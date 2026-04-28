<!-- pipelane:command:merge -->
Merge the current task's pull request.

Run:

```bash
npm run pipelane:merge -- $ARGUMENTS
```

This command:

1. Verifies the task lock.
2. Waits for required checks.
3. Squash-merges the PR.
4. Records the merged SHA for later deploy flow.

Display the output directly. If the output prints "Choose the action to take:",
ask the user to pick one of the printed choices; do not reduce it to "rerun with
--yes". When the user picks a runnable choice, run the matching slash command.
Report the merged SHA and the next step using slash commands only.

<!-- pipelane:consumer-extension:start -->
<!-- pipelane:consumer-extension:end -->
