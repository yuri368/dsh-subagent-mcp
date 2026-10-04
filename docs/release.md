# Local release and upgrade

The local release candidate is **0.8.0-rc.8** for Windows. Building a local artifact does not publish it to npm. Run the pack command only after all source changes are complete:

```powershell
node scripts/pack-local-release.mjs C:/path/to/output
```

This creates a `.tgz`, a `.tgz.sha256` integrity sidecar and a `.tgz.manifest.json` containing the packed file inventory. The pack entry validates shrinkwrap against the source package lock and inspects actual tarball bytes before creating success sidecars. A missing or altered lock rejects and removes the artifact. npm normalizes tar metadata; the same source and npm version produce the same artifact. The explicitly whitelisted `npm-shrinkwrap.json` locks direct and transitive runtime dependencies. Keep it synchronized with `package-lock.json` when deliberately updating dependencies. Installation uses `--ignore-scripts`. RC1 draft artifacts omitted this lock and are superseded by RC2.

From an installed release:

```powershell
dsh-subagent-mcp upgrade --package C:/path/to/dsh-subagent-mcp-0.8.0-rc.8.tgz --yes --no-install-deps
dsh-subagent-mcp rollback
```

For first installation, use npm's local artifact runner:

```powershell
npm exec --yes --package=C:/path/to/dsh-subagent-mcp-0.8.0-rc.8.tgz -- dsh-subagent-mcp setup
```

`upgrade --package` verifies the sidecar before npm sees the artifact. Verify the sidecar independently before first installation. `upgrade` without a package queries npm latest, checks its complete semantic version including prereleases, then runs that exact version. A public 0.7.0 cannot replace 0.8.0-rc.8. `rollback` is the explicit route to a retained older installation.

The Windows delivery's `Install.ps1` verifies the bundled artifact and invokes
RC8 `setup --yes --completion-mode auto`, migrating the old explicit Desktop
selection to the agreed CLI/Desktop defaults. Ordinary setup without that flag
preserves an existing explicit policy. Retained rollback restores the target
installation's saved completion policy; a legacy target without one receives
`native`, so it never inherits an unsupported `auto` setting. Other Codex
settings and custom timeouts remain unchanged.

Each setup uses a fresh version directory with a random suffix and stores SHA-256 hashes for every program file, excluding dependency directories. Existing directories remain intact. `previousInstallation` records the previous actual directory and hashes, including previously accepted local patches. Rollback activates that exact retained directory and does not redownload npm code. Repeated onboarding is a no-op at the same version; explicit repeated setup makes another retained directory safely.

Upgrades and rollback reject active tasks. Setup refuses modified files or an older installation without an integrity baseline. Save the existing program directory and review its changes before explicitly passing `--replace-modified`. That option accepts replacement while retaining the original directory for rollback. A custom skill is never replaced automatically; use `--no-skill` to preserve it. Modifying an owned linked skill also changes the integrity hashes and requires deliberate migration.

Codex registration edits only the bridge command, args, state and config environment values in `config.toml`. It validates the complete TOML before editing, locates the owned values in the original source, then validates the result and compares its complete parsed values against the intended changes. Valid multiline command strings and args arrays, quoted/dotted keys and inline env tables are supported. Unknown values, their formatting, unrelated sections and CRLF line endings are preserved. Comments inside a replaced launch array are retained as standalone comments; trailing comments are retained. Timeouts, `env_vars`, callback/model settings and other environment entries keep their values. Invalid TOML, duplicate definitions, invalid command/args/env types and unsupported inline parent registration tables are refused before any configuration write. A setup failure restores the prior registration bytes, installation record and owned skill link before restoring the previous service. State/history/provider settings are not purged. Capturing a new provider key is an explicit credential operation and is independent of program rollback.

Dedicated checks (OS/service/provider integrations are stubbed in the journey fixture):

```powershell
node --test test/release-safety.test.mjs test/release-journey.test.mjs test/release-package.test.mjs
```

These cover setup success, failure after registration, exact configuration restoration, repeated setup, retained patched rollback, active-task rejection, custom configuration preservation, modified program detection, prerelease downgrade protection and real npm installation of an isolated local fixture artifact. Production daemon acceptance and final artifact validation remain separate release gates.
