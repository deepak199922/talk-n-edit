import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { APP_ROOT, getConfig, LIBRARY, WORKSPACE } from "./config.js";
import { StudioError } from "./errors.js";
import { ffmpeg } from "./ffmpeg.js";
import { FxMeta, fxDir, fxMeta, GRAPHICS } from "./graphics.js";
import type { BrandKit } from "./catalog.js";

const REMOTION_SRC = path.join(APP_ROOT, "remotion");
const cacheDir = () => path.join(WORKSPACE, "cache", "remotion");

/** The headless Chrome that setup downloaded into node_modules/.remotion (macOS/Windows). */
function bundledChrome(): string | null {
  const base = path.join(APP_ROOT, "node_modules", ".remotion", "chrome-headless-shell");
  try {
    for (const plat of fs.readdirSync(base)) {
      const dir = path.join(base, plat);
      for (const sub of fs.readdirSync(dir)) {
        for (const exe of ["chrome-headless-shell", "chrome-headless-shell.exe"]) {
          const p = path.join(dir, sub, exe);
          if (fs.existsSync(p)) return p;
        }
      }
    }
  } catch {
    /* not downloaded */
  }
  return null;
}

function browserExecutable(): string | null {
  // Remotion looks for its browser relative to the working folder; Claude Desktop starts us in "/".
  if (process.cwd() !== APP_ROOT) {
    try {
      process.chdir(APP_ROOT);
    } catch {
      /* keep going with explicit paths */
    }
  }
  const cfg = getConfig() as any;
  if (cfg.chrome && fs.existsSync(cfg.chrome)) return cfg.chrome;
  if (process.env.VS_CHROME && fs.existsSync(process.env.VS_CHROME)) return process.env.VS_CHROME;
  const bundled = bundledChrome();
  if (bundled) return bundled;
  if (process.platform === "linux") for (const p of ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"]) if (fs.existsSync(p)) return p;
  return null;
}

function fileHash(files: string[]): string {
  const h = crypto.createHash("sha1");
  for (const f of files) {
    h.update(f);
    h.update(fs.readFileSync(f));
  }
  return h.digest("hex").slice(0, 16);
}

const bundles = new Map<string, Promise<string>>();

/** Bundle the built-in graphics plus the named custom effects. Cached on disk by content hash. */
export async function ensureBundle(fxNames: string[] = [], overrides: Record<string, string> = {}): Promise<string> {
  const fx = [...new Set(fxNames)].sort();
  const srcFiles = ["Root.tsx", "shared.tsx", "components.tsx"].map((f) => path.join(REMOTION_SRC, f));
  const fxPath = (n: string) => overrides[n] ?? path.join(fxDir(), `${n}.tsx`);
  const fxFiles = fx.map((n) => {
    const f = fxPath(n);
    if (!fs.existsSync(f)) throw new StudioError("INVALID_INPUT", `Custom effect "${n}" not found`, "Create it with fx_create.");
    return f;
  });
  const hash = fileHash([...srcFiles, ...fxFiles]);
  const cached = bundles.get(hash);
  if (cached) return cached;
  const p = (async () => {
    const outDir = path.join(cacheDir(), `bundle-${hash}`);
    if (fs.existsSync(path.join(outDir, "index.html"))) return outDir;
    const entryDir = path.join(cacheDir(), `entry-${hash}`);
    fs.mkdirSync(entryDir, { recursive: true });
    // Forward slashes: webpack accepts C:/... on Windows, and backslashes would need escaping.
    const imp = (f: string) => JSON.stringify(f.replace(/\.tsx$/, "").split(path.sep).join("/"));
    const lines = [
      `import { registerRoot } from "remotion";`,
      `import { makeRoot } from ${imp(path.join(REMOTION_SRC, "Root.tsx"))};`,
      `import * as Builtins from ${imp(path.join(REMOTION_SRC, "components.tsx"))};`,
      ...fx.map((n, i) => `import Fx${i} from ${imp(fxPath(n))};`),
      `registerRoot(makeRoot({ ...(Builtins as any), ${fx.map((n, i) => `${JSON.stringify(`fx:${n}`)}: Fx${i}`).join(", ")} }));`,
    ];
    const entry = path.join(entryDir, "index.tsx");
    fs.writeFileSync(entry, lines.join("\n") + "\n");
    const { bundle } = await import("@remotion/bundler");
    const nm = path.join(APP_ROOT, "node_modules");
    await bundle({
      entryPoint: entry,
      outDir,
      publicDir: LIBRARY,
      rootDir: APP_ROOT,
      enableCaching: true,
      webpackOverride: (c: any) => ({
        ...c,
        resolve: { ...(c.resolve ?? {}), modules: [nm, ...((c.resolve?.modules as string[]) ?? ["node_modules"])] },
        resolveLoader: { ...(c.resolveLoader ?? {}), modules: [nm, ...((c.resolveLoader?.modules as string[]) ?? ["node_modules"])] },
      }),
    } as any);
    return outDir;
  })();
  bundles.set(hash, p);
  p.catch(() => bundles.delete(hash));
  return p;
}

export interface GraphicSpec {
  component: string;
  props: Record<string, any>;
  width: number;
  height: number;
  fps: number;
  frames: number;
  brand: BrandKit;
}

function inputProps(spec: GraphicSpec) {
  return {
    component: spec.component,
    props: spec.props,
    brand: { colors: spec.brand.colors, fonts: { heading: spec.brand.fonts.heading, body: spec.brand.fonts.body } },
    width: spec.width,
    height: spec.height,
    fps: spec.fps,
    frames: spec.frames,
  };
}

function cleanError(e: unknown): string {
  const m = (e as Error)?.message ?? String(e);
  return m.split("\n").filter((l) => l.trim() && !/^\s+at /.test(l)).slice(0, 12).join("\n");
}

/** Render a graphic to a transparent PNG sequence; returns the printf pattern of the frame files. */
export async function renderGraphic(spec: GraphicSpec, outDir: string, signal?: AbortSignal, onProgress?: (f: number) => void) {
  const fx = spec.component.startsWith("fx:") ? [spec.component.slice(3)] : [];
  if (!fx.length && !(spec.component in GRAPHICS)) throw new StudioError("INVALID_INPUT", `Unknown graphic ${spec.component}`);
  const serveUrl = await ensureBundle(fx);
  const { selectComposition, renderFrames, makeCancelSignal } = await import("@remotion/renderer");
  const cancel = makeCancelSignal();
  signal?.addEventListener("abort", () => cancel.cancel());
  fs.mkdirSync(outDir, { recursive: true });
  const props = inputProps(spec);
  try {
    const composition = await selectComposition({ serveUrl, id: "Graphic", inputProps: props, browserExecutable: browserExecutable(), logLevel: "error" } as any);
    await renderFrames({
      composition,
      serveUrl,
      inputProps: props,
      outputDir: outDir,
      imageFormat: "png",
      browserExecutable: browserExecutable(),
      cancelSignal: cancel.cancelSignal,
      logLevel: "error",
      onStart: () => undefined,
      onFrameUpdate: (n: number) => onProgress?.(n / spec.frames),
    } as any);
  } catch (e) {
    if (signal?.aborted) throw new StudioError("CANCELLED", "Cancelled");
    throw new StudioError("ENGINE_FAILED", `Rendering ${spec.component} failed`, cleanError(e));
  }
  const files = fs.readdirSync(outDir).filter((f) => f.endsWith(".png")).sort();
  if (!files.length) throw new StudioError("ENGINE_FAILED", `Rendering ${spec.component} produced no frames`);
  const m = /^(.*?)(\d+)\.png$/.exec(files[0]);
  if (!m) throw new StudioError("ENGINE_FAILED", `Unexpected frame name ${files[0]}`);
  return { pattern: `${m[1]}%0${m[2].length}d.png`, frames: files.length };
}

// ------------------------------------------------------------------ custom effects

const ALLOWED_IMPORT = /^\s*import\s+(?:type\s+)?[\s\S]*?\s+from\s+["'](react|remotion)["'];?\s*$/;
const FORBIDDEN = [
  /\brequire\s*\(/, /\bprocess\./, /child_process/, /\bfetch\s*\(/, /XMLHttpRequest/, /WebSocket/, /\beval\s*\(/, /new\s+Function\s*\(/,
  /\bimport\s*\(/, /localStorage/, /sessionStorage/, /document\.cookie/, /sendBeacon/, /\bnavigator\./, /window\.open/, /importScripts/, /\bWorker\s*\(/,
  // Bundler escape hatches: require.context(...), import.meta and new URL("file", import.meta.url) can pull
  // files from disk into the bundle; bracket access to globals can rebuild any of the names above.
  /\brequire\b/, /import\.meta/, /__webpack/, /\bnew\s+URL\s*\(/, /\bglobalThis\b/, /\bwindow\s*\[/, /\bself\s*\[/, /\bfetch\b/,
];

export function checkFxCode(code: string): string[] {
  const problems: string[] = [];
  if (code.length > 60_000) problems.push("Code is too long (max 60 KB).");
  const statements = code.match(/^\s*import[\s\S]*?;?\s*$/gm) ?? [];
  for (const line of code.split("\n")) {
    if (/^\s*import\b/.test(line) && !/from\s+["']/.test(line) && !/^\s*import\s+["']/.test(line)) continue; // multi-line import start
    if (/^\s*import\b/.test(line) && !ALLOWED_IMPORT.test(line)) problems.push(`Only imports from "react" and "remotion" are allowed: ${line.trim()}`);
  }
  if (!statements.length && !/export\s+default/.test(code)) problems.push("Missing default export.");
  if (!/export\s+default\s/.test(code)) problems.push("The component must be the default export: export default function MyFx(props) {...}");
  for (const re of FORBIDDEN) if (re.test(code)) problems.push(`Not allowed in effects: ${re.source.replace(/\\b|\\s\*|\\/g, "")}`);
  return problems;
}

export interface FxCreateInput {
  name: string;
  code: string;
  description: string;
  defaultProps?: Record<string, unknown>;
  defaultDuration?: number;
  preview?: { aspect?: "9:16" | "16:9" | "1:1" | "4:5"; background?: string; duration?: number; props?: Record<string, unknown> };
}

function fxSize(aspect: string) {
  return aspect === "16:9" ? { width: 960, height: 540 } : aspect === "1:1" ? { width: 720, height: 720 } : aspect === "4:5" ? { width: 720, height: 900 } : { width: 540, height: 960 };
}

/** Save a custom effect, bundle it, and render a 4-frame preview over a background. Errors come back for fixing. */
export async function fxCreate(input: FxCreateInput, brand: BrandKit, backgroundImage?: string) {
  if (!/^[a-z][a-z0-9-]{1,40}$/.test(input.name)) throw new StudioError("INVALID_INPUT", "name must be lowercase letters, digits and hyphens (2–41 chars)", undefined, "name");
  const problems = checkFxCode(input.code);
  if (problems.length) return { ok: false, stage: "check", problems };
  // Work on a draft: a working effect with the same name is only replaced once the new code builds and renders.
  const draftDir = path.join(fxDir(), "drafts");
  fs.mkdirSync(draftDir, { recursive: true });
  const draft = path.join(draftDir, `${input.name}.tsx`);
  const prev = fxMeta(input.name);
  fs.writeFileSync(draft, input.code);
  const meta: FxMeta = {
    name: input.name,
    description: input.description,
    defaultDuration: input.defaultDuration ?? 2.5,
    defaultProps: input.defaultProps ?? {},
    created: prev?.created ?? new Date().toISOString(),
    updated: new Date().toISOString(),
    approved: false,
  };
  const ov = { [input.name]: draft };
  try {
    await ensureBundle([input.name], ov);
  } catch (e) {
    return { ok: false, stage: "build", problems: [cleanError(e)], kept: prev ? `The previous working version of ${input.name} is unchanged.` : undefined };
  }
  // Preview: 4 stills composited over the background, tiled 2x2.
  const aspect = input.preview?.aspect ?? "9:16";
  const { width, height } = fxSize(aspect);
  const fps = 30;
  const frames = Math.max(2, Math.round((input.preview?.duration ?? meta.defaultDuration) * fps));
  const pdir = path.join(fxDir(), "previews", `${input.name}-${Date.now()}`);
  fs.mkdirSync(pdir, { recursive: true });
  const spec: GraphicSpec = { component: `fx:${input.name}`, props: { ...meta.defaultProps, ...(input.preview?.props ?? {}) }, width, height, fps, frames, brand };
  try {
    const serveUrl = await ensureBundle([input.name], ov);
    const { selectComposition, renderStill } = await import("@remotion/renderer");
    const props = inputProps(spec);
    const composition = await selectComposition({ serveUrl, id: "Graphic", inputProps: props, browserExecutable: browserExecutable(), logLevel: "error" } as any);
    const at = [0.1, 0.35, 0.65, 0.92].map((f) => Math.min(frames - 1, Math.round(f * frames)));
    for (let i = 0; i < at.length; i++) {
      await renderStill({ composition, serveUrl, inputProps: props, output: path.join(pdir, `s${i}.png`), frame: at[i], imageFormat: "png", browserExecutable: browserExecutable(), logLevel: "error" } as any);
    }
  } catch (e) {
    return { ok: false, stage: "render", problems: [cleanError(e)], kept: prev ? `The previous working version of ${input.name} is unchanged.` : undefined };
  }
  // Works: publish the draft.
  fs.copyFileSync(draft, path.join(fxDir(), `${input.name}.tsx`));
  fs.writeFileSync(path.join(fxDir(), `${input.name}.json`), JSON.stringify(meta, null, 2));
  const bg = backgroundImage
    ? ["-i", backgroundImage]
    : ["-f", "lavfi", "-i", `color=c=0x2b2b36:s=${width}x${height}:d=1`];
  for (let i = 0; i < 4; i++) {
    await ffmpeg(
      [...bg, "-i", path.join(pdir, `s${i}.png`), "-filter_complex", `[0:v]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height}[b];[b][1:v]overlay=0:0`, "-frames:v", "1", path.join(pdir, `c${i}.png`)],
      { label: "ffmpeg fx preview" },
    );
  }
  const sheet = path.join(pdir, "preview.jpg");
  await ffmpeg(["-framerate", "1", "-i", path.join(pdir, "c%d.png"), "-vf", "tile=4x1:padding=6:color=white", "-frames:v", "1", "-q:v", "3", sheet], { label: "ffmpeg fx sheet" });
  return { ok: true, name: `fx:${input.name}`, preview: sheet, previewTimes: ["10%", "35%", "65%", "92%"], meta };
}
