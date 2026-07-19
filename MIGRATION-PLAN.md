# پلن فازبندی مهاجرت از localStorage به Supabase

## مرور کلی
مهاجرت پروژه از ذخیره‌سازی مرورگری (localStorage) به **Supabase** (PostgreSQL + Auth + API خودکار) برای پشتیبانی از چند کاربر همزمان و دیپلوی روی وب.

**چرا Supabase؟**
- بدون نیاز به نوشتن بک‌اند دستی
- دیتابیس PostgreSQL managed
- احراز هویت آماده (email/password, social login)
- API خودکار (REST + GraphQL)
- رایگان تا 500MB دیتابیس و 50K کاربر فعال ماهانه
- دیپلوی رایگان روی Vercel/Netlify

**فناوری:** Supabase (Database + Auth + API) + Vercel (هاست فرانت)

---

## فاز ۰: آماده‌سازی اولیه و ساخت پروژه Supabase
**زمان تقریبی: ۱-۲ ساعت**

- [ ] ساخت اکانت رایگان در [supabase.com](https://supabase.com)
- [ ] ایجاد پروژه جدید در Supabase Dashboard
- [ ] دریافت Project URL و Anon Key از پنل Supabase
- [ ] نصب Supabase CLI: `npm install -g supabase`
- [ ] ایجاد فایل `.env` در پروژه:
  ```
  VITE_SUPABASE_URL=https://your-project.supabase.co
  VITE_SUPABASE_ANON_KEY=your-anon-key
  ```
- [ ] نصب کلاینت Supabase در پروژه: `npm install @supabase/supabase-js`
- [ ] ایجاد فایل `supabase.js` برای اتصال:
  ```javascript
  import { createClient } from '@supabase/supabase-js'
  export const supabase = createClient(
    import.meta.env.VITE_SUPABASE_URL,
    import.meta.env.VITE_SUPABASE_ANON_KEY
  )
  ```

**خروجی:** پروژه Supabase آماده و اتصال از فرانت برقرار

---

## فاز ۱: طراحی و ایجاد جداول دیتابیس
**زمان تقریبی: ۲-۳ ساعت**

- [ ] ایجاد جدول `users` (از طریق Supabase SQL Editor):
  ```sql
  CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    display_name TEXT,
    role TEXT DEFAULT 'user' CHECK (role IN ('admin', 'user')),
    permissions JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW()
  );
  ```
- [ ] ایجاد جدول `customers`:
  ```sql
  CREATE TABLE customers (
    id TEXT PRIMARY KEY,
    platform_id TEXT,
    platform TEXT,
    name TEXT,
    phone TEXT,
    status TEXT,
    notes TEXT,
    advisor TEXT,
    next_followup_date TEXT,
    products JSONB DEFAULT '[]',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
  );
  ```
- [ ] ایجاد جدول `followups`:
  ```sql
  CREATE TABLE followups (
    id BIGSERIAL PRIMARY KEY,
    customer_id TEXT REFERENCES customers(id) ON DELETE CASCADE,
    date TEXT,
    type TEXT,
    result TEXT,
    next_date TEXT,
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
  );
  ```
- [ ] ایجاد جدول `app_settings`:
  ```sql
  CREATE TABLE app_settings (
    key TEXT PRIMARY KEY,
    value JSONB
  );
  ```
- [ ] اضافه کردن index برای فیلترها:
  ```sql
  CREATE INDEX idx_customers_advisor ON customers(advisor);
  CREATE INDEX idx_customers_status ON customers(status);
  CREATE INDEX idx_followups_customer ON followups(customer_id);
  ```
- [ ] فعال کردن RLS (Row Level Security) روی همه جداول
- [ ] ایجاد policy برای دسترسی کاربران (بعد از فاز ۲)
- [ ] Seed داده اولیه (کاربر admin + مشتریان نمونه)

**خروجی:** 4 جدول با index و RLS آماده

---

## فاز ۲: سیستم احراز هویت Supabase Auth
**زمان تقریبی: ۳-۴ ساعت**

> **نکته:** Supabase Auth به صورت پیش‌فرض email/password داره. اما چون پروژه فعلی username/password داره، باید یکی از دو رویکرد رو انتخاب کنیم:
> - **رویکرد A:** استفاده از email بجای username (تغییر فرم لاگین)
> - **رویکرد B:** ذخیره کاربران در جدول `users` خودمان + بررسی دستی رمز (پیشنهاد میشه)

### رویکرد پیشنهادی (B): احراز هویت سفارشی
- [ ] پیاده‌سازی تابع `hashPassword(password)` با Web Crypto API:
  ```javascript
  async function hashPassword(password) {
    const encoder = new TextEncoder();
    const data = encoder.encode(password);
    const hash = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(hash))
      .map(b => b.toString(16).padStart(2, '0')).join('');
  }
  ```
- [ ] پیاده‌سازی `doLogin()` با Supabase:
  ```javascript
  async function doLogin() {
    const username = document.getElementById('loginUsername').value;
    const password = document.getElementById('loginPassword').value;
    const hash = await hashPassword(password);

    const { data: user } = await supabase
      .from('users')
      .select('*')
      .eq('username', username)
      .eq('password_hash', hash)
      .single();

    if (!user) { showToast('نام کاربری یا رمز اشتباه'); return; }

    localStorage.setItem('session', JSON.stringify(user));
    applyPermissions();
  }
  ```
- [ ] پیاده‌سازی `getCurrentUser()`:
  ```javascript
  function getCurrentUser() {
    const raw = localStorage.getItem('session');
    return raw ? JSON.parse(raw) : null;
  }
  ```
- [ ] پیاده‌سازی `doLogout()`:
  ```javascript
  function doLogout() {
    localStorage.removeItem('session');
    location.reload();
  }
  ```
- [ ] پیاده‌سازی CRUD کاربران با Supabase:
  - `getUsers()` → `supabase.from('users').select('*')`
  - `addUser()` → `supabase.from('users').insert({...})`
  - `deleteUser()` → `supabase.from('users').delete().eq('id', id)`
  - `updateUser()` → `supabase.from('users').update({...}).eq('id', id)`
- [ ] تست کامل لاگین/لاگاوت/مدیریت کاربران

**خروجی:** احراز هویت با Supabase فعال

---

## فاز ۳: مهاجرت ذخیره‌سازی مشتریان
**زمان تقریبی: ۳-۴ ساعت**

- [ ] تغییر `loadData()`:
  ```javascript
  async function loadData() {
    const { data: customers } = await supabase.from('customers').select('*');
    const { data: followups } = await supabase.from('followups').select('*');
    const { data: settings } = await supabase.from('app_settings').select('*');
    // تبدیل به ساختار فعلی
    return { customers, followups, nextId: ..., convertedCount: ... };
  }
  ```
- [ ] تغییر `saveData()` → ذخیره تکی هر مشتری:
  ```javascript
  async function saveCustomerToDB(customer) {
    await supabase.from('customers').upsert(customer);
  }
  ```
- [ ] تغییر `saveData()` → ذخیره تکی هر پیگیری:
  ```javascript
  async function saveFollowupToDB(followup) {
    await supabase.from('followups').upsert(followup);
  }
  ```
- [ ] تغییر تابع `saveCustomer()` (فرم مشتری) برای ذخیره در دیتابیس
- [ ] تغییر تابع `deleteCustomer()` برای حذف از دیتابیس
- [ ] تغییر تابع `saveFollowup()` (پیگیری) برای ذخیره در دیتابیس
- [ ] تغییر تابع `deleteFollowup()` برای حذف از دیتابیس
- [ ] حذف کامل `saveData()` و `loadData()` قدیمی
- [ ] تغییر `nextId` → استفاده از sequence دیتابیس یا UUID

**خروجی:** مشتریان و پیگیری‌ها در Supabase ذخیره میشن

---

## فاز ۴: مهاجرت ذخیره‌سازی فروش‌ها
**زمان تقریبی: ۲-۳ ساعت**

> **نکته:** فروش‌ها فعلیً در فیلد `products` هر مشتری ذخیره میشن (JSONB). این ساختار با Supabase سازگاره و نیازی به جدول جداگانه نیست.

- [ ] بررسی تابع `getAllSales()` → باید از دیتابیس بخونه
- [ ] تغییر `addProductRow()` → ذخیره در `products` مشتری مربوطه
- [ ] تغییر `updateProduct()` → آپدیت `products` مشتری مربوطه
- [ ] تغییر `removeProduct()` → حذف از `products` مشتری مربوطه
- [ ] اطمینان از عملکرد صحیح فیلترها و آمار

**خروجی:** فروش‌ها در دیتابیس ذخیره میشن

---

## فاز ۵: مهاجرت ایمپورت/اکسپورت
**زمان تقریبی: ۳-۴ ساعت**

### ایمپورت مشتری
- [ ] تغییر `doImport()` → خواندن فایل اکسل در مرورگر (همونطور که هست)
- [ ] تغییر ذخیره‌سازی → `supabase.from('customers').insert([...])`
- [ ] اضافه کردن batch insert برای عملکرد بهتر:
  ```javascript
  await supabase.from('customers').insert(newCustomers);
  ```

### ایمپورت فروش
- [ ] تغییر `doSalesImport()` → ذخیره در `products` مشتریان
- [ ] اضافه کردن batch update

### اکسپورت
- [ ] تغییر `exportTabCSV()` → خواندن از دیتابیس
- [ ] تغییر `exportTabXLSX()` → خواندن از دیتابیس
- [ ] اضافه کردن فیلتر کارشناس به خروجی

**خروجی:** ایمپورت/اکسپورت با Supabase کار می‌کنه

---

## فاز ۶: فیلترها و آمار داشبرد
**زمان تقریبی: ۲-۳ ساعت**

- [ ] تغییر `renderCustomers()` → فیلتر با Supabase query:
  ```javascript
  let query = supabase.from('customers').select('*');
  if (advisorFilter) query = query.eq('advisor', advisorFilter);
  if (search) query = query.or(`name.ilike.%${search}%,phone.ilike.%${search}%`);
  ```
- [ ] تغییر `renderFollowups()` → فیلتر با Supabase query
- [ ] تغییر `renderSales()` → فیلتر با Supabase query
- [ ] تغییر `renderDashboard()` → آمار از دیتابیس
- [ ] تغییر نمودارها → داده از دیتابیس
- [ ] اضافه کردن pagination برای لیست‌های بزرگ

**خروجی:** فیلترها و آمار از دیتابیس خوانده میشن

---

## فاز ۷: اتصال تبدیل LD↔CS و آپدیت خودکار
**زمان تقریبی: ۱-۲ ساعت**

- [ ] بررسی تبدیل LD→CS → آپدیت `id` در دیتابیس
- [ ] بررسی تبدیل CS→LD → آپدیت `id` در دیتابیس
- [ ] بررسی بروزرسانی خودکار followupها هنگام تبدیل
- [ ] بررسی عملکرد `nextFollowupDate`
- [ ] تست کامل سناریوهای تبدیل

**خروجی:** تبدیل نوع مشتری در دیتابیس کار می‌کنه

---

## فاز ۸: RLS و امنیت دیتابیس
**زمان تقریبی: ۲-۳ ساعت**

- [ ] نوشتن RLS policy برای جدول `customers`:
  ```sql
  -- کاربران فقط مشتریان خودشون رو ببینن (اختیاری)
  CREATE POLICY "Users can view own customers" ON customers
    FOR SELECT USING (true); -- یا شرط دقیق‌تر

  -- فقط ادمین بتونه حذف کنه
  CREATE POLICY "Only admin can delete" ON customers
    FOR DELETE USING (
      EXISTS (SELECT 1 FROM users WHERE role = 'admin')
    );
  ```
- [ ] نوشتن RLS policy برای جدول `followups`
- [ ] نوشتن RLS policy برای جدول `users` (فقط ادمین)
- [ ] تست دسترسی کاربران مختلف
- [ ] غیرفعال کردن دسترسی anonymous به جداول حساس
- [ ] فعال کردن SSL و HTTPS

**خروجی:** دیتابیس امن با دسترسی کنترل‌شده

---

## فاز ۹: دیپلوی و تست نهایی
**زمان تقریبی: ۲-۳ ساعت**

- [ ] آماده‌سازی پروژه برای دیپلوی:
  - فایل `.env.production` با متغیرهای محیطی
  - حذف فایل‌های اضافی
- [ ] دیپلوی فرانت روی **Vercel** (رایگان):
  ```bash
  npm i -g vercel
  vercel --prod
  ```
- [ ] یا دیپلوی روی **Netlify** (رایگان)
- [ ] تنظیم متغیرهای محیطی در Vercel/Netlify
- [ ] تست نهایی در محیط production:
  - لاگین/لاگاوت
  - CRUD مشتریان
  - پیگیری‌ها
  - فروش‌ها
  - ایمپورت/اکسپورت
  - فیلترها
  - داشبرد
  - چند کاربر همزمان
- [ ] تست روی موبایل و دسکتاپ
- [ ] اشتراک‌گذاری لینک با تیم

**خروجی:** پروژه دیپلوی شده و قابل استفاده

---

## خلاصه زمانی

| فاز | عنوان | زمان تقریبی |
|---|---|---|
| ۰ | آماده‌سازی اولیه Supabase | ۱-۲ ساعت |
| ۱ | ایجاد جداول دیتابیس | ۲-۳ ساعت |
| ۲ | احراز هویت Supabase Auth | ۳-۴ ساعت |
| ۳ | مهاجرت مشتریان و پیگیری‌ها | ۳-۴ ساعت |
| ۴ | مهاجرت فروش‌ها | ۲-۳ ساعت |
| ۵ | ایمپورت/اکسپورت | ۳-۴ ساعت |
| ۶ | فیلترها و داشبرد | ۲-۳ ساعت |
| ۷ | تبدیل LD↔CS | ۱-۲ ساعت |
| ۸ | RLS و امنیت | ۲-۳ ساعت |
| ۹ | دیپلوی و تست | ۲-۳ ساعت |
| **جمع** | | **۲۱-۳۱ ساعت** |

**تقریباً ۳ تا ۴ روز کاری** (با فرض ۷-۸ ساعت کار در روز)

---

## مقایسه با پلن قبلی (Docker + PostgreSQL)

| معیار | پلن قبلی | پلن Supabase |
|---|---|---|
| زمان کل | ۳۰-۴۳ ساعت | ۲۱-۳۱ ساعت |
| نوشتن API | بله (دستی) | خیر (خودکار) |
| نوشتن Auth | بله (دستی) | خیر (آماده) |
| مدیریت سرور | بله | خیر |
| هزینه ماهانه | سرور VPS | رایگان (تا حدی) |
| پیچیدگی | بالا | متوسط |

---

## هزینه‌های Supabase

| پلن | قیمت | محدودیت |
|---|---|---|
| **Free** | رایگان | 500MB دیتابیس, 50K کاربر فعال, 1GB transfer |
| **Pro** | $25/ماه | 8GB دیتابیس, 100K کاربر, 250GB transfer |
| **Team** | $599/ماه | همه چیز نامحدود |

**برای شروع: پلن Free کافیه**

---

## ابزارهای مورد نیاز

| ابزار | نصب | توضیح |
|---|---|---|
| Node.js | `brew install node` | Runtime |
| Supabase CLI | `npm i -g supabase` | مدیریت پروژه |
| Vercel CLI | `npm i -g vercel` | دیپلوی فرانت |
| npm | با Node نصب میشه | مدیریت پکیج‌ها |

---

## فایل‌های کلیدی که باید ایجاد/تغییر کنن

| فایل | وضعیت | توضیح |
|---|---|---|
| `supabase.js` | **جدید** | اتصال به Supabase |
| `api.js` | **جدید** | توابع API |
| `digital-marketing-sheet.html` | **تغییر** | حذف localStorage + اضافه کردن API calls |
| `.env` | **جدید** | متغیرهای محیطی |
| `.env.example` | **جدید** | نمونه متغیرها |
| `package.json` | **جدید** | وابستگی‌ها |
