# Service operations

## Check the integration

```sh
npx -y dsh-subagent-mcp@latest status
npx -y dsh-subagent-mcp@latest doctor
npx -y dsh-subagent-mcp@latest logs
```

`status` reports the DSH background service and active tasks. `doctor` checks the
runtime, MCP connection and account configuration; it does not make a model
request. Run it inside Codex to also check completion delivery to the current
conversation.

Bridge state follows the platform locations in the [installation guide](setup.md).
Full conversation history belongs to DSH's configured home. Saved provider
settings live in `provider.json` under the bridge configuration directory. Use
`configure` to enter a key privately, or `configure --capture-key` to save one
already present in your terminal. New DSH agents use the updated settings.

## Start, stop and remove the service

```sh
npx -y dsh-subagent-mcp@latest start
npx -y dsh-subagent-mcp@latest stop
npx -y dsh-subagent-mcp@latest restart
```

An ordinary stop or restart refuses to interrupt active DSH tasks. Finish them
first, or ask Codex to stop the task. Use `stop --force` only when you intend to
interrupt all active DSH work owned by the bridge.

Closing an MCP connection leaves DSH work running. The service commands manage
DSH; they do not manage your Codex conversations.

To remove the integration:

```sh
npx -y dsh-subagent-mcp@latest uninstall
```

Uninstall removes the bridge service, its owned skill link, MCP registration and
managed packages. History and saved provider settings are retained. See
[upgrade and uninstall](setup.md#upgrade-and-uninstall) for the purge option.

## Inspect DSH work

Manage subagents directly from your terminal:

```sh
npx -y dsh-subagent-mcp@latest agents list
npx -y dsh-subagent-mcp@latest agents ps
npx -y dsh-subagent-mcp@latest agents show AGENT_ID
npx -y dsh-subagent-mcp@latest agents result AGENT_ID
npx -y dsh-subagent-mcp@latest agents events AGENT_ID --progress
npx -y dsh-subagent-mcp@latest agents start --task "Inspect this project and report back" --permission read-only
npx -y dsh-subagent-mcp@latest agents wait AGENT_ID
npx -y dsh-subagent-mcp@latest agents followup AGENT_ID --task "Check the first finding"
npx -y dsh-subagent-mcp@latest agents interrupt AGENT_ID
npx -y dsh-subagent-mcp@latest agents gc
```

`agents --help` lists all commands. IDs accept unique prefixes; `--json` provides
machine-readable output. `wait` holds one connection until the task settles.
Terminal tasks do not automatically notify a Codex parent.

Finished and interrupted bridge tasks save their conversation and automatically
release their runtime. Results remain readable, and `followup` restores the same
DSH session. `agents ps` lists resident runtime PIDs. `agents gc` releases idle
runtimes without stopping active tasks or deleting history. `agents release ID`
does the same for one agent. `agents close ID` permanently closes that bridge
agent; external Web agents are only detached and keep running in their own host.

Open DSH Web with:

```sh
npx -y dsh-subagent-mcp@latest dsh web --port 0
```

In the workspace's **Claude Code / Codex 子代理** entry, open the subagent catalog
to inspect conversations and traces. The browser reads saved history, while the
bridge owns the running process. Browser activity indicators can therefore lag.

Ask Codex for current progress when needed. For targeted diagnostics, `dsh_status`
reports live lifecycle state and `dsh_events` can include progress and tool events.
A browser `TOOL_OUTCOME_UNKNOWN` marker means a recorded tool call has no result in
the loaded history. Check the live state before treating it as a crashed agent.

## If a completion result does not arrive

Ask Codex to check the DSH task. Results and delivery receipts are saved under
`callbacks` in the bridge state directory, so delivery failure does not discard
the answer. A receipt distinguishes `delivered`, `delivery_failed`, `cancelled`
and `stopped`. The complete result is in the same callback directory.

Completion defaults to `auto`: CLI selects native and Codex Desktop selects
desktop-message. Both require a successful `dsh_watch` receipt (`watching`) to
end the parent turn; otherwise retain the same task and use `dsh_wait` without
`seconds`. The native CLI task and result callback must use the same Codex App
Server. DSH Desktop.exe is not integrated by this Windows release candidate.

The callback requires Codex's App Server to remain reachable. A failed
acknowledgement may follow successful delivery; inspect the parent history before
resending so the result is not delivered twice. No alternate delivery route is
tried automatically.

Tasks that finish with `error` or `context_exhausted` notify the parent. An
observer connection failure produces `watch_error`, which is separate from a
failed DSH task. Explicitly interrupted or closed agents do not trigger continued
work. A process that remains live without finishing can keep its listener waiting;
ask Codex to inspect or interrupt that task when necessary.

## Validation for maintainers

Release acceptance is documented in [release end-to-end tests](release-acceptance.md).
Installation checks and real-model tests have separate roles: a successful
installation proves that the service and MCP tools are available; a real-model
run must also check delegation, the saved artifact, completion delivery and
Codex's review.

For local development:

On Windows RC8 and later, the login task uses a hidden Windows PowerShell
supervisor. It starts the Node daemon with no console window, waits for its
exit and returns the same exit code. This preserves Task Scheduler's login
trigger, least-privilege user context, duplicate prevention and failure retries.
Setting a task's `Hidden` checkbox alone does not hide a Node console.
The daemon's normal log remains in the bridge state directory; supervisor
startup failures are recorded as `service-launcher.log` beside installation.json.
No machine/user execution policy is changed. An enforced policy can still
reject the task script; setup then reports the failure and restores the prior
installation. Retained versions without this supervisor restore their original
direct-Node task during rollback, including the old window behavior.

```sh
npm test
DSH_RUNTIME_TEST=1 DSH_PACKAGE_TEST=1 DSH_FRESH_INSTALL_TEST=1 npm test
```

The three switches enable both real DSH preset checks, the packed installation
check, and the fresh installation check. Fresh installation uses private bridge,
DSH and Codex homes, registers MCP with the actual Codex CLI, checks the callback
schema, initializes both presets, and uninstalls its own service. It may reuse a
compatible dependency available on `PATH`; testing dependency downloads also
requires a private Node/npm installation and a `PATH` without DSH or Codex.

On Windows, use a test scratch directory outside the system temporary directory
when checking installation of Codex 0.158.0. Codex emits a helper-alias warning
when `CODEX_HOME` is under that directory. The official installer's Windows
PowerShell version check can treat this stderr warning as a failed version read.
`TMPDIR` controls the fresh fixture location without changing the user's Codex
home:

```powershell
$testScratch = Join-Path $PWD 'work\install-tests'
New-Item -ItemType Directory -Force -Path $testScratch | Out-Null
$env:TMPDIR = $testScratch
$env:DSH_RUNTIME_TEST = '1'
$env:DSH_PACKAGE_TEST = '1'
$env:DSH_FRESH_INSTALL_TEST = '1'
npm test
```

The runtime checks exercise actual DSH initialization, presets, permissions and
persistence without making model calls. The following tests make real model
requests in temporary workspaces:

```sh
node test/live.mjs
node test/mcp-live.mjs
node test/completion-live.mjs
```

Set `TMPDIR` for test workspaces. Reports are generated locally and excluded from
Git. These tests do not replace observing a real Codex parent receive and review
a result. See [callback validation](codex-callback-validation.md) for the
method, including checking an idle parent without model-driven progress polling.
