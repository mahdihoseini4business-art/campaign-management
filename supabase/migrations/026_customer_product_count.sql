-- Generated sale-line count for list views (startup payload omits products JSON).
ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS product_count INTEGER
  GENERATED ALWAYS AS (jsonb_array_length(COALESCE(products, '[]'::jsonb))) STORED;
