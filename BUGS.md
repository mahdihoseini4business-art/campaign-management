# گزارش جامع باگ‌های پروژه Campaign Management

> **تاریخ بررسی:** ۱۴۰۵/۰۴/۳۰  
> **وضعیت:** بررسی کامل تمام فایل‌ها  
> **تعداد کل باگ‌ها:** ۳۰

---

## خلاصه

| اولویت | تعداد |
|--------|-------|
| بحرانی (Critical) | ۲ |
| بالا (High) | ۸ |
| متوسط (Medium) | ۱۲ |
| پایین (Low) | ۸ |

---

## بحرانی (CRITICAL)

### C1 — `escapeHtml` در dashboard.js import نشده — نمودارها crash می‌کنند

**فایل:** `dashboard.js:116-132`  
**شرح:**  
تابع `escapeHtml` در خطوط ۱۱۶، ۱۱۷، ۱۱۸، ۱۳۰، ۱۳۱، ۱۳۲ استفاده شده اما در خط ۱ import نشده است. با رندر شدن لیست پیگیری‌های عقب افتاده یا نزدیک در داشبورد، خطای `ReferenceError: escapeHtml is not defined` رخ می‌دهد و کل داشبورد از کار می‌افتد.

**راه‌حل:**  
```js
import { hasPermission, formatNumber, jalaliToNum, getTodayJalaliNum, jalaliAddDays, getTodayJalaliStr, escapeHtml } from './utils.js'
```

---

### C2 — دکمه "بازنشانی رمز ادمین" در صفحه لاگین عمومی نمایش داده می‌شود

**فایل:** `index.html:35-37`  
**شرح:**  
هر کسی که به صفحه لاگین دسترسی داشته باشد می‌تواند روی دکمه "بازنشانی رمز ادمین" کلیک کند و رمز admin را به `admin123` ریست کند. این یک آسیب‌پذیری امنیتی بحرانی است.

**راه‌حل:**  
حذف دکمه از HTML و استفاده از console مرورگر یا اضافه کردن بررسی secret key.

---

## بالا (HIGH)

### H1 — `sortCustomers` و `sortFollowups` آرایه اصلی داده را in-place تغییر می‌دهند

**فایل:** `main.js:43-66,74-82`  
**شرح:**  
`data.customers.sort()` و `data.followups.sort()` آرایه اصلی در حافظه را تغییر می‌دهند. اگر render همزمان اتفاق بیفتد یا کاربر دیگری داده را تغییر دهد، ممکن است رفتار غیرمنتظره رخ دهد.

**راه‌حل:**  
```js
const sorted = [...data.customers].sort((a, b) => { ... })
```

---

### H2 — `saveCustomer` خطای `findIndex` ناموفق را مدیریت نمی‌کند

**فایل:** `customers.js:299`  
**شرح:**  
```js
await saveCustomerToDB(data.customers[data.customers.findIndex(c => c.id === (editId || data.customers[data.customers.length - 1].id))])
```
اگر `findIndex` مقدار `-1` برگرداند (مثلاً مشتری قبلاً حذف شده باشد)، `data.customers[-1]` برابر `undefined` است و `saveCustomerToDB(undefined)` خطا می‌دهد.

**راه‌حل:**  
ذخیره مشتری در متغیر جداگانه و بررسی قبل از save.

---

### H3 — `addQuickNote` نتیجه `saveFollowupToDB` را ذخیره نمی‌کند

**فایل:** `customers.js:517-518`  
**شرح:**  
```js
data.followups.push({ customerId, date: dateStr, type, result, nextDate: '', notes })
saveFollowupToDB({ customerId, date: dateStr, type, result, nextDate: '', notes })
```
آی‌دی برگشتی از `saveFollowupToDB` (که در data.js:114 return می‌شود) ذخیره نمی‌شود. پیگیری در حافظه بدون `id` باقی می‌ماند و بعداً برای ویرایش/حذف مشکل‌ساز می‌شود. همچنین `await` ندارد.

