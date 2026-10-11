/**
 * RackSavant inventory schema — single source of truth for collection
 * validators and index definitions. Consumed by scripts/init-db.ts.
 *
 * Bump SCHEMA_VERSION whenever the document shape changes; every imported
 * document is stamped with the version it was written under.
 */
import type { CreateIndexesOptions, IndexSpecification } from "mongodb";

export const SCHEMA_VERSION = 1;

export const COLLECTIONS = {
  products: "products",
  inventoryEvents: "inventory_events",
  inventoryState: "inventory_state",
  sourcedItems: "sourced_items",
  outfits: "outfits",
  tasks: "tasks",
  agentEvents: "agent_events",
} as const;

export const CONDITIONS = ["new", "like_new", "good", "fair", "poor"] as const;
export type Condition = (typeof CONDITIONS)[number];

export const PRODUCT_STATUSES = ["draft", "active", "sold_out", "archived"] as const;
export type ProductStatus = (typeof PRODUCT_STATUSES)[number];

export const SOURCE_TYPES = ["retail", "resale", "consignment", "generated", "synthetic", "sourced"] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

export const INVENTORY_EVENT_TYPES = [
  "received",   // item entered inventory (consignment intake, resale buy, restock)
  "listed",     // item became sellable/active
  "reserved",   // held for a shopper (try-on cart, pending checkout)
  "released",   // reservation expired / cancelled
  "sold",       // payment verified
  "returned",   // came back into inventory
  "adjusted",   // manual correction (damage, loss, recount)
  "archived",   // withdrawn from sale
] as const;
export type InventoryEventType = (typeof INVENTORY_EVENT_TYPES)[number];

/* ------------------------------------------------------------------ */
/* Validators ($jsonSchema, applied with validationLevel "strict")      */
/* ------------------------------------------------------------------ */

export const productsValidator = {
  $jsonSchema: {
    bsonType: "object",
    title: "products — one sellable item; one-off resale/consignment pieces are qty-1 rows",
    required: [
      "tenant_id", "product_id", "title", "category", "price_cents",
      "currency", "condition", "status", "source", "schema_version",
      "created_at", "updated_at",
    ],
    properties: {
      tenant_id:     { bsonType: "string", minLength: 1, description: "owning tenant; all queries are tenant-scoped" },
      product_id:    { bsonType: "string", minLength: 1, description: "stable unique id, format prod_<id>; never reused" },
      sku:           { bsonType: "string", description: "merchant SKU; optional for one-off items" },
      title:         { bsonType: "string", minLength: 1 },
      brand:         { bsonType: ["string", "null"] },
      category:      { bsonType: "string", minLength: 1 },
      subcategory:   { bsonType: "string" },
      price_cents:   { bsonType: "int", minimum: 0, description: "unit price in minor units; no floats for money" },
      currency:      { bsonType: "string", pattern: "^[A-Z]{3}$", description: "ISO 4217" },
      condition:     { enum: [...CONDITIONS] },
      size:          { bsonType: "string" },
      color:         { bsonType: "string" },
      material:      { bsonType: "string" },
      images: {
        bsonType: "array",
        items: {
          bsonType: "object",
          required: ["url"],
          properties: { url: { bsonType: "string" }, alt: { bsonType: "string" } },
        },
      },
      status:        { enum: [...PRODUCT_STATUSES] },
      source: {
        bsonType: "object",
        required: ["type", "system"],
        description: "provenance: where this item came from and which pipeline wrote it",
        properties: {
          type:        { enum: [...SOURCE_TYPES] },
          system:      { bsonType: "string", description: "originating system e.g. seed:synthetic-v1, shopify, pos" },
          external_id: { bsonType: "string", description: "id in the source system; dedupe key on re-import" },
          imported_at: { bsonType: "date" },
        },
      },
      schema_version: { bsonType: "int", minimum: 1 },
      created_at:     { bsonType: "date" },
      updated_at:     { bsonType: "date" },
    },
  },
};

export const inventoryEventsValidator = {
  $jsonSchema: {
    bsonType: "object",
    title: "inventory_events — append-only ledger; never update or delete",
    required: ["tenant_id", "event_id", "product_id", "type", "qty_delta", "occurred_at"],
    properties: {
      tenant_id:   { bsonType: "string", minLength: 1 },
      event_id:    { bsonType: "string", minLength: 1 },
      product_id:  { bsonType: "string", minLength: 1 },
      type:        { enum: [...INVENTORY_EVENT_TYPES] },
      qty_delta:   { bsonType: "int", description: "signed change to on-hand; sold=-1 received=+1" },
      actor:       { bsonType: "string", description: "agent | user:<id> | system:<name>" },
      occurred_at: { bsonType: "date" },
      meta:        { bsonType: "object" },
    },
  },
};

