// ============================================================================
// COBRO MASIVO — un depósito del cliente aplicado a varias facturas / letras
// (2026-10-10, SQL 83_cobros_masivos.sql)
// ============================================================================
// Caso típico: el cliente deposita 10,000 → cancela la factura más antigua y
// la siguiente (por antigüedad) queda parcial. Reglas:
//   • Orden FIFO: vencimiento más antiguo primero (luego emisión).
//   • Cada documento recibe un cobro normal (o abono de letra) con su asiento,
//     imputación a cuotas y retención IGV si aplica, pero SIN movimiento
//     bancario propio: el banco ve UN solo ingreso por el total depositado.
//   • Multimoneda: el depósito está en la moneda de la cuenta; cada documento
//     se aplica en su moneda con el T.C. del cobro.
//   • Debe cuadrar: Σ aplicado (en moneda de la cuenta) = importe recibido.
//   • Se deshace completo (lote), nunca un documento suelto.
// Analogía: el depósito es una jarra que se vierte en los vasos más antiguos
// primero; el último vaso queda a medias.
// ============================================================================

import { supabase } from './supabase-client.js'
import { showToast, formatNumber, fechaDMY } from './helpers.js'
import { addCobro, deleteCobro, eliminarAsientoContable } from './supabase-data.js'
import { getTipoCambioDia } from './sunat-api.js'
import { getCurrentUser } from './auth-supabase.js'

let C = null          // contexto que entrega cobranzas.js (funciones internas)
let _st = null        // estado del modal
const _r2 = n => Math.round((parseFloat(n) || 0) * 100) / 100
const _esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const _hoy = () => new Date().toISOString().slice(0, 10)
const _dias = (a, b) => (a && b) ? Math.round((new Date(b + 'T00:00:00') - new Date(a + 'T00:00:00')) / 86400000) : null
const $ = id => document.getElementById(id)

export function initCobroMasivo(ctx) { C = ctx; _inyectarModal() }

function _sb(q) { return q.then(({ data, error }) => { if (error) throw new Error(/cobros_lote|lote_id/.test(error.message) ? 'Falta ejecutar el SQL 83 (cobros masivos): ' + error.message : error.message); return data }) }

