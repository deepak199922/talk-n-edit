import { buildSentences, FacesResult, loadAnalysis, sentenceRange, Transcript, Word } from "./analysis.js";
import { BrandKit, CaptionPreset, getBrandKit, getCaptionPreset, safeArea, SafeArea, validateOverlayProps } from "./catalog.js";
import { getConfig } from "./config.js";
import { librarySound, lookFilters, mergeLook, xfadeName, ZoomEvent } from "./effects.js";
import { StudioError } from "./errors.js";
import { even, r3 } from "./ffmpeg.js";
import { isGraphic, validateGraphicProps } from "./graphics.js";
import { assetSource } from "./media.js";
import { Anchor, Look, outputSize, Timeline, TimelineSchema } from "./schema/timeline.js";
import { Asset, findAnalysis, getAsset } from "./store.js";
import { applyStyle } from "./styles.js";

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Segment {
  index: number;
  clipId: string;
  assetId: string;
  kind: "video" | "image" | "freeze";
  src: string;
  srcW: number;
  srcH: number;
  hasAudio: boolean;
  srcIn: number;
  srcDur: number;
  tlStart: number;
  tlDur: number;
  frames: number;
  speed: number;
  volume: number;
  layout: "crop" | "fit" | "split";
  /** For layout "fit": background fill and black bars to cut first (fractions of the source). */
  fit?: { background: "blur" | "black"; trim: { top: number; bottom: number; left: number; right: number } };
  crop?: Rect;
  split?: [Rect, Rect];
  motion?: { type: "kenburns-in" | "kenburns-out" | "punch-in"; strength: number };
  /** Transition from the previous segment into this one (overlapping). */
  transIn?: { name: string; xfade: string; dur: number; frames: number };
  zooms?: ZoomEvent[];
  look?: Look;
  flash?: boolean;
  reverse?: boolean;
  stabilize?: boolean;
  audioFx?: { denoise?: boolean; enhance?: boolean };
}

export interface TlWord {
  w: string;
  s: number;
  e: number;
}

export interface ResolvedOverlay {
  id: string;
  component: string;
  engine: "ass" | "remotion";
  start: number;
  end: number;
  props: Record<string, any>;
  layer: number;
}

export interface ResolvedAudio {
  id: string;
  src: string;
  role: "music" | "sfx" | "voice";
  start: number;
  in: number;
  out: number;
  volume: number;
  fadeIn: number;
  fadeOut: number;
  loop: boolean;
}

export interface ResolvedMask {
  id: string;
  start: number;
  end: number;
  rect: Rect;
  type: "blur" | "pixelate" | "box";
  color: string;
  strength: number;
}

export interface ResolvedLayer {
  id: string;
  kind: "video" | "image";
  src: string;
  srcW: number;
  srcH: number;
  in: number;
  start: number;
  end: number;
  mode: "full" | "pip";
  rect: Rect; // output pixels (for full: whole frame)
  fit: "fill" | "fit";
  border: number;
  borderColor: string;
  lookFilters: string[];
  volume: number;
  speed: number;
  hasAudio: boolean;
}

export interface ResolvedVfx {
  type: string;
  start: number;
  end: number;
  intensity: number;
  color?: string;
}

export interface Resolved {
  name: string;
  width: number;
  height: number;
  fps: number;
  duration: number;
  platform: string;
  aspect: string;
  safe: SafeArea;
  brand: BrandKit;
  segments: Segment[];
  captions?: { preset: CaptionPreset; words: TlWord[]; emphasis: "auto" | "none" | string[]; position: string; uppercase?: boolean; maxWordsPerLine?: number; size?: number };
  overlays: ResolvedOverlay[];
  vfx: ResolvedVfx[];
  masks: ResolvedMask[];
  layers: ResolvedLayer[];
  audio: ResolvedAudio[];
  transitions: Array<{ t: number; name: string; dur: number }>;
  mix: { targetLufs: number; duckMusicDb: number };
  warnings: string[];
  clipsSummary: Array<{ clipId: string; tlStart: number; tlEnd: number; pieces: number; srcIn: number; srcOut: number }>;
  spoken: TlWord[];
  styleNotes?: string;
}

const median = (xs: number[]) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

function fail(path: string, message: string, hint?: string): never {
  throw new StudioError("INVALID_INPUT", message, hint, path);
}

function hasTranscripts(ids: string[]): boolean {
  return ids.every((id) => {
    try {
      const a = getAsset(id);
      return a.kind === "image" || !!findAnalysis(a.id, "transcript");
    } catch {
      return false;
    }
  });
}

/** A plain-words fix for validation mistakes that come up often (added to the error's hint). */
function knownFix(p: PropertyKey[], code: string): string | undefined {
  const keys = p.map(String);
  const last = keys[keys.length - 1];
  if (last === "duration" && keys.some((k) => /^transition/.test(k)) && (code === "too_small" || code === "too_big"))
    return "A transition lasts 0.05–2 s. For a hard cut, leave the transition out instead of setting 0.";
  return undefined;
}

/** Parse + validate a timeline object (style defaults applied first); throws with a JSON path. */
export function parseTimeline(json: unknown): Timeline {
  const { timeline } = applyStyle(json, hasTranscripts);
  const r = TimelineSchema.safeParse(timeline);
  if (!r.success) {
    const i = r.error.issues[0];
    const where = i.path.join(".") || "(root)";
    const more = r.error.issues.length > 1 ? `${r.error.issues.length} problems; fix this one first.` : undefined;
    fail(where, i.message, [knownFix(i.path, i.code), more].filter(Boolean).join(" ") || undefined);
  }
  return r.data;
}

function snapToWords(words: Word[] | undefined, a: number, b: number, dur: number): [number, number] {
  if (!words?.length) return [a, b];
  let na = a;
  let nb = b;
  const first = words.find((w) => w.e > a + 0.02);
  if (first && Math.abs(first.s - a) < 0.6) na = Math.max(0, Math.min(a, first.s - 0.08));
  let last: Word | undefined;
  for (const w of words) if (w.s < b - 0.02) last = w;
  if (last && Math.abs(last.e - b) < 0.6) nb = Math.min(dur, Math.max(b, last.e + 0.15));
  return [na, nb];
}

