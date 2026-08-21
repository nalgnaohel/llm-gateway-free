"use strict";

/* ------------------------------------------------------------------ theme */

const THEME_KEY = "aigw-theme";
const ICON_SUN = '<circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2.4M12 19.1v2.4M4.9 4.9l1.7 1.7M17.4 17.4l1.7 1.7M2.5 12h2.4M19.1 12h2.4M4.9 19.1l1.7-1.7M17.4 6.6l1.7-1.7"/>';
const ICON_MOON = '<path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a7 7 0 0 0 10.5 10.5Z"/>';

function effectiveTheme() {
  const set = document.documentElement.getAttribute("data-theme");
  if (set) return set;
  return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function paintThemeIcon() {
  const icon = document.getElementById("theme-icon");
  icon.innerHTML = effectiveTheme() === "dark" ? ICON_SUN : ICON_MOON;
}

function initTheme() {
  const saved = localStorage.getItem(THEME_KEY);
  if (saved === "light" || saved === "dark") document.documentElement.setAttribute("data-theme", saved);
  paintThemeIcon();
  document.getElementById("theme-btn").addEventListener("click", () => {
    const next = effectiveTheme() === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    localStorage.setItem(THEME_KEY, next);
    paintThemeIcon();
  });
}

/* -------------------------------------------------------------------- nav */

const PAGE_META = {
  overview: ["Tổng quan", "Trạng thái gateway theo thời gian thực"],
  playground: ["Thử prompt", "Gửi thử một prompt tới đích danh một client"],
  clients: ["Clients", "Toàn bộ client agent, online và offline"],
  capabilities: ["Web & CLI", "Công cụ mà các client có thể chạy được"],
  usage: ["Token sử dụng", "Số token đã tiêu thụ theo từng client"],
  requests: ["Requests", "Lịch sử request gần đây"],
  routing: ["Routing", "Thuật toán phân phối tải giữa các client"],
  cache: ["Cache", "Trạng thái response cache"],
};

function initNav() {
  document.getElementById("nav").addEventListener("click", (e) => {
    const item = e.target.closest(".nav-item");
    if (!item) return;
    const view = item.dataset.view;
    document.querySelectorAll(".nav-item").forEach((n) => n.classList.toggle("active", n === item));
    document.querySelectorAll(".view").forEach((v) => v.classList.toggle("active", v.id === `view-${view}`));
    const [title, sub] = PAGE_META[view] || ["", ""];
    document.getElementById("page-title").textContent = title;
    document.getElementById("page-sub").textContent = sub;
  });
}

/* ------------------------------------------------------------------ utils */

const fmtNum = (n) => (n === null || n === undefined || Number.isNaN(n) ? "0" : Math.round(n).toLocaleString());

function timeAgo(ts) {
  if (!ts) return "—";
  const diff = Date.now() - ts;
  if (diff < 0 || diff < 10_000) return "vừa xong";
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s} giây trước`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} phút trước`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} giờ trước`;
  const d = Math.floor(h / 24);
  return `${d} ngày trước`;
}

function fmtMs(ms) {
  if (ms === null || ms === undefined || Number.isNaN(ms)) return "—";
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function statusBadge(status) {
  const cls = status === "online" || status === "ok" ? "online" : status === "offline" || status === "error" ? "offline" : "pending";
  return `<span class="badge ${cls}"><span class="dot ${cls === "online" ? "live" : cls === "offline" ? "down" : ""}"></span>${esc(status)}</span>`;
}

async function api(path, opts) {
  const res = await fetch(path, opts);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body?.error?.message || body?.message || `${path} → HTTP ${res.status}`);
  }
  return res.json();
}

function toast(msg, isErr) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.classList.toggle("err", !!isErr);
  el.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove("show"), 2600);
}

function capChip(cap) {
  const kind = cap.kind === "browser" ? "web" : "cli";
  const name = cap.displayName || cap.capabilityId || cap.id;
  const avail = cap.available !== false;
  return `<span class="cap-chip ${kind}${avail ? "" : " unavailable"}" title="${esc(cap.reason || "")}"><span class="kind-dot"></span>${esc(name)}</span>`;
}

function capChips(caps) {
  if (!caps || !caps.length) return '<span class="muted">—</span>';
  return `<div class="chip-wrap">${caps.map(capChip).join("")}</div>`;
}

/* --------------------------------------------------------------- fetching */

let lastData = { health: null, clients: null, capabilities: null, usage: null, requests: null, routing: null, cache: null };

async function loadAll() {
  try {
    const [health, clients, capabilities, usage, requests, routing] = await Promise.all([
      api("/health"),
      api("/api/clients"),
      api("/api/capabilities"),
      api("/api/usage/clients"),
      api("/api/requests?limit=50"),
      api("/api/settings/routing"),
    ]);
    lastData = { health, clients, capabilities, usage, requests, routing, cache: health.cache };
    setConn(true);
    renderOverview();
    renderPlayground();
    renderClients();
    renderCapabilities();
    renderUsage();
    renderRequests();
    renderRouting();
    renderCache();
  } catch (err) {
    setConn(false);
    console.error(err);
  }
}

function setConn(ok) {
  document.getElementById("conn-dot").className = `dot ${ok ? "live" : "down"}`;
  document.getElementById("conn-text").textContent = ok ? "Đã kết nối" : "Mất kết nối";
}

/* ---------------------------------------------------------------- render */

function renderOverview() {
  const { health, clients, capabilities, usage } = lastData;
  if (!health) return;
  document.getElementById("stat-clients-online").textContent = fmtNum(health.clients);
  document.getElementById("nav-clients-count").textContent = fmtNum(health.clients);
  const totalKnown = clients?.persisted?.length ?? health.clients;
  document.getElementById("stat-clients-total").textContent = `${fmtNum(totalKnown)} tổng cộng từng thấy`;
  document.getElementById("stat-active-jobs").textContent = fmtNum(health.activeJobs);
  const webCount = (capabilities?.capabilities || []).filter((c) => c.kind === "browser").length;
  const cliCount = (capabilities?.capabilities || []).filter((c) => c.kind === "cli").length;
  document.getElementById("stat-capabilities").textContent = fmtNum(webCount + cliCount);
  document.getElementById("stat-cap-breakdown").textContent = `${webCount} web · ${cliCount} cli`;
  const totalTokens = (usage?.clients || []).reduce((n, c) => n + (c.total_tokens || 0), 0);
  document.getElementById("stat-tokens").textContent = fmtNum(totalTokens);
  const totalReq = (usage?.clients || []).reduce((n, c) => n + (c.requests || 0), 0);
  document.getElementById("stat-requests-total").textContent = `${fmtNum(totalReq)} request`;

  const live = clients?.live || [];
  document.getElementById("clients-live-hint").textContent = `${live.length} online`;
  const rows = live.map(
    (c) => `<tr>
      <td><strong>${esc(c.name)}</strong><div class="mono">${esc(c.clientId)}</div></td>
      <td>${esc(c.platform)}</td>
      <td class="mono">${esc(c.remoteAddr)}</td>
      <td class="num">${c.activeJobs}/${c.maxConcurrency}</td>
      <td>${capChips(c.capabilities)}</td>
    </tr>`,
  );
  document.getElementById("tbl-overview-clients").innerHTML =
    rows.join("") || '<tr class="empty-row"><td colspan="5">Chưa có client nào kết nối</td></tr>';

  renderRoutingOverviewCard();
}

const STRATEGY_LABEL = {
  "least-busy": "Ít tải nhất",
  "round-robin": "Round robin",
  "fill-first": "Lấp đầy dần",
  "ip-hash": "Hash theo IP",
};

function renderRoutingOverviewCard() {
  const r = lastData.routing;
  if (!r) return;
  document.getElementById("overview-routing").innerHTML = `
    <div style="display:flex; align-items:center; gap:10px; margin-bottom:10px;">
      <span class="badge neutral">${esc(STRATEGY_LABEL[r.strategy] || r.strategy)}</span>
    </div>
    <p class="muted" style="margin:0 0 12px;">${esc(STRATEGY_DESC[r.strategy]?.text || "")}</p>
    <a href="#" data-view-link="routing" class="btn" style="text-decoration:none;">Đổi chiến lược →</a>
  `;
  document.querySelector('#overview-routing [data-view-link]')?.addEventListener("click", (e) => {
    e.preventDefault();
    document.querySelector('.nav-item[data-view="routing"]').click();
  });
}

/* ------------------------------------------------------------- playground */

function renderPlayground() {
  const live = lastData.clients?.live || [];
  const clientSel = document.getElementById("pg-client");
  const prevClient = clientSel.value;
  clientSel.innerHTML = live.length
    ? live.map((c) => `<option value="${esc(c.clientId)}">${esc(c.name)} — ${esc(c.clientId)}</option>`).join("")
    : `<option value="">Không có client online</option>`;
  clientSel.disabled = live.length === 0;
  if (live.some((c) => c.clientId === prevClient)) clientSel.value = prevClient;
  populatePlaygroundCapabilities();
}

function playgroundClient() {
  const live = lastData.clients?.live || [];
  return live.find((c) => c.clientId === document.getElementById("pg-client").value);
}

function populatePlaygroundCapabilities() {
  const capSel = document.getElementById("pg-capability");
  const prevCap = capSel.value;
  const caps = (playgroundClient()?.capabilities || []).filter((c) => c.available);
  capSel.innerHTML = caps.length
    ? caps.map((c) => `<option value="${esc(c.id)}">${c.kind === "browser" ? "🌐" : "⌨️"} ${esc(c.displayName)}</option>`).join("")
    : `<option value="">Client chưa có capability khả dụng</option>`;
  capSel.disabled = caps.length === 0;
  if (caps.some((c) => c.id === prevCap)) capSel.value = prevCap;
  populatePlaygroundSubmodels();
}

function populatePlaygroundSubmodels() {
  const capSel = document.getElementById("pg-capability");
  const subField = document.getElementById("pg-submodel-field");
  const subSel = document.getElementById("pg-submodel");
  const cap = (playgroundClient()?.capabilities || []).find((c) => c.id === capSel.value);
  const models = cap?.models || [];
  if (!models.length) {
    subField.style.display = "none";
    subSel.innerHTML = "";
    return;
  }
  const prev = subSel.value;
  subSel.innerHTML = models.map((m) => `<option value="${esc(m)}">${esc(m)}</option>`).join("");
  if (models.includes(prev)) subSel.value = prev;
  subField.style.display = "";
}

function pgAppend(text) {
  const out = document.getElementById("pg-output");
  if (out.dataset.empty === "1") {
    out.textContent = "";
    out.dataset.empty = "0";
  }
  out.textContent += text;
  out.scrollTop = out.scrollHeight;
}

async function runPlayground() {
  const clientId = document.getElementById("pg-client").value;
  const capabilityId = document.getElementById("pg-capability").value;
  const subField = document.getElementById("pg-submodel-field");
  const subModel = subField.style.display !== "none" ? document.getElementById("pg-submodel").value : undefined;
  const prompt = document.getElementById("pg-prompt").value.trim();
  const runBtn = document.getElementById("pg-run");
  const statusEl = document.getElementById("pg-status");
  const outputEl = document.getElementById("pg-output");
  const metaEl = document.getElementById("pg-meta");

  if (!clientId || !capabilityId) {
    toast("Chọn client và capability trước", true);
    return;
  }
  if (!prompt) {
    toast("Nhập prompt trước khi chạy", true);
    return;
  }

  runBtn.disabled = true;
  statusEl.textContent = "Đang gửi…";
  metaEl.textContent = "";
  outputEl.textContent = "";
  outputEl.dataset.empty = "1";

  try {
    const res = await fetch("/api/test-prompt", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ clientId, capabilityId, subModel, prompt }),
    });

    if (!res.ok || !res.body) {
      const errBody = await res.json().catch(() => ({}));
      throw new Error(errBody?.error?.message || `HTTP ${res.status}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const parts = buf.split("\n\n");
      buf = parts.pop() ?? "";
      for (const part of parts) {
        const line = part.trim();
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") continue;
        let ev;
        try {
          ev = JSON.parse(payload);
        } catch {
          continue;
        }
        applyPlaygroundEvent(ev, { statusEl, metaEl });
      }
    }
  } catch (err) {
    statusEl.textContent = "Lỗi";
    pgAppend(`\n⚠ ${err.message || err}`);
  } finally {
    runBtn.disabled = false;
  }
}

