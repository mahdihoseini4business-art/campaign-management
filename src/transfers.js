// ============================================
// Transfer Inbox (صندوق / تاریخچه انتقال مالکیت)
// ============================================

import {
  getTransferBatchesForUser,
  countUnreadReceivedBatches,
  markTransferBatchSeen
} from './data.js'
import {
  escapeHtml,
  escapeAttr,
  showToast,
  hasPermission,
  getCurrentUser
} from './utils.js'

let inboxTab = 'received' // received | sent
let activeBatchId = null

export function updateTransferInboxBadge() {
  const user = getCurrentUser()
  const badge = document.getElementById('transferInboxBadge')
  const btn = document.getElementById('transferInboxBtn')
  if (!btn) return

  const canSee = hasPermission('customers_view')
  btn.style.display = canSee ? '' : 'none'
  if (!canSee || !badge) return

  const n = countUnreadReceivedBatches(user?.phone)
  badge.textContent = String(n)
  badge.style.display = n > 0 ? 'inline-flex' : 'none'
}

export function openTransferInbox(tab = 'received') {
  if (!hasPermission('customers_view')) {
    showToast('دسترسی ندارید')
    return
  }
  inboxTab = tab === 'sent' ? 'sent' : 'received'
  activeBatchId = null
  const modal = document.getElementById('transferInboxModal')
  if (!modal) return
  modal.classList.add('active')
  renderTransferInbox()
}

export function closeTransferInbox() {
  const modal = document.getElementById('transferInboxModal')
  if (modal) modal.classList.remove('active')
  activeBatchId = null
}

export function setTransferInboxTab(tab) {
  inboxTab = tab === 'sent' ? 'sent' : 'received'
  activeBatchId = null
  renderTransferInbox()
}

export function renderTransferInbox() {
  const user = getCurrentUser()
  const listEl = document.getElementById('transferInboxList')
  const detailEl = document.getElementById('transferInboxDetail')
  if (!listEl) return

  document.querySelectorAll('.transfer-inbox-tab').forEach(btn => {
    const active = btn.dataset.tab === inboxTab
    btn.classList.toggle('active', active)
    btn.setAttribute('aria-selected', active ? 'true' : 'false')
  })

  const batches = getTransferBatchesForUser(user?.phone, inboxTab)

  if (batches.length === 0) {
    listEl.innerHTML = `
      <div class="empty-state" style="padding:32px 16px;">
        <div class="icon">⇄</div>
        <h3>${inboxTab === 'received' ? 'انتقال دریافتی ندارید' : 'انتقال ارسالی ندارید'}</h3>
        <p>وقتی انتقالی انجام شود اینجا نمایش داده می‌شود</p>
      </div>`
    if (detailEl) detailEl.innerHTML = ''
    updateTransferInboxBadge()
    return
  }

  listEl.innerHTML = batches.map(b => {
    const unread = inboxTab === 'received' && !b.seen
    const isActive = activeBatchId === b.id
    const partyLabel = inboxTab === 'received' ? 'از' : 'به'
    const party = b.counterpartName || b.counterpartPhone || '—'
    return `
      <button type="button"
        class="transfer-inbox-item${unread ? ' is-unread' : ''}${isActive ? ' is-active' : ''}"
        onclick="app.openTransferBatchDetail('${escapeAttr(b.id)}')">
        <div class="transfer-inbox-item-top">
          <span class="transfer-inbox-item-date">${escapeHtml(b.dateTime)}</span>
          ${unread ? '<span class="transfer-inbox-dot" title="خوانده‌نشده"></span>' : ''}
        </div>
        <div class="transfer-inbox-item-main">
          <span>${partyLabel} ${escapeHtml(party)}</span>
          <span class="transfer-inbox-count">${b.count} شماره</span>
        </div>
        <div class="transfer-inbox-item-meta">${escapeHtml(b.reasonLabel)}</div>
      </button>`
  }).join('')

  if (activeBatchId) {
    const still = batches.find(b => b.id === activeBatchId)
    if (still) renderTransferBatchDetail(still)
    else if (detailEl) detailEl.innerHTML = ''
  } else if (detailEl) {
    detailEl.innerHTML = `
      <div class="empty-state" style="padding:24px 12px;">
        <p>یک انتقال را برای دیدن لیست شماره‌ها انتخاب کنید</p>
      </div>`
  }

  updateTransferInboxBadge()
}

export async function openTransferBatchDetail(batchGroupId) {
  const user = getCurrentUser()
  activeBatchId = batchGroupId
  const batches = getTransferBatchesForUser(user?.phone, inboxTab)
  const batch = batches.find(b => b.id === batchGroupId)
  if (!batch) {
    showToast('انتقال یافت نشد')
    return
  }

  if (batch.direction === 'received' && !batch.seen) {
    try {
      await markTransferBatchSeen(batch.batchId, user?.phone)
    } catch (e) {
      console.warn('markTransferBatchSeen:', e?.message || e)
    }
  }

  renderTransferInbox()
  renderTransferBatchDetail(batch)
}

function renderTransferBatchDetail(batch) {
  const detailEl = document.getElementById('transferInboxDetail')
  if (!detailEl || !batch) return

  const partyLabel = batch.direction === 'received' ? 'فرستنده' : 'گیرنده'
  const party = batch.counterpartName || batch.counterpartPhone || '—'

  const rows = batch.customers.map(c => {
    const phone = c.phone || '—'
    const name = c.name || c.customerId
    return `
      <tr class="clickable-row" onclick="app.openCustomerFromTransfer('${escapeAttr(c.customerId)}')">
        <td style="font-family:monospace;direction:ltr;text-align:right;">${escapeHtml(phone)}</td>
        <td>${escapeHtml(name)}</td>
        <td style="font-size:11px;color:var(--text-muted);">${escapeHtml(c.customerId)}</td>
      </tr>`
  }).join('')

  detailEl.innerHTML = `
    <div class="transfer-inbox-detail-head">
      <div><strong>${escapeHtml(batch.dateTime)}</strong></div>
      <div style="font-size:13px;margin-top:4px;">${partyLabel}: ${escapeHtml(party)}</div>
      <div style="font-size:12px;color:var(--text-muted);margin-top:4px;">
        ${escapeHtml(batch.reasonLabel)} · ${batch.count} شماره
      </div>
    </div>
    <div class="table-wrapper" style="max-height:280px;overflow:auto;margin-top:12px;">
      <table>
        <thead>
          <tr>
            <th>شماره</th>
            <th>نام</th>
            <th>شناسه</th>
          </tr>
        </thead>
        <tbody>${rows || '<tr><td colspan="3">موردی نیست</td></tr>'}</tbody>
      </table>
    </div>`
}

export async function openCustomerFromTransfer(customerId) {
  if (!customerId) return
  closeTransferInbox()
  if (typeof window !== 'undefined' && typeof window.app?.openCustomerDetail === 'function') {
    await window.app.openCustomerDetail(customerId)
  }
}
