// ============================================================================
// ventas/state.js — parte de ventas.js (reorganizado 2026-09-25, sin cambios de lógica)
// Mapa completo de funciones: Claude outputs/glosario_funciones_erp.md
// ============================================================================
// Estado compartido entre submódulos (antes eran `let` sueltos en ventas.js).
// Se usa como S.nombre para que cualquier submódulo pueda reasignarlo.
export const S = {
  _clientes: [],
  _items: [],
  _lotes: [],
  _vendedores: [],
  _ventaLineas: [],
  _ventaLineaEditIdx: null,
  _stockUbic: [],
  _lotesMap: {},
  _tipoVentaActual: 'mercaderia',
  _anticiposVentaDisponiblesCache: [],
  _guiaDespachoLineas: [],
  _guiaDespachoZonasCache: [],
  _guiasDespachoLista: null,
  _guiaDespachoEditId: null,
}
