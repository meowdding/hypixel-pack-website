const REPO_CONFIG = {
  owner: "meowdding",
  repo: "hypixel-pack",
  branchFilter: null,
};

const API_BASE = "https://mrrp-proxy.retreat743.workers.dev/api/gh";
const RAW_BASE = "https://raw.githubusercontent.com";

let branches = [];
let branchCache = {};
let currentBranch = null;
let currentSubPath = "";
const expanded = new Set();
let globalLastCommitDate = null;
let activeCategoryFilter = null;
let viewingGroup = null;
let currentOpenFile = null;

let diffNav = { branch: null, stack: [], index: -1, loading: false };

function matchesCategoryFilter(item) {
  if (!activeCategoryFilter) return true;
  return categoryFor(item.name) === activeCategoryFilter;
}

const els = {
  sidebar: document.getElementById("sidebar"),
  grid: document.getElementById("grid"),
  breadcrumb: document.getElementById("breadcrumb"),
  search: document.getElementById("search"),
  filterBar: document.getElementById("filter-bar"),
  status: document.getElementById("status"),
  lastUpdated: document.getElementById("last-updated"),
  modal: document.getElementById("modal"),
  modalBody: document.getElementById("modal-body"),
};

els.filterBar.addEventListener("click", (e) => {
  const btn = e.target.closest(".filter-btn");
  if (!btn) return;
  activeCategoryFilter = btn.dataset.filter || null;
  els.filterBar.querySelectorAll(".filter-btn").forEach(b => b.classList.toggle("active", b === btn));
  els.search.dispatchEvent(new Event("input"));
});

if (els.lastUpdated) {
  els.lastUpdated.addEventListener("click", () => {
    if (currentBranch) openDiffModal(currentBranch);
  });
}

function updateChangesButton() {
  if (!els.lastUpdated) return;
  els.lastUpdated.classList.toggle("clickable", !!currentBranch);
  els.lastUpdated.title = currentBranch ? "Click to compare with the previous version" : "";
}

function rawUrl(branch, path) {
  const cached = branchCache[branch];
  const ref = cached && cached.sha ? cached.sha : encodeURIComponent(branch);
  return `${RAW_BASE}/${REPO_CONFIG.owner}/${REPO_CONFIG.repo}/${ref}/${path}`;
}

function rawUrlAtSha(sha, path) {
  return `${RAW_BASE}/${REPO_CONFIG.owner}/${REPO_CONFIG.repo}/${sha}/${path}`;
}

// ---------- Data stuff ----------

async function fetchBranches() {
  const cachedBranches = sessionStorage.getItem("gh_branches");
  if (cachedBranches) {
    try {
      branches = JSON.parse(cachedBranches);
      return;
    } catch (e) {
      console.warn("Failed to parse cached branches, re-fetching...");
    }
  }

  const res = await fetch(`${API_BASE}/repos/${REPO_CONFIG.owner}/${REPO_CONFIG.repo}/branches?per_page=100`);
  if (!res.ok) throw new Error(`GitHub API error ${res.status} fetching branches`);
  const all = await res.json();
  let names = all.map(b => b.name);
  
  names = names.filter(n => {
    const cleaned = n.toLowerCase().trim();
    return cleaned !== "main";
  });

  if (REPO_CONFIG.branchFilter) {
    const re = new RegExp(REPO_CONFIG.branchFilter);
    names = names.filter(n => re.test(n));
  }

  names.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }));
  branches = names;

  try {
    sessionStorage.setItem("gh_branches", JSON.stringify(branches));
  } catch (e) {
    console.warn("sessionStorage is full; couldn't cache branches list.", e);
  }
}

async function ensureBranchLoaded(branchName) {
  if (branchCache[branchName]) return branchCache[branchName];

  const cacheKey = `gh_branch_${branchName}`;

  const cachedBranchData = sessionStorage.getItem(cacheKey);
  if (cachedBranchData) {
    try {
      const parsed = JSON.parse(cachedBranchData);
      
      parsed.tree = buildNestedTree(parsed.fileIndex);
      
      branchCache[branchName] = parsed;
      return branchCache[branchName];
    } catch (e) {
      console.warn(`Failed to parse cached data for ${branchName}, re-fetching...`);
    }
  }

  const branchRes = await fetch(`${API_BASE}/repos/${REPO_CONFIG.owner}/${REPO_CONFIG.repo}/branches/${encodeURIComponent(branchName)}`);
  if (!branchRes.ok) {
    if (branchRes.status === 403) throw new Error("GitHub API rate limit hit - try again shortly.");
    throw new Error(`GitHub API error ${branchRes.status} resolving branch "${branchName}"`);
  }
  const branchData = await branchRes.json();
  const sha = branchData.commit.sha;
  
  const date = branchData.commit?.commit?.committer?.date || branchData.commit?.commit?.author?.date || null;

  const treeUrl = `${API_BASE}/repos/${REPO_CONFIG.owner}/${REPO_CONFIG.repo}/git/trees/${sha}?recursive=1`;
  const res = await fetch(treeUrl);
  if (!res.ok) {
    if (res.status === 403) throw new Error("GitHub API rate limit hit - try again shortly.");
    throw new Error(`GitHub API error ${res.status} for branch "${branchName}"`);
  }
  const data = await res.json();
  if (data.truncated) console.warn(`Tree for "${branchName}" was truncated by GitHub (very large branch).`);
  
  const fileIndex = data.tree
    .filter(e => e.type === "blob")
    .map(e => ({ path: e.path, size: e.size, name: e.path.split("/").pop() }));
    
  const tree = buildNestedTree(fileIndex);
  
  branchCache[branchName] = { tree, fileIndex, sha, date };

  try {
    sessionStorage.setItem(cacheKey, JSON.stringify({ fileIndex, sha, date }));
  } catch (e) {
    console.warn(`sessionStorage is still full; couldn't cache tree for ${branchName}.`, e);
  }

  return branchCache[branchName];
}

