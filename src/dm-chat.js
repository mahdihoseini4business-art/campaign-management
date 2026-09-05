// ============================================
// Private DM chat widget (bottom-left FAB + panel)
// ============================================

import { supabase } from './supabase.js'
import { getUsersSafe } from './auth.js'
import {
  escapeHtml,
  escapeAttr,
  getCurrentUser,
  normalizePhone,
  userDisplayName,
  showToast
} from './utils.js'

const CHANNEL_NAME = 'dm-chat-live'
const NOTIF_SOUND_URL = '/notif.mp3'
const MESSAGE_PAGE = 80
const MAX_OPEN_TABS = 6

/** @type {import('@supabase/supabase-js').RealtimeChannel | null} */
let channel = null
let started = false
let panelOpen = false
/** @type {'list' | 'chat'} */
let viewMode = 'list'
/** @type {{ conversationId: number, peerPhone: string }[]} */
let openTabs = []
let activeTabIndex = -1
/** @type {any[]} */
let conversations = []
/** @type {Map<number, any[]>} */
const messagesByConv = new Map()
/** @type {Map<number, number>} last_read_message_id by conversation */
const readsByConv = new Map()
/** @type {Map<number, number>} unread count by conversation */
const unreadByConv = new Map()
/** @type {Map<string, any>} */
let usersByPhone = new Map()
let contactFilter = ''
let sending = false
let escapeHandler = null

function myPhone() {
  return normalizePhone(getCurrentUser()?.phone)
}

function orderedPhones(a, b) {
  const pa = normalizePhone(a)
  const pb = normalizePhone(b)
  if (!pa || !pb) return null
  return pa < pb ? [pa, pb] : [pb, pa]
}

