#!/usr/bin/env node
/**
 * Tests for the switchable features in config.json "features" (v0.5.3):
 *   shapedCaptions, linkInfoCacheMinutes, localSectionCut, crossProcessCancel
 * plus job_cancel's explanations, the unknown-job-type guard and the new error hints.
 *
 *   npm run test:features
 *
 * Each feature is tested ON and OFF (OFF must behave exactly like before), and every fallback path is forced.
 * Runs in a throw-away workspace; nothing outside it is touched. Needs ffmpeg and the Python env (yt-dlp); no
 * speech model.
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const load = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "tne features "));
const FIX = path.join(TMP, "fixtures");
fs.mkdirSync(FIX, { recursive: true });
process.env.TALK_N_EDIT_HOME = path.join(TMP, "work space");
fs.mkdirSync(process.env.TALK_N_EDIT_HOME, { recursive: true });
// An existing user config from before v0.5.3: no "features" key at all.
fs.writeFileSync(
  path.join(process.env.TALK_N_EDIT_HOME, "config.json"),
  JSON.stringify({ importRoots: [FIX], exportDir: path.join(TMP, "clips"), inboxDir: path.join(TMP, "inbox (downloads)") }, null, 2),
);
process.env.NO_PROXY = process.env.no_proxy = [process.env.NO_PROXY, "127.0.0.1", "localhost"].filter(Boolean).join(",");

const svc = await load("dist/service.js");
const config = await load("dist/config.js");
const db = await load("dist/db.js");
const jobs = await load("dist/jobs.js");
const ff = await load("dist/ffmpeg.js");
const web = await load("dist/web.js");
const resolve = await load("dist/resolve.js");
const remotion = await load("dist/remotion.js");
svc.boot();
const FF = config.ffmpegBin();
const FP = config.ffprobeBin();
const F = () => config.getConfig().features;

// ------------------------------------------------------------------ harness
const results = [];
let current = "";
function check(name, ok, detail = "") {
  results.push({ group: current, name, ok: !!ok, detail: String(detail).slice(0, 400) });
  process.stdout.write(`${ok ? "  ✓" : "  ✗"} ${name}${detail && !ok ? `  — ${String(detail).slice(0, 400)}` : ""}\n`);
}
async function group(name, fn) {
  current = name;
  console.log(`\n▸ ${name}`);
  const saved = { ...F() };
  try {
    await fn();
  } catch (e) {
    check("unexpected error", false, e?.stack ?? JSON.stringify(e));
  } finally {
    Object.assign(F(), saved); // every group starts from the defaults
  }
}
const sh = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 64 << 20 });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")}\n${r.stderr}`);
  return r.stdout;
};
const ffx = (args) => sh(FF, ["-hide_banner", "-loglevel", "error", "-y", ...args]);
const duration = (f) => Number(sh(FP, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f]).trim());
/** A small grey thumbnail of one frame, for comparing pictures. */
function frame(file, t, w = 160, h = 90, extra = "") {
  const seek = t > 0 ? ["-ss", String(t)] : [];
  const r = spawnSync(FF, ["-hide_banner", "-loglevel", "error", ...seek, "-i", file, "-frames:v", "1", "-vf", `${extra}scale=${w}:${h},format=gray`, "-f", "rawvideo", "-"], { maxBuffer: 16 << 20 });
  if (r.status !== 0) throw new Error(String(r.stderr));
  // Guard against comparisons passing on empty pictures.
  if (r.stdout.length !== w * h) throw new Error(`frame(${file}, ${t}) gave ${r.stdout.length} bytes, expected ${w * h}`);
  return r.stdout;
}
const diff = (a, b) => {
  let s = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) s += Math.abs(a[i] - b[i]);
  return s / Math.max(1, Math.min(a.length, b.length));
};
const runJob = async (job) => {
  await svc.waitForJob(job.id);
  return jobs.getJob(job.id);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ fixtures
console.log(`Workspace: ${TMP}`);
// 30 s clip with a running timestamp (testsrc2) and a tone: easy to tell frames apart.
ffx(["-f", "lavfi", "-i", "testsrc2=s=640x360:r=25:d=30", "-f", "lavfi", "-i", "sine=f=440:d=30", "-c:v", "libx264", "-preset", "ultrafast", "-g", "250", "-c:a", "aac", "-shortest", path.join(FIX, "link.mp4")]);
// 12 s portrait clip for captions.
ffx(["-f", "lavfi", "-i", "color=c=0x335577:s=720x1280:r=30:d=12", "-f", "lavfi", "-i", "sine=f=300:d=12", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-shortest", path.join(FIX, "cap.mp4")]);
// 10 min clip so a face scan runs long enough to be cancelled from another process.
ffx(["-f", "lavfi", "-i", "testsrc2=s=960x540:r=25:d=600", "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-shortest", path.join(FIX, "long.mp4")]);

// ------------------------------------------------------------------ config
await group("config: features switches", async () => {
  const f = F();
  check("an old config.json without features gets every default", f.shapedCaptions === true && f.linkInfoCacheMinutes === 60 && f.localSectionCut === true && f.crossProcessCancel === true, JSON.stringify(f));
  const saved = JSON.parse(fs.readFileSync(config.configPath(), "utf8"));
  check("the user's config.json is not rewritten", !("features" in saved), JSON.stringify(saved));
  // A partial and a broken "features" value, read by a fresh process.
  const probe = (cfgObj) => {
    const home = fs.mkdtempSync(path.join(TMP, "cfg "));
    fs.writeFileSync(path.join(home, "config.json"), JSON.stringify(cfgObj));
    const code = `import(${JSON.stringify(pathToFileURL(path.join(ROOT, "dist/config.js")).href)}).then(m=>console.log(JSON.stringify(m.getConfig().features)))`;
    return JSON.parse(sh(process.execPath, ["--disable-warning=ExperimentalWarning", "--input-type=module", "-e", code]).trim() || "{}");
  };
  const env0 = process.env.TALK_N_EDIT_HOME;
  try {
    const homeA = fs.mkdtempSync(path.join(TMP, "cfgA "));
    fs.writeFileSync(path.join(homeA, "config.json"), JSON.stringify({ features: { shapedCaptions: false } }));
    process.env.TALK_N_EDIT_HOME = homeA;
    const code = `import(${JSON.stringify(pathToFileURL(path.join(ROOT, "dist/config.js")).href)}).then(m=>console.log(JSON.stringify(m.getConfig().features)))`;
    const a = JSON.parse(sh(process.execPath, ["--disable-warning=ExperimentalWarning", "--input-type=module", "-e", code]).trim());
    check("one switch turned off keeps the other defaults", a.shapedCaptions === false && a.localSectionCut === true && a.linkInfoCacheMinutes === 60, JSON.stringify(a));
    const homeB = fs.mkdtempSync(path.join(TMP, "cfgB "));
    fs.writeFileSync(path.join(homeB, "config.json"), JSON.stringify({ features: "yes please" }));
    process.env.TALK_N_EDIT_HOME = homeB;
    const b = JSON.parse(sh(process.execPath, ["--disable-warning=ExperimentalWarning", "--input-type=module", "-e", code]).trim());
    check("a malformed features value falls back to defaults", b.shapedCaptions === true && b.crossProcessCancel === true, JSON.stringify(b));
  } finally {
    process.env.TALK_N_EDIT_HOME = env0;
  }
  void probe;
  const doc = await svc.doctor();
  check("system_doctor reports caption shaping (informational)", typeof doc.captionShaping === "string" && /complex|simple|off/.test(doc.captionShaping), doc.captionShaping);
  check("system_doctor still ok", doc.ok === true, JSON.stringify(doc.issues));
});

// ------------------------------------------------------------------ captions
await group("shapedCaptions: Gurmukhi and Devanagari captions", async () => {
  const supported = ff.assShapingSupported();
  check("this ffmpeg's ass filter supports shaping", supported);
  F().shapedCaptions = true;
  check("switch on → ass filter with complex shaping", ff.captionFilter("captions.ass") === "ass=filename=captions.ass:fontsdir=fonts:shaping=complex", ff.captionFilter("captions.ass"));
  F().shapedCaptions = false;
  check("switch off → the old subtitles filter, unchanged", ff.captionFilter("captions.ass") === "subtitles=filename=captions.ass:fontsdir=fonts", ff.captionFilter("captions.ass"));
  check("an ffmpeg that can't be run counts as unsupported (fallback)", ff.assShapingSupported(path.join(TMP, "no-such-ffmpeg")) === false);

  // Full pipeline render, switch on and off, same timeline.
  const P = svc.projectOpen("Captions project");
  const imp = await runJob(svc.mediaImport(P.projectId, [path.join(FIX, "cap.mp4")]));
  const asset = imp.result.assets[0].assetId;
  const tl = (name) => ({
    projectId: P.projectId,
    name,
    output: { aspect: "9:16" },
    clips: [{ id: "c1", assetId: asset, in: 0, out: 10 }],
    captions: {
      source: "lines",
      preset: "boxed",
      lines: [
        { start: { clip: "c1", sourceTime: 0.2 }, end: { clip: "c1", sourceTime: 4.8 }, text: "ਸਿੱਖਿਆ ਵਿੱਚ ਕਿਤਾਬ" },
        { start: { clip: "c1", sourceTime: 5.2 }, end: { clip: "c1", sourceTime: 9.8 }, text: "हिंदी में किताब" },
      ],
    },
  });
  const assOf = (renderId) => fs.readFileSync(path.join(db.getDb().prepare(`SELECT dir FROM renders WHERE id=?`).get(renderId).dir, "captions.ass"), "utf8");
  let lastAss = "";
  const render = async (name, timeline = tl(name)) => {
    const r = svc.renderStart({ timeline, quality: "draft" });
    const j = await runJob({ id: r.jobId });
    if (j.status !== "succeeded") throw new Error(JSON.stringify(j.error));
    lastAss = assOf(r.renderId);
    return svc.framesGet({ renderId: r.renderId, times: [2, 7], width: 720 });
  };
  F().shapedCaptions = true;
  const on = await render("shaped");
  const assOn = lastAss;
  F().shapedCaptions = false;
  const off = await render("unshaped");
  const assOff = lastAss;
  const dlg = (a) => a.split("\n").filter((l) => l.startsWith("Dialogue:"));
  check("switch on → Indic caption lines get letter spacing 0 (\\fsp0)", dlg(assOn).length > 0 && dlg(assOn).every((l) => l.includes("\\fsp0")), dlg(assOn).slice(0, 2).join(" | "));
  check("switch off → captions file has no \\fsp0 (as before)", !assOff.includes("\\fsp0"));
  // English captions: the captions file must be byte-for-byte the same with the switch on or off.
  const latin = (name) => ({ ...tl(name), captions: { ...tl(name).captions, lines: [{ start: { clip: "c1", sourceTime: 0.2 }, end: { clip: "c1", sourceTime: 4.8 }, text: "Most developers get this wrong" }] } });
  F().shapedCaptions = true;
  const latOn = await render("latin-on", latin("latin-on"));
  const latAssOn = lastAss;
  F().shapedCaptions = false;
  const latOff = await render("latin-off", latin("latin-off"));
  const latAssOff = lastAss;
  check("English captions file identical with the switch on or off", latAssOn === latAssOff);
  const dL = diff(frame(latOn[0].path, 0, 360, 640), frame(latOff[0].path, 0, 360, 640));
  check("English caption picture (almost) identical with the switch on or off", dL < 0.5, `mean diff ${dL.toFixed(3)}`);
  for (const [k, v] of [["latin-on", latOn], ["latin-off", latOff]]) fs.copyFileSync(v[0].path, path.join(TMP, `caption-${k}.jpg`));
  check("both renders succeed (switch on and off)", on.length === 2 && off.length === 2);
  const g = (p) => frame(p, 0, 360, 640);
  const dG = diff(g(on[0].path), g(off[0].path));
  const dH = diff(g(on[1].path), g(off[1].path));
  check("Gurmukhi caption is drawn differently with shaping (vowel signs reordered)", dG > 0.05, `mean diff ${dG.toFixed(3)}`);
  check("Devanagari caption is drawn differently with shaping", dH > 0.05, `mean diff ${dH.toFixed(3)}`);
  // Keep the frames for a human look.
  for (const [k, v] of [["on", on], ["off", off]]) v.forEach((f, i) => fs.copyFileSync(f.path, path.join(TMP, `caption-${k}-${i}.jpg`)));
  console.log(`    (frames to look at: ${path.join(TMP, "caption-*.jpg")})`);
});

// ------------------------------------------------------------------ links
const srvHits = { count: 0 };
const srv = http.createServer((req, res) => {
  srvHits.count++;
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
const cacheDir = () => path.join(process.env.TALK_N_EDIT_HOME, "cache", "linkinfo");
const cacheFiles = () => (fs.existsSync(cacheDir()) ? fs.readdirSync(cacheDir()).filter((f) => f.endsWith(".json")) : []);

await group("linkInfoCacheMinutes: link details read once", async () => {
  const url = `${BASE}/link.mp4`;
  const before = cacheFiles().length;
  const li = await svc.linkInfoGet(url);
  check("link_info works", li.source?.id === "link", JSON.stringify(li.source).slice(0, 200));
  check("link_info saves the details", cacheFiles().length === before + 1);
  const cached = web.readCachedInfo(url);
  const m0 = fs.statSync(cached.file).mtimeMs;
  const P = svc.projectOpen("Links A");
  const r = await runJob(svc.mediaImportUrl(P.projectId, url, {}));
  check("download with saved details succeeds", r.status === "succeeded", JSON.stringify(r.error));
  check("saved details were reused (not read again)", fs.statSync(cached.file).mtimeMs === m0 && !r.result.notes);
  const d = duration(r.result.downloaded);
  check("downloaded file is complete", Math.abs(d - 30) < 0.2, d);

  // Stale details: a format URL that now 404s. Must fall back to reading the link again.
  const bad = JSON.parse(fs.readFileSync(cached.file, "utf8"));
  const point = (o) => { if (o && typeof o === "object") for (const k of Object.keys(o)) { if (k === "url" && typeof o[k] === "string" && o[k].includes("/link.mp4")) o[k] = o[k].replace("/link.mp4", "/expired.mp4"); else point(o[k]); } };
  point(bad.formats ?? []);
  if (typeof bad.url === "string") bad.url = bad.url.replace("/link.mp4", "/expired.mp4");
  fs.writeFileSync(cached.file, JSON.stringify(bad));
  // Move the finished download aside so yt-dlp has to fetch again (otherwise it reuses the file).
  fs.renameSync(r.result.downloaded, r.result.downloaded + ".aside");
  const P2 = svc.projectOpen("Links B");
  // Different output name so the earlier finished file isn't simply reused.
  const r2 = await runJob(svc.mediaImportUrl(P2.projectId, url, { maxHeight: 240 }));
  check("expired details → falls back and still succeeds", r2.status === "succeeded", JSON.stringify(r2.error));
  check("…and says so", (r2.result?.notes ?? []).some((n) => /expired/.test(n)), JSON.stringify(r2.result?.notes));

  // Garbage in the cache file is ignored.
  fs.writeFileSync(cached.file, "{not json");
  check("a corrupt saved file is ignored", web.readCachedInfo(url) === undefined);

  // Switch off: nothing saved, nothing read.
  F().linkInfoCacheMinutes = 0;
  const url2 = `${BASE}/cap.mp4`;
  const n = cacheFiles().length;
  await svc.linkInfoGet(url2);
  check("switch off → link_info saves nothing", cacheFiles().length === n);
  const r3 = await runJob(svc.mediaImportUrl(P.projectId, url2, {}));
  check("switch off → download works exactly as before", r3.status === "succeeded" && !r3.result.notes, JSON.stringify(r3.error ?? r3.result?.notes));

  // Expiry.
  F().linkInfoCacheMinutes = 60;
  await svc.linkInfoGet(url2);
  const c2 = web.readCachedInfo(url2);
  const old = new Date(Date.now() - 61 * 60_000);
  fs.utimesSync(c2.file, old, old);
  check("details older than the limit are not used", web.readCachedInfo(url2) === undefined);
  // Cookies are part of the key.
  check("details saved without cookies aren't used with cookies", web.readCachedInfo(url, "firefox") === undefined);
});

await group("localSectionCut: part of a video already in the project", async () => {
  const url = `${BASE}/link.mp4`;
  const P = svc.projectOpen("Section project");
  const full = await runJob(svc.mediaImportUrl(P.projectId, url, {}));
  check("full copy imported", full.status === "succeeded", JSON.stringify(full.error));
  const fullFile = full.result.downloaded;

  F().localSectionCut = true;
  const hits0 = srvHits.count;
  const cut = await runJob(svc.mediaImportUrl(P.projectId, url, { start: 10, end: 18 }));
  check("section from the full copy succeeds", cut.status === "succeeded", JSON.stringify(cut.error));
  check("…cut locally (result says so)", /Cut from/.test(cut.result?.cutFrom ?? ""), JSON.stringify(cut.result).slice(0, 300));
  check("…nothing downloaded from the site", srvHits.count === hits0, `${srvHits.count - hits0} requests`);
  const dc = duration(cut.result.downloaded);
  check("…exact length (8 s)", Math.abs(dc - 8) < 0.1, dc);
  // Same pictures as the original at the same source time (testsrc2 shows a running timestamp).
  const same = [1, 4, 7].map((t) => diff(frame(cut.result.downloaded, t), frame(fullFile, 10 + t)));
  const other = diff(frame(cut.result.downloaded, 1), frame(fullFile, 1));
  check("…frames match the original at start + t", same.every((x) => x < 4), same.map((x) => x.toFixed(2)).join(", "));
  check("…and not some other part", other > 4 * Math.max(...same), `${other.toFixed(2)} vs ${Math.max(...same).toFixed(2)}`);
  const a = svc.analysisGet(cut.result.assets[0].assetId, "source");
  check("…source info records the section", a.sectionStart === 10 && a.sectionEnd === 18, JSON.stringify(a).slice(0, 200));
  check("…audio kept", sh(FP, ["-v", "error", "-select_streams", "a", "-show_entries", "stream=codec_type", "-of", "csv=p=0", cut.result.downloaded]).includes("audio"));

  // Same request again: the finished file is reused (as yt-dlp does), no new asset.
  const again = await runJob(svc.mediaImportUrl(P.projectId, url, { start: 10, end: 18 }));
  check("same section again reuses the file (already imported)", again.status === "succeeded" && again.result.assets[0].alreadyImported === true, JSON.stringify(again.result?.assets));

  // Switch off → yt-dlp downloads the part, as before.
  F().localSectionCut = false;
  const hits1 = srvHits.count;
  const dl = await runJob(svc.mediaImportUrl(P.projectId, url, { start: 20, end: 26 }));
  check("switch off → section downloaded the old way", dl.status === "succeeded" && !dl.result.cutFrom && srvHits.count > hits1, JSON.stringify(dl.error ?? dl.result?.cutFrom));
  const dd = duration(dl.result.downloaded);
  check("…length right (6 s)", Math.abs(dd - 6) < 0.3, dd);
  const dlSame = diff(frame(dl.result.downloaded, 2), frame(fullFile, 22));
  check("…and local cut gives the same pictures as the download would", diff(frame(cut.result.downloaded, 2), frame(fullFile, 12)) <= dlSame + 2, `${dlSame.toFixed(2)}`);

  // No full copy in this project → normal download.
  F().localSectionCut = true;
  const P2 = svc.projectOpen("Section project 2");
  const hits2 = srvHits.count;
  const other2 = await runJob(svc.mediaImportUrl(P2.projectId, url, { start: 3, end: 7 }));
  check("no full copy in the project → downloads", other2.status === "succeeded" && !other2.result.cutFrom && srvHits.count > hits2, JSON.stringify(other2.error));

  // Full copy deleted from disk (simulated by moving it) → downloads instead, no error.
  const ast = db.getDb().prepare(`SELECT id, data FROM assets WHERE project_id=? ORDER BY created LIMIT 1`).get(P.projectId);
  const data = JSON.parse(ast.data);
  const moved = data.original + ".moved";
  fs.chmodSync(path.dirname(data.original), 0o755);
  fs.renameSync(data.original, moved);
  try {
    const hits3 = srvHits.count;
    const r = await runJob(svc.mediaImportUrl(P.projectId, url, { start: 12, end: 15 }));
    check("full copy missing on disk → downloads instead", r.status === "succeeded" && !r.result.cutFrom && srvHits.count > hits3, JSON.stringify(r.error));
  } finally {
    fs.renameSync(moved, data.original);
  }

  // Asking for more than the full copy has → downloads.
  const r4 = await runJob(svc.mediaImportUrl(P.projectId, url, { start: 25, end: 40 }));
  check("end past the video is clamped and still works", r4.status === "succeeded", JSON.stringify(r4.error));

  // Higher resolution wanted than the full copy has → download (not a blurrier local cut).
  const fakeInfo = { formats: [{ height: 1080 }, { height: 360 }] };
  const copy = web.findFullCopy(P.projectId, "Generic", full.result.source.id, 2, 5, 1080, fakeInfo);
  check("a lower-resolution full copy is not used when sharper is available", copy === undefined);
  const copy2 = web.findFullCopy(P.projectId, full.result.source.site, full.result.source.id, 2, 5, 360, { formats: [{ height: 360 }] });
  check("…but is used when it's as sharp as the download would be", copy2 !== undefined);
});

// ------------------------------------------------------------------ cancel
await group("job_cancel: explanations and cross-process cancel", async () => {
  const P = svc.projectOpen("Cancel project");
  const imp = await runJob(svc.mediaImport(P.projectId, [path.join(FIX, "link.mp4")]));
  const done = svc.cancelJobView(imp.id);
  check("cancelling a finished job says nothing was cancelled", done.cancelled === false && /already succeeded/.test(done.note), JSON.stringify(done));
  check("…and leaves its status and results alone", jobs.getJob(imp.id).status === "succeeded" && jobs.getJob(imp.id).result?.assets?.length === 1);
  check("old cancelJob still returns the job row", jobs.cancelJob(imp.id).id === imp.id);

  // Queued: block the analysis lane with a long job, queue another behind it, cancel the queued one.
  const longImp = await runJob(svc.mediaImport(P.projectId, [path.join(FIX, "long.mp4")]));
  const longId = longImp.result.assets[0].assetId;
  const blocker = svc.analyze({ assetId: longId, include: ["faces"], force: true });
  const queued = svc.analyze({ assetId: imp.result.assets[0].assetId, include: ["scenes"] });
  for (let i = 0; i < 100 && jobs.getJob(blocker.id).status !== "running"; i++) await sleep(100);
  const q = svc.cancelJobView(queued.id);
  check("cancelling a queued job", q.cancelled === true && q.status === "cancelled", JSON.stringify(q));
  const own = svc.cancelJobView(blocker.id);
  check("cancelling a running job in this process", own.cancelled === true && /Stopping/.test(own.note), JSON.stringify(own));
  const b = await runJob(blocker);
  check("…it stops", b.status === "cancelled", b.status);

  // Cross-process: another server process runs a long face scan; cancel it from here.
  const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", path.join(ROOT, "dist/cli.js"), "analyze", longId, "faces"], { env: process.env });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  const closed = new Promise((r) => child.on("close", (code) => r(code)));
  let jobId;
  for (let i = 0; i < 100 && !jobId; i++) {
    await sleep(300);
    const row = db.getDb().prepare(`SELECT id FROM jobs WHERE type='analyze' AND status='running' AND owner=?`).get(child.pid);
    jobId = row?.id;
  }
  check("other process is running a job", !!jobId);
  if (jobId) {
    const t0 = Date.now();
    const x = svc.cancelJobView(jobId);
    check("cancel from here explains another server runs it", x.cancelled === true && /Another Talk-n-Edit server/.test(x.note), JSON.stringify(x));
    let st;
    for (let i = 0; i < 60; i++) {
      await sleep(500);
      st = jobs.getJob(jobId).status;
      if (st !== "running") break;
    }
    check("…and the other process stops it within seconds", st === "cancelled", `${st} after ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  }
  child.kill();
  await closed;

  // Switch off: no cross-process request.
  F().crossProcessCancel = false;
  const child2 = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", path.join(ROOT, "dist/cli.js"), "analyze", longId, "faces"], { env: { ...process.env } });
  const closed2 = new Promise((r) => child2.on("close", (code) => r(code)));
  let id2;
  for (let i = 0; i < 100 && !id2; i++) {
    await sleep(300);
    id2 = db.getDb().prepare(`SELECT id FROM jobs WHERE type='analyze' AND status='running' AND owner=?`).get(child2.pid)?.id;
  }
  if (id2) {
    const y = svc.cancelJobView(id2);
    check("switch off → says it can't, changes nothing", y.cancelled === false && /switched off/.test(y.note) && jobs.getJob(id2).status === "running", JSON.stringify(y));
  } else check("second child started", false);
  child2.kill("SIGKILL");
  await closed2;
});

await group("jobs: a newer server's job kinds are left alone", async () => {
  const d = db.getDb();
  const ts = new Date().toISOString();
  d.prepare(`INSERT INTO jobs (id,type,queue,status,stage,progress,input,created,updated,owner) VALUES (?,?,?,?,?,?,?,?,?,?)`).run("job_future1", "transcribe_v2", "analysis", "queued", "queued", 0, "{}", ts, ts, process.pid);
  d.prepare(`INSERT INTO jobs (id,type,queue,status,stage,progress,input,created,updated,owner) VALUES (?,?,?,?,?,?,?,?,?,?)`).run("job_future2", "transcribe_v2", "asr", "queued", "queued", 0, "{}", ts, ts, 999999);
  const P = svc.projectOpen("Guard project");
  const j = await runJob(svc.mediaImport(P.projectId, [path.join(FIX, "cap.mp4")]));
  check("known jobs still run past an unknown queued one", j.status === "succeeded", j.status);
  check("unknown job kind is not started", jobs.getJob("job_future1").status === "queued");
  jobs.recoverJobs();
  await sleep(300);
  const r2 = d.prepare(`SELECT owner, status FROM jobs WHERE id='job_future2'`).get();
  check("unknown job kind from a stopped server is not adopted", r2.owner === 999999 && r2.status === "queued", JSON.stringify(r2));
  d.prepare(`DELETE FROM jobs WHERE id IN ('job_future1','job_future2')`).run();
});

// ------------------------------------------------------------------ hints
await group("clearer errors", async () => {
  const P = svc.projectOpen("Hints project");
  const imp = await runJob(svc.mediaImport(P.projectId, [path.join(FIX, "cap.mp4")]));
  const asset = imp.result.assets[0].assetId;
  let err;
  try {
    svc.timelineValidate({ projectId: P.projectId, name: "h", output: { aspect: "9:16" }, clips: [{ id: "c1", assetId: asset, in: 0, out: 3 }, { id: "c2", assetId: asset, in: 3, out: 6, transitionIn: { type: "crossfade", duration: 0 } }] }, false);
  } catch (e) {
    err = e;
  }
  check("transition duration 0 → error with a plain fix", err?.code === "INVALID_INPUT" && /0\.05–2 s/.test(err?.hint ?? ""), JSON.stringify(err));
  let err2;
  try {
    svc.timelineValidate({ projectId: P.projectId, name: "h", output: { aspect: "9:16" }, clips: [{ id: "c1", assetId: asset, in: 0, out: 3, speed: 99 }] }, false);
  } catch (e) {
    err2 = e;
  }
  check("other validation errors are unchanged (no made-up hint)", err2?.code === "INVALID_INPUT" && !/transition/i.test(err2?.hint ?? ""), JSON.stringify(err2));
  const h = remotion.fxHints(["Error: inputRange must be strictly monotonically increasing but got [102,102]"]);
  check("animation inputRange error gets a plain fix", h?.length === 1 && /at least 1 frame/.test(h[0]), JSON.stringify(h));
  check("unrelated animation errors get no hint", remotion.fxHints(["SyntaxError: Unexpected token"]) === undefined);
});

srv.close();
// ------------------------------------------------------------------ summary
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed${failed.length ? `, ${failed.length} failed:` : ""}`);
for (const f of failed) console.log(`  ✗ [${f.group}] ${f.name}: ${f.detail}`);
console.log(`\nTest files are in: ${TMP}`);
process.exit(failed.length ? 1 : 0);
