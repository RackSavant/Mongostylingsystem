/**
 * External model clients for the trend library: Claude vision (describe) and
 * Atlas/Voyage embeddings (embed). Plain fetch, no extra dependencies.
 * Keys come from env only and are never logged.
 *
 *   ANTHROPIC_API_KEY   required for describe
 *   ANTHROPIC_MODEL     default "claude-sonnet-4-5" (any vision-capable Claude model)
 *   ATLAS_MODEL_API_KEY required for embed (https://ai.mongodb.com)
 *   EMBED_MODEL         default "voyage-4-large"
 *   EMBED_DIMENSIONS    default 1024 (must match the vector index)
 */
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { TREND_ROLES, SEASONS } from "./vocab";

export const EMBED_MODEL = () => process.env.EMBED_MODEL ?? "voyage-4-large";
export const EMBED_DIMENSIONS = () => Number(process.env.EMBED_DIMENSIONS ?? 1024);

const need = (name: string) => {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set — see .env.example`);
  return v;
};

/** fetch with backoff on 429/5xx (Voyage free tier is 3 RPM / 10K TPM until billing is added). */
async function fetchRetry(url: string, init: RequestInit, tries = 5): Promise<Response> {
  for (let a = 0; ; a++) {
    const res = await fetch(url, init);
    if ((res.status !== 429 && res.status < 500) || a >= tries) return res;
    const wait = Number(res.headers.get("retry-after")) * 1000 || Math.min(25_000 * (a + 1), 60_000);
    await new Promise((r) => setTimeout(r, wait));
  }
}

const MEDIA: Record<string, string> = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".gif": "image/gif" };

export async function loadImage(ref: string): Promise<{ media_type: string; data: string; bytes: Buffer }> {
  let bytes: Buffer, media_type: string | undefined;
  if (/^https:\/\//i.test(ref)) {
    const res = await fetch(ref);
    if (!res.ok) throw new Error(`image fetch failed: ${res.status}`);
    bytes = Buffer.from(await res.arrayBuffer());
    media_type = res.headers.get("content-type")?.split(";")[0] ?? MEDIA[extname(new URL(ref).pathname).toLowerCase()];
  } else {
    bytes = await readFile(ref);
    media_type = MEDIA[extname(ref).toLowerCase()];
  }
  if (!media_type || !Object.values(MEDIA).includes(media_type)) throw new Error(`unsupported image type for ${ref.slice(0, 80)}`);
  if (bytes.length > 5 * 1024 * 1024) throw new Error("image larger than 5 MB; resize before ingest");
  return { media_type, data: bytes.toString("base64"), bytes };
}

export const DESCRIBE_SYSTEM = `You are a fashion cataloguer writing search-ready metadata for a personal-styling engine.
Describe ONLY what is visible. Never guess brands or prices. Be specific and concrete: name silhouettes, fits, lengths, fabrics, colors (use precise names like "oxblood", "bone", "washed indigo"), details (hardware, seams, collars, layering) and how the pieces work together.
Return ONLY a JSON object, no prose, matching exactly:
{
 "summary": "2-3 sentences on the overall look and why it works",
 "aesthetics": ["e.g. quiet luxury","gorpcore","coastal grandmother"],
 "occasions": ["e.g. smart casual dinner"],
 "seasons": [${SEASONS.map((s) => `"${s}"`).join(",")}],
 "garments": [{
   "role": one of ${TREND_ROLES.join("|")},
   "name": "short product-style name",
   "silhouette": "...", "fit": "...", "length": "...",
   "colors": ["primary first"], "pattern": "solid|stripe|plaid|...", "fabric": "best visual guess",
   "details": ["..."], "aesthetics": ["..."], "occasions": ["..."], "seasons": [...],
   "description": "2-4 sentences of detailed semantics a shopper could search with",
   "pairs_with": "which other pieces in this look it is styled with and why"
 }]
}
List every distinct visible garment and accessory (one entry each).`;

export async function describeImage(ref: string): Promise<{ raw: unknown; model: string; sha256: string }> {
  const { createHash } = await import("node:crypto");
  const img = await loadImage(ref);
  const model = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-5";
  const res = await fetchRetry("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": need("ANTHROPIC_API_KEY"), "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model,
      max_tokens: 2500,
      system: DESCRIBE_SYSTEM,
      messages: [{ role: "user", content: [
        { type: "image", source: { type: "base64", media_type: img.media_type, data: img.data } },
        { type: "text", text: "Describe this look as the JSON object specified." },
      ] }],
    }),
  });
  if (!res.ok) throw new Error(`Claude vision call failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
  const body: any = await res.json();
  const text: string = (body.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("");
  const json = text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  let raw: unknown;
  try { raw = JSON.parse(json); } catch { throw new Error("model did not return valid JSON"); }
  return { raw, model, sha256: createHash("sha256").update(img.bytes).digest("hex") };
}

export async function embedTexts(texts: string[], inputType: "document" | "query"): Promise<number[][]> {
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += 64) {
    const res = await fetchRetry("https://ai.mongodb.com/v1/embeddings", {
      method: "POST",
      headers: { authorization: `Bearer ${need("ATLAS_MODEL_API_KEY")}`, "content-type": "application/json" },
      body: JSON.stringify({ model: EMBED_MODEL(), input: texts.slice(i, i + 64), input_type: inputType, output_dimension: EMBED_DIMENSIONS() }),
    });
    if (!res.ok) throw new Error(`embedding call failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
    const body: any = await res.json();
    for (const d of body.data) out.push(d.embedding);
  }
  return out;
}
