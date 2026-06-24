import { useEffect, useMemo, useRef, useState } from 'react';
import { Authenticator, useAuthenticator } from '@aws-amplify/ui-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { invokeAgent } from './lib/agentCore';

type Message = {
  id: string;
  role: 'user' | 'assistant' | 'status';
  content: string;
  state?: 'running' | 'done' | 'error';
};

function createMessage(message: Omit<Message, 'id'>): Message {
  return { ...message, id: crypto.randomUUID() };
}

function finishRunningMessages(messages: Message[]) {
  return messages.map((message) => (
    message.state === 'running'
      ? { ...message, state: 'done' as const }
      : message
  ));
}

function buildShareMarkdown() {
  const text = '#AWSサミットエージェント に質問してみました。これは便利！ https://summit.minoruonda.com';
  const href = `https://x.com/compose/post?text=${encodeURIComponent(text)}`;
  return `\n\n---\nこの体験をXでシェアしませんか？ 👉 [ツイート](${href})`;
}

function appendShareLinkToLastAssistant(messages: Message[]) {
  let lastAssistantIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === 'assistant') {
      lastAssistantIndex = index;
      break;
    }
  }

  if (lastAssistantIndex < 0) {
    return messages;
  }

  const lastAssistant = messages[lastAssistantIndex];
  if (!lastAssistant.content.trim() || lastAssistant.content.includes('https://x.com/compose/post?text=')) {
    return messages;
  }

  return messages.map((message, index) => (
    index === lastAssistantIndex
      ? { ...message, content: `${message.content}${buildShareMarkdown()}` }
      : message
  ));
}

function toolLabel(toolName: string) {
  const labels: Record<string, string> = {
    current_time_jst: '現在時刻を確認しています',
    get_event_schedule: 'イベントスケジュールを確認しています',
    search_summit_knowledge: '資料・ナレッジベースを検索しています',
    web_search: 'Webで補足情報を検索しています',
    http_request: 'URLの内容を確認しています',
  };
  return labels[toolName] || `${toolName} を使って確認しています`;
}

function MarkdownMessage({ content, isStreaming }: { content: string; isStreaming?: boolean }) {
  return (
    <div className="markdown-body">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noopener noreferrer">
              {children}
            </a>
          ),
        }}
      >
        {content + (isStreaming ? ' ▌' : '')}
      </ReactMarkdown>
    </div>
  );
}

const quickPrompts = [
  'みのるんのセッションはいつ？',
  '初参加です。朝の動き方と持ち物を教えて',
  '6/26午後の生成AIセッションを探して',
  '幕張のランチのおすすめは？',
];

const authComponents = {
  Header() {
    return (
      <div className="auth-header">
        <p className="auth-kicker">AWS SUMMIT JAPAN 2026 参加者をサポート</p>
        <h1>#AWSサミットエージェント（非公式）</h1>
        <p>誰でもアカウントを作って利用できます！</p>
      </div>
    );
  },
  Footer() {
    return (
      <div className="auth-footer">
        <p>登録されたメールアドレスは認証目的でのみ使用します。</p>
        <p className="auth-footer-note">※新規登録が1日50名を超えるとエラーになります</p>
      </div>
    );
  },
};

function App() {
  return (
    <Authenticator components={authComponents}>
      {({ signOut }) => <MainApp signOut={signOut} />}
    </Authenticator>
  );
}

