import './styles.css'
import { toEnDigits, initDigitConversion, hasPermission, hasAnyRefundPermission, jalaliToNum, showToast, escapeAttr, getStatusOrder, toggleToolbarActions, closeAllToolbarActions, initToolbarActionsMenus, getPrimaryPhone, copyToClipboard } from './utils.js'
import { getData, loadData, backfillAdvisorPhones, cleanupConversionOrphans } from './data.js'
import { seedAdmin, doLogin, doLogout, checkSession, applyPermissions, openSettingsModal as openSettingsModalBase, closeSettingsModal, addUser, deleteUser, saveUserPermissions, togglePermCheckbox, togglePermGroup, toggleProfileMenu, initProfileMenu, getUsers, getUsersSafe, debugListUsers, debugCreateTestUser, toggleSettingsUserRow, selectSettingsUser, filterSettingsUsers, backToUsersList, markPermissionsDirty, switchSettingsSection, filterSettingsNav, addDestinationBank, removeDestinationBank, startDestinationBankEdit, cancelDestinationBankEdit, saveDestinationBankEdit, addProductCatalogItem, removeProductCatalogItem, startProductCatalogEdit, cancelProductCatalogEdit, saveProductCatalogEdit, onNewProductKindChange, onEditProductKindChange, onNewProductProfitModeChange, onEditProductProfitModeChange, startProductBundleEdit, cancelProductBundleEdit, saveProductBundleForm, removeProductBundle, runCatalogToBundleMigration, filterViewUserOptions, changeUserGroupAssignment, createSettingsGroup, renameSettingsGroup, deleteSettingsGroup, selectSettingsGroup, backToGroupsList, addSettingsGroupMember, removeSettingsGroupMember, makeGroupManager, addPlatform, removePlatform, updatePlatformField, editPlatform, cancelPlatformEdit, savePlatformEdit, addStatus, removeStatus, updateStatusField, editStatus, cancelStatusEdit, saveStatusEdit, onStatusDragStart, onStatusDragOver, onStatusDrop, onSalesTargetMetricChange, onSalesTargetAllocationChange, onSalesTargetDeadlineChange, addDeadlineUrgencyStage, removeDeadlineUrgencyStage, saveDeadlineUrgencySettings, startSalesTargetEdit, cancelSalesTargetEdit, saveSalesTargetForm, removeSalesTarget, renderSalesTargetsSettings, addSalesTargetBarToDraft, removeSalesTargetBarFromDraft, saveSmsPanelSettings, resetSmsMessageTemplate } from './auth.js'
import { renderCustomers, updateStats, openCustomerModal, closeCustomerModal, saveCustomer, saveCustomerDetail, editCustomer, deleteCustomer, closeDeleteModal, openCustomerDetail, onCustomerRowClick, closeDetailModal, switchDetailTab, setNextFollowup, clearNextFollowup, addQuickNote, updateCustomerAdvisor, updateCustomerLevel, addProductRow, removeProduct, onCustomerPhoneInput, addCustomerPhoneSlot, removeCustomerPhoneSlot, onCustomerAddressInput, onCustomerAddressPriorityChange, addCustomerAddressSlot, removeCustomerAddressSlot, addProductPayment, removeProductPayment, onDestinationBankSelect, commitSalePayment, commitSaleProductDetails, commitGiftSale, onSaleProductNameChange, onSalePriceInput, markSalePaymentTouched, toggleClosedProductBlock, openStartSaleModal, closeStartSaleModal, confirmStartSale, filterStartSaleCustomers, closeMergeCustomerModal, confirmMergeCustomers } from './customers.js'
import { renderFollowups, openFollowupModal, closeFollowupModal, saveFollowup, editFollowup, deleteFollowup, setFollowupFilter, clearFollowupSearch, openFollowupDoneModal, closeFollowupDoneModal, confirmFollowupDone, openFollowupDonePicker, closeFollowupDonePicker, filterFollowupDonePick, confirmFollowupDonePick, setFollowupDoneNextShortcut, isFollowupDoneNoteDirty, updateFollowupBadge } from './followups.js'
import { renderSales, sortSales } from './sales.js'
import { renderProductMatrix, cycleProductMatrixFilter, clearProductMatrixFilters, toggleProductMatrixAdvisorDropdown, toggleProductMatrixAdvisor, toggleProductMatrixAdvisorsAll } from './product-matrix.js'
import { renderAccounting, setAccountingFilter, toggleAccountingBankBalances, approvePayment, approveGiftSale, requestUnapprovePayment, requestUnapproveGiftSale, openRejectPaymentModal, openEditRejectReasonModal, closeRejectPaymentModal, confirmRejectPayment, onRejectReasonPresetClick, onRejectReasonInput } from './accounting.js'
import { renderShipments, setShipmentsFilter, openConfirmShipmentModal, closeConfirmShipmentModal, confirmShipment } from './shipments.js'
import {
  renderRefunds, setRefundsView, openRefundWizard, closeRefundWizard, refundWizardBack, refundWizardNext,
  onRefundWizardCustomerSearch, selectRefundWizardCustomer, selectRefundWizardPayment, setRefundWizardFullAmount,
  onRefundWizardReasonClick,
  onRefundCardPointerDown, onRefundStatusSelect,
  onRefundShebaInput, onRefundCardInput, onRefundDigitFieldKeydown,
  openCompleteRefundModal, closeCompleteRefundModal, confirmCompleteRefund,
  openRejectRefundModal, closeRejectRefundModal, confirmRejectRefund, archiveRefund
} from './refunds.js'
import { renderDashboard, toggleDashSection, applyDashFilter, clearDashFilter, toggleDashUserDropdown, toggleDashUser, toggleDashGroup, toggleDashUsersAll, onSalesChartControlsChange, applySalesChart, onAdvisorCompareMetricChange, onProductChartMetricChange, onDashTargetsScopeChange, renderSalesTargetBand, onAovMaControlsChange, exportDashboardForAi, copyDashboardExport } from './dashboard.js'
import { exportTabCSV, exportTabXLSX, openImportModal, closeImportModal, doImport, setImportMapping, setFollowupImportMapping, initImportListeners, openSalesImportModal, closeSalesImportModal, doSalesImport, setSalesImportMapping, setSalesAmountUnit, setSalesProductValueMap, setSalesDestinationValueMap, setSalesStatusValueMap, setSalesAdvisorValueMap, downloadSalesImportProblems, initSalesImportListeners } from './import-export.js'
import { toggleSelectAll, toggleRowSelect, executeBulkAction, clearSelection, openBulkTransferModal, closeBulkTransferModal, confirmBulkTransfer, refreshCustomerBulkOptions, updateBulkTransferPreview, filterBulkTransferOptions } from './bulk.js'
import {
  openTransferInbox,
  closeTransferInbox,
  setTransferInboxTab,
  openTransferBatchDetail,
  openCustomerFromTransfer,
  updateTransferInboxBadge
} from './transfers.js'
import {
  toggleNotificationMenu,
  initNotificationMenu,
  refreshNotifications,
  sendNotification,
  filterNotifRecipients,
  toggleAllNotifRecipients,
  updateNotifRecipientCount,
  toggleNotifGroup,
  onNotifRecipientChange,
  renderNotificationAdminSection,
  closeNotificationMenu,
  openNotificationDetail,
  closeNotificationDetail,
  deleteNotification,
  setNotifMessageMode,
  updateNotifMessagePreview
} from './notifications.js'
import { initSaleToastFeed, toggleSaleToastSetting, syncSaleToastToggleUi } from './sale-toasts.js'
import { initLiveSync } from './live-sync.js'
import { initAppUpdate } from './app-update.js'
import {
  initBrowserNotifications,
  syncBrowserNotifUi,
  dismissBrowserNotifBanner,
  requestBrowserNotificationPermission,
  getNotificationPermission
} from './browser-notifications.js'
import { setPage } from './pagination.js'

