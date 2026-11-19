import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { WORKSPACE } from "./config.js";
import { StudioError } from "./errors.js";

const Unit = z.number().min(0).max(1);
const Point = z.object({ x: Unit, y: Unit }).strict();
const Pos = z.enum(["top", "center", "bottom"]);
const Color = z.string().regex(/^#[0-9a-fA-F]{6}$/);

/** Animated graphics rendered with Remotion (transparent overlays). Props are validated here before rendering. */
export const GRAPHICS = {
  AnimatedTitle: {
    description: "Animated headline text. Styles: pop, slide-up, typewriter, bounce, glitch, highlight (marker sweep).",
    defaultDuration: 2.5,
    props: z
      .object({
        text: z.string().min(1).max(120),
        style: z.enum(["pop", "slide-up", "typewriter", "bounce", "glitch", "highlight"]).default("pop"),
        position: Pos.default("center"),
        size: z.enum(["s", "m", "l", "xl"]).default("l"),
        color: Color.optional(),
        accent: Color.optional(),
        uppercase: z.boolean().default(true),
      })
      .strict(),
    example: { text: "₹2 lakh. Really?", style: "pop", position: "center" },
  },
  Emoji: {
    description: "A big emoji that pops, floats, shakes, spins or pulses at a point on screen.",
    defaultDuration: 1.5,
    props: z
      .object({
        emoji: z.string().min(1).max(16),
        animation: z.enum(["pop", "float", "shake", "spin", "pulse"]).default("pop"),
        x: Unit.default(0.75),
        y: Unit.default(0.3),
        size: z.number().min(0.05).max(0.8).default(0.22).describe("fraction of frame width"),
      })
      .strict(),
    example: { emoji: "🔥", animation: "pop", x: 0.75, y: 0.3 },
  },
  Arrow: {
    description: "An arrow that draws itself from one point to another, with an optional label at the start.",
    defaultDuration: 2,
    props: z
      .object({ from: Point, to: Point, label: z.string().max(40).optional(), color: Color.default("#FFD60A"), curve: z.number().min(-1).max(1).default(0.25) })
      .strict(),
    example: { from: { x: 0.2, y: 0.25 }, to: { x: 0.5, y: 0.5 }, label: "Look here" },
  },
  Callout: {
    description: "Highlights a region with an animated box or circle and an optional label.",
    defaultDuration: 2.5,
    props: z
      .object({
        rect: z.object({ x: Unit, y: Unit, w: Unit, h: Unit }).strict(),
        shape: z.enum(["box", "circle"]).default("box"),
        label: z.string().max(40).optional(),
        color: Color.default("#FFD60A"),
        dimOutside: z.boolean().default(false),
      })
      .strict(),
    example: { rect: { x: 0.3, y: 0.4, w: 0.4, h: 0.2 }, shape: "circle", label: "5.2 mm" },
  },
  CountUp: {
    description: "A number that counts up (or down), e.g. prices, followers, percentages. locale en-IN groups as 2,00,000.",
    defaultDuration: 2,
    props: z
      .object({
        from: z.number().default(0),
        to: z.number(),
        prefix: z.string().max(8).default(""),
        suffix: z.string().max(12).default(""),
        decimals: z.number().int().min(0).max(3).default(0),
        locale: z.enum(["en-IN", "en-US", "en-GB", "de-DE"]).default("en-IN"),
        label: z.string().max(40).optional(),
        position: Pos.default("center"),
        color: Color.optional(),
      })
      .strict(),
    example: { from: 0, to: 200000, prefix: "₹", label: "Price" },
  },
  ProgressBar: {
    description: "A thin bar that fills over the overlay's duration (use the whole video length for a watch-time bar).",
    defaultDuration: 30,
    props: z.object({ position: z.enum(["top", "bottom"]).default("top"), color: Color.optional(), thickness: z.number().min(0.003).max(0.03).default(0.008) }).strict(),
    example: { position: "top" },
  },
  FollowCTA: {
    description: "Animated follow/subscribe button with a pointer tap.",
    defaultDuration: 2.5,
    props: z
      .object({ text: z.string().max(30).default("Follow"), handle: z.string().max(40).optional(), platform: z.enum(["instagram", "youtube", "tiktok", "generic"]).default("instagram"), position: Pos.default("bottom") })
      .strict(),
    example: { text: "Follow", handle: "@yourhandle", platform: "instagram" },
  },
  Confetti: {
    description: "A burst of confetti for wins, reveals and milestones.",
    defaultDuration: 2,
    props: z.object({ count: z.number().int().min(10).max(300).default(120), colors: z.array(Color).max(8).optional(), origin: Point.default({ x: 0.5, y: 0.6 }) }).strict(),
    example: { count: 120 },
  },
  Checklist: {
    description: "Items that tick in one by one, with an optional title.",
    defaultDuration: 4,
    props: z.object({ title: z.string().max(60).optional(), items: z.array(z.string().min(1).max(60)).min(1).max(8), position: Pos.default("center") }).strict(),
    example: { title: "Before you buy", items: ["Battery", "Crease", "Weight"] },
  },
} as const;
export type GraphicName = keyof typeof GRAPHICS;

// ---------------------------------------------------------------- custom effects written by Claude (fx:<name>)
export const fxDir = () => path.join(WORKSPACE, "fx");

export interface FxMeta {
  name: string;
  description: string;
  defaultDuration: number;
  defaultProps: Record<string, unknown>;
  created: string;
  updated: string;
  approved: boolean;
}

export function fxMeta(name: string): FxMeta | undefined {
  const p = path.join(fxDir(), `${name}.json`);
  return fs.existsSync(p) ? (JSON.parse(fs.readFileSync(p, "utf8")) as FxMeta) : undefined;
}

export function listFx(): FxMeta[] {
  if (!fs.existsSync(fxDir())) return [];
  return fs
    .readdirSync(fxDir())
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(fs.readFileSync(path.join(fxDir(), f), "utf8")) as FxMeta);
}

