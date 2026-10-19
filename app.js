// ===== 计划鲸灵 · 核心逻辑(含云端同步)=====
'use strict';

const LS_PLANS = 'jql_plans_v1';
const LS_PROGRESS = 'jql_progress_v1';
const LS_TOKEN = 'jql_token';
const LS_TOPIC = 'jql_ntfy_topic';
const LS_SCHED = 'jql_scheduled_v1';

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
let fullScreenTab = null;
let calYear = new Date().getFullYear();
let calMonth = new Date().getMonth();
let calSel = dateStr(new Date());
let calMode = 'active';
let sortGroups = { event: true, deadline: true, weekly: true, monthly: true };
let sortMethod = 'importance';
let expandedIds = new Set();
let activeCat = '全部';
let editingId = null;
let draftCat = '学习';
let draftPeriod = 'daily';
let draftOnceType = 'deadline';
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
function daysUntil(ds) {
  if (!ds) return null;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const due = new Date(ds + 'T00:00:00');
  return Math.round((due - today) / 86400000);
}
function countdownText(plan) {
  const d = daysUntil(plan.due);
  if (d == null) return '';
  const ev = plan.onceType === 'event';
  if (d === 0) return ev ? '今天' : '今天截止';
  if (d === 1) return ev ? '明天' : '明天截止';
  if (d > 1) return ev ? `还有 ${d} 天` : `还有 ${d} 天截止`;
  return ev ? `已过 ${-d} 天` : `已截止 ${-d} 天`;
}
function periodRemain(plan) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  if (plan.period === 'weekly') return (7 - today.getDay()) % 7;
  if (plan.period === 'monthly') {
    const last = new Date(today.getFullYear(), today.getMonth() + 1, 0);
    return Math.round((last - today) / 86400000);
  }
  return null;
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
function completedOnDay(plan, ds) {
  const d = new Date(ds + 'T00:00:00');
  if (plan.period === 'daily') return isDayDone(plan, d);
  if (plan.period === 'once') return isFullyDone(plan) && plan.due === ds;
  if (plan.period === 'weekly') return isFullyDone(plan) && d.getDay() === 0;
  if (plan.period === 'monthly') return isFullyDone(plan) && d.getDate() === new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  return false;
}
function completedTypesOnDay(ds) {
  const types = new Set();
  for (const p of plans) {
    if (!completedOnDay(p, ds)) continue;
    if (p.period === 'daily') types.add('daily');
    else if (p.period === 'once') types.add('once');
    else if (p.period === 'weekly') types.add('weekly');
    else if (p.period === 'monthly') types.add('monthly');
  }
  return types;
}
function completedTasksOnDay(ds) {
  return plans.filter(p => completedOnDay(p, ds));
}
function allTypesOnDay(ds) {
  const s = new Set(dotTypesOnDay(ds));
  for (const t of completedTypesOnDay(ds)) s.add(t);
  return s;
}
function allTasksOnDay(ds) {
  const map = new Map();
  for (const p of tasksOnDay(ds)) map.set(p.id, p);
  for (const p of completedTasksOnDay(ds)) map.set(p.id, p);
  return [...map.values()];
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
      runReminderEngine();
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

// ---------- 提醒(ntfy 推送)----------
// ntfy.sh 免费版对「定时消息」有硬上限:最长只能预约 72 小时(实测 72.5h 起返回 40006)。
// 所以只往前排 3 天差 1 分钟,留一点时钟误差余量。
const REMIND_HORIZON_MS = 3 * 24 * 3600 * 1000 - 60 * 1000;

function getTopic() {
  let t = localStorage.getItem(LS_TOPIC);
  if (t) return t;
  const bytes = new Uint8Array(16);
  if (window.crypto && crypto.getRandomValues) crypto.getRandomValues(bytes);
  else for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  t = 'jql-' + Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  localStorage.setItem(LS_TOPIC, t);
  return t;
}
function saveSched(s) { localStorage.setItem(LS_SCHED, JSON.stringify(s)); }

function shouldRemindOn(plan, day) {
  const ds = dateStr(day);
  if (plan.period === 'once') {
    return !!(plan.due && ds === plan.due && !isFullyDone(plan));
  }
  if (plan.startDate && ds < plan.startDate) return false;
  if (plan.endDate && ds > plan.endDate) return false;
  if (isFullyDone(plan)) return false;
  if (plan.period === 'daily') return true;
  if (plan.period === 'weekly') return day.getDay() === 0;
  if (plan.period === 'monthly') return day.getDate() === new Date(day.getFullYear(), day.getMonth() + 1, 0).getDate();
  return false;
}
function reminderTimes(plan, from, to) {
  const m = /^(\d{2}):(\d{2})$/.exec(plan.remindTime || '');
  if (!m) return [];
  const h = +m[1], min = +m[2];
  const out = [];
  const d = new Date(from); d.setHours(0, 0, 0, 0);
  const end = new Date(to);
  while (d <= end) {
    const t = new Date(d); t.setHours(h, min, 0, 0);
    if (t >= from && t <= to && shouldRemindOn(plan, d)) out.push(t);
    d.setDate(d.getDate() + 1);
  }
  return out;
}
function reminderMessage(plan) {
  const t = plan.title;
  if (plan.period === 'once') {
    return plan.onceType === 'event'
      ? { title: '📌 今天有安排', body: `「${t}」` }
      : { title: '⏰ 今天截止', body: `「${t}」今天截止,别忘啦` };
  }
  if (plan.period === 'daily') return { title: '🐋 该打卡啦', body: `「${t}」还没打卡,加油!` };
  if (plan.period === 'weekly') return { title: '🗓️ 本周目标', body: `「${t}」本周结束,完成了吗?` };
  if (plan.period === 'monthly') return { title: '📆 本月目标', body: `「${t}」本月结束,完成了吗?` };
  return { title: '🐋 计划鲸灵', body: t };
}
function sidFor(plan, t) {
  const hh = String(t.getHours()).padStart(2, '0');
  const mm = String(t.getMinutes()).padStart(2, '0');
  return plan.id + '-' + dateStr(t) + '-' + hh + mm;
}
async function publishReminder(job) {
  try {
    const url = `https://ntfy.sh/${getTopic()}?title=${encodeURIComponent(job.title)}`;
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'Priority': '4',
        'At': job.at.toISOString().replace(/\.\d{3}Z$/, 'Z'),
        'X-Sequence-ID': job.sid,
      },
      body: job.body,
    });
    return r.ok;
  } catch (e) { return false; }
}
async function cancelReminder(sid) {
  try {
    const r = await fetch(`https://ntfy.sh/${getTopic()}/${sid}`, { method: 'DELETE' });
    return r.ok;
  } catch (e) { return false; }
}
async function runReminderEngine() {
  const sched = load(LS_SCHED, {});
  if (!plans.some(p => p.remindTime) && !Object.keys(sched).length) return;
  const now = new Date();
  const to = new Date(now.getTime() + REMIND_HORIZON_MS);
  const byId = new Map(plans.map(p => [p.id, p]));
  const today = dateStr(new Date());

  const toCancel = [];
  const jobs = [];

  // 清理:已过期直接本地删;计划删除/关闭提醒 → 取消 ntfy 端再删
  for (const key of Object.keys(sched)) {
    const i = key.indexOf('|');
    const pid = key.slice(0, i), day = key.slice(i + 1);
    const plan = byId.get(pid);
    if (day < today) { delete sched[key]; continue; }
    if (!plan || !plan.remindTime) { toCancel.push(sched[key].sid); delete sched[key]; }
  }
  // 计算要(重新)发布的提醒
  for (const p of plans) {
    if (!p.remindTime) continue;
    for (const t of reminderTimes(p, now, to)) {
      const key = p.id + '|' + dateStr(t);
      const cur = sched[key];
      if (cur && cur.at === t.getTime()) continue;   // 没变,跳过
      const sid = sidFor(p, t);
      const msg = reminderMessage(p);
      jobs.push({ key, sid, oldSid: cur ? cur.sid : null, at: t, title: msg.title, body: msg.body });
      sched[key] = { at: t.getTime(), sid };
    }
  }
  saveSched(sched);

  for (const sid of toCancel) await cancelReminder(sid);
  for (const j of jobs) {
    const ok = await publishReminder(j);
    if (ok) { if (j.oldSid) await cancelReminder(j.oldSid); }
    else { delete sched[j.key]; saveSched(sched); }
  }
}
async function sendTestReminder() {
  try {
    const url = `https://ntfy.sh/${getTopic()}?title=${encodeURIComponent('🐋 测试成功')}`;
    const r = await fetch(url, { method: 'POST', headers: { 'Priority': '4' }, body: '计划鲸灵提醒已连通!到点就会这样提醒你。' });
    if (r.ok) alertBox('已发送!去看手机 ntfy App 有没有弹出这条通知。');
    else alertBox('发送失败(HTTP ' + r.status + ')。可能是网络连不上 ntfy.sh。');
  } catch (e) { alertBox('发送失败,连不上 ntfy.sh。'); }
}
function copyTopic() {
  const topic = getTopic();
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(topic).then(() => alertBox('已复制,去 ntfy App 里粘贴订阅'));
  } else {
    showDialog('请手动复制这串频道名:\n\n' + topic, { hideCancel: true });
  }
}
function openRemind() {
  const topic = getTopic();
  document.getElementById('remind-body').innerHTML = `
    <p class="sync-desc">给计划设置「提醒时间」后,到点会推送到你手机。先发一条测试,确认手机能收到。</p>
    <div class="field"><span>你的私密频道(在 ntfy App 里订阅它)</span>
      <div class="topic-row"><code>${topic}</code><button class="btn ghost mini" id="remind-copy">复制</button></div>
    </div>
    <div class="sheet-actions"><button class="btn primary" id="remind-test">📲 发送测试提醒</button></div>
    <p class="sync-desc" style="text-align:left;margin-top:16px">使用步骤:<br>① 手机应用商店搜 <b>ntfy</b> 安装;<br>② 打开 ntfy → 点「+」→ 订阅上面这串频道;<br>③ 点「发送测试提醒」,手机能收到即成功。<br>之后给计划填好提醒时间,到点 ntfy 就会弹。</p>
    <p class="sync-desc" style="text-align:left">⚠️ ntfy 免费版只能预约 <b>3 天内</b>的提醒。所以 App 至少每 3 天打开一次,提醒才会一直排上队。</p>`;
  document.getElementById('remind-test').onclick = sendTestReminder;
  document.getElementById('remind-copy').onclick = copyTopic;
  document.getElementById('remind-overlay').hidden = false;
}

