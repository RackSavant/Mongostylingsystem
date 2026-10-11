/**
 * AgentRun — the shared context every workforce agent executes inside.
 * Provides run_id, observability events (agent_events), and HITL escalation
 * (tasks). Agents never write these collections directly.
 */
import { randomUUID } from "node:crypto";
import type { Db } from "mongodb";
import { COLLECTIONS, type AGENT_EVENT_TYPES, type TASK_TYPES } from "../data/schema";

type AgentEventType = (typeof AGENT_EVENT_TYPES)[number];
type TaskType = (typeof TASK_TYPES)[number];

export interface AgentRunOpts {
  db: Db;
  tenantId: string;
  agent: string;
  dryRun?: boolean;
}

export class AgentRun {
  readonly runId: string;
  readonly agent: string;
  readonly tenantId: string;
  private seq = 0;
  private db: Db;
  private dryRun: boolean;

  private constructor(opts: AgentRunOpts) {
    this.db = opts.db;
    this.tenantId = opts.tenantId;
    this.agent = opts.agent;
    this.dryRun = !!opts.dryRun;
    this.runId = `run_${randomUUID()}`;
  }

  static async start(opts: AgentRunOpts): Promise<AgentRun> {
    const run = new AgentRun(opts);
    await run.emit("run_start", "info", `${opts.agent} run started`);
    return run;
  }

  /** Append an observability event for this run. */
  async emit(type: AgentEventType, severity: "debug" | "info" | "warn" | "error", summary: string, payload?: object): Promise<void> {
    if (this.dryRun) return;
    await this.db.collection(COLLECTIONS.agentEvents).insertOne({
      tenant_id: this.tenantId,
      event_id: `ae_${randomUUID()}`,
      run_id: this.runId,
      agent: this.agent,
      seq: this.seq++,
      type,
      severity,
      summary,
      ...(payload ? { payload } : {}),
      occurred_at: new Date(),
    } as any);
  }

  /**
   * Escalate a decision to a human. Creates an open task; the agent continues
   * (or ends) and the human decides later via POST /tasks/:id/decision.
   */
  async escalate(type: TaskType, priority: number, payload: object, notes?: string): Promise<string> {
    const task_id = `task_${randomUUID()}`;
    await this.emit("escalate", "warn", `escalated ${type}`, { task_id, ...payload });
    if (this.dryRun) return task_id;
    await this.db.collection(COLLECTIONS.tasks).insertOne({
      tenant_id: this.tenantId,
      task_id,
      type,
      status: "open",
      priority,
      payload,
      agent_run_id: this.runId,
      ...(notes ? { notes } : {}),
      created_at: new Date(),
    } as any);
    return task_id;
  }

  async end(summary: string, payload?: object): Promise<void> {
    await this.emit("run_end", "info", summary, payload);
  }
}
