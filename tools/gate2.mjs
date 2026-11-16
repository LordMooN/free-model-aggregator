// Tests whether the agentic-harness gate accepts an honest User-Agent for this server, or only the
// published products' own strings. A development tool, outside the entry.
//   OPENROUTER_API_KEY=sk-or-... node tools/gate2.mjs
const key = process.env.OPENROUTER_API_KEY ?? '';
const MODEL = 'thinkingmachines/inkling-2-small:free';
const URL = 'https://openrouter.ai/api/v1/chat/completions';

const agents = [
  'makefun-free-model-aggregator/1.0',
  'makefun-aggregator/1.0 (agentic harness)',
  'my-coding-agent/1.0',
  'agentic-harness/1.0',
  'opencode/0.15.0',
  'cursor/0.44.0',
  'aider/0.60.0',
  'cline/3.1.0',
  'continue/1.0.0',
  'roo-code/3.2.0',
];

for (const agent of agents) {
  let line;
  try {
    const response = await fetch(URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}`, 'user-agent': agent },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: 'user', content: 'Reply with exactly the word PINE-11 and nothing else.' }],
        max_tokens: 64,
      }),
    });
    const text = await response.text();
    let detail = text.slice(0, 120);
    try {
      const value = JSON.parse(text);
      detail = value.error ? `GATED` : JSON.stringify(value.choices?.[0]?.message?.content ?? '').slice(0, 40);
    } catch {
      // Not JSON.
    }
    line = `${String(response.status).padEnd(4)} ${agent.padEnd(44)} ${detail}`;
  } catch (err) {
    line = `ERR  ${agent.padEnd(44)} ${err.message}`;
  }
  console.log(line);
}
