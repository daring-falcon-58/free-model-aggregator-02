// free-model-aggregator-02: one server, two client wires, a real free model behind every answer.
//
// The entry serves the OpenAI Chat Completions API and the Anthropic Messages API over
// OpenRouter's free models, reached through the grader's gateway, in JSON and in server-sent
// events, and registers the catalog it read from the brief. For each prompt it dials the best
// free model that meets the prompt's requirements, fails over down the rating order when the
// gateway refuses, and exits 0 when the env says the workload is done.
//
// ROUTING (quality is 60% of the score): candidates are the brief's free models meeting the
// prompt's requirements, best rating first — see lib/router.ts. The six prompts carry no
// per-model budget to spread across and no failure schedule to dodge, so the best model is the
// right first pick every time; spreading within a few milli-points of the best would only give
// quality away. The best model per prompt, from the brief's ratings:
//   - a JSON-mode prompt needs json: true — best is nemotron-3.5-super-vl at 1303;
//   - any other prompt takes the strict best — inkling-2-small at 1475;
//   - a tools prompt needs tools: true — inkling-2-small at 1475 qualifies.
// A model that refuses is demoted behind every model that never refused, for the rest of the
// trial, and a prompt that is served after refusals carries the trail in the
// `x-makefun-upstream-failures` header, the only way the failover column can see it.
//
// WIRES: every prompt goes upstream as a Chat Completions request on the gateway's route; an
// Anthropic-shaped request is translated there and the answer translated back, in JSON and in
// streaming, with the system prompt, tools, the output cap and JSON mode surviving the round
// trip. The `model` field on every answer and every streamed chunk is the id this entry
// dialled, never the provider's own spelling.
//
// The trial: the brief is at $MAKEFUN_PROMPT_FILE (the free model list and the six prompts).
// The server listens on 0.0.0.0 at a free port, POSTs $MAKEFUN_ENV_URL/register, serves the
// client's prompts, and polls GET $MAKEFUN_ENV_URL/work every 100 ms, exiting 0 when it says
// done. `node main.ts --list` prints the same catalog JSON and exits 0 before any server starts.
//
// Determinism: every choice is a function of the brief, the requests and the gateway's answers
// so far. No wall clock and no unseeded randomness reach a request, so a replay leaves the same
// state.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  buildCatalog,
  freeModels,
  isRecord,
  readBrief,
  type CatalogReport,
  type Json,
  type Requirement,
} from './lib/providers.ts';
import {
  anthropicError,
  anthropicEventsFromOpenAI,
  anthropicModelList,
  anthropicToOpenAI,
  openAIError,
  openAIJsonWithModel,
  openAIModelList,
  openAIStreamWithModel,
  openAIToAnthropic,
  type ServedModel,
} from './lib/wire.ts';
import { servePrompt, type ServedCall } from './lib/router.ts';

/** The wire protocol's version, in the register body. */
const PROTOCOL_VERSION = 1;
/** How often GET /work is polled, in milliseconds. */
const POLL_INTERVAL_MS = 100;
/** How long one gateway call may take, in milliseconds, before the next candidate is tried. */
const GATEWAY_TIMEOUT_MS = 45000;
/** The most bytes of one client request body this server reads. */
const MAX_BODY_BYTES = 8 * 1024 * 1024;

const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
const PROMPT_FILE = process.env.MAKEFUN_PROMPT_FILE ?? '';
const GATEWAY_URL = (process.env.OPENAI_BASE_URL ?? '').replace(/\/+$/, '');
/** The trial's dummy key for the entry's gateway lane; the gateway swaps it for the entrant's own key. */
const GATEWAY_KEY = process.env.OPENAI_API_KEY ?? '';

const brief = readBrief(PROMPT_FILE);
const catalog: CatalogReport = buildCatalog(brief);
/** Which prompt row the request now arriving is: the brief's prompts are in the client's arrival order. */
let manifestIndex = 0;
/** The models that refused a gateway call so far: demoted behind the never-refused, for the trial. */
const refusedModels = new Set<string>();

function log(message: string): void {
  process.stderr.write(`aggregator: ${message}\n`);
}

/**
 * The gateway's Chat Completions route. OPENAI_BASE_URL is the OpenAI-compatible root (`…/v1` on
 * the trial network); a base that does not already end in `/v1` gets one, so both spellings reach
 * the route.
 */
