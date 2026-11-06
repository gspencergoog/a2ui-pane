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

| Template id          | Surface        | Shape                                                                                                                                                                                                                                                                      | Data keys                                                                                                                                                                                             | Action                                              | Customize                                                                                                                                                                               |
| :------------------- | :------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :-------------------------------------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `assumption_ledger`  | inline         | Approve by exception: pre-checked rows with a source badge and an override field                                                                                                                                                                                           | `/title` `/intro` `/assumptions[] {claim, source, holds, override}` `/submitLabel`                                                                                                                    | `confirm_assumptions`                               | `submit_btn`                                                                                                                                                                            |
| `contract_workbench` | inline         | Live micro-spec editor: two validated identifiers, a chip picker, a slider, two flags, a reactive preview                                                                                                                                                                  | `/title` `/contract {route, eventName, wireFormat, timeoutSec, idempotent, includeDataModel}` `/labels {...}` `/submitLabel`                                                                          | `approve_contract`                                  | `preview_text` `wire_format_picker` `timeout_slider` `submit_btn`                                                                                                                       |
| `consequence_cards`  | inline or pane | Architectural fork: stacked full-width option cards (title, optional badge, Markdown impact bullets, tradeoff) above an optional blast-radius collapsible, multi-select chips (combine freely or defer), and notes                                                         | `/question` `/options[] {title, badge, tone, impact, tradeoff}` `/traceTitle` `/traceSummary` `/trace` `/choice` `/notes` `/submitLabel`                                                              | `submit_alignment`                                  | `choice_picker` (set its options to match `/options`) `submit_btn`                                                                                                                      |
| `triage_matrix`      | pane           | Batch disposition: cards with a severity icon, summary, trace popover, bucket chips, and a note                                                                                                                                                                            | `/title` `/intro` `/items[] {icon, title, summary, trace, bucket, note}` `/submitLabel`                                                                                                               | `submit_triage_matrix`                              | `bucket_picker` `submit_btn`                                                                                                                                                            |
| `state_walkthrough`  | pane           | Persistent diagram or formula block above per-transition tabs with a policy picker, slider, and flag                                                                                                                                                                       | `/title` `/diagram` `/transitions {t1:{desc,policy,maxRetries,flag}, t2:{desc,policy,maxRetries}, t3:{desc,policy,flag}}` `/labels {slider1, slider2, flag1, flag3}` `/submitLabel`                   | `submit_state_machine`                              | `transition_tabs` `t1_policy_picker` `t2_policy_picker` `t3_policy_picker` `submit_btn`                                                                                                 |
| `wave_sequencer`     | pane           | Dependency DAG and strategy badge above task cards with wave chips, a multi-select verification gate, and a note                                                                                                                                                           | `/title` `/intro` `/dag` `/global {rolloutMode, coverageGate}` `/tasks[] {title, dependsOn, wave, verification, note}` `/submitLabel`                                                                 | `submit_wave_sequence`                              | `wave_picker` `verification_picker` `rollout_badge` `submit_btn`                                                                                                                        |
| `confirm_gate`       | inline         | One consequential action: Markdown summary, acknowledgement checkbox that unlocks the primary button, cancel button                                                                                                                                                        | `/title` `/summary` `/confirmLabel` `/confirmed` `/confirmButtonLabel` `/cancelLabel`                                                                                                                 | `confirm_gate` (cancel sends `cancel_confirm_gate`) | `confirm_btn` `cancel_btn`                                                                                                                                                              |
| `progress_board`     | pane           | Live status rows (semantic badge, bold label, detail, segmented progress bar) with an acknowledge button                                                                                                                                                                   | `/title` `/subtitle` `/items[] {status, tone, label, detail}` `/ackLabel`                                                                                                                             | `acknowledge_progress`                              | `ack_btn`                                                                                                                                                                               |
| `metrics_dashboard`  | pane           | KPI summary cards above an interactive `Chart` component (`bar`, `line`, `pie`, `donut`, `scatter`) and note field                                                                                                                                                         | `/title` `/subtitle` `/kpis[] {label, value, delta}` `/chartTitle` `/xAxisLabel` `/yAxisLabel` `/labels[]` `/series[] {name, values}` `/selected` `/note` `/submitLabel`                              | `inspect_metric`                                    | `main_chart` (override variant to `line`, `donut`, etc.) `submit_btn`                                                                                                                   |
| `decision_batch`     | inline or pane | Batch of short decisions: one card per item with prompt, optional hint, and horizontal `ChoiceCards` driven by per-item `options`, plus one shared notes field at the bottom                                                                                               | `/title` `/intro` `/items[] {prompt, hint, options, choice}` `/note` `/submitLabel`                                                                                                                   | `submit_decision_batch`                             | `choice_cards` `submit_btn`                                                                                                                                                             |
| `scorecard`          | pane           | Rubric scores: overall progress bar, rows with label, collapsible rationale, score bar, and tone badge, plus notes                                                                                                                                                         | `/title` `/intro` `/overall {score, max}` `/rows[] {label, score, max, tone, rationale}` `/note` `/submitLabel`                                                                                       | `submit_scorecard`                                  | `overall_bar` `submit_btn`                                                                                                                                                              |
| `stack_board`        | pane           | PR or CL stack: title and optional status badge, Markdown subtitle, auto-legend progress bar, rows with state, CI, and review badges, a title link, Markdown detail bullets, and a 5-step lifecycle Stepper                                                                | `/title` `/subtitle` `/status` `/statusTone` `/statusPulse` `/steps[] {label, detail}` `/items[] {id, title, url, wave, base, state, tone, ci, ciTone, review, reviewTone, detail, step}` `/ackLabel` | `acknowledge_stack_board`                           | `ack_btn`                                                                                                                                                                               |
| `comparison_matrix`  | pane           | Criteria by options tradeoff: `Table` with one row per criterion and a badge cell per option, multi-select option chips (pick one or combine), and notes; prefer over `consequence_cards` for 3 or more options or 4 or more criteria; keep cell text to two to four words | `/title` `/question` `/rows[] {criterion, o1, o2, o3}` (cells are `{text, tone}`) `/choice` `/notes` `/submitLabel`                                                                                   | `submit_comparison`                                 | `matrix_table` and `choice_picker` (redefine both together: column labels are the option titles, chip values are `o1`..`o3`; keep `width: "14ch"` on the criterion column) `submit_btn` |
| `status_matrix`      | pane           | Parity grid: tone-badge legend above a dense `Table` (label column, four badge columns); columns are static                                                                                                                                                                | `/title` `/intro` `/legend[] {text, tone}` `/rows[] {label, c1, c2, c3, c4}` (cells are `{text, tone}`) `/ackLabel`                                                                                   | `acknowledge_status_matrix`                         | `matrix_table` (redefine for other columns) `legend_badge` `ack_btn`                                                                                                                    |
| `plan_overview`      | pane           | Implementation plan overview: title, status badge, optional subtitle, stacked At a glance subheadings over prose, an Execution waves Markdown diagram (usually a Mermaid flowchart), Planned changes rows, and a footer with open-question count and action button         | `/title` `/subtitle` `/status` `/statusTone` `/glance[] {label, value}` `/waveDiagram` `/prsHeading` `/prs[] {id, title, repo, wave}` `/openQuestions` `/ackLabel`                                    | `acknowledge_plan_overview`                         | `waves_heading` `ack_btn`                                                                                                                                                               |

