// ============================================================================
// shared/igv-tipos.js — Lista editable de "Tipos de IGV" del módulo Compras
// ============================================================================
// Se edita en Compras → Configuración → "Tipos de IGV" (guardada en
// localStorage junto al resto de la config del módulo: compras.tiposIGV).
// TODOS los selectores de IGV de Compras (servicio, anticipo, OC, mercadería,
// editar compra, notas, gasto de importación) se llenan desde aquí.
//
// Cada tipo: { etiqueta, igv, ipm, incluido, activo }
//   · % total que se aplica a la línea = igv + ipm  (ej. MYPE 2026: 8 + 2.5 = 10.5)
//   · incluido = el precio unitario ya trae el IGV (se extrae, no se suma)
//   · el valor del <option> es el % total ("10.5") o "10.5-inc" si es incluido,
//     igual que siempre (_calcularMontosDetalleCompra ya lo entiende).
// Los documentos ya registrados guardan su propio % por línea (igv_porcentaje):
// cambiar un tipo aquí NO modifica el historial.
//
// NOTA PARA LA SESIÓN DE CONTABILIDAD: el desglose igv/ipm queda en la
// configuración (no por documento). Si el registro de compras / PDT 621 exige
// separar IGV e IPM por comprobante, derivarlo del % de la línea con esta lista.
// ============================================================================

import { getModuloConfig, guardarModuloConfig } from '../config-modulo.js'

const r4 = n => Math.round((parseFloat(n) || 0) * 10000) / 10000
const esc = t => String(t ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

const RESPALDO = [
  { etiqueta: '18%', igv: 16, ipm: 2, incluido: false, activo: true },
  { etiqueta: '0% — Exonerado / No gravada (exterior)', igv: 0, ipm: 0, incluido: false, activo: true }
]

/** Tipos activos con su valor de <option>. `incluido:true` agrega los "IGV incluido". */
export function tiposIGV({ incluido = false } = {}) {
  let lista = getModuloConfig('compras').tiposIGV
  if (!Array.isArray(lista) || !lista.some(t => t && t.activo !== false)) lista = RESPALDO
  return lista
    .filter(t => t && t.activo !== false && (incluido || !t.incluido))
    .map(t => {
      const pct = r4((parseFloat(t.igv) || 0) + (parseFloat(t.ipm) || 0))
      return { ...t, pct, valor: String(pct) + (t.incluido ? '-inc' : '') }
    })
}

/** Valor de <option> del tipo por defecto (compras.igvDefault si existe en la lista, si no el primero). */
export function valorIGVDefault({ incluido = false } = {}) {
  const lista = tiposIGV({ incluido })
  const d = String(getModuloConfig('compras').igvDefault ?? '')
  return (lista.find(t => t.valor === d && !t.incluido) || lista[0])?.valor || '18'
}

/** <option>…</option> listos para insertar. `valor` = seleccionado; si no está en la lista
 *  (documento antiguo con un % ya retirado) se agrega como "(histórico)" para no perderlo. */
export function opcionesIGVHtml({ incluido = false, valor = null } = {}) {
  const lista = tiposIGV({ incluido })
  const sel = valor == null ? valorIGVDefault({ incluido }) : String(valor)
  let html = lista.map(t =>
    `<option value="${esc(t.valor)}"${t.valor === sel ? ' selected' : ''}${t.incluido ? ' title="El precio unitario ya incluye el IGV: se extrae en vez de sumarse encima."' : ''}>${esc(t.etiqueta)}</option>`).join('')
  if (valor != null && !lista.some(t => t.valor === sel)) {
    html += `<option value="${esc(sel)}" selected>${esc(sel.replace('-inc', ''))}% (histórico)</option>`
  }
  return html
}

/** Rellena un <select> existente conservando su selección actual si sigue en la lista. */
export function poblarSelectIGV(id, { incluido = false, valor = null } = {}) {
  const el = document.getElementById(id)
  if (!el) return
  const actual = valor != null ? String(valor) : (el.options.length ? el.value : null)
  el.innerHTML = opcionesIGVHtml({ incluido, valor: actual })
  if (actual != null) el.value = el.querySelector(`option[value="${CSS.escape(actual)}"]`) ? actual : el.options[0]?.value
}

/** Selectores estáticos de compras.html. */
export function poblarTodosIGV() {
  poblarSelectIGV('csIGV')
  poblarSelectIGV('atIGV')
  poblarSelectIGV('newDetalleOCIGV')
  poblarSelectIGV('newDetalleCompraIGV', { incluido: true })
}

/** Guarda la lista (ya validada) y avisa a los selectores abiertos. */
export function guardarTiposIGV(lista) {
  guardarModuloConfig('compras', { tiposIGV: lista })
  window.dispatchEvent(new CustomEvent('zv-igv-tipos-cambiado'))
}

window.addEventListener('zv-igv-tipos-cambiado', poblarTodosIGV)
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', poblarTodosIGV)
else poblarTodosIGV()
