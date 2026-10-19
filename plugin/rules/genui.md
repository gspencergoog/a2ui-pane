---
trigger: always_on
description: 'Route multi-question alignment, tradeoff comparisons, confirmation gates, item triage, live progress, and high-signal quantitative charts to the genui skill and A2UI surfaces with a graceful cross-harness fallback.'
---

# genui Rule

Read and use the `genui` skill (`render_a2ui`) instead of plain prose or a modal question tool whenever you:

- Ask the user 2 or more questions at once, or verify a batch of inferred assumptions (`assumption_ledger`).
- Compare architectural options with blast-radius consequences (`consequence_cards`) or tune API/schema parameters (`contract_workbench`).
- Gate a consequential action such as a commit, PR action, or branch deletion (`confirm_gate`).
- Present 3 or more items to triage, sequence into waves, walk through state transitions, or track live across phases (`triage_matrix`, `wave_sequencer`, `state_walkthrough`, `progress_board`).
- Visualize quantitative series, distributions, or benchmarks with 4 or more data points (or 2+ series across 3+ categories) sharing a single unit axis (`Chart` in `mode: "inline"` when compact under 500px, or `metrics_dashboard` in `mode: "pane"` for larger or multi-part displays). Keep 1 to 3 scalar numbers, mixed-unit summaries, string lookup tables, and brief factual lookups or status checks in plain Markdown.

Use the host's interactive question tool (`ask_question` in Antigravity, `AskUserQuestion` in Claude Code) or a numbered chat prompt for a single self-contained choice. Also use it as the fallback when `render_a2ui` is unavailable. Always select a recommended option, list it first, and prefix it with `(Recommended)`.
