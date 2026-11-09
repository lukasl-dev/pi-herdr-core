# Pi agents on herdr-core

**Status: implementation started.** The initial vertical slice is authorised;
installation, publication and later checkpoints remain separate.

## Direction

Build `pi-herdr-core`: an hc-native Pi extension for asynchronous,
inspectable child agents. Keep the useful interaction model of
`pi-herdr-agents`, without reproducing its pane/workspace machinery or its
entire configuration surface.

Each child is a real interactive Pi process in an hc terminal. The parent can
continue working, receives a structured result automatically, and can interrupt
or cancel its children. A person can attach to a child's terminal at any time.

**Core owns terminals. The extension owns tasks. The desktop owns layout.**

### Naming and placement (approved refinement)

Do not reproduce a forced shared “Agents” tab. Default to one terminal per agent,
with a short random word-pair name such as `moss-fox`. Keep a semantic task label
separate from that identity. Naming is configurable (`random` or `task`, optional
prefix), as is Desktop placement (`tabs` or `background`). When the parent has a
Desktop space, tabs use that space, each with its own generated ID and name,
without changing focus. Headless execution remains independent of the desktop.

## What changed upstream

| Component                    | Relevant responsibility                                                                                                |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `herdrdev/herdr` / `herdr`   | Older terminal multiplexer, with panes, tabs, workspaces, agent detection and plugins. Its repository is not archived. |
| `herdrdev/herdr-core` / `hc` | Headless persistent terminals, parent–child relationships, labels, events, input, interruption and termination.        |
| Herdr Desktop / `herdr-app`  | A graphical client with its own spaces, tabs and layouts; not a requirement for this extension.                        |

This is not a CLI rename. Core does not provide the old workspace/worktree API,
and it does not infer agent status from terminal text. Programs report status
through OSC 7501. The inspected Pi distribution already implements that reporting,
including working, blocked, done and error states. Do not add a second reporter.

Core also already supports delegation using templates, `hc send` and parent
notifications. The extension's extra value is **Pi-aware task results, automatic
parent wake-up, role/model selection, and controlled checkout/lifecycle handling**,
not another generic wrapper around every hc command.

## First release

### Include

- Asynchronous launch: acknowledge acquisition, then deliver the result later.
- Interactive children with explicit cwd, exact model ID and thinking level.
- Bare tasks and optional Markdown roles from `.pi/agents/` and the user's
  agent directory. A missing role fails before creating resources.
- A small parent status widget and an inspection command.
- Separate interrupt and cancel operations.
- Local Git worktrees as an explicit launch option, retained after completion.
- Recovery of owned runs across `/reload`, with durable task/result records.
- Leaves by default: children cannot delegate through this extension unless a
  future feature explicitly permits it.

### Defer

- Persistent specialists and sequential follow-up tasks.
- Full-context forks and resuming arbitrary historical child sessions.
- Model fallback lists, task-model rankings and automatic preference writers.
- Accept-check/retry orchestration and workflow engines.
- Remote launches, cross-machine artifact transport and machine provisioning.
- Desktop mods, split/group placement and sidebar filtering. Separate-tab label
  placement and tab naming are included by the approved refinement above.
- Compatibility with the old `herdr` backend.

These are separate additions, not compatibility promises hidden inside v0.1.

## User-facing surface

Keep familiar tool names, but do not claim complete upstream API compatibility:

| Tool                 | Meaning                                                                                              |
| -------------------- | ---------------------------------------------------------------------------------------------------- |
| `subagent`           | Start one asynchronous child; optionally use a role or worktree.                                     |
| `subagent_interrupt` | Stop its current turn, leaving Pi open.                                                              |
| `subagent_cancel`    | Record cancellation intent, terminate the owned terminal program, then confirm the observed outcome. |
| `subagents_list`     | Inspect roles and owned runs; not needed to wait for completion.                                     |
| `worktree_list`      | Inspect retained, extension-managed worktrees.                                                       |
| `worktree_remove`    | Explicit guarded removal, never automatic cleanup.                                                   |

Children get `caller_ping` for a structured help request. Ordinary completion
does not depend on the model remembering to call a reporting tool.

Example proposed call:

```typescript
subagent({
  name: "login-review",
  task: "Review the login diff. Do not edit files or launch other agents.",
  model: "openai/gpt-6.1-terra",
  thinking: "high",
});
```

