/**
 * timeline_preview: still pictures of a timeline at chosen moments, without rendering the whole video.
 * Each picture goes through the same ffmpeg graph as a render (cuts, framing, zooms, look, masks, layers, captions)
 * with each animated graphic drawn for that one frame only, so what you see is what the render will show.
 */
import fs from "node:fs";
import path from "node:path";
import { buildAss } from "./ass.js";
import { dirs, LIBRARY } from "./config.js";
import { StudioError } from "./errors.js";
import { ffmpeg, r3 } from "./ffmpeg.js";
import { linkDir } from "./platform.js";
import { renderStack } from "./remotion.js";
import { BATCH, buildCommand, graphicFrames } from "./render.js";
import { resolveTimeline } from "./resolve.js";
import { getTimeline } from "./store.js";

export async function previewStills(timelineId: string, version: number | undefined, times: number[], quality: "draft" | "final", signal?: AbortSignal) {
  const tl = getTimeline(timelineId, version);
  const res = resolveTimeline(tl.json, quality);
  if (res.segments.length > BATCH)
    throw new StudioError("INVALID_INPUT", `This timeline has ${res.segments.length} cuts; previews handle up to ${BATCH}.`, "Render a draft instead.");
  const dir = path.join(dirs.tmp(), `preview-${Date.now()}-${process.pid}`);
  fs.mkdirSync(dir, { recursive: true });
  const ass = buildAss(res);
  let assFile: string | null = null;
  if (ass) {
    assFile = path.join(dir, "captions.ass");
    fs.writeFileSync(assFile, ass);
    linkDir(path.join(LIBRARY, "fonts"), path.join(dir, "fonts"));
  }
  if (fs.existsSync(path.join(LIBRARY, "luts"))) linkDir(path.join(LIBRARY, "luts"), path.join(dir, "luts"));

  const frames: Array<{ t: number; path: string; graphics: string[] }> = [];
  for (const [n, t0] of times.entries()) {
    const fi = Math.max(0, Math.min(Math.round(t0 * res.fps), Math.floor(res.duration * res.fps) - 1));
    const t = fi / res.fps;
    // Graphics showing at t, bottom first (same order as a render), each at its own frame.
    // Same frame a render shows: frame 0 at floor(start × fps), for graphicFrames frames.
    const nth = (o: { start: number }) => fi - Math.floor(o.start * res.fps + 1e-6);
    const live = res.overlays
      .map((o, i) => ({ o, i }))
      .filter(({ o }) => o.engine === "remotion" && nth(o) >= 0 && nth(o) < graphicFrames(o.start, o.end, res.fps))
      .sort((p, q) => p.o.layer - q.o.layer || p.i - q.i)
      .map(({ o }) => o);
    const graphics: Array<{ dir: string; pattern: string; start: number; frames: number; layer: number }> = [];
    if (live.length) {
      const gdir = path.join(dir, `g${n}`);
      // Stack frame 0 = this moment: each layer starts nth(o) frames before it. The stack is as long as the
      // longest remaining layer so no layer is shortened (that would trigger its exit animation early).
      const layers = live.map((o) => ({
        spec: { component: o.component, props: o.props, width: res.width, height: res.height, fps: res.fps, frames: graphicFrames(o.start, o.end, res.fps), brand: res.brand },
        from: -nth(o),
      }));
      const length = Math.max(1, ...layers.map((l) => l.from + l.spec.frames));
      const r = await renderStack(layers, length, gdir, signal, undefined, 0);
      graphics.push({ dir: gdir, pattern: r.pattern, start: t, frames: 1, layer: 0 });
    }
    const args = buildCommand(res, assFile, path.join(dir, "unused.mkv"), "draft", undefined, graphics, false);
    const fc = args.indexOf("-filter_complex");
    const mapAt = args.indexOf("-map");
    const vfinal = args[mapAt + 1];
    const aout = args[mapAt + 3];
    const out = path.join(dir, `t${String(n).padStart(2, "0")}-${r3(t)}.jpg`);
    // Seek to just before the frame (rounding down), so the frame itself is kept, even the very last one.
    const ss = Math.floor(t * 1000) / 1000;
    const run = [...args.slice(0, fc), "-filter_complex", `${args[fc + 1]};\n${aout}anullsink`, "-map", vfinal, "-ss", String(ss), "-frames:v", "1", "-q:v", "3", out];
    await ffmpeg(run, { cwd: dir, signal, label: "ffmpeg preview" });
    if (!fs.existsSync(out)) throw new StudioError("ENGINE_FAILED", `No picture came out for ${r3(t)}s`);
    frames.push({ t: r3(t), path: out, graphics: live.map((o) => o.id) });
  }
  return { timelineId: tl.id, version: tl.version, size: `${res.width}x${res.height}`, frames };
}
