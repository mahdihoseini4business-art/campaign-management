import { sendOTP, verifyOTP } from '../sms.js'
import { readFunctionsInvokeError, functionsErrorStatus } from '../edge-error.js'
import { normalizePhone } from '../utils.js'
import { platformSupabase } from './client.js'
import {
  PLATFORM_SETTING_DEFAULTS,
  DIAMOND_ONLY_FEATURES,
  PLAN_IDS,
  mergePlatformSettings,
  coercePlatformSetting
} from './defaults.js'
import {
  PLATFORM_AUTH_FLAG_KEY,
  LEGACY_PLATFORM_SESSION_STORAGE_KEY
} from './session-contract.js'

function $(id) {
  return document.getElementById(id)
}

function setStatus(message, isError = true) {
  const el = $('platformGateStatus')
  if (!el) return
  el.textContent = message || ''
  el.hidden = !message
  el.dataset.tone = isError ? 'error' : 'info'
}

function showGate() {
  $('platformBoot')?.setAttribute('hidden', '')
  $('platformGate')?.removeAttribute('hidden')
  $('platformShell')?.setAttribute('hidden', '')
}

function showShell() {
  $('platformBoot')?.setAttribute('hidden', '')
  $('platformGate')?.setAttribute('hidden', '')
  $('platformShell')?.removeAttribute('hidden')
}

function markAuthed(phone) {
  try {
    sessionStorage.setItem(PLATFORM_AUTH_FLAG_KEY, JSON.stringify({ phone, at: Date.now() }))
  } catch {
    /* ignore */
  }
}

function clearAuthedFlag() {
  try {
    sessionStorage.removeItem(PLATFORM_AUTH_FLAG_KEY)
  } catch {
    /* ignore */
  }
}

function readPhoneFromForm() {
  const el = $('platformPhone')
  const phone = normalizePhone(el?.value || '')
  if (el && phone) el.value = phone
  return phone
}

function requireValidPhone() {
  const phone = readPhoneFromForm()
  if (!/^09\d{9}$/.test(phone)) {
    setStatus('شماره موبایل معتبر نیست (09xxxxxxxxx)')
    return null
  }
  return phone
}

async function applyPlatformSession(session) {
  if (!session?.access_token || !session?.refresh_token) {
    throw new Error('session missing tokens')
  }
  const { error } = await platformSupabase.auth.setSession({
    access_token: session.access_token,
    refresh_token: session.refresh_token
  })
  if (error) throw error
}

async function clearPlatformAuth() {
  clearAuthedFlag()
  try {
    localStorage.removeItem(LEGACY_PLATFORM_SESSION_STORAGE_KEY)
  } catch {
    /* ignore */
  }
  try {
    await platformSupabase.auth.signOut()
  } catch (e) {
    console.warn('platform signOut', e)
  }
}

async function platformApi(action, payload = {}) {
  const { data: { session } } = await platformSupabase.auth.getSession()
  if (!session?.access_token) throw new Error('نشست سوپرادمین موجود نیست')

  const { data, error } = await platformSupabase.functions.invoke('platform-api', {
    body: { action, ...payload },
    headers: { Authorization: `Bearer ${session.access_token}` }
  })
  if (error) {
    const detail = await readFunctionsInvokeError(error, 'خطای platform-api')
    const err = new Error(data?.error || detail)
    err.status = functionsErrorStatus(error)
    throw err
  }
  if (!data?.success) throw new Error(data?.error || 'خطای platform-api')
  return data
}

async function tenantOps(action, payload = {}) {
  const { data: { session } } = await platformSupabase.auth.getSession()
  if (!session?.access_token) throw new Error('نشست سوپرادمین موجود نیست')
  const { data, error } = await platformSupabase.functions.invoke('tenant-ops', {
    body: { action, ...payload },
    headers: { Authorization: `Bearer ${session.access_token}` }
  })
  if (error) {
    const detail = await readFunctionsInvokeError(error, 'خطای tenant-ops')
    throw new Error(data?.error || detail)
  }
  if (!data?.success) throw new Error(data?.error || 'خطای tenant-ops')
  return data
}

/**
 * Server allowlist check — client flag alone never grants shell.
 * @returns {Promise<{ ok: true, phone: string } | { ok: false, message: string, forbidden?: boolean }>}
 */
