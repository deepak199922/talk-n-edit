import type { Resolved, TlWord } from "./resolve.js";

/** "#RRGGBB" -> ASS "&HAABBGGRR" */
function col(hex: string, alpha = 0): string {
  const h = hex.replace("#", "").padEnd(6, "0");
  const r = h.slice(0, 2);
  const g = h.slice(2, 4);
  const b = h.slice(4, 6);
  return `&H${alpha.toString(16).padStart(2, "0").toUpperCase()}${b}${g}${r}`.toUpperCase();
}
const ovc = (hex: string) => {
  const h = hex.replace("#", "");
  return `&H${h.slice(4, 6)}${h.slice(2, 4)}${h.slice(0, 2)}&`.toUpperCase();
};

function ts(t: number): string {
  const cs = Math.max(0, Math.round(t * 100));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  const c = cs % 100;
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(c).padStart(2, "0")}`;
}

const r1 = (n: number) => Math.round(n * 10) / 10;
const esc = (s: string) => s.replace(/\\/g, "/").replace(/\{/g, "(").replace(/\}/g, ")").replace(/\n/g, " ");

const GURMUKHI = /[਀-੿]/;
const NON_LATIN = /[^\u0000-ɏḀ-ỿ -⁯₠-⃏\s]/;

const DEVANAGARI = /[ऀ-ॿ꣠-ꣿ]/;

let FONTS = { body: "Poppins ExtraBold", devanagari: "Mukta ExtraBold", gurmukhi: "Mukta Mahee ExtraBold" };

/** Pick a font that can draw the text: Gurmukhi and Devanagari get their own fonts; the heading font is Latin-only. */
function fontFor(text: string, preferred: string, _body?: string, _g?: string): string {
  if (GURMUKHI.test(text)) return FONTS.gurmukhi;
  if (DEVANAGARI.test(text)) return FONTS.devanagari;
  if (NON_LATIN.test(text)) return FONTS.body;
  return preferred;
}

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
/** Visible character count (Indic vowel signs don't count as extra characters). */
const glen = (s: string) => [...graphemes.segment(s)].length;

interface Chunk {
  words: TlWord[];
  start: number;
  end: number;
}

function isPunctEnd(w: string) {
  return /[.?!।]["')\]]?$/.test(w);
}

const WEAK = new Set(["a","an","the","to","of","and","or","but","in","on","at","for","with","my","your","our","their","his","her","is","are","was","i","we","you","they","that","this","so","if","as","by","from","ki","ka","ke","ko","se","me","hai","aur","की","का","के","को","से","में","और","ਦੀ","ਦਾ","ਦੇ","ਨੂੰ","ਤੇ"]);

function chunkWords(words: TlWord[], maxWords: number, maxLineChars: number, maxLines: number): Chunk[] {
  const chunks: Chunk[] = [];
  let cur: TlWord[] = [];
  const flush = () => {
    if (cur.length) chunks.push({ words: cur, start: cur[0].s, end: cur[cur.length - 1].e });
    cur = [];
  };
  const maxChars = maxLineChars * maxLines;
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const curChars = cur.reduce((n, x) => n + glen(x.w) + 1, 0);
    const full = cur.length > 0 && (cur.length >= maxWords * maxLines || curChars + glen(w.w) > maxChars || w.e - cur[0].s > 3.2);
    if (cur.length && (full || w.s - cur[cur.length - 1].e > 0.35)) {
      // Don't end a caption on a weak word ("the", "to", "and"...): carry it to the next one.
      const carry: TlWord[] = [];
      while (full && cur.length > 2 && WEAK.has(cur[cur.length - 1].w.toLowerCase().replace(/[^\p{L}']/gu, "")) && w.s - cur[cur.length - 1].e < 0.35) carry.unshift(cur.pop()!);
      flush();
      cur = carry;
    }
    cur.push(w);
    if (isPunctEnd(w.w) || (/[,;:]$/.test(w.w) && cur.length >= 2)) flush();
  }
  flush();
  // Extend each chunk to the next one if the gap is short, so captions don't flicker.
  for (let i = 0; i < chunks.length; i++) {
    const next = chunks[i + 1];
    if (next && next.start - chunks[i].end < 0.6) chunks[i].end = next.start;
    else chunks[i].end = chunks[i].end + 0.2;
    if (next) chunks[i].end = Math.min(chunks[i].end, next.start);
  }
  return chunks;
}

function splitLines(n: number, maxPerLine: number, maxLines: number): number[] {
  if (n <= maxPerLine || maxLines === 1) return [n];
  const first = Math.ceil(n / 2);
  return [first, n - first];
}

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}%₹$]+/gu, "");

function emphasisSet(words: TlWord[], emphasis: "auto" | "none" | string[]): Set<number> {
  const out = new Set<number>();
  if (emphasis === "none") return out;
  if (emphasis === "auto") {
    words.forEach((w, i) => {
      if (/[0-9%₹$]/.test(w.w) || (w.w.length > 2 && w.w === w.w.toUpperCase() && /\p{Lu}/u.test(w.w))) out.add(i);
    });
    return out;
  }
  const W = words.map((w) => norm(w.w));
  for (const phrase of emphasis) {
    const ph = phrase.split(/\s+/).map(norm).filter(Boolean);
    if (!ph.length) continue;
    for (let i = 0; i + ph.length <= W.length; i++) {
      if (ph.every((p, k) => W[i + k] === p)) for (let k = 0; k < ph.length; k++) out.add(i + k);
    }
  }
  return out;
}

export function buildAss(res: Resolved): string | null {
  const hasCaps = !!res.captions && res.captions.words.length > 0;
  if (!hasCaps && !res.overlays.length) return null;
  const W = res.width;
  const H = res.height;
  const minDim = Math.min(W, H);
  const k = minDim / 1080;
  const vertical = H > W * 1.05;
  const brand = res.brand;
  const safe = res.safe;
  FONTS = { body: brand.fonts.body, devanagari: brand.fonts.devanagari ?? "Mukta ExtraBold", gurmukhi: brand.fonts.gurmukhi };
  const lines: string[] = [];
  const events: string[] = [];

  const styles: string[] = [];
  const style = (
    name: string, font: string, size: number, primary: string, outline: string, back: string,
    borderStyle: number, outlineW: number, shadow: number, align: number, ml: number, mr: number, mv: number, spacing = 0,
  ) =>
    styles.push(
      `Style: ${name},${font},${Math.round(size)},${primary},${primary},${outline},${back},0,0,0,0,100,100,${r1(spacing)},0,${borderStyle},${Math.round(outlineW)},${Math.round(shadow)},${align},${Math.round(ml)},${Math.round(mr)},${Math.round(mv)},1`,
    );

  // ---------------- captions
  if (hasCaps) {
    const c = res.captions!;
    const p = c.preset;
    const fs = p.size * minDim * (c.size ?? 1);
    const side = W * Math.max(safe.left, safe.right);
    let align = 2;
    let mv: number;
    if (!vertical) mv = H * (safe.bottom + 0.02);
    else if (c.position === "middle") {
      align = 5;
      mv = 0;
    } else if (c.position === "upper") {
      align = 8;
      mv = H * (safe.top + 0.14);
    } else if (c.position === "lower") mv = H * (safe.bottom + 0.02);
    else mv = H * Math.max(safe.bottom + 0.08, 0.27);
    const boxed = p.boxed;
    style(
      "Cap", brand.fonts.body, fs, col(brand.colors.text), boxed ? col(brand.colors.box, 0x50) : col(brand.colors.outline), col("#000000", 0x80),
      boxed ? 3 : 1, p.outline * k, p.shadow * k, align, side, side, mv, 2 * k,
    );
    const maxPerLine = c.maxWordsPerLine ?? p.maxWordsPerLine;
    const maxLineChars = Math.max(8, Math.floor((W - 2 * side) / (fs * 0.6)));
    const upper = c.uppercase ?? p.uppercase;
    const words = c.words.map((w) => ({ ...w, w: upper ? w.w.toLocaleUpperCase() : w.w }));
    const emph = emphasisSet(words, c.emphasis);
    const idx = new Map(words.map((w, i) => [w, i]));
    const chunks = chunkWords(words, maxPerLine, maxLineChars, p.maxLines);
    for (const ch of chunks) {
      const per = splitLines(ch.words.length, maxPerLine, p.maxLines);
      const text = ch.words.map((w) => w.w).join(" ");
      const fn = fontFor(text, brand.fonts.body, brand.fonts.body, brand.fonts.gurmukhi);
      const fnTag = fn !== brand.fonts.body ? `\\fn${fn}` : "";
      const render = (current: number) => {
        let s = "";
        let wi = 0;
        per.forEach((count, li) => {
          const parts: string[] = [];
          for (let j = 0; j < count; j++, wi++) {
            const w = ch.words[wi];
            const gi = idx.get(w)!;
            let txt = esc(w.w);
            if (p.highlightCurrent && wi === current) txt = `{\\c${ovc(brand.colors.highlight)}}${txt}{\\c${ovc(brand.colors.text)}}`;
            else if (emph.has(gi)) txt = `{\\c${ovc(brand.colors.emphasis)}}${txt}{\\c${ovc(brand.colors.text)}}`;
            parts.push(txt);
          }
          s += parts.join(" ") + (li < per.length - 1 ? "\\N" : "");
        });
        return s;
      };
      if (!p.highlightCurrent) {
        events.push(`Dialogue: 5,${ts(ch.start)},${ts(ch.end)},Cap,,0,0,0,,{${fnTag}${p.pop ? "\\fscx75\\fscy75\\t(0,90,\\fscx100\\fscy100)" : ""}}${render(-1)}`);
      } else {
        ch.words.forEach((w, wi) => {
          const s = wi === 0 ? ch.start : w.s;
          const e = wi === ch.words.length - 1 ? ch.end : ch.words[wi + 1].s;
          if (e - s < 0.01) return;
          const pop = p.pop && wi === 0 ? "\\fscx75\\fscy75\\t(0,90,\\fscx100\\fscy100)" : "";
          events.push(`Dialogue: 5,${ts(s)},${ts(e)},Cap,,0,0,0,,{${fnTag}${pop}}${render(wi)}`);
        });
      }
    }
  }

  // ---------------- overlays
  const side = W * Math.max(safe.left, safe.right, 0.06);
  for (const o of res.overlays) {
    const layer = 10 + o.layer;
    const P = o.props;
    if (o.component === "HookText") {
      const fs = 0.1 * minDim;
      const boxed = P.style !== "bold";
      const name = `Hook_${o.id}`;
      const align = P.position === "center" ? 5 : 8;
      const mv = P.position === "center" ? 0 : H * (vertical ? safe.top + 0.05 : 0.08);
      style(
        name, brand.fonts.heading, fs, boxed ? col("#000000") : col(brand.colors.text), boxed ? col(brand.colors.highlight) : col(brand.colors.outline),
        col("#000000", 0x80), boxed ? 3 : 1, boxed ? 18 * k : 7 * k, boxed ? 0 : 3 * k, align, W * 0.06, W * 0.06, mv,
      );
      const fn = fontFor(P.text, brand.fonts.heading, brand.fonts.body, brand.fonts.gurmukhi);
      const fnTag = fn !== brand.fonts.heading ? `\\fn${fn}` : "";
      const hookSide = W * 0.06;
      const maxChars = Math.max(10, Math.floor((W - 2 * hookSide) / (fs * (fn === brand.fonts.heading ? 0.46 : 0.55))));
      const text = wrap(esc(P.uppercase === false ? P.text : P.text.toLocaleUpperCase()), maxChars);
      events.push(`Dialogue: ${layer},${ts(o.start)},${ts(o.end)},${name},,0,0,0,,{${fnTag}\\fad(120,160)\\fscx85\\fscy85\\t(0,140,\\fscx100\\fscy100)}${text}`);
    } else if (o.component === "LowerThird") {
      const fsName = 0.052 * minDim;
      const name = `Lower_${o.id}`;
      const mv = vertical ? H * 0.43 : H * (safe.bottom + 0.06);
      style(name, brand.fonts.body, fsName, col(brand.colors.text), col(brand.colors.box, 0x40), col("#000000", 0x80), 3, 16 * k, 0, 1, W * 0.06, side, mv);
      const fn = fontFor(`${P.name} ${P.role ?? ""}`, brand.fonts.body, brand.fonts.body, brand.fonts.gurmukhi);
      const fnTag = fn !== brand.fonts.body ? `\\fn${fn}` : "";
      const role = P.role ? `\\N{\\fs${Math.round(fsName * 0.66)}\\c${ovc(brand.colors.highlight)}}${esc(P.role)}` : "";
      events.push(`Dialogue: ${layer},${ts(o.start)},${ts(o.end)},${name},,0,0,0,,{${fnTag}\\fad(200,200)}${esc(P.name)}${role}`);
    } else if (o.component === "TitleCard") {
      const fs = 0.13 * minDim;
      const name = `Title_${o.id}`;
      style(name, brand.fonts.heading, fs, col(brand.colors.text), col(brand.colors.outline), col("#000000", 0x80), 1, 6 * k, 2 * k, 5, side, side, 0);
      const alpha = Math.round((1 - (P.dim ?? 0.55)) * 255);
      events.push(
        `Dialogue: ${layer - 1},${ts(o.start)},${ts(o.end)},${name},,0,0,0,,{\\an7\\pos(0,0)\\p1\\bord0\\shad0\\c&H000000&\\1a&H${alpha.toString(16).padStart(2, "0").toUpperCase()}&\\fad(150,150)}m 0 0 l ${W} 0 ${W} ${H} 0 ${H}{\\p0}`,
      );
      const fn = fontFor(P.title, brand.fonts.heading, brand.fonts.body, brand.fonts.gurmukhi);
      const fnTag = fn !== brand.fonts.heading ? `\\fn${fn}` : "";
      const maxChars = Math.max(8, Math.floor((W - 2 * side) / (fs * 0.45)));
      const sub = P.subtitle
        ? `\\N{\\fn${fontFor(P.subtitle, brand.fonts.body, brand.fonts.body, brand.fonts.gurmukhi)}\\fs${Math.round(fs * 0.42)}\\c${ovc(brand.colors.highlight)}}${esc(P.subtitle)}`
        : "";
      events.push(`Dialogue: ${layer},${ts(o.start)},${ts(o.end)},${name},,0,0,0,,{${fnTag}\\fad(150,150)}${wrap(esc(P.title.toLocaleUpperCase()), maxChars)}${sub}`);
    }
  }

  lines.push(
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${W}`,
    `PlayResY: ${H}`,
    "WrapStyle: 2",
    "ScaledBorderAndShadow: yes",
    "YCbCr Matrix: TV.709",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    ...styles,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ...events,
    "",
  );
  return lines.join("\n");
}

function wrap(text: string, maxChars: number): string {
  // Balanced wrap: as few lines as fit, with similar lengths (no lonely last word).
  const words = text.split(" ");
  const total = glen(text);
  const lines = Math.max(1, Math.ceil(total / maxChars));
  const target = Math.min(maxChars, Math.ceil(total / lines) + 2);
  const out: string[] = [];
  let line = "";
  for (const w of words) {
    if (line && glen(line + " " + w) > target && out.length < lines - 1) {
      out.push(line);
      line = w;
    } else line = line ? `${line} ${w}` : w;
  }
  if (line) out.push(line);
  return out.join("\\N");
}

/** Caption boxes are laid out by construction inside the safe area; QA reports this. */
export function captionLayoutNote(res: Resolved): string {
  return `Captions placed between ${Math.round(res.safe.left * 100)}% / ${Math.round(res.safe.right * 100)}% side margins and above the bottom ${Math.round(res.safe.bottom * 100)}% UI zone for ${res.platform}.`;
}
