import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { object } from "./config.ts";

export type Outcome = "completed" | "failed" | "cancelled" | "help";
export type Thinking =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";
export const thinkingLevels: readonly Thinking[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

export interface ChildResult {
  version: 1;
  id: string;
  outcome: Outcome;
  text: string;
  session: string | null;
}

export interface Run {
  version: 1;
  id: string;
  owner: string;
  name: string;
  taskName: string;
  cwd: string;
  model: string;
  thinking: Thinking;
  created: number;
  terminal: string | null;
  cancelled: boolean;
  delivered: boolean;
  phase:
    | "starting"
    | "running"
    | "interrupted"
    | "uncertain"
    | "finalizing"
    | "finished";
  status: string | null;
  desktopNamed: boolean;
  desktopNote: string | null;
  problem: string | null;
  result: ChildResult | null;
}

export function privateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const info = statSync(path);
  if (
    (process.getuid && info.uid !== process.getuid()) ||
    (info.mode & 0o077) !== 0
  ) {
    throw new Error(
      `Agent state directory must be owned by you and private (0700): ${path}`,
    );
  }
}

export function atomicJson(path: string, value: unknown): void {
  const temporary = join(dirname(path), `.write-${randomUUID()}`);
  writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", {
    mode: 0o600,
    flag: "wx",
  });
  renameSync(temporary, path);
}

export function readJson(path: string, maximum = 1024 * 1024): unknown {
  if (statSync(path).size > maximum)
    throw new Error(`Agent artifact exceeds ${maximum} bytes: ${path}`);
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

export function optionalJson(path: string): unknown {
  try {
    return readJson(path);
  } catch (error) {
    if (object(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
}

export function parseResult(value: unknown, id: string): ChildResult {
  if (
    !object(value) ||
    value.version !== 1 ||
    value.id !== id ||
    !["completed", "failed", "cancelled", "help"].includes(
      String(value.outcome),
    ) ||
    typeof value.text !== "string" ||
    !(value.session === null || typeof value.session === "string")
  ) {
    throw new Error(`Invalid result artifact for run ${id}`);
  }
  return value as unknown as ChildResult;
}

export function parseRun(value: unknown, owner: string, id: string): Run {
  if (
    !object(value) ||
    value.version !== 1 ||
    value.owner !== owner ||
    value.id !== id ||
    !["name", "taskName", "cwd", "model"].every(
      (k) => typeof value[k] === "string",
    ) ||
    !thinkingLevels.includes(value.thinking as Thinking) ||
    typeof value.created !== "number" ||
    !(value.terminal === null || typeof value.terminal === "string") ||
    typeof value.cancelled !== "boolean" ||
    typeof value.delivered !== "boolean" ||
    ![
      "starting",
      "running",
      "interrupted",
      "uncertain",
      "finalizing",
      "finished",
    ].includes(String(value.phase)) ||
    !(value.status === null || typeof value.status === "string") ||
    typeof value.desktopNamed !== "boolean" ||
    !(
      value.desktopNote === undefined ||
      value.desktopNote === null ||
      typeof value.desktopNote === "string"
    ) ||
    !(value.problem === null || typeof value.problem === "string")
  ) {
    throw new Error(`Invalid run manifest: ${id}`);
  }
  if (value.result !== null) parseResult(value.result, id);
  return { ...value, desktopNote: value.desktopNote ?? null } as unknown as Run;
}

export function runPath(root: string, run: Pick<Run, "id">): string {
  return join(root, run.id);
}

export function saveRun(root: string, run: Run): void {
  const path = join(runPath(root, run), "run.json");
  if (JSON.stringify(optionalJson(path)) !== JSON.stringify(run))
    atomicJson(path, run);
}
