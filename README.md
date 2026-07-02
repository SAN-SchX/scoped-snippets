# Scoped Snippets
Scoped Snippets is an Obsidian plugin that lets you apply CSS snippets to individual Markdown (.md) and Base (.base) files instead of enabling them globally across your entire vault.


### ⚠️ IMPORTANT: Disable CSS snippets in Obsidian first
For this plugin to work as intended, the CSS snippets you want to control per file must be disabled in Obsidian’s built-in **Settings → Appearance → CSS snippets** section.

If a snippet is enabled there, Obsidian will apply it globally across the entire vault, and Scoped Snippets will not be able to limit it to a single `.md` or `.base` file.

## Installation

**Manual Installation:**

Download the latest release from the GitHub releases page.
Extract the downloaded ZIP file.
Copy the plugin folder into:

	YourVault/.obsidian/plugins/

Restart Obsidian.
Go to Settings → Community plugins.
Enable Scoped Snippets.

**From Obsidian Community Plugins:**
1. Open Settings → Community plugins.
2. Click **Browse** and search for "Scoped Snippets".
3. Click **Install**, then **Enable**.

## Usage

Add your CSS snippets to:

	.obsidian/snippets/

Open a Markdown `.md` or Base `.base` file then use the picker in the file view header. Tick one or more CSS snippets to apply them to that specific file. The button shows the current selection (`— none —`, the snippet name, or `N snippets`).

To remove a snippets from a file, click "Clear" button

![Scoped Snippets demo](assets/demo_0_5_0v2.gif)

## ⚙️ Settings

You can customize the plugin in:

Settings → Community plugins → Scoped Snippets

Available settings:

1. Show or hide the snippet selector in supported file views.
2. Dropdown position:
	- Left
	- Right

Hiding the selector does not disable already assigned snippets. It only hides the selector UI.

## Limitations

Scoped Snippets is designed to scope regular CSS selectors to a specific file view. Some very complex CSS snippets, especially those using global selectors, advanced at-rules, or theme-wide variables, may require small adjustments to work perfectly when scoped.

## 🟢 changelog v0.5.0

- Replaced the dropdown component with a picker for improved usability.
- Removed the "center" position option for the selector.

## License

This project is licensed under the MIT License.
