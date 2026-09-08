/**
 * Phase 3: org subscription status UI + tenant-api helpers
 */
import { supabase } from './supabase.js'
import { getStoredTenantId } from './tenant.js'
import { getEntitlements, loadEntitlements, applyEntitlementUI } from './entitlements.js'
import { getCurrentUser, isMainAdmin, showToast } from './utils.js'
import { PLAN_IDS } from './platform/defaults.js'

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
    <div class="modal" role="dialog" aria-modal="true" aria-labelledby="subscriptionStatusTitle" style="max-width:440px;">
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

    body.innerHTML = `
      <p><strong>سازمان:</strong> ${escape(orgName)}</p>
      <p><strong>پلن:</strong> ${escape(PLAN_LABELS[planId] || planId)}</p>
      <p><strong>وضعیت:</strong> ${escape(STATUS_LABELS[status] || status)}</p>
      <p><strong>حالت دسترسی:</strong> ${escape(ent?.accessMode || '—')}</p>
      <p><strong>پایان آزمایشی:</strong> ${escape(formatDate(remote?.subscription?.trial_ends_at || ent?.trialEndsAt))}</p>
      <p><strong>پایان اعتبار:</strong> ${escape(formatDate(remote?.subscription?.ends_at || ent?.endsAt))}</p>
      <p><strong>نقش شما:</strong> ${escape(remote?.member_role || '—')}</p>
      <p><strong>قابلیت‌های پلن:</strong> ${escape(featureLines)}</p>
      <p style="color:var(--text-muted);font-size:12px;margin-top:12px;">خرید آنلاین در فاز زرین‌پال اضافه می‌شود. فعال‌سازی دستی از پشتیبانی / سوپرادمین.</p>
    `
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
