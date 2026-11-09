// ============================================================================
// COBRO POR RECIBO / COBRO MASIVO — uno o VARIOS vouchers del cliente aplicados
// a una o varias facturas / letras (2026-10-10 · ampliado 2026-11-09, SQL 151)
// ============================================================================
// Modo normal: un depósito (como siempre). Botón "➕ Vouchers": el recibo junta
// varios vouchers (fechas, cuentas y T.C. distintos) — cada uno con su propio
// movimiento bancario; todos con el mismo N° de recibo (cobros_lote.grupo_recibo).
//
// Reglas:
//   • FIFO: el voucher más antiguo paga primero el documento más antiguo; si no
//     alcanza, el documento se completa con el siguiente voucher.
//   • Cada cruce voucher × documento = un cobro (o abono de letra) con la FECHA y
//     el T.C. de ese voucher, sin movimiento propio (el banco ve el voucher).
//   • SALDO A FAVOR: si sobra, queda como saldo a favor del cliente
//     (saldos_favor_cliente) y en la próxima cobranza aparece para netearlo
//     (cobro con medio 'saldo_favor', sin banco).
//   • Deshacer = el recibo completo (todos sus vouchers y el saldo a favor que
//     generó, si aún no se usó).
// Analogía: varias jarras (vouchers) llenan los vasos más antiguos primero; lo
// que sobra se guarda en un termo (saldo a favor) para la próxima vez.
// ============================================================================

import { supabase, empresaTrabajoCtx } from './supabase-client.js'
import { showToast, formatNumber, fechaDMY } from './helpers.js'
import { addCobro, deleteCobro, eliminarAsientoContable } from './supabase-data.js'
import { getTipoCambioDia } from './sunat-api.js'
import { getCurrentUser } from './auth-supabase.js'
import { marcarTC } from './shared/tc-fecha.js'

let C = null          // contexto que entrega cobranzas.js (funciones internas)
let _st = null        // estado del modal
const _r2 = n => Math.round((parseFloat(n) || 0) * 100) / 100
const _esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const _hoy = () => new Date().toISOString().slice(0, 10)
const _dias = (a, b) => (a && b) ? Math.round((new Date(b + 'T00:00:00') - new Date(a + 'T00:00:00')) / 86400000) : null
const $ = id => document.getElementById(id)
const _uuid = () => (crypto?.randomUUID ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => { const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16) }))

export function initCobroMasivo(ctx) { C = ctx; _inyectarModal() }

// Solo culpa al SQL si la tabla/columna NO existe.
function _sb(q) { return q.then(({ data, error }) => { if (error) throw new Error(/does not exist|no existe|schema cache/i.test(error.message) && /cobros_lote|lote_id|grupo_recibo|saldo_favor/.test(error.message) ? 'Falta ejecutar el SQL 83/151 (cobro por recibo): ' + error.message : error.message); return data }) }

const MEDIOS = [['transferencia', 'Transferencia'], ['deposito', 'Depósito'], ['efectivo', 'Efectivo'], ['cheque', 'Cheque'], ['yape_plin', 'Yape / Plin'], ['otro', 'Otro']]
const _optsMedio = v => MEDIOS.map(([k, t]) => `<option value="${k}" ${k === v ? 'selected' : ''}>${t}</option>`).join('')
const _optsBanco = v => '<option value="">-- Cuenta --</option>' + (C?.bancos() || []).map(b => `<option value="${b.id}" ${Number(b.id) === Number(v) ? 'selected' : ''}>${_esc(b.nombre)} (${b.moneda || ''})</option>`).join('')

