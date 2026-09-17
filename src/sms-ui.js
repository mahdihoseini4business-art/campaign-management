import { getData, listSmsTemplates, createSmsCampaign, createSmsSchedule, cancelPendingSmsSchedulesForCustomer, cancelPendingSettlementSmsForCustomer, getFollowupSmsDefaultHour, getStatuses, getProductCatalogNames, getPlatforms, listPendingAutoSmsSchedules, listDuePendingSmsSchedules, updateSmsScheduleRow } from './data.js'
import { showToast, escapeHtml, escapeAttr, formatNumber, getCurrentUser, normalizePhone, getOperationalBalance, getPrimaryPhone, jalaliDateTimeToIso, jalaliToNum, gregorianToJalaliStr, isGiftSale, isDealCancelled, CUSTOMER_LEVELS, resolveCustomerLevel, formatTeamFilterLabel } from './utils.js'
import { canUseSmsKind, canManageSmsSettings, invokeSendSms, buildRecipientFromCustomer, formatBalanceFa, fetchSmsQuota, buildSettlementSmsVars } from './sms-business.js'
import { normalizeFollowupDefaultHour } from './sms-features.js'
import { getStoredTenantId } from './tenant.js'

const SMS_TEST_PHONE_KEY = 'sms_test_phone'

function readSavedTestPhone() {
  try {
    return String(localStorage.getItem(SMS_TEST_PHONE_KEY) || '').trim()
  } catch (_) {
    return ''
  }
}

function saveTestPhone(phone) {
  try {
    if (phone) localStorage.setItem(SMS_TEST_PHONE_KEY, phone)
  } catch (_) { /* ignore */ }
}

function fillTestPhoneInput(id) {
  const el = document.getElementById(id)
  if (!el) return
  if (!String(el.value || '').trim()) el.value = readSavedTestPhone()
}

function parseTestPhone(raw) {
  const phone = normalizePhone(raw)
  if (!phone || !/^09\d{9}$/.test(phone)) return null
  return phone
}

function buildTestRecipient(phone, sample) {
  return {
    phone,
    customer_id: sample?.customer_id || null,
    vars: {
      customer_name: 'تست',
      advisor: '',
      followup_date: '',
      org_name: 'آکادمی کارنو',
      product_name: '',
      balance: '',
      total_balance: '',
      tracking_code: '',
      ...(sample?.vars || {}),
      phone,
    },
    meta: { ...(sample?.meta || {}), test: true },
  }
}

/** @type {null | {
 *  kind: string,
 *  title: string,
 *  templateKey: string,
 *  recipients: Array,
 *  onSent?: Function
 * }} */
let composeState = null

/** Templates shown per compose kind (manual text always available). */
const KIND_TEMPLATE_KEYS = Object.freeze({
  sale_single: ['sale_balance', 'sale_settlement_due'],
  sale_group: ['sale_balance', 'sale_settlement_due'],
  sale_settlement_due: ['sale_settlement_due'],
  customer_single: ['customer_campaign'],
  customer_campaign: ['customer_campaign'],
  followup_bulk: ['followup_bulk', 'followup_due'],
  followup_schedule: ['followup_due'],
  shipment_queued: ['shipment_queued'],
  shipment_shipped: ['shipment_shipped'],
})

function renderPreviewText(body, vars) {
  let out = String(body || '')
  const merged = { phone: '', ...(vars || {}) }
  for (const [k, v] of Object.entries(merged)) {
    out = out.split(`{${k}}`).join(String(v ?? ''))
  }
  return out
}

function smsSegmentInfo(text) {
  const len = String(text || '').length
  // Rough GSM-7 vs UCS-2: Persian → UCS-2 (70 / 67)
  const isUcs2 = /[^\x00-\x7F]/.test(text || '')
  const single = isUcs2 ? 70 : 160
  const multi = isUcs2 ? 67 : 153
  const parts = len === 0 ? 0 : (len <= single ? 1 : Math.ceil(len / multi))
  return { len, parts }
}

function templatesForKind(templates, kind, preferredKey) {
  const keys = KIND_TEMPLATE_KEYS[kind]
  if (!keys || !keys.length) return templates || []
  const set = new Set(keys)
  const filtered = (templates || []).filter((t) => set.has(t.key))
  if (preferredKey && !filtered.some((t) => t.key === preferredKey)) {
    const preferred = (templates || []).find((t) => t.key === preferredKey)
    if (preferred) filtered.unshift(preferred)
  }
  return filtered.length ? filtered : (templates || [])
}

function updateSmsComposeMetaAndCount(previewText) {
  const metaEl = document.getElementById('smsComposeMeta')
  const countEl = document.getElementById('smsComposeCount')
  const n = composeState?.recipients?.length || 0
  if (metaEl) metaEl.textContent = `${n} گیرنده`
  const info = smsSegmentInfo(previewText ?? (document.getElementById('smsComposeBody')?.value || ''))
  if (countEl) {
    countEl.textContent = info.len
      ? `${formatNumber(info.len)} کاراکتر · حدود ${formatNumber(info.parts)} پیامک`
      : ''
  }
  renderAudienceSample('smsComposeAudienceSample', composeState?.recipients || [])
}

const AUDIENCE_SAMPLE_MAX = 8

function renderAudienceSample(elId, recipients) {
  const el = document.getElementById(elId)
  if (!el) return
  const list = recipients || []
  if (list.length <= 1) {
    el.style.display = 'none'
    el.innerHTML = ''
    return
  }
  const slice = list.slice(0, AUDIENCE_SAMPLE_MAX)
  const lines = slice.map((r) => {
    const name = escapeHtml(r?.vars?.customer_name || '—')
    const phone = escapeHtml(r?.phone || '')
    return `<div>${name} — <span dir="ltr">${phone}</span></div>`
  })
  if (list.length > AUDIENCE_SAMPLE_MAX) {
    lines.push(`<div class="settings-pane-desc">و ${formatNumber(list.length - AUDIENCE_SAMPLE_MAX)} نفر دیگر</div>`)
  }
  el.innerHTML = lines.join('')
  el.style.display = ''
}