function buildNestedTree(files) {
  const root = { __dirs: {}, __files: [] };
  for (const f of files) {
    const parts = f.path.split("/");
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      if (!node.__dirs[part]) node.__dirs[part] = { __dirs: {}, __files: [] };
      node = node.__dirs[part];
    }
    node.__files.push(f);
  }
  return root;
}

function nodeAtPath(tree, path) {
  if (!path) return tree;
  let node = tree;
  for (const part of path.split("/")) {
    if (!node || !node.__dirs[part]) return null;
    node = node.__dirs[part];
  }
  return node;
}

function categoryFor(name) {
  const ext = name.includes(".") ? name.split(".").pop().toLowerCase() : "";
  if (["png", "jpg", "jpeg", "gif"].includes(ext)) return "image";
  if (["ogg", "wav", "mp3"].includes(ext)) return "audio";
  if (["json", "mcmeta"].includes(ext)) return "json";
  return "text";
}

function groupBranchName(name) {
  const idx = name.indexOf("/");
  return idx === -1 ? null : name.slice(0, idx);
}

function getBranchGroups(list) {
  const groups = {};
  const standalone = [];
  for (const b of list) {
    const prefix = groupBranchName(b);
    if (prefix) {
      (groups[prefix] = groups[prefix] || []).push(b);
    } else {
      standalone.push(b);
    }
  }
  return { groups, standalone };
}

// ---------- Routing ----------

function encodeHashSegment(str) {
  return str.split('/').map(encodeURIComponent).join('/');
}

