/**
 * Sound packs: sounds the user downloaded (Sonniss GDC bundles, Pixabay, CC0 packs from Freesound, own recordings)
 * imported with a licence record, so every render can say where each sound came from and under what licence.
 *
 * A pack lives in <workspace>/sounds/<pack>/ with LICENSE.json; use its sounds as  "library": "packs/<pack>/<name>".
 * Packs are copied in (the originals are left alone) and never shipped with Talk-n-Edit itself, because several of
 * these licences allow use in your videos but not passing the raw files on.
 */
import fs from "node:fs";
import path from "node:path";
import { WORKSPACE } from "./config.js";
import { StudioError } from "./errors.js";
import { resolveReadable } from "./paths.js";

export const packsDir = () => path.join(WORKSPACE, "sounds");
const AUDIO = /\.(wav|mp3|m4a|aac|flac|ogg|aif|aiff)$/i;

/** Licences a pack can be imported under. Non-commercial and no-derivatives licences are refused: client Reels are commercial work. */
export const LICENSES: Record<string, { label: string; attribution: boolean; note: string }> = {
  "CC0": { label: "Creative Commons 0 (public domain)", attribution: false, note: "Use freely; just don't claim you made the sound." },
  "CC-BY-4.0": { label: "Creative Commons Attribution 4.0", attribution: true, note: "Credit the author wherever the video is published (e.g. the caption)." },
  "Pixabay": { label: "Pixabay Content License", attribution: false, note: "Commercial use OK, no credit needed; don't redistribute the raw sound on its own." },
  "Sonniss-GDC": { label: "Sonniss GDC bundle licence (royalty-free)", attribution: false, note: "Commercial use OK, no credit needed; don't redistribute the raw files or use them to train AI." },
  "Own": { label: "Your own recording or creation", attribution: false, note: "You own it." },
  "Other-commercial": { label: "Other licence that allows commercial use", attribution: false, note: "Keep the licence text in the pack's notes." },
};

export interface PackLicense {
  license: string;
  source: string;
  url?: string;
  attribution?: string;
  notes?: string;
  imported: string;
  files: number;
}

const slugName = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "sound";

export function importPack(a: { folder: string; pack: string; license: string; source: string; url?: string; attribution?: string; notes?: string }) {
  const lic = LICENSES[a.license];
  if (!lic) {
    const nc = /\bnc\b|non-?commercial|\bnd\b|no-?deriv/i.test(a.license);
    throw new StudioError(
      "INVALID_INPUT",
      nc ? `"${a.license}" doesn't allow commercial use or edits, so it can't be used in client videos.` : `Unknown licence "${a.license}"`,
      `Use one of: ${Object.keys(LICENSES).join(", ")}.`,
    );
  }
  if (lic.attribution && !a.attribution?.trim()) throw new StudioError("INVALID_INPUT", `${a.license} needs a credit line`, 'Give attribution, e.g. "Sound by <author> (freesound.org/s/123), CC BY 4.0".');
  const src = resolveReadable(a.folder);
  if (!fs.statSync(src).isDirectory()) throw new StudioError("INVALID_INPUT", `${src} is not a folder`);
  const pack = slugName(a.pack);
  const dest = path.join(packsDir(), pack);
  if (fs.existsSync(path.join(dest, "LICENSE.json"))) throw new StudioError("INVALID_INPUT", `A pack named "${pack}" already exists`, "Pick another name.");
  const found: string[] = [];
  const walk = (d: string, depth: number) => {
    for (const n of fs.readdirSync(d)) {
      const f = path.join(d, n);
      const st = fs.statSync(f);
      if (st.isDirectory()) {
        if (depth < 6) walk(f, depth + 1);
      } else if (AUDIO.test(n)) found.push(f);
    }
  };
  walk(src, 0);
  if (!found.length) throw new StudioError("NOT_FOUND", `No audio files in ${src}`);
  if (found.length > 5000) throw new StudioError("LIMIT_EXCEEDED", `${found.length} files; import at most 5000 at a time`, "Import a sub-folder.");
  fs.mkdirSync(dest, { recursive: true });
  const names = new Set<string>();
  const items: Array<{ name: string; from: string }> = [];
  for (const f of found) {
    const ext = path.extname(f).toLowerCase();
    let base = slugName(path.basename(f, path.extname(f)));
    let n = base;
    for (let i = 2; names.has(n); i++) n = `${base}-${i}`;
    names.add(n);
    fs.copyFileSync(f, path.join(dest, n + ext));
    items.push({ name: n, from: path.relative(src, f) });
  }
  const record: PackLicense & { items: typeof items } = {
    license: a.license,
    source: a.source,
    url: a.url,
    attribution: a.attribution,
    notes: a.notes,
    imported: new Date().toISOString(),
    files: items.length,
    items,
  };
  fs.writeFileSync(path.join(dest, "LICENSE.json"), JSON.stringify(record, null, 1));
  return { pack, files: items.length, use: `"library": "packs/${pack}/<name>"`, examples: items.slice(0, 8).map((i) => `packs/${pack}/${i.name}`), license: lic.label, note: lic.note };
}

function readLicense(pack: string): PackLicense | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(packsDir(), pack, "LICENSE.json"), "utf8"));
  } catch {
    return null;
  }
}

/** Every sound in every pack, as library refs. */
export function listPackSounds(): string[] {
  let packs: string[] = [];
  try {
    packs = fs.readdirSync(packsDir());
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const p of packs) {
    if (!readLicense(p)) continue;
    for (const f of fs.readdirSync(path.join(packsDir(), p))) if (AUDIO.test(f)) out.push(`packs/${p}/${f.replace(AUDIO, "")}`);
  }
  return out;
}

export function packSound(ref: string): string | null {
  const m = /^packs\/([a-z0-9-]+)\/([a-z0-9-]+)$/.exec(ref);
  if (!m) return null;
  if (!readLicense(m[1])) throw new StudioError("INVALID_INPUT", `Sound pack "${m[1]}" has no licence record`, "Import packs with sound_pack_import.");
  const dir = path.join(packsDir(), m[1]);
  for (const f of fs.readdirSync(dir)) if (f.replace(AUDIO, "") === m[2] && AUDIO.test(f)) return path.join(dir, f);
  throw new StudioError("INVALID_INPUT", `No sound "${m[2]}" in pack "${m[1]}"`, "See catalog_list sfx.");
}

/** Where a library sound came from and its licence; for the credits file of a render. */
export function soundCredit(ref: string): { ref: string; license: string; source: string; url?: string; attribution?: string } {
  const m = /^packs\/([a-z0-9-]+)\//.exec(ref);
  if (m) {
    const l = readLicense(m[1]);
    return { ref, license: l ? (LICENSES[l.license]?.label ?? l.license) : "UNKNOWN (no licence record)", source: l?.source ?? "?", url: l?.url, attribution: l?.attribution };
  }
  return { ref, license: "Talk-n-Edit built-in (synthesised by Talk-n-Edit, MIT)", source: "Talk-n-Edit library" };
}
