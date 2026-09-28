// ============================================================================
// SUPABASE-DATA.JS - Gestión de datos con Supabase
// ============================================================================

import { supabase, getAll, getById, insert, update, deleteRecord, query, ultimoErrorDelete, ultimoErrorInsert } from './supabase-client.js'

// Se re-exporta para que los módulos puedan explicar en pantalla por qué
// falló un borrado (qué tabla sigue referenciando el registro).
export { ultimoErrorDelete, ultimoErrorInsert }
// ============================================================================
// ITEMS
// ============================================================================

// Caché de items: catálogo grande y de baja frecuencia de cambio, pero
// consultado por muchas funciones (selects, renders) — sin caché cada
// llamada baja la tabla completa. Se invalida al crear/editar/eliminar.
let _itemsPromise = null

export function invalidateItemsCache() {
  _itemsPromise = null
}

export async function getItems(forzar = false) {
  if (forzar || !_itemsPromise) {
    _itemsPromise = getAll('items')
  }
  return await _itemsPromise
}

export async function getItemById(id) {
  const items = await getItems()
  return items.find(i => i.id === id) || null
}

export async function addItem(item) {
  const r = await insert('items', item)
  if (r) invalidateItemsCache()
  return r
}

export async function updateItem(id, data) {
  const r = await update('items', id, data)
  if (r) invalidateItemsCache()
  return r
}

export async function deleteItem(id) {
  const r = await deleteRecord('items', id)
  if (r) invalidateItemsCache()
  return r
}

// ============================================================================
// LOTES
// ============================================================================

export async function getLotes() {
  return await getAll('lotes')
}

export async function getLoteById(id) {
  return await getById('lotes', id)
}

export async function getLotesByItemId(itemId) {
  return await query('lotes', { item_id: itemId })
}

export async function getLotesByCompraId(compraId) {
  return await query('lotes', { compra_id: compraId })
}

export async function addLote(lote) {
  return await insert('lotes', lote)
}

export async function updateLote(id, data) {
  return await update('lotes', id, data)
}

export async function deleteLote(id) {
  return await deleteRecord('lotes', id)
}

// ============================================================================
// LOTE_BULTOS — detalle de peso individual por bulto (productos con
// es_peso_variable=true). Ver 43_lote_bultos.sql.
// ============================================================================

export async function getLoteBultosByLote(loteId) {
  return await query('lote_bultos', { lote_id: loteId })
}

export async function getLoteBultoById(id) {
  return await getById('lote_bultos', id)
}

export async function addLoteBulto(bulto) {
  return await insert('lote_bultos', bulto)
}

export async function updateLoteBulto(id, data) {
  return await update('lote_bultos', id, data)
}

export async function deleteLoteBulto(id) {
  return await deleteRecord('lote_bultos', id)
}

/**
 * Bultos disponibles (estado='disponible') de un lote, para elegir cuáles
 * mover/vender/despachar. Más livianos primero no importa — se ordena por
 * fecha de ingreso (los más antiguos primero) solo para que la lista sea
 * predecible en pantalla.
 */
export async function getLoteBultosDisponibles(loteId) {
  const bultos = await getLoteBultosByLote(loteId)
  return (bultos || [])
    .filter(b => b.estado === 'disponible')
    .sort((a, b) => (a.id || 0) - (b.id || 0))
}

/**
 * Recalcula lotes.cantidad y cantidad_unidades sumando/contando los bultos
 * disponibles de ese lote. Para lotes con es_peso_variable=true estos dos
 * campos dejan de escribirse a mano — siempre reflejan el detalle real.
 */
export async function recalcularLoteDesdeBultos(loteId) {
  const disponibles = await getLoteBultosDisponibles(loteId)
  const cantidad = parseFloat(disponibles.reduce((s, b) => s + (parseFloat(b.peso) || 0), 0).toFixed(4))
  const cantidad_unidades = disponibles.length
  await updateLote(loteId, { cantidad, cantidad_unidades })
  return { cantidad, cantidad_unidades }
}

/** Stock disponible por zona para lotes con bultos (lee la vista v_stock_bultos_zona). */
export async function getStockBultosZona() {
  return await getAll('v_stock_bultos_zona')
}

export async function getStockBultosZonaByLote(loteId) {
  const filas = await getStockBultosZona()
  return (filas || []).filter(f => f.lote_id === loteId)
}

/**
 * Bultos disponibles de un lote, filtrados a UNA zona — es lo que se ofrece
 * para marcar/seleccionar en la Guía de Despacho (Fase 2): el usuario pide
 * un peso aproximado y arma la selección con estos bultos hasta acercarse.
 */
export async function getLoteBultosDisponiblesZona(loteId, ubicacionId) {
  const disponibles = await getLoteBultosDisponibles(loteId)
  return (disponibles || []).filter(b => b.ubicacion_id === ubicacionId)
}

/**
 * Bultos ligados a una línea de guía de despacho (detalle_guias_despacho_
 * venta.id) — para poder revertirlos si se elimina la guía.
 */
export async function getLoteBultosPorDetalleGuiaDespacho(detalleGuiaDespachoId) {
  return await query('lote_bultos', { detalle_guia_despacho_id: detalleGuiaDespachoId })
}

/**
 * Revierte a 'disponible' todos los bultos que una línea de guía de
 * despacho había marcado como vendidos, y limpia sus referencias. NO
 * recalcula el lote (para no recalcularlo varias veces si una guía tocó el
 * mismo lote en más de una línea) — el llamador debe llamar
 * recalcularLoteDesdeBultos(loteId) por cada id devuelto, una sola vez.
 */
export async function revertirBultosDeDetalleGuiaDespacho(detalleGuiaDespachoId) {
  const bultos = await getLoteBultosPorDetalleGuiaDespacho(detalleGuiaDespachoId)
  const loteIds = new Set()
  for (const b of (bultos || [])) {
    await updateLoteBulto(b.id, { estado: 'disponible', detalle_venta_id: null, detalle_guia_despacho_id: null })
    loteIds.add(b.lote_id)
  }
  return Array.from(loteIds)
}

/**
 * Reingresa a Inventario los bultos que el cliente devuelve por una Nota de
 * Crédito. A diferencia de revertirBultosDeDetalleGuiaDespacho (que DESHACE
 * la guía completa, como si nunca hubiera pasado), aquí la venta original
 * SIGUE siendo válida — solo una NC la corrige parcialmente — así que no se
 * puede "resucitar" el bulto vendido tal cual: ese registro es el historial
 * de esa venta. Se sigue el patrón ya previsto en 43_lote_bultos.sql:
 *   1) El bulto vendido pasa a estado='devuelto_cliente' (cierra su ciclo,
 *      conserva detalle_venta_id/detalle_guia_despacho_id como historial) y
 *      se le anota nota_credito_venta_id.
 *   2) Se crea un BULTO NUEVO en estado='disponible', con bulto_origen_id
 *      apuntando al vendido, en la zona de recepción indicada — con el peso
 *      que el usuario ingresó en la devolución (casi nunca es idéntico al
 *      peso de venta: se repesa en almacén).
 * NO recalcula el lote ni inserta Kardex — el llamador (ventas.js) hace eso
 * una vez por lote, después de reingresar todos los bultos de la NC, y
 * decide el costo/concepto del movimiento de Kardex.
 *
 * @param {Array<{bultoVendidoId:number, pesoDevuelto:number, ubicacionId:number}>} devoluciones
 * @param {number} notaCreditoVentaId  id de la fila de NC (ventas.id, tipo_comprobante='07')
 * @param {number|null} createdBy
 * @returns {Array<{loteId:number, bultoNuevo:object}>}
 */
export async function reingresarBultosPorNotaCredito(devoluciones, notaCreditoVentaId, createdBy = null) {
  const resultado = []
  for (const dev of (devoluciones || [])) {
    const original = await getLoteBultoById(dev.bultoVendidoId)
    if (!original) continue

    await updateLoteBulto(original.id, {
      estado: 'devuelto_cliente',
      nota_credito_venta_id: notaCreditoVentaId
    })

    const bultoNuevo = await addLoteBulto({
      lote_id:         original.lote_id,
      peso:            dev.pesoDevuelto,
      unidad_medida:   original.unidad_medida,
      ubicacion_id:    dev.ubicacionId || original.ubicacion_id,
      estado:          'disponible',
      bulto_origen_id: original.id,
      nota_credito_venta_id: notaCreditoVentaId,
      fecha_ingreso:   new Date().toISOString().split('T')[0],
      created_by:      createdBy
    })

    resultado.push({ loteId: original.lote_id, bultoNuevo })
  }
  return resultado
}

// ============================================================================
// ALMACENES Y ZONAS (ubicaciones)
// ============================================================================

// Catálogos pequeños pero consultados en cada carga de Guía/Inventario —
// mismo patrón de caché con invalidación en escritura.
let _almacenesPromise = null

export function invalidateAlmacenesCache() {
  _almacenesPromise = null
}

export async function getAlmacenes(forzar = false) {
  if (forzar || !_almacenesPromise) {
    _almacenesPromise = getAll('almacenes')
  }
  return await _almacenesPromise
}

export async function getAlmacenById(id) {
  const almacenes = await getAlmacenes()
  return almacenes.find(a => a.id === id) || null
}

export async function addAlmacen(almacen) {
  const r = await insert('almacenes', almacen)
  if (r) invalidateAlmacenesCache()
  return r
}

export async function updateAlmacen(id, data) {
  const r = await update('almacenes', id, data)
  if (r) invalidateAlmacenesCache()
  return r
}

export async function deleteAlmacen(id) {
  const r = await deleteRecord('almacenes', id)
  if (r) invalidateAlmacenesCache()
  return r
}

let _ubicacionesPromise = null

export function invalidateUbicacionesCache() {
  _ubicacionesPromise = null
}

export async function getUbicaciones(forzar = false) {
  if (forzar || !_ubicacionesPromise) {
    _ubicacionesPromise = getAll('ubicaciones')
  }
  return await _ubicacionesPromise
}

export async function getUbicacionesByAlmacen(almacenId) {
  const ubicaciones = await getUbicaciones()
  return ubicaciones.filter(u => u.almacen_id === almacenId)
}

export async function getUbicacionById(id) {
  const ubicaciones = await getUbicaciones()
  return ubicaciones.find(u => u.id === id) || null
}

export async function addUbicacion(ubicacion) {
  const r = await insert('ubicaciones', ubicacion)
  if (r) invalidateUbicacionesCache()
  return r
}

export async function updateUbicacion(id, data) {
  const r = await update('ubicaciones', id, data)
  if (r) invalidateUbicacionesCache()
  return r
}

export async function deleteUbicacion(id) {
  const r = await deleteRecord('ubicaciones', id)
  if (r) invalidateUbicacionesCache()
  return r
}

// ============================================================================
// STOCK POR UBICACIÓN (zona) — independiente del costeo por lote
// ============================================================================

export async function getStockUbicaciones() {
  return await getAll('stock_ubicaciones')
}

export async function getStockUbicacionesByLote(loteId) {
  return await query('stock_ubicaciones', { lote_id: loteId })
}

export async function getStockUbicacionesByUbicacion(ubicacionId) {
  return await query('stock_ubicaciones', { ubicacion_id: ubicacionId })
}

// ── Escritura: NO-OPS desde 50_stock_ubicaciones_vista_kardex.sql ──────────
// stock_ubicaciones pasó de ser una tabla escrita a mano a una VISTA
// calculada en vivo desde kardex (misma idea que v_stock_bultos_zona). El
// stock ya queda correcto en cuanto compras.js/ventas.js/inventario.js
// insertan el movimiento en kardex — estas 3 funciones no tienen nada que
// escribir. Se mantienen (en vez de borrar las ~26 llamadas en los 3
// archivos) para no tocar lógica de negocio ya probada; ninguna de esas
// llamadas depende del id que devolvían (verificado call por call).
export async function addStockUbicacion(registro) {
  return { id: null, ...registro }
}

export async function updateStockUbicacion(_id, _data) {
  return true
}

export async function deleteStockUbicacion(_id) {
  return true
}

// ============================================================================
// TIPO DOCUMENTOS (Catálogo SUNAT)
// ============================================================================

export async function getTipoDocumentos() {
  return await getAll('tipo_documentos')
}

export async function getTipoDocumentoById(id) {
  return await getById('tipo_documentos', id)
}

// Cache en memoria para lookup sincrónico en renders
let _tipoDocumentosCache = null

