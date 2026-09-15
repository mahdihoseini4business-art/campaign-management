# چک‌لیست Go-Live — CARNO SaaS

بعد از پیاده‌سازی فاز ۰–۵، این فهرست را **قبل از فروش عمومی** کامل کنید. اجرا به دیپلوی وابسته است؛ خود سند و تست‌های واحد بدون دیپلوی قابل استفاده‌اند.

## ۱) Supabase — migrations

به ترتیب روی پروژه پروداکشن / staging:

- [ ] `031_tenancy_foundation.sql`
- [ ] `032_platform_settings_read.sql`
- [ ] `033_org_registration_log.sql`
- [ ] `034_billing_payments.sql`
- [ ] `035_subdomain_audit.sql`
- [ ] `036_rls_tenant_query_perf.sql` (ایندکس + RLS برای جلوگیری از timeout لود مشتریان/پیگیری‌ها)
- [ ] `037_users_tenant_rls_fix.sql` (**حیاتی** — جلوگیری از نشت لیست کاربران بین سازمان‌ها)
- [ ] `038_tenant_scoped_group_dm_uniques.sql`
- [ ] `039_write_audit_log_membership.sql`
- [ ] `040_notification_digest_meta.sql` (kind/meta برای خلاصه صبح/عصر)

بعد از apply: `NOTIFY pgrst, 'reload schema'` (معمولاً داخل migration هست).

Rollback: migrationها عمدتاً additive هستند؛ rollback کامل دستی است (حذف RLS/جداول خطرناک است). قبل از پروداکشن روی staging تست کنید و snapshot DB بگیرید.

## ۲) Edge Functions

دیپلوی با `verify_jwt` مطابق `supabase/config.toml`:

| Function | نقش |
|----------|-----|
| `send-otp` | ارسال OTP |
| `verify-otp` | تأیید + JWT + ثبت‌نام سازمان |
| `platform-api` | سوپرادمین |
| `tenant-api` | دعوت / وضعیت اشتراک |
| `tenant-ops` | ساب‌دامین / آرشیو / audit |
| `create-payment` | شروع زرین‌پال |
| `zarinpal-callback` | verify + فعال‌سازی |
| `subscription-cron` | trial→readonly، active→grace→readonly |
| `ops-digest-cron` | خلاصه صبح مشاور / عصر مدیر گروه → صندوق اعلان |

Smoke بعد از دیپلوی:

```bash
npm run smoke:saas
```

(نیاز به `SUPABASE_URL` و `SUPABASE_ANON_KEY` در env؛ اختیاری `CRON_SECRET`، `SMOKE_APP_URL`)

## ۳) Secrets (فقط Edge / dashboard — نه `VITE_*`)

- [ ] `SMS_USERNAME` / `SMS_PASSWORD` / `SMS_SENDER` (+ اختیاری `SMS_API_URL` / `SMS_MESSAGE_TEMPLATE`)
- [ ] `PLATFORM_ADMIN_PHONES` (کاما جدا، فرمت `09xxxxxxxxx`)
- [ ] `ZARINPAL_MERCHANT_ID`
- [ ] `ZARINPAL_SANDBOX=true` تا زمان go-live واقعی، بعد `false`
- [ ] `PUBLIC_APP_URL` (بدون اسلش انتهایی؛ همان دامنه Liara/اپ)
- [ ] `CRON_SECRET`
- [ ] `SUPABASE_SERVICE_ROLE_KEY` (معمولاً خودکار برای Functions)

## ۴) Liara / فرانت

- [ ] Build با `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` / `VITE_HASH_SECRET` / `VITE_ADMIN_PHONE` / `VITE_ROOT_DOMAIN`
- [ ] اختیاری واکی‌تاکی: `VITE_TURN_URLS` / `VITE_TURN_USERNAME` / `VITE_TURN_CREDENTIAL`
- [ ] migrations `041_dm_voice_realtime_auth` + `042_dm_voice_ring_auth` + `043_dm_voice_ring_select_fix` (ring inbox؛ 043 برای JOIN فرستنده روی topic گیرنده لازم است)
- [ ] بعد از آن‌ها: Realtime → Settings → غیرفعال کردن Allow public access (سیاست‌های known topics در migration پوشش می‌دهند)
- [ ] `liara_nginx.conf` برای `/platform`، `/signup`، `/payment-result`
- [ ] DNS apex + در صورت الماس: wildcard `*.carno.ir` + TLS

## ۵) Cron

نمونه روزانه — اشتراک:

```bash
curl -X POST -H "x-cron-secret: $CRON_SECRET" \
  "https://<project-ref>.supabase.co/functions/v1/subscription-cron"
```

خلاصه عملیاتی (به وقت تهران؛ دو بار در روز):

```bash
# صبح ~۰۸:۰۰ IRST — خلاصه مشاور
curl -X POST -H "x-cron-secret: $CRON_SECRET" \
  "https://<project-ref>.supabase.co/functions/v1/ops-digest-cron?kind=morning"

# عصر ~۱۸:۰۰ IRST — خلاصه مدیر گروه
curl -X POST -H "x-cron-secret: $CRON_SECRET" \
  "https://<project-ref>.supabase.co/functions/v1/ops-digest-cron?kind=evening"
```

**توجه:** بدون این زمان‌بندی، Edge Function خودش اجرا نمی‌شود. از نسخهٔ فعلی، با **باز کردن اپ** هم خلاصه صبح (و بعد از ۱۶:۰۰ تهران خلاصه عصر برای مدیر گروه) در صورت وجود کار باز ساخته می‌شود تا وابستگی صرف به cron کمتر شود. برای کاربران آفلاین هنوز cron لازم است.

پیش‌نیاز: migration `040_notification_digest_meta.sql` + دیپلوی `ops-digest-cron`. اگر پاسخ `migration_040_required` بود، ابتدا migration را apply کنید.

- [ ] زمان‌بندی `subscription-cron` در Supabase Cron / سرویس خارجی ثبت شد
- [ ] زمان‌بندی `ops-digest-cron` صبح و عصر (Tehran) ثبت شد
- [ ] یک بار دستی هر دو kind اجرا و پاسخ JSON (`sent` / `skipped_*`) بررسی شد
- [ ] migration `040` روی پروداکشن apply شده

## ۶) بکاپ و بازیابی عملیاتی

- [ ] Snapshot دیتابیس قبل از migration پروداکشن
- [ ] تست بکاپ کامل از یک tenant trial/gold
- [ ] تأیید که در readonly، restore بلاک می‌شود
- [ ] شماره/کانال پشتیبانی برای پرداخت‌های ناموفق مشخص است

## ۷) سوپرادمین

- [ ] ورود `/platform` فقط با شماره allowlist
- [ ] شماره خارج از allowlist رد می‌شود
- [ ] ساخت tenant دستی + تغییر پلن + پرداخت دستی کار می‌کند
- [ ] `root_domain` و سقف SMS در تنظیمات ذخیره می‌شود

## ۸) معیار پذیرش فروش

حداقل این‌ها سبز باشند (جزئیات در [`e2e-saas-scenarios.md`](e2e-saas-scenarios.md)):

- [ ] نشت cross-tenant دیده نمی‌شود
- [ ] Trial پایان → readonly + paywall + قطع import/export
- [ ] پرداخت sandbox موفق → active
- [ ] پرداخت لغو/ناموفق → اشتراک عوض نمی‌شود
- [ ] الماس: ساب‌دامین resolve؛ طلایی: feature قفل

## ۹) تست‌های واحد (بدون دیپلوی)

```bash
npm run test:entitlements
npm run test:subdomain
npm run test:merge
```
