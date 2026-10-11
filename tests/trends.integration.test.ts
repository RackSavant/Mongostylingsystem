/**
 * Live check of the trend library: real Voyage embeddings + Atlas Vector Search.
 * Gated: RUN_DB_TESTS=1 and ATLAS_MODEL_API_KEY set, and `bun run trends:index` already run
 * against MONGODB_DB. Uses a throwaway tenant and removes only its own documents.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { getDb, closeMongo } from "../src/data/mongo";
import { TREND_COLLECTIONS, TREND_VECTOR_INDEX } from "../src/data/schema";
import { embedTexts } from "../src/trends/clients";
import { buildDocs, embeddingInputs } from "../src/trends/ingest-core";
import { validateLookDescription } from "../src/trends/vocab";
import { searchTrendGarments, trendLooksForIntent } from "../src/trends/search";

const enabled = process.env.RUN_DB_TESTS === "1" && !!process.env.ATLAS_MODEL_API_KEY;
const T = `trend-selftest-${Date.now()}`;
const mk = (g: any) => ({ silhouette: "straight", fit: "relaxed", pattern: "solid", details: [], aesthetics: ["quiet luxury"], occasions: ["dinner"], seasons: ["fall"], ...g });

afterAll(async () => {
  if (!enabled) return;
  const db = await getDb();
  await db.collection(TREND_COLLECTIONS.garments).deleteMany({ tenant_id: T });
  await db.collection(TREND_COLLECTIONS.looks).deleteMany({ tenant_id: T });
  await closeMongo();
});

describe.skipIf(!enabled)("trend retrieval (live Atlas + Voyage)", () => {
  test("ingest docs -> vector search returns approved garments only, filtered by role", async () => {
    const db = await getDb();
    const d = validateLookDescription({
      summary: "Warm neutral quiet-luxury layering for a fall dinner.", aesthetics: ["quiet luxury"], occasions: ["dinner"], seasons: ["fall"],
      garments: [
        mk({ role: "outerwear", name: "Camel wool coat", colors: ["camel"], fabric: "wool", description: "Long single-breasted camel wool overcoat with notch lapels and dropped shoulders." }),
        mk({ role: "shoes", name: "White leather sneakers", colors: ["white"], fabric: "leather", description: "Minimal low-top white leather sneakers with a flat rubber sole and clean stitching." }),
      ],
    });
    if (!d.ok) throw new Error(d.errors.join());
    const embeddings = await embedTexts(embeddingInputs(d.value), "document");
    const { lookDoc, garmentDocs } = buildDocs({
      tenantId: T, entry: { image: "selftest.jpg", source: { license: "owned", credit: "selftest" } },
      description: d.value, embeddings, imageSha256: "x", now: new Date(),
      model: { vision: "none", embedding: "voyage-4-large", dimensions: 1024, vocab_version: 1 },
    });

    await db.collection(TREND_COLLECTIONS.looks).insertOne(lookDoc as any);
    await db.collection(TREND_COLLECTIONS.garments).insertMany(garmentDocs as any[]);

    const col = db.collection(TREND_COLLECTIONS.garments);
    for (let i = 0; i < 30; i++) {
      const ix: any = (await col.listSearchIndexes().toArray()).find((x: any) => x.name === TREND_VECTOR_INDEX);
      if (ix?.queryable) break;
      await Bun.sleep(5000);
    }
    await Bun.sleep(8000);

    // pending_review is invisible to agents
    expect(await searchTrendGarments(db, T, "tan long winter overcoat")).toHaveLength(0);

    await db.collection(TREND_COLLECTIONS.looks).updateOne({ tenant_id: T }, { $set: { review_status: "approved" } });
    await col.updateMany({ tenant_id: T }, { $set: { review_status: "approved" } });
    await Bun.sleep(8000);

    const hits = await searchTrendGarments(db, T, "tan long winter overcoat", { limit: 2 });
    expect(hits[0]?.name).toBe("Camel wool coat");
    const shoes = await searchTrendGarments(db, T, "tan long winter overcoat", { role: "shoes", limit: 2 });
    expect(shoes.every((h) => h.role === "shoes")).toBe(true);
    const looks = await trendLooksForIntent(db, T, "fall dinner outfit");
    expect(looks[0]?.garments).toHaveLength(2);
  }, 120_000);
});
