import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import extension from "../src/extension.ts";

test("normal profile discovery does not register a delegation host inside a child", () => {
  const previous = process.env.PI_HC_RUN_DIR;
  process.env.PI_HC_RUN_DIR = "/child-run";
  let accesses = 0;
  try {
    extension(
      new Proxy({} as ExtensionAPI, {
        get() {
          accesses++;
          throw new Error("Child must not register a parent host");
        },
      }),
    );
    assert.equal(accesses, 0);
  } finally {
    if (previous === undefined) delete process.env.PI_HC_RUN_DIR;
    else process.env.PI_HC_RUN_DIR = previous;
  }
});
