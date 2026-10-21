---
trigger: always_on
description: 'Route multi-question alignment, tradeoff comparisons, confirmation gates, item triage, live progress, rubrics, PR stacks, status grids, and high-signal quantitative charts to the genui skill and A2UI surfaces with a graceful cross-harness fallback.'
---

# genui Rule

Read and use the `genui` skill (`render_a2ui`) instead of plain prose or a modal question tool whenever you:

- Ask the user 2 or more questions at once, list 2 or more numbered questions to confirm (`decision_batch`), or verify a batch of inferred assumptions (`assumption_ledger`).
- Compare architectural options with blast-radius consequences (`consequence_cards`), compare 3 or more options on 3 or more criteria (`comparison_matrix`), or tune API or schema parameters (`contract_workbench`).
- Gate a consequential action such as a PR action or branch deletion (`confirm_gate`).
- Present 3 or more items to triage, sequence into waves, walk through state transitions, or track live across phases (`triage_matrix`, `wave_sequencer`, `state_walkthrough`, `progress_board`).
- Present a table of PRs or CLs with states and CI status (`stack_board`).
- Present an evaluation rubric with 3 or more scored rows (`scorecard`).
- Present a test suite by platform or feature by SDK grid (`status_matrix`).
- Visualize quantitative series, distributions, or benchmarks with 4 or more data points (or 2 or more series across 3 or more categories) sharing a single unit axis (`Chart` in `mode: "inline"` when compact under 500px, or `metrics_dashboard` in `mode: "pane"` for larger or multi-part displays). Keep 1 to 3 scalar numbers, mixed-unit summaries, string lookup tables, and brief factual lookups or status checks in plain Markdown.

Use the host's interactive question tool (`ask_question` in Antigravity, `AskUserQuestion` in Claude Code) or a numbered chat prompt for a single self-contained choice. Also use it as the fallback when `render_a2ui` is unavailable. Always select a recommended option, list it first, and prefix it with `(Recommended)`.
