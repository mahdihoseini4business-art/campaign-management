# راهنمای مهاجرت از localStorage به دیتابیس

## خلاصه پروژه
پروژه یک فایل HTML تکی (`digital-marketing-sheet.html`) هست که تمام داده‌ها رو در `localStorage` مرورگر ذخیره می‌کنه. برای دیپلوی روی سرور و پشتیبانی از چند کاربر همزمان، باید به دیتابیس سمت سرور مهاجرت کنه.

---

## ساختار فعلی داده‌ها (3 کلید localStorage)

| کلید | محتوا | توابع |
|---|---|---|
| `campaign_manager_data` | مشتریان، پیگیری‌ها، شمارنده، آمار تبدیل | `loadData()`, `saveData()` |
| `campaign_manager_users` | لیست کاربران (نام کاربری، رمز هش‌شده، نام نمایشی، نقش، دسترسی‌ها) | `getUsers()`, `saveUsers()` |
| `campaign_manager_session` | کاربر جاری (لاگین/لاگاوت) | `getCurrentUser()`, `setCurrentUser()`, `clearCurrentUser()` |

---

## توابعی که باید تغییر کنند (7 تابع)

### 1. `loadData()` (خط ~1507)
- **فعلی:** `localStorage.getItem(STORAGE_KEY)` + fallback به داده نمونه
- **تغییر:** فراخوانی API سمت سرور (مثلاً `GET /api/data`)
- **خروجی:** آبجکت `{ customers, followups, nextId, convertedCount }`

### 2. `saveData()` (خط ~1545)
- **فعلی:** `localStorage.setItem(STORAGE_KEY, JSON.stringify(data))`
- **تغییر:** فراخوانی API سمت سرور (مثلاً `POST /api/data`)
- **ورودی:** آبجکت `data` کامل

### 3. `getUsers()` (خط ~3386)
- **فعلی:** `localStorage.getItem(AUTH_KEY)` + fallback به کاربر admin پیش‌فرض
- **تغییر:** فراخوانی API سمت سرور (مثلاً `GET /api/users`)
- **خروجی:** آرایه کاربران

### 4. `saveUsers(users)` (خط ~3395)
- **فعلی:** `localStorage.setItem(AUTH_KEY, JSON.stringify(users))`
- **تغییر:** فراخوانی API سمت سرور (مثلاً `POST /api/users`)
- **ورودی:** آرایه کاربران

### 5. `getCurrentUser()` (خط ~3410)
- **فعلی:** `localStorage.getItem(SESSION_KEY)`
- **تغییر:** استفاده از cookie/session سمت سرور یا JWT
- **نکته:** لاگین باید سمت سرور انجام بشه (نه فقط چک کردن هش رمز در مرورگر)

### 6. `setCurrentUser(user)` (خط ~3418)
- **فعلی:** `localStorage.setItem(SESSION_KEY, JSON.stringify(user))`
- **تغییر:** سرور session/JWT صادر کنه و در cookie ذخیره بشه

### 7. `clearCurrentUser()` (خط ~3422)
- **actusy:** `localStorage.removeItem(SESSION_KEY)`
- **تغییر:** `POST /api/logout` + پاک کردن cookie

---

## جداول دیتابیس پیشنهادی

### جدول `users`
```sql
CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  username VARCHAR(50) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  display_name VARCHAR(100),
  role VARCHAR(10) DEFAULT 'user',
  permissions JSONB,
  created_at TIMESTAMP DEFAULT NOW()
);
```

### جدول `customers`
```sql
CREATE TABLE customers (
  id VARCHAR(10) PRIMARY KEY,
  platform_id VARCHAR(100),
  platform VARCHAR(20),
  name VARCHAR(100),
  phone VARCHAR(20),
  status VARCHAR(30),
  notes TEXT,
  advisor VARCHAR(100),
  next_followup_date VARCHAR(20),
  products JSONB DEFAULT '[]',
  created_at TIMESTAMP DEFAULT NOW()
);
```

### جدول `followups`
```sql
CREATE TABLE followups (
  id SERIAL PRIMARY KEY,
  customer_id VARCHAR(10) REFERENCES customers(id),
  date VARCHAR(20),
  type VARCHAR(20),
  result VARCHAR(50),
  next_date VARCHAR(20),
  notes TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);
```

### جدول `app_settings` (اختیاری)
```sql
CREATE TABLE app_settings (
  key VARCHAR(50) PRIMARY KEY,
  value JSONB
);
```
برای ذخیره `nextId` و `convertedCount`.

---

## API‌های مورد نیاز

| متد | مسیر | توضیح |
|---|---|---|
| POST | `/api/auth/login` | ورود کاربر |
| POST | `/api/auth/logout` | خروج |
| GET | `/api/auth/me` | کاربر جاری |
| GET | `/api/data` | دریافت تمام داده‌ها |
| POST | `/api/data` | ذخیره تمام داده‌ها |
| GET | `/api/users` | لیست کاربران |
| POST | `/api/users` | اضافه/ویرایش کاربر |
| DELETE | `/api/users/:id` | حذف کاربر |

---

## ملاحظات امنیتی

1. **رمز عبور:** فعلیً در مرورگر هش میشه (`hashPassword`). در سمت سرور باید از `bcrypt` استفاده بشه
2. **احراز هویت:** فعلیً فقط localStorage. باید JWT یا server-side session باشه
3. ** اعتبارسنجی ورودی:** فعلیً هیچ validation سمت سروری نیست. باید اضافه بشه
4. ** CORS:** اگر فرانت و بک‌اند جداگانه باشن، CORS باید تنظیم بشه
5. **نسخه‌پشتیبانی:** فعلیً localStorage قابل پشتیبان‌گیری نیست. دیتابیس باید backup داشته باشه

---

## پشنهاد فناوری

| لایه | گزینه‌ها |
|---|---|
| بک‌اند | Node.js + Express / Python + FastAPI / Go |
| دیتابیس | PostgreSQL (توصیه شده) / SQLite (برای شروع ساده) |
| ORM | Prisma / Drizzle (Node.js) / SQLAlchemy (Python) |
| احراز هویت | JWT + bcrypt |

---

## ترتیب پیشنهادی مهاجرت

1. **ایجاد API سمت سرور** با احراز هویت
2. **ایجاد جداول دیتابیس**
3. **تغییر توابع ذخیره‌سازی** (`loadData`, `saveData`, `getUsers`, `saveUsers`)
4. **تغییر سیستم احراز هویت** (`getCurrentUser`, `setCurrentUser`, `clearCurrentUser`)
5. **تغییر `doLogin`** برای احراز هویت سمت سرور
6. **تests و دیپلوی**
