-- Dynamic user groups: exclusive membership, one manager per group.
-- Manager's permissions.viewUserPhones is derived from other members (app layer).

CREATE TABLE IF NOT EXISTS groups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT groups_name_unique UNIQUE (name)
);

CREATE TABLE IF NOT EXISTS group_members (
  group_id UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_phone TEXT NOT NULL,
  is_manager BOOLEAN NOT NULL DEFAULT false,
  PRIMARY KEY (group_id, user_phone)
);

-- Each user belongs to at most one group
CREATE UNIQUE INDEX IF NOT EXISTS group_members_user_phone_unique
  ON group_members (user_phone);

-- At most one manager per group
CREATE UNIQUE INDEX IF NOT EXISTS group_members_one_manager
  ON group_members (group_id)
  WHERE is_manager = true;

CREATE INDEX IF NOT EXISTS idx_group_members_group_id
  ON group_members (group_id);

ALTER TABLE groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE group_members ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_groups_all" ON groups;
CREATE POLICY "anon_groups_all" ON groups
  FOR ALL TO anon, authenticated
  USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "anon_group_members_all" ON group_members;
CREATE POLICY "anon_group_members_all" ON group_members
  FOR ALL TO anon, authenticated
  USING (true) WITH CHECK (true);
