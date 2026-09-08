import { sendOTP, verifyOTP } from '../sms.js'
import { applyAuthSession, clearAuthSession } from '../tenant.js'
import { supabase } from '../supabase.js'
import { PLATFORM_SETTING_DEFAULTS, DIAMOND_ONLY_FEATURES, PLAN_IDS } from './defaults.js'
import {
  attemptPlatformLogin,
  clearPlatformGateSession,
  isPlatformAccessGranted,
  readPlatformGateSession
} from './gate.js'

const PLATFORM_AUTH_FLAG = 'carno_platform_authed_v1'

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
  $('platformGate')?.removeAttribute('hidden')
  $('platformShell')?.setAttribute('hidden', '')
}

function showShell() {
  $('platformGate')?.setAttribute('hidden', '')
  $('platformShell')?.removeAttribute('hidden')
}

function markAuthed(phone) {
  try {
    sessionStorage.setItem(PLATFORM_AUTH_FLAG, JSON.stringify({ phone, at: Date.now() }))
  } catch {
    /* ignore */
  }
}

function clearAuthedFlag() {
  try {
    sessionStorage.removeItem(PLATFORM_AUTH_FLAG)
  } catch {
    /* ignore */
  }
}

function readAuthedFlag() {
  try {
    const raw = sessionStorage.getItem(PLATFORM_AUTH_FLAG)
    if (!raw) return null
    return JSON.parse(raw)
  } catch {
    return null
  }
}

async function platformApi(action, payload = {}) {
  const { data: { session } } = await supabase.auth.getSession()
  if (!session?.access_token) throw new Error('نشست سوپرادمین موجود نیست')

  const { data, error } = await supabase.functions.invoke('platform-api', {
    body: { action, ...payload },
    headers: { Authorization: `Bearer ${session.access_token}` }
  })
  if (error) throw error
  if (!data?.success) throw new Error(data?.error || 'خطای platform-api')
  return data
}

function renderDefaultsSummary() {
  const el = $('platformDefaultsSummary')
  if (!el) return
  const d = PLATFORM_SETTING_DEFAULTS
  el.innerHTML = [
    `<li>Trial: <strong>${d.trial_days}</strong> روز</li>`,
    `<li>Grace پیش‌فرض: <strong>${d.grace_days}</strong> روز</li>`,
    `<li>سقف SMS/روز — Trial / طلایی / الماسی: <strong>${d.sms_daily_limit_trial}</strong> / <strong>${d.sms_daily_limit_gold}</strong> / <strong>${d.sms_daily_limit_diamond}</strong></li>`,
    `<li>پلن‌ها: ${Object.values(PLAN_IDS).join(' · ')}</li>`,
    `<li>فقط الماس: ${DIAMOND_ONLY_FEATURES.join(', ')}</li>`
  ].join('')
}