export async function getTipoDocumentosMap() {
  if (!_tipoDocumentosCache) {
    const tipos = await getTipoDocumentos()
    _tipoDocumentosCache = {}
    tipos.forEach(t => { _tipoDocumentosCache[t.id] = t })
  }
  return _tipoDocumentosCache
}

/**
 * Retorna el nombre del tipo de documento dado su código SUNAT ('01', '03', etc.).
 * Si no se encuentra, retorna el propio id como fallback.
 */
export async function getNombreTipoDocumento(id) {
  if (!id) return '-'
  const map = await getTipoDocumentosMap()
  return map[id]?.name || id
}

/**
 * Versión sincrónica (usa cache ya cargado). Llama getTipoDocumentosMap() primero.
 * Si el cache no está listo, retorna el id.
 */
export function getNombreTipoDocumentoSync(id) {
  if (!id) return '-'
  if (!_tipoDocumentosCache) return id
  return _tipoDocumentosCache[id]?.name || id
}

/**
 * Puebla un <select> con los tipos de documento activos del catálogo SUNAT.
 * @param {string} selectId  - id del elemento <select>
 * @param {string} selectedId - valor que debe quedar seleccionado
 */
export async function cargarSelectTipoDocumentos(selectId, selectedId = '') {
  const tipos = await getTipoDocumentos()
  const select = document.getElementById(selectId)
  if (!select) return
  select.innerHTML = '<option value="">-- Selecciona tipo --</option>'
  tipos.filter(t => t.active !== false).forEach(t => {
    const opt = document.createElement('option')
    opt.value = t.id
    opt.textContent = `${t.id} - ${t.name}`
    if (t.id === selectedId) opt.selected = true
    select.appendChild(opt)
  })
}

// ============================================================================
// CONTACTOS (Proveedores, Clientes, Vendedores)
// ============================================================================

// Caché de contactos: getSuppliers/getCustomers/selects llaman getContacts
// varias veces por página — sin caché eso son N descargas de la tabla completa.
// Se guarda la promesa (no el resultado) para que llamadas concurrentes
// compartan una sola consulta. Se invalida al crear/editar/eliminar.
let _contactsPromise = null

export function invalidateContactsCache() {
  _contactsPromise = null
}

export async function getContacts(forzar = false) {
  if (forzar || !_contactsPromise) {
    _contactsPromise = getAll('contacts')
  }
  return await _contactsPromise
}

export async function getContactById(id) {
  const contacts = await getContacts()
  return contacts.find(c => c.id === id) || null
}

/**
 * tipo_contacto ahora es text[] en la BD, ej: ['cliente','proveedor'].
 * Este helper normaliza cualquier formato (array nuevo o string legacy
 * 'ambos'/'Cliente'/'proveedor') a un array en minúsculas.
 */
export function tiposDeContacto(contact) {
  const v = contact?.tipo_contacto
  if (Array.isArray(v)) return v.map(x => String(x).toLowerCase())
  if (!v) return []
  const s = String(v).toLowerCase()
  return s === 'ambos' ? ['cliente', 'proveedor'] : [s]
}

export async function getContactsByType(tipoContacto) {
  const t = String(tipoContacto || '').toLowerCase()
  const contacts = await getContacts()
  return contacts.filter(c => tiposDeContacto(c).includes(t))
}

export async function getSuppliers() {
  return await getContactsByType('proveedor')
}

export async function getCustomers() {
  return await getContactsByType('cliente')
}

export async function addContact(contact) {
  const r = await insert('contacts', contact)
  if (r) invalidateContactsCache()
  return r
}

export async function updateContact(id, data) {
  const r = await update('contacts', id, data)
  if (r) invalidateContactsCache()
  return r
}

export async function deleteContact(id) {
  const r = await deleteRecord('contacts', id)
  if (r) invalidateContactsCache()
  return r
}

// ============================================================================
// HELPERS - Búsqueda por referencia
// ============================================================================

export async function getSupplierById(id) {
  if (!id) return null
  const contacts = await getContacts()
  return contacts.find(c => c.id === id && tiposDeContacto(c).includes('proveedor'))
}

export async function getCustomerById(id) {
  if (!id) return null
  const contacts = await getContacts()
  return contacts.find(c => c.id === id && tiposDeContacto(c).includes('cliente'))
}

// ============================================================================
// CATEGORÍAS
// ============================================================================

export async function getCategorias() {
  return await getAll('categorias')
}

export async function getCategoriaById(id) {
  return await getById('categorias', id)
}

export async function addCategoria(categoria) {
  return await insert('categorias', categoria)
}

export async function updateCategoria(id, data) {
  return await update('categorias', id, data)
}

export async function deleteCategoria(id) {
  return await deleteRecord('categorias', id)
}

// ============================================================================
// MARCAS
// ============================================================================

let _marcasPromise = null

export function invalidateMarcasCache() {
  _marcasPromise = null
}

export async function getMarcas(forzar = false) {
  if (forzar || !_marcasPromise) {
    _marcasPromise = getAll('marcas')
  }
  return await _marcasPromise
}

export async function getMarcaById(id) {
  const marcas = await getMarcas()
  return marcas.find(m => m.id === id) || null
}

export async function addMarca(marca) {
  const r = await insert('marcas', marca)
  if (r) invalidateMarcasCache()
  return r
}

export async function updateMarca(id, data) {
  const r = await update('marcas', id, data)
  if (r) invalidateMarcasCache()
  return r
}

export async function deleteMarca(id) {
  const r = await deleteRecord('marcas', id)
  if (r) invalidateMarcasCache()
  return r
}

// ============================================================================
// PARTIDAS
// ============================================================================

let _partidasPromise = null

export function invalidatePartidasCache() {
  _partidasPromise = null
}

export async function getPartidas(forzar = false) {
  if (forzar || !_partidasPromise) {
    _partidasPromise = getAll('partidas')
  }
  return await _partidasPromise
}

export async function getPartidaById(id) {
  const partidas = await getPartidas()
  return partidas.find(p => p.id === id) || null
}

export async function getPartidasByItemId(itemId) {
  // La columna real en `partidas` es product_id, no item_id (ver
  // 01_schema.sql). Antes filtraba por item_id y siempre devolvía [].
  const partidas = await getPartidas()
  return partidas.filter(p => p.product_id === itemId)
}

export async function addPartida(partida) {
  const r = await insert('partidas', partida)
  if (r) invalidatePartidasCache()
  return r
}

export async function updatePartida(id, data) {
  const r = await update('partidas', id, data)
  if (r) invalidatePartidasCache()
  return r
}

export async function deletePartida(id) {
  const r = await deleteRecord('partidas', id)
  if (r) invalidatePartidasCache()
  return r
}

// ============================================================================
// PLAN DE CUENTAS
// ============================================================================

export async function getAccounts() {
  return await getAll('plan_cuentas')
}

export async function getAccountById(id) {
  return await getById('plan_cuentas', id)
}

export async function getAccountByCode(code) {
  const accounts = await getAccounts()
  const codeStr = String(code).trim()
  return accounts.find(a => String(a.codigo || '').trim() === codeStr)
}

export async function getAccountsByTipo(tipo) {
  return await query('plan_cuentas', { tipo })
}

export async function updateAccount(id, data) {
  return await update('plan_cuentas', id, data)
}

// Cuentas de gasto disponibles para selección manual (marcador __CUENTA_GASTO__)
export async function getCuentasGasto() {
  const accounts = await getAccounts()
  return accounts.filter(a =>
    a.activo !== false &&
    (a.tipo === 'Gastos' || a.tipo === 'Gasto' || a.subgrupo === 'Gastos') &&
    a.naturaleza_saldo === 'deudor'
  )
}

// ============================================================================
// ÓRDENES DE COMPRA
// ============================================================================

export async function getOrderCompras() {
  return await getAll('orden_compra')
}

/**
 * Página de órdenes de compra desde el servidor (50 por defecto),
 * ordenadas de la más reciente a la más antigua. Devuelve { data, total }.
 */
export async function getOrderComprasPage({ pagina = 1, porPagina = 50 } = {}) {
  try {
    const desde = (pagina - 1) * porPagina
    const { data, error, count } = await supabase
      .from('orden_compra')
      .select('*', { count: 'exact' })
      .order('id', { ascending: false })
      .range(desde, desde + porPagina - 1)
    if (error) { console.error('Error getOrderComprasPage:', error); return { data: [], total: 0 } }
    return { data: data || [], total: count || 0 }
  } catch (e) { console.error('Error en getOrderComprasPage:', e); return { data: [], total: 0 } }
}

export async function getOrderCompraById(id) {
  return await getById('orden_compra', id)
}

export async function addOrderCompra(order) {
  return await insert('orden_compra', order)
}

export async function updateOrderCompra(id, data) {
  return await update('orden_compra', id, data)
}

export async function deleteOrderCompra(id) {
  return await deleteRecord('orden_compra', id)
}

// ============================================================================
// DETALLES DE ÓRDENES DE COMPRA
// ============================================================================

export async function getOrderCompraDetalles(ordenCompraId) {
  return await query('detalle_orden_compra', { orden_compra_id: ordenCompraId })
}

export async function getOrderCompraDetalleById(id) {
  return await getById('detalle_orden_compra', id)
}

export async function addOrderCompraDetalle(detalle) {
  return await insert('detalle_orden_compra', detalle)
}

export async function updateOrderCompraDetalle(id, data) {
  return await update('detalle_orden_compra', id, data)
}

export async function deleteOrderCompraDetalle(id) {
  return await deleteRecord('detalle_orden_compra', id)
}

// ============================================================================
// COMPRAS
// ============================================================================

export async function getCompras() {
  return await getAll('compras')
}

/**
 * Página de compras desde el servidor (50 por defecto), de la más
 * reciente a la más antigua. Devuelve { data, total }.
 * Igual que ventas: lee su propia tabla, no el diario contable.
 */
export async function getComprasPage({ pagina = 1, porPagina = 50 } = {}) {
  try {
    const desde = (pagina - 1) * porPagina
    const { data, error, count } = await supabase
      .from('compras')
      .select('*', { count: 'exact' })
      .order('id', { ascending: false })
      .range(desde, desde + porPagina - 1)
    if (error) { console.error('Error getComprasPage:', error); return { data: [], total: 0 } }
    return { data: data || [], total: count || 0 }
  } catch (e) { console.error('Error en getComprasPage:', e); return { data: [], total: 0 } }
}

export async function getCompraById(id) {
  return await getById('compras', id)
}

export async function addCompra(compra) {
  return await insert('compras', compra)
}

export async function updateCompra(id, data) {
  return await update('compras', id, data)
}

export async function deleteCompra(id) {
  return await deleteRecord('compras', id)
}

// ============================================================================
// ADJUNTO DE COMPRA (Supabase Storage — bucket "compras-adjuntos")
// ============================================================================
// 1 archivo por compra. Se guarda el PATH en compras.adjunto_url (no la URL
// pública: el bucket es privado), y se resuelve a URL firmada temporal solo
// cuando se necesita ver/descargar.

const ADJUNTOS_BUCKET = 'compras-adjuntos'

/**
 * Sube (o reemplaza) el documento adjunto de una compra y actualiza
 * compras.adjunto_url / adjunto_nombre. Si ya había un archivo previo con
 * otro nombre, lo borra del bucket para no dejar huérfanos.
 */
export async function subirAdjuntoCompra(compraId, file) {
  if (!file) throw new Error('No se seleccionó ningún archivo')
  const permitidos = ['application/pdf', 'image/jpeg', 'image/png']
  if (!permitidos.includes(file.type)) {
    throw new Error('Solo se aceptan PDF, JPEG o PNG')
  }
  if (file.size > 10 * 1024 * 1024) {
    throw new Error('El archivo no puede superar 10 MB')
  }

  const compra = await getCompraById(compraId)
  const anterior = compra?.adjunto_url || null

  const ext = (file.name.split('.').pop() || 'pdf').toLowerCase()
  const path = `compra-${compraId}/${Date.now()}.${ext}`

  const { error } = await supabase.storage.from(ADJUNTOS_BUCKET).upload(path, file, { upsert: false })
  if (error) throw new Error(`No se pudo subir el archivo: ${error.message}`)

  await updateCompra(compraId, { adjunto_url: path, adjunto_nombre: file.name })

  if (anterior) {
    await supabase.storage.from(ADJUNTOS_BUCKET).remove([anterior]).catch(() => {})
  }

  return path
}

/** Genera una URL firmada temporal (1 hora) para ver/descargar el adjunto. */
export async function getUrlAdjuntoCompra(path, expiresIn = 3600) {
  if (!path) return null
  const { data, error } = await supabase.storage.from(ADJUNTOS_BUCKET).createSignedUrl(path, expiresIn)
  if (error) throw new Error(`No se pudo generar el enlace: ${error.message}`)
  return data?.signedUrl || null
}

