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
import { GraphicSpec, graphicKey, renderGraphic } from "./remotion.js";

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
