import { createClient } from '@supabase/supabase-js'
import { SUPABASE_URL, SUPABASE_ANON_KEY } from '../config.js'
import { PLATFORM_AUTH_STORAGE_KEY } from './session-contract.js'

/**
 * Auth storage isolated from the tenant app (`carno-supabase-auth`).
 * Logout on /platform must not clear tenant sessions and vice versa.
 */
export const platformSupabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: false,
    storageKey: PLATFORM_AUTH_STORAGE_KEY
  }
})
