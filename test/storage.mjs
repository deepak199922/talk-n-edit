#!/usr/bin/env node
/**
 * Tests for the shared graphics cache bookkeeping and the storage tools (v0.5.4):
 *   features.graphicsCache / graphicsCacheWarnGB, storage_report, storage_clean.
 *
 *   npm run test:storage
 *
 * Runs in a throw-away workspace with fake renders and fake cache entries; drawing real graphics is covered by
 * the render comparison on a real machine. Nothing outside the temp folder is touched.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const load = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "tne storage "));
process.env.TALK_N_EDIT_HOME = path.join(TMP, "work space");
fs.mkdirSync(process.env.TALK_N_EDIT_HOME, { recursive: true });
fs.writeFileSync(path.join(process.env.TALK_N_EDIT_HOME, "config.json"), JSON.stringify({ importRoots: [TMP], exportDir: path.join(TMP, "clips") }, null, 2));

const config = await load("dist/config.js");
const store = await load("dist/store.js");
const gc = await load("dist/gcache.js");
const st = await load("dist/storage.js");
const { now } = await load("dist/db.js");

let fails = 0;
let passes = 0;
function check(name, ok, detail = "") {
  if (ok) passes++;
  else fails++;
  console.log(`${ok ? "  ✓" : "  ✗"} ${name}${!ok && detail ? `  — ${String(detail).slice(0, 300)}` : ""}`);
}
const MB = 1024 * 1024;
const blob = (f, mb) => {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, Buffer.alloc(Math.round(mb * MB), 1));
};
// config.json is read once per process (like the server), so switches are flipped on the live config.
const setFeatures = (f) => Object.assign(config.getConfig().features, f);

// ------------------------------------------------------------------ defaults
console.log("\n▸ defaults (old config.json without the new switches)");
{
  const f = config.getConfig().features;
  check("graphicsCache defaults to on", f.graphicsCache === true, JSON.stringify(f));
  check("graphicsCacheWarnGB defaults to 20", f.graphicsCacheWarnGB === 20, JSON.stringify(f));
  check("older switches keep their defaults", f.shapedCaptions === true && f.linkInfoCacheMinutes === 60 && f.localSectionCut === true && f.crossProcessCancel === true);
}

// ------------------------------------------------------------------ fake cache entries
const cdir = gc.graphicsCacheDir();
function entry(key, { mb = 1, frames = 3, lastUsedAgoMs = 0, usedBy = [], drop } = {}) {
  const d = path.join(cdir, key);
  for (let i = 0; i < frames; i++) if (drop !== i) blob(path.join(d, `element-${String(i).padStart(4, "0")}.png`), mb / frames);
  const t = new Date(Date.now() - lastUsedAgoMs).toISOString();
  fs.writeFileSync(path.join(d, "meta.json"), JSON.stringify({ key, component: "fx:test", pattern: "element-%04d.png", frames, bytes: Math.round(mb * MB), created: t, lastUsed: t, usedBy }));
  return d;
}
const DAY = 86400e3;
entry("a1", { mb: 4, lastUsedAgoMs: 40 * DAY, usedBy: [{ project: "alpha", timeline: "reel-1" }] });
entry("a2", { mb: 2, lastUsedAgoMs: 10 * DAY, usedBy: [{ project: "alpha", timeline: "reel-2" }] });
entry("shared", { mb: 1, lastUsedAgoMs: 10 * DAY, usedBy: [{ project: "alpha", timeline: "reel-1" }, { project: "beta", timeline: "promo" }] });
entry("fresh", { mb: 3, lastUsedAgoMs: 60 * 1000, usedBy: [{ project: "alpha", timeline: "reel-1" }] });
entry("broken", { mb: 1, frames: 3, drop: 2, lastUsedAgoMs: 9 * DAY, usedBy: [{ project: "beta", timeline: "promo" }] });
fs.mkdirSync(path.join(cdir, "zz.part-123-1"), { recursive: true });
blob(path.join(cdir, "zz.part-123-1", "element-0000.png"), 0.5);
fs.utimesSync(path.join(cdir, "zz.part-123-1"), new Date(Date.now() - 2 * DAY), new Date(Date.now() - 2 * DAY));

console.log("\n▸ cache listing and warning");
{
  const l = gc.listCache();
  check("lists every entry incl. unfinished", l.length === 6, l.map((e) => e.key).join(","));
  check("newest use first", l[0].key === "fresh");
  check("recently used entry is marked in use", l.find((e) => e.key === "fresh").inUse === true);
  check("old entry is not in use", l.find((e) => e.key === "a1").inUse === false);
  check("unfinished folder is labelled", l.find((e) => e.key.includes(".part-")).component === "(unfinished)");
  check("no warning under the limit", gc.cacheWarning() === undefined);
  setFeatures({ graphicsCacheWarnGB: 0.005 });
  const w = gc.cacheWarning();
  check("warns past the limit, says nothing is removed automatically", !!w && /Nothing is removed automatically/.test(w), w);
  setFeatures({ graphicsCacheWarnGB: 0 });
  check("warning 0 = never", gc.cacheWarning() === undefined);
  setFeatures({ graphicsCacheWarnGB: 0.005, graphicsCache: false });
  check("no warning when the cache is switched off", gc.cacheWarning() === undefined);
  setFeatures({ graphicsCacheWarnGB: 20, graphicsCache: true });
}

// ------------------------------------------------------------------ fake projects and renders
const alpha = store.createProject("alpha");
const beta = store.createProject("beta");
const tl1 = store.saveTimeline(alpha.id, "reel-1", { name: "reel-1" });
const tl2 = store.saveTimeline(alpha.id, "reel-2", { name: "reel-2" });
const tlb = store.saveTimeline(beta.id, "promo", { name: "promo" });
function render(prj, tl, id, status, { graphics = 2, pre = true, batches = 0 } = {}) {
  const dir = config.dirs.render(prj.id, id);
  for (let i = 0; i < graphics; i++) blob(path.join(dir, `graphic-g${i}`, "element-0000.png"), 1);
  if (pre) blob(path.join(dir, "pre.mkv"), 0.5);
  for (let i = 0; i < batches; i++) blob(path.join(dir, `batch-0${i}.mkv`), 0.25);
  blob(path.join(dir, "output.mp4"), 0.3);
  blob(path.join(dir, "qa.json"), 0.001);
  store.insertRender({ id, project_id: prj.id, timeline_id: tl.id, version: 1, quality: "final", status, dir, created: now(), data: {} });
  return dir;
}
const r1 = render(alpha, tl1, "rnd_a1", "succeeded", { batches: 2 });
const r2 = render(alpha, tl2, "rnd_a2", "failed");
const r3 = render(beta, tlb, "rnd_b1", "succeeded");
const rRun = render(alpha, tl1, "rnd_run", "running");
// A render row pointing outside the workspace must never be touched.
const outside = path.join(TMP, "not-the-workspace");
blob(path.join(outside, "graphic-x", "element-0000.png"), 0.2);
blob(path.join(outside, "pre.mkv"), 0.2);
store.insertRender({ id: "rnd_evil", project_id: beta.id, timeline_id: tlb.id, version: 1, quality: "final", status: "succeeded", dir: outside, created: now(), data: {} });

console.log("\n▸ storage_report (read-only)");
{
  const before = fs.readdirSync(cdir).length;
  const rep = st.storageReport();
  check("cache total and entry count", rep.graphicsCache.entries === 6, JSON.stringify(rep.graphicsCache).slice(0, 200));
  check("grouped by project and Reel", rep.graphicsCache.byReel.some((g) => g.project === "alpha" && g.timeline === "reel-1" && g.graphics === 3), JSON.stringify(rep.graphicsCache.byReel));
  check("shared graphic listed under both Reels", rep.graphicsCache.byReel.some((g) => g.project === "beta" && g.timeline === "promo"));
  check("old render files by project (running render skipped)", rep.oldRenderFiles.byProject.find((p) => p.project === "alpha")?.renders === 2, JSON.stringify(rep.oldRenderFiles));
  check("render outside the workspace is not listed", rep.oldRenderFiles.byProject.find((p) => p.project === "beta")?.renders === 1, JSON.stringify(rep.oldRenderFiles));
  check("report removes nothing", fs.readdirSync(cdir).length === before && fs.existsSync(path.join(r1, "pre.mkv")));
}

console.log("\n▸ storage_clean renderFiles");
{
  const dry = st.storageClean({ what: "renderFiles", project: "alpha" });
  check("dry run by default", dry.applied === false && /apply: true/.test(dry.next) && fs.existsSync(path.join(r1, "graphic-g0")), JSON.stringify(dry));
  check("dry run counts finished and failed renders, not running", dry.renders === 2, JSON.stringify(dry));
  const one = st.storageClean({ what: "renderFiles", project: "alpha", timeline: "reel-2", apply: true });
  check("timeline filter removes only that Reel", one.renders === 1 && !fs.existsSync(path.join(r2, "graphic-g0")) && fs.existsSync(path.join(r1, "graphic-g0")), JSON.stringify(one));
  const all = st.storageClean({ what: "renderFiles", project: "alpha", apply: true });
  check("project clean removes frames, batches and pre.mkv", !fs.existsSync(path.join(r1, "graphic-g0")) && !fs.existsSync(path.join(r1, "pre.mkv")) && !fs.existsSync(path.join(r1, "batch-00.mkv")), JSON.stringify(all));
  check("finished video and QA are kept", fs.existsSync(path.join(r1, "output.mp4")) && fs.existsSync(path.join(r1, "qa.json")));
  check("running render untouched", fs.existsSync(path.join(rRun, "graphic-g0")) && fs.existsSync(path.join(rRun, "pre.mkv")));
  check("other project untouched", fs.existsSync(path.join(r3, "graphic-g0")));
  st.storageClean({ what: "renderFiles", apply: true });
  check("folder outside the workspace never touched", fs.existsSync(path.join(outside, "graphic-x")) && fs.existsSync(path.join(outside, "pre.mkv")));
  let threw = "";
  try {
    st.storageClean({ what: "renderFiles", project: "nope" });
  } catch (e) {
    threw = e.code;
  }
  check("unknown project → clear error", threw === "NOT_FOUND");
  threw = "";
  try {
    st.storageClean({ what: "renderFiles", timeline: "reel-1" });
  } catch (e) {
    threw = e.code;
  }
  check("timeline without project → clear error", threw === "INVALID_INPUT");
}

console.log("\n▸ storage_clean graphicsCache");
{
  const dry = st.storageClean({ what: "graphicsCache", notUsedForDays: 30 });
  check("age filter picks only the 40-day-old entry", dry.graphics === 1 && dry.applied === false && fs.existsSync(path.join(cdir, "a1")), JSON.stringify(dry));
  const b = st.storageClean({ what: "graphicsCache", project: "beta", apply: true });
  check("project filter (shared + broken from beta)", b.graphics === 2 && !fs.existsSync(path.join(cdir, "shared")) && !fs.existsSync(path.join(cdir, "broken")) && fs.existsSync(path.join(cdir, "a2")), JSON.stringify(b));
  const a = st.storageClean({ what: "graphicsCache", apply: true });
  check("clean all skips graphics used in the last hours", fs.existsSync(path.join(cdir, "fresh")) && !fs.existsSync(path.join(cdir, "a1")) && a.skippedInUse === 1, JSON.stringify(a));
  check("old unfinished folder removed with the rest", !fs.readdirSync(cdir).some((n) => n.includes(".part-")));
}

console.log(`\n${passes} passed, ${fails} failed`);
fs.rmSync(TMP, { recursive: true, force: true });
process.exit(fails ? 1 : 0);
