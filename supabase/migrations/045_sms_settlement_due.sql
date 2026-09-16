-- Auto SMS on sale settlement due date: feature flag + default template

-- Merge sales_settlement_due into existing sms_features (default off — opt-in)
UPDATE public.app_settings
SET value = COALESCE(value, '{}'::jsonb) || jsonb_build_object('sales_settlement_due', false)
WHERE key = 'sms_features';

-- New tenants / missing rows: ensure key exists with defaults
INSERT INTO public.app_settings (tenant_id, key, value)
SELECT t.id, 'sms_features', '{
  "shipment_queued": true,
  "shipment_shipped": true,
  "sales_single": true,
  "sales_group_debtors": true,
  "sales_settlement_due": false,
  "customer_single": true,
  "customer_campaign": true,
  "followup_on_schedule": true,
  "followup_bulk": true,
  "templates_edit": true,
  "history_view": true
}'::jsonb
FROM public.tenants t
ON CONFLICT (tenant_id, key) DO NOTHING;

INSERT INTO public.sms_templates (tenant_id, key, name, body, enabled)
SELECT t.id, v.key, v.name, v.body, true
FROM public.tenants t
CROSS JOIN (VALUES
  (
    'sale_settlement_due',
    'موعد تسویه',
    'سلام {customer_name} عزیز، موعد تسویه «{product_name}» ({settlement_date}) فرا رسیده است. مانده حساب شما: {balance} ریال.'
  )
) AS v(key, name, body)
ON CONFLICT (tenant_id, key) DO NOTHING;