// ============================================
// Tab Switching
// ============================================

function switchTab(tab, el) {
  const permMap = { dashboard: 'dashboard', customers: 'customers_view', followups: 'followups_view', sales: 'sales_view', products: 'products_matrix', accounting: 'accounting' }
  if (tab === 'refunds') {
    if (!hasAnyRefundPermission()) return
  } else if (permMap[tab] && !hasPermission(permMap[tab])) {
    return
  }

  document.querySelectorAll('.tab').forEach(t => {
    t.classList.remove('active')
    t.setAttribute('aria-selected', 'false')
    t.setAttribute('tabindex', '-1')
  })
  document.querySelectorAll('.sheet').forEach(s => {
    s.classList.remove('active')
    s.hidden = true
  })

  const activeTab = el || document.querySelector(`.tab-${tab}`) || document.getElementById(`tab-${tab}`)
  if (activeTab) {
    activeTab.classList.add('active')
    activeTab.setAttribute('aria-selected', 'true')
    activeTab.setAttribute('tabindex', '0')
  }

  const sheet = document.getElementById('sheet-' + tab)
  if (sheet) {
    sheet.classList.add('active')
    sheet.hidden = false
  }

  const dropdown = document.getElementById('profileDropdown')
  if (dropdown) {
    dropdown.classList.remove('active')
    dropdown.hidden = true
    document.getElementById('profileMenuBtn')?.setAttribute('aria-expanded', 'false')
  }

  if (tab === 'dashboard') renderDashboard()
  if (tab === 'followups') renderFollowups()
  if (tab === 'sales') renderSales()
  if (tab === 'products') renderProductMatrix()
  if (tab === 'accounting') renderAccounting()
  if (tab === 'shipments') renderShipments()
  if (tab === 'refunds') renderRefunds()
}

