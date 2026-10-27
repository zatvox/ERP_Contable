// ============================================================================
// boletin-modal.js — Boletín químico (Liquidación de Cobranza de SUNAT) 2026-10-26
// ----------------------------------------------------------------------------
// El boletín químico NO es un tributo de la DAM: es una "Liquidación de Cobranza"
// aparte (tipo 0026 Autoliquidación-Tributos, concepto 0031) que se paga en soles
// días después de numerar la DAM. Este modal copia los campos de esa liquidación
// (consulta SUNAT «Detalle de una Liquidación») y la lleva al costeo:
//   documentos_importacion (tipo liquidacion_sunat) + importacion_costos
//   (concepto boletin_quimico · PEN · inventario → costo NIC 2 y de gestión ·
//   prorrateo por peso bruto). No requiere SQL nuevo; los datos propios de la
//   liquidación (recepción, CDA, tipo L/C, sustento) van en observaciones.
// Uso: window.abrirBoletinQuimico(costoId?)  — sin id = registrar; con id = ver/editar.
// ============================================================================
import { query, update, ultimoErrorInsert, esperarContextoEmpresa } from '../supabase-client.js'
import { getCurrentUser } from '../auth-supabase.js'
import { showToast, formatNumber, fechaDMY } from '../helpers.js'
import { aplicarModoVerEditar } from '../shared/ver-editar.js'
import { declararEmpresaModal } from '../empresa.js'
import { getTipoCambioDia } from '../sunat-api.js'
import { crearLineaCosto, conceptoPorCodigo } from './costos-ledger.js'

const $ = id => document.getElementById(id)
const v = id => ($(id)?.value ?? '').toString().trim()
const num = x => { const n = parseFloat(String(x ?? '').replace(/,/g, '')); return isNaN(n) ? null : n }
const n0 = x => num(x) || 0
const n2 = x => formatNumber(n0(x), 2)
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const carpeta = () => window.carpetaActual || null
const ciActual = () => window.costeoActual?.id ? window.costeoActual : null

let _dam = null, _costo = null, _doc = null

// ── observaciones ⇄ campos propios de la liquidación ──────────────────────────
const ETQ = { rec: 'Recepción', cda: 'CDA', tipo: 'Tipo L/C', sus: 'Sustento', liq: 'Liquidado' }
const _packObs = () => Object.entries(ETQ).map(([k, e]) => `${e}: ${v({ rec: 'bqRecepcion', cda: 'bqCDA', tipo: 'bqTipoLC', sus: 'bqSustento', liq: 'bqFechaLiq' }[k])}`).join(' | ')
function _unpackObs(txt) {
  const o = {}; for (const parte of String(txt || '').split(' | ')) { const i = parte.indexOf(': '); if (i > 0) o[parte.slice(0, i)] = parte.slice(i + 2) }
  return { rec: o[ETQ.rec] || '', cda: o[ETQ.cda] || '', tipo: o[ETQ.tipo] || '', sus: o[ETQ.sus] || '', liq: o[ETQ.liq] || '' }
}