async function refreshSmsQuotaDisplay(elId) {
  const el = document.getElementById(elId)
  if (!el) return
  el.textContent = 'در حال دریافت سقف روزانه…'
  const q = await fetchSmsQuota()
  if (!q?.success) {
    el.textContent = q?.error ? `سقف روزانه: ${q.error}` : 'سقف روزانه در دسترس نیست'
    return null
  }
  const remaining = Number(q.remaining || 0)
  const limit = Number(q.limit || 0)
  const used = Number(q.used || 0)
  el.textContent = `امروز: ${formatNumber(remaining)} از ${formatNumber(limit)} باقی‌مانده (مصرف‌شده ${formatNumber(used)})`
  return q
}

async function assertWithinQuota(needed) {
  const q = await fetchSmsQuota()
  if (!q?.success) return true // don't hard-block if quota endpoint unavailable
  const remaining = Number(q.remaining || 0)
  if (remaining <= 0) {
    showToast('سقف روزانه پیامک تمام شده است')
    return false
  }
  if (needed > remaining) {
    const ok = window.confirm(
      `تعداد گیرنده (${formatNumber(needed)}) بیشتر از باقی‌مانده امروز (${formatNumber(remaining)}) است. ادامه؟`
    )
    return ok
  }
  return true
}

export async function openSmsComposeModal(opts) {
  if (!canUseSmsKind(opts.kind)) {
    showToast('دسترسی یا قابلیت این پیامک فعال نیست')
    return
  }
  const templates = await listSmsTemplates().catch(() => [])
  composeState = {
    kind: opts.kind,
    title: opts.title || 'ارسال پیامک',
    templateKey: opts.templateKey || '',
    recipients: opts.recipients || [],
    onSent: opts.onSent,
  }
  const titleEl = document.getElementById('smsComposeTitle')
  const sel = document.getElementById('smsComposeTemplate')
  const bodyEl = document.getElementById('smsComposeBody')
  if (titleEl) titleEl.textContent = composeState.title
  updateSmsComposeMetaAndCount('')
  const relevant = templatesForKind(templates, opts.kind, opts.templateKey)
  if (sel) {
    sel.innerHTML = `<option value="">متن دستی</option>` + relevant.map((t) =>
      `<option value="${escapeAttr(t.key)}" ${t.key === opts.templateKey ? 'selected' : ''}>${escapeHtml(t.name || t.key)}</option>`
    ).join('')
  }
  const selectedKey = opts.templateKey || sel?.value || ''
  const tpl = templates.find((t) => t.key === selectedKey)
  if (bodyEl) bodyEl.value = opts.body || tpl?.body || ''
  fillTestPhoneInput('smsComposeTestPhone')
  updateSmsComposePreview()
  void refreshSmsQuotaDisplay('smsComposeQuota')
  document.getElementById('smsComposeModal')?.classList.add('active')
}

export function closeSmsComposeModal() {
  composeState = null
  document.getElementById('smsComposeModal')?.classList.remove('active')
}

export function onSmsComposeTemplateChange() {
  if (!composeState) return
  const key = document.getElementById('smsComposeTemplate')?.value || ''
  composeState.templateKey = key
  if (!key) {
    updateSmsComposePreview()
    return
  }
  listSmsTemplates().then((templates) => {
    const tpl = templates.find((t) => t.key === key)
    const bodyEl = document.getElementById('smsComposeBody')
    if (tpl && bodyEl) bodyEl.value = tpl.body || ''
    updateSmsComposePreview()
  }).catch(() => {
    updateSmsComposePreview()
  })
}

export function onSmsComposeBodyInput() {
  updateSmsComposePreview()
}

function sampleComposeVars() {
  const sample = composeState?.recipients?.[0]
  return {
    phone: sample?.phone || '',
    ...(sample?.vars || {}),
  }
}

function updateSmsComposePreview() {
  const body = document.getElementById('smsComposeBody')?.value || ''
  const preview = document.getElementById('smsComposePreview')
  const rendered = renderPreviewText(body, sampleComposeVars())
  if (preview) {
    preview.textContent = rendered || '—'
  }
  updateSmsComposeMetaAndCount(rendered)
}

/** Send one real SMS to a manual test number using current compose text/vars. */
export async function sendSmsComposeTest() {
  if (!composeState) return
  const body = document.getElementById('smsComposeBody')?.value || ''
  if (!body.trim()) {
    showToast('متن پیام را وارد کنید')
    return
  }
  const phone = parseTestPhone(document.getElementById('smsComposeTestPhone')?.value)
  if (!phone) {
    showToast('شماره تست معتبر نیست (مثلاً 09123456789)')
    return
  }
  if (!(await assertWithinQuota(1))) return
  const templateKey = document.getElementById('smsComposeTemplate')?.value || composeState.templateKey || ''
  const sample = composeState.recipients?.[0] || null
  const result = await invokeSendSms({
    mode: 'single',
    kind: composeState.kind,
    template_key: templateKey || null,
    body_override: body,
    recipients: [buildTestRecipient(phone, sample)],
  })
  if (result?.success || Number(result?.sent || 0) > 0) {
    saveTestPhone(phone)
    showToast(`پیام تست به ${phone} ارسال شد`)
    void refreshSmsQuotaDisplay('smsComposeQuota')
  } else {
    showToast(result?.error || 'ارسال تست ناموفق بود')
  }
}

