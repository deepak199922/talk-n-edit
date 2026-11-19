import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getConfig, WORKSPACE } from "./config.js";
import { StudioError } from "./errors.js";

function expand(p: string): string {
  return p.replace(/^~(?=$|\/)/, os.homedir());
}

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** Resolve a user-supplied path for reading; must be inside an import root or the workspace. */
export function resolveReadable(p: string): string {
  const abs = path.resolve(expand(p));
  if (!fs.existsSync(abs)) throw new StudioError("NOT_FOUND", `File not found: ${abs}`);
  const real = fs.realpathSync(abs);
  const roots = [WORKSPACE, ...getConfig().importRoots].map((r) => {
    try {
      return fs.realpathSync(r);
    } catch {
      return r;
    }
  });
  if (!roots.some((r) => isInside(real, r))) {
    throw new StudioError(
      "PATH_DENIED",
      `Not allowed to read ${abs}`,
      `Move the file into one of: ${getConfig().importRoots.join(", ")} — or add its folder to importRoots in ${path.join(WORKSPACE, "config.json")}.`,
    );
  }
  return real;
}

/** Ensure a path we are about to write is inside the workspace or the export folder. */
export function assertWritable(p: string): string {
  const abs = path.resolve(p);
  const ok = isInside(abs, WORKSPACE) || isInside(abs, getConfig().exportDir);
  if (!ok) throw new StudioError("PATH_DENIED", `Refusing to write outside the workspace: ${abs}`);
  return abs;
}