Notes:

- `icon` values must be basic-catalog icon names (`warning`, `info`, `error`, `check`, `search`, `settings`, ...).
- `bucket`, `choice`, `wave`, `verification`, and `policy` are string arrays even for single selection.
- Table columns, ChoicePicker options, and Tabs titles are static in A2UI Express. They cannot bind to dynamic data and appear under Customize instead. For comparison_matrix and status_matrix, redefine Table columns and ChoicePicker options together so columns and chips match.
- Event names are literal in v0.9; to change one, redefine the button.
- For a single compact chart without KPI cards or a note field, prefer an inline surface (`mode: "inline"`, `root = Card(Chart(..., height=190))`) so it renders directly in chat under the 500px cap; reach for `metrics_dashboard` (`mode: "pane"`) when combining KPI cards, a larger chart, and interactive selection/notes.
- `decision_batch` replaces chat replies of the form "Three things to confirm: 1. ... 2. ... 3. ...". Each item carries its own `options` list (`[{value, label, description?, badge?, tone?, quiet?}]`) rendered via horizontal `ChoiceCards`. For simple confirmations, pass `[{value: "yes", label: "Yes"}, {value: "no", label: "No"}, {value: "defer", label: "Defer", quiet: true}]`; for named alternatives, put the real option labels, optional descriptions, and a `"Recommended"` badge in `options`. Pre-fill each item's `choice` with the recommended answer, and capture caveats in the single shared `/note` field. Use `mode: "inline"` for up to 3 items and `mode: "pane"` for 4 or more. Never encode named alternatives as `"Yes = Option A; No = Option B"` inside `hint`.

