// ============================================
// DM + group chat widget (bottom-left FAB)
// ============================================

import { supabase } from './supabase.js'
import { getUsersSafe } from './auth.js'
import {
  escapeHtml,
  escapeAttr,
  getCurrentUser,
  normalizePhone,
  userDisplayName,
  showToast,
  isMainAdmin
} from './utils.js'

const CHANNEL_NAME = 'dm-chat-live'
const NOTIF_SOUND_URL = '/notif.mp3'
const MESSAGE_PAGE = 80
const MAX_OPEN_TABS = 6
const HEARTBEAT_MS = 15_000
const HEARTBEAT_SECONDS = 15

/** @type {import('@supabase/supabase-js').RealtimeChannel | null} */
let channel = null
let started = false
let panelOpen = false
/** @type {'list' | 'chat' | 'create-group'} */
let viewMode = 'list'
/** @type {{ conversationId: number, kind: string, title?: string, peerPhone?: string }[]} */
let openTabs = []
let activeTabIndex = -1
/** @type {any[]} */
let conversations = []
/** @type {Map<number, any[]>} */
const messagesByConv = new Map()
/** @type {Map<number, number>} */
const readsByConv = new Map()
/** @type {Map<number, number>} */
const unreadByConv = new Map()
/** @type {Set<number>} */
const personalPins = new Set()
/** @type {Set<number>} */
const globalPins = new Set()
/** @type {Map<string, any>} */
let usersByPhone = new Map()
let contactFilter = ''
let groupTitleDraft = ''
/** @type {Set<string>} */
let groupMemberDraft = new Set()
let groupMemberFilter = ''
let sending = false
let escapeHandler = null
let visibilityHandler = null
let heartbeatTimer = null
let viewportHandler = null

function myPhone() {
  return normalizePhone(getCurrentUser()?.phone)
}

function orderedPhones(a, b) {
  const pa = normalizePhone(a)
  const pb = normalizePhone(b)
  if (!pa || !pb) return null
  return pa < pb ? [pa, pb] : [pb, pa]
}

function convKind(conv) {
  return conv?.kind === 'group' ? 'group' : 'dm'
}

function peerPhoneOf(conv, me = myPhone()) {
  if (!conv || !me || convKind(conv) === 'group') return ''
  const a = normalizePhone(conv.phone_a)
  const b = normalizePhone(conv.phone_b)
  return a === me ? b : a
}

function convLabel(conv) {
  if (!conv) return 'گفتگو'
  if (convKind(conv) === 'group') return (conv.title || 'گروه').trim() || 'گروه'
  return peerLabel(peerPhoneOf(conv))
}

function tabLabel(tab) {
  if (!tab) return 'گفتگو'
  if (tab.kind === 'group') return (tab.title || 'گروه').trim() || 'گروه'
  return peerLabel(tab.peerPhone)
}

function playNotifSound() {
  try {
    const audio = new Audio(NOTIF_SOUND_URL)
    audio.play().catch(() => {})
  } catch (_) { /* ignore */ }
}

function rootEl() {
  return document.getElementById('dmChatRoot')
}

function panelEl() {
  return document.getElementById('dmChatPanel')
}

function badgeEl() {
  return document.getElementById('dmChatBadge')
}

function todayUtcDate() {
  return new Date().toISOString().slice(0, 10)
}

function formatMsgTime(iso) {
  if (!iso) return ''
  try {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return ''
    return d.toLocaleString('fa-IR', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    })
  } catch {
    return ''
  }
}

function peerLabel(phone) {
  const p = normalizePhone(phone)
  const u = usersByPhone.get(p)
  return userDisplayName(u) || p || 'کاربر'
}

function totalUnread() {
  let n = 0
  for (const v of unreadByConv.values()) n += v
  return n
}

function updateBadge() {
  const el = badgeEl()
  if (!el) return
  const n = totalUnread()
  if (n > 0) {
    el.hidden = false
    el.textContent = n > 99 ? '99+' : String(n)
  } else {
    el.hidden = true
    el.textContent = '0'
  }
  const fab = document.getElementById('dmChatFab')
  if (fab) fab.setAttribute('aria-label', n > 0 ? `چت (${n} خوانده‌نشده)` : 'چت')
}

function setBodyChatOpen(open) {
  document.body.classList.toggle('dm-chat-open', !!open)
}

function syncViewportOffset() {
  const panel = panelEl()
  if (!panel || !panelOpen) return
  const vv = window.visualViewport
  if (!vv) {
    panel.style.maxHeight = ''
    return
  }
  const available = Math.max(240, Math.floor(vv.height - 24))
  panel.style.maxHeight = `${available}px`
}

async function refreshUsersMap() {
  const users = await getUsersSafe()
  const map = new Map()
  for (const u of users) {
    const p = normalizePhone(u.phone)
    if (p) map.set(p, u)
  }
  usersByPhone = map
}