export function isGraphic(component: string): boolean {
  return component in GRAPHICS || component.startsWith("fx:");
}

export function validateGraphicProps(component: string, props: unknown, pathPrefix: string): Record<string, any> {
  if (component.startsWith("fx:")) {
    const name = component.slice(3);
    const meta = fxMeta(name);
    if (!meta) throw new StudioError("INVALID_INPUT", `No custom effect "${name}"`, "Create it with fx_create (catalog_list fx lists existing ones).", `${pathPrefix}.component`);
    if (props !== undefined && (typeof props !== "object" || Array.isArray(props))) throw new StudioError("INVALID_INPUT", "props must be an object", undefined, `${pathPrefix}.props`);
    return { ...meta.defaultProps, ...((props as object) ?? {}) };
  }
  const g = (GRAPHICS as Record<string, (typeof GRAPHICS)[GraphicName]>)[component];
  const r = g.props.safeParse(props ?? {});
  if (!r.success) {
    const i = r.error.issues[0];
    throw new StudioError("INVALID_INPUT", `${component} props: ${i.message}`, `Example props: ${JSON.stringify(g.example)}`, `${pathPrefix}.props.${i.path.join(".")}`);
  }
  return r.data as Record<string, any>;
}

export function graphicsCatalog() {
  return [
    ...Object.entries(GRAPHICS).map(([name, g]) => ({
      name,
      engine: "remotion",
      description: g.description,
      defaultDuration: g.defaultDuration,
      props: z.toJSONSchema(g.props),
      example: g.example,
    })),
    ...listFx().map((m) => ({ name: `fx:${m.name}`, engine: "remotion (custom)", description: m.description, defaultDuration: m.defaultDuration, example: m.defaultProps, approved: m.approved })),
  ];
}
