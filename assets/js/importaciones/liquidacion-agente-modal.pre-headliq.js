// ============================================================================
// liquidacion-agente-modal.js — Liquidación del agente aduanero + devolución de saldo
// ----------------------------------------------------------------------------
// Etapa 4 de la carpeta. La liquidación del agente (ej. «2026-080») resume:
//   · facturas/gastos que el agente pagó por el cliente (se LEEN del ledger:
//     documentos_importacion de la carpeta; no se duplican costos)
//   · abonos del cliente al agente (USD y/o S/)
//   · saldo por moneda y devolución del saldo a favor
// Tablas (SQL 107): importacion_liquidaciones_agente, importacion_liquidacion_abonos,
// importacion_costos.liquidacion_agente_id.
// Uso: window.abrirLiquidacionAgente() · bloque de la hoja: window.renderEtapa4Liquidacion()
// ============================================================================
import { query, insert, update, deleteRecord, ultimoErrorInsert, esperarContextoEmpresa, supabase } from '../supabase-client.js'
import { getCurrentUser } from '../auth-supabase.js'
import { showToast, formatNumber, fechaDMY } from '../helpers.js'
import { aplicarModoVerEditar } from '../shared/ver-editar.js'
import { declararEmpresaModal } from '../empresa.js'
import { getTipoCambioDia } from '../sunat-api.js'
import { subirAdjuntos, getAdjuntos, getContacts } from '../supabase-data.js'
import { convertirEnBuscador, refrescarBuscador } from '../buscador-select.js'
import { abrirModalContacto } from '../shared/contacto-modal.js'
import { CONCEPTOS_COSTO, crearLineaCosto } from './costos-ledger.js'
import './gasto-factura.js'

const $ = id => document.getElementById(id)
const v = id => ($(id)?.value ?? '').toString().trim()
const num = x => { const n = parseFloat(String(x ?? '').replace(/,/g, '')); return isNaN(n) ? 0 : n }
const n2 = x => formatNumber(num(x), 2)
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const carpeta = () => window.carpetaActual || null
const SIGNO = m => (m === 'PEN' ? 'S/' : '$')
const MARCA_COM = id => `[comision-abono:${id}]`
const TIPOS_EXCLUIDOS = ['dam', 'autoliquidacion', 'voucher_bancario']

let _liq = null          // cabecera guardada (o null si es nueva)
let _docs = []           // candidatos: {id, titulo, numero, fecha, moneda, total, marcado}
let _abonos = []         // [{fecha, moneda, tipo_cambio, monto, operacion, banco_id, concepto}]
let _bancos = []
let _dam = null
let _costos = []        // ledger de la carpeta (para la auditoría proforma vs real)
let _prof = { numero: '', fecha: '', tc: '', gl: [], tr: [] }   // proforma del agente (pre-liquidación)

/** Líneas de la proforma: cada una con su moneda y monto (las antiguas guardaban solo usd / pen). */
const _normLineas = (arr, monDef) => (arr || []).map(l => ({ concepto: l.concepto || '', codigo: l.codigo || '',
  moneda: l.moneda || (l.usd != null && l.pen == null ? 'USD' : l.pen != null && l.usd == null ? 'PEN' : monDef),
  monto: l.monto ?? (l.moneda === 'PEN' || (l.pen != null && l.usd == null) ? l.pen : l.usd) ?? '' }))
// ── datos ─────────────────────────────────────────────────────────────────────
async function _cargarBase() {
  const c = carpeta()
  const costos = ((await query('importacion_costos', { carpeta_importacion_id: c.id })) || []).filter(k => !k.anulado)
  const ids = [...new Set(costos.map(k => k.documento_id).filter(Boolean))]
  let docs = []
  for (let i = 0; i < ids.length; i += 80) {   // .in() por tandas: query() corta en 1,000 filas
    const { data } = await supabase.from('documentos_importacion').select('*').in('id', ids.slice(i, i + 80))
    docs = docs.concat(data || [])
  }
  const fiscales = new Set(costos.filter(k => ['credito_fiscal', 'percepcion'].includes(k.clasificacion)).map(k => k.documento_id))
  const cand = docs.filter(d => !TIPOS_EXCLUIDOS.includes(d.tipo) && !fiscales.has(d.id) && !(d.tipo === 'voucher_bancario'))
  const concepto = id => costos.find(k => k.documento_id === id)?.concepto || ''
  return { costos, cand: cand.map(d => {
    const ks = costos.filter(k => k.documento_id === d.id)
    const igv = num(d.igv_monto), tot = num(d.monto_total)
    return { id: d.id, titulo: concepto(d.id) || d.tipo, numero: [d.serie, d.numero].filter(Boolean).join('-') || '—', fecha: d.fecha_emision, moneda: d.moneda, total: tot,
      igv, base: d.monto_sin_igv != null ? num(d.monto_sin_igv) : Math.max(0, tot - igv), costoIds: ks.map(k => k.id), compra_id: d.compra_id || null, regul: d.regularizacion || null }
  }) }
}

async function _cargarLiq() {
  const c = carpeta()
  const ci = window.costeoActual?.id ? window.costeoActual : null
  const [liqs, base, dams, bancos] = await Promise.all([
    query('importacion_liquidaciones_agente', { carpeta_importacion_id: c.id }),
    _cargarBase(),
    ci ? query('dams', { importacion_id: ci.id }) : [],
    query('bancos', {})
  ])
  _liq = (liqs || [])[0] || null
  const vinculados = new Set(base.costos.filter(k => _liq && k.liquidacion_agente_id === _liq.id).map(k => k.documento_id))
  _docs = base.cand.map(d => ({ ...d, marcado: _liq ? vinculados.has(d.id) : true }))
  _abonos = _liq ? (((await query('importacion_liquidacion_abonos', { liquidacion_agente_id: _liq.id })) || []).sort((a, b) => a.id - b.id)) : []
  _dam = (dams || [])[0] || null
  _bancos = bancos || []
  _costos = base.costos
  _prof = { numero: _liq?.proforma_numero || '', fecha: _liq?.proforma_fecha || '', tc: _liq?.proforma_tc || '', gl: _normLineas(_liq?.proforma_items?.gl, 'USD'), tr: _normLineas(_liq?.proforma_items?.tr, 'PEN') }
  return base
}

// ── cálculos ──────────────────────────────────────────────────────────────────
function _saldos(docs, abonos) {
  const r = { USD: { fact: 0, abono: 0 }, PEN: { fact: 0, abono: 0 } }
  for (const d of docs.filter(x => x.marcado)) (r[d.moneda === 'PEN' ? 'PEN' : 'USD']).fact += num(d.total)
  for (const a of abonos) (r[a.moneda === 'PEN' ? 'PEN' : 'USD']).abono += num(a.monto)
  r.USD.saldo = r.USD.abono - r.USD.fact
  r.PEN.saldo = r.PEN.abono - r.PEN.fact
  return r
}