function _asegurarModal() {
  if ($('modal-dam-boletin')) return
  document.body.insertAdjacentHTML('beforeend', `
  <div id="modal-dam-boletin" class="modal">
    <div class="modal-content" style="width:min(96vw, 860px); max-width:min(96vw, 860px); max-height:calc(100vh - 48px); overflow-y:auto;">
      <div class="modal-header">
        <h3 class="modal-title" id="bqTitulo">Boletín químico</h3>
        <button class="modal-close" onclick="window.cerrarBoletinQuimico()">&times;</button>
      </div>
      <div style="padding:6px 20px 0;">
        <div class="costeo-selector dm-carpeta"><label>Carpeta:</label><select id="bqCarpeta" disabled></select></div>
        <div class="dm-explica">🧪 El boletín químico es una <b>Liquidación de Cobranza</b> aparte de la DAM (se paga en soles). Cópiala de SUNAT → «Detalle de una Liquidación». Al guardar entra al costeo como costo de la mercadería.</div>

        <strong class="mod-sec">Liquidación de cobranza <small style="text-transform:none; letter-spacing:0; font-weight:400;">(consulta SUNAT)</small></strong>
        <div style="display:grid; grid-template-columns:repeat(4, 1fr); gap:10px;">
          <div class="form-group"><label>N° de liquidación * <span class="bl-en">(Número de Liquidación)</span></label><input type="text" id="bqNumero" maxlength="40" placeholder="118-324755-26"></div>
          <div class="form-group"><label>N° de recepción <span class="bl-en">(Número de Recepción)</span></label><input type="text" id="bqRecepcion" maxlength="40" placeholder="26-003330"></div>
          <div class="form-group" style="grid-column:span 2;"><label>C.D.A. <span class="bl-en">(C.D.A.)</span></label><input type="text" id="bqCDA" maxlength="60" placeholder="118-26-10-436155-99-8-02"></div>
          <div class="form-group" style="grid-column:span 2;"><label>Tipo de liquidación <span class="bl-en">(Tipo L/C)</span></label><input type="text" id="bqTipoLC" maxlength="60" value="0026 AUTOLIQUIDACION-TRIBUTOS"></div>
          <div class="form-group" style="grid-column:span 2;"><label>Concepto <span class="bl-en">(Código · Descripción)</span></label><input type="text" id="bqConcepto" value="0031 · BOLETIN QUIMICO" disabled></div>
          <div class="form-group" style="grid-column:span 4;"><label>Sustento <span class="bl-en">(Sustento)</span></label><input type="text" id="bqSustento" maxlength="160" placeholder="BOLETIN QUIMICO DAM: 118-2026-10-… DE FECHA: dd/mm/aaaa"></div>
        </div>

        <strong class="mod-sec">Fechas e importe</strong>
        <div style="display:grid; grid-template-columns:repeat(4, 1fr); gap:10px;">
          <div class="form-group"><label>Fecha de liquidación * <span class="bl-en">(Liquidado)</span></label><input type="date" id="bqFechaLiq" oninput="window.bqCruces()"></div>
          <div class="form-group"><label>Fecha de cancelación * <span class="bl-en">(Cancelado)</span></label><input type="date" id="bqFechaPago" onchange="window.bqTC(); window.bqCruces()"></div>
          <div class="form-group"><label>Total S/ * <span class="bl-en">(Total Liquidado en SOLES)</span></label><input type="number" id="bqMonto" step="0.01" oninput="window.bqRecalcular()"></div>
          <div class="form-group"><label>T.C. venta SUNAT <button type="button" class="btn btn-secondary btn-small" data-solo-edicion onclick="window.bqTC(true)" title="Consultar T.C. de la fecha de cancelación">⟳</button></label><input type="number" id="bqTC" step="0.001" oninput="window.bqRecalcular()"></div>
        </div>
        <div class="dm-nota" id="bqDestino" style="margin-top:6px;"></div>

        <strong class="mod-sec">Cruces automáticos <small style="text-transform:none; letter-spacing:0; font-weight:400;">(boletín contra la DAM)</small></strong>
        <div id="bqCruces" style="margin-bottom:10px;"></div>
        <div class="dm-nota">📎 Adjunta el PDF desde «Documentos de la carpeta» (tipo: Boletín químico).
          <button type="button" class="btn btn-secondary btn-small" onclick="window.abrirAdjuntosCarpeta?.()">Abrir documentos</button></div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" data-solo-lectura onclick="window.cerrarBoletinQuimico()">Cerrar</button>
        <button class="btn btn-primary" data-solo-lectura onclick="window.bqEditar()">✏️ Editar</button>
        <button class="btn btn-secondary" data-solo-edicion onclick="window.bqCancelar()">Cancelar</button>
        <button class="btn btn-primary" data-solo-edicion onclick="window.guardarBoletinQuimico()">💾 Guardar boletín</button>
      </div>
    </div>
  </div>`)
}

function _volcar() {
  const c = _costo, d = _doc
  const o = _unpackObs(d?.observaciones)
  $('bqNumero').value = d?.numero || ''
  $('bqRecepcion').value = o.rec; $('bqCDA').value = o.cda
  $('bqTipoLC').value = o.tipo || '0026 AUTOLIQUIDACION-TRIBUTOS'
  $('bqSustento').value = c ? o.sus : (_dam ? `BOLETIN QUIMICO DAM: ${_dam.numero_dam} DE FECHA: ${fechaDMY(_dam.fecha_dam)}` : '')
  $('bqFechaLiq').value = o.liq || ''
  $('bqFechaPago').value = d?.fecha_emision || ''
  $('bqMonto').value = c ? n0(c.monto_moneda) : ''
  $('bqTC').value = c ? n0(c.tipo_cambio).toFixed(3) : (_dam?.tipo_cambio ? n0(_dam.tipo_cambio).toFixed(3) : '')
  window.bqRecalcular()
}

