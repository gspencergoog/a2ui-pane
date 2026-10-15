---
trigger: always_on
description: "Route multi-question alignment, tradeoff comparisons, confirmation gates, item triage, and live progress to the genui skill and A2UI surfaces with a graceful cross-harness fallback."
---

# genui Rule

Read and use the `genui` skill (`render_a2ui`) instead of plain prose or a modal question tool whenever you:

- Ask the user 2 or more questions at once, or verify a batch of inferred assumptions (`assumption_ledger`).
- Compare architectural options with blast-radius consequences (`consequence_cards`) or tune API/schema parameters (`contract_workbench`).
- Gate a consequential action such as a commit, PR action, or branch deletion (`confirm_gate`).
- Present 3 or more items to triage, sequence into waves, walk through state transitions, or track live across phases (`triage_matrix`, `wave_sequencer`, `state_walkthrough`, `progress_board`).

Reserve the host's interactive question tool (`ask_question` in Jetski/Antigravity, `AskUserQuestion` in Claude Code) or a numbered chat prompt for a single self-contained choice whose consequences fit in a one-line label, or as the fallback when `render_a2ui` is unavailable. Always put thought into selecting a recommended option, list it first, and prefix it with `(Recommended)`.
