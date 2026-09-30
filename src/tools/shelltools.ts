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
import { exec, type ChildProcess } from "node:child_process";
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

/**
 * Run one command via /bin/sh with a deadline and output cap. The command
 * is never parsed or validated here — it is exactly what the caller sent.
 * Partial output survives a kill: the callback's stdout/stderr args carry
 * whatever was buffered (Node also mirrors them onto the error object on
 * some paths, so both sources are checked). Classification of the error:
 * `killed` = the deadline ended the command, a MAXBUFFER error code = the
 * output cap ended it, a numeric `code` = the process exit code, anything
 * else = the command could not start (rejected as a ToolError).
 */
export function runShellCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
  maxOutputBytes: number,
  onChild?: (child: ChildProcess) => void,
): Promise<ShellRun> {
  return new Promise((resolve, reject) => {
    let outputBytes = 0;
    let combinedCapped = false;
    const child = exec(
      command,
      { cwd, shell: "/bin/sh", timeout: timeoutMs, maxBuffer: maxOutputBytes, encoding: "utf8" },
      (err, stdout, stderr) => {
        const e = err as { stdout?: unknown; stderr?: unknown; code?: unknown; killed?: boolean } | null;
        const rawOut = String(e?.stdout ?? stdout);
        const rawErr = String(e?.stderr ?? stderr);
        const out = new TextDecoder().decode(Buffer.from(rawOut).subarray(0, maxOutputBytes), { stream: true });
        const remaining = Math.max(0, maxOutputBytes - Buffer.byteLength(out));
        const errOut = new TextDecoder().decode(Buffer.from(rawErr).subarray(0, remaining), { stream: true });
        if (combinedCapped) {
          resolve({ exitCode: null, timedOut: false, capped: true, stdout: out, stderr: errOut });
          return;
        }
        if (err === null) {
          resolve({ exitCode: 0, timedOut: false, capped: false, stdout: out, stderr: errOut });
          return;
        }
        const code = e?.code;
        // Node may mark a maxBuffer kill as killed too; classify the cap first.
        if (typeof code === "string" && code.includes("MAXBUFFER")) {
          resolve({ exitCode: null, timedOut: false, capped: true, stdout: out, stderr: errOut });
          return;
        }
        if (e?.killed === true) {
          resolve({ exitCode: null, timedOut: true, capped: false, stdout: out, stderr: errOut });
          return;
        }
        if (typeof code === "number") {
          resolve({ exitCode: code, timedOut: false, capped: false, stdout: out, stderr: errOut });
          return;
        }
        // Error with no exit code and no kill: the command could not even
        // start (e.g. /bin/sh missing). Surface it, not a fake exit 0.
        reject(new ToolError(`cannot start /bin/sh: ${err.message}`));
      },
    );
    const countOutput = (chunk: string): void => {
      outputBytes += Buffer.byteLength(chunk);
      if (outputBytes > maxOutputBytes && !combinedCapped) {
        combinedCapped = true;
        child.kill();
      }
    };
    child.stdout?.on("data", countOutput);
    child.stderr?.on("data", countOutput);
    onChild?.(child);
  });
}

export class ShellTools {
  private readonly active = new Set<ChildProcess>();

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
    const run = await runShellCommand(command, cwd, timeoutS * 1000, this.opts.maxOutputBytes, (child) => {
      this.active.add(child);
      child.once("close", () => this.active.delete(child));
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
    for (const child of this.active) {
      try {
        child.kill();
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
