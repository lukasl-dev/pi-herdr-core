import assert from "node:assert/strict";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { nameDesktopTab } from "../src/desktop.ts";

test("tab naming waits for adoption, targets only the allocated tab, and never focuses it", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "pi-hc-app-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const command = join(directory, "app.mjs");
  const log = join(directory, "log.json");
  writeFileSync(
    command,
    `#!/usr/bin/env node
import {existsSync,readFileSync,writeFileSync} from "node:fs";
const path=process.env.APP_LOG;
const calls=existsSync(path)?JSON.parse(readFileSync(path,"utf8")):[];
calls.push(process.argv.slice(2));writeFileSync(path,JSON.stringify(calls));
if(calls.length===1){console.error("tab not adopted yet");process.exit(1)}
console.log("{}");
`,
  );
  chmodSync(command, 0o755);
  assert.equal(
    await nameDesktopTab(
      "pihc-owned-id",
      "moss-fox",
      new AbortController().signal,
      { ...process.env, APP_LOG: log },
      command,
    ),
    null,
  );
  const calls = JSON.parse(readFileSync(log, "utf8")) as string[][];
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.deepEqual(call.slice(0, 2), ["do", "tab.rename"]);
    assert.deepEqual(JSON.parse(call[2]!) as unknown, {
      id: "pihc-owned-id",
      name: "moss-fox",
    });
  }
});

test("missing desktop is optional and shutdown aborts pending naming", async () => {
  assert.match(
    (await nameDesktopTab(
      "tab",
      "name",
      new AbortController().signal,
      process.env,
      "/missing-app",
    ))!,
    /not installed/,
  );
  const abort = new AbortController();
  abort.abort();
  assert.equal(await nameDesktopTab("tab", "name", abort.signal), null);
});
