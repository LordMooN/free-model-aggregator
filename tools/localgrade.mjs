// A local stand-in for the trial's three containers, to test the entry without the sandbox:
//   - a gateway on 127.0.0.1 that forwards Chat Completions to OpenRouter on the key in the environment
//     (the same lane the grader's gateway gives you), and
//   - an env that registers the entry's port, sends the practice workload's six prompts one at a time in
//     the order the brief lists them, and checks each answer the way the scorer's wire checks do.
//
//   OPENROUTER_API_KEY=sk-or-... node tools/localgrade.mjs [--trial 0] [--keep]
//
// It prints one line a prompt (status, model, token found, usage, stop reason) and a rough score over the
// five columns. It is a development tool: the real grade is the server's.
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = resolve(fileURLToPath(new URL('.', import.meta.url)));
const repository = resolve(here, '..');
const kit = process.env.FMA_KIT ?? join(repository, '..', 'free-model-aggregator-02-kit');
const trialArg = process.argv.indexOf('--trial');
const trial = trialArg === -1 ? 0 : Number(process.argv[trialArg + 1]);
const trialDir = join(kit, 'practice', `trial-${trial}`);
const workload = JSON.parse(readFileSync(join(trialDir, 'input', 'env', 'workload.json'), 'utf8'));
const briefText = readFileSync(join(trialDir, 'input', 'prompt.txt'), 'utf8');
const briefModels = JSON.parse(
  briefText.split('\n').find((line) => line.startsWith('{"schema":"free-model-aggregator-02/models/v1"')),
).models;
const ratings = new Map(briefModels.map((model) => [model.id, model]));

const UPSTREAM = 'https://openrouter.ai/api/v1';

// ---------------------------------------------------------------- the gateway
const gateway = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', 'http://gateway');
  if (request.method === 'GET' && url.pathname.endsWith('/models')) {
    const upstream = await fetch(`${UPSTREAM}/models`, {
      headers: { authorization: `Bearer ${process.env.OPENROUTER_API_KEY ?? ''}` },
    });
    response.writeHead(upstream.status, { 'content-type': 'application/json' });
    response.end(Buffer.from(await upstream.arrayBuffer()));
    return;
  }
  if (request.method !== 'POST' || !url.pathname.endsWith('/chat/completions')) {
    response.writeHead(404, { 'content-type': 'application/json' }).end('{"error":{"message":"no route"}}');
    return;
  }
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = Buffer.concat(chunks);
  let model = '(none)';
  try {
    model = JSON.parse(body.toString('utf8')).model;
  } catch {
    // The entry sent something that is not JSON; upstream will refuse it.
  }
  // The grader's gateway strips the competition's prefix; this stand-in does the same, since OpenRouter
  // itself names a model without it.
  let upstreamBody = body;
  try {
    const parsed = JSON.parse(body.toString('utf8'));
    parsed.model = String(parsed.model ?? '').replace(/^openrouter\//, '');
    upstreamBody = Buffer.from(JSON.stringify(parsed));
  } catch {
    // Forwarded as sent.
  }
  const upstream = await fetch(`${UPSTREAM}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${process.env.OPENROUTER_API_KEY ?? ''}`,
    },
    body: upstreamBody,
  });
  const headers = { 'content-type': upstream.headers.get('content-type') ?? 'application/json' };
  response.writeHead(upstream.status, headers);
  if (upstream.body === null) {
    response.end();
    return;
  }
  for await (const chunk of upstream.body) response.write(Buffer.from(chunk));
  response.end();
  process.stderr.write(`gateway: ${model} -> HTTP ${upstream.status}\n`);
});

// ---------------------------------------------------------------- the env
let registered = null;
let sent = 0;
let done = false;
const results = [];

function tokenOf(prompt) {
  return prompt.token;
}

