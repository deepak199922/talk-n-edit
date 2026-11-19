import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { WORKSPACE } from "./config.js";

let db: DatabaseSync | null = null;

export function getDb(): DatabaseSync {
  if (db) return db;
  fs.mkdirSync(WORKSPACE, { recursive: true });
  db = new DatabaseSync(path.join(WORKSPACE, "studio.db"));
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 10000;
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY, name TEXT UNIQUE NOT NULL, created TEXT NOT NULL, data TEXT NOT NULL DEFAULT '{}'
    );
    CREATE TABLE IF NOT EXISTS assets (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL,
      created TEXT NOT NULL, data TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS analyses (
      id TEXT PRIMARY KEY, asset_id TEXT NOT NULL, kind TEXT NOT NULL, params_hash TEXT NOT NULL,
      path TEXT NOT NULL, created TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '{}'
    );
    CREATE TABLE IF NOT EXISTS timelines (
      id TEXT NOT NULL, version INTEGER NOT NULL, project_id TEXT NOT NULL, name TEXT NOT NULL,
      json TEXT NOT NULL, created TEXT NOT NULL, PRIMARY KEY (id, version)
    );
    CREATE TABLE IF NOT EXISTS renders (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, timeline_id TEXT NOT NULL, version INTEGER NOT NULL,
      quality TEXT NOT NULL, status TEXT NOT NULL, dir TEXT NOT NULL, created TEXT NOT NULL,
      data TEXT NOT NULL DEFAULT '{}'
    );
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY, type TEXT NOT NULL, queue TEXT NOT NULL, status TEXT NOT NULL,
      stage TEXT NOT NULL DEFAULT '', progress REAL NOT NULL DEFAULT 0, input TEXT NOT NULL,
      result TEXT, error TEXT, created TEXT NOT NULL, updated TEXT NOT NULL
    );
  `);
  // v0.1.1: jobs remember which server process owns them.
  const cols = (db.prepare(`PRAGMA table_info(jobs)`).all() as Array<{ name: string }>).map((c) => c.name);
  if (!cols.includes("owner")) db.exec(`ALTER TABLE jobs ADD COLUMN owner INTEGER NOT NULL DEFAULT 0`);
  return db;
}

export const now = () => new Date().toISOString();

export function parseRow<T>(row: Record<string, unknown> | undefined, jsonCols: string[] = ["data"]): T | undefined {
  if (!row) return undefined;
  const out: Record<string, unknown> = { ...row };
  for (const c of jsonCols) if (typeof out[c] === "string") out[c] = JSON.parse(out[c] as string);
  return out as T;
}