/** Rightmost accessible tab in RTL = first visible tab in DOM order. */
function openDefaultAccessibleTab() {
  const tab = [...document.querySelectorAll('.tab')].find(t => t.style.display !== 'none')
  if (!tab) return
  const name = tab.id?.replace(/^tab-/, '') || tab.className.match(/tab-(\w+)/)?.[1]
  if (name) switchTab(name, tab)
}

// ============================================
// Sort Functions
// ============================================

let customerSortState = { field: null, asc: true }
let followupSortState = { field: null, asc: true }
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
      const so = getStatusOrder()
      const orderA = so.indexOf(va)
      const orderB = so.indexOf(vb)
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
    } else if (field === 'customerPhone') {
      const ca = data.customers.find(c => c.id === a.customerId)
      const cb = data.customers.find(c => c.id === b.customerId)
      va = getPrimaryPhone(ca) || ''
      vb = getPrimaryPhone(cb) || ''
    } else if (field === 'advisor') {
      va = (data.customers.find(c => c.id === a.customerId) || {}).advisor || ''
      vb = (data.customers.find(c => c.id === b.customerId) || {}).advisor || ''
    }
    return followupSortState.asc ? String(va).localeCompare(String(vb), 'fa') : String(vb).localeCompare(String(va), 'fa')
  })
  renderFollowups()
}

function goToPage(key, page) {
  if (page < 1) return
  setPage(key, page)
  const renderers = {
    customers: renderCustomers,
    followups: renderFollowups,
    sales: renderSales,
    productMatrix: renderProductMatrix,
    accounting: renderAccounting,
    shipments: renderShipments
  }
  renderers[key]?.()
}

// ============================================
// Single app namespace (QC-H1: avoid polluting window)
// ============================================

async function openSettingsModal() {
  await openSettingsModalBase()
  if (!document.getElementById('settingsModal')?.classList.contains('active')) return
  await renderNotificationAdminSection()
  syncSaleToastToggleUi()
  syncBrowserNotifUi()
}

