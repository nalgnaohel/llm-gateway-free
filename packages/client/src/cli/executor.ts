import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { messagesToPrompt, type ChatMessage } from "@aigw/shared";
import { BUILTIN_ADAPTERS, EXTRA_ADAPTERS, type CliAdapter } from "./adapters.ts";
import { logger } from "../log.ts";

const execFileAsync = promisify(execFile);
const log = logger("cli");

export type CliExecutorOptions = {
  cwd: string;
  timeoutMs: number;
  /** ids from EXTRA_ADAPTERS to enable in addition to the built-ins */
  extra: string[];
};

export type CliProbe = { adapter: CliAdapter; available: boolean; reason?: string; version?: string };

export class CliExecutor {
  private readonly opts: CliExecutorOptions;
  private readonly adapters: CliAdapter[];

  constructor(opts: CliExecutorOptions) {
    this.opts = opts;
    this.adapters = [...BUILTIN_ADAPTERS, ...opts.extra.map((id) => EXTRA_ADAPTERS[id]).filter(Boolean)];
  }

  list(): CliAdapter[] {
    return this.adapters;
  }

  byCapability(capabilityId: string): CliAdapter | undefined {
    return this.adapters.find((a) => a.capabilityId === capabilityId);
  }

  /** Is the binary on PATH and does it answer --version? */
  async probe(): Promise<CliProbe[]> {
    return Promise.all(
      this.adapters.map(async (adapter) => {
        try {
          const { stdout } = await execFileAsync(adapter.bin, adapter.versionArgs, {
            timeout: 10_000,
            windowsHide: true,
          });
          return { adapter, available: true, version: stdout.trim().split("\n")[0] };
        } catch (err) {
          const msg = String((err as { message?: string })?.message ?? err);
          return {
            adapter,
            available: false,
            reason: msg.includes("ENOENT") ? `${adapter.bin} not found on PATH` : msg.slice(0, 200),
          };
        }
      }),
    );
  }

  async run(args: {
    capabilityId: string;
    messages: ChatMessage[];
    model?: string;
    stream: boolean;
    timeoutMs: number;
    signal: AbortSignal;
    onDelta: (delta: string) => void;
  }): Promise<{ content: string }> {
    const adapter = this.byCapability(args.capabilityId);
    if (!adapter) throw new Error(`unknown cli capability "${args.capabilityId}"`);

    const prompt = messagesToPrompt(args.messages);
    const argv = adapter.buildArgs({ prompt, model: args.model, stream: args.stream });
    log.debug(`spawn ${adapter.bin} ${argv.slice(0, 6).join(" ")}…`);

    return new Promise<{ content: string }>((resolve, reject) => {
      const child = spawn(adapter.bin, argv, {
        cwd: this.opts.cwd,
        env: { ...process.env, ...(adapter.env ?? {}) },
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";
      let streamed = "";
      let finalText: string | undefined;
      let pending = "";
      let settled = false;

      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill("SIGKILL");
        reject(new Error(`${adapter.displayName} timed out after ${args.timeoutMs}ms`));
      }, args.timeoutMs);

      const onAbort = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        child.kill("SIGTERM");
        reject(new Error("cancelled"));
      };
      args.signal.addEventListener("abort", onAbort, { once: true });

      const finish = (err?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        args.signal.removeEventListener("abort", onAbort);
        if (err) {
          reject(err);
          return;
        }
        const content = (finalText ?? streamed ?? stdout).trim();
        if (!content) {
          reject(new Error(`${adapter.displayName} produced no output${stderr ? `: ${stderr.slice(0, 400)}` : ""}`));
          return;
        }
        resolve({ content });
      };

      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
        if (adapter.outputMode === "text") {
          streamed += chunk;
          args.onDelta(chunk);
          return;
        }
        pending += chunk;
        let nl = pending.indexOf("\n");
        while (nl !== -1) {
          const line = pending.slice(0, nl).trim();
          pending = pending.slice(nl + 1);
          nl = pending.indexOf("\n");
          if (!line) continue;
          let event: unknown;
          try {
            event = JSON.parse(line);
          } catch {
            continue; // non-JSON noise on stdout
          }
          const delta = adapter.pickDelta?.(event);
          if (delta) {
            streamed += delta;
            args.onDelta(delta);
          }
          const fin = adapter.pickFinal?.(event);
          if (fin !== undefined) finalText = fin;
        }
      });

      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
        if (stderr.length > 8_000) stderr = stderr.slice(-8_000);
      });

      child.on("error", (err) => finish(new Error(`failed to spawn ${adapter.bin}: ${err.message}`)));

      child.on("close", (code) => {
        if (code !== 0 && !finalText && !streamed.trim()) {
          finish(new Error(`${adapter.displayName} exited ${code}${stderr ? `: ${stderr.slice(0, 400)}` : ""}`));
          return;
        }
        finish();
      });

      if (adapter.promptVia === "stdin") {
        child.stdin.write(prompt);
        child.stdin.end();
      } else {
        child.stdin.end();
      }
    });
  }
}