function keepRanges(words: Word[], a: number, b: number, minGap: number, pad: number): Array<[number, number]> {
  const ws = words.filter((w) => w.e > a && w.s < b);
  if (!ws.length) return [[a, b]];
  const out: Array<[number, number]> = [];
  let s = Math.max(a, ws[0].s - pad);
  let e = ws[0].e;
  for (let i = 1; i < ws.length; i++) {
    if (ws[i].s - e > minGap) {
      out.push([s, Math.min(b, e + pad)]);
      s = Math.max(a, ws[i].s - pad);
    }
    e = Math.max(e, ws[i].e);
  }
  out.push([s, Math.min(b, e + pad)]);
  const merged: Array<[number, number]> = [];
  for (const r of out) {
    const prev = merged[merged.length - 1];
    if (prev && r[0] <= prev[1] + 0.02) prev[1] = Math.max(prev[1], r[1]);
    else merged.push([r[0], r[1]]);
  }
  return merged.filter(([x, y]) => y - x > 0.08);
}

/** Split ranges at the given cut times (keeping pieces at least `min` long). */
function splitAt(ranges: Array<[number, number]>, cuts: number[], min = 0.3): Array<[number, number]> {
  if (!cuts.length) return ranges;
  const sorted = [...cuts].sort((a, b) => a - b);
  const out: Array<[number, number]> = [];
  for (const [a, b] of ranges) {
    let s = a;
    for (const c of sorted) {
      if (c > s + min && c < b - min) {
        out.push([s, c]);
        s = c;
      }
    }
    out.push([s, b]);
  }
  return out;
}

function fillRect(W0: number, H0: number, aspect: number, zoom = 1): { w: number; h: number } {
  let w: number;
  let h: number;
  if (W0 / H0 > aspect) {
    h = H0;
    w = H0 * aspect;
  } else {
    w = W0;
    h = W0 / aspect;
  }
  return { w: even(Math.min(W0, w / zoom)), h: even(Math.min(H0, h / zoom)) };
}

function placeRect(W0: number, H0: number, w: number, h: number, cx: number, cy: number): Rect {
  return { x: even(clamp(cx * W0 - w / 2, 0, W0 - w)), y: even(clamp(cy * H0 - h / 2, 0, H0 - h)), w, h };
}

interface FaceStat {
  cx: number;
  cy: number;
  h: number;
}

function facesIn(faces: FacesResult | undefined, a: number, b: number): Array<number[][]> {
  if (!faces) return [];
  return faces.frames.filter((f) => f.t >= a && f.t <= b).map((f) => f.faces.filter((x) => (x[4] ?? 1) >= 0.6));
}

function dominantFace(frames: Array<number[][]>): FaceStat | null {
  const xs: number[] = [];
  const ys: number[] = [];
  const hs: number[] = [];
  for (const fs of frames) {
    if (!fs.length) continue;
    const big = fs.reduce((m, f) => (f[2] * f[3] > m[2] * m[3] ? f : m));
    xs.push(big[0] + big[2] / 2);
    ys.push(big[1] + big[3] / 2);
    hs.push(big[3]);
  }
  if (xs.length < Math.max(1, frames.length * 0.2)) return null;
  return { cx: median(xs), cy: median(ys), h: median(hs) };
}

function twoFaces(frames: Array<number[][]>): [FaceStat, FaceStat] | null {
  const L: FaceStat[] = [];
  const R: FaceStat[] = [];
  for (const fs of frames) {
    if (fs.length < 2) continue;
    const sorted = [...fs].sort((p, q) => q[2] * q[3] - p[2] * p[3]).slice(0, 2).sort((p, q) => p[0] - q[0]);
    const st = (f: number[]) => ({ cx: f[0] + f[2] / 2, cy: f[1] + f[3] / 2, h: f[3] });
    L.push(st(sorted[0]));
    R.push(st(sorted[1]));
  }
  if (L.length < Math.max(2, frames.length * 0.25)) return null;
  const m = (arr: FaceStat[]): FaceStat => ({ cx: median(arr.map((s) => s.cx)), cy: median(arr.map((s) => s.cy)), h: median(arr.map((s) => s.h)) });
  return [m(L), m(R)];
}

type WordTime = (clipId: string, phrase: string, n: number, edge: "start" | "end", path: string) => number;

/**
 * Time anchors inside overlay props. Any value written as {"$at": anchor} becomes seconds from the overlay's start,
 * {"$time": anchor} becomes seconds on the timeline. anchor is {at}, {clip, sourceTime} or {clip, word, n?, edge?}
 * (word = a word or phrase she says in that clip; n = which occurrence, 1 = first; edge "start" (default) or "end").
 * So times follow the speech when clips are trimmed or moved. Everything else is left exactly as written.
 */
