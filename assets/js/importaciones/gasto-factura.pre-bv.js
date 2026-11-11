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
import { montarDetraccion, detraccionAutomatica, espejoCxP, guardarDetraccionCompra } from '../shared/detraccion.js'
import '../shared/perfil-contacto.js'
import { query, update, esperarContextoEmpresa } from '../supabase-client.js'
import { getCurrentUser } from '../auth-supabase.js'
import { showToast, formatNumber } from '../helpers.js'
import { convertirEnBuscador, refrescarBuscador } from '../buscador-select.js'
import { getTipoCambioDia } from '../sunat-api.js'
import { CONCEPTOS_COSTO } from './costos-ledger.js'
import { getSuppliers, getContactById, updateContact, addCompra, addCompraDetalle, addCuentaPagar, getCuentasGasto,
         subirAdjuntoCompra, subirAdjuntos } from '../supabase-data.js'

const num = x => { const n = parseFloat(String(x ?? '').replace(/,/g, '')); return isNaN(n) ? 0 : n }
const r2 = x => Math.round((num(x) + Number.EPSILON) * 100) / 100
const n2 = x => formatNumber(num(x), 2)
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const $ = id => document.getElementById(id)

// Cuenta de gasto sugerida según el concepto del ledger (el usuario puede cambiarla).
export const CUENTA_POR_CONCEPTO = {
  transporte_local: '631111', almacen: '632917', sobreestadia: '632917',
  comision_aduanas: '638211', agenciamiento: '638211', gastos_destino: '638211',
  gate_in: '638211', visto_bueno: '638211', thc: '638211', otro: '638111', interes: '638111'
}
const TIPOS = [['01', 'Factura'], ['03', 'Boleta de venta'], ['02', 'Recibo por honorarios'], ['91', 'Factura / Invoice del exterior (no domiciliado)'], ['12', 'Ticket / otro']]

let _ctx = null // { costo, doc, cuentas, proveedores }

// ── Núcleo (sin pantalla) ─────────────────────────────────────────────────────
/** Retención de 4ta (Recibo por Honorarios): 8% si el recibo supera S/ 1,500 y el proveedor no tiene suspensión vigente.
 *  Parámetros en parametros_renta4ta (SQL 142); suspensión en contacts.suspension_4ta_anio. Devuelve { ret, motivo }. */
export async function calcRetencion4ta({ total, moneda, tc, fecha, proveedorId }) {
  const anio = parseInt(String(fecha || new Date().toISOString()).slice(0, 4))
  let par = null; try { par = ((await query('parametros_renta4ta', { anio })) || [])[0] } catch { /* sin SQL 142 */ }
  const tasa = num(par?.tasa_retencion) || 0.08, umbral = num(par?.umbral_retencion_pen) || 1500
  const prov = proveedorId ? await getContactById(proveedorId) : null
  if (prov && prov.suspension_4ta_anio === anio) return { ret: 0, motivo: `suspensión de 4ta vigente ${anio}` }
  const totalPen = num(total) * (moneda === 'USD' ? (num(tc) || 1) : 1)
  if (totalPen <= umbral) return { ret: 0, motivo: `recibo ≤ S/ ${umbral}` }
  return { ret: r2(num(total) * tasa), motivo: `recibo > S/ ${umbral}: ${(tasa * 100).toFixed(0)}%` }
}
const _TIPOS_CXP = ['01', '02', '91']   // comprobantes que generan Cuenta por Pagar (el RH por el NETO)

/** CxP de un comprobante ya registrado en Compras. RH: monto = total − retención 4ta. */
async function _crearCxpGasto({ compra, proveedorId, tipo, serie, numero, fecha, moneda, tc, total, retencion, empresaId, userId, observaciones }) {
  return await addCuentaPagar({
    contact_id: proveedorId, compra_id: compra.id, tipo_comprobante: tipo,
    serie, numero_comprobante: numero, fecha_emision: fecha, fecha_vencimiento: null,
    moneda, tipo_cambio: tc, monto_total: r2(num(total) - num(retencion)), monto_pagado: 0, estado: 'pendiente', ...espejoCxP(compra),
    observaciones: observaciones || null, empresa_id: empresaId ?? undefined, created_by: userId
  })
}

