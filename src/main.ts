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

interface EditorPosition {
    line: number;
    ch: number;
}

declare global {
    interface HTMLElement {
        style: CSSStyleDeclaration;
    }

    interface Element {
        style?: CSSStyleDeclaration;
    }
}

declare module 'obsidian' {
    interface App {
        commands: {
            listCommands: () => ObsidianCommand[];
            removeCommand: (id: string) => void;
            executeCommandById: (id: string) => void;
        }
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
    useFileStorage: true,
    templatesFolder: 'templates'
}

interface ObsidianCommand {
    id: string;
    name: string;
}

export default class QuickTemplatesPlugin extends Plugin {
    settings: QuickTemplatesSettings;

    async onload() {
        await this.loadSettings();

        this.clearAllTooltips();

        try {
            const templatesPath = normalizePath(this.settings.templatesFolder);
            const folder = this.app.vault.getAbstractFileByPath(templatesPath);

            if (folder) {
                await this.validateTemplatesFolder();
                await this.loadTemplatesFromFiles();
            } else {
                await this.ensureTemplatesFolderExists();
            }
        } catch (error) {
            console.error("Error checking templates folder:", error);
        }

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

        this.addCommand({
            id: 'insert-template',
            name: 'Insert template',
            editorCallback: (editor: Editor, view: MarkdownView) => {
                new InsertTemplateModal(this.app, this, editor).open();
            }
        });

        this.addCommand({
            id: 'manage-templates',
            name: 'Manage templates',
            callback: () => {
                new ManageTemplatesModal(this.app, this).open();
            }
        });

        this.app.workspace.onLayoutReady(() => {
            this.registerTemplateCommands();
        });

        this.registerEditorSuggest(new TemplateSuggest(this));

        this.registerEvent(
            this.app.workspace.on('editor-menu', (menu: Menu, editor: Editor) => {
                menu.addItem((item) => {
                    item.setTitle('Insert template')
                        .setIcon('template-glyph')
                        .onClick(() => {
                            new InsertTemplateModal(this.app, this, editor).open();
                        });
                });

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

        this.addSettingTab(new QuickTemplatesSettingTab(this.app, this));
    }

    onunload() {
        this.clearAllTooltips();
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());

        this.settings.useFileStorage = true;

        try {
            await this.validateTemplatesFolder();

            await this.loadTemplatesFromFiles();
        } catch (error) {
            console.error("Error loading templates:", error);
            new Notice("Error loading templates. Check console for details.");
        }
    }

    async saveSettings() {
        if (this.settings.templates.length > 0) {
            await this.saveTemplatesToFiles();
        }

        const settingsWithoutTemplates = {
            ...this.settings,
            templates: []
        };
        await this.saveData(settingsWithoutTemplates);

        if (this.app.workspace.layoutReady) {
            this.registerTemplateCommands();
        } else {
            this.app.workspace.onLayoutReady(() => {
                this.registerTemplateCommands();
            });
        }
    }

    registerTemplateCommands() {
        try {
            this.app.commands.listCommands()
                .filter((cmd: ObsidianCommand) => cmd.id.startsWith('quick-templates:template-'))
                .forEach((cmd: ObsidianCommand) => {
                    this.app.commands.removeCommand(cmd.id);
                });

            this.settings.templates.forEach(template => {
                if (!template) return;

                const templateName = template.name;

                if (!templateName) return;

                const commandId = `quick-templates:template-${this.createSafeId(templateName)}`;

                const commandName = `Template: ${template.name}`;

                try {
                    this.addCommand({
                        id: commandId,
                        name: commandName,
                        editorCallback: (editor: Editor) => {
                            if (!editor) return;

                            this.insertTemplateContent(editor, template.content);
                        }
                    });
                } catch (addError) {
                }
            });
        } catch (error) {
        }
    }

    createSafeId(text: string): string {
        return btoa(unescape(encodeURIComponent(text)))
            .replace(/\+/g, '-')
            .replace(/\//g, '_')
            .replace(/=+$/, '');
    }

    insertTemplateContent(editor: Editor, content: string, startPos?: EditorPosition, endPos?: EditorPosition) {
        if (!editor || !content) {
            return;
        }

        try {
            if (startPos && endPos) {
                editor.replaceRange(content, startPos, endPos);
            } else {
                editor.replaceSelection(content);
            }

            try {
                const cursor = editor.getCursor();
                if (cursor) {
                    editor.setCursor(cursor);
                }
            } catch (cursorError) {
            }
        } catch (error) {
            new Notice('Failed to insert template. Please try again.');
        }
    }

    async ensureTemplatesFolderExists() {
        const templatesPath = normalizePath(this.settings.templatesFolder);

        try {
            const existingFolder = this.app.vault.getAbstractFileByPath(templatesPath);

            if (existingFolder) {
                return;
            }

            try {
                await this.app.vault.createFolder(templatesPath);
                new Notice(`Templates folder created at ${templatesPath}`);
            } catch (createError) {
                if (createError.message && createError.message.includes("already exists")) {
                    return;
                }
                throw createError;
            }
        } catch (error) {
            console.error('Failed to create templates folder:', error);
            new Notice('Failed to create templates folder. Please check file permissions.');
            throw error;
        }
    }

    async loadTemplatesFromFiles() {
        try {
            const templatesPath = normalizePath(this.settings.templatesFolder);

            const folder = this.app.vault.getAbstractFileByPath(templatesPath);
            if (!folder) {
                await this.ensureTemplatesFolderExists();
                return;
            }

            this.settings.templates = [];

            const files = this.app.vault.getFiles().filter(file =>
                file.path.startsWith(this.settings.templatesFolder + '/') &&
                file.extension === 'md'
            );

            if (files.length === 0) {
                return;
            }

            let loadedCount = 0;
            let errorCount = 0;

            for (const file of files) {
                try {
                    const content = await this.app.vault.read(file);

                    const metaSection = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);

                    if (metaSection) {
                        const metaContent = metaSection[1];
                        const templateContent = metaSection[2].trim();

                        const name = metaContent.match(/name:\s*(.*)/)?.[1]?.trim();
                        const useNameAsCommand = metaContent.match(/useNameAsCommand:\s*(.*)/)?.[1]?.trim() === 'true';

                        if (name) {
                            this.settings.templates.push({
                                name,
                                content: templateContent,
                                useNameAsCommand: useNameAsCommand !== undefined ? useNameAsCommand : true,
                            });
                            loadedCount++;
                        } else {
                            const fileName = file.basename;
                            this.settings.templates.push({
                                name: fileName,
                                content: templateContent,
                                useNameAsCommand: useNameAsCommand !== undefined ? useNameAsCommand : true,
                            });
                            loadedCount++;
                        }
                    } else {
                        const fileName = file.basename;
                        this.settings.templates.push({
                            name: fileName,
                            content: content.trim(),
                            useNameAsCommand: true,
                        });
                        loadedCount++;

                        try {
                            const updatedContent = [
                                '---',
                                `name: ${fileName}`,
                                'useNameAsCommand: true',
                                '---',
                                '',
                                content.trim()
                            ].join('\n');

                            await this.app.vault.modify(file, updatedContent);
                        } catch (updateError) {
                        }
                    }
                } catch (error) {
                    console.error(`Failed to load template from file ${file.path}:`, error);
                    errorCount++;
                }
            }

            if (loadedCount > 0) {
                new Notice(`Successfully loaded ${loadedCount} templates`);
            }

            if (this.settings.templates.length > 0 && this.app.workspace.layoutReady) {
                this.registerTemplateCommands();
            }

        } catch (error) {
            console.error('Failed to load templates from files:', error);
            new Notice('Failed to load templates from files. Some templates may be missing.');
        }
    }

    async saveTemplatesToFiles() {
        try {
            const templatesPath = normalizePath(this.settings.templatesFolder);

            const folder = this.app.vault.getAbstractFileByPath(templatesPath);
            if (!folder) {

                await this.ensureTemplatesFolderExists();

                const checkFolder = this.app.vault.getAbstractFileByPath(templatesPath);
                if (!checkFolder) {
                    throw new Error('Templates folder could not be created');
                }
            }

            const existingFiles = this.app.vault.getFiles().filter(file =>
                file.path.startsWith(this.settings.templatesFolder + '/') &&
                file.extension === 'md'
            );

            if (this.settings.templates.length === 0) {
                return;
            }

            const existingFileMap = new Map();
            existingFiles.forEach(file => {
                const baseName = file.basename;
                existingFileMap.set(baseName, file);
            });

            let savedCount = 0;
            let updatedCount = 0;
            let unchangedCount = 0;
            let newCount = 0;

            for (const template of this.settings.templates) {
                try {
                    if (!template || !template.name) {
                        continue;
                    }

                    const safeFileName = this.createSafeFileName(template.name);
                    const filePath = normalizePath(`${this.settings.templatesFolder}/${safeFileName}.md`);

                    const metadata = [
                        '---',
                        `name: ${template.name}`,
                        `useNameAsCommand: ${template.useNameAsCommand}`,
                        '---',
                        '',
                        template.content
                    ].join('\n');

                    if (existingFileMap.has(safeFileName)) {
                        const existingFile = existingFileMap.get(safeFileName);
                        const currentContent = await this.app.vault.read(existingFile);

                        if (currentContent !== metadata) {
                            await this.app.vault.modify(existingFileMap.get(safeFileName), metadata);
                            updatedCount++;
                        } else {
                            unchangedCount++;
                        }

                        existingFileMap.delete(safeFileName);
                        savedCount++;
                    } else {
                        await this.app.vault.create(filePath, metadata);
                        newCount++;
                        savedCount++;
                    }
                } catch (templateError) {
                    console.error(`Failed to save template "${template.name}":`, templateError);
                    new Notice(`Failed to save template "${template.name}". Check the console for details.`);
                }
            }

            if (savedCount > 0) {
                new Notice(`Saved ${savedCount} templates to ${templatesPath}`);
            }

            let deletedCount = 0;
            for (const [fileName, file] of existingFileMap.entries()) {
                try {
                    await this.app.fileManager.trashFile(file);
                    deletedCount++;
                } catch (deleteError) {
                    console.error(`Failed to delete template file "${file.path}":`, deleteError);
                }
            }

            if (deletedCount > 0) {
                new Notice(`Removed ${deletedCount} obsolete template files`);
            }

        } catch (error) {
            console.error('Failed to save templates to files:', error);
            new Notice('Failed to save templates to files. Please check file permissions.');
        }
    }

    createSafeFileName(name: string): string {
        return name
            .replace(/[\\/:*?"<>|]/g, '_')
            .replace(/\s+/g, '_')
            .substring(0, 100);
    }

    clearAllTooltips() {
        document.querySelectorAll('.template-tooltip').forEach(element => element.remove());
    }

    async validateTemplatesFolder() {
        try {
            const templatesPath = normalizePath(this.settings.templatesFolder);

            const folder = this.app.vault.getAbstractFileByPath(templatesPath);
            if (!folder) {
                await this.ensureTemplatesFolderExists();
                return;
            }

            if (folder instanceof TFile) {
                console.error(`Templates path ${templatesPath} is a file, not a folder`);
                new Notice(`Templates path is a file, not a folder. Please check settings.`);
                return;
            }

            const files = this.app.vault.getFiles().filter(file =>
                file.path.startsWith(templatesPath + '/') &&
                file.extension === 'md'
            );

            for (const file of files) {
                try {
                    const content = await this.app.vault.read(file);

                    if (content.trim() && !content.match(/^---\n([\s\S]*?)\n---\n/)) {
                        const fileName = file.basename;
                        const updatedContent = [
                            '---',
                            `name: ${fileName}`,
                            'useNameAsCommand: true',
                            '---',
                            '',
                            content.trim()
                        ].join('\n');

                        await this.app.vault.modify(file, updatedContent);
                    }
                } catch (error) {
                    console.error(`Error validating file ${file.path}:`, error);
                }
            }
        } catch (error) {
            console.error(`Error validating templates folder:`, error);
        }
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
                    });
            });

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

                        // always use the template name as the command
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

        this.plugin.clearAllTooltips();
    }

