// ============================================================================
// MODAL-GUARDIA.JS — Confirmar antes de cerrar un modal con cambios (2026-10-06)
// ============================================================================
// Aplica a TODOS los modales del ERP (.modal), sin tocar cada formulario:
//   · Un modal queda "con cambios" cuando el USUARIO escribe/elige algo en él
//     (eventos input/change con isTrusted — lo que llena el código al abrir
//     NO cuenta) o pulsa un botón que agrega/quita líneas.
//   · Lo que se edita en un sub-modal (ej. "Agregar Producto") también marca
//     al modal padre abierto: es parte del mismo documento.
//   · Al intentar cerrar por la ✕, un botón "Cancelar" o clic fuera, pide
//     confirmación. Los cierres que hace el código tras GUARDAR no preguntan
//     (no pasan por un clic del usuario).
//   · Al abrirse o cerrarse un modal, su marca se limpia sola.
// Excluir un modal: atributo data-sin-guardia, o id en EXCLUIDOS (ya tiene
// su propia confirmación).
// ============================================================================

const EXCLUIDOS = new Set(['modal-nueva-guia'])
const _sucios = new Set()

const _aplica = (modal) => modal && modal.classList?.contains('modal') && !EXCLUIDOS.has(modal.id) && !modal.hasAttribute('data-sin-guardia')
const _abiertos = () => [...document.querySelectorAll('.modal.show')]

export function marcarModalSucio(modalOrId) {
  const m = typeof modalOrId === 'string' ? document.getElementById(modalOrId) : modalOrId
  if (_aplica(m)) _sucios.add(m)
}
export function limpiarModalSucio(modalOrId) {
  const m = typeof modalOrId === 'string' ? document.getElementById(modalOrId) : modalOrId
  if (m) _sucios.delete(m)
}
window.marcarModalSucio = marcarModalSucio
window.limpiarModalSucio = limpiarModalSucio

function _marcarDesde(el) {
  const m = el?.closest?.('.modal')
  if (!_aplica(m) || !m.classList.contains('show')) return
  // el modal donde se editó + los otros abiertos (padre de un sub-modal)
  _abiertos().forEach(x => { if (_aplica(x)) _sucios.add(x) })
}

// 1) Cambios hechos por el usuario
const _onEdit = (e) => {
  if (!e.isTrusted) return
  const t = e.target
  if (!t || !(t.matches?.('input, select, textarea'))) return
  if (t.type === 'button' || t.type === 'submit') return
  _marcarDesde(t)
}
document.addEventListener('input', _onEdit, true)
document.addEventListener('change', _onEdit, true)

// Botones que cambian el contenido (agregar/quitar/retirar líneas)
const _RE_EDITA = /agregar|quitar|retirar|eliminarlinea|_pkfacsel|_pkfacretirar|nuevalinea|anadir|añadir/i

// 2) Intento de cierre por el usuario → confirmar si hay cambios
const _esCierre = (el, modal) => {
  if (!el) return false
  if (el === modal) return true                                   // clic en el fondo
  const btn = el.closest('button, .modal-close, [role="button"]')
  if (!btn || !modal.contains(btn)) return false
  if (btn.classList.contains('modal-close')) return true
  const oc = btn.getAttribute('onclick') || ''
  if (/closeModal\(|cerrarModal|cerrar\w*Modal/i.test(oc) && !/guardar|emitir|confirmar/i.test(oc)) return true
  return /^\s*(✕\s*)?cancelar\s*$/i.test(btn.textContent || '')
}

document.addEventListener('click', (e) => {
  if (!e.isTrusted) return
  const modal = e.target.closest?.('.modal') || (e.target.classList?.contains('modal') ? e.target : null)
  if (!modal || !modal.classList.contains('show')) return

  if (_esCierre(e.target, modal)) {
    if (!_sucios.has(modal)) return
    if (confirm('Tienes cambios sin guardar en este formulario.\n\n¿Cerrar y descartarlos?')) {
      _sucios.delete(modal)
      return                                                        // sigue el cierre normal
    }
    e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation()
    return
  }
  // botón que agrega/quita líneas → también cuenta como cambio
  const btn = e.target.closest('button')
  if (btn && _RE_EDITA.test(btn.getAttribute('onclick') || '')) _marcarDesde(btn)
}, true)

// 3) Abrir / cerrar (por cualquier vía: openModal, closeModal, clase 'show') → limpiar marca
const _obs = new MutationObserver((muts) => {
  for (const m of muts) {
    const el = m.target
    if (!el.classList?.contains('modal')) continue
    const ahora = el.classList.contains('show')
    const antes = (m.oldValue || '').split(/\s+/).includes('show')
    if (ahora !== antes) _sucios.delete(el)
  }
})
const _iniciar = () => _obs.observe(document.body, { subtree: true, attributes: true, attributeFilter: ['class'], attributeOldValue: true })
if (document.body) _iniciar(); else document.addEventListener('DOMContentLoaded', _iniciar)
