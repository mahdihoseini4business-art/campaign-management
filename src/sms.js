// ماژول ارسال و تأیید OTP
// فراخوانی Edge Function‌های Supabase

import { supabase } from './supabase.js'

/**
 * ارسال کد OTP به شماره موبایل
 * @param {string} phone - شماره موبایل (فرمت: 09xxxxxxxxx)
 * @returns {Promise<{success: boolean, error?: string}>}
 */
export async function sendOTP(phone) {
  try {
    const { data, error } = await supabase.functions.invoke('send-otp', {
      body: { phone }
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
 * تأیید کد OTP
 * @param {string} phone - شماره موبایل
 * @param {string} code - کد ۶ رقمی
 * @returns {Promise<{success: boolean, user?: object, error?: string, locked?: boolean}>}
 */
export async function verifyOTP(phone, code) {
  try {
    const { data, error } = await supabase.functions.invoke('verify-otp', {
      body: { phone, code }
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
 * بررسی وجود شماره موبایل در دیتابیس
 * @param {string} phone - شماره موبایل
 * @returns {Promise<boolean>}
 */
export async function checkPhoneExists(phone) {
  try {
    const { data, error } = await supabase
      .from('users')
      .select('id')
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
