本仓库已作为个人 Fork 上传 GitHub。下文记录此前 RC8 本地成品的交付和验收范围；源码安装方法见 [setup.md](setup.md)，本分支差异见 [fork-status.md](fork-status.md)。原始本机日志与聊天记录保留在本地。

# 当前 Windows 交付范围 · 0.8.0-rc.8

本次按用户要求交付完整的 Windows 本地项目包。它包含可安装 tgz、
完整可编辑源码、锁文件、测试、技能、文档和 PowerShell 使用脚本。
`Install.ps1` 校验固定包后执行 RC8 `setup --yes --completion-mode auto`。
公开 npm 的 `latest` 是此前发布的版本，不能用它代替本次包。

## 本次实现

| 内容 | 交付行为 |
| --- | --- |
| Codex CLI 完成方式 | `auto` 选择 `native`，调用公开实验性 App Server 的原生工具结果回传；CLI 和回调必须连接到同一个服务器 |
| Codex Desktop 完成方式 | `auto` 选择 `desktop-message`，经已安装的官方 app-tools 插件将已保存结果发回同一聊天 |
| 注册失败 | 保留同一 DSH agent，执行一次不带 `seconds` 的 `dsh_wait`；只有 `watching` 回执允许结束父轮次 |
| DSH→Codex Astra 限制 | 显式模型、实际选用的环境默认和历史 Astra 会话在 worker 启动前返回 `ASTRA_DELEGATION_FORBIDDEN` |
| 模型调度范围 | 只限制本桥接的 DSH→Codex 委派；不控制 Codex 内置子 Agent，不实现 Astra 完整工具隔离 |
| 旧配置迁移 | `setup --completion-mode auto` 修改桥接拥有的完成模式；普通 setup 保留旧显式模式 |
| 回滚 | 恢复保留安装的完成模式，缺少记录的旧版使用 `native`，避免把旧版不支持的 `auto` 留在 MCP 配置里 |

CLI 从 Desktop 终端通过本包启动时，会清除继承的 Desktop 回调管道和父聊天标记，
让新 CLI 使用自己的上下文。完成结果仍按执行回合去重；投递不确定时保留证据，
不重放任务、不自动补发可能已经送达的结果。

## 验收边界

当前 Windows 自动检查覆盖包安装、真实 DSH 预设、持久化、恢复、配置迁移、
回滚和 Astra 拒绝。确切计数、日志及成品校验结果在交付包 `evidence/`。
这些检查不等于所有外部账号和模型链路验收通过。

本轮真实 Codex CLI `0.159.2` 成功验收：一个真实 DSH Flash/off/minimal
只读任务完成，结果被保存后通过一次原生 `dsh_completion` 回到同一空闲
CLI 线程，随后 Luna/medium 的第二回合核对结果并在实际终端显示成功标记。
任务由绑定线程的安装后 MCP 客户端派发；该例验证配置正确时的实际回传链路，
**不等于 CLI 模型自主派发或普通 CLI 零配置启动已验收通过**。
此前 RC7 的账户初始化超时目前不再复现，两个 CLI 版本的只读账户检查通过；
精确根因仍未确认，不能断言版本故障或网络故障。
失败参数例 `effort:minimal` 与成功例分开保留；Flash 的推理强度和同名预设
不同。成功例为 `effort:off` 和 `preset:minimal`。

Codex Desktop 消息回传及退出重开后保存结果恢复已有 RC5 真实验收记录。
普通 DSH Web 的反向委派已有 RC6 真实验收记录。包内保留原版本的证据并标明
`historical`，不把它们写成本轮重做的付费模型验收。

本轮没有接通 Codex Desktop 原生回调。当前选择消息回传；不修改 Codex 内部代码。
本包默认使用兼容 DSH CLI `0.1.5-rc.1`，实际 **DSH Desktop.exe 尚未接入**。
Linux/macOS 已按用户要求移出本轮验收范围。项目包没有公开发布到 npm。

## Windows 隐藏启动

RC8 登录计划任务使用系统 Windows PowerShell 的隐藏监督脚本，
以 UseShellExecute=false、CreateNoWindow=true 启动原来的 Node daemon，
等待结束并返回同样退出码；保留登录触发器、低权限、IgnoreNew 和失败重启设置。
不会通过关闭服务来移除窗口。回滚到缺少监督脚本的旧版时恢复原始直接 Node
任务，避免旧版无法启动；旧版也恢复其原有窗口行为。
测试运行器最多并行四个文件，减少真实 DSH/安装初始化夹具的资源争抢。

## 安装后加载

旧聊天中的 MCP 进程不会热加载新版。安装后新建聊天或重开 Codex，建立新连接。
必须依据实际回执选择完成方式。Desktop 消息回传需要应用保持打开、官方工具插件
和调用端管道可用；原生注册失败则走同一 agent 的等待兜底。

全新机器需要 Windows、Node.js 24+（含 npm）和依赖下载网络。
本包不包含账号凭据，也不是所有依赖的离线集合；安装不会自动登录或开始模型任务。
