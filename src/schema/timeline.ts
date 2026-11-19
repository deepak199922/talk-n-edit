import { z } from "zod";

const Seconds = z.number().min(0);
const Unit = z.number().min(0).max(1);

export const AnchorSchema = z.union([
  z.object({ at: Seconds }).strict(),
  z.object({ clip: z.string(), sourceTime: Seconds }).strict(),
]);

export const ReframeSchema = z.discriminatedUnion("mode", [
  z
    .object({
      mode: z.literal("fit"),
      background: z.enum(["blur", "black"]).default("blur").describe("What fills the space around the frame"),
      trim: z
        .object({ top: z.number().min(0).max(0.4).default(0), bottom: z.number().min(0).max(0.4).default(0), left: z.number().min(0).max(0.4).default(0), right: z.number().min(0).max(0.4).default(0) })
        .strict()
        .optional()
        .describe("Cut built-in black bars first, as fractions of the source (e.g. letterboxed trailers: top/bottom 0.13)"),
    })
    .strict()
    .describe("Whole frame, centred; blurred copy (or black) fills the rest"),
  z.object({ mode: z.literal("fill-center") }),
  z.object({ mode: z.literal("auto-face") }).describe("Crop follows the dominant face, fixed per shot"),
  z.object({ mode: z.literal("split"), layout: z.literal("top-bottom").default("top-bottom") }),
  z.object({ mode: z.literal("manual"), x: Unit, y: Unit.default(0.5), zoom: z.number().min(1).max(4).default(1) }),
]);

/** Transition names (mapped to ffmpeg xfade). */
export const TRANSITIONS = [
  "cut", "crossfade", "fade-black", "fade-white", "dissolve",
  "slide-left", "slide-right", "slide-up", "slide-down",
  "wipe-left", "wipe-right", "wipe-up", "wipe-down",
  "whip-left", "whip-right", "zoom-in", "circle-open", "circle-close",
  "pixelize", "radial", "blur", "squeeze",
] as const;

export const LOOK_PRESETS = [
  "none", "vivid", "warm", "cool", "cinematic", "teal-orange", "bw", "noir", "vintage", "matte", "moody", "bright", "sepia", "punchy",
] as const;

export const LookSchema = z
  .object({
    preset: z.enum(LOOK_PRESETS).default("none"),
    brightness: z.number().min(-0.5).max(0.5).optional().describe("-0.5..0.5, 0 = unchanged"),
    contrast: z.number().min(0.5).max(2).optional().describe("1 = unchanged"),
    saturation: z.number().min(0).max(3).optional().describe("1 = unchanged, 0 = black & white"),
    gamma: z.number().min(0.5).max(2).optional(),
    warmth: z.number().min(-1).max(1).optional().describe("-1 cool .. +1 warm"),
    vignette: z.number().min(0).max(1).optional(),
    grain: z.number().min(0).max(1).optional(),
    sharpen: z.number().min(0).max(1).optional(),
    blur: z.number().min(0).max(1).optional(),
    lut: z.string().optional().describe("File name of a .cube LUT in library/luts"),
  })
  .strict();

export const ClipSchema = z
  .object({
    id: z.string().min(1).max(40),
    assetId: z.string(),
    in: Seconds.optional(),
    out: Seconds.optional(),
    sentences: z.object({ from: z.string(), to: z.string() }).optional().describe("Pick by transcript sentence ids instead of in/out"),
    duration: z.number().positive().max(60).optional().describe("Images only: seconds on screen"),
    snap: z.enum(["word", "frame"]).optional(),
    speed: z.number().min(0.25).max(4).default(1),
    speedRamp: z
      .array(z.object({ at: Seconds.describe("source time"), speed: z.number().min(0.25).max(4) }).strict())
      .max(10)
      .optional()
      .describe("From each source time on, play at that speed (overrides speed)"),
    removeSilences: z
      .object({ minGap: z.number().min(0.15).max(5).default(0.6), keepPad: z.number().min(0).max(0.5).default(0.12) })
      .optional(),
    reframe: ReframeSchema.optional(),
    motion: z
      .object({ type: z.enum(["kenburns-in", "kenburns-out", "punch-in"]), strength: z.number().min(0).max(1).default(0.5) })
      .optional(),
    transitionIn: z.object({ type: z.enum(TRANSITIONS), duration: z.number().min(0.05).max(2).default(0.4) }).optional(),
    freezes: z
      .array(z.object({ at: Seconds.describe("source time"), duration: z.number().min(0.1).max(10), flash: z.boolean().default(false) }).strict())
      .max(10)
      .optional(),
    reverse: z.boolean().optional().describe("Play backwards (clips up to 20 s)"),
    stabilize: z.boolean().optional(),
    look: LookSchema.optional().describe("Overrides the timeline look for this clip"),
    audio: z
      .object({ denoise: z.boolean().default(false), enhance: z.boolean().default(false), mute: z.boolean().default(false) })
      .strict()
      .optional(),
    volume: z.number().min(0).max(2).default(1),
  })
  .strict();