window.bqRecalcular = function () {
  const m = n0(v('bqMonto')), tc = n0(v('bqTC'))
  const cc = conceptoPorCodigo('boletin_quimico')
  $('bqDestino').innerHTML = m
    ? `Al guardar: <b>S/ ${n2(m)}</b>${tc >= 1 ? ` (≈ $ ${n2(m / tc)} al T.C. ${tc.toFixed(3)})` : ' · falta el T.C.'} → costo de la mercadería (NIC 2) y de gestión, prorrateado por <b>${cc?.base === 'peso_bruto' ? 'peso bruto' : (cc?.base || 'peso bruto')}</b>.`
    : ''
  window.bqCruces()
}

window.bqCruces = function () {
  const host = $('bqCruces'); if (!host) return
  const f = []
  const fila = (ok, txt, nota) => f.push(`<div class="dm-cruce ${ok ? 'ok' : 'warn'}"><span class="dm-cruce-ico">${ok ? '✔' : '⚠'}</span><div>${txt}${!ok && nota ? `<div class="dm-nota">${nota}</div>` : ''}</div></div>`)
  if (!_dam) { host.innerHTML = '<div class="dm-nota">Registra primero la DAM de la carpeta para poder cruzar.</div>'; return }
  const sus = v('bqSustento')
  if (sus) fila(sus.includes(_dam.numero_dam), `<b>Sustento</b> · menciona la DAM ${esc(_dam.numero_dam)}`, `El sustento no cita la DAM de esta carpeta (${esc(_dam.numero_dam)}): verifica que el boletín sea de esta importación.`)
  const fl = v('bqFechaLiq'), fp = v('bqFechaPago')
  if (fl && _dam.fecha_dam) fila(fl >= _dam.fecha_dam, `<b>Fecha de liquidación</b> · ${fechaDMY(fl)} · DAM ${fechaDMY(_dam.fecha_dam)}`, 'La liquidación no puede ser anterior a la numeración de la DAM.')
  if (fl && fp) fila(fp >= fl, `<b>Fecha de cancelación</b> · ${fechaDMY(fp)} · liquidación ${fechaDMY(fl)}`, 'La cancelación no puede ser anterior a la liquidación.')
  host.innerHTML = f.join('') || '<div class="dm-nota">Llena los datos para ver los cruces.</div>'
}

window.bqTC = async function (forzar) {
  const f = v('bqFechaPago'); if (!f) { if (forzar === true) showToast('Indica la fecha de cancelación', 'warning'); return }
  if (!forzar && v('bqTC')) return
  try {
    const r = await getTipoCambioDia(f, { permitirApi: forzar === true })
    if (r?.venta) { $('bqTC').value = Number(r.venta).toFixed(3); window.bqRecalcular() }
    else if (forzar === true) showToast(r?.error || 'Sin T.C. para esa fecha', 'warning')
  } catch { if (forzar === true) showToast('No se pudo consultar el T.C.', 'danger') }
}

window.abrirBoletinQuimico = async function (costoId) {
  try {
    await esperarContextoEmpresa()
    const ci = ciActual(), c = carpeta()
    if (!ci || !c) { showToast('Abre primero una carpeta con Commercial Invoice', 'warning'); return }
    _dam = ((await query('dams', { importacion_id: ci.id })) || [])[0] || null
    if (!_dam) { showToast('Primero registra la DAM de la carpeta (el boletín se sustenta en ella)', 'warning'); return }
    _asegurarModal()
    _costo = costoId ? ((await query('importacion_costos', { id: costoId })) || [])[0] || null : null
    _doc = _costo?.documento_id ? ((await query('documentos_importacion', { id: _costo.documento_id })) || [])[0] || null : null
    const selC = document.getElementById('costeoSelector')
    $('bqCarpeta').innerHTML = `<option>${esc(selC?.selectedOptions?.[0]?.text || c.numero_carpeta || '')}</option>`
    $('bqTitulo').textContent = _doc ? `Boletín químico ${_doc.numero || ''}` : 'Registrar boletín químico'
    declararEmpresaModal('modal-dam-boletin', c.empresa_id)
    _volcar()
    aplicarModoVerEditar('modal-dam-boletin', !!_costo)
    window.openModal('modal-dam-boletin')
  } catch (e) { console.error('abrirBoletinQuimico:', e); showToast('No se pudo abrir el boletín químico', 'danger') }
}
window.bqEditar = () => aplicarModoVerEditar('modal-dam-boletin', false)
window.bqCancelar = () => { if (_costo) { _volcar(); aplicarModoVerEditar('modal-dam-boletin', true) } else window.cerrarBoletinQuimico() }
window.cerrarBoletinQuimico = () => { window.closeModal('modal-dam-boletin'); window.renderHojaCosteo?.(); window.renderCostosLedger?.() }

