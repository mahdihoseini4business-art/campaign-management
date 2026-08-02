-- Add title to manual notifications (dropdown shows title only).

ALTER TABLE notifications
  ADD COLUMN IF NOT EXISTS title TEXT;

UPDATE notifications
SET title = LEFT(message, 80)
WHERE title IS NULL OR TRIM(title) = '';

ALTER TABLE notifications
  ALTER COLUMN title SET DEFAULT '';

ALTER TABLE notifications
  ALTER COLUMN title SET NOT NULL;
