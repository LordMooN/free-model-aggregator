// Probes every free model of the practice brief once, directly against OpenRouter, to learn which ones
// this account may actually call and how fast they answer. A development tool, never part of the entry.
//   OPENROUTER_API_KEY=sk-or-... node tools/probe.mjs
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = resolve(fileURLToPath(new URL('.', import.meta.url)));
const kit = process.env.FMA_KIT ?? join(here, '..', '..', 'free-model-aggregator-02-kit');
const briefText = readFileSync(join(kit, 'practice', 'trial-0', 'input', 'prompt.txt'), 'utf8');
const models = JSON.parse(
  briefText.split('\n').find((line) => line.startsWith('{"schema":"free-model-aggregator-02/models/v1"')),
).models;

const key = process.env.OPENROUTER_API_KEY ?? '';
for (const model of models) {
  const started = Date.now();
  let line;
  try {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: model.id.replace(/^openrouter\//, ''),
        messages: [{ role: 'user', content: 'Reply with the single word OK and nothing else.' }],
        max_tokens: 32,
      }),
    });
    const ms = Date.now() - started;
    const text = await response.text();
    let detail = '';
    if (!response.ok) {
      try {
        detail = JSON.stringify(JSON.parse(text).error?.message ?? '').slice(0, 90);
      } catch {
        detail = text.slice(0, 90);
      }
    } else {
      const body = JSON.parse(text);
      detail = `"${String(body.choices?.[0]?.message?.content ?? '').slice(0, 40).replace(/\s+/g, ' ')}"`;
    }
    line = `${String(response.status).padEnd(4)} ${String(ms).padStart(5)}ms  ${model.id.padEnd(60)} ${detail}`;
  } catch (err) {
    line = `ERR        ${model.id.padEnd(60)} ${err.message}`;
  }
  process.stdout.write(`${line}\n`);
}
