// ============================================
// Data Layer (localStorage - Phase 3: Supabase)
// ============================================

const STORAGE_KEY = 'campaign_manager_data'

export function loadData() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) return JSON.parse(raw)
  } catch (e) {}

  return {
    customers: [
      { id: 'LD0001', platformId: 'user_ali_98', platform: 'instagram', name: 'علی محمدی', phone: '09121234567', status: 'contacted', notes: 'به محصول A علاقه‌مند', advisor: 'مدیر سیستم', products: [] },
      { id: 'LD0002', platformId: 'sara_online', platform: 'telegram', name: 'سارا احمدی', phone: '', status: 'new', notes: 'کامنت رو پست آخر', advisor: 'مدیر سیستم', products: [] },
      { id: 'LD0003', platformId: 'mehdi_dev', platform: 'instagram', name: 'مهدی رضایی', phone: '09359876543', status: 'interested', notes: 'قیمت رو پرسید', advisor: 'مدیر سیستم', products: [] },
      { id: 'CS0001', platformId: 'nora_club', platform: 'whatsapp', name: 'نرگس کریمی', phone: '09011112233', status: 'sent', notes: 'مشتری قبلی - خرید B', advisor: 'مدیر سیستم', products: [
        { name: 'کتاب', status: 'تکمیل', price: '450000', deposit: '' },
        { name: 'آنلاین چینی', status: 'بیعانه', price: '1200000', deposit: '500000' }
      ] },
      { id: 'LD0004', platformId: 'reza_shop', platform: 'instagram', name: 'رضا عباسی', phone: '', status: 'new', notes: 'دایرکت داده', advisor: 'مدیر سیستم', products: [] },
    ],
    followups: [
      { customerId: 'LD0001', date: '1404/04/08', type: 'دایرکت', result: 'پاسخ داد', nextDate: '1404/04/10', notes: 'در مورد محصول A سوال داشت' },
      { customerId: 'LD0001', date: '1404/04/10', type: 'تماس', result: 'صحبت شد', nextDate: '1404/04/12', notes: 'قیمت رو پذیرفت' },
      { customerId: 'LD0001', date: '1404/04/12', type: 'پیام', result: 'پیگیری', nextDate: '1404/04/15', notes: 'منتظر پاسخ' },
      { customerId: 'LD0003', date: '1404/04/11', type: 'کامنت', result: 'ارسال قیمت', nextDate: '1404/04/13', notes: 'قیمت کامل ارسال شد' },
      { customerId: 'LD0003', date: '1404/04/12', type: 'دایرکت', result: 'پاسخ داد', nextDate: '1404/04/15', notes: 'در حال مقایسه با رقبا' },
      { customerId: 'CS0001', date: '1404/04/05', type: 'تماس', result: 'پیگیری', nextDate: '1404/04/08', notes: 'رضایت از خرید قبلی' },
      { customerId: 'CS0001', date: '1404/04/08', type: 'پیام', result: 'ارسال پیشنهاد', nextDate: '1404/04/10', notes: 'پیشنهاد محصول جدید' },
      { customerId: 'CS0001', date: '1404/04/10', type: 'دایرکت', result: 'صحبت شد', nextDate: '1404/04/12', notes: 'علاقه‌مند شد' },
      { customerId: 'CS0001', date: '1404/04/12', type: 'تماس', result: 'ارسال محصول', nextDate: '1404/04/14', notes: 'ارسال شد' },
      { customerId: 'CS0001', date: '1404/04/14', type: 'پیام', result: 'تحویل شد', nextDate: '-', notes: 'رضایت کامل' },
      { customerId: 'LD0004', date: '1404/04/13', type: 'دایرکت', result: 'پاسخ داد', nextDate: '1404/04/16', notes: 'اطلاعات ارسال شد' },
    ],
    nextId: 5,
    convertedCount: 0
  }
}

let data = loadData()

export function getData() {
  return data
}

export function saveData() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data))
}

export function generateId(type) {
  const prefix = type === 'CS' ? 'CS' : 'LD'
  const existingIds = data.customers
    .filter(c => c.id.startsWith(prefix))
    .map(c => parseInt(c.id.slice(2)))
    .filter(n => !isNaN(n))
  const nextNum = existingIds.length > 0 ? Math.max(...existingIds) + 1 : 1
  return prefix + String(nextNum).padStart(4, '0')
}
