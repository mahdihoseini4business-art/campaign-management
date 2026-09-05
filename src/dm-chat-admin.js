// ============================================
// Chat oversight (main admin settings pane)
// ============================================

import { supabase } from './supabase.js'
import { getUsersSafe } from './auth.js'
import {
  escapeHtml,
  escapeAttr,
  requireMainAdmin,
  userDisplayName,
  normalizePhone,
  getTodayJalaliStr,
  jalaliAddDays,
  toGregorian,
  toEnDigits,
  showToast
} from './utils.js'

let ChartLib = null
/** @type {Record<string, any>} */
const charts = {}
/** @type {'dashboard' | 'daily' | 'archive'} */
let subTab = 'dashboard'
/** @type {'today' | '7' | '30' | 'custom'} */
let rangePreset = '7'
let customFrom = ''
let customTo = ''
let dailyPick = ''
/** @type {Map<string, any>} */
let usersByPhone = new Map()
/** @type {Map<number, any>} */
let convById = new Map()
/** @type {any[]} */
let timeRows = []
/** @type {any[]} */
let messageRows = []
let archiveFilter = ''
/** @type {any[]} */
let archiveConvs = []
let archiveOpenId = null
let archiveMessages = []

async function ensureChartLib() {
  if (!ChartLib) {
    const mod = await import('chart.js/auto')
    ChartLib = mod.default
  }
  return ChartLib
}

function destroyChart(key) {
  if (charts[key]) {
    try { charts[key].destroy() } catch (_) { /* ignore */ }
    delete charts[key]
  }
}

function destroyAllCharts() {
  Object.keys(charts).forEach(destroyChart)
}

function scheduleChartsResize() {
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      Object.values(charts).forEach(c => {
        try { c.resize() } catch (_) { /* ignore */ }
      })
    })
  })
}

function pad2(n) {
  return String(n).padStart(2, '0')
}

function jalaliToIsoDate(jstr) {
  const parts = toEnDigits(String(jstr || '')).split(/[/-]/).map(Number)
  if (parts.length < 3 || parts.some(n => !Number.isFinite(n))) return ''
  const g = toGregorian(parts[0], parts[1], parts[2])
  return `${g.year}-${pad2(g.month)}-${pad2(g.day)}`
}

function isoToJalaliLabel(iso) {
  if (!iso) return '—'
  try {
    const d = new Date(`${iso}T12:00:00Z`)
    return d.toLocaleDateString('fa-IR')
  } catch {
    return iso
  }
}

function formatDuration(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (h > 0) return `${h}س ${m}د`
  if (m > 0) return `${m} دقیقه`
  return `${s} ثانیه`
}

function getRangeIso() {
  const todayJ = getTodayJalaliStr()
  if (rangePreset === 'today') {
    const iso = jalaliToIsoDate(todayJ)
    return { from: iso, to: iso }
  }
  if (rangePreset === '7') {
    return { from: jalaliToIsoDate(jalaliAddDays(todayJ, -6)), to: jalaliToIsoDate(todayJ) }
  }
  if (rangePreset === '30') {
    return { from: jalaliToIsoDate(jalaliAddDays(todayJ, -29)), to: jalaliToIsoDate(todayJ) }
  }
  const from = jalaliToIsoDate(customFrom) || jalaliToIsoDate(jalaliAddDays(todayJ, -6))
  const to = jalaliToIsoDate(customTo) || jalaliToIsoDate(todayJ)
  return from <= to ? { from, to } : { from: to, to: from }
}

function daysInRange(fromIso, toIso) {
  const a = new Date(`${fromIso}T12:00:00Z`).getTime()
  const b = new Date(`${toIso}T12:00:00Z`).getTime()
  return Math.max(1, Math.round((b - a) / 86400000) + 1)
}

function eachIsoDay(fromIso, toIso) {
  const out = []
  let t = new Date(`${fromIso}T12:00:00Z`).getTime()
  const end = new Date(`${toIso}T12:00:00Z`).getTime()
  while (t <= end) {
    out.push(new Date(t).toISOString().slice(0, 10))
    t += 86400000
  }
  return out
}

function nameOf(phone) {
  const p = normalizePhone(phone)
  return userDisplayName(usersByPhone.get(p)) || p || '—'
}

