/**
 * Pure ops-digest metrics (no DOM / Supabase).
 * Used by ops-digest-cron (Deno) and scripts/test-ops-digest.mjs (Node).
 */

export const DIGEST_KIND_MORNING = 'morning_advisor'
export const DIGEST_KIND_EVENING = 'evening_manager'
export const SYSTEM_DIGEST_PHONE = 'system:digest'
export const SYSTEM_DIGEST_NAME = 'سیستم'

const FA_DIGITS = '۰۱۲۳۴۵۶۷۸۹'
const EN_DIGITS = '0123456789'

export function toEnDigits(str) {
  return String(str || '').replace(/[۰-۹]/g, (ch) => {
    const i = FA_DIGITS.indexOf(ch)
    return i >= 0 ? EN_DIGITS[i] : ch
  })
}

/** Normalize to 11-digit 09xxxxxxxxx when possible. */
export function normalizePhone(phone) {
  let p = toEnDigits(String(phone || '')).replace(/\D/g, '')
  if (!p) return ''
  if (p.length > 10) p = p.slice(-10)
  if (p.length === 10 && p.startsWith('9')) p = '0' + p
  return p
}

export function toJalali(gregorian) {
  const gy = gregorian.getFullYear()
  const gm = gregorian.getMonth() + 1
  const gd = gregorian.getDate()

  const g_d_m = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334]
  const gy2 = (gm > 2) ? (gy + 1) : gy
  let days = 355666 + (365 * gy) + Math.floor((gy2 + 3) / 4) - Math.floor((gy2 + 99) / 100) + Math.floor((gy2 + 399) / 400) + gd + g_d_m[gm - 1]
  let jy = -1595 + (33 * Math.floor(days / 12053))
  days %= 12053
  jy += 4 * Math.floor(days / 1461)
  days %= 1461
  if (days > 365) {
    jy += Math.floor((days - 1) / 365)
    days = (days - 1) % 365
  }
  let jm
  let jd
  if (days < 186) {
    jm = 1 + Math.floor(days / 31)
    jd = 1 + (days % 31)
  } else {
    jm = 7 + Math.floor((days - 186) / 30)
    jd = 1 + ((days - 186) % 30)
  }
  return { year: jy, month: jm, day: jd }
}

/** Jalali YYYY/MM/DD in Asia/Tehran for a Date (default now). */
export function getTodayJalaliStr(now = new Date()) {
  const tehran = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Tehran' }))
  const j = toJalali(tehran)
  return `${j.year}/${String(j.month).padStart(2, '0')}/${String(j.day).padStart(2, '0')}`
}

export function normalizeJalaliDate(dateStr) {
  if (!dateStr) return ''
  return toEnDigits(String(dateStr)).trim().split(/\s+/)[0] || ''
}

export function jalaliToNum(dateStr) {
  if (!dateStr) return 99999999
  const datePart = normalizeJalaliDate(dateStr)
  const parts = datePart.split('/')
  if (parts.length !== 3) return 99999999
  const y = parseInt(parts[0], 10) || 0
  const m = parseInt(parts[1], 10) || 0
  const d = parseInt(parts[2], 10) || 0
  if (!y || !m || !d) return 99999999
  return y * 10000 + m * 100 + d
}

export function isJalaliLeap(y) {
  return ((y + 2346) % 33) % 4 === 1
}

/** Returns numeric yyyymmdd after adding days to a Jalali date string. */
export function jalaliAddDays(dateStr, days) {
  const parts = normalizeJalaliDate(dateStr).split('/').map(Number)
  let y = parts[0]
  let m = parts[1]
  let d = parts[2] + days
  const daysInMonth = [31, 31, 31, 31, 31, 31, 30, 30, 30, 30, 30, isJalaliLeap(y) ? 30 : 29]
  while (d > daysInMonth[m - 1]) {
    d -= daysInMonth[m - 1]
    m++
    if (m > 12) {
      m = 1
      y++
    }
  }
  while (d <= 0) {
    m--
    if (m < 1) {
      m = 12
      y--
    }
    const dim = [31, 31, 31, 31, 31, 31, 30, 30, 30, 30, 30, isJalaliLeap(y) ? 30 : 29]
    d += dim[m - 1]
  }
  return y * 10000 + m * 100 + d
}

/** today | waiting | overdue | null */
export function classifyFollowupDate(dateStr, todayStr) {
  const num = jalaliToNum(dateStr)
  if (num === 99999999) return null
  const todayN = jalaliToNum(todayStr)
  if (num < todayN) return 'overdue'
  if (num === todayN) return 'today'
  return 'waiting'
}

