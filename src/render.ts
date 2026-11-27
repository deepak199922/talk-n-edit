import fs from "node:fs";
import path from "node:path";
import { buildAss } from "./ass.js";
import { dirs, getConfig, LIBRARY } from "./config.js";
import { now } from "./db.js";
import { atempoChain, lookFilters, voiceFilters, zoomExpr } from "./effects.js";
import { linkDir } from "./platform.js";
import { StudioError } from "./errors.js";
import { captionFilter, ffmpeg, hasEncoder, r3 } from "./ffmpeg.js";
import { probe } from "./ffprobe.js";
import { newId, slug } from "./ids.js";
import { enqueue, JobContext } from "./jobs.js";
import { assertWritable } from "./paths.js";
import { quickQa } from "./qa.js";
import { cacheWarning, drawGraphics } from "./gcache.js";
import { soundCredit } from "./sounds.js";
import { Resolved, resolveTimeline, Segment } from "./resolve.js";
import { getProject, getRender, getTimeline, insertRender, updateRender } from "./store.js";

const AFMT = "aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo";
export const BATCH = 20;

const hex = (c: string) => `0x${c.replace("#", "")}`;

function layoutFilters(seg: Segment, res: Resolved, L: string, base: string, parts: string[]): string {
  const { width: W, height: H } = res;
  if (seg.layout === "fit") {
    const tr = seg.fit?.trim;
    if (tr && tr.top + tr.bottom + tr.left + tr.right > 0) {
      const cw = Math.max(16, Math.round((seg.srcW * (1 - tr.left - tr.right)) / 2) * 2);
      const ch = Math.max(16, Math.round((seg.srcH * (1 - tr.top - tr.bottom)) / 2) * 2);
      base += `,crop=${cw}:${ch}:${Math.round(seg.srcW * tr.left)}:${Math.round(seg.srcH * tr.top)}`;
    }
    if (seg.fit?.background === "black") {
      return `${base},scale=${W}:${H}:force_original_aspect_ratio=decrease:flags=lanczos,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:black`;
    }
    parts.push(
      `${base},split=2[${L}a][${L}b]`,
      `[${L}a]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},boxblur=luma_radius=${Math.round(Math.min(W, H) / 25)}:luma_power=2,eq=brightness=-0.06[${L}bg]`,
      `[${L}b]scale=${W}:${H}:force_original_aspect_ratio=decrease[${L}fg]`,
    );
    return `[${L}bg][${L}fg]overlay=(W-w)/2:(H-h)/2`;
  }
  if (seg.layout === "split") {
    const [r1, r2] = seg.split!;
    const h2 = Math.round(H / 4) * 2;
    parts.push(
      `${base},split=2[${L}a][${L}b]`,
      `[${L}a]crop=${r1.w}:${r1.h}:${r1.x}:${r1.y},scale=${W}:${h2}[${L}t]`,
      `[${L}b]crop=${r2.w}:${r2.h}:${r2.x}:${r2.y},scale=${W}:${H - h2}[${L}u]`,
    );
    return `[${L}t][${L}u]vstack=inputs=2`;
  }
  const c = seg.crop!;
  return `${base},crop=${c.w}:${c.h}:${c.x}:${c.y},scale=${W}:${H}:flags=lanczos`;
}

