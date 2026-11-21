import { getConfig } from "./config.js";
import { getDb, now, parseRow } from "./db.js";
import { asStudioError, StudioError } from "./errors.js";
import { newId } from "./ids.js";

export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";
export type Queue = "analysis" | "render" | "download";

export interface JobContext {
  jobId: string;
  signal: AbortSignal;
  /** Report a stage name and overall progress 0..1. */
  progress: (stage: string, progress: number) => void;
}

export type JobHandler = (input: any, ctx: JobContext) => Promise<unknown>;

interface JobDef {
  queue: Queue;
  handler: JobHandler;
}

export interface JobRow {
  id: string;
  type: string;
  queue: Queue;
  status: JobStatus;
  stage: string;
  progress: number;
  input: any;
  result: any;
  error: any;
  created: string;
  updated: string;
}

const defs = new Map<string, JobDef>();
const running = new Map<Queue, { id: string; ctrl: AbortController; started: number } | null>([
  ["analysis", null],
  ["render", null],
]);
const waiters = new Map<string, Array<(j: JobRow) => void>>();

export function registerJob(type: string, queue: Queue, handler: JobHandler) {
  defs.set(type, { queue, handler });
}

function alive(pid: number): boolean {
  if (!pid) return false;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Called once at startup. Several server processes can share one workspace (Claude Desktop and Claude Code at once):
 * only jobs whose owning process is gone are touched. Their running jobs are marked interrupted; their queued
 * jobs are adopted by this process.
 */
export function recoverJobs() {
  const db = getDb();
  const rows = db.prepare(`SELECT id, type, status, owner FROM jobs WHERE status IN ('running','queued')`).all() as Array<{ id: string; type: string; status: string; owner: number }>;
  for (const r of rows) {
    if (alive(r.owner)) continue;
    if (r.status === "running")
      db.prepare(`UPDATE jobs SET status='failed', error=?, updated=? WHERE id=? AND status='running'`).run(
        JSON.stringify({ code: "ENGINE_FAILED", message: "interrupted: the server stopped while this job ran. Start it again." }),
        now(),
        r.id,
      );
    // Queued jobs of a kind this version can't run are left for a server that can.
    else if (defs.has(r.type)) db.prepare(`UPDATE jobs SET owner=?, updated=? WHERE id=? AND status='queued'`).run(process.pid, now(), r.id);
  }
  setImmediate(pump);
}

export function enqueue(type: string, input: unknown): JobRow {
  const def = defs.get(type);
  if (!def) throw new Error(`Unknown job type ${type}`);
  const id = newId("job");
  const ts = now();
  getDb()
    .prepare(`INSERT INTO jobs (id,type,queue,status,stage,progress,input,created,updated,owner) VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(id, type, def.queue, "queued", "queued", 0, JSON.stringify(input), ts, ts, process.pid);
  setImmediate(pump);
  return getJob(id)!;
}

export function getJob(id: string): JobRow | undefined {
  const row = getDb().prepare(`SELECT * FROM jobs WHERE id=?`).get(id) as Record<string, unknown> | undefined;
  return parseRow<JobRow>(row, ["input", "result", "error"]);
}

export function listJobs(limit = 20): JobRow[] {
  const rows = getDb().prepare(`SELECT * FROM jobs ORDER BY created DESC LIMIT ?`).all(limit) as Record<string, unknown>[];
  return rows.map((r) => parseRow<JobRow>(r, ["input", "result", "error"])!);
}

function update(id: string, fields: Partial<Record<"status" | "stage" | "progress" | "result" | "error", unknown>>) {
  const sets: string[] = [];
  const vals: any[] = [];
  for (const [k, v] of Object.entries(fields)) {
    sets.push(`${k}=?`);
    vals.push(k === "result" || k === "error" ? JSON.stringify(v) : v);
  }
  sets.push("updated=?");
  vals.push(now());
  vals.push(id);
  getDb().prepare(`UPDATE jobs SET ${sets.join(",")} WHERE id=?`).run(...vals);
}

export function cancelJob(id: string): JobRow {
  return cancelJobDetailed(id).job;
}

export interface CancelOutcome {
  job: JobRow;
  /** true when the job was stopped or a stop was requested; false when there was nothing to cancel. */
  cancelled: boolean;
  note: string;
}

/** Cancel with an explanation of what actually happened (job_cancel shows this). */
export function cancelJobDetailed(id: string): CancelOutcome {
  const job = getJob(id);
  if (!job) throw new StudioError("NOT_FOUND", `No job ${id}`);
  if (job.status === "succeeded" || job.status === "failed" || job.status === "cancelled") {
    return { job, cancelled: false, note: `Nothing to cancel: the job had already ${job.status === "cancelled" ? "been cancelled" : job.status} (at ${job.updated}). Its results are unchanged.` };
  }
  if (job.status === "queued") {
    update(id, { status: "cancelled", stage: "cancelled" });
    return { job: getJob(id)!, cancelled: true, note: "Cancelled before it started." };
  }
  // running
  const r = running.get(job.queue);
  if (r?.id === id) {
    r.ctrl.abort();
    return { job: getJob(id)!, cancelled: true, note: "Stopping: the job is being stopped now." };
  }
  if (getConfig().features.crossProcessCancel) {
    getDb().prepare(`UPDATE jobs SET cancel_req=1, updated=? WHERE id=? AND status='running'`).run(now(), id);
    return {
      job: getJob(id)!,
      cancelled: true,
      note: "Another Talk-n-Edit server (e.g. Claude Desktop vs Claude Code) is running this job; it was asked to stop and should within a few seconds. If it keeps running, that server is an older version: restart it.",
    };
  }
  return { job, cancelled: false, note: "Another Talk-n-Edit server is running this job and cross-process cancel is switched off (features.crossProcessCancel)." };
}

/** Resolve when the job reaches a final state (used by the CLI). */
export function waitForJob(id: string): Promise<JobRow> {
  const j = getJob(id);
  if (j && ["succeeded", "failed", "cancelled"].includes(j.status)) return Promise.resolve(j);
  return new Promise((res) => {
    const arr = waiters.get(id) ?? [];
    arr.push(res);
    waiters.set(id, arr);
  });
}

export function eta(job: JobRow): number | null {
  const r = running.get(job.queue);
  if (!r || r.id !== job.id || job.progress <= 0.02) return null;
  const elapsed = (Date.now() - r.started) / 1000;
  return Math.round((elapsed / job.progress) * (1 - job.progress));
}

let pumping = false;
function pump() {
  if (pumping) return;
  pumping = true;
  try {
    for (const queue of ["analysis", "render", "download"] as Queue[]) {
      if (running.get(queue)) continue;
      // Only jobs this version knows how to run (a newer server sharing the workspace may queue new kinds).
      const types = [...defs.keys()];
      if (!types.length) continue;
      const row = getDb()
        .prepare(`SELECT id FROM jobs WHERE queue=? AND status='queued' AND owner=? AND type IN (${types.map(() => "?").join(",")}) ORDER BY created LIMIT 1`)
        .get(queue, process.pid, ...types) as { id: string } | undefined;
      if (!row) continue;
      // Atomic claim: only one process can move a job from queued to running.
      const claimed = getDb()
        .prepare(`UPDATE jobs SET status='running', stage='starting', progress=0, updated=? WHERE id=? AND status='queued'`)
        .run(now(), row.id);
      if (Number(claimed.changes) !== 1) continue;
      void start(row.id);
    }
  } finally {
    pumping = false;
  }
}

async function start(id: string) {
  const job = getJob(id)!;
  const def = defs.get(job.type)!;
  const ctrl = new AbortController();
  running.set(job.queue, { id, ctrl, started: Date.now() });
  let lastWrite = 0;
  // Watch for a cancel request from another server process (job_cancel there can't reach this AbortController).
  const watch = getConfig().features.crossProcessCancel
    ? setInterval(() => {
        try {
          const row = getDb().prepare(`SELECT cancel_req FROM jobs WHERE id=?`).get(id) as { cancel_req?: number } | undefined;
          if (row?.cancel_req) ctrl.abort();
        } catch {
          /* the database is busy; check again next tick */
        }
      }, 1000)
    : null;
  watch?.unref();
  const ctx: JobContext = {
    jobId: id,
    signal: ctrl.signal,
    progress: (stage, progress) => {
      const t = Date.now();
      if (t - lastWrite < 500 && progress < 1) return;
      lastWrite = t;
      update(id, { stage, progress: Math.max(0, Math.min(1, progress)) });
    },
  };
  try {
    const result = await def.handler(job.input, ctx);
    update(id, { status: "succeeded", stage: "done", progress: 1, result: result ?? null });
  } catch (e) {
    const err = asStudioError(e);
    if (err.code === "CANCELLED" || ctrl.signal.aborted) update(id, { status: "cancelled", stage: "cancelled" });
    else update(id, { status: "failed", stage: "failed", error: err.toJSON() });
  } finally {
    if (watch) clearInterval(watch);
    running.set(job.queue, null);
    const done = getJob(id)!;
    for (const w of waiters.get(id) ?? []) w(done);
    waiters.delete(id);
    setImmediate(pump);
  }
}
