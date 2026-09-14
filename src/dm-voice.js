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
/** Bumped on every hard teardown and every sync resync; in-flight work checks this. */
let teardownToken = 0
/** Token of the sync attempt that currently owns module globals (0 = none). */
let sessionToken = 0
/** User wants mic open (pointer/key held). Cleared on release so in-flight startPtt aborts. */
let pttWanted = false
/** Invalidates in-flight startPtt when stop/release wins the race. */
let pttEpoch = 0
let pttStarting = false

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
    const blocked = peerTalking && !isTalking
    btn.toggleAttribute('aria-disabled', blocked)
    btn.classList.toggle('is-peer-talking', blocked)
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

/**
 * @param {import('@supabase/supabase-js').RealtimeChannel | null} ch
 * @param {number} conversationId
 * @param {string} event
 * @param {Record<string, unknown>} [extra]
 */
async function sendSignalOn(ch, conversationId, event, extra = {}) {
  if (!ch || !conversationId) return
  const from = myPhone()
  if (!from) return
  try {
    await ch.send({
      type: 'broadcast',
      event,
      payload: {
        conversationId,
        fromPhone: from,
        at: Date.now(),
        ...extra
      }
    })
  } catch (e) {
    console.error('dm-voice signal:', event, e)
  }
}

async function sendSignal(event, extra = {}) {
  await sendSignalOn(channel, activeConversationId, event, extra)
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
  // Only accept signals from the bound DM peer (not any other phone).
  if (!peerPhone || from !== peerPhone) return

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
    // Half-duplex: yield if we were transmitting
    if (isTalking || pttWanted) {
      pttWanted = false
      pttEpoch += 1
      if (isTalking) {
        isTalking = false
        setLocalMicEnabled(false)
        sendSignal('ptt-stop').catch(() => {})
      }
    }
    updateVoiceUi()
    return
  }
  if (event === 'ptt-stop' || event === 'voice-hangup') {
    peerTalking = false
    updateVoiceUi()
  }
}

async function safeRemoveChannel(ch) {
  if (!ch) return
  try { await supabase.removeChannel(ch) } catch (_) { /* ignore */ }
}

/**
 * Subscribe without assigning the module `channel` until the caller decides.
 * Rejects (and removes the channel) on CHANNEL_ERROR / TIMED_OUT.
 * @param {number} conversationId
 * @returns {Promise<import('@supabase/supabase-js').RealtimeChannel>}
 */
async function subscribeChannel(conversationId) {
  const ch = supabase.channel(channelName(conversationId), {
    config: { broadcast: { self: false } }
  })

  const events = ['voice-hello', 'voice-offer', 'voice-answer', 'voice-ice', 'ptt-start', 'ptt-stop', 'voice-hangup']
  for (const event of events) {
    ch.on('broadcast', { event }, (msg) => {
      handleSignal({ event, payload: msg.payload }).catch(e => console.error('dm-voice signal handler:', e))
    })
  }

  const status = await new Promise((resolve) => {
    ch.subscribe((next) => {
      if (next === 'SUBSCRIBED' || next === 'CHANNEL_ERROR' || next === 'TIMED_OUT') resolve(next)
    })
  })

  if (status !== 'SUBSCRIBED') {
    await safeRemoveChannel(ch)
    throw new Error(`dm-voice subscribe failed: ${status}`)
  }

  return ch
}

async function bootstrapConnection(token) {
  if (token !== teardownToken) return
  await createPeerConnection()
  if (token !== teardownToken) return
  try {
    await ensureLocalStream()
    if (token !== teardownToken) return
    attachLocalTracks()
  } catch (e) {
    // Mic permission can wait until first PTT
    console.warn('dm-voice mic deferred:', e?.message || e)
  }

  if (token !== teardownToken) return
  await sendSignal('voice-hello')

  if (token !== teardownToken) return
  // Impolite peer (smaller phone) creates the initial offer if media ready
  if (!polite && localStream && pc?.signalingState === 'stable') {
    await makeOffer()
  }
}

/**
 * Close only the captured resources. Safe if module globals already point at a newer session.
 * @param {{
 *   pc: RTCPeerConnection | null,
 *   channel: import('@supabase/supabase-js').RealtimeChannel | null,
 *   localStream: MediaStream | null,
 *   remoteAudio: HTMLAudioElement | null,
 *   conversationId: number,
 *   wasTalking: boolean
 * }} snap
 */