// ── Modal (se inyecta una sola vez) ──────────────────────────────────────────
function _inyectarModal() {
  if ($('modal-cobro-masivo')) return
  const sec = t => `<strong style="display:block; margin:4px 0 8px; color:var(--text-primary); font-size:0.85rem; font-weight:700; text-transform:uppercase; letter-spacing:0.03em;">${t}</strong>`
  document.body.insertAdjacentHTML('beforeend', `
  <div id="modal-cobro-masivo" class="modal">
    <div class="modal-content" style="width:min(97vw, 1180px); max-width:min(97vw, 1180px); max-height:calc(100vh - 40px); overflow-y:auto;">
      <div class="modal-header">
        <h3 class="modal-title">💰 Cobro masivo — un depósito, varios documentos</h3>
        <button class="modal-close" onclick="window.closeModal('modal-cobro-masivo')">✕</button>
      </div>
      <div style="display:flex; flex-direction:column; gap:14px;">
        <div>
          ${sec('1. Cliente')}
          <div style="display:grid; grid-template-columns:minmax(260px, 2fr) 1fr; gap:12px; align-items:end;">
            <div class="form-group" style="margin:0;"><label>Cliente *</label><select id="cmCliente" onchange="window._cmCambioCliente()"></select></div>
            <div style="display:flex; gap:14px; flex-wrap:wrap; padding-bottom:6px;">
              <label style="display:flex; gap:6px; align-items:center; cursor:pointer; margin:0;"><input type="checkbox" id="cmLetras" checked style="width:auto; margin:0;" onchange="window._cmPintar()"> Incluir letras en cartera</label>
              <label id="cmRetWrap" style="display:none; gap:6px; align-items:center; cursor:pointer; margin:0;"><input type="checkbox" id="cmRet" checked style="width:auto; margin:0;" onchange="window._cmRetGlobal()"> Aplicar retención IGV</label>
            </div>
          </div>
        </div>
        <div style="padding-top:12px; border-top:1px solid var(--border-color);">
          ${sec('2. Depósito')}
          <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(160px, 1fr)); gap:12px;">
            <div class="form-group" style="margin:0;"><label>Fecha de cobro *</label><input type="date" id="cmFecha" onchange="window._cmTC(true)"></div>
            <div class="form-group" style="margin:0;"><label>Cuenta (banco / caja) *</label><select id="cmBanco" onchange="window._cmCambioCuenta()"></select></div>
            <div class="form-group" style="margin:0;"><label>Medio</label><select id="cmMedio">
              <option value="transferencia">Transferencia</option><option value="deposito">Depósito</option><option value="efectivo">Efectivo</option>
              <option value="cheque">Cheque</option><option value="yape_plin">Yape / Plin</option><option value="otro">Otro</option></select></div>
            <div class="form-group" style="margin:0;"><label>N° operación</label><input type="text" id="cmNumOp"></div>
            <div class="form-group" style="margin:0;"><label>N° Recibo de cobranza</label>
              <div style="display:flex; gap:6px;"><input type="text" id="cmRecibo" style="flex:1; min-width:0;"><button type="button" class="btn btn-small btn-secondary" title="Siguiente N° del correlativo" onclick="window._sugerirRecibo('cmRecibo')">⏭</button></div></div>
            <div class="form-group" style="margin:0;"><label style="display:flex; align-items:center; justify-content:space-between; gap:6px; white-space:nowrap;"><span>T. Cambio</span>
              <button type="button" class="btn-tc-dia" onclick="window._cmTC(true, this)">⟳ Del día</button></label>
              <input type="number" id="cmTC" step="0.0001" min="0" oninput="window._cmRecalc()"></div>
            <div class="form-group" style="margin:0;"><label>Importe recibido <span id="cmMonCta"></span> *</label>
              <input type="number" id="cmImporte" step="0.01" min="0" oninput="window._cmRecalc()" style="text-align:right; font-weight:700;"></div>
          </div>
        </div>
        <div style="padding-top:12px; border-top:1px solid var(--border-color);">
          <div style="display:flex; justify-content:space-between; align-items:center; gap:10px; flex-wrap:wrap;">
            ${sec('3. Documentos pendientes (más antiguo primero)')}
            <div style="display:flex; gap:8px;">
              <button type="button" class="btn btn-small btn-primary" onclick="window._cmDistribuir()" title="Reparte el importe recibido: cancela los más antiguos y deja parcial el siguiente">⚡ Distribuir por antigüedad</button>
              <button type="button" class="btn btn-small btn-secondary" onclick="window._cmLimpiar()">Limpiar</button>
            </div>
          </div>
          <div style="border:1px solid var(--border-color); border-radius:var(--radius-md); overflow:auto; max-height:380px;">
            <table style="width:100%; border-collapse:collapse; margin:0; font-size:0.85rem;">
              <thead><tr style="background:var(--bg-secondary); position:sticky; top:0; z-index:1;">
                <th style="width:34px;"></th><th style="text-align:left; padding:7px;">Documento</th><th style="text-align:left; padding:7px;">Vence</th>
                <th style="text-align:right; padding:7px;">Atraso</th><th style="text-align:center; padding:7px;">Mon.</th><th style="text-align:right; padding:7px;">Saldo</th>
                <th style="text-align:right; padding:7px;" id="cmThRet">Retención</th><th style="text-align:right; padding:7px; width:150px;">Aplicar</th>
                <th style="text-align:right; padding:7px;">Equivale (<span id="cmMonCta2"></span>)</th><th style="text-align:center; padding:7px;">Resultado</th>
              </tr></thead>
              <tbody id="cmFilas"></tbody>
            </table>
          </div>
        </div>
        <div id="cmResumen" style="display:grid; grid-template-columns:repeat(auto-fit, minmax(150px, 1fr)); gap:10px; padding:12px; background:var(--bg-secondary); border-radius:var(--radius-md);"></div>
        <div class="form-group" style="margin:0;"><label>Observaciones</label><input type="text" id="cmObs" placeholder="Opcional"></div>
        <div>
          ${sec('Archivos adjuntos')}
          <input type="file" id="cmasArchivo" multiple accept=".pdf,.jpg,.jpeg,.png,.webp,application/pdf,image/jpeg,image/png,image/webp" onchange="window._adjSeleccionar('cmas')">
          <small style="color:var(--text-secondary); font-size:0.72rem;">Voucher del depósito / recibo (se guardan en el primer cobro del lote).</small>
          <div id="cmas-adj-lista" style="display:flex; flex-direction:column; gap:6px; margin-top:6px;"></div>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn" onclick="window.closeModal('modal-cobro-masivo')">Cancelar</button>
        <button class="btn btn-primary" id="cmBtnOk" onclick="window.conCarga(this, window.confirmarCobroMasivo)">💾 Registrar cobro masivo</button>
      </div>
    </div>
  </div>`)
}