function parseHash() {
  let raw = location.hash.replace(/^#\/?/, "");
  if (!raw) return { branch: null, subPath: "", diff: null };

  let diff = null;
  const qIndex = raw.indexOf("?");
  if (qIndex !== -1) {
    const query = new URLSearchParams(raw.slice(qIndex + 1));
    diff = query.get("diff");
    raw = raw.slice(0, qIndex);
  }

  if (!raw) return { branch: null, subPath: "", diff };

  const decodedRaw = raw.split('/').map(decodeURIComponent).join('/');

  const sortedBranches = [...branches].sort((a, b) => b.length - a.length);
  for (const b of sortedBranches) {
    if (decodedRaw === b) {
      return { branch: b, subPath: "", diff };
    }
    if (decodedRaw.startsWith(b + "/")) {
      return { branch: b, subPath: decodedRaw.slice(b.length + 1), diff };
    }
  }

  const parts = decodedRaw.split("/");
  
  if (parts.length > 1 && parts[0].toLowerCase() === "alpha") {
    return {
      branch: `${parts[0]}/${parts[1]}`,
      subPath: parts.slice(2).join("/"),
      diff
    };
  }

  return { 
    branch: parts[0], 
    subPath: parts.slice(1).join("/"),
    diff
  };
}

function fileHash(branch, item) {
  return `#/${encodeHashSegment(branch)}/${encodeHashSegment(item.path)}`;
}

function buildFileLink(branch, item) {
  return `${location.origin}${location.pathname}${fileHash(branch, item)}`;
}

function setHashSilently(hash, { push = true } = {}) {
  const url = location.pathname + location.search + hash;
  if (push) history.pushState(null, "", url);
  else history.replaceState(null, "", url);
}

function folderHash(branch, subPath) {
  let hash = `#/${encodeHashSegment(branch)}`;
  if (subPath) hash += `/${encodeHashSegment(subPath)}`;
  return hash;
}

function navigateTo(branch, subPath = "") {
  if (!branch) {
    if (location.hash !== "#/") location.hash = "#/";
    return;
  }

  let hash = `#/${encodeHashSegment(branch)}`;
  if (subPath) {
    hash += `/${encodeHashSegment(subPath)}`;
  }

  if (location.hash === hash) { 
    handleRoute(); 
  } else { 
    location.hash = hash; 
  }
}

window.addEventListener("hashchange", handleRoute);

async function handleRoute() {
    closeModal(false);
    const { branch, subPath, diff } = parseHash();
    currentBranch = branch;
    els.search.value = "";

    if (!branch) {
        viewingGroup = null;
        currentSubPath = "";
        renderRootBranchList();
        updateChangesButton();
        return;
    }

    viewingGroup = null;
    els.status.textContent = `Loading ${branch}...`;
    try {
        await ensureBranchLoaded(branch);

        let dirPath = subPath;
        let fileToOpen = null;
        if (subPath && !nodeAtPath(branchCache[branch].tree, subPath)) {
            const match = branchCache[branch].fileIndex.find(f => f.path === subPath);
            if (match) {
                const lastSlash = subPath.lastIndexOf("/");
                dirPath = lastSlash === -1 ? "" : subPath.slice(0, lastSlash);
                fileToOpen = match;
            }
        }
        currentSubPath = dirPath;

        els.status.textContent = `${branchCache[branch].fileIndex.length} files in ${branch}`;
        renderLastUpdated(branchCache[branch].date);
        updateChangesButton();
        renderBreadcrumb();
        ensureSidebarExpanded(branch, dirPath);
        renderSidebar();
        const activeRow = els.sidebar.querySelector(".tree-row.active");
        if (activeRow) activeRow.scrollIntoView({ block: "nearest" });
        const node = nodeAtPath(branchCache[branch].tree, dirPath);
        renderGrid(node || branchCache[branch].tree, branch);

        if (diff) {
            const [base, head] = diff.split("...");
            if (base && head) openDiffModal(branch, base, head);
        } else if (fileToOpen) {
            openDetail(branch, fileToOpen, categoryFor(fileToOpen.name));
        }
    } catch (e) {
        console.error(e);
        els.status.textContent = `Couldn't load "${branch}"`;
        els.grid.innerHTML = `<div class="empty">Couldn't load this version.</div>`;
        if (els.lastUpdated) {
            els.lastUpdated.classList.remove("clickable");
            els.lastUpdated.title = "";
        }
    }
}

// ---------- Sidebar ----------

function ensureSidebarExpanded(branch, subPath) {
  expanded.add(branch);
  const groupPrefix = groupBranchName(branch);
  if (groupPrefix) expanded.add(`group:${groupPrefix}`);
  if (!subPath) return;
  const parts = subPath.split("/");
  let acc = "";
  for (const part of parts) {
    acc = acc ? `${acc}/${part}` : part;
    expanded.add(`${branch}/${acc}`);
  }
}

function renderSidebar() {
  els.sidebar.innerHTML = "";
  const rootUl = document.createElement("ul");
  const rootLi = document.createElement("li");

  const rootRow = document.createElement("div");
  rootRow.className = "tree-row" + (!currentBranch ? " active" : "");
  rootRow.onclick = () => navigateTo(null);
  const spacer = document.createElement("span");
  spacer.className = "tree-caret";
  rootRow.appendChild(spacer);
  const rootLabel = document.createElement("span");
  rootLabel.textContent = REPO_CONFIG.repo;
  rootRow.appendChild(rootLabel);
  rootLi.appendChild(rootRow);

  const branchUl = document.createElement("ul");
  const { groups } = getBranchGroups(branches);
  const seenGroups = new Set();
  for (const b of branches) {
    const prefix = groupBranchName(b);
    if (prefix) {
      if (seenGroups.has(prefix)) continue;
      seenGroups.add(prefix);
      branchUl.appendChild(makeBranchGroupNode(prefix, groups[prefix]));
    } else {
      branchUl.appendChild(makeBranchNode(b));
    }
  }
  rootLi.appendChild(branchUl);
  rootUl.appendChild(rootLi);
  els.sidebar.appendChild(rootUl);
}

function makeBranchNode(branchName, displayLabel) {
  const li = document.createElement("li");
  const row = document.createElement("div");
  row.className = "tree-row" + (currentBranch === branchName && !currentSubPath ? " active" : "");

  const isOpen = expanded.has(branchName);
  const caret = document.createElement("span");
  caret.className = "tree-caret" + (isOpen ? " open" : "");
  caret.textContent = "▸";

  async function toggleBranchExpand() {
    if (expanded.has(branchName)) {
      expanded.delete(branchName);
      renderSidebar();
      return;
    }
    caret.textContent = "...";
    try {
      await ensureBranchLoaded(branchName);
      expanded.add(branchName);
      renderSidebar();
    } catch (err) {
      console.error(err);
      caret.textContent = "▸";
    }
  }

  row.onclick = () => {
    if (currentBranch === branchName && !currentSubPath) {
      toggleBranchExpand();
    } else {
      navigateTo(branchName);
    }
  };
  caret.onclick = (e) => {
    e.stopPropagation();
    toggleBranchExpand();
  };
  row.appendChild(caret);

  const label = document.createElement("span");
  label.textContent = "📁 " + (displayLabel || branchName);
  row.appendChild(label);
  li.appendChild(row);

  if (isOpen && branchCache[branchName]) {
    const ul = document.createElement("ul");
    const dirNames = Object.keys(branchCache[branchName].tree.__dirs).sort();
    for (const name of dirNames) ul.appendChild(makeDirTreeNode(branchName, name, name));
    li.appendChild(ul);
  }
  return li;
}

function makeBranchGroupNode(prefix, branchList) {
  const key = `group:${prefix}`;
  const li = document.createElement("li");
  const row = document.createElement("div");
  row.className = "tree-row" + (viewingGroup === prefix ? " active" : "");

  const isOpen = expanded.has(key);
  const caret = document.createElement("span");
  caret.className = "tree-caret" + (isOpen ? " open" : "");
  caret.textContent = "▸";

  function toggleGroupExpand() {
    if (expanded.has(key)) expanded.delete(key); else expanded.add(key);
    renderSidebar();
  }

  row.onclick = toggleGroupExpand;
  caret.onclick = (e) => {
    e.stopPropagation();
    toggleGroupExpand();
  };
  row.appendChild(caret);

  const label = document.createElement("span");
  label.textContent = "📁 " + prefix;
  row.appendChild(label);
  li.appendChild(row);

  if (isOpen) {
    const ul = document.createElement("ul");
    for (const b of branchList) {
      ul.appendChild(makeBranchNode(b, b.slice(prefix.length + 1)));
    }
    li.appendChild(ul);
  }
  return li;
}

function makeDirTreeNode(branchName, path, label) {
  const key = `${branchName}/${path}`;
  const li = document.createElement("li");
  const row = document.createElement("div");
  row.className = "tree-row" + (currentBranch === branchName && currentSubPath === path ? " active" : "");

  const node = nodeAtPath(branchCache[branchName].tree, path);
  const dirNames = node ? Object.keys(node.__dirs).sort() : [];
  const isOpen = expanded.has(key);

  function toggleDirExpand() {
    if (!dirNames.length) return;
    if (expanded.has(key)) expanded.delete(key); else expanded.add(key);
    renderSidebar();
  }

  row.onclick = () => {
    if (currentBranch === branchName && currentSubPath === path) {
      toggleDirExpand();
    } else {
      navigateTo(branchName, path);
    }
  };

  if (dirNames.length) {
    const caret = document.createElement("span");
    caret.className = "tree-caret" + (isOpen ? " open" : "");
    caret.textContent = "▸";
    caret.onclick = (e) => {
      e.stopPropagation();
      toggleDirExpand();
    };
    row.appendChild(caret);
  } else {
    const spacer = document.createElement("span");
    spacer.className = "tree-caret";
    row.appendChild(spacer);
  }

  const labelSpan = document.createElement("span");
  labelSpan.textContent = "📁 " + label;
  row.appendChild(labelSpan);
  li.appendChild(row);

  if (isOpen && dirNames.length) {
    const ul = document.createElement("ul");
    for (const name of dirNames) ul.appendChild(makeDirTreeNode(branchName, `${path}/${name}`, name));
    li.appendChild(ul);
  }
  return li;
}

// ---------- Breadcrumb ----------

function renderBreadcrumb() {
  els.breadcrumb.innerHTML = "";
  const rootCrumb = document.createElement("span");
  rootCrumb.className = "crumb";
  rootCrumb.textContent = REPO_CONFIG.repo;
  rootCrumb.onclick = () => navigateTo(null);
  els.breadcrumb.appendChild(rootCrumb);

  addCrumbSep();
  const branchCrumb = document.createElement("span");
  branchCrumb.className = "crumb";
  branchCrumb.textContent = currentBranch;
  branchCrumb.onclick = () => navigateTo(currentBranch);
  els.breadcrumb.appendChild(branchCrumb);

  const parts = currentSubPath ? currentSubPath.split("/") : [];
  let acc = "";
  for (const part of parts) {
    acc = acc ? `${acc}/${part}` : part;
    addCrumbSep();
    const c = document.createElement("span");
    c.className = "crumb";
    c.textContent = part;
    const p = acc;
    c.onclick = () => navigateTo(currentBranch, p);
    els.breadcrumb.appendChild(c);
  }
}

// ---------- Grid ----------

function renderRootBranchList(filterQuery = "") {
  renderSidebar();
  els.grid.innerHTML = "";
  
  els.status.textContent = `${branches.length} versions available`;
  
  if (globalLastCommitDate) {
    renderLastUpdated(globalLastCommitDate);
  } else if (els.lastUpdated) {
    els.lastUpdated.textContent = "";
  }

  const q = filterQuery.trim().toLowerCase();
  if (q) {
    viewingGroup = null;
    renderBreadcrumbRoot();
    const list = branches.filter(b => b.toLowerCase().includes(q));
    if (!list.length) {
      els.grid.innerHTML = `<div class="empty">No versions match.</div>`;
      return;
    }
    for (const b of list) {
      const slot = document.createElement("div");
      slot.className = "slot slot-branch";
      slot.innerHTML = `<div class="slot-preview">📁</div><div class="slot-label">${escapeHtml(b)}</div>`;
      slot.onclick = () => navigateTo(b);
      els.grid.appendChild(slot);
    }
    return;
  }

  if (viewingGroup) {
    renderGroupCrumb(viewingGroup);
    const branchesInGroup = branches.filter(b => groupBranchName(b) === viewingGroup);
    els.status.textContent = `${branchesInGroup.length} versions in ${viewingGroup}`;
    if (!branchesInGroup.length) {
      els.grid.innerHTML = `<div class="empty">No versions here.</div>`;
      return;
    }
    for (const b of branchesInGroup) {
      const slot = document.createElement("div");
      slot.className = "slot slot-branch";
      const suffix = b.slice(viewingGroup.length + 1);
      slot.innerHTML = `<div class="slot-preview">📁</div><div class="slot-label">${escapeHtml(suffix)}</div>`;
      slot.onclick = () => navigateTo(b);
      els.grid.appendChild(slot);
    }
    return;
  }

  renderBreadcrumbRoot();
  const { groups, standalone } = getBranchGroups(branches);
  const groupNames = Object.keys(groups).sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }));

  if (!groupNames.length && !standalone.length) {
    els.grid.innerHTML = `<div class="empty">No versions match.</div>`;
    return;
  }

  for (const g of groupNames) {
    const slot = document.createElement("div");
    slot.className = "slot slot-dir";
    slot.innerHTML = `<div class="slot-preview">📁</div><div class="slot-label">${escapeHtml(g)}</div>`;
    slot.onclick = () => {
      viewingGroup = g;
      expanded.add(`group:${g}`);
      renderRootBranchList();
    };
    els.grid.appendChild(slot);
  }
  for (const b of standalone) {
    const slot = document.createElement("div");
    slot.className = "slot slot-branch";
    slot.innerHTML = `<div class="slot-preview">📁</div><div class="slot-label">${escapeHtml(b)}</div>`;
    slot.onclick = () => navigateTo(b);
    els.grid.appendChild(slot);
  }
}

