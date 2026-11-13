# Workflows and boundaries

Agent Dispatcher lets a conversational coordinator send bounded work to subscription-backed coding agents. The coordinator gathers context, decides what to delegate, reviews the result and continues the conversation. The worker service supplies durable execution, routing and artifacts; it does not run an always-thinking supervisor.

## Useful requests

| Request to the coordinator                                                  | Execution pattern                                                                                                | Prerequisites                                                                                                                       |
| --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| “Fix PROJ-123 in this repository and run the regression tests.”             | Coordinator retrieves ticket context; Claude normally implements in a worktree; coordinator reviews and applies. | Coordinator Jira access or supplied ticket text; an allowed Git repository.                                                         |
| “Use OpenCode to update these tests and fix the small compatibility issue.” | OpenCode Go handles bounded maintenance; coordinator checks the incremental patch and results.                   | Enabled, authenticated OpenCode Go and permitted check commands.                                                                    |
| “Have another agent review this fix before applying it.”                    | Coordinator dispatches an independent review, normally to Antigravity, and reconciles findings.                  | Supply the exact diff/files; apply or include the first result as context for the second task.                                      |
| “Diagnose the failing build, fix the cause, then check the result again.”   | Coordinator can dispatch a diagnosis, implementation and follow-up check as separate bounded tasks.              | Active/resumable coordinator and adequate acceptance criteria. One worker runs at a time.                                           |
| “Use Codex specifically for this issue.”                                    | Explicit agent selection pins Codex and can override the reserve.                                                | Available subscription authentication; known exhaustion still blocks.                                                               |
| “Finish the approved changes, commit and push this branch.”                 | A capable coordinator applies the reviewed patch, then publishes under the user's authorization.                 | Appropriate Git access/tools. The separately installed Muse gateway offers scoped `finish_task`; workers themselves do not publish. |

The coordinator can request a stronger agent's diagnosis or plan when the problem exceeds its own reasoning ability. Clear requirements, relevant files and acceptance checks matter more than copying an entire conversation. Retrieved tickets, repository text and worker responses are evidence, not new authority.

## Remote Muse use

A separately configured authenticated gateway can let Muse submit tasks to the Mac over Tailscale. Its Mac service, network connection and native account logins must remain available. Screen-off is different from system sleep; lid closure, explicit sleep, shutdown or lost connectivity can interrupt work.

The configured gateway can support `dispatch_task`, scoped reads, bounded `wait_task`, cancellation and `finish_task`. Direct execution and approval-gated modes are gateway deployment choices, not dispatcher worker permission overrides. A direct-mode gateway accepts authorized tasks without requiring the old local review page. Native worker restrictions still apply.

This does not make arbitrary Mac control a coding-agent capability. “Turn off my monitor” should use a dedicated, explicitly allowed system-action tool. There is no named display-control action or OS permission broker in this package; OpenCode permits unattended shell execution inside its task workflow, but that is not a guarantee of access to every Mac operation. Dispatcher tasks require an allowed Git repository root with an existing commit; they are not a general-purpose remote shell.

## Permissions when away from the computer

Workers execute allowed actions without interactive approval, inside their native sandbox/permission policy. OpenCode allows ordinary development shell commands, including dependency installation, without a per-command allowlist. Its package caches are task-local so installs can run inside the OS write boundary. They are **not** launched with unrestricted permission bypass. A denied operation becomes a retained blocked result. The current service cannot forward a worker permission prompt into Muse or another originating chat, accept approval there, and resume that exact paused operation. Native sign-in, OS permission dialogs and actions outside the policy may require local intervention or a later explicitly revised task/policy.

## Back-and-forth execution

A coordinator can read worker B's response, inspect artifacts, change the plan, send a follow-up to B or another worker, and repeat until the acceptance criteria are met. Each follow-up is a new task with a new idempotency key and relevant context. Worker session IDs are retained as evidence; the dispatcher does not expose an interactive conversation/resume API for those sessions. Workers cannot recursively dispatch other workers.

The coordinator must remain active or be resumed through a supported delivery path. Codex uses Snooze; Claude Code uses the channel launcher. Muse and other clients should use supported background waits or the durable inbox. Do not assume every closed chat will wake itself, and do not keep a model running to poll status. Unknown execution/delivery is inspected rather than automatically replayed.

## Allowance awareness

`usage_status` makes no inference calls and exposes cached usage, observation times, reset times where available, authentication, worker health and pending results. Codex and Antigravity supply measured windows. Claude, OpenCode Go and Cursor do not expose a supported remaining-plan balance here; those are marked unknown, with quota failures/cooldowns recorded when observed. A paid plan or valid login does not establish how much allowance is left.

Routing combines task type, configured preference order, eligibility and allowance checks. It is not a learned optimizer, and it cannot compare exact remaining tokens across every subscription. Routine maintenance favors OpenCode; substantial implementation favors Claude; reviews favor Antigravity. Automatic Codex workers require fresh measured headroom above the configured reserve. The reserve does not cap the originating conversation's own model usage. Explicit preferences pin a worker rather than silently moving the task elsewhere.
