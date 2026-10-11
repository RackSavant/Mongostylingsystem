/**
 * Pure import logic — no I/O, fully unit-testable.
 * The importer (scripts/import-products.ts) wraps these with Mongo access.
 */
import { createHash } from "node:crypto";
import {
  SCHEMA_VERSION, CONDITIONS, PRODUCT_STATUSES, SOURCE_TYPES,
  type Condition, type ProductStatus, type SourceType,
} from "./schema";

/** Payload as it appears in a seed/import file (pre-normalization). */
export interface ProductPayload {
  tenant_id?: string;
  product_id?: string;
  sku?: string;
  title?: unknown;
  brand?: string | null;
  category?: unknown;
  subcategory?: string;
  price_cents?: unknown;
  currency?: unknown;
  condition?: unknown;
  size?: string;
  color?: string;
  material?: string;
  images?: { url: string; alt?: string }[];
  status?: unknown;
  quantity?: unknown;          // seed convenience: maps to inventory events
  source?: { type?: unknown; system?: unknown; external_id?: unknown };
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

const CURRENCY_RE = /^[A-Z]{3}$/;

/** Mirror of the collection validator, applied client-side for clean errors. */
export function validateProductPayload(p: ProductPayload): ValidationResult {
  const errors: string[] = [];
  const req = (cond: boolean, msg: string) => { if (!cond) errors.push(msg); };

  req(typeof p.tenant_id === "string" && p.tenant_id.length > 0, "tenant_id: required non-empty string");
  if (p.product_id !== undefined) req(typeof p.product_id === "string" && p.product_id.length > 0, "product_id: must be non-empty string when provided");
  if (p.sku !== undefined) req(typeof p.sku === "string", "sku: must be string");
  req(typeof p.title === "string" && p.title.length > 0, "title: required non-empty string");
  req(typeof p.category === "string" && p.category.length > 0, "category: required non-empty string");
  req(Number.isInteger(p.price_cents) && (p.price_cents as number) >= 0, "price_cents: required integer >= 0 (no floats, minor units)");
  req(typeof p.currency === "string" && CURRENCY_RE.test(p.currency), "currency: required ISO 4217 code (e.g. USD)");
  req(typeof p.condition === "string" && (CONDITIONS as readonly string[]).includes(p.condition), `condition: one of ${CONDITIONS.join("|")}`);
  req(typeof p.status === "string" && (PRODUCT_STATUSES as readonly string[]).includes(p.status), `status: one of ${PRODUCT_STATUSES.join("|")}`);
  req(typeof p.source?.type === "string" && (SOURCE_TYPES as readonly string[]).includes(p.source.type), `source.type: one of ${SOURCE_TYPES.join("|")}`);
  req(typeof p.source?.system === "string" && p.source.system.length > 0, "source.system: required string (provenance)");
  if (p.source?.external_id !== undefined) req(typeof p.source.external_id === "string" && p.source.external_id.length > 0, "source.external_id: must be non-empty string when provided");
  if (p.images !== undefined) {
    req(Array.isArray(p.images) && p.images.every((i) => typeof i?.url === "string" && i.url.length > 0), "images: array of {url[, alt]}");
  }
  if (p.quantity !== undefined) req(Number.isInteger(p.quantity) && (p.quantity as number) >= 0, "quantity: integer >= 0 when provided");

  return { ok: errors.length === 0, errors };
}

/**
 * Deterministic stable id: prod_<24hex> = sha256(tenant|system|external_id).
 * Re-importing the same source item always resolves to the same product_id,
 * which is what makes the importer safely rerunnable.
 */
export function productIdFor(tenantId: string, system: string, externalId: string): string {
  const h = createHash("sha256").update(`${tenantId}|${system}|${externalId}`).digest("hex");
  return `prod_${h.slice(0, 24)}`;
}

export interface ProductDoc {
  tenant_id: string;
  product_id: string;
  sku?: string;
  title: string;
  brand: string | null;
  category: string;
  subcategory?: string;
  price_cents: number;
  currency: string;
  condition: Condition;
  size?: string;
  color?: string;
  material?: string;
  images: { url: string; alt?: string }[];
  status: ProductStatus;
  source: { type: SourceType; system: string; external_id?: string; imported_at: Date };
  schema_version: number;
  created_at: Date;
  updated_at: Date;
}

/** Normalize a validated payload into a product document. */
export function toProductDoc(p: ProductPayload & { tenant_id: string }, now: Date): ProductDoc {
  const source = {
    type: p.source!.type as SourceType,
    system: p.source!.system as string,
    ...(p.source!.external_id !== undefined ? { external_id: p.source!.external_id as string } : {}),
    imported_at: now,
  };
  const product_id =
    p.product_id ??
    (source.external_id
      ? productIdFor(p.tenant_id, source.system, source.external_id)
      : `prod_${createHash("sha256").update(`${p.tenant_id}|${crypto.randomUUID()}`).digest("hex").slice(0, 24)}`);

  return {
    tenant_id: p.tenant_id,
    product_id,
    ...(p.sku !== undefined ? { sku: p.sku } : {}),
    title: p.title as string,
    brand: p.brand ?? null,
    category: p.category as string,
    ...(p.subcategory !== undefined ? { subcategory: p.subcategory } : {}),
    price_cents: p.price_cents as number,
    currency: p.currency as string,
    condition: p.condition as Condition,
    ...(p.size !== undefined ? { size: p.size } : {}),
    ...(p.color !== undefined ? { color: p.color } : {}),
    ...(p.material !== undefined ? { material: p.material } : {}),
    images: p.images ?? [],
    status: p.status as ProductStatus,
    source,
    schema_version: SCHEMA_VERSION,
    created_at: now,
    updated_at: now,
  };
}

export type PlanOp =
  | { op: "insert"; doc: ProductDoc }
  | { op: "skip"; reason: string; product_id: string }
  | { op: "update"; product_id: string; set: Partial<ProductDoc> };

/** Fields the importer may refresh on rerun with --update (never identity/provenance). */
const UPDATABLE: (keyof ProductDoc)[] = [
  "sku", "title", "brand", "category", "subcategory", "price_cents", "currency",
  "condition", "size", "color", "material", "images", "status", "schema_version",
];

/**
 * Decide what to do with one validated doc.
 * existing = the product already in DB with same (tenant_id, product_id), or null.
 * opts.update must be true to mutate an existing record — never overwrite silently.
 */
export function planImport(existing: { product_id: string } | null, doc: ProductDoc, opts: { update: boolean }): PlanOp {
  if (!existing) return { op: "insert", doc };
  if (!opts.update) return { op: "skip", reason: "exists (use --update to refresh fields)", product_id: existing.product_id };
  const set: Partial<ProductDoc> = { updated_at: doc.updated_at };
  for (const k of UPDATABLE) if (k in doc) (set as any)[k] = doc[k];
  return { op: "update", product_id: existing.product_id, set };
}
