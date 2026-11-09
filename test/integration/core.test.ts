import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { EventEmitter, once } from "node:events";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  watch,
  writeFileSync,
  symlinkSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { parseConfig, object } from "../../src/config.ts";
import { Core, parseTerminal } from "../../src/hc.ts";
import { Host } from "../../src/host.ts";
import type { ChildResult, Run } from "../../src/artifacts.ts";

const cli = fileURLToPath(
  new URL(
    "../../node_modules/@earendil-works/pi-coding-agent/dist/cli.js",
    import.meta.url,
  ),
);
const extension = fileURLToPath(
  new URL("../../src/extension.ts", import.meta.url),
);

function shellArguments(args: readonly string[]): string {
  return args.map((arg) => `'${arg.replaceAll("'", "'\\''")}'`).join(" ");
}

async function setup(t: TestContext) {
  const cleanup: (() => void | Promise<void>)[] = [];
  t.after(async () => {
    const failures: unknown[] = [];
    for (const action of cleanup.reverse()) {
      try {
        await action();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length)
      throw new AggregateError(failures, "Isolated test cleanup failed");
  });
  const directory = mkdtempSync(join(tmpdir(), "pi-hc-integration-"));
  t.diagnostic(`Evidence retained in ${directory}`);
  const env: NodeJS.ProcessEnv = {
    ...Object.fromEntries(
      ["PATH", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL"].flatMap((key) =>
        process.env[key] ? [[key, process.env[key]]] : [],
      ),
    ),
    HOME: join(directory, "home"),
    XDG_CONFIG_HOME: join(directory, "config"),
    XDG_STATE_HOME: join(directory, "state"),
    XDG_DATA_HOME: join(directory, "data"),
    XDG_RUNTIME_DIR: join(directory, "runtime"),
    HERDR_APP_HOME: join(directory, "app"),
    PI_CODING_AGENT_DIR: join(directory, "agent"),
    PI_OFFLINE: "1",
    PI_SKIP_VERSION_CHECK: "1",
    PI_PROGRAM_STATUS: "1",
    HC_SESSION: `pihc-test-${directory.split("-").at(-1)}`,
  };
  for (const key of Object.keys(env))
    if (
      (key.startsWith("HC_") && key !== "HC_SESSION") ||
      key.startsWith("PI_HC_")
    )
      delete env[key];
  delete env.PI_PACKAGE_DIR;
  mkdirSync(env.HOME!, { recursive: true });
  mkdirSync(env.XDG_RUNTIME_DIR!, { recursive: true, mode: 0o700 });
  mkdirSync(env.PI_CODING_AGENT_DIR!, { recursive: true });
  const piCommand = [
    process.execPath,
    cli,
    "--no-skills",
    "--no-context-files",
    "--no-prompt-templates",
    "--no-themes",
    "--no-approve",
    "--offline",
  ];
  mkdirSync(join(directory, "bin"));
  writeFileSync(
    join(directory, "bin", "pi"),
    `#!/bin/sh\nexec ${shellArguments(piCommand)} "$@"\n`,
    { mode: 0o700 },
  );
  env.PATH = `${join(directory, "bin")}${delimiter}${env.PATH ?? ""}`;
  const requests: unknown[] = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += String(chunk);
    const payload: unknown = JSON.parse(body);
    requests.push(payload);
    const serialized = JSON.stringify(payload);
    const messages =
      object(payload) && Array.isArray(payload.messages)
        ? payload.messages
        : [];
    const parent = messages.some(
      (m: unknown) =>
        object(m) && JSON.stringify(m.content).includes("PARENT_TEST"),
    );
    const reported = serialized.includes("Child report:");
    const hasToolResult = messages.some(
      (m: unknown) => object(m) && m.role === "tool",
    );
    const slow = serialized.includes("SLOW_CHILD");
    const help = serialized.includes("HELP_CHILD");
    if (serialized.includes("FAIL_CHILD")) {
      response.writeHead(401, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          error: {
            message: "Fixture denied access",
            type: "authentication_error",
          },
        }),
      );
      return;
    }
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    const chunk = (delta: unknown, finish_reason: string | null = null) =>
      response.write(
        `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 0, model: "test", choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
      );
    chunk({ role: "assistant", content: "" });
    if ((parent && !reported && !hasToolResult) || help) {
      chunk({
        tool_calls: [
          {
            index: 0,
            id: "delegate",
            type: "function",
            function: {
              name: help ? "caller_ping" : "subagent",
              arguments: JSON.stringify(
                help
                  ? { message: "Need parent input" }
                  : {
                      task: "Return CHILD_RESULT_42",
                      model: "fixture/test",
                      thinking: "off",
                    },
              ),
            },
          },
        ],
      });
      chunk({}, "tool_calls");
    } else {
      chunk({
        content: parent
          ? reported
            ? "PARENT_RECEIVED_CHILD_RESULT_42"
            : "Waiting for child."
          : slow
            ? "Working..."
            : "CHILD_RESULT_42",
      });
      if (slow) return;
      chunk({}, "stop");
    }
    response.end("data: [DONE]\n\n");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanup.push(() => {
    server.closeAllConnections();
    server.close();
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  writeFileSync(
    join(env.PI_CODING_AGENT_DIR!, "models.json"),
    JSON.stringify({
      providers: {
        fixture: {
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          apiKey: "test-only",
          api: "openai-completions",
          models: [
            {
              id: "test",
              name: "Fixture",
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 128000,
              maxTokens: 1024,
            },
          ],
        },
      },
    }),
  );
  const core = new Core("hc", env);
  cleanup.push(() => {
    try {
      execFileSync("hc", ["server", "stop"], {
        env,
        timeout: 10_000,
        stdio: "pipe",
      });
    } finally {
      core.close();
    }
  });
  await core.start("test-controller");
  const parent = parseTerminal(
    await core.rpc.request("terminal.run", {
      argv: [process.execPath, "-e", "process.stdin.resume()"],
      cwd: directory,
      name: "test-parent",
      no_parent: true,
      no_notify: true,
      wait: false,
    }),
  );
  const events = new EventEmitter();
  const results: { run: Run; result: ChildResult }[] = [];
  const host = new Host({
    session: "test-parent",
    parent: parent.address,
    config: parseConfig({}),
    env,
    directory: env.PI_CODING_AGENT_DIR!,
    onChange: () => events.emit("change"),
    onProblem: (message) => t.diagnostic(message),
    onResult: (run, result) => {
      results.push({ run, result });
      events.emit("change");
    },
  });
  cleanup.push(() => host.shutdown(false));
  await host.start();
  const wait = async (predicate: () => boolean) => {
    while (!predicate())
      await once(events, "change", { signal: AbortSignal.timeout(25_000) });
  };
  return {
    directory,
    env,
    core,
    host,
    results,
    wait,
    piCommand,
    requests,
    addCleanup: (action: () => void | Promise<void>) => cleanup.push(action),
  };
}

test(
  "children retain the pi wrapper's environment, provider, theme, discovered extensions and MCP",
  { timeout: 180_000 },
  async (t) => {
    const f = await setup(t);
    const provider = join(f.directory, "wrapper-provider.ts");
    const themePath = join(f.directory, "wrapper-theme.json");
    const models = JSON.parse(
      readFileSync(join(f.env.PI_CODING_AGENT_DIR!, "models.json"), "utf8"),
    ) as { providers: { fixture: unknown } };
    writeFileSync(
      provider,
      `import {writeFileSync} from "node:fs";
      export default function(pi) {
        pi.registerProvider("wrapped-fixture", ${JSON.stringify(models.providers.fixture)});
        pi.on("agent_start", (_event, ctx) => writeFileSync(process.env.PI_HC_RUN_DIR + "/profile.json", JSON.stringify({
          marker: process.env.WRAPPER_ONLY, theme: ctx.ui.theme.name,
        })));
      }`,
    );
    const theme = JSON.parse(
      readFileSync(
        new URL(
          "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/dark.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ) as Record<string, unknown>;
    theme.name = "wrapper-fixture";
    writeFileSync(themePath, JSON.stringify(theme));
    const extensions = join(f.env.PI_CODING_AGENT_DIR!, "extensions");
    mkdirSync(extensions);
    symlinkSync(
      fileURLToPath(new URL("../../", import.meta.url)),
      join(extensions, "host-profile"),
      "dir",
    );
    writeFileSync(
      join(extensions, "sentinel.ts"),
      `import {Type} from "typebox";
      export default function(pi) { pi.registerTool({name: "profile_sentinel", label: "Profile", description: "Fixture only", parameters: Type.Object({}),
        async execute() { return {content: [{type: "text", text: "Profile tool"}], details: undefined}; }
      }); }`,
    );
    const mcp = {
      autoEnableCodemode: false,
      mcpServers: {
        profile: {
          command: process.execPath,
          args: [
            fileURLToPath(
              new URL("../fixtures/profile-mcp.mjs", import.meta.url),
            ),
          ],
          exposure: "direct",
        },
      },
    };
    const nixSource = process.env.PI_HC_TEST_PI_NIX;
    if (nixSource) {
      const expression = join(f.directory, "wrapper.nix");
      const system = `${process.arch === "arm64" ? "aarch64" : "x86_64"}-${process.platform === "darwin" ? "darwin" : "linux"}`;
      writeFileSync(
        expression,
        `let
        project = builtins.getFlake ${JSON.stringify(`git+file://${nixSource}`)};
        pkgs = project.inputs.nixpkgs.legacyPackages.${system};
      in (project.lib.mkCodingAgent { inherit pkgs; modules = [{ pi.coding-agent = {
        package = pkgs.writeShellScriptBin "pi" ${JSON.stringify(`exec ${shellArguments(f.piCommand)} "$@"`)};
        extensions = [ ${JSON.stringify(provider)} ];
        themes = [ (builtins.toPath ${JSON.stringify(themePath)}) ];
        environment.WRAPPER_ONLY.value = "pi-wrapper-loaded";
        settings.theme = "wrapper-fixture";
        mcp = builtins.fromJSON ${JSON.stringify(JSON.stringify(mcp))};
      }; }]; }).package`,
      );
      const outputs = JSON.parse(
        execFileSync(
          "nix",
          ["build", "--impure", "--no-link", "--json", "--file", expression],
          {
            env: f.env,
            encoding: "utf8",
            timeout: 120_000,
            maxBuffer: 4 * 1024 * 1024,
          },
        ),
      ) as { outputs: { out: string } }[];
      f.env.PATH = `${join(outputs[0]!.outputs.out, "bin")}${delimiter}${f.env.PATH ?? ""}`;
      t.diagnostic(`Actual pi.nix wrapper: ${outputs[0]!.outputs.out}`);
    } else {
      writeFileSync(
        join(f.directory, "bin", "pi"),
        `#!/bin/sh\nexport WRAPPER_ONLY=pi-wrapper-loaded\nexec ${shellArguments([...f.piCommand, "--extension", provider, "--theme", themePath])} "$@"\n`,
        { mode: 0o700 },
      );
      writeFileSync(
        join(f.env.PI_CODING_AGENT_DIR!, "settings.json"),
        JSON.stringify({ theme: "wrapper-fixture" }),
      );
      writeFileSync(
        join(f.env.PI_CODING_AGENT_DIR!, "mcp.json"),
        JSON.stringify(mcp),
      );
    }
    const run = await f.host.launch({
      task: "Return CHILD_RESULT_42",
      cwd: f.directory,
      model: "wrapped-fixture/test",
      thinking: "off",
    });
    await f.wait(() => f.results.length === 1);
    assert.equal(f.results[0]!.result.outcome, "completed");
    assert.equal(f.results[0]!.result.text, "CHILD_RESULT_42");
    assert.deepEqual(
      JSON.parse(
        readFileSync(join(f.host.root, run.id, "profile.json"), "utf8"),
      ),
      { marker: "pi-wrapper-loaded", theme: "wrapper-fixture" },
    );
    const request = f.requests[0];
    assert.ok(object(request) && Array.isArray(request.tools));
    const names = request.tools
      .filter(object)
      .map((tool) => (object(tool.function) ? tool.function.name : undefined));
    assert.ok(names.includes("profile_sentinel"));
    assert.ok(names.includes("mcp__profile__echo"));
    assert.ok(names.includes("caller_ping"));
    assert.ok(!names.includes("subagent"));
  },
);

