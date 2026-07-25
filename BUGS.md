# گزارش جامع باگ‌های پروژه Campaign Management

> **تاریخ آخرین بررسی:** ۱۴۰۵/۰۵/۰۳  
> **تعداد کل باگ‌ها:** ۸۸  
> **فیکس شده:** ۳۲ باگ

---

## خلاصه

| اولویت | امنیتی | داده‌ای | رابط کاربری | دسترسی‌پذیری | کیفیت کد | جمع |
|--------|--------|---------|-------------|--------------|----------|-----|
| بالا (High) | ۰ | ۸ | ۰ | ۶ | ۱ | ۱۵ |
| متوسط (Medium) | ۴ | ۱۱ | ۱۰ | ۸ | ۰ | ۳۳ |
| پایین (Low) | ۳ | ۵ | ۱۰ | ۱۰ | ۲ | ۳۰ |
| **جمع** | **۷** | **۲۴** | **۲۰** | **۲۴** | **۳** | **۷۸** |

---

## باگ‌های فیکس شده ✅

| باگ | توضیح | کامیت |
|---|---|---|
| SEC-C1 | اضافه کردن HMAC signature به session | `37d9042` |
| SEC-C2/C3 | اضافه کردن escapeAttr برای onclick handlers | `6d36c03` |
| SEC-C4 | حذف ریست رمز عبور admin در هر لود | `1677749` |
| SEC-H5 | حذف override رمز admin (بخشی از SEC-C4) | `1677749` |
| SEC-H2 | escapeHtml اکنون escapeAttr رو هم پوشش میده | `6d36c03` |
| DATA-C1 | بررسی خطا در حذف پیگیری‌ها قبل از حذف مشتری | `60d8490` |
| DATA-C2 | propagate کردن خطاهای loadData | `3eb4327` |
| DATA-C3 | تغییر generateId به async با کوئری مستقیم دیتابیس | `ab9f1ad` |
| DATA-C4/QC-C1 | اضافه کردن catch به init() + نمایش پیام خطا | `8ea5b87` |
| DATA-L6 | generateId اکنون شناسه تکراری تولید نمی‌کنه | `ab9f1ad` |
| DATA-M8 | حذف non-atomic اصلاح شد (بخشی از DATA-C1) | `60d8490` |
| UX-C1 | حذف display:flex تناقضی از loading overlay | `2110221` |
| UX-C2 | مخفی کردن loading overlay قبل از redirect | `2110221` |
| SEC-H1 | اضافه کردن محدودیت تعداد تلاش لاگین | `f38ee40` |
| SEC-H3 | اضافه کردن اعتبارسنجی رمز عبور | `1078d1b` |
| SEC-H4 | استفاده از secret key در salt رمز عبور | `506444c` |
| QC-H3 | sort آرایه با کپی به جای in-place | `aba7b82` |
| QC-L3 | حذف `isAdmin()` کد مرده | — |
| UX-H1 | حذف `user-scalable=no` از index.html و login.html | `a]` |
| UX-H2 | اضافه کردن try-catch به لاگین + غیرفعال کردن دکمه | `a]` |
| UX-H3 | اضافه کردن try/finally به saveCustomer برای غیرفعال کردن دکمه | `a]` |
| UX-H4 | اضافه کردن `for` به تمام label فیلدها | `a]` |
| UX-H5 | اصلاح Toast flicker با clearTimeout و reflow | `a]` |
| QC-H2 | اضافه کردن null check به switchTab | `a]` |
| QC-M1 | اضافه کردن throw به deleteUserFromDB | `a]` |
| QC-M4 | حذف await غیرضروری از renderFollowups | `a]` |
| QC-M5 | کش کردن getAllSales در داشبرد | `a]` |
| QC-M6 | کش کردن getRows در exportTabXLSX | `a]` |
| QC-L2 | حذف formatInput/unformatInput مرده از utils | `a]` |
| QC-L8 | اضافه کردن backtick به escapeHtml | `a]` |
| QC-L11 | اضافه کردن null-check به showToast | `a]` |
| QC-L13 | اصلاح formatInput برای پشتیبانی عدد منفی | `a]` |

---

## دسته ۱: باگ‌های امنیتی

### متوسط (Medium)

#### SEC-M1 — اعتبارسنجی سمت سرور برای session وجود نداره
- **فایل:** `src/utils.js`، `src/auth.js`
- **توضیح:** تمام بررسی‌های دسترسی سمت کلاینت هستن. Supabase RLS باید فعال باشه.

#### SEC-M2 — داده session در localStorage قابل تغییره
- **فایل:** `src/utils.js` خطوط ۱۷۴-۱۷۹
- **توضیح:** هر اسکریپتی (از جمله XSS) می‌تونه نقش و مجوزها رو تغییر بده.

#### SEC-M3 — کلید anon Supabase در کلاینت لو رفته
- **فایل:** `src/supabase.js` خط ۴
- **توضیح:** اگه RLS فعال نباشه، هر کسی می‌تونه مستقیماً به Supabase وصل بشه.

#### SEC-M4 — فایل `.env.local` شامل credential واقعیه
- **فایل:** `.env.local`
- **توضیح:** اگه اشتباهاً کامیت بشه، credential لو میره. (در gitignore هست ولی باید مراقب بود)

### پایین (Low)

#### SEC-L1 — پسورد در متغیر scope بیش از حد باقی می‌مونه
- **فایل:** `src/auth.js` خط ۸۲

#### SEC-L2 — `getCurrentUser()` خطای JSON parse رو سکوت می‌کنه
- **فایل:** `src/utils.js` خط ۱۷۰

#### SEC-L3 — حالت password در فرم لاگین بعد از موفقیت پاک نمیشه
- **فایل:** `src/auth.js` خطوط ۱۰۷-۱۰۸

