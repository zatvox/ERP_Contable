// ============================================================================
// VENTAS.JS — Módulo Ventas: Cotizaciones + Facturación Electrónica (NUBEFACT)
// ============================================================================

import { getCurrentUser } from './auth-supabase.js'
import {
  getSalesQuotes, getSalesQuoteById, addSalesQuote, updateSalesQuote,
  getCustomers, getContactById, addContact, updateContact, deleteContact, tiposDeContacto, getContactsByType,
  getLotes, getLoteById, updateLote, addLote,
  getItems, getItemById, addItem,
  getCategorias, addCategoria,
  addVenta, getVentas, getVentaById, updateVenta, deleteVenta,
  addDetalleVenta, getDetalleVentas, updateDetalleVenta, deleteDetalleVenta,
  addCuentaCobrar, getCuentasCobrarByVenta, updateCuentaCobrar, deleteCuentaCobrar,
  addCuotaCobrar, getCuotasCobrarByCxC, deleteCuotaCobrar, getCuentasCobrar,
  getCobrosByCxC, deleteCobro, reversarAsiento, ultimoErrorDelete,
  generarAsientoVenta, generarNumeroVenta,
  getAccounts,
  aplicarModelo, crearAsientoContable,
  getTipoDocumentosMap, asegurarPeriodoAbierto,
  getAlmacenes, getUbicaciones,
  getStockUbicaciones, getStockUbicacionesByLote, addStockUbicacion, updateStockUbicacion, deleteStockUbicacion,
  getUbicacionCustomers, addKardexMovimiento, getKardexByVenta, deleteKardexMovimiento,
  getGuiasDespachoVenta, getGuiaDespachoVentaById, addGuiaDespachoVenta, updateGuiaDespachoVenta, deleteGuiaDespachoVenta,
  getDetalleGuiasDespachoVenta, getDetalleGuiasDespachoVentaByVenta, addDetalleGuiaDespachoVenta, deleteDetalleGuiaDespachoVenta,
  invalidateGuiasDespachoVentaCache
} from './supabase-data.js'
import { emitirCPE, attachRucAutocomplete, getTCVenta } from './sunat-api.js'
import { showToast, formatNumber, formatQty } from './helpers.js'
import { initModuleNavDropdowns, initSubtabs, menuAccionesFila } from './main.js'
import { abrirModalAnulacion, camposAnulacion, estaAnulado, badgeAnulado, ESTILO_FILA_ANULADA } from './anulacion.js'
import { abrirModalNota, TIPO_NC, TIPO_ND, esNota, signoDocumento, nombreTipoComprobante, badgeTipoDocumento } from './notas.js'
import { convertirEnBuscador, refrescarBuscador } from './buscador-select.js'
import { renderEditorCronograma, actualizarCronograma, leerCronograma, getTerminosConCuotas, cargarCuotasExistentes, generarCronograma, cronogramaDesdeTexto } from './cronograma.js'
import { cacheado } from './data-cache.js'
import { crearReporte, nombreMes } from './reportes.js'
import { getModuloConfig, renderConfiguracionTab, aplicarPreferenciasVista } from './config-modulo.js'

// ============================================================================
// ESTADO LOCAL
// ============================================================================

let _clientes  = []
let _items     = []
let _lotes     = []
let _vendedores = []    // contacts con tipo_contacto incluye 'vendedor'
let _ventaLineas = []   // líneas del modal de nueva venta
let _almacenes = []
let _zonas     = []     // ubicaciones (con almacen_id)
let _stockUbic = []     // stock_ubicaciones: cuánto de cada lote hay en cada zona
let _lotesMap  = {}     // lote.id -> lote (para resolver item_id/fecha_ingreso rápido)

// ============================================================================
// INIT
// ============================================================================

document.addEventListener('DOMContentLoaded', async () => {
  try {
    const user = await getCurrentUser()
    const userDisplay = document.getElementById('userDisplay')
    if (userDisplay && user) userDisplay.textContent = user.nombre || user.email

    aplicarPreferenciasVista('ventas')
    initTabsVentas()
    await getTipoDocumentosMap()

    // Pre-carga en paralelo
    const [clientes, items, lotes, vendedores, almacenes, zonas, stockUbic] = await Promise.all([
      getCustomers(), getItems(), getLotes(), getContactsByType('vendedor'),
      getAlmacenes(), getUbicaciones(), getStockUbicaciones()
    ])
    _clientes = clientes
    _items    = items
    _lotes    = lotes
    _vendedores = vendedores
    _almacenes  = almacenes
    _zonas      = zonas
    _stockUbic  = stockUbic
    _lotesMap   = {}
    for (const lo of (_lotes || [])) _lotesMap[lo.id] = lo

    _poblarSelectClientes()
    _poblarSelectItems()
    _poblarSelectLotes()
    _poblarSelectVendedores()
    _poblarSelectZonasVenta()

    // Selects largos (cientos de opciones) convertidos en buscadores con
    // filtrado en vivo. El <select> original sigue existiendo oculto, así que
    // todo el código que lee .value o escucha 'change' funciona igual.
    convertirEnBuscador('ventaContactId', {
      placeholder: 'Escribe el nombre o RUC del cliente...',
      sinResultados: 'Ningún cliente coincide',
      alCrearNuevo: { label: 'Registrar cliente nuevo', onClick: () => window.abrirFormularioCliente?.() }
    })
    convertirEnBuscador('ventaItemSelect', { placeholder: 'Escribe el producto o SKU...', sinResultados: 'Sin productos con stock' })
    convertirEnBuscador('ventaVendedor', { placeholder: 'Sin asignar — escribe para buscar...', sinResultados: 'Sin vendedores' })
    convertirEnBuscador('cotCliente', { placeholder: 'Escribe el nombre del cliente...' })
    convertirEnBuscador('gdVenta', { placeholder: 'Escribe el N° de venta o cliente...', sinResultados: 'Sin ventas pendientes de despacho' })

    // Cotizaciones en standby: no se precarga (tab oculto en el HTML)
    await Promise.all([renderVentas(), renderClientes()])

    // Fecha de hoy en formulario venta
    const hoy = new Date().toISOString().split('T')[0]
    const fVenta = document.getElementById('ventaFechaEmision')
    if (fVenta) fVenta.value = hoy

    // RUC autocomplete en modal de nueva venta
    attachRucAutocomplete('ventaClienteRUC', 'ventaClienteNombre', 'ventaClienteDireccion', 'ventaClienteEstado')

    // TC automático (SBS/APIs.pe) DESACTIVADO temporalmente: el endpoint no
    // responde en este entorno (ERR_SSL_PROTOCOL_ERROR). El campo de tipo de
    // cambio queda 100% editable a mano y no se auto-consulta en cada cambio
    // de moneda/fecha. Se reactivará cuando se integre la API propia del
    // usuario. El botón "↻ Auto" (autoFetchTCVenta) sigue disponible por si
    // se quiere probar manualmente.
    // const selMoneda  = document.getElementById('ventaMoneda')
    // const inputFecha = document.getElementById('ventaFechaEmision')
    // if (selMoneda) selMoneda.addEventListener('change', () => _actualizarTCVenta())
    // if (inputFecha) inputFecha.addEventListener('change', () => _actualizarTCVenta())
  } catch (error) {
    console.error('DOMContentLoaded ventas:', error)
    showToast('Error al cargar el módulo de ventas', 'danger')
  }
})

// ─── Tipo de Cambio automático ────────────────────────────────────────────────

/**
 * Consulta el TC VENTA SBS para la fecha del formulario y lo llena.
 * Se omite si la moneda es PEN (TC = 1).
 */
async function _actualizarTCVenta() {
  const moneda = document.getElementById('ventaMoneda')?.value
  const campo  = document.getElementById('ventaTipoCambio')
  const aviso  = document.getElementById('ventaTCAviso')
  const badge  = document.getElementById('ventaTCTipo')
  if (!campo) return

  if (moneda !== 'USD') {
    campo.value = '1.000'
    if (aviso) aviso.textContent = ''
    if (badge) { badge.textContent = '—'; badge.style.color = 'var(--color-muted)' }
    return
  }

  const fecha = document.getElementById('ventaFechaEmision')?.value || null
  if (aviso) aviso.textContent = 'Consultando SBS...'

  const result = await getTCVenta(fecha)
  if (result.error) {
    if (aviso) aviso.textContent = `⚠️ ${result.error} — ingresa TC manualmente`
    showToast('No se pudo obtener el TC de SUNAT. Ingresa el tipo de cambio manualmente.', 'warning')
    return
  }

  campo.value = result.tc.toFixed(3)
  if (badge) { badge.textContent = 'VENTA SBS'; badge.style.color = 'var(--color-info)' }
  if (aviso) aviso.textContent = `TC Venta SBS ${result.fecha}: S/. ${result.tc.toFixed(3)} — Art. 61° LIR`
}

/** Botón "↻ Auto" en el formulario de venta */
window.autoFetchTCVenta = async function () {
  const btn = document.getElementById('btnAutoTC')
  if (btn) btn.disabled = true
  await _actualizarTCVenta()
  if (btn) btn.disabled = false
}

// ─────────────────────────────────────────────────────────────────────────────

function initTabsVentas() {
  const btns     = document.querySelectorAll('#ventasTabs .tab-btn')
  const contents = document.querySelectorAll('.tab-content')
  btns.forEach(btn => {
    btn.addEventListener('click', async () => {
      const tab = btn.getAttribute('data-tab')
      btns.forEach(b => b.classList.remove('active'))
      contents.forEach(c => c.classList.remove('active'))
      btn.classList.add('active')
      const tabContent = document.getElementById(`tab-${tab}`)
      if (tabContent) tabContent.classList.add('active')

      if (tab === 'ventas')       await renderVentas()
      if (tab === 'guias-despacho') await renderGuiasDespachoVenta()
      if (tab === 'cotizaciones') await renderCotizaciones()
      if (tab === 'clientes')     await renderClientes()
      if (tab === 'configuracion') renderConfiguracionTab('ventas', 'tab-configuracion')
      if (tab === 'reportes') {
        const activo = document.querySelector('#ven-subtabs-reportes .subtab.active')?.getAttribute('data-sub') || 'repv-evolucion'
        await construirReporteVentas(activo)
      }
    })
  })

  initSubtabs('#ven-subtabs-reportes', (panel) => construirReporteVentas(panel))

  // Convierte la fila de tabs (agrupada en dropdowns dentro del header) en un
  // submenú desplegable estilo Odoo. No reemplaza el listener de arriba, solo
  // agrega abrir/cerrar y resaltar el grupo activo.
  initModuleNavDropdowns('#ventasTabs')
}

// ============================================================================
// HELPERS
// ============================================================================

function _poblarSelectClientes() {
  const sel = document.getElementById('cotCliente')
  const selV = document.getElementById('ventaContactId')
  const opts = '<option value="">-- Selecciona Cliente --</option>' +
    _clientes.map(c => `<option value="${c.id}">${c.razon_social || c.nombre || c.name || c.email}</option>`).join('')
  if (sel) sel.innerHTML = opts
  if (selV) selV.innerHTML = opts
  // Los selects ya convertidos en buscador deben re-sincronizar su input
  // cuando se repuebla la lista (ej. tras crear un cliente nuevo).
  refrescarBuscador('cotCliente')
  refrescarBuscador('ventaContactId')
}

// Suma de stock (kg) de un ítem en TODAS las zonas reales (vía
// stock_ubicaciones). Se usa para que el selector de producto de Nueva
// Venta solo muestre lo que efectivamente tiene stock — no toda la lista
// de ítems del catálogo.
function _stockTotalItem(itemId) {
  return (_stockUbic || [])
    .filter(su => _lotesMap[su.lote_id]?.item_id === itemId)
    .reduce((s, su) => s + (parseFloat(su.cantidad) || 0), 0)
}

// Tasa fija del Régimen de Retenciones del IGV (SUNAT) — mismo valor que
// cobranzas.js usa al aplicar la retención en el cobro. Acá es solo
// informativo: la venta se emite por el 100%, la retención real se
// descuenta recién al cobrar.
const RETENCION_IGV_PCT = 0.03

/** Aviso informativo (no bloquea nada) si el cliente elegido es agente de retención IGV. */
window.onCambiarClienteVenta = function () {
  _actualizarAvisoRetencionVenta()
  _avisarCreditoCliente()
  // El término del cliente es solo una sugerencia: se recarga el selector,
  // pero si el usuario ya personalizó el cronograma no se le pisa.
  const crono = leerCronograma('venta-cronograma')
  if (_cronogramaVentaListo && !crono?.personalizado) _prepararCronogramaVenta(true)
}

function _actualizarAvisoRetencionVenta() {
  const aviso = document.getElementById('ventaClienteRetencionAviso')
  if (!aviso) return
  const contactId = parseInt(document.getElementById('ventaContactId')?.value || 0)
  const cliente = _clientes.find(c => c.id === contactId)
  if (!contactId || !cliente?.sujeto_retencion) {
    aviso.style.display = 'none'
    return
  }
  const total = parseFloat(document.getElementById('ventaTotalFinal')?.textContent?.replace(/,/g, '') || 0)
  const retencionEstim = parseFloat((total * RETENCION_IGV_PCT).toFixed(2))
  aviso.style.display = 'block'
  aviso.textContent = total > 0
    ? `⚠ Cliente sujeto a retención IGV (${(RETENCION_IGV_PCT * 100).toFixed(0)}%): al cobrar se retendrá aprox. S/ ${retencionEstim.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}. La factura se emite igual por el total.`
    : `⚠ Cliente sujeto a retención IGV (${(RETENCION_IGV_PCT * 100).toFixed(0)}%): se aplicará al cobrar.`
}

function _poblarSelectItems() {
  const sel = document.getElementById('ventaItemSelect')
  if (!sel) return
  const itemsConStock = (_items || []).filter(i => _stockTotalItem(i.id) > 0)
  sel.innerHTML = '<option value="">-- Selecciona producto --</option>' +
    // data-costo se eliminó: items.costo_promedio nunca se actualiza (queda
    // en 0 siempre) — el costo real ahora se toma del lote elegido.
    itemsConStock.map(i => `<option value="${i.id}" data-precio="${i.precio_venta || 0}">${i.nombre || i.name} (${i.codigo || i.sku || ''})</option>`).join('')
  refrescarBuscador('ventaItemSelect')
}

function _poblarSelectLotes() {
  const sel = document.getElementById('cotLote')
  if (!sel) return
  sel.innerHTML = '<option value="">-- Selecciona Lote --</option>' +
    _lotes.map(l => `<option value="${l.id}">${l.numero_lote} (Stock: ${l.cantidad || l.stock || 0})</option>`).join('')
}

function _poblarSelectVendedores() {
  const opts = '<option value="">-- Sin asignar --</option>' +
    _vendedores.map(v => `<option value="${v.id}">${v.nombre}</option>`).join('')
  const selNueva = document.getElementById('ventaVendedor')
  const selEditar = document.getElementById('evVendedor')
  if (selNueva) selNueva.innerHTML = opts
  if (selEditar) selEditar.innerHTML = opts
}

async function _nombreCliente(contactId) {
  if (!contactId) return '-'
  const local = _clientes.find(c => c.id === contactId)
  if (local) return local.razon_social || local.nombre || local.name || `ID ${contactId}`
  try {
    const c = await getContactById(contactId)
    return c?.razon_social || c?.nombre || c?.name || `ID ${contactId}`
  } catch { return `ID ${contactId}` }
}

function _nombreVendedor(vendedorId) {
  if (!vendedorId) return '-'
  const v = _vendedores.find(x => x.id === vendedorId)
  return v?.nombre || `ID ${vendedorId}`
}

// ─── Ventas por Zona (Etapa 3 de Almacenes) ──────────────────────────────────
// El stock real por zona vive en stock_ubicaciones (lote_id + ubicacion_id).
// Estos helpers permiten elegir de qué zona sale cada línea vendida y
// validar que esa zona tenga stock suficiente ANTES de agregar la línea,
// en vez de descubrirlo recién al guardar.

// Se mantiene por si algo más la usa, pero el selector de zona de la línea
// de venta ahora se puebla en vivo según el producto elegido (ver
// _poblarZonaSelectParaItem) — sin producto, no tiene sentido listar zonas.
function _poblarSelectZonasVenta() {
  const sel = document.getElementById('ventaLineaZona')
  if (!sel) return
  sel.innerHTML = '<option value="">-- Elige un producto --</option>'
  sel.disabled = true
}

/** Zonas reales (no virtuales) donde el ítem tiene stock > 0. */
function _poblarZonaSelectParaItem(itemId) {
  const sel = document.getElementById('ventaLineaZona')
  if (!sel) return
  if (!itemId) {
    sel.innerHTML = '<option value="">-- Elige un producto --</option>'
    sel.disabled = true
    return
  }
  const almacenesMap = {}
  for (const a of (_almacenes || [])) almacenesMap[a.id] = a
  // Las zonas virtuales (Partners/Vendors, Partners/Customers) son solo
  // para el Kardex — nunca una zona real de la que se pueda vender stock.
  const zonaIds = new Set(
    (_stockUbic || [])
      .filter(su => _lotesMap[su.lote_id]?.item_id === itemId && (parseFloat(su.cantidad) || 0) > 0)
      .map(su => su.ubicacion_id)
  )
  const zonasConStock = (_zonas || []).filter(z => zonaIds.has(z.id) && !almacenesMap[z.almacen_id]?.es_virtual)
  if (zonasConStock.length === 0) {
    sel.innerHTML = '<option value="">-- Sin stock en ninguna zona --</option>'
    sel.disabled = true
    return
  }
  sel.disabled = false
  sel.innerHTML = '<option value="">-- Selecciona --</option>' +
    zonasConStock.map(z => `<option value="${z.id}">${almacenesMap[z.almacen_id]?.nombre || '?'} — ${z.nombre}</option>`).join('')
}

/** Lotes con stock > 0 del ítem en la zona elegida (cada uno con su fila exacta de stock_ubicaciones). */
function _poblarLoteSelectParaZona(itemId, zonaId) {
  const sel = document.getElementById('ventaLineaLote')
  if (!sel) return
  if (!itemId || !zonaId) {
    sel.innerHTML = '<option value="">-- Elige zona --</option>'
    sel.disabled = true
    return
  }
  const filas = (_stockUbic || [])
    .filter(su => su.ubicacion_id === zonaId && _lotesMap[su.lote_id]?.item_id === itemId && (parseFloat(su.cantidad) || 0) > 0)
    .sort((a, b) => new Date(_lotesMap[a.lote_id]?.fecha_ingreso || 0) - new Date(_lotesMap[b.lote_id]?.fecha_ingreso || 0))
  if (filas.length === 0) {
    sel.innerHTML = '<option value="">-- Sin lotes con stock --</option>'
    sel.disabled = true
    return
  }
  sel.disabled = false
  sel.innerHTML = '<option value="">-- Selecciona lote (FIFO sugerido primero) --</option>' +
    filas.map(su => {
      const lote = _lotesMap[su.lote_id]
      const disp = parseFloat(su.cantidad) || 0
      const dispUnid = parseFloat(su.cantidad_unidades) || 0
      return `<option value="${su.id}">${lote?.numero_lote || '?'} — disp: ${formatQty(disp)} kg${dispUnid > 0 ? ' / ' + formatQty(dispUnid) + ' und' : ''}${lote?.es_peso_variable ? ' (peso variable)' : ''}</option>`
    }).join('')
}

/** La fila de stock_ubicaciones del lote elegido actualmente en el formulario. */
function _stockUbicSeleccionada() {
  const suId = parseInt(document.getElementById('ventaLineaLote')?.value || 0)
  if (!suId) return null
  return (_stockUbic || []).find(su => su.id === suId) || null
}

// Sugiere N° de Unidades a partir del peso_por_unidad del lote elegido (el
// campo queda editable: es solo una sugerencia inicial). También refresca
// el campo de solo-lectura "Peso x Unid." con el valor del lote.
function _sugerirUnidadesLineaVenta() {
  const inpUnid = document.getElementById('ventaLineaCantUnidades')
  const inpPeso = document.getElementById('ventaLineaPesoUnidad')
  const su = _stockUbicSeleccionada()
  const lote = su ? _lotesMap[su.lote_id] : null

  if (inpPeso) inpPeso.value = (lote?.peso_por_unidad && lote.peso_por_unidad > 0) ? formatQty(lote.peso_por_unidad) : ''

  if (!inpUnid) return
  if (!su) { inpUnid.value = ''; inpUnid.placeholder = '—'; return }
  const cantidad = parseFloat(document.getElementById('ventaLineaCantidad')?.value || 0)
  if (lote?.peso_por_unidad && lote.peso_por_unidad > 0) {
    inpUnid.value = parseFloat((cantidad / lote.peso_por_unidad).toFixed(2))
    inpUnid.placeholder = lote.es_peso_variable ? 'Aproximado (peso variable) — ajusta si hace falta' : ''
  } else {
    inpUnid.value = ''
    inpUnid.placeholder = 'Este lote no trackea unidades'
  }
}

function _nombreZona(ubicacionId) {
  if (!ubicacionId) return '-'
  const z = (_zonas || []).find(x => x.id === ubicacionId)
  if (!z) return `Zona #${ubicacionId}`
  const a = (_almacenes || []).find(x => x.id === z.almacen_id)
  return `${a?.nombre || '?'} — ${z.nombre}`
}

/** Muestra el stock disponible (kg y unidades) del lote+zona elegidos, en vivo. */
function _actualizarAvisoStockLineaVenta() {
  const aviso = document.getElementById('ventaLineaStockAviso')
  if (!aviso) return
  const itemId = parseInt(document.getElementById('ventaItemSelect')?.value || 0)
  const zonaId = parseInt(document.getElementById('ventaLineaZona')?.value || 0)
  const su = _stockUbicSeleccionada()
  const cantidad = parseFloat(document.getElementById('ventaLineaCantidad')?.value || 0)

  if (!itemId) { aviso.textContent = 'Selecciona un producto para ver sus zonas y lotes con stock.'; aviso.style.color = 'var(--text-secondary)'; return }
  if (!zonaId) { aviso.textContent = 'Selecciona la zona de la que sale el stock.'; aviso.style.color = 'var(--color-warning)'; return }
  if (!su)     { aviso.textContent = 'Selecciona el lote del que sale el stock.'; aviso.style.color = 'var(--color-warning)'; return }

  const disp = parseFloat(su.cantidad) || 0
  const dispUnid = parseFloat(su.cantidad_unidades) || 0
  const insuficiente = cantidad > 0 && cantidad > disp
  aviso.textContent = `Stock disponible en este lote/zona: ${formatQty(disp)} kg` +
    (dispUnid > 0 ? ` / ${formatQty(dispUnid)} und` : '') +
    (insuficiente ? ' — INSUFICIENTE para la cantidad pedida' : '')
  aviso.style.color = insuficiente ? 'var(--color-danger)' : 'var(--color-success)'
}

/** Al elegir un producto: repuebla zonas (solo con stock), resetea lote/unidad/precio. */
window.onCambiarItemLineaVenta = function () {
  const sel = document.getElementById('ventaItemSelect')
  const opt = sel?.selectedOptions[0]
  const itemId = parseInt(sel?.value || 0)
  const item = _items.find(i => i.id === itemId)
  const inpUnidad = document.getElementById('ventaLineaUnidad')
  const inpPrecio = document.getElementById('ventaLineaPrecio')
  if (inpUnidad) inpUnidad.value = item?.unidad_medida || ''
  if (inpPrecio) inpPrecio.value = opt?.getAttribute('data-precio') || ''
  _poblarZonaSelectParaItem(itemId)
  _poblarLoteSelectParaZona(null, null)
  _sugerirUnidadesLineaVenta()
  _actualizarAvisoStockLineaVenta()
}

/** Al elegir zona: repuebla lotes con stock de ese ítem en esa zona. */
window.onCambiarZonaLineaVenta = function () {
  const itemId = parseInt(document.getElementById('ventaItemSelect')?.value || 0)
  const zonaId = parseInt(document.getElementById('ventaLineaZona')?.value || 0)
  _poblarLoteSelectParaZona(itemId, zonaId)
  _sugerirUnidadesLineaVenta()
  _actualizarAvisoStockLineaVenta()
}

/** Al elegir lote: sugiere unidades según su peso_por_unidad, muestra el peso x unidad y refresca el aviso de stock. */
window.onCambiarLoteLineaVenta = function () {
  _sugerirUnidadesLineaVenta()
  _actualizarAvisoStockLineaVenta()
}

/** Al cambiar la cantidad (kg): recalcula la sugerencia de unidades y el aviso de stock. */
window.onCambiarCantidadLineaVenta = function () {
  _sugerirUnidadesLineaVenta()
  _actualizarAvisoStockLineaVenta()
}

// ============================================================================
// TAB: VENTAS (Facturas / Boletas + NUBEFACT CPE)
// ============================================================================

let _ventasListaEnriquecida = null // cache: [{v, cliente, vendedor}]
let _ventasSort = { col: null, dir: 'asc' } // orden por columna (click en header), mismo patrón que compras.js

// Comparador genérico: números se comparan numéricamente, todo lo demás
// como texto (localeCompare 'es' con soporte numérico para que "2" < "10").
function _compararValoresOrdenVentas(a, b) {
  if (a == null && b == null) return 0
  if (a == null) return -1
  if (b == null) return 1
  if (typeof a === 'number' && typeof b === 'number') return a - b
  return String(a).localeCompare(String(b), 'es', { numeric: true, sensitivity: 'base' })
}

function _flechaOrdenVentas(campo) {
  if (_ventasSort.col !== campo) return ''
  return _ventasSort.dir === 'asc' ? ' ▲' : ' ▼'
}

function _thOrdenableVentas(label, campo) {
  return `<th style="cursor:pointer; user-select:none;" onclick="window.ordenarVentas('${campo}')" title="Ordenar por ${label}">${label}${_flechaOrdenVentas(campo)}</th>`
}

function _valorOrdenVenta({ v, cliente, vendedor }, campo) {
  switch (campo) {
    case 'comprobante': return `${v.serie || ''}-${String(v.correlativo || '').padStart(8, '0')}`
    case 'tipo':         return v.tipo_comprobante || ''
    case 'cliente':      return cliente || ''
    case 'vendedor':     return vendedor || ''
    case 'fecha':        return v.fecha_emision || ''
    case 'moneda':       return v.moneda || ''
    case 'base':         return parseFloat(v.base_imponible) || 0
    case 'igv':          return parseFloat(v.igv) || 0
    case 'total':        return parseFloat(v.total) || 0
    case 'cpe':          return v.cpe_estado || ''
    default: return ''
  }
}

window.ordenarVentas = function (campo) {
  if (_ventasSort.col === campo) {
    _ventasSort.dir = _ventasSort.dir === 'asc' ? 'desc' : 'asc'
  } else {
    _ventasSort.col = campo
    _ventasSort.dir = 'asc'
  }
  _pintarFilasVentas()
}

// El shell (header + input de búsqueda) se crea UNA sola vez; filtrar solo
// reescribe el <tbody> de #tabla-ventas-body, para no destruir el <input>
// en cada tecla (perdía el foco/cursor si se regeneraba todo el bloque).
async function renderVentas(forzar = false) {
  try {
    const container = document.getElementById('content-ventas')
    if (!container) return

    if (!_ventasListaEnriquecida || forzar) {
      const ventas = await getVentas()
      const ventasOrdenadas = (ventas || []).sort((a, b) => b.id - a.id)
      _ventasListaEnriquecida = []
      for (const v of ventasOrdenadas) {
        const cliente = await _nombreCliente(v.contact_id)
        const vendedor = _nombreVendedor(v.vendedor_id)
        _ventasListaEnriquecida.push({ v, cliente, vendedor })
      }
    }

    if (!document.getElementById('buscarVenta')) {
      container.innerHTML = `
        <div class="card-header">
          <h3 class="card-title">Comprobantes de Venta</h3>
          <div style="display:flex; gap:8px;">
            <button id="btnEliminarVentasSeleccionadas" class="btn btn-danger btn-small" style="display:none;" onclick="window.eliminarVentasSeleccionadas()">🗑 Eliminar seleccionadas (0)</button>
            <button class="btn btn-secondary btn-small" onclick="window.abrirModalImportarVentas()">📥 Importar</button>
            <button class="btn btn-primary btn-small" onclick="window.abrirModalNuevaVenta()">+ Nueva Venta</button>
          </div>
        </div>
        <div style="padding:12px 16px; border-bottom:1px solid var(--border-color, #e0e0e0); display:flex; gap:12px; flex-wrap:wrap; align-items:center;">
          <input type="text" id="buscarVenta" placeholder="Buscar por comprobante, cliente, vendedor, moneda o tipo..." style="flex:1; min-width:260px; max-width:420px;" oninput="window.filtrarVentas()">
          <select id="filtroAnuladasVentas" onchange="window.filtrarVentas()" style="max-width:210px;" title="Los comprobantes anulados se conservan pero no suman en reportes">
            <option value="activos" selected>Solo vigentes</option>
            <option value="todos">Vigentes y anulados</option>
            <option value="anulados">Solo anulados</option>
          </select>
        </div>
        <div class="table-container">
          <table>
            <thead>
              <tr>
                <th style="width:32px;"><input type="checkbox" id="selAllVentas" onchange="window.toggleSeleccionTodasVentas(this.checked)" title="Seleccionar todas"></th>
                ${_thOrdenableVentas('N° Comprobante', 'comprobante')}
                ${_thOrdenableVentas('Tipo', 'tipo')}
                ${_thOrdenableVentas('Cliente', 'cliente')}
                ${_thOrdenableVentas('Vendedor', 'vendedor')}
                ${_thOrdenableVentas('Fecha', 'fecha')}
                ${_thOrdenableVentas('Moneda', 'moneda')}
                ${_thOrdenableVentas('Base Imp.', 'base')}
                ${_thOrdenableVentas('IGV', 'igv')}
                ${_thOrdenableVentas('Total', 'total')}
                ${_thOrdenableVentas('CPE', 'cpe')}
                <th>Acciones</th>
              </tr>
            </thead>
            <tbody id="tabla-ventas-body"></tbody>
          </table>
        </div>
      `
    }

    _pintarFilasVentas()
  } catch (error) {
    console.error('renderVentas:', error)
    showToast('Error al cargar ventas', 'danger')
  }
}