async function loadConversations() {
  const me = myPhone()
  if (!me) {
    conversations = []
    return
  }
  const { data: memberships, error: memErr } = await supabase
    .from('dm_members')
    .select('conversation_id')
    .eq('user_phone', me)
  if (memErr) {
    // Fallback for pre-029 schema
    const { data, error } = await supabase
      .from('dm_conversations')
      .select('*')
      .or(`phone_a.eq.${me},phone_b.eq.${me}`)
      .order('last_message_at', { ascending: false, nullsFirst: false })
    if (error) {
      console.error('dm loadConversations:', error)
      conversations = []
      return
    }
    conversations = data || []
    return
  }
  const ids = [...new Set((memberships || []).map(m => Number(m.conversation_id)).filter(Boolean))]
  if (!ids.length) {
    conversations = []
    return
  }
  const { data, error } = await supabase
    .from('dm_conversations')
    .select('*')
    .in('id', ids)
    .order('last_message_at', { ascending: false, nullsFirst: false })
  if (error) {
    console.error('dm loadConversations:', error)
    conversations = []
    return
  }
  conversations = data || []
}

async function loadPins() {
  personalPins.clear()
  globalPins.clear()
  const me = myPhone()
  if (!me) return
  const { data, error } = await supabase
    .from('dm_pins')
    .select('conversation_id, scope, user_phone')
  if (error) {
    if (!/dm_pins|does not exist|relation/i.test(error.message || '')) {
      console.error('dm loadPins:', error)
    }
    return
  }
  for (const row of data || []) {
    const cid = Number(row.conversation_id)
    if (row.scope === 'global') globalPins.add(cid)
    else if (row.scope === 'personal' && normalizePhone(row.user_phone) === me) personalPins.add(cid)
  }
}

async function loadReads() {
  const me = myPhone()
  readsByConv.clear()
  if (!me) return
  const { data, error } = await supabase
    .from('dm_reads')
    .select('conversation_id, last_read_message_id')
    .eq('user_phone', me)
  if (error) {
    console.error('dm loadReads:', error)
    return
  }
  for (const row of data || []) {
    readsByConv.set(Number(row.conversation_id), Number(row.last_read_message_id || 0))
  }
}

async function refreshUnreadCounts() {
  const me = myPhone()
  unreadByConv.clear()
  if (!me || !conversations.length) {
    updateBadge()
    return
  }
  const ids = conversations.map(c => Number(c.id))
  const { data, error } = await supabase
    .from('dm_messages')
    .select('id, conversation_id, sender_phone')
    .in('conversation_id', ids)
    .neq('sender_phone', me)
  if (error) {
    console.error('dm refreshUnreadCounts:', error)
    updateBadge()
    return
  }
  for (const msg of data || []) {
    const cid = Number(msg.conversation_id)
    const lastRead = readsByConv.get(cid) || 0
    if (Number(msg.id) > lastRead) {
      unreadByConv.set(cid, (unreadByConv.get(cid) || 0) + 1)
    }
  }
  updateBadge()
}

async function loadMessages(conversationId) {
  const cid = Number(conversationId)
  const { data, error } = await supabase
    .from('dm_messages')
    .select('*')
    .eq('conversation_id', cid)
    .order('id', { ascending: false })
    .limit(MESSAGE_PAGE)
  if (error) {
    console.error('dm loadMessages:', error)
    messagesByConv.set(cid, [])
    return []
  }
  const rows = (data || []).slice().reverse()
  messagesByConv.set(cid, rows)
  return rows
}

async function ensureDmMembers(conv) {
  if (!conv?.id) return
  const phones = [normalizePhone(conv.phone_a), normalizePhone(conv.phone_b)].filter(Boolean)
  if (!phones.length) return
  const rows = phones.map(user_phone => ({
    conversation_id: Number(conv.id),
    user_phone
  }))
  const { error } = await supabase.from('dm_members').upsert(rows, { onConflict: 'conversation_id,user_phone' })
  if (error && !/dm_members|does not exist|relation/i.test(error.message || '')) {
    console.error('ensureDmMembers:', error)
  }
}

