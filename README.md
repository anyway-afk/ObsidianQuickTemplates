# Obsidian Quick Templates

A feature-rich Obsidian plugin for managing text templates. Create, save, update, and insert text templates with ease.

## Features

- **Save Selection as Template**: Select text and save it as a reusable template via command palette or right-click menu.
- **Insert Template**: Insert templates via command palette, right-click menu, or autocomplete.
- **Autocomplete**: Type `!!template_name` to quickly insert templates (supports all Unicode characters).
- **Manage Templates**: Edit or delete your saved templates.
- **Template Preview**: Hover over templates to see a preview of their content.

## How to Use

### Save a Template

1. Select text in your note.
2. Either:
   - Open the command palette (`Ctrl/Cmd + P`) and run "Save selection as template".
   - Right-click and select "Save selection as template" from the context menu.
3. Enter a name for your template.
4. Choose whether to use the template name as a command or provide a custom command.
5. Click "Save".

### Insert a Template

There are three ways to insert a template:

1. **Command Palette**: Open the command palette and run "Insert template".
2. **Right-Click Menu**: Right-click in the editor and select "Insert template".
3. **Autocomplete**: Type `!!` followed by your template name or custom command.

### Manage Templates

1. Open the command palette.
2. Run the command "Manage templates".
3. From here, you can:
   - Edit template content or settings
   - Delete templates


## Installation

### Manual Installation

1. Download the latest release from the GitHub repository.
2. Extract the zip file into your Obsidian plugins folder:
   - Windows: `%APPDATA%\Obsidian\plugins\`
   - macOS: `~/Library/Application Support/Obsidian/plugins/`
   - Linux: `~/.config/Obsidian/plugins/`
3. Rename the folder to `obsidian-quick-templates`.
4. Restart Obsidian and enable the plugin in Settings > Community plugins.

## Building from Source

1. Clone the repository.
2. Run `npm install` to install dependencies.
3. Run `npm run build` to build the plugin.
4. Copy the `main.js`, `manifest.json`, and `styles.css` to your Obsidian plugins folder.

## License

This project is licensed under the MIT License. 
