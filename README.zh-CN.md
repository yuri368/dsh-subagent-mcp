> **这是 [yuri368 维护的 Windows 修改版](https://github.com/yuri368/dsh-subagent-mcp)。** 基于 [原项目](https://github.com/dqtz5vpvj9-create/dsh-subagent-mcp)，保留原作者信息和 MIT 许可证。RC8 改动使用 Codex 辅助完成，已在本地 Windows 验收；详见[本分支状态与验收范围](docs/fork-status.md)。

<p align="center">
  <img src="https://raw.githubusercontent.com/dqtz5vpvj9-create/dsh-subagent-mcp/main/docs/assets/readme-hero.png?v=0.5.3" alt="DSH Subagent MCP：给 Codex 配一支 DeepSeek 团队。蓝发鲸鱼娘在 Codex 终端图标旁协作完成代码实现、排查与测试。" width="1200">
</p>

<p align="center">
  <a href="skills/dsh-subagent/SKILL.md"><img src="https://img.shields.io/badge/Codex-skill-4D6BFE?style=flat-square" alt="Codex skill included"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-A6ADBB?style=flat-square" alt="MIT license"></a>
</p>

<p align="center">中文 · <a href="README.md">English</a> · <a href="#开始使用">开始使用</a> · <a href="docs/usage.md">使用指南</a></p>

DSH Subagent MCP 让 Codex 直接调用 DeepSeek 子代理。Codex 负责规划和验收，子代理在 DSH 中完成各自的任务，结束后通过所选的完成方式回传结果。需要修改时，可以继续使用原来的代理，无需重新交代上下文。

<table>
<tr>
<td width="33%"><strong>并行执行</strong><br>多个代理可以同时处理独立任务。</td>
<td width="33%"><strong>回传结果</strong><br>通过一次持续等待或可达的原生回调接收答复和证据。</td>
<td width="33%"><strong>继续同一会话</strong><br>保留上下文，交给原来的代理继续修改。</td>
</tr>
</table>

## 开始使用

本仓库包含 Windows RC8 修改版源码。需要 Windows、Node.js 24+（包含 npm）及依赖下载网络。从源码安装：

```powershell
git clone https://github.com/yuri368/dsh-subagent-mcp.git
cd dsh-subagent-mcp
npm ci --ignore-scripts
node src/cli.mjs setup --yes --completion-mode auto
```

安装复用兼容的已有 DSH/Codex 配置；默认使用 DSH CLI `0.1.5-rc.1`，支持明确指定兼容 CLI。npm 上的 `dsh-subagent-mcp@latest` 属于原项目，不包含本修改版。本仓库当前未发布 npm，包设置为 private。

进入要处理的项目目录，像平时一样启动 Codex：

```sh
codex
```

如果安装时 Codex 已经打开，新开一个 Codex 会话即可加载 MCP 工具和 skill。

先在 Codex 中试一个小任务：

```text
让 DSH 只读检查这个项目，找出主要入口和测试运行方式，
完成后帮我整理一份简短说明。
```

Codex 会把任务交给 DSH，完成后自动接收结果。你可以询问进度，让同一个代理继续排查，或在方向变化时要求它停止。开始实现功能时，再让 Codex 将已确认的方案拆成独立任务，交给 DSH 执行测试，最后统一验收。

## 为什么将 Codex 与 DSH 结合？

使用 GPT-6 Astra 处理长任务时，模型用量不只花在制定方案上。每轮执行后的判断、进度查询和结果检查也会消耗 token。DSH Subagent MCP 将范围明确的工作交给 DeepSeek，让 Codex 负责方案设计和最终验收。例如，Codex 可以将一个模块的实现交给子代理，待代码和测试结果返回后统一检查。

DeepSeek 在自己的 Harness 中执行任务，Codex 则通过一次持续等待或可达的原生回调接收结果。子任务运行期间，父模型无需反复查询进度。

### 让 DeepSeek 在 DSH 中执行任务

编程代理需要读取项目、编辑文件和执行命令，也需要管理执行过程中不断增长的上下文。桥接器直接启动 DeepSeek Harness，由 DSH 处理这些工作。每个代理在指定目录中运行，使用各自的工具权限并保留会话。标准预设会压缩过长的上下文、裁剪工具结果；后续修改可以在同一会话中继续。

Codex 在委派时说明目标、允许修改的范围、约束和验收要求。子代理负责完成实现，并处理相关测试中发现的问题。父代理收到结果后集中检查，无需逐步指导子代理调用工具。

### 按完成模式接收结果

Codex 通过 MCP 启动或追问子代理，并按回执中的完成模式接收结果。完成方式默认为 **auto**，按调用端选择 CLI **native** 或 Codex Desktop **desktop-message**。后者会将已保存的结果作为普通消息发回同一个聊天。注册失败时，保留同一个 agent 并使用一次不带 `seconds` 的 `dsh_wait`；只有收到 `watching` 回执才可结束父轮次。

CLI **native** 回调要求 DSH 任务与结果回调连接到同一个 Codex App Server。此公开接口仍属实验性；当前 Desktop native 回调仍未通过验证。**desktop-message** 通过已安装的官方 Codex 聊天工具发回普通消息，需要 Desktop 工具管道且应用保持打开；子任务结果不构成新的用户授权。DSH Desktop.exe 尚未接入此候选版本。配置方法见[安装说明](docs/setup.md#completion-delivery-in-codex-desktop)。

RC8 已通过真实 DSH Flash 任务、保存结果、向同一空闲 CLI 0.159.2 聊天投递一次原生回调，以及 CLI 显示并核对结果的验收。任务由绑定该聊天的外部 MCP 客户端派发；这证明已配置的回调链路，不代表模型自主自然语言派发或零配置启动已验收。此前 RC7 的账号初始化超时目前不再复现，具体根因尚未确认。

Windows 登录启动改为隐藏监督进程，Node 服务不创建控制台窗口，保留登录启动、普通用户权限和失败重试。详见[运行维护](docs/operations.md)。

候选版本支持从本地安装包安装，保留配置、检查安装完整性并回滚，见[发布与升级](docs/release.md)。完成监听按 DSH 执行回合去重，先保存完整结果，再投递；送达不确定时保留证据，不自动重放，见[异常恢复](docs/recovery.md)。

标准桥接代理可通过 `codex_delegate` 调用 Sol 或 Luna。DSH→Codex 请求 Astra 会返回 `ASTRA_DELEGATION_FORBIDDEN`。此规则针对该委派接口，不控制 Codex 内置子代理。明确标记 `task_kind: simple` 时选择 Luna/medium，其他新任务默认 Sol/medium；调度不另花一次模型请求分类。见[模型调度](docs/model-routing.md)。

普通 DSH Web 也可通过显式命令 `dsh-subagent-mcp web` 启用反向委派。请从要工作的目录运行；默认允许该目录及其子目录，其他目录通过重复的 `--codex-workspace` 参数明确加入。此命令为本次普通 Web 进程加载工具插件，保留原来的 Web profile 和会话目录；已运行的 Web 宿主需要退出后用此命令重开。`dsh_attach` 负责观察已有会话，不负责注入工具。见[Web 接入方法](docs/codex-delegation.md)。

任务因错误或上下文耗尽而结束时，也会返回给父代理。某次工具调用失败而子代理仍在修复时，不算整个任务完成。主动中断或关闭的代理不会触发完成回调。

### 委派开销还取决于任务和上下文

父代理仍要准备任务、传递必要的上下文并检查结果。如果模型每隔几秒查询一次进度，这些查询又会产生新的推理轮次，每轮都带上父会话上下文。一次持续的工具等待可以避免轮询；成功注册的 native 回调还允许父会话结束当前轮次，由调度器在完成事件到达时恢复执行。

任务应该一次交代清楚，并划分好各代理可以修改的文件。子代理完成后提交简短结论和验收证据，父代理集中检查；详细日志保留在文件中，检查到具体问题时再读取。需要修复的缺陷可以合并成一次后续任务，交给原来的代理处理。

父会话本身也会不断变长。阶段性验收后，保留目标、已确认的结论和后续需要的产物及代理 ID 即可，详细日志留在原处。同一任务的追问仍可使用原来的 DSH 代理，不必将它的全部执行记录复制到父会话。

### 等待与回传的实际表现

Desktop-message 无法注册时，一次持续的 `dsh_wait` 会保持父代理的工作回合，直到结果返回。不传 `seconds` 只取消服务端的等待时限，客户端自身的请求时限仍然有效。应将 Codex 对应 MCP 服务器的 `tool_timeout_sec` 设为足以容纳任务的秒数，并使用新连接加载。配置与超时恢复方法见[安装说明](docs/setup.md#completion-delivery-in-codex-desktop)和[使用指南](docs/usage.md)。

此候选版本尚未接入 DSH Desktop.exe。任务安排和结果验收仍会消耗 Codex token，DeepSeek 的用量由其服务单独计算。[原生回调验证记录](docs/codex-callback-validation.md)描述了历史测试环境与方法，不能证明当前 Desktop 原生回调或全新的 CLI 回调全链路已通过。

## 在 DSH Web 查看执行记录

DSH 将子代理按工作区归档。每个工作区有一条名为“Claude Code / Codex 子代理”的会话，打开其中的子代理列表，就能查看各项任务的对话和工具执行记录。

网页显示已保存的记录，可能晚于实际执行进度，运行标识也不反映这些代理的实时状态。可以让 Codex 查询，也可以直接从终端管理：

```sh
dsh-subagent-mcp agents list
dsh-subagent-mcp agents ps
dsh-subagent-mcp agents result AGENT_ID
dsh-subagent-mcp agents followup AGENT_ID --task "继续检查第一个问题"
```

任务完成后自动保存会话并释放子进程；追问时恢复同一段对话。`agents --help` 可查看中断、关闭和清理空闲运行时等命令，详细说明见[运维指南](docs/operations.md#inspect-dsh-work)。

已有的普通 DSH Web 会话可以通过 `dsh_attach` 接入，继续原来的工作。具体用法见[使用指南](docs/usage.md)。

## 进一步了解

| 文档 | 内容 |
| :--- | :--- |
| [安装](docs/setup.md) | 凭据、持久安装、升级和旧会话迁移 |
| [使用](docs/usage.md) | 工具、回调、追问、进度、外部会话和上下文预算 |
| [架构](docs/architecture.md) | 进程归属、权限和生命周期 |
| [运维](docs/operations.md) | 服务管理、子代理命令行管理、结果检查和网页历史 |
| [回调验证](docs/codex-callback-validation.md) | 结果回传、空闲等待与父代理验收 |
| [更新日志](CHANGELOG.md) | 版本变化和兼容性说明 |

执行工具也可用于 Claude Code 等其他 MCP 客户端。这里的自动唤醒使用 Codex 专用回调；其他客户端采用各自支持的通知或等待方式。目前 DSH 在 Codex 中显示为 MCP 活动。

使用问题和功能建议请提交到 [Issues](https://github.com/dqtz5vpvj9-create/dsh-subagent-mcp/issues)。

## 致谢

基于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 和 [MCP SDK](https://github.com/modelcontextprotocol/typescript-sdk) 构建。感谢 [dsh-mcp](https://github.com/Mr-potato-123/dsh-mcp) 与 [dsh-cursor-codex](https://github.com/jeremy9682/dsh-cursor-codex) 对 DSH 委派的探索，以及启发本项目的终端界面 [DSH-Code](https://github.com/unlinearity/dsh-code)。

[MIT 许可](LICENSE)，独立社区项目。
