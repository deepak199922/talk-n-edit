import fs from "node:fs";
import path from "node:path";
import { dirs, getConfig, PYTHON_DIR, pythonBin } from "./config.js";
import { now } from "./db.js";
import { StudioError } from "./errors.js";
import { ffmpeg } from "./ffmpeg.js";
import { hashParams, newId } from "./ids.js";
import type { JobContext } from "./jobs.js";
import { run } from "./proc.js";
import { Asset, findAnalysis, getAsset, insertAnalysis } from "./store.js";

export type AnalysisKind = "transcript" | "scenes" | "faces" | "beats";

export interface Word {
  w: string;
  s: number;
  e: number;
  p?: number;
}
export interface Transcript {
  backend: string;
  model: string;
  language: string;
  segments: Array<{ start: number; end: number; text: string }>;
  words: Word[];
}
export interface Sentence {
  id: string;
  start: number;
  end: number;
  text: string;
  w0: number; // index of first word
  w1: number; // index of last word (inclusive)
}
export interface FacesResult {
  sampleFps: number;
  width: number;
  height: number;
  frames: Array<{ t: number; faces: number[][] }>;
}

async function sidecar(task: string, inp: string, out: string, params: object, ctx: JobContext, base: number, span: number, label: string) {
  const script = path.join(PYTHON_DIR, "vpt_analyze.py");
  const py = pythonBin();
  if (!fs.existsSync(py)) {
    throw new StudioError("DEPENDENCY_MISSING", `Python environment not found at ${py}`, "Run scripts/setup_mac.sh, or system_doctor with fix:true.");
  }
  await run(py, [script, task, "--in", inp, "--out", out, "--params", JSON.stringify(params)], {
    signal: ctx.signal,
    label: `analysis:${task}`,
    env: { ...process.env, PYTHONUNBUFFERED: "1", TOKENIZERS_PARALLELISM: "false" },
    onStdoutLine: (line) => {
      try {
        const j = JSON.parse(line);
        if (typeof j.progress === "number") ctx.progress(`${label}: ${j.stage}`, base + span * j.progress);
      } catch {
        /* not a progress line */
      }
    },
  });
  return JSON.parse(fs.readFileSync(out, "utf8"));
}

export interface AnalyzeInput {
  assetId: string;
  include: AnalysisKind[];
  language?: string;
  model?: string;
  prompt?: string;
  force?: boolean;
}

export async function analyzeJob(input: AnalyzeInput, ctx: JobContext) {
  const asset = getAsset(input.assetId);
  if (asset.kind === "image") throw new StudioError("INVALID_INPUT", "Images have nothing to analyse.");
  const dir = dirs.analysis(asset.project_id, asset.id);
  fs.mkdirSync(dir, { recursive: true });
  const kinds = [...new Set(input.include)];
  if (asset.kind === "audio") kinds.splice(0, kinds.length, ...kinds.filter((k) => k === "transcript" || k === "beats"));
  const summary: Record<string, unknown> = {};
  const span = 1 / Math.max(1, kinds.length);
  for (let i = 0; i < kinds.length; i++) {
    const kind = kinds[i];
    const base = i * span;
    const cfg = getConfig();
    const params: Record<string, unknown> =
      kind === "transcript"
        ? { backend: cfg.transcriptionBackend, model: input.model ?? cfg.whisperModel, language: input.language ?? null, prompt: input.prompt ?? null }
        : kind === "faces"
          ? { sampleFps: 2 }
          : kind === "beats"
            ? { v: 1 }
            : { threshold: 27 };
    const ph = hashParams(params);
    const existing = findAnalysis(asset.id, kind, ph);
    if (existing && !input.force && fs.existsSync(existing.path)) {
      summary[kind] = { ...existing.summary, cached: true };
      continue;
    }
    const out = path.join(dir, `${kind}.${ph}.json`);
    let result: any;
    if (kind === "transcript") {
      if (!asset.data.probe.hasAudio) throw new StudioError("INVALID_INPUT", `${asset.name} has no audio to transcribe.`);
      const wav = path.join(dir, "audio16k.wav");
      if (!fs.existsSync(wav)) {
        ctx.progress("transcript: extracting audio", base);
        await ffmpeg(["-i", asset.data.original, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", wav], {
          duration: asset.data.probe.duration,
          signal: ctx.signal,
          onProgress: (f) => ctx.progress("transcript: extracting audio", base + span * 0.05 * f),
        });
      }
      result = await sidecar("transcribe", wav, out, { ...params, duration: asset.data.probe.duration }, ctx, base + span * 0.05, span * 0.95, "transcript");
      const t = result as Transcript;
      summary.transcript = {
        language: t.language,
        words: t.words.length,
        sentences: buildSentences(t.words).length,
        model: `${t.backend}:${t.model}`,
      };
    } else if (kind === "beats") {
      if (!asset.data.probe.hasAudio) throw new StudioError("INVALID_INPUT", `${asset.name} has no audio to find beats in.`);
      const wav = path.join(dir, "audio22k.wav");
      if (!fs.existsSync(wav)) {
        ctx.progress("beats: extracting audio", base);
        await ffmpeg(["-i", asset.data.original, "-vn", "-ac", "1", "-ar", "22050", "-c:a", "pcm_s16le", wav], { duration: asset.data.probe.duration, signal: ctx.signal });
      }
      result = await sidecar("beats", wav, out, { ...params, duration: asset.data.probe.duration }, ctx, base + span * 0.1, span * 0.9, "beats");
      summary.beats = { tempo: result.tempo, beats: result.beats.length };
    } else {
      const src = asset.data.proxy ?? asset.data.original;
      result = await sidecar(kind, src, out, { ...params, duration: asset.data.probe.duration }, ctx, base, span, kind);
      if (kind === "scenes") summary.scenes = { count: result.scenes.length };
      if (kind === "faces") {
        const fr = result as FacesResult;
        const withFace = fr.frames.filter((f) => f.faces.length > 0).length;
        const multi = fr.frames.filter((f) => f.faces.length > 1).length;
        summary.faces = {
          sampledFrames: fr.frames.length,
          framesWithFace: withFace,
          framesWithTwoOrMore: multi,
          detector: (result as any).detector,
        };
      }
    }
    insertAnalysis({ id: newId("ana"), asset_id: asset.id, kind, params_hash: ph, path: out, created: now(), summary: summary[kind] as any });
  }
  return { assetId: asset.id, summary };
}

