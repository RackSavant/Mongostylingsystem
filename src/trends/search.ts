/**
 * Agent-facing retrieval over the trend library.
 * Only `approved` garments are ever returned to agents.
 *
 *   searchTrendGarments(db, tenantId, "oversized camel coat for fall", { role: "outerwear" })
 *   trendLooksForIntent(db, tenantId, "smart casual dinner")   // whole looks = base pairs
 */
import type { Db } from "mongodb";
import { TREND_COLLECTIONS, TREND_VECTOR_INDEX } from "../data/schema";
import { embedTexts } from "./clients";

export interface TrendHit {
  garment_id: string; look_id: string; role: string; name: string; description: string;
  colors: string[]; score: number;
}

export async function searchTrendGarments(
  db: Db, tenantId: string, query: string,
  opts: { role?: string; limit?: number } = {},
): Promise<TrendHit[]> {
  const [vector] = await embedTexts([query], "query");
  const filter: Record<string, unknown> = { tenant_id: tenantId, review_status: "approved" };
  if (opts.role) filter.role = opts.role;
  const limit = Math.min(opts.limit ?? 5, 25);
  return db.collection(TREND_COLLECTIONS.garments).aggregate<TrendHit>([
    { $vectorSearch: { index: TREND_VECTOR_INDEX, path: "embedding", queryVector: vector, numCandidates: limit * 20, limit, filter } },
    { $project: { _id: 0, garment_id: 1, look_id: 1, role: 1, name: 1, description: 1, colors: 1, score: { $meta: "vectorSearchScore" } } },
  ]).toArray();
}

/** Whole looks (with their garments = base pairs) nearest to an intent. */
export async function trendLooksForIntent(db: Db, tenantId: string, intent: string, limit = 3) {
  const hits = await searchTrendGarments(db, tenantId, intent, { limit: limit * 4 });
  const lookIds = [...new Set(hits.map((h) => h.look_id))].slice(0, limit);
  const looks = await db.collection(TREND_COLLECTIONS.looks)
    .find({ tenant_id: tenantId, look_id: { $in: lookIds }, review_status: "approved" }, { projection: { embedding: 0 } }).toArray();
  const garments = await db.collection(TREND_COLLECTIONS.garments)
    .find({ tenant_id: tenantId, look_id: { $in: lookIds }, review_status: "approved" }, { projection: { embedding: 0 } }).toArray();
  return lookIds.map((id) => ({ look: looks.find((l) => l.look_id === id), garments: garments.filter((g) => g.look_id === id) })).filter((x) => x.look);
}
