# genui Rule

When you are about to ask the user more than one question, collect a decision with consequences, or show structure that prose hides (a list to triage, a dependency graph, a state machine, live progress), consider rendering a surface with the `genui` skill before falling back to prose or `ask_question`. Read the `genui` skill first; it chooses the channel, points to templates, and documents the `a2ui_instructions` and `render_a2ui` calls. If those tools are not available, use `ask_question` and Markdown instead.
