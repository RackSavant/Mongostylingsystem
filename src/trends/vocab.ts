/**
 * Trend library — controlled vocabulary + pure validation/normalization.
 * No I/O. The vision model must answer in this shape; anything that does not
 * validate is rejected before it can reach the database or the embeddings.
 */
import { createHash } from "node:crypto";

export const TREND_ROLES = ["tops", "bottoms", "shoes", "outerwear", "accessories", "dresses"] as const;
export type TrendRole = (typeof TREND_ROLES)[number];

export const SEASONS = ["spring", "summer", "fall", "winter", "all_season"] as const;
export const REVIEW_STATUSES = ["pending_review", "approved", "rejected"] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

export const LICENSE_TYPES = ["owned", "licensed", "public_web_demo"] as const;
export const TREND_SOURCE_TYPES = ["manual", "approved_outfit", "agent_found"] as const;

export const TREND_VOCAB_VERSION = 1;

export interface GarmentDescription {
  role: TrendRole;
  name: string;
  silhouette: string;
  fit: string;
  length?: string;
  colors: string[];
  pattern: string;
  fabric: string;
  details: string[];
  aesthetics: string[];
  occasions: string[];
  seasons: string[];
  description: string;
  pairs_with?: string;
}

export interface LookDescription {
  summary: string;
  aesthetics: string[];
  occasions: string[];
  seasons: string[];
  garments: GarmentDescription[];
}

const str = (v: unknown, max = 600) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const strList = (v: unknown, max = 12): string[] =>
  Array.isArray(v)
    ? [...new Set(v.map((x) => str(x, 60).toLowerCase()).filter(Boolean))].slice(0, max)
    : [];

/** Validate + normalize raw model JSON into a LookDescription, or return errors. */
export function validateLookDescription(raw: unknown): { ok: true; value: LookDescription } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const r = (raw ?? {}) as Record<string, unknown>;
  const summary = str(r.summary, 800);
  if (summary.length < 20) errors.push("summary must be at least 20 characters");
  if (!Array.isArray(r.garments) || r.garments.length === 0) errors.push("garments must be a non-empty array");

  const garments: GarmentDescription[] = [];
  (Array.isArray(r.garments) ? r.garments : []).forEach((g: any, i: number) => {
    const role = str(g?.role).toLowerCase();
    if (!(TREND_ROLES as readonly string[]).includes(role)) errors.push(`garments[${i}].role must be one of ${TREND_ROLES.join("|")}`);
    const description = str(g?.description, 1200);
    if (description.length < 30) errors.push(`garments[${i}].description must be at least 30 characters (detailed semantics)`);
    const colors = strList(g?.colors, 6);
    if (colors.length === 0) errors.push(`garments[${i}].colors required`);
    const name = str(g?.name, 120);
    if (!name) errors.push(`garments[${i}].name required`);
    garments.push({
      role: role as TrendRole,
      name,
      silhouette: str(g?.silhouette, 80).toLowerCase(),
      fit: str(g?.fit, 80).toLowerCase(),
      length: str(g?.length, 80).toLowerCase() || undefined,
      colors,
      pattern: str(g?.pattern, 80).toLowerCase() || "solid",
      fabric: str(g?.fabric, 120).toLowerCase(),
      details: strList(g?.details),
      aesthetics: strList(g?.aesthetics),
      occasions: strList(g?.occasions),
      seasons: strList(g?.seasons, 5).filter((s) => (SEASONS as readonly string[]).includes(s)),
      description,
      pairs_with: str(g?.pairs_with, 400) || undefined,
    });
  });

  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    value: {
      summary,
      aesthetics: strList(r.aesthetics),
      occasions: strList(r.occasions),
      seasons: strList(r.seasons, 5).filter((s) => (SEASONS as readonly string[]).includes(s)),
      garments,
    },
  };
}

/** Text that gets embedded for a garment — description first, facets after, so both semantic and keyword signal land in the vector. */
export function garmentEmbeddingText(g: GarmentDescription, lookAesthetics: string[] = []): string {
  return [
    `${g.name} (${g.role}). ${g.description}`,
    `Silhouette: ${g.silhouette}. Fit: ${g.fit}.${g.length ? ` Length: ${g.length}.` : ""}`,
    `Colors: ${g.colors.join(", ")}. Pattern: ${g.pattern}. Fabric: ${g.fabric}.`,
    g.details.length ? `Details: ${g.details.join(", ")}.` : "",
    `Aesthetic: ${[...new Set([...g.aesthetics, ...lookAesthetics])].join(", ")}.`,
    g.occasions.length ? `Occasions: ${g.occasions.join(", ")}.` : "",
    g.pairs_with ? `Pairs with: ${g.pairs_with}` : "",
  ].filter(Boolean).join(" ");
}

export function lookEmbeddingText(l: LookDescription): string {
  return [
    l.summary,
    `Aesthetic: ${l.aesthetics.join(", ")}. Occasions: ${l.occasions.join(", ")}.`,
    `Pieces: ${l.garments.map((g) => `${g.name} (${g.role})`).join("; ")}.`,
  ].join(" ");
}

/** Deterministic ids so reruns never duplicate. */
export const lookIdFor = (tenantId: string, imageKey: string) =>
  `look_${createHash("sha256").update(`${tenantId}|${imageKey}`).digest("hex").slice(0, 20)}`;
export const garmentIdFor = (lookId: string, index: number, role: string) =>
  `tg_${createHash("sha256").update(`${lookId}|${index}|${role}`).digest("hex").slice(0, 20)}`;

export interface ManifestEntry {
  image: string;
  look_id?: string;
  season?: string;
  notes?: string;
  source: { type?: string; url?: string; credit?: string; license?: string };
}

export function validateManifestEntry(e: unknown, i: number): string[] {
  const errors: string[] = [];
  const x = (e ?? {}) as ManifestEntry;
  if (!x.image || typeof x.image !== "string") errors.push(`entry ${i}: image (path or https URL) required`);
  if (!x.source || typeof x.source !== "object") errors.push(`entry ${i}: source required`);
  else {
    if (!(LICENSE_TYPES as readonly string[]).includes(String(x.source.license))) errors.push(`entry ${i}: source.license must be ${LICENSE_TYPES.join("|")}`);
    if (!x.source.credit && !x.source.url) errors.push(`entry ${i}: source.credit or source.url required (provenance)`);
  }
  return errors;
}
