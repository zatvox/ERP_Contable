// ============================================================================
// PAGOS-PROVEEDOR.JS — Registro ÚNICO de pagos de una carpeta de importación
// ============================================================================
// Un PAGO sale de una cuenta de banco (cuenta_origen_id), en la moneda de la
// cuenta, con su T.C. Cada pago se APLICA a uno o varios documentos de la
// carpeta (importacion_pago_aplicaciones, SQL 116): anticipo de la PI, saldo
// del CI, tributos de la DAM, percepción, ajuste de valor… en la moneda del
// DOCUMENTO (p. ej. tributos en USD pagados desde una cuenta en soles).
//
// El estado de cada documento (Pendiente / Parcial / Pagado) se CALCULA con las
// aplicaciones; nadie lo escribe a mano.
//
// Al guardar un pago:
//   1. importacion_pagos  (+ equivalentes en USD y S/)
//   2. importacion_pago_aplicaciones (una por documento)
//   3. comisiones → ledger de la carpeta (gasto financiero)
//   4. egreso en Bancos (monto + comisión) → descuenta el saldo de la cuenta
//   5. voucher / SWIFT → adjuntos (entidad 'importacion_pago')
//   6. DAM / ajuste de valor: estado, fecha de pago y T.C. se sincronizan solos
// Los pagos «históricos» (anteriores a este registro) no tocan Bancos hasta que
// los confirmes con «Registrar en Bancos» (busca antes un egreso igual).
// ============================================================================

import { query, insert, update, deleteRecord, ultimoErrorInsert, esperarContextoEmpresa } from '../supabase-client.js'
import { getCurrentUser } from '../auth-supabase.js'
import { showToast, formatNumber, fechaDMY } from '../helpers.js'
import { declararEmpresaModal } from '../empresa.js'
import { miniaturaArchivoHTML, pintarMiniaturaArchivo } from '../shared/adj-preview.js'
import { getBancos, ADJ_CONCEPTOS, subirAdjuntos, getAdjuntos, eliminarAdjuntosDe, validarArchivoAdjunto, addMovimientoBanco, deleteMovimientoBanco } from '../supabase-data.js'
import { getTipoCambioDia } from '../sunat-api.js'
import { crearLineaCosto } from './costos-ledger.js'
import { anticipoDeCI } from './ci-multi.js'

const num = x => parseFloat(x) || 0
const n2 = x => formatNumber(num(x), 2)
const _esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const $ = id => document.getElementById(id)
const v = id => ($(id)?.value ?? '').toString().trim()
const SIM = { USD: 'US$', PEN: 'S/', EUR: '€' }

export const TIPOS_PAGO = {
  anticipo: 'Anticipo al proveedor', saldo: 'Saldo al proveedor', pago_total: 'Pago total al proveedor',
  agente: 'Pago al agente / terceros', devolucion: 'Devolución del proveedor', otro: 'Otro',
  tributos: 'Tributos de la DAM', percepcion: 'Percepción', ajuste_valor: 'Ajuste de valor', combinado: 'Pago combinado'
}
const DOC_TIPOS = {
  oc_anticipo: 'Anticipo (PI)', ci_saldo: 'Saldo (CI)', dam_tributos: 'Tributos DAM', dam_percepcion: 'Percepción',
  ajuste_valor: 'Ajuste de valor', agente: 'Agente', otro: 'Otro'
}
const TIPO_POR_DOC = { oc_anticipo: 'anticipo', ci_saldo: 'saldo', dam_tributos: 'tributos', dam_percepcion: 'percepcion', ajuste_valor: 'ajuste_valor', agente: 'agente', otro: 'otro' }
const MEDIOS = { transferencia_exterior: 'Transferencia al exterior (SWIFT)', transferencia: 'Transferencia nacional / interbancaria', deposito: 'Depósito', cheque: 'Cheque', vep: 'Pago virtual SUNAT (VEP)', efectivo: 'Efectivo', otro: 'Otro' }
/** A quién se le paga según el documento: define medio habitual, campos y validaciones. */
const GRUPO_DOC = { oc_anticipo: 'proveedor', ci_saldo: 'proveedor', dam_tributos: 'sunat', dam_percepcion: 'sunat', ajuste_valor: 'sunat', agente: 'agente', otro: 'otro' }
const GRUPOS = {
  proveedor: { nombre: 'Proveedor del exterior', medio: 'transferencia_exterior', exigeOp: true,
    nota: 'Pago al proveedor del exterior: se hace por transferencia al exterior (SWIFT). Guarda el voucher y el mensaje SWIFT.' },
  sunat: { nombre: 'SUNAT', medio: 'vep', exigeOp: true,
    nota: 'Pago a SUNAT (no hay beneficiario ni SWIFT). Destino contable: <b>ad valorem → costo de la mercadería</b>; <b>IGV y percepción → crédito fiscal</b> (no entran al costo del inventario).' },
  agente: { nombre: 'Agente / terceros', medio: 'transferencia', exigeOp: false, nota: 'Pago al agente de aduana o a un tercero (transferencia nacional).' },
  otro: { nombre: 'Otro', medio: 'transferencia', exigeOp: false, nota: '' }
}
const _grupoDe = l => GRUPO_DOC[l.doc_tipo] || 'otro'
const MARCA_COMISION = id => `Pago importación #${id}`

let _ctx = { carpetaId: null, carpeta: null, oc: null, ci: null, cis: [], dams: [], dam: null, ajustes: [], proveedor: null, pagos: [], apps: [], bancos: [], sinSQL: false }
let _archivos = []
let _editId = null          // pago en edición (null = nuevo)
let _lineas = []            // obligaciones mostradas en el formulario

const carpetaActual = () => window.costeoActual?.carpeta_importacion_id || window.carpetaActual?.id || null
const keyDe = o => `${o.doc_tipo}:${o.doc_id ?? ''}`
const valido = p => p.estado !== 'observado'
const conv = (m, de, a, tc) => (de === a || !tc) ? m : (de === 'USD' && a === 'PEN') ? m * tc : (de === 'PEN' && a === 'USD') ? m / tc : m

// ─── Carga ───────────────────────────────────────────────────────────────────
async function _cargar() {
  await esperarContextoEmpresa()
  const carpetaId = carpetaActual()
  _ctx = { carpetaId, carpeta: null, oc: null, ci: null, cis: [], dams: [], dam: null, ajustes: [], proveedor: null, pagos: [], apps: [], bancos: [], sinSQL: false }
  if (!carpetaId) return false
  const carpeta = ((await query('carpetas_importacion', { id: carpetaId })) || [])[0] || null
  _ctx.carpeta = carpeta
  const [oc, cis, pagos, bancos] = await Promise.all([
    carpeta?.orden_compra_id ? query('orden_compra', { id: carpeta.orden_compra_id }) : [],
    query('comercial_invoices', { carpeta_importacion_id: carpetaId }),
    query('importacion_pagos', { carpeta_importacion_id: carpetaId }),
    getBancos().catch(() => [])
  ])
  _ctx.oc = (oc || [])[0] || null
  _ctx.cis = (cis || []).slice().sort((a, b) => a.id - b.id)
  _ctx.ci = _ctx.cis.find(x => x.id === window.costeoActual?.id) || _ctx.cis.find(x => x.id === carpeta?.comercial_invoice_id) || _ctx.cis[0] || null
  _ctx.pagos = (pagos || []).sort((a, b) => String(a.fecha).localeCompare(String(b.fecha)) || a.id - b.id)
  _ctx.bancos = (bancos || []).filter(b => b.activo !== false)
  const [prov, dams, apps] = await Promise.all([
    _ctx.oc?.contact_id ? query('contacts', { id: _ctx.oc.contact_id }) : [],
    _ctx.cis.length ? Promise.all(_ctx.cis.map(c => query('dams', { importacion_id: c.id }))).then(r => r.flat()) : [],
    query('importacion_pago_aplicaciones', { carpeta_importacion_id: carpetaId })
  ])
  _ctx.proveedor = (prov || [])[0] || null
  _ctx.dams = dams || []
  _ctx.dam = _ctx.dams.find(x => x.importacion_id === _ctx.ci?.id) || _ctx.dams[0] || null
  _ctx.apps = apps || []
  _ctx.ajustes = _ctx.dams.length ? (await Promise.all(_ctx.dams.map(x => query('dam_autoliquidaciones', { dam_id: x.id })))).flat().filter(a => a && a.estado !== 'desestimada') : []
  // Si la tabla no existe, query() devuelve [] sin avisar: lo detectamos con una lectura directa
  try {
    const { supabase } = await import('../supabase-client.js')
    const { error } = await supabase.from('importacion_pago_aplicaciones').select('id').limit(1)
    if (error) _ctx.sinSQL = true
  } catch { /* ignorar */ }
  return true
}