async function ensurePlatformAccess() {
  const { data: { session } } = await platformSupabase.auth.getSession()
  if (!session?.access_token) {
    return { ok: false, message: 'نشست سوپرادمین موجود نیست' }
  }
  try {
    const data = await platformApi('whoami')
    const phone = String(data?.phone || '').trim()
    if (!phone) return { ok: false, message: 'دسترسی مجاز نیست', forbidden: true }
    return { ok: true, phone }
  } catch (e) {
    const msg = e?.message || ''
    const status = e?.status
    const forbidden = status === 403 || /مجاز نیست|Forbidden/i.test(msg)
    return {
      ok: false,
      message: forbidden ? 'دسترسی مجاز نیست' : (msg || 'تأیید دسترسی ناموفق بود'),
      forbidden
    }
  }
}

let tenantsCache = []
let paymentsCache = []
let rootDomainCache = PLATFORM_SETTING_DEFAULTS.root_domain
const statusClearTimers = new Map()

function setFormBusy(form, busy) {
  if (!form) return
  form.querySelectorAll('button, input, select, textarea').forEach((el) => {
    if (el.dataset.keepEnabled === '1') return
    el.disabled = !!busy
  })
}

function setButtonBusy(btn, busy) {
  if (!btn) return
  btn.disabled = !!busy
}

function findCachedTenant(tenantId) {
  return tenantsCache.find((t) => t.id === tenantId) || null
}

function tenantHasDiamondSubdomain(tenant) {
  const plan = tenant?.subscription?.plan_id
  return plan === 'diamond'
}

function formatAuditMeta(meta) {
  if (meta == null) return ''
  try {
    return JSON.stringify(meta, null, 0)
  } catch {
    return String(meta)
  }
}

function flashStatus(elOrId, message, isError = false, clearMs = 4500) {
  const el = typeof elOrId === 'string' ? $(elOrId) : elOrId
  if (!el) return
  const key = el.id || el
  if (statusClearTimers.has(key)) {
    clearTimeout(statusClearTimers.get(key))
    statusClearTimers.delete(key)
  }
  el.hidden = !message
  el.textContent = message || ''
  el.dataset.tone = isError ? 'error' : 'info'
  if (message && !isError && clearMs > 0) {
    statusClearTimers.set(key, setTimeout(() => {
      el.hidden = true
      el.textContent = ''
      statusClearTimers.delete(key)
    }, clearMs))
  }
}

async function copyText(text) {
  const value = String(text || '')
  if (!value) return false
  try {
    await navigator.clipboard.writeText(value)
    return true
  } catch {
    try {
      const ta = document.createElement('textarea')
      ta.value = value
      ta.setAttribute('readonly', '')
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      const ok = document.execCommand('copy')
      document.body.removeChild(ta)
      return ok
    } catch {
      return false
    }
  }
}

function subdomainHost(label) {
  const sub = String(label || '').trim().toLowerCase()
  const root = String(rootDomainCache || PLATFORM_SETTING_DEFAULTS.root_domain).trim()
  if (!sub || !root) return ''
  return `${sub}.${root}`
}

function tenantMatchesQuery(t, q) {
  if (!q) return true
  const hay = [
    t.name,
    t.slug,
    t.id,
    t.subdomain,
    t.status,
    t.subscription?.plan_id,
    t.subscription?.status
  ].map((x) => String(x || '').toLowerCase()).join(' ')
  return hay.includes(q)
}

