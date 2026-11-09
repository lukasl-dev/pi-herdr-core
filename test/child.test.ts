import assert from "node:assert/strict";
import test from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { completion } from "../src/child.ts";

function message(
  stopReason: AssistantMessage["stopReason"],
  text = "Answer",
): AssistantMessage {
  return {
    role: "assistant",
    api: "openai-completions",
    provider: "fixture",
    model: "test",
    content: [{ type: "text", text }],
    stopReason,
    timestamp: 0,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}

test("child completion preserves the actual answer, including intentionally empty responses", () => {
  assert.deepEqual(completion(message("stop")), {
    outcome: "completed",
    text: "Answer",
  });
  assert.deepEqual(completion(message("stop", "")), {
    outcome: "completed",
    text: "",
  });
});

test("missing, errored or aborted assistant messages never become successful task results", () => {
  assert.equal(completion(undefined).outcome, "failed");
  assert.deepEqual(
    completion({ ...message("error"), errorMessage: "Provider denied access" }),
    { outcome: "failed", text: "Provider denied access" },
  );
  assert.equal(completion(message("aborted")).outcome, "failed");
});
