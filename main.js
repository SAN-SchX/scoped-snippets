const { Plugin, Notice, Modal, ItemView, setIcon, PluginSettingTab, Setting } = require("obsidian");

const SNIPPET_EDITOR_VIEW_TYPE = "scoped-snippets-editor";

const DROPDOWN_POSITIONS = {
  left: "Left",
  right: "Right"
};

const EDITOR_COLOR_FIELDS = {
  background: "Editor background",
  foreground: "Default text",
  comment: "Comments",
  selector: "Selectors",
  property: "Properties",
  value: "Values",
  number: "Numbers & colors",
  string: "Strings",
  atrule: "At-rules",
  function: "Functions",
  punctuation: "Punctuation"
};

const EDITOR_COLOR_PRESETS = {
  midnight: {
    name: "Midnight",
    colors: {
      background: "#1e1e1e",
      foreground: "#d4d4d4",
      comment: "#6a9955",
      selector: "#d7ba7d",
      property: "#9cdcfe",
      value: "#ce9178",
      number: "#b5cea8",
      string: "#ce9178",
      atrule: "#c586c0",
      function: "#dcdcaa",
      punctuation: "#d4d4d4"
    }
  },
  daylight: {
    name: "Daylight",
    colors: {
      background: "#ffffff",
      foreground: "#000000",
      comment: "#008000",
      selector: "#800000",
      property: "#e50000",
      value: "#0451a5",
      number: "#098658",
      string: "#a31515",
      atrule: "#af00db",
      function: "#795e26",
      punctuation: "#000000"
    }
  },
  neon: {
    name: "Neon",
    colors: {
      background: "#272822",
      foreground: "#f8f8f2",
      comment: "#75715e",
      selector: "#a6e22e",
      property: "#66d9ef",
      value: "#fd971f",
      number: "#ae81ff",
      string: "#e6db74",
      atrule: "#f92672",
      function: "#a6e22e",
      punctuation: "#f8f8f2"
    }
  },
  "violet-night": {
    name: "Violet Night",
    colors: {
      background: "#282a36",
      foreground: "#f8f8f2",
      comment: "#6272a4",
      selector: "#50fa7b",
      property: "#8be9fd",
      value: "#f8f8f2",
      number: "#bd93f9",
      string: "#f1fa8c",
      atrule: "#ff79c6",
      function: "#50fa7b",
      punctuation: "#f8f8f2"
    }
  }
};

const LEGACY_PRESET_KEYS = {
  "vscode-dark": "midnight",
  "vscode-light": "daylight",
  monokai: "neon",
  dracula: "violet-night"
};

const DEFAULT_SETTINGS = {
  fileSnippets: {},
  dropdownPosition: "right",
  dropdownVisible: true,
  editorColorPreset: "midnight",
  editorColors: Object.assign({}, EDITOR_COLOR_PRESETS.midnight.colors),
  editorSidebarWidth: 200,
  editorDrafts: {}
};