function _pintarFilasVentas() {
  const tbody = document.getElementById('tabla-ventas-body')
  if (!tbody) return

  const statusBadge = (v) => {
    // El estado de anulación manda sobre el estado CPE: una factura anulada
    // no debe verse como "CPE OK" aunque haya sido aceptada en su momento.
    if (estaAnulado(v)) return badgeAnulado(v)
    const cpe = v.cpe_estado
    if (cpe === 'aceptado')  return '<span class="badge badge-success">CPE OK</span>'
    if (cpe === 'rechazado') return '<span class="badge badge-danger">CPE Error</span>'
    if (cpe === 'enviando')  return '<span class="badge badge-info">Enviando</span>'
    if (cpe === 'baja')      return '<span class="badge badge-secondary">Baja</span>'
    return '<span class="badge badge-secondary">Sin enviar</span>'
  }

  const busqueda = (document.getElementById('buscarVenta')?.value || '').trim().toLowerCase()
  const modoAnul = document.getElementById('filtroAnuladasVentas')?.value || 'activos'

  let listaFiltrada = (_ventasListaEnriquecida || []).filter(({ v }) => {
    const anul = estaAnulado(v)
    if (modoAnul === 'activos')  return !anul
    if (modoAnul === 'anulados') return anul
    return true
  })

  if (busqueda) {
    listaFiltrada = listaFiltrada.filter(({ v, cliente, vendedor }) => {
      const comprobante = `${v.serie || ''}-${String(v.correlativo || '').padStart(8, '0')}`
      return `${comprobante} ${cliente || ''} ${vendedor || ''} ${v.moneda || ''} ${v.tipo_comprobante || ''}`
        .toLowerCase().includes(busqueda)
    })
  }

  if (_ventasSort.col) {
    listaFiltrada.sort((a, b) => {
      const cmp = _compararValoresOrdenVentas(_valorOrdenVenta(a, _ventasSort.col), _valorOrdenVenta(b, _ventasSort.col))
      return _ventasSort.dir === 'asc' ? cmp : -cmp
    })
  }

  if (listaFiltrada.length === 0) {
    tbody.innerHTML = `<tr><td colspan="12" style="text-align:center;">${busqueda ? 'Sin resultados para la búsqueda' : (modoAnul === 'anulados' ? 'No hay comprobantes anulados' : 'Sin ventas registradas')}</td></tr>`
    return
  }

  let html = ''
  for (const { v, cliente, vendedor } of listaFiltrada) {
    // Las notas de crédito se muestran en negativo (y en rojo) para que la
    // columna Total se pueda leer como una suma: es lo que espera el contador.
    const signo = signoDocumento(v.tipo_comprobante)
    const bi  = parseFloat(v.base_imponible || 0) * signo
    const igv = parseFloat(v.igv || 0) * signo
    const tot = parseFloat(v.total || 0) * signo
    const estiloMonto = signo < 0 ? ' color:var(--color-danger);' : ''
    const aceptado = v.cpe_estado === 'aceptado'
    const anulada  = estaAnulado(v)

    html += `<tr${anulada ? ` style="${ESTILO_FILA_ANULADA}"` : ''}>
      <td>${aceptado || anulada
        ? `<input type="checkbox" disabled title="${anulada ? 'Comprobante anulado' : 'No se puede eliminar: CPE aceptado por SUNAT'}">`
        : `<input type="checkbox" class="venta-sel" value="${v.id}" onchange="window.actualizarBotonEliminarVentasSeleccionadas()">`}</td>
      <td><strong>${v.serie || ''}-${String(v.correlativo || '').padStart(8,'0')}</strong></td>
      <td>${badgeTipoDocumento(v.tipo_comprobante)}${v.venta_referencia_id ? `<br><small style="color:var(--text-secondary);">ref. ${v.doc_referencia_serie || ''}-${String(v.doc_referencia_numero || '').padStart(8,'0')}</small>` : ''}</td>
      <td>${cliente}</td>
      <td>${vendedor}</td>
      <td>${v.fecha_emision || '-'}</td>
      <td>${v.moneda || 'PEN'}</td>
      <td style="text-align:right;${estiloMonto}">${formatNumber(bi)}</td>
      <td style="text-align:right;${estiloMonto}">${formatNumber(igv)}</td>
      <td style="text-align:right; font-weight:bold;${estiloMonto}">${formatNumber(tot)}</td>
      <td>${statusBadge(v)}</td>
      <td class="col-acciones" style="text-decoration:none; opacity:1;">
        ${menuAccionesFila(anulada
          ? [
              { label: 'Ver motivo de anulación', icono: 'ℹ️', onclick: `window.verMotivoAnulacion('venta', ${v.id})` }
            ]
          : [
              (!v.cpe_estado || v.cpe_estado === 'no_enviado') && { label: 'Emitir CPE', icono: '📤', onclick: `window.emitirCPEVenta(${v.id})` },
              v.nubefact_enlace && { label: 'Ver PDF', icono: '📄', href: v.nubefact_enlace },
              !v.asiento_id && { label: 'Generar asiento', icono: '📑', onclick: `window.generarAsientoDeVenta(${v.id})` },
              { label: 'Editar', icono: '✏️', onclick: `window.editarVenta(${v.id})` },
              { separador: true },
              { label: 'Nota de Crédito', icono: '↩️', onclick: `window.abrirModalNotaCredito(${v.id})` },
              { label: 'Nota de Débito', icono: '↪️', onclick: `window.abrirModalNotaDebito(${v.id})` },
              { separador: true },
              { label: 'Anular comprobante', icono: '🚫', onclick: `window.anularVenta(${v.id})`, peligro: true },
              { label: 'Eliminar', icono: '🗑️', onclick: `window.eliminarVenta(${v.id})`, peligro: true }
            ])}
      </td>
    </tr>`
  }
  tbody.innerHTML = html
}

window.filtrarVentas = function () {
  _pintarFilasVentas()
}

// ─── Editar Venta (solo cabecera: no se tocan líneas/stock ya descontado) ────

// ============================================================================
// EDITAR VENTA — con propagación en cascada a los documentos vinculados
// ============================================================================
// Una venta no vive sola: de ella cuelgan la Cuenta por Cobrar, sus cuotas,
// las guías de despacho y el asiento contable. Antes este modal solo tocaba
// tres campos de `ventas` y NADA se propagaba: si corregías el cliente, la
// CxC seguía apuntando al cliente viejo y Cobranzas mostraba la deuda a la
// persona equivocada.
//
// Ahora se edita en un solo lugar y los cambios bajan a los vinculados, pero
// respetando dos límites que no son negociables:
//   * Lo que ya movió dinero no se toca (cuotas con cobros, retenciones).
//   * Los importes NUNCA se editan: un comprobante emitido se corrige con
//     Nota de Crédito o Débito, no reescribiendo el total.

let _evContexto = null   // { venta, cxc, cuotas, guias, bloqueos }

window.editarVenta = async function (id) {
  try {
    const v = await getVentaById(id)
    if (!v) { showToast('No se encontró la venta', 'danger'); return }

    if (estaAnulado(v)) {
      showToast('Este comprobante está anulado: no se puede editar', 'warning')
      return
    }

    // ── Contexto: todo lo que cuelga de esta venta ──────────────────────
    const [cxcs, guiasTodas, todasVentas] = await Promise.all([
      getCuentasCobrarByVenta(id), getGuiasDespachoVenta(true), getVentas()
    ])
    const cxc = (cxcs || [])[0] || null
    const cuotas = cxc ? await getCuotasCobrarByCxC(cxc.id) : []
    const guias = (guiasTodas || []).filter(g => g.venta_id === id && g.estado !== 'anulada')
    const notas = (todasVentas || []).filter(x => x.venta_referencia_id === id && !estaAnulado(x))

    // Lo aplicado incluye retenciones y canjes: todos son dinero o deuda ya
    // comprometida, aunque no haya entrado efectivo.
    const aplicado = cxc
      ? parseFloat(cxc.monto_cobrado || 0) + parseFloat(cxc.monto_retenido || 0) + parseFloat(cxc.monto_canjeado || 0)
      : 0

    const bloqueos = {
      cliente:    aplicado > 0.01 || notas.length > 0,
      moneda:     aplicado > 0.01,
      cronograma: aplicado > 0.01,
      numeracion: v.cpe_estado === 'aceptado'
    }

    _evContexto = { venta: v, cxc, cuotas, guias, notas, aplicado, bloqueos }

    // ── Rellenar el formulario ──────────────────────────────────────────
    const numero = `${v.serie || ''}-${String(v.correlativo || '').padStart(8, '0')}`
    _setEv('ev-titulo', `Editar ${nombreTipoComprobante(v.tipo_comprobante)} ${numero}`)
    _valEv('evId', v.id)
    _valEv('evTipoComp', `${v.tipo_comprobante} — ${nombreTipoComprobante(v.tipo_comprobante)}`)
    _valEv('evSerie', v.serie || '')
    _valEv('evCorrelativo', String(v.correlativo || '').padStart(8, '0'))
    _valEv('evPeriodo', v.periodo_contable || (v.fecha_emision || '').slice(0, 7))
    _valEv('evFechaEmision', v.fecha_emision || '')
    _valEv('evMoneda', v.moneda || 'PEN')
    _valEv('evTipoCambio', parseFloat(v.tipo_cambio) || 1)
    _valEv('evDescripcion', v.descripcion || '')
    _valEv('evObservaciones', v.observaciones || '')

    _setEv('evBase', formatNumber(v.base_imponible))
    _setEv('evIgv', formatNumber(v.igv))
    _setEv('evTotal', `${v.moneda || 'PEN'} ${formatNumber(v.total)}`)
    _setEv('evEstadoPagoTexto', _etiquetaEstadoPago(cxc, aplicado))

    if (!_clientes || _clientes.length === 0) _clientes = await getCustomers()
    _poblarSelectClientes()
    const selCli = document.getElementById('evContactId')
    if (selCli) {
      selCli.innerHTML = '<option value="">-- Selecciona --</option>' +
        _clientes.map(c => `<option value="${c.id}">${_esc(c.razon_social || c.nombre || '')}</option>`).join('')
      selCli.value = v.contact_id || ''
    }
    if (!_vendedores || _vendedores.length === 0) { _vendedores = await getContactsByType('vendedor'); _poblarSelectVendedores() }
    _valEv('evVendedor', v.vendedor_id || '')

    convertirEnBuscador('evContactId', { placeholder: 'Escribe el nombre o RUC...', sinResultados: 'Ningún cliente coincide' })
    convertirEnBuscador('evVendedor', { placeholder: 'Sin asignar — escribe para buscar...' })
    refrescarBuscador('evContactId')
    refrescarBuscador('evVendedor')

    // Candados cerrados en cada apertura
    ;[['evSerie','btnCandadoEvSerie','aviso-ev-serie'],
      ['evCorrelativo','btnCandadoEvCorr','aviso-ev-corr'],
      ['evPeriodo','btnCandadoEvPeriodo','aviso-ev-periodo']].forEach(([i, b, a]) => {
      const inp = document.getElementById(i), btn = document.getElementById(b)
      if (inp) { inp.readOnly = true; inp.dataset.valorAutomatico = inp.value }
      if (btn) { btn.textContent = '🔒'; btn.classList.remove('abierto'); btn.disabled = !!bloqueos.numeracion }
      document.getElementById(a)?.classList.remove('visible')
    })

    window.onCambiarMonedaEdicion()
    _pintarAvisosEdicion()
    await _pintarCronogramaEdicion()
    _pintarVinculados()

    window.openModal('modal-editar-venta')
  } catch (error) {
    console.error('Error en editarVenta:', error)
    showToast('Error al abrir la venta para editar: ' + error.message, 'danger')
  }
}

function _etiquetaEstadoPago(cxc, aplicado) {
  if (!cxc) return 'Sin cuenta por cobrar'
  const total = parseFloat(cxc.monto_total || 0) + parseFloat(cxc.monto_notas_debito || 0) - parseFloat(cxc.monto_notas_credito || 0)
  if (aplicado >= total - 0.01) return 'Cobrado ✅'
  if (aplicado > 0.01) return `Parcial — aplicado ${formatNumber(aplicado)} de ${formatNumber(total)}`
  return 'Pendiente'
}

/** Avisa qué está bloqueado y por qué, antes de que el usuario lo intente. */
function _pintarAvisosEdicion() {
  const c = _evContexto
  const cont = document.getElementById('ev-avisos')
  if (!cont || !c) return

  const avisos = []
  if (c.aplicado > 0.01) {
    avisos.push({ t: 'warning', txt: `Esta venta ya tiene ${formatNumber(c.aplicado)} aplicado entre cobros, retenciones o canjes. No se pueden cambiar el cliente, la moneda ni el cronograma.` })
  }
  if (c.notas.length > 0) {
    avisos.push({ t: 'warning', txt: `Tiene ${c.notas.length} nota(s) de crédito/débito asociada(s). El cliente no se puede cambiar sin corregirlas primero.` })
  }
  if (c.venta.cpe_estado === 'aceptado') {
    avisos.push({ t: 'danger', txt: 'El comprobante ya fue aceptado por SUNAT. Cambiar serie, número o cliente aquí NO lo corrige ante SUNAT: eso se hace con Nota de Crédito o Comunicación de Baja.' })
  }
  if (c.guias.length > 0) {
    avisos.push({ t: 'info', txt: `Tiene ${c.guias.length} guía(s) de despacho emitida(s). Si cambias el cliente, revisa que el destino de la mercadería siga siendo correcto.` })
  }

  cont.innerHTML = avisos.length === 0
    ? '<div style="padding:9px 12px; border-radius:var(--radius-md); background:rgba(16,185,129,.12); color:var(--color-success); font-size:.85rem;">Sin cobros ni notas: se puede editar todo.</div>'
    : avisos.map(a => `<div style="padding:9px 12px; margin-bottom:6px; border-radius:var(--radius-md); font-size:.85rem; line-height:1.45;
        background:${a.t === 'danger' ? 'rgba(239,68,68,.12)' : a.t === 'warning' ? 'rgba(245,158,11,.12)' : 'rgba(59,130,246,.12)'};
        color:var(--${a.t === 'danger' ? 'color-danger' : a.t === 'warning' ? 'color-warning' : 'color-info'});">${_esc(a.txt)}</div>`).join('')
}

/** Lista los documentos que cuelgan de la venta y qué les va a pasar. */
function _pintarVinculados() {
  const c = _evContexto
  const cont = document.getElementById('ev-vinculados')
  if (!cont || !c) return

  const filas = []
  if (c.cxc) {
    filas.push({
      doc: `Cuenta por Cobrar — ${c.cxc.tipo_comprobante || ''} ${c.cxc.serie || ''}-${c.cxc.numero_comprobante || ''}`,
      detalle: `${c.cxc.moneda || 'PEN'} ${formatNumber(c.cxc.monto_total)} · estado ${c.cxc.estado}`,
      efecto: 'Se actualizarán cliente, serie/número, fechas, moneda y tipo de cambio.'
    })
  }
  if (c.cuotas.length > 0) {
    const conCobro = c.cuotas.filter(q => (parseFloat(q.monto_cobrado) || 0) + (parseFloat(q.monto_retenido) || 0) > 0.01).length
    filas.push({
      doc: `${c.cuotas.length} cuota(s) del cronograma`,
      detalle: conCobro > 0 ? `${conCobro} con cobros aplicados` : 'ninguna cobrada',
      efecto: conCobro > 0
        ? 'NO se modifican: ya tienen dinero aplicado.'
        : 'Se reemplazan por el cronograma que dejes arriba.'
    })
  }
  c.guias.forEach(g => filas.push({
    doc: `Guía de despacho ${g.numero_guia}`, detalle: g.fecha_guia || '',
    efecto: 'No se modifica (el stock ya se movió).'
  }))
  c.notas.forEach(n => filas.push({
    doc: `${nombreTipoComprobante(n.tipo_comprobante)} ${n.serie || ''}-${String(n.correlativo || '').padStart(8, '0')}`,
    detalle: `${n.moneda || 'PEN'} ${formatNumber(n.total)}`,
    efecto: 'No se modifica. Si cambias serie/número, su referencia se actualiza.'
  }))
  if (c.venta.asiento_id) filas.push({
    doc: `Asiento contable AS-${String(c.venta.asiento_id).padStart(6, '0')}`, detalle: '',
    efecto: 'No se regenera automáticamente. Si cambias la fecha o el tipo de cambio, revísalo en Contabilidad.'
  })

  cont.innerHTML = filas.length === 0
    ? '<p style="color:var(--text-secondary); font-size:.85rem;">Esta venta no tiene documentos vinculados todavía.</p>'
    : `<div class="table-container"><table>
        <thead><tr><th>Documento</th><th>Detalle</th><th>Al guardar</th></tr></thead>
        <tbody>${filas.map(f => `<tr>
          <td style="font-size:.84rem;"><strong>${_esc(f.doc)}</strong></td>
          <td style="font-size:.84rem; color:var(--text-secondary);">${_esc(f.detalle)}</td>
          <td style="font-size:.82rem;">${_esc(f.efecto)}</td>
        </tr>`).join('')}</tbody></table></div>`
}

async function _pintarCronogramaEdicion() {
  const c = _evContexto
  const cont = document.getElementById('ev-cronograma')
  if (!cont || !c) return

  if (!c.cxc) {
    cont.innerHTML = '<p style="color:var(--text-secondary); font-size:.85rem;">Esta venta no generó Cuenta por Cobrar (no es factura), así que no tiene cronograma.</p>'
    return
  }

  await renderEditorCronograma('ev-cronograma', {
    total: parseFloat(c.cxc.monto_total) || 0,
    fechaEmision: c.venta.fecha_emision,
    terminoId: c.cxc.termino_pago_id || null,
    aplicaA: 'venta',
    soloLectura: c.bloqueos.cronograma
  })

  // Si ya existen cuotas guardadas, se muestran ESAS y no un cronograma
  // recalculado: son la verdad del documento, incluidas las fechas que el
  // usuario negoció a mano en su momento.
  if (c.cuotas.length > 0) {
    cargarCuotasExistentes('ev-cronograma', c.cuotas)
  }

  if (c.bloqueos.cronograma) {
    cont.insertAdjacentHTML('beforeend',
      '<div style="margin-top:6px; font-size:.78rem; color:var(--color-warning);">Cronograma en solo lectura: ya hay cobros aplicados. Para reprogramar, revierte primero los cobros en Cuentas x Cobrar/Pagar.</div>')
  }
}

window.onCambiarFechaEmisionEdicion = function () {
  const fecha = document.getElementById('evFechaEmision')?.value
  if (!fecha) return
  const per = document.getElementById('evPeriodo')
  if (per && per.readOnly) { per.value = fecha.slice(0, 7); per.dataset.valorAutomatico = per.value }
  if (!_evContexto?.bloqueos.cronograma) actualizarCronograma('ev-cronograma', { fechaEmision: fecha })
}

window.onCambiarMonedaEdicion = function () {
  const moneda = document.getElementById('evMoneda')?.value
  const grupo = document.getElementById('evTipoCambioGroup')
  const inp = document.getElementById('evTipoCambio')
  const bloqueada = !!_evContexto?.bloqueos.moneda
  if (grupo) grupo.style.display = moneda === 'USD' ? '' : 'none'
  if (moneda !== 'USD' && inp) inp.value = 1
  const sel = document.getElementById('evMoneda')
  if (sel) sel.disabled = bloqueada
  const aviso = document.getElementById('ev-cliente-aviso')
  const selCli = document.getElementById('evContactId')
  if (selCli) selCli.disabled = !!_evContexto?.bloqueos.cliente
  if (aviso) aviso.textContent = _evContexto?.bloqueos.cliente ? 'Bloqueado: la venta ya tiene cobros o notas.' : ''
}

window.guardarEdicionVenta = async function () {
  const btn = document.getElementById('btnGuardarEdicionVenta')
  if (btn?.disabled) return
  try {
    const c = _evContexto
    const id = parseInt(document.getElementById('evId')?.value || 0)
    if (!id || !c) { showToast('Venta inválida', 'danger'); return }

    const serie      = document.getElementById('evSerie')?.value?.trim()
    const correl     = document.getElementById('evCorrelativo')?.value?.trim()
    const periodo    = document.getElementById('evPeriodo')?.value?.trim()
    const fechaEmi   = document.getElementById('evFechaEmision')?.value
    const contactId  = parseInt(document.getElementById('evContactId')?.value || 0) || c.venta.contact_id
    const vendedorId = parseInt(document.getElementById('evVendedor')?.value || 0) || null
    const moneda     = document.getElementById('evMoneda')?.value || c.venta.moneda
    const tipoCambio = moneda === 'USD' ? (parseFloat(document.getElementById('evTipoCambio')?.value || 0) || 1) : 1
    const descripcion   = document.getElementById('evDescripcion')?.value?.trim() || null
    const observaciones = document.getElementById('evObservaciones')?.value?.trim() || null

    if (!fechaEmi) { showToast('La fecha de emisión es obligatoria', 'warning'); return }
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(periodo || '')) {
      showToast('El período contable debe tener el formato AAAA-MM', 'warning'); return
    }
    if (moneda === 'USD' && tipoCambio <= 1) {
      showToast('Ingresa el tipo de cambio para una venta en dólares', 'warning'); return
    }

    // Numeración duplicada: solo se valida si realmente cambió.
    const numeroNuevo = `${serie}-${String(correl).padStart(8, '0')}`
    const numeroViejo = `${c.venta.serie || ''}-${String(c.venta.correlativo || '').padStart(8, '0')}`
    if (numeroNuevo !== numeroViejo) {
      const existe = (await getVentas() || []).some(v => v.id !== id && v.numero === numeroNuevo)
      if (existe) { showToast(`Ya existe el comprobante ${numeroNuevo}`, 'danger'); return }
    }

    // Cronograma
    let crono = null
    if (!c.bloqueos.cronograma && c.cxc) {
      crono = leerCronograma('ev-cronograma')
      if (crono && !crono.cuadra) {
        showToast(`Las cuotas suman ${formatNumber(crono.suma)} pero el total es ${formatNumber(crono.total)}. Usa "= Prorratear al total".`, 'warning')
        return
      }
    }

    // Resumen de la cascada para que el usuario confirme lo que va a pasar.
    const cambios = []
    if (contactId !== c.venta.contact_id) cambios.push('cliente')
    if (numeroNuevo !== numeroViejo) cambios.push('serie/número')
    if (fechaEmi !== c.venta.fecha_emision) cambios.push('fecha de emisión')
    if (periodo !== c.venta.periodo_contable) cambios.push('período contable')
    if (moneda !== c.venta.moneda) cambios.push('moneda')
    if (Math.abs(tipoCambio - (parseFloat(c.venta.tipo_cambio) || 1)) > 0.0001) cambios.push('tipo de cambio')
    if (crono?.cuotas?.length) cambios.push('cronograma de pago')

    if (cambios.length === 0) {
      showToast('No hay cambios que guardar', 'info')
      return
    }
    if (!confirm(
      `Se actualizará ${cambios.join(', ')} en la venta ${numeroViejo}` +
      (c.cxc ? `, y se propagará a su Cuenta por Cobrar${crono ? ' y su cronograma de cuotas' : ''}.` : '.') +
      `\n\n¿Confirmar?`
    )) return

    if (btn) { btn.disabled = true; btn.textContent = 'Guardando...' }

    // ── 1) La venta ────────────────────────────────────────────────────
    const fechaVenc = crono?.cuotas?.length
      ? crono.cuotas[crono.cuotas.length - 1].fecha_vencimiento
      : c.venta.fecha_vencimiento

    const okVenta = await updateVenta(id, {
      contact_id: contactId, vendedor_id: vendedorId,
      serie, correlativo: correl.replace(/^0+/, '') || correl,
      numero: numeroNuevo,
      fecha_emision: fechaEmi, fecha_vencimiento: fechaVenc,
      periodo_contable: periodo, moneda, tipo_cambio: tipoCambio,
      descripcion, observaciones,
      termino_pago_id: crono?.terminoId ?? c.venta.termino_pago_id,
      cronograma_personalizado: crono ? !!crono.personalizado : c.venta.cronograma_personalizado
    })
    if (!okVenta) throw new Error('no se pudo actualizar la venta')

    // ── 2) Cuenta por Cobrar ───────────────────────────────────────────
    // Sin esto, Cobranzas seguiría mostrando la deuda con los datos viejos.
    if (c.cxc) {
      try {
        await updateCuentaCobrar(c.cxc.id, {
          contact_id: contactId, serie, numero_comprobante: correl.replace(/^0+/, '') || correl,
          fecha_emision: fechaEmi, fecha_vencimiento: fechaVenc,
          moneda, tipo_cambio: tipoCambio,
          termino_pago_id: crono?.terminoId ?? c.cxc.termino_pago_id,
          cronograma_personalizado: crono ? !!crono.personalizado : c.cxc.cronograma_personalizado
        })
      } catch (e) {
        console.warn('CxC no actualizada:', e.message)
        showToast('Venta guardada ⚠️ la Cuenta por Cobrar no se actualizó: ' + e.message, 'warning')
      }
    }

    // ── 3) Cuotas ──────────────────────────────────────────────────────
    // Se reemplazan enteras: reconciliar altas/bajas/cambios de orden una por
    // una es más frágil que regenerarlas, y aquí ya validamos que ninguna
    // tiene dinero aplicado.
    if (crono?.cuotas?.length && c.cxc) {
      try {
        for (const q of c.cuotas) await deleteCuotaCobrar(q.id)
        await _guardarCuotasDeCxC(c.cxc.id, crono)
      } catch (e) {
        console.warn('Cuotas no regeneradas:', e.message)
        showToast('⚠️ El cronograma no se pudo regenerar: ' + e.message, 'warning')
      }
    }

    // ── 4) Notas que referencian esta venta ────────────────────────────
    if (numeroNuevo !== numeroViejo && c.notas.length > 0) {
      for (const n of c.notas) {
        try {
          await updateVenta(n.id, {
            doc_referencia_serie: serie,
            doc_referencia_numero: correl.replace(/^0+/, '') || correl
          })
        } catch (e) { console.warn(`Nota ${n.id} no actualizada:`, e.message) }
      }
    }

    _invalidarCacheVentas()
    showToast(`Venta ${numeroNuevo} actualizada ✅ — ${cambios.length} cambio(s) propagado(s)`, 'success')
    window.closeModal('modal-editar-venta')
    await renderVentas(true)
  } catch (error) {
    console.error('Error en guardarEdicionVenta:', error)
    showToast('Error al actualizar la venta: ' + error.message, 'danger')
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Guardar y propagar cambios' }
  }
}

function _setEv(id, txt) { const el = document.getElementById(id); if (el) el.textContent = txt }
function _valEv(id, v)   { const el = document.getElementById(id); if (el) el.value = v }

