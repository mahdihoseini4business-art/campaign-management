import { getShippingSender } from './data.js'
import { escapeHtml } from './utils.js'

export function isShippingSenderConfigured(sender = getShippingSender()) {
  return !!(sender?.name && sender?.address)
}

function dash(value) {
  const s = String(value || '').trim()
  return s || '—'
}

function partyBlock(title, party) {
  return `
    <section class="sl-party">
      <div class="sl-title">${escapeHtml(title)}</div>
      <div>${escapeHtml(dash(party?.name))}</div>
      <div class="sl-ltr">${escapeHtml(dash(party?.phone))}</div>
      <div class="sl-address">${escapeHtml(dash(party?.address))}</div>
      <div class="sl-ltr">کد پستی: ${escapeHtml(dash(party?.postalCode))}</div>
    </section>`
}

export function buildLabelHtml({ sender, recipient }) {
  const logo = sender?.logoDataUrl
    ? `<div class="sl-logo-row"><img class="sl-logo" src="${sender.logoDataUrl}" alt=""></div>`
    : ''
  return `
    <article class="sl-label">
      <div class="sl-stack">
        ${logo}
        ${partyBlock('فرستنده', sender)}
        <hr class="sl-hr">
        ${partyBlock('گیرنده', recipient)}
      </div>
    </article>`
}

function buildPrintDocument(labelsHtml, orientation = 'portrait') {
  const fontHref = new URL('/fonts/vazirmatn.css', window.location.origin).href
  const isLandscape = orientation === 'landscape'
  const pageSize = isLandscape ? 'A5 landscape' : 'A5 portrait'
  // A5: 148×210mm — lock exact page height so content cannot spill to sheet 2
  const pageHeight = isLandscape ? '148mm' : '210mm'

  return `<!DOCTYPE html>
<html lang="fa" dir="rtl">
<head>
  <meta charset="utf-8">
  <title></title>
  <link rel="stylesheet" href="${fontHref}">
  <style>
    @page { size: ${pageSize}; margin: 0; }
    * { box-sizing: border-box; }
    html, body {
      margin: 0;
      padding: 0;
      width: 100%;
      height: 100%;
      background: #fff;
      color: #000;
      font-family: 'Vazirmatn', Tahoma, sans-serif;
      font-size: 11pt;
      line-height: 1.45;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }
    .sl-label {
      width: 100%;
      height: ${pageHeight};
      max-height: ${pageHeight};
      overflow: hidden;
      padding: 4mm;
      display: flex;
      flex-direction: column;
      page-break-after: always;
      break-after: page;
      page-break-inside: avoid;
      break-inside: avoid;
    }
    .sl-label:last-child {
      page-break-after: auto;
      break-after: auto;
    }
    .sl-stack {
      flex: 1 1 auto;
      min-height: 0;
      width: 100%;
      border: 1.5pt solid #000;
      padding: 5mm;
      display: flex;
      flex-direction: column;
      justify-content: center;
      overflow: hidden;
    }
    .sl-party { margin: 0; }
    .sl-title {
      font-size: 16.5pt;
      font-weight: 800;
      margin-bottom: 2px;
    }
    .sl-logo-row {
      text-align: center;
      margin-bottom: 3mm;
    }
    .sl-logo {
      max-height: 21mm;
      max-width: 48mm;
      object-fit: contain;
    }
    .sl-address { word-break: break-word; }
    .sl-ltr {
      direction: ltr;
      text-align: right;
      unicode-bidi: isolate;
    }
    .sl-hr {
      border: none;
      border-top: 1px solid #000;
      margin: 4mm 0;
      flex-shrink: 0;
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

  const docHtml = buildPrintDocument(labelsHtml, sender.orientation || 'portrait')
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
  try { doc.title = '' } catch (_) { /* ignore */ }

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