async function getOrCreateConversation(peerPhone) {
  const me = myPhone()
  const ordered = orderedPhones(me, peerPhone)
  if (!ordered) throw new Error('شماره نامعتبر')
  const [phone_a, phone_b] = ordered
  if (phone_a === phone_b) throw new Error('نمی‌توانید با خودتان چت کنید')

  const { data: existing, error: selErr } = await supabase
    .from('dm_conversations')
    .select('*')
    .eq('kind', 'dm')
    .eq('phone_a', phone_a)
    .eq('phone_b', phone_b)
    .maybeSingle()
  if (selErr) {
    // pre-029 without kind column
    const { data: legacy, error: legErr } = await supabase
      .from('dm_conversations')
      .select('*')
      .eq('phone_a', phone_a)
      .eq('phone_b', phone_b)
      .maybeSingle()
    if (legErr) throw selErr
    if (legacy) {
      await ensureDmMembers(legacy)
      return legacy
    }
  } else if (existing) {
    await ensureDmMembers(existing)
    return existing
  }

  const payload = { phone_a, phone_b, kind: 'dm', created_by_phone: me }
  const { data: created, error: insErr } = await supabase
    .from('dm_conversations')
    .insert(payload)
    .select('*')
    .single()
  if (insErr) {
    const { data: again } = await supabase
      .from('dm_conversations')
      .select('*')
      .eq('phone_a', phone_a)
      .eq('phone_b', phone_b)
      .maybeSingle()
    if (again) {
      await ensureDmMembers(again)
      return again
    }
    // retry without kind for pre-029
    const { data: createdLegacy, error: legIns } = await supabase
      .from('dm_conversations')
      .insert({ phone_a, phone_b })
      .select('*')
      .single()
    if (legIns) throw insErr
    await ensureDmMembers(createdLegacy)
    return createdLegacy
  }
  await ensureDmMembers(created)
  return created
}

async function markConversationRead(conversationId) {
  const me = myPhone()
  const cid = Number(conversationId)
  if (!me || !cid) return
  const msgs = messagesByConv.get(cid) || []
  const lastId = msgs.length ? Number(msgs[msgs.length - 1].id) : 0
  if (!lastId) {
    unreadByConv.delete(cid)
    updateBadge()
    return
  }
  const { error } = await supabase.from('dm_reads').upsert({
    conversation_id: cid,
    user_phone: me,
    last_read_message_id: lastId,
    last_read_at: new Date().toISOString()
  }, { onConflict: 'conversation_id,user_phone' })
  if (error) {
    console.error('dm markConversationRead:', error)
    return
  }
  readsByConv.set(cid, lastId)
  unreadByConv.delete(cid)
  updateBadge()
}

function isActiveConversation(conversationId) {
  if (!panelOpen || viewMode !== 'chat' || activeTabIndex < 0) return false
  return Number(openTabs[activeTabIndex]?.conversationId) === Number(conversationId)
}

function canHeartbeat() {
  if (!panelOpen || viewMode !== 'chat') return false
  if (document.visibilityState !== 'visible') return false
  if (document.hidden) return false
  const tab = openTabs[activeTabIndex]
  return !!(tab && tab.conversationId)
}

async function flushHeartbeat() {
  if (!canHeartbeat()) return
  const me = myPhone()
  const tab = openTabs[activeTabIndex]
  if (!me || !tab) return
  const cid = Number(tab.conversationId)
  const day = todayUtcDate()
  const { error } = await supabase.rpc('dm_add_chat_seconds', {
    p_day: day,
    p_user_phone: me,
    p_conversation_id: cid,
    p_seconds: HEARTBEAT_SECONDS
  })
  if (error) {
    // Fallback without RPC
    try {
      const { data } = await supabase
        .from('dm_chat_time_daily')
        .select('seconds')
        .eq('day', day)
        .eq('user_phone', me)
        .eq('conversation_id', cid)
        .maybeSingle()
      const next = Number(data?.seconds || 0) + HEARTBEAT_SECONDS
      await supabase.from('dm_chat_time_daily').upsert({
        day,
        user_phone: me,
        conversation_id: cid,
        seconds: next
      }, { onConflict: 'day,user_phone,conversation_id' })
    } catch (e) {
      /* ignore analytics failures */
    }
  }
}

function startHeartbeat() {
  stopHeartbeat()
  heartbeatTimer = setInterval(() => {
    flushHeartbeat().catch(() => {})
  }, HEARTBEAT_MS)
}

function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer)
    heartbeatTimer = null
  }
}

function pinRank(cid) {
  const id = Number(cid)
  if (globalPins.has(id)) return 0
  if (personalPins.has(id)) return 1
  return 2
}

function sortedConversations() {
  return [...conversations].sort((a, b) => {
    const ra = pinRank(a.id)
    const rb = pinRank(b.id)
    if (ra !== rb) return ra - rb
    const ta = a.last_message_at ? new Date(a.last_message_at).getTime() : 0
    const tb = b.last_message_at ? new Date(b.last_message_at).getTime() : 0
    return tb - ta
  })
}

