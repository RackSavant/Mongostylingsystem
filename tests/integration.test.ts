/**
 * Integration tests against a real Atlas cluster.
 * Gated: only runs when RUN_DB_TESTS=1 and MONGODB_URI is set.
 * Uses MONGODB_TEST_DB (default needitnow_test) — never touches the app DB.
 */
import { test, describe, beforeAll, afterAll } from "bun:test";
import assert from "node:assert/strict";
import { getDb, closeMongo, mongoUri } from "../src/data/mongo";
import { COLLECTIONS, schema } from "../src/data/schema";
import { toProductDoc } from "../src/data/import-core";

const RUN = process.env.RUN_DB_TESTS === "1" && !!process.env.MONGODB_URI;
const DB = process.env.MONGODB_TEST_DB ?? "needitnow_test";

const docA = toProductDoc({
  tenant_id: "tenant-a", title: "Coat A", category: "outerwear",
  price_cents: 1000, currency: "USD", condition: "good", status: "active",
  source: { type: "synthetic", system: "test", external_id: "a1" },
}, new Date());
const docB = { ...docA, tenant_id: "tenant-b", title: "Coat B" };

describe.skipIf(!RUN)("mongo integration (Atlas)", () => {
  beforeAll(async () => {
    mongoUri(); // throws early if unset
    const db = await getDb(DB);
    const existing = new Set((await db.listCollections().toArray()).map((c) => c.name));
    for (const def of schema) {
      if (!existing.has(def.name)) {
        await db.createCollection(def.name, { validator: def.validator, validationLevel: "strict", validationAction: "error" });
      }
      for (const ix of def.indexes) await db.collection(def.name).createIndex(ix.keys, ix.options);
    }
  });

  afterAll(async () => {
    const db = await getDb(DB);
    for (const def of schema) await db.collection(def.name).deleteMany({ tenant_id: /^tenant-(a|b)$/ });
    await closeMongo();
  });

  test("validator rejects a doc missing tenant_id", async () => {
    const db = await getDb(DB);
    const bad: any = { ...docA };
    delete bad.tenant_id;
    await assert.rejects(() => db.collection(COLLECTIONS.products).insertOne(bad));
  });

  test("validator rejects non-integer price", async () => {
    const db = await getDb(DB);
    await assert.rejects(() =>
      db.collection(COLLECTIONS.products).insertOne({ ...docA, price_cents: 9.99 } as any),
    );
  });

  test("duplicate (tenant_id, product_id) insert fails — rerun safety at DB level", async () => {
    const db = await getDb(DB);
    await db.collection(COLLECTIONS.products).insertOne(docA as any);
    await assert.rejects(() => db.collection(COLLECTIONS.products).insertOne({ ...docA } as any));
  });

  test("tenant isolation: tenant-b cannot read tenant-a product", async () => {
    const db = await getDb(DB);
    await db.collection(COLLECTIONS.products).insertOne(docB as any);
    const asB = await db.collection(COLLECTIONS.products).findOne({ tenant_id: "tenant-b", product_id: docA.product_id });
    assert.ok(asB && asB.title === "Coat B", "tenant-b sees only its own doc for same product_id shape");
    const crossRead = await db.collection(COLLECTIONS.products).findOne({ tenant_id: "tenant-b", title: "Coat A" });
    assert.equal(crossRead, null);
  });
});