function applyPlaygroundEvent(ev, { statusEl, metaEl }) {
  if (ev.type === "start") {
    statusEl.textContent = `Đã gửi tới ${ev.clientId}…`;
    return;
  }
  if (ev.type === "accepted") {
    statusEl.textContent = "Client đã nhận job, đang xử lý…";
    return;
  }
  if (ev.type === "chunk") {
    pgAppend(ev.delta);
    return;
  }
  if (ev.type === "done") {
    statusEl.textContent = "Hoàn tất";
    if (document.getElementById("pg-output").dataset.empty === "1" && ev.content) pgAppend(ev.content);
    const u = ev.usage || {};
    metaEl.textContent = `${fmtNum(u.totalTokens)} token · ${fmtMs(ev.latencyMs)} · ${esc(ev.finishReason || "stop")}`;
    return;
  }
  if (ev.type === "error") {
    statusEl.textContent = "Lỗi";
    pgAppend(`\n\n⚠ [${ev.code}] ${ev.message}`);
    return;
  }
}

function renderClients() {
  const { clients } = lastData;
  if (!clients) return;
  const liveMap = new Map((clients.live || []).map((c) => [c.clientId, c]));
  const rows = (clients.persisted || []).map((p) => {
    const live = liveMap.get(p.id);
    const activeJobs = live ? live.activeJobs : 0;
    return `<tr>
      <td><strong>${esc(p.name)}</strong><div class="mono">${esc(p.id)}</div></td>
      <td>${statusBadge(p.status)}</td>
      <td>${esc(p.platform || "—")}</td>
      <td class="mono">${esc(p.remote_addr || "—")}</td>
      <td class="num">${activeJobs}/${p.max_concurrency}</td>
      <td class="num">${fmtNum(p.total_jobs)}</td>
      <td class="num">${p.failed_jobs ? `<span style="color:var(--danger)">${fmtNum(p.failed_jobs)}</span>` : "0"}</td>
      <td>${capChips(p.capabilities)}</td>
      <td class="muted">${timeAgo(p.last_seen_at)}</td>
    </tr>`;
  });
  document.getElementById("tbl-clients").innerHTML =
    rows.join("") || '<tr class="empty-row"><td colspan="9">Chưa có client nào từng kết nối</td></tr>';
}

