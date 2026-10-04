# Windows fork status

This fork retains the upstream project history, authorship and MIT license. It is based on upstream commit d3be85ca24c01df3f0419a104cb6a60280d60c9b. RC8 runtime changes were developed with Codex assistance. No upstream pull request is part of this delivery.

## Validated locally on Windows

- Full RC8 automated suite: 182 passed, 0 failed, 0 skipped. Package, real DSH preset and fresh-install gates were enabled.
- Delivered RC7 to RC8 installer upgrade: completed; account files and unrelated settings preserved.
- Hidden startup: upgrade launch and two actual scheduled-task restart cycles; all three observations had zero visible windows and a healthy service. Actual OS reboot/login was not performed.
- Fresh installed MCP connection: 14 tools. DSH-to-Codex Astra requests rejected before worker launch in explicit/default/resumed cases.
- Configured real DSH-to-CLI native callback: one real Flash/off/minimal task settled, saved its result and delivered once to the same idle CLI 0.159.2 thread; the CLI displayed its review. An external installed MCP client dispatched the task using RC7 components; RC8 callback/delegation files were byte-identical.
- Desktop message delivery and exit/reopen recovery have RC5 historical acceptance; ordinary DSH Web reverse delegation has RC6 historical acceptance. They were not repeated as new RC8 paid tasks.

Raw local logs, private connection files, credentials and chat transcripts are not included here. These counts describe prior local RC8 acceptance, not a GitHub Actions run or a fresh validation on someone else's account. This fork changes repository metadata and documentation only beyond the accepted RC8 runtime source.

## Scope

The supported delivery target is Windows. Linux/macOS are outside this fork's acceptance scope. CLI native callback requires the working CLI and callback to share the same App Server. Autonomous natural-language CLI dispatch, ordinary CLI zero-configuration native startup and a continuous one-hour wait remain unverified. Codex Desktop uses desktop-message; Desktop native callback and the standalone DSH Desktop.exe are not integrated.

Sol/Luna model defaults and the Astra denial apply to this bridge's DSH-to-Codex delegation, not Codex built-in subagents. See model-routing.md.

Install from this checkout as described in setup.md. Commands using the upstream npm latest package in historical documents refer to the original project. This fork is not published to npm, and private=true prevents publishing under the original package name.
