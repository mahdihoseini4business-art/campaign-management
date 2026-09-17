/**
 * In-app confirm / alert modals (replaces window.confirm / window.alert).
 * Self-contained: injects markup + styles if the host page has none.
 */

const MODAL_ID = 'appConfirmModal'
const STYLE_ID = 'appConfirmModalStyles'
const MSG_ID = 'appConfirmMessage'
const TITLE_ID = 'appConfirmTitle'
const OK_ID = 'appConfirmOkBtn'
const CANCEL_ID = 'appConfirmCancelBtn'
const CLOSE_ID = 'appConfirmCloseBtn'

/** @type {null | ((value: boolean) => void)} */
let pendingResolve = null

function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = `
#${MODAL_ID}{
  position:fixed;inset:0;z-index:100000;display:none;align-items:center;justify-content:center;
  padding:16px;box-sizing:border-box;background:rgba(15,23,42,.45);
  font-family:Vazirmatn,Tahoma,sans-serif;direction:rtl;
}
#${MODAL_ID}.active{display:flex}
#${MODAL_ID} .app-confirm-dialog{
  width:100%;max-width:420px;background:#fff;color:#0f172a;border-radius:12px;
  box-shadow:0 20px 50px rgba(15,23,42,.25);overflow:hidden;
}
#${MODAL_ID} .app-confirm-header{
  display:flex;align-items:center;justify-content:space-between;gap:12px;
  padding:14px 16px;border-bottom:1px solid #e2e8f0;
}
#${MODAL_ID} .app-confirm-header h2{margin:0;font-size:16px;font-weight:700}
#${MODAL_ID} .app-confirm-close{
  border:0;background:transparent;font-size:22px;line-height:1;cursor:pointer;color:#64748b;padding:0 4px;
}
#${MODAL_ID} .app-confirm-body{padding:16px;line-height:1.7;font-size:14px;white-space:pre-wrap}
#${MODAL_ID} .app-confirm-footer{
  display:flex;justify-content:flex-start;gap:8px;flex-wrap:wrap;
  padding:12px 16px 16px;border-top:1px solid #e2e8f0;
}
#${MODAL_ID} .app-confirm-btn{
  border:1px solid #cbd5e1;background:#f8fafc;color:#0f172a;border-radius:8px;
  padding:8px 14px;font:inherit;cursor:pointer;
}
#${MODAL_ID} .app-confirm-btn-primary{background:#0155d2;border-color:#0155d2;color:#fff}
#${MODAL_ID} .app-confirm-btn-danger{background:#dc2626;border-color:#dc2626;color:#fff}
`
  document.head.appendChild(style)
}

function ensureModal() {
  ensureStyles()
  let modal = document.getElementById(MODAL_ID)
  if (modal) return modal

  modal = document.createElement('div')
  modal.id = MODAL_ID
  modal.setAttribute('role', 'dialog')
  modal.setAttribute('aria-modal', 'true')
  modal.innerHTML = `
    <div class="app-confirm-dialog">
      <div class="app-confirm-header">
        <h2 id="${TITLE_ID}">تأیید</h2>
        <button type="button" class="app-confirm-close" id="${CLOSE_ID}" aria-label="بستن">&times;</button>
      </div>
      <div class="app-confirm-body" id="${MSG_ID}"></div>
      <div class="app-confirm-footer">
        <button type="button" class="app-confirm-btn" id="${CANCEL_ID}">انصراف</button>
        <button type="button" class="app-confirm-btn app-confirm-btn-primary" id="${OK_ID}">تأیید</button>
      </div>
    </div>
  `
  document.body.appendChild(modal)

  const finish = (value) => {
    modal.classList.remove('active')
    const resolve = pendingResolve
    pendingResolve = null
    if (resolve) resolve(value)
  }

  document.getElementById(OK_ID)?.addEventListener('click', () => finish(true))
  document.getElementById(CANCEL_ID)?.addEventListener('click', () => finish(false))
  document.getElementById(CLOSE_ID)?.addEventListener('click', () => finish(false))
  modal.addEventListener('click', (e) => {
    if (e.target === modal) finish(false)
  })
  document.addEventListener('keydown', (e) => {
    if (!modal.classList.contains('active')) return
    if (e.key === 'Escape') {
      e.preventDefault()
      finish(false)
    }
  })

  return modal
}

/**
 * @param {string} message
 * @param {{
 *   title?: string,
 *   confirmLabel?: string,
 *   cancelLabel?: string,
 *   danger?: boolean,
 *   hideCancel?: boolean,
 * }} [opts]
 * @returns {Promise<boolean>}
 */
export function openAppConfirm(message, opts = {}) {
  const modal = ensureModal()
  const msgEl = document.getElementById(MSG_ID)
  const titleEl = document.getElementById(TITLE_ID)
  const okBtn = document.getElementById(OK_ID)
  const cancelBtn = document.getElementById(CANCEL_ID)

  if (pendingResolve) {
    pendingResolve(false)
    pendingResolve = null
  }

  if (msgEl) msgEl.textContent = String(message || '')
  if (titleEl) titleEl.textContent = opts.title || (opts.hideCancel ? 'پیام' : 'تأیید')
  if (okBtn) {
    okBtn.textContent = opts.confirmLabel || (opts.hideCancel ? 'باشه' : 'تأیید')
    okBtn.className = opts.danger
      ? 'app-confirm-btn app-confirm-btn-danger'
      : 'app-confirm-btn app-confirm-btn-primary'
  }
  if (cancelBtn) {
    cancelBtn.textContent = opts.cancelLabel || 'انصراف'
    cancelBtn.hidden = !!opts.hideCancel
  }

  return new Promise((resolve) => {
    pendingResolve = resolve
    modal.classList.add('active')
    queueMicrotask(() => okBtn?.focus?.())
  })
}

/**
 * Alert-style dialog (single OK button).
 * @param {string} message
 * @param {{ title?: string, confirmLabel?: string }} [opts]
 * @returns {Promise<void>}
 */
export async function openAppAlert(message, opts = {}) {
  await openAppConfirm(message, {
    title: opts.title || 'پیام',
    confirmLabel: opts.confirmLabel || 'باشه',
    hideCancel: true,
  })
}
