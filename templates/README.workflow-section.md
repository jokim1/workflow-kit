## Workflow

This repo uses `pipelane` (formerly `workflow-kit`), the repo-specific workflow layer for AI-first builders.

It is designed to work well with Claude, Codex, and similar tools by keeping the release flow
deterministic:

- repo-native commands are the source of truth
- slash commands are thin adapters
- `{{ALIAS_NEW}}` creates explicit isolated task workspaces
- `{{ALIAS_RESUME}}` recovers them later when needed

The default alias set can be changed in `.project-workflow.json`. If aliases change, rerun
`npm run pipelane:setup` and reopen Claude/Codex so the new names are picked up.
Aliases must be unique, and setup fails closed if an alias would overwrite an unrelated command.
Codex resolves aliases per repo at runtime, so the same alias can mean different pipelane commands in different pipelane repos on one machine.

### Two dev modes

`pipelane` gives this repo two lanes:

- `build`: the fast lane, where merge is expected to hand off production deploy
- `release`: the protected lane, where staging happens before prod for the same merged SHA

### Build mode user journey

User-facing:

1. `{{ALIAS_DEVMODE}} build`
2. `{{ALIAS_NEW}} <task-name>`
3. `{{ALIAS_PR}}`
4. `{{ALIAS_MERGE}}`
5. `{{ALIAS_CLEAN}}`

Repo-native:

```bash
npm run pipelane:devmode -- build
npm run pipelane:new -- --task "example-task"
npm run pipelane:pr -- --title "Example PR title"
npm run pipelane:merge
npm run pipelane:clean
```

### Release mode user journey

User-facing:

1. `{{ALIAS_DEVMODE}} release`
2. `{{ALIAS_NEW}} <task-name>`
3. `{{ALIAS_PR}}`
4. `{{ALIAS_MERGE}}`
5. `{{ALIAS_DEPLOY}} staging`
6. `{{ALIAS_DEPLOY}} prod`
7. `{{ALIAS_CLEAN}}`

Repo-native:

```bash
npm run pipelane:devmode -- release
npm run pipelane:new -- --task "example-task"
npm run pipelane:pr -- --title "Example PR title"
npm run pipelane:merge
npm run pipelane:deploy -- staging
npm run pipelane:deploy -- prod
npm run pipelane:clean
```

### Command surface

- `{{ALIAS_DEVMODE}}`
- `{{ALIAS_NEW}}`
- `{{ALIAS_RESUME}}`
- `{{ALIAS_PR}}`
- `{{ALIAS_MERGE}}`
- `{{ALIAS_DEPLOY}}`
- `{{ALIAS_CLEAN}}`
- `{{ALIAS_STATUS}}`
- `{{ALIAS_DOCTOR}}`

Canonical repo-native commands:

- `npm run pipelane:setup`
- `npm run pipelane:devmode -- ...`
- `npm run pipelane:new -- --task "<task-name>"` (the `--task` flag is optional; omitting it generates a `task-<hex>` slug)
- `npm run pipelane:resume -- --task "<task-name>"`
- `npm run pipelane:pr -- ...`
- `npm run pipelane:merge`
- `npm run pipelane:release-check`
- `npm run pipelane:task-lock -- verify --task "<task-name>"`
- `npm run pipelane:deploy -- staging|prod ...`
- `npm run pipelane:clean`
- `npm run pipelane:status`
- `npm run pipelane:doctor` (add `-- --probe` for live healthchecks, `-- --fix` for the guided wizard)

The legacy `workflow:*` script names remain wired as deprecation aliases for one release window.

### pipelane + gstack

Use both.

- use `pipelane` for task workspaces, PR prep, merge, and deploy flow
- use gstack for review, QA, architecture review, deploy bootstrap, docs, and investigation

If this repo is adopting pipelane for the first time, commit the tracked workflow files
before using `pipelane:new` in a remote-backed repo.

### What each user still needs to do

- One repo maintainer runs `pipelane init`, reviews `.project-workflow.json`, and commits the tracked workflow files.
- Each Claude user pulls the repo and reopens Claude if command files or aliases changed.
- Each Codex user runs `npm run pipelane:setup` on their own machine and reopens Codex if needed.
- Each release operator fills local deploy config in `CLAUDE.md` and verifies with `npm run pipelane:release-check`.

Use [docs/RELEASE_WORKFLOW.md](./docs/RELEASE_WORKFLOW.md) for the full operator workflow.
