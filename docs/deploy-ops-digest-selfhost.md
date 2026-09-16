# دیپلوی خلاصه روزانه (ops-digest) — self-hosted

مسیر سریع روی سرور Supabase (همان هاستی که `/opt/supabase-project` دارد).

## ۱) یک فرمان روی سرور

```bash
cd /opt/supabase-project
# اگر اسکریپت را از ریپو می‌خواهید (همیشه آخرین main):
curl -fsSL -o /tmp/deploy-edge-functions-selfhost.sh \
  https://raw.githubusercontent.com/mahdihoseini4business-art/campaign-management/main/scripts/deploy-edge-functions-selfhost.sh
bash /tmp/deploy-edge-functions-selfhost.sh
```

این اسکریپت:

- همه Edge Functionها از جمله `ops-digest-cron` را در `volumes/functions` کپی می‌کند
- migration `040` (ستون‌های digest) و `044` (SMS) را روی DB اجرا می‌کند
- کانتینر `functions` را ری‌استارت می‌کند

## ۲) تست دستی (روی همان سرور)

```bash
# باید JSON با success:true برگردد (حتی اگر sent:0)
curl -sS -X POST 'http://127.0.0.1:8000/functions/v1/ops-digest-cron?kind=morning' \
  -H "x-cron-secret: $CRON_SECRET"
```

اگر `unauthorized` → مقدار `CRON_SECRET` در env فانکشن‌ها ست نیست.  
اگر `migration_040_required` → SQL `040` اجرا نشده (اسکریپت را دوباره بزن یا دستی در psql).

## ۳) زمان‌بندی (اختیاری ولی توصیه‌شده)

با crontab روی سرور (ساعت به UTC؛ معادل تهران):

```cron
# 08:00 تهران ≈ 04:30 UTC
30 4 * * * curl -sS -X POST 'http://127.0.0.1:8000/functions/v1/ops-digest-cron?kind=morning' -H "x-cron-secret: YOUR_CRON_SECRET" >/dev/null
# 18:00 تهران ≈ 14:30 UTC
30 14 * * * curl -sS -X POST 'http://127.0.0.1:8000/functions/v1/ops-digest-cron?kind=evening' -H "x-cron-secret: YOUR_CRON_SECRET" >/dev/null
```

## ۴) فرانت (Liara)

حتماً یک دیپلوی تازه از `main` بزنید. از این نسخه با **باز کردن اپ** هم خلاصه ساخته می‌شود حتی اگر cron دیر ست شود.

## تست نهایی محصول

با کاربری که فالوآپ معوق یا سررسید امروز دارد وارد شوید → زنگوله باید «خلاصه صبح» را نشان دهد.
