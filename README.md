# Mongostylingsystem

RackSavant's inventory + styling-workforce data layer on **MongoDB Atlas**.

Agents source best-fit items → outfits are composed from **our inventory ∪ sourced candidates** → decisions bubble up to a **human-in-the-loop task queue** → approved sourced items are promoted into inventory, so the catalog builds itself.

## Collections

| Collection | Purpose |
|---|---|
| `products` | Canonical sellable catalog — stable `product_id`, `tenant_id`, SKU, title, brand, category, `price_cents`+`currency`, condition, size/color/material, image refs, `source` provenance |
| `inventory_events` | Append-only ledger (received/listed/reserved/released/sold/returned/adjusted/archived) — supports one-off resale & consignment |
| `inventory_state` | Per-product rollup (on_hand/reserved/status), rebuildable from events |
| `sourced_items` | Agent-found external candidates (`source_id`, url, retailer, `found_by` run); promoted to `products` only via human intake |
| `outfits` | Composed looks mixing `product_id` and `source_id` refs per role (top/bottom/shoes/…) |
| `tasks` | HITL queue — open/claimed/decided, priority-ordered, payload refs only |
| `agent_events` | Per-run observability ledger (run_start/tool_call/llm_call/decision/escalate/run_end/error) |

All validators are strict `$jsonSchema`; every collection is tenant-scoped and indexed (`src/data/schema.ts` is the single source of truth — bump `SCHEMA_VERSION` on shape changes).

## Env vars

See `.env.example`. Required: `MONGODB_URI`, `MONGODB_DB`. Optional: `MONGODB_TEST_DB` (integration tests), `RUN_DB_TESTS=1`.

> Use a least-privilege Atlas user (readWrite on the app DB only) in shared/prod environments.

## Run locally

```bash
bun install
cp .env.example .env        # fill in MONGODB_URI
bun run db:init             # create collections + validators + indexes (idempotent)
bun run db:import --dry-run # validate + plan, write nothing — prints import report
bun run db:import           # seed synthetic catalog (safe to rerun: dupes skip)
bun run db:import --update  # refresh mutable fields on existing rows
bun test                    # unit tests
RUN_DB_TESTS=1 bun test     # + live Atlas integration (uses MONGODB_TEST_DB)
```

## Deployment environment

The importer and init script are plain Bun/TS with no build step — run them wherever `MONGODB_URI` is set (container, CI job, or Agent Engine task):

```bash
MONGODB_URI=... bun run scripts/init-db.ts
MONGODB_URI=... bun run scripts/import-products.ts --file <catalog.json> --tenant <tenant>
```

Import files are JSON arrays of product payloads (see `scripts/seeds/products.synthetic.v1.json` for the shape). Every run prints a JSON report: received / valid / rejected / inserted / skipped / updated (+ `--report <path>` to persist it).

**Safety rules baked in:** products dedupe on `(tenant_id, product_id)` and `(tenant_id, source.system, source.external_id)`; existing rows are skipped unless `--update`; nothing is ever deleted; identity and provenance fields are never overwritten.

Synthetic seed data only until the real catalog import is reviewed.