**راه‌حل:**  
```js
const id = await saveFollowupToDB({ ... })
newFollowup.id = id
```

---

### H4 — `saveFollowupToDB` در customers.js import نشده

**فایل:** `customers.js:1`  
**شرح:**  
`saveFollowupToDB` در خط ۱ import شده اما در `addQuickNote` (خط ۵۱8) استفاده می‌شود. اگر import وجود نداشته باشد، خطا می‌دهد. بررسی نشده آیا واقعاً import هست یا نه — ولی اگر باشد، مشکل `await` و `id` باقی است.

---

### H5 — `addProductRow`، `saveProductField`، `updateProduct`، `removeProduct` بدون `await` `setProducts` را فراخوانی می‌کنند

**فایل:** `customers.js:630,638,649,657`  
**شرح:**  
`setProducts` اکنون async است (خط ۵۷۰) اما هیچ‌کدام از فراخوانی‌هایش `await` ندارند. اگر ذخیره در دیتابیس ناموفق باشد، داده در حافظه تغییر کرده ولی در دیتابیس ذخیره نشده است.

**راه‌حل:**  
اضافه کردن `await` به تمام فراخوانی‌های `setProducts`.

---

### H6 — `updateFollowupsCustomerId` از الگوی delete+re-insert استفاده می‌کند

**فایل:** `data.js:143-161`  
**شرح:**  
هنگام تبدیل LD↔CS، تمام پیگیری‌های مشتری حذف و دوباره درج می‌شوند. در صورت قطع اینترنت یا خطا در مرحله insert، تمام پیگیری‌ها از بین می‌روند.

**راه‌حل:**  
استفاده از `update` برای تغییر `customer_id` به جای delete+insert.

---

### H7 — رمز عبور hardcoded با salt ثابت

**فایل:** `auth.js:12`  
**شرح:**  
```js
const salt = encoder.encode('campaign_manager_salt_2024')
```
Salt برای تمام کاربران یکسان است. اگر دیتابیس نشت کند، حمله rainbow table روی تمام رمزها امکان‌پذیر است.

**راه‌حل:**  
تولید salt منحصربفرد برای هر کاربر و ذخیره آن در دیتابیس.

---

### H8 — `deleteUser` از `window.confirm()` مرورگر استفاده می‌کند

**فایل:** `auth.js:181`  
**شرح:**  
با وجود مودال سفارشی `deleteModal` برای حذف مشتری و پیگیری، حذف کاربر از دیالوگ پیش‌فرض مرورگر استفاده می‌کند.

**راه‌حل:**  
استفاده از `deleteModal` مانند سایر حذف‌ها.

---

## متوسط (MEDIUM)

### M1 — `reRenderAll` تعریف شده ولی هیچجا فراخوانی نمی‌شود

**فایل:** `main.js:160-165`  
**شرح:**  
تابع `reRenderAll` تعریف شده ولی استفاده نمی‌شود. کد مرده.

**راه‌حل:**  
حذف تابع یا استفاده از آن بعد از import.

---

### M2 — `renderCustomers` دو بار اجرا می‌شود (اولی + setTimeout)

**فایل:** `main.js:218-229`  
**شرح:**  
`renderCustomers()` یک بار در خط ۲۱۸ و بار دیگر بعد از `setTimeout` 500ms اجرا می‌شود. رندر اضافی و فلش موقتی در UI ایجاد می‌کند.

**راه‌حل:**  
حذف `setTimeout` یا حذف فراخوانی اولیه.

---

### M3 — `toJalali` در customers.js تکراری است

**فایل:** `customers.js:524-540` و `utils.js:43-68`  
**شرح:**  
تابع `toJalali` در دو فایل با کد یکسان وجود دارد. نسخه `customers.js` فقط در `addQuickNote` استفاده می‌شود.

**راه‌حل:**  
حذف نسخه `customers.js` و import از `utils.js`.

---