// ─── Eliminar Venta ───────────────────────────────────────────────────────────
// Orden correcto para eliminar una venta sin descuadrar Inventario/CxC:
//   1) Si el comprobante ya fue ACEPTADO por NUBEFACT/SUNAT (cpe_estado ===
//      'aceptado'), NO se puede simplemente borrar: legalmente hay que anular
//      con una Nota de Crédito. Se bloquea el borrado.
//   2) Si la CxC de esta venta ya tiene algo cobrado (monto_cobrado > 0), se
//      bloquea: primero hay que revertir/anular ese cobro en Cobranzas.
//   3) Si pasa ambas validaciones: se devuelve el stock. Se usa el Kardex
//      ('salida' con venta_id) como fuente PRECISA, porque ahí sí queda un
//      movimiento por cada lote+zona realmente tocado — a diferencia de
//      detalle_ventas, que solo guarda UN lote_id "representativo" por
//      línea (el primer lote FIFO) con la cantidad total de la línea. Si
//      una línea consumió 2 lotes, revertir solo por detalle_ventas le
//      devolvía TODO al primer lote y dejaba el segundo con menos stock
//      del real, y luego eliminarGuia/eliminarCompra fallaba con un falso
//      "ya hay ventas" sobre ese segundo lote. Solo se cae al método
//      antiguo (detalle_ventas) si la venta es de antes de que existiera
//      el Kardex y no tiene movimientos que revertir.
// Devuelve cantidad+unidades a un lote y, si aplica, a la fila específica de
// stock_ubicaciones de esa zona (se recrea si ya no existe). Compartida por
// _eliminarVentaCore y por eliminarGuiaDespachoVenta (ambos revierten stock
// consumido por una salida de venta).
async function _devolverAUnaZona(loteId, ubicacionId, cantidad, unidades = 0) {
  if (!loteId || !cantidad) return
  const lote = await getLoteById(loteId)
  if (!lote) return
  await updateLote(loteId, {
    cantidad: parseFloat(((parseFloat(lote.cantidad) || 0) + cantidad).toFixed(4)),
    cantidad_unidades: parseFloat(((parseFloat(lote.cantidad_unidades) || 0) + (unidades || 0)).toFixed(4))
  })
  if (!ubicacionId) return
  const filasLote = await getStockUbicacionesByLote(loteId)
  const filaZona = (filasLote || []).find(f => f.ubicacion_id === ubicacionId)
  if (filaZona) {
    await updateStockUbicacion(filaZona.id, {
      cantidad: parseFloat(((parseFloat(filaZona.cantidad) || 0) + cantidad).toFixed(4)),
      cantidad_unidades: parseFloat(((parseFloat(filaZona.cantidad_unidades) || 0) + (unidades || 0)).toFixed(4))
    })
  } else {
    await addStockUbicacion({ lote_id: loteId, ubicacion_id: ubicacionId, cantidad, cantidad_unidades: unidades || 0 })
  }
}

// Lógica núcleo de reversión (sin confirm() ni toasts) — la usan tanto
// eliminarVenta (una sola, con confirm) como eliminarVentasSeleccionadas
// (varias, con un solo confirm para todo el lote). Lanza Error con un
// mensaje claro si no se puede eliminar (CPE aceptado, CxC cobrada, etc).
async function _eliminarVentaCore(id) {
  const venta = await getVentaById(id)
  if (!venta) throw new Error('No se encontró la venta')

  const numeroVenta = `${venta.serie || ''}-${String(venta.correlativo || '').padStart(8, '0')}`

  if (venta.cpe_estado === 'aceptado') {
    throw new Error(`${numeroVenta}: ya fue aceptado por SUNAT/NUBEFACT, debe anularse con Nota de Crédito`)
  }

  const cxcs = await getCuentasCobrarByVenta(id)
  // Se revisa cobrado Y retenido: una retención de IGV salda parte de la CxC
  // sin que entre efectivo, así que monto_cobrado puede seguir en 0 y aun así
  // haber movimiento aplicado que no se puede borrar en silencio.
  const cxcCobrada = (cxcs || []).find(c =>
    (parseFloat(c.monto_cobrado) || 0) > 0 || (parseFloat(c.monto_retenido) || 0) > 0)
  if (cxcCobrada) {
    throw new Error(`${numeroVenta}: ya tiene un cobro o retención registrada en Cuentas por Cobrar, revierte ese movimiento primero`)
  }

  // Notas de crédito/débito que apuntan a esta venta: `ventas.venta_referencia_id`
  // es una FK a la propia tabla, así que borrar la venta original con notas
  // vivas falla por restricción de clave foránea (error 23503 → 409 en la API).
  const notasDeEstaVenta = (await getVentas() || []).filter(v => v.venta_referencia_id === id)
  if (notasDeEstaVenta.length > 0) {
    const nums = notasDeEstaVenta.map(n => `${n.serie || ''}-${String(n.correlativo || '').padStart(8, '0')}`).join(', ')
    throw new Error(`${numeroVenta}: tiene ${notasDeEstaVenta.length} nota(s) de crédito/débito (${nums}). Elimínalas primero.`)
  }

  // No se puede borrar una venta que ya tiene guía(s) de despacho: primero
  // hay que borrar las guías (eso sí revierte su stock/kardex), recién
  // entonces la venta queda libre para eliminarse.
  const todasGuias = await getGuiasDespachoVenta()
  const guiasVenta = (todasGuias || []).filter(g => g.venta_id === id)
  if (guiasVenta.length > 0) {
    const numeros = guiasVenta.map(g => g.numero_guia).join(', ')
    throw new Error(`${numeroVenta}: tiene ${guiasVenta.length} guía(s) de despacho (${numeros}). Elimina primero esa(s) guía(s) antes de borrar la venta.`)
  }

  const detalles = await getDetalleVentas(id)
  const kardexVenta = await getKardexByVenta(id)
  const salidasKardex = (kardexVenta || []).filter(k => k.tipo_movimiento === 'salida' && k.lote_id)

  if (salidasKardex.length > 0) {
    // Fuente precisa: un movimiento de kardex por cada lote+zona
    // realmente consumido por esta venta.
    for (const k of salidasKardex) {
      await _devolverAUnaZona(k.lote_id, k.ubicacion_origen_id, parseFloat(k.cantidad_salida) || 0, parseFloat(k.cantidad_unidades_salida) || 0)
    }
  } else {
    // Fallback para ventas de antes del Kardex (sin movimientos que
    // revertir): usa detalle_ventas.lote_id, best-effort si una línea
    // consumió más de un lote por FIFO.
    for (const d of (detalles || [])) {
      await _devolverAUnaZona(d.lote_id, d.ubicacion_id, parseFloat(d.cantidad) || 0, parseFloat(d.cantidad_unidades) || 0)
    }
  }

  for (const c of (cxcs || [])) {
    // `cobros.cxc_id` referencia la cuenta por cobrar: si quedara algún cobro
    // (aunque sea de monto 0), el DELETE de la CxC fallaría por FK.
    const cobrosCxC = await getCobrosByCxC(c.id)
    for (const cb of (cobrosCxC || [])) await deleteCobro(cb.id)
    await deleteCuentaCobrar(c.id)
  }

  // Kardex: se borran las filas 'salida' que generó esta venta (aún en
  // pruebas — sin esto quedarían movimientos de una venta ya borrada).
  for (const k of (kardexVenta || [])) {
    await deleteKardexMovimiento(k.id)
  }

  const ok = await deleteVenta(id)
  if (!ok) {
    const motivo = ultimoErrorDelete()
    throw new Error(
      `${numeroVenta}: no se pudo eliminar — ${motivo?.mensaje || 'error desconocido'} ` +
      `Si no quieres perder el rastro del documento, anúlala en vez de eliminarla.`
    )
  }

  return numeroVenta
}

window.eliminarVenta = async function (id) {
  try {
    const venta = await getVentaById(id)
    if (!venta) { showToast('No se encontró la venta', 'danger'); return }

    if (!confirm(
      `Se eliminará la venta ${venta.serie || ''}-${String(venta.correlativo || '').padStart(8,'0')}, ` +
      `su detalle y se devolverá el stock a Inventario. ¿Continuar?`
    )) return

    const numeroVenta = await _eliminarVentaCore(id)
    showToast(`Venta ${numeroVenta} eliminada: stock devuelto a Inventario`, 'success')
    await renderVentas(true)
  } catch (error) {
    console.error('Error en eliminarVenta:', error)
    showToast(error.message || 'Error al eliminar la venta', 'danger')
  }
}

// ─── Eliminación masiva (checkbox) ───────────────────────────────────────────
// Reusa _eliminarVentaCore por cada id marcado, un solo confirm() para todo
// el lote, y un resumen al final (cuántas se borraron / cuántas fallaron y
// por qué) en vez de un toast por fila.
window.toggleSeleccionTodasVentas = function (checked) {
  document.querySelectorAll('.venta-sel:not(:disabled)').forEach(cb => { cb.checked = checked })
  window.actualizarBotonEliminarVentasSeleccionadas()
}

window.actualizarBotonEliminarVentasSeleccionadas = function () {
  const seleccionadas = document.querySelectorAll('.venta-sel:checked').length
  const btn = document.getElementById('btnEliminarVentasSeleccionadas')
  if (!btn) return
  btn.style.display = seleccionadas > 0 ? 'inline-flex' : 'none'
  btn.textContent = `🗑 Eliminar seleccionadas (${seleccionadas})`
}

window.eliminarVentasSeleccionadas = async function () {
  const ids = Array.from(document.querySelectorAll('.venta-sel:checked')).map(cb => parseInt(cb.value))
  if (ids.length === 0) { showToast('Selecciona al menos una venta', 'warning'); return }

  if (!confirm(
    `Se eliminarán ${ids.length} venta(s), su detalle, y se devolverá el stock (kg y unidades) a Inventario. ` +
    `Esta acción no se puede deshacer. ¿Continuar?`
  )) return

  const btn = document.getElementById('btnEliminarVentasSeleccionadas')
  if (btn) { btn.disabled = true; btn.textContent = 'Eliminando...' }

  let ok = 0
  const errores = []
  for (const id of ids) {
    try {
      await _eliminarVentaCore(id)
      ok++
    } catch (error) {
      console.error(`Error eliminando venta ${id}:`, error)
      errores.push(error.message || `Venta #${id}: error inesperado`)
    }
  }

  if (ok > 0) showToast(`${ok} venta(s) eliminada(s): stock devuelto a Inventario`, 'success')
  if (errores.length > 0) {
    showToast(`${errores.length} venta(s) no se pudieron eliminar: ${errores.join(' | ')}`, 'danger')
  }

  if (btn) { btn.disabled = false }
  await renderVentas(true)
}

// ============================================================================
// MODAL: NUEVA VENTA
// ============================================================================

window.abrirModalNuevaVenta = async function() {
  try {
    _ventaLineas = []
    document.getElementById('ventaLineas').innerHTML = ''
    document.getElementById('ventaTotalCantidad').textContent = '0'
    document.getElementById('ventaTotalBase').textContent   = '0.00'
    document.getElementById('ventaTotalIGV').textContent    = '0.00'
    document.getElementById('ventaTotalFinal').textContent  = '0.00'
    const avisoRet = document.getElementById('ventaClienteRetencionAviso')
    if (avisoRet) avisoRet.style.display = 'none'

    const periodo = await asegurarPeriodoAbierto()
    const periodoEl = document.getElementById('ventaPeriodo')
    if (periodoEl) {
      periodoEl.value = periodo
      periodoEl.dataset.valorAutomatico = periodo
    }

    // Fecha vencimiento por defecto = fecha emisión (el onchange del campo
    // de emisión la mantiene sincronizada mientras el usuario no la toque).
    const fEmision = document.getElementById('ventaFechaEmision')
    const fVenc    = document.getElementById('ventaFechaVencimiento')
    if (fEmision && !fEmision.value) fEmision.value = new Date().toISOString().split('T')[0]
    if (fVenc && fEmision) fVenc.value = fEmision.value

    // Preferencias de Configuración: moneda y serie por defecto.
    const cfgVentas = getModuloConfig('ventas')
    const monedaSel = document.getElementById('ventaMoneda')
    if (monedaSel) monedaSel.value = cfgVentas.monedaDefault || 'PEN'
    const tipoCompSel = document.getElementById('ventaTipoComp')
    const serieEl = document.getElementById('ventaSerie')
    if (serieEl && !serieEl.value) {
      serieEl.value = tipoCompSel?.value === '03' ? (cfgVentas.serieBoleta || 'B001') : (cfgVentas.serieFactura || 'F001')
    }

    // Candados cerrados, campos opcionales plegados y correlativo sugerido
    // según la serie que quedó arriba.
    await window._prepararCamposVenta()

    // Cronograma: se re-renderiza en cada apertura para tomar el término del
    // cliente elegido y limpiar lo que quedó de la venta anterior.
    _cronogramaVentaListo = false
    await _prepararCronogramaVenta(true)

    // T.C. oculto salvo que la moneda sea USD (igual que en Compras).
    const tcGroup = document.getElementById('ventaTipoCambioGroup')
    if (tcGroup) tcGroup.style.display = monedaSel?.value === 'USD' ? 'block' : 'none'

    // Refrescar stock/lotes: el aviso de zona/lote se arma con esto, para
    // no ofrecer stock que ya no existe.
    const [lotesFrescos, stockFresco] = await Promise.all([getLotes(), getStockUbicaciones()])
    _lotes = lotesFrescos
    _stockUbic = stockFresco
    _lotesMap = {}
    for (const lo of (_lotes || [])) _lotesMap[lo.id] = lo

    _poblarSelectClientes()
    _poblarSelectItems()
    _poblarZonaSelectParaItem(null)
    _poblarLoteSelectParaZona(null, null)
    const inpUnidad = document.getElementById('ventaLineaUnidad')
    if (inpUnidad) inpUnidad.value = ''
    const inpCantUnid = document.getElementById('ventaLineaCantUnidades')
    if (inpCantUnid) inpCantUnid.value = ''
    const inpPeso = document.getElementById('ventaLineaPesoUnidad')
    if (inpPeso) inpPeso.value = ''
    _actualizarAvisoStockLineaVenta()

    window.openModal('modal-nueva-venta')
  } catch (e) {
    showToast('Error al abrir modal: ' + e.message, 'danger')
  }
}

// La venta pide lote+zona por línea (para no facturar algo que no hay), pero
// eso NO mueve stock/kardex acá — es solo referencial en detalle_ventas. El
// movimiento real (descontar de lotes/stock_ubicaciones, generar kardex) se
// hace después, en la Guía de Despacho de Venta (ver TAB: GUÍAS DE DESPACHO),
// igual que en Compras la OC no mueve stock y recién la Guía de Remisión lo hace.
/** Abre el modal de "Agregar Producto a la Venta" (espejo de compras). */
window.abrirModalLineaVenta = function () {
  window.openModal('modal-agregar-linea-venta')
}

window.cerrarModalLineaVenta = function () {
  window.closeModal('modal-agregar-linea-venta')
}

window.agregarLineaVenta = function() {
  const sel    = document.getElementById('ventaItemSelect')
  const opt    = sel?.selectedOptions[0]
  const itemId = parseInt(sel?.value || 0)
  if (!itemId) { showToast('Selecciona un producto', 'warning'); return }

  const zonaSel = document.getElementById('ventaLineaZona')
  const zonaId  = parseInt(zonaSel?.value || 0)
  if (!zonaId) { showToast('Selecciona el Almacén/Zona de la que saldrá el stock', 'warning'); return }

  const su = _stockUbicSeleccionada()
  if (!su) { showToast('Selecciona el lote del que saldrá el stock', 'warning'); return }
  const lote = _lotesMap[su.lote_id]
  if (!lote) { showToast('No se encontró el lote seleccionado', 'danger'); return }

  const cantInput  = document.getElementById('ventaLineaCantidad')
  const unidInput  = document.getElementById('ventaLineaCantUnidades')
  const precioInp  = document.getElementById('ventaLineaPrecio')
  const descInp    = document.getElementById('ventaLineaDesc')
  const tipoBase   = document.getElementById('ventaLineTipoBase')?.value || 'gravada'

  const cantidad         = parseFloat(cantInput?.value || 1)
  const cantidadUnidades = parseFloat(unidInput?.value || 0) || 0
  const precio      = parseFloat(precioInp?.value || opt?.getAttribute('data-precio') || 0)
  const descripcion = descInp?.value || opt?.text || ''
  const item        = _items.find(i => i.id === itemId)
  const unidadMedida = item?.unidad_medida || 'KG'

  if (cantidad <= 0 || precio <= 0) {
    showToast('Cantidad y precio deben ser mayores a 0', 'warning')
    return
  }

  // Stock disponible en ESE lote+zona específico — si no alcanza, se
  // bloquea acá (solo aviso: el stock recién se descuenta de verdad al
  // crear la Guía de Despacho). Se descuenta lo que otras líneas ya
  // agregadas en este mismo formulario reservaron del mismo lote+zona,
  // para no "vender" el mismo stock dos veces antes de guardar.
  const yaReservadoKg = _ventaLineas
    .filter(l => l.stock_ubicacion_id === su.id)
    .reduce((s, l) => s + (parseFloat(l.cantidad) || 0), 0)
  const yaReservadoUnid = _ventaLineas
    .filter(l => l.stock_ubicacion_id === su.id)
    .reduce((s, l) => s + (parseFloat(l.cantidad_unidades) || 0), 0)
  const disponibleKg   = (parseFloat(su.cantidad) || 0) - yaReservadoKg
  const disponibleUnid = (parseFloat(su.cantidad_unidades) || 0) - yaReservadoUnid

  if (cantidad > disponibleKg) {
    showToast(
      `Stock insuficiente en el lote ${lote.numero_lote} (${_nombreZona(zonaId)}) para "${descripcion}": disponible ${formatQty(disponibleKg)} kg, solicitado ${formatQty(cantidad)} kg.`,
      'danger'
    )
    return
  }
  if (cantidadUnidades > 0 && cantidadUnidades > disponibleUnid) {
    showToast(
      `Unidades insuficientes en el lote ${lote.numero_lote}: disponible ${formatQty(disponibleUnid)} und, solicitado ${formatQty(cantidadUnidades)} und.`,
      'danger'
    )
    return
  }

  // "Gravada 18% (incluido)" es solo un modo de captura: el vendedor pasa
  // el precio del pedido con IGV ya incluido. tipo_base se sigue guardando
  // como 'gravada' (el CHECK de detalle_ventas no tiene un valor aparte
  // para esto), pero precio_unitario se normaliza a la base SIN IGV antes
  // de guardar, para que subtotal = cantidad * precio_unitario siga
  // cumpliéndose en todo el sistema (ej. calcularTotalesLinea).
  const igvIncluido = tipoBase === 'gravada_incluido'
  const tipoBaseGuardar = igvIncluido ? 'gravada' : tipoBase
  const igvPct = (tipoBase === 'gravada' || igvIncluido) ? 18 : 0

  let subtotal, igvMonto, totalLine, precioUnitarioGuardar
  if (igvIncluido) {
    totalLine = parseFloat((cantidad * precio).toFixed(2))
    subtotal  = parseFloat((totalLine / 1.18).toFixed(2))
    igvMonto  = parseFloat((totalLine - subtotal).toFixed(2))
    precioUnitarioGuardar = parseFloat((subtotal / cantidad).toFixed(4))
  } else {
    subtotal  = parseFloat((cantidad * precio).toFixed(2))
    igvMonto  = parseFloat((subtotal * igvPct / 100).toFixed(2))
    totalLine = parseFloat((subtotal + igvMonto).toFixed(2))
    precioUnitarioGuardar = precio
  }

  _ventaLineas.push({
    item_id: itemId, descripcion, cantidad, cantidad_unidades: cantidadUnidades,
    precio_unitario: precioUnitarioGuardar,
    subtotal, tipo_base: tipoBaseGuardar, igv_porcentaje: igvPct,
    igv_monto: igvMonto, total_linea: totalLine,
    unidad_medida: unidadMedida, ubicacion_id: zonaId,
    lote_id: lote.id, stock_ubicacion_id: su.id, numero_lote: lote.numero_lote,
    costo_unitario: parseFloat(lote.costo_unitario || 0)
  })

  _renderLineasVenta()

  // Limpiar
  if (cantInput)  cantInput.value  = '1'
  if (unidInput)  unidInput.value  = ''
  if (precioInp)  precioInp.value  = ''
  if (descInp)    descInp.value    = ''
  if (sel)        sel.value        = ''
  const inpUnidad = document.getElementById('ventaLineaUnidad')
  if (inpUnidad)  inpUnidad.value  = ''
  const inpPeso = document.getElementById('ventaLineaPesoUnidad')
  if (inpPeso)    inpPeso.value    = ''
  _poblarZonaSelectParaItem(null)
  _poblarLoteSelectParaZona(null, null)
  _actualizarAvisoStockLineaVenta()
  window.cerrarModalLineaVenta()
  showToast('Producto agregado a la venta', 'success')
}

// Etiqueta + color legibles para el tipo de IGV de una línea (en vez de
// mostrar el valor crudo de la BD como 'gravada'/'exonerada'/'inafecta').
function _badgeTipoIGV(tipoBase) {
  const map = {
    gravada:   { label: 'Gravada 18%', color: 'var(--color-info)' },
    exonerada: { label: 'Exonerada',   color: 'var(--color-warning)' },
    inafecta:  { label: 'Inafecta',    color: 'var(--text-secondary)' }
  }
  const m = map[tipoBase] || { label: tipoBase || '-', color: 'var(--text-secondary)' }
  return `<span style="display:inline-block; padding:2px 8px; border-radius:999px; font-size:0.75rem; font-weight:600; color:#fff; background:${m.color}; white-space:nowrap;">${m.label}</span>`
}

// Chip gris sutil para la zona, igual de compacto que un badge de tipo,
// para que ambas columnas se vean consistentes en vez de texto suelto.
function _badgeZona(ubicacionId) {
  return `<span style="display:inline-block; padding:2px 8px; border-radius:999px; font-size:0.75rem; background:var(--bg-tertiary); color:var(--text-primary); white-space:nowrap;">${_nombreZona(ubicacionId)}</span>`
}

function _renderLineasVenta() {
  const container = document.getElementById('ventaLineas')
  if (!container) return

  let cantidadTotal = 0, base = 0, igv = 0, total = 0
  _ventaLineas.forEach(l => {
    cantidadTotal += parseFloat(l.cantidad) || 0
    base += l.subtotal; igv += l.igv_monto; total += l.total_linea
  })

  if (_ventaLineas.length === 0) {
    container.innerHTML = `<tr><td colspan="11" style="text-align:center; color:var(--text-secondary); padding:20px;">Sin productos agregados</td></tr>`
  } else {
    container.innerHTML = _ventaLineas.map((l, idx) => `
      <tr>
        <td>${l.descripcion}</td>
        <td>${l.numero_lote || '-'}</td>
        <td style="text-align:right;">${(parseFloat(l.cantidad) || 0).toLocaleString('en-US', { maximumFractionDigits: 3 })}</td>
        <td>${l.unidad_medida || '-'}</td>
        <td style="text-align:right;">${(parseFloat(l.cantidad_unidades) || 0) > 0 ? (parseFloat(l.cantidad_unidades) || 0).toLocaleString('en-US', { maximumFractionDigits: 2 }) : '-'}</td>
        <td style="text-align:right;">${l.precio_unitario.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
        <td>${_badgeTipoIGV(l.tipo_base)}</td>
        <td>${_badgeZona(l.ubicacion_id)}</td>
        <td style="text-align:right;">${l.igv_monto.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
        <td style="text-align:right; font-weight:bold;">${l.total_linea.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
        <td><button type="button" class="btn btn-small btn-danger" onclick="window.quitarLineaVenta(${idx})">✕</button></td>
      </tr>
    `).join('')
  }

  document.getElementById('ventaTotalCantidad').textContent = cantidadTotal.toLocaleString('en-US', { maximumFractionDigits: 3 })
  document.getElementById('ventaTotalBase').textContent   = base.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  document.getElementById('ventaTotalIGV').textContent    = igv.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  document.getElementById('ventaTotalFinal').textContent  = total.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  _actualizarAvisoRetencionVenta()
  // Las cuotas se prorratean sobre el total: si cambian las líneas, el
  // cronograma tiene que seguirlas o dejaría de cuadrar.
  window._refrescarCronogramaVenta?.()
}

window.quitarLineaVenta = function(idx) {
  _ventaLineas.splice(idx, 1)
  _renderLineasVenta()
  _actualizarAvisoStockLineaVenta()
}