class ScopedSnippetsPlugin extends Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.normalizeSettings();

    this.snippetList = [];
    this.snippetListKey = "";
    this.refreshTimer = null;
    this.cssBuildSerial = 0;
    this.snippetIds = new Map();
    this.activePopup = null;

    this.runtimeStyleEl = document.createElement("style");
    this.runtimeStyleEl.id = "scoped-snippets-runtime-css";
    document.head.appendChild(this.runtimeStyleEl);

    await this.reloadSnippetList();
    await this.rebuildScopedCss();

    this.addSettingTab(new ScopedSnippetsSettingTab(this.app, this));

    this.addCommand({
      id: "reload-scoped-snippets",
      name: "Reload scoped CSS snippets",
      callback: async () => {
        await this.refreshAfterSnippetChange();
        new Notice("Scoped CSS snippets reloaded.");
      }
    });

    this.registerView(SNIPPET_EDITOR_VIEW_TYPE, (leaf) => new SnippetEditorView(leaf, this));

    this.addRibbonIcon("file-heart", "Edit CSS snippets", () => {
      this.activateSnippetEditorView();
    });

    this.addCommand({
      id: "open-snippet-editor",
      name: "Edit CSS snippets",
      callback: () => {
        this.activateSnippetEditorView();
      }
    });

    this.addCommand({
      id: "save-active-snippet",
      name: "Save active CSS snippet",
      checkCallback: (checking) => {
        const view = this.app.workspace.getActiveViewOfType(SnippetEditorView);
        if (!view || !view.activeSnippet) return false;
        if (!checking) view.saveActiveSnippet();
        return true;
      }
    });

    this.registerEvent(this.app.workspace.on("layout-change", () => this.scheduleRefresh()));
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => {
      this.closePopup();
      this.scheduleRefresh();
    }));
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
      this.closePopup();
      this.removeAllControlsAndAttributes();
      if (this.runtimeStyleEl) {
        this.runtimeStyleEl.remove();
        this.runtimeStyleEl = null;
      }
    });

    this.isUnloading = false;
    this.register(() => {
      this.isUnloading = true;
    });
  }

  normalizeSettings() {
    if (!this.settings || typeof this.settings !== "object") {
      this.settings = Object.assign({}, DEFAULT_SETTINGS);
    }

    if (!this.settings.fileSnippets || typeof this.settings.fileSnippets !== "object" || Array.isArray(this.settings.fileSnippets)) {
      this.settings.fileSnippets = {};
    }

    for (const key of Object.keys(this.settings.fileSnippets)) {
      const value = this.settings.fileSnippets[key];
      let list;

      if (Array.isArray(value)) {
        list = value.filter((item) => typeof item === "string" && item);
      } else if (typeof value === "string" && value) {
        list = [value];
      } else {
        list = [];
      }

      const unique = Array.from(new Set(list));
      if (unique.length) {
        this.settings.fileSnippets[key] = unique;
      } else {
        delete this.settings.fileSnippets[key];
      }
    }

    if (!Object.prototype.hasOwnProperty.call(DROPDOWN_POSITIONS, this.settings.dropdownPosition)) {
      this.settings.dropdownPosition = DEFAULT_SETTINGS.dropdownPosition;
    }

    if (typeof this.settings.dropdownVisible !== "boolean") {
      this.settings.dropdownVisible = DEFAULT_SETTINGS.dropdownVisible;
    }

    if (Object.prototype.hasOwnProperty.call(LEGACY_PRESET_KEYS, this.settings.editorColorPreset)) {
      this.settings.editorColorPreset = LEGACY_PRESET_KEYS[this.settings.editorColorPreset];
    }

    if (
      this.settings.editorColorPreset !== "custom" &&
      !Object.prototype.hasOwnProperty.call(EDITOR_COLOR_PRESETS, this.settings.editorColorPreset)
    ) {
      this.settings.editorColorPreset = DEFAULT_SETTINGS.editorColorPreset;
    }

    if (!this.settings.editorColors || typeof this.settings.editorColors !== "object" || Array.isArray(this.settings.editorColors)) {
      this.settings.editorColors = {};
    }

    const fallbackColors = EDITOR_COLOR_PRESETS[DEFAULT_SETTINGS.editorColorPreset].colors;
    const normalizedColors = {};
    for (const key of Object.keys(EDITOR_COLOR_FIELDS)) {
      const value = this.settings.editorColors[key];
      normalizedColors[key] =
        typeof value === "string" && value.trim() && value.length <= 64 ? value.trim() : fallbackColors[key];
    }
    this.settings.editorColors = normalizedColors;

    const sidebarWidth = Number(this.settings.editorSidebarWidth);
    this.settings.editorSidebarWidth = Number.isFinite(sidebarWidth)
      ? Math.min(480, Math.max(140, Math.round(sidebarWidth)))
      : DEFAULT_SETTINGS.editorSidebarWidth;

    if (!this.settings.editorDrafts || typeof this.settings.editorDrafts !== "object" || Array.isArray(this.settings.editorDrafts)) {
      this.settings.editorDrafts = {};
    }
    for (const key of Object.keys(this.settings.editorDrafts)) {
      if (typeof this.settings.editorDrafts[key] !== "string") {
        delete this.settings.editorDrafts[key];
      }
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

  getFileSnippets(path) {
    const value = this.settings.fileSnippets[path];
    if (Array.isArray(value)) return value.slice();
    if (typeof value === "string" && value) return [value];
    return [];
  }

  setFileSnippets(path, list) {
    const requested = new Set((list || []).filter(Boolean));
    const ordered = [];

    for (const snippet of this.snippetList || []) {
      if (requested.has(snippet)) {
        ordered.push(snippet);
        requested.delete(snippet);
      }
    }
    for (const snippet of requested) ordered.push(snippet);

    if (ordered.length) {
      this.settings.fileSnippets[path] = ordered;
    } else {
      delete this.settings.fileSnippets[path];
    }
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
    await this.refreshAfterSnippetChange();
  }

  async refreshAfterSnippetChange() {
    await this.reloadSnippetList();
    await this.rebuildScopedCss();
    this.refreshAllLeaves();

    for (const leaf of this.app.workspace.getLeavesOfType(SNIPPET_EDITOR_VIEW_TYPE)) {
      if (leaf.view instanceof SnippetEditorView) leaf.view.handleSnippetListChange();
    }
  }

  async activateSnippetEditorView() {
    const existing = this.app.workspace.getLeavesOfType(SNIPPET_EDITOR_VIEW_TYPE);
    if (existing.length) {
      this.app.workspace.revealLeaf(existing[0]);
      return;
    }

    const leaf = this.app.workspace.getLeaf(true);
    await leaf.setViewState({ type: SNIPPET_EDITOR_VIEW_TYPE, active: true });
    this.app.workspace.revealLeaf(leaf);
  }

  async applyEditorColorSettings(nextColors, presetKey) {
    this.settings.editorColors = Object.assign({}, this.settings.editorColors, nextColors || {});
    this.settings.editorColorPreset = presetKey;
    await this.saveSettings();

    for (const leaf of this.app.workspace.getLeavesOfType(SNIPPET_EDITOR_VIEW_TYPE)) {
      if (leaf.view instanceof SnippetEditorView) leaf.view.applyEditorColors();
    }
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

    if (this.activePopup && !this.activePopup.button.isConnected) {
      this.closePopup();
    }
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

    const selected = this.getFileSnippets(file.path);
    this.applyScopeAttributes(containerEl, file.path, selected);

    if (!this.isDropdownVisible()) {
      this.removeControlsFromContainer(containerEl);
      return;
    }

    const headerEl = this.getHeaderEl(view, containerEl);
    if (!headerEl) return;

    const picker = this.ensurePicker(headerEl, containerEl);
    this.placePicker(headerEl, picker);

    const button = picker.querySelector(".scoped-snippets-button");
    if (!button) return;

    button.dataset.scopedFilePath = file.path;
    this.updateButtonLabel(button, selected);

    if (this.activePopup && this.activePopup.button === button) {
      if (this.activePopup.filePath !== file.path) {
        this.closePopup();
      } else {
        this.syncPopupContents();
        this.positionPopup();
      }
    }
  }

  syncPopupContents() {
    const state = this.activePopup;
    if (!state) return;
    if (state.snippetListKey === this.snippetListKey) return;

    const hadFocusInside = state.panel.contains(document.activeElement);
    this.renderPopupContents(state.panel, state.filePath);

    if (hadFocusInside) {
      const firstInput = state.panel.querySelector(".scoped-snippets-popup-checkbox");
      if (firstInput) firstInput.focus();
    }
  }

  getHeaderEl(view, containerEl) {
    if (view && view.headerEl) return view.headerEl;
    return containerEl.querySelector(".view-header");
  }

  ensurePicker(headerEl, containerEl) {
    const existing = Array.from(headerEl.querySelectorAll(".scoped-snippets-picker"));
    const first = existing.shift();
    for (const duplicate of existing) duplicate.remove();

    if (first) return first;

    const picker = document.createElement("div");
    picker.className = "scoped-snippets-picker";
    picker.setAttribute("aria-label", "Scoped CSS snippets");

    const label = document.createElement("span");
    label.className = "scoped-snippets-picker-label";
    label.textContent = "CSS";
    picker.appendChild(label);

    const selectWrap = document.createElement("div");
    selectWrap.className = "scoped-snippets-select-wrap";

    const button = document.createElement("button");
    button.type = "button";
    button.className = "dropdown scoped-snippets-button";
    button.setAttribute("aria-haspopup", "listbox");
    button.setAttribute("aria-expanded", "false");
    button.setAttribute("aria-label", "CSS snippets for this file");

    const buttonLabel = document.createElement("span");
    buttonLabel.className = "scoped-snippets-button-label";
    button.appendChild(buttonLabel);

    for (const eventName of ["pointerdown", "mousedown", "keydown"]) {
      button.addEventListener(eventName, (event) => event.stopPropagation());
    }

    button.addEventListener("click", (event) => {
      event.stopPropagation();
      event.preventDefault();
      this.togglePopup(button, containerEl);
    });

    selectWrap.appendChild(button);
    picker.appendChild(selectWrap);

    this.placePicker(headerEl, picker);

    return picker;
  }

  placePicker(headerEl, picker) {
    if (!headerEl || !picker) return;

    const position = this.getDropdownPosition();
    headerEl.classList.add("scoped-snippets-header");

    picker.dataset.position = position;
    picker.classList.toggle("scoped-snippets-picker-left", position === "left");
    picker.classList.toggle("scoped-snippets-picker-right", position === "right");

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

  formatSelectionSummary(selected) {
    const clean = (selected || []).filter(Boolean);

    if (clean.length === 0) {
      return { text: "— none —", title: "No scoped snippets" };
    }

    if (clean.length === 1) {
      const name = clean[0].replace(/\.css$/i, "");
      return { text: name, title: name };
    }

    const names = clean.map((snippet) => snippet.replace(/\.css$/i, ""));
    return { text: `${clean.length} snippets`, title: names.join(", ") };
  }

  updateButtonLabel(button, selected) {
    const labelEl = button.querySelector(".scoped-snippets-button-label");
    const summary = this.formatSelectionSummary(selected);

    if (labelEl) labelEl.textContent = summary.text;
    button.title = summary.title;

    const hasSelection = (selected || []).length > 0;
    button.classList.toggle("scoped-snippets-button-empty", !hasSelection);
    button.classList.toggle("is-active", hasSelection);

    const noSnippets = (this.snippetList || []).length === 0;
    const disabled = noSnippets && !hasSelection;
    if (disabled && this.activePopup && this.activePopup.button === button) {
      this.closePopup();
    }
    button.disabled = disabled;
  }

  togglePopup(button, containerEl) {
    if (this.activePopup && this.activePopup.button === button) {
      this.closePopup();
      return;
    }
    this.openPopup(button, containerEl);
  }

  openPopup(button, containerEl) {
    this.closePopup();

    const filePath = button.dataset.scopedFilePath;
    if (!filePath) return;

    const panel = document.createElement("div");
    panel.className = "scoped-snippets-popup";
    panel.setAttribute("role", "listbox");
    panel.setAttribute("aria-multiselectable", "true");

    const state = { button, panel, filePath, containerEl };
    this.activePopup = state;

    this.renderPopupContents(panel, filePath);
    document.body.appendChild(panel);

    button.setAttribute("aria-expanded", "true");
    button.classList.add("is-open");

    this.positionPopup();

    state.onDocPointerDown = (event) => {
      if (panel.contains(event.target) || button.contains(event.target)) return;
      this.closePopup();
    };
    state.onKeyDown = (event) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        this.closePopup();
        button.focus();
      }
    };

    panel.addEventListener("keydown", (event) => {
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;

      const inputs = Array.from(panel.querySelectorAll(".scoped-snippets-popup-checkbox"));
      if (!inputs.length) return;

      const index = inputs.indexOf(document.activeElement);
      let next;
      if (event.key === "Home" || index === -1) next = 0;
      else if (event.key === "End") next = inputs.length - 1;
      else if (event.key === "ArrowDown") next = Math.min(index + 1, inputs.length - 1);
      else next = Math.max(index - 1, 0);

      event.preventDefault();
      event.stopPropagation();
      inputs[next].focus();
    });
    state.onReposition = () => {
      if (!button.isConnected) {
        this.closePopup();
        return;
      }
      this.positionPopup();
    };

    document.addEventListener("pointerdown", state.onDocPointerDown, true);
    document.addEventListener("keydown", state.onKeyDown, true);
    window.addEventListener("resize", state.onReposition, true);
    window.addEventListener("scroll", state.onReposition, true);

    const firstInput = panel.querySelector(".scoped-snippets-popup-checkbox");
    if (firstInput) firstInput.focus();
  }

  renderPopupContents(panel, filePath) {
    if (this.activePopup && this.activePopup.panel === panel) {
      this.activePopup.snippetListKey = this.snippetListKey;
    }

    const selected = this.getFileSnippets(filePath);
    const snippets = this.snippetList || [];
    const fragment = document.createDocumentFragment();

    const head = document.createElement("div");
    head.className = "scoped-snippets-popup-head";

    const title = document.createElement("span");
    title.className = "scoped-snippets-popup-title";
    title.textContent = "Scoped Snippets";
    head.appendChild(title);

    const clearBtn = document.createElement("button");
    clearBtn.type = "button";
    clearBtn.className = "scoped-snippets-popup-clear";
    clearBtn.textContent = "Clear";
    clearBtn.disabled = selected.length === 0;
    clearBtn.addEventListener("click", async (event) => {
      event.stopPropagation();
      await this.setSelectionForFile(filePath, []);
      this.renderPopupContents(panel, filePath);
    });
    head.appendChild(clearBtn);

    fragment.appendChild(head);

    const listEl = document.createElement("div");
    listEl.className = "scoped-snippets-popup-list";

    const known = new Set(snippets);
    const missing = selected.filter((snippet) => !known.has(snippet));

    if (snippets.length === 0 && missing.length === 0) {
      const empty = document.createElement("div");
      empty.className = "scoped-snippets-popup-empty";
      empty.textContent = "No CSS snippets found in the snippets folder.";
      listEl.appendChild(empty);
    } else {
      for (const snippet of snippets) {
        listEl.appendChild(this.createPopupRow(panel, filePath, snippet, selected.includes(snippet), false));
      }
      for (const snippet of missing) {
        listEl.appendChild(this.createPopupRow(panel, filePath, snippet, true, true));
      }
    }

    fragment.appendChild(listEl);
    panel.replaceChildren(fragment);
  }

  createPopupRow(panel, filePath, snippet, checked, isMissing) {
    const row = document.createElement("label");
    row.className = "scoped-snippets-popup-row";
    row.setAttribute("role", "option");
    row.setAttribute("aria-selected", checked ? "true" : "false");
    if (isMissing) row.classList.add("is-missing");

    const input = document.createElement("input");
    input.type = "checkbox";
    input.className = "scoped-snippets-popup-checkbox";
    input.checked = checked;
    input.addEventListener("click", (event) => event.stopPropagation());
    input.addEventListener("change", async (event) => {
      event.stopPropagation();
      await this.toggleSnippetForFile(filePath, snippet, input.checked);
      this.refreshPopupAfterToggle(panel, filePath);
    });

    const text = document.createElement("span");
    text.className = "scoped-snippets-popup-row-label";
    const name = snippet.replace(/\.css$/i, "");
    text.textContent = isMissing ? `⚠ missing file: ${name}` : name;
    row.title = text.textContent;

    row.appendChild(input);
    row.appendChild(text);
    return row;
  }

  refreshPopupAfterToggle(panel, filePath) {
    const selected = this.getFileSnippets(filePath);

    const clearBtn = panel.querySelector(".scoped-snippets-popup-clear");
    if (clearBtn) clearBtn.disabled = selected.length === 0;

    for (const row of Array.from(panel.querySelectorAll(".scoped-snippets-popup-row"))) {
      const input = row.querySelector("input");
      if (!input) continue;
      row.setAttribute("aria-selected", input.checked ? "true" : "false");
      if (row.classList.contains("is-missing") && !input.checked) row.remove();
    }
  }

  positionPopup() {
    const state = this.activePopup;
    if (!state) return;

    const { button, panel } = state;
    const rect = button.getBoundingClientRect();

    if (!button.isConnected || (rect.width === 0 && rect.height === 0)) {
      this.closePopup();
      return;
    }

    const margin = 6;

    panel.style.minWidth = `${Math.round(rect.width)}px`;
    panel.style.visibility = "hidden";
    panel.style.left = "0px";
    panel.style.top = "0px";

    const panelWidth = panel.offsetWidth;
    const panelHeight = panel.offsetHeight;

    let left;
    if (this.getDropdownPosition() === "left") {
      left = rect.left;
    } else {
      left = rect.right - panelWidth;
    }

    if (left + panelWidth > window.innerWidth - margin) {
      left = window.innerWidth - margin - panelWidth;
    }
    if (left < margin) left = margin;

    let top = rect.bottom + 4;
    if (top + panelHeight > window.innerHeight - margin) {
      const above = rect.top - 4 - panelHeight;
      top = above >= margin ? above : Math.max(margin, window.innerHeight - margin - panelHeight);
    }

    panel.style.left = `${Math.round(left)}px`;
    panel.style.top = `${Math.round(top)}px`;
    panel.style.visibility = "";
  }

  closePopup() {
    const state = this.activePopup;
    if (!state) return;
    this.activePopup = null;

    if (state.onDocPointerDown) document.removeEventListener("pointerdown", state.onDocPointerDown, true);
    if (state.onKeyDown) document.removeEventListener("keydown", state.onKeyDown, true);
    if (state.onReposition) {
      window.removeEventListener("resize", state.onReposition, true);
      window.removeEventListener("scroll", state.onReposition, true);
    }

    if (state.panel) state.panel.remove();

    if (state.button) {
      state.button.setAttribute("aria-expanded", "false");
      state.button.classList.remove("is-open");
    }
  }

  async toggleSnippetForFile(filePath, snippet, enabled) {
    const current = new Set(this.getFileSnippets(filePath));
    if (enabled) current.add(snippet);
    else current.delete(snippet);
    await this.setSelectionForFile(filePath, Array.from(current));
  }

  async setSelectionForFile(filePath, list) {
    this.setFileSnippets(filePath, list);
    await this.saveSettings();

    const selected = this.getFileSnippets(filePath);

    this.applySelectionToOpenSupportedViews(filePath, selected);
    await this.rebuildScopedCss();
  }

  applySelectionToOpenSupportedViews(scopedFilePath, selected) {
    this.app.workspace.iterateAllLeaves((leaf) => {
      const file = this.getSupportedFileFromLeaf(leaf);
      const view = leaf && leaf.view;
      const containerEl = view && view.containerEl;
      if (!file || !containerEl || file.path !== scopedFilePath) return;

      this.applyScopeAttributes(containerEl, scopedFilePath, selected);

      const button = containerEl.querySelector(".scoped-snippets-button");
      if (button) this.updateButtonLabel(button, selected);
    });
  }

  applyScopeAttributes(containerEl, scopedFilePath, selected) {
    const filePath = scopedFilePath || "";
    containerEl.setAttribute("data-base-scoped-file", filePath);
    containerEl.setAttribute("data-bss-scoped-file", filePath);

    const ids = (selected || []).filter(Boolean).map((snippet) => this.getSnippetId(snippet));

    if (ids.length) {
      const attr = ids.join(" ");
      containerEl.setAttribute("data-base-scoped-snippet", attr);
      containerEl.setAttribute("data-bss-scoped-snippet", attr);
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
    if (this.activePopup && containerEl.contains(this.activePopup.button)) {
      this.closePopup();
    }

    for (const picker of Array.from(containerEl.querySelectorAll(".scoped-snippets-picker"))) {
      picker.remove();
    }

    for (const header of Array.from(containerEl.querySelectorAll(".scoped-snippets-header"))) {
      header.classList.remove("scoped-snippets-header");
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
      new Set(
        Object.values(this.settings.fileSnippets || {})
          .flatMap((value) => (Array.isArray(value) ? value : (value ? [value] : [])))
          .filter(Boolean)
      )
    );

    const snippetsFolder = this.getSnippetsFolderPath();
    const blocks = [];

    for (const snippet of selectedSnippets) {
      const snippetPath = `${snippetsFolder}/${snippet}`;

      try {
        const css = await this.app.vault.adapter.read(snippetPath);
        const id = this.getSnippetId(snippet);
        const scope = `[data-bss-scoped-snippet~="${this.escapeAttributeForSelector(id)}"]`;
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

    if (/^[.#\[]/.test(selector)) {
      return `${descendantSelector}, ${scope}${selector}`;
    }

    return descendantSelector;
  }
}

class SnippetEditorView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.activeSnippet = null;
    this.buffers = new Map();
    this.savedContents = new Map();
    this.armedDelete = null;
    this.armedDeleteTimer = null;
    this.fileListEl = null;
    this.fileDotEls = new Map();
    this.tabbarEl = null;
    this.tabDotEls = new Map();
    this.openTabs = [];
    this.bypassCloseGuard = false;
    this.openSequence = 0;
    this.draftTimer = null;
    this.stopResize = null;
    this.patchedLeaf = null;
    this.leafDetachOriginal = null;
    this.conflictOverride = null;
    this.sidebarCollapsed = false;
    this.collapseBtn = null;
    this.saveBtn = null;
    this.sidebarEl = null;
    this.searchInputEl = null;
    this.countEl = null;
    this.fileFilter = "";
    this.editorAreaEl = null;
    this.gutterEl = null;
    this.textarea = null;
    this.rootEl = null;
    this.highlightWrapEl = null;
    this.highlightEl = null;
    this.statusLeftEl = null;
    this.statusRightEl = null;
    this.statusCaretEl = null;
  }

  getViewType() {
    return SNIPPET_EDITOR_VIEW_TYPE;
  }

  getDisplayText() {
    return "CSS snippets";
  }

  getIcon() {
    return "file-heart";
  }

  async onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("scoped-snippets-ide-content");

    const root = contentEl.createDiv({ cls: "scoped-snippets-ide" });
    this.rootEl = root;
    this.applyEditorColors();

    const sidebar = root.createDiv({ cls: "scoped-snippets-ide-sidebar" });
    this.sidebarEl = sidebar;
    sidebar.style.setProperty("--ssc-sidebar-width", `${this.plugin.settings.editorSidebarWidth}px`);

    const sidebarHead = sidebar.createDiv({ cls: "scoped-snippets-ide-sidebar-header" });
    const titleWrap = sidebarHead.createDiv({ cls: "scoped-snippets-ide-sidebar-title" });
    titleWrap.createSpan({ text: "Snippets" });
    this.countEl = titleWrap.createSpan({ cls: "scoped-snippets-ide-count" });

    const headActions = sidebarHead.createDiv({ cls: "scoped-snippets-ide-sidebar-actions" });

    const newBtn = headActions.createEl("button", {
      cls: "clickable-icon scoped-snippets-ide-icon-button scoped-snippets-ide-new-button",
      attr: { "aria-label": "New snippet" }
    });
    setIcon(newBtn, "plus");
    newBtn.addEventListener("click", () => this.showNewFileInput());

    this.collapseBtn = headActions.createEl("button", {
      cls: "clickable-icon scoped-snippets-ide-icon-button",
      attr: { "aria-label": "Collapse navigator" }
    });
    setIcon(this.collapseBtn, "panel-left-close");
    this.collapseBtn.addEventListener("click", () => this.toggleSidebar());

    const searchWrap = sidebar.createDiv({ cls: "scoped-snippets-ide-search" });

    this.searchInputEl = searchWrap.createEl("input", {
      attr: { type: "search", placeholder: "Search snippets…", "aria-label": "Search snippets" }
    });

    const refreshBtn = searchWrap.createEl("button", {
      cls: "clickable-icon scoped-snippets-ide-icon-button scoped-snippets-ide-refresh-button",
      attr: { "aria-label": "Refresh snippets" }
    });
    setIcon(refreshBtn, "refresh-cw");
    refreshBtn.addEventListener("click", async () => {
      if (refreshBtn.disabled) return;
      refreshBtn.disabled = true;
      try {
        await this.plugin.refreshAfterSnippetChange();
        await this.syncOpenBuffersFromDisk();
        new Notice("Snippets refreshed.");
      } finally {
        refreshBtn.disabled = false;
      }
    });
    this.searchInputEl.addEventListener("input", () => {
      this.fileFilter = this.searchInputEl.value.trim().toLowerCase();
      this.renderFileList();
    });
    this.searchInputEl.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && this.searchInputEl.value) {
        event.stopPropagation();
        this.searchInputEl.value = "";
        this.fileFilter = "";
        this.renderFileList();
      }
    });

    this.fileListEl = sidebar.createDiv({ cls: "scoped-snippets-ide-files" });

    const footer = sidebar.createDiv({ cls: "scoped-snippets-ide-sidebar-footer" });
    const openFolderBtn = footer.createEl("button", {
      cls: "clickable-icon scoped-snippets-ide-open-folder",
      attr: { "aria-label": "Open snippets folder" }
    });
    const folderIcon = openFolderBtn.createSpan({ cls: "scoped-snippets-ide-open-folder-icon" });
    setIcon(folderIcon, "folder-open");
    openFolderBtn.createSpan({ cls: "scoped-snippets-ide-open-folder-label", text: "Open snippets folder" });
    openFolderBtn.addEventListener("click", () => this.openSnippetsFolder());

    const resizer = sidebar.createDiv({ cls: "scoped-snippets-ide-resizer" });
    resizer.addEventListener("pointerdown", (event) => this.startSidebarResize(event));

    const main = root.createDiv({ cls: "scoped-snippets-ide-main" });

    const tabbar = main.createDiv({ cls: "scoped-snippets-ide-tabbar" });
    this.tabbarEl = tabbar.createDiv({ cls: "scoped-snippets-ide-tabs" });

    const tabActions = tabbar.createDiv({ cls: "scoped-snippets-ide-tab-actions" });
    this.saveBtn = tabActions.createEl("button", {
      cls: "clickable-icon scoped-snippets-ide-icon-button scoped-snippets-ide-save-button",
      attr: { "aria-label": "Save (Ctrl/Cmd+S)" }
    });
    setIcon(this.saveBtn, "save");
    this.saveBtn.addEventListener("click", () => this.saveActiveSnippet());

    this.editorAreaEl = main.createDiv({ cls: "scoped-snippets-ide-editor" });

    this.registerDomEvent(contentEl, "keydown", (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        event.stopPropagation();
        this.saveActiveSnippet();
      }
    }, true);

    const status = main.createDiv({ cls: "scoped-snippets-ide-status" });
    this.statusLeftEl = status.createDiv({ cls: "scoped-snippets-ide-status-left" });
    this.statusRightEl = status.createDiv({ cls: "scoped-snippets-ide-status-right" });
    this.statusCaretEl = this.statusRightEl.createSpan();
    this.statusRightEl.createSpan({ text: "Spaces: 2" });
    this.statusRightEl.createSpan({ text: "CSS" });

    await this.plugin.reloadSnippetList();
    this.renderFileList();
    this.renderEditor();

    this.patchLeafDetach();
  }

  async onClose() {
    this.clearArmedDelete();
    if (this.stopResize) this.stopResize();
    if (this.draftTimer) {
      window.clearTimeout(this.draftTimer);
      this.draftTimer = null;
    }

    this.storeActiveBuffer();
    const dirty = this.openTabs.filter((name) => this.isDirty(name));
    await this.persistDrafts();
    if (dirty.length) {
      new Notice("Snippet editor closed with unsaved changes. They will be restored when you reopen the files.");
    }

    this.unpatchLeafDetach();
  }

  getDirtySnippets() {
    this.storeActiveBuffer();
    return this.openTabs.filter((name) => this.isDirty(name));
  }

  patchLeafDetach() {
    const leaf = this.leaf;
    if (!leaf || leaf.scopedSnippetsDetachPatched) return;
    leaf.scopedSnippetsDetachPatched = true;
    this.patchedLeaf = leaf;
    this.leafDetachOriginal = leaf.detach;

    leaf.detach = () => {
      const dirty = this.getDirtySnippets();

      if (!dirty.length || this.bypassCloseGuard || this.plugin.isUnloading) {
        return this.leafDetachOriginal.call(leaf);
      }

      const label = dirty.length === 1 ? dirty[0] : `${dirty.length} snippets`;

      new UnsavedChangesModal(this.app, label, async (choice) => {
        if (choice === "save") {
          for (const name of dirty) {
            const saved = await this.saveSnippet(name);
            if (!saved) return;
          }
          this.bypassCloseGuard = true;
          this.leafDetachOriginal.call(leaf);
        } else if (choice === "discard") {
          this.discardAllBuffers();
          this.bypassCloseGuard = true;
          this.leafDetachOriginal.call(leaf);
        }
      }).open();
    };
  }

  unpatchLeafDetach() {
    const leaf = this.patchedLeaf;
    if (!leaf || !this.leafDetachOriginal) return;
    leaf.detach = this.leafDetachOriginal;
    delete leaf.scopedSnippetsDetachPatched;
    this.patchedLeaf = null;
    this.leafDetachOriginal = null;
  }

  discardAllBuffers() {
    const drafts = this.plugin.settings.editorDrafts || {};
    let changed = false;

    for (const name of this.openTabs) {
      this.buffers.delete(name);
      this.savedContents.delete(name);
      if (Object.prototype.hasOwnProperty.call(drafts, name)) {
        delete drafts[name];
        changed = true;
      }
    }

    this.openTabs = [];
    if (changed) this.plugin.saveSettings();
  }

  async persistDrafts() {
    const drafts = Object.assign({}, this.plugin.settings.editorDrafts);
    let changed = false;

    for (const name of this.openTabs) {
      if (this.isDirty(name)) {
        if (drafts[name] !== this.buffers.get(name)) {
          drafts[name] = this.buffers.get(name);
          changed = true;
        }
      } else if (Object.prototype.hasOwnProperty.call(drafts, name)) {
        delete drafts[name];
        changed = true;
      }
    }

    if (!changed) return;
    this.plugin.settings.editorDrafts = drafts;
    await this.plugin.saveSettings();
  }

  scheduleDraftPersist() {
    if (this.draftTimer) window.clearTimeout(this.draftTimer);
    this.draftTimer = window.setTimeout(() => {
      this.draftTimer = null;
      this.persistDrafts();
    }, 1000);
  }

  clearDraft(name) {
    const drafts = this.plugin.settings.editorDrafts || {};
    if (Object.prototype.hasOwnProperty.call(drafts, name)) {
      delete drafts[name];
      this.plugin.saveSettings();
    }
  }

  hasUnsavedChanges(name) {
    if (this.isDirty(name)) return true;
    if (this.buffers.has(name)) return false;
    return typeof (this.plugin.settings.editorDrafts || {})[name] === "string";
  }

  async syncOpenBuffersFromDisk() {
    for (const name of this.openTabs.slice()) {
      let disk;
      try {
        disk = await this.app.vault.adapter.read(this.getSnippetPath(name));
      } catch (error) {
        continue;
      }

      if (disk === this.savedContents.get(name)) continue;

      if (!this.isDirty(name)) {
        this.buffers.set(name, disk);
        this.savedContents.set(name, disk);
        if (name === this.activeSnippet && this.textarea) {
          this.textarea.value = disk;
          this.updateGutter();
          this.updateHighlight();
        }
      } else {
        this.savedContents.set(name, disk);
        new Notice(`"${name}" changed on disk. Your unsaved editor changes now differ from the new file contents.`);
      }
    }

    this.updateDirtyIndicators();
  }

  clearArmedDelete() {
    if (this.armedDeleteTimer) {
      window.clearTimeout(this.armedDeleteTimer);
      this.armedDeleteTimer = null;
    }
    this.armedDelete = null;
  }

  toggleSidebar() {
    this.sidebarCollapsed = !this.sidebarCollapsed;
    if (this.rootEl) this.rootEl.classList.toggle("is-collapsed", this.sidebarCollapsed);
    if (this.collapseBtn) {
      setIcon(this.collapseBtn, this.sidebarCollapsed ? "panel-left-open" : "panel-left-close");
      this.collapseBtn.setAttribute("aria-label", this.sidebarCollapsed ? "Expand navigator" : "Collapse navigator");
    }
  }

  startSidebarResize(event) {
    if (this.sidebarCollapsed || !this.sidebarEl) return;
    event.preventDefault();

    const startX = event.clientX;
    const startWidth = this.sidebarEl.getBoundingClientRect().width;

    this.sidebarEl.classList.add("is-resizing");
    if (this.rootEl) this.rootEl.classList.add("is-resizing");

    const onMove = (moveEvent) => {
      const width = Math.min(480, Math.max(140, Math.round(startWidth + moveEvent.clientX - startX)));
      this.sidebarEl.style.setProperty("--ssc-sidebar-width", `${width}px`);
    };

    const cleanup = () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.removeEventListener("pointercancel", onUp);
      this.stopResize = null;
      if (this.sidebarEl) this.sidebarEl.classList.remove("is-resizing");
      if (this.rootEl) this.rootEl.classList.remove("is-resizing");
    };

    const onUp = async () => {
      cleanup();
      const width = Math.round(this.sidebarEl.getBoundingClientRect().width);
      this.plugin.settings.editorSidebarWidth = width;
      await this.plugin.saveSettings();
    };

    this.stopResize = cleanup;

    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
    document.addEventListener("pointercancel", onUp);
  }

  setFileIcon(el) {
    setIcon(el, "file-braces-corner");
    if (!el.querySelector("svg")) setIcon(el, "braces");
  }

  async openSnippetsFolder() {
    const folder = this.plugin.getSnippetsFolderPath();
    const adapter = this.app.vault.adapter;

    try {
      if (!(await adapter.exists(folder))) await adapter.mkdir(folder);
    } catch (error) {
      console.warn(`Scoped Snippets: could not create ${folder}`, error);
    }

    if (typeof this.app.openWithDefaultApp === "function") {
      this.app.openWithDefaultApp(folder);
      return;
    }

    new Notice("Opening the snippets folder is not supported on this platform.");
  }

  getSnippetPath(name) {
    return `${this.plugin.getSnippetsFolderPath()}/${name}`;
  }

  isDirty(name) {
    if (!this.buffers.has(name)) return false;
    return this.buffers.get(name) !== this.savedContents.get(name);
  }

  storeActiveBuffer() {
    if (this.activeSnippet && this.textarea) {
      this.buffers.set(this.activeSnippet, this.textarea.value);
    }
  }

  handleSnippetListChange() {
    const snippets = this.plugin.snippetList || [];
    this.openTabs = this.openTabs.filter((name) => snippets.includes(name));

    for (const name of Array.from(this.buffers.keys())) {
      if (!snippets.includes(name)) {
        this.buffers.delete(name);
        this.savedContents.delete(name);
      }
    }

    if (snippets.length) {
      const drafts = this.plugin.settings.editorDrafts || {};
      let draftsChanged = false;
      for (const key of Object.keys(drafts)) {
        if (!snippets.includes(key)) {
          delete drafts[key];
          draftsChanged = true;
        }
      }
      if (draftsChanged) this.plugin.saveSettings();
    }

    if (this.activeSnippet && !snippets.includes(this.activeSnippet)) {
      this.activeSnippet = this.openTabs[this.openTabs.length - 1] || null;
      this.renderEditor();
    } else if (!this.activeSnippet) {
      this.renderEditor();
    } else {
      this.renderTabs();
    }
    this.renderFileList();
  }

  renderFileList() {
    if (!this.fileListEl) return;

    const pendingNewFile = this.fileListEl.querySelector(".scoped-snippets-ide-new-file");
    const pendingInput = pendingNewFile ? pendingNewFile.querySelector("input") : null;
    const pendingHadFocus = pendingInput && document.activeElement === pendingInput;

    this.fileListEl.empty();
    this.fileDotEls = new Map();

    if (pendingNewFile) {
      this.fileListEl.appendChild(pendingNewFile);
      if (pendingHadFocus && pendingInput) pendingInput.focus();
    }

    const snippets = this.plugin.snippetList || [];
    if (this.countEl) this.countEl.textContent = String(snippets.length);

    const filter = this.fileFilter || "";
    const visible = filter ? snippets.filter((name) => name.toLowerCase().includes(filter)) : snippets;

    if (!snippets.length) {
      this.fileListEl.createDiv({
        cls: "scoped-snippets-ide-files-empty",
        text: "No CSS snippets yet."
      });
      return;
    }

    if (!visible.length) {
      this.fileListEl.createDiv({
        cls: "scoped-snippets-ide-files-empty",
        text: "No matching snippets."
      });
      return;
    }

    for (const snippet of visible) {
      const row = this.fileListEl.createDiv({ cls: "scoped-snippets-ide-file" });
      if (snippet === this.activeSnippet) row.addClass("is-active");
      row.setAttribute("title", snippet);

      const icon = row.createSpan({ cls: "scoped-snippets-ide-file-icon" });
      this.setFileIcon(icon);

      row.createSpan({ cls: "scoped-snippets-ide-file-name", text: snippet });

      const dot = row.createSpan({ cls: "scoped-snippets-ide-dirty-dot", text: "●" });
      dot.classList.toggle("is-visible", this.hasUnsavedChanges(snippet));
      this.fileDotEls.set(snippet, dot);

      const trash = row.createEl("button", {
        cls: "clickable-icon scoped-snippets-ide-icon-button scoped-snippets-ide-file-delete",
        attr: { "aria-label": `Delete ${snippet}` }
      });
      setIcon(trash, "trash-2");
      if (this.armedDelete === snippet) {
        trash.addClass("is-armed");
        trash.setAttribute("aria-label", "Click again to delete");
      }
      trash.addEventListener("click", (event) => {
        event.stopPropagation();
        this.deleteSnippet(snippet);
      });

      row.addEventListener("click", () => this.openSnippet(snippet));
    }
  }

  showNewFileInput() {
    if (!this.fileListEl) return;
    if (this.sidebarCollapsed) this.toggleSidebar();

    const existing = this.fileListEl.querySelector(".scoped-snippets-ide-new-file");
    if (existing) {
      const existingInput = existing.querySelector("input");
      if (existingInput) existingInput.focus();
      return;
    }

    const row = document.createElement("div");
    row.className = "scoped-snippets-ide-file scoped-snippets-ide-new-file";

    const icon = document.createElement("span");
    icon.className = "scoped-snippets-ide-file-icon";
    this.setFileIcon(icon);
    row.appendChild(icon);

    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = "new-snippet.css";
    row.appendChild(input);

    this.fileListEl.insertBefore(row, this.fileListEl.firstChild);
    input.focus();

    input.addEventListener("keydown", async (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        row.remove();
      } else if (event.key === "Enter") {
        event.preventDefault();
        await this.createSnippet(input.value);
      }
    });
    input.addEventListener("blur", () => {
      window.setTimeout(() => {
        if (row.isConnected && !input.value.trim()) row.remove();
      }, 150);
    });
  }

  async createSnippet(rawName) {
    let name = String(rawName || "").trim();

    if (!name) {
      new Notice("Enter a file name for the new snippet.");
      return;
    }
    if (name.includes("/") || name.includes("\\")) {
      new Notice("Snippet names cannot contain folders.");
      return;
    }
    if (/[<>:"|?*\u0000-\u001f]/.test(name)) {
      new Notice('Snippet names cannot contain the characters < > : " | ? *');
      return;
    }
    if (!name.toLowerCase().endsWith(".css")) {
      name += ".css";
    }

    const base = name.slice(0, -4);
    if (!base || base === "." || base === "..") {
      new Notice("Enter a valid file name for the new snippet.");
      return;
    }
    if (/^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(base)) {
      new Notice(`"${base}" is a reserved file name.`);
      return;
    }
    if (/[. ]$/.test(base)) {
      new Notice("Snippet names cannot end with a dot or space.");
      return;
    }

    const folder = this.plugin.getSnippetsFolderPath();
    const path = this.getSnippetPath(name);
    const adapter = this.app.vault.adapter;

    try {
      const existsInList = (this.plugin.snippetList || []).some(
        (snippet) => snippet.toLowerCase() === name.toLowerCase()
      );
      if (existsInList || (await adapter.exists(path))) {
        new Notice(`"${name}" already exists.`);
        return;
      }

      if (!(await adapter.exists(folder))) {
        await adapter.mkdir(folder);
      }

      await adapter.write(path, "");
    } catch (error) {
      console.warn(`Scoped Snippets: could not create ${path}`, error);
      new Notice(`Could not create "${name}".`);
      return;
    }

    new Notice(`Created "${name}".`);
    await this.plugin.refreshAfterSnippetChange();
    await this.openSnippet(name);
  }

  async openSnippet(name) {
    this.storeActiveBuffer();
    this.clearArmedDelete();

    this.openSequence += 1;
    const sequence = this.openSequence;

    if (!this.buffers.has(name)) {
      let contents;
      try {
        contents = await this.app.vault.adapter.read(this.getSnippetPath(name));
      } catch (error) {
        console.warn(`Scoped Snippets: could not read ${this.getSnippetPath(name)}`, error);
        new Notice(`Could not read "${name}".`);
        return;
      }

      this.savedContents.set(name, contents);

      const draft = (this.plugin.settings.editorDrafts || {})[name];
      if (typeof draft === "string" && draft !== contents) {
        this.buffers.set(name, draft);
        new Notice(`Restored unsaved changes for "${name}".`);
      } else {
        this.buffers.set(name, contents);
      }

      if (sequence !== this.openSequence) return;
    }

    if (!this.openTabs.includes(name)) this.openTabs.push(name);
    this.activeSnippet = name;
    this.renderFileList();
    this.renderEditor();
  }

  renderTabs() {
    if (!this.tabbarEl) return;
    this.tabbarEl.empty();
    this.tabDotEls = new Map();

    for (const name of this.openTabs) {
      const tab = this.tabbarEl.createDiv({ cls: "scoped-snippets-ide-tab" });
      if (name === this.activeSnippet) tab.addClass("is-active");
      tab.setAttribute("title", name);

      const tabIcon = tab.createSpan({ cls: "scoped-snippets-ide-file-icon" });
      this.setFileIcon(tabIcon);

      tab.createSpan({ cls: "scoped-snippets-ide-tab-name", text: name });

      const dot = tab.createSpan({ cls: "scoped-snippets-ide-dirty-dot", text: "●" });
      dot.classList.toggle("is-visible", this.isDirty(name));
      this.tabDotEls.set(name, dot);

      const closeBtn = tab.createEl("button", {
        cls: "clickable-icon scoped-snippets-ide-icon-button scoped-snippets-ide-tab-close",
        attr: { "aria-label": `Close ${name}` }
      });
      setIcon(closeBtn, "x");
      closeBtn.addEventListener("click", (event) => {
        event.stopPropagation();
        this.closeTab(name);
      });

      tab.addEventListener("click", () => {
        if (name !== this.activeSnippet) this.openSnippet(name);
      });
      tab.addEventListener("auxclick", (event) => {
        if (event.button === 1) this.closeTab(name);
      });
    }
  }

  closeTab(name) {
    if (name === this.activeSnippet) this.storeActiveBuffer();

    if (this.isDirty(name)) {
      new UnsavedChangesModal(this.app, name, async (choice) => {
        if (choice === "save") {
          const saved = await this.saveSnippet(name);
          if (saved) this.finishCloseTab(name);
        } else if (choice === "discard") {
          this.finishCloseTab(name);
        }
      }).open();
      return;
    }

    this.finishCloseTab(name);
  }

  finishCloseTab(name) {
    const index = this.openTabs.indexOf(name);
    if (index !== -1) this.openTabs.splice(index, 1);
    this.buffers.delete(name);
    this.savedContents.delete(name);
    this.clearDraft(name);

    if (this.activeSnippet === name) {
      const next = this.openTabs[Math.min(index, this.openTabs.length - 1)] || null;
      this.activeSnippet = null;
      if (next) {
        this.openSnippet(next);
        return;
      }
      this.renderEditor();
    } else {
      this.renderTabs();
    }
    this.renderFileList();
  }

  renderEditor() {
    if (!this.editorAreaEl || !this.tabbarEl) return;
    this.editorAreaEl.empty();
    this.renderTabs();

    if (!this.activeSnippet) {
      this.gutterEl = null;
      this.textarea = null;
      this.highlightWrapEl = null;
      this.highlightEl = null;
      const placeholder = this.editorAreaEl.createDiv({ cls: "scoped-snippets-ide-placeholder" });
      const hasSnippets = (this.plugin.snippetList || []).length > 0;

      if (hasSnippets) {
        placeholder.createDiv({ text: "Select a snippet to edit, or create a new one." });
      } else {
        placeholder.createDiv({ text: "There are no CSS snippets in your snippets folder yet." });
        placeholder.createDiv({
          cls: "scoped-snippets-ide-placeholder-hint",
          text: "Create a new snippet, or drop .css files into the snippets folder."
        });

        const actions = placeholder.createDiv({ cls: "scoped-snippets-ide-placeholder-actions" });

        const newBtn = actions.createEl("button", { text: "New snippet", cls: "mod-cta" });
        newBtn.addEventListener("click", () => this.showNewFileInput());

        const folderBtn = actions.createEl("button", { text: "Open snippets folder" });
        folderBtn.addEventListener("click", () => this.openSnippetsFolder());
      }

      this.updateStatus();
      return;
    }

    this.gutterEl = this.editorAreaEl.createDiv({ cls: "scoped-snippets-ide-gutter" });

    const codeWrap = this.editorAreaEl.createDiv({ cls: "scoped-snippets-ide-code" });
    this.highlightWrapEl = codeWrap.createEl("pre", { cls: "scoped-snippets-ide-highlight" });
    this.highlightEl = this.highlightWrapEl.createEl("code");

    this.textarea = codeWrap.createEl("textarea", {
      cls: "scoped-snippets-ide-textarea",
      attr: { wrap: "off", spellcheck: "false" }
    });
    this.textarea.value = this.buffers.get(this.activeSnippet) || "";

    this.textarea.addEventListener("input", () => {
      this.buffers.set(this.activeSnippet, this.textarea.value);
      this.updateGutter();
      this.updateHighlight();
      this.updateDirtyIndicators();
      this.scheduleDraftPersist();
    });
    this.textarea.addEventListener("scroll", () => {
      if (this.gutterEl) this.gutterEl.scrollTop = this.textarea.scrollTop;
      this.syncHighlightScroll();
    });
    this.textarea.addEventListener("keyup", () => this.updateStatus());
    this.textarea.addEventListener("click", () => this.updateStatus());
    this.textarea.addEventListener("keydown", (event) => {
      if (event.key === "Tab") {
        event.preventDefault();
        this.textarea.setRangeText("  ", this.textarea.selectionStart, this.textarea.selectionEnd, "end");
        this.buffers.set(this.activeSnippet, this.textarea.value);
        this.updateGutter();
        this.updateHighlight();
        this.updateDirtyIndicators();
        this.scheduleDraftPersist();
      }
    });

    this.updateGutter();
    this.updateHighlight();
    this.updateDirtyIndicators();
    this.textarea.focus();
  }

  updateGutter() {
    if (!this.gutterEl || !this.textarea) return;

    const lineCount = this.textarea.value.split("\n").length;
    const numbers = [];
    for (let i = 1; i <= lineCount; i += 1) numbers.push(i);
    this.gutterEl.textContent = numbers.join("\n");
    this.gutterEl.scrollTop = this.textarea.scrollTop;
  }

  applyEditorColors() {
    if (!this.rootEl) return;

    const colors = this.plugin.settings.editorColors || {};
    for (const key of Object.keys(EDITOR_COLOR_FIELDS)) {
      if (colors[key]) this.rootEl.style.setProperty(`--ssc-${key}`, colors[key]);
    }
  }

  syncHighlightScroll() {
    if (!this.highlightWrapEl || !this.textarea) return;
    this.highlightWrapEl.scrollTop = this.textarea.scrollTop;
    this.highlightWrapEl.scrollLeft = this.textarea.scrollLeft;
  }

  updateHighlight() {
    if (!this.highlightEl || !this.textarea) return;

    const fragment = document.createDocumentFragment();
    for (const token of this.tokenizeCss(this.textarea.value)) {
      if (token.type === "plain") {
        fragment.appendChild(document.createTextNode(token.value));
      } else {
        const span = document.createElement("span");
        span.className = `ssc-tok-${token.type}`;
        span.textContent = token.value;
        fragment.appendChild(span);
      }
    }
    fragment.appendChild(document.createTextNode("\n"));

    this.highlightEl.replaceChildren(fragment);
    this.syncHighlightScroll();
  }

  tokenizeCss(text) {
    const tokens = [];
    const push = (type, value) => {
      if (value) tokens.push({ type, value });
    };

    let i = 0;
    const blocks = [];
    let inValue = false;
    let atGroupPrelude = false;

    const inDeclarations = () => blocks.length > 0 && blocks[blocks.length - 1] === "declarations";

    while (i < text.length) {
      if (text.startsWith("/*", i)) {
        const end = text.indexOf("*/", i + 2);
        const stop = end === -1 ? text.length : end + 2;
        push("comment", text.slice(i, stop));
        i = stop;
        continue;
      }

      const ch = text[i];

      if (ch === "\"" || ch === "'") {
        let j = i + 1;
        while (j < text.length && text[j] !== ch && text[j] !== "\n") {
          if (text[j] === "\\") j += 1;
          j += 1;
        }
        const stop = Math.min(j + 1, text.length);
        push("string", text.slice(i, stop));
        i = stop;
        continue;
      }

      if (ch === "{") {
        blocks.push(atGroupPrelude ? "rules" : "declarations");
        atGroupPrelude = false;
        inValue = false;
        push("punctuation", ch);
        i += 1;
        continue;
      }
      if (ch === "}") {
        blocks.pop();
        atGroupPrelude = false;
        inValue = false;
        push("punctuation", ch);
        i += 1;
        continue;
      }
      if (ch === ";") {
        atGroupPrelude = false;
        inValue = false;
        push("punctuation", ch);
        i += 1;
        continue;
      }
      if (ch === ":" && inDeclarations() && !inValue) {
        inValue = true;
        push("punctuation", ch);
        i += 1;
        continue;
      }

      if (ch === "@") {
        const match = /^@[\w-]+/.exec(text.slice(i));
        if (match) {
          atGroupPrelude = /^@(media|supports|container|layer|scope|document|(-\w+-)?keyframes)$/i.test(match[0]);
          push("atrule", match[0]);
          i += match[0].length;
          continue;
        }
      }

      const ws = /^\s+/.exec(text.slice(i));
      if (ws) {
        push("plain", ws[0]);
        i += ws[0].length;
        continue;
      }

      if (!inDeclarations()) {
        if (ch === ",") {
          push("punctuation", ch);
          i += 1;
          continue;
        }
        const match = /^[^\s{};,]+/.exec(text.slice(i));
        if (match) {
          push("selector", match[0]);
          i += match[0].length;
          continue;
        }
      } else if (!inValue) {
        const match = /^(?:--)?[-\w]+/.exec(text.slice(i));
        if (match) {
          push("property", match[0]);
          i += match[0].length;
          continue;
        }
      } else {
        const slice = text.slice(i);

        const hex = /^#[0-9a-fA-F]{3,8}\b/.exec(slice);
        if (hex) {
          push("number", hex[0]);
          i += hex[0].length;
          continue;
        }

        const num = /^-?(?:\d+\.?\d*|\.\d+)[a-zA-Z%]*/.exec(slice);
        if (num) {
          push("number", num[0]);
          i += num[0].length;
          continue;
        }

        const important = /^!\s*important\b/i.exec(slice);
        if (important) {
          push("atrule", important[0]);
          i += important[0].length;
          continue;
        }

        const fn = /^(?:--)?[-\w]+(?=\()/.exec(slice);
        if (fn) {
          push("function", fn[0]);
          i += fn[0].length;
          continue;
        }

        const word = /^(?:--)?[-\w]+/.exec(slice);
        if (word) {
          push("value", word[0]);
          i += word[0].length;
          continue;
        }

        if (ch === "(" || ch === ")" || ch === ",") {
          push("punctuation", ch);
          i += 1;
          continue;
        }
      }

      push("plain", ch);
      i += 1;
    }

    return tokens;
  }

  updateDirtyIndicators() {
    for (const [name, dot] of this.tabDotEls) {
      dot.classList.toggle("is-visible", this.isDirty(name));
    }

    for (const [name, dot] of this.fileDotEls) {
      dot.classList.toggle("is-visible", this.hasUnsavedChanges(name));
    }

    this.updateStatus();
  }

  updateStatus() {
    if (!this.statusLeftEl || !this.statusRightEl) return;

    if (this.saveBtn) {
      const hasFile = Boolean(this.activeSnippet && this.textarea);
      this.saveBtn.disabled = !hasFile;
      this.saveBtn.classList.toggle("is-dirty", hasFile && this.isDirty(this.activeSnippet));
    }

    if (!this.activeSnippet || !this.textarea) {
      this.statusLeftEl.textContent = "No file open";
      this.statusRightEl.classList.add("is-hidden");
      return;
    }

    this.statusRightEl.classList.remove("is-hidden");

    const dirty = this.isDirty(this.activeSnippet);
    this.statusLeftEl.textContent = `${this.activeSnippet}${dirty ? " — unsaved changes" : ""}`;

    const value = this.textarea.value;
    const caret = this.textarea.selectionStart || 0;
    const before = value.slice(0, caret).split("\n");
    const line = before.length;
    const col = before[before.length - 1].length + 1;
    this.statusCaretEl.textContent = `Ln ${line}, Col ${col}`;
  }

  async saveActiveSnippet() {
    if (!this.activeSnippet || !this.textarea) return;
    this.buffers.set(this.activeSnippet, this.textarea.value);
    await this.saveSnippet(this.activeSnippet);
  }

  async saveSnippet(name) {
    if (!this.buffers.has(name)) return false;

    const contents = this.buffers.get(name);
    const path = this.getSnippetPath(name);

    let diskContents = null;
    try {
      diskContents = await this.app.vault.adapter.read(path);
    } catch (error) {
      diskContents = null;
    }

    if (
      diskContents !== null &&
      diskContents !== this.savedContents.get(name) &&
      diskContents !== contents &&
      this.conflictOverride !== name
    ) {
      this.savedContents.set(name, diskContents);
      this.conflictOverride = name;
      this.updateDirtyIndicators();
      new Notice(`"${name}" changed on disk since it was opened. Save again to overwrite the external changes.`);
      return false;
    }
    this.conflictOverride = null;

    try {
      await this.app.vault.adapter.write(path, contents);
    } catch (error) {
      console.warn(`Scoped Snippets: could not write ${path}`, error);
      new Notice(`Could not save "${name}".`);
      return false;
    }

    this.savedContents.set(name, contents);
    this.clearDraft(name);
    this.updateDirtyIndicators();
    new Notice(`Saved "${name}".`);
    await this.plugin.refreshAfterSnippetChange();
    return true;
  }

  async deleteSnippet(name) {
    if (this.armedDelete !== name) {
      this.clearArmedDelete();
      this.armedDelete = name;
      this.armedDeleteTimer = window.setTimeout(() => {
        this.armedDelete = null;
        this.armedDeleteTimer = null;
        this.renderFileList();
      }, 4000);
      this.renderFileList();
      new Notice(`Click the trash icon again to delete "${name}".`);
      return;
    }

    this.clearArmedDelete();

    try {
      await this.app.vault.adapter.remove(this.getSnippetPath(name));
    } catch (error) {
      console.warn(`Scoped Snippets: could not delete ${this.getSnippetPath(name)}`, error);
      new Notice(`Could not delete "${name}".`);
      return;
    }

    this.buffers.delete(name);
    this.savedContents.delete(name);
    this.clearDraft(name);

    const tabIndex = this.openTabs.indexOf(name);
    if (tabIndex !== -1) this.openTabs.splice(tabIndex, 1);

    if (this.activeSnippet === name) {
      this.activeSnippet = this.openTabs[Math.min(tabIndex, this.openTabs.length - 1)] || null;
      this.renderEditor();
    }

    new Notice(`Deleted "${name}".`);
    await this.plugin.refreshAfterSnippetChange();
  }
}

class UnsavedChangesModal extends Modal {
  constructor(app, snippetName, onChoice) {
    super(app);
    this.snippetName = snippetName;
    this.onChoice = onChoice;
    this.discardTimer = null;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    this.modalEl.addClass("scoped-snippets-unsaved-modal");

    const warnIcon = this.modalEl.createDiv({ cls: "scoped-snippets-unsaved-warning-icon" });
    setIcon(warnIcon, "alert-triangle");
    if (!warnIcon.querySelector("svg")) setIcon(warnIcon, "triangle-alert");

    contentEl.createEl("h3", { text: "Unsaved changes" });

    contentEl.createEl("p", {
      cls: "scoped-snippets-unsaved-message",
      text: "Do you want to save the changes you made to:"
    });
    contentEl.createEl("p", {
      cls: "scoped-snippets-unsaved-filename",
      text: this.snippetName
    });

    contentEl.createEl("p", {
      cls: "scoped-snippets-unsaved-hint",
      text: "Your changes will be lost if you don't save them."
    });

    const buttons = contentEl.createDiv({ cls: "modal-button-container" });

    const saveBtn = buttons.createEl("button", { text: "Save changes", cls: "mod-cta" });
    saveBtn.addEventListener("click", () => {
      this.close();
      this.onChoice("save");
    });

    const discardBtn = buttons.createEl("button", {
      text: "Discard changes",
      cls: "scoped-snippets-unsaved-discard"
    });
    discardBtn.addEventListener("click", () => {
      if (!discardBtn.classList.contains("mod-warning")) {
        discardBtn.textContent = "Click again to discard";
        discardBtn.classList.add("mod-warning");
        this.discardTimer = window.setTimeout(() => {
          this.discardTimer = null;
          discardBtn.textContent = "Discard changes";
          discardBtn.classList.remove("mod-warning");
        }, 4000);
        return;
      }

      if (this.discardTimer) {
        window.clearTimeout(this.discardTimer);
        this.discardTimer = null;
      }
      this.close();
      this.onChoice("discard");
    });

    buttons.createDiv({ cls: "scoped-snippets-unsaved-spacer" });

    const cancelBtn = buttons.createEl("button", { text: "Cancel" });
    cancelBtn.addEventListener("click", () => this.close());

    window.setTimeout(() => saveBtn.focus(), 0);
  }

  onClose() {
    if (this.discardTimer) {
      window.clearTimeout(this.discardTimer);
      this.discardTimer = null;
    }
    this.contentEl.empty();
  }
}

class ScopedSnippetsSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Scoped Snippets" });

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

    containerEl.createEl("h3", { text: "Snippet editor colors" });

    let presetDropdown = null;

    new Setting(containerEl)
      .setName("Color preset")
      .setDesc("Pick a preset for the snippet editor's syntax colors, or adjust individual colors below.")
      .addDropdown((dropdown) => {
        presetDropdown = dropdown;
        for (const [key, preset] of Object.entries(EDITOR_COLOR_PRESETS)) {
          dropdown.addOption(key, preset.name);
        }
        dropdown.addOption("custom", "Custom");
        dropdown.setValue(this.plugin.settings.editorColorPreset);
        dropdown.onChange(async (value) => {
          if (value === "custom") {
            await this.plugin.applyEditorColorSettings({}, "custom");
            return;
          }
          await this.plugin.applyEditorColorSettings(
            Object.assign({}, EDITOR_COLOR_PRESETS[value].colors),
            value
          );
          this.display();
        });
      });

    for (const [key, label] of Object.entries(EDITOR_COLOR_FIELDS)) {
      new Setting(containerEl)
        .setName(label)
        .addColorPicker((picker) => {
          picker.setValue(this.plugin.settings.editorColors[key]);
          picker.onChange(async (value) => {
            await this.plugin.applyEditorColorSettings({ [key]: value }, "custom");
            if (presetDropdown) presetDropdown.setValue("custom");
          });
        });
    }

    const info = containerEl.createDiv({ cls: "scoped-snippets-settings-info" });
    info.createEl("p", {
      text: "The plugin reads CSS files from the .obsidian/snippets folder. Open the picker in a .base or .md header to tick one or more snippets to apply to that file. Snippets that should apply only to specific files should remain disabled in Obsidian's native Appearance settings."
    });
  }
}

module.exports = ScopedSnippetsPlugin;
