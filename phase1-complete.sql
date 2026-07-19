-- ============================================
-- فاز ۱: تکمیل دیتابیس - Indexes
-- این اسکریپت رو در Supabase SQL Editor اجرا کن
-- ============================================

-- 1. Indexes برای فیلترها
CREATE INDEX IF NOT EXISTS idx_customers_advisor ON customers(advisor);
CREATE INDEX IF NOT EXISTS idx_customers_status ON customers(status);
CREATE INDEX IF NOT EXISTS idx_customers_id_prefix ON customers(id);
CREATE INDEX IF NOT EXISTS idx_followups_customer ON followups(customer_id);
