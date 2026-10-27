// ============================================================================
// estadia-modal.js — Control de ESTADÍA de la carpeta (SQL 112)
// Dos relojes que parten de la fecha de descarga:
//   · contenedor (naviera): días libres hasta devolver el vacío
//   · almacenaje (terminal / depósito temporal): días libres hasta retirar la carga
// La constancia oficial (aviso de llegada, consulta SUNAT, liquidación del terminal)
// se adjunta a la carpeta con concepto «estadia». Alerta en la línea de tiempo.
// Uso: window.abrirEstadia() · window.estadiaResumen(fila)
// ============================================================================
import { query, insert, update, esperarContextoEmpresa, ultimoErrorInsert } from '../supabase-client.js'
import { getCurrentUser } from '../auth-supabase.js'
import { showToast, formatNumber, fechaDMY } from '../helpers.js'
import { declararEmpresaModal } from '../empresa.js'
import { subirAdjuntos } from '../supabase-data.js'

const $ = id => document.getElementById(id)
const v = id => ($(id)?.value ?? '').toString().trim()
const num = x => { const n = parseFloat(String(x ?? '').replace(/,/g, '')); return isNaN(n) ? 0 : n }
const n2 = x => formatNumber(num(x), 2)
const carpeta = () => window.carpetaActual || null
const hoyISO = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10)
const dias = (a, b) => Math.round((new Date(b + 'T00:00:00') - new Date(a + 'T00:00:00')) / 86400000)

/** Un reloj: {usados, libres, restan, extra, estado:'curso'|'alerta'|'exceso'|'ok', texto} */
function _reloj(desde, fin, libres, tarifa, nombre) {
  if (!desde || libres == null || libres === '') return null
  const cerrado = !!fin, hasta = fin || hoyISO()
  const usados = Math.max(0, dias(desde, hasta)), restan = num(libres) - usados, extra = Math.max(0, -restan)
  const estado = extra > 0 ? 'exceso' : cerrado ? 'ok' : restan <= 2 ? 'alerta' : 'curso'
  const costo = extra && tarifa ? extra * num(tarifa) : 0
  const texto = extra > 0 ? `${nombre}: ${extra} día(s) de sobreestadía${costo ? ` (≈ $ ${n2(costo)})` : ''}`
    : cerrado ? `${nombre}: cerrado con ${usados} de ${libres} días`
    : `${nombre}: día ${usados} de ${libres} (${restan === 0 ? 'vence hoy' : 'quedan ' + restan})`
  return { usados, libres: num(libres), restan, extra, estado, cerrado, costo, texto }
}

window.estadiaResumen = function (e) {
  if (!e) return null
  const cont = _reloj(e.fecha_descarga, e.fecha_devolucion_vacio, e.dias_libres_contenedor, e.tarifa_dia_contenedor, 'Contenedor')
  const alm = _reloj(e.fecha_descarga, e.fecha_retiro, e.dias_libres_almacen, e.tarifa_dia_almacen, 'Almacenaje')
  const rs = [cont, alm].filter(Boolean)
  if (!rs.length) return null
  return { cont, alm, texto: rs.map(r => r.texto).join(' · '), alerta: rs.some(r => r.estado === 'alerta' || r.estado === 'exceso'), exceso: rs.some(r => r.estado === 'exceso'), cerrado: rs.every(r => r.cerrado) }
}

