/**
 * bun run trends:ingest --file <manifest.json> --tenant <id> [--dry-run] [--redescribe] [--limit N] [--report path]
 *
 * For each manifest entry: Claude vision describes the look in the controlled
 * vocabulary -> validate -> embed (Voyage via Atlas) -> upsert trend_looks +
 * trend_garments as `pending_review`. Idempotent: existing looks are skipped
 * unless --redescribe (which only rewrites pending_review looks; approved
 * looks are never overwritten). --dry-run validates the manifest and makes no
 * API or database calls.
 *
 * Manifest: [{ "image": "./looks/a.jpg" | "https://...", "season": "fall",
 *   "source": { "license": "owned|licensed|public_web_demo", "credit": "...", "url": "..." } }]
 */
import { readFile, writeFile } from "node:fs/promises";
import { getDb, closeMongo } from "../src/data/mongo";
import { TREND_COLLECTIONS } from "../src/data/schema";
import { describeImage, embedTexts, EMBED_MODEL, EMBED_DIMENSIONS } from "../src/trends/clients";
import { buildDocs, embeddingInputs, planLook } from "../src/trends/ingest-core";
import { TREND_VOCAB_VERSION, validateLookDescription, validateManifestEntry, type ManifestEntry } from "../src/trends/vocab";

const args = process.argv.slice(2);
const flag = (n: string) => args.includes(`--${n}`);
const opt = (n: string) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };

const file = opt("file"), tenantId = opt("tenant");
if (!file || !tenantId) { console.error("usage: --file <manifest.json> --tenant <id> [--dry-run] [--redescribe] [--limit N] [--report path]"); process.exit(2); }
const DRY = flag("dry-run"), REDO = flag("redescribe");

const manifest = JSON.parse(await readFile(file, "utf8"));
const entries: ManifestEntry[] = (Array.isArray(manifest) ? manifest : manifest.looks ?? []).slice(0, Number(opt("limit") ?? Infinity));
const report = { tenant_id: tenantId, dry_run: DRY, received: entries.length, invalid: [] as string[], inserted: 0, skipped: 0, redescribed: 0, failed: [] as { image: string; error: string }[], look_ids: [] as string[] };

for (const [i, e] of entries.entries()) report.invalid.push(...validateManifestEntry(e, i));
if (report.invalid.length) { console.error(JSON.stringify(report, null, 2)); process.exit(1); }

if (!DRY) {
  const db = await getDb();
  const looks = db.collection(TREND_COLLECTIONS.looks), garments = db.collection(TREND_COLLECTIONS.garments);
  for (const entry of entries) {
    const { look_id } = planLook(tenantId, entry);
    report.look_ids.push(look_id);
    try {
      const existing = await looks.findOne({ tenant_id: tenantId, look_id }, { projection: { review_status: 1 } });
      if (existing && (!REDO || existing.review_status !== "pending_review")) { report.skipped++; continue; }

      const { raw, model, sha256 } = await describeImage(entry.image);
      const v = validateLookDescription(raw);
      if (!v.ok) throw new Error(`description invalid: ${v.errors.join("; ")}`);
      const embeddings = await embedTexts(embeddingInputs(v.value), "document");
      const now = new Date();
      const { lookDoc, garmentDocs } = buildDocs({
        tenantId, entry, description: v.value, embeddings, imageSha256: sha256, now,
        model: { vision: model, embedding: EMBED_MODEL(), dimensions: EMBED_DIMENSIONS(), vocab_version: TREND_VOCAB_VERSION },
      });
      if (existing) {
        await garments.deleteMany({ tenant_id: tenantId, look_id, review_status: "pending_review" });
        const { created_at, ...rest } = lookDoc;
        await looks.updateOne({ tenant_id: tenantId, look_id }, { $set: rest });
        report.redescribed++;
      } else {
        await looks.insertOne(lookDoc as any);
        report.inserted++;
      }
      if (garmentDocs.length) await garments.insertMany(garmentDocs as any[]);
    } catch (err) {
      report.failed.push({ image: entry.image.slice(0, 120), error: err instanceof Error ? err.message : "unknown" });
    }
  }
  await closeMongo();
}

const out = JSON.stringify(report, null, 2);
console.log(out);
const rp = opt("report"); if (rp) await writeFile(rp, out);
process.exit(report.failed.length ? 1 : 0);