test(
  "actual interactive Pi child reports its final answer and exits",
  { timeout: 45_000 },
  async (t) => {
    const f = await setup(t);
    const run = await f.host.launch({
      task: "Return CHILD_RESULT_42",
      cwd: f.directory,
      model: "fixture/test",
      thinking: "off",
    });
    t.diagnostic(`Child: ${run.name} (${run.terminal})`);
    await f.wait(() => f.results.length === 1);
    assert.equal(f.results[0]!.result.outcome, "completed");
    assert.equal(f.results[0]!.result.text, "CHILD_RESULT_42");
    assert.ok(f.results[0]!.result.session?.endsWith("session.jsonl"));
    assert.equal((await f.core.get(run.terminal!)).state, "finished");
    const ready = JSON.parse(
      readFileSync(join(f.host.root, run.id, "ready.json"), "utf8"),
    ) as Record<string, unknown>;
    assert.equal(ready.terminal, run.terminal);
    assert.equal(f.requests.length, 1);
  },
);

test(
  "native status, Escape interruption and cancellation against an actual interactive Pi",
  { timeout: 45_000 },
  async (t) => {
    const f = await setup(t);
    const run = await f.host.launch({
      task: "SLOW_CHILD",
      cwd: f.directory,
      model: "fixture/test",
      thinking: "off",
    });
    await f.wait(() => f.host.runs.get(run.id)?.status === "working");
    await f.host.interrupt(run.name);
    assert.equal((await f.core.get(run.terminal!)).state, "live");
    assert.equal(f.results.length, 0);
    const cancelled = await f.host.cancel(run.name);
    assert.equal(cancelled.confirmed, true);
    await f.wait(() => f.results.length === 1);
    assert.equal(f.results[0]!.result.outcome, "cancelled");
  },
);

