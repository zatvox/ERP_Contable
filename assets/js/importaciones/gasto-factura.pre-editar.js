// ============================================================================
// gasto-factura.js — «Registrar gasto»: la factura de un gasto local de importación
// pasa a ser una COMPRA de servicio/gasto (Registro de Compras + IGV crédito fiscal + CxP)
// ----------------------------------------------------------------------------
// Parte de una línea del ledger (importacion_costos + documentos_importacion) que
// hoy solo vive en el costeo. Al registrar:
//   1. compras (tipo_compra 'servicio', carpeta_importacion_id) + detalle (ítem 1 = glosa)
//   2. cuentas_pagar pendiente al emisor real de la factura
//   3. documentos_importacion: compra_id, cxp_id, base / IGV / total correctos,
//      regularizacion = 'pendiente' (se concilia luego en CxP con el abono a la liquidación)
//   4. importacion_costos: monto = BASE sin IGV, igv_monto = IGV (una sola fuente)
//   5. abonos de la liquidación del agente → 'pendiente' de regularizar
// Uso: window.abrirGastoFactura(costoId)  ·  API sin pantalla: registrarGastoFactura({...})
// ============================================================================
import { query, update, esperarContextoEmpresa } from '../supabase-client.js'
import { getCurrentUser } from '../auth-supabase.js'
import { showToast, formatNumber } from '../helpers.js'
import { convertirEnBuscador, refrescarBuscador } from '../buscador-select.js'
import { getTipoCambioDia } from '../sunat-api.js'
import { getSuppliers, getContactById, addCompra, addCompraDetalle, addCuentaPagar, getCuentasGasto,
         subirAdjuntoCompra, subirAdjuntos } from '../supabase-data.js'

const num = x => { const n = parseFloat(String(x ?? '').replace(/,/g, '')); return isNaN(n) ? 0 : n }
const r2 = x => Math.round((num(x) + Number.EPSILON) * 100) / 100
const n2 = x => formatNumber(num(x), 2)
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const $ = id => document.getElementById(id)

// Cuenta de gasto sugerida según el concepto del ledger (el usuario puede cambiarla).
const CUENTA_POR_CONCEPTO = {
  transporte_local: '631111', almacen: '632917', sobreestadia: '632917',
  comision_aduanas: '638211', agenciamiento: '638211', gastos_destino: '638211',
  gate_in: '638211', visto_bueno: '638211', thc: '638211', otro: '638111', interes: '638111'
}
const TIPOS = [['01', 'Factura'], ['03', 'Boleta de venta'], ['02', 'Recibo por honorarios'], ['12', 'Ticket / otro']]

let _ctx = null // { costo, doc, cuentas, proveedores }

