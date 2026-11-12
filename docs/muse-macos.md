# Mac-only feasibility investigation

Checked on November 12, 2026 against Meta's official
[Muse Gadget SDK](https://github.com/facebookincubator/muse-gadget-sdk),
commit `2d9db7d`.

## Result

A separate Linux machine is not a fundamental requirement of Muse messaging.
The stock Gadget installer and Bluetooth backend target Linux, but much of the
SDK is reusable on macOS. A native Mac port is plausible and has not been paired
with a real phone in this investigation.

On this Mac, the unmodified Linux package's isolated test suite completed with
**810 passed, 2 skipped in 38.56 seconds**:

```sh
cd linux
uv run --no-project --isolated --with pytest --with . python -m pytest -q
```

The skipped tests require real root ownership/execution in a Linux container.
The suite uses fake VMs and synthetic pairing credentials; it does not establish
real Bluetooth compatibility or live Muse authorization.

## What needs adapting for a native Mac port

- Replace `ble_server.py`'s BlueZ/D-Bus/GLib GATT peripheral with CoreBluetooth.
  Keep the existing framing, encrypted pairing, and setup controller.
- Replace systemd/apt installation with a user-owned environment and launchd.
  Relocate `/var/lib` and `/run` defaults through the existing state/socket overrides.
- Advertise a custom Gadget model and a restricted command set. Do not reuse
  the installed Muse Mac app's identity or extract its account tokens.
- Test discovery and pairing on the actual Android phone. Apple's advertising
  API supports local name and service UUIDs, whereas the Linux backend also
  supplies manufacturer data. Whether Muse's Android discovery accepts that
  difference remains unverified.

[Apple advertising API](<https://developer.apple.com/documentation/corebluetooth/cbperipheralmanager/startadvertising(_:)>)
and [Meta Bluetooth backend](https://github.com/facebookincubator/muse-gadget-sdk/blob/2d9db7d/linux/src/musegadget/ble_server.py).

## Tailscale and Docker

Tailscale provides private IP connectivity for an already available service.
It can connect Mac to a paired Gadget host, but cannot supply a missing Bluetooth
peripheral or Muse pairing credentials.

Docker can run Linux code on Mac. Pairing still needs access to a Bluetooth
adapter and BlueZ/D-Bus. Docker Desktop's documented USB/IP route requires
additional device forwarding and does not guarantee every USB device works.
It is a possible hardware experiment, not a shortcut already verified here.

[Tailscale overview](https://tailscale.com/docs/concepts/what-is-tailscale),
[Docker USB/IP documentation](https://docs.docker.com/desktop/features/usbip/).

## Faster Mac-only POC

[Muse-Chat-MCP](https://github.com/duclm1x1/Muse-Chat-MCP) is an MIT-licensed
community project that automates the real Muse website with Playwright and a
dedicated Chrome profile. Its source documents side-chat selection and reads
rendered replies. This avoids Gadget pairing and Linux, but it is an unofficial
UI integration and can break when Muse changes its website.

The current dispatcher POC implements only the official Gadget command contract.
It cannot use this browser project merely by changing the executable: the CLI
arguments and receipt semantics need a separate adapter. No browser profile,
login cookies, or credentials belong in the dispatcher repository.

The Mac app UI POC created a one-time reminder and the user confirmed its
Android notification. The user then completed normal Muse web sign-in in a
separate browser session. Through Codex's supported browser automation:

- Created one disposable reminder titled `Mac browser POC disposable`.
- Read its actual scheduled-task panel: November 12, 2026 at 2:26 pm Phoenix time.
- Asked Muse to reschedule that same task to 3:15 pm Phoenix time.
- Reopened the task panel and verified the saved time changed to 3:15 pm.

- Asked Muse to cancel the disposable reminder and received its confirmation.
- Read the live scheduled-task region: the disposable task was gone; the
  guardian reminder, flight check, and heartbeat were still present.

No real Bluetooth pairing was attempted. These results prove the browser interaction
path, not a tested standalone dispatcher-to-browser MCP adapter. A production
browser transport still needs dedicated profile management, correlated replies,
serialized requests, durable no-replay receipts and explicit handling of login
expiry and uncertain results.

## Paired Mac SDK POC follow-up

The `wong2/muse-client` repository already implements macOS pairing using a small
CoreBluetooth helper. It is a TypeScript client of the Gadget protocol, not the
browser-based Muse-Chat-MCP project. Its repository at commit `1043c16` passed
58 tests; the separately enabled Python-reference interoperability test also
passed, for 59 passing tests overall. Type checking, the library build and native
helper compilation succeeded.

On November 12, 2026, the user paired the Mac helper with Muse on a OnePlus
Android phone. Device credentials were verified and saved outside the repository.
The connection check established the encrypted Noise session and chat
subscription. A direct SDK request created one test reminder titled `Muse SDK
POC`; Muse returned its scheduled time over the SDK connection. The actual Muse
task panel independently showed November 12 at 3:22 pm America/Phoenix.

The dispatcher now has a `muse-client` transport option using a private pairing
directory, an exclusive credential-owner lock, dedicated side chats, and the same
no-replay request ledger. The original Linux CLI transport remains available.
Real request receipts and pairing credentials stay in private state, never in
this repository. A live `send_muse_request` call through an actual stdio MCP client returned
`answered` via the paired Mac transport. Its read-only response confirmed the
test reminder time and reported that the scheduled run had started. Phone
notification delivery remains a separate user-observed acceptance check.

No native fork was needed for this POC. Before release, review the client's
licensing/notices, package maintenance, macOS permission onboarding, and Android
compatibility beyond this one device. Protocol acknowledgements and returned
text are never promoted to proof of phone notification delivery.