/** Elimina el documento adjunto de una compra (bucket + columnas). */
export async function eliminarAdjuntoCompra(compraId) {
  const compra = await getCompraById(compraId)
  if (!compra?.adjunto_url) return
  await supabase.storage.from(ADJUNTOS_BUCKET).remove([compra.adjunto_url]).catch(() => {})
  await updateCompra(compraId, { adjunto_url: null, adjunto_nombre: null })
}

// ============================================================================
// DETALLES DE COMPRAS
// ============================================================================

export async function getCompraDetalles(compraId) {
  return await query('detalle_compras', { compra_id: compraId })
}

// Todas las líneas de todas las compras de un jalón: usado para calcular,
// compra por compra, cuánto queda pendiente de recibir sin hacer N+1
// consultas (ver _cargarComprasSelectGuia en compras.js).
export async function getTodosDetalleCompras() {
  return await getAll('detalle_compras')
}

export async function getCompraDetalleById(id) {
  return await getById('detalle_compras', id)
}

export async function addCompraDetalle(detalle) {
  return await insert('detalle_compras', detalle)
}

export async function updateCompraDetalle(id, data) {
  return await update('detalle_compras', id, data)
}

// ============================================================================
// GUÍAS DE INGRESO DE COMPRA (recepción de mercadería -> genera stock/lotes)
// ============================================================================

// Caché de guías: usada tanto para listar el tab Guías como para el badge
// "Con Guía/Pendiente" en la lista de Compras — antes se bajaba la tabla
// completa en cada render/paginación de Compras.
let _guiasIngresoCompraPromise = null

export function invalidateGuiasIngresoCompraCache() {
  _guiasIngresoCompraPromise = null
}

export async function getGuiasIngresoCompra(forzar = false) {
  if (forzar || !_guiasIngresoCompraPromise) {
    _guiasIngresoCompraPromise = getAll('guias_ingreso_compra')
  }
  return await _guiasIngresoCompraPromise
}

export async function getGuiaIngresoCompraById(id) {
  return await getById('guias_ingreso_compra', id)
}

export async function addGuiaIngresoCompra(guia) {
  const r = await insert('guias_ingreso_compra', guia)
  if (r) invalidateGuiasIngresoCompraCache()
  return r
}

export async function updateGuiaIngresoCompra(id, data) {
  const r = await update('guias_ingreso_compra', id, data)
  if (r) invalidateGuiasIngresoCompraCache()
  return r
}

export async function deleteGuiaIngresoCompra(id) {
  const r = await deleteRecord('guias_ingreso_compra', id)
  if (r) invalidateGuiasIngresoCompraCache()
  return r
}

export async function getDetalleGuiasIngresoCompra(guiaId) {
  return await query('detalle_guias_ingreso_compra', { guia_id: guiaId })
}

// Todas las líneas de todas las guías de ingreso: usado para sumar, línea de
// compra por línea de compra, cuánto se ha recibido ya en TODAS sus guías
// (una compra puede recibirse en varias guías parciales).
export async function getTodosDetalleGuiasIngresoCompra() {
  return await getAll('detalle_guias_ingreso_compra')
}

export async function addDetalleGuiaIngresoCompra(detalle) {
  return await insert('detalle_guias_ingreso_compra', detalle)
}

export async function deleteDetalleGuiaIngresoCompra(id) {
  return await deleteRecord('detalle_guias_ingreso_compra', id)
}

// ============================================================================
// NOTA_CREDITO_COMPRA_DETALLE — declara qué ítem/lote se devuelve al
// proveedor en una NC RECIBIDA (tipo_comprobante='07' en compras). Ver
// 53_devolucion_compra.sql. Solo declarativo: no mueve stock por sí solo,
// eso lo hace guias_devolucion_compra cuando se emite la guía.
// ============================================================================

export async function getNotaCreditoCompraDetalleByNota(notaCompraId) {
  return await query('nota_credito_compra_detalle', { nota_compra_id: notaCompraId })
}

export async function getNotaCreditoCompraDetalleByCompraOrigen(compraOrigenId) {
  return await query('nota_credito_compra_detalle', { compra_origen_id: compraOrigenId })
}

export async function addNotaCreditoCompraDetalle(d) {
  return await insert('nota_credito_compra_detalle', d)
}

export async function deleteNotaCreditoCompraDetalle(id) {
  return await deleteRecord('nota_credito_compra_detalle', id)
}

// ============================================================================
// GUÍAS DE DEVOLUCIÓN A PROVEEDOR — espejo de guías de ingreso/despacho: la
// NC solo declara qué se debe devolver, esta guía es la que de verdad saca
// la mercadería (descuenta lotes.cantidad + Kardex salida hacia
// Partners/Vendors). Ver 53_devolucion_compra.sql.
// ============================================================================

let _guiasDevolucionCompraPromise = null

export function invalidateGuiasDevolucionCompraCache() {
  _guiasDevolucionCompraPromise = null
}

export async function getGuiasDevolucionCompra(forzar = false) {
  if (forzar || !_guiasDevolucionCompraPromise) {
    _guiasDevolucionCompraPromise = getAll('guias_devolucion_compra')
  }
  return await _guiasDevolucionCompraPromise
}

export async function getGuiaDevolucionCompraById(id) {
  return await getById('guias_devolucion_compra', id)
}

export async function addGuiaDevolucionCompra(guia) {
  const r = await insert('guias_devolucion_compra', guia)
  if (r) invalidateGuiasDevolucionCompraCache()
  return r
}

export async function updateGuiaDevolucionCompra(id, data) {
  const r = await update('guias_devolucion_compra', id, data)
  if (r) invalidateGuiasDevolucionCompraCache()
  return r
}

export async function deleteGuiaDevolucionCompra(id) {
  const r = await deleteRecord('guias_devolucion_compra', id)
  if (r) invalidateGuiasDevolucionCompraCache()
  return r
}

export async function getDetalleGuiasDevolucionCompra(guiaId) {
  return await query('detalle_guias_devolucion_compra', { guia_id: guiaId })
}

// Todas las líneas de TODAS las guías de devolución que cubren una línea de
// NC en particular — para calcular cuánto ya se devolvió físicamente contra
// lo declarado en nota_credito_compra_detalle.cantidad (pendiente/parcial/completa).
export async function getDetalleGuiasDevolucionCompraByNotaDetalle(notaCreditoCompraDetalleId) {
  return await query('detalle_guias_devolucion_compra', { nota_credito_compra_detalle_id: notaCreditoCompraDetalleId })
}

// Todas las líneas de todas las guías de devolución: usado para recalcular,
// de una sola bajada, el estado_devolucion de todas las NC pendientes.
export async function getTodosDetalleGuiasDevolucionCompra() {
  return await getAll('detalle_guias_devolucion_compra')
}

export async function addDetalleGuiaDevolucionCompra(detalle) {
  return await insert('detalle_guias_devolucion_compra', detalle)
}

export async function deleteDetalleGuiaDevolucionCompra(id) {
  return await deleteRecord('detalle_guias_devolucion_compra', id)
}

/**
 * Bultos ligados a una línea de guía de devolución (detalle_guias_devolucion_
 * compra.id) — para poder revertirlos si se elimina/edita la guía.
 */
export async function getLoteBultosPorDetalleGuiaDevolucion(detalleGuiaDevolucionId) {
  return await query('lote_bultos', { detalle_guia_devolucion_id: detalleGuiaDevolucionId })
}

/**
 * Revierte a 'disponible' todos los bultos que una línea de guía de
 * devolución había marcado como devuelto_proveedor, y limpia sus
 * referencias. Mismo patrón que revertirBultosDeDetalleGuiaDespacho (ventas)
 * pero en la dirección contraria (el bulto vuelve a existir en stock en vez
 * de reingresar por NC). NO recalcula el lote — el llamador debe llamar
 * recalcularLoteDesdeBultos(loteId) por cada id devuelto, una sola vez.
 */
export async function revertirBultosDeDetalleGuiaDevolucion(detalleGuiaDevolucionId) {
  const bultos = await getLoteBultosPorDetalleGuiaDevolucion(detalleGuiaDevolucionId)
  const loteIds = new Set()
  for (const b of (bultos || [])) {
    await updateLoteBulto(b.id, { estado: 'disponible', nota_credito_compra_id: null, detalle_guia_devolucion_id: null })
    loteIds.add(b.lote_id)
  }
  return Array.from(loteIds)
}

export async function deleteCompraDetalle(id) {
  return await deleteRecord('detalle_compras', id)
}

// ============================================================================
// GUÍAS DE DESPACHO DE VENTA (salida de mercadería -> descuenta stock/kardex)
// Espejo exacto de GUÍAS DE INGRESO DE COMPRA (ver arriba).
// ============================================================================

let _guiasDespachoVentaPromise = null

export function invalidateGuiasDespachoVentaCache() {
  _guiasDespachoVentaPromise = null
}

export async function getGuiasDespachoVenta(forzar = false) {
  if (forzar || !_guiasDespachoVentaPromise) {
    _guiasDespachoVentaPromise = getAll('guias_despacho_venta')
  }
  return await _guiasDespachoVentaPromise
}

export async function getGuiaDespachoVentaById(id) {
  return await getById('guias_despacho_venta', id)
}

export async function addGuiaDespachoVenta(guia) {
  const r = await insert('guias_despacho_venta', guia)
  if (r) invalidateGuiasDespachoVentaCache()
  return r
}

export async function updateGuiaDespachoVenta(id, data) {
  const r = await update('guias_despacho_venta', id, data)
  if (r) invalidateGuiasDespachoVentaCache()
  return r
}

export async function deleteGuiaDespachoVenta(id) {
  const r = await deleteRecord('guias_despacho_venta', id)
  if (r) invalidateGuiasDespachoVentaCache()
  return r
}

export async function getDetalleGuiasDespachoVenta(guiaId) {
  // Sin `guiaId` devuelve TODAS las líneas de despacho. Antes, llamarla sin
  // argumento generaba un `.eq('guia_id', undefined)` que no filtra lo que se
  // espera; el importador masivo necesita el universo completo para saber
  // cuánto se despachó ya por cada línea de venta.
  if (guiaId === undefined || guiaId === null) return await getAll('detalle_guias_despacho_venta')
  return await query('detalle_guias_despacho_venta', { guia_id: guiaId })
}

export async function getDetalleGuiasDespachoVentaByVenta(ventaId) {
  // Todas las líneas de despacho de TODAS las guías de una venta (para saber
  // cuánto ya se despachó por línea, sin importar en qué guía se hizo).
  const guias = await getGuiasDespachoVenta()
  const guiaIds = new Set((guias || []).filter(g => g.venta_id === ventaId).map(g => g.id))
  if (guiaIds.size === 0) return []
  const todas = await getAll('detalle_guias_despacho_venta')
  return (todas || []).filter(d => guiaIds.has(d.guia_id))
}

export async function addDetalleGuiaDespachoVenta(detalle) {
  return await insert('detalle_guias_despacho_venta', detalle)
}

export async function deleteDetalleGuiaDespachoVenta(id) {
  return await deleteRecord('detalle_guias_despacho_venta', id)
}

// ============================================================================
// COTIZACIONES DE VENTA
// ============================================================================

export async function getSalesQuotes() {
  return await getAll('sales_quotes')
}

export async function getSalesQuoteById(id) {
  return await getById('sales_quotes', id)
}

export async function addSalesQuote(quote) {
  return await insert('sales_quotes', quote)
}

export async function updateSalesQuote(id, data) {
  return await update('sales_quotes', id, data)
}

// ============================================================================
// ASIENTOS CONTABLES
// ============================================================================

export async function getJournalEntries() {
  return await getAll('journal_entries')
}

export async function getJournalEntryById(id) {
  return await getById('journal_entries', id)
}

export async function getJournalEntriesByType(tipoMovimiento) {
  return await query('journal_entries', { tipo_movimiento: tipoMovimiento })
}

export async function getJournalEntriesByDocument(tipoDocumento) {
  return await query('journal_entries', { tipo_documento: tipoDocumento })
}

/**
 * Página de asientos contables desde el servidor (50 por defecto),
 * opcionalmente filtrados por tipo_movimiento (array), del más reciente
 * al más antiguo. Devuelve { data, total }. Evita descargar todo el diario.
 */
