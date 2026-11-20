import { setupHint } from "./platform.js";
import fs from "node:fs";
import path from "node:path";
import { ffmpegBin, getConfig, pythonBin, WORKSPACE } from "./config.js";
import { StudioError } from "./errors.js";
import { r3 } from "./ffmpeg.js";
import { hashParams } from "./ids.js";
import type { JobContext } from "./jobs.js";
import { importJob } from "./media.js";
import { run } from "./proc.js";
import * as store from "./store.js";

/**
 * Links and discovery, built on yt-dlp (YouTube, Twitch, Instagram, Vimeo, X and many more sites).
 * yt-dlp runs from the Python environment; Node (this process) is its JavaScript runtime for YouTube.
 */

export const BROWSERS = ["chrome", "safari", "firefox", "edge", "brave", "chromium", "opera", "vivaldi"] as const;
export type Browser = (typeof BROWSERS)[number];

function ytdlp(extra: string[], cookiesFromBrowser?: Browser): string[] {
  const args = ["-m", "yt_dlp", "--ignore-config", "--no-warnings", "--js-runtimes", `node:${process.execPath}`];
  const ff = ffmpegBin();
  if (path.isAbsolute(ff)) args.push("--ffmpeg-location", path.dirname(ff));
  if (cookiesFromBrowser) args.push("--cookies-from-browser", cookiesFromBrowser);
  return [...args, ...extra];
}

/**
 * Run yt-dlp for its JSON (-J). The whole output is kept (a YouTube video's info can be several
 * hundred KB) and, if it still isn't JSON, yt-dlp's own message is reported instead of a parse error.
 */
async function ytdlpJson(py: string, args: string[], cookiesFromBrowser: Browser | undefined, url: string, signal?: AbortSignal): Promise<any> {
  let r;
  try {
    r = await run(py, ytdlp(args, cookiesFromBrowser), { signal, timeoutMs: 180_000, label: "yt-dlp", keepAllStdout: true });
  } catch (e) {
    throw friendly(e, url, cookiesFromBrowser);
  }
  try {
    return JSON.parse(r.stdout);
  } catch {
    const said = `${r.stderr}\n${r.stdout.slice(0, 2000)}`.trim().split(/\r?\n/).slice(-12).join("\n");
    throw friendly(new StudioError("ENGINE_FAILED", "yt-dlp didn't return the video's details.", said || "It printed nothing."), url, cookiesFromBrowser);
  }
}

export function friendly(e: unknown, url: string, cookiesFromBrowser?: Browser): StudioError {
  const se = e as StudioError;
  const tail = `${se.hint ?? ""} ${se.message ?? ""}`;
  if (/No module named yt_dlp/.test(tail)) return new StudioError("DEPENDENCY_MISSING", "The downloader (yt-dlp) isn't installed yet.", setupHint());
  // Windows: Chrome and Edge lock (and app-bind encrypt) their cookie database while open.
  if (/Could not copy .*cookie database|Failed to decrypt|cookie.*(locked|permission)/i.test(tail))
    return new StudioError("ENGINE_FAILED", "Couldn't read that browser's sign-in cookies.", "Close the browser completely and retry, or use cookiesFromBrowser \"firefox\" (Chrome and Edge on Windows often block this).");
  if (/Unsupported URL/i.test(tail)) return new StudioError("INVALID_INPUT", `That link isn't a video page yt-dlp understands: ${url}`, "Use the link of a single video (or a channel/playlist for discover_videos).");
  // YouTube's bot check is about the network (too many requests, VPN, shared or data-centre IP),
  // so signing in rarely helps once it has started; say what does.
  if (/not a bot/i.test(tail))
    return new StudioError(
      "ENGINE_FAILED",
      "YouTube is asking this network to prove it isn't a bot, so it's blocking downloads for now.",
      (cookiesFromBrowser ? "" : 'First retry with cookiesFromBrowser (e.g. "chrome" or "safari"). ') +
        "If that still fails: turn off any VPN or switch network (a phone hotspot works), or wait an hour or two. Or download the video in your browser and drop it into the Talk-n-Edit Inbox.",
    );
  if (/Sign in to confirm|login required|cookies|private video|members-only|age/i.test(tail))
    return new StudioError("ENGINE_FAILED", "The site wants you to be signed in for this video.", 'Retry with cookiesFromBrowser (e.g. "chrome" or "safari") to use your browser\'s sign-in.');
  if (/HTTP Error 403|429|rate.?limit|Too Many Requests/i.test(tail))
    return new StudioError("ENGINE_FAILED", "The site refused or rate-limited the download.", "Wait a few minutes, run setup again to update yt-dlp, or retry with cookiesFromBrowser.");
  if (/Video unavailable|not available|removed|404/i.test(tail)) return new StudioError("NOT_FOUND", "That video isn't available (removed, private or region-locked).", se.hint);
  return se instanceof StudioError ? se : new StudioError("ENGINE_FAILED", String(e));
}