function MainApp({ signOut }: { signOut?: () => void }) {
  const { user } = useAuthenticator((context) => [context.user]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const sessionId = useMemo(() => `summit-${crypto.randomUUID()}`, []);

  useEffect(() => {
    const setViewportHeight = () => {
      const viewport = window.visualViewport;
      const height = viewport?.height ?? window.innerHeight;
      document.documentElement.style.setProperty('--app-height', `${Math.round(height)}px`);
      document.documentElement.classList.toggle(
        'keyboard-open',
        Boolean(viewport && window.innerHeight - viewport.height > 140),
      );
    };

    setViewportHeight();
    window.visualViewport?.addEventListener('resize', setViewportHeight);
    window.visualViewport?.addEventListener('scroll', setViewportHeight);
    window.addEventListener('resize', setViewportHeight);
    window.addEventListener('orientationchange', setViewportHeight);

    return () => {
      window.visualViewport?.removeEventListener('resize', setViewportHeight);
      window.visualViewport?.removeEventListener('scroll', setViewportHeight);
      window.removeEventListener('resize', setViewportHeight);
      window.removeEventListener('orientationchange', setViewportHeight);
      document.documentElement.classList.remove('keyboard-open');
    };
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ block: 'end' });
  }, [messages]);

  const submitPrompt = async (prompt: string) => {
    const trimmed = prompt.trim();
    if (!trimmed || isLoading) return;

    setInput('');
    setIsLoading(true);
    setMessages((current) => [
      ...finishRunningMessages(current),
      createMessage({ role: 'user', content: trimmed }),
      createMessage({ role: 'status', content: 'AWS Summit情報を確認しています...', state: 'running' }),
    ]);

    let hadError = false;

    try {
      await invokeAgent(trimmed, sessionId, {
        onText: (text) => {
          setMessages((current) => {
            const updated = finishRunningMessages(current);
            const last = updated.at(-1);
            if (last?.role === 'assistant') {
              return updated.map((message) => (
                message.id === last.id
                  ? { ...message, content: message.content + text, state: 'running' }
                  : message
              ));
            }
            return [
              ...updated,
              createMessage({ role: 'assistant', content: text, state: 'running' }),
            ];
          });
        },
        onStatus: (nextStatus) => {
          setMessages((current) => {
            const updated = finishRunningMessages(current);
            const last = updated.at(-1);
            if (last?.role === 'status' && last.content === nextStatus) {
              return updated;
            }
            return [
              ...updated,
              createMessage({ role: 'status', content: nextStatus, state: 'running' }),
            ];
          });
        },
        onToolUse: (toolName) => {
          const nextStatus = toolLabel(toolName);
          setMessages((current) => {
            const updated = finishRunningMessages(current);
            const last = updated.at(-1);
            if (last?.role === 'status' && last.content === nextStatus) {
              return updated;
            }
            return [
              ...updated,
              createMessage({ role: 'status', content: nextStatus, state: 'running' }),
            ];
          });
        },
        onError: (message) => {
          hadError = true;
          setMessages((current) => [
            ...finishRunningMessages(current),
            createMessage({ role: 'assistant', content: `エラー: ${message}`, state: 'error' }),
          ]);
        },
      });

      if (!hadError) {
        setMessages((current) => appendShareLinkToLastAssistant(finishRunningMessages(current)));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setMessages((current) => [
        ...finishRunningMessages(current),
        createMessage({ role: 'assistant', content: `エラー: ${message}`, state: 'error' }),
      ]);
    } finally {
      setMessages((current) => finishRunningMessages(current));
      setIsLoading(false);
      if (!window.matchMedia('(pointer: coarse)').matches) {
        inputRef.current?.focus();
      }
    }
  };

  return (
    <div className="app-shell">
      <header className="topbar">
          <div>
            <p className="eyebrow">AWS SUMMIT JAPAN 2026 参加者をサポート</p>
            <h1>#AWSサミットエージェント（非公式）</h1>
          </div>
        <button className="ghost-button" onClick={signOut}>ログアウト</button>
      </header>

      <main className="chat-panel">
        {messages.length === 0 ? (
          <section className="empty-state">
            <p className="welcome">こんにちは、{user?.signInDetails?.loginId || '参加者'}さん</p>
            <h2>幕張での動き方を一緒に決めましょう。</h2>
            <p>
              公式情報、271件の公開セッション、AWS Expoブース、Startup Zoneやウェブ情報をもとに、
              次に見る場所やセッション候補を具体的に案内します。
            </p>
            <div className="quick-grid">
              {quickPrompts.map((prompt) => (
                <button key={prompt} onClick={() => submitPrompt(prompt)}>
                  {prompt}
                </button>
              ))}
            </div>
          </section>
        ) : (
          <div className="messages">
            {messages.map((message) => (
              <article key={message.id} className={`message ${message.role}`}>
                {message.role === 'status' ? (
                  <div className={`status-bubble ${message.state === 'done' ? 'done' : ''}`}>
                    <span className="status-icon" />
                    <span>{message.content}</span>
                  </div>
                ) : (
                  <div className="bubble">
                    {message.role === 'assistant' ? (
                      <MarkdownMessage content={message.content || '...'} isStreaming={message.state === 'running'} />
                    ) : (
                      message.content
                    )}
                  </div>
                )}
              </article>
            ))}
            <div ref={messagesEndRef} />
          </div>
        )}
      </main>

      <footer className="composer-wrap">
        <form
          className="composer"
          onSubmit={(event) => {
            event.preventDefault();
            submitPrompt(input);
          }}
        >
          <input
            id="summit-chat-input"
            name="message"
            ref={inputRef}
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onFocus={() => {
              window.setTimeout(() => {
                messagesEndRef.current?.scrollIntoView({ block: 'end' });
              }, 250);
            }}
            placeholder="例: 生成AI中心でおすすめを教えて"
            disabled={isLoading}
            maxLength={1200}
          />
          <button disabled={isLoading || !input.trim()} type="submit">
            送信
          </button>
        </form>
      </footer>
    </div>
  );
}

export default App;
