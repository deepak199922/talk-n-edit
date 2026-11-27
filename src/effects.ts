import fs from "node:fs";
import { packSound } from "./sounds.js";
import path from "node:path";
import { LIBRARY } from "./config.js";
import { StudioError } from "./errors.js";
import type { Look, TransitionName } from "./schema/timeline.js";

const r4 = (n: number) => Math.round(n * 10000) / 10000;

// ---------------------------------------------------------------- transitions
const XFADE: Record<Exclude<TransitionName, "cut">, string> = {
  crossfade: "fade",
  "fade-black": "fadeblack",
  "fade-white": "fadewhite",
  dissolve: "dissolve",
  "slide-left": "slideleft",
  "slide-right": "slideright",
  "slide-up": "slideup",
  "slide-down": "slidedown",
  "wipe-left": "wipeleft",
  "wipe-right": "wiperight",
  "wipe-up": "wipeup",
  "wipe-down": "wipedown",
  "whip-left": "smoothleft",
  "whip-right": "smoothright",
  "zoom-in": "zoomin",
  "circle-open": "circleopen",
  "circle-close": "circleclose",
  pixelize: "pixelize",
  radial: "radial",
  blur: "hblur",
  squeeze: "squeezeh",
};
export function xfadeName(t: TransitionName): string | null {
  return t === "cut" ? null : XFADE[t];
}

// ---------------------------------------------------------------- looks
const PRESET: Record<string, string[]> = {
  none: [],
  vivid: ["eq=saturation=1.35:contrast=1.06"],
  warm: ["colorbalance=rs=0.07:gs=0.01:bs=-0.07:rm=0.05:bm=-0.05", "eq=saturation=1.08"],
  cool: ["colorbalance=rs=-0.06:bs=0.07:rm=-0.04:bm=0.05", "eq=saturation=0.95"],
  cinematic: ["colorbalance=rs=0.06:gs=-0.01:bs=-0.06:rh=-0.04:bh=0.06", "eq=contrast=1.1:saturation=1.08:gamma=0.97", "vignette=angle=0.45"],
  "teal-orange": ["colorbalance=rs=0.1:bs=-0.08:rh=-0.06:gh=0.01:bh=0.1:rm=0.04:bm=-0.04", "eq=contrast=1.08:saturation=1.15"],
  bw: ["hue=s=0", "eq=contrast=1.12"],
  noir: ["hue=s=0", "eq=contrast=1.35:brightness=-0.03", "vignette=angle=0.6"],
  vintage: ["curves=preset=vintage", "eq=saturation=0.85", "noise=alls=8:allf=t"],
  matte: ["curves=all='0/0.08 0.5/0.5 1/0.94'", "eq=saturation=0.9"],
  moody: ["eq=brightness=-0.04:contrast=1.15:saturation=0.82", "vignette=angle=0.5"],
  bright: ["eq=brightness=0.04:gamma=1.08:saturation=1.1"],
  sepia: ["colorchannelmixer=.393:.769:.189:0:.349:.686:.168:0:.272:.534:.131"],
  punchy: ["eq=contrast=1.12:saturation=1.25", "unsharp=5:5:0.8"],
};

