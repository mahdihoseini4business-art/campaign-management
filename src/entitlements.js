/**
 * Phase 2: plan entitlements + access modes (trial / grace / readonly + paywall).
 * Source of truth: subscriptions + plans (+ platform_settings for grace_days).
 */
import { supabase } from './supabase.js'
import { getStoredTenantId } from './tenant.js'
import { DIAMOND_ONLY_FEATURES, PLATFORM_SETTING_DEFAULTS, PLAN_IDS } from './platform/defaults.js'
import { showToast } from './utils.js'

const FEATURE_LABELS = {
  dm_chat: 'چت داخلی',
  products_matrix: 'ماتریس محصولات',
  refunds: 'عودت وجه',
  shipments: 'ارسالی‌ها',
  custom_subdomain: 'ساب‌دامین اختصاصی',
  import_export: 'ایمپورت / اکسپورت'
}

const PLAN_FEATURE_FALLBACK = {
  [PLAN_IDS.trial]: {
    dm_chat: true,
    products_matrix: true,
    refunds: true,
    shipments: true,
    custom_subdomain: false
  },
  [PLAN_IDS.gold]: {
    dm_chat: false,
    products_matrix: false,
    refunds: false,
    shipments: false,
    custom_subdomain: false
  },
  [PLAN_IDS.diamond]: {
    dm_chat: true,
    products_matrix: true,
    refunds: true,
    shipments: true,
    custom_subdomain: true
  }
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

function defaultFeatures(planId) {
  return { ...(PLAN_FEATURE_FALLBACK[planId] || PLAN_FEATURE_FALLBACK[PLAN_IDS.gold]) }
}

function mergeFeatures(planId, fromDb) {
  const base = defaultFeatures(planId)
  if (fromDb && typeof fromDb === 'object' && !Array.isArray(fromDb)) {
    for (const k of Object.keys(base)) {
      if (typeof fromDb[k] === 'boolean') base[k] = fromDb[k]
    }
  }
  return base
}

/**
 * Compute effective access from subscription row + grace_days.
 */
export function computeAccessState(sub, graceDays = PLATFORM_SETTING_DEFAULTS.grace_days) {
  const now = Date.now()
  const gDays = Number.isFinite(Number(graceDays)) ? Number(graceDays) : PLATFORM_SETTING_DEFAULTS.grace_days

  if (!sub) {
    return {
      accessMode: 'readonly',
      paywall: true,
      blockImportExport: true,
      reason: 'no_subscription',
      planId: PLAN_IDS.gold,
      rawStatus: 'missing'
    }
  }

  const planId = sub.plan_id || PLAN_IDS.gold
  const rawStatus = sub.status || 'active'
  const trialEnds = sub.trial_ends_at ? new Date(sub.trial_ends_at).getTime() : null
  const endsAt = sub.ends_at ? new Date(sub.ends_at).getTime() : null

  if (rawStatus === 'suspended') {
    return {
      accessMode: 'readonly',
      paywall: true,
      blockImportExport: true,
      reason: 'suspended',
      planId,
      rawStatus
    }
  }

  if (rawStatus === 'readonly') {
    return {
      accessMode: 'readonly',
      paywall: true,
      blockImportExport: true,
      reason: 'readonly',
      planId,
      rawStatus
    }
  }

  // Trial ended → readonly + paywall (per product decision)
  if (rawStatus === 'trialing' && trialEnds && trialEnds < now) {
    return {
      accessMode: 'readonly',
      paywall: true,
      blockImportExport: true,
      reason: 'trial_ended',
      planId,
      rawStatus
    }
  }

  if (rawStatus === 'trialing') {
    return {
      accessMode: 'writable',
      paywall: false,
      blockImportExport: false,
      reason: 'trialing',
      planId,
      rawStatus
    }
  }

  // Paid expired → grace then readonly
  if ((rawStatus === 'active' || rawStatus === 'grace') && endsAt && endsAt < now) {
    const graceEnd = endsAt + gDays * 86400000
    if (now < graceEnd || rawStatus === 'grace') {
      if (now < graceEnd) {
        return {
          accessMode: 'grace',
          paywall: false,
          blockImportExport: false,
          reason: 'grace',
          planId,
          rawStatus: 'grace'
        }
      }
    }
    return {
      accessMode: 'readonly',
      paywall: true,
      blockImportExport: true,
      reason: 'expired',
      planId,
      rawStatus
    }
  }

  if (rawStatus === 'grace') {
    return {
      accessMode: 'grace',
      paywall: false,
      blockImportExport: false,
      reason: 'grace',
      planId,
      rawStatus
    }
  }

  return {
    accessMode: 'writable',
    paywall: false,
    blockImportExport: false,
    reason: 'active',
    planId,
    rawStatus
  }
}

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
  if (!state?.loaded) return true
  return state.accessMode === 'writable' || state.accessMode === 'grace'
}

export function shouldShowPaywall() {
  return !!(state?.loaded && state.paywall)
}