/** Read a streamed answer's text and the metadata the wire checks look at. */
async function readStream(response) {
  let text = '';
  let usage = null;
  let finish = null;
  let events = [];
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done: end, value } = await reader.read();
    if (end) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split('\n\n');
    buffer = parts.pop() ?? '';
    for (const part of parts) {
      const lines = part.split('\n').filter((line) => line.startsWith('data:'));
      for (const line of lines) {
        const payload = line.slice(5).trim();
        if (payload === '' || payload === '[DONE]') continue;
        let event;
        try {
          event = JSON.parse(payload);
        } catch {
          continue;
        }
        events.push(event);
        if (event.usage) usage = { ...(usage ?? {}), ...event.usage };
        if (event.choices?.[0]?.finish_reason) finish = event.choices[0].finish_reason;
        if (event.choices?.[0]?.delta?.content) text += event.choices[0].delta.content;
        if (event.type === 'content_block_delta' && event.delta?.text) text += event.delta.text;
        if (event.type === 'message_delta') {
          if (event.delta?.stop_reason) finish = event.delta.stop_reason;
          if (event.usage) usage = { ...(usage ?? {}), ...event.usage };
        }
        if (event.type === 'message_start' && event.message?.usage) usage = { ...(usage ?? {}), ...event.message.usage };
        if (event.type === 'content_block_start' && event.content_block?.text) text += event.content_block.text;
      }
    }
  }
  return { text, usage, finish, events };
}

async function sendPrompt(prompt) {
  const body = workload.bodies[prompt.id];
  const anthropic = prompt.api === 'anthropic';
  const headers = { 'content-type': 'application/json' };
  if (anthropic) {
    headers['x-api-key'] = 'local-test';
    headers['anthropic-version'] = '2023-06-01';
  } else {
    headers.authorization = 'Bearer local-test';
  }
  const url = `${registered}/v1/${anthropic ? 'messages' : 'chat/completions'}`;
  const started = Date.now();
  let response;
  try {
    response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  } catch (err) {
    return { id: prompt.id, status: 0, error: err.message };
  }
  const ms = Date.now() - started;
  const trail = response.headers.get('x-makefun-upstream-failures');
  if (!response.ok) {
    const text = await response.text();
    return { id: prompt.id, status: response.status, error: text.slice(0, 200), ms, trail };
  }
  const streamed = body.stream === true;
  let text = '';
  let usage = null;
  let finish = null;
  let model = null;
  if (streamed) {
    const read = await readStream(response);
    text = read.text;
    usage = read.usage;
    finish = read.finish;
    model = read.events.find((event) => event.model)?.model ?? null;
    if (!model) model = read.events.find((event) => event.message?.model)?.message.model ?? null;
  } else {
    const answer = await response.json();
    model = answer.model ?? null;
    finish = anthropic ? answer.stop_reason : answer.choices?.[0]?.finish_reason;
    usage = answer.usage ?? null;
    text = anthropic
      ? (answer.content ?? []).map((block) => block.text ?? '').join('')
      : (answer.choices?.[0]?.message?.content ?? '');
    if (typeof text !== 'string') text = JSON.stringify(text);
  }
  const output = anthropic ? (usage?.output_tokens ?? 0) : (usage?.completion_tokens ?? 0);
  const input = anthropic ? (usage?.input_tokens ?? -1) : (usage?.prompt_tokens ?? -1);
  return {
    id: prompt.id,
    status: response.status,
    model,
    token: text.includes(tokenOf(prompt)),
    usageOk: input >= 0 && output >= 1,
    finish,
    ms,
    trail,
    excerpt: text.slice(0, 90).replace(/\s+/g, ' '),
    streamed,
    text,
  };
}

async function drivePrompts() {
  for (const prompt of workload.manifest) {
    const result = await sendPrompt(prompt);
    results.push(result);
    sent += 1;
    const rating = result.model ? ratings.get(result.model)?.rating_milli : undefined;
    process.stderr.write(
      `prompt ${result.id} ${prompt.api}${prompt.stream ? '+sse' : ''} w${prompt.weight}: ` +
        `${result.status} model=${result.model ?? '-'}${rating ? `(${rating})` : ''} ` +
        `token=${result.token ?? '-'} usage=${result.usageOk ?? '-'} finish=${result.finish ?? '-'} ${result.ms}ms` +
        `${result.trail ? ` trail=${result.trail}` : ''}\n` +
        (result.excerpt ? `        "${result.excerpt}"\n` : `${result.error ? `        ${result.error}\n` : ''}`),
    );
  }
  done = true;
}

