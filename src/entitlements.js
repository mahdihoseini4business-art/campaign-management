/**
 * Phase 2+6: plan entitlements + access modes (trial / grace / readonly + paywall).
 * Source of truth: subscriptions + plans (+ platform_settings for grace_days).
 */
import { supabase } from './supabase.js'
import { getStoredTenantId } from './tenant.js'
import { DIAMOND_ONLY_FEATURES, PLATFORM_SETTING_DEFAULTS } from './platform/defaults.js'
import { showToast } from './utils.js'
import {
  computeAccessState,
  mergeFeatures,
  paywallCopy,
  graceDaysRemaining
} from './entitlements-core.js'

export { computeAccessState } from './entitlements-core.js'

const FEATURE_LABELS = {
  dm_chat: 'چت داخلی',
  products_matrix: 'ماتریس محصولات',
  refunds: 'عودت وجه',
  shipments: 'ارسالی‌ها',
  custom_subdomain: 'ساب‌دامین اختصاصی',
  import_export: 'ایمپورت / اکسپورت'
}

/** @type {null | {
 *   loaded: boolean,
 *   tenantId: string | null,
 *   planId: string,
 *   rawStatus: string,
 *   accessMode: 'writable' | 'grace' | 'readonly',
 *   paywall: boolean,
 *   blockImportExport: boolean,
 *   reason: string,
 *   features: Record<string, boolean>,
 *   trialEndsAt: string | null,
 *   endsAt: string | null,
 *   graceDays: number
 * }} */
let state = null

export function getEntitlements() {
  return state
}

export function canUseFeature(featureKey) {
  if (!state?.loaded) return true // fail-open until loaded (avoids flash-lock before boot)
  if (featureKey === 'import_export') {
    return !state.blockImportExport && state.accessMode !== 'readonly'
  }
  if (DIAMOND_ONLY_FEATURES.includes(featureKey) || featureKey in (state.features || {})) {
    return !!state.features?.[featureKey]
  }
  return true
}

export function canWriteData() {
  return !state?.loaded || state.accessMode === 'writable' || state.accessMode === 'grace'
}

export function shouldShowPaywall() {
  return !!(state?.loaded && state.paywall)
}

function paywallDismissKey() {
  const tid = state?.tenantId || getStoredTenantId() || 'x'
  return `carno_paywall_dismissed:${tid}:${state?.reason || 'paywall'}`
}

function isPaywallDismissed() {
  try {
    return sessionStorage.getItem(paywallDismissKey()) === '1'
  } catch {
    return false
  }
}

function markPaywallDismissed() {
  try {
    sessionStorage.setItem(paywallDismissKey(), '1')
  } catch {
    /* ignore */
  }
}

export function assertFeature(featureKey, { silent = false } = {}) {
  if (canUseFeature(featureKey)) return true
  if (!silent) {
    const label = FEATURE_LABELS[featureKey] || featureKey
    showToast(`قابلیت «${label}» در پلن فعلی شما فعال نیست. برای دسترسی پلن الماسی لازم است.`, 'error')
    if (shouldShowPaywall()) showPaywallModal()
  }
  return false
}

export function assertWritable({ silent = false } = {}) {
  if (canWriteData()) return true
  if (!silent) {
    showToast('اشتراک شما فقط‌خواندنی است. برای ادامه کار اشتراک را تمدید یا خریداری کنید.', 'error')
    if (shouldShowPaywall()) showPaywallModal()
  }
  return false
}

export function assertImportExport({ silent = false } = {}) {
  if (canUseFeature('import_export')) return true
  if (!silent) {
    showToast('ایمپورت و اکسپورت در وضعیت فعلی اشتراک غیرفعال است.', 'error')
    if (shouldShowPaywall()) showPaywallModal()
  }
  return false
}

export function clearEntitlementsState() {
  state = null
}

export async function loadEntitlements() {
  const tenantId = getStoredTenantId()
  let graceDays = PLATFORM_SETTING_DEFAULTS.grace_days
  try {
    const { data: graceRow } = await supabase
      .from('platform_settings')
      .select('value')
      .eq('key', 'grace_days')
      .maybeSingle()
    if (graceRow?.value != null) graceDays = Number(graceRow.value) || graceDays
  } catch {
    /* keep default */
  }

  let sub = null
  let planFeatures = null
  if (tenantId) {
    const { data } = await supabase
      .from('subscriptions')
      .select('tenant_id, plan_id, status, trial_ends_at, ends_at, starts_at')
      .eq('tenant_id', tenantId)
      .maybeSingle()
    sub = data
    if (sub?.plan_id) {
      const { data: plan } = await supabase
        .from('plans')
        .select('features')
        .eq('id', sub.plan_id)
        .maybeSingle()
      planFeatures = plan?.features || null
    }
  }

  const access = computeAccessState(sub, graceDays)
  // Expired trial on diamond-feature plan still had features in DB; keep feature flags
  // but accessMode readonly already blocks writes / import-export.
  const features = mergeFeatures(access.planId, planFeatures)

  state = {
    loaded: true,
    tenantId,
    planId: access.planId,
    rawStatus: access.rawStatus,
    accessMode: access.accessMode,
    paywall: access.paywall,
    blockImportExport: access.blockImportExport,
    reason: access.reason,
    features,
    trialEndsAt: sub?.trial_ends_at || null,
    endsAt: sub?.ends_at || null,
    graceDays
  }
  return state
}

