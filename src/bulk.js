import { getData, deleteCustomerFromDB, deleteFollowupFromDB, saveCustomerToDB, generateTransferBatchId } from './data.js'
import { showToast, requirePermission, hasPermission, canTransferCustomer, normalizePhone, escapeHtml, escapeAttr, userDisplayName, resolveAdvisor } from './utils.js'
import { renderCustomers, reassignCustomerOwnership } from './customers.js'
import { renderFollowups } from './followups.js'
import { renderSales } from './sales.js'
import { getUsersSafe } from './auth.js'
import { updateTransferInboxBadge } from './transfers.js'

const selectedIds = { customers: new Set(), followups: new Set(), sales: new Set() }

const BULK_DELETE_PERM = {
  customers: 'customers_delete',
  followups: 'followups_delete',
  sales: 'customers_add',
}

/** True if the user may select rows for any bulk action on this tab. */
function canBulkSelect(tab) {
  if (tab === 'customers') {
    return hasPermission('customers_delete') || hasPermission('customers_transfer')
  }
  const perm = BULK_DELETE_PERM[tab]
  return !perm || hasPermission(perm)
}

export function getSelectedIds(tab) {
  return selectedIds[tab]
}

export function toggleSelectAll(tab, checked) {
  if (!canBulkSelect(tab)) return
  const tbody = getTabBody(tab)
  if (!tbody) return
  const checkboxes = tbody.querySelectorAll('input[type="checkbox"]')
  checkboxes.forEach(cb => {
    cb.checked = checked
    const id = cb.dataset.id
    if (checked) {
      selectedIds[tab].add(id)
    } else {
      selectedIds[tab].delete(id)
    }
  })
  updateBulkUI(tab)
}

export function toggleRowSelect(tab, id, checked) {
  if (!canBulkSelect(tab)) return
  if (checked) {
    selectedIds[tab].add(id)
  } else {
    selectedIds[tab].delete(id)
  }
  updateBulkUI(tab)
  updateSelectAllCheckbox(tab)
}

function updateSelectAllCheckbox(tab) {
  const selectAllId = `selectAll${capitalize(tab)}`
  const selectAll = document.getElementById(selectAllId)
  if (!selectAll) return
  const tbody = getTabBody(tab)
  const checkboxes = tbody ? tbody.querySelectorAll('input[type="checkbox"]') : []
  const total = checkboxes.length
  const checked = selectedIds[tab].size
  selectAll.checked = total > 0 && checked === total
  selectAll.indeterminate = checked > 0 && checked < total
}

function updateBulkUI(tab) {
  const count = selectedIds[tab].size
  const actionId = `bulkAction${capitalize(tab)}`
  const countId = `bulkCount${capitalize(tab)}`
  const actionEl = document.getElementById(actionId)
  const countEl = document.getElementById(countId)
  if (actionEl) {
    actionEl.style.display = count > 0 ? '' : 'none'
    if (tab === 'customers') syncCustomerBulkOptions(actionEl)
  }
  if (countEl) {
    countEl.style.display = count > 0 ? '' : 'none'
    countEl.textContent = `${count} مورد انتخاب شده`
  }
}

function syncCustomerBulkOptions(actionEl) {
  if (!actionEl || actionEl.dataset.optionsReady === '1') return
  const canDelete = hasPermission('customers_delete')
  const canTransfer = hasPermission('customers_transfer')
  actionEl.innerHTML = '<option value="">عملیات دسته‌جمعی...</option>' +
    (canTransfer ? '<option value="transfer">انتقال به کارشناس</option>' : '') +
    (canDelete ? '<option value="delete">حذف انتخاب شده‌ها</option>' : '')
  actionEl.dataset.optionsReady = '1'
}

/** Call after permissions change so bulk options rebuild. */
export function refreshCustomerBulkOptions() {
  const actionEl = document.getElementById('bulkActionCustomers')
  if (!actionEl) return
  delete actionEl.dataset.optionsReady
  syncCustomerBulkOptions(actionEl)
}

function getTabBody(tab) {
  const map = { customers: 'customerBody', followups: 'followupBody', sales: 'salesBody' }
  return document.getElementById(map[tab])
}

function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

export function executeBulkAction(tab) {
  const actionEl = document.getElementById(`bulkAction${capitalize(tab)}`)
  const action = actionEl?.value
  if (!action) return

  const ids = selectedIds[tab]
  if (ids.size === 0) {
    showToast('هیچ موردی انتخاب نشده')
    return
  }

  if (action === 'delete') {
    const perm = BULK_DELETE_PERM[tab]
    if (perm && !requirePermission(perm)) {
      actionEl.value = ''
      return
    }
    bulkDelete(tab, [...ids])
  } else if (action === 'transfer' && tab === 'customers') {
    if (!requirePermission('customers_transfer')) {
      actionEl.value = ''
      return
    }
    openBulkTransferModal([...ids])
  }

  actionEl.value = ''
}

