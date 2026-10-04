# Installation

This repository contains the Windows RC8 source fork. With Windows and Node.js 24+ (including npm), install from this checkout:

```powershell
git clone https://github.com/yuri368/dsh-subagent-mcp.git
cd dsh-subagent-mcp
npm ci --ignore-scripts
node src/cli.mjs setup --yes --completion-mode auto
```

Dependency downloads require network access. Existing compatible DSH/Codex configuration is reused. The default managed DSH CLI is `0.1.5-rc.1`; explicitly selected compatible CLIs are supported. The upstream npm package `dsh-subagent-mcp@latest` does not contain this fork. This repository is not an npm publication; the package is marked private.

RC8 acceptance passed a real DSH Flash task and one native callback to the same idle CLI 0.159.2 thread, with the CLI displaying the result. The task was dispatched by an external installed MCP client bound to that thread. This verifies the configured callback chain; autonomous natural-language dispatch and zero-configuration startup remain unverified. The earlier RC7 account-bootstrap timeout no longer reproduces; its precise cause is unconfirmed.

Windows login startup uses a hidden PowerShell supervisor and a Node process with CreateNoWindow. The task retains least privilege and failure retries. This does not change the user or machine PowerShell execution policy.

Existing DSH and Codex installations are reused when compatible. Missing
dependencies are installed for your user account; no administrator access,
Python or global npm installation is required. Repeating the command checks the
installation and applies available updates. If DSH tasks are still running, it
keeps the installed version so they can finish.

## Connect your account

Setup shows account configuration separately from installation status. Existing
Codex sign-in and DSH provider settings are reused. A configured credential does
not prove that an account has remaining quota or that a model request will succeed.

If Codex needs a login:

```sh
npx -y dsh-subagent-mcp@latest login
```

This opens Codex's sign-in flow without starting a coding task.

If DeepSeek needs a key, get one from your provider and run:

```sh
npx -y dsh-subagent-mcp@latest configure
```

Paste the key at the prompt; input is hidden. Press Enter without a key to leave
the existing settings unchanged. Interactive setup can also offer this prompt.

If `DEEPSEEK_API_KEY` is already set in your terminal, save it for background tasks:

```sh
npx -y dsh-subagent-mcp@latest configure --capture-key
```

`DEEPSEEK_BASE_URL` is also captured when present. Values are saved in a private
provider file and never printed or inserted into Codex's MCP configuration.
New DSH agents use the saved settings; running agents keep their existing settings.
Noninteractive installation does not wait for account input.

## Start working

Open your project folder and run Codex normally:

```sh
codex
```

If setup installed a separate compatible Codex because yours was missing or too
old, use its copy explicitly:

```sh
npx -y dsh-subagent-mcp@latest codex
```

Arguments after `codex` are passed to Codex, for example `--cd` or `--model`.
An already-open Codex session needs to reload the newly installed MCP tools and
skill; starting a fresh Codex session is sufficient.

### Completion delivery in Codex Desktop

Completion defaults to **auto**, which selects **native** for CLI and
**desktop-message** for Codex Desktop. Desktop-message saves the result and sends
it as an ordinary message to the same chat through the installed official Codex
app-tools server. The Desktop app must remain open. Only `status: watching`
permits ending the parent turn; if registration fails, retain the same agent and
use one pending `dsh_wait` without `seconds`.

Native delivery requires the DSH task and result callback to use the same Codex
App Server connection. The CLI native route is a public experimental interface;
this candidate does not claim the current Desktop native callback or a fresh CLI
end-to-end callback journey as passed. The MCP frontend reads the mode from the caller's environment, or from
`DSH_COMPLETION_MODE` when the installation record contains a saved default and
the client does not forward it. Explicit modes `wait`, `native` and
`desktop-message` remain available. To migrate an existing saved single-mode
default to caller-based routing, run `setup --completion-mode auto`. The setup
command also accepts `--completion-mode auto|wait|native|desktop-message`.

The official Codex app-tools MCP plugin must be installed, and `CODEX_APP_TOOLS_PIPE_PATH`
must be forwarded from the calling Desktop process. Preserve any existing
`env_vars` and add that name to the `dsh_subagent` server's list. No callback
result is sent to another conversation. This delivery differs from
native `turn/start.toolOutput`; read the delivery field in the callback receipt.
The Desktop app must be open to receive a message. Starting with RC5, a fresh
MCP frontend announces its new Desktop pipe to the daemon automatically. The daemon refreshes
pending Desktop callbacks and recovers complete saved results only when the
original delivery is definitely `not_sent`; it never replays the child task or
resends accepted/unknown delivery. A new connection is required to load the
upgraded frontend. Forward `CODEX_APP_TOOLS_CALLER_HOST_ID` too when the caller
uses an explicit host identity. See [recovery](recovery.md) for cancellation,
pause, execution identity and validation boundaries. Missing callback setup
falls back to the same pending-wait workflow, never to a different transport.

