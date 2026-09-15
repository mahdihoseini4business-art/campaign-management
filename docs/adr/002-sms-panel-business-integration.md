# ADR 002 — اتصال پنل پیامک به ماژول‌های کسب‌وکار

**وضعیت:** پیشنهادی (طراحی — هنوز پیاده‌سازی نشده)  
**تاریخ:** 2026-09-15 · به‌روزرسانی: 2026-09-15  
**مرتبط:** ADR 001 (امنیت و چندمستأجری)، `send-otp`، تنظیمات «پنل پیامک»، `ALL_PERMISSIONS`

## زمینه

امروز پیامک فقط برای **OTP ورود** از Edge Function `send-otp` و secrets سروری `SMS_*` استفاده می‌شود. UI تنظیمات پنل پیامک در اپ وجود دارد، اما برای ارسال کسب‌وکاری مسیر ارسال، قالب، لاگ، سقف مصرف، **سوییچ قابلیت** و **دسترسی کاربری** تعریف نشده است.

نیاز کسب‌وکار (نسخهٔ نهایی این ADR):

| بخش | کاربرد |
|-----|--------|
| **ارسالی‌ها** | ۱) پیام خودکار هنگام ورود به صف ارسال پس از تأیید حسابداری ۲) پیام پس از تأیید ارسال + کد رهگیری |
| **فروش‌ها** | طراح متن (الگو یا دستی)؛ ارسال تکی و گروهی شخصی‌سازی‌شده (مثلاً همه بدهکاران با `{balance}` خودشان) |
| **مشتریان** | کمپین پارامتری با الگو/دستی و شیوه‌های ارسال فوری / زمان‌بندی / قطره‌ای |
| **فالوآپ‌ها** | زمان‌بندی پیام هم‌زمان با موعد پیگیری بعدی؛ ارسال دسته‌ای به مشتریان فالوآپ‌دار |
| **تنظیمات SMS** | روشن/خاموش کردن **تک‌تک** این قابلیت‌ها + دادن دسترسی به کاربران مشخص |

## تصمیم‌های معماری

### ۱) یک لایه ارسال واحد روی سرور

- Edge Function جدید: **`send-sms`** (جدا از `send-otp`).
- OTP همچنان فقط از `send-otp` و `SMS_*` پلتفرم.
- همهٔ ارسال‌های کسب‌وکار از `send-sms`: JWT → عضویت tenant → **feature flag سازمانی** → **مجوز کاربر** → سقف روزانه → رندر قالب → Melipayamak → `sms_logs`.

```
UI (ارسالی / فروش / مشتری / فالوآپ / تنظیمات)
        │
        ▼
  src/sms-business.js  →  supabase.functions.invoke('send-sms')
        │
        ▼
  Edge: auth → featureOn? → permission? → quota → render → provider → logs
```

### ۲) دو لایه کنترل دسترسی (الزامی)

هر قابلیت پیامک با **هر دو** شرط زیر فعال است؛ قطع هر کدام UI و Edge را مسدود می‌کند.

| لایه | کجا ست می‌شود | چه کسی | اثر |
|------|----------------|--------|-----|
| **سوییچ سازمانی (feature)** | تنظیمات → ارتباطات → پنل پیامک | ادمین سازمان (`sms_manage`) | قابلیت برای کل سازمان خاموش/روشن |
| **مجوز کاربر (permission)** | مدیریت کاربران (چک‌باکس‌های موجود + گروه «پیامک») | ادمین سازمان | فقط کاربران دارای کلید مربوطه CTA/ارسال می‌بینند |

قانون سرور (غیرقابل دور زدن از UI):

```
canSend(kind) =
  sms_features[kind] === true
  AND user.permissions[sms_perm_for(kind)] === true
  AND (template.enabled اگر از قالب استفاده شود)
  AND within_daily_quota
```

