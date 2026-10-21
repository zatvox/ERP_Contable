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
// CONTEXTO MULTIEMPRESA — EL ÚNICO PUNTO DE FILTRADO DEL SISTEMA
// ============================================================================
// El filtro por empresa NO se pone pantalla por pantalla: son ~150 funciones
// get* en supabase-data.js y basta que a una se le olvide para que se vea
// data de otra empresa. Se pone aquí, en el cuello de botella por donde
// pasan todas.
//
// `empresa.js` se registra con `registrarContextoEmpresa()` durante el
// top-level await de auth-init.js, ANTES de que cualquier módulo consulte.
// Mientras no esté registrado no se filtra nada — eso es a propósito: así
// `empresa.js` puede leer `empresa_config` para arrancar.

let _ctxEmpresa = null

export function registrarContextoEmpresa(ctx) { _ctxEmpresa = ctx }

/**
 * Espera a que el contexto de empresa esté resuelto.
 *
 * El problema que resuelve: `initEmpresaContexto()` es asíncrono, y la
 * primera pantalla de un módulo (el tab por defecto) dispara sus consultas
 * mientras todavía está en vuelo. Antes eso devolvía la tabla COMPLETA de las
 * 3 empresas — por eso Ventas y Compras mostraban data de Jhiro estando en
 * Benji, mientras Packing y Guías (que cargan al hacer clic, ya con el
 * contexto listo) salían bien.
 *
 * Todas las lecturas y escrituras del helper CRUD pasan por aquí primero.
 */
export async function esperarContextoEmpresa() {
  if (_ctxEmpresa?.listo?.()) return
  if (!_ctxEmpresa?.promesa) return
  await _ctxEmpresa.promesa
}
export function empresasActivasCtx() { return _ctxEmpresa?.listo?.() ? _ctxEmpresa.activas() : null }
export function empresaTrabajoCtx()  { return _ctxEmpresa?.listo?.() ? _ctxEmpresa.trabajo() : null }

// Tablas y vistas DUEÑAS: tienen columna empresa_id propia y se filtran.
// Lo que NO está aquí es catálogo compartido (items, contacts, plan_cuentas,
// tipos_cambio, terminos_pago, marcas, categorias, partidas…) o
// tabla hija que hereda la empresa por FK (detalle_*, lote_bultos, cuotas_*).
// Un solo menú de restaurante, tres despensas distintas.
export const TABLAS_EMPRESA = new Set([
  // Ventas y compras
  'ventas', 'compras', 'packing', 'orden_compra', 'sales_quotes',
  'guias_ingreso_compra', 'guias_despacho_venta', 'guias_devolucion_compra', 'guias_remision',
  // Inventario
  'lotes', 'kardex', 'almacenes', 'ubicaciones', 'familias',
  // Cobranzas y tesorería
  'cuentas_cobrar', 'cuentas_pagar', 'cobros', 'cobros_lote', 'pagos', 'pagos_proveedores',
  'letras_cambio', 'letras_refinanciacion', 'bancos', 'movimientos_banco',
  // Documentos y correlativos
  'series_documentos', 'secuencias_documentos',
  // Contabilidad
  'journal_entries', 'diarios', 'periodos_contables', 'pdt621_declaraciones',
  // Importaciones
  'carpetas_importacion', 'comercial_invoices', 'bill_of_ladings', 'dams',
  'documentos_importacion', 'gastos_locales', 'importacion_parametros',
  // Vistas que ya exponen empresa_id (SQL 87, parte 8)
  'stock_ubicaciones', 'v_stock_bultos_zona', 'v_registro_ventas', 'v_registro_compras',
  'v_cxc_pendientes', 'v_cxp_pendientes', 'v_antiguedad_cxc_cliente',
  'v_libro_mayor', 'v_balance_comprobacion',
  // Vistas de importaciones con empresa_id (SQL 89)
  'v_importacion_costos', 'v_importacion_doc_cuadre', 'v_importacion_resumen',
  'v_importacion_costo_detalle', 'v_importacion_prorrateo_cuadre',
  'v_importacion_analisis_general', 'v_compras_importacion'
])

/** Aplica el filtro de empresas activas a una consulta, si corresponde. */
export function filtrarPorEmpresa(q, table) {
  if (!TABLAS_EMPRESA.has(table)) return q
  const activas = empresasActivasCtx()
  if (activas?.length) {
    return activas.length === 1 ? q.eq('empresa_id', activas[0]) : q.in('empresa_id', activas)
  }
  // SIN contexto todavía: se filtra a NADA, no a TODO.
  // Un filtro que "falla abierto" es peor que no tener filtro, porque enseña
  // datos de otra empresa con cara de ser los correctos. Si todavía no sabes
  // de quién es el almacén, no abres la puerta. El warning nombra la tabla
  // para poder cazar a cualquier módulo que consulte demasiado pronto.
  console.warn(`[multiempresa] "${table}" se consultó antes de tener contexto de empresa: se devuelve vacío. Revisa quién la llama.`)
  return q.eq('empresa_id', -1)
}

