// ============================================================================
// SUPABASE-CLIENT.JS - Cliente Supabase para JHIRO ERP
// ============================================================================
// Un solo cliente con anon key. Las políticas RLS + JWT del usuario
// autenticado se encargan del control de acceso. No se necesita
// service_role key en el frontend.
// ============================================================================

import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.39.3/+esm'
import { SUPABASE_CONFIG } from './config.js'

export const supabase = createClient(SUPABASE_CONFIG.URL, SUPABASE_CONFIG.ANON_KEY)

// ============================================================================
// HELPERS CRUD
// ============================================================================

export async function getAll(table) {
  try {
    const { data, error } = await supabase.from(table).select('*')
    if (error) { console.error(`Error fetching ${table}:`, error); return [] }
    return data || []
  } catch (e) { console.error('Error en getAll:', e); return [] }
}

export async function getById(table, id) {
  try {
    const { data, error } = await supabase.from(table).select('*').eq('id', id).single()
    if (error) { console.error(`Error fetching ${table} by ID:`, error); return null }
    return data
  } catch (e) { console.error('Error en getById:', e); return null }
}

export async function insert(table, data) {
  try {
    console.log("Datos a insertar:", data);
    const { data: result, error } = await supabase.from(table).insert([data]).select()
    if (error) { console.error(`Error inserting into ${table}:`, error); return null }
    return result ? result[0] : null
  } catch (e) { console.error('Error en insert:', e); return null }
}

export async function update(table, id, data) {
  try {
    // Nunca enviar 'id' ni 'created_at' en el payload: las PK son GENERATED ALWAYS (error 428C9)
    const { id: _omit, created_at: _omit2, ...clean } = data || {}
    const { data: result, error } = await supabase.from(table).update(clean).eq('id', id).select()
    if (error) { console.error(`Error updating ${table}:`, error); return null }
    return result ? result[0] : 'sin resultado'
  } catch (e) { console.error('Error en update:', e); return null }
}

// Última razón por la que falló un delete. Los módulos la leen con
// `ultimoErrorDelete()` para poder mostrar en pantalla QUÉ tabla está
// bloqueando el borrado, en vez del genérico "no se pudo eliminar" que
// obligaba a abrir la consola.
let _ultimoErrorDelete = null

export function ultimoErrorDelete() { return _ultimoErrorDelete }

export async function deleteRecord(table, id) {
  _ultimoErrorDelete = null
  try {
    const { error } = await supabase.from(table).delete().eq('id', id)
    if (error) {
      console.error(`Error deleting from ${table}:`, error)
      _ultimoErrorDelete = _interpretarErrorDelete(error, table)
      return false
    }
    return true
  } catch (e) {
    console.error('Error en deleteRecord:', e)
    _ultimoErrorDelete = { mensaje: e.message, tabla: null, codigo: null }
    return false
  }
}

/**
 * Traduce el error de Postgres a algo accionable.
 * 23503 = foreign_key_violation: otra tabla todavía apunta a este registro.
 * Postgres pone el nombre de esa tabla en `details`, con el formato
 * 'Key is still referenced from table "cuentas_pagar".'
 */
function _interpretarErrorDelete(error, tabla) {
  const codigo = error?.code || null
  if (codigo === '23503') {
    const m = /from table "([^"]+)"/.exec(error?.details || '')
    const tablaBloqueante = m ? m[1] : null
    const legibles = {
      cuentas_pagar: 'Cuentas por Pagar', cuentas_cobrar: 'Cuentas por Cobrar',
      cobros: 'Cobros', pagos_proveedores: 'Pagos a Proveedores',
      guias_ingreso_compra: 'Guías de Ingreso', guias_despacho_venta: 'Guías de Despacho',
      detalle_compras: 'Detalle de la compra', detalle_ventas: 'Detalle de la venta',
      lotes: 'Lotes de inventario', kardex: 'Movimientos de Kardex',
      journal_entries: 'Asientos contables', ventas: 'Ventas (notas de crédito/débito)',
      compras: 'Compras (notas de crédito/débito)'
    }
    const nombre = legibles[tablaBloqueante] || tablaBloqueante || 'otro registro'
    return {
      codigo,
      tabla: tablaBloqueante,
      mensaje: `todavía está referenciado desde ${nombre}. Elimina o desvincula eso primero.`
    }
  }
  return { codigo, tabla: null, mensaje: error?.message || 'error desconocido' }
}

export async function query(table, filters = {}) {
  try {
    let q = supabase.from(table).select('*')
    Object.keys(filters).forEach(key => { q = q.eq(key, filters[key]) })
    const { data, error } = await q
    if (error) { console.error(`Error querying ${table}:`, error); return [] }
    return data || []
  } catch (e) { console.error('Error en query:', e); return [] }
}

export function subscribe(table, callback) {
  return supabase
    .channel(`public:${table}`)
    .on('postgres_changes', { event: '*', schema: 'public', table }, callback)
    .subscribe()
}