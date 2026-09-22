/**
 * Shared import/export/backup job progress UI.
 * Modal-embedded panel or floating corner panel with spinner, bar, ETA, lock, cancel.
 */

import { toFaDigits, showToast } from './utils.js'

/** @type {JobHandle | null} */
let activeJob = null

const THROTTLE_MS = 100
const ETA_MIN_SAMPLES = 3

/**
 * @typedef {{
 *   host?: string | Element | 'float',
 *   title?: string,
 *   lockButtons?: (string | Element)[],
 *   lockSelectors?: string[],
 *   cancellable?: boolean,
 *   onCancel?: () => void,
 * }} JobProgressOptions
 */

/**
 * @typedef {{
 *   id: number,
 *   cancelled: boolean,
 *   signal: AbortSignal,
 *   set: (state: { label?: string, done?: number, total?: number | null }) => void,
 *   paint: () => Promise<void>,
 *   isCancelled: () => boolean,
 *   throwIfCancelled: () => void,
 *   end: () => void,
 *   fail: (err?: unknown) => void,
 * }} JobHandle
 */

function resolveEl(ref) {
  if (!ref) return null
  if (typeof ref === 'string') return document.querySelector(ref)
  return ref
}

function paintFrame() {
  return new Promise(resolve => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => resolve())
    })
  })
}

function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return ''
  const sec = Math.round(ms / 1000)
  if (sec < 60) return `${toFaDigits(sec)} ثانیه`
  const m = Math.floor(sec / 60)
  const s = sec % 60
  if (m < 60) return s ? `${toFaDigits(m)} دقیقه و ${toFaDigits(s)} ثانیه` : `${toFaDigits(m)} دقیقه`
  const h = Math.floor(m / 60)
  const rm = m % 60
  return rm ? `${toFaDigits(h)} ساعت و ${toFaDigits(rm)} دقیقه` : `${toFaDigits(h)} ساعت`
}

function ensureFloatHost() {
  let el = document.getElementById('jobProgressFloat')
  if (el) return el
  el = document.createElement('div')
  el.id = 'jobProgressFloat'
  el.className = 'job-progress-float'
  el.hidden = true
  document.body.appendChild(el)
  return el
}

/**
 * @param {Element} mount
 * @param {{ title: string, cancellable: boolean }} opts
 */
function buildPanel(mount, { title, cancellable }) {
  let panel = mount.querySelector(':scope > .job-progress-panel')
  if (!panel) {
    panel = document.createElement('div')
    panel.className = 'job-progress-panel'
    panel.setAttribute('role', 'status')
    panel.setAttribute('aria-live', 'polite')
    panel.innerHTML = `
      <div class="job-progress-inner">
        <span class="loader job-progress-spinner" aria-hidden="true"></span>
        <div class="job-progress-text">
          <div class="job-progress-title"></div>
          <div class="job-progress-label"></div>
          <div class="job-progress-bar-track" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">
            <div class="job-progress-bar-fill"></div>
          </div>
          <div class="job-progress-meta"></div>
        </div>
        <button type="button" class="btn btn-sm job-progress-cancel" hidden>لغو</button>
      </div>
    `
    mount.appendChild(panel)
  }
  panel.hidden = false
  const titleEl = panel.querySelector('.job-progress-title')
  if (titleEl) titleEl.textContent = title || 'در حال انجام…'
  const cancelBtn = panel.querySelector('.job-progress-cancel')
  if (cancelBtn) cancelBtn.hidden = !cancellable
  return panel
}

/**
 * @param {JobProgressOptions} [opts]
 * @returns {JobHandle | null} null if another job is already running
 */
