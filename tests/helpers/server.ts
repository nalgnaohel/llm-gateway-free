import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startServer, type StartedServer } from "../../packages/server/src/main.ts";

export type TestServer = StartedServer & { wsUrl: string; dbPath: string; dataDir: string; cleanup(): Promise<void> };

export async function startTestServer(env: Record<string, string> = {}): Promise<TestServer> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aigw-test-"));
  const dbPath = path.join(dataDir, "gateway.sqlite");
  const started = await startServer({
    ...process.env,
    AIGW_PORT: "0",
    AIGW_HOST: "127.0.0.1",
    AIGW_DATA_DIR: dataDir,
    AIGW_DB_PATH: dbPath,
    AIGW_AGENT_TOKEN: "test-token",
    AIGW_LOG_LEVEL: "silent",
    AIGW_HEARTBEAT_INTERVAL_MS: "1000",
    AIGW_QUEUE_WAIT_MS: "500",
    ...env,
  });
  return {
    ...started,
    wsUrl: started.url.replace("http://", "ws://") + "/agent",
    dbPath,
    dataDir,
    async cleanup() {
      await started.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

export async function readSse(res: Response): Promise<{ events: unknown[]; text: string }> {
  const raw = await res.text();
  const events: unknown[] = [];
  for (const block of raw.split("\n\n")) {
    const line = block.trim();
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (payload === "[DONE]") continue;
    events.push(JSON.parse(payload));
  }
  return { events, text: raw };
}

export function contentOf(events: unknown[]): string {
  let out = "";
  for (const e of events) {
    const choice = (e as { choices?: Array<{ delta?: { content?: string } }> }).choices?.[0];
    if (choice?.delta?.content) out += choice.delta.content;
  }
  return out;
}