function convTitle(conv) {
  if (!conv) return 'گفتگو'
  if (conv.kind === 'group') return conv.title || 'گروه'
  return `${nameOf(conv.phone_a)} ↔ ${nameOf(conv.phone_b)}`
}

async function refreshUsers() {
  const users = await getUsersSafe()
  const map = new Map()
  for (const u of users) {
    const p = normalizePhone(u.phone)
    if (p) map.set(p, u)
  }
  usersByPhone = map
}

async function loadConversationsMap() {
  const { data, error } = await supabase.from('dm_conversations').select('*')
  if (error) {
    console.error('chat admin convs:', error)
    convById = new Map()
    return
  }
  const map = new Map()
  for (const c of data || []) map.set(Number(c.id), c)
  convById = map
}

async function loadRangeData() {
  const { from, to } = getRangeIso()
  const [timeRes, msgRes] = await Promise.all([
    supabase
      .from('dm_chat_time_daily')
      .select('*')
      .gte('day', from)
      .lte('day', to),
    supabase
      .from('dm_messages')
      .select('id, conversation_id, sender_phone, created_at')
      .gte('created_at', `${from}T00:00:00.000Z`)
      .lte('created_at', `${to}T23:59:59.999Z`)
  ])
  if (timeRes.error && !/dm_chat_time_daily|does not exist|relation/i.test(timeRes.error.message || '')) {
    console.error(timeRes.error)
  }
  if (msgRes.error) console.error(msgRes.error)
  timeRows = timeRes.error ? [] : (timeRes.data || [])
  messageRows = msgRes.error ? [] : (msgRes.data || [])
}