function renderTabs() {
  const el = document.getElementById('dmChatTabs')
  if (!el) return
  if (!openTabs.length || viewMode !== 'chat') {
    el.hidden = true
    el.innerHTML = ''
    return
  }
  el.hidden = false
  el.innerHTML = openTabs.map((tab, i) => {
    const active = i === activeTabIndex ? ' is-active' : ''
    const unread = unreadByConv.get(Number(tab.conversationId)) || 0
    const badge = unread > 0 ? `<span class="dm-chat-tab-unread">${unread > 9 ? '9+' : unread}</span>` : ''
    return `<button type="button" class="dm-chat-tab${active}" onclick="app.selectDmChatTab(${i})">
      <span class="dm-chat-tab-label">${escapeHtml(tabLabel(tab))}</span>
      ${badge}
      <span class="dm-chat-tab-close" onclick="event.stopPropagation(); app.closeDmChatTab(${i})" title="بستن" aria-label="بستن">&times;</span>
    </button>`
  }).join('')
}

function pinButtonsHtml(cid) {
  const id = Number(cid)
  const personal = personalPins.has(id)
  const global = globalPins.has(id)
  const admin = isMainAdmin()
  let html = `<button type="button" class="dm-chat-pin-btn${personal ? ' is-on' : ''}" title="${personal ? 'برداشتن پین شخصی' : 'پین شخصی'}"
    onclick="event.stopPropagation(); app.toggleDmChatPin(${id}, 'personal')" aria-label="پین شخصی">📌</button>`
  if (admin) {
    html += `<button type="button" class="dm-chat-pin-btn dm-chat-pin-global${global ? ' is-on' : ''}" title="${global ? 'برداشتن پین سراسری' : 'پین برای همه'}"
      onclick="event.stopPropagation(); app.toggleDmChatPin(${id}, 'global')" aria-label="پین سراسری">🌐</button>`
  }
  return html
}

function renderListBody() {
  const body = document.getElementById('dmChatBody')
  const composer = document.getElementById('dmChatComposer')
  const backBtn = document.getElementById('dmChatBackBtn')
  const title = document.getElementById('dmChatTitle')
  if (composer) composer.hidden = true
  if (backBtn) backBtn.hidden = true
  if (title) title.textContent = 'گفتگوها'
  renderTabs()
  if (!body) return

  const me = myPhone()
  const q = contactFilter.trim().toLowerCase()
  const peersFromConvs = new Set(
    conversations.filter(c => convKind(c) === 'dm').map(c => peerPhoneOf(c, me)).filter(Boolean)
  )

  const convItems = sortedConversations().map(c => {
    const kind = convKind(c)
    const name = convLabel(c)
    const peer = peerPhoneOf(c, me)
    const unread = unreadByConv.get(Number(c.id)) || 0
    const hay = `${name} ${peer}`.toLowerCase()
    if (q && !hay.includes(q)) return ''
    const pinMark = globalPins.has(Number(c.id))
      ? '<span class="dm-chat-pin-mark" title="پین سراسری">🌐</span>'
      : personalPins.has(Number(c.id))
        ? '<span class="dm-chat-pin-mark" title="پین شخصی">📌</span>'
        : ''
    const openCall = kind === 'group'
      ? `app.openDmChatConversation(${Number(c.id)})`
      : `app.openDmChatWith('${escapeAttr(peer)}')`
    return `<div class="dm-chat-row-wrap">
      <button type="button" class="dm-chat-row" onclick="${openCall}">
        <div class="dm-chat-row-main">
          <span class="dm-chat-row-name">${pinMark}${kind === 'group' ? '<span class="dm-chat-kind-tag">گروه</span>' : ''}${escapeHtml(name)}</span>
          <span class="dm-chat-row-meta">${escapeHtml(formatMsgTime(c.last_message_at))}</span>
        </div>
        ${unread > 0 ? `<span class="dm-chat-row-badge">${unread > 99 ? '99+' : unread}</span>` : ''}
      </button>
      <div class="dm-chat-row-actions">${pinButtonsHtml(c.id)}</div>
    </div>`
  }).filter(Boolean).join('')

  const contactUsers = [...usersByPhone.values()]
    .filter(u => {
      const p = normalizePhone(u.phone)
      if (!p || p === me) return false
      if (peersFromConvs.has(p)) return false
      const name = userDisplayName(u).toLowerCase()
      if (q && !name.includes(q) && !p.includes(q)) return false
      return true
    })
    .sort((a, b) => userDisplayName(a).localeCompare(userDisplayName(b), 'fa'))

  const contactItems = contactUsers.map(u => {
    const p = normalizePhone(u.phone)
    return `<button type="button" class="dm-chat-row dm-chat-row-contact" onclick="app.openDmChatWith('${escapeAttr(p)}')">
      <div class="dm-chat-row-main">
        <span class="dm-chat-row-name">${escapeHtml(userDisplayName(u))}</span>
        <span class="dm-chat-row-meta">${escapeHtml(p)}</span>
      </div>
    </button>`
  }).join('')

  const adminBar = isMainAdmin()
    ? `<div class="dm-chat-admin-bar">
        <button type="button" class="btn btn-sm btn-primary" onclick="app.openDmCreateGroup()">گروه جدید</button>
      </div>`
    : ''

  body.innerHTML = `
    ${adminBar}
    <div class="dm-chat-search">
      <input type="search" id="dmChatSearch" placeholder="جستجوی کاربر یا گفتگو…" value="${escapeAttr(contactFilter)}"
        oninput="app.filterDmChatContacts(this.value)" autocomplete="off" />
    </div>
    <div class="dm-chat-list" role="list">
      ${convItems || (q ? '' : '<div class="dm-chat-empty">هنوز گفتگویی ندارید</div>')}
      ${contactItems ? `<div class="dm-chat-list-section">شروع گفتگوی جدید</div>${contactItems}` : ''}
      ${!convItems && !contactItems ? '<div class="dm-chat-empty">نتیجه‌ای یافت نشد</div>' : ''}
    </div>
  `
}

