// ============================================================================
// costos-lote-carpeta.js — Del costeo de la carpeta al LOTE (costo real + comercial)
// ----------------------------------------------------------------------------
// Toma el resultado de la hoja de costeo y lo lleva al lote vinculado (por la guía):
//   · lotes.costo_real       = costo CONTABLE final (NIC 2) por kg, en USD   [solo lectura en Inventario]
//   · lotes.costo_comercial  = costo COMERCIAL (gestión) por kg, en USD
//   · lotes.costo_unitario   = costo contable en S/ por kg (el que usa el kardex)
// y RECOSTEA lo ya vendido: kardex (entrada/salidas/saldo) y detalle_ventas del lote.
// Seguridad: validaciones previas → bitácora con valores anteriores (lote_costo_historial,
// SQL 111) → aplicar → si algo falla, se revierte con la bitácora (todo o nada).
// Requiere: guía vinculada a la carpeta (guia-carpeta-modal.js, SQL 110) y SQL 111.
// ============================================================================
import { query, insert, update, esperarContextoEmpresa, ultimoErrorInsert } from '../supabase-client.js'
import { getCurrentUser } from '../auth-supabase.js'
import { showToast, formatNumber, fechaDMY } from '../helpers.js'
import { declararEmpresaModal } from '../empresa.js'

const $ = id => document.getElementById(id)
const num = x => { const n = parseFloat(String(x ?? '').replace(/,/g, '')); return isNaN(n) ? 0 : n }
const n2 = x => formatNumber(num(x), 2)
const n4 = x => formatNumber(num(x), 4)
const n0 = x => formatNumber(num(x), 0)
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const carpeta = () => window.carpetaActual || null
const TOL = 0.0005
let _plan = null

// ── 1. ¿La carpeta está lista? (bloqueantes y avisos) ────────────────────────
function _checks(d, c, lotes) {
  const bl = [], av = []
  if (!c || c.fdUsdC == null || c.fdPenC == null) bl.push('La hoja no tiene factor de distribución en S/ (falta DAM con T.C. o el CI).')
  if (!d.dam) bl.push('Falta registrar la DAM.')
  else {
    if (d.dam.estado !== 'pagado') bl.push('La DAM no figura pagada.')
    if (!d.dam.fecha_levante) bl.push('Aún no hay levante autorizado.')
  }
  const pend = (d.ajustes || []).filter(a => a.estado !== 'desestimada' && (a.estado === 'pendiente' || !a.numero))
  if (pend.length) bl.push(`${pend.length} ajuste(s) de valor por liquidar/pagar.`)
  const prov = (d.costos || []).filter(k => k.es_provisional && !k.castigada)
  if (prov.length) bl.push(`${prov.length} costo(s) provisional(es): falta la factura real.`)
  if (!d.liq?.numero) bl.push('Falta registrar la liquidación del agente (costos finales).')
  else if (d.liq.dev_estado === 'en_proceso') av.push('La devolución del agente sigue en proceso.')
  if (!lotes.length) bl.push('No hay lotes vinculados: vincula la guía de ingreso en la pestaña «Guía de remisión».')
  if (d.carpeta?.estado === 'cerrada') av.push('La carpeta está cerrada: el costo ya debería ser definitivo.')
  return { bl, av }
}

