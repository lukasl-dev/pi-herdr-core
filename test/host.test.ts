import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { join } from "node:path";
import test from "node:test";
import { atomicJson, type ChildResult, type Run } from "../src/artifacts.ts";
import { parseConfig } from "../src/config.ts";
import { Host } from "../src/host.ts";
import { fakeCore } from "./helpers.ts";

async function setup(t: Parameters<typeof fakeCore>[0], loseReply = false) {
  const fixture = fakeCore(t);
  const events = new EventEmitter();
  const results: { run: Run; result: ChildResult }[] = [];
  const options = {
    session: "parent-session",
    parent: "tp",
    config: parseConfig({ piCommand: [process.execPath] }),
    directory: fixture.directory,
    hc: fixture.command,
    app: "/no-herdr-app-in-unit-tests",
    env: {
      ...fixture.env,
      ...(loseReply ? { FAKE_HC_LOSE_LAUNCH_REPLY: "1" } : {}),
    },
    onChange: () => events.emit("change"),
    onResult: (run: Run, result: ChildResult) => {
      results.push({ run, result });
      events.emit("result");
    },
  };
  const host = new Host(options);
  t.after(() => host.shutdown(true));
  await host.start();
  const wait = async (predicate: () => boolean) => {
    while (!predicate())
      await once(events, "change", { signal: AbortSignal.timeout(5000) });
  };
  const launch = (name?: string) =>
    host.launch({
      task: "Inspect the task",
      cwd: fixture.directory,
      model: "fixture/test",
      thinking: "off",
      ...(name ? { name } : {}),
    });
  return { ...fixture, events, results, host, options, wait, launch };
}

test("one interactive terminal per agent, safe argv, distinct short names and task labels", async (t) => {
  const f = await setup(t);
  const [a, b] = await Promise.all([
    f.launch("inspect API"),
    f.launch("inspect UI"),
  ]);
  assert.match(a.name, /^[a-z]+-[a-z]+$/);
  assert.notEqual(a.name, b.name);
  assert.equal(a.taskName, "inspect API");
  const launches = f.read().launches;
  assert.equal(launches.length, 2);
  const first = launches[0]!;
  assert.deepEqual(
    [first.wait, first.keep, first.rm, first.no_notify],
    [false, false, false, true],
  );
  assert.equal(first.parent, "tp");
  const argv = first.argv as string[];
  assert.ok(!argv.includes("--print") && !argv.includes("--mode"));
  assert.ok(!argv.includes("--no-extensions"));
  assert.ok(!argv.includes("--no-mcp"));
  assert.ok(argv.at(-1)?.startsWith("@"));
  assert.ok(!argv.some((arg) => arg.includes("Inspect the task")));
  assert.notEqual(
    (first.labels as Record<string, string>)["herdr.tab"],
    (launches[1]!.labels as Record<string, string>)["herdr.tab"],
  );
  assert.equal(f.results.length, 0);
});

test("structured completion requires terminal exit, delivers once and reload respects acknowledgment", async (t) => {
  const f = await setup(t);
  const run = await f.launch();
  atomicJson(join(f.host.root, run.id, "result.json"), {
    version: 1,
    id: run.id,
    outcome: "completed",
    text: "Actual answer",
    session: "/session",
  });
  await f.wait(() => f.host.runs.get(run.id)?.phase === "finalizing");
  assert.equal(f.results.length, 0);
  const state = f.read();
  state.terminals[1]!.state = "finished";
  state.terminals[1]!.exit_code = 0;
  f.write(state);
  await f.wait(() => f.results.length === 1);
  assert.equal(f.results[0]!.result.text, "Actual answer");
  await f.host.acknowledge(run.id);
  f.write(f.read());
  await f.wait(() => f.host.runs.get(run.id)!.delivered);
  assert.equal(f.results.length, 1);
  await f.host.shutdown(true);
  const recovered = new Host(f.options);
  t.after(() => recovered.shutdown(true));
  await recovered.start();
  assert.equal(recovered.runs.get(run.id)?.delivered, true);
  assert.equal(f.results.length, 1);
});

test("interruption leaves a terminal live; cancellation wins over a late completion", async (t) => {
  const f = await setup(t);
  const run = await f.launch();
  await f.host.interrupt(run.name);
  assert.equal(f.read().terminals[1]!.state, "live");
  assert.equal(f.results.length, 0);
  atomicJson(join(f.host.root, run.id, "result.json"), {
    version: 1,
    id: run.id,
    outcome: "completed",
    text: "too late",
    session: null,
  });
  const cancel = await f.host.cancel(run.name);
  assert.equal(cancel.confirmed, true);
  await f.wait(() => f.results.length === 1);
  assert.equal(f.results[0]!.result.outcome, "cancelled");
  assert.deepEqual(
    f.read().actions.map((a) => a.method),
    ["terminal.interrupt", "terminal.kill"],
  );
});

test("ownership mismatch refuses both interrupt and kill", async (t) => {
  const f = await setup(t);
  const run = await f.launch();
  const state = f.read();
  state.terminals[1]!.labels["pi-hc.owner"] = "somebody-else";
  f.write(state);
  await assert.rejects(f.host.interrupt(run.id), /ownership changed/);
  const cancelled = await f.host.cancel(run.id);
  assert.equal(cancelled.confirmed, false);
  assert.equal(f.read().actions.length, 0);
});

test("zero exit without a result fails rather than inventing success", async (t) => {
  const f = await setup(t);
  const run = await f.launch();
  const state = f.read();
  state.terminals[1]!.state = "finished";
  state.terminals[1]!.exit_code = 0;
  f.write(state);
  await f.wait(() => f.results.length === 1);
  assert.equal(f.results[0]!.run.id, run.id);
  assert.equal(f.results[0]!.result.outcome, "failed");
});

test("a malformed child artifact does not block other runs", async (t) => {
  const f = await setup(t);
  const broken = await f.launch();
  const healthy = await f.launch();
  atomicJson(join(f.host.root, broken.id, "result.json"), { invalid: true });
  atomicJson(join(f.host.root, healthy.id, "result.json"), {
    version: 1,
    id: healthy.id,
    outcome: "completed",
    text: "The healthy answer",
    session: null,
  });
  const state = f.read();
  state.terminals.find((term) => term.address === healthy.terminal)!.state =
    "finished";
  f.write(state);
  await f.wait(() => f.results.length === 1);
  assert.equal(f.results[0]!.run.id, healthy.id);
  assert.match(
    f.host.runs.get(broken.id)!.problem ?? "",
    /Could not reconcile/,
  );
  assert.equal((await f.host.cancel(broken.id)).confirmed, true);
});

test("a lost launch reply is reconciled by run labels without a duplicate launch", async (t) => {
  const f = await setup(t, true);
  const run = await f.launch();
  assert.equal(run.phase, "uncertain");
  await f.wait(() => Boolean(f.host.runs.get(run.id)?.terminal));
  assert.equal(f.read().launches.length, 1);
  assert.equal(f.host.runs.get(run.id)?.terminal, "t1");
});

test("cancellation intent survives unresolved acquisition and ends the recovered terminal", async (t) => {
  const f = await setup(t, true);
  const run = await f.launch();
  const cancelled = await f.host.cancel(run.id);
  assert.equal(cancelled.confirmed, false);
  await f.wait(() => f.results.length === 1);
  assert.equal(f.results[0]!.result.outcome, "cancelled");
  assert.equal(f.read().launches.length, 1);
  assert.equal(f.read().terminals[1]!.state, "finished");
});
