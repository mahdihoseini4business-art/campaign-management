/**
 * Phase 3–5: org subscription status UI + tenant-api / tenant-ops helpers
 */
import { supabase } from './supabase.js'
import { getStoredTenantId } from './tenant.js'
import { getEntitlements, loadEntitlements, applyEntitlementUI, canUseFeature } from './entitlements.js'
import { getCurrentUser, isMainAdmin, showToast } from './utils.js'
import { PLAN_IDS } from './platform/defaults.js'
import { validateSubdomainLabel, fetchRootDomain } from './subdomain.js'

const PLAN_LABELS = {
  [PLAN_IDS.trial]: 'آزمایشی',
  [PLAN_IDS.gold]: 'طلایی',
  [PLAN_IDS.diamond]: 'الماسی'
}

const STATUS_LABELS = {
  trialing: 'آزمایشی',
  active: 'فعال',
  grace: 'مهلت تمدید',
  readonly: 'فقط‌خواندنی',
  suspended: 'تعلیق'
}

async function tenantApi(action, payload = {}) {
  const { data: { session } } = await supabase.auth.getSession()
  if (!session?.access_token) throw new Error('نشست معتبر نیست')
  const { data, error } = await supabase.functions.invoke('tenant-api', {
    body: { action, ...payload },
    headers: { Authorization: `Bearer ${session.access_token}` }
  })
  if (error) throw error
  if (!data?.success) throw new Error(data?.error || 'خطای tenant-api')
  return data
}

export async function tenantOps(action, payload = {}) {
  const { data: { session } } = await supabase.auth.getSession()
  if (!session?.access_token) throw new Error('نشست معتبر نیست')
  const { data, error } = await supabase.functions.invoke('tenant-ops', {
    body: { action, ...payload },
    headers: { Authorization: `Bearer ${session.access_token}` }
  })
  if (error) throw error
  if (!data?.success) throw new Error(data?.error || 'خطای tenant-ops')
  return data
}

export async function inviteTenantMember({ phone, firstName, lastName, role = 'user' }) {
  const tenantId = getStoredTenantId()
  if (!tenantId) throw new Error('سازمان فعلی مشخص نیست')
  return tenantApi('invite_member', {
    tenant_id: tenantId,
    phone,
    first_name: firstName,
    last_name: lastName,
    role
  })
}

export async function fetchSubscriptionStatus() {
  const tenantId = getStoredTenantId()
  if (!tenantId) throw new Error('سازمان فعلی مشخص نیست')
  return tenantApi('subscription_status', { tenant_id: tenantId })
}

export async function listMyPayments() {
  const tenantId = getStoredTenantId()
  if (!tenantId) throw new Error('سازمان فعلی مشخص نیست')
  return tenantApi('list_payments', { tenant_id: tenantId })
}

/**
 * Start Zarinpal checkout; redirects browser to gateway.
 * @param {'gold'|'diamond'} planId
 * @param {'monthly'|'yearly'} [period]
 */
export async function startCheckout(planId, period = 'monthly') {
  const tenantId = getStoredTenantId()
  if (!tenantId) throw new Error('سازمان فعلی مشخص نیست')
  const { data: { session } } = await supabase.auth.getSession()
  if (!session?.access_token) throw new Error('نشست معتبر نیست')

  const { data, error } = await supabase.functions.invoke('create-payment', {
    body: { tenant_id: tenantId, plan_id: planId, period },
    headers: { Authorization: `Bearer ${session.access_token}` }
  })
  if (error) throw error
  if (!data?.success || !data.redirect_url) {
    throw new Error(data?.error || 'ایجاد پرداخت ناموفق')
  }
  window.location.href = data.redirect_url
  return data
}

function formatDate(iso) {
  if (!iso) return '—'
  try {
    return new Date(iso).toLocaleString('fa-IR')
  } catch {
    return String(iso)
  }
}

