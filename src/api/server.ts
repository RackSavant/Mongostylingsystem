/**
 * RackSavant styling-workforce API — what racksavant-android talks to.
 *
 *   GET  /health
 *   GET  /v1/tenants/:t/products?status=&category=
 *   POST /v1/tenants/:t/listings            { AndroidListing }  -> import into inventory
 *   POST /v1/tenants/:t/style               { shopper_id, intent } -> scout+stylist, outfit pending_review
 *   GET  /v1/tenants/:t/outfits/:id         -> outfit + resolved try-on items
 *   GET  /v1/tenants/:t/tasks?status=open   -> HITL queue (stylist console)
 *   POST /v1/tenants/:t/tasks/:id/decision  { decision, decided_by, notes? }
 *   GET  /v1/tenants/:t/agent-events?run_id= -> observability feed
 *
 * Env: MONGODB_URI, MONGODB_DB, PORT (default 8080)
 */
import type { Db } from "mongodb";
import { getDb, closeMongo } from "../data/mongo";
import { COLLECTIONS } from "../data/schema";
import { validateProductPayload, toProductDoc } from "../data/import-core";
import { scout, stylist } from "../workforce/agents";
import { decideTask } from "../workforce/decisions";
import { listingToPayload, outfitToTryOnItems, type AndroidListing } from "./mapper";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const err = (msg: string, status = 400) => json({ error: msg }, status);

export function createHandler(db: Db) {
  return async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const m = url.pathname.match(/^\/v1\/tenants\/([^/]+)(\/.*)?$/);
    const tenantId = m?.[1];
    const rest = m?.[2] ?? "";

    try {
      if (req.method === "GET" && url.pathname === "/health") return json({ ok: true, db: db.databaseName });
      if (!tenantId) return err("not found", 404);

      // inventory browse
      if (req.method === "GET" && rest === "/products") {
        const q: any = { tenant_id: tenantId };
        if (url.searchParams.get("status")) q.status = url.searchParams.get("status");
        if (url.searchParams.get("category")) q.category = url.searchParams.get("category");
        const items = await db.collection(COLLECTIONS.products).find(q).sort({ created_at: -1 }).limit(200).toArray();
        return json({ items, count: items.length });
      }

      // app listing -> inventory product (idempotent via source external_id)
      if (req.method === "POST" && rest === "/listings") {
        const listing = (await req.json()) as AndroidListing;
        if (!listing?.listingId || !listing.title) return err("listing.listingId and listing.title required");
        const payload = listingToPayload(listing, tenantId);
        const v = validateProductPayload(payload);
        if (!v.ok) return err(`invalid listing: ${v.errors.join("; ")}`, 422);
        const doc = toProductDoc(payload as any, new Date());
        const res = await db.collection(COLLECTIONS.products).updateOne(
          { tenant_id: tenantId, product_id: doc.product_id },
          { $setOnInsert: doc },
          { upsert: true },
        );
        return json({ product_id: doc.product_id, created: !!res.upsertedCount }, res.upsertedCount ? 201 : 200);
      }

      // run the workforce: scout -> stylist -> outfit pending human review
      if (req.method === "POST" && rest === "/style") {
        const body = (await req.json()) as { shopper_id?: string; intent?: string };
        if (!body.shopper_id || !body.intent) return err("shopper_id and intent required");
        const coverage = await scout({ db, tenantId, shopperId: body.shopper_id, intent: body.intent });
        const result = await stylist({ db, tenantId, shopperId: body.shopper_id, intent: body.intent });
        return json({ ...result, coverage, status: "pending_review" }, 201);
      }

      // outfit detail + try-on payload
      const outfitMatch = rest.match(/^\/outfits\/([^/]+)$/);
      if (req.method === "GET" && outfitMatch) {
        const outfit = await db.collection(COLLECTIONS.outfits).findOne({ tenant_id: tenantId, outfit_id: outfitMatch[1] });
        if (!outfit) return err("outfit not found", 404);
        const pIds = (outfit.items as any[]).filter((i) => i.kind === "inventory").map((i) => i.product_id);
        const sIds = (outfit.items as any[]).filter((i) => i.kind === "sourced").map((i) => i.source_id);
        const products = await db.collection(COLLECTIONS.products).find({ tenant_id: tenantId, product_id: { $in: pIds } }).toArray();
        const sourced = await db.collection(COLLECTIONS.sourcedItems).find({ tenant_id: tenantId, source_id: { $in: sIds } }).toArray();
        const tryonItems = outfitToTryOnItems(
          outfit.items as any[],
          new Map(products.map((p) => [p.product_id, p])),
          new Map(sourced.map((s) => [s.source_id, s])),
        );
        return json({ ...outfit, tryon_items: tryonItems });
      }

      // HITL queue
      if (req.method === "GET" && rest === "/tasks") {
        const q: any = { tenant_id: tenantId };
        q.status = url.searchParams.get("status") ?? "open";
        const tasks = await db.collection(COLLECTIONS.tasks).find(q).sort({ priority: -1, created_at: 1 }).limit(100).toArray();
        return json({ tasks, count: tasks.length });
      }

      // human decision
      const taskMatch = rest.match(/^\/tasks\/([^/]+)\/decision$/);
      if (req.method === "POST" && taskMatch) {
        const body = (await req.json()) as { decision?: string; decided_by?: string; notes?: string };
        if (!body.decision || !body.decided_by) return err("decision and decided_by required");
        if (!["approved", "rejected", "done"].includes(body.decision)) return err("decision must be approved|rejected|done");
        const result = await decideTask({
          db, tenantId, taskId: taskMatch[1],
          decision: body.decision as any, decidedBy: body.decided_by, notes: body.notes,
        });
        return json(result);
      }

      // observability feed
      if (req.method === "GET" && rest === "/agent-events") {
        const q: any = { tenant_id: tenantId };
        if (url.searchParams.get("run_id")) q.run_id = url.searchParams.get("run_id");
        if (url.searchParams.get("agent")) q.agent = url.searchParams.get("agent");
        const events = await db.collection(COLLECTIONS.agentEvents).find(q).sort({ occurred_at: -1 }).limit(200).toArray();
        return json({ events, count: events.length });
      }

      return err("not found", 404);
    } catch (e) {
      return err(e instanceof Error ? e.message : "internal error", 500);
    }
  };
}

if (import.meta.main) {
  const db = await getDb();
  const port = Number(process.env.PORT ?? 8080);
  Bun.serve({ port, fetch: createHandler(db) });
  console.log(`racksavant styling API on :${port} (db: ${db.databaseName})`);
}
