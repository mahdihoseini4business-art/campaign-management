import { getShippingSender } from './data.js'
import { escapeHtml } from './utils.js'

export function isShippingSenderConfigured(sender = getShippingSender()) {
  return !!(sender?.name && sender?.address)
}

function dash(value) {
  const s = String(value || '').trim()
  return s || '—'
}

function formatPostalDisplay(postalCode) {
  const digits = String(postalCode || '').replace(/\D/g, '')
  if (!digits) return null
  // 10-digit Iranian postal: 12345-67890
  if (digits.length === 10) return `${digits.slice(0, 5)}-${digits.slice(5)}`
  return digits
}

function partyBlock(title, party, { logoDataUrl, emphasize = false } = {}) {
  const logo = logoDataUrl
    ? `<div class="sl-logo-wrap"><img class="sl-logo" src="${logoDataUrl}" alt=""></div>`
    : ''
  const postal = formatPostalDisplay(party?.postalCode)
  const postalHtml = postal
    ? `<div class="sl-postal" aria-label="کد پستی">
        <span class="sl-postal-label">کد پستی</span>
        <span class="sl-postal-value">${escapeHtml(postal)}</span>
      </div>`
    : `<div class="sl-postal sl-postal-empty">
        <span class="sl-postal-label">کد پستی</span>
        <span class="sl-postal-value">—</span>
      </div>`

  return `
    <section class="sl-party${emphasize ? ' sl-party-emphasis' : ''}">
      <header class="sl-party-head">
        <span class="sl-badge">${escapeHtml(title)}</span>
        ${logo}
      </header>
      <div class="sl-name">${escapeHtml(dash(party?.name))}</div>
      <div class="sl-phone sl-ltr">${escapeHtml(dash(party?.phone))}</div>
      <div class="sl-address">${escapeHtml(dash(party?.address))}</div>
      ${postalHtml}
    </section>`
}

export function buildLabelHtml({ sender, recipient }) {
  return `
    <article class="sl-label">
      <div class="sl-frame">
        ${partyBlock('فرستنده', sender, { logoDataUrl: sender?.logoDataUrl || null })}
        <div class="sl-divider" role="separator">
          <span class="sl-divider-mark"></span>
        </div>
        ${partyBlock('گیرنده', recipient, { emphasize: true })}
      </div>
    </article>`
}

