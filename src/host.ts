import { createHash, randomUUID } from "node:crypto";
import {
  readdirSync,
  statSync,
  watch,
  writeFileSync,
  type FSWatcher,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  agentDirectory,
  executable,
  terminalName,
  type Config,
} from "./config.ts";
import {
  optionalJson,
  parseResult,
  parseRun,
  privateDirectory,
  runPath,
  saveRun,
  type ChildResult,
  type Run,
  type Thinking,
} from "./artifacts.ts";
import { Core, CoreError, parseTerminal, type Terminal } from "./hc.ts";
import { nameDesktopTab, placementLabels } from "./desktop.ts";

export interface Launch {
  task: string;
  name?: string;
  cwd: string;
  model: string;
  thinking: Thinking;
}

export interface HostOptions {
  session: string;
  parent: string;
  config: Config;
  directory?: string;
  env?: NodeJS.ProcessEnv;
  hc?: string;
  app?: string;
  onResult: (run: Run, result: ChildResult, path: string) => void;
  onChange?: () => void;
  onProblem?: (message: string) => void;
}

const hostLabel = "pi-herdr-core";

export class Host {
  readonly owner: string;
  readonly root: string;
  readonly runs = new Map<string, Run>();
  readonly options: HostOptions;
  problem: string | undefined;
  #core: Core | undefined;
  #watcher: FSWatcher | undefined;
  #queue: Promise<unknown> = Promise.resolve();
  #queued = new Set<string>();
  #closed = false;
  #stopping = false;
  #reconnect: NodeJS.Timeout | undefined;
  #scheduled = false;
  #backoff = 500;
  #desktop = new AbortController();
  #namedTabs = new Set<string>();
  #shutdown: Promise<void> | undefined;

  constructor(options: HostOptions) {
    if (options.parent.includes("/"))
      throw new Error("Remote parent addresses are not supported");
    this.options = options;
    this.owner = createHash("sha256")
      .update(`${options.session}\0${options.parent}`)
      .digest("hex")
      .slice(0, 24);
    this.root = join(
      options.directory ?? agentDirectory(options.env),
      "herdr-core",
      "runs",
      this.owner,
    );
  }

