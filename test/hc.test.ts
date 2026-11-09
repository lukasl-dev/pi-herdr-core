import assert from "node:assert/strict";
import test from "node:test";
import { CoreError, parseTerminal, type Terminal } from "../src/hc.ts";
import { connection, untilEvent } from "./helpers.ts";

test("plain JSON-RPC multiplexes request IDs and reports structured failures", async (t) => {
  const { core } = await connection(t);
  assert.deepEqual(
    await Promise.all([
      core.rpc.request("echo", { a: 1 }),
      core.rpc.request("echo", { b: 2 }),
    ]),
    [{ a: 1 }, { b: 2 }],
  );
  await assert.rejects(
    core.rpc.request("error"),
    (error) => error instanceof CoreError && error.kind === "fixture_error",
  );
  assert.equal((await core.list())[0]?.address, "tp");
  const notifications: unknown[] = [];
  core.rpc.on("notification", (message: unknown) =>
    notifications.push(message),
  );
  await core.rpc.request("coerced-event");
  assert.deepEqual(notifications, []);
});

test("event subscriptions report snapshot replacement; malformed messages reject pending calls", async (t) => {
  const { core, read, write } = await connection(t);
  const changed = untilEvent(core, "change");
  write(read());
  const [event] = await changed;
  assert.equal((event as { method: string }).method, "missed");
  await assert.rejects(
    core.rpc.request("malformed"),
    (error) => error instanceof CoreError && error.kind === "protocol",
  );
});

test("terminal records reject missing or malformed ownership data", () => {
  assert.throws(
    () => parseTerminal({ address: "t1", state: "finished" }),
    /Invalid terminal/,
  );
  const terminal: Terminal = {
    address: "t1",
    state: "live",
    name: "moss-fox",
    labels: { "pi-hc.owner": "owner" },
    status: null,
    reason: null,
    exit_code: null,
    keep: false,
  };
  assert.deepEqual(parseTerminal(terminal), terminal);
  for (const change of [
    { state: ["live"] },
    { labels: { "pi-hc.owner": 1 } },
    { status: { state: ["idle"] } },
    { exit_code: "0" },
  ]) {
    assert.throws(
      () => parseTerminal({ ...terminal, ...change }),
      /Invalid terminal/,
    );
  }
});
