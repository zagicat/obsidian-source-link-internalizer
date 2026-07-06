import { App, Modal, Notice, Plugin, TFile } from "obsidian";

interface ProposedChange {
  file: TFile;
  originalMatch: string;
  linkText: string;
  url: string;
  targetFile: TFile;
  replacement: string;
}

export default class SourceLinkInternalizerPlugin extends Plugin {
  async onload() {
    this.addCommand({
      id: "internalize-links",
      name: "Internalize external links to local sources",
      callback: () => this.runInternalization(),
    });
  }

  async runInternalization() {
    new Notice("Scanning vault for source URLs...");

    // Step 1: Build source index
    const sourceIndex = await this.buildSourceIndex();

    if (sourceIndex.size === 0) {
      new Notice("No files with 'source' frontmatter found.");
      return;
    }

    // Step 2: Find all links that match sources
    const changes = await this.findMatchingLinks(sourceIndex);

    if (changes.length === 0) {
      new Notice("No external links found that match known sources.");
      return;
    }

    // Step 3: Show preview modal
    new PreviewModal(this.app, changes, async (approved) => {
      if (approved) {
        await this.applyChanges(changes);
      }
    }).open();
  }

  async buildSourceIndex(): Promise<Map<string, TFile>> {
    const sourceIndex = new Map<string, TFile>();
    const files = this.app.vault.getMarkdownFiles();

    for (const file of files) {
      const cache = this.app.metadataCache.getFileCache(file);
      if (!cache?.frontmatter?.source) continue;

      const sources = cache.frontmatter.source;

      // Handle both string and array values
      if (typeof sources === "string") {
        sourceIndex.set(sources, file);
      } else if (Array.isArray(sources)) {
        for (const src of sources) {
          if (typeof src === "string") {
            sourceIndex.set(src, file);
          }
        }
      }
    }

    return sourceIndex;
  }

  async findMatchingLinks(sourceIndex: Map<string, TFile>): Promise<ProposedChange[]> {
    const changes: ProposedChange[] = [];
    const files = this.app.vault.getMarkdownFiles();

    // Regex for markdown links: [text](url)
    const linkRegex = /\[([^\]]*)\]\(([^)]+)\)/g;

    for (const file of files) {
      const content = await this.app.vault.read(file);
      let match;

      while ((match = linkRegex.exec(content)) !== null) {
        const [fullMatch, linkText, url] = match;

        // Check if this URL is in our source index
        const targetFile = sourceIndex.get(url);
        if (targetFile && targetFile.path !== file.path) {
          // Get filename without extension for wikilink
          const targetName = targetFile.basename;
          // Only include display text when it differs from the document name
          const replacement =
            linkText === targetName
              ? `[[${targetName}]]`
              : `[[${targetName}|${linkText}]]`;

          changes.push({
            file,
            originalMatch: fullMatch,
            linkText,
            url,
            targetFile,
            replacement,
          });
        }
      }
    }

    return changes;
  }

  async applyChanges(changes: ProposedChange[]) {
    // Group changes by file
    const changesByFile = new Map<string, ProposedChange[]>();

    for (const change of changes) {
      const path = change.file.path;
      if (!changesByFile.has(path)) {
        changesByFile.set(path, []);
      }
      changesByFile.get(path)!.push(change);
    }

    const modifiedFiles: string[] = [];
    const errors: string[] = [];

    for (const [path, fileChanges] of changesByFile) {
      try {
        const file = fileChanges[0].file;
        let content = await this.app.vault.read(file);

        // Apply all changes for this file
        for (const change of fileChanges) {
          content = content.replace(change.originalMatch, change.replacement);
        }

        await this.app.vault.modify(file, content);
        modifiedFiles.push(`${path} (${fileChanges.length} link${fileChanges.length > 1 ? 's' : ''})`);

        // Log to console for debugging
        console.log(`[Source Link Internalizer] Modified: ${path}`);
        for (const change of fileChanges) {
          console.log(`  - ${change.originalMatch} → ${change.replacement}`);
        }
      } catch (e) {
        console.error(`[Source Link Internalizer] Error processing ${path}:`, e);
        errors.push(path);
      }
    }

    // Show results modal
    console.log(`[Source Link Internalizer] Opening results modal: ${modifiedFiles.length} modified, ${errors.length} errors`);
    const resultsModal = new ResultsModal(this.app, modifiedFiles, errors);
    resultsModal.open();
  }
}

