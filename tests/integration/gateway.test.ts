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

const chat = (body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${server.url}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

beforeEach(async () => {
  server = await startTestServer();
});

afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await server.cleanup();
});

describe("health and discovery", () => {
  it("reports health with zero clients", async () => {
    const res = await fetch(`${server.url}/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(body.clients).toBe(0);
  });

  it("lists a connected client's capabilities as OpenAI models", async () => {
    await connectFake({ agentId: "a", capabilities: [cap("cli/echo", { models: ["v1"] }), cap("web/chatgpt", { available: false })] });
    const res = await fetch(`${server.url}/v1/models`);
    const body = await res.json();
    const ids = body.data.map((m: { id: string }) => m.id);
    expect(ids).toContain("cli/echo");
    expect(ids).toContain("cli/echo:v1"); // sub-models are addressable
    expect(ids).not.toContain("web/chatgpt"); // unavailable ones stay hidden
  });

  it("drops a client's models the moment it disconnects", async () => {
    const c = await connectFake({ agentId: "a" });
    expect((await (await fetch(`${server.url}/v1/models`)).json()).data).toHaveLength(1);
    c.close();
    await new Promise((r) => setTimeout(r, 300));
    expect((await (await fetch(`${server.url}/v1/models`)).json()).data).toHaveLength(0);
  });

  it("reflects a hot capability update without reconnecting", async () => {
    const c = await connectFake({ agentId: "a", capabilities: [cap("cli/echo")] });
    c.updateCapabilities([cap("cli/echo"), cap("web/claude")]);
    await new Promise((r) => setTimeout(r, 300));
    const ids = (await (await fetch(`${server.url}/v1/models`)).json()).data.map((m: { id: string }) => m.id);
    expect(ids).toContain("web/claude");
  });

  it("rejects an agent socket without the token", async () => {
    const bad = new FakeClient({ url: server.wsUrl, token: "wrong", agentId: "x", capabilities: [cap("cli/echo")] });
    await expect(bad.connect()).rejects.toThrow();
  });
});

describe("non-streaming chat", () => {
  it("routes a request to the client and returns an OpenAI completion", async () => {
    await connectFake({ agentId: "a" });
    const res = await chat({ model: "cli/echo", messages: [{ role: "user", content: "hi" }] });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-aigw-cache")).toBe("miss");
    expect(res.headers.get("x-aigw-client")).toBe("a");
    const body = await res.json();
    expect(body.object).toBe("chat.completion");
    expect(body.choices[0].message.content).toBe("hello from fake");
    expect(body.usage.total_tokens).toBeGreaterThan(0);
  });

  it("passes the sub-model through to the client", async () => {
    let seenModel: unknown;
    await connectFake({
      agentId: "a",
      capabilities: [cap("cli/claude", { models: ["sonnet"] })],
      behavior: async (_id, payload) => {
        seenModel = payload.model;
        return { kind: "done", content: "ok" };
      },
    });
    await chat({ model: "cli/claude:sonnet", messages: [{ role: "user", content: "hi" }] });
    expect(seenModel).toBe("sonnet");
  });

  it("503s when no client provides the model", async () => {
    await connectFake({ agentId: "a" });
    const res = await chat({ model: "cli/nope", messages: [{ role: "user", content: "hi" }] });
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error.type).toBe("api_error");
    expect(body.error.message).toContain("cli/nope");
  });

  it("400s on a malformed request", async () => {
    expect((await chat({ messages: [] })).status).toBe(400);
    expect((await chat({ model: "cli/echo" })).status).toBe(400);
    expect((await chat({ model: "cli/echo", messages: [{ role: "wizard", content: "x" }] })).status).toBe(400);
  });

  it("waits for a client that connects after the request arrives", async () => {
    const pending = chat({ model: "cli/echo", messages: [{ role: "user", content: "hi" }] });
    await new Promise((r) => setTimeout(r, 100));
    await connectFake({ agentId: "late" });
    const res = await pending;
    expect(res.status).toBe(200);
  });
});

describe("streaming chat", () => {
  it("streams deltas and terminates with usage plus [DONE]", async () => {
    await connectFake({ agentId: "a" });
    const res = await chat({ model: "cli/echo", messages: [{ role: "user", content: "hi" }], stream: true });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const { events, text } = await readSse(res);
    expect(text.endsWith("data: [DONE]\n\n")).toBe(true);
    expect(contentOf(events)).toBe("hello from fake");
    const first = events[0] as { choices: Array<{ delta: { role?: string } }> };
    expect(first.choices[0].delta.role).toBe("assistant");
    const last = events[events.length - 1] as { choices: Array<{ finish_reason: string }>; usage?: unknown };
    expect(last.choices[0].finish_reason).toBe("stop");
    expect(last.usage).toBeDefined();
  });

  it("emits a full-text chunk when the backend does not stream", async () => {
    await connectFake({ agentId: "a", behavior: async () => ({ kind: "done", content: "one shot answer" }) });
    const res = await chat({ model: "cli/echo", messages: [{ role: "user", content: "hi" }], stream: true });
    const { events } = await readSse(res);
    expect(contentOf(events)).toBe("one shot answer");
  });

  it("emits an OpenAI error frame when the job fails mid-stream", async () => {
    await connectFake({
      agentId: "a",
      behavior: async () => ({ kind: "error", code: "BACKEND_ERROR", message: "provider blew up", retryable: false }),
    });
    const res = await chat({ model: "cli/echo", messages: [{ role: "user", content: "hi" }], stream: true });
    const { events, text } = await readSse(res);
    expect(text).toContain("[DONE]");
    const err = events.find((e) => (e as { error?: unknown }).error) as { error: { message: string } };
    expect(err.error.message).toContain("provider blew up");
  });
});

describe("caching", () => {
  it("serves a repeat request from cache without touching the client", async () => {
    let calls = 0;
    await connectFake({
      agentId: "a",
      behavior: async () => {
        calls += 1;
        return { kind: "done", content: `answer ${calls}` };
      },
    });
    const body = { model: "cli/echo", messages: [{ role: "user", content: "same" }] };
    const first = await chat(body);
    expect(first.headers.get("x-aigw-cache")).toBe("miss");
    const second = await chat(body);
    expect(second.headers.get("x-aigw-cache")).toBe("hit");
    expect((await second.json()).choices[0].message.content).toBe("answer 1");
    expect(calls).toBe(1);
  });

  it("replays a cached answer over SSE too", async () => {
    await connectFake({ agentId: "a" });
    const body = { model: "cli/echo", messages: [{ role: "user", content: "sse-cache" }] };
    await chat(body);
    const res = await chat({ ...body, stream: true });
    expect(res.headers.get("x-aigw-cache")).toBe("hit");
    const { events } = await readSse(res);
    expect(contentOf(events)).toBe("hello from fake");
  });

  it("honours cache:false to force a fresh call", async () => {
    let calls = 0;
    await connectFake({
      agentId: "a",
      behavior: async () => {
        calls += 1;
        return { kind: "done", content: `answer ${calls}` };
      },
    });
    const body = { model: "cli/echo", messages: [{ role: "user", content: "nocache" }], cache: false };
    await chat(body);
    await chat(body);
    expect(calls).toBe(2);
  });
});

describe("api key auth", () => {
  it("enforces keys only when configured", async () => {
    await server.cleanup();
    server = await startTestServer({ AIGW_REQUIRE_API_KEY: "true", AIGW_API_KEY: "sk-secret" });
    await connectFake({ agentId: "a" });
    expect((await chat({ model: "cli/echo", messages: [{ role: "user", content: "x" }] })).status).toBe(401);
    expect(
      (await chat({ model: "cli/echo", messages: [{ role: "user", content: "x" }] }, { authorization: "Bearer nope" }))
        .status,
    ).toBe(401);
    expect(
      (await chat({ model: "cli/echo", messages: [{ role: "user", content: "x" }] }, { authorization: "Bearer sk-secret" }))
        .status,
    ).toBe(200);
  });
});

describe("persistence", () => {
  it("writes clients, capabilities and request rows to sqlite", async () => {
    await connectFake({ agentId: "a" });
    await chat({ model: "cli/echo", messages: [{ role: "user", content: "persist me" }] });
    const db = new Database(server.dbPath, { readonly: true });
    const client = db.prepare(`SELECT * FROM clients WHERE id='a'`).get() as Record<string, unknown>;
    expect(client.status).toBe("online");
    expect(client.total_jobs).toBe(1);
    const capRow = db.prepare(`SELECT * FROM capabilities WHERE client_id='a'`).get() as Record<string, unknown>;
    expect(capRow.capability_id).toBe("cli/echo");
    const req = db.prepare(`SELECT * FROM requests ORDER BY created_at DESC`).get() as Record<string, unknown>;
    expect(req.status).toBe("ok");
    expect(req.client_id).toBe("a");
    expect(req.attempts).toBe(1);
    const events = db.prepare(`SELECT kind FROM request_events WHERE request_id=?`).all(req.id) as Array<{ kind: string }>;
    expect(events.map((e) => e.kind)).toContain("dispatch");
    db.close();
  });

  it("exposes usage and recent requests over the admin API", async () => {
    await connectFake({ agentId: "a" });
    await chat({ model: "cli/echo", messages: [{ role: "user", content: "admin" }] });
    const usage = await (await fetch(`${server.url}/api/usage`)).json();
    expect(usage.totals.requests).toBe(1);
    const reqs = await (await fetch(`${server.url}/api/requests`)).json();
    expect(reqs.requests[0].model).toBe("cli/echo");
    const clientsApi = await (await fetch(`${server.url}/api/clients`)).json();
    expect(clientsApi.live[0].clientId).toBe("a");
  });
});
