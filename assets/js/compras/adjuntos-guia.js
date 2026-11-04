// ============================================================================
// compras/adjuntos-guia.js — Documentos adjuntos de las Guías de Remisión
// (guias_ingreso_compra) · 2026-11-03
// ----------------------------------------------------------------------------
// Mismo flujo que "Adjuntar documento" de Compras (⋮ de la fila → modal con lo
// ya adjunto + subir), pero sobre la tabla genérica `adjuntos` (varios archivos
// por guía). Entidad = 'guia_remision' (ya permitida por el CHECK de adjuntos,
// SQL 86/94/107/123) · entidad_id = guias_ingreso_compra.id.
// ============================================================================
import { getAdjuntos, subirAdjuntos, getUrlAdjunto, eliminarAdjunto, validarArchivoAdjunto, getConteoAdjuntos } from '../supabase-data.js'
import { getCurrentUser } from '../auth-supabase.js'
import { showToast } from '../helpers.js'

export const ENTIDAD_ADJ_GUIA = 'guia_remision'
const _esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
let _guiaAdjId = null
let _alCambiar = null   // callback para refrescar la tabla (lo registra guias-ingreso-lista.js)

/** { guia_id: n° de adjuntos } para pintar 📎 en la tabla. */
export async function conteoAdjuntosGuias() {
  try { return await getConteoAdjuntos(ENTIDAD_ADJ_GUIA) || {} } catch { return {} }
}
export function alCambiarAdjuntosGuia(fn) { _alCambiar = fn }

function _asegurarModal() {
  if (document.getElementById('modal-adjunto-guia')) return
  const div = document.createElement('div')
  div.id = 'modal-adjunto-guia'
  div.className = 'modal'
  div.innerHTML = `
    <div class="modal-content" style="max-width:560px;">
      <div class="modal-header">
        <h3 class="modal-title" id="adjGuiaTitulo">Documentos de la guía</h3>
        <button class="modal-close" onclick="window.closeModal('modal-adjunto-guia')">✕</button>
      </div>
      <div style="padding:16px;">
        <div id="adjGuiaActual" style="margin-bottom:14px;"></div>
        <div class="form-group">
          <label>Adjuntar (PDF, imagen, Excel… máx. 10 MB c/u — puedes elegir varios)</label>
          <input type="file" id="adjGuiaArchivo" multiple>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" onclick="window.closeModal('modal-adjunto-guia')">Cerrar</button>
        <button class="btn btn-primary" id="btnSubirAdjGuia" onclick="window.guardarAdjuntoGuia()">Subir</button>
      </div>
    </div>`
  document.body.appendChild(div)
}

async function _pintarActuales() {
  const cont = document.getElementById('adjGuiaActual')
  if (!cont) return
  cont.innerHTML = '<span style="color:var(--text-secondary);">Cargando…</span>'
  const adjs = await getAdjuntos(ENTIDAD_ADJ_GUIA, _guiaAdjId)
  if (!adjs.length) { cont.innerHTML = '<span style="color:var(--text-secondary);">Esta guía todavía no tiene documentos adjuntos.</span>'; return }
  cont.innerHTML = adjs.map(a => `
    <div style="display:flex; align-items:center; gap:8px; padding:6px 0; border-bottom:1px solid var(--border-color);">
      <span class="badge badge-success" style="max-width:300px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${_esc(a.nombre)}">📎 ${_esc(a.nombre || 'Documento')}</span>
      <a href="#" onclick="window.verAdjuntoGuia(${a.id}); return false;">Ver / descargar</a>
      <button type="button" class="btn btn-small btn-danger" style="margin-left:auto;" onclick="window.eliminarAdjuntoGuia(${a.id})" title="Eliminar este documento">✕</button>
    </div>`).join('')
  cont._adjs = adjs
}

window.abrirModalAdjuntoGuia = async function (guiaId, numeroGuia = '') {
  try {
    _asegurarModal()
    _guiaAdjId = guiaId
    document.getElementById('adjGuiaTitulo').textContent = `Documentos de la guía ${numeroGuia || '#' + guiaId}`
    const inp = document.getElementById('adjGuiaArchivo'); if (inp) inp.value = ''
    window.openModal('modal-adjunto-guia')
    await _pintarActuales()
  } catch (e) { showToast('Error: ' + e.message, 'danger') }
}

window.verAdjuntoGuia = async function (adjId) {
  try {
    const a = (document.getElementById('adjGuiaActual')?._adjs || []).find(x => x.id === adjId)
    const url = a ? await getUrlAdjunto(a.path) : null
    if (url) window.open(url, '_blank', 'noopener')
    else showToast('No se pudo generar el enlace', 'warning')
  } catch (e) { showToast(e.message, 'danger') }
}

/** Abre directo los adjuntos de una guía (clic en el 📎 de la tabla). */
window.verAdjuntosGuia = async function (guiaId) {
  try {
    const adjs = await getAdjuntos(ENTIDAD_ADJ_GUIA, guiaId)
    if (!adjs.length) { showToast('Sin adjuntos', 'info'); return }
    for (const a of adjs) { const url = await getUrlAdjunto(a.path); if (url) window.open(url, '_blank', 'noopener') }
  } catch (e) { showToast('No se pudo abrir el adjunto: ' + e.message, 'danger') }
}

window.guardarAdjuntoGuia = async function () {
  const btn = document.getElementById('btnSubirAdjGuia')
  try {
    const files = [...(document.getElementById('adjGuiaArchivo')?.files || [])]
    if (!_guiaAdjId) { showToast('Guía no válida', 'danger'); return }
    if (!files.length) { showToast('Selecciona al menos un archivo', 'warning'); return }
    const malos = files.map(validarArchivoAdjunto).filter(Boolean)
    if (malos.length) { showToast(malos.join(' · '), 'warning', 7000); return }
    if (btn) { btn.disabled = true; btn.textContent = 'Subiendo…' }
    const { ok, errores } = await subirAdjuntos(ENTIDAD_ADJ_GUIA, _guiaAdjId, files.map(file => ({ file, concepto: 'otro' })), (await getCurrentUser())?.db_id || null)
    if (ok) showToast(`${ok} documento(s) adjuntado(s)`, 'success')
    if (errores.length) showToast(errores.join(' · '), 'danger', 8000)
    document.getElementById('adjGuiaArchivo').value = ''
    await _pintarActuales()
    await _alCambiar?.()
  } catch (e) {
    showToast('Error: ' + e.message, 'danger')
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Subir' }
  }
}

window.eliminarAdjuntoGuia = async function (adjId) {
  try {
    if (!confirm('¿Eliminar este documento adjunto de la guía?')) return
    await eliminarAdjunto(adjId)
    showToast('Documento eliminado', 'success')
    await _pintarActuales()
    await _alCambiar?.()
  } catch (e) { showToast('Error: ' + e.message, 'danger') }
}