// ── modal ─────────────────────────────────────────────────────────────────────
function _asegurarModal() {
  if ($('modal-liq-agente')) return
  document.body.insertAdjacentHTML('beforeend', `
  <div id="modal-liq-agente" class="modal">
    <div class="modal-content" style="width:min(96vw, 1040px); max-width:min(96vw, 1040px); max-height:calc(100vh - 48px); display:flex; flex-direction:column;">
      <div class="modal-header"><h3 class="modal-title" id="laTitulo">Liquidación del agente</h3>
        <button class="modal-close" onclick="window.cerrarLiqAgente()">&times;</button></div>
      <div style="padding:4px 20px 0;">
        <div class="costeo-selector dm-carpeta"><label>Carpeta:</label><select id="laCarpeta" disabled></select></div>
        <div class="form-group" style="margin:6px 0 2px;"><label>Agente aduanero <span class="bl-en">(busca por nombre o RUC · se hereda de la DAM si ya lo tiene)</span> <small id="laAgHint" style="font-weight:400; color:var(--text-secondary);"></small></label>
          <select id="laAgente"></select></div>
        <div class="la-steps" id="laSteps"></div>
      </div>
      <div class="la-body" style="padding:0 20px 8px; overflow-y:auto; flex:1;">

        <section class="la-panel" data-p="1">
          <div class="dm-explica">📝 <b>Paso 1 · Proforma del agente.</b> Estimación que te envía <span class="la-ag">el agente</span> antes del despacho (gastos locales en USD y derechos en S/). <b>No es costo</b>: sirve para auditar contra la liquidación final.</div>
          <div class="la-grid">
            <div class="form-group"><label>N° de proforma</label><input type="text" id="laPfNumero" maxlength="40" placeholder="2026-091" oninput="window.laPfSet('numero', this.value)"></div>
            <div class="form-group"><label>Fecha</label><input type="date" id="laPfFecha" onchange="window.laPfSet('fecha', this.value); window.laPfTCDia(false)"></div>
            <div class="form-group"><label>T.C. de la proforma <span id="laPfTCaviso" style="font-weight:400; color:var(--text-secondary); font-size:.75rem;"></span></label><div style="display:flex; gap:4px;"><input type="number" id="laPfTC" step="0.001" oninput="window.laPfSet('tc', this.value)"><button type="button" class="btn btn-secondary btn-small" data-solo-edicion onclick="window.laPfTCDia(true)" title="Consultar el T.C. venta SUNAT de la fecha de la proforma">⟳</button></div></div>
          </div>
          <div class="la-pf-grid" style="grid-template-columns:1fr;">
            <div><div class="e3-sub">Gastos locales estimados <button type="button" class="btn btn-secondary btn-small" data-solo-edicion onclick="window.laPfAdd('gl')">+ Línea</button></div><div id="laPfGL"></div><div id="laPfGLsub"></div></div>
            <div><div class="e3-sub">Derechos estimados <button type="button" class="btn btn-secondary btn-small" data-solo-edicion onclick="window.laPfAdd('tr')">+ Línea</button></div><div id="laPfTR"></div><div id="laPfTRsub"></div></div>
          </div>
          <div id="laPfTot"></div>
          <div class="dm-nota">📎 PDF de la proforma: <button type="button" class="btn btn-secondary btn-small" onclick="window.laAdjuntar('proforma')">Subir PDF</button> <span id="laAdjProforma"></span></div>
        </section>

        <section class="la-panel" data-p="2">
          <div class="dm-explica">💵 <b>Paso 2 · Abono sobre la proforma.</b> Lo que le abonaste a <span class="la-ag">el agente</span> para que despache (provisión de fondos). Ej.: USD 2,370 del 11/09.</div>
          <div id="laResProf" style="margin-bottom:8px;"></div>
          <div class="e3-sub">Abonos de la proforma <button type="button" class="btn btn-secondary btn-small" data-solo-edicion onclick="window.laAddAbono('proforma')">+ Abono</button></div>
          <div id="laAbonosProf"></div>
          <div class="dm-nota">📎 Voucher / constancia del abono: <button type="button" class="btn btn-secondary btn-small" onclick="window.laAdjuntar('voucher')">Subir</button> <span class="laAdjVoucher"></span></div>
        </section>

        <section class="la-panel" data-p="3">
          <div class="dm-explica">📑 <b>Paso 3 · Liquidación final.</b> Lo que realmente pagó el agente. Las facturas se leen del costeo de la carpeta (no se vuelven a costear).</div>
          <div class="la-grid">
            <div class="form-group"><label>N° de liquidación *</label><input type="text" id="laNumero" maxlength="40" placeholder="2026-080" oninput="window.laPaso()"></div>
            <div class="form-group"><label>Fecha *</label><input type="date" id="laFecha"></div>
            <div class="form-group"><label>Estado</label>
              <select id="laEstado"><option value="conforme">Conforme</option><option value="observada">Observada</option><option value="borrador">Borrador</option></select></div>
            <div class="form-group"><label>DAM</label><input type="text" id="laDam" maxlength="60"></div>
          </div>
          <div class="e3-sub">Facturas y gastos pagados por el agente <small style="font-weight:400">(marca las que van en esta liquidación)</small> <button type="button" class="btn btn-secondary btn-small" data-solo-edicion onclick="window.laNuevaFactura()">＋ Factura de gasto</button></div>
          <div id="laDocs" style="margin-bottom:8px;"></div>
          <div class="e3-sub">Auditoría · proforma vs liquidación final</div>
          <div id="laAudit" style="margin-bottom:8px;"></div>
          <div class="dm-nota">📎 PDF de la liquidación: <button type="button" class="btn btn-secondary btn-small" onclick="window.laAdjuntar('liquidacion')">Subir PDF</button> <span id="laAdjN"></span></div>
        </section>

        <section class="la-panel" data-p="4">
          <div class="dm-explica">💵 <b>Paso 4 · Abono sobre la liquidación.</b> Lo que abonaste después para cubrir la diferencia. Ej.: S/ 1,284 del 16/10 (boletín + transporte).</div>
          <div id="laResLiq" style="margin-bottom:8px;"></div>
          <div class="e3-sub">Abonos de la liquidación <button type="button" class="btn btn-secondary btn-small" data-solo-edicion onclick="window.laAddAbono('liquidacion')">+ Abono</button></div>
          <div id="laAbonosLiq"></div>
          <div class="dm-nota">📎 Voucher / constancia del abono: <button type="button" class="btn btn-secondary btn-small" onclick="window.laAdjuntar('voucher')">Subir</button> <span class="laAdjVoucher"></span></div>
        </section>

        <section class="la-panel" data-p="5">
          <div class="dm-explica">⚖️ <b>Paso 5 · Saldo y devolución.</b> Abonos totales menos facturas de la liquidación. Si sobra a tu favor, el agente debe devolverlo.</div>
          <div id="laResultado" style="margin-bottom:8px;"></div>
          <div class="e3-sub">Devolución de saldo</div>
          <div class="la-grid">
            <div class="form-group"><label>Monto USD</label><input type="number" id="laDevMonto" step="0.01" oninput="window.laRecalcular()"></div>
            <div class="form-group"><label>Fecha</label><input type="date" id="laDevFecha"></div>
            <div class="form-group"><label>Medio</label><input type="text" id="laDevMedio" maxlength="60" placeholder="Transferencia interbancaria"></div>
            <div class="form-group"><label>N° de operación</label><input type="text" id="laDevOp" maxlength="60"></div>
            <div class="form-group" style="grid-column:span 2;"><label>Cuenta que recibe</label><select id="laDevBanco"></select></div>
            <div class="form-group"><label>Estado</label><select id="laDevEstado" onchange="window.laRecalcular()"><option value="">— sin devolución —</option><option value="en_proceso">En proceso</option><option value="recibida">Recibida</option></select></div>
            <div class="form-group"><label>Comisión a cargo de</label><select id="laDevComision"><option value="agente">Agente</option><option value="cliente">Cliente</option></select></div>
          </div>
          <div class="form-group"><label>Observaciones</label><textarea id="laObs" rows="2"></textarea></div>
        </section>
      </div>
      <div class="modal-footer" style="flex-wrap:wrap;">
        <button class="btn btn-secondary" onclick="window.laIr(window.laPasoActual - 1)">‹ Anterior</button>
        <button class="btn btn-secondary" onclick="window.laIr(window.laPasoActual + 1)">Siguiente ›</button>
        <span style="flex:1"></span>
        <button class="btn btn-secondary" data-solo-lectura onclick="window.cerrarLiqAgente()">Cerrar</button>
        <button class="btn btn-primary" data-solo-lectura onclick="window.laEditar()">✏️ Editar</button>
        <button class="btn btn-secondary" data-solo-edicion onclick="window.laCancelar()">Cancelar</button>
        <button class="btn btn-primary" data-solo-edicion onclick="window.guardarLiqAgente()">💾 Guardar</button>
      </div>
    </div>
  </div>`)
}