// ---------- 鲸灵助手(DeepSeek)----------
const DS_API = 'https://api.deepseek.com/chat/completions';
const LS_DS_KEY = 'jql_ds_key';
const DS_MODEL = 'deepseek-chat';

const LS_CHAT = 'jql_chat_v1';
const CHAT_MAX = 50;

let dsKey = localStorage.getItem(LS_DS_KEY) || null;
let chatHistory = (() => {
  try { return JSON.parse(localStorage.getItem(LS_CHAT)) || []; } catch (e) { return []; }
})();
let pendingAction = null;
let chatBusy = false;

function clampInt(v, def, min, max) { v = parseInt(v, 10); return isNaN(v) ? def : Math.max(min, Math.min(max, v)); }
function validTime(s) { return typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s); }
function plansSummary() {
  if (!plans.length) return '(当前没有任何计划)';
  return plans.map(p => {
    const parts = [p.title, '分类' + (p.category || '其他'), PERIOD_LABEL[p.period] || p.period];
    if (p.period === 'once' && p.due) parts.push((p.onceType === 'event' ? '事件' : '截止') + p.due);
    if (p.remindTime) parts.push('提醒' + p.remindTime);
    return parts.join(',');
  }).join(';\n');
}
function systemPrompt() {
  const today = dateStr(new Date());
  const wd = '日一二三四五六';
  return `你是「计划鲸灵」App 内置的智能助手「鲸灵」。你只负责听懂用户的话并翻译成结构化操作,真正的数据操作由 App 执行。你只能通过工具(tools)操作,不要凭空编造数据。

# 这是什么 App
一个可爱的计划/打卡管理应用。核心是「计划」:一个要完成的任务或习惯,可设置提醒。

# 计划的字段
- title 标题(必填,简短)
- category 分类,只能是 学习/工作/生活/健身/其他
- period 周期,只能 once/daily/weekly/monthly(单次/每天/每周/每月)
- onceType 仅 period=once 时用:event=当天事件,deadline=截止任务
- due 仅 period=once 时用,日期 YYYY-MM-DD
- note 备注(可选)
- importance 重要度 1-10,默认 5
- startDate/endDate 仅循环任务用,日期范围(可选)
- subtasks 子任务(字符串数组,可选)
- remindTime 提醒时间 "HH:MM"(可选,空=不提醒)

# 提醒
设 remindTime 后到点会推送提醒。例如"每天9点提醒我背单词"→ period=daily, remindTime="09:00"。

# 今天是
${today}(周${wd[new Date().getDay()]})。换算"明天/后天/本周日/下周五"等相对时间时,以此为准算成 YYYY-MM-DD。

# 当前已有计划(供你定位,避免重复添加)
${plansSummary()}

# 工具
1. add_plan 新建计划
2. delete_plan 删除计划(用 match 关键词定位)
3. edit_plan 修改计划(用 match 定位 + 要改的字段)
4. query_plans 查询计划

# 理解规则
- "每天/每日/天天 X点做Y"→ period=daily, remindTime=换算成 HH:MM
- "每周X做Y"→ weekly;"每月X做Y"→ monthly
- "周五截止交报告/周五前完成"→ once, onceType=deadline, due=这个周五
- "今天下午开会/明天去看牙"→ once, onceType=event, due=相应日期
- 时间:早上8点/8点→08:00;晚上8点/晚8点→20:00;下午3点→15:00
- 分类按内容猜:背单词/学习→学习;跑步/健身→健身;开会/报告/项目→工作;购物/家务→生活;猜不准用"其他"
- 重要度没说就用 5
- 只说"加个任务:xxx"、没提周期和时间:默认 once, onceType=deadline, due=今天
- 删/改时,match 用任务标题里的关键词(尽量唯一)

# 规则
- 必须通过工具操作,返回合法工具调用。
- title 简洁准确,提取核心意图。
- 日期/时间严格换算,不要臆造。
- 指令含糊、缺必要信息(如删哪个说不清)时,不要调工具,直接回复一个澄清问题。`;
}
const DS_TOOLS = [
  { type: 'function', function: { name: 'add_plan', description: '新建一个计划', parameters: { type: 'object', properties: {
    title: { type: 'string', description: '标题' },
    category: { type: 'string', enum: CATS },
    period: { type: 'string', enum: ['once', 'daily', 'weekly', 'monthly'] },
    onceType: { type: 'string', enum: ['event', 'deadline'] },
    due: { type: 'string', description: 'YYYY-MM-DD,仅once时' },
    note: { type: 'string' },
    importance: { type: 'integer', minimum: 1, maximum: 10 },
    startDate: { type: 'string', description: 'YYYY-MM-DD' },
    endDate: { type: 'string', description: 'YYYY-MM-DD' },
    subtasks: { type: 'array', items: { type: 'string' } },
    remindTime: { type: 'string', description: 'HH:MM' }
  }, required: ['title'] } } },
  { type: 'function', function: { name: 'delete_plan', description: '删除计划', parameters: { type: 'object', properties: {
    match: { type: 'string', description: '要删的任务标题关键词' }
  }, required: ['match'] } } },
  { type: 'function', function: { name: 'edit_plan', description: '修改计划', parameters: { type: 'object', properties: {
    match: { type: 'string', description: '要改的任务标题关键词' },
    title: { type: 'string' },
    category: { type: 'string', enum: CATS },
    period: { type: 'string', enum: ['once', 'daily', 'weekly', 'monthly'] },
    onceType: { type: 'string', enum: ['event', 'deadline'] },
    due: { type: 'string' },
    note: { type: 'string' },
    importance: { type: 'integer' },
    remindTime: { type: 'string', description: 'HH:MM,空字符串表示取消提醒' },
    startDate: { type: 'string' },
    endDate: { type: 'string' }
  }, required: ['match'] } } },
  { type: 'function', function: { name: 'query_plans', description: '查询计划', parameters: { type: 'object', properties: {
    type: { type: 'string', enum: ['today', 'week', 'month', 'all'], description: 'today今天/week本周/month本月/all全部' }
  }, required: ['type'] } } }
];

