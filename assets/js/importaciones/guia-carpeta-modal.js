// ============================================================================
// guia-carpeta-modal.js — Guía de ingreso al almacén de una carpeta de importación
// ----------------------------------------------------------------------------
// Mismo flujo que Compras: se busca el Commercial Invoice (CI), se cargan solos la
// compra y sus guías de ingreso ya registradas, y se VINCULAN a la carpeta:
//   carpeta → guía de ingreso (guias_ingreso_compra.carpeta_importacion_id)
//           → lote (lotes.carpeta_importacion_id) → kardex (entrada del lote)
// Además guarda los datos reales del traslado (guias_remision, SQL 110):
// transportista, placa, conductor, contenedor, precinto, fecha de traslado.
// NO genera asientos ni mueve stock: la guía de ingreso ya lo hizo en Compras.
// Uso: window.abrirGuiaCarpeta() · lista de la pestaña: window.renderGuiasCarpeta()
// ============================================================================
import { query, insert, update, esperarContextoEmpresa, ultimoErrorInsert } from '../supabase-client.js'
import { getCurrentUser } from '../auth-supabase.js'
import { showToast, formatNumber, fechaDMY } from '../helpers.js'
import { declararEmpresaModal } from '../empresa.js'

const $ = id => document.getElementById(id)
const v = id => ($(id)?.value ?? '').toString().trim()
const num = x => { const n = parseFloat(String(x ?? '').replace(/,/g, '')); return isNaN(n) ? 0 : n }
const n0 = x => formatNumber(num(x), 0)
const n2 = x => formatNumber(num(x), 2)
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const carpeta = () => window.carpetaActual || null

let _ci = null          // CI elegido (por defecto el de la carpeta)
let _cis = []           // todos los CI (buscador)
let _compra = null
let _guias = []         // [{g, det:[{...detalle, lote, vendido}], remision}]

// ── datos ─────────────────────────────────────────────────────────────────────
async function _cargarGuias() {
  _guias = []
  if (!_compra) return
  const gs = ((await query('guias_ingreso_compra', { compra_id: _compra.id })) || []).sort((a, b) => a.id - b.id)
  for (const g of gs) {
    const det = (await query('detalle_guias_ingreso_compra', { guia_id: g.id })) || []
    for (const d of det) {
      d.lote = d.lote_id ? ((await query('lotes', { id: d.lote_id })) || [])[0] || null : null
      const kx = d.lote_id ? ((await query('kardex', { lote_id: d.lote_id })) || []) : []
      d.vendido = kx.filter(k => k.tipo_movimiento === 'salida' && !(num(k.cantidad_entrada) > 0)).reduce((t, k) => t + num(k.cantidad_salida), 0)   // salidas puras: los traslados entre ubicaciones traen entrada=salida
    }
    const remision = ((await query('guias_remision', { guia_ingreso_id: g.id })) || [])[0] || null
    _guias.push({ g, det, remision })
  }
}

async function _cargarCompra() {
  _compra = null
  if (!_ci) return
  const c = carpeta()
  const todas = (await query('compras', {})) || []
  const num_ = String(_ci.invoice_number || '').replace(/^INVOICE-?/i, '').toLowerCase()
  _compra = todas.find(x => x.carpeta_importacion_id === c?.id && !x.anulado)
    || todas.find(x => !x.anulado && String(x.numero || '').toLowerCase() === num_)
    || todas.find(x => !x.anulado && String(x.referencia || '').toLowerCase().includes(num_) && num_)
    || null
}

