import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { LIBRARY } from "./config.js";
import { StudioError } from "./errors.js";
import { listLibrary } from "./effects.js";
import { graphicsCatalog } from "./graphics.js";
import { LOOK_PRESETS, TRANSITIONS } from "./schema/timeline.js";
import { listStyles } from "./styles.js";

// ---------------------------------------------------------------- brand kits
export const BrandKitSchema = z.object({
  id: z.string(),
  name: z.string(),
  fonts: z.object({
    heading: z.string(),
    body: z.string(),
    devanagari: z.string().default("Mukta ExtraBold"),
    gurmukhi: z.string().default("Mukta Mahee ExtraBold"),
  }),
  colors: z.object({
    text: z.string().default("#FFFFFF"),
    highlight: z.string().default("#FFD60A"),
    emphasis: z.string().default("#FFD60A"),
    outline: z.string().default("#000000"),
    box: z.string().default("#000000"),
  }),
  captionPreset: z.string().default("karaoke-highlight"),
  handle: z.string().optional(),
});
export type BrandKit = z.infer<typeof BrandKitSchema>;

const DEFAULT_KIT: BrandKit = {
  id: "default",
  name: "Default (white + yellow)",
  fonts: { heading: "Anton", body: "Poppins ExtraBold", devanagari: "Mukta ExtraBold", gurmukhi: "Mukta Mahee ExtraBold" },
  colors: { text: "#FFFFFF", highlight: "#FFD60A", emphasis: "#FFD60A", outline: "#000000", box: "#000000" },
  captionPreset: "karaoke-highlight",
};

export function listBrandKits(): BrandKit[] {
  const dir = path.join(LIBRARY, "brand-kits");
  const kits: BrandKit[] = [DEFAULT_KIT];
  if (fs.existsSync(dir)) {
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".json"))) {
      try {
        const k = BrandKitSchema.parse({ id: path.basename(f, ".json"), ...JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) });
        if (k.id !== "default") kits.push(k);
        else kits[0] = k;
      } catch {
        /* skip invalid kit */
      }
    }
  }
  return kits;
}

export function getBrandKit(id?: string): BrandKit {
  const kits = listBrandKits();
  const k = kits.find((x) => x.id === (id ?? "default"));
  if (!k) throw new StudioError("INVALID_INPUT", `Unknown brand kit "${id}"`, `Available: ${kits.map((x) => x.id).join(", ")}`, "brandKit");
  return k;
}

// ---------------------------------------------------------------- caption presets
export interface CaptionPreset {
  id: string;
  description: string;
  /** Font size as a fraction of the shorter output side. */
  size: number;
  maxWordsPerLine: number;
  maxLines: number;
  uppercase: boolean;
  /** Highlight the word being spoken. */
  highlightCurrent: boolean;
  pop: boolean;
  boxed: boolean;
  outline: number; // px at 1080 short side
  shadow: number;
  bestFor: string;
}

export const CAPTION_PRESETS: CaptionPreset[] = [
  {
    id: "karaoke-highlight",
    description: "Two short lines; the word being spoken turns the highlight colour.",
    size: 0.08, maxWordsPerLine: 3, maxLines: 2, uppercase: false, highlightCurrent: true, pop: false, boxed: false,
    outline: 5, shadow: 2, bestFor: "Reels and Shorts from talking-head or podcast footage",
  },
  {
    id: "word-pop",
    description: "One to three words at a time, uppercase, each group pops in.",
    size: 0.095, maxWordsPerLine: 3, maxLines: 1, uppercase: true, highlightCurrent: true, pop: true, boxed: false,
    outline: 6, shadow: 3, bestFor: "Fast, punchy clips and hooks",
  },
  {
    id: "clean-subtitle",
    description: "Sentence-style subtitles, low on screen, no highlight.",
    size: 0.055, maxWordsPerLine: 7, maxLines: 2, uppercase: false, highlightCurrent: false, pop: false, boxed: false,
    outline: 3, shadow: 1, bestFor: "16:9 YouTube videos, calm or long-form content",
  },
  {
    id: "boxed",
    description: "Sentence-style subtitles on a dark box; readable over busy footage.",
    size: 0.055, maxWordsPerLine: 6, maxLines: 2, uppercase: false, highlightCurrent: false, pop: false, boxed: true,
    outline: 14, shadow: 0, bestFor: "Bright or busy backgrounds",
  },
];

export function getCaptionPreset(id: string): CaptionPreset {
  const p = CAPTION_PRESETS.find((x) => x.id === id);
  if (!p) throw new StudioError("INVALID_INPUT", `Unknown caption preset "${id}"`, `Available: ${CAPTION_PRESETS.map((x) => x.id).join(", ")}`, "captions.preset");
  return p;
}

