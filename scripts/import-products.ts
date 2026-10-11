/**
 * bun run db:import — versioned, idempotent product importer.
 *
 *   --file <path>    seed JSON (array of product payloads)   [default: scripts/seeds/products.synthetic.v1.json]
 *   --tenant <id>    tenant_id applied to rows lacking one   [default: racksavant-dev]
 *   --dry-run        validate + plan only, write nothing
 *   --update         allow refreshing mutable fields on existing products
 *                    (identity fields and provenance are never overwritten)
 *   --report <path>  also write the JSON import report to disk
 *
 * Safe to rerun: products dedupe on (tenant_id, product_id) — deterministic
 * prod_<sha256> ids — and (tenant_id, source.system, source.external_id).
 * Existing records are SKIPPED by default; they are never deleted.
 *
 * New inserts also emit inventory_events (received + listed) and upsert
 * inventory_state, so one-off resale/consignment stock lands correctly.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { getDb, closeMongo } from "../src/data/mongo";
import { COLLECTIONS } from "../src/data/schema";
import {
  validateProductPayload, toProductDoc, planImport,
  type ProductPayload, type ProductDoc,
} from "../src/data/import-core";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const opt = (name: string, dflt: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};

const FILE = opt("file", "scripts/seeds/products.synthetic.v1.json");
const TENANT = opt("tenant", "racksavant-dev");
const DRY_RUN = flag("dry-run");
const UPDATE = flag("update");
const REPORT_PATH = opt("report", "");

interface Report {
  file: string; tenant: string; dryRun: boolean; update: boolean;
  totals: { received: number; valid: number; rejected: number; inserted: number; skipped: number; updated: number };
  rejections: { index: number; title: unknown; errors: string[] }[];
  product_ids: string[];
}

const report: Report = {
  file: FILE, tenant: TENANT, dryRun: DRY_RUN, update: UPDATE,
  totals: { received: 0, valid: 0, rejected: 0, inserted: 0, skipped: 0, updated: 0 },
  rejections: [], product_ids: [],
};

const payloads: ProductPayload[] = JSON.parse(readFileSync(FILE, "utf8"));
if (!Array.isArray(payloads)) throw new Error(`${FILE} must contain a JSON array`);
report.totals.received = payloads.length;

const db = await getDb();
const products = db.collection(COLLECTIONS.products);
const events = db.collection(COLLECTIONS.inventoryEvents);
const state = db.collection(COLLECTIONS.inventoryState);
const now = new Date();

for (const [index, raw] of payloads.entries()) {
  const p: ProductPayload = { tenant_id: TENANT, status: "active", ...raw };

  const v = validateProductPayload(p);
  if (!v.ok) {
    report.totals.rejected++;
    report.rejections.push({ index, title: raw.title, errors: v.errors });
    continue;
  }
  report.totals.valid++;

  const doc = toProductDoc(p as ProductPayload & { tenant_id: string }, now);
  const qty = Number.isInteger(p.quantity) ? (p.quantity as number) : 1;

  // dedupe on product_id OR the source (system, external_id) pair
  const existing = await products.findOne({
    tenant_id: doc.tenant_id,
    $or: [
      { product_id: doc.product_id },
      ...(doc.source.external_id
        ? [{ "source.system": doc.source.system, "source.external_id": doc.source.external_id }]
        : []),
    ],
  });

  const plan = planImport(existing, doc, { update: UPDATE });
  report.product_ids.push(doc.product_id);

  if (plan.op === "insert") {
    if (!DRY_RUN) {
      const { created_at, ...insertDoc } = doc; // created_at immutable
      await products.insertOne({ ...insertDoc, created_at: now } as any);

      // inventory intake: received (qty in) + listed, then state rollup
      const mkEvent = (type: string, delta: number) => ({
        tenant_id: doc.tenant_id, event_id: `evt_${randomUUID()}`,
        product_id: doc.product_id, type, qty_delta: delta,
        actor: "system:import-products", occurred_at: now,
      });
      await events.insertMany([mkEvent("received", qty), mkEvent("listed", 0)] as any[]);
      await state.updateOne(
        { tenant_id: doc.tenant_id, product_id: doc.product_id },
        {
          $set: {
            tenant_id: doc.tenant_id, product_id: doc.product_id,
            on_hand: qty, reserved: 0,
            status: qty > 0 ? "in_stock" : "out",
            updated_at: now,
          },
        },
        { upsert: true },
      );
    }
    report.totals.inserted++;
  } else if (plan.op === "update") {
    if (!DRY_RUN) {
      await products.updateOne(
        { tenant_id: doc.tenant_id, product_id: plan.product_id },
        { $set: plan.set },
      );
    }
    report.totals.updated++;
  } else {
    report.totals.skipped++;
  }
}

if (REPORT_PATH) writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
await closeMongo();
