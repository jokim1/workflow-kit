<!-- pipelane:command:doctor -->
Diagnose deploy configuration, run live probes, or launch the fix wizard.

Three modes:

```text
# Read CLAUDE.md, list missing deploy fields, detect platform.
{{ALIAS_DOCTOR}}

# Hit each configured staging/production healthcheck URL and record
# liveness to probe-state.json. Required for release-mode readiness.
{{ALIAS_DOCTOR}} --probe

# Interactive wizard: asks platform + URLs, writes the Deploy
# Configuration block in CLAUDE.md, then auto-runs --probe.
{{ALIAS_DOCTOR}} --fix
```

Rules:

- `/doctor --probe` writes `probe-state.json`. The release gate blocks when
  any probe is older than 24h or non-2xx.
- `/doctor --fix` requires a TTY. Use `pipelane configure` for scripted setup.
- Diagnose is a pure read — no side effects, safe to run anytime.

<!-- pipelane:consumer-extension:start -->
<!-- pipelane:consumer-extension:end -->
