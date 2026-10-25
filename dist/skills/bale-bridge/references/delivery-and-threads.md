> Bale port: only the supported subset in [Bale compatibility](../../docs/bale-compatibility.md) is enabled. Inherited Thread, reaction, Guest, Rich block and draft contracts are not Bale capabilities.

# Direct Delivery And Threads

Read this reference only for explicit local/TUI Bale delivery, cross-target delivery, or Thread routing.

## Direct Delivery

Use `bale_message` only when the user explicitly requests Bale delivery from local/TUI or names a concrete different Bale target.

- Omitted target selects the paired/default target only outside an active Bale turn.
- `chat_id` plus optional `thread_id` selects an explicit Bot API target. A public `@username`, or an exact negative numeric channel ID with `channel: true`, uses `chat_id` without `thread_id`; channel delivery requires the direct leader, and Bale enforces the bot's posting permission.
- `thread` selects another live Pi Thread by case-insensitive name or numeric id and admits one attributed turn there.
- During an active Bale turn, answer the current target normally; direct delivery to that same target is rejected.
- Direct delivery requires this Pi instance to own transport or hold a live Threaded Mode registration.
- Unknown, ambiguous, same, offline, unauthorized, or cross-chat targets fail closed.

Use `bale_attach` outside Bale turns only for an explicit file-delivery request. Registered followers default to their assigned Thread; explicit targets must preserve both `chat_id` and `thread_id`.

## Threaded Mode

Threaded Mode uses one leader transport and visible operator-started follower Pi processes.

- `Thread` is the product term; reserve `topic` for Bot API primitives.
- A Thread follows its assigned live Pi instance and current session.
- The `All` surface controls routing; it does not create processes.
- Never invent hidden followers, launch shadow Pi processes, expose internal bus roles as user identity, or rename Threads through guessed prompts or unsupported tools.

Cross-Thread delivery must preserve the concrete target and current registration authority. Keep the source turn on its ordinary reply path and use `bale_message(thread=...)` only for an explicitly requested different live Thread.
