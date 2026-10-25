# Bale compatibility

Authority: <https://docs.bale.ai/> (reviewed during this port).

## Transport

- JSON and multipart requests use `https://tapi.bale.ai/bot<TOKEN>/<METHOD>`.
- Downloads use `https://tapi.bale.ai/file/bot<TOKEN>/<file_path>` after `getFile`.
- `getMe`, `getUpdates`, `deleteWebhook`, message sends/edits/deletion, callback answers, files and `sendChatAction` are documented.
- `sendMessage` accepts `reply_to_message_id`; the adapter converts inherited `reply_parameters` to that field.
- Bale messages use Markdown without a `parse_mode` parameter. HTML UI is converted to a limited Markdown representation. Rich Markdown text is sent using `sendMessage`; block/media Rich payloads fail closed.
- Inherited optional entity, link-preview and update-filter parameters are removed at the boundary. Unknown methods and Thread-addressed sends are refused locally.

## Unsupported inherited surfaces

The documentation does not establish private-chat Threads, forum lifecycle, reactions, Guest Mode, native Rich blocks, draft APIs or `setMyCommands`. The port must not infer their availability from structural similarity with another Bot API. Thread capability is always disabled. Draft previews default off. Command synchronization can report an unsupported-method diagnostic; `/start` and normal messages remain independently admitted.

The internal bus, Workspace, Thread lifecycle and Rich rendering code remains inherited machinery, not an enabled Bale contract. Subsystem documentation and bundled skills apply only where compatible with this page. Never issue unsupported method probes or enable retained unavailable settings to claim support.

## Validation and remaining work

Controlled tests validate request translation and unsupported-operation rejection, not Bale client behavior. Before production use, validate a disposable bot with a real token: pairing, polling, text/menu callback round trips, Markdown, uploads/downloads, voice configuration, abort/continue, reconnect and durable replay. No live bot token was supplied for this port.

No automatic credential or accepted-work migration is performed. Use separate `bale.json` and `tmp/pi-bale` storage. Local installation requires a fresh build and a Pi restart/reload; it does not connect a bot automatically.
