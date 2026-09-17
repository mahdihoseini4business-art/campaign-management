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
  jalaliAddDaysStr,
  jalaliToNum,
  morningHasWork,
  normalizePhone,
  isOpenAssignedFollowup,
  isSystemDigestSender,
  formatMoneyShort,
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
  assert(jalaliAddDaysStr(today, -1) === '1404/06/22', 'yesterday str')
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
  assert(formatMoneyShort(48_500_000).includes('میلیون'), 'money millions')
}

{
  const today = '1404/06/23'
  const yesterday = '1404/06/22'
  const customers = [
    {
      id: 'CS1',
      name: 'سارا احمدی',
      advisor_phone: '09121111111',
      next_followup_date: '1404/06/20',
      platform: 'instagram',
      products: [{
        name: 'دوره A',
        price: '10000000',
        status: 'بیعانه',
        payments: [{
          amount: '5000000',
          soldAt: `${yesterday} 10:00`,
          paymentStatus: 'approved',
          soldByPhone: '09121111111'
        }]
      }]
    },
    {
      id: 'CS2',
      name: 'رضا',
      advisor_phone: '09121111111',
      next_followup_date: '1404/06/23',
      platform: 'telegram',
      products: []
    },
    {
      id: 'CS3',
      name: 'بدون تاریخ',
      advisor_phone: '09121111111',
      next_followup_date: '',
      products: []
    },
    {
      id: 'LD9',
      name: 'لید دیروز',
      advisor_phone: '09121111111',
      next_followup_date: '1404/06/25',
      created_at: '2025-09-13T10:00:00.000Z', // may not match yesterday — we also test via Jalali createdAt
      createdAt: yesterday,
      products: []
    },
    {
      id: 'CS4',
      advisor_phone: '09122222222',
      next_followup_date: '1404/06/20',
      products: []
    }
  ]
  const followups = [
    { assigned_to_phone: '09121111111', next_date: '1404/06/20', status: 'pending', type: 'ارجاع' },
    { assigned_to_phone: '09121111111', next_date: '1404/06/23', status: 'pending', type: 'ارجاع' },
    { assigned_to_phone: '09121111111', next_date: '1404/06/24', status: 'done', type: 'ارجاع' },
    { assigned_to_phone: '09123333333', next_date: '1404/06/24', status: 'pending', type: 'ارجاع' }
  ]
  const refunds = [
    { status: 'requested', advisor_phone: '09121111111' },
    { status: 'completed', advisor_phone: '09121111111' }
  ]
  const salesTargets = [{
    id: 'g1',
    title: 'تارگت ماه',
    items: [{
      id: 'bar1',
      metric: 'amount',
      value: 100_000_000,
      productNames: [],
      startDate: '1404/06/01',
      endDate: '1404/06/31'
    }],
    allocations: [{
      userGroupId: 'grp1',
      shares: [{ barId: 'bar1', value: 100_000_000 }],
      members: [{
        userPhone: '09121111111',
        shares: [{ barId: 'bar1', value: 50_000_000 }]
      }]
    }]
  }]

  const c = countAdvisorMorningMetrics({
    phone: '09121111111',
    customers,
    followups,
    todayStr: today,
    salesTargets,
    refunds
  })
  assert(c.overdue === 1, 'morning overdue')
  assert(c.today === 1, 'morning today')
  assert(c.assignedOpen === 2, 'morning assigned open')
  assert(c.assignedOverdue === 1, 'morning assigned overdue')
  assert(c.assignedToday === 1, 'morning assigned today')
  assert(c.noFollowup === 1, 'morning no followup')
  assert(c.overdueTop.length === 1, 'morning overdue top')
  assert(c.overdueTop[0].name.includes('سارا'), 'morning overdue name')
  assert(c.salesYesterdayCount === 1, 'morning sales yesterday count')
  assert(c.salesYesterdayAmount === 5_000_000, 'morning sales yesterday amount')
  assert(c.openDepositCount === 1, 'morning open deposit')
  assert(c.refundsOpen === 1, 'morning refunds')
  assert(c.newLeadsYesterday === 1, 'morning new leads')
  assert(c.target && c.target.goal === 50_000_000, 'morning target goal')
  assert(morningHasWork(c), 'morning has work')
  assert(!morningHasWork({
    overdue: 0, today: 0, assignedOpen: 0, noFollowup: 0,
    salesYesterdayCount: 0, openDepositCount: 0, pendingCount: 0,
    refundsOpen: 0, newLeadsYesterday: 0, target: null
  }), 'morning empty')

  const msg = formatMorningMessage(c)
  assert(msg.includes('اولویت'), 'morning msg section')
  assert(msg.includes('معوق'), 'morning msg overdue')
  assert(msg.includes('سارا'), 'morning msg name')
  assert(msg.includes('دیروز') || msg.includes('کتاب'), 'morning money section')
}

