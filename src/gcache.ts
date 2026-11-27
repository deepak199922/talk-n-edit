/**
 * Shared cache of drawn graphics (transparent PNG frames from Remotion).
 *
 * Every graphic in a render used to be drawn again into that render's own folder. Now each one is drawn once into
 * cache/graphics/<key>, where the key covers everything that can change its pixels (see graphicKey), and any later
 * render that needs the same graphic reuses those frames: a fix to one overlay redraws only that overlay.
 *
 * Nothing here deletes on its own. The cache is never trimmed automatically; renders only warn when it grows past
 * features.graphicsCacheWarnGB, and storageReport / storageClean let the user see and pick what to remove.
 * Switch: features.graphicsCache (false = draw into the render folder exactly as before).
 */
import fs from "node:fs";
import path from "node:path";
import { getConfig, WORKSPACE } from "./config.js";
import { StudioError } from "./errors.js";
import { GraphicSpec, graphicKey, renderGraphic, renderStack, StackLayer, stackKey } from "./remotion.js";

export const graphicsCacheDir = () => path.join(WORKSPACE, "cache", "graphics");
const META = "meta.json";
/** Entries used this recently may belong to a render that is still running; cleaning skips them. */
const IN_USE_MS = 6 * 3600 * 1000;

export interface UsedBy {
  project: string;
  timeline: string;
}
export interface CacheMeta {
  key: string;
  component: string;
  pattern: string;
  frames: number;
  bytes: number;
  created: string;
  lastUsed: string;
  usedBy: UsedBy[];
}
export interface Drawn {
  dir: string;
  pattern: string;
  frames: number;
  cached: boolean;
}

const frameName = (pattern: string, i: number) => pattern.replace(/%0(\d+)d/, (_, n) => String(i).padStart(Number(n), "0"));

function readMeta(dir: string): CacheMeta | null {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(dir, META), "utf8")) as CacheMeta;
    if (!m || typeof m.pattern !== "string" || !(m.frames > 0)) return null;
    return { ...m, usedBy: Array.isArray(m.usedBy) ? m.usedBy : [] };
  } catch {
    return null;
  }
}

