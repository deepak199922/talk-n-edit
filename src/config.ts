import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expandHome, isInside, IS_WIN, windowsProgramDirs } from "./platform.js";

/** Folder this app is installed in (contains dist/, library/, python/). */
export const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const LIBRARY = path.join(APP_ROOT, "library");
export const PYTHON_DIR = path.join(APP_ROOT, "python");

const HOME = os.homedir();
const ENV_HOME = process.env.TALK_N_EDIT_HOME ?? process.env.VIDEO_STUDIO_HOME;
const NEW_HOME = path.join(HOME, "TalkNEdit");
const LEGACY_HOME = path.join(HOME, "VideoStudio");
/** Installs from before the rename (as "Video Studio") keep their folders. */
export const LEGACY_INSTALL = !ENV_HOME && !fs.existsSync(NEW_HOME) && fs.existsSync(LEGACY_HOME);
/** Projects, renders, cache, saved styles and custom graphics. */
export const WORKSPACE = path.resolve(ENV_HOME ?? (LEGACY_INSTALL ? LEGACY_HOME : NEW_HOME));
/** Where you drop videos (Inbox) and get finished clips (Clips). */
export const MEDIA_DIR = path.join(HOME, "Downloads", LEGACY_INSTALL ? "Video Studio" : "Talk-n-Edit");
export const INBOX_DIR = path.join(MEDIA_DIR, "Inbox");

export interface Config {
  /** Folders media may be imported from. */
  importRoots: string[];
  /** Final renders are also copied here with a friendly name. */
  exportDir: string;
  /** Where you drop videos, and where downloads from links are saved. */
  inboxDir: string;
  /** "auto" picks mlx-whisper on Apple Silicon, faster-whisper elsewhere. */
  transcriptionBackend: "auto" | "mlx" | "faster-whisper";
  /** Whisper model name (backend specific mapping happens in the sidecar). */
  whisperModel: string;
  limits: { maxImportGB: number; maxOutputMinutes: number };
  defaultBrandKit: string;
  ffmpeg?: string;
  ffprobe?: string;
  python?: string;
  /** Chrome/Chromium for animated graphics (optional; macOS uses Remotion's own headless shell). */
  chrome?: string;
  /**
   * Switches for newer behaviour. Each one can be set to false in config.json to get the previous behaviour back.
   * Every switch also falls back to the previous behaviour on its own if the new path fails.
   */
  features: Features;
}

export interface Features {
  /** Draw captions with ffmpeg's `ass` filter and complex text shaping (correct Gurmukhi/Devanagari vowel signs). */
  shapedCaptions: boolean;
  /** Reuse a link's details (from link_info or an earlier download) for this many minutes instead of reading the page again. 0 = off. */
  linkInfoCacheMinutes: number;
  /** For start/end downloads of a video whose full copy is already in the project, cut the part locally instead of downloading it. */
  localSectionCut: boolean;
  /** Let job_cancel stop a job that another Talk-n-Edit server process (Claude Desktop vs Claude Code) is running. */
  crossProcessCancel: boolean;
  /** Reuse drawn graphics across renders (cache/graphics). false = draw into each render's folder as before. */
  graphicsCache: boolean;
  /** Renders add a note when the graphics cache is bigger than this many GB (0 = never). Nothing is removed automatically. */
  graphicsCacheWarnGB: number;
}

/** Folders people keep videos in. Windows calls Movies "Videos", and OneDrive may hold Desktop and Documents. */
function defaultImportRoots(): string[] {
  const roots = ["Downloads", IS_WIN ? "Videos" : "Movies", "Desktop", "Documents", "Developer"].map((d) => path.join(HOME, d));
  if (IS_WIN && process.env.OneDrive) for (const d of ["Desktop", "Documents", "Videos"]) roots.push(path.join(process.env.OneDrive, d));
  return roots;
}

/**
 * Speech model. Apple Silicon runs large-v3-turbo fast with MLX; elsewhere it runs on the CPU, where
 * "small" is a good balance and "base" keeps older computers (under 6 GB of memory) responsive.
 */
function defaultWhisperModel(): string {
  if (process.platform === "darwin" && process.arch === "arm64") return "large-v3-turbo";
  return os.totalmem() < 6 * 1024 ** 3 ? "base" : "small";
}

const DEFAULTS: Config = {
  importRoots: defaultImportRoots(),
  exportDir: path.join(MEDIA_DIR, "Clips"),
  inboxDir: INBOX_DIR,
  transcriptionBackend: "auto",
  whisperModel: defaultWhisperModel(),
  limits: { maxImportGB: 20, maxOutputMinutes: 15 },
  defaultBrandKit: "default",
  features: { shapedCaptions: true, linkInfoCacheMinutes: 60, localSectionCut: true, crossProcessCancel: true, graphicsCache: true, graphicsCacheWarnGB: 20 },
};

