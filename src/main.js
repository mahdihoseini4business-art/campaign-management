import './styles.css'
import { toEnDigits, initDigitConversion, hasPermission, jalaliToNum, showToast } from './utils.js'
import { getData, loadData } from './data.js'
import { seedAdmin, doLogin, doLogout, checkSession, applyPermissions, openSettingsModal, closeSettingsModal, addUser, deleteUser, saveUserPermissions, togglePermCheckbox, toggleProfileMenu, initProfileMenu, getUsers } from './auth.js'
import { renderCustomers, updateStats, openCustomerModal, closeCustomerModal, saveCustomer, editCustomer, deleteCustomer, closeDeleteModal, openCustomerDetail, closeDetailModal, setNextFollowup, clearNextFollowup, addQuickNote, updateCustomerAdvisor, addProductRow, saveProductField, updateProduct, removeProduct } from './customers.js'
import { renderFollowups, openFollowupModal, closeFollowupModal, saveFollowup, editFollowup, deleteFollowup } from './followups.js'
import { renderSales, sortSales } from './sales.js'
import { renderDashboard, toggleDashSection, clearDashFilter } from './dashboard.js'
import { exportTabCSV, exportTabXLSX, openImportModal, closeImportModal, doImport, setImportMapping, initImportListeners, openSalesImportModal, closeSalesImportModal, doSalesImport, setSalesImportMapping, initSalesImportListeners } from './import-export.js'

// ============================================
// Tab Switching
// ============================================

function switchTab(tab, el) {
  const permMap = { dashboard: 'dashboard', customers: 'customers_view', followups: 'followups_view', sales: 'sales_view' }
  if (permMap[tab] && !hasPermission(permMap[tab])) {
    return
  }

  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'))
  document.querySelectorAll('.sheet').forEach(s => s.classList.remove('active'))
  if (el) el.classList.add('active')
  else document.querySelector(`.tab-${tab}`)?.classList.add('active')
  document.getElementById('sheet-' + tab).classList.add('active')
  document.getElementById('profileDropdown').classList.remove('active')
  if (tab === 'dashboard') renderDashboard()
  if (tab === 'sales') renderSales()
}

// ============================================
// Sort Functions
// ============================================

let customerSortState = { field: null, asc: true }
let followupSortState = { field: null, asc: true }
const STATUS_ORDER = ['new', 'contacted', 'chatting', 'interested', 'sent', 'followup_done', 'converting', 'purchased', 'cancelled']

function sortCustomers(field) {
  if (customerSortState.field === field) customerSortState.asc = !customerSortState.asc
  else { customerSortState.field = field; customerSortState.asc = true }

  const data = getData()
  data.customers = [...data.customers].sort((a, b) => {
    let va = a[field], vb = b[field]
    if (field === 'followupCount') {
      va = data.followups.filter(f => f.customerId === a.id).length
      vb = data.followups.filter(f => f.customerId === b.id).length
    }
    if (field === 'lastFollowup') {
      va = (data.followups.filter(f => f.customerId === a.id).pop() || {}).date || ''
      vb = (data.followups.filter(f => f.customerId === b.id).pop() || {}).date || ''
    }
    if (field === 'nextFollowupDate') {
      va = jalaliToNum(a.nextFollowupDate || '')
      vb = jalaliToNum(b.nextFollowupDate || '')
      return customerSortState.asc ? va - vb : vb - va
    }
    if (field === 'status') {
      const orderA = STATUS_ORDER.indexOf(va)
      const orderB = STATUS_ORDER.indexOf(vb)
      return customerSortState.asc ? orderA - orderB : orderB - orderA
    }
    if (typeof va === 'number') return customerSortState.asc ? va - vb : vb - va
    return customerSortState.asc ? String(va).localeCompare(String(vb), 'fa') : String(vb).localeCompare(String(va), 'fa')
  })
  renderCustomers()
}

function sortFollowups(field) {
  if (followupSortState.field === field) followupSortState.asc = !followupSortState.asc
  else { followupSortState.field = field; followupSortState.asc = true }

  const data = getData()
  data.followups = [...data.followups].sort((a, b) => {
    let va = a[field], vb = b[field]
    if (field === 'customerName') {
      va = (data.customers.find(c => c.id === a.customerId) || {}).name || ''
      vb = (data.customers.find(c => c.id === b.customerId) || {}).name || ''
    }
    return followupSortState.asc ? String(va).localeCompare(String(vb), 'fa') : String(vb).localeCompare(String(va), 'fa')
  })
  renderFollowups()
}

