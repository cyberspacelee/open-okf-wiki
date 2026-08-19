import { spawn } from "node:child_process";

const MAX_GIT_STREAM_BYTES = 1024 * 1024;

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

export async function git(cwd: string, args: string[]): Promise<GitResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let overflow: "stdout" | "stderr" | undefined;
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;

    const terminateForOverflow = (stream: "stdout" | "stderr"): void => {
      if (overflow) return;
      overflow = stream;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 1000);
      killTimer.unref();
    };
    const collect = (stream: "stdout" | "stderr", chunk: Buffer | string): void => {
      if (overflow) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const current = stream === "stdout" ? stdoutBytes : stderrBytes;
      if (current + bytes.byteLength > MAX_GIT_STREAM_BYTES) {
        terminateForOverflow(stream);
        return;
      }
      if (stream === "stdout") {
        stdout.push(bytes);
        stdoutBytes += bytes.byteLength;
      } else {
        stderr.push(bytes);
        stderrBytes += bytes.byteLength;
      }
    };
    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      if (killTimer) clearTimeout(killTimer);
      action();
    };

    child.stdout.on("data", (chunk: Buffer | string) => collect("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer | string) => collect("stderr", chunk));
    child.once("error", (error) => finish(() => reject(error)));
    child.once("close", (code) => finish(() => {
      if (overflow) {
        reject(new Error(`git ${args.join(" ")} exceeded its ${overflow} output limit of ${MAX_GIT_STREAM_BYTES} bytes`));
        return;
      }
      resolve({
        code: code ?? 1,
        stdout: Buffer.concat(stdout, stdoutBytes).toString("utf8"),
        stderr: Buffer.concat(stderr, stderrBytes).toString("utf8"),
      });
    }));
  });
}

export async function repositoryRoot(cwd: string): Promise<string> {
  const result = await git(cwd, ["rev-parse", "--show-toplevel"]);
  if (result.code !== 0) throw new Error(result.stderr.trim() || "git rev-parse --show-toplevel failed");
  return result.stdout.trim();
}