/** Reclasifica la línea de costo si cambió el concepto (grupo y clasificación salen del catálogo). */
async function _aplicarConcepto(costo, codigo) {
  const c = CONCEPTOS_COSTO.find(x => x.codigo === codigo)
  if (!c || c.codigo === costo.concepto_codigo) return {}
  // Los flags de costo contable/gestión se fijan al INSERTAR según la clasificación: si cambia el concepto hay que recalcularlos,
  // si no, la línea queda con los del concepto anterior (ej. late payment que salió de Financieros seguía fuera del costo contable).
  return { concepto_codigo: c.codigo, grupo: c.grupo, clasificacion: c.clasificacion,
    entra_costo_contable: c.clasificacion === 'inventario',
    entra_costo_gestion: ['inventario', 'solo_gestion', 'gasto_financiero'].includes(c.clasificacion) }
}

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
  const tcCosto = num(p.tc)                 // T.C. SUNAT de la fecha: el costeo lo usa para convertir a USD (también si la factura es en soles)
  const tc = moneda === 'USD' ? tcCosto : 1   // compra / CxP / documento en soles llevan 1
  if (tcCosto <= 1) throw new Error('Falta el tipo de cambio (el costeo lo usa para convertir a USD)')

  const base = r2(p.base)
  const igvPct = num(p.igvPct)
  const igv = p.igv != null && p.igv !== '' ? r2(p.igv) : r2(base * igvPct / 100)
  const total = r2(base + igv)
  if (base <= 0) throw new Error('La base imponible debe ser mayor a 0')
  const esRH = (p.tipoComprobante || '01') === '02'
  const ret = esRH ? r2(p.retencion4ta) : 0

  // ¿Ya está esa factura en el Registro de Compras?
  const previas = (await query('compras', { contact_id: p.proveedorId, serie: p.serie, numero: p.numero })) || []
  if (previas.some(c => c.tipo_comprobante === (p.tipoComprobante || '01') && c.comprobante_anulado !== true)) {
    throw new Error(`La factura ${p.serie}-${p.numero} de este proveedor ya existe en el Registro de Compras`)
  }

  const prov = await getContactById(p.proveedorId)
  const cuenta = (await getCuentasGasto()).find(c => c.codigo === p.cuentaCodigo)
  const carpeta = (await query('carpetas_importacion', { id: costo.carpeta_importacion_id }))?.[0]
  const refCarpeta = carpeta?.numero_carpeta ? ` · Carpeta ${carpeta.numero_carpeta}` : ''

  // Detracción (SQL 157): con pantalla viene en p.detraccion; en el registro automático se detecta aquí (servicio gravado > S/ 700)
  const detr = p.detraccion !== undefined ? (p.detraccion?.detraccion_aplica ? p.detraccion : {})
    : (!esRH ? await detraccionAutomatica({ proveedorId: p.proveedorId, texto: p.glosa, tipoComprobante: p.tipoComprobante || '01', igvMonto: igv, total, moneda, tc }) : {})
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
    ...(esRH ? { retencion_4ta: ret, neto_pagado: r2(total - ret) } : {}),
    ...detr,
    carpeta_importacion_id: costo.carpeta_importacion_id,
    empresa_id: doc.empresa_id ?? undefined,
    created_by: user?.db_id
  })
  if (!compra?.id) throw new Error('No se pudo registrar la compra (¿referencia duplicada?)')

  await addCompraDetalle({
    compra_id: compra.id, item_id: null, descripcion: p.glosa, unidad_medida: 'UND', cantidad: 1,
    precio_unitario: base, subtotal: base, tipo_base: igv > 0 ? 'gravada' : (String(p.tipoComprobante) === '91' ? 'no_gravada' : 'exonerada'),
    igv_porcentaje: igv > 0 ? (igvPct || 18) : 0, igv_monto: igv, total_linea: total
  })

  let cxp = null
  if (_TIPOS_CXP.includes(p.tipoComprobante || '01')) {
    cxp = await _crearCxpGasto({ compra, proveedorId: p.proveedorId, tipo: p.tipoComprobante || '01', serie: p.serie, numero: p.numero, fecha: p.fecha, moneda, tc, total, retencion: ret,
      empresaId: doc.empresa_id, userId: user?.db_id,
      observaciones: p.regularizar === false ? null : `Pendiente de regularizar · pagado por el agente en su liquidación${refCarpeta}` })
  }

  // Documento del ledger: importes correctos + enlaces
  const cambiosDoc = {
    proveedor_id: p.proveedorId, tipo_comprobante: p.tipoComprobante || '01', serie: p.serie, numero: p.numero,
    fecha_emision: p.fecha, moneda, tipo_cambio: tc, monto_sin_igv: base, igv_monto: igv, monto_total: total,
    compra_id: compra.id, cxp_id: cxp?.id ?? null, sustentado: !p.sinSustento,
    ...(detr.detraccion_aplica ? { detraccion_monto: detr.detraccion_monto, detraccion_estado: detr.detraccion_estado } : {}),
    ...(esRH ? { retencion_4ta: ret, neto_pagado: r2(total - ret) } : {})
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
  await update('importacion_costos', costo.id, { moneda, tipo_cambio: tcCosto, monto_moneda: base, igv_monto: igv, ...(await _aplicarConcepto(costo, p.conceptoCodigo)) })

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
  if (p.detraccion?.detraccion_aplica && p.detraccionPerfil && Object.keys(p.detraccionPerfil).length) { try { await updateContact(p.proveedorId, p.detraccionPerfil) } catch (e) { console.warn('perfil detracción', e) } }
  return { compraId: compra.id, cxpId: cxp?.id ?? null, base, igv, total }
}

