import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { LIBRARY, WORKSPACE } from "./config.js";
import { StudioError } from "./errors.js";
import { slug } from "./ids.js";
import { CaptionsSchema, LookSchema, TRANSITIONS } from "./schema/timeline.js";

/** An edit style = reusable defaults applied to any timeline that names it. Timeline values always win. */
export const StyleSchema = z
  .object({
    name: z.string().min(1).max(60),
    description: z.string().max(400).default(""),
    brandKit: z.string().optional(),
    look: LookSchema.optional(),
    transition: z.object({ type: z.enum(TRANSITIONS), duration: z.number().min(0.05).max(2).default(0.4) }).optional(),
    autoPunch: z.object({ scale: z.number().min(1.02).max(1.6).default(1.12), every: z.enum(["cut", "sentence"]).default("cut") }).optional(),
    captions: CaptionsSchema.partial().optional(),
    sfxOnTransitions: z.string().optional(),
    hook: z.object({ style: z.enum(["boxed", "bold"]).default("boxed"), position: z.enum(["top", "center"]).default("top") }).optional(),
    removeSilences: z.object({ minGap: z.number().min(0.15).max(5).default(0.6), keepPad: z.number().min(0).max(0.5).default(0.12) }).optional(),
    music: z.object({ volume: z.number().min(0).max(2).default(0.3) }).optional(),
    notes: z.string().max(1000).optional().describe("Free-text guidance for Claude (pacing, tone, what to emphasise)"),
  })
  .strict();
export type Style = z.infer<typeof StyleSchema>;

const userDir = () => path.join(WORKSPACE, "styles");
const builtinDir = () => path.join(LIBRARY, "styles");

export function listStyles(): Array<Style & { id: string; builtIn: boolean }> {
  const out: Array<Style & { id: string; builtIn: boolean }> = [];
  for (const [dir, builtIn] of [
    [builtinDir(), true],
    [userDir(), false],
  ] as const) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".json"))) {
      try {
        const s = StyleSchema.parse(JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")));
        const id = path.basename(f, ".json");
        const i = out.findIndex((x) => x.id === id);
        if (i >= 0) out.splice(i, 1); // user style overrides a built-in with the same id
        out.push({ ...s, id, builtIn });
      } catch {
        /* skip invalid */
      }
    }
  }
  return out;
}

export function getStyle(id: string): Style {
  const s = listStyles().find((x) => x.id === id || x.name.toLowerCase() === id.toLowerCase());
  if (!s) throw new StudioError("INVALID_INPUT", `Unknown style "${id}"`, `Available: ${listStyles().map((x) => x.id).join(", ")}`, "style");
  return s;
}

export function saveStyle(style: unknown) {
  const s = StyleSchema.parse(style);
  fs.mkdirSync(userDir(), { recursive: true });
  const id = slug(s.name, 40);
  const file = path.join(userDir(), `${id}.json`);
  fs.writeFileSync(file, JSON.stringify(s, null, 2));
  return { id, file, style: s };
}

/** Merge a style's defaults into a raw timeline object (before validation). */
export function applyStyle(raw: any, hasTranscripts: (clipAssetIds: string[]) => boolean): { timeline: any; notes: string[] } {
  if (!raw || typeof raw !== "object" || !raw.style) return { timeline: raw, notes: [] };
  const st = getStyle(String(raw.style));
  const tl = { ...raw };
  const notes: string[] = [];
  if (st.brandKit && tl.brandKit === undefined) tl.brandKit = st.brandKit;
  if (st.look) tl.look = { ...st.look, ...(tl.look ?? {}) };
  if (st.transition && tl.transition === undefined) tl.transition = st.transition;
  if (st.autoPunch && tl.autoPunch === undefined) tl.autoPunch = st.autoPunch;
  if (st.sfxOnTransitions && tl.sfxOnTransitions === undefined) tl.sfxOnTransitions = st.sfxOnTransitions;
  if (st.captions) {
    if (tl.captions) tl.captions = { ...st.captions, ...tl.captions };
    else {
      const ids = (Array.isArray(tl.clips) ? tl.clips : []).map((c: any) => c?.assetId).filter(Boolean);
      if (hasTranscripts(ids)) tl.captions = { ...st.captions };
      else notes.push(`Style "${st.name}" has captions, but not every clip has a transcript; captions skipped.`);
    }
  }
  if (st.removeSilences && Array.isArray(tl.clips)) {
    tl.clips = tl.clips.map((c: any) => (c && c.removeSilences === undefined && c.duration === undefined ? { ...c, removeSilences: st.removeSilences } : c));
  }
  if (st.hook && Array.isArray(tl.overlays)) {
    tl.overlays = tl.overlays.map((o: any) => (o?.component === "HookText" ? { ...o, props: { ...st.hook, ...(o.props ?? {}) } } : o));
  }
  if (st.music && Array.isArray(tl.audio)) {
    tl.audio = tl.audio.map((a: any) => (a?.role === "music" && a.volume === undefined ? { ...a, volume: st.music!.volume } : a));
  }
  return { timeline: tl, notes };
}