window.guardarNuevaVenta = async function() {
  const btn = document.getElementById('btnGuardarNuevaVenta')
  if (btn?.disabled) return
  if (btn) { btn.disabled = true; btn.textContent = 'Guardando...' }
  try {
    const user = await getCurrentUser()

    const contactId     = parseInt(document.getElementById('ventaContactId')?.value || 0)
    const tipoComp      = document.getElementById('ventaTipoComp')?.value || '01'
    const serie         = document.getElementById('ventaSerie')?.value?.trim() || (tipoComp === '01' ? 'F001' : 'B001')
    const fechaEmision  = document.getElementById('ventaFechaEmision')?.value
    const fechaVenc     = document.getElementById('ventaFechaVencimiento')?.value
    const moneda        = document.getElementById('ventaMoneda')?.value || 'PEN'
    // PEN siempre es 1 (igual que en Compras); en USD se usa el valor del
    // campo (manual o el que dejó el botón "↻ Auto").
    const tipoCambio = moneda === 'USD'
      ? (parseFloat(document.getElementById('ventaTipoCambio')?.value || 0) || 1)
      : 1
    const periodo       = document.getElementById('ventaPeriodo')?.value
    const vendedorId    = parseInt(document.getElementById('ventaVendedor')?.value || 0) || null
    const descripcion   = document.getElementById('ventaDescripcion')?.value?.trim() || null
    const observaciones = document.getElementById('ventaObservaciones')?.value?.trim() || null

    if (!contactId)           { showToast('Selecciona un cliente', 'warning'); return }

    // Si el contacto no tiene el tipo 'cliente' (ej. solo proveedor), se informa
    // y se agrega 'cliente' a su lista tipo_contacto para futuras ventas.
    // La venta continúa después de la confirmación, no se anula.
    const contactoVenta = await getContactById(contactId)
    if (contactoVenta) {
      const tipos = tiposDeContacto(contactoVenta)
      if (!tipos.includes('cliente')) {
        const ok = confirm(
          `⚠ "${contactoVenta.nombre}" está registrado como: ${tipos.join(', ') || 'sin tipo'}.\n\n` +
          `Se agregará "cliente" a su tipo de contacto para esta y futuras ventas.\n\n` +
          `¿Confirmar y continuar con la venta?`
        )
        if (!ok) return
        await updateContact(contactId, { tipo_contacto: [...tipos, 'cliente'] })
        showToast(`"${contactoVenta.nombre}" ahora también es cliente`, 'info')
      }
    }

    if (!fechaEmision)        { showToast('Ingresa la fecha de emisión', 'warning'); return }
    if (_ventaLineas.length === 0) { showToast('Agrega al menos una línea', 'warning'); return }

    // Re-chequeo de stock en el LOTE+ZONA exacto de cada línea (elegidos en
    // el selector) justo antes de crear la venta — agregarLineaVenta ya
    // valida al agregar, pero el stock pudo cambiar mientras el modal
    // estaba abierto. Es solo un aviso preventivo: la venta no descuenta
    // stock (eso lo hace la Guía de Despacho), pero así se evita facturar
    // algo que ya no hay disponible. Se reserva localmente por si dos
    // líneas del carrito comparten lote+zona.
    const stockUbicActual = await getStockUbicaciones()
    _stockUbic = stockUbicActual
    const stockLocal = (stockUbicActual || []).map(su => ({ ...su }))
    for (const l of _ventaLineas) {
      const fila = stockLocal.find(su => su.id === l.stock_ubicacion_id)
      if (!fila || fila.ubicacion_id !== l.ubicacion_id || _lotesMap[fila.lote_id]?.item_id !== l.item_id) {
        showToast(
          `El stock del lote ${l.numero_lote || ''} para "${l.descripcion}" cambió desde que abriste el formulario. ` +
          `Cierra y vuelve a intentar.`,
          'danger'
        )
        return
      }
      const dispKg   = parseFloat(fila.cantidad) || 0
      const dispUnid = parseFloat(fila.cantidad_unidades) || 0
      if (l.cantidad > dispKg) {
        showToast(
          `Stock insuficiente en el lote ${l.numero_lote} (${_nombreZona(l.ubicacion_id)}) para "${l.descripcion}": disponible ${formatQty(dispKg)} kg, solicitado ${formatQty(l.cantidad)} kg. ` +
          `El stock pudo cambiar desde que abriste el formulario — cierra y vuelve a intentar.`,
          'danger'
        )
        return
      }
      if ((l.cantidad_unidades || 0) > 0 && l.cantidad_unidades > dispUnid) {
        showToast(
          `Unidades insuficientes en el lote ${l.numero_lote}: disponible ${formatQty(dispUnid)} und, solicitado ${formatQty(l.cantidad_unidades)} und. ` +
          `El stock pudo cambiar desde que abriste el formulario — cierra y vuelve a intentar.`,
          'danger'
        )
        return
      }
      fila.cantidad = parseFloat((dispKg - l.cantidad).toFixed(4)) // reserva local para la próxima línea del carrito
      fila.cantidad_unidades = parseFloat((dispUnid - (l.cantidad_unidades || 0)).toFixed(4))
    }

    // El correlativo sale del campo del formulario (sugerido automáticamente,
    // o escrito a mano si el usuario abrió el candado).
    const correlativoInput = document.getElementById('ventaCorrelativo')?.value?.trim()
    const correlativo = correlativoInput
      ? parseInt(correlativoInput, 10)
      : await generarNumeroVenta(tipoComp, serie)

    if (!correlativo || isNaN(correlativo) || correlativo <= 0) {
      showToast('El N° de comprobante debe ser un número válido', 'warning')
      return
    }

    // Si el número o el período se editaron a mano, se pide confirmación
    // explícita: ambos tienen consecuencias (correlatividad y mes de
    // declaración) que no conviene cambiar sin darse cuenta.
    if (!(await _confirmarCamposManualesVenta(periodo, correlativo))) {
      showToast('Guardado cancelado', 'info')
      return
    }

    // Un correlativo manual puede chocar con uno ya emitido en esa serie.
    if (_campoFueEditado('ventaCorrelativo')) {
      const numeroTentativo = `${serie}-${String(correlativo).padStart(8, '0')}`
      const yaExiste = (await getVentas() || []).some(v => v.numero === numeroTentativo)
      if (yaExiste) {
        showToast(`Ya existe el comprobante ${numeroTentativo}. Usa otro número.`, 'danger')
        return
      }
    }

    const base  = _ventaLineas.reduce((s, l) => s + l.subtotal,   0)
    const igv   = _ventaLineas.reduce((s, l) => s + l.igv_monto,  0)
    const total = _ventaLineas.reduce((s, l) => s + l.total_linea, 0)

    // Cronograma de pago: si las cuotas no suman el total, la CxC quedaría
    // descuadrada desde el día uno. Se valida aquí, antes de escribir nada.
    const cronograma = leerCronograma('venta-cronograma')
    if (cronograma && !cronograma.cuadra) {
      showToast(
        `Las cuotas suman ${formatNumber(cronograma.suma)} pero el total es ${formatNumber(total)}. ` +
        `Usa "= Prorratear al total" en el cronograma o corrige los importes.`,
        'warning'
      )
      return
    }

    const venta = await addVenta({
      numero:           `${serie}-${String(correlativo).padStart(8,'0')}`,
      tipo_comprobante: tipoComp,
      serie,
      correlativo,
      contact_id:       contactId,
      fecha_emision:    fechaEmision,
      fecha_vencimiento: fechaVenc || null,
      periodo_contable: periodo || fechaEmision.slice(0,7),
      moneda,
      tipo_cambio:      tipoCambio,
      base_imponible:   parseFloat(base.toFixed(2)),
      igv:              parseFloat(igv.toFixed(2)),
      total:            parseFloat(total.toFixed(2)),
      estado:           'emitida',
      estado_pago:      'pendiente',
      cpe_estado:       'no_enviado',
      vendedor_id:      vendedorId,
      descripcion,
      observaciones,
      termino_pago_id:  cronograma?.terminoId || null,
      cronograma_personalizado: !!cronograma?.personalizado,
      created_by:       user?.db_id
    })

    if (!venta?.id) throw new Error('No se pudo crear la venta')

    // La venta SOLO registra el comprobante — NO mueve stock ni kardex
    // (eso lo hace la Guía de Despacho, paso separado, ver TAB: GUÍAS DE
    // DESPACHO; venta.estado_despacho queda en 'pendiente' por default).
    // lote_id/ubicacion_id/costo_unitario SÍ se guardan en detalle_ventas
    // como referencia de lo que el vendedor eligió al facturar, pero son
    // solo informativos: no descuentan lotes.cantidad ni stock_ubicaciones,
    // y la Guía de Despacho puede terminar despachando de un lote distinto
    // si el elegido aquí ya no tiene stock al momento de despachar.
    for (const l of _ventaLineas) {
      await addDetalleVenta({
        venta_id:         venta.id,
        item_id:          l.item_id,
        lote_id:          l.lote_id,
        ubicacion_id:     l.ubicacion_id,
        descripcion:      l.descripcion,
        unidad_medida:    l.unidad_medida,
        cantidad:         l.cantidad,
        cantidad_unidades: l.cantidad_unidades || 0,
        precio_unitario:  l.precio_unitario,
        subtotal:         l.subtotal,
        tipo_base:        l.tipo_base,
        igv_porcentaje:   l.igv_porcentaje,
        igv_monto:        l.igv_monto,
        total_linea:      l.total_linea,
        costo_unitario:   l.costo_unitario
      })
    }

    // Crear CxC automáticamente
    if (tipoComp === '01') {
      try {
        const cxc = await addCuentaCobrar({
          contact_id:          contactId,
          venta_id:            venta.id,
          tipo_comprobante:    tipoComp,
          serie,
          numero_comprobante:  correlativo,
          fecha_emision:       fechaEmision,
          // La fecha de vencimiento del documento es la de la ÚLTIMA cuota:
          // es el momento en que la deuda queda totalmente exigible.
          fecha_vencimiento:   cronograma?.cuotas?.length
            ? cronograma.cuotas[cronograma.cuotas.length - 1].fecha_vencimiento
            : (fechaVenc || null),
          moneda,
          tipo_cambio:         tipoCambio,
          monto_total:         parseFloat(total.toFixed(2)),
          monto_cobrado:       0,
          estado:              'pendiente',
          termino_pago_id:     cronograma?.terminoId || null,
          cronograma_personalizado: !!cronograma?.personalizado
        })

        // Cuotas: el cronograma real. Si falla alguna, la venta NO se revierte
        // — la factura ya está emitida y es lo crítico; las cuotas se pueden
        // regenerar después desde Cuentas x Cobrar.
        if (cxc?.id) await _guardarCuotasDeCxC(cxc.id, cronograma)
      } catch (eCxC) {
        console.warn('Venta creada pero CxC falló:', eCxC.message)
      }
    }

    showToast(`Venta ${serie}-${String(correlativo).padStart(8,'0')} creada ✅`, 'success')
    window.closeModal('modal-nueva-venta')
    _ventaLineas = []
    const descEl = document.getElementById('ventaDescripcion')
    const obsEl  = document.getElementById('ventaObservaciones')
    if (descEl) descEl.value = ''
    if (obsEl)  obsEl.value  = ''

    await renderVentas(true)
  } catch (e) {
    console.error('guardarNuevaVenta:', e)
    showToast('Error: ' + e.message, 'danger')
  }
}

// ============================================================================
// IMPORTAR VENTAS MASIVAS (desde Excel/CSV)
// ============================================================================
// Varias filas con el mismo numero_documento forman UNA venta con varias
// líneas. A diferencia de "Nueva Venta" (que reparte el consumo entre varios
// lotes por FIFO), cada línea importada trae su lote y zona EXACTOS —
// mismo criterio que Traslado Interno: si no alcanza el stock ahí, la fila
// falla en vez de buscar stock en otro lado.

window.abrirModalImportarVentas = function () {
  const input = document.getElementById('fileImportarVentas')
  if (input) input.value = ''
  const resumen = document.getElementById('importar-ventas-resumen')
  const log = document.getElementById('importar-ventas-log')
  if (resumen) resumen.innerHTML = ''
  if (log) log.innerHTML = ''
  window.openModal('modal-importar-ventas')
}

async function _leerArchivoImportVentas(file) {
  const XLSX = await import('https://cdn.jsdelivr.net/npm/xlsx@0.18.5/+esm')
  const buffer = await file.arrayBuffer()
  const wb = XLSX.read(buffer, { type: 'array', cellDates: true })
  const primeraHoja = wb.SheetNames[0]
  const ws = wb.Sheets[primeraHoja]
  return XLSX.utils.sheet_to_json(ws, { defval: null, raw: true })
}

function _parseFechaImportVentas(valor) {
  if (!valor) return null
  if (valor instanceof Date) return valor.toISOString().slice(0, 10)
  const s = String(valor).trim()
  if (/^\d+(\.\d+)?$/.test(s)) {
    const excelEpoch = new Date(Date.UTC(1899, 11, 30))
    const d = new Date(excelEpoch.getTime() + parseFloat(s) * 86400000)
    return d.toISOString().slice(0, 10)
  }
  const isoMatch = s.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (isoMatch) return `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`
  const dmyMatch = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/)
  if (dmyMatch) return `${dmyMatch[3]}-${dmyMatch[2].padStart(2, '0')}-${dmyMatch[1].padStart(2, '0')}`
  return null
}

window.procesarImportacionVentas = async function () {
  const btn = document.getElementById('btnProcesarImportarVentas')
  const input = document.getElementById('fileImportarVentas')
  const resumenEl = document.getElementById('importar-ventas-resumen')
  const logEl = document.getElementById('importar-ventas-log')
  if (btn?.disabled) return

  const file = input?.files?.[0]
  if (!file) { showToast('Selecciona un archivo primero', 'warning'); return }

  try {
    if (btn) { btn.disabled = true; btn.textContent = 'Procesando...' }
    if (resumenEl) resumenEl.innerHTML = '<p style="color:var(--text-secondary);">Leyendo archivo...</p>'
    if (logEl) logEl.innerHTML = ''

    const user = await getCurrentUser()
    if (!user) { showToast('Usuario no autenticado', 'danger'); return }

    let filas
    try {
      filas = await _leerArchivoImportVentas(file)
    } catch (e) {
      console.error('Error leyendo archivo de importación:', e)
      if (resumenEl) resumenEl.innerHTML = '<p style="color:var(--color-danger);">No se pudo leer el archivo. Verifica que sea un .xlsx o .csv válido.</p>'
      return
    }

    if (!filas || filas.length === 0) {
      if (resumenEl) resumenEl.innerHTML = '<p style="color:var(--color-danger);">El archivo no tiene filas de datos.</p>'
      return
    }

    const [clientes, items, lotes, ubicaciones, almacenes, terminos] = await Promise.all([
      getCustomers(), getItems(), getLotes(), getUbicaciones(), getAlmacenes(), getTerminosConCuotas()
    ])
    // Término "Contado" del catálogo: es el fallback cuando la columna
    // termino_pago viene vacía o dice literalmente "CONTADO".
    const terminoContado = terminos.find(t => t.tipo === 'contado') || null
    const clientesPorRuc = new Map(clientes.filter(c => c.nro_documento).map(c => [String(c.nro_documento).trim(), c]))
    const itemsBySku = new Map(items.filter(i => i.sku).map(i => [String(i.sku).trim(), i]))
    const lotesByNumero = new Map(lotes.map(l => [String(l.numero_lote).trim(), l]))
    const almacenesById = new Map(almacenes.map(a => [a.id, a]))
    // Solo zonas de almacenes REALES (no la virtual "Partners") son válidas como origen.
    const zonasRealesByCodigo = new Map(
      ubicaciones.filter(u => !almacenesById.get(u.almacen_id)?.es_virtual).map(u => [String(u.codigo).trim(), u])
    )

    // La importación masiva crea venta + detalle_ventas con el lote/zona del
    // Excel (informativo, igual que al facturar manualmente) pero NO mueve
    // stock ni kardex — eso lo hace después, manual, la Guía de Despacho de
    // Venta. Sí se VALIDA contra el stock real (lote+zona exacto, igual que
    // un traslado) para no facturar algo que ya no hay: se reserva
    // localmente por si dos filas del archivo comparten lote+zona.
    _lotes = lotes
    _lotesMap = {}
    for (const lo of (_lotes || [])) _lotesMap[lo.id] = lo
    let stockLocal = (await getStockUbicaciones()).map(s => ({ ...s }))
    _stockUbic = stockLocal

    const grupos = new Map()
    filas.forEach((fila, idx) => {
      const numRaw = fila.numero_documento ?? fila.numeroDocumento
      const num = numRaw != null ? String(numRaw).trim() : ''
      if (!grupos.has(num)) grupos.set(num, [])
      grupos.get(num).push({ fila, numFila: idx + 2 })
    })

    let ok = 0, fallidas = 0
    const logLineas = []

    for (const [numeroDocumento, filasGrupo] of grupos) {
      if (!numeroDocumento) {
        fallidas += filasGrupo.length
        logLineas.push(`Fila ${filasGrupo[0].numFila}: falta "numero_documento".`)
        continue
      }

      const primera = filasGrupo[0].fila
      const rucRaw = primera.cliente_ruc ?? primera.clienteRuc
      const ruc = rucRaw != null ? String(rucRaw).trim() : ''
      const cliente = clientesPorRuc.get(ruc)
      if (!ruc || !cliente) {
        fallidas += filasGrupo.length
        logLineas.push(`Venta "${numeroDocumento}": cliente RUC/DNI "${ruc}" no existe.`)
        continue
      }

      const fecha = _parseFechaImportVentas(primera.fecha_emision ?? primera.fechaEmision)
      if (!fecha) {
        fallidas += filasGrupo.length
        logLineas.push(`Venta "${numeroDocumento}": fecha inválida.`)
        continue
      }

      const tipoComprobante = String(primera.tipo_comprobante ?? primera.tipoComprobante ?? '01').trim()
      if (!['01', '03', '07', '08'].includes(tipoComprobante)) {
        fallidas += filasGrupo.length
        logLineas.push(`Venta "${numeroDocumento}": tipo_comprobante "${tipoComprobante}" inválido (usa 01, 03, 07 u 08).`)
        continue
      }

      const moneda = (primera.moneda || 'PEN').toString().trim().toUpperCase()
      const tipoCambio = moneda === 'USD' ? (parseFloat(primera.tipo_cambio ?? primera.tipoCambio) || 1) : 1

      // Validar cada línea: SKU, lote, zona real, stock exacto disponible
      // (no mueve nada, solo valida y reserva localmente para el resto del archivo).
      const lineas = []
      let grupoValido = true
      for (const { fila, numFila } of filasGrupo) {
        const skuRaw = fila.sku ?? fila.SKU
        const sku = skuRaw != null ? String(skuRaw).trim() : ''
        const loteRaw = fila.numero_lote ?? fila.numeroLote
        const numeroLote = loteRaw != null ? String(loteRaw).trim() : ''
        const zonaRaw = fila.zona_origen ?? fila.zonaOrigen
        const zonaCod = zonaRaw != null ? String(zonaRaw).trim() : ''
        const cantidad = parseFloat(fila.cantidad)
        const precioUnitario = parseFloat(fila.precio_unitario ?? fila.precioUnitario)
        const igvPorcentaje = parseFloat(fila.igv_porcentaje ?? fila.igvPorcentaje ?? 18)
        // cantidad_unidades es opcional en el archivo: si no viene, se
        // estima con el peso_por_unidad del lote (cuando el lote lo tiene
        // calculado). Si el lote no trackea unidades, queda en 0.
        const unidadesRaw = fila.cantidad_unidades ?? fila.unidades
        let cantidadUnidades = unidadesRaw != null && unidadesRaw !== '' ? parseFloat(unidadesRaw) : NaN

        const item = itemsBySku.get(sku)
        const lote = lotesByNumero.get(numeroLote)
        const zona = zonasRealesByCodigo.get(zonaCod)

        if (!sku || !item) { logLineas.push(`Fila ${numFila}: SKU "${sku}" no existe.`); grupoValido = false; continue }
        if (!numeroLote || !lote) { logLineas.push(`Fila ${numFila}: lote "${numeroLote}" no existe.`); grupoValido = false; continue }
        if (lote.item_id !== item.id) { logLineas.push(`Fila ${numFila}: lote "${numeroLote}" no pertenece al SKU "${sku}".`); grupoValido = false; continue }
        if (!zonaCod || !zona) { logLineas.push(`Fila ${numFila}: zona origen "${zonaCod}" no existe o no es una zona real.`); grupoValido = false; continue }
        if (!cantidad || cantidad <= 0) { logLineas.push(`Fila ${numFila}: cantidad inválida.`); grupoValido = false; continue }
        if (isNaN(precioUnitario) || precioUnitario < 0) { logLineas.push(`Fila ${numFila}: precio unitario inválido.`); grupoValido = false; continue }

        if (isNaN(cantidadUnidades)) {
          cantidadUnidades = (lote.peso_por_unidad && lote.peso_por_unidad > 0)
            ? parseFloat((cantidad / lote.peso_por_unidad).toFixed(2))
            : 0
        }

        const filaStock = stockLocal.find(s => s.lote_id === lote.id && s.ubicacion_id === zona.id)
        const disponible = parseFloat(filaStock?.cantidad || 0)
        const disponibleUnid = parseFloat(filaStock?.cantidad_unidades || 0)
        if (!filaStock || cantidad > disponible) {
          logLineas.push(`Fila ${numFila}: stock insuficiente en "${zonaCod}" para lote "${numeroLote}" (disponible ${disponible.toLocaleString('en-US', { maximumFractionDigits: 2 })}).`)
          grupoValido = false
          continue
        }
        if (cantidadUnidades > 0 && cantidadUnidades > disponibleUnid) {
          logLineas.push(`Fila ${numFila}: unidades insuficientes en "${zonaCod}" para lote "${numeroLote}" (disponible ${disponibleUnid.toLocaleString('en-US', { maximumFractionDigits: 2 })} und).`)
          grupoValido = false
          continue
        }

        const subtotal = parseFloat((cantidad * precioUnitario).toFixed(2))
        const igvMonto = parseFloat((subtotal * igvPorcentaje / 100).toFixed(2))
        const totalLinea = parseFloat((subtotal + igvMonto).toFixed(2))

        // Reserva local: esta cantidad ya no está disponible para la
        // siguiente fila del archivo que use el mismo lote+zona (no se
        // escribe en la BD, es solo para no sobrevender dentro del mismo
        // archivo importado).
        filaStock.cantidad = parseFloat((disponible - cantidad).toFixed(4))
        filaStock.cantidad_unidades = parseFloat((disponibleUnid - cantidadUnidades).toFixed(4))

        lineas.push({
          item_id: item.id,
          lote_id: lote.id,
          ubicacion_id: zona.id,
          descripcion: item.nombre,
          unidad_medida: item.unidad_medida || 'UND',
          cantidad,
          cantidad_unidades: cantidadUnidades,
          precio_unitario: precioUnitario,
          subtotal,
          tipo_base: igvPorcentaje > 0 ? 'gravada' : 'exonerada',
          igv_porcentaje: igvPorcentaje,
          igv_monto: igvMonto,
          total_linea: totalLinea,
          costo_unitario: parseFloat(lote.costo_unitario || 0)
        })
      }

      if (!grupoValido || lineas.length === 0) {
        fallidas += filasGrupo.length
        continue
      }

      try {
        const base = lineas.reduce((s, l) => s + l.subtotal, 0)
        const igv = lineas.reduce((s, l) => s + l.igv_monto, 0)
        const total = lineas.reduce((s, l) => s + l.total_linea, 0)
        const [serieV, correlativoV] = numeroDocumento.includes('-')
          ? numeroDocumento.split(/-(.+)/)
          : [null, numeroDocumento]

        // Término de pago: se interpreta el texto libre de la columna
        // termino_pago (ej. "CONTADO", "45 DIAS", "60-75-90 DIAS", tal cual
        // viene de Odoo). Si la columna no viene o el texto no trae ningún
        // número reconocible, se usa el término habitual del cliente y, si
        // tampoco tiene uno asignado, Contado.
        const terminoTexto = primera.termino_pago ?? primera.terminoPago ?? ''
        let crono = cronogramaDesdeTexto(terminoTexto, total, fecha, terminoContado)
        if (!crono) {
          const terminoCliente = terminos.find(x => x.id === cliente.termino_pago_id)
          crono = {
            cuotas: generarCronograma(terminoCliente || terminoContado, total, fecha),
            terminoId: cliente.termino_pago_id || terminoContado?.id || null,
            personalizado: false
          }
          if (terminoTexto) {
            logLineas.push(`Venta "${numeroDocumento}": término de pago "${terminoTexto}" no reconocido, se usó ${terminoCliente ? terminoCliente.nombre : 'Contado'}.`)
          }
        }
        const fechaVencCrono = crono.cuotas[crono.cuotas.length - 1].fecha_vencimiento

        const venta = await addVenta({
          numero:           numeroDocumento,
          tipo_comprobante: tipoComprobante,
          serie:            serieV,
          correlativo:      correlativoV,
          contact_id:       cliente.id,
          fecha_emision:    fecha,
          fecha_vencimiento: fechaVencCrono,
          periodo_contable: fecha.slice(0, 7),
          moneda,
          tipo_cambio:      tipoCambio,
          base_imponible:   parseFloat(base.toFixed(2)),
          igv:              parseFloat(igv.toFixed(2)),
          total:            parseFloat(total.toFixed(2)),
          estado:           'emitida',
          estado_pago:      'pendiente',
          cpe_estado:       'no_enviado',
          descripcion:      `Venta importada - ${cliente.nombre || ''}`,
          observaciones:    null,
          termino_pago_id:  crono.terminoId,
          cronograma_personalizado: crono.personalizado,
          created_by:       user.db_id
        })

        if (!venta?.id) {
          fallidas += filasGrupo.length
          logLineas.push(`Venta "${numeroDocumento}": no se pudo registrar (¿número duplicado?).`)
          continue
        }

        // Venta + detalle_ventas con lote/zona del Excel (informativo, ya
        // validado arriba contra stock real) — sin tocar stock/kardex. El
        // despacho real se hace después, manual, en la Guía de Despacho.
        for (const l of lineas) {
          await addDetalleVenta({
            venta_id: venta.id,
            lote_id: l.lote_id,
            ubicacion_id: l.ubicacion_id,
            item_id: l.item_id,
            descripcion: l.descripcion,
            unidad_medida: l.unidad_medida,
            cantidad: l.cantidad,
            cantidad_unidades: l.cantidad_unidades || 0,
            precio_unitario: l.precio_unitario,
            subtotal: l.subtotal,
            tipo_base: l.tipo_base,
            igv_porcentaje: l.igv_porcentaje,
            igv_monto: l.igv_monto,
            total_linea: l.total_linea,
            costo_unitario: l.costo_unitario
          })
        }

        if (tipoComprobante === '01') {
          try {
            const cxc = await addCuentaCobrar({
              contact_id:          cliente.id,
              venta_id:            venta.id,
              tipo_comprobante:    tipoComprobante,
              serie:               serieV,
              numero_comprobante:  correlativoV,
              fecha_emision:       fecha,
              fecha_vencimiento:   fechaVencCrono,
              moneda,
              tipo_cambio:         tipoCambio,
              monto_total:         parseFloat(total.toFixed(2)),
              monto_cobrado:       0,
              estado:              'pendiente',
              termino_pago_id:     crono.terminoId,
              cronograma_personalizado: crono.personalizado
            })
            if (cxc?.id) await _guardarCuotasDeCxC(cxc.id, crono)
          } catch (eCxC) {
            console.warn(`Venta ${numeroDocumento} creada pero CxC falló:`, eCxC.message)
          }
        }

        ok += filasGrupo.length
      } catch (e) {
        console.error(`Error importando venta ${numeroDocumento}:`, e)
        fallidas += filasGrupo.length
        logLineas.push(`Venta "${numeroDocumento}": error inesperado al procesar (ver consola).`)
      }
    }

    if (resumenEl) {
      resumenEl.innerHTML = `
        <div style="display:flex; gap:20px;">
          <div><strong style="color:var(--color-success);">${ok}</strong> líneas importadas</div>
          <div><strong style="color:${fallidas > 0 ? 'var(--color-danger)' : 'var(--text-secondary)'};">${fallidas}</strong> filas con error</div>
        </div>`
    }
    if (logEl) {
      logEl.innerHTML = logLineas.length > 0
        ? `<ul style="margin:0; padding-left:18px; color:var(--color-danger);">${logLineas.map(l => `<li>${l}</li>`).join('')}</ul>`
        : ''
    }

    if (ok > 0) {
      showToast(`Ventas importadas correctamente (${ok} línea(s)).`, 'success')
      await renderVentas(true)
    }
    if (fallidas > 0 && ok === 0) {
      showToast('No se pudo importar ninguna fila. Revisa el detalle de errores.', 'danger')
    }
  } catch (error) {
    console.error('Error en procesarImportacionVentas:', error)
    showToast('Error al procesar la importación', 'danger')
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Procesar Importación' }
  }
}

// ============================================================================
// CPE — Emitir Comprobante Electrónico con NUBEFACT
// ============================================================================

window.emitirCPEVenta = async function(ventaId) {
  try {
    const venta   = await getVentaById(ventaId)
    const lineas  = await getDetalleVentas(ventaId)
    const cliente = await getContactById(venta.contact_id)

    // Construir datos del cliente para NUBEFACT
    const ventaConCliente = {
      ...venta,
      cliente_tipo_doc:   cliente?.tipo_documento === 'RUC' ? '6' : '1',
      cliente_doc:        cliente?.ruc || cliente?.dni || '',
      cliente_nombre:     cliente?.razon_social || cliente?.nombre || '',
      cliente_direccion:  cliente?.direccion || '',
      cliente_email:      cliente?.email || ''
    }

    showToast('Emitiendo CPE con NUBEFACT...', 'info')

    const resultado = await emitirCPE(ventaConCliente, lineas, null)

    if (!resultado.ok) {
      showToast('Error NUBEFACT: ' + resultado.error, 'danger')
      await updateVenta(ventaId, { cpe_estado: 'rechazado' })
      return
    }

    await updateVenta(ventaId, {
      cpe_estado:       'aceptado',
      nubefact_id:      resultado.nubefact_id,
      nubefact_enlace:  resultado.enlace_pdf,
      nubefact_qr:      resultado.qr,
      nubefact_hash:    resultado.hash,
      xml_url:          resultado.enlace_xml,
      pdf_url:          resultado.enlace_pdf
    })

    showToast('CPE emitido y aceptado por SUNAT ✅', 'success')
    await renderVentas(true)
  } catch (e) {
    console.error('emitirCPEVenta:', e)
    showToast('Error al emitir CPE: ' + e.message, 'danger')
  }
}

// ============================================================================
// GENERAR ASIENTO DE VENTA
// ============================================================================

window.generarAsientoDeVenta = async function(ventaId) {
  try {
    const user = await getCurrentUser()
    await generarAsientoVenta(ventaId, user?.id)
    showToast('Asiento contable generado ✅', 'success')
    await renderVentas(true)
  } catch (e) {
    showToast('Error al generar asiento: ' + e.message, 'danger')
  }
}

// ============================================================================
// TAB: COTIZACIONES (legacy — se mantiene funcional)
// ============================================================================

async function renderCotizaciones() {
  try {
    const cotizaciones = await getSalesQuotes()
    const container    = document.getElementById('tabla-cot')
    if (!container) return

    if (!cotizaciones || cotizaciones.length === 0) {
      container.innerHTML = '<p style="text-align:center; color:var(--text-secondary); padding:20px;">Sin cotizaciones</p>'
      return
    }

    let html = `
      <table>
        <thead>
          <tr>
            <th>Número</th><th>Cliente</th><th>Moneda</th>
            <th style="text-align:right;">Total</th>
            <th>Estado</th><th>Acciones</th>
          </tr>
        </thead>
        <tbody>
    `

    for (const cot of cotizaciones.sort((a,b) => b.id - a.id)) {
      const cliente = await _nombreCliente(cot.customer_id || cot.contact_id)
      html += `<tr>
        <td><strong>${cot.numero || cot.id}</strong></td>
        <td>${cliente}</td>
        <td>${cot.currency || cot.moneda || 'PEN'}</td>
        <td style="text-align:right;">${parseFloat(cot.total || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
        <td><span class="badge badge-${cot.status === 'confirmado' ? 'success' : 'secondary'}">${cot.status || 'borrador'}</span></td>
        <td>
          <button class="btn btn-small btn-secondary" onclick="window.verCotizacion(${cot.id})">Ver</button>
          ${cot.status !== 'confirmado' ? `<button class="btn btn-small btn-primary" onclick="window.confirmarCotizacion(${cot.id})">Confirmar</button>` : ''}
        </td>
      </tr>`
    }

    html += '</tbody></table>'
    container.innerHTML = html
  } catch (error) {
    console.error('renderCotizaciones:', error)
    showToast('Error al cargar cotizaciones', 'danger')
  }
}

window.verCotizacion = async function(id) {
  try {
    const cot     = await getSalesQuoteById(id)
    if (!cot) { showToast('No encontrada', 'warning'); return }
    const cliente = await _nombreCliente(cot.customer_id || cot.contact_id)
    alert(`COT #${cot.numero || cot.id}
Cliente: ${cliente}
Cantidad: ${formatQty(cot.cantidad || 0)}
Precio Unitario: ${cot.currency || 'PEN'} ${formatNumber(cot.precio_unitario)}
Subtotal: ${formatNumber(cot.subtotal)}
IGV: ${formatNumber(cot.igv)}
Total: ${formatNumber(cot.total)}
Estado: ${cot.status || '-'}`)
  } catch (e) {
    showToast('Error: ' + e.message, 'danger')
  }
}

