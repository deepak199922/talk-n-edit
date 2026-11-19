#!/usr/bin/env node
/* Command-line access to the same engine the MCP server uses (handy for testing and batch work). */
import fs from "node:fs";
import * as svc from "./service.js";

function usage(): never {
  console.log(`talk-n-edit <command>
  doctor
  project [name]
  import <projectId> <path...>
  analyze <assetId> [transcript,faces,scenes] [--model small] [--language en]
  transcript <assetId> [page]
  validate <timeline.json>
  render <timeline.json> [draft|final]
  qa <renderId>
  frames <renderId|assetId> <t1,t2,...>`);
  process.exit(1);
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
}

async function waitAndPrint(jobId: string) {
  let last = "";
  const timer = setInterval(async () => {
    const [v] = await svc.waitJobs([jobId], 0);
    const line = `${v.status} ${Math.round(v.progress * 100)}% ${v.stage}`;
    if (line !== last) process.stderr.write(line + "\n");
    last = line;
  }, 2000);
  const j = await svc.waitForJob(jobId);
  clearInterval(timer);
  const [v] = await svc.waitJobs([j.id], 0);
  console.log(JSON.stringify(v, null, 1));
  if (v.status !== "succeeded") process.exitCode = 1;
}

async function main() {
  const args = process.argv.slice(2);
  const cmd = args.shift();
  svc.boot();
  switch (cmd) {
    case "doctor":
      console.log(JSON.stringify(await svc.doctor(), null, 1));
      break;
    case "project":
      console.log(JSON.stringify(svc.projectOpen(args[0]), null, 1));
      break;
    case "import": {
      const [pid, ...paths] = args;
      if (!pid || !paths.length) usage();
      await waitAndPrint(svc.mediaImport(pid, paths).id);
      break;
    }
    case "analyze": {
      const model = flag(args, "model");
      const language = flag(args, "language");
      const [aid, kinds = "transcript,faces,scenes"] = args;
      if (!aid) usage();
      await waitAndPrint(svc.analyze({ assetId: aid, include: kinds.split(",") as any, model, language }).id);
      break;
    }
    case "transcript":
      console.log(svc.transcriptGet(args[0], { page: Number(args[1] ?? 1) }));
      break;
    case "validate":
      console.log(JSON.stringify(svc.timelineValidate(JSON.parse(fs.readFileSync(args[0], "utf8"))), null, 1));
      break;
    case "render": {
      const r = svc.renderStart({ timeline: JSON.parse(fs.readFileSync(args[0], "utf8")), quality: (args[1] as any) ?? "draft" });
      process.stderr.write(JSON.stringify(r) + "\n");
      await waitAndPrint(r.jobId);
      break;
    }
    case "qa":
      await waitAndPrint(svc.qaCheck(args[0]).id);
      break;
    case "frames": {
      const [id, ts] = args;
      const times = ts.split(",").map(Number);
      const out = await svc.framesGet(id.startsWith("rnd_") ? { renderId: id, times } : { assetId: id, times });
      console.log(JSON.stringify(out, null, 1));
      break;
    }
    default:
      usage();
  }
}

main().then(
  () => setTimeout(() => process.exit(process.exitCode ?? 0), 50),
  (e) => {
    console.error(JSON.stringify({ error: e?.toJSON?.() ?? String(e) }, null, 1));
    process.exit(1);
  },
);