// ── Modal (se inyecta una sola vez) ──────────────────────────────────────────
function _inyectarModal() {
  if ($('modal-cobro-masivo')) return
  const sec = t => `<strong style="display:block; margin:4px 0 8px; color:var(--text-primary); font-size:0.85rem; font-weight:700; text-transform:uppercase; letter-spacing:0.03em;">${t}</strong>`
  document.body.insertAdjacentHTML('beforeend', `
  <div id="modal-cobro-masivo" class="modal">
    <div class="modal-content" style="width:min(97vw, 1180px); max-width:min(97vw, 1180px); max-height:calc(100vh - 40px); overflow-y:auto;">
      <div class="modal-header">
        <h3 class="modal-title" id="cmTitulo">💰 Cobro masivo — un depósito, varios documentos</h3>
        <button class="modal-close" onclick="window.closeModal('modal-cobro-masivo')">✕</button>
      </div>
      <div style="display:flex; flex-direction:column; gap:14px;">
        <div>
          ${sec('1. Cliente y recibo')}
          <div style="display:grid; grid-template-columns:minmax(260px, 2fr) minmax(170px, 1fr) auto; gap:12px; align-items:end;">
            <div class="form-group" style="margin:0;"><label>Cliente *</label><select id="cmCliente" onchange="window._cmCambioCliente()"></select></div>
            <div class="form-group" style="margin:0;"><label>N° Recibo de cobranza</label>
              <div style="display:flex; gap:6px;"><input type="text" id="cmRecibo" style="flex:1; min-width:0;"><button type="button" class="btn btn-small btn-secondary" title="Siguiente N° del correlativo" onclick="window._sugerirRecibo('cmRecibo')">⏭</button></div></div>
            <div style="display:flex; gap:14px; flex-wrap:wrap; padding-bottom:6px;">
              <label style="display:flex; gap:6px; align-items:center; cursor:pointer; margin:0;"><input type="checkbox" id="cmLetras" checked style="width:auto; margin:0;" onchange="window._cmPintar()"> Incluir letras</label>
              <label id="cmRetWrap" style="display:none; gap:6px; align-items:center; cursor:pointer; margin:0;"><input type="checkbox" id="cmRet" checked style="width:auto; margin:0;" onchange="window._cmRetGlobal()"> Retención IGV</label>
            </div>
          </div>
          <div id="cmSaldosFavor" style="display:none; margin-top:10px;"></div>
        </div>
        <div style="padding-top:12px; border-top:1px solid var(--border-color);">
          <div style="display:flex; justify-content:space-between; align-items:center; gap:10px; flex-wrap:wrap;">
            ${sec('2. <span id="cmTitDep">Depósito</span>')}
            <div style="display:flex; gap:8px;">
              <button type="button" class="btn btn-small btn-secondary" id="cmBtnMulti" onclick="window._cmModoMulti(true)" title="El recibo junta varios vouchers (fechas, cuentas o T.C. distintos)">➕ Vouchers</button>
              <button type="button" class="btn btn-small btn-secondary" id="cmBtnAddV" style="display:none;" onclick="window._cmAddVoucher()">+ Agregar voucher</button>
              <button type="button" class="btn btn-small btn-secondary" id="cmBtnUno" style="display:none;" onclick="window._cmModoMulti(false)" title="Volver a un solo depósito">↩ Un solo depósito</button>
            </div>
          </div>
          <div id="cmDepUno" style="display:grid; grid-template-columns:repeat(auto-fit, minmax(160px, 1fr)); gap:12px;">
            <div class="form-group" style="margin:0;"><label>Fecha de cobro *</label><input type="date" id="cmFecha" onchange="window._cmVSet(0, 'fecha', this.value); window._cmTC(0, 'fecha')"></div>
            <div class="form-group" style="margin:0;"><label>Cuenta (banco / caja) *</label><select id="cmBanco" onchange="window._cmVSet(0, 'bancoId', this.value)"></select></div>
            <div class="form-group" style="margin:0;"><label>Medio</label><select id="cmMedio" onchange="window._cmVSet(0, 'medio', this.value)">${_optsMedio('transferencia')}</select></div>
            <div class="form-group" style="margin:0;"><label>N° operación</label><input type="text" id="cmNumOp" oninput="window._cmVSet(0, 'numOp', this.value, true)"></div>
            <div class="form-group" style="margin:0;"><label style="display:flex; align-items:center; justify-content:space-between; gap:6px; white-space:nowrap;"><span>T. Cambio</span>
              <button type="button" class="btn-tc-dia" onclick="window._cmTC(0, true, this)">⟳ Del día</button></label>
              <input type="number" id="cmTC" step="0.0001" min="0" oninput="window._cmVSet(0, 'tc', this.value, true)"></div>
            <div class="form-group" style="margin:0;"><label>Importe recibido <span id="cmMonCta"></span> *</label>
              <input type="number" id="cmImporte" step="0.01" min="0" oninput="window._cmVSet(0, 'importe', this.value, true)" style="text-align:right; font-weight:700;"></div>
          </div>
          <div id="cmDepMulti" style="display:none; border:1px solid var(--border-color); border-radius:var(--radius-md); overflow:auto;">
            <table style="width:100%; border-collapse:collapse; margin:0; font-size:0.85rem;">
              <thead><tr style="background:var(--bg-secondary);">
                <th style="padding:7px; width:40px;">#</th><th style="padding:7px; text-align:left;">Fecha *</th><th style="padding:7px; text-align:left;">Cuenta *</th>
                <th style="padding:7px; text-align:left;">Medio</th><th style="padding:7px; text-align:left;">N° operación</th>
                <th style="padding:7px; text-align:right;">T.C.</th><th style="padding:7px; text-align:right;">Importe *</th><th style="width:36px;"></th>
              </tr></thead>
              <tbody id="cmVouchers"></tbody>
            </table>
          </div>
        </div>
        <div style="padding-top:12px; border-top:1px solid var(--border-color);">
          <div style="display:flex; justify-content:space-between; align-items:center; gap:10px; flex-wrap:wrap;">
            ${sec('3. Documentos pendientes (más antiguo primero)')}
            <div style="display:flex; gap:8px;">
              <button type="button" class="btn btn-small btn-primary" onclick="window._cmDistribuir()" title="Reparte lo recibido: cancela los más antiguos y deja parcial el siguiente">⚡ Distribuir por antigüedad</button>
              <button type="button" class="btn btn-small btn-secondary" onclick="window._cmLimpiar()">Limpiar</button>
            </div>
          </div>
          <div style="border:1px solid var(--border-color); border-radius:var(--radius-md); overflow:auto; max-height:380px;">
            <table style="width:100%; border-collapse:collapse; margin:0; font-size:0.85rem;">
              <thead><tr style="background:var(--bg-secondary); position:sticky; top:0; z-index:1;">
                <th style="width:34px;"></th><th style="text-align:left; padding:7px;">Documento</th><th style="text-align:left; padding:7px;">Vence</th>
                <th style="text-align:right; padding:7px;">Atraso</th><th style="text-align:center; padding:7px;">Mon.</th><th style="text-align:right; padding:7px;">Saldo</th>
                <th style="text-align:right; padding:7px;" id="cmThRet">Retención</th><th style="text-align:right; padding:7px; width:150px;">Aplicar</th>
                <th style="text-align:left; padding:7px;">Pagado con</th><th style="text-align:center; padding:7px;">Resultado</th>
              </tr></thead>
              <tbody id="cmFilas"></tbody>
            </table>
          </div>
        </div>
        <div id="cmResumen" style="display:grid; grid-template-columns:repeat(auto-fit, minmax(150px, 1fr)); gap:10px; padding:12px; background:var(--bg-secondary); border-radius:var(--radius-md);"></div>
        <div id="cmSobranteBox" style="display:none;"></div>
        <div class="form-group" style="margin:0;"><label>Observaciones</label><input type="text" id="cmObs" placeholder="Opcional"></div>
        <div>
          ${sec('Archivos adjuntos')}
          <input type="file" data-preview-lista id="cmasArchivo" multiple accept=".pdf,.jpg,.jpeg,.png,.webp,application/pdf,image/jpeg,image/png,image/webp" onchange="window._adjSeleccionar('cmas')">
          <small style="color:var(--text-secondary); font-size:0.72rem;">Vouchers / recibo (se guardan en el primer cobro del recibo).</small>
          <div id="cmas-adj-lista" style="display:flex; flex-direction:column; gap:6px; margin-top:6px;"></div>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn" onclick="window.closeModal('modal-cobro-masivo')">Cancelar</button>
        <button class="btn btn-primary" id="cmBtnOk" onclick="window.conCarga(this, window.confirmarCobroMasivo)">💾 Registrar cobro</button>
      </div>
    </div>
  </div>`)
}

// ── Estado / vouchers ────────────────────────────────────────────────────────
// El T.C. NO se copia del voucher anterior: se trae siempre por la fecha del nuevo.
const _nuevoV = (base = {}) => ({ fecha: base.fecha || _hoy(), bancoId: base.bancoId || '', medio: base.medio || 'transferencia', numOp: '', tc: '', importe: 0 })
const _monV = v => C.monedaBanco(v.bancoId) || _st?.filas?.[0]?.moneda || 'PEN'
const _filasVisibles = () => _st.filas.filter(f => f.tipo === 'factura' || $('cmLetras').checked)
const _retAplicada = f => ($('cmRet').checked && $('cmRetWrap').style.display !== 'none') ? f.ret : 0
const _maxAplicable = f => _r2(f.saldo - _retAplicada(f))

// ── Abrir ────────────────────────────────────────────────────────────────────
window.abrirCobroMasivo = async function (contactId = null, opc = {}) {
  if (!C) return
  await C.cargar()
  const cxc = C.cxc().filter(c => c.estado !== 'anulado' && C.saldoCxC(c) > 0.009)
  const letras = C.letras().filter(l => l.tipo === 'emitida' && C.letraAbierta(l) && C.saldoLetra(l) > 0.005)
  const ids = [...new Set([...cxc.map(c => c.contact_id), ...letras.map(l => l.contact_id), ...(contactId ? [contactId] : [])])]
  const opts = ids.map(id => ({ id, n: C.nombre(id) })).sort((a, b) => a.n.localeCompare(b.n, 'es'))
  $('cmCliente').innerHTML = '<option value="">-- Selecciona el cliente --</option>' + opts.map(o => `<option value="${o.id}">${_esc(o.n)}</option>`).join('')
  $('cmCliente').value = contactId || ''
  C.refrescarBuscador?.('cmCliente')
  for (const k of ['cmRecibo', 'cmObs']) $(k).value = ''
  C.limpiarAdjuntos('cmas')
  _st = { contactId: null, filas: [], multi: false, vouchers: [_nuevoV()], saldos: [], usarSobrante: true }
  window._cmModoMulti(!!opc.multi, true)
  await window._cmCambioCliente()
  window.openModal('modal-cobro-masivo')
  window._cmTC(0, false)
}

