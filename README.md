# Mermaid Preview for Claude Code

The Claude desktop app's Markdown preview shows Mermaid blocks as plain code. This plugin adds its own preview pane that draws them as diagrams.

- **View Plan button**: under any Claude reply that links a `.md` file containing a Mermaid block, a **View Plan** button opens that file in the preview pane.
- **`/mermaid-preview <file.md>`**: opens any Markdown file in the pane.
- **Expand**: each diagram has an Expand button that shows it enlarged in the pane, centred, with zoom controls (50% to 400%). Back returns to the plan at that diagram.
- The pane refreshes by itself when the file changes.
- A diagram with a syntax error shows Mermaid's error and its code.

## Install

On each computer that runs Claude Code sessions (macOS or Windows):

```bash
claude plugin marketplace add bizcrew-developer/claude-mermaid-preview
claude plugin install mermaid-preview@mermaid-preview
```

Then start a new session. Phones viewing a session that runs on one of these computers need nothing installed.

## Requirements

- **Node.js with npm** ([nodejs.org](https://nodejs.org)).
- **Mermaid CLI (`mmdc`)**: installed automatically. The first time a diagram needs drawing and `mmdc` isn't found, the plugin runs `npm install -g @mermaid-js/mermaid-cli`. This downloads a headless Chrome and can take a few minutes. If it fails (for example, npm needs admin rights), the pane shows the command to run yourself.

## Notes

- Buttons show in the desktop app and VS Code. The terminal has no buttons, so use `/mermaid-preview` there; diagrams are drawn only on surfaces that support images.
- Diagrams are drawn as written, with their own theme and colours. Dark-theme diagrams get a dark background matching the pane; others get white.

## Development

The tests draw the pane through Claude Code's own plugin test runner, on the desktop, VS Code, mobile and terminal surfaces, and fail if the engine would refuse to draw it:

```bash
claude plugin test plugins/mermaid-preview
```
