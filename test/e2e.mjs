#!/usr/bin/env node
/**
 * Talk-n-Edit end-to-end test suite.
 *
 *   npm test                 full suite (needs ffmpeg + the Python env; first run downloads the speech model)
 *   npm test -- --quick      skips the slow cases (4K HEVC, multi-process, MCP)
 *
 * It makes its own fixtures (spoken audio via ffmpeg's flite filter, macOS `say` or espeak-ng), runs in a throw-away
 * workspace whose path contains spaces, and checks outputs by measuring them (size, orientation, duration,
 * A/V sync, loudness, crops), not just by exit codes. Nothing outside that temporary folder is touched.
 * Optional: FACE_IMAGE=/path/to/portrait.png enables the face-tracking and split-screen cases.
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const QUICK = process.argv.includes("--quick");
// import() needs a file:// URL for absolute paths (on Windows a bare "D:\\..." is read as a URL scheme).
const load = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "vs e2e "));
const FIX = path.join(TMP, "fixtures");
const ODD = path.join(FIX, "Odd Folder (x)");
const EXPORT = path.join(TMP, "export clips");
fs.mkdirSync(ODD, { recursive: true });
process.env.TALK_N_EDIT_HOME = path.join(TMP, "work space");
fs.mkdirSync(process.env.TALK_N_EDIT_HOME, { recursive: true });
fs.writeFileSync(
  path.join(process.env.TALK_N_EDIT_HOME, "config.json"),
  JSON.stringify(
    {
      importRoots: [FIX],
      exportDir: EXPORT,
      inboxDir: path.join(TMP, "inbox (downloads)"),
      transcriptionBackend: "auto",
      ...(process.env.VS_TEST_MODEL ? { whisperModel: process.env.VS_TEST_MODEL } : {}),
    },
    null,
    2,
  ),
);

const svc = await load("dist/service.js");
const config = await load("dist/config.js");
const db = await load("dist/db.js");
const jobs = await load("dist/jobs.js");
svc.boot();
const FF = config.ffmpegBin();
const FP = config.ffprobeBin();

// ------------------------------------------------------------------ harness
const results = [];
let current = "";
function check(name, ok, detail = "") {
  results.push({ group: current, name, ok: !!ok, detail: String(detail).slice(0, 300) });
  process.stdout.write(`${ok ? "  ✓" : "  ✗"} ${name}${detail && !ok ? `  — ${String(detail).slice(0, 300)}` : ""}\n`);
}
async function group(name, fn) {
  current = name;
  console.log(`\n▸ ${name}`);
  try {
    await fn();
  } catch (e) {
    check("unexpected error", false, e?.toJSON ? JSON.stringify(e.toJSON()) : e?.stack ?? e);
  }
}
async function expectError(name, fn, code, re) {
  try {
    await fn();
    check(name, false, "no error thrown");
  } catch (e) {
    const j = e?.toJSON ? e.toJSON() : { message: String(e) };
    check(name, (!code || j.code === code) && (!re || re.test(JSON.stringify(j))), JSON.stringify(j));
  }
}
function ff(args) {
  const r = spawnSync(FF, ["-hide_banner", "-loglevel", "error", "-y", ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${args.join(" ")}\n${r.stderr}`);
}
function probe(file) {
  const r = spawnSync(FP, ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file], { encoding: "utf8" });
  return JSON.parse(r.stdout);
}
function streamDur(file, type) {
  const j = probe(file);
  const s = j.streams.find((x) => x.codec_type === type);
  return Number(s?.duration ?? j.format.duration);
}
/** Mean luma of the top and bottom halves of the frame at time t (ffmpeg applies rotation like a player). */
function halves(file, t) {
  const r = spawnSync(FF, ["-v", "error", "-ss", String(t), "-i", file, "-frames:v", "1", "-vf", "scale=4:8,format=gray", "-f", "rawvideo", "-"], {
    maxBuffer: 1 << 20,
  });
  const b = r.stdout;
  const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  return { top: avg([...b.subarray(0, 16)]), bottom: avg([...b.subarray(16, 32)]) };
}

/** Small grayscale/RGB samples of a frame for measuring effects. */
// flags "area" averages pixels when shrinking a lot; the default (bicubic) aliases on fine detail
// and that aliasing differs between ffmpeg builds.
function frameBytes(file, t, filter, size = "16:16", fmt = "gray", flags = "") {
  const r = spawnSync(FF, ["-v", "error", "-ss", String(t), "-i", file, "-frames:v", "1", "-vf", `${filter ? filter + "," : ""}scale=${size}${flags ? ":flags=" + flags : ""},format=${fmt}`, "-f", "rawvideo", "-"], { maxBuffer: 1 << 22 });
  return r.stdout;
}
const mean = (b) => b.reduce((x, y) => x + y, 0) / b.length;
const std = (b) => {
  const m = mean(b);
  return Math.sqrt(b.reduce((x, y) => x + (y - m) ** 2, 0) / b.length);
};
const absDiff = (a, b) => mean(a.map((x, i) => Math.abs(x - b[i])));

async function runJob(job) {
  const j = await svc.waitForJob(job.id ?? job.jobId);
  const [v] = await svc.waitJobs([j.id], 0);
  if (v.status !== "succeeded") throw Object.assign(new Error(`job ${v.type} ${v.status}: ${JSON.stringify(v.error)}`), { toJSON: () => v.error });
  return v.result;
}
async function render(tl, quality = "draft") {
  const r = svc.renderStart({ timeline: tl, quality });
  const res = await runJob({ id: r.jobId });
  return { ...res, resolved: JSON.parse(fs.readFileSync(path.join(path.dirname(res.output), "resolved.json"), "utf8")) };
}