function peerPhoneOf(conv, me = myPhone()) {
  if (!conv || !me) return ''
  const a = normalizePhone(conv.phone_a)
  const b = normalizePhone(conv.phone_b)
  return a === me ? b : a
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

async function getOrCreateConversation(peerPhone) {
  const me = myPhone()
  const ordered = orderedPhones(me, peerPhone)
  if (!ordered) throw new Error('شماره نامعتبر')
  const [phone_a, phone_b] = ordered
  if (phone_a === phone_b) throw new Error('نمی‌توانید با خودتان چت کنید')

  const { data: existing, error: selErr } = await supabase
    .from('dm_conversations')
    .select('*')
    .eq('phone_a', phone_a)
    .eq('phone_b', phone_b)
    .maybeSingle()
  if (selErr) throw selErr
  if (existing) return existing

  const { data: created, error: insErr } = await supabase
    .from('dm_conversations')
    .insert({ phone_a, phone_b })
    .select('*')
    .single()
  if (insErr) {
    // race: unique conflict — re-select
    const { data: again, error: againErr } = await supabase
      .from('dm_conversations')
      .select('*')
      .eq('phone_a', phone_a)
      .eq('phone_b', phone_b)
      .maybeSingle()
    if (again) return again
    throw againErr || insErr
  }
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
      <span class="dm-chat-tab-label">${escapeHtml(peerLabel(tab.peerPhone))}</span>
      ${badge}
      <span class="dm-chat-tab-close" onclick="event.stopPropagation(); app.closeDmChatTab(${i})" title="بستن" aria-label="بستن">&times;</span>
    </button>`
  }).join('')
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
  const peersFromConvs = new Set(conversations.map(c => peerPhoneOf(c, me)))

  const convItems = conversations.map(c => {
    const peer = peerPhoneOf(c, me)
    const name = peerLabel(peer)
    const unread = unreadByConv.get(Number(c.id)) || 0
    if (q && !name.toLowerCase().includes(q) && !peer.includes(q)) return ''
    return `<button type="button" class="dm-chat-row" onclick="app.openDmChatWith('${escapeAttr(peer)}')">
      <div class="dm-chat-row-main">
        <span class="dm-chat-row-name">${escapeHtml(name)}</span>
        <span class="dm-chat-row-meta">${escapeHtml(formatMsgTime(c.last_message_at))}</span>
      </div>
      ${unread > 0 ? `<span class="dm-chat-row-badge">${unread > 99 ? '99+' : unread}</span>` : ''}
    </button>`
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

  body.innerHTML = `
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
  if (title) title.textContent = peerLabel(tab.peerPhone)
  renderTabs()
  if (!body) return

  const me = myPhone()
  const msgs = messagesByConv.get(Number(tab.conversationId)) || []
  const bubbles = msgs.map(m => {
    const mine = normalizePhone(m.sender_phone) === me
    return `<div class="dm-chat-bubble${mine ? ' is-mine' : ''}">
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
  else renderListBody()
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

async function handleIncomingMessage(msg) {
  const me = myPhone()
  if (!me || !msg) return
  const cid = Number(msg.conversation_id)
  const sender = normalizePhone(msg.sender_phone)

  // Ensure conversation is in local list
  if (!conversations.some(c => Number(c.id) === cid)) {
    await loadConversations()
  }

  const isParticipant = conversations.some(c => {
    if (Number(c.id) !== cid) return false
    return normalizePhone(c.phone_a) === me || normalizePhone(c.phone_b) === me
  })
  if (!isParticipant) return

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
    .subscribe((status) => {
      if (status === 'CHANNEL_ERROR') console.warn('dm-chat realtime channel error')
    })
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

    let idx = openTabs.findIndex(t => Number(t.conversationId) === cid)
    if (idx < 0) {
      if (openTabs.length >= MAX_OPEN_TABS) openTabs.shift()
      openTabs.push({ conversationId: cid, peerPhone: peer })
      idx = openTabs.length - 1
    }
    activeTabIndex = idx
    viewMode = 'chat'
    panelOpen = true
    const panel = panelEl()
    if (panel) panel.hidden = false
    rootEl()?.classList.add('is-open')

    await loadMessages(cid)
    await markConversationRead(cid)
    renderPanel()
    const input = document.getElementById('dmChatInput')
    input?.focus()
  } catch (e) {
    console.error('openDmChatWith:', e)
    showToast('خطا در باز کردن گفتگو')
  }
}

export function selectDmChatTab(index) {
  const i = Number(index)
  if (i < 0 || i >= openTabs.length) return
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
  openTabs.splice(i, 1)
  if (!openTabs.length) {
    activeTabIndex = -1
    viewMode = 'list'
    renderPanel()
    return
  }
  if (activeTabIndex >= openTabs.length) activeTabIndex = openTabs.length - 1
  else if (activeTabIndex > i) activeTabIndex -= 1
  else if (activeTabIndex === i) {
    // stay on same index (next tab) or previous
    if (activeTabIndex >= openTabs.length) activeTabIndex = openTabs.length - 1
  }
  const tab = openTabs[activeTabIndex]
  viewMode = 'chat'
  loadMessages(tab.conversationId)
    .then(() => markConversationRead(tab.conversationId))
    .then(() => renderPanel())
    .catch(e => console.error(e))
}

export function backToDmChatList() {
  viewMode = 'list'
  renderPanel()
}

export function filterDmChatContacts(value) {
  contactFilter = String(value || '')
  if (viewMode === 'list') renderListBody()
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
  if (viewMode === 'chat' && openTabs[activeTabIndex]) {
    await loadMessages(openTabs[activeTabIndex].conversationId)
    await markConversationRead(openTabs[activeTabIndex].conversationId)
  } else {
    viewMode = 'list'
    await refreshUsersMap()
    await loadConversations()
    await loadReads()
    await refreshUnreadCounts()
  }
  renderPanel()
}

export function closeDmChatPanel() {
  panelOpen = false
  const panel = panelEl()
  if (panel) panel.hidden = true
  rootEl()?.classList.remove('is-open')
}

function bindEscape() {
  if (escapeHandler) return
  escapeHandler = (e) => {
    if (e.key === 'Escape' && panelOpen) closeDmChatPanel()
  }
  document.addEventListener('keydown', escapeHandler)
}

export async function initDmChat() {
  if (started) return
  const root = rootEl()
  if (!root) return
  if (!getCurrentUser()?.phone) return

  started = true
  root.hidden = false
  bindEscape()

  await refreshUsersMap()
  await loadConversations()
  await loadReads()
  await refreshUnreadCounts()
  await subscribeRealtime()
  updateBadge()
}

export function teardownDmChat() {
  closeDmChatPanel()
  if (channel) {
    supabase.removeChannel(channel).catch(() => {})
    channel = null
  }
  if (escapeHandler) {
    document.removeEventListener('keydown', escapeHandler)
    escapeHandler = null
  }
  started = false
  openTabs = []
  activeTabIndex = -1
  conversations = []
  messagesByConv.clear()
  readsByConv.clear()
  unreadByConv.clear()
  updateBadge()
  const root = rootEl()
  if (root) root.hidden = true
}