// ─── Obligaciones (lo que hay que pagar) y su estado calculado ────────────────
function _pagadoDe(doc_tipo, doc_id) {
  const vivos = new Set(_ctx.pagos.filter(valido).map(p => p.id))
  return _ctx.apps.filter(a => a.doc_tipo === doc_tipo && (a.doc_id ?? null) == (doc_id ?? null) && vivos.has(a.pago_id))
    .reduce((t, a) => t + num(a.monto_doc), 0)
}
const MARCA_CIERRA = '[cierra'
function _anticipoCerrado(docId, ctx = _ctx) {
  const vivos = new Set((ctx.pagos || []).filter(valido).map(p => p.id))
  return (ctx.apps || []).some(a => a.doc_tipo === 'oc_anticipo' && (a.doc_id ?? null) == (docId ?? null) && vivos.has(a.pago_id) && String(a.concepto || '').includes(MARCA_CIERRA))
}
/** Si pagas MENOS de lo marcado y entre lo marcado está el anticipo de la PI (completo), la diferencia pasa al saldo del CI. */
function _ajusteAnticipo(marcadas, monto, mp, tc) {
  const ant = marcadas.find(l => l.doc_tipo === 'oc_anticipo')
  if (!ant || !(monto > 0) || num(ant.aPagar) < num(ant.pendiente) - 0.01) return null
  const esperado = marcadas.reduce((t, l) => t + conv(num(l.aPagar), l.moneda, mp, tc), 0)
  const defMp = esperado - monto
  if (defMp <= 0.005) return null
  const defDoc = conv(defMp, mp, ant.moneda, tc)
  if (defDoc >= num(ant.aPagar) - 0.005) return null
  return { linea: ant, defDoc: Math.round(defDoc * 100) / 100 }
}
export function obligacionesCarpeta(ctx = _ctx) {
  const out = []
  const { oc, ci, dam } = ctx
  const monPI = oc?.currency || 'USD'
  const totPI = num(oc?.total_oc), pct = num(oc?.anticipo_porcentaje)
  const totReal = num(ci?.valor_total_final_ci) > 0 ? num(ci.valor_total_final_ci) : totPI
  if (oc && totPI > 0) {
    const tot = totPI * pct / 100
    out.push({ doc_tipo: 'oc_anticipo', doc_id: oc.id, titulo: `Anticipo ${n2(pct)}% · PI ${oc.numero_proforma_proveedor || oc.numero}`, moneda: monPI, total: tot })
  }
  const cisL = (ctx.cis && ctx.cis.length) ? ctx.cis : (ci ? [ci] : [])
  if (oc && (totReal > 0 || cisL.length)) {
    const antPag = _pagadoDe('oc_anticipo', oc.id)
    const antBase = antPag > 0 ? antPag : totPI * pct / 100
    for (const c of (cisL.length ? cisL : [null])) {
      const tr = c && num(c.valor_total_final_ci) > 0 ? num(c.valor_total_final_ci) : totPI
      const antC = c ? anticipoDeCI(c, cisL, antBase) : antBase
      out.push({ doc_tipo: 'ci_saldo', doc_id: c?.id ?? null, titulo: `Saldo · ${c ? 'CI ' + (c.invoice_number || '') : 'PI'}`, moneda: monPI, total: Math.max(0, tr - antC) })
    }
  }
  const damsL = (ctx.dams && ctx.dams.length) ? ctx.dams : (dam ? [dam] : [])
  for (const dm of damsL) {
    const trib = num(dm.ad_valorem_usd) + num(dm.imp_usd) + num(dm.igv_usd)
    if (trib > 0) out.push({ doc_tipo: 'dam_tributos', doc_id: dm.id, titulo: `Tributos DAM ${dm.numero_dam || ''}`, moneda: 'USD', total: trib })
    if (num(dm.percepcion) > 0) out.push({ doc_tipo: 'dam_percepcion', doc_id: dm.id, titulo: `Percepción DAM ${dm.numero_dam || ''}`, moneda: 'PEN', total: num(dm.percepcion) })
    for (const a of (ctx.ajustes || []).filter(a => a.dam_id == null || a.dam_id === dm.id)) {
      const t = num(a.ad_valorem_usd) + num(a.ipm_usd) + num(a.igv_usd) + num(a.intereses_usd)
      if (t > 0) out.push({ doc_tipo: 'ajuste_valor', doc_id: a.id, titulo: `Ajuste de valor ${a.numero || ''}`, moneda: 'USD', total: t })
    }
  }
  return out.map(o => {
    const pagado = _pagadoDe(o.doc_tipo, o.doc_id)
    // Anticipo cerrado con ajuste: se pagó menos que la PI y la diferencia pasa al saldo del CI
    const cerrado = o.doc_tipo === 'oc_anticipo' && pagado > 0 && _anticipoCerrado(o.doc_id, ctx)
    const pendiente = cerrado ? 0 : Math.max(0, o.total - pagado)
    const estado = (pendiente <= 0.005 && o.total > 0) ? 'pagado' : pagado > 0 ? 'parcial' : 'pendiente'
    return { ...o, key: keyDe(o), pagado, pendiente, estado, cerradoConAjuste: cerrado }
  })
}
const CHIP_E = { pagado: ['Pagado', '#10b981'], parcial: ['Parcial', '#f59e0b'], pendiente: ['Pendiente', '#6b7280'] }
const chipE = e => `<span class="cr-chip" style="--c:${CHIP_E[e][1]};">${CHIP_E[e][0]}</span>`

