// ============================================================================
// compras/state.js — parte de compras.js (reorganizado 2026-09-25, sin cambios de lógica)
// Mapa completo de funciones: Claude outputs/glosario_funciones_erp.md
// ============================================================================
// Estado compartido entre submódulos (antes eran `let` sueltos en compras.js).
// Se usa como S.nombre para que cualquier submódulo pueda reasignarlo.
export const S = {
  _ecContexto: null,
  _ecModoVista: true,
  _guiaLineas: [],
  _guiaComprasCache: null,
  _guiaIngresoEditId: null,
  _guiaMarcasCache: [],
  _guiaZonasCache: [],
  _guiaLotesPorItem: {},
  _guiaZonasNombre: {},
  _guiaCompraActual: null,
}