function renderCapTable(elId, list) {
  const rows = list.map(
    (c) => `<tr>
      <td><strong>${esc(c.displayName)}</strong><div class="mono">${esc(c.id)}</div></td>
      <td class="num">${fmtNum(c.clients)}</td>
      <td class="num">${fmtNum(c.slots)}</td>
      <td>${(c.models || []).map((m) => `<span class="cap-chip web" style="margin-top:2px;">${esc(m)}</span>`).join("") || '<span class="muted">—</span>'}</td>
    </tr>`,
  );
  document.getElementById(elId).innerHTML = rows.join("") || `<tr class="empty-row"><td colspan="4">Chưa có capability nào</td></tr>`;
}

function renderCapabilities() {
  const caps = lastData.capabilities?.capabilities || [];
  renderCapTable("tbl-cap-web", caps.filter((c) => c.kind === "browser"));
  renderCapTable("tbl-cap-cli", caps.filter((c) => c.kind === "cli"));
}

function renderUsage() {
  const list = lastData.usage?.clients || [];
  const maxTokens = Math.max(1, ...list.map((c) => c.total_tokens || 0));
  const rows = list.map((c) => {
    const pct = Math.round(((c.total_tokens || 0) / maxTokens) * 100);
    return `<tr>
      <td><strong>${esc(c.name || c.client_id)}</strong><div class="mono">${esc(c.client_id)}</div></td>
      <td>${statusBadge(c.status)}</td>
      <td class="num">${fmtNum(c.requests)}</td>
      <td class="num">${fmtNum(c.ok)}</td>
      <td class="num">${c.errors ? `<span style="color:var(--danger)">${fmtNum(c.errors)}</span>` : "0"}</td>
      <td class="num">${fmtNum(c.prompt_tokens)}</td>
      <td class="num">${fmtNum(c.completion_tokens)}</td>
      <td class="num"><strong>${fmtNum(c.total_tokens)}</strong></td>
      <td><div class="bar-track"><div class="bar-fill" style="width:${pct}%"></div></div></td>
      <td class="num">${fmtMs(c.avg_latency_ms)}</td>
    </tr>`;
  });
  document.getElementById("tbl-usage").innerHTML =
    rows.join("") || '<tr class="empty-row"><td colspan="10">Chưa có dữ liệu sử dụng</td></tr>';
}

