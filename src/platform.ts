import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Things that differ between macOS, Windows and Linux, in one place. */
export const IS_WIN = process.platform === "win32";
export const IS_MAC = process.platform === "darwin";

/** What to tell people when a dependency is missing: the setup script for their system. */
export function setupHint(): string {
  if (IS_WIN) return 'Run the setup again (in PowerShell, in the Talk-n-Edit folder: powershell -ExecutionPolicy Bypass -File scripts\\setup_windows.ps1), then restart Claude.';
  if (IS_MAC) return "Run the setup again (in Terminal, in the Talk-n-Edit folder: bash scripts/setup_mac.sh), then restart Claude.";
  return "Install ffmpeg (with libass), Node 22+ and uv, then follow the Linux steps in docs/REFERENCE.md.";
}

export function ffmpegInstallHint(): string {
  if (IS_WIN) return "Install it with: winget install Gyan.FFmpeg (or run the Windows setup script), then restart Claude.";
  if (IS_MAC) return "Install it with: brew install ffmpeg-full, then restart Claude.";
  return "Install your distribution's ffmpeg package (it must include libass for captions).";
}

/** Expand a leading ~ (followed by / or \ on Windows) to the home folder. */
export function expandHome(p: string): string {
  return p.replace(IS_WIN ? /^~(?=$|[\\/])/ : /^~(?=$|\/)/, os.homedir());
}

/** True when child is the parent folder or inside it (case-insensitive on Windows, via path.relative). */
export function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * Link a folder into another folder (fonts and LUTs into a render folder, so ffmpeg filters can use
 * short relative paths). Windows uses a directory junction, which needs no admin rights.
 */
export function linkDir(target: string, link: string): void {
  if (fs.existsSync(link)) return;
  try {
    fs.symlinkSync(target, link, IS_WIN ? "junction" : "dir");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return;
    // Last resort (e.g. a file system without links): copy the folder.
    fs.cpSync(target, link, { recursive: true });
  }
}

/** Folders on Windows where winget, Scoop and Chocolatey put programs such as ffmpeg.exe. */
export function windowsProgramDirs(): string[] {
  if (!IS_WIN) return [];
  const local = process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local");
  const dirs = [
    path.join(local, "Microsoft", "WinGet", "Links"),
    path.join(os.homedir(), "scoop", "shims"),
    path.join(process.env.ProgramData ?? "C:\\ProgramData", "chocolatey", "bin"),
    path.join(process.env.ProgramFiles ?? "C:\\Program Files", "ffmpeg", "bin"),
    "C:\\ffmpeg\\bin",
  ];
  // winget's Gyan.FFmpeg package also lives here when its Links shim is missing.
  const pkgs = path.join(local, "Microsoft", "WinGet", "Packages");
  try {
    for (const p of fs.readdirSync(pkgs)) {
      if (!/^Gyan\.FFmpeg/i.test(p)) continue;
      for (const sub of fs.readdirSync(path.join(pkgs, p))) dirs.push(path.join(pkgs, p, sub, "bin"));
    }
  } catch {
    /* winget not used */
  }
  return dirs;
}

/** Environment for child processes: Python always speaks UTF-8 (Windows defaults to the old code page). */
export function childEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8", HF_HUB_DISABLE_SYMLINKS_WARNING: "1", ...extra };
}