/** Filters for one segment; its input index is k. Produces [v{k}] and [a{k}]. */
function segmentFilters(seg: Segment, k: number, res: Resolved, quality: "draft" | "final"): { inputs: string[]; graph: string } {
  const { width: W, height: H, fps } = res;
  const N = seg.frames;
  const D = r3(N / fps);
  const inputs: string[] = [];
  const parts: string[] = [];
  const L = `s${k}`;
  const look = lookFilters(seg.look);
  let v: string;
  if (seg.kind === "image") {
    inputs.push("-loop", "1", "-framerate", String(fps), "-t", String(r3(D + 0.5)), "-i", seg.src);
    const c = seg.crop!;
    const S = 0.08 + 0.2 * (seg.motion?.strength ?? 0.5);
    const z = seg.motion?.type === "kenburns-out" ? `${1 + S}-${S}*on/${N}` : `1+${S}*on/${N}`;
    const pre = seg.layout === "fit" ? `scale=${W * 2}:${H * 2}:force_original_aspect_ratio=decrease,pad=${W * 2}:${H * 2}:(ow-iw)/2:(oh-ih)/2:black` : `crop=${c.w}:${c.h}:${c.x}:${c.y},scale=${W * 2}:${H * 2}`;
    v = `[${k}:v]${pre},zoompan=z='${z}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${W}x${H}:fps=${fps}`;
    if (look.length) v += `,${look.join(",")}`;
  } else if (seg.kind === "freeze") {
    inputs.push("-ss", String(r3(seg.srcIn)), "-t", "0.5", "-i", seg.src);
    v = layoutFilters(seg, res, L, `[${k}:v]trim=end_frame=1,setpts=PTS-STARTPTS`, parts);
    if (look.length) v += `,${look.join(",")}`;
    v += `,fps=${fps},tpad=stop_mode=clone:stop=${N}`;
    if (seg.flash) v += `,fade=t=in:st=0:d=0.3:color=white`;
  } else {
    inputs.push("-ss", String(r3(seg.srcIn)), "-t", String(r3(seg.srcDur + (seg.reverse ? 0 : 0.5))), "-i", seg.src);
    let base = `[${k}:v]setpts=PTS-STARTPTS`;
    if (seg.reverse) base += ",reverse";
    if (seg.stabilize) base += ",deshake";
    if (seg.speed !== 1) base += `,setpts=PTS/${seg.speed}`;
    v = layoutFilters(seg, res, L, base, parts);
    if (look.length) v += `,${look.join(",")}`;
  }
  v += `,fps=${fps},scale=out_range=tv,format=yuv420p,setsar=1`;
  if (seg.zooms?.length) {
    const ze = zoomExpr(seg.zooms, fps);
    const up = quality === "final" ? `scale=${W * 2}:${H * 2}:flags=bicubic,` : "";
    v += `,${up}zoompan=z='${ze.z}':x='${ze.x}':y='${ze.y}':d=1:s=${W}x${H}:fps=${fps}`;
  }
  v += `,tpad=stop_mode=clone:stop_duration=1,trim=end_frame=${N},setpts=PTS-STARTPTS,settb=AVTB`;
  parts.push(`${v}[v${k}]`);

  let a: string;
  if (seg.kind === "video" && seg.hasAudio) {
    a = `[${k}:a]asetpts=PTS-STARTPTS`;
    if (seg.reverse) a += ",areverse";
    const tempo = atempoChain(seg.speed);
    if (tempo.length) a += `,${tempo.join(",")}`;
    a += `,${AFMT}`;
    const vf = voiceFilters(seg.audioFx);
    if (vf.length) a += `,${vf.join(",")}`;
    a += `,volume=${seg.volume},apad,atrim=0:${D},asetpts=PTS-STARTPTS`;
  } else a = `anullsrc=r=48000:cl=stereo,atrim=0:${D},asetpts=PTS-STARTPTS`;
  parts.push(`${a}[a${k}]`);
  return { inputs, graph: parts.join(";\n") };
}

interface JoinItem {
  v: string;
  a: string;
  frames: number;
  trans?: { xfade: string; frames: number };
}

/** Join streams in order: consecutive cuts are concatenated; transitions overlap with xfade/acrossfade. */
function joinItems(items: JoinItem[], fps: number, graph: string[], prefix: string): { v: string; a: string; frames: number } {
  // Group into runs separated by transitions.
  const runs: Array<{ items: JoinItem[]; trans?: JoinItem["trans"] }> = [];
  for (const it of items) {
    if (!runs.length || it.trans) runs.push({ items: [it], trans: runs.length ? it.trans : undefined });
    else runs[runs.length - 1].items.push(it);
  }
  const runOut = runs.map((r, i) => {
    if (r.items.length === 1) return { v: r.items[0].v, a: r.items[0].a, frames: r.items[0].frames };
    const v = `[${prefix}rv${i}]`;
    const a = `[${prefix}ra${i}]`;
    graph.push(`${r.items.map((x) => `${x.v}${x.a}`).join("")}concat=n=${r.items.length}:v=1:a=1${v.replace("]", "c]")}${a.replace("]", "c]")}`);
    graph.push(`${v.replace("]", "c]")}settb=AVTB${v}`);
    graph.push(`${a.replace("]", "c]")}anull${a}`);
    return { v, a, frames: r.items.reduce((n, x) => n + x.frames, 0) };
  });
  let cur = runOut[0];
  for (let i = 1; i < runOut.length; i++) {
    const tr = runs[i].trans!;
    const D = tr.frames / fps;
    const offset = (cur.frames - tr.frames) / fps;
    const v = `[${prefix}xv${i}]`;
    const a = `[${prefix}xa${i}]`;
    graph.push(`${cur.v}${runOut[i].v}xfade=transition=${tr.xfade}:duration=${r3(D)}:offset=${r3(offset)}${v}`);
    graph.push(`${cur.a}${runOut[i].a}acrossfade=d=${r3(D)}:c1=tri:c2=tri${a}`);
    cur = { v, a, frames: cur.frames + runOut[i].frames - tr.frames };
  }
  return cur;
}

