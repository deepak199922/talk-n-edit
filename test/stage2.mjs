#!/usr/bin/env node
/**
 * Tests for the 0.5.4 editing features: timeline_patch, word/time anchors in overlay props, video effects (vfx) and
 * shake, timeline_preview, hardware draft encoding switch, sound packs with licence records and render credits.
 *
 *   npm run test:stage2
 *
 * Real renders and previews here use ffmpeg only (no animated graphics), so this runs on any machine with ffmpeg.
 * Graphics drawing (cache, one pass) is checked on a real Mac with the render comparison. Throw-away workspace.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const load = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "tne stage2 "));
const FIX = path.join(TMP, "fixtures");
fs.mkdirSync(FIX, { recursive: true });
process.env.TALK_N_EDIT_HOME = path.join(TMP, "work space");
fs.mkdirSync(process.env.TALK_N_EDIT_HOME, { recursive: true });
fs.writeFileSync(path.join(process.env.TALK_N_EDIT_HOME, "config.json"), JSON.stringify({ importRoots: [FIX], exportDir: path.join(TMP, "clips") }, null, 2));

const svc = await load("dist/service.js");
const config = await load("dist/config.js");
const store = await load("dist/store.js");
const patch = await load("dist/patch.js");
const resolve = await load("dist/resolve.js");
const render = await load("dist/render.js");
const effects = await load("dist/effects.js");
const ffm = await load("dist/ffmpeg.js");
const sounds = await load("dist/sounds.js");
const preview = await load("dist/preview.js");
const catalog = await load("dist/catalog.js");
svc.boot();
const FF = config.ffmpegBin();

let passes = 0;
let fails = 0;
function check(name, ok, detail = "") {
  ok ? passes++ : fails++;
  console.log(`${ok ? "  ✓" : "  ✗"} ${name}${!ok && detail ? `  — ${String(detail).slice(0, 400)}` : ""}`);
}
async function group(name, fn) {
  console.log(`\n▸ ${name}`);
  try {
    await fn();
  } catch (e) {
    check("unexpected error", false, e?.stack ?? JSON.stringify(e));
  }
}
const ff = (args) => {
  const r = spawnSync(FF, ["-y", "-v", "error", ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(r.stderr);
};
const throwsCode = (fn) => {
  try {
    fn();
    return "";
  } catch (e) {
    return e.code ?? e.message;
  }
};
async function runJob(id) {
  await svc.waitForJob(id);
  const [v] = await svc.waitJobs([id], 0);
  if (v.status !== "succeeded") throw new Error(`job ${v.type} ${v.status}: ${JSON.stringify(v.error)}`);
  return v.result;
}
/**
 * Render and return the video file. ffmpeg 4.x (e.g. Ubuntu 22.04) loses the stereo layout of the intermediate
 * pcm/mkv file and fails the final AAC step; ffmpeg 6+ (what setup installs) doesn't. Then the picture is checked on
 * the intermediate pre.mkv, which holds exactly the same video.
 */
async function renderVideo(timelineId, version) {
  const r = svc.renderStart({ timelineId, version, quality: "draft" });
  await svc.waitForJob(r.jobId);
  const [v] = await svc.waitJobs([r.jobId], 0);
  if (v.status === "succeeded") return { file: v.result.output, result: v.result };
  const pre = path.join(store.getRender(r.renderId).dir, "pre.mkv");
  if (/finish/.test(v.error?.message ?? "") && fs.existsSync(pre)) return { file: pre, result: null, oldFfmpeg: true };
  throw new Error(`render ${v.status}: ${JSON.stringify(v.error)}`);
}
// mean luma of a frame (0..255)
function luma(file, t, filter = "") {
  const r = spawnSync(FF, ["-v", "error", ...(t > 0 ? ["-ss", String(t)] : []), "-i", file, "-frames:v", "1", "-vf", `${filter ? filter + "," : ""}scale=16:16,format=gray`, "-f", "rawvideo", "-"], { maxBuffer: 1 << 20 });
  const b = [...r.stdout];
  return b.reduce((x, y) => x + y, 0) / (b.length || 1);
}
function chroma(file, t) {
  // mean absolute difference between R and B channels (rgbSplit / glitch make them diverge on a grey test card)
  const r = spawnSync(FF, ["-v", "error", "-ss", String(t), "-i", file, "-frames:v", "1", "-vf", "scale=64:64,format=rgb24", "-f", "rawvideo", "-"], { maxBuffer: 1 << 20 });
  const b = r.stdout;
  let d = 0;
  for (let i = 0; i < b.length; i += 3) d += Math.abs(b[i] - b[i + 2]);
  return d / (b.length / 3);
}

