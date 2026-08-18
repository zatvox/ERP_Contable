// ============================================================================
// COMPRAS.JS - Módulo Compras (Versión Async/Await Completa)
// ============================================================================

import { getCurrentUser } from './auth-supabase.js'
import {  getOrderCompras, getOrderComprasPage, getOrderCompraById, addOrderCompra, updateOrderCompra,
          getCompras, getComprasPage, getCompraById, addCompra, addCompraDetalle, updateCompra, deleteCompra,
          getCompraDetalles, deleteCompraDetalle,
          getOrderCompraDetalles, getOrderCompraDetalleById, addOrderCompraDetalle, updateOrderCompraDetalle, deleteOrderCompraDetalle,
          getLoteById, getLotesByItemId, getLotesByCompraId, getLotes, addLote, updateLote, deleteLote,
          getItems, getItemById, addItem, updateItem, deleteItem,
          getSuppliers, addContact, getContactById, updateContact, deleteContact, tiposDeContacto,
          getCategorias, addCategoria, getMarcas, getPartidas, getCuentasGasto,
          getTipoDocumentos,
          getGuiasIngresoCompra, getGuiaIngresoCompraById, addGuiaIngresoCompra, updateGuiaIngresoCompra, deleteGuiaIngresoCompra,
          getDetalleGuiasIngresoCompra, addDetalleGuiaIngresoCompra,
          getAlmacenes, getUbicaciones, addStockUbicacion,
          getUbicacionVendors, addKardexMovimiento, getKardexByCompra, deleteKardexMovimiento,
          getTipoDocumentosMap, getNombreTipoDocumentoSync, cargarSelectTipoDocumentos,
          addCuentaPagar, getCuentasPagarByCompra, updateCuentaPagar, deleteCuentaPagar, addCuotaPagar,
          getPagosProveedoresByCompra, getPagosProveedoresByCxP, deletePagoProveedor, ultimoErrorDelete,
          updateStockUbicacion, getStockUbicacionesByLote,
          reversarAsiento, generarAsientoCompra, generarAsientoGuiaRemision,
          subirAdjuntoCompra, getUrlAdjuntoCompra, eliminarAdjuntoCompra} from './supabase-data.js'
import { ASIENTOS_AUTO_COMPRAS_ACTIVO } from './config-asientos-auto.js'
import { getTCCompra } from './sunat-api.js'
import { showToast, formatNumber, formatQty } from './helpers.js'
import { initModuleNavDropdowns, initSubtabs, menuAccionesFila } from './main.js'
import { abrirModalAnulacion, camposAnulacion, estaAnulado, badgeAnulado, ESTILO_FILA_ANULADA } from './anulacion.js'
import { abrirModalNota, TIPO_NC, TIPO_ND, esNota, signoDocumento, badgeTipoDocumento } from './notas.js'
import { convertirVarios, refrescarBuscador } from './buscador-select.js'
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
 * comprobante '01' (factura), espejo exacto de lo que ventas.js hace con
 * cuentas_cobrar al facturar. Se llama justo después de addCompra() en los
 * 4 flujos que registran una compra. Las Guías (de Remisión) NUNCA llaman
 * esto — solo mueven stock, no generan ni tocan CxP.
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
  if (!compra?.id || compra.tipo_comprobante !== '01') return
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
      // (OC en standby), así que queda null en vez de igualarse a cantidad.
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
        cantidad_unidades: null,
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