function renderTenantList() {
  const list = $('platformTenantList')
  if (!list) return
  const q = ($('platformTenantSearch')?.value || '').trim().toLowerCase()
  const tenants = tenantsCache.filter((t) => tenantMatchesQuery(t, q))
  if (!tenantsCache.length) {
    list.innerHTML = '<li style="color:var(--muted)">سازمانی ثبت نشده</li>'
    return
  }
  if (!tenants.length) {
    list.innerHTML = '<li style="color:var(--muted)">موردی با این جستجو نیست</li>'
    return
  }
  list.innerHTML = tenants.map((t) => {
    const sub = t.subscription
    const plan = sub?.plan_id || '—'
    const st = sub?.status || '—'
    const host = t.subdomain ? subdomainHost(t.subdomain) : ''
    const hostHtml = host
      ? ` · <a class="sub-link" href="https://${escapeAttr(host)}" target="_blank" rel="noopener noreferrer" dir="ltr">${escapeHtml(host)}</a>`
      : ''
    return `<li>
      <strong>${escapeHtml(t.name)}</strong>
      <span style="color:var(--muted)">(${escapeHtml(t.slug || '')})</span><br>
      <span style="color:var(--muted);font-size:0.85rem;">id: <code style="user-select:all">${escapeHtml(t.id)}</code></span>
      <div class="inline-actions">
        <button type="button" class="secondary" data-copy-id="${escapeAttr(t.id)}">کپی id</button>
        <button type="button" class="secondary" data-fill-tenant="${escapeAttr(t.id)}" data-fill-plan="${escapeAttr(plan)}">پر کردن فرم‌ها</button>
      </div>
      <span style="color:var(--muted);font-size:0.85rem;">پلن: ${escapeHtml(plan)} · وضعیت: ${escapeHtml(st)} · ${escapeHtml(t.status)}${t.archived_at ? ' · آرشیو' : ''}${t.subdomain ? ` · ${escapeHtml(t.subdomain)}` : ''}${hostHtml}</span>
    </li>`
  }).join('')

  list.querySelectorAll('[data-fill-tenant]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-fill-tenant')
      const plan = btn.getAttribute('data-fill-plan')
      if ($('subTenantId')) $('subTenantId').value = id || ''
      if ($('manualTenantId')) $('manualTenantId').value = id || ''
      if ($('opsTenantId')) $('opsTenantId').value = id || ''
      if (plan && $('subPlanId') && ['trial', 'gold', 'diamond'].includes(plan)) {
        $('subPlanId').value = plan
      }
      if (plan && $('manualPlanId') && ['gold', 'diamond'].includes(plan)) {
        $('manualPlanId').value = plan
      }
    })
  })
  list.querySelectorAll('[data-copy-id]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.getAttribute('data-copy-id') || ''
      const ok = await copyText(id)
      btn.textContent = ok ? 'کپی شد' : 'خطا'
      setTimeout(() => { btn.textContent = 'کپی id' }, 1200)
    })
  })
}

function renderPaymentsList() {
  const list = $('platformPaymentsList')
  if (!list) return
  const statusFilter = ($('platformPaymentStatusFilter')?.value || '').trim()
  const rows = statusFilter
    ? paymentsCache.filter((p) => String(p.status || '') === statusFilter)
    : paymentsCache
  if (!paymentsCache.length) {
    list.innerHTML = '<li style="color:var(--muted)">پرداختی نیست</li>'
    return
  }
  if (!rows.length) {
    list.innerHTML = '<li style="color:var(--muted)">موردی با این فیلتر نیست</li>'
    return
  }
  list.innerHTML = rows.map((p) =>
    `<li><code>${escapeHtml(p.id)}</code><br>${escapeHtml(p.plan_id)} / ${escapeHtml(p.period)} — ${Number(p.amount_irr || 0).toLocaleString('fa-IR')} — <strong>${escapeHtml(p.status)}</strong>${p.ref_id ? ` — ${escapeHtml(p.ref_id)}` : ''}${p.tenant_id ? `<br><span style="font-size:0.8rem;">tenant: <code style="user-select:all">${escapeHtml(p.tenant_id)}</code></span>` : ''}</li>`
  ).join('')
}

async function enterShell(phone) {
  markAuthed(phone)
  showShell()
  await refreshTenants()
  await loadSettingsForm()
  await refreshPayments()
}

function renderDefaultsSummary(settings = PLATFORM_SETTING_DEFAULTS) {
  const el = $('platformDefaultsSummary')
  if (!el) return
  const d = mergePlatformSettings(settings)
  el.innerHTML = [
    `<li>Trial: <strong>${escapeHtml(d.trial_days)}</strong> روز</li>`,
    `<li>Grace: <strong>${escapeHtml(d.grace_days)}</strong> روز</li>`,
    `<li>دامنه ریشه: <strong dir="ltr">${escapeHtml(d.root_domain)}</strong></li>`,
    `<li>حداقل طول ساب‌دامین: <strong>${escapeHtml(d.subdomain_min_length)}</strong></li>`,
    `<li>سقف SMS/روز — Trial / طلایی / الماسی: <strong>${escapeHtml(d.sms_daily_limit_trial)}</strong> / <strong>${escapeHtml(d.sms_daily_limit_gold)}</strong> / <strong>${escapeHtml(d.sms_daily_limit_diamond)}</strong></li>`,
    `<li>پلن‌ها: ${escapeHtml(Object.values(PLAN_IDS).join(' · '))}</li>`,
    `<li>فقط الماس: ${escapeHtml(DIAMOND_ONLY_FEATURES.join(', '))}</li>`
  ].join('')
}

