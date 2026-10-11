/**
 * Mapping between the racksavant-android app's models and this system.
 * Pure functions — unit-testable, no I/O.
 */
import type { ProductPayload } from "../data/import-core";

/** Mirrors com.racksavant.lens.model.Listing (Firestore doc shape). */
export interface AndroidListing {
  listingId: string;
  shopId?: string;
  sellerId?: string;
  title: string;
  description?: string;
  brand?: string;
  size?: string;
  priceUsdc?: string;       // "0.00" — USDC ~ USD
  imageUrls?: string[];
  videoUrl?: string;
  category?: string;
  condition?: string;
  tags?: string[];
  status?: string;
}

const CONDITION_MAP: Record<string, string> = {
  new: "new", "new with tags": "new", nwt: "new",
  "like new": "like_new", like_new: "like_new", euc: "like_new",
  good: "good", gently_used: "good",
  fair: "fair",
  poor: "poor", well_worn: "poor",
};

export function mapCondition(raw?: string): string {
  const key = (raw ?? "").toLowerCase().trim();
  return CONDITION_MAP[key] ?? "good";
}

const STATUS_MAP: Record<string, string> = {
  active: "active", draft: "draft", sold: "sold_out", archived: "archived",
};

/** priceUsdc "12.50" -> 1250 (minor units; USDC treated 1:1 with USD). */
export function usdcToCents(priceUsdc?: string): number {
  const n = Number.parseFloat(priceUsdc ?? "0");
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : 0;
}

/** Android Listing -> import payload for the products importer. */
export function listingToPayload(listing: AndroidListing, tenantId: string): ProductPayload {
  return {
    tenant_id: tenantId,
    title: listing.title,
    brand: listing.brand || null,
    category: listing.category || "uncategorized",
    price_cents: usdcToCents(listing.priceUsdc),
    currency: "USD",
    condition: mapCondition(listing.condition),
    status: STATUS_MAP[listing.status ?? "active"] ?? "active",
    ...(listing.size ? { size: listing.size } : {}),
    images: (listing.imageUrls ?? []).map((url) => ({ url })),
    source: {
      type: "resale",
      system: "racksavant-android",
      external_id: listing.listingId,
    },
  };
}

/** One outfit item resolved for the app's Try-On feature. */
export interface TryOnItem {
  role: string;
  kind: "inventory" | "sourced";
  ref: string;                       // product_id or source_id
  title?: string;
  brand?: string | null;
  price_cents?: number;
  currency?: string;
  garment_image_url?: string;        // what the app feeds GeminiTryOnRepository
  tryon_ready: boolean;              // image present -> can be sent to try-on
}

export function outfitToTryOnItems(
  items: { role: string; kind: string; product_id?: string; source_id?: string; rationale?: string }[],
  productsById: Map<string, any>,
  sourcedById: Map<string, any>,
): TryOnItem[] {
  return items.map((it) => {
    const doc = it.kind === "inventory" ? productsById.get(it.product_id!) : sourcedById.get(it.source_id!);
    const img = it.kind === "inventory" ? doc?.images?.[0]?.url : doc?.image_url;
    return {
      role: it.role,
      kind: it.kind as "inventory" | "sourced",
      ref: it.kind === "inventory" ? it.product_id! : it.source_id!,
      title: doc?.title,
      brand: doc?.brand ?? null,
      price_cents: doc?.price_cents,
      currency: doc?.currency,
      garment_image_url: img,
      tryon_ready: typeof img === "string" && img.length > 0,
      ...(it.rationale ? { rationale: it.rationale } : {}),
    } as TryOnItem;
  });
}