function _thOrdenable(label, campo, sortState, funcOrdenar) {
  return `<th style="cursor:pointer; user-select:none;" onclick="window.${funcOrdenar}('${campo}')" title="Ordenar por ${label}">${label}${_flechaOrden(sortState, campo)}</th>`
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

    const [, comprasConGuia] = await Promise.all([
      getTipoDocumentosMap(),         // cacheado; garantiza nombres de tipo doc en carga lazy
      _cargarComprasConGuia()
    ])

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
            ${_thOrdenable('Id', 'id', _compSort, 'ordenarCompras')}
            ${_thOrdenable('Proveedor', 'proveedor', _compSort, 'ordenarCompras')}
            ${_thOrdenable('Fecha Emisión', 'fecha_emision', _compSort, 'ordenarCompras')}
            ${_thOrdenable('Comprobante', 'comprobante', _compSort, 'ordenarCompras')}
            ${_thOrdenable('Referencia', 'referencia', _compSort, 'ordenarCompras')}
            ${_thOrdenable('Descripcion', 'descripcion', _compSort, 'ordenarCompras')}
            ${_thOrdenable('Periodo', 'periodo', _compSort, 'ordenarCompras')}
            ${_thOrdenable('Tipo Documento', 'tipo_comprobante', _compSort, 'ordenarCompras')}
            ${_thOrdenable('Total', 'total', _compSort, 'ordenarCompras')}
            ${_thOrdenable('Estado Pago', 'estado_pago', _compSort, 'ordenarCompras')}
            <th>Stock</th>
            <th>Acciones</th>
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
      const badgeStock = c.tipo_compra !== 'mercaderia'
        ? '<span class="badge badge-secondary">N/A (servicio)</span>'
        : (tieneGuia
            ? '<span class="badge badge-success">✓ Con Guía</span>'
            : '<span class="badge badge-warning">⏳ Pendiente Guía</span>')

      const anulada = estaAnulado(c)

      html += `
        <tr${anulada ? ` style="${ESTILO_FILA_ANULADA}"` : ''}>
          <td><strong>${c.id}</strong></td>
          <td>${c.proveedor_nombre || '-'}</td>
          <td>${c.fecha_emision || '-'}</td>
          <td>${comprobante}</td>
          <td>${referencia || '-'}</td>
          <td>${c.descripcion || '-'}</td>
          <td>${periodo}</td>
          <td>${esNota(c.tipo_comprobante)
                ? `${badgeTipoDocumento(c.tipo_comprobante)}${c.compra_referencia_id ? `<br><small style="color:var(--text-secondary);">ref. ${c.doc_referencia_serie || ''}-${c.doc_referencia_numero || ''}</small>` : ''}`
                : (c.tipo_comprobante ? `${c.tipo_comprobante} - ${getNombreTipoDocumentoSync(c.tipo_comprobante)}` : '-')}</td>
          <td><strong style="${signoDocumento(c.tipo_comprobante) < 0 ? 'color:var(--color-danger);' : ''}">${formatNumber((parseFloat(c.total) || 0) * signoDocumento(c.tipo_comprobante))} ${c.currency || 'PEN'}</strong></td>
          <td>${anulada ? badgeAnulado(c) : `<span class="badge badge-${badgePago}">${c.estado_pago || 'pendiente'}</span>`}</td>
          <td>${anulada ? '<span class="badge badge-secondary">—</span>' : badgeStock}${c.adjunto_url ? ' <span title="Tiene documento adjunto">📎</span>' : ''}</td>
          <td class="col-acciones" style="text-decoration:none; opacity:1;">
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

// ─── Editar Compra (solo cabecera: no se tocan cantidades/lotes ya ingresados) ──

window.editarCompra = async function (id) {
  try {
    const { getById } = await import('./supabase-client.js')
    const c = await getById('compras', id)
    if (!c) { showToast('No se encontró la compra', 'danger'); return }

    document.getElementById('ecId').value = c.id
    document.getElementById('ecReferencia').value = c.referencia || ''
    document.getElementById('ecFechaEmision').value = c.fecha_emision || ''
    document.getElementById('ecFechaRecepcion').value = c.fecha_recepcion || ''
    document.getElementById('ecNumeroComprobante').value = c.numero || ''
    document.getElementById('ecEstadoPago').value = c.estado_pago || 'pendiente'
    document.getElementById('ecMoneda').value = c.currency || 'PEN'
    document.getElementById('ecTipoCambio').value = c.tipo_cambio || 1

    window.openModal('modal-editar-compra')
  } catch (error) {
    console.error('Error en editarCompra:', error)
    showToast('Error al abrir la compra para editar', 'danger')
  }
}

window.guardarEdicionCompra = async function () {
  try {
    const id = parseInt(document.getElementById('ecId')?.value || 0)
    if (!id) { showToast('Compra inválida', 'danger'); return }

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

    const actualizado = await updateCompra(id, {
      referencia,
      fecha_emision: fechaEmision,
      fecha_recepcion: fechaRecepcion,
      numero,
      estado_pago: estadoPago,
      currency: moneda,
      tipo_cambio: tipoCambio
    })

    if (!actualizado) { showToast('No se pudo actualizar la compra', 'danger'); return }

    showToast('Compra actualizada', 'success')
    window.closeModal('modal-editar-compra')
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
    const kardexCompra = await getKardexByCompra(id)
    for (const k of (kardexCompra || [])) {
      await deleteKardexMovimiento(k.id)
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
            <th style="width:32px;"><input type="checkbox" id="selAllGuias" onchange="window.toggleSeleccionTodasGuias(this.checked)" title="Seleccionar todas"></th>
            ${_thOrdenable('N° Guía', 'numero_guia', _guiaSort, 'ordenarGuias')}
            ${_thOrdenable('Fecha', 'fecha_guia', _guiaSort, 'ordenarGuias')}
            ${_thOrdenable('Compra (Referencia)', 'referencia', _guiaSort, 'ordenarGuias')}
            ${_thOrdenable('Proveedor', 'proveedor', _guiaSort, 'ordenarGuias')}
            ${_thOrdenable('# Productos', 'num_productos', _guiaSort, 'ordenarGuias')}
            <th>Producto(s) / Lote(s)</th>
            <th>Marca(s)</th><th>Almacén / Zona(s)</th>
            ${_thOrdenable('Observaciones', 'observaciones', _guiaSort, 'ordenarGuias')}
            <th>Estado</th>
            <th>Acciones</th>
          </tr>
        </thead>
        <tbody>
    `

    listaFiltrada.forEach(({ g, compra, detalles, productosLote, marcasTexto, zonasTexto }) => {
      const gAnulada = estaAnulado(g)
      html += `
        <tr${gAnulada ? ` style="${ESTILO_FILA_ANULADA}"` : ''}>
          <td style="text-decoration:none; opacity:1;">${gAnulada
            ? `<input type="checkbox" disabled title="Guía anulada: su stock ya fue retirado">`
            : `<input type="checkbox" class="gi-sel" value="${g.id}" onchange="window.actualizarBotonEliminarGuias()">`}</td>
          <td><strong>${g.numero_guia}</strong></td>
          <td>${g.fecha_guia || '-'}</td>
          <td>${compra?.referencia || `Compra #${g.compra_id}`}</td>
          <td>${compra?.proveedor_nombre || '-'}</td>
          <td style="text-align:center;">${(detalles || []).length}</td>
          <td><div class="clamp-lineas" title="${(productosLote || '').replace(/"/g, '&quot;')}">${productosLote}</div></td>
          <td>${marcasTexto}</td>
          <td>${zonasTexto}</td>
          <td>${g.observaciones || '-'}</td>
          <td>${gAnulada ? badgeAnulado(g) : '<span class="badge badge-success">Emitida</span>'}</td>
          <td class="col-acciones" style="text-decoration:none; opacity:1;">
            ${menuAccionesFila(gAnulada
              ? [{ label: 'Ver motivo de anulación', icono: 'ℹ️', onclick: `window.verMotivoAnulacionCompra('guia', ${g.id})` }]
              : [
                  { label: 'Editar', icono: '✏️', onclick: `window.editarGuia(${g.id})` },
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
async function _eliminarGuiaIngresoCore(id, pedirConfirmacion = true) {
  {
    const detalles = await getDetalleGuiasIngresoCompra(id)

    const vendidos = []
    const lotesABorrar = []     // lotes creados por ESTA guía: se eliminan enteros
    const lotesADescontar = []  // lotes preexistentes a los que esta guía sumó: se restan

    for (const dg of (detalles || [])) {
      if (!dg.lote_id) continue
      const lote = await getLoteById(dg.lote_id)
      if (!lote) continue // ya no existe: nada que revertir para esta línea

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
        `Anula/ajusta esas ventas para devolver el stock antes de eliminarla`
      )
    }

    if (pedirConfirmacion && !confirm(
      `Se eliminará la guía revirtiendo el stock ingresado:\n` +
      `  • ${lotesABorrar.length} lote(s) creados por esta guía se eliminarán.\n` +
      `  • ${lotesADescontar.length} lote(s) preexistentes solo se descontarán.\n\n¿Continuar?`
    )) return { cancelado: true }

    // Kardex: se borran las filas de los lotes que se van a eliminar (aún
    // en pruebas — sin esto quedarían movimientos "fantasma" de lotes que
    // ya no existen). Se filtra por compra_id + lote_id para no tocar
    // movimientos de OTRAS guías de la misma compra.
    const guiaActual = await getGuiaIngresoCompraById(id)
    if (guiaActual?.compra_id && lotesABorrar.length > 0) {
      const kardexCompra = await getKardexByCompra(guiaActual.compra_id)
      for (const k of (kardexCompra || [])) {
        if (lotesABorrar.includes(k.lote_id)) await deleteKardexMovimiento(k.id)
      }
    }

    // Lotes preexistentes: se resta lo que esta guía aportó, a ellos y a su
    // fila de stock_ubicaciones de la zona correspondiente.
    for (const d of lotesADescontar) {
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

    for (const loteId of lotesABorrar) {
      await deleteLote(loteId) // stock_ubicaciones de ese lote se borra solo (ON DELETE CASCADE)
    }

    const ok = await deleteGuiaIngresoCompra(id) // detalle_guias_ingreso_compra se borra solo (ON DELETE CASCADE)
    if (!ok) {
      const motivo = ultimoErrorDelete()
      throw new Error(motivo?.mensaje || 'no se pudo eliminar')
    }

    return { cancelado: false, lotesBorrados: lotesABorrar.length, lotesDescontados: lotesADescontar.length }
  }
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
    const form = document.getElementById('formNuevaGuia')
    if (form) form.reset()
    document.getElementById('ngInfoCompra').style.display = 'none'
    document.getElementById('ngFechaGuia').value = new Date().toISOString().split('T')[0]
    document.getElementById('tabla-detalle-guia').innerHTML =
      '<p style="text-align:center; color:var(--text-secondary); padding:20px;">Selecciona una compra para ver sus productos.</p>'

    await _cargarComprasSelectGuia()
    window.openModal('modal-nueva-guia')
  } catch (error) {
    console.error('Error en abrirModalNuevaGuia:', error)
    showToast('Error al abrir el formulario de guía', 'danger')
  }
}

async function _cargarComprasSelectGuia() {
  const select = document.getElementById('ngCompra')
  if (!select) return

  // Solo compras de mercadería, y solo las que AÚN NO tienen guía
  // registrada (forzar:true para no mostrar como "pendiente" una compra a
  // la que se le acaba de crear/eliminar una guía en esta misma sesión).
  const [{ data: compras }, comprasConGuia] = await Promise.all([
    getComprasPage({ pagina: 1, porPagina: 500 }),
    _cargarComprasConGuia(true)
  ])
  _guiaComprasCache = (compras || []).filter(c => c.tipo_compra === 'mercaderia' && !comprasConGuia.has(c.id))

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
    // Lote" para poder recibir más mercadería sobre un lote abierto en vez de
    // crear un duplicado con el mismo número (que era el bug: quedaban dos
    // filas de `lotes` con el mismo numero_lote y el stock partido entre
    // ambas, así que el kardex del lote no reflejaba la cantidad real).
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

    _guiaLineas = (detalles || []).map(d => {
      const marcaDefault = itemsMap[d.item_id]?.marca_id || null
      return {
        detalle_compra_id: d.id,
        item_id:            d.item_id,
        nombre:              itemsMap[d.item_id]?.nombre || `Item #${d.item_id}`,
        unidad_medida:       d.unidad_medida,
        cantidad_comprada:   parseFloat(d.cantidad) || 0,
        unidades_compradas: parseFloat(d.unidades) || null,
        precio_unitario:     parseFloat(d.precio_unitario) || 0,
        marca_default_id:    marcaDefault,
        // Una línea comprada puede recibirse en 1 o más lotes/zonas distintos
        // (ej: 1000kg llegan repartidos en 2 lotes). Se arranca con 1
        // recepción precargada con la cantidad y N° de unidades comprados
        // (si hay más de una recepción, el usuario debe repartir el N° de
        // unidades entre ellas manualmente).
        recepciones: [
          {
            cantidad: parseFloat(d.cantidad) || 0,
            numero_lote: '',
            marca_id: marcaDefault,
            codigo_partida: '', // texto libre y opcional: agrupa lotes de esta misma guía (no es Partida Arancelaria)
            ubicacion_id: '',
            cantidad_unidades: parseFloat(d.unidades) || null
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
    })
  })
}

window.agregarRecepcionGuia = function (idx) {
  _sincronizarRecepcionesGuiaDesdeDOM()
  const l = _guiaLineas[idx]
  if (!l) return
  l.recepciones.push({ cantidad: 0, numero_lote: '', marca_id: l.marca_default_id, codigo_partida: '', ubicacion_id: '', cantidad_unidades: null, es_peso_variable: false })
  _renderTablaDetalleGuia()
}

window.quitarRecepcionGuia = function (idx, subIdx) {
  _sincronizarRecepcionesGuiaDesdeDOM()
  const l = _guiaLineas[idx]
  if (!l) return
  l.recepciones.splice(subIdx, 1)
  if (l.recepciones.length === 0) {
    l.recepciones.push({ cantidad: l.cantidad_comprada, numero_lote: '', marca_id: l.marca_default_id, codigo_partida: '', ubicacion_id: '', cantidad_unidades: l.unidades_compradas, es_peso_variable: false })
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
    const colorTotal = Math.abs(totalRecibido - l.cantidad_comprada) < 0.0001 ? 'var(--color-success)' : 'var(--color-warning)'

    html += `
      <div style="border:1px solid var(--border-color); border-radius:var(--radius-md); margin-bottom:14px; padding:12px;">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
          <strong>${l.nombre}</strong>
          <span style="font-size:0.85rem;">
            Comprado: ${formatQty(l.cantidad_comprada)} ${l.unidad_medida || ''} &nbsp;|&nbsp;
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
              <th>Cantidad (${l.unidad_medida || 'KG'}) *</th><th>N° de Unidades</th>
              <th title="Marca el peso por unidad como aproximado (no exacto). Se usa al vender para saber si pedir unidades exactas o dejarlas estimadas.">Peso Variable</th>
              <th>N° de Lote *</th><th>Marca *</th>
              <th>Partida <span style="font-weight:400; color:var(--text-secondary);" title="Código que agrupa varios lotes de esta misma guía (ej. varios lotes 'LT.26027-01, -02, -03...' comparten la partida 'LT.26027'). Opcional.">(opcional)</span></th>
              <th>Almacén / Zona *</th><th></th>
            </tr>
          </thead>
          <tbody>
    `
    l.recepciones.forEach((r, subIdx) => {
      html += `
        <tr>
          ${l.recepciones.length > 1 ? `<td><input type="checkbox" id="gc-${idx}-${subIdx}-sel"></td>` : ''}
          <td><input type="number" id="gc-${idx}-${subIdx}-cantidad" value="${r.cantidad}" step="0.01" min="0" style="width:100px;"></td>
          <td><input type="number" id="gc-${idx}-${subIdx}-unidades" value="${r.cantidad_unidades ?? ''}" placeholder="Ej: 10" step="1" min="0" style="width:90px;"></td>
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

      cant?.addEventListener('input', () => { r.cantidad = parseFloat(cant.value || 0); _actualizarTotalesRecepcionGuia() })
      cantUnid?.addEventListener('input', () => { r.cantidad_unidades = parseFloat(cantUnid.value || 0) || null; _actualizarTotalesRecepcionGuia() })
      lote?.addEventListener('input', () => {
        r.numero_lote = lote.value?.trim() || ''
        _avisarLoteExistente(idx, subIdx, l, r)
        _actualizarTotalesRecepcionGuia()
      })
      _avisarLoteExistente(idx, subIdx, l, r)
      codigoPartida?.addEventListener('input', () => { r.codigo_partida = codigoPartida.value?.trim() || '' })
      pesoVar?.addEventListener('change', () => { r.es_peso_variable = !!pesoVar.checked })
    })
  })
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
  window.closeModal('modal-nueva-guia')
}

window.guardarGuiaIngresoCompra = async function () {
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
        if (!r.cantidad || r.cantidad <= 0) { showToast(`Cantidad recibida inválida para "${l.nombre}"`, 'warning'); return }
        if (!r.numero_lote)                 { showToast(`Falta el N° de Lote de "${l.nombre}"`, 'warning'); return }
        if (!r.marca_id)                    { showToast(`Falta la Marca de "${l.nombre}"`, 'warning'); return }
        if (!r.ubicacion_id)                { showToast(`Falta el Almacén/Zona de "${l.nombre}"`, 'warning'); return }

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
          loteExistenteId:    null   // lo resuelve el bloque de abajo
        })
      }
    }

    const compra = await getCompraById(compraId)

    // ── ¿Alguna recepción va sobre un lote que ya existe? ──────────────────
    // Se resuelve ANTES de escribir nada, porque si los costos no coinciden
    // hay que preguntar y una respuesta negativa cancela toda la guía.
    const conflictosCosto = []
    for (const rec of recepcionesValidadas) {
      const existente = _buscarLoteExistente(rec.item_id, rec.numeroLote)
      if (!existente) continue

      rec.loteExistenteId = existente.id

      const costoExistente = parseFloat(existente.costo_unitario) || 0
      const costoNuevo = parseFloat(((parseFloat(rec.precio_unitario) || 0) * (parseFloat(compra?.tipo_cambio) || 1)).toFixed(4))
      if (Math.abs(costoExistente - costoNuevo) >= 0.0001) {
        conflictosCosto.push({ rec, existente, costoExistente, costoNuevo })
      }
    }

    if (conflictosCosto.length > 0) {
      // El costeo es por identificación específica: cada lote lleva su propio
      // costo. Fusionar dos ingresos de costo distinto bajo el mismo N° de
      // lote obliga a promediar, y eso ya no es identificación específica.
      // Por eso se pregunta en vez de decidir por el usuario.
      const detalle = conflictosCosto.map(c =>
        `• ${c.rec.nombreProducto} — lote ${c.rec.numeroLote}\n` +
        `    existente: ${(parseFloat(c.existente.cantidad) || 0).toLocaleString('en-US', { maximumFractionDigits: 2 })} ${c.existente.unidad_medida || 'KG'} a S/ ${c.costoExistente.toFixed(4)}\n` +
        `    ingresando: ${c.rec.cantidad.toLocaleString('en-US', { maximumFractionDigits: 2 })} ${c.rec.unidadMedida} a S/ ${c.costoNuevo.toFixed(4)}`
      ).join('\n\n')

      const fusionar = confirm(
        `⚠ ${conflictosCosto.length} lote(s) ya existen pero con OTRO costo unitario:\n\n${detalle}\n\n` +
        `Aceptar = SUMAR al lote existente recalculando su costo como promedio ponderado.\n` +
        `Cancelar = no guardar (podrás cambiar el N° de lote para mantenerlos separados,\n` +
        `que es lo correcto si son ingresos de costos distintos).`
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
          cantidad_unidades:  l.cantidadUnidades,
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
    window.cerrarModalNuevaGuia()
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
      pais: document.getElementById('provPais')?.value || ''
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

    // Selects que deben listar proveedores: OC, compra directa de mercadería y compra de servicio/gasto
    const ids = ['ocProveedor', 'cmProveedor', 'csProveedor']
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
    // cantidad_unidades no se pide en este modal: queda null en vez de
    // igualarse a cantidad (eran dos dimensiones distintas).
    await addLote({
      item_id:            productId,
      numero_lote:        numeroLote,
      cantidad:           cantidad,
      cantidad_unidades:  null,
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

    const contactId    = parseInt(document.getElementById('csProveedor')?.value || 0)
    const moneda       = document.getElementById('csMoneda')?.value || 'PEN'
    // PEN siempre es 1; en USD se toma el valor del campo (manual o el que
    // dejó el botón "↻ Auto"). Antes se guardaba 1 fijo aunque la compra
    // fuera en dólares, así que el costo en soles quedaba mal.
    const tipoCambioServicio = moneda === 'USD'
      ? (parseFloat(document.getElementById('csTipoCambio')?.value || 0) || 1)
      : 1
    const fecha        = document.getElementById('csFecha')?.value
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
    const referencia = `SERV-${Date.now()}`

    // compras no tiene columna de cuenta contable: se deja trazado en la descripción.
    const compra = await addCompra({
      referencia,
      tipo_referencia:        'compra_directa',
      tipo_comprobante:       '01',
      serie:                  null,
      numero:                 referencia,
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
    await _crearCuentaPagarSiFactura(compra, user.db_id)

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
    window.closeModal('modal-nueva-compra-servicio')
    const form = document.getElementById('formNewCompraServicio')
    if (form) form.reset()
    await renderCompras(true)
  } catch (error) {
    console.error('Error en guardarCompraServicio:', error)
    showToast('Error: ' + error.message, 'danger')
  }
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

window.abrirModalNuevaCompraMercaderia = function () {
  _detallesCompraEnCreacion = []
  const form = document.getElementById('formNewCompraMercaderia')
  if (form) form.reset()
  const fechaEl = document.getElementById('cmFecha')
  if (fechaEl) fechaEl.value = new Date().toISOString().split('T')[0]
  const monedaEl = document.getElementById('cmMoneda')
  if (monedaEl) monedaEl.value = getModuloConfig('compras').monedaDefault || 'USD'
  // form.reset() devuelve el <select> a su opción `selected` del HTML y deja
  // el bloque del T.C. como estaba; hay que re-aplicar la regla a mano.
  window.onCambiarMonedaCompra()
  _renderTablaDetalleCompra()
  _cronogramaCompraListo = false
  _prepararCronogramaCompra(true)
  window.openModal('modal-nueva-compra-mercaderia')
}

// ============================================================================
// CRONOGRAMA DE PAGO EN NUEVA COMPRA (mercadería) — espejo de ventas.js
// ============================================================================

let _cronogramaCompraListo = false

window.onCambiarFechaCompra = function () {
  const fecha = document.getElementById('cmFecha')?.value
  if (!fecha) return
  if (_cronogramaCompraListo) actualizarCronograma('compra-cronograma', { fechaEmision: fecha })
}

/** Se llama al elegir proveedor: precarga el término habitual de ESE proveedor. */
window.onCambiarProveedorCompra = function () {
  if (_cronogramaCompraListo) _prepararCronogramaCompra(true)
}

/** Se llama al abrir el modal y cada vez que cambia el total de la compra. */
async function _prepararCronogramaCompra(forzarRender = false) {
  const cont = document.getElementById('compra-cronograma')
  if (!cont) return

  const total = _detallesCompraEnCreacion.reduce((s, d) => s + (parseFloat(d.total) || 0), 0)
  const fechaEmision = document.getElementById('cmFecha')?.value || new Date().toISOString().slice(0, 10)

  if (!_cronogramaCompraListo || forzarRender) {
    // El término del proveedor solo PRECARGA el selector: la condición real
    // se negocia por operación, así que la compra guarda la suya y nunca se
    // reescribe la ficha del contacto desde aquí.
    const contactId = parseInt(document.getElementById('cmProveedor')?.value || 0)
    const prov = contactId ? await getContactById(contactId) : null

    await renderEditorCronograma('compra-cronograma', {
      total, fechaEmision, aplicaA: 'compra',
      terminoId: prov?.termino_pago_id || null,
      onCambio: (crono) => {
        // La fecha de vencimiento del comprobante = última cuota.
        const ultima = crono?.cuotas?.[crono.cuotas.length - 1]
        const fv = document.getElementById('cmFechaVencimiento')
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
    const proveedorId = document.getElementById('cmProveedor')?.value || ''
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

window.calcularDetalleCompraMercaderia = function () {
  const cantidad  = parseFloat(document.getElementById('newDetalleCompraCantidad')?.value || 0)
  const precio    = parseFloat(document.getElementById('newDetalleCompraPrecio')?.value || 0)
  const descuento = parseFloat(document.getElementById('newDetalleCompraDescuento')?.value || 0)
  const igvPct    = parseInt(document.getElementById('newDetalleCompraIGV')?.value || 18)

  let subtotal = cantidad * precio
  if (descuento > 0) subtotal -= subtotal * (descuento / 100)
  const igvMonto = (subtotal * igvPct) / 100
  const total = subtotal + igvMonto

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
    const igvPct      = parseInt(document.getElementById('newDetalleCompraIGV')?.value || 18)
    const nroUnidades = parseFloat(document.getElementById('newDetalleCompraUnidades')?.value || 0) || null

    if (cantidad <= 0 || precio <= 0) { showToast('Cantidad y precio deben ser mayores a 0', 'warning'); return }

    let subtotal = cantidad * precio
    if (descuento > 0) subtotal -= subtotal * (descuento / 100)
    const igvMonto = (subtotal * igvPct) / 100
    const total = subtotal + igvMonto

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

    const contactId      = parseInt(document.getElementById('cmProveedor')?.value || 0)
    const moneda          = document.getElementById('cmMoneda')?.value || 'USD'
    const fecha           = document.getElementById('cmFecha')?.value
    const nroComprobante  = document.getElementById('cmNumeroComprobante')?.value?.trim() || null
    // PEN siempre es 1. En USD se usa el valor del campo (manual o el que
    // trajo el botón "↻ Auto" desde la SBS).
    const tipoCambio = moneda === 'USD'
      ? (parseFloat(document.getElementById('cmTipoCambio')?.value || 0) || 1)
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

    const compra = await addCompra({
      referencia,
      tipo_referencia:        'compra_directa',
      tipo_comprobante:       '01',
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
    await _crearCuentaPagarSiFactura(compra, user.db_id, cronograma)

    // Asiento contable de la factura (601111/40111C debe, 42111 haber).
    // Detrás del candado de desarrollo: ver config-asientos-auto.js.
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
        tipo_comprobante: c.tipo_comprobante === '01' ? 'Factura' : (c.tipo_comprobante === '03' ? 'Boleta' : (c.tipo_comprobante || 'Otro')),
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
            if (idsLotes.includes(k.lote_id)) await deleteKardexMovimiento(k.id)
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
      : totalOrigen

    const cfg = getModuloConfig('compras')

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
      onEmitir: async (d) => {
        if (!d.serie || !d.numero) {
          throw new Error('Copia la serie y el número exactos de la nota que te envió el proveedor')
        }

        const base = parseFloat(d.base.toFixed(2))
        const igv  = parseFloat(d.igv.toFixed(2))
        const tot  = parseFloat(d.importe.toFixed(2))

        await addCompra({
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
          created_by:             d.usuarioId
        })

        // Ajustar la Cuenta por Pagar del comprobante original
        if (cxp) {
          try {
            const campos = tipoNota === TIPO_NC
              ? { monto_notas_credito: parseFloat((parseFloat(cxp.monto_notas_credito || 0) + tot).toFixed(2)) }
              : { monto_notas_debito:  parseFloat((parseFloat(cxp.monto_notas_debito || 0) + tot).toFixed(2)) }

            const nuevoSaldo = parseFloat(cxp.monto_total || 0)
              + parseFloat(cxp.monto_notas_debito || 0) + (tipoNota === TIPO_ND ? tot : 0)
              - parseFloat(cxp.monto_notas_credito || 0) - (tipoNota === TIPO_NC ? tot : 0)
              - parseFloat(cxp.monto_pagado || 0)
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
// BUSCADORES EN VIVO — selects largos del módulo Compras
// ============================================================================
// Mismos selects que antes, pero con filtrado por texto. El <select> original
// sigue oculto detrás, así que ni las validaciones ni los onchange cambian.
// Se convierten después de que cada select ya tiene sus opciones cargadas.

function _activarBuscadoresCompras() {
  convertirVarios([
    { id: 'ocProveedor',              placeholder: 'Escribe el nombre o RUC del proveedor...', sinResultados: 'Ningún proveedor coincide',
      alCrearNuevo: { label: 'Registrar proveedor nuevo', onClick: () => window.abrirModalNuevoProveedor?.() } },
    { id: 'cmProveedor',              placeholder: 'Escribe el nombre o RUC del proveedor...', sinResultados: 'Ningún proveedor coincide',
      alCrearNuevo: { label: 'Registrar proveedor nuevo', onClick: () => window.abrirModalNuevoProveedor?.() } },
    { id: 'csProveedor',              placeholder: 'Escribe el nombre o RUC del proveedor...', sinResultados: 'Ningún proveedor coincide',
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
// Cuidado con el costeo: el método es identificación específica (LIR Art. 62°),
// donde cada lote lleva un costo unitario fijo. Sumar a un lote existente solo
// es correcto si el costo coincide. Si no coincide, se avisa y se pide decidir:
//   * mantener lotes separados (correcto contablemente), o
//   * fusionar recalculando el costo como promedio ponderado.

function _buscarLoteExistente(itemId, numeroLote) {
  const num = String(numeroLote || '').trim().toLowerCase()
  if (!num) return null
  return (_guiaLotesPorItem[itemId] || []).find(lo =>
    String(lo.numero_lote || '').trim().toLowerCase() === num) || null
}

/** Costo unitario en soles que tendría esta recepción (para comparar con el lote existente). */
function _costoRecepcionPen(linea, compra) {
  const tc = parseFloat(compra?.tipo_cambio) || 1
  return parseFloat(((parseFloat(linea.precio_unitario) || 0) * tc).toFixed(4))
}

function _avisarLoteExistente(idx, subIdx, linea, recepcion) {
  const el = document.getElementById(`gc-${idx}-${subIdx}-loteaviso`)
  if (!el) return

  const existente = _buscarLoteExistente(linea.item_id, recepcion.numero_lote)
  if (!existente) {
    el.className = 'lote-aviso'
    el.innerHTML = recepcion.numero_lote
      ? '<span style="color:var(--color-success);">Lote nuevo</span>'
      : ''
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

window.onCambiarMonedaCompra = function () {
  _aplicarMonedaCompra({
    idMoneda: 'cmMoneda', idGrupoTC: 'cmTipoCambioGroup',
    idInputTC: 'cmTipoCambio', idAviso: 'cmTCAviso',
    autoFetch: window.autoFetchTCMercaderia
  })
}

window.onCambiarMonedaServicio = function () {
  _aplicarMonedaCompra({
    idMoneda: 'csMoneda', idGrupoTC: 'csTipoCambioGroup',
    idInputTC: 'csTipoCambio', idAviso: 'csTCAviso',
    autoFetch: window.autoFetchTCServicio
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

window.autoFetchTCMercaderia = function () {
  return _traerTCCompraA('cmTipoCambio', 'cmTCAviso', 'cmFecha', 'btnAutoTCMercaderia')
}

window.autoFetchTCServicio = function () {
  return _traerTCCompraA('csTipoCambio', 'csTCAviso', 'csFecha', 'btnAutoTCServicio')
}

window.abrirModalCompraServicio = function () {
  const form = document.getElementById('formNewCompraServicio')
  if (form) form.reset()
  const fechaEl = document.getElementById('csFecha')
  if (fechaEl) fechaEl.value = new Date().toISOString().split('T')[0]
  const monedaEl = document.getElementById('csMoneda')
  if (monedaEl) monedaEl.value = getModuloConfig('compras').monedaDefault || 'USD'
  window.onCambiarMonedaServicio()
  window.openModal('modal-nueva-compra-servicio')
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