// ── 2. Plan por lote (cálculo + simulación del recosteo) ─────────────────────
async function _planLote(lote, art, c, tc) {
  const r = { lote, art, bl: [], av: [] }
  if (!art) { r.bl.push('No encuentro la línea del CI de este producto.'); return r }
  if (art.fobPenUnit == null) { r.bl.push('Sin T.C. de la DAM no se puede calcular el costo en S/.'); return r }
  const contUsd = art.unit * c.fdUsdC, comUsd = art.unit * c.fdUsd
  const contPen = art.fobPenUnit * c.fdPenC, comPen = art.fobPenUnit * c.fdPen   // S/ por kg = FOB unit × T.C. de la DAM × factor en S/
  const cifPenOld = num(lote.costo_unitario)
  Object.assign(r, { contUsd, comUsd, contPen, comPen, cifPenOld, cifUsd: art.unit })
  if (!(contUsd > 0) || !(contPen > 0)) r.bl.push('El costo calculado no es válido.')
  if (contUsd < art.unit - 1e-9) r.bl.push('El costo contable quedó por DEBAJO del FOB: revisa la hoja.')
  if (comUsd + 1e-9 < contUsd) r.av.push('El costo comercial salió menor al contable (revisa las clasificaciones).')
  // Kardex del lote. El saldo se guarda por zona/almacén (los traslados lo reparten): no se suma por lote;
  // se exige que cada fila esté valorizada solo con este lote (saldo_valor = saldo × costo actual).
  const kx = ((await query('kardex', { lote_id: lote.id })) || []).sort((a, b) => a.id - b.id)
  let stock = 0
  for (const k of kx) {
    stock += num(k.cantidad_entrada) - num(k.cantidad_salida)
    if (Math.abs(num(k.costo_unitario) - cifPenOld) > TOL) { r.bl.push(`El mov. ${k.id} tiene costo ${n4(k.costo_unitario)} distinto al del lote (${n4(cifPenOld)}).`); break }
    if (Math.abs(num(k.saldo_valor) - num(k.saldo_cantidad) * cifPenOld) > 1) { r.bl.push(`El saldo valorizado del mov. ${k.id} mezcla otros lotes del producto: recosteo automático no seguro.`); break }
    if (k.asiento_id) r.av.push(`El mov. ${k.id} tiene asiento contable: el asiento NO se ajusta automáticamente.`)
  }
  const dv = (await query('detalle_ventas', { lote_id: lote.id })) || []
  for (const l of dv) if (l.costo_unitario != null && Math.abs(num(l.costo_unitario) - cifPenOld) > TOL) { r.bl.push(`La venta (línea ${l.id}) usa costo ${n4(l.costo_unitario)} distinto al del lote.`); break }
  const vendidoKg = kx.filter(k => k.tipo_movimiento === 'salida' && !(num(k.cantidad_entrada) > 0)).reduce((t, k) => t + num(k.cantidad_salida), 0)
  Object.assign(r, { kx, dv, vendidoKg, stock, dCostoVentas: vendidoKg * (contPen - cifPenOld), dInventario: stock * (contPen - cifPenOld), nVentas: new Set(dv.map(l => l.venta_id)).size })
  if (lote.costo_estado === 'definitivo' && lote.costo_carpeta_id === carpeta()?.id && lote.costo_real != null) r.av.push('Este lote ya tiene costos aplicados de esta carpeta: se reemplazarán.')
  return r
}

// ── 3. Bloque en la hoja (Etapa 4) ───────────────────────────────────────────
window.renderCostosLote = async function () {
  const host = $('e4-lote-host'); const c0 = carpeta(); if (!host || !c0) return
  try {
    const lotes = (await query('lotes', { carpeta_importacion_id: c0.id })) || []
    const ap = lotes.filter(l => l.costo_carpeta_id === c0.id && l.costo_real != null)
    const chips = lotes.length ? lotes.map(l => `<span class="cr-chip" style="--c:${ap.includes(l) ? '#10b981' : '#f59e0b'};">${esc(l.numero_lote)} · ${ap.includes(l) ? 'costo aplicado' : 'costo pendiente'}</span>`).join(' ') : '<span class="cr-chip" style="--c:#ef4444;">Sin lote vinculado</span>'
    host.innerHTML = `<div class="e3-lista"><div class="e3-sub">Costo final al lote</div>
      <div style="display:flex; gap:8px; flex-wrap:wrap; align-items:center; margin:6px 0;">
        <button type="button" class="btn btn-primary btn-small" onclick="window.abrirCostosLote()">📦 Revisar y aplicar al lote</button>${chips}</div></div>`
  } catch (e) { host.innerHTML = '' }
}

// ── 4. Modal de revisión ──────────────────────────────────────────────────────
function _asegurarModal() {
  if ($('modal-costos-lote')) return
  document.body.insertAdjacentHTML('beforeend', `
  <div id="modal-costos-lote" class="modal">
    <div class="modal-content" style="width:min(96vw, 1000px); max-width:min(96vw, 1000px); max-height:calc(100vh - 48px); overflow-y:auto;">
      <div class="modal-header"><h3 class="modal-title">Aplicar costo final al lote</h3>
        <button class="modal-close" onclick="closeModal('modal-costos-lote')">&times;</button></div>
      <div style="padding:6px 20px 0;">
        <div class="dm-explica">📦 Lleva el costo de la hoja al lote: <b>Costo real = contable (NIC 2)</b> y <b>Costo comercial</b>. También <b>recostea lo ya vendido</b>. Revisa los números antes de aplicar.</div>
        <div id="clChecks"></div>
        <div id="clPlan"></div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" onclick="closeModal('modal-costos-lote')">Cerrar</button>
        <button class="btn btn-primary" id="clAplicar" onclick="window.aplicarCostosLote()">✅ Aplicar costos y recostear ventas</button>
      </div>
    </div>
  </div>`)
}