function computeMetrics() {
  const { from, to } = getRangeIso()
  const dayCount = daysInRange(from, to)
  const days = eachIsoDay(from, to)

  let totalSeconds = 0
  /** @type {Map<string, number>} */
  const secByUser = new Map()
  /** @type {Map<string, number>} */
  const secByDay = new Map()
  /** @type {Map<number, number>} */
  const secByConv = new Map()
  /** @type {Map<string, Map<number, number>>} */
  const userConvSec = new Map()
  let dmSeconds = 0
  let groupSeconds = 0

  for (const row of timeRows) {
    const sec = Number(row.seconds) || 0
    const phone = normalizePhone(row.user_phone)
    const cid = Number(row.conversation_id)
    const day = String(row.day).slice(0, 10)
    totalSeconds += sec
    secByUser.set(phone, (secByUser.get(phone) || 0) + sec)
    secByDay.set(day, (secByDay.get(day) || 0) + sec)
    secByConv.set(cid, (secByConv.get(cid) || 0) + sec)
    if (!userConvSec.has(phone)) userConvSec.set(phone, new Map())
    const m = userConvSec.get(phone)
    m.set(cid, (m.get(cid) || 0) + sec)
    const conv = convById.get(cid)
    if (conv?.kind === 'group') groupSeconds += sec
    else dmSeconds += sec
  }

  /** @type {Map<string, number>} */
  const msgByDay = new Map()
  /** @type {Map<string, number>} */
  const msgByUser = new Map()
  /** @type {Map<number, number>} */
  const msgByConv = new Map()
  /** @type {number[]} */
  const hourBuckets = Array.from({ length: 24 }, () => 0)
  let dmMsgs = 0
  let groupMsgs = 0

  for (const m of messageRows) {
    const phone = normalizePhone(m.sender_phone)
    const cid = Number(m.conversation_id)
    const created = m.created_at ? new Date(m.created_at) : null
    if (created && !Number.isNaN(created.getTime())) {
      const day = created.toISOString().slice(0, 10)
      msgByDay.set(day, (msgByDay.get(day) || 0) + 1)
      hourBuckets[created.getHours()] += 1
    }
    msgByUser.set(phone, (msgByUser.get(phone) || 0) + 1)
    msgByConv.set(cid, (msgByConv.get(cid) || 0) + 1)
    const conv = convById.get(cid)
    if (conv?.kind === 'group') groupMsgs += 1
    else dmMsgs += 1
  }

  const activeUsers = [...secByUser.entries()].filter(([, s]) => s > 0)
  const avgPerActivePerDay = activeUsers.length
    ? totalSeconds / activeUsers.length / dayCount
    : 0
  const avgPerPresenceRow = timeRows.length
    ? timeRows.reduce((s, r) => s + (Number(r.seconds) || 0), 0) / timeRows.length
    : 0
  const avgMsgsPerActive = activeUsers.length
    ? messageRows.length / activeUsers.length
    : 0

  const topUsers = [...secByUser.entries()]
    .map(([phone, seconds]) => {
      const daysActive = new Set(
        timeRows.filter(r => normalizePhone(r.user_phone) === phone).map(r => String(r.day).slice(0, 10))
      ).size || 1
      const convs = userConvSec.get(phone)?.size || 0
      return {
        phone,
        name: nameOf(phone),
        seconds,
        avgDaily: seconds / daysActive,
        convs,
        messages: msgByUser.get(phone) || 0
      }
    })
    .sort((a, b) => b.seconds - a.seconds)

  /** DM pairs */
  const pairMap = new Map()
  for (const [cid, seconds] of secByConv) {
    const conv = convById.get(cid)
    if (!conv || conv.kind === 'group') continue
    const a = normalizePhone(conv.phone_a)
    const b = normalizePhone(conv.phone_b)
    if (!a || !b) continue
    const key = a < b ? `${a}|${b}` : `${b}|${a}`
    const prev = pairMap.get(key) || { a, b, seconds: 0, messages: 0, days: new Set() }
    prev.seconds += seconds
    prev.messages += msgByConv.get(cid) || 0
    for (const r of timeRows) {
      if (Number(r.conversation_id) === cid) prev.days.add(String(r.day).slice(0, 10))
    }
    pairMap.set(key, prev)
  }
  const topPairs = [...pairMap.values()]
    .map(p => ({
      ...p,
      label: `${nameOf(p.a)} ↔ ${nameOf(p.b)}`,
      avgDaily: p.seconds / Math.max(1, p.days.size)
    }))
    .sort((a, b) => b.seconds - a.seconds)

  const topGroups = [...secByConv.entries()]
    .map(([cid, seconds]) => {
      const conv = convById.get(cid)
      if (!conv || conv.kind !== 'group') return null
      return {
        cid,
        title: conv.title || 'گروه',
        seconds,
        messages: msgByConv.get(cid) || 0
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.seconds - a.seconds)

  const focusRows = topUsers.map(u => {
    const map = userConvSec.get(u.phone) || new Map()
    let top = 0
    let topCid = 0
    for (const [cid, sec] of map) {
      if (sec > top) {
        top = sec
        topCid = cid
      }
    }
    const pct = u.seconds > 0 ? Math.round((top / u.seconds) * 100) : 0
    const conv = convById.get(topCid)
    return {
      phone: u.phone,
      name: u.name,
      peers: map.size,
      topPct: pct,
      topLabel: convTitle(conv)
    }
  }).sort((a, b) => b.topPct - a.topPct)

  const allPhones = [...usersByPhone.keys()]
  const inactive = allPhones
    .filter(p => !(secByUser.get(p) > 0))
    .map(p => ({ phone: p, name: nameOf(p) }))
    .sort((a, b) => a.name.localeCompare(b.name, 'fa'))

  return {
    from,
    to,
    dayCount,
    days,
    totalSeconds,
    avgPerActivePerDay,
    avgPerPresenceRow,
    messageCount: messageRows.length,
    avgMsgsPerActive,
    dmSeconds,
    groupSeconds,
    dmMsgs,
    groupMsgs,
    activeUserCount: activeUsers.length,
    secByDay,
    msgByDay,
    hourBuckets,
    topUsers,
    topPairs,
    topGroups,
    focusRows,
    inactive,
    userConvSec,
    secByUser
  }
}

function kpiHtml(m) {
  return `
    <div class="dm-admin-kpi-grid">
      <div class="dm-admin-kpi"><div class="dm-admin-kpi-label">مجموع زمان</div><div class="dm-admin-kpi-value">${escapeHtml(formatDuration(m.totalSeconds))}</div></div>
      <div class="dm-admin-kpi"><div class="dm-admin-kpi-label">میانگین روزانه نفر فعال</div><div class="dm-admin-kpi-value">${escapeHtml(formatDuration(m.avgPerActivePerDay))}</div></div>
      <div class="dm-admin-kpi"><div class="dm-admin-kpi-label">میانگین حضور در گفتگو</div><div class="dm-admin-kpi-value">${escapeHtml(formatDuration(m.avgPerPresenceRow))}</div></div>
      <div class="dm-admin-kpi"><div class="dm-admin-kpi-label">پیام‌ها</div><div class="dm-admin-kpi-value">${m.messageCount.toLocaleString('fa-IR')}</div><div class="dm-admin-kpi-sub">میانگین ${Math.round(m.avgMsgsPerActive).toLocaleString('fa-IR')} / نفر فعال</div></div>
      <div class="dm-admin-kpi"><div class="dm-admin-kpi-label">نفر فعال</div><div class="dm-admin-kpi-value">${m.activeUserCount.toLocaleString('fa-IR')}</div></div>
      <div class="dm-admin-kpi"><div class="dm-admin-kpi-label">پی‌وی / گروه (زمان)</div><div class="dm-admin-kpi-value">${escapeHtml(formatDuration(m.dmSeconds))} / ${escapeHtml(formatDuration(m.groupSeconds))}</div></div>
    </div>`
}

async function renderChart(key, canvasId, config) {
  const canvas = document.getElementById(canvasId)
  if (!canvas) return
  await ensureChartLib()
  destroyChart(key)
  charts[key] = new ChartLib(canvas, config)
}

async function paintDashboardCharts(m) {
  const dayLabels = m.days.map(isoToJalaliLabel)
  const timeSeries = m.days.map(d => Math.round((m.secByDay.get(d) || 0) / 60))
  const msgSeries = m.days.map(d => m.msgByDay.get(d) || 0)

  await renderChart('trend', 'dmAdminChartTrend', {
    type: 'line',
    data: {
      labels: dayLabels,
      datasets: [
        { label: 'دقیقه چت', data: timeSeries, borderColor: '#25b88b', backgroundColor: 'rgba(37,184,139,0.15)', tension: 0.25, yAxisID: 'y' },
        { label: 'پیام', data: msgSeries, borderColor: '#0155d2', backgroundColor: 'rgba(1,85,210,0.1)', tension: 0.25, yAxisID: 'y1' }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        y: { beginAtZero: true, position: 'right', title: { display: true, text: 'دقیقه' } },
        y1: { beginAtZero: true, position: 'left', grid: { drawOnChartArea: false }, title: { display: true, text: 'پیام' } }
      }
    }
  })

  await renderChart('share', 'dmAdminChartShare', {
    type: 'doughnut',
    data: {
      labels: ['پی‌وی', 'گروه'],
      datasets: [{
        data: [Math.round(m.dmSeconds / 60), Math.round(m.groupSeconds / 60)],
        backgroundColor: ['#25b88b', '#0155d2']
      }]
    },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom' } } }
  })

  const topU = m.topUsers.slice(0, 10)
  await renderChart('users', 'dmAdminChartUsers', {
    type: 'bar',
    data: {
      labels: topU.map(u => u.name),
      datasets: [{ label: 'دقیقه', data: topU.map(u => Math.round(u.seconds / 60)), backgroundColor: '#25b88b' }]
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } }
    }
  })

  const pairs = m.topPairs.slice(0, 10)
  await renderChart('pairs', 'dmAdminChartPairs', {
    type: 'bar',
    data: {
      labels: pairs.map(p => p.label),
      datasets: [{ label: 'دقیقه', data: pairs.map(p => Math.round(p.seconds / 60)), backgroundColor: '#0155d2' }]
    },
    options: { indexAxis: 'y', responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } } }
  })

  const groups = m.topGroups.slice(0, 10)
  await renderChart('groups', 'dmAdminChartGroups', {
    type: 'bar',
    data: {
      labels: groups.map(g => g.title),
      datasets: [{ label: 'دقیقه', data: groups.map(g => Math.round(g.seconds / 60)), backgroundColor: '#F59E0B' }]
    },
    options: { indexAxis: 'y', responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } } }
  })

  const focus = m.focusRows.slice(0, 10)
  await renderChart('focus', 'dmAdminChartFocus', {
    type: 'bar',
    data: {
      labels: focus.map(f => f.name),
      datasets: [{ label: 'تمرکز %', data: focus.map(f => f.topPct), backgroundColor: '#ED1C24' }]
    },
    options: { indexAxis: 'y', responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } } }
  })

  await renderChart('hours', 'dmAdminChartHours', {
    type: 'bar',
    data: {
      labels: Array.from({ length: 24 }, (_, i) => String(i)),
      datasets: [{ label: 'پیام', data: m.hourBuckets, backgroundColor: '#78716C' }]
    },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } } }
  })

  scheduleChartsResize()
}