window.confirmarCotizacion = async function(id) {
  try {
    if (!confirm('¿Confirmar esta cotización? Se generarán asientos contables y se actualizará el stock.')) return

    const user = await getCurrentUser()
    const cot  = await getSalesQuoteById(id)
    if (!cot) { showToast('No encontrada', 'warning'); return }
    if (cot.status === 'confirmado') { showToast('Ya fue confirmada', 'warning'); return }

    const cliente  = await _nombreCliente(cot.customer_id || cot.contact_id)
    const moneda   = cot.currency || 'PEN'
    const tieneLote = !!cot.lote_id

    // Asiento de venta
    const { lineas } = await aplicarModelo({
      tipoMovimiento: 'Venta',
      tipoDocumento:  cot.tipo_pago === 'contado' ? '03' : '01',
      moneda,
      nombre:         tieneLote ? `Venta mercadería ${cot.tipo_pago || 'credito'}` : 'Venta servicio crédito',
      datos: {
        subtotal: cot.subtotal || 0,
        igv:      cot.igv      || 0,
        total:    cot.total    || 0,
        monto:    cot.total    || 0,
        tipo_pago: cot.tipo_pago || 'credito'
      }
    })

    await crearAsientoContable({
      fecha:                cot.fecha || new Date().toISOString().split('T')[0],
      descripcion:          `Venta ${cot.numero || cot.id} a ${cliente}`,
      documento_referencia: cot.numero || `COT-${cot.id}`,
      tipo_movimiento:      'Venta',
      tipo_documento:       cot.tipo_pago === 'contado' ? '03' : '01',
      contact_id:           cot.customer_id || cot.contact_id,
      created_by:           user?.db_id,
      lineas
    })

    // Costo de venta y stock si tiene lote
    if (tieneLote) {
      const lote = await getLoteById(cot.lote_id)
      if (lote) {
        const costoTotal = parseFloat(((lote.costo_unitario || 0) * (cot.cantidad || 0)).toFixed(2))
        if (costoTotal > 0) {
          await crearAsientoContable({
            fecha:                cot.fecha || new Date().toISOString().split('T')[0],
            descripcion:          `Costo venta ${cot.numero || cot.id}`,
            documento_referencia: cot.numero || `COT-${cot.id}`,
            tipo_movimiento:      'CostoVenta',
            tipo_documento:       'Interno',
            contact_id:           cot.customer_id || cot.contact_id,
            created_by:           user?.db_id,
            lineas: [
              { cuenta_codigo: '69111', debe: costoTotal, haber: 0,          descripcion: `Costo venta ${cot.numero || cot.id}` },
              { cuenta_codigo: '20111', debe: 0,          haber: costoTotal, descripcion: `Salida mercadería venta ${cot.numero || cot.id}` }
            ]
          })
        }
        await updateLote(lote.id, { cantidad: Math.max(0, (lote.cantidad || lote.stock || 0) - (cot.cantidad || 0)) })
      }
    }

    await updateSalesQuote(id, { status: 'confirmado' })
    showToast('Cotización confirmada ✅ Asientos generados', 'success')
    await renderCotizaciones()
  } catch (e) {
    console.error('confirmarCotizacion:', e)
    showToast('Error: ' + e.message, 'danger')
  }
}

window.guardarCotizacion = async function() {
  try {
    const user       = await getCurrentUser()
    const customerId = parseInt(document.getElementById('cotCliente')?.value || 0)
    const loteId     = parseInt(document.getElementById('cotLote')?.value || 0)
    const cantidad   = parseInt(document.getElementById('cotCantidad')?.value || 0)
    const igvPct     = parseInt(document.getElementById('cotIGV')?.value || 18)
    const moneda     = document.getElementById('cotMoneda')?.value || 'PEN'
    const tipoPago   = document.getElementById('cotTipoPago')?.value || 'credito'

    if (!customerId || !loteId || !cantidad) {
      showToast('Complete todos los campos', 'warning')
      return
    }

    const lote = _lotes.find(l => l.id === loteId)
    if (!lote) { showToast('Lote no encontrado', 'warning'); return }

    const precioUnitario = parseFloat(lote.costo_unitario || 0)
    const subtotal       = parseFloat((cantidad * precioUnitario).toFixed(2))
    const igvAmount      = parseFloat((subtotal * igvPct / 100).toFixed(2))
    const total          = parseFloat((subtotal + igvAmount).toFixed(2))

    await addSalesQuote({
      customer_id: customerId, lote_id: loteId, cantidad,
      precio_unitario: precioUnitario, igv: igvAmount, subtotal, total,
      currency: moneda, tipo_pago: tipoPago, status: 'borrador',
      user: user?.nombre || user?.email,
      fecha: new Date().toISOString().split('T')[0]
    })

    showToast('Cotización creada', 'success')
    window.closeModal('modal-nueva-cot')
    await renderCotizaciones()
    const form = document.getElementById('formNewCot')
    if (form) form.reset()
  } catch (e) {
    console.error('guardarCotizacion:', e)
    showToast('Error: ' + e.message, 'danger')
  }
}

// ============================================================================
// TAB: CLIENTES
// ============================================================================

// Paginación: 50 clientes por página, con caché para no re-consultar la BD
const CLI_POR_PAGINA = getModuloConfig('ventas').itemsPorPagina || 50
let _cliPagina = 1
let _cliLista = null
let _cliEditandoId = null   // null = modo crear, id = modo editar

async function renderClientes(forzar = false) {
  try {
    const container = document.getElementById('tabla-clientes')
    if (!container) return

    if (!_cliLista || forzar) {
      _cliLista = await getCustomers()
      _cliPagina = 1
    }

    // Búsqueda en vivo (contiene, sobre la lista ya cacheada — sin red)
    const busqueda = (document.getElementById('buscarCliente')?.value || '').trim().toLowerCase()
    const clientes = busqueda
      ? _cliLista.filter(c => `${c.nombre || ''} ${c.nro_documento || ''}`.toLowerCase().includes(busqueda))
      : _cliLista

    if (!clientes || clientes.length === 0) {
      container.innerHTML = `<p style="text-align:center; color:var(--text-secondary); padding:20px;">${busqueda ? 'Sin resultados para la búsqueda' : 'Sin clientes'}</p>`
      return
    }

    const totalPaginas = Math.max(1, Math.ceil(clientes.length / CLI_POR_PAGINA))
    if (_cliPagina > totalPaginas) _cliPagina = totalPaginas
    if (_cliPagina < 1) _cliPagina = 1
    const inicio = (_cliPagina - 1) * CLI_POR_PAGINA
    const pagina = clientes.slice(inicio, inicio + CLI_POR_PAGINA)

    const paginador = `
      <div style="display:flex; justify-content:space-between; align-items:center; padding:12px 16px;">
        <span style="color:var(--text-secondary); font-size:0.85rem;">
          Mostrando ${inicio + 1}–${inicio + pagina.length} de ${clientes.length} clientes
        </span>
        <div style="display:flex; gap:8px; align-items:center;">
          <button class="btn btn-small btn-secondary" onclick="window.cambiarPaginaClientes(-1)" ${_cliPagina <= 1 ? 'disabled' : ''}>← Anterior</button>
          <span style="font-size:0.85rem;">Página ${_cliPagina} de ${totalPaginas}</span>
          <button class="btn btn-small btn-secondary" onclick="window.cambiarPaginaClientes(1)" ${_cliPagina >= totalPaginas ? 'disabled' : ''}>Siguiente →</button>
        </div>
      </div>
    `

    let html = paginador + `<table>
      <thead>
        <tr>
          <th>Nombre</th><th>Nro Documento</th><th>Email</th>
          <th>Teléfono</th><th>Dirección</th><th>Estado</th><th>Acciones</th>
        </tr>
      </thead>
      <tbody>`

    pagina.forEach(c => {
      html += `<tr>
        <td><strong>${c.nombre || c.razon_social || '-'}</strong></td>
        <td>${c.nro_documento || '-'}</td>
        <td>${c.email || '-'}</td>
        <td>${c.telefono || c.numero || '-'}</td>
        <td style="font-size:0.82rem;">${c.direccion || '-'}</td>
        <td><span class="badge badge-${c.activo === false ? 'danger' : 'success'}">${c.activo === false ? 'Inactivo' : 'Activo'}</span></td>
        <td>
          <button class="btn btn-small btn-secondary" onclick="window.editarCliente(${c.id})">Editar</button>
          <button class="btn btn-small btn-danger" onclick="window.eliminarCliente(${c.id})">Eliminar</button>
        </td>
      </tr>`
    })

    html += '</tbody></table>' + paginador
    container.innerHTML = html
  } catch (e) {
    console.error('renderClientes:', e)
    showToast('Error al cargar clientes', 'danger')
  }
}

window.cambiarPaginaClientes = async function (delta) {
  _cliPagina += delta
  await renderClientes()  // usa caché, solo cambia de página
}

window.filtrarClientes = async function () {
  _cliPagina = 1  // cada nueva búsqueda vuelve a la página 1
  await renderClientes()  // usa caché, solo re-filtra (sin red)
}

function _resetModalCliente() {
  _cliEditandoId = null
  const titulo = document.getElementById('modalClienteTitle')
  if (titulo) titulo.textContent = 'Nuevo Cliente'
  const form = document.getElementById('formNewCliente')
  if (form) form.reset()
}

window.abrirFormularioCliente = function() {
  _resetModalCliente()
  window.openModal('modal-nuevo-cliente')
}

window.guardarCliente = async function() {
  try {
    const nombre    = document.getElementById('cliNombre')?.value?.trim()
    const ruc       = document.getElementById('cliRUC')?.value?.trim()
    const email     = document.getElementById('cliEmail')?.value?.trim()
    const phone     = document.getElementById('cliPhone')?.value?.trim()
    const sujetoRetencion = !!document.getElementById('cliSujetoRetencion')?.checked

    if (!nombre) { showToast('El nombre es requerido', 'warning'); return }
    if (!ruc)    { showToast('El RUC/documento es requerido', 'warning'); return }

    // Columnas reales de contacts (assets/sql/01_schema.sql): nombre,
    // tipo_documento, nro_documento, email, numero, direccion, distrito,
    // pais, tipo_contacto (text[]), sujeto_retencion (boolean). No existe
    // columna "moneda" ni "ciudad".
    const tipoDocumento = ruc.length === 11 ? 'RUC' : ruc.length === 8 ? 'DNI' : 'otro'

    const datos = {
      nombre:         nombre,
      tipo_documento: tipoDocumento,
      nro_documento:  ruc,
      email:          email || null,
      numero:         phone || '0',
      sujeto_retencion: sujetoRetencion
    }

    if (_cliEditandoId) {
      await updateContact(_cliEditandoId, datos)
      showToast('Cliente actualizado', 'success')
    } else {
      await addContact({ ...datos, tipo_contacto: ['cliente'] })
      showToast('Cliente creado exitosamente', 'success')
    }

    window.closeModal('modal-nuevo-cliente')
    _resetModalCliente()
    _poblarSelectClientes()
    await renderClientes(true)
  } catch (e) {
    console.error('guardarCliente:', e)
    showToast('Error: ' + e.message, 'danger')
  }
}

window.editarCliente = async function(id) {
  try {
    const c = await getContactById(id)
    if (!c) { showToast('Cliente no encontrado', 'warning'); return }

    document.getElementById('cliNombre').value = c.nombre || ''
    document.getElementById('cliRUC').value    = c.nro_documento || ''
    document.getElementById('cliEmail').value  = c.email || ''
    document.getElementById('cliPhone').value  = c.numero || ''
    const chkRet = document.getElementById('cliSujetoRetencion')
    if (chkRet) chkRet.checked = !!c.sujeto_retencion

    _cliEditandoId = id
    const titulo = document.getElementById('modalClienteTitle')
    if (titulo) titulo.textContent = `Editar Cliente #${id}`
    window.openModal('modal-nuevo-cliente')
  } catch (e) {
    console.error('editarCliente:', e)
    showToast('Error al editar cliente', 'danger')
  }
}

window.eliminarCliente = async function(id) {
  try {
    if (!confirm('¿Eliminar este cliente? Esta acción no se puede deshacer.')) return
    await deleteContact(id)
    showToast('Cliente eliminado', 'success')
    _poblarSelectClientes()
    await renderClientes(true)
  } catch (e) {
    console.error('eliminarCliente:', e)
    showToast('Error al eliminar cliente. Puede tener documentos asociados.', 'danger')
  }
}

// ============================================================================
// MODALES RÁPIDOS: PRODUCTO Y LOTE (accesibles desde el formulario de Cotización)
// ============================================================================

window.abrirFormularioProducto = function() {
  const form = document.getElementById('formNewProducto')
  if (form) form.reset()
  window.openModal('modal-nuevo-producto')
}

// items.categoria_id es NOT NULL (FK a categorias). Este modal rápido solo
// pide el nombre de la categoría como texto libre: se busca por nombre
// (case-insensitive) y si no existe se crea. Ver assets/sql/01_schema.sql.
async function _resolverCategoriaId(nombreCategoria) {
  const nombre = (nombreCategoria || '').trim()
  const categorias = await getCategorias()
  const buscar = (n) => categorias.find(c => (c.nombre || '').toLowerCase() === n.toLowerCase())

  if (nombre) {
    const existente = buscar(nombre)
    if (existente) return existente.id
    const nueva = await addCategoria({ nombre })
    if (nueva?.id) return nueva.id
  }

  // Fallback: categoría "General" (se crea si no existe todavía)
  const general = buscar('General')
  if (general) return general.id
  const nuevaGeneral = await addCategoria({ nombre: 'General' })
  return nuevaGeneral?.id || null
}

window.guardarProducto = async function() {
  try {
    const nombre      = document.getElementById('prodNombre')?.value?.trim()
    const sku         = document.getElementById('prodSKU')?.value?.trim()
    const descripcion = document.getElementById('prodDescripcion')?.value?.trim()
    const categoria   = document.getElementById('prodCategoria')?.value?.trim()
    const activo      = document.getElementById('prodActivo')?.value === 'true'

    if (!nombre || !sku) { showToast('Complete los campos requeridos (Nombre y SKU)', 'warning'); return }

    const categoriaId = await _resolverCategoriaId(categoria)

    await addItem({
      nombre,
      sku,
      descripcion:  descripcion || null,
      categoria_id: categoriaId,
      tipo_item:    'mercaderia',
      activo
    })

    showToast('Producto creado exitosamente', 'success')
    window.closeModal('modal-nuevo-producto')
    const form = document.getElementById('formNewProducto')
    if (form) form.reset()

    _items = await getItems()
    _poblarSelectItems()
  } catch (e) {
    console.error('guardarProducto:', e)
    showToast('Error: ' + e.message, 'danger')
  }
}

window.abrirFormularioLote = function() {
  const selLote = document.getElementById('loteProducto')
  if (selLote) {
    selLote.innerHTML = '<option value="">-- Selecciona --</option>' +
      _items.map(i => `<option value="${i.id}">${i.nombre}${i.sku ? ' (' + i.sku + ')' : ''}</option>`).join('')
  }
  const usuario = document.getElementById('loteUsuario')
  if (usuario) {
    getCurrentUser().then(u => { usuario.value = u?.nombre || u?.email || '' })
  }
  const form = document.getElementById('formNewLote')
  if (form) form.reset()
  window.openModal('modal-nuevo-lote')
}

window.guardarLote = async function() {
  try {
    const user = await getCurrentUser()
    if (!user) { showToast('Usuario no autenticado', 'danger'); return }

    const productId    = parseInt(document.getElementById('loteProducto')?.value || 0)
    const numeroLote    = document.getElementById('loteNumero')?.value?.trim()
    const stock         = parseFloat(document.getElementById('loteStock')?.value || 0)
    const costoUnitario = parseFloat(document.getElementById('loteCosto')?.value || 0)
    const costoDestino  = parseFloat(document.getElementById('loteDestino')?.value || 0)
    const fechaVenc     = document.getElementById('loteVencimiento')?.value || ''

    if (!productId || !numeroLote || !stock || !costoUnitario || !fechaVenc) {
      showToast('Complete todos los campos requeridos', 'warning')
      return
    }

    // Columnas reales de lotes: item_id, cantidad (no product_id/stock/costo_destino)
    await addLote({
      item_id:            productId,
      numero_lote:        numeroLote,
      cantidad:           stock,
      cantidad_unidades:  stock,
      costo_unitario:     costoUnitario,
      fecha_vencimiento:  fechaVenc || null,
      fecha_ingreso:      new Date().toISOString().split('T')[0],
      created_by:         user.db_id
    })

    showToast('Lote creado exitosamente', 'success')
    window.closeModal('modal-nuevo-lote')
    const form = document.getElementById('formNewLote')
    if (form) form.reset()

    _lotes = await getLotes()
    _poblarSelectLotes()
  } catch (e) {
    console.error('guardarLote:', e)
    showToast('Error: ' + e.message, 'danger')
  }
}

// ============================================================================
// TAB: GUÍAS DE DESPACHO DE VENTA (espejo exacto de Guías de Remisión en
// Compras, ver compras.js). La Venta solo registra el comprobante; recién
// acá se elige lote+zona real y se descuenta stock/kardex. Una venta puede
// despacharse en varias guías (envíos parciales) — cada línea de venta
// puede repartirse entre varios lotes/zonas ("despachos"), igual que en
// Compras una línea comprada puede recibirse en varias "recepciones".
// ============================================================================

let _guiaDespachoLineas = []   // [{ detalle_venta_id, item_id, nombre, unidad_medida, cantidad_vendida, cantidad_despachada_previa, despachos:[{cantidad, cantidad_unidades, ubicacion_id, lote_id, numero_lote}] }]
let _guiaDespachoZonasCache = []
let _guiasDespachoLista = null   // cache de guias_despacho_venta enriquecidas para el tab
let _ventasPendientesGuiaCache = null

/** Ventas con estado_despacho pendiente o parcial (candidatas a recibir una guía). */
async function _cargarVentasPendientesDespacho(forzar = false) {
  if (_ventasPendientesGuiaCache && !forzar) return _ventasPendientesGuiaCache
  const [ventas, clientes] = await Promise.all([getVentas(), getCustomers()])
  const clientesMap = {}
  for (const c of (clientes || [])) clientesMap[c.id] = c
  _ventasPendientesGuiaCache = (ventas || [])
    .filter(v => v.estado_despacho === 'pendiente' || v.estado_despacho === 'parcial')
    .map(v => ({ ...v, clienteNombre: clientesMap[v.contact_id]?.razon_social || clientesMap[v.contact_id]?.nombre || '-' }))
    .sort((a, b) => new Date(b.fecha_emision || 0) - new Date(a.fecha_emision || 0))
  return _ventasPendientesGuiaCache
}

/** Zonas reales (no virtuales) donde el ítem tiene stock > 0. */
function _zonasConStockItem(itemId) {
  const almacenesMap = {}
  for (const a of (_almacenes || [])) almacenesMap[a.id] = a
  const zonaIds = new Set(
    (_stockUbic || [])
      .filter(su => _lotesMap[su.lote_id]?.item_id === itemId && (parseFloat(su.cantidad) || 0) > 0)
      .map(su => su.ubicacion_id)
  )
  return (_zonas || [])
    .filter(z => zonaIds.has(z.id) && !almacenesMap[z.almacen_id]?.es_virtual)
    .map(z => ({ id: z.id, nombre: z.nombre, almacenNombre: almacenesMap[z.almacen_id]?.nombre || '?' }))
}

/** Lotes con stock > 0 del ítem en la zona elegida, más antiguos primero (FIFO sugerido). */
function _lotesConStockZona(itemId, zonaId) {
  return (_stockUbic || [])
    .filter(su => su.ubicacion_id === zonaId && _lotesMap[su.lote_id]?.item_id === itemId && (parseFloat(su.cantidad) || 0) > 0)
    .map(su => ({
      stock_ubicacion_id: su.id,
      lote_id: su.lote_id,
      numero_lote: _lotesMap[su.lote_id]?.numero_lote || '?',
      disponible: parseFloat(su.cantidad) || 0,
      disponibleUnid: parseFloat(su.cantidad_unidades) || 0
    }))
    .sort((a, b) => new Date(_lotesMap[a.lote_id]?.fecha_ingreso || 0) - new Date(_lotesMap[b.lote_id]?.fecha_ingreso || 0))
}

window.abrirModalNuevaGuiaDespacho = async function () {
  try {
    _guiaDespachoLineas = []
    const form = document.getElementById('formNuevaGuiaDespacho')
    if (form) form.reset()
    document.getElementById('gdInfoVenta').style.display = 'none'
    document.getElementById('gdFechaGuia').value = new Date().toISOString().split('T')[0]
    document.getElementById('tabla-detalle-guia-despacho').innerHTML =
      '<p style="text-align:center; color:var(--text-secondary); padding:20px;">Selecciona una venta para ver sus productos pendientes.</p>'

    const ventasPend = await _cargarVentasPendientesDespacho(true)
    const sel = document.getElementById('gdVenta')
    if (sel) {
      sel.innerHTML = '<option value="">-- Selecciona una venta pendiente/parcial --</option>' +
        ventasPend.map(v => `<option value="${v.id}">${v.serie || ''}-${String(v.correlativo || '').padStart(8,'0')} — ${v.clienteNombre} (${v.estado_despacho})</option>`).join('')
    }
    window.openModal('modal-nueva-guia-despacho')
  } catch (error) {
    console.error('Error en abrirModalNuevaGuiaDespacho:', error)
    showToast('Error al abrir el formulario de guía de despacho', 'danger')
  }
}

window.cerrarModalNuevaGuiaDespacho = function () {
  window.closeModal('modal-nueva-guia-despacho')
}

window.onSeleccionarVentaGuiaDespacho = async function () {
  try {
    const ventaId = parseInt(document.getElementById('gdVenta')?.value || 0)
    const infoDiv = document.getElementById('gdInfoVenta')
    const tablaDiv = document.getElementById('tabla-detalle-guia-despacho')

    if (!ventaId) {
      infoDiv.style.display = 'none'
      tablaDiv.innerHTML = '<p style="text-align:center; color:var(--text-secondary); padding:20px;">Selecciona una venta para ver sus productos pendientes.</p>'
      _guiaDespachoLineas = []
      return
    }

    const [venta, detalles, despachosVenta, almacenes] = await Promise.all([
      getVentaById(ventaId),
      getDetalleVentas(ventaId),
      getDetalleGuiasDespachoVentaByVenta(ventaId),
      getAlmacenes()
    ])

    const cliente = _clientes.find(c => c.id === venta?.contact_id)
    infoDiv.style.display = 'block'
    infoDiv.innerHTML = `
      <strong>Cliente:</strong> ${cliente?.razon_social || cliente?.nombre || '-'} &nbsp;|&nbsp;
      <strong>Comprobante:</strong> ${venta?.serie || ''}-${String(venta?.correlativo || '').padStart(8,'0')} &nbsp;|&nbsp;
      <strong>Fecha venta:</strong> ${venta?.fecha_emision || '-'} &nbsp;|&nbsp;
      <strong>Estado despacho:</strong> ${venta?.estado_despacho || 'pendiente'}
    `

    const almacenesMap = {}
    for (const a of (almacenes || [])) almacenesMap[a.id] = a
    _guiaDespachoZonasCache = (_zonas || [])
      .filter(z => !almacenesMap[z.almacen_id]?.es_virtual)
      .map(z => ({ id: z.id, nombre: z.nombre, almacen_id: z.almacen_id, almacenNombre: almacenesMap[z.almacen_id]?.nombre || `Almacén #${z.almacen_id}` }))

    // Ya despachado por cada detalle_venta_id (sumando sus guías previas).
    // Las guías ANULADAS no cuentan: su stock ya volvió a Inventario, así que
    // esa cantidad está otra vez pendiente de despachar.
    const guiasDeEstaVenta = (await getGuiasDespachoVenta(true) || []).filter(g => g.venta_id === ventaId)
    const anuladasIds = new Set(guiasDeEstaVenta.filter(g => g.estado === 'anulada').map(g => g.id))

    const despachadoPorDetalle = {}
    for (const d of (despachosVenta || [])) {
      if (anuladasIds.has(d.guia_id)) continue
      despachadoPorDetalle[d.detalle_venta_id] = (despachadoPorDetalle[d.detalle_venta_id] || 0) + (parseFloat(d.cantidad) || 0)
    }

    _guiaDespachoLineas = (detalles || [])
      .map(d => {
        const cantidadVendida = parseFloat(d.cantidad) || 0
        const yaDespachado = despachadoPorDetalle[d.id] || 0
        const pendiente = parseFloat((cantidadVendida - yaDespachado).toFixed(4))
        return {
          detalle_venta_id: d.id,
          item_id: d.item_id,
          nombre: d.descripcion || `Item #${d.item_id}`,
          unidad_medida: d.unidad_medida,
          cantidad_vendida: cantidadVendida,
          cantidad_despachada_previa: yaDespachado,
          cantidad_pendiente: pendiente,
          despachos: pendiente > 0 ? [{ cantidad: pendiente, cantidad_unidades: null, ubicacion_id: '', lote_id: '' }] : []
        }
      })
      .filter(l => l.cantidad_pendiente > 0)

    _renderTablaDetalleGuiaDespacho()
  } catch (error) {
    console.error('Error en onSeleccionarVentaGuiaDespacho:', error)
    showToast('Error al cargar el detalle de la venta', 'danger')
  }
}

function _sincronizarDespachosGuiaDesdeDOM() {
  _guiaDespachoLineas.forEach((l, idx) => {
    l.despachos.forEach((desp, subIdx) => {
      const cant = document.getElementById(`gd-${idx}-${subIdx}-cantidad`)
      const cantUnid = document.getElementById(`gd-${idx}-${subIdx}-unidades`)
      const zona = document.getElementById(`gd-${idx}-${subIdx}-zona`)
      const lote = document.getElementById(`gd-${idx}-${subIdx}-lote`)
      if (cant)     desp.cantidad = parseFloat(cant.value || 0)
      if (cantUnid) desp.cantidad_unidades = cantUnid.value !== '' ? parseFloat(cantUnid.value) : null
      if (zona)     desp.ubicacion_id = parseInt(zona.value || 0) || ''
      if (lote)     desp.lote_id = parseInt(lote.value || 0) || ''
    })
  })
}

window.agregarDespachoGuia = function (idx) {
  _sincronizarDespachosGuiaDesdeDOM()
  const l = _guiaDespachoLineas[idx]
  if (!l) return
  l.despachos.push({ cantidad: 0, cantidad_unidades: null, ubicacion_id: '', lote_id: '' })
  _renderTablaDetalleGuiaDespacho()
}

window.quitarDespachoGuia = function (idx, subIdx) {
  _sincronizarDespachosGuiaDesdeDOM()
  const l = _guiaDespachoLineas[idx]
  if (!l) return
  l.despachos.splice(subIdx, 1)
  _renderTablaDetalleGuiaDespacho()
}

/** Al elegir zona en una fila de despacho: repuebla el select de lote de ESA fila con los lotes que tienen stock ahí. */
window.onCambiarZonaDespachoGuia = function (idx, subIdx) {
  _sincronizarDespachosGuiaDesdeDOM()
  _renderTablaDetalleGuiaDespacho()
}

/** Al elegir lote en una fila de despacho: muestra su peso x unidad y sugiere N° de Unidades (editable) según cantidad/peso_por_unidad. */
window.onCambiarLoteDespachoGuia = function (idx, subIdx) {
  _sincronizarDespachosGuiaDesdeDOM()
  const l = _guiaDespachoLineas[idx]
  const desp = l?.despachos[subIdx]
  if (desp) {
    const lote = desp.lote_id ? _lotesMap[desp.lote_id] : null
    if (lote?.peso_por_unidad && lote.peso_por_unidad > 0) {
      desp.cantidad_unidades = parseFloat(((desp.cantidad || 0) / lote.peso_por_unidad).toFixed(2))
    }
  }
  _renderTablaDetalleGuiaDespacho()
}

/** Al cambiar la cantidad de una fila de despacho: re-sugiere N° de Unidades si el lote elegido trackea peso por unidad. */
window.onCambiarCantidadDespachoGuia = function (idx, subIdx) {
  _sincronizarDespachosGuiaDesdeDOM()
  const l = _guiaDespachoLineas[idx]
  const desp = l?.despachos[subIdx]
  if (desp) {
    const lote = desp.lote_id ? _lotesMap[desp.lote_id] : null
    if (lote?.peso_por_unidad && lote.peso_por_unidad > 0) {
      desp.cantidad_unidades = parseFloat(((desp.cantidad || 0) / lote.peso_por_unidad).toFixed(2))
    }
  }
  _renderTablaDetalleGuiaDespacho()
}