function setSettingsStatus(message, isError = false) {
  const status = $('platformSettingsStatus')
  if (!status) return
  status.hidden = !message
  status.textContent = message || ''
  status.dataset.tone = isError ? 'error' : 'info'
}

async function refreshTenants() {
  const list = $('platformTenantList')
  if (!list) return
  list.innerHTML = '<li style="color:var(--muted)">در حال بارگذاری...</li>'
  try {
    const data = await platformApi('list_tenants')
    tenantsCache = data.tenants || []
    renderTenantList()
  } catch (e) {
    tenantsCache = []
    list.innerHTML = `<li style="color:var(--danger)">${escapeHtml(e.message || 'خطا')}</li>`
  }
}

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function escapeAttr(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
}

async function onSendOtp(event) {
  event.preventDefault()
  const phone = requireValidPhone()
  if (!phone) return
  const btn = $('platformSendOtpBtn')
  if (btn) btn.disabled = true
  setStatus('')
  try {
    const result = await sendOTP(phone, { purpose: 'platform', client: platformSupabase })
    if (!result.success) {
      setStatus(result.error || 'ارسال ناموفق')
      return
    }
    $('platformOtpBlock')?.removeAttribute('hidden')
    setStatus('کد ارسال شد.', false)
  } finally {
    if (btn) btn.disabled = false
  }
}

async function onVerify(event) {
  event.preventDefault()
  const phone = requireValidPhone()
  const otp = ($('platformOtp')?.value || '').trim()
  const btn = $('platformLoginBtn')
  if (btn) btn.disabled = true
  setStatus('')
  try {
    if (!phone) return
    if (!otp) {
      setStatus('کد تأیید لازم است')
      return
    }
    const result = await verifyOTP(phone, otp, { purpose: 'platform', client: platformSupabase })
    if (!result.success || !result.session) {
      setStatus(result.error || 'ورود ناموفق')
      return
    }
    await applyPlatformSession(result.session)
    const access = await ensurePlatformAccess()
    if (!access.ok) {
      await clearPlatformAuth()
      showGate()
      setStatus(access.message || 'دسترسی مجاز نیست')
      return
    }
    await enterShell(access.phone)
  } catch (e) {
    setStatus(e.message || 'خطا')
  } finally {
    if (btn) btn.disabled = false
  }
}

async function onCreateTenant(event) {
  event.preventDefault()
  const form = $('platformCreateForm')
  const name = ($('newTenantName')?.value || '').trim()
  const ownerPhone = ($('newTenantOwnerPhone')?.value || '').trim()
  const planId = ($('newTenantPlan')?.value || 'trial')
  const status = $('platformCreateStatus')
  setFormBusy(form, true)
  try {
    await platformApi('create_tenant', { name, owner_phone: ownerPhone || undefined, plan_id: planId })
    flashStatus(status, 'سازمان ساخته شد.', false)
    if ($('newTenantName')) $('newTenantName').value = ''
    if ($('newTenantOwnerPhone')) $('newTenantOwnerPhone').value = ''
    await refreshTenants()
  } catch (e) {
    flashStatus(status, e.message || 'خطا', true, 0)
  } finally {
    setFormBusy(form, false)
  }
}

async function loadSettingsForm() {
  try {
    const data = await platformApi('get_settings')
    const merged = mergePlatformSettings(data.settings || {})
    const map = {
      trial_days: 'settingTrialDays',
      grace_days: 'settingGraceDays',
      sms_daily_limit_trial: 'settingSmsTrial',
      sms_daily_limit_gold: 'settingSmsGold',
      sms_daily_limit_diamond: 'settingSmsDiamond',
      root_domain: 'settingRootDomain',
      subdomain_min_length: 'settingSubdomainMinLength'
    }
    for (const [key, id] of Object.entries(map)) {
      const el = $(id)
      if (!el) continue
      el.value = merged[key]
    }
    renderDefaultsSummary(merged)
    rootDomainCache = merged.root_domain
    setSettingsStatus('')
    renderTenantList()
  } catch (e) {
    console.warn('loadSettingsForm', e)
    setSettingsStatus(e.message || 'بارگذاری تنظیمات ناموفق بود', true)
  }
}