function tableUsers(m) {
  const rows = m.topUsers.map(u => `<tr>
    <td>${escapeHtml(u.name)}</td>
    <td>${escapeHtml(formatDuration(u.seconds))}</td>
    <td>${escapeHtml(formatDuration(u.avgDaily))}</td>
    <td>${u.convs}</td>
    <td>${u.messages.toLocaleString('fa-IR')}</td>
  </tr>`).join('') || '<tr><td colspan="5">داده‌ای نیست</td></tr>'
  return `<div class="dm-admin-table-wrap"><table class="dm-admin-table"><thead><tr>
    <th>کاربر</th><th>مجموع</th><th>میانگین روزانه</th><th>گفتگو</th><th>پیام</th>
  </tr></thead><tbody>${rows}</tbody></table></div>`
}

function tablePairs(m) {
  const rows = m.topPairs.map(p => `<tr>
    <td>${escapeHtml(p.label)}</td>
    <td>${escapeHtml(formatDuration(p.seconds))}</td>
    <td>${escapeHtml(formatDuration(p.avgDaily))}</td>
    <td>${p.messages.toLocaleString('fa-IR')}</td>
  </tr>`).join('') || '<tr><td colspan="4">داده‌ای نیست</td></tr>'
  return `<div class="dm-admin-table-wrap"><table class="dm-admin-table"><thead><tr>
    <th>جفت</th><th>زمان</th><th>میانگین روزانه</th><th>پیام</th>
  </tr></thead><tbody>${rows}</tbody></table></div>`
}