// ── Núcleo (sin pantalla) ─────────────────────────────────────────────────────
export async function registrarGastoFactura(p) {
  await esperarContextoEmpresa()
  const user = await getCurrentUser()
  const costo = (await query('importacion_costos', { id: p.costoId }))?.[0]
  if (!costo) throw new Error('No se encontró la línea de costo')
  const doc = costo.documento_id ? (await query('documentos_importacion', { id: costo.documento_id }))?.[0] : null
  if (!doc) throw new Error('La línea no tiene documento')
  if (doc.compra_id) throw new Error('Este gasto ya tiene su compra registrada (#' + doc.compra_id + ')')
  if (!p.proveedorId) throw new Error('Elige el proveedor')
  if (!p.serie || !p.numero) throw new Error('Falta serie y número de la factura')
  if (!p.fecha) throw new Error('Falta la fecha de emisión')
  if (!p.glosa) throw new Error('Falta la glosa (concepto del gasto)')
  if (!p.cuentaCodigo) throw new Error('Elige la cuenta de gasto')
  const moneda = p.moneda || 'USD'
  const tc = moneda === 'USD' ? num(p.tc) : 1
  if (moneda === 'USD' && tc <= 1) throw new Error('Falta el tipo de cambio')

  const base = r2(p.base)
  const igvPct = num(p.igvPct)
  const igv = p.igv != null && p.igv !== '' ? r2(p.igv) : r2(base * igvPct / 100)
  const total = r2(base + igv)
  if (base <= 0) throw new Error('La base imponible debe ser mayor a 0')

  // ¿Ya está esa factura en el Registro de Compras?
  const previas = (await query('compras', { contact_id: p.proveedorId, serie: p.serie, numero: p.numero })) || []
  if (previas.some(c => c.tipo_comprobante === (p.tipoComprobante || '01') && c.comprobante_anulado !== true)) {
    throw new Error(`La factura ${p.serie}-${p.numero} de este proveedor ya existe en el Registro de Compras`)
  }

  const prov = await getContactById(p.proveedorId)
  const cuenta = (await getCuentasGasto()).find(c => c.codigo === p.cuentaCodigo)
  const carpeta = (await query('carpetas_importacion', { id: costo.carpeta_importacion_id }))?.[0]
  const refCarpeta = carpeta?.numero_carpeta ? ` · Carpeta ${carpeta.numero_carpeta}` : ''

  const compra = await addCompra({
    referencia: `${p.serie}-${p.numero}`,
    tipo_referencia: 'compra_directa',
    tipo_comprobante: p.tipoComprobante || '01',
    serie: p.serie, numero: p.numero,
    periodo_mes: parseInt(p.fecha.slice(5, 7)), periodo_ano: parseInt(p.fecha.slice(0, 4)),
    fecha_emision: p.fecha, fecha_recepcion: p.fecha,
    contact_id: p.proveedorId,
    proveedor_ruc: prov?.nro_documento || '-', proveedor_nombre: prov?.nombre || '-',
    tipo_compra: 'servicio',
    descripcion: `${p.glosa}${refCarpeta} [Cuenta: ${cuenta ? cuenta.codigo + ' ' + cuenta.nombre : p.cuentaCodigo}]`,
    unidad_medida: 'UND', cantidad: 1, precio_unitario: base,
    base_imponible_gravada: igv > 0 ? base : 0, monto_exonerado: igv > 0 ? 0 : base,
    igv_gravado: igv, subtotal: base, total,
    currency: moneda, tipo_cambio: tc,
    estado_pago: 'pendiente', asiento_id: null,
    carpeta_importacion_id: costo.carpeta_importacion_id,
    empresa_id: doc.empresa_id ?? undefined,
    created_by: user?.db_id
  })
  if (!compra?.id) throw new Error('No se pudo registrar la compra (¿referencia duplicada?)')

  await addCompraDetalle({
    compra_id: compra.id, item_id: null, descripcion: p.glosa, unidad_medida: 'UND', cantidad: 1,
    precio_unitario: base, subtotal: base, tipo_base: igv > 0 ? 'gravada' : 'exonerada',
    igv_porcentaje: igv > 0 ? (igvPct || 18) : 0, igv_monto: igv, total_linea: total
  })

  let cxp = null
  if ((p.tipoComprobante || '01') === '01') {
    cxp = await addCuentaPagar({
      contact_id: p.proveedorId, compra_id: compra.id, tipo_comprobante: '01',
      serie: p.serie, numero_comprobante: p.numero, fecha_emision: p.fecha, fecha_vencimiento: null,
      moneda, tipo_cambio: tc, monto_total: total, monto_pagado: 0, estado: 'pendiente',
      observaciones: p.regularizar === false ? null : `Pendiente de regularizar · pagado por el agente en su liquidación${refCarpeta}`,
      empresa_id: doc.empresa_id ?? undefined, created_by: user?.db_id
    })
  }

  // Documento del ledger: importes correctos + enlaces
  const cambiosDoc = {
    proveedor_id: p.proveedorId, tipo_comprobante: p.tipoComprobante || '01', serie: p.serie, numero: p.numero,
    fecha_emision: p.fecha, moneda, tipo_cambio: tc, monto_sin_igv: base, igv_monto: igv, monto_total: total,
    compra_id: compra.id, cxp_id: cxp?.id ?? null, sustentado: true
  }
  if (p.regularizar !== false) cambiosDoc.regularizacion = 'pendiente'
  let okDoc = await update('documentos_importacion', doc.id, cambiosDoc)
  if (!okDoc && cambiosDoc.regularizacion) { // ¿falta correr el SQL 122?
    delete cambiosDoc.regularizacion
    okDoc = await update('documentos_importacion', doc.id, cambiosDoc)
    if (okDoc) showToast('Compra registrada. Falta correr el SQL 122 para marcar «pendiente de regularizar».', 'warning', 7000)
  }
  if (!okDoc) throw new Error('La compra #' + compra.id + ' se creó pero no se pudo enlazar al documento del costeo')

  // Línea de costo: BASE sin IGV + IGV aparte (el costo ya no arrastra el IGV dentro del monto)
  await update('importacion_costos', costo.id, { moneda, tipo_cambio: tc, monto_moneda: base, igv_monto: igv })

  // Adjuntos (factura): a la compra y al documento del costeo
  if (p.archivo) {
    try { await subirAdjuntoCompra(compra.id, p.archivo) } catch (e) { showToast(e.message || 'No se pudo adjuntar a la compra', 'warning') }
    try { await subirAdjuntos('documento_importacion', doc.id, [{ file: p.archivo, concepto: 'factura_gasto' }], user?.db_id) } catch (e) { console.warn('adjunto doc', e) }
  }

  // Abonos de la liquidación del agente → pendientes de regularizar
  if (p.regularizar !== false && costo.liquidacion_agente_id) {
    try {
      const abonos = (await query('importacion_liquidacion_abonos', { liquidacion_agente_id: costo.liquidacion_agente_id })) || []
      for (const a of abonos.filter(a => a.concepto !== 'proforma' && !a.regularizacion)) {
        await update('importacion_liquidacion_abonos', a.id, { regularizacion: 'pendiente' })
      }
    } catch (e) { console.warn('abonos regularizar', e) }
  }
  return { compraId: compra.id, cxpId: cxp?.id ?? null, base, igv, total }
}