  async start(delivered: ReadonlySet<string> = new Set()): Promise<void> {
    if (this.#closed || this.#stopping)
      throw new Error("Cannot restart a closed host instance");
    privateDirectory(this.root);
    for (const entry of readdirSync(this.root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^[0-9a-f-]{36}$/.test(entry.name)) continue;
      const run = parseRun(
        optionalJson(join(this.root, entry.name, "run.json")),
        this.owner,
        entry.name,
      );
      if (delivered.has(run.id)) run.delivered = true;
      this.runs.set(run.id, run);
    }
    this.#watcher = watch(this.root, { recursive: true }, (_event, path) => {
      if (
        path &&
        ["result.json", "ready.json", "accepted.json"].includes(
          basename(String(path)),
        )
      )
        this.#schedule();
    });
    this.#watcher.on("error", (error) =>
      this.#problem(`Artifact watch failed: ${error.message}`),
    );
    await this.#serial(() => this.#connect());
  }

  get active(): boolean {
    return [...this.runs.values()].some(
      (r) => r.phase !== "finished" || !r.delivered,
    );
  }

  launch(input: Launch): Promise<Run> {
    return this.#serial(async () => {
      if (this.#closed || this.#stopping)
        throw new Error("Agent host is shutting down");
      const core = this.#requireCore();
      const slash = input.model.indexOf("/");
      if (slash < 1 || slash === input.model.length - 1)
        throw new Error("Model must be an exact provider/model-id");
      const cwd = resolve(input.cwd);
      if (!statSync(cwd).isDirectory())
        throw new Error(`Not a directory: ${cwd}`);
      if (!input.task.trim() || input.task.length > 100_000)
        throw new Error("Task must contain 1–100000 characters");
      if (
        input.name &&
        (input.name.length > 80 || /[\r\n\x00-\x1f]/.test(input.name))
      ) {
        throw new Error("Task labels must be at most 80 printable characters");
      }
      const command = this.options.config.piCommand;
      const program = executable(command[0]!, this.options.env);
      const parent = await core.get(this.options.parent);
      const used = new Set(
        (await core.list())
          .filter((t) => t.state === "live")
          .flatMap((t) => (t.name ? [t.name] : [])),
      );
      for (const run of this.runs.values()) used.add(run.name);
      const run: Run = {
        version: 1,
        id: randomUUID(),
        owner: this.owner,
        name: terminalName(this.options.config.terminal, input.name, used),
        taskName: input.name ?? "",
        cwd,
        model: input.model,
        thinking: input.thinking,
        created: Date.now(),
        terminal: null,
        cancelled: false,
        delivered: false,
        phase: "starting",
        status: null,
        desktopNamed: false,
        desktopNote: null,
        problem: null,
        result: null,
      };
      const directory = runPath(this.root, run);
      privateDirectory(directory);
      saveRun(this.root, run);
      writeFileSync(
        join(directory, "task.md"),
        `${input.task}\n\nYou are a delegated child. Do not launch other agents. ` +
          `Do not push, merge, deploy or remove worktrees unless the task explicitly authorizes it. ` +
          `Give your final answer normally; the host delivers it automatically. ` +
          `Use caller_ping if blocked.\n`,
        { mode: 0o600, flag: "wx" },
      );
      this.runs.set(run.id, run);
      this.options.onChange?.();
      const env: Record<string, string> = {
        PI_HC_RUN_DIR: directory,
        PI_CODING_AGENT_DIR:
          this.options.directory ?? agentDirectory(this.options.env),
        PI_PACKAGE_DIR: "",
        PI_PROGRAM_STATUS: "1",
      };
      if (this.options.env?.PATH ?? process.env.PATH)
        env.PATH = (this.options.env?.PATH ?? process.env.PATH)!;
      const labels = {
        "pi-hc.host": hostLabel,
        "pi-hc.owner": this.owner,
        "pi-hc.run": run.id,
        ...placementLabels(
          this.options.config.desktop.placement,
          parent.labels["herdr.space"],
          run.name,
        ),
      };
      try {
        let value: unknown;
        for (let attempt = 0; attempt < 8; attempt++) {
          try {
            value = await core.rpc.request("terminal.run", {
              argv: [
                program,
                ...command.slice(1),
                "--extension",
                fileURLToPath(new URL("child.ts", import.meta.url)),
                "--provider",
                input.model.slice(0, slash),
                "--model",
                input.model.slice(slash + 1),
                "--thinking",
                input.thinking,
                "--name",
                run.name,
                "--session",
                join(directory, "session.jsonl"),
                "--",
                `@${join(directory, "task.md")}`,
              ],
              cwd,
              env,
              labels,
              name: run.name,
              caller: this.options.parent,
              parent: this.options.parent,
              wait: false,
              keep: false,
              rm: false,
              no_notify: true,
              outlive_parent: false,
            });
            break;
          } catch (error) {
            if (
              !(error instanceof CoreError) ||
              error.kind !== "name_taken" ||
              attempt === 7 ||
              (this.options.config.terminal.naming === "task" && input.name)
            )
              throw error;
            used.add(run.name);
            run.name = terminalName(
              this.options.config.terminal,
              input.name,
              used,
            );
            if ("where" in labels) labels.where = run.name;
            saveRun(this.root, run);
          }
        }
        const terminal = parseTerminal(value);
        if (!this.#owns(terminal, run))
          throw new Error("hc launch returned mismatched ownership labels");
        run.terminal = terminal.address;
      } catch (error) {
        run.problem = error instanceof Error ? error.message : String(error);
        if (
          error instanceof CoreError &&
          [
            "name_taken",
            "spawn_failed",
            "invalid_params",
            "config",
            "invalid_template",
          ].includes(error.kind)
        ) {
          run.phase = "finished";
          run.result = {
            version: 1,
            id: run.id,
            outcome: "failed",
            text: run.problem,
            session: null,
          };
        } else run.phase = "uncertain";
      }
      saveRun(this.root, run);
      this.#schedule();
      return structuredClone(run);
    });
  }

  interrupt(target: string): Promise<unknown> {
    return this.#serial(async () => {
      const run = this.#find(target);
      if (run.phase === "finished")
        throw new Error(`${run.name} already finished`);
      if (run.cancelled) throw new Error(`${run.name} is being cancelled`);
      const terminal = await this.#ownedTerminal(run);
      const result = await this.#requireCore().rpc.request(
        "terminal.interrupt",
        { terminal: terminal.address, timeout: 2 },
        5000,
      );
      run.phase = "interrupted";
      saveRun(this.root, run);
      this.options.onChange?.();
      return result;
    });
  }

  cancel(target: string): Promise<{ confirmed: boolean; run: Run }> {
    return this.#serial(async () => {
      const run = this.#find(target);
      if (run.phase === "finished")
        return { confirmed: true, run: structuredClone(run) };
      const confirmed = await this.#cancelRun(run);
      this.#schedule();
      return { confirmed, run: structuredClone(run) };
    });
  }

  acknowledge(id: string): Promise<void> {
    return this.#serial(async () => {
      const run = this.runs.get(id);
      if (!run?.result || run.delivered) return;
      run.delivered = true;
      saveRun(this.root, run);
      this.options.onChange?.();
    });
  }

  shutdown(preserve: boolean): Promise<void> {
    return (this.#shutdown ??= this.#end(preserve));
  }

  async #end(preserve: boolean): Promise<void> {
    this.#stopping = true;
    const failures: unknown[] = [];
    try {
      if (!preserve) {
        for (const run of this.runs.values()) {
          if (run.phase === "finished") continue;
          try {
            await this.cancel(run.id);
          } catch (error) {
            failures.push(error);
          }
        }
      }
    } finally {
      this.#closed = true;
      this.#desktop.abort();
      if (this.#reconnect) clearTimeout(this.#reconnect);
      this.#watcher?.close();
      this.#core?.close();
      this.#core = undefined;
      await this.#queue;
    }
    if (failures.length)
      throw new AggregateError(
        failures,
        "Some child cancellations could not be recorded during shutdown",
      );
  }

  #serial<T>(work: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(work);
    this.#queue = result.catch(() => {});
    return result;
  }

  async #connect(): Promise<void> {
    if (this.#closed || this.#stopping) return;
    const core = new Core(this.options.hc ?? "hc", this.options.env);
    try {
      await core.start(this.owner);
      if (this.#closed) {
        core.close();
        return;
      }
      this.#core = core;
      this.#backoff = 500;
      this.problem = undefined;
      core.on("change", () => this.#schedule());
      core.on("disconnect", (error: Error) => {
        if (this.#core !== core) return;
        this.#core = undefined;
        core.close();
        this.#problem(error.message);
        this.#retryConnect();
      });
      await this.#reconcile();
    } catch (error) {
      core.close();
      this.#problem(error instanceof Error ? error.message : String(error));
      this.#retryConnect();
    }
  }

  #retryConnect(): void {
    if (this.#closed || this.#stopping || this.#reconnect) return;
    this.#reconnect = setTimeout(() => {
      this.#reconnect = undefined;
      void this.#serial(() => this.#connect());
    }, this.#backoff);
    this.#reconnect.unref();
    this.#backoff = Math.min(10_000, this.#backoff * 2);
  }

  #schedule(): void {
    if (this.#closed || this.#stopping || this.#scheduled) return;
    this.#scheduled = true;
    setImmediate(() => {
      this.#scheduled = false;
      if (!this.#closed && !this.#stopping)
        void this.#serial(() => this.#reconcile()).catch((e: unknown) =>
          this.#problem(String(e)),
        );
    });
  }

  async #reconcile(): Promise<void> {
    if (!this.#core || this.#closed || this.#stopping) return;
    const terminals = await this.#core.list();
    for (const run of this.runs.values()) {
      try {
        if (run.phase === "finished") {
          this.#deliver(run);
          continue;
        }
        const matches = terminals.filter((terminal) =>
          this.#owns(terminal, run),
        );
        if (
          matches.length !== 1 ||
          (run.terminal && matches[0]?.address !== run.terminal)
        ) {
          run.problem =
            "Cannot uniquely reconcile this run's terminal; no automatic relaunch or kill";
          saveRun(this.root, run);
          continue;
        }
        const terminal = matches[0]!;
        run.terminal = terminal.address;
        run.status = terminal.status?.state ?? null;
        run.problem = null;
        if (run.cancelled && terminal.state === "live") {
          await this.#cancelRun(run);
          this.#deliver(run);
          continue;
        }
        const tab = terminal.labels["herdr.tab"];
        if (
          this.options.config.desktop.placement === "tabs" &&
          terminal.state === "live" &&
          tab?.startsWith("pihc-") &&
          !run.desktopNamed &&
          !this.#namedTabs.has(run.id)
        ) {
          this.#namedTabs.add(run.id);
          void nameDesktopTab(
            tab,
            run.name,
            this.#desktop.signal,
            this.options.env,
            this.options.app,
          )
            .then((note) => {
              if (this.#closed || this.#desktop.signal.aborted) return;
              return this.#serial(async () => {
                if (this.#closed) return;
                run.desktopNamed = note === null;
                run.desktopNote = note;
                saveRun(this.root, run);
                this.options.onChange?.();
              });
            })
            .catch((error: unknown) => this.#problem(String(error)));
        }
        const payload = optionalJson(
          join(runPath(this.root, run), "result.json"),
        );
        if (!run.cancelled && payload !== undefined) {
          run.result = parseResult(payload, run.id);
          run.phase = "finalizing";
        }
        if (terminal.state === "finished") {
          if (run.cancelled)
            this.#finish(run, "cancelled", "Cancelled by parent");
          else if (run.result) {
            run.phase = "finished";
            run.problem = null;
          } else
            this.#finish(
              run,
              "failed",
              `Terminal ended without a result (${terminal.reason}, exit ${terminal.exit_code})`,
            );
        } else if (run.phase === "starting" || run.phase === "uncertain") {
          const accepted = optionalJson(
            join(runPath(this.root, run), "accepted.json"),
          );
          if (
            typeof accepted === "object" &&
            accepted !== null &&
            "id" in accepted &&
            accepted.id === run.id
          )
            run.phase = "running";
        }
        saveRun(this.root, run);
        this.#deliver(run);
      } catch (error) {
        run.problem = `Could not reconcile this run: ${String(error)}`;
        saveRun(this.root, run);
      }
    }
    this.options.onChange?.();
  }

  async #cancelRun(run: Run): Promise<boolean> {
    run.cancelled = true;
    saveRun(this.root, run);
    try {
      const terminal = await this.#ownedTerminal(run);
      const observed = parseTerminal(
        await this.#requireCore().rpc.request(
          "terminal.kill",
          { terminal: terminal.address },
          10_000,
        ),
      );
      if (!this.#owns(observed, run))
        throw new Error("hc kill returned mismatched ownership labels");
      if (observed.state === "finished")
        this.#finish(run, "cancelled", "Cancelled by parent");
      else run.problem = "Cancellation not yet confirmed by hc";
    } catch (error) {
      run.problem = `Cancellation unconfirmed: ${error instanceof Error ? error.message : String(error)}`;
    }
    saveRun(this.root, run);
    return run.phase === "finished";
  }

  #finish(run: Run, outcome: ChildResult["outcome"], text: string): void {
    run.phase = "finished";
    run.problem = null;
    run.result = {
      version: 1,
      id: run.id,
      outcome,
      text,
      session: run.result?.session ?? null,
    };
  }

  #deliver(run: Run): void {
    if (
      this.#stopping ||
      run.phase !== "finished" ||
      !run.result ||
      run.delivered ||
      this.#queued.has(run.id)
    )
      return;
    this.#queued.add(run.id);
    try {
      this.options.onResult(
        structuredClone(run),
        run.result,
        runPath(this.root, run),
      );
    } catch (error) {
      this.#queued.delete(run.id);
      this.#problem(`Result delivery failed: ${String(error)}`);
    }
  }

  #owns(terminal: Terminal, run: Run): boolean {
    return (
      !terminal.address.includes("/") &&
      terminal.labels["pi-hc.host"] === hostLabel &&
      terminal.labels["pi-hc.owner"] === this.owner &&
      terminal.labels["pi-hc.run"] === run.id
    );
  }

  async #ownedTerminal(run: Run): Promise<Terminal> {
    if (!run.terminal)
      throw new Error(
        "Terminal acquisition is unresolved; inspect the run before retrying",
      );
    const terminal = await this.#requireCore().get(run.terminal);
    if (!this.#owns(terminal, run))
      throw new Error("Terminal ownership changed; refusing to control it");
    return terminal;
  }

  #find(target: string): Run {
    const matches = [...this.runs.values()].filter(
      (run) => run.id === target || run.name === target,
    );
    if (matches.length !== 1)
      throw new Error(`Unknown or ambiguous owned agent: ${target}`);
    return matches[0]!;
  }

  #requireCore(): Core {
    if (!this.#core) throw new Error(this.problem ?? "hc is not connected");
    return this.#core;
  }

  #problem(message: string): void {
    if (this.#closed || this.#stopping) return;
    this.problem = message;
    this.options.onProblem?.(message);
    this.options.onChange?.();
  }
}