export async function submitSmsCompose() {
  if (!composeState) return
  const body = document.getElementById('smsComposeBody')?.value || ''
  const templateKey = document.getElementById('smsComposeTemplate')?.value || composeState.templateKey || ''
  if (!body.trim()) {
    showToast('متن پیام را وارد کنید')
    return
  }
  const recipients = composeState.recipients
  if (!recipients.length) {
    showToast('گیرنده‌ای نیست')
    return
  }
  if (!(await assertWithinQuota(recipients.length))) return
  if (recipients.length > 1) {
    const ok = window.confirm(`ارسال به ${recipients.length} گیرنده؟`)
    if (!ok) return
  }

  // Batch in chunks of 50
  let sent = 0
  let failed = 0
  for (let i = 0; i < recipients.length; i += 50) {
    const chunk = recipients.slice(i, i + 50)
    const result = await invokeSendSms({
      mode: chunk.length > 1 ? 'bulk' : 'single',
      kind: composeState.kind,
      template_key: templateKey || null,
      body_override: body,
      recipients: chunk,
    })
    sent += Number(result.sent || 0)
    failed += Number(result.failed || 0) + Number(result.skipped || 0)
    if (!result.success && result.error && !result.sent) {
      showToast(result.error)
      void refreshSmsQuotaDisplay('smsComposeQuota')
      return
    }
  }
  showToast(`ارسال شد: ${sent} — ناموفق: ${failed}`)
  const cb = composeState.onSent
  closeSmsComposeModal()
  if (typeof cb === 'function') cb({ sent, failed })
}

function recipientsFromCustomers(customers, extraVarsFn) {
  const recipients = []
  for (const c of customers || []) {
    const phone = getPrimaryPhone(c) || c.phone
    if (!phone) continue
    const extra = typeof extraVarsFn === 'function' ? (extraVarsFn(c) || {}) : {}
    recipients.push(buildRecipientFromCustomer(c, extra))
  }
  return recipients
}

/** Sales: single product balance */
export async function openSaleBalanceSms(customerId, productIndex) {
  const data = getData()
  const customer = data.customers.find((c) => c.id === customerId)
  const product = customer?.products?.[productIndex]
  if (!customer || !product) {
    showToast('فروش یافت نشد')
    return
  }
  const balance = getOperationalBalance(product)
  const settlementDate = String(product.settlementDate || '').trim()
  const recipient = buildRecipientFromCustomer(customer, {
    product_name: product.name || '',
    balance: formatBalanceFa(balance),
    total_balance: formatBalanceFa(balance),
    ...buildSettlementSmsVars(settlementDate),
  }, { productIndex })
  await openSmsComposeModal({
    kind: 'sale_single',
    title: 'پیامک مانده حساب',
    templateKey: 'sale_balance',
    recipients: [recipient],
  })
}

/**
 * Sales tab: debtors from currently filtered sales rows (balance > 0).
 */
export async function openDebtorsGroupSms(productNameFilter = '') {
  if (!canUseSmsKind('sale_group')) {
    showToast('پیامک گروهی بدهکاران فعال نیست یا دسترسی ندارید')
    return
  }
  const data = getData()
  const byCustomer = new Map()

  let sales = []
  try {
    const { getFilteredSales } = await import('./sales.js')
    sales = getFilteredSales() || []
  } catch (e) {
    console.warn('openDebtorsGroupSms filtered sales', e)
    showToast('خطا در خواندن لیست فروش')
    return
  }

  for (const s of sales) {
    if (productNameFilter && String(s.productName || '') !== productNameFilter) continue
    const customer = data.customers.find((c) => c.id === s.customerId)
    if (!customer) continue
    const productIndex = Number(s.productIndex)
    const product = customer.products?.[productIndex]
    if (!product) continue
    const bal = getOperationalBalance(product)
    if (bal <= 0) continue
    let entry = byCustomer.get(customer.id)
    if (!entry) {
      entry = { customer, total: 0, names: [], seen: new Set(), earliestSettlement: '', earliestNum: 99999999 }
      byCustomer.set(customer.id, entry)
    }
    if (entry.seen.has(productIndex)) continue
    entry.seen.add(productIndex)
    entry.total += bal
    const name = String(product.name || s.productName || 'محصول').trim() || 'محصول'
    entry.names.push(name)
    const settle = String(product.settlementDate || s.settlementDate || '').trim()
    if (settle) {
      const n = jalaliToNum(settle)
      if (n < entry.earliestNum) {
        entry.earliestNum = n
        entry.earliestSettlement = settle
      }
    }
  }

  const recipients = []
  for (const { customer, total, names, earliestSettlement } of byCustomer.values()) {
    const phone = getPrimaryPhone(customer) || customer.phone
    if (!phone) continue
    recipients.push(buildRecipientFromCustomer(customer, {
      product_name: names.join('، ') || 'محصولات',
      balance: formatBalanceFa(total),
      total_balance: formatBalanceFa(total),
      ...buildSettlementSmsVars(earliestSettlement),
    }))
  }

  if (!recipients.length) {
    showToast('بدهکاری در لیست فیلترشده فعلی یافت نشد')
    return
  }
  await openSmsComposeModal({
    kind: 'sale_group',
    title: 'پیامک گروهی بدهکاران',
    templateKey: 'sale_balance',
    recipients,
  })
}

export async function openCustomerSingleSms(customerId) {
  const customer = getData().customers.find((c) => c.id === customerId)
  if (!customer) {
    showToast('مشتری یافت نشد')
    return
  }
  await openSmsComposeModal({
    kind: 'customer_single',
    title: 'پیامک به مشتری',
    templateKey: 'customer_campaign',
    recipients: [buildRecipientFromCustomer(customer)],
  })
}

/** Customers tab: unified SMS modal (filters + immediate/scheduled/drip). */
export async function openCustomersFilteredSms() {
  return openSmsCampaignModal()
}

export async function openFollowupBulkSms(items) {
  const recipients = (items || []).map((item) => {
    const customer = getData().customers.find((c) => c.id === item.customerId)
    if (!customer) return null
    const phone = getPrimaryPhone(customer) || customer.phone
    if (!phone) return null
    return buildRecipientFromCustomer(customer, {
      followup_date: item.nextDate || customer.nextFollowupDate || '',
    })
  }).filter(Boolean)
  if (!recipients.length) {
    showToast('مخاطبی نیست')
    return
  }
  await openSmsComposeModal({
    kind: 'followup_bulk',
    title: 'پیامک دسته‌ای فالوآپ',
    templateKey: 'followup_bulk',
    recipients,
  })
}

