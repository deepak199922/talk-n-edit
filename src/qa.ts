import fs from "node:fs";
import path from "node:path";
import { captionLayoutNote } from "./ass.js";
import { ffmpeg, r3 } from "./ffmpeg.js";
import { probe } from "./ffprobe.js";
import type { JobContext } from "./jobs.js";
import { contactSheet, grabFrames } from "./media.js";
import type { Resolved } from "./resolve.js";
import { getRender } from "./store.js";

export interface QaCheck {
  check: string;
  status: "pass" | "warn" | "fail";
  detail: string;
  fix?: string;
}

export interface QaReport {
  summary: { pass: number; warn: number; fail: number; verdict: "ok" | "review" | "fix" };
  checks: QaCheck[];
  loudness?: { integrated: number; truePeak: number };
}

export async function quickQa(file: string, res: Resolved, signal?: AbortSignal): Promise<QaReport> {
  const checks: QaCheck[] = [];
  const pr = await probe(file);
  const fmtOk = pr.width === res.width && pr.height === res.height && pr.hasAudio && pr.videoCodec === "h264";
  checks.push({
    check: "format",
    status: fmtOk ? "pass" : "fail",
    detail: `${pr.width}x${pr.height} ${pr.videoCodec}/${pr.audioCodec} ${pr.avgFps}fps`,
    fix: fmtOk ? undefined : "Re-render; the encoder output does not match the timeline output settings.",
  });
  const dd = Math.abs(pr.duration - res.duration);
  checks.push({
    check: "duration",
    status: dd <= 0.12 ? "pass" : "warn",
    detail: `output ${r3(pr.duration)}s vs timeline ${res.duration}s`,
  });

  const an = await ffmpeg(
    ["-i", file, "-vf", "blackdetect=d=0.5:pix_th=0.10", "-af", "silencedetect=n=-50dB:d=1.5,ebur128=peak=true:framelog=quiet", "-f", "null", "-"],
    { signal, label: "ffmpeg qa" },
  );
  const err = an.stderr;
  // Planned dark moments: transitions (fade-black etc.) and title cards.
  const fades = [
    ...res.transitions.map((tr) => [tr.t - 0.3, tr.t + tr.dur + 0.3]),
    ...res.overlays.filter((o) => o.component === "TitleCard").map((o) => [o.start - 0.2, o.end + 0.2]),
  ];
  const blacks = [...err.matchAll(/black_start:([\d.]+) black_end:([\d.]+)/g)]
    .map((m) => [Number(m[1]), Number(m[2])])
    .filter(([a, b]) => !fades.some(([x, y]) => a >= x - 0.2 && b <= y + 0.2));
  checks.push({
    check: "black frames",
    status: blacks.length ? "warn" : "pass",
    detail: blacks.length ? `unplanned black at ${blacks.map(([a, b]) => `${r3(a)}–${r3(b)}s`).join(", ")}` : "none",
    fix: blacks.length ? "Check those times with frames_get; trim the clip or change its in/out." : undefined,
  });
  const silences = [...err.matchAll(/silence_end: ([\d.]+) \| silence_duration: ([\d.]+)/g)].map((m) => [Number(m[1]) - Number(m[2]), Number(m[2])]);
  const I = Number(/I:\s+(-?[\d.]+) LUFS/.exec(err.slice(err.lastIndexOf("Summary")))?.[1] ?? NaN);
  const TP = Number(/Peak:\s+(-?[\d.]+) dBFS/.exec(err.slice(err.lastIndexOf("True peak")))?.[1] ?? NaN);
  const silentVideo = !isFinite(I) || I <= -60;
  if (silentVideo) {
    checks.push({
      check: "audio",
      status: "warn",
      detail: "the video has no sound (source has no audio, or it was muted)",
      fix: "Fine for a silent edit; otherwise add an audio item with role \"music\".",
    });
  } else {
    checks.push({
      check: "dead air",
      status: silences.length ? "warn" : "pass",
      detail: silences.length ? `silence of ${silences.map(([s, d]) => `${r3(d)}s at ${r3(s)}s`).join(", ")}` : "no silence over 1.5 s",
      fix: silences.length ? "Add removeSilences to the clip, or music under it." : undefined,
    });
    const loudOk = Math.abs(I - res.mix.targetLufs) <= 1.5;
    const tpOk = !isFinite(TP) || TP <= -0.5;
    checks.push({
      check: "loudness",
      status: loudOk && tpOk ? "pass" : "warn",
      detail: `integrated ${I} LUFS (target ${res.mix.targetLufs}), true peak ${isFinite(TP) ? TP : "?"} dBTP`,
      fix: loudOk ? undefined : "Draft renders use one-pass normalisation; final renders are more accurate.",
    });
  }
  const firstWord = res.captions?.words[0]?.s ?? Infinity;
  const firstOverlay = Math.min(...res.overlays.map((o) => o.start), Infinity);
  const hookOk = Math.min(firstWord, firstOverlay) <= 0.6;
  checks.push({
    check: "hook in first 0.6 s",
    status: hookOk ? "pass" : res.platform === "youtube" ? "pass" : "warn",
    detail: hookOk ? "speech or text starts immediately" : `first caption at ${isFinite(firstWord) ? r3(firstWord) : "none"}s, no overlay at start`,
    fix: hookOk ? undefined : "Trim the clip start to the first word, or add a HookText overlay at {at: 0}.",
  });
  if (res.captions) checks.push({ check: "caption safe area", status: "pass", detail: captionLayoutNote(res) });

  const count = (s: QaCheck["status"]) => checks.filter((c) => c.status === s).length;
  const summary = { pass: count("pass"), warn: count("warn"), fail: count("fail"), verdict: (count("fail") ? "fix" : count("warn") ? "review" : "ok") as "ok" | "review" | "fix" };
  return { summary, checks, loudness: { integrated: I, truePeak: TP } };
}

export async function qaJob(input: { renderId: string }, ctx: JobContext) {
  const r = getRender(input.renderId);
  if (r.status !== "succeeded" || !r.data.output) throw new Error(`Render ${r.id} is ${r.status}`);
  const res: Resolved = JSON.parse(fs.readFileSync(path.join(r.dir, "resolved.json"), "utf8"));
  ctx.progress("analysing output", 0.1);
  const report = await quickQa(r.data.output, res, ctx.signal);
  ctx.progress("contact sheet", 0.6);
  const sheet = await contactSheet(r.data.output, res.duration, path.join(r.dir, "contact.jpg"), ctx.signal);
  // Frames just after cuts (first 6) so framing changes can be checked.
  const cuts = res.segments.slice(1, 7).map((s) => s.tlStart + (s.transIn ? s.transIn.dur : 0) + 0.1);
  const times = [0.3, ...cuts];
  ctx.progress("frames after cuts", 0.8);
  const frames = await grabFrames(r.data.output, times, path.join(r.dir, "qa-frames"), 360, ctx.signal);
  const out = { ...report, contactSheet: sheet.path, contactTimes: sheet.times, cutFrames: frames.map((f, i) => ({ path: f, t: r3(times[i]) })) };
  fs.writeFileSync(path.join(r.dir, "qa.json"), JSON.stringify(out, null, 1));
  return out;
}
