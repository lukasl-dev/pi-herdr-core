#!/usr/bin/env node
import { createInterface } from "node:readline";
import { readFileSync, writeFileSync, watch } from "node:fs";
import { dirname } from "node:path";

const statePath = process.env.FAKE_HC_STATE;
const state = () => JSON.parse(readFileSync(statePath, "utf8"));
let subscribed = false;
let seq = 0;
function write(value) {
  process.stdout.write(JSON.stringify(value) + "\n");
}
function save(value) {
  writeFileSync(statePath, JSON.stringify(value));
}
watch(dirname(statePath), (_event, path) => {
  if (subscribed && String(path) === "core.json") {
    write({
      jsonrpc: "2.0",
      method: "missed",
      params: { seq: ++seq, terminals: state().terminals },
    });
  }
});

createInterface({ input: process.stdin }).on("line", (line) => {
  const { id, method, params } = JSON.parse(line);
  const reply = (result) => write({ jsonrpc: "2.0", id, result });
  const error = (kind) =>
    write({
      jsonrpc: "2.0",
      id,
      error: { code: -32000, message: kind, data: { kind } },
    });
  const data = state();
  if (method === "hello")
    return reply({
      generation: 1,
      methods: [
        "terminal.run",
        "terminal.get",
        "terminal.list",
        "terminal.kill",
        "terminal.interrupt",
        "events.subscribe",
      ],
    });
  if (method === "events.subscribe") {
    reply({ seq, terminals: data.terminals });
    subscribed = true;
  } else if (method === "terminal.list")
    reply({ terminals: data.terminals, hidden_finished: 0 });
  else if (method === "terminal.get") {
    const terminal = data.terminals.find((t) => t.address === params.terminal);
    return terminal ? reply(terminal) : error("not_found");
  } else if (method === "terminal.run") {
    if (
      data.terminals.some((t) => t.name === params.name && t.state === "live")
    )
      return error("name_taken");
    const terminal = {
      address: `t${data.terminals.length}`,
      state: "live",
      name: params.name,
      labels: params.labels,
      status: null,
      reason: null,
      exit_code: null,
      keep: params.keep,
    };
    data.terminals.push(terminal);
    data.launches.push(params);
    save(data);
    if (process.env.FAKE_HC_LOSE_LAUNCH_REPLY) process.exit(0);
    reply(terminal);
  } else if (method === "terminal.kill" || method === "terminal.interrupt") {
    const terminal = data.terminals.find((t) => t.address === params.terminal);
    if (!terminal) return error("not_found");
    data.actions.push({ method, terminal: params.terminal });
    if (method === "terminal.kill") {
      terminal.state = "finished";
      terminal.reason = "killed";
      terminal.exit_code = 0;
    } else terminal.status = { state: "idle" };
    save(data);
    reply(terminal);
  } else if (method === "echo") reply(params);
  else if (method === "error") error("fixture_error");
  else if (method === "malformed") process.stdout.write("not-json\n");
});
process.stdin.on("end", () => process.exit(0));
