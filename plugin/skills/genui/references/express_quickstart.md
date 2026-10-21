# A2UI Express Quickstart (for `render_a2ui`)

`a2ui_instructions` returns the full contract. This page is the subset you reach for most.

````text
surface("review", sendDataModel=true)          // createSurface; omit for the default surfaceId
$/title = "### Heading"                        // data assignment (updateDataModel at /)
$/items = [{title: "A", done: true}]           // arrays of maps for list templates
$/series = [{name: "P95", values: [18, 12]}]   // numeric series for Chart
root = Card(main)                              // `root` is required for a new surface
main = Column([header, chart, rows, footer])   // children are variable names
header = Text($/title)                         // Markdown, LaTeX, and ```mermaid render inside Text
chart = Chart("bar", $/series, labels=["v0.9", "v1.0"], selected=$/picked)  // Charts catalog
rows = Column(_template($/items, row))         // one `row` per item
row = Row([CheckBox($title, $done)], _, "center")   // relative bindings inside a template body
field = TextField("Note", $/note, _, _, _, [?required("Required")])   // `_` skips a positional arg
footer = Row([btn], "end", "center")
btn = Button(Text("Save"), "primary", Event("save_review", {items: $/items}))
````

Statement forms:

- `name = Component(args...)` defines a component; `root` is the entry point of a new surface.
- `$/path = value` sets data; a block with only data lines compiles to `updateDataModel`.
- `surface("id", update=true)` targets an existing surface for component changes; `deleteSurface("id")` removes one.
- Strings: `"..."`, triple-quoted `"""..."""` for multi-line Markdown, `r"..."` raw strings for regexes.
- Checks: `?required(msg)`, `?regex(r"^[a-z]+$", msg)`, `?length(min, msg)`, `?and([$/a, $/b], msg)`; on a field they test its value, on a button they gate the action.
- Comments: `// ...` or `# ...`.

Gotchas that still bite:

- `Event` names must be literal strings. Bound `context` values are fine.
- `ChoicePicker` options, `Tabs` titles, `Slider.max`, variants, and `weight` are static: literals only, never `$` bindings.
- `ChoicePicker` values are lists (`["a"]`) even for `mutuallyExclusive`.
- `Button` takes a component child (`Text(...)` or `Icon(...)`), never a bare string.
- `and` needs at least two values; use `?and([$/flag, true], msg)` to gate on one boolean.
- Inside `_template` bodies use `$field`; `$/field` would read the surface root.
- Keep ids out of your head: the compiler derives ids for components from variable names, so reuse the same names when updating.

Links: Markdown links are clickable inside `Text`. `[label](https://...)` opens in the browser; `file://` and `conversation://` links copy the path to the clipboard when clicked. Prefer them to a borderless `Button` with `openUrl` for references, and keep links out of `Button` labels (the button action wins).

```text
ref = Text("Review [PR 3339](https://github.com/a2ui-project/a2ui/pull/3339) and the [notes](file:///tmp/review-notes.md).")
```

Table: Status catalog component for tabular data with 3 or more columns or typed cells (`badge`, `progress`, `link`, `check`, `icon`). Column definitions are static.

```text
$/rows = [{feature: "Router", status: {text: "stable", tone: "success"}, coverage: {value: 95, max: 100}}]
tbl = Table([{key: "feature", label: "Feature"}, {key: "status", label: "Status", kind: "badge"}, {key: "coverage", label: "Coverage", kind: "progress"}], $/rows, dense=true)
```

Stepper: Status catalog component for ordered milestone lifecycles. Completed steps render with success tone; current step renders with active pulse or the given tone; future steps render neutral.

```text
$/steps = [{label: "Plan"}, {label: "Review"}, {label: "CI"}, {label: "Merge"}]
step_bar = Stepper($/steps, $/current_step, "active")
```

Compact inline chart (`mode: "inline"`, fits well under the 500px inline height cap):

```text
$/series = [{name: "Score", values: [28, 22, 19, 16, 12]}]
$/labels = ["parseExpr", "compileDsl", "validate", "renderSvg", "inflate"]
root = Card(Chart("horizontal-bar", $/series, $/labels, "Top Functions by Cognitive Complexity", "Score", _, 190))
```