let _celda = null   // celda en edición (doble clic, estilo Excel): { i, col }
const COLS_ED = ['concepto', 'numero', 'fecha', 'base', 'igv']
function _pintarDocs() {
  const lectura = $('modal-liq-agente')?.dataset.modo === 'lectura'
  if (!_docs.length) { $('laDocs').innerHTML = '<div class="dm-nota">La carpeta aún no tiene facturas de gastos locales. Usa «＋ Factura de gasto» para registrarlas (entran al costeo y a esta liquidación).</div>'; return }
  const sub = { USD: { b: 0, i: 0, t: 0, n: 0 }, PEN: { b: 0, i: 0, t: 0, n: 0 } }
  for (const d of _docs.filter(x => x.marcado)) { const m = sub[d.moneda === 'PEN' ? 'PEN' : 'USD']; m.b += d.base; m.i += d.igv; m.t += d.total; m.n++ }
  const fila = (d, i) => {
    const S = SIGNO(d.moneda)
    const chk = `<td><input type="checkbox" style="width:auto;margin:0" ${d.marcado ? 'checked' : ''} ${lectura ? 'disabled' : ''} onchange="window.laMarcar(${i}, this.checked)"></td>`
    const editable = !lectura && d.costoIds.length === 1
    // Celda editable: doble clic → input; si no, texto
    const cel = (col, html, tipo, valor, cls = '') => {
      if (_celda && _celda.i === i && _celda.col === col) {
        const num_ = tipo === 'number'
        return `<td class="${cls} la-cel-ed">${num_ ? `<span class="la-mon">${S}</span>` : ''}<input id="laC_in" class="la-celda" type="${tipo}" ${num_ ? 'step="0.01"' : ''} value="${esc(valor)}" onkeydown="window.laCeldaTecla(event, ${i}, '${col}')" onblur="window.laCeldaBlur(${i}, '${col}')"></td>`
      }
      return `<td class="${cls} ${editable ? 'la-cel' : ''}" ${editable ? `ondblclick="window.laCeldaEd(${i}, '${col}')" title="Doble clic para editar"` : ''}>${html}</td>`
    }
    const estado = d.compra_id
      ? `<span class="badge badge-success" title="Compra #${d.compra_id} en el Registro de Compras">Compra #${d.compra_id}</span>${d.regul === 'pendiente' ? ' <span class="badge badge-warning" title="Pagada por el agente: concílíala en Cuentas por Pagar">Por regularizar</span>' : ''}`
      : (d.costoIds.length === 1 ? `<button type="button" class="la-reg" onclick="window.laRegistrarGasto(${d.costoIds[0]})" title="Abre el modal de compra de gasto con esta factura">🧾 Registrar gasto</button>` : '')
    return `<tr>${chk}
      ${cel('concepto', `<div class="la-glosa"><span>${esc(d.titulo)}</span>${estado}</div>`, 'text', d.titulo)}
      ${cel('numero', esc(d.numero), 'text', d.numero === '—' ? '' : d.numero)}
      ${cel('fecha', fechaDMY(d.fecha), 'date', d.fecha || '')}
      ${cel('base', `<span class="la-mon">${S}</span>${n2(d.base)}`, 'number', d.base.toFixed(2), 'la-num')}
      ${cel('igv', `<span class="la-mon">${S}</span>${n2(d.igv)}`, 'number', d.igv.toFixed(2), 'la-num')}
      <td class="la-num"><b><span class="la-mon">${S}</span>${n2(d.total)}</b></td>
      <td class="la-acc">${lectura || d.costoIds.length !== 1 ? '' : `<button type="button" class="la-edit" data-solo-edicion title="${d.compra_id ? 'Editar gasto (modal completo)' : 'Registrar / editar gasto (modal completo)'}" onclick="window.laRegistrarGasto(${d.costoIds[0]})">✏️</button>`}</td></tr>`
  }
  const pie = ['USD', 'PEN'].filter(m => sub[m].n).map(m => `<tr class="la-sub"><td></td><td colspan="3">Subtotal ${m === 'USD' ? 'dólares' : 'soles'} (${sub[m].n} marcadas)</td>
      <td class="la-num"><span class="la-mon">${SIGNO(m)}</span>${n2(sub[m].b)}</td><td class="la-num"><span class="la-mon">${SIGNO(m)}</span>${n2(sub[m].i)}</td><td class="la-num"><b><span class="la-mon">${SIGNO(m)}</span>${n2(sub[m].t)}</b></td><td></td></tr>`).join('')
  $('laDocs').innerHTML = `<div style="overflow-x:auto;"><table class="data-table la-tabla" style="width:100%"><thead><tr><th></th><th>Concepto (glosa)</th><th>N° doc.</th><th>Fecha</th><th class="la-num">Base imponible</th><th class="la-num">IGV</th><th class="la-num">Total</th><th></th></tr></thead><tbody>${_docs.map(fila).join('')}</tbody><tfoot>${pie}</tfoot></table></div>`
  if (_celda) setTimeout(() => { const e = $('laC_in'); if (e) { e.focus(); if (e.select && e.type !== 'date') e.select() } }, 0)
}

async function _refrescarDocs() {
  const previos = new Map(_docs.map(d => [d.id, d.marcado]))
  const base = await _cargarBase(); _costos = base.costos
  _docs = base.cand.map(d => ({ ...d, marcado: previos.has(d.id) ? !!previos.get(d.id) : true }))
  _pintarDocs(); aplicarModoVerEditar('modal-liq-agente', $('modal-liq-agente')?.dataset.modo === 'lectura'); window.laRecalcular(); window.laAuditar()
}
window.laRegistrarGasto = async function (costoId) {
  window._alGuardarCosto = async () => { window._alGuardarCosto = null; await _refrescarDocs() }
  await window.abrirGastoFactura?.(costoId)
}
window.laCeldaEd = (i, col) => { if (_celda) return; _celda = { i, col }; _pintarDocs(); aplicarModoVerEditar('modal-liq-agente', false) }
let _guardandoCelda = false
window.laCeldaTecla = (ev, i, col) => {
  if (ev.key === 'Enter') { ev.preventDefault(); _celdaGuardar(i, col, 0) }
  else if (ev.key === 'Escape') { ev.preventDefault(); _celda = null; _pintarDocs(); aplicarModoVerEditar('modal-liq-agente', false) }
  else if (ev.key === 'Tab') { ev.preventDefault(); _celdaGuardar(i, col, ev.shiftKey ? -1 : 1) }
}
window.laCeldaBlur = (i, col) => { setTimeout(() => { if (_celda && _celda.i === i && _celda.col === col && !_guardandoCelda) _celdaGuardar(i, col, 0) }, 120) }
async function _celdaGuardar(i, col, salto) {
  if (_guardandoCelda || !_celda) return
  const d = _docs[i], inp = $('laC_in'); if (!d || !inp) { _celda = null; return }
  _guardandoCelda = true
  const val = inp.value.trim()
  try {
    const cambios = {}; cambios[col] = val
    const previo = col === 'concepto' ? d.titulo : col === 'numero' ? (d.numero === '—' ? '' : d.numero) : col === 'fecha' ? (d.fecha || '') : col === 'base' ? d.base.toFixed(2) : d.igv.toFixed(2)
    if (val !== previo) await _aplicarCambio(i, cambios)
    _celda = null
    // siguiente celda (Tab) en la misma fila
    if (salto) { const k = COLS_ED.indexOf(col) + salto; if (k >= 0 && k < COLS_ED.length) _celda = { i, col: COLS_ED[k] } }
    if (val !== previo) await _refrescarDocs(); else { _pintarDocs(); aplicarModoVerEditar('modal-liq-agente', false) }
    if (_celda) { _pintarDocs(); aplicarModoVerEditar('modal-liq-agente', false) }
  } catch (e) { console.error('laCelda', e); showToast(e.message || 'No se pudo guardar la celda', 'danger'); _celda = null; _pintarDocs(); aplicarModoVerEditar('modal-liq-agente', false) }
  finally { _guardandoCelda = false }
}
async function _aplicarCambio(i, c) {
  const d = _docs[i]
  if (d.costoIds.length !== 1) throw new Error('Este documento tiene varias líneas de costo: edítalo desde el ledger')
  let concepto = 'concepto' in c ? c.concepto : d.titulo
  let numTxt = 'numero' in c ? c.numero : (d.numero === '—' ? '' : d.numero)
  let fecha = 'fecha' in c ? c.fecha : d.fecha
  let base = 'base' in c ? Math.round(num(c.base) * 100) / 100 : d.base
  let igv = 'igv' in c ? Math.round(num(c.igv) * 100) / 100 : d.igv
  // si cambia la base y el IGV era el 18 % de la base anterior → se recalcula (como Excel con fórmula)
  if ('base' in c && d.igv > 0 && Math.abs(d.igv - Math.round(d.base * 18) / 100) < 0.02) igv = Math.round(base * 18) / 100
  const total = Math.round((base + igv) * 100) / 100
  if (!concepto) throw new Error('La glosa no puede quedar vacía')
  if (!fecha) throw new Error('Falta la fecha')
  if (base <= 0) throw new Error('La base imponible debe ser mayor a 0')
  const k = numTxt.indexOf('-'), serie = k > 0 ? numTxt.slice(0, k) : null, numero = k > 0 ? numTxt.slice(k + 1) : (numTxt || null)
  if (!await update('documentos_importacion', d.id, { serie, numero, fecha_emision: fecha, monto_sin_igv: base, igv_monto: igv, monto_total: total })) throw new Error('No se pudo actualizar el documento')
  if (!await update('importacion_costos', d.costoIds[0], { concepto, monto_moneda: base, igv_monto: igv })) throw new Error('No se pudo actualizar la línea de costo (¿carpeta cerrada?)')
  if (d.compra_id) {   // la compra y su CxP acompañan (la CxP solo si aún no tiene pagos)
    await update('compras', d.compra_id, { serie, numero, referencia: numTxt || null, fecha_emision: fecha, fecha_recepcion: fecha, periodo_mes: parseInt(fecha.slice(5, 7)), periodo_ano: parseInt(fecha.slice(0, 4)),
      precio_unitario: base, subtotal: base, igv_gravado: igv, base_imponible_gravada: igv > 0 ? base : 0, monto_exonerado: igv > 0 ? 0 : base, total })
    const det = ((await query('detalle_compras', { compra_id: d.compra_id })) || [])[0]
    if (det) await update('detalle_compras', det.id, { descripcion: concepto, precio_unitario: base, subtotal: base, igv_monto: igv, total_linea: total })
    const cx = ((await query('cuentas_pagar', { compra_id: d.compra_id })) || [])[0]
    if (cx && num(cx.monto_pagado) === 0) await update('cuentas_pagar', cx.id, { serie, numero_comprobante: numero, fecha_emision: fecha, monto_total: total })
    else if (cx) showToast('La CxP ya tiene pagos: ajusta su monto desde Cuentas por Pagar', 'warning', 6000)
  }
  showToast('Celda actualizada', 'success', 1800)
}