export const ZoomSchema = z
  .object({
    start: AnchorSchema,
    duration: z.number().min(0.1).max(60),
    scale: z.number().min(1).max(4).default(1.25),
    x: Unit.default(0.5).describe("focus point across the output frame"),
    y: Unit.default(0.42).describe("focus point down the output frame"),
    ease: z.enum(["smooth", "snap", "linear"]).default("smooth"),
    ramp: z.number().min(0).max(2).default(0.35).describe("seconds to zoom in and out"),
  })
  .strict();

export const OverlaySchema = z
  .object({
    id: z.string().min(1).max(40),
    component: z.string(),
    start: AnchorSchema,
    duration: z.number().positive().max(600),
    props: z.record(z.string(), z.unknown()).default({}),
    layer: z.number().int().min(0).max(9).default(1),
  })
  .strict();

const Rect = z.object({ x: Unit, y: Unit, w: z.number().min(0.01).max(1), h: z.number().min(0.01).max(1) }).strict();

export const MaskSchema = z
  .object({
    id: z.string().min(1).max(40),
    start: AnchorSchema,
    duration: z.number().positive().max(600),
    rect: Rect.describe("Region of the output frame, 0..1"),
    type: z.enum(["blur", "pixelate", "box"]).default("blur"),
    color: z.string().default("#000000"),
    strength: z.number().min(0).max(1).default(0.7),
  })
  .strict();

export const LayerSchema = z
  .object({
    id: z.string().min(1).max(40),
    assetId: z.string().describe("video or image asset"),
    in: Seconds.default(0).describe("source start (video)"),
    start: AnchorSchema,
    duration: z.number().positive().max(600),
    mode: z.enum(["full", "pip"]).default("pip").describe("full = B-roll cutaway over the main video; pip = picture-in-picture"),
    rect: z
      .object({ x: Unit, y: Unit, w: z.number().min(0.05).max(1) })
      .strict()
      .default({ x: 0.62, y: 0.06, w: 0.33 })
      .describe("pip position (top-left corner) and width, 0..1 of the output frame"),
    fit: z.enum(["fill", "fit"]).default("fill"),
    border: z.number().min(0).max(40).default(6),
    borderColor: z.string().default("#FFFFFF"),
    look: LookSchema.optional(),
    volume: z.number().min(0).max(2).default(0),
    speed: z.number().min(0.25).max(4).default(1),
  })
  .strict();

export const CaptionsSchema = z
  .object({
    source: z.enum(["transcript", "script", "lines"]).default("transcript"),
    scriptText: z.string().optional(),
    lines: z
      .array(z.object({ start: AnchorSchema, end: AnchorSchema, text: z.string().min(1).max(200) }).strict())
      .max(400)
      .optional()
      .describe('For source "lines": your own caption text per time range (Hinglish, translations, corrected spelling). Words follow the speech inside each range.'),
    preset: z.string().default("karaoke-highlight"),
    emphasis: z.union([z.literal("auto"), z.literal("none"), z.array(z.string())]).default("auto"),
    position: z.enum(["auto", "lower", "middle", "upper"]).default("auto"),
    uppercase: z.boolean().optional(),
    maxWordsPerLine: z.number().int().min(1).max(12).optional(),
    size: z.number().min(0.5).max(2).optional().describe("Caption size multiplier (1 = preset size)"),
  })
  .strict();

