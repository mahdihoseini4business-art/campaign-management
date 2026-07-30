import { getData, deleteCustomerFromDB, deleteFollowupFromDB, saveCustomerToDB } from './data.js'
import { showToast, requirePermission, hasPermission, canTransferCustomer, normalizePhone, escapeHtml, escapeAttr, userDisplayName, resolveAdvisor } from './utils.js'
import { renderCustomers, reassignCustomerOwnership } from './customers.js'
import { renderFollowups } from './followups.js'
import { renderSales } from './sales.js'
import { getUsersSafe } from './auth.js'

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

export async function openBulkTransferModal(ids) {
  pendingTransferIds = ids || []
  const modal = document.getElementById('bulkTransferModal')
  const countEl = document.getElementById('bulkTransferCount')
  const selectEl = document.getElementById('bulkTransferAdvisor')
  const reasonEl = document.getElementById('bulkTransferReason')
  if (!modal || !selectEl) return

  if (countEl) countEl.textContent = String(pendingTransferIds.length)
  if (reasonEl) reasonEl.value = 'distribution'

  const users = await getUsersSafe()
  selectEl.innerHTML = '<option value="">انتخاب کارشناس مقصد...</option>' +
    users.filter(u => u.phone).map(u => {
      const phone = normalizePhone(u.phone)
      return `<option value="${escapeAttr(phone)}">${escapeHtml(userDisplayName(u) || u.username)} · ${escapeHtml(phone)}</option>`
    }).join('')

  modal.classList.add('active')
}

export function closeBulkTransferModal() {
  const modal = document.getElementById('bulkTransferModal')
  if (modal) modal.classList.remove('active')
  pendingTransferIds = []
}

export async function confirmBulkTransfer() {
  const selectEl = document.getElementById('bulkTransferAdvisor')
  const reasonEl = document.getElementById('bulkTransferReason')
  const toPhone = normalizePhone(selectEl?.value || '')
  if (!toPhone) {
    showToast('کارشناس مقصد را انتخاب کنید')
    return
  }

  const ids = [...pendingTransferIds]
  if (ids.length === 0) {
    showToast('هیچ موردی انتخاب نشده')
    closeBulkTransferModal()
    return
  }

  const users = await getUsersSafe()
  const { advisor, advisorPhone } = resolveAdvisor(toPhone, users)
  if (!advisorPhone) {
    showToast('کارشناس مقصد نامعتبر است')
    return
  }

  const reason = (reasonEl?.value || 'distribution').trim() || 'distribution'
  const batchId = `batch_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  const data = getData()

  let transferred = 0
  let skipped = 0
  let denied = 0

  const confirmBtn = document.getElementById('bulkTransferConfirmBtn')
  if (confirmBtn) {
    confirmBtn.disabled = true
    confirmBtn.textContent = 'در حال انتقال...'
  }

  try {
    for (const id of ids) {
      const customer = data.customers.find(c => c.id === id)
      if (!customer) { skipped++; continue }
      if (!canTransferCustomer(customer)) { denied++; continue }
      if (normalizePhone(customer.advisorPhone) === advisorPhone) { skipped++; continue }
      try {
        const result = await reassignCustomerOwnership({
          customer,
          toAdvisor: advisor,
          toAdvisorPhone: advisorPhone,
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

  const parts = [`${transferred} منتقل شد`]
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
