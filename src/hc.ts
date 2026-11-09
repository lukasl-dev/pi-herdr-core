import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { object } from "./config.ts";

export class CoreError extends Error {
  readonly kind: string;
  constructor(kind: string, message: string) {
    super(message);
    this.kind = kind;
  }
}

export interface Terminal {
  address: string;
  state: "live" | "finished";
  name: string | null;
  labels: Record<string, string>;
  status: { state: string } | null;
  reason: string | null;
  exit_code: number | null;
  keep: boolean;
}

export function parseTerminal(value: unknown): Terminal {
  if (
    !object(value) ||
    typeof value.address !== "string" ||
    !(value.state === "live" || value.state === "finished") ||
    !(value.name === null || typeof value.name === "string") ||
    !object(value.labels) ||
    !Object.values(value.labels).every((v) => typeof v === "string") ||
    !(
      value.status === null ||
      (object(value.status) && typeof value.status.state === "string")
    ) ||
    !(value.reason === null || typeof value.reason === "string") ||
    !(value.exit_code === null || Number.isInteger(value.exit_code)) ||
    typeof value.keep !== "boolean"
  ) {
    throw new CoreError("protocol", "Invalid terminal record from hc");
  }
  return value as unknown as Terminal;
}

export interface CoreEvent {
  method: "event" | "heartbeat" | "missed";
  params: Record<string, unknown>;
}

export class RpcConnection extends EventEmitter {
  readonly process: ChildProcessWithoutNullStreams;
  #pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();
  #id = 0;
  #buffer = "";
  #stderr = "";
  #closed = false;

  constructor(command = "hc", env: NodeJS.ProcessEnv = process.env) {
    super();
    this.process = spawn(command, ["connect"], { env, stdio: "pipe" });
    this.process.stdout.setEncoding("utf8");
    this.process.stderr.setEncoding("utf8");
    this.process.stderr.on("data", (chunk: string) => {
      this.#stderr = (this.#stderr + chunk).slice(-4096);
    });
    this.process.stdout.on("data", (chunk: string) => this.#read(chunk));
    this.process.on("error", (error) => this.#fail(error));
    this.process.stdin.on("error", (error) => this.#fail(error));
    this.process.on("exit", (code, signal) =>
      this.#fail(
        new CoreError(
          "disconnected",
          `hc connect exited (${code ?? signal}): ${this.#stderr.trim()}`,
        ),
      ),
    );
  }

  request(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = 15_000,
  ): Promise<unknown> {
    if (this.#closed)
      return Promise.reject(
        new CoreError("disconnected", "hc connection is closed"),
      );
    const id = ++this.#id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(
          new CoreError(
            "timeout",
            `${method} timed out; a mutation may already have happened`,
          ),
        );
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      this.process.stdin.write(
        JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n",
      );
    });
  }

  close(): void {
    this.#fail(new CoreError("closed", "hc connection closed"));
    this.process.stdin.destroy();
    this.process.kill();
  }

  #read(chunk: string): void {
    this.#buffer += chunk;
    if (Buffer.byteLength(this.#buffer) > 16 * 1024 * 1024) {
      this.#fail(new CoreError("protocol", "hc message exceeds 16 MiB"));
      this.process.kill();
      return;
    }
    for (;;) {
      const end = this.#buffer.indexOf("\n");
      if (end < 0) return;
      const line = this.#buffer.slice(0, end);
      this.#buffer = this.#buffer.slice(end + 1);
      try {
        const message: unknown = JSON.parse(line);
        if (!object(message) || message.jsonrpc !== "2.0")
          throw new Error("Invalid JSON-RPC envelope");
        if (typeof message.id === "number") {
          const pending = this.#pending.get(message.id);
          if (!pending) continue;
          this.#pending.delete(message.id);
          clearTimeout(pending.timer);
          if (object(message.error)) {
            const data = object(message.error.data) ? message.error.data : {};
            pending.reject(
              new CoreError(
                String(data.kind ?? "rpc"),
                String(message.error.message),
              ),
            );
          } else if ("result" in message) pending.resolve(message.result);
          else
            pending.reject(
              new CoreError("protocol", "hc reply has no result or error"),
            );
        } else if (
          (message.method === "event" ||
            message.method === "heartbeat" ||
            message.method === "missed") &&
          object(message.params)
        ) {
          this.emit("notification", message as unknown as CoreEvent);
        }
      } catch (error) {
        this.#fail(
          new CoreError("protocol", `Invalid hc response: ${String(error)}`),
        );
        this.process.kill();
        return;
      }
    }
  }

  #fail(error: Error): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
    this.emit("disconnect", error);
  }
}

export class Core extends EventEmitter {
  readonly rpc: RpcConnection;
  readonly events: RpcConnection;
  #closed = false;

  constructor(command = "hc", env: NodeJS.ProcessEnv = process.env) {
    super();
    this.rpc = new RpcConnection(command, env);
    this.events = new RpcConnection(command, env);
    for (const connection of [this.rpc, this.events]) {
      connection.on("disconnect", (error: Error) => {
        if (!this.#closed) this.emit("disconnect", error);
      });
    }
    this.events.on("notification", (event: CoreEvent) =>
      this.emit("change", event),
    );
  }

  async start(owner: string): Promise<void> {
    const hello = await this.rpc.request("hello", { generation: 1 });
    const methods =
      object(hello) && hello.generation === 1 ? hello.methods : undefined;
    if (
      !Array.isArray(methods) ||
      ![
        "terminal.run",
        "terminal.get",
        "terminal.list",
        "terminal.kill",
        "terminal.interrupt",
        "events.subscribe",
      ].every((method) => methods.includes(method))
    ) {
      throw new CoreError(
        "incompatible",
        "hc does not provide the required generation-1 terminal API",
      );
    }
    await this.events.request("hello", { generation: 1 });
    await this.events.request("events.subscribe", {
      labels: { "pi-hc.owner": owner },
    });
  }

  async list(): Promise<Terminal[]> {
    const result = await this.rpc.request("terminal.list", { all: true });
    if (!object(result) || !Array.isArray(result.terminals))
      throw new CoreError("protocol", "Invalid terminal list");
    return result.terminals.map(parseTerminal);
  }

  async get(address: string): Promise<Terminal> {
    return parseTerminal(
      await this.rpc.request("terminal.get", { terminal: address }),
    );
  }

  close(): void {
    this.#closed = true;
    this.rpc.close();
    this.events.close();
  }
}
