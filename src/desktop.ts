import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { Config } from "./config.ts";

export function placementLabels(
  placement: Config["desktop"]["placement"],
  space: string | undefined,
  name: string,
): Record<string, string> {
  if (placement !== "tabs" || !space) return {};
  return {
    "herdr.space": space,
    "herdr.tab": `pihc-${randomUUID()}`,
    where: name,
  };
}

export async function nameDesktopTab(
  tab: string,
  name: string,
  signal: AbortSignal,
  env: NodeJS.ProcessEnv = process.env,
  command = "herdr-app",
): Promise<string | null> {
  for (let attempt = 0; attempt < 12 && !signal.aborted; attempt++) {
    const outcome = await new Promise<{
      ok: boolean;
      missing: boolean;
      message: string;
    }>((resolve) => {
      execFile(
        command,
        ["do", "tab.rename", JSON.stringify({ id: tab, name })],
        { env, signal, timeout: 1500, maxBuffer: 16_384 },
        (error, stdout, stderr) => {
          resolve({
            ok: !error,
            missing: error?.code === "ENOENT",
            message: (stderr || stdout || error?.message || "").slice(0, 300),
          });
        },
      );
    });
    if (outcome.ok || signal.aborted) return null;
    if (outcome.missing)
      return "herdr-app is not installed; terminal names still work in hc";
    if (attempt === 11)
      return `Desktop tab naming unavailable: ${outcome.message}`;
    // Label adoption is asynchronous. Rename only our preallocated tab; never select or create one here.
    try {
      await delay(200, undefined, { signal });
    } catch {
      return null;
    }
  }
  return null;
}