// ── Pantalla ─────────────────────────────────────────────────────────────────
function _asegurarModal() {
  if ($('modal-gasto-factura')) return
  const opt = (arr, sel) => arr.map(([k, v]) => `<option value="${k}" ${k === sel ? 'selected' : ''}>${v}</option>`).join('')
  document.body.insertAdjacentHTML('beforeend', `
  <div id="modal-gasto-factura" class="modal" style="z-index:2400;">
    <div class="modal-content" style="width:min(96vw, 860px); max-width:min(96vw, 860px); max-height:calc(100vh - 48px); overflow-y:auto;">
      <div class="modal-header">
        <h3 class="modal-title">🧾 Registrar gasto · factura del proveedor</h3>
        <button class="modal-close" onclick="window.cerrarGastoFactura()">&times;</button>
      </div>
      <div style="padding:14px 20px 4px;">
        <div id="gfInfo" class="dm-nota" style="margin-bottom:8px;"></div>

        <strong class="mod-sec">Comprobante</strong>
        <div style="display:grid; grid-template-columns:2fr 1.2fr 0.7fr 1fr; gap:10px;">
          <div class="form-group"><label>Proveedor (emisor) *</label><select id="gfProveedor"><option value="">— Selecciona —</option></select></div>
          <div class="form-group"><label>Tipo de comprobante</label><select id="gfTipo">${opt(TIPOS, '01')}</select></div>
          <div class="form-group"><label>Serie *</label><input type="text" id="gfSerie" maxlength="8" placeholder="F001"></div>
          <div class="form-group"><label>Número *</label><input type="text" id="gfNumero" maxlength="20" placeholder="00007419"></div>
        </div>
        <div style="display:grid; grid-template-columns:1fr 0.8fr 1fr 2fr; gap:10px;">
          <div class="form-group"><label>Fecha de emisión *</label><input type="date" id="gfFecha" onchange="window.gfTCAuto()"></div>
          <div class="form-group"><label>Moneda</label><select id="gfMoneda" onchange="window.gfOnMoneda()"><option value="USD">USD</option><option value="PEN">PEN</option></select></div>
          <div class="form-group"><label>T.C. venta SUNAT <button type="button" class="btn btn-secondary btn-small" onclick="window.gfTCAuto(true)" title="Consultar el T.C. de la fecha">⟳</button></label><input type="number" id="gfTC" step="0.001"></div>
          <div class="form-group"><label>Cuenta de gasto *</label><select id="gfCuenta"><option value="">— Selecciona —</option></select></div>
        </div>

        <strong class="mod-sec">Ítem 1 · glosa del gasto <span class="bl-en">(hereda el concepto del costeo)</span></strong>
        <div class="form-group"><input type="text" id="gfGlosa" maxlength="200"></div>

        <strong class="mod-sec">Importes</strong>
        <div style="display:grid; grid-template-columns:repeat(4, 1fr); gap:10px;">
          <div class="form-group"><label>Base imponible *</label><input type="number" id="gfBase" step="0.01" oninput="window.gfCalc('base')"></div>
          <div class="form-group"><label>IGV</label><select id="gfIgvPct" onchange="window.gfCalc('base')"><option value="18">18 %</option><option value="0">Exonerado / sin IGV</option></select></div>
          <div class="form-group"><label>Monto IGV</label><input type="number" id="gfIgv" step="0.01" oninput="window.gfCalc('igv')"></div>
          <div class="form-group"><label>Total del comprobante</label><input type="number" id="gfTotal" step="0.01" oninput="window.gfCalc('total')"></div>
        </div>
        <div id="gfHint" style="font-size:.78rem; color:var(--text-secondary); margin:-2px 0 6px;"></div>

        <strong class="mod-sec">Documento</strong>
        <div class="form-group"><label>Factura (PDF / imagen) <span class="bl-en">(opcional · si aún no llegó, se sube después)</span></label><input type="file" id="gfArchivo" accept="application/pdf,image/jpeg,image/png"></div>
        <div style="display:flex; gap:8px; align-items:center; font-size:.85rem; margin:8px 0 2px;"><input type="checkbox" id="gfRegul" checked style="width:auto; margin:0;"><span>Pagada por el agente en su liquidación → dejar <b>pendiente de regularizar</b> (se concilia en CxP)</span></div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" onclick="window.cerrarGastoFactura()">Cancelar</button>
        <button class="btn btn-primary" id="gfGuardar" onclick="window.guardarGastoFactura()">💾 Registrar compra del gasto</button>
      </div>
    </div>
  </div>`)
  convertirEnBuscador($('gfProveedor'), { placeholder: 'Buscar por nombre o RUC…' })
}