// ── Edición de un gasto ya registrado ─────────────────────────────────────────
export async function actualizarGastoFactura(p) {
  await esperarContextoEmpresa()
  const user = await getCurrentUser()
  const costo = (await query('importacion_costos', { id: p.costoId }))?.[0]
  const doc = costo?.documento_id ? (await query('documentos_importacion', { id: costo.documento_id }))?.[0] : null
  if (!costo || !doc?.compra_id) throw new Error('Este gasto aún no tiene compra registrada')
  if (!p.proveedorId) throw new Error('Elige el proveedor')
  if (!p.serie || !p.numero) throw new Error('Falta serie y número de la factura')
  if (!p.fecha) throw new Error('Falta la fecha de emisión')
  if (!p.glosa) throw new Error('Falta la glosa (concepto del gasto)')
  const moneda = p.moneda || 'USD', tcCosto = num(p.tc), tc = moneda === 'USD' ? tcCosto : 1
  if (tcCosto <= 1) throw new Error('Falta el tipo de cambio (el costeo lo usa para convertir a USD)')
  const base = r2(p.base), igvPct = num(p.igvPct)
  const igv = p.igv != null && p.igv !== '' ? r2(p.igv) : r2(base * igvPct / 100), total = r2(base + igv)
  if (base <= 0) throw new Error('La base imponible debe ser mayor a 0')
  const tipo = p.tipoComprobante || '01'
  const esRH = tipo === '02', ret = esRH ? r2(p.retencion4ta) : 0
  // ¿otra compra con el mismo comprobante?
  const previas = (await query('compras', { contact_id: p.proveedorId, serie: p.serie, numero: p.numero })) || []
  if (previas.some(c => c.id !== doc.compra_id && c.tipo_comprobante === tipo && c.comprobante_anulado !== true))
    throw new Error(`La factura ${p.serie}-${p.numero} de este proveedor ya existe en el Registro de Compras`)

  const prov = await getContactById(p.proveedorId)
  const cuenta = (await getCuentasGasto()).find(c => c.codigo === p.cuentaCodigo)
  const carpeta = (await query('carpetas_importacion', { id: costo.carpeta_importacion_id }))?.[0]
  const refCarpeta = carpeta?.numero_carpeta ? ` · Carpeta ${carpeta.numero_carpeta}` : ''

  if (!await update('compras', doc.compra_id, {
    referencia: `${p.serie}-${p.numero}`, tipo_comprobante: tipo, serie: p.serie, numero: p.numero,
    periodo_mes: parseInt(p.fecha.slice(5, 7)), periodo_ano: parseInt(p.fecha.slice(0, 4)),
    fecha_emision: p.fecha, fecha_recepcion: p.fecha, contact_id: p.proveedorId,
    proveedor_ruc: prov?.nro_documento || '-', proveedor_nombre: prov?.nombre || '-',
    descripcion: `${p.glosa}${refCarpeta} [Cuenta: ${cuenta ? cuenta.codigo + ' ' + cuenta.nombre : p.cuentaCodigo}]`,
    precio_unitario: base, base_imponible_gravada: igv > 0 ? base : 0, monto_exonerado: igv > 0 ? 0 : base,
    igv_gravado: igv, subtotal: base, total, currency: moneda, tipo_cambio: tc,
    ...(esRH ? { retencion_4ta: ret, neto_pagado: r2(total - ret) } : {}) })) throw new Error('No se pudo actualizar la compra #' + doc.compra_id)

  const det = ((await query('detalle_compras', { compra_id: doc.compra_id })) || [])[0]
  if (det) await update('detalle_compras', det.id, { descripcion: p.glosa, precio_unitario: base, subtotal: base,
    tipo_base: igv > 0 ? 'gravada' : (String(p.tipoComprobante) === '91' ? 'no_gravada' : 'exonerada'), igv_porcentaje: igv > 0 ? (igvPct || 18) : 0, igv_monto: igv, total_linea: total })

  const cx = ((await query('cuentas_pagar', { compra_id: doc.compra_id })) || [])[0]
  let cxpId = cx?.id ?? doc.cxp_id ?? null
  if (cx) {
    if (num(cx.monto_pagado) === 0)
      await update('cuentas_pagar', cx.id, { contact_id: p.proveedorId, tipo_comprobante: tipo, serie: p.serie, numero_comprobante: p.numero, fecha_emision: p.fecha, moneda, tipo_cambio: tc, monto_total: r2(total - ret) })
    else showToast('La CxP ya tiene pagos: ajusta su monto desde Cuentas por Pagar', 'warning', 6000)
  } else if (_TIPOS_CXP.includes(tipo)) {   // compra sin CxP (ej. RH registrado antes): se crea ahora, sin doble registro
    const nueva = await _crearCxpGasto({ compra: { id: doc.compra_id }, proveedorId: p.proveedorId, tipo, serie: p.serie, numero: p.numero, fecha: p.fecha, moneda, tc, total, retencion: ret,
      empresaId: doc.empresa_id, userId: user?.db_id, observaciones: p.regularizar ? 'Pendiente de regularizar · pagado por el agente en su liquidación' : null })
    cxpId = nueva?.id ?? null
  }

  const cambiosDoc = { proveedor_id: p.proveedorId, tipo_comprobante: tipo, serie: p.serie, numero: p.numero, fecha_emision: p.fecha,
    moneda, tipo_cambio: tc, monto_sin_igv: base, igv_monto: igv, monto_total: total, cxp_id: cxpId,
    ...(p.sinSustento !== undefined ? { sustentado: !p.sinSustento } : {}),
    ...(esRH ? { retencion_4ta: ret, neto_pagado: r2(total - ret) } : {}) }
  if (doc.regularizacion !== 'conciliado') cambiosDoc.regularizacion = p.regularizar ? 'pendiente' : null
  let okDoc = await update('documentos_importacion', doc.id, cambiosDoc)
  if (!okDoc && 'regularizacion' in cambiosDoc) { delete cambiosDoc.regularizacion; okDoc = await update('documentos_importacion', doc.id, cambiosDoc) }
  if (!okDoc) throw new Error('No se pudo actualizar el documento del costeo')
  if (!await update('importacion_costos', costo.id, { concepto: p.glosa, moneda, tipo_cambio: tcCosto, monto_moneda: base, igv_monto: igv, ...(await _aplicarConcepto(costo, p.conceptoCodigo)) }))
    throw new Error('No se pudo actualizar la línea de costo (¿carpeta cerrada?)')

  if (p.archivo) {
    try { await subirAdjuntoCompra(doc.compra_id, p.archivo) } catch (e) { showToast(e.message || 'No se pudo adjuntar a la compra', 'warning') }
    try { await subirAdjuntos('documento_importacion', doc.id, [{ file: p.archivo, concepto: 'factura_gasto' }], user?.db_id) } catch (e) { console.warn('adjunto doc', e) }
  }
  if (p.detraccion !== undefined) await guardarDetraccionCompra({ compraId: doc.compra_id, valores: p.detraccion, perfilPatch: p.detraccionPerfil, contactId: p.proveedorId })
  return { compraId: doc.compra_id, base, igv, total }
}

