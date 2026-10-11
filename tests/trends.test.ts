import { describe, expect, test } from "bun:test";
import { validateLookDescription, validateManifestEntry, lookIdFor, garmentEmbeddingText } from "../src/trends/vocab";
import { buildDocs, embeddingInputs } from "../src/trends/ingest-core";

const good = {
  summary: "Relaxed quiet-luxury layering in warm neutrals with a tailored camel coat.",
  aesthetics: ["Quiet Luxury", "quiet luxury"],
  occasions: ["smart casual dinner"],
  seasons: ["fall", "bogus"],
  garments: [
    { role: "outerwear", name: "Camel wool coat", silhouette: "straight", fit: "oversized", colors: ["camel"], pattern: "solid", fabric: "wool", details: ["notch lapel"], aesthetics: ["quiet luxury"], occasions: [], seasons: ["fall"], description: "Long single-breasted camel wool coat with notch lapels and dropped shoulders.", pairs_with: "ivory knit and wide trousers" },
    { role: "tops", name: "Ivory knit", silhouette: "boxy", fit: "relaxed", colors: ["ivory"], pattern: "solid", fabric: "merino", details: [], aesthetics: [], occasions: [], seasons: [], description: "Fine-gauge ivory merino crewneck knit with a slightly cropped boxy body." },
  ],
};

describe("trend vocab validation", () => {
  test("accepts and normalizes a good description", () => {
    const r = validateLookDescription(good);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.aesthetics).toEqual(["quiet luxury"]);
      expect(r.value.seasons).toEqual(["fall"]);
      expect(r.value.garments).toHaveLength(2);
    }
  });
  test("rejects bad role, short description, missing colors", () => {
    const bad = { ...good, garments: [{ ...good.garments[0], role: "hats", description: "short", colors: [] }] };
    const r = validateLookDescription(bad);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.length).toBeGreaterThanOrEqual(3);
  });
  test("rejects empty garments and non-objects", () => {
    expect(validateLookDescription({ summary: "x".repeat(30), garments: [] }).ok).toBe(false);
    expect(validateLookDescription(null).ok).toBe(false);
  });
});

describe("manifest + ids", () => {
  test("requires license and provenance", () => {
    expect(validateManifestEntry({ image: "a.jpg", source: { license: "owned", credit: "us" } }, 0)).toEqual([]);
    expect(validateManifestEntry({ image: "a.jpg", source: { license: "nope" } }, 0).length).toBe(2);
    expect(validateManifestEntry({ source: { license: "owned", credit: "x" } }, 0).length).toBe(1);
  });
  test("look ids are deterministic and tenant-scoped", () => {
    expect(lookIdFor("t1", "a.jpg")).toBe(lookIdFor("t1", "a.jpg"));
    expect(lookIdFor("t1", "a.jpg")).not.toBe(lookIdFor("t2", "a.jpg"));
  });
});

describe("doc building", () => {
  test("builds linked docs, all pending_review, with embedding text", () => {
    const r = validateLookDescription(good);
    if (!r.ok) throw new Error("fixture invalid");
    const inputs = embeddingInputs(r.value);
    expect(inputs).toHaveLength(3);
    const embeddings = inputs.map(() => [0.1, 0.2]);
    const { lookDoc, garmentDocs } = buildDocs({
      tenantId: "t1", entry: { image: "a.jpg", source: { license: "owned", credit: "us" } },
      description: r.value, embeddings, imageSha256: "abc", now: new Date(0),
      model: { vision: "m", embedding: "e", dimensions: 2, vocab_version: 1 },
    });
    expect(lookDoc.review_status).toBe("pending_review");
    expect(lookDoc.garment_ids).toEqual(garmentDocs.map((g) => g.garment_id));
    expect(garmentDocs.every((g) => g.look_id === lookDoc.look_id && g.review_status === "pending_review")).toBe(true);
    expect(garmentDocs[0].embedding_text).toContain("camel");
    expect(garmentEmbeddingText(r.value.garments[0])).toContain("Pairs with");
  });
  test("embedding count mismatch throws", () => {
    const r = validateLookDescription(good);
    if (!r.ok) throw new Error("fixture invalid");
    expect(() => buildDocs({ tenantId: "t", entry: { image: "a", source: { license: "owned", credit: "x" } }, description: r.value, embeddings: [[1]], imageSha256: "x", now: new Date(), model: { vision: "", embedding: "", dimensions: 1, vocab_version: 1 } })).toThrow();
  });
});