function buildPrintDocument(labelsHtml) {
  const fontHref = new URL('/fonts/vazirmatn.css', window.location.origin).href
  return `<!DOCTYPE html>
<html lang="fa" dir="rtl">
<head>
  <meta charset="utf-8">
  <title>لیبل پستی</title>
  <link rel="stylesheet" href="${fontHref}">
  <style>
    @page { size: A5; margin: 8mm; }
    * { box-sizing: border-box; }
    html, body {
      margin: 0;
      padding: 0;
      background: #fff;
      color: #1a1a1a;
      font-family: 'Vazirmatn', Tahoma, sans-serif;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }
    .sl-label {
      width: 100%;
      min-height: calc(210mm - 16mm);
      padding: 2mm;
      page-break-after: always;
      break-after: page;
    }
    .sl-label:last-child {
      page-break-after: auto;
      break-after: auto;
    }
    .sl-frame {
      height: 100%;
      min-height: calc(210mm - 20mm);
      border: 1.25pt solid #222;
      outline: 3.5pt solid #222;
      outline-offset: 2.5mm;
      padding: 6mm 7mm;
      display: flex;
      flex-direction: column;
      gap: 0;
    }
    .sl-party {
      flex: 0 0 auto;
    }
    .sl-party-emphasis {
      flex: 1 1 auto;
      display: flex;
      flex-direction: column;
      padding-top: 1mm;
    }
    .sl-party-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      margin-bottom: 3.5mm;
    }
    .sl-badge {
      display: inline-block;
      font-size: 9pt;
      font-weight: 700;
      letter-spacing: 0.06em;
      color: #fff;
      background: #222;
      padding: 1.6mm 4mm;
      border-radius: 2px;
    }
    .sl-party-emphasis .sl-badge {
      background: #111;
      font-size: 10pt;
      padding: 2mm 5mm;
    }
    .sl-logo-wrap {
      width: 28mm;
      height: 16mm;
      display: flex;
      align-items: center;
      justify-content: flex-end;
    }
    .sl-logo {
      max-height: 16mm;
      max-width: 28mm;
      object-fit: contain;
    }
    .sl-name {
      font-size: 13pt;
      font-weight: 700;
      line-height: 1.35;
      margin-bottom: 1.5mm;
    }
    .sl-party-emphasis .sl-name {
      font-size: 18pt;
      margin-bottom: 2.5mm;
    }
    .sl-phone {
      font-size: 11pt;
      color: #333;
      margin-bottom: 2.5mm;
      font-weight: 500;
    }
    .sl-party-emphasis .sl-phone {
      font-size: 12.5pt;
      margin-bottom: 3.5mm;
    }
    .sl-address {
      font-size: 10.5pt;
      line-height: 1.7;
      color: #222;
      word-break: break-word;
      margin-bottom: 4mm;
    }
    .sl-party-emphasis .sl-address {
      font-size: 12.5pt;
      line-height: 1.75;
      flex: 1 1 auto;
      margin-bottom: 5mm;
    }
    .sl-ltr {
      direction: ltr;
      text-align: right;
      unicode-bidi: isolate;
    }
    .sl-postal {
      margin-top: auto;
      border: 1.25pt solid #222;
      display: flex;
      align-items: stretch;
      overflow: hidden;
      background: #fafafa;
    }
    .sl-postal-label {
      flex: 0 0 auto;
      background: #222;
      color: #fff;
      font-size: 9pt;
      font-weight: 700;
      padding: 2.5mm 3.5mm;
      display: flex;
      align-items: center;
    }
    .sl-postal-value {
      flex: 1 1 auto;
      font-size: 16pt;
      font-weight: 700;
      letter-spacing: 0.12em;
      padding: 2.5mm 4mm;
      direction: ltr;
      text-align: center;
      unicode-bidi: isolate;
      font-variant-numeric: tabular-nums;
    }
    .sl-party-emphasis .sl-postal-value {
      font-size: 20pt;
      letter-spacing: 0.16em;
      padding: 3.5mm 4mm;
    }
    .sl-postal-empty .sl-postal-value {
      color: #999;
      letter-spacing: 0;
    }
    .sl-divider {
      position: relative;
      height: 8mm;
      display: flex;
      align-items: center;
      margin: 2mm 0 3mm;
    }
    .sl-divider::before {
      content: '';
      position: absolute;
      inset-inline: 0;
      top: 50%;
      border-top: 1.5pt dashed #444;
    }
    .sl-divider-mark {
      position: relative;
      z-index: 1;
      width: 7mm;
      height: 7mm;
      margin: 0 auto;
      background: #fff;
      border: 1.25pt solid #222;
      border-radius: 50%;
      box-shadow: inset 0 0 0 1.5pt #fff, inset 0 0 0 2.5pt #222;
    }
  </style>
</head>
<body>
${labelsHtml}
</body>
</html>`
}

/**
 * @param {Array<{ recipient: object }>} items
 * @returns {{ ok: true } | { ok: false, reason: 'empty' | 'sender_incomplete' }}
 */
export function printShippingLabels(items) {
  const list = Array.isArray(items) ? items.filter(Boolean) : []
  if (!list.length) return { ok: false, reason: 'empty' }

  const sender = getShippingSender()
  if (!isShippingSenderConfigured(sender)) {
    return { ok: false, reason: 'sender_incomplete' }
  }

  const labelsHtml = list.map(item => buildLabelHtml({
    sender,
    recipient: item.recipient || {}
  })).join('\n')

  const docHtml = buildPrintDocument(labelsHtml)
  const iframe = document.createElement('iframe')
  iframe.setAttribute('aria-hidden', 'true')
  iframe.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;opacity:0;pointer-events:none;'
  document.body.appendChild(iframe)

  const win = iframe.contentWindow
  const doc = iframe.contentDocument || win?.document
  if (!win || !doc) {
    iframe.remove()
    return { ok: false, reason: 'empty' }
  }

  doc.open()
  doc.write(docHtml)
  doc.close()

  const cleanup = () => {
    try { iframe.remove() } catch (_) { /* ignore */ }
  }

  const triggerPrint = () => {
    try {
      win.focus()
      win.print()
    } finally {
      setTimeout(cleanup, 1000)
    }
  }

  const fontsReady = doc.fonts?.ready
  if (fontsReady && typeof fontsReady.then === 'function') {
    fontsReady.then(triggerPrint).catch(triggerPrint)
  } else {
    setTimeout(triggerPrint, 250)
  }

  return { ok: true }
}

export function shipmentToLabelItem(shipment) {
  if (!shipment) return null
  return {
    recipient: {
      name: shipment.customerName || '',
      phone: shipment.customerPhone || (shipment.customerPhones && shipment.customerPhones[0]) || '',
      address: shipment.shippingAddress || '',
      postalCode: shipment.shippingPostalCode || ''
    }
  }
}
