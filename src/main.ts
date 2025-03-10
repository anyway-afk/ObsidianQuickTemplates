import {
    App,
    Editor,
    MarkdownView,
    Modal,
    Notice,
    Plugin,
    PluginSettingTab,
    Setting,
    Menu,
    EditorSuggest,
    EditorSuggestContext,
    EditorSuggestTriggerInfo,
    TFile,
    normalizePath
} from 'obsidian';

// Define EditorPosition type
interface EditorPosition {
    line: number;
    ch: number;
}

// Define HTMLElement with style property for TypeScript
declare global {
    interface HTMLElement {
        style: CSSStyleDeclaration;
    }

    interface Element {
        style?: CSSStyleDeclaration;
    }
}

interface Template {
    name: string;
    content: string;
    useNameAsCommand: boolean;
}

interface QuickTemplatesSettings {
    templates: Template[];
    useFileStorage: boolean;
    templatesFolder: string;
}

const DEFAULT_SETTINGS: QuickTemplatesSettings = {
    templates: [],
    useFileStorage: false,
    templatesFolder: 'templates'
}

export default class QuickTemplatesPlugin extends Plugin {
    settings: QuickTemplatesSettings;

    async onload() {
        await this.loadSettings();

        // Register "Save selection as template" command
        this.addCommand({
            id: 'save-selection-as-template',
            name: 'Save selection as template',
            editorCallback: (editor: Editor, view: MarkdownView) => {
                const selection = editor.getSelection();
                if (selection) {
                    new SaveTemplateModal(this.app, this, selection).open();
                } else {
                    new Notice('No text selected');
                }
            }
        });

        // Register "Insert template" command
        this.addCommand({
            id: 'insert-template',
            name: 'Insert template',
            editorCallback: (editor: Editor, view: MarkdownView) => {
                new InsertTemplateModal(this.app, this, editor).open();
            }
        });

        // Register "Manage templates" command
        this.addCommand({
            id: 'manage-templates',
            name: 'Manage templates',
            callback: () => {
                new ManageTemplatesModal(this.app, this).open();
            }
        });

        // Wait for Obsidian to be fully loaded before registering template commands
        this.app.workspace.onLayoutReady(() => {
            // Register custom commands for each template
            this.registerTemplateCommands();
        });

        // Register editor suggest for !!template + Tab
        this.registerEditorSuggest(new TemplateSuggest(this));

        // Add context menu for inserting templates
        this.registerEvent(
            this.app.workspace.on('editor-menu', (menu: Menu, editor: Editor) => {
                menu.addItem((item) => {
                    item.setTitle('Insert template')
                        .setIcon('template-glyph')
                        .onClick(() => {
                            new InsertTemplateModal(this.app, this, editor).open();
                        });
                });

                // Add "Save selection as template" to context menu
                const selection = editor.getSelection();
                if (selection) {
                    menu.addItem((item) => {
                        item.setTitle('Save selection as template')
                            .setIcon('plus-with-circle')
                            .onClick(() => {
                                new SaveTemplateModal(this.app, this, selection).open();
                            });
                    });
                }
            })
        );

        // Add settings tab
        this.addSettingTab(new QuickTemplatesSettingTab(this.app, this));

        // Create templates folder if using file storage
        if (this.settings.useFileStorage) {
            this.ensureTemplatesFolderExists();
        }
    }

    onunload() {
        console.log('Unloading Quick Templates plugin');
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());