export function resolvePropTimes(value: unknown, overlayStart: number, path: string, wordTime: WordTime, clipMap: (clipId: string, t: number) => number | null, fps = 0): any {
  if (Array.isArray(value)) return value.map((v, i) => resolvePropTimes(v, overlayStart, `${path}[${i}]`, wordTime, clipMap, fps));
  if (!value || typeof value !== "object") return value;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (keys.length === 1 && (keys[0] === "$at" || keys[0] === "$time")) {
    const a = obj[keys[0]] as Record<string, unknown> | null;
    const p = `${path}.${keys[0]}`;
    if (!a || typeof a !== "object") fail(p, "Time anchor must be an object", 'Use {"at": seconds}, {"clip": "id", "sourceTime": s} or {"clip": "id", "word": "text"}.');
    let t: number;
    if (typeof a.at === "number") t = a.at;
    else if (typeof a.clip === "string" && typeof a.sourceTime === "number") {
      const m = clipMap(a.clip, a.sourceTime);
      if (m === null) fail(p, `Source time ${a.sourceTime}s is not inside clip "${a.clip}" after cuts`);
      t = m;
    } else if (typeof a.clip === "string" && typeof a.word === "string") {
      const n = typeof a.n === "number" && a.n >= 1 ? Math.floor(a.n) : 1;
      t = wordTime(a.clip, a.word, n, a.edge === "end" ? "end" : "start", p);
    } else return fail(p, "Unknown time anchor", 'Use {"at": seconds}, {"clip": "id", "sourceTime": s} or {"clip": "id", "word": "text", "n": 1}.');
    if (typeof a.offset === "number") t += a.offset;
    const v = keys[0] === "$at" ? t - overlayStart : t;
    // Snapped to whole frames: graphics only change once per frame, and a sub-frame shift (e.g. after re-framing a
    // clip) then leaves the graphic, and its cached frames, unchanged.
    return fps > 0 ? Math.round(Math.round(v * fps) * (1000 / fps)) / 1000 : Math.round(v * 1000) / 1000;
  }
  const out: Record<string, unknown> = {};
  for (const k of keys) out[k] = resolvePropTimes(obj[k], overlayStart, `${path}.${k}`, wordTime, clipMap, fps);
  return out;
}

function resolveAnchor(anchor: Anchor, path: string, clipMap: (clipId: string, t: number) => number | null): number {
  if ("at" in anchor) return anchor.at;
  const t = clipMap(anchor.clip, anchor.sourceTime);
  if (t === null) fail(path, `Anchor source time ${anchor.sourceTime}s is not inside clip "${anchor.clip}" after cuts`, "Use a time inside the kept part of the clip, or {at: seconds}.");
  return t;
}

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

/** Align script tokens to timed ASR words (LCS), interpolating times for unmatched tokens. */
export function alignScript(script: string, asr: TlWord[], tStart: number, tEnd: number): TlWord[] {
  const toks = script.split(/\s+/).filter(Boolean);
  if (!toks.length) return [];
  const n = toks.length;
  const m = asr.length;
  const match: number[] = new Array(n).fill(-1);
  if (m) {
    const A = toks.map(norm);
    const B = asr.map((w) => norm(w.w));
    const dp: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
    for (let i = n - 1; i >= 0; i--)
      for (let j = m - 1; j >= 0; j--) dp[i][j] = A[i] && A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (A[i] && A[i] === B[j]) {
        match[i] = j;
        i++;
        j++;
      } else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
      else j++;
    }
  }
  const out: TlWord[] = toks.map((w, i) => (match[i] >= 0 ? { w, s: asr[match[i]].s, e: asr[match[i]].e } : { w, s: NaN, e: NaN }));
  let i = 0;
  while (i < n) {
    if (!isNaN(out[i].s)) {
      i++;
      continue;
    }
    let j = i;
    while (j < n && isNaN(out[j].s)) j++;
    const left = i > 0 ? out[i - 1].e : tStart;
    const right = j < n ? out[j].s : tEnd;
    const step = Math.max(0.05, (right - left) / (j - i));
    for (let k = i; k < j; k++) {
      out[k].s = left + (k - i) * step;
      out[k].e = left + (k - i + 1) * step;
    }
    i = j;
  }
  return out;
}

const hexOk = (s: string) => /^#[0-9a-fA-F]{6}$/.test(s);

function fitOpts(r: { background?: "blur" | "black"; trim?: { top?: number; bottom?: number; left?: number; right?: number } }): NonNullable<Segment["fit"]> {
  const t = r.trim ?? {};
  return { background: r.background ?? "blur", trim: { top: t.top ?? 0, bottom: t.bottom ?? 0, left: t.left ?? 0, right: t.right ?? 0 } };
}

/**
 * Spread caption tokens over the timed speech words inside [s, e], in order.
 * Token i covers the same share of the word sequence (by position), so any wording,
 * script or language (Hinglish, translations) follows the voice. No speech → even spread.
 */
export function spreadTokens(toks: string[], asr: TlWord[], s: number, e: number): TlWord[] {
  const m = toks.length;
  const n = asr.length;
  if (!m) return [];
  if (!n) {
    const step = Math.max(0.05, (e - s) / m);
    return toks.map((w, i) => ({ w, s: r3(s + i * step), e: r3(s + (i + 1) * step) }));
  }
  const at = (p: number, end: boolean): number => {
    if (end && p > 0 && Math.abs(p - Math.round(p)) < 1e-9) return asr[Math.min(n, Math.round(p)) - 1].e;
    const k = Math.min(n - 1, Math.floor(p));
    const f = Math.min(1, p - k);
    return asr[k].s + f * (asr[k].e - asr[k].s);
  };
  return toks.map((w, i) => {
    const ws = at((i * n) / m, false);
    const we = Math.max(ws + 0.05, at(((i + 1) * n) / m, true));
    return { w, s: r3(ws), e: r3(we) };
  });
}

interface Piece {
  a: number;
  b: number;
  speed: number;
  freeze?: { duration: number; flash: boolean };
}

