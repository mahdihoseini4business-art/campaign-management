# ADR 001 — امنیت و چندمستأجری SaaS

**وضعیت:** پذیرفته‌شده (فاز ۰)  
**تاریخ:** 2026-09-08

## زمینه

CARNO امروز تک‌مستأجر است: OTP سفارشی، session با HMAC در `localStorage`، و RLS باز روی کلید anon. برای فروش اشتراکی چندسازمانی این مدل امن نیست.

## تصمیم‌ها

### ۱) ریپو و مسیر سوپرادمین

- همان ریپو باقی می‌ماند.
- پنل پلتفرم روی مسیر **`/platform`** با entry جدا: `platform.html` + `src/platform/`.
- اپ مشتری همان `index.html` / `login.html` / `src/` است.

### ۲) نقش‌ها

| نقش | محدوده | مسئولیت |
|-----|--------|---------|
| **platform super-admin** | کل پلتفرم | tenantها، پلن‌ها، SMS/روز، grace، فعال‌سازی دستی، نظارت پرداخت |
| **tenant owner** | یک سازمان | همان ادمین فعلی سیستم؛ دعوت کاربر با موبایل؛ وضعیت اشتراک سازمان |
| **tenant user** | یک سازمان | مجوزهای فعلی (`users.permissions`) داخل همان tenant |

یک موبایل می‌تواند عضو چند سازمان باشد. اگر فقط یک عضویت داشته باشد، UI انتخاب سازمان نمایش داده نمی‌شود.

### ۳) قرارداد session (از فاز ۱ الزامی)

1. کاربر OTP می‌گیرد (`send-otp`).
2. `verify-otp` پس از تأیید، با **Supabase Auth Admin API** session واقعی (`access_token` / `refresh_token`) صادر می‌کند.
3. کلاینت session را با `supabase.auth.setSession` نگه می‌دارد و درخواست‌های DB با JWT کاربر می‌رود.
4. **دسترسی داده دیگر به `VITE_HASH_SECRET` / HMAC محلی وابسته نیست** (HMAC فعلی فقط تا مهاجرت فاز ۱ ممکن است برای سازگاری موقت بماند، نه به‌عنوان مرز امنیتی DB).
5. `service_role` فقط داخل Edge Functions استفاده می‌شود.

### ۴) Allowlist سوپرادمین

- شماره‌های مجاز فقط در **secret سرور** (مثلاً `PLATFORM_ADMIN_PHONES`) — **نه** در `VITE_*` و نه در باندل فرانت.
- اسکلت `/platform` در فاز ۰ به‌صورت پیش‌فرض deny است تا Edge فاز ۱ به allowlist وصل شود.

### ۵) ماتریس پلن

| قابلیت / محدودیت | Trial (۷ روز) | طلایی | الماسی |
|------------------|---------------|--------|--------|
| CRM پایه | بله | بله | بله |
| چت داخلی | بله (موقت) | خیر | بله |
| ماتریس محصولات | بله (موقت) | خیر | بله |
| عودت وجه | بله (موقت) | خیر | بله |
| ارسالی‌ها | بله (موقت) | خیر | بله |
| ساب‌دامین اختصاصی | خیر | خیر | بله |
| سقف SMS روزانه | از تنظیمات سوپرادمین | همان | همان |
| حجم بکاپ | از تنظیمات / پلن | همان | همان |

- پایان Trial: قطع ایمپورت/اکسپورت + فقط‌خواندنی + paywall.
- پایان اشتراک پولی: `grace_days` (پویا در سوپرادمین) سپس فقط‌خواندنی.
- فعال‌سازی: دستی توسط سوپرادمین **و** زرین‌پال؛ بعد از پرداخت موفق، پنل سازمان فعال می‌شود.

### ۶) تنظیمات پلتفرم (پیش‌فرض اولیه)

مقادیر پیش‌فرض در `src/platform/defaults.js`؛ منبع حقیقت بعد از فاز ۲ جدول/ذخیره سروری `platform_settings` است:

