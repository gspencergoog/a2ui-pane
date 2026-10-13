# A2UI Express Quickstart (for `render_a2ui`)

`a2ui_instructions` returns the full contract. This page is the subset you reach for most.

````text
surface("review", sendDataModel=true)          // createSurface; omit for the default surfaceId
$/title = "### Heading"                        // data assignment (updateDataModel at /)
$/items = [{title: "A", done: true}]           // arrays of maps for list templates
root = Card(main)                              // `root` is required for a new surface
main = Column([header, rows, footer])          // children are variable names
header = Text($/title)                         // Markdown, LaTeX, and ```mermaid render inside Text
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
- Keep ids out of your head: the compiler derives component ids from variable names, so reuse the same names when updating.
