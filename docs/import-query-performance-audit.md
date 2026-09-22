# گزارش بهینه‌سازی سرعت ایمپورت و کوئری‌ها

تاریخ بررسی: ۲۰۲۶-۰۹-۲۲  
محدوده: مسیرهای ایمپورت/اکسپورت، ذخیره مشتری/پیگیری، تولید شناسه، بکاپ، و الگوهای دسترسی به داده در حافظه.

> این سند فقط **تحلیل و پیشنهاد** است؛ هنوز پیاده‌سازی نشده.

---

## خلاصه اجرایی

گلوگاه اصلی سرعت ایمپورت، **IndexedDB نیست**. نوشتن‌ها به **Supabase** می‌روند و در بیشتر جریان‌ها به‌صورت **یک درخواست شبکه به‌ازای هر ردیف/مشتری** انجام می‌شود.

| جریان | الگوی فعلی | وضعیت سرعت |
|--------|------------|------------|
| ایمپورت مشتری (`doImport`) | `await saveCustomerToDB` به‌ازای هر ردیف + اسکن خطی تلفن | خیلی کند |
| ایمپورت پیگیری | یک insert/update به‌ازای هر ردیف | خیلی کند |
| ایمپورت فروش | بعد از mutate، ذخیرهٔ ترتیبی هر مشتری لمس‌شده | کند |
| ایمپورت رویداد | تا ۲ upsert + `generateId` به‌ازای ردیف | خیلی کند |
| ایمپورت ماتریس | اندیس تلفن + `generateIdBatch` + بچ ۴۰ موازی | نسبتاً خوب (الگوی مرجع) |
| بکاپ restore | upsert بچ ۱۵۰ | خوب برای نوشتن؛ حذف هنوز یکی‌یکی |

**تخمین اثر** (۱۰۰۰ ردیف، RTT شبکه ~۸۰–۱۵۰ms): مسیرهای ترتیبی حدود **۱–۳+ دقیقه** فقط برای شبکه؛ با بچ ۱۰۰–۱۵۰ موازی/چانک، همان کار می‌تواند به **چند ثانیه تا ده–بیست ثانیه** نزدیک شود — بدون تغییر منطق merge/validation، اگر بچ‌بندی و اندیس‌گذاری درست انجام شود.

---

## معماری نوشتن (برای رفع سوءتفاهم)

```
فایل Excel/CSV
    → parse (SheetJS / FileReader)     [یک‌بار، CPU]
    → match در RAM (customers[])       [اسکن یا Map]
    → supabase.from(...).upsert/insert [شبکه — گلوگاه]
    → (اختیاری) invalidate cache / level resync
```

- `src/data-cache.js` فقط اسنپ‌شات بوت است؛ مسیر ایمپورت ردیف‌به‌ردیف آنجا نمی‌نویسد.
- `saveCustomerToDB` در `src/data.js` یک `upsert` تکی روی `customers` است (با چند fallback اسکیما).

---

## یافته‌ها (مرتب‌شده بر اساس اولویت)

### P0 — اثر بالا، ارزش پیاده‌سازی فوری

#### 1) ذخیرهٔ ترتیبی مشتری بدون API بچ

- **کجا:** `saveCustomerToDB` → `data.js` (~۳۰۴۳–۳۱۱۸)؛ مصرف در `doImport`، ذخیرهٔ فروش، رویدادها.
- **مشکل:** هر فراخوانی = حداقل یک RTT به Supabase + payload کامل (`products` JSON و فیلدها) + `invalidateProductSalesCountCache()` در هر موفقیت.
- **الگوی موجود در پروژه:** `backup/backup-apply.js` با `UPSERT_CHUNK = 150` و `upsert(chunk)`.
- **پیشنهاد امن:** افزودن `saveCustomersToDBBatch(customers, options)` که همان ساخت ردیف را انجام دهد و `upsert` را در چانک‌های ۱۰۰–۱۵۰ بزند؛ یک‌بار invalidate در پایان چانک. منطق merge ردیف‌ها قبل از بچ در RAM بماند (مثل ماتریس).
- **ریسک دقت:** کم، اگر قبل از upsert همان merge فعلی روی آبجکت‌های کش اعمال شود و `onConflict: 'id'` حفظ شود.