async function bulkDelete(tab, ids) {
  if (!confirm(`آیا از حذف ${ids.length} مورد مطمئن هستید؟`)) return

  const data = getData()
  let deleted = 0

  if (tab === 'customers') {
    for (const id of ids) {
      try {
        await deleteCustomerFromDB(id)
        data.customers = data.customers.filter(c => c.id !== id)
        data.followups = data.followups.filter(f => f.customerId !== id)
        deleted++
      } catch (e) {
        console.error('Bulk delete customer error:', e)
      }
    }
  } else if (tab === 'followups') {
    for (const id of ids) {
      const f = data.followups.find(x => String(x.id) === String(id) || data.followups.indexOf(x) === parseInt(id))
      if (f) {
        try {
          if (f.id) await deleteFollowupFromDB(f.id)
          data.followups = data.followups.filter(x => x !== f)
          deleted++
        } catch (e) {
          console.error('Bulk delete followup error:', e)
        }
      }
    }
  } else if (tab === 'sales') {
    for (const id of ids) {
      const customer = data.customers.find(c => c.id === id)
      if (customer && customer.products) {
        customer.products = []
        try {
          await saveCustomerToDB(customer)
          deleted++
        } catch (e) {
          console.error('Bulk delete sales error:', e)
        }
      }
    }
  }

  selectedIds[tab].clear()
  updateBulkUI(tab)
  showToast(`${deleted} مورد حذف شد`)

  if (tab === 'customers') await renderCustomers()
  else if (tab === 'followups') await renderFollowups()
  else if (tab === 'sales') await renderSales()
}

let pendingTransferIds = []

function getSelectedTransferPhones() {
  return [...document.querySelectorAll('#bulkTransferAdvisorList input[type="checkbox"]:checked')]
    .map(cb => normalizePhone(cb.value))
    .filter(Boolean)
}

/** Split `n` items across `k` buckets as evenly as possible (first buckets get the remainder). */
export function evenSplitCounts(n, k) {
  if (k <= 0) return []
  const base = Math.floor(n / k)
  const rem = n % k
  return Array.from({ length: k }, (_, i) => base + (i < rem ? 1 : 0))
}

/**
 * Assign eligible customers round-robin / even chunks to destinations.
 * Skips customers already owned by their assigned destination (tries next destination).
 */
function buildEvenAssignments(customers, destinations) {
  const assignments = [] // { customer, toPhone }
  if (!destinations.length) return assignments

  const eligible = customers.filter(c => {
    const owner = normalizePhone(c.advisorPhone)
    // Already with one of the destinations — leave as-is (not part of redistribute pool)
    return !destinations.includes(owner)
  })

  const counts = evenSplitCounts(eligible.length, destinations.length)
  let idx = 0
  for (let t = 0; t < destinations.length; t++) {
    const take = counts[t]
    for (let j = 0; j < take; j++) {
      const customer = eligible[idx++]
      if (!customer) break
      assignments.push({ customer, toPhone: destinations[t] })
    }
  }
  return assignments
}

export function filterBulkTransferOptions(query) {
  const list = document.getElementById('bulkTransferAdvisorList')
  if (!list) return
  const q = String(query || '').trim().toLowerCase()
  list.querySelectorAll('.view-users-option').forEach(el => {
    const hay = el.getAttribute('data-search') || ''
    el.style.display = !q || hay.includes(q) ? '' : 'none'
  })
}

export function updateBulkTransferPreview() {
  const preview = document.getElementById('bulkTransferPreview')
  const list = document.getElementById('bulkTransferAdvisorList')
  if (!list) return

  const phones = getSelectedTransferPhones()
  const data = getData()
  const transferable = pendingTransferIds
    .map(id => data.customers.find(c => c.id === id))
    .filter(c => c && canTransferCustomer(c))

  const destSet = new Set(phones)
  const alreadyThere = transferable.filter(c => destSet.has(normalizePhone(c.advisorPhone))).length
  const toDistribute = Math.max(0, transferable.length - alreadyThere)
  const counts = evenSplitCounts(toDistribute, phones.length)
  const shareByPhone = new Map(phones.map((phone, i) => [phone, counts[i] ?? 0]))

  list.querySelectorAll('.view-users-option').forEach(el => {
    const cb = el.querySelector('input[type="checkbox"]')
    const shareEl = el.querySelector('.bulk-transfer-share')
    if (!cb || !shareEl) return
    if (cb.checked) {
      const n = shareByPhone.get(normalizePhone(cb.value)) ?? 0
      shareEl.textContent = `${n} سهم`
      shareEl.hidden = false
      el.classList.add('is-selected')
    } else {
      shareEl.textContent = ''
      shareEl.hidden = true
      el.classList.remove('is-selected')
    }
  })

  if (!preview) return
  if (phones.length === 0) {
    preview.textContent = 'حداقل یک کارشناس مقصد انتخاب کنید.'
    return
  }
  let text = `${toDistribute} مورد بین ${phones.length} کارشناس تقسیم می‌شود`
  if (alreadyThere) text += ` · ${alreadyThere} مورد از قبل نزد مقصدهاست و جابه‌جا نمی‌شود`
  preview.textContent = text
}