/** Schedule SMS at follow-up date + default hour */
export async function scheduleFollowupSms(customer, followupDate, { bodyOverride = null, templateKey = 'followup_due' } = {}) {
  if (!canUseSmsKind('followup_schedule')) return null
  const timeStr = getFollowupSmsDefaultHour()
  let sendAt = jalaliDateTimeToIso(followupDate, timeStr)
  if (!sendAt) {
    const [hh, mm] = String(timeStr).split(':').map((x) => Number(x) || 0)
    const d = new Date()
    d.setHours(hh, mm, 0, 0)
    sendAt = d.toISOString()
  }
  await cancelPendingSmsSchedulesForCustomer(customer.id)
  return createSmsSchedule({
    customer_id: customer.id,
    kind: 'followup_schedule',
    template_key: templateKey,
    body_override: bodyOverride,
    send_at: sendAt,
    created_by: normalizePhone(getCurrentUser()?.phone || ''),
    meta: {
      followup_date: followupDate,
      vars: {
        customer_name: customer.name || '',
        advisor: customer.advisor || '',
        followup_date: followupDate,
        org_name: 'آکادمی کارنو',
      },
    },
  })
}

function isSettlementDueSmsEligible(product) {
  if (!product) return false
  if (isGiftSale(product) || isDealCancelled(product)) return false
  if (product.status === 'تکمیل') return false
  const settlementDate = String(product.settlementDate || '').trim()
  if (!settlementDate) return false
  const balance = getOperationalBalance(product)
  return balance > 0
}

/**
 * Rebuild pending settlement-due SMS schedules for all products of a customer.
 * Org feature must be on; runs as auto (no per-user permission required).
 * @returns {Promise<number>} number of schedules created
 */
export async function syncSettlementDueSmsForCustomer(customer) {
  if (!customer?.id) return 0
  try {
    await cancelPendingSettlementSmsForCustomer(customer.id)
    if (!canUseSmsKind('sale_settlement_due', { auto: true })) return 0

    const products = customer.products || []
    const timeStr = getFollowupSmsDefaultHour()
    const createdBy = normalizePhone(getCurrentUser()?.phone || '')
    let created = 0

    for (let productIndex = 0; productIndex < products.length; productIndex++) {
      const product = products[productIndex]
      if (!isSettlementDueSmsEligible(product)) continue
      const settlementDate = String(product.settlementDate || '').trim()
      const balance = getOperationalBalance(product)
      let sendAt = jalaliDateTimeToIso(settlementDate, timeStr)
      if (!sendAt) continue
      const settleVars = buildSettlementSmsVars(settlementDate)
      await createSmsSchedule({
        customer_id: customer.id,
        kind: 'sale_settlement_due',
        template_key: 'sale_settlement_due',
        body_override: null,
        send_at: sendAt,
        created_by: createdBy,
        meta: {
          productIndex,
          settlementDate,
          product_name: product.name || '',
          vars: {
            customer_name: customer.name || '',
            advisor: customer.advisor || '',
            product_name: product.name || '',
            balance: formatBalanceFa(balance),
            total_balance: formatBalanceFa(balance),
            org_name: 'آکادمی کارنو',
            ...settleVars,
          },
        },
      })
      created += 1
    }
    return created
  } catch (e) {
    console.error('syncSettlementDueSmsForCustomer', e)
    return 0
  }
}

/**
 * Build/refresh all auto schedules from current customer data (settlement + follow-up dates).
 * Loads products from DB so it works even if detail tabs were not opened.
 */
export async function rebuildAllAutoSmsSchedules() {
  const { getStoredTenantId } = await import('./tenant.js')
  const { supabase } = await import('./supabase.js')
  const tenantId = getStoredTenantId()
  if (!tenantId) throw new Error('سازمان انتخاب نشده')

  const { data: rows, error } = await supabase
    .from('customers')
    .select('id, name, phone, phones, advisor, next_followup_date, products')
    .eq('tenant_id', tenantId)
  if (error) throw new Error('خطا در خواندن مشتریان: ' + error.message)

  let settlementCreated = 0
  let followupCreated = 0
  const timeStr = getFollowupSmsDefaultHour()
  const createdBy = normalizePhone(getCurrentUser()?.phone || '')
  const followupAuto = canUseSmsKind('followup_schedule', { auto: true })

  for (const row of rows || []) {
    const customer = {
      id: row.id,
      name: row.name || '',
      phone: row.phone || '',
      phones: Array.isArray(row.phones) ? row.phones : [],
      advisor: row.advisor || '',
      nextFollowupDate: row.next_followup_date || '',
      products: Array.isArray(row.products) ? row.products : [],
    }

    settlementCreated += await syncSettlementDueSmsForCustomer(customer)

    if (followupAuto) {
      const followupDate = String(customer.nextFollowupDate || '').trim()
      await cancelPendingSmsSchedulesForCustomer(customer.id)
      if (followupDate) {
        let sendAt = jalaliDateTimeToIso(followupDate, timeStr)
        if (sendAt) {
          await createSmsSchedule({
            customer_id: customer.id,
            kind: 'followup_schedule',
            template_key: 'followup_due',
            body_override: null,
            send_at: sendAt,
            created_by: createdBy,
            meta: {
              followup_date: followupDate,
              vars: {
                customer_name: customer.name || '',
                advisor: customer.advisor || '',
                followup_date: followupDate,
                org_name: 'آکادمی کارنو',
              },
            },
          })
          followupCreated += 1
        }
      }
    } else {
      await cancelPendingSmsSchedulesForCustomer(customer.id)
    }
  }

  return { settlementCreated, followupCreated }
}

/**
 * Keep the calendar day of each pending auto schedule; move clock to new default time (Tehran).
 * @returns {Promise<number>} updated count
 */
