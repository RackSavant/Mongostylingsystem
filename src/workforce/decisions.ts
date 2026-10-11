/**
 * decideTask — apply a human decision to an open task and run consequences.
 * This is where the loop closes: approve => downstream effect, reject => clean up.
 */
import type { Db } from "mongodb";
import { COLLECTIONS } from "../data/schema";
import { AgentRun } from "./runner";
import { intake } from "./agents";

export interface DecisionResult {
  taskId: string;
  type: string;
  decision: string;
  effects: Record<string, unknown>;
}

export async function decideTask(opts: {
  db: Db;
  tenantId: string;
  taskId: string;
  decision: "approved" | "rejected" | "done";
  decidedBy: string;
  notes?: string;
  dryRun?: boolean;
}): Promise<DecisionResult> {
  const tasks = opts.db.collection(COLLECTIONS.tasks);
  const task = await tasks.findOne({ tenant_id: opts.tenantId, task_id: opts.taskId });
  if (!task) throw new Error(`task ${opts.taskId} not found`);
  if (!["open", "claimed", "snoozed"].includes(task.status as string)) {
    throw new Error(`task ${opts.taskId} is already ${task.status}`);
  }

  const now = new Date();
  const effects: Record<string, unknown> = {};

  await tasks.updateOne(
    { tenant_id: opts.tenantId, task_id: opts.taskId },
    { $set: { status: opts.decision, decision: opts.decision, decided_at: now, assignee: opts.decidedBy, ...(opts.notes ? { notes: opts.notes } : {}) } },
  );

  const run = await AgentRun.start({ db: opts.db, tenantId: opts.tenantId, agent: "decision-handler", dryRun: opts.dryRun });
  await run.emit("decision", "info", `task ${opts.taskId} -> ${opts.decision} by ${opts.decidedBy}`);

  if (task.type === "outfit_review") {
    const outfitId = (task.payload as any)?.outfit_id;
    await opts.db.collection(COLLECTIONS.outfits).updateOne(
      { tenant_id: opts.tenantId, outfit_id: outfitId },
      { $set: { status: opts.decision === "approved" ? "approved" : "rejected", decided_by: opts.decidedBy, decided_at: now, updated_at: now } },
    );
    effects.outfit_id = outfitId;
    effects.outfit_status = opts.decision === "approved" ? "approved" : "rejected";
    // rejected outfit → its sourced candidates are rejected too (never reach catalog)
    if (opts.decision === "rejected") {
      const srcIds = ((task.payload as any)?.source_ids as string[]) ?? [];
      if (srcIds.length) {
        await opts.db.collection(COLLECTIONS.sourcedItems).updateMany(
          { tenant_id: opts.tenantId, source_id: { $in: srcIds } },
          { $set: { status: "rejected", updated_at: now } },
        );
        effects.rejected_source_ids = srcIds;
      }
    }
  }

  if (task.type === "source_intake" && opts.decision === "approved") {
    const srcIds = ((task.payload as any)?.source_ids as string[]) ?? [];
    const promoted: Record<string, string> = {};
    for (const sid of srcIds) {
      const { productId } = await intake({ db: opts.db, tenantId: opts.tenantId, sourceId: sid, decidedBy: opts.decidedBy, dryRun: opts.dryRun });
      promoted[sid] = productId;
    }
    effects.promoted = promoted;
  }

  if (task.type === "source_intake" && opts.decision === "rejected") {
    const srcIds = ((task.payload as any)?.source_ids as string[]) ?? [];
    if (srcIds.length) {
      await opts.db.collection(COLLECTIONS.sourcedItems).updateMany(
        { tenant_id: opts.tenantId, source_id: { $in: srcIds } },
        { $set: { status: "rejected", updated_at: now } },
      );
      effects.rejected_source_ids = srcIds;
    }
  }

  await run.end(`decision applied`, effects);
  return { taskId: opts.taskId, type: task.type as string, decision: opts.decision, effects };
}