#### 2) اسکن خطی تلفن/شناسه در ایمپورت مشتری و فروش

- **کجا:** `doImport` (~۱۷۳۱–۱۷۴۱)؛ `findCustomerByPhone` در `utils.js` (~۱۰۰۲–۱۰۰۸) با `.find` روی کل آرایه.
- **مشکل:** برای هر ردیف تا چند بار O(C) روی کل مشتریان → CPU روی دیتای بزرگ قبل از شبکه هم سنگین می‌شود.
- **الگوی موجود:** `buildPhoneIndex` + Map در ماتریس (~۳۲۷۸) و رویدادها (~۷۹۵–۸۰۱).
- **پیشنهاد امن:** یک‌بار قبل از حلقه: `Map(id)`، `buildPhoneIndex`، `Map(platformId.lower)`؛ حین ایجاد مشتری جدید Mapها را به‌روز کن.
- **ریسک دقت:** کم — همان قوانین match فعلی (id → phone → platformId).

#### 3) `generateId` به‌ازای هر ایجاد جدید = ۲+ round-trip

- **کجا:** `getNextIdNumber` / `generateId` در `data.js` (~۴۶۴۷–۴۶۸۷)؛ مصرف در `doImport` (~۱۷۶۷)، فروش، رویدادها (~۸۷۳).
- **مشکل:** هر بار همهٔ idهای با پیشوند `CS%`/`LD%` از DB خوانده می‌شود + آپدیت کانتر تنظیمات.
- **الگوی موجود:** `generateIdBatch` در ماتریس (~۳۳۴۷–۳۳۴۸).
- **پیشنهاد امن:** شمارش/جمع‌آوری موارد جدید در فاز اول، یک `generateIdBatch`، سپس تخصیص id.
- **ریسک دقت:** کم اگر رزرو بلاک قبل از نوشتن باشد و برخورد mid-import مثل گارد فعلی چک شود.

#### 4) ایمپورت رویداد: تا دو ذخیره برای یک مشتری

- **کجا:** `applyEventRosterImport` در `events.js` (~۷۸۷–۱۰۰۳)؛ `assignInPersonSessionToSale` در `data.js` (~۱۹۹۱) خودش `saveCustomerToDB` می‌زند؛ بعد دوباره (~۹۹۵) اگر `dirty`.
- **مشکل:** برای تخصیص سانس + آپدیت نام/فروش جدید، دو upsert پشت سر هم رایج است؛ به‌علاوه `generateId` تکی برای مشتری جدید.
- **پیشنهاد امن:** تغییر در حافظه (map سانس / push محصول / نام) و **یک** `saveCustomerToDB` در پایان ردیف؛ یا مسیر اختصاصی «mutate بدون save» برای assign. سپس بچ‌بندی ذخیرهٔ مشتریان dirty.
- **ریسک دقت:** متوسط — باید invariantهای `assertSaleCanUseInPersonSession` و قوانین ظرفیت سانس قبل از نوشتن حفظ شوند (همان چک‌ها، فقط نقطهٔ persist جابه‌جا شود).

---

### P1 — اثر متوسط–بالا

#### 5) ایمپورت پیگیری: یک statement به‌ازای هر ردیف

- **کجا:** `importFollowupRows` در `import-export.js` (~۱۰۱۹–۱۱۴۷)؛ `saveFollowupToDB` / `updateFollowupInDB`.
- **پیشنهاد:** `insert` چندردیفی برای موارد جدید؛ آپدیت‌ها در چانک یا حداقل موازی محدود؛ Map برای `customerId → customer`؛ به‌روزرسانی `nextFollowupDate` مشتری‌ها در یک بچ upsert جدا.
- **ریسک دقت:** کم برای insert؛ برای update باید id و fingerprint تکراری مثل الان حفظ شود.

#### 6) بعد از ایمپورت مشتری: resync سطح همه + persist ترتیبی

- **کجا:** `doImport` (~۱۸۱۰–۱۸۱۳) → `resyncAndPersistCustomerLevels` → `persistCustomerLevels` یکی‌یکی (`customer-level-sync.js` ~۱۰۹–۱۳۳).
- **پیشنهاد:** فقط روی idهای لمس‌شده؛ یا `scheduleCustomerLevelResyncForIds` غیرمسدود؛ در صورت نیاز بچ روی `saveCustomerLevelFieldsToDB`.
- **ریسک دقت:** کم اگر CIP/referral بعد از import هنوز روی همان مجموعهٔ مرتبط محاسبه شود.