export async function openBulkTransferModal(ids) {
  pendingTransferIds = ids || []
  const modal = document.getElementById('bulkTransferModal')
  const countEl = document.getElementById('bulkTransferCount')
  const listEl = document.getElementById('bulkTransferAdvisorList')
  const reasonEl = document.getElementById('bulkTransferReason')
  const searchEl = document.getElementById('bulkTransferSearch')
  if (!modal || !listEl) return

  if (countEl) countEl.textContent = String(pendingTransferIds.length)
  if (reasonEl) reasonEl.value = 'distribution'
  if (searchEl) searchEl.value = ''

  const users = await getUsersSafe()
  listEl.innerHTML = users.filter(u => u.phone).map(u => {
    const phone = normalizePhone(u.phone)
    const name = userDisplayName(u) || u.username || phone
    const label = `${name} · ${phone}`
    return `<label class="view-users-option" data-search="${escapeAttr(label.toLowerCase())}">
      <input type="checkbox" value="${escapeAttr(phone)}" data-name="${escapeAttr(name)}" onchange="app.updateBulkTransferPreview()">
      <span class="bulk-transfer-name">${escapeHtml(name)}</span>
      <span class="bulk-transfer-share" hidden></span>
      <span class="view-users-phone">${escapeHtml(phone)}</span>
    </label>`
  }).join('') || '<div style="font-size:12px;color:var(--text-muted);">کاربری برای انتخاب نیست</div>'

  updateBulkTransferPreview()
  modal.classList.add('active')
}

export function closeBulkTransferModal() {
  const modal = document.getElementById('bulkTransferModal')
  if (modal) modal.classList.remove('active')
  pendingTransferIds = []
}

export async function confirmBulkTransfer() {
  const phones = getSelectedTransferPhones()
  if (phones.length === 0) {
    showToast('حداقل یک کارشناس مقصد انتخاب کنید')
    return
  }

  const ids = [...pendingTransferIds]
  if (ids.length === 0) {
    showToast('هیچ موردی انتخاب نشده')
    closeBulkTransferModal()
    return
  }

  const users = await getUsersSafe()
  const destinations = []
  for (const phone of phones) {
    const { advisor, advisorPhone } = resolveAdvisor(phone, users)
    if (!advisorPhone) continue
    destinations.push({ advisor, advisorPhone })
  }
  if (destinations.length === 0) {
    showToast('کارشناس مقصد نامعتبر است')
    return
  }

  const reasonEl = document.getElementById('bulkTransferReason')
  const reason = (reasonEl?.value || 'distribution').trim() || 'distribution'
  const batchId = generateTransferBatchId()
  const data = getData()

  const candidates = []
  let denied = 0
  let skipped = 0
  for (const id of ids) {
    const customer = data.customers.find(c => c.id === id)
    if (!customer) { skipped++; continue }
    if (!canTransferCustomer(customer)) { denied++; continue }
    candidates.push(customer)
  }

  const destPhones = destinations.map(d => d.advisorPhone)
  const assignments = buildEvenAssignments(candidates, destPhones)
  skipped += candidates.length - assignments.length

  let transferred = 0
  const confirmBtn = document.getElementById('bulkTransferConfirmBtn')
  if (confirmBtn) {
    confirmBtn.disabled = true
    confirmBtn.textContent = 'در حال انتقال...'
  }

  try {
    for (const { customer, toPhone } of assignments) {
      const dest = destinations.find(d => d.advisorPhone === toPhone)
      if (!dest) { skipped++; continue }
      try {
        const result = await reassignCustomerOwnership({
          customer,
          toAdvisor: dest.advisor,
          toAdvisorPhone: dest.advisorPhone,
          reason,
          batchId
        })
        if (result.skipped) skipped++
        else transferred++
      } catch (e) {
        console.error('Bulk transfer error:', e)
        denied++
      }
    }
  } finally {
    if (confirmBtn) {
      confirmBtn.disabled = false
      confirmBtn.textContent = 'انتقال'
    }
  }

  selectedIds.customers.clear()
  updateBulkUI('customers')
  closeBulkTransferModal()
  await renderCustomers()
  updateTransferInboxBadge()

  const destLabel = destinations.length === 1
    ? destinations[0].advisor
    : `${destinations.length} کارشناس`
  const parts = [`${transferred} منتقل شد به ${destLabel}`]
  if (denied) parts.push(`${denied} رد شد (بدون دسترسی)`)
  if (skipped) parts.push(`${skipped} بدون تغییر`)
  showToast(parts.join('، '))
}

export function clearSelection(tab) {
  selectedIds[tab].clear()
  updateBulkUI(tab)
  updateSelectAllCheckbox(tab)
  const selectAllId = `selectAll${capitalize(tab)}`
  const selectAll = document.getElementById(selectAllId)
  if (selectAll) selectAll.checked = false
}
