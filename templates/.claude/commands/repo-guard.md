<!-- pipelane:command:repo-guard -->
Verify the current checkout is safe for a task, or create an isolated task worktree when it is not.

Run:

```bash
npm run pipelane:repo-guard -- $ARGUMENTS
```

Expected form:

```bash
npm run pipelane:repo-guard -- --task "task name"
```

This command:

1. Reuses the current checkout only when it already matches the requested task safely.
2. Creates a fresh isolated sibling worktree when the current checkout is `main`, dirty, or already tied to different task work.
3. Refreshes the task lock so later `pipelane:task-lock -- verify` checks stay aligned.

Display the output directly. If a new worktree is created, call out that the chat/workspace has not moved automatically yet.

<!-- pipelane:consumer-extension:start -->
<!-- pipelane:consumer-extension:end -->
