import { describe, expect, it, beforeEach } from "vitest";
import { openDatabase } from "../../packages/server/src/db/index.ts";
import { ResponseCache, TtlValue, cacheKey } from "../../packages/server/src/cache.ts";
import type { ChatMessage } from "@aigw/shared";

const msgs: ChatMessage[] = [{ role: "user", content: "hi" }];
const usage = { promptTokens: 1, completionTokens: 2, totalTokens: 3 };

describe("cacheKey", () => {
  it("is stable for identical inputs", () => {
    expect(cacheKey({ model: "m", messages: msgs })).toBe(cacheKey({ model: "m", messages: msgs }));
  });
  it("changes with the model, the messages and the sampling params", () => {
    const a = cacheKey({ model: "m", messages: msgs });
    expect(cacheKey({ model: "n", messages: msgs })).not.toBe(a);
    expect(cacheKey({ model: "m", messages: [{ role: "user", content: "ho" }] })).not.toBe(a);
    expect(cacheKey({ model: "m", messages: msgs, temperature: 0.5 })).not.toBe(a);
    expect(cacheKey({ model: "m", messages: msgs, maxTokens: 10 })).not.toBe(a);
    expect(cacheKey({ model: "m", messages: msgs, stop: ["x"] })).not.toBe(a);
  });
});

describe("ResponseCache", () => {
  let db: ReturnType<typeof openDatabase>;
  beforeEach(() => {
    db = openDatabase(":memory:");
  });

  it("misses, then hits from memory", () => {
    const c = new ResponseCache(db, { enabled: true, ttlMs: 60_000, maxEntries: 10 });
    expect(c.get("k")).toBeUndefined();
    c.set("k", "m", { content: "answer", usage });
    expect(c.get("k")?.content).toBe("answer");
    expect(c.stats().hitsMemory).toBe(1);
    expect(c.stats().misses).toBe(1);
  });

  it("survives a process restart via the sqlite tier", () => {
    const first = new ResponseCache(db, { enabled: true, ttlMs: 60_000, maxEntries: 10 });
    first.set("k", "m", { content: "answer", usage });
    const second = new ResponseCache(db, { enabled: true, ttlMs: 60_000, maxEntries: 10 });
    expect(second.get("k")?.content).toBe("answer");
    expect(second.stats().hitsDisk).toBe(1);
  });

  it("expires entries and prunes them from both tiers", () => {
    const c = new ResponseCache(db, { enabled: true, ttlMs: -1, maxEntries: 10 });
    c.set("k", "m", { content: "answer", usage });
    expect(c.get("k")).toBeUndefined();
    expect(c.stats().diskEntries).toBe(0);
  });

  it("evicts the least-recently-used entry past maxEntries", () => {
    const c = new ResponseCache(db, { enabled: true, ttlMs: 60_000, maxEntries: 2 });
    c.set("a", "m", { content: "A", usage });
    c.set("b", "m", { content: "B", usage });
    c.get("a"); // touch a so b becomes the LRU victim
    c.set("c", "m", { content: "C", usage });
    expect(c.stats().memoryEntries).toBe(2);
    // b left memory but is still on disk, so this is a disk hit, not a miss.
    const before = c.stats().hitsDisk;
    expect(c.get("b")?.content).toBe("B");
    expect(c.stats().hitsDisk).toBe(before + 1);
  });

  it("is a no-op when disabled", () => {
    const c = new ResponseCache(db, { enabled: false, ttlMs: 60_000, maxEntries: 10 });
    c.set("k", "m", { content: "answer", usage });
    expect(c.get("k")).toBeUndefined();
    expect(c.stats().diskEntries).toBe(0);
  });

  it("refuses to cache empty content", () => {
    const c = new ResponseCache(db, { enabled: true, ttlMs: 60_000, maxEntries: 10 });
    c.set("k", "m", { content: "", usage });
    expect(c.stats().diskEntries).toBe(0);
  });
});

describe("TtlValue", () => {
  it("computes once inside the window and again after invalidate", () => {
    let n = 0;
    const v = new TtlValue<number>(60_000);
    expect(v.get(() => ++n)).toBe(1);
    expect(v.get(() => ++n)).toBe(1);
    v.invalidate();
    expect(v.get(() => ++n)).toBe(2);
  });
});