window.gfCalc = function (origen) {
  const pct = num($('gfIgvPct').value)
  if (origen === 'base') {
    const b = num($('gfBase').value); const i = r2(b * pct / 100)
    $('gfIgv').value = b ? i.toFixed(2) : ''; $('gfTotal').value = b ? r2(b + i).toFixed(2) : ''
  } else if (origen === 'igv') {
    const b = num($('gfBase').value); $('gfTotal').value = b ? r2(b + num($('gfIgv').value)).toFixed(2) : ''
  } else if (origen === 'total') {
    const t = num($('gfTotal').value); const b = r2(t / (1 + pct / 100))
    $('gfBase').value = t ? b.toFixed(2) : ''; $('gfIgv').value = t ? r2(t - b).toFixed(2) : ''
  }
}
window.gfOnMoneda = () => { const usd = $('gfMoneda').value === 'USD'; $('gfTC').disabled = !usd; if (!usd) $('gfTC').value = 1; else window.gfTCAuto() }
window.gfTCAuto = async function (forzar) {
  if ($('gfMoneda').value !== 'USD') return
  const f = $('gfFecha').value; if (!f) return
  if (!forzar && $('gfTC').value && $('gfTC').dataset.fecha === f) return
  try {
    const r = await getTipoCambioDia(f)
    if (r && r.venta) { $('gfTC').value = r.venta; $('gfTC').dataset.fecha = f }
    else if (forzar) showToast(r?.error || 'Sin T.C. para esa fecha', 'warning')
  } catch (e) { if (forzar) showToast('No se pudo consultar el T.C.', 'warning') }
}
window.cerrarGastoFactura = () => window.closeModal('modal-gasto-factura')