// ─── Modal ───────────────────────────────────────────────────────────────────
function _asegurarModal() {
  if ($('modal-pagos-proveedor')) return
  const bancoOpts = '<option value="">— Elige la cuenta de donde sale —</option>'
  document.body.insertAdjacentHTML('beforeend', `
  <div id="modal-pagos-proveedor" class="modal">
    <div class="modal-content" style="width:min(96vw, 1040px); max-width:min(96vw, 1040px); max-height:calc(100vh - 48px); overflow-y:auto;">
      <div class="modal-header">
        <h3 class="modal-title" id="ppTitulo">Pagos de la carpeta</h3>
        <button class="modal-close" onclick="window.cerrarPagosProveedor()">&times;</button>
      </div>
      <div style="padding:16px 20px 0;">
        <div id="ppAvisoSQL"></div>
        <div id="ppResumen"></div>

        <strong class="mod-sec">Pagos registrados</strong>
        <div id="ppLista" class="table-container"></div>

        <div id="ppFormWrap" style="display:none;">
          <hr style="border:none; border-top:1px solid var(--border-color); margin:16px 0;">
          <strong class="mod-sec" id="ppFormTitulo">Nuevo pago</strong>

          <div class="form-group"><label>¿Qué se paga? <small style="font-weight:400; color:var(--text-secondary);">(marca uno o varios documentos: un mismo voucher o cheque puede pagar varios)</small></label>
            <div id="ppDocs" class="pp-oblig"></div>
            <div id="ppDestino" style="font-size:.84rem; margin-top:8px; padding:8px 12px; border-left:3px solid var(--color-primary,#6366f1); background:var(--bg-secondary); border-radius:6px; display:none;"></div></div>

          <div style="display:grid; grid-template-columns:repeat(4, 1fr); gap:10px;">
            <div class="form-group" style="grid-column:span 2;"><label>Cuenta de origen * <small id="ppSaldoBanco" style="font-weight:400; color:var(--text-secondary);"></small></label>
              <select id="ppCuenta" onchange="window.ppCambioCuenta()">${bancoOpts}</select></div>
            <div class="form-group"><label>Fecha de operación *</label>
              <input type="date" id="ppFecha" onchange="window.ppTCDelDia()"></div>
            <div class="form-group"><label>Medio de pago *</label>
              <select id="ppMedio" onchange="this.dataset.auto='0'; window.ppAplicarMedio()">${Object.entries(MEDIOS).map(([k, t]) => `<option value="${k}">${t}</option>`).join('')}</select></div>

            <div class="form-group"><label>T.C. (S/ por US$) <span id="ppTCAviso" style="font-weight:400; color:var(--text-secondary); font-size:0.75rem;"></span></label>
              <div style="display:flex; gap:4px;"><input type="number" step="0.001" id="ppTC" oninput="this.dataset.auto='0'; window.ppAutoMonto()">
              <button type="button" class="btn btn-secondary btn-small" onclick="window.ppTCDelDia(true)" title="Traer el T.C. del día">⟳</button></div></div>
            <div class="form-group"><label>Moneda de la cuenta</label>
              <input type="text" id="ppMoneda" readonly style="background:var(--bg-secondary,#f3f4f6); font-weight:600;"></div>
            <div class="form-group"><label>Monto pagado * <small id="ppMontoAyuda" style="font-weight:400; color:var(--text-secondary);"></small></label>
              <input type="number" step="0.01" id="ppMonto" oninput="this.dataset.auto='0'; window.ppRecalcular()"></div>
            <div class="form-group"><label>N° operación / cheque</label>
              <input type="text" id="ppCodOp" maxlength="60"></div>

            <div class="form-group"><label>Comisión bancaria</label>
              <input type="number" step="0.01" id="ppComTransf" value="0" oninput="window.ppRecalcular()"></div>
            <div class="form-group pp-ext"><label>Comisión SWIFT</label>
              <input type="number" step="0.01" id="ppComSwift" value="0" oninput="window.ppRecalcular()"></div>
            <div class="form-group"><label>Total debitado</label>
              <input type="text" id="ppTotalDeb" readonly style="background:var(--bg-secondary,#f3f4f6); font-weight:600;"></div>
            <div class="form-group"><label>Estado</label>
              <select id="ppEstado"><option value="ejecutado">Ejecutado</option><option value="en_proceso">En proceso</option><option value="observado">Observado (no cuenta como pagado)</option></select></div>
          </div>
          <div id="ppEquiv" style="font-size:0.82rem; color:var(--text-secondary); margin:2px 0 8px;"></div>

          <details class="pp-banco pp-ext" open><summary>Datos de la constancia bancaria (beneficiario, SWIFT, UETR)</summary>
            <div style="display:grid; grid-template-columns:repeat(4, 1fr); gap:10px; margin-top:10px;">
              <div class="form-group" style="grid-column:span 2;"><label>Beneficiario</label><input type="text" id="ppBenef" maxlength="200"></div>
              <div class="form-group" style="grid-column:span 2;"><label>Banco del beneficiario</label><input type="text" id="ppBancoBenef" maxlength="200"></div>
              <div class="form-group"><label>SWIFT / BIC</label><input type="text" id="ppSwift" maxlength="20" style="text-transform:uppercase;"></div>
              <div class="form-group" style="grid-column:span 3;"><label>UETR (seguimiento SWIFT)</label><input type="text" id="ppUetr" maxlength="60"></div>
            </div></details>

          <div class="form-group" style="margin-top:10px;"><label>Referencia / observaciones</label>
            <input type="text" id="ppObs" maxlength="300" placeholder="Ej. Anticipo 20% PI 8300318"></div>

          <label style="display:flex; align-items:center; gap:8px; font-size:0.88rem; margin:6px 0 10px;">
            <input type="checkbox" id="ppEnBancos" checked> Descontar de Bancos (registra el egreso y la comisión en la cuenta elegida)</label>

          <strong class="mod-sec">Documentos de este pago <span id="ppDocsN" class="pp-docs-n"></span></strong>
          <div id="ppDrop" class="pp-drop" tabindex="0">
            <div class="pp-drop-ico">📎</div>
            <div><strong>Arrastra aquí los documentos del pago</strong> o <label class="pp-drop-link">elígelos<input type="file" id="ppArchivos" multiple hidden data-sin-preview></label>
              <span class="pp-drop-hint">Voucher · SWIFT · cheque · constancia de pago SUNAT (máx. 10 MB c/u). También puedes pegar capturas con Ctrl+V.</span></div>
          </div>
          <div id="ppPendientes" class="pp-docs"></div>
          <div style="font-size:0.8rem; color:var(--text-secondary); margin-top:8px;">
            Las comisiones pasan al costeo como <strong>gasto financiero</strong> (no inflan el inventario).
          </div>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-primary" id="ppBtnNuevo" onclick="window.ppNuevo()">+ Registrar pago</button>
        <button class="btn btn-primary" id="ppBtnGuardar" style="display:none;" onclick="window.ppGuardar()">💾 Guardar pago</button>
        <button class="btn btn-secondary" id="ppBtnCancelar" style="display:none;" onclick="window.ppCancelarBtn()">Cancelar</button>
        <button class="btn btn-secondary" onclick="window.cerrarPagosProveedor()">Cerrar</button>
      </div>
    </div>
  </div>`)
  if (!$('pp-oblig-css')) document.head.insertAdjacentHTML('beforeend', `<style id="pp-oblig-css">
    .pp-oblig{border:1px solid var(--border-color); border-radius:8px; overflow:hidden}
    .pp-ob{display:grid; grid-template-columns:28px 1.6fr .6fr .8fr .8fr .8fr 1fr; gap:8px; align-items:center; padding:7px 10px; border-bottom:1px solid var(--border-color); font-size:.85rem}
    .pp-ob:last-child{border-bottom:0}
    .pp-ob.cab{background:var(--bg-secondary); color:var(--text-secondary); font-size:.72rem; text-transform:uppercase; letter-spacing:.03em}
    .pp-ob input[type=number]{width:100%; padding:4px 6px}
    .pp-ob.off{opacity:.55}
    .pp-ob .num{text-align:right}
    .pp-fila-falta{background:color-mix(in srgb,#f59e0b 10%,transparent)}
  </style>`)
}

function _pintarAvisoSQL() {
  $('ppAvisoSQL').innerHTML = _ctx.sinSQL ? `<div class="info-card" style="padding:10px 14px; border-left:4px solid var(--color-danger,#ef4444); background:var(--bg-secondary); border-radius:6px; margin-bottom:10px;">
    Falta correr <code>assets/sql/116_pagos_importacion_unificados.sql</code> en Supabase para registrar pagos.</div>` : ''
}

function _pintarResumen() {
  const obs = obligacionesCarpeta()
  if (!_ctx.oc && !obs.length) {
    $('ppResumen').innerHTML = `<div class="info-card" style="padding:10px 14px; border-left:4px solid var(--color-warning,#f59e0b); background:var(--bg-secondary,#f9fafb); border-radius:6px;">
      Esta carpeta no tiene Proforma ni DAM: no hay documentos por pagar todavía.</div>`
    return
  }
  const cab = _ctx.oc ? `<div style="margin-bottom:8px; font-size:0.9rem;">Proforma <strong>${_esc(_ctx.oc.numero_proforma_proveedor || _ctx.oc.numero)}</strong>
      · ${_esc(_ctx.proveedor?.nombre || 'Proveedor')} · Incoterm ${_esc(_ctx.oc.incoterm || '—')}</div>` : ''
  $('ppResumen').innerHTML = cab + `<strong class="mod-sec">Documentos por pagar</strong>
    <table class="data-table"><thead><tr><th>Documento</th><th class="text-right">Total</th><th class="text-right">Pagado</th><th class="text-right">Por pagar</th><th>Estado</th><th></th></tr></thead><tbody>${obs.map(o => `<tr>
      <td>${_esc(o.titulo)}</td><td class="text-right">${SIM[o.moneda] || o.moneda} ${n2(o.total)}</td><td class="text-right">${n2(o.pagado)}</td>
      <td class="text-right"><strong>${n2(o.pendiente)}</strong></td><td>${chipE(o.estado)}</td>
      <td>${o.estado === 'pagado' ? '' : `<button class="btn btn-primary btn-small" onclick="window.ppNuevo('${o.key}')">Pagar</button>`}</td></tr>`).join('')}</tbody></table>`
}

function _docsDelPago(p) {
  return _ctx.apps.filter(a => a.pago_id === p.id).map(a => `${_esc(DOC_TIPOS[a.doc_tipo] || a.doc_tipo)} <small>${SIM[a.moneda_doc] || a.moneda_doc} ${n2(a.monto_doc)}</small>`).join('<br>') || _esc(TIPOS_PAGO[p.tipo] || p.tipo)
}

function _pintarLista() {
  const filas = _ctx.pagos
  if (!filas.length) {
    $('ppLista').innerHTML = '<p style="text-align:center; color:var(--text-secondary); padding:14px;">Todavía no hay pagos registrados en esta carpeta.</p>'
    return
  }
  const badge = e => ({ ejecutado: ['Ejecutado', 'success'], en_proceso: ['En proceso', 'warning'], observado: ['Observado', 'danger'] }[e] || [e, 'info'])
  const banco = id => _ctx.bancos.find(b => b.id === id)
  $('ppLista').innerHTML = `<table class="data-table"><thead><tr>
      <th>Fecha</th><th>Documentos</th><th>Cuenta</th><th class="text-right">Pagado</th><th class="text-right">Equivale</th>
      <th class="text-right">Comisión</th><th>Estado</th><th>Bancos</th><th></th></tr></thead><tbody>${filas.map(p => {
        const [lbl, col] = badge(p.estado)
        const b = banco(p.cuenta_origen_id)
        const falta = !p.cuenta_origen_id
        const bancoTxt = p.movimiento_banco_id ? '<span class="badge badge-success" title="Egreso registrado en Bancos">✔ En Bancos</span>'
          : (p.estado === 'observado' ? '—' : (p.cuenta_origen_id ? `<button class="btn btn-secondary btn-small" onclick="window.ppRegistrarBanco(${p.id})" title="${p.es_historico ? 'Pago anterior: confirma antes de descontar' : 'Registrar el egreso en Bancos'}">Registrar en Bancos</button>` : '<span style="color:var(--text-secondary);">—</span>'))
        return `<tr class="${falta ? 'pp-fila-falta' : ''}">
          <td>${fechaDMY(p.fecha)}${p.es_historico ? '<br><small style="color:var(--text-secondary);">histórico</small>' : ''}</td>
          <td>${_docsDelPago(p)}${p.codigo_operacion ? `<br><small style="color:var(--text-secondary);">Op. ${_esc(p.codigo_operacion)}</small>` : ''}</td>
          <td>${b ? `${_esc(b.nombre)}<br><small style="color:var(--text-secondary);">${_esc(MEDIOS[p.medio] || '')}</small>` : '<span class="badge badge-warning">Falta cuenta</span>'}</td>
          <td class="text-right"><strong>${SIM[p.moneda] || p.moneda} ${n2(p.monto_transferido)}</strong><br><small style="color:var(--text-secondary);">T.C. ${num(p.tipo_cambio).toFixed(3)}</small></td>
          <td class="text-right"><small>${p.monto_equiv_usd != null ? 'US$ ' + n2(p.monto_equiv_usd) : ''}${p.monto_equiv_pen != null ? '<br>S/ ' + n2(p.monto_equiv_pen) : ''}</small></td>
          <td class="text-right">${n2(num(p.comision_transferencia) + num(p.comision_swift))}</td>
          <td><span class="badge badge-${col}">${lbl}</span></td>
          <td>${bancoTxt}</td>
          <td style="white-space:nowrap;"><button class="btn btn-secondary btn-small" onclick="window.ppVerAdjuntos(${p.id})" title="Documentos">📎</button>
            <button class="btn btn-secondary btn-small" onclick="window.ppEditar(${p.id})" title="Editar / completar datos">✏️</button>
            <button class="btn btn-danger btn-small" onclick="window.ppEliminar(${p.id})" title="Eliminar pago">🗑</button></td>
        </tr>`
      }).join('')}</tbody></table><div id="ppAdjuntosVista" style="font-size:0.85rem; margin-top:6px;"></div>`
}

