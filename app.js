// ===== 计划鲸灵 · 核心逻辑(含云端同步)=====
'use strict';

const LS_PLANS = 'jql_plans_v1';
const LS_PROGRESS = 'jql_progress_v1';
const LS_TOKEN = 'jql_token';

// 云端同步(GitHub 私有仓库)
const GH_OWNER = 'FuGuang315';
const GH_REPO = 'plan-jingling-data';
const GH_FILE = 'data.json';
const GH_API = `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/contents/${GH_FILE}`;

const CATS = ['学习', '工作', '生活', '健身', '其他'];
const CAT_COLORS = {
  '学习': '#6C8BFF',
  '工作': '#8B7BF0',
  '生活': '#FF9FB0',
  '健身': '#4ED4A8',
  '其他': '#A0A8C0',
};
const PERIOD_LABEL = { once: '单次', daily: '每天', weekly: '每周', monthly: '每月' };

let plans = load(LS_PLANS, []);
let progress = load(LS_PROGRESS, {});
let activeTab = 'today';
let prevTab = 'today';
let calYear = new Date().getFullYear();
let calMonth = new Date().getMonth();
let calSel = dateStr(new Date());
let activeCat = '全部';
let editingId = null;
let draftCat = '学习';
let draftPeriod = 'daily';
let draftSubs = [];

// 同步状态
let syncToken = localStorage.getItem(LS_TOKEN) || null;
let remoteSha = null;
let syncState = syncToken ? 'pending' : 'off'; // off | pending | synced | error
let pushTimer = null;
let syncError = '';