function renderBreadcrumbRoot() {
  els.breadcrumb.innerHTML = "";
  const rootCrumb = document.createElement("span");
  rootCrumb.className = "crumb";
  rootCrumb.textContent = REPO_CONFIG.repo;
  els.breadcrumb.appendChild(rootCrumb);
}

function renderGroupCrumb(group) {
  els.breadcrumb.innerHTML = "";
  const rootCrumb = document.createElement("span");
  rootCrumb.className = "crumb";
  rootCrumb.textContent = REPO_CONFIG.repo;
  rootCrumb.onclick = () => {
    viewingGroup = null;
    renderRootBranchList();
  };
  els.breadcrumb.appendChild(rootCrumb);

  addCrumbSep();
  const groupCrumb = document.createElement("span");
  groupCrumb.className = "crumb";
  groupCrumb.textContent = group;
  els.breadcrumb.appendChild(groupCrumb);
}

function addCrumbSep() {
  const sep = document.createElement("span");
  sep.className = "crumb-sep";
  sep.textContent = "›";
  els.breadcrumb.appendChild(sep);
}

function renderGrid(node, branch) {
  els.grid.innerHTML = "";
  const dirNames = Object.keys(node.__dirs).sort();
  const files = [...node.__files]
    .filter(matchesCategoryFilter)
    .sort((a, b) => a.name.localeCompare(b.name));

  for (const name of dirNames) els.grid.appendChild(makeDirSlot(branch, name));
  for (const f of files) els.grid.appendChild(makeFileSlot(branch, f));
  if (!dirNames.length && !files.length) {
    els.grid.innerHTML = `<div class="empty">Nothing here.</div>`;
  }
}

function makeDirSlot(branch, name) {
  const slot = document.createElement("div");
  slot.className = "slot slot-dir";
  slot.innerHTML = `<div class="slot-preview">📁</div><div class="slot-label">${escapeHtml(name)}</div>`;
  slot.onclick = () => navigateTo(branch, currentSubPath ? `${currentSubPath}/${name}` : name);
  return slot;
}

const CAT_ICONS = { audio: "🔊", json: "{ }", text: "📄" };