function renderRequests() {
  const list = lastData.requests?.requests || [];
  const rows = list.map(
    (r) => `<tr>
      <td class="muted">${timeAgo(r.created_at)}</td>
      <td class="mono">${esc(r.model)}</td>
      <td class="mono">${esc(r.client_id || "—")}</td>
      <td>${statusBadge(r.status)}</td>
      <td class="num">${r.attempts ?? 0}</td>
      <td>${r.cache_hit ? '<span class="badge ok">hit</span>' : '<span class="muted">miss</span>'}</td>
      <td class="num">${fmtNum(r.total_tokens)}</td>
      <td class="num">${fmtMs(r.latency_ms)}</td>
    </tr>`,
  );
  document.getElementById("tbl-requests").innerHTML =
    rows.join("") || '<tr class="empty-row"><td colspan="8">Chưa có request nào</td></tr>';
}

const STRATEGY_DESC = {
  "least-busy": {
    icon: '<path d="M3 12h4l3 8 4-16 3 8h4"/>',
    text: "Chọn client còn nhiều slot rảnh nhất tại thời điểm dispatch. Cân bằng tải sát thực tế nhất, mặc định khuyến nghị.",
  },
  "round-robin": {
    icon: '<path d="M17 2.1 21 6l-4 3.9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><path d="M7 21.9 3 18l4-3.9"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/>',
    text: "Luân phiên tuần tự qua từng client theo thứ tự cố định, không quan tâm tải hiện tại. Đơn giản, phân bổ đều số lượng request.",
  },
  "fill-first": {
    icon: '<rect x="3" y="10" width="4" height="10"/><rect x="10" y="6" width="4" height="14"/><rect x="17" y="3" width="4" height="17"/>',
    text: "Dồn đầy một client trước khi chuyển sang client kế tiếp. Phù hợp khi muốn giữ các máy còn lại rảnh để tiết kiệm tài nguyên.",
  },
  "ip-hash": {
    icon: '<circle cx="12" cy="12" r="9"/><path d="M12 3v18"/><path d="M3 12h18"/>',
    text: "Băm địa chỉ IP của người gọi để luôn định tuyến về cùng một client (sticky session) khi client đó còn khả dụng — hữu ích khi cần tính nhất quán theo người dùng/phiên.",
  },
};