## Composable Express Question Blocks (Multi-Question `/grill-me` Worksheets)

For uniform batches of short decisions, pass per-item `options` to `decision_batch`. When a `/grill-me` or `/plan` turn mixes question tiers, header badges, collapsible traces, or a footer checkbox, pass `dsl` without `template`. Snap together these three question-block tiers above a shared footer:

```text
surface("design-alignment", sendDataModel=true)

// Data model (pre-populate recommended choices)
$/q1 = {choice: ["out"]}
$/q2 = {
  options: [
    {value: "normalize", label: "A · Normalize $/ and /", description: "Normalizes `$/foo` and `/foo` in `ExpressCompiler` and keeps existing `.a2ui` templates valid.", badge: "Recommended", tone: "success"},
    {value: "strict", label: "B · Strict RFC 6901 only", description: "Rejects `$/` prefixes and requires callers to update existing templates."},
    {value: "defer", label: "Defer", quiet: true}
  ],
  trace: "- `packages/mcp-server/python/express_worker.py`\n- `packages/renderer/src/processor.ts`",
  choice: ["normalize"]
}
$/q3 = {
  options: [
    {title: "**A: Dual-Write (Recommended)**", badge: "Zero downtime", tone: "success", impact: "Writes to both tables during rollout.", tradeoff: "Tradeoff: 2ms shadow-diff overhead."},
    {title: "**B: In-Place Cutover**", badge: "15m freeze", tone: "warning", impact: "Swaps table in one migration.", tradeoff: "Tradeoff: 15-minute write freeze."}
  ],
  choice: ["dual_write"]
}
$/review = true
$/notes = ""

// Tier 1: Simple Choice (prompt + optional 1-line hint + named chips; no per-item text fields)
q1_head = Row([Text("**1. Include legacy v0.8 fallback in this PR?**", "body", 1), Badge("Scope", "neutral")], "spaceBetween", "center")
q1_picker = ChoicePicker(_, "mutuallyExclusive", [{label: "(Recommended) Out of scope", value: "out"}, {label: "Add 1 smoke test", value: "smoke"}, {label: "Defer", value: "defer"}], $/q1/choice, "chips")
q1_block = Column([q1_head, q1_picker])

// Tier 2: Consequence-Aware Decision (header row with Q<n> badge + ChoiceCards with per-option descriptions, Recommended badge, and quiet Defer + collapsible file trace)
q2_head = Row([Text("**Q2: Path binding syntax in data assignments**", "body", 1), Badge("Q2", "warning")], "spaceBetween", "center")
q2_cards = ChoiceCards($/q2/options, $/q2/choice)
q2_trace = Collapsible("Affected files & blast radius", Text($/q2/trace, "caption"), "2 files")
q2_block = Column([q2_head, q2_cards, q2_trace])

// Tier 3: Complex Architectural Fork (stacked full-width option cards or Criteria Table + multi-select chips)
q3_head = Row([Text("**3. Cutover strategy for `orders_v2`**", "body", 1), Badge("Architecture", "active")], "spaceBetween", "center")
q3_cards = Column(_template($/q3/options, q3_card), _, "stretch")
q3_card = Card(Column([Row([Text($title, "body", 1), Badge($badge, $tone)], "spaceBetween", "center"), Text($impact), Text($tradeoff, "caption")]))
q3_picker = ChoicePicker(_, "multipleSelection", [{label: "(Recommended) A: Dual-Write", value: "dual_write"}, {label: "B: In-Place Cutover", value: "cutover"}, {label: "Defer", value: "defer"}], $/q3/choice, "chips")
q3_block = Column([q3_head, q3_cards, q3_picker])

// Shared Footer (single overall note field + optional process checkbox + one primary submit button)
shared_note = TextField("Overall notes or overrides", $/notes)
review_check = CheckBox("Run an independent review of this plan (recommended)", $/review)
submit_btn = Button(Text("Submit Decisions"), "primary", Event("submit_alignment", {q1: $/q1/choice, q2: $/q2/choice, q3: $/q3/choice, review: $/review, notes: $/notes}))
footer = Row([review_check, submit_btn], "spaceBetween", "center")

root = Card(Column([Text("### Alignment Questions"), Text("Recommended answers are preselected.", "caption"), q1_block, Divider(), q2_block, Divider(), q3_block, Divider(), shared_note, footer]))
```

