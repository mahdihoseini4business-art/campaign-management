// ماژول ارسال و تأیید OTP
// فراخوانی Edge Function‌های Supabase

import { supabase } from './supabase.js'

/**
 * @param {string} phone
 * @param {{ purpose?: 'tenant' | 'platform' }} [opts]
 */
export async function sendOTP(phone, opts = {}) {
  try {
    const { data, error } = await supabase.functions.invoke('send-otp', {
      body: { phone, purpose: opts.purpose === 'platform' ? 'platform' : 'tenant' }
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
 * @param {{ purpose?: 'tenant' | 'platform' }} [opts]
 */
export async function verifyOTP(phone, code, opts = {}) {
  try {
    const { data, error } = await supabase.functions.invoke('verify-otp', {
      body: {
        phone,
        code,
        purpose: opts.purpose === 'platform' ? 'platform' : 'tenant'
      }
    })

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