function writeMeta(dir: string, m: CacheMeta) {
  const tmp = path.join(dir, `${META}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(m));
  fs.renameSync(tmp, path.join(dir, META));
}

/** A cache entry is usable only if its first and last frame are still on disk. */
function usable(dir: string): CacheMeta | null {
  const m = readMeta(dir);
  if (!m) return null;
  if (!fs.existsSync(path.join(dir, frameName(m.pattern, 0)))) return null;
  if (!fs.existsSync(path.join(dir, frameName(m.pattern, m.frames - 1)))) return null;
  return m;
}

function touch(dir: string, m: CacheMeta, who?: UsedBy) {
  try {
    const usedBy = [...m.usedBy];
    if (who && !usedBy.some((u) => u.project === who.project && u.timeline === who.timeline)) usedBy.push(who);
    writeMeta(dir, { ...m, lastUsed: new Date().toISOString(), usedBy: usedBy.slice(-50) });
  } catch {
    /* bookkeeping only */
  }
}

function dirBytes(dir: string): number {
  let total = 0;
  for (const n of fs.readdirSync(dir)) {
    try {
      const st = fs.statSync(path.join(dir, n));
      total += st.isDirectory() ? dirBytes(path.join(dir, n)) : st.size;
    } catch {
      /* gone meanwhile */
    }
  }
  return total;
}

const isCancel = (e: unknown) => e instanceof StudioError && e.code === "CANCELLED";

/**
 * Draw a graphic, reusing cached frames when the same graphic was drawn before.
 * With the cache switched off, or if anything about the cache itself goes wrong, it draws into `fallbackDir`
 * exactly as before. Errors from drawing the graphic are reported as before.
 */
export async function drawGraphic(
  spec: GraphicSpec,
  fallbackDir: string,
  who: UsedBy | undefined,
  signal?: AbortSignal,
  onProgress?: (f: number) => void,
): Promise<Drawn> {
  const plain = async (): Promise<Drawn> => ({ dir: fallbackDir, ...(await renderGraphic(spec, fallbackDir, signal, onProgress)), cached: false });
  if (getConfig().features.graphicsCache === false) return plain();

  let final: string;
  try {
    const key = await graphicKey(spec);
    final = path.join(graphicsCacheDir(), key);
    const hit = usable(final);
    if (hit) {
      touch(final, hit, who);
      onProgress?.(1);
      return { dir: final, pattern: hit.pattern, frames: hit.frames, cached: true };
    }
  } catch (e) {
    if (isCancel(e)) throw e;
    return plain(); // e.g. an unknown custom effect: the plain path reports it the usual way
  }

  // Draw into a private folder, then move it into place in one step, so a half-drawn graphic is never reused.
  const part = `${final}.part-${process.pid}-${Date.now()}`;
  let r: { pattern: string; frames: number };
  try {
    r = await renderGraphic(spec, part, signal, onProgress);
  } catch (e) {
    try {
      fs.rmSync(part, { recursive: true, force: true });
    } catch {
      /* leftover .part folders are listed by storageReport */
    }
    throw e;
  }
  try {
    const stamp = new Date().toISOString();
    writeMeta(part, {
      key: path.basename(final),
      component: spec.component,
      pattern: r.pattern,
      frames: r.frames,
      bytes: dirBytes(part),
      created: stamp,
      lastUsed: stamp,
      usedBy: who ? [who] : [],
    });
    try {
      fs.renameSync(part, final);
    } catch {
      // Another render (or the other Claude app) finished the same graphic first: use that one.
      const other = usable(final);
      if (!other) throw new Error("cache entry not usable");
      touch(final, other, who);
      fs.rmSync(part, { recursive: true, force: true });
      return { dir: final, pattern: other.pattern, frames: other.frames, cached: true };
    }
    return { dir: final, pattern: r.pattern, frames: r.frames, cached: false };
  } catch {
    // The frames in `part` are good; only the bookkeeping failed. Use them where they are.
    return { dir: part, pattern: r.pattern, frames: r.frames, cached: false };
  }
}

// ------------------------------------------------------------------ several graphics at once

export interface GraphicJob {
  spec: GraphicSpec;
  /** Timeline seconds where the graphic's frame 0 shows. */
  start: number;
  layer: number;
  fallbackDir: string;
  label: string;
}
export interface DrawnInput extends Drawn {
  start: number;
  layer: number;
  /** How many of the requested graphics this input carries (a stack carries several). */
  members: number;
}

/**
 * Draw all graphics of a render. Returns inputs in stacking order (bottom first, same order ffmpeg would use).
 * With features.graphicsOnePass, graphics that are next to each other in that order and not cached yet are drawn
 * together in one Remotion pass (one browser screenshot per frame instead of one per graphic per frame) and cached
 * as one entry. Any problem with a stack falls back to drawing its graphics one by one.
 */
export async function drawGraphics(jobs: GraphicJob[], who: UsedBy | undefined, signal?: AbortSignal, onProgress?: (label: string, f: number) => void): Promise<{ inputs: DrawnInput[]; reused: number }> {
  const sorted = jobs.map((j, i) => ({ j, i })).sort((p, q) => p.j.layer - q.j.layer || p.i - q.i).map((x) => x.j);
  const f = getConfig().features;
  const out: DrawnInput[] = [];
  let reused = 0;
  const total = sorted.length || 1;
  let doneCount = 0;
  const one = async (j: GraphicJob) => {
    const r = await drawGraphic(j.spec, j.fallbackDir, who, signal, (x) => onProgress?.(j.label, (doneCount + x) / total));
    doneCount++;
    if (r.cached) reused++;
    out.push({ ...r, start: j.start, layer: j.layer, members: 1 });
  };
  if (f.graphicsCache === false || f.graphicsOnePass === false || sorted.length < 2) {
    for (const j of sorted) await one(j);
    return { inputs: out, reused };
  }
  // Which graphics are already cached on their own?
  const hit: Array<CacheMeta | null> = [];
  for (const j of sorted) {
    try {
      hit.push(usable(path.join(graphicsCacheDir(), await graphicKey(j.spec))));
    } catch (e) {
      if (isCancel(e)) throw e;
      hit.push(null);
    }
  }
  const sameKind = (a: GraphicSpec, b: GraphicSpec) => a.width === b.width && a.height === b.height && a.fps === b.fps && JSON.stringify(a.brand) === JSON.stringify(b.brand);
  let i = 0;
  while (i < sorted.length) {
    if (hit[i]) {
      await one(sorted[i]);
      i++;
      continue;
    }
    let k = i + 1;
    while (k < sorted.length && !hit[k] && sameKind(sorted[i].spec, sorted[k].spec)) k++;
    const run = sorted.slice(i, k);
    i = k;
    if (run.length < 2) {
      await one(run[0]);
      continue;
    }
    try {
      const d = await drawStack(run, who, signal, (x) => onProgress?.(`${run.length} graphics in one pass`, (doneCount + x * run.length) / total));
      doneCount += run.length;
      if (d.cached) reused += run.length;
      out.push(d);
    } catch (e) {
      if (isCancel(e)) throw e;
      for (const j of run) await one(j); // reports the real error if one of them is broken
    }
  }
  return { inputs: out, reused };
}

async function drawStack(run: GraphicJob[], who: UsedBy | undefined, signal?: AbortSignal, onProgress?: (f: number) => void): Promise<DrawnInput> {
  const fps = run[0].spec.fps;
  const t0 = Math.min(...run.map((j) => j.start));
  // Same placement ffmpeg uses for a single graphic (frame 0 at floor(start × fps)), so stacking changes no timing.
  const startFrame = (s: number) => Math.floor(s * fps + 1e-6);
  const layers: StackLayer[] = run.map((j) => ({ spec: j.spec, from: Math.max(0, startFrame(j.start) - startFrame(t0)) }));
  const frames = Math.max(...layers.map((l) => l.from + l.spec.frames));
  const key = await stackKey(layers, frames);
  const final = path.join(graphicsCacheDir(), key);
  const base = { start: t0, layer: run[0].layer, members: run.length };
  const h = usable(final);
  if (h) {
    touch(final, h, who);
    onProgress?.(1);
    return { dir: final, pattern: h.pattern, frames: h.frames, cached: true, ...base };
  }
  const part = `${final}.part-${process.pid}-${Date.now()}`;
  let r: { pattern: string; frames: number };
  try {
    r = await renderStack(layers, frames, part, signal, onProgress);
  } catch (e) {
    try {
      fs.rmSync(part, { recursive: true, force: true });
    } catch {
      /* listed by storageReport */
    }
    throw e;
  }
  const stamp = new Date().toISOString();
  writeMeta(part, { key, component: `stack: ${run.map((j) => j.spec.component).join(" + ")}`, pattern: r.pattern, frames: r.frames, bytes: dirBytes(part), created: stamp, lastUsed: stamp, usedBy: who ? [who] : [] });
  try {
    fs.renameSync(part, final);
  } catch {
    const other = usable(final);
    if (other) {
      fs.rmSync(part, { recursive: true, force: true });
      return { dir: final, pattern: other.pattern, frames: other.frames, cached: true, ...base };
    }
    return { dir: part, pattern: r.pattern, frames: r.frames, cached: false, ...base };
  }
  return { dir: final, pattern: r.pattern, frames: r.frames, cached: false, ...base };
}

// ------------------------------------------------------------------ size, report and clean-up

export interface CacheEntry extends CacheMeta {
  dir: string;
  inUse: boolean;
}

/** Everything in the graphics cache, newest use first. Unfinished `.part` folders are listed with component "(unfinished)". */
export function listCache(): CacheEntry[] {
  const base = graphicsCacheDir();
  let names: string[] = [];
  try {
    names = fs.readdirSync(base);
  } catch {
    return [];
  }
  const out: CacheEntry[] = [];
  const nowMs = Date.now();
  for (const n of names) {
    const dir = path.join(base, n);
    try {
      if (!fs.statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    const m = readMeta(dir);
    if (m && !n.includes(".part-")) {
      out.push({ ...m, dir, inUse: nowMs - Date.parse(m.lastUsed) < IN_USE_MS });
    } else {
      const st = fs.statSync(dir);
      const stamp = st.mtime.toISOString();
      out.push({ key: n, component: "(unfinished)", pattern: "", frames: 0, bytes: dirBytes(dir), created: stamp, lastUsed: stamp, usedBy: [], dir, inUse: nowMs - st.mtimeMs < IN_USE_MS });
    }
  }
  return out.sort((a, b) => Date.parse(b.lastUsed) - Date.parse(a.lastUsed));
}

export function cacheBytes(): number {
  return listCache().reduce((s, e) => s + e.bytes, 0);
}

const GB = 1024 ** 3;
export const fmtBytes = (b: number) => (b >= GB ? `${(b / GB).toFixed(1)} GB` : `${Math.round(b / 1024 ** 2)} MB`);

/** A note for render results when the cache is bigger than features.graphicsCacheWarnGB (0 = never warn). */
export function cacheWarning(): string | undefined {
  const f = getConfig().features;
  const warn = Number(f.graphicsCacheWarnGB);
  if (f.graphicsCache === false || !(warn > 0)) return undefined;
  const b = cacheBytes();
  if (b < warn * GB) return undefined;
  return `The graphics cache is ${fmtBytes(b)} (warning set at ${warn} GB). Nothing is removed automatically: run storage_report to see what it holds and storage_clean to remove what you no longer need.`;
}
