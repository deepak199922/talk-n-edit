import fs from "node:fs";
import path from "node:path";
import { analyzeJob, AnalysisKind, transcriptText } from "./analysis.js";
import { catalog } from "./catalog.js";
import { APP_ROOT, dirs, ffmpegBin, ffprobeBin, getConfig, LIBRARY, PYTHON_DIR, pythonBin, WORKSPACE } from "./config.js";
import { StudioError } from "./errors.js";
import { r3 } from "./ffmpeg.js";
import { cancelJob, enqueue, eta, getJob, JobRow, recoverJobs, registerJob, waitForJob } from "./jobs.js";
import { contactSheet, expandPaths, grabFrames, importJob, summarizeAsset } from "./media.js";
import { run } from "./proc.js";
import { Browser, discoverVideos, DiscoverInput, linkInfo, sourceFor, urlImportJob, validateUrl } from "./web.js";
import { qaJob } from "./qa.js";
import { renderJob, startRender } from "./render.js";
import { parseTimeline, previewText, resolveTimeline } from "./resolve.js";
import * as store from "./store.js";

let booted = false;
export function boot() {
  if (booted) return;
  booted = true;
  getConfig();
  registerJob("import", "analysis", importJob);
  registerJob("analyze", "analysis", analyzeJob);
  registerJob("render", "render", renderJob);
  registerJob("qa", "analysis", qaJob);
  registerJob("download", "download", urlImportJob);
  recoverJobs();
}

// ------------------------------------------------------------ jobs
export function jobView(j: JobRow) {
  return {
    jobId: j.id,
    type: j.type,
    status: j.status,
    stage: j.stage,
    progress: Math.round(j.progress * 100) / 100,
    etaSeconds: j.status === "running" ? eta(j) : undefined,
    result: j.status === "succeeded" ? j.result : undefined,
    error: j.status === "failed" ? j.error : undefined,
  };
}

/** Wait up to `seconds` for all jobs to finish, then return their views. */
export async function waitJobs(ids: string[], seconds: number) {
  const deadline = Date.now() + Math.max(0, Math.min(45, seconds)) * 1000;
  for (;;) {
    const jobs = ids.map((id) => {
      const j = getJob(id);
      if (!j) throw new StudioError("NOT_FOUND", `No job ${id}`);
      return j;
    });
    const done = jobs.every((j) => ["succeeded", "failed", "cancelled"].includes(j.status));
    if (done || Date.now() >= deadline) return jobs.map(jobView);
    await new Promise((r) => setTimeout(r, 1000));
  }
}

export { cancelJob, waitForJob };

// ------------------------------------------------------------ projects
export function projectOpen(name?: string, create = true) {
  if (!name) {
    return {
      projects: store.listProjects().map((p) => ({ projectId: p.id, name: p.name, created: p.created, assets: store.listAssets(p.id).length })),
      hint: "Call project_open with a name to open or create one.",
    };
  }
  let p = store.getProjectByName(name);
  let created = false;
  if (!p) {
    if (!create) throw new StudioError("NOT_FOUND", `No project named "${name}"`);
    p = store.createProject(name);
    created = true;
  }
  const assets = store.listAssets(p.id).map((a) => ({
    ...summarizeAsset(a),
    analyses: Object.fromEntries(store.listAnalyses(a.id).map((x) => [x.kind, x.summary])),
  }));
  const renders = store.listRenders(p.id).slice(-15).map((r) => ({
    renderId: r.id, timelineId: r.timeline_id, version: r.version, quality: r.quality, status: r.status,
    output: r.data.output, exported: r.data.exported, duration: r.data.duration,
  }));
  return { projectId: p.id, name: p.name, created, assets, timelines: store.listTimelines(p.id), renders, exportDir: getConfig().exportDir };
}

// ------------------------------------------------------------ media
export function mediaImport(projectId: string, paths: string[]) {
  store.getProject(projectId);
  if (!paths.length) throw new StudioError("INVALID_INPUT", "paths is empty");
  // Check paths now so mistakes come back immediately instead of inside the job.
  const files = expandPaths(paths);
  if (!files.length) throw new StudioError("INVALID_INPUT", "No media files found in the given paths.", "Supported: video (mp4, mov, mkv…), audio (mp3, wav, m4a…), images (jpg, png, webp, heic).");
  return enqueue("import", { projectId, paths });
}

