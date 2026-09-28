// ============================================================================
// compras/ordenes-compra.js — parte de compras.js (reorganizado 2026-09-25, sin cambios de lógica)
// Mapa completo de funciones: Claude outputs/glosario_funciones_erp.md
// ============================================================================
import { getCurrentUser } from '../auth-supabase.js'
import { getOrderCompras, getOrderComprasPage, getOrderCompraById, addOrderCompra, updateOrderCompra, addCompra, addCompraDetalle, getOrderCompraDetalles, addOrderCompraDetalle, addLote, getItems, getItemById, getSuppliers, getContactById, getCategorias, getMarcas, getPartidas, cargarSelectTipoDocumentos, addCuentaPagar, addCuotaPagar } from '../supabase-data.js'
import { showToast, formatNumber, formatQty } from '../helpers.js'
import { refrescarBuscador } from '../buscador-select.js'
import { _escCompras } from './buscadores.js'
import { renderCompras } from './compras-lista.js'
import { _autoFetchTCCompra } from './init.js'

// ============================================================================
// ÓRDENES DE COMPRA
// ============================================================================

// Paginación server-side: solo se piden 50 órdenes por página a Supabase
const OC_POR_PAGINA = 50
let _ocPagina = 1

export async function renderOrdenes() {
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
export async function _crearCuentaPagarSiFactura(compra, userId, crono = null) {
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
  // 2026-09-25 (migración 57): confirmar una OC creaba lotes con stock SIN
  // kardex. El tab de OC está en standby; si se reactiva, este flujo debe
  // registrar la compra sin lote y dejar que el stock entre por la Guía de
  // Remisión. Bloqueado por decisión de Luis.
  showToast('Confirmar Órdenes de Compra está deshabilitado: registra la Compra y su Guía de Remisión.', 'warning')
  return
  // eslint-disable-next-line no-unreachable
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

export async function cargarItemsSelectDetalle(targetId = 'newDetalleOCProducto') {
  try {
    const productos = await getItems()
    const select = document.getElementById(targetId)

    if (!select) return

    select.innerHTML = '<option value="">-- Selecciona un producto --</option>' +
      productos.map(p => `<option value="${p.id}">${p.sku ? '(' + _escCompras(p.sku) + ') ' : ''}${_escCompras(p.nombre || p.name || '')}</option>`).join('')
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