export const inventoryStateValidator = {
  $jsonSchema: {
    bsonType: "object",
    title: "inventory_state — current per-product rollup; rebuildable from inventory_events",
    required: ["tenant_id", "product_id", "on_hand", "reserved", "status", "updated_at"],
    properties: {
      tenant_id:  { bsonType: "string", minLength: 1 },
      product_id: { bsonType: "string", minLength: 1 },
      on_hand:    { bsonType: "int", minimum: 0 },
      reserved:   { bsonType: "int", minimum: 0 },
      status:     { enum: ["in_stock", "reserved", "sold", "out"] },
      updated_at: { bsonType: "date" },
    },
  },
};

/* ------------------------------------------------------------------ */
/* Indexes                                                            */
/* ------------------------------------------------------------------ */

export interface IndexDef {
  keys: IndexSpecification;
  options: CreateIndexesOptions;
}

export const productIndexes: IndexDef[] = [
  // tenant-scoped lookup by stable id — THE primary access path
  { keys: { tenant_id: 1, product_id: 1 }, options: { unique: true, name: "uq_tenant_product" } },
  // SKU unique per tenant when present (one-off items may not have one)
  { keys: { tenant_id: 1, sku: 1 },
    options: { unique: true, name: "uq_tenant_sku", partialFilterExpression: { sku: { $type: "string" } } } },
  // source dedupe key — importer resolves external ids to existing docs
  { keys: { tenant_id: 1, "source.system": 1, "source.external_id": 1 },
    options: { unique: true, name: "uq_tenant_source_ext", partialFilterExpression: { "source.external_id": { $type: "string" } } } },
  // availability browse
  { keys: { tenant_id: 1, status: 1 }, options: { name: "ix_tenant_status" } },
  // category browse
  { keys: { tenant_id: 1, category: 1 }, options: { name: "ix_tenant_category" } },
];

export const inventoryEventIndexes: IndexDef[] = [
  { keys: { tenant_id: 1, event_id: 1 }, options: { unique: true, name: "uq_tenant_event" } },
  { keys: { tenant_id: 1, product_id: 1, occurred_at: 1 }, options: { name: "ix_tenant_product_time" } },
];

export const inventoryStateIndexes: IndexDef[] = [
  { keys: { tenant_id: 1, product_id: 1 }, options: { unique: true, name: "uq_tenant_product_state" } },
  { keys: { tenant_id: 1, status: 1 }, options: { name: "ix_tenant_state_status" } },
];

export const OUTFIT_STATUSES = ["draft", "pending_review", "approved", "rejected", "delivered"] as const;
export const TASK_STATUSES = ["open", "claimed", "approved", "rejected", "snoozed", "done"] as const;
export const TASK_TYPES = ["outfit_review", "source_intake", "signal_triage", "custom"] as const;
export const SOURCED_ITEM_STATUSES = ["candidate", "approved", "intake", "rejected", "expired"] as const;
export const AGENT_EVENT_TYPES = ["run_start", "tool_call", "llm_call", "decision", "escalate", "run_end", "error"] as const;

/* ------------------------------------------------------------------ */
/* Workforce collections: sourcing, outfits, HITL tasks, observability */
/* ------------------------------------------------------------------ */

export const sourcedItemsValidator = {
  $jsonSchema: {
    bsonType: "object",
    title: "sourced_items — agent-found external candidates; promoted to products only via human intake",
    required: ["tenant_id", "source_id", "title", "url", "status", "found_by", "created_at", "updated_at"],
    properties: {
      tenant_id:  { bsonType: "string", minLength: 1 },
      source_id:  { bsonType: "string", minLength: 1, description: "stable external id src_<hash>; dedupes re-discovery" },
      title:      { bsonType: "string", minLength: 1 },
      brand:      { bsonType: ["string", "null"] },
      category:   { bsonType: "string" },
      price_cents:{ bsonType: "int", minimum: 0 },
      currency:   { bsonType: "string", pattern: "^[A-Z]{3}$" },
      url:        { bsonType: "string", minLength: 1, description: "canonical product page" },
      image_url:  { bsonType: "string" },
      retailer:   { bsonType: "string" },
      status:     { enum: [...SOURCED_ITEM_STATUSES] },
      found_by: {
        bsonType: "object",
        required: ["agent", "run_id"],
        properties: { agent: { bsonType: "string" }, run_id: { bsonType: "string" } },
      },
      matched_product_id: { bsonType: "string", description: "set once promoted into products" },
      rationale:  { bsonType: "string", description: "why the agent thinks this fits" },
      created_at: { bsonType: "date" },
      updated_at: { bsonType: "date" },
    },
  },
};