window.abrirCostosLote = async function () {
  try {
    await esperarContextoEmpresa()
    const c0 = carpeta(); const u = window.hcUltimo
    if (!c0 || !u) { showToast('Abre primero la hoja de costeo de una carpeta', 'warning'); return }
    _asegurarModal(); declararEmpresaModal('modal-costos-lote', c0.empresa_id)
    const { d, c } = u
    const lotes = (await query('lotes', { carpeta_importacion_id: c0.id })) || []
    const ch = _checks(d, c, lotes)
    _plan = { lotes: [], bl: [...ch.bl], av: [...ch.av], d, c }
    for (const l of lotes) _plan.lotes.push(await _planLote(l, c?.art?.find(a => String(a.itemId) === String(l.item_id)), c, c?.tc))
    for (const p of _plan.lotes) { _plan.bl.push(...p.bl.map(x => `Lote ${esc(p.lote.numero_lote)}: ${x}`)); _plan.av.push(...p.av.map(x => `Lote ${esc(p.lote.numero_lote)}: ${x}`)) }
    const li = (arr, ico) => arr.map(x => `<div style="margin:3px 0;">${ico} ${x}</div>`).join('')
    $('clChecks').innerHTML = (_plan.bl.length ? `<div class="la-alerta"><b>No se puede aplicar todavía:</b>${li(_plan.bl, '⛔')}</div>` : '<div class="la-alerta ok">✅ Validaciones cumplidas.</div>') + (_plan.av.length ? `<div class="la-alerta info">${li(_plan.av, '⚠️')}</div>` : '')
    $('clPlan').innerHTML = _plan.lotes.map(p => !p.contUsd ? '' : `<strong class="mod-sec">Lote ${esc(p.lote.numero_lote)} · ${n0(p.lote.cantidad)} kg en stock</strong>
      <table class="data-table" style="width:100%"><thead><tr><th>Costo por kg</th><th style="text-align:right">Hoy en el lote</th><th style="text-align:right">Nuevo</th><th style="text-align:right">Cambio</th></tr></thead><tbody>
        <tr><td>CIF (factura) · USD</td><td style="text-align:right">$ ${n4(p.cifUsd)}</td><td style="text-align:right">—</td><td></td></tr>
        <tr><td><b>Costo real = contable (NIC 2)</b> · USD</td><td style="text-align:right">${p.lote.costo_real != null ? '$ ' + n4(p.lote.costo_real) : '—'}</td><td style="text-align:right"><b>$ ${n4(p.contUsd)}</b></td><td style="text-align:right">+${n2((p.contUsd / p.cifUsd - 1) * 100)}% sobre CIF</td></tr>
        <tr><td>Costo contable · S/ (kardex)</td><td style="text-align:right">S/ ${n4(p.cifPenOld)}</td><td style="text-align:right"><b>S/ ${n4(p.contPen)}</b></td><td style="text-align:right">${p.contPen >= p.cifPenOld ? '+' : ''}${n4(p.contPen - p.cifPenOld)}</td></tr>
        <tr><td><b>Costo comercial</b> · USD</td><td style="text-align:right">${p.lote.costo_comercial != null ? '$ ' + n4(p.lote.costo_comercial) : '—'}</td><td style="text-align:right"><b>$ ${n4(p.comUsd)}</b></td><td style="text-align:right">+${n2((p.comUsd / p.cifUsd - 1) * 100)}% sobre CIF</td></tr></tbody></table>
      <div class="dm-cruce warn" style="margin-top:8px;"><span class="dm-cruce-ico">📉</span><div><b>Impacto del recosteo</b> — ya vendido: ${n0(p.vendidoKg)} kg en ${p.nVentas} venta(s) → el costo de ventas pasadas sube S/ ${n2(p.dCostoVentas)} (el margen baja en ese monto).
        Stock restante: ${n0(p.stock)} kg → el inventario valorizado sube S/ ${n2(p.dInventario)}. Movimientos de kardex a corregir: ${p.kx.length}.</div></div>`).join('')
    $('clAplicar').disabled = !!_plan.bl.length || !_plan.lotes.length
    window.openModal('modal-costos-lote')
  } catch (e) { console.error('abrirCostosLote:', e); showToast('No se pudo preparar el costo del lote', 'danger') }
}

