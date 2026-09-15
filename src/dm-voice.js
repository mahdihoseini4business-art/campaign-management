// ============================================
// DM walkie-talkie (WebRTC audio + Realtime broadcast signaling)
// Ephemeral only — nothing is written to dm_messages / DB.
// ============================================

import { supabase } from './supabase.js'
import { getIceServers } from './config.js'
import { getCurrentUser, normalizePhone, showToast, userDisplayName } from './utils.js'
import { getUsersSafe } from './auth.js'

const PEER_TALKING_TTL_MS = 15000
const MAX_AUTO_RECOVER = 2
const BACKGROUND_TEARDOWN_MS = 60000
/** If ICE never reaches connected, surface failure instead of endless "connecting". */
const CONNECTING_TIMEOUT_MS = 12000
/** Re-send hello/offer while stuck connecting (late joiner / lost broadcast). */
const HANDSHAKE_RETRY_MS = 2500

/** @type {import('@supabase/supabase-js').RealtimeChannel | null} */
let channel = null
/** @type {RTCPeerConnection | null} */
let pc = null
/** @type {MediaStream | null} */
let localStream = null
/** @type {HTMLAudioElement | null} */
let remoteAudio = null
/** @type {RTCIceCandidateInit[]} */
let pendingIceCandidates = []

let activeConversationId = 0
let peerPhone = ''
let polite = false
let makingOffer = false
let isTalking = false
let peerTalking = false
/** @type {ReturnType<typeof setTimeout> | null} */
let peerTalkingTimer = null
let connecting = false
/** @type {'idle' | 'connecting' | 'connected' | 'failed'} */
let voiceLinkState = 'idle'
let recovering = false
let recoverAttempts = 0
/** @type {ReturnType<typeof setTimeout> | null} */
let connectingTimer = null
/** @type {ReturnType<typeof setInterval> | null} */
let handshakeTimer = null
/** Bumped on every hard teardown and every sync resync; in-flight work checks this. */
let teardownToken = 0
/** Token of the sync attempt that currently owns module globals (0 = none). */
let sessionToken = 0
/** User wants mic open (pointer/key held). Cleared on release so in-flight startPtt aborts. */
let pttWanted = false
/** Invalidates in-flight startPtt when stop/release wins the race. */
let pttEpoch = 0
let pttStarting = false
/** Remote audio.play() failed — need a user gesture. */
let needsAudioGesture = false
/** @type {ReturnType<typeof setTimeout> | null} */
let backgroundTeardownTimer = null
/** If makeOffer is busy, run again after it finishes (direction/track changes). */
let negotiationQueued = false
let negotiationIceRestart = false
/** Serialize handleOffer so duplicate/retried offers cannot race setLocalDescription. */
let handlingOffer = false
/** Personal ring channel — stays up while DM chat feature is enabled. */
/** @type {import('@supabase/supabase-js').RealtimeChannel | null} */
let inboxChannel = null
let lastRingAt = 0
/** Composer PTT visible (tab UI); false for background incoming sessions. */
let composerVisible = false

function myPhone() {
  return normalizePhone(getCurrentUser()?.phone)
}

function channelName(conversationId) {
  return `dm-voice-${Number(conversationId)}`
}

function ringChannelName(phone) {
  return `dm-voice-ring-${normalizePhone(phone)}`
}

