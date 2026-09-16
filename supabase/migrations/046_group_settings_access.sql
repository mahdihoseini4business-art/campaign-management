-- Per-group settings delegation for group managers.
-- Shape: { "<sectionId>": { "enabled": true, "scope": "org"|"group" }, ... }
-- Locked sections (groups, sms, backup, chat-*) are never stored/applied in app layer.

ALTER TABLE groups
  ADD COLUMN IF NOT EXISTS settings_access JSONB NOT NULL DEFAULT '{}'::jsonb;