// ── Abrir ────────────────────────────────────────────────────────────────────
window.abrirCobroMasivo = async function (contactId = null) {
  if (!C) return
  await C.cargar()
  const cxc = C.cxc().filter(c => c.estado !== 'anulado' && C.saldoCxC(c) > 0.009)
  const letras = C.letras().filter(l => l.tipo === 'emitida' && C.letraAbierta(l) && C.saldoLetra(l) > 0.005)
  const ids = [...new Set([...cxc.map(c => c.contact_id), ...letras.map(l => l.contact_id)])]
  const opts = ids.map(id => ({ id, n: C.nombre(id) })).sort((a, b) => a.n.localeCompare(b.n, 'es'))
  $('cmCliente').innerHTML = '<option value="">-- Selecciona el cliente --</option>' + opts.map(o => `<option value="${o.id}">${_esc(o.n)}</option>`).join('')
  $('cmCliente').value = contactId || ''
  C.refrescarBuscador?.('cmCliente')
  $('cmBanco').innerHTML = '<option value="">-- Selecciona --</option>' + C.bancos().map(b => `<option value="${b.id}">${_esc(b.nombre)} — ${_esc(b.numero_cuenta || '')} (${b.moneda || ''})</option>`).join('')
  $('cmFecha').value = _hoy()
  for (const k of ['cmNumOp', 'cmRecibo', 'cmImporte', 'cmObs']) $(k).value = ''
  $('cmTC').value = ''
  C.limpiarAdjuntos('cmas')
  _st = { contactId: null, filas: [] }
  window._cmCambioCliente()
  window.openModal('modal-cobro-masivo')
  window._cmTC(false)
}

window._cmCambioCliente = function () {
  const id = parseInt($('cmCliente').value || 0) || null
  _st.contactId = id
  const ct = id ? C.contacto(id) : null
  const sujeto = !!ct?.sujeto_retencion
  $('cmRetWrap').style.display = sujeto ? 'flex' : 'none'
  $('cmThRet').style.display = sujeto ? '' : 'none'
  // Filas: facturas con saldo + letras en cartera (no en banco: esas las cobra el banco)
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
  window._cmCambioCuenta(true)
}

window._cmCambioCuenta = function (soloPintar = false) {
  const mon = C.monedaBanco($('cmBanco').value) || (_st?.filas?.[0]?.moneda) || 'PEN'
  $('cmMonCta').textContent = `(${mon})`
  $('cmMonCta2').textContent = mon
  if (!soloPintar) window._cmTC(false)
  window._cmPintar()
}

/** T.C. de venta del día del cobro (tabla de T.C.). forzar = botón ⟳. */
window._cmTC = async function (forzar = false, btn = null) {
  const f = $('cmFecha').value
  if (!f) { if (forzar) showToast('Ingresa la fecha de cobro', 'warning'); return }
  if (!forzar && parseFloat($('cmTC').value) > 0) return window._cmRecalc()
  const txt = btn?.textContent
  if (btn) { btn.disabled = true; btn.textContent = '⟳ …' }
  try {
    const r = await getTipoCambioDia(f, { permitirApi: false })
    if (r?.venta > 0) { $('cmTC').value = r.venta; if (btn) showToast(`T.C. venta ${fechaDMY(f)}: ${r.venta}`, 'success', 2200) }
    else if (forzar) showToast(`No hay T.C. registrado para el ${fechaDMY(f)}`, 'warning')
  } catch (e) { if (forzar) showToast('No se pudo consultar el T.C.: ' + e.message, 'danger') }
  finally { if (btn) { btn.disabled = false; btn.textContent = txt } }
  window._cmRecalc()
}