    async saveTemplateToSettings(name: string, cmd: string, useNameAsCmd: boolean) {
        const existingTemplateIndex = this.plugin.settings.templates.findIndex((t: Template) => t.name === name);
        if (existingTemplateIndex >= 0) {
            const confirmModal = new ConfirmModal(
                this.app,
                `Template "${name}" already exists. Overwrite?`,
                async (confirmed) => {
                    if (confirmed) {
                        this.plugin.settings.templates[existingTemplateIndex] = {
                            name: name,
                            content: this.templateContent,
                            useNameAsCommand: true,
                        };
                        await this.plugin.saveSettings();
                        new Notice(`Template "${name}" updated`);
                        this.close();
                    }
                }
            ).open();
        } else {
            this.plugin.settings.templates.push({
                name: name,
                content: this.templateContent,
                useNameAsCommand: true,
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

            const checkButton = contentEl.createEl('button', {
                text: 'Check Templates Folder',
                cls: 'mod-cta'
            });

            checkButton.addEventListener('click', async () => {
                const templatesPath = normalizePath(this.plugin.settings.templatesFolder);

                const folder = this.app.vault.getAbstractFileByPath(templatesPath);

                if (folder) {
                    new Notice(`Checking templates folder at ${templatesPath}...`);
                    await this.plugin.loadTemplatesFromFiles();

                    if (this.plugin.settings.templates.length > 0) {
                        new Notice(`Found ${this.plugin.settings.templates.length} templates.`);
                        this.close();
                        new InsertTemplateModal(this.app, this.plugin, this.editor).open();
                    } else {
                        new Notice(`No templates found in ${templatesPath}.`);
                        contentEl.empty();
                        contentEl.createEl('h2', { text: 'Insert Template' });
                        contentEl.createEl('p', { text: `No templates found in folder ${templatesPath}.` });
                        contentEl.createEl('p', { text: 'Please create a template first using "Save selection as template" command.' });
                    }
                } else {
                    await this.plugin.ensureTemplatesFolderExists();
                    new Notice(`Templates folder created at ${templatesPath}. Please create templates first.`);
                }
            });

            return;
        }

        const templateList = contentEl.createEl('div', { cls: 'template-list' });

        this.plugin.settings.templates.forEach(template => {
            const templateItem = templateList.createEl('div', { cls: 'template-item' });

            const nameEl = templateItem.createEl('div', { text: template.name, cls: 'template-name' });

            const commandInfo = template.name;
            const commandEl = templateItem.createEl('div', { text: `!!${commandInfo}`, cls: 'template-command' });

            templateItem.addEventListener('click', () => {
                this.plugin.insertTemplateContent(this.editor, template.content);
                this.close();
            });

            templateItem.addEventListener('mouseenter', () => {
                document.querySelectorAll('.template-tooltip').forEach(element => element.remove());

                const tooltip = document.createElement('div');
                tooltip.classList.add('template-tooltip', 'tooltip-positioned');

                tooltip.textContent = template.content.length > 100
                    ? template.content.substring(0, 100) + '...'
                    : template.content;

                document.body.appendChild(tooltip);

                const rect = templateItem.getBoundingClientRect();
                tooltip.style.left = `${rect.right + 10}px`;
                tooltip.style.top = `${rect.top}px`;

                templateItem.dataset.tooltipId = Date.now().toString();
                tooltip.dataset.tooltipId = templateItem.dataset.tooltipId;
            });

            templateItem.addEventListener('mouseleave', () => {
                this.plugin.clearAllTooltips();
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

        this.plugin.clearAllTooltips();
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

        const templateList = contentEl.createEl('div', { cls: 'template-list manage-list' });

        this.plugin.settings.templates.forEach((template, index) => {
            const templateItem = templateList.createEl('div', { cls: 'template-item' });

            // Template info (name, command, preview)
            const infoEl = templateItem.createEl('div', { cls: 'template-info' });

            infoEl.createEl('div', { text: template.name, cls: 'template-name template-name-bold' });

            const commandInfo = template.name;
            infoEl.createEl('div', { text: `Command: !!${commandInfo}`, cls: 'template-command template-command-muted' });

            // Preview of content
            const previewText = template.content.length > 100
                ? template.content.substring(0, 100) + '...'
                : template.content;
            infoEl.createEl('div', { text: previewText, cls: 'template-preview template-preview-text' });

            // Template actions (edit, delete)
            const actionsEl = templateItem.createEl('div', { cls: 'template-actions' });

            // Edit button
            const editBtn = actionsEl.createEl('button', { text: '✏️', cls: 'action-button' });
            editBtn.addEventListener('click', () => {
                new EditTemplateModal(this.app, this.plugin, template, index, () => {
                    this.close();
                    new ManageTemplatesModal(this.app, this.plugin).open();
                }).open();
            });

            // Delete button
            const deleteBtn = actionsEl.createEl('button', { text: '❌', cls: 'action-button' });
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

        this.plugin.clearAllTooltips();
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
                        // Remove the update of customCommand
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
                class: 'template-content-textarea'
            }
        });
        this.contentTextarea.value = this.template.content;

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

        this.plugin.clearAllTooltips();
    }

    async saveTemplateToSettings(name: string, cmd: string, useNameAsCmd: boolean) {
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
            useNameAsCommand: true,
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

        if (this.isInserting) return null;

        try {
            const line = editor.getLine(cursor.line);
            if (!line) return null;

            const subString = line.substring(0, cursor.ch);

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
            return null;
        }
    }

    getSuggestions(context: EditorSuggestContext): Template[] {
        if (!context) return [];

        try {
            const query = context.query.toLowerCase();

            if (!query) {
                return this.plugin.settings.templates || [];
            }

            return (this.plugin.settings.templates || []).filter(template => {
                if (!template) return false;

                const nameMatch = template.name.toLowerCase().includes(query);
                return nameMatch;
            });
        } catch (error) {
            return [];
        }
    }

    renderSuggestion(template: Template, el: HTMLElement): void {
        if (!template || !el) return;

        try {
            el.createEl('div', { text: template.name, cls: 'suggestion-title' });

            const commandInfo = template.name;
            el.createEl('div', { text: `!!${commandInfo}`, cls: 'suggestion-note' });

            const previewText = template.content.length > 100
                ? template.content.substring(0, 100) + '...'
                : template.content;
            el.createEl('div', { text: previewText, cls: 'suggestion-content' });
        } catch (error) {
        }
    }

    selectSuggestion(template: Template, event: MouseEvent | KeyboardEvent): void {
        if (!template) return;

        try {
            if (!this.context) return;

            const editor = this.context.editor;
            const startPos = this.context.start;
            const endPos = this.context.end;

            if (!editor || !startPos || !endPos) {
                return;
            }

            this.isInserting = true;

            editor.replaceRange(template.content, startPos, endPos);

            setTimeout(() => {
                this.isInserting = false;
            }, 100);

            this.close();
        } catch (error) {
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

        // Templates folder setting - without the ability to disable file storage
        const templatesFolderSetting = new Setting(containerEl)
            .setName('Templates folder')
            .setDesc('Folder where template files will be stored (relative to Obsidian vault folder)')
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
                    .onClick(async () => {
                        const templatesPath = normalizePath(this.plugin.settings.templatesFolder);

                        const folder = this.app.vault.getAbstractFileByPath(templatesPath);
                        if (folder) {
                            this.app.workspace.getLeaf().openFile(folder as any);
                        } else {
                            try {
                                await this.plugin.ensureTemplatesFolderExists();
                                new Notice(`Templates folder created at: ${templatesPath}`);
                            } catch (error) {
                                new Notice('Failed to create templates folder.');
                            }
                        }
                    });
            });

        const templatesPath = normalizePath(this.plugin.settings.templatesFolder);
        const pathInfo = containerEl.createEl('div', {
            cls: 'templates-path-info'
        });

        pathInfo.createEl('div', { text: 'Templates folder location:' });

        pathInfo.createEl('code', {
            text: `${templatesPath} (relative to your vault root)`
        });

        containerEl.createEl('p', {
            text: 'Use the "Manage templates" command to create, edit, and delete templates.',
            cls: 'usage-hint'
        });

        const usageSection = containerEl.createEl('div', {
            cls: 'usage-section'
        });

        usageSection.createEl('h3', {
            text: 'How to Use Quick Templates'
        });

        // Create cards for each usage item
        const usageCards = usageSection.createEl('div', {
            cls: 'usage-cards'
        });

        // Card 1: Save selection as template
        const saveCard = usageCards.createEl('div', {
            cls: 'usage-card'
        });

        saveCard.createEl('h4', {
            text: '📝 Save selection as template'
        });

        saveCard.createEl('p', {
            text: 'Select text in your note and use:'
        });

        const saveSteps = saveCard.createEl('ul');

        saveSteps.createEl('li', {
            text: 'Command palette (Ctrl/Cmd+P) → "Save selection as template"'
        });

        saveSteps.createEl('li', {
            text: 'Right-click menu → "Save selection as template"'
        });

        // Card 2: Insert template
        const insertCard = usageCards.createEl('div', {
            cls: 'usage-card'
        });

        insertCard.createEl('h4', {
            text: '📋 Insert template'
        });

        insertCard.createEl('p', {
            text: 'Insert your saved templates using:'
        });

        const insertSteps = insertCard.createEl('ul');

        insertSteps.createEl('li', {
            text: 'Command palette → "Insert template"'
        });

        insertSteps.createEl('li', {
            text: 'Right-click menu → "Insert template"'
        });

        insertSteps.createEl('li', {
            text: 'Type !! followed by your template name (autocomplete will appear)'
        });

        // Card 3: Manage templates
        const manageCard = usageCards.createEl('div', {
            cls: 'usage-card'
        });

        manageCard.createEl('h4', {
            text: '⚙️ Manage templates'
        });

        manageCard.createEl('p', {
            text: 'Edit or delete your templates:'
        });

        const manageSteps = manageCard.createEl('ul');

        manageSteps.createEl('li', {
            text: 'Command palette → "Manage templates"'
        });

        const quickAccessButton = usageSection.createEl('button', {
            text: 'Open Template Manager',
            cls: 'mod-cta quick-access-button'
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