function _pintarAbonos() {
  const lectura = $('modal-liq-agente')?.dataset.modo === 'lectura'
  const dis = lectura ? 'disabled' : ''
  const bancos = sel => `<option value="">—</option>` + _bancos.map(b => `<option value="${b.id}" ${String(sel) === String(b.id) ? 'selected' : ''}>${esc(b.nombre)}</option>`).join('')
  const lista = etapa => {
    const filas = _abonos.map((a, i) => [a, i]).filter(([a]) => (a.concepto === 'proforma' ? 'proforma' : 'liquidacion') === etapa)
    return filas.length ? filas.map(([a, i]) => `<div class="la-abono">
      <input type="date" value="${a.fecha || ''}" ${dis} onchange="window.laSetAbono(${i},'fecha',this.value)">
      <select ${dis} onchange="window.laSetAbono(${i},'moneda',this.value)"><option ${a.moneda === 'USD' ? 'selected' : ''}>USD</option><option ${a.moneda === 'PEN' ? 'selected' : ''}>PEN</option></select>
      <input type="number" step="0.001" placeholder="T.C." value="${a.tipo_cambio || ''}" ${dis} onchange="window.laSetAbono(${i},'tipo_cambio',this.value)">
      <input type="number" step="0.01" placeholder="Monto" value="${a.monto ?? ''}" ${dis} oninput="window.laSetAbono(${i},'monto',this.value)">
      <input type="text" placeholder="N° operación" value="${esc(a.operacion || '')}" ${dis} onchange="window.laSetAbono(${i},'operacion',this.value)">
      <input type="number" step="0.01" min="0" placeholder="Comisión banc." title="Comisión interbancaria / transferencia que te cobró tu banco por este abono (en la moneda del abono). Pasa al costeo como gasto financiero." value="${a.comision ?? ''}" ${dis} oninput="window.laSetAbono(${i},'comision',this.value)">
      <select ${dis} onchange="window.laSetAbono(${i},'banco_id',this.value)">${bancos(a.banco_id)}</select>
      <button type="button" class="btn btn-secondary btn-small" data-solo-edicion onclick="window.laQuitarAbono(${i})">✕</button></div>`).join('')
      : '<div class="dm-nota">Sin abonos en esta etapa.</div>'
  }
  $('laAbonosProf').innerHTML = lista('proforma')
  $('laAbonosLiq').innerHTML = lista('liquidacion')
}