async function onSaveSettings(event) {
  event.preventDefault()
  try {
    const settings = {
      trial_days: coercePlatformSetting('trial_days', $('settingTrialDays')?.value),
      grace_days: coercePlatformSetting('grace_days', $('settingGraceDays')?.value),
      sms_daily_limit_trial: coercePlatformSetting('sms_daily_limit_trial', $('settingSmsTrial')?.value),
      sms_daily_limit_gold: coercePlatformSetting('sms_daily_limit_gold', $('settingSmsGold')?.value),
      sms_daily_limit_diamond: coercePlatformSetting('sms_daily_limit_diamond', $('settingSmsDiamond')?.value),
      root_domain: coercePlatformSetting('root_domain', $('settingRootDomain')?.value),
      subdomain_min_length: coercePlatformSetting('subdomain_min_length', $('settingSubdomainMinLength')?.value)
    }
    await platformApi('update_settings', { settings })
    renderDefaultsSummary(settings)
    rootDomainCache = settings.root_domain
    renderTenantList()
    flashStatus('platformSettingsStatus', 'ذخیره شد.', false)
  } catch (e) {
    flashStatus('platformSettingsStatus', e.message || 'خطا', true, 0)
  }
}

async function onSetSubscription(event) {
  event.preventDefault()
  const form = $('platformSubForm')
  const status = $('platformSubStatus')
  setFormBusy(form, true)
  try {
    const subStatus = $('subStatus')?.value || 'active'
    const payload = {
      tenant_id: ($('subTenantId')?.value || '').trim(),
      plan_id: $('subPlanId')?.value || 'gold',
      status: subStatus,
    }
    // Only active renews ends_at from the form. trialing uses server trial_days;
    // grace/readonly/suspended must not rewrite ends_at.
    if (subStatus === 'active') {
      payload.ends_in_days = Number($('subEndsInDays')?.value || 30)
    }
    await platformApi('set_subscription', payload)
    flashStatus(status, 'اشتراک به‌روز شد.', false)
    await refreshTenants()
  } catch (e) {
    flashStatus(status, e.message || 'خطا', true, 0)
  } finally {
    setFormBusy(form, false)
  }
}

async function refreshPayments() {
  const list = $('platformPaymentsList')
  if (!list) return
  list.innerHTML = '<li style="color:var(--muted)">...</li>'
  try {
    const tenantId = ($('manualTenantId')?.value || $('subTenantId')?.value || '').trim()
    const data = await platformApi('list_payments', tenantId ? { tenant_id: tenantId } : {})
    paymentsCache = data.payments || []
    renderPaymentsList()
  } catch (e) {
    paymentsCache = []
    list.innerHTML = `<li style="color:var(--danger)">${escapeHtml(e.message || 'خطا')}</li>`
  }
}

async function onManualPay(event) {
  event.preventDefault()
  const form = $('platformManualPayForm')
  const status = $('platformManualPayStatus')
  setFormBusy(form, true)
  try {
    const amount = Number($('manualAmount')?.value)
    if (!Number.isFinite(amount) || amount <= 0) {
      flashStatus(status, 'مبلغ باید بزرگ‌تر از صفر باشد', true, 0)
      return
    }
    await platformApi('record_manual_payment', {
      tenant_id: ($('manualTenantId')?.value || '').trim(),
      plan_id: $('manualPlanId')?.value || 'gold',
      period: $('manualPeriod')?.value || 'monthly',
      amount_irr: amount,
      note: ($('manualNote')?.value || '').trim(),
      ends_in_days: ($('manualPeriod')?.value === 'yearly') ? 365 : 30
    })
    flashStatus(status, 'پرداخت دستی ثبت و اشتراک فعال شد.', false)
    await refreshTenants()
    await refreshPayments()
  } catch (e) {
    flashStatus(status, e.message || 'خطا', true, 0)
  } finally {
    setFormBusy(form, false)
  }
}

