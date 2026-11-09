import assert from "node:assert/strict";
import test from "node:test";
import { parseConfig, terminalName, validateName } from "../src/config.ts";
import { placementLabels } from "../src/host.ts";
import type { Terminal } from "../src/hc.ts";

test("defaults use short random names and separate desktop tabs", () => {
  const config = parseConfig({});
  assert.equal(config.terminal.naming, "random");
  assert.equal(config.desktop.placement, "tabs");
  assert.deepEqual(config.piCommand, ["pi"]);
  const names = new Set<string>();
  for (let i = 0; i < 100; i++) {
    const name = terminalName(config.terminal, "a task description", names);
    assert.match(name, /^[a-z]{3,5}-[a-z]{3,5}$/);
    assert.ok(name.length <= 11);
    names.add(name);
  }
  assert.equal(names.size, 100);
});

test("name allocation retries occupied combinations and fails boundedly", () => {
  const used = new Set(["amber-bear"]);
  let picks = 0;
  assert.equal(
    terminalName(parseConfig({}).terminal, undefined, used, () =>
      picks++ < 2 ? 0 : 1,
    ),
    "birch-bee",
  );
  assert.throws(
    () => terminalName(parseConfig({}).terminal, undefined, used, () => 0),
    /Cannot allocate/,
  );
});

test("task naming and prefixes are opt-in and validate before use", () => {
  const config = parseConfig({ terminal: { naming: "task", prefix: "pi-" } });
  assert.equal(
    terminalName(config.terminal, "login-review", new Set()),
    "pi-login-review",
  );
  assert.throws(
    () =>
      terminalName(
        config.terminal,
        "login-review",
        new Set(["pi-login-review"]),
      ),
    /already used/,
  );
  assert.throws(
    () => terminalName(config.terminal, "bad name", new Set()),
    /Terminal names/,
  );
  assert.throws(() => validateName("a".repeat(33)), /Terminal names/);
});

test("custom launchers retain their executable and profile arguments", () => {
  assert.deepEqual(
    parseConfig({ piCommand: ["/custom/pi", "--theme", "/custom/theme.json"] })
      .piCommand,
    ["/custom/pi", "--theme", "/custom/theme.json"],
  );
});

test("configuration rejects misspellings and unsupported grouping instead of silently ignoring them", () => {
  for (const value of [
    null,
    [],
    { panes: {} },
    { terminal: { group: "Agents" } },
    { terminal: { naming: "other" } },
    { terminal: { prefix: "Invalid!" } },
    { desktop: { placement: "grouped" } },
    { desktop: { group: "Agents" } },
    { piCommand: [] },
  ]) {
    assert.throws(() => parseConfig(value));
  }
});

test("desktop placement never shares the parent's tab; headless/background stays unlabelled", () => {
  const parent: Terminal = {
    address: "tp",
    name: null,
    labels: { "herdr.space": "space", "herdr.tab": "parent" },
    state: "live",
    status: null,
    reason: null,
    exit_code: null,
    keep: false,
  };
  const first = placementLabels(parseConfig({}), parent, "moss-fox");
  const second = placementLabels(parseConfig({}), parent, "calm-wren");
  assert.equal(first["herdr.space"], "space");
  assert.equal(first.where, "moss-fox");
  assert.notEqual(first["herdr.tab"], "parent");
  assert.notEqual(first["herdr.tab"], second["herdr.tab"]);
  assert.deepEqual(
    placementLabels(
      parseConfig({ desktop: { placement: "background" } }),
      parent,
      "x",
    ),
    {},
  );
  assert.deepEqual(
    placementLabels(parseConfig({}), { ...parent, labels: {} }, "x"),
    {},
  );
});
