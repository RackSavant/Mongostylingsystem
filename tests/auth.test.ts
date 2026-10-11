import { describe, expect, test } from "bun:test";
import { createHandler } from "../src/api/server";

const TOKEN = "t".repeat(32);
const fakeDb = { databaseName: "fake", collection: () => { throw new Error("db must not be touched"); } } as any;
const handle = createHandler(fakeDb, TOKEN);
const req = (path: string, init: RequestInit = {}) => handle(new Request(`http://x${path}`, init));

describe("api auth + hardening", () => {
  test("health is public", async () => {
    expect((await req("/health")).status).toBe(200);
  });
  test("missing token -> 401", async () => {
    expect((await req("/v1/tenants/t1/products")).status).toBe(401);
  });
  test("wrong token -> 401", async () => {
    const r = await req("/v1/tenants/t1/products", { headers: { authorization: "Bearer nope" } });
    expect(r.status).toBe(401);
  });
  test("invalid tenant id -> 404 before db access", async () => {
    const r = await req("/v1/tenants/bad%24id/products", { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(r.status).toBe(404);
  });
  test("malformed JSON -> 400", async () => {
    const r = await req("/v1/tenants/t1/style", { method: "POST", body: "{nope", headers: { authorization: `Bearer ${TOKEN}` } });
    expect(r.status).toBe(400);
  });
  test("oversized body -> 413", async () => {
    const r = await req("/v1/tenants/t1/style", { method: "POST", body: "x".repeat(70_000), headers: { authorization: `Bearer ${TOKEN}` } });
    expect(r.status).toBe(413);
  });
  test("internal errors do not leak details", async () => {
    const r = await req("/v1/tenants/t1/products", { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(r.status).toBe(500);
    expect(await r.json()).toEqual({ error: "internal error" });
  });
});