function renderCreateGroupBody() {
  const body = document.getElementById('dmChatBody')
  const composer = document.getElementById('dmChatComposer')
  const backBtn = document.getElementById('dmChatBackBtn')
  const title = document.getElementById('dmChatTitle')
  if (composer) composer.hidden = true
  if (backBtn) backBtn.hidden = false
  if (title) title.textContent = 'گروه جدید'
  renderTabs()
  if (!body) return

  const me = myPhone()
  const q = groupMemberFilter.trim().toLowerCase()
  const users = [...usersByPhone.values()]
    .filter(u => {
      const p = normalizePhone(u.phone)
      if (!p || p === me) return false
      const name = userDisplayName(u).toLowerCase()
      if (q && !name.includes(q) && !p.includes(q)) return false
      return true
    })
    .sort((a, b) => userDisplayName(a).localeCompare(userDisplayName(b), 'fa'))

  const rows = users.map(u => {
    const p = normalizePhone(u.phone)
    const checked = groupMemberDraft.has(p) ? 'checked' : ''
    return `<label class="dm-chat-member-row">
      <input type="checkbox" ${checked} onchange="app.toggleDmGroupMember('${escapeAttr(p)}', this.checked)" />
      <span>
        <strong>${escapeHtml(userDisplayName(u))}</strong>
        <small>${escapeHtml(p)}</small>
      </span>
    </label>`
  }).join('')

  body.innerHTML = `
    <div class="dm-chat-create-group">
      <div class="form-group">
        <label for="dmGroupTitle">نام گروه</label>
        <input type="text" class="form-input" id="dmGroupTitle" maxlength="80" value="${escapeAttr(groupTitleDraft)}"
          oninput="app.onDmGroupTitleInput(this.value)" placeholder="مثلاً تیم فروش" />
      </div>
      <div class="form-group">
        <label>اعضا (${groupMemberDraft.size} نفر)</label>
        <input type="search" class="form-input" placeholder="جستجوی عضو…" value="${escapeAttr(groupMemberFilter)}"
          oninput="app.filterDmGroupMembers(this.value)" autocomplete="off" />
        <div class="dm-chat-member-list">${rows || '<div class="dm-chat-empty">کاربری نیست</div>'}</div>
      </div>
      <button type="button" class="btn btn-primary" style="width:100%" onclick="app.submitDmCreateGroup()">ایجاد گروه</button>
    </div>
  `
}

function renderChatBody() {
  const body = document.getElementById('dmChatBody')
  const composer = document.getElementById('dmChatComposer')
  const backBtn = document.getElementById('dmChatBackBtn')
  const title = document.getElementById('dmChatTitle')
  const tab = openTabs[activeTabIndex]
  if (!tab) {
    viewMode = 'list'
    renderListBody()
    return
  }
  if (composer) composer.hidden = false
  if (backBtn) backBtn.hidden = false
  if (title) title.textContent = tabLabel(tab)
  renderTabs()
  if (!body) return

  const me = myPhone()
  const msgs = messagesByConv.get(Number(tab.conversationId)) || []
  const bubbles = msgs.map(m => {
    const mine = normalizePhone(m.sender_phone) === me
    const sender = !mine && tab.kind === 'group'
      ? `<div class="dm-chat-bubble-sender">${escapeHtml(peerLabel(m.sender_phone))}</div>`
      : ''
    return `<div class="dm-chat-bubble${mine ? ' is-mine' : ''}">
      ${sender}
      <div class="dm-chat-bubble-text">${escapeHtml(m.body || '')}</div>
      <div class="dm-chat-bubble-time">${escapeHtml(formatMsgTime(m.created_at))}</div>
    </div>`
  }).join('')

  body.innerHTML = `
    <div class="dm-chat-messages" id="dmChatMessages">
      ${bubbles || '<div class="dm-chat-empty">اولین پیام را بفرستید</div>'}
    </div>
  `
  const scroller = document.getElementById('dmChatMessages')
  if (scroller) scroller.scrollTop = scroller.scrollHeight
}