const segItem = (seg: Segment, k: number): JoinItem => ({
  v: `[v${k}]`,
  a: `[a${k}]`,
  frames: seg.frames,
  trans: seg.transIn ? { xfade: seg.transIn.xfade, frames: seg.transIn.frames } : undefined,
});

/** Render a run of segments (at most BATCH) to one intermediate file. */
export function buildBatchCommand(res: Resolved, segs: Segment[], outFile: string, quality: "draft" | "final", first: boolean) {
  const inputs: string[] = [];
  const graph: string[] = [];
  segs.forEach((seg, k) => {
    const f = segmentFilters(seg, k, res, quality);
    inputs.push(...f.inputs);
    graph.push(f.graph);
  });
  // The batch's own first transition is applied when batches are joined.
  const items = segs.map((s, k) => segItem(s, k));
  if (!first) items[0] = { ...items[0], trans: undefined };
  const out = joinItems(items, res.fps, graph, "b");
  return {
    frames: out.frames,
    args: [
      ...inputs,
      "-filter_complex", graph.join(";\n"),
      "-map", out.v, "-map", out.a,
      "-c:v", "libx264", "-preset", "ultrafast", "-crf", "12", "-pix_fmt", "yuv420p", "-color_range", "tv", "-r", String(res.fps),
      "-c:a", "pcm_s16le", "-ar", "48000",
      outFile,
    ],
  };
}

export interface GraphicInput {
  dir: string;
  pattern: string;
  start: number;
  frames: number;
  layer: number;
}

/**
 * Main pass. Without batches every segment is an input; with batches (long, heavily cut timelines) the
 * pre-rendered batches are joined instead. Then: masks → layers (B-roll / PiP) → graphics → captions/text.
 */
