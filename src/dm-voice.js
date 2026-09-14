// ============================================
// DM walkie-talkie (WebRTC audio + Realtime broadcast signaling)
// Ephemeral only — nothing is written to dm_messages / DB.
// ============================================

import { supabase } from './supabase.js'
import { getCurrentUser, normalizePhone, showToast, userDisplayName } from './utils.js'
import { getUsersSafe } from './auth.js'

const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }]

/** @type {import('@supabase/supabase-js').RealtimeChannel | null} */
let channel = null
/** @type {RTCPeerConnection | null} */
let pc = null
/** @type {MediaStream | null} */
let localStream = null
/** @type {HTMLAudioElement | null} */
let remoteAudio = null

let activeConversationId = 0
let peerPhone = ''
let polite = false
let makingOffer = false
let ignoreOffer = false
let isTalking = false
let peerTalking = false
let connecting = false
let teardownToken = 0

function myPhone() {
  return normalizePhone(getCurrentUser()?.phone)
}

function channelName(conversationId) {
  return `dm-voice-${Number(conversationId)}`
}

function ensureRemoteAudio() {
  if (remoteAudio) return remoteAudio
  const el = document.createElement('audio')
  el.autoplay = true
  el.playsInline = true
  el.setAttribute('aria-hidden', 'true')
  el.style.display = 'none'
  document.body.appendChild(el)
  remoteAudio = el
  return el
}

function setLocalMicEnabled(enabled) {
  if (!localStream) return
  for (const track of localStream.getAudioTracks()) {
    track.enabled = !!enabled
  }
}

function updateVoiceUi() {
  const btn = document.getElementById('dmChatPttBtn')
  if (btn) {
    btn.classList.toggle('is-talking', isTalking)
    btn.setAttribute('aria-pressed', isTalking ? 'true' : 'false')
  }
  const status = document.getElementById('dmChatVoiceStatus')
  if (!status) return
  if (peerTalking) {
    const users = getUsersSafe()
    const peer = users.find(u => normalizePhone(u.phone) === peerPhone)
    const label = peer ? userDisplayName(peer) : peerPhone
    status.hidden = false
    status.textContent = `${label} در حال صحبت…`
  } else if (isTalking) {
    status.hidden = false
    status.textContent = 'شما در حال صحبت…'
  } else {
    status.hidden = true
    status.textContent = ''
  }
}

async function sendSignal(event, extra = {}) {
  if (!channel || !activeConversationId) return
  const from = myPhone()
  if (!from) return
  try {
    await channel.send({
      type: 'broadcast',
      event,
      payload: {
        conversationId: activeConversationId,
        fromPhone: from,
        at: Date.now(),
        ...extra
      }
    })
  } catch (e) {
    console.error('dm-voice signal:', event, e)
  }
}

async function ensureLocalStream() {
  if (localStream) return localStream
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('getUserMedia unsupported')
  }
  localStream = await navigator.mediaDevices.getUserMedia({
    audio: true,
    video: false
  })
  // Start muted until push-to-talk
  setLocalMicEnabled(false)
  return localStream
}

function attachLocalTracks() {
  if (!pc || !localStream) return
  const existing = new Set(pc.getSenders().map(s => s.track).filter(Boolean))
  for (const track of localStream.getTracks()) {
    if (!existing.has(track)) pc.addTrack(track, localStream)
  }
}

async function createPeerConnection() {
  if (pc) return pc
  pc = new RTCPeerConnection({ iceServers: ICE_SERVERS })

  pc.onicecandidate = (ev) => {
    if (!ev.candidate) return
    sendSignal('voice-ice', { candidate: ev.candidate.toJSON() }).catch(() => {})
  }

  pc.ontrack = (ev) => {
    const audio = ensureRemoteAudio()
    const stream = ev.streams?.[0] || new MediaStream([ev.track])
    audio.srcObject = stream
    audio.play().catch(() => {})
  }

  pc.onconnectionstatechange = () => {
    if (!pc) return
    if (pc.connectionState === 'failed') {
      console.warn('dm-voice connection failed')
    }
  }

  return pc
}

async function makeOffer() {
  if (!pc || makingOffer) return
  makingOffer = true
  try {
    const offer = await pc.createOffer()
    await pc.setLocalDescription(offer)
    await sendSignal('voice-offer', { sdp: pc.localDescription })
  } finally {
    makingOffer = false
  }
}