// ── Pantalla ─────────────────────────────────────────────────────────────────
function _asegurarModal() {
  if ($('modal-gasto-factura')) return
  const opt = (arr, sel) => arr.map(([k, v]) => `<option value="${k}" ${k === sel ? 'selected' : ''}>${v}</option>`).join('')
  document.body.insertAdjacentHTML('beforeend', `
  <div id="modal-gasto-factura" class="modal" style="z-index:2400;">
    <div class="modal-content" style="width:min(96vw, 860px); max-width:min(96vw, 860px); max-height:calc(100vh - 48px); overflow-y:auto;">
      <div class="modal-header">
        <h3 class="modal-title" id="gfTit">🧾 Registrar gasto · factura del proveedor</h3>
        <button class="modal-close" onclick="window.cerrarGastoFactura()">&times;</button>
      </div>
      <div style="padding:14px 20px 4px;">
        <div id="gfInfo" class="dm-nota" style="margin-bottom:8px;"></div>
        <div id="gfEstado" style="display:flex; flex-wrap:wrap; gap:6px; margin-bottom:8px;"></div>
        <div class="form-group"><label>Concepto del costeo <span class="bl-en">(cómo se clasifica el gasto: define su sección y si es costo de inventario)</span></label><select id="gfConcepto"></select><small id="gfConceptoHint" style="color:var(--text-secondary);"></small></div>

        <strong class="mod-sec">Comprobante</strong>
        <div style="display:grid; grid-template-columns:2fr 1.2fr 0.7fr 1fr; gap:10px;">
          <div class="form-group"><label>Proveedor (emisor) *</label><select id="gfProveedor"><option value="">— Selecciona —</option></select></div>
          <div class="form-group"><label>Tipo de comprobante</label><select id="gfTipo" onchange="window.gfOnTipo()">${opt(TIPOS, '01')}</select></div>
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
          <div class="form-group"><label id="gfLblBase">Base imponible *</label><input type="number" id="gfBase" step="0.01" oninput="window.gfCalc('base')"></div>
          <div class="form-group"><label>IGV</label><select id="gfIgvPct" onchange="window.gfCalc('base')"><option value="18">Gravado 18 %</option><option value="0">Sin IGV (exonerado / inafecto / exterior)</option></select></div>
          <div class="form-group"><label>Monto IGV</label><input type="number" id="gfIgv" step="0.01" oninput="window.gfCalc('igv')"></div>
          <div class="form-group"><label id="gfLblTotal">Total del comprobante</label><input type="number" id="gfTotal" step="0.01" oninput="window.gfCalc('total')"></div>
        </div>
        <div id="gfDetrHost"></div>
        <div id="gfRHBox" style="display:none; grid-template-columns:1fr 3fr; gap:10px; align-items:end;">
          <div class="form-group"><label>Retención 4ta</label><input type="number" id="gfRet" step="0.01" min="0" oninput="window.gfCalcRet(true)"></div>
          <div id="gfRetMotivo" style="font-size:.8rem; color:var(--text-secondary); padding-bottom:10px;"></div>
        </div>
        <div id="gfHint" style="font-size:.78rem; color:var(--text-secondary); margin:-2px 0 6px;"></div>

        <strong class="mod-sec">Documento</strong>
        <div class="form-group"><label>Factura (PDF / imagen) <span class="bl-en">(opcional · si aún no llegó, se sube después)</span></label><input type="file" id="gfArchivo" accept="application/pdf,image/jpeg,image/png"></div>
        <div style="display:flex; gap:8px; align-items:center; font-size:.85rem; margin:8px 0 2px;"><input type="checkbox" id="gfSinDoc" style="width:auto; margin:0;"><span>⚠ <b>No encuentro el comprobante todavía</b> → el gasto suma al costeo pero queda <b style="color:#f59e0b">Por revisar</b> hasta que subas el documento.</span></div>
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
  window.gfDetrActualizar?.()
}
// Detracción (SPOT): caja embebida (SQL 157)
let _gfDetr = null
window.gfDetrActualizar = async () => { if (!_gfDetr) return; await _gfDetr.actualizar({ tipoCompra: 'servicio', tipoComprobante: $('gfTipo').value, igvMonto: num($('gfIgv').value), total: num($('gfTotal').value), moneda: $('gfMoneda').value, tc: num($('gfTC').value) || 1, proveedorId: parseInt($('gfProveedor').value) || null, texto: $('gfGlosa').value }) }
// Recibo por honorarios: retención de 4ta editable (auto: 8% si > S/ 1,500 y sin suspensión). La CxP queda por el NETO.
let _retManual = false
window.gfOnTipo = () => { const rh = $('gfTipo').value === '02', ext = $('gfTipo').value === '91'; $('gfRHBox').style.display = rh ? 'grid' : 'none'; if (ext) { $('gfIgvPct').value = '0'; window.gfCalc('base') } if (rh) { $('gfIgvPct').value = '0'; window.gfCalc('base'); window.gfCalcRet(false) } }
window.gfCalcRet = async function (manual) {
  _retManual = !!manual; if ($('gfTipo').value !== '02' || manual) return
  const r = await calcRetencion4ta({ total: $('gfTotal').value, moneda: $('gfMoneda').value, tc: $('gfTC').value, fecha: $('gfFecha').value, proveedorId: parseInt($('gfProveedor').value) || null })
  $('gfRet').value = r.ret.toFixed(2); $('gfRetMotivo').textContent = `Auto: ${r.motivo}. Editable. Neto a pagar al proveedor: ${n2(num($('gfTotal').value) - r.ret)}.`
}
window.gfEtiquetas = () => { const m = $('gfMoneda').value; $('gfLblBase').textContent = `Base imponible (${m}) *`; $('gfLblTotal').textContent = `Total del comprobante (${m})` }
window.gfOnMoneda = () => { $('gfTC').disabled = false; window.gfEtiquetas(); window.gfTCAuto(); window.gfDetrActualizar?.() }
window.gfTCAuto = async function (forzar) {
  const f = $('gfFecha').value; if (!f) return
  if (!forzar && num($('gfTC').value) > 1 && $('gfTC').dataset.fecha === f) return
  try {
    const r = await getTipoCambioDia(f)
    if (r && r.venta) { $('gfTC').value = r.venta; $('gfTC').dataset.fecha = f }
    else if (forzar) showToast(r?.error || 'Sin T.C. para esa fecha', 'warning')
  } catch (e) { if (forzar) showToast('No se pudo consultar el T.C.', 'warning') }
}
window.cerrarGastoFactura = () => { _gfDetr = null; window.closeModal('modal-gasto-factura') }

window.abrirGastoFactura = async function (costoId) {
  try {
    await esperarContextoEmpresa()
    const costo = (await query('importacion_costos', { id: costoId }))?.[0]
    if (!costo) { showToast('No se encontró el gasto', 'warning'); return }
    const doc = costo.documento_id ? (await query('documentos_importacion', { id: costo.documento_id }))?.[0] : null
    if (!doc) { showToast('Este gasto no tiene documento', 'warning'); return }
    _asegurarModal()
    const [provs, cuentas] = await Promise.all([getSuppliers(), getCuentasGasto()])
    const editar = !!doc.compra_id
    _ctx = { costo, doc, editar }
    const compra = editar ? (await query('compras', { id: doc.compra_id }))?.[0] : null
    const sp = $('gfProveedor')
    sp.innerHTML = '<option value="">— Selecciona —</option>' + (provs || []).map(p => `<option value="${p.id}">${esc(p.nombre)}${p.nro_documento ? ' · ' + esc(p.nro_documento) : ''}</option>`).join('')
    sp.value = String((editar && compra?.contact_id) || doc.proveedor_id || '')
    refrescarBuscador(sp)
    const sc = $('gfCuenta'), sug = (editar && /\[Cuenta: (\S+)/.exec(compra?.descripcion || '')?.[1]) || CUENTA_POR_CONCEPTO[costo.concepto_codigo] || ''
    sc.innerHTML = '<option value="">— Selecciona —</option>' + (cuentas || []).map(c => `<option value="${esc(c.codigo)}">${esc(c.codigo)} ${esc(c.nombre)}</option>`).join('')
    sc.value = sug
    $('gfTipo').value = doc.tipo_comprobante || '01'
    const grpOk = ['despacho', 'nacionalizacion', 'financiero']
    $('gfConcepto').innerHTML = CONCEPTOS_COSTO.filter(c => grpOk.includes(c.grupo)).map(c => `<option value="${esc(c.codigo)}">${esc(c.label)} · ${esc(c.grupo)}</option>`).join('')
    $('gfConcepto').value = costo.concepto_codigo || 'otro'
    $('gfConceptoHint').textContent = ''
    $('gfSinDoc').checked = doc.sustentado === false
    {
      const cx = editar ? ((await query('cuentas_pagar', { compra_id: doc.compra_id })) || [])[0] : null
      const chip = (t, c, tit = '') => `<span class="badge" style="background:${c};color:#fff" title="${esc(tit)}">${t}</span>`
      $('gfEstado').innerHTML = editar
        ? [chip('Compra #' + doc.compra_id, '#16a34a', 'Registro de Compras'),
           cx ? chip(`CxP #${cx.id} · ${esc(cx.estado || '')}${num(cx.monto_pagado) ? ' · pagado ' + n2(cx.monto_pagado) : ''}`, num(cx.monto_pagado) ? '#2563eb' : '#64748b', 'Cuenta por pagar') : chip('Sin CxP', '#f59e0b', 'Se creará al guardar'),
           doc.regularizacion === 'pendiente' ? chip('Por regularizar', '#f59e0b', 'Pagado por el agente: se concilia en CxP') : '',
           doc.sustentado === false ? chip('Por revisar', '#f59e0b', 'Falta el comprobante') : ''].join('')
        : chip('Aún no está en Compras', '#64748b')
    }
    $('gfSerie').value = doc.serie || ''; $('gfNumero').value = doc.numero || ''
    $('gfFecha').value = doc.fecha_emision || ''
    $('gfMoneda').value = costo.moneda || doc.moneda || 'USD'
    $('gfTC').value = num(costo.tipo_cambio) > 1 ? costo.tipo_cambio : ''; $('gfTC').dataset.fecha = num(costo.tipo_cambio) > 1 ? ($('gfFecha').value || '') : ''
    $('gfGlosa').value = costo.concepto || ''
    $('gfIgvPct').value = editar && !(num(costo.igv_monto) > 0) ? '0' : '18'
    // Si ya hay IGV separado: base = monto. Si no (IGV 0): el importe registrado es el total de la factura.
    const monto = num(costo.monto_moneda), igv = num(costo.igv_monto)
    if (igv > 0) { $('gfBase').value = monto.toFixed(2); window.gfCalc('base'); $('gfIgv').value = igv.toFixed(2); window.gfCalc('igv') }
    else if (editar) { $('gfBase').value = monto.toFixed(2); window.gfCalc('base') }
    else { $('gfTotal').value = monto.toFixed(2); window.gfCalc('total') }
    $('gfHint').textContent = editar ? `Compra #${doc.compra_id} · los cambios se reflejan en el Registro de Compras, la CxP y el costeo.` : igv > 0
      ? `En el costeo hoy: base ${n2(monto)} + IGV ${n2(igv)}.`
      : `En el costeo hoy: ${n2(monto)} sin IGV separado → se tomó como TOTAL de la factura. Verifícalo con el comprobante.`
    $('gfInfo').innerHTML = `<b>${esc(costo.concepto)}</b> · el costeo tomará la <b>base sin IGV</b>; el IGV va a crédito fiscal y la factura al Registro de Compras y a Cuentas por Pagar.`
    $('gfArchivo').value = ''; $('gfRegul').checked = editar ? doc.regularizacion === 'pendiente' : !!costo.liquidacion_agente_id
    $('gfRegul').disabled = doc.regularizacion === 'conciliado'
    $('gfTit').textContent = editar ? `✏️ Editar gasto · compra #${doc.compra_id}` : '🧾 Registrar gasto · factura del proveedor'
    $('gfGuardar').textContent = editar ? '💾 Guardar cambios' : '💾 Registrar compra del gasto'
    window.gfOnMoneda()
    _gfDetr = await montarDetraccion($('gfDetrHost'), { prefijo: 'gfd' })
    for (const id of ['gfProveedor', 'gfGlosa', 'gfTC', 'gfTipo']) $(id)?.addEventListener('change', () => window.gfDetrActualizar())
    if (editar && compra?.detraccion_aplica) _gfDetr.cargar(compra)
    await window.gfDetrActualizar()
    $('gfRHBox').style.display = $('gfTipo').value === '02' ? 'grid' : 'none'
    window.gfEtiquetas()
    if ($('gfTipo').value === '02') { if (editar && compra?.retencion_4ta != null) { $('gfRet').value = num(compra.retencion_4ta).toFixed(2); _retManual = true } else window.gfCalcRet(false) }
    window.openModal('modal-gasto-factura')
    const m = $('modal-gasto-factura'); if (m) { document.body.appendChild(m); m.style.zIndex = 2400 }
  } catch (e) { console.error('abrirGastoFactura', e); showToast(e.message || 'No se pudo abrir el gasto', 'danger') }
}

