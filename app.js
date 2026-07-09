const REPO_CONFIG = {
  owner: "meowdding",
  repo: "hypixel-pack",
  branchFilter: null,
};

const API_BASE = "https://api.github.com";
const RAW_BASE = "https://raw.githubusercontent.com";

let branches = [];
let branchCache = {};
let currentBranch = null;
let currentSubPath = "";
const expanded = new Set();
let globalLastCommitDate = null;
let activeCategoryFilter = null;

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

function rawUrl(branch, path) {
  const cached = branchCache[branch];
  const ref = cached && cached.sha ? cached.sha : encodeURIComponent(branch);
  return `${RAW_BASE}/${REPO_CONFIG.owner}/${REPO_CONFIG.repo}/${ref}/${path}`;
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

// ---------- Routing ----------

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, "");
  if (!raw) return { branch: null, subPath: "" };

  const decodedRaw = raw.split('/').map(decodeURIComponent).join('/');

  const sortedBranches = [...branches].sort((a, b) => b.length - a.length);
  for (const b of sortedBranches) {
    if (decodedRaw === b) {
      return { branch: b, subPath: "" }; 
    }
    if (decodedRaw.startsWith(b + "/")) {
      return { branch: b, subPath: decodedRaw.slice(b.length + 1) };
    }
  }

  const parts = decodedRaw.split("/");
  
  if (parts.length > 1 && parts[0].toLowerCase() === "alpha") {
    return {
      branch: `${parts[0]}/${parts[1]}`,
      subPath: parts.slice(2).join("/")
    };
  }

  return { 
    branch: parts[0], 
    subPath: parts.slice(1).join("/") 
  };
}

function navigateTo(branch, subPath = "") {
  if (!branch) {
    if (location.hash !== "#/") location.hash = "#/";
    return;
  }
  
  const encodeParts = (str) => str.split('/').map(encodeURIComponent).join('/');
  
  let hash = `#/${encodeParts(branch)}`;
  if (subPath) {
    hash += `/${encodeParts(subPath)}`;
  }

  if (location.hash === hash) { 
    handleRoute(); 
  } else { 
    location.hash = hash; 
  }
}

window.addEventListener("hashchange", handleRoute);

async function handleRoute() {
    closeModal();
    const { branch, subPath } = parseHash();
    currentBranch = branch;
    currentSubPath = subPath;
    els.search.value = "";

    if (!branch) {
        renderRootBranchList();
        return;
    }

    els.status.textContent = `Loading ${branch}...`;
    try {
        await ensureBranchLoaded(branch);
        els.status.textContent = `${branchCache[branch].fileIndex.length} files in ${branch}`;
        renderLastUpdated(branchCache[branch].date);
        renderBreadcrumb();
        ensureSidebarExpanded(branch, subPath);
        renderSidebar();
        const activeRow = els.sidebar.querySelector(".tree-row.active");
        if (activeRow) activeRow.scrollIntoView({ block: "nearest" });
        const node = nodeAtPath(branchCache[branch].tree, subPath);
        renderGrid(node || branchCache[branch].tree, branch);
    } catch (e) {
        console.error(e);
        els.status.textContent = `Couldn't load "${branch}"`;
        els.grid.innerHTML = `<div class="empty">Couldn't load this version.</div>`;
    }
}

// ---------- Sidebar ----------

function ensureSidebarExpanded(branch, subPath) {
  expanded.add(branch);
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
  for (const b of branches) branchUl.appendChild(makeBranchNode(b));
  rootLi.appendChild(branchUl);
  rootUl.appendChild(rootLi);
  els.sidebar.appendChild(rootUl);
}

function makeBranchNode(branchName) {
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
  label.textContent = "📁 " + branchName;
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
  renderBreadcrumbRoot();
  renderSidebar();
  els.grid.innerHTML = "";
  
  els.status.textContent = `${branches.length} versions available`;
  
  if (globalLastCommitDate) {
    renderLastUpdated(globalLastCommitDate);
  } else if (els.lastUpdated) {
    els.lastUpdated.textContent = "";
  }

  const q = filterQuery.trim().toLowerCase();
  const list = q ? branches.filter(b => b.toLowerCase().includes(q)) : branches;
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
}

function renderBreadcrumbRoot() {
  els.breadcrumb.innerHTML = "";
  const rootCrumb = document.createElement("span");
  rootCrumb.className = "crumb";
  rootCrumb.textContent = REPO_CONFIG.repo;
  els.breadcrumb.appendChild(rootCrumb);
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

  els.modalBody.innerHTML = `
    <div class="modal-title">${escapeHtml(item.name)}</div>
    <div class="modal-path">${escapeHtml(branch)} / ${escapeHtml(item.path)}${item.size != null ? ` · ${formatSize(item.size)}` : ""}</div>
    <div class="modal-preview">${previewHtml}</div>
    <div class="modal-actions">
      <a href="${url}" target="_blank" rel="noopener">Open raw</a>
      <a href="${url}" download="${item.name}">Download</a>
      <button type="button" data-copy="${url}">Copy link</button>
    </div>
  `;
  const copyBtn = els.modalBody.querySelector("[data-copy]");
  copyBtn.onclick = () => {
    navigator.clipboard.writeText(copyBtn.dataset.copy);
    copyBtn.textContent = "Copied!";
    setTimeout(() => (copyBtn.textContent = "Copy link"), 1500);
  };
}

function closeModal() {
  els.modal.classList.remove("open");
  els.modal.setAttribute("aria-hidden", "true");
  els.modalBody.innerHTML = "";
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