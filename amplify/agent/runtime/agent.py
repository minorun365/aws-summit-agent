"""AWS Summit Agent - AgentCore Runtime entrypoint."""

from __future__ import annotations

import asyncio
import ipaddress
import json
import os
import re
import socket
from datetime import datetime, timedelta, timezone
from urllib.parse import urljoin, urlparse

import boto3
import requests
from botocore.config import Config
from bedrock_agentcore import BedrockAgentCoreApp
from strands import Agent, tool
from strands.agent.conversation_manager import SlidingWindowConversationManager
from strands.models import BedrockModel
from tavily import TavilyClient

JST = timezone(timedelta(hours=9))
WEEKDAY_JA = ["月", "火", "水", "木", "金", "土", "日"]
STREAM_KEEPALIVE_INTERVAL = 10.0
STREAM_SENTINEL = object()

AWS_REGION = os.environ.get("BEDROCK_REGION") or os.environ.get("AWS_DEFAULT_REGION") or "us-east-1"
MODEL_ID = os.environ.get("MODEL_ID", "us.anthropic.claude-sonnet-4-6")
HTTP_SUMMARY_MODEL_ID = os.environ.get("HTTP_SUMMARY_MODEL_ID", MODEL_ID)
SUMMIT_KB_ID = os.environ.get("SUMMIT_KB_ID", "")
TAVILY_API_SECRET_ARN = os.environ.get("TAVILY_API_SECRET_ARN", "")
HTTP_TIMEOUT_SECONDS = 20
HTTP_TEXT_LIMIT = 5000
HTTP_SUMMARY_THRESHOLD = 8000
HTTP_SUMMARY_INPUT_LIMIT = 50000

app = BedrockAgentCoreApp()
_agent_sessions: dict[str, Agent] = {}


def _load_tavily_api_keys() -> list[str]:
    if not TAVILY_API_SECRET_ARN:
        return []

    try:
        client = boto3.client(
            "secretsmanager",
            region_name=AWS_REGION,
            config=Config(retries={"max_attempts": 3, "mode": "adaptive"}),
        )
        response = client.get_secret_value(SecretId=TAVILY_API_SECRET_ARN)
        secret = response.get("SecretString", "")
        try:
            secret_json = json.loads(secret)
            secret = (
                secret_json.get("tavilyApiKeys")
                or secret_json.get("apiKey")
                or secret
            )
        except json.JSONDecodeError:
            pass
        return [key.strip() for key in secret.split(",") if key.strip()]
    except Exception as exc:
        print(f"[WARN] failed to load Tavily API keys from Secrets Manager: {exc}")
        return []


TAVILY_CLIENTS: list[TavilyClient] = [
    TavilyClient(api_key=key)
    for key in _load_tavily_api_keys()
]


EVENT_OVERVIEW = """AWS Summit Japan 2026
- Dates: 2026年6月25日(木)〜6月26日(金)
- Venue: 幕張メッセ
- Highlights: 260以上のセッション、AWS Village、AWS for Industries Zone、AWS Builders' Fair、Developer Community Zone、Startup Zone、ワークショップ、Partner Solution Expo
- Day 1: 08:30受付開始、10:00-11:10基調講演、10:00-18:30 AWS Expo / Partner Expo、11:30-17:10セッション、18:30終了
- Day 2: 08:30受付開始、10:00-11:30スペシャルセッション、10:00-19:00 AWS Expo、10:00-17:00 Partner Expo、12:00-16:40セッション、17:30-19:00ネットワーキングレセプション、19:00終了
"""


