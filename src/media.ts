import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { dirs, getConfig } from "./config.js";
import { now } from "./db.js";
import { StudioError } from "./errors.js";
import { ffmpeg, r3 } from "./ffmpeg.js";
import { probe } from "./ffprobe.js";
import { newId } from "./ids.js";
import type { JobContext } from "./jobs.js";
import { resolveReadable } from "./paths.js";
import { Asset, findAssetBySha, getAsset, getProject, insertAsset, updateAssetData } from "./store.js";

const VIDEO_EXT = new Set([".mp4", ".mov", ".m4v", ".mkv", ".webm", ".avi", ".mts", ".m2ts", ".3gp"]);
const AUDIO_EXT = new Set([".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg", ".opus"]);
const IMAGE_EXT = new Set([".jpg", ".jpeg", ".png", ".webp", ".heic", ".bmp", ".tif", ".tiff"]);

async function sha256(file: string, signal: AbortSignal): Promise<string> {
  return new Promise((res, rej) => {
    const h = crypto.createHash("sha256");
    const s = fs.createReadStream(file, { highWaterMark: 4 * 1024 * 1024 });
    signal.addEventListener("abort", () => s.destroy(new StudioError("CANCELLED", "Cancelled")));
    s.on("data", (d) => h.update(d));
    s.on("error", rej);
    s.on("end", () => res(h.digest("hex")));
  });
}

/** Expand folders into media files (one level deep). */
export function expandPaths(paths: string[]): string[] {
  const out: string[] = [];
  for (const p of paths) {
    const real = resolveReadable(p);
    if (fs.statSync(real).isDirectory()) {
      for (const f of fs.readdirSync(real).sort()) {
        const ext = path.extname(f).toLowerCase();
        if (f.startsWith(".")) continue;
        if (VIDEO_EXT.has(ext) || AUDIO_EXT.has(ext) || IMAGE_EXT.has(ext)) out.push(path.join(real, f));
      }
    } else out.push(real);
  }
  return out;
}

export interface ImportInput {
  projectId: string;
  paths: string[];
}

export async function importJob(input: ImportInput, ctx: JobContext) {
  getProject(input.projectId);
  const files = expandPaths(input.paths);
  if (!files.length) throw new StudioError("INVALID_INPUT", "No media files found in the given paths.");
  const results: any[] = [];
  const maxBytes = getConfig().limits.maxImportGB * 1024 ** 3;
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const base = i / files.length;
    const step = 1 / files.length;
    ctx.progress(`hashing ${path.basename(file)}`, base);
    const stat = fs.statSync(file);
    if (stat.size > maxBytes)
      throw new StudioError("LIMIT_EXCEEDED", `${path.basename(file)} is ${(stat.size / 1024 ** 3).toFixed(1)} GB; limit is ${getConfig().limits.maxImportGB} GB`);
    const sha = await sha256(file, ctx.signal);
    const existing = findAssetBySha(input.projectId, sha);
    if (existing) {
      results.push(summarizeAsset(existing, true));
      continue;
    }
    const ext = path.extname(file).toLowerCase();
    const kind: Asset["kind"] = IMAGE_EXT.has(ext) ? "image" : AUDIO_EXT.has(ext) ? "audio" : "video";
    const id = newId("ast");
    const dir = dirs.source(input.projectId, id);
    fs.mkdirSync(dir, { recursive: true });
    const original = path.join(dir, `original${ext}`);
    ctx.progress(`copying ${path.basename(file)}`, base + step * 0.1);
    await fs.promises.copyFile(file, original, fs.constants.COPYFILE_FICLONE);
    fs.chmodSync(original, 0o444);
    const pr = await probe(original);
    if (kind === "video" && !pr.hasVideo) throw new StudioError("INVALID_INPUT", `${path.basename(file)} has no video stream`);
    const asset: Asset = {
      id,
      project_id: input.projectId,
      kind: kind === "video" && !pr.hasVideo && pr.hasAudio ? "audio" : kind,
      name: path.basename(file),
      created: now(),
      data: { original, sourcePath: file, sha256: sha, probe: pr, bytes: stat.size },
    };
    insertAsset(asset);
    if (asset.kind === "video") {
      ctx.progress(`making proxy for ${asset.name}`, base + step * 0.2);
      const proxy = path.join(dir, "proxy.mp4");
      await ffmpeg(
        [
          "-i", original,
          "-map", "0:v:0", "-map", "0:a:0?",
          "-vf", "scale=-2:540:flags=bicubic,format=yuv420p",
          "-c:v", "libx264", "-preset", "ultrafast", "-crf", "26", "-g", "30",
          "-c:a", "aac", "-b:a", "96k", "-ac", "2",
          proxy,
        ],
        {
          duration: pr.duration,
          signal: ctx.signal,
          label: "ffmpeg proxy",
          onProgress: (f) => ctx.progress(`making proxy for ${asset.name}`, base + step * (0.2 + 0.8 * f)),
        },
      );
      asset.data.proxy = proxy;
      updateAssetData(id, asset.data);
    }
    results.push(summarizeAsset(asset, false));
  }
  return { assets: results };
}

export function summarizeAsset(a: Asset, alreadyImported = false) {
  const p = a.data.probe;
  return {
    assetId: a.id,
    name: a.name,
    kind: a.kind,
    duration: r3(p.duration),
    size: p.hasVideo ? `${p.width}x${p.height}` : undefined,
    fps: p.hasVideo ? p.avgFps : undefined,
    hasAudio: p.hasAudio,
    vfr: p.vfr || undefined,
    alreadyImported: alreadyImported || undefined,
  };
}

/** Best file to read for a given purpose. */
export function assetSource(a: Asset, draft = false): string {
  if (draft && a.data.proxy && fs.existsSync(a.data.proxy)) return a.data.proxy;
  return a.data.original;
}

function fmtTime(t: number) {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, "0")}`;
}

/** Grab single frames as JPEGs; returns paths. */
export async function grabFrames(file: string, times: number[], outDir: string, width = 512, signal?: AbortSignal) {
  fs.mkdirSync(outDir, { recursive: true });
  const outs: string[] = [];
  for (let i = 0; i < times.length; i++) {
    const out = path.join(outDir, `f${String(i).padStart(2, "0")}.jpg`);
    await ffmpeg(
      ["-ss", String(r3(Math.max(0, times[i]))), "-i", file, "-frames:v", "1", "-vf", `scale=${width}:-2`, "-q:v", "4", out],
      { signal, label: "ffmpeg frame" },
    );
    outs.push(out);
  }
  return outs;
}

/** 4x3 contact sheet of evenly spaced frames. Returns {path, times}. */
export async function contactSheet(file: string, duration: number, outPath: string, signal?: AbortSignal) {
  const n = 12;
  const times = Array.from({ length: n }, (_, i) => ((i + 0.5) * duration) / n);
  // Scratch frames live next to the sheet and are overwritten next time (the toolkit never deletes files).
  const scratch = `${outPath}.frames`;
  await grabFrames(file, times, scratch, 320, signal);
  await ffmpeg(
    ["-framerate", "1", "-i", path.join(scratch, "f%02d.jpg"), "-vf", "scale=320:-2,tile=4x3:padding=4:color=black", "-frames:v", "1", "-q:v", "4", outPath],
    { signal, label: "ffmpeg contact sheet" },
  );
  return { path: outPath, times: times.map(fmtTime) };
}

export function readImageB64(p: string) {
  return { type: "image" as const, data: fs.readFileSync(p).toString("base64"), mimeType: "image/jpeg" };
}

export function assetOrThrow(id: string) {
  return getAsset(id);
}
