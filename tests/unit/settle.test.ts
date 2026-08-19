import { describe, expect, it } from "vitest";
import {
  StallWatchdog,
  deltaOf,
  hasTurnStarted,
  isTransientText,
  isTurnSettled,
  SETTLE_QUIET_MS,
  type TurnState,
} from "../../packages/client/src/browser/settle.ts";

const base: TurnState = {
  streaming: false,
  text: "hello world",
  stableForMs: SETTLE_QUIET_MS + 100,
  assistantCount: 1,
  baselineAssistantCount: 0,
  baselineText: "",
};

describe("isTransientText", () => {
  it("flags placeholder states as not-an-answer", () => {
    for (const t of ["Thinking", "Thinking…", "Thought for 3 seconds", "Generating response…", "   "]) {
      expect(isTransientText(t)).toBe(true);
    }
  });
  it("accepts real content", () => {
    expect(isTransientText("Here is the answer.")).toBe(false);
    // A real answer that merely mentions thinking must not be swallowed.
    expect(isTransientText("Thinking about it, the answer is 42.")).toBe(false);
  });
});

describe("hasTurnStarted", () => {
  it("is true while the stop button is up", () => {
    expect(hasTurnStarted({ ...base, streaming: true, text: "", assistantCount: 0 })).toBe(true);
  });
  it("is true once a new assistant node appears", () => {
    expect(hasTurnStarted({ ...base, text: "", assistantCount: 1, baselineAssistantCount: 0 })).toBe(true);
  });
  it("is true when the last node was rewritten in place", () => {
    expect(hasTurnStarted({ ...base, text: "new", assistantCount: 1, baselineAssistantCount: 1, baselineText: "old" })).toBe(true);
  });
  it("is false when nothing moved", () => {
    expect(hasTurnStarted({ ...base, text: "old", assistantCount: 1, baselineAssistantCount: 1, baselineText: "old" })).toBe(false);
  });
});

describe("isTurnSettled", () => {
  it("settles on a quiet, non-transient answer", () => {
    expect(isTurnSettled(base)).toBe(true);
  });
  it("never settles while streaming", () => {
    expect(isTurnSettled({ ...base, streaming: true })).toBe(false);
  });
  it("waits out the quiet window", () => {
    expect(isTurnSettled({ ...base, stableForMs: SETTLE_QUIET_MS - 1 })).toBe(false);
  });
  it("does not settle on a placeholder even when quiet", () => {
    expect(isTurnSettled({ ...base, text: "Thinking…" })).toBe(false);
  });
  it("does not settle on empty text", () => {
    expect(isTurnSettled({ ...base, text: "" })).toBe(false);
  });
});

describe("deltaOf", () => {
  it("returns only the appended suffix", () => {
    expect(deltaOf("abc", "abcdef")).toBe("def");
  });
  it("returns nothing when the node was rewritten", () => {
    expect(deltaOf("abc", "xyz")).toBe("");
  });
  it("returns nothing when unchanged", () => {
    expect(deltaOf("abc", "abc")).toBe("");
  });
});

describe("StallWatchdog", () => {
  it("fires only after the stall window and stops at maxReloads", () => {
    let now = 0;
    const w = new StallWatchdog({ stallMs: 1000, maxReloads: 2, clock: () => now });
    expect(w.shouldReload()).toBe(false);
    now = 999;
    expect(w.shouldReload()).toBe(false);
    now = 1000;
    expect(w.shouldReload()).toBe(true);
    w.noteReload();
    expect(w.shouldReload()).toBe(false);
    now = 2000;
    expect(w.shouldReload()).toBe(true);
    w.noteReload();
    now = 9999;
    expect(w.shouldReload()).toBe(false);
    expect(w.reloadCount).toBe(2);
  });

  it("progress resets the stall clock", () => {
    let now = 0;
    const w = new StallWatchdog({ stallMs: 1000, clock: () => now });
    now = 900;
    w.noteProgress();
    now = 1500;
    expect(w.shouldReload()).toBe(false);
    now = 1900;
    expect(w.shouldReload()).toBe(true);
  });
});
