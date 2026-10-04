/**
 * The shell tool family: one tool that runs a shell command on the bot's
 * host, via /bin/sh, in the file workspace. A per-command deadline and a
 * combined stdout+stderr cap keep one call from hanging or flooding the
 * context; in-flight commands are killed with the tool stack on shutdown.
 *
 * The command line is executed verbatim by the shell (pipes, && and
 * redirects all work). It is not sandboxed: the model's judgment plus the
 * system-prompt rules are the only guard, so the tool description steers it
 * toward read-only or workspace-local commands.
 */
import { spawn, type ChildProcess } from "node:child_process";
import type { ToolSpec } from "../llm/client.js";
import { ToolRegistry, argInt, argString } from "./executor.js";
import { ToolError } from "./web/ssrf.js";
import { workspaceRoot } from "./file/paths.js";

export interface ShellToolsOptions {
  /** Working directory commands run in (the file workspace). */
  cwd: string;
  /** Max deadline per command (ms); the tool's timeout_s arg is clamped to it. */
  timeoutMs: number;
  /** Max combined stdout+stderr bytes kept; a chatty command is killed, the partial output still returned. */
  maxOutputBytes: number;
  /** Hard cap on characters in one tool result. */
  maxResultChars: number;
}

/** What one command run produced (before formatting). */
export interface ShellRun {
  /** Exit code (null when the command was killed). */
  exitCode: number | null;
  /** True when the deadline killed the command. */
  timedOut: boolean;
  /** True when the output cap killed the command. */
  capped: boolean;
  stdout: string;
  stderr: string;
}

/** Run a command in its own process group, terminating descendants on every kill path. */
export function runShellCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
  maxOutputBytes: number,
  onChild?: (child: ChildProcess, terminate: () => void) => void,
): Promise<ShellRun> {
  return new Promise((resolve, reject) => {
    const child = spawn("/bin/sh", ["-c", command], { cwd, detached: true, stdio: ["pipe", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let timedOut = false;
    let capped = false;
    let stopping = false;
    const killGroup = (signal: NodeJS.Signals): void => {
      if (child.pid === undefined) return;
      try { process.kill(-child.pid, signal); } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ESRCH") throw err;
      }
    };
    const stop = (): void => {
      if (stopping) return;
      stopping = true;
      killGroup("SIGTERM");
      // Keep escalation even if the shell exits first: descendants may ignore SIGTERM.
      setTimeout(() => { killGroup("SIGKILL"); }, 100).unref();
    };
    const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
    const collect = (chunks: Buffer[], chunk: Buffer): void => {
      const remaining = Math.max(0, maxOutputBytes - outputBytes);
      if (remaining > 0) chunks.push(chunk.subarray(0, remaining));
      outputBytes += chunk.length;
      if (outputBytes > maxOutputBytes && !capped) {
        capped = true;
        stop();
      }
    };
    child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
    child.once("error", (err) => {
      clearTimeout(timer);
      reject(new ToolError(`cannot start /bin/sh: ${err.message}`));
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({
        exitCode: stopping ? null : code,
        timedOut: !capped && timedOut,
        capped,
        stdout: new TextDecoder().decode(Buffer.concat(stdout), { stream: true }),
        stderr: new TextDecoder().decode(Buffer.concat(stderr), { stream: true }),
      });
    });
    // Route explicit shutdown kills through the same process-group termination.
    child.stdin.end();
    onChild?.(child, () => { timedOut = true; stop(); });
  });
}

export class ShellTools {
  private readonly active = new Set<() => void>();

  /** Max seconds the timeout_s argument may request (from the configured timeout). */
  readonly timeoutCapS: number;

  constructor(private readonly opts: ShellToolsOptions) {
    this.timeoutCapS = Math.max(1, Math.ceil(opts.timeoutMs / 1000));
  }

  /** Hard-cap one tool result before it is handed to the model. */
  private cap(text: string): string {
    return text.length > this.opts.maxResultChars
      ? `${text.slice(0, this.opts.maxResultChars)}\n…[truncated]`
      : text;
  }

  /** Run one command in the workspace; returns the formatted result for the model. */
  async exec(command: string, timeoutS: number): Promise<string> {
    const cwd = workspaceRoot(this.opts.cwd);
    const run = await runShellCommand(command, cwd, timeoutS * 1000, this.opts.maxOutputBytes, (child, terminate) => {
      this.active.add(terminate);
      child.once("close", () => this.active.delete(terminate));
    });
    const parts: string[] = [`$ ${command}`];
    if (run.timedOut) {
      parts.push(`timed out after ${timeoutS}s (killed)`);
    } else if (run.capped) {
      parts.push(`output exceeded the ${this.opts.maxOutputBytes} byte cap (killed)`);
    } else {
      parts.push(`exit: ${run.exitCode}`);
    }
    if (run.stdout.trim().length > 0) parts.push(`stdout:\n${run.stdout.trimEnd()}`);
    if (run.stderr.trim().length > 0) parts.push(`stderr:\n${run.stderr.trimEnd()}`);
    if (parts.length === 2) parts.push("(no output)");
    return this.cap(parts.join("\n"));
  }

  /** Kill all in-flight commands (graceful shutdown). */
  abort(): void {
    for (const terminate of this.active) {
      try {
        terminate();
      } catch {
        /* already settled */
      }
    }
    this.active.clear();
  }
}

/** OpenAI-compatible function spec for the shell tool. */
export const SHELL_EXEC_SPEC: ToolSpec = {
  name: "shell_exec",
  description: "Run /bin/sh on the bot host with the workspace as its initial directory. Returns exit status, stdout and stderr; deadline or output overflow kills the command and returns partial output. Not sandboxed: prefer read-only or workspace-local commands; destructive actions require the user to ask.",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", minLength: 1, description: "Shell command; pipes, redirects and && are supported." },
      timeout_s: { type: "integer", minimum: 1, description: "Deadline in seconds (minimum 1; defaults to and is clamped to the configured cap)." },
    },
    required: ["command"],
    additionalProperties: false,
  },
};

/** Register the shell tool on a registry, bound to one ShellTools. */
export function registerShellTools(registry: ToolRegistry, tools: ShellTools): void {
  registry.register(SHELL_EXEC_SPEC, (args) =>
    tools.exec(argString(args, "command"), argInt(args, "timeout_s", tools.timeoutCapS, 1, tools.timeoutCapS)),
  );
}