function _renderTablaDetalleGuiaDespacho() {
  const container = document.getElementById('tabla-detalle-guia-despacho')
  if (!container) return

  if (!_guiaDespachoLineas || _guiaDespachoLineas.length === 0) {
    container.innerHTML = '<p style="text-align:center; color:var(--text-secondary); padding:20px;">Esta venta no tiene productos pendientes de despacho.</p>'
    return
  }

  const zonaOptions = (_guiaDespachoZonasCache || [])
    .map(z => `<option value="${z.id}">${z.almacenNombre} — ${z.nombre}</option>`).join('')

  let html = ''
  _guiaDespachoLineas.forEach((l, idx) => {
    const totalDespachando = l.despachos.reduce((s, d) => s + (parseFloat(d.cantidad) || 0), 0)
    const colorTotal = Math.abs(totalDespachando - l.cantidad_pendiente) < 0.0001 ? 'var(--color-success)' : 'var(--color-warning)'

    html += `
      <div style="border:1px solid var(--border-color); border-radius:var(--radius-md); margin-bottom:14px; padding:12px;">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
          <strong>${l.nombre}</strong>
          <span style="font-size:0.85rem;">
            Vendido: ${formatQty(l.cantidad_vendida)} ${l.unidad_medida || ''} &nbsp;|&nbsp;
            Ya despachado: ${formatQty(l.cantidad_despachada_previa)} &nbsp;|&nbsp;
            Pendiente: ${formatQty(l.cantidad_pendiente)} &nbsp;|&nbsp;
            Despachando ahora: <strong style="color:${colorTotal};">${formatQty(totalDespachando)}</strong>
          </span>
        </div>
        <div style="overflow-x:auto;">
        <table style="min-width:760px;">
          <thead>
            <tr>
              <th>Cantidad (${l.unidad_medida || 'KG'}) *</th><th>Unidad</th><th>Peso x Unid.</th><th>N° de Unidades</th>
              <th>Almacén / Zona *</th><th>N° de Lote *</th><th></th>
            </tr>
          </thead>
          <tbody>
    `
    l.despachos.forEach((desp, subIdx) => {
      const lotesDeZona = desp.ubicacion_id ? _lotesConStockZona(l.item_id, desp.ubicacion_id) : []
      const loteOptions = lotesDeZona.map(lo =>
        `<option value="${lo.lote_id}">${lo.numero_lote} — disp: ${formatQty(lo.disponible)}${lo.disponibleUnid > 0 ? ' / ' + formatQty(lo.disponibleUnid) + ' und' : ''}</option>`
      ).join('')
      const pesoPorUnidad = desp.lote_id ? _lotesMap[desp.lote_id]?.peso_por_unidad : null
      html += `
        <tr>
          <td><input type="number" id="gd-${idx}-${subIdx}-cantidad" value="${desp.cantidad}" step="0.01" min="0" style="width:100px;" onchange="window.onCambiarCantidadDespachoGuia(${idx}, ${subIdx})"></td>
          <td><input type="text" id="gd-${idx}-${subIdx}-unidadmedida" value="${l.unidad_medida || ''}" readonly size="4" style="width:auto; max-width:60px; background:var(--bg-primary); color:var(--text-secondary);"></td>
          <td><input type="text" id="gd-${idx}-${subIdx}-pesounidad" value="${pesoPorUnidad ? formatQty(pesoPorUnidad) : ''}" readonly size="6" style="width:auto; max-width:80px; background:var(--bg-primary); color:var(--text-secondary);"></td>
          <td><input type="number" id="gd-${idx}-${subIdx}-unidades" value="${desp.cantidad_unidades ?? ''}" placeholder="Ej: 10" step="1" min="0" style="width:90px;"></td>
          <td><select id="gd-${idx}-${subIdx}-zona" style="min-width:160px;" onchange="window.onCambiarZonaDespachoGuia(${idx}, ${subIdx})">
                <option value="">-- Selecciona --</option>${zonaOptions}
              </select></td>
          <td><select id="gd-${idx}-${subIdx}-lote" style="min-width:200px;" ${!desp.ubicacion_id ? 'disabled' : ''} onchange="window.onCambiarLoteDespachoGuia(${idx}, ${subIdx})">
                <option value="">${desp.ubicacion_id ? '-- Selecciona lote (FIFO sugerido primero) --' : '-- Elige zona --'}</option>${loteOptions}
              </select></td>
          <td>${l.despachos.length > 1 ? `<button type="button" class="btn btn-small btn-danger" onclick="window.quitarDespachoGuia(${idx}, ${subIdx})">✕</button>` : ''}</td>
        </tr>
      `
    })
    html += `
          </tbody>
        </table>
        </div>
        <button type="button" class="btn btn-small btn-secondary" style="margin-top:6px;" onclick="window.agregarDespachoGuia(${idx})">+ Agregar otro lote/zona para este producto</button>
      </div>
    `
  })

  container.innerHTML = html

  // Preseleccionar valores guardados en el estado + listeners para no perder foco al escribir.
  _guiaDespachoLineas.forEach((l, idx) => {
    l.despachos.forEach((desp, subIdx) => {
      const cant = document.getElementById(`gd-${idx}-${subIdx}-cantidad`)
      const cantUnid = document.getElementById(`gd-${idx}-${subIdx}-unidades`)
      const zona = document.getElementById(`gd-${idx}-${subIdx}-zona`)
      const lote = document.getElementById(`gd-${idx}-${subIdx}-lote`)
      if (zona && desp.ubicacion_id) zona.value = desp.ubicacion_id
      if (lote && desp.lote_id) lote.value = desp.lote_id

      cant?.addEventListener('input', () => { desp.cantidad = parseFloat(cant.value || 0) })
      cantUnid?.addEventListener('input', () => { desp.cantidad_unidades = cantUnid.value !== '' ? parseFloat(cantUnid.value) : null })
    })
  })
}

window.guardarGuiaDespachoVenta = async function () {
  const btn = document.getElementById('btnGuardarGuiaDespachoVenta')
  if (btn?.disabled) return
  if (btn) { btn.disabled = true; btn.textContent = 'Guardando...' }
  try {
    const user = await getCurrentUser()
    if (!user) { showToast('Usuario no autenticado', 'danger'); return }

    const ventaId       = parseInt(document.getElementById('gdVenta')?.value || 0)
    const numeroGuia     = document.getElementById('gdNumeroGuia')?.value?.trim()
    const fechaGuia      = document.getElementById('gdFechaGuia')?.value
    const observaciones  = document.getElementById('gdObservaciones')?.value?.trim() || null

    if (!ventaId)     { showToast('Selecciona la venta que estás despachando', 'warning'); return }
    if (!numeroGuia)  { showToast('Ingresa el N° de Guía', 'warning'); return }
    if (!fechaGuia)   { showToast('Ingresa la fecha de la guía', 'warning'); return }
    if (!_guiaDespachoLineas || _guiaDespachoLineas.length === 0) { showToast('Esta venta no tiene productos pendientes', 'warning'); return }

    _sincronizarDespachosGuiaDesdeDOM()

    // Validar cantidad + zona + lote en cada despacho, y que no se despache
    // más de lo pendiente por línea, antes de escribir nada. Cuando hay
    // varias líneas del MISMO producto (mismo nombre) el mensaje de error
    // no alcanza para distinguir cuál falta — se agrega "línea N de M" +
    // la cantidad pendiente de esa línea puntual.
    // reservaZona acumula, POR lote+zona, lo que ya se validó en despachos
    // anteriores de este mismo guardado — necesario porque varias líneas
    // (incluso de productos distintos) pueden repartirse del mismo
    // lote+zona, y comparar cada una por separado contra el stock crudo
    // permitiría "reservar" el mismo stock más de una vez.
    const reservaZona = new Map() // filaStockId -> { cantidad, unidades } ya reservado en este guardado
    const despachosValidados = []
    const totalLineas = _guiaDespachoLineas.length
    for (const [i, l] of _guiaDespachoLineas.entries()) {
      const etiquetaLinea = totalLineas > 1 ? `"${l.nombre}" (línea ${i + 1} de ${totalLineas}, pendiente ${formatQty(l.cantidad_pendiente)})` : `"${l.nombre}"`
      let totalLinea = 0
      for (const d of l.despachos) {
        if (!d.cantidad || d.cantidad <= 0) continue // fila vacía: se ignora, no bloquea
        if (!d.ubicacion_id) { showToast(`Falta el Almacén/Zona en ${etiquetaLinea}`, 'warning'); return }
        if (!d.lote_id)      { showToast(`Falta el Lote en ${etiquetaLinea}`, 'warning'); return }

        const filaStock = (_stockUbic || []).find(su => su.lote_id === d.lote_id && su.ubicacion_id === d.ubicacion_id)
        if (!filaStock) {
          showToast(`Stock insuficiente para ${etiquetaLinea} en el lote/zona elegidos (disponible 0).`, 'danger')
          return
        }

        const yaReservado = reservaZona.get(filaStock.id) || { cantidad: 0, unidades: 0 }
        const disponible = parseFloat(filaStock.cantidad || 0) - yaReservado.cantidad
        const disponibleUnid = parseFloat(filaStock.cantidad_unidades || 0) - yaReservado.unidades
        if (d.cantidad > disponible) {
          showToast(`Stock insuficiente para ${etiquetaLinea} en el lote/zona elegidos (disponible ${formatQty(disponible)}).`, 'danger')
          return
        }
        if ((d.cantidad_unidades || 0) > 0 && d.cantidad_unidades > disponibleUnid) {
          showToast(`Unidades insuficientes para ${etiquetaLinea} en el lote/zona elegidos (disponible ${formatQty(disponibleUnid)} und).`, 'danger')
          return
        }
        reservaZona.set(filaStock.id, { cantidad: yaReservado.cantidad + d.cantidad, unidades: yaReservado.unidades + (d.cantidad_unidades || 0) })

        totalLinea += d.cantidad
        despachosValidados.push({
          detalle_venta_id: l.detalle_venta_id,
          item_id: l.item_id,
          cantidad: d.cantidad,
          cantidad_unidades: d.cantidad_unidades || 0,
          ubicacion_id: d.ubicacion_id,
          lote_id: d.lote_id,
          filaStockId: filaStock.id
        })
      }
      if (totalLinea - l.cantidad_pendiente > 0.0001) {
        showToast(`${etiquetaLinea}: estás despachando ${formatQty(totalLinea)} pero solo hay ${formatQty(l.cantidad_pendiente)} pendiente.`, 'danger')
        return
      }
    }

    if (despachosValidados.length === 0) { showToast('No hay cantidades a despachar', 'warning'); return }

    const venta = await getVentaById(ventaId)

    const guia = await addGuiaDespachoVenta({
      venta_id:      ventaId,
      numero_guia:   numeroGuia,
      fecha_guia:    fechaGuia,
      observaciones,
      created_by:    user.db_id
    })

    if (!guia?.id) { showToast('No se pudo registrar la guía de despacho', 'danger'); return }

    // Ubicación virtual "Partners/Customers": destino de TODA salida por venta en el Kardex.
    const customersZona = await getUbicacionCustomers()

    // Copia local de las filas de stock_ubicaciones tocadas, para decrementar
    // ACUMULATIVAMENTE cuando varios despachos comparten el mismo
    // filaStockId (mismo lote+zona) — si se leyera cada vez de _stockUbic
    // (caché sin refrescar durante el loop) se pisaría el descuento anterior
    // en vez de sumarlo.
    const stockLocalPorFila = new Map()
    for (const su of (_stockUbic || [])) stockLocalPorFila.set(su.id, { ...su })

    for (const d of despachosValidados) {
      const lote = await getLoteById(d.lote_id)
      const nuevaCantidadLote = parseFloat(((parseFloat(lote?.cantidad) || 0) - d.cantidad).toFixed(4))
      const nuevaUnidadesLote = Math.max(0, parseFloat(((parseFloat(lote?.cantidad_unidades) || 0) - (d.cantidad_unidades || 0)).toFixed(4)))
      await updateLote(d.lote_id, { cantidad: nuevaCantidadLote, cantidad_unidades: nuevaUnidadesLote })

      const filaStock = stockLocalPorFila.get(d.filaStockId)
      const nuevaCantidadZona = parseFloat(((parseFloat(filaStock?.cantidad) || 0) - d.cantidad).toFixed(4))
      const nuevaUnidadesZona = Math.max(0, parseFloat(((parseFloat(filaStock?.cantidad_unidades) || 0) - (d.cantidad_unidades || 0)).toFixed(4)))
      if (filaStock) { filaStock.cantidad = nuevaCantidadZona; filaStock.cantidad_unidades = nuevaUnidadesZona } // acumular para el próximo despacho de esta misma fila
      if (nuevaCantidadZona <= 0) {
        await deleteStockUbicacion(d.filaStockId)
        stockLocalPorFila.delete(d.filaStockId)
      } else {
        await updateStockUbicacion(d.filaStockId, { cantidad: nuevaCantidadZona, cantidad_unidades: nuevaUnidadesZona })
      }

      // Kardex: salida de la zona real hacia Partners/Customers (externo).
      // costo_unitario viene del lote (costeo por identificación específica).
      const costoUnitLote = parseFloat(lote?.costo_unitario || 0)
      await addKardexMovimiento({
        item_id:              d.item_id,
        lote_id:               d.lote_id,
        ubicacion_origen_id:   d.ubicacion_id,
        ubicacion_destino_id:  customersZona?.id || null,
        fecha:                 fechaGuia,
        tipo_movimiento:       'salida',
        concepto:              'Venta - salida de almacén (guía de despacho)',
        documento_referencia:  numeroGuia,
        cantidad_entrada:      0,
        cantidad_salida:       d.cantidad,
        cantidad_unidades_entrada: 0,
        cantidad_unidades_salida:  d.cantidad_unidades || 0,
        costo_unitario:        costoUnitLote,
        valor_entrada:         0,
        valor_salida:          parseFloat((d.cantidad * costoUnitLote).toFixed(2)),
        moneda:                lote?.moneda || 'PEN',
        tipo_cambio:            parseFloat(lote?.tipo_cambio) || 1,
        costo_unit_original:    parseFloat(lote?.costo_unit_original ?? costoUnitLote),
        saldo_cantidad:        nuevaCantidadLote,
        saldo_valor:           parseFloat((nuevaCantidadLote * costoUnitLote).toFixed(2)),
        saldo_unidades:        nuevaUnidadesLote,
        venta_id:              ventaId,
        created_by:            user.db_id
      })

      await addDetalleGuiaDespachoVenta({
        guia_id:            guia.id,
        detalle_venta_id:   d.detalle_venta_id,
        item_id:            d.item_id,
        cantidad:           d.cantidad,
        cantidad_unidades:  d.cantidad_unidades || 0,
        numero_lote:        lote?.numero_lote || '',
        lote_id:            d.lote_id,
        ubicacion_id:       d.ubicacion_id
      })

      // Trazabilidad rápida en detalle_ventas (referencial): si la línea se
      // despachó de un solo lote, queda ese lote/zona; si se repartió entre
      // varios, queda el ÚLTIMO — para el detalle exacto por lote, la fuente
      // real es detalle_guias_despacho_venta.
      await updateDetalleVenta(d.detalle_venta_id, {
        lote_id: d.lote_id,
        ubicacion_id: d.ubicacion_id,
        costo_unitario: costoUnitLote
      })
    }

    // Recalcular estado_despacho de la venta: comparar total despachado
    // (incluye esta guía recién guardada) contra el total vendido.
    await _recalcularEstadoDespachoVenta(ventaId)

    showToast('Guía de despacho registrada: stock actualizado en Inventario', 'success')
    window.cerrarModalNuevaGuiaDespacho()
    _guiaDespachoLineas = []

    // Refrescar cachés locales de stock/lotes (se acaban de consumir).
    const [lotesFrescos, stockFresco] = await Promise.all([getLotes(), getStockUbicaciones()])
    _lotes = lotesFrescos
    _stockUbic = stockFresco
    _lotesMap = {}
    for (const lo of (_lotes || [])) _lotesMap[lo.id] = lo

    await renderGuiasDespachoVenta(true)
    await renderVentas(true)
  } catch (error) {
    console.error('Error en guardarGuiaDespachoVenta:', error)
    showToast('Error: ' + error.message, 'danger')
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Guardar Guía (descuenta stock)' }
  }
}

/** Compara lo despachado (detalle_guias_despacho_venta) contra lo vendido (detalle_ventas) y actualiza ventas.estado_despacho. */
async function _recalcularEstadoDespachoVenta(ventaId) {
  const [detalles, despachos] = await Promise.all([
    getDetalleVentas(ventaId),
    getDetalleGuiasDespachoVentaByVenta(ventaId)
  ])
  // Las guías anuladas ya devolvieron su stock, así que no cuentan como
  // despachado: si contaran, una venta con su única guía anulada seguiría
  // apareciendo como "despachada" y no se podría volver a despachar.
  const guiasVenta = await getGuiasDespachoVenta(true)
  const guiasAnuladas = new Set((guiasVenta || []).filter(g => g.estado === 'anulada').map(g => g.id))

  const despachadoPorDetalle = {}
  for (const d of (despachos || [])) {
    if (guiasAnuladas.has(d.guia_id)) continue
    despachadoPorDetalle[d.detalle_venta_id] = (despachadoPorDetalle[d.detalle_venta_id] || 0) + (parseFloat(d.cantidad) || 0)
  }
  let totalVendido = 0, totalDespachado = 0
  for (const d of (detalles || [])) {
    totalVendido += parseFloat(d.cantidad) || 0
    totalDespachado += Math.min(parseFloat(d.cantidad) || 0, despachadoPorDetalle[d.id] || 0)
  }
  let estado = 'pendiente'
  if (totalDespachado > 0 && totalDespachado + 0.0001 >= totalVendido) estado = 'despachado'
  else if (totalDespachado > 0) estado = 'parcial'
  await updateVenta(ventaId, { estado_despacho: estado })
}

// Lógica núcleo de eliminación (sin confirm ni toasts) — la usan tanto el
// borrado individual como el masivo. Lanza Error con mensaje claro si algo
// impide eliminar, para que el masivo pueda seguir con las demás y reportar
// al final cuáles fallaron.
async function _eliminarGuiaDespachoCore(id) {
  const guiaActual = await getGuiaDespachoVentaById(id)
  if (!guiaActual) throw new Error(`Guía #${id}: no se encontró`)

  const detalles = await getDetalleGuiasDespachoVenta(id)

  for (const dg of (detalles || [])) {
    await _devolverAUnaZona(dg.lote_id, dg.ubicacion_id, parseFloat(dg.cantidad) || 0, parseFloat(dg.cantidad_unidades) || 0)
  }

  // Kardex: se borran las filas 'salida' de esta venta que correspondan a
  // los lotes tocados por esta guía específica (documento_referencia =
  // numero_guia de esta guía).
  if (guiaActual.venta_id) {
    const kardexVenta = await getKardexByVenta(guiaActual.venta_id)
    for (const k of (kardexVenta || [])) {
      if (k.documento_referencia === guiaActual.numero_guia) await deleteKardexMovimiento(k.id)
    }
  }

  const ok = await deleteGuiaDespachoVenta(id) // detalle_guias_despacho_venta se borra solo (ON DELETE CASCADE)
  if (!ok) {
    const motivo = ultimoErrorDelete()
    throw new Error(`Guía ${guiaActual.numero_guia}: ${motivo?.mensaje || 'no se pudo eliminar'}`)
  }

  if (guiaActual.venta_id) await _recalcularEstadoDespachoVenta(guiaActual.venta_id)
  return { numero: guiaActual.numero_guia, ventaId: guiaActual.venta_id, lineas: detalles?.length || 0 }
}

window.eliminarGuiaDespachoVenta = async function (id) {
  try {
    const detalles = await getDetalleGuiasDespachoVenta(id)
    if (!confirm(
      `Se eliminará la guía de despacho y se revertirá el stock (${detalles?.length || 0} línea(s)) a Inventario. ¿Continuar?`
    )) return

    await _eliminarGuiaDespachoCore(id)

    _invalidarCacheVentas()
    showToast('Guía de despacho eliminada: stock revertido en Inventario', 'success')
    await renderGuiasDespachoVenta(true)
    await renderVentas(true)
  } catch (error) {
    console.error('Error en eliminarGuiaDespachoVenta:', error)
    showToast('Error al eliminar la guía: ' + error.message, 'danger')
  }
}

// ── Selección múltiple ──────────────────────────────────────────────────────
// Las guías anuladas quedan fuera de la selección: su stock YA se revirtió al
// anularlas, así que eliminarlas en lote junto a guías vigentes aplicaría la
// reversión dos veces sobre el mismo lote.

window.toggleSeleccionTodasGuiasDespacho = function (checked) {
  document.querySelectorAll('.gd-sel:not(:disabled)').forEach(cb => { cb.checked = checked })
  window.actualizarBotonEliminarGuiasDespacho()
}

window.actualizarBotonEliminarGuiasDespacho = function () {
  const n = document.querySelectorAll('.gd-sel:checked').length
  const btn = document.getElementById('btnEliminarGuiasDespachoSel')
  if (!btn) return
  btn.style.display = n > 0 ? 'inline-flex' : 'none'
  btn.textContent = `🗑 Eliminar seleccionadas (${n})`
}

window.eliminarGuiasDespachoSeleccionadas = async function () {
  const ids = Array.from(document.querySelectorAll('.gd-sel:checked')).map(cb => parseInt(cb.value))
  if (ids.length === 0) { showToast('Selecciona al menos una guía', 'warning'); return }

  if (!confirm(
    `Se eliminarán ${ids.length} guía(s) de despacho y se devolverá su stock (kg y unidades) a Inventario.\n\n` +
    `También se recalculará el estado de despacho de las ventas afectadas.\n\n` +
    `Esta acción no se puede deshacer. ¿Continuar?`
  )) return

  const btn = document.getElementById('btnEliminarGuiasDespachoSel')
  if (btn) { btn.disabled = true; btn.textContent = 'Eliminando...' }

  let ok = 0
  const errores = []
  for (const id of ids) {
    try {
      await _eliminarGuiaDespachoCore(id)
      ok++
    } catch (e) {
      console.error(`Error eliminando guía de despacho ${id}:`, e)
      errores.push(e.message || `Guía #${id}: error inesperado`)
    }
  }

  if (ok > 0) showToast(`${ok} guía(s) eliminada(s): stock devuelto a Inventario`, 'success')
  if (errores.length > 0) showToast(`${errores.length} no se pudo(eron) eliminar: ${errores.join(' | ')}`, 'danger', 8000)

  if (btn) { btn.disabled = false }
  _invalidarCacheVentas()
  await renderGuiasDespachoVenta(true)
  await renderVentas(true)
}

async function renderGuiasDespachoVenta(forzar = false) {
  try {
    const container = document.getElementById('tabla-guias-despacho')
    if (!container) return

    if (!_guiasDespachoLista || forzar) {
      invalidateGuiasDespachoVentaCache()
      const [guias, ventas, clientes] = await Promise.all([getGuiasDespachoVenta(true), getVentas(), getCustomers()])
      const ventasMap = {}
      for (const v of (ventas || [])) ventasMap[v.id] = v
      const clientesMap = {}
      for (const c of (clientes || [])) clientesMap[c.id] = c
      _guiasDespachoLista = (guias || []).map(g => {
        const v = ventasMap[g.venta_id]
        return {
          ...g,
          ventaNumero: v ? `${v.serie || ''}-${String(v.correlativo || '').padStart(8,'0')}` : `Venta #${g.venta_id}`,
          clienteNombre: v ? (clientesMap[v.contact_id]?.razon_social || clientesMap[v.contact_id]?.nombre || '-') : '-'
        }
      }).sort((a, b) => new Date(b.fecha_guia || 0) - new Date(a.fecha_guia || 0))
    }

    const busqueda = (document.getElementById('buscarGuiaDespacho')?.value || '').trim().toLowerCase()
    const lista = busqueda
      ? _guiasDespachoLista.filter(g => `${g.numero_guia || ''} ${g.clienteNombre || ''} ${g.ventaNumero || ''}`.toLowerCase().includes(busqueda))
      : _guiasDespachoLista

    if (!lista || lista.length === 0) {
      container.innerHTML = `<p style="text-align:center; color:var(--text-secondary); padding:20px;">${busqueda ? 'Sin resultados para la búsqueda' : 'Sin guías de despacho registradas'}</p>`
      return
    }

    container.innerHTML = `
      <table>
        <thead>
          <tr>
            <th style="width:32px;"><input type="checkbox" id="selAllGuiasDespacho" onchange="window.toggleSeleccionTodasGuiasDespacho(this.checked)" title="Seleccionar todas"></th>
            <th>N° Guía</th><th>Venta</th><th>Cliente</th><th>Fecha</th><th>Estado</th><th>Observaciones</th><th>Acciones</th>
          </tr>
        </thead>
        <tbody>
          ${lista.map(g => {
            const anulada = estaAnulado(g)
            return `
            <tr${anulada ? ` style="${ESTILO_FILA_ANULADA}"` : ''}>
              <td style="text-decoration:none; opacity:1;">${anulada
                ? `<input type="checkbox" disabled title="Guía anulada: su stock ya fue revertido">`
                : `<input type="checkbox" class="gd-sel" value="${g.id}" onchange="window.actualizarBotonEliminarGuiasDespacho()">`}</td>
              <td>${g.numero_guia}</td>
              <td>${g.ventaNumero}</td>
              <td>${g.clienteNombre}</td>
              <td>${g.fecha_guia || '-'}</td>
              <td>${anulada ? badgeAnulado(g) : '<span class="badge badge-success">Emitida</span>'}</td>
              <td>${g.observaciones || '-'}</td>
              <td class="col-acciones" style="text-decoration:none; opacity:1;">
                ${menuAccionesFila(anulada
                  ? [{ label: 'Ver motivo de anulación', icono: 'ℹ️', onclick: `window.verMotivoAnulacion('guia', ${g.id})` }]
                  : [
                      { label: 'Anular guía', icono: '🚫', onclick: `window.anularGuiaDespachoVenta(${g.id})`, peligro: true },
                      { label: 'Eliminar', icono: '🗑️', onclick: `window.eliminarGuiaDespachoVenta(${g.id})`, peligro: true }
                    ])}
              </td>
            </tr>`
          }).join('')}
        </tbody>
      </table>
    `
  } catch (error) {
    console.error('Error en renderGuiasDespachoVenta:', error)
    showToast('Error al cargar las guías de despacho', 'danger')
  }
}

window.filtrarGuiasDespacho = function () {
  renderGuiasDespachoVenta(false)
}
 
// ============================================================================
// REPORTES GERENCIALES DE VENTAS — Fase 2
// ============================================================================
// El margen se calcula con el costo_unitario que quedó registrado en cada
// línea de detalle_ventas (costeo por identificación específica, LIR Art. 62°).
// Las líneas sin costo se excluyen del margen pero sí cuentan en la venta,
// y el reporte lo advierte para que no se lea un margen engañoso.

const _repVentasListos = {}