export function ensurePaywallDom() {
  if (document.getElementById('entitlementPaywall')) return
  const wrap = document.createElement('div')
  wrap.id = 'entitlementPaywall'
  wrap.className = 'entitlement-paywall'
  wrap.hidden = true
  wrap.innerHTML = `
    <div class="entitlement-paywall-card" role="dialog" aria-modal="true" aria-labelledby="entitlementPaywallTitle">
      <h2 id="entitlementPaywallTitle">اشتراک به پایان رسیده</h2>
      <p id="entitlementPaywallBody"></p>
      <div class="entitlement-paywall-actions">
        <button type="button" class="btn btn-primary" id="entitlementPaywallBuyGold">خرید طلایی (ماهانه)</button>
        <button type="button" class="btn btn-primary" id="entitlementPaywallBuyDiamond">خرید الماسی (ماهانه)</button>
        <button type="button" class="btn" id="entitlementPaywallOpenStatus">جزئیات اشتراک</button>
        <button type="button" class="btn btn-sm" id="entitlementPaywallDismiss">ادامه فقط‌خواندنی</button>
      </div>
      <p class="entitlement-paywall-hint">پرداخت امن از طریق زرین‌پال. گزینه‌های سالانه و وضعیت کامل در «جزئیات اشتراک» است. فعال‌سازی دستی از سوپرادمین هم ممکن است.</p>
    </div>
  `
  document.body.appendChild(wrap)
  document.getElementById('entitlementPaywallDismiss')?.addEventListener('click', () => {
    markPaywallDismissed()
    wrap.hidden = true
  })
  document.getElementById('entitlementPaywallOpenStatus')?.addEventListener('click', async () => {
    wrap.hidden = true
    try {
      const { openSubscriptionStatusModal } = await import('./onboarding.js')
      await openSubscriptionStatusModal()
    } catch (e) {
      showToast(e.message || 'خطا در باز کردن وضعیت اشتراک', 'error')
    }
  })
  const buy = async (planId) => {
    const btnGold = document.getElementById('entitlementPaywallBuyGold')
    const btnDiamond = document.getElementById('entitlementPaywallBuyDiamond')
    if (btnGold) btnGold.disabled = true
    if (btnDiamond) btnDiamond.disabled = true
    try {
      const { startCheckout } = await import('./onboarding.js')
      await startCheckout(planId, 'monthly')
    } catch (e) {
      showToast(e.message || 'خطا در شروع پرداخت', 'error')
      if (btnGold) btnGold.disabled = false
      if (btnDiamond) btnDiamond.disabled = false
    }
  }
  document.getElementById('entitlementPaywallBuyGold')?.addEventListener('click', () => buy('gold'))
  document.getElementById('entitlementPaywallBuyDiamond')?.addEventListener('click', () => buy('diamond'))

  if (!document.getElementById('entitlementBanner')) {
    const banner = document.createElement('div')
    banner.id = 'entitlementBanner'
    banner.className = 'entitlement-banner'
    banner.hidden = true
    banner.setAttribute('role', 'status')
    document.body.prepend(banner)
  }

  if (!document.getElementById('entitlementStyles')) {
    const style = document.createElement('style')
    style.id = 'entitlementStyles'
    style.textContent = `
      .entitlement-banner {
        position: sticky; top: 0; z-index: 9000;
        background: #92400e; color: #fff;
        padding: 10px 16px; text-align: center; font-size: 13px;
        display: flex; flex-wrap: wrap; gap: 8px; align-items: center; justify-content: center;
      }
      .entitlement-banner[hidden] { display: none !important; }
      .entitlement-banner[data-tone="danger"] { background: #991b1b; }
      .entitlement-banner button {
        font: inherit; cursor: pointer; border: 1px solid rgba(255,255,255,.45);
        background: transparent; color: #fff; border-radius: 8px; padding: 4px 10px; font-size: 12px;
      }
      .entitlement-paywall {
        position: fixed; inset: 0; z-index: 10050;
        background: rgba(15, 23, 42, 0.55);
        display: flex; align-items: center; justify-content: center;
        padding: 24px;
      }
      .entitlement-paywall[hidden] { display: none !important; }
      .entitlement-paywall-card {
        background: #fff; border-radius: 16px; max-width: 460px; width: 100%;
        padding: 24px; box-shadow: 0 16px 48px rgba(0,0,0,.2);
        font-family: Vazirmatn, sans-serif;
      }
      .entitlement-paywall-card h2 { margin: 0 0 10px; font-size: 1.15rem; }
      .entitlement-paywall-card p { margin: 0 0 12px; color: #475569; line-height: 1.7; font-size: 0.92rem; }
      .entitlement-paywall-hint { font-size: 0.8rem !important; color: #94a3b8 !important; }
      .entitlement-paywall-actions {
        display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 8px;
      }
      .entitlement-paywall-actions .btn { flex: 1 1 140px; }
      body.entitlement-readonly [data-entitlement-write] { opacity: 0.45; pointer-events: none !important; }
    `
    document.head.appendChild(style)
  }
}