Expose `/subagent` for manual launch/list/inspection and
`/subagent doctor` for dependency and connection diagnostics. Inspection should
show the terminal address, task state, model, cwd, session path and any worktree.
People can attach with `hc attach <address>` or open it in their desktop client.

Because tool names overlap, **load only one delegation host in a Pi session**.
Installing both packages for different sessions is fine; detect conflicting
registration where possible and give an actionable error. Do not silently change
which backend an existing tool controls.

## Architecture

```text
Parent Pi extension
  ├─ validates launch, role, model and checkout
  ├─ records task identity and owned resources
  ├─ hc connect → JSON-RPC requests
  ├─ hc connect → filtered event subscription
  └─ result delivery → Pi custom message, triggering a parent turn
             │
             └─ hc terminal: interactive Pi + child bridge
                    ├─ Pi's native OSC 7501 status
                    ├─ private task/result artifacts
                    └─ final answer + structured outcome + Pi session path
```

### Core connection

Use `hc connect` with newline-delimited JSON-RPC rather than hardcoded socket
paths or parsing human CLI output. This leaves endpoint discovery and platform
differences with hc. Plain mode suffices: requests use one connection, and an
event subscription uses another. We do not need framed terminal attachment.

Handshake with `hello`, check generation/method support, and consume a small,
validated subset of the published schema. Subscribe before launching. On
reconnect or `missed`, reconcile from a fresh snapshot and the durable run ledger;
sequence numbers are not continuous across core restarts.

Launch through `terminal.run` with an executable/argv, explicit cwd and labels
for host, owner and run ID. Resolve the Pi executable deliberately, including
Nix wrappers; do not assume the core daemon has the parent's current PATH.
Handle required launch environment explicitly without copying secrets into labels
or persistent launch diagnostics.

Set `wait: false`, `keep: false`, `rm: false` and `no_notify: true`. Keep the
parent link, but suppress core's automatic typed parent notes **for our children
only**: the extension delivers their results through Pi instead. Do not change
the user's global hc notification settings.

### Task and result transport

Use private local artifact directories and a small child extension, not screen
scraping or `hc send` to inject a result into the parent's editor.

1. Allocate an immutable run ID and persist launch intent before creating a terminal.
2. Pass the task by file and load the child bridge explicitly. Avoid prompt text
   in shell command construction. A child-ready/task-accepted record distinguishes
   process creation from successful task delivery.
3. At Pi's settled boundary, the bridge atomically records the final answer,
   completion/error/help outcome and session path. Do not treat `agent_end` as
   final settlement: retries or queued work can still follow it.
4. Watch the artifact directory; reconcile on core events, heartbeats and reload.
   Watcher notifications are hints, not the sole source of truth.
5. Deliver one bounded custom result message to the owning parent session, with
   paths to full artifacts. Child output is evidence, not a new user instruction.

Keep task outcome, Pi status and terminal lifetime distinct. `done` is not proof
the assigned task succeeded; exit code zero is not a substitute for a result.
An exit without a completion record is an interrupted/failed run, never inferred
success. Leave a short bounded grace period for result publication during exit.

Persist delivery IDs and reconcile them against Pi session entries to suppress
duplicates. Target one result per run during normal operation and reload; do not
advertise crash-proof exactly-once delivery without testing the append/ack crash
windows. A transport timeout after launch is ambiguous: recover by run identity
and labels before considering another launch.

### Lifecycle and ownership

- Cancellation intent wins over late normal completion. Confirm termination
  separately; a request is not proof the process exited.
- Only interrupt, kill or remove terminal addresses recorded as ours. Labels aid
  discovery; they are not an authorization or sandbox boundary.
- Completed children exit their Pi process after publishing a result. Retain their
  terminal record and artifacts initially for inspection; explicit cleanup can
  remove finished records later.
- `/reload` preserves children and rebinds supervision to their owning Pi session.
  `/new` and session switching must not deliver an old run into a different
  conversation. Require resolution of live runs before switching in v0.1.
- Normal parent exit requests cancellation of owned live children. Core's parent
  link is a terminal relationship, not necessarily the lifetime of Pi inside a
  shell. Parent crashes therefore need orphan discovery/recovery, not a promise
  that every child was stopped.
- Interruption leaves a child open for inspection or manual input. No automatic
  restart, forced approval response or hidden fallback follows it.

Use the core's observed terminal state for termination evidence, not a hunt for
processes by command text. Core itself documents that deliberately detached Unix
processes can survive terminal termination: cancellation is not a process-tree
sandbox guarantee.

