import { getData, listSmsTemplates, createSmsCampaign, createSmsSchedule, cancelPendingSmsSchedulesForCustomer, getFollowupSmsDefaultHour, getStatuses } from './data.js'
import { showToast, escapeHtml, escapeAttr, formatNumber, getCurrentUser, normalizePhone, getOperationalBalance, getPrimaryPhone } from './utils.js'
import { canUseSmsKind, invokeSendSms, buildRecipientFromCustomer, formatBalanceFa } from './sms-business.js'
import { getStoredTenantId } from './tenant.js'

/** @type {null | {
 *  kind: string,
 *  title: string,
 *  templateKey: string,
 *  recipients: Array,
 *  onSent?: Function
 * }} */
let composeState = null

function renderPreviewText(body, vars) {
  let out = String(body || '')
  for (const [k, v] of Object.entries(vars || {})) {
    out = out.split(`{${k}}`).join(String(v ?? ''))
  }
  return out
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
  const metaEl = document.getElementById('smsComposeMeta')
  const sel = document.getElementById('smsComposeTemplate')
  const bodyEl = document.getElementById('smsComposeBody')
  const countEl = document.getElementById('smsComposeCount')
  if (titleEl) titleEl.textContent = composeState.title
  if (metaEl) metaEl.textContent = `${composeState.recipients.length} گیرنده`
  if (countEl) countEl.textContent = ''
  if (sel) {
    const relevant = templates.filter((t) => {
      if (opts.templateKey) return true
      return true
    })
    sel.innerHTML = `<option value="">متن دستی</option>` + relevant.map((t) =>
      `<option value="${escapeAttr(t.key)}" ${t.key === opts.templateKey ? 'selected' : ''}>${escapeHtml(t.name || t.key)}</option>`
    ).join('')
  }
  const tpl = templates.find((t) => t.key === (opts.templateKey || sel?.value))
  if (bodyEl) bodyEl.value = opts.body || tpl?.body || ''
  updateSmsComposePreview()
  document.getElementById('smsComposeModal')?.classList.add('active')
}

export function closeSmsComposeModal() {
  composeState = null
  document.getElementById('smsComposeModal')?.classList.remove('active')
}

export function onSmsComposeTemplateChange() {
  const key = document.getElementById('smsComposeTemplate')?.value || ''
  if (!key || !composeState) return
  listSmsTemplates().then((templates) => {
    const tpl = templates.find((t) => t.key === key)
    const bodyEl = document.getElementById('smsComposeBody')
    if (tpl && bodyEl) bodyEl.value = tpl.body || ''
    if (composeState) composeState.templateKey = key
    updateSmsComposePreview()
  }).catch(() => {})
}

function updateSmsComposePreview() {
  const body = document.getElementById('smsComposeBody')?.value || ''
  const sample = composeState?.recipients?.[0]?.vars || {}
  const preview = document.getElementById('smsComposePreview')
  if (preview) preview.textContent = renderPreviewText(body, sample)
}

export function previewSmsCompose() {
  updateSmsComposePreview()
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
      return
    }
  }
  showToast(`ارسال شد: ${sent} — ناموفق: ${failed}`)
  const cb = composeState.onSent
  closeSmsComposeModal()
  if (typeof cb === 'function') cb({ sent, failed })
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
  const recipient = buildRecipientFromCustomer(customer, {
    product_name: product.name || '',
    balance: formatBalanceFa(balance),
    total_balance: formatBalanceFa(balance),
  }, { productIndex })
  await openSmsComposeModal({
    kind: 'sale_single',
    title: 'پیامک مانده حساب',
    templateKey: 'sale_balance',
    recipients: [recipient],
  })
}