function renderPanel() {
  if (viewMode === 'chat') renderChatBody()
  else if (viewMode === 'create-group') renderCreateGroupBody()
  else renderListBody()
  syncViewportOffset()
}

function appendMessageLocal(msg) {
  const cid = Number(msg.conversation_id)
  const list = messagesByConv.get(cid) || []
  if (list.some(m => Number(m.id) === Number(msg.id))) return false
  list.push(msg)
  messagesByConv.set(cid, list)
  const conv = conversations.find(c => Number(c.id) === cid)
  if (conv) {
    conv.last_message_at = msg.created_at
    conversations = [conv, ...conversations.filter(c => Number(c.id) !== cid)]
  }
  return true
}

function isMemberLocal(cid, me = myPhone()) {
  return conversations.some(c => Number(c.id) === Number(cid))
}

async function handleIncomingMessage(msg) {
  const me = myPhone()
  if (!me || !msg) return
  const cid = Number(msg.conversation_id)
  const sender = normalizePhone(msg.sender_phone)

  if (!isMemberLocal(cid, me)) {
    await loadConversations()
  }
  if (!isMemberLocal(cid, me)) return

  const added = appendMessageLocal(msg)
  if (!added) return

  if (sender !== me) {
    if (isActiveConversation(cid)) {
      await markConversationRead(cid)
    } else {
      unreadByConv.set(cid, (unreadByConv.get(cid) || 0) + 1)
      updateBadge()
      playNotifSound()
    }
  }

  if (panelOpen) renderPanel()
}

async function subscribeRealtime() {
  if (channel) {
    try { await supabase.removeChannel(channel) } catch (_) { /* ignore */ }
    channel = null
  }
  channel = supabase
    .channel(CHANNEL_NAME)
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'dm_messages' }, (payload) => {
      handleIncomingMessage(payload.new).catch(e => console.error('dm realtime handler:', e))
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'dm_pins' }, () => {
      loadPins().then(() => { if (panelOpen && viewMode === 'list') renderListBody() }).catch(() => {})
    })
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'dm_members' }, (payload) => {
      const row = payload.new
      if (normalizePhone(row?.user_phone) === myPhone()) {
        loadConversations().then(() => refreshUnreadCounts()).then(() => {
          if (panelOpen && viewMode === 'list') renderListBody()
        }).catch(() => {})
      }
    })
    .subscribe((status) => {
      if (status === 'CHANNEL_ERROR') console.warn('dm-chat realtime channel error')
    })
}

function openConversationTab(conv) {
  const cid = Number(conv.id)
  const kind = convKind(conv)
  const tab = {
    conversationId: cid,
    kind,
    title: conv.title || '',
    peerPhone: kind === 'dm' ? peerPhoneOf(conv) : ''
  }
  let idx = openTabs.findIndex(t => Number(t.conversationId) === cid)
  if (idx < 0) {
    if (openTabs.length >= MAX_OPEN_TABS) openTabs.shift()
    openTabs.push(tab)
    idx = openTabs.length - 1
  } else {
    openTabs[idx] = { ...openTabs[idx], ...tab }
  }
  activeTabIndex = idx
  viewMode = 'chat'
  panelOpen = true
  const panel = panelEl()
  if (panel) panel.hidden = false
  rootEl()?.classList.add('is-open')
  setBodyChatOpen(true)
  startHeartbeat()
  return cid
}

export async function openDmChatWith(peerPhoneRaw) {
  const peer = normalizePhone(peerPhoneRaw)
  const me = myPhone()
  if (!me || !peer) {
    showToast('کاربر نامعتبر است')
    return
  }
  if (peer === me) {
    showToast('نمی‌توانید با خودتان چت کنید')
    return
  }

  try {
    const conv = await getOrCreateConversation(peer)
    const cid = Number(conv.id)
    if (!conversations.some(c => Number(c.id) === cid)) {
      conversations = [conv, ...conversations]
    }
    openConversationTab(conv)
    await loadMessages(cid)
    await markConversationRead(cid)
    renderPanel()
    document.getElementById('dmChatInput')?.focus()
  } catch (e) {
    console.error('openDmChatWith:', e)
    showToast('خطا در باز کردن گفتگو')
  }
}

export async function openDmChatConversation(conversationId) {
  const cid = Number(conversationId)
  let conv = conversations.find(c => Number(c.id) === cid)
  if (!conv) {
    const { data } = await supabase.from('dm_conversations').select('*').eq('id', cid).maybeSingle()
    conv = data
    if (conv) conversations = [conv, ...conversations]
  }
  if (!conv) {
    showToast('گفتگو یافت نشد')
    return
  }
  try {
    openConversationTab(conv)
    await loadMessages(cid)
    await markConversationRead(cid)
    renderPanel()
    document.getElementById('dmChatInput')?.focus()
  } catch (e) {
    console.error('openDmChatConversation:', e)
    showToast('خطا در باز کردن گفتگو')
  }
}