export const outfitsValidator = {
  $jsonSchema: {
    bsonType: "object",
    title: "outfits — composed looks mixing inventory products + sourced candidates",
    required: ["tenant_id", "outfit_id", "shopper_id", "items", "status", "created_at"],
    properties: {
      tenant_id:  { bsonType: "string", minLength: 1 },
      outfit_id:  { bsonType: "string", minLength: 1 },
      shopper_id: { bsonType: "string", minLength: 1 },
      items: {
        bsonType: "array",
        minItems: 1,
        items: {
          bsonType: "object",
          required: ["role", "kind"],
          properties: {
            role:       { bsonType: "string", description: "top|bottom|shoes|outerwear|accessory|..." },
            kind:       { enum: ["inventory", "sourced"] },
            product_id: { bsonType: "string", description: "products ref when kind=inventory" },
            source_id:  { bsonType: "string", description: "sourced_items ref when kind=sourced" },
            rationale:  { bsonType: "string" },
          },
        },
      },
      status:       { enum: [...OUTFIT_STATUSES] },
      agent_run_id: { bsonType: "string" },
      decided_by:   { bsonType: "string" },
      decided_at:   { bsonType: "date" },
      created_at:   { bsonType: "date" },
      updated_at:   { bsonType: "date" },
    },
  },
};

export const tasksValidator = {
  $jsonSchema: {
    bsonType: "object",
    title: "tasks — human-in-the-loop queue; agents escalate, humans decide",
    required: ["tenant_id", "task_id", "type", "status", "priority", "created_at"],
    properties: {
      tenant_id: { bsonType: "string", minLength: 1 },
      task_id:   { bsonType: "string", minLength: 1 },
      type:      { enum: [...TASK_TYPES] },
      status:    { enum: [...TASK_STATUSES] },
      priority:  { bsonType: "int", minimum: 0, maximum: 10, description: "0 low — 10 urgent" },
      payload:   { bsonType: "object", description: "refs to outfit_id/source_id/etc; never embeds secrets" },
      agent_run_id: { bsonType: "string" },
      assignee:  { bsonType: "string" },
      decision:  { bsonType: "string" },
      notes:     { bsonType: "string" },
      created_at:{ bsonType: "date" },
      decided_at:{ bsonType: "date" },
    },
  },
};

export const agentEventsValidator = {
  $jsonSchema: {
    bsonType: "object",
    title: "agent_events — observability ledger; append-only per run",
    required: ["tenant_id", "event_id", "run_id", "agent", "type", "occurred_at"],
    properties: {
      tenant_id:  { bsonType: "string", minLength: 1 },
      event_id:   { bsonType: "string", minLength: 1 },
      run_id:     { bsonType: "string", minLength: 1 },
      agent:      { bsonType: "string", minLength: 1, description: "scout|stylist|intake|..." },
      seq:        { bsonType: "int", minimum: 0 },
      type:       { enum: [...AGENT_EVENT_TYPES] },
      severity:   { enum: ["debug", "info", "warn", "error"] },
      summary:    { bsonType: "string" },
      payload:    { bsonType: "object" },
      occurred_at:{ bsonType: "date" },
    },
  },
};

export const sourcedItemIndexes: IndexDef[] = [
  { keys: { tenant_id: 1, source_id: 1 }, options: { unique: true, name: "uq_tenant_source" } },
  { keys: { tenant_id: 1, status: 1, created_at: -1 }, options: { name: "ix_tenant_source_status" } },
];

export const outfitIndexes: IndexDef[] = [
  { keys: { tenant_id: 1, outfit_id: 1 }, options: { unique: true, name: "uq_tenant_outfit" } },
  { keys: { tenant_id: 1, shopper_id: 1, created_at: -1 }, options: { name: "ix_tenant_shopper_outfits" } },
  { keys: { tenant_id: 1, status: 1 }, options: { name: "ix_tenant_outfit_status" } },
];

export const taskIndexes: IndexDef[] = [
  { keys: { tenant_id: 1, task_id: 1 }, options: { unique: true, name: "uq_tenant_task" } },
  // the human queue: what's open, highest priority first
  { keys: { tenant_id: 1, status: 1, priority: -1, created_at: 1 }, options: { name: "ix_tenant_task_queue" } },
];

export const agentEventIndexes: IndexDef[] = [
  { keys: { tenant_id: 1, event_id: 1 }, options: { unique: true, name: "uq_tenant_agent_event" } },
  { keys: { tenant_id: 1, run_id: 1, seq: 1 }, options: { name: "ix_tenant_run_seq" } },
  { keys: { tenant_id: 1, agent: 1, occurred_at: -1 }, options: { name: "ix_tenant_agent_time" } },
];

export const schema: Array<{ name: string; validator: object; indexes: IndexDef[] }> = [
  { name: COLLECTIONS.products,        validator: productsValidator,        indexes: productIndexes },
  { name: COLLECTIONS.inventoryEvents, validator: inventoryEventsValidator, indexes: inventoryEventIndexes },
  { name: COLLECTIONS.inventoryState,  validator: inventoryStateValidator,  indexes: inventoryStateIndexes },
  { name: COLLECTIONS.sourcedItems,    validator: sourcedItemsValidator,    indexes: sourcedItemIndexes },
  { name: COLLECTIONS.outfits,         validator: outfitsValidator,         indexes: outfitIndexes },
  { name: COLLECTIONS.tasks,           validator: tasksValidator,           indexes: taskIndexes },
  { name: COLLECTIONS.agentEvents,     validator: agentEventsValidator,     indexes: agentEventIndexes },
];