/** Sales: all debtors (optional product name filter) */
export async function openDebtorsGroupSms(productNameFilter = '') {
  const data = getData()
  const recipients = []
  for (const c of data.customers) {
    let total = 0
    const parts = []
    ;(c.products || []).forEach((p, idx) => {
      if (productNameFilter && String(p.name || '') !== productNameFilter) return
      const bal = getOperationalBalance(p)
      if (bal > 0) {
        total += bal
        parts.push(`${p.name}: ${formatBalanceFa(bal)}`)
      }
    })
    if (total <= 0) continue
    recipients.push(buildRecipientFromCustomer(c, {
      product_name: parts.join('، ') || 'محصولات',
      balance: formatBalanceFa(total),
      total_balance: formatBalanceFa(total),
    }))
  }
  if (!recipients.length) {
    showToast('بدهکاری یافت نشد')
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

export async function openFollowupBulkSms(items) {
  const recipients = (items || []).map((item) => {
    const customer = getData().customers.find((c) => c.id === item.customerId)
    if (!customer) return null
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
  const hour = getFollowupSmsDefaultHour()
  // followupDate is Jalali YYYY/MM/DD — store send_at as approx: use local Date with that calendar string in meta; convert via midday UTC offset heuristic
  // Practical approach: send_at = now if date is today/past morning; else encode as ISO from a parsed approximation.
  // We keep Jalali in meta and set send_at to tomorrow-equivalent using a simple local construction:
  const sendAt = jalaliDateToApproxIso(followupDate, hour)
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

/** Very rough Jalali→ISO for scheduling (same-day hour in Asia/Tehran wall clock via offset). */
function jalaliDateToApproxIso(jalaliDate, hour) {
  const parts = String(jalaliDate || '').split('/').map((x) => parseInt(x, 10))
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) {
    const d = new Date()
    d.setHours(hour, 0, 0, 0)
    return d.toISOString()
  }
  // Use Intl-free approximation: treat as gregorian offset ~621 years for scheduling MVP
  // Better: store as UTC date constructed from jalaali if available — check if project has helper
  try {
    // dynamic: many carno files use jalali — look for toGregorian
    const gy = parts[0] - 621
    const d = new Date(Date.UTC(gy, parts[1] - 1, parts[2], hour - 3.5, 0, 0))
    if (!Number.isNaN(d.getTime())) return d.toISOString()
  } catch (_) { /* fallthrough */ }
  const d = new Date()
  d.setHours(hour, 0, 0, 0)
  return d.toISOString()
}

// —— Campaign wizard ——
let campaignAudience = []

export async function openSmsCampaignModal() {
  if (!canUseSmsKind('customer_campaign')) {
    showToast('کمپین پیامک فعال نیست یا دسترسی ندارید')
    return
  }
  const statuses = getStatuses()
  const statusSel = document.getElementById('smsCampaignStatus')
  if (statusSel) {
    statusSel.innerHTML = `<option value="">همه</option>` + statuses.map((s) =>
      `<option value="${escapeAttr(s.key)}">${escapeHtml(s.label || s.key)}</option>`
    ).join('')
  }
  const templates = await listSmsTemplates().catch(() => [])
  const tplSel = document.getElementById('smsCampaignTemplate')
  if (tplSel) {
    tplSel.innerHTML = templates.map((t) =>
      `<option value="${escapeAttr(t.key)}" ${t.key === 'customer_campaign' ? 'selected' : ''}>${escapeHtml(t.name || t.key)}</option>`
    ).join('')
  }
  const tpl = templates.find((t) => t.key === 'customer_campaign') || templates[0]
  const bodyEl = document.getElementById('smsCampaignBody')
  if (bodyEl) bodyEl.value = tpl?.body || ''
  const titleEl = document.getElementById('smsCampaignTitle')
  if (titleEl) titleEl.value = ''
  refreshSmsCampaignAudience()
  document.getElementById('smsCampaignModal')?.classList.add('active')
}

export function closeSmsCampaignModal() {
  campaignAudience = []
  document.getElementById('smsCampaignModal')?.classList.remove('active')
}

export function onSmsCampaignTemplateChange() {
  const key = document.getElementById('smsCampaignTemplate')?.value || ''
  listSmsTemplates().then((templates) => {
    const tpl = templates.find((t) => t.key === key)
    const bodyEl = document.getElementById('smsCampaignBody')
    if (tpl && bodyEl) bodyEl.value = tpl.body || ''
  }).catch(() => {})
}

export function refreshSmsCampaignAudience() {
  const status = document.getElementById('smsCampaignStatus')?.value || ''
  const data = getData()
  campaignAudience = []
  for (const c of data.customers) {
    if (status && String(c.status || '') !== status) continue
    const phone = getPrimaryPhone(c) || c.phone
    if (!phone) continue
    campaignAudience.push(buildRecipientFromCustomer(c))
  }
  const el = document.getElementById('smsCampaignCount')
  if (el) el.textContent = `${campaignAudience.length} گیرنده`
}

export async function submitSmsCampaign() {
  if (!canUseSmsKind('customer_campaign')) return
  refreshSmsCampaignAudience()
  if (!campaignAudience.length) {
    showToast('مخاطبی انتخاب نشده')
    return
  }
  const title = document.getElementById('smsCampaignTitle')?.value?.trim() || 'کمپین پیامک'
  const mode = document.getElementById('smsCampaignMode')?.value || 'immediate'
  const templateKey = document.getElementById('smsCampaignTemplate')?.value || 'customer_campaign'
  const body = document.getElementById('smsCampaignBody')?.value || ''
  const dripInterval = Number(document.getElementById('smsCampaignDripInterval')?.value || 5)
  const dripBatch = Number(document.getElementById('smsCampaignDripBatch')?.value || 20)
  let sendAt = null
  const sendAtRaw = document.getElementById('smsCampaignSendAt')?.value
  if (mode === 'scheduled' && sendAtRaw) {
    sendAt = new Date(sendAtRaw).toISOString()
  }

  const campaign = await createSmsCampaign({
    title,
    template_key: templateKey,
    body,
    filter: { status: document.getElementById('smsCampaignStatus')?.value || '', recipients: campaignAudience },
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
    // Kick first batches from client
    for (let i = 0; i < campaignAudience.length; i += 50) {
      const chunk = campaignAudience.slice(i, i + 50)
      await invokeSendSms({
        mode: 'bulk',
        kind: 'customer_campaign',
        template_key: templateKey,
        body_override: body,
        recipients: chunk,
      })
    }
    // mark done via update
    const { supabase } = await import('./supabase.js')
    const tenantId = getStoredTenantId()
    await supabase.from('sms_campaigns').update({
      status: 'done',
      sent: campaignAudience.length,
      updated_at: new Date().toISOString(),
    }).eq('id', campaign.id).eq('tenant_id', tenantId)
    showToast('کمپین ارسال شد')
  } else {
    showToast(mode === 'scheduled' ? 'کمپین زمان‌بندی شد' : 'کمپین قطره‌ای شروع شد — کرون دسته‌ها را می‌فرستد')
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