// ------------------------------------------------------------------ source info

export interface SourceInfo {
  url: string;
  site: string;
  id: string;
  title: string;
  channel?: string;
  channelUrl?: string;
  uploadDate?: string;
  duration?: number;
  views?: number;
  likes?: number;
  license?: string;
  language?: string;
  description?: string;
  tags?: string[];
  /** When only part of the video was downloaded: source time of the asset's 0 s. */
  sectionStart?: number;
  sectionEnd?: number;
  chapters?: { title: string; start: number; end: number }[];
  /** "Most replayed" peaks (YouTube), in the downloaded file's time. Higher score = rewatched more. */
  mostReplayed?: { start: number; end: number; score: number }[];
}

function ymd(d?: string): string | undefined {
  return d && /^\d{8}$/.test(d) ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : undefined;
}

/** Strongest non-overlapping heatmap windows (in time order), shifted into the downloaded section's time. */
export function replayPeaks(heatmap: { start_time: number; end_time: number; value: number }[] | undefined, from = 0, to = Infinity, n = 6) {
  if (!Array.isArray(heatmap) || !heatmap.length) return undefined;
  const inside = heatmap.filter((h) => h.end_time > from && h.start_time < to);
  if (!inside.length) return undefined;
  const sorted = [...inside].sort((a, b) => b.value - a.value);
  // Only real peaks: well above the video's typical replay level.
  const values = inside.map((h) => h.value).sort((a, b) => a - b);
  const median = values[Math.floor(values.length / 2)];
  const floor = Math.max(median * 1.5, sorted[0].value * 0.5);
  const picked: typeof inside = [];
  for (const h of sorted) {
    if (picked.length >= n || h.value < floor) break;
    if (picked.some((p) => h.start_time < p.end_time + 5 && h.end_time > p.start_time - 5)) continue;
    picked.push(h);
  }
  if (!picked.length) return undefined;
  return picked
    .sort((a, b) => a.start_time - b.start_time)
    .map((h) => ({ start: r3(Math.max(0, h.start_time - from)), end: r3(Math.min(to, h.end_time) - from), score: Math.round(h.value * 100) / 100 }));
}

export function sourceFromInfo(info: any, url: string, start?: number, end?: number): SourceInfo {
  const from = start ?? 0;
  const to = end ?? Infinity;
  const chapters = Array.isArray(info.chapters)
    ? info.chapters
        .filter((c: any) => c.end_time > from && c.start_time < to)
        .slice(0, 40)
        .map((c: any) => ({ title: String(c.title ?? "").slice(0, 100), start: r3(Math.max(0, c.start_time - from)), end: r3(Math.min(to, c.end_time) - from) }))
    : undefined;
  return {
    url: info.webpage_url ?? url,
    site: info.extractor_key ?? info.extractor ?? "web",
    id: String(info.id ?? ""),
    title: String(info.title ?? info.fulltitle ?? "video"),
    channel: info.channel ?? info.uploader ?? undefined,
    channelUrl: info.channel_url ?? info.uploader_url ?? undefined,
    uploadDate: ymd(info.upload_date),
    duration: typeof info.duration === "number" ? r3(info.duration) : undefined,
    views: info.view_count ?? undefined,
    likes: info.like_count ?? undefined,
    license: info.license ?? undefined,
    language: info.language ?? undefined,
    description: typeof info.description === "string" ? info.description.slice(0, 1500) : undefined,
    tags: Array.isArray(info.tags) ? info.tags.slice(0, 25) : undefined,
    sectionStart: start,
    sectionEnd: end,
    chapters: chapters?.length ? chapters : undefined,
    mostReplayed: replayPeaks(info.heatmap, from, to),
  };
}