window._cmCambioCliente = async function () {
  const id = parseInt($('cmCliente').value || 0) || null
  _st.contactId = id
  const ct = id ? C.contacto(id) : null
  const sujeto = !!ct?.sujeto_retencion
  $('cmRetWrap').style.display = sujeto ? 'flex' : 'none'
  $('cmThRet').style.display = sujeto ? '' : 'none'
  const facturas = id ? C.cxc().filter(c => c.contact_id === id && c.estado !== 'anulado' && C.saldoCxC(c) > 0.009).map(c => {
    const esFactura = String(c.tipo_comprobante || '').replace(/^0/, '') === '1' || /factura/i.test(c.tipo_comprobante || '')
    const ret = sujeto && esFactura ? _r2(C.calcRetencion(c)) : 0
    return { k: 'f' + c.id, tipo: 'factura', id: c.id, doc: C.descDoc(c), emision: c.fecha_emision, venc: c.fecha_vencimiento || c.fecha_emision,
      moneda: c.moneda || 'PEN', saldo: _r2(C.saldoCxC(c)), retPosible: ret, ret: ret, aplicar: 0, obj: c }
  }) : []
  const letras = id ? C.letras().filter(l => l.tipo === 'emitida' && l.contact_id === id && ['cartera', 'parcial', 'protestada'].includes(l.estado) && C.saldoLetra(l) > 0.005).map(l => ({
    k: 'l' + l.id, tipo: 'letra', id: l.id, doc: `Letra ${l.numero_letra}`, emision: l.fecha_emision, venc: l.fecha_vencimiento,
    moneda: C.monedaLetra(l), saldo: _r2(C.saldoLetra(l)), retPosible: 0, ret: 0, aplicar: 0, obj: l
  })) : []
  _st.filas = [...facturas, ...letras].sort((a, b) => String(a.venc).localeCompare(String(b.venc)) || String(a.emision).localeCompare(String(b.emision)))
  _st.saldos = []
  if (id) {
    try {
      const { data } = await supabase.from('saldos_favor_cliente').select('*').eq('contact_id', id).eq('estado', 'disponible').order('fecha')
      _st.saldos = (data || []).map(s => ({ id: s.id, moneda: s.moneda, fecha: s.fecha, recibo: s.numero_recibo, empresa_id: s.empresa_id,
        disponible: _r2(parseFloat(s.monto) - parseFloat(s.monto_aplicado || 0)), usar: true, monto: _r2(parseFloat(s.monto) - parseFloat(s.monto_aplicado || 0)) }))
        .filter(s => s.disponible > 0.009)
    } catch (_) { _st.saldos = [] }
  }
  _pintarSaldos()
  _pintarVouchers()
  window._cmPintar()
}

function _pintarSaldos() {
  const box = $('cmSaldosFavor')
  if (!_st.saldos.length) { box.style.display = 'none'; box.innerHTML = ''; return }
  box.style.display = ''
  box.innerHTML = `<div style="padding:10px 14px; border-radius:var(--radius-md); background:rgba(16,185,129,.10); border:1px solid rgba(16,185,129,.4);">
    <div style="font-weight:700; margin-bottom:6px;">💚 Este cliente tiene saldo a favor — se netea en este cobro</div>
    ${_st.saldos.map((s, i) => `<label style="display:flex; align-items:center; gap:10px; margin:4px 0; cursor:pointer; flex-wrap:wrap;">
      <input type="checkbox" style="width:auto; margin:0;" ${s.usar ? 'checked' : ''} onchange="window._cmSaldoSet(${i}, 'usar', this.checked)">
      <span>Saldo #${s.id} · ${fechaDMY(s.fecha)}${s.recibo ? ` · Recibo ${_esc(s.recibo)}` : ''} · disponible <b>${s.moneda} ${formatNumber(s.disponible)}</b></span>
      <span style="display:flex; align-items:center; gap:4px;">usar ${s.moneda} <input type="number" step="0.01" min="0" max="${s.disponible}" value="${s.monto.toFixed(2)}" style="width:110px; text-align:right; padding:3px 6px;" oninput="window._cmSaldoSet(${i}, 'monto', this.value)"></span>
    </label>`).join('')}
    <small style="color:var(--text-secondary);">Solo se aplica a facturas (no a letras). Se usa primero, antes que los vouchers.</small></div>`
}
window._cmSaldoSet = function (i, campo, v) {
  const s = _st.saldos[i]; if (!s) return
  if (campo === 'usar') s.usar = !!v
  else s.monto = Math.min(s.disponible, Math.max(0, _r2(v)))
  window._cmRecalc()
}

window._cmModoMulti = function (on, silencioso = false) {
  if (!_st) return
  if (!on && _st.vouchers.length > 1) {
    if (!silencioso && !confirm(`Volver a un solo depósito descarta ${_st.vouchers.length - 1} voucher(s). ¿Continuar?`)) return
    _st.vouchers = [_st.vouchers[0]]
  }
  _st.multi = !!on
  $('cmDepUno').style.display = on ? 'none' : 'grid'
  $('cmDepMulti').style.display = on ? '' : 'none'
  $('cmBtnMulti').style.display = on ? 'none' : ''
  $('cmBtnAddV').style.display = on ? '' : 'none'
  $('cmBtnUno').style.display = on ? '' : 'none'
  $('cmTitDep').textContent = on ? 'Vouchers del recibo (uno por depósito / transferencia)' : 'Depósito'
  $('cmTitulo').textContent = on ? '🧾 Cobro por recibo — varios vouchers, varios documentos' : '💰 Cobro masivo — un depósito, varios documentos'
  if (on && _st.vouchers.length === 1 && !silencioso) { _st.vouchers.push(_nuevoV(_st.vouchers[0])); window._cmTC(1, 'fecha') }
  _pintarVouchers()
  window._cmRecalc?.()
}

window._cmAddVoucher = function () {
  const ult = _st.vouchers[_st.vouchers.length - 1] || {}
  _st.vouchers.push(_nuevoV(ult))
  _pintarVouchers()
  window._cmTC(_st.vouchers.length - 1, 'fecha')
}
window._cmQuitarVoucher = function (i) {
  if (_st.vouchers.length <= 1) return
  _st.vouchers.splice(i, 1)
  _pintarVouchers(); window._cmRecalc()
}

function _pintarVouchers() {
  const v0 = _st.vouchers[0]
  $('cmBanco').innerHTML = _optsBanco(v0.bancoId)
  $('cmFecha').value = v0.fecha || ''
  $('cmMedio').value = v0.medio || 'transferencia'
  $('cmNumOp').value = v0.numOp || ''
  $('cmTC').value = v0.tc || ''
  $('cmImporte').value = v0.importe || ''
  $('cmMonCta').textContent = `(${_monV(v0)})`
  const inp = 'style="width:100%; padding:5px 7px;"'
  $('cmVouchers').innerHTML = _st.vouchers.map((v, i) => `<tr style="border-top:1px solid var(--border-color);">
    <td style="padding:6px; text-align:center; font-weight:700;">V${i + 1}</td>
    <td style="padding:6px;"><input type="date" ${inp} value="${v.fecha || ''}" onchange="window._cmVSet(${i}, 'fecha', this.value); window._cmTC(${i}, 'fecha')"></td>
    <td style="padding:6px; min-width:190px;"><select ${inp} onchange="window._cmVSet(${i}, 'bancoId', this.value)">${_optsBanco(v.bancoId)}</select></td>
    <td style="padding:6px;"><select ${inp} onchange="window._cmVSet(${i}, 'medio', this.value)">${_optsMedio(v.medio)}</select></td>
    <td style="padding:6px;"><input type="text" ${inp} value="${_esc(v.numOp || '')}" oninput="window._cmVSet(${i}, 'numOp', this.value, true)"></td>
    <td style="padding:6px; white-space:nowrap;"><div style="display:flex; gap:4px; align-items:center;"><input type="number" step="0.0001" min="0" value="${v.tc || ''}" style="width:90px; text-align:right; padding:5px 6px;" id="cmVtc${i}" oninput="window._cmVSet(${i}, 'tc', this.value, true)"><button type="button" class="btn-tc-dia" title="T.C. del día de este voucher" onclick="window._cmTC(${i}, true, this)">⟳</button></div></td>
    <td style="padding:6px; white-space:nowrap;"><div style="display:flex; gap:4px; align-items:center;"><span class="mon mon-${_monV(v).toLowerCase()}">${_monV(v)}</span><input type="number" step="0.01" min="0" value="${v.importe || ''}" style="width:120px; text-align:right; font-weight:700; padding:5px 6px;" oninput="window._cmVSet(${i}, 'importe', this.value, true)"></div></td>
    <td style="text-align:center;">${_st.vouchers.length > 1 ? `<button type="button" class="btn btn-small btn-danger" title="Quitar voucher" onclick="window._cmQuitarVoucher(${i})">✕</button>` : ''}</td>
  </tr>`).join('')
}

