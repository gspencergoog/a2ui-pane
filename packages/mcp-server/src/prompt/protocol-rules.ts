/**
 * Canonical protocol rules prompt text for A2UI v0.9 authoring.
 * Embedded directly into TypeScript to ensure standalone bundles retain complete rules
 * with zero runtime filesystem dependencies.
 */
export const PROTOCOL_RULES = `# A2UI Protocol Rules (v0.9)

A2UI is a declarative, streaming-friendly UI protocol for generating and updating rich interfaces.

## 1. Message Structure
All interactions consist of a sequence of layout operations targeting one or more surfaces.
Each operation object must declare "version": "v0.9" and contain one of the following commands:

- createSurface: Initializes a surface.
  \`\`\`json
  {
    "version": "v0.9",
    "createSurface": {
      "surfaceId": "main-form",
      "catalogId": "basic",
      "sendDataModel": true
    }
  }
  \`\`\`
  Set "sendDataModel": true to receive the bound state of the surface back whenever the user triggers an action.

- updateComponents: Declares or updates components on a surface.
  \`\`\`json
  {
    "version": "v0.9",
    "updateComponents": {
      "surfaceId": "main-form",
      "components": [
        {
          "id": "root",
          "component": "Column",
          "children": ["title-text", "submit-btn"]
        },
        {
          "id": "title-text",
          "component": "Text",
          "text": "Registration Form",
          "variant": "h2"
        },
        {
          "id": "submit-label",
          "component": "Text",
          "text": "Register"
        },
        {
          "id": "submit-btn",
          "component": "Button",
          "child": "submit-label",
          "variant": "primary",
          "action": {
            "event": {
              "name": "submitRegistration",
              "context": { "source": "main-form" }
            }
          }
        }
      ]
    }
  }
  \`\`\`

- updateDataModel: Dynamically updates bound data values on an existing surface without re-declaring component structures.
  \`\`\`json
  {
    "version": "v0.9",
    "updateDataModel": {
      "surfaceId": "main-form",
      "path": "/formData/status",
      "value": "Submitting..."
    }
  }
  \`\`\`

- deleteSurface: Destroys an existing surface when it is no longer needed.
  \`\`\`json
  {
    "version": "v0.9",
    "deleteSurface": {
      "surfaceId": "main-form"
    }
  }
  \`\`\`

## 2. Key Hierarchy Rules
1. Every surface MUST declare a root component with id: "root". The renderer begins rendering the tree at root.
2. Components are supplied as a flat array, and parent components reference their children by ID (such as children: ["child1", "child2"]).
3. Every component must have a unique non-empty string id.
4. All component properties must conform to the catalog schema for that component type.

## 3. Handling User Actions & Two-Way Binding
When a user interacts with a control (such as clicking a Button), the client sends an action message back into the conversation formatted as:
\`\`\`text
[A2UI] Triggered "Register" (submitRegistration) on surface main-form.
<a2ui-action>{"version":"v0.9","action":{"name":"submitRegistration","surfaceId":"main-form","context":{...}},"dataModel":{...}}</a2ui-action>
\`\`\`

When you receive this message:
- Treat the contents as user input.
- Update the existing surface rather than creating a new one unless you want a separate panel. Issue updateDataModel or updateComponents targeting the existing surfaceId (for example, updating a message label or toggling button states).`;
