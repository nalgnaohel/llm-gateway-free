import { describe, expect, it } from "vitest";
import { aggregateCapabilities, candidatesFor, pickCandidate, resolveModel } from "../../packages/server/src/hub/router.ts";
import type { ConnectedClient } from "../../packages/server/src/hub/types.ts";
import type { Capability } from "@aigw/shared";

function makeCap(id: string, concurrency = 1, available = true): Capability {
  return { id, kind: "cli", provider: id, displayName: id, available, concurrency };
}

function makeClient(id: string, caps: Capability[], opts: { maxConcurrency?: number; inflight?: Record<string, number> } = {}): ConnectedClient {
  const inflightByCapability = new Map(Object.entries(opts.inflight ?? {}));
  const inflight = new Set<string>();
  let n = 0;
  for (const count of inflightByCapability.values()) for (let i = 0; i < count; i += 1) inflight.add(`job-${id}-${n++}`);
  return {
    clientId: id,
    name: id,
    version: "1",
    platform: "test",
    remoteAddr: "127.0.0.1",
    maxConcurrency: opts.maxConcurrency ?? 4,
    capabilities: new Map(caps.map((c) => [c.id, c])),
    inflight,
    inflightByCapability,
    connectedAt: 0,
    lastHeartbeatAt: 0,
    heartbeatMisses: 0,
    send: () => {},
    close: () => {},
  };
}

describe("resolveModel", () => {
  it("passes a bare capability id through", () => {
    expect(resolveModel("web/chatgpt")).toEqual({ capabilityId: "web/chatgpt" });
  });
  it("splits a sub-model on the first colon only", () => {
    expect(resolveModel("cli/claude:sonnet")).toEqual({ capabilityId: "cli/claude", subModel: "sonnet" });
    expect(resolveModel("cli/x:a:b")).toEqual({ capabilityId: "cli/x", subModel: "a:b" });
  });
});

describe("candidatesFor", () => {
  it("skips clients without the capability, unavailable caps, and excluded ids", () => {
    const clients = [
      makeClient("a", [makeCap("cli/echo")]),
      makeClient("b", [makeCap("cli/other")]),
      makeClient("c", [makeCap("cli/echo", 1, false)]),
      makeClient("d", [makeCap("cli/echo")]),
    ];
    const found = candidatesFor(clients, "cli/echo", new Set(["d"]));
    expect(found.map((c) => c.client.clientId)).toEqual(["a"]);
  });

  it("skips clients whose capability slots are exhausted", () => {
    const clients = [makeClient("a", [makeCap("cli/echo", 2)], { inflight: { "cli/echo": 2 } })];
    expect(candidatesFor(clients, "cli/echo")).toHaveLength(0);
  });

  it("skips clients at their global concurrency ceiling", () => {
    const clients = [makeClient("a", [makeCap("cli/echo", 5)], { maxConcurrency: 1, inflight: { "cli/echo": 1 } })];
    expect(candidatesFor(clients, "cli/echo")).toHaveLength(0);
  });
});

describe("pickCandidate", () => {
  const clients = [
    makeClient("a", [makeCap("cli/echo", 4)], { inflight: { "cli/echo": 3 } }), // 1 free
    makeClient("b", [makeCap("cli/echo", 4)], { inflight: { "cli/echo": 1 } }), // 3 free
    makeClient("c", [makeCap("cli/echo", 4)]), // 4 free
  ];

  it("least-busy picks the most free capability slots", () => {
    const pick = pickCandidate(candidatesFor(clients, "cli/echo"), "least-busy", new Map(), "cli/echo");
    expect(pick?.client.clientId).toBe("c");
  });

  it("fill-first saturates the busiest client first", () => {
    const pick = pickCandidate(candidatesFor(clients, "cli/echo"), "fill-first", new Map(), "cli/echo");
    expect(pick?.client.clientId).toBe("a");
  });

  it("round-robin cycles deterministically across calls", () => {
    const state = new Map<string, number>();
    const seen = [0, 1, 2, 3].map(
      () => pickCandidate(candidatesFor(clients, "cli/echo"), "round-robin", state, "cli/echo")?.client.clientId,
    );
    expect(seen).toEqual(["a", "b", "c", "a"]);
  });

  it("returns undefined when there is nothing to pick", () => {
    expect(pickCandidate([], "least-busy", new Map(), "x")).toBeUndefined();
  });
});

describe("aggregateCapabilities", () => {
  it("merges the same capability across clients and sums free slots", () => {
    const clients = [
      makeClient("a", [{ ...makeCap("web/chatgpt", 2), models: ["gpt-5"] }], { inflight: { "web/chatgpt": 1 } }),
      makeClient("b", [{ ...makeCap("web/chatgpt", 3), models: ["gpt-5", "auto"] }]),
    ];
    const [agg] = aggregateCapabilities(clients);
    expect(agg.id).toBe("web/chatgpt");
    expect(agg.clients).toBe(2);
    expect(agg.slots).toBe(1 + 3);
    expect(agg.models.sort()).toEqual(["auto", "gpt-5"]);
  });

  it("hides unavailable capabilities", () => {
    const clients = [makeClient("a", [makeCap("cli/echo", 1, false)])];
    expect(aggregateCapabilities(clients)).toHaveLength(0);
  });
});