// ── modal ─────────────────────────────────────────────────────────────────────
function _asegurarModal() {
  if ($('modal-guia-carpeta')) return
  document.body.insertAdjacentHTML('beforeend', `
  <div id="modal-guia-carpeta" class="modal">
    <div class="modal-content" style="width:min(96vw, 980px); max-width:min(96vw, 980px); max-height:calc(100vh - 48px); overflow-y:auto;">
      <div class="modal-header"><h3 class="modal-title">Guía de ingreso al almacén</h3>
        <button class="modal-close" onclick="closeModal('modal-guia-carpeta')">&times;</button></div>
      <div style="padding:6px 20px 0;">
        <div class="costeo-selector dm-carpeta"><label>Carpeta:</label><select id="gcCarpeta" disabled></select></div>
        <div class="dm-explica">🔗 Busca el Commercial Invoice: se cargan la compra y sus guías de ingreso ya registradas. Vincúlalas a la carpeta para que el costo final llegue al lote. <b>No mueve stock ni genera asientos</b> (eso ya lo hizo la guía en Compras).</div>

        <strong class="mod-sec">1 · Commercial Invoice</strong>
        <div style="display:grid; grid-template-columns:1fr 1fr; gap:10px;">
          <div class="form-group"><label>Buscar CI (N° o proveedor)</label>
            <input type="text" id="gcBuscar" list="gcCIs" placeholder="Escribe HY5012-26-1…" oninput="window.gcElegirCI(this.value)"><datalist id="gcCIs"></datalist></div>
          <div id="gcCompra" class="form-group"></div>
        </div>

        <strong class="mod-sec">2 · Guías de ingreso registradas de esa compra</strong>
        <div id="gcGuias" style="margin-bottom:8px;"></div>

        <strong class="mod-sec">3 · Datos del traslado <small style="text-transform:none; letter-spacing:0; font-weight:400;">(guía de remisión del puerto/terminal al almacén)</small></strong>
        <div class="dm-nota" id="gcRemTit">Elige una guía en el paso 2 para completar sus datos de traslado.</div>
        <div id="gcRem" style="display:none;">
          <div style="display:grid; grid-template-columns:repeat(4, 1fr); gap:10px;">
            <div class="form-group"><label>Tipo de guía</label><select id="gcTipo"><option value="remitente">Remitente</option><option value="transportista">Transportista</option></select></div>
            <div class="form-group"><label>N° de guía *</label><input type="text" id="gcNumero" maxlength="40"></div>
            <div class="form-group"><label>Fecha de emisión *</label><input type="date" id="gcFecha"></div>
            <div class="form-group"><label>Fecha de traslado</label><input type="date" id="gcTraslado"></div>
            <div class="form-group" style="grid-column:span 2;"><label>Transportista</label><input type="text" id="gcTransp" maxlength="120"></div>
            <div class="form-group"><label>RUC transportista</label><input type="text" id="gcTranspRuc" maxlength="11"></div>
            <div class="form-group"><label>Placa</label><input type="text" id="gcPlaca" maxlength="15"></div>
            <div class="form-group" style="grid-column:span 2;"><label>Conductor</label><input type="text" id="gcConductor" maxlength="120"></div>
            <div class="form-group"><label>Licencia</label><input type="text" id="gcLicencia" maxlength="20"></div>
            <div class="form-group"><label>Peso bruto (kg)</label><input type="number" id="gcPeso" step="0.01"></div>
            <div class="form-group"><label>N° contenedor</label><input type="text" id="gcCont" maxlength="20"></div>
            <div class="form-group"><label>Precinto</label><input type="text" id="gcPrec" maxlength="30"></div>
            <div class="form-group"><label>Estado</label><select id="gcEstado"><option value="recibido">Recibido</option><option value="en_transito">En tránsito</option><option value="pendiente">Pendiente</option></select></div>
            <div class="form-group" style="grid-column:span 2;"><label>Punto de partida</label><input type="text" id="gcPartida" maxlength="160" placeholder="Terminal / depósito"></div>
            <div class="form-group" style="grid-column:span 2;"><label>Punto de llegada (almacén)</label><input type="text" id="gcDestino" maxlength="160"></div>
          </div>
          <div class="form-group"><label>Observaciones</label><textarea id="gcObs" rows="2"></textarea></div>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" onclick="closeModal('modal-guia-carpeta')">Cerrar</button>
        <button class="btn btn-primary" id="gcGuardar" style="display:none;" onclick="window.gcGuardarRemision()">💾 Guardar datos del traslado</button>
      </div>
    </div>
  </div>`)
}

let _gSel = null   // id de guía de ingreso en edición de traslado

function _pintarCompra() {
  const c = _compra
  $('gcCompra').innerHTML = !_ci ? '' : c
    ? `<label>Compra enlazada</label><div class="dm-cruce ok"><span class="dm-cruce-ico">✔</span><div><b>${esc(c.serie || '')}-${esc(c.numero || '')}</b> · ${esc(c.proveedor_nombre || '')}<br>${n0(c.cantidad)} ${esc(c.unidad_medida || '')} · ${c.currency === 'PEN' ? 'S/' : '$'} ${n2(c.total)}</div></div>`
    : `<label>Compra enlazada</label><div class="dm-cruce warn"><span class="dm-cruce-ico">⚠</span><div>No encontré la compra de este CI. Regístrala en Compras (o la guía de ingreso se vincula desde ahí).</div></div>`
}

