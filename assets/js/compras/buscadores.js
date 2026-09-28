// ============================================================================
// compras/buscadores.js — parte de compras.js (reorganizado 2026-09-25, sin cambios de lógica)
// Mapa completo de funciones: Claude outputs/glosario_funciones_erp.md
// ============================================================================
import { convertirVarios } from '../buscador-select.js'

// ============================================================================
// BUSCADORES EN VIVO — selects largos del módulo Compras
// ============================================================================
// Mismos selects que antes, pero con filtrado por texto. El <select> original
// sigue oculto detrás, así que ni las validaciones ni los onchange cambian.
// Se convierten después de que cada select ya tiene sus opciones cargadas.

export function _activarBuscadoresCompras() {
  convertirVarios([
    { id: 'ocProveedor',              placeholder: 'Escribe el nombre o RUC del proveedor...', sinResultados: 'Ningún proveedor coincide',
      alCrearNuevo: { label: 'Registrar proveedor nuevo', onClick: () => window.abrirModalNuevoProveedor?.() } },
    { id: 'nqProveedor',              placeholder: 'Escribe el nombre o RUC del proveedor...', sinResultados: 'Ningún proveedor coincide',
      alCrearNuevo: { label: 'Registrar proveedor nuevo', onClick: () => window.abrirModalNuevoProveedor?.() } },
    { id: 'ngCompra',                 placeholder: 'Escribe el N° de compra o proveedor...',   sinResultados: 'Sin compras pendientes de guía' },
    { id: 'newDetalleCompraProducto', placeholder: 'Escribe el producto o SKU...',             sinResultados: 'Sin productos' },
    { id: 'newDetalleOCProducto',     placeholder: 'Escribe el producto o SKU...',             sinResultados: 'Sin productos' },
    { id: 'loteProducto',             placeholder: 'Escribe el producto o SKU...',             sinResultados: 'Sin productos' },
    { id: 'csCuentaGasto',            placeholder: 'Escribe la cuenta contable...',            sinResultados: 'Sin cuentas' }
  ])
}

export function _escCompras(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}
