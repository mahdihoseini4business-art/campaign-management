/**
 * Unit tests for ops digest metrics (no network).
 * Run: node scripts/test-ops-digest.mjs
 */
import {
  classifyFollowupDate,
  countAdvisorMorningMetrics,
  countManagerEveningMetrics,
  eveningHasWork,
  formatEveningMessage,
  formatMorningMessage,
  getTodayJalaliStr,
  jalaliAddDays,
  jalaliToNum,
  morningHasWork,
  normalizePhone,
  isOpenAssignedFollowup,
  isSystemDigestSender,
  SYSTEM_DIGEST_PHONE
} from '../supabase/functions/_shared/digest-metrics.js'

function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

{
  assert(normalizePhone('9123456789') === '09123456789', 'normalize 10-digit')
  assert(normalizePhone('09123456789') === '09123456789', 'normalize 11-digit')
  assert(normalizePhone('+98 912 345 6789') === '09123456789', 'normalize intl')
}

{
  const today = '1404/06/23'
  assert(classifyFollowupDate('1404/06/20', today) === 'overdue', 'overdue')
  assert(classifyFollowupDate('1404/06/23', today) === 'today', 'today')
  assert(classifyFollowupDate('1404/06/25', today) === 'waiting', 'waiting')
  assert(classifyFollowupDate('', today) === null, 'empty date')
}

{
  const today = '1404/06/23'
  const n = jalaliAddDays(today, 3)
  assert(n === jalaliToNum('1404/06/26'), 'add 3 days')
}

{
  assert(isOpenAssignedFollowup({
    assigned_to_phone: '09121111111',
    next_date: '1404/06/24',
    status: 'pending',
    type: 'ارجاع'
  }), 'open assigned')
  assert(!isOpenAssignedFollowup({
    assigned_to_phone: '09121111111',
    next_date: '1404/06/24',
    status: 'done'
  }), 'done assigned closed')
  assert(!isOpenAssignedFollowup({
    assigned_to_phone: '09121111111',
    next_date: '1404/06/24',
    type: 'پیگیری انجام‌شده'
  }), 'done type closed')
}

{
  const today = '1404/06/23'
  const customers = [
    { advisor_phone: '09121111111', next_followup_date: '1404/06/20' },
    { advisor_phone: '09121111111', next_followup_date: '1404/06/23' },
    { advisor_phone: '09121111111', next_followup_date: '1404/06/25' },
    { advisor_phone: '09122222222', next_followup_date: '1404/06/20' }
  ]
  const followups = [
    { assigned_to_phone: '09121111111', next_date: '1404/06/24', status: 'pending', type: 'ارجاع' },
    { assigned_to_phone: '09121111111', next_date: '1404/06/24', status: 'done', type: 'ارجاع' },
    { assigned_to_phone: '09123333333', next_date: '1404/06/24', status: 'pending', type: 'ارجاع' }
  ]
  const c = countAdvisorMorningMetrics({
    phone: '09121111111',
    customers,
    followups,
    todayStr: today
  })
  assert(c.overdue === 1, 'morning overdue')
  assert(c.today === 1, 'morning today')
  assert(c.assignedOpen === 1, 'morning assigned')
  assert(morningHasWork(c), 'morning has work')
  assert(!morningHasWork({ overdue: 0, today: 0, assignedOpen: 0 }), 'morning empty')

  const msg = formatMorningMessage(c)
  assert(msg.includes('معوق'), 'morning msg overdue')
  assert(msg.includes('امروز'), 'morning msg today')
  assert(msg.includes('ارجاع'), 'morning msg assigned')
}

{
  const today = '1404/06/23'
  const team = ['09121111111', '09122222222']
  const customers = [
    { advisor_phone: '09121111111', next_followup_date: '1404/06/20' },
    { advisor_phone: '09122222222', next_followup_date: '1404/06/25' },
    { advisor_phone: '09122222222', next_followup_date: '1404/07/01' },
    { advisor_phone: '09129999999', next_followup_date: '1404/06/20' }
  ]
  const followups = [
    { assigned_to_phone: '09122222222', next_date: '1404/06/24', status: 'pending', type: 'ارجاع' },
    { assigned_to_phone: '09129999999', next_date: '1404/06/24', status: 'pending', type: 'ارجاع' }
  ]
  const c = countManagerEveningMetrics({
    teamPhones: team,
    customers,
    followups,
    todayStr: today
  })
  assert(c.overdue === 1, 'evening overdue')
  assert(c.soon === 1, 'evening soon (within 3 days)')
  assert(c.assignedOpen === 1, 'evening assigned')
  assert(eveningHasWork(c), 'evening has work')
  const msg = formatEveningMessage(c)
  assert(msg.includes('معوق تیم'), 'evening msg')
}

{
  assert(isSystemDigestSender(SYSTEM_DIGEST_PHONE), 'system sender')
  assert(!isSystemDigestSender('09121111111'), 'human sender')
  const today = getTodayJalaliStr()
  assert(/^\d{4}\/\d{2}\/\d{2}$/.test(today), 'today jalali shape')
}

console.log('test-ops-digest: ok')
