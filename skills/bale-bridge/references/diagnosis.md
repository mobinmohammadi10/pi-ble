> Bale port: only the supported subset in [Bale compatibility](../../docs/bale-compatibility.md) is enabled. Inherited Thread, reaction, Guest, Rich block and draft contracts are not Bale capabilities.

# Bridge Diagnosis

Read this reference only when diagnosing Bale bridge health or delivery failure.

Inspect in this order:

1. `/bale-status` for compact health in the Pi TUI.
2. `/bale-status --debug` for bounded human-readable diagnostics in the Pi TUI.
3. `~/.pi/agent/tmp/pi-bale/state.json` (per-profile `transport`, `workspace` canonical bindings and `runtime` roster/diagnostics sections) and `logs.jsonl` (profile-labelled redacted evidence); rotated history is `logs/logs._prev.jsonl`.
4. For a named profile, read its `profiles.<name>` entry and filter log records by `profile`; service journals are `journals/<kind>.<profile sha256>.json`.

These slash commands are registered Pi commands, not shell executables or agent tools. If the agent cannot invoke them through a supported Pi surface, read the diagnostic files directly; do not run them in Bash or inject terminal input.

When `PI_CODING_AGENT_DIR` selects another compatible runtime, resolve its equivalent `tmp/pi-bale` directory.

A `persistent-conflict` polling stop means the bounded competing-`getUpdates` threshold triggered full transport stand-down, not cancellation of accepted local Pi work. The terminal diagnostic distinguishes lost local ownership from a competing client despite an apparently owned lock. Check other profiles, agent directories, installations, or non-Pi clients sharing the bot; after removing the competition, reconnect through the supported Pi command. Do not restart repeatedly or alter lock files to compete for the stream.

Do not mutate ownership files, bridge state, journals, bindings, or locks to force recovery. Use supported commands and preserve exact profile, target, transport, and session authority. Never claim successful delivery without transport evidence.