SYSTEM_PROMPT = f"""あなたは「AWSサミットエージェント」です。
AWS Summit Japan 2026の参加者に、スマホで読みやすい短い回答を返します。

基本方針:
- 公式情報・RAG検索・提供資料を優先し、根拠が弱い情報は断言しない。
- セッション、Expoブース、Startup Zone、参加準備、会場移動に関する質問では search_summit_knowledge を最優先で使う。
- Developer Learning Lounge、みのるん本人の参加予定、このアプリの技術構成に関する質問でも search_summit_knowledge を使い、提供済みKB情報を確認する。
- web_search は search_summit_knowledge の次に優先して使う。ユーザーが明示的に「Web検索して」と言わなくても、KB検索後に確証・最新性・補足根拠が足りない場合は積極的に使う。
- 次の質問では、まず search_summit_knowledge を使い、その結果だけで十分に答えられない場合は web_search で補完する: 店舗や営業時間、交通、天気、オンライン配信、外部記事、コミュニティ情報、スポンサーやブースの最新情報、公式ページ上の細かい変更、KBにない固有名詞。
- KB検索結果が0件、古い可能性がある、質問に対して情報が曖昧、または「どこ」「いつ」「空いてる」「今日」「最新」「おすすめ」「まだやってる」のような最新性・実在確認が重要な質問では、KBの次に web_search を使う。
- ユーザーがURLを貼った場合や、web_search の検索結果だけでは重要ページの本文確認が不足する場合は http_request でURLを読む。ただし多数のURLを連続取得せず、必要な1〜2件に絞る。
- web_search と http_request の結果は補助情報として扱い、公式情報・Knowledge Baseと矛盾する場合は公式情報・Knowledge Baseを優先する。
- Web検索やURL取得を使った回答では、確認できたURLや出典名を短く添える。
- 日時・曜日は current_time_jst と get_event_schedule の結果を優先し、LLMだけで計算しない。
- セッション推薦では、参加者の興味、空き時間、会場、同時間帯の重なり、Expoとの移動しやすさを考慮する。
- セッションやブースを提案するときは、可能な限りコード、日時、会場、なぜ合うか、次の行動を含める。
- 公式情報とコミュニティ記事が矛盾する場合は公式情報を優先する。
- 個人ブログ由来のTipsは「参加者目線の補足」として扱い、公式ルールのように断言しない。
- AWS Summit参加中に自然に発生する周辺相談は、サミットに直接関係しないように見えても拒否しない。海浜幕張駅・幕張メッセ周辺の夜の飲食店、居酒屋、カフェ、本屋、コンビニ、ホテル、移動、雨天時の過ごし方などは参加者支援として柔軟に答える。
- 海浜幕張駅・幕張メッセ周辺の店舗、営業時間、混雑、予約可否は変わりやすい。Knowledge Baseに候補がある場合も、最新性が重要なら web_search や http_request で確認し、最後に公式ページ・店舗・地図アプリ等での最終確認を促す。
- 回答は日本語。必要なら箇条書きで、スマホで読みやすくする。
- 絵文字は控えめにする。原則として使わず、親しみやすさに役立つ場合でも1回答につき最大1個までにする。
- 見出しや箇条書きの先頭を絵文字で装飾しない。代わりに短い日本語見出しを使う。
- AWS Summit Japan 2026は2026年6月25日(木)〜26日(金)、幕張メッセ開催。
- 「みのるん」はKDDIアジャイル開発センター株式会社の御田 稔です。
- みのるんはこのアプリの作者であり、AWS Summit Japan 2026のブレイクアウトセッション登壇者です。
- みのるんのセッションは DEV250「『勝手に広まる』人気 AI エージェントを爆速で作ろう！」です。2026年6月26日(金) 12:00-12:30 JST、Hall 4: Room 11で開催されます。
- みのるんやDEV250について聞かれたら、上記の固定情報を使いつつ、必要に応じて search_summit_knowledge で公式セッション情報を確認する。

現在保持している固定情報:
{EVENT_OVERVIEW}
"""


async def _safe_anext(aiter):
    try:
        return await aiter.__anext__()
    except StopAsyncIteration:
        return STREAM_SENTINEL


@tool
def current_time_jst() -> str:
    """現在の日本時間を曜日付きで返します。日付・曜日・時間帯判断が必要なときに使います。"""
    now = datetime.now(JST)
    weekday = WEEKDAY_JA[now.weekday()]
    return f"{now.year}年{now.month}月{now.day}日({weekday}) {now.strftime('%H:%M')} JST"


@tool
def get_event_schedule(day: str = "all") -> str:
    """AWS Summit Japan 2026の公式ページ由来の概要スケジュールを返します。

    Args:
        day: "day1", "day2", "all" のいずれか。

    Returns:
        公式ページ由来の開催概要と日別スケジュール。
    """
    normalized = day.lower().strip()
    if normalized in {"day1", "1", "2026-06-25", "6/25"}:
        return "Day 1: 2026年6月25日(木)。08:30受付開始、10:00-11:10基調講演、10:00-18:30 AWS Expo / Partner Expo、11:30-17:10セッション、18:30終了。"
    if normalized in {"day2", "2", "2026-06-26", "6/26"}:
        return "Day 2: 2026年6月26日(金)。08:30受付開始、10:00-11:30スペシャルセッション、10:00-19:00 AWS Expo、10:00-17:00 Partner Expo、12:00-16:40セッション、17:30-19:00ネットワーキングレセプション、19:00終了。"
    return EVENT_OVERVIEW