## Improvising Custom A2UI Express Surfaces

Templates and custom A2UI Express (`dsl` without `template`) are co-equal tools. Whenever a problem decomposes into orthogonal axes, benefits from live UI previews, tunes numeric thresholds, or steps through >4 deep architectural forks, call `a2ui_instructions` once per session and author an Express surface tailored to the decision.

### 1. Orthogonal Axis Mixer (Independent Dimensions)

When a design has independent axes (such as storage engine, transport protocol, and sync trigger), do not force bundled `"Option A / B / C"` cross-products. Give each axis its own `ChoicePicker`:

```text
surface("axis-mixer", sendDataModel=true)

$/storage = ["sqlite_wal"]
$/transport = ["sse"]
$/features = ["etag_cache", "offline_replay"]
$/notes = ""

storage_pick = ChoicePicker("1. Local persistence", "mutuallyExclusive", [{label: "(Recommended) SQLite WAL", value: "sqlite_wal"}, {label: "JSONL append log", value: "jsonl"}, {label: "In-memory only", value: "memory"}], $/storage, "chips")
transport_pick = ChoicePicker("2. Live update transport", "mutuallyExclusive", [{label: "(Recommended) Server-Sent Events", value: "sse"}, {label: "WebSocket", value: "ws"}, {label: "Long polling", value: "poll"}], $/transport, "chips")
feature_pick = ChoicePicker("3. Optional capabilities (combine freely)", "multipleSelection", [{label: "(Recommended) ETag caching", value: "etag_cache"}, {label: "(Recommended) Offline replay", value: "offline_replay"}, {label: "Cross-tab broadcast", value: "broadcast"}], $/features, "chips")
notes_field = TextField("Constraints or hybrid notes", $/notes)
submit_btn = Button(Text("Confirm Architecture"), "primary", Event("submit_axes", {storage: $/storage, transport: $/transport, features: $/features, notes: $/notes}))

root = Card(Column([Text("### Compose Target Architecture"), storage_pick, Divider(), transport_pick, Divider(), feature_pick, Divider(), notes_field, Row([submit_btn], "end", "center")]))
```

### 2. Live Component / Layout Preview (`Tabs`)

When brainstorming UI or UX layouts, render live interactive mockups inside `Tabs` above a picker so the user compares real rendered layouts rather than prose descriptions:

```text
surface("layout-preview", sendDataModel=true)

$/picked = ["table"]
$/notes = ""
$/previewRows = [{metric: "P50 latency", v1: {text: "14ms", tone: "success"}, v2: {text: "9ms", tone: "success"}}]

tab_a = Column([Text("Compact single-card summary with inline badges:"), Row([Badge("Healthy", "success"), Badge("3 active", "info")])])
tab_b = Column([Text("Structured table view for dense multi-column scanning:"), Table([{key: "metric", label: "Metric", width: "14ch"}, {key: "v1", label: "Current", kind: "badge"}, {key: "v2", label: "Proposed", kind: "badge"}], $/previewRows, dense=true)])
preview_tabs = Tabs([{title: "Layout A: Compact Badges", child: tab_a}, {title: "Layout B: Dense Table", child: tab_b}])

layout_pick = ChoicePicker("Preferred layout (or combine)", "multipleSelection", [{label: "(Recommended) Layout B: Dense Table", value: "table"}, {label: "Layout A: Compact Badges", value: "badges"}], $/picked, "chips")
notes_field = TextField("Visual tweaks or hybrid ideas", $/notes)
submit_btn = Button(Text("Select Layout"), "primary", Event("select_layout", {picked: $/picked, notes: $/notes}))

root = Card(Column([Text("### Compare Candidate UI Layouts"), preview_tabs, Divider(), layout_pick, notes_field, Row([submit_btn], "end", "center")]))
```