function ensureSubscriptionModal() {
  if (document.getElementById('subscriptionStatusModal')) return
  const el = document.createElement('div')
  el.id = 'subscriptionStatusModal'
  el.className = 'modal-overlay'
  el.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true" aria-labelledby="subscriptionStatusTitle" style="max-width:480px;">
      <div class="modal-header" style="display:flex;justify-content:space-between;align-items:center;gap:12px;">
        <h3 id="subscriptionStatusTitle" style="margin:0;">وضعیت اشتراک</h3>
        <button type="button" class="btn btn-sm" id="subscriptionStatusClose">بستن</button>
      </div>
      <div class="modal-body" id="subscriptionStatusBody" style="padding-top:12px;line-height:1.8;font-size:14px;"></div>
    </div>
  `
  document.body.appendChild(el)
  el.addEventListener('click', (e) => {
    if (e.target === el) closeSubscriptionStatusModal()
  })
  document.getElementById('subscriptionStatusClose')?.addEventListener('click', closeSubscriptionStatusModal)
}

export function closeSubscriptionStatusModal() {
  document.getElementById('subscriptionStatusModal')?.classList.remove('active')
}

export async function openSubscriptionStatusModal() {
  ensureSubscriptionModal()
  const modal = document.getElementById('subscriptionStatusModal')
  const body = document.getElementById('subscriptionStatusBody')
  if (!modal || !body) return
  body.textContent = 'در حال بارگذاری...'
  modal.classList.add('active')

  try {
    await loadEntitlements()
    applyEntitlementUI()
    const ent = getEntitlements()
    let remote = null
    try {
      remote = await fetchSubscriptionStatus()
    } catch (e) {
      console.warn('subscription_status', e)
    }

    const planId = remote?.subscription?.plan_id || ent?.planId || '—'
    const status = remote?.subscription?.status || ent?.rawStatus || '—'
    const orgName = remote?.tenant?.name || getCurrentUser()?.tenantName || 'سازمان فعلی'
    const features = remote?.plan?.features || ent?.features || {}
    const featureLines = Object.entries(features)
      .filter(([, v]) => v)
      .map(([k]) => k)
      .join(' · ') || '—'
    const currentSub = remote?.tenant?.subdomain || ''
    const rootDomain = await fetchRootDomain()
    const canSub = canUseFeature('custom_subdomain')
    const isOwnerish = remote?.member_role === 'owner' || isMainAdmin(getCurrentUser())

    body.innerHTML = `
      <p><strong>سازمان:</strong> ${escape(orgName)}</p>
      <p><strong>پلن:</strong> ${escape(PLAN_LABELS[planId] || planId)}</p>
      <p><strong>وضعیت:</strong> ${escape(STATUS_LABELS[status] || status)}</p>
      <p><strong>حالت دسترسی:</strong> ${escape(ent?.accessMode || '—')}</p>
      <p><strong>پایان آزمایشی:</strong> ${escape(formatDate(remote?.subscription?.trial_ends_at || ent?.trialEndsAt))}</p>
      <p><strong>پایان اعتبار:</strong> ${escape(formatDate(remote?.subscription?.ends_at || ent?.endsAt))}</p>
      <p><strong>نقش شما:</strong> ${escape(remote?.member_role || '—')}</p>
      <p><strong>قابلیت‌های پلن:</strong> ${escape(featureLines)}</p>
      <div id="subscriptionSubdomainBox" style="margin-top:16px;padding-top:12px;border-top:1px solid #e2e8f0;">
        <p style="margin:0 0 8px;"><strong>ساب‌دامین اختصاصی</strong> (فقط الماسی)</p>
        ${canSub && isOwnerish ? `
          <p style="font-size:12px;color:#64748b;margin:0 0 8px;">آدرس: <code>نام.${escape(rootDomain)}</code></p>
          <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;">
            <input type="text" id="subdomainInput" dir="ltr" placeholder="acme" value="${escape(currentSub)}" style="flex:1;min-width:120px;padding:8px 10px;border:1px solid #cbd5e1;border-radius:8px;font:inherit;">
            <button type="button" class="btn btn-primary btn-sm" id="subdomainSaveBtn">ذخیره</button>
            ${currentSub ? '<button type="button" class="btn btn-sm" id="subdomainClearBtn">حذف</button>' : ''}
          </div>
          <p id="subdomainMsg" style="display:none;font-size:12px;margin-top:8px;"></p>
        ` : `
          <p style="font-size:13px;color:#64748b;margin:0;">
            ${currentSub ? `فعلی: <code dir="ltr">${escape(currentSub)}.${escape(rootDomain)}</code>` : 'در پلن الماسی می‌توانید ساب‌دامین تنظیم کنید.'}
          </p>
        `}
      </div>
      <div style="margin-top:16px;display:grid;gap:8px;">
        <button type="button" class="btn btn-primary" data-checkout="gold" data-period="monthly">خرید طلایی (ماهانه)</button>
        <button type="button" class="btn btn-primary" data-checkout="diamond" data-period="monthly">خرید الماسی (ماهانه)</button>
        <button type="button" class="btn" data-checkout="gold" data-period="yearly">طلایی سالانه</button>
        <button type="button" class="btn" data-checkout="diamond" data-period="yearly">الماسی سالانه</button>
      </div>
      <div id="subscriptionPayments" style="margin-top:16px;text-align:right;font-size:12px;color:#64748b;"></div>
      <p id="subscriptionCheckoutError" style="display:none;color:#b91c1c;font-size:13px;margin-top:8px;"></p>
    `

    body.querySelectorAll('[data-checkout]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const err = document.getElementById('subscriptionCheckoutError')
        if (err) { err.style.display = 'none'; err.textContent = '' }
        btn.disabled = true
        try {
          await startCheckout(btn.getAttribute('data-checkout'), btn.getAttribute('data-period') || 'monthly')
        } catch (e) {
          if (err) {
            err.style.display = 'block'
            err.textContent = e.message || 'خطا در شروع پرداخت'
          } else {
            showToast(e.message || 'خطا در شروع پرداخت', 'error')
          }
          btn.disabled = false
        }
      })
    })

    const saveBtn = document.getElementById('subdomainSaveBtn')
    if (saveBtn) {
      saveBtn.addEventListener('click', async () => {
        const msg = document.getElementById('subdomainMsg')
        const raw = document.getElementById('subdomainInput')?.value || ''
        const v = validateSubdomainLabel(raw)
        if (!v.ok) {
          if (msg) {
            msg.style.display = 'block'
            msg.style.color = '#b91c1c'
            msg.textContent = v.error
          }
          return
        }
        saveBtn.disabled = true
        try {
          const tenantId = getStoredTenantId()
          await tenantOps('set_subdomain', { tenant_id: tenantId, subdomain: v.label })
          if (msg) {
            msg.style.display = 'block'
            msg.style.color = '#15803d'
            msg.textContent = `ذخیره شد: ${v.label}.${rootDomain}`
          }
          showToast('ساب‌دامین ذخیره شد')
        } catch (e) {
          if (msg) {
            msg.style.display = 'block'
            msg.style.color = '#b91c1c'
            msg.textContent = e.message || 'خطا'
          }
        } finally {
          saveBtn.disabled = false
        }
      })
    }
    document.getElementById('subdomainClearBtn')?.addEventListener('click', async () => {
      const msg = document.getElementById('subdomainMsg')
      try {
        await tenantOps('clear_subdomain', { tenant_id: getStoredTenantId() })
        const input = document.getElementById('subdomainInput')
        if (input) input.value = ''
        if (msg) {
          msg.style.display = 'block'
          msg.style.color = '#15803d'
          msg.textContent = 'ساب‌دامین حذف شد'
        }
        showToast('ساب‌دامین حذف شد')
      } catch (e) {
        if (msg) {
          msg.style.display = 'block'
          msg.style.color = '#b91c1c'
          msg.textContent = e.message || 'خطا'
        }
      }
    })

    try {
      const pay = await listMyPayments()
      const box = document.getElementById('subscriptionPayments')
      const rows = pay.payments || []
      if (box) {
        box.innerHTML = rows.length
          ? `<strong>پرداخت‌های اخیر</strong><ul style="margin:8px 0 0;padding-right:18px;">${rows.slice(0, 5).map((p) =>
            `<li>${escape(p.plan_id)} / ${escape(p.period)} — ${Number(p.amount_irr || 0).toLocaleString('fa-IR')} ریال — ${escape(p.status)}${p.ref_id ? ` — ${escape(p.ref_id)}` : ''}</li>`
          ).join('')}</ul>`
          : 'هنوز پرداختی ثبت نشده.'
      }
    } catch (_) { /* ignore */ }
  } catch (e) {
    body.textContent = e.message || 'خطا در دریافت وضعیت اشتراک'
  }
}

function escape(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** Show profile item for tenant owners / main admins. */
export function syncSubscriptionMenuVisibility() {
  const item = document.getElementById('subscriptionStatusMenuItem')
  if (!item) return
  const user = getCurrentUser()
  const show = !!(user && (isMainAdmin(user) || user.role === 'admin'))
  item.style.display = show ? '' : 'none'
}