async function construirReporteVentas(panelId) {
  if (_repVentasListos[panelId]) return
  _repVentasListos[panelId] = true
  const cont = document.getElementById(panelId)
  if (cont) cont.innerHTML = '<div class="card"><p class="reporte-vacio">Calculando reporte…</p></div>'

  try {
    const [ventas, clientes, detalles, items] = await Promise.all([
      cacheado('ventas', getVentas),
      cacheado('clientes', getCustomers),
      cacheado('detalle_ventas', getDetalleVentas),
      cacheado('items', getItems)
    ])

    const cliMap = {};   (clientes || []).forEach(c => { cliMap[c.id] = c.razon_social || c.nombre })
    const itemMap = {};  (items || []).forEach(i => { itemMap[i.id] = i })
    const ventaMap = {}; (ventas || []).forEach(v => { ventaMap[v.id] = v })

    // Un comprobante anulado no vendió nada: se excluye de TODOS los reportes
    // (facturación, márgenes, despacho). Queda visible solo en el listado.
    const activas = (ventas || []).filter(v => !estaAnulado(v))

    // Las notas de crédito entran con signo negativo para que cualquier
    // agrupación (por mes, cliente, producto) dé la venta NETA real.
    const filas = activas.map(v => {
      const sg = signoDocumento(v.tipo_comprobante)
      return {
        cliente: cliMap[v.contact_id] || `ID ${v.contact_id}`,
        mes: nombreMes((v.fecha_emision || '').slice(0, 7)),
        fecha: v.fecha_emision || '',
        comprobante: v.numero || `${v.serie || ''}-${v.correlativo || ''}`,
        tipo_comprobante: nombreTipoComprobante(v.tipo_comprobante),
        moneda: v.moneda || 'PEN',
        estado_pago: v.estado_pago || 'pendiente',
        estado_despacho: v.estado_despacho || 'pendiente',
        base: parseFloat(v.base_imponible || 0) * sg,
        igv: parseFloat(v.igv || 0) * sg,
        total: parseFloat(v.total || 0) * sg
      }
    })

    const filtrosBase = [
      { key: 'buscar', label: 'Buscar', tipo: 'texto', campos: ['cliente', 'comprobante'], placeholder: 'Cliente o comprobante...' },
      { key: 'tipo_comprobante', label: 'Comprobante', tipo: 'select', opciones: Array.from(new Set(filas.map(f => f.tipo_comprobante))).sort() },
      { key: 'moneda', label: 'Moneda', tipo: 'select', opciones: ['PEN', 'USD'] },
      { key: 'rango', label: 'Emisión', tipo: 'rango', campo: 'fecha' }
    ]
    const medidasBase = [
      { key: 'base', label: 'Base imponible', agg: 'sum', formato: 'money' },
      { key: 'igv', label: 'IGV', agg: 'sum', formato: 'money' },
      { key: 'total', label: 'Total', agg: 'sum', formato: 'money' }
    ]
    const kpisBase = (f) => [
      { label: 'Total vendido', valor: f.reduce((s, x) => s + x.total, 0), formato: 'money', color: 'var(--color-success)' },
      { label: 'IGV (débito fiscal)', valor: f.reduce((s, x) => s + x.igv, 0), formato: 'money' },
      { label: 'Comprobantes', valor: f.length, formato: 'int' },
      { label: 'Ticket promedio', valor: f.length ? f.reduce((s, x) => s + x.total, 0) / f.length : 0, formato: 'money' }
    ]

    if (panelId === 'repv-evolucion') {
      crearReporte('repv-evolucion', {
        id: 'repv-evolucion',
        titulo: 'Evolución de las ventas',
        descripcion: 'Ventas mes a mes, cruzables por tipo de comprobante, moneda o cliente.',
        datos: filas,
        dimensiones: [
          { key: 'mes', label: 'Mes' }, { key: 'tipo_comprobante', label: 'Comprobante' },
          { key: 'moneda', label: 'Moneda' }, { key: 'cliente', label: 'Cliente' }
        ],
        medidas: medidasBase, filtros: filtrosBase,
        agruparPorDefecto: ['mes'], orden: { key: '_etiqueta', dir: 'asc' }, kpis: kpisBase
      })
    }

    if (panelId === 'repv-clientes') {
      crearReporte('repv-clientes', {
        id: 'repv-clientes',
        titulo: 'Ventas por cliente',
        descripcion: 'Concentración de ventas: cuánto pesa cada cliente en tu facturación.',
        datos: filas,
        dimensiones: [
          { key: 'cliente', label: 'Cliente' }, { key: 'mes', label: 'Mes' },
          { key: 'moneda', label: 'Moneda' }, { key: 'estado_pago', label: 'Estado de pago' }
        ],
        medidas: medidasBase, filtros: filtrosBase,
        agruparPorDefecto: ['cliente'], kpis: kpisBase
      })
    }

    if (panelId === 'repv-despacho') {
      // Las notas de crédito/débito no se despachan: se excluyen para que no
      // aparezcan eternamente como "pendientes de despacho".
      const filasDespacho = activas
        .filter(v => !esNota(v.tipo_comprobante))
        .map(v => filas[activas.indexOf(v)])
        .filter(Boolean)
      crearReporte('repv-despacho', {
        id: 'repv-despacho',
        titulo: 'Estado de despacho de las ventas',
        descripcion: 'Facturado vs entregado. Las ventas pendientes o parciales necesitan su Guía de Despacho para que el stock se descuente. Las notas de crédito/débito no aparecen aquí porque no mueven mercadería.',
        datos: filasDespacho,
        dimensiones: [
          { key: 'estado_despacho', label: 'Estado de despacho' }, { key: 'cliente', label: 'Cliente' },
          { key: 'mes', label: 'Mes' }, { key: 'estado_pago', label: 'Estado de pago' }
        ],
        medidas: [{ key: 'total', label: 'Total facturado', agg: 'sum', formato: 'money' }],
        filtros: [
          ...filtrosBase,
          { key: 'estado_despacho', label: 'Despacho', tipo: 'select', opciones: Array.from(new Set(filas.map(f => f.estado_despacho))).sort() }
        ],
        agruparPorDefecto: ['estado_despacho'],
        kpis: (f) => {
          const pend = f.filter(x => x.estado_despacho !== 'despachado')
          return [
            { label: 'Total facturado', valor: f.reduce((s, x) => s + x.total, 0), formato: 'money' },
            { label: 'Sin despachar', valor: pend.reduce((s, x) => s + x.total, 0), formato: 'money', color: 'var(--color-warning)', sub: `${pend.length} venta(s)` },
            { label: 'Comprobantes', valor: f.length, formato: 'int' }
          ]
        }
      })
    }

    if (panelId === 'repv-productos' || panelId === 'repv-margen') {
      const filasDet = (detalles || []).map(d => {
        const v = ventaMap[d.venta_id] || {}
        if (estaAnulado(v)) return null
        const it = itemMap[d.item_id] || {}
        const cant  = parseFloat(d.cantidad || 0)
        const pu    = parseFloat(d.precio_unitario || 0)
        const costo = parseFloat(d.costo_unitario || 0)
        const ingreso = parseFloat(d.subtotal || (cant * pu) || 0)
        const costoTotal = parseFloat((cant * costo).toFixed(2))
        return {
          producto: it.nombre || d.descripcion || `Item ${d.item_id}`,
          sku: it.sku || '—',
          cliente: cliMap[v.contact_id] || '(sin cliente)',
          mes: nombreMes((v.fecha_emision || '').slice(0, 7)),
          fecha: v.fecha_emision || '',
          moneda: v.moneda || 'PEN',
          con_costo: costo > 0 ? 'Con costo' : 'Sin costo registrado',
          cantidad: cant,
          precio_unitario: pu,
          ingreso,
          costo: costoTotal,
          margen: parseFloat((ingreso - costoTotal).toFixed(2)),
          margen_pct: ingreso > 0 ? parseFloat(((ingreso - costoTotal) / ingreso * 100).toFixed(1)) : 0
        }
      }).filter(Boolean)

      if (panelId === 'repv-productos') {
        crearReporte('repv-productos', {
          id: 'repv-productos',
          titulo: 'Ventas por producto',
          descripcion: 'Qué productos mueven tu facturación y a qué precio promedio se venden.',
          datos: filasDet,
          dimensiones: [
            { key: 'producto', label: 'Producto' }, { key: 'cliente', label: 'Cliente' },
            { key: 'mes', label: 'Mes' }, { key: 'moneda', label: 'Moneda' }
          ],
          medidas: [
            { key: 'cantidad', label: 'Cantidad', agg: 'sum', formato: 'qty' },
            { key: 'ingreso', label: 'Ingreso', agg: 'sum', formato: 'money' },
            { key: 'precio_unitario', label: 'Precio unit. prom.', agg: 'avg', formato: 'money4' }
          ],
          filtros: [
            { key: 'buscar', label: 'Buscar', tipo: 'texto', campos: ['producto', 'sku', 'cliente'], placeholder: 'Producto o cliente...' },
            { key: 'moneda', label: 'Moneda', tipo: 'select', opciones: ['PEN', 'USD'] },
            { key: 'rango', label: 'Fecha', tipo: 'rango', campo: 'fecha' }
          ],
          agruparPorDefecto: ['producto'],
          kpis: (f) => [
            { label: 'Ingreso total', valor: f.reduce((s, x) => s + x.ingreso, 0), formato: 'money' },
            { label: 'Unidades vendidas', valor: f.reduce((s, x) => s + x.cantidad, 0), formato: 'qty' },
            { label: 'Productos distintos', valor: new Set(f.map(x => x.producto)).size, formato: 'int' }
          ]
        })
      }

      if (panelId === 'repv-margen') {
        const sinCosto = filasDet.filter(f => f.con_costo === 'Sin costo registrado').length
        crearReporte('repv-margen', {
          id: 'repv-margen',
          titulo: 'Margen bruto por producto y cliente',
          descripcion: sinCosto > 0
            ? `Ingreso menos costo del lote vendido. ⚠ ${sinCosto} línea(s) no tienen costo registrado y aparecen con margen = ingreso: filtra por "Con costo" para leer el margen real.`
            : 'Ingreso menos costo del lote efectivamente vendido (identificación específica).',
          datos: filasDet,
          dimensiones: [
            { key: 'producto', label: 'Producto' }, { key: 'cliente', label: 'Cliente' },
            { key: 'mes', label: 'Mes' }, { key: 'con_costo', label: 'Costo registrado' }
          ],
          medidas: [
            { key: 'ingreso', label: 'Ingreso', agg: 'sum', formato: 'money' },
            { key: 'costo', label: 'Costo', agg: 'sum', formato: 'money' },
            { key: 'margen', label: 'Margen bruto', agg: 'sum', formato: 'money', semaforo: true },
            { key: 'margen_pct', label: '% margen', agg: 'avg', formato: 'pct' }
          ],
          filtros: [
            { key: 'buscar', label: 'Buscar', tipo: 'texto', campos: ['producto', 'cliente'], placeholder: 'Producto o cliente...' },
            { key: 'con_costo', label: 'Costo', tipo: 'select', opciones: ['Con costo', 'Sin costo registrado'], valorDefecto: sinCosto > 0 ? 'Con costo' : '' },
            { key: 'rango', label: 'Fecha', tipo: 'rango', campo: 'fecha' }
          ],
          agruparPorDefecto: ['producto'],
          kpis: (f) => {
            const ing = f.reduce((s, x) => s + x.ingreso, 0)
            const cos = f.reduce((s, x) => s + x.costo, 0)
            return [
              { label: 'Ingreso', valor: ing, formato: 'money' },
              { label: 'Costo', valor: cos, formato: 'money', color: 'var(--color-danger)' },
              { label: 'Margen bruto', valor: ing - cos, formato: 'money', color: (ing - cos) >= 0 ? 'var(--color-success)' : 'var(--color-danger)' },
              { label: '% margen', valor: ing ? ((ing - cos) / ing * 100) : 0, formato: 'pct' }
            ]
          }
        })
      }
    }
  } catch (e) {
    console.error('construirReporteVentas:', e)
    _repVentasListos[panelId] = false
    if (cont) cont.innerHTML = `<div class="card"><p class="reporte-vacio">No se pudo construir el reporte: ${e.message}</p></div>`
  }
}

// ============================================================================
// ANULACIÓN DE FACTURAS DE VENTA
// ============================================================================
// Anular ≠ eliminar. El comprobante se conserva con su numeración (SUNAT lo
// exige) pero deja de contar en reportes, CxC e IGV.
//
// Orden de las validaciones — importa, porque cada bloqueo se resuelve en un
// sitio distinto del sistema:
//   1. Ya anulada          → nada que hacer.
//   2. Tiene cobros        → primero hay que revertir el cobro en Cuentas x
//                            Cobrar/Pagar; si no, quedaría plata cobrada
//                            contra un documento inexistente.
//   3. Tiene guías activas → primero se anulan las guías, que son las que
//                            devuelven el stock. Anular la venta no toca
//                            stock por sí sola (el stock lo mueve la guía).
//   4. CPE aceptado        → SUNAT ya lo recibió: legalmente se anula con Nota
//                            de Crédito, no borrando. Se avisa, pero se deja
//                            continuar marcándolo como anulado internamente.

window.anularVenta = async function (id) {
  try {
    const venta = await getVentaById(id)
    if (!venta) { showToast('No se encontró la venta', 'danger'); return }

    const numero = `${venta.serie || ''}-${String(venta.correlativo || '').padStart(8, '0')}`

    if (estaAnulado(venta)) {
      showToast(`${numero} ya está anulada`, 'info')
      return
    }

    const bloqueos = []
    const efectos  = []

    // --- Cobros aplicados
    const cxcs = await getCuentasCobrarByVenta(id)
    let totalCobrado = 0
    for (const cxc of (cxcs || [])) {
      totalCobrado += (parseFloat(cxc.monto_cobrado) || 0) + (parseFloat(cxc.monto_retenido) || 0)
    }
    if (totalCobrado > 0.01) {
      bloqueos.push(`Tiene ${formatNumber(totalCobrado)} ya cobrado/retenido. Revierte los cobros en "Cuentas x Cobrar/Pagar" antes de anular.`)
    } else if ((cxcs || []).length > 0) {
      efectos.push(`Se anulará su Cuenta por Cobrar (${formatNumber(cxcs[0].monto_total)}).`)
    }

    // --- Guías de despacho activas (las que movieron stock)
    const guias = (await getGuiasDespachoVenta(true) || []).filter(g => g.venta_id === id && g.estado !== 'anulada')
    if (guias.length > 0) {
      bloqueos.push(`Tiene ${guias.length} guía(s) de despacho activa(s) (${guias.map(g => g.numero_guia).join(', ')}). Anúlalas primero — son las que devuelven el stock a Inventario.`)
    }

    // --- Asiento contable
    if (venta.asiento_id) {
      efectos.push('Se generará un asiento de reversión (el asiento original no se borra).')
    }

    if (venta.cpe_estado === 'aceptado') {
      efectos.push('⚠ Este comprobante ya fue aceptado por SUNAT: ante la administración se anula emitiendo una Nota de Crédito. Aquí solo se marcará como anulado en tu sistema.')
    }

    efectos.push('Quedará como ANULADO con su número reservado; no se reutiliza la numeración.')
    efectos.push('Dejará de sumar en reportes, KPIs, dashboard e IGV del periodo.')

    abrirModalAnulacion({
      titulo: 'Anular Factura de Venta',
      documento: `${venta.tipo_comprobante === '01' ? 'Factura' : venta.tipo_comprobante === '03' ? 'Boleta' : 'Comprobante'} ${numero}`,
      detalle: `${venta.fecha_emision || ''} · ${venta.moneda || 'PEN'} ${formatNumber(venta.total)}`,
      efectos, bloqueos,
      onConfirmar: async ({ motivo, fecha, usuarioId }) => {
        // 1. Marcar el comprobante
        await updateVenta(id, {
          ...camposAnulacion({ motivo, fecha, usuarioId }),
          estado: 'anulada'
        })

        // 2. Anular su cuenta por cobrar (ya validamos que no tiene cobros)
        for (const cxc of (cxcs || [])) {
          try {
            await updateCuentaCobrar(cxc.id, { estado: 'anulado' })
          } catch (e) {
            console.warn('CxC no anulada:', e.message)
          }
        }

        // 3. Reversar el asiento contable. Si falla, la anulación NO se
        //    revierte: el documento anulado es lo prioritario y el asiento se
        //    puede reversar a mano desde Contabilidad.
        if (venta.asiento_id) {
          try {
            await reversarAsiento(venta.asiento_id, usuarioId, `Anulación de venta ${numero}: ${motivo}`)
          } catch (e) {
            console.warn('Asiento no reversado:', e.message)
            showToast('Venta anulada ⚠️ el asiento no se pudo reversar: ' + e.message, 'warning')
          }
        }

        _invalidarCacheVentas()
        showToast(`${numero} anulada ✅`, 'success')
        await renderVentas(true)
      }
    })
  } catch (e) {
    console.error('anularVenta:', e)
    showToast('Error al preparar la anulación: ' + e.message, 'danger')
  }
}

window.verMotivoAnulacion = async function (tipo, id) {
  try {
    const doc = tipo === 'venta' ? await getVentaById(id) : await getGuiaDespachoVentaById(id)
    if (!doc) return
    const etiqueta = tipo === 'venta'
      ? `${doc.serie || ''}-${String(doc.correlativo || '').padStart(8, '0')}`
      : doc.numero_guia
    alert(
      `Documento: ${etiqueta}\n` +
      `Fecha de anulación: ${doc.fecha_anulacion || '(no registrada)'}\n\n` +
      `Motivo:\n${doc.motivo_anulacion || '(sin motivo registrado)'}`
    )
  } catch (e) {
    showToast('No se pudo leer el motivo: ' + e.message, 'danger')
  }
}

function _invalidarCacheVentas() {
  import('./data-cache.js').then(({ invalidarVarios }) => {
    invalidarVarios(['ventas', 'detalle_ventas', 'cuentas_cobrar', 'lotes', 'stock_ubicaciones', 'kardex'])
  }).catch(() => {})
  Object.keys(_repVentasListos).forEach(k => { _repVentasListos[k] = false })
}

// ============================================================================
// ANULACIÓN DE GUÍAS DE DESPACHO DE VENTA
// ============================================================================
// Diferencia con "Eliminar": eliminar borra el registro y su numeración se
// pierde; anular conserva la guía como documento histórico (su número queda
// reservado) pero revierte todos sus efectos:
//   * devuelve la cantidad y las unidades al lote y a su zona de origen,
//   * borra los movimientos de kardex que generó esa guía,
//   * recalcula el estado de despacho de la venta (vuelve a quedar pendiente
//     o parcial, según lo que quede realmente despachado).

window.anularGuiaDespachoVenta = async function (id) {
  try {
    const guia = await getGuiaDespachoVentaById(id)
    if (!guia) { showToast('No se encontró la guía', 'danger'); return }

    if (estaAnulado(guia)) {
      showToast(`La guía ${guia.numero_guia} ya está anulada`, 'info')
      return
    }

    const detalles = await getDetalleGuiasDespachoVenta(id)
    const bloqueos = []

    // Si la venta ya fue anulada, la guía debería anularse igual (de hecho es
    // el orden correcto: guía primero). No se bloquea nada por eso.
    const venta = guia.venta_id ? await getVentaById(guia.venta_id) : null

    const totalKg = (detalles || []).reduce((s, d) => s + (parseFloat(d.cantidad) || 0), 0)

    const efectos = [
      `Se devolverán ${formatQty(totalKg)} a Inventario, a los mismos lotes y zonas de donde salieron (${detalles?.length || 0} línea(s)).`,
      'Se eliminarán los movimientos de kardex que generó esta guía.',
      'La venta volverá a figurar como pendiente o parcialmente despachada.',
      'La guía queda registrada como ANULADA; su número no se reutiliza.'
    ]

    abrirModalAnulacion({
      titulo: 'Anular Guía de Despacho',
      documento: `Guía ${guia.numero_guia}`,
      detalle: venta
        ? `Venta ${venta.serie || ''}-${String(venta.correlativo || '').padStart(8, '0')} · ${guia.fecha_guia || ''}`
        : (guia.fecha_guia || ''),
      efectos, bloqueos,
      onConfirmar: async ({ motivo, fecha, usuarioId }) => {
        // 1. Devolver el stock línea por línea
        for (const dg of (detalles || [])) {
          await _devolverAUnaZona(
            dg.lote_id, dg.ubicacion_id,
            parseFloat(dg.cantidad) || 0,
            parseFloat(dg.cantidad_unidades) || 0
          )
        }

        // 2. Borrar el kardex de esta guía (se identifica por documento_referencia)
        if (guia.venta_id) {
          const kardexVenta = await getKardexByVenta(guia.venta_id)
          for (const k of (kardexVenta || [])) {
            if (k.documento_referencia === guia.numero_guia) await deleteKardexMovimiento(k.id)
          }
        }

        // 3. Marcar la guía como anulada (el detalle se conserva: es el
        //    sustento de qué se había despachado y por eso se pudo revertir)
        await updateGuiaDespachoVenta(id, camposAnulacion(
          { motivo, fecha, usuarioId }, { usaEstadoComprobante: false }
        ))

        // 4. Recalcular el estado de despacho de la venta
        if (guia.venta_id) await _recalcularEstadoDespachoVenta(guia.venta_id)

        _invalidarCacheVentas()
        showToast(`Guía ${guia.numero_guia} anulada ✅ — stock devuelto a Inventario`, 'success')
        await renderGuiasDespachoVenta(true)
        await renderVentas(true)
      }
    })
  } catch (e) {
    console.error('anularGuiaDespachoVenta:', e)
    showToast('Error al preparar la anulación: ' + e.message, 'danger')
  }
}

// ============================================================================
// NOTAS DE CRÉDITO Y DÉBITO — EMITIDAS AL CLIENTE
// ============================================================================
// Una nota se guarda como una venta más, con tipo_comprobante '07' o '08' y
// apuntando a la venta que modifica (venta_referencia_id). Su importe se
// guarda en positivo; el signo lo aplican los reportes vía signoDocumento().
//
// Efecto sobre la Cuenta por Cobrar del comprobante origen:
//   NC → sube `monto_notas_credito` (baja el saldo exigible)
//   ND → sube `monto_notas_debito`  (sube el saldo exigible)
// Si el motivo anula la operación (01, 02 o 06 del Catálogo 09), además se
// marca la venta original como anulada y su CxC como 'anulado'.

window.abrirModalNotaCredito = function (ventaId) { _abrirNotaVenta(ventaId, TIPO_NC) }
window.abrirModalNotaDebito  = function (ventaId) { _abrirNotaVenta(ventaId, TIPO_ND) }

async function _abrirNotaVenta(ventaId, tipoNota) {
  try {
    const venta = await getVentaById(ventaId)
    if (!venta) { showToast('No se encontró la venta', 'danger'); return }

    const numeroOrigen = `${venta.serie || ''}-${String(venta.correlativo || '').padStart(8, '0')}`
    const bloqueos = []

    if (estaAnulado(venta)) {
      bloqueos.push('El comprobante ya está anulado: no se le pueden emitir notas.')
    }
    if (esNota(venta.tipo_comprobante)) {
      bloqueos.push('Este documento ya es una nota. Las notas se emiten sobre facturas o boletas, no sobre otras notas.')
    }

    // Total ya afectado por notas previas: una NC no puede llevar el
    // comprobante a un importe negativo.
    const todas = await getVentas()
    const notasPrevias = (todas || []).filter(v => v.venta_referencia_id === ventaId && !estaAnulado(v))
    const ncPrevias = notasPrevias.filter(v => String(v.tipo_comprobante) === TIPO_NC)
      .reduce((s, v) => s + (parseFloat(v.total) || 0), 0)
    const ndPrevias = notasPrevias.filter(v => String(v.tipo_comprobante) === TIPO_ND)
      .reduce((s, v) => s + (parseFloat(v.total) || 0), 0)

    const totalOrigen = parseFloat(venta.total || 0)
    const disponibleNC = parseFloat((totalOrigen + ndPrevias - ncPrevias).toFixed(2))

    if (tipoNota === TIPO_NC && disponibleNC <= 0.01 && bloqueos.length === 0) {
      bloqueos.push(`El comprobante ya está totalmente acreditado con notas previas (${formatNumber(ncPrevias)}).`)
    }

    const cxcs = await getCuentasCobrarByVenta(ventaId)
    const cxc = (cxcs || [])[0] || null
    const saldo = cxc
      ? parseFloat(cxc.monto_total || 0) + parseFloat(cxc.monto_notas_debito || 0)
        - parseFloat(cxc.monto_notas_credito || 0) - parseFloat(cxc.monto_cobrado || 0) - parseFloat(cxc.monto_retenido || 0)
      : totalOrigen

    const cliente = await _nombreCliente(venta.contact_id)
    const cfg = getModuloConfig('ventas')
    const serieSugerida = tipoNota === TIPO_NC ? (cfg.serieNotaCredito || 'FC01') : (cfg.serieNotaDebito || 'FD01')
    const correlativo = await generarNumeroVenta(tipoNota, serieSugerida)

    await abrirModalNota({
      tipoNota, contexto: 'venta',
      documento: `${nombreTipoComprobante(venta.tipo_comprobante)} ${numeroOrigen}`,
      detalle: `${cliente} · ${venta.fecha_emision || ''} · ${venta.moneda || 'PEN'} ${formatNumber(totalOrigen)}`,
      totalOrigen: disponibleNC,
      saldoOrigen: saldo,
      igvPorcentaje: parseFloat(cfg.igvDefault) || 18,
      serieSugerida,
      numeroSugerido: String(correlativo).padStart(8, '0'),
      bloqueos,
      onEmitir: async (d) => {
        // 1. Crear la nota como un documento de venta propio
        const nota = await addVenta({
          numero: `${d.serie}-${String(d.numero || '').padStart(8, '0')}`,
          tipo_comprobante: tipoNota,
          serie: d.serie,
          correlativo: d.numero,
          contact_id: venta.contact_id,
          fecha_emision: d.fecha,
          fecha_vencimiento: null,
          periodo_contable: (d.fecha || '').slice(0, 7),
          moneda: venta.moneda || 'PEN',
          tipo_cambio: parseFloat(venta.tipo_cambio) || 1,
          base_imponible: parseFloat(d.base.toFixed(2)),
          igv: parseFloat(d.igv.toFixed(2)),
          total: parseFloat(d.importe.toFixed(2)),
          estado: 'emitida',
          estado_pago: 'pendiente',
          cpe_estado: 'no_enviado',
          vendedor_id: venta.vendedor_id || null,
          descripcion: d.descripcion,
          observaciones: `${d.motivoTexto} — ref. ${numeroOrigen}`,
          // Referencia al documento que modifica (FK + los campos de texto
          // que exige el CPE/SUNAT)
          venta_referencia_id: ventaId,
          doc_referencia_tipo: venta.tipo_comprobante,
          doc_referencia_serie: venta.serie,
          doc_referencia_numero: String(venta.correlativo || ''),
          motivo_nota_codigo: d.motivo,
          motivo_nota_texto: d.motivoTexto,
          created_by: d.usuarioId
        })

        // 2. Ajustar la Cuenta por Cobrar del comprobante original
        if (cxc) {
          try {
            const campos = tipoNota === TIPO_NC
              ? { monto_notas_credito: parseFloat((parseFloat(cxc.monto_notas_credito || 0) + d.importe).toFixed(2)) }
              : { monto_notas_debito:  parseFloat((parseFloat(cxc.monto_notas_debito || 0) + d.importe).toFixed(2)) }

            // Si la NC deja el saldo en cero, la cuenta queda saldada.
            const nuevoSaldo = parseFloat(cxc.monto_total || 0)
              + parseFloat(cxc.monto_notas_debito || 0) + (tipoNota === TIPO_ND ? d.importe : 0)
              - parseFloat(cxc.monto_notas_credito || 0) - (tipoNota === TIPO_NC ? d.importe : 0)
              - parseFloat(cxc.monto_cobrado || 0) - parseFloat(cxc.monto_retenido || 0)
            if (nuevoSaldo <= 0.01) campos.estado = d.anulaTotal ? 'anulado' : 'cobrado'

            await updateCuentaCobrar(cxc.id, campos)
          } catch (e) {
            console.warn('CxC no ajustada por la nota:', e.message)
            showToast('Nota emitida ⚠️ no se pudo ajustar la Cuenta por Cobrar: ' + e.message, 'warning')
          }
        }

        // 3. Si el motivo anula la operación, marcar el comprobante origen
        if (d.anulaTotal && tipoNota === TIPO_NC) {
          await updateVenta(ventaId, {
            ...camposAnulacion({ motivo: `Anulado por ${d.serie}-${d.numero}: ${d.motivoTexto}`, fecha: d.fecha, usuarioId: d.usuarioId }),
            estado: 'anulada'
          })
        }

        _invalidarCacheVentas()
        showToast(
          `${tipoNota === TIPO_NC ? 'Nota de Crédito' : 'Nota de Débito'} ${d.serie}-${d.numero} emitida ✅` +
          (d.anulaTotal ? ' — el comprobante origen quedó anulado' : ''),
          'success'
        )
        void nota
        await renderVentas(true)
      }
    })
  } catch (e) {
    console.error('_abrirNotaVenta:', e)
    showToast('Error al preparar la nota: ' + e.message, 'danger')
  }
}

// ============================================================================
// CAMPOS OPCIONALES Y CANDADOS DEL MODAL DE VENTA
// ============================================================================
// Descripción y Observaciones se muestran solo si el usuario los pide: el
// formulario arranca más limpio y se evita el ruido de dos campos vacíos que
// casi nunca se llenan.

window.toggleCampoOpcional = function (idGrupo, checkbox, idInput) {
  const grupo = document.getElementById(idGrupo)
  if (!grupo) return
  const abierto = !!checkbox.checked
  grupo.classList.toggle('abierto', abierto)
  const input = idInput ? document.getElementById(idInput) : null
  if (abierto) { input?.focus() }
  else if (input) { input.value = '' }   // al ocultarlo se limpia: no se guarda algo invisible
}

// Correlativo y Período llegan calculados por el sistema. Se pueden editar,
// pero hay que abrir el candado a propósito — así nadie los cambia sin querer
// y el sistema sabe que el valor es manual (para pedir confirmación al guardar).
const _camposDesbloqueados = new Set()

window.toggleCandado = function (idInput, idBoton, idAviso) {
  const input = document.getElementById(idInput)
  const boton = document.getElementById(idBoton)
  const aviso = document.getElementById(idAviso)
  if (!input || !boton) return

  const abriendo = input.readOnly
  input.readOnly = !abriendo
  boton.textContent = abriendo ? '🔓' : '🔒'
  boton.classList.toggle('abierto', abriendo)
  boton.title = abriendo ? 'Volver al valor automático' : 'Editar manualmente'
  aviso?.classList.toggle('visible', abriendo)

  if (abriendo) {
    _camposDesbloqueados.add(idInput)
    input.dataset.valorAutomatico = input.dataset.valorAutomatico ?? input.value
    input.focus()
    input.select()
  } else {
    _camposDesbloqueados.delete(idInput)
    // Al cerrar el candado se restaura el valor que había calculado el sistema.
    if (input.dataset.valorAutomatico !== undefined) input.value = input.dataset.valorAutomatico
  }
}

function _campoFueEditado(idInput) {
  const input = document.getElementById(idInput)
  if (!input || !_camposDesbloqueados.has(idInput)) return false
  return input.dataset.valorAutomatico !== undefined && input.value.trim() !== input.dataset.valorAutomatico
}

function _resetearCandados() {
  ;[['ventaCorrelativo', 'btnCandadoCorrelativo', 'aviso-correlativo'],
    ['ventaPeriodo', 'btnCandadoPeriodo', 'aviso-periodo']].forEach(([i, b, a]) => {
    const input = document.getElementById(i)
    const boton = document.getElementById(b)
    if (input) { input.readOnly = true; delete input.dataset.valorAutomatico }
    if (boton) { boton.textContent = '🔒'; boton.classList.remove('abierto') }
    document.getElementById(a)?.classList.remove('visible')
    _camposDesbloqueados.delete(i)
  })
}