### M4 — `jalaliToNum` برای تاریخ خالی مقدار sentinel `99999999` برمی‌گرداند

**فایل:** `utils.js:70-78`  
**شرح:**  
این مقدار می‌تواند در مقایسه‌ها و مرتب‌سازی‌ها رفتار غیرمنتظره ایجاد کند. مثلاً فروش‌های بدون تاریخ تسویه در انتهای لیست قرار می‌گیرند.

**راه‌حل:**  
返 null یا undefined به جای مقدار sentinel.

---

### M5 — `getTodayJalaliStr` از timezone محلی سیستم استفاده می‌کند

**فایل:** `utils.js:80-84`  
**شرح:**  
`new Date()` زمان محلی مرورگر را برمی‌گرداند. کاربران در مناطق زمانی مختلف تاریخ متفاوتی دریافت می‌کنند.

**راه‌حل:**  
استفاده از `timeZone: 'Asia/Tehran'` در `Intl.DateTimeFormat`.

---

### M6 — `formatNumber` عدد منفی را مدیریت نمی‌کند

**فایل:** `utils.js:11-16`  
**شرح:**  
`n.replace(/[^\d]/g, '')` علامت منفی را حذف می‌کند. اگر مانده حساب منفی باشد، علامت منفی از بین می‌رود.

**راه‌حل:**
```js
const num = typeof n === 'string' ? n.replace(/[^\d-]/g, '') : n
```

---

### M7 — فیلتر تاریخ داشبرد فروش‌های بدون تاریخ تسویه را حذف می‌کند

**فایل:** `dashboard.js:83`  
**شرح:**  
وقتی فیلتر تاریخ فعال است، فروش‌هایی که `settlementDate` ندارند توسط `inDateRange` رد می‌شوند.

**راه‌حل:**  
فروش‌های بدون تاریخ تسویه را از فیلتر تاریخ مستثنا کنید.

---

### M8 — `renderSales` و `sortSales` کد رندر را تکرار می‌کنند

**فایل:** `sales.js:106-141,168-202`  
**شرح:**  
کد HTML رندر فروش‌ها دقیقاً دو بار (در `renderSales` و `sortSales`) نوشته شده. هر تغییری باید در دو جا اعمال شود.

**راه‌حل:**  
استخراج تابع `renderSalesTable(sales)` مشترک.

---

### M9 — `openFollowupModal` نام مشتریان را escape نمی‌کند

**فایل:** `followups.js:71-74`  
**شرح:**  
```js
`<option value="${c.id}">${c.id} — ${c.name || c.platformId}</option>`
```
نام مشتری بدون `escapeHtml` در dropdown قرار می‌گیرد.

**راه‌حل:**
```js
`<option value="${c.id}">${c.id} — ${escapeHtml(c.name || c.platformId)}</option>`
```

---

### M10 — `saveUser` موفقیت/خطا را برنمی‌گرداند

**فایل:** `auth.js:36-39`  
**شرح:**  
```js
export async function saveUser(user) {
  const { error } = await supabase.from('users').upsert(user, { onConflict: 'username' })
  if (error) console.error('saveUser error:', error)
}
```
فقط `console.error` می‌زند و خطا را برنمی‌گرداند. caller نمی‌تواند بفهمد آیا ذخیره موفق بوده یا نه.

**راه‌حل:**  
throw کردن خطا یا برگرداندن `{ success, error }`.

---

### M11 — `init` در main.js `await` ناقص دارد

**فایل:** `main.js:218-221`  
**شرح:**  
`renderCustomers` با `await` اجرا می‌شود ولی `renderFollowups`، `renderSales`، `renderDashboard` بدون `await` هستند.

**راه‌حل:**  
اضافه کردن `await` به همه یا اطمینان از sync بودن.

---

### M12 — `deleteFollowup` آی‌دی پیگیری را بررسی نمی‌کند