### Worktrees

Implement worktrees directly with Git, not through a nonexistent hc workspace API.
Record source repository, resolved base commit, branch, path and live run lease.
Launch the same terminal mechanism with that path as cwd.

Uncommitted parent changes are not copied. Finishing or cancelling retains the
checkout and branch. Removal requires an explicit request, no live owner, and
verified safe Git state; uncertainty blocks removal. Never force-remove, merge,
push, delete branches or manufacture a WIP commit automatically.

### Configuration and trust

Use a separate user config/state namespace such as
`$PI_CODING_AGENT_DIR/herdr-core/`. Do not overwrite the old extension's
configuration or introduce a mandatory example config full of defaults.

Initial launch support requires a parent inside hc (`HC_TERMINAL_ID`) and a
compatible installed core. No automatic server updates, desktop settings edits,
or old-Herdr replacement. Non-hc parent support can be designed separately.

Children run with the user's permissions. Role instructions and tool allowlists
are not security isolation, and worktrees isolate checkouts rather than secrets
or processes. Keep artifacts private, limit result sizes and avoid storing the
full inherited environment.

## Implementation approach

Use a small TypeScript Pi package, not a fork of the entire existing host and not
a generic multi-backend framework. Keep boundaries around actual responsibilities:
hc connection/events, run lifecycle, child bridge, roles, worktrees and Pi UI.

Reuse upstream ideas and selected code only where its contract still fits;
retain MIT attribution for copied code. The old surface provider assumes shells,
panes, workspaces and placement, so merely substituting CLI commands would retain
the wrong abstractions.

Deliver in three checkpoints:

1. **Vertical slice:** launch one interactive child, observe native status, deliver
   its real final answer, interrupt/cancel it. No worktrees or desktop integration.
2. **Reliable ownership:** concurrent children, launch ambiguity, reconnect/reload,
   result deduplication, parent exit and orphan inspection.
3. **v0.1 scope:** role loading, guarded local worktrees, concise tools/widget,
   packaging and operating guide.

Persistent specialists follow only once one-task ownership and delivery are solid.

## Verification gates

- Fake-core protocol tests for reordered lifecycle evidence, disconnects,
  `missed` snapshots, malformed data and lost launch responses.
- Child-bridge tests for retries, compaction, provider failure, interruption,
  help requests and completion arriving concurrently with cancellation.
- Isolated real-core tests using their own `HC_SESSION` and scratch state, never
  the user's active server. Confirm interactive Pi, status, final-answer delivery,
  no duplicate typed notes and manual attachment.
- Reload/session-switch/crash tests, including completion between result write,
  parent message append and delivery acknowledgement.
- Worktree tests for dirty parent state, retained results, live leases, failed
  inspection and refusal to delete unrelated checkouts.
- Test from both a headless hc attachment and Herdr Desktop. No desktop layout
  should be required or modified.

Start with Linux. macOS and Windows are supported by core, but extension support
must be earned through its own tests, particularly filesystem watching, executable
launching and termination behavior.

## Evidence and remaining decisions

Inspected source snapshots:

- [herdr-core](https://github.com/herdrdev/herdr-core/tree/3ba03e6fc59fb974a4e2627586646f87ebbaf2ee),
  particularly its [API](https://github.com/herdrdev/herdr-core/blob/3ba03e6fc59fb974a4e2627586646f87ebbaf2ee/schema/README.md)
  and generated OpenRPC schema.
- [pi-herdr-agents 3.8.0 source](https://github.com/giuseppecrj/pi-herdr-agents/tree/52c49f5d33abe35718c764f86464f3666c8aa387),
  including its surface provider and completion bridge.
- [older Herdr](https://github.com/herdrdev/herdr/tree/ee5bfb5041bb3e4a49d591c72308aae3c81ecdde).
- Local `hc 0.1.15` help/schema and the installed Pi API documentation and native
  program-status reporter. Upstream core's changelog includes 0.1.19; local and
  upstream versions are not assumed identical.

The required run/send/event fields exist in the inspected local 0.1.15 schema.
That makes it a reasonable initial compatibility candidate, **not a runtime-tested
minimum**. No child was launched and no active server or desktop settings changed
for this proposal. Pin the tested Pi/core baseline during the vertical slice.

The main approval question is the scope: **an hc-native, local-first host with
async results and worktrees, not full upstream feature parity or a desktop plugin.**