async function enableBrowserNotifications() {
  const profileDropdown = document.getElementById('profileDropdown')
  if (profileDropdown) {
    profileDropdown.classList.remove('active')
    profileDropdown.hidden = true
    document.getElementById('profileMenuBtn')?.setAttribute('aria-expanded', 'false')
  }

  const current = getNotificationPermission()
  if (current === 'granted') {
    showToast('اعلان مرورگر فعال است')
    syncBrowserNotifUi()
    return
  }
  if (current === 'denied') {
    showToast('اعلان‌ها در تنظیمات مرورگر مسدود است — از آیکون قفل کنار آدرس اجازه دهید')
    syncBrowserNotifUi()
    return
  }
  if (current === 'unsupported') {
    showToast('این مرورگر از اعلان دسکتاپ پشتیبانی نمی‌کند')
    syncBrowserNotifUi()
    return
  }
  const result = await requestBrowserNotificationPermission()
  if (result === 'granted') showToast('اعلان مرورگر فعال شد')
  else if (result === 'denied') showToast('اجازه اعلان داده نشد')
}

const app = {
  openCustomerDetail,
  onCustomerRowClick,
  switchDetailTab,
  editCustomer,
  deleteCustomer,
  openCustomerModal,
  saveCustomer,
  saveCustomerDetail,
  closeCustomerModal,
  onCustomerPhoneInput,
  addCustomerPhoneSlot,
  removeCustomerPhoneSlot,
  onCustomerAddressInput,
  onCustomerAddressPriorityChange,
  addCustomerAddressSlot,
  removeCustomerAddressSlot,
  openFollowupModal,
  saveFollowup,
  closeFollowupModal,
  editFollowup,
  deleteFollowup,
  setFollowupFilter,
  clearFollowupSearch,
  openFollowupDoneModal,
  closeFollowupDoneModal,
  confirmFollowupDone,
  openFollowupDonePicker,
  closeFollowupDonePicker,
  filterFollowupDonePick,
  confirmFollowupDonePick,
  setFollowupDoneNextShortcut,
  isFollowupDoneNoteDirty,
  setNextFollowup,
  clearNextFollowup,
  addQuickNote,
  updateCustomerAdvisor,
  updateCustomerLevel,
  addProductRow,
  addProductPayment,
  commitSalePayment,
  commitSaleProductDetails,
  commitGiftSale,
  onSaleProductNameChange,
  onSalePriceInput,
  markSalePaymentTouched,
  toggleClosedProductBlock,
  openStartSaleModal,
  closeStartSaleModal,
  confirmStartSale,
  filterStartSaleCustomers,
  onDestinationBankSelect,
  removeProductPayment,
  removeProduct,
  closeDetailModal,
  closeDeleteModal,
  closeMergeCustomerModal,
  confirmMergeCustomers,
  exportTabCSV,
  exportTabXLSX,
  openImportModal,
  closeImportModal,
  doImport,
  setImportMapping,
  setFollowupImportMapping,
  openSalesImportModal,
  closeSalesImportModal,
  toggleToolbarActions,
  closeAllToolbarActions,
  doSalesImport,
  setSalesImportMapping,
  setSalesAmountUnit,
  setSalesProductValueMap,
  setSalesDestinationValueMap,
  setSalesStatusValueMap,
  setSalesAdvisorValueMap,
  downloadSalesImportProblems,
  doLogin,
  showToast,
  hasPermission,
  doLogout,
  openSettingsModal,
  closeSettingsModal,
  addUser,
  deleteUser,
  saveUserPermissions,
  togglePermCheckbox,
  togglePermGroup,
  toggleSettingsUserRow,
  selectSettingsUser,
  filterSettingsUsers,
  backToUsersList,
  markPermissionsDirty,
  switchSettingsSection,
  filterSettingsNav,
  filterViewUserOptions,
  changeUserGroupAssignment,
  createSettingsGroup,
  renameSettingsGroup,
  deleteSettingsGroup,
  selectSettingsGroup,
  backToGroupsList,
  addSettingsGroupMember,
  removeSettingsGroupMember,
  makeGroupManager,
  addDestinationBank,
  removeDestinationBank,
  startDestinationBankEdit,
  cancelDestinationBankEdit,
  saveDestinationBankEdit,
  addProductCatalogItem,
  removeProductCatalogItem,
  startProductCatalogEdit,
  cancelProductCatalogEdit,
  saveProductCatalogEdit,
  onNewProductKindChange,
  onEditProductKindChange,
  onNewProductProfitModeChange,
  onEditProductProfitModeChange,
  startProductBundleEdit,
  cancelProductBundleEdit,
  saveProductBundleForm,
  removeProductBundle,
  runCatalogToBundleMigration,
  renderSalesTargetsSettings,
  onSalesTargetMetricChange,
  onSalesTargetAllocationChange,
  onSalesTargetDeadlineChange,
  addDeadlineUrgencyStage,
  removeDeadlineUrgencyStage,
  saveDeadlineUrgencySettings,
  startSalesTargetEdit,
  cancelSalesTargetEdit,
  saveSalesTargetForm,
  removeSalesTarget,
  addSalesTargetBarToDraft,
  removeSalesTargetBarFromDraft,
  saveSmsPanelSettings,
  resetSmsMessageTemplate,
  addPlatform,
  removePlatform,
  updatePlatformField,
  editPlatform,
  cancelPlatformEdit,
  savePlatformEdit,
  addStatus,
  removeStatus,
  updateStatusField,
  editStatus,
  cancelStatusEdit,
  saveStatusEdit,
  onStatusDragStart,
  onStatusDragOver,
  onStatusDrop,
  toggleProfileMenu,
  switchTab,
  sortCustomers,
  sortFollowups,
  sortSales,
  toggleDashSection,
  clearDashFilter,
  applyDashFilter,
  exportDashboardForAi,
  copyDashboardExport,
  toggleDashUserDropdown,
  toggleDashUser,
  toggleDashGroup,
  toggleDashUsersAll,
  onSalesChartControlsChange,
  applySalesChart,
  onAdvisorCompareMetricChange,
  onProductChartMetricChange,
  onAovMaControlsChange,
  onDashTargetsScopeChange,
  renderSalesTargetBand,
  renderDashboard,
  renderCustomers,
  renderFollowups,
  renderProductMatrix,
  cycleProductMatrixFilter,
  clearProductMatrixFilters,
  toggleProductMatrixAdvisorDropdown,
  toggleProductMatrixAdvisor,
  toggleProductMatrixAdvisorsAll,
  renderSales,
  renderAccounting,
  setAccountingFilter,
  toggleAccountingBankBalances,
  renderShipments,
  setShipmentsFilter,
  renderRefunds,
  setRefundsView,
  openRefundWizard,
  closeRefundWizard,
  refundWizardBack,
  refundWizardNext,
  onRefundWizardCustomerSearch,
  selectRefundWizardCustomer,
  selectRefundWizardPayment,
  setRefundWizardFullAmount,
  onRefundWizardReasonClick,
  onRefundCardPointerDown,
  onRefundStatusSelect,
  onRefundShebaInput,
  onRefundCardInput,
  onRefundDigitFieldKeydown,
  openCompleteRefundModal,
  closeCompleteRefundModal,
  confirmCompleteRefund,
  openRejectRefundModal,
  closeRejectRefundModal,
  confirmRejectRefund,
  archiveRefund,
  goToPage,
  approvePayment,
  approveGiftSale,
  requestUnapprovePayment,
  requestUnapproveGiftSale,
  openRejectPaymentModal,
  openEditRejectReasonModal,
  closeRejectPaymentModal,
  confirmRejectPayment,
  onRejectReasonPresetClick,
  onRejectReasonInput,
  openConfirmShipmentModal,
  closeConfirmShipmentModal,
  confirmShipment,
  copyToClipboard,
  toggleSelectAll,
  toggleRowSelect,
  executeBulkAction,
  clearSelection,
  openBulkTransferModal,
  closeBulkTransferModal,
  confirmBulkTransfer,
  updateBulkTransferPreview,
  filterBulkTransferOptions,
  openTransferInbox,
  closeTransferInbox,
  setTransferInboxTab,
  openTransferBatchDetail,
  openCustomerFromTransfer,
  updateTransferInboxBadge,
  toggleNotificationMenu,
  sendNotification,
  filterNotifRecipients,
  toggleAllNotifRecipients,
  updateNotifRecipientCount,
  toggleNotifGroup,
  onNotifRecipientChange,
  openNotificationDetail,
  closeNotificationDetail,
  deleteNotification,
  setNotifMessageMode,
  updateNotifMessagePreview,
  toggleSaleToastSetting,
  enableBrowserNotifications,
  dismissBrowserNotifBanner,
  formatInput: (el) => {
    let raw = el.value.replace(/[^\d]/g, '')
    el.value = raw ? Number(raw).toLocaleString('en-US') : ''
  },
  unformatInput: (el) => el.value.replace(/[^\d]/g, ''),
  sortCustomersHeader: (field) => sortCustomers(field),
  sortFollowupsHeader: (field) => sortFollowups(field),
  sortSalesHeader: (field) => sortSales(field),
  debugListUsers,
  debugCreateTestUser
}

