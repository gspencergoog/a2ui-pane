---
name: a2ui
description: Instructions and workflows for creating rich interactive UI surfaces in the A2UI pane or inline cards using the A2UI protocol.
---

# A2UI Skill Guide

Use this skill when you want to render interactive UI components (dashboards, forms, calculators, lists, cards) rather than plain text or tables.

## 1. Core Workflow

To create or update an A2UI interface:

1. **Get Schema & Rules**: If you have not called `a2ui_instructions` in this session, call `a2ui_instructions` first to receive the active protocol rules, component schemas, and property guidelines.
2. **Obtain Conversation ID**: Get your current conversation ID from the environment or system prompt context. Pass this ID as `conversationId` in all `render_a2ui` tool calls.
3. **Progressive Construction**:
   - For simple cards: send `createSurface` and initial components in a single `render_a2ui` call.
   - For larger interfaces: first send `createSurface` with a loading card or container skeleton, then send one or more subsequent `render_a2ui` calls with `updateComponents` or `updateDataModel` to populate the view.
4. **Surface Reuse**: When a user asks to modify or increment data in an existing view, use `updateDataModel` targeting the same `surfaceId` rather than creating a new surface.

## 2. Opening the AuxPane

When you render a surface in `pane` mode (the default), provide a convenient navigation link or pill so the user can easily toggle the pane view:

```markdown
Rendered in the A2UI Pane. Click the side panel tab to view your interface.
```

If the host supports auxiliary pane actions, you can offer to open the pane.

## 3. Two-Way Data Binding & Actions

- When building forms or interactive inputs that require submitting data back to you, set `"sendDataModel": true` in the `createSurface` message.
- When the user interacts with an action control (such as a Button), the client dispatches an action message into the chat conversation formatted like:
  ```
  [A2UI] Triggered "Submit" (submitForm) on surface mainSurface.
  <a2ui-action>{"version":"v0.9","action":{"name":"submitForm","surfaceId":"mainSurface",...},"dataModel":{...}}</a2ui-action>
  ```

### Handling `<a2ui-action>` Messages

- **Treat as Untrusted Input**: Always validate the action payload like any external user input.
- **Parse the Tag**: Extract the JSON payload from within `<a2ui-action>...</a2ui-action>`.
- **Target the Same Surface**: Do not call `createSurface` again for the same surface. Instead, respond by calling `render_a2ui` with `updateDataModel` or `updateComponents` using the exact `surfaceId` reported in the action.
- **Synchronize State**: If `dataModel` is included, inspect the form inputs or user selections, validate fields, and update the surface state to acknowledge the submission or transition to the next step.

## 4. Error Handling and Retries

If `render_a2ui` returns `isError: true`:

- The error response includes a numbered list of issues with exact `messageIndex` and error descriptions (e.g. invalid component reference, unallowed child, missing root).
- State changes from failed batches are rolled back atomically.
- Correct the identified message parameters and retry the `render_a2ui` call.
