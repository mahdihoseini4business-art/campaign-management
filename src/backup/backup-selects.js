/** Shared SELECT lists for full backup export (used by data.js and backup-tables.js). */

/** List load omits heavy `notes` (fetched on detail open). */
export const CUSTOMER_LIST_SELECT = [
  'id', 'platform_id', 'platform', 'name', 'phone', 'phones', 'addresses',
  'status', 'advisor', 'advisor_phone', 'next_followup_date', 'products',
  'created_at', 'updated_at', 'customer_level', 'customer_level_locked', 'referred_by_phone',
  'customer_code'
].join(',')

/** Full customer row including notes for detail panel / backup. */
export const CUSTOMER_DETAIL_SELECT = CUSTOMER_LIST_SELECT + ',notes'

export const FOLLOWUP_SELECT = [
  'id', 'customer_id', 'date', 'type', 'result', 'next_date', 'product_name', 'notes',
  'created_by_phone', 'status', 'done_at', 'done_by_phone', 'done_note',
  'was_overdue', 'assigned_to_phone', 'assigned_by_phone', 'assigned_at', 'updated_at'
].join(',')

export const REFUND_SELECT = [
  'id', 'customer_id', 'product_index', 'product_name', 'payment_id', 'amount',
  'is_full_payment', 'status', 'note', 'refund_reason', 'account_info',
  'account_holder_name', 'sheba', 'card_number', 'reject_reason', 'advisor_phone',
  'customer_name', 'created_by_phone', 'created_by_name', 'updated_by_phone',
  'completed_by_phone', 'requested_at', 'awaiting_at', 'completed_at', 'archived_at',
  'created_at', 'updated_at'
].join(',')

export const OWNERSHIP_TRANSFER_SELECT = [
  'id', 'customer_id', 'customer_phone', 'from_advisor_phone', 'from_advisor_name',
  'to_advisor_phone', 'to_advisor_name', 'acted_by_phone', 'batch_id', 'reason',
  'customer_status_at_transfer', 'created_at', 'updated_at'
].join(',')

export const OWNERSHIP_ACK_SELECT = 'id,user_phone,batch_id,seen_at,updated_at'
