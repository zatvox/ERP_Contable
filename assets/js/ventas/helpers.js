// ============================================================================
// ventas/helpers.js — parte de ventas.js (reorganizado 2026-09-25, sin cambios de lógica)
// Mapa completo de funciones: Claude outputs/glosario_funciones_erp.md
// ============================================================================
import { S } from './state.js'
import { getContactById, getLotes, getStockUbicaciones } from '../supabase-data.js'
import { formatQty, pintarDocumentoContacto } from '../helpers.js'
import { refrescarBuscador } from '../buscador-select.js'
import { aplicarTiposPorCliente } from '../series.js'
import { showToast } from '../helpers.js'
import { leerCronograma } from '../cronograma.js'
import { _almacenes, _esc, _zonas } from './init.js'
import { _cargarAnticiposDisponiblesCliente } from './venta-anticipo.js'
import { _avisarCreditoCliente, _cronogramaVentaListo, _prepararCronogramaVenta } from './venta-nueva.js'

// ============================================================================
// HELPERS
// ============================================================================

export function _poblarSelectClientes() {
  const sel = document.getElementById('cotCliente')
  const selV = document.getElementById('ventaContactId')
  const opts = '<option value="">-- Selecciona Cliente --</option>' +
    S._clientes.map(c => `<option value="${c.id}">${c.razon_social || c.nombre || c.name || c.email}</option>`).join('')
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
  return (S._stockUbic || [])
    .filter(su => S._lotesMap[su.lote_id]?.item_id === itemId)
    .reduce((s, su) => s + (parseFloat(su.cantidad) || 0), 0)
}

// Tasa fija del Régimen de Retenciones del IGV (SUNAT) — mismo valor que
// cobranzas.js usa al aplicar la retención en el cobro. Acá es solo
// informativo: la venta se emite por el 100%, la retención real se
// descuenta recién al cobrar.
const RETENCION_IGV_PCT = 0.03

/** Pinta el RUC/DNI del contacto elegido debajo de su selector — reutilizable
 * en cualquier modal de Ventas con selector de Cliente (Nueva Venta, Editar
 * Venta, Cotización): todos leen del mismo array `_clientes`. */
function _pintarDocClienteVentas(selectId, infoId) {
  const contactId = parseInt(document.getElementById(selectId)?.value || 0)
  const cliente = S._clientes.find(c => c.id === contactId)
  pintarDocumentoContacto(infoId, cliente || null)
}

/** Aviso informativo (no bloquea nada) si el cliente elegido es agente de retención IGV. */
window.onCambiarClienteVenta = async function () {
  _pintarDocClienteVentas('ventaContactId', 'ventaClienteDocInfo')
  // Tipo según documento del cliente: DNI → solo Boleta; RUC → Factura primero.
  {
    const id = parseInt(document.getElementById('ventaContactId')?.value || 0)
    const cli = (S._clientes || []).find(c => c.id === id) || null
    const selTipo = document.getElementById('ventaTipoComp')
    if (S._tipoVentaActual !== 'anticipo' && aplicarTiposPorCliente(selTipo, cli)) {
      showToast(`Tipo → ${selTipo.value === '03' ? 'Boleta' : 'Factura'} según el documento del cliente`, 'info')
      await window.onCambiarTipoCompVenta?.()
    } else if (S._tipoVentaActual !== 'anticipo' && selTipo?.value === '01') {
      // Mismo tipo, otro cliente: la lista de series depende de si es DNI (acepta_dni)
      await window.onCambiarTipoCompVenta?.()
    }
  }
  _actualizarAvisoRetencionVenta()
  _avisarCreditoCliente()
  // El término del cliente es solo una sugerencia: se recarga el selector,
  // pero si el usuario ya personalizó el cronograma no se le pisa.
  const crono = leerCronograma('venta-cronograma')
  if (_cronogramaVentaListo && !crono?.personalizado) _prepararCronogramaVenta(true)
  _cargarAnticiposDisponiblesCliente()
}

/** Editar Venta: el Cliente normalmente ya viene precargado; si el usuario lo
 * cambia, el RUC/DNI mostrado debe actualizarse igual. */
window._onCambiarClienteEditarVenta = async function (soloOpciones = false) {
  _pintarDocClienteVentas('evContactId', 'evClienteDocInfo')
  // Mismo criterio en Editar. Al ABRIR solo se marcan las opciones no válidas
  // (no se cambia el tipo guardado); al cambiar de cliente sí se ajusta.
  const selTipo = document.getElementById('evTipoComp')
  if (selTipo?.dataset.editable) {
    const id = parseInt(document.getElementById('evContactId')?.value || 0)
    const cli = (S._clientes || []).find(c => c.id === id) || null
    if (aplicarTiposPorCliente(selTipo, cli, { cambiarValor: soloOpciones !== true && !selTipo.disabled })) {
      await window._onCambiarTipoEdicionVenta?.()
    } else if (soloOpciones !== true && selTipo.value === '01') {
      await window._onCambiarTipoEdicionVenta?.()
    }
  }
}