const sourcesDir = () => path.join(WORKSPACE, "sources");

export function sourceFor(assetId: string): SourceInfo | undefined {
  const a = store.getAsset(assetId);
  return (a.data as { source?: SourceInfo }).source;
}

// ------------------------------------------------------------------ import from a link

export interface UrlImportInput {
  projectId: string;
  url: string;
  /** Download only this part (seconds in the source video). */
  start?: number;
  end?: number;
  maxHeight?: number;
  cookiesFromBrowser?: Browser;
}

export function validateUrl(url: string): string {
  const u = url.trim();
  if (!/^https?:\/\/\S+$/i.test(u)) throw new StudioError("INVALID_INPUT", `Not a web link: ${url}`, "Give the full link, starting with https://");
  return u;
}

function fmtTime(s: number): string {
  const m = Math.floor(s / 60);
  const sec = Math.round(s - m * 60);
  return `${m}m${String(sec).padStart(2, "0")}s`;
}

export async function urlImportJob(input: UrlImportInput, ctx: JobContext) {
  store.getProject(input.projectId);
  const url = validateUrl(input.url);
  const py = pythonBin();
  if (!fs.existsSync(py)) throw new StudioError("DEPENDENCY_MISSING", "The Python environment is missing.", "Run the setup script, then restart Claude.");

  ctx.progress("reading the link", 0.02);
  let info: any;
  try {
    info = await ytdlpJson(py, ["-J", "--no-playlist", url], input.cookiesFromBrowser, url, ctx.signal);
  } catch (e) {
    throw e instanceof StudioError ? e : friendly(e, url, input.cookiesFromBrowser);
  }
  if (info._type === "playlist" || Array.isArray(info.entries))
    throw new StudioError("INVALID_INPUT", "That link is a playlist or channel, not one video.", "Use discover_videos on it to list its videos, then import the ones you want.");
  if (info.is_live) throw new StudioError("INVALID_INPUT", "That's a live stream that is still running.", "Import it after the stream ends, or use a clip link.");

  const dur = typeof info.duration === "number" ? info.duration : undefined;
  let start = input.start;
  let end = input.end;
  if (start !== undefined && end !== undefined && end <= start) throw new StudioError("INVALID_INPUT", `"end" (${end}) must be after "start" (${start}).`);
  if (dur !== undefined) {
    if (start !== undefined && start >= dur) throw new StudioError("INVALID_INPUT", `start ${start}s is past the end of the video (${r3(dur)}s).`);
    if (end !== undefined && end > dur) end = dur;
  }
  const section = start !== undefined || end !== undefined;
  if (section) start = start ?? 0;

  const inbox = getConfig().inboxDir;
  fs.mkdirSync(inbox, { recursive: true });
  const tag = section ? ` (${fmtTime(start!)}-${end !== undefined ? fmtTime(end) : "end"})` : "";
  const template = path.join(inbox, `%(title).70B [%(id)s]${tag}.%(ext)s`);
  const h = Math.max(240, Math.min(2160, input.maxHeight ?? 1080));
  const fmt = `bv*[height<=${h}][ext=mp4]+ba[ext=m4a]/bv*[height<=${h}]+ba/b[height<=${h}]/b`;
  const args = [
    "--no-playlist",
    "-f", fmt,
    "--merge-output-format", "mp4",
    "--no-mtime",
    "-o", template,
    "--print", "after_move:TNEFILE:%(filepath)s",
    "--no-simulate",
    "--progress", "--newline",
    "--progress-template", "download:TNEPROG %(progress._percent_str)s",
  ];
  // Cut exactly at the asked times (re-encodes just the cut points' neighbourhood), so section times stay true.
  if (section) args.push("--download-sections", `*${start}-${end ?? "inf"}`, "--force-keyframes-at-cuts");
  args.push(url);

  let file = "";
  const onLine = (line: string) => {
    const mp = /TNEPROG\s+([\d.]+)%/.exec(line);
    if (mp) ctx.progress("downloading", 0.05 + 0.6 * Math.min(1, +mp[1] / 100));
    const mf = /^TNEFILE:(.+)$/.exec(line.trim());
    if (mf) file = mf[1].trim();
  };
  try {
    await run(py, ytdlp(args, input.cookiesFromBrowser), { signal: ctx.signal, timeoutMs: 3 * 3600_000, label: "yt-dlp", onStdoutLine: onLine, onStderrLine: onLine });
  } catch (e) {
    throw friendly(e, url, input.cookiesFromBrowser);
  }
  if (!file || !fs.existsSync(file)) throw new StudioError("ENGINE_FAILED", "The download finished but the file wasn't found.", "Check the Inbox folder; run setup to update yt-dlp.");

  const source = sourceFromInfo(info, url, section ? start : undefined, section ? end : undefined);
  fs.mkdirSync(sourcesDir(), { recursive: true });
  fs.writeFileSync(path.join(sourcesDir(), `${hashParams({ site: source.site, id: source.id, start, end })}.json`), JSON.stringify(source, null, 2));

  const sub: JobContext = { ...ctx, progress: (stage, p) => ctx.progress(stage, 0.68 + 0.32 * p) };
  const res = await importJob({ projectId: input.projectId, paths: [file] }, sub);
  for (const a of res.assets) {
    const asset = store.getAsset(a.assetId);
    store.updateAssetData(asset.id, { ...asset.data, source } as any);
  }
  return {
    downloaded: file,
    assets: res.assets,
    source: { ...source, description: source.description?.slice(0, 300) },
    hint: languageHint(source),
  };
}