// ---------------------------------------------------------------- safe areas (fractions of the frame; approximate)
export interface SafeArea {
  top: number;
  bottom: number;
  left: number;
  right: number;
}
const SAFE: Record<string, SafeArea> = {
  "instagram-reels": { top: 0.12, bottom: 0.2, left: 0.05, right: 0.14 },
  "youtube-shorts": { top: 0.1, bottom: 0.22, left: 0.05, right: 0.14 },
  tiktok: { top: 0.1, bottom: 0.22, left: 0.05, right: 0.16 },
  youtube: { top: 0.05, bottom: 0.08, left: 0.05, right: 0.05 },
  generic: { top: 0.08, bottom: 0.12, left: 0.06, right: 0.06 },
};
export function safeArea(platform: string, aspect: string): SafeArea {
  const file = path.join(LIBRARY, "safe-areas.json");
  let table = SAFE;
  if (fs.existsSync(file)) {
    try {
      table = { ...SAFE, ...JSON.parse(fs.readFileSync(file, "utf8")) };
    } catch {
      /* keep defaults */
    }
  }
  if (aspect === "16:9" && platform !== "youtube") return table.youtube;
  return table[platform] ?? table.generic;
}

// ---------------------------------------------------------------- components (drawn with ASS for now)
export const COMPONENTS = {
  HookText: {
    description: "Bold opening line in the first 1–3 seconds. Keep it under ~60 characters.",
    defaultDuration: 2.5,
    props: z
      .object({
        text: z.string().min(1).max(90),
        style: z.enum(["boxed", "bold"]).default("boxed"),
        position: z.enum(["top", "center"]).default("top"),
        uppercase: z.boolean().default(true).describe("Set false to keep case, e.g. units like 253g"),
      })
      .strict(),
    example: { text: "Most developers make this mistake", style: "boxed", position: "top" },
  },
  LowerThird: {
    description: "Speaker name and role on a box, lower left (16:9) or above the captions (9:16).",
    defaultDuration: 4,
    props: z.object({ name: z.string().min(1).max(40), role: z.string().max(60).optional() }).strict(),
    example: { name: "Deepak", role: "Software engineer" },
  },
  TitleCard: {
    description: "Full-screen title over dimmed footage: intros, chapter cards, end cards with a call to action.",
    defaultDuration: 2.5,
    props: z
      .object({ title: z.string().min(1).max(60), subtitle: z.string().max(80).optional(), dim: z.number().min(0).max(1).default(0.55) })
      .strict(),
    example: { title: "Follow for part 2", subtitle: "@yourhandle" },
  },
} as const;
export type ComponentName = keyof typeof COMPONENTS;

export function validateOverlayProps(component: string, props: unknown, pathPrefix: string) {
  const c = (COMPONENTS as Record<string, (typeof COMPONENTS)[ComponentName]>)[component];
  if (!c) throw new StudioError("INVALID_INPUT", `Unknown component "${component}"`, `Available: ${Object.keys(COMPONENTS).join(", ")}`, `${pathPrefix}.component`);
  const r = c.props.safeParse(props);
  if (!r.success) {
    const i = r.error.issues[0];
    throw new StudioError("INVALID_INPUT", `${component} props: ${i.message}`, `Example props: ${JSON.stringify(c.example)}`, `${pathPrefix}.props.${i.path.join(".")}`);
  }
  return r.data as Record<string, any>;
}

// ---------------------------------------------------------------- music & fonts
export function listMusic() {
  const dir = path.join(LIBRARY, "music");
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => /\.(mp3|wav|m4a|aac|flac|ogg)$/i.test(f))
    .map((f) => ({ file: path.join(dir, f), name: f, note: "Import with media_import to get an assetId" }));
}

export function listFonts() {
  const dir = path.join(LIBRARY, "fonts");
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /\.(ttf|otf)$/i.test(f)) : [];
}

export type CatalogKind = "components" | "captionPresets" | "brandKits" | "music" | "fonts" | "styles" | "sfx" | "transitions" | "looks" | "luts";

export function catalog(kind: CatalogKind) {
  switch (kind) {
    case "components":
      return [
        ...Object.entries(COMPONENTS).map(([name, c]) => ({
          name,
          engine: "text (fast)",
          description: c.description,
          defaultDuration: c.defaultDuration,
          props: z.toJSONSchema(c.props),
          example: c.example,
        })),
        ...graphicsCatalog(),
      ];
    case "styles":
      return listStyles();
    case "sfx":
      return listLibrary("sfx");
    case "luts":
      return listLibrary("luts");
    case "transitions":
      return TRANSITIONS;
    case "looks":
      return { presets: LOOK_PRESETS, adjustments: ["brightness", "contrast", "saturation", "gamma", "warmth", "vignette", "grain", "sharpen", "blur", "lut"] };
    case "captionPresets":
      return CAPTION_PRESETS.map((p) => ({ id: p.id, description: p.description, bestFor: p.bestFor }));
    case "brandKits":
      return listBrandKits();
    case "music":
      return [...listMusic(), ...listLibrary("music").map((m) => ({ library: m }))];
    case "fonts":
      return listFonts();
  }
}