### 3. Interactive Threshold & Budget Tuner (`Slider` + `formatString`)

When tuning numeric budgets, timeouts, concurrency caps, or feature flags, pair `Slider` (note v1.0's 7-slot order: `Slider(label?, min?, max, value, steps?, weight?, checks?)`) and `CheckBox` with a reactive `formatString` summary:

```text
surface("budget-tuner", sendDataModel=true)

$/budget = {maxLines: 200, maxQuestions: 4, strictReadOnly: true}
$/notes = ""

live_summary = Text(formatString("**Live spec:** Phase 2 cap = `${/budget/maxLines}` lines | Max forks per batch = `${/budget/maxQuestions}`"))
lines_slider = Slider("Phase 2 line target", 100, 400, $/budget/maxLines, 6, 1)
questions_slider = Slider("Max forks before Stepper deck", 2, 8, $/budget/maxQuestions, 6, 1)
readonly_flag = CheckBox("Enforce zero workspace and external mutations", $/budget/strictReadOnly)
notes_field = TextField("Overrides or edge cases", $/notes)
submit_btn = Button(Text("Lock Budgets"), "primary", Event("submit_budgets", {budget: $/budget, notes: $/notes}))

root = Card(Column([Text("### Tune Workflow Thresholds"), live_summary, Divider(), Row([lines_slider, questions_slider]), readonly_flag, notes_field, Row([submit_btn], "end", "center")]))
```

### 4. 1-by-1 `Stepper` Decision Deck (For >4 Deep Forks)

When a design has more than 4 heavy architectural forks, avoid stacking a giant wall of cards in one turn. Render a `Stepper` header above one focused fork in `mode: "pane"` (`replace: true`), advancing `$/currentStep` on each turn as answers arrive:

```text
surface("decision-deck", sendDataModel=true)

$/steps = [{label: "1. Storage"}, {label: "2. Sync"}, {label: "3. Auth"}, {label: "4. Rollout"}, {label: "5. Telemetry"}]
$/currentStep = 0
$/options = [
  {title: "**(Recommended) A: SQLite WAL**", badge: "Local-first", tone: "success", impact: "- Millisecond local reads.\n- Single-file backup.", tradeoff: "Tradeoff: single-writer lock per host."},
  {title: "**B: Remote Postgres**", badge: "Multi-host", tone: "info", impact: "- Shared across machines.", tradeoff: "Tradeoff: requires network + auth setup."}
]
$/choice = ["sqlite"]
$/notes = ""

deck_stepper = Stepper($/steps, $/currentStep, "active")
fork_cards = Column(_template($/options, fork_card), _, "stretch")
fork_card = Card(Column([Row([Text($title, "body", 1), Badge($badge, $tone)], "spaceBetween", "center"), Text($impact), Text($tradeoff, "caption")]))
fork_picker = ChoicePicker("Step 1 of 5: Choose storage engine (combine freely)", "multipleSelection", [{label: "(Recommended) A: SQLite WAL", value: "sqlite"}, {label: "B: Remote Postgres", value: "postgres"}, {label: "Defer", value: "defer"}], $/choice, "chips")
notes_field = TextField("Notes before advancing to Step 2 (Sync)", $/notes)
next_btn = Button(Text("Save & Next Decision"), "primary", Event("submit_deck_step", {step: 0, choice: $/choice, notes: $/notes}))

root = Card(Column([Text("### Architecture Decision Deck"), deck_stepper, Divider(), fork_cards, fork_picker, notes_field, Row([next_btn], "end", "center")]))
```

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

## Worked example: `stack_board`

Render the stack once; the title in each row is a Markdown link, `detail` renders inline as a Markdown bullet list, and each row ends with a 5-step lifecycle Stepper driven by `step`. Items with the same `wave` read as a group, and every tone is supplied by you (`success`, `active`, `warning`, `danger`, `neutral`).

```text
$/title = "### Ship-it stack: StoreWriter rewrite"
$/subtitle = "Three changes in two waves."
$/items = [{id: "PR 3339", title: "feat(store): add StoreWriter", url: "https://github.com/a2ui-project/a2ui/pull/3339", wave: "1", base: "main", state: "Open", tone: "active", ci: "CI running", ciTone: "active", review: "Approved", reviewTone: "success", detail: "- Waiting on the integration suite.", step: 1}, {id: "PR 3340", title: "refactor(store): extract flush scheduling", url: "https://github.com/a2ui-project/a2ui/pull/3340", wave: "2", base: "PR 3339", state: "Draft", tone: "neutral", ci: "CI pending", ciTone: "warning", review: "Unreviewed", reviewTone: "neutral", detail: "- Rebase after PR 3339 merges.", step: 0}, {id: "PR 3341", title: "feat(store): roll StoreWriter downstream", url: "https://github.com/a2ui-project/a2ui/pull/3341", wave: "2", base: "PR 3340", state: "Pending", tone: "warning", ci: "CI passed", ciTone: "success", review: "Approved", reviewTone: "success", detail: "- Downstream integration branch ready.", step: 3}]
```

When PR 3339 merges, send only the fields that changed. Each line updates one row; the progress bar retallies from the new tones and nothing else re-renders:

```text
$/items/0/state = "Merged"
$/items/0/tone = "success"
$/items/0/ci = "CI passed"
$/items/0/ciTone = "success"
$/items/0/step = 4
$/items/0/detail = "- Merged as 3eab437."
```

## Worked example: `status_matrix`

Table columns are static in A2UI Express, so the template ships with `Suite | Python | TypeScript | Dart | Swift`. Rows carry the cells under the keys `label` and `c1` to `c4`, and each cell is `{text, tone}` with a tone from the legend.

```text
$/title = "### Conformance by SDK"
$/legend = [{text: "pass", tone: "success"}, {text: "partial", tone: "warning"}, {text: "fail", tone: "danger"}, {text: "n/a", tone: "neutral"}]
$/rows = [{label: "Data binding", c1: {text: "pass", tone: "success"}, c2: {text: "pass", tone: "success"}, c3: {text: "partial", tone: "warning"}, c4: {text: "n/a", tone: "neutral"}}]
```

For a different set of columns, redefine `matrix_table` with your own column keys and labels; the first column is a plain text label and the rest are `kind: "badge"`:

```text
matrix_table = Table([{key: "label", label: "Feature"}, {key: "c1", label: "Web", kind: "badge"}, {key: "c2", label: "Android", kind: "badge"}, {key: "c3", label: "iOS", kind: "badge"}], $/rows, dense=true)
```

Flip one cell later with a data-only update:

```text
$/rows/0/c3 = {text: "pass", tone: "success"}
```

## Worked example: `plan_overview`

Use `plan_overview` after presenting a multi-wave implementation plan to show the plan's structure as a wave diagram, planned commits or PRs, and remaining open questions in the side pane.

````text
$/title = "## Improve /plan: readable briefs and post-plan UI"
$/subtitle = "3 waves · 4 parallel tracks · 2 changes · 0 open questions"
$/status = "Ready"
$/statusTone = "success"
$/glance = [{label: "Goal", value: "Make plans faster to absorb, and move post-plan decisions, review findings, progress, and landing into UI."}, {label: "Shape", value: "3 waves. Wave 2 has 4 parallel tracks."}]
$/waveDiagram = "```mermaid\nflowchart TD\n    W1[\"Wave 1 · plan_model.py + overview data contract (PR 1)\"]\n    subgraph W2[\"Wave 2 · Checks, surfaces, templates, and overview (Verifier · PR 2)\"]\n        W2T0[\"2A · validator checks\"]\n        W2T1[\"2B · plan_surfaces.py\"]\n        W2T2[\"2C · plan templates and references\"]\n        W2T3[\"2D · a2ui-pane plan_overview template\"]\n    end\n    W3[\"Wave 3 · SKILL.md, lint, tests, promote, commit\"]\n    W1 --> W2\n    W2 --> W3\n```"
$/prsHeading = "### Planned changes"
$/prs = [{id: "1", title: "feat(plan): parse plan briefs, questions, PR tables, and tracks", repo: "cheats", wave: "Wave 1"}, {id: "2", title: "feat(templates): add plan_overview template", repo: "a2ui-pane · 2D", wave: "Wave 2"}]
$/openQuestions = 0
$/ackLabel = "Proceed"
````
