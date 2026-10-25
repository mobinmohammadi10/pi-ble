> Bale port: only the supported subset in [Bale compatibility](../../docs/bale-compatibility.md) is enabled. Inherited Thread, reaction, Guest, Rich block and draft contracts are not Bale capabilities.

# Bale Explanation Surfaces

Use this reference only when Show Me is responding through Bale or preparing an artifact for Bale delivery.

## Selection

- With plain `show me`, prefer a native Markdown reply when one phone-width view can explain the point.
- Use HTML when spatial comparison, dense state, a timeline, or a visual hierarchy would become harder to understand in narrow Markdown.
- `Show me markdown` means rendered Markdown in the current reply, not a `.md` attachment, unless the user explicitly asks for a file.
- `Show me html` means one focused, self-contained `.html` artifact delivered through the active Bale file path. The surrounding reply should say what the artifact explains and disclose its evidence state.
- Do not create both formats by habit. The second format must answer a need the first cannot.

## Bale Markdown

- Design for a phone before a desktop: one governing question, one primary visual, short labels, shallow nesting, and prose that wraps naturally.
- Prefer compact semantic diffs, call trees, timelines, or state transitions over raw repository diffs. A remote user needs to understand impact before file-level detail.
- Avoid wide tables, deep trees, side-by-side layouts, and Mermaid when the current Bale renderer would expose only source text. Move genuinely spatial material to HTML.
- Put material state near the top: what changed, whether it is local or live, what was validated, and what remains unresolved.
- Keep source paths and symbol names below the explanation unless they are the explanation.
- Keep intended Bale bot-command tokens as plain text rather than inline code. Format Pi/TUI or shell commands as code according to the host contract. Plain source shape does not prove native clickability; claim it only after the active entity-detection and client path is verified.
- Use explicit Markdown links when a destination matters rather than assuming plain URL auto-detection.

## Bale HTML

- Produce a single self-contained file with UTF-8 metadata and a viewport declaration. Avoid external assets, scripts, fonts, trackers, or network requirements unless the user explicitly requested them.
- Build mobile-first for roughly phone-width reading, then let the same document expand cleanly in a system or desktop browser. Text must wrap; diagrams must scroll or reflow without clipping.
- Use semantic headings, sufficient contrast, non-color status meaning, comfortable touch targets, and no hover-only information.
- Preserve real labels, values, ordering, and uncertainty. An attractive reconstruction must not invent runtime state or imply that a proposed interaction exists.
- Include a compact provenance line when state matters, such as `Local patch - validated - not released - not live`.
- When rendering tools are available, inspect at least one narrow viewport and one wider viewport. Report what was inspected; static source review is not visual proof.
- Deliver the file through the active Bale attachment mechanism. Do not expose local paths as if the user could open them remotely.

## Current-Work Evidence

Before explaining “what we did” or “what happened,” use the narrowest available evidence that can support the answer:

1. Inspect retained repository status and diff for the relevant task.
2. Identify pre-existing or unrelated changes and exclude them from the claimed task result.
3. Name the actual changed mechanism or contract, not a friendlier neighboring concept.
4. Separate implementation evidence from validation, release, deployment, runtime, transport, and client evidence.
5. State unresolved causes or missing live checks instead of filling them with a cleaner story.

A visual is successful when the user can understand the outcome away from a computer without being given a stronger claim than the evidence supports.