window.app = app

// ============================================
// Modal focus trap (A11Y-H3)
// ============================================

const FOCUSABLE_SELECTOR = 'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
const modalFocusMemory = new WeakMap()
const MODAL_BASE_Z = 1000
let modalStackTop = MODAL_BASE_Z
let modalScrollLockY = 0

function getFocusableElements(container) {
  return [...container.querySelectorAll(FOCUSABLE_SELECTOR)].filter(el => {
    if (el.closest('[hidden]')) return false
    if (el.getAttribute('aria-hidden') === 'true') return false
    return el.offsetParent !== null || el === document.activeElement
  })
}

function getActiveModalOverlays() {
  return [...document.querySelectorAll('.modal-overlay.active')]
}

function syncBodyScrollLock() {
  const shouldLock = getActiveModalOverlays().length > 0
  const body = document.body
  const isLocked = body.classList.contains('modal-open')

  if (shouldLock === isLocked) return

  if (shouldLock) {
    modalScrollLockY = window.scrollY || document.documentElement.scrollTop || 0
    body.classList.add('modal-open')
    body.style.top = `-${modalScrollLockY}px`
  } else {
    body.classList.remove('modal-open')
    body.style.top = ''
    window.scrollTo(0, modalScrollLockY)
  }
}

function getTopmostModalOverlay() {
  const active = getActiveModalOverlays()
  if (!active.length) return null
  return active.reduce((top, el) => {
    const z = parseInt(el.style.zIndex, 10) || MODAL_BASE_Z
    const topZ = parseInt(top.style.zIndex, 10) || MODAL_BASE_Z
    return z >= topZ ? el : top
  })
}