export async function reschedulePendingAutoSmsWithDefaultTime(timeRaw) {
  const timeStr = normalizeFollowupDefaultHour(timeRaw ?? getFollowupSmsDefaultHour())
  const schedules = await listPendingAutoSmsSchedules({ limit: 300 })
  let updated = 0
  for (const sch of schedules) {
    const jalaliDate = gregorianToJalaliStr(sch.send_at)
    if (!jalaliDate) continue
    const sendAt = jalaliDateTimeToIso(jalaliDate, timeStr)
    if (!sendAt || sendAt === sch.send_at) continue
    await updateSmsScheduleRow(sch.id, { send_at: sendAt })
    updated += 1
  }
  return updated
}

/**
 * Process due pending schedules for this tenant (manual stand-in for sms-schedule-cron).
 * First rebuilds schedules from sales/follow-ups so the queue is not empty after only changing the hour.
 */
export async function processDueSmsSchedulesManually() {
  if (!canManageSmsSettings()) {
    showToast('دسترسی مدیریت پیامک ندارید')
    return null
  }

  showToast('در حال ساخت/بروزرسانی زمان‌بندی‌ها…')
  let rebuilt = { settlementCreated: 0, followupCreated: 0 }
  try {
    rebuilt = await rebuildAllAutoSmsSchedules()
  } catch (e) {
    console.error('rebuildAllAutoSmsSchedules', e)
    showToast(e.message || 'خطا در ساخت زمان‌بندی‌ها')
    return null
  }

  const pendingAll = await listPendingAutoSmsSchedules({ limit: 300 })
  const due = await listDuePendingSmsSchedules({ limit: 50 })
  if (!due.length) {
    const future = pendingAll.length
    if (future > 0) {
      showToast(
        `زمان‌بندی ساخته شد (تسویه: ${formatNumber(rebuilt.settlementCreated)}، فالوآپ: ${formatNumber(rebuilt.followupCreated)}) · ${formatNumber(future)} مورد در صف است ولی هنوز به ساعت ارسال نرسیده`
      )
    } else {
      const settleOn = canUseSmsKind('sale_settlement_due', { auto: true })
      showToast(
        settleOn
          ? 'زمان‌بندی واجد شرایطی پیدا نشد. فروش باید تاریخ تسویه داشته باشد، مانده > ۰ و وضعیت بیعانه باشد.'
          : 'قابلیت «پیامک خودکار در موعد تسویه» خاموش است. آن را روشن کنید و ذخیره بزنید.'
      )
    }
    return { processed: 0, sent: 0, failed: 0, cancelled: 0, rebuilt }
  }

  const { supabase } = await import('./supabase.js')
  const { getStoredTenantId } = await import('./tenant.js')
  const tenantId = getStoredTenantId()

  let sent = 0
  let failed = 0
  let cancelled = 0

  for (const sch of due) {
    const meta = sch.meta && typeof sch.meta === 'object' ? sch.meta : {}
    const kind = String(sch.kind || 'followup_schedule')

    let customer = null
    let products = []
    if (sch.customer_id && tenantId) {
      const { data: row } = await supabase
        .from('customers')
        .select('id, name, phone, phones, advisor, next_followup_date, products')
        .eq('tenant_id', tenantId)
        .eq('id', sch.customer_id)
        .maybeSingle()
      if (row) {
        products = Array.isArray(row.products) ? row.products : []
        customer = {
          id: row.id,
          name: row.name || '',
          phone: row.phone || '',
          phones: Array.isArray(row.phones) ? row.phones : [],
          advisor: row.advisor || '',
          nextFollowupDate: row.next_followup_date || '',
          products,
        }
      }
    }

    const sendPhone = getPrimaryPhone(customer) || customer?.phone || ''
    if (!sendPhone) {
      await updateSmsScheduleRow(sch.id, {
        status: 'failed',
        meta: { ...meta, last_result: { error: 'no_phone' } },
      })
      failed += 1
      continue
    }

    let settlementVars = {}
    if (kind === 'sale_settlement_due') {
      const productIndex = Number(meta.productIndex)
      const product = products[productIndex]
      const balance = getOperationalBalance(product)
      const settlementDate = String(product?.settlementDate || meta.settlementDate || '').trim()
      if (
        !product
        || isGiftSale(product)
        || isDealCancelled(product)
        || product.status === 'تکمیل'
        || balance <= 0
        || !settlementDate
      ) {
        await updateSmsScheduleRow(sch.id, {
          status: 'cancelled',
          meta: { ...meta, skip_reason: 'no_balance_or_settled' },
        })
        cancelled += 1
        continue
      }
      settlementVars = {
        product_name: product.name || '',
        balance: formatBalanceFa(balance),
        total_balance: formatBalanceFa(balance),
        ...buildSettlementSmsVars(settlementDate),
      }
    }

    const result = await invokeSendSms({
      mode: 'single',
      kind,
      auto: true,
      template_key: sch.template_key || (
        kind === 'sale_settlement_due'
          ? 'sale_settlement_due'
          : (kind === 'followup_bulk' ? 'followup_bulk' : 'followup_due')
      ),
      body_override: sch.body_override || null,
      recipients: [{
        phone: sendPhone,
        customer_id: sch.customer_id,
        vars: {
          customer_name: customer?.name || '',
          advisor: customer?.advisor || '',
          followup_date: customer?.nextFollowupDate || String(meta.followup_date || ''),
          org_name: String(meta.org_name || 'آکادمی کارنو'),
          ...((meta.vars && typeof meta.vars === 'object') ? meta.vars : {}),
          ...settlementVars,
        },
        meta: { schedule_id: sch.id, ...meta },
      }],
    })

    const ok = Number(result?.sent || 0) > 0
    await updateSmsScheduleRow(sch.id, {
      status: ok ? 'sent' : 'failed',
      meta: { ...meta, last_result: result },
    })
    if (ok) sent += 1
    else failed += 1
  }

  showToast(`صف پیامک: ${formatNumber(sent)} ارسال، ${formatNumber(failed)} ناموفق، ${formatNumber(cancelled)} لغو`)
  try {
    const { refreshSmsHistory } = await import('./auth.js')
    await refreshSmsHistory()
  } catch (_) { /* ignore */ }
  return { processed: sent + failed + cancelled, sent, failed, cancelled, rebuilt }
}