export function startJobProgress(opts = {}) {
  if (activeJob) {
    showToast('عملیات دیگری در حال اجراست')
    return null
  }

  const title = opts.title || 'در حال انجام…'
  const cancellable = !!opts.cancellable
  const lockRefs = [
    ...(opts.lockButtons || []),
    ...(opts.lockSelectors || []).map(s => document.querySelector(s)).filter(Boolean)
  ]

  /** @type {Element} */
  let mount
  /** @type {Element | null} */
  let busyRoot = null
  let isFloat = false

  if (opts.host === 'float' || !opts.host) {
    mount = ensureFloatHost()
    mount.hidden = false
    isFloat = true
  } else {
    const hostEl = resolveEl(opts.host)
    if (!hostEl) {
      mount = ensureFloatHost()
      mount.hidden = false
      isFloat = true
    } else {
      mount = hostEl
      busyRoot = hostEl.closest('.modal-overlay') || hostEl
    }
  }

  const panel = buildPanel(mount, { title, cancellable })
  const labelEl = panel.querySelector('.job-progress-label')
  const metaEl = panel.querySelector('.job-progress-meta')
  const trackEl = panel.querySelector('.job-progress-bar-track')
  const fillEl = panel.querySelector('.job-progress-bar-fill')
  const cancelBtn = panel.querySelector('.job-progress-cancel')

  const locked = []
  for (const ref of lockRefs) {
    const el = resolveEl(ref)
    if (!el || el.disabled) continue
    el.disabled = true
    locked.push(el)
  }

  if (busyRoot) busyRoot.setAttribute('aria-busy', 'true')

  const ac = new AbortController()
  const startedAt = Date.now()
  let lastPaintAt = 0
  let pending = { label: title, done: 0, total: null }
  let samples = []
  let ended = false
  const id = Date.now()

  const render = (force = false) => {
    if (ended) return
    const now = Date.now()
    if (!force && now - lastPaintAt < THROTTLE_MS) return
    lastPaintAt = now

    const { label, done, total } = pending
    if (labelEl) labelEl.textContent = label || title

    const hasTotal = total != null && total > 0
    const pct = hasTotal ? Math.min(100, Math.round((done / total) * 100)) : null

    if (trackEl && fillEl) {
      if (hasTotal) {
        trackEl.classList.remove('is-indeterminate')
        fillEl.style.width = `${pct}%`
        trackEl.setAttribute('aria-valuenow', String(pct))
        trackEl.removeAttribute('aria-valuetext')
      } else {
        trackEl.classList.add('is-indeterminate')
        fillEl.style.width = ''
        trackEl.setAttribute('aria-valuenow', '0')
        trackEl.setAttribute('aria-valuetext', 'در حال انجام')
      }
    }

    const parts = []
    if (hasTotal) {
      parts.push(`${toFaDigits(done)} از ${toFaDigits(total)}`)
      parts.push(`${toFaDigits(pct)}٪`)
    }
    const elapsed = now - startedAt
    if (elapsed >= 1000) parts.push(`گذشته: ${formatDuration(elapsed)}`)

    if (hasTotal && done > 0 && samples.length >= ETA_MIN_SAMPLES) {
      const rate = done / (elapsed / 1000)
      if (rate > 0) {
        const remainMs = ((total - done) / rate) * 1000
        if (remainMs > 500) parts.push(`مانده: حدود ${formatDuration(remainMs)}`)
      }
    }

    if (metaEl) metaEl.textContent = parts.join(' · ')
  }

  /** @type {JobHandle} */
  const job = {
    id,
    cancelled: false,
    signal: ac.signal,
    set({ label, done, total } = {}) {
      if (ended) return
      if (label != null) pending.label = label
      if (done != null) pending.done = Math.max(0, Number(done) || 0)
      if (total !== undefined) pending.total = total == null ? null : Math.max(0, Number(total) || 0)
      if (pending.total != null && pending.done > 0) {
        samples.push({ t: Date.now(), done: pending.done })
        if (samples.length > 20) samples.shift()
      }
      render()
    },
    async paint() {
      render(true)
      await paintFrame()
    },
    isCancelled() {
      return job.cancelled || ac.signal.aborted
    },
    throwIfCancelled() {
      if (job.isCancelled()) {
        const err = new Error('CANCELLED')
        err.code = 'CANCELLED'
        throw err
      }
    },
    end() {
      cleanup(false)
    },
    fail(err) {
      cleanup(true, err)
    }
  }

  function cleanup(_failed, _err) {
    if (ended) return
    ended = true
    if (activeJob === job) activeJob = null

    for (const el of locked) {
      try { el.disabled = false } catch (_) {}
    }
    if (busyRoot) busyRoot.removeAttribute('aria-busy')

    panel.hidden = true
    if (isFloat) {
      const floatHost = document.getElementById('jobProgressFloat')
      if (floatHost) floatHost.hidden = true
    }
    if (cancelBtn) {
      cancelBtn.onclick = null
    }
  }

  if (cancelBtn && cancellable) {
    cancelBtn.onclick = () => {
      if (ended || job.cancelled) return
      job.cancelled = true
      ac.abort()
      if (typeof opts.onCancel === 'function') {
        try { opts.onCancel() } catch (_) {}
      }
      if (labelEl) labelEl.textContent = 'در حال لغو…'
      render(true)
    }
  }

  activeJob = job
  render(true)
  return job
}

/** True when a job is currently active. */
export function isJobProgressActive() {
  return !!activeJob
}

/**
 * Run async work under a job progress panel.
 * Returns null if another job is busy (and shows toast).
 * @template T
 * @param {JobProgressOptions} opts
 * @param {(job: JobHandle) => Promise<T>} fn
 * @returns {Promise<T | null>}
 */
export async function runWithJobProgress(opts, fn) {
  const job = startJobProgress(opts)
  if (!job) return null
  await job.paint()
  try {
    const result = await fn(job)
    if (job.isCancelled()) {
      showToast('عملیات لغو شد — تغییرات اعمال‌شده تا این لحظه حفظ شده‌اند')
      job.end()
      return result
    }
    job.end()
    return result
  } catch (err) {
    if (err?.code === 'CANCELLED' || err?.message === 'CANCELLED') {
      showToast('عملیات لغو شد — تغییرات اعمال‌شده تا این لحظه حفظ شده‌اند')
      job.end()
      return null
    }
    job.fail(err)
    throw err
  }
}

export { paintFrame as jobPaintFrame }
