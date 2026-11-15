// Rating-ordered routing and failover for the -02 gateway.
//
// The -02 trial sends six prompts at fourteen real free models through one gateway, and the
// score's quality column (60%) is the rating of the model that really served each prompt
// against the best rating a free model meeting that prompt could have given. Routing is
// therefore simple and strict: for every prompt, try the best free model that meets its
// requirements first, then the next best, and so on. There is no per-model budget to spread
// across and no failure schedule to dodge by load-balancing (the sibling -01 contest had
// both); spreading within a few milli-points of the best would only give quality away.
//
// A model that refuses is demoted behind every model that never refused, for the rest of the
// trial: a 429 is a per-model rate limit on OpenRouter's free tier, and a 5xx is that provider
// failing, so the same model is the least likely to answer the next prompt. The demotion is a
// pure function of the refusals seen so far, never of the clock, so a replay that sees the same
// gateway answers makes the same choices.
//
// Attempts are capped at 3 gateway calls a prompt (6 prompts, so at most 18 calls, far under
// the trial's 60-call cap; the tie-break is fewer calls, so a prompt that serves first try
// costs exactly 1). A 401 stops at once: the key is the problem and no other model will answer
// on it. A 429 or 5xx fails over to the next candidate. Any other 4xx fails over once, then
// stops: a 400 is likelier a property of the request than of the model. A fetch that throws
// (the gateway unreachable) counts as a refusal and fails over the same way.
//
// Every refusal is recorded for the `x-makefun-upstream-failures` trail: the failover column
// can only see a refusal the server recovered from when the served response carries the trail,
// because the env sees the answers and never the gateway's traffic. The trail is at most 8
// rows, each {status, code, model}, in the order the calls refused.

import { capabilitiesOf, meetsRequirements, type Json, type ModelRow, type Requirement } from './providers.ts';

/** One refused gateway call, as the `x-makefun-upstream-failures` trail carries it. */
export interface Refusal {
  status: number;
  code: string;
  model: string | null;
}

/** A gateway call that answered: the model that served it and its raw response. */
export interface ServedCall {
  model: ModelRow;
  response: Response;
  /** The refusals this prompt cost before it was served, in the order they happened. */
  failures: Refusal[];
}

/** The most gateway calls one prompt may cost. */
export const MAX_ATTEMPTS = 3;

/** The order to try the models that meet a prompt: best rating first, ties by id, and a model
 *  that refused before behind every model that never refused. */
export function candidatesFor(requires: Requirement, models: readonly ModelRow[], refused: ReadonlySet<string>): ModelRow[] {
  const byRating = (a: ModelRow, b: ModelRow): number =>
    b.rating_milli - a.rating_milli || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const fresh: ModelRow[] = [];
  const cooled: ModelRow[] = [];
  for (const model of models) {
    if (!model.free) continue;
    if (!meetsRequirements(requires, capabilitiesOf(model))) continue;
    (refused.has(model.id) ? cooled : fresh).push(model);
  }
  fresh.sort(byRating);
  cooled.sort(byRating);
  return [...fresh, ...cooled];
}

/** The error code a refused gateway call carries: the provider's own code when it names one. */
export function errorCodeOf(status: number, bodyText: string): string {
  try {
    const parsed: unknown = JSON.parse(bodyText);
    if (parsed !== null && typeof parsed === 'object') {
      const error = (parsed as Json).error;
      if (error !== null && typeof error === 'object') {
        const code = (error as Json).code ?? (error as Json).type;
        if (typeof code === 'string' && code !== '') return code;
      }
      const code = (parsed as Json).code;
      if (typeof code === 'string' && code !== '') return code;
    }
  } catch {
    // Not JSON: fall through to the status.
  }
  return `http_${status}`;
}

/**
 * Serve one prompt through the gateway, failing over across the candidates in rating order.
 * `dial` makes one gateway call for a model and returns its raw response (or throws when the
 * gateway cannot be reached at all). Returns the first answered call with its refusal trail,
 * or null when no candidate served the prompt.
 */
export async function servePrompt(
  requires: Requirement,
  models: readonly ModelRow[],
  refused: Set<string>,
  dial: (model: ModelRow) => Promise<Response>,
): Promise<ServedCall | null> {
  const candidates = candidatesFor(requires, models, refused);
  const failures: Refusal[] = [];
  let attempts = 0;
  for (const model of candidates) {
    if (attempts >= MAX_ATTEMPTS) break;
    attempts += 1;
    let response: Response;
    try {
      response = await dial(model);
    } catch {
      failures.push({ status: 0, code: 'fetch_error', model: model.id });
      refused.add(model.id);
      continue;
    }
    if (response.ok) return { model, response, failures };
    const text = await response.text().catch(() => '');
    failures.push({ status: response.status, code: errorCodeOf(response.status, text), model: model.id });
    refused.add(model.id);
    // A 401 is the key, not the model: no other model will answer on it, so stop at once.
    if (response.status === 401) break;
    // Any other 4xx is likelier the request than the model: one failover, then stop.
    if (response.status >= 400 && response.status < 500 && response.status !== 429 && failures.length >= 2) break;
  }
  return null;
}