@tool
def search_summit_knowledge(query: str) -> str:
    """AWS Summit Japan関連のBedrock Knowledge Baseを検索します。

    Args:
        query: セッション、展示、会場、資料、会場周辺の飲食店・本屋・買い物に関する検索クエリ。

    Returns:
        RAG検索結果。Knowledge Baseが未設定の場合は、未設定であることを返します。
    """
    if not SUMMIT_KB_ID:
        return (
            "Knowledge Baseはまだ接続されていません。"
            "現在は公式ページ由来の開催概要と固定スケジュールだけを使えます。"
            "セッションカタログや資料が投入されたら、このツールから検索できるようになります。"
        )

    client = boto3.client(
        "bedrock-agent-runtime",
        region_name=AWS_REGION,
        config=Config(retries={"max_attempts": 5, "mode": "adaptive"}),
    )
    response = client.retrieve(
        knowledgeBaseId=SUMMIT_KB_ID,
        retrievalQuery={"text": query},
        retrievalConfiguration={
            "vectorSearchConfiguration": {
                "numberOfResults": 8,
            }
        },
    )

    results = []
    for item in response.get("retrievalResults", []):
        content = item.get("content", {}).get("text", "")
        score = item.get("score")
        location = item.get("location", {})
        uri = json.dumps(location, ensure_ascii=False)
        results.append(f"score={score}\nsource={uri}\n{content}")

    if not results:
        return (
            "Knowledge Baseを検索しましたが、関連する結果は見つかりませんでした。"
            "質問に答えるには、次に web_search で最新情報や外部情報を確認してください。"
        )
    return "\n\n---\n\n".join(results)


@tool
def web_search(query: str) -> str:
    """TavilyでWeb検索し、AWS Summit Japan 2026関連の最新情報や外部記事を確認します。

    search_summit_knowledge の次の優先度で積極的に使います。
    KB検索後に確証・最新性・補足根拠が足りない場合は、ユーザーが明示しなくても使ってください。
    店舗、営業時間、交通、天気、オンライン配信、外部記事、コミュニティ情報、スポンサーやブースの最新情報、
    KBにない固有名詞の確認では特に有効です。

    Args:
        query: 検索クエリ。AWS Summit Japan 2026など、対象年とイベント名を含めると精度が上がります。

    Returns:
        検索結果のタイトル、抜粋、URL。APIキー未設定や制限時はその旨を返します。
    """
    if not TAVILY_CLIENTS:
        return "Web検索機能は現在利用できません（Tavily APIキー未設定）。"

    for client in TAVILY_CLIENTS:
        try:
            response = client.search(
                query=query,
                max_results=4,
                search_depth="basic",
                include_answer=False,
            )
            response_text = str(response).lower()
            if "usage limit" in response_text or "exceeds your plan" in response_text:
                continue

            formatted_results = []
            for index, result in enumerate(response.get("results", []), start=1):
                title = result.get("title", "").strip()
                content = result.get("content", "").strip()
                url = result.get("url", "").strip()
                if not title and not content and not url:
                    continue
                formatted_results.append(
                    f"{index}. {title}\n概要: {content}\nURL: {url}"
                )

            if not formatted_results:
                return "Web検索を実行しましたが、関連する検索結果は見つかりませんでした。"
            return "\n\n".join(formatted_results)
        except Exception as exc:
            error_text = str(exc).lower()
            if any(token in error_text for token in ["rate limit", "429", "quota", "usage limit"]):
                continue
            return f"Web検索エラー: {exc}"

    return "Web検索APIの利用枠またはレート制限に到達している可能性があります。"


def _html_to_text(html: str) -> str:
    text = re.sub(r"<script[^>]*>.*?</script>", " ", html, flags=re.DOTALL | re.IGNORECASE)
    text = re.sub(r"<style[^>]*>.*?</style>", " ", text, flags=re.DOTALL | re.IGNORECASE)
    text = re.sub(r"<[^>]+>", " ", text)
    text = re.sub(r"\s+", " ", text).strip()
    return text


