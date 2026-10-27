// ============================================================================
// liquidacion-agente-modal.js — Liquidación del agente aduanero + devolución de saldo
// ----------------------------------------------------------------------------
// Etapa 4 de la carpeta. La liquidación del agente (ej. DESA «2026-080») resume:
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
import { subirAdjuntos, getAdjuntos } from '../supabase-data.js'
import { CONCEPTOS_COSTO, crearLineaCosto } from './costos-ledger.js'

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

// ── datos ─────────────────────────────────────────────────────────────────────
async function _cargarBase() {
  const c = carpeta()
  const costos = ((await query('importacion_costos', { carpeta_importacion_id: c.id })) || []).filter(k => !k.anulado)
  const ids = [...new Set(costos.map(k => k.documento_id).filter(Boolean))]
  const todos = ids.length ? ((await query('documentos_importacion', {})) || []) : []
  const docs = todos.filter(d => ids.includes(d.id))
  const fiscales = new Set(costos.filter(k => ['credito_fiscal', 'percepcion'].includes(k.clasificacion)).map(k => k.documento_id))
  const cand = docs.filter(d => !TIPOS_EXCLUIDOS.includes(d.tipo) && !fiscales.has(d.id) && !(d.tipo === 'voucher_bancario'))
  const concepto = id => costos.find(k => k.documento_id === id)?.concepto || ''
  return { costos, cand: cand.map(d => ({ id: d.id, titulo: concepto(d.id) || d.tipo, numero: [d.serie, d.numero].filter(Boolean).join('-') || '—', fecha: d.fecha_emision, moneda: d.moneda, total: num(d.monto_total) })) }
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
  _prof = { numero: _liq?.proforma_numero || '', fecha: _liq?.proforma_fecha || '', tc: _liq?.proforma_tc || '', gl: [...(_liq?.proforma_items?.gl || [])], tr: [...(_liq?.proforma_items?.tr || [])] }
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
        <div class="la-steps" id="laSteps"></div>
      </div>
      <div class="la-body" style="padding:0 20px 8px; overflow-y:auto; flex:1;">

        <section class="la-panel" data-p="1">
          <div class="dm-explica">📝 <b>Paso 1 · Proforma del agente.</b> Estimación que te envía DESA antes del despacho (gastos locales en USD y derechos en S/). <b>No es costo</b>: sirve para auditar contra la liquidación final.</div>
          <div class="la-grid">
            <div class="form-group"><label>N° de proforma</label><input type="text" id="laPfNumero" maxlength="40" placeholder="2026-091" oninput="window.laPfSet('numero', this.value)"></div>
            <div class="form-group"><label>Fecha</label><input type="date" id="laPfFecha" onchange="window.laPfSet('fecha', this.value)"></div>
            <div class="form-group"><label>T.C. de la proforma</label><input type="number" id="laPfTC" step="0.001" oninput="window.laPfSet('tc', this.value)"></div>
          </div>
          <div class="la-pf-grid">
            <div><div class="e3-sub">Gastos locales estimados (USD) <button type="button" class="btn btn-secondary btn-small" data-solo-edicion onclick="window.laPfAdd('gl')">+ Línea</button></div><div id="laPfGL"></div></div>
            <div><div class="e3-sub">Derechos estimados (S/) <button type="button" class="btn btn-secondary btn-small" data-solo-edicion onclick="window.laPfAdd('tr')">+ Línea</button></div><div id="laPfTR"></div></div>
          </div>
          <div class="dm-nota">📎 PDF de la proforma: <button type="button" class="btn btn-secondary btn-small" onclick="window.laAdjuntar('proforma')">Subir PDF</button> <span id="laAdjProforma"></span></div>
        </section>

        <section class="la-panel" data-p="2">
          <div class="dm-explica">💵 <b>Paso 2 · Abono sobre la proforma.</b> Lo que le abonaste a DESA para que despache (provisión de fondos). Ej.: USD 2,370 del 11/09.</div>
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
            <div class="form-group" style="grid-column:span 2;"><label>Agente de aduana</label><input type="text" id="laAgente" maxlength="120"></div>
            <div class="form-group"><label>DAM</label><input type="text" id="laDam" maxlength="60"></div>
          </div>
          <div class="e3-sub">Facturas y gastos pagados por el agente <small style="font-weight:400">(marca las que van en esta liquidación)</small></div>
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

function _pintarDocs() {
  const lectura = $('modal-liq-agente')?.dataset.modo === 'lectura'
  $('laDocs').innerHTML = _docs.length ? `<table class="data-table" style="width:100%"><thead><tr><th></th><th>Concepto</th><th>N° doc.</th><th>Fecha</th><th style="text-align:right">Importe</th></tr></thead><tbody>${
    _docs.map((d, i) => `<tr><td><input type="checkbox" style="width:auto;margin:0" ${d.marcado ? 'checked' : ''} ${lectura ? 'disabled' : ''} onchange="window.laMarcar(${i}, this.checked)"></td>
      <td>${esc(d.titulo)}</td><td>${esc(d.numero)}</td><td>${fechaDMY(d.fecha)}</td><td style="text-align:right">${SIGNO(d.moneda)} ${n2(d.total)}</td></tr>`).join('')}</tbody></table>`
    : '<div class="dm-nota">La carpeta aún no tiene facturas de gastos locales en el costeo.</div>'
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
window.laPfSet = (k, val) => { _prof[k] = val; window.laAuditar() }
window.laPfAdd = tipo => { _prof[tipo].push({ concepto: '', [tipo === 'gl' ? 'usd' : 'pen']: '', codigo: '' }); _pintarProforma(); aplicarModoVerEditar('modal-liq-agente', false) }
window.laPfQuitar = (tipo, i) => { _prof[tipo].splice(i, 1); _pintarProforma(); aplicarModoVerEditar('modal-liq-agente', false); window.laAuditar() }
window.laPfLinea = (tipo, i, k, val) => {
  const l = _prof[tipo][i]; l[k] = val
  if (k === 'concepto' && !l.codigo) { l.codigo = _autoCodigo(val, tipo); _pintarProforma(); aplicarModoVerEditar('modal-liq-agente', false) }
  window.laAuditar()
}
function _pintarProforma() {
  const lectura = $('modal-liq-agente')?.dataset.modo === 'lectura'
  const dis = lectura ? 'disabled' : ''
  const fila = (tipo, l, i) => {
    const campo = tipo === 'gl' ? 'usd' : 'pen'
    return `<div style="display:grid; grid-template-columns:1fr 90px 1fr auto; gap:6px; margin-bottom:5px; align-items:center;">
      <input type="text" value="${esc(l.concepto)}" placeholder="Concepto" ${dis} onchange="window.laPfLinea('${tipo}', ${i}, 'concepto', this.value)">
      <input type="number" step="0.01" value="${l[campo] ?? ''}" placeholder="${tipo === 'gl' ? 'USD' : 'S/'}" ${dis} oninput="window.laPfLinea('${tipo}', ${i}, '${campo}', this.value)">
      <select ${dis} title="Con qué concepto del costeo se compara" onchange="window.laPfLinea('${tipo}', ${i}, 'codigo', this.value)">${_opcionesReal(tipo).map(([c, t]) => `<option value="${c}" ${l.codigo === c ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select>
      <button type="button" class="btn btn-secondary btn-small" data-solo-edicion onclick="window.laPfQuitar('${tipo}', ${i})">✕</button></div>`
  }
  $('laPfGL').innerHTML = _prof.gl.length ? _prof.gl.map((l, i) => fila('gl', l, i)).join('') : '<div class="dm-nota">Sin líneas.</div>'
  $('laPfTR').innerHTML = _prof.tr.length ? _prof.tr.map((l, i) => fila('tr', l, i)).join('') : '<div class="dm-nota">Sin líneas.</div>'
}
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
    for (const l of _prof[tipo]) { const k = l.codigo || '__sin'; (prof[k] = prof[k] || { n: [], v: 0 }); prof[k].n.push(l.concepto); prof[k].v += num(l[campo]) }
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
    if (favor > 0.005 && !dev) h += `<div class="la-alerta">🔔 <b>Saldo por recuperar: $ ${n2(favor)}</b> — DESA debe devolvértelo. Registra abajo la devolución (monto, fecha, operación).</div>`
    else if (dev && v('laDevEstado') === 'en_proceso') h += `<div class="la-alerta info">⏳ Devolución de $ ${n2(dev)} <b>en proceso</b>: confirma la recepción en el banco y cambia el estado a «Recibida».</div>`
    else if (dev && v('laDevEstado') === 'recibida') h += `<div class="la-alerta ok">✅ Devolución de $ ${n2(dev)} recibida. Saldo cerrado.</div>`
    if (dev && Math.abs(dev - favor) >= 0.005) h += `<div class="dm-cruce warn"><span class="dm-cruce-ico">⚠</span><div>La devolución ($ ${n2(dev)}) no coincide con el saldo a favor en dólares ($ ${n2(favor)}).</div></div>`
  }
  $('laResultado').innerHTML = h
  // resúmenes por etapa de abono
  const glUsd = _prof.gl.reduce((t, l) => t + num(l.usd), 0), ab1 = _sumAb('proforma', 'USD')
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

function _volcar() {
  const c = carpeta()
  $('laNumero').value = _liq?.numero || ''
  $('laFecha').value = _liq?.fecha || ''
  $('laAgente').value = _liq?.agente_nombre ?? _dam?.agente_aduana ?? ''
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
    await _cargarLiq()
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
window.laEditar = () => { aplicarModoVerEditar('modal-liq-agente', false); _pintarProforma(); _pintarDocs(); _pintarAbonos() }
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
      carpeta_importacion_id: c.id, numero: numero || null, fecha: v('laFecha') || null, agente_nombre: v('laAgente') || null, dam_numero: v('laDam') || null,
      estado: numero ? v('laEstado') : 'borrador', dev_monto_usd: dev, dev_fecha: v('laDevFecha') || null, dev_medio: v('laDevMedio') || null,
      dev_operacion: v('laDevOp') || null, dev_banco_id: v('laDevBanco') ? Number(v('laDevBanco')) : null,
      proforma_numero: _prof.numero || null, proforma_fecha: _prof.fecha || null, proforma_tc: num(_prof.tc) || null,
      proforma_items: { gl: _prof.gl.filter(l => l.concepto || num(l.usd)), tr: _prof.tr.filter(l => l.concepto || num(l.pen)) },
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
    host.innerHTML = `<div class="e3-lista"><div class="e3-sub">Etapa 4 · Liquidación del agente aduanero</div>
      <div style="display:flex; gap:8px; flex-wrap:wrap; align-items:center; margin:6px 0;">
        <button type="button" class="btn btn-primary btn-small" onclick="window.abrirLiquidacionAgente()">📑 ${_liq ? 'Ver liquidación del agente' : 'Registrar liquidación del agente'}</button>${chips}</div>
      ${avisos.length ? `<div class="e3-sub" style="margin-top:10px;">Aviso final · conclusiones y observaciones de la carpeta</div>` + avisos.map(([t, x]) => `<div class="e3-nota">${t === 'warn' ? '⚠️' : t === 'obs' ? '📝' : 'ℹ️'} ${x}</div>`).join('') : (_liq?.numero ? '<div class="e3-nota">✅ Sin observaciones pendientes en la liquidación.</div>' : '')}
    </div>`
  } catch (e) {
    console.error('renderEtapa4Liquidacion:', e)
    host.innerHTML = /importacion_liquidaciones_agente|relation|does not exist|schema cache/i.test(e.message || '') ? '<div class="e3-nota">⚠️ Corre el SQL 107 para activar la liquidación del agente.</div>' : ''
  }
}

export default { abrirLiquidacionAgente: window.abrirLiquidacionAgente }
