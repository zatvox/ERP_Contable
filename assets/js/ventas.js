// ============================================================================
// VENTAS.JS — Módulo Ventas: Cotizaciones + Facturación Electrónica (NUBEFACT)
// ============================================================================

import { getCurrentUser } from './auth-supabase.js'
import { registrarColumnas, colStyle } from './col-menu.js'
import {
  getSalesQuotes, getSalesQuoteById, addSalesQuote, updateSalesQuote,
  getCustomers, getContactById, addContact, updateContact, deleteContact, tiposDeContacto, getContactsByType,
  getLotes, getLoteById, updateLote, addLote,
  getItems, getItemById, addItem,
  getCategorias, addCategoria,
  addVenta, getVentas, getVentaById, updateVenta, deleteVenta,
  addDetalleVenta, getDetalleVentas, getTodosDetalleVentas, updateDetalleVenta, deleteDetalleVenta,
  getSuppliers,
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
  invalidateGuiasDespachoVentaCache,
  getLoteBultosDisponiblesZona, updateLoteBulto, recalcularLoteDesdeBultos, revertirBultosDeDetalleGuiaDespacho,
  getLoteBultosByLote, reingresarBultosPorNotaCredito, addNotaCreditoVentaDetalle,
  getTodosVentasAnticiposAplicados, getAnticiposAplicadosPorAnticipoVenta, getAnticiposAplicadosPorDestinoVenta, addVentaAnticipoAplicado
} from './supabase-data.js'
import { emitirCPE, emitirNota, attachRucAutocomplete, attachConsultaDocumento, getTCVenta, pintarBadgeSunat } from './sunat-api.js'
import { showToast, formatNumber, formatQty } from './helpers.js'
import { initModuleNavDropdowns, initSubtabs, menuAccionesFila } from './main.js'
import { abrirModalAnulacion, camposAnulacion, estaAnulado, badgeAnulado, ESTILO_FILA_ANULADA } from './anulacion.js'
import { abrirModalNota, TIPO_NC, TIPO_ND, esNota, signoDocumento, nombreTipoComprobante, badgeTipoDocumento } from './notas.js'
import { convertirEnBuscador, refrescarBuscador } from './buscador-select.js'
import { renderEditorCronograma, actualizarCronograma, leerCronograma, getTerminosConCuotas, cargarCuotasExistentes, generarCronograma, cronogramaDesdeTexto } from './cronograma.js'
import { cacheado } from './data-cache.js'
import { crearReporte, nombreMes } from './reportes.js'
import { getModuloConfig, renderConfiguracionTab, aplicarPreferenciasVista } from './config-modulo.js'

// Escapa HTML al inyectar texto libre en innerHTML (nombres de cliente,
// motivos de anulación, mensajes de error, etc.) — mismo helper que ya
// existe en cada módulo del ERP (bancos.js, cobranzas.js, anulacion.js...);
// ventas.js lo llamaba en varios sitios pero nunca lo definía (bug real:
// ReferenceError: _esc is not defined al abrir "Editar Venta", entre otros).
function _esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

// ============================================================================
// ESTADO LOCAL
// ============================================================================

let _clientes  = []
let _items     = []
let _lotes     = []
let _vendedores = []    // contacts con tipo_contacto incluye 'vendedor'
let _ventaLineas = []   // líneas del modal de nueva venta
let _ventaLineaEditIdx = null   // índice en _ventaLineas que se está editando (null = agregando una nueva)
let _almacenes = []
let _zonas     = []     // ubicaciones (con almacen_id)
let _stockUbic = []     // stock_ubicaciones: cuánto de cada lote hay en cada zona
let _lotesMap  = {}     // lote.id -> lote (para resolver item_id/fecha_ingreso rápido)

// Tipo actualmente seleccionado en el modal unificado de Nueva Venta:
// 'mercaderia' | 'anticipo' — espejo de _tipoCompraActual en compras.js.
let _tipoVentaActual = 'mercaderia'
let _anticiposVentaDisponiblesCache = []

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

    // Botón "Consultar" en el modal Nuevo Cliente (RUC o DNI, según Tipo Documento)
    attachConsultaDocumento({
      btnId: 'btnConsultarCliRUC', tipoDocId: 'cliTipoDocumento', numeroId: 'cliRUC',
      nombreId: 'cliNombre', direccionId: 'cliDireccion', distritoId: 'cliDistrito', paisId: 'cliPais',
      sunatSectionId: 'cliDatosSunat', estadoId: 'cliEstadoSunat', condicionId: 'cliCondicionSunat',
      buenContribuyenteId: 'cliBuenContribuyenteSunat', agenteRetencionId: 'cliSujetoRetencion',
      agenteRetencionBadgeId: 'cliAgenteRetencionSunat'
    })

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
  _cargarAnticiposDisponiblesCliente()
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
// El stock real por zona vive en stock_ubicaciones (lote_id + ubicacion_id),
// pero en "Agregar Producto a la Venta" ya NO se elige zona/lote fila por
// fila: eso duplicaba trabajo con la Guía de Despacho y, en pedidos grandes
// con varios lotes por producto, hacía fácil descuadrar base imponible/IGV
// al ir sumando líneas parciales. Ahora se captura el TOTAL de kg por
// producto y solo se valida contra el stock TOTAL (todas las zonas/lotes
// sumadas); el desglose de lotes de abajo es informativo. La selección real
// de qué lote/zona se despacha queda exclusivamente en Guía de Despacho.

/**
 * Suma de stock disponible (todas las zonas reales, sin virtuales) para un
 * ítem, más el desglose de lotes en orden FIFO (más antiguo primero) — lo
 * que se usaría si se despachara ahora mismo. Puramente informativo acá.
 */
function _stockTotalPorItem(itemId) {
  if (!itemId) return { totalKg: 0, totalUnid: 0, lotes: [] }
  const almacenesMap = {}
  for (const a of (_almacenes || [])) almacenesMap[a.id] = a
  const zonasMap = {}
  for (const z of (_zonas || [])) zonasMap[z.id] = z

  // Las zonas virtuales (Partners/Vendors, Partners/Customers) son solo
  // para el Kardex — nunca stock real vendible.
  const filas = (_stockUbic || [])
    .filter(su => {
      if ((parseFloat(su.cantidad) || 0) <= 0) return false
      if (_lotesMap[su.lote_id]?.item_id !== itemId) return false
      const zona = zonasMap[su.ubicacion_id]
      if (!zona) return false
      return !almacenesMap[zona.almacen_id]?.es_virtual
    })
    .sort((a, b) => new Date(_lotesMap[a.lote_id]?.fecha_ingreso || 0) - new Date(_lotesMap[b.lote_id]?.fecha_ingreso || 0))

  let totalKg = 0, totalUnid = 0
  const lotes = filas.map(su => {
    const lote = _lotesMap[su.lote_id]
    const disp = parseFloat(su.cantidad) || 0
    const dispUnid = parseFloat(su.cantidad_unidades) || 0
    totalKg += disp
    totalUnid += dispUnid
    const zona = zonasMap[su.ubicacion_id]
    const almacen = zona ? almacenesMap[zona.almacen_id] : null
    return {
      lote_id: su.lote_id,
      numero_lote: lote?.numero_lote || '?',
      disp, dispUnid,
      costo_unitario: parseFloat(lote?.costo_unitario || 0),
      zonaNombre: zona ? `${almacen?.nombre || '?'} — ${zona.nombre}` : '?'
    }
  })

  return { totalKg, totalUnid, lotes }
}

// Sugiere N° de Unidades a partir del peso_por_unidad promedio del stock
// disponible del producto (el campo queda editable: es solo una sugerencia
// inicial, ahora que ya no hay un único lote elegido del que tomar el dato).
function _sugerirUnidadesLineaVenta() {
  const inpUnid = document.getElementById('ventaLineaCantUnidades')
  const itemId = parseInt(document.getElementById('ventaItemSelect')?.value || 0)
  const { totalKg, totalUnid } = _stockTotalPorItem(itemId)

  if (inpUnid) {
    const cantidad = parseFloat(document.getElementById('ventaLineaCantidad')?.value || 0)
    if (itemId && totalKg > 0 && totalUnid > 0) {
      const pesoPorUnidadProm = totalKg / totalUnid
      inpUnid.value = parseFloat((cantidad / pesoPorUnidadProm).toFixed(2))
      inpUnid.placeholder = 'Aproximado (promedio del stock) — ajusta si hace falta'
    } else {
      inpUnid.value = ''
      inpUnid.placeholder = itemId ? 'Este producto no trackea unidades' : '—'
    }
  }

  // Centralizado acá porque este helper ya se llama desde los puntos que
  // pueden cambiar el total de la línea (producto, cantidad) — evita
  // repetir la llamada en cada handler.
  window._actualizarPreviewLineaVenta()
}

/**
 * Recalcula Subtotal/IGV/Total EN VIVO dentro del modal "Agregar/Editar
 * Producto", antes de guardar la línea — mismo cálculo que agregarLineaVenta
 * hace al confirmar, para que lo que se ve acá sea exactamente lo que se va
 * a guardar (incluyendo el modo "18% incluido").
 */
window._actualizarPreviewLineaVenta = function () {
  const cantidad = parseFloat(document.getElementById('ventaLineaCantidad')?.value || 0)
  const precio   = parseFloat(document.getElementById('ventaLineaPrecio')?.value || 0)
  const tipoBase = document.getElementById('ventaLineTipoBase')?.value || 'gravada'
  const igvIncluido = tipoBase === 'gravada_incluido'
  const igvPct = (tipoBase === 'gravada' || igvIncluido) ? 18 : 0

  let subtotal, igvMonto, total
  if (igvIncluido) {
    total = cantidad * precio
    subtotal = total / 1.18
    igvMonto = total - subtotal
  } else {
    subtotal = cantidad * precio
    igvMonto = subtotal * igvPct / 100
    total = subtotal + igvMonto
  }

  const elSub = document.getElementById('ventaLineaSubtotalPreview')
  const elIgv = document.getElementById('ventaLineaIGVPreview')
  const elTot = document.getElementById('ventaLineaTotalPreview')
  if (elSub) elSub.value = subtotal.toFixed(2)
  if (elIgv) elIgv.value = igvMonto.toFixed(2)
  if (elTot) elTot.value = total.toFixed(2)
}

function _nombreZona(ubicacionId) {
  if (!ubicacionId) return '-'
  const z = (_zonas || []).find(x => x.id === ubicacionId)
  if (!z) return `Zona #${ubicacionId}`
  const a = (_almacenes || []).find(x => x.id === z.almacen_id)
  return `${a?.nombre || '?'} — ${z.nombre}`
}

/**
 * Muestra el stock TOTAL disponible del producto (todas las zonas/lotes
 * sumadas) contra la cantidad pedida, más el desglose informativo de lotes
 * (FIFO) que cubrirían esa cantidad si se despachara ahora. Reemplaza al
 * viejo aviso por-lote-y-zona: la elección real del lote queda para la
 * Guía de Despacho, acá solo se valida que la suma alcance.
 */
function _actualizarAvisoStockLineaVenta() {
  const aviso = document.getElementById('ventaLineaStockAviso')
  const panelLotes = document.getElementById('ventaLineaDesgloseLotes')
  if (!aviso) return
  const itemId = parseInt(document.getElementById('ventaItemSelect')?.value || 0)
  const cantidad = parseFloat(document.getElementById('ventaLineaCantidad')?.value || 0)

  if (!itemId) {
    aviso.textContent = 'Selecciona un producto para ver su stock disponible.'
    aviso.style.color = 'var(--text-secondary)'
    if (panelLotes) panelLotes.innerHTML = ''
    return
  }

  const { totalKg, totalUnid, lotes } = _stockTotalPorItem(itemId)
  const insuficiente = cantidad > 0 && cantidad > totalKg

  aviso.textContent = lotes.length === 0
    ? 'Sin stock disponible en ninguna zona para este producto.'
    : `Stock TOTAL disponible: ${formatQty(totalKg)} kg` +
      (totalUnid > 0 ? ` / ${formatQty(totalUnid)} und` : '') +
      ` (en ${lotes.length} lote${lotes.length === 1 ? '' : 's'})` +
      (insuficiente ? ' — INSUFICIENTE para la cantidad pedida' : '')
  aviso.style.color = lotes.length === 0 ? 'var(--color-warning)' : (insuficiente ? 'var(--color-danger)' : 'var(--color-success)')

  // Desglose FIFO: qué lotes/zonas cubrirían la cantidad pedida si se
  // despachara ahora — puramente informativo, no se guarda nada de esto.
  if (panelLotes) {
    if (lotes.length === 0) {
      panelLotes.innerHTML = ''
    } else {
      let restante = cantidad > 0 ? cantidad : 0
      panelLotes.innerHTML = '<table style="width:100%; border-collapse:collapse;">' +
        '<tr style="color:var(--text-secondary);"><td style="padding:2px 6px 2px 0;">Lote</td><td style="padding:2px 6px;">Zona</td><td style="padding:2px 6px; text-align:right;">Disp. kg</td><td style="padding:2px 0; text-align:center;">Usaría</td></tr>' +
        lotes.map(l => {
          const usa = restante > 0 ? Math.min(restante, l.disp) : 0
          restante = parseFloat((restante - usa).toFixed(4))
          return `<tr>` +
            `<td style="padding:2px 6px 2px 0;">${_esc(l.numero_lote)}</td>` +
            `<td style="padding:2px 6px;">${_esc(l.zonaNombre)}</td>` +
            `<td style="padding:2px 6px; text-align:right;">${formatQty(l.disp)}</td>` +
            `<td style="padding:2px 0; text-align:center;">${usa > 0 ? '✓ ' + formatQty(usa) + ' kg' : '—'}</td>` +
          `</tr>`
        }).join('') +
        '</table>'
    }
  }
}

/**
 * Refresca en memoria _stockUbic/_lotes/_lotesMap con lo que hay AHORA
 * mismo en Supabase. Antes estas variables se cargaban una sola vez al
 * abrir "Nueva Venta" y quedaban congeladas mientras el modal seguía
 * abierto: si alguien más despachaba stock de ese mismo lote/zona mientras
 * tanto (otra pestaña, otro usuario), el select de Lote seguía mostrando el
 * número viejo hasta cerrar y volver a abrir todo el formulario.
 *
 * Se llama justo antes de poblar Zona/Lote — el momento exacto en que el
 * usuario necesita ver el stock real, no una foto vieja. ESTE es el patrón
 * a replicar en cualquier otro select que dependa de stock/lotes (Compras,
 * Guía de Despacho, Traslados de Inventario, etc.): refrescar la fuente de
 * datos justo antes de poblar el select, no una sola vez al abrir el modal.
 */
async function _refrescarStockLoteEnVivo() {
  const [lotesFrescos, stockFresco] = await Promise.all([getLotes(), getStockUbicaciones()])
  _lotes = lotesFrescos
  _stockUbic = stockFresco
  _lotesMap = {}
  for (const lo of (_lotes || [])) _lotesMap[lo.id] = lo
}

/** Al elegir un producto: refresca stock en vivo y muestra el total disponible + desglose de lotes. */
window.onCambiarItemLineaVenta = async function () {
  const sel = document.getElementById('ventaItemSelect')
  const opt = sel?.selectedOptions[0]
  const itemId = parseInt(sel?.value || 0)
  const item = _items.find(i => i.id === itemId)
  const inpUnidad = document.getElementById('ventaLineaUnidad')
  const inpPrecio = document.getElementById('ventaLineaPrecio')
  if (inpUnidad) inpUnidad.value = item?.unidad_medida || ''
  if (inpPrecio) inpPrecio.value = opt?.getAttribute('data-precio') || ''

  const aviso = document.getElementById('ventaLineaStockAviso')
  if (aviso) aviso.textContent = 'Actualizando stock...'
  await _refrescarStockLoteEnVivo()

  _sugerirUnidadesLineaVenta()
  _actualizarAvisoStockLineaVenta()
}

/** Al cambiar la cantidad (kg): recalcula la sugerencia de unidades y el aviso/desglose de stock. */
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

registrarColumnas('ventas', [
  { key: 'sel',         label: 'Seleccionar' },
  { key: 'comprobante', label: 'N° Comprobante' },
  { key: 'tipo',        label: 'Tipo' },
  { key: 'cliente',     label: 'Cliente' },
  { key: 'vendedor',    label: 'Vendedor' },
  { key: 'fecha',       label: 'Fecha' },
  { key: 'moneda',      label: 'Moneda' },
  { key: 'base',        label: 'Base Imp.' },
  { key: 'igv',         label: 'IGV' },
  { key: 'total',       label: 'Total' },
  { key: 'cpe',         label: 'CPE' },
  { key: 'acciones',    label: 'Acciones' }
])