async function handleOffer(payload) {
  if (!pc || !payload?.sdp) return
  const offerCollision = makingOffer || pc.signalingState !== 'stable'
  ignoreOffer = !polite && offerCollision
  if (ignoreOffer) return

  try {
    await ensureLocalStream()
    attachLocalTracks()
    await pc.setRemoteDescription(payload.sdp)
    const answer = await pc.createAnswer()
    await pc.setLocalDescription(answer)
    await sendSignal('voice-answer', { sdp: pc.localDescription })
  } catch (e) {
    console.error('dm-voice handleOffer:', e)
  }
}

async function handleAnswer(payload) {
  if (!pc || !payload?.sdp) return
  try {
    if (pc.signalingState === 'have-local-offer') {
      await pc.setRemoteDescription(payload.sdp)
    }
  } catch (e) {
    console.error('dm-voice handleAnswer:', e)
  }
}

async function handleIce(payload) {
  if (!pc || !payload?.candidate) return
  try {
    await pc.addIceCandidate(payload.candidate)
  } catch (e) {
    if (!ignoreOffer) console.error('dm-voice ice:', e)
  }
}

async function handleSignal({ event, payload }) {
  if (!payload) return
  const cid = Number(payload.conversationId)
  if (cid !== activeConversationId) return
  const from = normalizePhone(payload.fromPhone)
  const me = myPhone()
  if (!from || from === me) return

  if (event === 'voice-hello') {
    // Lexicographically smaller phone initiates the offer (impolite = offerer)
    if (!polite && pc && pc.signalingState === 'stable') {
      try {
        await ensureLocalStream()
        attachLocalTracks()
        await makeOffer()
      } catch (e) {
        console.error('dm-voice hello offer:', e)
      }
    }
    return
  }

  if (event === 'voice-offer') {
    await handleOffer(payload)
    return
  }
  if (event === 'voice-answer') {
    await handleAnswer(payload)
    return
  }
  if (event === 'voice-ice') {
    await handleIce(payload)
    return
  }
  if (event === 'ptt-start') {
    peerTalking = true
    updateVoiceUi()
    return
  }
  if (event === 'ptt-stop' || event === 'voice-hangup') {
    peerTalking = false
    updateVoiceUi()
  }
}

