import { test, describe } from "bun:test";
import assert from "node:assert/strict";
import { listingToPayload, usdcToCents, mapCondition, outfitToTryOnItems, type AndroidListing } from "../src/api/mapper";

const listing: AndroidListing = {
  listingId: "lst_123",
  shopId: "shop_9",
  title: "Vintage Denim Jacket",
  brand: "Levi's",
  size: "M",
  priceUsdc: "68.50",
  imageUrls: ["https://img.example/j1.jpg"],
  category: "outerwear",
  condition: "Gently Used",
  status: "active",
};

describe("usdcToCents", () => {
  test("converts decimal strings to integer cents", () => {
    assert.equal(usdcToCents("68.50"), 6850);
    assert.equal(usdcToCents("0.00"), 0);
    assert.equal(usdcToCents(undefined), 0);
    assert.equal(usdcToCents("junk"), 0);
    assert.equal(usdcToCents("-5"), 0);
  });
});

describe("mapCondition", () => {
  test("maps app condition strings to schema enum", () => {
    assert.equal(mapCondition("Gently Used"), "good");
    assert.equal(mapCondition("NWT"), "new");
    assert.equal(mapCondition("EUC"), "like_new");
    assert.equal(mapCondition(undefined), "good");
  });
});

describe("listingToPayload", () => {
  test("produces a valid import payload keyed on listingId", () => {
    const p = listingToPayload(listing, "t1");
    assert.equal(p.tenant_id, "t1");
    assert.equal(p.price_cents, 6850);
    assert.equal(p.condition, "good");
    assert.equal(p.source?.external_id, "lst_123");
    assert.equal(p.source?.system, "racksavant-android");
    assert.equal((p.images ?? [])[0].url, "https://img.example/j1.jpg");
  });
});

describe("outfitToTryOnItems", () => {
  test("resolves inventory + sourced refs into try-on-ready items", () => {
    const items = [
      { role: "tops", kind: "inventory", product_id: "p1" },
      { role: "shoes", kind: "sourced", source_id: "s1" },
      { role: "bottoms", kind: "inventory", product_id: "p2" },
    ];
    const products = new Map([["p1", { title: "Tee", images: [{ url: "https://img/t.jpg" }] }]]);
    const sourced = new Map([["s1", { title: "Boots", image_url: "https://img/b.jpg" }]]);
    const out = outfitToTryOnItems(items, products, sourced);
    assert.equal(out.length, 3);
    assert.equal(out[0].garment_image_url, "https://img/t.jpg");
    assert.equal(out[0].tryon_ready, true);
    assert.equal(out[1].garment_image_url, "https://img/b.jpg");
    assert.equal(out[2].tryon_ready, false); // missing product doc -> not ready
  });
});