// ============================================
// Expose to window (for inline onclick handlers)
// ============================================

window.appOpenCustomerDetail = openCustomerDetail
window.appEditCustomer = editCustomer
window.appDeleteCustomer = deleteCustomer
window.appOpenCustomerModal = openCustomerModal
window.appSaveCustomer = saveCustomer
window.appCloseCustomerModal = closeCustomerModal
window.appOpenFollowupModal = openFollowupModal
window.appSaveFollowup = saveFollowup
window.appCloseFollowupModal = closeFollowupModal
window.appEditFollowup = editFollowup
window.appDeleteFollowup = deleteFollowup
window.appSetNextFollowup = setNextFollowup
window.appClearNextFollowup = clearNextFollowup
window.appAddQuickNote = addQuickNote
window.appUpdateCustomerAdvisor = updateCustomerAdvisor
window.appAddProductRow = addProductRow
window.appSaveProductField = saveProductField
window.appUpdateProduct = updateProduct
window.appRemoveProduct = removeProduct
window.appCloseDetailModal = closeDetailModal
window.appCloseDeleteModal = closeDeleteModal
window.appExportTabCSV = exportTabCSV
window.appExportTabXLSX = exportTabXLSX
window.appOpenImportModal = openImportModal
window.appCloseImportModal = closeImportModal
window.appDoImport = doImport
window.appSetImportMapping = setImportMapping
window.appOpenSalesImportModal = openSalesImportModal
window.appCloseSalesImportModal = closeSalesImportModal
window.appDoSalesImport = doSalesImport
window.appSetSalesImportMapping = setSalesImportMapping
window.appDoLogin = doLogin
window.appShowToast = showToast
window.appHasPermission = hasPermission
window.appDoLogout = doLogout
window.appOpenSettingsModal = openSettingsModal
window.appCloseSettingsModal = closeSettingsModal
window.appAddUser = addUser
window.appDeleteUser = deleteUser
window.appSaveUserPermissions = saveUserPermissions
window.appTogglePermCheckbox = togglePermCheckbox
window.appToggleProfileMenu = toggleProfileMenu
window.appSwitchTab = switchTab
window.appSortCustomers = sortCustomers
window.appSortFollowups = sortFollowups
window.appSortSales = sortSales
window.appToggleDashSection = toggleDashSection
window.appClearDashFilter = clearDashFilter
window.appRenderDashboard = renderDashboard
window.appRenderCustomers = renderCustomers
window.appRenderFollowups = renderFollowups
window.appRenderSales = renderSales
window.appFormatInput = (el) => {
  let raw = el.value.replace(/[^\d]/g, '')
  el.value = raw ? Number(raw).toLocaleString('en-US') : ''
}
window.appUnformatInput = (el) => el.value.replace(/[^\d]/g, '')

// ============================================
// Sort header onclick mapping
// ============================================

window.appSortCustomersHeader = (field) => sortCustomers(field)
window.appSortFollowupsHeader = (field) => sortFollowups(field)
window.appSortSalesHeader = (field) => sortSales(field)

// ============================================
// Init
// ============================================

async function init() {
  initDigitConversion()
  initProfileMenu()
  initImportListeners()
  initSalesImportListeners()

  // Seed admin if needed
  await seedAdmin()

  // Load data from Supabase
  await loadData()

  // Check session
  checkSession()
  applyPermissions()

  // Login handlers
  document.getElementById('loginPassword').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin() })
  document.getElementById('loginUsername').addEventListener('keydown', (e) => { if (e.key === 'Enter') document.getElementById('loginPassword').focus() })

  // Modal close on overlay click
  document.querySelectorAll('.modal-overlay').forEach(overlay => {
    overlay.addEventListener('click', function (e) {
      if (e.target === this) this.classList.remove('active')
    })
  })

  // Modal close on Escape
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      document.querySelectorAll('.modal-overlay.active').forEach(m => m.classList.remove('active'))
    }
  })

  // Init jalali datepicker
  jalaliDatepicker.startWatch({
    selector: 'input[data-jdp]',
    autoShow: true,
    autoHide: true,
    hideAfterChange: true,
    showTodayBtn: true,
    showEmptyBtn: true,
    position: 'center',
    persianDigits: false
  })

  // Render all
  try { await renderCustomers() } catch (e) { console.error('renderCustomers error:', e) }
  try { renderFollowups() } catch (e) { console.error('renderFollowups error:', e) }
  try { renderSales() } catch (e) { console.error('renderSales error:', e) }
  try { renderDashboard() } catch (e) { console.error('renderDashboard error:', e) }
}

init()