function _validar(item) {
  const c = carpeta(), av = []
  if (c?.estado === 'cerrada') av.push(['err', 'La carpeta está cerrada.'])
  const kg = item.det.reduce((t, d) => t + num(d.cantidad), 0)
  const kgCI = num(_ci?.total_cantidad ?? _ci?.cantidad_total ?? _compra?.cantidad)
  if (kgCI && Math.abs(kg - kgCI) / kgCI > 0.005) av.push(['warn', `La guía ingresó ${n0(kg)} y el CI/compra dice ${n0(kgCI)}.`])
  for (const d of item.det) {
    if (!d.lote) av.push(['err', `La línea ${esc(d.numero_lote || '')} no tiene lote asociado.`])
    else if (d.lote.carpeta_importacion_id && d.lote.carpeta_importacion_id !== c?.id) av.push(['err', `El lote ${esc(d.lote.numero_lote)} ya está vinculado a otra carpeta.`])
  }
  if (item.g.estado && item.g.estado !== 'emitida') av.push(['err', `La guía está «${esc(item.g.estado)}».`])
  return av
}

function _pintarGuias() {
  const c = carpeta()
  if (!_compra) { $('gcGuias').innerHTML = '<div class="dm-nota">Primero necesito la compra del CI.</div>'; return }
  if (!_guias.length) { $('gcGuias').innerHTML = '<div class="dm-nota">Esa compra aún no tiene guía de ingreso. Regístrala en Compras → Guías de ingreso y vuelve aquí a vincularla.</div>'; return }
  $('gcGuias').innerHTML = _guias.map(item => {
    const { g, det, remision } = item
    const vinc = g.carpeta_importacion_id === c?.id
    const otra = g.carpeta_importacion_id && !vinc
    const av = _validar(item)
    const err = av.some(a => a[0] === 'err')
    return `<div class="dm-cruce ${vinc ? 'ok' : 'warn'}" style="display:block; margin-bottom:8px;">
      <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
        <b>${esc(g.numero_guia)}</b> · ${fechaDMY(g.fecha_guia)} <span class="cr-chip" style="--c:${vinc ? '#10b981' : otra ? '#ef4444' : '#f59e0b'};">${vinc ? 'Vinculada a esta carpeta' : otra ? 'Vinculada a otra carpeta' : 'Sin vincular'}</span>
        ${remision ? '<span class="cr-chip" style="--c:#3b82f6;">Con datos de traslado</span>' : ''}
        <span style="flex:1"></span>
        <button type="button" class="btn btn-secondary btn-small" onclick="window.gcTraslado(${g.id})">🚚 Datos de traslado</button>
        ${vinc ? `<button type="button" class="btn btn-secondary btn-small" onclick="window.gcVincular(${g.id}, false)">Desvincular</button>`
          : `<button type="button" class="btn btn-primary btn-small" ${err || otra ? 'disabled' : ''} onclick="window.gcVincular(${g.id}, true)">🔗 Vincular a la carpeta</button>`}
      </div>
      <table class="data-table" style="width:100%; margin-top:6px;"><thead><tr><th>Lote</th><th style="text-align:right">Ingresó</th><th style="text-align:right">Unidades</th><th style="text-align:right">Vendido</th><th style="text-align:right">Stock actual</th></tr></thead><tbody>${
        det.map(d => `<tr><td>${esc(d.lote?.numero_lote || d.numero_lote || '—')}</td><td style="text-align:right">${n0(d.cantidad)}</td><td style="text-align:right">${n0(d.cantidad_unidades)}</td><td style="text-align:right">${d.vendido ? n0(d.vendido) : '—'}</td><td style="text-align:right">${n0(d.lote?.cantidad)}</td></tr>`).join('')}</tbody></table>
      ${av.map(([t, x]) => `<div style="font-size:.8rem; margin-top:4px;">${t === 'err' ? '⛔' : '⚠️'} ${x}</div>`).join('')}
    </div>`
  }).join('')
}

window.gcElegirCI = async function (txt) {
  const t = String(txt || '').trim().toLowerCase()
  const hit = _cis.find(x => String(x.invoice_number || '').toLowerCase() === t)
  if (!hit) return
  _ci = hit
  await _cargarCompra(); await _cargarGuias(); _pintarCompra(); _pintarGuias()
}