async function subscribeChannel(conversationId) {
  if (channel) {
    try { await supabase.removeChannel(channel) } catch (_) { /* ignore */ }
    channel = null
  }

  const ch = supabase.channel(channelName(conversationId), {
    config: { broadcast: { self: false } }
  })

  const events = ['voice-hello', 'voice-offer', 'voice-answer', 'voice-ice', 'ptt-start', 'ptt-stop', 'voice-hangup']
  for (const event of events) {
    ch.on('broadcast', { event }, (msg) => {
      handleSignal({ event, payload: msg.payload }).catch(e => console.error('dm-voice signal handler:', e))
    })
  }

  await new Promise((resolve) => {
    ch.subscribe((status) => {
      if (status === 'SUBSCRIBED' || status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') resolve(status)
    })
  })

  channel = ch
  return ch
}

async function bootstrapConnection() {
  await createPeerConnection()
  try {
    await ensureLocalStream()
    attachLocalTracks()
  } catch (e) {
    // Mic permission can wait until first PTT
    console.warn('dm-voice mic deferred:', e?.message || e)
  }

  await sendSignal('voice-hello')

  // Impolite peer (smaller phone) creates the initial offer if media ready
  if (!polite && localStream && pc?.signalingState === 'stable') {
    await makeOffer()
  }
}

/**
 * Bind walkie-talkie to the active DM tab (or tear down if not a DM).
 * @param {{ conversationId?: number, peerPhone?: string, enabled?: boolean }} opts
 */
export async function syncDmVoiceForTab(opts = {}) {
  const enabled = !!opts.enabled
  const cid = Number(opts.conversationId) || 0
  const peer = normalizePhone(opts.peerPhone)
  const me = myPhone()

  if (!enabled || !cid || !peer || !me || peer === me) {
    await teardownDmVoice()
    syncDmVoiceComposerVisibility(false)
    return
  }

  syncDmVoiceComposerVisibility(true)

  if (activeConversationId === cid && peerPhone === peer && channel && pc) {
    updateVoiceUi()
    return
  }

  const token = ++teardownToken
  await teardownDmVoice({ soft: true })
  if (token !== teardownToken) return

  activeConversationId = cid
  peerPhone = peer
  // Higher phone is polite (yields on glare); lower phone is the offerer
  polite = me > peer
  isTalking = false
  peerTalking = false
  connecting = true

  try {
    await subscribeChannel(cid)
    if (token !== teardownToken) return
    await bootstrapConnection()
    updateVoiceUi()
  } catch (e) {
    console.error('syncDmVoiceForTab:', e)
    showToast('اتصال واکی‌تاکی برقرار نشد')
  } finally {
    connecting = false
  }
}

export function syncDmVoiceComposerVisibility(visible) {
  const btn = document.getElementById('dmChatPttBtn')
  const status = document.getElementById('dmChatVoiceStatus')
  if (btn) btn.hidden = !visible
  if (status && !visible) {
    status.hidden = true
    status.textContent = ''
  }
}

export async function startPtt() {
  if (!activeConversationId || isTalking) return
  if (!myPhone()) return

  try {
    await ensureLocalStream()
    await createPeerConnection()
    attachLocalTracks()

    // Resume remote playback under this user gesture (autoplay policies)
    if (remoteAudio?.srcObject) {
      remoteAudio.play().catch(() => {})
    }

    if (pc && !pc.currentRemoteDescription) {
      await sendSignal('voice-hello')
      if (!polite && pc.signalingState === 'stable') {
        await makeOffer()
      }
    }

    setLocalMicEnabled(true)
    isTalking = true
    updateVoiceUi()
    await sendSignal('ptt-start')
  } catch (e) {
    console.error('startPtt:', e)
    const denied = e?.name === 'NotAllowedError' || e?.name === 'PermissionDeniedError'
    showToast(denied ? 'دسترسی میکروفون رد شد' : 'شروع واکی‌تاکی ناموفق بود')
    isTalking = false
    setLocalMicEnabled(false)
    updateVoiceUi()
  }
}

export async function stopPtt() {
  if (!isTalking) return
  isTalking = false
  setLocalMicEnabled(false)
  updateVoiceUi()
  await sendSignal('ptt-stop')
}

export function onDmVoicePttDown(event) {
  if (event) {
    event.preventDefault()
    try {
      event.currentTarget?.setPointerCapture?.(event.pointerId)
    } catch (_) { /* ignore */ }
  }
  startPtt().catch(() => {})
}

export function onDmVoicePttUp(event) {
  if (event) {
    event.preventDefault()
    try {
      if (event.currentTarget?.hasPointerCapture?.(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId)
      }
    } catch (_) { /* ignore */ }
  }
  stopPtt().catch(() => {})
}

/**
 * @param {{ soft?: boolean }} [opts] soft=true skips incrementing teardown token (used by resync)
 */
export async function teardownDmVoice(opts = {}) {
  if (!opts.soft) teardownToken += 1

  if (isTalking) {
    isTalking = false
    try { await sendSignal('ptt-stop') } catch (_) { /* ignore */ }
  }
  peerTalking = false

  try { await sendSignal('voice-hangup') } catch (_) { /* ignore */ }

  if (pc) {
    try { pc.onicecandidate = null; pc.ontrack = null; pc.close() } catch (_) { /* ignore */ }
    pc = null
  }

  if (localStream) {
    for (const t of localStream.getTracks()) {
      try { t.stop() } catch (_) { /* ignore */ }
    }
    localStream = null
  }

  if (remoteAudio) {
    try {
      remoteAudio.srcObject = null
      remoteAudio.remove()
    } catch (_) { /* ignore */ }
    remoteAudio = null
  }

  if (channel) {
    try { await supabase.removeChannel(channel) } catch (_) { /* ignore */ }
    channel = null
  }

  activeConversationId = 0
  peerPhone = ''
  polite = false
  makingOffer = false
  ignoreOffer = false
  connecting = false
  updateVoiceUi()
  syncDmVoiceComposerVisibility(false)
}

export function getDmVoiceActiveConversationId() {
  return activeConversationId
}
