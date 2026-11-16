// free-model-aggregator-02: one server, two client wires, a real free model behind every answer.
//
// The shape of a trial:
//   the env sends six prompts, one at a time, three on the OpenAI Chat Completions wire and three on the
//   Anthropic Messages wire, some streaming, some in JSON mode, one declaring tools; every prompt carries
//   a unique token its answer must carry back. This server picks a free model for each one, dials it on
//   the gateway's Chat Completions route, and hands the provider's own answer back in the wire the client
//   used. The house scores the model its own gateway record shows really answering, so the `model` field
//   on every answer and every streamed chunk is the id this server dialled, never the provider's echo.
//
// What this entry adds over the house baseline, one scoring column each:
//   - quality (60%): every free candidate is ranked by the brief's own rating_milli at the prompt's
//     requirements, and the strongest one that can serve the prompt is asked first. The starter took the
//     first model in the brief's order.
//   - failover (10%): a refusal is not an answer. The prompt moves on to the next-strongest candidate, and
//     every refusal it left behind is reported in the optional `x-makefun-upstream-failures` header, which
//     is the only way the failover column can see a refusal this server recovered from.
//   - cooldowns: a model that refused keeps a penalty, so a rate-limited model never takes the whole trial
//     down with it: the next prompt starts from the strongest model that has not refused yet.
//   - catalog (5%): the registered catalog, `--list` and both `GET /v1/models` answers are the same
//     fourteen free ids, once each, built once from the brief.
//
// Everything here is a function of the brief and the answers the gateway has already given: no wall clock,
// no unseeded randomness, one request at a time in arrival order. A replay must leave the same state.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  buildCatalog,
  capabilitiesOf,
  freeModels,
  isRecord,
  meetsRequirements,
  readBrief,
  type CatalogReport,
  type Json,
  type ModelRow,
  type Requirement,
} from './lib/providers.ts';
import {
  anthropicError,
  anthropicModelList,
  openAIError,
  openAIJsonWithModel,
  openAIToAnthropic,
  openAIModelList,
  type ServedModel,
} from './lib/wire.ts';
import * as wire from './lib/wire.ts';
import { openAIStreamFrames } from './lib/stream.ts';

// The two Anthropic translators of lib/wire.ts, found by their name prefix.
function wireFunction(prefix: string): (...args: never[]) => unknown {
  for (const [name, value] of Object.entries(wire)) {
    if (name.startsWith(prefix) && typeof value === 'function' && name !== 'anthropicError') return value as never;
  }
  throw new Error(`lib/wire.ts exports no ${prefix}* function`);
}

const anthropicToChat = wireFunction('anthropicTo') as (body: Json, model: string) => Json;
const anthropicEventsFromChat = wireFunction('anthropicEventsFrom') as (
  upstream: ReadableStream<Uint8Array>,
  model: string,
) => AsyncGenerator<string>;

const PROTOCOL_VERSION = 1;
const POLL_INTERVAL_MS = 100;
const MAX_BODY_BYTES = 8 * 1024 * 1024;
/** How many gateway calls one prompt may cost before this server gives up on it, retries included. */
const MAX_CALLS_PER_PROMPT = 6;

/** A refusal worth asking the same model again for: the provider is busy, not the model unavailable. */
function worthRetrying(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}
/** The failover trail's own caps: eight rows, and well under the 8 KiB the env will read. */
const MAX_TRAIL_ROWS = 8;
const MAX_TRAIL_BYTES = 4096;

const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
const PROMPT_FILE = process.env.MAKEFUN_PROMPT_FILE ?? '';
const GATEWAY_URL = (process.env.OPENAI_BASE_URL ?? '').replace(/\/+$/, '');
const GATEWAY_KEY = process.env.OPENAI_API_KEY ?? '';

const brief = readBrief(PROMPT_FILE);
const catalog: CatalogReport = buildCatalog(brief);

/** The prompt row the request now arriving belongs to: the brief lists them in the client's send order. */
let manifestIndex = 0;

/** How many times each free model has refused, across the trial: the cooldown the next prompt reads. */
const refusals = new Map<string, number>();

function log(message: string): void {
  process.stderr.write(`aggregator: ${message}\n`);
}

