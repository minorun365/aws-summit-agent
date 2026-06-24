import { fetchAuthSession } from 'aws-amplify/auth';
import outputs from '../../amplify_outputs.json';
import { readSseStream, type AgentEvent } from './sse';

export type AgentCallbacks = {
  onText: (text: string) => void;
  onStatus: (status: string) => void;
  onToolUse: (toolName: string) => void;
  onError: (message: string) => void;
};

function getRuntimeUrl() {
  const runtimeArn = outputs.custom?.agentRuntimeArn;
  if (!runtimeArn) {
    throw new Error('AgentCore Runtime ARNが設定されていません。');
  }
  const region = runtimeArn.split(':')[3];
  return `https://bedrock-agentcore.${region}.amazonaws.com/runtimes/${encodeURIComponent(runtimeArn)}/invocations?qualifier=DEFAULT`;
}

function handleEvent(event: AgentEvent, callbacks: AgentCallbacks) {
  const text = event.content || event.data || event.message;
  if (event.type === 'text' && text) callbacks.onText(text);
  if (event.type === 'status' && text) callbacks.onStatus(text);
  if (event.type === 'progress' && text) callbacks.onStatus(text);
  if (event.type === 'tool_use' && text) callbacks.onToolUse(text);
  if (event.type === 'error') callbacks.onError(event.error || text || 'エージェントでエラーが発生しました。');
}

export async function invokeAgent(
  prompt: string,
  sessionId: string,
  callbacks: AgentCallbacks,
) {
  const session = await fetchAuthSession();
  const accessToken = session.tokens?.accessToken?.toString();
  if (!accessToken) {
    throw new Error('ログインが必要です。');
  }

  const response = await fetch(getRuntimeUrl(), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      'X-Amzn-Bedrock-AgentCore-Runtime-Session-Id': sessionId,
    },
    body: JSON.stringify({ prompt }),
  });

  if (!response.ok) {
    throw new Error(`AgentCore API Error: ${response.status} ${response.statusText}`);
  }

  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error('AgentCoreのレスポンスを読み取れませんでした。');
  }

  await readSseStream(reader, (event) => handleEvent(event, callbacks));
}