window.guardarGastoFactura = async function () {
  const btn = $('gfGuardar'); if (!_ctx) return
  if (window.validarRequeridos?.(['gfProveedor', 'gfSerie', 'gfNumero', 'gfFecha', 'gfGlosa', 'gfCuenta', 'gfBase']) === false) return
  if (!(await window.validarPerfilContacto?.(parseInt($('gfProveedor').value) || 0, { rol: 'proveedor' }) ?? true)) return
  let det = null
  if (_gfDetr && $('gfTipo').value === '01') { await window.gfDetrActualizar(); det = _gfDetr.leer(); if (det.error) { showToast(det.error, 'warning'); return } }
  try {
    btn.disabled = true; btn.textContent = _ctx.editar ? 'Guardando…' : 'Registrando…'
    const r = await (_ctx.editar ? actualizarGastoFactura : registrarGastoFactura)({
      costoId: _ctx.costo.id, proveedorId: parseInt($('gfProveedor').value) || null, tipoComprobante: $('gfTipo').value,
      serie: $('gfSerie').value.trim().toUpperCase(), numero: $('gfNumero').value.trim(), fecha: $('gfFecha').value,
      moneda: $('gfMoneda').value, tc: $('gfTC').value, glosa: $('gfGlosa').value.trim(), cuentaCodigo: $('gfCuenta').value,
      base: $('gfBase').value, igvPct: $('gfIgvPct').value, igv: $('gfIgv').value,
      archivo: $('gfArchivo').files?.[0] || null, regularizar: $('gfRegul').checked, retencion4ta: $('gfTipo').value === '02' ? $('gfRet').value : 0,
      conceptoCodigo: $('gfConcepto').value, sinSustento: $('gfSinDoc').checked,
      detraccion: det ? det.valores : undefined, detraccionPerfil: det?.perfilPatch
    })
    showToast(`Compra #${r.compraId} ${_ctx.editar ? 'actualizada' : 'registrada'} · base ${n2(r.base)} + IGV ${n2(r.igv)} = ${n2(r.total)}`, 'success')
    window.cerrarGastoFactura()
    try { await window._alGuardarCosto?.() } catch (e2) { console.warn('alGuardarCosto', e2) }
    window.renderCostosLedger?.(); window.renderHojaCosteo?.()
  } catch (e) {
    console.error('guardarGastoFactura', e); showToast(e.message || 'No se pudo registrar el gasto', 'danger')
  } finally { btn.disabled = false; btn.textContent = _ctx?.editar ? '💾 Guardar cambios' : '💾 Registrar compra del gasto' }
}