window._cmVSet = function (i, campo, v, soloRecalc = false) {
  const x = _st?.vouchers?.[i]; if (!x) return
  x[campo] = campo === 'importe' ? Math.max(0, _r2(v)) : (campo === 'tc' ? (parseFloat(v) || '') : v)
  if (!soloRecalc) _pintarVouchers()
  window._cmRecalc()
}

/**
 * T.C. de venta del día del voucher i (tabla de T.C.).
 * modo: false = solo si está vacío · 'fecha' = cambió la fecha → SIEMPRE se
 * vuelve a traer (ley del sistema) · true = botón ⟳ (con avisos).
 */
window._cmTC = async function (i = 0, modo = false, btn = null) {
  const v = _st?.vouchers?.[i]; if (!v) return
  const forzar = modo === true, porFecha = modo === 'fecha'
  if (!v.fecha) { if (forzar) showToast('Ingresa la fecha del voucher', 'warning'); return }
  if (!forzar && !porFecha && parseFloat(v.tc) > 0) return window._cmRecalc()
  const txt = btn?.textContent
  if (btn) { btn.disabled = true; btn.textContent = '…' }
  let ok = false
  try {
    const r = await getTipoCambioDia(v.fecha, { permitirApi: false })
    if (r?.venta > 0) { v.tc = r.venta; ok = true; if (forzar) showToast(`T.C. venta ${fechaDMY(v.fecha)}: ${r.venta}`, 'success', 2200) }
    else if (forzar) showToast(`No hay T.C. registrado para el ${fechaDMY(v.fecha)}`, 'warning')
  } catch (e) { if (forzar) showToast('No se pudo consultar el T.C.: ' + e.message, 'danger') }
  finally { if (btn) { btn.disabled = false; btn.textContent = txt } }
  const inputs = [$(`cmVtc${i}`), i === 0 ? $('cmTC') : null].filter(Boolean)
  for (const el of inputs) {
    el.value = v.tc || ''
    if (forzar || porFecha) marcarTC(el, ok, ok ? `T.C. venta SUNAT del ${fechaDMY(v.fecha)}` : `No hay T.C. registrado para el ${fechaDMY(v.fecha)}: revisa el valor`)
  }
  window._cmRecalc()
}

// ── Motor de asignación (FIFO fuentes × documentos) ─────────────────────────
/** Fuentes ordenadas: saldos a favor marcados (solo facturas) y luego vouchers por fecha. */
function _fuentes() {
  const tcRef = _st.vouchers.find(v => parseFloat(v.tc) > 0)?.tc || null
  const s = _st.saldos.filter(x => x.usar && x.monto > 0.009).map(x => ({ k: 'S' + x.id, label: `Saldo a favor #${x.id}`, corto: 'SF', tipo: 'saldo', ref: x, mon: x.moneda, tc: tcRef, monto: x.monto, fecha: x.fecha }))
  const v = _st.vouchers.map((x, i) => ({ k: 'V' + (i + 1), label: `Voucher V${i + 1}`, corto: 'V' + (i + 1), tipo: 'voucher', ref: x, idx: i, mon: _monV(x), tc: parseFloat(x.tc) || null, monto: _r2(x.importe), fecha: x.fecha }))
    .filter(x => x.monto > 0).sort((a, b) => String(a.fecha).localeCompare(String(b.fecha)) || a.idx - b.idx)
  return [...s, ...v]
}
const _conv = (m, de, a, tc) => _r2(C.conv(m, de, a, tc || 1))
const _tcPara = (src, f) => src.tc || parseFloat(f.obj?.tipo_cambio) || 1

/** necesidad(f) → cuánto cubrir. Devuelve asignaciones y lo que sobra de cada fuente. */
function _asignar(necesidad) {
  const fuentes = _fuentes().map(s => ({ ...s, resto: s.monto }))
  const asig = [], falta = {}
  for (const f of _filasVisibles()) {
    let need = _r2(necesidad(f))
    if (!(need > 0)) continue
    for (const s of fuentes) {
      if (need <= 0.004) break
      if (s.resto <= 0.004) continue
      if (s.tipo === 'saldo' && f.tipo !== 'factura') continue
      const tc = _tcPara(s, f)
      const dispDoc = _conv(s.resto, s.mon, f.moneda, tc)
      if (dispDoc <= 0.004) continue
      const tomaDoc = Math.min(need, dispDoc)
      const tomaSrc = tomaDoc >= dispDoc - 0.004 ? s.resto : Math.min(s.resto, _conv(tomaDoc, f.moneda, s.mon, tc))
      asig.push({ f, s, montoDoc: _r2(tomaDoc), montoSrc: _r2(tomaSrc), tc })
      need = _r2(need - tomaDoc); s.resto = _r2(s.resto - tomaSrc)
    }
    if (need > 0.004) falta[f.k] = need
  }
  return { asig, falta, fuentes }
}

window._cmPintar = function () {
  if (!_st) return
  const tb = $('cmFilas')
  const vis = _filasVisibles()
  const sujeto = $('cmRetWrap').style.display !== 'none'
  const hoy = _st.vouchers[0]?.fecha || _hoy()
  if (!_st.contactId) { tb.innerHTML = '<tr><td colspan="10" style="text-align:center; padding:16px; color:var(--text-secondary);">Elige el cliente.</td></tr>'; window._cmRecalc(); return }
  if (!vis.length) { tb.innerHTML = '<tr><td colspan="10" style="text-align:center; padding:16px; color:var(--text-secondary);">Sin documentos pendientes. Si el cliente deposita por adelantado, todo quedará como saldo a favor.</td></tr>'; window._cmRecalc(); return }
  tb.innerHTML = vis.map(f => {
    const at = _dias(f.venc, hoy)
    return `<tr data-k="${f.k}" style="border-top:1px solid var(--border-color);">
      <td style="text-align:center;"><input type="checkbox" style="width:auto; margin:0;" ${f.aplicar > 0 ? 'checked' : ''} onchange="window._cmCheck('${f.k}', this.checked)"></td>
      <td style="padding:6px 7px;"><b>${_esc(f.doc)}</b>${f.tipo === 'letra' ? ' <span class="badge badge-info" style="font-size:0.65rem;">letra</span>' : ''}<br><small style="color:var(--text-secondary);">Emisión ${fechaDMY(f.emision)}</small></td>
      <td style="padding:6px 7px;">${fechaDMY(f.venc)}</td>
      <td style="padding:6px 7px; text-align:right; ${at > 0 ? 'color:var(--color-danger); font-weight:600;' : 'color:var(--color-success);'}">${at === null ? '—' : (at > 0 ? '+' : '') + at}</td>
      <td style="text-align:center;"><span class="badge ${f.moneda === 'USD' ? 'badge-info' : 'badge-secondary'}">${f.moneda}</span></td>
      <td style="padding:6px 7px; text-align:right; font-weight:600;">${formatNumber(f.saldo)}</td>
      <td style="padding:6px 7px; text-align:right; ${sujeto ? '' : 'display:none;'}">${f.retPosible ? `<input type="number" step="0.01" min="0" value="${f.ret.toFixed(2)}" style="width:90px; text-align:right; padding:4px 6px;" oninput="window._cmSet('${f.k}', 'ret', this.value)">` : '—'}</td>
      <td style="padding:6px 7px;"><input type="number" step="0.01" min="0" value="${f.aplicar ? f.aplicar.toFixed(2) : ''}" placeholder="0.00" id="cmAp-${f.k}" style="width:100%; text-align:right; padding:5px 7px; font-weight:600;" oninput="window._cmSet('${f.k}', 'aplicar', this.value)"></td>
      <td style="padding:6px 7px; font-size:0.78rem;" id="cmEq-${f.k}"></td>
      <td style="text-align:center;" id="cmRes-${f.k}"></td>
    </tr>`
  }).join('')
  window._cmRecalc()
}