function tableGroups(m) {
  const rows = m.topGroups.map(g => `<tr>
    <td>${escapeHtml(g.title)}</td>
    <td>${escapeHtml(formatDuration(g.seconds))}</td>
    <td>${g.messages.toLocaleString('fa-IR')}</td>
  </tr>`).join('') || '<tr><td colspan="3">گروهی نیست</td></tr>'
  return `<div class="dm-admin-table-wrap"><table class="dm-admin-table"><thead><tr>
    <th>گروه</th><th>زمان</th><th>پیام</th>
  </tr></thead><tbody>${rows}</tbody></table></div>`
}

function tableFocus(m) {
  const rows = m.focusRows.map(f => `<tr>
    <td>${escapeHtml(f.name)}</td>
    <td>${f.peers}</td>
    <td>${f.topPct}٪</td>
    <td>${escapeHtml(f.topLabel)}</td>
  </tr>`).join('') || '<tr><td colspan="4">داده‌ای نیست</td></tr>'
  return `<div class="dm-admin-table-wrap"><table class="dm-admin-table"><thead><tr>
    <th>کاربر</th><th>مخاطب یکتا</th><th>تمرکز Top-1</th><th>بیشترین گفتگو</th>
  </tr></thead><tbody>${rows}</tbody></table></div>`
}