function _resetearCamposOpcionales() {
  ;[['grupo-venta-descripcion', 'chkVentaDescripcion', 'ventaDescripcion'],
    ['grupo-venta-observaciones', 'chkVentaObservaciones', 'ventaObservaciones']].forEach(([g, c, i]) => {
    document.getElementById(g)?.classList.remove('abierto')
    const chk = document.getElementById(c); if (chk) chk.checked = false
    const inp = document.getElementById(i); if (inp) inp.value = ''
  })
}

// ============================================================================
// CORRELATIVO SUGERIDO
// ============================================================================
// Se recalcula al abrir el modal y cada vez que cambian el tipo o la serie,
// porque el correlativo es por serie: F001 y B001 llevan numeraciones
// independientes.

async function _sugerirCorrelativoVenta() {
  const input = document.getElementById('ventaCorrelativo')
  if (!input || _camposDesbloqueados.has('ventaCorrelativo')) return
  try {
    const tipo  = document.getElementById('ventaTipoComp')?.value || '01'
    const serie = document.getElementById('ventaSerie')?.value?.trim() || (tipo === '03' ? 'B001' : 'F001')
    const n = await generarNumeroVenta(tipo, serie)
    input.value = String(n).padStart(8, '0')
    input.dataset.valorAutomatico = input.value
  } catch (e) {
    console.warn('No se pudo sugerir el correlativo:', e.message)
  }
}

window.onCambiarTipoCompVenta = function () {
  const tipo = document.getElementById('ventaTipoComp')?.value
  const serieEl = document.getElementById('ventaSerie')
  const cfg = getModuloConfig('ventas')
  // La serie sigue al tipo salvo que el usuario ya la haya escrito a mano.
  if (serieEl && !serieEl.dataset.manual) {
    serieEl.value = tipo === '03' ? (cfg.serieBoleta || 'B001') : (cfg.serieFactura || 'F001')
  }
  _sugerirCorrelativoVenta()
}

window.onCambiarSerieVenta = function () {
  const serieEl = document.getElementById('ventaSerie')
  if (serieEl) serieEl.dataset.manual = '1'
  clearTimeout(window._tSerieVenta)
  window._tSerieVenta = setTimeout(_sugerirCorrelativoVenta, 350)
}

window._prepararCamposVenta = async function () {
  _resetearCandados()
  _resetearCamposOpcionales()
  const serieEl = document.getElementById('ventaSerie')
  if (serieEl) delete serieEl.dataset.manual
  await _sugerirCorrelativoVenta()
}

/**
 * Valida el período y el correlativo manuales antes de guardar.
 * Devuelve false si el usuario cancela.
 */
async function _confirmarCamposManualesVenta(periodo, correlativo) {
  const avisos = []

  if (_campoFueEditado('ventaPeriodo')) {
    const auto = document.getElementById('ventaPeriodo').dataset.valorAutomatico
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(periodo || '')) {
      showToast('El período contable debe tener el formato AAAA-MM (ej. 2026-08)', 'warning')
      return false
    }
    avisos.push(
      `PERÍODO CONTABLE modificado a mano:\n` +
      `   automático: ${auto}\n` +
      `   se guardará: ${periodo}\n` +
      `   Esto define en qué mes declara esta venta ante SUNAT.`
    )
  }

  if (_campoFueEditado('ventaCorrelativo')) {
    const auto = document.getElementById('ventaCorrelativo').dataset.valorAutomatico
    avisos.push(
      `N° DE COMPROBANTE modificado a mano:\n` +
      `   sugerido: ${auto}\n` +
      `   se guardará: ${String(correlativo).padStart(8, '0')}\n` +
      `   Verifica que no duplique ni salte la correlatividad de la serie.`
    )
  }

  if (avisos.length === 0) return true
  return confirm(`⚠ Vas a guardar con datos editados manualmente:\n\n${avisos.join('\n\n')}\n\n¿Confirmar y guardar la venta?`)
}

// ============================================================================
// IMPORTACIÓN MASIVA DE GUÍAS DE DESPACHO
// ============================================================================
// Espejo del importador de Guías de Ingreso, pero en sentido contrario: aquí
// se DESCUENTA stock. Por eso la validación es más estricta — se comprueba
// que el lote exista, que esté en la zona indicada y que tenga cantidad
// suficiente, acumulando las reservas de todas las filas del archivo que
// toquen el mismo lote+zona (dos guías del mismo lote no pueden llevarse cada
// una el stock completo).
//
// El modo simulación es aún más importante que en compras: si el archivo
// falla a mitad, el stock queda descuadrado sin registro que lo explique.

window.abrirModalImportarGuiasDespacho = function () {
  const input = document.getElementById('fileImportarGuiasDespacho')
  if (input) input.value = ''
  const chk = document.getElementById('chkSimularGuiasDespacho')
  if (chk) chk.checked = true
  _htmlV('importar-guias-despacho-resumen', '')
  _htmlV('importar-guias-despacho-log', '')
  window.openModal('modal-importar-guias-despacho')
}

window.descargarPlantillaGuiasDespacho = async function () {
  const { descargarCSV } = await import('./reportes.js')
  descargarCSV('plantilla_guias_despacho.csv', [
    ['numero_guia', 'fecha_guia', 'venta_numero', 'sku', 'cantidad', 'numero_unidades',
     'numero_lote', 'almacen', 'zona', 'observaciones'],
    ['T001-00000045', '2026-02-10', 'F001-00000123', 'SKU-001', '3816', '9',
     'HR-Q0830721', 'SJL2', 'Zona A', 'Salida parcial'],
    ['T001-00000045', '2026-02-10', 'F001-00000123', 'SKU-001', '424', '1',
     'HR-Q0830722', 'SJL2', 'Zona A', '']
  ])
}

function _htmlV(id, contenido) { const el = document.getElementById(id); if (el) el.innerHTML = contenido }

function _valorFilaV(fila, ...nombres) {
  for (const n of nombres) {
    if (fila[n] !== undefined && fila[n] !== null && String(fila[n]).trim() !== '') return String(fila[n]).trim()
  }
  return ''
}

window.procesarImportacionGuiasDespacho = async function () {
  const btn     = document.getElementById('btnProcesarImportarGuiasDespacho')
  const input   = document.getElementById('fileImportarGuiasDespacho')
  const simular = !!document.getElementById('chkSimularGuiasDespacho')?.checked
  if (btn?.disabled) return

  const file = input?.files?.[0]
  if (!file) { showToast('Selecciona un archivo primero', 'warning'); return }

  const log = []
  const anotar = (tipo, texto) => log.push({ tipo, texto })

  try {
    if (btn) { btn.disabled = true; btn.textContent = simular ? 'Simulando...' : 'Importando...' }
    _htmlV('importar-guias-despacho-resumen', '<p style="color:var(--text-secondary);">Leyendo archivo...</p>')
    _htmlV('importar-guias-despacho-log', '')

    const user = await getCurrentUser()
    if (!user) { showToast('Usuario no autenticado', 'danger'); return }

    let filas
    try {
      filas = await _leerArchivoImportVentas(file)
    } catch (e) {
      _htmlV('importar-guias-despacho-resumen', '<p style="color:var(--color-danger);">No se pudo leer el archivo. Verifica que sea un .xlsx o .csv válido.</p>')
      return
    }
    if (!filas?.length) {
      _htmlV('importar-guias-despacho-resumen', '<p style="color:var(--color-danger);">El archivo no tiene filas de datos.</p>')
      return
    }

    const [ventas, items, lotesTodos, stockTodo, zonas, almacenes, guiasExistentes] = await Promise.all([
      getVentas(), getItems(), getLotes(), getStockUbicaciones(),
      getUbicaciones(), getAlmacenes(), getGuiasDespachoVenta(true)
    ])

    // La venta se puede referenciar por `numero` o por "serie-correlativo".
    const ventaPorClave = new Map()
    for (const v of (ventas || [])) {
      const claves = [v.numero, `${v.serie || ''}-${String(v.correlativo || '').padStart(8, '0')}`]
      for (const k of claves) if (k) ventaPorClave.set(String(k).trim().toUpperCase(), v)
    }
    const itemPorSku = new Map((items || []).filter(i => i.sku).map(i => [String(i.sku).trim().toUpperCase(), i]))
    const almacenPorId = new Map((almacenes || []).map(a => [a.id, a]))
    const guiasYaUsadas = new Set((guiasExistentes || []).map(g => String(g.numero_guia || '').trim().toUpperCase()))

    const zonaPorClave = new Map()
    const zonaPorNombreSolo = new Map()
    for (const z of (zonas || [])) {
      const alm = almacenPorId.get(z.almacen_id)
      if (alm?.es_virtual) continue
      zonaPorClave.set(`${String(alm?.nombre || '').trim().toUpperCase()}|${String(z.nombre || '').trim().toUpperCase()}`, z)
      const solo = String(z.nombre || '').trim().toUpperCase()
      zonaPorNombreSolo.set(solo, zonaPorNombreSolo.has(solo) ? null : z)
    }

    const lotePorItemNumero = new Map()
    for (const l of (lotesTodos || [])) {
      if (!l.item_id || !l.numero_lote) continue
      lotePorItemNumero.set(`${l.item_id}|${String(l.numero_lote).trim().toUpperCase()}`, l)
    }

    // Copia mutable del stock: cada línea validada "reserva" su cantidad, para
    // que dos filas del mismo lote+zona no pasen ambas la validación.
    const stockLocal = new Map()
    for (const su of (stockTodo || [])) stockLocal.set(su.id, { ...su })

    // Ya despachado por cada línea de venta (guías previas no anuladas).
    const guiasAnuladas = new Set((guiasExistentes || []).filter(g => g.estado === 'anulada').map(g => g.id))
    const despachosPrevios = await getDetalleGuiasDespachoVenta()
    const yaDespachadoPorDetalle = new Map()
    for (const d of (despachosPrevios || [])) {
      if (guiasAnuladas.has(d.guia_id)) continue
      yaDespachadoPorDetalle.set(d.detalle_venta_id, (yaDespachadoPorDetalle.get(d.detalle_venta_id) || 0) + (parseFloat(d.cantidad) || 0))
    }

    // ── Agrupar por N° de guía ────────────────────────────────────────────
    const grupos = new Map()
    filas.forEach((fila, i) => {
      const numeroGuia = _valorFilaV(fila, 'numero_guia', 'guia', 'nro_guia')
      if (!numeroGuia) { anotar('error', `Fila ${i + 2}: sin numero_guia, se omite`); return }
      const clave = numeroGuia.toUpperCase()
      if (!grupos.has(clave)) grupos.set(clave, { numeroGuia, filas: [] })
      grupos.get(clave).filas.push({ fila, nroFila: i + 2 })
    })

    // ── Validación completa ───────────────────────────────────────────────
    const guiasValidas = []
    let filasConError = 0

    for (const [clave, grupo] of grupos) {
      const errores = []
      if (guiasYaUsadas.has(clave)) errores.push(`la guía ${grupo.numeroGuia} ya existe`)

      const primera = grupo.filas[0].fila
      const ventaClave = _valorFilaV(primera, 'venta_numero', 'venta', 'comprobante', 'numero_documento').toUpperCase()
      const venta = ventaPorClave.get(ventaClave)
      if (!venta) errores.push(`no se encontró la venta "${ventaClave || '(vacío)'}"`)
      else if (estaAnulado(venta)) errores.push(`la venta ${ventaClave} está anulada`)

      const fechaGuia = _parseFechaImportVentas(_valorFilaV(primera, 'fecha_guia', 'fecha'))
      if (!fechaGuia) errores.push('fecha_guia inválida o vacía')

      const detallesVenta = venta ? await getDetalleVentas(venta.id) : []
      const lineas = []

      for (const { fila, nroFila } of grupo.filas) {
        const errFila = []

        const sku  = _valorFilaV(fila, 'sku', 'codigo', 'producto').toUpperCase()
        const item = itemPorSku.get(sku)
        if (!item) errFila.push(`SKU "${sku || '(vacío)'}" no existe`)

        const cantidad = parseFloat(_valorFilaV(fila, 'cantidad', 'cantidad_kg', 'kg') || 0)
        if (!(cantidad > 0)) errFila.push('cantidad debe ser mayor a 0')
        const unidades = parseFloat(_valorFilaV(fila, 'numero_unidades', 'unidades') || 0) || 0

        const numeroLote = _valorFilaV(fila, 'numero_lote', 'lote')
        if (!numeroLote) errFila.push('falta numero_lote')

        const almacenNom = _valorFilaV(fila, 'almacen', 'almacén').toUpperCase()
        const zonaNom    = _valorFilaV(fila, 'zona', 'ubicacion', 'ubicación').toUpperCase()
        let zona = zonaPorClave.get(`${almacenNom}|${zonaNom}`)
        if (!zona && !almacenNom && zonaNom) {
          const unica = zonaPorNombreSolo.get(zonaNom)
          if (unica === null) errFila.push(`la zona "${zonaNom}" existe en varios almacenes: indica también almacen`)
          else zona = unica
        }
        if (!zona) errFila.push(`no se encontró la zona "${almacenNom ? almacenNom + ' / ' : ''}${zonaNom || '(vacío)'}"`)

        // La línea de venta a la que corresponde este despacho.
        const detalleVenta = item ? (detallesVenta || []).find(d => d.item_id === item.id) : null
        if (venta && item && !detalleVenta) {
          errFila.push(`el producto ${item.nombre} no figura en el detalle de la venta ${ventaClave}`)
        }

        // Lote + stock disponible en esa zona, descontando lo ya reservado
        // por filas anteriores de este mismo archivo.
        let filaStock = null
        if (item && numeroLote && zona) {
          const lote = lotePorItemNumero.get(`${item.id}|${numeroLote.toUpperCase()}`)
          if (!lote) {
            errFila.push(`el lote "${numeroLote}" no existe para ${item.nombre}`)
          } else {
            filaStock = Array.from(stockLocal.values()).find(su => su.lote_id === lote.id && su.ubicacion_id === zona.id)
            if (!filaStock) {
              errFila.push(`el lote ${numeroLote} no tiene stock en ${zonaNom}`)
            } else if ((parseFloat(filaStock.cantidad) || 0) + 0.0001 < cantidad) {
              errFila.push(`stock insuficiente en lote ${numeroLote} / ${zonaNom}: disponible ${formatQty(filaStock.cantidad)}, pedido ${formatQty(cantidad)}`)
            }
          }
        }

        if (errFila.length > 0) {
          filasConError++
          anotar('error', `Fila ${nroFila} (guía ${grupo.numeroGuia}): ${errFila.join(' · ')}`)
          continue
        }

        // Reserva local (solo en la copia; el stock real no se toca aún)
        filaStock.cantidad = parseFloat(((parseFloat(filaStock.cantidad) || 0) - cantidad).toFixed(4))
        filaStock.cantidad_unidades = parseFloat(Math.max(0, (parseFloat(filaStock.cantidad_unidades) || 0) - unidades).toFixed(4))

        const lote = lotePorItemNumero.get(`${item.id}|${numeroLote.toUpperCase()}`)
        lineas.push({ nroFila, item, cantidad, unidades, lote, zona, detalleVenta, filaStockId: filaStock.id })
      }

      if (errores.length > 0 || lineas.length === 0) {
        anotar('error', `Guía ${grupo.numeroGuia}: ${errores.length ? errores.join(' · ') : 'sin líneas válidas'} — no se importará`)
        continue
      }

      // Aviso (no bloqueo) si se despacha más de lo vendido: puede ser un
      // error de digitación, pero también un ajuste legítimo por peso.
      const porDetalle = new Map()
      for (const l of lineas) {
        if (!l.detalleVenta) continue
        porDetalle.set(l.detalleVenta.id, (porDetalle.get(l.detalleVenta.id) || 0) + l.cantidad)
      }
      for (const [detId, cant] of porDetalle) {
        const det = (detallesVenta || []).find(d => d.id === detId)
        const pendiente = (parseFloat(det?.cantidad) || 0) - (yaDespachadoPorDetalle.get(detId) || 0)
        if (cant > pendiente + 0.0001) {
          anotar('error', `Guía ${grupo.numeroGuia}: se despachan ${formatQty(cant)} de "${det?.descripcion || ''}" pero solo quedan ${formatQty(pendiente)} pendientes (se importará igual)`)
        }
      }

      guiasValidas.push({ numeroGuia: grupo.numeroGuia, fechaGuia, venta, lineas,
        observaciones: _valorFilaV(primera, 'observaciones', 'observacion') || null })
      guiasYaUsadas.add(clave)
    }

    const totalLineas = guiasValidas.reduce((s, g) => s + g.lineas.length, 0)
    const totalKg     = guiasValidas.reduce((s, g) => s + g.lineas.reduce((s2, l) => s2 + l.cantidad, 0), 0)

    if (guiasValidas.length === 0) {
      _htmlV('importar-guias-despacho-resumen', '<p style="color:var(--color-danger);">Ninguna guía se puede importar. Revisa el detalle de abajo.</p>')
      _pintarLogImportV('importar-guias-despacho-log', log)
      return
    }

    if (simular) {
      _htmlV('importar-guias-despacho-resumen', `
        <div style="padding:12px 14px; background:var(--bg-secondary); border-radius:var(--radius-md); border-left:3px solid var(--color-info);">
          <strong>Simulación — no se grabó nada</strong>
          <div style="margin-top:8px; font-size:0.88rem; line-height:1.7;">
            Guías a crear: <strong>${guiasValidas.length}</strong><br>
            Líneas: <strong>${totalLineas}</strong> · Stock a descontar: <strong>${formatQty(totalKg)}</strong><br>
            ${filasConError > 0 ? `<span style="color:var(--color-danger);">Filas con error que se omitirán: <strong>${filasConError}</strong></span>` : '<span style="color:var(--color-success);">Sin errores ✅</span>'}
          </div>
          <div style="margin-top:10px; font-size:0.85rem; color:var(--text-secondary);">
            Si el resultado es correcto, desmarca "Simular primero" y vuelve a procesar.
          </div>
        </div>`)
      _pintarLogImportV('importar-guias-despacho-log', log)
      return
    }

    // ── Escritura real ────────────────────────────────────────────────────
    let creadas = 0, fallidas = 0
    const zonaClientes = await getUbicacionCustomers()
    const ventasTocadas = new Set()

    for (const g of guiasValidas) {
      try {
        const guia = await addGuiaDespachoVenta({
          venta_id: g.venta.id, numero_guia: g.numeroGuia, fecha_guia: g.fechaGuia,
          observaciones: g.observaciones, created_by: user.db_id
        })
        if (!guia?.id) throw new Error('no se pudo crear la cabecera de la guía')

        for (const l of g.lineas) {
          const loteFresco = await getLoteById(l.lote.id)
          const costoUnit = parseFloat(loteFresco?.costo_unitario) || 0

          // Lote
          await updateLote(l.lote.id, {
            cantidad: parseFloat(Math.max(0, (parseFloat(loteFresco?.cantidad) || 0) - l.cantidad).toFixed(4)),
            cantidad_unidades: parseFloat(Math.max(0, (parseFloat(loteFresco?.cantidad_unidades) || 0) - l.unidades).toFixed(4))
          })

          // Stock de la zona
          const filasLote = await getStockUbicacionesByLote(l.lote.id)
          const filaZona = (filasLote || []).find(f => f.ubicacion_id === l.zona.id)
          if (filaZona) {
            await updateStockUbicacion(filaZona.id, {
              cantidad: parseFloat(Math.max(0, (parseFloat(filaZona.cantidad) || 0) - l.cantidad).toFixed(4)),
              cantidad_unidades: parseFloat(Math.max(0, (parseFloat(filaZona.cantidad_unidades) || 0) - l.unidades).toFixed(4))
            })
          }

          const valorSalida = parseFloat((l.cantidad * costoUnit).toFixed(2))
          await addKardexMovimiento({
            item_id: l.item.id, lote_id: l.lote.id,
            ubicacion_origen_id: l.zona.id,
            ubicacion_destino_id: zonaClientes?.id || null,
            fecha: g.fechaGuia, tipo_movimiento: 'salida',
            concepto: 'Venta - despacho a cliente (importado)',
            documento_referencia: g.numeroGuia,
            cantidad_entrada: 0, cantidad_salida: l.cantidad,
            cantidad_unidades_entrada: 0, cantidad_unidades_salida: l.unidades,
            costo_unitario: costoUnit, valor_entrada: 0, valor_salida: valorSalida,
            venta_id: g.venta.id, created_by: user.db_id
          })

          await addDetalleGuiaDespachoVenta({
            guia_id: guia.id, detalle_venta_id: l.detalleVenta?.id || null,
            item_id: l.item.id, cantidad: l.cantidad, cantidad_unidades: l.unidades || 0,
            lote_id: l.lote.id, ubicacion_id: l.zona.id, numero_lote: l.lote.numero_lote
          })
        }

        ventasTocadas.add(g.venta.id)
        creadas++
        anotar('ok', `Guía ${g.numeroGuia}: ${g.lineas.length} línea(s) despachada(s)`)
      } catch (e) {
        fallidas++
        anotar('error', `Guía ${g.numeroGuia}: ${e.message}`)
      }
    }

    // El estado de despacho se recalcula una vez por venta al final, no por
    // línea: si una venta tuvo 3 guías en el archivo, calcularlo 3 veces sería
    // trabajo repetido y el resultado intermedio sería incorrecto.
    for (const ventaId of ventasTocadas) {
      try { await _recalcularEstadoDespachoVenta(ventaId) } catch (e) { console.warn('estado_despacho:', e.message) }
    }

    _htmlV('importar-guias-despacho-resumen', `
      <div style="padding:12px 14px; background:var(--bg-secondary); border-radius:var(--radius-md); border-left:3px solid ${fallidas ? 'var(--color-warning)' : 'var(--color-success)'};">
        <strong>Importación terminada</strong>
        <div style="margin-top:8px; font-size:0.88rem; line-height:1.7;">
          Guías creadas: <strong style="color:var(--color-success);">${creadas}</strong><br>
          Guías con error: <strong style="color:${fallidas ? 'var(--color-danger)' : 'var(--text-secondary)'};">${fallidas}</strong><br>
          Filas omitidas por validación: <strong>${filasConError}</strong><br>
          Ventas con estado de despacho recalculado: <strong>${ventasTocadas.size}</strong>
        </div>
      </div>`)
    _pintarLogImportV('importar-guias-despacho-log', log)

    _invalidarCacheVentas()
    await renderGuiasDespachoVenta(true)
    await renderVentas(true)
    showToast(`${creadas} guía(s) de despacho importada(s)`, creadas ? 'success' : 'warning')
  } catch (error) {
    console.error('procesarImportacionGuiasDespacho:', error)
    _htmlV('importar-guias-despacho-resumen', `<p style="color:var(--color-danger);">Error inesperado: ${_esc(error.message)}</p>`)
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Procesar' }
  }
}

function _pintarLogImportV(idContenedor, log) {
  const errores = log.filter(l => l.tipo === 'error')
  const oks     = log.filter(l => l.tipo === 'ok')
  _htmlV(idContenedor, [
    ...errores.map(l => `<div style="padding:4px 0; color:var(--color-danger);">✕ ${_esc(l.texto)}</div>`),
    ...oks.map(l => `<div style="padding:4px 0; color:var(--color-success);">✓ ${_esc(l.texto)}</div>`)
  ].join('') || '<div style="color:var(--text-secondary);">Sin observaciones.</div>')
}

// ============================================================================
// CRONOGRAMA DE PAGO EN NUEVA VENTA
// ============================================================================
// La Fecha de Vencimiento del comprobante dejó de digitarse: ahora la calcula
// el cronograma (es el vencimiento de la ÚLTIMA cuota). Antes el onchange de
// Fecha Emisión la sobrescribía con el mismo valor, así que toda venta nacía
// vencida el día que se emitía — por eso el reporte de antigüedad mostraba
// casi todo en "1-30 días" en vez de "por vencer".

let _cronogramaVentaListo = false

window.onCambiarFechaEmisionVenta = function () {
  const fecha = document.getElementById('ventaFechaEmision')?.value
  if (!fecha) return
  // El período contable sigue a la fecha de emisión salvo que se haya
  // desbloqueado el candado para escribirlo a mano.
  const periodoEl = document.getElementById('ventaPeriodo')
  if (periodoEl && periodoEl.readOnly) {
    periodoEl.value = fecha.slice(0, 7)
    periodoEl.dataset.valorAutomatico = periodoEl.value
  }
  if (_cronogramaVentaListo) actualizarCronograma('venta-cronograma', { fechaEmision: fecha })
}

/** Se llama al abrir el modal y cada vez que cambia el total de la venta. */
async function _prepararCronogramaVenta(forzarRender = false) {
  const cont = document.getElementById('venta-cronograma')
  if (!cont) return

  const total = parseFloat((document.getElementById('ventaTotalFinal')?.textContent || '0').replace(/,/g, '')) || 0
  const fechaEmision = document.getElementById('ventaFechaEmision')?.value || new Date().toISOString().slice(0, 10)

  if (!_cronogramaVentaListo || forzarRender) {
    // El término del cliente solo PRECARGA el selector: la condición real se
    // negocia por operación, así que la venta guarda la suya y nunca se
    // reescribe la ficha del contacto desde aquí.
    const contactId = parseInt(document.getElementById('ventaContactId')?.value || 0)
    const cliente = _clientes.find(c => c.id === contactId)

    await renderEditorCronograma('venta-cronograma', {
      total, fechaEmision, aplicaA: 'venta',
      terminoId: cliente?.termino_pago_id || null,
      onCambio: (crono) => {
        // La fecha de vencimiento del comprobante = última cuota.
        const ultima = crono?.cuotas?.[crono.cuotas.length - 1]
        const fv = document.getElementById('ventaFechaVencimiento')
        if (fv && ultima) fv.value = ultima.fecha_vencimiento
      }
    })
    _cronogramaVentaListo = true
  } else {
    actualizarCronograma('venta-cronograma', { total, fechaEmision })
  }
}

/** El cronograma se re-prorratea cada vez que cambian las líneas de la venta. */
window._refrescarCronogramaVenta = function () {
  if (_cronogramaVentaListo) _prepararCronogramaVenta(false)
}

/**
 * Guarda el cronograma como cuotas de la CxC recién creada.
 * Si algo falla, NO se revierte la venta: la factura ya está emitida y es lo
 * crítico; las cuotas se pueden regenerar después desde Cuentas x Cobrar.
 */
async function _guardarCuotasDeCxC(cxcId, crono) {
  if (!cxcId || !crono?.cuotas?.length) return
  for (const c of crono.cuotas) {
    try {
      await addCuotaCobrar({
        cxc_id: cxcId,
        numero_cuota: c.numero_cuota,
        fecha_vencimiento: c.fecha_vencimiento,
        monto: parseFloat(c.monto.toFixed(2)),
        monto_cobrado: 0, monto_retenido: 0, monto_canjeado: 0,
        estado: 'pendiente',
        hito: c.hito || null
      })
    } catch (e) {
      console.warn(`Cuota ${c.numero_cuota} no se pudo crear:`, e.message)
      showToast(`⚠️ La cuota ${c.numero_cuota} no se guardó: ${e.message}`, 'warning')
    }
  }
}

void getCuotasCobrarByCxC
void leerCronograma

// ============================================================================
// AVISO DE LÍNEA DE CRÉDITO
// ============================================================================
// Avisa, no bloquea: la decisión de vender por encima del límite es comercial,
// no del sistema. Se puede endurecer desde Configuración → Ventas si algún día
// hace falta.

async function _avisarCreditoCliente() {
  const aviso = document.getElementById('ventaClienteRetencionAviso')
  if (!aviso) return
  const contactId = parseInt(document.getElementById('ventaContactId')?.value || 0)
  if (!contactId) return

  const cliente = _clientes.find(c => c.id === contactId)
  const linea = parseFloat(cliente?.linea_credito) || 0
  if (linea <= 0) return   // 0 = sin límite definido

  try {
    const { cacheado } = await import('./data-cache.js')
    const cxcs = await cacheado('cuentas_cobrar', getCuentasCobrar)
    const deuda = (cxcs || [])
      .filter(c => c.contact_id === contactId && c.estado !== 'cobrado' && c.estado !== 'anulado')
      .reduce((s, c) => s + (
        parseFloat(c.monto_total || 0) + parseFloat(c.monto_notas_debito || 0)
        - parseFloat(c.monto_notas_credito || 0) - parseFloat(c.monto_cobrado || 0)
        - parseFloat(c.monto_retenido || 0) - parseFloat(c.monto_canjeado || 0)
      ), 0)

    if (deuda > linea) {
      aviso.style.display = 'block'
      aviso.style.color = 'var(--color-danger)'
      aviso.textContent = `⚠ Este cliente supera su línea de crédito: debe ${formatNumber(deuda)} de un tope de ${formatNumber(linea)}. Puedes continuar, es solo un aviso.`
    } else if (deuda > linea * 0.8) {
      aviso.style.display = 'block'
      aviso.style.color = 'var(--color-warning)'
      aviso.textContent = `Línea de crédito al ${((deuda / linea) * 100).toFixed(0)}%: debe ${formatNumber(deuda)} de ${formatNumber(linea)}.`
    }
  } catch (e) {
    console.warn('No se pudo evaluar la línea de crédito:', e.message)
  }
}

void getCuentasCobrar