export function resolveTimeline(json: unknown, quality: "draft" | "final"): Resolved {
  const { notes: styleWarnings } = applyStyle(json, hasTranscripts);
  const tl = parseTimeline(json);
  const warnings: string[] = [...styleWarnings];
  const full = outputSize(tl.output);
  const scale = quality === "draft" ? Math.min(1, 960 / Math.max(full.width, full.height)) : 1;
  const width = even(full.width * scale);
  const height = even(full.height * scale);
  const fps = tl.output.fps;
  const aspect = width / height;
  const brand = getBrandKit(tl.brandKit ?? getConfig().defaultBrandKit);
  const segments: Segment[] = [];
  const clipsSummary: Resolved["clipsSummary"] = [];
  const transitions: Resolved["transitions"] = [];
  const ids = new Set<string>();
  const transcripts = new Map<string, Transcript | undefined>();
  const getWords = (a: Asset) => {
    if (!transcripts.has(a.id)) transcripts.set(a.id, loadAnalysis<Transcript>(a.id, "transcript"));
    return transcripts.get(a.id)?.words;
  };
  if (tl.look) lookFilters(tl.look); // validates LUT names early

  // Beat grid for beatSync (timeline seconds).
  let beatGrid: number[] | null = null;
  if (tl.beatSync) {
    const item = tl.audio.find((a) => a.id === tl.beatSync!.audioId);
    if (!item) fail("beatSync.audioId", `No audio item with id "${tl.beatSync.audioId}"`);
    if (!item.assetId) fail("beatSync.audioId", "beatSync needs an imported music asset (assetId), not a library sound");
    if (!("at" in item.start)) fail("beatSync", "The synced music must start at a fixed time ({at: seconds})");
    const beats = loadAnalysis<{ beats: number[] }>(item.assetId, "beats");
    if (!beats?.beats?.length) warnings.push(`beatSync ignored: run analyze with include:["beats"] on the music asset first.`);
    else {
      const every = tl.beatSync.every;
      const off = (item.start as { at: number }).at - (item.in ?? 0);
      beatGrid = beats.beats.filter((_, i) => i % every === 0).map((b) => b + off).filter((b) => b > 0.3);
    }
  }

  let t = 0;
  let punchToggle = false;

  tl.clips.forEach((clip, ci) => {
    const p = `clips[${ci}]`;
    if (ids.has(clip.id)) fail(`${p}.id`, `Duplicate clip id "${clip.id}"`);
    ids.add(clip.id);
    const asset = (() => {
      try {
        return getAsset(clip.assetId);
      } catch (e) {
        fail(`${p}.assetId`, (e as Error).message, "Use an assetId from project_open or media_import.");
      }
    })();
    if (asset.project_id !== tl.projectId) fail(`${p}.assetId`, `Asset ${asset.id} belongs to another project`);
    if (asset.kind === "audio") fail(`${p}.assetId`, `${asset.name} is audio-only; put it in "audio" instead of "clips"`);
    const pr = asset.data.probe;
    const src = assetSource(asset, quality === "draft");
    const srcW = quality === "draft" && src !== asset.data.original ? even((pr.width * 540) / pr.height) : pr.width;
    const srcH = quality === "draft" && src !== asset.data.original ? 540 : pr.height;
    const segStart = segments.length;
    const look = mergeLook(tl.look, clip.look);
    if (clip.look) lookFilters(clip.look);
    const trans = ci === 0 ? undefined : clip.transitionIn ?? tl.transition;

    // Overlap with the previous segment for a transition.
    const startSegment = (seg: Segment, first: boolean) => {
      if (first && trans && trans.type !== "cut" && segments.length) {
        const prev = segments[segments.length - 1];
        const want = Math.round(trans.duration * fps);
        const f = Math.min(want, prev.frames - 2, seg.frames - 2);
        if (f >= 2) {
          seg.transIn = { name: trans.type, xfade: xfadeName(trans.type)!, dur: f / fps, frames: f };
          seg.tlStart = t - f / fps;
          transitions.push({ t: r3(seg.tlStart), name: trans.type, dur: r3(f / fps) });
        } else warnings.push(`${p}: transition too long for the clips around it; using a cut.`);
      }
      segments.push(seg);
      t = seg.tlStart + seg.tlDur;
    };

    if (asset.kind === "image") {
      const dur = clip.duration ?? 3;
      const frames = Math.max(1, Math.round(dur * fps));
      const fr = fillRect(srcW, srcH, aspect);
      startSegment(
        {
          index: segments.length, clipId: clip.id, assetId: asset.id, kind: "image", src, srcW, srcH, hasAudio: false,
          srcIn: 0, srcDur: frames / fps, tlStart: t, tlDur: frames / fps, frames, speed: 1, volume: 0,
          layout: clip.reframe?.mode === "fit" ? "fit" : "crop",
          fit: clip.reframe?.mode === "fit" ? fitOpts(clip.reframe) : undefined,
          crop: placeRect(srcW, srcH, fr.w, fr.h, 0.5, 0.5),
          motion: clip.motion ?? { type: "kenburns-in", strength: 0.5 },
          look,
        },
        true,
      );
      clipsSummary.push({ clipId: clip.id, tlStart: r3(segments[segStart].tlStart), tlEnd: r3(t), pieces: 1, srcIn: 0, srcOut: r3(dur) });
      return;
    }

    let a: number;
    let b: number;
    if (clip.sentences) {
      try {
        ({ in: a, out: b } = sentenceRange(asset, clip.sentences.from, clip.sentences.to));
      } catch (e) {
        fail(`${p}.sentences`, (e as Error).message, "Use sentence ids from transcript_get.");
      }
      if (clip.in !== undefined) a = clip.in;
      if (clip.out !== undefined) b = clip.out;
    } else {
      if (clip.in === undefined || clip.out === undefined) fail(p, `Clip needs "in" and "out" (seconds) or "sentences": {from, to}`);
      a = clip.in;
      b = clip.out;
    }
    if (a >= b) fail(`${p}.out`, `"out" (${b}) must be after "in" (${a})`);
    if (a > pr.duration) fail(`${p}.in`, `"in" (${a}) is past the end of ${asset.name} (${r3(pr.duration)}s)`);
    if (b > pr.duration + 0.05) {
      warnings.push(`${p}.out ${b}s is past the end (${r3(pr.duration)}s); clamped.`);
      b = pr.duration;
    }
    if (clip.reverse && b - a > 20) fail(`${p}.reverse`, "reverse works on clips up to 20 s");
    const words = getWords(asset);
    const snap = clip.snap ?? (words ? "word" : "frame");
    if (snap === "word") [a, b] = snapToWords(words, a, b, pr.duration);

    let ranges: Array<[number, number]> = [[a, b]];
    if (clip.removeSilences && !clip.reverse) {
      if (!words) warnings.push(`${p}.removeSilences ignored: ${asset.name} has no transcript (run analyze with "transcript").`);
      else ranges = keepRanges(words, a, b, clip.removeSilences.minGap, clip.removeSilences.keepPad);
    }
    const mode = clip.reframe?.mode ?? (Math.abs(srcW / srcH - aspect) < 0.02 ? "fill-center" : "auto-face");
    const faces = mode === "auto-face" || mode === "split" ? loadAnalysis<FacesResult>(asset.id, "faces") : undefined;
    if ((mode === "auto-face" || mode === "split") && !faces && Math.abs(srcW / srcH - aspect) > 0.02)
      warnings.push(`${p}: no face analysis for ${asset.name}; cropping to centre. Run analyze with "faces" for face-following crops.`);
    if (!clip.reverse) {
      if (mode === "auto-face" || mode === "split") {
        const sc = loadAnalysis<{ scenes: number[][] }>(asset.id, "scenes");
        ranges = splitAt(ranges, (sc?.scenes ?? []).map((s) => s[0]).filter((x) => x > 0));
      }
      if (tl.autoPunch?.every === "sentence" && words) ranges = splitAt(ranges, buildSentences(words).map((s) => s.start), 0.8);
      if (clip.speedRamp?.length) ranges = splitAt(ranges, clip.speedRamp.map((r) => r.at), 0.05);
      if (clip.freezes?.length) ranges = splitAt(ranges, clip.freezes.map((f) => f.at), 0.04);
    }

    // Pieces with speeds and freezes.
    const speedAt = (x: number) => {
      let s = clip.speed ?? 1;
      for (const r of [...(clip.speedRamp ?? [])].sort((m, n) => m.at - n.at)) if (x >= r.at - 0.001) s = r.speed;
      return s;
    };
    const pieces: Piece[] = [];
    const freezes = clip.freezes ?? [];
    freezes.forEach((fz, k) => {
      if (fz.at < a - 0.05 || fz.at > b + 0.05) fail(`${p}.freezes[${k}].at`, `Freeze at ${fz.at}s is outside the clip (${r3(a)}–${r3(b)}s)`);
    });
    const used = new Set<number>();
    const freezeAt = (x: number, onlyClipStart: boolean) =>
      freezes.forEach((fz, k) => {
        if (used.has(k) || Math.abs(fz.at - x) >= 0.05 || (onlyClipStart && x !== ranges[0][0])) return;
        used.add(k);
        pieces.push({ a: fz.at, b: fz.at, speed: 1, freeze: { duration: fz.duration, flash: fz.flash } });
      });
    for (const [ra, rb] of ranges) {
      freezeAt(ra, true);
      pieces.push({ a: ra, b: rb, speed: speedAt(ra) });
      freezeAt(rb, false);
    }
    freezes.forEach((fz, k) => {
      if (!used.has(k)) warnings.push(`${p}.freezes[${k}]: ${fz.at}s falls in a removed pause; freeze skipped.`);
    });

    // Beat sync: stretch/trim the last moving piece so the cut lands on a beat.
    if (beatGrid && pieces.length) {
      let dur = 0;
      for (const pc of pieces) dur += pc.freeze ? pc.freeze.duration : (pc.b - pc.a) / pc.speed;
      const endNow = t + dur - (trans && segments.length ? trans.duration : 0);
      const target = beatGrid.reduce((best, x) => (Math.abs(x - endNow) < Math.abs(best - endNow) ? x : best), beatGrid[0]);
      const last = [...pieces].reverse().find((pc) => !pc.freeze)!;
      const delta = (target - endNow) * last.speed;
      const nb = clamp(last.b + delta, last.a + 0.25, pr.duration);
      if (Math.abs(delta) < 1.5) last.b = nb;
    }

    let prevCrop: Rect | undefined;
    pieces.forEach((pc, ri) => {
      const isFreeze = !!pc.freeze;
      const frames = Math.max(1, Math.round((isFreeze ? pc.freeze!.duration : (pc.b - pc.a) / pc.speed) * fps));
      const tlDur = frames / fps;
      const seg: Segment = {
        index: segments.length, clipId: clip.id, assetId: asset.id, kind: isFreeze ? "freeze" : "video", src, srcW, srcH,
        hasAudio: pr.hasAudio && !isFreeze && !clip.audio?.mute, srcIn: clip.reverse ? a : pc.a, srcDur: isFreeze ? 0 : tlDur * pc.speed,
        tlStart: t, tlDur, frames, speed: isFreeze ? 1 : pc.speed, volume: clip.audio?.mute ? 0 : clip.volume ?? 1, layout: "crop", look,
        flash: pc.freeze?.flash, reverse: clip.reverse, stabilize: clip.stabilize,
        audioFx: clip.audio && (clip.audio.denoise || clip.audio.enhance) ? { denoise: clip.audio.denoise, enhance: clip.audio.enhance } : undefined,
      };
      const punchZoom = tl.autoPunch && !isFreeze ? (punchToggle ? tl.autoPunch.scale : 1) : 1;
      if (tl.autoPunch && !isFreeze) punchToggle = !punchToggle;
      const baseZoom = clip.reframe?.mode === "manual" ? clip.reframe.zoom : clip.motion?.type === "punch-in" ? 1 + 0.25 * (clip.motion.strength ?? 0.5) : 1;
      const fr = fillRect(srcW, srcH, aspect, baseZoom * punchZoom);
      const lo = pc.a;
      const hi = isFreeze ? pc.a + 0.5 : pc.b;
      if (mode === "fit") {
        seg.layout = "fit";
        if (clip.reframe?.mode === "fit") seg.fit = fitOpts(clip.reframe);
      }
      else if (mode === "manual" && clip.reframe?.mode === "manual") seg.crop = placeRect(srcW, srcH, fr.w, fr.h, clip.reframe.x, clip.reframe.y);
      else if (mode === "split") {
        const two = twoFaces(facesIn(faces, lo, hi));
        if (two) {
          seg.layout = "split";
          const halfAspect = width / (height / 2);
          seg.split = two.map((f) => {
            let h = even(Math.min(srcH, f.h * srcH * 3.4));
            let w = even(h * halfAspect);
            if (w > srcW) {
              w = even(srcW);
              h = even(w / halfAspect);
            }
            return placeRect(srcW, srcH, w, h, f.cx, f.cy + 0.05);
          }) as [Rect, Rect];
        } else {
          warnings.push(`${p}: split needs two faces in frame around ${r3(lo)}s; used a single face crop there.`);
          const f = dominantFace(facesIn(faces, lo, hi));
          seg.crop = placeRect(srcW, srcH, fr.w, fr.h, f?.cx ?? 0.5, f ? f.cy + 0.12 : 0.5);
        }
      } else if (mode === "auto-face") {
        const f = dominantFace(facesIn(faces, lo, hi));
        const zoomed = baseZoom * punchZoom;
        // Zooming in on a close-up would cut off the head: keep the full crop when the face is already large.
        const box = zoomed > 1 && f && f.h * zoomed > 0.42 ? fillRect(srcW, srcH, aspect, Math.max(1, Math.min(zoomed, 0.42 / f.h))) : fr;
        let crop = placeRect(srcW, srcH, box.w, box.h, f?.cx ?? 0.5, f ? f.cy + 0.12 : 0.5);
        if (prevCrop && prevCrop.w === crop.w && Math.abs(prevCrop.x - crop.x) < srcW * 0.08 && Math.abs(prevCrop.y - crop.y) < srcH * 0.08) crop = prevCrop;
        seg.crop = crop;
        prevCrop = crop;
      } else seg.crop = placeRect(srcW, srcH, fr.w, fr.h, 0.5, 0.5);
      startSegment(seg, ri === 0);
    });
    clipsSummary.push({ clipId: clip.id, tlStart: r3(segments[segStart].tlStart), tlEnd: r3(t), pieces: pieces.length, srcIn: r3(a), srcOut: r3(Math.max(...pieces.map((x) => x.b))) });
  });

  const duration = t;
  if (duration > getConfig().limits.maxOutputMinutes * 60) {
    throw new StudioError("LIMIT_EXCEEDED", `Timeline is ${r3(duration)}s; limit is ${getConfig().limits.maxOutputMinutes} min`);
  }
  if (["instagram-reels", "youtube-shorts", "tiktok"].includes(tl.output.platform) && duration > 90)
    warnings.push(`Duration ${r3(duration)}s is long for ${tl.output.platform}; 20–60 s performs best.`);

  const clipMap = (clipId: string, st: number): number | null => {
    const segs = segments.filter((s) => s.clipId === clipId && s.kind !== "freeze");
    if (!segs.length) return null;
    for (const s of segs) {
      if (s.reverse) {
        if (st >= s.srcIn - 0.001 && st <= s.srcIn + s.srcDur + 0.001) return s.tlStart + (s.srcIn + s.srcDur - st) / s.speed;
        continue;
      }
      if (st >= s.srcIn - 0.001 && st <= s.srcIn + s.srcDur + 0.001) return s.tlStart + (st - s.srcIn) / s.speed;
    }
    const after = segs.find((s) => s.srcIn > st);
    return after ? after.tlStart : null;
  };

  // Spoken words on the timeline (captions + preview).
  const spoken: TlWord[] = [];
  let missing = false;
  for (const s of segments) {
    if (s.kind !== "video") continue;
    const ws = getWords(getAsset(s.assetId));
    if (!ws) {
      missing = true;
      continue;
    }
    if (s.reverse) continue;
    const end = s.srcIn + s.srcDur;
    for (const w of ws) {
      const mid = (w.s + w.e) / 2;
      if (mid < s.srcIn || mid > end) continue;
      const ts = s.tlStart + (Math.max(w.s, s.srcIn) - s.srcIn) / s.speed;
      const te = s.tlStart + (Math.min(w.e, end) - s.srcIn) / s.speed;
      spoken.push({ w: w.w, s: r3(ts), e: r3(Math.max(te, ts + 0.05)) });
    }
  }

  let captions: Resolved["captions"];
  if (tl.captions) {
    const c = tl.captions;
    const preset = getCaptionPreset(c.preset === "brand" ? brand.captionPreset : c.preset);
    if (missing && c.source === "transcript")
      fail("captions", "Captions need a transcript for every video clip", 'Run analyze with include:["transcript"] on each asset first.');
    let words: TlWord[];
    if (c.source === "script") words = alignScript(c.scriptText ?? fail("captions.scriptText", 'scriptText is required when source is "script"'), spoken, 0, duration);
    else if (c.source === "lines") {
      if (!c.lines?.length) fail("captions.lines", 'lines is required when source is "lines"', "Give [{start, end, text}] with anchors like {clip, sourceTime}.");
      words = [];
      let prevEnd = 0;
      c.lines!.forEach((ln, li) => {
        const p = `captions.lines[${li}]`;
        const s0 = resolveAnchor(ln.start, `${p}.start`, clipMap);
        const e0 = Math.min(duration, resolveAnchor(ln.end, `${p}.end`, clipMap));
        if (e0 <= s0) fail(`${p}.end`, `Line ends (${r3(e0)}s) before it starts (${r3(s0)}s)`, "Check the anchors; both must fall inside kept footage.");
        if (s0 < prevEnd - 0.4) warnings.push(`${p} starts ${r3(prevEnd - s0)}s before the previous caption line ends; check the order and anchors`);
        prevEnd = e0;
        const inRange = spoken.filter((w) => (w.s + w.e) / 2 >= s0 && (w.s + w.e) / 2 <= e0);
        words.push(...spreadTokens(ln.text.split(/\s+/).filter(Boolean), inRange, s0, e0));
      });
      words.sort((a, b) => a.s - b.s);
      // Lines that meet at a transition can overlap a little; never show two captions at once.
      for (let i = 0; i + 1 < words.length; i++) if (words[i].e > words[i + 1].s && words[i + 1].s > words[i].s) words[i].e = Math.max(words[i].s + 0.05, words[i + 1].s);
    } else words = spoken;
    captions = { preset, words, emphasis: c.emphasis, position: c.position, uppercase: c.uppercase, maxWordsPerLine: c.maxWordsPerLine, size: c.size };
  }

  // Video effects. "shake" becomes a small shaking zoom (so no edges show); the rest are drawn over the picture.
  const vfx: ResolvedVfx[] = [];
  const shakeZooms: Array<{ s0: number; e0: number; scale: number; shake: number }> = [];
  (tl.vfx ?? []).forEach((v, vi) => {
    const s0 = resolveAnchor(v.start, `vfx[${vi}].start`, clipMap);
    if (s0 >= duration) fail(`vfx[${vi}].start`, `Effect starts after the timeline ends (${r3(duration)}s)`);
    const e0 = Math.min(duration, s0 + v.duration);
    if (v.color !== undefined && !hexOk(v.color)) fail(`vfx[${vi}].color`, "color must be #RRGGBB");
    if (v.type === "shake") shakeZooms.push({ s0, e0, scale: 1.04 + 0.08 * v.intensity, shake: v.intensity });
    else vfx.push({ type: v.type, start: r3(s0), end: r3(e0), intensity: v.intensity, color: v.color });
  });
  for (const z of shakeZooms)
    for (const seg of segments) {
      if (seg.kind === "image") continue;
      if (z.e0 <= seg.tlStart || z.s0 >= seg.tlStart + seg.tlDur) continue;
      (seg.zooms ??= []).push({ a: z.s0 - seg.tlStart, b: z.e0 - seg.tlStart, scale: z.scale, x: 0.5, y: 0.5, ease: "smooth", ramp: 0.08, shake: z.shake });
    }

  // Zoom keyframes → per-segment local events.
  (tl.zooms ?? []).forEach((z, zi) => {
    const s0 = resolveAnchor(z.start, `zooms[${zi}].start`, clipMap);
    const e0 = Math.min(duration, s0 + z.duration);
    if (s0 >= duration) fail(`zooms[${zi}].start`, `Zoom starts after the timeline ends (${r3(duration)}s)`);
    for (const seg of segments) {
      if (seg.kind === "image") continue;
      if (e0 <= seg.tlStart || s0 >= seg.tlStart + seg.tlDur) continue;
      (seg.zooms ??= []).push({ a: s0 - seg.tlStart, b: e0 - seg.tlStart, scale: z.scale, x: z.x, y: z.y, ease: z.ease, ramp: z.ramp, shake: z.shake });
    }
  });

  // Spoken-word lookup for time anchors inside overlay props: {"$at": {clip, word, n?, edge?}}.
  const wordTime = (clipId: string, phrase: string, n: number, edge: "start" | "end", path: string): number => {
    const clip = tl.clips.find((c) => c.id === clipId);
    if (!clip) fail(path, `No clip "${clipId}"`, "Use a clip id from this timeline.");
    const words = getWords(getAsset(clip.assetId)) ?? [];
    if (!words.length) fail(path, `Clip "${clipId}" has no transcript`, 'Run analyze with include:["transcript"] first, or use {clip, sourceTime}.');
    const segs = segments.filter((s) => s.clipId === clipId && s.kind === "video");
    const kept = (w: { s: number; e: number }) => segs.some((s) => w.s >= s.srcIn - 0.05 && w.e <= s.srcIn + s.srcDur + 0.05);
    const toks = phrase.split(/\s+/).map(norm).filter(Boolean);
    if (!toks.length) fail(path, "word is empty");
    const inClip = words.filter(kept);
    let seen = 0;
    for (let i = 0; i + toks.length <= inClip.length; i++) {
      if (!toks.every((t, k) => norm(inClip[i + k].w) === t)) continue;
      if (++seen < n) continue;
      const w = edge === "end" ? inClip[i + toks.length - 1].e : inClip[i].s;
      const t = clipMap(clipId, w);
      if (t === null) break;
      return t;
    }
    const near = inClip.slice(0, 60).map((w) => w.w).join(" ");
    return fail(path, `"${phrase}"${n > 1 ? ` (occurrence ${n})` : ""} is not spoken in the kept part of clip "${clipId}"`, near ? `Words in that clip start: ${near.slice(0, 300)}…` : undefined);
  };

  // Overlays: text components drawn with libass, animated graphics with Remotion.
  const overlays: ResolvedOverlay[] = [];
  const oids = new Set<string>();
  (tl.overlays ?? []).forEach((o, oi) => {
    const p = `overlays[${oi}]`;
    if (oids.has(o.id)) fail(`${p}.id`, `Duplicate overlay id "${o.id}"`);
    oids.add(o.id);
    const remotion = isGraphic(o.component);
    const start = resolveAnchor(o.start, `${p}.start`, clipMap);
    const timed = getConfig().features.propTimeAnchors === false ? o.props : resolvePropTimes(o.props, start, `${p}.props`, wordTime, clipMap, fps);
    const props = remotion ? validateGraphicProps(o.component, timed, p) : validateOverlayProps(o.component, timed, p);
    if (start >= duration) fail(`${p}.start`, `Overlay starts at ${r3(start)}s, after the timeline ends (${r3(duration)}s)`);
    overlays.push({ id: o.id, component: o.component, engine: remotion ? "remotion" : "ass", start: r3(start), end: r3(Math.min(duration, start + o.duration)), props, layer: o.layer ?? 1 });
  });

  // Masks (in output pixels).
  const masks: ResolvedMask[] = (tl.masks ?? []).map((m, mi) => {
    if (!hexOk(m.color)) fail(`masks[${mi}].color`, "color must be #RRGGBB");
    const start = resolveAnchor(m.start, `masks[${mi}].start`, clipMap);
    const x = even(m.rect.x * width);
    const y = even(m.rect.y * height);
    const w = even(Math.min(width - x, m.rect.w * width));
    const h = even(Math.min(height - y, m.rect.h * height));
    if (w < 4 || h < 4) fail(`masks[${mi}].rect`, "Mask is outside the frame or too small");
    return { id: m.id, start: r3(start), end: r3(Math.min(duration, start + m.duration)), rect: { x, y, w, h }, type: m.type, color: m.color, strength: m.strength };
  });

  // Layers: B-roll cutaways and picture-in-picture.
  const layers: ResolvedLayer[] = (tl.layers ?? []).map((l, li) => {
    const p = `layers[${li}]`;
    let asset: Asset;
    try {
      asset = getAsset(l.assetId);
    } catch (e) {
      fail(`${p}.assetId`, (e as Error).message);
    }
    if (asset.kind === "audio") fail(`${p}.assetId`, "A layer needs a video or image asset");
    if (!hexOk(l.borderColor)) fail(`${p}.borderColor`, "borderColor must be #RRGGBB");
    const start = resolveAnchor(l.start, `${p}.start`, clipMap);
    const end = Math.min(duration, start + l.duration);
    const pr = asset.data.probe;
    const lsrc = assetSource(asset, quality === "draft");
    const lw = quality === "draft" && lsrc !== asset.data.original ? even((pr.width * 540) / pr.height) : pr.width;
    const lh = quality === "draft" && lsrc !== asset.data.original ? 540 : pr.height;
    if (asset.kind === "video" && l.in + (end - start) * l.speed > pr.duration + 0.05) warnings.push(`${p}: layer runs past the end of ${asset.name}; it will hold the last frame.`);
    let rect: Rect;
    if (l.mode === "full") rect = { x: 0, y: 0, w: width, h: height };
    else {
      const w = even(l.rect.w * width);
      const h = even(w * (lh / lw));
      rect = { x: even(Math.min(l.rect.x * width, width - w)), y: even(Math.min(l.rect.y * height, height - h)), w, h };
    }
    return {
      id: l.id, kind: asset.kind === "image" ? "image" : "video", src: lsrc, srcW: lw, srcH: lh, in: l.in, start: r3(start), end: r3(end),
      mode: l.mode, rect, fit: l.fit, border: l.mode === "pip" ? Math.round((l.border * Math.min(width, height)) / 1080) : 0,
      borderColor: l.borderColor, lookFilters: lookFilters(mergeLook(tl.look, l.look)), volume: l.volume, speed: l.speed,
      hasAudio: asset.kind === "video" && pr.hasAudio && l.volume > 0,
    };
  });

  // Audio items (+ automatic transition sounds).
  const audio: ResolvedAudio[] = [];
  const audioItems = [...(tl.audio ?? [])];
  if (tl.sfxOnTransitions)
    transitions.forEach((tr, i) =>
      audioItems.push({ id: `auto-sfx-${i}`, library: tl.sfxOnTransitions, role: "sfx", start: { at: Math.max(0, tr.t - 0.08) }, volume: 0.7, fadeIn: 0, fadeOut: 0, loop: false }),
    );
  audioItems.forEach((au, ai) => {
    const p = `audio[${ai}]`;
    let src: string;
    let srcDur: number;
    if (au.library) {
      try {
        src = librarySound(au.library);
      } catch (e) {
        fail(`${p}.library`, (e as Error).message, (e as StudioError).hint);
      }
      srcDur = au.out ?? 600;
    } else if (au.assetId) {
      let asset: Asset;
      try {
        asset = getAsset(au.assetId);
      } catch (e) {
        fail(`${p}.assetId`, (e as Error).message);
      }
      if (!asset.data.probe.hasAudio) fail(`${p}.assetId`, `${asset.name} has no audio`);
      src = asset.data.original;
      srcDur = asset.data.probe.duration;
    } else fail(p, 'Audio item needs "assetId" or "library"');
    const start = resolveAnchor(au.start, `${p}.start`, clipMap);
    const ain = au.in ?? 0;
    const aout = au.out ?? srcDur;
    if (aout <= ain) fail(`${p}.out`, `"out" must be after "in"`);
    if (start >= duration) return;
    audio.push({ id: au.id, src, role: au.role, start: r3(start), in: ain, out: aout, volume: au.volume, fadeIn: au.fadeIn, fadeOut: au.fadeOut, loop: au.loop });
  });

  // Back-to-back clips from the same source that overlap (often after word snapping) repeat words.
  for (let i = 1; i < clipsSummary.length; i++) {
    const a = clipsSummary[i - 1];
    const b = clipsSummary[i];
    const ca = tl.clips.find((c) => c.id === a.clipId);
    const cb = tl.clips.find((c) => c.id === b.clipId);
    if (!ca || !cb || ca.assetId !== cb.assetId) continue;
    const ov = a.srcOut - b.srcIn;
    if (b.srcIn > a.srcIn && ov > 0.12)
      warnings.push(`clips "${a.clipId}" and "${b.clipId}" overlap by ${r3(ov)}s of source, so the same words may play twice. Set "snap": "frame" on both and put the cut in the pause between words.`);
  }

  return {
    name: tl.name,
    width,
    height,
    fps,
    duration: r3(duration),
    platform: tl.output.platform,
    aspect: tl.output.aspect,
    safe: safeArea(tl.output.platform, tl.output.aspect),
    brand,
    segments,
    captions,
    overlays,
    vfx,
    masks,
    layers,
    audio,
    transitions,
    mix: { targetLufs: tl.mix.targetLufs, duckMusicDb: tl.mix.duckMusicDb },
    warnings,
    clipsSummary,
    spoken,
  };
}

/** How each clip starts and ends in words: that is what decides whether it works. */
export function previewText(res: Resolved, maxChars = 200): Record<string, string> {
  const out: Record<string, string> = {};
  for (const c of res.clipsSummary) {
    const ws = res.spoken.filter((w) => w.s >= c.tlStart && w.s < c.tlEnd).map((w) => w.w);
    const s = ws.join(" ");
    out[c.clipId] = s.length > maxChars ? `${s.slice(0, maxChars / 2).trimEnd()} … ${s.slice(-maxChars / 2).trimStart()}` : s;
  }
  return out;
}

export { buildSentences };