export function buildCommand(
  res: Resolved,
  assFile: string | null,
  outFile: string,
  quality: "draft" | "final",
  batches?: Array<{ file: string; frames: number; trans?: { xfade: string; frames: number } }>,
  graphics: GraphicInput[] = [],
  hwDraft = false,
) {
  const inputs: string[] = [];
  const graph: string[] = [];
  let n = 0;
  let joined: { v: string; a: string; frames: number };
  if (batches?.length) {
    const items: JoinItem[] = batches.map((b, k) => {
      inputs.push("-i", b.file);
      graph.push(`[${k}:v]settb=AVTB[bv${k}]`);
      return { v: `[bv${k}]`, a: `[${k}:a]`, frames: b.frames, trans: k ? b.trans : undefined };
    });
    n = batches.length;
    joined = joinItems(items, res.fps, graph, "m");
  } else {
    res.segments.forEach((seg, k) => {
      const f = segmentFilters(seg, k, res, quality);
      inputs.push(...f.inputs);
      graph.push(f.graph);
    });
    n = res.segments.length;
    joined = joinItems(res.segments.map((s, k) => segItem(s, k)), res.fps, graph, "m");
  }
  let cur = joined.v;
  let step = 0;
  const next = () => `[st${step++}]`;
  const W = res.width;
  const H = res.height;

  // Masks
  for (const m of res.masks) {
    const en = `enable='between(t,${m.start},${m.end})'`;
    const { x, y, w, h } = m.rect;
    const out = next();
    if (m.type === "box") graph.push(`${cur}drawbox=x=${x}:y=${y}:w=${w}:h=${h}:color=${hex(m.color)}@1:t=fill:${en}${out}`);
    else {
      const a = next();
      const b = next();
      const c = next();
      graph.push(`${cur}split=2${a}${b}`);
      const eff =
        m.type === "blur"
          ? (() => {
              const r = Math.max(2, Math.min(Math.floor(Math.min(w, h) / 2) - 1, Math.round(Math.min(w, h) * 0.05 + m.strength * Math.min(w, h) * 0.12)));
              const cr = Math.max(1, Math.min(Math.floor(Math.min(w, h) / 4) - 1, Math.round(r / 2)));
              return `boxblur=luma_radius=${r}:luma_power=3:chroma_radius=${cr}:chroma_power=3`;
            })()
          : `scale=${Math.max(2, Math.round(w / (6 + m.strength * 30)))}:-2:flags=neighbor,scale=${w}:${h}:flags=neighbor`;
      graph.push(`${b}crop=${w}:${h}:${x}:${y},${eff}${c}`);
      graph.push(`${a}${c}overlay=${x}:${y}:${en}${out}`);
    }
    cur = out;
  }

  // Layers (B-roll cutaways and picture-in-picture)
  let idx = n;
  const extraVoice: string[] = [];
  for (const l of res.layers) {
    const dur = r3(l.end - l.start);
    if (l.kind === "image") inputs.push("-loop", "1", "-framerate", String(res.fps), "-t", String(r3(dur + 0.5)), "-i", l.src);
    else inputs.push("-ss", String(r3(l.in)), "-t", String(r3(dur * l.speed + 0.5)), "-i", l.src);
    const { w, h } = l.rect;
    const fit =
      l.fit === "fit"
        ? `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:black`
        : `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}`;
    let chain = `[${idx}:v]setpts=PTS-STARTPTS${l.speed !== 1 ? `,setpts=PTS/${l.speed}` : ""},${fit}`;
    if (l.lookFilters.length) chain += `,${l.lookFilters.join(",")}`;
    chain += `,fps=${res.fps},scale=out_range=tv,format=yuv420p`;
    if (l.border) chain += `,pad=${w + 2 * l.border}:${h + 2 * l.border}:${l.border}:${l.border}:color=${hex(l.borderColor)}`;
    chain += `,tpad=stop_mode=clone:stop_duration=${r3(dur + 1)},trim=duration=${dur},setpts=PTS-STARTPTS+${l.start}/TB`;
    const lv = `[lv${idx}]`;
    graph.push(chain + lv);
    const out = next();
    graph.push(`${cur}${lv}overlay=${Math.max(0, l.rect.x - l.border)}:${Math.max(0, l.rect.y - l.border)}:eof_action=pass:enable='between(t,${l.start},${l.end})'${out}`);
    cur = out;
    if (l.hasAudio) {
      const ms = Math.round(l.start * 1000);
      const tempo = atempoChain(l.speed);
      graph.push(`[${idx}:a]asetpts=PTS-STARTPTS${tempo.length ? `,${tempo.join(",")}` : ""},${AFMT},atrim=0:${dur},volume=${l.volume},adelay=${ms}|${ms},apad,atrim=0:${res.duration}[la${idx}]`);
      extraVoice.push(`[la${idx}]`);
    }
    idx++;
  }

  // Video effects for a stretch of time (drawn over the picture, under graphics and captions).
  for (const v of res.vfx ?? []) {
    const f = vfxFilters(v, res.width);
    if (!f.length) continue;
    const out = next();
    graph.push(`${cur}${f.join(",")}${out}`);
    cur = out;
  }

  // Animated graphics (transparent PNG sequences from Remotion)
  for (const g of [...graphics].sort((p, q) => p.layer - q.layer)) {
    inputs.push("-framerate", String(res.fps), "-start_number", "0", "-i", path.join(g.dir, g.pattern));
    const gv = `[gv${idx}]`;
    graph.push(`[${idx}:v]format=rgba,setpts=PTS-STARTPTS+${g.start}/TB${gv}`);
    const out = next();
    graph.push(`${cur}${gv}overlay=0:0:eof_action=pass:format=auto${out}`);
    cur = out;
    idx++;
  }

  if (assFile) {
    const out = next();
    graph.push(`${cur}${captionFilter(path.basename(assFile))}${out}`);
    cur = out;
  }
  const vfinal = next();
  graph.push(`${cur}scale=out_range=tv,format=yuv420p${vfinal}`);

  // Audio: voice bus (+ layer audio, sfx, voice items), music ducked under it.
  const D = res.duration;
  const voice: string[] = [joined.a, ...extraVoice];
  const music: string[] = [];
  for (const au of res.audio) {
    const len = au.loop ? D - au.start : Math.min(au.out - au.in, D - au.start);
    if (len <= 0.05) continue;
    if (au.loop) inputs.push("-stream_loop", "-1");
    inputs.push("-ss", String(r3(au.in)), "-i", au.src);
    const ms = Math.round(au.start * 1000);
    let chain = `[${idx}:a]${AFMT},atrim=0:${r3(len)},asetpts=PTS-STARTPTS,volume=${au.volume}`;
    if (au.fadeIn) chain += `,afade=t=in:st=0:d=${au.fadeIn}`;
    if (au.fadeOut) chain += `,afade=t=out:st=${r3(Math.max(0, len - au.fadeOut))}:d=${au.fadeOut}`;
    chain += `,adelay=${ms}|${ms},apad,atrim=0:${D}[x${idx}]`;
    graph.push(chain);
    (au.role === "music" ? music : voice).push(`[x${idx}]`);
    idx++;
  }
  let aout = joined.a;
  if (voice.length > 1) {
    graph.push(`${voice.join("")}amix=inputs=${voice.length}:normalize=0:duration=first[vbus]`);
    aout = "[vbus]";
  }
  if (music.length) {
    const mbus = music.length > 1 ? "[mbus]" : music[0];
    if (music.length > 1) graph.push(`${music.join("")}amix=inputs=${music.length}:normalize=0:duration=longest[mbus]`);
    const ratio = Math.max(2, Math.min(20, -res.mix.duckMusicDb / 1.5));
    graph.push(`${aout}asplit=2[vmain][vsc]`);
    graph.push(`${mbus}[vsc]sidechaincompress=threshold=0.02:ratio=${r3(ratio)}:attack=15:release=400[mduck]`);
    graph.push(`[vmain][mduck]amix=inputs=2:normalize=0:duration=first[amix]`);
    aout = "[amix]";
  }
  const x264 = quality === "final" ? ["-preset", "medium", "-crf", "18"] : ["-preset", "veryfast", "-crf", "28"];
  // Drafts only: the Mac's hardware encoder at a generous bitrate. Finals always use x264.
  const venc = quality === "draft" && hwDraft ? ["-c:v", "h264_videotoolbox", "-b:v", `${Math.max(3, Math.round((res.width * res.height) / 90000))}M`] : ["-c:v", "libx264", ...x264];
  return [
    ...inputs,
    "-filter_complex", graph.join(";\n"),
    "-map", vfinal, "-map", aout,
    ...venc, "-profile:v", "high", "-pix_fmt", "yuv420p",
    "-color_range", "tv", "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709",
    "-r", String(res.fps), "-g", String(res.fps * 2),
    "-c:a", "pcm_s16le", "-ar", "48000",
    "-t", String(res.duration),
    outFile,
  ];
}