let selectedStrategy = null;

function renderStrategyGrid() {
  const grid = document.getElementById("strategy-grid");
  if (grid.dataset.built) return;
  grid.dataset.built = "1";
  const order = ["round-robin", "ip-hash", "least-busy", "fill-first"];
  grid.innerHTML = order
    .map(
      (key) => `<label class="strategy-option" data-key="${key}">
        <input type="radio" name="strategy" value="${key}" />
        <div class="name-row">
          <div class="name"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${STRATEGY_DESC[key].icon}</svg>${esc(STRATEGY_LABEL[key])}</div>
          <div class="check"></div>
        </div>
        <div class="desc">${esc(STRATEGY_DESC[key].text)}</div>
      </label>`,
    )
    .join("");
  grid.querySelectorAll(".strategy-option").forEach((opt) => {
    opt.addEventListener("click", () => {
      selectedStrategy = opt.dataset.key;
      grid.querySelectorAll(".strategy-option").forEach((o) => o.classList.toggle("selected", o === opt));
    });
  });
}

function renderRouting() {
  renderStrategyGrid();
  const current = lastData.routing?.strategy;
  if (!selectedStrategy) selectedStrategy = current;
  document.querySelectorAll(".strategy-option").forEach((o) => o.classList.toggle("selected", o.dataset.key === selectedStrategy));
  document.getElementById("strategy-current-label").textContent = `Đang áp dụng: ${STRATEGY_LABEL[current] || current}`;
}

function renderCache() {
  const c = lastData.cache;
  if (!c) return;
  document.getElementById("cache-entries").textContent = `${fmtNum(c.memoryEntries)} / ${fmtNum(c.diskEntries)}`;
  document.getElementById("cache-hits-mem").textContent = fmtNum(c.hitsMemory);
  document.getElementById("cache-hits-disk").textContent = fmtNum(c.hitsDisk);
  document.getElementById("cache-misses").textContent = fmtNum(c.misses);
}

/* ---------------------------------------------------------------- wiring */

function initActions() {
  document.getElementById("refresh-btn").addEventListener("click", loadAll);

  document.getElementById("pg-client").addEventListener("change", populatePlaygroundCapabilities);
  document.getElementById("pg-capability").addEventListener("change", populatePlaygroundSubmodels);
  document.getElementById("pg-run").addEventListener("click", runPlayground);

  document.getElementById("apply-strategy").addEventListener("click", async (e) => {
    if (!selectedStrategy) return;
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      await api("/api/settings/routing", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ strategy: selectedStrategy }),
      });
      toast(`Đã áp dụng: ${STRATEGY_LABEL[selectedStrategy] || selectedStrategy}`);
      await loadAll();
    } catch (err) {
      toast(err.message || "Không thể áp dụng", true);
    } finally {
      btn.disabled = false;
    }
  });

  document.getElementById("clear-cache-btn").addEventListener("click", async () => {
    try {
      await api("/api/cache", { method: "DELETE" });
      toast("Đã xoá cache");
      await loadAll();
    } catch (err) {
      toast(err.message || "Không thể xoá cache", true);
    }
  });
}

initTheme();
initNav();
initActions();
loadAll();
setInterval(loadAll, 5000);
