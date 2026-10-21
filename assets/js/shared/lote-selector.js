// ============================================================================
// LOTE-SELECTOR.JS — Componente compartido: elegir un lote EXISTENTE
// ============================================================================
// Estándar del ERP: un campo que REFERENCIA un lote se elige de un selector;
// un campo que CREA el lote (modal "Nuevo Lote") se escribe a mano. Nunca se
// teclea el número de un lote que ya existe: si el texto no calza exacto con
// `lotes.numero_lote`, el enlace se rompe en silencio y el stock sale en 0.
//
// Uso:
//   await llenarSelectorLote('newDetalleLote', { itemId, compraId, loteId })
//   const v = leerSelectorLote('newDetalleLote')   → { lote_id, lote }
//   const err = await validarLoteCI(v.lote_id, { itemId, excluirDetalleId })
//
// Multiempresa: `lotes` está en TABLAS_EMPRESA, así que la consulta ya sale
// filtrada por las empresas activas del chip.
// ============================================================================

import { query } from '../supabase-client.js'
import { formatNumber } from '../helpers.js'

const n2 = v => formatNumber(parseFloat(v) || 0, 2)

/** Cache por item para no re-consultar en cada apertura del modal. */
const _cache = new Map()

export function limpiarCacheLotes() { _cache.clear() }

/** Lotes de un producto (de las empresas activas). */
export async function getLotesDeItem(itemId, { forzar = false } = {}) {
  if (!itemId) return []
  const key = String(itemId)
  if (!forzar && _cache.has(key)) return _cache.get(key)
  const filas = (await query('lotes', { item_id: parseInt(itemId) })) || []
  filas.sort((a, b) => String(b.numero_lote || '').localeCompare(String(a.numero_lote || ''), 'es', { numeric: true }))
  _cache.set(key, filas)
  return filas
}

function _etiqueta(l) {
  const partes = [l.numero_lote]
  partes.push(`${n2(l.cantidad)} kg`)
  if (l.costo_estado === 'provisional') partes.push('costo provisional')
  if (l.numero_factura) partes.push(l.numero_factura)
  return partes.filter(Boolean).join(' · ')
}

/**
 * Llena un <select> con los lotes del producto.
 *   itemId    : producto de la línea (obligatorio para que la lista sea corta y correcta)
 *   compraId  : si la carpeta nace de una compra, esos lotes van primero
 *   loteId    : lote ya enlazado (lo deja seleccionado aunque no esté en la lista)
 *   loteTexto : número de lote heredado como texto (datos viejos sin lote_id)
 */
export async function llenarSelectorLote(idOrEl, { itemId, compraId = null, loteId = null, loteTexto = '' } = {}) {
  const sel = typeof idOrEl === 'string' ? document.getElementById(idOrEl) : idOrEl
  if (!sel) return { lotes: [] }

  if (!itemId) {
    sel.innerHTML = '<option value="">— Elige primero el producto —</option>'
    sel.disabled = true
    return { lotes: [] }
  }

  sel.disabled = false
  const lotes = await getLotesDeItem(itemId)
  const deCompra = compraId ? lotes.filter(l => l.compra_id === parseInt(compraId)) : []
  const otros = lotes.filter(l => !deCompra.includes(l))

  const opt = l => `<option value="${l.id}" data-lote="${l.numero_lote}" ${String(l.id) === String(loteId) ? 'selected' : ''}>${_etiqueta(l)}</option>`
  let html = '<option value="">— Sin lote asignado todavía —</option>'
  if (deCompra.length) html += `<optgroup label="Lotes de esta compra">${deCompra.map(opt).join('')}</optgroup>`
  if (otros.length)    html += `<optgroup label="${deCompra.length ? 'Otros lotes del producto' : 'Lotes del producto'}">${otros.map(opt).join('')}</optgroup>`
  if (!lotes.length)   html += '<option value="" disabled>(este producto no tiene lotes registrados)</option>'

  // Dato viejo: tenía texto de lote pero no existe un lote con ese número.
  if (!loteId && loteTexto && !lotes.some(l => l.numero_lote === loteTexto)) {
    html += `<optgroup label="Texto heredado (no existe como lote)"><option value="" data-lote="${loteTexto}" selected>${loteTexto} — sin vincular</option></optgroup>`
  }

  sel.innerHTML = html
  if (loteId) sel.value = String(loteId)
  return { lotes, deCompra: deCompra.length, otros: otros.length }
}

/** Lee el select: devuelve el id y el número de lote que hay que guardar. */
export function leerSelectorLote(idOrEl) {
  const sel = typeof idOrEl === 'string' ? document.getElementById(idOrEl) : idOrEl
  if (!sel) return { lote_id: null, lote: '' }
  const op = sel.options[sel.selectedIndex]
  return {
    lote_id: sel.value ? parseInt(sel.value) : null,
    lote: (op && op.dataset && op.dataset.lote) ? op.dataset.lote : ''
  }
}

/**
 * Validaciones de un lote elegido para una línea de Commercial Invoice.
 * Devuelve un mensaje de error, o null si está bien.
 *   itemId          : el producto de la línea
 *   excluirDetalleId: al editar, la propia línea no cuenta como duplicado
 *   pesoLinea       : peso neto de la línea, para avisar de diferencias
 */
export async function validarLoteCI(loteId, { itemId, excluirDetalleId = null, pesoLinea = null } = {}) {
  if (!loteId) return null                       // "sin asignar" es válido: se vincula después

  const lotes = await getLotesDeItem(itemId)
  const lote = lotes.find(l => l.id === parseInt(loteId))

  // 1) El lote tiene que ser del mismo producto (y de una empresa activa)
  if (!lote) {
    return 'El lote elegido no pertenece a este producto o es de otra empresa. Vuelve a elegirlo.'
  }

  // 2) Un lote no puede estar enlazado a dos líneas de Commercial Invoice
  const usados = (await query('detalle_comercial_invoice', { lote_id: parseInt(loteId) })) || []
  const otro = usados.find(d => String(d.id) !== String(excluirDetalleId))
  if (otro) {
    return `El lote ${lote.numero_lote} ya está enlazado a otra línea de Commercial Invoice (línea #${otro.id}). Un lote pertenece a una sola línea.`
  }

  // 3) Aviso de peso: no bloquea, pero el costo/kg se calcula sobre el peso
  //    de la línea y el stock sale del lote.
  if (pesoLinea && parseFloat(lote.cantidad) > 0) {
    const dif = Math.abs(parseFloat(lote.cantidad) - parseFloat(pesoLinea))
    if (dif / parseFloat(pesoLinea) > 0.05) {
      return `AVISO: el lote ${lote.numero_lote} tiene ${n2(lote.cantidad)} kg y la línea declara ${n2(pesoLinea)} kg (${n2(dif)} kg de diferencia). Si es merma, registra el peso recibido; si no, revisa el lote.`
    }
  }

  return null
}

/** true si el mensaje de validarLoteCI es solo un aviso (se puede continuar). */
export const esAviso = msg => !!msg && msg.startsWith('AVISO:')

export default { llenarSelectorLote, leerSelectorLote, validarLoteCI, getLotesDeItem, limpiarCacheLotes, esAviso }
