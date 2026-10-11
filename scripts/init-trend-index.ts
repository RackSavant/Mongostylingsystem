/**
 * bun run trends:index — create the Atlas Vector Search index for trend_garments.
 * Idempotent. Dimensions come from EMBED_DIMENSIONS (default 1024) and must match ingest.
 * Atlas builds the index asynchronously; queries work once it reports READY.
 */
import { getDb, closeMongo } from "../src/data/mongo";
import { TREND_COLLECTIONS, TREND_VECTOR_INDEX } from "../src/data/schema";
import { EMBED_DIMENSIONS } from "../src/trends/clients";

const db = await getDb();
const col = db.collection(TREND_COLLECTIONS.garments);
const existing = await col.listSearchIndexes().toArray();
if (existing.some((i) => i.name === TREND_VECTOR_INDEX)) {
  console.log(`= ${TREND_VECTOR_INDEX} already exists (status: ${(existing.find((i) => i.name === TREND_VECTOR_INDEX) as any)?.status})`);
} else {
  await col.createSearchIndex({
    name: TREND_VECTOR_INDEX,
    type: "vectorSearch",
    definition: {
      fields: [
        { type: "vector", path: "embedding", numDimensions: EMBED_DIMENSIONS(), similarity: "cosine" },
        { type: "filter", path: "tenant_id" },
        { type: "filter", path: "role" },
        { type: "filter", path: "review_status" },
      ],
    },
  });
  console.log(`+ ${TREND_VECTOR_INDEX} created (${EMBED_DIMENSIONS()} dims, cosine) — building asynchronously`);
}
await closeMongo();