// ------------------------------------------------------------------ fixtures: 8 s grey card with a tone
const CLIP = path.join(FIX, "card.mp4");
ff(["-f", "lavfi", "-i", "color=c=0x808080:s=1280x720:r=30", "-f", "lavfi", "-i", "sine=f=440:r=48000", "-t", "8", "-vf", "drawgrid=w=80:h=80:t=2:c=white@0.6", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", CLIP]);
const prj = svc.projectOpen("stage2", true);
const pid = prj.projectId ?? prj.id;
const imp = await runJob(svc.mediaImport(pid, [CLIP]).id);
const assetId = (imp.assets ?? imp.imported ?? [])[0]?.assetId ?? store.listAssets(pid)[0].id;
// A fake transcript (word times on the source), so word anchors can be tested without a speech model.
{
  const words = [
    { w: "first", s: 0.5, e: 0.9 },
    { w: "we", s: 1.0, e: 1.2 },
    { w: "shift", s: 1.3, e: 1.7 },
    { w: "the", s: 1.8, e: 1.9 },
    { w: "elements", s: 2.0, e: 2.6 },
    { w: "then", s: 4.0, e: 4.3 },
    { w: "we", s: 4.4, e: 4.6 },
    { w: "shift", s: 4.7, e: 5.1 },
    { w: "again", s: 5.2, e: 5.6 },
  ];
  const p = path.join(config.dirs.analysis(pid, assetId), "transcript-test.json");
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify({ backend: "test", language: "en", words, sentences: [{ id: 0, s: 0.5, e: 5.6, text: words.map((w) => w.w).join(" ") }] }));
  store.insertAnalysis({ id: "ana_test1", asset_id: assetId, kind: "transcript", params_hash: "test", path: p, created: new Date().toISOString(), summary: {} });
}
const baseTl = (extra = {}) => ({
  projectId: pid,
  name: "s2",
  output: { aspect: "9:16", fps: 30 },
  clips: [
    { id: "a", assetId, in: 0, out: 3, snap: "frame" },
    { id: "b", assetId, in: 4, out: 7, snap: "frame" },
  ],
  ...extra,
});

await group("timeline_patch: paths and ops", async () => {
  const tl = { projectId: "p", name: "n", clips: [{ id: "a", in: 0, out: 3 }], overlays: [{ id: "panel", props: { rows: [{ text: "x" }, { text: "y" }] } }] };
  const r = patch.applyPatch(tl, [
    { op: "set", path: "overlays[id=panel].props.rows[1].text", value: "changed" },
    { op: "set", path: "captions.size", value: 1.2 },
    { op: "append", path: "overlays[id=panel].props.rows", value: { text: "z" } },
    { op: "remove", path: "overlays[id=panel].props.rows[0]" },
    { op: "set", path: "clips[0].out", value: 2.5 },
  ]);
  check("set by id + index", r.json.overlays[0].props.rows[0].text === "changed", JSON.stringify(r.json));
  check("set creates missing objects", r.json.captions?.size === 1.2);
  check("append + remove", r.json.overlays[0].props.rows.length === 2 && r.json.overlays[0].props.rows[1].text === "z");
  check("original untouched", tl.overlays[0].props.rows[1].text === "y" && !tl.captions);
  check("changed list", r.changed.length === 5);
  check("unknown id → clear error", throwsCode(() => patch.applyPatch(tl, [{ op: "set", path: "overlays[id=nope].x", value: 1 }])) === "INVALID_INPUT");
  check("bad index → clear error", throwsCode(() => patch.applyPatch(tl, [{ op: "remove", path: "clips[5]" }])) === "INVALID_INPUT");
  check("name/projectId protected", throwsCode(() => patch.applyPatch(tl, [{ op: "set", path: "name", value: "x" }])) === "INVALID_INPUT");
  check("bad path syntax → clear error", throwsCode(() => patch.parsePath("overlays[id=a")) === "INVALID_INPUT");
  // Through the service: patched timeline is validated and saved as the next version.
  const v1 = svc.timelineValidate(baseTl(), true);
  const base = svc.timelineGet({ timelineId: v1.timelineId });
  const p = patch.applyPatch(base.timeline, [{ op: "set", path: "clips[id=b].out", value: 6 }]);
  const v2 = svc.timelineValidate(p.json, true);
  check("saved as next version of the same timeline", v2.timelineId === v1.timelineId && v2.version === v1.version + 1 && Math.abs(v2.duration - 5) < 0.2, JSON.stringify({ v1: v1.version, v2: v2.version, d: v2.duration }));
});

await group("time anchors in overlay props ($at / $time)", async () => {
  const words = (clip, phrase, n, edge) => (phrase === "boom" ? 2 : 1.5 + n);
  const map = (clip, t) => (clip === "a" ? t : null);
  const out = resolve.resolvePropTimes({ rows: [{ at: { $at: { at: 5 } } }, { at: { $time: { clip: "a", sourceTime: 2 } } }, { keep: { at: 3 } }], x: 1 }, 1, "props", words, map);
  check("$at → seconds from overlay start", out.rows[0].at === 4, JSON.stringify(out));
  check("$time → timeline seconds", out.rows[1].at === 2);
  check("other objects untouched (even with an 'at' key)", out.rows[2].keep.at === 3 && out.x === 1);
  const q = resolve.resolvePropTimes({ a: { $at: { at: 19.96 } }, b: { $at: { at: 19.95 } } }, 0, "props", words, map, 30);
  check("snapped to whole frames (sub-frame shifts don't change the graphic)", q.a === q.b && q.a === 19.967, JSON.stringify(q));
  // Real resolve with the fake transcript: clip a = source 0–3, clip b = source 4–7 (timeline 3–6).
  fs.mkdirSync(path.join(process.env.TALK_N_EDIT_HOME, "fx"), { recursive: true });
  fs.writeFileSync(path.join(process.env.TALK_N_EDIT_HOME, "fx", "anchortest.json"), JSON.stringify({ name: "anchortest", description: "test", defaultDuration: 5, defaultProps: {} }));
  const tl = baseTl({
    overlays: [
      {
        id: "t",
        component: "fx:anchortest",
        start: { at: 0 },
        duration: 6,
        props: { text: "x", marks: [{ $at: { clip: "a", word: "shift" } }, { $at: { clip: "b", word: "shift" } }, { $time: { clip: "a", word: "the elements", edge: "end" } }, { $at: { clip: "a", word: "shift", offset: 0.5 } }] },
      },
    ],
  });
  let r;
  try {
    r = resolve.resolveTimeline(tl, "draft");
  } catch (e) {
    check("resolves", false, e.message + " " + (e.hint ?? ""));
    return;
  }
  const o = r.overlays.find((x) => x.id === "t");
  const m = o?.props?.marks;
  check("custom effect props kept", Array.isArray(m), JSON.stringify(o?.props));
  if (m) {
    check('word in clip a ("shift" at 1.3)', Math.abs(m[0] - 1.3) < 0.04, JSON.stringify(m));
    check('same word in clip b (source 4.7 → timeline 3.7)', Math.abs(m[1] - 3.7) < 0.04, JSON.stringify(m));
    check("phrase + edge end (\"the elements\" ends 2.6)", Math.abs(m[2] - 2.6) < 0.04, JSON.stringify(m));
    check("offset", Math.abs(m[3] - 1.8) < 0.04, JSON.stringify(m));
  }
  const bad = baseTl({ overlays: [{ id: "t", component: "fx:anchortest", start: { at: 0 }, duration: 2, props: { at: { $at: { clip: "a", word: "again" } } } }] });
  check("word cut out of the clip → clear error", throwsCode(() => resolve.resolveTimeline(bad, "draft")) === "INVALID_INPUT");
  config.getConfig().features.propTimeAnchors = false;
  const off = baseTl({ overlays: [{ id: "t", component: "HookText", start: { at: 0 }, duration: 2, props: { text: "x" } }] });
  check("switch off: still resolves plain timelines", !!resolve.resolveTimeline(off, "draft"));
  config.getConfig().features.propTimeAnchors = true;
});

await group("vfx: every effect renders and changes the picture only in its window", async () => {
  const types = ["flash", "rgbSplit", "glitch", "blur", "vignette", "blackWhite", "invert", "punch", "ghost", "motionBlur", "letterbox", "grain"];
  for (const t of types) {
    const f = render.vfxFilters({ type: t, start: 0.2, end: 0.8, intensity: 0.7, color: t === "flash" ? "#FFD60A" : undefined }, 540);
    const p = spawnSync(FF, ["-v", "error", "-f", "lavfi", "-i", "testsrc2=s=540x960:d=1:r=30", "-vf", f.join(","), "-f", "null", "-"], { encoding: "utf8" });
    check(`${t} filter runs`, p.status === 0 && !p.stderr.trim(), p.stderr);
  }
  const tl = baseTl({
    vfx: [
      { type: "flash", start: { at: 1 }, duration: 0.4, intensity: 1 },
      { type: "rgbSplit", start: { clip: "b", sourceTime: 5 }, duration: 0.6, intensity: 1 },
      { type: "shake", start: { at: 2 }, duration: 0.5, intensity: 0.8 },
    ],
  });
  const res = resolve.resolveTimeline(tl, "draft");
  check("shake becomes a shaking zoom, others stay as effects", res.vfx.length === 2 && res.segments.some((s) => (s.zooms ?? []).some((z) => z.shake > 0)), JSON.stringify(res.vfx));
  check("anchored effect start (clip b source 5 → timeline 4)", Math.abs(res.vfx.find((v) => v.type === "rgbSplit").start - 4) < 0.05);
  const v = svc.timelineValidate(tl, true);
  const out = await renderVideo(v.timelineId, v.version);
  if (out.oldFfmpeg) console.log("    (old ffmpeg: checking the intermediate video)");
  const before = luma(out.file, 0.5);
  const flash = luma(out.file, 1.05);
  const after = luma(out.file, 1.8);
  check("flash brightens only during its window", flash > before + 25 && Math.abs(after - before) < 6, `${before} ${flash} ${after}`);
  check("rgbSplit separates colours only in its window", chroma(out.file, 4.2) > chroma(out.file, 3.5) + 1, `${chroma(out.file, 3.5)} → ${chroma(out.file, 4.2)}`);
  if (out.result) check("render result has no graphics line when there are none", out.result.graphics === undefined);
  check("bad flash colour → clear error", throwsCode(() => resolve.resolveTimeline(baseTl({ vfx: [{ type: "flash", start: { at: 1 }, duration: 0.3, color: "yellow" }] }), "draft")) === "INVALID_INPUT");
});

await group("timeline_preview (stills through the render graph)", async () => {
  const v = svc.timelineValidate(baseTl({ name: "s2-prev", vfx: [{ type: "flash", start: { at: 1 }, duration: 0.4, intensity: 1 }] }), true);
  const t0 = Date.now();
  const p = await preview.previewStills(v.timelineId, v.version, [0.5, 1.05, 4.5], "draft");
  const secs = (Date.now() - t0) / 1000;
  check("3 pictures", p.frames.length === 3 && p.frames.every((f) => fs.existsSync(f.path)), JSON.stringify(p.frames));
  check("draft size", p.size === "540x960", p.size);
  check("preview shows the flash at 1.05 s and not at 0.5 s", luma(p.frames[1].path, 0) > luma(p.frames[0].path, 0) + 25, `${luma(p.frames[0].path, 0)} vs ${luma(p.frames[1].path, 0)}`);
  check(`fast (${secs.toFixed(1)} s for 3 pictures)`, secs < 60);
  // A preview frame matches the same frame of a real render.
  const out = await renderVideo(v.timelineId, v.version);
  const d = Math.abs(luma(out.file, 4.5) - luma(p.frames[2].path, 0));
  check("matches the render at the same moment", d < 4, d);
  // Times whose frame lands a hair under the exact second (22.6 s × 30 = 677.99999…) must still show their graphics.
  const many = await preview.previewStills(v.timelineId, v.version, [0.7, 1.1, 2.6, 4.2, 5.3], "draft");
  check("every requested moment gives its own frame", new Set(many.frames.map((f) => f.t)).size === 5, JSON.stringify(many.frames.map((f) => f.t)));
  check("time past the end is clamped", (await preview.previewStills(v.timelineId, v.version, [99], "draft")).frames[0].t < 6.01);
});

await group("hardware draft encoding switch", async () => {
  check("hasEncoder answers without throwing", typeof ffm.hasEncoder("h264_videotoolbox") === "boolean" && ffm.hasEncoder("libx264") === true);
  const f = config.getConfig().features;
  check("default on", f.hwDraftEncode === true && f.graphicsOnePass === true && f.propTimeAnchors === true);
  const res = resolve.resolveTimeline(baseTl(), "draft");
  const hw = render.buildCommand(res, null, "x.mkv", "draft", undefined, [], true);
  const sw = render.buildCommand(res, null, "x.mkv", "draft", undefined, [], false);
  const fin = render.buildCommand(res, null, "x.mkv", "final", undefined, [], true);
  check("draft with hw uses videotoolbox", hw.includes("h264_videotoolbox") && !hw.includes("libx264"));
  check("draft without hw uses x264 as before", sw.includes("libx264") && sw.includes("28"));
  check("finals always x264 crf 18", fin.includes("libx264") && fin.includes("18") && !fin.includes("h264_videotoolbox"));
});

await group("graphic frame placement (matches ffmpeg, covers to the end)", async () => {
  const f = config.getConfig().features;
  // End card starting at 84.62 s that should run to the end of an 88.067 s video at 30 fps.
  check("fix on: covers through the last frame", render.graphicFrames(84.62, 88.067, 30) === 2643 - 2538, render.graphicFrames(84.62, 88.067, 30));
  check("whole-frame start unchanged", render.graphicFrames(3.4, 12.71, 30) === 280, render.graphicFrames(3.4, 12.71, 30));
  f.graphicsFrameFix = false;
  check("fix off: previous count", render.graphicFrames(84.62, 88.067, 30) === 103);
  f.graphicsFrameFix = true;
  // ffmpeg places frame 0 at floor(start × fps): a 16×16 white graphic starting at 0.05 s (1.5 frames) shows from frame 1.
  const g = path.join(TMP, "g");
  fs.mkdirSync(g, { recursive: true });
  for (let i = 0; i < 3; i++) ff(["-f", "lavfi", "-i", "color=c=white:s=16x16", "-frames:v", "1", path.join(g, `g-${i}.png`)]);
  const r = spawnSync(FF, ["-v", "error", "-f", "lavfi", "-i", "color=c=black:s=16x16:r=30:d=0.3", "-framerate", "30", "-start_number", "0", "-i", path.join(g, "g-%d.png"), "-filter_complex", "[1:v]format=rgba,setpts=PTS-STARTPTS+0.05/TB[g];[0:v][g]overlay=0:0:eof_action=pass:format=auto,format=gray", "-f", "rawvideo", "-"], { maxBuffer: 1 << 20 });
  const lit = [];
  for (let k = 0; k * 256 < r.stdout.length; k++) lit.push(r.stdout[k * 256] > 128 ? 1 : 0);
  check("ffmpeg shows a graphic from floor(start × fps)", lit.indexOf(1) === 1, lit.join(""));
});

await group("sound packs and render credits", async () => {
  const dl = path.join(FIX, "My Download", "Impacts");
  fs.mkdirSync(dl, { recursive: true });
  ff(["-f", "lavfi", "-i", "sine=f=90:d=0.4", path.join(dl, "Big Hit 01.wav")]);
  ff(["-f", "lavfi", "-i", "sine=f=900:d=0.2", path.join(dl, "Tick.WAV")]);
  fs.writeFileSync(path.join(dl, "readme.txt"), "not audio");
  check("non-commercial licence refused", throwsCode(() => sounds.importPack({ folder: path.join(FIX, "My Download"), pack: "x", license: "CC-BY-NC-4.0", source: "s" })) === "INVALID_INPUT");
  check("CC-BY needs an attribution line", throwsCode(() => sounds.importPack({ folder: path.join(FIX, "My Download"), pack: "x", license: "CC-BY-4.0", source: "s" })) === "INVALID_INPUT");
  check("folder outside import roots refused", throwsCode(() => sounds.importPack({ folder: os.homedir(), pack: "x", license: "CC0", source: "s" })) === "PATH_DENIED");
  const r = sounds.importPack({ folder: path.join(FIX, "My Download"), pack: "GDC Impacts", license: "Sonniss-GDC", source: "Sonniss GDC 2026 bundle", url: "https://sonniss.com" });
  check("imported 2 sounds (subfolders, any case extension)", r.files === 2 && r.pack === "gdc-impacts", JSON.stringify(r));
  check("originals left in place", fs.existsSync(path.join(dl, "Big Hit 01.wav")));
  const sfx = catalog.catalog("sfx");
  check("catalog_list sfx shows pack sounds next to built-ins", JSON.stringify(sfx).includes("packs/gdc-impacts/big-hit-01") && JSON.stringify(sfx).includes("sfx/whoosh"), JSON.stringify(sfx).slice(0, 300));
  check("library ref resolves to the copied file", effects.librarySound("packs/gdc-impacts/tick").endsWith(".wav"));
  check("unknown pack sound → clear error", throwsCode(() => effects.librarySound("packs/gdc-impacts/nope")) === "INVALID_INPUT");
  check("duplicate pack name refused", throwsCode(() => sounds.importPack({ folder: path.join(FIX, "My Download"), pack: "GDC Impacts", license: "CC0", source: "s" })) === "INVALID_INPUT");
  const tl = baseTl({ name: "s2-sfx", audio: [{ id: "s1", library: "packs/gdc-impacts/big-hit-01", role: "sfx", start: { at: 1 } }, { id: "s2", library: "sfx/pop", role: "sfx", start: { at: 2 } }] });
  const v = svc.timelineValidate(tl, true);
  const out = await renderVideo(v.timelineId, v.version);
  const c = out.result ? out.result.credits : JSON.parse(fs.readFileSync(path.join(path.dirname(out.file), "credits.json"), "utf8"));
  check("render lists both sounds with licences", c && c.sounds.length === 2 && c.sounds.some((s) => /Sonniss/.test(s.license)) && c.sounds.some((s) => /built-in/.test(s.license)), JSON.stringify(c));
  check("credits.json written", fs.existsSync(path.join(path.dirname(out.file), "credits.json")));
  const cc = sounds.importPack({ folder: path.join(FIX, "My Download"), pack: "cc", license: "CC-BY-4.0", source: "freesound", attribution: "Hit by someone (freesound.org/s/1), CC BY 4.0" });
  const c2 = render.renderCredits({ audio: [{ library: `packs/${cc.pack}/tick` }] });
  check("attribution line surfaced for CC-BY", c2.attributionNeeded?.[0]?.includes("CC BY 4.0"), JSON.stringify(c2));
});

console.log(`\n${passes} passed, ${fails} failed`);
fs.rmSync(TMP, { recursive: true, force: true });
process.exit(fails ? 1 : 0);