**فایل:** `followups.js:140-153`  
**شرح:**  
```js
if (f.id) await deleteFollowupFromDB(f.id)
data.followups.splice(index, 1)
```
اگر `f.id` وجود نداشته باشد (پیگیری‌های قدیمی بدون id)، فقط از حافظه حذف می‌شود ولی در دیتابیس باقی می‌ماند.

**راه‌حل:**  
هشدار به کاربر یا تلاش برای حذف با معیارهای دیگر.

---

## پایین (LOW)

### L1 — کد مرده: `reRenderAll`

**فایل:** `main.js:160-165`  
**شرح:**  
تابع `reRenderAll` تعریف شده ولی هیچجا فراخوانی نمی‌شود.

**راه‌حل:**  
حذف تابع.

---

### L2 — `togglePermCheckbox` بدون پیشوند `window.` در HTML

**فایل:** `auth.js:206`  
**شرح:**  
```html
onchange="window.appTogglePermCheckbox(this)"
```
این اصلاح شده ولی تابع خودش فقط رنگ پس‌زمینه را تغییر می‌دهد و منطق اصلی در inline handler انجام می‌شود.

---

### L3 — `initProfileMenu` و modal close overlap دارند

**فایل:** `auth.js:300-306`, `main.js:192-196`  
**شرح:**  
هر دو listener روی `document` کلیک رصد می‌کنند. ممکن است هر دو همزمان اجرا شوند.

**راه‌حل:**  
استفاده از `stopPropagation`.

---

### L4 — Toast ها روی هم stacking نمی‌شوند

**فایل:** `utils.js:32-37`  
**شرح:**  
فقط یک toast element وجود دارد. پیام‌های سریع جایگزین قبلی می‌شوند.

**راه‌حل:**  
پیاده‌سازی queue یا استacking toast.

---

### L5 — موقعیت dropdown پروفایل در RTL

**فایل:** `styles.css:55`  
**شرح:**  
`left: 0` ممکن است در RTL مشکل‌ساز باشد.

**راه‌حل:**  
تغییر به `right: 0; left: auto;`.

---

### L6 — نشانگر loading در زمان لود اولیه وجود ندارد

**فایل:** `main.js:170-232`  
**شرح:**  
در زمان `loadData()` هیچ spinner یا skeleton UI نمایش داده نمی‌شود.

**راه‌حل:**  
اضافه کردن loading overlay.

---

### L7 — `formatNumber` edge case برای رشته خالی

**فایل:** `utils.js:11-16`  
**شرح:**  
اگر `n` رشته خالی `""` باشد، `replace` آن را به `""` تبدیل می‌کند و `isNaN("")` برابر `false` است (چون `Number("")` برابر `0` است). بنابراین `formatNumber("")` برابر `"0"` می‌شود نه `""`.

**راه‌حل:**  
اضافه کردن بررسی `if (num === '') return ''` بعد از replace.

---

### L8 — `escapeHtml` کاراکتر `>` را escape نمی‌کند (edge case)

**فایل:** `utils.js:27-30`  
**شرح:**  
`>` در HTML معتبر است ولی در برخی سناریوها ممکنه مشکل ایجاد کنه. فعلی فقط `&<>"'` را handle می‌کند که کافی است.

---

## خلاصه اولویت‌بندی برای رفع

### فوری (همین الان)
1. **C1** — import `escapeHtml` در dashboard.js (بدون این، داشبورد کار نمی‌کند)
2. **C2** — حذف دکمه ریست رمز ادمین از صفحه لاگین عمومی

### اول (قبل از پروداکشن)
3. **H1** — کپی آرایه قبل از sort
4. **H2** — مدیریت خطای findIndex
5. **H3** — ذخیره id پیگیری جدید
6. **H5** — اضافه کردن await به setProducts
7. **H6** — بهبود updateFollowupsCustomerId

### دوم (هفته آینده)
8. **H7, H8** — امنیت رمز عبور و جایگزینی confirm
9. **M1-M12** — رفع باگ‌های متوسط

### سوم (ماه آینده)
10. **L1-L8** — رفع باگ‌های پایین
