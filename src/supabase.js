import { createClient } from '@supabase/supabase-js'
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js'

// The anon key is public by design (browser clients). Security depends on
// Postgres Row Level Security — see supabase/migrations/002_security_rls.sql
export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
