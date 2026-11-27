#!/usr/bin/env node
import fs from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { asStudioError } from "./errors.js";
import { readImageB64 } from "./media.js";
import * as svc from "./service.js";
import { storageClean, storageReport } from "./storage.js";
import { applyPatch } from "./patch.js";
import { previewStills } from "./preview.js";
import { importPack, LICENSES } from "./sounds.js";
import { BROWSERS } from "./web.js";
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
Workflow: project_open -> media_import (files) or media_import_url (links; link_info peeks first; discover_videos finds videos) -> analyze (transcript, faces, scenes, beats) -> transcript_get / analysis_get
-> timeline (catalog_list: components, transitions, looks, sfx, styles) -> timeline_validate -> render_start draft -> frames_get / open_in_player
-> revise with timeline_get + timeline_validate -> render_start final -> qa_check. For effects the library lacks, write one with fx_create and show its preview first.
Jobs return a jobId: job_status can wait up to 45 s. Finals are copied to the Clips folder (system_doctor shows the Inbox and Clips folders). Never invent ids, components or presets.`;

export function createServer() {
  svc.boot();
  const server = new McpServer({ name: "talk-n-edit", version: "0.5.4" }, { instructions: INSTRUCTIONS });

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

  const browser = z.enum(BROWSERS).optional().describe("Use this browser's sign-in (for private, unlisted, members-only or age-restricted videos)");
  server.registerTool(
    "media_import_url",
    {
      description:
        "Download a video from a link (YouTube, Shorts, Twitch VODs and clips, Instagram, Vimeo, X, Facebook and many more) into the Inbox and import it, like media_import. Give start/end (seconds) to download only that part of a long video. The result includes the source (title, channel, chapters and, for YouTube, the most-replayed moments) and a jobId; downloads can take minutes, poll job_status.",
      inputSchema: {
        projectId: z.string(),
        url: z.string().min(8).max(2000),
        start: z.number().min(0).optional().describe("Download from this second of the source"),
        end: z.number().positive().optional().describe("Download up to this second of the source"),
        maxHeight: z.number().int().min(240).max(2160).default(1080).describe("Highest resolution to fetch"),
        cookiesFromBrowser: browser,
        wait: z.number().min(0).max(45).default(30).describe("Seconds to wait for the job before returning"),
      },
    },
    wrap(async ({ projectId, url, start, end, maxHeight, cookiesFromBrowser, wait }) => {
      const job = svc.mediaImportUrl(projectId, url, { start, end, maxHeight, cookiesFromBrowser });
      const [v] = await svc.waitJobs([job.id], wait);
      return ok(v);
    }),
  );

  server.registerTool(
    "link_info",
    {
      description:
        "Look at a video link without downloading it: title, channel, length, views, available resolutions, chapters and (YouTube) the most-replayed moments, in the source's time, plus a thumbnail. Use it on long videos to choose which part to download with media_import_url start/end.",
      inputSchema: { url: z.string().min(8).max(2000), cookiesFromBrowser: browser },
      annotations: RO,
    },
    wrap(async ({ url, cookiesFromBrowser }) => {
      const r = await svc.linkInfoGet(url, cookiesFromBrowser);
      return ok({ source: r.source, resolutions: r.formats }, r.thumbnail ? [r.thumbnail] : []);
    }),
  );

  server.registerTool(
    "discover_videos",
    {
      description:
        "Find videos to edit or learn from: YouTube search (query; sort relevance, newest or views), a channel's videos/Shorts/streams (channel: @handle or link), a Twitch streamer's top clips or past broadcasts (platform twitch, channel login, tab clips|videos, range), or any playlist/profile link (url). Filters by duration. Returns numbered results with links, views and dates, plus thumbnail pictures (each result's `picture` number). Import picks with media_import_url.",
      inputSchema: {
        query: z.string().max(200).optional(),
        channel: z.string().max(300).optional(),
        url: z.string().max(2000).optional(),
        platform: z.enum(["youtube", "twitch"]).optional(),
        tab: z.enum(["videos", "shorts", "streams", "clips"]).optional(),
        sort: z.enum(["relevance", "newest", "views"]).default("relevance"),
        range: z.enum(["24h", "7d", "30d", "all"]).optional().describe("Twitch clips time range (default 7d)"),
        count: z.number().int().min(1).max(25).default(10),
        minDuration: z.number().min(0).optional().describe("Seconds"),
        maxDuration: z.number().positive().optional().describe("Seconds"),
        cookiesFromBrowser: browser,
      },
      annotations: RO,
    },
    wrap(async (a) => {
      const r = await svc.discover(a);
      return ok({ searched: r.searched, results: r.results }, r.thumbnails);
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
    "timeline_patch",
    {
      description:
        "Change a few values in a saved timeline without sending all of it: ops like {op:'set', path:'overlays[id=panel].props.rows[2].text', value:'…'}, {op:'remove', path:'zooms[1]'}, {op:'append', path:'overlays', value:{…}}. [n] = list index, [id=x] = list item by id. The result is validated and saved as the next version (nothing is saved if it's invalid); returns the same report as timeline_validate plus what changed.",
      inputSchema: {
        timelineId: z.string(),
        version: z.number().int().positive().optional().describe("Version to start from (default: latest)"),
        ops: z
          .array(z.object({ op: z.enum(["set", "remove", "append"]), path: z.string().min(1), value: z.unknown().optional() }))
          .min(1)
          .max(100),
      },
    },
    wrap(async ({ timelineId, version, ops }) => {
      const base = svc.timelineGet({ timelineId, version }) as any;
      const { json, changed } = applyPatch(base.timeline, ops as any);
      return ok({ from: { timelineId, version: base.version }, changed, ...svc.timelineValidate(json, true) });
    }),
  );

  server.registerTool(
    "sound_pack_import",
    {
      description: `Import a folder of sounds the user downloaded (e.g. a Sonniss GDC bundle folder, Pixabay or CC0 Freesound downloads, own recordings) as a sound pack, with its licence recorded. Sounds become "library": "packs/<pack>/<name>" (listed in catalog_list sfx) and every render's credits list them with their licence. license: ${Object.keys(LICENSES).join(", ")} (non-commercial or no-derivatives licences are refused; CC-BY-4.0 needs an attribution line). Ask the user which licence the download came with; never guess.`,
      inputSchema: {
        folder: z.string(),
        pack: z.string().min(1).max(60),
        license: z.string(),
        source: z.string().min(1).describe("Where it came from, e.g. 'Sonniss GDC 2026 bundle' or 'freesound.org user X'"),
        url: z.string().optional(),
        attribution: z.string().optional(),
        notes: z.string().optional(),
      },
    },
    wrap(async (a) => ok(importPack(a))),
  );

  server.registerTool(
    "timeline_preview",
    {
      description:
        "Still pictures of a saved timeline at chosen seconds (up to 8), drawn exactly as a render would (cuts, framing, zooms, look, captions, graphics at that frame), in seconds instead of a full render. Use it to check a fix to text, positions or timing before rendering. quality draft = 540 wide (fast), final = full size.",
      inputSchema: {
        timelineId: z.string(),
        version: z.number().int().positive().optional(),
        times: z.array(z.number().min(0)).min(1).max(8),
        quality: z.enum(["draft", "final"]).default("draft"),
      },
      annotations: RO,
    },
    wrap(async ({ timelineId, version, times, quality }) => {
      const r = await previewStills(timelineId, version, times, quality);
      return ok(r, r.frames.map((f) => f.path));
    }),
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
    { description: "Cancel a queued or running job. The answer says whether anything was cancelled (a job that already finished keeps its results).", inputSchema: { jobId: z.string() } },
    wrap(async ({ jobId }) => ok(svc.cancelJobView(jobId))),
  );

  server.registerTool(
    "storage_report",
    {
      description:
        "Show what is using disk space: the shared graphics cache (by project and Reel, and how much has not been used for 7 or 30 days) and leftover files in old renders. Read-only. Renders add a note when the cache passes the size set in config.json features.graphicsCacheWarnGB.",
      inputSchema: {},
      annotations: RO,
    },
    wrap(async () => ok(storageReport())),
  );

  server.registerTool(
    "storage_clean",
    {
      description:
        "Free disk space by removing what the user picked. what: graphicsCache (drawn graphics kept for reuse; filter by project, timeline name and/or notUsedForDays) or renderFiles (drawn frames and in-between video in old renders; filter by project/timeline). Finished videos, sources, analyses and timelines are never touched, and graphics used in the last 6 hours are skipped. Runs as a dry run unless apply is true: show the user the dry-run result and only apply after they confirm.",
      inputSchema: {
        what: z.enum(["graphicsCache", "renderFiles"]),
        project: z.string().optional(),
        timeline: z.string().optional(),
        notUsedForDays: z.number().min(0).max(3650).optional(),
        apply: z.boolean().default(false),
      },
    },
    wrap(async (a) => ok(storageClean(a))),
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
        "Read analysis results: scenes (each shot with start/end, face coverage, face position and size — use it to pick shots), beats (tempo + beat times for beat-synced cuts), faces (same per-scene view), source (for videos imported from a link: title, channel, views, chapters and YouTube's most-replayed moments, in the file's time).",
      inputSchema: { assetId: z.string(), kind: z.enum(["scenes", "beats", "faces", "source"]) },
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
    { description: "Open a finished render in the default video player (QuickTime on a Mac, Media Player/Films & TV on Windows) so the user can watch it.", inputSchema: { renderId: z.string() } },
    wrap(async ({ renderId }) => ok(svc.openInPlayer(renderId))),
  );

  return server;
}

async function main() {
  if (process.argv.includes("--paths")) {
    // Used by the setup script so both agree on the folders.
    const { WORKSPACE, getConfig } = await import("./config.js");
    console.log(JSON.stringify({ workspace: WORKSPACE, inbox: getConfig().inboxDir, clips: getConfig().exportDir, whisperModel: getConfig().whisperModel }));
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