// ── Proforma del agente + auditoría ──────────────────────────────────────────
const _opcionesReal = tipo => {
  const base = tipo === 'gl' ? [['__igv', 'IGV de los gastos locales']] : []
  const cat = CONCEPTOS_COSTO.filter(c => tipo === 'gl' ? ['despacho', 'nacionalizacion'].includes(c.grupo) : c.grupo === 'tributos')
  return [['', '— sin equivalente —'], ...base, ...cat.map(c => [c.codigo, c.label])]
}
function _autoCodigo(txt, tipo) {
  const t = String(txt || '').toLowerCase()
  const reglas = tipo === 'gl'
    ? [[/igv/, '__igv'], [/thc/, 'thc'], [/visto/, 'visto_bueno'], [/gate/, 'gate_in'], [/comisi.n.*aduana|operativ|canal/, 'comision_aduanas'], [/transporte/, 'transporte_local'], [/descarga|almac/, 'almacen']]
    : [[/valorem/, 'ad_valorem'], [/general venta|igv/, 'igv'], [/promoc|municip|ipm/, 'ipm'], [/percep/, 'percepcion']]
  return (reglas.find(([r]) => r.test(t)) || [])[1] || ''
}
/** T.C. venta SUNAT del día de la proforma, desde la BD (y la API si hace falta). Sin forzar, solo llena si está vacío. */
window.laPfTCDia = async function (forzar) {
  const f = $('laPfFecha')?.value, av = $('laPfTCaviso'); if (!f) { if (forzar) showToast('Primero pon la fecha de la proforma', 'warning'); return }
  if (!forzar && $('laPfTC').value) return
  if (av) av.textContent = 'Buscando…'
  let r = await getTipoCambioDia(f, { permitirApi: false }).catch(() => null)
  if (!r?.venta) r = await getTipoCambioDia(f).catch(() => null)
  if (r?.venta) { $('laPfTC').value = Number(r.venta).toFixed(3); window.laPfSet('tc', $('laPfTC').value); if (av) av.textContent = `(SUNAT venta ${fechaDMY(f)})` }
  else if (av) av.textContent = '— no hay T.C. de esa fecha, ingrésalo a mano'
}
window.laPfSet = (k, val) => { _prof[k] = val; _subtotalesProf(); window.laAuditar() }
window.laPfAdd = tipo => { _prof[tipo].push({ concepto: '', moneda: tipo === 'gl' ? 'USD' : 'PEN', monto: '', codigo: '' }); _pintarProforma(); aplicarModoVerEditar('modal-liq-agente', false) }
window.laPfQuitar = (tipo, i) => { _prof[tipo].splice(i, 1); _pintarProforma(); aplicarModoVerEditar('modal-liq-agente', false); window.laAuditar() }
window.laPfLinea = (tipo, i, k, val) => {
  const l = _prof[tipo][i]; l[k] = val
  _subtotalesProf()
  if (k === 'concepto' && !l.codigo) { l.codigo = _autoCodigo(val, tipo); _pintarProforma(); aplicarModoVerEditar('modal-liq-agente', false) }
  window.laAuditar()
}
/** Monto de una línea de la proforma expresado en `mon` con el T.C. de la proforma (0 si falta el T.C. y hay que convertir). */
const _enMon = (l, mon) => { const m = num(l.monto), tc = num(_prof.tc); if (l.moneda === mon) return m; if (!tc) return 0; return mon === 'PEN' ? m * tc : m / tc }
function _subtotalesProf() {
  const tc = num(_prof.tc)
  const sub = lineas => ['USD', 'PEN'].map(m => [m, lineas.filter(l => l.moneda === m).reduce((t, l) => t + num(l.monto), 0)])
  const bloque = (lineas, id, titulo) => {
    const el = $(id); if (!el) return
    if (!lineas.length) { el.innerHTML = ''; return }
    const [[, u], [, p]] = sub(lineas)
    const totU = lineas.reduce((t, l) => t + _enMon(l, 'USD'), 0), totP = lineas.reduce((t, l) => t + _enMon(l, 'PEN'), 0)
    el.innerHTML = `<div style="font-size:.84rem; padding:6px 10px; background:var(--bg-secondary); border-radius:6px; margin-top:4px;">
      <b>Subtotal ${titulo}:</b> US$ ${n2(u)} · S/ ${n2(p)}
      ${(u && p && !tc) ? ' <span style="color:var(--color-warning,#b45309);">— falta el T.C. para unificar</span>' : `→ <b>US$ ${n2(totU)}</b> · <b>S/ ${n2(totP)}</b>`}</div>`
  }
  bloque(_prof.gl, 'laPfGLsub', 'gastos locales'); bloque(_prof.tr, 'laPfTRsub', 'derechos')
  const t = $('laPfTot'); if (!t) return
  const todas = [..._prof.gl, ..._prof.tr]
  if (!todas.length) { t.innerHTML = ''; return }
  const u = todas.filter(l => l.moneda === 'USD').reduce((a, l) => a + num(l.monto), 0), p = todas.filter(l => l.moneda === 'PEN').reduce((a, l) => a + num(l.monto), 0)
  const totU = todas.reduce((a, l) => a + _enMon(l, 'USD'), 0), totP = todas.reduce((a, l) => a + _enMon(l, 'PEN'), 0)
  t.innerHTML = `<div style="font-size:.9rem; padding:8px 12px; border-left:3px solid var(--color-primary,#6366f1); background:var(--bg-secondary); border-radius:6px; margin-top:8px;">
    <b>Total de la proforma</b> · en dólares US$ ${n2(u)} · en soles S/ ${n2(p)} ${tc ? `→ equivale a <b>US$ ${n2(totU)}</b> ó <b>S/ ${n2(totP)}</b> (T.C. ${tc.toFixed(3)})` : '<span style="color:var(--color-warning,#b45309);">— pon el T.C. para ver el total unificado</span>'}</div>`
}
function _pintarProforma() {
  const lectura = $('modal-liq-agente')?.dataset.modo === 'lectura'
  const dis = lectura ? 'disabled' : ''
  const fila = (tipo, l, i) => {
    const otra = l.moneda === 'USD' ? 'PEN' : 'USD', tc = num(_prof.tc)
    const eq = tc && num(l.monto) ? `≈ ${otra === 'PEN' ? 'S/' : 'US$'} ${n2(_enMon(l, otra))}` : ''
    return `<div style="display:grid; grid-template-columns:1.4fr 76px 110px 100px 1.2fr auto; gap:6px; margin-bottom:5px; align-items:center;">
      <input type="text" value="${esc(l.concepto)}" placeholder="Concepto" ${dis} onchange="window.laPfLinea('${tipo}', ${i}, 'concepto', this.value)">
      <select ${dis} onchange="window.laPfLinea('${tipo}', ${i}, 'moneda', this.value); window.laPfRepintar()"><option value="USD" ${l.moneda === 'USD' ? 'selected' : ''}>US$</option><option value="PEN" ${l.moneda === 'PEN' ? 'selected' : ''}>S/</option></select>
      <input type="number" step="0.01" value="${l.monto ?? ''}" placeholder="Monto" ${dis} oninput="window.laPfLinea('${tipo}', ${i}, 'monto', this.value)" onchange="window.laPfRepintar()" style="text-align:right;">
      <span style="font-size:.78rem; color:var(--text-secondary);">${eq}</span>
      <select ${dis} title="Con qué concepto del costeo se compara" onchange="window.laPfLinea('${tipo}', ${i}, 'codigo', this.value)">${_opcionesReal(tipo).map(([c, t]) => `<option value="${c}" ${l.codigo === c ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select>
      <button type="button" class="btn btn-secondary btn-small" data-solo-edicion onclick="window.laPfQuitar('${tipo}', ${i})">✕</button></div>`
  }
  $('laPfGL').innerHTML = _prof.gl.length ? _prof.gl.map((l, i) => fila('gl', l, i)).join('') : '<div class="dm-nota">Sin líneas.</div>'
  $('laPfTR').innerHTML = _prof.tr.length ? _prof.tr.map((l, i) => fila('tr', l, i)).join('') : '<div class="dm-nota">Sin líneas.</div>'
  _subtotalesProf()
}
window.laPfRepintar = () => { _pintarProforma(); aplicarModoVerEditar('modal-liq-agente', false) }
const _igvUsdC = c => c.moneda === 'PEN' ? num(c.igv_monto) / (num(c.tipo_cambio) || 1) : num(c.igv_monto)
window.laAuditar = function () {
  const host = $('laAudit'); if (!host) return
  const hay = _prof.gl.length || _prof.tr.length
  if (!hay) { host.innerHTML = '<div class="dm-nota">Registra la proforma del agente para comparar contra lo que realmente se pagó.</div>'; return }
  const vivos = _costos.filter(c => !c.anulado)
  const locales = vivos.filter(c => ['despacho', 'nacionalizacion'].includes(c.grupo) && c.concepto_codigo !== 'comision_interna')
  const realGL = {}, realTR = {}
  for (const c of locales) realGL[c.concepto_codigo] = (realGL[c.concepto_codigo] || 0) + num(c.monto_usd)
  realGL.__igv = locales.reduce((t, c) => t + _igvUsdC(c), 0)
  for (const c of vivos.filter(c => ['ad_valorem', 'ad_valorem_adic', 'igv', 'ipm', 'percepcion'].includes(c.concepto_codigo))) {
    const k = c.concepto_codigo === 'ad_valorem_adic' ? 'ad_valorem' : c.concepto_codigo
    realTR[k] = (realTR[k] || 0) + num(c.monto_pen)
  }
  const etq = c => c === '__igv' ? 'IGV de los gastos locales' : (CONCEPTOS_COSTO.find(x => x.codigo === c)?.label || c || 'Sin equivalente')
  const bloque = (tipo, real, sign, campo) => {
    const prof = {}
    for (const l of _prof[tipo]) { const k = l.codigo || '__sin'; (prof[k] = prof[k] || { n: [], v: 0 }); prof[k].n.push(l.concepto); prof[k].v += _enMon(l, tipo === 'gl' ? 'USD' : 'PEN') }
    const claves = [...new Set([...Object.keys(prof), ...Object.keys(real).filter(k => Math.abs(real[k]) > 0.005)])]
    let tp = 0, tr = 0
    const filas = claves.map(k => {
      const p = prof[k]?.v || 0, r = k === '__sin' ? 0 : (real[k] || 0), dif = r - p
      tp += p; tr += r
      const nota = !prof[k] ? ' <span class="cr-chip" style="--c:#f59e0b;">no estaba en la proforma</span>' : (k !== '__sin' && !r ? ' <span class="cr-chip" style="--c:#10b981;">no se cobró</span>' : '')
      const nom = prof[k] ? esc(prof[k].n.filter(Boolean).join(' + ') || etq(k)) + (k !== '__sin' && prof[k].n.length ? ` <small style="color:var(--text-secondary)">→ ${esc(etq(k))}</small>` : '') : esc(etq(k))
      return `<tr><td>${nom}${nota}</td><td style="text-align:right">${sign} ${n2(p)}</td><td style="text-align:right">${sign} ${n2(r)}</td><td style="text-align:right; color:${dif > 0.005 ? '#ef4444' : dif < -0.005 ? '#10b981' : 'inherit'}">${dif > 0 ? '+' : ''}${n2(dif)}</td></tr>`
    }).join('')
    const dif = tr - tp
    return `<table class="data-table" style="width:100%"><thead><tr><th>${tipo === 'gl' ? 'Gastos locales (USD)' : 'Derechos e impuestos (S/)'}</th><th style="text-align:right">Proforma</th><th style="text-align:right">Real</th><th style="text-align:right">Diferencia</th></tr></thead><tbody>${filas}
      <tr style="font-weight:700"><td>Total</td><td style="text-align:right">${sign} ${n2(tp)}</td><td style="text-align:right">${sign} ${n2(tr)}</td><td style="text-align:right; color:${dif > 0.005 ? '#ef4444' : dif < -0.005 ? '#10b981' : 'inherit'}">${dif > 0 ? '+' : ''}${n2(dif)}</td></tr></tbody></table>`
  }
  host.innerHTML = (_prof.gl.length ? bloque('gl', realGL, '$', 'usd') : '') + (_prof.tr.length ? '<div style="height:8px"></div>' + bloque('tr', realTR, 'S/', 'pen') : '') +
    '<div class="dm-nota">Rojo = costó más que la proforma · verde = costó menos. «Real» sale del costeo de la carpeta (no de los totales de la liquidación).</div>'
}

const _sumAb = (etapa, mon) => _abonos.filter(a => (a.concepto === 'proforma' ? 'proforma' : 'liquidacion') === etapa && (a.moneda === 'PEN' ? 'PEN' : 'USD') === mon).reduce((t, a) => t + num(a.monto), 0)
const _tieneLiq = () => !!(v('laNumero') || _liq?.numero)

const _aud0 = window.laAuditar
window.laAuditar = function () { _aud0(); window.laRecalcular?.() }

window.laRecalcular = function () {
  const s = _saldos(_docs, _abonos)
  const hayLiq = _tieneLiq()
  const linea = (mon, x) => {
    const sal = x.saldo, ok = Math.abs(sal) < 0.005
    const txt = ok ? 'Cuadrado ✔' : sal > 0 ? `Saldo a favor tuyo: <b>${SIGNO(mon)} ${n2(sal)}</b>` : `Saldo a favor del agente: <b>${SIGNO(mon)} ${n2(-sal)}</b>`
    return `<div class="dm-cruce ${ok || sal > 0 ? 'ok' : 'warn'}"><span class="dm-cruce-ico">${ok ? '✔' : sal > 0 ? 'ℹ' : '⚠'}</span><div>${mon === 'USD' ? 'Dólares' : 'Soles'}: facturas ${SIGNO(mon)} ${n2(x.fact)} · abonos ${SIGNO(mon)} ${n2(x.abono)} → ${txt}</div></div>`
  }
  let h = ''
  if (!hayLiq) h = '<div class="dm-cruce warn"><span class="dm-cruce-ico">⏳</span><div>Aún no registras la liquidación final (paso 3): el saldo se calcula cuando exista.</div></div>'
  else {
    if (s.USD.fact || s.USD.abono) h += linea('USD', s.USD)
    if (s.PEN.fact || s.PEN.abono) h += linea('PEN', s.PEN)
    const dev = num(v('laDevMonto')), favor = Math.max(0, s.USD.saldo)
    if (favor > 0.005 && !dev) h += `<div class="la-alerta">🔔 <b>Saldo por recuperar: $ ${n2(favor)}</b> — ${esc(_nombreAg())} debe devolvértelo. Registra abajo la devolución (monto, fecha, operación).</div>`
    else if (dev && v('laDevEstado') === 'en_proceso') h += `<div class="la-alerta info">⏳ Devolución de $ ${n2(dev)} <b>en proceso</b>: confirma la recepción en el banco y cambia el estado a «Recibida».</div>`
    else if (dev && v('laDevEstado') === 'recibida') h += `<div class="la-alerta ok">✅ Devolución de $ ${n2(dev)} recibida. Saldo cerrado.</div>`
    if (dev && Math.abs(dev - favor) >= 0.005) h += `<div class="dm-cruce warn"><span class="dm-cruce-ico">⚠</span><div>La devolución ($ ${n2(dev)}) no coincide con el saldo a favor en dólares ($ ${n2(favor)}).</div></div>`
  }
  $('laResultado').innerHTML = h
  // resúmenes por etapa de abono
  const glUsd = _prof.gl.reduce((t, l) => t + _enMon(l, 'USD'), 0), ab1 = _sumAb('proforma', 'USD')
  $('laResProf').innerHTML = _prof.gl.length ? `<div class="dm-cruce ${ab1 >= glUsd - 0.005 ? 'ok' : 'warn'}"><span class="dm-cruce-ico">${ab1 >= glUsd - 0.005 ? '✔' : 'ℹ'}</span><div>Proforma (gastos locales): $ ${n2(glUsd)} · abonado: $ ${n2(ab1)}${ab1 < glUsd - 0.005 ? ` · falta $ ${n2(glUsd - ab1)}` : ab1 > glUsd + 0.005 ? ` · provisión de más $ ${n2(ab1 - glUsd)}` : ''}</div></div>` : '<div class="dm-nota">Registra las líneas de la proforma (paso 1) para comparar con el abono.</div>'
  const dU = s.USD.fact - ab1 - _sumAb('liquidacion', 'USD'), dP = s.PEN.fact - _sumAb('liquidacion', 'PEN')
  $('laResLiq').innerHTML = hayLiq ? `<div class="dm-cruce ok"><span class="dm-cruce-ico">ℹ</span><div>Facturas de la liquidación: $ ${n2(s.USD.fact)}${s.PEN.fact ? ' + S/ ' + n2(s.PEN.fact) : ''} · abonado en proforma: $ ${n2(ab1)} · pendiente por cubrir: $ ${n2(Math.max(0, s.USD.fact - s.USD.abono))}${s.PEN.fact ? ' + S/ ' + n2(Math.max(0, s.PEN.fact - s.PEN.abono)) : ''}</div></div>` : '<div class="dm-nota">Registra la liquidación final (paso 3).</div>'
  const comTot = (etapa) => ['USD', 'PEN'].map(m => [m, _abonos.filter(a => (a.concepto === 'proforma' ? 'proforma' : 'liquidacion') === etapa && (a.moneda === 'PEN' ? 'PEN' : 'USD') === m).reduce((t, a) => t + num(a.comision), 0)]).filter(x => x[1] > 0).map(([m, t]) => `${SIGNO(m)} ${n2(t)}`).join(' + ')
  const nota = etapa => comTot(etapa) ? `<div class="dm-nota">🏦 Comisiones bancarias de estos abonos: <b>${comTot(etapa)}</b> → pasan al costeo como <b>gasto financiero</b> (no inflan el inventario; no cambian lo que debes al agente).</div>` : ''
  $('laResProf').innerHTML += nota('proforma'); $('laResLiq').innerHTML += nota('liquidacion')
  _pintarPasos(s, hayLiq)
}

// ── Pasos (pestañas) ─────────────────────────────────────────────────────────
window.laPasoActual = 1
const _PASOS = [['Proforma', '📝'], ['Abono 1', '💵'], ['Liquidación', '📑'], ['Abono 2', '💵'], ['Saldo', '⚖️']]
function _pintarPasos(s, hayLiq) {
  const host = $('laSteps'); if (!host) return
  s = s || _saldos(_docs, _abonos); hayLiq = hayLiq ?? _tieneLiq()
  const dev = num(v('laDevMonto')), favor = Math.max(0, s.USD.saldo)
  const debe = s.USD.saldo < -0.005 || s.PEN.saldo < -0.005
  const est = [
    _prof.numero ? 'ok' : '',
    _abonos.some(a => a.concepto === 'proforma') ? 'ok' : '',
    hayLiq ? 'ok' : '',
    _abonos.some(a => a.concepto !== 'proforma') ? 'ok' : '',
    !hayLiq ? '' : (debe || (favor > 0.005 && !dev) || (dev && v('laDevEstado') === 'en_proceso')) ? 'warn' : 'ok'
  ]
  host.innerHTML = _PASOS.map(([t, ico], i) => `<button type="button" class="la-step ${est[i]} ${window.laPasoActual === i + 1 ? 'act' : ''}" onclick="window.laIr(${i + 1})"><span class="la-dot">${est[i] === 'ok' ? '✓' : est[i] === 'warn' ? '!' : i + 1}</span><span class="la-tx">${ico} ${t}</span></button>`).join('<i class="la-lin"></i>')
}
window.laPaso = () => window.laRecalcular()
let _devAuto = {}   // campos del paso 5 llenados por sugerencia (se refrescan hasta que los edites)
function _sugerirDevolucion() {
  if ($('modal-liq-agente')?.dataset.modo === 'lectura' || !_tieneLiq()) return
  const s = _saldos(_docs, _abonos), favor = Math.max(0, s.USD.saldo)
  const poner = (id, val) => { const el = $(id); if (!el || val === '' || val == null) return; if (!el.value || _devAuto[id]) { el.value = val; _devAuto[id] = true; el.classList.add('la-sug') } }
  if (favor < 0.005) return
  poner('laDevMonto', favor.toFixed(2))
  poner('laDevFecha', v('laFecha') || '')
  poner('laDevMedio', 'Transferencia interbancaria')
  const ab = _abonos.filter(a => a.moneda !== 'PEN' && a.banco_id)[0] || _abonos.filter(a => a.banco_id)[0]
  if (ab) poner('laDevBanco', String(ab.banco_id))
  if (!$('laDevEstado').value || _devAuto.laDevEstado) { $('laDevEstado').value = 'en_proceso'; _devAuto.laDevEstado = true }
  window.laRecalcular()
}
document.addEventListener('input', e => { if (e.target?.classList?.contains('la-sug') && e.target.id) { delete _devAuto[e.target.id]; e.target.classList.remove('la-sug') } })
window.laIr = n => {
  n = Math.max(1, Math.min(5, n)); window.laPasoActual = n
  document.querySelectorAll('#modal-liq-agente .la-panel').forEach(p => { p.style.display = Number(p.dataset.p) === n ? '' : 'none' })
  _pintarPasos()
  if (n === 5) _sugerirDevolucion()
}

window.laMarcar = (i, on) => { _docs[i].marcado = on; window.laRecalcular() }
window.laAddAbono = etapa => { _abonos.push({ fecha: '', moneda: 'USD', tipo_cambio: '', monto: '', comision: '', operacion: '', banco_id: '', concepto: etapa || 'liquidacion' }); _pintarAbonos(); aplicarModoVerEditar('modal-liq-agente', false) }
window.laQuitarAbono = i => { _abonos.splice(i, 1); _pintarAbonos(); aplicarModoVerEditar('modal-liq-agente', false); window.laRecalcular() }
window.laSetAbono = async (i, k, val) => {
  _abonos[i][k] = val
  if (k === 'fecha' && _abonos[i].fecha) {
    // T.C. venta SUNAT del día del abono (se actualiza solo con la fecha; editable)
    let r = await getTipoCambioDia(_abonos[i].fecha, { permitirApi: false }).catch(() => null)
    if (!r?.venta) r = await getTipoCambioDia(_abonos[i].fecha).catch(() => null)
    if (r?.venta) { _abonos[i].tipo_cambio = Number(r.venta); _pintarAbonos(); aplicarModoVerEditar('modal-liq-agente', false) }
  }
  window.laRecalcular()
}


// ── Agente aduanero: buscador por nombre/RUC, heredado de la DAM ──────────────
let _contactosAg = [], _pendienteAg = false
const _opcAg = () => '<option value="">— sin definir —</option>' + _contactosAg.map(c => `<option value="${esc(c.nombre)}">${esc(c.nombre)}${c.nro_documento ? ' — ' + esc(c.nro_documento) : ''}</option>`).join('')
/** Nombre corto del agente para los textos del modal (sin «S.A.C.» etc.); genérico si aún no hay. */
function _nombreAg() { const n = v('laAgente'); return n ? n.replace(/\s+(S\.?\s?A\.?\s?C?\.?|S\.?\s?R\.?\s?L\.?|E\.?\s?I\.?\s?R\.?\s?L\.?)\s*$/i, '').trim() : 'el agente' }
function _textosAgente() { document.querySelectorAll('#modal-liq-agente .la-ag').forEach(e => { e.textContent = _nombreAg() }) }
async function _cargarContactosAg() {
  try { _contactosAg = ((await getContacts(true)) || []).filter(c => c.nombre).sort((a, b) => a.nombre.localeCompare(b.nombre, 'es')) } catch (e) { console.warn('contactos agente:', e) }
  const sel = $('laAgente'); if (!sel) return
  const actual = sel.value; sel.innerHTML = _opcAg(); _ponerAgente(actual)
}
function _ponerAgente(valor) {
  const sel = $('laAgente'); if (!sel) return
  if (valor && ![...sel.options].some(o => o.value === valor)) sel.insertAdjacentHTML('beforeend', `<option value="${esc(valor)}">${esc(valor)}</option>`)
  sel.value = valor || ''; refrescarBuscador(sel); _textosAgente()
}
function _montarBuscadorAg() {
  const sel = $('laAgente'); if (!sel || sel.dataset.bus) return
  sel.dataset.bus = '1'
  convertirEnBuscador(sel, { placeholder: 'Escribe el nombre o RUC del agente...', sinResultados: 'Ningún contacto coincide',
    alCrearNuevo: { label: 'Agregar agente (contacto nuevo, con búsqueda por RUC)', onClick: () => { _pendienteAg = true; abrirModalContacto({ roles: ['proveedor'] }) } } })
  sel.addEventListener('change', () => { _textosAgente(); const h = $('laAgHint'); if (h) h.textContent = '' })
}
window.addEventListener('contacto-guardado', async e => {
  if (!_pendienteAg) return
  _pendienteAg = false
  const c = e.detail?.contacto
  await _cargarContactosAg()
  if (c?.nombre && !c._eliminado) { _ponerAgente(c.nombre); showToast(`${c.nombre} seleccionado`, 'success') }
})

/** «＋ Factura de gasto»: abre el registro de costos de la carpeta y, al guardar, la factura queda marcada en esta liquidación. */
window.laNuevaFactura = async function () {
  const previos = new Set(_docs.map(d => d.id))
  window._alGuardarCosto = async () => {
    window._alGuardarCosto = null
    const base = await _cargarBase(); _costos = base.costos
    const marcados = new Map(_docs.map(d => [d.id, d.marcado]))
    _docs = base.cand.map(d => ({ ...d, marcado: previos.has(d.id) ? !!marcados.get(d.id) : true }))
    _pintarDocs(); window.laRecalcular(); window.laAuditar()
  }
  await window.abrirModalLineaCosto?.()
  const m = document.getElementById('modal-linea-costo'); if (m) { document.body.appendChild(m); m.style.zIndex = 2300 }
}

function _volcar() {
  const c = carpeta()
  $('laNumero').value = _liq?.numero || ''
  $('laFecha').value = _liq?.fecha || ''
  { const heredado = !_liq?.agente_nombre && !!_dam?.agente_aduana
    _ponerAgente(_liq?.agente_nombre || _dam?.agente_aduana || '')
    const h = $('laAgHint'); if (h) h.textContent = heredado ? '· tomado de la DAM' : '' }
  $('laDam').value = _liq?.dam_numero ?? _dam?.numero_dam ?? ''
  $('laEstado').value = _liq?.estado || 'conforme'
  $('laDevMonto').value = _liq?.dev_monto_usd || ''
  $('laDevFecha').value = _liq?.dev_fecha || ''
  $('laDevMedio').value = _liq?.dev_medio || ''
  $('laDevOp').value = _liq?.dev_operacion || ''
  $('laDevEstado').value = _liq?.dev_estado || ''
  $('laDevComision').value = _liq?.dev_comision_a_cargo || 'agente'
  $('laDevBanco').innerHTML = '<option value="">—</option>' + _bancos.map(b => `<option value="${b.id}" ${String(_liq?.dev_banco_id) === String(b.id) ? 'selected' : ''}>${esc(b.nombre)}</option>`).join('')
  $('laObs').value = _liq?.observaciones || ''
  $('laPfNumero').value = _prof.numero; $('laPfFecha').value = _prof.fecha || ''; $('laPfTC').value = _prof.tc || ''
  _pintarProforma(); _pintarDocs(); _pintarAbonos(); window.laRecalcular(); window.laAuditar()
  window.laIr(!_prof.numero ? 1 : !_abonos.some(a => a.concepto === 'proforma') ? 2 : !_liq?.numero ? 3 : !_abonos.some(a => a.concepto !== 'proforma') ? 4 : 5)
  _pend = []; _adjGuardados = []
  if (_liq) getAdjuntos('liquidacion_agente', _liq.id).then(a => { _adjGuardados = a || []; _pintarAdj() }).catch(() => {})
  _pintarAdj()
}

window.abrirLiquidacionAgente = async function () {
  try {
    await esperarContextoEmpresa()
    const c = carpeta(); if (!c) { showToast('Abre primero una carpeta', 'warning'); return }
    _asegurarModal()
    _montarBuscadorAg()
    await Promise.all([_cargarLiq(), _cargarContactosAg()])
    const selC = document.getElementById('costeoSelector')
    $('laCarpeta').innerHTML = `<option>${esc(selC?.selectedOptions?.[0]?.text || c.numero_carpeta || '')}</option>`
    $('laTitulo').textContent = _liq ? `Agente aduanero · ${_liq.numero ? 'liquidación ' + _liq.numero : 'proforma ' + (_liq.proforma_numero || '')}` : 'Agente aduanero · proforma y liquidación'
    declararEmpresaModal('modal-liq-agente', c.empresa_id)
    aplicarModoVerEditar('modal-liq-agente', !!_liq)
    _volcar()
    window.openModal('modal-liq-agente')
  } catch (e) {
    console.error('abrirLiquidacionAgente:', e)
    showToast(/importacion_liquidaciones_agente|relation|does not exist/i.test(e.message || '') ? 'Falta correr el SQL 107' : 'No se pudo abrir la liquidación del agente', 'danger')
  }
}
window.laEditar = () => { aplicarModoVerEditar('modal-liq-agente', false); refrescarBuscador($('laAgente')); _pintarProforma(); _pintarDocs(); _pintarAbonos() }
window.laCancelar = () => { if (_liq) window.abrirLiquidacionAgente(); else window.cerrarLiqAgente() }
window.cerrarLiqAgente = () => { window.closeModal('modal-liq-agente'); window.renderHojaCosteo?.() }

let _pend = [], _adjGuardados = []   // archivos en cola (aún sin liquidación guardada) y ya guardados
function _pintarAdj() {
  const cuenta = c => _adjGuardados.filter(a => a.concepto === c).length + _pend.filter(a => a.concepto === c).length
  const txt = c => { const n = cuenta(c), p = _pend.filter(a => a.concepto === c).length; return n ? `(${n} archivo${n > 1 ? 's' : ''}${p ? ' · ' + p + ' por guardar' : ''})` : '' }
  if ($('laAdjProforma')) $('laAdjProforma').textContent = txt('proforma')
  if ($('laAdjN')) $('laAdjN').textContent = txt('liquidacion')
  document.querySelectorAll('#modal-liq-agente .laAdjVoucher').forEach(e => { e.textContent = txt('voucher') })
}
async function _subirPend(id) {
  if (!_pend.length) return
  const user = await getCurrentUser()
  const por = {}
  for (const x of _pend) (por[x.concepto] = por[x.concepto] || []).push({ file: x.file, concepto: x.concepto })
  for (const arr of Object.values(por)) {
    const res = await subirAdjuntos('liquidacion_agente', id, arr, user?.db_id)
    if (res.errores?.length) showToast(res.errores.join(' · '), 'danger')
  }
  _pend = []
}
window.laAdjuntar = function (concepto = 'liquidacion') {
  const inp = document.createElement('input'); inp.type = 'file'; inp.accept = 'application/pdf,image/*'; inp.multiple = true
  inp.onchange = async () => {
    const files = [...inp.files]; if (!files.length) return
    if (_liq) {
      const user = await getCurrentUser()
      const res = await subirAdjuntos('liquidacion_agente', _liq.id, files.map(file => ({ file, concepto })), user?.db_id)
      showToast(res.errores?.length ? res.errores.join(' · ') : 'Adjunto guardado', res.errores?.length ? 'danger' : 'success')
      _adjGuardados = (await getAdjuntos('liquidacion_agente', _liq.id)) || []
    } else {
      _pend.push(...files.map(file => ({ file, concepto })))
      showToast('Archivo en cola: se sube al guardar', 'info')
    }
    _pintarAdj()
  }
  inp.click()
}

window.guardarLiqAgente = async function () {
  try {
    const c = carpeta(); if (!c) throw new Error('Sin carpeta')
    const numero = v('laNumero')
    if (!numero && !_prof.numero) throw new Error('Registra al menos la proforma (N°) o la liquidación (N°)')
    const marcados = _docs.filter(d => d.marcado)
    if (numero) {
      if (!v('laFecha')) throw new Error('Falta la fecha de la liquidación')
      if (!marcados.length) throw new Error('Marca al menos una factura de la liquidación')
    }
    for (const a of _abonos) {
      if (!a.fecha || !(num(a.monto) > 0)) throw new Error('Cada abono necesita fecha y monto')
      if (!(num(a.tipo_cambio) >= 1)) throw new Error('Cada abono necesita T.C. (se llena con la fecha)')
    }
    const dev = num(v('laDevMonto'))
    if (dev > 0 && !v('laDevEstado')) throw new Error('Indica el estado de la devolución')
    const user = await getCurrentUser()
    const cab = {
      carpeta_importacion_id: c.id, numero: numero || null, fecha: v('laFecha') || null, agente_nombre: v('laAgente') || null, agente_id: _contactosAg.find(c => c.nombre === v('laAgente'))?.id ?? null, dam_numero: v('laDam') || null,
      estado: numero ? v('laEstado') : 'borrador', dev_monto_usd: dev, dev_fecha: v('laDevFecha') || null, dev_medio: v('laDevMedio') || null,
      dev_operacion: v('laDevOp') || null, dev_banco_id: v('laDevBanco') ? Number(v('laDevBanco')) : null,
      proforma_numero: _prof.numero || null, proforma_fecha: _prof.fecha || null, proforma_tc: num(_prof.tc) || null,
      proforma_items: { gl: _prof.gl.filter(l => l.concepto || num(l.monto)).map(l => ({ ...l, monto: num(l.monto) })), tr: _prof.tr.filter(l => l.concepto || num(l.monto)).map(l => ({ ...l, monto: num(l.monto) })) },
      dev_estado: v('laDevEstado') || null, dev_comision_a_cargo: v('laDevComision'), observaciones: v('laObs') || null
    }
    let id = _liq?.id
    if (id) { if (!(await update('importacion_liquidaciones_agente', id, cab))) throw new Error(ultimoErrorInsert()?.message || 'No se pudo actualizar') }
    else {
      const f = await insert('importacion_liquidaciones_agente', { ...cab, created_by: user?.db_id })
      if (!f?.id) throw new Error(ultimoErrorInsert()?.message || 'No se pudo crear la liquidación')
      id = f.id
    }
    // abonos: se reemplazan
    await _subirPend(id)
    const viejos = ((await query('importacion_liquidacion_abonos', { liquidacion_agente_id: id })) || [])
    const marcasViejas = new Set(viejos.map(a => MARCA_COM(a.id)))
    for (const k of ((await query('importacion_costos', { carpeta_importacion_id: c.id })) || [])) if (marcasViejas.has(k.observaciones)) await deleteRecord('importacion_costos', k.id)
    for (const a of viejos) await deleteRecord('importacion_liquidacion_abonos', a.id)
    const avisos = []
    for (const a of _abonos) {
      const f = await insert('importacion_liquidacion_abonos', {
        liquidacion_agente_id: id, fecha: a.fecha, moneda: a.moneda, tipo_cambio: num(a.tipo_cambio),
        monto: num(a.monto), ...(num(a.comision) > 0 ? { comision: num(a.comision) } : {}), concepto: a.concepto === 'proforma' ? 'proforma' : 'liquidacion', operacion: a.operacion || null, banco_id: a.banco_id ? Number(a.banco_id) : null
      })
      if (!f?.id) throw new Error(ultimoErrorInsert()?.message || 'No se pudo guardar un abono')
      if (num(a.comision) > 0) {
        try {
          const tc = num(a.tipo_cambio) || 1, mon = a.moneda === 'PEN' ? 'PEN' : 'USD'
          await crearLineaCosto({
            tipo: 'voucher_bancario', tipo_comprobante: null, serie: null, numero: null, proveedor_id: null, fecha_emision: a.fecha,
            moneda: mon, tipo_cambio: tc, monto_sin_igv: num(a.comision), igv_monto: 0, monto_total: num(a.comision),
            estado_pago: 'pagado', es_provisional: false, sustentado: true, empresa_id: c.empresa_id ?? undefined
          }, {
            carpeta_importacion_id: c.id, grupo: 'financiero', concepto: `Comisión bancaria — abono al agente ${fechaDMY(a.fecha)}`, concepto_codigo: 'comision_bancaria',
            clasificacion: 'gasto_financiero', entra_costo_contable: false, entra_costo_gestion: true, moneda: mon, tipo_cambio: tc,
            monto_moneda: num(a.comision), igv_monto: 0, base_prorrateo: 'valor_fob', es_provisional: false, observaciones: MARCA_COM(f.id)
          }, user?.db_id)
        } catch (e) { console.error('Comisión al ledger:', e); avisos.push('La comisión del abono del ' + fechaDMY(a.fecha) + ' no pasó al costeo: ' + e.message) }
      }
    }
    // vínculo de las líneas del ledger con la liquidación
    const costos = numero ? ((await query('importacion_costos', { carpeta_importacion_id: c.id })) || []) : []
    const marcadosIds = new Set(marcados.map(d => d.id)), candIds = new Set(_docs.map(d => d.id))
    for (const k of costos) {
      const debe = marcadosIds.has(k.documento_id) ? id : (candIds.has(k.documento_id) || k.liquidacion_agente_id === id ? null : k.liquidacion_agente_id)
      if ((k.liquidacion_agente_id ?? null) !== (debe ?? null)) await update('importacion_costos', k.id, { liquidacion_agente_id: debe })
    }
    showToast(avisos.length ? 'Guardado. ' + avisos[0] : 'Liquidación del agente guardada', avisos.length ? 'warning' : 'success')
    await window.abrirLiquidacionAgente()
    window.renderHojaCosteo?.()
  } catch (e) { console.error('guardarLiqAgente:', e); showToast(e.message || 'No se pudo guardar', 'danger') }
}

// ── Bloque de la Etapa 4 en la hoja: resumen + aviso final ────────────────────
function _num(s) { const m = /USD\s*([\d.,]+)/i.exec(s || ''); return m ? parseFloat(m[1].replace(/,/g, '')) : null }

window.renderEtapa4Liquidacion = async function () {
  const host = $('e4-liq-host'); const c = carpeta(); if (!host || !c) return
  try {
    const base = await _cargarLiq()
    const s = _saldos(_docs, _abonos)
    const avisos = []   // [tipo, texto]
    // 1) notificación vs liquidación pagada
    const aj = (_dam ? ((await query('dam_autoliquidaciones', { dam_id: _dam.id })) || []) : []).filter(a => !a.anulado)
    for (const a of aj) {
      const notif = _num(a.observaciones)
      const pagado = num(a.ad_valorem_usd) + num(a.igv_usd) + num(a.ipm_usd) + num(a.intereses_usd)
      if (notif && Math.abs(notif - pagado) >= 0.005) avisos.push(['info', `Notificación de Aduanas por <b>$ ${n2(notif)}</b> vs liquidación de cobranza ${esc(a.numero || '')} pagada por <b>$ ${n2(pagado)}</b>: diferencia <b>$ ${n2(notif - pagado)}</b> (la liquidación fue menor que la orden de depósito/garantía). Sin saldo pendiente: queda como conclusión.`])
    }
    // 2) liquidación del agente
    if (!_liq?.numero) avisos.push(['warn', 'Falta registrar la liquidación final del agente aduanero.' + (_liq?.proforma_numero ? ' (la proforma ya está registrada)' : '')])
    else {
      if (Math.abs(s.USD.saldo) >= 0.005 && s.USD.saldo < 0) avisos.push(['warn', `El agente aún tiene a su favor $ ${n2(-s.USD.saldo)}.`])
      if (Math.abs(s.PEN.saldo) >= 0.005 && s.PEN.saldo < 0) avisos.push(['warn', `El agente aún tiene a su favor S/ ${n2(-s.PEN.saldo)}.`])
      if (s.USD.saldo > 0.005 && num(_liq.dev_monto_usd) < 0.005) avisos.push(['warn', `Saldo a favor del cliente $ ${n2(s.USD.saldo)} sin devolución registrada.`])
      if (_liq.dev_estado === 'en_proceso') avisos.push(['info', `Devolución de $ ${n2(_liq.dev_monto_usd)} en proceso${_liq.dev_operacion ? ' (op. ' + esc(_liq.dev_operacion) + ')' : ''}: confirma la recepción en el banco.`])
      if (_liq.observaciones) avisos.push(['obs', esc(_liq.observaciones).replace(/\n/g, '<br>')])
    }
    const chips = _liq?.numero ? `<span class="cr-chip" style="--c:#10b981;">Liquidación ${esc(_liq.numero)}</span>
      <span class="cr-chip" style="--c:#6b7280;">Facturas $ ${n2(s.USD.fact)}${s.PEN.fact ? ' + S/ ' + n2(s.PEN.fact) : ''}</span>
      <span class="cr-chip" style="--c:#6b7280;">Abonos $ ${n2(s.USD.abono)}${s.PEN.abono ? ' + S/ ' + n2(s.PEN.abono) : ''}</span>` : ''
    host.innerHTML = `<div class="e3-lista">
      <div style="display:flex; gap:8px; flex-wrap:wrap; align-items:center; margin:2px 0;">
        <button type="button" class="btn btn-primary btn-small" onclick="window.abrirLiquidacionAgente()">${_liq ? 'Ver liquidación del agente' : 'Registrar liquidación del agente'}</button>${chips}</div>
    </div>`
    // Avisos / conclusiones: suben al panel «Estado de la carpeta» (arriba de la columna)
    const av = $('hc-estado-avisos')
    if (av) {
      const cls = { warn: 'warn', info: 'info', obs: 'obs' }
      av.innerHTML = avisos.length
        ? avisos.map(([t, x]) => `<div class="hc-aviso ${cls[t] || 'info'}">${x}</div>`).join('')
        : (_liq?.numero ? '<div class="hc-aviso ok">Sin observaciones pendientes en la liquidación.</div>' : '')
    }
  } catch (e) {
    console.error('renderEtapa4Liquidacion:', e)
    host.innerHTML = /importacion_liquidaciones_agente|relation|does not exist|schema cache/i.test(e.message || '') ? '<div class="e3-nota">⚠️ Corre el SQL 107 para activar la liquidación del agente.</div>' : ''
  }
}

export default { abrirLiquidacionAgente: window.abrirLiquidacionAgente }