/**
 * Tell Claude which language to transcribe in. YouTube often doesn't list a language (Bollywood clip
 * channels rarely do), so fall back to the script of the title: Devanagari → Hindi, Gurmukhi → Punjabi.
 */
export function languageHint(source: Pick<SourceInfo, "language" | "title" | "mostReplayed">): string | undefined {
  let lang = source.language && !/^en\b/i.test(source.language) ? source.language.split(/[-_]/)[0] : undefined;
  if (!source.language) {
    if (/[\u0A00-\u0A7F]/.test(source.title ?? "")) lang = "pa";
    else if (/[\u0900-\u097F]/.test(source.title ?? "")) lang = "hi";
  }
  if (lang) return `Spoken language looks like "${lang}": pass it to analyze as language.`;
  return source.mostReplayed ? "mostReplayed lists the moments viewers rewatched most (times are in the downloaded file)." : undefined;
}

/** Look at a link without downloading: whole-video chapters, most-replayed moments, length, views, thumbnail. */
export async function linkInfo(urlIn: string, cookiesFromBrowser?: Browser): Promise<{ source: SourceInfo; formats?: string; thumbnail?: string }> {
  const url = validateUrl(urlIn);
  const py = pythonBin();
  if (!fs.existsSync(py)) throw new StudioError("DEPENDENCY_MISSING", "The Python environment is missing.", "Run the setup script, then restart Claude.");
  let info: any;
  try {
    info = await ytdlpJson(py, ["-J", "--no-playlist", url], cookiesFromBrowser, url);
  } catch (e) {
    throw e instanceof StudioError ? e : friendly(e, url, cookiesFromBrowser);
  }
  if (info._type === "playlist" || Array.isArray(info.entries))
    throw new StudioError("INVALID_INPUT", "That link is a playlist or channel, not one video.", "Use discover_videos to list its videos.");
  const source = sourceFromInfo(info, url);
  const heights = Array.isArray(info.formats) ? [...new Set(info.formats.map((f: any) => f.height).filter((h: any) => typeof h === "number"))].sort((a: any, b: any) => b - a) : [];
  let thumbnail: string | undefined;
  const t = thumbOf({ ...info, ie_key: info.extractor_key });
  if (t) {
    const dir = path.join(WORKSPACE, "cache", "thumbs");
    fs.mkdirSync(dir, { recursive: true });
    thumbnail = await fetchThumb(t, path.join(dir, `${hashParams(t)}.jpg`));
  }
  return { source: { ...source, description: source.description?.slice(0, 600) }, formats: heights.length ? `${heights.slice(0, 6).join("p, ")}p` : undefined, thumbnail };
}

