# free-model-aggregator-02

One server, two API wires, a real free model behind every answer.

The server serves the OpenAI Chat Completions API (`POST /v1/chat/completions`) and the
Anthropic Messages API (`POST /v1/messages`), in JSON and in server-sent events, over
OpenRouter's fourteen free models, reached through the grader's gateway. For each of the six
prompts it dials the best free model that meets the prompt's requirements, fails over down the
rating order when the gateway refuses, and reports the catalog it read from the brief.

## Routing

Quality is 60% of the score: the rating of the model that really served each prompt, over the
best rating a free model meeting that prompt could have given. So the routing is strict best
first — no load-spreading, because there is no per-model budget to spread across:

- a JSON-mode prompt needs `json: true` — best is `openrouter/nvidia/nemotron-3.5-super-vl:free` (1303);
- any other prompt takes the strict best — `openrouter/thinkingmachines/inkling-2-small:free` (1475);
- a tools prompt needs `tools: true` — inkling-2-small (1475) qualifies.

A model that refuses is demoted behind every model that never refused, for the rest of the
trial. A prompt served after refusals carries the trail in the
`x-makefun-upstream-failures` header, the only way the failover column can see it. At most 3
gateway calls per prompt; a 401 stops at once (the key is the problem).

## Run

```sh
node main.ts --list   # prints the catalog document the server registers, byte for byte
node main.ts          # serves; needs MAKEFUN_ENV_URL, MAKEFUN_PROMPT_FILE, OPENAI_BASE_URL
```

The server listens on `0.0.0.0` at a free port, registers it at
`POST $MAKEFUN_ENV_URL/register`, serves the client's prompts, polls
`GET $MAKEFUN_ENV_URL/work` every 100 ms and exits 0 when it says done.

## Layout

- `main.ts` — the server: routes, register, poll, `--list`.
- `lib/providers.ts` — the brief's two documents, the free model list, the catalog.
- `lib/wire.ts` — the client wires and the one upstream wire; the model field.
- `lib/router.ts` — rating-ordered candidates, failover, the refusal trail.

## License

MIT.
