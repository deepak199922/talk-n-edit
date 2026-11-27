/**
 * timeline_patch: change a few values in a saved timeline without sending the whole timeline again.
 *
 * Paths are dot-separated, with [n] for an array index and [id=x] to pick an array item by its id, e.g.
 *   overlays[id=panel].props.rows[2].text      clips[id=c].out      zooms[0].scale      captions.size
 * Ops: set (creates missing object keys), remove (an object key or an array item), append (to an array).
 * The patched timeline goes through timeline_validate, so it is checked and saved as the next version exactly
 * like a full timeline; nothing is saved if validation fails.
 */
import { StudioError } from "./errors.js";

export interface PatchOp {
  op: "set" | "remove" | "append";
  path: string;
  value?: unknown;
}

type Step = { key: string } | { index: number } | { id: string };

export function parsePath(path: string): Step[] {
  const steps: Step[] = [];
  const re = /([^.[\]]+)|\[(\d+)\]|\[id=([^\]]+)\]/g;
  let pos = 0;
  let m: RegExpExecArray | null;
  const p = path.trim();
  if (!p) throw new StudioError("INVALID_INPUT", "Empty path");
  while ((m = re.exec(p))) {
    const between = p.slice(pos, m.index);
    if (between && between !== ".") throw new StudioError("INVALID_INPUT", `Can't read path "${path}" near "${between}"`, 'Example: overlays[id=panel].props.rows[2].text');
    if (m[1] !== undefined) steps.push({ key: m[1] });
    else if (m[2] !== undefined) steps.push({ index: Number(m[2]) });
    else steps.push({ id: m[3] });
    pos = re.lastIndex;
  }
  if (pos !== p.length) throw new StudioError("INVALID_INPUT", `Can't read path "${path}"`, 'Example: overlays[id=panel].props.rows[2].text');
  return steps;
}

const show = (steps: Step[]) => steps.map((s) => ("key" in s ? `.${s.key}` : "index" in s ? `[${s.index}]` : `[id=${s.id}]`)).join("").replace(/^\./, "");

function child(container: any, step: Step, path: Step[], create: boolean): { parent: any; at: string | number } {
  if ("key" in step) {
    if (!container || typeof container !== "object" || Array.isArray(container))
      throw new StudioError("INVALID_INPUT", `${show(path) || "timeline"} is not an object`);
    if (!(step.key in container) && !create)
      throw new StudioError("INVALID_INPUT", `No "${step.key}" in ${show(path) || "timeline"}`, `It has: ${Object.keys(container).join(", ")}`);
    return { parent: container, at: step.key };
  }
  if (!Array.isArray(container)) throw new StudioError("INVALID_INPUT", `${show(path)} is not a list`);
  if ("index" in step) {
    if (step.index >= container.length) throw new StudioError("INVALID_INPUT", `${show(path)} has ${container.length} items; [${step.index}] doesn't exist`);
    return { parent: container, at: step.index };
  }
  const i = container.findIndex((x: any) => x && typeof x === "object" && x.id === step.id);
  if (i < 0) {
    const ids = container.map((x: any) => x?.id).filter(Boolean);
    throw new StudioError("INVALID_INPUT", `No item with id "${step.id}" in ${show(path)}`, ids.length ? `ids: ${ids.join(", ")}` : undefined);
  }
  return { parent: container, at: i };
}

export function applyPatch(timeline: Record<string, unknown>, ops: PatchOp[]): { json: Record<string, unknown>; changed: string[] } {
  if (!ops.length) throw new StudioError("INVALID_INPUT", "No changes given");
  const json = structuredClone(timeline);
  const changed: string[] = [];
  for (const op of ops) {
    const steps = parsePath(op.path);
    const head = steps[0];
    if (steps.length === 1 && "key" in head && (head.key === "projectId" || head.key === "name"))
      throw new StudioError("INVALID_INPUT", `${head.key} can't be patched`, "Use timeline_validate with the full timeline to save it under another name.");
    let cur: any = json;
    for (let i = 0; i < steps.length - 1; i++) {
      const { parent, at } = child(cur, steps[i], steps.slice(0, i), op.op === "set");
      if (parent[at] === undefined && op.op === "set") {
        const next = steps[i + 1];
        parent[at] = "key" in next ? {} : [];
      }
      cur = parent[at];
    }
    const last = steps[steps.length - 1];
    if (op.op === "set") {
      if (op.value === undefined) throw new StudioError("INVALID_INPUT", `set ${op.path}: value is missing`);
      const { parent, at } = child(cur, last, steps.slice(0, -1), true);
      parent[at] = structuredClone(op.value);
    } else if (op.op === "remove") {
      const { parent, at } = child(cur, last, steps.slice(0, -1), false);
      if (Array.isArray(parent)) parent.splice(at as number, 1);
      else delete parent[at];
    } else if (op.op === "append") {
      if (op.value === undefined) throw new StudioError("INVALID_INPUT", `append ${op.path}: value is missing`);
      const { parent, at } = child(cur, last, steps.slice(0, -1), true);
      if (parent[at] === undefined) parent[at] = [];
      if (!Array.isArray(parent[at])) throw new StudioError("INVALID_INPUT", `${op.path} is not a list`);
      parent[at].push(structuredClone(op.value));
    } else throw new StudioError("INVALID_INPUT", `Unknown op "${(op as any).op}"`, "Use set, remove or append.");
    changed.push(`${op.op} ${op.path}`);
  }
  return { json, changed };
}
