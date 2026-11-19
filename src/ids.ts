import crypto from "node:crypto";

/** Prefixed, time-sortable id, e.g. ast_m3x9k2a1b7f2c4. */
export function newId(prefix: "prj" | "ast" | "tl" | "rnd" | "job" | "ana"): string {
  const t = Date.now().toString(36).padStart(9, "0");
  const r = crypto.randomBytes(5).toString("hex");
  return `${prefix}_${t}${r}`;
}

export function hashParams(obj: unknown): string {
  return crypto.createHash("sha1").update(JSON.stringify(obj ?? {})).digest("hex").slice(0, 12);
}

export function slug(s: string, max = 48): string {
  return (
    s
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^\p{L}\p{N}]+/gu, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, max) || "untitled"
  );
}