async function _repintar() { _pintarAvisoSQL(); _pintarResumen(); _pintarLista() }

// ─── Apertura ────────────────────────────────────────────────────────────────
window.abrirPagosProveedor = async function () {
  if (!carpetaActual()) { showToast('Selecciona primero una carpeta', 'warning'); return }
  _asegurarModal()
  await _cargar()
  declararEmpresaModal('modal-pagos-proveedor', _ctx.carpeta?.empresa_id)
  { const m = $('modal-pagos-proveedor'); document.body.appendChild(m); m.style.zIndex = 2200 }
  $('ppTitulo').textContent = `Pagos de la carpeta ${_ctx.carpeta?.numero_carpeta || _ctx.carpetaId}`
  delete $('modal-pagos-proveedor').dataset.modo
  window.ppCancelar()
  await _repintar()
  window.openModal('modal-pagos-proveedor')
}

/** Desde la hoja o un documento: abre el pago al frente con el/los documentos marcados.
 *  sel: 'anticipo' | 'saldo' | 'tributos' | 'percepcion' | 'dam_tributos:12' | ['ajuste_valor:3', …] */
window.abrirPagoRapido = async function (sel = 'anticipo') {
  if (!carpetaActual()) { showToast('Selecciona primero una carpeta', 'warning'); return }
  _asegurarModal()
  await _cargar()
  declararEmpresaModal('modal-pagos-proveedor', _ctx.carpeta?.empresa_id)
  { const m = $('modal-pagos-proveedor'); document.body.appendChild(m); m.style.zIndex = 2200 }   // por encima de la DAM / ajuste abiertos
  $('ppTitulo').textContent = `Registrar pago · Carpeta ${_ctx.carpeta?.numero_carpeta || _ctx.carpetaId}`
  $('modal-pagos-proveedor').dataset.modo = 'rapido'
  await _repintar()
  window.ppNuevo(sel)
  window.openModal('modal-pagos-proveedor')
}
window.pagarDocumento = (docTipo, docId) => window.abrirPagoRapido(`${docTipo}:${docId ?? ''}`)

window.cerrarPagosProveedor = function () { window.closeModal('modal-pagos-proveedor'); const m = $('modal-pagos-proveedor'); if (m) delete m.dataset.modo; Promise.resolve(window.renderHojaCosteo?.()).then(() => window.onPagosCambiaron?.()) }

const _ALIAS = { anticipo: 'oc_anticipo', saldo: 'ci_saldo', pago_total: 'ci_saldo', tributos: 'dam_tributos', percepcion: 'dam_percepcion' }
function _resolverSel(sel) {
  const lista = Array.isArray(sel) ? sel : [sel]
  const obs = obligacionesCarpeta()
  const keys = new Set()
  for (const s of lista) {
    if (!s) continue
    if (String(s).includes(':')) { keys.add(String(s)); continue }
    const t = _ALIAS[s] || s
    obs.filter(o => o.doc_tipo === t && o.pendiente > 0.005).forEach(o => keys.add(o.key))
  }
  return keys
}

// ─── Formulario ──────────────────────────────────────────────────────────────
function _preparar(sel, pago) {
  _archivos = []
  _editId = pago?.id || null
  $('ppFormWrap').style.display = ''
  $('ppBtnNuevo').style.display = 'none'
  $('ppBtnGuardar').style.display = ''
  $('ppBtnCancelar').style.display = ''
  $('ppFormTitulo').textContent = pago ? `Editar pago #${pago.id}${pago.es_historico ? ' (histórico: completa los datos)' : ''}` : 'Nuevo pago'

  const obs = obligacionesCarpeta()
  const keys = pago ? new Set(_ctx.apps.filter(a => a.pago_id === pago.id).map(a => `${a.doc_tipo}:${a.doc_id ?? ''}`)) : _resolverSel(sel)
  // Al editar, lo ya aplicado por ESTE pago cuenta como pendiente de nuevo
  const propias = pago ? _ctx.apps.filter(a => a.pago_id === pago.id) : []
  _lineas = obs.map(o => {
    const mio = propias.find(a => `${a.doc_tipo}:${a.doc_id ?? ''}` === o.key)
    const cierra = mio && String(mio.concepto || '').includes(MARCA_CIERRA)
    const pend = cierra ? o.total : o.pendiente + (mio ? num(mio.monto_doc) : 0)   // si cerró con ajuste, al editar vuelve a su total y se recalcula
    return { ...o, pendiente: pend, marcado: keys.has(o.key), aPagar: mio ? (cierra ? o.total : num(mio.monto_doc)) : pend }
  }).filter(l => l.pendiente > 0.005 || l.marcado)
  // Aplicaciones de documentos que ya no existen como obligación (p. ej. agente): se conservan
  for (const a of propias) if (!_lineas.some(l => l.key === `${a.doc_tipo}:${a.doc_id ?? ''}`)) {
    _lineas.push({ key: `${a.doc_tipo}:${a.doc_id ?? ''}`, doc_tipo: a.doc_tipo, doc_id: a.doc_id, titulo: a.concepto || DOC_TIPOS[a.doc_tipo], moneda: a.moneda_doc, total: num(a.monto_doc), pagado: 0, pendiente: num(a.monto_doc), marcado: true, aPagar: num(a.monto_doc) })
  }
  _pintarObligaciones()

  $('ppCuenta').innerHTML = '<option value="">— Elige la cuenta de donde sale —</option>' + _ctx.bancos.map(b =>
    `<option value="${b.id}">${_esc(b.nombre)} — ${_esc(b.numero_cuenta || '')} (${b.moneda || ''})</option>`).join('')
  const ultimo = [..._ctx.pagos].reverse().find(p => p.cuenta_origen_id)
  $('ppFecha').value = pago?.fecha || new Date().toISOString().slice(0, 10)
  $('ppMedio').value = pago?.medio || (pago?.swift_bic || pago?.beneficiario ? 'transferencia_exterior' : 'transferencia')
  $('ppMedio').dataset.auto = pago?.medio ? '0' : '1'
  $('ppCuenta').value = pago?.cuenta_origen_id || (!pago && ultimo ? ultimo.cuenta_origen_id : '') || ''
  $('ppTC').value = pago ? num(pago.tipo_cambio).toFixed(3) : ''
  $('ppTC').dataset.auto = pago ? '0' : '1'
  $('ppMonto').value = pago ? num(pago.monto_transferido).toFixed(2) : ''
  $('ppMonto').dataset.auto = pago ? '0' : '1'
  $('ppCodOp').value = pago?.codigo_operacion || ''
  $('ppComTransf').value = pago ? num(pago.comision_transferencia) : '0'
  $('ppComSwift').value = pago ? num(pago.comision_swift) : '0'
  $('ppEstado').value = pago?.estado || 'ejecutado'
  $('ppBenef').value = pago ? (pago.beneficiario || '') : ''
  $('ppBancoBenef').value = pago?.banco_beneficiario || ''
  $('ppSwift').value = pago?.swift_bic || ''
  $('ppUetr').value = pago?.uetr || ''
  $('ppObs').value = pago?.referencia || ''
  // Pagos históricos: no descuentan Bancos salvo que lo confirmes
  $('ppEnBancos').checked = pago ? !!pago.movimiento_banco_id || !pago.es_historico : true
  _cablearDrop(); _pintarDocs(); window.ppAplicarMedio(true)
  window.ppCambioCuenta(true)
  if (!pago) window.ppTCDelDia()
}

