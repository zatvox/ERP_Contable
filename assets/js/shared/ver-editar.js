// ============================================================================
// shared/ver-editar.js — ESTÁNDAR "Ver (ojito) → Editar" para modales del ERP
// ============================================================================
// Todo modal de un registro se abre en MODO LECTURA y el botón "✏️ Editar"
// habilita los campos. Cómo usarlo:
//   1. Campo/fila con 👁 al extremo derecho:  ojoBtn("window.verX(12)", "Ver / editar X")
//   2. En el modal marca los botones del footer:
//        data-solo-lectura  → visibles solo al ver  (Cerrar, ✏️ Editar)
//        data-solo-edicion  → visibles solo al editar (Cancelar, 💾 Guardar)
//      y los campos que NUNCA se editan con  data-siempre-lectura.
//   3. Al abrir:  aplicarModoVerEditar('modal-id', true)
//      Botón Editar: aplicarModoVerEditar('modal-id', false)
//      Cancelar: vuelve a abrir el registro (descarta cambios) en modo lectura.
// Ver compras-editar.js (_ecModoVista) y estándar en el proyecto:
//   claude/estandar_diseno_links_moneda_adjuntos_2026-10-22.md  §6
// ============================================================================

/** HTML del botón 👁 (usa la clase .ojo-btn de styles.css). */
export function ojoBtn(onclick, titulo = 'Ver detalle') {
  return `<button type="button" class="ojo-btn" onclick="${onclick}" title="${titulo}" aria-label="${titulo}">👁</button>`
}

/** Pone un modal en modo lectura (true) o edición (false). */
export function aplicarModoVerEditar(modalId, lectura) {
  const m = document.getElementById(modalId)
  if (!m) return
  m.dataset.modo = lectura ? 'lectura' : 'edicion'
  m.querySelectorAll('input, select, textarea').forEach(el => {
    if (el.type === 'hidden') return
    el.disabled = lectura || el.hasAttribute('data-siempre-lectura')
  })
  // Un campo-buscador deshabilitado no dispara blur: su lista (fixed) quedaba abierta y flotando fuera del campo.
  m.querySelectorAll('.bsq-caja.abierta').forEach(c => c.classList.remove('abierta'))
  m.querySelectorAll('[data-solo-lectura]').forEach(b => { b.style.display = lectura ? '' : 'none' })
  m.querySelectorAll('[data-solo-edicion]').forEach(b => { b.style.display = lectura ? 'none' : '' })
}

window.aplicarModoVerEditar = aplicarModoVerEditar
export default { ojoBtn, aplicarModoVerEditar }
