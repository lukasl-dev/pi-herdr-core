import assert from "node:assert/strict";
import test from "node:test";
import {
  parseResult,
  parseRun,
  type ChildResult,
  type Run,
} from "../src/artifacts.ts";

test("result tags are literal values, not values that stringify to a tag", () => {
  const result: ChildResult = {
    version: 1,
    id: "run-id",
    outcome: "completed",
    text: "The actual answer",
    session: null,
  };
  for (const outcome of ["completed", "failed", "cancelled", "help"]) {
    const value = { ...result, outcome, extra: "retained" };
    assert.deepEqual(parseResult(value, result.id), value);
  }
  for (const outcome of [["completed"], null, 0, {}, "unknown"]) {
    assert.throws(
      () => parseResult({ ...result, outcome }, result.id),
      /Invalid result artifact/,
    );
  }
  assert.throws(
    () => parseResult(result, "another-run"),
    /Invalid result artifact/,
  );
});

test("run manifests validate their tags and nested results while retaining legacy metadata", () => {
  const run: Run = {
    version: 1,
    id: "run-id",
    owner: "owner-id",
    name: "moss-fox",
    taskName: "inspect API",
    cwd: "/project",
    model: "fixture/test",
    thinking: "off",
    created: 0,
    terminal: null,
    cancelled: false,
    delivered: false,
    phase: "starting",
    status: null,
    desktopNamed: false,
    desktopNote: null,
    problem: null,
    result: null,
  };
  const legacy = Object.fromEntries(
    Object.entries(run).filter(([key]) => key !== "desktopNote"),
  );
  assert.deepEqual(
    parseRun({ ...legacy, extra: "retained" }, run.owner, run.id),
    { ...run, extra: "retained" },
  );
  for (const phase of [
    "starting",
    "running",
    "interrupted",
    "uncertain",
    "finalizing",
    "finished",
  ]) {
    assert.equal(parseRun({ ...run, phase }, run.owner, run.id).phase, phase);
  }
  for (const thinking of [
    "off",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ]) {
    assert.equal(
      parseRun({ ...run, thinking }, run.owner, run.id).thinking,
      thinking,
    );
  }
  for (const change of [
    { phase: ["finished"] },
    { phase: "unknown" },
    { thinking: ["off"] },
    { owner: "another-owner" },
    { id: "another-run" },
    {
      result: {
        version: 1,
        id: run.id,
        outcome: ["completed"],
        text: "bad tag",
        session: null,
      },
    },
  ]) {
    assert.throws(() => parseRun({ ...run, ...change }, run.owner, run.id));
  }
});
