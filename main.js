const { Plugin, Notice, PluginSettingTab, Setting } = require("obsidian");

const DROPDOWN_POSITIONS = {
  left: "Left",
  center: "Center",
  right: "Right"
};

const DEFAULT_SETTINGS = {
  fileSnippets: {},
  dropdownPosition: "right",
  dropdownVisible: true
};

/**
 * Base Scoped Snippets
 *
 * Now supports both .base and .md files.
 *
 * Design goals for this rewrite:
 * - Do not observe the whole Obsidian DOM. That was the main source of flicker/freezes.
 * - Do not rebuild the <select> while the user is interacting with it.
 * - Do not refresh every leaf after a dropdown change. Apply only the changed data attribute.
 * - Keep native Obsidian CSS snippets disabled; this plugin reads the CSS and scopes it itself.
 */
class BaseScopedSnippetsPlugin extends Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.normalizeSettings();

    this.snippetList = [];
    this.snippetListKey = "";
    this.refreshTimer = null;
    this.cssBuildSerial = 0;
    this.snippetIds = new Map();

    this.runtimeStyleEl = document.createElement("style");
    this.runtimeStyleEl.id = "base-scoped-snippets-runtime-css";
    document.head.appendChild(this.runtimeStyleEl);

    await this.reloadSnippetList();
    await this.rebuildScopedCss();

    this.addSettingTab(new BaseScopedSnippetsSettingTab(this.app, this));

    this.addCommand({
      id: "reload-base-scoped-snippets",
      name: "Reload scoped CSS snippets",
      callback: async () => {
        await this.reloadSnippetList();
        await this.rebuildScopedCss();
        this.refreshAllLeaves();
        new Notice("Scoped CSS snippets reloaded.");
      }
    });

    this.registerEvent(this.app.workspace.on("layout-change", () => this.scheduleRefresh()));
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.scheduleRefresh()));
    this.registerEvent(this.app.workspace.on("file-open", () => this.scheduleRefresh()));

    this.registerEvent(this.app.vault.on("rename", async (file, oldPath) => {
      await this.handleVaultRename(file, oldPath);
    }));

    this.registerEvent(this.app.vault.on("delete", async (file) => {
      await this.handleVaultDelete(file);
    }));

    this.registerEvent(this.app.vault.on("create", async (file) => {
      await this.handlePossibleSnippetChange(file);
    }));

    this.registerEvent(this.app.vault.on("modify", async (file) => {
      await this.handlePossibleSnippetChange(file);
    }));

    if (this.app.workspace.onLayoutReady) {
      this.app.workspace.onLayoutReady(() => this.scheduleRefresh(0));
    } else {
      this.scheduleRefresh(0);
    }

    this.register(() => {
      if (this.refreshTimer) {
        window.clearTimeout(this.refreshTimer);
        this.refreshTimer = null;
      }
      this.removeAllControlsAndAttributes();
      if (this.runtimeStyleEl) {
        this.runtimeStyleEl.remove();
        this.runtimeStyleEl = null;
      }
    });
  }

  normalizeSettings() {
    if (!this.settings || typeof this.settings !== "object") {
      this.settings = Object.assign({}, DEFAULT_SETTINGS);
    }

    if (!this.settings.fileSnippets || typeof this.settings.fileSnippets !== "object" || Array.isArray(this.settings.fileSnippets)) {
      this.settings.fileSnippets = {};
    }

    if (!Object.prototype.hasOwnProperty.call(DROPDOWN_POSITIONS, this.settings.dropdownPosition)) {
      this.settings.dropdownPosition = DEFAULT_SETTINGS.dropdownPosition;
    }

    if (typeof this.settings.dropdownVisible !== "boolean") {
      this.settings.dropdownVisible = DEFAULT_SETTINGS.dropdownVisible;
    }
  }

  async saveSettings() {
    this.normalizeSettings();
    await this.saveData(this.settings);
  }

  async updateInterfaceSettings(nextSettings) {
    this.settings = Object.assign({}, this.settings, nextSettings || {});
    this.normalizeSettings();
    await this.saveSettings();
    this.refreshAllLeaves();
  }

  getDropdownPosition() {
    this.normalizeSettings();
    return this.settings.dropdownPosition;
  }

  isDropdownVisible() {
    this.normalizeSettings();
    return this.settings.dropdownVisible;
  }

  getSnippetsFolderPath() {
    const configDir = this.app.vault.configDir || ".obsidian";
    return `${configDir}/snippets`;
  }

  scheduleRefresh(delay = 80) {
    if (this.refreshTimer) return;
    this.refreshTimer = window.setTimeout(async () => {
      this.refreshTimer = null;
      await this.reloadSnippetList();
      this.refreshAllLeaves();
    }, delay);
  }

  async handleVaultRename(file, oldPath) {
    const newPath = file && file.path;

    if (oldPath && Object.prototype.hasOwnProperty.call(this.settings.fileSnippets, oldPath)) {
      if (newPath) {
        this.settings.fileSnippets[newPath] = this.settings.fileSnippets[oldPath];
      }
      delete this.settings.fileSnippets[oldPath];
      await this.saveSettings();
      await this.rebuildScopedCss();
    }

    if (this.isSnippetCssPath(oldPath) || this.isSnippetCssPath(newPath)) {
      await this.reloadSnippetList();
      await this.rebuildScopedCss();
    }

    this.refreshAllLeaves();
  }

  async handleVaultDelete(file) {
    const path = file && file.path;

    if (path && Object.prototype.hasOwnProperty.call(this.settings.fileSnippets, path)) {
      delete this.settings.fileSnippets[path];
      await this.saveSettings();
      await this.rebuildScopedCss();
    }

    if (this.isSnippetCssPath(path)) {
      await this.reloadSnippetList();
      await this.rebuildScopedCss();
    }

    this.refreshAllLeaves();
  }

  async handlePossibleSnippetChange(file) {
    if (!this.isSnippetCssPath(file && file.path)) return;
    await this.reloadSnippetList();
    await this.rebuildScopedCss();
    this.refreshAllLeaves();
  }

  isSnippetCssPath(path) {
    if (!path || typeof path !== "string") return false;
    const snippetsFolder = this.getSnippetsFolderPath();
    return path.startsWith(`${snippetsFolder}/`) && path.toLowerCase().endsWith(".css");
  }

  async reloadSnippetList() {
    const snippetsFolder = this.getSnippetsFolderPath();
    let snippets = [];

    try {
      const listed = await this.app.vault.adapter.list(snippetsFolder);
      snippets = (listed.files || [])
        .filter((path) => path.toLowerCase().endsWith(".css"))
        .map((path) => path.substring(snippetsFolder.length + 1))
        .filter((name) => name && !name.includes("/"))
        .sort((a, b) => a.localeCompare(b));
    } catch (error) {
      snippets = [];
    }

    const key = snippets.join("\u0000");
    const changed = key !== this.snippetListKey;
    this.snippetList = snippets;
    this.snippetListKey = key;
    return changed;
  }

  refreshAllLeaves() {
    this.app.workspace.iterateAllLeaves((leaf) => {
      this.refreshLeaf(leaf);
    });
  }

  getSupportedFileFromLeaf(leaf) {
    const view = leaf && leaf.view;
    const file = view && view.file;
    if (!file || !file.path) return null;

    const extension = String(file.extension || "").toLowerCase();
    const path = String(file.path || "").toLowerCase();

    if (extension === "base" || extension === "md") return file;
    if (path.endsWith(".base") || path.endsWith(".md")) return file;
    return null;
  }

  refreshLeaf(leaf) {
    const view = leaf && leaf.view;
    const containerEl = view && view.containerEl;
    if (!containerEl) return;

    const file = this.getSupportedFileFromLeaf(leaf);

    if (!file) {
      this.removeControlsFromContainer(containerEl);
      this.clearScopeAttributes(containerEl);
      return;
    }

    const selected = this.settings.fileSnippets[file.path] || "";
    this.applyScopeAttributes(containerEl, file.path, selected);

    if (!this.isDropdownVisible()) {
      this.removeControlsFromContainer(containerEl);
      return;
    }

    const headerEl = this.getHeaderEl(view, containerEl);
    if (!headerEl) return;

    const picker = this.ensurePicker(headerEl, containerEl);
    this.placePicker(headerEl, picker);

    const select = picker.querySelector("select");
    if (!select) return;

    select.dataset.scopedFilePath = file.path;
    this.populateSelectIfNeeded(select, selected);
  }

  getHeaderEl(view, containerEl) {
    if (view && view.headerEl) return view.headerEl;
    return containerEl.querySelector(".view-header");
  }

  ensurePicker(headerEl, containerEl) {
    const existing = Array.from(headerEl.querySelectorAll(".base-scoped-snippets-picker"));
    const first = existing.shift();
    for (const duplicate of existing) duplicate.remove();

    if (first) return first;

    const picker = document.createElement("div");
    picker.className = "base-scoped-snippets-picker";
    picker.setAttribute("aria-label", "Scoped CSS snippet");

    const label = document.createElement("span");
    label.className = "base-scoped-snippets-picker-label";
    label.textContent = "CSS";
    picker.appendChild(label);

    const selectWrap = document.createElement("div");
    selectWrap.className = "base-scoped-snippets-select-wrap";

    const select = document.createElement("select");
    select.className = "dropdown base-scoped-snippets-select";
    select.setAttribute("aria-label", "CSS snippet for this file");

    // Stop only propagation, not default behavior. This prevents Obsidian's header
    // click handlers from reacting while still allowing the native dropdown to open.
    for (const eventName of ["pointerdown", "mousedown", "click", "keydown"]) {
      select.addEventListener(eventName, (event) => event.stopPropagation());
    }

    select.addEventListener("change", async (event) => {
      event.stopPropagation();
      await this.handleSelectChange(select, containerEl);
    });

    selectWrap.appendChild(select);
    picker.appendChild(selectWrap);

    this.placePicker(headerEl, picker);

    return picker;
  }

  placePicker(headerEl, picker) {
    if (!headerEl || !picker) return;

    const position = this.getDropdownPosition();
    headerEl.classList.add("base-scoped-snippets-header");

    picker.dataset.position = position;
    picker.classList.toggle("base-scoped-snippets-picker-left", position === "left");
    picker.classList.toggle("base-scoped-snippets-picker-center", position === "center");
    picker.classList.toggle("base-scoped-snippets-picker-right", position === "right");

    if (position === "left") {
      const titleContainer = headerEl.querySelector(".view-header-title-container");
      if (titleContainer && titleContainer.parentElement === headerEl) {
        if (titleContainer.previousSibling !== picker) {
          headerEl.insertBefore(picker, titleContainer);
        }
      } else if (headerEl.firstChild !== picker) {
        headerEl.insertBefore(picker, headerEl.firstChild);
      }
      return;
    }

    const actionsEl = headerEl.querySelector(".view-actions");
    if (actionsEl && actionsEl.parentElement) {
      if (actionsEl.previousSibling !== picker) {
        actionsEl.parentElement.insertBefore(picker, actionsEl);
      }
    } else if (picker.parentElement !== headerEl || picker.nextSibling) {
      headerEl.appendChild(picker);
    }
  }

  populateSelectIfNeeded(select, selected) {
    const snippets = this.snippetList || [];
    const missingSelected = selected && !snippets.includes(selected) ? selected : "";
    const optionsKey = `${snippets.join("\u0000")}\u0001${selected}`;

    // Do not rebuild options while the user is opening or navigating the native select.
    // This is the key fix for the flicker/freeze loop.
    if (document.activeElement === select && select.dataset.optionsKey) {
      return;
    }

    if (select.dataset.optionsKey === optionsKey) {
      if (select.value !== selected) select.value = selected;
      select.disabled = snippets.length === 0 && !missingSelected;
      this.updateSelectTitle(select);
      return;
    }

    const fragment = document.createDocumentFragment();

    const none = document.createElement("option");
    none.value = "";
    none.textContent = "— none —";
    fragment.appendChild(none);

    for (const snippet of snippets) {
      const option = document.createElement("option");
      option.value = snippet;
      option.textContent = snippet.replace(/\.css$/i, "");
      option.title = snippet.replace(/\.css$/i, "");
      fragment.appendChild(option);
    }

    if (missingSelected) {
      const missing = document.createElement("option");
      missing.value = missingSelected;
      missing.textContent = `⚠ missing file: ${missingSelected.replace(/\.css$/i, "")}`;
      missing.title = missing.textContent;
      fragment.appendChild(missing);
    }

    select.replaceChildren(fragment);
    select.value = selected || "";
    select.disabled = snippets.length === 0 && !missingSelected;
    select.dataset.optionsKey = optionsKey;
    this.updateSelectTitle(select);
  }

  updateSelectTitle(select) {
    const selectedOption = select.selectedOptions && select.selectedOptions[0];
    select.title = selectedOption ? (selectedOption.textContent || "") : "";
  }

  async handleSelectChange(select, containerEl) {
    const scopedFilePath = select.dataset.scopedFilePath || select.dataset.basePath;
    if (!scopedFilePath) return;

    const value = select.value || "";
    this.updateSelectTitle(select);
    const previous = this.settings.fileSnippets[scopedFilePath] || "";
    if (previous === value) return;

    if (value) {
      this.settings.fileSnippets[scopedFilePath] = value;
    } else {
      delete this.settings.fileSnippets[scopedFilePath];
    }

    await this.saveSettings();

    // Apply immediately without scheduling a workspace-wide DOM refresh.
    this.applySelectionToOpenSupportedViews(scopedFilePath, value);
    await this.rebuildScopedCss();
  }

  applySelectionToOpenSupportedViews(scopedFilePath, selected) {
    this.app.workspace.iterateAllLeaves((leaf) => {
      const file = this.getSupportedFileFromLeaf(leaf);
      const view = leaf && leaf.view;
      const containerEl = view && view.containerEl;
      if (!file || !containerEl || file.path !== scopedFilePath) return;

      this.applyScopeAttributes(containerEl, scopedFilePath, selected);

      const picker = containerEl.querySelector(".base-scoped-snippets-picker");
      const select = picker && picker.querySelector("select");
      if (select && document.activeElement !== select) {
        select.value = selected || "";
      }
    });
  }

  applyScopeAttributes(containerEl, scopedFilePath, selected) {
    const filePath = scopedFilePath || "";
    containerEl.setAttribute("data-base-scoped-file", filePath);
    containerEl.setAttribute("data-bss-scoped-file", filePath);

    if (selected) {
      const snippetId = this.getSnippetId(selected);
      containerEl.setAttribute("data-base-scoped-snippet", snippetId);
      containerEl.setAttribute("data-bss-scoped-snippet", snippetId);
    } else {
      containerEl.removeAttribute("data-base-scoped-snippet");
      containerEl.removeAttribute("data-bss-scoped-snippet");
    }
  }

  clearScopeAttributes(containerEl) {
    containerEl.removeAttribute("data-base-scoped-file");
    containerEl.removeAttribute("data-base-scoped-snippet");
    containerEl.removeAttribute("data-bss-scoped-file");
    containerEl.removeAttribute("data-bss-scoped-snippet");
  }

  removeControlsFromContainer(containerEl) {
    for (const picker of Array.from(containerEl.querySelectorAll(".base-scoped-snippets-picker"))) {
      picker.remove();
    }

    for (const header of Array.from(containerEl.querySelectorAll(".base-scoped-snippets-header"))) {
      header.classList.remove("base-scoped-snippets-header");
    }
  }

  removeAllControlsAndAttributes() {
    this.app.workspace.iterateAllLeaves((leaf) => {
      const view = leaf && leaf.view;
      const containerEl = view && view.containerEl;
      if (!containerEl) return;
      this.removeControlsFromContainer(containerEl);
      this.clearScopeAttributes(containerEl);
    });
  }

  async rebuildScopedCss() {
    const serial = ++this.cssBuildSerial;
    const selectedSnippets = Array.from(
      new Set(Object.values(this.settings.fileSnippets || {}).filter(Boolean))
    );

    const snippetsFolder = this.getSnippetsFolderPath();
    const blocks = [];

    for (const snippet of selectedSnippets) {
      const snippetPath = `${snippetsFolder}/${snippet}`;

      try {
        const css = await this.app.vault.adapter.read(snippetPath);
        const id = this.getSnippetId(snippet);
        const scope = `[data-bss-scoped-snippet="${this.escapeAttributeForSelector(id)}"]`;
        const scopedCss = this.scopeCss(css, scope);
        blocks.push(`\n/* Scoped CSS Snippet: ${snippet} */\n${scopedCss}\n`);
      } catch (error) {
        console.warn(`Scoped CSS Snippets: could not read ${snippetPath}`, error);
      }
    }

    if (serial !== this.cssBuildSerial) return;

    const nextText = blocks.join("\n");
    if (this.runtimeStyleEl && this.runtimeStyleEl.textContent !== nextText) {
      this.runtimeStyleEl.textContent = nextText;
    }
  }

  getSnippetId(snippet) {
    if (this.snippetIds.has(snippet)) return this.snippetIds.get(snippet);

    let hash = 0;
    for (let i = 0; i < snippet.length; i += 1) {
      hash = ((hash << 5) - hash + snippet.charCodeAt(i)) | 0;
    }

    const safeName = snippet
      .toLowerCase()
      .replace(/\.css$/i, "")
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "snippet";

    const id = `${safeName}-${Math.abs(hash)}`;
    this.snippetIds.set(snippet, id);
    return id;
  }

  escapeAttributeForSelector(value) {
    return String(value).replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
  }

  scopeCss(css, scope) {
    const cleaned = String(css || "")
      .replace(/\/\*# sourceMappingURL=.*?\*\//gs, "")
      .replace(/@charset\s+[^;]+;/gi, "")
      .replace(/@import\s+(?:url\([^)]*\)|"[^"]*"|'[^']*')[^;]*;/gi, "/* Scoped CSS Snippets: @import omitted because imported CSS cannot be scoped safely. */");

    return this.scopeCssBlock(cleaned, scope, false);
  }

  stripCssComments(text) {
    return String(text || "").replace(/\/\*[\s\S]*?\*\//g, "");
  }

  scopeCssBlock(css, scope, inKeyframes) {
    let output = "";
    let index = 0;

    while (index < css.length) {
      const delimiter = this.findNextTopLevelDelimiter(css, index);

      if (!delimiter) {
        output += css.slice(index);
        break;
      }

      const rawPrelude = css.slice(index, delimiter.index);
      const prelude = this.stripCssComments(rawPrelude).trim();

      if (delimiter.type === "semicolon") {
        // At-rules without blocks, e.g. @layer name; or @namespace ...;
        // They are safe to preserve. @import was already removed above.
        output += css.slice(index, delimiter.index + 1);
        index = delimiter.index + 1;
        continue;
      }

      const openIndex = delimiter.index;
      const closeIndex = this.findMatchingBrace(css, openIndex);

      if (closeIndex === -1) {
        output += css.slice(index);
        break;
      }

      const body = css.slice(openIndex + 1, closeIndex);
      output += this.scopeRule(prelude, body, scope, inKeyframes);
      index = closeIndex + 1;
    }

    return output;
  }

  scopeRule(prelude, body, scope, inKeyframes) {
    if (!prelude) return `{${body}}`;

    const lower = prelude.toLowerCase();

    if (
      inKeyframes ||
      lower.startsWith("@keyframes") ||
      lower.startsWith("@-webkit-keyframes")
    ) {
      return `${prelude} {${body}}`;
    }

    if (
      lower.startsWith("@font-face") ||
      lower.startsWith("@property") ||
      lower.startsWith("@page") ||
      lower.startsWith("@counter-style")
    ) {
      return `${prelude} {${body}}`;
    }

    if (prelude.startsWith("@")) {
      return `${prelude} {${this.scopeCssBlock(body, scope, false)}}`;
    }

    return `${this.prefixSelectorList(prelude, scope)} {${body}}`;
  }

  findNextTopLevelDelimiter(css, startIndex) {
    let quote = null;
    let comment = false;
    let parenDepth = 0;
    let bracketDepth = 0;

    for (let i = startIndex; i < css.length; i += 1) {
      const char = css[i];
      const next = css[i + 1];

      if (comment) {
        if (char === "*" && next === "/") {
          comment = false;
          i += 1;
        }
        continue;
      }

      if (quote) {
        if (char === "\\") {
          i += 1;
        } else if (char === quote) {
          quote = null;
        }
        continue;
      }

      if (char === "/" && next === "*") {
        comment = true;
        i += 1;
        continue;
      }

      if (char === "\"" || char === "'") {
        quote = char;
        continue;
      }

      if (char === "(") parenDepth += 1;
      else if (char === ")" && parenDepth > 0) parenDepth -= 1;
      else if (char === "[") bracketDepth += 1;
      else if (char === "]" && bracketDepth > 0) bracketDepth -= 1;

      if (parenDepth === 0 && bracketDepth === 0) {
        if (char === "{") return { index: i, type: "brace" };
        if (char === ";") return { index: i, type: "semicolon" };
      }
    }

    return null;
  }

  findMatchingBrace(css, openIndex) {
    let depth = 0;
    let quote = null;
    let comment = false;

    for (let i = openIndex; i < css.length; i += 1) {
      const char = css[i];
      const next = css[i + 1];

      if (comment) {
        if (char === "*" && next === "/") {
          comment = false;
          i += 1;
        }
        continue;
      }

      if (quote) {
        if (char === "\\") {
          i += 1;
        } else if (char === quote) {
          quote = null;
        }
        continue;
      }

      if (char === "/" && next === "*") {
        comment = true;
        i += 1;
        continue;
      }

      if (char === "\"" || char === "'") {
        quote = char;
        continue;
      }

      if (char === "{") depth += 1;
      else if (char === "}") {
        depth -= 1;
        if (depth === 0) return i;
      }
    }

    return -1;
  }

  prefixSelectorList(selectorList, scope) {
    return this.splitSelectorList(selectorList)
      .map((selector) => this.prefixSelector(selector.trim(), scope))
      .filter(Boolean)
      .join(", ");
  }

  splitSelectorList(selectorList) {
    const result = [];
    let current = "";
    let quote = null;
    let parenDepth = 0;
    let bracketDepth = 0;

    for (let i = 0; i < selectorList.length; i += 1) {
      const char = selectorList[i];

      if (quote) {
        current += char;
        if (char === "\\") {
          i += 1;
          current += selectorList[i] || "";
        } else if (char === quote) {
          quote = null;
        }
        continue;
      }

      if (char === "\"" || char === "'") {
        quote = char;
        current += char;
        continue;
      }

      if (char === "(") parenDepth += 1;
      else if (char === ")" && parenDepth > 0) parenDepth -= 1;
      else if (char === "[") bracketDepth += 1;
      else if (char === "]" && bracketDepth > 0) bracketDepth -= 1;

      if (char === "," && parenDepth === 0 && bracketDepth === 0) {
        result.push(current);
        current = "";
      } else {
        current += char;
      }
    }

    if (current.trim()) result.push(current);
    return result;
  }

  prefixSelector(selector, scope) {
    if (!selector) return selector;
    if (selector.startsWith(scope)) return selector;

    const htmlBody = selector.match(/^html\s+body(.*)$/i);
    if (htmlBody) {
      const rest = (htmlBody[1] || "").trim();
      return rest ? `html body ${scope} ${rest}` : `html body ${scope}`;
    }

    const bodyLike = selector.match(/^(body|html|:root)([^\s>+~]*)?(.*)$/i);
    if (bodyLike) {
      const root = bodyLike[1] + (bodyLike[2] || "");
      const rest = (bodyLike[3] || "").trim();
      return rest ? `${root} ${scope} ${rest}` : `${root} ${scope}`;
    }

    const themeLike = selector.match(/^(\.theme-dark|\.theme-light)([^\s>+~]*)?(.*)$/i);
    if (themeLike) {
      const root = themeLike[1] + (themeLike[2] || "");
      const rest = (themeLike[3] || "").trim();
      return rest ? `${root} ${scope} ${rest}` : `${root} ${scope}`;
    }

    const descendantSelector = `${scope} ${selector}`;

    // Some snippets target Obsidian's view container itself, for example:
    // .workspace-leaf-content[data-type="base"] .bases-view { ... }
    // .workspace-leaf-content[data-type="markdown"] .markdown-preview-view { ... }
    // Because this plugin places the scoped data attribute on that same container,
    // include a same-element variant for class/id/attribute selectors.
    if (/^[.#\[]/.test(selector)) {
      return `${descendantSelector}, ${scope}${selector}`;
    }

    return descendantSelector;
  }
}

class BaseScopedSnippetsSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Base Scoped Snippets" });

    new Setting(containerEl)
      .setName("Show dropdown")
      .setDesc("Show or hide the CSS snippet picker in .base and .md file headers. Hiding the dropdown does not disable already selected snippets.")
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.isDropdownVisible())
          .onChange(async (value) => {
            await this.plugin.updateInterfaceSettings({ dropdownVisible: value });
          });
      });

    new Setting(containerEl)
      .setName("Dropdown position")
      .setDesc("Choose where the dropdown appears in supported file headers.")
      .addDropdown((dropdown) => {
        for (const [value, label] of Object.entries(DROPDOWN_POSITIONS)) {
          dropdown.addOption(value, label);
        }

        dropdown
          .setValue(this.plugin.getDropdownPosition())
          .onChange(async (value) => {
            await this.plugin.updateInterfaceSettings({ dropdownPosition: value });
          });
      });

    const info = containerEl.createDiv({ cls: "base-scoped-snippets-settings-info" });
    info.createEl("p", {
      text: "The plugin reads CSS files from the .obsidian/snippets folder. Snippets that should apply only to specific .base or .md files should remain disabled in Obsidian's native Appearance settings."
    });
  }
}

module.exports = BaseScopedSnippetsPlugin;