        // If using file storage, load templates from files
        if (this.settings.useFileStorage) {
            await this.loadTemplatesFromFiles();
        }
    }

    async saveSettings() {
        // If using file storage, save templates to files
        if (this.settings.useFileStorage) {
            await this.saveTemplatesToFiles();

            // Save settings without templates to reduce file size
            const settingsWithoutTemplates = {
                ...this.settings,
                templates: [] // Don't store templates in settings.json when using file storage
            };
            await this.saveData(settingsWithoutTemplates);
        } else {
            await this.saveData(this.settings);
        }

        // Only register commands if the app is fully loaded
        if (this.app.workspace.layoutReady) {
            this.registerTemplateCommands();
        } else {
            // Otherwise, wait for the layout to be ready
            this.app.workspace.onLayoutReady(() => {
                this.registerTemplateCommands();
            });
        }
    }

    registerTemplateCommands() {
        try {
            // Unregister existing commands
            // @ts-ignore - commands is a private API
            this.app.commands.listCommands()
                .filter((cmd: any) => cmd.id.startsWith('quick-templates:template-'))
                .forEach((cmd: any) => {
                    // @ts-ignore - commandId is actually a property of the command
                    this.app.commands.removeCommand(cmd.id);
                });

            this.settings.templates.forEach(template => {
                if (!template) return;

                // Всегда используем имя шаблона как команду
                const commandText = template.name;

                if (!commandText) return;

                // Use a safer way to create command IDs that works with non-Latin characters
                const commandId = `quick-templates:template-${this.createSafeId(commandText)}`;

                const commandName = `Template: ${template.name}`;

                try {
                    this.addCommand({
                        id: commandId,
                        name: commandName,
                        editorCallback: (editor: Editor) => {
                            if (!editor) return;

                            // Just use the default behavior (insert at cursor)
                            this.insertTemplateContent(editor, template.content);
                        }
                    });
                } catch (addError) {
                    console.log(`Failed to add command ${commandId}:`, addError);
                }
            });
        } catch (error) {
            console.log('Error in registerTemplateCommands:', error);
        }
    }

    // Helper method to create a safe ID from any string (including non-Latin characters)
    createSafeId(text: string): string {
        // Convert to base64 to handle any Unicode characters safely
        return btoa(unescape(encodeURIComponent(text)))
            .replace(/\+/g, '-')
            .replace(/\//g, '_')
            .replace(/=+$/, '');
    }

    // Helper method to insert template content with proper Markdown rendering
    insertTemplateContent(editor: Editor, content: string, startPos?: EditorPosition, endPos?: EditorPosition) {
        if (!editor || !content) {
            console.log('Editor or content is null, cannot insert template');
            return;
        }

        try {
            if (startPos && endPos) {
                // Replace the specified range with the template content
                editor.replaceRange(content, startPos, endPos);
            } else {
                // Insert at current cursor position
                editor.replaceSelection(content);
            }

            // Trigger Obsidian's Markdown processor to render the content
            // This is a workaround as there's no direct API to force rendering
            try {
                const cursor = editor.getCursor();
                if (cursor) {
                    editor.setCursor(cursor);
                }
            } catch (cursorError) {
                console.log('Error setting cursor after template insertion:', cursorError);
            }
        } catch (error) {
            console.log('Error inserting template content:', error);
            new Notice('Failed to insert template. Please try again.');
        }
    }

    // Ensure templates folder exists when using file storage
    ensureTemplatesFolderExists() {
        const templatesPath = normalizePath(this.settings.templatesFolder);

        try {
            // Check if folder exists
            const folderExists = this.app.vault.getAbstractFileByPath(templatesPath) !== null;

            if (!folderExists) {
                // Create folder
                this.app.vault.createFolder(templatesPath).catch(error => {
                    console.error('Failed to create templates folder:', error);
                    new Notice('Failed to create templates folder. Reverting to JSON storage.');
                    this.settings.useFileStorage = false;
                });
            }
        } catch (error) {
            console.error('Failed to create templates folder:', error);
            new Notice('Failed to create templates folder. Reverting to JSON storage.');
            this.settings.useFileStorage = false;
        }
    }

    // Load templates from files
    async loadTemplatesFromFiles() {
        try {
            const templatesPath = normalizePath(this.settings.templatesFolder);

            // Check if folder exists
            const folder = this.app.vault.getAbstractFileByPath(templatesPath);
            if (!folder) {
                return;
            }

            // Clear existing templates
            this.settings.templates = [];

            // Get all template files
            const files = this.app.vault.getFiles().filter(file =>
                file.path.startsWith(this.settings.templatesFolder + '/') &&
                file.extension === 'md'
            );

            for (const file of files) {
                try {
                    const content = await this.app.vault.read(file);
                    const metaSection = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);

                    if (metaSection) {
                        const metaContent = metaSection[1];
                        const templateContent = metaSection[2].trim();

                        // Parse metadata
                        const name = metaContent.match(/name:\s*(.*)/)?.[1]?.trim();
                        const useNameAsCommand = metaContent.match(/useNameAsCommand:\s*(.*)/)?.[1]?.trim() === 'true';

                        if (name) {
                            this.settings.templates.push({
                                name,
                                content: templateContent,
                                useNameAsCommand,
                            });
                        }
                    }
                } catch (error) {
                    console.error(`Failed to load template from file ${file.path}:`, error);
                }
            }
        } catch (error) {
            console.error('Failed to load templates from files:', error);
            new Notice('Failed to load templates from files. Some templates may be missing.');
        }
    }

    // Save templates to files
    async saveTemplatesToFiles() {
        try {
            const templatesPath = normalizePath(this.settings.templatesFolder);

            // Check if folder exists
            const folder = this.app.vault.getAbstractFileByPath(templatesPath);
            if (!folder) {
                this.ensureTemplatesFolderExists();
            }

            // Get existing template files
            const existingFiles = this.app.vault.getFiles().filter(file =>
                file.path.startsWith(this.settings.templatesFolder + '/') &&
                file.extension === 'md'
            );

            // Create a map of existing files for quick lookup
            const existingFileMap = new Map();
            existingFiles.forEach(file => {
                const baseName = file.basename;
                existingFileMap.set(baseName, file);
            });

            // Process each template
            for (const template of this.settings.templates) {
                const safeFileName = this.createSafeFileName(template.name);
                const filePath = normalizePath(`${this.settings.templatesFolder}/${safeFileName}.md`);

                // Create metadata section
                const metadata = [
                    '---',
                    `name: ${template.name}`,
                    `useNameAsCommand: ${template.useNameAsCommand}`,
                    '---',
                    '',
                    template.content
                ].join('\n');

                // Check if file exists
                if (existingFileMap.has(safeFileName)) {
                    // Update existing file
                    await this.app.vault.modify(existingFileMap.get(safeFileName), metadata);
                    existingFileMap.delete(safeFileName);
                } else {
                    // Create new file
                    await this.app.vault.create(filePath, metadata);
                }
            }

            // Delete files for templates that no longer exist
            for (const [_, file] of existingFileMap.entries()) {
                await this.app.vault.delete(file);
            }
        } catch (error) {
            console.error('Failed to save templates to files:', error);
            new Notice('Failed to save templates to files. Reverting to JSON storage.');
            this.settings.useFileStorage = false;
            await this.saveData(this.settings);
        }
    }

    // Create a safe filename from template name
    createSafeFileName(name: string): string {
        return name
            .replace(/[\\/:*?"<>|]/g, '_') // Replace invalid filename characters
            .replace(/\s+/g, '_')          // Replace spaces with underscores
            .substring(0, 100);            // Limit length
    }
}

class SaveTemplateModal extends Modal {
    plugin: QuickTemplatesPlugin;
    templateContent: string;
    templateNameInput: HTMLInputElement;

    constructor(app: App, plugin: QuickTemplatesPlugin, templateContent: string) {
        super(app);
        this.plugin = plugin;
        this.templateContent = templateContent;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.createEl('h2', { text: 'Save as Template' });

        // Template name
        new Setting(contentEl)
            .setName('Template name')
            .setDesc('Enter a name for this template. The template will be available as a command with this name.')
            .addText(text => {
                this.templateNameInput = text.inputEl;
                text.setPlaceholder('Template name')
                    .setValue('')
                    .onChange(value => {
                        // Удаляем обновление customCommand
                    });
            });

        // Double-check to make sure no custom command field exists
        setTimeout(() => {
            const existingCustomCommandSetting = contentEl.querySelector('.custom-command-setting');
            if (existingCustomCommandSetting) {
                existingCustomCommandSetting.remove();
            }
        }, 0);

        // Save button
        new Setting(contentEl)
            .addButton(button => {
                button.setButtonText('Save')
                    .setCta()
                    .onClick(async () => {
                        const templateName = this.templateNameInput.value.trim();
                        if (!templateName) {
                            new Notice('Template name is required');
                            return;
                        }

                        // Всегда используем имя шаблона как команду
                        await this.saveTemplateToSettings(templateName, '', true);
                    });
            })
            .addButton(button => {
                button.setButtonText('Cancel')
                    .onClick(() => {
                        this.close();
                    });
            });
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }

    async saveTemplateToSettings(name: string, cmd: string, useNameAsCmd: boolean) {
        // Check if template with same name exists
        const existingTemplateIndex = this.plugin.settings.templates.findIndex((t: Template) => t.name === name);
        if (existingTemplateIndex >= 0) {
            // Confirm overwrite
            const confirmModal = new ConfirmModal(
                this.app,
                `Template "${name}" already exists. Overwrite?`,
                async (confirmed) => {
                    if (confirmed) {
                        // Update existing template
                        this.plugin.settings.templates[existingTemplateIndex] = {
                            name: name,
                            content: this.templateContent,
                            useNameAsCommand: true, // Всегда true
                        };
                        await this.plugin.saveSettings();
                        new Notice(`Template "${name}" updated`);
                        this.close();
                    }
                }
            ).open();
        } else {
            // Add new template
            this.plugin.settings.templates.push({
                name: name,
                content: this.templateContent,
                useNameAsCommand: true, // Всегда true
            });
            await this.plugin.saveSettings();
            new Notice(`Template "${name}" saved`);
            this.close();
        }
    }
}

class InsertTemplateModal extends Modal {
    plugin: QuickTemplatesPlugin;
    editor: Editor;

    constructor(app: App, plugin: QuickTemplatesPlugin, editor: Editor) {
        super(app);
        this.plugin = plugin;
        this.editor = editor;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.createEl('h2', { text: 'Insert Template' });

        if (this.plugin.settings.templates.length === 0) {
            contentEl.createEl('p', { text: 'No templates found. Create a template first.' });
            return;
        }

        // Create a list of templates
        const templateList = contentEl.createEl('div', { cls: 'template-list' });

        // Add some styling
        templateList.style.maxHeight = '300px';
        templateList.style.overflow = 'auto';
        templateList.style.margin = '10px 0';

        this.plugin.settings.templates.forEach(template => {
            const templateItem = templateList.createEl('div', { cls: 'template-item' });
            templateItem.style.padding = '8px';
            templateItem.style.borderBottom = '1px solid var(--background-modifier-border)';
            templateItem.style.cursor = 'pointer';
            templateItem.style.display = 'flex';
            templateItem.style.justifyContent = 'space-between';
            templateItem.style.alignItems = 'center';
            templateItem.setAttribute('aria-label', template.content.length > 100
                ? template.content.substring(0, 100) + '...'
                : template.content);

            // Template name
            const nameEl = templateItem.createEl('div', { text: template.name });
            nameEl.style.fontWeight = 'bold';

            // Command info
            const commandInfo = template.name;
            const commandEl = templateItem.createEl('div', { text: `!!${commandInfo}` });
            commandEl.style.color = 'var(--text-muted)';
            commandEl.style.fontSize = '0.8em';

            // Click to insert
            templateItem.addEventListener('click', () => {
                // Just use the default behavior (insert at cursor)
                this.plugin.insertTemplateContent(this.editor, template.content);
                this.close();
            });

            // Hover effect with preview tooltip
            templateItem.addEventListener('mouseenter', () => {
                templateItem.style.backgroundColor = 'var(--background-modifier-hover)';

                // Create tooltip with template preview
                const tooltip = document.createElement('div');
                tooltip.classList.add('template-tooltip');

                // Only show the content once in the tooltip
                tooltip.textContent = template.content.length > 100
                    ? template.content.substring(0, 100) + '...'
                    : template.content;

                // Position tooltip
                tooltip.style.position = 'absolute';
                tooltip.style.zIndex = '1000';
                tooltip.style.backgroundColor = 'var(--background-primary)';
                tooltip.style.border = '1px solid var(--background-modifier-border)';
                tooltip.style.borderRadius = '4px';
                tooltip.style.padding = '8px';
                tooltip.style.maxWidth = '300px';
                tooltip.style.boxShadow = '0 2px 8px rgba(0, 0, 0, 0.1)';
                tooltip.style.fontSize = '0.9em';
                tooltip.style.whiteSpace = 'pre-wrap';
                tooltip.style.wordBreak = 'break-word';

                // Add tooltip to DOM
                document.body.appendChild(tooltip);

                // Position tooltip near the template item
                const rect = templateItem.getBoundingClientRect();
                tooltip.style.left = `${rect.right + 10}px`;
                tooltip.style.top = `${rect.top}px`;

                // Store tooltip reference for removal
                templateItem.dataset.tooltipId = Date.now().toString();
                tooltip.dataset.tooltipId = templateItem.dataset.tooltipId;
            });

            templateItem.addEventListener('mouseleave', () => {
                templateItem.style.backgroundColor = '';

                // Remove tooltip
                if (templateItem.dataset.tooltipId) {
                    const tooltip = document.querySelector(`.template-tooltip[data-tooltip-id="${templateItem.dataset.tooltipId}"]`);
                    if (tooltip) {
                        tooltip.remove();
                    }
                }
            });
        });

        // Cancel button
        new Setting(contentEl)
            .addButton(button => {
                button.setButtonText('Cancel')
                    .onClick(() => {
                        this.close();
                    });
            });
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();

        // Clean up any tooltips that might still be in the DOM
        document.querySelectorAll('.template-tooltip').forEach(tooltip => {
            tooltip.remove();
        });
    }
}

class ManageTemplatesModal extends Modal {
    plugin: QuickTemplatesPlugin;

    constructor(app: App, plugin: QuickTemplatesPlugin) {
        super(app);
        this.plugin = plugin;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.createEl('h2', { text: 'Manage Templates' });

        if (this.plugin.settings.templates.length === 0) {
            contentEl.createEl('p', { text: 'No templates found. Create a template first.' });
            return;
        }

        // Create a list of templates
        const templateList = contentEl.createEl('div', { cls: 'template-list' });
        templateList.style.maxHeight = '400px';
        templateList.style.overflow = 'auto';
        templateList.style.margin = '10px 0';

        this.plugin.settings.templates.forEach((template, index) => {
            const templateItem = templateList.createEl('div', { cls: 'template-item' });
            templateItem.style.padding = '10px';
            templateItem.style.borderBottom = '1px solid var(--background-modifier-border)';
            templateItem.style.display = 'flex';
            templateItem.style.justifyContent = 'space-between';
            templateItem.style.alignItems = 'center';

            // Template info
            const infoEl = templateItem.createEl('div');
            infoEl.createEl('div', { text: template.name, cls: 'template-name' }).style.fontWeight = 'bold';

            const commandInfo = template.name;
            infoEl.createEl('div', { text: `Command: !!${commandInfo}`, cls: 'template-command' }).style.color = 'var(--text-muted)';

            // Preview of content (first 50 chars)
            const previewText = template.content.length > 50
                ? template.content.substring(0, 50) + '...'
                : template.content;
            infoEl.createEl('div', { text: previewText, cls: 'template-preview' }).style.color = 'var(--text-muted)';
            infoEl.createEl('div', { cls: 'template-preview' }).style.fontSize = '0.8em';

            // Actions
            const actionsEl = templateItem.createEl('div', { cls: 'template-actions' });
            actionsEl.style.display = 'flex';
            actionsEl.style.gap = '8px';

            // Edit button
            const editBtn = actionsEl.createEl('button', { text: '📝' });
            editBtn.style.cursor = 'pointer';
            editBtn.addEventListener('click', () => {
                new EditTemplateModal(this.app, this.plugin, template, index, () => {
                    this.close();
                    new ManageTemplatesModal(this.app, this.plugin).open();
                }).open();
            });

            // Delete button
            const deleteBtn = actionsEl.createEl('button', { text: '❌' });
            deleteBtn.style.cursor = 'pointer';
            deleteBtn.addEventListener('click', () => {
                new ConfirmModal(
                    this.app,
                    `Delete template "${template.name}"?`,
                    async (confirmed) => {
                        if (confirmed) {
                            this.plugin.settings.templates.splice(index, 1);
                            await this.plugin.saveSettings();
                            new Notice(`Template "${template.name}" deleted`);
                            this.close();
                            new ManageTemplatesModal(this.app, this.plugin).open();
                        }
                    }
                ).open();
            });
        });

        // Close button
        new Setting(contentEl)
            .addButton(button => {
                button.setButtonText('Close')
                    .onClick(() => {
                        this.close();
                    });
            });
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}

class EditTemplateModal extends Modal {
    plugin: QuickTemplatesPlugin;
    template: Template;
    templateIndex: number;
    onSave: () => void;
    nameInput: HTMLInputElement;
    contentTextarea: HTMLTextAreaElement;

    constructor(app: App, plugin: QuickTemplatesPlugin, template: Template, templateIndex: number, onSave: () => void) {
        super(app);
        this.plugin = plugin;
        this.template = template;
        this.templateIndex = templateIndex;
        this.onSave = onSave;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.createEl('h2', { text: 'Edit Template' });

        // Template name
        new Setting(contentEl)
            .setName('Template name')
            .setDesc('Enter a name for this template. The template will be available as a command with this name.')
            .addText(text => {
                this.nameInput = text.inputEl;
                text.setValue(this.template.name)
                    .onChange(value => {
                        // Удаляем обновление customCommand
                    });
            });

        // Template content
        new Setting(contentEl)
            .setName('Template content')
            .setDesc('The content of the template')
            .setClass('template-content-setting');

        // Add a textarea for content
        this.contentTextarea = contentEl.createEl('textarea', {
            attr: {
                rows: '10',
                style: 'width: 100%; font-family: monospace; margin-bottom: 1em;'
            }
        });
        this.contentTextarea.value = this.template.content;

        // Double-check to make sure no custom command field exists
        setTimeout(() => {
            const existingCustomCommandSetting = contentEl.querySelector('.custom-command-setting');
            if (existingCustomCommandSetting) {
                existingCustomCommandSetting.remove();
            }
        }, 0);

        // Save and Cancel buttons
        new Setting(contentEl)
            .addButton(button => {
                button.setButtonText('Save')
                    .setCta()
                    .onClick(async () => {
                        const templateName = this.nameInput.value.trim();
                        if (!templateName) {
                            new Notice('Template name is required');
                            return;
                        }

                        // Всегда используем имя шаблона как команду
                        await this.saveTemplateToSettings(templateName, '', true);
                    });
            })
            .addButton(button => {
                button.setButtonText('Cancel')
                    .onClick(() => {
                        this.close();
                    });
            });
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }

    async saveTemplateToSettings(name: string, cmd: string, useNameAsCmd: boolean) {
        // Check if template with same name exists (excluding current template)
        const existingTemplateIndex = this.plugin.settings.templates.findIndex(
            (t: Template, idx: number) => t.name === name && idx !== this.templateIndex
        );

        if (existingTemplateIndex >= 0) {
            new Notice(`Template with name "${name}" already exists`);
            return;
        }

        // Update template
        this.plugin.settings.templates[this.templateIndex] = {
            name: name,
            content: this.contentTextarea.value,
            useNameAsCommand: true, // Всегда true
        };

        await this.plugin.saveSettings();
        new Notice(`Template "${name}" updated`);
        this.close();
        this.onSave();
    }
}

class ConfirmModal extends Modal {
    message: string;
    onConfirm: (confirmed: boolean) => void;

    constructor(app: App, message: string, onConfirm: (confirmed: boolean) => void) {
        super(app);
        this.message = message;
        this.onConfirm = onConfirm;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.createEl('h2', { text: 'Confirm' });
        contentEl.createEl('p', { text: this.message });

        new Setting(contentEl)
            .addButton(button => {
                button.setButtonText('Yes')
                    .setCta()
                    .onClick(() => {
                        this.onConfirm(true);
                        this.close();
                    });
            })
            .addButton(button => {
                button.setButtonText('No')
                    .onClick(() => {
                        this.onConfirm(false);
                        this.close();
                    });
            });
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}

class TemplateSuggest extends EditorSuggest<Template> {
    plugin: QuickTemplatesPlugin;
    isInserting: boolean = false;

    constructor(plugin: QuickTemplatesPlugin) {
        super(plugin.app);
        this.plugin = plugin;
    }

    onTrigger(cursor: EditorPosition, editor: Editor, file: TFile): EditorSuggestTriggerInfo | null {
        if (!cursor || !editor || !file) {
            return null;
        }

        // Don't trigger if we're in the middle of inserting a template
        if (this.isInserting) return null;

        try {
            const line = editor.getLine(cursor.line);
            if (!line) return null;

            const subString = line.substring(0, cursor.ch);

            // Updated regex to support all Unicode characters (including non-Latin)
            const match = subString.match(/!!([^\s]*)$/u);
            if (!match) return null;

            return {
                start: {
                    line: cursor.line,
                    ch: subString.lastIndexOf('!!'),
                },
                end: cursor,
                query: match[1],
            };
        } catch (error) {
            console.log('Error in TemplateSuggest.onTrigger:', error);
            return null;
        }
    }

    getSuggestions(context: EditorSuggestContext): Template[] {
        if (!context) return [];

        try {
            const query = context.query.toLowerCase();

            // If query is empty, return all templates
            if (!query) {
                return this.plugin.settings.templates || [];
            }

            return (this.plugin.settings.templates || []).filter(template => {
                if (!template) return false;

                const nameMatch = template.name.toLowerCase().includes(query);
                return nameMatch;
            });
        } catch (error) {
            console.log('Error in TemplateSuggest.getSuggestions:', error);
            return [];
        }
    }

    renderSuggestion(template: Template, el: HTMLElement): void {
        if (!template || !el) return;

        try {
            el.createEl('div', { text: template.name, cls: 'suggestion-title' });

            const commandInfo = template.name;
            el.createEl('div', { text: `!!${commandInfo}`, cls: 'suggestion-note' });

            // Preview of content (first 100 chars instead of 50)
            const previewText = template.content.length > 100
                ? template.content.substring(0, 100) + '...'
                : template.content;
            el.createEl('div', { text: previewText, cls: 'suggestion-content' });
        } catch (error) {
            console.log('Error in TemplateSuggest.renderSuggestion:', error);
        }
    }

    selectSuggestion(template: Template, event: MouseEvent | KeyboardEvent): void {
        if (!template) return;

        try {
            if (this.context && this.context.editor) {
                const editor = this.context.editor;
                const startPos = this.context.start;
                const endPos = this.context.end;

                if (!editor || !startPos || !endPos) {
                    console.log('Missing editor or position information');
                    return;
                }

                // Set flag to prevent re-triggering during insertion
                this.isInserting = true;

                // Replace the template command with the template content
                editor.replaceRange(template.content, startPos, endPos);

                // Reset the flag after a short delay
                setTimeout(() => {
                    this.isInserting = false;
                }, 100);

                // Close the suggestion popup
                this.close();
            }
        } catch (error) {
            console.log('Error in TemplateSuggest.selectSuggestion:', error);
            this.isInserting = false;
        }
    }
}

class QuickTemplatesSettingTab extends PluginSettingTab {
    plugin: QuickTemplatesPlugin;

    constructor(app: App, plugin: QuickTemplatesPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();

        containerEl.createEl('h2', { text: 'Quick Templates Settings' });

        // Storage settings
        containerEl.createEl('h3', { text: 'Storage Settings' });

        new Setting(containerEl)
            .setName('Use file-based storage')
            .setDesc('Store templates as individual files in a templates folder instead of in settings.json')
            .addToggle(toggle => {
                toggle.setValue(this.plugin.settings.useFileStorage)
                    .onChange(async (value) => {
                        this.plugin.settings.useFileStorage = value;

                        // Show/hide templates folder setting based on toggle
                        const folderSetting = containerEl.querySelector('.templates-folder-setting') as HTMLElement;
                        if (folderSetting) {
                            folderSetting.style.display = value ? 'flex' : 'none';
                        }

                        await this.plugin.saveSettings();
                    });
            });

        // Templates folder setting
        const templatesFolderSetting = new Setting(containerEl)
            .setName('Templates folder')
            .setDesc('Folder where template files will be stored (relative to Obsidian config folder)')
            .setClass('templates-folder-setting')
            .addText(text => {
                text.setValue(this.plugin.settings.templatesFolder)
                    .onChange(async (value) => {
                        if (value.trim()) {
                            this.plugin.settings.templatesFolder = value.trim();
                            await this.plugin.saveSettings();
                        }
                    });
            })
            .addButton(button => {
                button.setButtonText('Open Folder')
                    .setTooltip('Open templates folder in Obsidian')
                    .onClick(() => {
                        // Get the full path to the templates folder
                        const templatesPath = normalizePath(this.plugin.settings.templatesFolder);

                        // Try to open the folder in Obsidian
                        const folder = this.app.vault.getAbstractFileByPath(templatesPath);
                        if (folder) {
                            // If the folder exists, open it in a new leaf
                            this.app.workspace.getLeaf().openFile(folder as any);
                        } else {
                            // If the folder doesn't exist, try to create it
                            this.plugin.ensureTemplatesFolderExists();
                            new Notice(`Templates folder created at: ${templatesPath}`);
                        }
                    });
            });

        // Add information about the full path to the templates folder
        if (this.plugin.settings.useFileStorage) {
            // Используем более безопасный способ отображения пути
            const templatesPath = normalizePath(this.plugin.settings.templatesFolder);

            const pathInfo = containerEl.createEl('div', {
                cls: 'templates-path-info',
                attr: {
                    style: 'margin-top: 8px; margin-bottom: 16px; font-size: 0.8em; color: var(--text-muted);'
                }
            });

            pathInfo.createEl('div', {
                text: 'Templates folder location:',
                attr: {
                    style: 'margin-bottom: 4px;'
                }
            });

            pathInfo.createEl('code', {
                text: `${templatesPath} (relative to your vault root)`,
                attr: {
                    style: 'word-break: break-all; background-color: var(--background-secondary); padding: 4px 8px; border-radius: 4px;'
                }
            });
        }

        // Hide templates folder setting if not using file storage
        if (!this.plugin.settings.useFileStorage) {
            templatesFolderSetting.settingEl.style.display = 'none';
        }

        containerEl.createEl('p', {
            text: 'Use the "Manage templates" command to create, edit, and delete templates.',
            attr: {
                style: 'margin-bottom: 16px; font-style: italic; color: var(--text-accent);'
            }
        });

        // Улучшенный раздел Usage
        const usageSection = containerEl.createEl('div', {
            cls: 'usage-section',
            attr: {
                style: 'background-color: var(--background-secondary); padding: 16px; border-radius: 8px; margin-bottom: 24px;'
            }
        });

        usageSection.createEl('h3', {
            text: 'How to Use Quick Templates',
            attr: {
                style: 'margin-top: 0; margin-bottom: 16px; color: var(--text-accent); border-bottom: 1px solid var(--background-modifier-border); padding-bottom: 8px;'
            }
        });

        // Создаем карточки для каждого пункта использования
        const usageCards = usageSection.createEl('div', {
            cls: 'usage-cards',
            attr: {
                style: 'display: flex; flex-direction: column; gap: 16px;'
            }
        });

        // Карточка 1: Save selection as template
        const saveCard = usageCards.createEl('div', {
            cls: 'usage-card',
            attr: {
                style: 'background-color: var(--background-primary); padding: 16px; border-radius: 6px; border-left: 4px solid var(--interactive-accent);'
            }
        });

        saveCard.createEl('h4', {
            text: '📝 Save selection as template',
            attr: {
                style: 'margin-top: 0; margin-bottom: 8px; color: var(--text-normal);'
            }
        });

        saveCard.createEl('p', {
            text: 'Select text in your note and use:',
            attr: {
                style: 'margin: 0 0 8px 0; color: var(--text-muted);'
            }
        });

        const saveSteps = saveCard.createEl('ul', {
            attr: {
                style: 'margin: 0; padding-left: 24px;'
            }
        });

        saveSteps.createEl('li', {
            text: 'Command palette (Ctrl/Cmd+P) → "Save selection as template"',
            attr: {
                style: 'margin-bottom: 4px;'
            }
        });

        saveSteps.createEl('li', {
            text: 'Right-click menu → "Save selection as template"'
        });

        // Карточка 2: Insert template
        const insertCard = usageCards.createEl('div', {
            cls: 'usage-card',
            attr: {
                style: 'background-color: var(--background-primary); padding: 16px; border-radius: 6px; border-left: 4px solid var(--interactive-accent);'
            }
        });

        insertCard.createEl('h4', {
            text: '📋 Insert template',
            attr: {
                style: 'margin-top: 0; margin-bottom: 8px; color: var(--text-normal);'
            }
        });

        insertCard.createEl('p', {
            text: 'Insert your saved templates using:',
            attr: {
                style: 'margin: 0 0 8px 0; color: var(--text-muted);'
            }
        });

        const insertSteps = insertCard.createEl('ul', {
            attr: {
                style: 'margin: 0; padding-left: 24px;'
            }
        });

        insertSteps.createEl('li', {
            text: 'Command palette → "Insert template"',
            attr: {
                style: 'margin-bottom: 4px;'
            }
        });

        insertSteps.createEl('li', {
            text: 'Right-click menu → "Insert template"',
            attr: {
                style: 'margin-bottom: 4px;'
            }
        });

        insertSteps.createEl('li', {
            text: 'Type !! followed by your template name (autocomplete will appear)'
        });

        // Карточка 3: Manage templates
        const manageCard = usageCards.createEl('div', {
            cls: 'usage-card',
            attr: {
                style: 'background-color: var(--background-primary); padding: 16px; border-radius: 6px; border-left: 4px solid var(--interactive-accent);'
            }
        });

        manageCard.createEl('h4', {
            text: '⚙️ Manage templates',
            attr: {
                style: 'margin-top: 0; margin-bottom: 8px; color: var(--text-normal);'
            }
        });

        manageCard.createEl('p', {
            text: 'Edit or delete your templates:',
            attr: {
                style: 'margin: 0 0 8px 0; color: var(--text-muted);'
            }
        });

        const manageSteps = manageCard.createEl('ul', {
            attr: {
                style: 'margin: 0; padding-left: 24px;'
            }
        });

        manageSteps.createEl('li', {
            text: 'Command palette → "Manage templates"'
        });

        // Кнопка для быстрого доступа к управлению шаблонами
        const quickAccessButton = usageSection.createEl('button', {
            text: '🚀 Open Template Manager',
            cls: 'mod-cta',
            attr: {
                style: 'margin-top: 16px; width: 100%;'
            }
        });

        quickAccessButton.addEventListener('click', () => {
            new ManageTemplatesModal(this.app, this.plugin).open();
        });

        if (this.plugin.settings.templates.length > 0) {
            containerEl.createEl('h3', { text: 'Your Templates' });

            const templateCount = containerEl.createEl('p', {
                text: `You have ${this.plugin.settings.templates.length} template(s)`
            });

            const manageButton = containerEl.createEl('button', {
                text: 'Manage Templates',
                cls: 'mod-cta'
            });

            manageButton.addEventListener('click', () => {
                new ManageTemplatesModal(this.app, this.plugin).open();
            });
        }
    }
} 