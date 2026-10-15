// ===== 计划鲸灵 · 核心逻辑 =====
'use strict';

const LS_PLANS = 'jql_plans_v1';
const LS_PROGRESS = 'jql_progress_v1';

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
let activeCat = '全部';
let editingId = null;
let draftCat = '学习';
let draftPeriod = 'daily';
let draftSubs = [];

// ---------- 基础工具 ----------
function load(key, fallback) {
  try { const v = JSON.parse(localStorage.getItem(key)); return v == null ? fallback : v; }
  catch (e) { return fallback; }
}
function save() {
  localStorage.setItem(LS_PLANS, JSON.stringify(plans));
  localStorage.setItem(LS_PROGRESS, JSON.stringify(progress));
}
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
function streakOf(plan) {
  let n = 0;
  const d = new Date();
  if (!isDayDone(plan, d)) d.setDate(d.getDate() - 1); // 今天没完成就从昨天开始数
  while (isDayDone(plan, d)) { n++; d.setDate(d.getDate() - 1); }
  return n;
}

// ---------- 渲染 ----------
function render() { renderChips(); renderContent(); }

function renderChips() {
  const el = document.getElementById('cat-chips');
  const cats = ['全部', ...CATS];
  el.innerHTML = cats.map(c => `<button class="chip ${activeCat === c ? 'active' : ''}" data-cat="${c}">${c}</button>`).join('');
}

function renderContent() {
  const el = document.getElementById('content');
  const catOk = p => activeCat === '全部' || p.category === activeCat;
  let html = '';

  if (activeTab === 'today') {
    const daily = plans.filter(p => p.period === 'daily' && catOk(p));
    const once = plans.filter(p => p.period === 'once' && catOk(p) && shown(p, stateAt(p)) < 100);
    if (!daily.length && !once.length) { el.innerHTML = emptyHTML('🐳', '今天还没有计划,点下面 ＋ 新建一个吧'); return; }
    if (daily.length) html += sectionHTML('🌤️ 每天打卡', daily);
    if (once.length) html += sectionHTML('📌 待办', once);
  } else if (activeTab === 'week') {
    const list = plans.filter(p => p.period === 'weekly' && catOk(p));
    html = list.length ? sectionHTML('🗓️ 本周目标', list) : emptyHTML('🗓️', '本周还没有目标');
  } else if (activeTab === 'month') {
    const list = plans.filter(p => p.period === 'monthly' && catOk(p));
    html = list.length ? sectionHTML('📆 本月目标', list) : emptyHTML('📆', '本月还没有目标');
  } else {
    const groups = [
      ['每天', plans.filter(p => p.period === 'daily' && catOk(p))],
      ['单次', plans.filter(p => p.period === 'once' && catOk(p))],
      ['每周', plans.filter(p => p.period === 'weekly' && catOk(p))],
      ['每月', plans.filter(p => p.period === 'monthly' && catOk(p))],
    ];
    if (!groups.some(g => g[1].length)) { el.innerHTML = emptyHTML('🐳', '还没有计划,点下面 ＋ 新建一个吧'); return; }
    for (const [t, list] of groups) if (list.length) html += sectionHTML(t, list);
  }
  el.innerHTML = html;
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
  const done = pct >= 100;
  const color = CAT_COLORS[plan.category] || CAT_COLORS['其他'];
  let html = `<div class="card" data-id="${plan.id}">
    <div class="card-top">
      <span class="tag" style="background:${color}">${esc(plan.category)}</span>
      <div class="card-title ${done ? 'done' : ''}">${esc(plan.title)}</div>
      <span class="badge">${PERIOD_LABEL[plan.period]}</span>
    </div>`;
  if (plan.period === 'once' && plan.due) html += `<p class="card-note">⏰ 截止 ${esc(plan.due)}</p>`;
  if (plan.note) html += `<p class="card-note">${esc(plan.note)}</p>`;

  if (plan.subtasks.length) {
    html += `<div class="subs">`;
    plan.subtasks.forEach((s, i) => {
      const on = !!(st && st.checked[i]);
      html += `<div class="sub"><input type="checkbox" data-action="sub" data-id="${plan.id}" data-i="${i}" ${on ? 'checked' : ''}/><label class="${on ? 'on' : ''}">${esc(s.text)}</label></div>`;
    });
    html += `</div>`;
  }

  html += `<div class="progress-row"><div class="bar"><i style="width:${pct}%"></i></div><span class="pct">${pct}%</span></div>`;

  if (plan.period === 'daily' && !plan.subtasks.length) {
    const doneToday = !!(st && st.doneAt);
    html += `<div class="card-foot">
      <button class="btn ${doneToday ? 'ghost' : 'primary'} mini" data-action="check" data-id="${plan.id}">${doneToday ? '已打卡 ✓' : '打卡'}</button>
      <span class="streak">🔥 ${streakOf(plan)} 天</span>
      <span style="flex:1"></span>
      <button class="icon-btn" data-action="edit" data-id="${plan.id}">✏️</button>
      <button class="icon-btn" data-action="del" data-id="${plan.id}">🗑️</button>
    </div>`;
  } else {
    html += `<div class="slider-row"><input type="range" min="0" max="100" step="1" value="${pct}" data-action="slide" data-id="${plan.id}"/></div>
    <div class="card-foot">
      <button class="btn ${done ? 'ghost' : 'primary'} mini" data-action="done" data-id="${plan.id}">${done ? '↩ 取消完成' : '完成'}</button>
      ${plan.period === 'daily' ? `<span class="streak">🔥 ${streakOf(plan)} 天</span>` : ''}
      <span style="flex:1"></span>
      <button class="icon-btn" data-action="edit" data-id="${plan.id}">✏️</button>
      <button class="icon-btn" data-action="del" data-id="${plan.id}">🗑️</button>
    </div>`;
  }
  return html + '</div>';
}