async function onSetSubdomain(event) {
  event.preventDefault()
  const form = $('platformSubdomainForm')
  const status = $('platformOpsStatus')
  const tenantId = ($('opsTenantId')?.value || '').trim()
  const subdomain = ($('opsSubdomain')?.value || '').trim()
  const cached = findCachedTenant(tenantId)
  if (cached && !tenantHasDiamondSubdomain(cached)) {
    const ok = window.confirm(
      'این سازمان پلن الماسی ندارد. تنظیم ساب‌دامین به‌عنوان سوپرادمین override entitlement است. ادامه می‌دهید؟'
    )
    if (!ok) return
  } else if (!cached && tenantId) {
    const ok = window.confirm(
      'پلن این سازمان در کش فهرست نیست. اگر entitlement الماس نداشته باشد، باز هم به‌عنوان سوپرادمین override می‌شود. ادامه؟'
    )
    if (!ok) return
  }
  setFormBusy(form, true)
  setButtonBusy($('platformClearSubdomainBtn'), true)
  setButtonBusy($('platformArchiveTenantBtn'), true)
  setButtonBusy($('platformUnarchiveTenantBtn'), true)
  try {
    const data = await tenantOps('set_subdomain', { tenant_id: tenantId, subdomain })
    flashStatus(status, data?.entitlement_override
      ? `ساب‌دامین تنظیم شد (override بدون entitlement): ${subdomain}`
      : `ساب‌دامین تنظیم شد: ${subdomain}`, false)
    await refreshTenants()
  } catch (e) {
    flashStatus(status, e.message || 'خطا', true, 0)
  } finally {
    setFormBusy(form, false)
    setButtonBusy($('platformClearSubdomainBtn'), false)
    setButtonBusy($('platformArchiveTenantBtn'), false)
    setButtonBusy($('platformUnarchiveTenantBtn'), false)
  }
}

async function onClearSubdomain() {
  const status = $('platformOpsStatus')
  const form = $('platformSubdomainForm')
  setFormBusy(form, true)
  setButtonBusy($('platformClearSubdomainBtn'), true)
  setButtonBusy($('platformArchiveTenantBtn'), true)
  setButtonBusy($('platformUnarchiveTenantBtn'), true)
  try {
    await tenantOps('clear_subdomain', { tenant_id: ($('opsTenantId')?.value || '').trim() })
    flashStatus(status, 'ساب‌دامین حذف شد.', false)
    if ($('opsSubdomain')) $('opsSubdomain').value = ''
    await refreshTenants()
  } catch (e) {
    flashStatus(status, e.message || 'خطا', true, 0)
  } finally {
    setFormBusy(form, false)
    setButtonBusy($('platformClearSubdomainBtn'), false)
    setButtonBusy($('platformArchiveTenantBtn'), false)
    setButtonBusy($('platformUnarchiveTenantBtn'), false)
  }
}

async function onArchiveTenant() {
  const status = $('platformOpsStatus')
  const form = $('platformSubdomainForm')
  const btn = $('platformArchiveTenantBtn')
  const tenantId = ($('opsTenantId')?.value || '').trim()
  if (!tenantId) {
    flashStatus(status, 'شناسه tenant لازم است', true, 0)
    return
  }
  if (!window.confirm('آرشیو این سازمان؟ ساب‌دامین پاک و اشتراک معلق می‌شود.')) return
  setFormBusy(form, true)
  setButtonBusy(btn, true)
  setButtonBusy($('platformUnarchiveTenantBtn'), true)
  setButtonBusy($('platformClearSubdomainBtn'), true)
  try {
    await tenantOps('archive_tenant', { tenant_id: tenantId })
    flashStatus(status, 'سازمان آرشیو شد.', false)
    await refreshTenants()
  } catch (e) {
    flashStatus(status, e.message || 'خطا', true, 0)
  } finally {
    setFormBusy(form, false)
    setButtonBusy(btn, false)
    setButtonBusy($('platformUnarchiveTenantBtn'), false)
    setButtonBusy($('platformClearSubdomainBtn'), false)
  }
}

async function onUnarchiveTenant() {
  const status = $('platformOpsStatus')
  const form = $('platformSubdomainForm')
  const btn = $('platformUnarchiveTenantBtn')
  const tenantId = ($('opsTenantId')?.value || '').trim()
  if (!tenantId) {
    flashStatus(status, 'شناسه tenant لازم است', true, 0)
    return
  }
  if (!window.confirm('خروج از آرشیو؟ سازمان دوباره active می‌شود و وضعیت اشتراک بر اساس تاریخ انقضا تنظیم می‌گردد.')) return
  setFormBusy(form, true)
  setButtonBusy(btn, true)
  setButtonBusy($('platformArchiveTenantBtn'), true)
  setButtonBusy($('platformClearSubdomainBtn'), true)
  try {
    const data = await tenantOps('unarchive_tenant', { tenant_id: tenantId })
    flashStatus(status, `از آرشیو خارج شد · اشتراک: ${data?.subscription_status || '—'}`, false)
    await refreshTenants()
  } catch (e) {
    flashStatus(status, e.message || 'خطا', true, 0)
  } finally {
    setFormBusy(form, false)
    setButtonBusy(btn, false)
    setButtonBusy($('platformArchiveTenantBtn'), false)
    setButtonBusy($('platformClearSubdomainBtn'), false)
  }
}

