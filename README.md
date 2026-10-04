> **Windows fork maintained under [yuri368](https://github.com/yuri368/dsh-subagent-mcp).** Based on [dqtz5vpvj9-create/dsh-subagent-mcp](https://github.com/dqtz5vpvj9-create/dsh-subagent-mcp), with the original MIT license and attribution retained. RC8 runtime changes were developed with Codex assistance and tested locally on Windows. See [fork status and validation scope](docs/fork-status.md).

<p align="center">
  <img src="https://raw.githubusercontent.com/dqtz5vpvj9-create/dsh-subagent-mcp/main/docs/assets/readme-hero.png?v=0.5.3" alt="DSH Subagent MCP — Give Codex a DeepSeek crew. Blue-haired whale-girl agents write code, investigate, and test beside the Codex terminal emblem." width="1200">
</p>

<p align="center">
  <a href="skills/dsh-subagent/SKILL.md"><img src="https://img.shields.io/badge/Codex-skill-4D6BFE?style=flat-square" alt="Codex skill included"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-A6ADBB?style=flat-square" alt="MIT license"></a>
</p>

<p align="center">English · <a href="README.zh-CN.md">中文</a> · <a href="#get-started">Quick start</a> · <a href="docs/usage.md">Usage guide</a></p>

Give Codex a team of DeepSeek agents. Let them implement, investigate, and test in parallel while Codex plans and reviews. Results return through the selected completion path, and each agent keeps its context for the next task.

<table>
<tr>
<td width="33%"><strong>Work in parallel</strong><br>Move independent tasks forward at the same time.</td>
<td width="33%"><strong>Return results</strong><br>Receive the answer and evidence through a pending wait or a reachable native callback.</td>
<td width="33%"><strong>Keep the context</strong><br>Continue the same agent for fixes, questions, and verification.</td>
</tr>
</table>

## Get started

This repository contains the Windows RC8 source fork. With Windows and Node.js 24+ (including npm), install from this checkout:

```powershell
git clone https://github.com/yuri368/dsh-subagent-mcp.git
cd dsh-subagent-mcp
npm ci --ignore-scripts
node src/cli.mjs setup --yes --completion-mode auto
```

Dependency downloads require network access. Existing compatible DSH/Codex configuration is reused. The default managed DSH CLI is `0.1.5-rc.1`; explicitly selected compatible CLIs are supported. The upstream npm package `dsh-subagent-mcp@latest` does not contain this fork. This repository is not an npm publication; the package is marked private.

Open your project folder and start Codex as usual:

```sh
codex
```

If Codex was already open during installation, start a fresh Codex session to load the MCP tools and skill.

Try a small task in Codex:

```text
Ask DSH to inspect this project without changing files.
Find the main entry points and how the tests are run, then summarize what it finds.
```

Codex delegates the task and receives the result when DSH finishes. You can ask “What has it found?”, have the same agent investigate further, or stop it when the plan changes. For implementation work, ask Codex to split the agreed plan into independent DSH tasks, run the relevant tests, and review the results.

## Why combine Codex and DSH?

Software work combines decisions that need broad project context with execution that can be assigned a clear scope: implementing a module, tracing a defect, or running and repairing tests. DSH Subagent MCP separates these responsibilities. GPT-6 in Codex handles task decomposition, cross-task decisions, and acceptance; DeepSeek handles bounded deliverables through its own runtime. This keeps the parent's model budget focused on coordination and review.

Two requirements shape the design: preserve DeepSeek's execution environment, and integrate delegation into Codex without repeated parent-model activity while children run.

### Preserve the full DSH execution environment

Tool access, context management, and the execution loop all affect how an agent completes a task. The bridge starts a real DeepSeek Harness agent with its own conversation, working directory, tools, and permissions. The standard DSH preset provides context compaction and tool-result pruning, while persisted sessions allow the same agent to continue related work.

Codex supplies a self-contained brief with the objective, allowed changes, constraints, and acceptance evidence. The child then owns implementation, relevant tests, and in-scope repairs. The parent does not have to relay each tool call or supervise every intermediate step.

### Deliver completion to the parent scheduler

Codex starts and follows up with agents through MCP and uses the completion mode returned in each receipt. Completion defaults to **auto**, selecting **native** for CLI and **desktop-message** for Codex Desktop. Desktop-message sends the saved result to the same chat as an ordinary message. If `dsh_watch` registration fails, retain the same agent and use one pending `dsh_wait` without `seconds`; only a `watching` receipt permits ending the parent turn.

The CLI's **native** callback requires the DSH task and result callback to use the same Codex App Server. This exposed route is experimental; the current Desktop native callback remains unvalidated. **desktop-message** sends an ordinary message through the installed official Codex app-tools MCP server, requires the app to remain open, and does not grant new user authorization. DSH Desktop.exe is not integrated. See [setup](docs/setup.md#completion-delivery-in-codex-desktop).

RC8 acceptance passed a real DSH Flash task, saved result, one native callback to the same idle CLI 0.159.2 thread, and the CLI's visible result check. An external installed MCP client dispatched the task. This establishes the configured callback chain, not autonomous natural-language model dispatch or zero-configuration startup. The earlier RC7 account-bootstrap timeout is no longer reproduced; its precise cause remains unconfirmed.

Windows login startup now uses a hidden supervisor and creates no Node console. It retains least privilege, login startup and failure retries. See [operations](docs/operations.md).

Release candidates can be installed from a local tarball with configuration preservation, integrity checks and rollback. See [release and upgrade](docs/release.md). Completion listeners identify the DSH execution, retain results before delivery, and expose uncertain delivery without automatic replay; see [recovery](docs/recovery.md).

Standard bridge agents can call `codex_delegate` for Sol or Luna workers. Requests for Astra are rejected with `ASTRA_DELEGATION_FORBIDDEN`. This applies to DSH-to-Codex delegation and does not control Codex's built-in subagents. Explicit `task_kind: simple` selects Luna/medium; other new tasks default to Sol/medium. Routing adds no classifier model call. See [model routing](docs/model-routing.md).

Ordinary DSH Web can enable reverse delegation with `dsh-subagent-mcp web`.
Run it from the intended workspace; that directory and its descendants are
allowed by default. Add other roots explicitly with repeated
`--codex-workspace` arguments. The command loads the tool plugin for this Web
process and preserves its existing profile and session directory. Restart an
existing Web host through this command to enable the tool. `dsh_attach` observes
sessions but does not inject tools. See [Web integration](docs/codex-delegation.md).

Errors and context exhaustion also return to the parent. A tool error that the child is still repairing does not prematurely complete its task. Explicitly interrupted or closed agents do not trigger a completion callback.

### Reduce orchestration overhead as well as execution work

Delegation introduces its own costs: preparing briefs, inspecting status, transferring context, and reviewing results. Short model-driven status checks repeatedly bring the parent conversation into another model turn. A single pending tool wait avoids that repetition; a successfully registered native callback additionally lets the parent end its turn and resume when the result arrives.

The bundled skill combines the selected completion path with three practices:

- Assign complete deliverables with clear file ownership, so independent agents can make progress without continual parent instructions.
- Request a concise final answer and artifact evidence, then perform one consolidated acceptance pass. Keep detailed execution logs available for targeted inspection.
- Keep the parent focused on the current phase, with accepted conclusions and artifact references. Continue the same DSH agent for related fixes and questions.

These practices reduce parent execution and polling turns, unnecessary transcript transfer, and repeated review. These completion paths avoid repeated model-driven status checks; brief quality, parent-context size, and acceptance work still determine the rest of the overhead.

### Waiting for results

When Desktop-message registration is unavailable, one pending `dsh_wait` keeps the parent turn open until the result returns. Omitting `seconds` removes only the server-side timeout; the MCP client's own limit still applies. Set Codex's per-server `tool_timeout_sec` to cover the task duration and load it through a new MCP connection. See [setup](docs/setup.md#completion-delivery-in-codex-desktop) and [usage](docs/usage.md) for configuration and timeout recovery.

DSH Desktop.exe is not integrated by this candidate. Assigning tasks and reviewing results still consume Codex tokens; DeepSeek usage is billed separately by its provider. The [native callback validation record](docs/codex-callback-validation.md) describes its particular historical test environment and method; it does not establish the current Desktop native callback or a complete fresh CLI callback journey.

## See the work, keep the conversation

Each workspace has a **Claude Code / Codex 子代理** entry in DSH Web. Open its subagent catalog to inspect individual conversations and traces without filling the sidebar with every delegated run.

The browser reads persisted history, so it can lag and its running indicators are not authoritative for bridge-owned agents. Ask Codex for live status, or manage tasks from your terminal:

```sh
dsh-subagent-mcp agents list
dsh-subagent-mcp agents ps
dsh-subagent-mcp agents result AGENT_ID
dsh-subagent-mcp agents followup AGENT_ID --task "Check the first finding"
```

Finished tasks save their session and release their process automatically. Follow-ups restore the same conversation. See [all management commands](docs/operations.md#inspect-dsh-work), including cancellation and idle-runtime cleanup.

Already working in an ordinary DSH Web session? Attach it with `dsh_attach` and continue that same conversation. Details are in the [usage guide](docs/usage.md).

## Explore the bridge

| Guide | Contents |
| :--- | :--- |
| [Setup](docs/setup.md) | Credentials, persistent installation, upgrades, and older-session migration |
| [Usage](docs/usage.md) | Tools, callbacks, follow-ups, progress, external sessions, and context budgets |
| [Architecture](docs/architecture.md) | Runtime ownership, permissions, and lifecycle |
| [Operations](docs/operations.md) | Service management, result inspection, and browser history |
| [Callback validation](docs/codex-callback-validation.md) | Completion delivery, idle waiting, and parent review |
| [Changelog](CHANGELOG.md) | Release changes and compatibility notes |

The execution tools work with other MCP clients, including Claude Code. Automatic parent wakeup described here uses the Codex-specific callback; other clients use their supported notification or waiting mechanism. DSH appears as MCP activity in Codex today.

If this improves your workflow, [star the project](https://github.com/dqtz5vpvj9-create/dsh-subagent-mcp/stargazers) or share your experience in [Issues](https://github.com/dqtz5vpvj9-create/dsh-subagent-mcp/issues).

## Built on

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) and the [MCP SDK](https://github.com/modelcontextprotocol/typescript-sdk). Thanks to [dsh-mcp](https://github.com/Mr-potato-123/dsh-mcp) and [dsh-cursor-codex](https://github.com/jeremy9682/dsh-cursor-codex) for exploring DSH delegation, and [DSH-Code](https://github.com/unlinearity/dsh-code) for the terminal UI that sparked this project.

[MIT](LICENSE). Independent community project.
