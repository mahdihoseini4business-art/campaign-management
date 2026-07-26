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
