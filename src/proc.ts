import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { StudioError } from "./errors.js";
import { childEnv, IS_WIN } from "./platform.js";

export interface RunOptions {
  cwd?: string;
  signal?: AbortSignal;
  onStdoutLine?: (line: string) => void;
  onStderrLine?: (line: string) => void;
  /** Max ms before the process is killed. */
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  label?: string;
  /** Keep all of stdout (for programs that print data to parse, like yt-dlp -J), not just the last part. */
  keepAllStdout?: boolean;
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
      env: childEnv(opts.env),
      stdio: ["ignore", "pipe", "pipe"],
      // No console window flashing up on Windows for every ffmpeg/Python run.
      windowsHide: true,
    });
    // Decode across chunk boundaries so multi-byte characters (Hindi, emoji) never get split.
    const outDec = new StringDecoder("utf8");
    const errDec = new StringDecoder("utf8");
    let stdout = "";
    let stderr = "";
    let outBuf = "";
    let errBuf = "";
    let killed = false;
    const kill = () => {
      if (killed) return;
      killed = true;
      if (IS_WIN && child.pid) {
        // Windows has no signals: end the whole tree (yt-dlp → ffmpeg, Remotion → Chrome).
        spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).on("error", () => child.kill());
        return;
      }
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5000).unref();
    };
    const onAbort = () => kill();
    opts.signal?.addEventListener("abort", onAbort);
    const timer = opts.timeoutMs ? setTimeout(kill, opts.timeoutMs) : null;

    child.stdout.on("data", (d: Buffer) => {
      const s = outDec.write(d);
      stdout = opts.keepAllStdout ? stdout + s : (stdout + s).slice(-KEEP);
      if (opts.onStdoutLine) {
        outBuf += s;
        let i;
        while ((i = outBuf.indexOf("\n")) >= 0) {
          opts.onStdoutLine(outBuf.slice(0, i).replace(/\r$/, ""));
          outBuf = outBuf.slice(i + 1);
        }
      }
    });
    child.stderr.on("data", (d: Buffer) => {
      const s = errDec.write(d);
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
      stdout += outDec.end();
      stderr += errDec.end();
      if (opts.onStdoutLine && outBuf) opts.onStdoutLine(outBuf.replace(/\r$/, ""));
      if (code !== 0) {
        const tail = stderr.trim().split(/\r?\n/).slice(-20).join("\n");
        return reject(
          new StudioError("ENGINE_FAILED", `${opts.label ?? cmd} exited with code ${code}${killed ? " (timed out)" : ""}`, tail),
        );
      }
      resolve({ code: code ?? 0, stdout, stderr });
    });
  });
}