function makeFileSlot(branch, item) {
  const cat = categoryFor(item.name);
  const slot = document.createElement("div");
  slot.className = `slot slot-${cat}`;
  if (cat === "image") {
    slot.innerHTML = `<div class="slot-preview checker"><img loading="lazy" src="${rawUrl(branch, item.path)}" alt="${escapeHtml(item.name)}"></div><div class="slot-label">${escapeHtml(item.name)}</div>`;
  } else {
    slot.innerHTML = `<div class="slot-preview icon-preview">${CAT_ICONS[cat]}</div><div class="slot-label">${escapeHtml(item.name)}</div>`;
  }
  slot.onclick = () => openDetail(branch, item, cat);
  return slot;
}

// ---------- Search ----------

els.search.addEventListener("input", () => {
  const q = els.search.value.trim().toLowerCase();

  if (!currentBranch) {
    renderRootBranchList(els.search.value);
    return;
  }

  if (!q) {
    renderBreadcrumb();
    renderGrid(nodeAtPath(branchCache[currentBranch].tree, currentSubPath) || branchCache[currentBranch].tree, currentBranch);
    return;
  }

  els.breadcrumb.innerHTML = `<span class="crumb">${escapeHtml(currentBranch)} · search "${escapeHtml(els.search.value)}"</span>`;
  const matches = branchCache[currentBranch].fileIndex
    .filter(f => f.name.toLowerCase().includes(q))
    .filter(matchesCategoryFilter)
    .slice(0, 300);
  els.grid.innerHTML = "";
  if (!matches.length) {
    els.grid.innerHTML = `<div class="empty">No files match.</div>`;
    return;
  }
  for (const f of matches) {
    const slot = makeFileSlot(currentBranch, f);
    const pathTag = document.createElement("div");
    pathTag.className = "slot-label";
    pathTag.style.display = "block";
    pathTag.style.opacity = "0.6";
    pathTag.textContent = f.path;
    slot.appendChild(pathTag);
    els.grid.appendChild(slot);
  }
});

// ---------- Modal ----------