// ── Conversión documento ↔ cuenta ────────────────────────────────────────────
const _monCta = () => C.monedaBanco($('cmBanco').value) || _st.filas[0]?.moneda || 'PEN'
const _tc = () => parseFloat($('cmTC').value) || 0
const _aCta = (monto, mon) => _r2(C.conv(monto, mon, _monCta(), _tc()))
const _aDoc = (monto, mon) => _r2(C.conv(monto, _monCta(), mon, _tc()))
const _filasVisibles = () => _st.filas.filter(f => f.tipo === 'factura' || $('cmLetras').checked)
const _retAplicada = f => ($('cmRet').checked && $('cmRetWrap').style.display !== 'none') ? f.ret : 0
const _maxAplicable = f => _r2(f.saldo - _retAplicada(f))

window._cmPintar = function () {
  if (!_st) return
  const tb = $('cmFilas')
  const vis = _filasVisibles()
  const sujeto = $('cmRetWrap').style.display !== 'none'
  const hoy = $('cmFecha').value || _hoy()
  if (!_st.contactId) { tb.innerHTML = '<tr><td colspan="10" style="text-align:center; padding:16px; color:var(--text-secondary);">Elige el cliente.</td></tr>'; window._cmRecalc(); return }
  if (!vis.length) { tb.innerHTML = '<tr><td colspan="10" style="text-align:center; padding:16px; color:var(--text-secondary);">Sin documentos pendientes.</td></tr>'; window._cmRecalc(); return }
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
      <td style="padding:6px 7px; text-align:right;" id="cmEq-${f.k}"></td>
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
    // Marca: aplica lo que falta del depósito (o el saldo completo si no hay importe)
    const recibido = _r2($('cmImporte').value)
    const usado = _filasVisibles().filter(x => x.k !== k).reduce((s, x) => s + _aCta(x.aplicar, x.moneda), 0)
    const resta = recibido > 0 ? Math.max(0, _r2(recibido - usado)) : Infinity
    f.aplicar = Math.min(_maxAplicable(f), resta === Infinity ? _maxAplicable(f) : _aDoc(resta, f.moneda))
  } else f.aplicar = 0
  const inp = $(`cmAp-${k}`); if (inp) inp.value = f.aplicar ? f.aplicar.toFixed(2) : ''
  window._cmRecalc()
}
window._cmRetGlobal = function () { window._cmPintar() }
window._cmLimpiar = function () { _st.filas.forEach(f => { f.aplicar = 0 }); window._cmPintar() }

/** FIFO: cancela los más antiguos y deja parcial el siguiente. */
window._cmDistribuir = function () {
  let resta = _r2($('cmImporte').value)
  if (!(resta > 0)) { showToast('Ingresa el importe recibido', 'warning'); return }
  if (_st.filas.some(f => f.moneda !== _monCta()) && !(_tc() > 0)) { showToast('Ingresa el T.C. (hay documentos en otra moneda)', 'warning'); return }
  _st.filas.forEach(f => { f.aplicar = 0 })
  for (const f of _filasVisibles()) {
    if (resta <= 0.004) break
    const max = _maxAplicable(f)
    const necesita = _aCta(max, f.moneda)
    if (resta >= necesita - 0.004) { f.aplicar = max; resta = _r2(resta - necesita) }
    else { f.aplicar = Math.min(max, _aDoc(resta, f.moneda)); resta = 0 }
  }
  window._cmPintar()
  if (resta > 0.004) showToast(`Sobran ${_monCta()} ${formatNumber(resta)}: el depósito es mayor que toda la deuda seleccionada`, 'warning', 6000)
}