function renderDashboardHtml(m) {
  const inactive = m.inactive.slice(0, 40).map(u => `<li>${escapeHtml(u.name)}</li>`).join('') || '<li>همه فعال بوده‌اند</li>'
  return `
    ${kpiHtml(m)}
    <div class="dm-admin-block">
      <h4>روند روزانه</h4>
      <div class="dm-admin-chart-box"><canvas id="dmAdminChartTrend"></canvas></div>
    </div>
    <div class="dm-admin-split">
      <div class="dm-admin-block">
        <h4>سهم پی‌وی / گروه</h4>
        <div class="dm-admin-chart-box dm-admin-chart-sm"><canvas id="dmAdminChartShare"></canvas></div>
        <p class="settings-pane-desc">پیام‌ها: پی‌وی ${m.dmMsgs.toLocaleString('fa-IR')} — گروه ${m.groupMsgs.toLocaleString('fa-IR')}</p>
      </div>
      <div class="dm-admin-block">
        <h4>توزیع ساعتی پیام</h4>
        <div class="dm-admin-chart-box"><canvas id="dmAdminChartHours"></canvas></div>
      </div>
    </div>
    <div class="dm-admin-split">
      <div class="dm-admin-block"><h4>پرفعال‌ترین کاربران</h4><div class="dm-admin-chart-box"><canvas id="dmAdminChartUsers"></canvas></div>${tableUsers(m)}</div>
      <div class="dm-admin-block"><h4>جفت‌های پرترافیک</h4><div class="dm-admin-chart-box"><canvas id="dmAdminChartPairs"></canvas></div>${tablePairs(m)}</div>
    </div>
    <div class="dm-admin-split">
      <div class="dm-admin-block"><h4>گروه‌های پرفعال</h4><div class="dm-admin-chart-box"><canvas id="dmAdminChartGroups"></canvas></div>${tableGroups(m)}</div>
      <div class="dm-admin-block"><h4>تمرکز ارتباطی</h4><div class="dm-admin-chart-box"><canvas id="dmAdminChartFocus"></canvas></div>${tableFocus(m)}</div>
    </div>
    <div class="dm-admin-block">
      <h4>کاربران کم‌فعال / صفر در بازه</h4>
      <ul class="dm-admin-inactive">${inactive}</ul>
    </div>
  `
}

function renderDailyHtml(m) {
  const day = dailyPick || getTodayJalaliStr()
  const dayIso = jalaliToIsoDate(day)
  const dayTime = timeRows.filter(r => String(r.day).slice(0, 10) === dayIso)
  /** @type {Map<string, number>} */
  const byUser = new Map()
  for (const r of dayTime) {
    const p = normalizePhone(r.user_phone)
    byUser.set(p, (byUser.get(p) || 0) + (Number(r.seconds) || 0))
  }
  const ranked = [...byUser.entries()].sort((a, b) => b[1] - a[1])
  const rows = ranked.map(([phone, sec]) => {
    const details = dayTime
      .filter(r => normalizePhone(r.user_phone) === phone)
      .map(r => {
        const conv = convById.get(Number(r.conversation_id))
        return `<li>${escapeHtml(convTitle(conv))}: ${escapeHtml(formatDuration(r.seconds))}</li>`
      }).join('')
    return `<tr>
      <td>${escapeHtml(nameOf(phone))}</td>
      <td>${escapeHtml(formatDuration(sec))}</td>
      <td><ul class="dm-admin-mini-list">${details}</ul></td>
    </tr>`
  }).join('') || '<tr><td colspan="3">برای این روز داده‌ای نیست</td></tr>'

  return `
    <div class="dm-admin-daily-controls">
      <label>روز</label>
      <input type="text" class="form-input" id="dmAdminDailyDate" data-jdp value="${escapeAttr(day)}"
        onchange="app.onDmAdminDailyDate(this.value)" placeholder="تاریخ جلالی" />
      <button type="button" class="btn btn-sm" onclick="app.refreshDmChatAdmin()">اعمال</button>
    </div>
    <div class="dm-admin-split">
      <div class="dm-admin-block">
        <h4>سهم کاربران در ${escapeHtml(day)}</h4>
        <div class="dm-admin-chart-box dm-admin-chart-sm"><canvas id="dmAdminChartDailyPie"></canvas></div>
      </div>
      <div class="dm-admin-block">
        <h4>جزئیات</h4>
        <div class="dm-admin-table-wrap"><table class="dm-admin-table"><thead><tr>
          <th>کاربر</th><th>مجموع</th><th>گفتگوها</th>
        </tr></thead><tbody>${rows}</tbody></table></div>
      </div>
    </div>
  `
}

