import { getDb, now, parseRow } from "./db.js";
import { StudioError } from "./errors.js";
import { newId } from "./ids.js";
import type { Probe } from "./ffprobe.js";

export interface Project {
  id: string;
  name: string;
  created: string;
  data: { brandKit?: string };
}

export interface AssetData {
  original: string; // path inside workspace
  sourcePath: string; // where it was imported from
  sha256: string;
  probe: Probe;
  proxy?: string;
  bytes: number;
}

export interface Asset {
  id: string;
  project_id: string;
  kind: "video" | "audio" | "image";
  name: string;
  created: string;
  data: AssetData;
}

export interface AnalysisRow {
  id: string;
  asset_id: string;
  kind: string;
  params_hash: string;
  path: string;
  created: string;
  summary: Record<string, unknown>;
}

export interface TimelineRow {
  id: string;
  version: number;
  project_id: string;
  name: string;
  json: any;
  created: string;
}

export interface RenderRow {
  id: string;
  project_id: string;
  timeline_id: string;
  version: number;
  quality: "draft" | "final";
  status: string;
  dir: string;
  created: string;
  data: { output?: string; exported?: string; duration?: number; planned?: number; width?: number; height?: number; qa?: unknown; jobId?: string };
}

// ---------- projects
export function getProjectByName(name: string): Project | undefined {
  return parseRow<Project>(getDb().prepare(`SELECT * FROM projects WHERE name=?`).get(name) as any);
}
export function getProject(id: string): Project {
  const p = parseRow<Project>(getDb().prepare(`SELECT * FROM projects WHERE id=?`).get(id) as any);
  if (!p) throw new StudioError("NOT_FOUND", `No project ${id}`, "Call project_open to list or create projects.");
  return p;
}
export function createProject(name: string): Project {
  const id = newId("prj");
  getDb().prepare(`INSERT INTO projects (id,name,created,data) VALUES (?,?,?,?)`).run(id, name, now(), "{}");
  return getProject(id);
}
export function listProjects(): Project[] {
  return (getDb().prepare(`SELECT * FROM projects ORDER BY created DESC`).all() as any[]).map((r) => parseRow<Project>(r)!);
}

// ---------- assets
export function insertAsset(a: Asset) {
  getDb()
    .prepare(`INSERT INTO assets (id,project_id,kind,name,created,data) VALUES (?,?,?,?,?,?)`)
    .run(a.id, a.project_id, a.kind, a.name, a.created, JSON.stringify(a.data));
}
export function updateAssetData(id: string, data: AssetData) {
  getDb().prepare(`UPDATE assets SET data=? WHERE id=?`).run(JSON.stringify(data), id);
}
export function getAsset(id: string): Asset {
  const a = parseRow<Asset>(getDb().prepare(`SELECT * FROM assets WHERE id=?`).get(id) as any);
  if (!a) throw new StudioError("NOT_FOUND", `No asset ${id}`, "Call project_open to list the project's assets.");
  return a;
}
export function listAssets(projectId: string): Asset[] {
  return (getDb().prepare(`SELECT * FROM assets WHERE project_id=? ORDER BY created`).all(projectId) as any[]).map(
    (r) => parseRow<Asset>(r)!,
  );
}
export function findAssetBySha(projectId: string, sha: string): Asset | undefined {
  return listAssets(projectId).find((a) => a.data.sha256 === sha);
}

