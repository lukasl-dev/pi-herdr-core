import { randomInt } from "node:crypto";
import { accessSync, constants, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join, resolve } from "node:path";

export interface Config {
  terminal: { naming: "random" | "task"; prefix: string };
  desktop: { placement: "tabs" | "background" };
  piCommand: string[];
}

export function agentDirectory(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"));
}

export function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseConfig(value: unknown): Config {
  if (!object(value)) throw new Error("Configuration must be a JSON object");
  for (const key of Object.keys(value)) {
    if (!["terminal", "desktop", "piCommand"].includes(key)) {
      throw new Error(`Unknown configuration key: ${key}`);
    }
  }
  const terminal = value.terminal ?? {};
  const desktop = value.desktop ?? {};
  if (!object(terminal) || !object(desktop)) {
    throw new Error("terminal and desktop must be objects");
  }
  if (Object.keys(terminal).some((k) => !["naming", "prefix"].includes(k))) {
    throw new Error("Unknown terminal option (supported: naming, prefix)");
  }
  if (Object.keys(desktop).some((k) => k !== "placement")) {
    throw new Error("Unknown desktop option (supported: placement)");
  }
  const naming = terminal.naming ?? "random";
  const prefix = terminal.prefix ?? "";
  const placement = desktop.placement ?? "tabs";
  const piCommand = value.piCommand ?? ["pi"];
  if (naming !== "random" && naming !== "task") {
    throw new Error("terminal.naming must be random or task");
  }
  if (
    typeof prefix !== "string" ||
    !/^(?:[a-z0-9][a-z0-9-]{0,11})?$/.test(prefix)
  ) {
    throw new Error(
      "terminal.prefix needs 0–12 lowercase letters, digits or hyphens; nonempty prefixes must start with a letter or digit",
    );
  }
  if (placement !== "tabs" && placement !== "background") {
    throw new Error("desktop.placement must be tabs or background");
  }
  if (
    !Array.isArray(piCommand) ||
    !piCommand.length ||
    !piCommand.every(
      (v) => typeof v === "string" && v.length > 0 && !v.includes("\0"),
    )
  ) {
    throw new Error("piCommand must be a nonempty executable/argument array");
  }
  return { terminal: { naming, prefix }, desktop: { placement }, piCommand };
}

export function readConfig(directory = agentDirectory()): Config {
  const path = join(directory, "herdr-core", "config.json");
  try {
    return parseConfig(JSON.parse(readFileSync(path, "utf8")) as unknown);
  } catch (error) {
    if (object(error) && error.code === "ENOENT") return parseConfig({});
    throw new Error(
      `Cannot load ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

const first = [
  "amber",
  "birch",
  "blue",
  "brisk",
  "calm",
  "cedar",
  "clear",
  "coral",
  "dawn",
  "dusk",
  "fern",
  "flint",
  "fog",
  "gold",
  "green",
  "haze",
  "jade",
  "lake",
  "leaf",
  "lime",
  "mint",
  "mist",
  "moss",
  "opal",
  "pine",
  "plum",
  "quiet",
  "reed",
  "rose",
  "sage",
  "soft",
  "swift",
];
const second = [
  "bear",
  "bee",
  "bird",
  "crab",
  "crow",
  "deer",
  "dove",
  "duck",
  "elk",
  "finch",
  "fox",
  "frog",
  "gull",
  "hare",
  "hawk",
  "ibis",
  "jay",
  "kite",
  "lark",
  "lynx",
  "moth",
  "newt",
  "owl",
  "pike",
  "puma",
  "seal",
  "swan",
  "tern",
  "toad",
  "vole",
  "wolf",
  "wren",
];

export function terminalName(
  config: Config["terminal"],
  taskName: string | undefined,
  used: ReadonlySet<string>,
  pick: (max: number) => number = randomInt,
): string {
  if (config.naming === "task" && taskName) {
    const name = config.prefix + taskName;
    validateName(name);
    if (used.has(name))
      throw new Error(`Terminal name is already used: ${name}`);
    return name;
  }
  for (let i = 0; i < 32; i++) {
    const name = `${config.prefix}${first[pick(first.length)]}-${second[pick(second.length)]}`;
    if (!used.has(name)) return name;
  }
  throw new Error("Cannot allocate a unique short terminal name; try again");
}

export function validateName(name: string): void {
  if (!/^[a-z0-9][a-z0-9._-]{0,31}$/.test(name)) {
    throw new Error(
      "Terminal names need 1–32 lowercase letters, digits, dots, hyphens or underscores",
    );
  }
}

export function executable(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const candidates =
    isAbsolute(command) || command.includes("/")
      ? [resolve(command)]
      : (env.PATH ?? "")
          .split(delimiter)
          .filter(Boolean)
          .map((p) => join(p, command));
  for (const path of candidates) {
    try {
      accessSync(path, constants.X_OK);
      return path;
    } catch {
      /* try the next PATH entry */
    }
  }
  throw new Error(
    `Executable not found: ${command}. Set piCommand to its absolute executable/argv.`,
  );
}
