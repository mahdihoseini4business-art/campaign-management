-- Ownership by mobile phone: advisor_phone on customers
-- Apply in Supabase SQL Editor after deploy.
-- Keeps customer ownership stable when users are recreated with the same phone.

-- 1) Column
ALTER TABLE customers ADD COLUMN IF NOT EXISTS advisor_phone TEXT;

CREATE INDEX IF NOT EXISTS idx_customers_advisor_phone ON customers(advisor_phone);

-- 2) Backfill from users.display_name → users.phone
UPDATE customers c
SET advisor_phone = u.phone
FROM users u
WHERE (c.advisor_phone IS NULL OR c.advisor_phone = '')
  AND c.advisor IS NOT NULL
  AND c.advisor <> ''
  AND u.phone IS NOT NULL
  AND u.phone <> ''
  AND trim(c.advisor) = trim(u.display_name);

-- 3) Also match "first_name last_name" if display_name empty/mismatch
UPDATE customers c
SET advisor_phone = u.phone
FROM users u
WHERE (c.advisor_phone IS NULL OR c.advisor_phone = '')
  AND c.advisor IS NOT NULL
  AND c.advisor <> ''
  AND u.phone IS NOT NULL
  AND u.phone <> ''
  AND trim(c.advisor) = trim(concat_ws(' ', u.first_name, u.last_name));
