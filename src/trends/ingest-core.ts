/** Pure builders: description + embeddings -> trend_looks / trend_garments documents. */
import { SCHEMA_VERSION } from "../data/schema";
import {
  garmentEmbeddingText, garmentIdFor, lookEmbeddingText, lookIdFor,
  type LookDescription, type ManifestEntry,
} from "./vocab";

const prune = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

export function planLook(tenantId: string, entry: ManifestEntry) {
  return { look_id: entry.look_id ?? lookIdFor(tenantId, entry.image) };
}

export function embeddingInputs(d: LookDescription): string[] {
  return [lookEmbeddingText(d), ...d.garments.map((g) => garmentEmbeddingText(g, d.aesthetics))];
}

export function buildDocs(opts: {
  tenantId: string; entry: ManifestEntry; description: LookDescription; embeddings: number[][];
  imageSha256: string; model: { vision: string; embedding: string; dimensions: number; vocab_version: number }; now: Date;
}) {
  const { tenantId, entry, description: d, embeddings, now } = opts;
  if (embeddings.length !== d.garments.length + 1) throw new Error("embedding count mismatch");
  const { look_id } = planLook(tenantId, entry);
  const garmentDocs = d.garments.map((g, i) => ({
    tenant_id: tenantId,
    garment_id: garmentIdFor(look_id, i, g.role),
    look_id,
    ...prune(g),
    embedding_text: garmentEmbeddingText(g, d.aesthetics),
    embedding: embeddings[i + 1],
    review_status: "pending_review" as const,
    schema_version: SCHEMA_VERSION,
    created_at: now,
    updated_at: now,
  }));
  const lookDoc = prune({
    tenant_id: tenantId,
    look_id,
    image: { ref: entry.image, sha256: opts.imageSha256 },
    source: prune({ type: entry.source.type ?? "manual", url: entry.source.url, credit: entry.source.credit, license: entry.source.license }),
    season: entry.season,
    notes: entry.notes,
    summary: d.summary,
    aesthetics: d.aesthetics,
    occasions: d.occasions,
    seasons: d.seasons,
    garment_ids: garmentDocs.map((g) => g.garment_id),
    review_status: "pending_review" as const,
    embedding: embeddings[0],
    model: opts.model,
    schema_version: SCHEMA_VERSION,
    created_at: now,
    updated_at: now,
  });
  return { lookDoc, garmentDocs };
}