خودکارها (صف ارسال، کرون فالوآپ) هم بدون سوییچ روشن و بدون مجوز کاربر تریگرکننده (یا نقش سیستمی کرون با بررسی سوییچ) ارسال نمی‌شوند.

### ۳) اعتبارنامه SMS

| حالت | منبع | کاربرد |
|------|------|--------|
| **پلتفرم** (پیش‌فرض) | `SMS_*` env | OTP + tenant بدون پنل اختصاصی |
| **سازمانی** | secrets سروری per-tenant | پنل ملی‌پیامک خود سازمان |

پسورد هرگز در `app_settings` کلاینت‌خوان ذخیره نمی‌شود.

### ۴) سقف مصرف

- `sms_daily_limit_trial|gold|diamond` برای ارسال کسب‌وکار **اجرا** می‌شود.
- OTP از سقف کسب‌وکار جدا است.

---

## سوییچ‌های سازمانی در تنظیمات SMS

ذخیره در `app_settings` با کلید `sms_features` (jsonb، بدون secret):

```json
{
  "shipment_queued": true,
  "shipment_shipped": true,
  "sales_single": true,
  "sales_group_debtors": true,
  "customer_single": true,
  "customer_campaign": true,
  "followup_on_schedule": true,
  "followup_bulk": true,
  "templates_edit": true,
  "history_view": true
}
```

UI در همان pane «پنل پیامک» (گسترش‌یافته)، بخش **«قابلیت‌ها»**: برای هر ردیف یک toggle روشن/خاموش + توضیح کوتاه.

| کلید سوییچ | معنی وقتی خاموش است |
|------------|---------------------|
| `shipment_queued` | بعد از تأیید حسابداری پیام صف ارسال نمی‌رود؛ دکمه ارسال مجدد صف مخفی |
| `shipment_shipped` | مودال تأیید ارسال گزینه پیامک رهگیری ندارد |
| `sales_single` | composer تکی فروش/مانده مخفی |
| `sales_group_debtors` | ارسال گروهی به بدهکاران مخفی |
| `customer_single` | ارسال تکی از پروفایل مشتری مخفی |
| `customer_campaign` | ویزارد کمپین مخفی |
| `followup_on_schedule` | چک‌باکس «پیامک در موعد پیگیری» مخفی؛ schedule جدید ساخته نمی‌شود |
| `followup_bulk` | ارسال دسته‌ای به صف فالوآپ مخفی |
| `templates_edit` | ویرایش قالب‌ها فقط برای دارندگان مجوز + سوییچ |
| `history_view` | تب تاریخچه پیامک مخفی |

پیش‌فرض پس از migration: همه `true` تا ادمین آگاهانه قطع کند. OTP از این سوییچ‌ها مستقل است و همیشه از مسیر ورود کار می‌کند.

---

## مجوزهای کاربری (گروه «پیامک»)

افزودن به [`ALL_PERMISSIONS` / `PERMISSION_GROUPS`](src/utils.js) — همان الگوی چک‌باکس مدیریت کاربران:

| کلید | برچسب | متناظر سوییچ |
|------|--------|--------------|
| `sms_manage` | مدیریت تنظیمات و قالب‌های پیامک | `templates_edit` (+ ذخیره سوییچ‌ها و اتصال پنل) |
| `sms_history` | مشاهده تاریخچه پیامک | `history_view` |
| `sms_shipment_queued` | پیامک صف ارسالی | `shipment_queued` |
| `sms_shipment_shipped` | پیامک تأیید ارسال و رهگیری | `shipment_shipped` |
| `sms_sales_single` | پیامک فروش تکی (الگو/دستی) | `sales_single` |
| `sms_sales_group` | پیامک گروهی بدهکاران | `sales_group_debtors` |
| `sms_customer_single` | پیامک تکی به مشتری | `customer_single` |
| `sms_customer_campaign` | کمپین پیامکی مشتریان | `customer_campaign` |
| `sms_followup_schedule` | زمان‌بندی پیامک روی موعد فالوآپ | `followup_on_schedule` |
| `sms_followup_bulk` | پیامک دسته‌ای به فالوآپ‌دارها | `followup_bulk` |