function formatSize(bytes) {
  if (bytes == null) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function syntaxHighlight(jsonStr) {
  let json = jsonStr.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  
  return json.replace(/("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g, function (match) {
    let cls = 'json-number';
    if (/^"/.test(match)) {
      if (/:$/.test(match)) {
        cls = 'json-key';
      } else {
        cls = 'json-string';
      }
    } else if (/true|false/.test(match)) {
      cls = 'json-boolean';
    } else if (/null/.test(match)) {
      cls = 'json-null';
    }
    return `<span class="${cls}">${match}</span>`;
  });
}

async function openDetail(branch, item, cat) {
    els.modal.classList.add("open");
    els.modal.setAttribute("aria-hidden", "false");
    els.modalBody.innerHTML = `<div class="modal-loading">Loading...</div>`;

    const targetHash = fileHash(branch, item);
    if (location.hash !== targetHash) setHashSilently(targetHash);
    currentOpenFile = { branch, subPath: currentSubPath };

    const url = rawUrl(branch, item.path);
    let previewHtml = "";

    if (cat === "image") {
        previewHtml = `<img class="modal-image" src="${url}" width="100px" alt="${escapeHtml(item.name)}">`;
    } else if (cat === "audio") {
        previewHtml = `<audio controls autoplay src="${url}"></audio>`;
    } else {
        try {
        const res = await fetch(url);
        const text = await res.text();
        
        if (cat === "json") {
            try {
            const parsed = JSON.parse(text);
            const pretty = JSON.stringify(parsed, null, 2);
            previewHtml = `<pre class="modal-text">${syntaxHighlight(pretty)}</pre>`;
            } catch (err) {
            previewHtml = `<pre class="modal-text">${escapeHtml(text.slice(0, 20000))}</pre>`;
            }
        } else {
            previewHtml = `<pre class="modal-text">${escapeHtml(text.slice(0, 20000))}</pre>`;
        }
        } catch (e) {
        previewHtml = `<div class="modal-error">Couldn't load file contents.</div>`;
        }
    }

  const pageLink = buildFileLink(branch, item);

  els.modalBody.innerHTML = `
    <div class="modal-title">${escapeHtml(item.name)}</div>
    <div class="modal-path">${escapeHtml(branch)} / ${escapeHtml(item.path)}${item.size != null ? ` · ${formatSize(item.size)}` : ""}</div>
    <div class="modal-preview">${previewHtml}</div>
    <div class="modal-actions">
      <button type="button" class="modal-copy-page-link">Copy link</button>
      <a href="${url}" download="${item.name}">Download</a>
      <button type="button" data-copy="${url}">Copy raw link</button>
      <a href="${url}" target="_blank" rel="noopener">Open raw</a>
    </div>
  `;
  const copyBtn = els.modalBody.querySelector("[data-copy]");
  copyBtn.onclick = () => {
    navigator.clipboard.writeText(copyBtn.dataset.copy);
    copyBtn.textContent = "Copied!";
    setTimeout(() => (copyBtn.textContent = "Copy raw link"), 1500);
  };
  const copyPageLinkBtn = els.modalBody.querySelector(".modal-copy-page-link");
  copyPageLinkBtn.onclick = async () => {
    const ok = await copyTextToClipboard(pageLink);
    copyPageLinkBtn.textContent = ok ? "Copied!" : "Couldn't copy";
    setTimeout(() => (copyPageLinkBtn.textContent = "Copy link"), 1500);
  };
}

// ---------- Diff ----------

async function copyTextToClipboard(text) {
  if (window.isSecureContext && navigator.clipboard && navigator.clipboard.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (e) {
      console.warn("Failed to copy.", e);
    }
  }
}

function getImgDiff(oldUrl, newUrl) {
  const oldImg = new Image();
  const newImg = new Image();
  oldImg.crossOrigin = "anonymous";
  newImg.crossOrigin = "anonymous";

  return Promise.all([
      new Promise(resolve => {
          oldImg.onload = resolve;
          oldImg.src = oldUrl;
      }),
      new Promise(resolve => {
          newImg.onload = resolve;
          newImg.src = newUrl;
      })
  ]).then(() => {
    const url = compareImages(oldImg, newImg);
    return url;
  });
}

function compareImages(oldImg, newImg) {
  const width = oldImg.width;
  const height = oldImg.height;

  const oldCanvas = document.createElement("canvas");
  const newCanvas = document.createElement("canvas");
  const diffCanvas = document.createElement("canvas");

  oldCanvas.width = newCanvas.width = diffCanvas.width = width;
  oldCanvas.height = newCanvas.height = diffCanvas.height = height;

  const oldCtx = oldCanvas.getContext("2d");
  const newCtx = newCanvas.getContext("2d");
  const diffCtx = diffCanvas.getContext("2d");

  oldCtx.drawImage(oldImg, 0, 0);
  newCtx.drawImage(newImg, 0, 0);
  const oldData = oldCtx.getImageData(0, 0, width, height);
  const newData = newCtx.getImageData(0, 0, width, height);
  const diffData = diffCtx.createImageData(width, height);

  for (let i = 0; i < oldData.data.length; i += 4) {
    const same =
      oldData.data[i] === newData.data[i] &&
      oldData.data[i+1] === newData.data[i + 1] &&
      oldData.data[i+2] === newData.data[i + 2] &&
      oldData.data[i+3] === newData.data[i + 3];
    if (same) {
      // Semi-transparent
      diffData.data[i] = oldData.data[i];
      diffData.data[i+1] = oldData.data[i+1];
      diffData.data[i+2] = oldData.data[i+2];
      diffData.data[i+3] = Math.round(oldData.data[i+3] / 2);
    } else {
      // Magenta
      diffData.data[i] = 255;
      diffData.data[i+1] = 0;
      diffData.data[i+2] = 255;
      diffData.data[i+3] = 255;
    }
  }
  diffCtx.putImageData(diffData, 0, 0);
  return diffCanvas.toDataURL("image/png");
}

async function openDiffModal(branch, explicitBase = null, explicitHead = null) {
  const data = branchCache[branch];
  if (!data) return;

  els.modal.classList.add("open");
  els.modal.setAttribute("aria-hidden", "false");

  diffNav = { branch, stack: [], index: -1, loading: false };

  const currentSha = explicitHead || data.sha;
  let parentSha = explicitBase;
  let headDate = null;

  try {
    els.modalBody.innerHTML = `<div class="modal-loading">${parentSha ? "Comparing versions..." : "Finding the previous version..."}</div>`;
    const commitRes = await fetch(`${API_BASE}/repos/${REPO_CONFIG.owner}/${REPO_CONFIG.repo}/commits/${currentSha}`);
    if (!commitRes.ok) {
      if (commitRes.status === 403) throw new Error("GitHub API rate limit hit - try again shortly.");
      throw new Error(`GitHub API error ${commitRes.status} resolving commit history`);
    }
    const commit = await commitRes.json();
    headDate = (commit.commit && (commit.commit.committer?.date || commit.commit.author?.date)) || null;

    if (!parentSha) {
      parentSha = commit.parents && commit.parents[0] && commit.parents[0].sha;
      if (!parentSha) {
        els.modalBody.innerHTML = `<div class="empty">This is the first version of this branch - nothing to compare against.</div>`;
        return;
      }
    }

    els.modalBody.innerHTML = `<div class="modal-loading">Comparing versions...</div>`;
    const res = await fetch(`${API_BASE}/repos/${REPO_CONFIG.owner}/${REPO_CONFIG.repo}/compare/${parentSha}...${currentSha}`);
    if (!res.ok) {
      if (res.status === 403) throw new Error("GitHub API rate limit hit - try again shortly.");
      throw new Error(`GitHub API error ${res.status} comparing versions`);
    }
    const cmp = await res.json();
    const targetEntry = { base: parentSha, head: currentSha, headDate, cmp, noOlder: undefined };
    diffNav.stack = [targetEntry];
    diffNav.index = 0;

    if (currentSha !== data.sha) {
      try {
        const aheadRes = await fetch(`${API_BASE}/repos/${REPO_CONFIG.owner}/${REPO_CONFIG.repo}/compare/${currentSha}...${data.sha}`);
        if (aheadRes.ok) {
          const ahead = await aheadRes.json();
          const commits = ahead.commits || [];
          const newerEntries = [];
          let prevSha = currentSha;
          for (const c of commits) {
            newerEntries.push({
              base: prevSha,
              head: c.sha,
              headDate: (c.commit && (c.commit.committer?.date || c.commit.author?.date)) || null,
              cmp: null,
              noOlder: undefined,
            });
            prevSha = c.sha;
          }
          newerEntries.reverse();
          diffNav.stack = [...newerEntries, targetEntry];
          diffNav.index = newerEntries.length;
        }
      } catch (e) {
        console.warn("Couldn't reconstruct newer commits for this diff link.", e);
      }
    }

    renderDiff(branch, cmp, parentSha, currentSha, headDate);
  } catch (e) {
    console.error(e);
    els.modalBody.innerHTML = `<div class="modal-error">${escapeHtml(e.message || "Couldn't load the diff.")}</div>`;
  }
}

async function goOlderDiff() {
  const nav = diffNav;
  if (nav.loading || nav.index === -1) return;
  const current = nav.stack[nav.index];
  if (current.noOlder) return;
  const branch = nav.branch;

  const nextIndex = nav.index + 1;
  if (nav.stack[nextIndex]) {
    nav.index = nextIndex;
    const entry = nav.stack[nextIndex];
    renderDiff(branch, entry.cmp, entry.base, entry.head, entry.headDate);
    return;
  }

  nav.loading = true;
  updateDiffNavButtons();

  try {
    const commitRes = await fetch(`${API_BASE}/repos/${REPO_CONFIG.owner}/${REPO_CONFIG.repo}/commits/${current.base}`);
    if (!commitRes.ok) {
      if (commitRes.status === 403) throw new Error("GitHub API rate limit hit - try again shortly.");
      throw new Error(`GitHub API error ${commitRes.status} resolving commit history`);
    }
    const commit = await commitRes.json();
    const newHeadDate = (commit.commit && (commit.commit.committer?.date || commit.commit.author?.date)) || null;
    const newBase = commit.parents && commit.parents[0] && commit.parents[0].sha;

    if (!newBase) {
      current.noOlder = true;
      nav.loading = false;
      updateDiffNavButtons();
      return;
    }

    const res = await fetch(`${API_BASE}/repos/${REPO_CONFIG.owner}/${REPO_CONFIG.repo}/compare/${newBase}...${current.base}`);
    if (!res.ok) {
      if (res.status === 403) throw new Error("GitHub API rate limit hit - try again shortly.");
      throw new Error(`GitHub API error ${res.status} comparing versions`);
    }
    const cmp = await res.json();

    if (diffNav.branch !== branch) return;

    nav.stack.push({ base: newBase, head: current.base, headDate: newHeadDate, cmp, noOlder: undefined });
    nav.index = nextIndex;
    nav.loading = false;
    renderDiff(branch, cmp, newBase, current.base, newHeadDate);
  } catch (e) {
    console.error(e);
    nav.loading = false;
    updateDiffNavButtons();
    els.modalBody.insertAdjacentHTML("beforeend",
      `<div class="modal-error">${escapeHtml(e.message || "Couldn't load the previous commit.")}</div>`);
  }
}

async function goNewerDiff() {
  const nav = diffNav;
  if (nav.loading || nav.index <= 0) return;
  const branch = nav.branch;
  const targetIndex = nav.index - 1;
  const entry = nav.stack[targetIndex];

  if (entry.cmp) {
    nav.index = targetIndex;
    renderDiff(branch, entry.cmp, entry.base, entry.head, entry.headDate);
    return;
  }

  nav.loading = true;
  updateDiffNavButtons();

  try {
    const res = await fetch(`${API_BASE}/repos/${REPO_CONFIG.owner}/${REPO_CONFIG.repo}/compare/${entry.base}...${entry.head}`);
    if (!res.ok) {
      if (res.status === 403) throw new Error("GitHub API rate limit hit - try again shortly.");
      throw new Error(`GitHub API error ${res.status} comparing versions`);
    }
    const cmp = await res.json();

    if (diffNav.branch !== branch) return;

    entry.cmp = cmp;
    nav.index = targetIndex;
    nav.loading = false;
    renderDiff(branch, cmp, entry.base, entry.head, entry.headDate);
  } catch (e) {
    console.error(e);
    nav.loading = false;
    updateDiffNavButtons();
    els.modalBody.insertAdjacentHTML("beforeend",
      `<div class="modal-error">${escapeHtml(e.message || "Couldn't load the next commit.")}</div>`);
  }
}

function updateDiffNavButtons() {
  const olderBtn = els.modalBody.querySelector(".diff-nav-older");
  const newerBtn = els.modalBody.querySelector(".diff-nav-newer");
  const current = diffNav.stack[diffNav.index];
  if (olderBtn) {
    olderBtn.disabled = diffNav.loading || !current || current.noOlder === true;
    olderBtn.textContent = diffNav.loading ? "Loading..." : "‹ Older";
  }
  if (newerBtn) {
    newerBtn.disabled = diffNav.loading || diffNav.index <= 0;
  }
}

async function checkOlderAvailability(entry, branch) {
  if (!entry || entry.noOlder !== undefined || entry.checkingOlder) return;
  entry.checkingOlder = true;
  try {
    const commitRes = await fetch(`${API_BASE}/repos/${REPO_CONFIG.owner}/${REPO_CONFIG.repo}/commits/${entry.base}`);
    if (!commitRes.ok) return; 
    const commit = await commitRes.json();
    const hasParent = !!(commit.parents && commit.parents[0] && commit.parents[0].sha);
    entry.noOlder = !hasParent;
  } catch (e) {

  } finally {
    entry.checkingOlder = false;
    if (diffNav.branch === branch && diffNav.stack[diffNav.index] === entry) {
      updateDiffNavButtons();
    }
  }
}

const DIFF_STATUS_BADGE = { added: "+", removed: "-", modified: "±", renamed: "→", changed: "±" };

function renderDiff(branch, cmp, parentSha, currentSha, headDate) {
  const files = cmp.files || [];
  const dateLabel = headDate
    ? new Date(headDate).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
    : null;
  const title = `Changes on ${dateLabel} to ${escapeHtml(branch)}`;

  els.modalBody.innerHTML = `
    <div class="modal-title">${title}</div>
    <div class="modal-path">${escapeHtml(branch)}</div>
    <div class="diff-toolbar">
      <div class="diff-summary">${files.length} file${files.length === 1 ? "" : "s"} changed</div>
      <div class="diff-toolbar-actions">
        <button type="button" class="diff-nav-older" title="See the previous commit's diff">‹ Older</button>
        <button type="button" class="diff-nav-newer" title="Back to the more recent diff">Newer ›</button>
        <button type="button" class="diff-toggle-all" data-action="expand">Expand all</button>
        <button type="button" class="diff-toggle-all" data-action="collapse">Collapse all</button>
        <button type="button" class="diff-copy-link">Copy link</button>
      </div>
    </div>
  `;

  els.modalBody.querySelector(".diff-nav-older").onclick = goOlderDiff;
  els.modalBody.querySelector(".diff-nav-newer").onclick = goNewerDiff;
  updateDiffNavButtons();

  const activeEntry = diffNav.stack[diffNav.index];
  if (activeEntry && activeEntry.base === parentSha && activeEntry.head === currentSha) {
    checkOlderAvailability(activeEntry, branch);
  }

  const copyLinkBtn = els.modalBody.querySelector(".diff-copy-link");
  if (copyLinkBtn) {
    copyLinkBtn.onclick = async () => {
      const hash = `#/${encodeHashSegment(branch)}?diff=${parentSha.slice(0, 6)}...${currentSha.slice(0, 6)}`;
      const url = `${location.origin}${location.pathname}${hash}`;
      const originalText = copyLinkBtn.textContent;
      const ok = await copyTextToClipboard(url);
      copyLinkBtn.textContent = ok ? "Copied!" : "Couldn't copy";
      setTimeout(() => { copyLinkBtn.textContent = originalText; }, 1800);
    };
  }

  if (!files.length) {
    els.modalBody.insertAdjacentHTML("beforeend", `<div class="empty">No file changes detected.</div>`);
    return;
  }

  const list = document.createElement("div");
  list.className = "diff-list";
  const itemControls = [];

  for (const f of files) {
    const item = document.createElement("div");
    item.className = "diff-item";

    const row = document.createElement("div");
    row.className = "diff-row";
    const badge = DIFF_STATUS_BADGE[f.status] || "~";
    const statsParts = [];
    if (f.additions) statsParts.push(`+${f.additions}`);
    if (f.deletions) statsParts.push(`-${f.deletions}`);

    row.innerHTML = `
      <span class="diff-badge diff-${f.status}">${badge}</span>
      <span class="diff-filename">${escapeHtml(f.status === "renamed" ? `${f.previous_filename} → ${f.filename}` : f.filename)}</span>
      <span class="diff-stats">${statsParts.join(" ")}</span>
    `;
    row.style.cursor = "pointer";
    row.title = "Click to expand";

    const expando = document.createElement("div");
    expando.className = "diff-expando";
    expando.style.display = "none";
    let loaded = false;

    function setOpen(open) {
      expando.style.display = open ? "" : "none";
      if (open && !loaded) {
        fillDiffExpando(expando, f, parentSha, currentSha);
        loaded = true;
      }
    }

    row.onclick = () => setOpen(expando.style.display === "none");
    itemControls.push(setOpen);

    item.appendChild(row);
    item.appendChild(expando);
    list.appendChild(item);
  }

  els.modalBody.appendChild(list);

  els.modalBody.querySelectorAll(".diff-toggle-all").forEach(btn => {
    btn.onclick = () => {
      const open = btn.dataset.action === "expand";
      itemControls.forEach(setOpen => setOpen(open));
    };
  });
}

function fillDiffExpando(container, f, parentSha, currentSha) {
  if (f.patch) {
    container.innerHTML = buildPatchHtml(f.patch);
    return;
  }

  const cat = categoryFor(f.filename);
  if (cat === "image" || cat === "audio") {
    const blocks = [];
    const oldPath = f.status === "renamed" ? f.previous_filename : f.filename;
    const beforeUrl = rawUrlAtSha(parentSha, oldPath);
    const afterUrl = rawUrlAtSha(currentSha, f.filename);

    if (f.status !== "added" && parentSha) {
      blocks.push(mediaPreviewBlock("Before", beforeUrl, cat, f.filename));
    }
    if (f.status !== "removed" && currentSha) {
      blocks.push(mediaPreviewBlock("After", afterUrl, cat, f.filename));
    }
    if (cat === "image" && f.status === "modified" && parentSha && currentSha) {
      const diffUrl = getImgDiff(beforeUrl, afterUrl).then(url => {
        console.log(url);
        container.firstChild.innerHTML += mediaPreviewBlock("Diff", url, cat, f.filename + " (diff)")
      })
    }

    container.innerHTML = `<div class="diff-media">${blocks.join("")}</div>`;
    return;
  }

  container.innerHTML = `<div class="diff-nopatch">No preview available for this file.</div>`;
}

function mediaPreviewBlock(label, url, cat, name) {
  if (cat === "image") {
    return `
      <div class="diff-media-item">
        <div class="diff-media-label">${label}</div>
        <div class="diff-media-preview checker"><img loading="lazy" src="${url}" alt="${escapeHtml(name)}"></div>
      </div>`;
  }
  return `
    <div class="diff-media-item">
      <div class="diff-media-label">${label}</div>
      <audio controls src="${url}"></audio>
    </div>`;
}

function buildPatchHtml(patch) {
  const highlighted = patch
    .split("\n")
    .map(line => {
      let cls = "";
      if (line.startsWith("+") && !line.startsWith("+++")) cls = "diff-add";
      else if (line.startsWith("-") && !line.startsWith("---")) cls = "diff-remove";
      else if (line.startsWith("@@")) cls = "diff-hunk";
      return `<span class="${cls}">${escapeHtml(line)}</span>`;
    })
    .join("");
  return `<pre class="modal-text diff-patch">${highlighted}</pre>`;
}

function closeModal(restoreUrl = true) {
  els.modal.classList.remove("open");
  els.modal.setAttribute("aria-hidden", "true");
  els.modalBody.innerHTML = "";

  if (restoreUrl && currentOpenFile) {
    const targetHash = folderHash(currentOpenFile.branch, currentOpenFile.subPath);
    if (location.hash !== targetHash) setHashSilently(targetHash, { push: false });
  }
  currentOpenFile = null;
}

els.modal.addEventListener("click", (e) => {
  if (e.target === els.modal || e.target.classList.contains("modal-close")) closeModal();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeModal();
});

// ---------- Init ----------

function renderLastUpdated(dateString) {
  if (!els.lastUpdated || !dateString) return;
  const date = new Date(dateString);
  els.lastUpdated.textContent = `Last update: ${date.toLocaleString(undefined, { 
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' 
  })}`;
}

async function init() {
  els.status.textContent = "Loading versions...";
  try {
    const res = await fetch(`${API_BASE}/repos/${REPO_CONFIG.owner}/${REPO_CONFIG.repo}`);
    if (res.ok) {
      const data = await res.json();
      if (data && data.pushed_at) {
        globalLastCommitDate = data.pushed_at;
        if (!currentBranch) renderLastUpdated(globalLastCommitDate);
        
        const cachedDate = sessionStorage.getItem("gh_repo_last_pushed");
        if (cachedDate && cachedDate !== globalLastCommitDate) {
          console.log("Repository updated. Clearing stale session cache.");
          sessionStorage.clear(); 
        }
        sessionStorage.setItem("gh_repo_last_pushed", globalLastCommitDate);
      }
    }

    await fetchBranches();
    await handleRoute();
  } catch (e) {
    console.error(e);
    els.status.textContent = "Couldn't load repo";
  }
}

init();