export async function getJournalEntriesPage({ pagina = 1, porPagina = 50, tipos = null } = {}) {
  try {
    const desde = (pagina - 1) * porPagina
    let q = supabase
      .from('journal_entries')
      .select('*', { count: 'exact' })
      .order('id', { ascending: false })
      .range(desde, desde + porPagina - 1)
    if (tipos && tipos.length) q = q.in('tipo_movimiento', tipos)
    const { data, error, count } = await q
    if (error) { console.error('Error getJournalEntriesPage:', error); return { data: [], total: 0 } }
    return { data: data || [], total: count || 0 }
  } catch (e) { console.error('Error en getJournalEntriesPage:', e); return { data: [], total: 0 } }
}

/**
 * Solo las referencias de guías de remisión ya generadas (consulta liviana,
 * 1 columna) — para deshabilitar el botón "generar guía" sin bajar el diario.
 */
export async function getReferenciasGuiasRemision() {
  try {
    const { data, error } = await supabase
      .from('journal_entries')
      .select('documento_referencia')
      .eq('tipo_movimiento', 'Guía Remisión')
    if (error) { console.error('Error getReferenciasGuiasRemision:', error); return [] }
    return (data || []).map(r => String(r.documento_referencia || '').trim())
  } catch (e) { console.error('Error en getReferenciasGuiasRemision:', e); return [] }
}

/**
 * Busca un asiento contable por tipo_movimiento + documento_referencia.
 * Útil para evitar duplicados (ej: una guía de remisión ya generada
 * para una factura de compra determinada).
 */
export async function getJournalEntryByReferencia(tipoMovimiento, documentoReferencia) {
  if (!documentoReferencia) return null
  // Consulta puntual en servidor (antes descargaba todo el diario para buscar 1 fila)
  const { data, error } = await supabase
    .from('journal_entries')
    .select('*')
    .eq('tipo_movimiento', tipoMovimiento)
    .eq('documento_referencia', String(documentoReferencia).trim())
    .limit(1)
  if (error) { console.error('Error getJournalEntryByReferencia:', error); return null }
  return data?.[0] || null
}

export async function addJournalEntry(entry) {
  return await insert('journal_entries', entry)
}

export async function updateJournalEntry(id, data) {
  return await update('journal_entries', id, data)
}

export async function deleteJournalEntry(id) {
  return await deleteRecord('journal_entries', id)
}

// ============================================================================
// LÍNEAS DE ASIENTOS CONTABLES
// ============================================================================

export async function getJournalEntryLines() {
  return await getAll('journal_entry_lines')
}

export async function getJournalEntryLinesByEntry(entryId) {
  return await query('journal_entry_lines', { journal_entry_id: entryId })
}

export async function addJournalEntryLine(line) {
  return await insert('journal_entry_lines', line)
}

export async function updateJournalEntryLine(id, data) {
  return await update('journal_entry_lines', id, data)
}

export async function deleteJournalEntryLine(id) {
  return await deleteRecord('journal_entry_lines', id)
}

// ============================================================================
// COSTEO DE IMPORTACIONES
// ============================================================================

export async function getComercialInvoices() {
  return await getAll('comercial_invoices')
}

export async function getComercialInvoiceById(id) {
  return await getById('comercial_invoices', id)
}

export async function addComercialInvoice(invoice) {
  return await insert('comercial_invoices', invoice)
}

export async function updateComercialInvoice(id, data) {
  return await update('comercial_invoices', id, data)
}

export async function deleteComercialInvoice(id) {
  return await deleteRecord('comercial_invoices', id)
}
// ============================================================================
// BILL OF LADING
// ============================================================================

export async function getBillOfLadings() {
  return await getAll('bill_of_ladings')
}

export async function getBillOfLadingById(id) {
  return await getById('bill_of_ladings', id)
}

export async function addBillOfLading(bill_of_lading) {
  return await insert('bill_of_ladings', bill_of_lading)
}

export async function updateBillOfLading(id, data) {
  return await update('bill_of_ladings', id, data)
}

export async function deleteBillOfLading(id) {
  return await deleteRecord('bill_of_ladings', id)
}

// ============================================================================
// CÁLCULOS Y HELPERS
// ============================================================================

export function calcularTotalesLinea(linea) {
  const subtotal = (linea.cantidad || 0) * (linea.precio_unitario || 0)
  const igvAmount = subtotal * ((linea.igv || 0) / 100)
  return {
    subtotal: parseFloat(subtotal.toFixed(2)),
    igv_amount: parseFloat(igvAmount.toFixed(2)),
    total: parseFloat((subtotal + igvAmount).toFixed(2))
  }
}

export function calcularTotalesDocumento(lineas) {
  let subtotal = 0, igv = 0
  lineas.forEach(linea => {
    const calc = calcularTotalesLinea(linea)
    subtotal += calc.subtotal
    igv += calc.igv_amount
  })
  return {
    subtotal: parseFloat(subtotal.toFixed(2)),
    igv: parseFloat(igv.toFixed(2)),
    total: parseFloat((subtotal + igv).toFixed(2))
  }
}

