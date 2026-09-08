import { attemptPlatformLogin, isPlatformAccessGranted } from './gate.js'
import { PLATFORM_SETTING_DEFAULTS, DIAMOND_ONLY_FEATURES, PLAN_IDS } from './defaults.js'

function $(id) {
  return document.getElementById(id)
}

function showGate() {
  $('platformGate')?.removeAttribute('hidden')
  $('platformShell')?.setAttribute('hidden', '')
}

function showShell() {
  $('platformGate')?.setAttribute('hidden', '')
  $('platformShell')?.removeAttribute('hidden')
}

function setStatus(message, isError = true) {
  const el = $('platformGateStatus')
  if (!el) return
  el.textContent = message || ''
  el.hidden = !message
  el.dataset.tone = isError ? 'error' : 'info'
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
    `<li>فقط الماس (و Trial موقت): ${DIAMOND_ONLY_FEATURES.join(', ')}</li>`
  ].join('')
}

async function onSubmit(event) {
  event.preventDefault()
  const phone = $('platformPhone')?.value || ''
  const otp = $('platformOtp')?.value || ''
  const btn = $('platformLoginBtn')
  if (btn) btn.disabled = true
  setStatus('')
  try {
    const result = await attemptPlatformLogin(phone, otp)
    if (!result.ok) {
      setStatus(result.message || 'دسترسی رد شد.')
      return
    }
    showShell()
  } finally {
    if (btn) btn.disabled = false
  }
}

function boot() {
  renderDefaultsSummary()
  $('platformLoginForm')?.addEventListener('submit', onSubmit)

  if (isPlatformAccessGranted()) {
    showShell()
  } else {
    showGate()
    setStatus(
      'گیت فاز ۰ فعال است: ورود واقعی پس از اتصال allowlist سرور در فاز ۱ انجام می‌شود.',
      false
    )
  }
}

boot()