window.abrirGuiaCarpeta = async function () {
  try {
    await esperarContextoEmpresa()
    const c = carpeta(); if (!c) { showToast('Abre primero una carpeta', 'warning'); return }
    _asegurarModal()
    _cis = (await query('comercial_invoices', {})) || []
    _ci = window.costeoActual?.id ? (_cis.find(x => x.id === window.costeoActual.id) || window.costeoActual) : null
    $('gcCIs').innerHTML = _cis.map(x => `<option value="${esc(x.invoice_number)}">${esc(x.invoice_number)}</option>`).join('')
    $('gcBuscar').value = _ci?.invoice_number || ''
    const selC = document.getElementById('costeoSelector')
    $('gcCarpeta').innerHTML = `<option>${esc(selC?.selectedOptions?.[0]?.text || c.numero_carpeta || '')}</option>`
    $('gcRem').style.display = 'none'; $('gcGuardar').style.display = 'none'; $('gcRemTit').style.display = ''; _gSel = null
    declararEmpresaModal('modal-guia-carpeta', c.empresa_id)
    await _cargarCompra(); await _cargarGuias(); _pintarCompra(); _pintarGuias()
    window.openModal('modal-guia-carpeta')
  } catch (e) { console.error('abrirGuiaCarpeta:', e); showToast('No se pudo abrir la guía de la carpeta', 'danger') }
}

// ── vincular / desvincular ───────────────────────────────────────────────────
window.gcVincular = async function (guiaId, vincular) {
  const c = carpeta(); const item = _guias.find(x => x.g.id === guiaId); if (!c || !item) return
  try {
    if (vincular) {
      const av = _validar(item)
      if (av.some(a => a[0] === 'err')) throw new Error('Corrige los avisos en rojo antes de vincular')
      if (av.length && !confirm('Hay avisos de diferencia de cantidad. ¿Vincular de todas formas?')) return
    } else {
      const vendidos = item.det.some(d => d.vendido > 0 && d.lote?.costo_estado === 'definitivo' && d.lote?.costo_real != null)
      if (vendidos && !confirm('Este lote ya tiene costo real aplicado. Desvincular no revierte el costo; solo quita el enlace. ¿Continuar?')) return
    }
    const val = vincular ? c.id : null
    if (!(await update('guias_ingreso_compra', guiaId, { carpeta_importacion_id: val }))) throw new Error(ultimoErrorInsert()?.message || 'No se pudo vincular la guía')
    for (const d of item.det) {
      if (!d.lote_id) continue
      if (!(await update('lotes', d.lote_id, { carpeta_importacion_id: val }))) throw new Error('No se pudo vincular el lote ' + (d.lote?.numero_lote || d.lote_id))
      for (const k of ((await query('kardex', { lote_id: d.lote_id })) || []).filter(k => k.tipo_movimiento === 'entrada' && num(k.cantidad_entrada) > 0)) await update('kardex', k.id, { carpeta_importacion_id: val })
    }
    if (vincular && _compra && !_compra.carpeta_importacion_id) await update('compras', _compra.id, { carpeta_importacion_id: c.id })
    showToast(vincular ? 'Guía y lote vinculados a la carpeta' : 'Guía desvinculada', 'success')
    await _cargarGuias(); _pintarGuias()
    window.renderGuiasCarpeta?.(); window.renderHojaCosteo?.()
  } catch (e) { console.error('gcVincular:', e); showToast(e.message || 'No se pudo vincular', 'danger') }
}

// ── datos del traslado ───────────────────────────────────────────────────────
window.gcTraslado = function (guiaId) {
  const item = _guias.find(x => x.g.id === guiaId); if (!item) return
  _gSel = guiaId
  const r = item.remision || {}
  $('gcRemTit').style.display = 'none'; $('gcRem').style.display = ''; $('gcGuardar').style.display = ''
  $('gcTipo').value = r.tipo_guia || 'remitente'
  $('gcNumero').value = r.numero_guia || item.g.numero_guia || ''
  $('gcFecha').value = r.fecha_guia || item.g.fecha_guia || ''
  $('gcTraslado').value = r.fecha_traslado || ''
  $('gcTransp').value = r.transportista_nombre || ''; $('gcTranspRuc').value = r.transportista_ruc || ''
  $('gcPlaca').value = r.placa || ''; $('gcConductor').value = r.conductor || ''; $('gcLicencia').value = r.conductor_licencia || ''
  $('gcPeso').value = r.peso_bruto || ''; $('gcCont').value = r.contenedor_nro || ''; $('gcPrec').value = r.precinto || ''
  $('gcEstado').value = r.estado || 'recibido'; $('gcPartida').value = r.punto_partida || ''; $('gcDestino').value = r.lugar_destino || ''
  $('gcObs').value = r.observaciones || ''
}