/** The gateway's Chat Completions route, from the OpenAI-compatible root the sandbox sets. */
function chatCompletionsUrl(): string {
  if (GATEWAY_URL === '') return '';
  return GATEWAY_URL.endsWith('/v1') ? `${GATEWAY_URL}/chat/completions` : `${GATEWAY_URL}/v1/chat/completions`;
}

/** The fourteen free models, as GET /v1/models names them. */
function servedModels(): ServedModel[] {
  return freeModels(brief).map((model) => ({ id: model.id, provider: model.provider, display_name: model.display_name }));
}

/**
 * Every free model that can serve a prompt with these requirements, strongest first: the brief's rating
 * decides, then the wider window, then the id, so two runs of the same trial order them the same way.
 * A model that has already refused sinks by one rank per refusal: the cooldown, kept as a count because a
 * clock reading would make a replay differ from the pass it replays.
 */
function candidateOrder(requires: Requirement): ModelRow[] {
  const eligible = freeModels(brief).filter((model) => meetsRequirements(requires, capabilitiesOf(model)));
  const penalty = (model: ModelRow): number => refusals.get(model.id) ?? 0;
  return eligible.sort((a, b) => {
    const byPenalty = penalty(a) - penalty(b);
    if (byPenalty !== 0) return byPenalty;
    const byRating = b.rating_milli - a.rating_milli;
    if (byRating !== 0) return byRating;
    const byContext = (b.context_length ?? 0) - (a.context_length ?? 0);
    if (byContext !== 0) return byContext;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/** The requirements of the prompt now arriving: the brief's row by arrival order, else the body's own. */
function requirementsFor(body: Json, wire: 'openai' | 'anthropic'): Requirement {
  const entry = brief.prompts[manifestIndex];
  manifestIndex += 1;
  if (entry !== undefined) return entry.requires;
  return requirementsFromBody(body, wire);
}

/** Requirements read off a request body, for a brief that carries no row for this request. */
function requirementsFromBody(body: Json, wire: 'openai' | 'anthropic'): Requirement {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  let vision = false;
  for (const message of messages) {
    if (!isRecord(message) || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (isRecord(block) && (block.type === 'image' || block.type === 'image_url')) vision = true;
    }
  }
  const format = isRecord(body.response_format) ? body.response_format.type : undefined;
  void wire;
  return {
    tools: Array.isArray(body.tools) && body.tools.length > 0,
    vision,
    json: format === 'json_object' || format === 'json_schema',
  };
}

/** One client request body, or null when it is not one JSON object or is over the intake cap. */
async function readJson(req: IncomingMessage): Promise<Json | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > MAX_BODY_BYTES) return null;
    chunks.push(buffer);
  }
  if (chunks.length === 0) return null;
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(text),
    ...headers,
  });
  res.end(text);
}

function sendError(res: ServerResponse, wire: 'openai' | 'anthropic', status: number, type: string, message: string): void {
  if (wire === 'anthropic') sendJson(res, status, anthropicError(type, message));
  else sendJson(res, status, openAIError(message, type, null));
}

/** One refusal this server recovered from, as the trail header reports it. */
interface TrailRow {
  status: number;
  code: string;
  model: string | null;
}

/**
 * The `x-makefun-upstream-failures` header: the refusals behind a prompt this server still served, in the
 * order the calls refused. It is optional, and it is the only way the failover column learns that a prompt
 * was refused at all before it was answered. A trail over eight rows or over the size cap is dropped whole,
 * so it is trimmed here rather than sent malformed.
 */
function trailHeaders(trail: readonly TrailRow[]): Record<string, string> {
  if (trail.length === 0) return {};
  const rows = trail.slice(0, MAX_TRAIL_ROWS).map((row) => ({
    status: row.status,
    code: row.code.slice(0, 80),
    model: row.model,
  }));
  const text = JSON.stringify(rows);
  if (Buffer.byteLength(text) > MAX_TRAIL_BYTES) return {};
  return { 'x-makefun-upstream-failures': text };
}

/** The gateway's error code, as its own body spells it, for the trail. */
function refusalCode(status: number, text: string): string {
  try {
    const value: unknown = JSON.parse(text);
    if (isRecord(value)) {
      if (isRecord(value.error) && typeof value.error.code === 'string') return value.error.code;
      if (typeof value.code === 'string') return value.code;
      if (isRecord(value.error) && typeof value.error.type === 'string') return value.error.type;
    }
  } catch {
    // Not JSON: the status alone is what is known.
  }
  return status === 429 ? 'rate_limited' : status >= 500 ? 'server_error' : 'refused';
}