ادمین اصلی سازمان (`isMainAdmin`) مثل بقیه مجوزها همه را دارد.

ارسال خودکار صف ارسالی از `approvePayment`: کاربر حسابدار باید `sms_shipment_queued` داشته باشد **یا** سیستم با هویت «system/auto» فقط وقتی سوییچ سازمان روشن است و یک `triggered_by` اختیاری ثبت می‌کند — تصمیم قطعی: **خودکار فقط به سوییچ سازمانی وابسته است**؛ مجوز برای CTA دستی/ارسال مجدد لازم است. دلیل: حسابدار نباید مجبور به گرفتن مجوز SMS شود تا چرخه سفارش بشکند؛ قطع کردن از تنظیمات SMS کافی است.

---

## مدل داده

### `sms_templates`

| ستون | توضیح |
|------|--------|
| `id`, `tenant_id` | |
| `key` | `shipment_queued`, `shipment_shipped`, `sale_balance`, `customer_campaign`, `followup_due`, `followup_bulk`, … |
| `name`, `body` | فارسی + placeholder |
| `enabled` | خاموش کردن یک قالب بدون قطع کل قابلیت |
| `updated_at` | |

**Placeholderها:** `{customer_name}`, `{phone}`, `{product_name}`, `{tracking_code}`, `{balance}`, `{total_balance}`, `{followup_date}`, `{advisor}`, `{org_name}`, `{session_label}`, `{session_time}`

### `sms_logs`

`kind`: `shipment_queued` | `shipment_shipped` | `sale_single` | `sale_group` | `customer_single` | `customer_campaign` | `followup_schedule` | `followup_bulk`  
+ `status`, `body`, `to_phone`, `customer_id`, `triggered_by`, `meta`

### `sms_campaigns`

`filter`, `body` / `template_key`, `mode` = `immediate` | `scheduled` | `drip`, شمارنده‌ها، `send_at` / `drip_interval_min` / `drip_batch_size`

### `sms_schedules`

برای فالوآپ تکی و کمپین زمان‌دار؛ `send_at`, `status`, لینک به `customer_id` / `campaign_id`

### فلگ روی خط محصول (JSON)

`smsQueuedAt`, `smsShippedAt` برای idempotency پیام‌های ارسالی.

---

## اتصال به بخش‌ها

### الف) ارسالی‌ها

| مرحله | تریگر | قالب | شرط |
|--------|--------|------|------|
| صف ارسال | `approvePayment` / `approveGiftSale` وقتی خط فیزیکی تازه `isEligibleForShipment` شد | `shipment_queued` — متن پیش‌فرض: «سفارش شما در صف ارسال آکادمی کارنو قرار گرفت» | سوییچ `shipment_queued` |
| ارسال شد | `confirmShipment` + کد رهگیری | `shipment_shipped` | سوییچ + مجوز `sms_shipment_shipped` برای چک‌باکس/ارسال مجدد |

### ب) فروش‌ها

Composer: الگو **یا** متن دستی؛ پیش‌نمایش؛ تکی یا گروهی بدهکاران با رندر per-گیرنده.  
سوییچ/مجوز جدا برای تکی و گروهی.

### ج) مشتریان

- تکی: پروفایل → الگو/دستی  
- کمپین: فیلتر مخاطب + متن پارامتری + شیوه **فوری / زمان‌بندی / قطره‌ای**  
سوییچ/مجوز جدا.

### د) فالوآپ‌ها

- هنگام `setNextFollowup`: چک‌باکس «ارسال پیامک اطلاع در موعد» + الگو/متن → `sms_schedules` با تاریخ موعد + ساعت پیش‌فرض قابل تنظیم در تنظیمات SMS  
- bulk روی فیلتر today/waiting/overdue  
- تغییر/پاک کردن موعد → cancel scheduleهای pending  
سوییچ/مجوز جدا.