// ── RED DE SEGURIDAD ────────────────────────────────────────────────────────
// 96 llamadas del ERP usan `supabase.from(...)` directo, sin pasar por
// getAll()/query(). Auditarlas una por una es caro y se escapa alguna, así que
// se envuelve `from` UNA sola vez: cualquier `.select()` sobre una tabla dueña
// sale ya filtrado por las empresas activas.
//
// Sólo se intercepta `select`. `insert`/`update`/`delete` quedan intactos a
// propósito: ahí la protección son los triggers del SQL 87 (parte 7), que es
// donde debe vivir una regla que no se puede permitir que falle.
const _fromOriginal = supabase.from.bind(supabase)
supabase.from = function (table) {
  const qb = _fromOriginal(table)
  if (!TABLAS_EMPRESA.has(table)) return qb
  const _selectOriginal = qb.select.bind(qb)
  qb.select = (...args) => filtrarPorEmpresa(_selectOriginal(...args), table)
  return qb
}

/**
 * Acceso CRUDO, sin el filtro de empresas activas.
 *
 * Existe para las pantallas de ADMINISTRACIÓN que deben ver las 3 empresas
 * aunque el switch tenga una sola marcada (ej. el tab Multiempresa contando
 * los lotes de cada una). Ojo: `from()` normal AGREGA su filtro, así que un
 * `.eq('empresa_id', X)` sobre una empresa que no está activa daría 0 —
 * los dos predicados se suman con AND, no se pisan.
 *
 * Fuera de administración NO se usa: saltarse el filtro es justamente lo que
 * mezcla los datos de dos empresas.
 */
export function fromSinFiltro(table) { return _fromOriginal(table) }

/** Sella un payload con la empresa de TRABAJO (una sola: el documento se firma con un solo sello). */
export function sellarEmpresa(table, data) {
  if (!TABLAS_EMPRESA.has(table) || !data || typeof data !== 'object') return data
  if (data.empresa_id != null) return data            // el modal ya la eligió explícitamente
  const emp = empresaTrabajoCtx()
  if (emp == null) return data                        // deja que la BD reclame (NOT NULL): mejor que caiga en la empresa equivocada
  return { ...data, empresa_id: emp }
}


// ============================================================================
// HELPERS CRUD
// ============================================================================

export async function getAll(table) {
  await esperarContextoEmpresa()
  try {
    const { data, error } = await supabase.from(table).select('*')   // el filtro de empresa lo pone el wrapper de `from`
    if (error) { console.error(`Error fetching ${table}:`, error); return [] }
    return data || []
  } catch (e) { console.error('Error en getAll:', e); return [] }
}

export async function getById(table, id) {
  await esperarContextoEmpresa()
  try {
    const { data, error } = await supabase.from(table).select('*').eq('id', id).single()
    if (error) { console.error(`Error fetching ${table} by ID:`, error); return null }
    return data
  } catch (e) { console.error('Error en getById:', e); return null }
}

// Última razón por la que falló un insert. Los módulos la leen con
// `ultimoErrorInsert()` para poder mostrar en pantalla POR QUÉ no se pudo
// crear el registro (típicamente choque contra un índice único), en vez
// del genérico "no se pudo crear" que obligaba a abrir la consola.
let _ultimoErrorInsert = null

export function ultimoErrorInsert() { return _ultimoErrorInsert }

export async function insert(table, data) {
  _ultimoErrorInsert = null
  await esperarContextoEmpresa()
  try {
    data = sellarEmpresa(table, data)
    console.log("Datos a insertar:", data);
    const { data: result, error } = await supabase.from(table).insert([data]).select()
    if (error) {
      console.error(`Error inserting into ${table}:`, error)
      _ultimoErrorInsert = _interpretarErrorInsert(error, table)
      return null
    }
    return result ? result[0] : null
  } catch (e) {
    console.error('Error en insert:', e)
    _ultimoErrorInsert = { mensaje: e.message, tabla: null, codigo: null }
    return null
  }
}

function _interpretarErrorInsert(error, tabla) {
  const codigo = error?.code || null
  if (codigo === '23505') {
    return {
      codigo,
      tabla,
      mensaje: 'ya existe un registro igual (choca contra un valor que debe ser único). Revisa si el dato ya fue creado antes.'
    }
  }
  if (codigo === '23503') {
    return { codigo, tabla, mensaje: 'hace referencia a un registro que no existe (llave foránea inválida).' }
  }
  return { codigo, tabla, mensaje: error?.message || 'error desconocido' }
}

export async function update(table, id, data) {
  await esperarContextoEmpresa()
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
  await esperarContextoEmpresa()
  try {
    let q = supabase.from(table).select('*')   // ídem: ya viene filtrado por empresa
    // Si un filtro llega en undefined/null (ej. función invocada sin argumento),
    // se ignora en vez de mandar "col=eq.undefined" a PostgREST, que Postgres
    // rechaza con 400 al castear y hacía que la consulta devolviera [] silenciosamente.
    Object.keys(filters).forEach(key => {
      if (filters[key] === undefined || filters[key] === null) return
      q = q.eq(key, filters[key])
    })
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