window._cmSet = function (k, campo, v) {
  const f = _st.filas.find(x => x.k === k); if (!f) return
  f[campo] = Math.max(0, _r2(v))
  if (campo === 'ret') f.ret = Math.min(f.ret, f.retPosible)
  const chk = document.querySelector(`tr[data-k="${k}"] input[type=checkbox]`)
  if (chk && campo === 'aplicar') chk.checked = f.aplicar > 0
  window._cmRecalc()
}
window._cmCheck = function (k, on) {
  const f = _st.filas.find(x => x.k === k); if (!f) return
  if (on) {
    // Marca: lo que alcance con lo que queda libre de las fuentes (o el saldo si aún no hay importes)
    const hayFuentes = _fuentes().length > 0
    const { fuentes } = _asignar(x => x.k === k ? 0 : x.aplicar)
    let libre = 0
    for (const s of fuentes) if (s.resto > 0.004 && !(s.tipo === 'saldo' && f.tipo !== 'factura')) libre = _r2(libre + _conv(s.resto, s.mon, f.moneda, _tcPara(s, f)))
    f.aplicar = hayFuentes ? Math.min(_maxAplicable(f), libre) : _maxAplicable(f)
  } else f.aplicar = 0
  const inp = $(`cmAp-${k}`); if (inp) inp.value = f.aplicar ? f.aplicar.toFixed(2) : ''
  window._cmRecalc()
}
window._cmRetGlobal = function () { window._cmPintar() }
window._cmLimpiar = function () { _st.filas.forEach(f => { f.aplicar = 0 }); window._cmPintar() }

/** FIFO: cancela los más antiguos y deja parcial el siguiente. */
window._cmDistribuir = function () {
  const fs = _fuentes()
  if (!fs.length) { showToast('Ingresa el importe del voucher (o marca un saldo a favor)', 'warning'); return }
  if (fs.some(s => s.tipo === 'voucher' && !s.ref.bancoId)) { showToast('Elige la cuenta de cada voucher', 'warning'); return }
  const sinTC = fs.some(s => s.tipo === 'voucher' && _filasVisibles().some(f => f.moneda !== s.mon) && !(s.tc > 0))
  if (sinTC) { showToast('Falta el T.C. de algún voucher (hay documentos en otra moneda)', 'warning'); return }
  _st.filas.forEach(f => { f.aplicar = 0 })
  const { asig } = _asignar(f => _maxAplicable(f))
  for (const a of asig) a.f.aplicar = _r2(a.f.aplicar + a.montoDoc)
  window._cmPintar()
}

function _sobrantes(fuentes) {
  const m = {}
  for (const s of fuentes) if (s.tipo === 'voucher' && s.resto > 0.009) m[s.mon] = _r2((m[s.mon] || 0) + s.resto)
  return m
}

window._cmRecalc = function () {
  if (!_st || !$('cmResumen')) return
  const { asig, falta, fuentes } = _asignar(f => f.aplicar)
  const porDoc = {}
  for (const a of asig) (porDoc[a.f.k] ||= []).push(a)
  let cancelados = 0, parciales = 0, retTot = 0
  const aplicadoMon = {}
  for (const f of _filasVisibles()) {
    const r = _retAplicada(f) && f.aplicar > 0 ? f.ret : 0
    retTot = _r2(retTot + r)
    const queda = _r2(f.saldo - f.aplicar - r)
    if (f.aplicar > 0) aplicadoMon[f.moneda] = _r2((aplicadoMon[f.moneda] || 0) + f.aplicar)
    const eqTd = $(`cmEq-${f.k}`)
    if (eqTd) eqTd.innerHTML = !f.aplicar ? '<span style="color:var(--text-secondary);">—</span>'
      : (porDoc[f.k] || []).map(a => `<span class="badge ${a.s.tipo === 'saldo' ? 'badge-success' : 'badge-secondary'}" style="font-size:0.7rem; margin:1px;" title="${_esc(a.s.label)} · ${fechaDMY(a.s.fecha)}${a.s.mon !== f.moneda ? ` · T.C. ${a.tc}` : ''}">${a.s.corto} ${a.s.mon} ${formatNumber(a.montoSrc)}</span>`).join(' ')
        + (falta[f.k] ? ` <span class="badge badge-danger" style="font-size:0.7rem;">falta ${formatNumber(falta[f.k])}</span>` : '')
    const res = $(`cmRes-${f.k}`)
    if (res) res.innerHTML = !f.aplicar ? '<span style="color:var(--text-secondary);">—</span>'
      : queda <= 0.009 ? '<span class="badge badge-success">Cancela</span>'
      : `<span class="badge badge-warning" title="Queda ${formatNumber(queda)}">Parcial · queda ${formatNumber(queda)}</span>`
    if (f.aplicar > 0) { if (queda <= 0.009) cancelados++; else parciales++ }
    const i = $(`cmAp-${f.k}`); if (i) i.style.borderColor = (f.aplicar > _maxAplicable(f) + 0.009 || falta[f.k]) ? 'var(--color-danger)' : ''
  }
  const recibidoMon = {}
  for (const s of fuentes) if (s.tipo === 'voucher') recibidoMon[s.mon] = _r2((recibidoMon[s.mon] || 0) + s.monto)
  const saldoUsado = {}
  for (const s of fuentes) if (s.tipo === 'saldo' && s.monto - s.resto > 0.004) saldoUsado[s.mon] = _r2((saldoUsado[s.mon] || 0) + s.monto - s.resto)
  const sobr = _sobrantes(fuentes)
  const faltaTot = Object.values(falta).reduce((t, x) => t + x, 0)
  const txt = o => Object.keys(o).length ? Object.entries(o).map(([m, v]) => `${m} ${formatNumber(v)}`).join(' · ') : '—'
  const caja = (t, v, st = '') => `<div><div style="font-size:0.7rem; text-transform:uppercase; letter-spacing:.4px; color:var(--text-secondary);">${t}</div><div style="font-weight:700; font-size:1.02rem;${st}">${v}</div></div>`
  const haySobr = Object.keys(sobr).length > 0
  const cuadra = faltaTot <= 0.05 && (!haySobr || _st.usarSobrante)
  $('cmResumen').innerHTML =
    caja(`Recibido (${_st.vouchers.length} voucher${_st.vouchers.length === 1 ? '' : 's'})`, txt(recibidoMon)) +
    (Object.keys(saldoUsado).length ? caja('Saldo a favor usado', txt(saldoUsado), ' color:var(--color-success);') : '') +
    caja('Aplicado a documentos', txt(aplicadoMon)) +
    caja(faltaTot > 0.05 ? 'Falta cubrir' : (haySobr ? 'Sobrante → saldo a favor' : 'Cuadra ✔'),
      faltaTot > 0.05 ? formatNumber(faltaTot) : (haySobr ? txt(sobr) : '0.00'),
      ` color:${faltaTot > 0.05 ? 'var(--color-danger)' : (haySobr ? 'var(--color-warning)' : 'var(--color-success)')};`) +
    caja('Cancelados / parciales', `${cancelados} / ${parciales}`) +
    (retTot ? caja('Retención IGV', formatNumber(retTot), ' color:var(--color-warning);') : '')
  const sb = $('cmSobranteBox')
  if (haySobr) {
    sb.style.display = ''
    sb.innerHTML = `<label style="display:flex; gap:10px; align-items:flex-start; padding:10px 14px; border-radius:var(--radius-md); border:1px solid var(--color-warning); background:rgba(245,158,11,.08); cursor:pointer;">
      <input type="checkbox" style="width:auto; margin:3px 0 0;" ${_st.usarSobrante ? 'checked' : ''} onchange="_cmSobranteOk(this.checked)">
      <span><b>Registrar el sobrante (${txt(sobr)}) como SALDO A FAVOR del cliente.</b><br><small style="color:var(--text-secondary);">El dinero entra completo al banco. En la próxima cobranza de este cliente aparecerá el aviso para netearlo.</small></span></label>`
  } else { sb.style.display = 'none'; sb.innerHTML = '' }
  const aplicado = Object.values(aplicadoMon).reduce((t, x) => t + x, 0)
  const btn = $('cmBtnOk')
  if (btn && !btn.classList.contains('btn-cargando')) {
    btn.disabled = !(fuentes.length) || !cuadra || (aplicado <= 0 && !haySobr)
    btn.textContent = _st.multi ? '💾 Registrar recibo' : '💾 Registrar cobro'
  }
}
window._cmSobranteOk = function (on) { _st.usarSobrante = !!on; window._cmRecalc() }

