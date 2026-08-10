-- Rename mistaken "کارنو لیدز" (carno_leads) platform to "تماس خروجی" (outbound_call).
-- Frees the carno_leads key for a real Carno Leads platform later.

UPDATE customers
SET platform = 'outbound_call'
WHERE platform = 'carno_leads';

UPDATE app_settings
SET value = (
  SELECT COALESCE(
    jsonb_agg(
      CASE
        WHEN elem->>'key' = 'carno_leads' THEN
          jsonb_set(
            jsonb_set(elem, '{key}', '"outbound_call"'::jsonb),
            '{label}',
            '"تماس خروجی"'::jsonb
          )
        ELSE elem
      END
      ORDER BY ordinality
    ),
    '[]'::jsonb
  )
  FROM jsonb_array_elements(value::jsonb) WITH ORDINALITY AS t(elem, ordinality)
)
WHERE key = 'platforms'
  AND value IS NOT NULL
  AND jsonb_typeof(value::jsonb) = 'array'
  AND EXISTS (
    SELECT 1
    FROM jsonb_array_elements(value::jsonb) AS e(elem)
    WHERE elem->>'key' = 'carno_leads'
  );