export function isDoneFollowup(f) {
  if (!f) return false
  if (f.status === 'done') return true
  const t = f.type || ''
  return t === 'پیگیری انجام‌شده' || t === 'پیگیری معوقه انجام‌شده'
}

export function isOpenAssignedFollowup(f) {
  if (!f) return false
  if (!normalizePhone(f.assigned_to_phone || f.assignedToPhone)) return false
  if (!normalizeJalaliDate(f.next_date || f.nextDate)) return false
  if (isDoneFollowup(f) || f.status === 'done') return false
  return true
}

/**
 * Morning advisor counts for one phone.
 * @param {{ phone: string, customers: Array<{advisor_phone?: string, advisorPhone?: string, next_followup_date?: string, nextFollowupDate?: string}>, followups: Array<object>, todayStr: string }}
 */
export function countAdvisorMorningMetrics({ phone, customers = [], followups = [], todayStr }) {
  const me = normalizePhone(phone)
  const empty = { overdue: 0, today: 0, assignedOpen: 0 }
  if (!me || !todayStr) return empty

  let overdue = 0
  let today = 0
  for (const c of customers) {
    const owner = normalizePhone(c.advisor_phone || c.advisorPhone)
    if (owner !== me) continue
    const cat = classifyFollowupDate(c.next_followup_date || c.nextFollowupDate, todayStr)
    if (cat === 'overdue') overdue++
    else if (cat === 'today') today++
  }

  let assignedOpen = 0
  for (const f of followups) {
    if (!isOpenAssignedFollowup(f)) continue
    const assignee = normalizePhone(f.assigned_to_phone || f.assignedToPhone)
    if (assignee !== me) continue
    assignedOpen++
  }

  return { overdue, today, assignedOpen }
}

/**
 * Evening manager counts for a team (subordinate phones only).
 * Soon = not overdue and date <= today+3 (dashboard monitor).
 */
export function countManagerEveningMetrics({ teamPhones = [], customers = [], followups = [], todayStr }) {
  const team = new Set((teamPhones || []).map(normalizePhone).filter(Boolean))
  const empty = { overdue: 0, soon: 0, assignedOpen: 0 }
  if (!team.size || !todayStr) return empty

  const in3DaysNum = jalaliAddDays(todayStr, 3)
  const todayN = jalaliToNum(todayStr)

  let overdue = 0
  let soon = 0
  for (const c of customers) {
    const owner = normalizePhone(c.advisor_phone || c.advisorPhone)
    if (!owner || !team.has(owner)) continue
    const num = jalaliToNum(c.next_followup_date || c.nextFollowupDate)
    if (num === 99999999) continue
    if (num < todayN) overdue++
    else if (num <= in3DaysNum) soon++
  }

  let assignedOpen = 0
  for (const f of followups) {
    if (!isOpenAssignedFollowup(f)) continue
    const assignee = normalizePhone(f.assigned_to_phone || f.assignedToPhone)
    if (!assignee || !team.has(assignee)) continue
    assignedOpen++
  }

  return { overdue, soon, assignedOpen }
}

export function morningHasWork(counts) {
  return !!(counts && (counts.overdue > 0 || counts.today > 0 || counts.assignedOpen > 0))
}

export function eveningHasWork(counts) {
  return !!(counts && (counts.overdue > 0 || counts.soon > 0 || counts.assignedOpen > 0))
}

export function formatMorningTitle(digestDate) {
  return `خلاصه صبح — ${digestDate}`
}

export function formatEveningTitle(digestDate) {
  return `خلاصه عصر تیم — ${digestDate}`
}

/** Markdown body; only lines with count > 0. */
export function formatMorningMessage(counts) {
  const lines = []
  if (counts.overdue > 0) lines.push(`- فالوآپ‌های معوق: **${counts.overdue}**`)
  if (counts.today > 0) lines.push(`- سررسید امروز: **${counts.today}**`)
  if (counts.assignedOpen > 0) lines.push(`- ارجاع‌شده به من (باز): **${counts.assignedOpen}**`)
  return lines.join('\n')
}

export function formatEveningMessage(counts) {
  const lines = []
  if (counts.overdue > 0) lines.push(`- فالوآپ معوق تیم: **${counts.overdue}**`)
  if (counts.soon > 0) lines.push(`- سررسید قریب تیم (تا ۳ روز): **${counts.soon}**`)
  if (counts.assignedOpen > 0) lines.push(`- ارجاع باز در تیم: **${counts.assignedOpen}**`)
  return lines.join('\n')
}

export function isDigestKind(kind) {
  return kind === DIGEST_KIND_MORNING || kind === DIGEST_KIND_EVENING
}

export function isSystemDigestSender(createdByPhone) {
  return String(createdByPhone || '') === SYSTEM_DIGEST_PHONE
}