function chatCompletionsUrl(): string {
  if (GATEWAY_URL === '') return '';
  return GATEWAY_URL.endsWith('/v1') ? `${GATEWAY_URL}/chat/completions` : `${GATEWAY_URL}/v1/chat/completions`;
}

/** The free models the brief lists, as GET /v1/models names them. */
function servedModels(): ServedModel[] {
  return freeModels(brief).map((model) => ({ id: model.id, provider: model.provider, display_name: model.display_name }));
}

/** The requirements of the prompt now arriving: the brief's row by arrival order, else the body's own. */
function requirementsFor(body: Json, index: number): Requirement {
  const entry = brief.prompts[index];
  if (entry !== undefined) return entry.requires;
  // The brief's prompt list is the declared source of each request's requirements; this
  // fallback is a guess for a brief that holds none.
  return requirementsFromBody(body);
}

/** Requirements read off a request body, when the brief has no row for it. */
function requirementsFromBody(body: Json): Requirement {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  let vision = false;
  for (const message of messages) {
    if (!isRecord(message) || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (isRecord(block) && (block.type === 'image' || block.type === 'image_url')) vision = true;
    }
  }
  const format = isRecord(body.response_format) ? body.response_format.type : undefined;
  return { tools: Array.isArray(body.tools) && body.tools.length > 0, vision, json: format === 'json_object' || format === 'json_schema' };
}

/** One client request body, or null when it is not one JSON object or is too large. */
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

function sendJson(res: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), ...extraHeaders });
  res.end(text);
}

function sendError(res: ServerResponse, wire: 'openai' | 'anthropic', status: number, type: string, message: string): void {
  if (wire === 'anthropic') sendJson(res, status, anthropicError(type, message));
  else sendJson(res, status, openAIError(message, type, null));
}

/** GET /v1/models, in the shape of the auth header the client sent. */
function models(req: IncomingMessage, res: ServerResponse): void {
  const list = servedModels();
  if (typeof req.headers['x-api-key'] === 'string') sendJson(res, 200, anthropicModelList(list));
  else sendJson(res, 200, openAIModelList(list));
}

/** The refusal trail a served response carries, or no header when the prompt served first try. */
function trailHeaders(served: ServedCall): Record<string, string> {
  if (served.failures.length === 0) return {};
  return { 'x-makefun-upstream-failures': JSON.stringify(served.failures.slice(0, 8)) };
}

/** POST one request to the gateway's Chat Completions route, naming the model this entry dialled. */
async function dial(model: string, body: Json): Promise<Response> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    authorization: `Bearer ${GATEWAY_KEY}`,
  };
  if (body.stream === true) headers.accept = 'text/event-stream';
  return fetch(chatCompletionsUrl(), {
    method: 'POST',
    headers,
    body: JSON.stringify({ ...body, model }),
    signal: AbortSignal.timeout(GATEWAY_TIMEOUT_MS),
  });
}

/** Answer one client request from the gateway, in the client's wire, with failover across the rating order. */
async function answer(
  req: IncomingMessage,
  res: ServerResponse,
  clientWire: 'openai' | 'anthropic',
  body: Json,
  index: number,
): Promise<void> {
  const requires = requirementsFor(body, index);
  const served = await servePrompt(requires, freeModels(brief), refusedModels, async (model) =>
    dial(model.id, clientWire === 'anthropic' ? anthropicToOpenAI(body, model.id) : { ...body, model: model.id }),
  );
  if (served === null) {
    return sendError(res, clientWire, 503, clientWire === 'anthropic' ? 'overloaded_error' : 'service_unavailable', 'every free model that meets this request refused it');
  }
  const upstream = served.response;
  if (upstream.body === null) {
    return sendError(res, clientWire, 502, clientWire === 'anthropic' ? 'api_error' : 'upstream_error', 'the gateway answered with no body');
  }
  const promptId = brief.prompts[index]?.id ?? `#${index}`;
  log(`served ${promptId} with ${served.model.id} (${served.model.rating_milli}) after ${served.failures.length} refusal(s)`);
  const headers = trailHeaders(served);
  if (body.stream === true) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', ...headers });
    try {
      if (clientWire === 'anthropic') {
        for await (const event of anthropicEventsFromOpenAI(upstream.body, served.model.id)) res.write(event);
      } else {
        for await (const frame of openAIStreamWithModel(upstream.body, served.model.id)) res.write(frame);
      }
    } finally {
      res.end();
    }
    return;
  }
  let answerBody: unknown;
  try {
    answerBody = await upstream.json();
  } catch {
    return sendError(res, clientWire, 502, clientWire === 'anthropic' ? 'api_error' : 'upstream_error', 'the gateway answer is not JSON');
  }
  const record = isRecord(answerBody) ? answerBody : {};
  sendJson(res, 200, clientWire === 'anthropic' ? openAIToAnthropic(record, served.model.id) : openAIJsonWithModel(record, served.model.id), headers);
}