- `sms_daily_limit_trial` / `gold` / `diamond`
- `grace_days`
- `trial_days` = 7

### ۷) اصول امنیتی ثابت

- هیچ راز عملیاتی در `VITE_*` یا `app_settings` کلاینت‌خوان.
- RLS پیش‌فرض deny؛ دسترسی با `auth.uid()` + عضویت `tenant_members` (یا نقش platform).
- مجوز UI مکمل RLS است، جایگزین آن نیست.
- وب‌هوک پرداخت (فاز ۴) باید idempotent و با검증 باشد.

## فاز ۴ — زرین‌پال

Secrets لازم: `ZARINPAL_MERCHANT_ID`, `ZARINPAL_SANDBOX`, `PUBLIC_APP_URL`, `CRON_SECRET`  
Functions: `create-payment`, `zarinpal-callback`, `subscription-cron`  
Cron نمونه (روزانه):  
`curl -H "x-cron-secret: $CRON_SECRET" https://<ref>.supabase.co/functions/v1/subscription-cron`

## فاز ۲ (کلاینت) — بدون وابستگی به دیپلوی Liara

- لایه `src/entitlements.js`: پلن، حالت دسترسی، paywall
- قفل قابلیت‌های الماس در تب‌ها و اکشن‌ها
- قطع ایمپورت/اکسپورت در پایان trial / readonly
- سوپرادمین: `set_subscription` برای تغییر پلن دستی

برای تست کامل همچنان migration + Edge Functions فاز ۱ لازم است.

1. اعمال migration: `supabase/migrations/031_tenancy_foundation.sql`
2. دیپلوی Edge Functions: `send-otp`, `verify-otp`, `platform-api`
3. Secrets سرور:
   - `SMS_USERNAME` / `SMS_PASSWORD` / `SMS_SENDER` (و اختیاری `SMS_API_URL` / `SMS_MESSAGE_TEMPLATE`)
   - `PLATFORM_ADMIN_PHONES` (لیست با کاما)
   - `SUPABASE_ANON_KEY` باید برای `verify-otp` در دسترس Edge باشد (معمولاً خودکار است)
4. بعد از migration، ورود فقط با OTP + JWT کار می‌کند؛ کلید anon دیگر به داده تجاری دسترسی ندارد.

## فاز ۵ — ساب‌دامین + audit + آرشیو

- Migration: `035_subdomain_audit.sql` (`tenants.subdomain`, `archived_at`, `audit_log`, `resolve_tenant_by_subdomain`)
- Edge: `tenant-ops` (`set_subdomain`, `clear_subdomain`, `archive_tenant`, `list_audit`)
- کلاینت: `src/subdomain.js` + hint روی login/boot؛ UI ساب‌دامین در وضعیت اشتراک و `/platform`
- Audit از مسیرهای ثبت‌نام، دعوت، پرداخت، cron، تغییر پلن
- بکاپ: نیاز به tenant context + entitlement ایمپورت/اکسپورت؛ بازیابی فقط در حالت writable
- Env: `VITE_ROOT_DOMAIN` (fallback؛ منبع اصلی `platform_settings.root_domain`)

برای ساب‌دامین پروداکشن، DNS wildcard (`*.carno.ir`) و TLS لازم است؛ nginx فعلی مسیرهای SPA را پوشش می‌دهد.

## پیامدها

- فاز ۱ باید migration `tenant_id` + بستن RLS باز + پل OTP→Auth را قبل از فروش انجام دهد.
- اپ آفلاین (`offline-app`) تا فاز جدا tenant-aware نمی‌شود مگر صریحاً در اسکوپ بعدی بیاید.
- برای پروداکشن، وب‌سرور باید `/platform` را به `platform.html` سرو کند (در dev توسط Vite؛ در Liara با `liara_nginx.conf`).
- UI HMAC session فقط برای نمایش هویت/مجوز است؛ مرز امنیتی داده JWT + RLS است.