const env = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', 'http://env');
  if (request.method === 'POST' && url.pathname === '/register') {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const catalog = body.catalog ?? { providers: [] };
    const ids = (catalog.providers ?? []).flatMap((provider) => (provider.models ?? []).filter((model) => model.free !== false).map((model) => model.id));
    registered = `http://127.0.0.1:${body.port}`;
    const expected = new Set(briefModels.map((model) => model.id));
    const catalogOk = ids.length === expected.size && ids.every((id) => expected.has(id)) && new Set(ids).size === ids.length;
    process.stderr.write(`register: port ${body.port}, ${ids.length} catalog ids, exact=${catalogOk}\n`);
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, requests: 6 }));
    setTimeout(() => {
      drivePrompts().catch((err) => process.stderr.write(`drive failed: ${err.message}\n`));
    }, 150);
    return;
  }
  if (request.method === 'GET' && url.pathname === '/work') {
    const pending = workload.manifest.length - sent;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify(done ? { done: true } : { done: false, next: workload.manifest[sent]?.id ?? '', pending }),
    );
    return;
  }
  response.writeHead(404).end();
});

const gatewayPort = await new Promise((done2) => gateway.listen(0, '127.0.0.1', () => done2(gateway.address().port)));
const envPort = await new Promise((done2) => env.listen(0, '127.0.0.1', () => done2(env.address().port)));

const child = spawn(process.execPath, [join(repository, 'main.ts')], {
  cwd: repository,
  env: {
    ...process.env,
    MAKEFUN_PROMPT_FILE: join(trialDir, 'input', 'prompt.txt'),
    MAKEFUN_ENV_URL: `http://127.0.0.1:${envPort}`,
    MAKEFUN_TRIAL_SEED: 'local-test-seed',
    OPENAI_BASE_URL: `http://127.0.0.1:${gatewayPort}/v1`,
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${gatewayPort}`,
    OPENAI_API_KEY: 'local-test',
    ANTHROPIC_API_KEY: 'local-test',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
child.stdout.on('data', (chunk) => process.stdout.write(`agent: ${chunk}`));
child.stderr.on('data', (chunk) => process.stderr.write(`agent: ${chunk}`));

const exitCode = await new Promise((done2) => {
  const timer = setTimeout(() => {
    process.stderr.write('agent did not exit within 240 s\n');
    child.kill();
    done2('timeout');
  }, 240_000);
  child.on('exit', (code) => {
    clearTimeout(timer);
    done2(code);
  });
});

// ---------------------------------------------------------------- the report
const answered = results.filter((result) => result.status === 200 && result.token === true);
const weight = (id) => workload.manifest.find((prompt) => prompt.id === id)?.weight ?? 1;
let weighted = 0;
let best = 0;
for (const result of results) {
  const brief = workload.manifest.find((prompt) => prompt.id === result.id);
  const bestModel = briefModels
    .filter((model) => (!brief.requires.tools || model.tools) && (!brief.requires.json || model.json) && (!brief.requires.vision || model.vision))
    .reduce((top, model) => Math.max(top, model.rating_milli), 0);
  const rating = result.model ? (ratings.get(result.model)?.rating_milli ?? 0) : 0;
  weighted += brief.weight * (result.token ? rating / bestModel : 0);
  best += brief.weight;
}
const quality = best === 0 ? 0 : Math.round((weighted / best) * 100);
const served = Math.round((answered.length / workload.manifest.length) * 100);
const wireChecks = results.filter((result) => result.status === 200 && result.usageOk && result.finish);
const wire = Math.round((wireChecks.length / workload.manifest.length) * 100);

process.stdout.write(
  `\nreport: exit=${exitCode} served=${served} wire=${wire} quality=${quality}\n` +
    `  ${results.map((result) => `${result.id}:${result.status}${result.token ? '+token' : ''}`).join(' ')}\n`,
);

env.close();
gateway.close();
if (process.argv.includes('--keep')) await new Promise(() => {});
process.exit(exitCode === 0 ? 0 : 1);