// ---------- 基础工具 ----------
function load(key, fallback) {
  try { const v = JSON.parse(localStorage.getItem(key)); return v == null ? fallback : v; }
  catch (e) { return fallback; }
}
function save() {
  localStorage.setItem(LS_PLANS, JSON.stringify(plans));
  localStorage.setItem(LS_PROGRESS, JSON.stringify(progress));
}
function commit() { save(); schedulePush(); }
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function dateStr(d) {
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return d.getFullYear() + '-' + m + '-' + day;
}
function isoWeek(d) {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((date - yearStart) / 86400000) + 1) / 7);
  return date.getUTCFullYear() + '-W' + String(week).padStart(2, '0');
}
function periodKey(plan, d = new Date()) {
  switch (plan.period) {
    case 'daily': return dateStr(d);
    case 'weekly': return isoWeek(d);
    case 'monthly': return dateStr(d).slice(0, 7);
    default: return 'once';
  }
}
function b64encode(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}
function b64decode(b64) {
  const bin = atob(b64.replace(/\s/g, ''));
  const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

// ---------- 通用弹窗(替代原生 confirm/alert,不乱码、更好看) ----------
function showDialog(msg, opts = {}) {
  return new Promise((resolve) => {
    const overlay = document.getElementById('dialog-overlay');
    const ok = document.getElementById('dialog-ok');
    const cancel = document.getElementById('dialog-cancel');
    document.getElementById('dialog-msg').textContent = msg;
    ok.textContent = opts.okText || '确定';
    cancel.textContent = opts.cancelText || '取消';
    cancel.style.display = opts.hideCancel ? 'none' : '';
    overlay.hidden = false;
    ok.onclick = () => { overlay.hidden = true; resolve(true); };
    cancel.onclick = () => { overlay.hidden = true; resolve(false); };
  });
}
function alertBox(msg) { return showDialog(msg, { hideCancel: true }); }

// ---------- 状态读取 ----------
function stateAt(plan, d = new Date()) {
  const st = progress[plan.id];
  return st ? (st[periodKey(plan, d)] || null) : null;
}
function curState(plan) {
  const key = periodKey(plan);
  if (!progress[plan.id]) progress[plan.id] = {};
  if (!progress[plan.id][key]) progress[plan.id][key] = { checked: [], manual: null, doneAt: null };
  return progress[plan.id][key];
}
function autoProgress(plan, st) {
  if (!st) return 0;
  if (plan.subtasks.length) {
    let c = 0;
    for (let i = 0; i < plan.subtasks.length; i++) if (st.checked[i]) c++;
    return Math.round((c / plan.subtasks.length) * 100);
  }
  return st.doneAt ? 100 : 0;
}
function shown(plan, st) {
  if (!st) return 0;
  return st.manual != null ? st.manual : autoProgress(plan, st);
}
function isDayDone(plan, d) {
  return shown(plan, stateAt(plan, d)) >= 100;
}
function isFullyDone(plan) {
  if (plan.period === 'once') return shown(plan, stateAt(plan)) >= 100;
  if (plan.endDate) return dateStr(new Date()) > plan.endDate;
  return false;
}
function streakOf(plan) {
  let n = 0;
  const d = new Date();
  if (!isDayDone(plan, d)) d.setDate(d.getDate() - 1);
  while (isDayDone(plan, d)) { n++; d.setDate(d.getDate() - 1); }
  return n;
}
function missedDays(plan, lookback = 30) {
  const out = [];
  const wd = '日一二三四五六';
  const today = new Date();
  const created = plan.createdAt ? dateStr(new Date(plan.createdAt)) : null;
  for (let i = 1; i <= lookback; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const ds = dateStr(d);
    if (created && ds < created) continue;
    if (plan.startDate && ds < plan.startDate) continue;
    if (plan.endDate && ds > plan.endDate) continue;
    if (!isDayDone(plan, d)) out.push({ date: ds, label: '周' + wd[d.getDay()] + ' ' + (d.getMonth() + 1) + '月' + d.getDate() + '日' });
  }
  return out;
}
function missSummary() {
  const daily = plans.filter(p => p.period === 'daily' && !isFullyDone(p));
  let total = 0, maxCon = 0;
  const today = new Date();
  for (const p of daily) {
    total += missedDays(p, 365).length;
    let con = 0;
    const created = p.createdAt ? dateStr(new Date(p.createdAt)) : null;
    for (let i = 1; i <= 365; i++) {
      const d = new Date(today); d.setDate(d.getDate() - i);
      const ds = dateStr(d);
      if (created && ds < created) break;
      if (p.endDate && ds > p.endDate) continue;
      if (p.startDate && ds < p.startDate) break;
      if (isDayDone(p, d)) break;
      con++;
    }
    if (con > maxCon) maxCon = con;
  }
  return { count: total, maxCon };
}
function planOnDay(plan, ds) {
  if (plan.period === 'daily') {
    if (!plan.startDate && ds < dateStr(new Date())) return false;  // 无开始日期的无限循环:今天之前不显示
    if (plan.startDate && ds < plan.startDate) return false;
    if (plan.endDate && ds > plan.endDate) return false;
    return true;
  }
  if (plan.period === 'once') {
    const s = plan.startDate, e = plan.due;
    if (s && e) return ds >= s && ds <= e;   // 多天任务
    if (e) return ds === e;                    // 当天(截止日)
    if (s) return ds === s;                    // 当天(开始日)
    return false;                              // 无日期
  }
  return false; // 每周/每月暂不进日历
}
function dotTypesOnDay(ds) {
  const d = new Date(ds + 'T00:00:00');
  const isSunday = d.getDay() === 0;
  const isMonthEnd = d.getDate() === new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  const types = new Set();
  for (const p of plans) {
    if (p.period === 'daily' && planOnDay(p, ds)) types.add('daily');
    else if (p.period === 'once' && planOnDay(p, ds)) types.add('once');
    else if (p.period === 'weekly' && isSunday && !isFullyDone(p)) types.add('weekly');
    else if (p.period === 'monthly' && isMonthEnd && !isFullyDone(p)) types.add('monthly');
  }
  return types;
}
function tasksOnDay(ds) {
  return plans.filter(p => {
    if (p.period === 'daily' || p.period === 'once') return planOnDay(p, ds);
    return (p.period === 'weekly' || p.period === 'monthly') && !isFullyDone(p);
  });
}

// ---------- 云端同步 ----------
function ghFetch(url, opts = {}) {
  return fetch(url, {
    ...opts,
    headers: {
      'Authorization': 'Bearer ' + syncToken,
      'Accept': 'application/vnd.github+json',
      ...(opts.headers || {})
    }
  });
}
function schedulePush() {
  if (!syncToken) return;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(pushToRemote, 800);
}
async function syncFromRemote() {
  if (!syncToken) return;
  setSyncState('pending');
  try {
    const r = await ghFetch(GH_API);
    if (r.status === 200) {
      const j = await r.json();
      remoteSha = j.sha;
      const data = JSON.parse(b64decode(j.content));
      plans = data.plans || [];
      progress = data.progress || {};
      save();           // 存本地缓存(不触发上传)
      setSyncState('synced');
      render();
    } else if (r.status === 404) {
      remoteSha = null;   // 云端还是空的 → 把本地推上去
      await pushToRemote();
    } else {
      setSyncState('error', statusMsg(r.status));
    }
  } catch (e) {
    setSyncState('error', '连不上 GitHub(网络或代理问题)');
  }
}
async function pushToRemote() {
  if (!syncToken) return;
  const payload = b64encode(JSON.stringify({ plans, progress }));
  try {
    let body = { message: 'sync ' + new Date().toISOString(), content: payload };
    if (remoteSha) body.sha = remoteSha;
    let r = await ghFetch(GH_API, { method: 'PUT', body: JSON.stringify(body) });
    if (r.status === 201 || r.status === 200) {
      const j = await r.json();
      remoteSha = j.content.sha;
      setSyncState('synced');
    } else if (r.status === 409) {
      // 冲突:先拿最新 sha,再以本地为准覆盖
      const g = await ghFetch(GH_API);
      if (g.status === 200) remoteSha = (await g.json()).sha;
      body.sha = remoteSha;
      r = await ghFetch(GH_API, { method: 'PUT', body: JSON.stringify(body) });
      if (r.status === 201 || r.status === 200) {
        const j = await r.json();
        remoteSha = j.content.sha;
        setSyncState('synced');
      } else setSyncState('error', '同步冲突,稍后重试');
    } else {
      setSyncState('error', statusMsg(r.status));
    }
  } catch (e) {
    setSyncState('error', '连不上 GitHub(网络或代理问题)');
  }
}
function statusMsg(s) {
  if (s === 401 || s === 403) return '令牌无效:检查有没有复制正确(ghp 后面是下划线 _ ,不是空格)';
  return '同步失败(HTTP ' + s + ')';
}
function setSyncState(s, msg) { syncState = s; if (msg !== undefined) syncError = msg; updateSyncBtn(); }
function updateSyncBtn() {
  const el = document.getElementById('menu-sync-status');
  if (!el) return;
  const map = { off: '未连接', pending: '同步中…', synced: '已同步', error: '失败' };
  el.textContent = syncToken ? (map[syncState] || '') : '未连接';
  el.style.color = syncState === 'synced' ? 'var(--blue)' : (syncState === 'error' ? '#FF7A93' : 'var(--ink-soft)');
}

// ---------- 同步弹窗 ----------
function openSync() {
  renderSyncBody();
  document.getElementById('sync-overlay').hidden = false;
}
function renderSyncBody() {
  const el = document.getElementById('sync-body');
  if (!syncToken) {
    el.innerHTML = `
      <p class="sync-desc">把数据存到云端,手机和电脑就能互通。<br>粘贴一个 GitHub 令牌即可(只存在你本机浏览器里)。</p>
      <label class="field"><span>GitHub 令牌</span>
        <input id="sync-token-input" type="text" placeholder="ghp_..." autocomplete="off" inputmode="text"/>
      </label>
      <div class="sheet-actions"><button class="btn primary" id="sync-connect">连接同步</button></div>`;
    document.getElementById('sync-connect').onclick = connectSync;
  } else {
    const map = { pending: '同步中…', synced: '已同步 ✓', error: '同步失败(可能离线)' };
    const st = map[syncState] || '未同步';
    el.innerHTML = `
      <p class="sync-desc">已连接云端同步。打开 App 会自动拉取最新数据,改动会自动上传。</p>
      <p class="sync-status ${syncState}">状态:${st}</p>
      ${syncError ? `<p class="sync-desc" style="color:#FF7A93">${esc(syncError)}</p>` : ''}
      <div class="sheet-actions">
        <button class="btn primary" id="sync-now">立即同步</button>
        <button class="btn ghost" id="sync-disconnect">断开同步</button>
      </div>`;
    document.getElementById('sync-now').onclick = pushToRemote;
    document.getElementById('sync-disconnect').onclick = disconnectSync;
  }
}
function connectSync() {
  const v = document.getElementById('sync-token-input').value.trim();
  if (!v) { alertBox('请粘贴令牌'); return; }
  syncToken = v;
  localStorage.setItem(LS_TOKEN, v);
  remoteSha = null;
  syncFromRemote();
}
function disconnectSync() {
  showDialog('断开同步?本地数据会保留,只是不再上传云端。', { okText: '断开' }).then(ok => {
    if (!ok) return;
    syncToken = null;
    remoteSha = null;
    clearTimeout(pushTimer);
    localStorage.removeItem(LS_TOKEN);
    setSyncState('off');
    renderSyncBody();
  });
}

// ---------- 渲染 ----------
function render() { renderChips(); renderContent(); updateChrome(); }
function updateChrome() {
  const inFull = activeTab === 'done' || activeTab === 'calendar';
  const set = (el) => { if (el) el.style.display = inFull ? 'none' : ''; };
  set(document.getElementById('tabbar'));
  set(document.getElementById('cat-chips'));
  set(document.getElementById('fab'));
  set(document.querySelector('.header'));
}

function renderChips() {
  const el = document.getElementById('cat-chips');
  const cats = ['全部', ...CATS];
  el.innerHTML = cats.map(c => `<button class="chip ${activeCat === c ? 'active' : ''}" data-cat="${c}">${c}</button>`).join('');
}

function renderContent() {
  const el = document.getElementById('content');
  const catOk = p => activeCat === '全部' || p.category === activeCat;
  const active = p => !isFullyDone(p);
  let html = '';

  if (activeTab === 'today') {
    const daily = plans.filter(p => p.period === 'daily' && catOk(p) && active(p));
    const once = plans.filter(p => p.period === 'once' && catOk(p) && shown(p, stateAt(p)) < 100);
    if (!daily.length && !once.length) { el.innerHTML = emptyHTML('🐳', '今天没有要做的,真棒'); return; }
    const miss = missSummary();
    if (miss.count > 0) {
      const txt = miss.maxCon === 1 ? '昨天没打卡' : `已连续 ${miss.maxCon} 天没打卡`;
      html += `<div class="card miss-banner" data-action="miss"><span>⚠️</span><div>${txt}<small>点我补卡</small></div></div>`;
    }
    if (daily.length) html += sectionHTML('🌤️ 每天打卡', daily);
    if (once.length) html += sectionHTML('📌 待办', once);
  } else if (activeTab === 'week') {
    const list = plans.filter(p => p.period === 'weekly' && catOk(p) && active(p));
    html = list.length ? sectionHTML('🗓️ 本周目标', list) : emptyHTML('🗓️', '本周没有目标');
  } else if (activeTab === 'month') {
    const list = plans.filter(p => p.period === 'monthly' && catOk(p) && active(p));
    html = list.length ? sectionHTML('📆 本月目标', list) : emptyHTML('📆', '本月没有目标');
  } else if (activeTab === 'done') {
    const groups = [
      ['每天', plans.filter(p => p.period === 'daily' && catOk(p) && isFullyDone(p))],
      ['单次', plans.filter(p => p.period === 'once' && catOk(p) && isFullyDone(p))],
      ['每周', plans.filter(p => p.period === 'weekly' && catOk(p) && isFullyDone(p))],
      ['每月', plans.filter(p => p.period === 'monthly' && catOk(p) && isFullyDone(p))],
    ];
    html += `<div class="done-head"><button class="back-btn" data-action="back">← 返回</button><span>已完成</span></div>`;
    html += groups.some(g => g[1].length)
      ? groups.map(([t, list]) => list.length ? `<div class="section-title">✅ ${t}</div>` + list.map(doneCardHTML).join('') : '').join('')
      : emptyHTML('✅', '还没有彻底完成的任务');
  } else if (activeTab === 'calendar') {
    html = renderCalendar();
  } else {
    const groups = [
      ['每天', plans.filter(p => p.period === 'daily' && catOk(p) && active(p))],
      ['单次', plans.filter(p => p.period === 'once' && catOk(p) && active(p))],
      ['每周', plans.filter(p => p.period === 'weekly' && catOk(p) && active(p))],
      ['每月', plans.filter(p => p.period === 'monthly' && catOk(p) && active(p))],
    ];
    if (!groups.some(g => g[1].length)) { el.innerHTML = emptyHTML('🎉', '没有进行中的任务,真棒!'); return; }
    for (const [t, list] of groups) if (list.length) html += sectionHTML(t, list);
  }
  el.innerHTML = html;
}

function doneCardHTML(plan) {
  const color = CAT_COLORS[plan.category] || CAT_COLORS['其他'];
  const imp = plan.importance || 5;
  const impColor = imp >= 8 ? '#FF5D7A' : (imp >= 5 ? '#FF9A3D' : '#A0A8C0');
  return `<div class="card">
    <div class="card-top">
      <span class="tag" style="background:${color}">${esc(plan.category)}</span>
      <div class="card-title done">${esc(plan.title)}</div>
      <span class="imp" style="color:${impColor}">★${imp}</span>
      <span class="badge">${PERIOD_LABEL[plan.period]}</span>
    </div>
    <div class="card-foot">
      <span class="done-date">✓ 已完成</span>
      <span style="flex:1"></span>
      <button class="icon-btn" data-action="edit" data-id="${plan.id}">✏️</button>
      <button class="icon-btn" data-action="del" data-id="${plan.id}">🗑️</button>
    </div>
  </div>`;
}

function renderCalendar() {
  const today = dateStr(new Date());
  const y = calYear, m = calMonth;
  const wd = '日一二三四五六';
  const sd = new Date(calSel + 'T00:00:00');
  const selLabel = `${sd.getMonth() + 1}月${sd.getDate()}日 周${wd[sd.getDay()]}`;
  let html = `<div class="done-head"><button class="back-btn" data-action="back">← 返回</button><span>日历</span></div>`;
  html += `<div class="cal-head"><button class="cal-nav" data-action="cal-prev">‹</button><span>${y}年${m + 1}月</span><button class="cal-nav" data-action="cal-next">›</button></div>`;
  html += `<div class="cal-week">${['日', '一', '二', '三', '四', '五', '六'].map(w => `<span>${w}</span>`).join('')}</div>`;
  const firstDow = new Date(y, m, 1).getDay();
  const daysInMonth = new Date(y, m + 1, 0).getDate();
  html += `<div class="cal-grid">`;
  for (let i = 0; i < firstDow; i++) html += `<div class="cal-day empty"></div>`;
  for (let d = 1; d <= daysInMonth; d++) {
    const ds = `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const types = [...dotTypesOnDay(ds)];
    const dots = types.length ? `<div class="cal-dots">${types.map(t => `<i class="dot ${t}"></i>`).join('')}</div>` : '';
    html += `<div class="cal-day ${ds === today ? 'today' : ''} ${ds === calSel ? 'sel' : ''}" data-action="cal-day" data-date="${ds}">${d}${dots}</div>`;
  }
  html += `</div>`;
  const selTasks = tasksOnDay(calSel);
  html += `<div class="cal-detail"><div class="cal-detail-title">${selLabel}</div>`;
  html += selTasks.length ? selTasks.map(cardHTML).join('') : `<div class="empty">这天没有任务</div>`;
  html += `</div>`;
  return html;
}

function sectionHTML(title, list) {
  return `<div class="section-title">${title}</div>` + list.map(cardHTML).join('');
}
function emptyHTML(emoji, text) {
  return `<div class="empty"><span class="big">${emoji}</span>${text}</div>`;
}

function cardHTML(plan) {
  const st = stateAt(plan);
  const pct = shown(plan, st);
  const fullyDone = isFullyDone(plan);
  const checked = pct >= 100;
  const color = CAT_COLORS[plan.category] || CAT_COLORS['其他'];
  const imp = plan.importance || 5;
  const impColor = imp >= 8 ? '#FF5D7A' : (imp >= 5 ? '#FF9A3D' : '#A0A8C0');
  let html = `<div class="card" data-id="${plan.id}">
    <div class="card-top">
      <span class="tag" style="background:${color}">${esc(plan.category)}</span>
      <div class="card-title ${fullyDone ? 'done' : ''}">${esc(plan.title)}</div>
      ${checked && !fullyDone ? '<span class="tag" style="background:#4ED4A8">✓ 已打卡</span>' : ''}
      <span class="imp" style="color:${impColor}">★${imp}</span>
      <span class="badge">${PERIOD_LABEL[plan.period]}</span>
    </div>`;
  if (plan.period === 'once' && plan.due) html += `<p class="card-note">⏰ 截止 ${esc(plan.due)}</p>`;
  if (plan.endDate) html += `<p class="card-note">📅 截止 ${esc(plan.endDate)}</p>`;
  if (plan.note) html += `<p class="card-note">${esc(plan.note)}</p>`;

  if (plan.subtasks.length) {
    html += `<div class="subs">`;
    plan.subtasks.forEach((s, i) => {
      const on = !!(st && st.checked[i]);
      html += `<div class="sub"><input type="checkbox" data-action="sub" data-id="${plan.id}" data-i="${i}" ${on ? 'checked' : ''}/><label class="${on ? 'on' : ''}">${esc(s.text)}</label></div>`;
    });
    html += `</div>`;
  }

  if (plan.period === 'daily' && !plan.subtasks.length) {
    const doneToday = !!(st && st.doneAt);
    html += `<div class="card-foot">
      <button class="btn ${doneToday ? 'ghost' : 'primary'} mini" data-action="check" data-id="${plan.id}">${doneToday ? '✓ 已打卡' : '打卡'}</button>
      <span class="streak">🔥 ${streakOf(plan)} 天</span>
      <span style="flex:1"></span>
      <button class="icon-btn" data-action="edit" data-id="${plan.id}">✏️</button>
      <button class="icon-btn" data-action="del" data-id="${plan.id}">🗑️</button>
    </div>`;
  } else {
    html += `<div class="progress-row"><div class="bar"><i style="width:${pct}%"></i></div><input class="pct" type="number" min="0" max="100" value="${pct}" data-action="pct" data-id="${plan.id}"/></div>`;
    html += `<div class="slider-row"><input type="range" min="0" max="100" step="1" value="${pct}" data-action="slide" data-id="${plan.id}"/></div>
    <div class="card-foot">
      <button class="btn ${checked ? 'ghost' : 'primary'} mini" data-action="done" data-id="${plan.id}">${checked ? '↩ 取消完成' : '完成'}</button>
      ${plan.period === 'daily' ? `<span class="streak">🔥 ${streakOf(plan)} 天</span>` : ''}
      <span style="flex:1"></span>
      <button class="icon-btn" data-action="edit" data-id="${plan.id}">✏️</button>
      <button class="icon-btn" data-action="del" data-id="${plan.id}">🗑️</button>
    </div>`;
  }
  return html + '</div>';
}

// ---------- 事件:内容区 ----------
const content = document.getElementById('content');
content.addEventListener('change', (e) => {
  const t = e.target;
  const action = t.dataset.action;
  if (action === 'sub') {
    const plan = plans.find(p => p.id === t.dataset.id); if (!plan) return;
    const st = curState(plan);
    st.checked[+t.dataset.i] = t.checked;
    st.manual = null;
    commit();
    renderContent();
  } else if (action === 'slide' || action === 'pct') {
    const plan = plans.find(p => p.id === t.dataset.id); if (!plan) return;
    const v = Math.max(0, Math.min(100, +t.value || 0));
    if (v >= 100) {
      showDialog('进度到 100% 了,标记为「已完成」?', { okText: '完成', cancelText: '先不' }).then(ok => {
        const st = curState(plan);
        st.manual = ok ? 100 : 99;
        commit(); renderContent();
      });
    } else {
      const st = curState(plan);
      st.manual = v; commit(); renderContent();
    }
  }
});
content.addEventListener('input', (e) => {
  const t = e.target;
  const action = t.dataset.action;
  if (action !== 'slide' && action !== 'pct') return;
  const card = t.closest('.card'); if (!card) return;
  const v = Math.max(0, Math.min(100, +t.value || 0));
  card.querySelector('.bar i').style.width = v + '%';
  card.querySelector('.card-title').classList.toggle('done', v >= 100);
  const other = card.querySelector(action === 'slide' ? '.pct' : '.slider-row input[type=range]');
  if (other) other.value = v;
});
content.addEventListener('click', (e) => {
  const b = e.target.closest('[data-action]'); if (!b) return;
  const action = b.dataset.action;
  if (action === 'back') { activeTab = prevTab; render(); return; }
  if (action === 'miss') { openMiss(); return; }
  if (action === 'cal-prev') { calMonth--; if (calMonth < 0) { calMonth = 11; calYear--; } render(); return; }
  if (action === 'cal-next') { calMonth++; if (calMonth > 11) { calMonth = 0; calYear++; } render(); return; }
  if (action === 'cal-day') { calSel = b.dataset.date; render(); return; }
  const id = b.dataset.id;
  const plan = plans.find(p => p.id === id); if (!plan) return;

  if (action === 'check') {
    const st = curState(plan);
    if (st.doneAt) { st.doneAt = null; st.manual = null; }
    else { st.doneAt = new Date().toISOString(); st.manual = null; }
    commit(); renderContent();
  } else if (action === 'done') {
    const st = curState(plan);
    st.manual = (shown(plan, st) >= 100) ? 0 : 100;
    commit(); renderContent();
  } else if (action === 'edit' || action === 'del') {
    handlePlanAction(action, id);
  }
});

// ---------- 底部导航 / 分类 ----------
document.getElementById('tabbar').addEventListener('click', (e) => {
  const t = e.target.closest('.tab'); if (!t) return;
  activeTab = t.dataset.tab;
  document.querySelectorAll('.tab').forEach(x => x.classList.toggle('active', x === t));
  renderContent();
});
document.getElementById('cat-chips').addEventListener('click', (e) => {
  const c = e.target.closest('.chip'); if (!c) return;
  activeCat = c.dataset.cat;
  render();
});

// ---------- 计划弹窗 ----------
const overlay = document.getElementById('overlay');
document.getElementById('fab').addEventListener('click', () => openSheet(null));
document.getElementById('sheet-close').addEventListener('click', closeSheet);
document.getElementById('sheet-cancel').addEventListener('click', closeSheet);
document.getElementById('sheet-save').addEventListener('click', saveSheet);
overlay.addEventListener('click', (e) => { if (e.target === overlay) closeSheet(); });

function openSheet(id) {
  editingId = id;
  const plan = id ? plans.find(p => p.id === id) : null;
  document.getElementById('sheet-title').textContent = plan ? '编辑计划' : '新建计划';
  document.getElementById('f-title').value = plan ? plan.title : '';
  document.getElementById('f-note').value = plan ? (plan.note || '') : '';
  document.getElementById('f-due').value = (plan && plan.due) ? plan.due : '';
  document.getElementById('f-imp').value = plan ? (plan.importance || 5) : 5;
  document.getElementById('f-start').value = (plan && plan.startDate) ? plan.startDate : '';
  document.getElementById('f-end').value = (plan && plan.endDate) ? plan.endDate : '';
  draftCat = plan ? plan.category : '学习';
  draftPeriod = plan ? plan.period : 'daily';
  draftSubs = plan ? plan.subtasks.map(s => s.text) : [];
  renderCatSeg(); renderPeriodSeg(); renderSubDraft();
  overlay.hidden = false;
  document.getElementById('f-title').focus();
}
function closeSheet() { overlay.hidden = true; }

function renderCatSeg() {
  document.getElementById('f-cat').innerHTML =
    CATS.map(c => `<button class="${draftCat === c ? 'active' : ''}" data-cat="${c}">${c}</button>`).join('');
}
function renderPeriodSeg() {
  const type = draftPeriod === 'once' ? 'once' : 'recurring';
  document.querySelectorAll('#f-type button').forEach(b => b.classList.toggle('active', b.dataset.type === type));
  document.getElementById('f-cycle-wrap').hidden = draftPeriod === 'once';
  document.querySelectorAll('#f-cycle button').forEach(b => b.classList.toggle('active', b.dataset.cycle === draftPeriod));
  document.getElementById('f-due-wrap').hidden = draftPeriod !== 'once';
  document.getElementById('f-range-wrap').hidden = draftPeriod === 'once';
}
function renderSubDraft() {
  document.getElementById('f-sub-list').innerHTML =
    draftSubs.map((s, i) => `<div class="sub-list-item"><input type="text" value="${esc(s)}" data-i="${i}" data-role="sub-edit"/><button class="del icon-btn" data-i="${i}">✕</button></div>`).join('');
}

document.getElementById('f-cat').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  draftCat = b.dataset.cat; renderCatSeg();
});
document.getElementById('f-type').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  draftPeriod = b.dataset.type === 'once' ? 'once' : (draftPeriod === 'once' ? 'daily' : draftPeriod);
  renderPeriodSeg();
});
document.getElementById('f-cycle').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  draftPeriod = b.dataset.cycle; renderPeriodSeg();
});
document.getElementById('f-sub-list').addEventListener('input', (e) => {
  const t = e.target;
  if (t.dataset.role === 'sub-edit') draftSubs[+t.dataset.i] = t.value;
});
document.getElementById('f-sub-list').addEventListener('click', (e) => {
  const b = e.target.closest('.del'); if (!b) return;
  draftSubs.splice(+b.dataset.i, 1); renderSubDraft();
});
document.getElementById('f-sub-input').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  const v = e.target.value.trim();
  if (v) { draftSubs.push(v); e.target.value = ''; renderSubDraft(); }
});

function saveSheet() {
  const title = document.getElementById('f-title').value.trim();
  if (!title) { alert('标题不能为空哦'); return; }
  const note = document.getElementById('f-note').value.trim();
  const due = (draftPeriod === 'once') ? (document.getElementById('f-due').value || null) : null;
  const importance = Math.max(1, Math.min(10, +document.getElementById('f-imp').value || 5));
  const startDate = (draftPeriod !== 'once') ? (document.getElementById('f-start').value || null) : null;
  const endDate = (draftPeriod !== 'once') ? (document.getElementById('f-end').value || null) : null;
  const subtasks = draftSubs.map(t => ({ id: uid(), text: t })).filter(s => s.text.trim());

  if (editingId) {
    const plan = plans.find(p => p.id === editingId);
    Object.assign(plan, { title, category: draftCat, period: draftPeriod, note, due, importance, startDate, endDate, subtasks });
    reconcile(plan);
  } else {
    plans.push({ id: uid(), title, category: draftCat, period: draftPeriod, note, due, importance, startDate, endDate, subtasks, createdAt: Date.now() });
  }
  commit(); render(); closeSheet();
}
function reconcile(plan) {
  const stAll = progress[plan.id]; if (!stAll) return;
  const n = plan.subtasks.length;
  for (const k in stAll) {
    const arr = stAll[k].checked || (stAll[k].checked = []);
    while (arr.length < n) arr.push(false);
    if (arr.length > n) arr.length = n;
  }
}

// ---------- 同步按钮 / 弹窗事件 ----------
document.getElementById('sync-close').addEventListener('click', () => { document.getElementById('sync-overlay').hidden = true; });
document.getElementById('sync-overlay').addEventListener('click', (e) => {
  if (e.target === document.getElementById('sync-overlay')) document.getElementById('sync-overlay').hidden = true;
});

// 鲸鱼菜单 / 已完成
document.getElementById('menu-btn').addEventListener('click', () => { document.getElementById('whale-overlay').hidden = false; });
document.getElementById('whale-close').addEventListener('click', () => { document.getElementById('whale-overlay').hidden = true; });
document.getElementById('whale-overlay').addEventListener('click', (e) => { if (e.target === document.getElementById('whale-overlay')) document.getElementById('whale-overlay').hidden = true; });
document.getElementById('menu-sync').addEventListener('click', () => {
  document.getElementById('whale-overlay').hidden = true;
  openSync();
});
document.getElementById('menu-done').addEventListener('click', () => {
  document.getElementById('whale-overlay').hidden = true;
  prevTab = activeTab;
  activeTab = 'done';
  render();
});
document.getElementById('menu-cal').addEventListener('click', () => {
  document.getElementById('whale-overlay').hidden = true;
  prevTab = activeTab;
  calYear = new Date().getFullYear();
  calMonth = new Date().getMonth();
  calSel = dateStr(new Date());
  activeTab = 'calendar';
  render();
});

function handlePlanAction(action, id) {
  const plan = plans.find(p => p.id === id); if (!plan) return;
  if (action === 'edit') { openSheet(id); return; }
  if (action === 'del') {
    showDialog('删除「' + plan.title + '」?', { okText: '删除' }).then(ok => {
      if (ok) {
        plans = plans.filter(p => p.id !== id);
        delete progress[id];
        commit(); render();
      }
    });
  }
}

// 补卡
document.getElementById('miss-close').addEventListener('click', () => { document.getElementById('miss-overlay').hidden = true; });
document.getElementById('miss-overlay').addEventListener('click', (e) => { if (e.target === document.getElementById('miss-overlay')) document.getElementById('miss-overlay').hidden = true; });
document.getElementById('miss-save').addEventListener('click', () => {
  let n = 0;
  document.querySelectorAll('#miss-body input[type=checkbox]:checked').forEach(cb => {
    const pid = cb.dataset.id, date = cb.dataset.date;
    if (!progress[pid]) progress[pid] = {};
    progress[pid][date] = { doneAt: new Date().toISOString(), checked: [], manual: null };
    n++;
  });
  if (n === 0) { alertBox('没勾选任何天哦'); return; }
  commit(); render();
  document.getElementById('miss-overlay').hidden = true;
});

function openMiss() { renderMissBody(); document.getElementById('miss-overlay').hidden = false; }
function renderMissBody() {
  const el = document.getElementById('miss-body');
  const daily = plans.filter(p => p.period === 'daily' && !isFullyDone(p));
  let html = '';
  let any = false;
  for (const p of daily) {
    const days = missedDays(p, 30);
    if (!days.length) continue;
    any = true;
    html += `<div class="miss-habit">${esc(p.title)}</div>`;
    for (const d of days) {
      html += `<label class="miss-day"><input type="checkbox" data-id="${p.id}" data-date="${d.date}"/>${esc(d.label)}</label>`;
    }
  }
  el.innerHTML = any ? html : '<div class="empty"><span class="big">🎉</span>没有漏打卡,真棒</div>';
}

// ---------- 问候语 / 启动 ----------
function greet() {
  const h = new Date().getHours();
  if (h < 6) return '夜深了,早点睡哦';
  if (h < 12) return '早上好,新的一天加油';
  if (h < 18) return '下午好,继续加油';
  return '晚上好,今天辛苦啦';
}

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
document.getElementById('today-line').textContent = greet();
render();
updateSyncBtn();
if (syncToken) syncFromRemote();