// ── 5. Aplicar (bitácora → cambios → rollback si falla) ──────────────────────
window.aplicarCostosLote = async function () {
  if (!_plan || _plan.bl.length) return
  const c0 = carpeta()
  if (!confirm(`Se aplicará el costo final a ${_plan.lotes.length} lote(s) y se recostearán sus ventas pasadas.\n\nQuedará una bitácora para poder revertir. ¿Continuar?`)) return
  const btn = $('clAplicar'); btn.disabled = true
  const user = await getCurrentUser()
  const hechos = []   // [tabla, id, prev]
  const poner = async (tabla, id, prev, nuevo) => {
    hechos.push([tabla, id, prev])
    if (!(await update(tabla, id, nuevo))) throw new Error(`No se pudo actualizar ${tabla} #${id}: ${ultimoErrorInsert()?.message || ''}`)
  }
  try {
    for (const p of _plan.lotes) {
      const l = p.lote, ahora = new Date().toISOString()
      const prevLote = { costo_unitario: l.costo_unitario, costo_real: l.costo_real, costo_comercial: l.costo_comercial, costo_estado: l.costo_estado, costo_carpeta_id: l.costo_carpeta_id, costo_carpeta_aplicado_at: l.costo_carpeta_aplicado_at }
      // 1) kardex
      let tiene = true
      for (const k of p.kx) {
        await poner('kardex', k.id, { costo_unitario: k.costo_unitario, valor_entrada: k.valor_entrada, valor_salida: k.valor_salida, saldo_valor: k.saldo_valor }, {
          costo_unitario: p.contPen,
          valor_entrada: num(k.cantidad_entrada) > 0 ? num(k.cantidad_entrada) * p.contPen : k.valor_entrada,
          valor_salida: num(k.cantidad_salida) > 0 ? num(k.cantidad_salida) * p.contPen : k.valor_salida,
          saldo_valor: num(k.saldo_cantidad) * p.contPen
        })
      }
      // 2) ventas pasadas
      for (const v of p.dv) if (v.costo_unitario != null) await poner('detalle_ventas', v.id, { costo_unitario: v.costo_unitario }, { costo_unitario: p.contPen })
      // 3) lote
      await poner('lotes', l.id, prevLote, { costo_unitario: p.contPen, costo_real: p.contUsd, costo_comercial: p.comUsd, costo_estado: 'definitivo', costo_carpeta_id: c0.id, costo_carpeta_aplicado_at: ahora, costo_real_actualizado_at: ahora })
      // 4) bitácora
      const hist = await insert('lote_costo_historial', {
        lote_id: l.id, carpeta_importacion_id: c0.id, aplicado_por: user?.db_id,
        anterior: { lote: prevLote, kardex: hechos.filter(h => h[0] === 'kardex').length, ventas: p.dv.length },
        nuevo: { costo_real_usd: p.contUsd, costo_comercial_usd: p.comUsd, costo_unitario_pen: p.contPen, kg_vendidos: p.vendidoKg, delta_costo_ventas_pen: p.dCostoVentas, delta_inventario_pen: p.dInventario },
        cambios: hechos.map(h => ({ t: h[0], id: h[1], prev: h[2] }))
      })
      if (!hist?.id) throw new Error('No se pudo guardar la bitácora (¿corriste el SQL 111?)')
    }
    showToast('Costos aplicados al lote y ventas recosteadas', 'success')
    closeModal('modal-costos-lote'); window.renderCostosLote?.(); window.renderHojaCosteo?.()
  } catch (e) {
    console.error('aplicarCostosLote:', e)
    // rollback con lo guardado en memoria (orden inverso)
    let fallos = 0
    for (const [t, id, prev] of hechos.reverse()) { try { if (!(await update(t, id, prev))) fallos++ } catch { fallos++ } }
    showToast((e.message || 'Falló la aplicación') + (fallos ? ` · ⚠ no pude revertir ${fallos} registro(s): avísame` : ' · cambios revertidos'), 'danger', 9000)
  } finally { btn.disabled = false }
}

export default { abrirCostosLote: window.abrirCostosLote }
