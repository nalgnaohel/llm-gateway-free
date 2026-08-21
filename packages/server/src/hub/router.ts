import type { ConnectedClient } from "./types.ts";

export type RoutingStrategy = "least-busy" | "round-robin" | "fill-first" | "ip-hash";

export const ROUTING_STRATEGIES: RoutingStrategy[] = ["least-busy", "round-robin", "fill-first", "ip-hash"];

/** FNV-1a: fast, deterministic, good enough spread for sticky IP routing. */
function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export type Candidate = {
  client: ConnectedClient;
  capabilityId: string;
  /** free slots on this capability right now */
  freeSlots: number;
  /** free slots on the client as a whole */
  clientFreeSlots: number;
};

/** Collect every online client that can serve `capabilityId` and still has room. */
export function candidatesFor(
  clients: Iterable<ConnectedClient>,
  capabilityId: string,
  exclude: ReadonlySet<string> = new Set(),
): Candidate[] {
  const out: Candidate[] = [];
  for (const client of clients) {
    if (exclude.has(client.clientId)) continue;
    const cap = client.capabilities.get(capabilityId);
    if (!cap || !cap.available) continue;
    const used = client.inflightByCapability.get(capabilityId) ?? 0;
    const freeSlots = cap.concurrency - used;
    const clientFreeSlots = client.maxConcurrency - client.inflight.size;
    if (freeSlots <= 0 || clientFreeSlots <= 0) continue;
    out.push({ client, capabilityId, freeSlots, clientFreeSlots });
  }
  return out;
}

/**
 * Deterministic tie-breaking on clientId keeps tests stable and avoids two
 * concurrent picks landing on the same client purely by insertion order.
 */
export function pickCandidate(
  candidates: Candidate[],
  strategy: RoutingStrategy,
  rrState: Map<string, number>,
  capabilityId: string,
  /** Caller IP for "ip-hash": same IP keeps landing on the same client while it stays a candidate. */
  hashKey?: string,
): Candidate | undefined {
  if (candidates.length === 0) return undefined;
  if (candidates.length === 1) return candidates[0];

  const sorted = [...candidates].sort((a, b) => a.client.clientId.localeCompare(b.client.clientId));

  if (strategy === "fill-first") {
    // Saturate one client before touching the next: fewest free slots wins.
    return [...sorted].sort((a, b) => a.clientFreeSlots - b.clientFreeSlots)[0];
  }

  if (strategy === "ip-hash") {
    const idx = hashString(hashKey || "unknown") % sorted.length;
    return sorted[idx];
  }

  if (strategy === "round-robin") {
    const cursor = rrState.get(capabilityId) ?? 0;
    const pick = sorted[cursor % sorted.length];
    rrState.set(capabilityId, (cursor + 1) % sorted.length);
    return pick;
  }

  // least-busy (default): most free capability slots, then most free client slots.
  return [...sorted].sort((a, b) => b.freeSlots - a.freeSlots || b.clientFreeSlots - a.clientFreeSlots)[0];
}

/** Union of capability ids across all connected clients, with aggregate stats. */
export function aggregateCapabilities(clients: Iterable<ConnectedClient>) {
  const map = new Map<
    string,
    { id: string; kind: string; provider: string; displayName: string; models: string[]; clients: number; slots: number }
  >();
  for (const client of clients) {
    for (const cap of client.capabilities.values()) {
      if (!cap.available) continue;
      const used = client.inflightByCapability.get(cap.id) ?? 0;
      const existing = map.get(cap.id);
      if (existing) {
        existing.clients += 1;
        existing.slots += Math.max(0, cap.concurrency - used);
        for (const m of cap.models ?? []) if (!existing.models.includes(m)) existing.models.push(m);
      } else {
        map.set(cap.id, {
          id: cap.id,
          kind: cap.kind,
          provider: cap.provider,
          displayName: cap.displayName,
          models: [...(cap.models ?? [])],
          clients: 1,
          slots: Math.max(0, cap.concurrency - used),
        });
      }
    }
  }
  return [...map.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * The gateway exposes both the capability id itself ("web/chatgpt") and every
 * sub-model qualified with it ("web/chatgpt:gpt-4o"). Resolve either form.
 */
export function resolveModel(model: string): { capabilityId: string; subModel?: string } {
  const idx = model.indexOf(":");
  if (idx === -1) return { capabilityId: model };
  return { capabilityId: model.slice(0, idx), subModel: model.slice(idx + 1) };
}