// ---------- 事件：内容区 ----------
const content = document.getElementById('content');
content.addEventListener('change', (e) => {
  const t = e.target;
  if (t.dataset.action !== 'sub') return;
  const plan = plans.find(p => p.id === t.dataset.id); if (!plan) return;
  const st = curState(plan);
  st.checked[+t.dataset.i] = t.checked;
  st.manual = null;          // 勾子任务后回到自动计算
  save();
  renderContent();
});
content.addEventListener('input', (e) => {
  const t = e.target;
  if (t.dataset.action !== 'slide') return;
  const plan = plans.find(p => p.id === t.dataset.id); if (!plan) return;
  const st = curState(plan);
  st.manual = +t.value;
  save();
  const card = t.closest('.card');
  card.querySelector('.pct').textContent = t.value + '%';
  card.querySelector('.bar i').style.width = t.value + '%';
  card.querySelector('.card-title').classList.toggle('done', +t.value >= 100);
});
content.addEventListener('click', (e) => {
  const b = e.target.closest('[data-action]'); if (!b) return;
  const id = b.dataset.id;
  const plan = plans.find(p => p.id === id); if (!plan) return;
  const action = b.dataset.action;

  if (action === 'check') {
    const st = curState(plan);
    if (st.doneAt) { st.doneAt = null; st.manual = null; }
    else { st.doneAt = new Date().toISOString(); st.manual = null; }
    save(); renderContent();
  } else if (action === 'done') {
    const st = curState(plan);
    st.manual = (shown(plan, st) >= 100) ? 0 : 100;
    save(); renderContent();
  } else if (action === 'edit') {
    openSheet(id);
  } else if (action === 'del') {
    if (confirm('删除「' + plan.title + '」?')) {
      plans = plans.filter(p => p.id !== id);
      delete progress[id];
      save(); render();
    }
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

// ---------- 弹窗 ----------
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
  document.querySelectorAll('#f-period button').forEach(b => b.classList.toggle('active', b.dataset.period === draftPeriod));
  document.getElementById('f-due-wrap').hidden = draftPeriod !== 'once';
}
function renderSubDraft() {
  document.getElementById('f-sub-list').innerHTML =
    draftSubs.map((s, i) => `<div class="sub-list-item"><input type="text" value="${esc(s)}" data-i="${i}" data-role="sub-edit"/><button class="del icon-btn" data-i="${i}">✕</button></div>`).join('');
}

document.getElementById('f-cat').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  draftCat = b.dataset.cat; renderCatSeg();
});
document.getElementById('f-period').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  draftPeriod = b.dataset.period; renderPeriodSeg();
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
  const subtasks = draftSubs.map(t => ({ id: uid(), text: t })).filter(s => s.text.trim());

  if (editingId) {
    const plan = plans.find(p => p.id === editingId);
    Object.assign(plan, { title, category: draftCat, period: draftPeriod, note, due, subtasks });
    reconcile(plan);
  } else {
    plans.push({ id: uid(), title, category: draftCat, period: draftPeriod, note, due, subtasks, createdAt: Date.now() });
  }
  save(); render(); closeSheet();
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
