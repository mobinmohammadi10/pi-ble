# pi-bale

**A Bale companion for a running Pi session.**

Continue local Pi work from a private Bale bot chat: send prompts, queue work, inspect menus, abort or continue tasks, and exchange files and voice. This extension is not a remote shell or process launcher.

## Install and connect

Requires Node.js ≥22.19 and Pi ≥1.0.0.

```bash
npm install --ignore-scripts
npm run build
pi install /absolute/path/to/pi-bale
```

Local installation loads this checkout; it does not publish an npm package. Restart Pi after installation.

1. In Bale, open [@botfather](https://ble.ir/botfather), create a bot, and copy its token.
2. In Pi, run `/bale-setup` and enter the token, or configure `BALE_BOT_TOKEN` before starting Pi.
3. Run `/bale-connect`.
4. Immediately send `/start` in the bot's private Bale chat. The first successfully persisted user becomes the paired owner; other users are ignored.

Configuration is stored in `~/.pi/agent/bale.json`; runtime storage uses `tmp/pi-bale`. Existing bridge configuration is not migrated automatically. Do not share tokens. For stronger first-contact protection, preconfigure `profiles.default.allowedUserId` with your numeric Bale account ID while preserving the saved token.

## Supported surface

- Private-chat text prompts, queued turns, inline callback buttons, and operator menus.
- `/start`, `/new`, `/compact`, `/next`, `/continue`, `/abort`, and `/stop`, subject to normal Pi lifecycle guards.
- File uploads/downloads, photos, voice and media through the documented Bale methods; voice transcription/synthesis still requires a configured provider.
- Pi commands `/bale-setup`, `/bale-connect`, `/bale-disconnect`, and `/bale-status`.
- Agent tools and markup use the `bale_` namespace, including `bale_attach` and `bale_message`.
- Named bot profiles, single-user authorization, durable input admission and transport ownership checks.

## Bale compatibility limits

This port targets [Bale's documented Bot API](https://docs.bale.ai/), using `https://tapi.bale.ai/bot<TOKEN>/<METHOD>` and its file endpoint. It has not yet been verified against a live Bale bot.

Classic DM mode is the supported connection mode: one polling Pi process per bot. Private Threads, leader/follower Thread routing, reaction shortcuts, Guest Mode, native Rich Messages, draft previews, command-list synchronization and Rich activity blocks are not documented by Bale and are **not supported**. Thread discovery returns disabled; unsupported transport methods fail locally rather than being sent to Bale. Do not enable draft previews or Rich activity options retained in inherited settings.

Bale formats messages using its own Markdown subset. HTML harness text is converted at the transport boundary; plain Rich Markdown text is downgraded to ordinary messages. Rich blocks or embedded Rich media are rejected rather than silently dropped. Some inherited menu options still describe unavailable features; use classic text, callback menus and ordinary attachments. Formatting fidelity and client behavior require live acceptance.

## Safety

Pair only your own account. Let the queue drain before reload/restart, or accept losing waiting work. Keep Pi running while using the bot. The extension never launches hidden Pi processes or forwards arbitrary terminal commands. Diagnostics redact credentials; native typing remains best effort.

## Documentation

Start with [Bale compatibility](docs/bale-compatibility.md) and the [technical index](docs/README.md). Existing subsystem documents describe inherited implementation machinery; their compatibility notice limits those contracts to the Bale-supported subset. The historical changelog and vendored original-platform API reference remain provenance, not Bale capability claims.

This is a local port of the MIT-licensed `@llblab/pi-telegram` project, originally derived from `badlogic/pi-telegram`. Original copyright and historical release evidence are retained. No Bale package publication or upstream repository ownership is implied.
