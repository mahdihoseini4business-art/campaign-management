# راهنمای راه‌اندازی سیستم OTP

## خلاصه مراحل

| مرحله | کار | وضعیت |
|-------|-----|-------|
| ۱ | اجرای SQL در Supabase | ⏳ دستی |
| ۲ | استقرار Edge Functions | ⏳ دستی |
| ۳ | تنظیم متغیرهای محیطی | ⏳ دستی |
| ۴ | تست لاگین | ⏳ دستی |

---

## مرحله ۱: اجرای SQL در Supabase

### مراحل:
1. به [Supabase Dashboard](https://supabase.com/dashboard) برو
2. پروژه خود را انتخاب کن
3. از منوی سمت چپ روی **SQL Editor** کلیک کن
4. روی **New query** کلیک کن
5. کد SQL زیر را کپی و Paste کن:

```sql
-- فاز ۱: زیرساخت دیتابیس برای سیستم OTP

-- ۱. ایجاد جدول otp_sessions
CREATE TABLE IF NOT EXISTS otp_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone TEXT NOT NULL,
  code TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  attempts INT DEFAULT 0,
  verified BOOLEAN DEFAULT false
);

CREATE INDEX IF NOT EXISTS idx_otp_phone ON otp_sessions(phone);
CREATE INDEX IF NOT EXISTS idx_otp_expires ON otp_sessions(expires_at);

-- ۲. اضافه کردن ستون‌های جدید به جدول users
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone TEXT UNIQUE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS first_name TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_name TEXT;

-- ۳. فعال کردن RLS روی جدول otp_sessions
ALTER TABLE otp_sessions ENABLE ROW LEVEL SECURITY;

-- سیاست: فقط سرویس‌ها (Edge Function) می‌توانند بنویسند
CREATE POLICY "Service role can manage otp_sessions" ON otp_sessions
  FOR ALL USING (true);

-- سیاست: کاربران فقط می‌توانند session خود را بخوانند
CREATE POLICY "Users can read own OTP sessions" ON otp_sessions
  FOR SELECT USING (true);
```

6. روی **Run** کلیک کن
7. مطمئن شو پیام موفقیت نمایش داده شد

---

## مرحله ۲: استقرار Edge Functions

### پیش‌نیازها:
- نصب [Supabase CLI](https://supabase.com/docs/guides/cli)
- لاگین به Supabase CLI

### مراحل:

```bash
# ۱. نصب Supabase CLI (اگر نصب نیست)
npm install -g supabase

# ۲. لاگین به Supabase
supabase login

# ۳. لینک پروژه (شماره پروژه خود را از Dashboard بگیر)
supabase link --project-ref <your-project-ref>

# ۴. استقرار Edge Functions
supabase functions deploy send-otp
supabase functions deploy verify-otp
```

**نکته:** اگر Supabase CLI نصب نیست، می‌توانید Edge Functions را از طریق Dashboard هم آپلود کنید:
1. در Dashboard روی **Edge Functions** کلیک کن
2. روی **Create a new function** کلیک کن
3. نام: `send-otp`
4. کد `supabase/functions/send-otp/index.ts` را Paste کن
5. همین کار را برای `verify-otp` تکرار کن

---

## مرحله ۳: تنظیم متغیرهای محیطی

### در Supabase Dashboard:

1. روی **Edge Functions** کلیک کن
2. روی **Secrets** کلیک کن
3. متغیرهای زیر را اضافه کن:

| نام | مقدار | توضیح |
|-----|-------|-------|
| `SMS_USERNAME` | نام کاربری SmartSMS | از پنل payamak-panel.com |
| `SMS_PASSWORD` | ApiKey SmartSMS | از بخش توسعه‌دهندگان |
| `SMS_SENDER` | شماره فرستنده | شماره اختصاصی شما |

**نکته:** مقادیر `SUPABASE_URL` و `SUPABASE_SERVICE_ROLE_KEY` خودکار تنظیم هستند.

---

## مرحله ۴: تست لاگین

### ۴.۱ ایجاد کاربر تست

1. برنامه را اجرا کن: `npm run dev`
2. وارد سایت شو (با لاگین قدیمی یا مستقیم به `/index.html`)
3. در کنسول مرورگر (F12) اجرا کن:

```javascript
// ایجاد کاربر تست با شماره ۰۹۱۲۳۴۵۶۷۸۹
appDebugCreateTestUser('09123456789', 'تست', 'کاربر')
```

### ۴.۲ تست لاگین OTP

1. مرورگر را در حالت Incognito باز کن
2. به `/login.html` برو
3. شماره `۰۹۱۲۳۴۵۶۷۸۹` را وارد کن
4. روی **ارسال کد تأیید** کلیک کن
5. کد ۶ رقمی را از پیامک دریافت کن
6. کد را وارد کن و **تأیید** را بزن

### ۴.۳ تست در موبایل

- صفحه لاگین ریسپانسیو است
- کیبورد عددی خودکار نمایش داده می‌شود
- paste خودکار کد از clipboard کار می‌کند

---

## عیب‌یابی

### اگر پیامک ارسال نشد:
- متغیرهای SMS را در Supabase بررسی کن
- شماره فرستنده (Sender) معتبر است؟
- اعتبار حساب SmartSMS کافی است؟

### اگر کد OTP تأیید نشد:
- در کنسول مرورگر اجرا کن: `appDebugListUsers()`
- بررسی کن کاربر با آن شماره وجود دارد
- بررسی کن جدول `otp_sessions` در دیتابیس ساخته شده

### اگر Edge Function خطا داد:
- در Supabase Dashboard روی **Edge Functions** → **Logs** کلیک کن
- لاگ‌ها را بررسی کن

---

## دستورات مفید برای تست (کنسول مرورگر)

```javascript
// لیست تمام کاربران
appDebugListUsers()

// ایجاد کاربر تست
appDebugCreateTestUser('09123456789', 'تست', 'کاربر')

// بررسی نشست فعلی
JSON.parse(localStorage.getItem('campaign_manager_session'))
```
