<!-- pipelane:command:smoke -->
Plan smoke coverage, configure the smoke runner, or run deterministic smoke against staging or prod.

Run:

```bash
npm run pipelane:smoke -- $ARGUMENTS
```

Expected subcommands:

- `plan` — scaffolds or audits `.pipelane/smoke-checks.json` and prints the top actions.
- `setup` — wires a smoke runner command into `.pipelane.json`. See "Setup quoting" below for passing commands with spaces / metacharacters.
- `staging` — runs smoke for the currently deployed staging SHA.
- `prod` — runs the prod-safe smoke subset for the currently deployed prod SHA.
- `waiver` / `quarantine` / `unquarantine` — coverage-registry management.

Rules:

- `staging` / `prod` inject `PIPELANE_SMOKE_ENV`, `PIPELANE_SMOKE_BASE_URL`, `PIPELANE_SMOKE_SHA`, and `PIPELANE_SMOKE_RUN_ID` into the repo-owned smoke command.
- `setup` is two-mode: either **auto-wired** (exactly one strong candidate package script, or explicit `--staging-command`) or **needs input** (multiple candidates, weak-only, or no candidates — setup writes nothing and tells you which flag to pass).
- `setup` refuses to promote a release gate it cannot run: `--require-staging-smoke=true` plus no staging command is treated as misconfigured and exits 1.
- `setup` exit codes: 0 for `configured` / `already configured` / `needs input`; 1 for `misconfigured` or write failures.

## Setup input forms

For the common case — picking a package.json script — use the **script form**. No quoting, no `npm run` prefix, no shell-escape gotchas:

- `/smoke setup --staging-script=test:e2e:smoke` → writes `smoke.staging.command = "npm run test:e2e:smoke"`.
- `/smoke setup --prod-script=test:e2e:smoke:prod` → writes `smoke.prod.command = "npm run test:e2e:smoke:prod"`.

For non-Node repos or custom invocations, use the **command form**:

- **Claude slash command:** `/smoke setup --staging-command="make smoke"` (single quotes also work).
- **Codex skill:** same double-quoted form.
- **npm script:** `npm run pipelane:smoke -- setup --staging-command="make smoke"` (note the `--` separator).
- **Bare CLI:** `pipelane run smoke setup --staging-command='pytest -k smoke --workers=2'` (single quotes when the value contains double quotes; avoid literal `@smoke-*` tag syntax in docs or smoke tag discovery will treat the doc itself as a test source).

Script and command forms are **mutually exclusive** — pass one or the other, not both.

Setup flags (accepted only on `smoke setup`):

- `--staging-script=<name>` — package.json script name; auto-prefixed to `npm run <name>`. Preferred when applicable.
- `--staging-command=<cmd>` — full shell command. Use when not a package script.
- `--prod-script=<name>` / `--prod-command=<cmd>` — same shape for production. Mutually exclusive with each other.
- `--require-staging-smoke=true|false` — release-gate switch; must pair with a staging script/command when true.
- `--generated-summary-path=<path>` — override the smoke summary output path.
- `--critical-path=<surface-or-path>` — repeatable; deduped, first-seen order preserved.
- `--critical-path-coverage=warn|block` — how /deploy prod treats uncovered critical paths.

Display the output directly and keep the environment explicit.

<!-- pipelane:consumer-extension:start -->
<!-- pipelane:consumer-extension:end -->