async function callDeepSeek(messages, tools) {
  const body = { model: DS_MODEL, messages, stream: false };
  if (tools) body.tools = tools;
  const r = await fetch(DS_API, { method: 'POST', headers: { 'Authorization': 'Bearer ' + dsKey, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) {
    let msg = 'HTTP ' + r.status;
    try { const j = await r.json(); if (j.error && j.error.message) msg = j.error.message; } catch (e) {}
    throw new Error(msg);
  }
  return r.json();
}

function saveChat() {
  try { localStorage.setItem(LS_CHAT, JSON.stringify(chatHistory.slice(-CHAT_MAX))); } catch (e) {}
}
function pushMsg(role, text) {
  chatHistory.push({ role: role, text: text });
  if (chatHistory.length > CHAT_MAX) chatHistory = chatHistory.slice(-CHAT_MAX);
  saveChat();
}
function findPlans(match) {
  const m = (match || '').toLowerCase();
  if (!m) return [];
  const exact = plans.filter(p => p.title.toLowerCase() === m);
  if (exact.length) return exact;
  return plans.filter(p => p.title.toLowerCase().includes(m));
}
function doAddPlan(a) {
  const title = (a.title || '').trim();
  if (!title) return '标题是空的,没加成。';
  const period = ['once', 'daily', 'weekly', 'monthly'].includes(a.period) ? a.period : 'once';
  const plan = {
    id: uid(), title,
    category: CATS.includes(a.category) ? a.category : '其他',
    period,
    onceType: period === 'once' ? (a.onceType === 'event' ? 'event' : 'deadline') : null,
    note: a.note || '',
    due: period === 'once' ? (a.due || null) : null,
    importance: clampInt(a.importance, 5, 1, 10),
    startDate: period !== 'once' ? (a.startDate || null) : null,
    endDate: period !== 'once' ? (a.endDate || null) : null,
    subtasks: Array.isArray(a.subtasks) ? a.subtasks.filter(s => s && s.trim()).map(s => ({ id: uid(), text: s.trim() })) : [],
    remindTime: validTime(a.remindTime) ? a.remindTime : null,
    createdAt: Date.now()
  };
  plans.push(plan);
  commit(); render();
  if (plan.remindTime) runReminderEngine();
  return '✅ 已添加「' + title + '」' + (period !== 'once' ? ' · ' + PERIOD_LABEL[period] : '') + (plan.remindTime ? ' · 提醒 ' + plan.remindTime : '');
}
function doDeletePlan(a) {
  const found = findPlans(a.match);
  if (!found.length) { pushMsg('assistant', '没找到和「' + (a.match || '') + '」匹配的任务,再说清楚点?'); return; }
  pendingAction = { type: 'delete', planIds: found.map(p => p.id), label: found.length === 1 ? found[0].title : ('这 ' + found.length + ' 个任务') };
}
function editSummary(ch) {
  const parts = [];
  if (ch.title) parts.push('标题→' + ch.title);
  if (ch.category) parts.push('分类→' + ch.category);
  if (ch.period) parts.push('周期→' + PERIOD_LABEL[ch.period]);
  if ('remindTime' in ch) parts.push('提醒→' + (ch.remindTime || '取消'));
  if (ch.due) parts.push('日期→' + ch.due);
  if (ch.importance) parts.push('重要度→' + ch.importance);
  return parts.join(',') || '内容不变';
}
function doEditPlan(a) {
  const found = findPlans(a.match);
  if (!found.length) { pushMsg('assistant', '没找到和「' + (a.match || '') + '」匹配的任务,再说清楚点?'); return; }
  if (found.length > 1) { pushMsg('assistant', '「' + (a.match || '') + '」匹配到好几个任务,说具体一点?'); return; }
  const ch = {};
  if (a.title) ch.title = a.title.trim();
  if (CATS.includes(a.category)) ch.category = a.category;
  if (['once', 'daily', 'weekly', 'monthly'].includes(a.period)) ch.period = a.period;
  if (a.onceType === 'event' || a.onceType === 'deadline') ch.onceType = a.onceType;
  if ('due' in a) ch.due = a.due || null;
  if ('note' in a) ch.note = a.note || '';
  if ('importance' in a && a.importance != null) ch.importance = clampInt(a.importance, 5, 1, 10);
  if ('startDate' in a) ch.startDate = a.startDate || null;
  if ('endDate' in a) ch.endDate = a.endDate || null;
  if ('remindTime' in a) ch.remindTime = validTime(a.remindTime) ? a.remindTime : null;
  if (!Object.keys(ch).length) { pushMsg('assistant', '好像没有要改的内容,再说清楚点?'); return; }
  pendingAction = { type: 'edit', planId: found[0].id, changes: ch, label: found[0].title, summary: editSummary(ch) };
}
function queryPlansByType(t) {
  if (t === 'all') return plans.filter(p => !isFullyDone(p));
  if (t === 'week') return plans.filter(p => p.period === 'weekly' && !isFullyDone(p));
  if (t === 'month') return plans.filter(p => p.period === 'monthly' && !isFullyDone(p));
  const today = dateStr(new Date());
  return plans.filter(p => {
    if (p.period === 'daily') return !isFullyDone(p);
    if (p.period === 'once') return !isFullyDone(p) && planOnDay(p, today);
    return false;
  });
}
function doQueryPlans(a) {
  const t = a.type || 'today';
  const list = queryPlansByType(t);
  if (!list.length) return t === 'today' ? '今天没有待办,真棒 🎉' : '没有符合条件的任务。';
  return list.map(p => '· ' + p.title + '（' + PERIOD_LABEL[p.period] + (p.remindTime ? ',提醒' + p.remindTime : '') + '）').join('\n');
}

async function handleToolCall(tc) {
  const fn = tc.function || {};
  let args = {};
  try { args = (typeof fn.arguments === 'string') ? JSON.parse(fn.arguments) : (fn.arguments || {}); } catch (e) { args = {}; }
  if (fn.name === 'add_plan') { pushMsg('assistant', doAddPlan(args)); }
  else if (fn.name === 'delete_plan') { doDeletePlan(args); }
  else if (fn.name === 'edit_plan') { doEditPlan(args); }
  else if (fn.name === 'query_plans') { pushMsg('assistant', doQueryPlans(args)); }
}

async function sendToAgent(text) {
  const t = (text || '').trim();
  if (!t || chatBusy) return;
  if (!dsKey) { openDsSettings(); return; }
  chatBusy = true;
  pushMsg('user', t);
  renderChat();
  try {
    // 带上最近 20 条对话,否则模型只看得到当前这一句(之前"上次说的话不记得")
    const history = chatHistory
      .filter(m => (m.role === 'user' || m.role === 'assistant') && m.text)
      .slice(-20)
      .map(m => ({ role: m.role, content: m.text }));
    const messages = [{ role: 'system', content: systemPrompt() }].concat(history);
    const data = await callDeepSeek(messages, DS_TOOLS);
    const msg = data.choices && data.choices[0] && data.choices[0].message;
    if (!msg) { pushMsg('assistant', '没听懂,再说一遍?'); return; }
    if (msg.content) pushMsg('assistant', msg.content);
    if (msg.tool_calls && msg.tool_calls.length) {
      for (const tc of msg.tool_calls) await handleToolCall(tc);
    } else if (!msg.content) {
      pushMsg('assistant', '…');
    }
  } catch (e) {
    pushMsg('assistant', '出错了:' + (e.message || e) + '。检查密钥/网络后重试。');
  } finally {
    chatBusy = false;
    renderChat();
    openChat();
  }
}

function confirmPending() {
  if (!pendingAction) return;
  if (pendingAction.type === 'delete') {
    const ids = new Set(pendingAction.planIds);
    plans = plans.filter(p => !ids.has(p.id));
    ids.forEach(id => delete progress[id]);
    commit(); render(); runReminderEngine();
    pushMsg('assistant', '🗑️ 已删除「' + pendingAction.label + '」');
  } else if (pendingAction.type === 'edit') {
    const plan = plans.find(p => p.id === pendingAction.planId);
    if (plan) {
      const ch = pendingAction.changes;
      if (ch.period) {
        if (ch.period === 'once') plan.onceType = plan.onceType || 'deadline';
        else { plan.onceType = null; plan.due = null; }
      }
      Object.assign(plan, ch);
      reconcile(plan);
      commit(); render(); runReminderEngine();
      pushMsg('assistant', '✏️ 已改好「' + plan.title + '」');
    } else {
      pushMsg('assistant', '这个任务已经不存在了');
    }
  }
  pendingAction = null;
  renderChat();
}
function cancelPending() { pendingAction = null; renderChat(); }

function renderChat() {
  const el = document.getElementById('chat-msgs');
  if (!el) return;
  let html = '';
  if (!chatHistory.length && !pendingAction) {
    html = '<div class="chat-empty">还没有对话。<br>试试问我「今天还有什么没做完」</div>';
  }
  for (const m of chatHistory) html += '<div class="msg ' + m.role + '">' + esc(m.text) + '</div>';
  if (pendingAction) {
    const del = pendingAction.type === 'delete';
    html += '<div class="confirm-card"><div class="cc-title">' + (del ? '删除「' + esc(pendingAction.label) + '」?' : '修改「' + esc(pendingAction.label) + '」?') + '</div>'
      + (del ? '<div class="cc-desc">删除后不能恢复,确定吗?</div>' : '<div class="cc-desc">' + esc(pendingAction.summary || '') + '</div>')
      + '<div class="cc-actions"><button class="btn primary mini" data-action="cc-ok">确认</button><button class="btn ghost mini" data-action="cc-cancel">取消</button></div></div>';
  }
  el.innerHTML = html;
  el.scrollTop = el.scrollHeight;
}
function openChat() {
  document.getElementById('chat-overlay').hidden = false;
  document.querySelector('.app').classList.add('chat-open');
  renderChat();
}
function closeChat() {
  document.getElementById('chat-overlay').hidden = true;
  document.querySelector('.app').classList.remove('chat-open');
}

// 面板高度:可上下拖动,记住上次的位置
const CHAT_H_KEY = 'jql_chat_h';
function applyChatHeight(h) {
  const vh = window.innerHeight || 600;
  h = Math.max(vh * 0.2, Math.min(vh * 0.85, h));
  document.documentElement.style.setProperty('--chat-h', h + 'px');
  return h;
}
(function initChatHeight() {
  const saved = parseInt(localStorage.getItem(CHAT_H_KEY) || '', 10);
  if (saved) applyChatHeight(saved);
})();

// ---------- 语音输入(讯飞「语音听写」iat)----------
// 密钥只存在本机 localStorage,不写进源码(GitHub Pages 上源码是公开的)。
// 流程:麦克风 → 16kHz 单声道 PCM → 每 40ms(1280 字节)一帧 base64 推进 WebSocket。
const LS_XF = 'jql_xfyun_v1';
const XF_HOST = 'iat-api.xfyun.cn';
const XF_PATH = '/v2/iat';
const XF_FRAME = 640;            // 640 个 Int16 = 1280 字节 = 40ms @ 16kHz
const XF_MIN_SAMPLES = 3200;     // 少于 0.2 秒就当作误触

let xfCfg = (() => { try { return JSON.parse(localStorage.getItem(LS_XF)) || {}; } catch (e) { return {}; } })();
function xfReady() { return !!(xfCfg.appid && xfCfg.apikey && xfCfg.apisecret); }

function bufToB64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

// 讯飞鉴权:signature_origin = "host: ...\ndate: ...\nGET /v2/iat HTTP/1.1"
// signature = base64(HMAC-SHA256(签名原文, APISecret)),date 偏差不能超过 300 秒。
async function xfAuthUrl() {
  if (!window.crypto || !crypto.subtle) throw new Error('需要 https 打开才能录音');
  const date = new Date().toUTCString();
  const origin = 'host: ' + XF_HOST + '\ndate: ' + date + '\nGET ' + XF_PATH + ' HTTP/1.1';
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(xfCfg.apisecret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(origin));
  const authOrigin = 'api_key="' + xfCfg.apikey + '",algorithm="hmac-sha256",headers="host date request-line",signature="' + bufToB64(sig) + '"';
  const auth = btoa(authOrigin);
  return 'wss://' + XF_HOST + XF_PATH
    + '?authorization=' + encodeURIComponent(auth)
    + '&date=' + encodeURIComponent(date)
    + '&host=' + encodeURIComponent(XF_HOST);
}

function toInt16(arr) {
  const out = new Int16Array(arr.length);
  for (let i = 0; i < arr.length; i++) {
    const s = Math.max(-1, Math.min(1, arr[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
  }
  return out;
}

// 有些浏览器锁死 48kHz,这里线性插值降到 16kHz(否则讯飞听起来是慢放)。
function resampleTo16k(f, from) {
  if (from === 16000) return f;
  const ratio = from / 16000;
  const n = Math.floor(f.length / ratio);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const p = i * ratio, i0 = Math.floor(p), i1 = Math.min(i0 + 1, f.length - 1), t = p - i0;
    out[i] = f[i0] * (1 - t) + f[i1] * t;
  }
  return out;
}

// 建立一次识别会话。返回 { stop, abort }
async function createIat(onText, onDone, onError, preCtx) {
  const url = await xfAuthUrl();
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const AC = window.AudioContext || window.webkitAudioContext;
  let ctx = preCtx || null;
  if (!ctx) {
    try { ctx = new AC({ sampleRate: 16000 }); } catch (e) { ctx = new AC(); }
  }
  if (ctx.state === 'suspended') { try { await ctx.resume(); } catch (e) {} }

  const inRate = ctx.sampleRate || 48000;
  const src = ctx.createMediaStreamSource(stream);
  const proc = ctx.createScriptProcessor(2048, 1, 1);
  src.connect(proc);
  proc.connect(ctx.destination);   // 不接 destination 回调不跑(输出是静音)

  let ws = null, wsOpen = false, stopping = false, finished = false, firstSent = false;
  let pending = [];                // 还没凑够一帧的采样
  const queue = [];                // 待发送的 base64 音频帧
  const results = {};              // sn → 文字片段
  let lastText = '';
  let totalSamples = 0;
  let tick = null, closeTimer = null;

  function render() {
    const keys = Object.keys(results).map(Number).sort((a, b) => a - b);
    const t = keys.map(k => results[k]).join('');
    if (t !== lastText) { lastText = t; onText(t); }
  }

  function sendFrame(audio, status) {
    if (!ws || ws.readyState !== 1) return;
    const payload = { data: { status: status, format: 'audio/L16;rate=16000', encoding: 'raw', audio: audio } };
    if (!firstSent) {
      firstSent = true;
      payload.common = { app_id: xfCfg.appid };
      payload.business = { language: 'zh_cn', domain: 'iat', accent: 'mandarin', vad_eos: 10000, ptt: 1 };
    }
    ws.send(JSON.stringify(payload));
  }

  // 每 40ms 发一帧;落后了就一次多发几帧追回来,收尾时补 status:2 结束帧
  function drain() {
    if (!wsOpen) return;
    const cap = queue.length > 6 ? 6 : 1;
    for (let n = 0; n < cap && queue.length; n++) {
      sendFrame(queue.shift(), firstSent ? 1 : 0);
    }
    if (!queue.length && stopping) { stopping = false; sendFrame('', 2); }
  }

  proc.onaudioprocess = (e) => {
    if (stopping || finished) return;
    const f = resampleTo16k(e.inputBuffer.getChannelData(0), inRate);
    totalSamples += f.length;
    for (let i = 0; i < f.length; i++) pending.push(f[i]);
    while (pending.length >= XF_FRAME) {
      queue.push(bufToB64(toInt16(pending.splice(0, XF_FRAME)).buffer));
    }
  };

  function teardownMic() {
    try { proc.onaudioprocess = null; } catch (e) {}
    try { src.disconnect(); } catch (e) {}
    try { proc.disconnect(); } catch (e) {}
    try { stream.getTracks().forEach(t => t.stop()); } catch (e) {}
    try { ctx.close(); } catch (e) {}
  }

  function cleanup() {
    if (tick) { clearInterval(tick); tick = null; }
    if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; }
    teardownMic();
    try { if (ws && ws.readyState <= 1) ws.close(); } catch (e) {}
    ws = null;
  }

  function finishOk() {
    if (finished) return;
    finished = true;
    cleanup();
    onDone(lastText || '');
  }

  function fail(msg) {
    if (finished) return;
    finished = true;
    cleanup();
    onError(new Error(msg || '识别失败'));
  }

  ws = new WebSocket(url);
  ws.onopen = () => { wsOpen = true; tick = setInterval(drain, 40); };
  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch (e) { return; }
    if (msg.code !== 0) { fail(msg.message || ('讯飞错误码 ' + msg.code)); return; }
    const d = msg.data || {};
    if (d.result && d.result.ws) {
      let piece = '';
      for (const alt of d.result.ws) for (const cw of (alt.cw || [])) piece += cw.w;
      if (d.result.sn) results[d.result.sn] = piece;
      render();
    }
    if (d.status === 2) finishOk();
  };
  ws.onerror = () => fail('网络连接失败');
  ws.onclose = () => { if (!finished) fail('连接被关闭'); };

  return {
    stop() {
      if (finished || stopping) return;
      if (totalSamples < XF_MIN_SAMPLES) { fail('说得太短了,按住多说两句'); return; }
      teardownMic();
      if (pending.length) {          // 剩余不足一帧的采样补零后发出去
        while (pending.length < XF_FRAME) pending.push(0);
        queue.push(bufToB64(toInt16(pending.slice(0, XF_FRAME)).buffer));
        pending = [];
      }
      stopping = true;
      drain();
      closeTimer = setTimeout(() => finishOk(), 5000);   // 兜底:5 秒还没结束就别等了
    },
    abort() { fail('已取消'); }
  };
}

let voiceCtl = null;
let voiceStarting = false;
let voiceReleaseEarly = false;

async function startVoiceHold(inputId, btn) {
  if (voiceCtl || voiceStarting) return;
  if (!xfReady()) { openDsSettings(); return; }
  voiceStarting = true;
  voiceReleaseEarly = false;
  const inp = document.getElementById(inputId);
  const oldPh = inp ? inp.placeholder : null;
  btn.classList.add('recording');
  if (inp) inp.placeholder = '松开结束…';
  // iOS 要求 AudioContext 在用户手势里同步创建,所以放在任何 await 之前
  let preCtx = null;
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    preCtx = new AC({ sampleRate: 16000 });
    if (preCtx.state === 'suspended') { const p = preCtx.resume(); if (p && p.catch) p.catch(() => {}); }
  } catch (e) { preCtx = null; }
  try {
    voiceCtl = await createIat(
      (t) => { if (inp) inp.value = t; },
      (t) => {
        btn.classList.remove('recording');
        if (inp) inp.placeholder = oldPh;
        voiceCtl = null;
        if (inp) inp.value = t;
        if (t) sendFromInput(inp);
      },
      (e) => {
        btn.classList.remove('recording');
        if (inp) inp.placeholder = oldPh;
        voiceCtl = null;
        alertBox('语音识别失败:' + ((e && e.message) || '请重试') + '\n(打字照样能用)');
      },
      preCtx
    );
    voiceStarting = false;
    if (voiceReleaseEarly) { voiceReleaseEarly = false; voiceCtl.stop(); }
  } catch (e) {
    voiceStarting = false;
    btn.classList.remove('recording');
    if (inp) inp.placeholder = oldPh;
    try { if (preCtx) preCtx.close(); } catch (e2) {}
    alertBox('录音启动失败:' + ((e && e.message) || '请检查麦克风权限'));
  }
}

function stopVoiceHold() {
  if (voiceCtl) voiceCtl.stop();
  else if (voiceStarting) voiceReleaseEarly = true;
}

function bindMic(btnId, inputId) {
  const btn = document.getElementById(btnId);
  if (!btn) return;
  btn.addEventListener('pointerdown', (e) => { e.preventDefault(); startVoiceHold(inputId, btn); });
  btn.addEventListener('pointerup', (e) => { e.preventDefault(); stopVoiceHold(); });
  btn.addEventListener('pointercancel', stopVoiceHold);
  btn.addEventListener('pointerleave', stopVoiceHold);
  btn.addEventListener('contextmenu', (e) => e.preventDefault());
}

function openDsSettings() {
  const body = document.getElementById('ds-body');
  let html = '';
  if (dsKey) {
    html += '<p class="sync-desc">✅ DeepSeek 密钥已设置,鲸灵助手可以直接用了。</p>'
      + '<div class="sheet-actions"><button class="btn ghost" id="ds-clear">清除 DeepSeek 密钥</button></div>';
  } else {
    html += '<p class="sync-desc">填一个 DeepSeek 密钥,鲸灵助手就能听你指挥。<br>去 platform.deepseek.com 注册 → API Keys → 创建,复制 sk-... 到这里(只存本机浏览器)。</p>'
      + '<label class="field"><span>DeepSeek 密钥</span><input id="ds-key-input" type="text" placeholder="sk-..." autocomplete="off"/></label>'
      + '<div class="sheet-actions"><button class="btn primary" id="ds-save">保存 DeepSeek 密钥</button></div>';
  }
  html += '<hr class="setting-split"/>';
  if (xfReady()) {
    html += '<p class="sync-desc">✅ 讯飞语音已配置,按住 🎤 说话,松开发送。</p>'
      + '<div class="sheet-actions"><button class="btn ghost" id="xf-clear">清除语音配置</button></div>';
  } else {
    html += '<p class="sync-desc">语音输入用讯飞的「语音听写」(每天免费 500 次)。<br>去 console.xfyun.cn → 我的应用 → 计划鲸灵 → 复制三个值填下面(只存本机浏览器)。</p>'
      + '<label class="field"><span>APPID</span><input id="xf-appid" type="text" placeholder="例如 5bc4bfeb" autocomplete="off"/></label>'
      + '<label class="field"><span>APIKey</span><input id="xf-apikey" type="text" autocomplete="off"/></label>'
      + '<label class="field"><span>APISecret</span><input id="xf-apisecret" type="text" autocomplete="off"/></label>'
      + '<div class="sheet-actions"><button class="btn primary" id="xf-save">保存语音配置</button></div>';
  }
  body.innerHTML = html;

  const dsClear = document.getElementById('ds-clear');
  if (dsClear) dsClear.onclick = () => { dsKey = null; localStorage.removeItem(LS_DS_KEY); openDsSettings(); };
  const dsSave = document.getElementById('ds-save');
  if (dsSave) dsSave.onclick = () => {
    const v = document.getElementById('ds-key-input').value.trim();
    if (!v) { alertBox('请粘贴密钥'); return; }
    dsKey = v; localStorage.setItem(LS_DS_KEY, v); openDsSettings(); alertBox('已保存,可以开始用了');
  };
  const xfClear = document.getElementById('xf-clear');
  if (xfClear) xfClear.onclick = () => {
    xfCfg = {}; localStorage.removeItem(LS_XF); openDsSettings();
  };
  const xfSave = document.getElementById('xf-save');
  if (xfSave) xfSave.onclick = () => {
    const appid = document.getElementById('xf-appid').value.trim();
    const apikey = document.getElementById('xf-apikey').value.trim();
    const apisecret = document.getElementById('xf-apisecret').value.trim();
    if (!appid || !apikey || !apisecret) { alertBox('三个值都要填'); return; }
    xfCfg = { appid: appid, apikey: apikey, apisecret: apisecret };
    localStorage.setItem(LS_XF, JSON.stringify(xfCfg));
    openDsSettings();
    alertBox('语音配置已保存,按住 🎤 试试');
  };

  document.getElementById('ds-overlay').hidden = false;
}

function sendFromInput(inputEl) {
  const v = inputEl.value.trim();
  if (!v) return;
  if (!dsKey) { openDsSettings(); return; }
  inputEl.value = '';
  sendToAgent(v);
}

// 事件绑定
document.getElementById('assist-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); sendFromInput(e.target); } });
document.getElementById('assist-send').addEventListener('click', () => sendFromInput(document.getElementById('assist-input')));
bindMic('assist-mic', 'assist-input');
document.getElementById('chat-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); sendFromInput(e.target); } });
document.getElementById('chat-send').addEventListener('click', () => sendFromInput(document.getElementById('chat-input')));
bindMic('chat-mic', 'chat-input');
document.getElementById('chat-close').addEventListener('click', closeChat);
document.getElementById('chat-overlay').addEventListener('click', (e) => { if (e.target === document.getElementById('chat-overlay')) closeChat(); });
document.getElementById('chat-clear').addEventListener('click', async () => {
  if (!chatHistory.length) { alertBox('还没有聊天记录'); return; }
  const ok = await showDialog('清空全部聊天记录？清空后不能恢复。', { okText: '清空' });
  if (!ok) return;
  chatHistory = [];
  saveChat();
  renderChat();
});

// 拖动面板顶部的小横条调整高度
(function bindChatDrag() {
  const grip = document.getElementById('chat-grip');
  const sheet = document.getElementById('chat-sheet');
  if (!grip || !sheet) return;
  let start = null;
  grip.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    try { grip.setPointerCapture(e.pointerId); } catch (err) {}
    start = { y: e.clientY, h: sheet.getBoundingClientRect().height };
  });
  grip.addEventListener('pointermove', (e) => {
    if (!start) return;
    e.preventDefault();
    applyChatHeight(start.h + (start.y - e.clientY));
  });
  const end = () => {
    if (!start) return;
    start = null;
    try {
      localStorage.setItem(CHAT_H_KEY, String(Math.round(sheet.getBoundingClientRect().height)));
    } catch (e) {}
  };
  grip.addEventListener('pointerup', end);
  grip.addEventListener('pointercancel', end);
})();
document.getElementById('chat-msgs').addEventListener('click', (e) => {
  const b = e.target.closest('[data-action]'); if (!b) return;
  if (b.dataset.action === 'cc-ok') confirmPending();
  else if (b.dataset.action === 'cc-cancel') cancelPending();
});
document.getElementById('menu-ds').addEventListener('click', () => { document.getElementById('whale-overlay').hidden = true; openDsSettings(); });
document.getElementById('menu-chat').addEventListener('click', () => { document.getElementById('whale-overlay').hidden = true; openChat(); });
document.getElementById('ds-close').addEventListener('click', () => { document.getElementById('ds-overlay').hidden = true; });
document.getElementById('ds-overlay').addEventListener('click', (e) => { if (e.target === document.getElementById('ds-overlay')) document.getElementById('ds-overlay').hidden = true; });

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
  const inFull = activeTab === 'calendar' || activeTab === 'sort';
  const set = (el) => { if (el) el.style.display = inFull ? 'none' : ''; };
  set(document.getElementById('tabbar'));
  set(document.getElementById('cat-chips'));
  set(document.getElementById('assist-bar'));
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

  if (activeTab === 'memo') {
    const list = plans.filter(p => p.period === 'once' && p.onceType === 'event' && catOk(p) && active(p));
    html = list.length ? sectionHTML('📌 备忘录(当天事件)', list) : emptyHTML('📌', '没有当天事件');
  } else if (activeTab === 'today') {
    const daily = plans.filter(p => p.period === 'daily' && catOk(p) && active(p));
    const once = plans.filter(p => p.period === 'once' && p.onceType !== 'event' && catOk(p) && active(p));
    if (!daily.length && !once.length) { el.innerHTML = emptyHTML('🐳', '今天没有要做的,真棒'); return; }
    const miss = missSummary();
    if (miss.count > 0) {
      const txt = miss.maxCon === 1 ? '昨天没打卡' : `已连续 ${miss.maxCon} 天没打卡`;
      html += `<div class="card miss-banner" data-action="miss"><span>⚠️</span><div>${txt}<small>点我补卡</small></div></div>`;
    }
    if (daily.length) html += sectionHTML('🌤️ 每天打卡', daily);
    if (once.length) html += sectionHTML('⏰ 待办 / 截止', once);
  } else if (activeTab === 'week') {
    const list = plans.filter(p => p.period === 'weekly' && catOk(p) && active(p));
    html = list.length ? sectionHTML('🗓️ 本周目标', list) : emptyHTML('🗓️', '本周没有目标');
  } else if (activeTab === 'month') {
    const list = plans.filter(p => p.period === 'monthly' && catOk(p) && active(p));
    html = list.length ? sectionHTML('📆 本月目标', list) : emptyHTML('📆', '本月没有目标');
  } else if (activeTab === 'calendar') {
    html = renderCalendar();
  } else if (activeTab === 'sort') {
    html = renderSortView();
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

function calHTML(mode) {
  const today = dateStr(new Date());
  const y = calYear, m = calMonth;
  const wd = '日一二三四五六';
  const sd = new Date(calSel + 'T00:00:00');
  const selLabel = `${sd.getMonth() + 1}月${sd.getDate()}日 周${wd[sd.getDay()]}`;
  let html = `<div class="cal-head"><button class="cal-nav" data-action="cal-prev">‹</button><span>${y}年${m + 1}月</span><button class="cal-nav" data-action="cal-next">›</button></div>`;
  html += `<div class="cal-week">${['日', '一', '二', '三', '四', '五', '六'].map(w => `<span>${w}</span>`).join('')}</div>`;
  const firstDow = new Date(y, m, 1).getDay();
  const daysInMonth = new Date(y, m + 1, 0).getDate();
  html += `<div class="cal-grid">`;
  for (let i = 0; i < firstDow; i++) html += `<div class="cal-day empty"></div>`;
  for (let d = 1; d <= daysInMonth; d++) {
    const ds = `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const types = mode === 'active' ? [...dotTypesOnDay(ds)] : mode === 'done' ? [...completedTypesOnDay(ds)] : [...allTypesOnDay(ds)];
    const dots = types.length ? `<div class="cal-dots">${types.map(t => `<i class="dot ${t}"></i>`).join('')}</div>` : '';
    html += `<div class="cal-day ${ds === today ? 'today' : ''} ${ds === calSel ? 'sel' : ''}" data-action="cal-day" data-date="${ds}">${d}${dots}</div>`;
  }
  html += `</div>`;
  const selTasks = mode === 'active' ? tasksOnDay(calSel) : mode === 'done' ? completedTasksOnDay(calSel) : allTasksOnDay(calSel);
  html += `<div class="cal-detail"><div class="cal-detail-title">${selLabel}</div>`;
  html += selTasks.length ? selTasks.map(cardHTML).join('') : `<div class="empty">这天没有任务</div>`;
  html += `</div>`;
  return html;
}
function renderCalendar() {
  let html = `<div class="done-head"><button class="back-btn" data-action="back">← 返回</button><span>日历</span></div>`;
  html += `<div class="seg cal-mode">
    <button data-action="cal-mode" data-mode="active" class="${calMode === 'active' ? 'active' : ''}">未完成</button>
    <button data-action="cal-mode" data-mode="done" class="${calMode === 'done' ? 'active' : ''}">已完成</button>
    <button data-action="cal-mode" data-mode="all" class="${calMode === 'all' ? 'active' : ''}">全部</button>
  </div>`;
  html += calHTML(calMode);
  if (calMode === 'done') {
    const catOk = p => activeCat === '全部' || p.category === activeCat;
    const groups = [
      ['每天', plans.filter(p => p.period === 'daily' && catOk(p) && isFullyDone(p))],
      ['单次', plans.filter(p => p.period === 'once' && catOk(p) && isFullyDone(p))],
      ['每周', plans.filter(p => p.period === 'weekly' && catOk(p) && isFullyDone(p))],
      ['每月', plans.filter(p => p.period === 'monthly' && catOk(p) && isFullyDone(p))],
    ];
    html += `<div class="section-title" style="margin-top:16px">✅ 全部已完成</div>`;
    html += groups.some(g => g[1].length)
      ? groups.map(([t, list]) => list.length ? `<div class="section-title">✅ ${t}</div>` + list.map(doneCardHTML).join('') : '').join('')
      : `<div class="empty">还没有彻底完成的任务</div>`;
  }
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
  const expanded = expandedIds.has(plan.id);
  const color = CAT_COLORS[plan.category] || CAT_COLORS['其他'];
  const imp = plan.importance || 5;
  const impColor = imp >= 8 ? '#FF5D7A' : (imp >= 5 ? '#FF9A3D' : '#A0A8C0');
  const editDel = expanded ? `<button class="icon-btn" data-action="edit" data-id="${plan.id}">✏️</button><button class="icon-btn" data-action="del" data-id="${plan.id}">🗑️</button>` : '';
  let html = `<div class="card${expanded ? ' expanded' : ''}" data-id="${plan.id}">
    <div class="card-top" data-action="toggle" data-id="${plan.id}">
      <span class="tag" style="background:${color}">${esc(plan.category)}</span>
      <div class="card-title ${fullyDone ? 'done' : ''}">${esc(plan.title)}</div>
      ${checked && !fullyDone ? '<span class="tag" style="background:#4ED4A8">✓ 已打卡</span>' : ''}
      <span class="imp" style="color:${impColor}">★${imp}</span>
      <span class="badge">${PERIOD_LABEL[plan.period]}</span>
      <span class="chev">${expanded ? '▴' : '▾'}</span>
    </div>`;

  if (expanded) {
    if (plan.period === 'once' && plan.due) {
      const cd = countdownText(plan);
      const ic = plan.onceType === 'event' ? '📌' : '⏰';
      html += `<p class="card-note">${ic} ${cd}（${esc(plan.due)}）</p>`;
    }
    if (plan.endDate) html += `<p class="card-note">📅 截止 ${esc(plan.endDate)}</p>`;
    if (plan.period === 'weekly') html += `<p class="card-note">🗓️ 本周剩余 ${periodRemain(plan)} 天</p>`;
    if (plan.period === 'monthly') html += `<p class="card-note">📆 本月剩余 ${periodRemain(plan)} 天</p>`;
    if (plan.note) html += `<p class="card-note">${esc(plan.note)}</p>`;

    if (plan.subtasks.length) {
      html += `<div class="subs">`;
      plan.subtasks.forEach((s, i) => {
        const on = !!(st && st.checked[i]);
        html += `<div class="sub"><input type="checkbox" data-action="sub" data-id="${plan.id}" data-i="${i}" ${on ? 'checked' : ''}/><label class="${on ? 'on' : ''}">${esc(s.text)}</label></div>`;
      });
      html += `</div>`;
    }
  }

  if (plan.period === 'daily' && !plan.subtasks.length) {
    const doneToday = !!(st && st.doneAt);
    html += `<div class="card-foot">
      <button class="btn ${doneToday ? 'ghost' : 'primary'} mini" data-action="check" data-id="${plan.id}">${doneToday ? '✓ 已打卡' : '打卡'}</button>
      <span class="streak">🔥 ${streakOf(plan)} 天</span>
      <span style="flex:1"></span>
      ${editDel}
    </div>`;
  } else {
    // 收起时不需要进度条,只在右下角留一个百分比,省一整行高度
    if (expanded) {
      html += `<div class="progress-row"><div class="bar"><i style="width:${pct}%"></i></div><input class="pct" type="number" min="0" max="100" value="${pct}" data-action="pct" data-id="${plan.id}"/></div>`;
      html += `<div class="slider-row"><input type="range" min="0" max="100" step="1" value="${pct}" data-action="slide" data-id="${plan.id}"/></div>`;
    }
    html += `<div class="card-foot">
      <button class="btn ${checked ? 'ghost' : 'primary'} mini" data-action="done" data-id="${plan.id}">${checked ? '↩ 取消完成' : '完成'}</button>
      ${plan.period === 'daily' ? `<span class="streak">🔥 ${streakOf(plan)} 天</span>` : ''}
      <span style="flex:1"></span>
      ${expanded ? editDel : `<span class="pct-static">${pct}%</span>`}
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
  if (action === 'back') { if (fullScreenTab) history.back(); return; }
  if (action === 'cal-mode') { calMode = b.dataset.mode; render(); return; }
  if (action === 'miss') { openMiss(); return; }
  if (action === 'cal-prev') { calMonth--; if (calMonth < 0) { calMonth = 11; calYear--; } render(); return; }
  if (action === 'cal-next') { calMonth++; if (calMonth > 11) { calMonth = 0; calYear++; } render(); return; }
  if (action === 'cal-day') { calSel = b.dataset.date; render(); return; }
  if (action === 'toggle') {
    const id = b.dataset.id;
    if (expandedIds.has(id)) expandedIds.delete(id); else expandedIds.add(id);
    renderContent();
    return;
  }
  const id = b.dataset.id;
  const plan = plans.find(p => p.id === id); if (!plan) return;

  if (action === 'check') {
    const st = curState(plan);
    if (st.doneAt) { st.doneAt = null; st.manual = null; }
    else { st.doneAt = new Date().toISOString(); st.manual = null; }
    commit(); renderContent();
  } else if (action === 'done') {
    const st = curState(plan);
    const done = shown(plan, st) >= 100;
    if (plan.subtasks.length) {
      // 有子任务:完成=全部打勾,取消完成=全部取消勾(百分比归0)
      plan.subtasks.forEach((s, i) => { st.checked[i] = !done; });
      st.manual = null;
    } else {
      st.manual = done ? 0 : 100;
    }
    commit(); renderContent();
  } else if (action === 'edit' || action === 'del') {
    handlePlanAction(action, id);
  }
});

// ---------- 底部导航 / 分类 ----------
document.getElementById('tabbar').addEventListener('click', (e) => {
  const t = e.target.closest('.tab'); if (!t) return;
  if (t.id === 'sort-btn') { openSort(); return; }
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
  document.getElementById('f-remind').value = (plan && plan.remindTime) ? plan.remindTime : '';
  document.getElementById('f-start').value = (plan && plan.startDate) ? plan.startDate : '';
  document.getElementById('f-end').value = (plan && plan.endDate) ? plan.endDate : '';
  draftCat = plan ? plan.category : '学习';
  draftPeriod = plan ? plan.period : 'daily';
  draftOnceType = plan ? (plan.onceType || 'deadline') : 'deadline';
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
  document.getElementById('f-oncetype-wrap').hidden = draftPeriod !== 'once';
  document.querySelectorAll('#f-oncetype button').forEach(b => b.classList.toggle('active', b.dataset.oncetype === draftOnceType));
  document.getElementById('f-due-label').textContent = draftOnceType === 'event' ? '日期' : '截止日期';
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
document.getElementById('f-oncetype').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  draftOnceType = b.dataset.oncetype; renderPeriodSeg();
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
  const onceType = (draftPeriod === 'once') ? draftOnceType : null;
  const importance = Math.max(1, Math.min(10, +document.getElementById('f-imp').value || 5));
  const startDate = (draftPeriod !== 'once') ? (document.getElementById('f-start').value || null) : null;
  const endDate = (draftPeriod !== 'once') ? (document.getElementById('f-end').value || null) : null;
  const subtasks = draftSubs.map(t => ({ id: uid(), text: t })).filter(s => s.text.trim());
  const remindTime = document.getElementById('f-remind').value || null;

  if (editingId) {
    const plan = plans.find(p => p.id === editingId);
    Object.assign(plan, { title, category: draftCat, period: draftPeriod, onceType, note, due, importance, startDate, endDate, subtasks, remindTime });
    reconcile(plan);
  } else {
    plans.push({ id: uid(), title, category: draftCat, period: draftPeriod, onceType, note, due, importance, startDate, endDate, subtasks, remindTime, createdAt: Date.now() });
  }
  commit(); render(); closeSheet();
  runReminderEngine();
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
document.getElementById('menu-cal').addEventListener('click', () => {
  document.getElementById('whale-overlay').hidden = true;
  calYear = new Date().getFullYear();
  calMonth = new Date().getMonth();
  calSel = dateStr(new Date());
  enterFull('calendar');
});
document.getElementById('menu-remind').addEventListener('click', () => {
  document.getElementById('whale-overlay').hidden = true;
  openRemind();
});
document.getElementById('remind-close').addEventListener('click', () => { document.getElementById('remind-overlay').hidden = true; });
document.getElementById('remind-overlay').addEventListener('click', (e) => {
  if (e.target === document.getElementById('remind-overlay')) document.getElementById('remind-overlay').hidden = true;
});

function enterFull(tab) {
  prevTab = activeTab;
  fullScreenTab = tab;
  activeTab = tab;
  history.pushState({ full: true }, '');
  render();
}
window.addEventListener('popstate', () => {
  if (fullScreenTab) {
    fullScreenTab = null;
    activeTab = prevTab;
    render();
  }
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
        runReminderEngine();
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

function openSort() { renderSortPanel(); document.getElementById('sort-overlay').hidden = false; }
function renderSortPanel() {
  const el = document.getElementById('sort-body');
  el.innerHTML = `
    <div class="field"><span>参与排序的任务</span>
      <label class="miss-day"><input type="checkbox" data-sg="event" ${sortGroups.event ? 'checked' : ''}/> 当天事件(备忘录)</label>
      <label class="miss-day"><input type="checkbox" data-sg="deadline" ${sortGroups.deadline ? 'checked' : ''}/> 截止任务</label>
      <label class="miss-day"><input type="checkbox" data-sg="weekly" ${sortGroups.weekly ? 'checked' : ''}/> 每周</label>
      <label class="miss-day"><input type="checkbox" data-sg="monthly" ${sortGroups.monthly ? 'checked' : ''}/> 每月</label>
    </div>
    <div class="field"><span>排序方式</span>
      <div class="seg" id="sort-method">
        <button data-method="importance" class="${sortMethod === 'importance' ? 'active' : ''}">按重要性</button>
        <button data-method="deadline" class="${sortMethod === 'deadline' ? 'active' : ''}">按截止日期</button>
      </div>
    </div>`;
}
document.getElementById('sort-close').addEventListener('click', () => { document.getElementById('sort-overlay').hidden = true; });
document.getElementById('sort-overlay').addEventListener('click', (e) => { if (e.target === document.getElementById('sort-overlay')) document.getElementById('sort-overlay').hidden = true; });
document.getElementById('sort-toggle-all').addEventListener('click', () => {
  const all = Object.values(sortGroups).every(Boolean);
  sortGroups = { event: !all, deadline: !all, weekly: !all, monthly: !all };
  renderSortPanel();
});
document.getElementById('sort-body').addEventListener('change', (e) => {
  const c = e.target.closest('[data-sg]'); if (!c) return;
  sortGroups[c.dataset.sg] = c.checked;
});
document.getElementById('sort-body').addEventListener('click', (e) => {
  const b = e.target.closest('#sort-method button'); if (!b) return;
  sortMethod = b.dataset.method;
  renderSortPanel();
});
document.getElementById('sort-apply').addEventListener('click', () => {
  document.getElementById('sort-overlay').hidden = true;
  enterFull('sort');
});

function deadlineKey(plan) {
  if (plan.period === 'once') return plan.due || '9999-12-31';
  if (plan.period === 'weekly') {
    const d = new Date();
    d.setDate(d.getDate() + ((7 - d.getDay()) % 7));
    return dateStr(d);
  }
  if (plan.period === 'monthly') {
    const d = new Date();
    return dateStr(new Date(d.getFullYear(), d.getMonth() + 1, 0));
  }
  return '9999-12-31';
}
function sortPlans() {
  const catOk = p => activeCat === '全部' || p.category === activeCat;
  const list = [];
  if (sortGroups.event) list.push(...plans.filter(p => p.period === 'once' && p.onceType === 'event' && !isFullyDone(p) && catOk(p)));
  if (sortGroups.deadline) list.push(...plans.filter(p => p.period === 'once' && p.onceType !== 'event' && !isFullyDone(p) && catOk(p)));
  if (sortGroups.weekly) list.push(...plans.filter(p => p.period === 'weekly' && !isFullyDone(p) && catOk(p)));
  if (sortGroups.monthly) list.push(...plans.filter(p => p.period === 'monthly' && !isFullyDone(p) && catOk(p)));
  if (sortMethod === 'importance') {
    list.sort((a, b) => (b.importance || 5) - (a.importance || 5));
  } else {
    list.sort((a, b) => deadlineKey(a).localeCompare(deadlineKey(b)));
  }
  return list;
}
function renderSortView() {
  const list = sortPlans();
  let html = `<div class="done-head"><button class="back-btn" data-action="back">← 返回</button><span>排序结果</span></div>`;
  html += `<div class="sort-desc">${sortMethod === 'importance' ? '按重要性从高到低' : '按截止日期从近到远'}</div>`;
  html += list.length ? list.map(cardHTML).join('') : `<div class="empty">没有符合条件的任务</div>`;
  return html;
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
runReminderEngine();
