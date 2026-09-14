export const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL
export const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY
/** Production admin OTP phone — must stay stable across deploys */
export const ADMIN_PHONE = import.meta.env.VITE_ADMIN_PHONE || '09123456789'

const DEFAULT_STUN = { urls: 'stun:stun.l.google.com:19302' }

/**
 * WebRTC ICE servers: always STUN; optional TURN from VITE_TURN_* env.
 * TURN creds are visible in the client bundle — prefer short-lived creds in production.
 * @returns {RTCIceServer[]}
 */
export function getIceServers() {
  /** @type {RTCIceServer[]} */
  const servers = [DEFAULT_STUN]
  const urls = String(import.meta.env.VITE_TURN_URLS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
  const username = String(import.meta.env.VITE_TURN_USERNAME || '').trim()
  const credential = String(import.meta.env.VITE_TURN_CREDENTIAL || '').trim()
  if (urls.length && username && credential) {
    servers.push({ urls, username, credential })
  }
  return servers
}
