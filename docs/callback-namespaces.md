> Bale port: only the supported subset in [Bale compatibility](bale-compatibility.md) is enabled. Inherited Thread, reaction, Guest, Rich block and draft contracts are not Bale capabilities.

# Callback Namespace Standard

Bale `callback_data` is one bot-wide namespace. Any extension that creates inline buttons for a bot shared with `pi-bale` must use namespaced callback data.

## Format

```text
<namespace>:<action>[:<payload>]
```

Examples:

```text
vividfish:approve:123
vividfish:deny:123
myext:page:2
```

## Rules

- Use a stable extension-owned namespace, preferably the package or extension name without scope punctuation.
- Keep the namespace lowercase ASCII: `a-z`, `0-9`, `_`, `-`.
- Do not use `pi-bale` owned prefixes: `compact:`, `new:`, `tgbtn:`, `menu:`, `model:`, `thinking:`, `status:`, `queue:`, `settings:`, `section:`, `reroute:`, `reroutemenu:`, `rerouteroot:`, `reroutenew:`, `rerouterestore:`, `reroutecancel:`. The `reroute*` family belongs to exact-source unbound Thread choosers; `reroutecancel:` retains an eligible owner's original before cancelling its routing authority. Its `review:` branch owns Status recovery for protected cancellation attempts; `history:` remains reserved only to reject retired historical-review controls. Action payloads carry a fresh bounded view nonce and an index, never caller-supplied journal paths or source authority. Current app navigation uses `menu:`; `status:` remains reserved for legacy/owned status callbacks but is not emitted by current UI. `compact:` and `new:` are owned by their destructive-action confirmation dialogs. `section:` is owned by the Extension Sections platform (0.10.0+), documented in [Extension Sections](./sections.md). `settings:` is owned for the built-in Settings submenu.
- Keep the full `callback_data` within Bale's 64-byte limit.
- Put only opaque ids or small enum values in payloads; do not store secrets, full prompts, or large state.
- Treat callbacks as untrusted input. Validate namespace, action, and payload before executing side effects.

## Queue Controls

The Steer surface owns `queue:lane-set:<chat>:<message>:steer|priority|normal` and independent `queue:skip-set:<chat>:<message>:keep|skip`. Previously published `queue:prio-set` and `queue:prio` controls remain explicit Priority/Normal compatibility routes. Payloads only identify a current view; they cannot grant source/session authority or edit a protected pending/frozen item. Control lanes remain producer-owned.

## pi-bale fallback

If `pi-bale` receives callback data that is not owned by its built-in prefixes and no built-in handler consumes it, it forwards the click to Pi as:

```text
[callback] <callback_data>
```

Layered extensions may intercept that message and handle their own namespace. If no extension handles it, the assistant may see the fallback message and should tell the user the callback was not handled and the environment may be misconfigured.

## Extension sections

[Bale Extension Sections](./sections.md) are a higher-level UI contract over this namespace rule. A section owns a canonical extension identity such as `@llblab/pi-bale-explorer`, but its Bale `callback_data` should use the `pi-bale` owned `section:` prefix plus a compact token, because Bale limits callback payloads to 64 bytes.

Conceptual form:

```text
section:<token>:<action>[:<payload>]
```

The token maps back to the full section identity inside the section registry. Section authors should not hand-roll `section:` callbacks outside the section context helpers, and ordinary layered extensions should continue using their own namespace plus update handlers or the `[callback]` fallback.
