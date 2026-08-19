import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startMockWebLlm, type MockWebServer } from "../helpers/mock-web-llm.ts";
import { launchChrome, type LaunchedChrome } from "../helpers/chrome.ts";
import { contentOf, readSse, startTestServer, type TestServer } from "../helpers/server.ts";
import { startClient } from "../../packages/client/src/main.ts";
import type { ClientAgent } from "../../packages/client/src/agent.ts";

/**
 * Full path: HTTP request -> gateway -> WebSocket -> client agent -> Playwright
 * over CDP -> a real Chromium tab -> back. The page is a local stand-in with the
 * same DOM contract as ChatGPT/Claude/Gemini, so no account is needed.
 */
let mock: MockWebServer;
let chrome: LaunchedChrome;
let server: TestServer;
let agent: ClientAgent;
let clientDataDir: string;

beforeAll(async () => {
  mock = await startMockWebLlm();
  chrome = await launchChrome(mock.url);
  server = await startTestServer({ AIGW_JOB_TIMEOUT_MS: "60000" });
  clientDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aigw-client-"));

  agent = await startClient({
    ...process.env,
    AIGW_SERVER_URL: server.wsUrl,
    AIGW_AGENT_TOKEN: "test-token",
    AIGW_AGENT_ID: "e2e-browser-agent",
    AIGW_CLIENT_DATA_DIR: clientDataDir,
    AIGW_CDP_URL: chrome.cdpUrl,
    AIGW_MOCKWEB_URL: mock.url,
    AIGW_BROWSER_PROVIDERS: "mockweb",
    AIGW_CLI_ENABLED: "false",
    AIGW_LOG_LEVEL: "silent",
    AIGW_CAPABILITY_SCAN_MS: "2000",
  });
  await agent.whenReady();
}, 120_000);

afterAll(async () => {
  await agent?.stop();
  await server?.cleanup();
  await chrome?.stop();
  await mock?.close();
  if (clientDataDir) fs.rmSync(clientDataDir, { recursive: true, force: true });
});

const chat = (body: unknown) =>
  fetch(`${server.url}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("browser backend end to end", () => {
  it("advertises the open tab as an available model", async () => {
    const models = await (await fetch(`${server.url}/v1/models`)).json();
    const ids = models.data.map((m: { id: string }) => m.id);
    expect(ids).toContain("web/mockweb");
  });

  it("drives the real page and returns the reply as an OpenAI completion", async () => {
    const res = await chat({ model: "web/mockweb", messages: [{ role: "user", content: "ping browser" }] });
    expect(res.status).toBe(200);
    const body = await res.json();
    const content = body.choices[0].message.content as string;
    expect(content).toContain("MOCKWEB reply");
    expect(content).toContain("ping browser");
    // The "Thinking…" placeholder must never be returned as the answer.
    expect(content).not.toBe("Thinking…");
    expect(res.headers.get("x-aigw-client")).toBe("e2e-browser-agent");
  }, 90_000);

  it("streams the page's tokens as SSE deltas", async () => {
    const res = await chat({
      model: "web/mockweb",
      messages: [{ role: "user", content: "stream this please" }],
      stream: true,
    });
    const { events, text } = await readSse(res);
    expect(text.endsWith("data: [DONE]\n\n")).toBe(true);
    const joined = contentOf(events);
    expect(joined).toContain("stream this please");
    // More than one delta proves we followed the DOM as it grew.
    const deltaFrames = events.filter(
      (e) => (e as { choices?: Array<{ delta?: { content?: string } }> }).choices?.[0]?.delta?.content,
    );
    expect(deltaFrames.length).toBeGreaterThan(2);
  }, 90_000);

  it("carries multi-turn context into the single prompt box", async () => {
    const res = await chat({
      model: "web/mockweb",
      messages: [
        { role: "system", content: "be terse" },
        { role: "user", content: "first question" },
        { role: "assistant", content: "first answer" },
        { role: "user", content: "second question" },
      ],
    });
    const content = (await res.json()).choices[0].message.content as string;
    expect(content).toContain("System instructions");
    expect(content).toContain("second question");
  }, 90_000);

  it("records the browser-backed request in sqlite", async () => {
    await chat({ model: "web/mockweb", messages: [{ role: "user", content: "sqlite check" }] });
    const db = new Database(server.dbPath, { readonly: true });
    const row = db
      .prepare(`SELECT * FROM requests WHERE model='web/mockweb' AND status='ok' ORDER BY created_at DESC`)
      .get() as Record<string, unknown>;
    expect(row.client_id).toBe("e2e-browser-agent");
    expect(row.capability_id).toBe("web/mockweb");
    expect(Number(row.latency_ms)).toBeGreaterThan(0);
    db.close();
  }, 90_000);

  it("marks the capability unavailable once the tab is gone", async () => {
    await chrome.stop();
    // Wait for the client's periodic re-probe to notice and push the change.
    const deadline = Date.now() + 20_000;
    let ids: string[] = [];
    while (Date.now() < deadline) {
      const models = await (await fetch(`${server.url}/v1/models`)).json();
      ids = models.data.map((m: { id: string }) => m.id);
      if (!ids.includes("web/mockweb")) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    expect(ids).not.toContain("web/mockweb");

    const res = await chat({ model: "web/mockweb", messages: [{ role: "user", content: "anyone home?" }] });
    expect(res.status).toBe(503);
  }, 60_000);
});