export function lookFilters(look?: Look): string[] {
  if (!look) return [];
  const f = [...(PRESET[look.preset ?? "none"] ?? [])];
  const eq: string[] = [];
  if (look.brightness !== undefined) eq.push(`brightness=${r4(look.brightness)}`);
  if (look.contrast !== undefined) eq.push(`contrast=${r4(look.contrast)}`);
  if (look.saturation !== undefined) eq.push(`saturation=${r4(look.saturation)}`);
  if (look.gamma !== undefined) eq.push(`gamma=${r4(look.gamma)}`);
  if (eq.length) f.push(`eq=${eq.join(":")}`);
  if (look.warmth) {
    const w = r4(look.warmth * 0.1);
    f.push(`colorbalance=rs=${w}:bs=${r4(-w)}:rm=${r4(w * 0.6)}:bm=${r4(-w * 0.6)}`);
  }
  if (look.lut) {
    const p = path.join(LIBRARY, "luts", path.basename(look.lut));
    if (!fs.existsSync(p)) throw new StudioError("INVALID_INPUT", `LUT not found: ${look.lut}`, "Put .cube files in library/luts (catalog_list luts).", "look.lut");
    // Relative to the render folder (which links library/luts as "luts"): no drive letters or
    // backslashes to escape in the filter graph, so Windows paths work too.
    const name = path.basename(look.lut);
    if (/['\\:;,\[\]]/.test(name)) throw new StudioError("INVALID_INPUT", `Rename the LUT file without quotes, colons, commas, semicolons or brackets: ${name}`, undefined, "look.lut");
    f.push(`lut3d=file='luts/${name}'`);
  }
  if (look.sharpen) f.push(`unsharp=5:5:${r4(look.sharpen * 1.5)}`);
  if (look.blur) f.push(`boxblur=${Math.max(1, Math.round(look.blur * 20))}:1`);
  if (look.vignette) f.push(`vignette=angle=${r4(0.15 + look.vignette * 0.6)}`);
  if (look.grain) f.push(`noise=alls=${Math.round(4 + look.grain * 26)}:allf=t`);
  return f;
}

export function mergeLook(base?: Look, over?: Look): Look | undefined {
  if (!base) return over;
  if (!over) return base;
  return { ...base, ...over };
}

// ---------------------------------------------------------------- zoom keyframes
export interface ZoomEvent {
  a: number; // local start (s)
  b: number; // local end (s)
  scale: number;
  x: number;
  y: number;
  ease: "smooth" | "snap" | "linear";
  ramp: number;
  /** 0..1 camera shake: the focus point wobbles (two out-of-step sines) inside the zoomed frame, so no edges show. */
  shake?: number;
}

/** zoompan z/x/y expressions for a list of zoom events on one segment (time t = on/fps). */
export function zoomExpr(events: ZoomEvent[], fps: number): { z: string; x: string; y: string } {
  const t = `(on/${fps})`;
  const terms: string[] = [];
  const xs: string[] = [];
  const ys: string[] = [];
  for (const e of events) {
    const r = e.ease === "snap" ? 1 / fps : Math.max(1 / fps, Math.min(e.ramp, (e.b - e.a) / 2));
    // envelope 0..1: up over r, hold, down over r
    let env = `clip(min((${t}-${r4(e.a)})/${r4(r)},(${r4(e.b)}-${t})/${r4(r)}),0,1)`;
    if (e.ease === "smooth") env = `(${env})*(${env})*(3-2*(${env}))`;
    terms.push(`${r4(e.scale - 1)}*${env}`);
    const sh = e.shake ? Math.min(1, Math.max(0, e.shake)) * 0.45 : 0;
    const jx = sh ? `+${r4(sh)}*(0.6*sin(2*PI*9.1*${t})+0.4*sin(2*PI*13.7*${t}+1.3))` : "";
    const jy = sh ? `+${r4(sh)}*(0.6*sin(2*PI*7.3*${t}+0.7)+0.4*sin(2*PI*11.9*${t}+2.1))` : "";
    xs.push(sh ? `between(${t},${r4(e.a)},${r4(e.b)})*clip(${r4(e.x)}${jx},0,1)` : `between(${t},${r4(e.a)},${r4(e.b)})*${r4(e.x)}`);
    ys.push(sh ? `between(${t},${r4(e.a)},${r4(e.b)})*clip(${r4(e.y)}${jy},0,1)` : `between(${t},${r4(e.a)},${r4(e.b)})*${r4(e.y)}`);
  }
  const z = `1+${terms.join("+")}`;
  // Focus point: the active event's point (0.5 when none is active).
  const active = events.map((e) => `between(${t},${r4(e.a)},${r4(e.b)})`).join("+");
  const fx = `if(gt(${active},0),(${xs.join("+")})/(${active}),0.5)`;
  const fy = `if(gt(${active},0),(${ys.join("+")})/(${active}),0.5)`;
  return { z, x: `(iw-iw/zoom)*(${fx})`, y: `(ih-ih/zoom)*(${fy})` };
}

// ---------------------------------------------------------------- audio
/** atempo only accepts 0.5..2 per instance (older ffmpeg): chain as needed. */
export function atempoChain(speed: number): string[] {
  const out: string[] = [];
  let s = speed;
  while (s > 2) {
    out.push("atempo=2");
    s /= 2;
  }
  while (s < 0.5) {
    out.push("atempo=0.5");
    s /= 0.5;
  }
  if (Math.abs(s - 1) > 1e-3) out.push(`atempo=${r4(s)}`);
  return out;
}

export function voiceFilters(fx?: { denoise?: boolean; enhance?: boolean }): string[] {
  const f: string[] = [];
  if (fx?.denoise) f.push("afftdn=nf=-25:tn=1");
  if (fx?.enhance) f.push("highpass=f=80", "lowpass=f=13000", "acompressor=threshold=0.1:ratio=3:attack=10:release=200:makeup=1.6", "deesser");
  return f;
}

// ---------------------------------------------------------------- library sounds
export function librarySound(ref: string): string {
  const clean = ref.replace(/\\/g, "/").replace(/^\/+/, "");
  if (clean.startsWith("packs/")) {
    const p = packSound(clean);
    if (p) return p;
    throw new StudioError("INVALID_INPUT", `Bad pack sound "${ref}"`, 'Use "packs/<pack>/<name>" from catalog_list sfx.');
  }
  if (clean.includes("..") || clean.includes(":")) throw new StudioError("INVALID_INPUT", `Bad library path ${ref}`);
  const base = path.join(LIBRARY, clean);
  for (const ext of ["", ".wav", ".mp3", ".m4a", ".aac", ".flac", ".ogg"]) {
    if (fs.existsSync(base + ext) && fs.statSync(base + ext).isFile()) return base + ext;
  }
  throw new StudioError("INVALID_INPUT", `No library sound "${ref}"`, "See catalog_list sfx / music.");
}

export function listLibrary(dir: "sfx" | "music" | "luts") {
  const d = path.join(LIBRARY, dir);
  if (!fs.existsSync(d)) return [];
  return fs
    .readdirSync(d)
    .filter((f) => !f.startsWith(".") && !f.endsWith(".txt") && !f.endsWith(".md"))
    .map((f) => (dir === "luts" ? f : `${dir}/${f.replace(/\.(wav|mp3|m4a|aac|flac|ogg)$/i, "")}`));
}