#### 7) `syncCustomerLevel` بدون override ارجاعات = اسکن O(C)

- **کجا:** فراخوانی‌های ایمپورت در `import-export.js`؛ منطق در `utils.js` (~۶۸۱+).
- **پیشنهاد:** مثل full resync، `getReferralCountForCustomer` / نقشهٔ followup از قبل ساخته شود.
- **ریسک دقت:** کم.

#### 8) `await job.paint()` خیلی پرتکرار

- **کجا:** مشتری هر ۵ ردیف؛ فروش هر ۳ ذخیره؛ ماتریس هر بچ.
- **مشکل:** `paint` = دو `requestAnimationFrame` → تأخیر مصنوعی روی حلقهٔ شبکه.
- **پیشنهاد:** تکیه بر throttle داخلی `job.set` (~۱۰۰ms)؛ `paint` فقط در مرز فاز (شروع parse، شروع ذخیره، پایان).
- **ریسک دقت:** صفر (فقط UX پیشرفت کمی درشت‌تر می‌شود).

#### 9) ایمپورت فروش: ذخیره ترتیبی بعد از merge خوب در RAM

- **کجا:** حلقهٔ ذخیره ~۲۷۰۴–۲۷۱۸.
- **نکتهٔ مثبت:** اول mutate، بعد ذخیرهٔ unique touched — از نظر منطقی درست است.
- **پیشنهاد:** همان بچ موازی ماتریس (۴۰ یا نزدیک ۱۵۰ بکاپ) + `generateIdBatch` + اندیس تلفن در حلقهٔ ردیف.
- **ریسک دقت:** کم.

---

### P2 — اثر متوسط / جانبی

#### 10) Parse فایل SheetJS روی کل workbook

- یک‌بار در هر ایمپورت؛ معمولاً کوچک‌تر از هزینهٔ شبکه است.
- پیشنهاد: برای فایل خیلی بزرگ ترجیح CSV؛ کش ردیف‌ها (رویدادها تا حدی دارد).

#### 11) Dry-run / analyze با همان اسکن خطی تلفن

- پیش‌نمایش را کند می‌کند؛ همان Maps کمک می‌کند.

#### 12) اکسپورت: `customers.find` به‌ازای هر فروش/پیگیری + گروه‌بندی followup

- برای خروجی‌های بزرگ: `Map(id→customer)` و گروه‌بندی یک‌بارهٔ followups.
- اثر روی «کندی ایمپورت» مستقیم نیست؛ روی UX خروجی مفید است.

#### 13) بکاپ: حذف یکی‌یکی، upsert خوب

- `backup-apply.js`: حذف در حلقهٔ تکی؛ upsert چانک ۱۵۰.
- پیشنهاد بعدی: `.delete().in(pk, ids)` در صورت امنیت RLS/FK.

#### 14) `invalidateProductSalesCountCache` در هر save

- در طوفان ایمپورت: یک‌بار در پایان بچ کافی است.

---

## مقایسهٔ الگوهای موجود در ریپو (الگوی طلایی)

ماتریس از قبل سه کار درست را انجام می‌دهد:

1. اندیس تلفن قبل از حلقه  
2. `generateIdBatch` یک‌بار  
3. `Promise.all` روی بچ ۴۰

بکاپ restore برای نوشتن حتی بهتر است (چانک ۱۵۰ روی یک `upsert` آرایه‌ای).

**نتیجه:** نیاز به معماری جدید نیست؛ باید الگوی ماتریس/بکاپ به بقیهٔ ایمپورت‌ها گسترش یابد.

---

## تخمین فراخوانی‌ها برای ~۱۰۰۰ ردیف

| عملیات | مشتری | فروش | ماتریس | رویداد | پیگیری |
|--------|-------|------|--------|--------|--------|
| اسکن تلفن/find | ~۱۰۰۰–۳۰۰۰ | ~۱۰۰۰ | ۰ (Map) | ۰ (Map) | ~۱۰۰۰ (id) |
| `generateId` تکی | ~N جدید | ~N | ۰ | ~N | ۰ |
| `generateIdBatch` | ۰ | ۰ | ۱ | ۰ | ۰ |
| `saveCustomerToDB` | ~۱۰۰۰ | ~U | ~U (موازی ۴۰) | ~dirty (+ assign) | ≤۱۰۰۰ (nextDate) |
| followup write | ۰ | ۰ | ۰ | ۰ | ≤۱۰۰۰ |
| `job.paint` await | ~۲۰۰ | ~U/۳ | ~U/۴۰ | کم | ۰ |