{
  const today = '1404/06/23'
  const team = ['09121111111', '09122222222', '09123333333']
  const customers = [
    {
      id: 'CS1',
      advisor_phone: '09121111111',
      advisor: 'علی',
      next_followup_date: '1404/06/20',
      products: [{
        name: 'P',
        price: '20000000',
        status: 'تکمیل',
        payments: [{
          amount: '20000000',
          soldAt: `${today} 12:00`,
          paymentStatus: 'approved',
          soldByPhone: '09121111111'
        }]
      }]
    },
    {
      id: 'CS2',
      advisor_phone: '09122222222',
      advisor: 'مریم',
      next_followup_date: '1404/06/25',
      products: [{
        name: 'P',
        price: '10000000',
        status: 'تکمیل',
        payments: [{
          amount: '10000000',
          soldAt: `${today} 13:00`,
          paymentStatus: 'approved',
          soldByPhone: '09122222222'
        }]
      }]
    },
    {
      id: 'CS3',
      advisor_phone: '09122222222',
      advisor: 'مریم',
      next_followup_date: '1404/07/01',
      products: []
    },
    {
      id: 'CS4',
      advisor_phone: '09129999999',
      next_followup_date: '1404/06/20',
      products: []
    }
  ]
  const followups = [
    {
      assigned_to_phone: '09122222222',
      next_date: '1404/06/24',
      status: 'pending',
      type: 'ارجاع'
    },
    {
      assigned_to_phone: '09129999999',
      next_date: '1404/06/24',
      status: 'pending',
      type: 'ارجاع'
    },
    {
      status: 'done',
      type: 'پیگیری انجام‌شده',
      done_at: `${today} 11:00`,
      done_by_phone: '09121111111',
      date: today
    },
    {
      status: 'done',
      type: 'پیگیری انجام‌شده',
      done_at: `${today} 11:30`,
      done_by_phone: '09122222222',
      date: today
    }
  ]
  const salesTargets = [{
    id: 'g1',
    title: 'مشاوران شمال',
    items: [{
      id: 'bar1',
      metric: 'amount',
      value: 100_000_000,
      productNames: [],
      startDate: '1404/06/01',
      endDate: '1404/06/31'
    }],
    allocations: [{
      userGroupId: 'grp-north',
      shares: [{ barId: 'bar1', value: 80_000_000 }],
      members: []
    }]
  }]

  const c = countManagerEveningMetrics({
    teamPhones: team,
    customers,
    followups,
    todayStr: today,
    salesTargets,
    refunds: [{ status: 'awaiting', advisor_phone: '09121111111' }],
    phoneNames: {
      '09121111111': 'علی',
      '09122222222': 'مریم',
      '09123333333': 'نیما'
    },
    groupIds: ['grp-north']
  })
  assert(c.overdue === 1, 'evening overdue')
  assert(c.soon === 1, 'evening soon (within 3 days)')
  assert(c.assignedOpen === 1, 'evening assigned')
  assert(c.doneToday === 2, 'evening done today')
  assert(c.overdueTop.length >= 1 && c.overdueTop[0].name === 'علی', 'evening overdue top')
  assert(c.salesTodayCount === 2, 'evening sales today count')
  assert(c.salesTodayAmount === 30_000_000, 'evening sales today amount')
  assert(c.salesTop.length >= 1, 'evening sales top')
  assert(c.inactiveToday.some(r => r.name === 'نیما'), 'evening inactive')
  assert(c.refundsOpen === 1, 'evening refunds')
  assert(c.target && c.target.title.includes('شمال'), 'evening target')
  assert(eveningHasWork(c), 'evening always has work object')
  assert(eveningHasWork({}), 'evening empty object still sends')

  const msg = formatEveningMessage(c)
  assert(msg.includes('عملیات'), 'evening ops section')
  assert(msg.includes('معوق'), 'evening msg overdue')
  assert(msg.includes('فروش امروز'), 'evening sales section')
  assert(msg.includes('علی') || msg.includes('برتر'), 'evening top names')
}

{
  // All-clear evening still formats
  const c = countManagerEveningMetrics({
    teamPhones: ['09121111111'],
    customers: [{
      advisor_phone: '09121111111',
      next_followup_date: '1404/08/01',
      products: []
    }],
    followups: [],
    todayStr: '1404/06/23'
  })
  assert(c.overdue === 0 && c.soon === 0, 'evening clean metrics')
  const msg = formatEveningMessage(c)
  assert(msg.includes('تمیز') || msg.includes('فروش امروز'), 'evening all-clear message')
}

{
  assert(isSystemDigestSender(SYSTEM_DIGEST_PHONE), 'system sender')
  assert(!isSystemDigestSender('09121111111'), 'human sender')
  const today = getTodayJalaliStr()
  assert(/^\d{4}\/\d{2}\/\d{2}$/.test(today), 'today jalali shape')
}

console.log('test-ops-digest: ok')