async function refreshTenants() {
  const list = $('platformTenantList')
  if (!list) return
  list.innerHTML = '<li style="color:var(--muted)">در حال بارگذاری...</li>'
  try {
    const data = await platformApi('list_tenants')
    const tenants = data.tenants || []
    if (!tenants.length) {
      list.innerHTML = '<li style="color:var(--muted)">سازمانی ثبت نشده</li>'
      return
    }
    list.innerHTML = tenants.map((t) => {
      const sub = t.subscription
      const plan = sub?.plan_id || '—'
      const st = sub?.status || '—'
      return `<li>
        <strong>${escapeHtml(t.name)}</strong>
        <span style="color:var(--muted)">(${escapeHtml(t.slug || '')})</span><br>
        <span style="color:var(--muted);font-size:0.85rem;">id: <code style="user-select:all">${escapeHtml(t.id)}</code></span><br>
        <span style="color:var(--muted);font-size:0.85rem;">پلن: ${escapeHtml(plan)} · وضعیت: ${escapeHtml(st)} · ${escapeHtml(t.status)}</span>
        <br><button type="button" class="secondary" style="margin-top:8px;padding:6px 10px;font-size:0.8rem;" data-fill-tenant="${escapeAttr(t.id)}" data-fill-plan="${escapeAttr(plan)}">پر کردن فرم پلن</button>
      </li>`
    }).join('')
    list.querySelectorAll('[data-fill-tenant]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-fill-tenant')
        const plan = btn.getAttribute('data-fill-plan')
        if ($('subTenantId')) $('subTenantId').value = id || ''
        if ($('manualTenantId')) $('manualTenantId').value = id || ''
        if (plan && $('subPlanId') && ['trial', 'gold', 'diamond'].includes(plan)) {
          $('subPlanId').value = plan
        }
        if (plan && $('manualPlanId') && ['gold', 'diamond'].includes(plan)) {
          $('manualPlanId').value = plan
        }
      })
    })
  } catch (e) {
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
  const phone = ($('platformPhone')?.value || '').trim()
  const btn = $('platformSendOtpBtn')
  if (btn) btn.disabled = true
  setStatus('')
  try {
    const result = await sendOTP(phone, { purpose: 'platform' })
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
  const phone = ($('platformPhone')?.value || '').trim()
  const otp = ($('platformOtp')?.value || '').trim()
  const btn = $('platformLoginBtn')
  if (btn) btn.disabled = true
  setStatus('')
  try {
    // Gate stub still validates empty fields; real path uses Edge
    if (!phone || !otp) {
      setStatus('شماره و کد لازم است')
      return
    }
    const result = await verifyOTP(phone, otp, { purpose: 'platform' })
    if (!result.success || !result.session) {
      setStatus(result.error || 'ورود ناموفق')
      return
    }
    await applyAuthSession(result.session)
    markAuthed(phone)
    showShell()
    await refreshTenants()
    await loadSettingsForm()
    await refreshPayments()
  } catch (e) {
    setStatus(e.message || 'خطا')
  } finally {
    if (btn) btn.disabled = false
  }
}

async function onCreateTenant(event) {
  event.preventDefault()
  const name = ($('newTenantName')?.value || '').trim()
  const ownerPhone = ($('newTenantOwnerPhone')?.value || '').trim()
  const planId = ($('newTenantPlan')?.value || 'trial')
  const status = $('platformCreateStatus')
  try {
    await platformApi('create_tenant', { name, owner_phone: ownerPhone || undefined, plan_id: planId })
    if (status) {
      status.hidden = false
      status.textContent = 'سازمان ساخته شد.'
      status.dataset.tone = 'info'
    }
    $('newTenantName').value = ''
    $('newTenantOwnerPhone').value = ''
    await refreshTenants()
  } catch (e) {
    if (status) {
      status.hidden = false
      status.textContent = e.message || 'خطا'
      status.dataset.tone = 'error'
    }
  }
}

async function loadSettingsForm() {
  try {
    const data = await platformApi('get_settings')
    const s = data.settings || {}
    const map = {
      grace_days: 'settingGraceDays',
      sms_daily_limit_trial: 'settingSmsTrial',
      sms_daily_limit_gold: 'settingSmsGold',
      sms_daily_limit_diamond: 'settingSmsDiamond'
    }
    for (const [key, id] of Object.entries(map)) {
      const el = $(id)
      if (!el) continue
      const v = s[key]
      el.value = v == null ? PLATFORM_SETTING_DEFAULTS[key] ?? '' : v
    }
  } catch (e) {
    console.warn('loadSettingsForm', e)
  }
}

async function onSaveSettings(event) {
  event.preventDefault()
  const status = $('platformSettingsStatus')
  try {
    await platformApi('update_settings', {
      settings: {
        grace_days: Number($('settingGraceDays')?.value || 3),
        sms_daily_limit_trial: Number($('settingSmsTrial')?.value || 20),
        sms_daily_limit_gold: Number($('settingSmsGold')?.value || 50),
        sms_daily_limit_diamond: Number($('settingSmsDiamond')?.value || 200)
      }
    })
    if (status) {
      status.hidden = false
      status.textContent = 'ذخیره شد.'
      status.dataset.tone = 'info'
    }
  } catch (e) {
    if (status) {
      status.hidden = false
      status.textContent = e.message || 'خطا'
      status.dataset.tone = 'error'
    }
  }
}

async function onSetSubscription(event) {
  event.preventDefault()
  const status = $('platformSubStatus')
  try {
    await platformApi('set_subscription', {
      tenant_id: ($('subTenantId')?.value || '').trim(),
      plan_id: $('subPlanId')?.value || 'gold',
      status: $('subStatus')?.value || 'active',
      ends_in_days: Number($('subEndsInDays')?.value || 30)
    })
    if (status) {
      status.hidden = false
      status.textContent = 'اشتراک به‌روز شد.'
      status.dataset.tone = 'info'
    }
    await refreshTenants()
  } catch (e) {
    if (status) {
      status.hidden = false
      status.textContent = e.message || 'خطا'
      status.dataset.tone = 'error'
    }
  }
}

async function refreshPayments() {
  const list = $('platformPaymentsList')
  if (!list) return
  list.innerHTML = '<li style="color:var(--muted)">...</li>'
  try {
    const tenantId = ($('manualTenantId')?.value || $('subTenantId')?.value || '').trim()
    const data = await platformApi('list_payments', tenantId ? { tenant_id: tenantId } : {})
    const rows = data.payments || []
    if (!rows.length) {
      list.innerHTML = '<li style="color:var(--muted)">پرداختی نیست</li>'
      return
    }
    list.innerHTML = rows.map((p) =>
      `<li><code>${escapeHtml(p.id)}</code><br>${escapeHtml(p.plan_id)} / ${escapeHtml(p.period)} — ${Number(p.amount_irr || 0).toLocaleString('fa-IR')} — <strong>${escapeHtml(p.status)}</strong>${p.ref_id ? ` — ${escapeHtml(p.ref_id)}` : ''}</li>`
    ).join('')
  } catch (e) {
    list.innerHTML = `<li style="color:var(--danger)">${escapeHtml(e.message || 'خطا')}</li>`
  }
}

async function onManualPay(event) {
  event.preventDefault()
  const status = $('platformManualPayStatus')
  try {
    await platformApi('record_manual_payment', {
      tenant_id: ($('manualTenantId')?.value || '').trim(),
      plan_id: $('manualPlanId')?.value || 'gold',
      period: $('manualPeriod')?.value || 'monthly',
      amount_irr: Number($('manualAmount')?.value || 0),
      note: ($('manualNote')?.value || '').trim(),
      ends_in_days: ($('manualPeriod')?.value === 'yearly') ? 365 : 30
    })
    if (status) {
      status.hidden = false
      status.textContent = 'پرداخت دستی ثبت و اشتراک فعال شد.'
      status.dataset.tone = 'info'
    }
    await refreshTenants()
    await refreshPayments()
  } catch (e) {
    if (status) {
      status.hidden = false
      status.textContent = e.message || 'خطا'
      status.dataset.tone = 'error'
    }
  }
}

async function onLogout() {
  clearAuthedFlag()
  clearPlatformGateSession()
  await clearAuthSession()
  showGate()
  setStatus('خارج شدید.', false)
}

async function boot() {
  renderDefaultsSummary()
  $('platformSendOtpForm')?.addEventListener('submit', onSendOtp)
  $('platformLoginForm')?.addEventListener('submit', onVerify)
  $('platformCreateForm')?.addEventListener('submit', onCreateTenant)
  $('platformSettingsForm')?.addEventListener('submit', onSaveSettings)
  $('platformSubForm')?.addEventListener('submit', onSetSubscription)
  $('platformManualPayForm')?.addEventListener('submit', onManualPay)
  $('platformRefreshPaymentsBtn')?.addEventListener('click', () => refreshPayments())
  $('platformLogoutBtn')?.addEventListener('click', onLogout)

  // Phase 0 stub no longer blocks after real OTP; keep helpers referenced
  void attemptPlatformLogin
  void isPlatformAccessGranted
  void readPlatformGateSession

  const { data: { session } } = await supabase.auth.getSession()
  const flag = readAuthedFlag()
  if (session && flag) {
    showShell()
    await refreshTenants()
    await loadSettingsForm()
    await refreshPayments()
  } else {
    showGate()
    setStatus('فقط شماره‌های allowlist سرور (PLATFORM_ADMIN_PHONES) مجازند.', false)
  }
}

boot()
