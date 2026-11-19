import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
}

const DEFAULTS: Config = {
  importRoots: [
    path.join(HOME, "Downloads"),
    path.join(HOME, "Movies"),
    path.join(HOME, "Desktop"),
    path.join(HOME, "Documents"),
    path.join(HOME, "Developer"),
  ],
  exportDir: path.join(MEDIA_DIR, "Clips"),
  transcriptionBackend: "auto",
  // Apple Silicon runs large-v3-turbo fast with MLX; elsewhere (CPU) default to small.
  whisperModel: process.platform === "darwin" && process.arch === "arm64" ? "large-v3-turbo" : "small",
  limits: { maxImportGB: 20, maxOutputMinutes: 15 },
  defaultBrandKit: "default",
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
  const cfg: Config = { ...DEFAULTS, ...user, limits: { ...DEFAULTS.limits, ...(user.limits ?? {}) } };
  cfg.importRoots = cfg.importRoots.map((r) => path.resolve(r.replace(/^~(?=$|\/)/, HOME)));
  cfg.exportDir = path.resolve(cfg.exportDir.replace(/^~(?=$|\/)/, HOME));
  cached = cfg;
  return cfg;
}

/** Find a binary even when launched by Claude Desktop with a minimal PATH. */
export function findBinary(name: string, override?: string): string {
  if (override && fs.existsSync(override)) return override;
  const candidates = [
    `/opt/homebrew/bin/${name}`,
    `/usr/local/bin/${name}`,
    `/usr/bin/${name}`,
    ...(process.env.PATH ?? "").split(path.delimiter).map((d) => path.join(d, name)),
  ];
  for (const c of candidates) {
    try {
      fs.accessSync(c, fs.constants.X_OK);
      return c;
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
  return path.join(PYTHON_DIR, ".venv", "bin", "python");
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