function _pintarObligaciones() {
  const box = $('ppDocs'); if (!box) return
  if (!_lineas.length) { box.innerHTML = '<div style="padding:12px; color:var(--text-secondary);">No hay documentos pendientes de pago en esta carpeta.</div>'; return }
  box.innerHTML = `<div class="pp-ob cab"><span></span><span>Documento</span><span>Moneda</span><span class="num">Total</span><span class="num">Pendiente</span><span class="num">A pagar ahora</span><span>Estado</span></div>` +
    _lineas.map((l, i) => `<div class="pp-ob ${l.marcado ? '' : 'off'}">
      <input type="checkbox" ${l.marcado ? 'checked' : ''} ${(() => { const m = _lineas.find(x => x.marcado); return m && _grupoDe(m) !== _grupoDe(l) ? 'disabled title="Otro destinatario: va en otro pago"' : '' })()} onchange="window.ppMarcar(${i}, this.checked)">
      <span>${_esc(l.titulo)}</span><span>${l.moneda}</span><span class="num">${n2(l.total)}</span><span class="num">${n2(l.pendiente)}</span>
      <input type="number" step="0.01" min="0" value="${num(l.aPagar).toFixed(2)}" ${l.marcado ? '' : 'disabled'} oninput="window.ppAPagar(${i}, this.value)">
      <span>${chipE(l.estado || 'pendiente')}</span></div>`).join('')
}
window.ppMarcar = (i, on) => {
  if (!_lineas[i]) return
  const otro = _lineas.find((l, j) => j !== i && l.marcado)
  if (on && otro && _grupoDe(otro) !== _grupoDe(_lineas[i])) { showToast(`Un pago es para un solo destinatario: ya marcaste documentos de ${GRUPOS[_grupoDe(otro)].nombre}. Registra el de ${GRUPOS[_grupoDe(_lineas[i])].nombre} en otro pago.`, 'warning'); _pintarObligaciones(); return }
  _lineas[i].marcado = on; _lineas[i].aPagar = on ? _lineas[i].pendiente : 0; _pintarObligaciones(); window.ppAplicarMedio(true); window.ppAutoMonto() }
window.ppAPagar = (i, val) => { if (_lineas[i]) { _lineas[i].aPagar = num(val); window.ppAutoMonto() } }

const _banco = () => _ctx.bancos.find(b => String(b.id) === v('ppCuenta')) || null
const _monedaPago = () => _banco()?.moneda || 'USD'

/** Muestra u oculta lo que depende del destinatario y del medio de pago. */
window.ppAplicarMedio = function (cambioDocs = false) {
  const marc = _lineas.filter(l => l.marcado)
  const grupo = marc.length ? _grupoDe(marc[0]) : null
  const med = $('ppMedio')
  if (grupo && med && (cambioDocs ? med.dataset.auto !== '0' : false)) { med.value = GRUPOS[grupo].medio; med.dataset.auto = '1' }
  const ext = v('ppMedio') === 'transferencia_exterior'
  document.querySelectorAll('#modal-pagos-proveedor .pp-ext').forEach(el => { el.style.display = ext ? '' : 'none' })
  const d = $('ppDestino'); if (d) { d.style.display = grupo && GRUPOS[grupo].nota ? '' : 'none'; d.innerHTML = grupo ? `<b>Destinatario: ${GRUPOS[grupo].nombre}.</b> ${GRUPOS[grupo].nota}` : '' }
  if (ext && !v('ppBenef') && _ctx.proveedor?.nombre) $('ppBenef').value = _ctx.proveedor.nombre
  window.ppRecalcular?.()
}
window.ppCambioCuenta = function (silencioso = false) {
  const b = _banco()
  $('ppMoneda').value = b ? (b.moneda || 'USD') : ''
  const s = $('ppSaldoBanco'); if (s) s.textContent = b ? `· saldo ${SIM[b.moneda] || b.moneda} ${n2(b.saldo_actual)}` : ''
  window.ppAutoMonto()
}

/** Monto pagado sugerido = suma de lo marcado, convertido a la moneda de la cuenta con el T.C. */
window.ppAutoMonto = function () {
  const mp = _monedaPago(), tc = num(v('ppTC'))
  const marcadas = _lineas.filter(l => l.marcado)
  const mixta = marcadas.some(l => l.moneda !== mp)
  const sug = marcadas.reduce((t, l) => t + conv(num(l.aPagar), l.moneda, mp, tc), 0)
  const ay = $('ppMontoAyuda')
  if (ay) ay.textContent = marcadas.length ? (mixta ? `· ${SIM[mp] || mp} ${n2(sug)} según el T.C.` : `· suma de lo marcado`) : ''
  if ($('ppMonto')?.dataset.auto === '1') $('ppMonto').value = sug > 0 ? sug.toFixed(2) : ''
  window.ppRecalcular()
}

window.ppRecalcular = function () {
  const mp = _monedaPago(), tc = num(v('ppTC'))
  const monto = num(v('ppMonto'))
  const t = monto + num(v('ppComTransf')) + (v('ppMedio') === 'transferencia_exterior' ? num(v('ppComSwift')) : 0)
  if ($('ppTotalDeb')) $('ppTotalDeb').value = v('ppCuenta') ? `${SIM[mp] || mp} ${n2(t)}` : ''
  const usd = mp === 'USD' ? monto : (tc ? monto / tc : 0), pen = mp === 'PEN' ? monto : monto * tc
  const marcadas = _lineas.filter(l => l.marcado)
  const esperado = marcadas.reduce((s, l) => s + conv(num(l.aPagar), l.moneda, mp, tc), 0)
  const dif = monto - esperado
  const eq = $('ppEquiv'); if (!eq) return
  eq.innerHTML = monto > 0 ? `Equivale a <strong>US$ ${n2(usd)}</strong> · <strong>S/ ${n2(pen)}</strong> (T.C. ${tc ? tc.toFixed(3) : '—'})`
    + (() => {
      if (!marcadas.length || Math.abs(dif) <= 0.005) return ''
      const aj = _ajusteAnticipo(marcadas, monto, mp, tc)
      if (aj) return ` · <span style="color:var(--color-info,#0369a1);">Anticipo: pagas ${aj.linea.moneda} ${n2(aj.linea.aPagar - aj.defDoc)} de ${n2(aj.linea.aPagar)}. La diferencia (${aj.linea.moneda} ${n2(aj.defDoc)}) se cobrará en el <strong>saldo del CI</strong> y el anticipo se cierra como pagado.</span>`
      return ` · <span style="color:var(--color-warning,#b45309);">diferencia con lo aplicado: ${SIM[mp] || mp} ${dif > 0 ? '+' : ''}${n2(dif)} (redondeo o diferencia del banco)</span>`
    })() : ''
}

window.ppTCDelDia = async function (forzar = false) {
  const campo = $('ppTC'), aviso = $('ppTCAviso')
  if (!campo) return
  if (!forzar && campo.dataset.auto !== '1') return
  if (aviso) aviso.textContent = 'Buscando…'
  try {
    const r = await getTipoCambioDia(v('ppFecha') || null, { permitirApi: forzar })
    const tc = (r && (r.venta || r.compra || r.tc)) || null
    if (!tc) { if (aviso) aviso.textContent = '— ingrésalo a mano'; return }
    campo.value = parseFloat(tc).toFixed(3); campo.dataset.auto = '1'
    if (aviso) aviso.textContent = `(SUNAT venta ${(r && r.fecha) || v('ppFecha')})`
    window.ppAutoMonto()
  } catch { if (aviso) aviso.textContent = '— ingrésalo a mano' }
}

window.ppNuevo = function (sel) {
  if (_ctx.sinSQL) { showToast('Falta correr el SQL 116 para registrar pagos', 'danger'); return }
  _preparar(typeof sel === 'string' || Array.isArray(sel) ? sel : 'anticipo', null)
}
window.ppEditar = function (id) {
  const p = _ctx.pagos.find(x => x.id === id); if (!p) return
  _preparar(null, p)
  $('ppFormWrap').scrollIntoView({ behavior: 'smooth', block: 'start' })
}
window.ppCancelarBtn = function () { if ($('modal-pagos-proveedor')?.dataset.modo === 'rapido') window.cerrarPagosProveedor(); else window.ppCancelar() }
window.ppCancelar = function () {
  _archivos = []; _editId = null
  if ($('ppFormWrap')) $('ppFormWrap').style.display = 'none'
  if ($('ppBtnNuevo')) $('ppBtnNuevo').style.display = ''
  if ($('ppBtnGuardar')) $('ppBtnGuardar').style.display = 'none'
  if ($('ppBtnCancelar')) $('ppBtnCancelar').style.display = 'none'
}

