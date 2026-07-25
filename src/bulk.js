import { getData, deleteCustomerFromDB, deleteFollowupFromDB, saveCustomerToDB } from './data.js'
import { showToast } from './utils.js'
import { renderCustomers } from './customers.js'
import { renderFollowups } from './followups.js'
import { renderSales } from './sales.js'

const selectedIds = { customers: new Set(), followups: new Set(), sales: new Set() }

export function getSelectedIds(tab) {
  return selectedIds[tab]
}

export function toggleSelectAll(tab, checked) {
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
  if (actionEl) actionEl.style.display = count > 0 ? '' : 'none'
  if (countEl) {
    countEl.style.display = count > 0 ? '' : 'none'
    countEl.textContent = `${count} مورد انتخاب شده`
  }
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
    bulkDelete(tab, [...ids])
  }

  actionEl.value = ''
}

async function bulkDelete(tab, ids) {
  if (!confirm(`آیا از حذف ${ids.size} مورد مطمئن هستید؟`)) return

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

  // Re-render
  if (tab === 'customers') await renderCustomers()
  else if (tab === 'followups') await renderFollowups()
  else if (tab === 'sales') await renderSales()
}

export function clearSelection(tab) {
  selectedIds[tab].clear()
  updateBulkUI(tab)
  updateSelectAllCheckbox(tab)
  const selectAllId = `selectAll${capitalize(tab)}`
  const selectAll = document.getElementById(selectAllId)
  if (selectAll) selectAll.checked = false
}