/** GET /v1/models, in the shape of the auth header the client sent. */
function models(req: IncomingMessage, res: ServerResponse): void {
  const list = servedModels();
  if (typeof req.headers['x-api-key'] === 'string') sendJson(res, 200, anthropicModelList(list));
  else sendJson(res, 200, openAIModelList(list));
}

/** The body a prompt is dialled with: the client's own, with the chosen model in place of `auto`. */
function dialBody(body: Json, model: string): Json {
  return { ...body, model };
}

/** POST one request to the gateway's Chat Completions route, naming the model this entry dialled. */
async function dial(body: Json): Promise<Response> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    authorization: `Bearer ${GATEWAY_KEY}`,
  };
  if (body.stream === true) headers.accept = 'text/event-stream';
  return fetch(chatCompletionsUrl(), { method: 'POST', headers, body: JSON.stringify(body) });
}

/** What one prompt's attempt loop came to: the model and answer that served it, or why none did. */
type Attempt =
  | { ok: true; model: ModelRow; upstream: Response; trail: TrailRow[] }
  | { ok: false; status: number; text: string; trail: TrailRow[] };

/**
 * Serve one prompt: walk the candidates strongest first, and take the first real answer. A provider that
 * is merely busy (429, 408, 425, a 5xx) is asked once more on the same model before the prompt moves on,
 * because the strongest model is worth one extra call; a model that is unavailable (403, 404, a 400) is
 * not asked again. Every refusal is counted against its model, so later prompts start lower down the list,
 * and kept for the trail the failover column reads. A whole list that refused answers with the last refusal.
 */
async function attempt(requires: Requirement, body: Json, wire: 'openai' | 'anthropic'): Promise<Attempt> {
  const order = candidateOrder(requires);
  const trail: TrailRow[] = [];
  let status = 0;
  let text = '';
  let calls = 0;
  if (order.length === 0) return { ok: false, status: 503, text: 'no free model meets this request', trail };
  for (const model of order) {
    if (calls >= MAX_CALLS_PER_PROMPT) break;
    const dialled = wire === 'anthropic' ? anthropicToChat(body, model.id) : body;
    for (let tries = 0; tries < 2 && calls < MAX_CALLS_PER_PROMPT; tries += 1) {
      calls += 1;
      let upstream: Response;
      try {
        upstream = await dial(dialBody(dialled, model.id));
      } catch (err) {
        refusals.set(model.id, (refusals.get(model.id) ?? 0) + 1);
        trail.push({ status: 502, code: 'unreachable', model: model.id });
        log(`${model.id}: ${(err as Error).message}`);
        break;
      }
      if (!upstream.ok || upstream.body === null) {
        status = upstream.ok ? 502 : upstream.status;
        text = (await upstream.text()).slice(0, 500);
        refusals.set(model.id, (refusals.get(model.id) ?? 0) + 1);
        trail.push({ status, code: refusalCode(status, text), model: model.id });
        log(`${model.id} refused HTTP ${status}`);
        if (!worthRetrying(status)) break;
        continue;
      }
      return { ok: true, model, upstream, trail };
    }
  }
  return { ok: false, status, text, trail };
}

/** A prompt this server could not serve at all: the client's wire's own error shape, with the trail. */
function giveUp(res: ServerResponse, wire: 'openai' | 'anthropic', failure: Attempt, trail: TrailRow[]): void {
  const status = failure.ok === false && failure.status >= 400 ? failure.status : 502;
  const detail = failure.ok === false && failure.text !== '' ? `: ${failure.text}` : '';
  const headers = trailHeaders(trail);
  if (wire === 'anthropic') {
    sendJson(res, status, anthropicError('api_error', `every free model refused this prompt${detail}`), headers);
  } else {
    sendJson(res, status, openAIError(`every free model refused this prompt${detail}`, 'upstream_error', null), headers);
  }
}

