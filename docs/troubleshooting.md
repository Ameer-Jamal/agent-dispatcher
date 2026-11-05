# Troubleshooting

- **Claude unavailable:** run `claude auth status --json`. Sign in with `claude auth login`; the accepted method is `claude.ai`. A paid web subscription does not establish that this CLI is signed in. The dispatcher does not initiate browser login or alter subscription settings.
- **Codex unavailable/unknown usage:** run `codex login status`, then `agent-dispatcher doctor`. Account reads are throttled to once per minute. A transient failure blocks automatic Codex selection conservatively; wait one minute and retry doctor. It does not consume a model turn.
- **No eligible worker:** inspect `status` and `doctor`. Check subscription login, allowance freshness, reserve and quota cooldown. An explicit `prefer` bypasses reserve only, not missing authentication or cooldown.
- **No worker progress:** verify `service install` succeeded and `status` reports a recent heartbeat. Inspect private `service-error.log`. For foreground diagnosis stop the service and run `worker`; never run two schedulers against one state directory.
- **No Codex notification:** verify Snooze is configured and its worker healthy. Inspect its saved job and delivery event. `queued` means queue acceptance, not confirmed model execution. Use `get_task` to retrieve results if the chat is closed or the schedule/delivery is uncertain.
- **No Claude notification:** plain MCP cannot wake Claude. Start through `agent-dispatcher claude`; the current CLI must support custom development channels. Resume the exact session with `--resume UUID`. Pending results persist while disconnected. Unknown or delivered-but-unacknowledged events require explicit retrieval rather than automatic duplicate sends.
- **Permission blocks:** inspect worker evidence. Native sandbox/permission restrictions remain enabled. Fix the needed scoped permission through your CLI policy; do not bypass all permissions.
- **Patch conflict:** changes are retained in the isolated worktree. Review and reconcile the patch against current source. `apply` checks the entire patch before applying it and does not stage it.
- **Interrupted runner:** inspect retained artifacts before resubmitting with a new idempotency key. A surviving orphan worker blocks subsequent execution; verify its PID/start time in the task record and stop it before retrying. Never blindly replay an uncertain task.
- **Stale lock:** the scheduler removes a lock only when the recorded process identity no longer exists. An unreadable lock is an uncertainty requiring inspection; do not delete a live worker's lock.
- **Submodules or no commits:** v1 requires a Git root with HEAD and no submodules. Run such tasks directly until their snapshot semantics are supported.
- **SQLite warning:** Node 22 may mark its built-in SQLite API experimental. Warnings go to stderr, not the MCP stdout transport.

Keep the Mac awake and logged in for unattended local work. No tool here wakes a sleeping computer. Results are private local files, not encrypted storage. Remove retained worktrees deliberately after review.