`N` = تعداد ایجاد جدید، `U` = مشتریان یکتای لمس‌شده، `C` = کل مشتریان در RAM.

---

## نقشهٔ پیاده‌سازی پیشنهادی (وقتی تأیید شد)

### فاز A — زیرساخت مشترک (بدون تغییر UX ظاهری) ✅ پیاده‌سازی‌شده

1. `saveCustomersToDBBatch` (+ `CUSTOMER_UPSERT_CHUNK` / `deferInvalidate` / `skipInvalidate`) در `src/data.js`
2. هلپر `buildCustomerMatchIndexes` (+ `registerCustomerInMatchIndexes` / `matchCustomerFromIndexes`) در `src/utils.js`
3. استاندارد پیشرفت: `reportJobRowProgress` / `reportJobPhase` / `JOB_PROGRESS_EVERY_N` در `src/job-progress.js` (بدون paint در حلقهٔ تنگ)

### فاز B — اتصال به جریان‌های کند ✅ پیاده‌سازی‌شده

1. `doImport` + analyze/dry-run: ایندکس + بچ upsert + `generateIdBatch`  
2. `doSalesImport`: ایندکس + batch id + بچ ذخیره  
3. `applyEventRosterImport`: یک persist per customer + batch id + بچ  
4. `importFollowupRows`: insert بچ + Map مشتری  

### فاز C — جلای بعد از نوشتن ✅ پیاده‌سازی‌شده

1. level resync فقط برای touched ids + referrerهای CIP / پس‌زمینه (`scheduleCustomerLevelResyncAfterImport`)  
2. کاهش invalidateهای میانی (`runWithDeferredProductSalesCacheInvalidation`)  
3. حذف بچ در backup restore (`.in(pk, ids)` برای کلید ساده؛ مرکب یکی‌یکی)  

### خارج از scope پیشنهادی این بهینه‌سازی

- تغییر قوانین merge/validation ایمپورت  
- موازی‌سازی کور بدون بچ‌بندی کنترل‌شده  
- جایگزینی `#loadingOverlay` اپ  
- ایندکس یونیک تلفن در Postgres (مدل فعلی match در RAM است)

---

## معیار پذیرش بعد از پیاده‌سازی (پیشنهادی)

- ایمپورت مشتری ۱۰۰۰ ردیفی: بدون کاهش دقت match، زمان wall-clock حداقل **~۵–۱۰×** بهتر از baseline ترتیبی (بسته به RTT).  
- هیچ double-submit / از دست رفتن پیشرفت job.  
- لغو همچنان بین بچ‌ها تمیز بماند (نه وسط یک upsert اتمی چانک — یا چانک کوچک‌تر برای cancel سریع‌تر).  
- تست رگرسیون: dry-run vs apply، برخورد تلفن، id وارداتی، رویداد با assign سانس، ماتریس تاریخی.

---

## فایل‌های اصلی مرتبط

| فایل | نقش |
|------|-----|
| `src/import-export.js` | حلقه‌های ایمپورت/اکسپورت |
| `src/events.js` | `applyEventRosterImport` |
| `src/data.js` | `saveCustomerToDB`, `generateId*`, assign سانس |
| `src/utils.js` | `findCustomerByPhone`, `syncCustomerLevel` |
| `src/customer-level-sync.js` | resync/persist سطح |
| `src/backup/backup-apply.js` | الگوی بچ upsert مرجع |
| `src/job-progress.js` | throttle/`paint` پیشرفت |

---

## جمع‌بندی یک‌خطی

کندی عمدتاً از **RTTهای ترتیبی Supabase + تولید id تکراری + اسکن خطی در RAM** است؛ ماتریس و بکاپ نشان می‌دهند راه امن سریع‌تر از قبل در همین ریپو وجود دارد — باید همان الگو را به مشتری/فروش/رویداد/پیگیری تعمیم داد.
