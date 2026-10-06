// ============================================================================
// SERIES.JS — Series y correlativos de documentos de Ventas (2026-09-30)
// ============================================================================
// Fuente única: tabla public.series_documentos (ver sql/59_series_documentos_y_packing.sql).
// Antes las series vivían en el navegador (localStorage, jhiro_config_ventas):
// cada PC podía sugerir una serie distinta. Ahora son de la BD.
//
// Regla del correlativo (igual en todos los documentos):
//   siguiente = MAYOR(ultimo_correlativo, correlativo_inicial - 1, maxUsado) + 1
// maxUsado = el mayor número que ya existe en la tabla del documento (ventas o
// packing). Así, aunque alguien escriba un número a mano, nunca se repite, y
// una serie nueva con correlativo inicial 18642 arranca exactamente ahí.
// ============================================================================
import { supabase, getAll, insert, update, deleteRecord } from './supabase-client.js'

let _seriesPromise = null

export function invalidarSeries() { _seriesPromise = null }

export async function getSeries(forzar = false) {
  if (forzar || !_seriesPromise) _seriesPromise = getAll('series_documentos').then(r => r || [])
  return await _seriesPromise
}

/** Series activas de un tipo ('PK','01','03','07','08'); para NC/ND se puede filtrar por aplica_a ('01'/'03'). */
export async function seriesDeTipo(tipo, aplicaA = null) {
  const todas = await getSeries()
  return todas
    .filter(s => s.activo && s.tipo_documento === tipo && (!aplicaA || !s.aplica_a || s.aplica_a === aplicaA))
    .sort((a, b) => (b.por_defecto - a.por_defecto) || a.serie.localeCompare(b.serie))
}

/** Serie por defecto del tipo (o la primera activa). null si la tabla aún no existe / está vacía. */
export async function serieDefault(tipo, aplicaA = null) {
  try {
    const lista = await seriesDeTipo(tipo, aplicaA)
    return lista.find(s => s.por_defecto && (!aplicaA || s.aplica_a === aplicaA)) || lista[0] || null
  } catch { return null }
}

export async function getSerie(tipo, serie) {
  const todas = await getSeries()
  return todas.find(s => s.tipo_documento === tipo && s.serie === serie) || null
}

export function siguienteCorrelativo(serieRow, maxUsado = 0) {
  if (!serieRow) return (parseInt(maxUsado) || 0) + 1
  return Math.max(parseInt(serieRow.ultimo_correlativo) || 0, (parseInt(serieRow.correlativo_inicial) || 1) - 1, parseInt(maxUsado) || 0) + 1
}

export function formatearNumero(serieRow, correlativo, serieTexto = null) {
  const dig = parseInt(serieRow?.digitos) || 8
  return `${serieRow?.serie || serieTexto || ''}-${String(correlativo).padStart(dig, '0')}`
}

/** Tras guardar un documento: sube ultimo_correlativo si el usado es mayor. No falla la operación principal si la tabla no existe. */
export async function registrarUsoSerie(tipo, serie, correlativo) {
  try {
    const s = await getSerie(tipo, serie)
    const n = parseInt(correlativo) || 0
    if (!s || n <= (parseInt(s.ultimo_correlativo) || 0)) return
    await update('series_documentos', s.id, { ultimo_correlativo: n, updated_at: new Date().toISOString() })
    s.ultimo_correlativo = n
  } catch (e) { console.warn('registrarUsoSerie:', e.message) }
}

/** ¿La serie se envía a NUBEFACT? Si no está registrada, se asume que sí (comportamiento de siempre). */
export async function serieEsCPE(tipo, serie) {
  try { const s = await getSerie(tipo, serie); return s ? s.es_cpe !== false : true } catch { return true }
}

export async function addSerie(d)        { const r = await insert('series_documentos', d); invalidarSeries(); return r }
export async function updateSerie(id, d) { const r = await update('series_documentos', id, d); invalidarSeries(); return r }
export async function deleteSerie(id)    { const r = await deleteRecord('series_documentos', id); invalidarSeries(); return r }

export const NOMBRE_TIPO_SERIE = { PK: 'Packing / Cotización', '01': 'Factura', '03': 'Boleta', '07': 'Nota de Crédito', '08': 'Nota de Débito', '09': 'Guía de Remisión' }

// ============================================================================
// GUÍAS DE REMISIÓN (tipo 09) — 2026-10-02, ver sql/62_series_guias_remision.sql
// ----------------------------------------------------------------------------
// Cada serie de comprobante (01/03) dice qué serie de guía genera
// (serie_guia: FFFI→T001, NV01→GN01) y cada serie de guía dice a qué
// ubicación virtual va la venta en el kardex (ubicacion_destino_id:
// T001→Partners/Customers, GN01→Partners/90). T001 la comparten las guías
// de venta y las de devolución a proveedor → el máximo usado mira ambas.
// ============================================================================

/** Separa 'T001-00000123' → { serie: 'T001', correlativo: 123 }. */
export function parseNumeroGuia(numero) {
  const txt = String(numero || '').trim()
  const i = txt.lastIndexOf('-')
  if (i <= 0) return { serie: null, correlativo: 0 }
  return { serie: txt.slice(0, i).toUpperCase(), correlativo: parseInt(txt.slice(i + 1).replace(/\D/g, '')) || 0 }
}

/** Mayor correlativo ya emitido con esa serie (guías de venta + devoluciones a proveedor). */
export async function maxCorrelativoGuia(serie) {
  let max = 0
  for (const tabla of ['guias_despacho_venta', 'guias_devolucion_compra']) {
    try {
      const { data } = await supabase.from(tabla).select('numero_guia').ilike('numero_guia', `${serie}-%`)
      for (const g of (data || [])) { const n = parseNumeroGuia(g.numero_guia).correlativo; if (n > max) max = n }
    } catch { /* tabla aún no creada */ }
  }
  return max
}

/** Serie de guía (fila tipo 09) que genera un comprobante. Sin enlace → la 09 por defecto. */
export async function serieGuiaDeComprobante(tipoComprobante, serieComprobante) {
  try {
    const comp = await getSerie(tipoComprobante, serieComprobante)
    if (comp?.serie_guia) { const g = await getSerie('09', comp.serie_guia); if (g) return g }
    return await serieDefault('09')
  } catch { return null }
}

/** Próximo número completo de una serie de guía, ej. 'T001-00000124'. */
export async function siguienteNumeroGuia(serieGuiaRow) {
  if (!serieGuiaRow) return ''
  return formatearNumero(serieGuiaRow, siguienteCorrelativo(serieGuiaRow, await maxCorrelativoGuia(serieGuiaRow.serie)))
}

/** Fila tipo 09 a partir de un número de guía ya escrito ('GN01-00000005' → serie GN01). */
export async function serieDeNumeroGuia(numero) {
  const { serie } = parseNumeroGuia(numero)
  if (!serie) return null
  try { return await getSerie('09', serie) } catch { return null }
}

/** Tras guardar una guía: sube ultimo_correlativo de su serie (si está registrada). */
export async function registrarUsoGuia(numero) {
  const { serie, correlativo } = parseNumeroGuia(numero)
  if (serie && correlativo) await registrarUsoSerie('09', serie, correlativo)
}
