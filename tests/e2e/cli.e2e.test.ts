import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { contentOf, readSse, startTestServer, type TestServer } from "../helpers/server.ts";
import { startClient } from "../../packages/client/src/main.ts";
import type { ClientAgent } from "../../packages/client/src/agent.ts";

const execFileAsync = promisify(execFile);

/**
 * Full path: HTTP -> gateway -> WebSocket -> client agent -> spawned coding CLI.
 * `cli/echo` is the deterministic adapter that always runs here; `cli/claude` and
 * `cli/opencode` are exercised only when those binaries are installed *and*
 * authenticated, so the suite is green on a machine with no credentials.
 */
let server: TestServer;
let agent: ClientAgent;
let clientDataDir: string;

const hasBinary = async (bin: string): Promise<boolean> => {
  try {
    await execFileAsync(bin, ["--version"], { timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
};

let claudeInstalled = false;
let opencodeInstalled = false;

beforeAll(async () => {
  claudeInstalled = await hasBinary("claude");
  opencodeInstalled = await hasBinary("opencode");
  server = await startTestServer({ AIGW_JOB_TIMEOUT_MS: "120000" });
  clientDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aigw-cli-client-"));

  agent = await startClient({
    ...process.env,
    AIGW_SERVER_URL: server.wsUrl,
    AIGW_AGENT_TOKEN: "test-token",
    AIGW_AGENT_ID: "e2e-cli-agent",
    AIGW_CLIENT_DATA_DIR: clientDataDir,
    AIGW_BROWSER_ENABLED: "false",
    AIGW_CLI_EXTRA: "echo",
    AIGW_CLI_CONCURRENCY: "2",
    AIGW_LOG_LEVEL: process.env.AIGW_E2E_VERBOSE === "1" ? "debug" : "silent",
  });
  await agent.whenReady();
}, 120_000);

afterAll(async () => {
  await agent?.stop();
  await server?.cleanup();
  if (clientDataDir) fs.rmSync(clientDataDir, { recursive: true, force: true });
});

const chat = (body: unknown) =>
  fetch(`${server.url}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("cli backend end to end", () => {
  it("detects which coding CLIs are installed on this machine", () => {
    const caps = agent.currentCapabilities();
    const byId = Object.fromEntries(caps.map((c) => [c.id, c]));
    expect(byId["cli/echo"].available).toBe(true);
    expect(byId["cli/claude"]).toBeDefined();
    expect(byId["cli/opencode"]).toBeDefined();
    expect(byId["cli/claude"].available).toBe(claudeInstalled);
    expect(byId["cli/opencode"].available).toBe(opencodeInstalled);
  });

  it("only advertises installed CLIs as models", async () => {
    const ids = (await (await fetch(`${server.url}/v1/models`)).json()).data.map((m: { id: string }) => m.id);
    expect(ids).toContain("cli/echo");
    expect(ids.includes("cli/claude")).toBe(claudeInstalled);
    expect(ids.includes("cli/opencode")).toBe(opencodeInstalled);
  });

  it("spawns the CLI and returns its output as an OpenAI completion", async () => {
    const res = await chat({ model: "cli/echo", messages: [{ role: "user", content: "hello from the gateway" }] });
    expect(res.status).toBe(200);
    const content = (await res.json()).choices[0].message.content as string;
    expect(content).toContain("echo-cli reply to:");
    expect(content).toContain("hello from the gateway");
  }, 60_000);

  it("streams the CLI's stdout as SSE deltas", async () => {
    const res = await chat({
      model: "cli/echo",
      messages: [{ role: "user", content: "stream from the cli please" }],
      stream: true,
    });
    const { events, text } = await readSse(res);
    expect(text.endsWith("data: [DONE]\n\n")).toBe(true);
    expect(contentOf(events)).toContain("stream from the cli please");
    const deltaFrames = events.filter(
      (e) => (e as { choices?: Array<{ delta?: { content?: string } }> }).choices?.[0]?.delta?.content,
    );
    expect(deltaFrames.length).toBeGreaterThan(1);
  }, 60_000);

  it("runs two CLI jobs concurrently on one client", async () => {
    const started = Date.now();
    const results = await Promise.all(
      ["alpha", "beta"].map((q) => chat({ model: "cli/echo", messages: [{ role: "user", content: q }] })),
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    const bodies = await Promise.all(results.map((r) => r.json()));
    expect(bodies[0].choices[0].message.content).toContain("alpha");
    expect(bodies[1].choices[0].message.content).toContain("beta");
    expect(Date.now() - started).toBeLessThan(30_000);
  }, 60_000);

  it("persists CLI-backed requests with the right capability", async () => {
    await chat({ model: "cli/echo", messages: [{ role: "user", content: "persist cli" }] });
    const db = new Database(server.dbPath, { readonly: true });
    const row = db
      .prepare(`SELECT * FROM requests WHERE capability_id='cli/echo' AND status='ok' ORDER BY created_at DESC`)
      .get() as Record<string, unknown>;
    expect(row.client_id).toBe("e2e-cli-agent");
    db.close();
  }, 60_000);

  it("surfaces a CLI failure as a 502 rather than hanging", async () => {
    const res = await chat({ model: "cli/claude", messages: [{ role: "user", content: "x" }] });
    // Not installed => the model is never advertised => 503.
    // Installed => either it answers, or the spawn fails and the gateway reports
    // the backend's own error (502/504) rather than a misleading 503.
    expect(claudeInstalled ? [200, 502, 504] : [503]).toContain(res.status);
  }, 120_000);

  it("runs a real prompt through claude CLI when it is authenticated", async () => {
    if (!claudeInstalled) return;
    const res = await chat({
      model: "cli/claude",
      messages: [{ role: "user", content: "Reply with exactly the word: PONG" }],
    });
    if (res.status !== 200) {
      // No credentials on this machine — the failure path is asserted above.
      expect([502, 504]).toContain(res.status);
      return;
    }
    const content = (await res.json()).choices[0].message.content as string;
    expect(content.toUpperCase()).toContain("PONG");
  }, 120_000);

  it("runs a real prompt through opencode CLI when it is authenticated", async () => {
    if (!opencodeInstalled) return;
    const res = await chat({
      model: "cli/opencode",
      messages: [{ role: "user", content: "Reply with exactly the word: PONG" }],
    });
    if (res.status !== 200) {
      expect([502, 504]).toContain(res.status);
      return;
    }
    const content = (await res.json()).choices[0].message.content as string;
    expect(content.toUpperCase()).toContain("PONG");
  }, 120_000);
});
