> Bale port: only the supported subset in [Bale compatibility](../../docs/bale-compatibility.md) is enabled. Inherited Thread, reaction, Guest, Rich block and draft contracts are not Bale capabilities.

# Configuration And Extension APIs

Read this reference only when configuring voice/media handlers or developing against pi-bale extension APIs.

Prefer shell-free command templates in `bale.json` before adding a companion extension:

- `inboundHandlers` transforms text/media before queueing.
- `outboundHandlers` transforms final replies.
- Voice transcription handlers may match `type: "voice"` or `mime: "audio/*"`; stdout becomes `[outputs]`.

Follow `docs/voice.md`, `docs/inbound.md`, `docs/outbound.md`, and `docs/command-templates.md` from the pi-bale package or repository. Inspect available Skills and trusted local executables for STT, TTS, or conversion capability. Check only whether required environment variables exist; never reveal their values.

Preserve unrelated `bale.json` fields. Order matching handlers as fallbacks, require OGG/Opus for native voice, validate every stage before a live smoke test, and keep `voice.replyMode` unchanged unless the user requests a policy change. Explicit `bale_voice` works in the default `manual` mode.

When configuration is insufficient, use documented `@llblab/pi-bale/*` package subpaths. Never import package-private `lib/*`, start another polling loop, bypass bridge ownership with raw Bot API access, or capture stale runtime state.
