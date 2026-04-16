Open the Pipelane Board — the visual release-pipeline dashboard for this repo.

Run:

```bash
npm run pipelane:board -- $ARGUMENTS
```

Common forms:

```bash
npm run pipelane:board            # start (if not already running) and open the browser
npm run pipelane:board -- stop    # stop the Pipelane Board for this repo
npm run pipelane:board -- status  # show URL, port, PID, log path
```

This command:

1. Checks whether the dashboard is already responding on the configured port (`/api/health`). If it is, just opens the browser to that URL.
2. Otherwise spawns the dashboard detached in the background, waits up to 8 seconds for it to become healthy, writes a PID file, and opens the browser.
3. Is safe to run repeatedly. No orphan servers, no port thrash.

Options:

- `--no-open` — start the server but do not open the browser.
- `--port <n>` — override the port for this invocation.
- `--repo <path>` — point at a different repo (default: cwd).

State lives under `~/.workflow-kit/dashboard/` (path retained across the workflow-kit → pipelane rename; a `~/.pipelane/dashboard/` migration ships in a follow-up release):

- `pids/<slug>-<hash>.pid` — PID of the background dashboard
- `logs/<slug>-<hash>.log` — dashboard stdout/stderr
- `<slug>-<hash>.json` — per-repo board settings (title, subtitle, preferred port, auto-refresh)

Display the command output directly. If the dashboard failed to become healthy within 8s, surface the log path so the operator can inspect what went wrong.
