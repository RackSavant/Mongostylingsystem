/**
 * bun run trends:review --tenant <id> [--list] [--approve <look_id>] [--reject <look_id>] [--approve-all]
 * Human gate: only approved looks/garments are retrievable by agents.
 * Changes review_status only; never deletes.
 */
import { getDb, closeMongo } from "../src/data/mongo";
import { TREND_COLLECTIONS } from "../src/data/schema";

const args = process.argv.slice(2);
const opt = (n: string) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
const tenantId = opt("tenant");
if (!tenantId) { console.error("usage: --tenant <id> [--list|--approve <look_id>|--reject <look_id>|--approve-all]"); process.exit(2); }

const db = await getDb();
const looks = db.collection(TREND_COLLECTIONS.looks), garments = db.collection(TREND_COLLECTIONS.garments);
const set = async (filter: object, status: "approved" | "rejected") => {
  const f = { tenant_id: tenantId, review_status: "pending_review", ...filter };
  const ids = (await looks.find(f, { projection: { look_id: 1 } }).toArray()).map((l) => l.look_id);
  const u = { $set: { review_status: status, updated_at: new Date() } };
  await looks.updateMany({ tenant_id: tenantId, look_id: { $in: ids } }, u);
  await garments.updateMany({ tenant_id: tenantId, look_id: { $in: ids } }, u);
  console.log(`${status}: ${ids.length} look(s)`);
};

if (opt("approve")) await set({ look_id: opt("approve") }, "approved");
else if (opt("reject")) await set({ look_id: opt("reject") }, "rejected");
else if (args.includes("--approve-all")) await set({}, "approved");
else {
  const pending = await looks.find({ tenant_id: tenantId, review_status: "pending_review" }, { projection: { embedding: 0 } }).toArray();
  for (const l of pending) {
    console.log("");
    console.log(`${l.look_id}  ${l.image.ref}`);
    console.log(`  ${l.summary}`);
    console.log(`  aesthetics: ${l.aesthetics.join(", ")}`);
    for (const g of await garments.find({ tenant_id: tenantId, look_id: l.look_id }).toArray()) console.log(`   - [${g.role}] ${g.name}: ${g.description}`);
  }
  console.log(`\n${pending.length} pending`);
}
await closeMongo();