export function selectDmChatTab(index) {
  const i = Number(index)
  if (i < 0 || i >= openTabs.length) return
  flushHeartbeat().catch(() => {})
  activeTabIndex = i
  viewMode = 'chat'
  const tab = openTabs[i]
  loadMessages(tab.conversationId)
    .then(() => markConversationRead(tab.conversationId))
    .then(() => renderPanel())
    .catch(e => console.error(e))
}

export function closeDmChatTab(index) {
  const i = Number(index)
  if (i < 0 || i >= openTabs.length) return
  if (i === activeTabIndex) flushHeartbeat().catch(() => {})
  openTabs.splice(i, 1)
  if (!openTabs.length) {
    activeTabIndex = -1
    viewMode = 'list'
    renderPanel()
    return
  }
  if (activeTabIndex >= openTabs.length) activeTabIndex = openTabs.length - 1
  else if (activeTabIndex > i) activeTabIndex -= 1
  else if (activeTabIndex === i && activeTabIndex >= openTabs.length) {
    activeTabIndex = openTabs.length - 1
  }
  const tab = openTabs[activeTabIndex]
  viewMode = 'chat'
  loadMessages(tab.conversationId)
    .then(() => markConversationRead(tab.conversationId))
    .then(() => renderPanel())
    .catch(e => console.error(e))
}

export function backToDmChatList() {
  flushHeartbeat().catch(() => {})
  viewMode = 'list'
  renderPanel()
}

export function filterDmChatContacts(value) {
  contactFilter = String(value || '')
  if (viewMode === 'list') renderListBody()
}

export function openDmCreateGroup() {
  if (!isMainAdmin()) {
    showToast('فقط ادمین اصلی می‌تواند گروه بسازد')
    return
  }
  groupTitleDraft = ''
  groupMemberDraft = new Set()
  groupMemberFilter = ''
  viewMode = 'create-group'
  renderPanel()
}

export function onDmGroupTitleInput(value) {
  groupTitleDraft = String(value || '')
}

export function filterDmGroupMembers(value) {
  groupMemberFilter = String(value || '')
  if (viewMode === 'create-group') renderCreateGroupBody()
}

export function toggleDmGroupMember(phone, checked) {
  const p = normalizePhone(phone)
  if (!p) return
  if (checked) groupMemberDraft.add(p)
  else groupMemberDraft.delete(p)
  if (viewMode === 'create-group') {
    const countLabel = document.querySelector('.dm-chat-create-group label')
    // re-render to refresh count is lighter via partial — full re-render ok
    renderCreateGroupBody()
  }
}

export async function submitDmCreateGroup() {
  if (!isMainAdmin()) return
  const me = myPhone()
  const title = groupTitleDraft.trim()
  if (!title) {
    showToast('نام گروه را وارد کنید')
    return
  }
  if (!groupMemberDraft.size) {
    showToast('حداقل یک عضو انتخاب کنید')
    return
  }
  try {
    const { data: conv, error } = await supabase
      .from('dm_conversations')
      .insert({
        kind: 'group',
        title,
        created_by_phone: me,
        phone_a: null,
        phone_b: null
      })
      .select('*')
      .single()
    if (error) throw error
    const members = [...groupMemberDraft, me].filter(Boolean)
    const rows = [...new Set(members)].map(user_phone => ({
      conversation_id: Number(conv.id),
      user_phone
    }))
    const { error: memErr } = await supabase.from('dm_members').upsert(rows, { onConflict: 'conversation_id,user_phone' })
    if (memErr) throw memErr
    conversations = [conv, ...conversations]
    showToast('گروه ایجاد شد')
    await openDmChatConversation(conv.id)
  } catch (e) {
    console.error('submitDmCreateGroup:', e)
    showToast('ایجاد گروه ناموفق بود')
  }
}

export async function toggleDmChatPin(conversationId, scope) {
  const cid = Number(conversationId)
  const me = myPhone()
  if (!cid || !me) return
  if (scope === 'global' && !isMainAdmin()) {
    showToast('فقط ادمین اصلی می‌تواند پین سراسری بگذارد')
    return
  }
  try {
    if (scope === 'global') {
      if (globalPins.has(cid)) {
        const { error } = await supabase.from('dm_pins').delete().eq('conversation_id', cid).eq('scope', 'global')
        if (error) throw error
        globalPins.delete(cid)
      } else {
        const { error } = await supabase.from('dm_pins').insert({
          conversation_id: cid,
          scope: 'global',
          user_phone: null,
          pinned_by_phone: me
        })
        if (error) throw error
        globalPins.add(cid)
      }
    } else {
      if (personalPins.has(cid)) {
        const { error } = await supabase
          .from('dm_pins')
          .delete()
          .eq('conversation_id', cid)
          .eq('scope', 'personal')
          .eq('user_phone', me)
        if (error) throw error
        personalPins.delete(cid)
      } else {
        const { error } = await supabase.from('dm_pins').insert({
          conversation_id: cid,
          scope: 'personal',
          user_phone: me,
          pinned_by_phone: me
        })
        if (error) throw error
        personalPins.add(cid)
      }
    }
    if (viewMode === 'list') renderListBody()
  } catch (e) {
    console.error('toggleDmChatPin:', e)
    showToast('خطا در پین')
  }
}