// ── Confirmar ────────────────────────────────────────────────────────────────
window.confirmarCobroMasivo = async function () {
  if (!_st?.contactId) { showToast('Elige el cliente', 'warning'); return }
  const recibo = $('cmRecibo').value.trim() || null, obs = $('cmObs').value.trim() || null
  const vouchers = _st.vouchers.filter(v => _r2(v.importe) > 0)
  if (_st.vouchers.some(v => _r2(v.importe) > 0 && (!v.fecha || !v.bancoId))) { showToast('Cada voucher necesita fecha y cuenta', 'warning'); return }
  if (!vouchers.length && !_st.saldos.some(s => s.usar && s.monto > 0)) { showToast('Ingresa el importe recibido', 'warning'); return }
  // N° de operación repetido dentro del recibo (misma cuenta)
  const ops = vouchers.filter(v => (v.numOp || '').trim()).map(v => `${v.bancoId}|${String(v.numOp).trim().replace(/^0+(?=\d)/, '').toLowerCase()}`)
  if (new Set(ops).size !== ops.length) { showToast('⛔ Hay dos vouchers con el mismo N° de operación en la misma cuenta', 'danger', 8000); return }
  for (const f of _filasVisibles()) if (f.aplicar > _maxAplicable(f) + 0.009) { showToast(`${f.doc}: lo aplicado supera su saldo (${formatNumber(_maxAplicable(f))})`, 'warning'); return }
  const sel = _filasVisibles().filter(f => f.aplicar > 0)
  // T.C. obligatorio cuando el voucher cruza a otra moneda
  for (const v of vouchers) if (sel.some(f => f.moneda !== _monV(v)) && !(parseFloat(v.tc) > 0)) { showToast(`Falta el T.C. del voucher del ${fechaDMY(v.fecha)}`, 'warning'); return }
  // Saldo REAL de la BD (otro usuario pudo cobrar mientras tanto)
  for (const f of sel.filter(x => x.tipo === 'factura')) {
    const { data: fr } = await supabase.from('cuentas_cobrar').select('*').eq('id', f.obj.id).maybeSingle()
    if (!fr) { showToast(`${f.doc}: no se pudo releer de la BD. Reintenta.`, 'danger'); return }
    const real = _r2(C.saldoCxC(fr))
    if (f.aplicar + _retAplicada(f) > real + 0.009) { showToast(`${f.doc}: ya fue cobrada por otro usuario. Saldo real ${formatNumber(Math.max(0, real))}. Cierra y vuelve a abrir.`, 'warning', 9000); return }
    f.obj = { ...f.obj, ...fr }
  }
  // MULTIEMPRESA: un recibo es de UNA empresa (documentos, cuentas y saldos a favor)
  const emps = [...new Set([...sel.map(f => f.obj?.empresa_id), ..._st.saldos.filter(s => s.usar).map(s => s.empresa_id)].filter(e => e != null).map(Number))]
  if (emps.length > 1) { showToast('⛔ Hay documentos/saldos de empresas distintas. Un recibo es de una sola empresa.', 'danger', 9000); return }
  let empresaRec = emps[0] ?? null
  for (const v of vouchers) {
    const b = C.bancos().find(x => Number(x.id) === Number(v.bancoId))
    if (b?.empresa_id == null) continue
    if (empresaRec == null) empresaRec = Number(b.empresa_id)
    if (Number(b.empresa_id) !== empresaRec) { showToast(`⛔ La cuenta "${b.nombre}" es de otra empresa que los documentos.`, 'danger', 9000); return }
  }
  empresaRec ??= empresaTrabajoCtx()
  // N° de operación ya registrado en esa cuenta → mismo depósito dos veces
  for (const v of vouchers) {
    const op = String(v.numOp || '').trim(); if (!op) continue
    const n = op.replace(/^0+(?=\d)/, '').replace(/["*,()]/g, '')
    const { data: ya } = await supabase.from('cobros_lote').select('id, fecha, monto_recibido, numero_operacion').eq('banco_id', v.bancoId).ilike('numero_operacion', `*${n}`)
    const igual = (ya || []).find(x => String(x.numero_operacion || '').replace(/^0+(?=\d)/, '').toLowerCase() === n.toLowerCase())
    if (igual) { showToast(`⛔ La operación N° ${op} ya está registrada en esa cuenta (L${igual.id}, ${fechaDMY(igual.fecha)}, ${formatNumber(igual.monto_recibido)}).`, 'danger', 10000); return }
  }
  const { asig, falta, fuentes } = _asignar(f => f.aplicar)
  if (Object.values(falta).reduce((t, x) => t + x, 0) > 0.05) { showToast('Lo recibido no alcanza para lo aplicado: ajusta los montos o agrega un voucher', 'warning'); return }
  const sobr = _sobrantes(fuentes)
  if (Object.keys(sobr).length && !_st.usarSobrante) { showToast('Hay un sobrante: márcalo como saldo a favor o ajusta los montos', 'warning'); return }
  if (!(await C.reciboLibre(recibo, _st.contactId))) return

  const resumen = [
    ...fuentes.map(s => `• ${s.label}${s.tipo === 'voucher' ? ` ${fechaDMY(s.fecha)}` : ''}: ${s.mon} ${formatNumber(s.monto - (s.tipo === 'saldo' ? s.resto : 0))}${s.tipo === 'voucher' && s.resto > 0.009 ? ` (sobran ${formatNumber(s.resto)} → saldo a favor)` : ''}`),
    '',
    ...sel.map(f => { const r = _retAplicada(f), queda = _r2(f.saldo - f.aplicar - r); return `• ${f.doc}: ${f.moneda} ${formatNumber(f.aplicar)}${r ? ` + ret. ${formatNumber(r)}` : ''} → ${queda <= 0.009 ? 'CANCELA' : 'parcial, queda ' + formatNumber(queda)}` })
  ].join('\n')
  if (!confirm(`${_st.multi ? 'Cobro por recibo' : 'Cobro masivo'} — ${C.nombre(_st.contactId)}${recibo ? ` · Recibo ${recibo}` : ''}\n\n${resumen}\n\n¿Registrar?`)) return

  const user = getCurrentUser()
  const grupo = _uuid()
  const hechos = [], errores = [], lotes = []
  const retUsada = new Set()
  let primerCobroId = null

  // 1) Un depósito (lote) + su movimiento bancario por cada voucher
  for (const s of fuentes.filter(x => x.tipo === 'voucher')) {
    const v = s.ref
    const usadoSrc = _r2(s.monto - s.resto)
    let lote
    try {
      lote = await _sb(supabase.from('cobros_lote').insert({
        empresa_id: empresaRec, grupo_recibo: grupo,
        contact_id: _st.contactId, fecha: v.fecha, banco_id: parseInt(v.bancoId), moneda: s.mon, tipo_cambio: parseFloat(v.tc) || null,
        monto_recibido: s.monto, monto_aplicado: usadoSrc, medio_pago: v.medio, numero_operacion: (v.numOp || '').trim() || null,
        numero_recibo: recibo, observaciones: obs, created_by: user?.db_id || null
      }).select().single())
    } catch (e) { errores.push(`${s.label}: ${e.message}`); continue }
    lotes.push({ s, lote })
    for (const a of asig.filter(x => x.s.k === s.k)) {
      const f = a.f
      try {
        if (f.tipo === 'factura') {
          const ret = !retUsada.has(f.k) ? _retAplicada(f) : 0
          retUsada.add(f.k)
          const tcDoc = f.moneda === 'PEN' && s.mon === 'PEN' ? 1 : (parseFloat(v.tc) || parseFloat(f.obj.tipo_cambio) || 1)
          const cobro = await addCobro({
            empresa_id: f.obj.empresa_id ?? empresaRec,
            numero_recibo: recibo, cxc_id: f.obj.id, contact_id: f.obj.contact_id, fecha: v.fecha, monto: a.montoDoc,
            moneda: f.moneda, tipo_cambio: tcDoc, medio_pago: v.medio, referencia: (v.numOp || '').trim() || `Recibo L${lote.id}`,
            banco_id: parseInt(v.bancoId), numero_operacion: (v.numOp || '').trim() || null, monto_retencion: ret, lote_id: lote.id
          })
          if (!cobro?.id) throw new Error('no se pudo crear el cobro (revisa la consola)')
          primerCobroId ||= cobro.id
          await C.aplicarEfectosCobro(cobro, f.obj, { sinMov: true })
        } else {
          await C.registrarAbonoLetra(f.obj, {
            ubicacion: 'cartera', medio: v.medio, bancoId: parseInt(v.bancoId), fecha: v.fecha, numOp: (v.numOp || '').trim() || null, recibo,
            tcDia: parseFloat(v.tc) || parseFloat(f.obj.tipo_cambio) || 1,
            amort: a.montoDoc, interes: 0, portes: 0, comision: 0, otros: 0, obs: `Recibo${recibo ? ' ' + recibo : ''} L${lote.id}`, sinMov: true, loteId: lote.id
          })
          f.obj = (await C.getLetra(f.obj.id)) || f.obj   // monto_pagado fresco para el siguiente voucher
        }
        hechos.push(`${f.doc} (${s.corto})`)
      } catch (e) { console.error('recibo', f.doc, e); errores.push(`${f.doc} (${s.corto}): ${e.message}`) }
    }
    const mov = await C.registrarMov({
      bancoId: parseInt(v.bancoId), tipo: 'ingreso', fecha: v.fecha, categoria: 'Cobranza clientes',
      concepto: `Depósito ${C.nombre(_st.contactId)} — ${_st.multi ? 'recibo' : 'cobro masivo'} L${lote.id}${recibo ? ` Rec. ${recibo}` : ''}`,
      referencia: (v.numOp || '').trim() || `LOTE-COBRO ${lote.id}`, numeroOperacion: (v.numOp || '').trim() || null, monto: s.monto, monedaMonto: s.mon, tc: parseFloat(v.tc) || 1
    })
    await supabase.from('cobros_lote').update({ movimiento_banco_id: mov?.id || null }).eq('id', lote.id)
    // Sobrante de este voucher → saldo a favor
    if (s.resto > 0.009) {
      try {
        await _sb(supabase.from('saldos_favor_cliente').insert({
          empresa_id: empresaRec, contact_id: _st.contactId, fecha: v.fecha, moneda: s.mon, monto: s.resto,
          origen: 'sobrante_cobro', lote_id: lote.id, grupo_recibo: grupo, numero_recibo: recibo,
          observaciones: `Sobrante del ${_st.multi ? 'recibo' : 'cobro masivo'} L${lote.id}`, created_by: user?.db_id || null
        }))
        hechos.push(`saldo a favor ${s.mon} ${formatNumber(s.resto)}`)
      } catch (e) { errores.push(`Saldo a favor: ${e.message}`) }
    }
  }

  // 2) Lo pagado con saldo a favor: cobro sin banco (medio 'saldo_favor'), atado al primer depósito del recibo
  const loteAncla = lotes[0]?.lote?.id || null
  const fechaSF = _st.vouchers.map(v => v.fecha).filter(Boolean).sort()[0] || _hoy()
  for (const a of asig.filter(x => x.s.tipo === 'saldo')) {
    const f = a.f
    try {
      const ret = !retUsada.has(f.k) ? _retAplicada(f) : 0
      retUsada.add(f.k)
      const cobro = await addCobro({
        empresa_id: f.obj.empresa_id ?? empresaRec,
        numero_recibo: recibo, cxc_id: f.obj.id, contact_id: f.obj.contact_id, fecha: fechaSF, monto: a.montoDoc,
        moneda: f.moneda, tipo_cambio: a.s.mon === f.moneda ? (parseFloat(f.obj.tipo_cambio) || 1) : a.tc, medio_pago: 'saldo_favor',
        referencia: `Saldo a favor #${a.s.ref.id}`, banco_id: null, monto_retencion: ret, lote_id: loteAncla,
        saldo_favor_id: a.s.ref.id, saldo_favor_monto: a.montoSrc
      })
      if (!cobro?.id) throw new Error('no se pudo crear el cobro con saldo a favor (¿falta el SQL 151?)')
      primerCobroId ||= cobro.id
      await C.aplicarEfectosCobro(cobro, f.obj, { sinMov: true })
      hechos.push(`${f.doc} (saldo a favor)`)
    } catch (e) { console.error('saldo a favor', f.doc, e); errores.push(`${f.doc} (saldo a favor): ${e.message}`) }
  }

  if (primerCobroId) await C.subirAdjuntos('cmas', 'cobro', primerCobroId)
  window.closeModal('modal-cobro-masivo')
  const L = lotes.map(x => 'L' + x.lote.id).join(', ')
  if (errores.length) showToast(`⚠️ ${hechos.length} aplicado(s), ${errores.length} con error — ${errores.join(' · ')}. Revisa y usa "Deshacer recibo" si hace falta.`, 'danger', 15000)
  else showToast(`${_st.multi ? 'Recibo' : 'Cobro masivo'} ✅ ${L} — ${hechos.join(' · ')}`, 'success', 8000)
  await C.refrescar()
}

// ── Deshacer (recibo / lote completo) ────────────────────────────────────────
window.deshacerCobroMasivo = async function (loteId) {
  try {
    const lote0 = await _sb(supabase.from('cobros_lote').select('*').eq('id', loteId).single())
    const lotes = lote0.grupo_recibo ? await _sb(supabase.from('cobros_lote').select('*').eq('grupo_recibo', lote0.grupo_recibo)) : [lote0]
    const ids = lotes.map(l => l.id)
    const cobros = await _sb(supabase.from('cobros').select('*').in('lote_id', ids))
    const abonos = await _sb(supabase.from('letras_abonos').select('*').in('lote_id', ids))
    let saldos = []
    try {
      saldos = lote0.grupo_recibo
        ? await _sb(supabase.from('saldos_favor_cliente').select('*').eq('grupo_recibo', lote0.grupo_recibo))
        : await _sb(supabase.from('saldos_favor_cliente').select('*').in('lote_id', ids))
    } catch (_) { saldos = [] }
    const usados = saldos.filter(s => parseFloat(s.monto_aplicado || 0) > 0.009)
    if (usados.length) { showToast(`⛔ El saldo a favor que generó este recibo ya se usó en otra cobranza (saldo #${usados.map(s => s.id).join(', #')}). Deshaz primero esa cobranza.`, 'danger', 10000); return }
    const docs = [...cobros.map(c => `${C.descDoc(C.cxc().find(x => x.id === c.cxc_id) || {}) || 'cobro #' + c.id}${c.medio_pago === 'saldo_favor' ? ' (con saldo a favor)' : ''}`), ...abonos.map(a => `letra #${a.letra_id}`)]
    const vtxt = lotes.map(l => `• L${l.id} ${fechaDMY(l.fecha)} ${l.moneda} ${formatNumber(l.monto_recibido)}`).join('\n')
    if (!confirm(`Deshacer el ${lotes.length > 1 ? `recibo completo (${lotes.length} vouchers)` : `cobro masivo L${loteId}`}:\n${vtxt}\n\nDocumentos:\n• ${docs.join('\n• ') || '—'}${saldos.length ? `\n\nSe anula el saldo a favor generado: ${saldos.map(s => `${s.moneda} ${formatNumber(s.monto)}`).join(', ')}` : ''}\n\nSe revierten cobros/abonos, cuotas y movimientos bancarios. ¿Continuar?`)) return
    const avisos = []
    for (const c of cobros) {
      const r = await C.revertirEfectosCP('cobro', c)
      avisos.push(...(r.avisos || []))
      const ok = await deleteCobro(c.id)
      if (!ok) { avisos.push(`cobro #${c.id} no se pudo eliminar`); continue }
      if (r.asiento?.id) { try { await eliminarAsientoContable(r.asiento.id) } catch (e) { avisos.push('asiento: ' + e.message) } }
    }
    for (const a of abonos) {
      const l = await C.getLetra(a.letra_id)
      avisos.push(...(await C.revertirContableAbono(a, l)))
      await supabase.from('letras_abonos').delete().eq('id', a.id)
      if (l) await C.recalcularLetra(l, a.estado_previo)
    }
    for (const s of saldos) await supabase.from('saldos_favor_cliente').delete().eq('id', s.id)
    for (const l of lotes) {
      const mov = l.movimiento_banco_id ? await C.movPorId(l.movimiento_banco_id) : null
      if (mov) await C.eliminarMovYSaldo(mov)
      await supabase.from('cobros_lote').delete().eq('id', l.id)
    }
    window.closeModal?.('modal-detalle-cp')
    showToast(`${lotes.length > 1 ? 'Recibo' : 'Cobro masivo'} deshecho ✅${avisos.length ? ' — ⚠️ ' + avisos.join('; ') : ''}`, avisos.length ? 'warning' : 'success', 8000)
    await C.refrescar()
  } catch (e) { console.error('deshacerCobroMasivo:', e); showToast('Error: ' + e.message, 'danger', 9000) }
}

/** Sección "📦 Cobro masivo / 🧾 Recibo" para Ver detalle de un cobro que pertenece a un lote. */
export async function htmlSeccionLote(loteId) {
  try {
    const lote0 = await _sb(supabase.from('cobros_lote').select('*').eq('id', loteId).single())
    const lotes = lote0.grupo_recibo ? await _sb(supabase.from('cobros_lote').select('*').eq('grupo_recibo', lote0.grupo_recibo).order('fecha')) : [lote0]
    const ids = lotes.map(l => l.id)
    const cobros = await _sb(supabase.from('cobros').select('id, cxc_id, monto, moneda, monto_retencion, lote_id, medio_pago, fecha').in('lote_id', ids))
    const abonos = await _sb(supabase.from('letras_abonos').select('id, letra_id, monto_amortizado, moneda, lote_id, fecha').in('lote_id', ids))
    let saldos = []
    try { saldos = lote0.grupo_recibo ? await _sb(supabase.from('saldos_favor_cliente').select('*').eq('grupo_recibo', lote0.grupo_recibo)) : await _sb(supabase.from('saldos_favor_cliente').select('*').in('lote_id', ids)) } catch (_) {}
    const filas = [
      ...cobros.map(c => { const d = C.cxc().find(x => x.id === c.cxc_id); const l = lotes.find(x => x.id === c.lote_id); return `<tr><td>${_esc(d ? C.descDoc(d) : 'cobro #' + c.id)}</td><td>${c.medio_pago === 'saldo_favor' ? '<span class="badge badge-success">Saldo a favor</span>' : `L${l?.id} · ${fechaDMY(l?.fecha)}`}</td><td>${c.moneda}</td><td style="text-align:right;">${formatNumber(c.monto)}</td><td style="text-align:right;">${parseFloat(c.monto_retencion) ? formatNumber(c.monto_retencion) : '—'}</td></tr>` }),
      ...abonos.map(a => { const l = C.letras().find(x => x.id === a.letra_id); const lo = lotes.find(x => x.id === a.lote_id); return `<tr><td>Letra ${_esc(l?.numero_letra || '#' + a.letra_id)}</td><td>L${lo?.id} · ${fechaDMY(lo?.fecha)}</td><td>${a.moneda || ''}</td><td style="text-align:right;">${formatNumber(a.monto_amortizado)}</td><td>—</td></tr>` })
    ].join('')
    const titulo = lotes.length > 1
      ? `🧾 Recibo${lote0.numero_recibo ? ' ' + _esc(lote0.numero_recibo) : ''} — ${lotes.length} vouchers`
      : `📦 Cobro masivo L${lote0.id} — depósito ${lote0.moneda} ${formatNumber(lote0.monto_recibido)} (${fechaDMY(lote0.fecha)})`
    return `<h4 style="margin:16px 0 6px;">${titulo}</h4>
      ${lotes.length > 1 ? `<div style="font-size:0.82rem; margin-bottom:6px;">${lotes.map(l => `<span class="badge badge-secondary" style="margin:2px;">L${l.id} · ${fechaDMY(l.fecha)} · ${l.moneda} ${formatNumber(l.monto_recibido)}${l.numero_operacion ? ' · Op. ' + _esc(l.numero_operacion) : ''}</span>`).join('')}</div>` : ''}
      <div style="font-size:0.82rem; color:var(--text-secondary); margin-bottom:6px;">Se edita o elimina deshaciendo el ${lotes.length > 1 ? 'recibo completo' : 'lote completo'}.</div>
      <div style="border:1px solid var(--border-color); border-radius:var(--radius-md); overflow-x:auto;"><table style="width:100%; border-collapse:collapse; margin:0;">
        <thead><tr style="background:var(--bg-secondary);"><th>Documento</th><th>Pagado con</th><th>Mon.</th><th style="text-align:right;">Aplicado</th><th style="text-align:right;">Retención</th></tr></thead><tbody>${filas}</tbody></table></div>
      ${saldos.length ? `<div style="margin-top:8px; padding:8px 12px; border-radius:var(--radius-md); background:rgba(16,185,129,.10); font-size:0.85rem;">💚 Saldo a favor generado: ${saldos.map(s => `#${s.id} ${s.moneda} ${formatNumber(s.monto)} (${s.estado}${parseFloat(s.monto_aplicado) ? ', usado ' + formatNumber(s.monto_aplicado) : ''})`).join(' · ')}</div>` : ''}
      <button class="btn btn-danger btn-small" style="margin-top:8px;" onclick="window.deshacerCobroMasivo(${lote0.id})">↩ Deshacer ${lotes.length > 1 ? 'recibo' : 'cobro masivo'}</button>`
  } catch (e) { return `<p style="color:var(--color-danger);">${_esc(e.message)}</p>` }
}
