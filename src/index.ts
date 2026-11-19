#!/usr/bin/env node
import fs from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { asStudioError } from "./errors.js";
import { readImageB64 } from "./media.js";
import * as svc from "./service.js";
import { APP_ROOT } from "./config.js";

// Claude Desktop starts servers in "/"; libraries that look for files next to the working folder (Remotion's browser) need ours.
try {
  process.chdir(APP_ROOT);
} catch {
  /* explicit paths are used everywhere else */
}

type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

function ok(data: unknown, images: string[] = []) {
  const content: Content[] = [{ type: "text", text: typeof data === "string" ? data : JSON.stringify(data, null, 1) }];
  for (const p of images) if (fs.existsSync(p)) content.push(readImageB64(p));
  return { content };
}

function wrap<A>(fn: (args: A) => Promise<ReturnType<typeof ok>> | ReturnType<typeof ok>) {
  return async (args: A) => {
    try {
      return await fn(args);
    } catch (e) {
      const err = asStudioError(e);
      return { isError: true, content: [{ type: "text" as const, text: JSON.stringify({ error: err.toJSON() }, null, 1) }] };
    }
  };
}

const RO = { readOnlyHint: true };

const INSTRUCTIONS = `Talk-n-Edit is a prompt-driven video editor: Claude designs the edit as a timeline (JSON) and the server renders it.
Start by asking the user for an editing brief (style, pacing, captions, music, effects) unless they gave one; catalog_list styles has presets.
Workflow: project_open -> media_import -> analyze (transcript, faces, scenes, beats) -> transcript_get / analysis_get
-> timeline (catalog_list: components, transitions, looks, sfx, styles) -> timeline_validate -> render_start draft -> frames_get / open_in_player
-> revise with timeline_get + timeline_validate -> render_start final -> qa_check. For effects the library lacks, write one with fx_create and show its preview first.
Jobs return a jobId: job_status can wait up to 45 s. Finals are copied to the Clips folder (system_doctor shows the Inbox and Clips folders). Never invent ids, components or presets.`;

