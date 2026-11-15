// lib/catalog.ts
// The 14 live free models this entry can serve, taken from the
// competition register (practice/trial-0/reference/ratings.json).
// The catalog lives here, in one typed place, instead of inline in
// providers.ts, so a drift between the models the server advertises
// and the models the register grades fails fast at startup instead
// of mid-trial. Ratings are milli-points: higher is better.

export type ModelEntry = {
  id: string;
  ratingMilli: number;
  contextLength: number;
  json: boolean;
  tools: boolean;
  vision: boolean;
  free: boolean;
};

export const CATALOG: readonly ModelEntry[] = [
  { id: "openrouter/baidu/ernie-5.5-flash-preview:free", ratingMilli: 1150, contextLength: 1024000, json: true, tools: true, vision: false, free: true },
  { id: "openrouter/cohere/north-mini-code:free", ratingMilli: 1200, contextLength: 256000, json: false, tools: true, vision: false, free: true },
  { id: "openrouter/dots-studio/dots-3-note-preview:free", ratingMilli: 1150, contextLength: 512000, json: true, tools: true, vision: true, free: true },
  { id: "openrouter/google/gemma-4-26b-a4b-it:free", ratingMilli: 1150, contextLength: 262144, json: true, tools: true, vision: true, free: true },
  { id: "openrouter/google/gemma-4-31b-it:free", ratingMilli: 1210, contextLength: 262144, json: true, tools: true, vision: true, free: true },
  { id: "openrouter/inclusionai/ling-3.2-flash:free", ratingMilli: 1150, contextLength: 1048576, json: true, tools: true, vision: true, free: true },
  { id: "openrouter/liquid/lfm-3-1.7b:free", ratingMilli: 1150, contextLength: 262144, json: true, tools: true, vision: false, free: true },
  { id: "openrouter/nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free", ratingMilli: 1150, contextLength: 256000, json: false, tools: true, vision: true, free: true },
  { id: "openrouter/nvidia/nemotron-3-ultra-550b-a55b:free", ratingMilli: 1285, contextLength: 1000000, json: false, tools: true, vision: false, free: true },
  { id: "openrouter/nvidia/nemotron-3.5-lightning:free", ratingMilli: 1221, contextLength: 1000000, json: false, tools: true, vision: false, free: true },
  { id: "openrouter/nvidia/nemotron-3.5-super-vl:free", ratingMilli: 1303, contextLength: 1000000, json: true, tools: true, vision: true, free: true },
  { id: "openrouter/particle-ai/particle-1:free", ratingMilli: 1150, contextLength: 1048576, json: true, tools: true, vision: true, free: true },
  { id: "openrouter/recursive/flint-v1.0:free", ratingMilli: 1150, contextLength: 262144, json: true, tools: true, vision: false, free: true },
  { id: "openrouter/thinkingmachines/inkling-2-small:free", ratingMilli: 1475, contextLength: 1048576, json: false, tools: true, vision: true, free: true },
];

// The register's ratings, keyed by model id. validateCatalog() checks
// every CATALOG entry against this table, so a typo or a stale rating
// in the catalog above is caught here, at startup, not by a lost trial.
const EXPECTED_RATINGS: Readonly<Record<string, number>> = {
  "openrouter/baidu/ernie-5.5-flash-preview:free": 1150,
  "openrouter/cohere/north-mini-code:free": 1200,
  "openrouter/dots-studio/dots-3-note-preview:free": 1150,
  "openrouter/google/gemma-4-26b-a4b-it:free": 1150,
  "openrouter/google/gemma-4-31b-it:free": 1210,
  "openrouter/inclusionai/ling-3.2-flash:free": 1150,
  "openrouter/liquid/lfm-3-1.7b:free": 1150,
  "openrouter/nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free": 1150,
  "openrouter/nvidia/nemotron-3-ultra-550b-a55b:free": 1285,
  "openrouter/nvidia/nemotron-3.5-lightning:free": 1221,
  "openrouter/nvidia/nemotron-3.5-super-vl:free": 1303,
  "openrouter/particle-ai/particle-1:free": 1150,
  "openrouter/recursive/flint-v1.0:free": 1150,
  "openrouter/thinkingmachines/inkling-2-small:free": 1475,
};

// The two routing anchors the entry depends on: the best model overall
// and the best model that can answer in JSON. If the register ever
// moves either anchor, routing must be re-checked, so fail loudly.
const BEST_OVERALL_ID = "openrouter/thinkingmachines/inkling-2-small:free";
const BEST_OVERALL_RATING = 1475;
const BEST_JSON_ID = "openrouter/nvidia/nemotron-3.5-super-vl:free";
const BEST_JSON_RATING = 1303;

function highestRated(entries: readonly ModelEntry[]): ModelEntry {
  let best = entries[0];
  for (const entry of entries.slice(1)) {
    if (entry.ratingMilli > best.ratingMilli) best = entry;
  }
  return best;
}

export function validateCatalog(entries: readonly ModelEntry[] = CATALOG): void {
  if (entries.length !== 14) {
    throw new Error(`catalog must hold exactly 14 models, got ${entries.length}`);
  }
  const seen = new Set<string>();
  for (const entry of entries) {
    if (!entry.id.startsWith("openrouter/") || !entry.id.endsWith(":free")) {
      throw new Error(`catalog id is not a free OpenRouter model: ${entry.id}`);
    }
    if (seen.has(entry.id)) {
      throw new Error(`catalog repeats model id: ${entry.id}`);
    }
    seen.add(entry.id);
    if (entry.free !== true) {
      throw new Error(`catalog model is not free: ${entry.id}`);
    }
    const expected = EXPECTED_RATINGS[entry.id];
    if (expected === undefined) {
      throw new Error(`catalog lists a model the register does not: ${entry.id}`);
    }
    if (entry.ratingMilli !== expected) {
      throw new Error(`catalog rating for ${entry.id} is ${entry.ratingMilli}, register says ${expected}`);
    }
  }
  const best = highestRated(entries);
  if (best.id !== BEST_OVERALL_ID || best.ratingMilli !== BEST_OVERALL_RATING) {
    throw new Error(`catalog best model changed: ${best.id} at ${best.ratingMilli}`);
  }
  const bestJson = highestRated(entries.filter((entry) => entry.json));
  if (bestJson.id !== BEST_JSON_ID || bestJson.ratingMilli !== BEST_JSON_RATING) {
    throw new Error(`catalog best json-capable model changed: ${bestJson.id} at ${bestJson.ratingMilli}`);
  }
}

// A fresh copy each time, so no caller can mutate the shared catalog.
export function catalog(): ModelEntry[] {
  return CATALOG.map((entry) => ({ ...entry }));
}

export function byId(id: string): ModelEntry | undefined {
  return CATALOG.find((entry) => entry.id === id);
}

// Fail fast: any drift is caught the moment this module is imported.
validateCatalog();