---

## دسته ۲: باگ‌های داده‌ای و یکپارچگی

### بالا (High)

#### DATA-H1 — ذخیره مشتری جدید قبل از save به دیتابیس
- **فایل:** `src/customers.js` خط ۲۵۵ در مقابل ۳۱۳
- **توضیح:** `data.customers.push()` قبل از `saveCustomerToDB()` اجرا میشه. اگه save ناموفق باشه، مشتری در حافظه هست ولی در دیتابیس نیست.

#### DATA-H2 — `saveFollowupToDB()` رکورد تکراری ایجاد می‌کنه
- **فایل:** `src/data.js` خطوط ۱۰۴-۱۱۵
- **توضیح:** دابل‌کلیک روی ذخیره باعث ایجاد رکورد تکراری میشه. هیچ idempotency key وجود نداره.

#### DATA-H3 — شناسه‌های حذف شده مجدداً استفاده میشن
- **فایل:** `src/data.js` خطوط ۱۶۲-۱۶۹
- **توضیح:** اگه `LD0003` حذف بشه، `generateId('LD')` ممکنه دوباره `LD0003` تولید کنه.

#### DATA-H4 — `Promise.all` در loadData با خطا متوقف میشه
- **فایل:** `src/data.js` خطوط ۱۴-۱۸
- **توضیح:** اگه یکی از سه کوئری throw کنه، بقیه نادیده گرفته میشن.

#### DATA-H5 — پیگیری ویرایش/حذف با index آرایه شکننده‌ست
- **فایل:** `src/followups.js` خطوط ۳۹، ۵۳-۵۴، ۱۲۰، ۱۶۵
- **توضیح:** اگه آرایه بین رندر و کلیک تغییر کنه، index به رکورد اشتباهی اشاره می‌کنه.

#### DATA-H6 — indexOf برای پیگیری‌های تکراری مشکل‌سازه
- **فایل:** `src/followups.js` خط ۳۹
- **توضیح:** اگه دو پیگیری مقادیر یکسانی داشته باشن، indexOf همیشه اولی رو برمی‌گردونه.

#### DATA-H7 — `saveCustomerToDB()` بدون catch خطا
- **فایل:** `src/customers.js` خطوط ۴۹۵-۵۱۰، ۵۱۲-۵۲۲، ۵۲۴-۵۴۳، ۵۴۶-۵۵۵، ۵۷۴-۵۸۱
- **توضیح:** در چندین تابع، `saveCustomerToDB()` بدون try/catch صدا زده میشه.

#### DATA-H8 — شرایط رقابتی در ایمپورت — slice(-imported)
- **فایل:** `src/import-export.js` خط ۲۶۷
- **توضیح:** `data.customers.slice(-imported)` ممکنه مشتری‌های اشتباهی رو بگیره اگه آرایه تغییر کرده باشه.

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

### بالا (High)

#### A11Y-H1 — Tab pattern ARIA نداره
- **فایل:** `index.html` خطوط ۹۷-۱۰۳
- **توضیح:** `role="tablist"`، `role="tab"`، `role="tabpanel"`، `aria-selected` وجود نداره.

#### A11Y-H2 — Profile dropdown keyboard-accessible نیست
- **فایل:** `index.html` خطوط ۸۱-۹۲
- **توضیح:** `tabindex`، `role="menuitem"`، Enter/Space handler وجود نداره.

#### A11Y-H3 — Modal focus trap وجود نداره
- **فایل:** `src/main.js` خطوط ۱۸۷-۱۹۹
- **توضیح:** کاربر می‌تونه با Tab از مودال خارج بشه.

#### A11Y-H4 — Dashboard collapsible ها keyboard-accessible نیستن
- **فایل:** `index.html` خطوط ۱۵۸، ۱۷۳
- **توضیح:** `tabindex`، `role="button"`، `aria-expanded` وجود نداره.

#### A11Y-H5 — Toast `role="status"` و `aria-live` نداره
- **فایل:** `index.html` خط ۴۶۸

#### A11Y-H6 — Contrast ratio برای برخی رنگ‌ها کافی نیست
- **فایل:** `src/styles.css`
- **توضیح:** `.status-new` و `.status-cancelled` contrast کمتر از ۴.۵:۱ دارن.

### متوسط (Medium)

#### A11Y-M1 — `user-scalable=no` در صفحه لاگین
- **فایل:** `login.html` خط ۵

#### A11Y-M2 — Error message `role="alert"` نداره
- **فایل:** `login.html` خط ۱۲۱

#### A11Y-M3 — Label فیلدها `for` attribute نداره
- **فایل:** `login.html` خطوط ۱۱۹-۱۲۳

#### A11Y-M4 — Modal `aria-modal="true"` و `role="dialog"` نداره
- **فایل:** `index.html`

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
#### A11Y-L9 — Status badge contrast AA نداره
#### A11Y-L10 — نداشتن `<noscript>` fallback

---

## دسته ۵: باگ‌های کیفیت کد

### بالا (High)

#### QC-H1 — `window` بیش از حد暴露 شده (~۵۰ تابع)
- **فایل:** `src/main.js` خطوط ۹۰-۱۵۴

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

### مهم (در نسخه بعدی)
1. **DATA-H1** — ذخیره قبل از save
2. **DATA-H2** — رکورد تکراری
3. **DATA-H5** — index-based edit/delete
4. **DATA-H7** — catch خطا در saveCustomerToDB

### بهبود (backlog)
1. **UX-M1** — Sort indicator
2. **A11Y-H1** — Tab ARIA pattern
3. **A11Y-H3** — Modal focus trap
4. **QC-H1** — کاهش expose کردن window