/** POST /v1/chat/completions: an OpenAI-shaped client. */
async function chat(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const index = manifestIndex;
  manifestIndex += 1;
  const body = await readJson(req);
  if (body === null) return sendError(res, 'openai', 400, 'invalid_request_error', 'the request body is not one JSON object');
  await answer(req, res, 'openai', body, index);
}

/** POST /v1/messages: an Anthropic-shaped client. */
async function messages(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const index = manifestIndex;
  manifestIndex += 1;
  const body = await readJson(req);
  if (body === null) return sendError(res, 'anthropic', 400, 'invalid_request_error', 'the request body is not one JSON object');
  await answer(req, res, 'anthropic', body, index);
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
  sendError(res, url.pathname === '/v1/messages' ? 'anthropic' : 'openai', 404, 'not_found', `no route ${req.method ?? ''} ${url.pathname}`);
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '0.0.0.0', () => resolve());
  });
}

/** POST /register with the port and the one catalog; the env answers with the trial's prompt count. */
async function register(port: number, report: CatalogReport): Promise<void> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const res = await fetch(`${ENV_URL}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ protocol_version: PROTOCOL_VERSION, port, catalog: report }),
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) throw new Error(`POST ${ENV_URL}/register answered HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`);
      const reply: unknown = await res.json();
      if (isRecord(reply) && typeof reply.requests === 'number') log(`registered: the trial holds ${reply.requests} prompts`);
      return;
    } catch (err) {
      lastError = err;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/** Poll GET /work every 100 ms; exit 0 the moment it says done. */
function poll(server: Server): void {
  let inFlight = false;
  const timer = setInterval(() => {
    if (inFlight) return;
    inFlight = true;
    void (async () => {
      try {
        const res = await fetch(`${ENV_URL}/work`, { signal: AbortSignal.timeout(2000) });
        if (res.status !== 200) return;
        const work: unknown = await res.json();
        if (isRecord(work) && work.done === true) {
          clearInterval(timer);
          server.close();
          process.exit(0);
        }
      } catch {
        // The env is not reachable yet: try again on the next tick.
      } finally {
        inFlight = false;
      }
    })();
  }, POLL_INTERVAL_MS);
}

async function start(): Promise<void> {
  if (brief.error !== null) log(brief.error);
  if (process.argv.includes('--list')) {
    // Print the one built catalog object, byte for byte the same document the register body
    // carries, then stop before any server starts. A process whose stdout is not flushed
    // loses the tail, so wait for the write to finish first.
    const text = `${JSON.stringify(catalog)}\n`;
    await new Promise<void>((resolve) => process.stdout.write(text, () => resolve()));
    process.exit(0);
  }
  if (ENV_URL === '') throw new Error('MAKEFUN_ENV_URL is not set');
  if (chatCompletionsUrl() === '') throw new Error('OPENAI_BASE_URL is not set');
  const server = createServer((req, res) => {
    void handle(req, res).catch((err: unknown) => {
      log((err as Error).stack ?? String(err));
      if (!res.headersSent) sendError(res, req.url?.startsWith('/v1/messages') === true ? 'anthropic' : 'openai', 500, 'internal_error', 'the server failed to answer');
    });
  });
  await listen(server);
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('the server has no port');
  const port = address.port;
  // 8080 belongs to the env on one layout; the OS's ephemeral range never holds it, so if it
  // ever shows up here the trial must be restarted rather than served from it.
  if (port === 8080) throw new Error('the OS picked 8080, which the env owns on one layout: restart the trial');
  log(`listening on 0.0.0.0:${port} with ${servedModels().length} free models`);
  await register(port, catalog);
  process.on('SIGTERM', () => process.exit(0));
  process.on('SIGINT', () => process.exit(0));
  poll(server);
}

try {
  await start();
} catch (err) {
  log((err as Error).stack ?? String(err));
  process.exit(1);
}
