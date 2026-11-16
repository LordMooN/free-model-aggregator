// The OpenAI event stream, rewritten on its way to the client: every chunk names the model this aggregator
// really dialled, exactly one chunk carries a finish reason, and the stream ends with one [DONE].
//
// A free provider is not careful about the stream's shape: one sends its finish reason twice, once in the
// text chunk and again beside the usage, and a reader that counts finish chunks calls the answer broken.
// The client's checks read the stream this aggregator emits, so the shape is normalised here rather than
// trusted from upstream. Anything that is not a well-formed `data:` JSON chunk is relayed untouched: an
// SSE comment, a provider's keep-alive, or a body this code does not understand is the client's to read.
import type { Json } from './providers.ts';

/** One SSE frame's data payload, or null when it is not JSON this code rewrites. */
function chunkOf(payload: string): Json | null {
  try {
    const value: unknown = JSON.parse(payload);
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : null;
  } catch {
    return null;
  }
}

/** Rewrite one SSE frame for the client: the model, and at most one finish reason across the stream. */
function rewriteFrame(frame: string, model: string, state: { finishSeen: boolean; doneSeen: boolean }): string | null {
  const lines = frame.split('\n');
  const out: string[] = [];
  for (const line of lines) {
    if (!line.startsWith('data:')) {
      out.push(line);
      continue;
    }
    const payload = line.slice(5).trim();
    if (payload === '[DONE]') {
      if (state.doneSeen) return null;
      state.doneSeen = true;
      out.push('data: [DONE]');
      continue;
    }
    const chunk = chunkOf(payload);
    if (chunk === null) {
      out.push(line);
      continue;
    }
    chunk.model = model;
    if (Array.isArray(chunk.choices)) {
      for (const choice of chunk.choices as unknown[]) {
        if (choice === null || typeof choice !== 'object') continue;
        const row = choice as Json;
        const finish = row.finish_reason;
        if (finish === undefined || finish === null) continue;
        // The first finish reason is the answer's; a second one is the provider repeating itself beside
        // its usage, and the client counts it as a second finish chunk.
        if (state.finishSeen) row.finish_reason = null;
        else state.finishSeen = true;
      }
    }
    out.push(`data: ${JSON.stringify(chunk)}`);
  }
  return out.join('\n');
}

/**
 * The gateway's Chat Completions stream, as the client's OpenAI stream: the same events, the model named back,
 * one finish reason, one [DONE]. A provider that never sent [DONE] gets one from here, which is what an OpenAI
 * client waits for.
 */
export async function* openAIStreamFrames(
  upstream: ReadableStream<Uint8Array>,
  model: string,
): AsyncGenerator<string> {
  const reader = upstream.getReader();
  const decoder = new TextDecoder();
  const state = { finishSeen: false, doneSeen: false };
  let buffer = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
      let at = buffer.indexOf('\n\n');
      while (at !== -1) {
        const frame = buffer.slice(0, at);
        buffer = buffer.slice(at + 2);
        const rewritten = rewriteFrame(frame, model, state);
        if (rewritten !== null) yield `${rewritten}\n\n`;
        at = buffer.indexOf('\n\n');
      }
    }
    buffer += decoder.decode();
    if (buffer.trim() !== '') {
      const rewritten = rewriteFrame(buffer, model, state);
      if (rewritten !== null) yield `${rewritten}\n\n`;
    }
    if (!state.doneSeen) yield 'data: [DONE]\n\n';
  } finally {
    reader.releaseLock();
  }
}