export function showPaywallModal() {
  if (isPaywallDismissed()) return
  ensurePaywallDom()
  const el = document.getElementById('entitlementPaywall')
  const title = document.getElementById('entitlementPaywallTitle')
  const body = document.getElementById('entitlementPaywallBody')
  const copy = paywallCopy(state?.reason)
  if (title) title.textContent = copy.title
  if (body) body.textContent = copy.body
  if (el) el.hidden = false
}

export function applyEntitlementUI() {
  ensurePaywallDom()
  if (!state?.loaded) return

  document.body.classList.toggle('entitlement-readonly', state.accessMode === 'readonly')
  document.body.classList.toggle('entitlement-grace', state.accessMode === 'grace')

  const banner = document.getElementById('entitlementBanner')
  if (banner) {
    if (state.accessMode === 'grace') {
      const left = graceDaysRemaining(state.endsAt, state.graceDays)
      banner.hidden = false
      banner.dataset.tone = 'warn'
      banner.innerHTML = `
        <span>مهلت تمدید اشتراک فعال است${left ? ` — حدود ${left.toLocaleString('fa-IR')} روز باقی‌مانده` : ''}. پس از پایان مهلت، سیستم فقط‌خواندنی می‌شود.</span>
        <button type="button" id="entitlementBannerUpgrade">تمدید / خرید</button>
      `
      document.getElementById('entitlementBannerUpgrade')?.addEventListener('click', async () => {
        try {
          const { openSubscriptionStatusModal } = await import('./onboarding.js')
          await openSubscriptionStatusModal()
        } catch (e) {
          showToast(e.message || 'خطا', 'error')
        }
      })
    } else if (state.accessMode === 'readonly') {
      banner.hidden = false
      banner.dataset.tone = 'danger'
      const msg = state.reason === 'trial_ended'
        ? 'آزمایشی تمام شده — فقط‌خواندنی · ایمپورت/اکسپورت غیرفعال'
        : state.reason === 'suspended'
          ? 'سازمان تعلیق شده — دسترسی محدود'
          : 'اشتراک منقضی — حالت فقط‌خواندنی'
      banner.innerHTML = `
        <span>${msg}</span>
        <button type="button" id="entitlementBannerUpgrade">خرید اشتراک</button>
      `
      document.getElementById('entitlementBannerUpgrade')?.addEventListener('click', () => showPaywallModal())
    } else {
      banner.hidden = true
      banner.innerHTML = ''
    }
  }

  // Feature tabs
  const featureTabMap = {
    products: 'products_matrix',
    refunds: 'refunds',
    shipments: 'shipments'
  }
  for (const [tab, feature] of Object.entries(featureTabMap)) {
    const btn = document.getElementById(`tab-${tab}`)
    if (!btn) continue
    const allowed = canUseFeature(feature)
    if (!allowed) btn.style.display = 'none'
  }

  // DM chat launcher
  document.querySelectorAll('[data-entitlement-feature="dm_chat"]').forEach((el) => {
    el.style.display = canUseFeature('dm_chat') ? '' : 'none'
  })

  // Import/export controls
  document.querySelectorAll(
    '[data-perm="customers_export"],[data-perm="customers_import"],[data-perm="followups_export"],[data-perm="sales_export"],[data-perm="sales_import"],[data-perm="matrix_historical_import"]'
  ).forEach((el) => {
    if (!canUseFeature('import_export')) el.style.display = 'none'
  })

  // Mark primary write buttons if they lack the attribute
  document.querySelectorAll(
    '[data-perm="customers_add"],[data-perm="followups_add"],[data-perm="refunds_request"],[data-perm="shipments_manage"]'
  ).forEach((el) => {
    el.setAttribute('data-entitlement-write', '1')
  })

  if (shouldShowPaywall()) showPaywallModal()
}

/** Hide feature if plan disallows — call after applyPermissions. */
export function applyFeaturePermissionsOverlay() {
  applyEntitlementUI()
}