// ─── Documentos del pago ─────────────────────────────────────────────────────
const _TIPOS_DOC_PAGO = ['voucher', 'swift', 'correo', 'contrato', 'otro']
const _adivinarTipo = nombre => {
  const n = String(nombre || '').toLowerCase()
  if (/swift|mt103|gpi|uetr/.test(n)) return 'swift'
  if (/correo|mail|email|outlook|confirm|gmail/.test(n)) return 'correo'
  if (/contrato|contract|sales/.test(n)) return 'contrato'
  if (/voucher|constancia|transf|pago|bcp|operaci|cheque|sunat|vep/.test(n)) return 'voucher'
  return _archivos.some(a => a.concepto === 'voucher') ? (_archivos.some(a => a.concepto === 'swift') ? 'correo' : 'swift') : 'voucher'
}
function _pintarDocs() {
  const lista = $('ppPendientes'); if (!lista) return
  const n = _archivos.length
  if ($('ppDocsN')) $('ppDocsN').textContent = n ? `· ${n}` : ''
  lista.innerHTML = _archivos.map((a, i) => {
    const opts = _TIPOS_DOC_PAGO.map(k => `<option value="${k}"${a.concepto === k ? ' selected' : ''}>${_esc(ADJ_CONCEPTOS[k] || k)}</option>`).join('')
    return `<div class="pp-doc">
      <div class="pp-doc-vista">${miniaturaArchivoHTML(`ppThumb${i}`)}</div>
      <div class="pp-doc-info"><div class="pp-doc-nombre" title="${_esc(a.file.name)}">${_esc(a.file.name)}</div>
        <div class="pp-doc-peso">${formatNumber(a.file.size / 1024, 0)} KB</div></div>
      <select onchange="window.ppTipoDoc(${i}, this.value)" aria-label="Tipo de documento">${opts}</select>
      <button type="button" class="pp-doc-x" onclick="window.ppQuitarDoc(${i})" title="Quitar">✕</button></div>`
  }).join('')
  _archivos.forEach((a, i) => pintarMiniaturaArchivo($(`ppThumb${i}`), a.file))
}
function _agregarDocs(files) {
  const errores = []
  for (const f of files || []) {
    const err = validarArchivoAdjunto(f)
    if (err) { errores.push(err); continue }
    if (_archivos.some(a => a.file.name === f.name && a.file.size === f.size)) continue
    _archivos.push({ file: f, concepto: _adivinarTipo(f.name) })
  }
  _pintarDocs()
  if (errores.length) showToast(errores[0], 'warning')
}
window.ppTipoDoc = (i, t) => { if (_archivos[i]) _archivos[i].concepto = t }
window.ppQuitarDoc = i => { _archivos.splice(i, 1); _pintarDocs() }
function _cablearDrop() {
  const z = $('ppDrop'); if (!z || z.dataset.listo) return
  z.dataset.listo = '1'
  $('ppArchivos').addEventListener('change', e => { _agregarDocs([...e.target.files]); e.target.value = '' })
  ;['dragenter', 'dragover'].forEach(ev => z.addEventListener(ev, e => { e.preventDefault(); z.classList.add('sobre') }))
  ;['dragleave', 'drop'].forEach(ev => z.addEventListener(ev, e => { e.preventDefault(); z.classList.remove('sobre') }))
  z.addEventListener('drop', e => _agregarDocs([...(e.dataTransfer?.files || [])]))
  document.addEventListener('paste', e => {
    if (!$('modal-pagos-proveedor')?.classList.contains('show') || $('ppFormWrap')?.style.display === 'none') return
    const fs = [...(e.clipboardData?.files || [])]
    if (fs.length) { e.preventDefault(); _agregarDocs(fs) }
  })
}

// ─── Bancos ──────────────────────────────────────────────────────────────────
const _resumenDocs = apps => apps.map(a => a.concepto || DOC_TIPOS[a.doc_tipo] || a.doc_tipo).join(' + ')

/** Crea (o vincula, si ya existe un egreso igual) el movimiento de Bancos del pago. Devuelve {movId, comId, vinculado}. */
async function _asentarBanco(pago, apps, { confirmarDuplicado = false } = {}) {
  const user = await getCurrentUser()
  const concepto = `Pago importación · Carpeta ${_ctx.carpeta?.numero_carpeta || ''} · ${_resumenDocs(apps) || TIPOS_PAGO[pago.tipo]}`
  let movId = null, vinculado = false
  if (confirmarDuplicado) {
    const existentes = ((await query('movimientos_banco', { banco_id: pago.cuenta_origen_id })) || []).filter(m => m.tipo === 'egreso'
      && Math.abs(num(m.monto) - num(pago.monto_transferido)) < 0.015
      && Math.abs((new Date(m.fecha) - new Date(pago.fecha)) / 86400000) <= 4)
    const ya = existentes.find(m => !_ctx.pagos.some(p => p.id !== pago.id && (p.movimiento_banco_id === m.id || p.movimiento_comision_id === m.id)))
    if (ya && confirm(`En Bancos ya existe un egreso igual:\n\n#${ya.id} · ${fechaDMY(ya.fecha)} · ${n2(ya.monto)} · ${ya.concepto}\n\nAceptar = vincularlo a este pago (no se duplica ni cambia el saldo).\nCancelar = crear un egreso nuevo.`)) {
      movId = ya.id; vinculado = true
    }
  }
  if (!movId) {
    const m = await addMovimientoBanco({ banco_id: pago.cuenta_origen_id, fecha: pago.fecha, tipo: 'egreso', concepto, categoria: 'pago_importacion',
      referencia: `IMP-PAGO-${pago.id}`, numero_operacion: pago.codigo_operacion || null, monto: num(pago.monto_transferido), created_by: user?.db_id || null })
    if (!m?.id) throw new Error('No se pudo registrar el egreso en Bancos: ' + (ultimoErrorInsert()?.message || ''))
    movId = m.id
  }
  let comId = null
  const com = num(pago.comision_transferencia) + num(pago.comision_swift)
  if (com > 0 && !vinculado) {
    const c = await addMovimientoBanco({ banco_id: pago.cuenta_origen_id, fecha: pago.fecha, tipo: 'egreso', concepto: `Comisión bancaria · ${concepto}`, categoria: 'gasto_banco',
      referencia: `IMP-PAGO-${pago.id}-COM`, numero_operacion: pago.codigo_operacion || null, monto: com, created_by: user?.db_id || null })
    comId = c?.id || null
  }
  await update('importacion_pagos', pago.id, { movimiento_banco_id: movId, movimiento_comision_id: comId })
  return { movId, comId, vinculado }
}

async function _quitarBanco(pago) {
  for (const id of [pago.movimiento_banco_id, pago.movimiento_comision_id]) if (id) { try { await deleteMovimientoBanco(id) } catch (e) { console.warn('movimiento', id, e) } }
  if (pago.movimiento_banco_id || pago.movimiento_comision_id) await update('importacion_pagos', pago.id, { movimiento_banco_id: null, movimiento_comision_id: null })
}

window.ppRegistrarBanco = async function (id) {
  try {
    const p = _ctx.pagos.find(x => x.id === id); if (!p) return
    if (!p.cuenta_origen_id) { showToast('Primero elige la cuenta de origen (✏️ editar)', 'warning'); return }
    const apps = _ctx.apps.filter(a => a.pago_id === id)
    const r = await _asentarBanco(p, apps, { confirmarDuplicado: true })
    showToast(r.vinculado ? 'Vinculado al egreso existente en Bancos' : 'Egreso registrado en Bancos', 'success')
    window.invalidarCache?.(['bancos', 'movimientos_banco'])
    await _cargar(); await _repintar()
  } catch (e) { console.error(e); showToast(e.message || 'No se pudo registrar en Bancos', 'danger') }
}

// ─── Sincronizar DAM / ajustes con sus pagos ─────────────────────────────────
/** estado, fecha y T.C. de pago de la DAM y de los ajustes salen de los pagos (no se escriben a mano). */
async function _sincronizarDocs() {
  await _cargarPagosApps()
  const obs = obligacionesCarpeta()
  const ultimo = (doc_tipo, doc_id) => {
    const ids = new Set(_ctx.apps.filter(a => a.doc_tipo === doc_tipo && (a.doc_id ?? null) == (doc_id ?? null)).map(a => a.pago_id))
    return _ctx.pagos.filter(p => ids.has(p.id) && valido(p)).sort((a, b) => String(b.fecha).localeCompare(String(a.fecha)))[0] || null
  }
  const dam = _ctx.dam
  if (dam) {
    const t = obs.find(o => o.doc_tipo === 'dam_tributos')
    if (t) {
      const lp = ultimo('dam_tributos', dam.id)
      if (t.estado === 'pagado' && lp) { if (dam.estado !== 'pagado' || dam.fecha_pago !== lp.fecha) await update('dams', dam.id, { estado: 'pagado', fecha_pago: lp.fecha, tipo_cambio: num(lp.tipo_cambio) || dam.tipo_cambio }) }
      else if (t.estado !== 'pagado' && dam.estado === 'pagado') { await update('dams', dam.id, { estado: 'pendiente' }) }
    }
    for (const a of _ctx.ajustes) {
      const o = obs.find(x => x.doc_tipo === 'ajuste_valor' && x.doc_id === a.id); if (!o) continue
      const lp = ultimo('ajuste_valor', a.id)
      if (o.estado === 'pagado' && lp) { if (a.estado !== 'pagada' || a.fecha_pago !== lp.fecha) await update('dam_autoliquidaciones', a.id, { estado: 'pagada', fecha_pago: lp.fecha, tipo_cambio: num(lp.tipo_cambio) || a.tipo_cambio }) }
      else if (o.estado !== 'pagado' && a.estado === 'pagada') await update('dam_autoliquidaciones', a.id, { estado: 'pendiente' })
    }
  }
}
async function _cargarPagosApps() {
  const [pagos, apps] = await Promise.all([query('importacion_pagos', { carpeta_importacion_id: _ctx.carpetaId }), query('importacion_pago_aplicaciones', { carpeta_importacion_id: _ctx.carpetaId })])
  _ctx.pagos = (pagos || []).sort((a, b) => String(a.fecha).localeCompare(String(b.fecha)) || a.id - b.id)
  _ctx.apps = apps || []
  if (_ctx.ci) { const d = ((await query('dams', { importacion_id: _ctx.ci.id })) || [])[0]; if (d) { _ctx.dam = d; _ctx.ajustes = ((await query('dam_autoliquidaciones', { dam_id: d.id })) || []).filter(a => a.estado !== 'desestimada') } }
}