/** ffmpeg filters for one video effect, each switched on only between its start and end. */
export function vfxFilters(v: { type: string; start: number; end: number; intensity: number; color?: string }, width: number): string[] {
  const k = Math.max(0, Math.min(1, v.intensity));
  const on = (expr = "") => `enable='between(t,${v.start},${v.end})${expr}'`;
  const px = (f: number) => Math.max(1, Math.round(width * f * (0.3 + k)));
  switch (v.type) {
    case "flash": {
      // Bright at the start, fading out in four steps over the effect's length.
      const c = (v.color ?? "#FFFFFF").replace("#", "0x");
      const d = (v.end - v.start) / 4;
      return [0, 1, 2, 3].map((i) => {
        const a = Math.round((0.35 + 0.6 * k) * (1 - i / 4) * 100) / 100;
        const s = Math.round((v.start + i * d) * 1000) / 1000;
        const e = Math.round((v.start + (i + 1) * d) * 1000) / 1000;
        return `drawbox=x=0:y=0:w=iw:h=ih:color=${c}@${a}:t=fill:enable='between(t,${s},${e})'`;
      });
    }
    case "rgbSplit":
      return [`rgbashift=rh=-${px(0.006)}:bh=${px(0.006)}:${on()}`];
    case "glitch": {
      const flick = "*lt(mod(t*12,1),0.55)";
      return [`rgbashift=rh=-${px(0.012)}:gv=${px(0.004)}:bh=${px(0.01)}:${on(flick)}`, `noise=alls=${Math.round(10 + 30 * k)}:allf=t+u:${on(flick)}`, `eq=contrast=${(1.1 + 0.3 * k).toFixed(2)}:${on(flick)}`];
    }
    case "blur":
      return [`gblur=sigma=${(3 + 25 * k).toFixed(1)}:${on()}`];
    case "vignette":
      return [`vignette=angle=${(0.35 + 0.6 * k).toFixed(2)}:${on()}`];
    case "blackWhite":
      return [`hue=s=${(1 - k).toFixed(2)}:${on()}`];
    case "invert":
      return [`negate=${on()}`];
    case "punch":
      return [`eq=contrast=${(1 + 0.35 * k).toFixed(2)}:saturation=${(1 + 0.6 * k).toFixed(2)}:${on()}`];
    case "ghost":
      return [`lagfun=decay=${(0.8 + 0.18 * k).toFixed(2)}:${on()}`];
    case "motionBlur":
      return [`tmix=frames=${2 + Math.round(4 * k)}:${on()}`];
    case "letterbox": {
      const h = `ih*${(0.06 + 0.08 * k).toFixed(3)}`;
      return [`drawbox=x=0:y=0:w=iw:h=${h}:color=black:t=fill:${on()}`, `drawbox=x=0:y=ih-${h}:w=iw:h=${h}:color=black:t=fill:${on()}`];
    }
    case "grain":
      return [`noise=alls=${Math.round(6 + 24 * k)}:allf=t:${on()}`];
    default:
      return [];
  }
}

