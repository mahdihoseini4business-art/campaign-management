# گزارش جامع باگ‌های پروژه Campaign Management

> **تاریخ آخرین بررسی:** ۱۴۰۵/۰۵/۰۴  
> **تعداد کل باگ‌ها:** ۶۳

---

## خلاصه

| اولویت | امنیتی | داده‌ای | رابط کاربری | دسترسی‌پذیری | کیفیت کد | جمع |
|--------|--------|---------|-------------|--------------|----------|-----|
| بالا (High) | ۰ | ۰ | ۰ | ۰ | ۰ | ۰ |
| متوسط (Medium) | ۰ | ۱۱ | ۱۰ | ۵ | ۰ | ۲۶ |
| پایین (Low) | ۳ | ۵ | ۱۰ | ۹ | ۱۰ | ۳۷ |
| **جمع** | **۳** | **۱۶** | **۲۰** | **۱۴** | **۱۰** | **۶۳** |

---

## دسته ۱: باگ‌های امنیتی

### پایین (Low)

#### SEC-L1 — پسورد در متغیر scope بیش از حد باقی می‌مونه
- **فایل:** `src/auth.js` خط ۸۲

#### SEC-L2 — `getCurrentUser()` خطای JSON parse رو سکوت می‌کنه
- **فایل:** `src/utils.js` خط ۱۷۰

#### SEC-L3 — حالت password در فرم لاگین بعد از موفقیت پاک نمیشه
- **فایل:** `src/auth.js` خطوط ۱۰۷-۱۰۸

---

## دسته ۲: باگ‌های داده‌ای و یکپارچگی

### متوسط (Medium)

#### DATA-M1 — بخشی از تبدیل LD↔CS بدون rollback
- **فایل:** `src/customers.js` خطوط ۲۷۱-۲۸۴
- **توضیح:** ۳ عملیات متوالی بدون تراکنش دیتابیس. اگه وسطش خطا بخوره، حالت ناسازگار ایجاد میشه.

#### DATA-M2 — `deleteCustomer()` اگه مشتری پیدا نشه کرش می‌کنه
- **فایل:** `src/customers.js` خطوط ۳۳۱-۳۳۲
- **توضیح:** `customer.name` روی undefined throw می‌کنه.

#### DATA-M3 — شماره تلفن با فرمت‌های مختلف dedup نمیشه
- **فایل:** `src/import-export.js` خط ۲۵۱
- **توضیح:** `09121234567` و `9121234567` و `+989121234567` به عنوان مشتری‌های متفاوت شناخته میشن.

#### DATA-M4 — CSV export خطوط جدید در سلول‌ها رو مدیریت نمی‌کنه
- **فایل:** `src/import-export.js` خطوط ۷۰-۷۲
- **توضیح:** اگه فیلد notes شامل `\n` باشه، CSV خراب میشه.

#### DATA-M5 — `data.convertedCount` ممکنه string "0" باشه
- **فایل:** `src/data.js` خط ۵۱
- **توضیح:** استفاده از `||` به جای `??` باعث میشه مقدار "0" از دیتابیس به صورت string باقی بمونه.

#### DATA-M6 — ایمپورت مشتری بدون فیلد الزامی
- **فایل:** `src/import-export.js` خطوط ۲۱۸-۲۶۴
- **توضیح:** هیچ فیلدی الزامی نیست. مشتری‌های خالی در دیتابیس ایجاد میشن.

#### DATA-M7 — `updateFollowupsCustomerId()` شرایط رقابتی
- **فایل:** `src/data.js` خطوط ۱۴۳-۱۴۷

#### DATA-M9 — `saveSetting()` به unique constraint وابسته
- **فایل:** `src/data.js` خط ۱۵۴

#### DATA-M10 — تشخیص تکراری در ایمپورت فروش سخت‌گیرانه نیست
- **فایل:** `src/import-export.js` خطوط ۴۲۱-۴۲۴
- **توضیح:** محصول مشابه با قیمت متفاوت به عنوان تکراری شناخته نمیشه.

#### DATA-M11 — ایمپورت فروش همه مشتریان با محصول رو ذخیره می‌کنه
- **فایل:** `src/import-export.js` خط ۴۳۱
- **توضیح:** نه فقط مشتری‌های تغییر یافته، بلکه تمام مشتریان با محصول save میشن.

#### DATA-M12 — auto-mapping ایمپورت false positive داره
- **فایل:** `src/import-export.js` خطوط ۱۶۹-۱۷۲
- **توضیح:** substring matching باعث تطابق اشتباه میشه.

### پایین (Low)

#### DATA-L1 — products به صورت reference کپی میشه
- **فایل:** `src/data.js` خط ۳۵

#### DATA-L2 — `getAllSales()` سه بار در داشبرد صدا زده میشه
- **فایل:** `src/dashboard.js` خطوط ۸۰، ۱۸۱، ۱۹۷

#### DATA-L3 — `getAllSales()` در import-export تکراریه
- **فایل:** `src/import-export.js` خطوط ۴۱-۵۴

#### DATA-L4 — auto-created customer در sales import `nextFollowupDate` نداره
- **فایل:** `src/import-export.js` خط ۴۱۰

