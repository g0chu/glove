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
    const child = exec(
      command,
      { cwd, shell: "/bin/sh", timeout: timeoutMs, maxBuffer: maxOutputBytes, encoding: "utf8" },
      (err, stdout, stderr) => {
        const e = err as { stdout?: unknown; stderr?: unknown; code?: unknown; killed?: boolean } | null;
        const out = String(e?.stdout ?? stdout);
        const errOut = String(e?.stderr ?? stderr);
        if (err === null) {
          resolve({ exitCode: 0, timedOut: false, capped: false, stdout: out, stderr: errOut });
          return;
        }
        // killed: the deadline (or an external signal) ended the command.
        if (e?.killed === true) {
          resolve({ exitCode: null, timedOut: true, capped: false, stdout: out, stderr: errOut });
          return;
        }
        const code = e?.code;
        // The output cap killed the command; the args carry the partial output.
        if (typeof code === "string" && code.includes("MAXBUFFER")) {
          resolve({ exitCode: null, timedOut: false, capped: true, stdout: out, stderr: errOut });
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
  description:
    "Run a shell command on the bot's host via /bin/sh, in the bot's file workspace (the directory the file tools operate in). Returns the exit code plus stdout and stderr (capped; a command that exceeds the cap or its deadline is killed and the partial output is still returned). Use it for what the file tools cannot do: running programs, git, package managers, scripts. Commands are not sandboxed — prefer read-only or workspace-local commands, and never run destructive commands without the user asking.",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "The command line to run (executed by /bin/sh, so pipes, && and redirects work)." },
      timeout_s: { type: "integer", description: "Deadline for the command, in seconds (defaults to and is clamped by the bot's configured cap)." },
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