export function assertFeature(featureKey, { silent = false } = {}) {
  if (canUseFeature(featureKey)) return true
  if (!silent) {
    const label = FEATURE_LABELS[featureKey] || featureKey
    showToast(`قابلیت «${label}» در پلن فعلی شما فعال نیست. برای دسترسی پلن الماسی لازم است.`, 'error')
  }
  return false
}

export function assertWritable({ silent = false } = {}) {
  if (canWriteData()) return true
  if (!silent) {
    showToast('اشتراک شما فقط‌خواندنی است. برای ادامه کار اشتراک را تمدید یا خریداری کنید.', 'error')
    showPaywallModal()
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
    /* platform_settings may be unreadable for non-platform users — use default */
  }

  let sub = null
  let planFeatures = null
  if (tenantId) {
    const { data: subRow, error } = await supabase
      .from('subscriptions')
      .select('tenant_id, plan_id, status, trial_ends_at, ends_at, starts_at')
      .eq('tenant_id', tenantId)
      .maybeSingle()
    if (!error) sub = subRow

    if (sub?.plan_id) {
      const { data: plan } = await supabase
        .from('plans')
        .select('id, features')
        .eq('id', sub.plan_id)
        .maybeSingle()
      planFeatures = plan?.features
    }
  }

  const access = computeAccessState(sub, graceDays)
  const features = mergeFeatures(access.planId, planFeatures)

  // Expired trial on diamond-feature plan still had features in DB; keep feature flags
  // but accessMode readonly already blocks writes / import-export.

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

function paywallMessage() {
  if (!state) return 'برای ادامه، اشتراک تهیه کنید.'
  if (state.reason === 'trial_ended') {
    return 'اشتراک آزمایشی رایگان شما به پایان رسیده است. سیستم فقط‌خواندنی است و ایمپورت/اکسپورت غیرفعال شده. برای ادامه یکی از پلن‌های طلایی یا الماسی را تهیه کنید.'
  }
  if (state.reason === 'expired' || state.reason === 'readonly') {
    return 'اشتراک سازمان منقضی شده و دسترسی فقط‌خواندنی است. برای بازگشایی امکانات، اشتراک را تمدید کنید.'
  }
  if (state.reason === 'suspended') {
    return 'سازمان شما تعلیق شده است. با پشتیبانی تماس بگیرید.'
  }
  return 'برای ادامه کار به اشتراک فعال نیاز دارید.'
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
        <button type="button" class="btn btn-primary" id="entitlementPaywallDismiss">مشاهده فقط‌خواندنی</button>
      </div>
      <p class="entitlement-paywall-hint">خرید آنلاین در فاز بعد (زرین‌پال) فعال می‌شود. فعلاً از طریق پشتیبانی / سوپرادمین فعال‌سازی کنید.</p>
    </div>
  `
  document.body.appendChild(wrap)
  document.getElementById('entitlementPaywallDismiss')?.addEventListener('click', () => {
    wrap.hidden = true
  })

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
      }
      .entitlement-banner[data-tone="danger"] { background: #991b1b; }
      .entitlement-paywall {
        position: fixed; inset: 0; z-index: 10050;
        background: rgba(15, 23, 42, 0.55);
        display: flex; align-items: center; justify-content: center;
        padding: 24px;
      }
      .entitlement-paywall[hidden] { display: none !important; }
      .entitlement-paywall-card {
        background: #fff; border-radius: 16px; max-width: 420px; width: 100%;
        padding: 24px; box-shadow: 0 16px 48px rgba(0,0,0,.2);
        font-family: Vazirmatn, Tahoma, sans-serif;
      }
      .entitlement-paywall-card h2 { margin: 0 0 10px; font-size: 1.15rem; }
      .entitlement-paywall-card p { margin: 0 0 12px; color: #475569; line-height: 1.7; font-size: 0.92rem; }
      .entitlement-paywall-hint { font-size: 0.8rem !important; color: #94a3b8 !important; }
      .entitlement-paywall-actions { display: flex; gap: 8px; margin-bottom: 8px; }
      body.entitlement-readonly [data-entitlement-write] { opacity: 0.45; pointer-events: none !important; }
    `
    document.head.appendChild(style)
  }
}

export function showPaywallModal() {
  ensurePaywallDom()
  const el = document.getElementById('entitlementPaywall')
  const body = document.getElementById('entitlementPaywallBody')
  if (body) body.textContent = paywallMessage()
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
      banner.hidden = false
      banner.dataset.tone = 'warn'
      banner.textContent = 'مهلت تمدید اشتراک (grace) فعال است. پس از پایان مهلت، سیستم فقط‌خواندنی می‌شود.'
    } else if (state.accessMode === 'readonly') {
      banner.hidden = false
      banner.dataset.tone = 'danger'
      banner.textContent = state.reason === 'trial_ended'
        ? 'آزمایشی تمام شده — فقط‌خواندنی · ایمپورت/اکسپورت غیرفعال'
        : 'اشتراک منقضی — حالت فقط‌خواندنی'
    } else {
      banner.hidden = true
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