export const AudioItemSchema = z
  .object({
    id: z.string().min(1).max(40),
    assetId: z.string().optional(),
    library: z.string().optional().describe('Built-in sound, e.g. "sfx/whoosh" (see catalog_list sfx)'),
    role: z.enum(["music", "sfx", "voice"]),
    start: AnchorSchema.default({ at: 0 }),
    in: Seconds.optional(),
    out: Seconds.optional(),
    volume: z.number().min(0).max(2).default(1),
    fadeIn: z.number().min(0).max(10).default(0),
    fadeOut: z.number().min(0).max(10).default(0),
    loop: z.boolean().default(false),
  })
  .strict();

export const TimelineSchema = z
  .object({
    schemaVersion: z.literal(1).default(1),
    projectId: z.string(),
    name: z.string().min(1).max(80),
    style: z.string().optional().describe("Saved edit style to apply as defaults (catalog_list styles)"),
    output: z
      .object({
        aspect: z.enum(["9:16", "16:9", "1:1", "4:5"]).default("9:16"),
        height: z.union([z.literal(1920), z.literal(1350), z.literal(1080), z.literal(720)]).optional(),
        fps: z.union([z.literal(24), z.literal(25), z.literal(30), z.literal(60)]).default(30),
        platform: z.enum(["instagram-reels", "youtube-shorts", "tiktok", "youtube", "generic"]).default("generic"),
      })
      .strict(),
    brandKit: z.string().optional(),
    look: LookSchema.optional().describe("Colour look for every clip"),
    transition: z
      .object({ type: z.enum(TRANSITIONS), duration: z.number().min(0.05).max(2).default(0.4) })
      .optional()
      .describe("Default transition between clips"),
    autoPunch: z
      .object({ scale: z.number().min(1.02).max(1.6).default(1.12), every: z.enum(["cut", "sentence"]).default("cut") })
      .optional()
      .describe("Jump-cut style: alternate between normal and zoomed-in framing"),
    sfxOnTransitions: z.string().optional().describe('Library sound played at every transition, e.g. "sfx/whoosh"'),
    beatSync: z
      .object({ audioId: z.string().describe("id of a music item in audio"), every: z.number().int().min(1).max(8).default(1) })
      .optional()
      .describe("Snap clip cuts to the music's beats"),
    clips: z.array(ClipSchema).min(1).max(200),
    zooms: z.array(ZoomSchema).max(100).default([]),
    overlays: z.array(OverlaySchema).max(50).default([]),
    masks: z.array(MaskSchema).max(20).default([]),
    layers: z.array(LayerSchema).max(20).default([]),
    captions: CaptionsSchema.optional(),
    audio: z.array(AudioItemSchema).max(40).default([]),
    mix: z
      .object({ targetLufs: z.number().min(-30).max(-8).default(-14), duckMusicDb: z.number().min(-30).max(0).default(-12) })
      .strict()
      .default({ targetLufs: -14, duckMusicDb: -12 }),
  })
  .strict();

export type Timeline = z.infer<typeof TimelineSchema>;
export type Clip = z.infer<typeof ClipSchema>;
export type Overlay = z.infer<typeof OverlaySchema>;
export type Anchor = z.infer<typeof AnchorSchema>;
export type AudioItem = z.infer<typeof AudioItemSchema>;
export type Captions = z.infer<typeof CaptionsSchema>;
export type Look = z.infer<typeof LookSchema>;
export type Zoom = z.infer<typeof ZoomSchema>;
export type Mask = z.infer<typeof MaskSchema>;
export type Layer = z.infer<typeof LayerSchema>;
export type TransitionName = (typeof TRANSITIONS)[number];

export function outputSize(o: Timeline["output"]): { width: number; height: number } {
  const [aw, ah] = o.aspect.split(":").map(Number);
  const height = o.height ?? (o.aspect === "16:9" ? 1080 : o.aspect === "4:5" ? 1350 : o.aspect === "1:1" ? 1080 : 1920);
  const width = Math.round((height * aw) / ah / 2) * 2;
  return { width, height };
}