window.abrirGastoFactura = async function (costoId) {
  try {
    await esperarContextoEmpresa()
    const costo = (await query('importacion_costos', { id: costoId }))?.[0]
    if (!costo) { showToast('No se encontró el gasto', 'warning'); return }
    const doc = costo.documento_id ? (await query('documentos_importacion', { id: costo.documento_id }))?.[0] : null
    if (!doc) { showToast('Este gasto no tiene documento', 'warning'); return }
    if (doc.compra_id) { showToast('Este gasto ya tiene su compra registrada (#' + doc.compra_id + ')', 'info'); return }
    _asegurarModal()
    const [provs, cuentas] = await Promise.all([getSuppliers(), getCuentasGasto()])
    _ctx = { costo, doc }
    const sp = $('gfProveedor')
    sp.innerHTML = '<option value="">— Selecciona —</option>' + (provs || []).map(p => `<option value="${p.id}">${esc(p.nombre)}${p.nro_documento ? ' · ' + esc(p.nro_documento) : ''}</option>`).join('')
    sp.value = doc.proveedor_id ? String(doc.proveedor_id) : ''
    refrescarBuscador(sp)
    const sc = $('gfCuenta'), sug = CUENTA_POR_CONCEPTO[costo.concepto_codigo] || ''
    sc.innerHTML = '<option value="">— Selecciona —</option>' + (cuentas || []).map(c => `<option value="${esc(c.codigo)}">${esc(c.codigo)} ${esc(c.nombre)}</option>`).join('')
    sc.value = sug
    $('gfTipo').value = doc.tipo_comprobante || '01'
    $('gfSerie').value = doc.serie || ''; $('gfNumero').value = doc.numero || ''
    $('gfFecha').value = doc.fecha_emision || ''
    $('gfMoneda').value = costo.moneda || doc.moneda || 'USD'
    $('gfTC').value = costo.moneda === 'PEN' ? 1 : (num(costo.tipo_cambio) || ''); $('gfTC').dataset.fecha = ''
    $('gfGlosa').value = costo.concepto || ''
    $('gfIgvPct').value = '18'
    // Si ya hay IGV separado: base = monto. Si no (IGV 0): el importe registrado es el total de la factura.
    const monto = num(costo.monto_moneda), igv = num(costo.igv_monto)
    if (igv > 0) { $('gfBase').value = monto.toFixed(2); window.gfCalc('base'); $('gfIgv').value = igv.toFixed(2); window.gfCalc('igv') }
    else { $('gfTotal').value = monto.toFixed(2); window.gfCalc('total') }
    $('gfHint').textContent = igv > 0
      ? `En el costeo hoy: base ${n2(monto)} + IGV ${n2(igv)}.`
      : `En el costeo hoy: ${n2(monto)} sin IGV separado → se tomó como TOTAL de la factura. Verifícalo con el comprobante.`
    $('gfInfo').innerHTML = `<b>${esc(costo.concepto)}</b> · el costeo tomará la <b>base sin IGV</b>; el IGV va a crédito fiscal y la factura al Registro de Compras y a Cuentas por Pagar.`
    $('gfArchivo').value = ''; $('gfRegul').checked = !!costo.liquidacion_agente_id
    window.gfOnMoneda()
    window.openModal('modal-gasto-factura')
    const m = $('modal-gasto-factura'); if (m) { document.body.appendChild(m); m.style.zIndex = 2400 }
  } catch (e) { console.error('abrirGastoFactura', e); showToast(e.message || 'No se pudo abrir el gasto', 'danger') }
}

window.guardarGastoFactura = async function () {
  const btn = $('gfGuardar'); if (!_ctx) return
  try {
    btn.disabled = true; btn.textContent = 'Registrando…'
    const r = await registrarGastoFactura({
      costoId: _ctx.costo.id, proveedorId: parseInt($('gfProveedor').value) || null, tipoComprobante: $('gfTipo').value,
      serie: $('gfSerie').value.trim().toUpperCase(), numero: $('gfNumero').value.trim(), fecha: $('gfFecha').value,
      moneda: $('gfMoneda').value, tc: $('gfTC').value, glosa: $('gfGlosa').value.trim(), cuentaCodigo: $('gfCuenta').value,
      base: $('gfBase').value, igvPct: $('gfIgvPct').value, igv: $('gfIgv').value,
      archivo: $('gfArchivo').files?.[0] || null, regularizar: $('gfRegul').checked
    })
    showToast(`Compra #${r.compraId} registrada · base ${n2(r.base)} + IGV ${n2(r.igv)} = ${n2(r.total)}`, 'success')
    window.cerrarGastoFactura()
    try { await window._alGuardarCosto?.() } catch (e2) { console.warn('alGuardarCosto', e2) }
    window.renderCostosLedger?.(); window.renderHojaCosteo?.()
  } catch (e) {
    console.error('guardarGastoFactura', e); showToast(e.message || 'No se pudo registrar el gasto', 'danger')
  } finally { btn.disabled = false; btn.textContent = '💾 Registrar compra del gasto' }
}

window.registrarGastoFactura = registrarGastoFactura
export default { abrirGastoFactura: window.abrirGastoFactura, registrarGastoFactura }