def _is_blocked_host(hostname: str | None) -> bool:
    if not hostname:
        return True
    if hostname in {"localhost", "localhost.localdomain"} or hostname.endswith(".localhost"):
        return True

    candidates: set[ipaddress._BaseAddress] = set()
    try:
        candidates.add(ipaddress.ip_address(hostname))
    except ValueError:
        try:
            for family, _, _, _, sockaddr in socket.getaddrinfo(hostname, None):
                if family in {socket.AF_INET, socket.AF_INET6}:
                    candidates.add(ipaddress.ip_address(sockaddr[0]))
        except socket.gaierror:
            return True

    for address in candidates:
        if (
            address.is_private
            or address.is_loopback
            or address.is_link_local
            or address.is_multicast
            or address.is_reserved
            or address.is_unspecified
        ):
            return True
    return False


def _summarize_http_content(content: str) -> str:
    client = boto3.client(
        "bedrock-runtime",
        region_name=AWS_REGION,
        config=Config(retries={"max_attempts": 3, "mode": "adaptive"}),
    )
    response = client.converse(
        modelId=HTTP_SUMMARY_MODEL_ID,
        messages=[
            {
                "role": "user",
                "content": [
                    {
                        "text": (
                            "以下のWebページ本文を、AWS Summit Japan 2026参加者向けの回答に使えるように要約してください。\n"
                            "固有名詞、日時、場所、URL、注意事項、数値、セッション名、登壇者名はできるだけ保持してください。\n"
                            "本文にない推測は追加しないでください。\n\n"
                            f"{content}"
                        )
                    }
                ],
            }
        ],
        inferenceConfig={"maxTokens": 1200, "temperature": 0},
    )
    return response["output"]["message"]["content"][0]["text"]


def _request_with_safe_redirects(method: str, url: str) -> requests.Response:
    current_url = url
    for _ in range(4):
        parsed = urlparse(current_url)
        if parsed.scheme not in {"http", "https"} or _is_blocked_host(parsed.hostname):
            raise ValueError("安全のため、このURLまたはリダイレクト先へのHTTP取得は許可されていません。")

        response = requests.request(
            method,
            current_url,
            timeout=HTTP_TIMEOUT_SECONDS,
            allow_redirects=False,
            headers={
                "User-Agent": "aws-summit-agent/1.0 (+https://summit.minoruonda.com)",
                "Accept": "text/html,application/xhtml+xml,text/plain,application/json,*/*;q=0.8",
            },
        )
        if response.is_redirect or response.is_permanent_redirect:
            location = response.headers.get("Location")
            if not location:
                return response
            current_url = urljoin(response.url, location)
            continue
        return response
    raise ValueError("リダイレクト回数が多すぎるため取得を中止しました。")


@tool
def http_request(url: str, method: str = "GET") -> str:
    """URLの本文をHTTPで取得します。

    ユーザーがURLを直接貼った場合、またはWeb検索結果だけでは本文確認が不足する場合に使用します。
    多数のURLを連続で読むのではなく、重要な1〜2件に絞ってください。

    Args:
        url: 取得するHTTPまたはHTTPS URL。
        method: HTTPメソッド。安全のためGETまたはHEADのみ使用できます。

    Returns:
        ステータス、Content-Type、最終URL、本文テキスト。大きな本文は要約されます。
    """
    method_normalized = method.upper().strip()
    if method_normalized not in {"GET", "HEAD"}:
        return "Error: http_requestではGETまたはHEADのみ使用できます。"

    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"}:
        return "Error: http_requestではhttpまたはhttpsのURLのみ取得できます。"
    if _is_blocked_host(parsed.hostname):
        return "Error: 安全のため、このホストへのHTTP取得は許可されていません。"

    try:
        response = _request_with_safe_redirects(method_normalized, url)
        content_type = response.headers.get("Content-Type", "")

        if method_normalized == "HEAD":
            return (
                f"Status: {response.status_code}\n"
                f"Final-URL: {response.url}\n"
                f"Content-Type: {content_type}\n"
                f"Content-Length: {response.headers.get('Content-Length', 'unknown')}"
            )

        if not (
            "text/" in content_type
            or "json" in content_type
            or "xml" in content_type
            or "html" in content_type
            or content_type == ""
        ):
            return (
                f"Status: {response.status_code}\n"
                f"Final-URL: {response.url}\n"
                f"Content-Type: {content_type}\n\n"
                "このURLはテキストではない可能性があります。PDFや画像はKnowledge Baseへの追加対象として扱うのがおすすめです。"
            )

        content = response.text
        original_length = len(content)
        if "html" in content_type:
            content = _html_to_text(content)

        if len(content) > HTTP_SUMMARY_THRESHOLD:
            try:
                summary = _summarize_http_content(content[:HTTP_SUMMARY_INPUT_LIMIT])
                content = f"（Webページ要約。元の文字数: {original_length}）\n\n{summary}"
            except Exception as exc:
                print(f"[WARN] http_request summarization failed: {exc}")
                content = (
                    content[:HTTP_TEXT_LIMIT]
                    + f"\n\n（以降省略: 全{original_length}文字中、先頭{HTTP_TEXT_LIMIT}文字を表示）"
                )
        elif len(content) > HTTP_TEXT_LIMIT:
            content = (
                content[:HTTP_TEXT_LIMIT]
                + f"\n\n（以降省略: 全{original_length}文字中、先頭{HTTP_TEXT_LIMIT}文字を表示）"
            )

        return (
            f"Status: {response.status_code}\n"
            f"Final-URL: {response.url}\n"
            f"Content-Type: {content_type}\n\n"
            f"{content}"
        )
    except Exception as exc:
        return f"Error: {exc}"