/** POST /v1/chat/completions: an OpenAI-shaped client, answered by the strongest free model that can serve it. */
async function chat(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJson(req);
  if (body === null) return sendError(res, 'openai', 400, 'invalid_request_error', 'the request body is not one JSON object');
  const requires = requirementsFor(body, 'openai');
  const result = await attempt(requires, body, 'openai');
  if (!result.ok) return giveUp(res, 'openai', result, result.trail);
  const headers = trailHeaders(result.trail);
  if (body.stream === true) {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      ...headers,
    });
    try {
      for await (const frame of openAIStreamFrames(result.upstream.body as ReadableStream<Uint8Array>, result.model.id)) {
        res.write(frame);
      }
    } finally {
      res.end();
    }
    return;
  }
  const answer: unknown = await result.upstream.json();
  sendJson(res, 200, openAIJsonWithModel(isRecord(answer) ? answer : {}, result.model.id), headers);
}

/** POST /v1/messages: an Anthropic-shaped client, rewritten to Chat Completions and answered back. */
async function messages(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJson(req);
  if (body === null) return sendError(res, 'anthropic', 400, 'invalid_request_error', 'the request body is not one JSON object');
  const requires = requirementsFor(body, 'anthropic');
  const result = await attempt(requires, body, 'anthropic');
  if (!result.ok) return giveUp(res, 'anthropic', result, result.trail);
  const headers = trailHeaders(result.trail);
  if (body.stream === true) {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      ...headers,
    });
    try {
      for await (const event of anthropicEventsFromChat(result.upstream.body as ReadableStream<Uint8Array>, result.model.id)) {
        res.write(event);
      }
    } finally {
      res.end();
    }
    return;
  }
  const answer: unknown = await result.upstream.json();
  sendJson(res, 200, openAIToAnthropic(isRecord(answer) ? answer : {}, result.model.id), headers);
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://entry');
  if (req.method === 'GET' && url.pathname === '/v1/models') {
    models(req, res);
    return;
  }
  if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
    await chat(req, res);
    return;
  }
  if (req.method === 'POST' && url.pathname === '/v1/messages') {
    await messages(req, res);
    return;
  }
  sendError(
    res,
    url.pathname === '/v1/messages' ? 'anthropic' : 'openai',
    404,
    'not_found',
    `no route ${req.method ?? ''} ${url.pathname}`,
  );
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    // A free port of this server's own: the env holds 8080 at MAKEFUN_ENV_URL.
    server.listen(0, '0.0.0.0', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') reject(new Error('no port'));
      else resolve(address.port);
    });
  });
}

/** Register the port and the catalog with the env, which then starts sending the trial's prompts. */
async function register(port: number): Promise<void> {
  const body = JSON.stringify({ protocol_version: PROTOCOL_VERSION, port, catalog });
  const answer = await fetch(`${ENV_URL}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });
  const text = await answer.text();
  if (!answer.ok) throw new Error(`register answered HTTP ${answer.status}: ${text.slice(0, 300)}`);
  log(`registered on ${port}: ${text.slice(0, 120)}`);
}

/** Ask the env whether every prompt has been sent; when it says done, the trial is over. */
async function work(server: Server): Promise<void> {
  for (;;) {
    let done = false;
    try {
      const answer = await fetch(`${ENV_URL}/work`);
      if (answer.ok) {
        const value: unknown = await answer.json();
        done = isRecord(value) && value.done === true;
      }
    } catch (err) {
      log(`work poll failed: ${(err as Error).message}`);
    }
    if (done) {
      log('work is done: exiting 0');
      server.close();
      process.exit(0);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

async function start(): Promise<void> {
  if (brief.error !== null) log(`brief: ${brief.error}`);
  log(`${freeModels(brief).length} free models, ${brief.prompts.length} prompts, gateway ${GATEWAY_URL || '(none)'}`);
  if (ENV_URL === '') throw new Error('MAKEFUN_ENV_URL is not set');
  const server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      log(`request failed: ${(err as Error).message}`);
      if (!res.headersSent) sendError(res, 'openai', 500, 'api_error', (err as Error).message);
      else res.end();
    });
  });
  const port = await listen(server);
  await register(port);
  await work(server);
}

/** `node main.ts --list`: the catalog document, byte for byte as the register body carries it. */
function list(): void {
  process.stdout.write(`${JSON.stringify(catalog)}\n`);
}

if (process.argv.includes('--list')) {
  list();
} else {
  start().catch((err: unknown) => {
    log(`fatal: ${(err as Error).message}`);
    process.exit(1);
  });
}
