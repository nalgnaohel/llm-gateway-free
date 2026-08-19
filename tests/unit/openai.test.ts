import { describe, expect, it } from "vitest";
import {
  buildErrorBody,
  estimateTokens,
  messagesToPrompt,
  nonStreamingBody,
  normalizeStop,
  sse,
  streamChunk,
} from "@aigw/shared";

describe("error envelope", () => {
  it("matches the OpenAI shape per status", () => {
    expect(buildErrorBody(401, "nope").error).toMatchObject({ type: "invalid_request_error", code: "invalid_api_key" });
    expect(buildErrorBody(503, "down").error).toMatchObject({ type: "api_error", code: "service_unavailable" });
    expect(buildErrorBody(599, "weird").error).toMatchObject({ type: "api_error", code: "internal_error" });
  });
});

describe("response bodies", () => {
  it("builds a valid non-streaming completion", () => {
    const body = nonStreamingBody({
      id: "chatcmpl-x",
      model: "cli/echo",
      content: "hi",
      usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 },
    });
    expect(body.object).toBe("chat.completion");
    expect(body.choices[0].message).toEqual({ role: "assistant", content: "hi" });
    expect(body.choices[0].finish_reason).toBe("stop");
    expect(body.usage).toEqual({ prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 });
  });

  it("builds chunk frames with a null finish_reason mid-stream", () => {
    const chunk = streamChunk({ id: "i", model: "m", delta: { content: "a" } });
    expect(chunk.object).toBe("chat.completion.chunk");
    expect(chunk.choices[0].finish_reason).toBeNull();
    expect(sse(chunk).startsWith("data: ")).toBe(true);
    expect(sse(chunk).endsWith("\n\n")).toBe(true);
  });
});

describe("prompt flattening", () => {
  it("labels non-user turns so a single-prompt backend keeps the context", () => {
    const p = messagesToPrompt([
      { role: "system", content: "be terse" },
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
      { role: "user", content: "again" },
    ]);
    expect(p).toContain("[System instructions]");
    expect(p).toContain("[Previous assistant reply]");
    expect(p.endsWith("again")).toBe(true);
  });
});

describe("misc helpers", () => {
  it("normalizes stop into an array", () => {
    expect(normalizeStop("x")).toEqual(["x"]);
    expect(normalizeStop(["x", "y"])).toEqual(["x", "y"]);
    expect(normalizeStop(undefined)).toBeUndefined();
  });
  it("estimates tokens monotonically", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("a".repeat(400))).toBe(100);
  });
});