window.guardarBoletinQuimico = async function () {
  try {
    const c = carpeta(); if (!c || !_dam) throw new Error('Falta la carpeta o la DAM')
    const numero = v('bqNumero'), monto = n0(v('bqMonto')), tc = n0(v('bqTC'))
    if (!numero) throw new Error('Falta el N° de liquidación')
    if (!v('bqFechaLiq')) throw new Error('Falta la fecha de liquidación')
    if (!v('bqFechaPago')) throw new Error('Falta la fecha de cancelación')
    if (v('bqFechaPago') < v('bqFechaLiq')) throw new Error('La cancelación no puede ser anterior a la liquidación')
    if (v('bqFechaLiq') < _dam.fecha_dam) throw new Error('La liquidación no puede ser anterior a la numeración de la DAM')
    if (monto <= 0) throw new Error('Ingresa el total liquidado en soles')
    if (!(tc >= 1 && tc <= 10)) throw new Error('Ingresa el T.C. venta SUNAT de la fecha de cancelación (usa ⟳)')

    const user = await getCurrentUser()
    const datosDoc = { numero, fecha_emision: v('bqFechaPago'), moneda: 'PEN', tipo_cambio: tc, monto_sin_igv: monto, igv_monto: 0, monto_total: monto, observaciones: _packObs() }

    if (_costo) {                                   // ── editar
      const okD = _doc ? await update('documentos_importacion', _doc.id, datosDoc) : true
      const okC = await update('importacion_costos', _costo.id, { moneda: 'PEN', tipo_cambio: tc, monto_moneda: monto, observaciones: `Boletín químico · liquidación ${numero}` })
      if (!okD || !okC) throw new Error(ultimoErrorInsert()?.message || 'No se pudo actualizar el boletín')
      showToast('Boletín actualizado', 'success')
    } else {                                        // ── nuevo (sin duplicar la liquidación)
      const previos = ((await query('documentos_importacion', { numero, tipo: 'liquidacion_sunat' })) || []).filter(d => !d.empresa_id || !c.empresa_id || d.empresa_id === c.empresa_id)
      if (previos.length) throw new Error(`La liquidación ${numero} ya está registrada en el costeo`)
      const cc = conceptoPorCodigo('boletin_quimico')
      const doc = { tipo: 'liquidacion_sunat', tipo_comprobante: '50', proveedor_id: null, ...datosDoc, estado_pago: 'pagado', es_provisional: false, sustentado: true, empresa_id: c.empresa_id ?? undefined }
      const linea = {
        carpeta_importacion_id: c.id, grupo: cc?.grupo || 'despacho', concepto: 'Boletín químico SUNAT', concepto_codigo: 'boletin_quimico',
        clasificacion: cc?.clasificacion || 'inventario', moneda: 'PEN', tipo_cambio: tc, monto_moneda: monto, igv_monto: 0,
        base_prorrateo: cc?.base || 'peso_bruto', es_provisional: false, observaciones: `Boletín químico · liquidación ${numero}`
      }
      await crearLineaCosto(doc, linea, user?.db_id)
      showToast('Boletín químico registrado en el costeo', 'success')
    }
    window.closeModal('modal-dam-boletin')
    window.renderHojaCosteo?.(); window.renderCostosLedger?.()
  } catch (e) { console.error('guardarBoletinQuimico:', e); showToast(e.message || 'No se pudo guardar el boletín', 'danger') }
}
