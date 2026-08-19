/**
 * Coding-CLI adapters. Each adapter turns an OpenAI chat request into an argv
 * for a locally installed CLI and turns that CLI's stdout back into text.
 *
 * Two output modes:
 *   - "text": stdout is the answer; deltas are emitted as data arrives.
 *   - "jsonl": each stdout line is a JSON event; `pickDelta` extracts the text.
 */

export type CliOutputMode = "text" | "jsonl";

export type CliAdapter = {
  id: string;
  /** capability id exposed by the gateway, e.g. "cli/claude" */
  capabilityId: string;
  displayName: string;
  bin: string;
  /** args to detect presence, expected to exit 0 quickly */
  versionArgs: string[];
  models?: string[];
  outputMode: CliOutputMode;
  /** build argv (excluding bin) for one non-interactive run */
  buildArgs(input: { prompt: string; model?: string; stream: boolean }): string[];
  /** how the prompt reaches the process */
  promptVia: "arg" | "stdin";
  /** for jsonl mode: return the incremental text carried by one event, if any */
  pickDelta?(event: unknown): string | undefined;
  /** for jsonl mode: return the authoritative final text, if this event carries it */
  pickFinal?(event: unknown): string | undefined;
  env?: Record<string, string>;
};

/* ------------------------------------------------------------------ claude */

type ClaudeEvent = {
  type?: string;
  subtype?: string;
  result?: string;
  message?: { content?: Array<{ type?: string; text?: string }> };
  delta?: { type?: string; text?: string };
  event?: { type?: string; delta?: { type?: string; text?: string } };
};

export const claudeCliAdapter: CliAdapter = {
  id: "claude",
  capabilityId: "cli/claude",
  displayName: "Claude Code CLI",
  bin: "claude",
  versionArgs: ["--version"],
  models: ["sonnet", "opus", "haiku"],
  outputMode: "jsonl",
  promptVia: "stdin",
  buildArgs: ({ model, stream }) => {
    const args = ["-p", "--output-format", "stream-json", "--verbose"];
    if (stream) args.push("--include-partial-messages");
    if (model) args.push("--model", model);
    return args;
  },
  pickDelta: (raw) => {
    const e = raw as ClaudeEvent;
    // --include-partial-messages emits stream_event frames carrying text deltas.
    if (e.type === "stream_event" && e.event?.type === "content_block_delta" && e.event.delta?.type === "text_delta") {
      return e.event.delta.text ?? "";
    }
    return undefined;
  },
  pickFinal: (raw) => {
    const e = raw as ClaudeEvent;
    if (e.type === "result" && typeof e.result === "string") return e.result;
    if (e.type === "assistant" && Array.isArray(e.message?.content)) {
      const text = e.message.content
        .filter((c) => c?.type === "text" && typeof c.text === "string")
        .map((c) => c.text as string)
        .join("");
      return text || undefined;
    }
    return undefined;
  },
};

/* ---------------------------------------------------------------- opencode */

type OpencodeEvent = {
  type?: string;
  part?: { type?: string; text?: string };
  properties?: { part?: { type?: string; text?: string } };
};

export const opencodeCliAdapter: CliAdapter = {
  id: "opencode",
  capabilityId: "cli/opencode",
  displayName: "OpenCode CLI",
  bin: "opencode",
  versionArgs: ["--version"],
  outputMode: "jsonl",
  promptVia: "arg",
  buildArgs: ({ prompt, model }) => {
    const args = ["run", "--format", "json"];
    if (model) args.push("--model", model);
    args.push(prompt);
    return args;
  },
  pickDelta: (raw) => {
    const e = raw as OpencodeEvent;
    const part = e.part ?? e.properties?.part;
    if (part?.type === "text" && typeof part.text === "string") return part.text;
    return undefined;
  },
  pickFinal: () => undefined,
};

/* -------------------------------------------------------------------- echo */

/**
 * Deterministic local adapter. It needs no credentials, so the E2E suite can
 * exercise the full server → client → CLI → server path on any machine.
 */
export const echoCliAdapter: CliAdapter = {
  id: "echo",
  capabilityId: "cli/echo",
  displayName: "Echo CLI (test)",
  bin: process.execPath,
  versionArgs: ["--version"],
  models: ["v1"],
  outputMode: "text",
  promptVia: "stdin",
  buildArgs: () => [new URL("./echo-cli.ts", import.meta.url).pathname],
};

export const BUILTIN_ADAPTERS: CliAdapter[] = [claudeCliAdapter, opencodeCliAdapter];
export const EXTRA_ADAPTERS: Record<string, CliAdapter> = { echo: echoCliAdapter };