function ensureRemoteAudio() {
  if (remoteAudio) return remoteAudio
  const el = document.createElement('audio')
  el.autoplay = true
  el.playsInline = true
  el.muted = false
  el.volume = 1
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

/** Ensure a recvonly audio transceiver so we can hear without grabbing the mic. */
function ensureRecvAudioTransceiver() {
  if (!pc) return
  if (pc.getTransceivers().length === 0) {
    try {
      pc.addTransceiver('audio', { direction: 'recvonly' })
    } catch (e) {
      console.warn('dm-voice recvonly transceiver:', e?.message || e)
    }
  }
}

/**
 * Attach mic tracks for send; prefer replaceTrack on existing audio transceiver.
 * Changing recvonly → sendrecv requires SDP renegotiation (caller must makeOffer).
 */
async function attachLocalTracks() {
  if (!pc || !localStream) return
  const audioTrack = localStream.getAudioTracks()[0]
  if (!audioTrack) return

  const audioTx = pc.getTransceivers().find(t =>
    t.receiver?.track?.kind === 'audio' ||
    t.sender?.track?.kind === 'audio' ||
    t.direction === 'recvonly' ||
    t.direction === 'sendrecv' ||
    t.direction === 'inactive'
  )
  if (audioTx) {
    try {
      // Direction first so the next offer advertises send; then bind the mic track.
      audioTx.direction = 'sendrecv'
      await audioTx.sender.replaceTrack(audioTrack)
    } catch (e) {
      console.warn('dm-voice attach transceiver:', e?.message || e)
      try { pc.addTrack(audioTrack, localStream) } catch (_) { /* ignore */ }
    }
    return
  }

  pc.addTrack(audioTrack, localStream)
}

/** Stop mic hardware and clear senders (keep PC for receiving). */
async function releaseLocalMic() {
  if (localStream) {
    for (const t of localStream.getTracks()) {
      try { t.stop() } catch (_) { /* ignore */ }
    }
    localStream = null
  }
  if (!pc) return
  for (const t of pc.getTransceivers()) {
    const isAudio =
      t.receiver?.track?.kind === 'audio' ||
      t.sender?.track?.kind === 'audio' ||
      t.direction === 'sendrecv' ||
      t.direction === 'sendonly' ||
      t.direction === 'recvonly'
    if (!isAudio) continue
    try { await t.sender.replaceTrack(null) } catch (_) { /* ignore */ }
    try { t.direction = 'recvonly' } catch (_) { /* ignore */ }
  }
}

function setPeerTalking(on) {
  peerTalking = !!on
  if (peerTalkingTimer) {
    clearTimeout(peerTalkingTimer)
    peerTalkingTimer = null
  }
  if (peerTalking) {
    peerTalkingTimer = setTimeout(() => {
      peerTalking = false
      peerTalkingTimer = null
      updateVoiceUi()
    }, PEER_TALKING_TTL_MS)
  }
  updateVoiceUi()
}

function clearConnectingTimer() {
  if (connectingTimer) {
    clearTimeout(connectingTimer)
    connectingTimer = null
  }
}

function clearHandshakeTimer() {
  if (handshakeTimer) {
    clearInterval(handshakeTimer)
    handshakeTimer = null
  }
}

/**
 * Late joiner often misses the first offer/ICE (broadcast is fire-and-forget).
 * Impolite peer must retransmit or rebuild when peer says hello.
 */
async function respondToPeerHello() {
  if (!pc || polite) return

  try {
    if (localStream) await attachLocalTracks()
    else ensureRecvAudioTransceiver()

    if (pc.signalingState === 'stable') {
      await makeOffer()
      return
    }

    // Stuck waiting for an answer the peer never sent (or we never got).
    if (pc.signalingState === 'have-local-offer' && !pc.currentRemoteDescription) {
      // After ICE gather, localDescription usually has candidates inlined — resend first.
      if (pc.localDescription && pc.iceGatheringState === 'complete') {
        await sendSignal('voice-offer', { sdp: pc.localDescription })
        return
      }
      // Still gathering or no SDP — rebuild a clean offer.
      await closePeerConnectionOnly()
      await createPeerConnection()
      ensureRecvAudioTransceiver()
      if (localStream) {
        try { await attachLocalTracks() } catch (_) { /* ignore */ }
      }
      await makeOffer()
    }
  } catch (e) {
    console.error('dm-voice hello offer:', e)
  }
}

function armHandshakeRetry() {
  clearHandshakeTimer()
  handshakeTimer = setInterval(() => {
    if (voiceLinkState !== 'connecting' || !channel || !activeConversationId) {
      clearHandshakeTimer()
      return
    }
    sendSignal('voice-hello').catch(() => {})
    // Impolite: keep pushing offer while answer never arrives.
    if (
      !polite &&
      pc?.signalingState === 'have-local-offer' &&
      !pc.currentRemoteDescription &&
      pc.localDescription
    ) {
      sendSignal('voice-offer', { sdp: pc.localDescription }).catch(() => {})
    }
  }, HANDSHAKE_RETRY_MS)
}

function armConnectingTimer() {
  clearConnectingTimer()
  connectingTimer = setTimeout(() => {
    connectingTimer = null
    if (!pc || voiceLinkState !== 'connecting') return
    const ice = pc.iceConnectionState
    const conn = pc.connectionState
    console.warn('dm-voice connecting timeout', { ice, conn, signaling: pc.signalingState })
    setVoiceLinkState('failed')
    updateVoiceUi()
    if (recoverAttempts < MAX_AUTO_RECOVER && activeConversationId) {
      recoverVoiceConnection().catch(e => console.error('dm-voice auto-recover:', e))
    }
  }, CONNECTING_TIMEOUT_MS)
}

function setVoiceLinkState(next) {
  voiceLinkState = next
  if (next === 'connecting') {
    armConnectingTimer()
    armHandshakeRetry()
  } else {
    clearConnectingTimer()
    clearHandshakeTimer()
  }
}

/** Snapshot for DevTools: `app.getDmVoiceDebug()` */
export function getDmVoiceDebug() {
  const remoteTrack = remoteAudio?.srcObject instanceof MediaStream
    ? remoteAudio.srcObject.getAudioTracks()[0]
    : null
  return {
    voiceLinkState,
    recovering,
    isTalking,
    peerTalking,
    needsAudioGesture,
    polite,
    activeConversationId,
    peerPhone,
    hasInbox: !!inboxChannel,
    lastRingAt,
    composerVisible,
    hasChannel: !!channel,
    hasPc: !!pc,
    hasLocalStream: !!localStream,
    hasRemoteAudio: !!remoteAudio,
    remoteSrcObject: !!remoteAudio?.srcObject,
    remoteTrack: remoteTrack
      ? {
          id: remoteTrack.id,
          readyState: remoteTrack.readyState,
          muted: remoteTrack.muted,
          enabled: remoteTrack.enabled
        }
      : null,
    pc: pc
      ? {
          connectionState: pc.connectionState,
          iceConnectionState: pc.iceConnectionState,
          iceGatheringState: pc.iceGatheringState,
          signalingState: pc.signalingState,
          localDescriptionType: pc.localDescription?.type || null,
          remoteDescriptionType: pc.remoteDescription?.type || null,
          transceiverDirections: pc.getTransceivers().map(t => t.direction)
        }
      : null
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
    const label = peerLabelCache.get(peerPhone) || peerPhone
    status.hidden = false
    status.textContent = `${label} در حال صحبت…`
    // Refresh display name without blocking UI (getUsersSafe is async).
    resolvePeerLabel(peerPhone).then((name) => {
      if (!peerTalking || !status.isConnected) return
      if (status.textContent?.includes('در حال صحبت')) {
        status.textContent = `${name} در حال صحبت…`
      }
    }).catch(() => {})
  } else if (isTalking) {
    status.hidden = false
    status.textContent = 'شما در حال صحبت…'
  } else if (voiceLinkState === 'failed') {
    status.hidden = false
    status.innerHTML =
      'ارتباط صوتی قطع شد — <button type="button" class="dm-chat-voice-retry" onclick="app.retryDmVoiceConnection()">تلاش مجدد</button>'
  } else if (needsAudioGesture && voiceLinkState === 'connected') {
    status.hidden = false
    status.innerHTML =
      'برای شنیدن صدا ضربه بزنید — <button type="button" class="dm-chat-voice-retry" onclick="app.unlockDmVoiceAudio()">فعال‌سازی صدا</button>'
  } else if (voiceLinkState === 'connecting') {
    status.hidden = false
    status.textContent = recovering ? 'در حال اتصال مجدد…' : 'در حال برقراری ارتباط صوتی…'
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

/**
 * Wake the peer's personal inbox so they can join the conversation voice channel
 * without already being in that DM tab.
 * @param {string} toPhone
 * @param {number} conversationId
 */
async function sendRing(toPhone, conversationId) {
  const to = normalizePhone(toPhone)
  const me = myPhone()
  const cid = Number(conversationId) || 0
  if (!to || !me || !cid || to === me) return
  let ch = null
  try {
    ch = supabase.channel(ringChannelName(to), {
      config: {
        broadcast: { self: false },
        private: true
      }
    })
    const status = await new Promise((resolve) => {
      ch.subscribe((next) => {
        if (next === 'SUBSCRIBED' || next === 'CHANNEL_ERROR' || next === 'TIMED_OUT') resolve(next)
      })
    })
    if (status !== 'SUBSCRIBED') {
      console.warn('dm-voice ring subscribe failed:', status, {
        hint: 'Apply supabase migration 043_dm_voice_ring_select_fix (sender must JOIN peer ring topic)'
      })
      return
    }
    await ch.send({
      type: 'broadcast',
      event: 'voice-ring',
      payload: {
        conversationId: cid,
        fromPhone: me,
        toPhone: to,
        at: Date.now()
      }
    })
  } catch (e) {
    console.error('dm-voice sendRing:', e)
  } finally {
    if (ch) await safeRemoveChannel(ch)
  }
}

/** @type {Map<string, string>} */
const peerLabelCache = new Map()

async function resolvePeerLabel(phone) {
  const p = normalizePhone(phone)
  if (!p) return ''
  if (peerLabelCache.has(p)) return peerLabelCache.get(p)
  try {
    const users = await getUsersSafe()
    const list = Array.isArray(users) ? users : []
    const peer = list.find(u => normalizePhone(u.phone) === p)
    const label = peer ? userDisplayName(peer) : p
    peerLabelCache.set(p, label)
    return label
  } catch (_) {
    return p
  }
}

function toastIncomingSpeaker(fromPhone) {
  resolvePeerLabel(fromPhone)
    .then((label) => showToast(`${label} در حال صحبت…`))
    .catch(() => showToast(`${normalizePhone(fromPhone) || 'همکار'} در حال صحبت…`))
}

/** One-shot gesture unlock when receiving in background (composer hidden). */
function armBackgroundAudioUnlock() {
  showToast('برای شنیدن صدا یک‌بار روی صفحه بزنید')
  if (typeof window === 'undefined' || window.__dmVoiceUnlockArmed) return
  window.__dmVoiceUnlockArmed = true
  const once = () => {
    window.__dmVoiceUnlockArmed = false
    document.removeEventListener('pointerdown', once, true)
    unlockDmVoiceAudio().catch(() => {})
  }
  document.addEventListener('pointerdown', once, true)
}

async function ensureLocalStream() {
  if (localStream) return localStream
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('getUserMedia unsupported')
  }
  // Mic hardware is only opened here (PTT hold) — never on DM open / sync.
  localStream = await navigator.mediaDevices.getUserMedia({
    audio: true,
    video: false
  })
  // Stay muted until startPtt finishes setup and confirms hold is still active.
  setLocalMicEnabled(false)
  return localStream
}

async function flushIceQueue() {
  if (!pc?.remoteDescription) return
  const queued = pendingIceCandidates.splice(0, pendingIceCandidates.length)
  for (const candidate of queued) {
    try {
      await pc.addIceCandidate(candidate)
    } catch (e) {
      console.error('dm-voice ice flush:', e)
    }
  }
}

/**
 * Close PC only (keep channel / mic stream) for ICE restart / rebuild.
 */
async function closePeerConnectionOnly() {
  const old = pc
  pc = null
  pendingIceCandidates = []
  makingOffer = false
  if (!old) return
  try {
    old.onicecandidate = null
    old.ontrack = null
    old.onconnectionstatechange = null
    old.onnegotiationneeded = null
    old.close()
  } catch (_) { /* ignore */ }
}

async function createPeerConnection() {
  if (pc) return pc
  pc = new RTCPeerConnection({ iceServers: getIceServers() })

  pc.onicecandidate = (ev) => {
    if (!ev.candidate) return
    sendSignal('voice-ice', { candidate: ev.candidate.toJSON() }).catch(() => {})
  }

  pc.ontrack = (ev) => {
    const audio = ensureRemoteAudio()
    if (ev.track) {
      try { ev.track.enabled = true } catch (_) { /* ignore */ }
    }
    const stream = ev.streams?.[0] || new MediaStream([ev.track])
    audio.srcObject = stream
    audio.muted = false
    audio.volume = 1
    audio.play()
      .then(() => {
        needsAudioGesture = false
        updateVoiceUi()
      })
      .catch(() => {
        needsAudioGesture = true
        if (!composerVisible) armBackgroundAudioUnlock()
        updateVoiceUi()
      })
  }

  pc.onnegotiationneeded = () => {
    makeOffer().catch(e => console.error('dm-voice negotiationneeded:', e))
  }

  pc.onconnectionstatechange = () => {
    if (!pc) return
    const state = pc.connectionState
    if (state === 'connected') {
      setVoiceLinkState('connected')
      recoverAttempts = 0
      updateVoiceUi()
      return
    }
    if (state === 'failed') {
      setVoiceLinkState('failed')
      setPeerTalking(false)
      updateVoiceUi()
      if (recoverAttempts < MAX_AUTO_RECOVER && activeConversationId) {
        recoverVoiceConnection().catch(e => console.error('dm-voice auto-recover:', e))
      }
      return
    }
    if (state === 'disconnected') {
      // Brief blips are normal; stuck peer-talking is cleared by TTL.
      updateVoiceUi()
    }
  }

  return pc
}

async function makeOffer(opts = {}) {
  if (!pc) return
  if (opts.iceRestart) negotiationIceRestart = true
  if (makingOffer) {
    negotiationQueued = true
    return
  }
  makingOffer = true
  try {
    do {
      negotiationQueued = false
      if (!pc) return
      const iceRestart = negotiationIceRestart
      negotiationIceRestart = false
      const offer = await pc.createOffer(iceRestart ? { iceRestart: true } : undefined)
      if (!pc) return
      await pc.setLocalDescription(offer)
      await sendSignal('voice-offer', { sdp: pc.localDescription })
    } while (negotiationQueued && pc)
  } finally {
    makingOffer = false
  }
}

async function handleOffer(payload) {
  if (!pc || !payload?.sdp) return
  if (handlingOffer) return

  const offerCollision = makingOffer || pc.signalingState !== 'stable'
  // Impolite peer ignores glare offers (perfect negotiation).
  if (!polite && offerCollision) return

  // Handshake retries may resend the same offer after we already answered.
  const incomingSdp = typeof payload.sdp === 'object' ? payload.sdp.sdp : null
  if (
    pc.signalingState === 'stable' &&
    pc.currentRemoteDescription?.type === 'offer' &&
    incomingSdp &&
    incomingSdp === pc.currentRemoteDescription.sdp
  ) {
    return
  }

  handlingOffer = true
  try {
    // Do not grab mic here — receive-only until PTT
    if (localStream) await attachLocalTracks()
    else ensureRecvAudioTransceiver()

    // Polite peer rolls back local offer on glare.
    if (offerCollision) {
      try {
        await pc.setLocalDescription({ type: 'rollback' })
      } catch (e) {
        console.warn('dm-voice rollback:', e?.message || e)
      }
    }

    await pc.setRemoteDescription(payload.sdp)
    await flushIceQueue()

    // Only answer when we actually have a remote offer pending.
    if (!pc || pc.signalingState !== 'have-remote-offer') return

    const answer = await pc.createAnswer()
    if (!pc || pc.signalingState !== 'have-remote-offer') return
    await pc.setLocalDescription(answer)
    await sendSignal('voice-answer', { sdp: pc.localDescription })
  } catch (e) {
    console.error('dm-voice handleOffer:', e)
  } finally {
    handlingOffer = false
  }
}

async function handleAnswer(payload) {
  if (!pc || !payload?.sdp) return
  try {
    if (pc.signalingState === 'have-local-offer') {
      await pc.setRemoteDescription(payload.sdp)
      await flushIceQueue()
    }
  } catch (e) {
    console.error('dm-voice handleAnswer:', e)
  }
}

async function handleIce(payload) {
  if (!pc || !payload?.candidate) return
  if (!pc.remoteDescription) {
    pendingIceCandidates.push(payload.candidate)
    return
  }
  try {
    await pc.addIceCandidate(payload.candidate)
  } catch (e) {
    console.error('dm-voice ice:', e)
  }
}

/**
 * ICE restart or full PC rebuild after connectionState === 'failed'.
 */
export async function recoverVoiceConnection() {
  if (recovering || !activeConversationId || !peerPhone || !channel) return
  recovering = true
  setVoiceLinkState('connecting')
  updateVoiceUi()

  try {
    recoverAttempts += 1

    // Prefer ICE restart on the existing PC when possible.
    if (pc && (pc.connectionState === 'failed' || pc.connectionState === 'disconnected')) {
      try {
        if (typeof pc.restartIce === 'function') pc.restartIce()
        if (!polite) {
          await makeOffer({ iceRestart: true })
        } else {
          await sendSignal('voice-hello')
        }
        return
      } catch (e) {
        console.warn('dm-voice ice restart failed, rebuilding PC:', e?.message || e)
      }
    }

    await closePeerConnectionOnly()
    await createPeerConnection()
    ensureRecvAudioTransceiver()
    if (localStream) {
      try { await attachLocalTracks() } catch (e) {
        console.warn('dm-voice recover attach:', e?.message || e)
      }
    }
    await sendSignal('voice-hello')
    if (!polite && pc?.signalingState === 'stable') {
      await makeOffer()
    }
  } catch (e) {
    console.error('recoverVoiceConnection:', e)
    setVoiceLinkState('failed')
    showToast('اتصال مجدد واکی‌تاکی ناموفق بود')
  } finally {
    recovering = false
    updateVoiceUi()
  }
}

/** Manual retry from status UI. */
export async function retryDmVoiceConnection() {
  recoverAttempts = 0
  await recoverVoiceConnection()
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
    await respondToPeerHello()
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
    // Half-duplex: yield before showing peer-talking UI
    if (isTalking || pttWanted) {
      pttWanted = false
      pttEpoch += 1
      if (isTalking) {
        isTalking = false
        sendSignal('ptt-stop').catch(() => {})
      }
      releaseLocalMic()
        .then(() => {
          if (pc?.signalingState === 'stable') return makeOffer()
          negotiationQueued = true
        })
        .catch(() => {})
    }
    setPeerTalking(true)
    // Background receiver (not in this DM UI): announce speaker.
    if (!composerVisible) toastIncomingSpeaker(from)
    // Peer started talking — try unlocking playback under whatever gesture we have.
    if (remoteAudio?.srcObject) {
      remoteAudio.play()
        .then(() => {
          needsAudioGesture = false
          updateVoiceUi()
        })
        .catch(() => {
          needsAudioGesture = true
          if (!composerVisible) armBackgroundAudioUnlock()
          updateVoiceUi()
        })
    }
    return
  }
  if (event === 'ptt-stop' || event === 'voice-hangup') {
    setPeerTalking(false)
  }
}

async function safeRemoveChannel(ch) {
  if (!ch) return
  try { await supabase.removeChannel(ch) } catch (_) { /* ignore */ }
}

/**
 * Defense-in-depth: confirm DB membership before joining the private voice channel.
 * @param {number} conversationId
 */
async function assertDmVoiceMembership(conversationId) {
  const me = myPhone()
  if (!me || !conversationId) return false

  const { data: member, error: memberErr } = await supabase
    .from('dm_members')
    .select('conversation_id')
    .eq('conversation_id', conversationId)
    .eq('user_phone', me)
    .maybeSingle()
  if (memberErr) console.warn('dm-voice membership check:', memberErr.message)
  if (member) return true

  const { data: conv, error: convErr } = await supabase
    .from('dm_conversations')
    .select('id, phone_a, phone_b')
    .eq('id', conversationId)
    .maybeSingle()
  if (convErr) console.warn('dm-voice conv check:', convErr.message)
  if (!conv) return false
  return normalizePhone(conv.phone_a) === me || normalizePhone(conv.phone_b) === me
}

/**
 * Subscribe without assigning the module `channel` until the caller decides.
 * Rejects (and removes the channel) on CHANNEL_ERROR / TIMED_OUT.
 * @param {number} conversationId
 * @returns {Promise<import('@supabase/supabase-js').RealtimeChannel>}
 */
async function subscribeChannel(conversationId) {
  const allowed = await assertDmVoiceMembership(conversationId)
  if (!allowed) {
    throw new Error('dm-voice membership denied')
  }

  const ch = supabase.channel(channelName(conversationId), {
    config: {
      broadcast: { self: false },
      private: true
    }
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
  ensureRecvAudioTransceiver()

  if (token !== teardownToken) return
  await sendSignal('voice-hello')

  if (token !== teardownToken) return
  // Impolite peer creates the initial offer without requiring mic yet
  if (!polite && pc?.signalingState === 'stable') {
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
      snap.pc.onnegotiationneeded = null
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
 * Bind walkie-talkie to a DM conversation (active tab or background incoming).
 * @param {{ conversationId?: number, peerPhone?: string, enabled?: boolean, showComposer?: boolean, ringPeer?: boolean }} opts
 */
export async function syncDmVoiceForTab(opts = {}) {
  const enabled = !!opts.enabled
  const cid = Number(opts.conversationId) || 0
  const peer = normalizePhone(opts.peerPhone)
  const me = myPhone()
  const showComposer = opts.showComposer !== false
  const ringPeer = opts.ringPeer !== false && showComposer

  if (!enabled || !cid || !peer || !me || peer === me) {
    await teardownDmVoice()
    syncDmVoiceComposerVisibility(false)
    return
  }

  if (showComposer) syncDmVoiceComposerVisibility(true)
  else syncDmVoiceComposerVisibility(false)

  if (activeConversationId === cid && peerPhone === peer && channel && pc) {
    updateVoiceUi()
    if (ringPeer) sendRing(peer, cid).catch(() => {})
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
  setPeerTalking(false)
  pendingIceCandidates = []
  recoverAttempts = 0
  setVoiceLinkState('connecting')
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
    if (ringPeer) await sendRing(peer, cid)
    updateVoiceUi()
  } catch (e) {
    console.error('syncDmVoiceForTab:', e)
    if (token === teardownToken) {
      const denied = String(e?.message || '').includes('membership denied')
      showToast(denied ? 'دسترسی واکی‌تاکی برای این گفتگو نیست' : 'اتصال واکی‌تاکی برقرار نشد')
      await abandonIfStillOwner(token)
      syncDmVoiceComposerVisibility(false)
    }
  } finally {
    if (token === teardownToken) connecting = false
  }
}

/** Join conversation voice in background after a personal inbox ring. */
export async function acceptIncomingDmVoice(opts = {}) {
  const cid = Number(opts.conversationId) || 0
  const peer = normalizePhone(opts.peerPhone)
  if (!cid || !peer) return
  await syncDmVoiceForTab({
    conversationId: cid,
    peerPhone: peer,
    enabled: true,
    showComposer: false,
    ringPeer: false
  })
}

async function handleIncomingRing(payload) {
  if (!payload) return
  const cid = Number(payload.conversationId) || 0
  const from = normalizePhone(payload.fromPhone)
  const me = myPhone()
  if (!cid || !from || !me || from === me) return

  lastRingAt = Date.now()

  if (activeConversationId === cid && peerPhone === from && channel && pc) {
    await sendSignal('voice-hello')
    if (!polite && pc.signalingState === 'stable') {
      await makeOffer()
    } else if (!polite && pc.signalingState === 'have-local-offer' && pc.localDescription) {
      await sendSignal('voice-offer', { sdp: pc.localDescription })
    }
    return
  }

  await acceptIncomingDmVoice({ conversationId: cid, peerPhone: from })
}

/** Keep a personal ring channel while DM chat is enabled (any screen). */
export async function startDmVoiceInbox() {
  const me = myPhone()
  if (!me) return
  if (inboxChannel) return

  const ch = supabase.channel(ringChannelName(me), {
    config: {
      broadcast: { self: false },
      private: true
    }
  })
  ch.on('broadcast', { event: 'voice-ring' }, (msg) => {
    handleIncomingRing(msg?.payload).catch(e => console.error('dm-voice ring handler:', e))
  })

  const status = await new Promise((resolve) => {
    ch.subscribe((next) => {
      if (next === 'SUBSCRIBED' || next === 'CHANNEL_ERROR' || next === 'TIMED_OUT') resolve(next)
    })
  })

  if (status !== 'SUBSCRIBED') {
    await safeRemoveChannel(ch)
    console.warn('dm-voice inbox subscribe failed:', status)
    return
  }

  inboxChannel = ch
}

export async function stopDmVoiceInbox() {
  const ch = inboxChannel
  inboxChannel = null
  await safeRemoveChannel(ch)
}

/**
 * Hide PTT UI / stop TX without tearing down media (receiver may still be listening).
 */
export async function leaveDmVoiceUi() {
  await stopPtt()
  syncDmVoiceComposerVisibility(false)
}

export function syncDmVoiceComposerVisibility(visible) {
  composerVisible = !!visible
  const btn = document.getElementById('dmChatPttBtn')
  const status = document.getElementById('dmChatVoiceStatus')
  if (btn) btn.hidden = !visible
  if (status && !visible) {
    status.hidden = true
    status.textContent = ''
  } else if (visible) {
    updateVoiceUi()
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
    // Wake peer inbox before grabbing mic so they can join the voice channel.
    await sendRing(peerPhone, activeConversationId)
    if (!pttWanted || epoch !== pttEpoch) {
      return
    }

    await ensureLocalStream()
    if (!pttWanted || epoch !== pttEpoch) {
      await releaseLocalMic()
      return
    }

    await createPeerConnection()
    await attachLocalTracks()
    // recvonly → sendrecv must be advertised in a new offer or the peer never gets audio.
    if (pc?.signalingState === 'stable') {
      await makeOffer()
    } else {
      negotiationQueued = true
    }

    // Resume remote playback under this user gesture (autoplay policies)
    if (remoteAudio?.srcObject) {
      try {
        await remoteAudio.play()
        needsAudioGesture = false
      } catch (_) {
        needsAudioGesture = true
      }
    }

    if (!pttWanted || epoch !== pttEpoch) {
      await releaseLocalMic()
      if (pc?.signalingState === 'stable') await makeOffer()
      return
    }

    if (pc && !pc.currentRemoteDescription) {
      await sendSignal('voice-hello')
      if (!pttWanted || epoch !== pttEpoch) {
        await releaseLocalMic()
        if (pc?.signalingState === 'stable') await makeOffer()
        return
      }
      if (!polite && pc.signalingState === 'stable') {
        await makeOffer()
      }
    }

    if (!pttWanted || epoch !== pttEpoch || peerTalking) {
      await releaseLocalMic()
      if (pc?.signalingState === 'stable') await makeOffer()
      return
    }

    setLocalMicEnabled(true)
    isTalking = true
    updateVoiceUi()
    await sendSignal('ptt-start')

    // Released while ptt-start was in flight — shut mic back off
    if (!pttWanted || epoch !== pttEpoch) {
      isTalking = false
      updateVoiceUi()
      await sendSignal('ptt-stop')
      await releaseLocalMic()
      if (pc?.signalingState === 'stable') await makeOffer()
    }
  } catch (e) {
    console.error('startPtt:', e)
    const denied = e?.name === 'NotAllowedError' || e?.name === 'PermissionDeniedError'
    const noDevice = e?.name === 'NotFoundError' || e?.name === 'DevicesNotFoundError'
    showToast(
      denied
        ? 'دسترسی میکروفون رد شد'
        : noDevice
          ? 'میکروفون روی این دستگاه/مرورگر پیدا نشد'
          : 'شروع واکی‌تاکی ناموفق بود'
    )
    isTalking = false
    await releaseLocalMic()
    updateVoiceUi()
  } finally {
    if (epoch === pttEpoch) pttStarting = false
  }
}

export async function stopPtt() {
  pttWanted = false
  pttEpoch += 1
  pttStarting = false

  const wasTalking = isTalking
  isTalking = false
  updateVoiceUi()
  if (wasTalking) {
    await sendSignal('ptt-stop')
  }
  await releaseLocalMic()
  // Drop send direction so peer stops expecting our audio.
  if (pc?.signalingState === 'stable') {
    try { await makeOffer() } catch (_) { /* ignore */ }
  } else {
    negotiationQueued = true
  }
}

/** Unlock remote audio after autoplay block (user gesture). */
export async function unlockDmVoiceAudio() {
  if (voiceLinkState !== 'connected') {
    showToast(
      voiceLinkState === 'connecting'
        ? 'هنوز ارتباط صوتی برقرار نشده — چند لحظه صبر کنید یا تلاش مجدد بزنید'
        : 'ارتباط صوتی برقرار نیست — تلاش مجدد را بزنید'
    )
    updateVoiceUi()
    return
  }
  if (!remoteAudio?.srcObject) {
    needsAudioGesture = false
    showToast('هنوز صدایی از طرف مقابل نرسیده — وقتی صحبت می‌کند دوباره فعال‌سازی را بزنید')
    updateVoiceUi()
    return
  }
  try {
    remoteAudio.muted = false
    remoteAudio.volume = 1
    await remoteAudio.play()
    needsAudioGesture = false
    updateVoiceUi()
  } catch (e) {
    console.warn('unlockDmVoiceAudio:', e?.message || e)
    showToast('پخش صدا ممکن نشد — دوباره تلاش کنید')
  }
}

export function scheduleDmVoiceBackgroundTeardown() {
  if (backgroundTeardownTimer) clearTimeout(backgroundTeardownTimer)
  backgroundTeardownTimer = setTimeout(() => {
    backgroundTeardownTimer = null
    teardownDmVoice().catch(() => {})
  }, BACKGROUND_TEARDOWN_MS)
}

export function cancelDmVoiceBackgroundTeardown() {
  if (backgroundTeardownTimer) {
    clearTimeout(backgroundTeardownTimer)
    backgroundTeardownTimer = null
  }
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
  setPeerTalking(false)
  pttWanted = false
  pttEpoch += 1
  pttStarting = false
  pendingIceCandidates = []
  recovering = false
  recoverAttempts = 0
  setVoiceLinkState('idle')
  needsAudioGesture = false
  cancelDmVoiceBackgroundTeardown()
  clearConnectingTimer()
  clearHandshakeTimer()
  activeConversationId = 0
  peerPhone = ''
  polite = false
  makingOffer = false
  negotiationQueued = false
  negotiationIceRestart = false
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
