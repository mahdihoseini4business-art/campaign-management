# چک‌لیست Go-Live — CARNO SaaS

بعد از پیاده‌سازی فاز ۰–۵، این فهرست را **قبل از فروش عمومی** کامل کنید. اجرا به دیپلوی وابسته است؛ خود سند و تست‌های واحد بدون دیپلوی قابل استفاده‌اند.

## ۱) Supabase — migrations

به ترتیب روی پروژه پروداکشن / staging:

- [ ] `031_tenancy_foundation.sql`
- [ ] `032_platform_settings_read.sql`
- [ ] `033_org_registration_log.sql`
- [ ] `034_billing_payments.sql`
- [ ] `035_subdomain_audit.sql`

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
- [ ] `liara_nginx.conf` برای `/platform`، `/signup`، `/payment-result`
- [ ] DNS apex + در صورت الماس: wildcard `*.carno.ir` + TLS

## ۵) Cron

نمونه روزانه:

```bash
curl -X POST -H "x-cron-secret: $CRON_SECRET" \
  "https://<project-ref>.supabase.co/functions/v1/subscription-cron"
```

- [ ] زمان‌بندی در Supabase Cron / سرویس خارجی ثبت شد
- [ ] یک بار دستی اجرا و پاسخ JSON بررسی شد

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