/** Download a video from a link (YouTube, Twitch, Instagram, Vimeo, X, …) into the Inbox and import it. */
export function mediaImportUrl(projectId: string, url: string, opts: { start?: number; end?: number; maxHeight?: number; cookiesFromBrowser?: Browser } = {}) {
  store.getProject(projectId);
  validateUrl(url);
  if (opts.start !== undefined && opts.end !== undefined && opts.end <= opts.start) throw new StudioError("INVALID_INPUT", `"end" (${opts.end}) must be after "start" (${opts.start}).`);
  return enqueue("download", { projectId, url, ...opts });
}

/** Look at a link without downloading it (chapters, most-replayed moments, length, views). */
export async function linkInfoGet(url: string, cookiesFromBrowser?: Browser) {
  return linkInfo(url, cookiesFromBrowser);
}

/** Search YouTube, list a channel's videos/Shorts, or a Twitch streamer's top clips. */
export async function discover(d: DiscoverInput) {
  return discoverVideos(d);
}

export async function mediaInspect(assetId: string, wantSheet = true) {
  const a = store.getAsset(assetId);
  const info = {
    ...summarizeAsset(a),
    sourcePath: a.data.sourcePath,
    probe: a.data.probe,
    analyses: Object.fromEntries(store.listAnalyses(a.id).map((x) => [x.kind, x.summary])),
  };
  let sheet: { path: string; times: string[] } | undefined;
  if (wantSheet && a.kind !== "audio") {
    const out = path.join(dirs.source(a.project_id, a.id), "contact.jpg");
    if (a.kind === "image") sheet = { path: a.data.original, times: [] };
    else sheet = await contactSheet(a.data.proxy ?? a.data.original, a.data.probe.duration, out);
  }
  return { info, sheet };
}

export function analyze(input: { assetId: string; include: AnalysisKind[]; language?: string; model?: string; prompt?: string; force?: boolean }) {
  store.getAsset(input.assetId);
  if (!input.include.length) throw new StudioError("INVALID_INPUT", "include must name at least one of transcript, scenes, faces");
  return enqueue("analyze", input);
}

export function transcriptGet(assetId: string, opts: { start?: number; end?: number; format?: "compact" | "words"; page?: number }) {
  const a = store.getAsset(assetId);
  const t = transcriptText(a, opts);
  return `${t.header}\n${t.body}${t.pages > (opts.page ?? 1) ? `\n… more on page ${(opts.page ?? 1) + 1}` : ""}`;
}

export async function framesGet(opts: { assetId?: string; renderId?: string; times: number[]; width?: number }) {
  if (!opts.times.length || opts.times.length > 12) throw new StudioError("INVALID_INPUT", "times must have 1–12 entries");
  let file: string;
  let dir: string;
  let dur: number;
  if (opts.renderId) {
    const r = store.getRender(opts.renderId);
    if (!r.data.output) throw new StudioError("INVALID_INPUT", `Render ${r.id} has no output yet (${r.status})`);
    file = r.data.output;
    dir = path.join(r.dir, "frames");
    dur = Math.min(r.data.duration ?? 0, r.data.planned ?? Infinity);
  } else if (opts.assetId) {
    const a = store.getAsset(opts.assetId);
    if (a.kind !== "video") throw new StudioError("INVALID_INPUT", "frames_get works on video assets and renders");
    file = a.data.original;
    dir = path.join(dirs.source(a.project_id, a.id), "frames");
    dur = a.data.probe.duration;
  } else throw new StudioError("INVALID_INPUT", "Give assetId or renderId");
  const times = opts.times.map((t) => Math.max(0, Math.min(t, Math.max(0, dur - 0.1))));
  const files = await grabFrames(file, times, dir, Math.min(1024, Math.max(160, opts.width ?? 512)));
  return files.map((f, i) => ({ path: f, t: r3(times[i]) }));
}

export { catalog };

// ------------------------------------------------------------ timelines
export function timelineValidate(json: any, save = true) {
  const tl = parseTimeline(json);
  store.getProject(tl.projectId);
  const res = resolveTimeline(tl, "final");
  let saved: { timelineId: string; version: number } | undefined;
  if (save) {
    const row = store.saveTimeline(tl.projectId, tl.name, tl);
    saved = { timelineId: row.id, version: row.version };
  }
  return {
    valid: true,
    ...saved,
    duration: res.duration,
    output: `${res.width}x${res.height}@${res.fps} ${res.aspect} (${res.platform})`,
    clips: res.clipsSummary,
    segments: res.segments.length,
    captions: res.captions ? { preset: res.captions.preset.id, words: res.captions.words.length } : undefined,
    overlays: res.overlays.map((o) => ({ id: o.id, component: o.component, start: o.start, end: o.end })),
    spokenText: previewText(res),
    warnings: res.warnings,
  };
}

