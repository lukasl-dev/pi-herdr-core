import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { isAbsolute, join } from "node:path";
import {
  atomicJson,
  optionalJson,
  parseRun,
  type ChildResult,
} from "./artifacts.ts";
import { object } from "./config.ts";

export function completion(
  message: AssistantMessage | undefined,
): Pick<ChildResult, "outcome" | "text"> {
  if (!message)
    return {
      outcome: "failed",
      text: "Pi settled without an assistant response",
    };
  if (message.stopReason === "error" || message.stopReason === "aborted") {
    return {
      outcome: "failed",
      text: message.errorMessage || `Pi stopped: ${message.stopReason}`,
    };
  }
  return {
    outcome: "completed",
    text: message.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n"),
  };
}

export default function child(pi: ExtensionAPI): void {
  const directory = process.env.PI_HC_RUN_DIR ?? "";
  if (!directory || !isAbsolute(directory))
    throw new Error("Child bridge needs an absolute PI_HC_RUN_DIR");
  const value = optionalJson(join(directory, "run.json"));
  if (
    !object(value) ||
    typeof value.owner !== "string" ||
    typeof value.id !== "string"
  ) {
    throw new Error("Missing child run manifest");
  }
  const run = parseRun(value, value.owner, value.id);
  let last: AssistantMessage | undefined;
  let accepted = false;
  let published = optionalJson(join(directory, "result.json")) !== undefined;

  function publish(
    outcome: ChildResult["outcome"],
    text: string,
    session: string | undefined,
  ): void {
    if (published) return;
    atomicJson(join(directory, "result.json"), {
      version: 1,
      id: run.id,
      outcome,
      text:
        text.length > 200_000
          ? `${text.slice(0, 200_000)}\n\n[Report truncated; the full response remains in the child session.]`
          : text,
      session: session ?? null,
    } satisfies ChildResult);
    published = true;
  }

  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui")
      throw new Error("Delegated Pi must be interactive, not print/RPC mode");
    pi.setSessionName(run.name);
    atomicJson(join(directory, "ready.json"), {
      id: run.id,
      terminal: process.env.HC_TERMINAL_ID,
      session: ctx.sessionManager.getSessionFile() ?? null,
    });
  });
  pi.on("agent_start", (_event, ctx) => {
    accepted = true;
    last = undefined;
    atomicJson(join(directory, "accepted.json"), {
      id: run.id,
      session: ctx.sessionManager.getSessionFile() ?? null,
    });
  });
  pi.on("message_end", (event) => {
    if (event.message.role === "assistant") last = event.message;
  });
  pi.on("agent_settled", (event, ctx) => {
    if (!accepted || event.aborted || last?.stopReason === "aborted") return;
    const result = completion(last);
    publish(result.outcome, result.text, ctx.sessionManager.getSessionFile());
    ctx.shutdown();
  });
  pi.on("session_shutdown", (event, ctx) => {
    if (event.reason === "quit") {
      publish(
        "failed",
        "Child Pi exited before publishing a settled result",
        ctx.sessionManager.getSessionFile(),
      );
    }
  });
  pi.on("session_before_switch", () => ({ cancel: true }));
  pi.on("session_before_fork", () => ({ cancel: true }));
  pi.registerTool({
    name: "caller_ping",
    label: "Ask parent",
    description: "Report a blocker to your parent and end this task.",
    parameters: Type.Object({
      message: Type.String({ minLength: 1, maxLength: 16_000 }),
    }),
    async execute(_id, args, _signal, _update, ctx) {
      publish("help", args.message, ctx.sessionManager.getSessionFile());
      ctx.shutdown();
      return {
        content: [
          { type: "text", text: "Help request recorded for the parent." },
        ],
        details: undefined,
        terminate: true,
      };
    },
  });
}
