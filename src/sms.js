// ماژول ارسال و تأیید OTP
// فراخوانی Edge Function‌های Supabase

import { supabase } from './supabase.js'
import { readFunctionsInvokeError } from './edge-error.js'

/**
 * @param {string} phone
 * @param {{ purpose?: 'tenant' | 'platform' | 'register', client?: import('@supabase/supabase-js').SupabaseClient }} [opts]
 */
export async function sendOTP(phone, opts = {}) {
  try {
    const client = opts.client || supabase
    const purpose = ['platform', 'register'].includes(opts.purpose) ? opts.purpose : 'tenant'
    const { data, error } = await client.functions.invoke('send-otp', {
      body: { phone, purpose }
    })

    if (error) {
      console.error('sendOTP error:', error)
      const detail = await readFunctionsInvokeError(error, 'خطا در ارسال کد تأیید')
      return { success: false, error: data?.error || detail }
    }

    return data || { success: false, error: 'پاسخ نامعتبر از سرور' }
  } catch (err) {
    console.error('sendOTP exception:', err)
    return { success: false, error: 'خطا در اتصال به سرور' }
  }
}

/**
 * @param {string} phone
 * @param {string} code
 * @param {{ purpose?: 'tenant' | 'platform' | 'register', org_name?: string, first_name?: string, last_name?: string, client?: import('@supabase/supabase-js').SupabaseClient }} [opts]
 */
export async function verifyOTP(phone, code, opts = {}) {
  try {
    const client = opts.client || supabase
    const purpose = ['platform', 'register'].includes(opts.purpose) ? opts.purpose : 'tenant'
    const body = { phone, code, purpose }
    if (purpose === 'register') {
      body.org_name = opts.org_name
      body.first_name = opts.first_name
      body.last_name = opts.last_name
    }
    const { data, error } = await client.functions.invoke('verify-otp', { body })

    if (error) {
      console.error('verifyOTP error:', error)
      const detail = await readFunctionsInvokeError(error, 'خطا در تأیید کد')
      return { success: false, error: data?.error || detail }
    }

    return data || { success: false, error: 'پاسخ نامعتبر از سرور' }
  } catch (err) {
    console.error('verifyOTP exception:', err)
    return { success: false, error: 'خطا در اتصال به سرور' }
  }
}

/**
 * @deprecated Prefer server-side checks; may fail under RLS without session.
 */
export async function checkPhoneExists(phone) {
  try {
    const { data, error } = await supabase
      .from('users')
      .select('username')
      .eq('phone', phone)
      .limit(1)

    if (error) {
      console.error('checkPhoneExists error:', error)
      return false
    }

    return data && data.length > 0
  } catch (err) {
    console.error('checkPhoneExists exception:', err)
    return false
  }
}