window._cmRecalc = function () {
  if (!_st) return
  const mon = _monCta()
  const recibido = _r2($('cmImporte').value)
  let aplicado = 0, cancelados = 0, parciales = 0, retTot = 0
  for (const f of _filasVisibles()) {
    const eq = _aCta(f.aplicar, f.moneda)
    aplicado = _r2(aplicado + eq)
    const r = _retAplicada(f) && f.aplicar > 0 ? f.ret : 0
    retTot = _r2(retTot + r)
    const queda = _r2(f.saldo - f.aplicar - r)
    const eqTd = $(`cmEq-${f.k}`); if (eqTd) eqTd.textContent = f.aplicar ? formatNumber(eq) : '—'
    const res = $(`cmRes-${f.k}`)
    if (res) res.innerHTML = !f.aplicar ? '<span style="color:var(--text-secondary);">—</span>'
      : queda <= 0.009 ? '<span class="badge badge-success">Cancela</span>'
      : `<span class="badge badge-warning" title="Queda ${formatNumber(queda)}">Parcial · queda ${formatNumber(queda)}</span>`
    if (f.aplicar > 0) { if (queda <= 0.009) cancelados++; else parciales++ }
    if (f.aplicar > _maxAplicable(f) + 0.009) { const i = $(`cmAp-${f.k}`); if (i) i.style.borderColor = 'var(--color-danger)' }
    else { const i = $(`cmAp-${f.k}`); if (i) i.style.borderColor = '' }
  }
  const dif = _r2(recibido - aplicado)
  const tol = _st.filas.some(f => f.aplicar > 0 && f.moneda !== mon) ? 0.05 : 0.009
  const caja = (t, v, st = '') => `<div><div style="font-size:0.7rem; text-transform:uppercase; letter-spacing:.4px; color:var(--text-secondary);">${t}</div><div style="font-weight:700; font-size:1.02rem;${st}">${v}</div></div>`
  $('cmResumen').innerHTML =
    caja('Recibido', `${mon} ${formatNumber(recibido)}`) +
    caja('Aplicado', `${mon} ${formatNumber(aplicado)}`) +
    caja(Math.abs(dif) <= tol ? 'Cuadra ✔' : (dif > 0 ? 'Sobrante sin aplicar' : 'Excede lo recibido'), `${mon} ${formatNumber(dif)}`, ` color:${Math.abs(dif) <= tol ? 'var(--color-success)' : 'var(--color-danger)'};`) +
    caja('Cancelados / parciales', `${cancelados} / ${parciales}`) +
    (retTot ? caja('Retención IGV', formatNumber(retTot), ' color:var(--color-warning);') : '')
  const btn = $('cmBtnOk')
  if (btn && !btn.classList.contains('btn-cargando')) btn.disabled = !(recibido > 0) || aplicado <= 0 || Math.abs(dif) > tol
}

