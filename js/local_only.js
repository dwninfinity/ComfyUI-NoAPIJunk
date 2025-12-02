import { app } from "../../scripts/app.js";

app.registerExtension({
	name: "Comfy.LocalOnly",
	init() {
		console.log("[LocalOnly] Initializing extension...");
		// 1. Register Settings
		this.settingId = "Comfy.LocalOnly.Enabled";
		this.blocklistSettingId = "Comfy.LocalOnly.CustomBlocklist";

		app.ui.settings.addSetting({
			id: this.settingId,
			name: "Force Local Only Mode",
			type: "boolean",
			defaultValue: true,
			onChange: (value) => {
				console.log("[LocalOnly] Setting changed:", value);
				this.updateState(value);
			},
		});

		app.ui.settings.addSetting({
			id: this.blocklistSettingId,
			name: "Local Only: Custom Blocklist (comma separated node types)",
			type: "text",
			defaultValue: "",
			onChange: (value) => {
				// No immediate action needed, checked dynamically
			},
		});
	},

	async setup() {
		console.log("[LocalOnly] Setup started.");
		const self = this;

		// Initial state check
		const enabled = app.ui.settings.getSettingValue(this.settingId, true);
		this.updateState(enabled);

		// 2. Patch Search Box to filter results (The "Double Click" menu)
		if (LGraphCanvas && LGraphCanvas.prototype) {
			const originalShowSearchBox = LGraphCanvas.prototype.showSearchBox;
			LGraphCanvas.prototype.showSearchBox = function (event, options) {
				// Force re-check of all nodes before search opens
				if (self.isLocalMode()) {
					console.log("[LocalOnly] Filtering nodes before search...");
					if (LiteGraph.registered_node_types) {
						for (const type in LiteGraph.registered_node_types) {
							const base_class = LiteGraph.registered_node_types[type];
							if (self.isNodeBanned(base_class, type)) {
								base_class.filter = true;
								base_class.hidden = true;
								// Also try to set these flags which some versions might use
								base_class.skip_list = true;
							}
						}
					}
				}
				return originalShowSearchBox.call(this, event, options);
			}
		}

		// 3. Block API Nodes in Node Search / Registration (The "Right Click" menu and general registry)
		const originalRegister = LiteGraph.registerNodeType;
		LiteGraph.registerNodeType = function (type, base_class) {
			if (self.isNodeBanned(base_class, type)) {
				// console.log("[LocalOnly] Banning new node:", type);
				base_class.is_paid_api = true;
				base_class.hidden = true;
				base_class.filter = true;
				base_class.skip_list = true;
			}
			return originalRegister.call(LiteGraph, type, base_class);
		}

		// 3b. Retroactively ban nodes that were already registered
		if (LiteGraph.registered_node_types) {
			for (const type in LiteGraph.registered_node_types) {
				const base_class = LiteGraph.registered_node_types[type];
				if (this.isNodeBanned(base_class, type)) {
					console.log("[LocalOnly] Retroactively banning node:", type);
					base_class.is_paid_api = true;
					base_class.hidden = true;
					base_class.filter = true;
					base_class.skip_list = true;
				}
			}
		}

		// 6. MutationObserver for Vue Search Box, Node Library, Templates Popup, Settings, and Dropdowns
		this.observer = new MutationObserver((mutations) => {
			if (!this.isLocalMode()) return;

			for (const mutation of mutations) {
				for (const node of mutation.addedNodes) {
					if (node.nodeType === 1) { // Element
						// Check if it's the search overlay or list items
						if (node.classList.contains("p-autocomplete-overlay") || node.querySelector(".p-autocomplete-list")) {
							this.filterSearchItems(node);
						}
						// Check for Node Library Tree Nodes
						if (node.classList.contains("p-tree-node")) {
							this.checkAndHideTreeNode(node);
						}
						// Check for Templates Dialog or its content
						if (node.classList.contains("p-dialog-mask") || node.closest(".p-dialog")) {
							this.handleTemplatesDialog(node);
							this.handleSettingsDialog(node);
						}
						// Check for Dropdown/Multiselect Panels (for Use Case filter)
						if (node.classList.contains("p-dropdown-panel") || node.classList.contains("p-multiselect-panel")) {
							this.filterDropdownItems(node);
						}

						// Check for children of added nodes (e.g. if a whole tree section is added)
						if (node.querySelectorAll) {
							const treeNodes = node.querySelectorAll(".p-tree-node");
							for (const treeNode of treeNodes) {
								this.checkAndHideTreeNode(treeNode);
							}
							// Check for template items inside added nodes
							if (node.querySelector("[data-testid^='template-workflow-']")) {
								this.handleTemplatesDialog(node);
							}
							// Check for settings items
							if (node.querySelector(".settings-container")) {
								this.handleSettingsDialog(node);
							}
						}

						// Also check if individual items are added (e.g. lazy loading)
						if (node.classList.contains("p-autocomplete-option")) {
							this.checkAndHideItem(node);
						}
					}
				}
				// Also check if children of existing nodes changed (e.g. list populated)
				if (mutation.type === 'childList') {
					if (mutation.target.classList.contains("p-autocomplete-list")) {
						this.filterSearchItems(mutation.target);
					}
					// Check for Node Library updates
					if (mutation.target.classList.contains("p-tree-node-children") || mutation.target.closest(".p-tree")) {
						const treeNodes = mutation.target.querySelectorAll(".p-tree-node");
						for (const treeNode of treeNodes) {
							this.checkAndHideTreeNode(treeNode);
						}
					}
					// Check for Templates updates
					if (mutation.target.closest(".workflow-template-selector-dialog") || mutation.target.closest("[data-testid='template-workflows-content']")) {
						this.handleTemplatesDialog(mutation.target);
					}
					// Check for Settings updates
					if (mutation.target.closest(".settings-container")) {
						this.handleSettingsDialog(mutation.target);
					}
				}
			}
		});

		this.observer.observe(document.body, { childList: true, subtree: true });
	},

	filterSearchItems(container) {
		const items = container.querySelectorAll(".p-autocomplete-option");
		for (const item of items) {
			this.checkAndHideItem(item);
		}
	},

	filterDropdownItems(panel) {
		const items = panel.querySelectorAll(".p-dropdown-item, .p-multiselect-item");
		for (const item of items) {
			// Hide "API" option in Use Case filter
			if (item.textContent.trim().toLowerCase() === "api") {
				item.style.display = "none";
			}
		}
	},

	checkAndHideTreeNode(node) {
		// Check aria-label (most reliable for Node Library)
		const label = node.getAttribute("aria-label");
		if (label) {
			const lowerLabel = label.toLowerCase();
			const bannedTerms = ["api node", "openai", "gemini", "cloud", "closed source", "sora", "topaz", "minimax", "kling", "bytedance", "ltxv", "luma", "pixverse", "pika", "runway", "stability ai", "tripo", "rodin", "vidu", "wan"];
			if (bannedTerms.some(term => lowerLabel.includes(term))) {
				// console.log("[LocalOnly] Hiding Node Library item:", label);
				node.style.display = "none";
				return;
			}
		}

		// Fallback: Check text content
		const textContent = node.textContent.toLowerCase();
		const bannedTerms = ["api node", "openai", "gemini", "cloud", "closed source"]; // Keep this list smaller to avoid false positives
		if (bannedTerms.some(term => textContent.includes(term))) {
			node.style.display = "none";
		}
	},

	checkAndHideItem(item) {
		// Check Category
		const categoryEl = item.querySelector(".option-category");
		if (categoryEl) {
			const category = categoryEl.textContent.toLowerCase();
			const bannedCategories = ["api", "cloud", "closed source", "openai", "gemini"];
			if (bannedCategories.some(c => category.includes(c))) {
				item.style.display = "none";
				return;
			}
		}

		// Check Name
		const nameEl = item.querySelector(".option-display-name span");
		if (nameEl) {
			const name = nameEl.textContent.toLowerCase();
			// Hardcoded blocklist for known offenders if category fails
			const bannedNames = ["openai", "gemini", "sora", "dall-e", "topaz"];
			if (bannedNames.some(n => name.includes(n))) {
				item.style.display = "none";
			}
		}
	},

	handleSettingsDialog(container) {
		// 1. Hide "User" Tab in Sidebar
		// Selector: li.p-listbox-option[aria-label="User"]
		const userTab = container.querySelector ? container.querySelector('li.p-listbox-option[aria-label="User"]') : null;
		if (userTab) {
			userTab.style.display = "none";
		}
		// Also check all list items if container is larger
		const listItems = container.querySelectorAll ? container.querySelectorAll('li.p-listbox-option') : [];
		for (const item of listItems) {
			if (item.getAttribute("aria-label") === "User") {
				item.style.display = "none";
			}
		}

		// 2. Hide "API Nodes" Section
		// Look for h3 with text "API Nodes" and hide its parent group
		const headers = container.querySelectorAll ? container.querySelectorAll("h3") : [];
		for (const h3 of headers) {
			if (h3.textContent.trim() === "API Nodes") {
				const group = h3.closest(".setting-group");
				if (group) {
					group.style.display = "none";
				}
			}
		}
	},

	handleTemplatesDialog(container) {
		// 1. Hide "Closed Source Models" Category in Sidebar
		// Look for h3 with specific text and hide its parent container
		const headers = container.querySelectorAll ? container.querySelectorAll("h3") : [];
		for (const h3 of headers) {
			if (h3.textContent.trim().toLowerCase() === "closed source models") {
				// The structure is h3 -> div -> div (parent group)
				// Based on file: <div class="flex flex-col gap-2"><div ...><h3 ...>Closed Source Models</h3></div>...</div>
				const parentGroup = h3.closest(".flex.flex-col.gap-2");
				if (parentGroup) {
					parentGroup.style.display = "none";
				}
			}
		}

		// 2. Hide "Partner Nodes" in Sidebar
		const buttons = container.querySelectorAll ? container.querySelectorAll("div[role='button']") : [];
		for (const btn of buttons) {
			if (btn.textContent.trim().includes("Partner Nodes")) {
				// Hide the parent wrapper div (flex flex-col gap-2)
				const parentWrapper = btn.closest(".flex.flex-col.gap-2");
				if (parentWrapper) {
					parentWrapper.style.display = "none";
				} else {
					btn.style.display = "none";
				}
			}
		}

		// 3. Hide API Template Cards
		// Target items with data-testid starting with template-workflow-
		const templates = container.querySelectorAll ? container.querySelectorAll("[data-testid^='template-workflow-']") : [];
		for (const template of templates) {
			const testId = template.getAttribute("data-testid").toLowerCase();
			const bannedIds = ["api_", "openai", "gemini", "sora", "vidu", "wan", "runway", "luma", "kling", "hailuo", "minimax", "topaz", "bytedance", "ltxv", "stability_ai"];

			if (bannedIds.some(id => testId.includes(id))) {
				template.style.display = "none";
				continue;
			}

			// Fallback: Check for "API" badge
			const badges = template.querySelectorAll("span");
			for (const badge of badges) {
				if (badge.textContent.trim() === "API") {
					template.style.display = "none";
					break;
				}
			}
		}
	},

	updateState(enabled) {
		console.log("[LocalOnly] Updating state. Enabled:", enabled);
		const body = document.body;
		if (enabled) {
			body.classList.add("local-only-mode");
			// Force re-check of UI elements
			this.enforceUI();
		} else {
			body.classList.remove("local-only-mode");
		}
	},

	enforceUI() {
		// Fallback: Text-based finding for Templates sidebar
		const navs = document.querySelectorAll("nav");
		for (const nav of navs) {
			if (nav.textContent.includes("Templates") && nav.querySelector(".icon-\\[comfy--template\\]")) {
				nav.style.display = "none";
			}
		}

		// Fallback: Text-based finding for User button
		const buttons = document.querySelectorAll("button, div[role='button']");
		for (const btn of buttons) {
			if (btn.textContent.trim() === "User" || btn.querySelector(".pi-user")) {
				btn.style.display = "none";
			}
		}
	},

	// 4. Block Workflow Loading
	async beforeConfigureGraph(graphData, missingNodeTypes) {
		console.log("[LocalOnly] Checking workflow...");
		const enabled = app.ui.settings.getSettingValue(this.settingId, true);
		if (!enabled) return;

		const bannedNodes = [];
		for (const node of graphData.nodes) {
			const nodeType = LiteGraph.registered_node_types[node.type];
			if (nodeType && this.isNodeBanned(nodeType, node.type)) {
				bannedNodes.push(node.type);
			}
			else if (!nodeType) {
				if (this.isNodeBanned({ category: "" }, node.type)) {
					bannedNodes.push(node.type);
				}
			}
		}

		if (bannedNodes.length > 0) {
			console.warn("[LocalOnly] Blocked workflow with nodes:", bannedNodes);
			alert(`Blocked loading workflow containing API/Cloud nodes:\n${bannedNodes.join("\n")}\n\nDisable "Force Local Only Mode" in settings to allow.`);
			return Promise.reject("Local Only Mode: Blocked API nodes.");
		}
	},

	isLocalMode() {
		return app.ui.settings.getSettingValue(this.settingId, true);
	},

	// 5. Dynamic Checks
	isNodeBanned(nodeClassOrType, typeName) {
		// If we are passed a class/object with metadata
		if (nodeClassOrType.nodeData && nodeClassOrType.nodeData.api_node) return true;
		if (nodeClassOrType.is_paid_api) return true;

		// Check Categories (Case Insensitive)
		const category = (nodeClassOrType.category || nodeClassOrType.CATEGORY || "").toLowerCase();
		const bannedCategories = ["closed source models", "api", "cloud", "openai", "gemini"];
		if (bannedCategories.some(c => category.includes(c))) return true;

		// Check Custom User Blocklist
		const customBlocklist = app.ui.settings.getSettingValue(this.blocklistSettingId, "");
		const blockList = customBlocklist.split(",").map(s => s.trim().toLowerCase()).filter(s => s);
		if (blockList.includes(typeName.toLowerCase())) return true;

		return false;
	}
});