/** Cotización: mismo patrón. */
window._onCambiarClienteCotizacion = function () {
  _pintarDocClienteVentas('cotCliente', 'cotClienteDocInfo')
}

export function _actualizarAvisoRetencionVenta() {
  const aviso = document.getElementById('ventaClienteRetencionAviso')
  if (!aviso) return
  const contactId = parseInt(document.getElementById('ventaContactId')?.value || 0)
  const cliente = S._clientes.find(c => c.id === contactId)
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

export function _poblarSelectItems() {
  const sel = document.getElementById('ventaItemSelect')
  if (!sel) return
  const itemsConStock = (S._items || []).filter(i => _stockTotalItem(i.id) > 0)
  sel.innerHTML = '<option value="">-- Selecciona producto --</option>' +
    // data-costo se eliminó: items.costo_promedio nunca se actualiza (queda
    // en 0 siempre) — el costo real ahora se toma del lote elegido.
    itemsConStock.map(i => `<option value="${i.id}" data-precio="${i.precio_venta || 0}">${(i.codigo || i.sku) ? '(' + (i.codigo || i.sku) + ') ' : ''}${i.nombre || i.name}</option>`).join('')
  refrescarBuscador('ventaItemSelect')
}

export function _poblarSelectLotes() {
  const sel = document.getElementById('cotLote')
  if (!sel) return
  sel.innerHTML = '<option value="">-- Selecciona Lote --</option>' +
    S._lotes.map(l => `<option value="${l.id}">${l.numero_lote} (Stock: ${l.cantidad || l.stock || 0})</option>`).join('')
}

export function _poblarSelectVendedores() {
  const opts = '<option value="">-- Sin asignar --</option>' +
    S._vendedores.map(v => `<option value="${v.id}">${v.nombre}</option>`).join('')
  const selNueva = document.getElementById('ventaVendedor')
  const selEditar = document.getElementById('evVendedor')
  if (selNueva) selNueva.innerHTML = opts
  if (selEditar) selEditar.innerHTML = opts
}

export async function _nombreCliente(contactId) {
  if (!contactId) return '-'
  const local = S._clientes.find(c => c.id === contactId)
  if (local) return local.razon_social || local.nombre || local.name || `ID ${contactId}`
  try {
    const c = await getContactById(contactId)
    return c?.razon_social || c?.nombre || c?.name || `ID ${contactId}`
  } catch { return `ID ${contactId}` }
}

export function _nombreVendedor(vendedorId) {
  if (!vendedorId) return '-'
  const v = S._vendedores.find(x => x.id === vendedorId)
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
export function _stockTotalPorItem(itemId) {
  if (!itemId) return { totalKg: 0, totalUnid: 0, lotes: [] }
  const almacenesMap = {}
  for (const a of (_almacenes || [])) almacenesMap[a.id] = a
  const zonasMap = {}
  for (const z of (_zonas || [])) zonasMap[z.id] = z

  // Las zonas virtuales (Partners/Vendors, Partners/Customers) son solo
  // para el Kardex — nunca stock real vendible.
  const filas = (S._stockUbic || [])
    .filter(su => {
      if ((parseFloat(su.cantidad) || 0) <= 0) return false
      if (S._lotesMap[su.lote_id]?.item_id !== itemId) return false
      const zona = zonasMap[su.ubicacion_id]
      if (!zona) return false
      return !almacenesMap[zona.almacen_id]?.es_virtual
    })
    .sort((a, b) => new Date(S._lotesMap[a.lote_id]?.fecha_ingreso || 0) - new Date(S._lotesMap[b.lote_id]?.fecha_ingreso || 0))

  let totalKg = 0, totalUnid = 0
  const lotes = filas.map(su => {
    const lote = S._lotesMap[su.lote_id]
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
export function _sugerirUnidadesLineaVenta() {
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
export function _actualizarAvisoStockLineaVenta() {
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
export async function _refrescarStockLoteEnVivo() {
  const [lotesFrescos, stockFresco] = await Promise.all([getLotes(), getStockUbicaciones()])
  S._lotes = lotesFrescos
  S._stockUbic = stockFresco
  S._lotesMap = {}
  for (const lo of (S._lotes || [])) S._lotesMap[lo.id] = lo
}

/** Al elegir un producto: refresca stock en vivo y muestra el total disponible + desglose de lotes. */
window.onCambiarItemLineaVenta = async function () {
  const sel = document.getElementById('ventaItemSelect')
  const opt = sel?.selectedOptions[0]
  const itemId = parseInt(sel?.value || 0)
  const item = S._items.find(i => i.id === itemId)
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