// —— Campaign wizard ——
let campaignAudience = []

function updateSmsCampaignPreview() {
  const body = document.getElementById('smsCampaignBody')?.value || ''
  const sample = campaignAudience[0]?.vars || {}
  const phone = campaignAudience[0]?.phone || ''
  const preview = document.getElementById('smsCampaignPreview')
  if (preview) {
    preview.textContent = renderPreviewText(body, { phone, ...sample }) || '—'
  }
}

function collectCampaignProductOptions() {
  const names = new Set()
  for (const n of getProductCatalogNames()) {
    const t = String(n || '').trim()
    if (t) names.add(t)
  }
  for (const c of getData().customers || []) {
    for (const p of c.products || []) {
      const t = String(p?.name || '').trim()
      if (t) names.add(t)
    }
  }
  return [...names].sort((a, b) => a.localeCompare(b, 'fa'))
}

function customerHasProduct(customer, productName) {
  if (!productName) return true
  const key = String(productName).trim().toLowerCase()
  if (!key) return true
  return (customer.products || []).some((p) => String(p?.name || '').trim().toLowerCase() === key)
}

export function onSmsCampaignModeChange() {
  const mode = document.getElementById('smsCampaignMode')?.value || 'immediate'
  const row = document.getElementById('smsCampaignScheduleRow')
  if (row) {
    const showSchedule = mode === 'scheduled'
    const showDrip = mode === 'drip'
    const sendAt = document.getElementById('smsCampaignSendAt')?.closest('.form-group')
    const dripInterval = document.getElementById('smsCampaignDripInterval')?.closest('.form-group')
    const dripBatch = document.getElementById('smsCampaignDripBatch')?.closest('.form-group')
    if (sendAt) sendAt.style.display = showSchedule ? '' : 'none'
    if (dripInterval) dripInterval.style.display = showDrip ? '' : 'none'
    if (dripBatch) dripBatch.style.display = showDrip ? '' : 'none'
    row.style.display = (showSchedule || showDrip) ? '' : 'none'
  }
  const submitBtn = document.getElementById('smsCampaignSubmitBtn')
  if (submitBtn) {
    submitBtn.textContent = mode === 'scheduled'
      ? 'زمان‌بندی ارسال'
      : mode === 'drip'
        ? 'شروع ارسال قطره‌ای'
        : 'ارسال فوری'
  }
}

export async function openSmsCampaignModal() {
  if (!canUseSmsKind('customer_campaign')) {
    showToast('پیامک مشتریان فعال نیست یا دسترسی ندارید')
    return
  }
  const statuses = getStatuses()
  const statusSel = document.getElementById('smsCampaignStatus')
  if (statusSel) {
    statusSel.innerHTML = `<option value="">همه</option>` + statuses.map((s) =>
      `<option value="${escapeAttr(s.key)}">${escapeHtml(s.label || s.key)}</option>`
    ).join('')
  }
  const platformSel = document.getElementById('smsCampaignPlatform')
  if (platformSel) {
    platformSel.innerHTML = `<option value="">همه پلتفرم‌ها</option>` + getPlatforms().map((p) =>
      `<option value="${escapeAttr(p.key)}">${escapeHtml(p.label || p.key)}</option>`
    ).join('')
  }
  const productSel = document.getElementById('smsCampaignProduct')
  if (productSel) {
    const products = collectCampaignProductOptions()
    productSel.innerHTML = `<option value="">همه محصولات</option>` + products.map((name) =>
      `<option value="${escapeAttr(name)}">${escapeHtml(name)}</option>`
    ).join('')
  }
  const levelSel = document.getElementById('smsCampaignLevel')
  if (levelSel) {
    levelSel.innerHTML = `<option value="">همه سطوح</option>` + Object.values(CUSTOMER_LEVELS).map((l) =>
      `<option value="${escapeAttr(l.key)}">${l.emoji || ''} ${escapeHtml(l.label || l.key)}</option>`
    ).join('')
  }
  const segmentSel = document.getElementById('smsCampaignSegment')
  if (segmentSel) segmentSel.value = ''
  const followupSel = document.getElementById('smsCampaignFollowup')
  if (followupSel) followupSel.value = ''
  const useTab = document.getElementById('smsCampaignUseTabFilters')
  if (useTab) useTab.checked = true
  await populateCampaignAdvisorSelect()
  const templates = await listSmsTemplates().catch(() => [])
  const campaignTemplates = templatesForKind(templates, 'customer_campaign', 'customer_campaign')
  const tplSel = document.getElementById('smsCampaignTemplate')
  if (tplSel) {
    tplSel.innerHTML = `<option value="">متن دستی</option>` + campaignTemplates.map((t) =>
      `<option value="${escapeAttr(t.key)}" ${t.key === 'customer_campaign' ? 'selected' : ''}>${escapeHtml(t.name || t.key)}</option>`
    ).join('')
  }
  const tpl = templates.find((t) => t.key === 'customer_campaign') || campaignTemplates[0]
  const bodyEl = document.getElementById('smsCampaignBody')
  if (bodyEl) bodyEl.value = tpl?.body || ''
  const titleEl = document.getElementById('smsCampaignTitle')
  if (titleEl) titleEl.value = ''
  const modeSel = document.getElementById('smsCampaignMode')
  if (modeSel) modeSel.value = 'immediate'
  fillTestPhoneInput('smsCampaignTestPhone')
  onSmsCampaignModeChange()
  await refreshSmsCampaignAudienceAsync()
  void refreshSmsQuotaDisplay('smsCampaignQuota')
  document.getElementById('smsCampaignModal')?.classList.add('active')
}