export function formatCurrency(value, currency = 'PEN') {
  const num = parseFloat(value) || 0
  const symbol = currency === 'USD' ? '$' : 'S/.'
  return `${symbol} ${num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

export function formatDate(dateStr) {
  if (!dateStr) return ''
  const date = new Date(dateStr)
  return date.toLocaleDateString('es-PE', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  })
}

export function formatNumber(value) {
  return parseFloat(value || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

// ======================gi======================================================
// CONTABILIDAD HELPERS
// ============================================================================

export async function calcularBalancesCuentas(persistir = true) {
  try {
    const accounts = await getAccounts()
    const lineas = await getJournalEntryLines()

    const resultados = accounts.map(account => {
      let debe = 0, haber = 0
      lineas.forEach(linea => {
        if (linea.account_id === account.id) {
          debe += parseFloat(linea.debe || 0)
          haber += parseFloat(linea.haber || 0)
        }
      })
      debe = parseFloat(debe.toFixed(2))
      haber = parseFloat(haber.toFixed(2))

      const balance = account.naturaleza_saldo === 'acreedor'
        ? parseFloat((haber - debe).toFixed(2))
        : parseFloat((debe - haber).toFixed(2))

      return {
        ...account,
        saldo_debe: debe,
        saldo_haber: haber,
        debit: debe,
        credit: haber,
        balance
      }
    })

    if (persistir) {
      for (const cuenta of resultados) {
        if (cuenta.saldo_debe !== (accounts.find(a => a.id === cuenta.id)?.saldo_debe || 0) ||
            cuenta.saldo_haber !== (accounts.find(a => a.id === cuenta.id)?.saldo_haber || 0)) {
          await updateAccount(cuenta.id, { saldo_debe: cuenta.saldo_debe, saldo_haber: cuenta.saldo_haber })
        }
      }
    }

    return resultados
  } catch (error) {
    console.error('Error en calcularBalancesCuentas:', error)
    return []
  }
}

// ============================================================================
// DIARIOS (modelos automáticos de asientos contables)
// ============================================================================

export async function getDiarios() {
  return await getAll('diarios')
}

export async function getDiarioById(id) {
  return await getById('diarios', id)
}

export async function addDiario(diario) {
  return await insert('diarios', diario)
}

export async function updateDiario(id, data) {
  return await update('diarios', id, data)
}

export async function deleteDiario(id) {
  return await deleteRecord('diarios', id)
}

export async function getDiarioLineas(diarioId) {
  const lineas = await query('diario_lineas', { diario_id: diarioId })
  return (lineas || []).sort((a, b) => (a.orden || 0) - (b.orden || 0))
}

export async function getDiarioLineaById(id) {
  return await getById('diario_lineas', id)
}

export async function addDiarioLinea(linea) {
  return await insert('diario_lineas', linea)
}

export async function updateDiarioLinea(id, data) {
  return await update('diario_lineas', id, data)
}

export async function deleteDiarioLinea(id) {
  return await deleteRecord('diario_lineas', id)
}

/**
 * Busca el diario (modelo) que corresponde a un tipo de movimiento,
 * tipo de documento y moneda. Si no hay un diario con la moneda exacta,
 * intenta uno sin moneda definida (válido para ambas).
 */
// Mapeo de compatibilidad: código SUNAT → strings descriptivos anteriores
// Permite que diarios configurados con el nombre anterior sigan funcionando
const _TIPO_DOC_COMPAT = {
  '01': ['Factura Compra', 'Factura Venta', 'Factura Servicio', 'Factura'],
  '03': ['Boleta Venta', 'Boleta de Venta'],
  '09': ['Ingreso Almacén', 'Guía de Remisión Remitente'],
  '50': ['Liquidación', 'DUA - Importación Definitiva'],
}

export async function getDiarioByModelo(tipoMovimiento, tipoDocumento, moneda) {
  const diarios = await getDiarios()
  // Valores equivalentes al código buscado (el código mismo + aliases legacy)
  const equivalentes = tipoDocumento
    ? [tipoDocumento, ...(_TIPO_DOC_COMPAT[tipoDocumento] || [])]
    : null
  const candidatos = diarios.filter(d =>
    d.activo !== false &&
    d.tipo_movimiento === tipoMovimiento &&
    (equivalentes ? equivalentes.includes(d.tipo_documento) : true)
  )
  let match = candidatos.find(d => d.moneda === moneda)
  if (!match) match = candidatos.find(d => !d.moneda)
  return match || null
}

/**
 * Evalúa una fórmula de diario_lineas (ej: "%subtotal%", "%total% - %igv%")
 * reemplazando los marcadores %clave% por los valores numéricos de `datos`.
 */
export function evaluarFormulaDiario(formula, datos = {}) {
  if (!formula) return 0
  const expr = String(formula).replace(/%([a-zA-Z_]+)%/g, (_, key) => {
    const val = parseFloat(datos[key])
    return isNaN(val) ? 0 : val
  })
  if (!/^[\d+\-*/().\s]+$/.test(expr)) {
    console.warn('Fórmula de diario con caracteres no permitidos:', formula, '->', expr)
    return 0
  }
  try {
    // eslint-disable-next-line no-new-func
    const resultado = Function(`"use strict"; return (${expr})`)()
    return parseFloat((Number(resultado) || 0).toFixed(2))
  } catch (error) {
    console.error('Error evaluando fórmula de diario:', formula, error)
    return 0
  }
}

/**
 * Evalúa la condición de una línea de diario (ej: "tipo_pago='contado'").
 * Si no hay condición, la línea siempre aplica.
 */
export function evaluarCondicionDiario(condicion, datos = {}) {
  if (!condicion) return true
  const cond = String(condicion).trim()
  const match = cond.match(/^([a-zA-Z_]+)\s*=\s*'([^']*)'$/)
  if (match) {
    const [, campo, valor] = match
    return String(datos[campo] ?? '') === valor
  }
  const matchNeq = cond.match(/^([a-zA-Z_]+)\s*!=\s*'([^']*)'$/)
  if (matchNeq) {
    const [, campo, valor] = matchNeq
    return String(datos[campo] ?? '') !== valor
  }
  return true
}

/**
 * Aplica un modelo de diario según tipo_movimiento/tipo_documento/moneda,
 * generando las líneas contables (cuenta_codigo, debe, haber, descripcion)
 * a partir de `datos`. Si una línea usa la cuenta marcador CUENTA_GASTO,
 * se resuelve con datos.cuenta_gasto_codigo.
 */
async function generarLineasDesdeDiario(diario, datos = {}) {
  const lineasModelo = await getDiarioLineas(diario.id)
  const lineas = []

  for (const linea of lineasModelo) {
    if (!evaluarCondicionDiario(linea.condicion, datos)) continue

    const importe = evaluarFormulaDiario(linea.formula, datos)
    if (!importe || importe === 0) continue

    let cuentaCodigo = linea.cuenta_codigo
    if (cuentaCodigo === '__CUENTA_GASTO__' || cuentaCodigo === 'CUENTA_GASTO') {
      cuentaCodigo = datos.cuenta_gasto_codigo
      if (!cuentaCodigo) {
        throw new Error('Esta operación requiere seleccionar una cuenta de gasto (CUENTA_GASTO)')
      }
    }

    // Mapear tipo (1=debe, 2=haber, string 'debe'/'haber') a columnas separadas
    let tipoLinea = linea.tipo
    if (tipoLinea === '1' || tipoLinea === 1) tipoLinea = 'debe'
    else if (tipoLinea === '2' || tipoLinea === 2) tipoLinea = 'haber'

    const monto = Math.abs(importe)
    lineas.push({
      orden: linea.orden,
      cuenta_codigo: cuentaCodigo,
      debe: tipoLinea === 'debe' ? monto : 0,
      haber: tipoLinea === 'haber' ? monto : 0,
      descripcion: linea.descripcion || diario.nombre
    })
  }

  return lineas
}

export async function aplicarModeloDiario(tipoMovimiento, tipoDocumento, moneda, datos = {}) {
  const diario = await getDiarioByModelo(tipoMovimiento, tipoDocumento, moneda)
  if (!diario) {
    throw new Error(`No se encontró un diario configurado para "${tipoMovimiento}" / "${tipoDocumento || '-'}" / "${moneda || '-'}"`)
  }
  const lineas = await generarLineasDesdeDiario(diario, datos)
  return { diario, lineas }
}

/**
 * Igual que aplicarModeloDiario, pero busca el modelo por su nombre exacto
 * (ej: "Compra nacional mercadería", "Venta mercadería contado", "Cobro a cliente").
 * Útil como respaldo cuando tipo_movimiento/tipo_documento/moneda no están
 * configurados de forma exacta en la tabla diarios.
 */
export async function aplicarModeloDiarioPorNombre(nombre, datos = {}) {
  const diarios = await getDiarios()
  const candidatos = diarios.filter(d => (d.nombre || '').trim().toLowerCase() === nombre.trim().toLowerCase())
  if (candidatos.length === 0) {
    throw new Error(`No se encontró el diario "${nombre}"`)
  }
  // Puede haber más de un diario con el mismo nombre (duplicados de seed/importación).
  // Se usa el primero que realmente tenga líneas configuradas, no el primero a secas.
  for (const diario of candidatos) {
    const lineas = await generarLineasDesdeDiario(diario, datos)
    if (lineas.length > 0) return { diario, lineas }
  }
  throw new Error(`El diario "${nombre}" no tiene líneas configuradas (revisa diario_lineas)`)
}

/**
 * Busca un modelo de diario primero por tipo_movimiento/tipo_documento/moneda,
 * y si no existe, intenta por nombre exacto como respaldo.
 */
export async function aplicarModelo({ tipoMovimiento, tipoDocumento, moneda, nombre, datos = {} }) {
  try {
    if (tipoMovimiento) {
      const diario = await getDiarioByModelo(tipoMovimiento, tipoDocumento, moneda)
      if (diario) {
        const lineas = await generarLineasDesdeDiario(diario, datos)
        // Un diario "encontrado" pero sin líneas (duplicado huérfano de un seed,
        // por ejemplo) no es un match válido: se intenta por nombre en vez de
        // devolver un asiento vacío en silencio.
        if (lineas.length > 0) return { diario, lineas }
        console.warn(`aplicarModelo: el diario "${diario.nombre}" (id ${diario.id}) no tiene líneas; se intentará por nombre`)
      }
    }
  } catch (error) {
    console.warn('aplicarModelo: fallo búsqueda por tipo, se intentará por nombre', error)
  }
  if (nombre) {
    return await aplicarModeloDiarioPorNombre(nombre, datos)
  }
  throw new Error(`No se encontró un diario para "${nombre || tipoMovimiento}"`)
}

/**
 * Genera el siguiente número de asiento contable (AS-000001, AS-000002, ...).
 */
export async function generarNumeroAsiento() {
  const entries = await getJournalEntries()
  let max = 0
  entries.forEach(e => {
    const match = String(e.numero_asiento || '').match(/(\d+)$/)
    if (match) max = Math.max(max, parseInt(match[1], 10))
  })
  return `AS-${String(max + 1).padStart(6, '0')}`
}

/**
 * Acumula debe/haber en saldo_debe/saldo_haber de una cuenta del plan de cuentas.
 * Acepta (accountId, debe, haber) — nuevo formato — o (accountId, tipo, importe) legacy.
 */
export async function acumularSaldoCuenta(accountId, debeOrTipo, haberOrImporte) {
  try {
    const account = await getAccountById(accountId)
    if (!account) return
    const data = {}
    // Soporte legacy: si debeOrTipo es string ('debe'/'haber') usamos el importe
    let debe = 0, haber = 0
    if (typeof debeOrTipo === 'string') {
      if (debeOrTipo === 'debe') debe = parseFloat(haberOrImporte || 0)
      else haber = parseFloat(haberOrImporte || 0)
    } else {
      debe = parseFloat(debeOrTipo || 0)
      haber = parseFloat(haberOrImporte || 0)
    }
    if (debe !== 0) data.saldo_debe = parseFloat(((account.saldo_debe || 0) + debe).toFixed(2))
    if (haber !== 0) data.saldo_haber = parseFloat(((account.saldo_haber || 0) + haber).toFixed(2))
    if (Object.keys(data).length > 0) await updateAccount(accountId, data)
  } catch (error) {
    console.error('Error en acumularSaldoCuenta:', error)
  }
}

/**
 * Crea un asiento contable (journal_entries) junto con sus líneas (journal_entry_lines).
 * Resuelve cuenta_codigo → account_id y actualiza saldos de plan_cuentas.
 *
 * Formato de líneas (nuevo): [{ cuenta_codigo, debe, haber, descripcion, contact_id, referencia_doc, fecha_vencimiento }]
 * Formato legacy aceptado:   [{ cuenta_codigo, tipo: 'debe'|'haber', importe, descripcion }]
 */
export async function crearAsientoContable({
  fecha, descripcion, documento_referencia, periodo_contable,
  tipo_movimiento, tipo_documento, contact_id, created_by,
  numero_asiento, numero, lineas, tipo_cambio   // 'numero' acepta legacy
}) {
  if (!lineas || lineas.length === 0) {
    throw new Error('El asiento contable no tiene líneas')
  }

  let totalDebe = 0, totalHaber = 0
  const lineasResueltas = []

  for (const linea of lineas) {
    const account = await getAccountByCode(linea.cuenta_codigo)
    if (!account) {
      throw new Error(`No existe la cuenta "${linea.cuenta_codigo}" en el plan de cuentas`)
    }
    // Soporte formato nuevo (debe/haber) y legacy (tipo/importe)
    let debe = parseFloat(linea.debe || 0)
    let haber = parseFloat(linea.haber || 0)
    if (linea.tipo === 'debe' && debe === 0) debe = parseFloat(linea.importe || 0)
    if (linea.tipo === 'haber' && haber === 0) haber = parseFloat(linea.importe || 0)
    if (debe === 0 && haber === 0) continue

    totalDebe += debe
    totalHaber += haber
    lineasResueltas.push({
      account_id: account.id,
      debe,
      haber,
      descripcion: linea.descripcion || descripcion,
      contact_id: linea.contact_id || null,
      referencia_doc: linea.referencia_doc || null,
      fecha_vencimiento: linea.fecha_vencimiento || null
    })
  }

  if (lineasResueltas.length === 0) {
    throw new Error('El asiento contable no tiene líneas con importe distinto de cero')
  }

  const fechaAsiento = fecha || new Date().toISOString().split('T')[0]
  const nroAsiento = numero_asiento || numero || await generarNumeroAsiento()

  const entry = await addJournalEntry({
    numero_asiento: nroAsiento,
    fecha: fechaAsiento,
    descripcion: descripcion || '',
    documento_referencia: documento_referencia || null,
    periodo_contable: periodo_contable || fechaAsiento.slice(0, 7),
    tipo_movimiento: tipo_movimiento || null,
    tipo_documento: tipo_documento || null,
    contact_id: contact_id || null,
    total_debe: parseFloat(totalDebe.toFixed(2)),
    total_haber: parseFloat(totalHaber.toFixed(2)),
    status: 'confirmado',
    created_by: created_by || null
  })

  if (!entry || !entry.id) {
    throw new Error('No se pudo crear el asiento contable')
  }

  const tipoCambioLinea = tipo_cambio ? parseFloat(tipo_cambio) : null
  for (const linea of lineasResueltas) {
    await addJournalEntryLine({
      journal_entry_id: entry.id,
      account_id: linea.account_id,
      debe: linea.debe,
      haber: linea.haber,
      descripcion: linea.descripcion || null,
      fecha: fechaAsiento,
      tipo_cambio: tipoCambioLinea,
      contact_id: linea.contact_id,
      referencia_doc: linea.referencia_doc,
      fecha_vencimiento: linea.fecha_vencimiento
    })
    await acumularSaldoCuenta(linea.account_id, linea.debe, linea.haber)
  }

  return entry
}

/**
 * Agrega una línea manual a un asiento contable existente (Libro Diario),
 * actualizando los totales del asiento y los saldos del plan de cuentas.
 */
export async function agregarLineaManualAsiento(entryId, { account_id, tipo, importe, debe: debeArg, haber: haberArg, descripcion }) {
  // Acepta formato nuevo (debe/haber) y legacy (tipo/importe)
  let debe = parseFloat(debeArg || 0)
  let haber = parseFloat(haberArg || 0)
  if (tipo === 'debe' && debe === 0) debe = parseFloat(importe || 0)
  if (tipo === 'haber' && haber === 0) haber = parseFloat(importe || 0)
  if (!account_id || (debe === 0 && haber === 0)) {
    throw new Error('Debe indicar cuenta e importe (debe o haber) distinto de cero')
  }

  const line = await addJournalEntryLine({
    journal_entry_id: entryId,
    account_id,
    debe,
    haber,
    descripcion: descripcion || null
  })

  const entry = await getJournalEntryById(entryId)
  if (entry) {
    const data = {}
    if (debe > 0) data.total_debe = parseFloat(((entry.total_debe || 0) + debe).toFixed(2))
    if (haber > 0) data.total_haber = parseFloat(((entry.total_haber || 0) + haber).toFixed(2))
    await updateJournalEntry(entryId, data)
  }

  await acumularSaldoCuenta(account_id, debe, haber)
  return line
}

/**
 * Elimina una línea manual de un asiento, revirtiendo totales y saldos.
 */
export async function eliminarLineaAsiento(lineaId) {
  const lineas = await getJournalEntryLines()
  const linea = lineas.find(l => l.id === lineaId)
  if (!linea) throw new Error('Línea de asiento no encontrada')

  await deleteJournalEntryLine(lineaId)

  const entry = await getJournalEntryById(linea.journal_entry_id)
  if (entry) {
    const data = {}
    const debe = parseFloat(linea.debe || 0)
    const haber = parseFloat(linea.haber || 0)
    if (debe > 0) data.total_debe = parseFloat(((entry.total_debe || 0) - debe).toFixed(2))
    if (haber > 0) data.total_haber = parseFloat(((entry.total_haber || 0) - haber).toFixed(2))
    await updateJournalEntry(entry.id, data)
  }

  const debe = parseFloat(linea.debe || 0)
  const haber = parseFloat(linea.haber || 0)
  // Revertir: acumular en sentido contrario
  await acumularSaldoCuenta(linea.account_id, -debe, -haber)
}

/**
 * Elimina un asiento contable completo: revierte los saldos acumulados de
 * cada cuenta por cada línea, elimina las líneas (journal_entry_lines) y
 * finalmente el encabezado (journal_entries).
 */
export async function eliminarAsientoContable(entryId) {
  const lineas = await getJournalEntryLinesByEntry(entryId)
  for (const linea of lineas) {
    const debe = parseFloat(linea.debe || 0)
    const haber = parseFloat(linea.haber || 0)
    await acumularSaldoCuenta(linea.account_id, -debe, -haber)
    await deleteJournalEntryLine(linea.id)
  }
  await deleteJournalEntry(entryId)
}

/**
 * Cierre periódico: cancela las cuentas de resultado (ingresos, costos,
 * gastos - grupo_reporte = 'Resultado') contra la cuenta 59111
 * (Resultados Acumulados / Utilidad del ejercicio).
 */
export async function cerrarPeriodoContable(periodo, userId) {
  const cuentas = await calcularBalancesCuentas(false)
  const cuentasResultado = cuentas.filter(c => c.grupo_reporte === 'Resultado')

  const lineas = []
  let totalDebe = 0, totalHaber = 0

  for (const c of cuentasResultado) {
    const debe = parseFloat(c.saldo_debe || 0)
    const haber = parseFloat(c.saldo_haber || 0)
    const diferencia = parseFloat((debe - haber).toFixed(2))
    if (Math.abs(diferencia) < 0.01) continue

    if (diferencia > 0) {
      // Cuenta deudora (gasto/costo): se cierra abonando
      lineas.push({ cuenta_codigo: c.codigo, debe: 0, haber: diferencia, descripcion: `Cierre ${c.nombre}` })
      totalHaber += diferencia
    } else {
      // Cuenta acreedora (ingreso): se cierra cargando
      const importe = Math.abs(diferencia)
      lineas.push({ cuenta_codigo: c.codigo, debe: importe, haber: 0, descripcion: `Cierre ${c.nombre}` })
      totalDebe += importe
    }
  }

  if (lineas.length === 0) {
    throw new Error('No hay movimientos en cuentas de resultado para cerrar en este periodo')
  }

  const utilidad = parseFloat((totalDebe - totalHaber).toFixed(2))
  if (utilidad > 0) {
    lineas.push({ cuenta_codigo: '59111', debe: 0, haber: utilidad, descripcion: 'Utilidad del ejercicio' })
  } else if (utilidad < 0) {
    lineas.push({ cuenta_codigo: '59111', debe: Math.abs(utilidad), haber: 0, descripcion: 'Pérdida del ejercicio' })
  }

  return await crearAsientoContable({
    fecha: new Date().toISOString().split('T')[0],
    descripcion: `Cierre del periodo ${periodo}`,
    documento_referencia: `CIERRE-${periodo}`,
    periodo_contable: periodo,
    tipo_movimiento: 'Cierre',
    tipo_documento: 'Interno',
    created_by: userId,
    lineas
  })
}

// ============================================================================
// ASIENTOS AUTOMÁTICOS — COMPRA DOMÉSTICA DE MERCADERÍA
// ============================================================================

/**
 * Genera el asiento contable de una compra doméstica de mercadería (factura
 * de proveedor local, mercadería gravada):
 *   DEBE:  601111 Compra mercadería + 40111C IGV crédito fiscal
 *   HABER: 42111 Factura por pagar (proveedor local)
 * Usa el diario configurado "Compra nacional mercadería" (Compra/01/PEN);
 * si la compra está en otra moneda/documento sin diario configurado, falla
 * con un mensaje claro en vez de adivinar cuentas.
 * Se vincula a la compra mediante compras.asiento_id.
 */
export async function generarAsientoCompra(compraId, userId) {
  const compra = await getCompraById(compraId)
  if (!compra) throw new Error('Compra no encontrada')
  if (compra.asiento_id) throw new Error('Esta compra ya tiene un asiento contable generado')

  const subtotal = parseFloat(compra.subtotal ?? compra.base_imponible_gravada ?? 0)
  const igv      = parseFloat(compra.igv_gravado || 0)
  const total    = parseFloat(compra.total || 0)

  const { lineas } = await aplicarModelo({
    tipoMovimiento: 'Compra',
    tipoDocumento:  compra.tipo_comprobante || '01',
    moneda:         compra.currency || 'PEN',
    nombre:         'Compra nacional mercadería',
    datos: { subtotal, igv, total, monto: total }
  })

  const periodo = compra.periodo_ano && compra.periodo_mes
    ? `${compra.periodo_ano}-${String(compra.periodo_mes).padStart(2, '0')}`
    : (compra.fecha_emision || '').slice(0, 7)

  const entry = await crearAsientoContable({
    fecha:                compra.fecha_emision,
    descripcion:           `Compra ${compra.numero || compra.referencia || ''} — ${compra.proveedor_nombre || ''}`.trim(),
    documento_referencia:  compra.referencia || compra.numero,
    periodo_contable:      periodo,
    tipo_movimiento:       'Compra',
    tipo_documento:        compra.tipo_comprobante || '01',
    contact_id:            compra.contact_id,
    created_by:            userId,
    lineas
  })

  await updateCompra(compraId, { asiento_id: entry.id })
  return entry
}

// ============================================================================
// ASIENTOS AUTOMÁTICOS - IMPORTACIONES
// ============================================================================

/**
 * Genera el asiento "Importación - Factura proveedor" (debe 28111 / haber 42122, USD)
 * a partir de un comercial_invoice ya confirmado.
 */
export async function generarAsientoFacturaImportacion(comercialInvoiceId, userId) {
  const invoice = await getComercialInvoiceById(comercialInvoiceId)
  if (!invoice) throw new Error('Comercial invoice no encontrado')

  const monto = parseFloat(invoice.valor_total_final_ci || invoice.total || 0)
  const { lineas } = await aplicarModelo({
    tipoMovimiento: 'Importación',
    tipoDocumento: '01',
    moneda: 'USD',
    nombre: 'Importación - Factura proveedor',
    datos: { monto, total: monto, subtotal: monto }
  })

  return await crearAsientoContable({
    fecha: invoice.fecha || new Date().toISOString().split('T')[0],
    descripcion: `Importación - Factura proveedor ${invoice.numero_invoice || ''}`.trim(),
    documento_referencia: invoice.numero_invoice || `CI-${invoice.id}`,
    tipo_movimiento: 'Importación',
    tipo_documento: '01',
    contact_id: invoice.proveedor_id || null,
    created_by: userId,
    lineas
  })
}

/**
 * Genera el asiento "Importación - Liquidación impuestos" (PEN) a partir de
 * los datos de la DAM (derechos, igv, total_pagado).
 */
export async function generarAsientoLiquidacionDAM(damId, userId) {
  const dam = await getDAMById(damId)
  if (!dam) throw new Error('DAM no encontrado')

  const derechos = parseFloat(dam.ad_valorem_usd || dam.derechos || 0) * parseFloat(dam.tipo_cambio || 1)
  const igv = parseFloat(dam.igv_usd || dam.igv || 0) * parseFloat(dam.tipo_cambio || 1)
  const totalPagado = parseFloat(dam.total_liquidacion || 0) * parseFloat(dam.tipo_cambio || 1)

  const { lineas } = await aplicarModelo({
    tipoMovimiento: 'Importación',
    tipoDocumento: '50',
    moneda: 'PEN',
    nombre: 'Importación - Liquidación impuestos',
    datos: {
      derechos: parseFloat(derechos.toFixed(2)),
      igv: parseFloat(igv.toFixed(2)),
      total_pagado: parseFloat(totalPagado.toFixed(2)),
      monto: parseFloat(totalPagado.toFixed(2)),
      total: parseFloat(totalPagado.toFixed(2))
    }
  })

  return await crearAsientoContable({
    fecha: new Date().toISOString().split('T')[0],
    descripcion: `Importación - Liquidación de tributos DAM ${dam.numero_dam || dam.id}`,
    documento_referencia: dam.numero_dam || `DAM-${dam.id}`,
    tipo_movimiento: 'Importación',
    tipo_documento: '50',
    created_by: userId,
    lineas
  })
}

// ============================================================================
// GUÍA DE REMISIÓN - VALUACIÓN DE INVENTARIO (ingreso de mercadería a almacén)
// ============================================================================

/**
 * Genera el asiento "Valuación de inventario" (debe 201111 Mercaderías-Costo /
 * haber 611511 Variación de existencias - Otras mercaderías) por el ingreso
 * de mercadería al almacén mediante una guía de remisión.
 *
 * Se vincula a su documento de origen (factura de compra, guía de
 * importación, etc.) mediante `documento_referencia`, lo que permite
 * detectar duplicados con getJournalEntryByReferencia().
 *
 * Primero intenta resolver el modelo configurado en "diarios" (tipo_movimiento
 * 'Guía Remisión' / tipo_documento '09', o por el nombre exacto
 * "Valuación de inventario"); si no existe ningún diario configurado, usa
 * el asiento estándar 201111 (debe) / 611511 (haber) como respaldo.
 */
export async function generarAsientoGuiaRemision({
  monto, documento_referencia, descripcion, contact_id, fecha, userId, tipo_documento
}) {
  const importe = parseFloat(monto || 0)
  if (!importe || importe <= 0) {
    throw new Error('El monto de la guía de remisión debe ser mayor a cero')
  }

  const datos = { monto: importe, subtotal: importe, total: importe }
  let lineas
  try {
    const resultado = await aplicarModelo({
      tipoMovimiento: 'Guía Remisión',
      tipoDocumento: tipo_documento || '09',
      moneda: 'PEN',
      nombre: 'Valuación de inventario',
      datos
    })
    lineas = resultado.lineas
  } catch (error) {
    // Respaldo: asiento estándar de valuación de inventario por ingreso a almacén
    lineas = [
      { cuenta_codigo: '20111', debe: importe, haber: 0, descripcion: descripcion || 'Ingreso de mercadería a almacén' },
      { cuenta_codigo: '611511', debe: 0, haber: importe, descripcion: descripcion || 'Valuación de inventario - ingreso a almacén' }
    ]
  }

  return await crearAsientoContable({
    fecha: fecha || new Date().toISOString().split('T')[0],
    descripcion: descripcion || 'Guía de Remisión - Ingreso a almacén',
    documento_referencia: documento_referencia || null,
    tipo_movimiento: 'Guía Remisión',
    tipo_documento: tipo_documento || '09',
    contact_id: contact_id || null,
    created_by: userId,
    lineas
  })
}

// ============================================================================
// DAM (Declaración Aduanal de Mercancías)
// ============================================================================

export async function getDAMs() {
  return await getAll('dams')
}

export async function getDAMById(id) {
  return await getById('dams', id)
}

export async function getDAMByImportacionId(importacionId) {
  return await query('dams', { importacion_id: importacionId })
}

export async function addDAM(dam) {
  return await insert('dams', dam)
}

export async function updateDAM(id, data) {
  return await update('dams', id, data)
}

export async function deleteDAM(id) {
  return await deleteRecord('dams', id)
}

// ============================================================================
// GUÍA DE REMISIÓN
// ============================================================================

export async function getGuiasRemision() {
  return await getAll('guias_remision')
}

export async function getGuiaRemisionById(id) {
  return await getById('guias_remision', id)
}

export async function getGuiaRemisionByImportacionId(importacionId) {
  return await query('guias_remision', { importacion_id: importacionId })
}

export async function addGuiaRemision(guia) {
  return await insert('guias_remision', guia)
}

export async function updateGuiaRemision(id, data) {
  return await update('guias_remision', id, data)
}

export async function deleteGuiaRemision(id) {
  return await deleteRecord('guias_remision', id)
}

// ============================================================================
// GASTOS LOCALES
// ============================================================================

export async function getGastosLocales() {
  return await getAll('gastos_locales')
}

export async function getGastoLocalById(id) {
  return await getById('gastos_locales', id)
}

export async function getGastoLocalByImportacionId(importacionId) {
  return await query('gastos_locales', { importacion_id: importacionId })
}

export async function addGastoLocal(gasto) {
  return await insert('gastos_locales', gasto)
}

export async function updateGastoLocal(id, data) {
  return await update('gastos_locales', id, data)
}

export async function deleteGastoLocal(id) {
  return await deleteRecord('gastos_locales', id)
}

// ============================================================================
// PAGOS
// ============================================================================

export async function getPagos() {
  return await getAll('pagos')
}

export async function getPagoById(id) {
  return await getById('pagos', id)
}

export async function getPagoByImportacionId(importacionId) {
  return await query('pagos', { importacion_id: importacionId })
}

export async function addPago(pago) {
  return await insert('pagos', pago)
}

export async function updatePago(id, data) {
  return await update('pagos', id, data)
}

export async function deletePago(id) {
  return await deleteRecord('pagos', id)
}

// ============================================================================
// SUPABASE-DATA-DETALLE-CI.JS
// Funciones para manejar detalle_comercial_invoice
// Agregar a supabase-data.js
// ============================================================================

// ============================================================================
// DETALLE COMERCIAL INVOICE
// ============================================================================

export async function getDetalleCI() {
  return await getAll('detalle_comercial_invoice')
}

export async function getDetalleCIById(id) {
  return await getById('detalle_comercial_invoice', id)
}

export async function getDetalleCIByComercialInvoiceId(comercialInvoiceId) {
  return await query('detalle_comercial_invoice', { comercial_invoice_id: comercialInvoiceId })
}

export async function addDetalleCI(detalle) {
  return await insert('detalle_comercial_invoice', detalle)
}

export async function updateDetalleCI(id, data) {
  return await update('detalle_comercial_invoice', id, data)
}

export async function deleteDetalleCI(id) {
  return await deleteRecord('detalle_comercial_invoice', id)
}

// ============================================================================
// HELPERS: Cálculos automáticos
// ============================================================================

/**
 * Calcular el costo total de un detalle
 */
export function calcularCostoDetalleCI(cantidadUnid, costoUnitario) {
  return parseFloat((cantidadUnid * costoUnitario).toFixed(2))
}

/**
 * Calcular totales desde los detalles
 * Retorna: { total_unidades, cantidad_total_neto, cantidad_total_gross, valor_total_final }
 */
export async function calcularTotalesCI(comercialInvoiceId) {
  try {
    const detalles = await getDetalleCIByComercialInvoiceId(comercialInvoiceId)
    
    if (!detalles || detalles.length === 0) {
      return {
        total_unidades: 0,
        cantidad_total_neto: 0,
        cantidad_total_gross: 0,
        valor_total_final_ci: 0
      }
    }

    const totales = detalles.reduce((acc, detalle) => {
      return {
        total_unidades: acc.total_unidades + (detalle.cantidad_unid || 0),
        cantidad_total_neto: acc.cantidad_total_neto + (detalle.cantidad_neto || 0),
        cantidad_total_gross: acc.cantidad_total_gross + (detalle.cantidad_gross || 0),
        valor_total_final_ci: acc.valor_total_final_ci + (detalle.costo_total || 0)
      }
    }, {
      total_unidades: 0,
      cantidad_total_neto: 0,
      cantidad_total_gross: 0,
      valor_total_final_ci: 0
    })

    return {
      total_unidades: totales.total_unidades,
      cantidad_total_neto: parseFloat(totales.cantidad_total_neto.toFixed(2)),
      cantidad_total_gross: parseFloat(totales.cantidad_total_gross.toFixed(2)),
      valor_total_final_ci: parseFloat(totales.valor_total_final_ci.toFixed(2))
    }
  } catch (error) {
    console.error('Error en calcularTotalesCI:', error)
    return {
      total_unidades: 0,
      cantidad_total_neto: 0,
      cantidad_total_gross: 0,
      valor_total_final_ci: 0
    }
  }
}

// ============================================================================
// VENTAS
// ============================================================================

export async function getVentas() { return await getAll('ventas') }
export async function getVentaById(id) { return await getById('ventas', id) }
export async function addVenta(v) { return await insert('ventas', v) }
export async function updateVenta(id, data) { return await update('ventas', id, data) }
export async function deleteVenta(id) { return await deleteRecord('ventas', id) }

export async function getDetalleVentas(ventaId) { return await query('detalle_ventas', { venta_id: ventaId }) }

/** Todas las líneas de venta de TODAS las ventas (para reportes agregados, evita N+1). */
export async function getTodosDetalleVentas() { return await query('detalle_ventas', {}) }

// ============================================================================
// DECOLECTA — Contador de consultas RUC/DNI (cuota mensual del plan)
// ============================================================================

/** Registra una llamada real que sí llegó a pegarle a la API de Decolecta (consume cuota). */
export async function addDecolectaConsultaLog(tipo, numero, exitosa = true, mensajeError = null, origenModulo = null, createdBy = null) {
  return await insert('decolecta_consultas_log', {
    tipo, numero, exitosa, mensaje_error: mensajeError, origen_modulo: origenModulo, created_by: createdBy
  })
}

/**
 * Consumo del mes en curso: ajuste_manual (semilla/corrección) + conteo real
 * del log de este periodo, contra el límite mensual del plan.
 * Retorna { periodo, usadas, limite, restantes, porcentaje }.
 */
export async function getDecolectaUsoMesActual() {
  const hoy = new Date()
  const periodo = `${hoy.getFullYear()}-${String(hoy.getMonth() + 1).padStart(2, '0')}`
  const desde = `${periodo}-01T00:00:00`

  const [ajustes, logMes] = await Promise.all([
    query('decolecta_uso_ajuste', { periodo }),
    query('decolecta_consultas_log', {})
  ])

  const ajuste = ajustes?.[0] || { ajuste_manual: 0, limite_mensual: 100 }
  const delMes = (logMes || []).filter(l => (l.created_at || '') >= desde)
  const usadas = (ajuste.ajuste_manual || 0) + delMes.length
  const limite = ajuste.limite_mensual || 100

  return {
    periodo,
    usadas,
    limite,
    restantes: Math.max(0, limite - usadas),
    porcentaje: limite > 0 ? Math.min(100, Math.round((usadas / limite) * 100)) : 0
  }
}
export async function addDetalleVenta(d) { return await insert('detalle_ventas', d) }
export async function updateDetalleVenta(id, data) { return await update('detalle_ventas', id, data) }
export async function deleteDetalleVenta(id) { return await deleteRecord('detalle_ventas', id) }

/**
 * Genera el siguiente número CORRELATIVO puro (ej: 1, 2, 3...), sin el
 * prefijo de serie. El caller (guardarNuevaVenta) arma numero =
 * `${serie}-${correlativo padded}` y guarda `correlativo` por separado.
 *
 * Antes esta función devolvía el string ya formateado "F001-00001" y el
 * caller lo trataba como si fuera solo el correlativo, generando
 * numero="F001-F001-00001" y guardando ese string completo en la columna
 * `correlativo`. Como el número final quedaba siempre idéntico (el
 * cálculo de "max" hacía parseInt sobre "F001", que es NaN), la SEGUNDA
 * venta en adelante chocaba con la restricción UNIQUE de `numero` y el
 * guardado fallaba en silencio (el error solo aparecía en consola).
 */
export async function generarNumeroVenta(tipoComprobante = '01', serie = null) {
  const ventas = await getVentas()
  const prefix = serie || (tipoComprobante === '01' ? 'F001' : 'B001')
  const existing = ventas.filter(v => v.numero && v.numero.startsWith(prefix + '-'))
  let max = 0
  existing.forEach(v => {
    const n = parseInt(String(v.numero).split('-').pop() || '0', 10)
    if (!isNaN(n) && n > max) max = n
  })
  return max + 1
}

// ============================================================================
// BANCOS
// ============================================================================

export async function getBancos() { return await getAll('bancos') }
export async function getBancoById(id) { return await getById('bancos', id) }
export async function addBanco(b) { return await insert('bancos', b) }
export async function updateBanco(id, data) { return await update('bancos', id, data) }
export async function deleteBanco(id) { return await deleteRecord('bancos', id) }

// ============================================================================
// MOVIMIENTOS BANCARIOS
// ============================================================================

export async function getMovimientosBanco(bancoId) {
  if (bancoId) return await query('movimientos_banco', { banco_id: bancoId })
  return await getAll('movimientos_banco')
}
export async function addMovimientoBanco(m) { return await insert('movimientos_banco', m) }
export async function updateMovimientoBanco(id, data) { return await update('movimientos_banco', id, data) }
export async function deleteMovimientoBanco(id) { return await deleteRecord('movimientos_banco', id) }

// ============================================================================
// CUENTAS POR COBRAR (CxC)
// ============================================================================

export async function getCuentasCobrar() { return await getAll('cuentas_cobrar') }
export async function getCuentaCobrarById(id) { return await getById('cuentas_cobrar', id) }
export async function getCuentasCobrarByContact(contactId) { return await query('cuentas_cobrar', { contact_id: contactId }) }
export async function getCuentasCobrarByVenta(ventaId) { return await query('cuentas_cobrar', { venta_id: ventaId }) }
export async function addCuentaCobrar(cxc) { return await insert('cuentas_cobrar', cxc) }
export async function updateCuentaCobrar(id, data) { return await update('cuentas_cobrar', id, data) }
export async function deleteCuentaCobrar(id) { return await deleteRecord('cuentas_cobrar', id) }

// ============================================================================
// VENTAS_ANTICIPOS_APLICADOS — espejo de compras_anticipos_aplicados, para
// anticipos de clientes. Ver 55_anticipos_proveedor_cliente.sql.
// ============================================================================

export async function getTodosVentasAnticiposAplicados() { return await getAll('ventas_anticipos_aplicados') }
export async function getAnticiposAplicadosPorAnticipoVenta(ventaAnticipoId) {
  return await query('ventas_anticipos_aplicados', { venta_anticipo_id: ventaAnticipoId })
}
export async function getAnticiposAplicadosPorDestinoVenta(ventaDestinoId) {
  return await query('ventas_anticipos_aplicados', { venta_destino_id: ventaDestinoId })
}
export async function addVentaAnticipoAplicado(d) { return await insert('ventas_anticipos_aplicados', d) }

// ============================================================================
// NOTA_CREDITO_VENTA_DETALLE — devolución de mercadería por ítem/lote/bulto en
// una NC EMITIDA al cliente. Ver 46_nota_credito_devolucion_stock.sql y el
// rename a nota_credito_venta_detalle en 53_devolucion_compra.sql (antes se
// llamaba nota_credito_detalle a secas — se renombró para ser simétrica con
// nota_credito_compra_detalle, la tabla equivalente para devoluciones A
// proveedor).
// ============================================================================

export async function getNotaCreditoVentaDetalleByNota(notaVentaId) { return await query('nota_credito_venta_detalle', { nota_venta_id: notaVentaId }) }
export async function getNotaCreditoVentaDetalleByVentaOrigen(ventaOrigenId) { return await query('nota_credito_venta_detalle', { venta_origen_id: ventaOrigenId }) }
export async function addNotaCreditoVentaDetalle(d) { return await insert('nota_credito_venta_detalle', d) }
export async function deleteNotaCreditoVentaDetalle(id) { return await deleteRecord('nota_credito_venta_detalle', id) }

// ============================================================================
// CUENTAS POR PAGAR (CxP) — espejo exacto de Cuentas por Cobrar. Se crea al
// registrar una COMPRA con comprobante '01' (factura), igual que ventas.js
// crea la CxC al registrar la venta — nunca desde una Guía (de Remisión o
// Despacho), que solo mueven stock.
// ============================================================================

export async function getCuentasPagar() { return await getAll('cuentas_pagar') }
export async function getCuentaPagarById(id) { return await getById('cuentas_pagar', id) }
export async function getCuentasPagarByContact(contactId) { return await query('cuentas_pagar', { contact_id: contactId }) }
export async function getCuentasPagarByCompra(compraId) { return await query('cuentas_pagar', { compra_id: compraId }) }
export async function addCuentaPagar(cxp) { return await insert('cuentas_pagar', cxp) }
export async function updateCuentaPagar(id, data) { return await update('cuentas_pagar', id, data) }
export async function deleteCuentaPagar(id) { return await deleteRecord('cuentas_pagar', id) }

// ============================================================================
// COMPRAS_ANTICIPOS_APLICADOS — declara qué factura de anticipo (compras con
// tipo_compra='anticipo') canceló qué monto de qué factura real. Ver
// 55_anticipos_proveedor_cliente.sql.
// ============================================================================

export async function getTodosComprasAnticiposAplicados() { return await getAll('compras_anticipos_aplicados') }
export async function getAnticiposAplicadosPorAnticipoCompra(compraAnticipoId) {
  return await query('compras_anticipos_aplicados', { compra_anticipo_id: compraAnticipoId })
}
export async function getAnticiposAplicadosPorDestinoCompra(compraDestinoId) {
  return await query('compras_anticipos_aplicados', { compra_destino_id: compraDestinoId })
}
export async function addCompraAnticipoAplicado(d) { return await insert('compras_anticipos_aplicados', d) }

// ============================================================================
// COBROS
// ============================================================================

export async function getCobros() { return await getAll('cobros') }
export async function getCobroById(id) { return await getById('cobros', id) }
export async function getCobrosByCxC(cxcId) { return await query('cobros', { cxc_id: cxcId }) }
export async function addCobro(cobro) { return await insert('cobros', cobro) }
export async function updateCobro(id, data) { return await update('cobros', id, data) }
export async function deleteCobro(id) { return await deleteRecord('cobros', id) }

// ============================================================================
// PAGOS A PROVEEDORES
// ============================================================================

export async function getPagosProveedores() { return await getAll('pagos_proveedores') }
export async function getPagoProveedorById(id) { return await getById('pagos_proveedores', id) }
export async function getPagosProveedoresByCompra(compraId) { return await query('pagos_proveedores', { compra_id: compraId }) }
export async function getPagosProveedoresByCxP(cxpId) { return await query('pagos_proveedores', { cxp_id: cxpId }) }
export async function addPagoProveedor(pago) { return await insert('pagos_proveedores', pago) }
export async function deletePagoProveedor(id) { return await deleteRecord('pagos_proveedores', id) }

// ============================================================================
// KARDEX
// ============================================================================

export async function getKardex() { return await getAll('kardex') }
export async function getKardexById(id) { return await getById('kardex', id) }
export async function getKardexByItem(itemId) { return await query('kardex', { item_id: itemId }) }
export async function getKardexByCompra(compraId) { return await query('kardex', { compra_id: compraId }) }
export async function getKardexByVenta(ventaId) { return await query('kardex', { venta_id: ventaId }) }
export async function addKardexMovimiento(k) { return await insert('kardex', k) }
export async function deleteKardexMovimiento(id) { return await deleteRecord('kardex', id) }

// Ubicaciones virtuales de terceros (modelo Odoo: Partners/Vendors y
// Partners/Customers), para que compras y ventas también tengan un
// origen/destino en el Kardex, igual que los traslados internos.
// Se resuelven por código, no por nombre (evita romper si alguien
// traduce/edita el nombre visible).
export async function getUbicacionVendors() {
  const ubicaciones = await getUbicaciones()
  return ubicaciones.find(u => u.codigo === 'VENDORS') || null
}

export async function getUbicacionCustomers() {
  const ubicaciones = await getUbicaciones()
  return ubicaciones.find(u => u.codigo === 'CUSTOMERS') || null
}

// ============================================================================
// PERIODOS CONTABLES
// ============================================================================

export async function getPeriodosContables() { return await getAll('periodos_contables') }
export async function getPeriodoByPeriodo(periodo) {
  const periodos = await getPeriodosContables()
  return periodos.find(p => p.periodo === periodo) || null
}
export async function addPeriodoContable(p) { return await insert('periodos_contables', p) }
export async function updatePeriodoContable(id, data) { return await update('periodos_contables', id, data) }

/**
 * Asegura que el período de la fecha indicada exista como abierto.
 */
export async function asegurarPeriodoAbierto(fecha) {
  const periodo = (fecha || new Date().toISOString().split('T')[0]).slice(0, 7)
  const existente = await getPeriodoByPeriodo(periodo)
  if (!existente) {
    const [ano, mes] = periodo.split('-').map(Number)
    await addPeriodoContable({ periodo, ano, mes, estado: 'abierto' })
  }
  return periodo
}

// ============================================================================
// ASIENTOS AUTOMÁTICOS — VENTA
// ============================================================================

/**
 * Genera el asiento contable de una venta (factura/boleta):
 *   DEBE:  12111 Cuentas x cobrar (o 10111 si es efectivo)
 *   HABER: 701111 Ventas + 40111 IGV
 * Luego genera el asiento de costo de ventas (si hay costo):
 *   DEBE:  691111 Costo de ventas
 *   HABER: 20111 Mercaderías
 */
export async function generarAsientoVenta(ventaId, userId) {
  const venta = await getVentaById(ventaId)
  if (!venta) throw new Error('Venta no encontrada')

  const lineas = await getDetalleVentas(ventaId)
  const subtotal = parseFloat(venta.base_imponible || 0)
  const igv      = parseFloat(venta.igv || 0)
  const total    = parseFloat(venta.total || 0)

  // Determinar cuenta deudora según tipo de comprobante
  const cuentaDeudora = venta.tipo_comprobante === '03' ? '10111' : '12111'

  const { lineas: lineasContables } = await aplicarModelo({
    tipoMovimiento: 'Venta',
    tipoDocumento:  venta.tipo_comprobante,
    moneda:         venta.moneda || 'PEN',
    nombre:         venta.tipo_comprobante === '03'
      ? 'Venta mercadería boleta PEN'
      : 'Venta mercadería factura PEN',
    datos: { subtotal, igv, total, monto: total }
  })

  const entry = await crearAsientoContable({
    fecha:               venta.fecha_emision,
    descripcion:         `Venta ${venta.numero} — ${venta.tipo_comprobante === '01' ? 'Factura' : 'Boleta'}`,
    documento_referencia: venta.numero,
    periodo_contable:    venta.periodo_contable || venta.fecha_emision.slice(0, 7),
    tipo_movimiento:     'Venta',
    tipo_documento:      venta.tipo_comprobante,
    contact_id:          venta.contact_id,
    origen_tipo:         'venta',
    origen_id:           venta.id,
    created_by:          userId,
    lineas:              lineasContables
  })

  // Asiento de costo de ventas (si hay ítems con costo)
  let costoTotal = 0
  for (const l of lineas) {
    const costo = parseFloat(l.costo_unitario || 0) * parseFloat(l.cantidad || 0)
    costoTotal += costo
  }

  if (costoTotal > 0.01) {
    await crearAsientoContable({
      fecha:               venta.fecha_emision,
      descripcion:         `Costo de ventas — ${venta.numero}`,
      documento_referencia: venta.numero,
      periodo_contable:    venta.periodo_contable || venta.fecha_emision.slice(0, 7),
      tipo_movimiento:     'Costo Ventas',
      origen_tipo:         'venta',
      origen_id:           venta.id,
      created_by:          userId,
      lineas: [
        { cuenta_codigo: '691111', debe: parseFloat(costoTotal.toFixed(2)), haber: 0,                               descripcion: `CMV — ${venta.numero}` },
        { cuenta_codigo: '20111',  debe: 0,                               haber: parseFloat(costoTotal.toFixed(2)), descripcion: `Salida inventario — ${venta.numero}` }
      ]
    })
  }

  // Actualizar asiento_id en la venta
  await updateVenta(ventaId, { asiento_id: entry.id })

  return entry
}

// ============================================================================
// ASIENTOS AUTOMÁTICOS — COBRO A CLIENTE
// ============================================================================

export async function generarAsientoCobroCliente({ cobroId, monto, cxcId, bancoId, medioPago, fecha, descripcion, userId }) {
  const cuentaBanco = bancoId
    ? ((await getBancoById(bancoId))?.cuenta_contable_codigo || '10411')
    : (medioPago === 'efectivo' ? '10111' : '10411')

  return await crearAsientoContable({
    fecha:               fecha || new Date().toISOString().split('T')[0],
    descripcion:         descripcion || 'Cobro a cliente',
    documento_referencia: cobroId ? `COBRO-${cobroId}` : null,
    tipo_movimiento:     'Cobro',
    origen_tipo:         'cobro',
    origen_id:           cobroId,
    created_by:          userId,
    lineas: [
      { cuenta_codigo: cuentaBanco, debe: parseFloat(monto), haber: 0,              descripcion: 'Cobro a cliente' },
      { cuenta_codigo: '12111',     debe: 0,              haber: parseFloat(monto), descripcion: 'Cancelación CxC' }
    ]
  })
}

// ============================================================================
// ASIENTOS AUTOMÁTICOS — PAGO A PROVEEDOR
// ============================================================================

export async function generarAsientoPagoProveedor({ pagoId, monto, compraId, bancoId, moneda, fecha, descripcion, userId }) {
  const cuentaBanco = bancoId
    ? ((await getBancoById(bancoId))?.cuenta_contable_codigo || '10411')
    : '10411'

  const cuentaProveedor = moneda === 'USD' ? '42122' : '42111'

  return await crearAsientoContable({
    fecha:               fecha || new Date().toISOString().split('T')[0],
    descripcion:         descripcion || 'Pago a proveedor',
    documento_referencia: pagoId ? `PAGO-${pagoId}` : null,
    tipo_movimiento:     'Pago Proveedor',
    origen_tipo:         'pago_proveedor',
    origen_id:           pagoId,
    created_by:          userId,
    lineas: [
      { cuenta_codigo: cuentaProveedor, debe: parseFloat(monto), haber: 0,                  descripcion: 'Cancelación CxP' },
      { cuenta_codigo: cuentaBanco,     debe: 0,                 haber: parseFloat(monto),  descripcion: 'Pago a proveedor' }
    ]
  })
}

// ============================================================================
// REVERSAR ASIENTO
// ============================================================================

export async function reversarAsiento(asientoId, userId, motivo = 'Corrección') {
  const { data, error } = await supabase.rpc('fn_reversar_asiento', {
    p_asiento_id: asientoId,
    p_user_id:    userId || null,
    p_motivo:     motivo
  })
  if (error) throw new Error(`Error al reversar asiento: ${error.message}`)
  return data  // retorna el ID del asiento de reversión
}

// ============================================================================
// SECUENCIA DE DOCUMENTOS (correlativo estilo Odoo, ej. "SJLP/INT/00393")
// ============================================================================
// Sube el contador atómicamente en la BD (ver 56_secuencias_documentos_traslados.sql)
// y devuelve el número entero — el llamador arma el string final con el
// código del almacén y el tipo. Un error aquí (p. ej. migración no corrida
// todavía) se propaga para que el llamador decida (normalmente: seguir sin
// numero_documento en vez de bloquear el traslado).
export async function obtenerSiguienteNumeroSecuencia(almacenId, tipo) {
  const { data, error } = await supabase.rpc('obtener_siguiente_numero_secuencia', {
    p_almacen_id: almacenId,
    p_tipo:       tipo
  })
  if (error) throw new Error(`Error al generar número de documento: ${error.message}`)
  return data // entero
}

// ============================================================================
// BALANCE GENERAL (desde vista PostgreSQL)
// ============================================================================

export async function getBalanceComprobacionVista() {
  const { data, error } = await supabase.from('v_balance_comprobacion').select('*')
  if (error) { console.error('Error v_balance_comprobacion:', error); return [] }
  return data || []
}

export async function getLibroMayor(cuentaCodigo = null) {
  let q = supabase.from('v_libro_mayor').select('*')
  if (cuentaCodigo) q = q.eq('cuenta_codigo', cuentaCodigo)
  const { data, error } = await q
  if (error) { console.error('Error v_libro_mayor:', error); return [] }
  return data || []
}

export async function getRegistroCompras(periodoAno = null, periodoMes = null) {
  let q = supabase.from('v_registro_compras').select('*')
  if (periodoAno) q = q.eq('periodo', `${periodoAno}${String(periodoMes || 1).padStart(2,'0')}`)
  const { data, error } = await q
  if (error) { console.error('Error v_registro_compras:', error); return [] }
  return data || []
}

export async function getRegistroVentas(periodoStr = null) {
  let q = supabase.from('v_registro_ventas').select('*')
  if (periodoStr) q = q.eq('periodo', periodoStr)
  const { data, error } = await q
  if (error) { console.error('Error v_registro_ventas:', error); return [] }
  return data || []
}
// ============================================================================
// TÉRMINOS DE PAGO Y CUOTAS (Etapa A de CxC/CxP)
// ============================================================================

export async function getTerminosPago() { return await getAll('terminos_pago') }
export async function getTerminoPagoById(id) { return await getById('terminos_pago', id) }
export async function addTerminoPago(t) { return await insert('terminos_pago', t) }
export async function updateTerminoPago(id, data) { return await update('terminos_pago', id, data) }
export async function deleteTerminoPago(id) { return await deleteRecord('terminos_pago', id) }

export async function getTerminosPagoCuotas(terminoId) {
  if (terminoId === undefined || terminoId === null) return await getAll('terminos_pago_cuotas')
  return await query('terminos_pago_cuotas', { termino_id: terminoId })
}
export async function addTerminoPagoCuota(c) { return await insert('terminos_pago_cuotas', c) }
export async function deleteTerminoPagoCuota(id) { return await deleteRecord('terminos_pago_cuotas', id) }

// ── Cuotas por cobrar ──
export async function getCuotasCobrar() { return await getAll('cuotas_cobrar') }
export async function getCuotasCobrarByCxC(cxcId) { return await query('cuotas_cobrar', { cxc_id: cxcId }) }
export async function getCuotaCobrarById(id) { return await getById('cuotas_cobrar', id) }
export async function addCuotaCobrar(c) { return await insert('cuotas_cobrar', c) }
export async function updateCuotaCobrar(id, data) { return await update('cuotas_cobrar', id, data) }
export async function deleteCuotaCobrar(id) { return await deleteRecord('cuotas_cobrar', id) }

// ── Cuotas por pagar ──
export async function getCuotasPagar() { return await getAll('cuotas_pagar') }
export async function getCuotasPagarByCxP(cxpId) { return await query('cuotas_pagar', { cxp_id: cxpId }) }
export async function getCuotaPagarById(id) { return await getById('cuotas_pagar', id) }
export async function addCuotaPagar(c) { return await insert('cuotas_pagar', c) }
export async function updateCuotaPagar(id, data) { return await update('cuotas_pagar', id, data) }
export async function deleteCuotaPagar(id) { return await deleteRecord('cuotas_pagar', id) }

// ── Letras de cambio ──
export async function getLetrasCambio() { return await getAll('letras_cambio') }
export async function getLetraCambioById(id) { return await getById('letras_cambio', id) }
export async function addLetraCambio(l) { return await insert('letras_cambio', l) }
export async function updateLetraCambio(id, data) { return await update('letras_cambio', id, data) }
export async function deleteLetraCambio(id) { return await deleteRecord('letras_cambio', id) }

/** Antigüedad por cuota — lee la vista SQL, no recalcula en el navegador. */
export async function getAntiguedadCxC() {
  const { data, error } = await supabase.from('v_antiguedad_cxc').select('*')
  if (error) { console.error('getAntiguedadCxC:', error); return [] }
  return data || []
}
