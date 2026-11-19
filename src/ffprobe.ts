import { ffprobeBin } from "./config.js";
import { StudioError } from "./errors.js";
import { run } from "./proc.js";

export interface Probe {
  duration: number;
  hasVideo: boolean;
  hasAudio: boolean;
  /** Display width/height (rotation applied). */
  width: number;
  height: number;
  fps: number;
  avgFps: number;
  vfr: boolean;
  videoCodec?: string;
  audioCodec?: string;
  rotation: number;
  sizeBytes: number;
  formatName: string;
}

function rate(s?: string): number {
  if (!s) return 0;
  const [a, b] = s.split("/").map(Number);
  return b ? a / b : a || 0;
}

export async function probe(file: string): Promise<Probe> {
  let out;
  try {
    out = await run(ffprobeBin(), ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file], {
      label: "ffprobe",
      timeoutMs: 60_000,
    });
  } catch (e) {
    throw new StudioError("INVALID_INPUT", `Not a readable media file: ${file}`, (e as StudioError).hint);
  }
  const j = JSON.parse(out.stdout);
  const streams: any[] = j.streams ?? [];
  const v = streams.find((s) => s.codec_type === "video" && !(s.disposition?.attached_pic === 1));
  const a = streams.find((s) => s.codec_type === "audio");
  let rotation = 0;
  if (v) {
    const sd = (v.side_data_list ?? []).find((d: any) => d.rotation !== undefined);
    rotation = Number(sd?.rotation ?? v.tags?.rotate ?? 0);
    rotation = ((Math.round(rotation) % 360) + 360) % 360;
  }
  let width = Number(v?.width ?? 0);
  let height = Number(v?.height ?? 0);
  if (rotation === 90 || rotation === 270) [width, height] = [height, width];
  const fps = rate(v?.r_frame_rate);
  const avgFps = rate(v?.avg_frame_rate) || fps;
  let vfr = !!v && fps > 0 && Math.abs(fps - avgFps) / fps > 0.005;
  if (v && !vfr) vfr = await jitteryTimestamps(file);
  const duration = Number(j.format?.duration ?? v?.duration ?? a?.duration ?? 0);
  return {
    duration,
    hasVideo: !!v,
    hasAudio: !!a,
    width,
    height,
    fps: Math.round(fps * 1000) / 1000,
    avgFps: Math.round(avgFps * 1000) / 1000,
    vfr,
    videoCodec: v?.codec_name,
    audioCodec: a?.codec_name,
    rotation,
    sizeBytes: Number(j.format?.size ?? 0),
    formatName: j.format?.format_name ?? "",
  };
}

/** Look at the first ~150 video timestamps: uneven frame spacing means variable frame rate. */
async function jitteryTimestamps(file: string): Promise<boolean> {
  try {
    const out = await run(
      ffprobeBin(),
      ["-v", "error", "-select_streams", "v:0", "-read_intervals", "%+#150", "-show_entries", "packet=pts_time", "-of", "csv=p=0", file],
      { label: "ffprobe", timeoutMs: 30_000 },
    );
    const t = out.stdout.split("\n").filter((x) => x.trim() !== "").map(Number).filter((x) => isFinite(x)).sort((a, b) => a - b);
    // Packets arrive in decode order, so the last few display times can be missing: ignore the tail.
    const head = t.slice(0, Math.floor(t.length * 0.8));
    if (head.length < 20) return false;
    const d = head.slice(1).map((x, i) => x - head[i]).filter((x) => x > 0);
    const med = [...d].sort((a, b) => a - b)[Math.floor(d.length / 2)];
    const off = d.filter((x) => Math.abs(x - med) / med > 0.1).length;
    return off / d.length > 0.1;
  } catch {
    return false;
  }
}
