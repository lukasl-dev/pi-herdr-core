# pi-herdr-core

Interactive, asynchronous Pi agents in [herdr-core](https://github.com/herdrdev/herdr-core)
terminals. **Early vertical slice**, not a feature-complete replacement for
`pi-herdr-agents`.

Each agent gets its own terminal and a short random name such as `moss-fox` or
`calm-wren`. There is no mandatory “Agents” tab. Task labels are separate from
terminal identity.

## Try without installing

Start a fresh Pi **inside an hc terminal**:

```sh
pi --extension /absolute/path/to/pi-herdr-core/src/extension.ts
```

Your normal launcher can supply themes, providers and other extensions. Do not
load this and the old `pi-herdr-agents` host together; their tool names overlap.
If a wrapper forces the old host, remove that entry first: `--no-extensions`
disables discovery, not explicit extensions inserted by a shell wrapper.

Ask Pi to delegate a bounded task, or call:

```typescript
subagent({
  task: "Review src/login.ts. Do not edit files or start other agents.",
  name: "login-review", // task label, not the default terminal name
  model: "openai/gpt-6.1-terra",
  thinking: "high",
});
```

Launch returns the generated name, run ID and terminal address. The actual result
arrives automatically and starts a parent follow-up turn. Do not poll for it.
Model IDs must exist in your own authenticated registry; the example is not a
promise that a particular provider account supports that model.

People can inspect a child with `hc attach <address>`. In Herdr Desktop, default
placement is a separate tab in the parent's space, without selecting it. Without
a Desktop space, it is an ordinary headless core terminal.

## Configuration

Optional file: `~/.pi/agent/herdr-core/config.json`, or
`$PI_CODING_AGENT_DIR/herdr-core/config.json`. Defaults need no config file.

```json
{
  "terminal": { "naming": "random", "prefix": "" },
  "desktop": { "placement": "tabs" }
}
```

- `terminal.naming`: `random` (default) or `task`. Task naming uses the supplied
  `name`; without one it falls back to a generated name. Explicit task-based names
  must be valid hc names and cannot collide with live terminals or retained runs.
- `terminal.prefix`: optional lowercase prefix, at most 12 characters, e.g. `pi-`.
- `desktop.placement`: `tabs` (default) or `background`. Tabs are independently
  named after their agents; background children have no Desktop placement labels.
  A shared tab/group mode is not implemented. No layout files are changed.
  If the app is closed during launch, the hc name still works; tab naming is
  best-effort. `/reload` retries it after opening the app. Once named, a tab is not
  renamed again on reload, preserving later manual renames.
- `piCommand`: optional executable/argument array, default `["pi"]`. Children
  resolve `pi` on the parent's `PATH`, preserving launchers such as `pi.nix`
  and their environment, rules, extensions, skills and theme configuration.
  Set an explicit array to choose a different launcher or add profile arguments.

```json
{
  "terminal": { "naming": "task", "prefix": "pi-" },
  "desktop": { "placement": "background" },
  "piCommand": ["/absolute/path/to/pi"]
}
```

Reload Pi after changing configuration. Unknown options are errors, not silently
ignored settings. The extension never writes the config file itself.

## Controls

| Tool                             | Effect                                                        |
| -------------------------------- | ------------------------------------------------------------- |
| `subagent`                       | Launch a child; task, optional task label/cwd/model/thinking. |
| `subagent_interrupt({ target })` | Escape the current turn; Pi stays open.                       |
| `subagent_cancel({ target })`    | Record cancellation, end its program, confirm observed exit.  |
| `subagents_list({})`             | Inspect owned runs; not needed to wait.                       |

`target` is the generated terminal name or run ID, not an arbitrary terminal.
Children get `caller_ping` to report a blocker and end their task.

Manual controls:

```text
/subagent list
/subagent doctor
/subagent interrupt moss-fox
/subagent cancel moss-fox
```

## Lifecycle and limits

- Children are real **interactive Pi processes**, not print-mode jobs. They use
  Pi's native OSC 7501 status. No second reporter or screen-scraped result parser.
- Children use the normal Pi profile, including configured extensions, providers,
  themes and MCP servers. Only this package's parent-host registration is skipped
  inside a delegated child, using `PI_HC_RUN_DIR`; the explicitly loaded child
  bridge owns result delivery. Other extensions retain their normal behaviour.
- Task and result files live privately under
  `$PI_CODING_AGENT_DIR/herdr-core/runs/`. Full task text and answers are sensitive.
  The launch environment is not copied into these records. Completed terminal
  records, session files and artifacts are retained for inspection.
- Completion needs a structured child result **and** an observed terminal exit.
  Exit code zero alone is not task success. Parent notifications from hc are
  suppressed for these children only, preventing duplicate pasted notes.
  Reports are capped at 200,000 characters with a truncation notice; the complete
  response remains in the child session file. The parent message previews up to
  12,000 characters and points to the full result artifact.
- `/reload` reattaches supervision. Session/branch switching is refused while
  runs are live or their results remain undelivered. Normal quit requests
  cancellation. Abrupt parent death can leave recoverable orphaned work.
- Result IDs and Pi session messages suppress duplicates during normal operation
  and reload. Crash-proof exactly-once delivery is not claimed.
- Only owned terminals are controlled. A failed/ambiguous launch is reconciled
  by run labels, not blindly repeated. Unresolved ownership blocks control.
- This is **not a sandbox**. Agents have your user permissions, and deliberately
  detached Unix processes can survive terminal cancellation.
- Roles, worktrees, persistent specialists, context forks and remote launches are
  not implemented yet. See [PROPOSAL.md](PROPOSAL.md) for the later checkpoints.

## Development

```sh
npm ci
npm run check
npm run test:integration  # requires hc on PATH; uses isolated core sessions
PI_HC_TEST_PI_NIX=/path/to/pi.nix npm run test:integration # also build a real pi.nix test wrapper
npm pack --dry-run
```

The integration suite uses actual interactive Pi and a deterministic loopback
model fixture, not external model accounts. It never restarts the user's core or
changes their Desktop settings. Test artifacts are retained under `/tmp`.
