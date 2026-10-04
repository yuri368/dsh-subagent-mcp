# DSH delegates to Codex

Standard DSH bridge agents have a `codex_delegate` tool. It starts an independent
Codex worker through the installed CLI's supported stdio App Server, waits for
the worker turn to settle, and returns its `thread_id`, `turn_id`, `status`,
`answer`, effective model, directory and parent permission. DSH can use the
result to continue its task. In code mode the tool appears in the `run_code`
SDK. The minimal preset retains its one-shell composition and does not mount
this tool.

The model supplies a self-contained `task` and can optionally supply a
`thread_id` returned by an earlier call. The directory and permission come from
the calling DSH session; the model cannot override them. Read-only parents create
read-only Codex workers. Workspace-write parents confine writes to their own
directory, with network access and extra temporary writable roots disabled.
Danger-full-access is accepted only when that is already the parent's effective
permission. Unknown/custom permission presets are rejected.

The worker uses the installed Codex account. Local task_kind routing defaults ordinary or uncertain work to gpt-6.1-sol/medium, and explicit simple work to gpt-6-luna/medium. New efforts below medium are rejected, and older low defaults are raised on invocation. Follow-ups retain ordinary choices. Astra requests through DSH-to-Codex delegation are rejected with `ASTRA_DELEGATION_FORBIDDEN`; this does not control Codex's built-in subagents. Explicit model/environment overrides cannot bypass effort minimums or this restriction. See [model routing](model-routing.md) for compatibility defaults, classification and lifecycle fields. Model choices are checked against the real model/list directory before dispatch; only a completed real inference proves account access. The worker strips Desktop parent identity, App Tools connection
information and DSH provider credentials from the worker environment. It clears
inherited MCP registrations and installed plugins using `enabled=false` configuration
overrides, disables apps and web search, and verifies the worker's actual MCP inventory contains only disabled servers with no tools or resources before sending
the task. Recursive DSH delegation and interactive approval requests are not
available to the worker.

Server IDs containing characters outside letters, digits, underscore and hyphen
are refused because Codex's per-thread dotted config keys cannot safely address
them. This refusal occurs before sending a worker task.

Follow-ups use `thread/resume` and preserve Codex conversation history. Thread
ownership is recorded under the bridge state's `codex-delegations` directory.
Only the DSH session that created the thread, in the same directory, can resume
it. Permissions are reapplied from the current parent on every call, so reducing
the parent's permission also reduces the worker's permission. Thread locks
reject concurrent attempts to resume the same worker.

Each invocation owns its App Server process and closes it after receiving
`turn/completed`. This does not use or wake an idle Desktop chat. The default
worker deadline is one hour. DSH interruption or deadline expiry requests
`turn/interrupt`, closes the worker connection, and fails that tool invocation;
it does not automatically replay the task. Failed and interrupted Codex turns
retain their status instead of being reported as completed. A worker can have
changed files before interruption, so inspect its result and artifacts before
any retry.

The supported request lifecycle is documented in the
[OpenAI App Server reference](https://learn.chatgpt.com/docs/app-server).
The bridge uses `initialize`, `thread/start` or `thread/resume`,
`mcpServerStatus/list`, `turn/start`, `turn/interrupt` and the native
`item/completed` / `turn/completed` notifications. It accepts only final agent
messages; commentary alone is not a completed answer.

External DSH Web sessions can be attached for observation and authorized prompt
delivery. Every observed execution is anchored to DSH's durable host turn number
(`turn/start`, `turn/end`, or numbered assistant/tool/step events), scoped to the
Web origin and session ID. The whole-log `turnOutline` wire projection can recover
the boundary when a short history snapshot omits `turn/start`. Older event
vocabularies can use an observed `turn/start` sequence as a fallback. Reconnects
and repeated history events preserve the same identity; a browser-origin second
turn receives a different identity even without a bridge request ID.

The browser's `requestId` is input correlation, not execution identity: queued
inputs have not started their future turn, and steering may feed the current
turn. An idle submitted prompt has unknown execution identity until a real host
boundary arrives. Automatic callbacks must refuse unknown identity or unresolved
pending prompt submissions rather than falling back to agent creation time or
the current turn of a queued request. Observation and explicit waits remain
available. The bridge does not replay an input to reconstruct identity.

Attaching an ordinary Web session does not install `codex_delegate`. In the
installed DSH 0.1.5-rc.1 protocol, `session/prompt` accepts session identity,
input identity, queue/steer mode, content and optional time zone; it has no tool
registration field. The generated Session Controller Remote inventory exposes
session operations, not a session-local tool injection endpoint. Plugin inventory
has a read-only `pluginInventory/list`; settings mutation changes declared
configuration, which is a different capability from mounting a scoped tool in an
already-running external session.

DSH's host plugin API does support `ctx.tools.register`, and its
`@deepseek-ai/dsh-mcp-client` plugin connects configured MCP servers through a
Cordis composition. The bridge mounts `dsh-codex-tool` in its own patched runtime
and registers the tool in each eligible agent's context. The explicit Web launcher
below mounts that host plugin for an operator-controlled ordinary Web process.
Attaching to an existing process still does not modify its composition. A genuine
isolated ordinary Web host has now passed two HTTP-prompt turns through this
integration, with authenticated WebSocket observation, Luna/medium execution,
owned same-thread resume and durable Web turn identity across reconnect. This
acceptance used the browser's protocol; it did not automate browser UI clicks or
modify an existing user Web host. Minimal retains its single-shell composition.

## Launch a standard Web host with Codex delegation

The explicit launcher below adds `dsh-codex-tool` through one temporary Cordis
`insert` overlay to the ordinary DSH Web composition. It does not use the bridge
SDK plugin. This affects only the newly launched process; attaching an already
running Web host still cannot install a tool. Existing services are not restarted
and neither the global nor profile `cordis.patch.yml` is edited.

```powershell
cd C:\path\to\workspace
node C:\path\to\dsh-subagent-mcp\src\cli.mjs web --port 3001
```

The launcher inherits the installed environment and provider settings, sets
`DSH_CLI` to the resolved installed CLI, and forwards the remaining Web flags.
`DSH_HOME` retains its normal precedence and the host uses its normal profile
and session directory. For an isolated home or a separate profile, set `DSH_HOME`
in the launching shell and optionally pass `--profile NAME`; initializing a new
custom Web profile also requires DSH's `--from-default-profile web`. This creates
a separate host and does not move an existing session between homes.

By default, only standard/legacy sessions whose directory is the launch directory
or a descendant receive `codex_delegate`. Repeat `--codex-workspace ABSOLUTE_PATH`
to explicitly allow other existing directories. A directory must remain both a
lexical descendant and a real filesystem descendant of an approved root; junction
and symbolic-link escapes are rejected. The tool rechecks the session directory,
current preset and effective permission on every invocation. Minimal remains
unchanged and unknown permission presets fail before a worker starts.

Web worker ownership includes a canonical host-home scope and the DSH session ID,
so equal session IDs in different homes cannot resume one another's workers.
Bridge-owned workers retain their existing session-ID ownership. The overlay is
removed when the launched process exits. `web --dump-config` can inspect the
resulting composition without executing a model; `--dump-default-config` is
rejected because that DSH mode omits launch overlays. These setup and composition
checks alone do not establish successful browser interaction or account inference.