export async function sendDmChatMessage() {
  if (sending) return
  const tab = openTabs[activeTabIndex]
  if (!tab || viewMode !== 'chat') return
  const input = document.getElementById('dmChatInput')
  const body = String(input?.value || '').trim()
  if (!body) return
  const me = myPhone()
  if (!me) return

  sending = true
  try {
    const { data, error } = await supabase
      .from('dm_messages')
      .insert({
        conversation_id: Number(tab.conversationId),
        sender_phone: me,
        body
      })
      .select('*')
      .single()
    if (error) throw error
    if (input) input.value = ''
    appendMessageLocal(data)
    await markConversationRead(tab.conversationId)
    renderPanel()
    input?.focus()
  } catch (e) {
    console.error('sendDmChatMessage:', e)
    showToast('ارسال پیام ناموفق بود')
  } finally {
    sending = false
  }
}

export function onDmChatInputKeydown(event) {
  if (!event) return
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault()
    sendDmChatMessage()
  }
}

export function toggleDmChatPanel() {
  if (panelOpen) closeDmChatPanel()
  else openDmChatPanel()
}

export async function openDmChatPanel() {
  panelOpen = true
  const panel = panelEl()
  if (panel) panel.hidden = false
  rootEl()?.classList.add('is-open')
  setBodyChatOpen(true)
  startHeartbeat()
  if (viewMode === 'chat' && openTabs[activeTabIndex]) {
    await loadMessages(openTabs[activeTabIndex].conversationId)
    await markConversationRead(openTabs[activeTabIndex].conversationId)
  } else if (viewMode !== 'create-group') {
    viewMode = 'list'
    await refreshUsersMap()
    await loadConversations()
    await loadPins()
    await loadReads()
    await refreshUnreadCounts()
  }
  renderPanel()
}

export function closeDmChatPanel() {
  flushHeartbeat().catch(() => {})
  stopHeartbeat()
  panelOpen = false
  const panel = panelEl()
  if (panel) {
    panel.hidden = true
    panel.style.maxHeight = ''
  }
  rootEl()?.classList.remove('is-open')
  setBodyChatOpen(false)
}

function bindChrome() {
  if (!escapeHandler) {
    escapeHandler = (e) => {
      if (e.key === 'Escape' && panelOpen) closeDmChatPanel()
    }
    document.addEventListener('keydown', escapeHandler)
  }
  if (!visibilityHandler) {
    visibilityHandler = () => {
      if (document.visibilityState !== 'visible') flushHeartbeat().catch(() => {})
    }
    document.addEventListener('visibilitychange', visibilityHandler)
  }
  if (!viewportHandler && window.visualViewport) {
    viewportHandler = () => syncViewportOffset()
    window.visualViewport.addEventListener('resize', viewportHandler)
    window.visualViewport.addEventListener('scroll', viewportHandler)
  }
}

export async function initDmChat() {
  if (started) return
  const root = rootEl()
  if (!root) return
  if (!getCurrentUser()?.phone) return

  started = true
  root.hidden = false
  bindChrome()

  await refreshUsersMap()
  await loadConversations()
  await loadPins()
  await loadReads()
  await refreshUnreadCounts()
  await subscribeRealtime()
  updateBadge()
}

export function teardownDmChat() {
  flushHeartbeat().catch(() => {})
  closeDmChatPanel()
  stopHeartbeat()
  if (channel) {
    supabase.removeChannel(channel).catch(() => {})
    channel = null
  }
  if (escapeHandler) {
    document.removeEventListener('keydown', escapeHandler)
    escapeHandler = null
  }
  if (visibilityHandler) {
    document.removeEventListener('visibilitychange', visibilityHandler)
    visibilityHandler = null
  }
  if (viewportHandler && window.visualViewport) {
    window.visualViewport.removeEventListener('resize', viewportHandler)
    window.visualViewport.removeEventListener('scroll', viewportHandler)
    viewportHandler = null
  }
  started = false
  openTabs = []
  activeTabIndex = -1
  conversations = []
  messagesByConv.clear()
  readsByConv.clear()
  unreadByConv.clear()
  personalPins.clear()
  globalPins.clear()
  updateBadge()
  const root = rootEl()
  if (root) root.hidden = true
}