/**
 * Registro AUTOMÁTICO en Compras + CxP de una factura de gasto ya cargada en el costeo (2026-11-06).
 * Lo usan «＋ Factura de gasto» de la liquidación del agente y «＋ Nuevo gasto» de la sección 4 de la hoja.
 * Devuelve { ok, compraId?, cxpId?, motivo? }. Nunca lanza: si falta algo, la línea queda en el costeo y
 * se puede completar con el botón 🧾 Registrar gasto.
 */
export async function registrarGastoAuto(docId, titulo = '') {
  try {
    await esperarContextoEmpresa()
    const doc = ((await query('documentos_importacion', { id: docId })) || [])[0]
    const k = ((await query('importacion_costos', { documento_id: docId })) || []).find(x => !x.anulado)
    if (!doc || !k) return { ok: false, motivo: 'sin documento' }
    if (doc.compra_id) { if (!doc.cxp_id && _TIPOS_CXP.includes(doc.tipo_comprobante || '01')) await completarCxpGasto(docId); return { ok: true, compraId: doc.compra_id } }
    if (!['despacho', 'nacionalizacion'].includes(k.grupo) || ['voucher_bancario', 'dam', 'autoliquidacion'].includes(doc.tipo)) return { ok: false, motivo: 'no aplica' }
    const nombre = titulo || k.concepto || 'gasto'
    if (!doc.proveedor_id || !doc.serie || !doc.numero || !doc.fecha_emision) {
      showToast(`«${nombre}»: falta proveedor/serie/número; usa 🧾 Registrar gasto`, 'warning', 6000); return { ok: false, motivo: 'datos incompletos' }
    }
    if (!(await window.validarPerfilContacto?.(doc.proveedor_id, { rol: 'proveedor' }) ?? true)) {
      showToast(`«${nombre}» quedó en el costeo: actualiza el contacto y usa 🧾 Registrar gasto`, 'warning', 7000); return { ok: false, motivo: 'perfil incompleto' }
    }
    const r = await registrarGastoFactura({
      costoId: k.id, proveedorId: doc.proveedor_id, tipoComprobante: doc.tipo_comprobante || '01', serie: doc.serie, numero: doc.numero,
      fecha: doc.fecha_emision, moneda: k.moneda || doc.moneda || 'USD', tc: num(k.tipo_cambio) > 1 ? k.tipo_cambio : doc.tipo_cambio, glosa: k.concepto || nombre,
      cuentaCodigo: CUENTA_POR_CONCEPTO[k.concepto_codigo] || '638111', base: num(k.monto_moneda), igvPct: num(k.igv_monto) > 0 ? 18 : 0, igv: num(k.igv_monto),
      archivo: null, regularizar: !!k.liquidacion_agente_id,
      retencion4ta: (doc.tipo_comprobante === '02') ? (num(k.retencion_4ta) || num(doc.retencion_4ta) || (await calcRetencion4ta({ total: num(k.monto_moneda) + num(k.igv_monto), moneda: k.moneda || doc.moneda, tc: k.tipo_cambio, fecha: doc.fecha_emision, proveedorId: doc.proveedor_id })).ret) : 0
    })
    showToast(`Compra #${r.compraId} registrada${r.cxpId ? ' · CxP #' + r.cxpId : ''} · ${doc.serie}-${doc.numero}`, 'success', 5000)
    return { ok: true, compraId: r.compraId, cxpId: r.cxpId }
  } catch (e) {
    console.warn('registrarGastoAuto', e)
    showToast(`«${titulo || 'gasto'}»: ${e.message || 'no se pudo registrar la compra'}; usa 🧾 Registrar gasto`, 'warning', 7000)
    return { ok: false, motivo: e.message }
  }
}
/** Crea la CxP que falta de un comprobante YA registrado en Compras (ej. RH de la cuadrilla): un solo registro, sin doble digitación. */
export async function completarCxpGasto(docId) {
  try {
    const doc = ((await query('documentos_importacion', { id: docId })) || [])[0]
    const compra = doc?.compra_id ? ((await query('compras', { id: doc.compra_id })) || [])[0] : null
    if (!doc || !compra) return { ok: false }
    if (((await query('cuentas_pagar', { compra_id: compra.id })) || []).length) return { ok: true }
    const user = await getCurrentUser()
    const ret = num(compra.retencion_4ta)
    const cx = await _crearCxpGasto({ compra, proveedorId: compra.contact_id, tipo: compra.tipo_comprobante, serie: compra.serie, numero: compra.numero, fecha: compra.fecha_emision,
      moneda: compra.currency || 'PEN', tc: num(compra.tipo_cambio) || 1, total: num(compra.total), retencion: ret, empresaId: compra.empresa_id, userId: user?.db_id,
      observaciones: doc.regularizacion === 'pendiente' ? 'Pendiente de regularizar' : null })
    if (cx?.id) { await update('documentos_importacion', doc.id, { cxp_id: cx.id }); showToast(`CxP #${cx.id} creada para ${compra.serie}-${compra.numero}${ret ? ' (neto ' + n2(num(compra.total) - ret) + ')' : ''}`, 'success', 5000); window.renderHojaCosteo?.() }
    return { ok: !!cx?.id }
  } catch (e) { console.warn('completarCxpGasto', e); showToast(e.message || 'No se pudo crear la CxP', 'warning'); return { ok: false } }
}
window.completarCxpGasto = completarCxpGasto
window.registrarGastoAuto = registrarGastoAuto

