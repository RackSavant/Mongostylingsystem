/**
 * Server-side MongoDB connection for RackSavant inventory.
 *
 * Env vars (loaded from .env by Bun automatically):
 *   MONGODB_URI   - full mongodb+srv:// connection string (required)
 *   MONGODB_DB    - database name (default "needitnow")
 *   MONGODB_TEST_DB - database used by integration tests (default "needitnow_test")
 *
 * Least-privilege note: MONGODB_URI should point at a user scoped to
 * readWrite on the app database only (Atlas: Database Access -> custom role).
 * The current sandbox user has broader grants; tighten before production.
 */
import { MongoClient, Db } from "mongodb";

let client: MongoClient | null = null;

export function mongoUri(): string {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI is not set — see .env.example");
  return uri;
}

export function dbName(override?: string): string {
  return override ?? process.env.MONGODB_DB ?? "needitnow";
}

export async function getDb(name?: string): Promise<Db> {
  if (!client) {
    client = new MongoClient(mongoUri(), { serverSelectionTimeoutMS: 10_000 });
    await client.connect();
  }
  return client.db(dbName(name));
}

/** Close the shared client (call at end of scripts/tests). */
export async function closeMongo(): Promise<void> {
  await client?.close();
  client = null;
}