// ------------------------------------------------------------------ fixtures
const filters = spawnSync(FF, ["-hide_banner", "-filters"], { encoding: "utf8" }).stdout;
// VS_TEST_SPEECH=flite|say|espeak|sapi forces one speech source (default: the first one available).
const want = process.env.VS_TEST_SPEECH;
const WIN = process.platform === "win32";
const onPath = (cmd) => spawnSync(WIN ? "where" : "which", [cmd], { windowsHide: true }).status === 0;
const hasFlite = (!want || want === "flite") && / flite /.test(filters);
const hasSay = (!want || want === "say") && !WIN && onPath("say");
const hasEspeak = (!want || want === "espeak") && onPath("espeak-ng");
// Windows' built-in voice (System.Speech), through PowerShell.
const hasSapi = (!want || want === "sapi") && WIN;
function speak(text, out) {
  if (hasFlite) return ff(["-f", "lavfi", "-i", `flite=text='${text.replace(/'/g, "")}':voice=slt`, "-ar", "48000", "-ac", "2", out]);
  if (hasSay) {
    const aiff = out.replace(/\.wav$/, ".aiff");
    const r = spawnSync("say", ["-o", aiff, text]);
    if (r.status !== 0) throw new Error("say failed");
    return ff(["-i", aiff, "-ar", "48000", "-ac", "2", out]);
  }
  if (hasEspeak) {
    const raw = out.replace(/\.wav$/, ".espeak.wav");
    const r = spawnSync("espeak-ng", ["-v", "en-us", "-s", "150", "-w", raw, text]);
    if (r.status !== 0) throw new Error("espeak-ng failed");
    return ff(["-i", raw, "-ar", "48000", "-ac", "2", out]);
  }
  if (hasSapi) {
    const raw = out.replace(/\.wav$/, ".sapi.wav");
    const ps = "Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.Rate = 1; $s.SetOutputToWaveFile($env:TNE_WAV); $s.Speak($env:TNE_TEXT); $s.Dispose()";
    const r = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps], { env: { ...process.env, TNE_WAV: raw, TNE_TEXT: text }, windowsHide: true, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`Windows speech failed: ${r.stderr}`);
    return ff(["-i", raw, "-ar", "48000", "-ac", "2", out]);
  }
  throw new Error("No speech synthesizer (ffmpeg flite, macOS say, espeak-ng or Windows speech) available for fixtures");
}
function speechTrack(lines, gaps, out) {
  const parts = [];
  lines.forEach((l, i) => {
    const f = path.join(TMP, `sp-${path.basename(out)}-${i}.wav`);
    speak(l, f);
    parts.push(f);
    if (i < lines.length - 1) {
      const g = path.join(TMP, `gap-${gaps[i] ?? 0.4}.wav`);
      if (!fs.existsSync(g)) ff(["-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo", "-t", String(gaps[i] ?? 0.4), g]);
      parts.push(g);
    }
  });
  const list = path.join(TMP, `list-${path.basename(out)}.txt`);
  fs.writeFileSync(list, parts.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n"));
  ff(["-f", "concat", "-safe", "0", "-i", list, "-c:a", "pcm_s16le", out]);
  return Number(probe(out).format.duration);
}

console.log(`Workspace: ${process.env.TALK_N_EDIT_HOME}\nFixtures:  ${FIX}`);
console.log(`Speech source: ${hasFlite ? "ffmpeg flite" : hasSay ? "macOS say" : hasEspeak ? "espeak-ng" : hasSapi ? "Windows speech" : "none"}`);
const LINES = [
  "Most developers make the same mistake when they start a new project.",
  "They write code before they understand the problem.",
  "Here is what I do instead.",
  "First, I talk to three real users.",
  "Second, I write down the one number that should move.",
  "Only then do I open my editor. It saves me weeks, every single time.",
];
const F = {};
await group("make fixtures", async () => {
  const speech = path.join(TMP, "speech.wav");
  const D = speechTrack(LINES, [1.6, 0.4, 2.4, 0.4, 1.6], speech);
  F.talk = path.join(FIX, "talk.mp4");
  ff(["-f", "lavfi", "-i", "testsrc2=size=1920x1080:rate=30", "-i", speech, "-t", String(D), "-c:v", "libx264", "-preset", "ultrafast", "-crf", "26", "-c:a", "aac", "-shortest", F.talk]);
  // Phone-style portrait video stored landscape + rotation metadata. Left half white, right half black.
  const raw = path.join(TMP, "raw-rot.mp4");
  ff(["-f", "lavfi", "-i", "color=white:s=960x1080:r=30", "-f", "lavfi", "-i", "color=black:s=960x1080:r=30", "-i", speech,
    "-filter_complex", "[0:v][1:v]hstack[v]", "-map", "[v]", "-map", "2:a", "-t", "12", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", raw]);
  F.rotated = path.join(FIX, "phone-rotated.mov");
  ff(["-display_rotation:v:0", "90", "-i", raw, "-c", "copy", F.rotated]);
  F.noaudio = path.join(FIX, "no-audio.mp4");
  ff(["-f", "lavfi", "-i", "testsrc=size=1280x720:rate=30", "-t", "6", "-c:v", "libx264", "-preset", "ultrafast", F.noaudio]);
  F.vfr = path.join(FIX, "vfr.mp4");
  ff(["-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30", "-i", speech, "-t", String(D),
    "-vf", "settb=1/1000,setpts='N/30/TB+0.011*sin(N*0.7)/TB'", "-fps_mode", "vfr", "-enc_time_base:v", "1:1000", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-shortest", F.vfr]);
  F.odd = path.join(ODD, "My Video (final) 'v2' हिंदी.mp4");
  fs.copyFileSync(F.talk, F.odd);
  F.letterbox = path.join(FIX, "letterbox.mp4");
  ff(["-f", "lavfi", "-i", "testsrc2=size=1280x532:rate=24", "-t", "4", "-vf", "pad=1280:720:0:94:black", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", F.letterbox]);
  F.square25 = path.join(FIX, "square25.mp4");
  ff(["-f", "lavfi", "-i", "testsrc2=size=1080x1080:rate=25", "-i", speech, "-t", String(D), "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-shortest", F.square25]);
  F.music = path.join(FIX, "music.wav");
  ff(["-f", "lavfi", "-i", "aevalsrc='0.2*sin(2*PI*220*t)*(0.6+0.4*sin(2*PI*2*t))+0.1*sin(2*PI*330*t)':s=48000:d=12", "-ac", "2", F.music]);
  F.clicks = path.join(FIX, "clicks-120bpm.wav");
  ff(["-f", "lavfi", "-i", "aevalsrc='if(lt(mod(t,0.5),0.025),0.8*sin(2*PI*1200*t),0)+0.02*sin(2*PI*110*t)':s=48000:d=20", "-ac", "2", F.clicks]);
  F.png = path.join(FIX, "logo-alpha.png");
  ff(["-f", "lavfi", "-i", "color=c=red@0.5:s=800x600,format=rgba", "-frames:v", "1", F.png]);
  F.bigjpg = path.join(FIX, "big-photo.jpg");
  ff(["-f", "lavfi", "-i", "testsrc=size=4000x3000:rate=1", "-frames:v", "1", F.bigjpg]);
  // Many short phrases with pauses: forces > 20 pieces after silence removal (batch rendering).
  const many = path.join(TMP, "many.wav");
  const mlines = Array.from({ length: 26 }, (_, i) => `Point number ${i + 1} is important.`);
  const MD = speechTrack(mlines, mlines.map(() => 0.9), many);
  F.many = path.join(FIX, "many-pauses.mp4");
  ff(["-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30", "-i", many, "-t", String(MD), "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-shortest", F.many]);
  if (process.env.FACE_IMAGE && fs.existsSync(process.env.FACE_IMAGE)) {
    F.face = path.join(FIX, "one-face.mp4");
    ff(["-loop", "1", "-i", process.env.FACE_IMAGE, "-i", speech, "-t", "8",
      "-filter_complex", "color=black:s=1920x1080:r=30[bg];[0:v]scale=-2:700[f];[bg][f]overlay=x=576-overlay_w/2:y=190,format=yuv420p[v]",
      "-map", "[v]", "-map", "1:a", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-shortest", F.face]);
    F.two = path.join(FIX, "two-faces.mp4");
    ff(["-loop", "1", "-i", process.env.FACE_IMAGE, "-i", speech, "-t", "8",
      "-filter_complex", "color=black:s=1920x1080:r=30[bg];[0:v]scale=-2:520,split[a][b];[bg][a]overlay=x=480-overlay_w/2:y=280[t];[t][b]overlay=x=1440-overlay_w/2:y=280,format=yuv420p[v]",
      "-map", "[v]", "-map", "1:a", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-shortest", F.two]);
  }
  if (!QUICK && / libx265 /.test(spawnSync(FF, ["-hide_banner", "-encoders"], { encoding: "utf8" }).stdout)) {
    F.hevc4k = path.join(FIX, "iphone-4k-hevc.mov");
    ff(["-f", "lavfi", "-i", "testsrc2=size=3840x2160:rate=30", "-i", speech, "-t", "5", "-c:v", "libx265", "-preset", "ultrafast", "-tag:v", "hvc1", "-c:a", "aac", "-shortest", F.hevc4k]);
  }
  check("fixtures created", fs.existsSync(F.talk) && fs.existsSync(F.rotated) && fs.existsSync(F.many), Object.keys(F).join(", "));
  check("rotation metadata present", (() => {
    const v = probe(F.rotated).streams.find((s) => s.codec_type === "video");
    return JSON.stringify(v.side_data_list ?? v.tags ?? {}).includes("90");
  })());
});

// ------------------------------------------------------------------ import
let P;
const A = {};
await group("project + import", async () => {
  P = svc.projectOpen("E2E project").projectId;
  check("project created", P?.startsWith("prj_"));
  check("project reopened by name", svc.projectOpen("E2E project").projectId === P);
  const res = await runJob(svc.mediaImport(P, [FIX]));
  const byName = Object.fromEntries(res.assets.map((a) => [a.name, a]));
  for (const [k, f] of Object.entries(F)) {
    if (path.dirname(f) !== FIX) continue;
    A[k] = byName[path.basename(f)]?.assetId;
  }
  check("folder import found every top-level file", Object.entries(F).filter(([, f]) => path.dirname(f) === FIX).every(([k]) => A[k]), JSON.stringify(Object.keys(byName)));
  const odd = await runJob(svc.mediaImport(P, [F.odd]));
  A.odd = odd.assets[0].assetId;
  check("odd filename (quotes, brackets, Hindi) imports", !!A.odd);
  check("odd file deduplicated by content (same as talk.mp4)", odd.assets[0].alreadyImported === true, JSON.stringify(odd.assets[0]));
  const rot = byName["phone-rotated.mov"];
  check("rotated phone video reported as portrait", rot.size === "1080x1920", rot.size);
  check("audio file classified as audio", byName["music.wav"].kind === "audio");
  check("images classified as image", byName["logo-alpha.png"].kind === "image" && byName["big-photo.jpg"].kind === "image");
  check("VFR detected", byName["vfr.mp4"].vfr === true, JSON.stringify(byName["vfr.mp4"]));
  // A system folder and a file in it that exist on every machine.
  const [sysDir, sysFile] = WIN ? [process.env.SystemRoot ?? "C:\\Windows", "win.ini"] : ["/etc", "hosts"];
  await expectError("import outside import roots is refused", () => svc.mediaImport(P, [path.join(sysDir, sysFile)]), "PATH_DENIED");
  const link = path.join(FIX, "sneaky-link");
  try {
    // Windows: a directory junction (no admin rights needed), which escapes the same way.
    fs.symlinkSync(sysDir, link, WIN ? "junction" : "dir");
  } catch {}
  await expectError("symlink escaping the import root is refused", () => svc.mediaImport(P, [path.join(link, sysFile)]), "PATH_DENIED");
  await expectError("missing file is reported", () => svc.mediaImport(P, [path.join(FIX, "nope.mp4")]), "NOT_FOUND");
  const insp = await svc.mediaInspect(A.talk, true);
  check("media_inspect returns a contact sheet", insp.sheet && fs.statSync(insp.sheet.path).size > 5000, insp.sheet?.path);
});

// ------------------------------------------------------------------ analysis
await group("analysis", async () => {
  const t0 = Date.now();
  const r = await runJob(svc.analyze({ assetId: A.talk, include: ["transcript", "faces", "scenes"] }));
  check(`transcript of talk.mp4 (${((Date.now() - t0) / 1000).toFixed(0)} s)`, r.summary.transcript?.words > 40, JSON.stringify(r.summary));
  const txt = svc.transcriptGet(A.talk, {});
  check("transcript_get lists numbered sentences", /\[s0001 /.test(txt) && /mistake/i.test(txt), txt.slice(0, 200));
  check("transcript words have sane timings", (() => {
    const w = svc.transcriptGet(A.talk, { format: "words" });
    return /@\d+\.\d\d/.test(w);
  })());
  const again = await runJob(svc.analyze({ assetId: A.talk, include: ["transcript"] }));
  check("analysis is cached on repeat", again.summary.transcript?.cached === true);
  for (const k of ["vfr", "square25", "many", "rotated"]) {
    const x = await runJob(svc.analyze({ assetId: A[k], include: ["transcript"] }));
    check(`transcript of ${k}`, x.summary.transcript?.words > 10, JSON.stringify(x.summary));
  }
  await expectError("transcribing a video with no audio gives a clear error", () => runJob(svc.analyze({ assetId: A.noaudio, include: ["transcript"] })), "INVALID_INPUT", /no audio/);
  await expectError("analysing an image is refused", () => runJob(svc.analyze({ assetId: A.png, include: ["transcript"] })), "INVALID_INPUT");
  await expectError("unknown asset id", () => svc.analyze({ assetId: "ast_nope", include: ["transcript"] }), "NOT_FOUND");
  if (A.face) {
    const fr = await runJob(svc.analyze({ assetId: A.face, include: ["faces", "scenes", "transcript"] }));
    check("face found in one-face video", fr.summary.faces.framesWithFace >= fr.summary.faces.sampledFrames * 0.8, JSON.stringify(fr.summary.faces));
    const tw = await runJob(svc.analyze({ assetId: A.two, include: ["faces", "transcript"] }));
    check("two faces found in two-face video", tw.summary.faces.framesWithTwoOrMore >= tw.summary.faces.sampledFrames * 0.8, JSON.stringify(tw.summary.faces));
  }
});

// ------------------------------------------------------------------ renders
const base = (name, extra = {}) => ({ projectId: P, name, output: { aspect: "9:16", fps: 30, platform: "instagram-reels" }, ...extra });

await group("render: full reel (final quality)", async () => {
  const tl = base("full-reel", {
    clips: [
      { id: "c1", assetId: A.talk, sentences: { from: "s0001", to: "s0006" }, removeSilences: { minGap: 0.5, keepPad: 0.1 } },
      { id: "c2", assetId: A.bigjpg, duration: 2.5, motion: { type: "kenburns-out", strength: 0.6 }, transitionIn: { type: "fade-black", duration: 0.3 } },
    ],
    overlays: [
      { id: "hook", component: "HookText", start: { at: 0 }, duration: 2.5, props: { text: "Most developers get this wrong" } },
      { id: "lt", component: "LowerThird", start: { clip: "c1", sourceTime: 9.5 }, duration: 2, props: { name: "Test Speaker", role: "Engineer" } },
      { id: "end", component: "TitleCard", start: { clip: "c2", sourceTime: 0 }, duration: 2.5, props: { title: "Follow for more", subtitle: "@test" } },
    ],
    captions: { preset: "karaoke-highlight", emphasis: ["three real users"] },
    audio: [{ id: "m", assetId: A.music, role: "music", volume: 0.6, fadeOut: 1, loop: true }],
  });
  const v = svc.timelineValidate(tl);
  check("validate: silence removal shortened the clip", v.clips[0].tlEnd < 24, JSON.stringify(v.clips[0]));
  // Compare with the transcript itself (wording differs between Whisper models).
  const sentText = (id) => (svc.transcriptGet(A.talk, {}).match(new RegExp(`^\\[${id} [^\\]]*\\] (.*)$`, "m")) ?? [])[1] ?? "";
  const firstWords = sentText("s0001").split(/\s+/).slice(0, 2).join(" ");
  const lastWord = sentText("s0006").split(/\s+/).pop() ?? "";
  check("validate: spokenText shows start and end", firstWords.length > 3 && lastWord.length > 1 && v.spokenText.c1.startsWith(firstWords) && v.spokenText.c1.trimEnd().endsWith(lastWord), `${JSON.stringify(firstWords)} … ${JSON.stringify(lastWord)} vs ${v.spokenText.c1}`);
  const r = await render(tl, "final");
  const pr = probe(r.output);
  const vs = pr.streams.find((s) => s.codec_type === "video");
  check("output is 1080x1920 h264 yuv420p", vs.width === 1080 && vs.height === 1920 && vs.codec_name === "h264" && vs.pix_fmt === "yuv420p", `${vs.width}x${vs.height} ${vs.codec_name} ${vs.pix_fmt}`);
  check("duration matches the timeline", Math.abs(Number(pr.format.duration) - r.resolved.duration) < 0.15, `${pr.format.duration} vs ${r.resolved.duration}`);
  check("audio and video lengths match (A/V sync)", Math.abs(streamDur(r.output, "audio") - streamDur(r.output, "video")) < 0.1);
  check("QA passes", r.qa.verdict === "ok", JSON.stringify(r.qa));
  check("final copied to export folder", r.exported && fs.existsSync(r.exported), r.exported);
  const ass = fs.readFileSync(path.join(path.dirname(r.output), "captions.ass"), "utf8");
  check("captions file has word events", (ass.match(/^Dialogue: 5,/gm) ?? []).length > 30);
  check("caption timing stays inside the video", (() => {
    const ends = [...ass.matchAll(/^Dialogue: \d+,[^,]+,(\d+):(\d\d):(\d\d\.\d\d)/gm)].map((m) => +m[1] * 3600 + +m[2] * 60 + +m[3]);
    return Math.max(...ends) <= r.resolved.duration + 0.05;
  })());
  const qa = await runJob(svc.qaCheck(r.renderId));
  check("qa_check returns contact sheet + cut frames", fs.existsSync(qa.contactSheet) && qa.cutFrames.length >= 2);
  const frames = await svc.framesGet({ renderId: r.renderId, times: [0.5, 5, 99] });
  check("frames_get clamps times past the end", frames.length === 3 && frames[2].t < r.resolved.duration && fs.existsSync(frames[2].path), `${frames.map((f) => f.t).join(", ")} vs ${r.resolved.duration}`);
  // A second final with the same name must not overwrite the first export.
  const r2 = await render({ ...tl, captions: { ...tl.captions, preset: "word-pop" } }, "final");
  check("second export gets a new file name (no overwrite)", r2.exported !== r.exported && fs.existsSync(r.exported) && fs.existsSync(r2.exported), `${r.exported} | ${r2.exported}`);
});

await group("render: rotated phone video", async () => {
  const src = halves(F.rotated, 2);
  const r = await render(base("rotated-9x16", { clips: [{ id: "c1", assetId: A.rotated, in: 0, out: 10 }] }));
  const out = halves(r.output, 2);
  check("portrait source → 9:16 keeps orientation", Math.sign(src.top - src.bottom) === Math.sign(out.top - out.bottom) && Math.abs(out.top - out.bottom) > 100, `src ${JSON.stringify(src)} out ${JSON.stringify(out)}`);
  const r2 = await render(base("rotated-16x9", { output: { aspect: "16:9", fps: 30, platform: "youtube" }, clips: [{ id: "c1", assetId: A.rotated, in: 0, out: 5, reframe: { mode: "fit" } }] }));
  const vs = probe(r2.output).streams.find((s) => s.codec_type === "video");
  check("portrait source → 16:9 with blurred fit (draft 960x540)", vs.width === 960 && vs.height === 540, `${vs.width}x${vs.height}`);
});

await group("render: edge cases", async () => {
  const na = await render(base("no-audio", { clips: [{ id: "c1", assetId: A.noaudio, in: 0, out: 5 }] }));
  check("video without audio renders with a silent track", probe(na.output).streams.some((s) => s.codec_type === "audio"));
  await expectError("captions on a video without transcript are refused", () => svc.timelineValidate(base("x", { clips: [{ id: "c1", assetId: A.noaudio, in: 0, out: 5 }], captions: { preset: "boxed" } })), "INVALID_INPUT", /transcript/);
  const vfr = await render(base("vfr", { clips: [{ id: "c1", assetId: A.vfr, sentences: { from: "s0001", to: "s0004" } }], captions: { preset: "word-pop" } }));
  check("VFR source: A/V lengths match", Math.abs(streamDur(vfr.output, "audio") - streamDur(vfr.output, "video")) < 0.1);
  check("VFR source: output is constant 30 fps", probe(vfr.output).streams.find((s) => s.codec_type === "video").r_frame_rate === "30/1");
  const odd = await render(base("odd file name", { clips: [{ id: "c1", assetId: A.odd, in: 0, out: 6 }], captions: { preset: "clean-subtitle" } }), "final");
  check("odd file name renders + exports with a safe name", fs.existsSync(odd.exported) && !/['()]/.test(path.basename(odd.exported)), odd.exported);
  for (const aspect of ["1:1", "4:5", "16:9"]) {
    const r = await render(base(`aspect ${aspect}`, { output: { aspect, fps: 30, platform: "generic" }, clips: [{ id: "c1", assetId: A.square25, in: 0, out: 6 }], captions: { preset: "boxed" } }));
    const vs = probe(r.output).streams.find((s) => s.codec_type === "video");
    const [aw, ah] = aspect.split(":").map(Number);
    check(`aspect ${aspect} (25 fps source → 30 fps)`, Math.abs(vs.width / vs.height - aw / ah) < 0.01 && vs.r_frame_rate === "30/1", `${vs.width}x${vs.height} ${vs.r_frame_rate}`);
  }
  const sp = await render(base("speed", { clips: [
    { id: "fast", assetId: A.square25, in: 0, out: 6, speed: 1.5, snap: "frame" },
    { id: "slow", assetId: A.square25, in: 6, out: 9, speed: 0.75, snap: "frame" },
  ], captions: { preset: "karaoke-highlight" } }));
  check("speed 1.5x + 0.75x durations", Math.abs(sp.resolved.duration - (6 / 1.5 + 3 / 0.75)) < 0.1, sp.resolved.duration);
  check("speed change keeps A/V in sync", Math.abs(streamDur(sp.output, "audio") - streamDur(sp.output, "video")) < 0.1);
  const img = await render(base("images", { clips: [
    { id: "a", assetId: A.png, duration: 2, reframe: { mode: "fit" } },
    { id: "b", assetId: A.bigjpg, duration: 2, motion: { type: "kenburns-in", strength: 1 }, transitionIn: { type: "fade-black", duration: 0.4 } },
  ], audio: [{ id: "m", assetId: A.music, role: "music", in: 2, out: 6, fadeIn: 0.5, fadeOut: 0.5 }] }));
  check("images (alpha PNG, 4000px JPEG) + music-only audio", Math.abs(img.resolved.duration - 3.6) < 0.05 && img.qa.fail === 0, JSON.stringify(img.qa));
  const indic = await render(base("indic", { clips: [{ id: "c1", assetId: A.talk, sentences: { from: "s0001", to: "s0002" } }],
    overlays: [
      { id: "h", component: "HookText", start: { at: 0 }, duration: 2, props: { text: "ज़्यादातर डेवलपर यही गलती करते हैं" } },
      { id: "p", component: "LowerThird", start: { at: 2 }, duration: 2, props: { name: "ਦੀਪਕ", role: "ਇੰਜੀਨੀਅਰ" } },
    ],
    captions: { source: "script", scriptText: "ज़्यादातर डेवलपर एक ही गलती करते हैं। वे समस्या समझने से पहले कोड लिखते हैं।", preset: "karaoke-highlight" } }));
  const ass = fs.readFileSync(path.join(path.dirname(indic.output), "captions.ass"), "utf8");
  check("Hindi uses Mukta, Punjabi uses Mukta Mahee", /\\fnMukta ExtraBold/.test(ass) && /\\fnMukta Mahee ExtraBold/.test(ass));
  if (F.hevc4k) {
    const h = await render(base("4k hevc", { clips: [{ id: "c1", assetId: A.hevc4k, in: 0, out: 4 }] }), "final");
    const vs = probe(h.output).streams.find((s) => s.codec_type === "video");
    check("4K HEVC source → 1080x1920 final", vs.width === 1080 && vs.height === 1920);
  }
});

await group("render: many cuts (batched)", async () => {
  // Silence removal splits the long clip; a run of short explicit clips guarantees > 20 pieces whatever the Whisper model hears.
  const extra = Array.from({ length: 12 }, (_, i) => ({ id: `x${i}`, assetId: A.many, in: 1 + i * 0.9, out: 1.5 + i * 0.9, snap: "frame" }));
  const tl = base("many-cuts", { clips: [{ id: "c1", assetId: A.many, in: 0, out: 9999, removeSilences: { minGap: 0.4, keepPad: 0.08 } }, ...extra], captions: { preset: "word-pop" } });
  const v = svc.timelineValidate(tl);
  check("long clip clamped with a warning", v.warnings.some((w) => /clamped/.test(w)), JSON.stringify(v.warnings));
  check("silence removal splits the clip", v.segments - extra.length >= 8, v.segments - extra.length);
  check("more than 20 pieces in total", v.segments > 20, v.segments);
  const r = await render(tl);
  const dir = path.dirname(r.output);
  check("rendered in batches", fs.readdirSync(dir).filter((f) => f.startsWith("batch-")).length >= 2);
  check("batched output duration matches", Math.abs(streamDur(r.output, "video") - r.resolved.duration) < 0.15, `${streamDur(r.output, "video")} vs ${r.resolved.duration}`);
  check("batched A/V in sync", Math.abs(streamDur(r.output, "audio") - streamDur(r.output, "video")) < 0.12);
  const c1 = r.resolved.clipsSummary.find((c) => c.clipId === "c1");
  const c1Dur = c1.tlEnd - c1.tlStart;
  check("silence actually removed", c1Dur < streamDur(F.many, "audio") * 0.85, `${c1Dur} of ${streamDur(F.many, "audio")}`);
});

if (A.face) {
  await group("render: face tracking", async () => {
    const r = await render(base("auto-face", { clips: [{ id: "c1", assetId: A.face, in: 0, out: 6, reframe: { mode: "auto-face" } }] }));
    const seg = r.resolved.segments[0];
    const cx = (seg.crop.x + seg.crop.w / 2) / seg.srcW;
    check("auto-face crop centred on the face (face at 30% of width)", Math.abs(cx - 0.3) < 0.06, `crop centre at ${(cx * 100).toFixed(1)}%`);
    const s = await render(base("split", { clips: [{ id: "c1", assetId: A.two, in: 0, out: 6, reframe: { mode: "split" } }] }));
    const sg = s.resolved.segments[0];
    const ok = sg.layout === "split" && sg.split.length === 2;
    const c1 = ok ? (sg.split[0].x + sg.split[0].w / 2) / sg.srcW : 0;
    const c2 = ok ? (sg.split[1].x + sg.split[1].w / 2) / sg.srcW : 0;
    check("split layout picks both faces (25% and 75%)", ok && Math.abs(c1 - 0.25) < 0.07 && Math.abs(c2 - 0.75) < 0.07, `${ok} ${c1.toFixed(2)} ${c2.toFixed(2)}`);
  });
}


await group("v0.2: transitions, zooms, speed, freeze, reverse", async () => {
  const types = (await load("dist/schema/timeline.js")).TRANSITIONS.filter((t) => t !== "cut");
  const clips = types.map((t, i) => ({ id: `t${i}`, assetId: A.square25, in: (i % 10) * 1.5, out: (i % 10) * 1.5 + 1.2, snap: "frame", ...(i ? { transitionIn: { type: t, duration: 0.3 } } : {}) }));
  clips.push({ id: "last", assetId: A.square25, in: 0, out: 1.2, snap: "frame", transitionIn: { type: types[0], duration: 0.3 } });
  const all = await render(base("all transitions", { output: { aspect: "1:1", fps: 30, platform: "generic" }, clips }));
  const expect = clips.length * 1.2 - (clips.length - 1) * 0.3;
  check(`all ${types.length} transition types render`, Math.abs(all.resolved.duration - expect) < 0.05 && all.resolved.transitions.length === clips.length - 1, `${all.resolved.duration} vs ${expect}`);
  check("transitions: output length and A/V match", Math.abs(streamDur(all.output, "video") - all.resolved.duration) < 0.12 && Math.abs(streamDur(all.output, "audio") - streamDur(all.output, "video")) < 0.12);

  const plain = await render(base("zoom off", { clips: [{ id: "c", assetId: A.talk, in: 0, out: 4, snap: "frame" }] }));
  const zoomed = await render(base("zoom on", { clips: [{ id: "c", assetId: A.talk, in: 0, out: 4, snap: "frame" }], zooms: [{ start: { at: 1 }, duration: 2, scale: 2, ease: "snap" }] }));
  // While zoomed 2x at (0.5, 0.42), the frame should look like the plain frame's matching half-size crop.
  const zc = "crop=iw/2:ih/2:iw/4:ih*0.21";
  const fb = (file, t, filter) => frameBytes(file, t, filter, "32:32", "gray", "area");
  const dMatch = absDiff(fb(zoomed.output, 2, ""), fb(plain.output, 2, zc));
  const dPlain = absDiff(fb(zoomed.output, 2, ""), fb(plain.output, 2, ""));
  const d0 = absDiff(fb(plain.output, 0.3, ""), fb(zoomed.output, 0.3, ""));
  check("zoom magnifies the focus area only while active", dMatch < dPlain * 0.6 && d0 < 3, `match ${dMatch.toFixed(1)} plain ${dPlain.toFixed(1)} before ${d0.toFixed(1)}`);

  const punch = svc.timelineValidate(base("punch", { autoPunch: { scale: 1.3, every: "cut" }, clips: [{ id: "c", assetId: A.talk, sentences: { from: "s0001", to: "s0006" }, removeSilences: { minGap: 0.5, keepPad: 0.1 } }] }));
  const pr = await render(base("punch", { autoPunch: { scale: 1.3, every: "cut" }, clips: [{ id: "c", assetId: A.talk, sentences: { from: "s0001", to: "s0006" }, removeSilences: { minGap: 0.5, keepPad: 0.1 } }] }));
  const widths = pr.resolved.segments.map((x) => x.crop.w);
  check("autoPunch alternates framing per cut", widths.length > 2 && widths.every((w, i) => i === 0 || w !== widths[i - 1]), widths.join(","));

  const ramp = svc.timelineValidate(base("ramp", { clips: [{ id: "c", assetId: A.square25, in: 0, out: 6, snap: "frame", speedRamp: [{ at: 3, speed: 2 }] }] }));
  check("speed ramp: 3 s at 1x + 3 s at 2x = 4.5 s", Math.abs(ramp.duration - 4.5) < 0.05, ramp.duration);

  const fz = await render(base("freeze", { clips: [{ id: "c", assetId: A.square25, in: 0, out: 4, snap: "frame", freezes: [{ at: 2, duration: 1, flash: true }] }] }));
  const flashLuma = mean(frameBytes(fz.output, 2.03));
  const normalLuma = mean(frameBytes(fz.output, 1.5));
  check("freeze adds its duration", Math.abs(fz.resolved.duration - 5) < 0.05, fz.resolved.duration);
  check("freeze flash is bright", flashLuma > normalLuma + 40, `${flashLuma.toFixed(0)} vs ${normalLuma.toFixed(0)}`);
  check("freeze holds a still frame", absDiff(frameBytes(fz.output, 2.4), frameBytes(fz.output, 2.9)) < 2);
  const rv = await render(base("reverse", { clips: [{ id: "c", assetId: A.square25, in: 1, out: 4, snap: "frame", reverse: true }] }));
  const sq = "crop=ih*9/16:ih";
  check("reverse: first frame of output ≈ end of the source range", absDiff(frameBytes(rv.output, 0.02), frameBytes(F.square25, 3.95, sq)) < absDiff(frameBytes(rv.output, 0.02), frameBytes(F.square25, 1.05, sq)));
});

await group("v0.2: looks, masks, layers, audio", async () => {
  const looks = (await load("dist/schema/timeline.js")).LOOK_PRESETS;
  const lk = await render(base("all looks", { output: { aspect: "1:1", fps: 30, platform: "generic" }, clips: looks.map((l, i) => ({ id: `l${i}`, assetId: A.square25, in: i * 0.5, out: i * 0.5 + 0.6, snap: "frame", look: { preset: l, vignette: 0.3, grain: 0.2, sharpen: 0.2, warmth: 0.3 } })) }));
  check(`all ${looks.length} look presets render`, lk.qa.fail === 0);
  const bw = await render(base("bw", { output: { aspect: "1:1", fps: 30, platform: "generic" }, look: { preset: "bw" }, clips: [{ id: "c", assetId: A.square25, in: 0, out: 2, snap: "frame" }] }));
  const rgb = frameBytes(bw.output, 1, "", "8:8", "rgb24");
  let maxDev = 0;
  for (let i = 0; i < rgb.length; i += 3) maxDev = Math.max(maxDev, Math.abs(rgb[i] - rgb[i + 1]), Math.abs(rgb[i + 1] - rgb[i + 2]));
  check("black & white look has no colour", maxDev < 14, maxDev);

  // A LUT file from library/luts (an identity LUT: the picture must stay the same).
  const lutName = "_e2e_identity.cube";
  fs.writeFileSync(path.join(ROOT, "library", "luts", lutName), "LUT_3D_SIZE 2\n0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1\n");
  const sq = { output: { aspect: "1:1", fps: 30, platform: "generic" } };
  const noLut = await render(base("no lut", { ...sq, clips: [{ id: "c", assetId: A.square25, in: 0, out: 1, snap: "frame" }] }));
  const withLut = await render(base("identity lut", { ...sq, look: { lut: lutName }, clips: [{ id: "c", assetId: A.square25, in: 0, out: 1, snap: "frame" }] }));
  const lutDiff = absDiff(frameBytes(withLut.output, 0.5, "", "32:32", "rgb24", "area"), frameBytes(noLut.output, 0.5, "", "32:32", "rgb24", "area"));
  check("LUT from library/luts applies (identity keeps the picture)", lutDiff < 3, lutDiff.toFixed(2));

  const masked = await render(base("masks", { output: { aspect: "16:9", fps: 30, platform: "generic" }, clips: [{ id: "c", assetId: A.talk, in: 0, out: 3, snap: "frame" }],
    masks: [{ id: "box", start: { at: 0 }, duration: 3, rect: { x: 0.45, y: 0.45, w: 0.1, h: 0.1 }, type: "box", color: "#FF0000" },
            { id: "blur", start: { at: 0 }, duration: 3, rect: { x: 0.0, y: 0.0, w: 0.4, h: 0.4 }, type: "blur", strength: 1 }] }));
  const unmasked = await render(base("no masks", { output: { aspect: "16:9", fps: 30, platform: "generic" }, clips: [{ id: "c", assetId: A.talk, in: 0, out: 3, snap: "frame" }] }));
  const px = frameBytes(masked.output, 1.5, "crop=iw*0.05:ih*0.05:iw*0.475:ih*0.475", "1:1", "rgb24");
  check("box mask paints its colour", px[0] > 200 && px[1] < 60 && px[2] < 60, [...px].join(","));
  const crop = "crop=iw*0.38:ih*0.38:iw*0.01:ih*0.01";
  // Sharp detail = number of large steps between neighbouring pixels (blur turns edges into gentle ramps).
  const sharp = (b) => {
    const n = 64;
    let k = 0;
    for (let y = 0; y < n; y++) for (let x = 1; x < n; x++) if (Math.abs(b[y * n + x] - b[y * n + x - 1]) > 12) k++;
    return k;
  };
  const sm = sharp(frameBytes(masked.output, 1.5, crop, "64:64"));
  const su = sharp(frameBytes(unmasked.output, 1.5, crop, "64:64"));
  check("blur mask removes sharp detail", sm < su * 0.3 && su > 20, `${sm} vs ${su} sharp steps`);

  const pip = await render(base("pip", { clips: [{ id: "c", assetId: A.talk, in: 0, out: 4, snap: "frame" }],
    layers: [{ id: "p", assetId: A.bigjpg, start: { at: 1 }, duration: 2, mode: "pip", rect: { x: 0.5, y: 0.1, w: 0.4 }, border: 10, borderColor: "#FFFFFF" },
             { id: "f", assetId: A.square25, in: 5, start: { at: 3.2 }, duration: 0.7, mode: "full" }] }));
  const L = pip.resolved.layers[0];
  // Sample the middle of the top border strip.
  const border = frameBytes(pip.output, 2, `crop=16:2:${L.rect.x + Math.round(L.rect.w / 2)}:${L.rect.y - L.border + 1}`, "1:1", "rgb24");
  check("picture-in-picture with white border", border[0] > 200 && border[1] > 200 && border[2] > 200, [...border].join(","));
  check("B-roll cutaway replaces the picture", absDiff(frameBytes(pip.output, 3.5), frameBytes(F.square25, 5.3, "crop=ih*9/16:ih")) < absDiff(frameBytes(pip.output, 3.5), frameBytes(pip.output, 0.5)));

  const au = await render(base("audio fx", { sfxOnTransitions: "sfx/whoosh", transition: { type: "crossfade", duration: 0.3 },
    clips: [{ id: "a", assetId: A.talk, sentences: { from: "s0001", to: "s0001" }, audio: { denoise: true, enhance: true } }, { id: "b", assetId: A.talk, sentences: { from: "s0002", to: "s0002" } }],
    audio: [{ id: "p", library: "sfx/pop", role: "sfx", start: { at: 0.5 } }, { id: "d", library: "sfx/ding", role: "sfx", start: { clip: "b", sourceTime: 6 } }] }), "final");
  check("sfx library + voice cleanup + transition whoosh", au.qa.fail === 0 && au.resolved.audio.some((x) => x.id.startsWith("auto-sfx")) && au.resolved.audio.length === 3, JSON.stringify(au.resolved.audio.map((x) => x.id)));
  check("catalog lists 11 sound effects", svc.catalog("sfx").length >= 11, svc.catalog("sfx").join(","));
});

await group("v0.2: beats + beat sync", async () => {
  const imp = await runJob(svc.mediaImport(P, [F.clicks]));
  A.clicks = imp.assets[0].assetId;
  const b = await runJob(svc.analyze({ assetId: A.clicks, include: ["beats"] }));
  check("beat analysis finds 120 BPM", Math.abs(b.summary.beats.tempo - 120) < 4, JSON.stringify(b.summary.beats));
  const beats = svc.analysisGet(A.clicks, "beats").beats;
  const tl = base("beat sync", { output: { aspect: "1:1", fps: 30, platform: "generic" }, beatSync: { audioId: "m", every: 2 },
    clips: [0, 1, 2].map((i) => ({ id: `c${i}`, assetId: A.square25, in: i * 3, out: i * 3 + 1.7, snap: "frame" })),
    audio: [{ id: "m", assetId: A.clicks, role: "music", start: { at: 0 } }] });
  const v = svc.timelineValidate(tl);
  const offs = v.clips.slice(0, 2).map((c) => Math.min(...beats.map((x) => Math.abs(x - c.tlEnd))));
  check("beat sync lands cuts on beats", offs.every((o) => o < 0.05), offs.join(","));
});

await group("v0.2: styles", async () => {
  const st = svc.catalog("styles");
  check("6 built-in styles", st.filter((x) => x.builtIn).length >= 6, st.map((x) => x.id).join(","));
  const v = svc.timelineValidate(base("styled", { style: "hype", clips: [{ id: "a", assetId: A.talk, sentences: { from: "s0001", to: "s0003" } }, { id: "b", assetId: A.talk, sentences: { from: "s0004", to: "s0006" } }] }));
  check("style applies captions + transition + silence removal", v.captions?.preset === "word-pop" && v.segments > 2, JSON.stringify({ c: v.captions, s: v.segments }));
  const saved = svc.styleSave({ name: "Deepak test style", description: "test", look: { preset: "warm" }, transition: { type: "slide-left", duration: 0.3 }, captions: { preset: "boxed" } });
  check("style_save writes a reusable style", svc.catalog("styles").some((x) => x.id === saved.id && !x.builtIn), saved.id);
  const v2 = svc.timelineValidate(base("styled2", { style: saved.id, clips: [{ id: "a", assetId: A.talk, sentences: { from: "s0001", to: "s0002" } }, { id: "b", assetId: A.talk, sentences: { from: "s0003", to: "s0004" } }] }));
  check("saved style applies", v2.captions?.preset === "boxed", JSON.stringify(v2.captions));
  const noTr = svc.timelineValidate(base("styled silent", { style: "hype", clips: [{ id: "a", assetId: A.noaudio, in: 0, out: 4 }] }));
  check("style captions skipped (with a note) when there is no transcript", !noTr.captions && noTr.warnings.some((w) => /captions skipped/.test(w)), JSON.stringify(noTr.warnings));
});

await group("v0.2: animated graphics + custom effects", async () => {
  const comps = [
    ["AnimatedTitle", { text: "Big news", style: "pop" }], ["AnimatedTitle", { text: "Typewriter", style: "typewriter", position: "top" }],
    ["AnimatedTitle", { text: "हिंदी ਪੰਜਾਬੀ test", style: "highlight", uppercase: false }], ["Emoji", { emoji: "🔥", animation: "shake" }],
    ["Arrow", { from: { x: 0.2, y: 0.2 }, to: { x: 0.6, y: 0.5 }, label: "Look" }], ["Callout", { rect: { x: 0.3, y: 0.3, w: 0.4, h: 0.2 }, shape: "circle", label: "Here", dimOutside: true }],
    ["CountUp", { to: 200000, prefix: "₹" }], ["ProgressBar", {}], ["FollowCTA", { handle: "@test" }], ["Confetti", {}], ["Checklist", { title: "Steps", items: ["One", "Two", "Three"] }],
  ];
  const tl = base("graphics", { clips: [{ id: "c", assetId: A.square25, in: 0, out: 9, snap: "frame" }],
    overlays: comps.map(([c, p], i) => ({ id: `g${i}`, component: c, start: { at: i * 0.75 }, duration: 1.2, props: p })) });
  const t0 = Date.now();
  const r = await render(tl);
  check(`all ${new Set(comps.map((c) => c[0])).size} animated components render (${((Date.now() - t0) / 1000).toFixed(0)} s)`, r.qa.fail === 0);
  const dir = path.dirname(r.output);
  const gdirs = fs.readdirSync(dir).filter((d) => d.startsWith("graphic-"));
  const drawn = gdirs.filter((g) => {
    const files = fs.readdirSync(path.join(dir, g)).filter((f) => f.endsWith(".png")).sort();
    const mid = path.join(dir, g, files[Math.floor(files.length * 0.6)]);
    return mean(frameBytes(mid, 0, "alphaextract", "16:16")) > 0.5;
  });
  check("every graphic draws visible pixels", drawn.length === comps.length, `${drawn.length}/${comps.length}`);
  check("graphics change the picture", absDiff(frameBytes(r.output, 0.6), frameBytes(F.square25, 0.6, "crop=ih*9/16:ih")) > 3);

  const good = `import React from "react";\nimport { AbsoluteFill, useCurrentFrame, interpolate } from "remotion";\nexport default function Bar(props: any) {\n  const f = useCurrentFrame();\n  return <AbsoluteFill><div style={{ position: "absolute", left: 0, top: "45%", height: "10%", width: interpolate(f, [0, 20], [0, 100], { extrapolateRight: "clamp" }) + "%", background: props.color ?? "#00FF88" }} /></AbsoluteFill>;\n}\n`;
  const c1 = await svc.fxCreate({ name: "e2e-bar", description: "test bar", code: good, defaultProps: { color: "#00FF88" }, defaultDuration: 1 });
  check("fx_create builds and previews", c1.ok && fs.existsSync(c1.preview), JSON.stringify(c1).slice(0, 300));
  const c2 = await svc.fxCreate({ name: "e2e-bar", description: "broken update", code: good.replace("return <AbsoluteFill>", "return <AbsoluteFill") });
  const kept = fs.readFileSync(path.join(process.env.TALK_N_EDIT_HOME, "fx", "e2e-bar.tsx"), "utf8") === good;
  check("broken update is rejected and the working version kept", !c2.ok && kept, JSON.stringify(c2).slice(0, 200));
  const c3 = await svc.fxCreate({ name: "e2e-evil", description: "x", code: `import cp from "child_process";\nexport default function X(){ return null; }` });
  check("effects cannot import Node modules", !c3.ok && c3.stage === "check");
  check("custom effect appears in the catalog", svc.catalog("components").some((x) => x.name === "fx:e2e-bar"));
  const fr = await render(base("fx use", { output: { aspect: "16:9", fps: 30, platform: "generic" }, clips: [{ id: "c", assetId: A.square25, in: 0, out: 2, snap: "frame" }], overlays: [{ id: "x", component: "fx:e2e-bar", start: { at: 0.5 }, duration: 1, props: { color: "#FF00FF" } }] }));
  const mag = frameBytes(fr.output, 1.3, "crop=iw*0.3:ih*0.04:iw*0.05:ih*0.48", "1:1", "rgb24");
  check("custom effect renders into the video with its props", mag[0] > 180 && mag[1] < 90 && mag[2] > 180, [...mag].join(","));
});

await group("links: import from a URL, discovery helpers", async () => {
  // A tiny web server with Range support stands in for a video site (yt-dlp's generic extractor).
  process.env.NO_PROXY = process.env.no_proxy = [process.env.NO_PROXY, "127.0.0.1", "localhost"].filter(Boolean).join(",");
  const srv = http.createServer((req, res) => {
    const f = path.join(FIX, decodeURIComponent(new URL(req.url, "http://x").pathname));
    if (!f.startsWith(FIX) || !fs.existsSync(f) || !fs.statSync(f).isFile()) {
      res.statusCode = 404;
      return res.end("not found");
    }
    const size = fs.statSync(f).size;
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Content-Type", f.endsWith(".mp4") ? "video/mp4" : "application/octet-stream");
    const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range ?? "");
    if (m) {
      const s0 = m[1] ? +m[1] : 0;
      const e0 = m[2] ? Math.min(+m[2], size - 1) : size - 1;
      res.statusCode = 206;
      res.setHeader("Content-Range", `bytes ${s0}-${e0}/${size}`);
      res.setHeader("Content-Length", e0 - s0 + 1);
      if (req.method === "HEAD") return res.end();
      return fs.createReadStream(f, { start: s0, end: e0 }).pipe(res);
    }
    res.setHeader("Content-Length", size);
    if (req.method === "HEAD") return res.end();
    fs.createReadStream(f).pipe(res);
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const BASE = `http://127.0.0.1:${srv.address().port}`;
  const P2 = svc.projectOpen("Links project");
  const inbox = config.getConfig().inboxDir;
  check("inbox can be moved in config (tests never touch ~/Downloads)", inbox.startsWith(TMP), inbox);
  check("inbox is always importable", config.getConfig().importRoots.includes(inbox));
  const runJob = async (job) => {
    await svc.waitForJob(job.id);
    return (await svc.waitJobs([job.id], 0))[0];
  };
  try {
    const whole = await runJob(svc.mediaImportUrl(P2.projectId, `${BASE}/talk.mp4`));
    const wa = whole.result?.assets?.[0];
    check("import from a link succeeds", whole.status === "succeeded" && !!wa, JSON.stringify(whole.error ?? whole.result).slice(0, 300));
    check("downloaded into the Inbox", !!whole.result?.downloaded && whole.result.downloaded.startsWith(inbox) && fs.existsSync(whole.result.downloaded), whole.result?.downloaded);
    check("downloaded video is complete", wa && Math.abs(wa.duration - streamDur(F.talk, "video")) < 0.15, `${wa?.duration} vs ${streamDur(F.talk, "video")}`);
    if (wa) {
      const src = svc.analysisGet(wa.assetId, "source");
      check("source info kept with the asset", src.url.includes("talk") && typeof src.title === "string" && src.title.length > 0, JSON.stringify(src).slice(0, 200));
    }
    const part = await runJob(svc.mediaImportUrl(P2.projectId, `${BASE}/talk.mp4`, { start: 2, end: 5 }));
    const pa = part.result?.assets?.[0];
    check("download just part of a video", part.status === "succeeded" && pa && Math.abs(pa.duration - 3) < 0.35, JSON.stringify(part.error ?? pa).slice(0, 300));
    check("part has its own file name", !!part.result?.downloaded && /\(0m02s-0m05s\)/.test(part.result.downloaded), part.result?.downloaded);
    check("part records its offset", part.result?.source?.sectionStart === 2 && part.result?.source?.sectionEnd === 5, JSON.stringify(part.result?.source ?? {}).slice(0, 200));
    if (pa && wa) {
      const ta = await runJob(svc.analyze({ assetId: pa.assetId, include: ["transcript"] }));
      check("downloaded part transcribes", ta.status === "succeeded", JSON.stringify(ta.error ?? "").slice(0, 200));
    }
    const before = fs.readdirSync(inbox).length;
    const li = await svc.linkInfoGet(`${BASE}/talk.mp4`);
    check("link_info looks without downloading", !!li.source.title && li.source.url.includes("talk") && fs.readdirSync(inbox).length === before, JSON.stringify(li.source).slice(0, 200));
    const missing = await runJob(svc.mediaImportUrl(P2.projectId, `${BASE}/no-such-video.mp4`));
    check("missing video → clear error", missing.status === "failed" && /NOT_FOUND|ENGINE_FAILED/.test(missing.error?.code ?? "") && !!missing.error?.message, JSON.stringify(missing.error ?? {}).slice(0, 200));
  } finally {
    srv.close();
  }
  const err = (fn) => {
    try {
      fn();
      return null;
    } catch (e) {
      return e;
    }
  };
  check("not a link → INVALID_INPUT", err(() => svc.mediaImportUrl(P2.projectId, "my video.mp4"))?.code === "INVALID_INPUT");
  check("end before start → INVALID_INPUT", err(() => svc.mediaImportUrl(P2.projectId, "https://example.com/v", { start: 9, end: 3 }))?.code === "INVALID_INPUT");

  const web = await load("dist/web.js");
  const t = (d) => web.discoverTarget(d).target;
  check("discover: YouTube search", t({ query: "podcast clips" }) === "ytsearch10:podcast clips");
  check("discover: newest first", t({ query: "x", sort: "newest", count: 5 }) === "ytsearchdate5:x");
  check("discover: most viewed fetches extra to sort", t({ query: "x", sort: "views", count: 5 }) === "ytsearch20:x");
  check("discover: channel Shorts", t({ channel: "@mkbhd", tab: "shorts" }) === "https://www.youtube.com/@mkbhd/shorts");
  check("discover: channel link", t({ channel: "https://www.youtube.com/@mkbhd/videos" }) === "https://www.youtube.com/@mkbhd/videos");
  check("discover: Twitch clips", t({ platform: "twitch", channel: "shroud", range: "30d" }) === "https://www.twitch.tv/shroud/clips?filter=clips&range=30d");
  check("discover: Twitch link is recognised", t({ channel: "https://www.twitch.tv/shroud", tab: "videos" }) === "https://www.twitch.tv/shroud/videos?filter=archives&sort=time");
  check("discover: Twitch needs a channel", err(() => web.discoverTarget({ platform: "twitch" }))?.code === "INVALID_INPUT");
  check("discover: needs something to search", err(() => web.discoverTarget({}))?.code === "INVALID_INPUT");
  const listing = {
    extractor: "youtube:search",
    entries: [
      { ie_key: "Youtube", id: "aaa", title: "Short one", duration: 40, view_count: 900, channel: "A" },
      { ie_key: "Youtube", id: "bbb", title: "Long one", duration: 4000, view_count: 50000, channel: "B" },
      { ie_key: "Youtube", id: "ccc", title: "Medium", duration: 600, view_count: 12000, channel: "C", upload_date: "20261101" },
    ],
  };
  const found = web.parseListing(listing, { sort: "views", maxDuration: 3600, count: 5 });
  check("discover: filters by length and sorts by views", found.map((x) => x.title).join("|") === "Medium|Short one", JSON.stringify(found));
  check("discover: builds links, dates and thumbnails", found[0].url === "https://www.youtube.com/watch?v=ccc" && found[0].uploadDate === "2026-11-01" && /i\.ytimg\.com\/vi\/ccc\//.test(found[0].thumbnail));
  const heat = Array.from({ length: 100 }, (_, i) => ({ start_time: i * 6, end_time: i * 6 + 6, value: i === 20 ? 1 : i === 21 ? 0.95 : i === 70 ? 0.8 : 0.1 }));
  const peaks = web.replayPeaks(heat, 60, 600);
  check("most-replayed peaks: only real peaks, no overlaps, in time order, shifted to the section", peaks?.length === 2 && peaks[0].start === 60 && peaks[1].start === 360, JSON.stringify(peaks));
});

await group("v0.2.1: caption lines, letterbox trim, caption size", async () => {
  // Own caption text (Hinglish, translations) per time range follows the speech word by word.
  const sec = (m) => +m.split(":")[0] * 60 + +m.split(":")[1];
  const ranges = [...svc.transcriptGet(A.talk, {}).matchAll(/^\[(s\d+) ([\d:.]+)–([\d:.]+)\]/gm)].map((m) => ({ id: m[1], s: sec(m[2]), e: sec(m[3]) }));
  const [r1, r2] = ranges;
  const texts = ["Zyaadatar developers shuru mein ek hi galti karte hain.", "Woh problem samajhne se pehle code likhte hain."];
  const tl = base("caption-lines", {
    clips: [{ id: "c1", assetId: A.talk, in: Math.max(0, r1.s - 0.3), out: r2.e + 0.3 }],
    captions: { source: "lines", preset: "word-pop", size: 1.4, lines: [r1, r2].map((r, i) => ({ start: { clip: "c1", sourceTime: r.s }, end: { clip: "c1", sourceTime: r.e }, text: texts[i] })) },
  });
  const r = await render(tl);
  const w = r.resolved.captions.words;
  const nTok = texts.join(" ").split(/\s+/).length;
  check("caption lines: every word of my text is shown", w.length === nTok && w.map((x) => x.w).join(" ") === texts.join(" "), `${w.length} of ${nTok}`);
  const off = Math.max(0, r1.s - 0.3);
  const inside = (x, rr) => x.s >= rr.s - off - 0.06 && x.e <= rr.e - off + 0.06;
  const n1 = texts[0].split(" ").length;
  check("caption lines: words stay inside their line's time range", w.slice(0, n1).every((x) => inside(x, r1)) && w.slice(n1).every((x) => inside(x, r2)), JSON.stringify(w.slice(0, 3)));
  check("caption lines: words run in order", w.every((x, i) => i === 0 || x.s >= w[i - 1].s - 1e-6) && w.every((x) => x.e > x.s));
  const ass = fs.readFileSync(path.join(path.dirname(r.output), "captions.ass"), "utf8");
  const capSize = +(ass.match(/^Style: Cap,[^,]+,(\d+),/m) ?? [])[1];
  const minDim = Math.min(r.resolved.width, r.resolved.height);
  check("caption size multiplier", Math.abs(capSize - Math.round(0.095 * minDim * 1.4)) <= 1, `${capSize} vs ${Math.round(0.095 * minDim * 1.4)}`);
  const bad = (() => { try { svc.timelineValidate({ ...tl, captions: { source: "lines", lines: [{ start: { clip: "c1", sourceTime: r1.e }, end: { clip: "c1", sourceTime: r1.s }, text: "x" }] } }, false); return null; } catch (e) { return e; } })();
  check("caption line ending before it starts → error with path", bad && /captions\.lines\[0\]\.end/.test(JSON.stringify(bad)), bad?.message);

  const ovw = svc.timelineValidate(base("overlap-check", { clips: [{ id: "a", assetId: A.talk, in: 0, out: 3, snap: "frame" }, { id: "b", assetId: A.talk, in: 2.5, out: 5, snap: "frame" }] }), false).warnings;
  check("back-to-back clips that repeat source → warning", ovw.some((w) => /overlap by 0\.5s/.test(w)), JSON.stringify(ovw));

  // Letterboxed source: trim the bars before fitting; black or blurred fill.
  const lb = (name, reframe) => render(base(name, { clips: [{ id: "c1", assetId: A.letterbox, in: 0, out: 3, reframe }] }));
  const plain = await lb("lb-plain", { mode: "fit" });
  const trimmed = await lb("lb-trim", { mode: "fit", trim: { top: 0.131, bottom: 0.131 } });
  const black = await lb("lb-black", { mode: "fit", background: "black", trim: { top: 0.131, bottom: 0.131 } });
  const topBand = (f) => mean(frameBytes(f, 1.5, "crop=iw:ih*0.08:0:0", "32:8"));
  const midBand = (f) => mean(frameBytes(f, 1.5, "crop=iw:ih*0.1:0:ih*0.45", "32:8"));
  check("fit trim removes the bars from the blurred fill", topBand(trimmed.output) > topBand(plain.output) + 15, `${topBand(trimmed.output).toFixed(1)} vs ${topBand(plain.output).toFixed(1)}`);
  check("fit background black", topBand(black.output) < 6 && midBand(black.output) > 40, `${topBand(black.output).toFixed(1)} / ${midBand(black.output).toFixed(1)}`);
  const stripRows = (f) => { const b = frameBytes(f, 1.5, "crop=8:ih:iw/2:0", "1:240"); let n = 0; for (const v of b) if (v > 12) n++; return n; };
  const want = Math.round((240 * (r.resolved.width * 532) / 1280) / r.resolved.height);
  check("fit trim keeps the picture's full width (no bars inside the strip)", Math.abs(stripRows(black.output) - want) <= 4, `${stripRows(black.output)} rows vs ${want}`);
});

await group("v0.2: tools for revising and reviewing", async () => {
  const sc = svc.analysisGet(A.talk, "scenes");
  check("analysis_get scenes lists shots with face data", sc.scenes.length >= 1 && "face" in sc.scenes[0]);
  const v = svc.timelineValidate(base("revise me", { clips: [{ id: "c", assetId: A.talk, in: 0, out: 3 }] }));
  const got = svc.timelineGet({ timelineId: v.timelineId });
  check("timeline_get returns the saved timeline", got.timeline.name === "revise me" && got.version === v.version);
  const edited = { ...got.timeline, clips: [{ ...got.timeline.clips[0], out: 2.5 }] };
  const v2 = svc.timelineValidate(edited);
  check("a revision becomes the next version", v2.version === v.version + 1 && v2.timelineId === v.timelineId);
  const rr = await render(base("open me", { clips: [{ id: "c", assetId: A.talk, in: 0, out: 2 }] }));
  const op = svc.openInPlayer(rr.renderId);
  check("open_in_player returns without crashing", op.opened === rr.output);
});

await group("timeline validation errors", async () => {
  const c = { id: "c1", assetId: A.talk, in: 0, out: 5 };
  const cases = [
    ["duplicate clip ids", base("e", { clips: [c, c] }), /Duplicate clip id/],
    ["in after out", base("e", { clips: [{ ...c, in: 5, out: 3 }] }), /must be after/],
    ["in past the end", base("e", { clips: [{ ...c, in: 500, out: 600 }] }), /past the end/],
    ["unknown asset", base("e", { clips: [{ ...c, assetId: "ast_missing" }] }), /No asset/],
    ["audio file used as a clip", base("e", { clips: [{ ...c, assetId: A.music }] }), /audio-only/],
    ["unknown component", base("e", { clips: [c], overlays: [{ id: "o", component: "Sparkles", start: { at: 0 }, duration: 1 }] }), /Unknown component/],
    ["bad component props", base("e", { clips: [c], overlays: [{ id: "o", component: "HookText", start: { at: 0 }, duration: 1, props: { txt: "x" } }] }), /HookText props/],
    ["overlay after the end", base("e", { clips: [c], overlays: [{ id: "o", component: "HookText", start: { at: 50 }, duration: 1, props: { text: "x" } }] }), /after the timeline ends/],
    ["anchor outside the clip", base("e", { clips: [c], overlays: [{ id: "o", component: "HookText", start: { clip: "c1", sourceTime: 20 }, duration: 1, props: { text: "x" } }] }), /not inside clip/],
    ["unknown caption preset", base("e", { clips: [c], captions: { preset: "rainbow" } }), /Unknown caption preset/],
    ["unknown sentence id", base("e", { clips: [{ id: "c1", assetId: A.talk, sentences: { from: "s0001", to: "s9999" } }] }), /Unknown sentence/],
    ["missing in/out", base("e", { clips: [{ id: "c1", assetId: A.talk }] }), /needs ..?in..? and ..?out/],
    ["unknown field (typo)", base("e", { clips: [{ ...c, reframe_mode: "x" }] }), /Unrecognized key|unrecognized/i],
    ["wrong project", { ...base("e", { clips: [c] }), projectId: "prj_other" }, /No project/],
  ];
  for (const [name, tl, re] of cases) await expectError(name, () => svc.timelineValidate(tl), undefined, re);
  const v1 = svc.timelineValidate(base("versioning", { clips: [c] }));
  const v2 = svc.timelineValidate(base("versioning", { clips: [c] }));
  const v3 = svc.timelineValidate(base("versioning", { clips: [{ ...c, out: 4 }] }));
  check("identical timeline reuses its version; a change adds one", v1.version === v2.version && v3.version === v1.version + 1 && v3.timelineId === v1.timelineId, `${v1.version} ${v2.version} ${v3.version}`);
});

await group("jobs: cancel, queue, recovery", async () => {
  const r = svc.renderStart({ timeline: base("to-cancel", { clips: [{ id: "c1", assetId: A.many, in: 0, out: 9999, removeSilences: {} }], captions: { preset: "karaoke-highlight" } }), quality: "final" });
  for (let i = 0; i < 100; i++) {
    const [v] = await svc.waitJobs([r.jobId], 0);
    if (v.status === "running" && v.progress > 0.04) break;
    await new Promise((s) => setTimeout(s, 200));
  }
  svc.cancelJob(r.jobId);
  const done = await svc.waitForJob(r.jobId);
  check("running render can be cancelled", done.status === "cancelled", done.status);
  const a = svc.renderStart({ timeline: base("queue-a", { clips: [{ id: "c1", assetId: A.talk, in: 0, out: 3 }] }), quality: "draft" });
  const b = svc.renderStart({ timeline: base("queue-b", { clips: [{ id: "c1", assetId: A.talk, in: 3, out: 6 }] }), quality: "draft" });
  const [ja, jb] = await Promise.all([svc.waitForJob(a.jobId), svc.waitForJob(b.jobId)]);
  check("two queued renders both finish", ja.status === "succeeded" && jb.status === "succeeded");
  // Simulate jobs left behind by a crashed server process (pid that cannot exist).
  const d = db.getDb();
  const ts = db.now();
  d.prepare(`INSERT INTO jobs (id,type,queue,status,stage,progress,input,created,updated,owner) VALUES (?,?,?,?,?,?,?,?,?,?)`).run("job_dead_running", "qa", "analysis", "running", "x", 0.5, JSON.stringify({ renderId: a.renderId }), ts, ts, 999999);
  d.prepare(`INSERT INTO jobs (id,type,queue,status,stage,progress,input,created,updated,owner) VALUES (?,?,?,?,?,?,?,?,?,?)`).run("job_dead_queued", "qa", "analysis", "queued", "queued", 0, JSON.stringify({ renderId: a.renderId }), ts, ts, 999999);
  jobs.recoverJobs();
  const adopted = await svc.waitForJob("job_dead_queued");
  const [dead] = await svc.waitJobs(["job_dead_running"], 0);
  check("crashed process: its running job is marked interrupted", dead.status === "failed" && /interrupted/.test(dead.error?.message), JSON.stringify(dead));
  check("crashed process: its queued job is adopted and runs", adopted.status === "succeeded", adopted.status);
});

if (!QUICK) {
  await group("two server processes on one workspace", async () => {
    const tlFile = (n, a, b) => {
      const f = path.join(TMP, `${n}.json`);
      fs.writeFileSync(f, JSON.stringify(base(n, { clips: [{ id: "c1", assetId: A.talk, in: a, out: b }], captions: { preset: "boxed" } })));
      return f;
    };
    const runCli = (f) =>
      new Promise((res) => {
        const p = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", path.join(ROOT, "dist/cli.js"), "render", f, "draft"], { env: process.env });
        let out = "";
        p.stdout.on("data", (d) => (out += d));
        p.on("close", (code) => res({ code, out }));
      });
    const [x, y] = await Promise.all([runCli(tlFile("proc-a", 0, 4)), runCli(tlFile("proc-b", 4, 8))]);
    const ok = (r) => r.code === 0 && JSON.parse(r.out).status === "succeeded";
    check("both processes finish their own renders", ok(x) && ok(y), `${x.code} ${y.code} ${x.out.slice(0, 200)} ${y.out.slice(0, 200)}`);
    const rows = db.getDb().prepare(`SELECT status, COUNT(*) n FROM jobs WHERE type='render' GROUP BY status`).all();
    check("no job left running", !rows.some((r) => r.status === "running"), JSON.stringify(rows));
  });

  await group("MCP protocol (as Claude Desktop sees it)", async () => {
    const { Client } = await load("node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js");
    const { StdioClientTransport } = await load("node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js");
    // Claude Desktop starts servers with a minimal PATH: make sure binaries are still found.
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.toUpperCase() !== "PATH"));
    env.PATH = WIN ? `${process.env.SystemRoot ?? "C:\\Windows"}\\System32;${process.env.SystemRoot ?? "C:\\Windows"}` : "/usr/bin:/bin";
    // …and in "/" as their working folder.
    const t = new StdioClientTransport({ command: process.execPath, args: ["--disable-warning=ExperimentalWarning", path.join(ROOT, "dist/index.js")], env, cwd: "/" });
    const c = new Client({ name: "e2e", version: "1" });
    await c.connect(t);
    const tools = (await c.listTools()).tools.map((x) => x.name).sort();
    check("21 tools listed", tools.length === 21 && ["media_import_url", "discover_videos", "link_info"].every((n) => tools.includes(n)), tools.join(","));
    const call = async (name, args) => c.callTool({ name, arguments: args });
    const dv = await call("discover_videos", { platform: "twitch" });
    check("discover_videos: bad input → clean error", dv.isError && /INVALID_INPUT/.test(dv.content[0].text));
    const doc = await call("system_doctor", {});
    check("system_doctor ok with minimal PATH", !doc.isError && JSON.parse(doc.content[0].text).ok === true, doc.content[0].text.slice(0, 400));
    const po = JSON.parse((await call("project_open", { name: "E2E project" })).content[0].text);
    check("project_open lists assets", po.assets.length >= 8);
    for (const kind of ["components", "captionPresets", "brandKits", "music", "fonts"]) {
      const r = await call("catalog_list", { kind });
      check(`catalog_list ${kind}`, !r.isError);
    }
    const insp = await call("media_inspect", { assetId: A.talk });
    check("media_inspect returns an image", insp.content.some((x) => x.type === "image"));
    const bad = await call("timeline_validate", { timeline: base("bad", { clips: [{ id: "c1", assetId: A.talk, in: 4, out: 2 }] }) });
    check("bad timeline → isError with JSON path", bad.isError && /clips\[0\]\.out/.test(bad.content[0].text));
    const rsr = await call("render_start", { quality: "draft", wait: 45, timeline: base("mcp", { clips: [{ id: "c1", assetId: A.talk, in: 0, out: 4 }], captions: { preset: "word-pop" }, overlays: [{ id: "e", component: "Emoji", start: { at: 1 }, duration: 1, props: { emoji: "🔥", animation: "pop", x: 0.8, y: 0.3, size: 0.2 } }] }) });
    const rs = JSON.parse(rsr.content[0].text);
    let st = rsr.isError || !rs.job ? { status: "failed", error: rs } : rs.job;
    while (st.status !== "succeeded" && st.status !== "failed") st = JSON.parse((await call("job_status", { jobIds: [rs.jobId], wait: 30 })).content[0].text)[0];
    check("render through MCP succeeds", st.status === "succeeded", JSON.stringify(st).slice(0, 300));
    const qa = await call("qa_check", { renderId: rs.renderId, wait: 45 });
    check("qa_check returns images", qa.content.filter((x) => x.type === "image").length >= 2);
    const fr = await call("frames_get", { renderId: rs.renderId, times: [0.5, 2] });
    check("frames_get returns 2 images", fr.content.filter((x) => x.type === "image").length === 2);
    const tg = await call("transcript_get", { assetId: A.talk, page: 1 });
    check("transcript_get", /s0001/.test(tg.content[0].text));
    const jc = await call("job_cancel", { jobId: rs.jobId });
    check("job_cancel on a finished job is harmless", !jc.isError && /succeeded/.test(jc.content[0].text));
    const nf = await call("media_inspect", { assetId: "ast_nope" });
    check("unknown id → clean error", nf.isError && /NOT_FOUND/.test(nf.content[0].text));
    await c.close();
  });
}

// ------------------------------------------------------------------ report
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed${failed.length ? `, ${failed.length} failed:` : "."}`);
for (const f of failed) console.log(`  ✗ [${f.group}] ${f.name}: ${f.detail}`);
console.log(`\nTest files are in: ${TMP}`);
fs.writeFileSync(path.join(TMP, "results.json"), JSON.stringify(results, null, 1));
setTimeout(() => process.exit(failed.length ? 1 : 0), 100);
