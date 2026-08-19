import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startMockWebLlm, type MockWebServer } from "../helpers/mock-web-llm.ts";
import { launchChrome, type LaunchedChrome } from "../helpers/chrome.ts";
import { startTestServer, type TestServer } from "../helpers/server.ts";
import { startClient } from "../../packages/client/src/main.ts";
import type { ClientAgent } from "../../packages/client/src/agent.ts";

/**
 * One client agent serving both backends at once, plus the reconnect path:
 * the gateway is restarted underneath a live client and must recover without
 * the client being touched.
 */
let mock: MockWebServer;
let chrome: LaunchedChrome;
let server: TestServer;
let agent: ClientAgent;
let dataDir: string;
const PORT = 8813;

beforeAll(async () => {
  mock = await startMockWebLlm();
  chrome = await launchChrome(mock.url);
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aigw-full-"));
  server = await startTestServer({ AIGW_PORT: String(PORT), AIGW_JOB_TIMEOUT_MS: "60000" });

  agent = await startClient({
    ...process.env,
    AIGW_SERVER_URL: `ws://127.0.0.1:${PORT}/agent`,
    AIGW_AGENT_TOKEN: "test-token",
    AIGW_AGENT_ID: "e2e-full-agent",
    AIGW_CLIENT_DATA_DIR: dataDir,
    AIGW_CDP_URL: chrome.cdpUrl,
    AIGW_MOCKWEB_URL: mock.url,
    AIGW_BROWSER_PROVIDERS: "mockweb",
    AIGW_CLI_EXTRA: "echo",
    AIGW_LOG_LEVEL: "silent",
    AIGW_RECONNECT_BASE_MS: "300",
    AIGW_RECONNECT_MAX_MS: "1500",
    AIGW_CAPABILITY_SCAN_MS: "2000",
  });
  await agent.whenReady();
}, 150_000);

afterAll(async () => {
  await agent?.stop();
  await server?.cleanup();
  await chrome?.stop();
  await mock?.close();
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
});

const chat = (base: string, body: unknown) =>
  fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("one client, both backends", () => {
  it("advertises browser and cli models together", async () => {
    const ids = (await (await fetch(`${server.url}/v1/models`)).json()).data.map((m: { id: string }) => m.id);
    expect(ids).toContain("web/mockweb");
    expect(ids).toContain("cli/echo");
  });

  it("routes each request to the right backend", async () => {
    const [web, cli] = await Promise.all([
      chat(server.url, { model: "web/mockweb", messages: [{ role: "user", content: "route to browser" }] }),
      chat(server.url, { model: "cli/echo", messages: [{ role: "user", content: "route to cli" }] }),
    ]);
    expect((await web.json()).choices[0].message.content).toContain("MOCKWEB reply");
    expect((await cli.json()).choices[0].message.content).toContain("echo-cli reply");
  }, 90_000);

  it("reports both backends in /health and the admin API", async () => {
    const health = await (await fetch(`${server.url}/health`)).json();
    expect(health.clients).toBe(1);
    expect(health.onlineCapabilities).toBeGreaterThanOrEqual(2);
    const clients = await (await fetch(`${server.url}/api/clients`)).json();
    const kinds = clients.live[0].capabilities.map((c: { kind: string }) => c.kind);
    expect(kinds).toContain("browser");
    expect(kinds).toContain("cli");
  });
});

describe("gateway restart", () => {
  it("the client reconnects on its own and traffic resumes", async () => {
    await server.close();
    await new Promise((r) => setTimeout(r, 500));

    server = await startTestServer({ AIGW_PORT: String(PORT), AIGW_JOB_TIMEOUT_MS: "60000" });

    // The client's backoff loop should re-register without any intervention.
    const deadline = Date.now() + 30_000;
    let online = 0;
    while (Date.now() < deadline) {
      const health = await (await fetch(`${server.url}/health`)).json().catch(() => ({ clients: 0 }));
      online = health.clients ?? 0;
      if (online > 0) break;
      await new Promise((r) => setTimeout(r, 300));
    }
    expect(online).toBe(1);

    const res = await chat(server.url, { model: "cli/echo", messages: [{ role: "user", content: "after restart" }] });
    expect(res.status).toBe(200);
    expect((await res.json()).choices[0].message.content).toContain("after restart");
  }, 90_000);
});