window.gcGuardarRemision = async function () {
  try {
    const c = carpeta(); const item = _guias.find(x => x.g.id === _gSel); if (!c || !item) return
    if (!v('gcNumero') || !v('gcFecha')) throw new Error('Falta el N° y la fecha de la guía')
    if (!_ci?.id) throw new Error('Falta el CI de la carpeta')
    const fila = {
      importacion_id: _ci.id, carpeta_importacion_id: c.id, guia_ingreso_id: item.g.id,
      tipo_guia: v('gcTipo'), numero_guia: v('gcNumero'), fecha_guia: v('gcFecha'), fecha_traslado: v('gcTraslado') || null,
      transportista_nombre: v('gcTransp') || null, transportista_ruc: v('gcTranspRuc') || null, placa: v('gcPlaca') || null,
      conductor: v('gcConductor') || null, conductor_licencia: v('gcLicencia') || null, peso_bruto: num(v('gcPeso')),
      contenedor_nro: v('gcCont') || null, precinto: v('gcPrec') || null, estado: v('gcEstado'),
      punto_partida: v('gcPartida') || null, lugar_destino: v('gcDestino') || null, observaciones: v('gcObs') || null,
      proveedor: _compra?.contact_id || null
    }
    if (item.remision) { if (!(await update('guias_remision', item.remision.id, fila))) throw new Error(ultimoErrorInsert()?.message || 'No se pudo actualizar') }
    else {
      const user = await getCurrentUser()
      const f = await insert('guias_remision', { ...fila, created_by: user?.db_id })
      if (!f?.id) throw new Error(ultimoErrorInsert()?.message || 'No se pudo guardar (¿corriste el SQL 110?)')
    }
    showToast('Datos del traslado guardados', 'success')
    await _cargarGuias(); _pintarGuias(); window.gcTraslado(_gSel)
    window.renderGuiasCarpeta?.()
  } catch (e) { console.error('gcGuardarRemision:', e); showToast(e.message || 'No se pudo guardar', 'danger') }
}

// ── lista en la pestaña «Guía de remisión» ───────────────────────────────────
window.renderGuiasCarpeta = async function () {
  const host = $('tabla-guia-remision'); const c = carpeta(); if (!host || !c) return
  try {
    const gs = (await query('guias_ingreso_compra', { carpeta_importacion_id: c.id })) || []
    if (!gs.length) { host.innerHTML = '<p style="text-align:center; color:var(--text-secondary); padding:20px;">Aún no hay guías vinculadas. Usa «Vincular / registrar guía».</p>'; return }
    const filas = []
    // Detalle, remisión y lotes de TODAS las guías en paralelo
    const datos = await Promise.all(gs.map(async g => {
      const [det, rem] = await Promise.all([
        query('detalle_guias_ingreso_compra', { guia_id: g.id }),
        query('guias_remision', { guia_ingreso_id: g.id })
      ])
      const ls = await Promise.all((det || []).map(d => d.lote_id ? query('lotes', { id: d.lote_id }) : []))
      return { g, det: det || [], r: (rem || [])[0] || null, ls }
    }))
    for (const { g, det, r, ls } of datos) {
      const lotes = []
      det.forEach((d, i) => { const l = (ls[i] || [])[0] || null; lotes.push(`${esc(l?.numero_lote || d.numero_lote || '—')} (${n0(d.cantidad)})`) })
      filas.push(`<tr><td><b>${esc(g.numero_guia)}</b></td><td>${fechaDMY(g.fecha_guia)}</td><td>${lotes.join(', ')}</td>
        <td>${r ? esc([r.transportista_nombre, r.placa].filter(Boolean).join(' · ') || '—') : '<span style="color:var(--text-secondary)">sin datos</span>'}</td>
        <td>${r ? esc([r.contenedor_nro, r.precinto && 'prec. ' + r.precinto].filter(Boolean).join(' · ') || '—') : '—'}</td>
        <td>${r?.fecha_traslado ? fechaDMY(r.fecha_traslado) : '—'}</td><td>${esc(g.estado || '')}</td></tr>`)
    }
    host.innerHTML = `<table><thead><tr><th>Guía de ingreso</th><th>Fecha</th><th>Lotes (kg)</th><th>Transportista · placa</th><th>Contenedor · precinto</th><th>Traslado</th><th>Estado</th></tr></thead><tbody>${filas.join('')}</tbody></table>`
  } catch (e) { console.error('renderGuiasCarpeta:', e); host.innerHTML = '' }
}

export default { abrirGuiaCarpeta: window.abrirGuiaCarpeta }
