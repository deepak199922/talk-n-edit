import { spawn } from "node:child_process";
import { StudioError } from "./errors.js";

export interface RunOptions {
  cwd?: string;
  signal?: AbortSignal;
  onStdoutLine?: (line: string) => void;
  onStderrLine?: (line: string) => void;
  /** Max ms before the process is killed. */
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  label?: string;
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

const KEEP = 200_000; // chars of output kept in memory

/** Run a program with an argument array (never a shell). Rejects with ENGINE_FAILED on non-zero exit. */
export function run(cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) return reject(new StudioError("CANCELLED", "Cancelled"));
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let outBuf = "";
    let errBuf = "";
    let killed = false;
    const kill = () => {
      if (killed) return;
      killed = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5000).unref();
    };
    const onAbort = () => kill();
    opts.signal?.addEventListener("abort", onAbort);
    const timer = opts.timeoutMs ? setTimeout(kill, opts.timeoutMs) : null;

    child.stdout.on("data", (d: Buffer) => {
      const s = d.toString();
      stdout = (stdout + s).slice(-KEEP);
      if (opts.onStdoutLine) {
        outBuf += s;
        let i;
        while ((i = outBuf.indexOf("\n")) >= 0) {
          opts.onStdoutLine(outBuf.slice(0, i));
          outBuf = outBuf.slice(i + 1);
        }
      }
    });
    child.stderr.on("data", (d: Buffer) => {
      const s = d.toString();
      stderr = (stderr + s).slice(-KEEP);
      if (opts.onStderrLine) {
        errBuf += s;
        let i;
        while ((i = errBuf.search(/[\r\n]/)) >= 0) {
          opts.onStderrLine(errBuf.slice(0, i));
          errBuf = errBuf.slice(i + 1);
        }
      }
    });
    child.on("error", (e) => {
      opts.signal?.removeEventListener("abort", onAbort);
      if (timer) clearTimeout(timer);
      const msg = (e as NodeJS.ErrnoException).code === "ENOENT" ? `${cmd} is not installed or not found` : e.message;
      reject(new StudioError("DEPENDENCY_MISSING", msg, "Run system_doctor to check dependencies."));
    });
    child.on("close", (code) => {
      opts.signal?.removeEventListener("abort", onAbort);
      if (timer) clearTimeout(timer);
      if (opts.signal?.aborted) return reject(new StudioError("CANCELLED", "Cancelled"));
      if (code !== 0) {
        const tail = stderr.trim().split("\n").slice(-20).join("\n");
        return reject(
          new StudioError("ENGINE_FAILED", `${opts.label ?? cmd} exited with code ${code}${killed ? " (timed out)" : ""}`, tail),
        );
      }
      resolve({ code: code ?? 0, stdout, stderr });
    });
  });
}