let _row = null
function _asegurarModal() {
  if ($('modal-estadia')) return
  document.body.insertAdjacentHTML('beforeend', `
  <div id="modal-estadia" class="modal">
    <div class="modal-content" style="width:min(96vw, 860px); max-width:min(96vw, 860px); max-height:calc(100vh - 48px); overflow-y:auto;">
      <div class="modal-header"><h3 class="modal-title">Control de estadía</h3><button class="modal-close" onclick="closeModal('modal-estadia')">&times;</button></div>
      <div style="padding:6px 20px 0;">
        <div class="dm-explica">⏱️ Dos relojes desde la <b>fecha de descarga</b>: el <b>contenedor</b> (días libres de la naviera hasta devolver el vacío) y el <b>almacenaje</b> (días libres del terminal/depósito temporal hasta retirar la carga). Los días libres salen del <b>aviso de llegada de la naviera</b> y de la liquidación/tarifario del terminal; la fecha de descarga y recepción se confirma en la <b>consulta de manifiesto de SUNAT</b>. Adjunta esa constancia.</div>
        <div id="esAlerta"></div>
        <div style="display:grid; grid-template-columns:repeat(4,1fr); gap:10px;">
          <div class="form-group"><label>Fecha de descarga *</label><input type="date" id="esDescarga" onchange="window.esRecalc()"></div>
          <div class="form-group" style="grid-column:span 3;"><label>Fuente / constancia</label><input type="text" id="esFuente" maxlength="160" placeholder="Aviso de llegada ONE · SUNAT consulta de manifiesto…"></div>
        </div>
        <strong class="mod-sec">Contenedor (naviera)</strong>
        <div style="display:grid; grid-template-columns:repeat(4,1fr); gap:10px;">
          <div class="form-group"><label>N° contenedor</label><input type="text" id="esCont" maxlength="20"></div>
          <div class="form-group"><label>Días libres</label><input type="number" id="esLibresC" min="0" step="1" oninput="window.esRecalc()"></div>
          <div class="form-group"><label>Tarifa por día (USD)</label><input type="number" id="esTarifaC" step="0.01" oninput="window.esRecalc()"></div>
          <div class="form-group"><label>Devolución del vacío</label><input type="date" id="esDevol" onchange="window.esRecalc()"></div>
        </div>
        <strong class="mod-sec">Almacenaje (terminal / depósito temporal)</strong>
        <div style="display:grid; grid-template-columns:repeat(4,1fr); gap:10px;">
          <div class="form-group"><label>Terminal / depósito</label><input type="text" id="esDeposito" maxlength="120"></div>
          <div class="form-group"><label>Días libres</label><input type="number" id="esLibresA" min="0" step="1" oninput="window.esRecalc()"></div>
          <div class="form-group"><label>Tarifa por día (USD)</label><input type="number" id="esTarifaA" step="0.01" oninput="window.esRecalc()"></div>
          <div class="form-group"><label>Retiro de la carga</label><input type="date" id="esRetiro" onchange="window.esRecalc()"></div>
        </div>
        <div class="form-group"><label>Observaciones</label><textarea id="esObs" rows="2"></textarea></div>
        <div class="dm-nota">📎 Constancia oficial: <button type="button" class="btn btn-secondary btn-small" onclick="window.esAdjuntar()">Subir archivo</button> <span id="esAdjN"></span></div>
      </div>
      <div class="modal-footer"><button class="btn btn-secondary" onclick="closeModal('modal-estadia')">Cerrar</button><button class="btn btn-primary" onclick="window.esGuardar()">💾 Guardar</button></div>
    </div>
  </div>`)
}

window.esRecalc = function () {
  const r = window.estadiaResumen({ fecha_descarga: v('esDescarga') || null, dias_libres_contenedor: v('esLibresC') === '' ? null : num(v('esLibresC')), tarifa_dia_contenedor: v('esTarifaC'), fecha_devolucion_vacio: v('esDevol') || null,
    dias_libres_almacen: v('esLibresA') === '' ? null : num(v('esLibresA')), tarifa_dia_almacen: v('esTarifaA'), fecha_retiro: v('esRetiro') || null })
  $('esAlerta').innerHTML = r ? `<div class="la-alerta ${r.exceso ? '' : r.alerta ? '' : 'ok'}" style="${r.exceso ? 'border-color:#ef4444;background:color-mix(in srgb,#ef4444 12%,transparent);' : ''}">${r.exceso ? '🚨' : r.alerta ? '⚠️' : '⏱️'} ${r.texto}</div>` : '<div class="dm-nota">Completa la fecha de descarga y los días libres para ver la alerta.</div>'
}

