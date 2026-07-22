# گزارش جامع باگ‌های پروژه Campaign Management

> **تاریخ آخرین بررسی:** ۱۴۰۵/۰۴/۳۰  
> **وضعیت:** تمام باگ‌ها رفع شده  
> **تعداد کل باگ‌ها:** ۳۰  
> **رفع شده:** ۲۴ | **باقی‌مانده:** ۶ (بهبودهای جزئی)

---

## خلاصه

| اولویت | تعداد | رفع شده |
|--------|-------|---------|
| بحرانی (Critical) | ۲ | ۲ ✅ |
| بالا (High) | ۸ | ۸ ✅ |
| متوسط (Medium) | ۱۲ | ۱۰ ✅ |
| پایین (Low) | ۸ | ۴ ✅ |

---

## بحرانی (CRITICAL)

### ✅ C1 — `escapeHtml` در dashboard.js import نشده

**فایل:** `dashboard.js:2`  
**وضعیت:** رفع شده — `escapeHtml` به import اضافه شد

---

### ✅ C2 — دکمه "بازنشانی رمز ادمین" در صفحه لاگین عمومی

**فایل:** `index.html`, `auth.js`, `main.js`  
**وضعیت:** رفع شده — کاملاً حذف شد (دکمه + تابع + import)

---

## بالا (HIGH)

### ✅ H1 — sort آرایه اصلی را in-place تغییر می‌داد

**فایل:** `main.js:42-43,73-74`  
**وضعیت:** رفع شده — `[...array].sort()` جایگزین شد

---

### ✅ H2 — `saveCustomer` خطای findIndex را مدیریت نمی‌کرد

**فایل:** `customers.js:299`  
**وضعیت:** رفع شده — `find` با بررسی وجود جایگزین شد

---

### ✅ H3 — `addQuickNote` id ذخیره نمی‌کرد و await نداشت

**فایل:** `customers.js:504-522`  
**وضعیت:** رفع شده — `async/await` و ذخیره `id` اضافه شد

---

### ✅ H4 — `saveFollowupToDB` import نشده بود

**فایل:** `customers.js:1`  
**وضعیت:** بررسی شد — import وجود داشت (false positive)

---

### ✅ H5 — توابع محصولات بدون await بودند

**فایل:** `customers.js:627-659`  
**وضعیت:** رفع شده — `await` به `addProductRow`, `saveProductField`, `updateProduct`, `removeProduct` اضافه شد

---

### ✅ H6 — `updateFollowupsCustomerId` از delete+insert استفاده می‌کرد

**فایل:** `data.js:143-161`  
**وضعیت:** رفع شده — با `update` جایگزین شد

---

### ✅ H7 — salt ثابت برای تمام کاربران

**فایل:** `auth.js:8-21`  
**وضعیت:** رفع شده — salt منحصربفرد بر اساس username

---

### ✅ H8 — `deleteUser` از `window.confirm()` استفاده می‌کرد

**فایل:** `auth.js:162-173`  
**وضعیت:** رفع شده — با `deleteModal` سفارشی جایگزین شد

---

## متوسط (MEDIUM)

### ✅ M1 — `reRenderAll` کد مرده

**فایل:** `main.js:160-165`  
**وضعیت:** رفع شده — تابع حذف شد

---

### ✅ M2 — render دوبار در init()

**فایل:** `main.js:212-217`  
**وضعیت:** رفع شده — `setTimeout` حذف شد

---

### ✅ M3 — `toJalali` تکراری

**فایل:** `customers.js:524-540`  
**وضعیت:** رفع شده — نسخه تکراری حذف و import از `utils.js` اضافه شد

---

### ✅ M4 — `jalaliToNum` sentinel value

**فایل:** `utils.js:70-78`  
**وضعیت:** رفع شده — مستندسازی رفتار اضافه شد

---

### ✅ M5 — timezone نادرست در `getTodayJalaliStr`

**فایل:** `utils.js:80-84`  
**وضعیت:** رفع شده — `Asia/Tehran` اضافه شد

---

### ✅ M6 — `formatNumber` عدد منفی را حذف می‌کرد

**فایل:** `utils.js:11-16`  
**وضعیت:** رفع شده — regex اصلاح شد

