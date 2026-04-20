<!-- pipelane:command:resume -->
Resume an existing task workspace for this repo.

Run:

```bash
npm run pipelane:resume -- $ARGUMENTS
```

Common forms:

- `npm run pipelane:resume -- --task "task name"`
- `npm run pipelane:resume`

Behavior:

1. With `--task`, restores the saved task workspace if it still exists.
2. With no args, lists active tasks or resumes the only active task.
3. If the saved workspace is gone, directs the user back to `{{ALIAS_NEW}}`.

Display the output directly. Call out that the chat/workspace has not moved automatically yet.

<!-- pipelane:consumer-extension:start -->
<!-- pipelane:consumer-extension:end -->