window.abrirEstadia = async function () {
  try {
    await esperarContextoEmpresa()
    const c = carpeta(); if (!c) { showToast('Abre primero una carpeta', 'warning'); return }
    _asegurarModal(); declararEmpresaModal('modal-estadia', c.empresa_id)
    _row = ((await query('importacion_estadia', { carpeta_importacion_id: c.id })) || [])[0] || null
    const d = window.hcUltimo?.d
    const gr = ((await query('guias_remision', { carpeta_importacion_id: c.id })) || [])[0] || null
    const bl = d?.bls?.[0]
    $('esDescarga').value = _row?.fecha_descarga || (bl?.fecha_eta ? String(bl.fecha_eta).slice(0, 10) : '')
    $('esFuente').value = _row?.fuente || ''
    $('esCont').value = _row?.contenedor_nro || gr?.contenedor_nro || ''
    $('esLibresC').value = _row?.dias_libres_contenedor ?? ''; $('esTarifaC').value = _row?.tarifa_dia_contenedor ?? ''; $('esDevol').value = _row?.fecha_devolucion_vacio || ''
    $('esDeposito').value = _row?.deposito_nombre || ''; $('esLibresA').value = _row?.dias_libres_almacen ?? ''; $('esTarifaA').value = _row?.tarifa_dia_almacen ?? ''
    $('esRetiro').value = _row?.fecha_retiro || gr?.fecha_traslado || d?.guias?.[0]?.fecha_guia || ''
    $('esObs').value = _row?.observaciones || ''
    const adj = (d?.adjuntos || []).filter(a => a.concepto === 'estadia').length
    $('esAdjN').textContent = adj ? `(${adj} archivo/s)` : ''
    window.esRecalc(); window.openModal('modal-estadia')
  } catch (e) { console.error('abrirEstadia:', e); showToast('No se pudo abrir el control de estadía', 'danger') }
}

window.esGuardar = async function () {
  try {
    const c = carpeta(); if (!c) return
    if (!v('esDescarga')) throw new Error('Falta la fecha de descarga')
    const user = await getCurrentUser()
    const fila = { carpeta_importacion_id: c.id, fecha_descarga: v('esDescarga'), fuente: v('esFuente') || null, contenedor_nro: v('esCont') || null,
      dias_libres_contenedor: v('esLibresC') === '' ? null : Math.round(num(v('esLibresC'))), tarifa_dia_contenedor: v('esTarifaC') === '' ? null : num(v('esTarifaC')), fecha_devolucion_vacio: v('esDevol') || null,
      deposito_nombre: v('esDeposito') || null, dias_libres_almacen: v('esLibresA') === '' ? null : Math.round(num(v('esLibresA'))), tarifa_dia_almacen: v('esTarifaA') === '' ? null : num(v('esTarifaA')), fecha_retiro: v('esRetiro') || null, observaciones: v('esObs') || null }
    if (_row) { if (!(await update('importacion_estadia', _row.id, fila))) throw new Error(ultimoErrorInsert()?.message || 'No se pudo actualizar') }
    else { const f = await insert('importacion_estadia', { ...fila, created_by: user?.db_id }); if (!f?.id) throw new Error(ultimoErrorInsert()?.message || 'No se pudo guardar (¿corriste el SQL 112?)'); _row = f }
    showToast('Estadía guardada', 'success'); window.closeModal('modal-estadia'); window.renderHojaCosteo?.()
  } catch (e) { console.error('esGuardar:', e); showToast(e.message || 'No se pudo guardar', 'danger') }
}

window.esAdjuntar = function () {
  const c = carpeta(); if (!c) return
  const inp = document.createElement('input'); inp.type = 'file'; inp.accept = 'application/pdf,image/*'; inp.multiple = true
  inp.onchange = async () => {
    const files = [...inp.files]; if (!files.length) return
    const user = await getCurrentUser()
    const res = await subirAdjuntos('carpeta_importacion', c.id, files.map(file => ({ file, concepto: 'estadia' })), user?.db_id)
    showToast(res.errores?.length ? res.errores.join(' · ') : 'Constancia guardada', res.errores?.length ? 'danger' : 'success')
    $('esAdjN').textContent = '(subido)'
  }
  inp.click()
}

export default { abrirEstadia: window.abrirEstadia }