// ─── Guardar ─────────────────────────────────────────────────────────────────
async function _comisionesALedger(pago, user) {
  const avisos = []
  for (const [monto_c, etiqueta] of [[num(pago.comision_transferencia), 'Comisión de transferencia'], [num(pago.comision_swift), 'Comisión SWIFT']]) {
    if (monto_c <= 0) continue
    try {
      await crearLineaCosto({
        tipo: 'voucher_bancario', tipo_comprobante: null, serie: null, numero: null,
        proveedor_id: null, fecha_emision: pago.fecha, moneda: pago.moneda, tipo_cambio: pago.tipo_cambio,
        monto_sin_igv: monto_c, igv_monto: 0, monto_total: monto_c, estado_pago: 'pagado', es_provisional: false, sustentado: true,
        empresa_id: _ctx.carpeta?.empresa_id ?? undefined
      }, {
        carpeta_importacion_id: _ctx.carpetaId, grupo: 'financiero',
        concepto: `${etiqueta} — ${TIPOS_PAGO[pago.tipo] || pago.tipo}`, concepto_codigo: 'comision_bancaria',
        clasificacion: 'gasto_financiero', entra_costo_contable: false, entra_costo_gestion: true,
        moneda: pago.moneda, tipo_cambio: pago.tipo_cambio, monto_moneda: monto_c, igv_monto: 0,
        base_prorrateo: 'valor_fob', es_provisional: false, observaciones: MARCA_COMISION(pago.id)
      }, user?.db_id)
    } catch (e) { console.error('Comisión al ledger:', e); avisos.push(`${etiqueta} no pasó al costeo (${e.message}); regístrala en Costos.`) }
  }
  return avisos
}
async function _quitarComisionesLedger(id) {
  const lineas = ((await query('importacion_costos', { carpeta_importacion_id: _ctx.carpetaId })) || []).filter(l => l.observaciones === MARCA_COMISION(id))
  for (const l of lineas) await deleteRecord('importacion_costos', l.id)
}

window.ppGuardar = async function () {
  const btn = $('ppBtnGuardar')
  try {
    const b = _banco()
    if (!b) throw new Error('Elige la cuenta de donde sale el pago')
    const mp = b.moneda || 'USD'
    const monto = num(v('ppMonto')), tc = num(v('ppTC'))
    if (!v('ppFecha')) throw new Error('Falta la fecha de la operación')
    if (monto <= 0) throw new Error('El monto pagado debe ser mayor a 0')
    if (tc <= 0) throw new Error('Falta el tipo de cambio (usa ⟳)')
    const marcadas = _lineas.filter(l => l.marcado && num(l.aPagar) > 0)
    if (!marcadas.length) throw new Error('Marca al menos un documento a pagar')
    const grupos = [...new Set(marcadas.map(_grupoDe))]
    if (grupos.length > 1) throw new Error('Un pago es para un solo destinatario: separa ' + grupos.map(g => GRUPOS[g].nombre).join(' y '))
    const grupo = grupos[0], ext = v('ppMedio') === 'transferencia_exterior'
    const comSwift = ext ? num(v('ppComSwift')) : 0
    const cod = v('ppCodOp')
    if (GRUPOS[grupo].exigeOp && !cod && v('ppEstado') === 'ejecutado') throw new Error(grupo === 'sunat' ? 'Falta el N° de operación / código de pago SUNAT de la constancia' : 'Falta el N° de operación del voucher')
    if (ext && !v('ppBenef')) throw new Error('Falta el beneficiario de la transferencia al exterior')
    if (grupo === 'proveedor' && !ext && !confirm('Un pago al proveedor del exterior normalmente es «Transferencia al exterior (SWIFT)». ¿Registrarlo con otro medio?')) return
    if (grupo === 'sunat' && ext) throw new Error('Los pagos a SUNAT no se hacen por transferencia al exterior: elige VEP, depósito o transferencia nacional')
    if (v('ppFecha') > new Date().toISOString().slice(0, 10) && v('ppEstado') === 'ejecutado') throw new Error('La fecha es futura: márcalo «En proceso» o corrige la fecha')
    const ajAnt = _ajusteAnticipo(marcadas, monto, mp, tc)
    { const esperado = marcadas.reduce((t, l) => t + conv(num(l.aPagar), l.moneda, mp, tc), 0)
      if (ajAnt) { if (!confirm(`Anticipo de la PI: pagas ${ajAnt.linea.moneda} ${n2(ajAnt.linea.aPagar - ajAnt.defDoc)} y la PI pedía ${n2(ajAnt.linea.aPagar)}.\n\nLa diferencia (${ajAnt.linea.moneda} ${n2(ajAnt.defDoc)}) pasará al saldo del CI y el anticipo quedará como pagado.\n\n¿Continuar?`)) return }
      else if (esperado > 0 && Math.abs(monto - esperado) / esperado > 0.01 && !confirm(`El monto pagado (${SIM[mp] || mp} ${n2(monto)}) difiere más de 1% de lo aplicado a los documentos (${SIM[mp] || mp} ${n2(esperado)}).\n\n¿Registrarlo igual?`)) return }
    if (cod && _ctx.pagos.some(p => p.id !== _editId && p.codigo_operacion === cod)) throw new Error(`El código de operación ${cod} ya está registrado en esta carpeta`)
    for (const l of marcadas) if (num(l.aPagar) > l.pendiente + 0.01 &&
      !confirm(`«${l.titulo}»: pagas ${l.moneda} ${n2(l.aPagar)} y solo faltan ${l.moneda} ${n2(l.pendiente)}.\n\n¿Registrarlo igual?`)) return
    if (v('ppEstado') === 'ejecutado' && v('ppEnBancos') !== '' && $('ppEnBancos').checked && num(b.saldo_actual) < monto + num(v('ppComTransf')) + comSwift && !_editId &&
      !confirm(`La cuenta ${b.nombre} tiene ${SIM[mp] || mp} ${n2(b.saldo_actual)} y este pago debita ${SIM[mp] || mp} ${n2(monto + num(v('ppComTransf')) + comSwift)}.\n\n¿Registrarlo igual?`)) return

    btn.disabled = true; btn.textContent = 'Guardando…'
    const user = await getCurrentUser()
    const tipos = [...new Set(marcadas.map(l => TIPO_POR_DOC[l.doc_tipo] || 'otro'))]
    const tipo = tipos.length === 1 ? tipos[0] : (tipos.every(t => ['anticipo', 'saldo'].includes(t)) ? 'pago_total' : 'combinado')
    const fila = {
      carpeta_importacion_id: _ctx.carpetaId, orden_compra_id: _ctx.oc?.id || null,
      tipo, fecha: v('ppFecha'), moneda: mp, tipo_cambio: tc, monto_transferido: monto,
      comision_transferencia: num(v('ppComTransf')), comision_swift: comSwift,
      cuenta_origen_id: b.id, medio: v('ppMedio') || null,
      monto_equiv_usd: mp === 'USD' ? monto : Math.round(monto / tc * 100) / 100,
      monto_equiv_pen: mp === 'PEN' ? monto : Math.round(monto * tc * 100) / 100,
      beneficiario: ext ? (v('ppBenef') || null) : null, banco_beneficiario: ext ? (v('ppBancoBenef') || null) : null,
      swift_bic: ext ? (v('ppSwift').toUpperCase() || null) : null, referencia: v('ppObs') || null,
      codigo_operacion: cod || null, uetr: ext ? (v('ppUetr') || null) : null, estado: v('ppEstado')
    }
    const avisos = []
    let pagoId = _editId
    const previo = _editId ? _ctx.pagos.find(p => p.id === _editId) : null
    if (_editId) {
      if (previo.movimiento_banco_id || previo.movimiento_comision_id) await _quitarBanco(previo)   // se recrea con los datos nuevos
      await _quitarComisionesLedger(_editId)
      const ok = await update('importacion_pagos', _editId, { ...fila, es_historico: previo.es_historico && !$('ppEnBancos').checked ? true : false })
      if (!ok) throw new Error('No se pudo actualizar el pago')
      for (const a of _ctx.apps.filter(a => a.pago_id === _editId)) await deleteRecord('importacion_pago_aplicaciones', a.id)
    } else {
      const g = await insert('importacion_pagos', { ...fila, created_by: user?.db_id || null })
      if (!g?.id) {
        const msg = ultimoErrorInsert()?.message || ultimoErrorInsert()?.mensaje || ''
        if (/tipo_check|violates check/i.test(msg)) throw new Error('Falta correr assets/sql/116_pagos_importacion_unificados.sql')
        throw new Error(msg || 'No se pudo registrar el pago (¿la carpeta está cerrada?)')
      }
      pagoId = g.id
    }
    // Aplicaciones
    const apps = []
    for (const l of marcadas) {
      const esAj = ajAnt && ajAnt.linea === l
      const montoDoc = esAj ? Math.round((num(l.aPagar) - ajAnt.defDoc) * 100) / 100 : num(l.aPagar)
      const concepto = esAj ? `${l.titulo} ${MARCA_CIERRA}: −${n2(ajAnt.defDoc)} pasa al saldo del CI]` : l.titulo
      const a = await insert('importacion_pago_aplicaciones', { pago_id: pagoId, carpeta_importacion_id: _ctx.carpetaId, doc_tipo: l.doc_tipo, doc_id: l.doc_id ?? null, concepto, moneda_doc: l.moneda, monto_doc: montoDoc })
      if (!a?.id) { if (!_editId) await deleteRecord('importacion_pagos', pagoId); throw new Error('No se pudo aplicar el pago a los documentos: ' + (ultimoErrorInsert()?.message || '')) }
      apps.push(a)
    }
    const pagoFinal = { ...(previo || {}), ...fila, id: pagoId }
    avisos.push(...await _comisionesALedger(pagoFinal, user))
    // Bancos
    if ($('ppEnBancos').checked && fila.estado === 'ejecutado') {
      try { await _asentarBanco(pagoFinal, apps, { confirmarDuplicado: !!previo?.es_historico }) }
      catch (e) { avisos.push(e.message) }
    }
    if (_archivos.length) {
      const res = await subirAdjuntos('importacion_pago', pagoId, _archivos, user?.db_id)
      if (res?.errores?.length) avisos.push(`${res.ok} adjunto(s) subidos. ${res.errores[0]}`)
    }
    await _cargarPagosApps()
    await _sincronizarDocs()
    window.invalidarCache?.(['bancos', 'movimientos_banco'])
    showToast(avisos.length ? `Pago guardado. ${avisos[0]}` : 'Pago guardado', avisos.length ? 'warning' : 'success')
    await _cargar(); window.ppCancelar(); await _repintar()
    if (typeof window.renderCostosLedger === 'function') window.renderCostosLedger()
    if ($('modal-pagos-proveedor')?.dataset.modo === 'rapido') window.cerrarPagosProveedor(); else { Promise.resolve(window.renderHojaCosteo?.()).then(() => window.onPagosCambiaron?.()) }
  } catch (e) {
    console.error('ppGuardar:', e)
    showToast(e.message || 'No se pudo guardar el pago', 'danger')
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '💾 Guardar pago' }
  }
}

