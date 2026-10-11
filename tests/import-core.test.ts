import { test, describe } from "bun:test";
import assert from "node:assert/strict";
import {
  validateProductPayload, productIdFor, toProductDoc, planImport,
  type ProductPayload,
} from "../src/data/import-core";
import { SCHEMA_VERSION } from "../src/data/schema";

const base: ProductPayload = {
  tenant_id: "t1",
  title: "Wool Coat",
  category: "outerwear",
  price_cents: 12000,
  currency: "USD",
  condition: "good",
  status: "active",
  source: { type: "resale", system: "test", external_id: "x1" },
};

describe("validateProductPayload", () => {
  test("accepts a well-formed payload", () => {
    assert.equal(validateProductPayload(base).ok, true);
  });
  test("rejects missing tenant_id", () => {
    const r = validateProductPayload({ ...base, tenant_id: "" });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => e.startsWith("tenant_id")));
  });
  test("rejects invalid price: negative, float, missing", () => {
    for (const price_cents of [-1, 9.99, undefined, "12"]) {
      const r = validateProductPayload({ ...base, price_cents: price_cents as any });
      assert.equal(r.ok, false, `expected reject for price=${price_cents}`);
      assert.ok(r.errors.some((e) => e.startsWith("price_cents")));
    }
  });
  test("rejects bad currency and bad condition", () => {
    assert.equal(validateProductPayload({ ...base, currency: "usd" }).ok, false);
    assert.equal(validateProductPayload({ ...base, currency: "USDD" }).ok, false);
    assert.equal(validateProductPayload({ ...base, condition: "mint" }).ok, false);
  });
  test("rejects unknown source type and missing source.system", () => {
    assert.equal(validateProductPayload({ ...base, source: { type: "alien", system: "x" } }).ok, false);
    assert.equal(validateProductPayload({ ...base, source: { type: "resale" } }).ok, false);
  });
});

describe("productIdFor", () => {
  test("is deterministic per (tenant, system, external_id)", () => {
    assert.equal(productIdFor("t1", "sys", "ext1"), productIdFor("t1", "sys", "ext1"));
    assert.notEqual(productIdFor("t1", "sys", "ext1"), productIdFor("t2", "sys", "ext1"));
    assert.match(productIdFor("t1", "sys", "ext1"), /^prod_[0-9a-f]{24}$/);
  });
});

describe("toProductDoc", () => {
  const now = new Date("2026-01-01T00:00:00Z");
  test("derives stable product_id from external_id and stamps schema_version", () => {
    const doc = toProductDoc({ ...base, tenant_id: "t1" }, now);
    assert.equal(doc.product_id, productIdFor("t1", "test", "x1"));
    assert.equal(doc.schema_version, SCHEMA_VERSION);
    assert.deepEqual(doc.created_at, now);
  });
});

describe("planImport — rerun safety", () => {
  const now = new Date();
  const doc = toProductDoc({ ...base, tenant_id: "t1" }, now);
  test("new product -> insert", () => {
    assert.equal(planImport(null, doc, { update: false }).op, "insert");
  });
  test("existing product without --update -> skip (no overwrite)", () => {
    const plan = planImport({ product_id: doc.product_id }, doc, { update: false });
    assert.equal(plan.op, "skip");
  });
  test("existing product with --update -> update of mutable fields only", () => {
    const plan = planImport({ product_id: doc.product_id }, doc, { update: true });
    assert.equal(plan.op, "update");
    if (plan.op === "update") {
      assert.ok(!("tenant_id" in plan.set), "never mutates tenant_id");
      assert.ok(!("source" in plan.set), "never mutates provenance");
      assert.ok(!("created_at" in plan.set), "never mutates created_at");
      assert.ok("updated_at" in plan.set);
    }
  });
});