const cache = new Map<string, unknown>();
function loadJson<T>(p: string): T {
  if (!cache.has(p)) cache.set(p, JSON.parse(fs.readFileSync(p, "utf8")));
  return cache.get(p) as T;
}

export function loadAnalysis<T>(assetId: string, kind: AnalysisKind): T | undefined {
  const row = findAnalysis(assetId, kind);
  if (!row || !fs.existsSync(row.path)) return undefined;
  return loadJson<T>(row.path);
}

export function requireTranscript(asset: Asset): Transcript {
  const t = loadAnalysis<Transcript>(asset.id, "transcript");
  if (!t) throw new StudioError("NOT_FOUND", `No transcript for ${asset.id} (${asset.name})`, `Run analyze with include:["transcript"] first.`);
  return t;
}

const END_RE = /[.?!।॥…]["')\]]?$/;

export function buildSentences(words: Word[]): Sentence[] {
  const out: Sentence[] = [];
  let start = 0;
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const next = words[i + 1];
    const gap = next ? next.s - w.e : 99;
    const count = i - start + 1;
    if (END_RE.test(w.w) || gap > 0.9 || count >= 40 || !next) {
      const ws = words.slice(start, i + 1);
      out.push({
        id: `s${String(out.length + 1).padStart(4, "0")}`,
        start: ws[0].s,
        end: ws[ws.length - 1].e,
        text: joinWords(ws.map((x) => x.w)),
        w0: start,
        w1: i,
      });
      start = i + 1;
    }
  }
  return out;
}

export function joinWords(ws: string[]): string {
  return ws.join(" ").replace(/\s+([,.!?;:।])/g, "$1").trim();
}

export function fmtClock(t: number): string {
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = (t % 60).toFixed(1).padStart(4, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${String(m).padStart(2, "0")}:${s}`;
}

export function transcriptText(asset: Asset, opts: { start?: number; end?: number; format?: "compact" | "words"; page?: number }) {
  const t = requireTranscript(asset);
  const sents = buildSentences(t.words).filter((s) => (opts.start === undefined || s.end >= opts.start) && (opts.end === undefined || s.start <= opts.end));
  const pageSize = opts.format === "words" ? 60 : 500;
  const page = Math.max(1, opts.page ?? 1);
  const pages = Math.max(1, Math.ceil(sents.length / pageSize));
  const slice = sents.slice((page - 1) * pageSize, page * pageSize);
  let body: string;
  if (opts.format === "words") {
    body = slice
      .map((s) => `${s.id}: ` + t.words.slice(s.w0, s.w1 + 1).map((w) => `${w.w}@${w.s.toFixed(2)}`).join(" "))
      .join("\n");
  } else {
    body = slice.map((s) => `[${s.id} ${fmtClock(s.start)}–${fmtClock(s.end)}] ${s.text}`).join("\n");
  }
  return {
    header: `${asset.name} · ${t.language} · ${fmtClock(asset.data.probe.duration)} · ${sents.length} sentences · page ${page}/${pages}`,
    body,
    sentences: slice,
    pages,
  };
}

/** Sentence id -> time range (used to let Claude pick clips by sentence). */
export function sentenceRange(asset: Asset, fromId: string, toId: string): { in: number; out: number } {
  const t = requireTranscript(asset);
  const s = buildSentences(t.words);
  const a = s.find((x) => x.id === fromId);
  const b = s.find((x) => x.id === toId);
  if (!a || !b) throw new StudioError("INVALID_INPUT", `Unknown sentence id ${!a ? fromId : toId}`);
  return { in: a.start, out: b.end };
}