// ── Confirmar ────────────────────────────────────────────────────────────────
window.confirmarCobroMasivo = async function () {
  if (!_st?.contactId) { showToast('Elige el cliente', 'warning'); return }
  const fecha = $('cmFecha').value, bancoId = parseInt($('cmBanco').value || 0)
  const recibido = _r2($('cmImporte').value), mon = _monCta(), tc = _tc()
  const numOp = $('cmNumOp').value.trim() || null, recibo = $('cmRecibo').value.trim() || null
  const medio = $('cmMedio').value, obs = $('cmObs').value.trim() || null
  const sel = _filasVisibles().filter(f => f.aplicar > 0)
  if (!fecha) { showToast('Ingresa la fecha de cobro', 'warning'); return }
  if (!bancoId) { showToast('Elige la cuenta donde entró el dinero', 'warning'); return }
  if (!(recibido > 0)) { showToast('Ingresa el importe recibido', 'warning'); return }
  if (!sel.length) { showToast('Aplica el importe a al menos un documento (⚡ Distribuir)', 'warning'); return }
  if (sel.some(f => f.moneda === 'USD' || f.moneda !== mon) && !(tc > 0)) { showToast('Ingresa el T.C. del día', 'warning'); return }
  for (const f of sel) if (f.aplicar > _maxAplicable(f) + 0.009) { showToast(`${f.doc}: lo aplicado supera su saldo (${formatNumber(_maxAplicable(f))})`, 'warning'); return }
  const aplicado = _r2(sel.reduce((s, f) => s + _aCta(f.aplicar, f.moneda), 0))
  const tol = sel.some(f => f.moneda !== mon) ? 0.05 : 0.009
  if (Math.abs(recibido - aplicado) > tol) { showToast(`No cuadra: recibido ${formatNumber(recibido)} vs aplicado ${formatNumber(aplicado)}`, 'warning'); return }
  if (!(await C.reciboLibre(recibo, _st.contactId))) return
  const resumen = sel.map(f => {
    const r = _retAplicada(f), queda = _r2(f.saldo - f.aplicar - r)
    return `• ${f.doc}: ${f.moneda} ${formatNumber(f.aplicar)}${r ? ` + ret. ${formatNumber(r)}` : ''} → ${queda <= 0.009 ? 'CANCELA' : 'parcial, queda ' + formatNumber(queda)}`
  }).join('\n')
  if (!confirm(`Cobro masivo — ${C.nombre(_st.contactId)}\nDepósito ${mon} ${formatNumber(recibido)} el ${fechaDMY(fecha)}${numOp ? ` · Op. ${numOp}` : ''}${recibo ? ` · Recibo ${recibo}` : ''}\n\n${resumen}\n\n¿Registrar?`)) return

  const user = getCurrentUser()
  let lote
  try {
    lote = await _sb(supabase.from('cobros_lote').insert({
      contact_id: _st.contactId, fecha, banco_id: bancoId, moneda: mon, tipo_cambio: tc || null, monto_recibido: recibido,
      monto_aplicado: aplicado, medio_pago: medio, numero_operacion: numOp, numero_recibo: recibo, observaciones: obs, created_by: user?.db_id || null
    }).select().single())
  } catch (e) { showToast('Error: ' + e.message, 'danger', 9000); return }

  const hechos = [], errores = []
  let primerCobroId = null
  for (const f of sel) {
    try {
      if (f.tipo === 'factura') {
        const cxc = f.obj
        const tcDoc = f.moneda === 'PEN' && mon === 'PEN' ? 1 : (tc || parseFloat(cxc.tipo_cambio) || 1)
        const cobro = await addCobro({
          numero_recibo: recibo, cxc_id: cxc.id, contact_id: cxc.contact_id, fecha, monto: f.aplicar,
          moneda: f.moneda, tipo_cambio: tcDoc, medio_pago: medio, referencia: numOp || `Cobro masivo L${lote.id}`,
          banco_id: bancoId, numero_operacion: numOp, monto_retencion: _retAplicada(f), lote_id: lote.id
        })
        if (!cobro?.id) throw new Error('no se pudo crear el cobro (¿falta el SQL 83?)')
        primerCobroId ||= cobro.id
        await C.aplicarEfectosCobro(cobro, cxc, { sinMov: true })
      } else {
        await C.registrarAbonoLetra(f.obj, {
          ubicacion: 'cartera', medio, bancoId, fecha, numOp, recibo, tcDia: tc || parseFloat(f.obj.tipo_cambio) || 1,
          amort: f.aplicar, interes: 0, portes: 0, comision: 0, otros: 0, obs: `Cobro masivo L${lote.id}`, sinMov: true, loteId: lote.id
        })
      }
      hechos.push(f.doc)
    } catch (e) { console.error('cobro masivo', f.doc, e); errores.push(`${f.doc}: ${e.message}`) }
  }
  // UN solo movimiento bancario por el depósito
  let mov = null
  if (hechos.length) {
    mov = await C.registrarMov({
      bancoId, tipo: 'ingreso', fecha, categoria: 'Cobranza clientes',
      concepto: `Depósito ${C.nombre(_st.contactId)} — cobro masivo L${lote.id} (${hechos.length} doc.)${recibo ? ` Rec. ${recibo}` : ''}`,
      referencia: numOp || `LOTE-COBRO ${lote.id}`, numeroOperacion: numOp, monto: recibido, monedaMonto: mon, tc: tc || 1
    })
    await supabase.from('cobros_lote').update({ movimiento_banco_id: mov?.id || null }).eq('id', lote.id)
    if (primerCobroId) await C.subirAdjuntos('cmas', 'cobro', primerCobroId)
  } else {
    await supabase.from('cobros_lote').delete().eq('id', lote.id)
  }
  window.closeModal('modal-cobro-masivo')
  if (errores.length) showToast(`⚠️ Lote L${lote.id}: ${hechos.length} aplicado(s), ${errores.length} con error — ${errores.join(' · ')}. Revisa y usa "Deshacer cobro masivo" si hace falta.`, 'danger', 15000)
  else showToast(`Cobro masivo L${lote.id} ✅ — ${hechos.length} documento(s)${mov?.id ? ` · ${C.numMB(mov.id)}` : ''}`, 'success', 7000)
  await C.refrescar()
}

