// ماژول ارسال و تأیید OTP
// فراخوانی Edge Function‌های Supabase

import { supabase } from './supabase.js'

/**
 * @param {string} phone
 * @param {{ purpose?: 'tenant' | 'platform' | 'register' }} [opts]
 */
export async function sendOTP(phone, opts = {}) {
  try {
    const purpose = ['platform', 'register'].includes(opts.purpose) ? opts.purpose : 'tenant'
    const { data, error } = await supabase.functions.invoke('send-otp', {
      body: { phone, purpose }
    })

    if (error) {
      console.error('sendOTP error:', error)
      return { success: false, error: 'خطا در ارسال کد تأیید' }
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
 * @param {{ purpose?: 'tenant' | 'platform' | 'register', org_name?: string, first_name?: string, last_name?: string }} [opts]
 */
export async function verifyOTP(phone, code, opts = {}) {
  try {
    const purpose = ['platform', 'register'].includes(opts.purpose) ? opts.purpose : 'tenant'
    const body = { phone, code, purpose }
    if (purpose === 'register') {
      body.org_name = opts.org_name
      body.first_name = opts.first_name
      body.last_name = opts.last_name
    }
    const { data, error } = await supabase.functions.invoke('verify-otp', { body })

    if (error) {
      console.error('verifyOTP error:', error)
      return { success: false, error: 'خطا در تأیید کد' }
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
