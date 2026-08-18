// ============================================================================
// ANULACION.JS — Anulación de comprobantes (ventas, compras y guías)
// ============================================================================
// Módulo compartido: los 4 documentos anulables usan el mismo modal, las
// mismas reglas de auditoría y la misma forma de marcar el estado.
//
// PRINCIPIO: anular NO borra. El comprobante queda en la base con
// `comprobante_anulado = true` y `estado_comprobante = '0'` (o `estado =
// 'anulada'` en las guías), más fecha, motivo y usuario que lo anuló. Esto es
// lo que exige SUNAT: un comprobante emitido debe seguir figurando en el
// Registro de Ventas/Compras aunque se haya anulado, y la numeración no se
// puede reutilizar.
//
// Los efectos colaterales (revertir stock, anular la CxC/CxP, reversar el
// asiento) los define cada módulo y se pasan como callback `onConfirmar`.
// ============================================================================

import { getCurrentUser } from './auth-supabase.js'

export const ESTADO_COMPROBANTE = {
  VALIDO:        '1',   // anotación que corresponde al periodo
  EXTEMPORANEO:  '2',   // comprobante de un periodo anterior anotado ahora
  ANULADO:       '0'
}

/** Motivos típicos; el usuario puede escribir uno libre igualmente. */
const MOTIVOS_SUGERIDOS = [
  'Error en los datos del cliente/proveedor',
  'Error en el importe o en el detalle',
  'Operación no realizada',
  'Duplicidad del comprobante',
  'Devolución total de la mercadería',
  'Anulación por acuerdo con la contraparte'
]

let _onConfirmarActual = null

/** Inyecta el modal una sola vez por página (no hace falta tocar cada HTML). */
function _asegurarModal() {
  if (document.getElementById('modal-anular-documento')) return

  const div = document.createElement('div')
  div.id = 'modal-anular-documento'
  div.className = 'modal'
  div.innerHTML = `
    <div class="modal-content" style="max-width:560px;">
      <div class="modal-header">
        <h3 class="modal-title">Anular documento</h3>
        <button class="modal-close" onclick="window.cerrarModalAnulacion()">&times;</button>
      </div>
      <div style="padding:20px; display:flex; flex-direction:column; gap:14px;">
        <div id="anul-cabecera" style="padding:12px 14px; background:var(--bg-secondary); border-radius:var(--radius-md); border-left:3px solid var(--color-danger);"></div>

        <div id="anul-efectos" style="font-size:0.85rem; color:var(--text-secondary); line-height:1.55;"></div>

        <div id="anul-bloqueo" style="display:none; padding:12px 14px; border-radius:var(--radius-md); background:rgba(239,68,68,.12); color:var(--color-danger); font-size:0.87rem; line-height:1.5;"></div>

        <div id="anul-formulario">
          <div class="form-group">
            <label>Motivo de la anulación *</label>
            <input type="text" id="anulMotivo" list="anul-motivos-sugeridos" placeholder="Explica por qué se anula (queda registrado)">
            <datalist id="anul-motivos-sugeridos">
              ${MOTIVOS_SUGERIDOS.map(m => `<option value="${m}">`).join('')}
            </datalist>
            <small style="color:var(--text-secondary);">Este texto queda guardado como sustento de la anulación.</small>
          </div>
          <div class="form-group">
            <label>Fecha de anulación</label>
            <input type="date" id="anulFecha" style="max-width:200px;">
          </div>
          <label style="display:flex; align-items:flex-start; gap:9px; cursor:pointer; margin-top:6px; font-weight:normal;">
            <input type="checkbox" id="anulConfirmo" style="margin-top:3px;">
            <span style="font-size:0.87rem;">Confirmo que entiendo que esta acción no se puede deshacer y que el documento quedará registrado como anulado.</span>
          </label>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" onclick="window.cerrarModalAnulacion()">Cancelar</button>
        <button class="btn btn-danger" id="anulBtnConfirmar" onclick="window.confirmarAnulacion()">🚫 Anular documento</button>
      </div>
    </div>`
  document.body.appendChild(div)
}

/**
 * Abre el modal de anulación.
 *
 * @param {object} opciones
 *   titulo      {string}   Ej. 'Anular Factura de Venta'
 *   documento   {string}   Ej. 'F001-00000123'
 *   detalle     {string}   Línea secundaria: cliente, monto, fecha…
 *   efectos     {string[]} Qué va a pasar al anular (se listan al usuario)
 *   bloqueos    {string[]} Motivos por los que NO se puede anular (si hay ≥1
 *                          se muestra el aviso y se desactiva el botón)
 *   onConfirmar {Function} async ({ motivo, fecha, usuarioId }) => void
 */
