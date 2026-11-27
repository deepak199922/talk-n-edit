import { spawnSync } from "node:child_process";
import { ffmpegBin, getConfig } from "./config.js";
import { run, RunResult } from "./proc.js";

export interface FfOpts {
  /** Expected output duration in seconds, for progress. */
  duration?: number;
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
  cwd?: string;
  label?: string;
  timeoutMs?: number;
}

/** Run ffmpeg with progress reporting. args must not include -progress. */
export function ffmpeg(args: string[], opts: FfOpts = {}): Promise<RunResult> {
  const full = ["-hide_banner", "-nostdin", "-y", "-progress", "pipe:1", "-nostats", ...args];
  return run(ffmpegBin(), full, {
    cwd: opts.cwd,
    signal: opts.signal,
    label: opts.label ?? "ffmpeg",
    timeoutMs: opts.timeoutMs,
    onStdoutLine: (line) => {
      if (!opts.onProgress || !opts.duration) return;
      const m = /^out_time_(?:us|ms)=(\d+)/.exec(line);
      if (m) opts.onProgress(Math.min(1, Number(m[1]) / 1e6 / opts.duration));
    },
  });
}

/** Quote a value for use inside an ffmpeg filtergraph option. */
export function fq(s: string): string {
  return "'" + s.replace(/\\/g, "\\\\").replace(/'/g, "'\\\\''").replace(/:/g, "\\:") + "'";
}

export const r3 = (n: number) => Math.round(n * 1000) / 1000;

const encoderCache = new Map<string, boolean>();
/** Whether this ffmpeg build has the named encoder (e.g. h264_videotoolbox). Checked once per process. */
export function hasEncoder(name: string): boolean {
  if (encoderCache.has(name)) return encoderCache.get(name)!;
  let ok = false;
  try {
    const r = spawnSync(ffmpegBin(), ["-hide_banner", "-encoders"], { encoding: "utf8", timeout: 15000 });
    ok = new RegExp(`\\s${name}\\s`).test(r.stdout ?? "");
  } catch {
    ok = false;
  }
  encoderCache.set(name, ok);
  return ok;
}
export const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

const shapingSupport = new Map<string, boolean>();
/** Does this ffmpeg's `ass` filter take a `shaping` option? Checked once per ffmpeg binary; any doubt counts as no. */
export function assShapingSupported(bin = ffmpegBin()): boolean {
  const known = shapingSupport.get(bin);
  if (known !== undefined) return known;
  let ok = false;
  try {
    const r = spawnSync(bin, ["-hide_banner", "-h", "filter=ass"], { encoding: "utf8", timeout: 15000, windowsHide: true });
    ok = r.status === 0 && /^\s*shaping\b/m.test(r.stdout ?? "") && /\bcomplex\b/.test(r.stdout ?? "");
  } catch {
    ok = false;
  }
  shapingSupport.set(bin, ok);
  return ok;
}

/**
 * The filter that burns the captions file in. ffmpeg's `subtitles` filter runs libass with simple shaping, which
 * puts Indic vowel signs (Gurmukhi ਿ, Devanagari ि) in the wrong place; the `ass` filter with shaping=complex shapes
 * them properly. Falls back to the old `subtitles` filter when the switch is off or this ffmpeg can't do it.
 */
export function captionFilter(assBase: string): string {
  if (getConfig().features.shapedCaptions && assShapingSupported()) return `ass=filename=${assBase}:fontsdir=fonts:shaping=complex`;
  return `subtitles=filename=${assBase}:fontsdir=fonts`;
}
