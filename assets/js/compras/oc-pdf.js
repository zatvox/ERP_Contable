// ============================================================================
// compras/oc-pdf.js — PDF de la ORDEN DE COMPRA (mismo diseño del packing)
// Emisor multiempresa (logo + color), caja de datos, tabla de líneas, total en
// letras y totales. OC de importación = bilingüe ES / EN + datos de la proforma
// (incoterm, puertos, anticipo, plazos). No cambia el estado de la OC.
// ============================================================================
import { getOrderCompraById, getOrderCompraDetalles, getItems, getContactById } from '../supabase-data.js'
import { fechaDMY, formatNumber, showToast } from '../helpers.js'
import { emisorPDF, textoSobre, tinte, _esc, numeroALetras, descargarPDFDesdeHTML, cssCabeceraPDF, htmlCabeceraPDF } from '../shared/pdf-documento.js'

const num = v => parseFloat(v) || 0
const p6 = n => num(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 })

window.imprimirOC = async function (id) {
  try {
    const oc = await getOrderCompraById(id)
    if (!oc) return showToast('Orden no encontrada', 'warning')
    showToast(`Generando PDF de ${oc.numero || 'la OC'}…`, 'info', 2500)
    const [detalles, items, prov] = await Promise.all([getOrderCompraDetalles(id), getItems(), getContactById(oc.contact_id)])
    const mapa = {}; (items || []).forEach(i => { mapa[i.id] = i })
    const imp = !!oc.es_importacion
    const L = (es, en) => imp ? `${es} / ${en}` : es            // bilingüe solo en importación
    const mon = oc.currency || 'PEN', sim = mon === 'USD' ? '$' : 'S/'
    const f = n => `${sim} ${formatNumber(n)}`
    const E = await emisorPDF(oc)
    const C = E.color, CT = textoSobre(C), C10 = tinte(C, 0.10), C25 = tinte(C, 0.25)
    const CTXT = CT === '#ffffff' ? C : '#111827'
    const base = new URL('.', location.href).href
    const lineas = (detalles || []).map(d => {
      const it = mapa[d.item_id]
      return { desc: it ? (it.sku ? `(${it.sku}) ${it.nombre || it.name}` : (it.nombre || it.name)) : `Item #${d.item_id}`,
        um: String(d.unidad_medida || 'KG').toLowerCase(), cant: num(d.cantidad), pu: num(d.precio_unitario), sub: num(d.subtotal) || num(d.cantidad) * num(d.precio_unitario),
        hs: d.partida_arancelaria || '' }
    })
    const hayHS = imp && lineas.some(l => l.hs)
    const anticipo = imp && num(oc.anticipo_porcentaje) ? num(oc.total_oc) * num(oc.anticipo_porcentaje) / 100 : 0
    // Pares etiqueta/valor de la caja (se omiten los vacíos)
    const datos = [
      [L('PROVEEDOR', 'SUPPLIER'), `${_esc(prov?.nombre || '')}<br>${prov?.nro_documento ? 'RUC / ID: ' + _esc(prov.nro_documento) : ''}`],
      [L('F. EMISIÓN', 'DATE'), _esc(fechaDMY(oc.fecha))],
      [L('DIRECCIÓN', 'ADDRESS'), _esc(prov?.direccion || '')],
      [L('MONEDA', 'CURRENCY'), mon === 'USD' ? L('DÓLARES', 'US DOLLARS') : 'SOLES'],
      [L('COND. PAGO', 'PAYMENT'), _esc(oc.tipo_pago === 'contado' ? L('Contado', 'Cash') : L('Crédito', 'Credit'))],
      imp ? ['PROFORMA (PI)', _esc(oc.numero_proforma_proveedor || '')] : null,
      imp && oc.incoterm ? ['INCOTERM', _esc(oc.incoterm)] : null,
      imp && (oc.puerto_embarque || oc.pais_origen) ? [L('PUERTO EMBARQUE', 'PORT OF LOADING'), _esc([oc.puerto_embarque, oc.pais_origen].filter(Boolean).join(' · '))] : null,
      imp && oc.puerto_destino ? [L('PUERTO DESTINO', 'DESTINATION PORT'), _esc(oc.puerto_destino)] : null,
      imp && oc.marca ? [L('MARCA', 'BRAND'), _esc(oc.marca)] : null,
      imp && anticipo ? [L('ANTICIPO', 'ADVANCE PAYMENT'), `${formatNumber(oc.anticipo_porcentaje, 0)}% = ${f(anticipo)}`] : null,
      imp && oc.dias_embarque ? [L('PLAZO EMBARQUE', 'SHIPMENT TIME'), `${_esc(oc.dias_embarque)} ${L('días', 'days')}`] : null,
      imp && oc.dias_saldo_desde_bl ? [L('SALDO', 'BALANCE'), `${_esc(oc.dias_saldo_desde_bl)} ${L('días desde B/L', 'days from B/L')}`] : null,
      imp && oc.entrega_pactada ? [L('ENTREGA PACTADA', 'DELIVERY'), _esc(fechaDMY(oc.entrega_pactada, String(oc.entrega_pactada)))] : null,
      imp && oc.validez_oferta ? [L('VALIDEZ OFERTA', 'OFFER VALIDITY'), _esc(fechaDMY(oc.validez_oferta, String(oc.validez_oferta)))] : null
    ].filter(Boolean)
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>${_esc(oc.numero)}</title><base href="${base}">
<style>
  @page { size: A4; margin: 14mm; }
  body { font-family: Arial, Helvetica, sans-serif; font-size: 11px; color:#111; }
  * { -webkit-print-color-adjust:exact; print-color-adjust:exact; }
  .box { border:1px solid ${C25}; background:${C10}; border-radius:10px; padding:8px 12px; margin-top:16px; display:grid; grid-template-columns:110px 1fr 110px 1fr; gap:5px 8px; font-size:10px; }
  .box .k { font-weight:bold; }
  table.l { width:100%; border-collapse:collapse; margin-top:16px; table-layout:auto; }
  table.l th { background:${C}; color:${CT}; padding:6px; font-size:11px; border:1px solid ${C}; }
  table.l td { border:1px solid #bbb; padding:5px 6px; }
  table.l th.n, table.l td.n { width:1%; white-space:nowrap; } table.l td.desc { word-break:break-word; }
  .r { text-align:right; } .c { text-align:center; }
  .tot { width:48%; margin-left:auto; border-collapse:collapse; margin-top:10px; }
  .tot td { border:1px solid #bbb; padding:6px 8px; } .tot td:first-child { color:${CTXT}; font-weight:bold; }
  .tot tr.t td { background:${C}; color:${CT}; font-weight:bold; }
  .letras { font-weight:bold; margin-top:14px; }
  ${cssCabeceraPDF(C, CT)}
</style></head><body>
  ${htmlCabeceraPDF(E, { colorTitulo: CTXT, titulo: L('Orden de Compra', 'Purchase Order'), numero: oc.numero || 'OC-' + oc.id, lblTelefono: L('Teléfono', 'Phone'), lblWeb: L('Sitio web', 'Website') })}
  <div class="box">${datos.map(([k, v]) => `<span class="k">${k}</span><span>${v}</span>`).join('')}</div>
  <table class="l"><thead><tr><th>${L('Descripción', 'Description')}</th>${hayHS ? '<th class="n">HS</th>' : ''}<th class="n">${L('Cantidad', 'Qty')}</th><th class="n">${L('UdM', 'Unit')}</th><th class="n">${L('Precio unit.', 'Unit price')}</th><th class="n">${L('Importe', 'Amount')}</th></tr></thead><tbody>
    ${lineas.map(l => `<tr><td class="desc">${_esc(l.desc)}</td>${hayHS ? `<td class="c n">${_esc(l.hs)}</td>` : ''}<td class="c n">${formatNumber(l.cant)}</td><td class="c n">${_esc(l.um)}</td><td class="c n">${sim} ${p6(l.pu)}</td><td class="r n">${f(l.sub)}</td></tr>`).join('')}
  </tbody></table>
  <div class="letras">${L('SON', 'SAY')}: ${numeroALetras(oc.total_oc, mon)}</div>
  <table class="tot"><tr><td>${imp ? L('SUBTOTAL', 'SUBTOTAL') : 'OP. GRAVADA'}</td><td class="r">${f(oc.total_subtotal)}</td></tr>
    ${num(oc.total_igv) || !imp ? `<tr><td>IGV</td><td class="r">${f(oc.total_igv)}</td></tr>` : ''}
    <tr class="t"><td>TOTAL</td><td class="r">${f(oc.total_oc)}</td></tr></table>
  ${oc.tipo_pago ? `<p style="margin-top:18px;">${L('Condición de pago', 'Payment terms')}: ${_esc(oc.tipo_pago === 'contado' ? L('Contado', 'Cash') : L('Crédito', 'Credit'))}${anticipo ? ` · ${L('Anticipo', 'Advance')} ${formatNumber(oc.anticipo_porcentaje, 0)}%` : ''}</p>` : ''}
</body></html>`
    window._ocHtmlUltimo = html   // para revisión visual
    await descargarPDFDesdeHTML(html, `${oc.numero || 'OC-' + oc.id}_${String(prov?.nombre || '').replace(/[^\w]+/g, '_').slice(0, 40)}.pdf`)
  } catch (e) { console.error('imprimirOC:', e); showToast('Error al generar PDF: ' + e.message, 'danger') }
}