/** «＋ Nuevo gasto» (sección 4 de la hoja): abre el registro de costos y, al guardar, la factura pasa sola a Compras + CxP. */
window.hcNuevoGasto = async function () {
  const carpetaId = window.costeoActual?.carpeta_importacion_id || window.carpetaActual?.id
  if (!carpetaId) { showToast('Abre primero una carpeta', 'warning'); return }
  const previos = new Set(((await query('importacion_costos', { carpeta_importacion_id: carpetaId })) || []).map(k => k.id))
  window._alGuardarCosto = async () => {
    window._alGuardarCosto = null
    const nuevos = ((await query('importacion_costos', { carpeta_importacion_id: carpetaId })) || []).filter(k => !previos.has(k.id) && k.documento_id && !k.anulado)
    const vistos = new Set()
    for (const k of nuevos) { if (vistos.has(k.documento_id)) continue; vistos.add(k.documento_id); await registrarGastoAuto(k.documento_id, k.concepto) }
    window.renderHojaCosteo?.()
  }
  await window.abrirModalLineaCosto?.()
  const m = document.getElementById('modal-linea-costo'); if (m) { document.body.appendChild(m); m.style.zIndex = 2300 }
}
window.registrarGastoFactura = registrarGastoFactura
window.actualizarGastoFactura = actualizarGastoFactura
export default { abrirGastoFactura: window.abrirGastoFactura, registrarGastoFactura }