// ---------- analyses
export function findAnalysis(assetId: string, kind: string, paramsHash?: string): AnalysisRow | undefined {
  const q = paramsHash
    ? getDb().prepare(`SELECT * FROM analyses WHERE asset_id=? AND kind=? AND params_hash=? ORDER BY created DESC`).get(assetId, kind, paramsHash)
    : getDb().prepare(`SELECT * FROM analyses WHERE asset_id=? AND kind=? ORDER BY created DESC`).get(assetId, kind);
  return parseRow<AnalysisRow>(q as any, ["summary"]);
}
export function insertAnalysis(row: AnalysisRow) {
  getDb()
    .prepare(`INSERT INTO analyses (id,asset_id,kind,params_hash,path,created,summary) VALUES (?,?,?,?,?,?,?)`)
    .run(row.id, row.asset_id, row.kind, row.params_hash, row.path, row.created, JSON.stringify(row.summary));
}
export function listAnalyses(assetId: string): AnalysisRow[] {
  return (getDb().prepare(`SELECT * FROM analyses WHERE asset_id=? ORDER BY created`).all(assetId) as any[]).map(
    (r) => parseRow<AnalysisRow>(r, ["summary"])!,
  );
}

// ---------- timelines
export function saveTimeline(projectId: string, name: string, json: unknown, id?: string): TimelineRow {
  const db = getDb();
  let tlId = id;
  let version = 1;
  if (tlId) {
    const r = db.prepare(`SELECT MAX(version) AS v FROM timelines WHERE id=?`).get(tlId) as { v: number | null };
    version = (r?.v ?? 0) + 1;
  } else {
    // Same project + same name continues the same timeline.
    const r = db
      .prepare(`SELECT id, MAX(version) AS v FROM timelines WHERE project_id=? AND name=? GROUP BY id`)
      .get(projectId, name) as { id: string; v: number } | undefined;
    if (r) {
      tlId = r.id;
      version = r.v + 1;
    } else tlId = newId("tl");
  }
  // Identical to the latest version: reuse it instead of adding a duplicate.
  if (version > 1) {
    const latest = getTimeline(tlId!, version - 1);
    if (JSON.stringify(latest.json) === JSON.stringify(json)) return latest;
  }
  db.prepare(`INSERT INTO timelines (id,version,project_id,name,json,created) VALUES (?,?,?,?,?,?)`).run(
    tlId!,
    version,
    projectId,
    name,
    JSON.stringify(json),
    now(),
  );
  return getTimeline(tlId!, version);
}
export function getTimeline(id: string, version?: number): TimelineRow {
  const row = version
    ? getDb().prepare(`SELECT * FROM timelines WHERE id=? AND version=?`).get(id, version)
    : getDb().prepare(`SELECT * FROM timelines WHERE id=? ORDER BY version DESC LIMIT 1`).get(id);
  const t = parseRow<TimelineRow>(row as any, ["json"]);
  if (!t) throw new StudioError("NOT_FOUND", `No timeline ${id}${version ? ` v${version}` : ""}`);
  return t;
}
export function listTimelines(projectId: string): Array<{ id: string; name: string; latest: number }> {
  return getDb()
    .prepare(`SELECT id, name, MAX(version) AS latest FROM timelines WHERE project_id=? GROUP BY id ORDER BY MIN(created)`)
    .all(projectId) as any;
}

// ---------- renders
export function insertRender(r: RenderRow) {
  getDb()
    .prepare(`INSERT INTO renders (id,project_id,timeline_id,version,quality,status,dir,created,data) VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(r.id, r.project_id, r.timeline_id, r.version, r.quality, r.status, r.dir, r.created, JSON.stringify(r.data));
}
export function updateRender(id: string, status: string, data: RenderRow["data"]) {
  getDb().prepare(`UPDATE renders SET status=?, data=? WHERE id=?`).run(status, JSON.stringify(data), id);
}
export function getRender(id: string): RenderRow {
  const r = parseRow<RenderRow>(getDb().prepare(`SELECT * FROM renders WHERE id=?`).get(id) as any);
  if (!r) throw new StudioError("NOT_FOUND", `No render ${id}`);
  return r;
}
export function listRenders(projectId: string): RenderRow[] {
  return (getDb().prepare(`SELECT * FROM renders WHERE project_id=? ORDER BY created`).all(projectId) as any[]).map(
    (r) => parseRow<RenderRow>(r)!,
  );
}