---

## UI تنظیمات «پنل پیامک» (ساختار نهایی)

1. **اتصال** — وضعیت پنل، تست ارسال (موجود، اصلاح‌شده)  
2. **قابلیت‌ها** — toggle تک‌تک ویژگی‌ها (جدول بالا)  
3. **ساعت پیش‌فرض فالوآپ** — برای schedule روی تاریخ بدون ساعت  
4. **قالب‌ها** — ویرایش متن هر کلید + فعال/غیرفعال قالب  
5. **تاریخچه** — `sms_logs`  
6. **کمپین‌ها** — لیست و پیشرفت  

دسترسی کاربران در UI موجود «مدیریت کاربران» با گروه جدید **پیامک** (نه فقط داخل pane SMS)؛ داخل pane SMS یک لینک راهنما: «دسترسی کاربران از مدیریت کاربران → گروه پیامک».

---

## قرارداد `send-sms` (خلاصه)

ورودی شامل `kind` متناظر سوییچ‌ها؛ Edge قبل از ارسال:

1. feature flag سازمان را از `app_settings.sms_features` می‌خواند  
2. برای kindهای دستی، permission کاربر را چک می‌کند  
3. برای auto `shipment_queued` فقط feature flag  
4. سقف روزانه، رندر، ارسال، لاگ  

`preview` بدون کسر سهمیه و بدون نیاز به همه مجوزهای ارسال (ولی نیاز به یکی از مجوزهای همان دامنه یا `sms_manage`).

---

## فازبندی

### فاز ۰ — زیرساخت + کنترل دسترسی

- Migration: جداول + seed قالب + `sms_features` پیش‌فرض  
- کلیدهای `ALL_PERMISSIONS` / گروه پیامک در UI کاربران  
- Edge `send-sms` با چک feature+permission+quota  
- UI تنظیمات: قابلیت‌ها، قالب‌ها، تاریخچه ساده  

### فاز ۱

- ارسالی: صف (auto) + رهگیری  
- فروش: composer تکی و گروهی بدهکاران  

### فاز ۲

- کمپین مشتریان (فوری/زمان‌دار/قطره‌ای)  
- فالوآپ schedule + bulk  
- کرون  

### فاز ۳

- پنل SMS اختصاصی tenant، گزارش سوپرادمین، retry، offline stub  

---

## نقاط قلاب کد

| محل | فایل |
|-----|------|
| سوییچ‌ها + قالب UI | `index.html` pane sms، `src/auth.js` |
| مجوزها | `src/utils.js` → `ALL_PERMISSIONS`, `PERMISSION_GROUPS` |
| صف ارسال auto | `src/accounting.js` → پس از approve |
| رهگیری | `src/shipments.js` → confirmShipment |
| فروش | `src/sales.js` / کارت محصول `customers.js` |
| کمپین / تکی مشتری | `src/customers.js` |
| فالوآپ | `src/customers.js` `setNextFollowup`، `src/followups.js` |
| کلاینت مشترک | `src/sms-business.js` (جدید) |
| Edge | `supabase/functions/send-sms` |

---

## ریسک‌ها

1. دو لایه کنترل اشتباه گرفته نشود: **سوییچ = کل سازمان**، **مجوز = فرد**.  
2. پیام auto صف ارسال بدون مجوز حسابدار؛ فقط با سوییچ قطع می‌شود.  
3. Idempotency با `smsQueuedAt` / `smsShippedAt`.  
4. اسپم کمپین: سقف روزانه + drip + مجوز جدا `sms_customer_campaign`.  

## خارج از محدوده

- واتساپ / کانال غیر SMS  
- پنل غیر Melipayamak/SmartSMS  
- جدول orders جدا از `customers.products`