async function populateCampaignAdvisorSelect() {
  const sel = document.getElementById('smsCampaignAdvisor')
  if (!sel) return
  const currentVal = sel.value
  try {
    const { getUsersSafe } = await import('./auth.js')
    const { loadGroupsData, buildGroupedAdvisorSelectHtml } = await import('./groups.js')
    const users = await getUsersSafe()
    try { await loadGroupsData() } catch (_) { /* optional */ }
    sel.innerHTML = buildGroupedAdvisorSelectHtml({
      users,
      selectedValue: currentVal,
      teamLabel: formatTeamFilterLabel(getCurrentUser()),
      emptyLabel: 'همه کارشناسان',
    })
    if (![...sel.options].some((o) => o.value === currentVal)) sel.value = ''
    else sel.value = currentVal
  } catch (e) {
    console.warn('populateCampaignAdvisorSelect', e)
    sel.innerHTML = '<option value="">همه کارشناسان</option>'
  }
}

export function closeSmsCampaignModal() {
  campaignAudience = []
  document.getElementById('smsCampaignModal')?.classList.remove('active')
}

export function onSmsCampaignTemplateChange() {
  const key = document.getElementById('smsCampaignTemplate')?.value || ''
  if (!key) {
    updateSmsCampaignPreview()
    return
  }
  listSmsTemplates().then((templates) => {
    const tpl = templates.find((t) => t.key === key)
    const bodyEl = document.getElementById('smsCampaignBody')
    if (tpl && bodyEl) bodyEl.value = tpl.body || ''
    updateSmsCampaignPreview()
  }).catch(() => {
    updateSmsCampaignPreview()
  })
}

export function onSmsCampaignBodyInput() {
  updateSmsCampaignPreview()
}

function customerLooksLikeBuyer(c) {
  if (!c._productsLoaded && c.productCount != null) return c.productCount > 0
  return (c.products || []).length > 0
}

function customerHasAnyFollowup(c, followupsByCustomer) {
  const list = followupsByCustomer?.get(c.id)
  return !!(list && list.length)
}

function finishAudience(base, opts) {
  const {
    status,
    productName,
    advisorPhones,
    advisorFilter,
    levelFilter,
    platform,
    segment,
    followup,
    useTabFilters,
  } = opts
  campaignAudience = []
  const data = getData()
  let followupsByCustomer = null
  if (segment === 'following') {
    try {
      // lazy: build map from followups
      followupsByCustomer = new Map()
      for (const f of data.followups || []) {
        if (!f?.customerId) continue
        if (!followupsByCustomer.has(f.customerId)) followupsByCustomer.set(f.customerId, [])
        followupsByCustomer.get(f.customerId).push(f)
      }
    } catch (_) {
      followupsByCustomer = new Map()
    }
  }

  for (const c of base) {
    if (status && String(c.status || '') !== status) continue
    if (platform && String(c.platform || '') !== platform) continue
    if (!customerHasProduct(c, productName)) continue
    if (advisorPhones instanceof Set) {
      const owner = normalizePhone(c.advisorPhone)
      if (!owner || !advisorPhones.has(owner)) continue
    }
    if (levelFilter) {
      const resolved = resolveCustomerLevel(c)
      if (resolved !== levelFilter) continue
    }
    if (segment === 'buyers' && !customerLooksLikeBuyer(c)) continue
    if (segment === 'following' && !customerHasAnyFollowup(c, followupsByCustomer)) continue
    if (segment === 'cs' && !String(c.id || '').startsWith('CS')) continue
    if (segment === 'ld' && !String(c.id || '').startsWith('LD')) continue
    if (followup === 'has' && !c.nextFollowupDate) continue
    if (followup === 'none' && c.nextFollowupDate) continue

    const phone = getPrimaryPhone(c) || c.phone
    if (!phone) continue
    const extra = {}
    if (productName) extra.product_name = productName
    campaignAudience.push(buildRecipientFromCustomer(c, extra))
  }
  const el = document.getElementById('smsCampaignCount')
  const parts = [`${campaignAudience.length} گیرنده`]
  if (useTabFilters) parts.push('فیلتر تب')
  if (productName) parts.push(`محصول: ${productName}`)
  if (platform) parts.push('پلتفرم')
  if (advisorFilter) parts.push('کارشناس')
  if (levelFilter) {
    const lv = CUSTOMER_LEVELS[levelFilter]
    parts.push(`سطح: ${lv?.label || levelFilter}`)
  }
  if (segment) parts.push('گروه')
  if (followup) parts.push('فالوآپ')
  if (el) el.textContent = parts.join(' · ')
  updateSmsCampaignPreview()
  renderAudienceSample('smsCampaignAudienceSample', campaignAudience)
}

/** Audience = optional customers-tab filters + modal filters. */
export function refreshSmsCampaignAudience() {
  void refreshSmsCampaignAudienceAsync()
}

export async function refreshSmsCampaignAudienceAsync() {
  const status = document.getElementById('smsCampaignStatus')?.value || ''
  const productName = document.getElementById('smsCampaignProduct')?.value || ''
  const advisorFilter = document.getElementById('smsCampaignAdvisor')?.value || ''
  const levelFilter = document.getElementById('smsCampaignLevel')?.value || ''
  const platform = document.getElementById('smsCampaignPlatform')?.value || ''
  const segment = document.getElementById('smsCampaignSegment')?.value || ''
  const followup = document.getElementById('smsCampaignFollowup')?.value || ''
  const useTabFilters = document.getElementById('smsCampaignUseTabFilters')?.checked !== false

  let base = getData().customers || []
  if (useTabFilters) {
    try {
      const { getFilteredCustomers } = await import('./customers.js')
      base = getFilteredCustomers() || base
    } catch (_) { /* keep all */ }
  }

  let advisorPhones = null
  if (advisorFilter) {
    try {
      const { phonesMatchingAdvisorFilter } = await import('./groups.js')
      advisorPhones = phonesMatchingAdvisorFilter(advisorFilter, getCurrentUser())
    } catch (_) {
      const p = normalizePhone(advisorFilter)
      advisorPhones = p ? new Set([p]) : null
    }
  }

  finishAudience(base, {
    status,
    productName,
    advisorPhones,
    advisorFilter,
    levelFilter,
    platform,
    segment,
    followup,
    useTabFilters,
  })
  return campaignAudience
}