// ── Deshacer (lote completo) ─────────────────────────────────────────────────
window.deshacerCobroMasivo = async function (loteId) {
  try {
    const lote = await _sb(supabase.from('cobros_lote').select('*').eq('id', loteId).single())
    const cobros = await _sb(supabase.from('cobros').select('*').eq('lote_id', loteId))
    const abonos = await _sb(supabase.from('letras_abonos').select('*').eq('lote_id', loteId))
    const docs = [...cobros.map(c => C.descDoc(C.cxc().find(x => x.id === c.cxc_id) || {}) || `cobro #${c.id}`), ...abonos.map(a => `letra #${a.letra_id}`)]
    if (!confirm(`Deshacer el cobro masivo L${loteId} (${fechaDMY(lote.fecha)}, ${lote.moneda} ${formatNumber(lote.monto_recibido)}):\n• ${docs.join('\n• ')}\n\nSe revierten los cobros/abonos, sus asientos, la imputación a cuotas y el movimiento bancario.\n¿Continuar?`)) return
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
    const mov = lote.movimiento_banco_id ? await C.movPorId(lote.movimiento_banco_id) : null
    if (mov) await C.eliminarMovYSaldo(mov)
    await supabase.from('cobros_lote').delete().eq('id', loteId)
    window.closeModal?.('modal-detalle-cp')
    showToast(`Cobro masivo L${loteId} deshecho ✅${avisos.length ? ' — ⚠️ ' + avisos.join('; ') : ''}`, avisos.length ? 'warning' : 'success', 8000)
    await C.refrescar()
  } catch (e) { console.error('deshacerCobroMasivo:', e); showToast('Error: ' + e.message, 'danger', 9000) }
}

/** Sección "📦 Cobro masivo" para Ver detalle de un cobro que pertenece a un lote. */
export async function htmlSeccionLote(loteId) {
  try {
    const lote = await _sb(supabase.from('cobros_lote').select('*').eq('id', loteId).single())
    const cobros = await _sb(supabase.from('cobros').select('id, cxc_id, monto, moneda, monto_retencion').eq('lote_id', loteId))
    const abonos = await _sb(supabase.from('letras_abonos').select('id, letra_id, monto_amortizado, moneda').eq('lote_id', loteId))
    const filas = [
      ...cobros.map(c => { const d = C.cxc().find(x => x.id === c.cxc_id); return `<tr><td>${_esc(d ? C.descDoc(d) : 'cobro #' + c.id)}</td><td>${c.moneda}</td><td style="text-align:right;">${formatNumber(c.monto)}</td><td style="text-align:right;">${parseFloat(c.monto_retencion) ? formatNumber(c.monto_retencion) : '—'}</td></tr>` }),
      ...abonos.map(a => { const l = C.letras().find(x => x.id === a.letra_id); return `<tr><td>Letra ${_esc(l?.numero_letra || '#' + a.letra_id)}</td><td>${a.moneda || ''}</td><td style="text-align:right;">${formatNumber(a.monto_amortizado)}</td><td>—</td></tr>` })
    ].join('')
    return `<h4 style="margin:16px 0 6px;">📦 Cobro masivo L${lote.id} — depósito ${lote.moneda} ${formatNumber(lote.monto_recibido)} (${fechaDMY(lote.fecha)})</h4>
      <div style="font-size:0.82rem; color:var(--text-secondary); margin-bottom:6px;">Este cobro es parte de un depósito aplicado a varios documentos. Se edita o elimina deshaciendo el lote completo.</div>
      <div style="border:1px solid var(--border-color); border-radius:var(--radius-md); overflow-x:auto;"><table style="width:100%; border-collapse:collapse; margin:0;">
        <thead><tr style="background:var(--bg-secondary);"><th>Documento</th><th>Mon.</th><th style="text-align:right;">Aplicado</th><th style="text-align:right;">Retención</th></tr></thead><tbody>${filas}</tbody></table></div>
      <button class="btn btn-danger btn-small" style="margin-top:8px;" onclick="window.deshacerCobroMasivo(${lote.id})">↩ Deshacer cobro masivo</button>`
  } catch (e) { return `<p style="color:var(--color-danger);">${_esc(e.message)}</p>` }
}