export function renderStart(input: { timelineId?: string; version?: number; timeline?: any; quality: "draft" | "final" }) {
  let id = input.timelineId;
  let version = input.version;
  if (input.timeline) {
    const v = timelineValidate(input.timeline, true);
    id = v.timelineId!;
    version = v.version!;
  }
  if (!id) throw new StudioError("INVALID_INPUT", "Give timelineId (and optional version) or an inline timeline");
  const row = store.getTimeline(id, version);
  return startRender(row.id, row.version, input.quality);
}

export function qaCheck(renderId: string) {
  const r = store.getRender(renderId);
  if (r.status !== "succeeded") throw new StudioError("INVALID_INPUT", `Render ${renderId} is ${r.status}; wait until it succeeds.`);
  return enqueue("qa", { renderId });
}

// ------------------------------------------------------------ doctor
export async function doctor() {
  const out: Record<string, unknown> = { node: process.version, appRoot: APP_ROOT, workspace: WORKSPACE, inbox: getConfig().inboxDir, clips: getConfig().exportDir, config: getConfig() };
  const issues: string[] = [];
  try {
    const v = await run(ffmpegBin(), ["-hide_banner", "-version"], { timeoutMs: 15000 });
    out.ffmpeg = { path: ffmpegBin(), version: v.stdout.split("\n")[0] };
    const f = await run(ffmpegBin(), ["-hide_banner", "-filters"], { timeoutMs: 15000 });
    const need = ["subtitles", "loudnorm", "sidechaincompress", "zoompan", "boxblur", "blackdetect", "ebur128"];
    const missing = need.filter((n) => !new RegExp(`\\s${n}\\s`).test(f.stdout));
    if (missing.length) issues.push(`ffmpeg is missing filters: ${missing.join(", ")} (subtitles needs libass: run 'brew install ffmpeg-full', then restart Claude)`);
    out.ffmpegFilters = missing.length ? { missing } : "all present";
  } catch (e) {
    issues.push(`ffmpeg not found (${(e as Error).message}). Install with: brew install ffmpeg-full`);
  }
  try {
    await run(ffprobeBin(), ["-version"], { timeoutMs: 15000 });
    out.ffprobe = ffprobeBin();
  } catch {
    issues.push("ffprobe not found (comes with ffmpeg)");
  }
  const py = pythonBin();
  if (!fs.existsSync(py)) issues.push(`Python env missing at ${py}. Run scripts/setup_mac.sh`);
  else {
    try {
      const tmp = path.join(WORKSPACE, "tmp");
      fs.mkdirSync(tmp, { recursive: true });
      const o = path.join(tmp, "doctor.json");
      await run(py, [path.join(PYTHON_DIR, "vpt_analyze.py"), "doctor", "--out", o], { timeoutMs: 120000 });
      out.python = JSON.parse(fs.readFileSync(o, "utf8"));
      const ytv = (out.python as Record<string, string>).yt_dlp;
      if (!ytv || ytv.startsWith("missing")) issues.push("yt-dlp (downloads from links) is missing: run the setup script again, then restart Claude");
    } catch (e) {
      issues.push(`Python sidecar failed: ${(e as StudioError).hint ?? (e as Error).message}`);
    }
  }
  const fonts = fs.existsSync(path.join(LIBRARY, "fonts")) ? fs.readdirSync(path.join(LIBRARY, "fonts")).filter((f) => f.endsWith(".ttf")) : [];
  out.fonts = fonts;
  if (!fonts.length) issues.push("No fonts in library/fonts");
  out.exportDirExists = fs.existsSync(getConfig().exportDir);
  out.issues = issues;
  out.ok = issues.length === 0;
  return out;
}

// ------------------------------------------------------------ v0.2: analysis, timelines, styles, effects, preview
import { FacesResult, loadAnalysis as loadA } from "./analysis.js";
import { spawn } from "node:child_process";
import { getBrandKit } from "./catalog.js";
import { fxCreate as fxCreateImpl, FxCreateInput } from "./remotion.js";
import { saveStyle } from "./styles.js";

