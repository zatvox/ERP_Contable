// ============================================================================
// COMPRAS.JS - Módulo Compras (Versión Async/Await Completa)
// ============================================================================

import { getCurrentUser } from './auth-supabase.js'
import { registrarColumnas, colStyle } from './col-menu.js'
import {  getOrderCompras, getOrderComprasPage, getOrderCompraById, addOrderCompra, updateOrderCompra,
          getCompras, getComprasPage, getCompraById, addCompra, addCompraDetalle, updateCompra, deleteCompra,
          getCompraDetalles, updateCompraDetalle, deleteCompraDetalle,
          getOrderCompraDetalles, getOrderCompraDetalleById, addOrderCompraDetalle, updateOrderCompraDetalle, deleteOrderCompraDetalle,
          getLoteById, getLotesByItemId, getLotesByCompraId, getLotes, addLote, updateLote, deleteLote,
          getItems, getItemById, addItem, updateItem, deleteItem,
          getSuppliers, addContact, getContactById, updateContact, deleteContact, tiposDeContacto,
          getCategorias, addCategoria, getMarcas, getPartidas, getCuentasGasto,
          getTipoDocumentos,
          getGuiasIngresoCompra, getGuiaIngresoCompraById, addGuiaIngresoCompra, updateGuiaIngresoCompra, deleteGuiaIngresoCompra,
          getDetalleGuiasIngresoCompra, addDetalleGuiaIngresoCompra, deleteDetalleGuiaIngresoCompra,
          getTodosDetalleCompras, getTodosDetalleGuiasIngresoCompra,
          getAlmacenes, getUbicaciones, addStockUbicacion,
          getUbicacionVendors, addKardexMovimiento, getKardexByCompra, deleteKardexMovimiento,
          getTipoDocumentosMap, getNombreTipoDocumentoSync, cargarSelectTipoDocumentos,
          addCuentaPagar, getCuentasPagarByCompra, updateCuentaPagar, deleteCuentaPagar, addCuotaPagar,
          getTodosComprasAnticiposAplicados, getAnticiposAplicadosPorAnticipoCompra, getAnticiposAplicadosPorDestinoCompra, addCompraAnticipoAplicado,
          getPagosProveedoresByCompra, getPagosProveedoresByCxP, deletePagoProveedor, ultimoErrorDelete,
          updateStockUbicacion, getStockUbicacionesByLote,
          reversarAsiento, generarAsientoCompra, generarAsientoGuiaRemision,
          subirAdjuntoCompra, getUrlAdjuntoCompra, eliminarAdjuntoCompra,
          addLoteBulto, recalcularLoteDesdeBultos, getLoteBultosByLote, deleteLoteBulto,
          updateLoteBulto, getLoteBultosDisponiblesZona, revertirBultosDeDetalleGuiaDevolucion, getLoteBultosPorDetalleGuiaDevolucion,
          getNotaCreditoCompraDetalleByNota, getNotaCreditoCompraDetalleByCompraOrigen, addNotaCreditoCompraDetalle, deleteNotaCreditoCompraDetalle,
          getGuiasDevolucionCompra, getGuiaDevolucionCompraById, addGuiaDevolucionCompra, updateGuiaDevolucionCompra, deleteGuiaDevolucionCompra,
          getDetalleGuiasDevolucionCompra, getDetalleGuiasDevolucionCompraByNotaDetalle, getTodosDetalleGuiasDevolucionCompra,
          addDetalleGuiaDevolucionCompra, deleteDetalleGuiaDevolucionCompra } from './supabase-data.js'
import { ASIENTOS_AUTO_COMPRAS_ACTIVO } from './config-asientos-auto.js'
import { getTCCompra, attachConsultaDocumento, pintarBadgeSunat } from './sunat-api.js'
import { showToast, formatNumber, formatQty } from './helpers.js'
import { initModuleNavDropdowns, initSubtabs, menuAccionesFila } from './main.js'
import { abrirModalAnulacion, camposAnulacion, estaAnulado, badgeAnulado, ESTILO_FILA_ANULADA } from './anulacion.js'
import { abrirModalNota, TIPO_NC, TIPO_ND, esNota, signoDocumento, badgeTipoDocumento } from './notas.js'
import { convertirVarios, convertirEnBuscador, refrescarBuscador } from './buscador-select.js'
import { getModuloConfig, renderConfiguracionTab, aplicarPreferenciasVista } from './config-modulo.js'
import { cacheado } from './data-cache.js'
import { crearReporte, nombreMes } from './reportes.js'
import { renderEditorCronograma, actualizarCronograma, leerCronograma, getTerminosConCuotas, generarCronograma, cronogramaDesdeTexto } from './cronograma.js'

// ─── Tipo de Cambio automático ────────────────────────────────────────────────

/**
 * Consulta el TC COMPRA SBS para la fecha indicada y llena #ccTipoCambio.
 * Usar en compras/importaciones en USD (Art. 61° LIR).
 */
async function _autoFetchTCCompra(fecha = null) {
  const campo = document.getElementById('ccTipoCambio')
  const aviso = document.getElementById('ccTCAviso')
  if (!campo) return

  if (aviso) aviso.textContent = 'Consultando SBS...'
  const result = await getTCCompra(fecha)

  if (result.error) {
    if (aviso) aviso.textContent = `⚠️ ${result.error} — ingresa TC manualmente`
    showToast('No se pudo obtener el TC de SUNAT. Ingresa el tipo de cambio manualmente.', 'warning')
    return
  }

  campo.value = result.tc.toFixed(3)
  if (aviso) aviso.textContent = `TC Compra SBS ${result.fecha}: S/. ${result.tc.toFixed(3)} — Art. 61° LIR`
}

/** Botón "↻ Auto" en el modal de confirmar compra */
window.autoFetchTCCompra = async function () {
  const fecha = document.getElementById('ccFecha')?.value || null
  const btn   = document.getElementById('btnAutoTCCompra')
  if (btn) btn.disabled = true
  await _autoFetchTCCompra(fecha)
  if (btn) btn.disabled = false
}

// ─────────────────────────────────────────────────────────────────────────────

// ============================================================================
// INICIALIZACIÓN
// ============================================================================

document.addEventListener('DOMContentLoaded', async () => {
  try {
    const user = await getCurrentUser()
    const userDisplay = document.getElementById('userDisplay')
    if (userDisplay && user) {
      userDisplay.textContent = user.nombre || user.email
    }

    aplicarPreferenciasVista('compras')
    initTabsCompras()
    // Lazy loading: solo se carga el tab visible (Compras, por defecto ahora
    // que Órdenes de Compra está en standby) + selects de los modales.
    // El tab Proveedores se carga recién al hacer click.
    await Promise.all([
      getTipoDocumentosMap(),   // precarga cache para getNombreTipoDocumentoSync
      cargarProveedoresSelect(),
      cargarItemsSelect(),
      cargarCuentasGastoSelect(),
      renderCompras()           // solo el tab activo por defecto
    ])

    // Se convierten DESPUÉS de cargar las opciones, para que el buscador ya
    // tenga la lista completa desde el primer foco.
    _activarBuscadoresCompras()

    // Botón "Consultar" en el modal Nuevo Proveedor (RUC o DNI, según Tipo Documento)
    attachConsultaDocumento({
      btnId: 'btnConsultarProvRUC', tipoDocId: 'provTipoDocumento', numeroId: 'provRUC',
      nombreId: 'provNombre', direccionId: 'provDireccion', distritoId: 'provDistrito', paisId: 'provPais',
      sunatSectionId: 'provDatosSunat', estadoId: 'provEstadoSunat', condicionId: 'provCondicionSunat',
      buenContribuyenteId: 'provBuenContribuyenteSunat', agenteRetencionId: 'provSujetoRetencion',
      agenteRetencionBadgeId: 'provAgenteRetencionSunat'
    })
  } catch (error) {
    console.error('Error en DOMContentLoaded:', error)
    showToast('Error al cargar el módulo de compras', 'danger')
  }
})

// ============================================================================
// TABS
// ============================================================================

function initTabsCompras() {
  const btns = document.querySelectorAll('#comprasTabs .tab-btn')
  const contents = document.querySelectorAll('.tab-content')

  btns.forEach(btn => {
    btn.addEventListener('click', async () => {
      const tab = btn.getAttribute('data-tab')

      btns.forEach(b => b.classList.remove('active'))
      contents.forEach(c => c.classList.remove('active'))

      btn.classList.add('active')
      const tabContent = document.getElementById(`tab-${tab}`)
      if (tabContent) {
        tabContent.classList.add('active')
      }

      if (tab === 'ordenes') await renderOrdenes()
      if (tab === 'compras') await renderCompras()
      if (tab === 'guias') await renderGuias()
      if (tab === 'proveedores') await renderProveedores()
      if (tab === 'configuracion') renderConfiguracionTab('compras', 'tab-configuracion')
      if (tab === 'reportes') {
        const activo = document.querySelector('#com-subtabs-reportes .subtab.active')?.getAttribute('data-sub') || 'repcm-evolucion'
        await construirReporteCompras(activo)
      }
    })
  })

  initSubtabs('#com-subtabs-reportes', (panel) => construirReporteCompras(panel))

  // Convierte la fila de tabs (agrupada en dropdowns dentro del header) en un
  // submenú desplegable estilo Odoo. No reemplaza el listener de arriba, solo
  // agrega abrir/cerrar y resaltar el grupo activo.
  initModuleNavDropdowns('#comprasTabs')
}

// ============================================================================
// ÓRDENES DE COMPRA
// ============================================================================

// Paginación server-side: solo se piden 50 órdenes por página a Supabase
const OC_POR_PAGINA = 50
let _ocPagina = 1

async function renderOrdenes() {
  try {
    const container = document.getElementById('tabla-oc')
    if (!container) return

    const [{ data: ordenes, total }, proveedores] = await Promise.all([
      getOrderComprasPage({ pagina: _ocPagina, porPagina: OC_POR_PAGINA }),
      getSuppliers() // cacheado; para mostrar nombre de proveedor
    ])

    if (!ordenes || ordenes.length === 0) {
      container.innerHTML = '<p style="text-align: center; color: var(--text-secondary); padding: 20px;">Sin órdenes de compra</p>'
      return
    }

    const proveedoresMap = {}
    proveedores.forEach(p => { proveedoresMap[p.id] = p.nombre || 'Sin nombre' })

    const totalPaginas = Math.max(1, Math.ceil(total / OC_POR_PAGINA))
    const inicio = (_ocPagina - 1) * OC_POR_PAGINA
    const paginador = `
      <div style="display:flex; justify-content:space-between; align-items:center; padding:12px 16px;">
        <span style="color:var(--text-secondary); font-size:0.85rem;">
          Mostrando ${inicio + 1}–${inicio + ordenes.length} de ${total} órdenes
        </span>
        <div style="display:flex; gap:8px; align-items:center;">
          <button class="btn btn-small btn-secondary" onclick="window.cambiarPaginaOrdenes(-1)" ${_ocPagina <= 1 ? 'disabled' : ''}>← Anterior</button>
          <span style="font-size:0.85rem;">Página ${_ocPagina} de ${totalPaginas}</span>
          <button class="btn btn-small btn-secondary" onclick="window.cambiarPaginaOrdenes(1)" ${_ocPagina >= totalPaginas ? 'disabled' : ''}>Siguiente →</button>
        </div>
      </div>
    `

    let html = paginador + `
      <table>
        <thead>
          <tr>
            <th>Número</th>
            <th>Proveedor</th>
            <th>Fecha</th>
            <th>Moneda</th>
            <th>Subtotal</th>
            <th>IGV</th>
            <th>Total</th>
            <th>Estado</th>
            <th>Acciones</th>
          </tr>
        </thead>
        <tbody>
    `
    ordenes.forEach(oc => {
      html += `
        <tr>
          <td><strong>${oc.id}</strong></td>
          <td>${proveedoresMap[oc.contact_id] || '-'}</td>
          <td>${oc.fecha || '-'}</td>
          <td>${oc.currency || 'PEN'}</td>
          <td>${(oc.total_subtotal || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
          <td>${(oc.total_igv || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
          <td><strong>${(oc.total_OC || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</strong></td>
          <td><span class="badge badge-${oc.status || 'pending'}">${oc.status || 'pending'}</span></td>
          <td>
            <button class="btn btn-small btn-secondary" onclick="window.verOC(${oc.id})">Ver</button>
            ${oc.status === 'borrador' ? `<button class="btn btn-small btn-primary" onclick="window.confirmarOC(${oc.id})">Confirmar</button>` : ''}
          </td>
        </tr>
      `
    })

    html += '</tbody></table>' + paginador
    container.innerHTML = html
  } catch (error) {
    console.error('Error en renderOrdenes:', error)
    showToast('Error al cargar las órdenes', 'danger')
  }
}

window.cambiarPaginaOrdenes = async function (delta) {
  _ocPagina += delta
  if (_ocPagina < 1) _ocPagina = 1
  await renderOrdenes()  // pide solo los 50 de la nueva página al servidor
}

window.verOC = async function (id) {
  try {
    const oc = await getOrderCompraById(id)
    if (!oc) {
      showToast('Orden no encontrada', 'warning')
      return
    }

    const prov = await getContactById(oc.contact_id)
    const detalles = await getOrderCompraDetalles(id) || []

    let detallesText = 'Sin detalles'
    if (detalles.length > 0) {
      const detallesPromises = detalles.map(async d => {
        const item = await getItemById(d.item_id)
        const nombreProducto = item ? (item.nombre || item.name) : `#${d.item_id}`
        return `producto: ${nombreProducto}
          ${(parseFloat(d.cantidad) || 0).toLocaleString('en-US', { maximumFractionDigits: 2 })} kg x ${(parseFloat(d.precio_unitario) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${oc.currency} = ${(parseFloat(d.total) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${oc.currency}`
      })
      const detallesArray = await Promise.all(detallesPromises)
      detallesText = detallesArray.join('\n')
    }

    const mensaje = `
          OC #${oc.id}
          Proveedor: ${prov?.nombre || '-'}
          Fecha: ${oc.fecha || '-'}
          Moneda: ${oc.currency || 'PEN'}
          Estado: ${oc.status || '-'}

          DETALLES:
          ${detallesText}

          TOTALES:
          Subtotal: ${oc.currency || 'PEN'} ${(oc.total_subtotal || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          IGV: ${oc.currency || 'PEN'} ${(oc.total_igv || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          Total: ${oc.currency || 'PEN'} ${(oc.total_OC || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              `

    alert(mensaje)
  } catch (error) {
    console.error('Error en verOC:', error)
    showToast('Error al ver la orden', 'danger')
  }
}


/**
 * Abre el modal "Confirmar Compra" pre-cargado con los datos de la OC.
 * El usuario completa tipo_documento, N° comprobante, y por cada producto
 * el N° de Lote (obligatorio) y N° de Partida (opcional). Al confirmar se
 * crea la compra + su detalle y se suma el stock directamente a Inventario
 * (el módulo de Contabilidad está en standby: no se genera asiento).
 */
window.confirmarOC = async function (id) {
  try {
    const oc = await getOrderCompraById(id)
    if (!oc) { showToast('Orden no encontrada', 'warning'); return }
    if (oc.status === 'confirmado') { showToast('Esta OC ya fue confirmada', 'warning'); return }

    const [prov, detallesRaw, categorias, marcas, partidas] = await Promise.all([
      getContactById(oc.contact_id),
      getOrderCompraDetalles(id),
      getCategorias(),
      getMarcas(),
      getPartidas()
    ])
    const detalles = detallesRaw || []

    // Cargar mapa de items
    const itemIds = [...new Set(detalles.map(d => d.item_id))]
    const itemsMap = {}
    await Promise.all(itemIds.map(async iid => {
      const item = await getItemById(iid)
      if (item) itemsMap[iid] = item
    }))
    const catMap = {}; (categorias || []).forEach(c => { catMap[c.id] = c.nombre })
    const marMap = {}; (marcas || []).forEach(m => { marMap[m.id] = m.nombre })

    _ocContextConfirmar = { oc, prov, detalles, itemsMap }

    // --- Llenar cabecera readonly ---
    document.getElementById('cc-oc-numero').textContent = oc.numero || `OC-${oc.id}`
    document.getElementById('cc-proveedor').textContent = prov?.nombre || '-'
    document.getElementById('cc-moneda').textContent = oc.currency || 'PEN'

    // --- Valores por defecto del formulario ---
    const fechaCompra = oc.fecha || new Date().toISOString().split('T')[0]
    document.getElementById('ccFecha').value = fechaCompra
    document.getElementById('ccTipoCambio').value = (oc.currency === 'PEN') ? '1.000' : ''
    document.getElementById('ccTipoPago').value = oc.tipo_pago || 'credito'

    // Auto-carga TC COMPRA SBS si la OC es en USD (Art. 61° LIR)
    if (oc.currency === 'USD') {
      _autoFetchTCCompra(fechaCompra)
    }
    document.getElementById('ccDescripcion').value =
      `Compra ${oc.numero || ''} - ${prov?.nombre || ''}`.trim()
    document.getElementById('ccNumeroComprobante').value = ''

    // --- Cargar select tipo_documento con el catálogo SUNAT ---
    await cargarSelectTipoDocumentos('ccTipoDocumento', '01')

    // --- Tabla de productos: categoría/marca informativos + lote/partida editables ---
    let totalSubtotal = 0, totalIGV = 0, totalTotal = 0
    let tableHtml = `
      <table style="width:100%;">
        <thead>
          <tr>
            <th>Producto</th>
            <th>Categoría</th>
            <th>Marca</th>
            <th style="text-align:right;">Cantidad</th>
            <th>U.M.</th>
            <th style="text-align:right;">Precio Unit.</th>
            <th style="text-align:right;">Total</th>
            <th>N° Lote *</th>
            <th>N° Partida</th>
          </tr>
        </thead>
        <tbody>`

    detalles.forEach((d, idx) => {
      const item = itemsMap[d.item_id]
      const nombre = item ? (item.nombre || item.name) : `#${d.item_id}`
      const sub = parseFloat(d.subtotal || 0)
      const igv = parseFloat(d.igv_monto || 0)
      const tot = parseFloat(d.total || 0)
      totalSubtotal += sub; totalIGV += igv; totalTotal += tot

      const partidasItem = (partidas || []).filter(p => p.product_id === d.item_id)
      const partidaOptions = '<option value="">-- Ninguna --</option>' +
        partidasItem.map(p => `<option value="${p.id}">${p.numero_partida}</option>`).join('')

      tableHtml += `<tr>
        <td>${nombre}</td>
        <td>${catMap[item?.categoria_id] || '-'}</td>
        <td>${marMap[item?.marca_id] || '-'}</td>
        <td style="text-align:right;">${(parseFloat(d.cantidad) || 0).toLocaleString('en-US', { maximumFractionDigits: 2 })}</td>
        <td>${d.unidad_medida || 'KG'}</td>
        <td style="text-align:right;">${(parseFloat(d.precio_unitario) || 0).toLocaleString('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 4 })}</td>
        <td style="text-align:right;"><strong>${tot.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</strong></td>
        <td><input type="text" id="cc-lote-${idx}" placeholder="Ej: L-${oc.numero || oc.id}-${idx+1}" style="min-width:130px;" required></td>
        <td><select id="cc-partida-${idx}" style="min-width:120px;">${partidaOptions}</select></td>
      </tr>`
    })
    tableHtml += '</tbody></table>'
    document.getElementById('cc-detalle-productos').innerHTML = tableHtml

    // --- Totales ---
    document.getElementById('cc-subtotal').textContent = totalSubtotal.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    document.getElementById('cc-igv').textContent = totalIGV.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    document.getElementById('cc-total').textContent = totalTotal.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

    openModal('modal-confirmar-compra')
  } catch (error) {
    console.error('Error en confirmarOC:', error)
    showToast(error.message || 'Error al abrir confirmación de OC', 'danger')
  }
}

/**
 * Crea la Cuenta por Pagar de una compra recién registrada — SOLO si es
 * comprobante '01' (factura nacional) o '91' (Comprobante de Pago No
 * Domiciliado — invoice de proveedor extranjero, usado en compras de
 * importación registradas directamente en este módulo, no en costeo-
 * importaciones.js). Boleta ('03') queda fuera a propósito: no da derecho a
 * crédito fiscal de IGV (Art. 19° Ley IGV / Reglamento de Comprobantes de
 * Pago), así que Compras no la acepta como comprobante de compra.
 * Espejo exacto de lo que ventas.js hace con cuentas_cobrar al facturar. Se
 * llama justo después de addCompra() en los 4 flujos que registran una
 * compra. Las Guías (de Remisión) NUNCA llaman esto — solo mueven stock, no
 * generan ni tocan CxP.
 * No lanza si falla: la compra ya quedó registrada, no tiene sentido
 * abortar todo el flujo por un problema en la CxP (se avisa y sigue).
 *
 * @param {object} crono  cronograma leído de leerCronograma() (opcional). Si
 *   viene con cuotas, la fecha de vencimiento de la CxP es la de la ÚLTIMA
 *   cuota y se generan las filas en cuotas_pagar. Los flujos que aún no
 *   tienen editor de cronograma (servicio, importación masiva) simplemente
 *   no lo pasan y quedan igual que antes (fecha_vencimiento null).
 */
async function _crearCuentaPagarSiFactura(compra, userId, crono = null) {
  if (!compra?.id || (compra.tipo_comprobante !== '01' && compra.tipo_comprobante !== '91')) return
  try {
    const fechaVenc = crono?.cuotas?.length
      ? crono.cuotas[crono.cuotas.length - 1].fecha_vencimiento
      : null
    const cxp = await addCuentaPagar({
      contact_id:         compra.contact_id,
      compra_id:          compra.id,
      tipo_comprobante:   compra.tipo_comprobante,
      serie:              compra.serie || null,
      numero_comprobante: compra.numero,
      fecha_emision:      compra.fecha_emision,
      fecha_vencimiento:  fechaVenc,
      moneda:             compra.currency || 'PEN',
      tipo_cambio:        parseFloat(compra.tipo_cambio) || 1,
      monto_total:        parseFloat(compra.total) || 0,
      monto_pagado:       0,
      estado:             'pendiente',
      termino_pago_id:         crono?.terminoId ?? null,
      cronograma_personalizado: !!crono?.personalizado,
      created_by:         userId
    })

    // Cuotas: el cronograma real. Si falla alguna, la compra NO se revierte
    // — el comprobante ya está registrado; las cuotas se pueden regenerar
    // después desde Cuentas x Pagar.
    if (crono?.cuotas?.length && cxp?.id) await _guardarCuotasDeCxP(cxp.id, crono)

    return cxp
  } catch (e) {
    console.warn('Compra registrada pero la Cuenta por Pagar falló:', e.message)
    showToast('Compra registrada ⚠️ no se pudo crear la Cuenta por Pagar: ' + e.message, 'warning')
  }
}

/** Guarda el cronograma como cuotas de la CxP recién creada (espejo de ventas.js). */
async function _guardarCuotasDeCxP(cxpId, crono) {
  if (!cxpId || !crono?.cuotas?.length) return
  for (const c of crono.cuotas) {
    try {
      await addCuotaPagar({
        cxp_id: cxpId,
        numero_cuota: c.numero_cuota,
        fecha_vencimiento: c.fecha_vencimiento,
        monto: parseFloat(c.monto.toFixed(2)),
        monto_pagado: 0,
        estado: 'pendiente',
        hito: c.hito || null
      })
    } catch (e) {
      console.warn(`Cuota ${c.numero_cuota} no se pudo crear:`, e.message)
      showToast(`⚠️ La cuota ${c.numero_cuota} no se guardó: ${e.message}`, 'warning')
    }
  }
}

/**
 * Lee el formulario del modal-confirmar-compra, valida el N° de Lote de
 * cada producto (obligatorio), registra la compra + su detalle, crea/actualiza
 * los lotes (sumando stock directo a Inventario) y marca la OC como confirmada.
 * El módulo de Contabilidad está en standby: no se genera asiento contable.
 */
window.ejecutarConfirmarCompra = async function () {
  try {
    const user = await getCurrentUser()
    if (!user) { showToast('Usuario no autenticado', 'danger'); return }
    if (!_ocContextConfirmar) { showToast('No hay OC cargada', 'warning'); return }

    const { oc, prov, detalles, itemsMap } = _ocContextConfirmar

    const tipoDocumento  = document.getElementById('ccTipoDocumento')?.value?.trim()
    const tipoCambioVal  = document.getElementById('ccTipoCambio')?.value
    const fecha          = document.getElementById('ccFecha')?.value
    const nroComprobante = document.getElementById('ccNumeroComprobante')?.value?.trim() || null
    const descripcion    = document.getElementById('ccDescripcion')?.value?.trim() ||
                           `Compra ${oc.numero || ''} - ${prov?.nombre || ''}`

    if (!tipoDocumento) { showToast('Selecciona el tipo de documento', 'warning'); return }
    if (!fecha)          { showToast('Ingresa la fecha', 'warning'); return }

    // Validar N° de Lote por cada línea ANTES de escribir nada en la BD
    const lineasLote = detalles.map((d, idx) => ({
      detalle: d,
      numeroLote: document.getElementById(`cc-lote-${idx}`)?.value?.trim() || '',
      partidaId: parseInt(document.getElementById(`cc-partida-${idx}`)?.value || 0) || null
    }))
    const faltantes = lineasLote.filter(l => !l.numeroLote)
    if (faltantes.length > 0) {
      showToast(`Falta el N° de Lote en ${faltantes.length} producto(s). Es obligatorio para ingresar el stock.`, 'warning')
      return
    }

    const moneda     = oc.currency || 'PEN'
    const tipoCambio = tipoCambioVal ? parseFloat(tipoCambioVal) : 1

    const cantidadTotal = detalles.reduce((s, d) => s + (parseFloat(d.cantidad) || 0), 0) || 1
    const subtotalC = parseFloat(oc.total_subtotal || 0)
    const igvC      = parseFloat(oc.total_igv || 0)
    const totalC    = parseFloat(oc.total_OC || 0)
    const referencia = nroComprobante || oc.numero || `OC-${oc.id}`
    const [serieC, numeroC] = (nroComprobante && nroComprobante.includes('-'))
      ? nroComprobante.split(/-(.+)/)
      : [null, referencia]

    // 1. Registrar la compra (sin asiento_id: Contabilidad en standby)
    const compra = await addCompra({
      referencia,
      tipo_referencia:        'orden_compra',
      tipo_comprobante:       tipoDocumento,
      serie:                  serieC,
      numero:                 numeroC,
      periodo_mes:            parseInt(fecha.slice(5, 7)),
      periodo_ano:            parseInt(fecha.slice(0, 4)),
      fecha_emision:          fecha,
      fecha_recepcion:        fecha,
      contact_id:             oc.contact_id,
      proveedor_ruc:          prov?.nro_documento || '-',
      proveedor_nombre:       prov?.nombre || '-',
      tipo_compra:            'mercaderia',
      descripcion,
      cantidad:               cantidadTotal,
      precio_unitario:        parseFloat((subtotalC / cantidadTotal).toFixed(4)) || 0,
      base_imponible_gravada: subtotalC,
      igv_gravado:            igvC,
      subtotal:               subtotalC,
      total:                  totalC,
      currency:               moneda,
      tipo_cambio:            tipoCambio,
      estado_pago:            'pendiente',
      asiento_id:             null,
      created_by:             user.db_id
    })

    if (!compra?.id) {
      showToast('No se pudo registrar la compra (¿referencia duplicada?)', 'danger')
      return
    }
    await _crearCuentaPagarSiFactura(compra, user.db_id)

    // 2. Detalle de la compra + 3. Lote por producto (suma stock a Inventario)
    for (const { detalle: d, numeroLote, partidaId } of lineasLote) {
      const item = itemsMap?.[d.item_id]

      await addCompraDetalle({
        compra_id:       compra.id,
        item_id:         d.item_id || null,
        descripcion:     item?.nombre || item?.name || d.descripcion || `Item #${d.item_id}`,
        unidad_medida:   d.unidad_medida || 'KG',
        cantidad:        parseFloat(d.cantidad) || 1,
        precio_unitario: parseFloat(d.precio_unitario) || 0,
        subtotal:        parseFloat(d.subtotal) || 0,
        tipo_base:       'gravada',
        igv_porcentaje:  18,
        igv_monto:       parseFloat(d.igv_monto) || 0,
        total_linea:     parseFloat(d.total) || 0
      })

      // Columnas reales de lotes: item_id, cantidad (no product_id/stock).
      // cantidad_unidades (N° de bultos/cajas) no se pide en este flujo
      // (OC en standby). lotes.cantidad_unidades es NOT NULL DEFAULT 0: va 0,
      // no null (null pisaría el DEFAULT y Postgres rechazaría el insert).
      // costo_unitario SIEMPRE va en soles (costo_unit_original x tipo_cambio);
      // si la compra fue en USD, precio_unitario venía en USD y aquí se convierte.
      const costoOriginal = parseFloat(d.precio_unitario) || 0
      const costoPen = parseFloat((costoOriginal * tipoCambio).toFixed(4))
      await addLote({
        item_id:         d.item_id || null,
        proveedor_id:    oc.contact_id,
        numero_lote:     numeroLote,
        numero_factura:  nroComprobante || null,
        partida_id:      partidaId,
        unidad_medida:   d.unidad_medida || 'KG',
        costo_unitario:  costoPen,
        moneda,
        tipo_cambio:         tipoCambio,
        costo_unit_original: costoOriginal,
        costo_estado:    'definitivo',
        cantidad:        parseFloat(d.cantidad) || 0,
        cantidad_unidades: 0,
        fecha_ingreso:   fecha,
        compra_id:       compra.id,
        created_by:      user.db_id
      })
    }

    // Marcar OC como confirmada
    await updateOrderCompra(oc.id, { status: 'confirmado' })

    _ocContextConfirmar = null
    closeModal('modal-confirmar-compra')
    showToast('Compra confirmada: stock actualizado en Inventario', 'success')
    await renderOrdenes()
    await renderCompras(true)
  } catch (error) {
    console.error('Error en ejecutarConfirmarCompra:', error)
    showToast(error.message || 'Error al confirmar la compra', 'danger')
  }
}

window.guardarOC = async function () {
  try {
    const user = await getCurrentUser()
    if (!user) {
      showToast('Usuario no autenticado', 'danger')
      return
    }

    const supplierId = parseInt(document.getElementById('ocProveedor')?.value || 0)
    const fecha = document.getElementById('ocFecha')?.value || new Date().toISOString().split('T')[0]
    const moneda = document.getElementById('ocMoneda')?.value || 'PEN'
    const tipoPago = document.getElementById('ocTipoPago')?.value || 'credito'

    if (!supplierId) {
      showToast('Selecciona un proveedor', 'warning')
      return
    }

    if (!detallesOCEnCreacion || detallesOCEnCreacion.length === 0) {
      showToast('Agrega al menos un producto', 'warning')
      return
    }

    // Calcular totales
    let totalSubtotal = 0
    let totalIGV = 0
    let totalMonto = 0

    detallesOCEnCreacion.forEach(detalle => {
      totalSubtotal += detalle.subtotal
      totalIGV += detalle.igv_monto
      totalMonto += detalle.total
    })

    // 1. Crear OC principal (sin detalles de productos)
    const idPrevio = await getOrderCompras().then(ocs => ocs.length > 0 ? Math.max(...ocs.map(o => o.id)) + 1 : 1)

    const ocPrincipal = {
      numero: `OC-${idPrevio}`,
      contact_id: supplierId,
      fecha: fecha,
      currency: moneda,
      tipo_pago: tipoPago,
      status: 'borrador',
      cantidad_total: detallesOCEnCreacion.reduce((sum, d) => sum + d.cantidad, 0),
      total_subtotal: totalSubtotal,
      total_igv: totalIGV,
      total_OC: totalMonto
    }

    const ocGuardada = await addOrderCompra(ocPrincipal)
    if (!ocGuardada || !ocGuardada.id) {
      showToast('Error al crear la orden de compra', 'danger')
      return
    }

    // 2. Guardar cada detalle asociado a la OC
    for (const detalle of detallesOCEnCreacion) {
      const detalleOC = {
        orden_compra_id: ocGuardada.id,
        item_id: detalle.item_id,
        cantidad: detalle.cantidad,
        precio_unitario: detalle.precio_unitario,
        unidad_medida: detalle.unidad_medida,
        igv_porcentaje: detalle.igv_porcentaje,
        subtotal: detalle.subtotal,
        igv_monto: detalle.igv_monto,
        total: detalle.total
      }

      const resultadoDetalle = await addOrderCompraDetalle(detalleOC)
      if (!resultadoDetalle) {
        showToast('Error al guardar un detalle de la orden', 'warning')
        // Continuamos con los demás detalles
      }
    }

    showToast('Orden de Compra creada exitosamente', 'success')
    //window.closeModal('modal-nueva-oc')
    detallesOCEnCreacion = []
    await renderOrdenes()
    const form = document.getElementById('formNewOC')
    if (form) form.reset()
    document.getElementById('tabla-detalle-nueva-oc').innerHTML = '<p style="text-align: center; color: var(--text-secondary); padding: 20px;">Sin productos agregados</p>'
  } catch (error) {
    console.error('Error en guardarOC:', error)
    showToast('Error al crear la orden de compra', 'danger')
  }
}

// ============================================================================
// COMPRAS - Obteniendo desde Journal Entries (Asientos Contables) filtrando tipo_movimiento 'Compra' para mostrar en la pestaña de Compras
// ============================================================================

// Paginación client-side (igual que Proveedores): se trae la lista completa
// una sola vez, se cachea, y la búsqueda + el paginador re-filtran/recortan
// en memoria sin volver a golpear la BD. Tamaño de página configurable en
// Compras > Configuración.
const COMPRAS_POR_PAGINA = getModuloConfig('compras').itemsPorPagina || 50
let _compPagina = 1
let _compLista = null
let _compSort = { col: null, dir: 'asc' } // orden por columna, tab Compras

registrarColumnas('compras', [
  { key: 'sel',          label: 'Seleccionar' },
  { key: 'id',           label: 'Id' },
  { key: 'proveedor',    label: 'Proveedor' },
  { key: 'fecha',        label: 'Fecha Emisión' },
  { key: 'comprobante',  label: 'Comprobante' },
  { key: 'referencia',   label: 'Referencia' },
  { key: 'descripcion',  label: 'Descripción' },
  { key: 'periodo',      label: 'Periodo' },
  { key: 'tipo',         label: 'Tipo Documento' },
  { key: 'total',        label: 'Total' },
  { key: 'estado_pago',  label: 'Estado Pago' },
  { key: 'stock',        label: 'Stock' },
  { key: 'acciones',     label: 'Acciones' }
])

registrarColumnas('guias-ingreso', [
  { key: 'sel',          label: 'Seleccionar' },
  { key: 'numero_guia',  label: 'N° Guía' },
  { key: 'fecha',        label: 'Fecha' },
  { key: 'referencia',   label: 'Compra (Referencia)' },
  { key: 'proveedor',    label: 'Proveedor' },
  { key: 'num_productos', label: '# Productos' },
  { key: 'productos',    label: 'Producto(s) / Lote(s)' },
  { key: 'marcas',       label: 'Marca(s)' },
  { key: 'zonas',        label: 'Almacén / Zona(s)' },
  { key: 'observaciones', label: 'Observaciones' },
  { key: 'estado',       label: 'Estado' },
  { key: 'acciones',     label: 'Acciones' }
])

// ─── Orden por columna (tabs Compras y Guías) ────────────────────────────────
// Comparador genérico: números se comparan numéricamente, todo lo demás como
// texto (localeCompare 'es' con soporte numérico para que "2" < "10").
function _compararValoresOrden(a, b) {
  if (a == null && b == null) return 0
  if (a == null) return -1
  if (b == null) return 1
  if (typeof a === 'number' && typeof b === 'number') return a - b
  return String(a).localeCompare(String(b), 'es', { numeric: true, sensitivity: 'base' })
}

// Flechita ▲/▼ junto al nombre de columna cuando esa columna es la que
// ordena la tabla actualmente; vacío en el resto.
function _flechaOrden(sortState, campo) {
  if (sortState.col !== campo) return ''
  return sortState.dir === 'asc' ? ' ▲' : ' ▼'
}

// `tabla`/`colKey` son opcionales: si se pasan, el <th> queda enganchado al
// menú "⋮" de columnas de esa tabla (ver col-menu.js) — colKey por defecto
// es el mismo `campo` de orden, se puede pisar cuando difieren (ej. columna
// de orden 'fecha_emision' pero clave de columna 'fecha').
function _thOrdenable(label, campo, sortState, funcOrdenar, tabla, colKey) {
  const oculta = tabla ? colStyle(tabla, colKey || campo) !== '' : false
  const attrsCol = tabla ? ` data-col-tabla="${tabla}" data-col="${colKey || campo}"` : ''
  const style = `cursor:pointer; user-select:none;${oculta ? ' display:none;' : ''}`
  return `<th${attrsCol} style="${style}" onclick="window.${funcOrdenar}('${campo}')" title="Ordenar por ${label}">${label}${_flechaOrden(sortState, campo)}</th>`
}

function _valorOrdenCompra(c, campo) {
  switch (campo) {
    case 'id':             return c.id
    case 'proveedor':      return c.proveedor_nombre || ''
    case 'fecha_emision':  return c.fecha_emision || ''
    case 'comprobante':    return c.serie ? `${c.serie}-${c.numero}` : (c.numero || '')
    case 'referencia':     return c.referencia || ''
    case 'descripcion':    return c.descripcion || ''
    case 'periodo':        return `${c.periodo_ano}-${String(c.periodo_mes).padStart(2, '0')}`
    case 'tipo_comprobante': return c.tipo_comprobante || ''
    case 'total':           return parseFloat(c.total) || 0
    case 'estado_pago':     return c.estado_pago || ''
    default: return ''
  }
}

window.ordenarCompras = async function (campo) {
  if (_compSort.col === campo) {
    _compSort.dir = _compSort.dir === 'asc' ? 'desc' : 'asc'
  } else {
    _compSort.col = campo
    _compSort.dir = 'asc'
  }
  await renderCompras()
}

async function renderCompras(forzar = false) {
  try {
    const container = document.getElementById('tabla-compras')
    if (!container) return

    const [, comprasConGuia, anticiposAplicadosTodos] = await Promise.all([
      getTipoDocumentosMap(),         // cacheado; garantiza nombres de tipo doc en carga lazy
      _cargarComprasConGuia(),
      getTodosComprasAnticiposAplicados()
    ])
    // Suma aplicada por cada compra tipo_compra='anticipo' — para el badge
    // "Aplicado X de Y" en la columna Stock.
    const aplicadoPorAnticipoCompra = new Map()
    for (const a of (anticiposAplicadosTodos || [])) {
      aplicadoPorAnticipoCompra.set(a.compra_anticipo_id, (aplicadoPorAnticipoCompra.get(a.compra_anticipo_id) || 0) + (parseFloat(a.monto_aplicado) || 0))
    }

    if (!_compLista || forzar) {
      _compLista = await getCompras()
      _compPagina = 1
    }

    // Búsqueda en vivo (contiene, sobre la lista ya cacheada — sin red)
    const busqueda = (document.getElementById('buscarCompra')?.value || '').trim().toLowerCase()
    const modoAnul = document.getElementById('filtroAnuladasCompras')?.value || 'activos'

    const porEstado = _compLista.filter(c => {
      const anul = estaAnulado(c)
      if (modoAnul === 'activos')  return !anul
      if (modoAnul === 'anulados') return anul
      return true
    })

    const listaFiltrada = busqueda
      ? porEstado.filter(c => {
          const comprobante = c.serie ? `${c.serie}-${c.numero}` : (c.numero || '')
          return `${c.proveedor_nombre || ''} ${c.referencia || ''} ${comprobante} ${c.descripcion || ''}`
            .toLowerCase().includes(busqueda)
        })
      : porEstado

    if (!listaFiltrada || listaFiltrada.length === 0) {
      container.innerHTML = `<p style="text-align: center; color: var(--text-secondary); padding: 20px;">${busqueda ? 'Sin resultados para la búsqueda' : 'Sin compras registradas'}</p>`
      return
    }

    if (_compSort.col) {
      listaFiltrada.sort((a, b) => {
        const cmp = _compararValoresOrden(_valorOrdenCompra(a, _compSort.col), _valorOrdenCompra(b, _compSort.col))
        return _compSort.dir === 'asc' ? cmp : -cmp
      })
    }

    const total = listaFiltrada.length
    const totalPaginas = Math.max(1, Math.ceil(total / COMPRAS_POR_PAGINA))
    if (_compPagina > totalPaginas) _compPagina = totalPaginas
    if (_compPagina < 1) _compPagina = 1
    const inicio = (_compPagina - 1) * COMPRAS_POR_PAGINA
    const compras = listaFiltrada.slice(inicio, inicio + COMPRAS_POR_PAGINA)

    const paginador = `
      <div style="display:flex; justify-content:space-between; align-items:center; padding:12px 16px;">
        <span style="color:var(--text-secondary); font-size:0.85rem;">
          Mostrando ${inicio + 1}–${inicio + compras.length} de ${total} compras
        </span>
        <div style="display:flex; gap:8px; align-items:center;">
          <button class="btn btn-small btn-secondary" onclick="window.cambiarPaginaCompras(-1)" ${_compPagina <= 1 ? 'disabled' : ''}>← Anterior</button>
          <span style="font-size:0.85rem;">Página ${_compPagina} de ${totalPaginas}</span>
          <button class="btn btn-small btn-secondary" onclick="window.cambiarPaginaCompras(1)" ${_compPagina >= totalPaginas ? 'disabled' : ''}>Siguiente →</button>
        </div>
      </div>
    `

    let html = paginador + `
      <table>
        <thead>
          <tr>
            <th data-col-tabla="compras" data-col="sel" style="width:32px;${colStyle('compras','sel') ? 'display:none;' : ''}"><input type="checkbox" id="selAllCompras" onchange="window.toggleSeleccionTodasCompras(this.checked)" title="Seleccionar todas"></th>
            ${_thOrdenable('Id', 'id', _compSort, 'ordenarCompras', 'compras')}
            ${_thOrdenable('Proveedor', 'proveedor', _compSort, 'ordenarCompras', 'compras')}
            ${_thOrdenable('Fecha Emisión', 'fecha_emision', _compSort, 'ordenarCompras', 'compras', 'fecha')}
            ${_thOrdenable('Comprobante', 'comprobante', _compSort, 'ordenarCompras', 'compras')}
            ${_thOrdenable('Referencia', 'referencia', _compSort, 'ordenarCompras', 'compras')}
            ${_thOrdenable('Descripcion', 'descripcion', _compSort, 'ordenarCompras', 'compras')}
            ${_thOrdenable('Periodo', 'periodo', _compSort, 'ordenarCompras', 'compras')}
            ${_thOrdenable('Tipo Documento', 'tipo_comprobante', _compSort, 'ordenarCompras', 'compras', 'tipo')}
            ${_thOrdenable('Total', 'total', _compSort, 'ordenarCompras', 'compras')}
            ${_thOrdenable('Estado Pago', 'estado_pago', _compSort, 'ordenarCompras', 'compras')}
            <th data-col-tabla="compras" data-col="stock"${colStyle('compras','stock')}>Stock</th>
            <th data-col-tabla="compras" data-col="acciones"${colStyle('compras','acciones')}>Acciones</th>
          </tr>
        </thead>
        <tbody>
    `

    compras.forEach(c => {
      const referencia = String(c.referencia || '').trim()
      const comprobante = c.serie ? `${c.serie}-${c.numero}` : (c.numero || '-')
      const periodo = `${c.periodo_ano}-${String(c.periodo_mes).padStart(2, '0')}`
      const badgePago = c.estado_pago === 'pagado' ? 'success' : (c.estado_pago === 'parcial' ? 'warning' : 'pending')
      const tieneGuia = c.tipo_compra !== 'mercaderia' || comprasConGuia.has(c.id)
      const badgeStock = c.tipo_compra === 'anticipo'
        ? (() => {
            const aplicado = aplicadoPorAnticipoCompra.get(c.id) || 0
            const total = parseFloat(c.total || 0)
            const saldo = parseFloat((total - aplicado).toFixed(2))
            return saldo <= 0.01
              ? '<span class="badge badge-success">💰 Aplicado íntegramente</span>'
              : `<span class="badge badge-warning" title="Aplicado ${aplicado.toFixed(2)} de ${total.toFixed(2)}">💰 Anticipo — saldo ${saldo.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>`
          })()
        : c.tipo_compra !== 'mercaderia'
        ? '<span class="badge badge-secondary">N/A (servicio)</span>'
        : (tieneGuia
            ? '<span class="badge badge-success">✓ Con Guía</span>'
            : '<span class="badge badge-warning">⏳ Pendiente Guía</span>')

      const anulada = estaAnulado(c)

      html += `
        <tr${anulada ? ` style="${ESTILO_FILA_ANULADA}"` : ''}>
          <td data-col-tabla="compras" data-col="sel"${colStyle('compras','sel')}>${anulada
            ? `<input type="checkbox" disabled title="Comprobante anulado">`
            : `<input type="checkbox" class="compra-sel" value="${c.id}" onchange="window.actualizarBotonEliminarComprasSeleccionadas()">`}</td>
          <td data-col-tabla="compras" data-col="id"${colStyle('compras','id')}><strong>${c.id}</strong></td>
          <td data-col-tabla="compras" data-col="proveedor"${colStyle('compras','proveedor')}>${c.proveedor_nombre || '-'}</td>
          <td data-col-tabla="compras" data-col="fecha"${colStyle('compras','fecha')}>${c.fecha_emision || '-'}</td>
          <td data-col-tabla="compras" data-col="comprobante"${colStyle('compras','comprobante')}>${comprobante}</td>
          <td data-col-tabla="compras" data-col="referencia"${colStyle('compras','referencia')}>${referencia || '-'}</td>
          <td data-col-tabla="compras" data-col="descripcion"${colStyle('compras','descripcion')}>${c.descripcion || '-'}</td>
          <td data-col-tabla="compras" data-col="periodo"${colStyle('compras','periodo')}>${periodo}</td>
          <td data-col-tabla="compras" data-col="tipo"${colStyle('compras','tipo')}>${esNota(c.tipo_comprobante)
                ? `${badgeTipoDocumento(c.tipo_comprobante)}${c.compra_referencia_id ? `<br><small style="color:var(--text-secondary);">ref. ${c.doc_referencia_serie || ''}-${c.doc_referencia_numero || ''}</small>` : ''}`
                : (c.tipo_comprobante ? `${c.tipo_comprobante} - ${getNombreTipoDocumentoSync(c.tipo_comprobante)}` : '-')}</td>
          <td data-col-tabla="compras" data-col="total"${colStyle('compras','total')}><strong style="${signoDocumento(c.tipo_comprobante) < 0 ? 'color:var(--color-danger);' : ''}">${formatNumber((parseFloat(c.total) || 0) * signoDocumento(c.tipo_comprobante))} ${c.currency || 'PEN'}</strong></td>
          <td data-col-tabla="compras" data-col="estado_pago"${colStyle('compras','estado_pago')}>${anulada ? badgeAnulado(c) : `<span class="badge badge-${badgePago}">${c.estado_pago || 'pendiente'}</span>`}</td>
          <td data-col-tabla="compras" data-col="stock"${colStyle('compras','stock')}>${anulada ? '<span class="badge badge-secondary">—</span>' : badgeStock}${c.adjunto_url ? ' <span title="Tiene documento adjunto">📎</span>' : ''}</td>
          <td data-col-tabla="compras" data-col="acciones" class="col-acciones" style="text-decoration:none; opacity:1;${colStyle('compras','acciones') ? ' display:none;' : ''}">
            ${menuAccionesFila(anulada
              ? [{ label: 'Ver motivo de anulación', icono: 'ℹ️', onclick: `window.verMotivoAnulacionCompra('compra', ${c.id})` }]
              : [
                  { label: 'Editar', icono: '✏️', onclick: `window.editarCompra(${c.id})` },
                  { label: c.adjunto_url ? 'Ver/Reemplazar documento' : 'Adjuntar documento', icono: '📎', onclick: `window.abrirModalAdjuntoCompra(${c.id})` },
                  { separador: true },
                  { label: 'Nota de Crédito', icono: '↩️', onclick: `window.abrirModalNotaCreditoCompra(${c.id})` },
                  { label: 'Nota de Débito', icono: '↪️', onclick: `window.abrirModalNotaDebitoCompra(${c.id})` },
                  { separador: true },
                  { label: 'Anular comprobante', icono: '🚫', onclick: `window.anularCompra(${c.id})`, peligro: true },
                  { label: 'Eliminar', icono: '🗑️', onclick: `window.eliminarCompra(${c.id})`, peligro: true }
                ])}
          </td>
        </tr>
      `
    })

    html += '</tbody></table>' + paginador
    container.innerHTML = html
    // El tbody se reconstruye entero en cada render: la selección anterior
    // ya no existe (checkboxes nuevos, todos sin marcar), así que el botón
    // de acción masiva debe volver a su estado oculto.
    window.actualizarBotonEliminarComprasSeleccionadas()
  } catch (error) {
    console.error('Error en renderCompras:', error)
    showToast('Error al cargar las compras', 'danger')
  }
}

window.cambiarPaginaCompras = async function (delta) {
  _compPagina += delta
  if (_compPagina < 1) _compPagina = 1
  await renderCompras()  // usa caché, solo cambia de página
}

window.filtrarCompras = async function () {
  _compPagina = 1  // cada nueva búsqueda vuelve a la página 1
  await renderCompras()  // usa caché, solo re-filtra (sin red)
}

// ─── Editar Compra (cabecera + precio/IGV de línea si aún no hay guía procesada) ──
//
// Diferencia clave con "Editar Venta" en ventas.js: allá el precio se podía
// dejar editable sin drama porque la VENTA nunca mueve stock (solo la Guía
// de Despacho). Acá es al revés: es la GUÍA DE INGRESO la que crea el lote y
// graba su costo_unitario, que además ya puede haber alimentado el Kardex y
// mezclado costo con stock preexistente del mismo N° de lote (costeo
// promedio ponderado). Por eso el candado de precio es "¿ya tiene guía
// procesada?" en vez de "¿ya hay cobros/CPE aceptado?" — una vez que la
// guía corrió, el precio de la compra queda bloqueado: corregirlo ahí no
// movería el costo ya grabado en lotes/kardex.

let _ecContexto = null   // { compra, detalles, cxp, guiasCompra, notas, bloqueos }

window.editarCompra = async function (id) {
  try {
    const { getById } = await import('./supabase-client.js')
    const [c, detalles, cxps, guiasTodas, todasCompras] = await Promise.all([
      getById('compras', id),
      getCompraDetalles(id),
      getCuentasPagarByCompra(id),
      getGuiasIngresoCompra(),
      getCompras()
    ])
    if (!c) { showToast('No se encontró la compra', 'danger'); return }

    const cxp = (cxps || [])[0] || null
    const guiasCompra = (guiasTodas || []).filter(g => g.compra_id === id)
    const notas = (todasCompras || []).filter(x => x.compra_referencia_id === id && !estaAnulado(x))
    const aplicado = parseFloat(cxp?.monto_pagado || 0)

    const bloqueos = {
      precios: guiasCompra.length > 0 || aplicado > 0.01 || notas.length > 0
    }
    _ecContexto = { compra: c, detalles: detalles || [], cxp, guiasCompra, notas, aplicado, bloqueos }

    document.getElementById('ecId').value = c.id
    document.getElementById('ecReferencia').value = c.referencia || ''
    document.getElementById('ecFechaEmision').value = c.fecha_emision || ''
    document.getElementById('ecFechaRecepcion').value = c.fecha_recepcion || ''
    document.getElementById('ecNumeroComprobante').value = c.numero || ''
    document.getElementById('ecEstadoPago').value = c.estado_pago || 'pendiente'
    document.getElementById('ecMoneda').value = c.currency || 'PEN'
    document.getElementById('ecTipoCambio').value = c.tipo_cambio || 1

    _pintarLineasEdicionCompra()

    window.openModal('modal-editar-compra')
  } catch (error) {
    console.error('Error en editarCompra:', error)
    showToast('Error al abrir la compra para editar', 'danger')
  }
}

/** Tabla de líneas del modal Editar Compra: precio_unitario y tipo de IGV editables si !bloqueos.precios. Mismo set de opciones que "Nueva Compra" (newDetalleCompraIGV: 18/18-inc/10/0). */
function _pintarLineasEdicionCompra() {
  const c = _ecContexto
  const cont = document.getElementById('ec-lineas')
  const aviso = document.getElementById('ec-precios-aviso')
  if (!cont || !c) return

  if (aviso) {
    if (c.bloqueos.precios) {
      const motivo = c.guiasCompra.length > 0
        ? 'ya tiene Guía de Ingreso procesada (el costo ya se grabó en el lote/kardex)'
        : (c.notas.length > 0 ? 'tiene notas de crédito/débito asociadas' : 'ya tiene pagos aplicados al proveedor')
      aviso.textContent = `Precio y tipo de IGV bloqueados: ${motivo}.` +
        (c.guiasCompra.length > 0 ? ' Moneda y Tipo de Cambio SÍ se pueden corregir: al guardar, el costo ya grabado en lote/Kardex se recalcula automáticamente con el TC nuevo (se bloquea solo si algún lote ya tuvo ventas).' : '')
      aviso.style.color = 'var(--color-warning)'
    } else {
      aviso.textContent = 'Puedes corregir el precio unitario y el tipo de IGV de cada línea — la cantidad no se toca aquí.'
      aviso.style.color = 'var(--text-secondary)'
    }
  }

  if (c.detalles.length === 0) {
    cont.innerHTML = `<tr><td colspan="8" style="text-align:center; color:var(--text-secondary); padding:14px;">Esta compra no tiene líneas registradas.</td></tr>`
    return
  }

  cont.innerHTML = c.detalles.map((d, idx) => `
    <tr>
      <td>${d.descripcion || ''}</td>
      <td style="text-align:right;">${(parseFloat(d.cantidad) || 0).toLocaleString('en-US', { maximumFractionDigits: 3 })}</td>
      <td>${d.unidad_medida || '-'}</td>
      <td style="text-align:right;">
        <input type="number" step="0.01" min="0.01" value="${parseFloat(d.precio_unitario || 0)}"
          id="ecLineaPrecio-${idx}" style="width:100px; text-align:right;" ${c.bloqueos.precios ? 'disabled' : ''}
          oninput="window.onCambiarLineaPrecioEdicionCompra(${idx})">
      </td>
      <td>
        <select id="ecLineaTipo-${idx}" ${c.bloqueos.precios ? 'disabled' : ''} onchange="window.onCambiarLineaPrecioEdicionCompra(${idx})">
          <option value="18"${(d.igv_porcentaje == 18) ? ' selected' : ''}>18%</option>
          <option value="18-inc" title="El Precio Unitario ya incluye el IGV: se extrae en vez de sumarse encima.">18% (incluido)</option>
          <option value="10"${(d.igv_porcentaje == 10) ? ' selected' : ''}>10%</option>
          <option value="0"${(!d.igv_porcentaje || d.igv_porcentaje == 0) ? ' selected' : ''}>Exonerada / Importación</option>
        </select>
      </td>
      <td style="text-align:right;" id="ecLineaSubtotal-${idx}">${parseFloat(d.subtotal || 0).toFixed(2)}</td>
      <td style="text-align:right;" id="ecLineaIgv-${idx}">${parseFloat(d.igv_monto || 0).toFixed(2)}</td>
      <td style="text-align:right; font-weight:600;" id="ecLineaTotal-${idx}">${parseFloat(d.total_linea || 0).toFixed(2)}</td>
    </tr>
  `).join('')

  _recalcularTotalesEdicionCompra()
}

window.onCambiarLineaPrecioEdicionCompra = function (idx) {
  const c = _ecContexto
  const d = c?.detalles?.[idx]
  if (!d) return

  const precio = Math.max(0, parseFloat(document.getElementById(`ecLineaPrecio-${idx}`)?.value || 0))
  const igvValor = document.getElementById(`ecLineaTipo-${idx}`)?.value || '18'
  const cantidad = parseFloat(d.cantidad) || 0

  const { subtotal, igvMonto, total, igvPct } = _calcularMontosDetalleCompra(cantidad, precio, 0, igvValor)

  d._precioNuevo = precio
  d._tipoBaseNuevo = igvPct > 0 ? 'gravada' : 'exonerada'
  d._igvPorcentajeNuevo = igvPct
  d._subtotalNuevo = parseFloat(subtotal.toFixed(2))
  d._igvMontoNuevo = parseFloat(igvMonto.toFixed(2))
  d._totalLineaNuevo = parseFloat(total.toFixed(2))

  _setEc(`ecLineaSubtotal-${idx}`, d._subtotalNuevo.toFixed(2))
  _setEc(`ecLineaIgv-${idx}`, d._igvMontoNuevo.toFixed(2))
  _setEc(`ecLineaTotal-${idx}`, d._totalLineaNuevo.toFixed(2))

  _recalcularTotalesEdicionCompra()
}

function _recalcularTotalesEdicionCompra() {
  const c = _ecContexto
  if (!c) return
  let subtotal = 0, igv = 0, total = 0
  for (const d of c.detalles) {
    subtotal += d._subtotalNuevo   ?? parseFloat(d.subtotal || 0)
    igv      += d._igvMontoNuevo   ?? parseFloat(d.igv_monto || 0)
    total    += d._totalLineaNuevo ?? parseFloat(d.total_linea || 0)
  }
  _setEc('ecSubtotal', subtotal.toFixed(2))
  _setEc('ecIgv', igv.toFixed(2))
  _setEc('ecTotal', total.toFixed(2))
}

function _setEc(id, txt) { const el = document.getElementById(id); if (el) el.textContent = txt }

// ── Recosteo de inventario al cambiar moneda/TC de una compra con guía ────
// Antes, editar moneda/tipo_cambio de la cabecera de una compra NO tocaba
// lotes.costo_unitario ni el Kardex ya grabado por su(s) Guía(s) de
// Ingreso: quedaban congelados con el TC viejo mientras la compra en
// pantalla mostraba el nuevo. Esto lo corrige revirtiendo el costo viejo y
// reaplicándolo con el TC nuevo — mismo patrón/candados que "Editar Guía de
// Ingreso" (_planRevertirGuiaIngreso ya bloquea si algún lote tuvo ventas).
// Cantidad/lote/zona NO se tocan aquí (siguen bloqueados junto con el
// precio mientras haya guía) — solo se recalcula el costo en soles.
/**
 * @param {number} compraId
 * @param {object} compraParaCosteo  la compra YA con moneda/tipo_cambio nuevos
 * @param {number} userId
 * @returns {{guiasRecosteadas:number, lineasRecosteadas:number}}
 */
async function _recostearGuiasPorCambioTC(compraId, compraParaCosteo, userId) {
  const guias = (await getGuiasIngresoCompra(true) || []).filter(g => g.compra_id === compraId)
  if (guias.length === 0) return { guiasRecosteadas: 0, lineasRecosteadas: 0 }

  // Todo-o-nada: se valida que NINGUNA guía esté bloqueada por ventas antes
  // de escribir nada. Si una sola lo está, no se toca ninguna — el usuario
  // tiene que resolver esa venta primero (mismo mensaje que al editar la
  // guía directamente).
  const planesPorGuia = new Map()
  for (const g of guias) {
    planesPorGuia.set(g.id, await _planRevertirGuiaIngreso(g.id))
  }

  const detallesCompra = await getCompraDetalles(compraId)
  const detalleCompraMap = new Map((detallesCompra || []).map(d => [d.id, d]))

  let lineasRecosteadas = 0
  for (const g of guias) {
    const plan = planesPorGuia.get(g.id)
    const detallesGuia = await getDetalleGuiasIngresoCompra(g.id)

    // Recepciones EXACTAMENTE como están hoy (mismo lote/marca/partida/zona/
    // cantidad/bultos) — solo cambia el TC con el que se recalcula el costo.
    const recepciones = []
    for (const dg of (detallesGuia || [])) {
      const dc = detalleCompraMap.get(dg.detalle_compra_id)
      if (!dc) continue // línea de compra borrada: no hay con qué recostear esta línea
      const lote = dg.lote_id ? await getLoteById(dg.lote_id) : null
      const esPesoVariable = !!lote?.es_peso_variable
      let bultos = null
      if (esPesoVariable && lote) {
        const bultosLote = await getLoteBultosByLote(lote.id)
        bultos = (bultosLote || [])
          .filter(b => b.guia_ingreso_id === g.id)
          .map(b => ({ peso: parseFloat(b.peso) || null }))
      }
      recepciones.push({
        detalle_compra_id: dg.detalle_compra_id, item_id: dg.item_id,
        nombreProducto: dc.descripcion || `Item #${dg.item_id}`,
        precio_unitario: parseFloat(dc.precio_unitario) || 0,
        unidadMedida: dc.unidad_medida || 'KG',
        cantidad: parseFloat(dg.cantidad) || 0,
        cantidadUnidades: lote?.cantidad_unidades || null,
        numeroLote: dg.numero_lote, marcaId: dg.marca_id,
        codigoPartida: dg.codigo_partida || null, ubicacionId: dg.ubicacion_id,
        esPesoVariable, bultos, loteExistenteId: null
      })
    }
    if (recepciones.length === 0) continue

    await _aplicarReversionGuiaIngreso(g.id, plan)
    const idsLotesABorrarCompleto = [...plan.lotesABorrar, ...plan.lotesConBultosCompletos.map(l => l.lote.id)]
    for (const loteId of idsLotesABorrarCompleto) await deleteLote(loteId)

    const detallesViejos = await getDetalleGuiasIngresoCompra(g.id)
    for (const dv of (detallesViejos || [])) await deleteDetalleGuiaIngresoCompra(dv.id)

    await _aplicarRecepcionesAGuiaIngreso(g, compraParaCosteo, compraId, recepciones, { db_id: userId }, g.fecha_guia, g.numero_guia)
    lineasRecosteadas += recepciones.length
  }

  return { guiasRecosteadas: guias.length, lineasRecosteadas }
}

window.guardarEdicionCompra = async function () {
  try {
    const c = _ecContexto
    const id = parseInt(document.getElementById('ecId')?.value || 0)
    if (!id || !c) { showToast('Compra inválida', 'danger'); return }

    const referencia = document.getElementById('ecReferencia')?.value?.trim()
    const fechaEmision = document.getElementById('ecFechaEmision')?.value
    const fechaRecepcion = document.getElementById('ecFechaRecepcion')?.value
    const numero = document.getElementById('ecNumeroComprobante')?.value?.trim()
    const estadoPago = document.getElementById('ecEstadoPago')?.value
    const moneda = document.getElementById('ecMoneda')?.value
    const tipoCambio = parseFloat(document.getElementById('ecTipoCambio')?.value || 1)

    if (!referencia || !fechaEmision || !fechaRecepcion || !numero) {
      showToast('Completa referencia, fechas y N° de comprobante', 'warning')
      return
    }

    // Precio/IGV de línea: si bloqueado, los totales quedan exactamente
    // como estaban (ninguna línea se toca).
    const detallesCambiados = []
    let nuevoSubtotal = 0, nuevoIgv = 0, nuevoTotal = 0, nuevoBaseGravada = 0
    if (c.bloqueos.precios) {
      nuevoSubtotal = parseFloat(c.compra.subtotal) || 0
      nuevoIgv      = parseFloat(c.compra.igv_gravado) || 0
      nuevoTotal    = parseFloat(c.compra.total) || 0
      nuevoBaseGravada = parseFloat(c.compra.base_imponible_gravada) || 0
    } else {
      for (const d of c.detalles) {
        const precioOriginal = parseFloat(d.precio_unitario || 0)
        const subtotal   = d._subtotalNuevo   ?? parseFloat(d.subtotal || 0)
        const igvMonto   = d._igvMontoNuevo   ?? parseFloat(d.igv_monto || 0)
        const totalLinea = d._totalLineaNuevo ?? parseFloat(d.total_linea || 0)
        const tipoBase   = d._tipoBaseNuevo ?? d.tipo_base
        nuevoSubtotal += subtotal; nuevoIgv += igvMonto; nuevoTotal += totalLinea
        if (tipoBase === 'gravada') nuevoBaseGravada += subtotal

        const precioCambio = d._precioNuevo != null && Math.abs(d._precioNuevo - precioOriginal) > 0.0001
        const tipoCambio_ = d._tipoBaseNuevo != null && (d._tipoBaseNuevo !== d.tipo_base || d._igvPorcentajeNuevo !== d.igv_porcentaje)
        if (precioCambio || tipoCambio_) {
          detallesCambiados.push({
            id: d.id,
            precio_unitario: d._precioNuevo ?? precioOriginal,
            tipo_base: tipoBase,
            igv_porcentaje: d._igvPorcentajeNuevo ?? d.igv_porcentaje,
            subtotal, igv_monto: igvMonto, total_linea: totalLinea
          })
        }
      }
      if (detallesCambiados.length > 0 && nuevoTotal <= 0) {
        showToast('El total de la compra no puede quedar en 0 o negativo', 'warning')
        return
      }
    }

    // Detectar qué cambió, ANTES de escribir, para el resumen final y para
    // decidir si hace falta recostear inventario.
    const monedaOriginal = c.compra.currency || 'PEN'
    const tcOriginal = parseFloat(c.compra.tipo_cambio) || 1
    const monedaCambio = moneda !== monedaOriginal
    const tcCambio = Math.abs(tipoCambio - tcOriginal) > 0.0001
    const cambios = []
    if (referencia !== (c.compra.referencia || ''))         cambios.push('referencia')
    if (fechaEmision !== (c.compra.fecha_emision || ''))    cambios.push('fecha de emisión')
    if (fechaRecepcion !== (c.compra.fecha_recepcion || '')) cambios.push('fecha de recepción')
    if (numero !== (c.compra.numero || ''))                 cambios.push('N° de comprobante')
    if (estadoPago !== (c.compra.estado_pago || ''))        cambios.push('estado de pago')
    if (monedaCambio || tcCambio)                           cambios.push('moneda/tipo de cambio')
    if (detallesCambiados.length > 0)                       cambios.push(`${detallesCambiados.length} línea(s) de precio/IGV`)

    const actualizado = await updateCompra(id, {
      referencia,
      fecha_emision: fechaEmision,
      fecha_recepcion: fechaRecepcion,
      numero,
      estado_pago: estadoPago,
      currency: moneda,
      tipo_cambio: tipoCambio,
      subtotal: parseFloat(nuevoSubtotal.toFixed(2)),
      igv_gravado: parseFloat(nuevoIgv.toFixed(2)),
      total: parseFloat(nuevoTotal.toFixed(2)),
      base_imponible_gravada: parseFloat(nuevoBaseGravada.toFixed(2))
    })

    if (!actualizado) { showToast('No se pudo actualizar la compra', 'danger'); return }

    // Recosteo de inventario: si cambió moneda/TC y esta compra ya tiene
    // Guía(s) de Ingreso, el costo grabado en lote/Kardex debe recalcularse
    // con el TC nuevo — si no, queda desincronizado con la cabecera.
    let recosteo = null
    let recosteoError = null
    if ((monedaCambio || tcCambio) && c.guiasCompra.length > 0) {
      try {
        const user = await getCurrentUser()
        const compraParaCosteo = { ...c.compra, currency: moneda, tipo_cambio: tipoCambio }
        recosteo = await _recostearGuiasPorCambioTC(id, compraParaCosteo, user?.db_id || null)
      } catch (eRecosteo) {
        console.error('Error recosteando guías tras cambio de TC:', eRecosteo)
        recosteoError = eRecosteo.message
      }
    }

    if (detallesCambiados.length > 0) {
      for (const dc of detallesCambiados) {
        try {
          await updateCompraDetalle(dc.id, {
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

    // CxP: se sincroniza monto_total siempre con el total recién calculado
    // — si no hubo cambio de precio, es el mismo valor de antes.
    let cxpSincronizada = false
    if (c.cxp) {
      try {
        await updateCuentaPagar(c.cxp.id, {
          numero_comprobante: numero,
          fecha_emision: fechaEmision,
          moneda, tipo_cambio: tipoCambio,
          monto_total: parseFloat(nuevoTotal.toFixed(2))
        })
        cxpSincronizada = true
      } catch (e) {
        console.warn('CxP no actualizada:', e.message)
        showToast('Compra guardada ⚠️ la Cuenta por Pagar no se actualizó: ' + e.message, 'warning')
      }
    }

    // Mensaje final: conclusión de qué cambió y qué impactó, no un genérico
    // "Compra actualizada" — hay demasiadas cosas relacionadas (inventario,
    // CxP, contabilidad) como para no decir explícitamente qué se tocó.
    const partes = []
    partes.push(cambios.length > 0 ? `Se actualizó: ${cambios.join(', ')}.` : 'Compra guardada sin cambios de datos.')
    if (recosteoError) {
      partes.push(`⚠️ El TC cambió pero el recosteo de inventario FALLÓ (${recosteoError}) — los lotes/Kardex de esta compra siguen con el costo del TC anterior, corrígelo manualmente.`)
    } else if (recosteo && recosteo.guiasRecosteadas > 0) {
      partes.push(`Inventario recosteado con el TC nuevo: ${recosteo.guiasRecosteadas} guía(s), ${recosteo.lineasRecosteadas} línea(s) de lote/Kardex.`)
    }
    if (cxpSincronizada) partes.push('Cuenta por Pagar sincronizada.')
    if (c.compra.asiento_id) {
      partes.push('⚠️ Esta compra ya tiene asiento contable generado: los montos en Contabilidad NO se actualizaron automáticamente (pendiente hasta activar ese módulo).')
    }

    showToast(partes.join(' '), recosteoError ? 'warning' : 'success', recosteoError || c.compra.asiento_id ? 10000 : 5000)
    window.closeModal('modal-editar-compra')
    _ecContexto = null
    await renderCompras(true)
  } catch (error) {
    console.error('Error en guardarEdicionCompra:', error)
    showToast('Error al actualizar la compra', 'danger')
  }
}

// ─── Eliminar Compra ──────────────────────────────────────────────────────────
// Orden correcto para eliminar una compra sin romper el inventario/ventas:
//   1) El stock ahora se genera vía Guía de Remisión, no directo en la
//      compra. La verificación de "¿ya se vendió algo?" se hace por LOTE,
//      no por línea de compra:
//        - Lotes creados por una guía (lote.guia_id): se compara la
//          cantidad ACTUAL del lote contra la cantidad ORIGINAL recibida en
//          esa guía (detalle_guias_ingreso_compra.cantidad, inmutable). Si
//          actual < original, ese lote ya tuvo una venta.
//        - Lotes "legacy" sin guia_id (creados antes de este flujo, con
//          compra_id directo): se usa el criterio anterior, comparando
//          contra detalle_compras.cantidad agregado por producto.
//        - Si un lote de esta compra YA NO EXISTE (se borró manualmente,
//          por ejemplo tras revertir una venta y luego borrar el lote a
//          mano), no se puede ni se debe asumir que "se vendió": ya no hay
//          nada que verificar ni que tocar para ese lote.
//   2) Si hay stock ya vendido: BLOQUEAR el borrado y pedir que primero se
//      anule/ajuste la venta correspondiente.
//   3) Si no hay ventas asociadas: borrar los lotes y guías de esta compra,
//      luego la compra (detalle_compras se borra solo por ON DELETE CASCADE).
window.eliminarCompra = async function (id) {
  try {
    const [detalles, lotes, todasLasGuias] = await Promise.all([
      getCompraDetalles(id),
      getLotesByCompraId(id),   // solo lotes que SIGUEN existiendo, vinculados a esta compra
      getGuiasIngresoCompra()
    ])

    const guiasCompra = (todasLasGuias || []).filter(g => g.compra_id === id)

    let detallesGuia = []
    for (const g of guiasCompra) {
      const d = await getDetalleGuiasIngresoCompra(g.id)
      detallesGuia = detallesGuia.concat(d || [])
    }
    const detalleGuiaPorLoteId = {}
    for (const dg of detallesGuia) {
      if (dg.lote_id) detalleGuiaPorLoteId[dg.lote_id] = dg
    }

    // Fallback legacy (lotes sin guia_id): agregado por producto contra detalle_compras
    const originalPorItemLegacy = {}
    for (const d of (detalles || [])) {
      originalPorItemLegacy[d.item_id] = (originalPorItemLegacy[d.item_id] || 0) + (parseFloat(d.cantidad) || 0)
    }
    const actualPorItemLegacy = {}
    for (const l of (lotes || [])) {
      if (l.guia_id) continue
      actualPorItemLegacy[l.item_id] = (actualPorItemLegacy[l.item_id] || 0) + (parseFloat(l.cantidad) || 0)
    }

    const vendidos = []

    // Lotes creados por guía: comparación precisa lote a lote
    for (const l of (lotes || [])) {
      if (!l.guia_id) continue
      const dg = detalleGuiaPorLoteId[l.id]
      if (!dg) continue
      const original = parseFloat(dg.cantidad) || 0
      const actual = parseFloat(l.cantidad) || 0
      const vendido = parseFloat((original - actual).toFixed(4))
      if (vendido > 0) {
        const item = await getItemById(l.item_id)
        vendidos.push(`${item?.nombre || 'Item #' + l.item_id} (lote ${l.numero_lote}): ${vendido} vendido de ${original}`)
      }
    }

    // Lotes legacy: comparación agregada por producto
    for (const itemId of Object.keys(originalPorItemLegacy)) {
      if (!(itemId in actualPorItemLegacy)) continue // sin lotes legacy para este item, nada que comparar
      const original = originalPorItemLegacy[itemId]
      const actual = actualPorItemLegacy[itemId] || 0
      const vendido = parseFloat((original - actual).toFixed(4))
      if (vendido > 0) {
        const item = await getItemById(parseInt(itemId))
        vendidos.push(`${item?.nombre || 'Item #' + itemId}: ${vendido} vendido de ${original}`)
      }
    }

    if (vendidos.length > 0) {
      showToast(
        `No se puede eliminar: ya hay ventas de esta compra (${vendidos.join(' | ')}). ` +
        `Primero anula/ajusta esas ventas para devolver el stock, luego elimina la compra.`,
        'danger'
      )
      return
    }

    // ── Dependencias financieras ──────────────────────────────────────────
    // `cuentas_pagar.compra_id` referencia la compra SIN ON DELETE CASCADE:
    // si la CxP existe, el DELETE de la compra falla con error 23503 en
    // Postgres (era el "409 Conflict" que aparecía en consola sin explicación
    // en pantalla). Hay que resolverla antes.
    const cxpsCompra = await getCuentasPagarByCompra(id)
    const pagosCompra = await getPagosProveedoresByCompra(id)

    // Un pago ya registrado significa que salió dinero: borrar la compra
    // dejaría un pago huérfano y descuadraría bancos y contabilidad.
    if ((pagosCompra || []).length > 0) {
      const totalPagado = pagosCompra.reduce((s2, p) => s2 + (parseFloat(p.monto) || 0), 0)
      showToast(
        `No se puede eliminar: la compra tiene ${pagosCompra.length} pago(s) por ${formatNumber(totalPagado)}. ` +
        `Elimina primero esos pagos en "Cuentas x Cobrar/Pagar", o anula la compra en vez de eliminarla.`,
        'danger'
      )
      return
    }

    // Notas de crédito/débito que referencian esta compra: también bloquean
    // el DELETE por FK, y borrarlas en silencio perdería documentos fiscales.
    const notasDeEstaCompra = (await getCompras() || []).filter(c => c.compra_referencia_id === id)
    if (notasDeEstaCompra.length > 0) {
      showToast(
        `No se puede eliminar: hay ${notasDeEstaCompra.length} nota(s) de crédito/débito que referencian esta compra ` +
        `(${notasDeEstaCompra.map(n => `${n.serie || ''}-${n.numero || ''}`).join(', ')}). Elimínalas primero.`,
        'danger'
      )
      return
    }

    const totalLotes = (lotes || []).length
    const totalGuias = guiasCompra.length
    if (totalLotes === 0 && totalGuias === 0) {
      const continuar = confirm(
        'Esta compra no tiene guía ni lotes vinculados (puede ser una compra de servicio, sin recibir aún, o ya revertida manualmente). ' +
        '¿Eliminar solo el registro de la compra y su detalle?'
      )
      if (!continuar) return
    } else {
      const continuar = confirm(
        `Se eliminará la compra, su detalle, ${totalGuias} guía(s) y ${totalLotes} lote(s) de inventario (sin ventas pendientes)` +
        `${(cxpsCompra || []).length > 0 ? `, y su Cuenta por Pagar (sin pagos aplicados)` : ''}. ¿Continuar?`
      )
      if (!continuar) return
    }

    // Kardex: se borran TODAS las filas de esta compra (aún en pruebas —
    // sin esto quedarían movimientos "entrada" de lotes que ya no existen).
    // deleteRecord() puede devolver false sin lanzar excepción — si no se
    // valida, el kardex queda huérfano y la compra se borra igual.
    const kardexCompra = await getKardexByCompra(id)
    for (const k of (kardexCompra || [])) {
      const okKardex = await deleteKardexMovimiento(k.id)
      if (!okKardex) {
        const motivo = ultimoErrorDelete()
        throw new Error(`No se pudo eliminar el movimiento de Kardex #${k.id}: ${motivo?.mensaje || 'motivo desconocido'}. Se detiene el borrado para no dejar el Kardex descuadrado.`)
      }
    }

    for (const l of (lotes || [])) {
      await deleteLote(l.id)
    }

    // Las guías de remisión de esta compra referencian compras.id sin CASCADE:
    // hay que borrarlas antes o el DELETE de la compra falla por FK.
    for (const g of guiasCompra) {
      await deleteGuiaIngresoCompra(g.id) // detalle_guias_ingreso_compra se borra solo (ON DELETE CASCADE)
    }

    // Cuentas por Pagar: se borran al final de las dependencias y justo antes
    // de la compra. Ya validamos arriba que no tienen pagos aplicados.
    for (const cxp of (cxpsCompra || [])) {
      const pagosCxP = await getPagosProveedoresByCxP(cxp.id)
      for (const pg of (pagosCxP || [])) await deletePagoProveedor(pg.id)
      await deleteCuentaPagar(cxp.id)
    }

    const ok = await deleteCompra(id)
    if (!ok) {
      const motivo = ultimoErrorDelete()
      showToast(
        `No se pudo eliminar la compra: ${motivo?.mensaje || 'error desconocido'} ` +
        `Si no quieres perder el rastro del documento, anúlala en vez de eliminarla.`,
        'danger', 8000
      )
      return
    }

    _invalidarCacheCompras()
    showToast('Compra eliminada correctamente', 'success')
    await _cargarComprasConGuia(true)
    await renderCompras(true)
  } catch (error) {
    console.error('Error en eliminarCompra:', error)
    showToast('Error al eliminar la compra: ' + error.message, 'danger')
  }
}

// ============================================================================
// SELECCIÓN MÚLTIPLE — checkbox por fila en la tabla de Compras (mismo
// patrón que Ventas: window.eliminarVentasSeleccionadas en ventas.js).
// ============================================================================

window.toggleSeleccionTodasCompras = function (checked) {
  document.querySelectorAll('.compra-sel:not(:disabled)').forEach(cb => { cb.checked = checked })
  window.actualizarBotonEliminarComprasSeleccionadas()
}

window.actualizarBotonEliminarComprasSeleccionadas = function () {
  const seleccionadas = document.querySelectorAll('.compra-sel:checked').length
  const btn = document.getElementById('btnEliminarComprasSeleccionadas')
  if (!btn) return
  btn.style.display = seleccionadas > 0 ? 'inline-flex' : 'none'
  btn.textContent = `🗑 Eliminar seleccionadas (${seleccionadas})`
}

// Reusa window.eliminarCompra por id — esa función YA trae sus propias
// validaciones y confirm() por compra (ventas pendientes, pagos aplicados,
// notas de crédito/débito, etc.), así que aquí solo se recorre la selección;
// no se duplica esa lógica de bloqueo.
window.eliminarComprasSeleccionadas = async function () {
  const ids = Array.from(document.querySelectorAll('.compra-sel:checked')).map(cb => parseInt(cb.value))
  if (ids.length === 0) { showToast('Selecciona al menos una compra', 'warning'); return }
  if (!confirm(`Vas a eliminar ${ids.length} compra(s). Cada una se validará individualmente (ventas, pagos o notas vinculadas la bloquearán). ¿Continuar?`)) return

  const btn = document.getElementById('btnEliminarComprasSeleccionadas')
  if (btn) { btn.disabled = true; btn.textContent = 'Eliminando...' }

  for (const id of ids) {
    await window.eliminarCompra(id)
  }

  if (btn) btn.disabled = false
}

// ============================================================================
// GUÍA DE REMISIÓN (recepción de mercadería de una compra ya registrada)
// ============================================================================
// Flujo: la Compra se registra sin lote (solo cantidad/precio/proveedor).
// El stock recién se agrega a Inventario cuando se guarda la Guía de
// Remisión: se elige la compra, se confirma/ajusta la cantidad recibida por
// línea y se pide N° de Lote (obligatorio) + Marca (obligatorio) + Partida
// (opcional) por producto. Cada línea de la guía crea un registro en
// "lotes" (compra_id + guia_id para trazabilidad).

let _guiaLineas = []           // líneas de la compra seleccionada, con lote/marca/partida a rellenar
let _guiaComprasCache = null   // cache de compras para el <select> del modal
// Modo dual del modal-nueva-guia: null = creando una guía nueva; con un id =
// editando esa guía existente (window.editarGuiaIngreso la puso ahí). El
// mismo formulario/tabla se reusa para ambos casos — solo cambia el guardado.
let _guiaIngresoEditId = null
let _guiaComprasConGuiaSet = null // set de compra_id que YA tienen al menos 1 guía (para el badge en renderCompras)

async function _cargarComprasConGuia(forzar = false) {
  if (_guiaComprasConGuiaSet && !forzar) return _guiaComprasConGuiaSet
  const guias = await getGuiasIngresoCompra()
  // Las guías anuladas ya retiraron su stock, así que la compra vuelve a estar
  // "pendiente de guía": no deben contar aquí o el badge diría "✓ Con Guía"
  // para una compra cuya mercadería ya no está en el almacén.
  _guiaComprasConGuiaSet = new Set(
    (guias || []).filter(g => g.estado !== 'anulada').map(g => g.compra_id)
  )
  return _guiaComprasConGuiaSet
}

let _guiasListaEnriquecida = null // cache: [{g, compra, detalles, productosLote, marcasTexto, zonasTexto}]
let _guiaSort = { col: null, dir: 'asc' } // orden por columna, tab Guías

function _valorOrdenGuia({ g, compra, detalles }, campo) {
  switch (campo) {
    case 'numero_guia':  return g.numero_guia || ''
    case 'fecha_guia':   return g.fecha_guia || ''
    case 'referencia':   return compra?.referencia || `Compra #${g.compra_id}`
    case 'proveedor':    return compra?.proveedor_nombre || ''
    case 'num_productos': return (detalles || []).length
    case 'observaciones': return g.observaciones || ''
    default: return ''
  }
}

window.ordenarGuias = async function (campo) {
  if (_guiaSort.col === campo) {
    _guiaSort.dir = _guiaSort.dir === 'asc' ? 'desc' : 'asc'
  } else {
    _guiaSort.col = campo
    _guiaSort.dir = 'asc'
  }
  await renderGuias()
}

async function renderGuias(forzar = false) {
  try {
    renderDevolucionesPendientes(forzar).catch(e => console.warn('renderDevolucionesPendientes:', e.message))

    const container = document.getElementById('tabla-guias')
    if (!container) return

    if (!_guiasListaEnriquecida || forzar) {
      const guias = await getGuiasIngresoCompra()
      if (!guias || guias.length === 0) {
        _guiasListaEnriquecida = []
      } else {
        const [itemsList, marcas, zonas, almacenes] = await Promise.all([
          getItems(), getMarcas(), getUbicaciones(), getAlmacenes()
        ])
        const itemMap = {}
        for (const it of (itemsList || [])) itemMap[it.id] = it
        const marcaMap = {}
        for (const m of (marcas || [])) marcaMap[m.id] = m
        const almacenMap = {}
        for (const a of (almacenes || [])) almacenMap[a.id] = a
        const zonaMap = {}
        for (const z of (zonas || [])) zonaMap[z.id] = z

        // Todas las guías en paralelo (antes: una compra+detalle por vez, en
        // secuencia — con 20 guías eran 40 idas y vueltas a la BD una tras otra).
        const guiasOrdenadas = guias.sort((a, b) => b.id - a.id)
        const datosPorGuia = await Promise.all(
          guiasOrdenadas.map(g => Promise.all([
            getCompraById(g.compra_id),
            getDetalleGuiasIngresoCompra(g.id)
          ]))
        )

        _guiasListaEnriquecida = guiasOrdenadas.map((g, idx) => {
          const [compra, detalles] = datosPorGuia[idx]

          // Resumen agrupado por producto en vez de listar cada lote (con
          // guías de 10-20+ lotes la columna se volvía enorme): "Producto —
          // N lote(s) — cantidad total". El detalle lote por lote sigue
          // disponible al editar la guía.
          const porProducto = new Map()
          for (const d of (detalles || [])) {
            const nombre = itemMap[d.item_id]?.nombre || `Item #${d.item_id}`
            const unidad = itemMap[d.item_id]?.unidad_medida || 'KG'
            const acc = porProducto.get(nombre) || { lotes: 0, cantidad: 0, unidad }
            acc.lotes += 1
            acc.cantidad += parseFloat(d.cantidad) || 0
            porProducto.set(nombre, acc)
          }
          const productosLote = [...porProducto.entries()]
            .map(([nombre, acc]) => `${nombre} — ${acc.lotes} lote${acc.lotes === 1 ? '' : 's'} — ${acc.cantidad.toLocaleString('en-US', { maximumFractionDigits: 2 })} ${acc.unidad}`)
            .join('; ') || '-'
          const marcasTexto = [...new Set((detalles || []).map(d => marcaMap[d.marca_id]?.nombre).filter(Boolean))]
            .join(', ') || '-'
          const zonasTexto = [...new Set((detalles || []).map(d => {
            const z = zonaMap[d.ubicacion_id]
            if (!z) return null
            return `${almacenMap[z.almacen_id]?.nombre || '?'} — ${z.nombre}`
          }).filter(Boolean))].join(', ') || '-'

          return { g, compra, detalles, productosLote, marcasTexto, zonasTexto }
        })
      }
    }

    if (_guiasListaEnriquecida.length === 0) {
      container.innerHTML = '<p style="text-align:center; color:var(--text-secondary); padding:20px;">Sin guías de remisión registradas</p>'
      return
    }

    const busqueda = (document.getElementById('buscarGuia')?.value || '').trim().toLowerCase()
    const listaFiltrada = busqueda
      ? _guiasListaEnriquecida.filter(({ g, compra }) => {
          return `${g.numero_guia || ''} ${g.fecha_guia || ''} ${g.observaciones || ''} ${compra?.referencia || ''} ${compra?.proveedor_nombre || ''}`
            .toLowerCase().includes(busqueda)
        })
      : _guiasListaEnriquecida

    if (listaFiltrada.length === 0) {
      container.innerHTML = '<p style="text-align:center; color:var(--text-secondary); padding:20px;">Sin resultados para la búsqueda</p>'
      return
    }

    if (_guiaSort.col) {
      listaFiltrada.sort((a, b) => {
        const cmp = _compararValoresOrden(_valorOrdenGuia(a, _guiaSort.col), _valorOrdenGuia(b, _guiaSort.col))
        return _guiaSort.dir === 'asc' ? cmp : -cmp
      })
    }

    let html = `
      <table>
        <thead>
          <tr>
            <th data-col-tabla="guias-ingreso" data-col="sel" style="width:32px;${colStyle('guias-ingreso','sel') ? 'display:none;' : ''}"><input type="checkbox" id="selAllGuias" onchange="window.toggleSeleccionTodasGuias(this.checked)" title="Seleccionar todas"></th>
            ${_thOrdenable('N° Guía', 'numero_guia', _guiaSort, 'ordenarGuias', 'guias-ingreso')}
            ${_thOrdenable('Fecha', 'fecha_guia', _guiaSort, 'ordenarGuias', 'guias-ingreso', 'fecha')}
            ${_thOrdenable('Compra (Referencia)', 'referencia', _guiaSort, 'ordenarGuias', 'guias-ingreso')}
            ${_thOrdenable('Proveedor', 'proveedor', _guiaSort, 'ordenarGuias', 'guias-ingreso')}
            ${_thOrdenable('# Productos', 'num_productos', _guiaSort, 'ordenarGuias', 'guias-ingreso')}
            <th data-col-tabla="guias-ingreso" data-col="productos"${colStyle('guias-ingreso','productos')}>Producto(s) / Lote(s)</th>
            <th data-col-tabla="guias-ingreso" data-col="marcas"${colStyle('guias-ingreso','marcas')}>Marca(s)</th>
            <th data-col-tabla="guias-ingreso" data-col="zonas"${colStyle('guias-ingreso','zonas')}>Almacén / Zona(s)</th>
            ${_thOrdenable('Observaciones', 'observaciones', _guiaSort, 'ordenarGuias', 'guias-ingreso')}
            <th data-col-tabla="guias-ingreso" data-col="estado"${colStyle('guias-ingreso','estado')}>Estado</th>
            <th data-col-tabla="guias-ingreso" data-col="acciones"${colStyle('guias-ingreso','acciones')}>Acciones</th>
          </tr>
        </thead>
        <tbody>
    `

    listaFiltrada.forEach(({ g, compra, detalles, productosLote, marcasTexto, zonasTexto }) => {
      const gAnulada = estaAnulado(g)
      html += `
        <tr${gAnulada ? ` style="${ESTILO_FILA_ANULADA}"` : ''}>
          <td data-col-tabla="guias-ingreso" data-col="sel" style="text-decoration:none; opacity:1;${colStyle('guias-ingreso','sel') ? ' display:none;' : ''}">${gAnulada
            ? `<input type="checkbox" disabled title="Guía anulada: su stock ya fue retirado">`
            : `<input type="checkbox" class="gi-sel" value="${g.id}" onchange="window.actualizarBotonEliminarGuias()">`}</td>
          <td data-col-tabla="guias-ingreso" data-col="numero_guia"${colStyle('guias-ingreso','numero_guia')}><strong>${g.numero_guia}</strong></td>
          <td data-col-tabla="guias-ingreso" data-col="fecha"${colStyle('guias-ingreso','fecha')}>${g.fecha_guia || '-'}</td>
          <td data-col-tabla="guias-ingreso" data-col="referencia"${colStyle('guias-ingreso','referencia')}>${compra?.referencia || `Compra #${g.compra_id}`}</td>
          <td data-col-tabla="guias-ingreso" data-col="proveedor"${colStyle('guias-ingreso','proveedor')}>${compra?.proveedor_nombre || '-'}</td>
          <td data-col-tabla="guias-ingreso" data-col="num_productos" style="text-align:center;${colStyle('guias-ingreso','num_productos') ? ' display:none;' : ''}">${(detalles || []).length}</td>
          <td data-col-tabla="guias-ingreso" data-col="productos"${colStyle('guias-ingreso','productos')}><div class="clamp-lineas" title="${(productosLote || '').replace(/"/g, '&quot;')}">${productosLote}</div></td>
          <td data-col-tabla="guias-ingreso" data-col="marcas"${colStyle('guias-ingreso','marcas')}>${marcasTexto}</td>
          <td data-col-tabla="guias-ingreso" data-col="zonas"${colStyle('guias-ingreso','zonas')}>${zonasTexto}</td>
          <td data-col-tabla="guias-ingreso" data-col="observaciones"${colStyle('guias-ingreso','observaciones')}>${g.observaciones ? _escCompras(g.observaciones) : (gAnulada && g.motivo_anulacion ? `<em style="color:var(--text-secondary);">Anulado: ${_escCompras(g.motivo_anulacion)}</em>` : '-')}</td>
          <td data-col-tabla="guias-ingreso" data-col="estado"${colStyle('guias-ingreso','estado')}>${gAnulada ? badgeAnulado(g) : '<span class="badge badge-success">Emitida</span>'}</td>
          <td data-col-tabla="guias-ingreso" data-col="acciones" class="col-acciones" style="text-decoration:none; opacity:1;${colStyle('guias-ingreso','acciones') ? ' display:none;' : ''}">
            ${menuAccionesFila(gAnulada
              ? [{ label: 'Ver motivo de anulación', icono: 'ℹ️', onclick: `window.verMotivoAnulacionCompra('guia', ${g.id})` }]
              : [
                  { label: 'Editar cabecera', icono: '✏️', onclick: `window.editarGuia(${g.id})` },
                  { label: 'Editar líneas (cantidad/lote/zona)', icono: '📦', onclick: `window.editarGuiaIngreso(${g.id})` },
                  { separador: true },
                  { label: 'Anular guía', icono: '🚫', onclick: `window.anularGuiaIngreso(${g.id})`, peligro: true },
                  { label: 'Eliminar', icono: '🗑️', onclick: `window.eliminarGuia(${g.id})`, peligro: true }
                ])}
          </td>
        </tr>
      `
    })
    html += '</tbody></table>'
    container.innerHTML = html
  } catch (error) {
    console.error('Error en renderGuias:', error)
    showToast('Error al cargar las guías de remisión', 'danger')
  }
}

window.filtrarGuias = async function () {
  await renderGuias()
}

// ─── Editar Guía (solo cabecera: N° guía, fecha, observaciones) ──────────────
// Las líneas (lote/marca/zona/cantidad) NO se editan aquí porque ya
// generaron stock real en Inventario (lotes + stock_ubicaciones). Para
// corregir cantidades hay que eliminar la guía (si no tiene ventas) y
// volver a registrarla.

window.editarGuia = async function (id) {
  try {
    const g = await getGuiaIngresoCompraById(id)
    if (!g) { showToast('No se encontró la guía', 'danger'); return }

    document.getElementById('egId').value = g.id
    document.getElementById('egNumeroGuia').value = g.numero_guia || ''
    document.getElementById('egFechaGuia').value = g.fecha_guia || ''
    document.getElementById('egObservaciones').value = g.observaciones || ''

    window.openModal('modal-editar-guia')
  } catch (error) {
    console.error('Error en editarGuia:', error)
    showToast('Error al abrir la guía para editar', 'danger')
  }
}

window.guardarEdicionGuia = async function () {
  try {
    const id = parseInt(document.getElementById('egId')?.value || 0)
    if (!id) { showToast('Guía inválida', 'danger'); return }

    const numeroGuia = document.getElementById('egNumeroGuia')?.value?.trim()
    const fechaGuia = document.getElementById('egFechaGuia')?.value
    const observaciones = document.getElementById('egObservaciones')?.value?.trim() || null

    if (!numeroGuia) { showToast('Ingresa el N° de Guía', 'warning'); return }
    if (!fechaGuia)  { showToast('Ingresa la fecha de la guía', 'warning'); return }

    const actualizado = await updateGuiaIngresoCompra(id, {
      numero_guia: numeroGuia,
      fecha_guia: fechaGuia,
      observaciones
    })

    if (!actualizado) { showToast('No se pudo actualizar la guía', 'danger'); return }

    showToast('Guía actualizada', 'success')
    window.closeModal('modal-editar-guia')
    await renderGuias(true)
  } catch (error) {
    console.error('Error en guardarEdicionGuia:', error)
    showToast('Error al actualizar la guía', 'danger')
  }
}

// ─── Eliminar Guía ────────────────────────────────────────────────────────────
// Al eliminar una guía se revierte el ingreso de stock que generó:
//   1) Por cada línea (detalle_guias_ingreso_compra) se verifica si el lote
//      creado ya tuvo alguna venta: se compara la cantidad ORIGINAL recibida
//      en esta guía (detalle.cantidad, inmutable) contra la cantidad ACTUAL
//      del lote (lotes.cantidad). Si actual < original, ya se vendió stock
//      de ese lote → SE BLOQUEA el borrado.
//   2) Si el lote ya no existe (se borró manualmente antes), no hay nada
//      que revertir para esa línea — se ignora, igual que en eliminarCompra.
//   3) Si todo está limpio: se borran los lotes (stock_ubicaciones se borra
//      solo por ON DELETE CASCADE) y luego la guía (detalle_guias_ingreso_
//      compra se borra solo por ON DELETE CASCADE). Importante: se borran
//      los LOTES primero, no solo la guía — lotes.guia_id es ON DELETE SET
//      NULL, así que borrar la guía sin borrar los lotes dejaría el stock
//      "huérfano" en Inventario en vez de revertirlo.
/**
 * Núcleo de la eliminación de una guía de ingreso.
 * @param {boolean} pedirConfirmacion  false en el borrado masivo (ya hubo un
 *        único confirm para todo el lote). Los bloqueos por stock ya vendido
 *        se lanzan como Error para que el masivo siga con las demás guías y
 *        reporte al final cuáles no pudo.
 */
/**
 * Calcula QUÉ habría que revertir para una guía de ingreso, sin escribir
 * nada en la base todavía. Lanza Error si algún lote/bulto de esta guía ya
 * tuvo consumo (venta, merma, etc.) — ni eliminar ni editar la guía es
 * seguro en ese caso. Reusado por _eliminarGuiaIngresoCore (borra todo) y
 * por window.guardarEdicionGuiaIngreso (revierte para reaplicar cambios).
 */
async function _planRevertirGuiaIngreso(id) {
  const detalles = await getDetalleGuiasIngresoCompra(id)

  const vendidos = []
  const lotesABorrar = []     // lotes que quedan en 0 tras la reversión: se eliminan enteros
  const lotesADescontar = []  // lotes sin peso variable a los que esta guía sumó: se restan por aritmética
  const lotesConBultos = []   // lotes con peso variable: se resuelve borrando SUS bultos, no por resta

  for (const dg of (detalles || [])) {
    if (!dg.lote_id) continue
    const lote = await getLoteById(dg.lote_id)
    if (!lote) continue // ya no existe: nada que revertir para esta línea

    // ── Lotes con peso variable: lote_bultos es la fuente de verdad ────────
    // No se puede restar dg.cantidad a mano porque cantidad/cantidad_unidades
    // del lote se recalculan SIEMPRE desde la suma de sus bultos disponibles
    // (recalcularLoteDesdeBultos) — cualquier resta manual que no borre
    // también los bultos de esta guía queda pisada la próxima vez que algo
    // dispare ese recálculo, resucitando la cantidad "eliminada".
    if (lote.es_peso_variable) {
      const bultosLote = await getLoteBultosByLote(lote.id)
      const bultosDeEstaGuia = (bultosLote || []).filter(b => b.guia_ingreso_id === id)
      if (bultosDeEstaGuia.length === 0) continue // esta guía no aportó bultos a este lote

      const noDisponibles = bultosDeEstaGuia.filter(b => b.estado !== 'disponible')
      if (noDisponibles.length > 0) {
        const item = await getItemById(dg.item_id)
        vendidos.push(`${item?.nombre || 'Item #' + dg.item_id} (lote ${lote.numero_lote}): ${noDisponibles.length} bulto(s) de esta guía ya no está(n) disponible(s) (vendido/devuelto/merma)`)
        continue
      }

      const pesoARevertir = bultosDeEstaGuia.reduce((s, b) => s + (parseFloat(b.peso) || 0), 0)
      lotesConBultos.push({
        lote, bultosDeEstaGuia, ubicacion_id: dg.ubicacion_id, pesoARevertir,
        esTodoElLote: bultosDeEstaGuia.length === bultosLote.length
      })
      continue
    }

    // ── Lotes sin peso variable: heurística original por aritmética ────────
    const original = parseFloat(dg.cantidad) || 0
    const actual = parseFloat(lote.cantidad) || 0

    // Un lote puede haber sido CREADO por esta guía (lote.guia_id === id) o
    // ser un lote preexistente al que esta guía le sumó cantidad. En el
    // segundo caso no se puede borrar: hay que restar solo lo que aportó.
    const loCreoEstaGuia = lote.guia_id === id

    if (loCreoEstaGuia) {
      const vendido = parseFloat((original - actual).toFixed(4))
      if (vendido > 0) {
        const item = await getItemById(dg.item_id)
        vendidos.push(`${item?.nombre || 'Item #' + dg.item_id} (lote ${lote.numero_lote}): ${vendido} vendido de ${original}`)
      } else {
        lotesABorrar.push(lote.id)
      }
    } else {
      if (actual + 0.0001 < original) {
        const item = await getItemById(dg.item_id)
        vendidos.push(`${item?.nombre || 'Item #' + dg.item_id} (lote ${lote.numero_lote}): quedan ${actual} pero esta guía aportó ${original}`)
      } else {
        lotesADescontar.push({ lote, cantidad: original, unidades: 0, ubicacion_id: dg.ubicacion_id })
      }
    }
  }

  if (vendidos.length > 0) {
    throw new Error(
      `ya hay ventas de esta guía (${vendidos.join(' | ')}). ` +
      `Anula/ajusta esas ventas para devolver el stock antes de editarla/eliminarla`
    )
  }

  const lotesConBultosCompletos = lotesConBultos.filter(l => l.esTodoElLote)
  const lotesConBultosParciales = lotesConBultos.filter(l => !l.esTodoElLote)
  return {
    lotesABorrar, lotesADescontar, lotesConBultos, lotesConBultosCompletos, lotesConBultosParciales,
    totalABorrar: lotesABorrar.length + lotesConBultosCompletos.length,
    totalADescontar: lotesADescontar.length + lotesConBultosParciales.length
  }
}

/**
 * Ejecuta el plan de _planRevertirGuiaIngreso: descuenta kardex/lotes/
 * stock_ubicaciones. NO borra la guía ni los lotes que quedan en 0 — eso lo
 * decide el llamador (eliminar borra todo; editar los borra para recrearlos
 * con los valores nuevos).
 */
async function _aplicarReversionGuiaIngreso(id, plan) {
  // Kardex: se borran las filas de los lotes que se van a eliminar POR
  // COMPLETO — sin esto quedarían movimientos "fantasma" de lotes que ya no
  // existen. No se tocan lotes que solo se descuentan parcialmente: ese
  // kardex sigue siendo válido para lo que queda.
  const idsLotesABorrarCompleto = [...plan.lotesABorrar, ...plan.lotesConBultosCompletos.map(l => l.lote.id)]
  const guiaActual = await getGuiaIngresoCompraById(id)
  if (guiaActual?.compra_id && idsLotesABorrarCompleto.length > 0) {
    const kardexCompra = await getKardexByCompra(guiaActual.compra_id)
    for (const k of (kardexCompra || [])) {
      if (idsLotesABorrarCompleto.includes(k.lote_id)) {
        const okKardex = await deleteKardexMovimiento(k.id)
        if (!okKardex) {
          const motivo = ultimoErrorDelete()
          throw new Error(`No se pudo eliminar el movimiento de Kardex #${k.id}: ${motivo?.mensaje || 'motivo desconocido'}. Se detiene la reversión para no dejar el Kardex descuadrado.`)
        }
      }
    }
  }

  // Lotes sin peso variable: se resta lo que esta guía aportó, a ellos y a
  // su fila de stock_ubicaciones de la zona correspondiente.
  for (const d of plan.lotesADescontar) {
    const nuevaCant = parseFloat(Math.max(0, (parseFloat(d.lote.cantidad) || 0) - d.cantidad).toFixed(4))
    await updateLote(d.lote.id, { cantidad: nuevaCant })
    if (d.ubicacion_id) {
      const filas = await getStockUbicacionesByLote(d.lote.id)
      const fila = (filas || []).find(f => f.ubicacion_id === d.ubicacion_id)
      if (fila) {
        await updateStockUbicacion(fila.id, {
          cantidad: parseFloat(Math.max(0, (parseFloat(fila.cantidad) || 0) - d.cantidad).toFixed(4))
        })
      }
    }
  }

  // Lotes con peso variable: se borran SOLO los bultos que esta guía trajo
  // y se recalcula el lote desde los que quedan (fuente de verdad real).
  // stock_ubicaciones se descuenta aparte porque, en Fase 1, sigue
  // escribiéndose en paralelo para compatibilidad con pantallas que aún no
  // leen v_stock_bultos_zona.
  for (const { lote, bultosDeEstaGuia, ubicacion_id, pesoARevertir, esTodoElLote } of plan.lotesConBultos) {
    for (const b of bultosDeEstaGuia) await deleteLoteBulto(b.id)

    if (!esTodoElLote) await recalcularLoteDesdeBultos(lote.id)
    // si esTodoElLote, el lote entero se borra en idsLotesABorrarCompleto;
    // recalcular no tiene sentido sobre un lote que va a desaparecer.

    if (ubicacion_id) {
      const filas = await getStockUbicacionesByLote(lote.id)
      const fila = (filas || []).find(f => f.ubicacion_id === ubicacion_id)
      if (fila) {
        await updateStockUbicacion(fila.id, {
          cantidad: parseFloat(Math.max(0, (parseFloat(fila.cantidad) || 0) - pesoARevertir).toFixed(4)),
          cantidad_unidades: parseFloat(Math.max(0, (parseFloat(fila.cantidad_unidades) || 0) - bultosDeEstaGuia.length).toFixed(4))
        })
      }
    }
  }
}

async function _eliminarGuiaIngresoCore(id, pedirConfirmacion = true) {
  const plan = await _planRevertirGuiaIngreso(id)

  if (pedirConfirmacion && !confirm(
    `Se eliminará la guía revirtiendo el stock ingresado:\n` +
    `  • ${plan.totalABorrar} lote(s) creados por esta guía se eliminarán.\n` +
    `  • ${plan.totalADescontar} lote(s) preexistentes solo se descontarán.\n\n¿Continuar?`
  )) return { cancelado: true }

  await _aplicarReversionGuiaIngreso(id, plan)

  // La guía se borra ANTES que los lotes. detalle_guias_ingreso_compra.lote_id
  // referencia a lotes SIN ON DELETE CASCADE: si se intentara borrar el lote
  // primero, Postgres rechaza el DELETE (23503) porque la línea de esta
  // misma guía todavía apunta a él — y como nadie revisaba el resultado de
  // deleteLote(), el error se tragaba en silencio: la guía quedaba
  // eliminada pero el lote sobrevivía intacto con la cantidad "revertida".
  const ok = await deleteGuiaIngresoCompra(id) // cascada: borra detalle_guias_ingreso_compra
  if (!ok) {
    const motivo = ultimoErrorDelete()
    throw new Error(motivo?.mensaje || 'no se pudo eliminar')
  }

  const idsLotesABorrarCompleto = [...plan.lotesABorrar, ...plan.lotesConBultosCompletos.map(l => l.lote.id)]
  for (const loteId of idsLotesABorrarCompleto) {
    const borrado = await deleteLote(loteId) // stock_ubicaciones y lote_bultos de ese lote se borran solos (ON DELETE CASCADE)
    if (!borrado) {
      const motivo = ultimoErrorDelete()
      console.error(`No se pudo eliminar el lote ${loteId} tras borrar la guía:`, motivo)
      showToast(
        `La guía se eliminó, pero el lote #${loteId} no se pudo borrar (${motivo?.mensaje || 'motivo desconocido'}). Revísalo manualmente en Inventario.`,
        'warning', 8000
      )
    }
  }

  return { cancelado: false, lotesBorrados: plan.totalABorrar, lotesDescontados: plan.totalADescontar }
}

window.eliminarGuia = async function (id) {
  try {
    const r = await _eliminarGuiaIngresoCore(id, true)
    if (r?.cancelado) return

    _invalidarCacheCompras()
    showToast('Guía eliminada: stock revertido en Inventario', 'success')
    await _cargarComprasConGuia(true)
    await renderGuias(true)
    await renderCompras(true)
  } catch (error) {
    console.error('Error en eliminarGuia:', error)
    showToast('No se pudo eliminar la guía: ' + error.message, 'danger', 7000)
  }
}

// ── Editar líneas de una Guía de Ingreso (cantidad/lote/marca/zona) ────────
// Reusa TODO el formulario/tabla de "Nueva Guía" (modal-nueva-guia,
// _guiaLineas, _renderTablaDetalleGuia, _sincronizarRecepcionesGuiaDesdeDOM)
// en un "modo edición": se precarga con lo que esta guía ya recibió, el
// usuario corrige cantidad/lote/marca/partida/zona (incluso packing list de
// bultos si es peso variable), y al guardar se hace REVERTIR + REAPLICAR
// sobre la MISMA guía — igual patrón que "Editar Guía de Despacho" en
// Ventas. _planRevertirGuiaIngreso ya bloquea todo el intento si algún lote
// de esta guía tuvo consumo (venta/merma) desde que se recibió: no se puede
// editar con seguridad en ese caso.
window.editarGuiaIngreso = async function (id) {
  try {
    // Verificación temprana: si algo de esta guía ya se vendió, no tiene
    // caso abrir el formulario de edición — se bloquea antes de armarlo.
    await _planRevertirGuiaIngreso(id)

    const guia = await getGuiaIngresoCompraById(id)
    if (!guia) { showToast('No se encontró la guía', 'danger'); return }

    const [compra, detallesGuia, todosDetallesCompra, marcas, itemsList, almacenes, zonas] = await Promise.all([
      getCompraById(guia.compra_id),
      getDetalleGuiasIngresoCompra(id),
      getCompraDetalles(guia.compra_id),
      getMarcas(),
      getItems(),
      getAlmacenes(),
      getUbicaciones()
    ])

    if (!detallesGuia || detallesGuia.length === 0) {
      showToast('Esta guía no tiene líneas registradas para editar', 'warning')
      return
    }

    const itemsMap = {}
    for (const it of (itemsList || [])) itemsMap[it.id] = it
    const almacenesMap = {}
    for (const a of (almacenes || [])) almacenesMap[a.id] = a
    const detalleCompraMap = {}
    for (const d of (todosDetallesCompra || [])) detalleCompraMap[d.id] = d

    _guiaMarcasCache = marcas || []
    _guiaZonasCache = (zonas || [])
      .filter(z => !almacenesMap[z.almacen_id]?.es_virtual)
      .map(z => ({
        id: z.id, nombre: z.nombre, almacen_id: z.almacen_id,
        almacenNombre: almacenesMap[z.almacen_id]?.nombre || `Almacén #${z.almacen_id}`
      }))
    _guiaZonasNombre = {}
    for (const z of _guiaZonasCache) _guiaZonasNombre[z.id] = `${z.almacenNombre} — ${z.nombre}`

    _guiaCompraActual = compra
    const lotesExistentes = await getLotes()
    _guiaLotesPorItem = {}
    for (const lo of (lotesExistentes || [])) {
      if (!lo.item_id) continue
      ;(_guiaLotesPorItem[lo.item_id] = _guiaLotesPorItem[lo.item_id] || []).push(lo)
    }
    Object.values(_guiaLotesPorItem).forEach(arr =>
      arr.sort((a, b) => (b.fecha_ingreso || '').localeCompare(a.fecha_ingreso || '') || b.id - a.id))

    // Lo recibido en OTRAS guías (no anuladas) de esta misma compra: sirve
    // de referencia de "pendiente" — la propia contribución de ESTA guía no
    // cuenta como "ya recibido" porque es justo lo que se está reeditando.
    const recibidoTodas = await _getCantidadesRecibidasPorDetalle()
    const recibidoEnEstaGuia = new Map()
    for (const dg of detallesGuia) {
      if (!dg.detalle_compra_id) continue
      recibidoEnEstaGuia.set(dg.detalle_compra_id, (recibidoEnEstaGuia.get(dg.detalle_compra_id) || 0) + (parseFloat(dg.cantidad) || 0))
    }

    // Agrupa las líneas de esta guía por detalle_compra_id (una línea de
    // compra pudo recibirse en 1 o más lotes/zonas dentro de esta MISMA
    // guía) y arma cada recepción con los valores actuales, editables.
    const porDetalleCompra = new Map()
    for (const dg of detallesGuia) {
      if (!porDetalleCompra.has(dg.detalle_compra_id)) porDetalleCompra.set(dg.detalle_compra_id, [])
      porDetalleCompra.get(dg.detalle_compra_id).push(dg)
    }

    _guiaLineas = []
    for (const [detalleCompraId, dgs] of porDetalleCompra) {
      const d = detalleCompraMap[detalleCompraId]
      if (!d) continue // línea de compra borrada: no hay nada que editar aquí

      const comprado = parseFloat(d.cantidad) || 0
      const recibidoOtras = parseFloat(((recibidoTodas.get(detalleCompraId) || 0) - (recibidoEnEstaGuia.get(detalleCompraId) || 0)).toFixed(4))
      const yaRecibido = Math.max(0, recibidoOtras)

      const recepciones = []
      for (const dg of dgs) {
        const lote = dg.lote_id ? await getLoteById(dg.lote_id) : null
        const esPesoVariable = !!lote?.es_peso_variable
        let bultos = []
        if (esPesoVariable && lote) {
          const bultosLote = await getLoteBultosByLote(lote.id)
          bultos = (bultosLote || [])
            .filter(b => b.guia_ingreso_id === id)
            .map(b => ({ peso: parseFloat(b.peso) || null }))
          if (bultos.length === 0) bultos = [{ peso: null }]
        }
        recepciones.push({
          cantidad: parseFloat(dg.cantidad) || 0,
          numero_lote: dg.numero_lote || '',
          marca_id: dg.marca_id || null,
          codigo_partida: dg.codigo_partida || '',
          ubicacion_id: dg.ubicacion_id || '',
          cantidad_unidades: lote?.cantidad_unidades || null,
          es_peso_variable: esPesoVariable,
          bultos
        })
      }

      _guiaLineas.push({
        detalle_compra_id: detalleCompraId,
        item_id:            d.item_id,
        nombre:              itemsMap[d.item_id]?.nombre || `Item #${d.item_id}`,
        unidad_medida:       d.unidad_medida,
        cantidad_comprada:   comprado,
        ya_recibido:         yaRecibido,
        unidades_compradas: parseFloat(d.unidades) || null,
        precio_unitario:     parseFloat(d.precio_unitario) || 0,
        marca_default_id:    itemsMap[d.item_id]?.marca_id || null,
        recepciones
      })
    }

    // Prepara el modal en modo edición (mismo formulario de "Nueva Guía").
    const form = document.getElementById('formNuevaGuia')
    if (form) { /* no .reset(): se prellena a mano abajo */ }
    document.getElementById('ngNumeroGuia').value = guia.numero_guia || ''
    document.getElementById('ngFechaGuia').value = guia.fecha_guia || ''
    document.getElementById('ngObservaciones').value = guia.observaciones || ''

    const selCompra = document.getElementById('ngCompra')
    if (selCompra) {
      selCompra.innerHTML = `<option value="${compra?.id}" selected>${compra?.referencia || 'Compra #' + compra?.id} — ${compra?.proveedor_nombre || ''}</option>`
      selCompra.disabled = true
    }
    document.getElementById('ngInfoCompra').style.display = 'block'
    document.getElementById('ngInfoCompra').innerHTML = `
      <strong>Proveedor:</strong> ${compra?.proveedor_nombre || '-'} (${compra?.proveedor_ruc || '-'}) &nbsp;|&nbsp;
      <strong>Comprobante:</strong> ${compra?.serie ? compra.serie + '-' + compra.numero : (compra?.numero || '-')} &nbsp;|&nbsp;
      <strong>Fecha compra:</strong> ${compra?.fecha_emision || '-'}
    `

    const titulo = document.getElementById('ng-titulo-modal')
    if (titulo) titulo.textContent = `Editar Guía ${guia.numero_guia || ''}`
    const aviso = document.getElementById('ng-edicion-aviso')
    if (aviso) {
      aviso.style.display = 'block'
      aviso.textContent = '⚠ Editando una guía ya procesada: al guardar se revierte el stock/kardex que generó y se vuelve a aplicar con los valores corregidos. Bloqueado si algún lote de esta guía ya tuvo ventas.'
    }
    const btnGuardar = document.getElementById('btnGuardarGuiaIngresoCompra')
    if (btnGuardar) btnGuardar.textContent = 'Guardar Cambios (revierte y reaplica stock)'

    _guiaIngresoEditId = id

    _renderTablaDetalleGuia()
    window.openModal('modal-nueva-guia')
  } catch (error) {
    console.error('Error en editarGuiaIngreso:', error)
    showToast('No se puede editar esta guía: ' + error.message, 'danger', 7000)
  }
}

/**
 * Guarda la edición de líneas de una guía de ingreso ya existente:
 * revierte el stock/kardex/lotes que generó (mismo plan que eliminarla),
 * borra sus líneas viejas y las reaplica con los valores corregidos sobre
 * el MISMO id de guía. Se vuelve a calcular el plan de reversión justo
 * antes de escribir, por si algo cambió desde que se abrió el modal.
 */
async function _guardarEdicionGuiaIngreso() {
  const btn = document.getElementById('btnGuardarGuiaIngresoCompra')
  if (btn?.disabled) return
  if (btn) { btn.disabled = true; btn.textContent = 'Guardando...' }
  try {
    const id = _guiaIngresoEditId
    if (!id) { showToast('No hay ninguna guía en edición', 'danger'); return }

    const user = await getCurrentUser()
    if (!user) { showToast('Usuario no autenticado', 'danger'); return }

    const numeroGuia = document.getElementById('ngNumeroGuia')?.value?.trim()
    const fechaGuia = document.getElementById('ngFechaGuia')?.value
    const observaciones = document.getElementById('ngObservaciones')?.value?.trim() || null

    if (!numeroGuia) { showToast('Ingresa el N° de Guía', 'warning'); return }
    if (!fechaGuia)  { showToast('Ingresa la fecha de la guía', 'warning'); return }
    if (!_guiaLineas || _guiaLineas.length === 0) { showToast('No hay líneas para guardar', 'warning'); return }

    _sincronizarRecepcionesGuiaDesdeDOM()

    const guiaOriginal = await getGuiaIngresoCompraById(id)
    if (!guiaOriginal) { showToast('La guía ya no existe', 'danger'); return }
    const compraId = guiaOriginal.compra_id
    const compra = await getCompraById(compraId)

    const recepcionesValidadas = []
    for (const l of _guiaLineas) {
      for (const r of l.recepciones) {
        // Entrega parcial: este producto de la factura simplemente no llegó
        // en ESTA guía — se omite sin error (ver _esRecepcionVaciaGuia).
        if (_esRecepcionVaciaGuia(r)) continue
        if (!r.cantidad || r.cantidad <= 0) { showToast(`Cantidad recibida inválida para "${l.nombre}"`, 'warning'); return }
        if (!r.numero_lote)                 { showToast(`Falta el N° de Lote de "${l.nombre}"`, 'warning'); return }
        if (!r.marca_id)                    { showToast(`Falta la Marca de "${l.nombre}"`, 'warning'); return }
        if (!r.ubicacion_id)                { showToast(`Falta el Almacén/Zona de "${l.nombre}"`, 'warning'); return }
        // Ver misma validación (y su motivo) en window.guardarGuiaIngresoCompra.
        if (!r.es_peso_variable && (!r.cantidad_unidades || r.cantidad_unidades <= 0)) {
          showToast(`Falta el N° de Unidades (bultos/cajas) de "${l.nombre}"`, 'warning')
          return
        }

        recepcionesValidadas.push({
          detalle_compra_id: l.detalle_compra_id,
          item_id:           l.item_id,
          nombreProducto:    l.nombre,
          precio_unitario:   l.precio_unitario,
          unidadMedida:       l.unidad_medida || 'KG',
          cantidad:           r.cantidad,
          cantidadUnidades:   r.cantidad_unidades || null,
          numeroLote:         r.numero_lote,
          marcaId:            r.marca_id,
          codigoPartida:      (r.codigo_partida || '').trim() || null,
          ubicacionId:        r.ubicacion_id,
          esPesoVariable:     !!r.es_peso_variable,
          bultos:             r.es_peso_variable ? (r.bultos || []) : null,
          loteExistenteId:    null
        })
      }
    }

    if (recepcionesValidadas.length === 0) {
      showToast('Ingresa la cantidad recibida de al menos un producto', 'warning')
      return
    }

    // Re-verificación justo antes de escribir: si algo cambió desde que se
    // abrió el modal (ej. otra pestaña vendió stock de este mismo lote),
    // se bloquea recién aquí en vez de dejar el revertir a medias.
    const plan = await _planRevertirGuiaIngreso(id)

    // ── Punto sin retorno: a partir de aquí se escribe en la base ──────────
    await _aplicarReversionGuiaIngreso(id, plan)

    const idsLotesABorrarCompleto = [...plan.lotesABorrar, ...plan.lotesConBultosCompletos.map(l => l.lote.id)]
    for (const loteId of idsLotesABorrarCompleto) {
      const borrado = await deleteLote(loteId)
      if (!borrado) {
        const motivo = ultimoErrorDelete()
        console.error(`No se pudo eliminar el lote ${loteId} al editar la guía ${id}:`, motivo)
      }
    }

    // Líneas viejas de esta guía: se borran para reemplazarlas por las
    // reaplicadas abajo (a diferencia de eliminarGuia, aquí NO se borra la
    // guía — sigue siendo el mismo id, mismo historial de auditoría).
    const detallesViejos = await getDetalleGuiasIngresoCompra(id)
    for (const dv of (detallesViejos || [])) await deleteDetalleGuiaIngresoCompra(dv.id)

    const actualizadaCabecera = await updateGuiaIngresoCompra(id, {
      numero_guia: numeroGuia,
      fecha_guia: fechaGuia,
      observaciones
    })
    if (!actualizadaCabecera) { showToast('No se pudo actualizar la cabecera de la guía', 'danger'); return }

    const guia = { id, compra_id: compraId }
    const totalValorGuia = await _aplicarRecepcionesAGuiaIngreso(guia, compra, compraId, recepcionesValidadas, user, fechaGuia, numeroGuia)

    if (ASIENTOS_AUTO_COMPRAS_ACTIVO && totalValorGuia > 0.01) {
      try {
        await generarAsientoGuiaRemision({
          monto: totalValorGuia,
          documento_referencia: numeroGuia,
          descripcion: `Guía de Remisión - Edición (${numeroGuia})`,
          contact_id: compra?.contact_id || null,
          fecha: fechaGuia,
          userId: user?.id
        })
      } catch (errorAsiento) {
        console.error('Error generando asiento tras editar guía de ingreso:', errorAsiento)
        showToast(errorAsiento.message || 'Guía actualizada, pero no se pudo generar el asiento de valuación de inventario', 'warning')
      }
    }

    showToast('Guía actualizada: stock/kardex revertido y reaplicado', 'success')
    _guiaIngresoEditId = null
    window.closeModal('modal-nueva-guia')
    _guiaLineas = []
    _invalidarCacheCompras()
    await _cargarComprasConGuia(true)
    await renderGuias(true)
    await renderCompras(true)
  } catch (error) {
    console.error('Error en _guardarEdicionGuiaIngreso:', error)
    showToast('Error al guardar la edición: ' + error.message, 'danger', 7000)
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = _guiaIngresoEditId ? 'Guardar Cambios (revierte y reaplica stock)' : 'Guardar Guía (ingresa stock)' }
  }
}

// ── Selección múltiple ──────────────────────────────────────────────────────
// Las guías anuladas no entran: su stock ya se retiró al anularlas, y volver
// a revertirlo dejaría el inventario en negativo.

window.toggleSeleccionTodasGuias = function (checked) {
  document.querySelectorAll('.gi-sel:not(:disabled)').forEach(cb => { cb.checked = checked })
  window.actualizarBotonEliminarGuias()
}

window.actualizarBotonEliminarGuias = function () {
  const n = document.querySelectorAll('.gi-sel:checked').length
  const btn = document.getElementById('btnEliminarGuiasSel')
  if (!btn) return
  btn.style.display = n > 0 ? 'inline-flex' : 'none'
  btn.textContent = `🗑 Eliminar seleccionadas (${n})`
}

window.eliminarGuiasSeleccionadas = async function () {
  const ids = Array.from(document.querySelectorAll('.gi-sel:checked')).map(cb => parseInt(cb.value))
  if (ids.length === 0) { showToast('Selecciona al menos una guía', 'warning'); return }

  if (!confirm(
    `Se eliminarán ${ids.length} guía(s) de ingreso y se revertirá el stock que agregaron a Inventario.\n\n` +
    `Las guías cuyo stock ya se vendió NO se eliminarán y se te informará cuáles.\n\n` +
    `Esta acción no se puede deshacer. ¿Continuar?`
  )) return

  const btn = document.getElementById('btnEliminarGuiasSel')
  if (btn) { btn.disabled = true; btn.textContent = 'Eliminando...' }

  // El número de guía se resuelve ANTES de borrarla: después ya no existe y
  // el mensaje de error diría solo "#id", que no le sirve a nadie.
  const guias = await getGuiasIngresoCompra()
  const numeroPorId = new Map((guias || []).map(g => [g.id, g.numero_guia]))

  let ok = 0
  const errores = []
  for (const id of ids) {
    try {
      const r = await _eliminarGuiaIngresoCore(id, false)
      if (!r?.cancelado) ok++
    } catch (e) {
      console.error(`Error eliminando guía ${id}:`, e)
      errores.push(`${numeroPorId.get(id) || '#' + id}: ${e.message}`)
    }
  }

  if (ok > 0) showToast(`${ok} guía(s) eliminada(s): stock revertido en Inventario`, 'success')
  if (errores.length > 0) showToast(`${errores.length} no se pudo(eron) eliminar → ${errores.join(' | ')}`, 'danger', 10000)

  if (btn) { btn.disabled = false }
  _invalidarCacheCompras()
  await _cargarComprasConGuia(true)
  await renderGuias(true)
  await renderCompras(true)
}

window.abrirModalNuevaGuia = async function () {
  try {
    _guiaLineas = []
    _guiaIngresoEditId = null
    const form = document.getElementById('formNuevaGuia')
    if (form) form.reset()
    document.getElementById('ngInfoCompra').style.display = 'none'
    document.getElementById('ngFechaGuia').value = new Date().toISOString().split('T')[0]
    document.getElementById('tabla-detalle-guia').innerHTML =
      '<p style="text-align:center; color:var(--text-secondary); padding:20px;">Selecciona una compra para ver sus productos.</p>'

    const titulo = document.getElementById('ng-titulo-modal')
    if (titulo) titulo.textContent = 'Nueva Guía de Remisión'
    const aviso = document.getElementById('ng-edicion-aviso')
    if (aviso) aviso.style.display = 'none'
    const selCompra = document.getElementById('ngCompra')
    if (selCompra) selCompra.disabled = false
    const btnGuardar = document.getElementById('btnGuardarGuiaIngresoCompra')
    if (btnGuardar) btnGuardar.textContent = 'Guardar Guía (ingresa stock)'

    await _cargarComprasSelectGuia()
    window.openModal('modal-nueva-guia')
  } catch (error) {
    console.error('Error en abrirModalNuevaGuia:', error)
    showToast('Error al abrir el formulario de guía', 'danger')
  }
}

// Cuánto se ha recibido ya, por línea de compra (detalle_compra_id), sumando
// TODAS las guías NO anuladas de esa línea (una compra puede recibirse en
// varias guías parciales). Se usa tanto para decidir qué compras siguen
// "pendientes de guía" como para prellenar cada recepción con lo que falta,
// no con el total comprado de nuevo.
async function _getCantidadesRecibidasPorDetalle() {
  const [guias, detallesGuia] = await Promise.all([
    getGuiasIngresoCompra(),
    getTodosDetalleGuiasIngresoCompra()
  ])
  const guiaAnulada = new Map((guias || []).map(g => [g.id, g.estado === 'anulada']))
  const acumulado = new Map() // detalle_compra_id -> cantidad recibida
  for (const dg of (detallesGuia || [])) {
    if (!dg.detalle_compra_id || guiaAnulada.get(dg.guia_id)) continue
    acumulado.set(dg.detalle_compra_id, (acumulado.get(dg.detalle_compra_id) || 0) + (parseFloat(dg.cantidad) || 0))
  }
  return acumulado
}

async function _cargarComprasSelectGuia() {
  const select = document.getElementById('ngCompra')
  if (!select) return

  // Solo compras de mercadería con algo pendiente de recibir: se compara,
  // línea por línea (detalle_compras.cantidad), lo comprado contra lo ya
  // recibido en TODAS sus guías no anuladas. Antes se ocultaba la compra con
  // la primera guía aunque fuera parcial — ahora sigue apareciendo hasta que
  // TODAS sus líneas queden cubiertas.
  const [{ data: compras }, todosDetalles, recibidoPorDetalle] = await Promise.all([
    getComprasPage({ pagina: 1, porPagina: 500 }),
    getTodosDetalleCompras(),
    _getCantidadesRecibidasPorDetalle()
  ])

  const detallesPorCompra = new Map()
  for (const d of (todosDetalles || [])) {
    if (!detallesPorCompra.has(d.compra_id)) detallesPorCompra.set(d.compra_id, [])
    detallesPorCompra.get(d.compra_id).push(d)
  }

  const tienePendiente = (compraId) => {
    const detalles = detallesPorCompra.get(compraId) || []
    if (detalles.length === 0) return true // sin líneas registradas: se muestra por seguridad
    return detalles.some(d => {
      const comprado = parseFloat(d.cantidad) || 0
      const recibido = recibidoPorDetalle.get(d.id) || 0
      return recibido + 0.0001 < comprado
    })
  }

  _guiaComprasCache = (compras || []).filter(c => c.tipo_compra === 'mercaderia' && tienePendiente(c.id))

  select.innerHTML = '<option value="">-- Selecciona una compra registrada --</option>' +
    _guiaComprasCache.map(c =>
      `<option value="${c.id}">${c.referencia} — ${c.proveedor_nombre} (${c.fecha_emision})</option>`
    ).join('')
  refrescarBuscador(select)
}

let _guiaMarcasCache = []
let _guiaZonasCache = []   // [{id, nombre, almacen_id, almacenNombre}]
let _guiaLotesPorItem = {} // item_id -> [lotes existentes], para el datalist del N° de Lote
let _guiaZonasNombre = {}  // ubicacion_id -> "Almacén — Zona"
let _guiaCompraActual = null // compra elegida en el modal (para comparar costos)

window.onSeleccionarCompraGuia = async function () {
  try {
    const compraId = parseInt(document.getElementById('ngCompra')?.value || 0)
    const infoDiv = document.getElementById('ngInfoCompra')
    const tablaDiv = document.getElementById('tabla-detalle-guia')

    if (!compraId) {
      infoDiv.style.display = 'none'
      tablaDiv.innerHTML = '<p style="text-align:center; color:var(--text-secondary); padding:20px;">Selecciona una compra para ver sus productos.</p>'
      _guiaLineas = []
      return
    }

    const [compra, detalles, marcas, itemsList, almacenes, zonas] = await Promise.all([
      getCompraById(compraId),
      getCompraDetalles(compraId),
      getMarcas(),
      getItems(),
      getAlmacenes(),
      getUbicaciones()
    ])

    infoDiv.style.display = 'block'
    infoDiv.innerHTML = `
      <strong>Proveedor:</strong> ${compra?.proveedor_nombre || '-'} (${compra?.proveedor_ruc || '-'}) &nbsp;|&nbsp;
      <strong>Comprobante:</strong> ${compra?.serie ? compra.serie + '-' + compra.numero : (compra?.numero || '-')} &nbsp;|&nbsp;
      <strong>Fecha compra:</strong> ${compra?.fecha_emision || '-'}
    `

    const itemsMap = {}
    for (const it of (itemsList || [])) itemsMap[it.id] = it

    const almacenesMap = {}
    for (const a of (almacenes || [])) almacenesMap[a.id] = a

    _guiaMarcasCache = marcas || []
    // Las zonas virtuales (Partners/Vendors, Partners/Customers) son solo
    // para el Kardex — nunca un destino real de recepción de mercadería.
    _guiaZonasCache = (zonas || [])
      .filter(z => !almacenesMap[z.almacen_id]?.es_virtual)
      .map(z => ({
        id: z.id,
        nombre: z.nombre,
        almacen_id: z.almacen_id,
        almacenNombre: almacenesMap[z.almacen_id]?.nombre || `Almacén #${z.almacen_id}`
      }))

    // Lotes YA existentes de cada producto: se ofrecen en el campo "N° de
    // Lote" para poder recibir más mercadería sobre un lote abierto de ESTA
    // MISMA compra. Si el texto coincide pero es de otra compra (factura
    // distinta), no se ofrece para sumar — se crea aparte, a propósito:
    // identificación específica por adquisición, no por texto de lote.
    _guiaCompraActual = await getCompraById(compraId)
    const lotesExistentes = await getLotes()
    _guiaLotesPorItem = {}
    for (const lo of (lotesExistentes || [])) {
      if (!lo.item_id) continue
      ;(_guiaLotesPorItem[lo.item_id] = _guiaLotesPorItem[lo.item_id] || []).push(lo)
    }
    // Más recientes primero: el lote que se está recibiendo suele ser el último.
    Object.values(_guiaLotesPorItem).forEach(arr =>
      arr.sort((a, b) => (b.fecha_ingreso || '').localeCompare(a.fecha_ingreso || '') || b.id - a.id))

    _guiaZonasNombre = {}
    for (const z of _guiaZonasCache) _guiaZonasNombre[z.id] = `${z.almacenNombre} — ${z.nombre}`

    // Lo ya recibido en OTRAS guías (no anuladas) de esta misma compra: la
    // recepción arranca prellenada con lo PENDIENTE, no con el total
    // comprado de nuevo — si no, cada guía parcial adicional invitaría a
    // recibir el pedido entero otra vez por error.
    const recibidoPorDetalle = await _getCantidadesRecibidasPorDetalle()

    _guiaLineas = (detalles || []).map(d => {
      const marcaDefault = itemsMap[d.item_id]?.marca_id || null
      const comprado = parseFloat(d.cantidad) || 0
      const yaRecibido = parseFloat((recibidoPorDetalle.get(d.id) || 0).toFixed(4))
      const pendiente = parseFloat(Math.max(0, comprado - yaRecibido).toFixed(4))
      return {
        detalle_compra_id: d.id,
        item_id:            d.item_id,
        nombre:              itemsMap[d.item_id]?.nombre || `Item #${d.item_id}`,
        unidad_medida:       d.unidad_medida,
        cantidad_comprada:   comprado,
        ya_recibido:         yaRecibido,
        unidades_compradas: parseFloat(d.unidades) || null,
        precio_unitario:     parseFloat(d.precio_unitario) || 0,
        marca_default_id:    marcaDefault,
        // Una línea comprada puede recibirse en 1 o más lotes/zonas distintos
        // (ej: 1000kg llegan repartidos en 2 lotes), y también en más de una
        // guía si la entrega llega incompleta. Se arranca con 1 recepción
        // precargada con lo PENDIENTE (si hay más de una recepción, el
        // usuario debe repartir el N° de unidades entre ellas manualmente).
        recepciones: [
          {
            cantidad: pendiente,
            numero_lote: '',
            marca_id: marcaDefault,
            codigo_partida: '', // texto libre y opcional: agrupa lotes de esta misma guía (no es Partida Arancelaria)
            ubicacion_id: '',
            cantidad_unidades: null,
            es_peso_variable: false,
            bultos: []   // packing list: peso individual por bulto cuando es_peso_variable=true
          }
        ]
      }
    })

    _renderTablaDetalleGuia()
  } catch (error) {
    console.error('Error en onSeleccionarCompraGuia:', error)
    showToast('Error al cargar el detalle de la compra', 'danger')
  }
}

// Antes de re-renderizar (agregar/quitar una recepción), se leen los
// valores actuales de los inputs de vuelta al estado _guiaLineas, para no
// perder lo que el usuario ya escribió.
function _sincronizarRecepcionesGuiaDesdeDOM() {
  _guiaLineas.forEach((l, idx) => {
    l.recepciones.forEach((r, subIdx) => {
      const cant = document.getElementById(`gc-${idx}-${subIdx}-cantidad`)
      const cantUnid = document.getElementById(`gc-${idx}-${subIdx}-unidades`)
      const lote = document.getElementById(`gc-${idx}-${subIdx}-lote`)
      const marca = document.getElementById(`gc-${idx}-${subIdx}-marca`)
      const codigoPartida = document.getElementById(`gc-${idx}-${subIdx}-codigopartida`)
      const zona = document.getElementById(`gc-${idx}-${subIdx}-zona`)
      const pesoVar = document.getElementById(`gc-${idx}-${subIdx}-pesovariable`)
      if (cant)    r.cantidad = parseFloat(cant.value || 0)
      if (cantUnid) r.cantidad_unidades = parseFloat(cantUnid.value || 0) || null
      if (lote)    r.numero_lote = lote.value?.trim() || ''
      if (marca)   r.marca_id = parseInt(marca.value || 0) || null
      if (codigoPartida) r.codigo_partida = codigoPartida.value?.trim() || ''
      if (zona)    r.ubicacion_id = parseInt(zona.value || 0) || null
      if (pesoVar) r.es_peso_variable = !!pesoVar.checked
      if (r.es_peso_variable && Array.isArray(r.bultos)) {
        r.bultos.forEach((b, bIdx) => {
          const inp = document.getElementById(`gc-${idx}-${subIdx}-bulto-${bIdx}`)
          if (inp) b.peso = parseFloat(inp.value || 0) || null
        })
      }
    })
  })
}

/** Una recepción "vacía" = el usuario no la tocó (o borró lo que traía
 * precargado) porque ese producto de la factura NO llegó en ESTA guía —
 * normal en una importación/entrega parcial (ej. factura con 2 artículos,
 * llega solo 1 primero). Se omite en silencio en vez de bloquear el guardado
 * con "Cantidad recibida inválida": el producto queda pendiente para una
 * guía posterior, igual que si nunca se hubiera agregado esa fila. Solo si
 * el usuario alcanzó a llenar ALGÚN otro campo (lote, marca, zona, unidades)
 * pero dejó la cantidad en 0 se sigue tratando como error real, para no
 * tragarse un dato a medio llenar por accidente. */
function _esRecepcionVaciaGuia(r) {
  const cantidadVacia = !r.cantidad || r.cantidad <= 0
  const restoVacio = !r.numero_lote && !r.marca_id && !r.ubicacion_id && !r.cantidad_unidades &&
    !(Array.isArray(r.bultos) && r.bultos.some(b => (parseFloat(b.peso) || 0) > 0))
  return cantidadVacia && restoVacio
}

window.agregarRecepcionGuia = function (idx) {
  _sincronizarRecepcionesGuiaDesdeDOM()
  const l = _guiaLineas[idx]
  if (!l) return
  l.recepciones.push({ cantidad: 0, numero_lote: '', marca_id: l.marca_default_id, codigo_partida: '', ubicacion_id: '', cantidad_unidades: null, es_peso_variable: false, bultos: [] })
  _renderTablaDetalleGuia()
}

window.quitarRecepcionGuia = function (idx, subIdx) {
  _sincronizarRecepcionesGuiaDesdeDOM()
  const l = _guiaLineas[idx]
  if (!l) return
  l.recepciones.splice(subIdx, 1)
  if (l.recepciones.length === 0) {
    l.recepciones.push({ cantidad: l.cantidad_comprada, numero_lote: '', marca_id: l.marca_default_id, codigo_partida: '', ubicacion_id: '', cantidad_unidades: l.unidades_compradas, es_peso_variable: false, bultos: [] })
  }
  _renderTablaDetalleGuia()
}

window.toggleSeleccionTodasGuia = function (idx, marcarTodas) {
  const l = _guiaLineas[idx]
  if (!l) return
  l.recepciones.forEach((r, subIdx) => {
    const chk = document.getElementById(`gc-${idx}-${subIdx}-sel`)
    if (chk) chk.checked = marcarTodas
  })
}

// Edición masiva: aplica Marca / Partida / Zona a las filas marcadas con
// checkbox dentro de UN mismo producto (no re-renderiza toda la tabla, solo
// pisa los <select>/<input> de las filas seleccionadas, para no perder lo
// que el usuario ya escribió en otras filas). N° de Lote y Cantidad quedan
// fuera a propósito: son datos únicos por fila, no tiene sentido copiarlos.
window.aplicarEdicionMasivaGuia = function (idx) {
  const l = _guiaLineas[idx]
  if (!l) return

  const marcaVal = document.getElementById(`gm-${idx}-marca`)?.value || ''
  const partidaVal = document.getElementById(`gm-${idx}-partida`)?.value?.trim() || ''
  const zonaVal = document.getElementById(`gm-${idx}-zona`)?.value || ''

  if (!marcaVal && !partidaVal && !zonaVal) {
    showToast('Elige al menos un valor (Marca, Partida o Zona) para aplicar', 'warning')
    return
  }

  let filasAfectadas = 0
  l.recepciones.forEach((r, subIdx) => {
    const chk = document.getElementById(`gc-${idx}-${subIdx}-sel`)
    if (!chk?.checked) return
    filasAfectadas++

    if (marcaVal) {
      r.marca_id = parseInt(marcaVal)
      const marcaEl = document.getElementById(`gc-${idx}-${subIdx}-marca`)
      if (marcaEl) marcaEl.value = marcaVal
    }
    if (partidaVal) {
      r.codigo_partida = partidaVal
      const partidaEl = document.getElementById(`gc-${idx}-${subIdx}-codigopartida`)
      if (partidaEl) partidaEl.value = partidaVal
    }
    if (zonaVal) {
      r.ubicacion_id = parseInt(zonaVal)
      const zonaEl = document.getElementById(`gc-${idx}-${subIdx}-zona`)
      if (zonaEl) zonaEl.value = zonaVal
    }
  })

  if (filasAfectadas === 0) {
    showToast('No hay filas seleccionadas', 'warning')
    return
  }
  showToast(`Aplicado a ${filasAfectadas} fila(s)`, 'success')
}

function _renderTablaDetalleGuia() {
  const container = document.getElementById('tabla-detalle-guia')
  if (!container) return

  if (!_guiaLineas || _guiaLineas.length === 0) {
    container.innerHTML = '<p style="text-align:center; color:var(--text-secondary); padding:20px;">Esta compra no tiene productos en su detalle.</p>'
    return
  }

  const marcaOptions = (_guiaMarcasCache || []).map(m => `<option value="${m.id}">${m.nombre}</option>`).join('')
  const zonaOptions = (_guiaZonasCache || [])
    .map(z => `<option value="${z.id}">${z.almacenNombre} — ${z.nombre}</option>`).join('')

  let html = ''
  _guiaLineas.forEach((l, idx) => {
    const totalRecibido = l.recepciones.reduce((s, r) => s + (parseFloat(r.cantidad) || 0), 0)
    // Verde cuando esta guía completa exactamente lo PENDIENTE (comprado
    // menos lo ya recibido en otras guías) — no lo comprado total, que ya no
    // es la referencia correcta a partir de la segunda guía parcial.
    const pendienteLinea = parseFloat(Math.max(0, l.cantidad_comprada - (l.ya_recibido || 0)).toFixed(4))
    const colorTotal = Math.abs(totalRecibido - pendienteLinea) < 0.0001 ? 'var(--color-success)' : 'var(--color-warning)'
    const infoYaRecibido = l.ya_recibido > 0
      ? `Ya recibido: ${formatQty(l.ya_recibido)} &nbsp;|&nbsp; Pendiente: ${formatQty(pendienteLinea)} &nbsp;|&nbsp; `
      : ''

    html += `
      <div style="border:1px solid var(--border-color); border-radius:var(--radius-md); margin-bottom:14px; padding:12px;">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
          <strong>${l.nombre}</strong>
          <span style="font-size:0.85rem;">
            Comprado: ${formatQty(l.cantidad_comprada)} ${l.unidad_medida || ''} &nbsp;|&nbsp;
            ${infoYaRecibido}
            Recibiendo: <strong style="color:${colorTotal};">${formatQty(totalRecibido)}</strong>
          </span>
        </div>
        ${l.recepciones.length > 1 ? `
        <div style="display:flex; flex-wrap:wrap; align-items:end; gap:10px; margin-bottom:8px; padding:8px 10px; background:var(--bg-secondary); border-radius:var(--radius-sm);">
          <div style="font-size:0.78rem; color:var(--text-secondary); align-self:center;">Editar filas seleccionadas:</div>
          <div>
            <label style="font-size:0.72rem; display:block; color:var(--text-secondary);">Marca</label>
            <select id="gm-${idx}-marca" style="min-width:110px;"><option value="">-- Sin cambio --</option>${marcaOptions}</select>
          </div>
          <div>
            <label style="font-size:0.72rem; display:block; color:var(--text-secondary);">Partida</label>
            <input type="text" id="gm-${idx}-partida" placeholder="Ej: LT.26027" style="width:120px;">
          </div>
          <div>
            <label style="font-size:0.72rem; display:block; color:var(--text-secondary);">Almacén / Zona</label>
            <select id="gm-${idx}-zona" style="min-width:160px;"><option value="">-- Sin cambio --</option>${zonaOptions}</select>
          </div>
          <button type="button" class="btn btn-small btn-secondary" onclick="window.aplicarEdicionMasivaGuia(${idx})">Aplicar a seleccionadas</button>
        </div>
        ` : ''}
        <datalist id="lotes-item-${l.item_id}">
          ${(_guiaLotesPorItem[l.item_id] || []).map(lo =>
            `<option value="${_escCompras(lo.numero_lote || '')}">${(parseFloat(lo.cantidad) || 0).toLocaleString('en-US', { maximumFractionDigits: 2 })} ${lo.unidad_medida || 'KG'} · costo ${(parseFloat(lo.costo_unitario) || 0).toFixed(4)}</option>`
          ).join('')}
        </datalist>
        <div style="overflow-x:auto;">
        <table style="min-width:920px;">
          <thead>
            <tr>
              ${l.recepciones.length > 1 ? `<th><input type="checkbox" id="gsel-${idx}-all" title="Seleccionar todas" onchange="window.toggleSeleccionTodasGuia(${idx}, this.checked)"></th>` : ''}
              <th>Cantidad (${l.unidad_medida || 'KG'}) *</th><th title="Obligatorio salvo cuando 'Peso Variable' está marcado (ahí se calcula solo del packing list). Sin esto el lote no puede calcular su peso por unidad.">N° de Unidades *</th>
              <th title="Marca el peso por unidad como aproximado (no exacto). Se usa al vender para saber si pedir unidades exactas o dejarlas estimadas.">Peso Variable</th>
              <th>N° de Lote *</th><th>Marca *</th>
              <th>Partida <span style="font-weight:400; color:var(--text-secondary);" title="Código que agrupa varios lotes de esta misma guía (ej. varios lotes 'LT.26027-01, -02, -03...' comparten la partida 'LT.26027'). Opcional.">(opcional)</span></th>
              <th>Almacén / Zona *</th><th></th>
            </tr>
          </thead>
          <tbody>
    `
    const colspanBultos = l.recepciones.length > 1 ? 8 : 7
    l.recepciones.forEach((r, subIdx) => {
      const soloLecturaCantidad = r.es_peso_variable ? 'readonly style="width:100px; background:var(--bg-secondary);" title="Se calcula solo del detalle de bultos de abajo"' : 'style="width:100px;"'
      const soloLecturaUnidades = r.es_peso_variable ? 'readonly style="width:90px; background:var(--bg-secondary);" title="Se calcula solo del detalle de bultos de abajo"' : 'style="width:90px;"'
      html += `
        <tr>
          ${l.recepciones.length > 1 ? `<td><input type="checkbox" id="gc-${idx}-${subIdx}-sel"></td>` : ''}
          <td><input type="number" id="gc-${idx}-${subIdx}-cantidad" value="${r.cantidad}" step="0.01" min="0" ${soloLecturaCantidad}></td>
          <td><input type="number" id="gc-${idx}-${subIdx}-unidades" value="${r.cantidad_unidades ?? ''}" placeholder="Ej: 10" step="1" min="0" ${soloLecturaUnidades}></td>
          <td style="text-align:center;"><input type="checkbox" id="gc-${idx}-${subIdx}-pesovariable" ${r.es_peso_variable ? 'checked' : ''}></td>
          <td>
            <input type="text" id="gc-${idx}-${subIdx}-lote" value="${r.numero_lote}" placeholder="Nuevo o existente..."
                   list="lotes-item-${l.item_id}" autocomplete="off" style="width:150px;">
            <div id="gc-${idx}-${subIdx}-loteaviso" class="lote-aviso"></div>
          </td>
          <td><select id="gc-${idx}-${subIdx}-marca" style="min-width:110px;">
                <option value="">-- Selecciona --</option>${marcaOptions}
              </select></td>
          <td><input type="text" id="gc-${idx}-${subIdx}-codigopartida" value="${r.codigo_partida || ''}" placeholder="Ej: LT.26027" style="width:120px;"></td>
          <td><select id="gc-${idx}-${subIdx}-zona" style="min-width:160px;">
                <option value="">-- Selecciona --</option>${zonaOptions}
              </select></td>
          <td>${l.recepciones.length > 1 ? `<button type="button" class="btn btn-small btn-danger" onclick="window.quitarRecepcionGuia(${idx}, ${subIdx})">✕</button>` : ''}</td>
        </tr>
      `
      if (r.es_peso_variable) {
        // Packing list de esta recepción: peso individual por bulto/caja.
        // cantidad y cantidad_unidades de arriba se recalculan solos desde
        // esta lista (ver _sincronizarCantidadDesdeBultos) — nunca se
        // escriben a mano cuando el producto es peso variable.
        if (!Array.isArray(r.bultos) || r.bultos.length === 0) r.bultos = [{ peso: null }]
        const sumaBultos = r.bultos.reduce((s, b) => s + (parseFloat(b.peso) || 0), 0)
        html += `
        <tr>
          <td colspan="${colspanBultos}" style="background:var(--bg-secondary); padding:10px 14px;">
            <div style="font-size:0.78rem; color:var(--text-secondary); margin-bottom:6px;">
              📦 Packing list — peso por bulto (${l.unidad_medida || 'KG'}). Total:
              <strong id="gc-${idx}-${subIdx}-bultostotal">${sumaBultos.toFixed(2)}</strong>
              en <strong>${r.bultos.length}</strong> bulto(s).
            </div>
            <div style="display:flex; flex-wrap:wrap; gap:8px;">
              ${r.bultos.map((b, bIdx) => `
                <div style="display:flex; align-items:center; gap:4px;">
                  <input type="number" id="gc-${idx}-${subIdx}-bulto-${bIdx}" value="${b.peso ?? ''}"
                         placeholder="Bulto ${bIdx + 1}" step="0.01" min="0" style="width:90px;">
                  ${r.bultos.length > 1 ? `<button type="button" class="btn btn-small btn-danger" onclick="window.quitarBultoGuia(${idx},${subIdx},${bIdx})">✕</button>` : ''}
                </div>
              `).join('')}
            </div>
            <button type="button" class="btn btn-small btn-secondary" style="margin-top:8px;" onclick="window.agregarBultoGuia(${idx},${subIdx})">+ Agregar bulto</button>
          </td>
        </tr>
        `
      }
    })
    html += `
          </tbody>
        </table>
        </div>
        <button type="button" class="btn btn-small btn-secondary" style="margin-top:6px;" onclick="window.agregarRecepcionGuia(${idx})">+ Agregar otro lote/zona para este producto</button>
      </div>
    `
  })

  // Resumen general de la guía (mismo formato de tarjetas que "Detalles de
  // Productos" en Nueva Compra): totales agregados de TODAS las líneas y
  // recepciones, con separador de miles.
  const cantidadTotalGuia = _guiaLineas.reduce((s, l) =>
    s + l.recepciones.reduce((s2, r) => s2 + (parseFloat(r.cantidad) || 0), 0), 0)
  const unidadesTotalGuia = _guiaLineas.reduce((s, l) =>
    s + l.recepciones.reduce((s2, r) => s2 + (parseFloat(r.cantidad_unidades) || 0), 0), 0)
  const lotesTotalGuia = _guiaLineas.reduce((s, l) =>
    s + l.recepciones.filter(r => (r.numero_lote || '').trim()).length, 0)

  html += `
    <div style="margin-top:10px; padding: 15px; background-color: var(--bg-secondary); border-radius: var(--radius-md); display: grid; grid-template-columns: repeat(3, 1fr); gap: 15px;">
      <div style="text-align: center;">
        <div style="font-size: 12px; color: var(--text-secondary);">Cantidad Total</div>
        <div style="font-size: 18px; font-weight: 600; color: var(--text-primary);" id="guiaTotalCantidad">${cantidadTotalGuia.toLocaleString('en-US', { maximumFractionDigits: 2 })}</div>
      </div>
      <div style="text-align: center;">
        <div style="font-size: 12px; color: var(--text-secondary);">N° Total Unidades</div>
        <div style="font-size: 18px; font-weight: 600; color: var(--text-primary);" id="guiaTotalUnidades">${unidadesTotalGuia.toLocaleString('en-US', { maximumFractionDigits: 2 })}</div>
      </div>
      <div style="text-align: center;">
        <div style="font-size: 12px; color: var(--text-secondary);">N° Total de Lotes</div>
        <div style="font-size: 18px; font-weight: 600; color: var(--text-primary);" id="guiaTotalLotes">${lotesTotalGuia.toLocaleString('en-US')}</div>
      </div>
    </div>
  `

  container.innerHTML = html

  // Preseleccionar marca/valores guardados en el estado (incluye la marca
  // default del producto y lo que el usuario ya había escrito antes de
  // agregar/quitar una recepción).
  _guiaLineas.forEach((l, idx) => {
    l.recepciones.forEach((r, subIdx) => {
      const cant = document.getElementById(`gc-${idx}-${subIdx}-cantidad`)
      const cantUnid = document.getElementById(`gc-${idx}-${subIdx}-unidades`)
      const lote = document.getElementById(`gc-${idx}-${subIdx}-lote`)
      const marca = document.getElementById(`gc-${idx}-${subIdx}-marca`)
      const codigoPartida = document.getElementById(`gc-${idx}-${subIdx}-codigopartida`)
      const zona = document.getElementById(`gc-${idx}-${subIdx}-zona`)
      const pesoVar = document.getElementById(`gc-${idx}-${subIdx}-pesovariable`)
      if (cant)  cant.value = r.cantidad
      if (cantUnid) cantUnid.value = r.cantidad_unidades ?? ''
      if (lote)  lote.value = r.numero_lote
      if (marca && r.marca_id) marca.value = r.marca_id
      if (codigoPartida) codigoPartida.value = r.codigo_partida || ''
      if (zona && r.ubicacion_id) zona.value = r.ubicacion_id
      if (pesoVar) pesoVar.checked = !!r.es_peso_variable

      // Mismo estándar de buscador con filtrado en vivo que Ventas y
      // Traslado Interno de Inventario — estos selects se recrean enteros en
      // cada render (container.innerHTML = html arriba), así que se vuelven
      // a envolver cada vez sobre el <select> nuevo.
      if (marca) { convertirEnBuscador(marca, { placeholder: 'Escribe la marca...', sinResultados: 'Sin marcas' }); refrescarBuscador(marca) }
      if (zona)  { convertirEnBuscador(zona,  { placeholder: 'Escribe el almacén o zona...', sinResultados: 'Sin zonas' }); refrescarBuscador(zona) }

      // Cuando es peso variable, cantidad/unidades son de solo lectura
      // (se calculan del packing list de abajo) — no se les pone listener
      // de edición manual.
      if (!r.es_peso_variable) {
        cant?.addEventListener('input', () => { r.cantidad = parseFloat(cant.value || 0); _actualizarTotalesRecepcionGuia() })
        cantUnid?.addEventListener('input', () => { r.cantidad_unidades = parseFloat(cantUnid.value || 0) || null; _actualizarTotalesRecepcionGuia() })
      }
      lote?.addEventListener('input', () => {
        r.numero_lote = lote.value?.trim() || ''
        _avisarLoteExistente(idx, subIdx, l, r)
        _actualizarTotalesRecepcionGuia()
      })
      _avisarLoteExistente(idx, subIdx, l, r)
      codigoPartida?.addEventListener('input', () => { r.codigo_partida = codigoPartida.value?.trim() || '' })
      pesoVar?.addEventListener('change', () => {
        r.es_peso_variable = !!pesoVar.checked
        if (r.es_peso_variable && (!Array.isArray(r.bultos) || r.bultos.length === 0)) r.bultos = [{ peso: null }]
        _renderTablaDetalleGuia()
      })

      // Packing list: un input por bulto, cada uno recalcula cantidad/unidades.
      if (r.es_peso_variable && Array.isArray(r.bultos)) {
        r.bultos.forEach((b, bIdx) => {
          const bultoInp = document.getElementById(`gc-${idx}-${subIdx}-bulto-${bIdx}`)
          bultoInp?.addEventListener('input', () => {
            b.peso = parseFloat(bultoInp.value || 0) || null
            _sincronizarCantidadDesdeBultos(idx, subIdx)
          })
        })
      }
    })
  })
}

/**
 * Recalcula r.cantidad (suma de pesos) y r.cantidad_unidades (conteo de
 * bultos con peso > 0) desde el packing list, y refleja el resultado en los
 * inputs de solo-lectura de Cantidad/N° de Unidades sin re-renderizar toda
 * la tabla (evita perder el foco del input de peso que se está tecleando).
 */
function _sincronizarCantidadDesdeBultos(idx, subIdx) {
  const l = _guiaLineas[idx]
  const r = l?.recepciones?.[subIdx]
  if (!r || !Array.isArray(r.bultos)) return

  const bultosConPeso = r.bultos.filter(b => (parseFloat(b.peso) || 0) > 0)
  r.cantidad = parseFloat(bultosConPeso.reduce((s, b) => s + (parseFloat(b.peso) || 0), 0).toFixed(4))
  r.cantidad_unidades = bultosConPeso.length

  const cant = document.getElementById(`gc-${idx}-${subIdx}-cantidad`)
  const cantUnid = document.getElementById(`gc-${idx}-${subIdx}-unidades`)
  const total = document.getElementById(`gc-${idx}-${subIdx}-bultostotal`)
  if (cant) cant.value = r.cantidad
  if (cantUnid) cantUnid.value = r.cantidad_unidades
  if (total) total.textContent = r.cantidad.toFixed(2)
  _actualizarTotalesRecepcionGuia()
}

window.agregarBultoGuia = function (idx, subIdx) {
  _sincronizarRecepcionesGuiaDesdeDOM()
  const r = _guiaLineas[idx]?.recepciones?.[subIdx]
  if (!r) return
  if (!Array.isArray(r.bultos)) r.bultos = []
  r.bultos.push({ peso: null })
  _renderTablaDetalleGuia()
}

window.quitarBultoGuia = function (idx, subIdx, bultoIdx) {
  _sincronizarRecepcionesGuiaDesdeDOM()
  const r = _guiaLineas[idx]?.recepciones?.[subIdx]
  if (!r || !Array.isArray(r.bultos)) return
  r.bultos.splice(bultoIdx, 1)
  if (r.bultos.length === 0) r.bultos.push({ peso: null })
  _sincronizarCantidadDesdeBultos(idx, subIdx)
  _renderTablaDetalleGuia()
}

// Actualiza en vivo el "Recibiendo: X" de cada línea sin re-renderizar toda
// la tabla (evita perder el foco del input mientras se escribe).
function _actualizarTotalesRecepcionGuia() {
  // Sincroniza el DOM al estado y vuelve a pintar (simple y suficiente
  // para este volumen de filas).
  _sincronizarRecepcionesGuiaDesdeDOM()
  const spans = document.querySelectorAll('#tabla-detalle-guia > div')
  _guiaLineas.forEach((l, idx) => {
    const totalRecibido = l.recepciones.reduce((s, r) => s + (parseFloat(r.cantidad) || 0), 0)
    const el = spans[idx]?.querySelector('strong[style]')
    if (el) el.textContent = totalRecibido.toLocaleString('en-US', { maximumFractionDigits: 2 })
  })

  const elCant = document.getElementById('guiaTotalCantidad')
  const elUnid = document.getElementById('guiaTotalUnidades')
  if (elCant) {
    const cantidadTotalGuia = _guiaLineas.reduce((s, l) =>
      s + l.recepciones.reduce((s2, r) => s2 + (parseFloat(r.cantidad) || 0), 0), 0)
    elCant.textContent = cantidadTotalGuia.toLocaleString('en-US', { maximumFractionDigits: 2 })
  }
  if (elUnid) {
    const unidadesTotalGuia = _guiaLineas.reduce((s, l) =>
      s + l.recepciones.reduce((s2, r) => s2 + (parseFloat(r.cantidad_unidades) || 0), 0), 0)
    elUnid.textContent = unidadesTotalGuia.toLocaleString('en-US', { maximumFractionDigits: 2 })
  }
  const elLotes = document.getElementById('guiaTotalLotes')
  if (elLotes) {
    const lotesTotalGuia = _guiaLineas.reduce((s, l) =>
      s + l.recepciones.filter(r => (r.numero_lote || '').trim()).length, 0)
    elLotes.textContent = lotesTotalGuia.toLocaleString('en-US')
  }
}

window.cerrarModalNuevaGuia = function () {
  // Si ya eligió una compra o escribió algo, cerrar sin avisar perdería el
  // trabajo (compra seleccionada + lote/marca/zona por línea ya tipeados).
  const compraId     = document.getElementById('ngCompra')?.value
  const numeroGuia    = document.getElementById('ngNumeroGuia')?.value?.trim()
  const observaciones = document.getElementById('ngObservaciones')?.value?.trim()
  const hayEdicion = !!compraId || !!numeroGuia || !!observaciones
  if (hayEdicion && !confirm('Vas a perder los datos ingresados en esta guía. ¿Cerrar de todas formas?')) return
  _guiaIngresoEditId = null
  window.closeModal('modal-nueva-guia')
}

/**
 * Aplica una lista de recepciones YA VALIDADAS a una guía de ingreso: crea o
 * suma lotes (promedio ponderado si el lote ya existía), actualiza
 * stock_ubicaciones, inserta el movimiento de entrada en Kardex, registra
 * bultos si aplica (peso variable), y crea la línea en
 * detalle_guias_ingreso_compra. Reusado por window.guardarGuiaIngresoCompra
 * (guía nueva) y window.guardarEdicionGuiaIngreso (revertir + reaplicar).
 * @returns {number} totalValorGuia — para el asiento de valuación de inventario.
 */
async function _aplicarRecepcionesAGuiaIngreso(guia, compra, compraId, recepcionesValidadas, user, fechaGuia, numeroGuia) {
  // Ubicación virtual "Partners/Vendors": origen de TODO ingreso por
  // compra en el Kardex (el proveedor es externo, no una zona real de
  // tu almacén). Se resuelve una sola vez para toda la guía.
  const vendorsZona = await getUbicacionVendors()
  let totalValorGuia = 0

  for (const l of recepcionesValidadas) {
    // Peso por unidad = cantidad total (peso/medida) / N° de unidades
    // físicas (bultos/cajas). cantidad_unidades es OPCIONAL y NUNCA debe
    // igualarse a cantidad — son dos dimensiones distintas (antes se
    // confundían y el "peso por unidad" quedaba mal calculado).
    const pesoPorUnidad = l.cantidadUnidades && l.cantidadUnidades > 0
      ? parseFloat((l.cantidad / l.cantidadUnidades).toFixed(4))
      : null

    // costo_unitario SIEMPRE en soles: l.precio_unitario viene en la
    // moneda original de la compra (detalle_compras.precio_unitario), se
    // convierte aquí con el tipo_cambio de la compra (PEN => tipo_cambio=1,
    // no cambia nada).
    const monedaCompra = compra?.currency || 'PEN'
    const tipoCambioCompra = parseFloat(compra?.tipo_cambio) || 1
    const costoOriginal = parseFloat(l.precio_unitario) || 0
    const costoPen = parseFloat((costoOriginal * tipoCambioCompra).toFixed(4))

    // ¿El N° de lote ya existe para este producto? Si el usuario lo eligió
    // del datalist (o lo escribió igual), se SUMA al lote existente en vez
    // de crear un duplicado. `l.loteExistenteId` lo resolvió la validación
    // previa, que ya preguntó qué hacer si los costos no coincidían.
    let lote = null
    let cantidadResultante = l.cantidad
    let costoFinalLote = costoPen

    if (l.loteExistenteId) {
      const existente = await getLoteById(l.loteExistenteId)
      if (!existente) throw new Error(`El lote ${l.numeroLote} ya no existe`)

      const cantPrevia = parseFloat(existente.cantidad) || 0
      const unidPrevias = parseFloat(existente.cantidad_unidades) || 0
      cantidadResultante = parseFloat((cantPrevia + l.cantidad).toFixed(4))
      const unidadesResultantes = parseFloat((unidPrevias + (l.cantidadUnidades || 0)).toFixed(4))

      // Costo: si el usuario aceptó fusionar con costos distintos, se
      // recalcula como promedio ponderado sobre la cantidad total. Si los
      // costos coincidían, el promedio da exactamente el mismo número.
      const costoPrevio = parseFloat(existente.costo_unitario) || 0
      costoFinalLote = cantidadResultante > 0
        ? parseFloat((((cantPrevia * costoPrevio) + (l.cantidad * costoPen)) / cantidadResultante).toFixed(4))
        : costoPen

      await updateLote(existente.id, {
        cantidad:          cantidadResultante,
        cantidad_unidades: unidadesResultantes,
        costo_unitario:    costoFinalLote,
        // El peso por unidad se recalcula sobre el acumulado, no se pisa
        // con el de esta recepción sola.
        peso_por_unidad:   unidadesResultantes > 0
          ? parseFloat((cantidadResultante / unidadesResultantes).toFixed(4))
          : existente.peso_por_unidad
      })
      lote = { ...existente, id: existente.id }
    } else {
      lote = await addLote({
        item_id:            l.item_id,
        proveedor_id:       compra?.contact_id || null,
        numero_lote:        l.numeroLote,
        numero_factura:     compra?.numero || null,
        codigo_partida:     l.codigoPartida,
        marca_id:           l.marcaId,
        costo_unitario:     costoPen,
        moneda:             monedaCompra,
        tipo_cambio:         tipoCambioCompra,
        costo_unit_original: costoOriginal,
        costo_estado:       'definitivo',
        cantidad:           l.cantidad,
        unidad_medida:      l.unidadMedida,
        // lotes.cantidad_unidades es NOT NULL DEFAULT 0: pasar `null`
        // explícito pisa el DEFAULT y Postgres rechaza el insert (23502).
        // l.cantidadUnidades sigue en null más arriba para no confundir
        // "0 unidades" con "no se ingresó" en los cálculos de peso_por_unidad.
        cantidad_unidades:  l.cantidadUnidades || 0,
        peso_por_unidad:    pesoPorUnidad,
        es_peso_variable:   l.esPesoVariable,
        ubicacion_id:       l.ubicacionId,
        fecha_ingreso:      fechaGuia,
        compra_id:          compraId,
        guia_id:            guia.id,
        created_by:         user.db_id
      })
    }

    if (lote?.id) {
      // stock_ubicaciones: si el lote ya tenía stock en ESA zona, se suma
      // a esa fila; si entra a una zona nueva, se crea la fila. (Un mismo
      // lote puede estar repartido en varias zonas.)
      const filasZona = l.loteExistenteId ? await getStockUbicacionesByLote(lote.id) : []
      const filaMisma = (filasZona || []).find(f => f.ubicacion_id === l.ubicacionId)
      if (filaMisma) {
        await updateStockUbicacion(filaMisma.id, {
          cantidad:          parseFloat(((parseFloat(filaMisma.cantidad) || 0) + l.cantidad).toFixed(4)),
          cantidad_unidades: parseFloat(((parseFloat(filaMisma.cantidad_unidades) || 0) + (l.cantidadUnidades || 0)).toFixed(4))
        })
      } else {
        await addStockUbicacion({
          lote_id:           lote.id,
          ubicacion_id:      l.ubicacionId,
          cantidad:          l.cantidad,
          cantidad_unidades: l.cantidadUnidades || 0
        })
      }

      // Kardex: entrada de Partners/Vendors (externo) a la zona real
      // elegida. Saldo = la cantidad del lote recién creado (costeo por
      // identificación específica: cada lote lleva su propio saldo).
      const costoTotalLinea = parseFloat((l.cantidad * costoPen).toFixed(2))
      totalValorGuia += costoTotalLinea
      await addKardexMovimiento({
        item_id:              l.item_id,
        lote_id:               lote.id,
        ubicacion_origen_id:   vendorsZona?.id || null,
        ubicacion_destino_id:  l.ubicacionId,
        fecha:                 fechaGuia,
        tipo_movimiento:       'entrada',
        concepto:              'Compra - ingreso a almacén',
        documento_referencia:  numeroGuia,
        cantidad_entrada:      l.cantidad,
        cantidad_salida:       0,
        cantidad_unidades_entrada: l.cantidadUnidades || 0,
        cantidad_unidades_salida:  0,
        costo_unitario:        costoPen,
        valor_entrada:         costoTotalLinea,
        valor_salida:          0,
        moneda:                monedaCompra,
        tipo_cambio:            tipoCambioCompra,
        costo_unit_original:    costoOriginal,
        // Saldo = cantidad ACUMULADA del lote tras esta entrada. Antes se
        // escribía solo `l.cantidad`, así que al recibir sobre un lote ya
        // existente el kardex mostraba un saldo menor al real.
        saldo_cantidad:        cantidadResultante,
        saldo_valor:           parseFloat((cantidadResultante * costoFinalLote).toFixed(2)),
        saldo_unidades:        l.cantidadUnidades || 0,
        compra_id:             compraId,
        created_by:            user.db_id
      })

      // Packing list: un lote_bultos por caja/bolsa con su peso real. Con
      // esto, lotes.cantidad/cantidad_unidades dejan de ser lo que se
      // escribió a mano arriba y pasan a ser la suma/conteo real de los
      // bultos (recalcularLoteDesdeBultos pisa lo que puso addLote/updateLote).
      if (l.esPesoVariable && Array.isArray(l.bultos) && l.bultos.length > 0) {
        const pesosValidos = l.bultos
          .map(b => parseFloat(b.peso) || 0)
          .filter(p => p > 0)
        for (const peso of pesosValidos) {
          await addLoteBulto({
            lote_id:        lote.id,
            peso,
            unidad_medida:  l.unidadMedida,
            ubicacion_id:   l.ubicacionId,
            estado:         'disponible',
            guia_ingreso_id: guia.id,
            fecha_ingreso:  fechaGuia,
            created_by:     user.db_id
          })
        }
        if (pesosValidos.length > 0) await recalcularLoteDesdeBultos(lote.id)
      }
    }

    await addDetalleGuiaIngresoCompra({
      guia_id:             guia.id,
      detalle_compra_id:   l.detalle_compra_id,
      item_id:             l.item_id,
      cantidad:            l.cantidad,
      numero_lote:         l.numeroLote,
      marca_id:            l.marcaId,
      codigo_partida:      l.codigoPartida,
      ubicacion_id:        l.ubicacionId,
      lote_id:             lote?.id || null
    })
  }

  return totalValorGuia
}

window.guardarGuiaIngresoCompra = async function () {
  // Modo edición: el mismo botón/modal se reusa para "Editar Guía de
  // Ingreso" (window.editarGuiaIngreso la puso en este modo) — se delega a
  // la ruta de revertir + reaplicar en vez de crear una guía nueva.
  if (_guiaIngresoEditId) { await _guardarEdicionGuiaIngreso(); return }

  const btn = document.getElementById('btnGuardarGuiaIngresoCompra')
  if (btn?.disabled) return
  if (btn) { btn.disabled = true; btn.textContent = 'Guardando...' }
  try {
    const user = await getCurrentUser()
    if (!user) { showToast('Usuario no autenticado', 'danger'); return }

    const compraId    = parseInt(document.getElementById('ngCompra')?.value || 0)
    const numeroGuia   = document.getElementById('ngNumeroGuia')?.value?.trim()
    const fechaGuia    = document.getElementById('ngFechaGuia')?.value
    const observaciones = document.getElementById('ngObservaciones')?.value?.trim() || null

    if (!compraId)   { showToast('Selecciona la compra que estás recibiendo', 'warning'); return }
    if (!numeroGuia) { showToast('Ingresa el N° de Guía', 'warning'); return }
    if (!fechaGuia)  { showToast('Ingresa la fecha de la guía', 'warning'); return }
    if (!_guiaLineas || _guiaLineas.length === 0) { showToast('Esta compra no tiene productos', 'warning'); return }

    _sincronizarRecepcionesGuiaDesdeDOM()

    // Validar Lote + Marca + Zona + Cantidad en cada recepción de cada línea
    // antes de escribir nada.
    const recepcionesValidadas = []
    for (const l of _guiaLineas) {
      for (const r of l.recepciones) {
        // Entrega parcial: este producto de la factura simplemente no llegó
        // en ESTA guía — se omite sin error (ver _esRecepcionVaciaGuia).
        if (_esRecepcionVaciaGuia(r)) continue
        if (!r.cantidad || r.cantidad <= 0) { showToast(`Cantidad recibida inválida para "${l.nombre}"`, 'warning'); return }
        if (!r.numero_lote)                 { showToast(`Falta el N° de Lote de "${l.nombre}"`, 'warning'); return }
        if (!r.marca_id)                    { showToast(`Falta la Marca de "${l.nombre}"`, 'warning'); return }
        if (!r.ubicacion_id)                { showToast(`Falta el Almacén/Zona de "${l.nombre}"`, 'warning'); return }
        // N° de Unidades obligatorio cuando NO es peso variable: sin esto,
        // peso_por_unidad queda null y el lote no puede sugerir unidades al
        // vender (bug recurrente de 13 lotes corregido el 05/09/2026 vía
        // backfill — esta validación evita que se repita). Cuando SÍ es peso
        // variable, cantidad_unidades se calcula solo del packing list.
        if (!r.es_peso_variable && (!r.cantidad_unidades || r.cantidad_unidades <= 0)) {
          showToast(`Falta el N° de Unidades (bultos/cajas) de "${l.nombre}"`, 'warning')
          return
        }

        recepcionesValidadas.push({
          detalle_compra_id: l.detalle_compra_id,
          item_id:           l.item_id,
          nombreProducto:    l.nombre,
          precio_unitario:   l.precio_unitario,
          unidadMedida:       l.unidad_medida || 'KG',
          cantidad:           r.cantidad,
          cantidadUnidades:   r.cantidad_unidades || null,
          numeroLote:         r.numero_lote,
          marcaId:            r.marca_id,
          codigoPartida:      (r.codigo_partida || '').trim() || null, // opcional: agrupa lotes de esta guía
          ubicacionId:        r.ubicacion_id,
          esPesoVariable:     !!r.es_peso_variable,
          bultos:             r.es_peso_variable ? (r.bultos || []) : null,  // packing list, solo si es_peso_variable
          loteExistenteId:    null   // lo resuelve el bloque de abajo
        })
      }
    }

    if (recepcionesValidadas.length === 0) {
      showToast('Ingresa la cantidad recibida de al menos un producto', 'warning')
      return
    }

    const compra = await getCompraById(compraId)

    // ── ¿Alguna recepción va sobre un lote que ya existe? ──────────────────
    // Se resuelve ANTES de escribir nada, porque si los costos no coinciden
    // hay que preguntar y una respuesta negativa cancela toda la guía.
    const conflictosCosto = []
    for (const rec of recepcionesValidadas) {
      // Compara solo contra lotes de ESTA MISMA compra — identificación
      // específica por adquisición: un mismo texto de lote en otra factura
      // nunca entra aquí, se crea como fila nueva más abajo (addLote).
      const existente = _buscarLoteExistente(rec.item_id, rec.numeroLote, compraId)
      if (!existente) continue

      rec.loteExistenteId = existente.id

      const costoExistente = parseFloat(existente.costo_unitario) || 0
      const costoNuevo = parseFloat(((parseFloat(rec.precio_unitario) || 0) * (parseFloat(compra?.tipo_cambio) || 1)).toFixed(4))
      if (Math.abs(costoExistente - costoNuevo) >= 0.0001) {
        conflictosCosto.push({ rec, existente, costoExistente, costoNuevo })
      }
    }

    if (conflictosCosto.length > 0) {
      // A esta altura ya es SIEMPRE la misma compra_id (identificación
      // específica por adquisición se resolvió arriba, en _buscarLoteExistente).
      // Si aun así el costo no coincide, es una corrección real dentro de la
      // misma factura (ej. precio_unitario tipeado distinto entre líneas de
      // una misma guía) — ahí sí tiene sentido preguntar si promediar.
      const detalle = conflictosCosto.map(c =>
        `• ${c.rec.nombreProducto} — lote ${c.rec.numeroLote}\n` +
        `    ya registrado en esta factura: ${(parseFloat(c.existente.cantidad) || 0).toLocaleString('en-US', { maximumFractionDigits: 2 })} ${c.existente.unidad_medida || 'KG'} a S/ ${c.costoExistente.toFixed(4)}\n` +
        `    ingresando ahora: ${c.rec.cantidad.toLocaleString('en-US', { maximumFractionDigits: 2 })} ${c.rec.unidadMedida} a S/ ${c.costoNuevo.toFixed(4)}`
      ).join('\n\n')

      const fusionar = confirm(
        `⚠ ${conflictosCosto.length} lote(s) de ESTA MISMA factura ya existían con OTRO costo unitario:\n\n${detalle}\n\n` +
        `Aceptar = SUMAR al lote existente recalculando su costo como promedio ponderado (correcto si es una corrección de precio dentro de la misma factura).\n` +
        `Cancelar = no guardar (revisa el precio unitario o el N° de lote antes de reintentar).`
      )
      if (!fusionar) {
        showToast('Guía no guardada: cambia el N° de lote para separar los ingresos de distinto costo', 'warning')
        return
      }
    }

    const guia = await addGuiaIngresoCompra({
      compra_id:     compraId,
      numero_guia:   numeroGuia,
      fecha_guia:    fechaGuia,
      observaciones,
      created_by:    user.db_id
    })

    if (!guia?.id) { showToast('No se pudo registrar la guía de remisión', 'danger'); return }

    const totalValorGuia = await _aplicarRecepcionesAGuiaIngreso(guia, compra, compraId, recepcionesValidadas, user, fechaGuia, numeroGuia)

    // Asiento de valuación de inventario (20111 debe / 611511 haber).
    // Detrás del mismo candado de desarrollo que la factura de compra.
    if (ASIENTOS_AUTO_COMPRAS_ACTIVO && totalValorGuia > 0.01) {
      try {
        await generarAsientoGuiaRemision({
          monto: totalValorGuia,
          documento_referencia: numeroGuia,
          descripcion: `Guía de Remisión - Ingreso a almacén (${numeroGuia})`,
          contact_id: compra?.contact_id || null,
          fecha: fechaGuia,
          userId: user?.id
        })
      } catch (errorAsiento) {
        console.error('Error generando asiento de guía de ingreso (compra doméstica):', errorAsiento)
        showToast(errorAsiento.message || 'Guía registrada, pero no se pudo generar el asiento de valuación de inventario', 'warning')
      }
    }

    showToast('Guía registrada: stock actualizado en Inventario', 'success')
    // Cierre directo (no cerrarModalNuevaGuia): la guía ya se guardó, así
    // que preguntar "¿vas a perder los datos?" aquí sería un falso aviso
    // sobre datos que ya están en la base.
    window.closeModal('modal-nueva-guia')
    _guiaLineas = []
    // Lotes, stock y kardex cambiaron: sin esto los reportes y el kardex
    // seguirían mostrando las cifras cacheadas de antes de la guía.
    _invalidarCacheCompras()
    await _cargarComprasConGuia(true)
    await renderGuias(true)
    await renderCompras(true)
  } catch (error) {
    console.error('Error en guardarGuiaIngresoCompra:', error)
    showToast('Error: ' + error.message, 'danger')
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Guardar Guía (ingresa stock)' }
  }
}

// ============================================================================
// PROVEEDORES
// ============================================================================
// El ingreso a almacén (creación de lotes) se hace desde el tab "Guía de
// Remisión" (window.guardarGuiaIngresoCompra), no al registrar la compra.

// Paginación: 50 proveedores por página, con caché para no re-consultar la BD
const PROV_POR_PAGINA = 50
let _provPagina = 1
let _provLista = null

async function renderProveedores(forzar = false) {
  try {
    const container = document.getElementById('tabla-proveedores')
    if (!container) return

    if (!_provLista || forzar) {
      _provLista = await getSuppliers()
      _provPagina = 1
    }

    // Búsqueda en vivo (contiene, sobre la lista ya cacheada — sin red)
    const busqueda = (document.getElementById('buscarProveedor')?.value || '').trim().toLowerCase()
    const proveedores = busqueda
      ? _provLista.filter(p => `${p.nombre || ''} ${p.nro_documento || ''}`.toLowerCase().includes(busqueda))
      : _provLista

    if (!proveedores || proveedores.length === 0) {
      container.innerHTML = `<p style="text-align: center; color: var(--text-secondary); padding: 20px;">${busqueda ? 'Sin resultados para la búsqueda' : 'Sin proveedores'}</p>`
      return
    }

    const totalPaginas = Math.max(1, Math.ceil(proveedores.length / PROV_POR_PAGINA))
    if (_provPagina > totalPaginas) _provPagina = totalPaginas
    if (_provPagina < 1) _provPagina = 1
    const inicio = (_provPagina - 1) * PROV_POR_PAGINA
    const pagina = proveedores.slice(inicio, inicio + PROV_POR_PAGINA)

    const paginador = `
      <div style="display:flex; justify-content:space-between; align-items:center; padding:12px 16px;">
        <span style="color:var(--text-secondary); font-size:0.85rem;">
          Mostrando ${inicio + 1}–${inicio + pagina.length} de ${proveedores.length} proveedores
        </span>
        <div style="display:flex; gap:8px; align-items:center;">
          <button class="btn btn-small btn-secondary" onclick="window.cambiarPaginaProveedores(-1)" ${_provPagina <= 1 ? 'disabled' : ''}>← Anterior</button>
          <span style="font-size:0.85rem;">Página ${_provPagina} de ${totalPaginas}</span>
          <button class="btn btn-small btn-secondary" onclick="window.cambiarPaginaProveedores(1)" ${_provPagina >= totalPaginas ? 'disabled' : ''}>Siguiente →</button>
        </div>
      </div>
    `

    let html = paginador + `
      <table>
        <thead>
          <tr>
            <th>Nombre</th>
            <th>Nro Documento</th>
            <th>Email</th>
            <th>Teléfono</th>
            <th>Dirección</th>
            <th>Pais</th>
            <th>Acciones</th>
          </tr>
        </thead>
        <tbody>
    `

    pagina.forEach(p => {
      html += `
        <tr>
          <td>${p.nombre || '-'}</td>
          <td>${p.nro_documento || '-'}</td>
          <td>${p.email || '-'}</td>
          <td>${p.telefono || p.numero || '-'}</td>
          <td>${p.direccion || '-'}</td>
          <td>${p.pais || '-'}</td>
          <td>
            <button class="btn btn-small btn-secondary" onclick="window.editarProveedor(${p.id})">Editar</button>
            <button class="btn btn-small btn-danger" onclick="window.eliminarProveedor(${p.id})">Eliminar</button>
          </td>
        </tr>
      `
    })

    html += '</tbody></table>' + paginador
    container.innerHTML = html
  } catch (error) {
    console.error('Error en renderProveedores:', error)
    showToast('Error al cargar los proveedores', 'danger')
  }
}

window.cambiarPaginaProveedores = async function (delta) {
  _provPagina += delta
  await renderProveedores()  // usa caché, solo cambia de página
}

window.filtrarProveedores = async function () {
  _provPagina = 1  // cada nueva búsqueda vuelve a la página 1
  await renderProveedores()  // usa caché, solo re-filtra (sin red)
}

// ID del proveedor en edición (null = modo crear)
let _provEditandoId = null

function _resetModalProveedor() {
  _provEditandoId = null
  const titulo = document.getElementById('modalProveedorTitle')
  if (titulo) titulo.textContent = 'Nuevo Proveedor'
  const form = document.getElementById('formNewProveedor')
  if (form) form.reset()
  // form.reset() no toca los spans "Datos SUNAT" (no son campos de formulario).
  ;['provEstadoSunat', 'provCondicionSunat', 'provBuenContribuyenteSunat', 'provAgenteRetencionSunat'].forEach(id => {
    const el = document.getElementById(id)
    if (el) { pintarBadgeSunat(el, '—', 'secondary'); delete el.dataset.value }
  })
  const tipoDocEl = document.getElementById('provTipoDocumento')
  if (tipoDocEl) tipoDocEl.dispatchEvent(new Event('change'))
}

window.abrirModalNuevoProveedor = function () {
  _resetModalProveedor()
  window.openModal('modal-nuevo-proveedor')
}

window.editarProveedor = async function (provId) {
  try {
    const p = await getContactById(provId)
    if (!p) { showToast('Proveedor no encontrado', 'danger'); return }

    document.getElementById('provNombre').value = p.nombre || ''
    document.getElementById('provTipoDocumento').value = p.tipo_documento || ''
    document.getElementById('provRUC').value = p.nro_documento || ''
    document.getElementById('provEmail').value = p.email || ''
    document.getElementById('provPhone').value = p.telefono || p.numero || ''
    document.getElementById('provDireccion').value = p.direccion || ''
    document.getElementById('provDistrito').value = p.distrito || ''
    document.getElementById('provPais').value = p.pais || ''
    const chkRet = document.getElementById('provSujetoRetencion')
    if (chkRet) chkRet.checked = !!p.sujeto_retencion

    // Datos SUNAT guardados de una consulta previa (si el contacto es RUC).
    pintarBadgeSunat(document.getElementById('provEstadoSunat'), p.estado || '—', p.estado === 'ACTIVO' ? 'success' : (p.estado ? 'danger' : 'secondary'))
    pintarBadgeSunat(document.getElementById('provCondicionSunat'), p.condicion || '—', p.condicion === 'HABIDO' ? 'success' : (p.condicion ? 'danger' : 'secondary'))
    const bcEl = document.getElementById('provBuenContribuyenteSunat')
    if (bcEl) {
      pintarBadgeSunat(bcEl, p.es_buen_contribuyente === true ? 'Sí' : (p.es_buen_contribuyente === false ? 'No' : '—'), p.es_buen_contribuyente === true ? 'success' : 'secondary')
      bcEl.dataset.value = p.es_buen_contribuyente === null || p.es_buen_contribuyente === undefined ? '' : String(p.es_buen_contribuyente)
    }
    const arEl = document.getElementById('provAgenteRetencionSunat')
    if (arEl) {
      pintarBadgeSunat(arEl, p.es_agente_retencion_sunat === true ? 'Sí' : (p.es_agente_retencion_sunat === false ? 'No' : '—'), p.es_agente_retencion_sunat === true ? 'success' : 'secondary')
      arEl.dataset.value = p.es_agente_retencion_sunat === null || p.es_agente_retencion_sunat === undefined ? '' : String(p.es_agente_retencion_sunat)
    }
    // Dispara el toggle de visibilidad del bloque "Datos SUNAT" según el
    // tipo_documento recién cargado (attachConsultaDocumento escucha 'change').
    const tipoDocEl = document.getElementById('provTipoDocumento')
    if (tipoDocEl) tipoDocEl.dispatchEvent(new Event('change'))

    _provEditandoId = provId
    const titulo = document.getElementById('modalProveedorTitle')
    if (titulo) titulo.textContent = `Editar Proveedor #${provId}`
    window.openModal('modal-nuevo-proveedor')
  } catch (error) {
    console.error('Error en editarProveedor:', error)
    showToast('Error al editar proveedor', 'danger')
  }
}

window.eliminarProveedor = async function (provId) {
  try {
    if (!confirm('¿Eliminar este proveedor? Esta acción no se puede deshacer.')) return

    const ok = await deleteContact(provId)
    if (!ok) {
      showToast('No se pudo eliminar: el contacto tiene documentos asociados (compras, CxP, etc.)', 'warning')
      return
    }
    showToast('Proveedor eliminado', 'success')
    await renderProveedores(true)
    await cargarProveedoresSelect()
  } catch (error) {
    console.error('Error en eliminarProveedor:', error)
    showToast('Error al eliminar proveedor', 'danger')
  }
}

window.guardarProveedor = async function () {
  try {
    const user = await getCurrentUser()
    if (!user) {
      showToast('Usuario no autenticado', 'danger')
      return
    }

    const prov = {
      nombre: document.getElementById('provNombre')?.value || '',
      tipo_documento: document.getElementById('provTipoDocumento')?.value || '',
      nro_documento: document.getElementById('provRUC')?.value || '',
      email: document.getElementById('provEmail')?.value || '',
      numero: document.getElementById('provPhone')?.value || '',
      direccion: document.getElementById('provDireccion')?.value || '',
      distrito: document.getElementById('provDistrito')?.value || '',
      pais: document.getElementById('provPais')?.value || '',
      sujeto_retencion: !!document.getElementById('provSujetoRetencion')?.checked,
      // Datos SUNAT (llenados por "Consultar" si Tipo Documento = RUC).
      estado:    document.getElementById('provEstadoSunat')?.textContent === '—' ? null : (document.getElementById('provEstadoSunat')?.textContent || null),
      condicion: document.getElementById('provCondicionSunat')?.textContent === '—' ? null : (document.getElementById('provCondicionSunat')?.textContent || null),
      es_buen_contribuyente: (() => {
        const v = document.getElementById('provBuenContribuyenteSunat')?.dataset.value
        return v === 'true' ? true : (v === 'false' ? false : null)
      })(),
      es_agente_retencion_sunat: (() => {
        const v = document.getElementById('provAgenteRetencionSunat')?.dataset.value
        return v === 'true' ? true : (v === 'false' ? false : null)
      })()
    }

    let resultado
    if (_provEditandoId) {
      // Al editar NO se toca tipo_contacto (conserva su lista actual)
      resultado = await updateContact(_provEditandoId, prov)
    } else {
      resultado = await addContact({ ...prov, tipo_contacto: ['proveedor'] })  // text[] en la BD
    }

    if (!resultado) {
      showToast('Error al guardar el proveedor en base de datos', 'danger')
      return
    }

    showToast(_provEditandoId ? 'Proveedor actualizado' : 'Proveedor guardado exitosamente', 'success')
    window.closeModal('modal-nuevo-proveedor')
    _resetModalProveedor()
    await renderProveedores(true)
    await cargarProveedoresSelect()
  } catch (error) {
    console.error('Error en guardarProveedor:', error)
    showToast('Error al guardar el proveedor', 'danger')
  }
}

// ============================================================================
// SELECT LOADERS
// ============================================================================
/*async function cargarTipoDocumentoSelect() {
  try {
    const tipoDocs = await getTipoDocumentos()
    if (!tipoDocs || tipoDocs.length === 0) {
      console.warn('No se encontraron tipos de documento para cargar el select')
      return
    }

    // Selects que deben listar proveedores: OC y compra de servicio/gasto
    const ids = ['ccTipoDocumento']
    ids.forEach(idSelect => {
      const select = document.getElementById(idSelect)
      if (!select) return
      select.innerHTML = '<option value="">-- Selecciona Tipo Documento --</option>'
      tipoDocs.forEach(t => {
        select.innerHTML += `<option value="${t.id}">${t.name}</option>`
      })
    })
  } catch (error) {
    console.error('Error en cargarTipoDocumentoSelect:', error) 
  }
}*/

async function cargarProveedoresSelect() {
  try {
    const proveedores = await getSuppliers()

    // Selects que deben listar proveedores: OC y el modal unificado de Nueva Compra
    const ids = ['ocProveedor', 'nqProveedor']
    ids.forEach(idSelect => {
      const select = document.getElementById(idSelect)
      if (!select) return
      // Se arma el HTML de una sola vez: hacer `innerHTML +=` dentro del bucle
      // reconstruye el DOM en cada vuelta y con cientos de proveedores se nota.
      select.innerHTML = '<option value="">-- Selecciona Proveedor --</option>' +
        proveedores.map(p => `<option value="${p.id}">${_escCompras(p.nombre || p.razon_social || '')}</option>`).join('')
      refrescarBuscador(select)
    })
  } catch (error) {
    console.error('Error en cargarProveedoresSelect:', error) 
  }
}

async function cargarCuentasGastoSelect() {
  try {
    const cuentas = await getCuentasGasto()
    const select = document.getElementById('csCuentaGasto')

    if (!select) return

    select.innerHTML = `<option value="">-- Selecciona Cuenta de Gasto ${cuentas.length}--</option>`
    cuentas.forEach(c => {
      select.innerHTML += `<option value="${c.codigo}">${c.codigo} - ${c.nombre}</option>`
    })
  } catch (error) {
    console.error('Error en cargarCuentasGastoSelect:', error)
  }
}

async function cargarItemsSelect() {
  try {
    const productos = await getItems()
    const select = document.getElementById('ocProducto')

    if (!select) return

    select.innerHTML = '<option value="">-- Selecciona Producto --</option>' +
      productos.map(p => `<option value="${p.id}">${_escCompras(p.nombre || '')}</option>`).join('')
    refrescarBuscador(select)
  } catch (error) {
    console.error('Error en cargarItemsSelect:', error)
  }
}

async function cargarLotesPorProducto() {
  try {
    const lotes = await getLotes()
    const select = document.getElementById('ocLote')

    if (!select) return

    select.innerHTML = '<option value="">-- Selecciona Lote --</option>'
    lotes.forEach(lote => {
      select.innerHTML += `<option value="${lote.id}">${lote.numero_lote}</option>`
    })
  } catch (error) {
    console.error('Error en cargarProductosSelect:', error)
  }
}

// ============================================================================
// CALCULOS DE TOTALES
// ============================================================================

window.calculoTotalNewOC = async function () {
  try {
    const cantidad = parseFloat(document.getElementById('ocCantidad')?.value || 0)
    const precioUnit = parseFloat(document.getElementById('ocPrecio')?.value || 0)
    const igv = parseFloat(document.getElementById('ocIGV')?.value || 0)

    if (igv === 18) {
      const subtotal = cantidad * precioUnit
      const igvAmount = subtotal * 0.18
      const totalConIGV = subtotal + igvAmount
      document.getElementById('ocIGVAmount').value = igvAmount.toFixed(2) || 0
      document.getElementById('ocSubtotal').value = subtotal.toFixed(2) || 0
      document.getElementById('ocTotal').value = totalConIGV.toFixed(2) || 0
    } else {
      const totalSinIGV = cantidad * precioUnit
      document.getElementById('ocIGVAmount').value = '0.00'
      document.getElementById('ocSubtotal').value = totalSinIGV.toFixed(2) || 0
      document.getElementById('ocTotal').value = totalSinIGV.toFixed(2) || 0
    }
  } catch (error) {
    console.error('Error en calculoTotalNewOC:', error)
    showToast('Error al calcular el total', 'danger')
  }
}
// ============================================================================
// ABRIR FORMULARIOS (Modal Helpers)
// ============================================================================

window.abrirFormularioProveedor = function() {
  window.openModal('modal-nuevo-proveedor')
}

window.abrirFormularioProducto = function() {
  window.openModal('modal-nuevo-producto')
}

window.abrirFormularioLote = async function() {
  try {
    const productos = await getItems()
    const sel = document.getElementById('loteProducto')
    if (sel) {
      sel.innerHTML = '<option value="">-- Selecciona --</option>' +
        productos.map(p => `<option value="${p.id}">${_escCompras(p.nombre || '')}${p.sku ? ' (' + _escCompras(p.sku) + ')' : ''}</option>`).join('')
      refrescarBuscador(sel)
    }
  } catch (error) {
    console.error('Error en abrirFormularioLote:', error)
  }
  window.openModal('modal-nuevo-lote')
}

// ============================================================================
// DETALLES OC EN CREACIÓN - Array y funciones
// ============================================================================

let detallesOCEnCreacion = []
let _ocContextConfirmar = null   // contexto para modal-confirmar-compra

window.abrirModalDetalleDesdeCrearOC = async function () {
  try {
    const supplierId = document.getElementById('ocProveedor')?.value || ''
    
    if (!supplierId || supplierId === '') {
      showToast('Primero debes seleccionar un proveedor', 'warning')
      return
    }

    // Cargar productos en el select
    await cargarItemsSelectDetalle()
    
    // Limpiar formulario
    document.getElementById('formNewDetalleOC').reset()
    document.getElementById('newDetalleOCIGV').value = '18'
    document.getElementById('newDetalleOCDescuento').value = '0'
    
    // Actualizar campos calculados
    calcularDetalleOC()
    
    // Abrir modal
    window.openModal('modal-nuevo-detalle-oc')
  } catch (error) {
    console.error('Error en abrirModalDetalleDesdeCrearOC:', error)
    showToast('Error al abrir el formulario', 'danger')
  }
}

async function cargarItemsSelectDetalle(targetId = 'newDetalleOCProducto') {
  try {
    const productos = await getItems()
    const select = document.getElementById(targetId)

    if (!select) return

    select.innerHTML = '<option value="">-- Selecciona un producto --</option>' +
      productos.map(p => `<option value="${p.id}">${_escCompras(p.nombre || p.name || '')}${p.sku ? ' (' + _escCompras(p.sku) + ')' : ''}</option>`).join('')
    refrescarBuscador(select)
  } catch (error) {
    console.error('Error en cargarItemsSelectDetalle:', error)
  }
}

window.calcularDetalleOC = function () {
  try {
    const cantidad = parseFloat(document.getElementById('newDetalleOCCantidad')?.value || 0)
    const precio = parseFloat(document.getElementById('newDetalleOCPrecio')?.value || 0)
    const descuento = parseFloat(document.getElementById('newDetalleOCDescuento')?.value || 0)
    const igvPorcentaje = parseInt(document.getElementById('newDetalleOCIGV')?.value || 18)
    
    // Calcular subtotal
    let subtotal = cantidad * precio
    
    // Aplicar descuento
    if (descuento > 0) {
      subtotal = subtotal - (subtotal * (descuento / 100))
    }
    
    // Calcular IGV
    const igvMonto = (subtotal * igvPorcentaje) / 100
    
    // Calcular total
    const total = subtotal + igvMonto
    
    // Actualizar campos
    document.getElementById('newDetalleOCSubtotal').value = subtotal.toFixed(2)
    document.getElementById('newDetalleOCIGVMonto').value = igvMonto.toFixed(2)
    document.getElementById('newDetalleOCTotal').value = total.toFixed(2)
  } catch (error) {
    console.error('Error en calcularDetalleOC:', error)
  }
}

function _renderTablaDetalleOC() {
  const container = document.getElementById('tabla-detalle-nueva-oc')
  if (container) {
    if (!detallesOCEnCreacion || detallesOCEnCreacion.length === 0) {
      container.innerHTML = '<p style="text-align: center; color: var(--text-secondary); padding: 20px;">Sin productos agregados</p>'
    } else {
      let html = `<table>
        <thead>
          <tr>
            <th>Producto</th><th>Cantidad</th><th>Unidad</th>
            <th style="text-align:right;">P. Unitario</th>
            <th style="text-align:right;">Subtotal</th>
            <th style="text-align:right;">IGV</th>
            <th style="text-align:right;">Total</th><th></th>
          </tr>
        </thead>
        <tbody>`
      detallesOCEnCreacion.forEach((d, idx) => {
        html += `<tr>
          <td>${d.nombre || `Item #${d.item_id}`}</td>
          <td>${formatQty(d.cantidad)}</td>
          <td>${d.unidad_medida}</td>
          <td style="text-align:right;">${formatNumber(d.precio_unitario)}</td>
          <td style="text-align:right;">${formatNumber(d.subtotal)}</td>
          <td style="text-align:right;">${formatNumber(d.igv_monto)}</td>
          <td style="text-align:right; font-weight:bold;">${formatNumber(d.total)}</td>
          <td><button type="button" class="btn btn-small btn-danger" onclick="window.quitarDetalleOC(${idx})">✕</button></td>
        </tr>`
      })
      html += '</tbody></table>'
      container.innerHTML = html
    }
  }

  const totCant = detallesOCEnCreacion.reduce((s, d) => s + (parseFloat(d.cantidad) || 0), 0)
  const totSub  = detallesOCEnCreacion.reduce((s, d) => s + (parseFloat(d.subtotal) || 0), 0)
  const totMon  = detallesOCEnCreacion.reduce((s, d) => s + (parseFloat(d.total) || 0), 0)
  const elCant = document.getElementById('totalCantidadOC')
  const elSub  = document.getElementById('totalSubtotalOC')
  const elTot  = document.getElementById('totalMontOC')
  if (elCant) elCant.textContent = totCant.toLocaleString('en-US', { maximumFractionDigits: 2 })
  if (elSub)  elSub.textContent  = totSub.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  if (elTot)  elTot.textContent  = totMon.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

window.crearDetalleOC = function () {
  try {
    const sel    = document.getElementById('newDetalleOCProducto')
    const itemId = parseInt(sel?.value || 0)
    if (!itemId) { showToast('Selecciona un producto', 'warning'); return }

    const cantidad  = parseFloat(document.getElementById('newDetalleOCCantidad')?.value || 0)
    const unidad    = document.getElementById('newDetalleOCUnidad')?.value || 'KG'
    const precio    = parseFloat(document.getElementById('newDetalleOCPrecio')?.value || 0)
    const descuento = parseFloat(document.getElementById('newDetalleOCDescuento')?.value || 0)
    const igvPct    = parseInt(document.getElementById('newDetalleOCIGV')?.value || 18)

    if (cantidad <= 0 || precio <= 0) {
      showToast('Cantidad y precio deben ser mayores a 0', 'warning')
      return
    }

    let subtotal = cantidad * precio
    if (descuento > 0) subtotal -= subtotal * (descuento / 100)
    const igvMonto = (subtotal * igvPct) / 100
    const total = subtotal + igvMonto

    detallesOCEnCreacion.push({
      item_id:         itemId,
      nombre:          sel?.selectedOptions[0]?.text || '',
      cantidad,
      unidad_medida:   unidad,
      precio_unitario: precio,
      igv_porcentaje:  igvPct,
      subtotal:        parseFloat(subtotal.toFixed(2)),
      igv_monto:       parseFloat(igvMonto.toFixed(2)),
      total:           parseFloat(total.toFixed(2))
    })

    _renderTablaDetalleOC()
    window.cerrarModalDetalleOC()
    showToast('Producto agregado a la orden', 'success')
  } catch (error) {
    console.error('Error en crearDetalleOC:', error)
    showToast('Error al agregar el producto', 'danger')
  }
}

window.quitarDetalleOC = function (idx) {
  detallesOCEnCreacion.splice(idx, 1)
  _renderTablaDetalleOC()
}

window.cerrarModalDetalleOC = function () {
  const form = document.getElementById('formNewDetalleOC')
  if (form) form.reset()
  window.closeModal('modal-nuevo-detalle-oc')
}

// ============================================================================
// GUARDAR PRODUCTO / LOTE (modales rápidos "+ Nuevo" desde Compras)
// ============================================================================

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

  const general = buscar('General')
  if (general) return general.id
  const nuevaGeneral = await addCategoria({ nombre: 'General' })
  return nuevaGeneral?.id || null
}

window.guardarProductoDesdeCompras = async function () {
  try {
    const nombre      = document.getElementById('prodNombre')?.value?.trim()
    const sku         = document.getElementById('prodSKU')?.value?.trim()
    const marcaTexto  = document.getElementById('prodMarca')?.value?.trim()
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

    // Nota: "Marca" en este modal es texto libre y no mapea a marca_id (FK).
    if (marcaTexto) console.info('Marca ingresada como texto (sin asociar a catálogo de marcas):', marcaTexto)

    showToast('Producto creado exitosamente', 'success')
    window.closeModal('modal-nuevo-producto')
    const form = document.getElementById('formNewProducto')
    if (form) form.reset()
    await cargarItemsSelectDetalle()
  } catch (error) {
    console.error('Error en guardarProductoDesdeCompras:', error)
    showToast('Error: ' + error.message, 'danger')
  }
}

window.guardarLoteDesdeCompras = async function () {
  try {
    const user = await getCurrentUser()
    if (!user) { showToast('Usuario no autenticado', 'danger'); return }

    const productId    = parseInt(document.getElementById('loteProducto')?.value || 0)
    const numeroLote    = document.getElementById('loteNumero')?.value?.trim()
    const cantidad      = parseFloat(document.getElementById('loteStock')?.value || 0)
    const costoUnitario = parseFloat(document.getElementById('loteCosto')?.value || 0)
    const fechaVenc      = document.getElementById('loteVencimiento')?.value || null

    if (!productId || !numeroLote || !cantidad || !costoUnitario) {
      showToast('Complete todos los campos requeridos (Producto, N° Lote, Stock, Costo)', 'warning')
      return
    }

    // Columnas reales de lotes: item_id, cantidad (no product_id/stock/costo_destino).
    // cantidad_unidades no se pide en este modal. lotes.cantidad_unidades es
    // NOT NULL DEFAULT 0, así que va 0 (no null: eso pisaría el DEFAULT y
    // Postgres rechazaría el insert con 23502).
    await addLote({
      item_id:            productId,
      numero_lote:        numeroLote,
      cantidad:           cantidad,
      cantidad_unidades:  0,
      costo_unitario:     costoUnitario,
      moneda:             'PEN',
      tipo_cambio:         1,
      costo_unit_original: costoUnitario,
      fecha_vencimiento:  fechaVenc,
      fecha_ingreso:      new Date().toISOString().split('T')[0],
      created_by:         user.db_id
    })

    showToast('Lote creado exitosamente', 'success')
    window.closeModal('modal-nuevo-lote')
    const form = document.getElementById('formNewLote')
    if (form) form.reset()
  } catch (error) {
    console.error('Error en guardarLoteDesdeCompras:', error)
    showToast('Error: ' + error.message, 'danger')
  }
}

// ============================================================================
// COMPRA DE SERVICIO / GASTO (sin producto, sin stock — ej: transporte, luz)
// ============================================================================

window.calcularCompraServicio = function () {
  const subtotal = parseFloat(document.getElementById('csSubtotal')?.value || 0)
  const igvPct   = parseFloat(document.getElementById('csIGV')?.value || 0)
  const igvMonto = parseFloat((subtotal * igvPct / 100).toFixed(2))
  const total    = parseFloat((subtotal + igvMonto).toFixed(2))

  const igvEl   = document.getElementById('csIGVMonto')
  const totalEl = document.getElementById('csTotal')
  if (igvEl)   igvEl.value   = igvMonto.toFixed(2)
  if (totalEl) totalEl.value = total.toFixed(2)
}

window.guardarCompraServicio = async function () {
  try {
    const user = await getCurrentUser()
    if (!user) { showToast('Usuario no autenticado', 'danger'); return }

    const contactId    = parseInt(document.getElementById('nqProveedor')?.value || 0)
    const moneda       = document.getElementById('nqMoneda')?.value || 'PEN'
    // PEN siempre es 1; en USD se toma el valor del campo (manual o el que
    // dejó el botón "↻ Auto"). Antes se guardaba 1 fijo aunque la compra
    // fuera en dólares, así que el costo en soles quedaba mal.
    const tipoCambioServicio = moneda === 'USD'
      ? (parseFloat(document.getElementById('nqTipoCambio')?.value || 0) || 1)
      : 1
    const fecha          = document.getElementById('nqFecha')?.value
    const nroComprobante = document.getElementById('nqNumeroComprobante')?.value?.trim() || null
    const tipoComprobante = document.getElementById('nqTipoComprobante')?.value || '01'
    const descripcion  = document.getElementById('csDescripcion')?.value?.trim()
    const cuentaSelect = document.getElementById('csCuentaGasto')
    const cuentaCodigo = cuentaSelect?.value || ''
    const cuentaNombre = cuentaSelect?.selectedOptions?.[0]?.textContent || ''
    const igvPct       = parseFloat(document.getElementById('csIGV')?.value || 0)
    const subtotal     = parseFloat(document.getElementById('csSubtotal')?.value || 0)

    if (!contactId)    { showToast('Selecciona un proveedor', 'warning'); return }
    if (!fecha)        { showToast('Ingresa la fecha', 'warning'); return }
    if (moneda === 'USD' && tipoCambioServicio <= 1) {
      showToast('Ingresa el Tipo de Cambio para una compra en dólares (usa "↻ Auto" para traer el de la SBS)', 'warning')
      return
    }
    if (!descripcion)  { showToast('Ingresa la descripción', 'warning'); return }
    if (!cuentaCodigo) { showToast('Selecciona la cuenta de gasto', 'warning'); return }
    if (!subtotal || subtotal <= 0) { showToast('Ingresa un subtotal válido', 'warning'); return }

    // Asegura que csIGVMonto/csTotal estén calculados aunque el usuario no
    // haya disparado el evento onchange (ej: pegó el valor y guardó directo).
    window.calcularCompraServicio()
    const igvMonto = parseFloat(document.getElementById('csIGVMonto')?.value || 0)
    const total    = parseFloat(document.getElementById('csTotal')?.value || 0)

    const prov = await getContactById(contactId)
    // Si el usuario dejó el N° de Comprobante (campo ahora compartido con
    // Mercadería/Anticipo), se usa igual que allá; si no, se mantiene el
    // comportamiento histórico de un correlativo interno.
    const referencia = nroComprobante || `SERV-${Date.now()}`
    const [serieServ, numeroServ] = (nroComprobante && nroComprobante.includes('-'))
      ? nroComprobante.split(/-(.+)/)
      : [null, referencia]

    // compras no tiene columna de cuenta contable: se deja trazado en la descripción.
    const compra = await addCompra({
      referencia,
      tipo_referencia:        'compra_directa',
      tipo_comprobante:       tipoComprobante,
      serie:                  serieServ,
      numero:                 numeroServ,
      periodo_mes:            parseInt(fecha.slice(5, 7)),
      periodo_ano:            parseInt(fecha.slice(0, 4)),
      fecha_emision:          fecha,
      fecha_recepcion:        fecha,
      contact_id:             contactId,
      proveedor_ruc:          prov?.nro_documento || '-',
      proveedor_nombre:       prov?.nombre || '-',
      tipo_compra:            'servicio',
      descripcion:            `${descripcion} [Cuenta: ${cuentaNombre || cuentaCodigo}]`,
      unidad_medida:          'UND',
      cantidad:               1,
      precio_unitario:        subtotal,
      base_imponible_gravada: igvPct > 0 ? subtotal : 0,
      monto_exonerado:        igvPct === 0 ? subtotal : 0,
      igv_gravado:            igvMonto,
      subtotal,
      total,
      currency:               moneda,
      tipo_cambio:            tipoCambioServicio,
      estado_pago:            'pendiente',
      asiento_id:             null,
      created_by:             user.db_id
    })

    if (!compra?.id) {
      showToast('No se pudo registrar la compra de servicio (¿referencia duplicada?)', 'danger')
      return
    }
    const cxpServicio = await _crearCuentaPagarSiFactura(compra, user.db_id)
    await _aplicarAnticiposSeleccionados(compra, cxpServicio, user.db_id)

    await addCompraDetalle({
      compra_id:       compra.id,
      item_id:         null,
      descripcion,
      unidad_medida:   'UND',
      cantidad:        1,
      precio_unitario: subtotal,
      subtotal,
      tipo_base:       igvPct > 0 ? 'gravada' : 'exonerada',
      igv_porcentaje:  igvPct,
      igv_monto:       igvMonto,
      total_linea:     total
    })

    // Adjunto opcional: si no llegó la factura todavía, se sube después
    // desde el kebab de la tabla (window.abrirModalAdjuntoCompra).
    const archivoServicio = document.getElementById('csAdjunto')?.files?.[0]
    if (archivoServicio) {
      try {
        await subirAdjuntoCompra(compra.id, archivoServicio)
      } catch (errorAdjunto) {
        console.error('Error subiendo adjunto de compra de servicio:', errorAdjunto)
        showToast(errorAdjunto.message || 'Compra registrada, pero no se pudo subir el documento', 'warning')
      }
    }

    showToast('Compra de servicio registrada exitosamente', 'success')
    window.closeModal('modal-nueva-compra-mercaderia')
    const form = document.getElementById('formNewCompraMercaderia')
    if (form) form.reset()
    await renderCompras(true)
  } catch (error) {
    console.error('Error en guardarCompraServicio:', error)
    showToast('Error: ' + error.message, 'danger')
  }
}

/** Espejo de calcularCompraServicio, para la sección Anticipo del modal unificado. */
window.calcularCompraAnticipo = function () {
  const subtotal = parseFloat(document.getElementById('atSubtotal')?.value || 0)
  const igvPct   = parseFloat(document.getElementById('atIGV')?.value || 0)
  const igvMonto = parseFloat((subtotal * igvPct / 100).toFixed(2))
  const total    = parseFloat((subtotal + igvMonto).toFixed(2))

  const igvEl   = document.getElementById('atIGVMonto')
  const totalEl = document.getElementById('atTotal')
  if (igvEl)   igvEl.value   = igvMonto.toFixed(2)
  if (totalEl) totalEl.value = total.toFixed(2)
}

// ============================================================================
// COMPRA — ANTICIPO A PROVEEDOR (Art. 5° Reglamento de Comprobantes de Pago:
// el pago anticipado, total o parcial, obliga a emitir el comprobante ANTES
// de que exista mercadería que recibir). Se registra como una compra más
// (para el Registro de Compras/IGV/CxP de SUNAT), pero con tipo_compra=
// 'anticipo' para que NUNCA aparezca en el selector de Nueva Guía de Ingreso
// (ese selector solo lista tipo_compra='mercaderia' — ver
// _cargarComprasSelectGuia) ni mueva stock. Más adelante se aplica contra la
// factura real desde la sección "Anticipos disponibles" (ver
// _cargarAnticiposDisponiblesProveedor / _aplicarAnticiposSeleccionados).
// Decisión confirmada con Luis 2026-09-07 a partir del caso real BENJI
// BILLION E.I.R.L. (factura FFFI-00000185, anticipo 100% Spun 20/1 RW).
// ============================================================================

window.guardarCompraAnticipo = async function () {
  try {
    const user = await getCurrentUser()
    if (!user) { showToast('Usuario no autenticado', 'danger'); return }

    const contactId  = parseInt(document.getElementById('nqProveedor')?.value || 0)
    const moneda     = document.getElementById('nqMoneda')?.value || 'USD'
    const tipoCambio = moneda === 'USD'
      ? (parseFloat(document.getElementById('nqTipoCambio')?.value || 0) || 1)
      : 1
    const fecha           = document.getElementById('nqFecha')?.value
    const nroComprobante  = document.getElementById('nqNumeroComprobante')?.value?.trim() || null
    const tipoComprobante = document.getElementById('nqTipoComprobante')?.value || '01'
    const descripcion     = document.getElementById('atDescripcion')?.value?.trim() || 'ANTICIPO'
    const refPedido       = document.getElementById('atReferenciaPedido')?.value?.trim() || ''
    const igvPct = parseFloat(document.getElementById('atIGV')?.value || 0)
    const subtotal = parseFloat(document.getElementById('atSubtotal')?.value || 0)

    if (!contactId) { showToast('Selecciona un proveedor', 'warning'); return }
    if (!fecha)     { showToast('Ingresa la fecha', 'warning'); return }
    if (moneda === 'USD' && tipoCambio <= 1) {
      showToast('Ingresa el Tipo de Cambio para un anticipo en dólares (usa "↻ Auto" para traer el de la SBS)', 'warning')
      return
    }
    if (!descripcion) { showToast('Ingresa la descripción del anticipo', 'warning'); return }
    if (!subtotal || subtotal <= 0) { showToast('Ingresa un subtotal válido', 'warning'); return }

    window.calcularCompraAnticipo()
    const igvMonto = parseFloat(document.getElementById('atIGVMonto')?.value || 0)
    const total    = parseFloat(document.getElementById('atTotal')?.value || 0)

    const prov = await getContactById(contactId)
    const referencia = nroComprobante || `ANT-${Date.now()}`
    const [serieAnt, numeroAnt] = (nroComprobante && nroComprobante.includes('-'))
      ? nroComprobante.split(/-(.+)/)
      : [null, referencia]
    const descripcionFinal = refPedido ? `${descripcion} [Pedido: ${refPedido}]` : descripcion

    const compra = await addCompra({
      referencia,
      tipo_referencia:        'compra_directa',
      tipo_comprobante:       tipoComprobante,
      serie:                  serieAnt,
      numero:                 numeroAnt,
      periodo_mes:            parseInt(fecha.slice(5, 7)),
      periodo_ano:            parseInt(fecha.slice(0, 4)),
      fecha_emision:          fecha,
      fecha_recepcion:        fecha,
      contact_id:             contactId,
      proveedor_ruc:          prov?.nro_documento || '-',
      proveedor_nombre:       prov?.nombre || '-',
      tipo_compra:            'anticipo',
      descripcion:            descripcionFinal,
      unidad_medida:          'UND',
      cantidad:               1,
      precio_unitario:        subtotal,
      base_imponible_gravada: igvPct > 0 ? subtotal : 0,
      monto_exonerado:        igvPct === 0 ? subtotal : 0,
      igv_gravado:            igvMonto,
      subtotal,
      total,
      currency:               moneda,
      tipo_cambio:            tipoCambio,
      estado_pago:            'pendiente',
      asiento_id:             null,
      created_by:             user.db_id
    })

    if (!compra?.id) {
      showToast('No se pudo registrar el anticipo (¿referencia duplicada?)', 'danger')
      return
    }

    // TODO CONTABILIDAD (detrás de ASIENTOS_AUTO_COMPRAS_ACTIVO cuando se
    // active el módulo): Debe 281111 Anticipo de Mercadería (o 422112
    // Anticipos a Proveedores ME si es en moneda extranjera) + 40111 IGV /
    // Haber Bancos (si se pagó de inmediato, término CONTADO como en el caso
    // BENJI) o 42111 Facturas por Pagar (si queda a crédito). Ver detalle
    // completo en 55_anticipos_proveedor_cliente.sql. NO se genera CxP con
    // cronograma de cuotas aquí (igual que Servicio): un anticipo se paga
    // completo, no se financia en cuotas.
    await _crearCuentaPagarSiFactura(compra, user.db_id)

    await addCompraDetalle({
      compra_id:       compra.id,
      item_id:         null,
      descripcion:     descripcionFinal,
      unidad_medida:   'UND',
      cantidad:        1,
      precio_unitario: subtotal,
      subtotal,
      tipo_base:       igvPct > 0 ? 'gravada' : 'exonerada',
      igv_porcentaje:  igvPct,
      igv_monto:       igvMonto,
      total_linea:     total
    })

    const archivoAnticipo = document.getElementById('atAdjunto')?.files?.[0]
    if (archivoAnticipo) {
      try {
        await subirAdjuntoCompra(compra.id, archivoAnticipo)
      } catch (errorAdjunto) {
        console.error('Error subiendo adjunto del anticipo:', errorAdjunto)
        showToast(errorAdjunto.message || 'Anticipo registrado, pero no se pudo subir el documento', 'warning')
      }
    }

    showToast('Anticipo a proveedor registrado. Podrás aplicarlo al registrar la factura real de mercadería.', 'success')
    window.closeModal('modal-nueva-compra-mercaderia')
    const form = document.getElementById('formNewCompraMercaderia')
    if (form) form.reset()
    await renderCompras(true)
  } catch (error) {
    console.error('Error en guardarCompraAnticipo:', error)
    showToast('Error: ' + error.message, 'danger')
  }
}

// ============================================================================
// APLICAR ANTICIPO A PROVEEDOR — al elegir proveedor en el modal de Nueva
// Compra (tipos Mercadería/Servicio), se buscan sus facturas tipo_compra=
// 'anticipo' con saldo sin aplicar y se ofrecen para descontar del total de
// ESTA factura. La aplicación es un DESCUENTO APARTE en la CxP recién creada
// (monto_anticipo_aplicado, mismo patrón que monto_notas_credito) — nunca
// una línea dentro de detalle_compras, para no ensuciar la tabla de
// productos real que usan Guía de Ingreso/kardex/reportes.
// ============================================================================

let _anticiposDisponiblesCache = []

/** Recalcula saldo disponible = compras.total del anticipo - lo ya aplicado en compras_anticipos_aplicados. */
async function _obtenerAnticiposDisponibles(contactId) {
  if (!contactId) return []
  const [compras, aplicaciones] = await Promise.all([getCompras(), getTodosComprasAnticiposAplicados()])
  const aplicadoPorAnticipo = new Map()
  for (const a of (aplicaciones || [])) {
    aplicadoPorAnticipo.set(a.compra_anticipo_id, (aplicadoPorAnticipo.get(a.compra_anticipo_id) || 0) + (parseFloat(a.monto_aplicado) || 0))
  }
  return (compras || [])
    .filter(c => c.contact_id === contactId && c.tipo_compra === 'anticipo' && !estaAnulado(c))
    .map(c => {
      const aplicado = aplicadoPorAnticipo.get(c.id) || 0
      const saldo = parseFloat((parseFloat(c.total || 0) - aplicado).toFixed(2))
      return { id: c.id, referencia: c.serie ? `${c.serie}-${c.numero}` : (c.numero || c.referencia), fecha: c.fecha_emision, moneda: c.currency || 'PEN', saldo }
    })
    .filter(a => a.saldo > 0.01)
    .sort((a, b) => new Date(a.fecha || 0) - new Date(b.fecha || 0))
}

/** Total actual del formulario, según el Tipo de Compra elegido — sirve para prellenar el monto a aplicar. */
function _totalActualFormularioCompra() {
  if (_tipoCompraActual === 'servicio') return parseFloat(document.getElementById('csTotal')?.value || 0) || 0
  if (_tipoCompraActual === 'anticipo') return 0 // no aplica: un anticipo no recibe otro anticipo
  return _detallesCompraEnCreacion.reduce((s, d) => s + (parseFloat(d.total) || 0), 0)
}

async function _cargarAnticiposDisponiblesProveedor() {
  const wrap = document.getElementById('nqAnticiposDisponibles')
  const lista = document.getElementById('nqAnticiposLista')
  if (!wrap || !lista) return

  const contactId = parseInt(document.getElementById('nqProveedor')?.value || 0)
  if (!contactId || _tipoCompraActual === 'anticipo') {
    wrap.style.display = 'none'
    lista.innerHTML = ''
    _anticiposDisponiblesCache = []
    return
  }

  try {
    _anticiposDisponiblesCache = await _obtenerAnticiposDisponibles(contactId)
  } catch (e) {
    console.error('Error cargando anticipos disponibles:', e)
    _anticiposDisponiblesCache = []
  }

  if (_anticiposDisponiblesCache.length === 0) {
    wrap.style.display = 'none'
    lista.innerHTML = ''
    return
  }

  wrap.style.display = ''
  lista.innerHTML = _anticiposDisponiblesCache.map(a => `
    <div style="display:flex; align-items:center; gap:10px; padding:6px 8px; background:var(--bg-primary); border-radius:var(--radius-sm);">
      <input type="checkbox" id="nqAntSel-${a.id}" onchange="window._toggleAnticipoAplicar(${a.id})">
      <span style="flex:1; font-size:0.85rem;">Factura ${_escCompras(a.referencia || '')} — ${a.fecha || ''} · Saldo disponible: ${a.moneda} ${a.saldo.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
      <input type="number" id="nqAntMonto-${a.id}" style="width:110px;" step="0.01" min="0" max="${a.saldo}" value="${a.saldo.toFixed(2)}" disabled>
    </div>
  `).join('')
}

window._toggleAnticipoAplicar = function (anticipoId) {
  const chk = document.getElementById(`nqAntSel-${anticipoId}`)
  const input = document.getElementById(`nqAntMonto-${anticipoId}`)
  if (!input) return
  input.disabled = !chk?.checked
  if (chk?.checked) {
    const a = _anticiposDisponiblesCache.find(x => x.id === anticipoId)
    const totalActual = _totalActualFormularioCompra()
    if (a) input.value = Math.min(a.saldo, totalActual > 0 ? totalActual : a.saldo).toFixed(2)
  }
}

/** Aplica los anticipos marcados en el modal contra la CxP recién creada de
 * `compraDestino`. Se llama después de _crearCuentaPagarSiFactura en los 3
 * flujos de guardado (Mercadería/Servicio; Anticipo nunca llama esto). */
async function _aplicarAnticiposSeleccionados(compraDestino, cxpDestino, userId) {
  if (!compraDestino?.id || !_anticiposDisponiblesCache.length) return

  let totalAplicado = 0
  for (const a of _anticiposDisponiblesCache) {
    const chk = document.getElementById(`nqAntSel-${a.id}`)
    if (!chk?.checked) continue
    const monto = parseFloat(document.getElementById(`nqAntMonto-${a.id}`)?.value || 0)
    if (!monto || monto <= 0) continue
    if (monto > a.saldo + 0.01) {
      showToast(`El monto a aplicar del anticipo ${a.referencia} supera su saldo disponible — se omitió`, 'warning')
      continue
    }

    const guardado = await addCompraAnticipoAplicado({
      compra_anticipo_id: a.id,
      compra_destino_id:  compraDestino.id,
      monto_aplicado:     monto,
      moneda:             compraDestino.currency || 'PEN',
      tipo_cambio:        parseFloat(compraDestino.tipo_cambio) || 1,
      created_by:         userId
    })
    if (!guardado?.id) {
      showToast(`No se pudo aplicar el anticipo ${a.referencia} — revísalo manualmente en Cuentas por Pagar`, 'warning')
      continue
    }
    totalAplicado += monto
  }

  if (totalAplicado <= 0) return
  if (!cxpDestino?.id) {
    showToast('Anticipo(s) aplicado(s), pero esta compra no generó Cuenta por Pagar (no es factura/invoice) — revísalo manualmente', 'warning')
    return
  }

  // TODO CONTABILIDAD (cuando se active el módulo): este es el momento de
  // generar el asiento de reclasificación Debe 60/20 Mercaderías (o la
  // cuenta de gasto de Servicio) / Haber 281111-422112 Anticipo, por
  // `totalAplicado` — NO un asiento de "pago" nuevo, es solo mover el saldo
  // de una cuenta transitoria a la definitiva. Ver 55_anticipos_proveedor_cliente.sql.
  const nuevoAplicado = parseFloat((parseFloat(cxpDestino.monto_anticipo_aplicado || 0) + totalAplicado).toFixed(2))
  const saldoRestante = parseFloat(cxpDestino.monto_total || 0) - parseFloat(cxpDestino.monto_pagado || 0) - parseFloat(cxpDestino.monto_notas_credito || 0) - nuevoAplicado
  const nuevoEstado = saldoRestante <= 0.01 ? 'pagado' : (nuevoAplicado > 0 ? 'parcial' : 'pendiente')
  await updateCuentaPagar(cxpDestino.id, { monto_anticipo_aplicado: nuevoAplicado, estado: nuevoEstado })
  showToast(`Anticipo aplicado: -${(compraDestino.currency || 'PEN')} ${totalAplicado.toFixed(2)}`, 'success')
}

// ============================================================================
// ADJUNTO DE COMPRA — 1 documento (PDF/JPEG/PNG) por compra. Pensado para
// gastos que se registran antes de que llegue la factura física (ej.
// comisión bancaria de una letra: se conoce el monto de inmediato, el PDF
// del banco llega después). Se sube/reemplaza/ve/borra desde el kebab de
// cualquier fila de la tabla Compras.
// ============================================================================

window.abrirModalAdjuntoCompra = async function (compraId) {
  try {
    const compra = await getCompraById(compraId)
    if (!compra) { showToast('Compra no encontrada', 'danger'); return }

    document.getElementById('adjCompraId').value = compraId
    const archivoInput = document.getElementById('adjArchivo')
    if (archivoInput) archivoInput.value = ''

    const actualDiv = document.getElementById('adjActual')
    const btnEliminar = document.getElementById('btnEliminarAdjunto')

    if (compra.adjunto_url) {
      let urlFirmada = null
      try { urlFirmada = await getUrlAdjuntoCompra(compra.adjunto_url) } catch (e) { console.error(e) }
      actualDiv.innerHTML = urlFirmada
        ? `<div class="badge badge-success">📎 ${compra.adjunto_nombre || 'Documento'}</div> · <a href="${urlFirmada}" target="_blank" rel="noopener">Ver / descargar</a>`
        : `<div class="badge badge-warning">📎 ${compra.adjunto_nombre || 'Documento'} (no se pudo generar el enlace)</div>`
      if (btnEliminar) btnEliminar.style.display = ''
    } else {
      actualDiv.innerHTML = '<span style="color:var(--text-secondary);">Esta compra todavía no tiene documento adjunto.</span>'
      if (btnEliminar) btnEliminar.style.display = 'none'
    }

    window.openModal('modal-adjunto-compra')
  } catch (error) {
    console.error('Error en abrirModalAdjuntoCompra:', error)
    showToast('Error: ' + error.message, 'danger')
  }
}

window.guardarAdjuntoCompra = async function () {
  try {
    const compraId = parseInt(document.getElementById('adjCompraId')?.value || 0)
    const archivo = document.getElementById('adjArchivo')?.files?.[0]
    if (!compraId) { showToast('Compra no válida', 'danger'); return }
    if (!archivo) { showToast('Selecciona un archivo', 'warning'); return }

    await subirAdjuntoCompra(compraId, archivo)
    showToast('Documento subido', 'success')
    window.closeModal('modal-adjunto-compra')
    _invalidarCacheCompras()
    await renderCompras(true)
  } catch (error) {
    console.error('Error en guardarAdjuntoCompra:', error)
    showToast('Error: ' + error.message, 'danger')
  }
}

window.eliminarAdjuntoCompraActual = async function () {
  try {
    const compraId = parseInt(document.getElementById('adjCompraId')?.value || 0)
    if (!compraId) return
    if (!confirm('¿Eliminar el documento adjunto de esta compra?')) return

    await eliminarAdjuntoCompra(compraId)
    showToast('Documento eliminado', 'success')
    window.closeModal('modal-adjunto-compra')
    _invalidarCacheCompras()
    await renderCompras(true)
  } catch (error) {
    console.error('Error en eliminarAdjuntoCompraActual:', error)
    showToast('Error: ' + error.message, 'danger')
  }
}

// ============================================================================
// COMPRA DE MERCADERÍA — registro directo, sin pasar por Orden de Compra.
// Por cada producto se pide N° de Lote (obligatorio) y N° de Partida
// (opcional); al guardar se crea la compra + detalle + el lote (stock
// directo en Inventario). Mismo criterio que ejecutarConfirmarCompra:
// Contabilidad en standby, sin asiento_id.
// ============================================================================

let _detallesCompraEnCreacion = []

// Tipo actualmente seleccionado en el modal unificado: 'mercaderia' | 'servicio' | 'anticipo'.
let _tipoCompraActual = 'mercaderia'

/** Punto de entrada único del botón "+ Nueva Compra" — reemplaza a los
 * antiguos abrirModalNuevaCompraMercaderia/abrirModalCompraServicio, hoy
 * fusionados en un solo modal con selector de Tipo (2026-09-07). */
window.abrirModalNuevaCompra = function () {
  _detallesCompraEnCreacion = []
  const form = document.getElementById('formNewCompraMercaderia')
  if (form) form.reset()
  const fechaEl = document.getElementById('nqFecha')
  if (fechaEl) fechaEl.value = new Date().toISOString().split('T')[0]
  const monedaEl = document.getElementById('nqMoneda')
  if (monedaEl) monedaEl.value = getModuloConfig('compras').monedaDefault || 'USD'
  // form.reset() devuelve el <select> a su opción `selected` del HTML y deja
  // el bloque del T.C. como estaba; hay que re-aplicar la regla a mano.
  window.onCambiarMonedaCompra()
  _renderTablaDetalleCompra()
  _cronogramaCompraListo = false
  _prepararCronogramaCompra(true)
  const atDesc = document.getElementById('atDescripcion')
  if (atDesc) atDesc.value = 'ANTICIPO'
  window.cambiarTipoCompra('mercaderia')
  window.openModal('modal-nueva-compra-mercaderia')
}

/** Alterna qué sección de detalle se ve dentro del modal unificado de Nueva
 * Compra, según el Tipo elegido. Nunca se mezclan tipos en un mismo
 * comprobante (decisión confirmada con Luis 2026-09-07). */
window.cambiarTipoCompra = function (tipo) {
  _tipoCompraActual = tipo

  const cuerpos = { mercaderia: 'tcBodyMercaderia', servicio: 'tcBodyServicio', anticipo: 'tcBodyAnticipo' }
  Object.entries(cuerpos).forEach(([t, id]) => {
    const el = document.getElementById(id)
    if (el) el.style.display = (t === tipo) ? '' : 'none'
  })

  const botones = { mercaderia: 'tcBtnMercaderia', servicio: 'tcBtnServicio', anticipo: 'tcBtnAnticipo' }
  Object.entries(botones).forEach(([t, id]) => {
    document.getElementById(id)?.classList.toggle('on', t === tipo)
  })

  // El cronograma de cuotas solo aplica a Mercadería (Servicio/Anticipo usan
  // Crédito/Contado simple, igual que siempre tuvo Servicio). Los anticipos
  // disponibles del proveedor no tienen sentido si esta MISMA compra es un
  // anticipo (no se puede aplicar un anticipo a otro anticipo).
  const cronoWrap = document.getElementById('nqCronogramaWrap')
  if (cronoWrap) cronoWrap.style.display = (tipo === 'mercaderia') ? '' : 'none'

  const titulo = { mercaderia: 'Nueva Compra (Mercadería)', servicio: 'Nueva Compra de Servicio/Gasto', anticipo: 'Nueva Compra — Anticipo a Proveedor' }
  const tituloEl = document.getElementById('ncTituloModal')
  if (tituloEl) tituloEl.textContent = titulo[tipo] || 'Nueva Compra'

  _cargarAnticiposDisponiblesProveedor()
}

/** Despacha el guardado al flujo correcto según el Tipo de Compra elegido. */
window.guardarCompraUnificada = function () {
  if (_tipoCompraActual === 'servicio') return window.guardarCompraServicio()
  if (_tipoCompraActual === 'anticipo') return window.guardarCompraAnticipo()
  return window.guardarCompraMercaderia()
}

// ============================================================================
// CRONOGRAMA DE PAGO EN NUEVA COMPRA (mercadería) — espejo de ventas.js
// ============================================================================

let _cronogramaCompraListo = false

window.onCambiarFechaCompra = function () {
  const fecha = document.getElementById('nqFecha')?.value
  if (!fecha) return
  if (_cronogramaCompraListo) actualizarCronograma('compra-cronograma', { fechaEmision: fecha })
}

/** Se llama al elegir proveedor: precarga el término habitual de ESE proveedor
 * y refresca la lista de anticipos disponibles de ese mismo proveedor. */
window.onCambiarProveedorCompra = function () {
  if (_cronogramaCompraListo) _prepararCronogramaCompra(true)
  _cargarAnticiposDisponiblesProveedor()
}

/** Se llama al abrir el modal y cada vez que cambia el total de la compra. */
async function _prepararCronogramaCompra(forzarRender = false) {
  const cont = document.getElementById('compra-cronograma')
  if (!cont) return

  const total = _detallesCompraEnCreacion.reduce((s, d) => s + (parseFloat(d.total) || 0), 0)
  const fechaEmision = document.getElementById('nqFecha')?.value || new Date().toISOString().slice(0, 10)

  if (!_cronogramaCompraListo || forzarRender) {
    // El término del proveedor solo PRECARGA el selector: la condición real
    // se negocia por operación, así que la compra guarda la suya y nunca se
    // reescribe la ficha del contacto desde aquí.
    const contactId = parseInt(document.getElementById('nqProveedor')?.value || 0)
    const prov = contactId ? await getContactById(contactId) : null

    await renderEditorCronograma('compra-cronograma', {
      total, fechaEmision, aplicaA: 'compra',
      terminoId: prov?.termino_pago_id || null,
      onCambio: (crono) => {
        // La fecha de vencimiento del comprobante = última cuota.
        const ultima = crono?.cuotas?.[crono.cuotas.length - 1]
        const fv = document.getElementById('nqFechaVencimiento')
        if (fv && ultima) fv.value = ultima.fecha_vencimiento
      }
    })
    _cronogramaCompraListo = true
  } else {
    actualizarCronograma('compra-cronograma', { total, fechaEmision })
  }
}

/** El cronograma se re-prorratea cada vez que cambian las líneas de la compra. */
function _refrescarCronogramaCompra() {
  if (_cronogramaCompraListo) _prepararCronogramaCompra(false)
}

window.abrirModalDetalleCompraMercaderia = async function () {
  try {
    const proveedorId = document.getElementById('nqProveedor')?.value || ''
    if (!proveedorId) { showToast('Primero selecciona un proveedor', 'warning'); return }

    await cargarItemsSelectDetalle('newDetalleCompraProducto')

    const form = document.getElementById('formNewDetalleCompra')
    if (form) form.reset()
    document.getElementById('newDetalleCompraIGV').value = String(getModuloConfig('compras').igvDefault ?? 18)
    document.getElementById('newDetalleCompraDescuento').value = '0'
    window.calcularDetalleCompraMercaderia()

    window.openModal('modal-nuevo-detalle-compra')
  } catch (error) {
    console.error('Error en abrirModalDetalleCompraMercaderia:', error)
    showToast('Error al abrir el formulario', 'danger')
  }
}

// Separado del cálculo porque lo usan tanto la vista previa en vivo
// (calcularDetalleCompraMercaderia) como el guardado real
// (crearDetalleCompraMercaderia) — antes cada uno repetía la fórmula, y al
// agregar "18% incluido" hubiera sido fácil actualizar una y olvidar la otra.
function _calcularMontosDetalleCompra(cantidad, precio, descuento, igvValor) {
  const incluido = String(igvValor).endsWith('-inc')
  const igvPct = parseFloat(igvValor) || 0

  let bruto = cantidad * precio
  if (descuento > 0) bruto -= bruto * (descuento / 100)

  let subtotal, igvMonto, total
  if (incluido && igvPct > 0) {
    // El Precio Unitario ya trae el IGV adentro: se extrae, no se suma encima.
    total = bruto
    subtotal = bruto / (1 + igvPct / 100)
    igvMonto = total - subtotal
  } else {
    subtotal = bruto
    igvMonto = (subtotal * igvPct) / 100
    total = subtotal + igvMonto
  }

  return { subtotal, igvMonto, total, igvPct }
}

window.calcularDetalleCompraMercaderia = function () {
  const cantidad  = parseFloat(document.getElementById('newDetalleCompraCantidad')?.value || 0)
  const precio    = parseFloat(document.getElementById('newDetalleCompraPrecio')?.value || 0)
  const descuento = parseFloat(document.getElementById('newDetalleCompraDescuento')?.value || 0)
  const igvValor  = document.getElementById('newDetalleCompraIGV')?.value || '18'

  const { subtotal, igvMonto, total } = _calcularMontosDetalleCompra(cantidad, precio, descuento, igvValor)

  document.getElementById('newDetalleCompraSubtotal').value = subtotal.toFixed(2)
  document.getElementById('newDetalleCompraIGVMonto').value = igvMonto.toFixed(2)
  document.getElementById('newDetalleCompraTotal').value = total.toFixed(2)
}

window.crearDetalleCompraMercaderia = function () {
  try {
    const sel    = document.getElementById('newDetalleCompraProducto')
    const itemId = parseInt(sel?.value || 0)
    if (!itemId) { showToast('Selecciona un producto', 'warning'); return }

    const cantidad    = parseFloat(document.getElementById('newDetalleCompraCantidad')?.value || 0)
    const unidad      = document.getElementById('newDetalleCompraUnidad')?.value || 'KG'
    const precio      = parseFloat(document.getElementById('newDetalleCompraPrecio')?.value || 0)
    const descuento   = parseFloat(document.getElementById('newDetalleCompraDescuento')?.value || 0)
    const igvValor    = document.getElementById('newDetalleCompraIGV')?.value || '18'
    const nroUnidades = parseFloat(document.getElementById('newDetalleCompraUnidades')?.value || 0) || null

    if (cantidad <= 0 || precio <= 0) { showToast('Cantidad y precio deben ser mayores a 0', 'warning'); return }

    const { subtotal, igvMonto, total, igvPct } = _calcularMontosDetalleCompra(cantidad, precio, descuento, igvValor)

    _detallesCompraEnCreacion.push({
      item_id:         itemId,
      nombre:          sel?.selectedOptions[0]?.text || '',
      cantidad,
      unidad_medida:   unidad,
      precio_unitario: precio,
      igv_porcentaje:  igvPct,
      subtotal:        parseFloat(subtotal.toFixed(2)),
      igv_monto:       parseFloat(igvMonto.toFixed(2)),
      total:           parseFloat(total.toFixed(2)),
      unidades:        nroUnidades
    })

    _renderTablaDetalleCompra()
    window.cerrarModalDetalleCompraMercaderia()
    showToast('Producto agregado a la compra', 'success')
  } catch (error) {
    console.error('Error en crearDetalleCompraMercaderia:', error)
    showToast('Error al agregar el producto', 'danger')
  }
}

window.cerrarModalDetalleCompraMercaderia = function () {
  window.closeModal('modal-nuevo-detalle-compra')
}

window.quitarDetalleCompraMercaderia = function (idx) {
  _detallesCompraEnCreacion.splice(idx, 1)
  _renderTablaDetalleCompra()
}

function _renderTablaDetalleCompra() {
  const container = document.getElementById('tabla-detalle-nueva-compra')
  if (container) {
    if (!_detallesCompraEnCreacion || _detallesCompraEnCreacion.length === 0) {
      container.innerHTML = '<p style="text-align: center; color: var(--text-secondary); padding: 20px;">Sin productos agregados</p>'
    } else {
      let html = `<table>
        <thead>
          <tr>
            <th>Producto</th><th>Cantidad</th><th>Unidad</th>
            <th style="text-align:right;">P. Unitario</th>
            <th style="text-align:right;">Total</th>
            <th>N° Unidades</th><th></th>
          </tr>
        </thead>
        <tbody>`
      _detallesCompraEnCreacion.forEach((d, idx) => {
        html += `<tr>
          <td>${d.nombre || `Item #${d.item_id}`}</td>
          <td>${(parseFloat(d.cantidad) || 0).toLocaleString('en-US', { maximumFractionDigits: 2 })}</td>
          <td>${d.unidad_medida}</td>
          <td style="text-align:right;">${parseFloat(d.precio_unitario).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
          <td style="text-align:right; font-weight:bold;">${parseFloat(d.total).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
          <td>${d.unidades ? parseFloat(d.unidades).toLocaleString('en-US', { maximumFractionDigits: 2 }) : '-'}</td>
          <td><button type="button" class="btn btn-small btn-danger" onclick="window.quitarDetalleCompraMercaderia(${idx})">✕</button></td>
        </tr>`
      })
      html += '</tbody></table>'
      container.innerHTML = html
    }
  }

  const totCant = _detallesCompraEnCreacion.reduce((s, d) => s + (parseFloat(d.cantidad) || 0), 0)
  const totUnid = _detallesCompraEnCreacion.reduce((s, d) => s + (parseFloat(d.unidades) || 0), 0)
  const totSub  = _detallesCompraEnCreacion.reduce((s, d) => s + (parseFloat(d.subtotal) || 0), 0)
  const totMon  = _detallesCompraEnCreacion.reduce((s, d) => s + (parseFloat(d.total) || 0), 0)
  const elCant = document.getElementById('totalCantidadCompra')
  const elUnid = document.getElementById('totalUnidadesCompra')
  const elSub  = document.getElementById('totalSubtotalCompra')
  const elTot  = document.getElementById('totalMontoCompra')
  if (elCant) elCant.textContent = totCant.toLocaleString('en-US', { maximumFractionDigits: 2 })
  if (elUnid) elUnid.textContent = totUnid.toLocaleString('en-US', { maximumFractionDigits: 2 })
  if (elSub)  elSub.textContent  = totSub.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  if (elTot)  elTot.textContent  = totMon.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

  _refrescarCronogramaCompra()
}

window.guardarCompraMercaderia = async function () {
  // Evita doble-submit: si el usuario percibe lentitud y hace doble clic,
  // el segundo intento antes chocaba en silencio contra la restricción
  // UNIQUE de `referencia` sin que quedara claro qué pasó.
  const btn = document.getElementById('btnGuardarCompraMercaderia')
  if (btn?.disabled) return
  if (btn) { btn.disabled = true; btn.textContent = 'Guardando...' }
  try {
    const user = await getCurrentUser()
    if (!user) { showToast('Usuario no autenticado', 'danger'); return }

    const contactId      = parseInt(document.getElementById('nqProveedor')?.value || 0)
    const moneda          = document.getElementById('nqMoneda')?.value || 'USD'
    const fecha           = document.getElementById('nqFecha')?.value
    const nroComprobante  = document.getElementById('nqNumeroComprobante')?.value?.trim() || null
    // PEN siempre es 1. En USD se usa el valor del campo (manual o el que
    // trajo el botón "↻ Auto" desde la SBS).
    const tipoCambio = moneda === 'USD'
      ? (parseFloat(document.getElementById('nqTipoCambio')?.value || 0) || 1)
      : 1

    if (!contactId) { showToast('Selecciona un proveedor', 'warning'); return }
    // Un T.C. de 1 en una compra en dólares dejaría el costo del lote en
    // soles igual al valor en USD, y ese costo es el que después valoriza el
    // inventario y el costo de venta. Se bloquea antes de guardar.
    if (moneda === 'USD' && tipoCambio <= 1) {
      showToast('Ingresa el Tipo de Cambio para una compra en dólares (usa "↻ Auto" para traer el de la SBS)', 'warning')
      return
    }
    if (!fecha)     { showToast('Ingresa la fecha', 'warning'); return }
    if (!_detallesCompraEnCreacion || _detallesCompraEnCreacion.length === 0) {
      showToast('Agrega al menos un producto', 'warning')
      return
    }

    const prov = await getContactById(contactId)
    const cantidadTotal = _detallesCompraEnCreacion.reduce((s, d) => s + (parseFloat(d.cantidad) || 0), 0) || 1
    const unidadesTotal = _detallesCompraEnCreacion.reduce((s, d) => s + (parseFloat(d.unidades) || 0), 0) || null
    const subtotalC = _detallesCompraEnCreacion.reduce((s, d) => s + (parseFloat(d.subtotal) || 0), 0)
    const igvC      = _detallesCompraEnCreacion.reduce((s, d) => s + (parseFloat(d.igv_monto) || 0), 0)
    const totalC    = _detallesCompraEnCreacion.reduce((s, d) => s + (parseFloat(d.total) || 0), 0)
    const referencia = nroComprobante || `COMP-${Date.now()}`
    const [serieC, numeroC] = (nroComprobante && nroComprobante.includes('-'))
      ? nroComprobante.split(/-(.+)/)
      : [null, referencia]

    // Cronograma de pago: si las cuotas no suman el total, la CxP quedaría
    // descuadrada desde el día uno. Se valida aquí, antes de escribir nada.
    const cronograma = leerCronograma('compra-cronograma')
    if (cronograma && !cronograma.cuadra) {
      showToast(
        `Las cuotas suman ${formatNumber(cronograma.suma)} pero el total es ${formatNumber(totalC)}. ` +
        `Usa "= Prorratear al total" en el cronograma o corrige los importes.`,
        'warning'
      )
      return
    }

    // Tipo de comprobante: '01' Factura nacional o '91' Comprobante de Pago
    // No Domiciliado (invoice de proveedor extranjero, importaciones
    // registradas directo aquí). Boleta no está entre las opciones: no da
    // derecho a crédito fiscal de IGV, Compras no la acepta.
    const tipoComprobanteC = document.getElementById('nqTipoComprobante')?.value || '01'

    const compra = await addCompra({
      referencia,
      tipo_referencia:        'compra_directa',
      tipo_comprobante:       tipoComprobanteC,
      serie:                  serieC,
      numero:                 numeroC,
      periodo_mes:            parseInt(fecha.slice(5, 7)),
      periodo_ano:            parseInt(fecha.slice(0, 4)),
      fecha_emision:          fecha,
      fecha_recepcion:        fecha,
      contact_id:             contactId,
      proveedor_ruc:          prov?.nro_documento || '-',
      proveedor_nombre:       prov?.nombre || '-',
      tipo_compra:            'mercaderia',
      descripcion:            `Compra directa - ${prov?.nombre || ''}`,
      cantidad:               cantidadTotal,
      total_unidades:         unidadesTotal,
      precio_unitario:        parseFloat((subtotalC / cantidadTotal).toFixed(4)) || 0,
      base_imponible_gravada: subtotalC,
      igv_gravado:            igvC,
      subtotal:               subtotalC,
      total:                  totalC,
      currency:               moneda,
      tipo_cambio:            tipoCambio,
      estado_pago:            'pendiente',
      asiento_id:             null,
      termino_pago_id:        cronograma?.terminoId || null,
      cronograma_personalizado: !!cronograma?.personalizado,
      created_by:             user.db_id
    })

    if (!compra?.id) {
      showToast('No se pudo registrar la compra (¿referencia duplicada?)', 'danger')
      return
    }
    const cxpMercaderia = await _crearCuentaPagarSiFactura(compra, user.db_id, cronograma)
    await _aplicarAnticiposSeleccionados(compra, cxpMercaderia, user.db_id)

    // Asiento contable de la factura (601111/40111C debe, 42111 haber).
    // Detrás del candado de desarrollo: ver config-asientos-auto.js.
    // TODO CONTABILIDAD: si esta compra tuvo anticipo(s) aplicado(s) (ver
    // _aplicarAnticiposSeleccionados arriba), el asiento de esta factura NO
    // debe generar una CxP nueva por el monto ya cubierto por el anticipo —
    // debe reclasificar 281111/422112 (anticipo) → 60/20 Mercaderías por el
    // monto aplicado, y solo generar CxP real por el saldo restante (si
    // queda alguno). Ver TODO detallado en 55_anticipos_proveedor_cliente.sql.
    if (ASIENTOS_AUTO_COMPRAS_ACTIVO) {
      try {
        await generarAsientoCompra(compra.id, user.db_id)
      } catch (errorAsiento) {
        console.error('Error generando asiento de compra:', errorAsiento)
        showToast(errorAsiento.message || 'Compra registrada, pero no se pudo generar el asiento contable', 'warning')
      }
    }

    // El stock YA NO se agrega aquí. Se agrega al registrar la Guía de
    // Remisión (tab "Guía de Remisión"), donde se pide N° de Lote, Marca y
    // Partida por producto recibido.
    for (const d of _detallesCompraEnCreacion) {
      await addCompraDetalle({
        compra_id:       compra.id,
        item_id:         d.item_id,
        descripcion:     d.nombre || `Item #${d.item_id}`,
        unidad_medida:   d.unidad_medida,
        cantidad:        d.cantidad,
        precio_unitario: d.precio_unitario,
        subtotal:        d.subtotal,
        tipo_base:       d.igv_porcentaje > 0 ? 'gravada' : 'exonerada',
        igv_porcentaje:  d.igv_porcentaje,
        igv_monto:       d.igv_monto,
        total_linea:     d.total,
        unidades:        d.unidades
      })
    }

    showToast('Compra registrada. Registra la Guía de Remisión para ingresar el stock a Inventario.', 'success')
    window.closeModal('modal-nueva-compra-mercaderia')
    _detallesCompraEnCreacion = []
    _cronogramaCompraListo = false
    const form = document.getElementById('formNewCompraMercaderia')
    if (form) form.reset()
    await renderCompras(true)
  } catch (error) {
    console.error('Error en guardarCompraMercaderia:', error)
    showToast('Error: ' + error.message, 'danger')
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Guardar Compra' }
  }
}

// ============================================================================
// IMPORTAR COMPRAS MASIVAS (desde Excel/CSV)
// ============================================================================
// Varias filas con el mismo numero_comprobante forman UNA compra con varias
// líneas (mismo criterio que "Nueva Compra (Mercadería)"). Solo llena
// compras + compra_detalles: NO toca stock/lotes/kardex — la Guía de
// Remisión de cada compra importada queda pendiente, igual que si se
// hubiera registrado la compra a mano desde el formulario.

window.abrirModalImportarCompras = function () {
  const input = document.getElementById('fileImportarCompras')
  if (input) input.value = ''
  const resumen = document.getElementById('importar-compras-resumen')
  const log = document.getElementById('importar-compras-log')
  if (resumen) resumen.innerHTML = ''
  if (log) log.innerHTML = ''
  window.openModal('modal-importar-compras')
}

async function _leerArchivoImportGenerico(file) {
  const XLSX = await import('https://cdn.jsdelivr.net/npm/xlsx@0.18.5/+esm')
  const buffer = await file.arrayBuffer()
  const wb = XLSX.read(buffer, { type: 'array', cellDates: true })
  const primeraHoja = wb.SheetNames[0]
  const ws = wb.Sheets[primeraHoja]
  return XLSX.utils.sheet_to_json(ws, { defval: null, raw: true })
}

function _parseFechaImportGenerico(valor) {
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

window.procesarImportacionCompras = async function () {
  const btn = document.getElementById('btnProcesarImportarCompras')
  const input = document.getElementById('fileImportarCompras')
  const resumenEl = document.getElementById('importar-compras-resumen')
  const logEl = document.getElementById('importar-compras-log')
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
      filas = await _leerArchivoImportGenerico(file)
    } catch (e) {
      console.error('Error leyendo archivo de importación:', e)
      if (resumenEl) resumenEl.innerHTML = '<p style="color:var(--color-danger);">No se pudo leer el archivo. Verifica que sea un .xlsx o .csv válido.</p>'
      return
    }

    if (!filas || filas.length === 0) {
      if (resumenEl) resumenEl.innerHTML = '<p style="color:var(--color-danger);">El archivo no tiene filas de datos.</p>'
      return
    }

    const [proveedores, items, terminos] = await Promise.all([getSuppliers(), getItems(), getTerminosConCuotas()])
    const provPorRuc = new Map(proveedores.filter(p => p.nro_documento).map(p => [String(p.nro_documento).trim(), p]))
    const itemsBySku = new Map(items.filter(i => i.sku).map(i => [String(i.sku).trim(), i]))
    // Término "Contado" del catálogo: fallback cuando termino_pago viene
    // vacío o dice literalmente "CONTADO".
    const terminoContado = terminos.find(t => t.tipo === 'contado') || null

    // Agrupar filas por numero_comprobante, preservando el orden de aparición.
    const grupos = new Map()
    filas.forEach((fila, idx) => {
      const numRaw = fila.numero_comprobante ?? fila.numeroComprobante
      const num = numRaw != null ? String(numRaw).trim() : ''
      if (!grupos.has(num)) grupos.set(num, [])
      grupos.get(num).push({ fila, numFila: idx + 2 })
    })

    let ok = 0, fallidas = 0
    const logLineas = []

    for (const [numeroComprobante, filasGrupo] of grupos) {
      if (!numeroComprobante) {
        fallidas += filasGrupo.length
        logLineas.push(`Fila ${filasGrupo[0].numFila}: falta "numero_comprobante".`)
        continue
      }

      const primera = filasGrupo[0].fila
      const rucRaw = primera.proveedor_ruc ?? primera.proveedorRuc
      const ruc = rucRaw != null ? String(rucRaw).trim() : ''
      const prov = provPorRuc.get(ruc)
      if (!ruc || !prov) {
        fallidas += filasGrupo.length
        logLineas.push(`Compra "${numeroComprobante}": proveedor RUC "${ruc}" no existe.`)
        continue
      }

      const fecha = _parseFechaImportGenerico(primera.fecha_emision ?? primera.fechaEmision)
      if (!fecha) {
        fallidas += filasGrupo.length
        logLineas.push(`Compra "${numeroComprobante}": fecha inválida.`)
        continue
      }

      const moneda = (primera.moneda || 'PEN').toString().trim().toUpperCase()
      const tipoCambio = moneda === 'USD' ? (parseFloat(primera.tipo_cambio ?? primera.tipoCambio) || 1) : 1

      // Validar cada línea de este comprobante antes de escribir nada.
      const lineas = []
      let grupoValido = true
      for (const { fila, numFila } of filasGrupo) {
        const skuRaw = fila.sku ?? fila.SKU
        const sku = skuRaw != null ? String(skuRaw).trim() : ''
        const item = itemsBySku.get(sku)
        const cantidad = parseFloat(fila.cantidad)
        const precioUnitario = parseFloat(fila.precio_unitario ?? fila.precioUnitario)
        const igvPorcentaje = parseFloat(fila.igv_porcentaje ?? fila.igvPorcentaje ?? 18)

        if (!sku || !item) { logLineas.push(`Fila ${numFila}: SKU "${sku}" no existe.`); grupoValido = false; continue }
        if (!cantidad || cantidad <= 0) { logLineas.push(`Fila ${numFila}: cantidad inválida.`); grupoValido = false; continue }
        if (isNaN(precioUnitario) || precioUnitario < 0) { logLineas.push(`Fila ${numFila}: precio unitario inválido.`); grupoValido = false; continue }

        const subtotal = parseFloat((cantidad * precioUnitario).toFixed(2))
        const igvMonto = parseFloat((subtotal * igvPorcentaje / 100).toFixed(2))
        const totalLinea = parseFloat((subtotal + igvMonto).toFixed(2))

        lineas.push({
          item_id: item.id,
          descripcion: item.nombre,
          unidad_medida: item.unidad_medida || 'UND',
          cantidad,
          precio_unitario: precioUnitario,
          subtotal,
          tipo_base: igvPorcentaje > 0 ? 'gravada' : 'exonerada',
          igv_porcentaje: igvPorcentaje,
          igv_monto: igvMonto,
          total_linea: totalLinea,
          unidades: null
        })
      }

      if (!grupoValido || lineas.length === 0) {
        fallidas += filasGrupo.length
        continue
      }

      try {
        const cantidadTotal = lineas.reduce((s, l) => s + l.cantidad, 0) || 1
        const subtotalC = lineas.reduce((s, l) => s + l.subtotal, 0)
        const igvC = lineas.reduce((s, l) => s + l.igv_monto, 0)
        const totalC = lineas.reduce((s, l) => s + l.total_linea, 0)
        const [serieC, numeroC] = numeroComprobante.includes('-')
          ? numeroComprobante.split(/-(.+)/)
          : [null, numeroComprobante]

        // Término de pago: texto libre de Odoo ("CONTADO", "45 DIAS",
        // "60-75-90 DIAS"...). Sin match reconocible, cae al término
        // habitual del proveedor y, si no tiene, a Contado.
        const terminoTexto = primera.termino_pago ?? primera.terminoPago ?? ''
        let crono = cronogramaDesdeTexto(terminoTexto, totalC, fecha, terminoContado)
        if (!crono) {
          const terminoProv = terminos.find(x => x.id === prov.termino_pago_id)
          crono = {
            cuotas: generarCronograma(terminoProv || terminoContado, totalC, fecha),
            terminoId: prov.termino_pago_id || terminoContado?.id || null,
            personalizado: false
          }
          if (terminoTexto) {
            logLineas.push(`Compra "${numeroComprobante}": término de pago "${terminoTexto}" no reconocido, se usó ${terminoProv ? terminoProv.nombre : 'Contado'}.`)
          }
        }

        const compra = await addCompra({
          referencia:             numeroComprobante,
          tipo_referencia:        'compra_directa',
          tipo_comprobante:       '01',
          serie:                  serieC,
          numero:                 numeroC,
          periodo_mes:            parseInt(fecha.slice(5, 7)),
          periodo_ano:            parseInt(fecha.slice(0, 4)),
          fecha_emision:          fecha,
          fecha_recepcion:        fecha,
          contact_id:             prov.id,
          proveedor_ruc:          prov.nro_documento || '-',
          proveedor_nombre:       prov.nombre || '-',
          tipo_compra:            'mercaderia',
          descripcion:            `Compra directa (importada) - ${prov.nombre || ''}`,
          cantidad:               cantidadTotal,
          total_unidades:         null,
          precio_unitario:        parseFloat((subtotalC / cantidadTotal).toFixed(4)) || 0,
          base_imponible_gravada: subtotalC,
          igv_gravado:            igvC,
          subtotal:               subtotalC,
          total:                  totalC,
          currency:               moneda,
          tipo_cambio:            tipoCambio,
          estado_pago:            'pendiente',
          asiento_id:             null,
          termino_pago_id:        crono.terminoId,
          cronograma_personalizado: crono.personalizado,
          created_by:             user.db_id
        })

        if (!compra?.id) {
          fallidas += filasGrupo.length
          logLineas.push(`Compra "${numeroComprobante}": no se pudo registrar (¿referencia duplicada?).`)
          continue
        }
        await _crearCuentaPagarSiFactura(compra, user.db_id, crono)

        for (const l of lineas) {
          await addCompraDetalle({ compra_id: compra.id, ...l })
        }

        ok += filasGrupo.length
      } catch (e) {
        console.error(`Error importando compra ${numeroComprobante}:`, e)
        fallidas += filasGrupo.length
        logLineas.push(`Compra "${numeroComprobante}": error inesperado al procesar (ver consola).`)
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
      showToast(`Compras importadas correctamente (${ok} línea(s)). La Guía de Remisión de cada una queda pendiente.`, 'success')
      await renderCompras(true)
    }
    if (fallidas > 0 && ok === 0) {
      showToast('No se pudo importar ninguna fila. Revisa el detalle de errores.', 'danger')
    }
  } catch (error) {
    console.error('Error en procesarImportacionCompras:', error)
    showToast('Error al procesar la importación', 'danger')
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Procesar Importación' }
  }
}
// ============================================================================
// REPORTES GERENCIALES DE COMPRAS — Fase 2
// ============================================================================

const _repComprasListos = {}

async function construirReporteCompras(panelId) {
  if (_repComprasListos[panelId]) return
  _repComprasListos[panelId] = true
  const cont = document.getElementById(panelId)
  if (cont) cont.innerHTML = '<div class="card"><p class="reporte-vacio">Calculando reporte…</p></div>'

  try {
    const [compras, proveedores, detalles, items] = await Promise.all([
      cacheado('compras', getCompras),
      cacheado('proveedores', getSuppliers),
      cacheado('compra_detalles', getCompraDetalles),
      cacheado('items', getItems)
    ])

    const provMap = {}; (proveedores || []).forEach(p => { provMap[p.id] = p.razon_social || p.nombre })
    const itemMap = {}; (items || []).forEach(i => { itemMap[i.id] = i })
    const compraMap = {}; (compras || []).forEach(c => { compraMap[c.id] = c })

    // Las compras anuladas no dan crédito fiscal ni cuentan como gasto.
    // Las notas de crédito recibidas entran en negativo: reducen la compra
    // neta y el crédito fiscal del periodo.
    const filas = (compras || []).filter(c => !estaAnulado(c)).map(c => {
      const sg = signoDocumento(c.tipo_comprobante)
      const total = parseFloat(c.total || 0) * sg
      const pagado = parseFloat(c.monto_pagado || 0) * sg
      return {
        proveedor: provMap[c.contact_id] || `ID ${c.contact_id}`,
        mes: nombreMes((c.fecha_emision || '').slice(0, 7)),
        fecha: c.fecha_emision || '',
        comprobante: `${c.tipo_comprobante || ''} ${c.serie || ''}-${c.numero || ''}`,
        tipo_comprobante: c.tipo_comprobante === '01' ? 'Factura' : (c.tipo_comprobante === '03' ? 'Boleta' : (c.tipo_comprobante === '91' ? 'Invoice (No Domiciliado)' : (c.tipo_comprobante || 'Otro'))),
        moneda: c.currency || c.moneda || 'PEN',
        estado_pago: c.estado_pago || 'pendiente',
        base: parseFloat(c.base_imponible_gravada || c.subtotal || 0) * sg,
        igv: parseFloat(c.igv_gravado || c.igv || 0) * sg,
        total,
        pendiente: sg > 0 ? Math.max(0, total - pagado) : total
      }
    })

    const filtrosBase = [
      { key: 'buscar', label: 'Buscar', tipo: 'texto', campos: ['proveedor', 'comprobante'], placeholder: 'Proveedor o comprobante...' },
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
      { label: 'Total comprado', valor: f.reduce((s, x) => s + x.total, 0), formato: 'money', color: 'var(--color-info)' },
      { label: 'IGV (crédito fiscal)', valor: f.reduce((s, x) => s + x.igv, 0), formato: 'money' },
      { label: 'Documentos', valor: f.length, formato: 'int' },
      { label: 'Compra promedio', valor: f.length ? f.reduce((s, x) => s + x.total, 0) / f.length : 0, formato: 'money' }
    ]

    if (panelId === 'repcm-evolucion') {
      crearReporte('repcm-evolucion', {
        id: 'repcm-evolucion',
        titulo: 'Evolución de las compras',
        descripcion: 'Cuánto se compró mes a mes, cruzable por tipo de comprobante y moneda.',
        datos: filas,
        dimensiones: [
          { key: 'mes', label: 'Mes' }, { key: 'tipo_comprobante', label: 'Comprobante' },
          { key: 'moneda', label: 'Moneda' }, { key: 'proveedor', label: 'Proveedor' }
        ],
        medidas: medidasBase, filtros: filtrosBase,
        agruparPorDefecto: ['mes'], orden: { key: '_etiqueta', dir: 'asc' }, kpis: kpisBase
      })
    }

    if (panelId === 'repcm-proveedores') {
      crearReporte('repcm-proveedores', {
        id: 'repcm-proveedores',
        titulo: 'Compras por proveedor',
        descripcion: 'Concentración de compras: quiénes son tus proveedores principales y cuánto representan.',
        datos: filas,
        dimensiones: [
          { key: 'proveedor', label: 'Proveedor' }, { key: 'moneda', label: 'Moneda' },
          { key: 'mes', label: 'Mes' }, { key: 'tipo_comprobante', label: 'Comprobante' }
        ],
        medidas: medidasBase, filtros: filtrosBase,
        agruparPorDefecto: ['proveedor'], kpis: kpisBase
      })
    }

    if (panelId === 'repcm-pagos') {
      crearReporte('repcm-pagos', {
        id: 'repcm-pagos',
        titulo: 'Estado de pago de las compras',
        descripcion: 'Qué compras están pagadas, parciales o pendientes. El detalle de saldos vive en Cuentas x Cobrar/Pagar.',
        datos: filas,
        dimensiones: [
          { key: 'estado_pago', label: 'Estado de pago' }, { key: 'proveedor', label: 'Proveedor' },
          { key: 'mes', label: 'Mes' }, { key: 'moneda', label: 'Moneda' }
        ],
        medidas: [
          { key: 'total', label: 'Total', agg: 'sum', formato: 'money' },
          { key: 'pendiente', label: 'Pendiente', agg: 'sum', formato: 'money', semaforo: true }
        ],
        filtros: [
          ...filtrosBase,
          { key: 'estado_pago', label: 'Estado', tipo: 'select', opciones: Array.from(new Set(filas.map(f => f.estado_pago))).sort() }
        ],
        agruparPorDefecto: ['estado_pago'],
        kpis: (f) => [
          { label: 'Total', valor: f.reduce((s, x) => s + x.total, 0), formato: 'money' },
          { label: 'Pendiente de pago', valor: f.reduce((s, x) => s + x.pendiente, 0), formato: 'money', color: 'var(--color-danger)' },
          { label: 'Documentos', valor: f.length, formato: 'int' }
        ]
      })
    }

    if (panelId === 'repcm-productos') {
      const filasDet = (detalles || []).map(d => {
        const c = compraMap[d.compra_id] || {}
        if (estaAnulado(c)) return null
        const it = itemMap[d.item_id] || {}
        const cant = parseFloat(d.cantidad || 0)
        const pu   = parseFloat(d.precio_unitario || d.costo_unitario || 0)
        return {
          producto: it.nombre || d.descripcion || `Item ${d.item_id}`,
          sku: it.sku || '—',
          proveedor: provMap[c.contact_id] || '(sin proveedor)',
          mes: nombreMes((c.fecha_emision || '').slice(0, 7)),
          fecha: c.fecha_emision || '',
          moneda: c.currency || c.moneda || 'PEN',
          cantidad: cant,
          precio_unitario: pu,
          total: parseFloat(d.total_linea || d.subtotal || (cant * pu) || 0)
        }
      }).filter(Boolean)

      crearReporte('repcm-productos', {
        id: 'repcm-productos',
        titulo: 'Compras por producto',
        descripcion: 'Qué se compra más y a qué precio. Agrupa por producto y proveedor para comparar precios entre proveedores.',
        datos: filasDet,
        dimensiones: [
          { key: 'producto', label: 'Producto' }, { key: 'proveedor', label: 'Proveedor' },
          { key: 'mes', label: 'Mes' }, { key: 'moneda', label: 'Moneda' }
        ],
        medidas: [
          { key: 'cantidad', label: 'Cantidad', agg: 'sum', formato: 'qty' },
          { key: 'total', label: 'Importe', agg: 'sum', formato: 'money' },
          { key: 'precio_unitario', label: 'Precio unit. prom.', agg: 'avg', formato: 'money4' }
        ],
        filtros: [
          { key: 'buscar', label: 'Buscar', tipo: 'texto', campos: ['producto', 'sku', 'proveedor'], placeholder: 'Producto o proveedor...' },
          { key: 'moneda', label: 'Moneda', tipo: 'select', opciones: ['PEN', 'USD'] },
          { key: 'rango', label: 'Fecha', tipo: 'rango', campo: 'fecha' }
        ],
        agruparPorDefecto: ['producto'],
        kpis: (f) => [
          { label: 'Importe total', valor: f.reduce((s, x) => s + x.total, 0), formato: 'money' },
          { label: 'Unidades', valor: f.reduce((s, x) => s + x.cantidad, 0), formato: 'qty' },
          { label: 'Productos distintos', valor: new Set(f.map(x => x.producto)).size, formato: 'int' }
        ]
      })
    }
  } catch (e) {
    console.error('construirReporteCompras:', e)
    _repComprasListos[panelId] = false
    if (cont) cont.innerHTML = `<div class="card"><p class="reporte-vacio">No se pudo construir el reporte: ${e.message}</p></div>`
  }
}

// ============================================================================
// ANULACIÓN DE FACTURAS DE COMPRA
// ============================================================================
// Espejo exacto de la anulación de ventas. Las validaciones cambian de lado:
//   * en vez de cobros, se revisan los PAGOS al proveedor;
//   * en vez de guías de despacho (que sacan stock), se revisan las guías de
//     INGRESO (que lo metieron): mientras la guía siga activa, hay mercadería
//     en el almacén sustentada por un comprobante que se quiere anular.

window.anularCompra = async function (id) {
  try {
    const compra = await getCompraById(id)
    if (!compra) { showToast('No se encontró la compra', 'danger'); return }

    const comprobante = `${compra.tipo_comprobante || ''} ${compra.serie || ''}-${compra.numero || ''}`.trim()

    if (estaAnulado(compra)) {
      showToast(`${comprobante} ya está anulada`, 'info')
      return
    }

    const bloqueos = []
    const efectos  = []

    // --- Pagos aplicados (vía cuentas_pagar)
    const cxps = await getCuentasPagarByCompra(id)
    let totalPagado = 0
    for (const cxp of (cxps || [])) totalPagado += parseFloat(cxp.monto_pagado) || 0

    if (totalPagado > 0.01) {
      bloqueos.push(`Tiene ${formatNumber(totalPagado)} ya pagado al proveedor. Revierte los pagos en "Cuentas x Cobrar/Pagar" antes de anular.`)
    } else if ((cxps || []).length > 0) {
      efectos.push(`Se anulará su Cuenta por Pagar (${formatNumber(cxps[0].monto_total)}).`)
    }

    // --- Guías de ingreso activas: son las que metieron el stock
    const guias = (await getGuiasIngresoCompra(true) || []).filter(g => g.compra_id === id && g.estado !== 'anulada')
    if (guias.length > 0) {
      bloqueos.push(`Tiene ${guias.length} guía(s) de ingreso activa(s) (${guias.map(g => g.numero_guia).join(', ')}). Anúlalas primero — son las que retiran el stock de Inventario.`)
    }

    // --- NC de devolución con stock ya retirado por una Guía de Devolución:
    // anular la NC sin revertir esa guía dejaría el stock afuera sin ninguna
    // NC que lo respalde.
    if (String(compra.tipo_comprobante) === TIPO_NC && compra.estado_devolucion && compra.estado_devolucion !== 'pendiente') {
      const detalleNota = await getNotaCreditoCompraDetalleByNota(id)
      const idsDetalle = new Set((detalleNota || []).map(d => d.id))
      const todasLasGuiasDetalle = await getTodosDetalleGuiasDevolucionCompra()
      const guiasIds = new Set((todasLasGuiasDetalle || []).filter(dg => idsDetalle.has(dg.nota_credito_compra_detalle_id)).map(dg => dg.guia_id))
      if (guiasIds.size > 0) {
        bloqueos.push(`Esta NC ya tiene ${guiasIds.size} Guía(s) de Devolución que retiraron stock (estado: ${compra.estado_devolucion}). Elimínalas primero en la pestaña Guía de Remisión — revierten el stock automáticamente.`)
      }
    }

    if (compra.asiento_id) {
      efectos.push('Se generará un asiento de reversión (el asiento original no se borra).')
    }

    efectos.push('Quedará como ANULADA con estado de comprobante "0"; ya no suma al crédito fiscal del periodo.')
    efectos.push('Dejará de aparecer en reportes de compras, KPIs y dashboard.')

    abrirModalAnulacion({
      titulo: 'Anular Factura de Compra',
      documento: comprobante || `Compra #${compra.id}`,
      detalle: `${compra.proveedor_nombre || ''} · ${compra.fecha_emision || ''} · ${compra.currency || 'PEN'} ${formatNumber(compra.total)}`,
      efectos, bloqueos,
      onConfirmar: async ({ motivo, fecha, usuarioId }) => {
        await updateCompra(id, camposAnulacion({ motivo, fecha, usuarioId }))

        for (const cxp of (cxps || [])) {
          try {
            await updateCuentaPagar(cxp.id, { estado: 'anulado' })
          } catch (e) {
            console.warn('CxP no anulada:', e.message)
          }
        }

        if (compra.asiento_id) {
          try {
            await reversarAsiento(compra.asiento_id, usuarioId, `Anulación de compra ${comprobante}: ${motivo}`)
          } catch (e) {
            console.warn('Asiento no reversado:', e.message)
            showToast('Compra anulada ⚠️ el asiento no se pudo reversar: ' + e.message, 'warning')
          }
        }

        _invalidarCacheCompras()
        showToast(`${comprobante} anulada ✅`, 'success')
        await renderCompras(true)
      }
    })
  } catch (e) {
    console.error('anularCompra:', e)
    showToast('Error al preparar la anulación: ' + e.message, 'danger')
  }
}

// ============================================================================
// ANULACIÓN DE GUÍAS DE INGRESO DE COMPRA
// ============================================================================
// Anular una guía de ingreso RETIRA del almacén lo que ella había metido.
// Por eso, a diferencia de la guía de despacho, aquí sí hay que validar antes:
// si parte de esa mercadería ya se vendió o se trasladó, el stock actual del
// lote es menor que lo ingresado y retirarlo dejaría cantidades negativas.
// En ese caso se bloquea y se indica exactamente qué lote es el problema.

window.anularGuiaIngreso = async function (id) {
  try {
    const guia = await getGuiaIngresoCompraById(id)
    if (!guia) { showToast('No se encontró la guía', 'danger'); return }

    if (estaAnulado(guia)) {
      showToast(`La guía ${guia.numero_guia} ya está anulada`, 'info')
      return
    }

    const detalles = await getDetalleGuiasIngresoCompra(id)
    const bloqueos = []
    const aRetirar = []
    let totalKg = 0

    for (const dg of (detalles || [])) {
      if (!dg.lote_id) continue
      const lote = await getLoteById(dg.lote_id)
      if (!lote) continue // el lote ya no existe: nada que retirar por esta línea

      const ingresado = parseFloat(dg.cantidad) || 0
      const actual    = parseFloat(lote.cantidad) || 0
      totalKg += ingresado

      // Da igual si el lote lo creó esta guía o ya existía: en ambos casos se
      // retira EXACTAMENTE lo que esta guía aportó. Lo único que hay que
      // garantizar es que esa cantidad siga disponible.
      if (actual + 0.0001 < ingresado) {
        const item = await getItemById(dg.item_id)
        const consumido = parseFloat((ingresado - actual).toFixed(4))
        bloqueos.push(
          `${item?.nombre || 'Item #' + dg.item_id} (lote ${lote.numero_lote}): ingresaron ${formatQty(ingresado)} pero solo quedan ${formatQty(actual)} ` +
          `— ya se consumieron ${formatQty(consumido)}. Anula primero la venta o el traslado que los consumió.`
        )
      } else {
        aRetirar.push({ lote, dg, ingresado, compartido: lote.guia_id !== id })
      }
    }

    const compra = guia.compra_id ? await getCompraById(guia.compra_id) : null

    const compartidos = aRetirar.filter(x => x.compartido).length
    const efectos = [
      `Se retirarán ${formatQty(totalKg)} de Inventario de ${aRetirar.length} lote(s).` +
        (compartidos > 0
          ? ` ${compartidos} de ellos son lotes preexistentes: solo se descuenta lo que esta guía aportó, el resto del lote se mantiene.`
          : ' Los lotes quedarán en cero.'),
      'Se eliminarán los movimientos de kardex que generó esta guía.',
      'La compra volverá a figurar como pendiente de guía.',
      'La guía queda registrada como ANULADA; su número no se reutiliza.'
    ]

    abrirModalAnulacion({
      titulo: 'Anular Guía de Ingreso',
      documento: `Guía ${guia.numero_guia}`,
      detalle: compra
        ? `Compra ${compra.serie || ''}-${compra.numero || ''} · ${compra.proveedor_nombre || ''} · ${guia.fecha_guia || ''}`
        : (guia.fecha_guia || ''),
      efectos, bloqueos,
      onConfirmar: async ({ motivo, fecha, usuarioId }) => {
        // 1. Retirar el stock: se descuenta lo ingresado del lote y de sus
        //    ubicaciones. Como ya validamos que nadie lo consumió, el lote
        //    queda en 0 y sus filas de stock_ubicaciones también.
        for (const { lote, dg, ingresado } of aRetirar) {
          const nuevaCantidad = parseFloat(Math.max(0, (parseFloat(lote.cantidad) || 0) - ingresado).toFixed(4))
          await updateLote(lote.id, { cantidad: nuevaCantidad })

          // Se descuenta primero de la zona a la que esta guía ingresó; solo
          // si ahí no alcanza se toma del resto (caso raro: hubo traslados).
          const filas = await getStockUbicacionesByLote(lote.id)
          const ordenadas = [...(filas || [])].sort((a, b) =>
            (b.ubicacion_id === dg.ubicacion_id ? 1 : 0) - (a.ubicacion_id === dg.ubicacion_id ? 1 : 0))

          let porDescontar = ingresado
          for (const f of ordenadas) {
            if (porDescontar <= 0) break
            const disponible = parseFloat(f.cantidad) || 0
            const quita = Math.min(disponible, porDescontar)
            await updateStockUbicacion(f.id, {
              cantidad: parseFloat((disponible - quita).toFixed(4))
            })
            porDescontar = parseFloat((porDescontar - quita).toFixed(4))
          }
        }

        // 2. Borrar el kardex de esta guía (filtrando por los lotes tocados,
        //    para no borrar movimientos de otras guías de la misma compra)
        if (guia.compra_id) {
          const idsLotes = aRetirar.map(x => x.lote.id)
          const kardexCompra = await getKardexByCompra(guia.compra_id)
          for (const k of (kardexCompra || [])) {
            if (idsLotes.includes(k.lote_id)) {
              const okKardex = await deleteKardexMovimiento(k.id)
              if (!okKardex) {
                const motivo = ultimoErrorDelete()
                throw new Error(`No se pudo eliminar el movimiento de Kardex #${k.id}: ${motivo?.mensaje || 'motivo desconocido'}. Se detiene la anulación para no dejar el Kardex descuadrado.`)
              }
            }
          }
        }

        // 3. Marcar la guía como anulada
        await updateGuiaIngresoCompra(id, camposAnulacion(
          { motivo, fecha, usuarioId }, { usaEstadoComprobante: false }
        ))

        _invalidarCacheCompras()
        showToast(`Guía ${guia.numero_guia} anulada ✅ — stock retirado de Inventario`, 'success')
        await _cargarComprasConGuia(true)
        await renderGuias(true)
        await renderCompras(true)
      }
    })
  } catch (e) {
    console.error('anularGuiaIngreso:', e)
    showToast('Error al preparar la anulación: ' + e.message, 'danger')
  }
}

window.verMotivoAnulacionCompra = async function (tipo, id) {
  try {
    const doc = tipo === 'compra' ? await getCompraById(id) : await getGuiaIngresoCompraById(id)
    if (!doc) return
    const etiqueta = tipo === 'compra'
      ? `${doc.tipo_comprobante || ''} ${doc.serie || ''}-${doc.numero || ''}`.trim()
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

function _invalidarCacheCompras() {
  import('./data-cache.js').then(({ invalidarVarios }) => {
    invalidarVarios(['compras', 'compra_detalles', 'cuentas_pagar', 'lotes', 'stock_ubicaciones', 'kardex'])
  }).catch(() => {})
  Object.keys(_repComprasListos).forEach(k => { _repComprasListos[k] = false })
}

// ============================================================================
// NOTAS DE CRÉDITO Y DÉBITO — RECIBIDAS DEL PROVEEDOR
// ============================================================================
// Espejo de las notas de venta, pero aquí NO las emitimos nosotros: las emite
// el proveedor y nosotros las registramos. Por eso el número y la serie los
// digita el usuario copiando el documento físico (no hay correlativo propio).
//
// Efecto:
//   NC recibida → nos deben menos: reduce lo que hay que pagar y reduce el
//                 crédito fiscal del periodo.
//   ND recibida → nos cobran más: aumenta lo que hay que pagar.

window.abrirModalNotaCreditoCompra = function (compraId) { _abrirNotaCompra(compraId, TIPO_NC) }
window.abrirModalNotaDebitoCompra  = function (compraId) { _abrirNotaCompra(compraId, TIPO_ND) }

// ── Detalle por ítem dentro de la NC de compra (devolución al proveedor) ───
// Catálogo 09 SUNAT (motivos de NC), mapeo confirmado con Luis:
//   01/02 anulación total          -> sin detalle (importe = total, ya lo maneja notas.js)
//   03 corrección de descripción   -> detalle opcional, solo informativo (no dispara guía)
//   04 descuento GLOBAL            -> sin detalle por ítem (a propósito: es monto único, no por línea)
//   05 descuento por ítem          -> detalle requerido, solo ajusta precio (NO mueve stock)
//   06 devolución total            -> detalle requerido, SÍ dispara Guía de Devolución (mueve stock)
//   07 devolución por ítem         -> detalle requerido, SÍ dispara Guía de Devolución (mueve stock)
//   08 bonificación                -> detalle requerido, solo ajusta precio (NO mueve stock)
//   09 disminución en el valor     -> detalle requerido, solo ajusta precio (NO mueve stock)
//   10 otros conceptos             -> sin detalle forzado (catch-all)
const MOTIVOS_NCC_CON_DETALLE  = ['03', '05', '06', '07', '08', '09']
const MOTIVOS_NCC_REQUERIDO    = ['05', '06', '07', '08', '09']  // 03 es opcional
const MOTIVOS_NCC_DEVOLUCION   = ['06', '07']                    // disparan Guía de Devolución

let _ncCompraLineas = []        // lotes de la compra origen, candidatos a devolver
let _ncCompraOrigenId = null

/** Arma _ncCompraLineas a partir de los lotes de la compra que la NC referencia. Solo lotes que SIGUEN existiendo y con cantidad > 0 (lo demás ya se consumió/devolvió por completo). */
async function _prepararDetalleNotaCompra(compraOrigenId) {
  _ncCompraOrigenId = compraOrigenId
  const lotes = await getLotesByCompraId(compraOrigenId)
  const lineas = []
  for (const l of (lotes || [])) {
    if ((parseFloat(l.cantidad) || 0) <= 0) continue
    const item = await getItemById(l.item_id)
    lineas.push({
      loteId: l.id, itemId: l.item_id,
      nombre: item?.nombre || `Item #${l.item_id}`,
      numeroLote: l.numero_lote,
      unidadMedida: l.unidad_medida || item?.unidad_medida || 'UND',
      cantidadDisponible: parseFloat(l.cantidad) || 0,
      precioDefault: parseFloat(l.costo_unit_original ?? l.costo_unitario) || 0
    })
  }
  _ncCompraLineas = lineas
}

/** HTML de la sección de detalle por ítem, inyectada en #nota-extra del modal genérico. */
function _renderDetalleNotaCompra() {
  if (_ncCompraLineas.length === 0) {
    return `<div id="nccDetalle-bloque" style="display:none; margin-top:6px; padding:10px 12px; border-radius:var(--radius-md); background:var(--bg-secondary); font-size:0.82rem; color:var(--text-secondary);">
      No quedan lotes disponibles de la compra origen para referenciar en el detalle (ya se consumieron o devolvieron por completo).
    </div>`
  }
  const igvDefault = String(getModuloConfig('compras').igvDefault ?? 18)
  const filas = _ncCompraLineas.map((l, idx) => `
    <tr style="border-top:1px solid var(--border-color);">
      <td style="text-align:center; width:36px; padding:8px 10px;"><input type="checkbox" id="nccDet-${idx}-chk" onchange="window.toggleLineaDetalleNotaCompra(${idx})"></td>
      <td style="padding:8px 10px;">
        <strong>${_escNcc(l.nombre)}</strong>
        <div style="color:var(--text-secondary); font-size:0.78rem;">lote ${_escNcc(l.numeroLote)}</div>
      </td>
      <td style="text-align:right; white-space:nowrap; color:var(--text-secondary); font-size:0.85rem; padding:8px 10px;">${l.cantidadDisponible} ${_escNcc(l.unidadMedida)}</td>
      <td style="width:100px; padding:8px 10px;">
        <input type="number" id="nccDet-${idx}-cantidad" value="${l.cantidadDisponible}" step="0.01" min="0.01" max="${l.cantidadDisponible}" style="width:100%;" disabled oninput="window.onCambiarLineaDetalleNotaCompra(${idx})">
      </td>
      <td style="width:110px; padding:8px 10px;">
        <input type="number" id="nccDet-${idx}-precio" value="${l.precioDefault}" step="0.0001" min="0" style="width:100%;" disabled oninput="window.onCambiarLineaDetalleNotaCompra(${idx})">
      </td>
      <td style="width:130px; padding:8px 10px;">
        <select id="nccDet-${idx}-igv" style="width:100%;" disabled onchange="window.onCambiarLineaDetalleNotaCompra(${idx})">
          <option value="18"${igvDefault === '18' ? ' selected' : ''}>18%</option>
          <option value="18-inc" title="El precio unitario ya incluye el IGV.">18% (incluido)</option>
          <option value="10"${igvDefault === '10' ? ' selected' : ''}>10%</option>
          <option value="0"${igvDefault === '0' ? ' selected' : ''}>Exonerada</option>
        </select>
      </td>
      <td style="text-align:right; padding:8px 10px; font-weight:600;" id="nccDet-${idx}-total">0.00</td>
    </tr>`).join('')

  return `
    <div id="nccDetalle-bloque" style="display:none; margin-top:10px;">
      <div id="nccDet-requerido-aviso" style="display:none; margin-bottom:10px; padding:10px 12px; border-radius:var(--radius-md); background:rgba(245,158,11,.14); color:var(--color-warning); font-size:0.82rem;">
        Este motivo exige detalle por ítem: selecciona al menos una línea.
      </div>
      <strong style="display:block; margin-bottom:4px; font-size:0.9rem;">📦 Detalle de la Nota de Crédito</strong>
      <small style="display:block; margin-bottom:10px; color:var(--text-secondary); line-height:1.4;">
        Solo puedes referenciar lotes de la compra que esta NC modifica. Si el motivo es Devolución (06/07), al emitir la NC quedará pendiente de "Guía de Devolución" en el tab Guía de Remisión — la mercadería sale del stock recién cuando emitas esa guía, no aquí.
        Los importes de la nota (arriba) se calculan solos sumando lo que marques aquí.
      </small>
      <div style="border:1px solid var(--border-color); border-radius:var(--radius-md); overflow:hidden; overflow-x:auto;">
        <table style="width:100%; border-collapse:collapse; margin:0;">
          <thead>
            <tr style="background:var(--bg-secondary);">
              <th style="width:36px;"></th>
              <th style="text-align:left; padding:8px 10px; font-size:0.78rem;">Producto / Lote</th>
              <th style="text-align:right; padding:8px 10px; font-size:0.78rem;">Disponible</th>
              <th style="text-align:left; padding:8px 10px; font-size:0.78rem;">Cantidad</th>
              <th style="text-align:left; padding:8px 10px; font-size:0.78rem;">Precio unit.</th>
              <th style="text-align:left; padding:8px 10px; font-size:0.78rem;">Tipo IGV</th>
              <th style="text-align:right; padding:8px 10px; font-size:0.78rem;">Total línea</th>
            </tr>
          </thead>
          <tbody>${filas}</tbody>
          <tfoot>
            <tr style="border-top:2px solid var(--border-color); background:var(--bg-secondary); font-weight:600;">
              <td colspan="6" style="text-align:right; padding:8px 10px;">Total seleccionado:</td>
              <td style="text-align:right; padding:8px 10px;" id="nccDet-total-general">0.00</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>`
}

function _escNcc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])) }

window.toggleLineaDetalleNotaCompra = function (idx) {
  const chk = document.getElementById(`nccDet-${idx}-chk`)
  const inpCant = document.getElementById(`nccDet-${idx}-cantidad`)
  const inpPrecio = document.getElementById(`nccDet-${idx}-precio`)
  const selIgv = document.getElementById(`nccDet-${idx}-igv`)
  if (inpCant)  inpCant.disabled = !chk?.checked
  if (inpPrecio) inpPrecio.disabled = !chk?.checked
  if (selIgv)   selIgv.disabled = !chk?.checked
  window.onCambiarLineaDetalleNotaCompra(idx)
}

/** Recalcula el total de una línea del detalle y, con eso, los 3 campos de importes de la nota (arriba, en modo lectura mientras el detalle está activo). */
window.onCambiarLineaDetalleNotaCompra = function (idx) {
  const chk = document.getElementById(`nccDet-${idx}-chk`)
  const totalCell = document.getElementById(`nccDet-${idx}-total`)
  if (!chk?.checked) {
    if (totalCell) totalCell.textContent = '0.00'
    _recalcularTotalesDetalleNotaCompra()
    return
  }
  const cantidad = parseFloat(document.getElementById(`nccDet-${idx}-cantidad`)?.value || 0)
  const precio   = parseFloat(document.getElementById(`nccDet-${idx}-precio`)?.value || 0)
  const igvValor = document.getElementById(`nccDet-${idx}-igv`)?.value || '18'
  const { total } = _calcularMontosDetalleCompra(cantidad, precio, 0, igvValor)
  if (totalCell) totalCell.textContent = total.toFixed(2)
  _recalcularTotalesDetalleNotaCompra()
}

/** Suma todas las líneas marcadas y escribe el resultado en los 3 campos de importes de la nota vía el hook que expone notas.js. */
function _recalcularTotalesDetalleNotaCompra() {
  let base = 0, igv = 0, importe = 0
  _ncCompraLineas.forEach((l, idx) => {
    const chk = document.getElementById(`nccDet-${idx}-chk`)
    if (!chk?.checked) return
    const cantidad = parseFloat(document.getElementById(`nccDet-${idx}-cantidad`)?.value || 0)
    const precio   = parseFloat(document.getElementById(`nccDet-${idx}-precio`)?.value || 0)
    const igvValor = document.getElementById(`nccDet-${idx}-igv`)?.value || '18'
    const r = _calcularMontosDetalleCompra(cantidad, precio, 0, igvValor)
    base += r.subtotal; igv += r.igvMonto; importe += r.total
  })
  const totalGeneral = document.getElementById('nccDet-total-general')
  if (totalGeneral) totalGeneral.textContent = importe.toFixed(2)
  window.setTotalesNotaDesdeDetalle?.({ base, igv, importe })
}

/** Lee del DOM lo que el usuario marcó/tipeó. Solo líneas con checkbox marcado y cantidad > 0. */
function _leerDetalleNotaCompra() {
  const seleccion = []
  _ncCompraLineas.forEach((l, idx) => {
    const chk = document.getElementById(`nccDet-${idx}-chk`)
    if (!chk?.checked) return
    const cantidad = parseFloat(document.getElementById(`nccDet-${idx}-cantidad`)?.value || 0)
    const precio   = parseFloat(document.getElementById(`nccDet-${idx}-precio`)?.value || 0)
    if (cantidad > 0) seleccion.push({ ...l, cantidad: Math.min(cantidad, l.cantidadDisponible), precioUnitario: precio })
  })
  return seleccion
}

async function _abrirNotaCompra(compraId, tipoNota) {
  try {
    const compra = await getCompraById(compraId)
    if (!compra) { showToast('No se encontró la compra', 'danger'); return }

    const numeroOrigen = `${compra.serie || ''}-${compra.numero || ''}`
    const bloqueos = []

    if (estaAnulado(compra)) {
      bloqueos.push('El comprobante ya está anulado: no se le pueden registrar notas.')
    }
    if (esNota(compra.tipo_comprobante)) {
      bloqueos.push('Este documento ya es una nota. Las notas se registran sobre facturas, no sobre otras notas.')
    }

    const todas = await getCompras()
    const notasPrevias = (todas || []).filter(c => c.compra_referencia_id === compraId && !estaAnulado(c))
    const ncPrevias = notasPrevias.filter(c => String(c.tipo_comprobante) === TIPO_NC)
      .reduce((s, c) => s + (parseFloat(c.total) || 0), 0)
    const ndPrevias = notasPrevias.filter(c => String(c.tipo_comprobante) === TIPO_ND)
      .reduce((s, c) => s + (parseFloat(c.total) || 0), 0)

    const totalOrigen = parseFloat(compra.total || 0)
    const disponibleNC = parseFloat((totalOrigen + ndPrevias - ncPrevias).toFixed(2))

    if (tipoNota === TIPO_NC && disponibleNC <= 0.01 && bloqueos.length === 0) {
      bloqueos.push(`El comprobante ya está totalmente acreditado con notas previas (${formatNumber(ncPrevias)}).`)
    }

    const cxps = await getCuentasPagarByCompra(compraId)
    const cxp = (cxps || [])[0] || null
    const saldo = cxp
      ? parseFloat(cxp.monto_total || 0) + parseFloat(cxp.monto_notas_debito || 0)
        - parseFloat(cxp.monto_notas_credito || 0) - parseFloat(cxp.monto_pagado || 0)
        - parseFloat(cxp.monto_anticipo_aplicado || 0)
      : totalOrigen

    const cfg = getModuloConfig('compras')

    // Detalle por ítem: solo tiene sentido en una NC sobre una compra de
    // mercadería (una ND nunca referencia lotes; un ajuste de servicio tampoco).
    if (tipoNota === TIPO_NC && compra.tipo_compra === 'mercaderia') {
      await _prepararDetalleNotaCompra(compraId)
    } else {
      _ncCompraLineas = []
      _ncCompraOrigenId = null
    }

    await abrirModalNota({
      tipoNota, contexto: 'compra',
      documento: `${compra.tipo_comprobante || ''} ${numeroOrigen}`.trim(),
      detalle: `${compra.proveedor_nombre || ''} · ${compra.fecha_emision || ''} · ${compra.currency || 'PEN'} ${formatNumber(totalOrigen)}`,
      totalOrigen: disponibleNC,
      saldoOrigen: saldo,
      igvPorcentaje: parseFloat(cfg.igvDefault) || 18,
      serieSugerida: '',
      numeroSugerido: '',
      bloqueos,
      anchoAmplio: tipoNota === TIPO_NC && _ncCompraLineas.length > 0,
      renderExtra: () => _renderDetalleNotaCompra(),
      onMotivoCambio: (motivo) => {
        const bloque = document.getElementById('nccDetalle-bloque')
        const conDetalle = MOTIVOS_NCC_CON_DETALLE.includes(motivo)
        if (bloque) bloque.style.display = conDetalle ? 'block' : 'none'
        const aviso = document.getElementById('nccDet-requerido-aviso')
        if (aviso) aviso.style.display = MOTIVOS_NCC_REQUERIDO.includes(motivo) ? 'block' : 'none'

        // Con detalle visible, los importes de la nota se calculan solos
        // sumando las líneas marcadas — el bloque de totales se mueve al
        // final y queda de solo lectura (window.setModoDetalleNota, en
        // notas.js). Sin detalle, vuelve a ser editable a mano arriba.
        window.setModoDetalleNota?.(conDetalle)
        if (conDetalle) _recalcularTotalesDetalleNotaCompra()
      },
      validarExtra: () => {
        const motivo = document.getElementById('notaMotivo')?.value
        if (!MOTIVOS_NCC_REQUERIDO.includes(motivo)) return { ok: true }
        const seleccion = _leerDetalleNotaCompra()
        if (seleccion.length === 0) {
          return { ok: false, mensaje: 'Este motivo exige detalle por ítem: selecciona al menos un lote de la compra origen (o cambia el motivo si no corresponde).' }
        }
        return { ok: true }
      },
      onEmitir: async (d) => {
        if (!d.serie || !d.numero) {
          throw new Error('Copia la serie y el número exactos de la nota que te envió el proveedor')
        }

        const base = parseFloat(d.base.toFixed(2))
        const igv  = parseFloat(d.igv.toFixed(2))
        const tot  = parseFloat(d.importe.toFixed(2))

        // Detalle por ítem (si el motivo lo trae) — se lee ANTES de crear la
        // NC porque el modal se cierra apenas onEmitir resuelve.
        const detalleSeleccionado = (tipoNota === TIPO_NC && MOTIVOS_NCC_CON_DETALLE.includes(d.motivo))
          ? _leerDetalleNotaCompra() : []
        const esDevolucionStock = MOTIVOS_NCC_DEVOLUCION.includes(d.motivo) && detalleSeleccionado.length > 0

        const nota = await addCompra({
          referencia:             `${tipoNota === TIPO_NC ? 'NC' : 'ND'}-${d.serie}-${d.numero}`,
          tipo_referencia:        'nota',
          tipo_comprobante:       tipoNota,
          serie:                  d.serie,
          numero:                 d.numero,
          periodo_mes:            parseInt(d.fecha.slice(5, 7)),
          periodo_ano:            parseInt(d.fecha.slice(0, 4)),
          fecha_emision:          d.fecha,
          fecha_recepcion:        d.fecha,
          contact_id:             compra.contact_id,
          proveedor_ruc:          compra.proveedor_ruc || '-',
          proveedor_nombre:       compra.proveedor_nombre || '-',
          // Se marca como 'servicio' porque una nota no ingresa mercadería:
          // si fuera 'mercaderia' el sistema le pediría Guía de Ingreso.
          tipo_compra:            'servicio',
          descripcion:            d.descripcion,
          unidad_medida:          'UND',
          cantidad:               1,
          precio_unitario:        base,
          base_imponible_gravada: base,
          igv_gravado:            igv,
          subtotal:               base,
          total:                  tot,
          currency:               compra.currency || 'PEN',
          tipo_cambio:            parseFloat(compra.tipo_cambio) || 1,
          estado_pago:            'pendiente',
          compra_referencia_id:   compraId,
          doc_referencia_tipo:    compra.tipo_comprobante,
          doc_referencia_serie:   compra.serie,
          doc_referencia_numero:  String(compra.numero || ''),
          motivo_nota_codigo:     d.motivo,
          motivo_nota_texto:      d.motivoTexto,
          estado_devolucion:      esDevolucionStock ? 'pendiente' : null,
          created_by:             d.usuarioId
        })

        // addCompra devuelve null si el INSERT falló en Supabase (RLS, CHECK,
        // NOT NULL, etc.) — sin este control la UI seguía de largo y mostraba
        // "Nota registrada ✅" aunque la fila nunca se guardó (bug real
        // encontrado 2026-09-03: al CHECK de tipo_comprobante le faltaba '07').
        if (!nota?.id) {
          throw new Error('Supabase rechazó el registro de la nota (revisa la consola del navegador para el detalle exacto). No se guardó nada.')
        }

        // Guardar el detalle por ítem (declarativo: no mueve stock). Si el
        // motivo es devolución (06/07), estado_devolucion='pendiente' ya
        // quedó marcado arriba — la Guía de Devolución es la que después
        // realmente saca la mercadería (pantalla "Devoluciones pendientes").
        if (detalleSeleccionado.length > 0 && nota?.id) {
          for (const linea of detalleSeleccionado) {
            await addNotaCreditoCompraDetalle({
              nota_compra_id: nota.id, compra_origen_id: compraId,
              item_id: linea.itemId, lote_id: linea.loteId,
              cantidad: linea.cantidad, precio_unitario: linea.precioUnitario,
              unidad_medida: linea.unidadMedida, created_by: d.usuarioId
            })
          }
        }

        // Ajustar la Cuenta por Pagar del comprobante original
        if (cxp) {
          try {
            const campos = tipoNota === TIPO_NC
              ? { monto_notas_credito: parseFloat((parseFloat(cxp.monto_notas_credito || 0) + tot).toFixed(2)) }
              : { monto_notas_debito:  parseFloat((parseFloat(cxp.monto_notas_debito || 0) + tot).toFixed(2)) }

            const nuevoSaldo = parseFloat(cxp.monto_total || 0)
              + parseFloat(cxp.monto_notas_debito || 0) + (tipoNota === TIPO_ND ? tot : 0)
              - parseFloat(cxp.monto_notas_credito || 0) - (tipoNota === TIPO_NC ? tot : 0)
              - parseFloat(cxp.monto_pagado || 0) - parseFloat(cxp.monto_anticipo_aplicado || 0)
            if (nuevoSaldo <= 0.01) campos.estado = d.anulaTotal ? 'anulado' : 'pagado'

            await updateCuentaPagar(cxp.id, campos)
          } catch (e) {
            console.warn('CxP no ajustada por la nota:', e.message)
            showToast('Nota registrada ⚠️ no se pudo ajustar la Cuenta por Pagar: ' + e.message, 'warning')
          }
        }

        // Motivo de anulación total: el comprobante original queda anulado
        if (d.anulaTotal && tipoNota === TIPO_NC) {
          await updateCompra(compraId, camposAnulacion({
            motivo: `Anulado por NC ${d.serie}-${d.numero}: ${d.motivoTexto}`,
            fecha: d.fecha, usuarioId: d.usuarioId
          }))
        }

        _invalidarCacheCompras()
        showToast(
          `${tipoNota === TIPO_NC ? 'Nota de Crédito' : 'Nota de Débito'} ${d.serie}-${d.numero} registrada ✅` +
          (d.anulaTotal ? ' — el comprobante origen quedó anulado' : ''),
          'success'
        )
        await renderCompras(true)
      }
    })
  } catch (e) {
    console.error('_abrirNotaCompra:', e)
    showToast('Error al preparar la nota: ' + e.message, 'danger')
  }
}

// ============================================================================
// GUÍA DE DEVOLUCIÓN A PROVEEDOR — segundo paso del flujo de devolución.
// ============================================================================
// La NC (arriba) solo DECLARA qué se debe devolver — no toca stock. Esta guía
// es la que de verdad lo saca: descuenta lotes.cantidad, marca bultos de peso
// variable como devuelto_proveedor, y registra Kardex salida hacia la zona
// virtual Partners/Vendors (espejo exacto de la entrada de Compras). Ver
// 53_devolucion_compra.sql y notas de diseño al inicio de _abrirNotaCompra.

/** Recalcula compras.estado_devolucion de una NC comparando lo declarado (nota_credito_compra_detalle) contra lo ya cubierto por guías de devolución. */
async function _recalcularEstadoDevolucionNota(notaCompraId) {
  const detalleNota = await getNotaCreditoCompraDetalleByNota(notaCompraId)
  if (!detalleNota || detalleNota.length === 0) return
  const totalDeclarado = detalleNota.reduce((s, d) => s + (parseFloat(d.cantidad) || 0), 0)

  const todasLasGuiasDetalle = await getTodosDetalleGuiasDevolucionCompra()
  const idsDetalleNota = new Set(detalleNota.map(d => d.id))
  const totalDevuelto = (todasLasGuiasDetalle || [])
    .filter(dg => idsDetalleNota.has(dg.nota_credito_compra_detalle_id))
    .reduce((s, dg) => s + (parseFloat(dg.cantidad) || 0), 0)

  let estado = 'pendiente'
  if (totalDevuelto >= totalDeclarado - 0.0001) estado = 'completa'
  else if (totalDevuelto > 0.0001) estado = 'parcial'

  await updateCompra(notaCompraId, { estado_devolucion: estado })
}

// ── Pantalla "Devoluciones pendientes" (dentro del tab Guía de Remisión) ───
async function renderDevolucionesPendientes(forzar = false) {
  const card = document.getElementById('card-devoluciones-pendientes')
  const container = document.getElementById('tabla-devoluciones-pendientes')
  if (!card || !container) return

  const contEmitidas = document.getElementById('tabla-guias-devolucion-emitidas')

  // La tarjeta siempre se muestra (no se oculta) — lista TODAS las NC de
  // devolución (motivo 06/07), sin importar su estado_devolucion. Si no hay
  // ninguna, se muestra un mensaje vacío pero la tarjeta se queda visible.
  card.style.display = 'block'

  const [todas, guiasEmitidas] = await Promise.all([getCompras(forzar), getGuiasDevolucionCompra(forzar)])
  const notasDevolucion = (todas || []).filter(c =>
    String(c.tipo_comprobante) === TIPO_NC && !!c.estado_devolucion && !estaAnulado(c)
  )

  if (notasDevolucion.length === 0) {
    container.innerHTML = '<p style="text-align:center; color:var(--text-secondary); padding:16px;">Aún no hay Notas de Crédito con devolución de mercadería (motivo 06/07).</p>'
  } else {
    const filas = await Promise.all(notasDevolucion.map(async nota => {
      const detalleNota = await getNotaCreditoCompraDetalleByNota(nota.id)
      const totalDeclarado = (detalleNota || []).reduce((s, d) => s + (parseFloat(d.cantidad) || 0), 0)
      const compraOrigen = nota.compra_referencia_id ? await getCompraById(nota.compra_referencia_id) : null
      return { nota, compraOrigen, itemsCount: (detalleNota || []).length, totalDeclarado }
    }))
    filas.sort((a, b) => b.nota.id - a.nota.id)

    const ESTADO_LABEL = { pendiente: 'Pendiente', parcial: 'Parcial', completa: 'Completo' }
    const ESTADO_BADGE = { pendiente: 'badge-info', parcial: 'badge-warning', completa: 'badge-success' }

    container.innerHTML = `
      <table>
        <thead>
          <tr>
            <th>Nota de Crédito</th><th>Compra origen</th><th>Proveedor</th>
            <th>Ítems declarados</th><th>Estado</th><th>Acciones</th>
          </tr>
        </thead>
        <tbody>
          ${filas.map(({ nota, compraOrigen, itemsCount, totalDeclarado }) => `
            <tr>
              <td><strong>${nota.serie || ''}-${nota.numero || ''}</strong></td>
              <td>${compraOrigen ? (compraOrigen.referencia || `Compra #${compraOrigen.id}`) : '-'}</td>
              <td>${nota.proveedor_nombre || '-'}</td>
              <td>${itemsCount} línea(s) — ${totalDeclarado.toLocaleString('en-US', { maximumFractionDigits: 2 })}</td>
              <td><span class="badge ${ESTADO_BADGE[nota.estado_devolucion] || 'badge-secondary'}">${ESTADO_LABEL[nota.estado_devolucion] || nota.estado_devolucion}</span></td>
              <td>${nota.estado_devolucion === 'completa'
                ? '<span style="color:var(--text-secondary); font-size:0.82rem;">Ya cubierta</span>'
                : `<button class="btn btn-primary btn-small" onclick="window.abrirModalGuiaDevolucion(${nota.id})">Emitir Guía de Devolución</button>`}</td>
            </tr>`).join('')}
        </tbody>
      </table>`
  }

  if (contEmitidas) {
    if (!guiasEmitidas || guiasEmitidas.length === 0) {
      contEmitidas.innerHTML = ''
    } else {
      const comprasMap = {}
      for (const c of (todas || [])) comprasMap[c.id] = c
      const ordenadas = [...guiasEmitidas].sort((a, b) => b.id - a.id)
      contEmitidas.innerHTML = `
        <strong style="display:block; margin:10px 0 6px; font-size:0.85rem;">Guías de Devolución emitidas</strong>
        <table>
          <thead><tr><th>N° Guía</th><th>Fecha</th><th>Compra origen</th><th>Proveedor</th><th>Observaciones</th><th>Acciones</th></tr></thead>
          <tbody>
            ${ordenadas.map(g => {
              const compra = comprasMap[g.compra_id]
              return `<tr>
                <td><strong>${g.numero_guia}</strong></td>
                <td>${g.fecha_guia || '-'}</td>
                <td>${compra?.referencia || `Compra #${g.compra_id}`}</td>
                <td>${compra?.proveedor_nombre || '-'}</td>
                <td>${g.observaciones || '-'}</td>
                <td class="col-acciones">${menuAccionesFila([
                  { label: 'Editar cabecera', icono: '✏️', onclick: `window.editarGuiaDevolucion(${g.id})` },
                  { label: 'Eliminar (revierte stock)', icono: '🗑️', onclick: `window.eliminarGuiaDevolucion(${g.id})`, peligro: true }
                ])}</td>
              </tr>`
            }).join('')}
          </tbody>
        </table>`
    }
  }
}

let _gdvNotaId = null
let _gdvCompraOrigenId = null
let _gdvLineas = []   // líneas pendientes de devolver de la NC seleccionada

window.abrirModalGuiaDevolucion = async function (notaCompraId) {
  try {
    const nota = await getCompraById(notaCompraId)
    if (!nota) { showToast('No se encontró la Nota de Crédito', 'danger'); return }
    if (estaAnulado(nota)) { showToast('Esta Nota de Crédito está anulada', 'warning'); return }

    const compraOrigen = nota.compra_referencia_id ? await getCompraById(nota.compra_referencia_id) : null
    _gdvNotaId = notaCompraId
    _gdvCompraOrigenId = nota.compra_referencia_id || null

    const detalleNota = await getNotaCreditoCompraDetalleByNota(notaCompraId)
    const lineas = []
    for (const d of (detalleNota || [])) {
      const yaDevuelto = (await getDetalleGuiasDevolucionCompraByNotaDetalle(d.id) || [])
        .reduce((s, dg) => s + (parseFloat(dg.cantidad) || 0), 0)
      const pendiente = parseFloat(((parseFloat(d.cantidad) || 0) - yaDevuelto).toFixed(4))
      if (pendiente <= 0.0001) continue

      const [lote, item] = await Promise.all([getLoteById(d.lote_id), getItemById(d.item_id)])
      if (!lote) continue

      if (lote.es_peso_variable) {
        const bultosLote = await getLoteBultosByLote(lote.id)
        const disponibles = (bultosLote || []).filter(b => b.estado === 'disponible')
        if (disponibles.length === 0) continue
        const zonas = await getUbicaciones()
        const zonasMap = {}
        for (const z of (zonas || [])) zonasMap[z.id] = z.nombre
        lineas.push({
          notaDetalleId: d.id, itemId: d.item_id, nombre: item?.nombre || `Item #${d.item_id}`,
          loteId: lote.id, numeroLote: lote.numero_lote, unidadMedida: lote.unidad_medida || 'KG',
          esPesoVariable: true, pendiente,
          bultos: disponibles.map(b => ({ id: b.id, peso: parseFloat(b.peso) || 0, ubicacionId: b.ubicacion_id, zonaNombre: zonasMap[b.ubicacion_id] || '?' }))
        })
      } else {
        const filasStock = await getStockUbicacionesByLote(lote.id)
        const zonas = await getUbicaciones()
        const zonasMap = {}
        for (const z of (zonas || [])) zonasMap[z.id] = z.nombre
        const zonasConStock = (filasStock || [])
          .filter(f => (parseFloat(f.cantidad) || 0) > 0)
          .map(f => ({ id: f.ubicacion_id, nombre: zonasMap[f.ubicacion_id] || '?', disponible: parseFloat(f.cantidad) || 0 }))
        if (zonasConStock.length === 0) continue
        lineas.push({
          notaDetalleId: d.id, itemId: d.item_id, nombre: item?.nombre || `Item #${d.item_id}`,
          loteId: lote.id, numeroLote: lote.numero_lote, unidadMedida: lote.unidad_medida || item?.unidad_medida || 'UND',
          esPesoVariable: false, pendiente, zonasConStock
        })
      }
    }
    _gdvLineas = lineas

    document.getElementById('gdvInfoNota').innerHTML = `
      <div style="font-size:0.72rem; text-transform:uppercase; letter-spacing:.4px; color:var(--text-secondary);">Cubre la Nota de Crédito</div>
      <div style="font-weight:600; font-size:1.05rem; margin-top:2px;">${_escGdv(nota.serie || '')}-${_escGdv(nota.numero || '')}</div>
      <div style="font-size:0.85rem; color:var(--text-secondary); margin-top:2px;">
        ${_escGdv(nota.proveedor_nombre || '-')} · Compra origen: ${compraOrigen ? _escGdv(compraOrigen.referencia || `#${compraOrigen.id}`) : '-'}
      </div>
    `
    document.getElementById('gdvNumeroGuia').value = ''
    document.getElementById('gdvFechaGuia').value = new Date().toISOString().split('T')[0]
    document.getElementById('gdvObservaciones').value = ''
    _setEvGdv('gdv-titulo-modal', 'Emitir Guía de Devolución')

    _renderTablaDetalleGuiaDevolucion()
    window.openModal('modal-guia-devolucion')
  } catch (e) {
    console.error('abrirModalGuiaDevolucion:', e)
    showToast('Error al preparar la guía de devolución: ' + e.message, 'danger')
  }
}

window.cerrarModalGuiaDevolucion = function () {
  _gdvNotaId = null; _gdvCompraOrigenId = null; _gdvLineas = []
  window.closeModal('modal-guia-devolucion')
}

function _renderTablaDetalleGuiaDevolucion() {
  const cont = document.getElementById('tabla-detalle-guia-devolucion')
  if (!cont) return
  if (_gdvLineas.length === 0) {
    cont.innerHTML = '<p style="text-align:center; color:var(--text-secondary); padding:20px;">No queda nada pendiente por devolver en esta NC (ya se cubrió con guías anteriores).</p>'
    return
  }

  const filas = _gdvLineas.map((l, idx) => {
    if (l.esPesoVariable) {
      const bultosHtml = l.bultos.map((b, bIdx) => `
        <label style="display:flex; align-items:center; gap:6px; padding:3px 0; font-weight:400; cursor:pointer;">
          <input type="checkbox" id="gdv-${idx}-b${bIdx}-chk">
          <span>Bulto #${b.id} — ${b.peso.toFixed(2)} ${_escGdv(l.unidadMedida)}</span>
          <span style="color:var(--text-secondary); font-size:0.78rem;">(${_escGdv(b.zonaNombre)})</span>
        </label>`).join('')
      return `
        <tr style="border-top:1px solid var(--border-color);">
          <td style="padding:8px 10px; vertical-align:top;">
            <strong>${_escGdv(l.nombre)}</strong>
            <div style="color:var(--text-secondary); font-size:0.78rem;">lote ${_escGdv(l.numeroLote)} · peso variable</div>
          </td>
          <td style="text-align:right; white-space:nowrap; color:var(--text-secondary); font-size:0.85rem; padding:8px 10px; vertical-align:top;">${l.pendiente} ${_escGdv(l.unidadMedida)}</td>
          <td colspan="2" style="padding:8px 10px;">${bultosHtml}</td>
        </tr>`
    }
    return `
      <tr style="border-top:1px solid var(--border-color);">
        <td style="padding:8px 10px;">
          <strong>${_escGdv(l.nombre)}</strong>
          <div style="color:var(--text-secondary); font-size:0.78rem;">lote ${_escGdv(l.numeroLote)}</div>
        </td>
        <td style="text-align:right; white-space:nowrap; color:var(--text-secondary); font-size:0.85rem; padding:8px 10px;">${l.pendiente} ${_escGdv(l.unidadMedida)}</td>
        <td style="width:120px; padding:8px 10px;">
          <input type="number" id="gdv-${idx}-cantidad" value="0" step="0.01" min="0" max="${l.pendiente}" style="width:100%;">
        </td>
        <td style="width:220px; padding:8px 10px;">
          <select id="gdv-${idx}-zona" style="width:100%;">
            ${l.zonasConStock.map(z => `<option value="${z.id}">${_escGdv(z.nombre)} (disp: ${z.disponible})</option>`).join('')}
          </select>
        </td>
      </tr>`
  }).join('')

  cont.innerHTML = `
    <div style="border:1px solid var(--border-color); border-radius:var(--radius-md); overflow:hidden; overflow-x:auto;">
      <table style="width:100%; border-collapse:collapse; margin:0;">
        <thead>
          <tr style="background:var(--bg-secondary);">
            <th style="text-align:left; padding:8px 10px; font-size:0.78rem;">Producto / Lote</th>
            <th style="text-align:right; padding:8px 10px; font-size:0.78rem;">Pendiente</th>
            <th style="text-align:left; padding:8px 10px; font-size:0.78rem;">Cantidad a devolver</th>
            <th style="text-align:left; padding:8px 10px; font-size:0.78rem;">Zona de salida</th>
          </tr>
        </thead>
        <tbody>${filas}</tbody>
      </table>
    </div>`
}

window.guardarGuiaDevolucionCompra = async function () {
  const btn = document.getElementById('btnGuardarGuiaDevolucion')
  try {
    if (!_gdvNotaId || !_gdvCompraOrigenId) { showToast('Guía inválida', 'danger'); return }
    const numeroGuia = document.getElementById('gdvNumeroGuia')?.value?.trim()
    const fechaGuia = document.getElementById('gdvFechaGuia')?.value
    const observaciones = document.getElementById('gdvObservaciones')?.value?.trim() || null
    if (!numeroGuia) { showToast('Ingresa el N° de Guía', 'warning'); return }
    if (!fechaGuia)  { showToast('Ingresa la fecha de la guía', 'warning'); return }

    const seleccionFija = []      // peso fijo: { linea, cantidad, ubicacionId }
    const seleccionVariable = []  // peso variable: { linea, bulto }
    _gdvLineas.forEach((l, idx) => {
      if (l.esPesoVariable) {
        l.bultos.forEach((b, bIdx) => {
          const chk = document.getElementById(`gdv-${idx}-b${bIdx}-chk`)
          if (chk?.checked) seleccionVariable.push({ linea: l, bulto: b })
        })
      } else {
        const cantidad = parseFloat(document.getElementById(`gdv-${idx}-cantidad`)?.value || 0)
        const ubicacionId = parseInt(document.getElementById(`gdv-${idx}-zona`)?.value || 0)
        if (cantidad > 0 && ubicacionId) seleccionFija.push({ linea: l, cantidad: Math.min(cantidad, l.pendiente), ubicacionId })
      }
    })

    if (seleccionFija.length === 0 && seleccionVariable.length === 0) {
      showToast('Selecciona o ingresa al menos una línea a devolver', 'warning')
      return
    }

    if (btn) { btn.disabled = true; btn.textContent = 'Guardando…' }
    const user = getCurrentUser()
    const usuarioId = user?.db_id || null

    const guia = await addGuiaDevolucionCompra({
      compra_id: _gdvCompraOrigenId, numero_guia: numeroGuia, fecha_guia: fechaGuia,
      observaciones, created_by: usuarioId
    })
    if (!guia?.id) throw new Error('No se pudo crear la guía')

    const vendorsZona = await getUbicacionVendors()
    const lotesTocados = new Set()

    // Líneas de peso fijo: una fila de detalle + descuento directo del lote/zona + kardex
    for (const { linea, cantidad, ubicacionId } of seleccionFija) {
      const dg = await addDetalleGuiaDevolucionCompra({
        guia_id: guia.id, nota_credito_compra_detalle_id: linea.notaDetalleId,
        item_id: linea.itemId, cantidad, numero_lote: linea.numeroLote,
        lote_id: linea.loteId, ubicacion_id: ubicacionId
      })

      const lote = await getLoteById(linea.loteId)
      const nuevaCantidad = parseFloat(Math.max(0, (parseFloat(lote?.cantidad) || 0) - cantidad).toFixed(4))
      await updateLote(linea.loteId, { cantidad: nuevaCantidad })

      const filas = await getStockUbicacionesByLote(linea.loteId)
      const fila = (filas || []).find(f => f.ubicacion_id === ubicacionId)
      if (fila) {
        await updateStockUbicacion(fila.id, { cantidad: parseFloat(Math.max(0, (parseFloat(fila.cantidad) || 0) - cantidad).toFixed(4)) })
      }

      const costoUnit = parseFloat(lote?.costo_unitario || 0)
      await addKardexMovimiento({
        item_id: linea.itemId, lote_id: linea.loteId,
        ubicacion_origen_id: ubicacionId, ubicacion_destino_id: vendorsZona?.id || null,
        fecha: fechaGuia, tipo_movimiento: 'salida', concepto: 'Devolución a proveedor (Guía de Devolución)',
        documento_referencia: numeroGuia,
        cantidad_entrada: 0, cantidad_salida: cantidad,
        cantidad_unidades_entrada: 0, cantidad_unidades_salida: 0,
        costo_unitario: costoUnit,
        valor_entrada: 0, valor_salida: parseFloat((cantidad * costoUnit).toFixed(2)),
        moneda: lote?.moneda || 'PEN', tipo_cambio: parseFloat(lote?.tipo_cambio) || 1,
        costo_unit_original: parseFloat(lote?.costo_unit_original ?? costoUnit),
        saldo_cantidad: nuevaCantidad, saldo_valor: parseFloat((nuevaCantidad * costoUnit).toFixed(2)),
        saldo_unidades: parseFloat(lote?.cantidad_unidades || 0),
        compra_id: _gdvCompraOrigenId, created_by: usuarioId
      })
    }

    // Líneas de peso variable: una fila de detalle por bulto + el bulto pasa a devuelto_proveedor
    const kardexPorZona = new Map()  // agrupa bultos por (loteId, ubicacionId) para un solo movimiento de kardex
    for (const { linea, bulto } of seleccionVariable) {
      const dg = await addDetalleGuiaDevolucionCompra({
        guia_id: guia.id, nota_credito_compra_detalle_id: linea.notaDetalleId,
        item_id: linea.itemId, cantidad: bulto.peso, numero_lote: linea.numeroLote,
        lote_id: linea.loteId, ubicacion_id: bulto.ubicacionId
      })
      await updateLoteBulto(bulto.id, {
        estado: 'devuelto_proveedor', nota_credito_compra_id: _gdvNotaId, detalle_guia_devolucion_id: dg?.id || null
      })
      lotesTocados.add(linea.loteId)

      const key = `${linea.loteId}|${bulto.ubicacionId}`
      const acc = kardexPorZona.get(key) || { itemId: linea.itemId, loteId: linea.loteId, ubicacionId: bulto.ubicacionId, cantidad: 0 }
      acc.cantidad += bulto.peso
      kardexPorZona.set(key, acc)
    }
    for (const loteId of lotesTocados) await recalcularLoteDesdeBultos(loteId)
    for (const { itemId, loteId, ubicacionId, cantidad } of kardexPorZona.values()) {
      const lote = await getLoteById(loteId)
      const costoUnit = parseFloat(lote?.costo_unitario || 0)
      await addKardexMovimiento({
        item_id: itemId, lote_id: loteId,
        ubicacion_origen_id: ubicacionId, ubicacion_destino_id: vendorsZona?.id || null,
        fecha: fechaGuia, tipo_movimiento: 'salida', concepto: 'Devolución a proveedor (Guía de Devolución)',
        documento_referencia: numeroGuia,
        cantidad_entrada: 0, cantidad_salida: cantidad,
        cantidad_unidades_entrada: 0, cantidad_unidades_salida: 0,
        costo_unitario: costoUnit,
        valor_entrada: 0, valor_salida: parseFloat((cantidad * costoUnit).toFixed(2)),
        moneda: lote?.moneda || 'PEN', tipo_cambio: parseFloat(lote?.tipo_cambio) || 1,
        costo_unit_original: parseFloat(lote?.costo_unit_original ?? costoUnit),
        saldo_cantidad: parseFloat(lote?.cantidad || 0), saldo_valor: parseFloat(((parseFloat(lote?.cantidad) || 0) * costoUnit).toFixed(2)),
        saldo_unidades: parseFloat(lote?.cantidad_unidades || 0),
        compra_id: _gdvCompraOrigenId, created_by: usuarioId
      })
    }

    await _recalcularEstadoDevolucionNota(_gdvNotaId)

    _invalidarCacheCompras()
    showToast(`Guía de Devolución ${numeroGuia} emitida ✅ — stock retirado de Inventario`, 'success')
    window.cerrarModalGuiaDevolucion()
    await renderGuias(true)
    await renderCompras(true)
  } catch (e) {
    console.error('guardarGuiaDevolucionCompra:', e)
    showToast('No se pudo guardar la guía de devolución: ' + e.message, 'danger', 7000)
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Guardar Guía (retira stock)' }
  }
}

// ── Editar (solo cabecera) / Eliminar (revierte stock) Guía de Devolución ──
window.editarGuiaDevolucion = async function (id) {
  try {
    const g = await getGuiaDevolucionCompraById(id)
    if (!g) { showToast('No se encontró la guía', 'danger'); return }
    document.getElementById('egdId').value = g.id
    document.getElementById('egdNumeroGuia').value = g.numero_guia || ''
    document.getElementById('egdFechaGuia').value = g.fecha_guia || ''
    document.getElementById('egdObservaciones').value = g.observaciones || ''
    window.openModal('modal-editar-guia-devolucion')
  } catch (e) {
    console.error('editarGuiaDevolucion:', e)
    showToast('Error al abrir la guía para editar', 'danger')
  }
}

window.guardarEdicionGuiaDevolucion = async function () {
  try {
    const id = parseInt(document.getElementById('egdId')?.value || 0)
    if (!id) { showToast('Guía inválida', 'danger'); return }
    const numeroGuia = document.getElementById('egdNumeroGuia')?.value?.trim()
    const fechaGuia = document.getElementById('egdFechaGuia')?.value
    const observaciones = document.getElementById('egdObservaciones')?.value?.trim() || null
    if (!numeroGuia) { showToast('Ingresa el N° de Guía', 'warning'); return }
    if (!fechaGuia)  { showToast('Ingresa la fecha de la guía', 'warning'); return }

    const ok = await updateGuiaDevolucionCompra(id, { numero_guia: numeroGuia, fecha_guia: fechaGuia, observaciones })
    if (!ok) { showToast('No se pudo actualizar la guía', 'danger'); return }

    showToast('Guía actualizada', 'success')
    window.closeModal('modal-editar-guia-devolucion')
    await renderGuias(true)
  } catch (e) {
    console.error('guardarEdicionGuiaDevolucion:', e)
    showToast('Error al actualizar la guía', 'danger')
  }
}

/**
 * Elimina una Guía de Devolución revirtiendo lo que había retirado:
 *   - Líneas de peso fijo: se suma la cantidad de vuelta al lote y a su zona.
 *   - Líneas de peso variable: el/los bulto(s) que esta línea marcó vuelven a
 *     'disponible' (revertirBultosDeDetalleGuiaDevolucion) y el lote se
 *     recalcula desde sus bultos reales.
 *   - Kardex: se borran los movimientos cuyo documento_referencia sea el N°
 *     de esta guía (se generaron con ese mismo número al emitirla).
 *   - La(s) NC que esta guía cubría vuelven a 'pendiente'/'parcial'.
 */
window.eliminarGuiaDevolucion = async function (id) {
  try {
    const guia = await getGuiaDevolucionCompraById(id)
    if (!guia) { showToast('No se encontró la guía', 'danger'); return }

    if (!confirm(`Se eliminará la guía ${guia.numero_guia} revirtiendo el stock retirado. ¿Continuar?`)) return

    const detalles = await getDetalleGuiasDevolucionCompra(id)
    const notasATocar = new Set()
    const lotesTocadosBultos = new Set()

    for (const dg of (detalles || [])) {
      notasATocar.add(dg.nota_credito_compra_detalle_id)

      const bultosDeEstaLinea = await getLoteBultosPorDetalleGuiaDevolucion(dg.id)
      if (bultosDeEstaLinea && bultosDeEstaLinea.length > 0) {
        await revertirBultosDeDetalleGuiaDevolucion(dg.id)
        lotesTocadosBultos.add(dg.lote_id)
      } else if (dg.lote_id) {
        const lote = await getLoteById(dg.lote_id)
        if (lote) {
          const nuevaCantidad = parseFloat(((parseFloat(lote.cantidad) || 0) + (parseFloat(dg.cantidad) || 0)).toFixed(4))
          await updateLote(dg.lote_id, { cantidad: nuevaCantidad })
          if (dg.ubicacion_id) {
            const filas = await getStockUbicacionesByLote(dg.lote_id)
            const fila = (filas || []).find(f => f.ubicacion_id === dg.ubicacion_id)
            if (fila) {
              await updateStockUbicacion(fila.id, { cantidad: parseFloat(((parseFloat(fila.cantidad) || 0) + (parseFloat(dg.cantidad) || 0)).toFixed(4)) })
            }
          }
        }
      }
    }
    for (const loteId of lotesTocadosBultos) await recalcularLoteDesdeBultos(loteId)

    // Kardex de esta guía: se identifican por documento_referencia (el N° de
    // guía, único), filtrando dentro del kardex de la compra origen.
    if (guia.compra_id) {
      const kardexCompra = await getKardexByCompra(guia.compra_id)
      for (const k of (kardexCompra || [])) {
        if (k.documento_referencia === guia.numero_guia && k.tipo_movimiento === 'salida') {
          const okKardex = await deleteKardexMovimiento(k.id)
          if (!okKardex) {
            const motivo = ultimoErrorDelete()
            throw new Error(`No se pudo eliminar el movimiento de Kardex #${k.id}: ${motivo?.mensaje || 'motivo desconocido'}. Se detiene la reversión.`)
          }
        }
      }
    }

    const ok = await deleteGuiaDevolucionCompra(id) // cascada: borra detalle_guias_devolucion_compra
    if (!ok) {
      const motivo = ultimoErrorDelete()
      throw new Error(motivo?.mensaje || 'no se pudo eliminar')
    }

    // Recalcular estado_devolucion de todas las NC que esta guía cubría.
    // Como nota_credito_compra_detalle_id ya no es resoluble tras el borrado
    // en cascada, se usa el detalle leído ANTES de eliminar.
    const notaIdsPorDetalle = {}
    for (const dg of (detalles || [])) {
      if (!(dg.nota_credito_compra_detalle_id in notaIdsPorDetalle)) {
        const d = (await getNotaCreditoCompraDetalleByCompraOrigen(guia.compra_id) || []).find(x => x.id === dg.nota_credito_compra_detalle_id)
        if (d) notaIdsPorDetalle[dg.nota_credito_compra_detalle_id] = d.nota_compra_id
      }
    }
    const notasUnicas = new Set(Object.values(notaIdsPorDetalle))
    for (const notaId of notasUnicas) await _recalcularEstadoDevolucionNota(notaId)

    _invalidarCacheCompras()
    showToast(`Guía ${guia.numero_guia} eliminada: stock revertido en Inventario`, 'success')
    await renderGuias(true)
    await renderCompras(true)
  } catch (e) {
    console.error('eliminarGuiaDevolucion:', e)
    showToast('No se pudo eliminar la guía: ' + e.message, 'danger', 7000)
  }
}

function _setEvGdv(id, texto) { const el = document.getElementById(id); if (el) el.textContent = texto }
function _escGdv(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])) }

// ============================================================================
// BUSCADORES EN VIVO — selects largos del módulo Compras
// ============================================================================
// Mismos selects que antes, pero con filtrado por texto. El <select> original
// sigue oculto detrás, así que ni las validaciones ni los onchange cambian.
// Se convierten después de que cada select ya tiene sus opciones cargadas.

function _activarBuscadoresCompras() {
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

function _escCompras(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

// ============================================================================
// LOTES EXISTENTES EN LA GUÍA DE INGRESO
// ============================================================================
// Antes, guardar una guía SIEMPRE hacía `addLote(...)`: si escribías un N° de
// lote que ya existía, quedaban dos filas en `lotes` con el mismo número y el
// stock partido entre ambas. En el Kardex (que agrupa por lote_id) el lote
// "viejo" seguía con su cantidad original y el nuevo aparecía aparte, así que
// ninguno mostraba la cantidad real del lote.
//
// Ahora el campo ofrece los lotes que ya existen del producto y, si eliges
// uno, la mercadería SE SUMA a ese lote en vez de crear otro.
//
// Identificación Específica por ADQUISICIÓN (LIR Art. 62° inciso c) / NIC 2
// párr. 24 — aprobado por contabilidad): la unidad de identificación es la
// compra/factura, no el texto que escribe el usuario en "N° de Lote". Un
// mismo texto de lote puede repetirse entre facturas distintas (common
// cuando el proveedor reutiliza su propia numeración) — eso NUNCA debe
// fusionarse ni promediarse, porque el costo real (y su tipo de cambio) es
// distinto por adquisición. Por eso _buscarLoteExistente exige tanto el
// texto del lote COMO la misma compra_id:
//   * mismo texto + misma compra  → es la misma adquisición, se suma a esa
//     fila (con aviso si el costo no cuadra, ver conflictosCosto abajo).
//   * mismo texto + compra distinta → nunca es un match: se crea una fila
//     nueva en `lotes` sin preguntar (índice único ahora es
//     (item_id, numero_lote, compra_id), ver 43_lote_bultos.sql).
function _buscarLoteExistente(itemId, numeroLote, compraId) {
  const num = String(numeroLote || '').trim().toLowerCase()
  if (!num) return null
  return (_guiaLotesPorItem[itemId] || []).find(lo =>
    String(lo.numero_lote || '').trim().toLowerCase() === num &&
    lo.compra_id === compraId) || null
}

/** Solo para el aviso en pantalla: ¿este texto de lote ya existe pero en OTRA compra? */
function _buscarLoteEnOtraCompra(itemId, numeroLote, compraId) {
  const num = String(numeroLote || '').trim().toLowerCase()
  if (!num) return null
  return (_guiaLotesPorItem[itemId] || []).find(lo =>
    String(lo.numero_lote || '').trim().toLowerCase() === num &&
    lo.compra_id !== compraId) || null
}

/** Costo unitario en soles que tendría esta recepción (para comparar con el lote existente). */
function _costoRecepcionPen(linea, compra) {
  const tc = parseFloat(compra?.tipo_cambio) || 1
  return parseFloat(((parseFloat(linea.precio_unitario) || 0) * tc).toFixed(4))
}

function _avisarLoteExistente(idx, subIdx, linea, recepcion) {
  const el = document.getElementById(`gc-${idx}-${subIdx}-loteaviso`)
  if (!el) return

  const compraId = _guiaCompraActual?.id
  const existente = _buscarLoteExistente(linea.item_id, recepcion.numero_lote, compraId)

  if (!existente) {
    const enOtraCompra = _buscarLoteEnOtraCompra(linea.item_id, recepcion.numero_lote, compraId)
    el.className = 'lote-aviso'
    if (enOtraCompra) {
      // Mismo texto de N° de lote, pero de otra factura: identificación
      // específica por adquisición → se crea como capa de costo aparte,
      // no se fusiona ni se pregunta.
      el.innerHTML = `<span style="color:var(--color-info);">↪ Este N° ya existe en otra factura (S/ ${(parseFloat(enOtraCompra.costo_unitario) || 0).toFixed(4)}). Se creará como registro aparte — no se fusiona.</span>`
    } else {
      el.innerHTML = recepcion.numero_lote
        ? '<span style="color:var(--color-success);">Lote nuevo</span>'
        : ''
    }
    return
  }

  const costoExistente = parseFloat(existente.costo_unitario) || 0
  const costoNuevo = _costoRecepcionPen(linea, _guiaCompraActual)
  const mismoCosto = Math.abs(costoExistente - costoNuevo) < 0.0001
  const zona = existente.ubicacion_id ? (_guiaZonasNombre[existente.ubicacion_id] || '') : ''

  el.className = 'lote-aviso ' + (mismoCosto ? 'ok' : 'alerta')
  el.innerHTML = mismoCosto
    ? `↪ Ya existe: ${(parseFloat(existente.cantidad) || 0).toLocaleString('en-US', { maximumFractionDigits: 2 })} ${existente.unidad_medida || 'KG'}${zona ? ' en ' + _escCompras(zona) : ''}. <strong>Se sumará a ese lote.</strong>`
    : `⚠ Ya existe con costo distinto (S/ ${costoExistente.toFixed(4)} vs S/ ${costoNuevo.toFixed(4)}). Se preguntará al guardar.`
}

// ============================================================================
// MONEDA Y TIPO DE CAMBIO EN LOS MODALES DE COMPRA
// ============================================================================
// La empresa compra casi todo importado, así que el valor por defecto es USD
// y el campo de Tipo de Cambio se muestra desde el inicio (antes había que
// cambiar la moneda para que apareciera, y como el <select> ya venía en USD
// tras un form.reset() el bloque quedaba oculto con una compra en dólares).
// Al pasar a PEN el T.C. se oculta y se fija en 1: en soles no hay conversión.

function _aplicarMonedaCompra({ idMoneda, idGrupoTC, idInputTC, idAviso, autoFetch }) {
  const moneda = document.getElementById(idMoneda)?.value || 'USD'
  const grupo  = document.getElementById(idGrupoTC)
  const inputTC = document.getElementById(idInputTC)
  const aviso  = document.getElementById(idAviso)
  const esUSD  = moneda === 'USD'

  if (grupo) grupo.style.display = esUSD ? '' : 'none'

  if (!esUSD) {
    if (inputTC) inputTC.value = '1'
    if (aviso) aviso.textContent = ''
    return
  }

  // Al volver a USD, si el T.C. quedó en 1 (valor de PEN) se intenta traer el
  // del día: un T.C. de 1 en dólares descuadraría todo el costeo en soles.
  if (inputTC && (!inputTC.value || parseFloat(inputTC.value) === 1) && typeof autoFetch === 'function') {
    autoFetch()
  }
}

// Un solo set de campos de Moneda/T.C. compartido por los 3 tipos de compra
// (Mercadería/Servicio/Anticipo) desde que se unificó el modal (2026-09-07).
window.onCambiarMonedaCompra = function () {
  _aplicarMonedaCompra({
    idMoneda: 'nqMoneda', idGrupoTC: 'nqTipoCambioGroup',
    idInputTC: 'nqTipoCambio', idAviso: 'nqTCAviso',
    autoFetch: window.autoFetchTCCompra
  })
}

/**
 * Trae el T.C. COMPRA de la SBS para la fecha del formulario.
 * Se usa COMPRA (no venta) porque el Art. 61° de la LIR manda ese tipo para
 * registrar adquisiciones; en Ventas se usa el T.C. VENTA, por eso son dos
 * funciones distintas y no una sola compartida.
 */
async function _traerTCCompraA(idInputTC, idAviso, idFecha, idBoton) {
  const campo = document.getElementById(idInputTC)
  const aviso = document.getElementById(idAviso)
  const btn   = document.getElementById(idBoton)
  if (!campo) return

  if (btn) btn.disabled = true
  if (aviso) aviso.textContent = 'Consultando SBS...'

  try {
    const fecha = document.getElementById(idFecha)?.value || null
    const result = await getTCCompra(fecha)
    if (result.error) {
      if (aviso) aviso.textContent = `⚠ ${result.error} — ingrésalo manualmente`
      return
    }
    campo.value = result.tc.toFixed(3)
    if (aviso) aviso.textContent = `T.C. Compra SBS ${result.fecha}: S/ ${result.tc.toFixed(3)} — Art. 61° LIR`
  } catch (e) {
    if (aviso) aviso.textContent = `⚠ No se pudo consultar (${e.message}) — ingrésalo manualmente`
  } finally {
    if (btn) btn.disabled = false
  }
}

window.autoFetchTCCompra = function () {
  return _traerTCCompraA('nqTipoCambio', 'nqTCAviso', 'nqFecha', 'btnAutoTCNuevaCompra')
}

// ============================================================================
// IMPORTACIÓN MASIVA DE GUÍAS DE INGRESO
// ============================================================================
// Reconstruye guías ya recibidas físicamente (típicamente al migrar desde otro
// sistema) sin tener que digitarlas una por una.
//
// A diferencia del importador de Compras — que solo crea documentos — este SÍ
// mueve stock: crea o suma lotes, escribe stock_ubicaciones y genera kardex,
// exactamente igual que `guardarGuiaIngresoCompra`. Por eso trae un modo
// SIMULACIÓN activado por defecto: valida el archivo completo y muestra qué
// pasaría, sin escribir nada. Con miles de filas, descubrir un error a mitad
// del proceso dejaría la base a medio migrar.

window.abrirModalImportarGuias = function () {
  const input = document.getElementById('fileImportarGuias')
  if (input) input.value = ''
  const chk = document.getElementById('chkSimularGuias')
  if (chk) chk.checked = true
  _html('importar-guias-resumen', '')
  _html('importar-guias-log', '')
  window.openModal('modal-importar-guias')
}

window.descargarPlantillaGuiasCompra = async function () {
  const { descargarCSV } = await import('./reportes.js')
  descargarCSV('plantilla_guias_ingreso.csv', [
    ['numero_guia', 'fecha_guia', 'compra_numero', 'sku', 'cantidad', 'numero_unidades',
     'numero_lote', 'marca', 'codigo_partida', 'almacen', 'zona', 'observaciones'],
    ['EG07-00006033', '2026-01-12', 'TCKI25628961', 'SKU-001', '24480', '680',
     'HR-Q0830721', 'BENJI', 'LT.26027', 'SJL2', 'Zona A', '(DAM) N° 118-2025-10-555842'],
    ['EG07-00006033', '2026-01-12', 'TCKI25628961', 'SKU-002', '5000', '100',
     'HR-Q0830722', 'BENJI', '', 'SJL2', 'Zona B', '']
  ])
}

function _valorFila(fila, ...nombres) {
  for (const n of nombres) {
    if (fila[n] !== undefined && fila[n] !== null && String(fila[n]).trim() !== '') return String(fila[n]).trim()
  }
  return ''
}

window.procesarImportacionGuias = async function () {
  const btn      = document.getElementById('btnProcesarImportarGuias')
  const input    = document.getElementById('fileImportarGuias')
  const simular  = !!document.getElementById('chkSimularGuias')?.checked
  if (btn?.disabled) return

  const file = input?.files?.[0]
  if (!file) { showToast('Selecciona un archivo primero', 'warning'); return }

  const log = []
  const anotar = (tipo, texto) => log.push({ tipo, texto })

  try {
    if (btn) { btn.disabled = true; btn.textContent = simular ? 'Simulando...' : 'Importando...' }
    _html('importar-guias-resumen', '<p style="color:var(--text-secondary);">Leyendo archivo...</p>')
    _html('importar-guias-log', '')

    const user = await getCurrentUser()
    if (!user) { showToast('Usuario no autenticado', 'danger'); return }

    let filas
    try {
      filas = await _leerArchivoImportGenerico(file)
    } catch (e) {
      _html('importar-guias-resumen', '<p style="color:var(--color-danger);">No se pudo leer el archivo. Verifica que sea un .xlsx o .csv válido.</p>')
      return
    }
    if (!filas?.length) {
      _html('importar-guias-resumen', '<p style="color:var(--color-danger);">El archivo no tiene filas de datos.</p>')
      return
    }

    // ── Catálogos para resolver los textos del archivo a ids ──────────────
    const [compras, items, marcas, zonas, almacenes, lotes, guiasExistentes] = await Promise.all([
      getCompras(), getItems(), getMarcas(), getUbicaciones(), getAlmacenes(), getLotes(), getGuiasIngresoCompra()
    ])

    // Una compra se puede referenciar por su N° de comprobante, por
    // serie-numero o por su referencia interna: se indexan las tres formas.
    const compraPorClave = new Map()
    for (const c of (compras || [])) {
      const claves = [c.numero, c.referencia, c.serie && c.numero ? `${c.serie}-${c.numero}` : null]
      for (const k of claves) if (k) compraPorClave.set(String(k).trim().toUpperCase(), c)
    }
    const itemPorSku   = new Map((items || []).filter(i => i.sku).map(i => [String(i.sku).trim().toUpperCase(), i]))
    const marcaPorNom  = new Map((marcas || []).map(m => [String(m.nombre || '').trim().toUpperCase(), m]))
    const almacenPorId = new Map((almacenes || []).map(a => [a.id, a]))
    const guiasYaUsadas = new Set((guiasExistentes || []).map(g => String(g.numero_guia || '').trim().toUpperCase()))

    // Zona: se busca por "almacen + zona"; si el archivo solo trae zona y su
    // nombre es único en todo el sistema, también se acepta.
    const zonaPorClave = new Map()
    const zonaPorNombreSolo = new Map()
    for (const z of (zonas || [])) {
      const alm = almacenPorId.get(z.almacen_id)
      if (alm?.es_virtual) continue   // Partners/Vendors no es una zona real de recepción
      zonaPorClave.set(`${String(alm?.nombre || '').trim().toUpperCase()}|${String(z.nombre || '').trim().toUpperCase()}`, z)
      const soloNombre = String(z.nombre || '').trim().toUpperCase()
      zonaPorNombreSolo.set(soloNombre, zonaPorNombreSolo.has(soloNombre) ? null : z) // null = ambiguo
    }

    const lotePorItemNumero = new Map()
    for (const l of (lotes || [])) {
      if (!l.item_id || !l.numero_lote) continue
      lotePorItemNumero.set(`${l.item_id}|${String(l.numero_lote).trim().toUpperCase()}`, l)
    }

    // ── Agrupar por N° de guía, preservando el orden de aparición ─────────
    const grupos = new Map()
    filas.forEach((fila, i) => {
      const numeroGuia = _valorFila(fila, 'numero_guia', 'numero guia', 'guia', 'nro_guia')
      if (!numeroGuia) { anotar('error', `Fila ${i + 2}: sin numero_guia, se omite`); return }
      const clave = numeroGuia.toUpperCase()
      if (!grupos.has(clave)) grupos.set(clave, { numeroGuia, filas: [] })
      grupos.get(clave).filas.push({ fila, nroFila: i + 2 })
    })

    // ── Validar TODO antes de escribir nada ───────────────────────────────
    const guiasValidas = []
    let filasConError = 0

    for (const [clave, grupo] of grupos) {
      const errores = []

      if (guiasYaUsadas.has(clave)) {
        errores.push(`la guía ${grupo.numeroGuia} ya existe en el sistema`)
      }

      const primera = grupo.filas[0].fila
      const compraClave = _valorFila(primera, 'compra_numero', 'compra', 'numero_comprobante', 'referencia').toUpperCase()
      const compra = compraPorClave.get(compraClave)
      if (!compra) errores.push(`no se encontró la compra "${compraClave || '(vacío)'}"`)

      const fechaGuia = _parseFechaImportGenerico(_valorFila(primera, 'fecha_guia', 'fecha'))
      if (!fechaGuia) errores.push('fecha_guia inválida o vacía')

      const observaciones = _valorFila(primera, 'observaciones', 'observacion') || null

      // Detalle de la compra: cada línea del archivo debe corresponder a un
      // producto realmente comprado, para poder enlazar detalle_compra_id.
      const detallesCompra = compra ? await getCompraDetalles(compra.id) : []
      const detallePorItem = new Map()
      for (const d of (detallesCompra || [])) if (d.item_id) detallePorItem.set(d.item_id, d)

      const lineas = []
      // Reserva local: si dos filas usan el mismo lote nuevo, la segunda debe
      // saber que la primera ya lo va a crear (si no, se crearía dos veces).
      const lotesNuevosEnEsteArchivo = new Set()

      for (const { fila, nroFila } of grupo.filas) {
        const errFila = []

        const sku  = _valorFila(fila, 'sku', 'codigo', 'producto').toUpperCase()
        const item = itemPorSku.get(sku)
        if (!item) errFila.push(`SKU "${sku || '(vacío)'}" no existe`)

        const cantidad = parseFloat(_valorFila(fila, 'cantidad', 'cantidad_kg', 'kg') || 0)
        if (!(cantidad > 0)) errFila.push('cantidad debe ser mayor a 0')

        const unidades = parseFloat(_valorFila(fila, 'numero_unidades', 'unidades', 'n_unidades') || 0) || null
        // Obligatorio (mismo motivo que en el formulario manual): sin esto
        // peso_por_unidad queda null y el lote nunca podrá sugerir unidades
        // al vender. Causó un bug de 13 lotes corregido el 05/09/2026.
        if (!(unidades > 0)) errFila.push('falta numero_unidades (obligatorio, mayor a 0)')

        const numeroLote = _valorFila(fila, 'numero_lote', 'lote')
        if (!numeroLote) errFila.push('falta numero_lote')

        const marcaNom = _valorFila(fila, 'marca').toUpperCase()
        // La marca del producto sirve de respaldo si el archivo no la trae.
        const marca = marcaPorNom.get(marcaNom) || (item?.marca_id ? { id: item.marca_id } : null)
        if (!marca) errFila.push(`marca "${marcaNom || '(vacío)'}" no existe y el producto no tiene marca por defecto`)

        const almacenNom = _valorFila(fila, 'almacen', 'almacén').toUpperCase()
        const zonaNom    = _valorFila(fila, 'zona', 'ubicacion', 'ubicación').toUpperCase()
        let zona = zonaPorClave.get(`${almacenNom}|${zonaNom}`)
        if (!zona && !almacenNom && zonaNom) {
          const unica = zonaPorNombreSolo.get(zonaNom)
          if (unica === null) errFila.push(`la zona "${zonaNom}" existe en varios almacenes: indica también la columna almacen`)
          else zona = unica
        }
        if (!zona) errFila.push(`no se encontró la zona "${almacenNom ? almacenNom + ' / ' : ''}${zonaNom || '(vacío)'}"`)

        const detalleCompra = item ? detallePorItem.get(item.id) : null
        if (compra && item && !detalleCompra) {
          errFila.push(`el producto ${item.nombre} no figura en el detalle de la compra ${compra.numero || compra.referencia}`)
        }

        // ¿El lote ya existe? Si sí, se sumará; si no, se creará.
        const claveLote = item ? `${item.id}|${numeroLote.toUpperCase()}` : null
        const loteExistente = claveLote ? lotePorItemNumero.get(claveLote) : null
        const yaEnArchivo = claveLote ? lotesNuevosEnEsteArchivo.has(claveLote) : false
        if (claveLote && !loteExistente) lotesNuevosEnEsteArchivo.add(claveLote)

        if (errFila.length > 0) {
          filasConError++
          anotar('error', `Fila ${nroFila} (guía ${grupo.numeroGuia}): ${errFila.join(' · ')}`)
          continue
        }

        lineas.push({
          nroFila, item, cantidad, unidades, numeroLote,
          marcaId: marca.id,
          codigoPartida: _valorFila(fila, 'codigo_partida', 'partida') || null,
          zona, detalleCompra,
          loteExistenteId: loteExistente?.id || null,
          seSumaALoteExistente: !!loteExistente || yaEnArchivo
        })
      }

      if (errores.length > 0 || lineas.length === 0) {
        anotar('error', `Guía ${grupo.numeroGuia}: ${errores.length ? errores.join(' · ') : 'sin líneas válidas'} — no se importará`)
        continue
      }

      guiasValidas.push({ numeroGuia: grupo.numeroGuia, fechaGuia, compra, observaciones, lineas })
      guiasYaUsadas.add(clave)  // evita duplicados dentro del mismo archivo
    }

    // ── Resumen ───────────────────────────────────────────────────────────
    const totalLineas = guiasValidas.reduce((s, g) => s + g.lineas.length, 0)
    const totalKg     = guiasValidas.reduce((s, g) => s + g.lineas.reduce((s2, l) => s2 + l.cantidad, 0), 0)
    const lotesNuevos = guiasValidas.reduce((s, g) => s + g.lineas.filter(l => !l.seSumaALoteExistente).length, 0)
    const lotesSumados = totalLineas - lotesNuevos

    if (guiasValidas.length === 0) {
      _html('importar-guias-resumen',
        `<p style="color:var(--color-danger);">Ninguna guía se puede importar. Revisa el detalle de abajo.</p>`)
      _pintarLogImport('importar-guias-log', log)
      return
    }

    if (simular) {
      _html('importar-guias-resumen', `
        <div style="padding:12px 14px; background:var(--bg-secondary); border-radius:var(--radius-md); border-left:3px solid var(--color-info);">
          <strong>Simulación — no se grabó nada</strong>
          <div style="margin-top:8px; font-size:0.88rem; line-height:1.7;">
            Guías a crear: <strong>${guiasValidas.length}</strong><br>
            Líneas: <strong>${totalLineas}</strong> · Cantidad total: <strong>${formatQty(totalKg)}</strong><br>
            Lotes nuevos: <strong>${lotesNuevos}</strong> · Se sumarán a lotes existentes: <strong>${lotesSumados}</strong><br>
            ${filasConError > 0 ? `<span style="color:var(--color-danger);">Filas con error que se omitirán: <strong>${filasConError}</strong></span>` : '<span style="color:var(--color-success);">Sin errores ✅</span>'}
          </div>
          <div style="margin-top:10px; font-size:0.85rem; color:var(--text-secondary);">
            Si el resultado es correcto, desmarca "Simular primero" y vuelve a procesar.
          </div>
        </div>`)
      _pintarLogImport('importar-guias-log', log)
      return
    }

    // ── Escritura real ────────────────────────────────────────────────────
    let creadas = 0, fallidas = 0
    const vendorsZona = await getUbicacionVendors()

    for (const g of guiasValidas) {
      try {
        const guia = await addGuiaIngresoCompra({
          compra_id: g.compra.id, numero_guia: g.numeroGuia, fecha_guia: g.fechaGuia,
          observaciones: g.observaciones, created_by: user.db_id
        })
        if (!guia?.id) throw new Error('no se pudo crear la cabecera de la guía')

        const monedaCompra = g.compra.currency || 'PEN'
        const tcCompra = parseFloat(g.compra.tipo_cambio) || 1

        for (const l of g.lineas) {
          const costoOriginal = parseFloat(l.detalleCompra?.precio_unitario) || 0
          const costoPen = parseFloat((costoOriginal * tcCompra).toFixed(4))
          const pesoPorUnidad = l.unidades > 0 ? parseFloat((l.cantidad / l.unidades).toFixed(4)) : null

          // Se relee el lote por si otra línea de este mismo archivo ya lo creó.
          const claveLote = `${l.item.id}|${l.numeroLote.toUpperCase()}`
          let lote = lotePorItemNumero.get(claveLote) || null
          let cantidadResultante = l.cantidad
          let costoFinal = costoPen

          if (lote) {
            const fresco = await getLoteById(lote.id)
            const cantPrevia = parseFloat(fresco?.cantidad) || 0
            const unidPrevias = parseFloat(fresco?.cantidad_unidades) || 0
            cantidadResultante = parseFloat((cantPrevia + l.cantidad).toFixed(4))
            const unidadesResultantes = parseFloat((unidPrevias + (l.unidades || 0)).toFixed(4))
            const costoPrevio = parseFloat(fresco?.costo_unitario) || 0
            costoFinal = cantidadResultante > 0
              ? parseFloat((((cantPrevia * costoPrevio) + (l.cantidad * costoPen)) / cantidadResultante).toFixed(4))
              : costoPen

            await updateLote(lote.id, {
              cantidad: cantidadResultante,
              cantidad_unidades: unidadesResultantes,
              costo_unitario: costoFinal,
              peso_por_unidad: unidadesResultantes > 0
                ? parseFloat((cantidadResultante / unidadesResultantes).toFixed(4))
                : fresco?.peso_por_unidad
            })
          } else {
            lote = await addLote({
              item_id: l.item.id, proveedor_id: g.compra.contact_id || null,
              numero_lote: l.numeroLote, numero_factura: g.compra.numero || null,
              codigo_partida: l.codigoPartida, marca_id: l.marcaId,
              costo_unitario: costoPen, moneda: monedaCompra, tipo_cambio: tcCompra,
              costo_unit_original: costoOriginal, costo_estado: 'definitivo',
              cantidad: l.cantidad, unidad_medida: l.detalleCompra?.unidad_medida || 'KG',
              cantidad_unidades: l.unidades, peso_por_unidad: pesoPorUnidad,
              es_peso_variable: false, ubicacion_id: l.zona.id,
              fecha_ingreso: g.fechaGuia, compra_id: g.compra.id, guia_id: guia.id,
              created_by: user.db_id
            })
            if (lote?.id) lotePorItemNumero.set(claveLote, lote)
          }

          if (!lote?.id) throw new Error(`no se pudo resolver el lote ${l.numeroLote}`)

          // Stock por zona: suma si ya había en esa zona, si no crea la fila.
          const filas = await getStockUbicacionesByLote(lote.id)
          const fila = (filas || []).find(f => f.ubicacion_id === l.zona.id)
          if (fila) {
            await updateStockUbicacion(fila.id, {
              cantidad: parseFloat(((parseFloat(fila.cantidad) || 0) + l.cantidad).toFixed(4)),
              cantidad_unidades: parseFloat(((parseFloat(fila.cantidad_unidades) || 0) + (l.unidades || 0)).toFixed(4))
            })
          } else {
            await addStockUbicacion({
              lote_id: lote.id, ubicacion_id: l.zona.id,
              cantidad: l.cantidad, cantidad_unidades: l.unidades || 0
            })
          }

          const valorLinea = parseFloat((l.cantidad * costoPen).toFixed(2))
          await addKardexMovimiento({
            item_id: l.item.id, lote_id: lote.id,
            ubicacion_origen_id: vendorsZona?.id || null,
            ubicacion_destino_id: l.zona.id,
            fecha: g.fechaGuia, tipo_movimiento: 'entrada',
            concepto: 'Compra - ingreso a almacén (importado)',
            documento_referencia: g.numeroGuia,
            cantidad_entrada: l.cantidad, cantidad_salida: 0,
            cantidad_unidades_entrada: l.unidades || 0, cantidad_unidades_salida: 0,
            costo_unitario: costoPen, valor_entrada: valorLinea, valor_salida: 0,
            moneda: monedaCompra, tipo_cambio: tcCompra, costo_unit_original: costoOriginal,
            saldo_cantidad: cantidadResultante,
            saldo_valor: parseFloat((cantidadResultante * costoFinal).toFixed(2)),
            saldo_unidades: l.unidades || 0,
            compra_id: g.compra.id, created_by: user.db_id
          })

          await addDetalleGuiaIngresoCompra({
            guia_id: guia.id, detalle_compra_id: l.detalleCompra?.id || null,
            item_id: l.item.id, cantidad: l.cantidad, numero_lote: l.numeroLote,
            marca_id: l.marcaId, codigo_partida: l.codigoPartida,
            ubicacion_id: l.zona.id, lote_id: lote.id
          })
        }

        creadas++
        anotar('ok', `Guía ${g.numeroGuia}: ${g.lineas.length} línea(s) importada(s)`)
      } catch (e) {
        fallidas++
        anotar('error', `Guía ${g.numeroGuia}: ${e.message}`)
      }
    }

    _html('importar-guias-resumen', `
      <div style="padding:12px 14px; background:var(--bg-secondary); border-radius:var(--radius-md); border-left:3px solid ${fallidas ? 'var(--color-warning)' : 'var(--color-success)'};">
        <strong>Importación terminada</strong>
        <div style="margin-top:8px; font-size:0.88rem; line-height:1.7;">
          Guías creadas: <strong style="color:var(--color-success);">${creadas}</strong><br>
          Guías con error: <strong style="color:${fallidas ? 'var(--color-danger)' : 'var(--text-secondary)'};">${fallidas}</strong><br>
          Filas omitidas por validación: <strong>${filasConError}</strong>
        </div>
      </div>`)
    _pintarLogImport('importar-guias-log', log)

    _invalidarCacheCompras()
    await _cargarComprasConGuia(true)
    await renderGuias(true)
    await renderCompras(true)
    showToast(`${creadas} guía(s) importada(s)`, creadas ? 'success' : 'warning')
  } catch (error) {
    console.error('procesarImportacionGuias:', error)
    _html('importar-guias-resumen', `<p style="color:var(--color-danger);">Error inesperado: ${_escCompras(error.message)}</p>`)
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Procesar' }
  }
}

/** Log compartido por los importadores: errores primero, con scroll. */
function _pintarLogImport(idContenedor, log) {
  const errores = log.filter(l => l.tipo === 'error')
  const oks     = log.filter(l => l.tipo === 'ok')
  _html(idContenedor, [
    ...errores.map(l => `<div style="padding:4px 0; color:var(--color-danger);">✕ ${_escCompras(l.texto)}</div>`),
    ...oks.map(l => `<div style="padding:4px 0; color:var(--color-success);">✓ ${_escCompras(l.texto)}</div>`)
  ].join('') || '<div style="color:var(--text-secondary);">Sin observaciones.</div>')
}

function _html(id, contenido) { const el = document.getElementById(id); if (el) el.innerHTML = contenido }