async function refreshAudit() {
  const list = $('platformAuditList')
  if (!list) return
  list.innerHTML = '<li style="color:var(--muted)">...</li>'
  try {
    const tenantId = ($('opsTenantId')?.value || '').trim()
    const data = await tenantOps('list_audit', tenantId ? { tenant_id: tenantId } : {})
    const rows = data.logs || []
    if (!rows.length) {
      list.innerHTML = '<li style="color:var(--muted)">لاگی نیست</li>'
      return
    }
    list.innerHTML = rows.map((r) => {
      const meta = formatAuditMeta(r.meta)
      return `<li style="margin-bottom:10px;">
        <code>${escapeHtml(r.created_at || '')}</code> · <strong>${escapeHtml(r.action)}</strong>
        ${r.tenant_id ? ` · tenant <code style="user-select:all">${escapeHtml(r.tenant_id)}</code>` : ''}
        ${r.entity_id ? ` · entity <code style="user-select:all">${escapeHtml(r.entity_id)}</code>` : ''}
        ${r.actor_username ? ` · ${escapeHtml(r.actor_username)}` : ''}
        ${meta ? `<details style="margin-top:4px;"><summary style="cursor:pointer;color:var(--muted);">meta</summary><pre style="white-space:pre-wrap;direction:ltr;text-align:left;margin:6px 0 0;font-size:0.75rem;color:var(--muted);">${escapeHtml(meta)}</pre></details>` : ''}
      </li>`
    }).join('')
  } catch (e) {
    list.innerHTML = `<li style="color:var(--danger)">${escapeHtml(e.message || 'خطا')}</li>`
  }
}

async function onLogout() {
  await clearPlatformAuth()
  showGate()
  setStatus('از پنل پلتفرم خارج شدید. نشست اپ سازمان (در صورت باز بودن) جداست و پاک نشده.', false)
}

async function boot() {
  renderDefaultsSummary()
  $('platformSendOtpForm')?.addEventListener('submit', onSendOtp)
  $('platformLoginForm')?.addEventListener('submit', onVerify)
  $('platformCreateForm')?.addEventListener('submit', onCreateTenant)
  $('platformSettingsForm')?.addEventListener('submit', onSaveSettings)
  $('platformSubForm')?.addEventListener('submit', onSetSubscription)
  $('platformManualPayForm')?.addEventListener('submit', onManualPay)
  $('platformSubdomainForm')?.addEventListener('submit', onSetSubdomain)
  $('platformClearSubdomainBtn')?.addEventListener('click', onClearSubdomain)
  $('platformArchiveTenantBtn')?.addEventListener('click', onArchiveTenant)
  $('platformUnarchiveTenantBtn')?.addEventListener('click', onUnarchiveTenant)
  $('platformRefreshTenantsBtn')?.addEventListener('click', () => refreshTenants())
  $('platformRefreshAuditBtn')?.addEventListener('click', () => refreshAudit())
  $('platformRefreshPaymentsBtn')?.addEventListener('click', () => refreshPayments())
  $('platformTenantSearch')?.addEventListener('input', () => renderTenantList())
  $('platformPaymentStatusFilter')?.addEventListener('change', () => renderPaymentsList())
  $('platformLogoutBtn')?.addEventListener('click', onLogout)

  const access = await ensurePlatformAccess()
  if (access.ok) {
    await enterShell(access.phone)
  } else {
    if (access.forbidden) {
      await clearPlatformAuth()
      showGate()
      setStatus('دسترسی مجاز نیست. با شماره allowlist دوباره وارد شوید.')
      return
    }
    showGate()
    setStatus('فقط شماره‌های allowlist سرور (PLATFORM_ADMIN_PHONES) مجازند.', false)
  }
}

boot()
