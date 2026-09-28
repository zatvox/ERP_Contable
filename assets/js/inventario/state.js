// ============================================================================
// inventario/state.js — parte de inventario.js (reorganizado 2026-09-25, sin cambios de lógica)
// Mapa completo de funciones: Claude outputs/glosario_funciones_erp.md
// ============================================================================
// Estado compartido entre submódulos (antes eran `let` sueltos en inventario.js).
// Se usa como S.nombre para que cualquier submódulo pueda reasignarlo.
export const S = {
  _detallesTrasladoEnCreacion: [],
}