test(
  "actual parent Pi receives one custom result and starts a follow-up turn",
  { timeout: 60_000 },
  async (t) => {
    const f = await setup(t);
    writeFileSync(
      join(f.env.PI_CODING_AGENT_DIR!, "herdr-core", "config.json"),
      JSON.stringify({
        desktop: { placement: "background" },
      }),
    );
    const session = join(f.directory, "parent-session.jsonl");
    const parent = parseTerminal(
      await f.core.rpc.request("terminal.run", {
        argv: [
          ...f.piCommand,
          "--no-extensions",
          "--no-mcp",
          "--extension",
          extension,
          "--provider",
          "fixture",
          "--model",
          "test",
          "--thinking",
          "off",
          "--session",
          session,
          "--",
          "PARENT_TEST: delegate the test task",
        ],
        cwd: f.directory,
        wait: false,
        no_parent: true,
        no_notify: true,
      }),
    );
    const watcher = watch(f.directory);
    try {
      const contains = () => {
        try {
          return readFileSync(session, "utf8").includes(
            "PARENT_RECEIVED_CHILD_RESULT_42",
          );
        } catch {
          return false;
        }
      };
      while (!contains())
        await once(watcher, "change", { signal: AbortSignal.timeout(30_000) });
      const entries = readFileSync(session, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      const reports = entries.filter(
        (e) =>
          e.type === "custom_message" && e.customType === "subagent_result",
      );
      assert.equal(reports.length, 1);
      assert.ok(object(reports[0]!.details));
      assert.equal(reports[0]!.details.outcome, "completed");
      const manifest = JSON.parse(
        readFileSync(
          join(String(reports[0]!.details.path), "run.json"),
          "utf8",
        ),
      ) as Record<string, unknown>;
      assert.equal(manifest.delivered, true);
    } finally {
      watcher.close();
      await f.core.rpc.request("terminal.kill", { terminal: parent.address });
    }
  },
);

test(
  "actual provider failure and help request retain their distinct outcomes",
  { timeout: 45_000 },
  async (t) => {
    const f = await setup(t);
    await f.host.launch({
      task: "FAIL_CHILD",
      cwd: f.directory,
      model: "fixture/test",
      thinking: "off",
    });
    await f.wait(() => f.results.length === 1);
    assert.equal(f.results[0]!.result.outcome, "failed");
    assert.match(f.results[0]!.result.text, /denied access/);
    await f.host.launch({
      task: "HELP_CHILD",
      cwd: f.directory,
      model: "fixture/test",
      thinking: "off",
    });
    await f.wait(() => f.results.length === 2);
    assert.equal(f.results[1]!.result.outcome, "help");
    assert.equal(f.results[1]!.result.text, "Need parent input");
  },
);

test(
  "live interactive child survives supervision reload and remains cancellable",
  { timeout: 45_000 },
  async (t) => {
    const f = await setup(t);
    const run = await f.host.launch({
      task: "SLOW_CHILD",
      cwd: f.directory,
      model: "fixture/test",
      thinking: "off",
    });
    await f.wait(() => f.host.runs.get(run.id)?.status === "working");
    await f.host.shutdown(true);
    assert.equal((await f.core.get(run.terminal!)).state, "live");
    const recovered = new Host(f.host.options);
    f.addCleanup(() => recovered.shutdown(false));
    await recovered.start();
    assert.equal(recovered.runs.get(run.id)?.terminal, run.terminal);
    assert.equal(recovered.runs.get(run.id)?.name, run.name);
    assert.equal((await recovered.cancel(run.id)).confirmed, true);
    await f.wait(() => f.results.length === 1);
    assert.equal(f.results[0]!.result.outcome, "cancelled");
  },
);