export function abrirModalAnulacion(opciones) {
  _asegurarModal()
  const { titulo, documento, detalle, efectos = [], bloqueos = [], onConfirmar } = opciones

  const tituloEl = document.querySelector('#modal-anular-documento .modal-title')
  if (tituloEl) tituloEl.textContent = titulo || 'Anular documento'

  const cab = document.getElementById('anul-cabecera')
  if (cab) {
    cab.innerHTML = `
      <div style="font-weight:600; font-size:1.05rem;">${_esc(documento || '')}</div>
      ${detalle ? `<div style="font-size:0.85rem; color:var(--text-secondary); margin-top:2px;">${_esc(detalle)}</div>` : ''}`
  }

  const efe = document.getElementById('anul-efectos')
  if (efe) {
    efe.innerHTML = efectos.length
      ? `<strong style="color:var(--text-primary);">Al anular:</strong><ul style="margin:6px 0 0 18px; padding:0;">${efectos.map(e => `<li>${_esc(e)}</li>`).join('')}</ul>`
      : ''
  }

  const blo  = document.getElementById('anul-bloqueo')
  const form = document.getElementById('anul-formulario')
  const btn  = document.getElementById('anulBtnConfirmar')
  const hayBloqueo = bloqueos.length > 0

  if (blo) {
    blo.style.display = hayBloqueo ? 'block' : 'none'
    blo.innerHTML = hayBloqueo
      ? `<strong>No se puede anular todavía:</strong><ul style="margin:6px 0 0 18px; padding:0;">${bloqueos.map(b => `<li>${_esc(b)}</li>`).join('')}</ul>`
      : ''
  }
  if (form) form.style.display = hayBloqueo ? 'none' : 'block'
  if (btn) {
    btn.style.display = hayBloqueo ? 'none' : ''
    btn.disabled = false
    btn.textContent = '🚫 Anular documento'
  }

  const fecha = document.getElementById('anulFecha')
  if (fecha) fecha.value = new Date().toISOString().split('T')[0]
  const motivo = document.getElementById('anulMotivo')
  if (motivo) motivo.value = ''
  const chk = document.getElementById('anulConfirmo')
  if (chk) chk.checked = false

  _onConfirmarActual = onConfirmar
  window.openModal('modal-anular-documento')
}

window.cerrarModalAnulacion = function () {
  _onConfirmarActual = null
  window.closeModal('modal-anular-documento')
}

window.confirmarAnulacion = async function () {
  const motivo = document.getElementById('anulMotivo')?.value?.trim()
  const fecha  = document.getElementById('anulFecha')?.value
  const chk    = document.getElementById('anulConfirmo')?.checked
  const btn    = document.getElementById('anulBtnConfirmar')

  if (!motivo || motivo.length < 5) {
    window.showToast?.('Escribe el motivo de la anulación (mínimo 5 caracteres)', 'warning')
    return
  }
  if (!fecha) { window.showToast?.('Indica la fecha de anulación', 'warning'); return }
  if (!chk)   { window.showToast?.('Marca la casilla de confirmación para continuar', 'warning'); return }
  if (typeof _onConfirmarActual !== 'function') { window.cerrarModalAnulacion(); return }

  // Se bloquea el botón durante el proceso: anular dispara varias escrituras
  // encadenadas (stock, CxC/CxP, asiento) y un doble click las duplicaría.
  if (btn) { btn.disabled = true; btn.textContent = 'Anulando…' }

  try {
    const user = getCurrentUser()
    await _onConfirmarActual({ motivo, fecha, usuarioId: user?.db_id || null })
    window.cerrarModalAnulacion()
  } catch (e) {
    console.error('confirmarAnulacion:', e)
    window.showToast?.('No se pudo anular: ' + e.message, 'danger')
    if (btn) { btn.disabled = false; btn.textContent = '🚫 Anular documento' }
  }
}

// ============================================================================
// HELPERS COMPARTIDOS
// ============================================================================

/** Campos que se escriben en cualquier documento anulado. */
export function camposAnulacion({ motivo, fecha, usuarioId }, { usaEstadoComprobante = true } = {}) {
  const base = {
    fecha_anulacion:  fecha,
    motivo_anulacion: motivo,
    anulado_por:      usuarioId
  }
  return usaEstadoComprobante
    ? { ...base, comprobante_anulado: true, estado_comprobante: ESTADO_COMPROBANTE.ANULADO }
    : { ...base, estado: 'anulada' }
}

/** ¿Este documento está anulado? Sirve para ventas, compras y guías. */
export function estaAnulado(doc) {
  if (!doc) return false
  return doc.comprobante_anulado === true ||
         doc.estado === 'anulada' ||
         String(doc.estado_comprobante ?? '') === ESTADO_COMPROBANTE.ANULADO
}

/** Badge HTML uniforme para los listados. */
export function badgeAnulado(doc) {
  if (!estaAnulado(doc)) return ''
  const t = doc.fecha_anulacion ? ` title="Anulado el ${doc.fecha_anulacion}${doc.motivo_anulacion ? ' — ' + doc.motivo_anulacion : ''}"` : ''
  return `<span class="badge badge-danger"${t}>ANULADO</span>`
}

/** Estilo de fila para documentos anulados (tachado y atenuado). */
export const ESTILO_FILA_ANULADA = 'opacity:.55; text-decoration:line-through; text-decoration-thickness:1px;'

function _esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}