async function disposeSnapshot(snap) {
  if (snap.wasTalking) {
    try { await sendSignalOn(snap.channel, snap.conversationId, 'ptt-stop') } catch (_) { /* ignore */ }
  }
  try { await sendSignalOn(snap.channel, snap.conversationId, 'voice-hangup') } catch (_) { /* ignore */ }

  if (snap.pc) {
    try {
      snap.pc.onicecandidate = null
      snap.pc.ontrack = null
      snap.pc.onconnectionstatechange = null
      snap.pc.close()
    } catch (_) { /* ignore */ }
  }

  if (snap.localStream) {
    for (const t of snap.localStream.getTracks()) {
      try { t.stop() } catch (_) { /* ignore */ }
    }
  }

  if (snap.remoteAudio) {
    try {
      snap.remoteAudio.srcObject = null
      snap.remoteAudio.remove()
    } catch (_) { /* ignore */ }
  }

  await safeRemoveChannel(snap.channel)
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

  sessionToken = token
  activeConversationId = cid
  peerPhone = peer
  // Higher phone is polite (yields on glare); lower phone is the offerer
  polite = me > peer
  isTalking = false
  peerTalking = false
  connecting = true

  try {
    const ch = await subscribeChannel(cid)
    if (token !== teardownToken) {
      // Channel was never published to module — drop it; only soft-teardown if we still own.
      await safeRemoveChannel(ch)
      await abandonIfStillOwner(token)
      return
    }
    channel = ch

    await bootstrapConnection(token)
    if (token !== teardownToken) {
      await abandonIfStillOwner(token)
      return
    }
    updateVoiceUi()
  } catch (e) {
    console.error('syncDmVoiceForTab:', e)
    if (token === teardownToken) {
      showToast('اتصال واکی‌تاکی برقرار نشد')
      await abandonIfStillOwner(token)
      syncDmVoiceComposerVisibility(false)
    }
  } finally {
    if (token === teardownToken) connecting = false
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
  if (!activeConversationId || !myPhone()) return
  if (peerTalking) {
    showToast('صبر کنید تا طرف مقابل صحبتش تمام شود')
    return
  }
  if (isTalking || pttStarting) return

  pttWanted = true
  const epoch = ++pttEpoch
  pttStarting = true

  try {
    await ensureLocalStream()
    if (!pttWanted || epoch !== pttEpoch) {
      setLocalMicEnabled(false)
      return
    }

    await createPeerConnection()
    attachLocalTracks()

    // Resume remote playback under this user gesture (autoplay policies)
    if (remoteAudio?.srcObject) {
      remoteAudio.play().catch(() => {})
    }

    if (!pttWanted || epoch !== pttEpoch) {
      setLocalMicEnabled(false)
      return
    }

    if (pc && !pc.currentRemoteDescription) {
      await sendSignal('voice-hello')
      if (!pttWanted || epoch !== pttEpoch) {
        setLocalMicEnabled(false)
        return
      }
      if (!polite && pc.signalingState === 'stable') {
        await makeOffer()
      }
    }

    if (!pttWanted || epoch !== pttEpoch || peerTalking) {
      setLocalMicEnabled(false)
      return
    }

    setLocalMicEnabled(true)
    isTalking = true
    updateVoiceUi()
    await sendSignal('ptt-start')

    // Released while ptt-start was in flight — shut mic back off
    if (!pttWanted || epoch !== pttEpoch) {
      isTalking = false
      setLocalMicEnabled(false)
      updateVoiceUi()
      await sendSignal('ptt-stop')
    }
  } catch (e) {
    console.error('startPtt:', e)
    const denied = e?.name === 'NotAllowedError' || e?.name === 'PermissionDeniedError'
    showToast(denied ? 'دسترسی میکروفون رد شد' : 'شروع واکی‌تاکی ناموفق بود')
    isTalking = false
    setLocalMicEnabled(false)
    updateVoiceUi()
  } finally {
    if (epoch === pttEpoch) pttStarting = false
  }
}

export async function stopPtt() {
  pttWanted = false
  pttEpoch += 1
  pttStarting = false

  if (!isTalking) {
    setLocalMicEnabled(false)
    return
  }
  isTalking = false
  setLocalMicEnabled(false)
  updateVoiceUi()
  await sendSignal('ptt-stop')
}

function isPttHoldKey(event) {
  return event.key === ' ' || event.key === 'Spacebar'
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

/** Space hold-to-talk on the PTT button (ignore key repeat). */
export function onDmVoicePttKeyDown(event) {
  if (!event || !isPttHoldKey(event)) return
  if (event.repeat) return
  event.preventDefault()
  startPtt().catch(() => {})
}

export function onDmVoicePttKeyUp(event) {
  if (!event || !isPttHoldKey(event)) return
  event.preventDefault()
  stopPtt().catch(() => {})
}

/**
 * @param {{ soft?: boolean }} [opts]
 * soft=true: used by resync; does not bump teardownToken (caller already did) and does not hide the PTT button.
 */
export async function teardownDmVoice(opts = {}) {
  const soft = !!opts.soft
  if (!soft) teardownToken += 1
  const myToken = teardownToken

  const snap = {
    pc,
    channel,
    localStream,
    remoteAudio,
    conversationId: activeConversationId,
    wasTalking: isTalking
  }

  // Detach immediately so a concurrent sync can own new globals without this
  // teardown closing them later.
  if (pc === snap.pc) pc = null
  if (channel === snap.channel) channel = null
  if (localStream === snap.localStream) localStream = null
  if (remoteAudio === snap.remoteAudio) remoteAudio = null

  sessionToken = 0
  isTalking = false
  peerTalking = false
  pttWanted = false
  pttEpoch += 1
  pttStarting = false
  activeConversationId = 0
  peerPhone = ''
  polite = false
  makingOffer = false
  ignoreOffer = false
  connecting = false

  await disposeSnapshot(snap)

  // A newer session took over while we were disposing — leave its UI alone.
  if (myToken !== teardownToken) return

  updateVoiceUi()
  if (!soft) syncDmVoiceComposerVisibility(false)
}

/**
 * If this aborted sync still owns module globals, dispose them.
 * Also cleans orphans recreated after a hard teardown cleared ownership.
 * @param {number} token
 */
async function abandonIfStillOwner(token) {
  if (sessionToken === token) {
    await teardownDmVoice({ soft: true })
    return
  }
  if (
    sessionToken === 0 &&
    token !== teardownToken &&
    (pc || channel || localStream || remoteAudio)
  ) {
    await teardownDmVoice({ soft: true })
  }
}

export function getDmVoiceActiveConversationId() {
  return activeConversationId
}