class PreviewModal extends Modal {
  private changes: ProposedChange[];
  private onResult: (approved: boolean) => void;

  constructor(app: App, changes: ProposedChange[], onResult: (approved: boolean) => void) {
    super(app);
    this.changes = changes;
    this.onResult = onResult;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("source-link-internalizer-modal");

    contentEl.createEl("h2", { text: "Preview Link Changes" });
    contentEl.createEl("p", {
      text: `Found ${this.changes.length} link(s) to internalize:`,
      cls: "sli-summary"
    });

    // Group changes by file for display
    const changesByFile = new Map<string, ProposedChange[]>();
    for (const change of this.changes) {
      const path = change.file.path;
      if (!changesByFile.has(path)) {
        changesByFile.set(path, []);
      }
      changesByFile.get(path)!.push(change);
    }

    const listContainer = contentEl.createDiv({ cls: "sli-changes-list" });

    for (const [path, fileChanges] of changesByFile) {
      const fileSection = listContainer.createDiv({ cls: "sli-file-section" });
      fileSection.createEl("h4", { text: path });

      for (const change of fileChanges) {
        const changeItem = fileSection.createDiv({ cls: "sli-change-item" });

        const beforeDiv = changeItem.createDiv({ cls: "sli-before" });
        beforeDiv.createSpan({ text: "Before: ", cls: "sli-label" });
        beforeDiv.createEl("code", { text: change.originalMatch });

        const afterDiv = changeItem.createDiv({ cls: "sli-after" });
        afterDiv.createSpan({ text: "After: ", cls: "sli-label" });
        afterDiv.createEl("code", { text: change.replacement });

        const targetDiv = changeItem.createDiv({ cls: "sli-target" });
        targetDiv.createSpan({ text: "Links to: ", cls: "sli-label" });
        targetDiv.createSpan({ text: change.targetFile.path });
      }
    }

    // Buttons
    const buttonContainer = contentEl.createDiv({ cls: "sli-buttons" });

    const applyBtn = buttonContainer.createEl("button", {
      text: "Apply All",
      cls: "mod-cta"
    });
    applyBtn.addEventListener("click", () => {
      this.close();
      this.onResult(true);
    });

    const cancelBtn = buttonContainer.createEl("button", { text: "Cancel" });
    cancelBtn.addEventListener("click", () => {
      this.close();
      this.onResult(false);
    });
  }

  onClose() {
    const { contentEl } = this;
    contentEl.empty();
  }
}

class ResultsModal extends Modal {
  private modifiedFiles: string[];
  private errors: string[];

  constructor(app: App, modifiedFiles: string[], errors: string[]) {
    super(app);
    this.modifiedFiles = modifiedFiles;
    this.errors = errors;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("source-link-internalizer-modal");

    contentEl.createEl("h2", { text: "Links Internalized" });

    if (this.modifiedFiles.length === 0 && this.errors.length === 0) {
      contentEl.createEl("p", { text: "No changes were made." });
    }

    if (this.modifiedFiles.length > 0) {
      contentEl.createEl("h4", { text: "Modified files:" });
      const list = contentEl.createEl("ul", { cls: "sli-results-list" });
      for (const file of this.modifiedFiles) {
        list.createEl("li", { text: file });
      }
    }

    if (this.errors.length > 0) {
      contentEl.createEl("h4", { text: "Errors:", cls: "sli-error-header" });
      const errorList = contentEl.createEl("ul", { cls: "sli-results-list sli-error-list" });
      for (const file of this.errors) {
        errorList.createEl("li", { text: file });
      }
    }

    const buttonContainer = contentEl.createDiv({ cls: "sli-buttons" });
    const closeBtn = buttonContainer.createEl("button", {
      text: "Close",
      cls: "mod-cta"
    });
    closeBtn.addEventListener("click", () => this.close());
  }

  onClose() {
    const { contentEl } = this;
    contentEl.empty();
  }
}
