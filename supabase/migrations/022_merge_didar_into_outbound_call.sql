-- Merge platform "دیدار" (didar) into "تماس خروجی" (outbound_call).

UPDATE customers
SET platform = 'outbound_call'
WHERE platform IN ('didar', 'دیدار')
   OR lower(platform) = 'didar';

UPDATE app_settings
SET value = (
  SELECT COALESCE(
    (
      SELECT jsonb_agg(elem ORDER BY ordinality)
      FROM (
        SELECT DISTINCT ON (norm_key)
          mapped AS elem,
          ordinality,
          norm_key
        FROM (
          SELECT
            CASE
              WHEN lower(elem->>'key') = 'didar'
                OR elem->>'key' = 'دیدار'
                OR elem->>'label' = 'دیدار'
              THEN jsonb_set(
                jsonb_set(elem, '{key}', '"outbound_call"'::jsonb),
                '{label}',
                '"تماس خروجی"'::jsonb
              )
              ELSE elem
            END AS mapped,
            ordinality,
            CASE
              WHEN lower(elem->>'key') = 'didar'
                OR elem->>'key' = 'دیدار'
                OR elem->>'label' = 'دیدار'
              THEN 'outbound_call'
              ELSE COALESCE(elem->>'key', '')
            END AS norm_key
          FROM jsonb_array_elements(value::jsonb) WITH ORDINALITY AS t(elem, ordinality)
        ) s
        ORDER BY norm_key,
          CASE WHEN mapped->>'key' = 'outbound_call' THEN 0 ELSE 1 END,
          ordinality
      ) d
    ),
    '[]'::jsonb
  )
)
WHERE key = 'platforms'
  AND value IS NOT NULL
  AND jsonb_typeof(value::jsonb) = 'array'
  AND EXISTS (
    SELECT 1
    FROM jsonb_array_elements(value::jsonb) AS e(elem)
    WHERE lower(elem->>'key') = 'didar'
       OR elem->>'key' = 'دیدار'
       OR elem->>'label' = 'دیدار'
  );
