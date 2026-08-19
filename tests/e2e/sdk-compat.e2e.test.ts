import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import OpenAI from "openai";
import { startTestServer, type TestServer } from "../helpers/server.ts";
import { startClient } from "../../packages/client/src/main.ts";
import type { ClientAgent } from "../../packages/client/src/agent.ts";

/**
 * The point of the gateway is that existing OpenAI tooling works unchanged.
 * These assertions run through the official `openai` SDK rather than raw fetch,
 * so a contract break (missing field, malformed SSE frame) fails here first.
 */
let server: TestServer;
let agent: ClientAgent;
let client: OpenAI;
let dataDir: string;

beforeAll(async () => {
  server = await startTestServer({ AIGW_REQUIRE_API_KEY: "true", AIGW_API_KEY: "sk-e2e-key" });
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aigw-sdk-"));
  agent = await startClient({
    ...process.env,
    AIGW_SERVER_URL: server.wsUrl,
    AIGW_AGENT_TOKEN: "test-token",
    AIGW_AGENT_ID: "e2e-sdk-agent",
    AIGW_CLIENT_DATA_DIR: dataDir,
    AIGW_BROWSER_ENABLED: "false",
    AIGW_CLI_EXTRA: "echo",
    AIGW_LOG_LEVEL: "silent",
  });
  await agent.whenReady();
  client = new OpenAI({ baseURL: `${server.url}/v1`, apiKey: "sk-e2e-key", maxRetries: 0 });
}, 120_000);

afterAll(async () => {
  await agent?.stop();
  await server?.cleanup();
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("official OpenAI SDK", () => {
  it("lists models", async () => {
    const models = await client.models.list();
    expect(models.data.map((m) => m.id)).toContain("cli/echo");
  });

  it("completes a non-streaming chat", async () => {
    const res = await client.chat.completions.create({
      model: "cli/echo",
      messages: [{ role: "user", content: "sdk non-stream" }],
    });
    expect(res.choices[0].message.content).toContain("sdk non-stream");
    expect(res.usage?.total_tokens).toBeGreaterThan(0);
  }, 60_000);

  it("consumes a streamed chat", async () => {
    const stream = await client.chat.completions.create({
      model: "cli/echo",
      messages: [{ role: "user", content: "sdk streaming" }],
      stream: true,
    });
    let text = "";
    let frames = 0;
    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content;
      if (delta) {
        text += delta;
        frames += 1;
      }
    }
    expect(frames).toBeGreaterThan(0);
    expect(text).toContain("sdk streaming");
  }, 60_000);

  it("rejects a bad API key the way the SDK expects", async () => {
    const bad = new OpenAI({ baseURL: `${server.url}/v1`, apiKey: "sk-wrong", maxRetries: 0 });
    await expect(
      bad.chat.completions.create({ model: "cli/echo", messages: [{ role: "user", content: "x" }] }),
    ).rejects.toMatchObject({ status: 401 });
  }, 60_000);

  it("surfaces an unknown model as a typed error", async () => {
    await expect(
      client.chat.completions.create({ model: "cli/does-not-exist", messages: [{ role: "user", content: "x" }] }),
    ).rejects.toMatchObject({ status: 503 });
  }, 60_000);
});