def _create_agent() -> Agent:
    model = BedrockModel(
        model_id=MODEL_ID,
        region_name=AWS_REGION,
        temperature=0.2,
        max_tokens=1800,
    )
    return Agent(
        model=model,
        system_prompt=SYSTEM_PROMPT,
        tools=[
            current_time_jst,
            get_event_schedule,
            search_summit_knowledge,
            web_search,
            http_request,
        ],
        conversation_manager=SlidingWindowConversationManager(window_size=12),
    )


def get_or_create_agent(session_id: str | None) -> Agent:
    if not session_id:
        return _create_agent()
    if session_id not in _agent_sessions:
        _agent_sessions[session_id] = _create_agent()
    return _agent_sessions[session_id]


@app.entrypoint
async def invoke(payload, context=None):
    prompt = (payload or {}).get("prompt", "").strip()
    session_id = getattr(context, "session_id", None) if context else None

    if not prompt:
        yield {"type": "text", "data": "AWS Summit Japanについて、知りたいことを聞いてください。"}
        yield {"type": "done"}
        return

    agent = get_or_create_agent(session_id)
    yield {"type": "status", "data": "AWS Summit情報を確認しています..."}

    try:
        stream = agent.stream_async(prompt)
        stream_iter = stream.__aiter__()
        pending = asyncio.ensure_future(_safe_anext(stream_iter))

        while True:
            done, _ = await asyncio.wait({pending}, timeout=STREAM_KEEPALIVE_INTERVAL)
            if not done:
                yield {"type": "progress", "message": "確認中..."}
                continue

            event = pending.result()
            if event is STREAM_SENTINEL:
                break

            if "data" in event:
                yield {"type": "text", "data": event["data"]}
            elif "current_tool_use" in event:
                tool_info = event["current_tool_use"]
                tool_name = tool_info.get("name", "tool")
                tool_input = tool_info.get("input", {})
                if isinstance(tool_input, str):
                    try:
                        tool_input = json.loads(tool_input)
                    except json.JSONDecodeError:
                        pass
                if isinstance(tool_input, dict):
                    query = tool_input.get("query") or tool_input.get("url")
                    if query:
                        yield {"type": "tool_use", "data": tool_name, "query": query}
                    else:
                        yield {"type": "tool_use", "data": tool_name}
                else:
                    yield {"type": "tool_use", "data": tool_name}
            elif "result" in event:
                result = event["result"]
                if hasattr(result, "message") and result.message:
                    for content in getattr(result.message, "content", []):
                        if hasattr(content, "text") and content.text:
                            yield {"type": "text", "data": content.text}

            pending = asyncio.ensure_future(_safe_anext(stream_iter))

    except Exception as exc:
        print(f"[ERROR] invocation failed: {exc}")
        yield {"type": "error", "error": str(exc)}

    yield {"type": "done"}


if __name__ == "__main__":
    app.run()