export async function sendSmsCampaignTest() {
  if (!canUseSmsKind('customer_campaign')) return
  const body = document.getElementById('smsCampaignBody')?.value || ''
  if (!body.trim()) {
    showToast('متن پیام را وارد کنید')
    return
  }
  const phone = parseTestPhone(document.getElementById('smsCampaignTestPhone')?.value)
  if (!phone) {
    showToast('شماره تست معتبر نیست (مثلاً 09123456789)')
    return
  }
  if (!(await assertWithinQuota(1))) return
  await refreshSmsCampaignAudienceAsync()
  const templateKey = document.getElementById('smsCampaignTemplate')?.value || 'customer_campaign'
  const sample = campaignAudience[0] || null
  const productName = document.getElementById('smsCampaignProduct')?.value || ''
  const recipient = buildTestRecipient(phone, sample)
  if (productName) recipient.vars.product_name = productName
  const result = await invokeSendSms({
    mode: 'single',
    kind: 'customer_campaign',
    template_key: templateKey || null,
    body_override: body,
    recipients: [recipient],
  })
  if (result?.success || Number(result?.sent || 0) > 0) {
    saveTestPhone(phone)
    showToast(`پیام تست به ${phone} ارسال شد`)
    void refreshSmsQuotaDisplay('smsCampaignQuota')
  } else {
    showToast(result?.error || 'ارسال تست ناموفق بود')
  }
}

export async function submitSmsCampaign() {
  if (!canUseSmsKind('customer_campaign')) return
  await refreshSmsCampaignAudienceAsync()
  if (!campaignAudience.length) {
    showToast('مخاطبی انتخاب نشده')
    return
  }
  const title = document.getElementById('smsCampaignTitle')?.value?.trim() || 'پیامک مشتریان'
  const mode = document.getElementById('smsCampaignMode')?.value || 'immediate'
  const templateKey = document.getElementById('smsCampaignTemplate')?.value || 'customer_campaign'
  const body = document.getElementById('smsCampaignBody')?.value || ''
  if (!body.trim()) {
    showToast('متن پیام را وارد کنید')
    return
  }
  const productName = document.getElementById('smsCampaignProduct')?.value || ''
  const status = document.getElementById('smsCampaignStatus')?.value || ''
  const advisor = document.getElementById('smsCampaignAdvisor')?.value || ''
  const level = document.getElementById('smsCampaignLevel')?.value || ''
  const platform = document.getElementById('smsCampaignPlatform')?.value || ''
  const segment = document.getElementById('smsCampaignSegment')?.value || ''
  const followup = document.getElementById('smsCampaignFollowup')?.value || ''
  const useTabFilters = document.getElementById('smsCampaignUseTabFilters')?.checked !== false
  if (!(await assertWithinQuota(campaignAudience.length))) return
  const modeLabel = mode === 'scheduled' ? 'زمان‌بندی' : mode === 'drip' ? 'ارسال قطره‌ای' : 'ارسال فوری'
  const ok = window.confirm(`${modeLabel} برای ${campaignAudience.length} گیرنده؟`)
  if (!ok) return

  const dripInterval = Number(document.getElementById('smsCampaignDripInterval')?.value || 5)
  const dripBatch = Number(document.getElementById('smsCampaignDripBatch')?.value || 20)
  let sendAt = null
  const sendAtRaw = document.getElementById('smsCampaignSendAt')?.value
  if (mode === 'scheduled') {
    if (!sendAtRaw) {
      showToast('زمان ارسال را مشخص کنید')
      return
    }
    sendAt = new Date(sendAtRaw).toISOString()
  }

  const campaign = await createSmsCampaign({
    title,
    template_key: templateKey || null,
    body,
    filter: {
      status,
      product: productName,
      advisor,
      level,
      platform,
      segment,
      followup,
      useTabFilters,
      recipients: campaignAudience,
    },
    mode,
    status: 'sending',
    total: campaignAudience.length,
    send_at: sendAt,
    drip_interval_min: dripInterval,
    drip_batch_size: dripBatch,
    next_batch_at: mode === 'drip' ? new Date().toISOString() : null,
    created_by: normalizePhone(getCurrentUser()?.phone || ''),
  })

  if (mode === 'immediate') {
    for (let i = 0; i < campaignAudience.length; i += 50) {
      const chunk = campaignAudience.slice(i, i + 50)
      await invokeSendSms({
        mode: 'bulk',
        kind: 'customer_campaign',
        template_key: templateKey || null,
        body_override: body,
        recipients: chunk,
      })
    }
    const { supabase } = await import('./supabase.js')
    const tenantId = getStoredTenantId()
    await supabase.from('sms_campaigns').update({
      status: 'done',
      sent: campaignAudience.length,
      updated_at: new Date().toISOString(),
    }).eq('id', campaign.id).eq('tenant_id', tenantId)
    showToast('ارسال انجام شد')
  } else {
    showToast(mode === 'scheduled' ? 'ارسال زمان‌بندی شد' : 'ارسال قطره‌ای شروع شد — کرون دسته‌ها را می‌فرستد')
  }
  closeSmsCampaignModal()
}

// Shipment helpers used by accounting/shipments
export async function sendShipmentQueuedSms(customer, product, productIndex) {
  if (!canUseSmsKind('shipment_queued', { auto: true })) return { skipped: true }
  if (product.smsQueuedAt) return { skipped: true }
  const recipient = buildRecipientFromCustomer(customer, {
    product_name: product.name || '',
  }, { productIndex })
  const result = await invokeSendSms({
    mode: 'single',
    kind: 'shipment_queued',
    auto: true,
    template_key: 'shipment_queued',
    recipients: [recipient],
  })
  return result
}

export async function sendShipmentShippedSms(customer, product, productIndex) {
  if (!canUseSmsKind('shipment_shipped')) return { skipped: true }
  const recipient = buildRecipientFromCustomer(customer, {
    product_name: product.name || '',
    tracking_code: product.trackingCode || '',
  }, { productIndex })
  return invokeSendSms({
    mode: 'single',
    kind: 'shipment_shipped',
    template_key: 'shipment_shipped',
    recipients: [recipient],
  })
}
