import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import type { TestContext } from "node:test";
import { Core, type Terminal } from "../src/hc.ts";

export interface FixtureState {
  terminals: Terminal[];
  launches: Record<string, unknown>[];
  actions: { method: string; terminal: string }[];
}

export function fakeCore(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "pi-hc-test-"));
  const statePath = join(directory, "core.json");
  const command = fileURLToPath(
    new URL("fixtures/fake-hc.mjs", import.meta.url),
  );
  chmodSync(command, 0o755);
  const parent: Terminal = {
    address: "tp",
    state: "live",
    name: null,
    labels: { "herdr.space": "sp-test", "herdr.tab": "tab-parent" },
    status: null,
    reason: null,
    exit_code: null,
    keep: false,
  };
  const read = (): FixtureState =>
    JSON.parse(readFileSync(statePath, "utf8")) as FixtureState;
  const write = (state: FixtureState) =>
    writeFileSync(statePath, JSON.stringify(state));
  write({ terminals: [parent], launches: [], actions: [] });
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return {
    directory,
    statePath,
    command,
    read,
    write,
    env: { ...process.env, FAKE_HC_STATE: statePath },
  };
}

export async function connection(t: TestContext) {
  const fixture = fakeCore(t);
  const core = new Core(fixture.command, fixture.env);
  t.after(() => core.close());
  await core.start("test-owner");
  return { ...fixture, core };
}

export async function untilEvent(
  emitter: NodeJS.EventEmitter,
  event: string,
): Promise<unknown[]> {
  return once(emitter, event, { signal: AbortSignal.timeout(5000) });
}

export const projectDirectory = dirname(
  fileURLToPath(new URL("../package.json", import.meta.url)),
);
