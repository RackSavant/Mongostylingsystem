/**
 * Workforce agents: scout, stylist, intake.
 * Deterministic heuristics now — the LLM/tool-calling brains plug into the
 * same run/escalate contract later (Raindrop orchestration, Agent Engine).
 */
import { randomUUID } from "node:crypto";
import type { Db } from "mongodb";
import { COLLECTIONS, SCHEMA_VERSION } from "../data/schema";
import { AgentRun } from "./runner";

export const OUTFIT_ROLES = ["tops", "bottoms", "shoes", "outerwear", "accessories"] as const;

/* ------------------------------------------------------------------ */
/* scout — measures inventory coverage for an intent, sources gaps     */
/* ------------------------------------------------------------------ */

export interface ScoutResult {
  coveredRoles: string[];
  gapRoles: string[];
  sourcedIds: string[];
}

/**
 * For each outfit role, scout checks whether active inventory has candidates.
 * Gap roles get `sourced_items` stubs (status=candidate) flagged for the
 * sourcing pipeline — in production an LLM/web tool fills real listings;
 * the contract (candidate → human intake → product) stays identical.
 */
export async function scout(opts: { db: Db; tenantId: string; shopperId: string; intent: string; dryRun?: boolean }): Promise<ScoutResult> {
  const run = await AgentRun.start({ db: opts.db, tenantId: opts.tenantId, agent: "scout", dryRun: opts.dryRun });
  const products = opts.db.collection(COLLECTIONS.products);
  const sourced = opts.db.collection(COLLECTIONS.sourcedItems);

  const active = await products.find({ tenant_id: opts.tenantId, status: "active" }).toArray();
  const coveredRoles = [...new Set(active.map((p) => p.category as string))];
  const gapRoles = OUTFIT_ROLES.filter((r) => !coveredRoles.includes(r));

  await run.emit("decision", "info", `coverage: ${coveredRoles.length}/${OUTFIT_ROLES.length} roles`, { coveredRoles, gapRoles });

  const sourcedIds: string[] = [];
  for (const role of gapRoles) {
    const source_id = `src_${randomUUID().slice(0, 12)}`;
    sourcedIds.push(source_id);
    if (!opts.dryRun) {
      await sourced.insertOne({
        tenant_id: opts.tenantId,
        source_id,
        title: `[sourcing needed] ${role} for: ${opts.intent}`,
        url: "https://pending.example/sourcing",
        status: "candidate",
        found_by: { agent: "scout", run_id: run.runId },
        category: role,
        rationale: `Inventory has no active ${role}; scout opened a sourcing slot for shopper ${opts.shopperId}`,
        created_at: new Date(),
        updated_at: new Date(),
      } as any);
    }
  }

  if (sourcedIds.length > 0) {
    await run.escalate("source_intake", 4, { shopper_id: opts.shopperId, source_ids: sourcedIds, gap_roles: gapRoles }, "Review sourced candidates before they enter inventory");
  }

  await run.end(`scout done: ${coveredRoles.length} covered, ${sourcedIds.length} gap slots`, { coveredRoles, gapRoles });
  return { coveredRoles, gapRoles, sourcedIds };
}

/* ------------------------------------------------------------------ */
/* stylist — composes outfit from inventory ∪ sourced candidates       */
/* ------------------------------------------------------------------ */

export interface OutfitItem {
  role: string;
  kind: "inventory" | "sourced";
  product_id?: string;
  source_id?: string;
  rationale?: string;
}

/**
 * Composes a draft outfit: best active product per covered role + sourced
 * candidates for gaps. Then ALWAYS escalates outfit_review — a human stylist
 * approves before anything reaches the shopper.
 */
