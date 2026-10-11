# Mongostylingsystem

RackSavant's **inventory-aware personal styling workforce** on MongoDB Atlas.

Agents do the work, tasks bubble up to a human stylist, and the outcome is a personalized outfit that mixes **items from our MongoDB inventory** with **items agents found elsewhere**. Approved external items are promoted into inventory, so the catalog builds itself. Every agent action is logged for observability.

```
POST /style {shopper_id, intent}
   |
   v
SCOUT    measures inventory coverage per role, opens `sourced_items` for gaps
   |
   v
STYLIST  composes outfit = inventory U sourced candidates   -> outfit: pending_review
   |
   v
TASK     `outfit_review` (and `source_intake`) opens in the HITL queue   <- human stylist
   |
   v
DECISION POST /tasks/:id/decision  -> outfit approved/rejected
                                   -> approved sourced item -> products (+ inventory events)
   |
   v
ANDROID  GET /outfits/:id -> tryon_items[].garment_image_url -> Gemini try-on

agent_events: append-only trace of every run (run_start / tool_call / llm_call /
              decision / escalate / run_end / error)
```

## Status (read this first)

| Area | State |
|---|---|
| Atlas schema, validators, indexes (7 collections) | Done, provisioned, tested |
| Idempotent importer (dry-run / update / report) | Done, tested |
| Workforce runner, HITL tasks, decisions, promotion | Done, verified end to end on live Atlas |
| REST API for Android | Done. Static bearer-token auth (`API_AUTH_TOKEN`), 64 KB body cap, tenant-id validation, no error-detail leaks. Per-user auth still to do (see Roadmap) |
| Scout | **Stub.** Inserts placeholder `sourced_items` for empty roles. No real sourcing yet |
| Stylist | Heuristic (newest active item per role). No embeddings or LLM yet |
| Per-user auth (Firebase), rate limiting, CORS | Not implemented |
| Trend library (vision descriptions, embeddings, vector search, review) | Built and verified for embeddings/search; Claude describe step untested live; agents not yet wired to it |
| Vector search over **inventory** products | Not implemented |
| MongoDB Agent Engine / Raindrop deployment | Not implemented |
| Android app integration | Not started (contract documented below) |
| Tests | Unit tests pass; integration tests are gated behind `RUN_DB_TESTS=1` |

Data in Atlas is **synthetic** (6 products, tenant `racksavant-dev`). Do not import the real catalog until it has been reviewed.

## Quick start