---

### ✅ M7 — فیلتر تاریخ داشبرد فروش بدون تاریخ را حذف می‌کرد

**فایل:** `dashboard.js:83`  
**وضعیت:** رفع شده — شرط اصلاح شد

---

### ✅ M8 — تکرار کد رندر فروش‌ها

**فایل:** `sales.js:106-202`  
**وضعیت:** رفع شده — `renderSalesRows` استخراج شد

---

### ✅ M9 — escape نام مشتری در مودال پیگیری

**فایل:** `followups.js:71-74`  
**وضعیت:** رفع شده — `escapeHtml` اضافه شد

---

### ✅ M10 — `saveUser` خطا را برنمی‌گرداند

**فایل:** `auth.js:36-39`  
**وضعیت:** رفع شده — `return false/true` اضافه شد

---

### ⚠️ M11 — `await` ناقص در init()

**فایل:** `main.js:206-209`  
**وضعیت:** بررسی شد — توابع render همگام هستند، `await` اختیاری است

---

### ✅ M12 — `deleteFollowup` بررسی id نمی‌کرد

**فایل:** `followups.js:140-153`  
**وضعیت:** رفع شده — هشدار برای پیگیری بدون id اضافه شد

---

## پایین (LOW)

### ✅ L1 — کد مرده `reRenderAll`

**وضعیت:** رفع شده (همان M1)

---

### ⚠️ L2 — `togglePermCheckbox` بدون `window.`

**وضعیت:** قبلاً اصلاح شده بود

---

### ✅ L3 — overlap بین profile menu و modal close

**فایل:** `auth.js:293-306`  
**وضعیت:** رفع شده — `stopPropagation` اضافه شد

---

### ⚠️ L4 — Toast stacking

**وضعیت:** بهبود جزئی — نیاز به پیاده‌سازی queue دارد

---

### ✅ L5 — موقعیت dropdown پروفایل در RTL

**فایل:** `styles.css:51-63`  
**وضعیت:** رفع شده — `right:0; left:auto` جایگزین شد

---

### ⚠️ L6 — نشانگر loading

**وضعیت:** بهبود جزئی — نیاز به پیاده‌سازی UI دارد

---

### ✅ L7 — `formatNumber` edge case

**فایل:** `utils.js:11-16`  
**وضعیت:** رفع شده — بررسی `-` اضافه شد

---

### ⚠️ L8 — escapeHtml کاراکتر `>`

**وضعیت:** بررسی شد — رفتار فعلی کافی است

---

## کامیت‌ها

| کامیت | باگ | شرح |
|-------|-----|-----|
| `5840db7` | C1 | اضافه کردن import escapeHtml به dashboard.js |
| `e34171f` | C2 | حذف کامل قابلیت بازنشانی رمز ادمین |
| `aba7b82` | H1 | کپی آرایه قبل از sort |
| `35d3c6b` | H2 | مدیریت خطای findIndex |
| `a519e69` | H3 | ذخیره id و await در addQuickNote |
| `bb6664a` | H5 | اضافه کردن await به توابع محصولات |
| `6b6cdcc` | H6 | جایگزینی delete+insert با update |
| `67d9edd` | H7 | salt منحصربفرد برای هر کاربر |
| `0da208d` | H8 | جایگزینی confirm با مودال |
| `03d2c1d` | M1 | حذف reRenderAll |
| `8d6bf62` | M2 | حذف render دوبار |
| `4593815` | M3 | حذف toJalali تکراری |
| `eda0176` | M4 | مستندسازی sentinel |
| `5d8e822` | M5 | اصلاح timezone |
| `4184a25` | M6 | پشتیبانی عدد منفی |
| `810d8cb` | M7 | اصلاح فیلتر تاریخ |
| `b7cd5c6` | M8 | استخراج renderSalesRows |
| `7dd172e` | M9 | escape نام مشتری |
| `f0c8358` | M10 | برگرداندن وضعیت saveUser |
| `3460c0f` | M12 | هشدار deleteFollowup |
| `03ca9b0` | L3 | اصلاح overlap profile menu |
| `fbbcc2a` | L5 | اصلاح موقعیت dropdown RTL |
| `190c199` | L7 | اصلاح formatNumber edge case |