Omitting `seconds` removes the server-side timeout only. The client's own
per-server `tool_timeout_sec` still applies, is measured in seconds, and must
cover the expected task duration:

```toml
[mcp_servers.dsh_subagent]
tool_timeout_sec = 3600
```

The setting takes effect on a new MCP connection, not in the current chat. After
changing it, start a new Codex session and confirm with a real call that runs
longer than the 300-second limit observed in this Desktop integration before
relying on a long wait. Other Codex clients or versions may use different defaults.

Try a small task:

```text
Ask DSH to inspect this project without changing files.
Find the main entry points and how the tests are run, then summarize what it finds.
```

Codex manages delegation and completion notifications. You can keep working or
leave Codex idle while DSH executes. The [usage guide](usage.md) covers follow-ups,
progress questions and cancellation.

To inspect the execution history in DSH Web:

```sh
npx -y dsh-subagent-mcp@latest dsh web --port 0
```

The system selects a free port. Open the local URL printed by DSH. This uses the same DSH installation, history
and saved provider settings.

## Check the installation

```sh
npx -y dsh-subagent-mcp@latest doctor
npx -y dsh-subagent-mcp@latest status
npx -y dsh-subagent-mcp@latest logs
```

`doctor` checks the runtime, service, MCP connection and account configuration.
Inside Codex it also checks access to the current parent conversation. It does
not submit a model task. `doctor --json` and `status --json` are available for scripts.

| System | Background startup | Installation directory |
| :--- | :--- | :--- |
| Windows | Per-user Scheduled Task | `%LOCALAPPDATA%\dsh-subagent-mcp` |
| macOS | User LaunchAgent | `~/Library/Application Support/dsh-subagent-mcp` |
| Linux | systemd user service when available | `${XDG_DATA_HOME:-~/.local/share}/dsh-subagent-mcp` |

If a login service is unavailable or belongs to another installation, setup uses
a separate background process and preserves the existing service. To choose that
mode explicitly, run `setup --service background`. Codex starts the service when
it connects; closing an MCP connection does not stop DSH tasks.

## Upgrade and uninstall

Run the installation command again to update:

```sh
npx -y dsh-subagent-mcp@latest
```

Installation files live outside the npm cache. Setup stages each version before
switching the service, and restores the previous installation if activation fails.
Updates are deferred while DSH tasks are active. Explicit `setup` and `upgrade`
commands also refuse to interrupt them.

To remove the integration:

```sh
npx -y dsh-subagent-mcp@latest uninstall
```

Uninstall removes the DSH bridge service, owned skill link, MCP registration and
managed packages. It retains bridge history, saved provider settings and DSH
conversations. `uninstall --purge` also removes bridge history and saved settings;
DSH's own conversations remain intact.

## Advanced configuration

- `setup --yes` skips interactive account prompts. `setup --capture-key` remains
  available when installation and credential capture belong in the same script.
- `mcp` runs the MCP stdio transport. Clients must pass this subcommand explicitly;
  the no-argument command installs the integration even when input is piped.
- `setup --no-install-deps` requires preinstalled compatible DSH and Codex.
- `setup --no-skill` preserves a separately managed skill. Conflicting custom
  skill directories are also preserved, with instructions printed by setup.
- `--skill` remains accepted for older installation commands.
- `DSH_CLI` selects DSH's JavaScript entrypoint; `DSH_HOME` selects its home.
- `DSH_SUBAGENT_DATA`, `DSH_SUBAGENT_CONFIG` and `DSH_SUBAGENT_STATE` override
  bridge directories. Linux also follows the corresponding XDG variables.
- `CODEX_HOME` selects the Codex home. `DSH_CODEX_CLI` selects an explicit
  executable or JavaScript CLI entrypoint.
- `DSH_COMPLETION_MODE` can select `auto`, `wait`, `native`, or `desktop-message`. An explicit
  value in the MCP server environment wins; otherwise a saved installation default is used,
  and then caller detection selects the `auto` route: CLI native or Desktop desktop-message.
- `tool_timeout_sec` on the `dsh_subagent` MCP server bounds a `dsh_wait` call in
  seconds. The server-side wait has no timeout, but the client limit still
  applies; changing it requires a new MCP connection.

Missing dependencies use the versions validated by this release: DSH
`0.1.5-rc.1` and Codex CLI `0.158.0`. Existing global installations are preserved.

For source development, run `npm ci --ignore-scripts` followed by
`npm run setup -- --service background` to use the checkout. Legacy session
migration with `adopt` requires Linux's `flock`; new DSH agents are grouped by
workspace on all three platforms.

Callback results and receipts are saved under `callbacks` in the bridge state
directory. Keep the evidence needed for review and remove individual callback
directories after acceptance. A manual listener can use `--output-dir` to select
a different empty directory.