function _thOrdenableVentas(label, campo) {
  const oculto = colStyle('ventas', campo) !== ''
  return `<th data-col-tabla="ventas" data-col="${campo}" style="cursor:pointer; user-select:none;${oculto ? ' display:none;' : ''}" onclick="window.ordenarVentas('${campo}')" title="Ordenar por ${label}">${label}${_flechaOrdenVentas(campo)}</th>`
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
// Suma aplicada por cada venta tipo_venta='anticipo' — para el badge
// "Aplicado X de Y" junto al tipo de comprobante. Se recarga junto con la
// lista principal (mismo patrón que aplicadoPorAnticipoCompra en compras.js).
let _aplicadoPorAnticipoVentaCache = new Map()

async function renderVentas(forzar = false) {
  try {
    const container = document.getElementById('content-ventas')
    if (!container) return

    if (!_ventasListaEnriquecida || forzar) {
      const [ventas, anticiposAplicadosTodos] = await Promise.all([getVentas(), getTodosVentasAnticiposAplicados()])
      _aplicadoPorAnticipoVentaCache = new Map()
      for (const a of (anticiposAplicadosTodos || [])) {
        _aplicadoPorAnticipoVentaCache.set(a.venta_anticipo_id, (_aplicadoPorAnticipoVentaCache.get(a.venta_anticipo_id) || 0) + (parseFloat(a.monto_aplicado) || 0))
      }
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
        <div class="col-menu card-corner-menu" id="ventasColMenu">
          <button type="button" class="card-menu-btn" onclick="window._colMenuToggle('ventas', 'ventasColMenu', 'ventasColMenuDropdown')" title="Elegir qué columnas mostrar">⋮</button>
          <div class="col-menu-dropdown" id="ventasColMenuDropdown"></div>
        </div>
        <div class="card-header" style="padding-right:34px;">
          <h3 class="card-title">Comprobantes de Venta</h3>
          <div style="display:flex; gap:8px;">
            <button id="btnEliminarVentasSeleccionadas" class="btn btn-danger btn-small" style="display:none;" onclick="window.eliminarVentasSeleccionadas()">🗑 Eliminar seleccionadas (0)</button>
            <button class="btn btn-secondary btn-small" onclick="window.abrirModalImportarVentas()">📥 Importar</button>
            <button class="btn btn-primary btn-small" onclick="window.abrirModalNuevaVenta()">+ Nueva Venta</button>
          </div>
        </div>
        <div style="padding:12px 16px; border-bottom:1px solid var(--border-color, #e0e0e0); display:flex; gap:12px; flex-wrap:wrap; align-items:center;">
          <input type="text" id="buscarVenta" placeholder="Buscar por comprobante, cliente, vendedor, moneda o tipo..." style="flex:1; min-width:260px; max-width:420px;" oninput="window.filtrarVentas()">
          <select id="filtroTipoComprobanteVentas" onchange="window.filtrarVentas()" style="max-width:180px;">
            <option value="">-- Todos los tipos --</option>
            <option value="01">Factura</option>
            <option value="03">Boleta</option>
            <option value="07">Nota de Crédito</option>
            <option value="08">Nota de Débito</option>
          </select>
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
                <th data-col-tabla="ventas" data-col="sel" style="width:32px;${colStyle('ventas','sel') ? 'display:none;' : ''}"><input type="checkbox" id="selAllVentas" onchange="window.toggleSeleccionTodasVentas(this.checked)" title="Seleccionar todas"></th>
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
                <th data-col-tabla="ventas" data-col="acciones"${colStyle('ventas','acciones')}>Acciones</th>
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

/** Badge "💰 Anticipo — saldo X" / "💰 Aplicado íntegramente" para ventas
 * tipo_venta='anticipo' — espejo del badgeStock de compras.js. Vacío para
 * ventas de mercadería normales. */
function _badgeAnticipoVenta(v) {
  if (v.tipo_venta !== 'anticipo') return ''
  const aplicado = _aplicadoPorAnticipoVentaCache.get(v.id) || 0
  const total = parseFloat(v.total || 0)
  const saldo = parseFloat((total - aplicado).toFixed(2))
  return saldo <= 0.01
    ? '<br><span class="badge badge-success">💰 Aplicado íntegramente</span>'
    : `<br><span class="badge badge-warning" title="Aplicado ${aplicado.toFixed(2)} de ${total.toFixed(2)}">💰 Anticipo — saldo ${saldo.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>`
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
  const fTipo = document.getElementById('filtroTipoComprobanteVentas')?.value || ''

  let listaFiltrada = (_ventasListaEnriquecida || []).filter(({ v }) => {
    const anul = estaAnulado(v)
    if (modoAnul === 'activos'  && anul) return false
    if (modoAnul === 'anulados' && !anul) return false
    if (fTipo && String(v.tipo_comprobante) !== fTipo) return false
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
      <td data-col-tabla="ventas" data-col="sel"${colStyle('ventas','sel')}>${aceptado || anulada
        ? `<input type="checkbox" disabled title="${anulada ? 'Comprobante anulado' : 'No se puede eliminar: CPE aceptado por SUNAT'}">`
        : `<input type="checkbox" class="venta-sel" value="${v.id}" onchange="window.actualizarBotonEliminarVentasSeleccionadas()">`}</td>
      <td data-col-tabla="ventas" data-col="comprobante"${colStyle('ventas','comprobante')}><strong>${v.serie || ''}-${String(v.correlativo || '').padStart(8,'0')}</strong></td>
      <td data-col-tabla="ventas" data-col="tipo"${colStyle('ventas','tipo')}>${badgeTipoDocumento(v.tipo_comprobante)}${v.venta_referencia_id ? `<br><small style="color:var(--text-secondary);">ref. ${v.doc_referencia_serie || ''}-${String(v.doc_referencia_numero || '').padStart(8,'0')}</small>` : ''}${_badgeAnticipoVenta(v)}</td>
      <td data-col-tabla="ventas" data-col="cliente"${colStyle('ventas','cliente')}>${cliente}</td>
      <td data-col-tabla="ventas" data-col="vendedor"${colStyle('ventas','vendedor')}>${vendedor}</td>
      <td data-col-tabla="ventas" data-col="fecha"${colStyle('ventas','fecha')}>${v.fecha_emision || '-'}</td>
      <td data-col-tabla="ventas" data-col="moneda"${colStyle('ventas','moneda')}>${v.moneda || 'PEN'}</td>
      <td data-col-tabla="ventas" data-col="base" style="text-align:right;${estiloMonto}${colStyle('ventas','base') ? ' display:none;' : ''}">${formatNumber(bi)}</td>
      <td data-col-tabla="ventas" data-col="igv" style="text-align:right;${estiloMonto}${colStyle('ventas','igv') ? ' display:none;' : ''}">${formatNumber(igv)}</td>
      <td data-col-tabla="ventas" data-col="total" style="text-align:right; font-weight:bold;${estiloMonto}${colStyle('ventas','total') ? ' display:none;' : ''}">${formatNumber(tot)}</td>
      <td data-col-tabla="ventas" data-col="cpe"${colStyle('ventas','cpe')}>${statusBadge(v)}</td>
      <td data-col-tabla="ventas" data-col="acciones" class="col-acciones" style="text-decoration:none; opacity:1;${colStyle('ventas','acciones') ? ' display:none;' : ''}">
        ${menuAccionesFila(anulada
          ? [
              { label: 'Ver motivo de anulación', icono: 'ℹ️', onclick: `window.verMotivoAnulacion('venta', ${v.id})` }
            ]
          : [
              (!v.cpe_estado || v.cpe_estado === 'no_enviado') && (esNota(v.tipo_comprobante)
                ? { label: 'Emitir Nota (SUNAT)', icono: '📤', onclick: `window.emitirNotaVenta(${v.id})` }
                : { label: 'Emitir CPE', icono: '📤', onclick: `window.emitirCPEVenta(${v.id})` }),
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
    const [cxcs, guiasTodas, todasVentas, detalles] = await Promise.all([
      getCuentasCobrarByVenta(id), getGuiasDespachoVenta(true), getVentas(), getDetalleVentas(id)
    ])
    const cxc = (cxcs || [])[0] || null
    const cuotas = cxc ? await getCuotasCobrarByCxC(cxc.id) : []
    const guias = (guiasTodas || []).filter(g => g.venta_id === id && g.estado !== 'anulada')
    const notas = (todasVentas || []).filter(x => x.venta_referencia_id === id && !estaAnulado(x))

    // Lo aplicado incluye retenciones, canjes y anticipos ya aplicados:
    // todos son dinero o deuda ya comprometida, aunque no haya entrado
    // efectivo ahora mismo.
    const aplicado = cxc
      ? parseFloat(cxc.monto_cobrado || 0) + parseFloat(cxc.monto_retenido || 0) + parseFloat(cxc.monto_canjeado || 0) + parseFloat(cxc.monto_anticipo_aplicado || 0)
      : 0

    const bloqueos = {
      cliente:    aplicado > 0.01 || notas.length > 0,
      moneda:     aplicado > 0.01,
      cronograma: aplicado > 0.01,
      numeracion: v.cpe_estado === 'aceptado',
      // Precio unitario / tipo IGV por línea: mismo criterio que numeración +
      // cliente. Un comprobante ACEPTADO por SUNAT no se corrige reescribiendo
      // el monto (eso es Nota de Crédito/Débito); y si ya hay cobros,
      // retenciones o canjes aplicados, o notas emitidas contra esta venta,
      // cambiar el total la descuadraría contra dinero que ya se movió.
      // (Pendiente: cuando el módulo de Contabilidad esté activo, agregar acá
      // el bloqueo por venta.asiento_id ya generado, para no dejarlo descuadrado.)
      precios:    v.cpe_estado === 'aceptado' || aplicado > 0.01 || notas.length > 0
    }

    _evContexto = { venta: v, cxc, cuotas, guias, notas, aplicado, bloqueos, detalles: detalles || [] }

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
    _pintarLineasEdicionVenta()
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
    avisos.push({ t: 'info', txt: `Tiene ${c.guias.length} guía(s) de despacho emitida(s). Si cambias el cliente, revisa que el destino de la mercadería siga siendo correcto. Moneda y Tipo de Cambio SÍ se pueden cambiar sin problema: el costo de Kardex no depende de ellos (viene fijo del lote desde la compra) — solo se resincroniza la Cuenta por Cobrar.` })
  }
  if (c.venta.asiento_id) {
    avisos.push({ t: 'warning', txt: 'Esta venta ya tiene asiento contable generado. Si cambias moneda, tipo de cambio o precios, el asiento en Contabilidad NO se actualiza automáticamente — queda pendiente hasta activar ese módulo.' })
  }

  cont.innerHTML = avisos.length === 0
    ? '<div style="padding:9px 12px; border-radius:var(--radius-md); background:rgba(16,185,129,.12); color:var(--color-success); font-size:.85rem;">Sin cobros ni notas: se puede editar todo.</div>'
    : avisos.map(a => `<div style="padding:9px 12px; margin-bottom:6px; border-radius:var(--radius-md); font-size:.85rem; line-height:1.45;
        background:${a.t === 'danger' ? 'rgba(239,68,68,.12)' : a.t === 'warning' ? 'rgba(245,158,11,.12)' : 'rgba(59,130,246,.12)'};
        color:var(--${a.t === 'danger' ? 'color-danger' : a.t === 'warning' ? 'color-warning' : 'color-info'});">${_esc(a.txt)}</div>`).join('')
}

// Etiqueta + color reutilizada del modal "Nueva Venta" (misma paleta que
// _badgeTipoIGV) para que ambos lugares se vean consistentes.
function _badgeTipoIGVEdicion(tipoBase) {
  const map = {
    gravada:   { label: 'Gravada 18%', color: 'var(--color-info)' },
    exonerada: { label: 'Exonerada',   color: 'var(--color-warning)' },
    inafecta:  { label: 'Inafecta',    color: 'var(--text-secondary)' }
  }
  const m = map[tipoBase] || { label: tipoBase || '-', color: 'var(--text-secondary)' }
  return `<span style="display:inline-block; padding:2px 8px; border-radius:999px; font-size:0.75rem; font-weight:600; color:#fff; background:${m.color}; white-space:nowrap;">${m.label}</span>`
}

/**
 * Tabla de líneas del comprobante en "Editar Venta": precio_unitario y tipo
 * de IGV quedan editables (cantidad NO — ya se despachó el stock real). Al
 * tocar un campo se recalcula Subtotal/IGV/Total de esa fila y los totales
 * del pie en vivo, con window.onCambiarLineaPrecioEdicion. Si
 * bloqueos.precios está activo, los campos quedan solo-lectura y se explica
 * el motivo en #ev-precios-aviso (mismo patrón que los otros candados).
 */
function _pintarLineasEdicionVenta() {
  const c = _evContexto
  const cont = document.getElementById('ev-lineas')
  const aviso = document.getElementById('ev-precios-aviso')
  if (!cont || !c) return

  if (aviso) {
    if (c.bloqueos.precios) {
      const motivo = c.venta.cpe_estado === 'aceptado'
        ? 'el comprobante ya fue aceptado por SUNAT'
        : (c.notas.length > 0
          ? 'tiene notas de crédito/débito asociadas'
          : 'ya tiene cobros, retenciones o canjes aplicados')
      aviso.textContent = `Precio y tipo de IGV bloqueados: ${motivo}. Para corregir el monto, usa una Nota de Crédito o Débito.`
      aviso.style.color = 'var(--color-warning)'
    } else {
      aviso.textContent = 'Puedes corregir el precio unitario y el tipo de IGV de cada línea — la cantidad y el lote no se tocan aquí.'
      aviso.style.color = 'var(--text-secondary)'
    }
  }

  if (c.detalles.length === 0) {
    cont.innerHTML = `<tr><td colspan="8" style="text-align:center; color:var(--text-secondary); padding:14px;">Esta venta no tiene líneas registradas.</td></tr>`
    return
  }

  cont.innerHTML = c.detalles.map((d, idx) => `
    <tr>
      <td>${_esc(d.descripcion || '')}</td>
      <td style="text-align:right;">${(parseFloat(d.cantidad) || 0).toLocaleString('en-US', { maximumFractionDigits: 3 })}</td>
      <td>${_esc(d.unidad_medida || '-')}</td>
      <td style="text-align:right;">
        <input type="number" step="0.01" min="0.01" value="${parseFloat(d.precio_unitario || 0)}"
          id="evLineaPrecio-${idx}" style="width:100px; text-align:right;" ${c.bloqueos.precios ? 'disabled' : ''}
          oninput="window.onCambiarLineaPrecioEdicion(${idx})">
      </td>
      <td>
        <select id="evLineaTipo-${idx}" ${c.bloqueos.precios ? 'disabled' : ''} onchange="window.onCambiarLineaPrecioEdicion(${idx})">
          <option value="gravada"${d.tipo_base === 'gravada' ? ' selected' : ''}>Gravada 18%</option>
          <option value="gravada_incluido" title="El precio unitario que escribas ya trae el IGV incluido; se normaliza a la base al guardar.">Gravada 18% (incluido)</option>
          <option value="exonerada"${d.tipo_base === 'exonerada' ? ' selected' : ''}>Exonerada</option>
          <option value="inafecta"${d.tipo_base === 'inafecta' ? ' selected' : ''}>Inafecta</option>
        </select>
      </td>
      <td style="text-align:right;" id="evLineaSubtotal-${idx}">${parseFloat(d.subtotal || 0).toFixed(2)}</td>
      <td style="text-align:right;" id="evLineaIgv-${idx}">${parseFloat(d.igv_monto || 0).toFixed(2)}</td>
      <td style="text-align:right; font-weight:600;" id="evLineaTotal-${idx}">${parseFloat(d.total_linea || 0).toFixed(2)}</td>
    </tr>
  `).join('')
}

/** Recalcula Subtotal/IGV/Total de UNA línea (en memoria, sobre _evContexto.detalles) y los totales del pie. */
window.onCambiarLineaPrecioEdicion = function (idx) {
  const c = _evContexto
  const d = c?.detalles?.[idx]
  if (!d) return

  const precio = Math.max(0, parseFloat(document.getElementById(`evLineaPrecio-${idx}`)?.value || 0))
  const tipoBase = document.getElementById(`evLineaTipo-${idx}`)?.value || 'gravada'
  const cantidad = parseFloat(d.cantidad) || 0

  // "Gravada 18% (incluido)" es solo un modo de captura (igual que en
  // Agregar Producto/Editar Línea de venta): el precio que se escribe ya
  // trae el IGV incluido, y se normaliza a la base SIN IGV antes de guardar
  // — tipo_base se persiste como 'gravada' (el CHECK de detalle_ventas no
  // tiene un valor aparte para esto).
  const igvIncluido = tipoBase === 'gravada_incluido'
  const tipoBaseGuardar = igvIncluido ? 'gravada' : tipoBase
  const igvPct = (tipoBase === 'gravada' || igvIncluido) ? 18 : 0

  let subtotal, igvMonto, totalLinea, precioGuardar
  if (igvIncluido && cantidad > 0) {
    totalLinea = parseFloat((cantidad * precio).toFixed(2))
    subtotal   = parseFloat((totalLinea / 1.18).toFixed(2))
    igvMonto   = parseFloat((totalLinea - subtotal).toFixed(2))
    precioGuardar = parseFloat((subtotal / cantidad).toFixed(4))
  } else {
    subtotal  = parseFloat((cantidad * precio).toFixed(2))
    igvMonto  = parseFloat((subtotal * igvPct / 100).toFixed(2))
    totalLinea = parseFloat((subtotal + igvMonto).toFixed(2))
    precioGuardar = precio
  }

  // Se guarda en memoria (no en BD todavía) — recién se persiste al confirmar
  // "Guardar y propagar cambios", igual que el resto del formulario.
  d._precioNuevo = precioGuardar
  d._tipoBaseNuevo = tipoBaseGuardar
  d._subtotalNuevo = subtotal
  d._igvMontoNuevo = igvMonto
  d._totalLineaNuevo = totalLinea

  _setEv(`evLineaSubtotal-${idx}`, subtotal.toFixed(2))
  _setEv(`evLineaIgv-${idx}`, igvMonto.toFixed(2))
  _setEv(`evLineaTotal-${idx}`, totalLinea.toFixed(2))

  _recalcularTotalesEdicionVenta()
}

/**
 * Suma las líneas (con sus valores editados si los hay), refresca
 * Base/IGV/Total del pie y — si el cronograma no está bloqueado — le avisa
 * el nuevo total para que sus cuotas se re-prorrateen contra ESE monto y no
 * contra el total viejo con el que se abrió el editor. Sin esto, "Prorratear
 * al total" del cronograma seguiría prorrateando contra el monto original.
 */
function _recalcularTotalesEdicionVenta() {
  const c = _evContexto
  if (!c) return
  let base = 0, igv = 0, total = 0
  for (const d of c.detalles) {
    base  += d._subtotalNuevo   ?? parseFloat(d.subtotal || 0)
    igv   += d._igvMontoNuevo   ?? parseFloat(d.igv_monto || 0)
    total += d._totalLineaNuevo ?? parseFloat(d.total_linea || 0)
  }
  base = parseFloat(base.toFixed(2)); igv = parseFloat(igv.toFixed(2)); total = parseFloat(total.toFixed(2))
  _setEv('evBase', formatNumber(base))
  _setEv('evIgv', formatNumber(igv))
  _setEv('evTotal', `${document.getElementById('evMoneda')?.value || 'PEN'} ${formatNumber(total)}`)

  if (c.cxc && !c.bloqueos.cronograma) {
    actualizarCronograma('ev-cronograma', { total })
  }
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

    // Precio unitario / tipo IGV por línea: si bloqueos.precios está activo
    // (CPE aceptado, cobros/retenciones/canjes aplicados, o notas asociadas)
    // los totales quedan exactamente como estaban — ninguna línea se toca.
    let huboCambioPrecios = false
    const detallesCambiados = []
    let nuevoBase = 0, nuevoIgv = 0, nuevoTotal = 0
    if (c.bloqueos.precios) {
      nuevoBase  = parseFloat(c.venta.base_imponible) || 0
      nuevoIgv   = parseFloat(c.venta.igv) || 0
      nuevoTotal = parseFloat(c.venta.total) || 0
    } else {
      for (const d of c.detalles) {
        const precioOriginal = parseFloat(d.precio_unitario || 0)
        const tipoOriginal   = d.tipo_base
        const subtotal    = d._subtotalNuevo   ?? parseFloat(d.subtotal || 0)
        const igvMonto    = d._igvMontoNuevo   ?? parseFloat(d.igv_monto || 0)
        const totalLinea  = d._totalLineaNuevo ?? parseFloat(d.total_linea || 0)
        nuevoBase += subtotal; nuevoIgv += igvMonto; nuevoTotal += totalLinea

        const precioCambio = d._precioNuevo != null && Math.abs(d._precioNuevo - precioOriginal) > 0.0001
        const tipoCambio_  = d._tipoBaseNuevo != null && d._tipoBaseNuevo !== tipoOriginal
        if (precioCambio || tipoCambio_) {
          huboCambioPrecios = true
          detallesCambiados.push({
            id: d.id,
            precio_unitario: d._precioNuevo ?? precioOriginal,
            tipo_base: d._tipoBaseNuevo ?? tipoOriginal,
            igv_porcentaje: (d._tipoBaseNuevo ?? tipoOriginal) === 'gravada' ? 18 : 0,
            subtotal, igv_monto: igvMonto, total_linea: totalLinea
          })
        }
      }
      if (huboCambioPrecios && nuevoTotal <= 0) {
        showToast('El total de la venta no puede quedar en 0 o negativo', 'warning')
        return
      }
    }

    // Cronograma — se valida contra el total NUEVO (con los precios ya
    // editados), no contra el total viejo con el que se abrió el editor:
    // si se cambia precio y cronograma en la misma pasada, tienen que
    // cuadrar entre sí, no cada uno contra un total distinto.
    let crono = null
    if (!c.bloqueos.cronograma && c.cxc) {
      crono = leerCronograma('ev-cronograma')
      if (crono && Math.abs(crono.suma - nuevoTotal) > 0.01) {
        showToast(`Las cuotas suman ${formatNumber(crono.suma)} pero el total es ${formatNumber(nuevoTotal)}. Usa "= Prorratear al total".`, 'warning')
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
    if (huboCambioPrecios) cambios.push(`precio/IGV de ${detallesCambiados.length} línea(s) — nuevo total ${formatNumber(nuevoTotal)}`)

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
      cronograma_personalizado: crono ? !!crono.personalizado : c.venta.cronograma_personalizado,
      base_imponible: parseFloat(nuevoBase.toFixed(2)),
      igv:            parseFloat(nuevoIgv.toFixed(2)),
      total:          parseFloat(nuevoTotal.toFixed(2))
    })
    if (!okVenta) throw new Error('no se pudo actualizar la venta')

    // ── 1b) Líneas con precio/IGV corregido ─────────────────────────────
    // Solo las que realmente cambiaron — el resto de detalle_ventas queda
    // intacto (cantidad, lote_id, etc. no se tocan desde este modal).
    if (detallesCambiados.length > 0) {
      for (const dc of detallesCambiados) {
        try {
          await updateDetalleVenta(dc.id, {
            precio_unitario: dc.precio_unitario,
            tipo_base: dc.tipo_base,
            igv_porcentaje: dc.igv_porcentaje,
            subtotal: dc.subtotal,
            igv_monto: dc.igv_monto,
            total_linea: dc.total_linea
          })
        } catch (e) {
          console.warn(`Línea ${dc.id} no actualizada:`, e.message)
          showToast(`⚠️ Una línea no se pudo actualizar: ${e.message}`, 'warning')
        }
      }
    }

    // ── 2) Cuenta por Cobrar ───────────────────────────────────────────
    // Sin esto, Cobranzas seguiría mostrando la deuda con los datos viejos.
    // monto_total se sincroniza siempre con el total recién calculado —
    // si hubo cambio de precio es el motivo principal; si no lo hubo, es el
    // mismo valor de antes y no cambia nada.
    if (c.cxc) {
      try {
        await updateCuentaCobrar(c.cxc.id, {
          contact_id: contactId, serie, numero_comprobante: correl.replace(/^0+/, '') || correl,
          fecha_emision: fechaEmi, fecha_vencimiento: fechaVenc,
          moneda, tipo_cambio: tipoCambio,
          monto_total: parseFloat(nuevoTotal.toFixed(2)),
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
  // deleteRecord() puede devolver false sin lanzar excepción (ver
  // supabase-client.js) — si no se valida, el kardex queda huérfano y la
  // venta se borra igual, descuadrando el reporte de Kardex en silencio
  // (caso real: guía T001-00000464, fila kardex #394 nunca se eliminó).
  for (const k of (kardexVenta || [])) {
    const okKardex = await deleteKardexMovimiento(k.id)
    if (!okKardex) {
      const motivo = ultimoErrorDelete()
      throw new Error(`No se pudo eliminar el movimiento de Kardex #${k.id}: ${motivo?.mensaje || 'motivo desconocido'}. Se detiene el borrado para no dejar el Kardex descuadrado.`)
    }
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

    // Refrescar stock/lotes: el aviso de stock total se arma con esto, para
    // no ofrecer stock que ya no existe.
    const [lotesFrescos, stockFresco] = await Promise.all([getLotes(), getStockUbicaciones()])
    _lotes = lotesFrescos
    _stockUbic = stockFresco
    _lotesMap = {}
    for (const lo of (_lotes || [])) _lotesMap[lo.id] = lo

    _poblarSelectClientes()
    _poblarSelectItems()
    const inpUnidad = document.getElementById('ventaLineaUnidad')
    if (inpUnidad) inpUnidad.value = ''
    const inpCantUnid = document.getElementById('ventaLineaCantUnidades')
    if (inpCantUnid) inpCantUnid.value = ''
    _actualizarAvisoStockLineaVenta()

    const atvDesc = document.getElementById('atvDescripcion')
    if (atvDesc) atvDesc.value = 'ANTICIPO'
    window.cambiarTipoVenta('mercaderia')

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
  _ventaLineaEditIdx = null
  _setEv('tituloModalLineaVenta', 'Agregar Producto a la Venta')
  const btn = document.getElementById('btnAgregarLineaVenta')
  if (btn) btn.textContent = '+ Agregar'
  window.openModal('modal-agregar-linea-venta')
}

window.cerrarModalLineaVenta = function () {
  _ventaLineaEditIdx = null
  window.closeModal('modal-agregar-linea-venta')
}

/**
 * Reabre el modal "Agregar Producto" precargado con los datos de una línea
 * YA agregada a la venta, para corregirla sin tener que borrarla y volver a
 * escribir todo. Al guardar (agregarLineaVenta), como _ventaLineaEditIdx
 * queda seteado, la línea se REEMPLAZA en su mismo puesto en vez de
 * agregarse una nueva al final.
 */
window.editarLineaVenta = async function (idx) {
  const l = _ventaLineas[idx]
  if (!l) return
  _ventaLineaEditIdx = idx

  // Los buscadores (convertirEnBuscador) solo sincronizan su input visible
  // cuando el <select> dispara 'change' o vía refrescarBuscador() — asignar
  // .value directo no dispara 'change', así que cada asignación de abajo
  // necesita su refrescarBuscador() inmediatamente después.
  const sel = document.getElementById('ventaItemSelect')
  if (sel) sel.value = String(l.item_id)
  refrescarBuscador('ventaItemSelect')

  await _refrescarStockLoteEnVivo()

  const cantInput = document.getElementById('ventaLineaCantidad')
  if (cantInput) cantInput.value = l.cantidad

  _sugerirUnidadesLineaVenta()   // sugerencia de unidades — se pisa abajo con el valor real guardado

  const unidInput = document.getElementById('ventaLineaCantUnidades')
  if (unidInput) unidInput.value = l.cantidad_unidades || ''
  const precioInp = document.getElementById('ventaLineaPrecio')
  if (precioInp) precioInp.value = l.precio_unitario
  const descInp = document.getElementById('ventaLineaDesc')
  if (descInp) descInp.value = l.descripcion || ''
  const inpUnidad = document.getElementById('ventaLineaUnidad')
  if (inpUnidad) inpUnidad.value = l.unidad_medida || ''
  // El modo "18% incluido" es solo de captura y no se conserva en la línea
  // guardada (ver comentario en agregarLineaVenta) — al editar se muestra
  // el tipo_base real ('gravada'/'exonerada'/'inafecta'), con el precio ya
  // en base sin IGV.
  const tipoSel = document.getElementById('ventaLineTipoBase')
  if (tipoSel) tipoSel.value = l.tipo_base || 'gravada'

  window._actualizarPreviewLineaVenta()
  _actualizarAvisoStockLineaVenta()

  _setEv('tituloModalLineaVenta', 'Editar Producto de la Venta')
  const btn = document.getElementById('btnAgregarLineaVenta')
  if (btn) btn.textContent = 'Guardar cambios'

  window.openModal('modal-agregar-linea-venta')
}

/**
 * Costo promedio ponderado FIFO: recorre los lotes disponibles del ítem
 * (más antiguo primero) "consumiendo" `cantidad` kg y promedia el costo de
 * lo que se habría usado. Es solo una estimación para detalle_ventas
 * (informativa/contable referencial) — el costo REAL que se contabiliza sale
 * de los lotes que la Guía de Despacho efectivamente descuente.
 */
function _costoPromedioFIFO(lotes, cantidad) {
  let restante = cantidad, costoAcum = 0, kgAcum = 0
  for (const l of lotes) {
    if (restante <= 0) break
    const usa = Math.min(restante, l.disp)
    costoAcum += usa * l.costo_unitario
    kgAcum += usa
    restante -= usa
  }
  return kgAcum > 0 ? costoAcum / kgAcum : (lotes[0]?.costo_unitario || 0)
}

window.agregarLineaVenta = function() {
  const sel    = document.getElementById('ventaItemSelect')
  const opt    = sel?.selectedOptions[0]
  const itemId = parseInt(sel?.value || 0)
  if (!itemId) { showToast('Selecciona un producto', 'warning'); return }

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

  // Stock TOTAL disponible del producto (todas las zonas/lotes sumadas) — si
  // no alcanza, se bloquea acá (solo aviso: el stock recién se descuenta de
  // verdad al crear la Guía de Despacho, que ahí sí elige lote/zona). Se
  // descuenta lo que OTRAS líneas de este mismo producto ya reservaron en
  // este mismo formulario, para no "vender" el mismo stock dos veces antes
  // de guardar. Si se está EDITANDO una línea existente, esa línea se
  // excluye de la cuenta para no restarse a sí misma.
  const { totalKg, totalUnid, lotes } = _stockTotalPorItem(itemId)
  const otrasLineas = _ventaLineas.filter((l, i) => i !== _ventaLineaEditIdx)
  const yaReservadoKg = otrasLineas
    .filter(l => l.item_id === itemId)
    .reduce((s, l) => s + (parseFloat(l.cantidad) || 0), 0)
  const yaReservadoUnid = otrasLineas
    .filter(l => l.item_id === itemId)
    .reduce((s, l) => s + (parseFloat(l.cantidad_unidades) || 0), 0)
  const disponibleKg   = totalKg - yaReservadoKg
  const disponibleUnid = totalUnid - yaReservadoUnid

  if (cantidad > disponibleKg) {
    showToast(
      `Stock insuficiente para "${descripcion}": disponible ${formatQty(disponibleKg)} kg (todas las zonas), solicitado ${formatQty(cantidad)} kg.`,
      'danger'
    )
    return
  }
  if (cantidadUnidades > 0 && cantidadUnidades > disponibleUnid) {
    showToast(
      `Unidades insuficientes para "${descripcion}": disponible ${formatQty(disponibleUnid)} und, solicitado ${formatQty(cantidadUnidades)} und.`,
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

  // Sin lote/zona elegidos acá (eso lo decide la Guía de Despacho al
  // despachar). lote_id/ubicacion_id/stock_ubicacion_id quedan null —
  // detalle_ventas.lote_id ya soporta null (ON DELETE SET NULL) porque la
  // venta nunca movió stock de verdad, solo lo registraba como referencia.
  const lineaGuardada = {
    item_id: itemId, descripcion, cantidad, cantidad_unidades: cantidadUnidades,
    precio_unitario: precioUnitarioGuardar,
    subtotal, tipo_base: tipoBaseGuardar, igv_porcentaje: igvPct,
    igv_monto: igvMonto, total_linea: totalLine,
    unidad_medida: unidadMedida, ubicacion_id: null,
    lote_id: null, stock_ubicacion_id: null, numero_lote: null,
    costo_unitario: parseFloat(_costoPromedioFIFO(lotes, cantidad).toFixed(4))
  }

  const editando = _ventaLineaEditIdx !== null
  if (editando) _ventaLineas[_ventaLineaEditIdx] = lineaGuardada
  else _ventaLineas.push(lineaGuardada)

  _renderLineasVenta()

  // Limpiar
  if (cantInput)  cantInput.value  = '1'
  if (unidInput)  unidInput.value  = ''
  if (precioInp)  precioInp.value  = ''
  if (descInp)    descInp.value    = ''
  if (sel)        sel.value        = ''
  refrescarBuscador('ventaItemSelect')
  const inpUnidad = document.getElementById('ventaLineaUnidad')
  if (inpUnidad)  inpUnidad.value  = ''
  _actualizarAvisoStockLineaVenta()
  window._actualizarPreviewLineaVenta()
  window.cerrarModalLineaVenta()
  showToast(editando ? 'Producto actualizado' : 'Producto agregado a la venta', 'success')
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


function _renderLineasVenta() {
  const container = document.getElementById('ventaLineas')
  if (!container) return

  let cantidadTotal = 0, base = 0, igv = 0, total = 0
  _ventaLineas.forEach(l => {
    cantidadTotal += parseFloat(l.cantidad) || 0
    base += l.subtotal; igv += l.igv_monto; total += l.total_linea
  })

  if (_ventaLineas.length === 0) {
    container.innerHTML = `<tr><td colspan="10" style="text-align:center; color:var(--text-secondary); padding:20px;">Sin productos agregados</td></tr>`
  } else {
    container.innerHTML = _ventaLineas.map((l, idx) => `
      <tr>
        <td>${l.descripcion}</td>
        <td style="text-align:right;">${(parseFloat(l.cantidad) || 0).toLocaleString('en-US', { maximumFractionDigits: 3 })}</td>
        <td>${l.unidad_medida || '-'}</td>
        <td style="text-align:right;">${(parseFloat(l.cantidad_unidades) || 0) > 0 ? (parseFloat(l.cantidad_unidades) || 0).toLocaleString('en-US', { maximumFractionDigits: 2 }) : '-'}</td>
        <td style="text-align:right;">${l.precio_unitario.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
        <td>${_badgeTipoIGV(l.tipo_base)}</td>
        <td style="text-align:right;">${l.subtotal.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
        <td><input type="number" step="0.01" min="0" value="${l.igv_monto.toFixed(2)}" style="width:90px; text-align:right;" title="Editable: ajusta por redondeo si hace falta" onchange="window.editarMontoIGVLineaVenta(${idx}, this.value)"></td>
        <td style="text-align:right; font-weight:bold;">${l.total_linea.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
        <td style="white-space:nowrap;">
          <button type="button" class="btn btn-small btn-secondary" onclick="window.editarLineaVenta(${idx})">✏️</button>
          <button type="button" class="btn btn-small btn-danger" onclick="window.quitarLineaVenta(${idx})">✕</button>
        </td>
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

// Ajuste manual de redondeo: el IGV de una línea normalmente sale de
// subtotal × 18%, pero al sumar varias líneas (o venir de un pedido externo
// ya redondeado) puede haber una diferencia de centavos. Se deja editable en
// vez de forzar siempre el cálculo exacto — el Subtotal NO se toca, solo el
// IGV y, en cascada, el Total de esa línea.
window.editarMontoIGVLineaVenta = function (idx, valor) {
  const l = _ventaLineas[idx]
  if (!l) return
  const nuevoIGV = Math.max(0, parseFloat(valor) || 0)
  l.igv_monto = parseFloat(nuevoIGV.toFixed(2))
  l.total_linea = parseFloat((l.subtotal + l.igv_monto).toFixed(2))
  _renderLineasVenta()
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

    // Re-chequeo de stock TOTAL por producto (todas las zonas/lotes sumadas)
    // justo antes de crear la venta — agregarLineaVenta ya valida al
    // agregar, pero el stock pudo cambiar mientras el modal estaba abierto.
    // Es solo un aviso preventivo: la venta no descuenta stock (eso lo hace
    // la Guía de Despacho, que ahí sí elige lote/zona). Se agrupa por
    // item_id por si el carrito tiene varias líneas del mismo producto.
    const [lotesActuales, stockUbicActual] = await Promise.all([getLotes(), getStockUbicaciones()])
    _lotes = lotesActuales
    _stockUbic = stockUbicActual
    _lotesMap = {}
    for (const lo of (_lotes || [])) _lotesMap[lo.id] = lo

    const totalPedidoPorItem = {}
    for (const l of _ventaLineas) {
      if (!totalPedidoPorItem[l.item_id]) totalPedidoPorItem[l.item_id] = { cantidad: 0, cantidad_unidades: 0, descripcion: l.descripcion }
      totalPedidoPorItem[l.item_id].cantidad += parseFloat(l.cantidad) || 0
      totalPedidoPorItem[l.item_id].cantidad_unidades += parseFloat(l.cantidad_unidades) || 0
    }
    for (const [itemIdStr, pedido] of Object.entries(totalPedidoPorItem)) {
      const { totalKg, totalUnid } = _stockTotalPorItem(parseInt(itemIdStr))
      if (pedido.cantidad > totalKg) {
        showToast(
          `Stock insuficiente para "${pedido.descripcion}": disponible ${formatQty(totalKg)} kg (todas las zonas), solicitado ${formatQty(pedido.cantidad)} kg. ` +
          `El stock pudo cambiar desde que abriste el formulario — cierra y vuelve a intentar.`,
          'danger'
        )
        return
      }
      if (pedido.cantidad_unidades > 0 && pedido.cantidad_unidades > totalUnid) {
        showToast(
          `Unidades insuficientes para "${pedido.descripcion}": disponible ${formatQty(totalUnid)} und, solicitado ${formatQty(pedido.cantidad_unidades)} und. ` +
          `El stock pudo cambiar desde que abriste el formulario — cierra y vuelve a intentar.`,
          'danger'
        )
        return
      }
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

    // Comprobante duplicado (serie + N°): antes solo se revisaba si el
    // usuario había editado el correlativo a mano, así que editar la SERIE
    // en vez del número (o un correlativo mal calculado) se colaba sin
    // aviso y el INSERT fallaba silencioso más abajo por la restricción
    // UNIQUE de la base, dejando el botón trabado en "Guardando...". Ahora
    // se revisa siempre, sin importar qué campo se haya tocado.
    const numeroTentativo = `${serie}-${String(correlativo).padStart(8, '0')}`
    const yaExiste = (await getVentas() || []).some(v => v.numero === numeroTentativo)
    if (yaExiste) {
      showToast(`Ya existe el comprobante ${numeroTentativo}. Usa otro número.`, 'danger')
      return
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
      tipo_venta:       'mercaderia',
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

    // Crear CxC automáticamente. Antes solo Factura ('01'); las Boletas
    // ('03') a crédito calculaban un cronograma que se descartaba sin
    // guardarse — ahora también generan CxC/cuotas si corresponde.
    if (tipoComp === '01' || tipoComp === '03') {
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

        // Anticipo(s) del cliente marcados en "Anticipos disponibles" — se
        // descuentan de la CxC recién creada, nunca de detalle_ventas.
        if (cxc?.id) await _aplicarAnticiposVentaSeleccionados(venta, cxc, user?.db_id)
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
  } finally {
    // Antes el botón se deshabilitaba arriba pero solo se volvía a
    // habilitar si TODO el guardado salía bien — cualquier validación que
    // cortara con `return` (cliente sin elegir, stock insuficiente,
    // comprobante duplicado, cronograma descuadrado, etc.) dejaba
    // "Guardando..." trabado para siempre y el formulario parecía colgado.
    // `finally` se ejecuta siempre, sin importar por dónde se salga del
    // try — es el punto correcto para reponer el botón.
    if (btn) { btn.disabled = false; btn.textContent = '💾 Guardar Venta' }
  }
}

// ============================================================================
// VENTA — TIPO DE VENTA (Mercadería / Anticipo de Cliente) — espejo exacto de
// cambiarTipoCompra/guardarCompraAnticipo en compras.js. Ver ambos casos en
// 55_anticipos_proveedor_cliente.sql y el TODO CONTABILIDAD ahí documentado.
// ============================================================================

/** Alterna qué sección del modal unificado de Nueva Venta se ve, según el
 * Tipo elegido. Nunca se mezclan productos reales y glosa de anticipo en un
 * mismo comprobante (mismo criterio confirmado con Luis 2026-09-07 para
 * Compras). */
window.cambiarTipoVenta = function (tipo) {
  _tipoVentaActual = tipo

  const cuerpos = { mercaderia: 'tvBodyMercaderia', anticipo: 'tvBodyAnticipo' }
  Object.entries(cuerpos).forEach(([t, id]) => {
    const el = document.getElementById(id)
    if (el) el.style.display = (t === tipo) ? '' : 'none'
  })

  const botones = { mercaderia: 'tvBtnMercaderia', anticipo: 'tvBtnAnticipo' }
  Object.entries(botones).forEach(([t, id]) => {
    document.getElementById(id)?.classList.toggle('on', t === tipo)
  })

  // El cronograma de cuotas solo aplica a Mercadería (un anticipo se cobra
  // completo, no se financia en cuotas — igual que Servicio en Compras). Los
  // anticipos disponibles del cliente no tienen sentido si esta MISMA venta
  // es un anticipo (no se puede aplicar un anticipo a otro anticipo).
  const cronoWrap = document.getElementById('tvCronogramaWrap')
  if (cronoWrap) cronoWrap.style.display = (tipo === 'mercaderia') ? '' : 'none'

  const titulo = { mercaderia: 'Nueva Venta — Comprobante Electrónico', anticipo: 'Nueva Venta — Anticipo de Cliente' }
  const tituloEl = document.getElementById('nvTituloModal')
  if (tituloEl) tituloEl.textContent = titulo[tipo] || 'Nueva Venta'

  _cargarAnticiposDisponiblesCliente()
}

/** Despacha el guardado al flujo correcto según el Tipo de Venta elegido. */
window.guardarVentaUnificada = function () {
  if (_tipoVentaActual === 'anticipo') return window.guardarVentaAnticipo()
  return window.guardarNuevaVenta()
}

window.calcularVentaAnticipo = function () {
  const subtotal = parseFloat(document.getElementById('atvSubtotal')?.value || 0)
  const igvPct   = parseFloat(document.getElementById('atvIGV')?.value || 0)
  const igvMonto = parseFloat((subtotal * igvPct / 100).toFixed(2))
  const total    = parseFloat((subtotal + igvMonto).toFixed(2))

  const igvEl   = document.getElementById('atvIGVMonto')
  const totalEl = document.getElementById('atvTotal')
  if (igvEl)   igvEl.value   = igvMonto.toFixed(2)
  if (totalEl) totalEl.value = total.toFixed(2)
}

// ============================================================================
// VENTA — ANTICIPO DE CLIENTE (Art. 5° Reglamento de Comprobantes de Pago: el
// cobro anticipado, total o parcial, obliga a emitir el comprobante ANTES de
// que exista mercadería que despachar). Se registra como una venta más (para
// el Registro de Ventas/IGV/CxC de SUNAT), pero con tipo_venta='anticipo'
// para que NUNCA aparezca en el selector de Nueva Guía de Despacho (ver
// _cargarVentasPendientesDespacho) ni mueva stock. Más adelante se aplica
// contra la factura real desde "Anticipos disponibles" (ver
// _cargarAnticiposDisponiblesCliente / _aplicarAnticiposVentaSeleccionados).
// Decisión confirmada con Luis 2026-09-07, espejo de guardarCompraAnticipo.
// ============================================================================

window.guardarVentaAnticipo = async function () {
  const btn = document.getElementById('btnGuardarNuevaVenta')
  if (btn?.disabled) return
  if (btn) { btn.disabled = true; btn.textContent = 'Guardando...' }
  try {
    const user = await getCurrentUser()
    if (!user) { showToast('Usuario no autenticado', 'danger'); return }

    const contactId    = parseInt(document.getElementById('ventaContactId')?.value || 0)
    const tipoComp     = document.getElementById('ventaTipoComp')?.value || '01'
    const serie        = document.getElementById('ventaSerie')?.value?.trim() || (tipoComp === '01' ? 'F001' : 'B001')
    const fechaEmision = document.getElementById('ventaFechaEmision')?.value
    const moneda       = document.getElementById('ventaMoneda')?.value || 'PEN'
    const tipoCambio   = moneda === 'USD'
      ? (parseFloat(document.getElementById('ventaTipoCambio')?.value || 0) || 1)
      : 1
    const periodo      = document.getElementById('ventaPeriodo')?.value
    const vendedorId   = parseInt(document.getElementById('ventaVendedor')?.value || 0) || null
    const descripcion  = document.getElementById('atvDescripcion')?.value?.trim() || 'ANTICIPO'
    const refPedido    = document.getElementById('atvReferenciaPedido')?.value?.trim() || ''
    const igvPct       = parseFloat(document.getElementById('atvIGV')?.value || 0)
    const subtotal     = parseFloat(document.getElementById('atvSubtotal')?.value || 0)

    if (!contactId)    { showToast('Selecciona un cliente', 'warning'); return }
    if (!fechaEmision) { showToast('Ingresa la fecha de emisión', 'warning'); return }
    if (!descripcion)  { showToast('Ingresa la descripción del anticipo', 'warning'); return }
    if (!subtotal || subtotal <= 0) { showToast('Ingresa un subtotal válido', 'warning'); return }

    window.calcularVentaAnticipo()
    const igvMonto = parseFloat(document.getElementById('atvIGVMonto')?.value || 0)
    const total    = parseFloat(document.getElementById('atvTotal')?.value || 0)

    const correlativoInput = document.getElementById('ventaCorrelativo')?.value?.trim()
    const correlativo = correlativoInput
      ? parseInt(correlativoInput, 10)
      : await generarNumeroVenta(tipoComp, serie)
    if (!correlativo || isNaN(correlativo) || correlativo <= 0) {
      showToast('El N° de comprobante debe ser un número válido', 'warning')
      return
    }

    const numeroTentativo = `${serie}-${String(correlativo).padStart(8, '0')}`
    const yaExiste = (await getVentas() || []).some(v => v.numero === numeroTentativo)
    if (yaExiste) {
      showToast(`Ya existe el comprobante ${numeroTentativo}. Usa otro número.`, 'danger')
      return
    }

    const descripcionFinal = refPedido ? `${descripcion} [Pedido: ${refPedido}]` : descripcion

    const venta = await addVenta({
      numero:            numeroTentativo,
      tipo_comprobante:  tipoComp,
      serie,
      correlativo,
      contact_id:        contactId,
      fecha_emision:     fechaEmision,
      fecha_vencimiento: fechaEmision,
      periodo_contable:  periodo || fechaEmision.slice(0, 7),
      moneda,
      tipo_cambio:       tipoCambio,
      tipo_venta:        'anticipo',
      base_imponible:    igvPct > 0 ? parseFloat(subtotal.toFixed(2)) : 0,
      igv:               parseFloat(igvMonto.toFixed(2)),
      total:             parseFloat(total.toFixed(2)),
      estado:            'emitida',
      estado_pago:       'pendiente',
      // estado_despacho NO se fija aquí: queda en su default 'pendiente' (la
      // columna tiene un CHECK que solo acepta pendiente/parcial/despachado).
      // Un anticipo nunca se despacha — se excluye del selector de Nueva
      // Guía de Despacho por tipo_venta='anticipo', igual que tipo_compra=
      // 'anticipo' se excluye del selector de Nueva Guía de Ingreso.
      cpe_estado:        'no_enviado',
      vendedor_id:       vendedorId,
      descripcion:       descripcionFinal,
      observaciones:     null,
      termino_pago_id:   null,
      cronograma_personalizado: false,
      created_by:        user.db_id
    })

    if (!venta?.id) throw new Error('No se pudo crear el anticipo')

    // TODO CONTABILIDAD (detrás de ASIENTOS_AUTO_VENTAS_ACTIVO o el flag que
    // se defina cuando se active el módulo): Debe 12 Cuentas por Cobrar
    // Comerciales (o Bancos si se cobró de inmediato) / Haber "1222 Anticipos
    // de Clientes" (cuenta a crear — hoy NO existe equivalente de 281111 en
    // el plan de cuentas del lado Ventas) + 40111 IGV por pagar. Ver detalle
    // completo en 55_anticipos_proveedor_cliente.sql.
    await addDetalleVenta({
      venta_id:          venta.id,
      item_id:           null,
      descripcion:       descripcionFinal,
      unidad_medida:     'UND',
      cantidad:          1,
      cantidad_unidades: 0,
      precio_unitario:   subtotal,
      subtotal,
      tipo_base:         igvPct > 0 ? 'gravada' : 'exonerada',
      igv_porcentaje:    igvPct,
      igv_monto:         igvMonto,
      total_linea:       total
    })

    if (tipoComp === '01' || tipoComp === '03') {
      try {
        const cxc = await addCuentaCobrar({
          contact_id:         contactId,
          venta_id:           venta.id,
          tipo_comprobante:   tipoComp,
          serie,
          numero_comprobante: correlativo,
          fecha_emision:      fechaEmision,
          fecha_vencimiento:  fechaEmision,
          moneda,
          tipo_cambio:        tipoCambio,
          monto_total:        parseFloat(total.toFixed(2)),
          monto_cobrado:      0,
          estado:             'pendiente',
          termino_pago_id:    null,
          cronograma_personalizado: false
        })
        if (!cxc?.id) console.warn('Anticipo creado pero no se pudo generar su CxC')
      } catch (eCxC) {
        console.warn('Anticipo creado pero CxC falló:', eCxC.message)
      }
    }

    showToast('Anticipo de cliente registrado. Podrás aplicarlo al registrar la factura real de mercadería.', 'success')
    window.closeModal('modal-nueva-venta')
    await renderVentas(true)
  } catch (e) {
    console.error('guardarVentaAnticipo:', e)
    showToast('Error: ' + e.message, 'danger')
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '💾 Guardar Venta' }
  }
}

// ============================================================================
// APLICAR ANTICIPO DE CLIENTE — al elegir cliente en el modal de Nueva Venta
// (tipo Mercadería), se buscan sus facturas tipo_venta='anticipo' con saldo
// sin aplicar y se ofrecen para descontar del total de ESTA factura. La
// aplicación es un DESCUENTO APARTE en la CxC recién creada
// (monto_anticipo_aplicado, mismo patrón que monto_notas_credito) — nunca una
// línea dentro de detalle_ventas, para no ensuciar la tabla de productos real
// que usan Guía de Despacho/kardex/reportes. Espejo exacto del bloque
// "APLICAR ANTICIPO A PROVEEDOR" de compras.js.
// ============================================================================

/** Recalcula saldo disponible = ventas.total del anticipo - lo ya aplicado en ventas_anticipos_aplicados. */
async function _obtenerAnticiposVentaDisponibles(contactId) {
  if (!contactId) return []
  const [ventas, aplicaciones] = await Promise.all([getVentas(), getTodosVentasAnticiposAplicados()])
  const aplicadoPorAnticipo = new Map()
  for (const a of (aplicaciones || [])) {
    aplicadoPorAnticipo.set(a.venta_anticipo_id, (aplicadoPorAnticipo.get(a.venta_anticipo_id) || 0) + (parseFloat(a.monto_aplicado) || 0))
  }
  return (ventas || [])
    .filter(v => v.contact_id === contactId && v.tipo_venta === 'anticipo' && !estaAnulado(v))
    .map(v => {
      const aplicado = aplicadoPorAnticipo.get(v.id) || 0
      const saldo = parseFloat((parseFloat(v.total || 0) - aplicado).toFixed(2))
      return { id: v.id, referencia: v.serie ? `${v.serie}-${String(v.correlativo || v.numero || '').padStart(8, '0')}` : (v.numero || ''), fecha: v.fecha_emision, moneda: v.moneda || 'PEN', saldo }
    })
    .filter(a => a.saldo > 0.01)
    .sort((a, b) => new Date(a.fecha || 0) - new Date(b.fecha || 0))
}

/** Total actual del formulario, según el Tipo de Venta elegido — sirve para prellenar el monto a aplicar. */
function _totalActualFormularioVenta() {
  if (_tipoVentaActual === 'anticipo') return 0 // no aplica: un anticipo no recibe otro anticipo
  return _ventaLineas.reduce((s, l) => s + (parseFloat(l.total_linea) || 0), 0)
}

async function _cargarAnticiposDisponiblesCliente() {
  const wrap = document.getElementById('tvAnticiposDisponibles')
  const lista = document.getElementById('tvAnticiposLista')
  if (!wrap || !lista) return

  const contactId = parseInt(document.getElementById('ventaContactId')?.value || 0)
  if (!contactId || _tipoVentaActual === 'anticipo') {
    wrap.style.display = 'none'
    lista.innerHTML = ''
    _anticiposVentaDisponiblesCache = []
    return
  }

  try {
    _anticiposVentaDisponiblesCache = await _obtenerAnticiposVentaDisponibles(contactId)
  } catch (e) {
    console.error('Error cargando anticipos disponibles del cliente:', e)
    _anticiposVentaDisponiblesCache = []
  }

  if (_anticiposVentaDisponiblesCache.length === 0) {
    wrap.style.display = 'none'
    lista.innerHTML = ''
    return
  }

  wrap.style.display = ''
  lista.innerHTML = _anticiposVentaDisponiblesCache.map(a => `
    <div style="display:flex; align-items:center; gap:10px; padding:6px 8px; background:var(--bg-primary); border-radius:var(--radius-sm);">
      <input type="checkbox" id="tvAntSel-${a.id}" onchange="window._toggleAnticipoVentaAplicar(${a.id})">
      <span style="flex:1; font-size:0.85rem;">Factura ${_esc(a.referencia || '')} — ${a.fecha || ''} · Saldo disponible: ${a.moneda} ${a.saldo.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
      <input type="number" id="tvAntMonto-${a.id}" style="width:110px;" step="0.01" min="0" max="${a.saldo}" value="${a.saldo.toFixed(2)}" disabled>
    </div>
  `).join('')
}

window._toggleAnticipoVentaAplicar = function (anticipoId) {
  const chk = document.getElementById(`tvAntSel-${anticipoId}`)
  const input = document.getElementById(`tvAntMonto-${anticipoId}`)
  if (!input) return
  input.disabled = !chk?.checked
  if (chk?.checked) {
    const a = _anticiposVentaDisponiblesCache.find(x => x.id === anticipoId)
    const totalActual = _totalActualFormularioVenta()
    if (a) input.value = Math.min(a.saldo, totalActual > 0 ? totalActual : a.saldo).toFixed(2)
  }
}

/** Aplica los anticipos marcados en el modal contra la CxC recién creada de
 * `ventaDestino`. Se llama después de crear la CxC en guardarNuevaVenta (solo
 * tipo Mercadería; Anticipo nunca llama esto). */
async function _aplicarAnticiposVentaSeleccionados(ventaDestino, cxcDestino, userId) {
  if (!ventaDestino?.id || !_anticiposVentaDisponiblesCache.length) return

  let totalAplicado = 0
  for (const a of _anticiposVentaDisponiblesCache) {
    const chk = document.getElementById(`tvAntSel-${a.id}`)
    if (!chk?.checked) continue
    const monto = parseFloat(document.getElementById(`tvAntMonto-${a.id}`)?.value || 0)
    if (!monto || monto <= 0) continue
    if (monto > a.saldo + 0.01) {
      showToast(`El monto a aplicar del anticipo ${a.referencia} supera su saldo disponible — se omitió`, 'warning')
      continue
    }

    const guardado = await addVentaAnticipoAplicado({
      venta_anticipo_id: a.id,
      venta_destino_id:  ventaDestino.id,
      monto_aplicado:    monto,
      moneda:            ventaDestino.moneda || 'PEN',
      tipo_cambio:       parseFloat(ventaDestino.tipo_cambio) || 1,
      created_by:        userId
    })
    if (!guardado?.id) {
      showToast(`No se pudo aplicar el anticipo ${a.referencia} — revísalo manualmente en Cuentas por Cobrar`, 'warning')
      continue
    }
    totalAplicado += monto
  }

  if (totalAplicado <= 0) return
  if (!cxcDestino?.id) {
    showToast('Anticipo(s) aplicado(s), pero esta venta no generó Cuenta por Cobrar (no es factura/boleta) — revísalo manualmente', 'warning')
    return
  }

  // TODO CONTABILIDAD (cuando se active el módulo): este es el momento de
  // generar el asiento de reclasificación Debe "1222 Anticipos de Clientes" /
  // Haber 70 Ventas, por `totalAplicado` — NO un asiento de "cobro" nuevo, es
  // solo mover el saldo de una cuenta transitoria a la definitiva. Ver
  // 55_anticipos_proveedor_cliente.sql.
  const nuevoAplicado = parseFloat((parseFloat(cxcDestino.monto_anticipo_aplicado || 0) + totalAplicado).toFixed(2))
  const saldoRestante = parseFloat(cxcDestino.monto_total || 0) - parseFloat(cxcDestino.monto_cobrado || 0) - parseFloat(cxcDestino.monto_notas_credito || 0) - nuevoAplicado
  const nuevoEstado = saldoRestante <= 0.01 ? 'pagado' : (nuevoAplicado > 0 ? 'parcial' : 'pendiente')
  await updateCuentaCobrar(cxcDestino.id, { monto_anticipo_aplicado: nuevoAplicado, estado: nuevoEstado })
  showToast(`Anticipo aplicado: -${(ventaDestino.moneda || 'PEN')} ${totalAplicado.toFixed(2)}`, 'success')
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

        if (tipoComprobante === '01' || tipoComprobante === '03') {
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
      // Si el error es de configuración (token/RUC no puestos aún, típico en
      // modo de prueba) NO se marca 'rechazado' — SUNAT nunca llegó a ver el
      // comprobante, así que "rechazado" sería engañoso. Se deja como estaba
      // para poder reintentar sin confusión cuando se configure NUBEFACT.
      if (!/no configurado/i.test(resultado.error || '')) {
        await updateVenta(ventaId, { cpe_estado: 'rechazado' })
      }
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

// Emisión electrónica de Notas de Crédito/Débito (tipo_comprobante 07/08).
// Usa emitirNota() en vez de emitirCPE(): arma los campos adicionales que
// NUBEFACT exige para notas (documento_que_se_modifica_*, tipo_de_nota_de_
// crédito/débito según catálogo 09/10 SUNAT) — antes el botón "Emitir CPE"
// de una fila de nota llamaba por error a emitirCPEVenta(), que no incluye
// esos campos y la nota quedaba mal formada ante NUBEFACT.
window.emitirNotaVenta = async function(notaId) {
  try {
    const nota    = await getVentaById(notaId)
    if (!nota) { showToast('No se encontró la nota', 'danger'); return }
    if (!esNota(nota.tipo_comprobante)) { showToast('Este comprobante no es una nota', 'warning'); return }
    if (!nota.doc_referencia_tipo || !nota.doc_referencia_serie || !nota.doc_referencia_numero) {
      showToast('La nota no tiene registrado el comprobante que modifica: no se puede emitir', 'danger')
      return
    }

    const lineas  = await getDetalleVentas(notaId)
    const cliente = await getContactById(nota.contact_id)

    const notaConCliente = {
      ...nota,
      cliente_tipo_doc:   cliente?.tipo_documento === 'RUC' ? '6' : '1',
      cliente_doc:        cliente?.ruc || cliente?.dni || '',
      cliente_nombre:     cliente?.razon_social || cliente?.nombre || '',
      cliente_direccion:  cliente?.direccion || '',
      cliente_email:      cliente?.email || ''
    }
    const docRef = {
      tipo:   nota.doc_referencia_tipo,
      serie:  nota.doc_referencia_serie,
      numero: nota.doc_referencia_numero
    }

    showToast(`Emitiendo ${nota.tipo_comprobante === TIPO_NC ? 'Nota de Crédito' : 'Nota de Débito'} con NUBEFACT...`, 'info')

    const resultado = await emitirNota(notaConCliente, lineas, docRef, null)

    if (!resultado.ok) {
      showToast('Error NUBEFACT: ' + (resultado.error || 'la nota fue rechazada'), 'danger')
      // Mismo criterio que emitirCPEVenta: un error de configuración (sin
      // token/RUC, modo de prueba) no es un rechazo real de SUNAT.
      if (!/no configurado/i.test(resultado.error || '')) {
        await updateVenta(notaId, { cpe_estado: 'rechazado' })
      }
      return
    }

    await updateVenta(notaId, {
      cpe_estado:      'aceptado',
      nubefact_enlace: resultado.enlace_pdf,
      xml_url:         resultado.enlace_xml,
      pdf_url:         resultado.enlace_pdf
    })

    showToast('Nota emitida y aceptada por SUNAT ✅', 'success')
    await renderVentas(true)
  } catch (e) {
    console.error('emitirNotaVenta:', e)
    showToast('Error al emitir la nota: ' + e.message, 'danger')
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
  // form.reset() no toca los spans "Datos SUNAT" (no son campos de formulario).
  ;['cliEstadoSunat', 'cliCondicionSunat', 'cliBuenContribuyenteSunat', 'cliAgenteRetencionSunat'].forEach(id => {
    const el = document.getElementById(id)
    if (el) { pintarBadgeSunat(el, '—', 'secondary'); delete el.dataset.value }
  })
  const tipoDocEl = document.getElementById('cliTipoDocumento')
  if (tipoDocEl) tipoDocEl.dispatchEvent(new Event('change'))
}

window.abrirFormularioCliente = function() {
  _resetModalCliente()
  window.openModal('modal-nuevo-cliente')
}

window.guardarCliente = async function() {
  try {
    // Columnas reales de contacts (assets/sql/01_schema.sql + script 44):
    // nombre, tipo_documento, nro_documento, email, numero, direccion,
    // distrito, pais, tipo_contacto (text[]), sujeto_retencion (boolean).
    // Antes el checkbox mandaba "sujeto_retencion" pero esa columna no
    // existía todavía en contacts (se confundía con compras.sujeto_
    // retencion, que es por COMPRA, no por cliente) — rompía el insert con
    // PGRST204 en silencio. Script 44 agregó la columna real; este guardado
    // ahora es un espejo de window.guardarProveedor (compras.js) + el flag.
    const datos = {
      nombre:         document.getElementById('cliNombre')?.value || '',
      tipo_documento: document.getElementById('cliTipoDocumento')?.value || '',
      nro_documento:  document.getElementById('cliRUC')?.value || '',
      email:          document.getElementById('cliEmail')?.value || '',
      numero:         document.getElementById('cliPhone')?.value || '',
      direccion:      document.getElementById('cliDireccion')?.value || '',
      distrito:       document.getElementById('cliDistrito')?.value || '',
      pais:           document.getElementById('cliPais')?.value || '',
      sujeto_retencion: !!document.getElementById('cliSujetoRetencion')?.checked,
      // Datos SUNAT (llenados por "Consultar" si Tipo Documento = RUC; quedan
      // vacíos/null si es DNI o si nunca se consultó — no bloquean el guardado).
      estado:    document.getElementById('cliEstadoSunat')?.textContent === '—' ? null : (document.getElementById('cliEstadoSunat')?.textContent || null),
      condicion: document.getElementById('cliCondicionSunat')?.textContent === '—' ? null : (document.getElementById('cliCondicionSunat')?.textContent || null),
      es_buen_contribuyente: (() => {
        const v = document.getElementById('cliBuenContribuyenteSunat')?.dataset.value
        return v === 'true' ? true : (v === 'false' ? false : null)
      })(),
      es_agente_retencion_sunat: (() => {
        const v = document.getElementById('cliAgenteRetencionSunat')?.dataset.value
        return v === 'true' ? true : (v === 'false' ? false : null)
      })()
    }

    let resultado
    if (_cliEditandoId) {
      // Al editar NO se toca tipo_contacto (conserva su lista actual)
      resultado = await updateContact(_cliEditandoId, datos)
    } else {
      resultado = await addContact({ ...datos, tipo_contacto: ['cliente'] })  // text[] en la BD
    }

    if (!resultado) {
      showToast('Error al guardar el cliente en base de datos', 'danger')
      return
    }

    showToast(_cliEditandoId ? 'Cliente actualizado' : 'Cliente creado exitosamente', 'success')
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
    document.getElementById('cliTipoDocumento').value = c.tipo_documento || ''
    document.getElementById('cliRUC').value    = c.nro_documento || ''
    document.getElementById('cliEmail').value  = c.email || ''
    document.getElementById('cliPhone').value  = c.telefono || c.numero || ''
    document.getElementById('cliDireccion').value = c.direccion || ''
    document.getElementById('cliDistrito').value  = c.distrito || ''
    document.getElementById('cliPais').value      = c.pais || ''
    const chkRet = document.getElementById('cliSujetoRetencion')
    if (chkRet) chkRet.checked = !!c.sujeto_retencion

    // Datos SUNAT guardados de una consulta previa (si el contacto es RUC).
    pintarBadgeSunat(document.getElementById('cliEstadoSunat'), c.estado || '—', c.estado === 'ACTIVO' ? 'success' : (c.estado ? 'danger' : 'secondary'))
    pintarBadgeSunat(document.getElementById('cliCondicionSunat'), c.condicion || '—', c.condicion === 'HABIDO' ? 'success' : (c.condicion ? 'danger' : 'secondary'))
    const bcEl = document.getElementById('cliBuenContribuyenteSunat')
    if (bcEl) {
      pintarBadgeSunat(bcEl, c.es_buen_contribuyente === true ? 'Sí' : (c.es_buen_contribuyente === false ? 'No' : '—'), c.es_buen_contribuyente === true ? 'success' : 'secondary')
      bcEl.dataset.value = c.es_buen_contribuyente === null || c.es_buen_contribuyente === undefined ? '' : String(c.es_buen_contribuyente)
    }
    const arEl = document.getElementById('cliAgenteRetencionSunat')
    if (arEl) {
      pintarBadgeSunat(arEl, c.es_agente_retencion_sunat === true ? 'Sí' : (c.es_agente_retencion_sunat === false ? 'No' : '—'), c.es_agente_retencion_sunat === true ? 'success' : 'secondary')
      arEl.dataset.value = c.es_agente_retencion_sunat === null || c.es_agente_retencion_sunat === undefined ? '' : String(c.es_agente_retencion_sunat)
    }
    // Dispara el toggle de visibilidad del bloque "Datos SUNAT" según el
    // tipo_documento recién cargado (attachConsultaDocumento escucha 'change').
    const tipoDocEl = document.getElementById('cliTipoDocumento')
    if (tipoDocEl) tipoDocEl.dispatchEvent(new Event('change'))

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
    // Una venta anulada nunca despachó nada y nunca va a despachar: aunque
    // su estado_despacho haya quedado en 'pendiente' (anular no lo toca),
    // no debe seguir apareciendo como candidata a Guía de Despacho.
    // Una Nota de Crédito/Débito se guarda como "una venta más" (tipo_comprobante
    // '07'/'08') y hereda estado_despacho='pendiente' por defecto aunque NUNCA
    // se despacha — no es una venta de mercadería, es un ajuste de otra venta.
    // Sin este filtro aparecía en el selector como si fuera una venta real.
    // Un anticipo de cliente (tipo_venta='anticipo') tampoco se despacha —
    // es solo el cobro adelantado, sin productos; se excluye igual que NC/ND.
    .filter(v => (v.estado_despacho === 'pendiente' || v.estado_despacho === 'parcial') && !estaAnulado(v) &&
      v.tipo_comprobante !== '07' && v.tipo_comprobante !== '08' && v.tipo_venta !== 'anticipo')
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
    _guiaDespachoEditId = null
    const form = document.getElementById('formNuevaGuiaDespacho')
    if (form) form.reset()
    document.getElementById('gdInfoVenta').style.display = 'none'
    document.getElementById('gdFechaGuia').value = new Date().toISOString().split('T')[0]
    document.getElementById('tabla-detalle-guia-despacho').innerHTML =
      '<p style="text-align:center; color:var(--text-secondary); padding:20px;">Selecciona una venta para ver sus productos pendientes.</p>'
    const aviso = document.getElementById('gd-edicion-aviso')
    if (aviso) aviso.style.display = 'none'
    _setEv('gd-titulo-modal', 'Nueva Guía de Despacho de Venta')
    const btnGuardar = document.getElementById('btnGuardarGuiaDespachoVenta')
    if (btnGuardar) { btnGuardar.textContent = 'Guardar Guía (descuenta stock)'; btnGuardar.onclick = () => window.guardarGuiaDespachoVenta() }

    const ventasPend = await _cargarVentasPendientesDespacho(true)
    const sel = document.getElementById('gdVenta')
    if (sel) {
      sel.disabled = false
      sel.innerHTML = '<option value="">-- Selecciona una venta pendiente/parcial --</option>' +
        ventasPend.map(v => `<option value="${v.id}">${v.serie || ''}-${String(v.correlativo || '').padStart(8,'0')} — ${v.clienteNombre} (${v.estado_despacho})</option>`).join('')
    }
    window.openModal('modal-nueva-guia-despacho')
  } catch (error) {
    console.error('Error en abrirModalNuevaGuiaDespacho:', error)
    showToast('Error al abrir el formulario de guía de despacho', 'danger')
  }
}

let _guiaDespachoEditId = null   // null = modo "crear"; id de la guía = modo "editar" (mismo modal, mismo array _guiaDespachoLineas)

window.cerrarModalNuevaGuiaDespacho = function () {
  _guiaDespachoEditId = null
  const selVenta = document.getElementById('gdVenta')
  if (selVenta) selVenta.disabled = false
  const aviso = document.getElementById('gd-edicion-aviso')
  if (aviso) aviso.style.display = 'none'
  _setEv('gd-titulo-modal', 'Nueva Guía de Despacho de Venta')
  const btn = document.getElementById('btnGuardarGuiaDespachoVenta')
  if (btn) { btn.textContent = 'Guardar Guía (descuenta stock)'; btn.onclick = () => window.guardarGuiaDespachoVenta() }
  window.closeModal('modal-nueva-guia-despacho')
}

/**
 * Abre el mismo modal de "Nueva Guía de Despacho" pero precargado con los
 * datos de una guía YA emitida, para corregir cantidad/lote/zona sin tener
 * que eliminarla y volverla a crear (perdiendo el N° de guía y teniendo que
 * volver a escribir todo). Al guardar (guardarEdicionGuiaDespachoVenta) se
 * revierte el stock/kardex que esta guía había movido y se vuelve a aplicar
 * con los valores nuevos, sobre la MISMA fila de guías_despacho_venta.
 *
 * Los lotes de peso variable (bultos) quedan fuera de este editor: reconstruir
 * qué bultos concretos estaban marcados es frágil, así que para esos casos se
 * sigue pidiendo eliminar + recrear (más seguro que arriesgar un descuadre).
 */
window.editarGuiaDespachoVenta = async function (id) {
  try {
    const guia = await getGuiaDespachoVentaById(id)
    if (!guia) { showToast('No se encontró la guía', 'danger'); return }
    if (estaAnulado(guia)) { showToast('Esta guía está anulada: no se puede editar', 'warning'); return }

    const detallesEstaGuia = await getDetalleGuiasDespachoVenta(id)

    await _refrescarStockLoteEnVivo()
    const tienePesoVariable = (detallesEstaGuia || []).some(dg => _lotesMap[dg.lote_id]?.es_peso_variable)
    if (tienePesoVariable) {
      showToast('Esta guía tiene lotes de peso variable (bultos): por ahora, para corregirla, elimínala y créala de nuevo.', 'warning', 7000)
      return
    }

    _guiaDespachoEditId = id
    const ventaId = guia.venta_id

    const [venta, detallesVenta, despachosVenta, almacenes] = await Promise.all([
      getVentaById(ventaId), getDetalleVentas(ventaId), getDetalleGuiasDespachoVentaByVenta(ventaId), getAlmacenes()
    ])

    const cliente = _clientes.find(c => c.id === venta?.contact_id)
    const infoDiv = document.getElementById('gdInfoVenta')
    if (infoDiv) {
      infoDiv.style.display = 'block'
      infoDiv.innerHTML = `
        <strong>Cliente:</strong> ${_esc(cliente?.razon_social || cliente?.nombre || '-')} &nbsp;|&nbsp;
        <strong>Comprobante:</strong> ${venta?.serie || ''}-${String(venta?.correlativo || '').padStart(8,'0')} &nbsp;|&nbsp;
        <strong>Fecha venta:</strong> ${venta?.fecha_emision || '-'} &nbsp;|&nbsp;
        <strong>Estado despacho:</strong> ${venta?.estado_despacho || 'pendiente'}
      `
    }

    const almacenesMap = {}
    for (const a of (almacenes || [])) almacenesMap[a.id] = a
    _guiaDespachoZonasCache = (_zonas || [])
      .filter(z => !almacenesMap[z.almacen_id]?.es_virtual)
      .map(z => ({ id: z.id, nombre: z.nombre, almacen_id: z.almacen_id, almacenNombre: almacenesMap[z.almacen_id]?.nombre || `Almacén #${z.almacen_id}` }))

    // Igual que onSeleccionarVentaGuiaDespacho, pero excluyendo ESTA guía de
    // "ya despachado" — es la que se está editando, así que su propia
    // reserva de stock se libera para poder redistribuirla.
    const guiasDeEstaVenta = (await getGuiasDespachoVenta(true) || []).filter(g => g.venta_id === ventaId)
    const anuladasIds = new Set(guiasDeEstaVenta.filter(g => g.estado === 'anulada').map(g => g.id))
    const despachadoPorDetalle = {}
    for (const d of (despachosVenta || [])) {
      if (anuladasIds.has(d.guia_id) || d.guia_id === id) continue
      despachadoPorDetalle[d.detalle_venta_id] = (despachadoPorDetalle[d.detalle_venta_id] || 0) + (parseFloat(d.cantidad) || 0)
    }

    const porDetalleEstaGuia = {}
    for (const dg of (detallesEstaGuia || [])) {
      if (!porDetalleEstaGuia[dg.detalle_venta_id]) porDetalleEstaGuia[dg.detalle_venta_id] = []
      porDetalleEstaGuia[dg.detalle_venta_id].push(dg)
    }

    _guiaDespachoLineas = (detallesVenta || [])
      .map(d => {
        const cantidadVendida = parseFloat(d.cantidad) || 0
        const yaDespachadoOtras = despachadoPorDetalle[d.id] || 0
        const pendiente = parseFloat((cantidadVendida - yaDespachadoOtras).toFixed(4))
        const filasEstaGuia = porDetalleEstaGuia[d.id] || []
        const despachos = filasEstaGuia.length > 0
          ? filasEstaGuia.map(dg => ({
              cantidad: parseFloat(dg.cantidad) || 0,
              cantidad_unidades: parseFloat(dg.cantidad_unidades) || 0,
              ubicacion_id: dg.ubicacion_id || '', lote_id: dg.lote_id || '',
              esPesoVariable: false, bultosDisponibles: [], bultosSeleccionados: []
            }))
          : (pendiente > 0 ? [{ cantidad: pendiente, cantidad_unidades: null, ubicacion_id: '', lote_id: '', esPesoVariable: false, bultosDisponibles: [], bultosSeleccionados: [] }] : [])
        // detalle_ventas.descripcion puede venir vacío en filas antiguas —
        // se completa con el nombre real del ítem (ya cacheado en _items)
        // antes de caer al fallback genérico "Item #id".
        const itemRef = (_items || []).find(it => it.id === d.item_id)
        return {
          detalle_venta_id: d.id, item_id: d.item_id,
          nombre: itemRef?.nombre || d.descripcion || `Item #${d.item_id}`,
          unidad_medida: d.unidad_medida,
          cantidad_vendida: cantidadVendida,
          cantidad_despachada_previa: yaDespachadoOtras,
          cantidad_pendiente: pendiente,
          despachos
        }
      })
      .filter(l => l.despachos.length > 0)

    const selVenta = document.getElementById('gdVenta')
    if (selVenta) {
      selVenta.innerHTML = `<option value="${ventaId}">${venta?.serie || ''}-${String(venta?.correlativo || '').padStart(8,'0')} — ${_esc(cliente?.razon_social || cliente?.nombre || '-')}</option>`
      selVenta.value = String(ventaId)
      selVenta.disabled = true
    }
    _valEv('gdNumeroGuia', guia.numero_guia || '')
    _valEv('gdFechaGuia', guia.fecha_guia || '')
    _valEv('gdObservaciones', guia.observaciones || '')

    _setEv('gd-titulo-modal', `Editar Guía de Despacho ${guia.numero_guia}`)
    const aviso = document.getElementById('gd-edicion-aviso')
    if (aviso) {
      aviso.style.display = 'block'
      aviso.textContent = 'Editando una guía ya emitida: al guardar se revierte el stock/kardex anterior y se vuelve a aplicar con estos valores — no hace falta eliminar y recrear.'
    }
    const btn = document.getElementById('btnGuardarGuiaDespachoVenta')
    if (btn) { btn.textContent = 'Guardar cambios (recalcula stock)'; btn.onclick = () => window.guardarEdicionGuiaDespachoVenta() }

    _renderTablaDetalleGuiaDespacho()
    window.openModal('modal-nueva-guia-despacho')
  } catch (error) {
    console.error('Error en editarGuiaDespachoVenta:', error)
    showToast('Error al abrir la guía para editar: ' + error.message, 'danger')
  }
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
        const itemRef = (_items || []).find(it => it.id === d.item_id)
        return {
          detalle_venta_id: d.id,
          item_id: d.item_id,
          nombre: itemRef?.nombre || d.descripcion || `Item #${d.item_id}`,
          unidad_medida: d.unidad_medida,
          cantidad_vendida: cantidadVendida,
          cantidad_despachada_previa: yaDespachado,
          cantidad_pendiente: pendiente,
          // esPesoVariable/bultosDisponibles/bultosSeleccionados se llenan al
          // elegir un lote con lotes.es_peso_variable=true (Fase 2): ahí la
          // cantidad/unidades dejan de escribirse a mano y se derivan de qué
          // bultos concretos se marcan (mismo patrón que Fase 1 en compras,
          // pero seleccionando bultos existentes en vez de creando nuevos).
          despachos: pendiente > 0 ? [{
            cantidad: pendiente, cantidad_unidades: null, ubicacion_id: '', lote_id: '',
            esPesoVariable: false, bultosDisponibles: [], bultosSeleccionados: []
          }] : []
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
      const zona = document.getElementById(`gd-${idx}-${subIdx}-zona`)
      const lote = document.getElementById(`gd-${idx}-${subIdx}-lote`)
      if (zona) desp.ubicacion_id = parseInt(zona.value || 0) || ''
      if (lote) desp.lote_id = parseInt(lote.value || 0) || ''
      // Para peso variable, cantidad/cantidad_unidades se derivan SIEMPRE de
      // los bultos marcados (toggleBultoDespachoGuia ya los mantiene al día
      // en desp.cantidad/desp.cantidad_unidades) — los inputs son readonly,
      // leerlos del DOM aquí solo repetiría lo mismo o, peor, pisaría el
      // valor correcto con un string a medio formatear.
      if (!desp.esPesoVariable) {
        const cant = document.getElementById(`gd-${idx}-${subIdx}-cantidad`)
        const cantUnid = document.getElementById(`gd-${idx}-${subIdx}-unidades`)
        if (cant)     desp.cantidad = parseFloat(cant.value || 0)
        if (cantUnid) desp.cantidad_unidades = cantUnid.value !== '' ? parseFloat(cantUnid.value) : null
      }
    })
  })
}

window.agregarDespachoGuia = function (idx) {
  _sincronizarDespachosGuiaDesdeDOM()
  const l = _guiaDespachoLineas[idx]
  if (!l) return
  l.despachos.push({
    cantidad: 0, cantidad_unidades: null, ubicacion_id: '', lote_id: '',
    esPesoVariable: false, bultosDisponibles: [], bultosSeleccionados: []
  })
  _renderTablaDetalleGuiaDespacho()
}

window.quitarDespachoGuia = function (idx, subIdx) {
  _sincronizarDespachosGuiaDesdeDOM()
  const l = _guiaDespachoLineas[idx]
  if (!l) return
  l.despachos.splice(subIdx, 1)
  _renderTablaDetalleGuiaDespacho()
}

/** Al elegir zona en una fila de despacho: repuebla el select de lote de ESA fila con los lotes que tienen stock ahí, y si ya había un lote de peso variable elegido, refresca su lista de bultos disponibles EN LA NUEVA zona. */
window.onCambiarZonaDespachoGuia = async function (idx, subIdx) {
  _sincronizarDespachosGuiaDesdeDOM()
  // Mismo estándar que "Agregar Producto a la Venta": leer stock fresco
  // justo antes de poblar el select de Lote, no una foto vieja de cuando se
  // abrió el modal de la guía.
  await _refrescarStockLoteEnVivo()
  const l = _guiaDespachoLineas[idx]
  const desp = l?.despachos[subIdx]
  if (desp) {
    // Cambiar de zona invalida cualquier selección de bultos previa (eran de
    // otra ubicación): se limpia y, si el lote sigue siendo válido para la
    // nueva zona, se re-carga la lista de bultos disponibles ahí.
    desp.bultosSeleccionados = []
    desp.bultosDisponibles = []
    if (desp.esPesoVariable && desp.lote_id && desp.ubicacion_id) {
      desp.bultosDisponibles = await getLoteBultosDisponiblesZona(desp.lote_id, desp.ubicacion_id)
    }
    desp.cantidad = 0
    desp.cantidad_unidades = desp.esPesoVariable ? 0 : desp.cantidad_unidades
  }
  _renderTablaDetalleGuiaDespacho()
}

/** Al elegir lote en una fila de despacho: si el lote es de peso variable (bultos), carga la lista de bultos disponibles en esa zona para que el usuario los marque uno por uno (Cantidad/Unidades pasan a ser de solo lectura, calculadas de la selección). Si no, mantiene el comportamiento anterior (sugerir N° de Unidades según peso_por_unidad). */
window.onCambiarLoteDespachoGuia = async function (idx, subIdx) {
  _sincronizarDespachosGuiaDesdeDOM()
  const l = _guiaDespachoLineas[idx]
  const desp = l?.despachos[subIdx]
  if (desp) {
    const lote = desp.lote_id ? _lotesMap[desp.lote_id] : null
    if (lote?.es_peso_variable) {
      desp.esPesoVariable = true
      desp.bultosSeleccionados = []
      desp.cantidad = 0
      desp.cantidad_unidades = 0
      desp.bultosDisponibles = desp.ubicacion_id ? await getLoteBultosDisponiblesZona(desp.lote_id, desp.ubicacion_id) : []
    } else {
      desp.esPesoVariable = false
      desp.bultosDisponibles = []
      desp.bultosSeleccionados = []
      if (lote?.peso_por_unidad && lote.peso_por_unidad > 0) {
        desp.cantidad_unidades = parseFloat(((desp.cantidad || 0) / lote.peso_por_unidad).toFixed(2))
      }
    }
  }
  _renderTablaDetalleGuiaDespacho()
}

/** Al cambiar la cantidad de una fila de despacho: re-sugiere N° de Unidades si el lote elegido trackea peso por unidad. No aplica a peso variable (el input es readonly ahí). */
window.onCambiarCantidadDespachoGuia = function (idx, subIdx) {
  _sincronizarDespachosGuiaDesdeDOM()
  const l = _guiaDespachoLineas[idx]
  const desp = l?.despachos[subIdx]
  if (desp && !desp.esPesoVariable) {
    const lote = desp.lote_id ? _lotesMap[desp.lote_id] : null
    if (lote?.peso_por_unidad && lote.peso_por_unidad > 0) {
      desp.cantidad_unidades = parseFloat(((desp.cantidad || 0) / lote.peso_por_unidad).toFixed(2))
    }
  }
  _renderTablaDetalleGuiaDespacho()
}

/**
 * Marca/desmarca un bulto en una fila de despacho de peso variable y
 * recalcula cantidad/cantidad_unidades como la suma/cuenta de lo
 * seleccionado (mismo patrón que la lista de empaque de Fase 1 en compras,
 * pero aquí se SELECCIONAN bultos ya existentes en vez de crearlos).
 * Bloquea seleccionar un bulto que ya está marcado en OTRA fila de este
 * mismo guardado (evita vender el mismo bulto físico dos veces).
 */
window.toggleBultoDespachoGuia = function (idx, subIdx, bultoId) {
  _sincronizarDespachosGuiaDesdeDOM()
  const l = _guiaDespachoLineas[idx]
  const desp = l?.despachos[subIdx]
  if (!desp) return

  const yaSeleccionado = desp.bultosSeleccionados.includes(bultoId)
  if (!yaSeleccionado) {
    const usadoEnOtraFila = _guiaDespachoLineas.some((ll, i2) =>
      ll.despachos.some((d2, s2) => (i2 !== idx || s2 !== subIdx) && (d2.bultosSeleccionados || []).includes(bultoId))
    )
    if (usadoEnOtraFila) {
      showToast('Ese bulto ya fue asignado a otra línea de esta guía', 'warning')
      return
    }
    desp.bultosSeleccionados.push(bultoId)
  } else {
    desp.bultosSeleccionados = desp.bultosSeleccionados.filter(id => id !== bultoId)
  }

  const seleccionados = (desp.bultosDisponibles || []).filter(b => desp.bultosSeleccionados.includes(b.id))
  desp.cantidad = parseFloat(seleccionados.reduce((s, b) => s + (parseFloat(b.peso) || 0), 0).toFixed(4))
  desp.cantidad_unidades = seleccionados.length

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
      // El lote ya asignado a ESTA fila (al editar una guía existente) puede
      // no traer stock disponible > 0 en esa zona: su cantidad ya está
      // "reservada" por esta misma guía, así que _lotesConStockZona no lo
      // devuelve. Sin su <option>, `select.value = desp.lote_id` (más abajo)
      // falla en silencio y el desplegable se ve en blanco. Se agrega a mano
      // si falta, para que siempre se pueda preseleccionar correctamente.
      const yaIncluido = lotesDeZona.some(lo => String(lo.lote_id) === String(desp.lote_id))
      if (desp.lote_id && !yaIncluido) {
        const loteAsignado = _lotesMap[desp.lote_id]
        lotesDeZona.push({
          lote_id: desp.lote_id,
          numero_lote: loteAsignado?.numero_lote || `#${desp.lote_id}`,
          disponible: parseFloat(desp.cantidad) || 0,
          disponibleUnid: 0,
          _reservadoAqui: true
        })
      }
      const loteOptions = lotesDeZona.map(lo =>
        `<option value="${lo.lote_id}">${lo.numero_lote} — ${lo._reservadoAqui ? 'reservado en esta guía' : `disp: ${formatQty(lo.disponible)}${lo.disponibleUnid > 0 ? ' / ' + formatQty(lo.disponibleUnid) + ' und' : ''}`}</option>`
      ).join('')
      const pesoPorUnidad = desp.lote_id ? _lotesMap[desp.lote_id]?.peso_por_unidad : null
      const soloLectura = desp.esPesoVariable
      html += `
        <tr>
          <td><input type="number" id="gd-${idx}-${subIdx}-cantidad" value="${desp.cantidad}" step="0.01" min="0" style="width:100px;" ${soloLectura ? 'readonly' : ''} onchange="window.onCambiarCantidadDespachoGuia(${idx}, ${subIdx})"></td>
          <td><input type="text" id="gd-${idx}-${subIdx}-unidadmedida" value="${l.unidad_medida || ''}" readonly size="4" style="width:auto; max-width:60px; background:var(--bg-primary); color:var(--text-secondary);"></td>
          <td><input type="text" id="gd-${idx}-${subIdx}-pesounidad" value="${pesoPorUnidad ? formatQty(pesoPorUnidad) : ''}" readonly size="6" style="width:auto; max-width:80px; background:var(--bg-primary); color:var(--text-secondary);"></td>
          <td><input type="number" id="gd-${idx}-${subIdx}-unidades" value="${desp.cantidad_unidades ?? ''}" placeholder="Ej: 10" step="1" min="0" style="width:90px;" ${soloLectura ? 'readonly' : ''}></td>
          <td><select id="gd-${idx}-${subIdx}-zona" style="min-width:160px;" onchange="window.onCambiarZonaDespachoGuia(${idx}, ${subIdx})">
                <option value="">-- Selecciona --</option>${zonaOptions}
              </select></td>
          <td><select id="gd-${idx}-${subIdx}-lote" style="min-width:200px;" ${!desp.ubicacion_id ? 'disabled' : ''} onchange="window.onCambiarLoteDespachoGuia(${idx}, ${subIdx})">
                <option value="">${desp.ubicacion_id ? '-- Selecciona lote (FIFO sugerido primero) --' : '-- Elige zona --'}</option>${loteOptions}
              </select></td>
          <td>${l.despachos.length > 1 ? `<button type="button" class="btn btn-small btn-danger" onclick="window.quitarDespachoGuia(${idx}, ${subIdx})">✕</button>` : ''}</td>
        </tr>
      `
      if (desp.esPesoVariable) {
        const otrosSeleccionados = new Set()
        _guiaDespachoLineas.forEach((ll, i2) => ll.despachos.forEach((d2, s2) => {
          if (i2 !== idx || s2 !== subIdx) (d2.bultosSeleccionados || []).forEach(id => otrosSeleccionados.add(id))
        }))
        const bultos = desp.bultosDisponibles || []
        const checklist = bultos.length === 0
          ? '<span style="color:var(--text-secondary); font-size:0.85rem;">No hay bultos disponibles de este lote en esa zona.</span>'
          : bultos.map(b => {
              const marcado = (desp.bultosSeleccionados || []).includes(b.id)
              const usadoEnOtraFila = otrosSeleccionados.has(b.id)
              return `
                <label style="display:inline-flex; align-items:center; gap:4px; margin:2px 10px 2px 0; ${usadoEnOtraFila ? 'opacity:0.4;' : ''}">
                  <input type="checkbox" ${marcado ? 'checked' : ''} ${usadoEnOtraFila ? 'disabled' : ''}
                    onchange="window.toggleBultoDespachoGuia(${idx}, ${subIdx}, ${b.id})">
                  ${b.codigo_bulto || ('Bulto #' + b.id)} — ${formatQty(b.peso)} ${l.unidad_medida || ''}${usadoEnOtraFila ? ' (usado en otra línea)' : ''}
                </label>`
            }).join('')
        html += `
          <tr>
            <td colspan="7" style="background:var(--bg-secondary); padding:8px 10px;">
              <div style="font-size:0.8rem; color:var(--text-secondary); margin-bottom:4px;">Peso variable — marca los bultos concretos a despachar:</div>
              ${checklist}
            </td>
          </tr>
        `
      }
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
  // Estos selects se recrean enteros en cada render (container.innerHTML =
  // html), así que convertirEnBuscador() se vuelve a llamar cada vez —
  // envuelve el <select> NUEVO, no queda ninguno del render anterior sin
  // wrapper (mismo patrón que Traslado Interno en Inventario: tdProducto/
  // tdLote).
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

      if (zona) {
        convertirEnBuscador(zona, { placeholder: 'Escribe el almacén o zona...', sinResultados: 'Sin zonas con stock' })
        refrescarBuscador(zona)
      }
      if (lote) {
        convertirEnBuscador(lote, { placeholder: 'Escribe el N° de lote...', sinResultados: 'Sin lotes disponibles' })
        refrescarBuscador(lote)
      }
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
        // Peso variable: la cantidad SIEMPRE debe venir de bultos marcados
        // (toggleBultoDespachoGuia ya la deriva ahí) — si por algún motivo
        // llegó en 0 bultos pero con cantidad > 0 (desincronización de
        // estado), se bloquea en vez de vender "cantidad sin bultos".
        if (d.esPesoVariable && (!d.bultosSeleccionados || d.bultosSeleccionados.length === 0)) {
          showToast(`Marca al menos un bulto para ${etiquetaLinea} (lote de peso variable)`, 'warning')
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
          filaStockId: filaStock.id,
          bultosSeleccionados: d.esPesoVariable ? [...(d.bultosSeleccionados || [])] : null
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
      const esPesoVariable = d.bultosSeleccionados && d.bultosSeleccionados.length > 0

      // Peso variable: NO se resta a mano — el lote se recalcula desde sus
      // bultos DESPUÉS de marcarlos 'vendido' (más abajo, una vez que existe
      // el id de detalle_guias_despacho_venta que necesitan). Estos valores
      // son provisionales solo para no dejar variables sin definir; el
      // Kardex usa los definitivos, calculados después del recálculo.
      let nuevaCantidadLote, nuevaUnidadesLote
      if (esPesoVariable) {
        nuevaCantidadLote = parseFloat(lote?.cantidad || 0)
        nuevaUnidadesLote = parseFloat(lote?.cantidad_unidades || 0)
      } else {
        nuevaCantidadLote = parseFloat(((parseFloat(lote?.cantidad) || 0) - d.cantidad).toFixed(4))
        nuevaUnidadesLote = Math.max(0, parseFloat(((parseFloat(lote?.cantidad_unidades) || 0) - (d.cantidad_unidades || 0)).toFixed(4)))
        await updateLote(d.lote_id, { cantidad: nuevaCantidadLote, cantidad_unidades: nuevaUnidadesLote })
      }

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

      // El detalle de guía de despacho se inserta ANTES del Kardex: si el
      // lote es de peso variable, marcar los bultos vendidos necesita el id
      // de esta fila (detalle_guia_despacho_id), y el recálculo del lote que
      // sigue debe terminar antes de armar el saldo del Kardex.
      const detalleGuia = await addDetalleGuiaDespachoVenta({
        guia_id:            guia.id,
        detalle_venta_id:   d.detalle_venta_id,
        item_id:            d.item_id,
        cantidad:           d.cantidad,
        cantidad_unidades:  d.cantidad_unidades || 0,
        numero_lote:        lote?.numero_lote || '',
        lote_id:            d.lote_id,
        ubicacion_id:       d.ubicacion_id
      })

      if (esPesoVariable) {
        for (const bultoId of d.bultosSeleccionados) {
          await updateLoteBulto(bultoId, {
            estado: 'vendido',
            detalle_venta_id: d.detalle_venta_id,
            detalle_guia_despacho_id: detalleGuia?.id || null
          })
        }
        const recalc = await recalcularLoteDesdeBultos(d.lote_id)
        nuevaCantidadLote = recalc.cantidad
        nuevaUnidadesLote = recalc.cantidad_unidades
      }

      // Kardex: salida de la zona real hacia Partners/Customers (externo).
      // costo_unitario viene del lote (costeo por identificación específica).
      // saldo_* usa nuevaCantidadLote/nuevaUnidadesLote YA definitivos
      // (recalculados desde bultos arriba si aplica).
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

/**
 * Guarda la edición de una guía YA emitida (abierta con editarGuiaDespachoVenta):
 * valida los despachos nuevos igual que al crear, y solo si todo cuadra
 * revierte el stock/kardex que la guía había movido y lo vuelve a aplicar con
 * los valores nuevos — sobre la MISMA fila de guías_despacho_venta (mismo N°
 * de guía, mismo id), sin pasar por eliminar+recrear.
 */
window.guardarEdicionGuiaDespachoVenta = async function () {
  const btn = document.getElementById('btnGuardarGuiaDespachoVenta')
  if (btn?.disabled) return
  const guiaId = _guiaDespachoEditId
  if (!guiaId) { showToast('No hay guía en edición', 'danger'); return }
  if (btn) { btn.disabled = true; btn.textContent = 'Guardando...' }
  try {
    const user = await getCurrentUser()
    if (!user) { showToast('Usuario no autenticado', 'danger'); return }

    const ventaId       = parseInt(document.getElementById('gdVenta')?.value || 0)
    const numeroGuia     = document.getElementById('gdNumeroGuia')?.value?.trim()
    const fechaGuia      = document.getElementById('gdFechaGuia')?.value
    const observaciones  = document.getElementById('gdObservaciones')?.value?.trim() || null

    if (!ventaId)    { showToast('Venta inválida', 'danger'); return }
    if (!numeroGuia) { showToast('Ingresa el N° de Guía', 'warning'); return }
    if (!fechaGuia)  { showToast('Ingresa la fecha de la guía', 'warning'); return }
    if (!_guiaDespachoLineas || _guiaDespachoLineas.length === 0) { showToast('No hay productos en esta guía', 'warning'); return }

    const guiaOriginal = await getGuiaDespachoVentaById(guiaId)
    if (!guiaOriginal) { showToast('La guía ya no existe', 'danger'); return }
    if (numeroGuia !== guiaOriginal.numero_guia) {
      const existe = (await getGuiasDespachoVenta(true) || []).some(g => g.id !== guiaId && g.numero_guia === numeroGuia && g.estado !== 'anulada')
      if (existe) { showToast(`Ya existe la guía ${numeroGuia}`, 'danger'); return }
    }

    _sincronizarDespachosGuiaDesdeDOM()

    // Misma validación que guardarGuiaDespachoVenta: cantidad/zona/lote por
    // línea, sin pasarse de lo pendiente — que ya excluye la reserva vieja de
    // esta misma guía (ver editarGuiaDespachoVenta), así que reusar el mismo
    // lote/zona con la misma cantidad de antes siempre pasa esta validación.
    const reservaZona = new Map()
    const despachosValidados = []
    const totalLineas = _guiaDespachoLineas.length
    for (const [i, l] of _guiaDespachoLineas.entries()) {
      const etiquetaLinea = totalLineas > 1 ? `"${l.nombre}" (línea ${i + 1} de ${totalLineas}, pendiente ${formatQty(l.cantidad_pendiente)})` : `"${l.nombre}"`
      let totalLinea = 0
      for (const d of l.despachos) {
        if (!d.cantidad || d.cantidad <= 0) continue
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
        if (d.esPesoVariable) {
          showToast(`"${l.nombre}" quedó en un lote de peso variable: este editor no soporta bultos. Elimina la guía y créala de nuevo.`, 'danger')
          return
        }

        reservaZona.set(filaStock.id, { cantidad: yaReservado.cantidad + d.cantidad, unidades: yaReservado.unidades + (d.cantidad_unidades || 0) })
        totalLinea += d.cantidad
        despachosValidados.push({
          detalle_venta_id: l.detalle_venta_id, item_id: l.item_id,
          cantidad: d.cantidad, cantidad_unidades: d.cantidad_unidades || 0,
          ubicacion_id: d.ubicacion_id, lote_id: d.lote_id, filaStockId: filaStock.id
        })
      }
      if (totalLinea - l.cantidad_pendiente > 0.0001) {
        showToast(`${etiquetaLinea}: estás despachando ${formatQty(totalLinea)} pero solo hay ${formatQty(l.cantidad_pendiente)} pendiente.`, 'danger')
        return
      }
    }

    if (despachosValidados.length === 0) { showToast('No hay cantidades a despachar', 'warning'); return }

    if (!confirm(
      `Se revertirá el stock/kardex que la guía ${guiaOriginal.numero_guia} había movido y se volverá a aplicar con los valores nuevos.\n\n¿Confirmar?`
    )) { if (btn) { btn.disabled = false; btn.textContent = 'Guardar cambios (recalcula stock)' }; return }

    // ── 1) Revertir TODO lo que esta guía había movido (sin borrar la guía) ──
    await _revertirStockGuiaDespacho(guiaId)
    const detallesViejos = await getDetalleGuiasDespachoVenta(guiaId)
    for (const dv of (detallesViejos || [])) await deleteDetalleGuiaDespachoVenta(dv.id)

    // ── 2) Cabecera de la guía (mismo id, mismo N° salvo que se haya editado) ─
    await updateGuiaDespachoVenta(guiaId, { numero_guia: numeroGuia, fecha_guia: fechaGuia, observaciones })

    // ── 3) Aplicar los despachos nuevos sobre la MISMA guía — idéntico al
    //       loop de guardarGuiaDespachoVenta, salvo que no vuelve a crear la
    //       fila de guías_despacho_venta (ya existe, recién actualizada). ──
    await _refrescarStockLoteEnVivo()
    const customersZona = await getUbicacionCustomers()
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
      if (filaStock) { filaStock.cantidad = nuevaCantidadZona; filaStock.cantidad_unidades = nuevaUnidadesZona }
      if (nuevaCantidadZona <= 0) {
        await deleteStockUbicacion(d.filaStockId)
        stockLocalPorFila.delete(d.filaStockId)
      } else {
        await updateStockUbicacion(d.filaStockId, { cantidad: nuevaCantidadZona, cantidad_unidades: nuevaUnidadesZona })
      }

      await addDetalleGuiaDespachoVenta({
        guia_id:            guiaId,
        detalle_venta_id:   d.detalle_venta_id,
        item_id:            d.item_id,
        cantidad:           d.cantidad,
        cantidad_unidades:  d.cantidad_unidades || 0,
        numero_lote:        lote?.numero_lote || '',
        lote_id:            d.lote_id,
        ubicacion_id:       d.ubicacion_id
      })

      const costoUnitLote = parseFloat(lote?.costo_unitario || 0)
      await addKardexMovimiento({
        item_id:              d.item_id,
        lote_id:               d.lote_id,
        ubicacion_origen_id:   d.ubicacion_id,
        ubicacion_destino_id:  customersZona?.id || null,
        fecha:                 fechaGuia,
        tipo_movimiento:       'salida',
        concepto:              'Venta - salida de almacén (guía de despacho, editada)',
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

      await updateDetalleVenta(d.detalle_venta_id, {
        lote_id: d.lote_id,
        ubicacion_id: d.ubicacion_id,
        costo_unitario: costoUnitLote
      })
    }

    await _recalcularEstadoDespachoVenta(ventaId)

    showToast(`Guía ${numeroGuia} actualizada: stock recalculado ✅`, 'success')
    window.cerrarModalNuevaGuiaDespacho()
    _guiaDespachoLineas = []

    const [lotesFrescos, stockFresco] = await Promise.all([getLotes(), getStockUbicaciones()])
    _lotes = lotesFrescos
    _stockUbic = stockFresco
    _lotesMap = {}
    for (const lo of (_lotes || [])) _lotesMap[lo.id] = lo

    _invalidarCacheVentas()
    await renderGuiasDespachoVenta(true)
    await renderVentas(true)
  } catch (error) {
    console.error('Error en guardarEdicionGuiaDespachoVenta:', error)
    showToast('Error al guardar la edición de la guía: ' + error.message, 'danger')
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Guardar cambios (recalcula stock)' }
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
/**
 * Revierte TODO el stock/kardex/bultos que una guía de despacho movió —
 * pero sin borrar la guía ni sus detalles (eso lo decide quien llama: al
 * eliminar se borra todo; al EDITAR se revierte esto y luego se vuelve a
 * aplicar con los valores nuevos sobre la misma guía). Aislado en su propio
 * helper para que ambos flujos compartan exactamente la misma lógica de
 * reversión — escribirla dos veces es como se cuelan descuadres de stock.
 */
async function _revertirStockGuiaDespacho(id) {
  const guiaActual = await getGuiaDespachoVentaById(id)
  if (!guiaActual) throw new Error(`Guía #${id}: no se encontró`)

  const detalles = await getDetalleGuiasDespachoVenta(id)

  // Revertir stock. _devolverAUnaZona actualiza lote.cantidad + la fila
  // espejo de stock_ubicaciones. Para lotes de peso variable (bultos), el
  // valor que escribe en lote.cantidad ahí es solo intermedio: se pisa abajo
  // con recalcularLoteDesdeBultos, que es la fuente de verdad real para esos
  // productos (mismo patrón dual-write que Fase 1 en compras — stock_
  // ubicaciones se mantiene en paralelo aunque el lote se recalcule aparte).
  const lotesPesoVariableTocados = new Set()
  for (const dg of (detalles || [])) {
    await _devolverAUnaZona(dg.lote_id, dg.ubicacion_id, parseFloat(dg.cantidad) || 0, parseFloat(dg.cantidad_unidades) || 0)
    const lote = dg.lote_id ? await getLoteById(dg.lote_id) : null
    if (lote?.es_peso_variable) {
      // Revierte a 'disponible' los bultos concretos que esta línea marcó
      // 'vendido', ANTES de borrar la guía (mismo orden que el fix de
      // compras: revertir/desvincular referencias primero, borrar después).
      await revertirBultosDeDetalleGuiaDespacho(dg.id)
      lotesPesoVariableTocados.add(dg.lote_id)
    }
  }
  // Recalcular cada lote de peso variable UNA sola vez, después de revertir
  // TODOS sus bultos (no por línea) — evita recalcular con bultos aún a
  // medio revertir si la guía tocó el mismo lote en más de una línea.
  for (const loteId of lotesPesoVariableTocados) {
    await recalcularLoteDesdeBultos(loteId)
  }

  // Kardex: se borran las filas 'salida' de esta venta que correspondan a
  // los lotes tocados por esta guía específica (documento_referencia =
  // numero_guia de esta guía).
  if (guiaActual.venta_id) {
    const kardexVenta = await getKardexByVenta(guiaActual.venta_id)
    for (const k of (kardexVenta || [])) {
      if (k.documento_referencia === guiaActual.numero_guia) {
        const okKardex = await deleteKardexMovimiento(k.id)
        if (!okKardex) {
          const motivo = ultimoErrorDelete()
          throw new Error(`No se pudo eliminar el movimiento de Kardex #${k.id} de la guía ${guiaActual.numero_guia}: ${motivo?.mensaje || 'motivo desconocido'}. Se detiene el borrado para no dejar el Kardex descuadrado.`)
        }
      }
    }
  }

  return { guiaActual, detalles: detalles || [] }
}

async function _eliminarGuiaDespachoCore(id) {
  const { guiaActual, detalles } = await _revertirStockGuiaDespacho(id)

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
            <th data-col-tabla="guias-despacho" data-col="sel" style="width:32px;${colStyle('guias-despacho','sel') ? 'display:none;' : ''}"><input type="checkbox" id="selAllGuiasDespacho" onchange="window.toggleSeleccionTodasGuiasDespacho(this.checked)" title="Seleccionar todas"></th>
            <th data-col-tabla="guias-despacho" data-col="numero_guia"${colStyle('guias-despacho','numero_guia')}>N° Guía</th>
            <th data-col-tabla="guias-despacho" data-col="venta"${colStyle('guias-despacho','venta')}>Venta</th>
            <th data-col-tabla="guias-despacho" data-col="cliente"${colStyle('guias-despacho','cliente')}>Cliente</th>
            <th data-col-tabla="guias-despacho" data-col="fecha"${colStyle('guias-despacho','fecha')}>Fecha</th>
            <th data-col-tabla="guias-despacho" data-col="estado"${colStyle('guias-despacho','estado')}>Estado</th>
            <th data-col-tabla="guias-despacho" data-col="observaciones"${colStyle('guias-despacho','observaciones')}>Observaciones</th>
            <th data-col-tabla="guias-despacho" data-col="acciones"${colStyle('guias-despacho','acciones')}>Acciones</th>
          </tr>
        </thead>
        <tbody>
          ${lista.map(g => {
            const anulada = estaAnulado(g)
            return `
            <tr${anulada ? ` style="${ESTILO_FILA_ANULADA}"` : ''}>
              <td data-col-tabla="guias-despacho" data-col="sel" style="text-decoration:none; opacity:1;${colStyle('guias-despacho','sel') ? ' display:none;' : ''}">${anulada
                ? `<input type="checkbox" disabled title="Guía anulada: su stock ya fue revertido">`
                : `<input type="checkbox" class="gd-sel" value="${g.id}" onchange="window.actualizarBotonEliminarGuiasDespacho()">`}</td>
              <td data-col-tabla="guias-despacho" data-col="numero_guia"${colStyle('guias-despacho','numero_guia')}>${g.numero_guia}</td>
              <td data-col-tabla="guias-despacho" data-col="venta"${colStyle('guias-despacho','venta')}>${g.ventaNumero}</td>
              <td data-col-tabla="guias-despacho" data-col="cliente"${colStyle('guias-despacho','cliente')}>${g.clienteNombre}</td>
              <td data-col-tabla="guias-despacho" data-col="fecha"${colStyle('guias-despacho','fecha')}>${g.fecha_guia || '-'}</td>
              <td data-col-tabla="guias-despacho" data-col="estado"${colStyle('guias-despacho','estado')}>${anulada ? badgeAnulado(g) : '<span class="badge badge-success">Emitida</span>'}</td>
              <td data-col-tabla="guias-despacho" data-col="observaciones"${colStyle('guias-despacho','observaciones')}>${g.observaciones ? _esc(g.observaciones) : (anulada && g.motivo_anulacion ? `<em style="color:var(--text-secondary);">Anulado: ${_esc(g.motivo_anulacion)}</em>` : '-')}</td>
              <td data-col-tabla="guias-despacho" data-col="acciones" class="col-acciones" style="text-decoration:none; opacity:1;${colStyle('guias-despacho','acciones') ? ' display:none;' : ''}">
                ${menuAccionesFila(anulada
                  ? [{ label: 'Ver motivo de anulación', icono: 'ℹ️', onclick: `window.verMotivoAnulacion('guia', ${g.id})` }]
                  : [
                      { label: 'Editar guía', icono: '✏️', onclick: `window.editarGuiaDespachoVenta(${g.id})` },
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

registrarColumnas('guias-despacho', [
  { key: 'sel',           label: 'Seleccionar' },
  { key: 'numero_guia',   label: 'N° Guía' },
  { key: 'venta',         label: 'Venta' },
  { key: 'cliente',       label: 'Cliente' },
  { key: 'fecha',         label: 'Fecha' },
  { key: 'estado',        label: 'Estado' },
  { key: 'observaciones', label: 'Observaciones' },
  { key: 'acciones',      label: 'Acciones' }
])
 
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
    const [ventas, clientes, detalles, items, lotes, proveedores] = await Promise.all([
      cacheado('ventas', getVentas),
      cacheado('clientes', getCustomers),
      cacheado('detalle_ventas_todos', getTodosDetalleVentas),
      cacheado('items', getItems),
      cacheado('lotes', getLotes),
      cacheado('proveedores', getSuppliers)
    ])

    const cliMap = {};   (clientes || []).forEach(c => { cliMap[c.id] = c.razon_social || c.nombre })
    const itemMap = {};  (items || []).forEach(i => { itemMap[i.id] = i })
    const ventaMap = {}; (ventas || []).forEach(v => { ventaMap[v.id] = v })
    const provMap = {};  (proveedores || []).forEach(p => { provMap[p.id] = p.razon_social || p.nombre })
    const loteMap = {};  (lotes || []).forEach(l => { loteMap[l.id] = l })

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
        const tc    = parseFloat(v.tipo_cambio || 1) || 1
        // El costo (lote.costo_unitario) SIEMPRE está en soles. El ingreso viene en
        // la moneda de la venta: si la venta es en USD hay que convertirlo a soles
        // con el TC de esa venta antes de restar el costo, o el margen mezcla monedas.
        const ingresoOriginal = parseFloat(d.subtotal || (cant * pu) || 0)
        const ingreso = (v.moneda === 'USD') ? parseFloat((ingresoOriginal * tc).toFixed(2)) : ingresoOriginal
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
    if (panelId === 'repv-lote') {
      // Ficha de vida completa del lote: nace en la compra (proveedor, fecha,
      // costo en soles) y de ahí se sigue cada venta que lo consumió, hasta el
      // total/margen final. Incluye lotes SIN ventas todavía (stock 100% intacto)
      // para dar visión de ciclo de vida completo, no solo de lo ya vendido.
      const filasLote = []
      ;(lotes || []).forEach(l => {
        const it = itemMap[l.item_id] || {}
        const base = {
          lote: l.numero_lote || `Lote ${l.id}`,
          producto: it.nombre || `Item ${l.item_id}`,
          proveedor: provMap[l.proveedor_id] || '(sin proveedor)',
          fecha_compra: l.fecha_ingreso || '',
          costo_unitario_lote: parseFloat(l.costo_unitario || 0),
          saldo_lote: parseFloat(l.cantidad || 0)
        }
        const detallesLote = (detalles || []).filter(d => {
          if (String(d.lote_id) !== String(l.id)) return false
          const v = ventaMap[d.venta_id]
          return v && !estaAnulado(v)
        })
        if (detallesLote.length === 0) {
          filasLote.push({
            ...base,
            documento: '(sin ventas)', cliente: '(sin ventas)', fecha_venta: '', mes: '',
            moneda: '—', cantidad_vendida: 0, precio_unitario: 0, ingreso: 0, costo: 0,
            margen: 0, margen_pct: 0, estado_lote: 'Sin ventas'
          })
          return
        }
        detallesLote.forEach(d => {
          const v = ventaMap[d.venta_id] || {}
          const cant = parseFloat(d.cantidad || 0)
          const pu   = parseFloat(d.precio_unitario || 0)
          const costoUnit = parseFloat(d.costo_unitario || l.costo_unitario || 0)
          const tc = parseFloat(v.tipo_cambio || 1) || 1
          const ingresoOriginal = parseFloat(d.subtotal || (cant * pu) || 0)
          const ingreso = (v.moneda === 'USD') ? parseFloat((ingresoOriginal * tc).toFixed(2)) : ingresoOriginal
          const costoTotal = parseFloat((cant * costoUnit).toFixed(2))
          filasLote.push({
            ...base,
            documento: v.numero || `${v.serie || ''}-${v.correlativo || ''}`,
            cliente: cliMap[v.contact_id] || '(sin cliente)',
            fecha_venta: v.fecha_emision || '',
            mes: nombreMes((v.fecha_emision || '').slice(0, 7)),
            moneda: v.moneda || 'PEN',
            cantidad_vendida: cant,
            precio_unitario: pu,
            ingreso, costo: costoTotal,
            margen: parseFloat((ingreso - costoTotal).toFixed(2)),
            margen_pct: ingreso > 0 ? parseFloat(((ingreso - costoTotal) / ingreso * 100).toFixed(1)) : 0,
            estado_lote: 'Con ventas'
          })
        })
      })

      crearReporte('repv-lote', {
        id: 'repv-lote',
        titulo: 'Rentabilidad por lote',
        descripcion: 'Ciclo de vida del lote: nace en la compra (proveedor, fecha, costo en soles) y de ahí se listan todas sus ventas hasta el margen final. Ingreso ya convertido a soles con el TC de cada venta.',
        datos: filasLote,
        dimensiones: [
          { key: 'lote', label: 'Lote' }, { key: 'producto', label: 'Producto' },
          { key: 'proveedor', label: 'Proveedor' }, { key: 'cliente', label: 'Cliente' },
          { key: 'documento', label: 'Venta (comprobante)' }, { key: 'mes', label: 'Mes de venta' }
        ],
        medidas: [
          { key: 'cantidad_vendida', label: 'Cant. vendida', agg: 'sum', formato: 'qty' },
          { key: 'saldo_lote', label: 'Saldo en stock', agg: 'max', formato: 'qty' },
          { key: 'ingreso', label: 'Ingreso (S/)', agg: 'sum', formato: 'money' },
          { key: 'costo', label: 'Costo (S/)', agg: 'sum', formato: 'money' },
          { key: 'margen', label: 'Margen bruto (S/)', agg: 'sum', formato: 'money', semaforo: true },
          { key: 'margen_pct', label: '% margen', agg: 'avg', formato: 'pct' }
        ],
        filtros: [
          { key: 'buscar', label: 'Buscar', tipo: 'texto', campos: ['lote', 'producto', 'proveedor', 'cliente'], placeholder: 'Lote, producto, proveedor o cliente...' },
          { key: 'estado_lote', label: 'Estado', tipo: 'select', opciones: ['Con ventas', 'Sin ventas'] },
          { key: 'compra', label: 'Fecha de compra', tipo: 'rango', campo: 'fecha_compra' },
          { key: 'venta', label: 'Fecha de venta', tipo: 'rango', campo: 'fecha_venta' }
        ],
        agruparPorDefecto: ['lote'],
        kpis: (f) => {
          const ing = f.reduce((s, x) => s + x.ingreso, 0)
          const cos = f.reduce((s, x) => s + x.costo, 0)
          const lotesDistintos = new Set(f.map(x => x.lote))
          const sinVender = new Set(f.filter(x => x.estado_lote === 'Sin ventas').map(x => x.lote))
          return [
            { label: 'Lotes en el reporte', valor: lotesDistintos.size, formato: 'int' },
            { label: 'Lotes sin vender aún', valor: sinVender.size, formato: 'int', color: 'var(--color-warning)' },
            { label: 'Ingreso total (S/)', valor: ing, formato: 'money' },
            { label: 'Margen bruto (S/)', valor: ing - cos, formato: 'money', color: (ing - cos) >= 0 ? 'var(--color-success)' : 'var(--color-danger)' },
            { label: '% margen', valor: ing ? ((ing - cos) / ing * 100) : 0, formato: 'pct' }
          ]
        }
      })
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
        // 1. Devolver el stock línea por línea. Igual que en eliminar: para
        //    lotes de peso variable, _devolverAUnaZona solo deja un valor
        //    intermedio en lote.cantidad (se pisa abajo con
        //    recalcularLoteDesdeBultos, la fuente de verdad real) y además
        //    hay que revertir los bultos concretos a 'disponible'.
        const lotesPesoVariableTocados = new Set()
        for (const dg of (detalles || [])) {
          await _devolverAUnaZona(
            dg.lote_id, dg.ubicacion_id,
            parseFloat(dg.cantidad) || 0,
            parseFloat(dg.cantidad_unidades) || 0
          )
          const lote = dg.lote_id ? await getLoteById(dg.lote_id) : null
          if (lote?.es_peso_variable) {
            await revertirBultosDeDetalleGuiaDespacho(dg.id)
            lotesPesoVariableTocados.add(dg.lote_id)
          }
        }
        for (const loteId of lotesPesoVariableTocados) {
          await recalcularLoteDesdeBultos(loteId)
        }

        // 2. Borrar el kardex de esta guía (se identifica por documento_referencia)
        if (guia.venta_id) {
          const kardexVenta = await getKardexByVenta(guia.venta_id)
          for (const k of (kardexVenta || [])) {
            if (k.documento_referencia === guia.numero_guia) {
              const okKardex = await deleteKardexMovimiento(k.id)
              if (!okKardex) {
                const motivo = ultimoErrorDelete()
                throw new Error(`No se pudo eliminar el movimiento de Kardex #${k.id} de la guía ${guia.numero_guia}: ${motivo?.mensaje || 'motivo desconocido'}. Se detiene la anulación para no dejar el Kardex descuadrado.`)
              }
            }
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

// ── Devolución de mercadería dentro de una NC ───────────────────────────────
// Solo aplica a Notas de Crédito sobre una venta que SÍ tiene guía de
// despacho (algo realmente salió del almacén). Si no hay guía, la NC es
// puramente un ajuste monetario (como era antes) — nunca salió mercadería,
// no hay nada que reingresar a Kardex.
//
// Patrón de reingreso (ver 46_nota_credito_devolucion_stock.sql): el bulto
// vendido NO se "resucita" tal cual (ese registro es el historial de ESA
// venta) — pasa a estado='devuelto_cliente' y se crea un BULTO NUEVO
// 'disponible' con bulto_origen_id apuntando al vendido, porque casi nunca
// pesa exactamente igual al repesarlo en recepción.
let _ncDevLineas = []       // líneas de despacho de la venta con algo pendiente de devolver
let _ncDevTieneDespacho = false

/** Arma _ncDevLineas a partir de las guías de despacho (no anuladas) de la venta. Cada línea de peso variable trae sus bultos vendidos aún reingresables (no devueltos antes); las de peso fijo traen la cantidad despachada como tope. */
async function _prepararDevolucionStockNota(ventaId) {
  const guiasVenta = (await getGuiasDespachoVenta(true) || []).filter(g => g.venta_id === ventaId && !estaAnulado(g))
  if (guiasVenta.length === 0) { _ncDevTieneDespacho = false; _ncDevLineas = []; return }

  const detalles = await getDetalleGuiasDespachoVentaByVenta(ventaId)
  const lineas = []
  for (const dg of (detalles || [])) {
    if (!dg.lote_id) continue
    const [lote, item] = await Promise.all([getLoteById(dg.lote_id), getItemById(dg.item_id)])
    if (!lote) continue

    if (lote.es_peso_variable) {
      const bultosLote = await getLoteBultosByLote(lote.id)
      const vendidos = (bultosLote || []).filter(b => b.detalle_guia_despacho_id === dg.id && b.estado === 'vendido')
      if (vendidos.length === 0) continue
      lineas.push({
        detalleGuiaId: dg.id, itemId: dg.item_id, nombre: item?.nombre || `Item #${dg.item_id}`,
        loteId: lote.id, numeroLote: lote.numero_lote, ubicacionId: dg.ubicacion_id,
        unidadMedida: lote.unidad_medida || 'KG', esPesoVariable: true,
        bultos: vendidos.map(b => ({ id: b.id, peso: parseFloat(b.peso) || 0 }))
      })
    } else {
      lineas.push({
        detalleGuiaId: dg.id, itemId: dg.item_id, nombre: item?.nombre || `Item #${dg.item_id}`,
        loteId: dg.lote_id, numeroLote: dg.numero_lote, ubicacionId: dg.ubicacion_id,
        unidadMedida: item?.unidad_medida || 'KG', esPesoVariable: false,
        cantidadDespachada: parseFloat(dg.cantidad) || 0
      })
    }
  }
  _ncDevTieneDespacho = true
  _ncDevLineas = lineas
}

/** HTML de la sección de devolución, inyectada en #nota-extra del modal genérico. Vacío si la venta no tiene guía de despacho. */
function _renderDevolucionStockNota() {
  if (!_ncDevTieneDespacho) return ''
  if (_ncDevLineas.length === 0) {
    return `<div style="margin-top:6px; padding:10px 12px; border-radius:var(--radius-md); background:var(--bg-secondary); font-size:0.82rem; color:var(--text-secondary);">
      Esta venta tiene guía de despacho, pero ya no queda nada pendiente de devolver (todo lo despachado ya fue devuelto o vendido nuevamente).
    </div>`
  }
  const filas = _ncDevLineas.map((l, idx) => {
    if (l.esPesoVariable) {
      const bultosHtml = l.bultos.map((b, bIdx) => `
        <div style="display:flex; align-items:center; gap:6px; padding:4px 0;">
          <input type="checkbox" id="ncDev-${idx}-b${bIdx}-chk" onchange="window.toggleBultoDevolucionNota(${idx},${bIdx})">
          <label for="ncDev-${idx}-b${bIdx}-chk" style="min-width:70px;">Bulto #${b.id}</label>
          <span style="color:var(--text-secondary); font-size:0.78rem;">vendido: ${b.peso.toFixed(2)} ${l.unidadMedida}</span>
          <span style="font-size:0.78rem;">devuelto:</span>
          <input type="number" id="ncDev-${idx}-b${bIdx}-peso" value="${b.peso}" step="0.01" min="0.01" style="width:80px;" disabled>
        </div>`).join('')
      return `
        <div style="border:1px solid var(--border-color); border-radius:var(--radius-md); padding:10px 12px; margin-bottom:8px;">
          <strong>${l.nombre}</strong> <span style="color:var(--text-secondary); font-size:0.8rem;">— lote ${l.numeroLote} (peso variable)</span>
          ${bultosHtml}
        </div>`
    }
    return `
      <div style="border:1px solid var(--border-color); border-radius:var(--radius-md); padding:10px 12px; margin-bottom:8px; display:flex; align-items:center; gap:10px; flex-wrap:wrap;">
        <div><strong>${l.nombre}</strong> <span style="color:var(--text-secondary); font-size:0.8rem;">— lote ${l.numeroLote}</span></div>
        <span style="color:var(--text-secondary); font-size:0.78rem;">despachado: ${l.cantidadDespachada} ${l.unidadMedida}</span>
        <label style="font-size:0.78rem;">Cantidad a devolver:</label>
        <input type="number" id="ncDev-${idx}-cantidad" value="0" step="0.01" min="0" max="${l.cantidadDespachada}" style="width:90px;">
      </div>`
  }).join('')

  return `
    <div id="ncDev-requerido-aviso" style="display:none; margin-top:10px; padding:8px 10px; border-radius:var(--radius-md); background:rgba(245,158,11,.14); color:var(--color-warning); font-size:0.8rem;">
      El motivo elegido es una devolución: selecciona qué se devuelve para reingresarlo al stock.
    </div>
    <div style="margin-top:10px;">
      <strong style="display:block; margin-bottom:6px; font-size:0.85rem;">📦 Devolución de mercadería (esta venta tiene guía de despacho)</strong>
      <small style="display:block; margin-bottom:8px; color:var(--text-secondary);">
        Marca/ingresa lo que el cliente realmente devuelve. Se reingresa a la MISMA zona de donde salió (se puede reubicar después con un Traslado Interno). El importe de la nota se sigue ingresando arriba: no se calcula solo, tú decides cuánto vale la devolución.
      </small>
      ${filas}
    </div>`
}

window.toggleBultoDevolucionNota = function (idx, bIdx) {
  const chk = document.getElementById(`ncDev-${idx}-b${bIdx}-chk`)
  const inp = document.getElementById(`ncDev-${idx}-b${bIdx}-peso`)
  if (inp) inp.disabled = !chk?.checked
}

/** Lee del DOM lo que el usuario seleccionó/tipeó. Solo incluye líneas con algo realmente marcado (>0). */
function _leerDevolucionStockNota() {
  const seleccion = []
  _ncDevLineas.forEach((l, idx) => {
    if (l.esPesoVariable) {
      const bultos = []
      l.bultos.forEach((b, bIdx) => {
        const chk = document.getElementById(`ncDev-${idx}-b${bIdx}-chk`)
        if (!chk?.checked) return
        const peso = parseFloat(document.getElementById(`ncDev-${idx}-b${bIdx}-peso`)?.value || 0)
        if (peso > 0) bultos.push({ bultoId: b.id, pesoDevuelto: peso })
      })
      if (bultos.length > 0) seleccion.push({ ...l, bultos })
    } else {
      const cantidad = parseFloat(document.getElementById(`ncDev-${idx}-cantidad`)?.value || 0)
      if (cantidad > 0) seleccion.push({ ...l, cantidadDevuelta: Math.min(cantidad, l.cantidadDespachada) })
    }
  })
  return seleccion
}

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
        - parseFloat(cxc.monto_anticipo_aplicado || 0)
      : totalOrigen

    const cliente = await _nombreCliente(venta.contact_id)
    const cfg = getModuloConfig('ventas')
    // SUNAT (RS 097-2012) exige que la serie de la nota inicie con la misma
    // letra que el comprobante que modifica: 'F' si es Factura, 'B' si es
    // Boleta. Antes se usaba siempre la serie de Factura (FC01/FD01) sin
    // importar el origen.
    const esBoletaOrigen = String(venta.tipo_comprobante) === '03'
    const serieSugerida = tipoNota === TIPO_NC
      ? (esBoletaOrigen ? (cfg.serieNotaCreditoBoleta || 'BC01') : (cfg.serieNotaCredito || 'FC01'))
      : (esBoletaOrigen ? (cfg.serieNotaDebitoBoleta  || 'BD01') : (cfg.serieNotaDebito  || 'FD01'))
    const correlativo = await generarNumeroVenta(tipoNota, serieSugerida)

    // Devolución de mercadería: solo tiene sentido en una NC (una ND nunca
    // "devuelve" stock, suma valor). Se arma ANTES de abrir el modal para
    // que la sección ya esté lista si el motivo elegido es de devolución.
    if (tipoNota === TIPO_NC) {
      await _prepararDevolucionStockNota(ventaId)
    } else {
      _ncDevTieneDespacho = false
      _ncDevLineas = []
    }

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
      renderExtra: () => _renderDevolucionStockNota(),
      onMotivoCambio: (motivo, anulaTotal) => {
        // Los motivos '06' (devolución total) y '07' (devolución por ítem)
        // del Catálogo 09 SUNAT son los que exigen seleccionar qué se
        // devuelve; el resto (descuentos, correcciones, etc.) la dejan
        // opcional aunque haya guía de despacho.
        const aviso = document.getElementById('ncDev-requerido-aviso')
        if (aviso) aviso.style.display = (_ncDevTieneDespacho && (motivo === '06' || motivo === '07')) ? 'block' : 'none'
      },
      validarExtra: () => {
        if (!_ncDevTieneDespacho) return { ok: true }
        const motivo = document.getElementById('notaMotivo')?.value
        const esMotivoDevolucion = motivo === '06' || motivo === '07'
        if (!esMotivoDevolucion) return { ok: true }
        const seleccion = _leerDevolucionStockNota()
        if (seleccion.length === 0) {
          return { ok: false, mensaje: 'El motivo elegido es una devolución y la venta tiene guía de despacho: selecciona qué se devuelve para reingresarlo al stock (o cambia el motivo si no corresponde devolver mercadería).' }
        }
        return { ok: true }
      },
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

        // 1.5. Reingreso de stock por devolución (si el usuario marcó algo)
        if (_ncDevTieneDespacho) {
          const seleccion = _leerDevolucionStockNota()
          if (seleccion.length > 0) {
            try {
              const lotesPesoVariableTocados = new Set()
              for (const linea of seleccion) {
                if (linea.esPesoVariable) {
                  const devoluciones = linea.bultos.map(b => ({
                    bultoVendidoId: b.bultoId, pesoDevuelto: b.pesoDevuelto, ubicacionId: linea.ubicacionId
                  }))
                  const resultado = await reingresarBultosPorNotaCredito(devoluciones, nota.id, d.usuarioId)
                  for (let i = 0; i < resultado.length; i++) {
                    const r = resultado[i]
                    lotesPesoVariableTocados.add(r.loteId)
                    await addNotaCreditoVentaDetalle({
                      nota_venta_id: nota.id, venta_origen_id: ventaId, item_id: linea.itemId,
                      lote_id: r.loteId, cantidad: devoluciones[i].pesoDevuelto, unidad_medida: linea.unidadMedida,
                      lote_bulto_nuevo_id: r.bultoNuevo?.id || null, reingresa_stock: true, created_by: d.usuarioId
                    })
                  }
                } else {
                  const lote = await getLoteById(linea.loteId)
                  const nuevaCantidadLote = parseFloat(((parseFloat(lote?.cantidad) || 0) + linea.cantidadDevuelta).toFixed(4))
                  await updateLote(linea.loteId, { cantidad: nuevaCantidadLote })

                  const filas = await getStockUbicacionesByLote(linea.loteId)
                  const fila = (filas || []).find(f => f.ubicacion_id === linea.ubicacionId)
                  if (fila) {
                    await updateStockUbicacion(fila.id, {
                      cantidad: parseFloat(((parseFloat(fila.cantidad) || 0) + linea.cantidadDevuelta).toFixed(4))
                    })
                  } else {
                    await addStockUbicacion({ lote_id: linea.loteId, ubicacion_id: linea.ubicacionId, cantidad: linea.cantidadDevuelta })
                  }

                  await addNotaCreditoVentaDetalle({
                    nota_venta_id: nota.id, venta_origen_id: ventaId, item_id: linea.itemId,
                    lote_id: linea.loteId, cantidad: linea.cantidadDevuelta, unidad_medida: linea.unidadMedida,
                    reingresa_stock: true, created_by: d.usuarioId
                  })
                }
              }

              // Lotes con bultos: recalcular cantidad/cantidad_unidades desde
              // los bultos disponibles reales (los de peso fijo ya se
              // actualizaron directamente arriba, no se tocan de nuevo).
              for (const loteId of lotesPesoVariableTocados) await recalcularLoteDesdeBultos(loteId)

              // Kardex: un movimiento 'entrada' por línea devuelta, desde la
              // zona virtual Partners/Customers (espejo exacto de la salida
              // que hizo la guía de despacho) hacia la zona real de recepción.
              const customersZona = await getUbicacionCustomers()
              for (const linea of seleccion) {
                const loteActual = await getLoteById(linea.loteId)
                const costoUnitLote = parseFloat(loteActual?.costo_unitario || 0)
                const cantidadLinea = linea.esPesoVariable
                  ? linea.bultos.reduce((s, b) => s + (b.pesoDevuelto || 0), 0)
                  : linea.cantidadDevuelta
                await addKardexMovimiento({
                  item_id: linea.itemId, lote_id: linea.loteId,
                  ubicacion_origen_id: customersZona?.id || null, ubicacion_destino_id: linea.ubicacionId,
                  fecha: d.fecha, tipo_movimiento: 'entrada', concepto: 'Devolución de cliente (Nota de Crédito)',
                  documento_referencia: `${d.serie}-${d.numero}`,
                  cantidad_entrada: cantidadLinea, cantidad_salida: 0,
                  cantidad_unidades_entrada: 0, cantidad_unidades_salida: 0,
                  costo_unitario: costoUnitLote,
                  valor_entrada: parseFloat((cantidadLinea * costoUnitLote).toFixed(2)), valor_salida: 0,
                  moneda: loteActual?.moneda || 'PEN', tipo_cambio: parseFloat(loteActual?.tipo_cambio) || 1,
                  costo_unit_original: parseFloat(loteActual?.costo_unit_original ?? costoUnitLote),
                  saldo_cantidad: parseFloat(loteActual?.cantidad || 0),
                  saldo_valor: parseFloat(((parseFloat(loteActual?.cantidad) || 0) * costoUnitLote).toFixed(2)),
                  saldo_unidades: parseFloat(loteActual?.cantidad_unidades || 0),
                  venta_id: ventaId, created_by: d.usuarioId
                })
              }

              showToast('Stock reingresado a Inventario por la devolución', 'success')
            } catch (eDev) {
              console.error('Error reingresando stock por NC:', eDev)
              showToast('Nota emitida ⚠️ el reingreso de stock falló: ' + eDev.message + ' — revísalo manualmente en Inventario', 'warning', 9000)
            }
          }
        }

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
              - parseFloat(cxc.monto_anticipo_aplicado || 0)
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
        - parseFloat(c.monto_anticipo_aplicado || 0)
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
