/**
 * See and free disk space. Nothing here runs on its own: storageReport only reads, and storageClean removes
 * exactly what the user picked, and only after a dry run (apply: false) has shown what it would remove.
 * It never touches sources, analyses, timelines, finished videos (output.mp4) or anything outside the workspace.
 */
import fs from "node:fs";
import path from "node:path";
import { dirs, getConfig, WORKSPACE } from "./config.js";
import { StudioError } from "./errors.js";
import { CacheEntry, fmtBytes, listCache } from "./gcache.js";
import { getProjectByName, listProjects, listRenders, listTimelines } from "./store.js";

const DAY = 24 * 3600 * 1000;

function bytesOf(p: string): number {
  try {
    const st = fs.statSync(p);
    if (!st.isDirectory()) return st.size;
    let t = 0;
    for (const n of fs.readdirSync(p)) t += bytesOf(path.join(p, n));
    return t;
  } catch {
    return 0;
  }
}

/** Files a finished render no longer needs: drawn graphic frames, cut batches and the pre-mix video. */
function renderLeftovers(dir: string): string[] {
  const inside = path.relative(dirs.projects(), path.resolve(dir));
  if (!inside || inside.startsWith("..") || path.isAbsolute(inside)) return [];
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names.filter((n) => /^graphic-/.test(n) || /^batch-\d+\.mkv$/.test(n) || n === "pre.mkv").map((n) => path.join(dir, n));
}

interface RenderLeftover {
  project: string;
  timeline: string;
  renderId: string;
  status: string;
  files: string[];
  bytes: number;
}

function leftovers(projectName?: string, timelineName?: string): RenderLeftover[] {
  const projects = projectName ? [requireProject(projectName)] : listProjects();
  const out: RenderLeftover[] = [];
  for (const p of projects) {
    const names = new Map(listTimelines(p.id).map((t) => [t.id, t.name]));
    for (const r of listRenders(p.id)) {
      if (r.status === "queued" || r.status === "running") continue;
      const tl = names.get(r.timeline_id) ?? r.timeline_id;
      if (timelineName && tl !== timelineName) continue;
      const files = renderLeftovers(r.dir ?? dirs.render(p.id, r.id));
      if (!files.length) continue;
      out.push({ project: p.name, timeline: tl, renderId: r.id, status: r.status, files, bytes: files.reduce((s, f) => s + bytesOf(f), 0) });
    }
  }
  return out;
}

function requireProject(name: string) {
  const p = getProjectByName(name);
  if (!p) throw new StudioError("NOT_FOUND", `No project named "${name}"`, "project_open with no name lists the projects.");
  return p;
}

const users = (e: CacheEntry) => (e.usedBy.length ? e.usedBy : [{ project: "(unknown)", timeline: "(unknown)" }]);

export function storageReport() {
  const cache = listCache();
  const cacheTotal = cache.reduce((s, e) => s + e.bytes, 0);
  const byUse = new Map<string, { project: string; timeline: string; entries: number; bytes: number; lastUsed: string }>();
  for (const e of cache) {
    for (const u of users(e)) {
      const k = `${u.project}\u0000${u.timeline}`;
      const g = byUse.get(k) ?? { project: u.project, timeline: u.timeline, entries: 0, bytes: 0, lastUsed: e.lastUsed };
      g.entries++;
      g.bytes += e.bytes;
      if (e.lastUsed > g.lastUsed) g.lastUsed = e.lastUsed;
      byUse.set(k, g);
    }
  }
  const age = (days: number) => cache.filter((e) => Date.now() - Date.parse(e.lastUsed) > days * DAY);
  const sum = (l: CacheEntry[]) => l.reduce((s, e) => s + e.bytes, 0);
  const lo = leftovers();
  const loByProject = new Map<string, { project: string; renders: number; bytes: number }>();
  for (const l of lo) {
    const g = loByProject.get(l.project) ?? { project: l.project, renders: 0, bytes: 0 };
    g.renders++;
    g.bytes += l.bytes;
    loByProject.set(l.project, g);
  }
  const bundles = bytesOf(path.join(WORKSPACE, "cache", "remotion"));
  const warn = Number(getConfig().features.graphicsCacheWarnGB);
  return {
    graphicsCache: {
      total: fmtBytes(cacheTotal),
      entries: cache.length,
      warnAt: warn > 0 ? `${warn} GB` : "off",
      notUsedFor7Days: fmtBytes(sum(age(7))),
      notUsedFor30Days: fmtBytes(sum(age(30))),
      byReel: [...byUse.values()]
        .sort((a, b) => b.bytes - a.bytes)
        .map((g) => ({ project: g.project, timeline: g.timeline, graphics: g.entries, size: fmtBytes(g.bytes), lastUsed: g.lastUsed.slice(0, 16).replace("T", " ") })),
      note: "A graphic shared by several Reels is listed under each of them. Removing one only means it is drawn again if a render needs it.",
    },
    oldRenderFiles: {
      total: fmtBytes(lo.reduce((s, l) => s + l.bytes, 0)),
      byProject: [...loByProject.values()].sort((a, b) => b.bytes - a.bytes).map((g) => ({ project: g.project, renders: g.renders, size: fmtBytes(g.bytes) })),
      note: "Drawn frames and in-between video files that finished renders no longer need. The finished videos are not included.",
    },
    graphicsCodeCache: { size: fmtBytes(bundles), note: "Compiled graphics code (cache/remotion). Not removable here yet." },
  };
}