let cached: Config | null = null;

export function configPath(): string {
  return path.join(WORKSPACE, "config.json");
}

export function getConfig(): Config {
  if (cached) return cached;
  fs.mkdirSync(WORKSPACE, { recursive: true });
  const p = configPath();
  let user: Partial<Config> = {};
  if (fs.existsSync(p)) {
    try {
      user = JSON.parse(fs.readFileSync(p, "utf8"));
    } catch (e) {
      throw new Error(`config.json is not valid JSON (${p}): ${(e as Error).message}`);
    }
  } else {
    fs.writeFileSync(p, JSON.stringify(DEFAULTS, null, 2));
  }
  const cfg: Config = {
    ...DEFAULTS,
    ...user,
    limits: { ...DEFAULTS.limits, ...(user.limits ?? {}) },
    features: { ...DEFAULTS.features, ...(user.features && typeof user.features === "object" ? user.features : {}) },
  };
  cfg.importRoots = cfg.importRoots.map((r) => path.resolve(expandHome(r)));
  cfg.exportDir = path.resolve(expandHome(cfg.exportDir));
  cfg.inboxDir = path.resolve(expandHome(cfg.inboxDir));
  // Downloads land in the Inbox, so it must always be importable.
  if (!cfg.importRoots.some((r) => isInside(cfg.inboxDir, r))) cfg.importRoots.push(cfg.inboxDir);
  cached = cfg;
  return cfg;
}

/** Find a binary even when launched by Claude Desktop with a minimal PATH. */
export function findBinary(name: string, override?: string): string {
  if (override && fs.existsSync(override)) return override;
  const pathDirs = (process.env.PATH ?? process.env.Path ?? "").split(path.delimiter).map((d) => d.replace(/^"(.*)"$/, "$1")).filter(Boolean);
  const candidates = IS_WIN
    ? [...pathDirs, ...windowsProgramDirs()].map((d) => path.join(d, `${name}.exe`))
    : [`/opt/homebrew/bin/${name}`, `/usr/local/bin/${name}`, `/usr/bin/${name}`, ...pathDirs.map((d) => path.join(d, name))];
  for (const c of candidates) {
    try {
      fs.accessSync(c, IS_WIN ? fs.constants.F_OK : fs.constants.X_OK);
      if (fs.statSync(c).isFile()) return c;
    } catch {
      /* next */
    }
  }
  return name;
}

/**
 * Homebrew's regular ffmpeg (8.1+) no longer includes libass, which captions need.
 * Its "ffmpeg-full" formula does, but is keg-only (not on PATH), so look there first.
 */
const FFMPEG_FULL_DIRS = ["/opt/homebrew/opt/ffmpeg-full/bin", "/usr/local/opt/ffmpeg-full/bin"];
function fullBinary(name: string): string | undefined {
  for (const d of FFMPEG_FULL_DIRS) {
    const c = path.join(d, name);
    try {
      fs.accessSync(c, fs.constants.X_OK);
      return c;
    } catch {
      /* next */
    }
  }
  return undefined;
}

export function ffmpegBin(): string {
  const o = getConfig().ffmpeg;
  if (o && fs.existsSync(o)) return o;
  return fullBinary("ffmpeg") ?? findBinary("ffmpeg");
}
export function ffprobeBin(): string {
  const o = getConfig().ffprobe;
  if (o && fs.existsSync(o)) return o;
  return fullBinary("ffprobe") ?? findBinary("ffprobe");
}
export function pythonBin(): string {
  const cfg = getConfig();
  if (cfg.python && fs.existsSync(cfg.python)) return cfg.python;
  return IS_WIN ? path.join(PYTHON_DIR, ".venv", "Scripts", "python.exe") : path.join(PYTHON_DIR, ".venv", "bin", "python");
}

export const dirs = {
  projects: () => path.join(WORKSPACE, "projects"),
  project: (prj: string) => path.join(WORKSPACE, "projects", prj),
  source: (prj: string, ast: string) => path.join(WORKSPACE, "projects", prj, "sources", ast),
  analysis: (prj: string, ast: string) => path.join(WORKSPACE, "projects", prj, "analysis", ast),
  timelines: (prj: string) => path.join(WORKSPACE, "projects", prj, "timelines"),
  render: (prj: string, rnd: string) => path.join(WORKSPACE, "projects", prj, "renders", rnd),
  tmp: () => path.join(WORKSPACE, "tmp"),
};
