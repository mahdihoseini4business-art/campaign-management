import { getShippingSender } from './data.js'
import { escapeHtml } from './utils.js'

export function isShippingSenderConfigured(sender = getShippingSender()) {
  return !!(sender?.name && sender?.address)
}

function dash(value) {
  const s = String(value || '').trim()
  return s || '—'
}

function partyBlock(title, party, { logoDataUrl } = {}) {
  const logo = logoDataUrl
    ? `<img class="sl-logo" src="${logoDataUrl}" alt="">`
    : ''
  return `
    <section class="sl-party">
      <div class="sl-party-head">
        <h2>${escapeHtml(title)}</h2>
        ${logo}
      </div>
      <div class="sl-field"><span class="sl-k">نام</span><span class="sl-v">${escapeHtml(dash(party?.name))}</span></div>
      <div class="sl-field"><span class="sl-k">تلفن</span><span class="sl-v sl-ltr">${escapeHtml(dash(party?.phone))}</span></div>
      <div class="sl-field"><span class="sl-k">آدرس</span><span class="sl-v">${escapeHtml(dash(party?.address))}</span></div>
      <div class="sl-field"><span class="sl-k">کد پستی</span><span class="sl-v sl-ltr">${escapeHtml(dash(party?.postalCode))}</span></div>
    </section>`
}

export function buildLabelHtml({ sender, recipient, trackingCode }) {
  return `
    <article class="sl-label">
      ${partyBlock('فرستنده', sender, { logoDataUrl: sender?.logoDataUrl || null })}
      <hr class="sl-divider">
      ${partyBlock('گیرنده', recipient)}
      <div class="sl-tracking">
        <span class="sl-tracking-label">کد رهگیری</span>
        <span class="sl-tracking-value">${escapeHtml(dash(trackingCode))}</span>
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
    @page { size: A5; margin: 10mm; }
    * { box-sizing: border-box; }
    html, body {
      margin: 0;
      padding: 0;
      background: #fff;
      color: #111;
      font-family: 'Vazirmatn', Tahoma, sans-serif;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }
    .sl-label {
      width: 100%;
      min-height: calc(210mm - 20mm);
      padding: 4mm;
      border: 1.5pt solid #222;
      display: flex;
      flex-direction: column;
      gap: 4mm;
      page-break-after: always;
      break-after: page;
    }
    .sl-label:last-child {
      page-break-after: auto;
      break-after: auto;
    }
    .sl-party { flex: 1; }
    .sl-party-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      margin-bottom: 3mm;
      border-bottom: 1px solid #ccc;
      padding-bottom: 2mm;
    }
    .sl-party-head h2 {
      margin: 0;
      font-size: 14pt;
      font-weight: 700;
    }
    .sl-logo {
      max-height: 18mm;
      max-width: 42mm;
      object-fit: contain;
    }
    .sl-field {
      display: grid;
      grid-template-columns: 22mm 1fr;
      gap: 2mm 3mm;
      margin: 1.5mm 0;
      font-size: 11pt;
      line-height: 1.55;
      align-items: start;
    }
    .sl-k {
      color: #555;
      font-size: 9.5pt;
      font-weight: 600;
    }
    .sl-v { word-break: break-word; }
    .sl-ltr { direction: ltr; text-align: right; unicode-bidi: isolate; }
    .sl-divider {
      border: none;
      border-top: 1.5pt dashed #333;
      margin: 1mm 0;
    }
    .sl-tracking {
      margin-top: auto;
      border: 1.5pt solid #222;
      padding: 3mm 4mm;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      background: #f5f5f5;
    }
    .sl-tracking-label {
      font-size: 10pt;
      font-weight: 700;
    }
    .sl-tracking-value {
      font-size: 14pt;
      font-weight: 700;
      letter-spacing: 0.04em;
      direction: ltr;
      unicode-bidi: isolate;
    }
  </style>
</head>
<body>
${labelsHtml}
</body>
</html>`
}

/**
 * @param {Array<{ recipient: object, trackingCode?: string }>} items
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
    recipient: item.recipient || {},
    trackingCode: item.trackingCode || ''
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

  // Wait for font/stylesheet when possible
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
    },
    trackingCode: shipment.trackingCode || ''
  }
}
