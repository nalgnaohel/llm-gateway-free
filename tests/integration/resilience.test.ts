import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { FakeClient, cap } from "../helpers/fake-client.ts";
import { contentOf, readSse, startTestServer, type TestServer } from "../helpers/server.ts";

let server: TestServer;
const clients: FakeClient[] = [];

async function connectFake(opts: Partial<ConstructorParameters<typeof FakeClient>[0]> & { agentId: string }) {
  const c = new FakeClient({
    url: server.wsUrl,
    token: "test-token",
    capabilities: [cap("cli/echo")],
    ...opts,
  } as ConstructorParameters<typeof FakeClient>[0]);
  await c.connect();
  clients.push(c);
  return c;
}

const chat = (body: unknown) =>
  fetch(`${server.url}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await server.cleanup();
});

describe("failover between clients", () => {
  beforeEach(async () => {
    server = await startTestServer();
  });

  it("retries on a second client when the first reports a retryable error", async () => {
    await connectFake({
      agentId: "bad",
      behavior: async () => ({ kind: "error", code: "BACKEND_ERROR", message: "tab closed", retryable: true }),
    });
    await connectFake({ agentId: "good", behavior: async () => ({ kind: "done", content: "recovered" }) });

    const res = await chat({ model: "cli/echo", messages: [{ role: "user", content: "hi" }] });
    expect(res.status).toBe(200);
    expect((await res.json()).choices[0].message.content).toBe("recovered");
    expect(res.headers.get("x-aigw-client")).toBe("good");
  });

  it("does not retry when the client says the error is terminal", async () => {
    let goodCalls = 0;
    await connectFake({
      agentId: "bad",
      behavior: async () => ({ kind: "error", code: "NOT_AUTHENTICATED", message: "signed out", retryable: false }),
    });
    await connectFake({
      agentId: "good",
      behavior: async () => {
        goodCalls += 1;
        return { kind: "done", content: "unused" };
      },
    });
    const res = await chat({ model: "cli/echo", messages: [{ role: "user", content: "hi" }] });
    expect(res.status).toBe(502);
    expect(goodCalls).toBe(0);
  });

  it("reports the backend's own error, not 503, when no other client is left", async () => {
    // Regression: excluding the only client used to surface "no active client".
    await connectFake({
      agentId: "solo",
      behavior: async () => ({ kind: "error", code: "BACKEND_ERROR", message: "cli exited 1", retryable: true }),
    });
    const res = await chat({ model: "cli/echo", messages: [{ role: "user", content: "hi" }] });
    expect(res.status).toBe(502);
    expect((await res.json()).error.message).toContain("cli exited 1");
  });

  it("gives up after maxRouteAttempts and reports the last error", async () => {
    await server.cleanup();
    server = await startTestServer({ AIGW_MAX_ROUTE_ATTEMPTS: "2" });
    for (const id of ["c1", "c2", "c3"]) {
      await connectFake({
        agentId: id,
        behavior: async () => ({ kind: "error", code: "BACKEND_ERROR", message: `fail-${id}`, retryable: true }),
      });
    }
    const res = await chat({ model: "cli/echo", messages: [{ role: "user", content: "hi" }] });
    expect(res.status).toBe(502);
    const db = new Database(server.dbPath, { readonly: true });
    const row = db.prepare(`SELECT attempts, status FROM requests ORDER BY created_at DESC`).get() as {
      attempts: number;
      status: string;
    };
    expect(row.attempts).toBe(2);
    expect(row.status).toBe("error");
    db.close();
  });

  it("fails the in-flight job and re-routes when a client vanishes mid-job", async () => {
    const dying = await connectFake({
      agentId: "dying",
      behavior: () => new Promise(() => {}), // accepts, never answers
    });
    await connectFake({ agentId: "backup", behavior: async () => ({ kind: "done", content: "backup answered" }) });

    const pending = chat({ model: "cli/echo", messages: [{ role: "user", content: "hi" }] });
    await new Promise((r) => setTimeout(r, 200));
    dying.close();
    const res = await pending;
    expect(res.status).toBe(200);
    expect((await res.json()).choices[0].message.content).toBe("backup answered");
  });

  it("warns in-stream before restarting the answer on another client", async () => {
    await connectFake({
      agentId: "half",
      behavior: async () => ({ kind: "error", code: "BACKEND_ERROR", message: "died", retryable: true }),
    });
    await connectFake({ agentId: "whole", behavior: async () => ({ kind: "done", chunks: ["full "], content: "full answer" }) });
    const res = await chat({ model: "cli/echo", messages: [{ role: "user", content: "hi" }], stream: true });
    const { events } = await readSse(res);
    expect(contentOf(events)).toContain("full");
  });

  it("re-routes when the chosen client never acknowledges the job", async () => {
    await server.cleanup();
    server = await startTestServer({ AIGW_DISPATCH_ACK_TIMEOUT_MS: "500" });
    await connectFake({ agentId: "silent", swallowJobs: true });
    await connectFake({ agentId: "responsive", behavior: async () => ({ kind: "done", content: "took over" }) });
    const res = await chat({ model: "cli/echo", messages: [{ role: "user", content: "hi" }] });
    expect(res.status).toBe(200);
    expect((await res.json()).choices[0].message.content).toBe("took over");
  });
});

describe("health check", () => {
  it("evicts a client that stops heart-beating and frees its models", async () => {
    server = await startTestServer({ AIGW_HEARTBEAT_INTERVAL_MS: "300", AIGW_HEARTBEAT_MISS_TOLERANCE: "2" });
    await connectFake({ agentId: "zombie", heartbeat: false });
    expect((await (await fetch(`${server.url}/api/clients`)).json()).live).toHaveLength(1);

    await new Promise((r) => setTimeout(r, 1500));
    const after = await (await fetch(`${server.url}/api/clients`)).json();
    expect(after.live).toHaveLength(0);
    expect(after.persisted[0].status).toBe("offline");
    expect(after.persisted[0].heartbeat_misses).toBeGreaterThanOrEqual(1);

    const models = await (await fetch(`${server.url}/v1/models`)).json();
    expect(models.data).toHaveLength(0);
  });

  it("keeps a heart-beating client alive across several intervals", async () => {
    server = await startTestServer({ AIGW_HEARTBEAT_INTERVAL_MS: "300", AIGW_HEARTBEAT_MISS_TOLERANCE: "2" });
    await connectFake({ agentId: "healthy" });
    await new Promise((r) => setTimeout(r, 1500));
    const health = await (await fetch(`${server.url}/health`)).json();
    expect(health.clients).toBe(1);
    const res = await chat({ model: "cli/echo", messages: [{ role: "user", content: "still here?" }] });
    expect(res.status).toBe(200);
  });

  it("supersedes the old socket when the same agent reconnects", async () => {
    server = await startTestServer();
    await connectFake({ agentId: "same" });
    await connectFake({ agentId: "same" });
    await new Promise((r) => setTimeout(r, 200));
    const body = await (await fetch(`${server.url}/api/clients`)).json();
    expect(body.live).toHaveLength(1);
    expect(body.persisted).toHaveLength(1);
  });
});

describe("concurrency", () => {
  beforeEach(async () => {
    server = await startTestServer();
  });

  it("spreads parallel requests across clients instead of queueing on one", async () => {
    const hits: Record<string, number> = { c1: 0, c2: 0 };
    for (const id of ["c1", "c2"]) {
      await connectFake({
        agentId: id,
        capabilities: [cap("cli/echo", { concurrency: 1 })],
        behavior: async () => {
          hits[id] += 1;
          await new Promise((r) => setTimeout(r, 300));
          return { kind: "done", content: `from ${id}` };
        },
      });
    }
    const results = await Promise.all(
      [1, 2].map((n) => chat({ model: "cli/echo", messages: [{ role: "user", content: `q${n}` }] })),
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(hits.c1).toBe(1);
    expect(hits.c2).toBe(1);
  });

  it("503s when every slot is busy and none frees up in time", async () => {
    await server.cleanup();
    server = await startTestServer({ AIGW_QUEUE_WAIT_MS: "200" });
    await connectFake({
      agentId: "busy",
      capabilities: [cap("cli/echo", { concurrency: 1 })],
      maxConcurrency: 1,
      behavior: async () => {
        await new Promise((r) => setTimeout(r, 1500));
        return { kind: "done", content: "slow" };
      },
    });
    const first = chat({ model: "cli/echo", messages: [{ role: "user", content: "a" }] });
    await new Promise((r) => setTimeout(r, 150));
    const second = await chat({ model: "cli/echo", messages: [{ role: "user", content: "b" }] });
    expect(second.status).toBe(503);
    expect((await second.json()).error.message).toContain("capacity");
    expect((await first).status).toBe(200);
  });

  it("releases the slot after a job finishes", async () => {
    await connectFake({
      agentId: "single",
      capabilities: [cap("cli/echo", { concurrency: 1 })],
      maxConcurrency: 1,
    });
    for (const q of ["a", "b", "c"]) {
      const res = await chat({ model: "cli/echo", messages: [{ role: "user", content: q }] });
      expect(res.status).toBe(200);
    }
    const health = await (await fetch(`${server.url}/health`)).json();
    expect(health.activeJobs).toBe(0);
  });
});
