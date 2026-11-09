import assert from "node:assert/strict";
import test from "node:test";
import { parseConfig, terminalName, validateName } from "../src/config.ts";

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

test("prefixes produce valid names in both naming modes", () => {
  for (const naming of ["random", "task"] as const) {
    for (const prefix of ["", "pi-", "0-", "a".repeat(12)]) {
      const config = parseConfig({ terminal: { naming, prefix } });
      const name = terminalName(config.terminal, "task", new Set(), () => 0);
      assert.equal(name, prefix + (naming === "task" ? "task" : "amber-bear"));
      assert.match(name, /^[a-z0-9][a-z0-9._-]{0,31}$/);
    }
    for (const prefix of ["-", "-pi", "a".repeat(13), "Invalid!"]) {
      assert.throws(
        () => parseConfig({ terminal: { naming, prefix } }),
        /terminal.prefix/,
      );
    }
  }
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