async function paintDailyChart() {
  const day = dailyPick || getTodayJalaliStr()
  const dayIso = jalaliToIsoDate(day)
  const dayTime = timeRows.filter(r => String(r.day).slice(0, 10) === dayIso)
  /** @type {Map<string, number>} */
  const byUser = new Map()
  for (const r of dayTime) {
    const p = normalizePhone(r.user_phone)
    byUser.set(p, (byUser.get(p) || 0) + (Number(r.seconds) || 0))
  }
  const ranked = [...byUser.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)
  await renderChart('dailyPie', 'dmAdminChartDailyPie', {
    type: 'doughnut',
    data: {
      labels: ranked.map(([p]) => nameOf(p)),
      datasets: [{ data: ranked.map(([, s]) => Math.round(s / 60)), backgroundColor: [
        '#25b88b', '#0155d2', '#F59E0B', '#ED1C24', '#78716C', '#10B981',
        '#6366F1', '#EC4899', '#14B8A6', '#A855F7', '#84CC16', '#F97316'
      ] }]
    },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom' } } }
  })
  scheduleChartsResize()
}

async function loadArchiveList() {
  await loadConversationsMap()
  archiveConvs = [...convById.values()].sort((a, b) => {
    const ta = a.last_message_at ? new Date(a.last_message_at).getTime() : 0
    const tb = b.last_message_at ? new Date(b.last_message_at).getTime() : 0
    return tb - ta
  })
}

function renderArchiveHtml() {
  const q = archiveFilter.trim().toLowerCase()
  const items = archiveConvs.filter(c => {
    const label = convTitle(c).toLowerCase()
    return !q || label.includes(q)
  }).slice(0, 200)

  const list = items.map(c => `<button type="button" class="dm-admin-archive-item" onclick="app.openDmAdminArchive(${Number(c.id)})">
    <strong>${c.kind === 'group' ? '<span class="dm-chat-kind-tag">گروه</span>' : ''}${escapeHtml(convTitle(c))}</strong>
    <span>${c.last_message_at ? escapeHtml(new Date(c.last_message_at).toLocaleString('fa-IR')) : '—'}</span>
  </button>`).join('') || '<div class="dm-chat-empty">گفتگویی نیست</div>'

  const modal = archiveOpenId
    ? `<div class="dm-admin-archive-modal" role="dialog">
        <div class="dm-admin-archive-modal-head">
          <strong>${escapeHtml(convTitle(convById.get(archiveOpenId)))}</strong>
          <button type="button" class="btn btn-sm" onclick="app.closeDmAdminArchive()">بستن</button>
        </div>
        <div class="dm-admin-archive-messages">
          ${archiveMessages.map(m => `<div class="dm-admin-archive-msg">
            <div class="dm-admin-archive-msg-meta">${escapeHtml(nameOf(m.sender_phone))} — ${escapeHtml(new Date(m.created_at).toLocaleString('fa-IR'))}</div>
            <div>${escapeHtml(m.body || '')}</div>
          </div>`).join('') || '<div class="dm-chat-empty">پیامی نیست</div>'}
        </div>
      </div>`
    : ''

  return `
    <div class="dm-chat-search">
      <input type="search" class="form-input" placeholder="جستجوی گفتگو…" value="${escapeAttr(archiveFilter)}"
        oninput="app.filterDmAdminArchive(this.value)" />
    </div>
    <div class="dm-admin-archive-list">${list}</div>
    ${modal}
  `
}