function bringModalToFront(overlay) {
  modalStackTop += 10
  overlay.style.zIndex = String(modalStackTop)
}

function syncModalStackTop() {
  const active = getActiveModalOverlays()
  modalStackTop = active.reduce((max, el) => {
    const z = parseInt(el.style.zIndex, 10) || MODAL_BASE_Z
    return Math.max(max, z)
  }, MODAL_BASE_Z)
}

function activateModalTrap(overlay) {
  bringModalToFront(overlay)

  const dialog = overlay.querySelector('.modal') || overlay
  modalFocusMemory.set(overlay, document.activeElement)

  if (!dialog.hasAttribute('role')) dialog.setAttribute('role', 'dialog')
  dialog.setAttribute('aria-modal', 'true')

  const focusable = getFocusableElements(dialog)
  ;(focusable[0] || dialog).focus()

  function onKeyDown(e) {
    if (e.key !== 'Tab') return
    const items = getFocusableElements(dialog)
    if (!items.length) {
      e.preventDefault()
      return
    }
    const first = items[0]
    const last = items[items.length - 1]
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault()
      first.focus()
    }
  }

  overlay._focusTrapHandler = onKeyDown
  overlay.addEventListener('keydown', onKeyDown)
}

function deactivateModalTrap(overlay) {
  if (overlay._focusTrapHandler) {
    overlay.removeEventListener('keydown', overlay._focusTrapHandler)
    delete overlay._focusTrapHandler
  }
  overlay.style.zIndex = ''
  syncModalStackTop()
  const prev = modalFocusMemory.get(overlay)
  modalFocusMemory.delete(overlay)
  if (prev && typeof prev.focus === 'function') {
    try { prev.focus() } catch (_) {}
  }
}