function parseLoudnorm(stderr: string): Record<string, string> | null {
  const i = stderr.lastIndexOf("{");
  const j = stderr.lastIndexOf("}");
  if (i < 0 || j < i) return null;
  try {
    return JSON.parse(stderr.slice(i, j + 1));
  } catch {
    return null;
  }
}

function uniquePath(dir: string, base: string): string {
  let p = path.join(dir, `${base}.mp4`);
  let n = 2;
  while (fs.existsSync(p)) p = path.join(dir, `${base}-v${n++}.mp4`);
  return p;
}

export interface RenderJobInput {
  renderId: string;
}

export async function renderJob(input: RenderJobInput, ctx: JobContext) {
  const rnd = getRender(input.renderId);
  const tl = getTimeline(rnd.timeline_id, rnd.version);
  const dir = rnd.dir;
  fs.mkdirSync(dir, { recursive: true });
  updateRender(rnd.id, "running", { ...rnd.data, jobId: ctx.jobId });
  ctx.progress("resolving timeline", 0.01);
  const res = resolveTimeline(tl.json, rnd.quality);
  fs.writeFileSync(path.join(dir, "resolved.json"), JSON.stringify(res, null, 1));
  // Where every sound came from, and its licence (credits.json in the render folder).
  const credits = renderCredits(tl.json as any);
  try {
    fs.writeFileSync(path.join(dir, "credits.json"), JSON.stringify(credits, null, 1));
  } catch {
    /* informational only */
  }
  const ass = buildAss(res);
  let assFile: string | null = null;
  if (ass) {
    assFile = path.join(dir, "captions.ass");
    fs.writeFileSync(assFile, ass);
    linkDir(path.join(LIBRARY, "fonts"), path.join(dir, "fonts"));
  }
  // LUT looks refer to "luts/<name>" relative to this folder.
  if (fs.existsSync(path.join(LIBRARY, "luts"))) linkDir(path.join(LIBRARY, "luts"), path.join(dir, "luts"));

  // 1. Animated graphics.
  const graphicsOverlays = res.overlays.filter((o) => o.engine === "remotion");
  const graphics: GraphicInput[] = [];
  let p0 = 0.03;
  let reused = 0;
  if (graphicsOverlays.length) {
    const who = { project: getProject(rnd.project_id).name, timeline: res.name };
    const jobs = graphicsOverlays.map((o) => ({
      spec: { component: o.component, props: o.props, width: res.width, height: res.height, fps: res.fps, frames: Math.max(1, Math.round((o.end - o.start) * res.fps)), brand: res.brand },
      start: o.start,
      layer: o.layer,
      fallbackDir: path.join(dir, `graphic-${slug(o.id, 30)}`),
      label: o.component,
    }));
    const drawn = await drawGraphics(jobs, who, ctx.signal, (label, f) => ctx.progress(`animating ${label}`, 0.03 + 0.2 * Math.min(1, f)));
    reused = drawn.reused;
    for (const g of drawn.inputs) graphics.push({ dir: g.dir, pattern: g.pattern, start: g.start, frames: g.frames, layer: g.layer });
    p0 = 0.23;
  }

  // 2. Video.
  const pre = path.join(dir, "pre.mkv");
  let batches: Array<{ file: string; frames: number; trans?: { xfade: string; frames: number } }> | undefined;
  let mainStart = p0;
  if (res.segments.length > BATCH) {
    batches = [];
    const count = Math.ceil(res.segments.length / BATCH);
    let done = 0;
    for (let b = 0; b < count; b++) {
      const segs = res.segments.slice(b * BATCH, (b + 1) * BATCH);
      const file = path.join(dir, `batch-${String(b).padStart(2, "0")}.mkv`);
      const cmd = buildBatchCommand(res, segs, file, rnd.quality, b === 0);
      const span = (0.55 - p0) / count;
      await ffmpeg(cmd.args, {
        cwd: dir,
        duration: cmd.frames / res.fps,
        signal: ctx.signal,
        label: `ffmpeg batch ${b + 1}/${count}`,
        onProgress: (f) => ctx.progress(`rendering cuts (batch ${b + 1}/${count})`, p0 + span * (done + f)),
      });
      done++;
      const first = segs[0];
      batches.push({ file, frames: cmd.frames, trans: first.transIn ? { xfade: first.transIn.xfade, frames: first.transIn.frames } : undefined });
    }
    mainStart = 0.55;
  }
  const hw = rnd.quality === "draft" && getConfig().features.hwDraftEncode !== false && process.platform === "darwin" && hasEncoder("h264_videotoolbox");
  const runMain = async (useHw: boolean) => {
    const args = buildCommand(res, assFile, pre, rnd.quality, batches, graphics, useHw);
    fs.writeFileSync(path.join(dir, "ffmpeg-args.json"), JSON.stringify(args, null, 1));
    await ffmpeg(args, {
      cwd: dir,
      duration: res.duration,
      signal: ctx.signal,
      label: "ffmpeg render",
      onProgress: (f) => ctx.progress("rendering video", mainStart + (0.85 - mainStart) * f),
    });
  };
  if (hw) {
    try {
      await runMain(true);
    } catch (e) {
      if (ctx.signal?.aborted) throw e;
      await runMain(false); // hardware encoder refused this one: same draft with x264
    }
  } else await runMain(false);

  // 3. Loudness + finish.
  const target = res.mix.targetLufs;
  const output = path.join(dir, "output.mp4");
  let af = `loudnorm=I=${target}:TP=-1.0:LRA=11`;
  if (rnd.quality === "final") {
    ctx.progress("measuring loudness", 0.86);
    const m = await ffmpeg(["-i", pre, "-vn", "-af", `${af}:print_format=json`, "-f", "null", "-"], { signal: ctx.signal, label: "ffmpeg loudness" });
    const j = parseLoudnorm(m.stderr);
    if (j && isFinite(Number(j.input_i)) && Number(j.input_i) > -70) {
      af += `:measured_I=${j.input_i}:measured_TP=${j.input_tp}:measured_LRA=${j.input_lra}:measured_thresh=${j.input_thresh}:offset=${j.target_offset}:linear=true`;
    }
  }
  ctx.progress("normalising audio", 0.92);
  await ffmpeg(
    ["-i", pre, "-map", "0:v", "-map", "0:a", "-c:v", "copy", "-af", `${af},aresample=48000`, "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-movflags", "+faststart", output],
    { signal: ctx.signal, duration: res.duration, label: "ffmpeg finish", onProgress: (f) => ctx.progress("normalising audio", 0.92 + 0.05 * f) },
  );
  const pr = await probe(output);
  let exported: string | undefined;
  if (rnd.quality === "final") {
    const cfg = getConfig();
    fs.mkdirSync(cfg.exportDir, { recursive: true });
    const project = getProject(rnd.project_id);
    exported = assertWritable(uniquePath(cfg.exportDir, `${slug(project.name, 30)}-${slug(res.name, 40)}`));
    await fs.promises.copyFile(output, exported);
  }
  ctx.progress("checking output", 0.98);
  const qa = await quickQa(output, res, ctx.signal);
  fs.writeFileSync(path.join(dir, "qa.json"), JSON.stringify(qa, null, 1));
  const graphicsInfo = graphicsOverlays.length ? { drawn: graphicsOverlays.length - reused, reused } : undefined;
  const data = { ...rnd.data, output, exported, duration: r3(pr.duration), planned: r3(res.duration), width: pr.width, height: pr.height, qa: qa.summary, graphics: graphicsInfo };
  updateRender(rnd.id, "succeeded", data);
  return {
    renderId: rnd.id,
    output,
    exported,
    quality: rnd.quality,
    duration: r3(pr.duration),
    size: `${pr.width}x${pr.height}`,
    qa: qa.summary,
    warnings: res.warnings,
    graphics: graphicsInfo,
    credits: credits.sounds.length || credits.yourFiles.length ? credits : undefined,
    note: safeCacheWarning(),
    clips: res.clipsSummary,
  };
}