// ------------------------------------------------------------------ discover videos

export interface DiscoverInput {
  /** Search words (YouTube search). */
  query?: string;
  /** A channel: @handle, channel link, or a Twitch login. */
  channel?: string;
  /** Any playlist / channel / profile link yt-dlp can list. */
  url?: string;
  platform?: "youtube" | "twitch";
  /** YouTube channel tab, or Twitch clips/videos. */
  tab?: "videos" | "shorts" | "streams" | "clips";
  sort?: "relevance" | "newest" | "views";
  /** Twitch clips time range. */
  range?: "24h" | "7d" | "30d" | "all";
  count?: number;
  minDuration?: number;
  maxDuration?: number;
  cookiesFromBrowser?: Browser;
}

export interface Found {
  n: number;
  /** Number of this result's thumbnail among the returned pictures (1-based), when one was fetched. */
  picture?: number;
  title: string;
  url: string;
  channel?: string;
  duration?: number;
  views?: number;
  uploadDate?: string;
  thumbnail?: string;
}

export function discoverTarget(d: DiscoverInput): { target: string; fetch: number; describe: string } {
  const count = Math.max(1, Math.min(25, d.count ?? 10));
  const filtered = d.minDuration !== undefined || d.maxDuration !== undefined || d.sort === "views";
  const fetchN = Math.min(100, filtered ? count * 4 : count);
  if (d.url) return { target: validateUrl(d.url), fetch: fetchN, describe: d.url };
  const platform = d.platform ?? (d.channel && /twitch\.tv/i.test(d.channel) ? "twitch" : "youtube");
  if (platform === "twitch") {
    if (!d.channel) throw new StudioError("INVALID_INPUT", "Twitch needs a channel (the streamer's login name).", 'For example {platform:"twitch", channel:"shroud", tab:"clips", range:"7d"}.');
    const login = d.channel.replace(/^https?:\/\/(www\.)?twitch\.tv\//i, "").replace(/[/?#].*$/, "");
    if (!/^\w{2,40}$/.test(login)) throw new StudioError("INVALID_INPUT", `Not a Twitch login: ${d.channel}`);
    if (d.tab === "videos") return { target: `https://www.twitch.tv/${login}/videos?filter=archives&sort=time`, fetch: fetchN, describe: `Twitch ${login} past broadcasts` };
    const range = { "24h": "24hr", "7d": "7d", "30d": "30d", all: "all" }[d.range ?? "7d"];
    return { target: `https://www.twitch.tv/${login}/clips?filter=clips&range=${range}`, fetch: fetchN, describe: `Twitch ${login} top clips (${d.range ?? "7d"})` };
  }
  if (d.channel) {
    let base = d.channel.trim();
    if (!/^https?:\/\//i.test(base)) base = `https://www.youtube.com/${base.startsWith("@") ? base : `@${base}`}`;
    base = base.replace(/\/(videos|shorts|streams|featured|playlists)\/?$/, "").replace(/\/$/, "");
    const tab = d.tab && d.tab !== "clips" ? d.tab : "videos";
    return { target: `${base}/${tab}`, fetch: fetchN, describe: `${base} (${tab})` };
  }
  if (!d.query?.trim()) throw new StudioError("INVALID_INPUT", "Give a query, a channel or a url.", 'For example {query:"podcast clips about startups", sort:"views"}.');
  const q = d.query.trim().replace(/\s+/g, " ").slice(0, 200);
  const prefix = d.sort === "newest" ? "ytsearchdate" : "ytsearch";
  return { target: `${prefix}${fetchN}:${q}`, fetch: fetchN, describe: `YouTube search "${q}"` };
}

function thumbOf(e: any): string | undefined {
  if (e.ie_key === "Youtube" || /youtube\.com|youtu\.be/.test(e.url ?? "")) if (e.id) return `https://i.ytimg.com/vi/${e.id}/mqdefault.jpg`;
  if (typeof e.thumbnail === "string") return e.thumbnail;
  if (Array.isArray(e.thumbnails) && e.thumbnails.length) {
    const sized = e.thumbnails.filter((t: any) => t.url && (t.width ?? 0) <= 640);
    return (sized.at(-1) ?? e.thumbnails.at(-1)).url;
  }
  return undefined;
}

export function parseListing(json: any, d: DiscoverInput): Found[] {
  const count = Math.max(1, Math.min(25, d.count ?? 10));
  const entries: any[] = Array.isArray(json?.entries) ? json.entries.flatMap((e: any) => (Array.isArray(e?.entries) ? e.entries : [e])) : [];
  let list = entries
    .filter((e) => e && (e.url || e.webpage_url || e.id))
    .map((e) => {
      let url: string = e.webpage_url ?? e.url ?? "";
      if (!/^https?:/.test(url) && e.id && (e.ie_key === "Youtube" || /^ytsearch/.test(json?.extractor ?? ""))) url = `https://www.youtube.com/watch?v=${e.id}`;
      return {
        title: String(e.title ?? e.id ?? "untitled").slice(0, 140),
        url,
        channel: e.channel ?? e.uploader ?? json?.channel ?? json?.uploader ?? undefined,
        duration: typeof e.duration === "number" ? r3(e.duration) : undefined,
        views: typeof e.view_count === "number" ? e.view_count : undefined,
        uploadDate: ymd(e.upload_date) ?? (typeof e.timestamp === "number" ? new Date(e.timestamp * 1000).toISOString().slice(0, 10) : undefined),
        thumbnail: thumbOf(e),
      };
    })
    .filter((e) => /^https?:/.test(e.url));
  if (d.minDuration !== undefined) list = list.filter((e) => e.duration === undefined || e.duration >= d.minDuration!);
  if (d.maxDuration !== undefined) list = list.filter((e) => e.duration === undefined || e.duration <= d.maxDuration!);
  if (d.sort === "views") list.sort((a, b) => (b.views ?? -1) - (a.views ?? -1));
  return list.slice(0, count).map((e, i) => ({ n: i + 1, ...e }));
}

async function fetchThumb(url: string, out: string): Promise<string | undefined> {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 8000);
    const r = await fetch(url, { signal: ctl.signal });
    clearTimeout(t);
    if (!r.ok) return undefined;
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length < 200 || buf.length > 8_000_000) return undefined;
    const raw = `${out}.src`;
    fs.writeFileSync(raw, buf);
    // Small pictures: enough to choose from, cheap to look at.
    try {
      await run(ffmpegBin(), ["-y", "-v", "error", "-i", raw, "-vf", "scale=320:-2", "-frames:v", "1", "-q:v", "4", out], { timeoutMs: 20_000 });
      return out;
    } catch {
      return undefined;
    }
  } catch {
    return undefined;
  }
}

