# genui Templates

Templates are Express files in `templates/`. Render one with:

```json
{
  "conversationId": "<your conversation id>",
  "template": "triage_matrix",
  "surfaceId": "review-triage",
  "mode": "pane",
  "dsl": "$/title = \"### Findings\"\n$/items = [ ... ]"
}
```

The server emits `surface("review-triage", sendDataModel=true)`, the template body, then your `dsl` (so do not put a `surface(...)` line in `dsl`). Later statements win, so:

- `$/key = value` overrides the template default for that key.
- Redefining a variable listed under **Customize** (for example a `ChoicePicker` with different options, or `submit_btn` with another label or event) replaces that component. Button labels are inlined (`Button(Text($/submitLabel), ...)`), so redefining a button leaves nothing orphaned; to change only the label, set its data key instead.
- Inside list items, the template binds fields relatively (`$title`), so your item objects just need the listed keys.

User templates in `${PLUGIN_DATA}/templates/*.a2ui` are discovered too (the registry re-scans when an id is not found) and shadow a built-in of the same id.

| Template id          | Surface        | Shape                                                                                                               | Data keys                                                                                                                                                                           | Action                                              | Customize                                                                               |
| :------------------- | :------------- | :------------------------------------------------------------------------------------------------------------------ | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :-------------------------------------------------- | :-------------------------------------------------------------------------------------- |
| `assumption_ledger`  | inline         | Approve by exception: pre-checked rows with a source badge and an override field                                    | `/title` `/intro` `/assumptions[] {claim, source, holds, override}` `/submitLabel`                                                                                                  | `confirm_assumptions`                               | `submit_btn`                                                                            |
| `contract_workbench` | inline         | Live micro-spec editor: two validated identifiers, a chip picker, a slider, two flags, a reactive preview           | `/title` `/contract {route, eventName, wireFormat, timeoutSec, idempotent, includeDataModel}` `/labels {...}` `/submitLabel`                                                        | `approve_contract`                                  | `preview_text` `wire_format_picker` `timeout_slider` `submit_btn`                       |
| `consequence_cards`  | inline or pane | Architectural fork: one card per option above a single-choice chip row, with notes and explain/defer flags          | `/question` `/options[] {title, impact, tradeoff}` `/choice` `/notes` `/moreInfo` `/defer` `/submitLabel`                                                                           | `submit_alignment`                                  | `choice_picker` (set its options to match `/options`) `submit_btn`                      |
| `triage_matrix`      | pane           | Batch disposition: cards with a severity icon, summary, trace popover, bucket chips, and a note                     | `/title` `/intro` `/items[] {icon, title, summary, trace, bucket, note}` `/submitLabel`                                                                                             | `submit_triage_matrix`                              | `bucket_picker` `submit_btn`                                                            |
| `state_walkthrough`  | pane           | Persistent diagram or formula block above per-transition tabs with a policy picker, slider, and flag                | `/title` `/diagram` `/transitions {t1:{desc,policy,maxRetries,flag}, t2:{desc,policy,maxRetries}, t3:{desc,policy,flag}}` `/labels {slider1, slider2, flag1, flag3}` `/submitLabel` | `submit_state_machine`                              | `transition_tabs` `t1_policy_picker` `t2_policy_picker` `t3_policy_picker` `submit_btn` |
| `wave_sequencer`     | pane           | Dependency DAG and strategy badge above task cards with wave chips, a multi-select verification gate, and a note    | `/title` `/intro` `/dag` `/global {rolloutMode, coverageGate}` `/tasks[] {title, dependsOn, wave, verification, note}` `/submitLabel`                                               | `submit_wave_sequence`                              | `wave_picker` `verification_picker` `rollout_badge` `submit_btn`                        |
| `confirm_gate`       | inline         | One consequential action: Markdown summary, acknowledgement checkbox that unlocks the primary button, cancel button | `/title` `/summary` `/confirmLabel` `/confirmed` `/confirmButtonLabel` `/cancelLabel`                                                                                               | `confirm_gate` (cancel sends `cancel_confirm_gate`) | `confirm_btn` `cancel_btn`                                                              |
| `progress_board`     | pane           | Live status rows (semantic badge, bold label, detail, segmented progress bar) with an acknowledge button            | `/title` `/subtitle` `/items[] {status, tone, label, detail}` `/ackLabel`                                                                                                           | `acknowledge_progress`                              | `ack_btn`                                                                               |
| `metrics_dashboard`  | pane           | KPI summary cards above an interactive `Chart` component (`bar`, `line`, `pie`, `donut`, `scatter`) and note field  | `/title` `/subtitle` `/kpis[] {label, value, delta}` `/chartTitle` `/xAxisLabel` `/yAxisLabel` `/labels[]` `/series[] {name, values}` `/selected` `/note` `/submitLabel`            | `inspect_metric`                                    | `main_chart` (override variant to `line`, `donut`, etc.) `submit_btn`                   |
| `decision_batch`     | inline or pane | Yes/No/Defer decisions: one card per item with prompt, hint, pre-filled chips, a free-text alternative, and a note  | `/title` `/intro` `/items[] {prompt, hint, choice, text, note}` `/submitLabel`                                                                                                      | `submit_decision_batch`                             | `choice_picker` `submit_btn`                                                            |
| `scorecard`          | pane           | Rubric scores: overall progress bar, rows with label, collapsible rationale, score bar, and tone badge, plus notes  | `/title` `/intro` `/overall {score, max}` `/rows[] {label, score, max, tone, rationale}` `/note` `/submitLabel`                                                                     | `submit_scorecard`                                  | `overall_bar` `submit_btn`                                                              |

Notes:

- `icon` values must be basic-catalog icon names (`warning`, `info`, `error`, `check`, `search`, `settings`, ...).
- `bucket`, `choice`, `wave`, `verification`, and `policy` are string arrays even for single selection.
- `ChoicePicker` options and `Tabs` titles are static in A2UI Express, which is why those variables appear under Customize instead of in the data.
- Event names are literal in v0.9; to change one, redefine the button.
- For a single compact chart without KPI cards or a note field, prefer an inline surface (`mode: "inline"`, `root = Card(Chart(..., height=190))`) so it renders directly in chat under the 500px cap; reach for `metrics_dashboard` (`mode: "pane"`) when combining KPI cards, a larger chart, and interactive selection/notes.
- `decision_batch` replaces chat replies of the form "Three things to confirm: 1. ... 2. ... 3. ...". Pre-fill each item's `choice` with the recommended answer and `text` with the proposed name or value, so the user only changes what they disagree with. Use `mode: "inline"` for up to 3 items and `mode: "pane"` for 4 or more.

## Worked example: `triage_matrix`

```text
$/title = "### Review findings for PR 1234"
$/intro = "Pick a bucket for each finding; open Trace for the evidence."
$/items = [{icon: "warning", title: "Race in StoreWriter.append", summary: "Two writers interleave lines.", trace: "`store-writer.ts:84`", bucket: ["p0"], note: ""}]
bucket_picker = ChoicePicker(_, "mutuallyExclusive", [{label: "Fix now", value: "p0"}, {label: "Follow-up", value: "p1"}, {label: "Won't fix", value: "out"}], $bucket, "chips")
```

Then update a single item later without re-rendering:

```text
$/items/0/note = "Fixed in 3eab437"
```