#### DATA-L5 — `phone.replace(/^0/, '+98')` فقط اولین صفر رو عوض می‌کنه
- **فایل:** `src/import-export.js` خط ۲۳۹

---

## دسته ۳: باگ‌های رابط کاربری (UX/UI)

### متوسط (Medium)

#### UX-M1 — شاگرد جهت مرتب‌سازی وجود نداره
- **فایل:** `src/main.js`، `src/sales.js`

#### UX-M2 — dropdown پروفایل در موبایل بدون backdrop هست
- **فایل:** `src/styles.css` خطوط ۶۸-۷۹

#### UX-M3 — اندازه دکمه‌های action در جدول کوچکه
- **فایل:** `src/styles.css` خطوط ۱۸۳-۱۸۹

#### UX-M4 — شکست لود داده سکوت میشه
- **فایل:** `src/data.js`، `src/main.js`

#### UX-M5 — بستن مودال با Escape بدون تایید داده ذخیره نشده
- **فایل:** `src/main.js` خطوط ۱۹۳-۱۹۷

#### UX-M6 — Escape همه مودال‌ها رو همزمان می‌بنده
- **فایل:** `src/main.js` خطوط ۱۹۳-۱۹۷

#### UX-M7 — pagination در هیچ جدولی وجود نداره
- **فایل:** `index.html`

#### UX-M8 — تب‌ها در موبایل بدون scroll hint هستن
- **فایل:** `src/styles.css` خطوط ۷۹۱-۷۹۶

#### UX-M9 — `initDigitConversion()` قبل از auth check اجرا میشه
- **فایل:** `src/main.js` خطوط ۱۶۱-۱۶۲

#### UX-M10 — `jalaliDatepicker` بدون بررسی وجود globals
- **فایل:** `src/main.js` خط ۲۰۰

### پایین (Low)

#### UX-L1 — هدرهای جدول keyboard support ندارن
#### UX-L2 — emoji به عنوان آیکون UI استفاده شده
#### UX-L3 — ستون توضیحات در موبایل truncate بدون expansion
#### UX-L4 — جستجوی پیگیری‌ها فقط نام و توضیحات رو جستجو می‌کنه
#### UX-L5 — آمار فروش فرمت متفاوت دارن
#### UX-L6 — مودال حذف ARIA role نداره
#### UX-L7 — پیام خطای لاگین aria-describedby نداره
#### UX-L8 — آیتم "پروفایل" dead-end هست
#### UX-L9 — دکمه خروجی بدون بازخورد در صورت عدم دسترسی
#### UX-L10 — کلیک روی overlay مودال بدون تایید

---

## دسته ۴: باگ‌های دسترسی‌پذیری (Accessibility)

### متوسط (Medium)

#### A11Y-M2 — Error message `role="alert"` نداره
- **فایل:** `login.html` خط ۱۲۱

#### A11Y-M5 — جدول‌ها `<caption>` یا `aria-label` ندارن
- **فایل:** `index.html`

#### A11Y-M6 — `prefers-reduced-motion` پشتیبانی نمیشه
- **فایل:** `src/styles.css`

#### A11Y-M7 — `:focus-visible` styles وجود نداره
- **فایل:** `src/styles.css`

#### A11Y-M8 — `<main>` و `<nav>` landmark نداره
- **فایل:** `index.html`

### پایین (Low)

#### A11Y-L1 — `font-display` control روی فونت CDN نیست
#### A11Y-L2 — print styles وجود نداره
#### A11Y-L3 — `preconnect` برای CDN نیست
#### A11Y-L4 — script ها در head render-blocking هستن
#### A11Y-L5 — CSP meta tag وجود نداره
#### A11Y-L6 — `:focus-visible` styles نداره
#### A11Y-L7 — Scrollbar مخفی در تب‌ها مشکل‌سازه
#### A11Y-L8 — `margin-right: auto` در RTL اشتباهه
#### A11Y-L10 — نداشتن `<noscript>` fallback

---

## دسته ۵: باگ‌های کیفیت کد

### پایین (Low)

#### QC-L1 — ثابت‌های تکراری در فایل‌های مختلف
#### QC-L4 — فیلتر تاریخ در داشبرد vs تب فروش متفاوته
#### QC-L5 — توابع داخلی بیش از حد export شدن
#### QC-L6 — state loading در async وجود نداره
#### QC-L7 — CDN خارجی بدون fallback
#### QC-L9 — تبدیل digit جهانی ممکنه با ویجت‌ها تداخل کنه
#### QC-L10 — `initDigitConversion()` قبل از auth اجرا میشه
#### QC-L12 — `formatNumber()` edge case با چند نقطه
#### QC-L14 — `jalaliAddDays()` after year rollover leap year اشتباهه
#### QC-L15 — `getTodayJalaliStr()` timezone hack شکننده‌ست

---

## اولویت پیشنهادی برای رفع

### بهبود (backlog)
1. **UX-M1** — Sort indicator
2. **DATA-M1** — تبدیل LD↔CS بدون rollback
3. **DATA-M2** — deleteCustomer روی مشتری ناموجود کرش می‌کنه
4. **A11Y-M7** — :focus-visible styles
5. **A11Y-M2** — Error message role="alert"
