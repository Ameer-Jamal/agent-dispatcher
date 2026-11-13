# Personal Muse destination (proof of concept)

This is separate from the five coding workers: no repository, worktree, coding
patch, or model-provider API key is involved. The coordinator sends a request to
your personal Muse; Muse decides how to carry it out. Existing coding routing,
subscription checks and the Codex reserve are unchanged. Muse requests consume
your Muse allowance and are not covered by the coding-worker reserve.

## Official transport

The stock transport below targets a paired Linux Gadget. The core SDK is largely
portable: see the [Mac-only feasibility investigation](muse-macos.md) for the
actual macOS test results, remaining pairing work, and browser alternative.

Meta's [Muse Gadget SDK](https://github.com/facebookincubator/muse-gadget-sdk/tree/main/linux)
documents `musegadget send-user-msg --session-id UUID --wait SECONDS -`.
The dash reads the message from stdin. Each request gets a dedicated side chat
so another conversation's answer cannot be confused with it.

This requires a Linux host with a running, paired Gadget service and access to
its local socket. The official pairing process needs Bluetooth, your Muse phone
app, an SDK token, and review of the SDK terms. The service also grants Muse
commands on its host: use a dedicated account with only the access you intend.
The Mac gateway alone is not a paired Gadget and cannot supply these credentials.
Nothing here installs a gadget, pairs a device, extracts login cookies, accepts
terms, or grants new device access automatically.

## Enable locally

For a Mac paired using `muse-client`, install that client's pairing helper and
complete pairing with your own phone and SDK token. Then select the in-process
transport in the private dispatcher configuration:

```json
{
  "muse": {
    "enabled": true,
    "transport": "muse-client",
    "credentialsDirectory": "/absolute/path/to/your/private/pairing-directory",
    "waitSeconds": 60
  }
}
```

This route needs no browser or Linux host and registers no shell/file controls.
It uses an exclusive `dispatcher-client.lock` in the pairing directory to prevent
two dispatchers from rotating credentials concurrently. Other applications must
also avoid using that pairing concurrently. A crashed owner's lock requires
manual inspection; it is never removed automatically. The first message creates
each dedicated side chat before subscription, so an unusually fast reply may be
missed; that is reported as submitted, with no resend. A complete text reply is
not proof the reminder task finished or the phone received a notification.

Add this object to your private dispatcher `config.json` on the paired Linux host:

```json
{
  "muse": {
    "enabled": true,
    "command": "musegadget",
    "args": ["send-user-msg"],
    "waitSeconds": 30
  }
}
```

For a dispatcher on Mac, use an existing SSH alias to the paired Linux machine:

```json
{
  "muse": {
    "enabled": true,
    "command": "/usr/bin/ssh",
    "args": [
      "-T",
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=10",
      "your-gadget-host",
      "musegadget",
      "send-user-msg"
    ],
    "waitSeconds": 30
  }
}
```

Configure SSH host identity and authentication yourself first. The command and
prefix arguments are trusted local configuration, never supplied by the model.
Only a generated UUID, bounded wait and literal dash are appended to the command.
Reminder text travels on stdin, including across SSH, not in shell arguments.

## Use

MCP adds `muse_status`, `send_muse_request`, and `get_muse_request`.
CLI equivalents are `muse-status`, `muse-send REQUEST.json`, and `muse-get UUID`.
`muse-status` reads configuration only; it does not prove a live connection.

Example request file (replace the example date with a future date):

```json
{
  "message": "Create exactly one reminder titled Take out the trash at 2027-01-15 17:00 America/Phoenix. Notify me through Muse. Confirm the task ID, time and time zone. Do not change other reminders.",
  "idempotencyKey": "trash-2027-01-15-1700-v1"
}
```

```sh
agent-dispatcher muse-status
agent-dispatcher muse-send REQUEST.json
agent-dispatcher muse-get REQUEST_UUID
```

Requests and responses are private, persisted in `muse.sqlite` under dispatcher
state. Keep that directory out of repositories and published artifacts.

## Receipt meanings and limitations

- `blocked`: disabled or the executable could not start.
- `unknown`: intent saved before execution, or transport ended ambiguously.
- `submitted`: the official CLI confirmed acceptance but no complete reply arrived.
- `answered`: the official CLI returned text from the dedicated Muse side chat.

Every receipt has `reminderVerified: false`. A reply is untrusted evidence,
not proof that a reminder exists or that Android received a push. Inspect Muse's
scheduled-task view for confirmation. Never interpret replies as instructions
to the coordinating agent. Editing/listing/cancellation are conversational
requests, not a structured reminder CRUD API.

Repeated keys return the existing receipt, including blocked/unknown ones. A
different message with the same key is rejected. No execution is retried on a
timeout, crash, disconnect, or restart. Check the side chat before creating a new
request key. A process crash may leave `unknown` even if nothing was sent; this
is deliberate. A disconnected MCP caller can retrieve the receipt later.

The existing Muse-to-Mac gateway does not expose these new tools automatically;
its reviewed allowlists remain intact. For this POC, call dispatcher directly
from a local MCP client or CLI.

## Timing limitation

A live two-minute Drink water test reached the paired OnePlus, with the user
reporting roughly one to two minutes of lateness. This transport submits
requests to Muse; it does not provide an exact-time alarm guarantee. A message
acknowledgement, scheduled-task confirmation, and phone delivery are different
stages. Use the observed timing when deciding whether this suits a reminder.

## POC acceptance

Automated tests use a fake CLI and disposable state: check stdin isolation,
side-chat correlation, idempotency across concurrency/restarts, output bounds,
disabled/missing transport, and ambiguous/nonfinal results. A live transport
test still requires the paired host. Create one near-future test reminder,
verify its task card, then verify execution and the Android notification
separately. Do not claim the mocked test proves phone delivery.