Requires [Bun](https://bun.sh).

```bash
bun install
cp .env.example .env         # fill in MONGODB_URI (never commit .env)
bun run db:init              # collections + validators + indexes (idempotent)
bun run db:import --dry-run  # validate + plan, writes nothing
bun run db:import            # seed synthetic catalog (rerun-safe)
bun run serve                # API on :8080 (PORT to override)
bun test                     # unit tests
RUN_DB_TESTS=1 bun test      # + live Atlas integration (uses MONGODB_TEST_DB)
bun run typecheck
```

Atlas Network Access must allow your egress IP. A server selection timeout almost always means the IP is not on the allowlist (use `x.x.x.x/32` form).

## Environment variables

See `.env.example`.

| Var | Required | Purpose |
|---|---|---|
| `MONGODB_URI` | yes | Atlas SRV connection string. Use a least-privilege user (readWrite on the app DB only) |
| `MONGODB_DB` | no (`needitnow`) | App database |
| `MONGODB_TEST_DB` | no (`needitnow_test`) | Isolated DB for integration tests |
| `RUN_DB_TESTS` | no | Set `1` to run live-DB tests |
| `API_AUTH_TOKEN` | yes for `bun run serve` | Bearer token (>= 24 chars) required on every route except `/health`. Server refuses to start without it. Generate with `openssl rand -hex 32` |
| `PORT` | no (`8080`) | API port |

Trend library only: `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`, `ATLAS_MODEL_API_KEY`, `EMBED_MODEL`, `EMBED_DIMENSIONS` (see the Trend library section). Planned (not yet read by code): ElevenLabs and AWS keys.

## Repository layout

```
src/data/schema.ts        single source of truth: collections, $jsonSchema validators, indexes
                          (bump SCHEMA_VERSION on shape changes)
src/data/mongo.ts         server-side Mongo client (env-driven, cached)
src/data/import-core.ts   pure validation + deterministic IDs + product doc builder
src/workforce/runner.ts   AgentRun: run_id, append-only agent_events, escalate() -> tasks
src/workforce/agents.ts   scout, stylist
src/workforce/decisions.ts decideTask(): human decision -> state transitions + intake/promotion
src/api/mapper.ts         Android Listing -> product payload; outfit -> try-on items
src/api/server.ts         Bun.serve REST API
scripts/init-db.ts        create/update collections, validators, indexes
scripts/import-products.ts importer CLI
scripts/seeds/            versioned synthetic seed data
tests/                    import-core, mapper (unit); integration (gated)
```

## Data model

All collections are tenant-scoped (`tenant_id`) and indexed by tenant.

| Collection | Purpose |
|---|---|
| `products` | Canonical catalog. Stable `product_id` (`prod_` + hash of tenant/system/external id), SKU, title, brand, category, `price_cents` + `currency`, condition, size/color/material, image refs, availability `status`, `source` provenance |
| `inventory_events` | Append-only ledger: received, listed, reserved, released, sold, returned, adjusted, archived. Supports one-off resale and consignment |
| `inventory_state` | Per-product rollup (on_hand / reserved / status). Rebuildable from events |
| `sourced_items` | Agent-found external candidates (`source_id`, url, retailer, `found_by` run). **Never** in `products` until a human approves intake |
| `outfits` | Items per role, each `inventory` (`product_id`) or `sourced` (`source_id`); status `draft / pending_review / approved / rejected / delivered` |
| `tasks` | HITL queue: `outfit_review`, `source_intake`, `signal_triage`, `custom`. Status `open / claimed / approved / rejected / snoozed / done`, priority, assignee, decision, notes |
| `agent_events` | Observability ledger, ordered by `seq` per `run_id` |

Outfit roles: `tops`, `bottoms`, `shoes`, `outerwear`, `accessories` (matches `products.category`).

### Importer guarantees

- Dedupes on `(tenant_id, product_id)` and `(tenant_id, source.system, source.external_id)`.
- Existing rows are skipped unless `--update`; update only touches mutable fields, never identity or provenance.
- Never deletes anything.
- Rejects invalid price, currency, condition, source type, and missing source identifiers.
- Prints a JSON report (received / valid / rejected / inserted / skipped / updated); `--report <path>` persists it.

## API

All routes except `/health` are `/v1/tenants/:tenantId/...`. JSON in, JSON out. Errors are `{ "error": "..." }`.

| Route | Purpose |
|---|---|
| `GET /health` | Liveness + db name |
| `GET .../products?status=&category=` | Inventory browse |
| `POST .../listings` | Bridge an Android `Listing` (Firestore shape) into `products`. Idempotent on `listingId`; USDC converted to cents |
| `POST .../style` `{shopper_id, intent}` | Runs scout then stylist. Returns `{outfitId, taskId, items, coverage, status: "pending_review"}` |
| `GET .../outfits/:id` | Outfit plus `tryon_items[]` |
| `GET .../tasks?status=open` | HITL queue, priority-ordered (stylist console) |
| `POST .../tasks/:id/decision` `{decision: approved\|rejected\|done, decided_by, notes?}` | Applies human decision; returns `effects` |
| `GET .../agent-events?run_id=&agent=` | Observability feed |

Example:

```bash
curl -X POST localhost:8080/v1/tenants/racksavant-dev/style \
  -H 'content-type: application/json' -d '{"shopper_id":"aria","intent":"smart casual dinner"}'
curl localhost:8080/v1/tenants/racksavant-dev/tasks?status=open
curl -X POST localhost:8080/v1/tenants/racksavant-dev/tasks/<taskId>/decision \
  -H 'content-type: application/json' -d '{"decision":"approved","decided_by":"stylist_maria"}'
```

### Try-on contract (Android)

`GET .../outfits/:id` returns `tryon_items[]`, one per role:

```json
{ "role": "tops", "kind": "inventory", "ref": "prod_...", "title": "...", "brand": "...",
  "price_cents": 3400, "currency": "USD",
  "garment_image_url": "https://...", "tryon_ready": true, "rationale": "..." }
```

`kind` is `inventory` or `sourced`. `tryon_ready: false` means no image; skip or hide the item. Seed image URLs are placeholders (`img.example.com`), so real images are required before a true try-on test.

Android side (repo `RackSavant/racksavant-android`, branch `feat/gemini-tryon`): `TryOnFragment` -> `TryOnViewModel` -> `GeminiTryOnRepository` currently take a garment image from camera/gallery. Integration means fetching `garment_image_url` as a bitmap and passing it into the same garment input. `Listing` fields map onto `products` via `src/api/mapper.ts`.

## Trend library ("base pairs")

Curated looks the agents retrieve from and learn from. Each full-outfit image is described by **Claude vision** in a fixed vocabulary, embedded with **Voyage (voyage-4-large)** through Atlas, and searched with **Atlas Vector Search**.

```
images + manifest -> Claude vision -> validate (src/trends/vocab.ts) -> Voyage embed
   -> trend_looks + trend_garments (pending_review) -> human review -> approved
   -> agents: searchTrendGarments() / trendLooksForIntent()   (approved only)
```

| Piece | Where |
|---|---|
| Collections + indexes | `trend_looks` (one per outfit image), `trend_garments` (one per piece; the retrieval unit) in `src/data/schema.ts` |
| Controlled vocabulary + validation | `src/trends/vocab.ts` (roles, seasons, licenses; rejects short or malformed descriptions) |
| Model clients | `src/trends/clients.ts` (Claude vision, Voyage embeddings, 429 backoff) |
| Pure doc builders | `src/trends/ingest-core.ts` |
| Agent retrieval | `src/trends/search.ts` |
| CLIs | `trends:index`, `trends:ingest`, `trends:review` |

Each garment stores structured facets (role, silhouette, fit, length, colors, pattern, fabric, details, aesthetics, occasions, seasons, `pairs_with`) plus a 2 to 4 sentence description. The exact text embedded is saved as `embedding_text`. Filters on `tenant_id`, `role` and `review_status` are part of the vector index.

### Run it

```bash
# .env needs ANTHROPIC_API_KEY and ATLAS_MODEL_API_KEY (see .env.example)
bun run db:init                  # creates trend_looks / trend_garments (idempotent)
bun run trends:index             # Atlas vector index (1024 dims, cosine); wait for READY in Atlas
cp scripts/seeds/trend-manifest.example.json my-looks.json   # list images + license + credit
bun run trends:ingest --file my-looks.json --tenant racksavant-dev --dry-run   # validate only, no API calls
bun run trends:ingest --file my-looks.json --tenant racksavant-dev             # describe + embed + store
bun run trends:review --tenant racksavant-dev                                  # read what the model wrote
bun run trends:review --tenant racksavant-dev --approve <look_id>              # or --reject / --approve-all
```

Ingest is idempotent (deterministic `look_id` from tenant + image). Reruns skip existing looks. `--redescribe` only rewrites looks still `pending_review`. It exits non-zero if any look failed and prints a JSON report (`--report path`). Images must be JPEG, PNG, WebP or GIF, 5 MB or smaller, as a local path or an https URL.

### Using it from agents

```ts
import { searchTrendGarments, trendLooksForIntent } from "./src/trends/search";
const looks = await trendLooksForIntent(db, tenantId, "smart casual dinner");        // base pairs: whole looks + their pieces
const coats = await searchTrendGarments(db, tenantId, "oversized camel coat", { role: "outerwear" });
```

Suggested wiring (not done yet, see roadmap): the stylist calls `trendLooksForIntent` and uses the pairings as templates for each slot, then fills slots from inventory; the scout uses the nearest `description` as the external search query for gap roles. Emit a `tool_call` agent event for each retrieval. When a human approves an outfit, write it back as a trend look with `source.type: "approved_outfit"` so the library learns.

### Gotchas

- **Rights.** `source.license` is required (`owned`, `licensed`, `public_web_demo`). `public_web_demo` images are for demos only. Use owned or licensed images in production.
- **Review gate.** Model output starts `pending_review` and agents never see it until a human approves it. Spot-check descriptions: bad tags poison retrieval.
- **Rate limits.** Voyage is 3 requests/min and 10K tokens/min until a payment method is added in the Atlas billing page. The client backs off on 429, but large batches will be slow until then.
- **Dimensions.** `EMBED_DIMENSIONS` must match the vector index. Changing it means a new index and a re-embed (`--redescribe` only touches pending looks).
- **Vector index is async.** After `trends:index`, queries return nothing until the index is queryable.
- **Not run live:** the Claude vision call. I had no `ANTHROPIC_API_KEY`, so the describe step is covered only by unit tests on the validator and builders. Embeddings and vector search were verified against live Atlas (`RUN_DB_TESTS=1 bun test tests/trends.integration`).

## Safety rules (keep these)

- Sourced candidates stay in `sourced_items` until a human approves `source_intake`. Promotion writes `received` and `listed` inventory events.
- Every outfit is escalated to `outfit_review`; nothing reaches a shopper without human approval.
- `agent_events` is append-only. Never log secrets, connection strings, or API keys in payloads.
- No deletes. Inventory changes go through events.
- Importer and API must stay tenant-isolated.

## Roadmap for the engineer

Highest value first:

1. **Per-user auth.** The API uses one shared bearer token (`API_AUTH_TOKEN`), which is fine for server-to-server but must not ship inside the Android APK. Verify Firebase ID tokens (Android uses Firebase Auth) and map the token to `tenant_id` and shopper identity instead of trusting the URL and `shopper_id`. Stylist-only routes (`/tasks/*/decision`) need a stylist role. Add CORS policy, rate limits and TLS termination.
2. **Real scout.** Replace the stub in `agents.ts` with an LLM/tool-calling agent that finds real external items (url, retailer, price, image) and writes `sourced_items`. Emit `tool_call` / `llm_call` events. Keep the candidate -> human intake -> product contract.
3. **Embeddings and ranking.** Embed products and shopper signals with `voyage-4-large` (`ATLAS_MODEL_API_KEY`), add an Atlas Vector Search index, retrieve then rerank (`/v1/rerank`) in the stylist instead of "newest per role".
4. **Real images.** Replace placeholder URLs with S3 (or Raindrop SmartBuckets) URLs reachable by Android and Gemini.
5. **Deployment.** Dockerfile, CI (typecheck, unit tests, gated integration), deploy target. Sponsor stack: MongoDB Agent Engine (`agentengine create / dev up / deploy`) and LiquidMetal Raindrop (deployed via the Raindrop MCP server: SmartMemory, SmartBuckets, SmartSQL, SmartInference). Vultr and ElevenLabs (voice) are in the hackathon requirements.
6. **Android integration.** Retrofit service + Kotlin models for the contract above, outfit picker UI near `TryOnFragment`, loading/error/empty states.
7. **Stylist console.** UI over the tasks and agent-events endpoints (claim, snooze, approve, reject).
8. **Tests.** Add API-level tests for `/style` and `/decision` including a mixed inventory + sourced outfit and the intake promotion path, which is implemented but not covered by an automated test.

## Credentials hygiene

Atlas database password, Atlas Admin API private key, and the Atlas Model API key were shared in chat during setup. **Rotate all of them** before any shared deployment, and create a dedicated least-privilege DB user. Never commit `.env` (it is gitignored).

Atlas details: project `6acbd0e624b62b00670ebc42`, cluster `Cluster0`, database `needitnow`. The Admin API key's own access list is separate from database Network Access.
