# pi-herdr-core

Delegate tasks to interactive Pi agents in
[herdr-core](https://github.com/herdrdev/herdr-core). Each agent gets a terminal
with a short name like `moss-fox`; its answer returns automatically to the parent.
In Herdr Desktop, agents open in separate tabs without taking focus—no shared
“Agents” tab required.

## Setup

Have `hc` and your normal `pi` launcher on `PATH`. From a checkout, start Pi
**inside an hc terminal**:

```sh
pi --extension /absolute/path/to/pi-herdr-core/src/extension.ts
```

Children use the same launcher and profile: themes, providers, extensions and
MCP servers stay available. Do not load this alongside `pi-herdr-agents`; their
tool names overlap. If your wrapper explicitly loads the old host, remove that
entry first (`--no-extensions` does not override it).

## Delegation

Ask Pi to delegate a bounded task. The model-facing tool call looks like:

```typescript
subagent({
  task: "Review src/login.ts. Do not edit files or start other agents.",
  name: "login-review", // task label, not the default terminal name
});
```

`cwd`, `model` (`provider/model-id`) and `thinking` are optional; they default to
the parent's working directory, model and thinking level. Launch returns a name,
run ID and terminal address—not the answer. The answer triggers a parent
follow-up turn when ready; no polling needed.

| Tool                            | Purpose                               |
| ------------------------------- | ------------------------------------- |
| `subagent`                      | Launch a task.                        |
| `subagent_interrupt({ target })` | Stop the current turn; keep Pi open.   |
| `subagent_cancel({ target })`    | Cancel the task and end its program.  |
| `subagents_list({})`             | Inspect owned runs.                   |

Targets are agent names or run IDs. For manual control:

```text
/subagent list
/subagent doctor
/subagent interrupt moss-fox
/subagent cancel moss-fox
```

Use `hc attach <address>` to inspect a child's terminal. Children can report a
blocker and end their task with `caller_ping`.

## Configuration

No configuration is required. To customise, create
`~/.pi/agent/herdr-core/config.json` (or
`$PI_CODING_AGENT_DIR/herdr-core/config.json`). Defaults:

```json
{
  "terminal": { "naming": "random", "prefix": "" },
  "desktop": { "placement": "tabs" },
  "piCommand": ["pi"]
}
```

- **Naming:** `task` uses the supplied task label instead of a random name,
  falling back to random when omitted. Names must be unique, 1–32 characters,
  start with a lowercase letter or digit, and contain only `a-z`, `0-9`, `._-`.
- **Prefix:** up to 12 characters from `a-z`, `0-9`, `-`, starting with a letter
  or digit; for example, `pi-`.
- **Placement:** `tabs` places each agent in the parent's Desktop space;
  `background` skips Desktop placement. Without a Desktop space, agents remain
  headless core terminals. Layout files are untouched. If tab naming fails while
  Desktop is closed, open it and `/reload` to retry.
- **Launcher:** `piCommand` is an executable/argument array. Use an absolute path
  or add profile arguments to select another launcher.

Run `/reload` after changes. Unknown options are rejected.

## Lifecycle and limits

- `/reload` resumes supervision. Normal quit requests cancellation; an abrupt
  parent exit can leave orphaned work. Session/branch switching is blocked while
  runs are live or results await delivery.
- Completion requires a child report and terminal exit, not just exit code zero.
  Long answers are previewed with a link to the result artifact. Reports are
  capped at 200,000 characters; full responses remain in child session files.
- Tasks, results and sessions are retained under the agent directory's
  `herdr-core/runs/`. Treat these files as sensitive. Crash-proof exactly-once
  result delivery is not guaranteed.
- **Not a sandbox:** agents have your user permissions. Only owned terminals are
  controlled, and detached processes can survive cancellation.
- Early release: no roles, worktrees, persistent specialists, context forks or
  remote launches yet. [PROPOSAL.md](PROPOSAL.md) describes possible later work.

## Development

```sh
npm ci
npm run check
npm run test:integration
npm pack --dry-run
```

Integration tests require `hc` on `PATH` and use real Pi with a local model
fixture in isolated core sessions. Set `PI_HC_TEST_PI_NIX=/path/to/pi.nix` to also
test a generated wrapper. Tests leave your core and Desktop settings untouched;
artifacts remain under `/tmp`.