export interface CleanArgs {
  what: "graphicsCache" | "renderFiles";
  project?: string;
  timeline?: string;
  notUsedForDays?: number;
  apply?: boolean;
}

export function storageClean(a: CleanArgs) {
  if (a.timeline && !a.project) throw new StudioError("INVALID_INPUT", "Give the project too when picking a timeline.");
  if (a.project) requireProject(a.project);
  const apply = a.apply === true;
  if (a.what === "renderFiles") {
    if (a.notUsedForDays !== undefined) throw new StudioError("INVALID_INPUT", "notUsedForDays is for graphicsCache; for renderFiles pick a project or timeline.");
    const list = leftovers(a.project, a.timeline);
    let freed = 0;
    let removed = 0;
    if (apply)
      for (const l of list)
        for (const f of l.files) {
          const b = bytesOf(f);
          fs.rmSync(f, { recursive: true, force: true });
          freed += b;
          removed++;
        }
    return {
      applied: apply,
      renders: list.length,
      size: fmtBytes(list.reduce((s, l) => s + l.bytes, 0)),
      freed: apply ? fmtBytes(freed) : undefined,
      items: removed || undefined,
      byReel: summarize(list.map((l) => ({ project: l.project, timeline: l.timeline, bytes: l.bytes }))),
      next: apply ? undefined : "Nothing removed yet. Call again with apply: true to remove these.",
    };
  }
  const cutoff = a.notUsedForDays !== undefined ? Date.now() - a.notUsedForDays * DAY : Infinity;
  const pick = listCache().filter((e) => {
    if (e.inUse) return false;
    if (Date.parse(e.lastUsed) > cutoff) return false;
    if (!a.project) return true;
    return users(e).some((u) => u.project === a.project && (!a.timeline || u.timeline === a.timeline));
  });
  const skippedInUse = listCache().filter((e) => e.inUse).length;
  let freed = 0;
  if (apply)
    for (const e of pick) {
      fs.rmSync(e.dir, { recursive: true, force: true });
      freed += e.bytes;
    }
  return {
    applied: apply,
    graphics: pick.length,
    size: fmtBytes(pick.reduce((s, e) => s + e.bytes, 0)),
    freed: apply ? fmtBytes(freed) : undefined,
    skippedInUse: skippedInUse || undefined,
    byReel: summarize(pick.flatMap((e) => users(e).map((u) => ({ ...u, bytes: e.bytes })))),
    next: apply ? undefined : "Nothing removed yet. Call again with apply: true to remove these.",
  };
}

function summarize(rows: Array<{ project: string; timeline: string; bytes: number }>) {
  const m = new Map<string, { project: string; timeline: string; bytes: number }>();
  for (const r of rows) {
    const k = `${r.project}\u0000${r.timeline}`;
    const g = m.get(k) ?? { project: r.project, timeline: r.timeline, bytes: 0 };
    g.bytes += r.bytes;
    m.set(k, g);
  }
  return [...m.values()].sort((a, b) => b.bytes - a.bytes).slice(0, 40).map((g) => ({ project: g.project, timeline: g.timeline, size: fmtBytes(g.bytes) }));
}
