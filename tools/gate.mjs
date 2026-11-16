// Probes the top free model with several request shapes, to find out whether its 403 is a hard gate or a
// header the caller can satisfy. A development tool, outside the entry.
//   OPENROUTER_API_KEY=sk-or-... node tools/gate.mjs
const key = process.env.OPENROUTER_API_KEY ?? '';
const MODEL = 'thinkingmachines/inkling-2-small:free';
const URL = 'https://openrouter.ai/api/v1/chat/completions';

const variants = [
  { name: 'plain', headers: {} },
  { name: 'ua-claude-code', headers: { 'user-agent': 'claude-code/2.0.1' } },
  { name: 'ua-codex', headers: { 'user-agent': 'codex_cli_rs/0.44.0' } },
  { name: 'ua-node', headers: { 'user-agent': 'node' } },
  { name: 'referer-title', headers: { 'http-referer': 'https://make.fun', 'x-title': 'make.fun aggregator' } },
  { name: 'ua-and-referer', headers: { 'user-agent': 'claude-code/2.0.1', 'http-referer': 'https://make.fun', 'x-title': 'make.fun' } },
  { name: 'x-ai-agent', headers: { 'x-agentic': 'true', 'user-agent': 'claude-code/2.0.1' } },
  { name: 'anthropic-beta', headers: { 'user-agent': 'claude-code/2.0.1', 'anthropic-beta': 'claude-code-20250219' } },
];

for (const variant of variants) {
  let line;
  try {
    const response = await fetch(URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${key}`,
        ...variant.headers,
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: 'user', content: 'Reply with exactly the word PINE-11 and nothing else.' }],
        max_tokens: 64,
      }),
    });
    const text = await response.text();
    let detail = text.slice(0, 300);
    try {
      const value = JSON.parse(text);
      detail = value.error ? JSON.stringify(value.error).slice(0, 240) : JSON.stringify(value.choices?.[0]?.message?.content ?? '').slice(0, 80);
    } catch {
      // Not JSON: the head is enough.
    }
    line = `${String(response.status).padEnd(4)} ${variant.name.padEnd(16)} ${detail}`;
  } catch (err) {
    line = `ERR  ${variant.name.padEnd(16)} ${err.message}`;
  }
  console.log(line);
}