function filtersHtml() {
  return `
    <div class="dm-admin-filters">
      <div class="dm-admin-presets">
        <button type="button" class="btn btn-sm${rangePreset === 'today' ? ' btn-primary' : ''}" onclick="app.setDmAdminRange('today')">امروز</button>
        <button type="button" class="btn btn-sm${rangePreset === '7' ? ' btn-primary' : ''}" onclick="app.setDmAdminRange('7')">۷ روز</button>
        <button type="button" class="btn btn-sm${rangePreset === '30' ? ' btn-primary' : ''}" onclick="app.setDmAdminRange('30')">۳۰ روز</button>
        <button type="button" class="btn btn-sm${rangePreset === 'custom' ? ' btn-primary' : ''}" onclick="app.setDmAdminRange('custom')">بازه</button>
      </div>
      <div class="dm-admin-custom${rangePreset === 'custom' ? '' : ' is-hidden'}">
        <input type="text" class="form-input" id="dmAdminFrom" data-jdp placeholder="از تاریخ" value="${escapeAttr(customFrom)}" onchange="app.onDmAdminCustomFrom(this.value)" />
        <input type="text" class="form-input" id="dmAdminTo" data-jdp placeholder="تا تاریخ" value="${escapeAttr(customTo)}" onchange="app.onDmAdminCustomTo(this.value)" />
        <button type="button" class="btn btn-sm btn-primary" onclick="app.refreshDmChatAdmin()">اعمال</button>
      </div>
      <div class="dm-admin-subtabs">
        <button type="button" class="notif-md-tab${subTab === 'dashboard' ? ' is-active' : ''}" onclick="app.setDmAdminSubTab('dashboard')">داشبورد</button>
        <button type="button" class="notif-md-tab${subTab === 'daily' ? ' is-active' : ''}" onclick="app.setDmAdminSubTab('daily')">جزئیات روزانه</button>
        <button type="button" class="notif-md-tab${subTab === 'archive' ? ' is-active' : ''}" onclick="app.setDmAdminSubTab('archive')">آرشیو</button>
      </div>
    </div>
  `
}

export async function renderDmChatAdminSection() {
  if (!requireMainAdmin()) return
  const host = document.getElementById('dmChatAdminRoot')
  if (!host) return
  host.innerHTML = `${filtersHtml()}<div class="dm-admin-body" id="dmAdminBody"><div class="dm-chat-empty">در حال بارگذاری…</div></div>`

  try {
    if (typeof window.jalaliDatepicker?.startWatch === 'function') {
      window.jalaliDatepicker.startWatch({ selector: '#dmAdminFrom,#dmAdminTo,#dmAdminDailyDate' })
    }
  } catch (_) { /* ignore */ }

  await refreshDmChatAdmin()
}

export async function refreshDmChatAdmin() {
  if (!requireMainAdmin()) return
  const body = document.getElementById('dmAdminBody')
  if (!body) return
  destroyAllCharts()
  await refreshUsers()
  await loadConversationsMap()

  if (subTab === 'archive') {
    await loadArchiveList()
    body.innerHTML = renderArchiveHtml()
    return
  }

  await loadRangeData()
  const m = computeMetrics()
  if (subTab === 'daily') {
    if (!dailyPick) dailyPick = getTodayJalaliStr()
    body.innerHTML = renderDailyHtml(m)
    await paintDailyChart()
  } else {
    body.innerHTML = renderDashboardHtml(m)
    await paintDashboardCharts(m)
  }
}

export function setDmAdminRange(preset) {
  rangePreset = preset
  renderDmChatAdminSection().catch(e => console.error(e))
}

export function setDmAdminSubTab(tab) {
  subTab = tab === 'daily' || tab === 'archive' ? tab : 'dashboard'
  destroyAllCharts()
  renderDmChatAdminSection().catch(e => console.error(e))
}

export function onDmAdminCustomFrom(v) {
  customFrom = String(v || '')
  rangePreset = 'custom'
}

export function onDmAdminCustomTo(v) {
  customTo = String(v || '')
  rangePreset = 'custom'
}

export function onDmAdminDailyDate(v) {
  dailyPick = String(v || '')
}

export function filterDmAdminArchive(v) {
  archiveFilter = String(v || '')
  const body = document.getElementById('dmAdminBody')
  if (body && subTab === 'archive') body.innerHTML = renderArchiveHtml()
}

export async function openDmAdminArchive(id) {
  archiveOpenId = Number(id)
  const { data, error } = await supabase
    .from('dm_messages')
    .select('*')
    .eq('conversation_id', archiveOpenId)
    .order('id', { ascending: true })
    .limit(500)
  if (error) {
    showToast('خطا در بارگذاری پیام‌ها')
    archiveMessages = []
  } else {
    archiveMessages = data || []
  }
  const body = document.getElementById('dmAdminBody')
  if (body) body.innerHTML = renderArchiveHtml()
}

export function closeDmAdminArchive() {
  archiveOpenId = null
  archiveMessages = []
  const body = document.getElementById('dmAdminBody')
  if (body) body.innerHTML = renderArchiveHtml()
}
