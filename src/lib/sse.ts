export type AgentEvent = {
  type?: string;
  data?: string;
  content?: string;
  message?: string;
  error?: string;
};

export async function readSseStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  onEvent: (event: AgentEvent) => void,
) {
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.split('\n\n');
    buffer = chunks.pop() || '';

    for (const chunk of chunks) {
      const lines = chunk.split('\n');
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const raw = line.slice(5).trim();
        if (!raw || raw === '[DONE]') continue;
        try {
          onEvent(JSON.parse(raw) as AgentEvent);
        } catch {
          onEvent({ type: 'text', data: raw });
        }
      }
    }
  }
}