export async function discoverVideos(d: DiscoverInput, withThumbs = true): Promise<{ searched: string; results: Found[]; thumbnails: string[] }> {
  const py = pythonBin();
  if (!fs.existsSync(py)) throw new StudioError("DEPENDENCY_MISSING", "The Python environment is missing.", "Run the setup script, then restart Claude.");
  const { target, fetch: n, describe } = discoverTarget(d);
  let json: any;
  try {
    json = await ytdlpJson(py, ["-J", "--flat-playlist", "--playlist-end", String(n), target], d.cookiesFromBrowser, target);
  } catch (e) {
    throw e instanceof StudioError ? e : friendly(e, target, d.cookiesFromBrowser);
  }
  const results = parseListing(json, d);
  const thumbnails: string[] = [];
  if (withThumbs && results.length) {
    const dir = path.join(WORKSPACE, "cache", "thumbs");
    fs.mkdirSync(dir, { recursive: true });
    const got = await Promise.all(
      results.slice(0, 12).map((r) => (r.thumbnail ? fetchThumb(r.thumbnail, path.join(dir, `${hashParams(r.thumbnail)}.jpg`)) : Promise.resolve(undefined))),
    );
    got.forEach((g, i) => {
      if (!g) return;
      thumbnails.push(g);
      results[i].picture = thumbnails.length;
    });
  }
  return { searched: describe, results, thumbnails };
}