// ─── Adjuntos / eliminar ─────────────────────────────────────────────────────
window.ppVerAdjuntos = async function (id) {
  const box = $('ppAdjuntosVista'); if (!box) return
  const adjs = await getAdjuntos('importacion_pago', id)
  if (!adjs.length) { box.innerHTML = 'Este pago no tiene documentos adjuntos.'; return }
  box.innerHTML = `<div class="pp-guardados">${adjs.map(a => `<div class="pp-guardado">
      <span class="adj-thumb" data-adj-path="${_esc(a.path)}" data-adj-nombre="${_esc(a.nombre)}">…</span>
      <div><div class="pp-doc-nombre" title="${_esc(a.nombre)}">${_esc(a.nombre)}</div><div class="pp-doc-peso">${_esc(ADJ_CONCEPTOS[a.concepto] || a.concepto)}</div></div></div>`).join('')}</div>`
}

window.ppEliminar = async function (id) {
  const p = _ctx.pagos.find(x => x.id === id); if (!p) return
  if (!confirm(`¿Eliminar el pago de ${p.moneda} ${n2(p.monto_transferido)} del ${fechaDMY(p.fecha)}?\n\nSe quitan también su egreso en Bancos (si lo tiene), sus comisiones del costeo y sus documentos. Los documentos que pagaba vuelven a quedar pendientes.`)) return
  try {
    await _quitarBanco(p)
    await _quitarComisionesLedger(id)
    await eliminarAdjuntosDe('importacion_pago', id)
    const ok = await deleteRecord('importacion_pagos', id)
    if (!ok) throw new Error('No se pudo eliminar (¿la carpeta está cerrada?)')
    await _sincronizarDocs()
    window.invalidarCache?.(['bancos', 'movimientos_banco'])
    showToast('Pago eliminado', 'success')
    await _cargar(); await _repintar(); Promise.resolve(window.renderHojaCosteo?.()).then(() => window.onPagosCambiaron?.())
    if (typeof window.renderCostosLedger === 'function') window.renderCostosLedger()
  } catch (e) { showToast(e.message || 'No se pudo eliminar', 'danger') }
}

/** Bloque «Pagos» para incrustar en el modal de un documento (PI, CI, DAM, ajuste…). Usa lo cargado por la hoja. */
window.pagosBloqueHtml = function (docTipo, docId, titulo = 'Pagos') {
  const d = window.hcUltimo?.d; if (!d) return ''
  const ctx = { oc: d.pi, ci: d.ci, cis: d.cis, dams: d.damsAll, dam: d.dam, ajustes: (d.ajustes || []).filter(a => a.estado !== 'desestimada') }
  const pagos = d.pagos || [], apps = d.apps || []
  const vivos = new Set(pagos.filter(valido).map(p => p.id))
  const mias = apps.filter(a => a.doc_tipo === docTipo && (a.doc_id ?? null) == (docId ?? null))
  const pagado = mias.filter(a => vivos.has(a.pago_id)).reduce((t, a) => t + num(a.monto_doc), 0)
  const ob = window.hcObligacion?.(docTipo, docId)
  const filas = mias.map(a => { const p = pagos.find(x => x.id === a.pago_id); return p ? `<tr><td>${fechaDMY(p.fecha)}</td><td>${SIM[a.moneda_doc] || a.moneda_doc} ${n2(a.monto_doc)}</td><td><small>${SIM[p.moneda] || p.moneda} ${n2(p.monto_transferido)} · T.C. ${num(p.tipo_cambio).toFixed(3)}</small></td><td>${_esc(MEDIOS[p.medio] || '')}</td></tr>` : '' }).join('')
  const estado = ob ? chipE(ob.estado) : ''
  return `<div style="margin:12px 0;"><div style="display:flex; align-items:center; gap:8px; margin-bottom:6px;"><strong style="font-size:.85rem;">${_esc(titulo)}</strong>${estado}
      ${ob ? `<span style="font-size:.8rem; color:var(--text-secondary);">${SIM[ob.moneda] || ob.moneda} ${n2(pagado)} de ${n2(ob.total)}</span>` : ''}
      ${ob && ob.estado === 'pagado' ? '' : `<button type="button" class="btn btn-primary btn-small" style="margin-left:auto;" onclick="window.pagarDocumento('${docTipo}', ${docId ?? 'null'})">＋ ${ob?.estado === 'parcial' ? 'Registrar otro pago' : 'Registrar pago'}</button>`}</div>
    ${filas ? `<table style="width:100%; font-size:.82rem;"><thead><tr style="color:var(--text-secondary);"><th align="left">Fecha</th><th align="left">Aplicado</th><th align="left">Pagado</th><th align="left">Medio</th></tr></thead><tbody>${filas}</tbody></table>` : '<div style="font-size:.82rem; color:var(--text-secondary);">Sin pagos registrados.</div>'}</div>`
}
/** Estado calculado de un documento (para la hoja, la línea de tiempo y los modales). */
window.hcObligacion = function (docTipo, docId) {
  const d = window.hcUltimo?.d; if (!d) return null
  const ctx = { oc: d.pi, ci: d.ci, cis: d.cis, dams: d.damsAll, dam: d.dam, ajustes: (d.ajustes || []).filter(a => a.estado !== 'desestimada') }
  const save = { pagos: _ctx.pagos, apps: _ctx.apps }
  _ctx.pagos = d.pagos || []; _ctx.apps = d.apps || []
  try { return obligacionesCarpeta(ctx).find(o => o.doc_tipo === docTipo && (o.doc_id ?? null) == (docId ?? null)) || null }
  finally { _ctx.pagos = save.pagos; _ctx.apps = save.apps }
}

export default { abrirPagosProveedor: window.abrirPagosProveedor, TIPOS_PAGO, obligacionesCarpeta }