export async function stylist(opts: { db: Db; tenantId: string; shopperId: string; intent: string; dryRun?: boolean }): Promise<{ outfitId: string; taskId: string; items: OutfitItem[] }> {
  const run = await AgentRun.start({ db: opts.db, tenantId: opts.tenantId, agent: "stylist", dryRun: opts.dryRun });
  const products = opts.db.collection(COLLECTIONS.products);
  const sourced = opts.db.collection(COLLECTIONS.sourcedItems);
  const outfits = opts.db.collection(COLLECTIONS.outfits);

  const items: OutfitItem[] = [];
  for (const role of OUTFIT_ROLES) {
    // best active inventory item for the role (newest condition first is a v0 heuristic)
    const inv = await products
      .find({ tenant_id: opts.tenantId, status: "active", category: role })
      .sort({ created_at: -1 })
      .limit(1)
      .toArray();
    if (inv[0]) {
      items.push({ role, kind: "inventory", product_id: inv[0].product_id, rationale: `in-stock ${role}` });
      continue;
    }
    const cand = await sourced
      .find({ tenant_id: opts.tenantId, status: "candidate", category: role })
      .sort({ created_at: -1 })
      .limit(1)
      .toArray();
    if (cand[0]) {
      items.push({ role, kind: "sourced", source_id: cand[0].source_id, rationale: `sourced candidate for missing ${role}` });
    }
  }

  const outfitId = `of_${randomUUID()}`;
  await run.emit("decision", "info", `composed outfit with ${items.length} items`, { items });
  if (!opts.dryRun) {
    await outfits.insertOne({
      tenant_id: opts.tenantId,
      outfit_id: outfitId,
      shopper_id: opts.shopperId,
      items,
      status: "pending_review",
      agent_run_id: run.runId,
      created_at: new Date(),
      updated_at: new Date(),
    } as any);
  }

  const taskId = await run.escalate("outfit_review", 5, { outfit_id: outfitId, shopper_id: opts.shopperId, item_count: items.length }, "Human stylist reviews composed outfit before delivery");
  await run.end(`outfit ${outfitId} pending review`, { outfitId, taskId });
  return { outfitId, taskId, items };
}

/* ------------------------------------------------------------------ */
/* intake — promotes an approved sourced_item into products            */
/* ------------------------------------------------------------------ */

export async function intake(opts: { db: Db; tenantId: string; sourceId: string; decidedBy: string; dryRun?: boolean }): Promise<{ productId: string }> {
  const run = await AgentRun.start({ db: opts.db, tenantId: opts.tenantId, agent: "intake", dryRun: opts.dryRun });
  const sourced = opts.db.collection(COLLECTIONS.sourcedItems);
  const products = opts.db.collection(COLLECTIONS.products);
  const events = opts.db.collection(COLLECTIONS.inventoryEvents);
  const state = opts.db.collection(COLLECTIONS.inventoryState);

  const item = await sourced.findOne({ tenant_id: opts.tenantId, source_id: opts.sourceId });
  if (!item) throw new Error(`sourced_item ${opts.sourceId} not found`);
  if (item.matched_product_id) return { productId: item.matched_product_id }; // idempotent

  const productId = `prod_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
  const now = new Date();
  await run.emit("decision", "info", `promoting ${opts.sourceId} -> ${productId}`);

  if (!opts.dryRun) {
    await products.insertOne({
      tenant_id: opts.tenantId,
      product_id: productId,
      title: item.title,
      brand: item.brand ?? null,
      category: item.category ?? "uncategorized",
      price_cents: item.price_cents ?? 0,
      currency: item.currency ?? "USD",
      condition: "new",
      images: item.image_url ? [{ url: item.image_url }] : [],
      status: "active",
      source: { type: "sourced", system: "agent:scout", external_id: item.source_id, imported_at: now },
      schema_version: SCHEMA_VERSION,
      created_at: now,
      updated_at: now,
    } as any);
    await events.insertMany([
      { tenant_id: opts.tenantId, event_id: `evt_${randomUUID()}`, product_id: productId, type: "received", qty_delta: 1, actor: `agent:intake`, occurred_at: now },
      { tenant_id: opts.tenantId, event_id: `evt_${randomUUID()}`, product_id: productId, type: "listed", qty_delta: 0, actor: `agent:intake`, occurred_at: now },
    ] as any[]);
    await state.updateOne(
      { tenant_id: opts.tenantId, product_id: productId },
      { $set: { tenant_id: opts.tenantId, product_id: productId, on_hand: 1, reserved: 0, status: "in_stock", updated_at: now } },
      { upsert: true },
    );
    await sourced.updateOne(
      { tenant_id: opts.tenantId, source_id: opts.sourceId },
      { $set: { status: "intake", matched_product_id: productId, updated_at: now } },
    );
  }

  await run.end(`intake ${opts.sourceId} -> ${productId}`);
  return { productId };
}
