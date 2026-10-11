/**
 * bun run db:init — provision RackSavant inventory collections + indexes.
 * Idempotent: creates collections only if missing, always (re)asserts indexes
 * and validators via collMod. Safe to run against a live database.
 *
 * Env: MONGODB_URI, MONGODB_DB (default "needitnow")
 */
import { getDb, closeMongo } from "../src/data/mongo";
import { schema } from "../src/data/schema";

const db = await getDb();
const existing = new Set((await db.listCollections().toArray()).map((c) => c.name));

for (const def of schema) {
  if (existing.has(def.name)) {
    // re-assert validator on existing collection (additive tightening is fine;
    // loosening rules is a migration — do that deliberately, not here)
    await db.command({ collMod: def.name, validator: def.validator });
    console.log(`~ ${def.name}: exists, validator re-asserted`);
  } else {
    await db.createCollection(def.name, {
      validator: def.validator,
      validationLevel: "strict",
      validationAction: "error",
    });
    console.log(`+ ${def.name}: created with validator`);
  }
  for (const ix of def.indexes) {
    await db.collection(def.name).createIndex(ix.keys, ix.options);
    console.log(`  · index ${ix.options.name}`);
  }
}

console.log(`\nDone. Database "${db.databaseName}" — ${schema.length} collections ready.`);
await closeMongo();