/** Sounds and files a timeline uses, with their licences (from sound pack records). */
export function renderCredits(tl: { audio?: Array<{ library?: string; assetId?: string }>; sfxOnTransitions?: string; layers?: Array<{ assetId?: string }> }) {
  const refs = new Set<string>();
  for (const a of tl.audio ?? []) if (a.library) refs.add(a.library);
  if (tl.sfxOnTransitions) refs.add(tl.sfxOnTransitions);
  const sounds = [...refs].map((r) => {
    try {
      return soundCredit(r);
    } catch {
      return { ref: r, license: "UNKNOWN", source: "?" };
    }
  });
  const yourFiles = [...new Set((tl.audio ?? []).map((a) => a.assetId).filter((x): x is string => !!x))];
  const attribution = sounds.map((s) => (s as any).attribution).filter(Boolean) as string[];
  const unknown = sounds.filter((s) => /UNKNOWN/.test(s.license)).map((s) => s.ref);
  return {
    sounds,
    yourFiles,
    attributionNeeded: attribution.length ? attribution : undefined,
    warning: unknown.length ? `No licence record for: ${unknown.join(", ")}` : undefined,
    note: yourFiles.length ? "Audio files you imported yourself (yourFiles) must be yours or licensed for this use." : undefined,
  };
}

function safeCacheWarning(): string | undefined {
  try {
    return cacheWarning();
  } catch {
    return undefined;
  }
}

/** Create a render row and queue the job. */
export function startRender(timelineId: string, version: number, quality: "draft" | "final") {
  const tl = getTimeline(timelineId, version);
  const res = resolveTimeline(tl.json, quality);
  const id = newId("rnd");
  const dir = dirs.render(tl.project_id, id);
  insertRender({ id, project_id: tl.project_id, timeline_id: tl.id, version: tl.version, quality, status: "queued", dir, created: now(), data: {} });
  const job = enqueue("render", { renderId: id });
  updateRender(id, "queued", { jobId: job.id });
  return { renderId: id, jobId: job.id, timelineId: tl.id, version: tl.version, expectedDuration: res.duration, warnings: res.warnings };
}

export function assertRenderable(id: string) {
  const r = getRender(id);
  if (r.status !== "succeeded" || !r.data.output) throw new StudioError("INVALID_INPUT", `Render ${id} is ${r.status}; wait for it to finish.`);
  return r;
}
