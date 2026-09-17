-- Persist customer panel profile fields (previously UI-only / in-memory)
ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS name_en text DEFAULT '',
  ADD COLUMN IF NOT EXISTS national_id text DEFAULT '',
  ADD COLUMN IF NOT EXISTS birth_date text DEFAULT '';
