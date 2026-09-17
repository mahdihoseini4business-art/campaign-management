-- Sticky first-fill timestamps for profile-completion sales targets (anti-cheat)
ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS field_filled_at jsonb DEFAULT '{}'::jsonb;

UPDATE customers
SET field_filled_at = '{}'::jsonb
WHERE field_filled_at IS NULL
   OR field_filled_at = 'null'::jsonb;

-- Legacy backfill: currently filled fields stamped at created_at (not NOW)
UPDATE customers
SET field_filled_at = COALESCE(field_filled_at, '{}'::jsonb)
  || CASE WHEN NULLIF(trim(COALESCE(name, '')), '') IS NOT NULL
    THEN jsonb_build_object('name', COALESCE(created_at, TIMESTAMPTZ '1970-01-01')) ELSE '{}'::jsonb END
  || CASE WHEN NULLIF(trim(COALESCE(name_en, '')), '') IS NOT NULL
    THEN jsonb_build_object('nameEn', COALESCE(created_at, TIMESTAMPTZ '1970-01-01')) ELSE '{}'::jsonb END
  || CASE WHEN NULLIF(trim(COALESCE(national_id, '')), '') ~ '^\d{10}$'
    THEN jsonb_build_object('nationalId', COALESCE(created_at, TIMESTAMPTZ '1970-01-01')) ELSE '{}'::jsonb END
  || CASE WHEN NULLIF(trim(COALESCE(birth_date, '')), '') ~ '^\d{4}/\d{2}/\d{2}$'
    THEN jsonb_build_object('birthDate', COALESCE(created_at, TIMESTAMPTZ '1970-01-01')) ELSE '{}'::jsonb END
  || CASE WHEN NULLIF(trim(COALESCE(status, '')), '') IS NOT NULL
    THEN jsonb_build_object('status', COALESCE(created_at, TIMESTAMPTZ '1970-01-01')) ELSE '{}'::jsonb END
  || CASE WHEN NULLIF(trim(COALESCE(customer_code, '')), '') IS NOT NULL
    THEN jsonb_build_object('customerCode', COALESCE(created_at, TIMESTAMPTZ '1970-01-01')) ELSE '{}'::jsonb END
  || CASE WHEN NULLIF(trim(COALESCE(customer_level, '')), '') IS NOT NULL
    THEN jsonb_build_object('customerLevel', COALESCE(created_at, TIMESTAMPTZ '1970-01-01')) ELSE '{}'::jsonb END
  || CASE WHEN NULLIF(trim(COALESCE(platform, '')), '') IS NOT NULL
    THEN jsonb_build_object('platform', COALESCE(created_at, TIMESTAMPTZ '1970-01-01')) ELSE '{}'::jsonb END
  || CASE WHEN NULLIF(trim(COALESCE(platform_id, '')), '') IS NOT NULL
    THEN jsonb_build_object('platformId', COALESCE(created_at, TIMESTAMPTZ '1970-01-01')) ELSE '{}'::jsonb END
  || CASE WHEN NULLIF(trim(COALESCE(advisor_phone, '')), '') IS NOT NULL
    THEN jsonb_build_object('advisor', COALESCE(created_at, TIMESTAMPTZ '1970-01-01')) ELSE '{}'::jsonb END
  || CASE WHEN NULLIF(trim(COALESCE(phone, '')), '') IS NOT NULL
       OR (jsonb_typeof(COALESCE(phones, '[]'::jsonb)) = 'array' AND jsonb_array_length(COALESCE(phones, '[]'::jsonb)) > 0)
    THEN jsonb_build_object('phones', COALESCE(created_at, TIMESTAMPTZ '1970-01-01')) ELSE '{}'::jsonb END
  || CASE WHEN jsonb_typeof(COALESCE(addresses, '[]'::jsonb)) = 'array'
       AND jsonb_array_length(COALESCE(addresses, '[]'::jsonb)) > 0
    THEN jsonb_build_object('addresses', COALESCE(created_at, TIMESTAMPTZ '1970-01-01')) ELSE '{}'::jsonb END;
