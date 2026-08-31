/** Import order respects foreign keys. */
const IMPORT_ORDER = [
  'users',
  'groups',
  'group_members',
  'app_settings',
  'customers',
  'followups',
  'refunds',
  'ownership_transfers',
  'ownership_transfer_acks',
  'notifications',
  'notification_reads'
]

/** @type {Record<string, string[]>} */
const TABLE_COLUMNS = {
  customers: [
    'id', 'platform_id', 'platform', 'name', 'phone', 'phones', 'addresses',
    'status', 'notes', 'advisor', 'advisor_phone', 'next_followup_date', 'products',
    'customer_level', 'customer_level_locked', 'referred_by_phone', 'customer_code',
    'created_at', 'updated_at'
  ],
  followups: [
    'id', 'customer_id', 'date', 'type', 'result', 'next_date', 'notes',
    'created_by_phone', 'status', 'done_at', 'done_by_phone', 'done_note',
    'was_overdue', 'updated_at'
  ],
  refunds: [
    'id', 'customer_id', 'product_index', 'product_name', 'payment_id', 'amount',
    'is_full_payment', 'status', 'note', 'refund_reason', 'account_info',
    'account_holder_name', 'sheba', 'card_number', 'reject_reason', 'advisor_phone',
    'customer_name', 'created_by_phone', 'created_by_name', 'updated_by_phone',
    'completed_by_phone', 'requested_at', 'awaiting_at', 'completed_at', 'archived_at',
    'created_at', 'updated_at'
  ],
  ownership_transfers: [
    'id', 'customer_id', 'customer_phone', 'from_advisor_phone', 'from_advisor_name',
    'to_advisor_phone', 'to_advisor_name', 'acted_by_phone', 'batch_id', 'reason',
    'customer_status_at_transfer', 'created_at', 'updated_at'
  ],
  ownership_transfer_acks: [
    'id', 'user_phone', 'batch_id', 'seen_at', 'updated_at'
  ],
  users: [
    'username', 'first_name', 'last_name', 'phone', 'display_name', 'role',
    'permissions', 'password_hash'
  ],
  groups: ['id', 'name', 'description', 'created_at'],
  group_members: ['group_id', 'user_phone', 'is_manager'],
  app_settings: ['key', 'value'],
  notifications: [
    'id', 'title', 'message', 'recipient_phones', 'created_by_phone',
    'created_by_name', 'created_at', 'expires_at'
  ],
  notification_reads: ['user_phone', 'notification_id', 'read_at']
}

/** Stored as JSON text in SQLite. */
const JSON_COLUMNS = {
  customers: ['phones', 'addresses', 'products'],
  users: ['permissions'],
  app_settings: ['value'],
  notifications: ['recipient_phones']
}

/** Stored as INTEGER 0/1 in SQLite. */
const BOOL_COLUMNS = {
  customers: ['customer_level_locked'],
  followups: ['was_overdue'],
  refunds: ['is_full_payment'],
  group_members: ['is_manager']
}

const CLEAR_ORDER = [...IMPORT_ORDER].reverse()

module.exports = {
  IMPORT_ORDER,
  CLEAR_ORDER,
  TABLE_COLUMNS,
  JSON_COLUMNS,
  BOOL_COLUMNS
}