function initModalFocusTrap() {
  document.querySelectorAll('.modal-overlay').forEach(overlay => {
    let wasActive = overlay.classList.contains('active')
    if (wasActive) activateModalTrap(overlay)
    const observer = new MutationObserver(() => {
      const isActive = overlay.classList.contains('active')
      if (isActive && !wasActive) activateModalTrap(overlay)
      else if (!isActive && wasActive) deactivateModalTrap(overlay)
      wasActive = isActive
      syncBodyScrollLock()
    })
    observer.observe(overlay, { attributes: true, attributeFilter: ['class'] })
  })
  syncBodyScrollLock()
}

// ============================================
// Init
// ============================================

async function init() {
  initDigitConversion()
  initProfileMenu()
  initNotificationMenu()
  initToolbarActionsMenus()
  initImportListeners()
  initSalesImportListeners()
  initAppUpdate().catch(e => console.error('app update init error:', e))

  // Show loading overlay
  const loadingOverlay = document.getElementById('loadingOverlay')
  if (loadingOverlay) loadingOverlay.style.display = 'flex'

  // Check session - verify signature + revalidate privileges from server
  const user = await checkSession()
  if (!user) {
    if (loadingOverlay) loadingOverlay.style.display = 'none'
    return
  }

  // Seed admin if needed (safe — never wipes existing users)
  await seedAdmin()

  // Load data from Supabase
  await loadData()

  // Backfill advisorPhone from display names for legacy rows
  try {
    const users = await getUsersSafe()
    const { updated } = await backfillAdvisorPhones(users)
    if (updated > 0) console.log(`Backfilled advisorPhone on ${updated} customers`)
  } catch (e) {
    console.error('advisorPhone backfill error:', e)
  }

  try {
    const { merged } = await cleanupConversionOrphans()
    if (merged > 0) console.log(`Cleaned ${merged} leftover LD/CS conversion duplicates`)
  } catch (e) {
    console.error('conversion orphan cleanup error:', e)
  }

  // Hide loading overlay
  if (loadingOverlay) loadingOverlay.style.display = 'none'

  try { applyPermissions() } catch (e) { console.error('applyPermissions error:', e) }
  try { openDefaultAccessibleTab() } catch (e) { console.error('openDefaultAccessibleTab error:', e) }
  try { refreshCustomerBulkOptions() } catch (e) { console.error('refreshCustomerBulkOptions error:', e) }
  try { updateTransferInboxBadge() } catch (e) { console.error('updateTransferInboxBadge error:', e) }
  try { renderSalesTargetBand() } catch (e) { console.error('renderSalesTargetBand error:', e) }
  refreshNotifications().catch(e => console.error('notifications init error:', e))
  initSaleToastFeed().catch(e => console.error('sale toast init error:', e))
  initLiveSync().catch(e => console.error('live sync init error:', e))
  try { initBrowserNotifications() } catch (e) { console.error('browser notifications init error:', e) }

  // Modal accessibility: focus trap + aria (A11Y-H3)
  initModalFocusTrap()

  // Dashboard collapsible keyboard support (A11Y-H4)
  document.querySelectorAll('.dash-collapsible[role="button"]').forEach(el => {
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        el.click()
      }
    })
  })

  // Modal close on overlay click (only the clicked overlay)
  document.querySelectorAll('.modal-overlay').forEach(overlay => {
    overlay.addEventListener('click', function (e) {
      if (e.target !== this) return
      if (this.id === 'followupDoneModal' && isFollowupDoneNoteDirty()) {
        showToast('یادداشت نیمه‌نوشته است — برای بستن از انصراف استفاده کنید')
        return
      }
      this.classList.remove('active')
    })
  })

  // Escape closes only the topmost modal so nested confirms stay usable
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return
    const top = getTopmostModalOverlay()
    if (top) {
      e.preventDefault()
      if (top.id === 'followupDoneModal' && isFollowupDoneNoteDirty()) {
        showToast('یادداشت نیمه‌نوشته است — برای بستن از انصراف استفاده کنید')
        return
      }
      if (top.id === 'settingsModal') closeSettingsModal()
      else top.classList.remove('active')
    }
    closeNotificationMenu()
  })

  // Tablist keyboard navigation (A11Y-H1)
  document.querySelector('.tabs')?.addEventListener('keydown', (e) => {
    const tabs = [...document.querySelectorAll('.tab:not([style*="display: none"])')]
    const idx = tabs.indexOf(document.activeElement)
    if (idx < 0) return

    let nextIdx = -1
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault()
      // RTL: ArrowLeft moves forward visually
      const delta = e.key === 'ArrowLeft' ? 1 : -1
      nextIdx = (idx + delta + tabs.length) % tabs.length
    } else if (e.key === 'Home') {
      e.preventDefault()
      nextIdx = 0
    } else if (e.key === 'End') {
      e.preventDefault()
      nextIdx = tabs.length - 1
    }

    if (nextIdx >= 0) {
      const tab = tabs[nextIdx]
      const name = tab.id?.replace(/^tab-/, '') || tab.className.match(/tab-(\w+)/)?.[1]
      if (name) switchTab(name, tab)
      tab.focus()
    }
  })

  // Init jalali datepicker (zIndex above modal stack; modals start at 1000 and rise)
  if (typeof jalaliDatepicker !== 'undefined' && jalaliDatepicker?.startWatch) {
    jalaliDatepicker.startWatch({
      selector: 'input[data-jdp]',
      autoShow: true,
      autoHide: true,
      hideAfterChange: true,
      showTodayBtn: true,
      showEmptyBtn: true,
      position: 'center',
      persianDigits: false,
      zIndex: 11000
    })
  } else {
    console.warn('jalaliDatepicker not loaded')
  }

  // Bulk action listeners
  document.getElementById('bulkActionCustomers')?.addEventListener('change', () => executeBulkAction('customers'))
  document.getElementById('bulkActionFollowups')?.addEventListener('change', () => executeBulkAction('followups'))
  document.getElementById('bulkActionSales')?.addEventListener('change', () => executeBulkAction('sales'))

  // Render all
  try { await renderCustomers() } catch (e) { console.error('renderCustomers error:', e) }
  try { renderFollowups() } catch (e) { console.error('renderFollowups error:', e) }
  try { renderSales() } catch (e) { console.error('renderSales error:', e) }
  try { renderDashboard() } catch (e) { console.error('renderDashboard error:', e) }
}

init().catch(err => {
  console.error('Init error:', err)
  const loadingOverlay = document.getElementById('loadingOverlay')
  if (loadingOverlay) loadingOverlay.style.display = 'none'
  const detail = (err && (err.message || String(err))) || 'خطای ناشناخته'
  document.body.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:center;min-height:100vh;padding:24px;text-align:center;font-family:Vazirmatn,sans-serif;">
      <div>
        <div style="font-size:48px;margin-bottom:16px;">⚠️</div>
        <h2 style="margin-bottom:8px;">خطا در بارگذاری برنامه</h2>
        <p style="color:#78716C;">لطفاً صفحه را رفرش کنید یا با پشتیبانی تماس بگیرید</p>
        <pre style="margin-top:16px;padding:12px;background:#f5f5f4;border-radius:8px;text-align:right;direction:ltr;font-size:12px;max-width:560px;overflow:auto;white-space:pre-wrap;color:#44403c;">${String(detail).replace(/[<>&]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]))}</pre>
        <button onclick="location.reload()" style="margin-top:16px;padding:8px 24px;background:#0155d2;color:white;border:none;border-radius:8px;cursor:pointer;font-family:inherit;">تلاش مجدد</button>
      </div>
    </div>
  `
})