export function createServer() {
  svc.boot();
  const server = new McpServer({ name: "talk-n-edit", version: "0.3.0" }, { instructions: INSTRUCTIONS });

  server.registerTool(
    "system_doctor",
    { description: "Check ffmpeg, the Python analysis environment, fonts and folders. Run this first if anything fails.", inputSchema: {}, annotations: RO },
    wrap(async () => ok(await svc.doctor())),
  );

  server.registerTool(
    "project_open",
    {
      description: "Open a project by name (creates it if missing) and list its assets, analyses, timelines and renders. With no name, lists projects.",
      inputSchema: { name: z.string().min(1).max(80).optional(), create: z.boolean().default(true) },
    },
    wrap(async ({ name, create }) => ok(svc.projectOpen(name, create))),
  );

  server.registerTool(
    "media_import",
    {
      description:
        "Import video, audio or image files (or every media file in a folder) into a project. Copies originals into the workspace and builds a 540p proxy. Returns a jobId.",
      inputSchema: {
        projectId: z.string(),
        paths: z.array(z.string()).min(1).max(50).describe("Absolute paths or ~/... ; folders import their media files"),
        wait: z.number().min(0).max(45).default(20).describe("Seconds to wait for the job before returning"),
      },
    },
    wrap(async ({ projectId, paths, wait }) => {
      const job = svc.mediaImport(projectId, paths);
      const [v] = await svc.waitJobs([job.id], wait);
      return ok(v);
    }),
  );

  server.registerTool(
    "media_inspect",
    {
      description: "Probe an asset (duration, size, fps, audio, analyses done) and return a 4x3 contact sheet image of evenly spaced frames.",
      inputSchema: { assetId: z.string(), contactSheet: z.boolean().default(true) },
      annotations: RO,
    },
    wrap(async ({ assetId, contactSheet }) => {
      const r = await svc.mediaInspect(assetId, contactSheet);
      return ok({ ...r.info, contactSheetTimes: r.sheet?.times }, r.sheet ? [r.sheet.path] : []);
    }),
  );

  server.registerTool(
    "analyze",
    {
      description:
        "Analyse an asset. transcript = word-level speech-to-text (clip picking, captions, silence removal); faces = face positions (auto-face / split reframing); scenes = shot boundaries; beats = music tempo + beat times (beat-synced cuts). Cached; returns a jobId.",
      inputSchema: {
        assetId: z.string(),
        include: z.array(z.enum(["transcript", "faces", "scenes", "beats"])).min(1),
        language: z.string().max(5).optional().describe("ISO code like en, hi, pa; omit to auto-detect"),
        model: z.string().optional().describe("Whisper model override, e.g. small, medium, large-v3-turbo"),
        prompt: z.string().max(400).optional().describe("Names or terms to help transcription spell things right"),
        force: z.boolean().default(false),
        wait: z.number().min(0).max(45).default(20),
      },
    },
    wrap(async ({ wait, ...input }) => {
      const job = svc.analyze(input as any);
      const [v] = await svc.waitJobs([job.id], wait);
      return ok(v);
    }),
  );

  server.registerTool(
    "transcript_get",
    {
      description:
        "Read an asset's transcript as numbered sentences with times: [s0012 03:41.2–03:47.9] text. Use sentence ids in clips ({sentences:{from,to}}) or the times as in/out. format 'words' gives per-word times.",
      inputSchema: {
        assetId: z.string(),
        start: z.number().min(0).optional(),
        end: z.number().min(0).optional(),
        format: z.enum(["compact", "words"]).default("compact"),
        page: z.number().int().min(1).default(1),
      },
      annotations: RO,
    },
    wrap(async ({ assetId, ...opts }) => ok(svc.transcriptGet(assetId, opts))),
  );

  server.registerTool(
    "frames_get",
    {
      description: "Grab up to 12 frames (as images) from a video asset or a finished render at the given times in seconds. Use it to check framing, hooks and cuts.",
      inputSchema: {
        assetId: z.string().optional(),
        renderId: z.string().optional(),
        times: z.array(z.number().min(0)).min(1).max(12),
        width: z.number().int().min(160).max(1024).default(400),
      },
      annotations: RO,
    },
    wrap(async (a) => {
      const frames = await svc.framesGet(a);
      return ok({ frames: frames.map((f) => ({ t: f.t })) }, frames.map((f) => f.path));
    }),
  );

  server.registerTool(
    "catalog_list",
    {
      description:
        "List what timelines can use: components (text overlays + animated graphics + custom fx, with prop schemas), styles (saved edit styles), transitions, looks, sfx, music, luts, captionPresets, brandKits, fonts.",
      inputSchema: { kind: z.enum(["components", "styles", "transitions", "looks", "sfx", "music", "luts", "captionPresets", "brandKits", "fonts"]) },
      annotations: RO,
    },
    wrap(async ({ kind }) => ok(svc.catalog(kind))),
  );

  server.registerTool(
    "timeline_validate",
    {
      description:
        "Validate a timeline JSON and save it as a new version. Returns resolved duration per clip, the spoken text each clip will contain, warnings, and errors with JSON paths. Same name + project continues the same timeline id.",
      inputSchema: { timeline: z.record(z.string(), z.unknown()), save: z.boolean().default(true) },
    },
    wrap(async ({ timeline, save }) => ok(svc.timelineValidate(timeline, save))),
  );

  server.registerTool(
    "render_start",
    {
      description:
        "Render a timeline to MP4. quality 'draft' = fast 540-wide preview; 'final' = full quality, loudness-normalised, also copied to the export folder. Give timelineId (+version) or an inline timeline. Returns renderId + jobId.",
      inputSchema: {
        timelineId: z.string().optional(),
        version: z.number().int().positive().optional(),
        timeline: z.record(z.string(), z.unknown()).optional(),
        quality: z.enum(["draft", "final"]).default("draft"),
        wait: z.number().min(0).max(45).default(30),
      },
    },
    wrap(async ({ wait, ...input }) => {
      const r = svc.renderStart(input as any);
      const [v] = await svc.waitJobs([r.jobId], wait);
      return ok({ ...r, job: v });
    }),
  );

  server.registerTool(
    "job_status",
    {
      description: "Status of one or more jobs (import, analyze, render, qa). Waits up to `wait` seconds for them to finish. A finished qa job includes its contact sheet and cut frames as images.",
      inputSchema: { jobIds: z.array(z.string()).min(1).max(20), wait: z.number().min(0).max(45).default(25) },
      annotations: RO,
    },
    wrap(async ({ jobIds, wait }) => {
      const views = await svc.waitJobs(jobIds, wait);
      const images: string[] = [];
      for (const v of views) {
        if (v.type === "qa" && v.status === "succeeded" && v.result) {
          const r = v.result as any;
          if (r.contactSheet) images.push(r.contactSheet);
          for (const f of r.cutFrames ?? []) images.push(f.path);
        }
      }
      return ok(views, images);
    }),
  );

  server.registerTool(
    "job_cancel",
    { description: "Cancel a queued or running job.", inputSchema: { jobId: z.string() } },
    wrap(async ({ jobId }) => ok(svc.jobView(svc.cancelJob(jobId)))),
  );

  server.registerTool(
    "qa_check",
    {
      description: "Check a finished render: format, duration, black frames, dead air, loudness, hook timing; returns a contact sheet and frames after the first cuts. Returns a jobId.",
      inputSchema: { renderId: z.string(), wait: z.number().min(0).max(45).default(30) },
      annotations: RO,
    },
    wrap(async ({ renderId, wait }) => {
      const job = svc.qaCheck(renderId);
      const [v] = await svc.waitJobs([job.id], wait);
      const images: string[] = [];
      if (v.status === "succeeded" && v.result) {
        const r = v.result as any;
        images.push(r.contactSheet, ...(r.cutFrames ?? []).map((f: any) => f.path));
      }
      return ok(v, images);
    }),
  );

  server.registerTool(
    "analysis_get",
    {
      description:
        "Read analysis results: scenes (each shot with start/end, face coverage, face position and size — use it to pick shots), beats (tempo + beat times for beat-synced cuts), faces (same per-scene view).",
      inputSchema: { assetId: z.string(), kind: z.enum(["scenes", "beats", "faces"]) },
      annotations: RO,
    },
    wrap(async ({ assetId, kind }) => ok(svc.analysisGet(assetId, kind))),
  );

  server.registerTool(
    "timeline_get",
    {
      description: "Read a saved timeline (latest or a given version) so you can revise it: change what the user asked, then timeline_validate saves the next version.",
      inputSchema: { timelineId: z.string().optional(), projectId: z.string().optional(), name: z.string().optional(), version: z.number().int().positive().optional() },
      annotations: RO,
    },
    wrap(async (a) => ok(svc.timelineGet(a))),
  );

  server.registerTool(
    "style_save",
    {
      description:
        "Save the user's editing preferences as a named style (look, transition, autoPunch, captions, sfxOnTransitions, hook, removeSilences, music volume, notes). Use it in timelines as \"style\": \"<id>\" so every future edit matches.",
      inputSchema: { style: z.record(z.string(), z.unknown()) },
    },
    wrap(async ({ style }) => ok(svc.styleSave(style))),
  );

  server.registerTool(
    "fx_create",
    {
      description: `Create or update a custom animated effect when the built-in components can't do what the user wants. Write a React component (TSX) for Remotion:
- Only import from "react" and "remotion" (useCurrentFrame, useVideoConfig, interpolate, spring, Easing, AbsoluteFill, Sequence…). No network, no require.
- export default function Fx(props) {...}; draw on a TRANSPARENT background; size everything relative to useVideoConfig().width/height.
- props.brand has colors {text, highlight, emphasis, outline, box}; font families 'VS Heading', 'VS Body', 'VS Deva', 'VS Guru' are loaded.
Returns a 4-frame preview image (or the build/render error to fix). Show the preview to the user before using it as overlay component "fx:<name>".`,
      inputSchema: {
        name: z.string().regex(/^[a-z][a-z0-9-]{1,40}$/),
        description: z.string().min(1).max(300),
        code: z.string().min(20),
        defaultProps: z.record(z.string(), z.unknown()).default({}),
        defaultDuration: z.number().min(0.2).max(60).default(2.5),
        preview: z
          .object({ aspect: z.enum(["9:16", "16:9", "1:1", "4:5"]).default("9:16"), duration: z.number().min(0.2).max(60).optional(), props: z.record(z.string(), z.unknown()).optional() })
          .optional(),
        backgroundAsset: z.object({ assetId: z.string(), time: z.number().min(0) }).optional().describe("Show the preview over a frame of the user's video"),
        brandKit: z.string().optional(),
      },
    },
    wrap(async (a) => {
      const r = await svc.fxCreate(a as any);
      return ok(r, r.ok && (r as any).preview ? [(r as any).preview] : []);
    }),
  );

  server.registerTool(
    "open_in_player",
    { description: "Open a finished render in the default video player (QuickTime on a Mac) so the user can watch it.", inputSchema: { renderId: z.string() } },
    wrap(async ({ renderId }) => ok(svc.openInPlayer(renderId))),
  );

  return server;
}

async function main() {
  if (process.argv.includes("--paths")) {
    // Used by the setup script so both agree on the folders.
    const { WORKSPACE, INBOX_DIR, getConfig } = await import("./config.js");
    console.log(JSON.stringify({ workspace: WORKSPACE, inbox: INBOX_DIR, clips: getConfig().exportDir }));
    return;
  }
  if (process.argv.includes("--check")) {
    svc.boot();
    const d = await svc.doctor();
    console.log(JSON.stringify(d, null, 1));
    process.exit(d.ok ? 0 : 1);
  }
  const server = createServer();
  await server.connect(new StdioServerTransport());
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