/** Scenes (with face coverage and position), beats, or face summary for an asset — for picking shots and timing cuts. */
export function analysisGet(assetId: string, kind: "scenes" | "beats" | "faces" | "source") {
  const a = store.getAsset(assetId);
  if (kind === "source") {
    const src = sourceFor(a.id);
    if (!src) throw new StudioError("NOT_FOUND", `${a.name} wasn't imported from a link, so there is no source info.`, "Source info (title, channel, chapters, most-replayed moments) exists for media_import_url imports.");
    return { asset: a.name, ...src };
  }
  if (kind === "beats") {
    const b = loadA<{ tempo: number; beats: number[] }>(a.id, "beats");
    if (!b) throw new StudioError("NOT_FOUND", `No beat analysis for ${a.name}`, 'Run analyze with include:["beats"].');
    return { asset: a.name, tempo: b.tempo, beatCount: b.beats.length, beats: b.beats };
  }
  const faces = loadA<FacesResult>(a.id, "faces");
  const sc = loadA<{ scenes: number[][] }>(a.id, "scenes");
  if (kind === "faces" && !faces) throw new StudioError("NOT_FOUND", `No face analysis for ${a.name}`, 'Run analyze with include:["faces"].');
  if (kind === "scenes" && !sc) throw new StudioError("NOT_FOUND", `No scene analysis for ${a.name}`, 'Run analyze with include:["scenes"].');
  const scenes = sc?.scenes ?? [[0, a.data.probe.duration]];
  const rows = scenes.map(([s, e], i) => {
    const fr = faces?.frames.filter((f) => f.t >= s && f.t < e) ?? [];
    const wf = fr.filter((f) => f.faces.length);
    const two = fr.filter((f) => f.faces.length >= 2);
    const cx = wf.map((f) => {
      const b = f.faces.reduce((m, x) => (x[2] * x[3] > m[2] * m[3] ? x : m));
      return b[0] + b[2] / 2;
    });
    const big = wf.map((f) => Math.max(...f.faces.map((x) => x[3])));
    return {
      scene: i + 1,
      start: r3(s),
      end: r3(e),
      dur: r3(e - s),
      face: faces ? (fr.length ? Math.round((wf.length / fr.length) * 100) / 100 : 0) : undefined,
      twoFaces: faces ? (fr.length ? Math.round((two.length / fr.length) * 100) / 100 : 0) : undefined,
      faceX: cx.length ? r3(cx.reduce((p, q) => p + q, 0) / cx.length) : undefined,
      faceSize: big.length ? r3(big.reduce((p, q) => p + q, 0) / big.length) : undefined,
    };
  });
  return { asset: a.name, duration: r3(a.data.probe.duration), scenes: rows, note: "face = share of sampled frames with a face; faceX = face centre across the frame (0–1); faceSize = face height / frame height (large = close-up)" };
}

export function timelineGet(opts: { timelineId?: string; projectId?: string; name?: string; version?: number }) {
  let id = opts.timelineId;
  if (!id && opts.projectId && opts.name) id = store.listTimelines(opts.projectId).find((t) => t.name === opts.name)?.id;
  if (!id) throw new StudioError("INVALID_INPUT", "Give timelineId, or projectId + name", "project_open lists timelines.");
  const row = store.getTimeline(id, opts.version);
  const latest = store.listTimelines(row.project_id).find((t) => t.id === row.id)?.latest;
  return { timelineId: row.id, version: row.version, latestVersion: latest, name: row.name, timeline: row.json };
}

export function styleSave(style: unknown) {
  return saveStyle(style);
}

export async function fxCreate(input: FxCreateInput & { brandKit?: string; backgroundAsset?: { assetId: string; time: number } }) {
  let bg: string | undefined;
  if (input.backgroundAsset) {
    const frames = await framesGet({ assetId: input.backgroundAsset.assetId, times: [input.backgroundAsset.time], width: 720 });
    bg = frames[0].path;
  }
  return fxCreateImpl(input, getBrandKit(input.brandKit), bg);
}

/** Open a render (or exported clip) in the default player on this computer. */
export function openInPlayer(renderId: string) {
  const r = store.getRender(renderId);
  const file = r.data.exported ?? r.data.output;
  if (!file || !fs.existsSync(file)) throw new StudioError("INVALID_INPUT", `Render ${renderId} has no output yet (${r.status})`);
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
  try {
    const child = spawn(cmd, [file], { detached: true, stdio: "ignore" });
    child.on("error", () => undefined);
    child.unref();
  } catch {
    /* no player available (e.g. a server) */
  }
  return { opened: file, with: cmd };
}
