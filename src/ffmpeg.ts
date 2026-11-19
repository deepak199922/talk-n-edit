import { ffmpegBin } from "./config.js";
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
export const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
