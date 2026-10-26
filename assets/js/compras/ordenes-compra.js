import { ultimoErrorInsert, query } from '../supabase-client.js'
import { registrarColumnas, colStyle } from '../col-menu.js'
import { menuAccionesFila } from '../main.js'
import { fechaDMY } from '../helpers.js'
import { validarCamposPI } from '../importaciones/pi-validaciones.js'
// ============================================================================
// compras/ordenes-compra.js — parte de compras.js (reorganizado 2026-09-25, sin cambios de lógica)
// Mapa completo de funciones: Claude outputs/glosario_funciones_erp.md
// ============================================================================
import { getCurrentUser } from '../auth-supabase.js'
import { getOrderCompras, getOrderComprasPage, getOrderCompraById, addOrderCompra, updateOrderCompra, getCompraById, getCompraDetalles, updateCompra, addCompra, addCompraDetalle, getOrderCompraDetalles, addOrderCompraDetalle, addLote, getItems, getItemById, getSuppliers, getContactById, getCategorias, getMarcas, getPartidas, cargarSelectTipoDocumentos, addCuentaPagar, addCuotaPagar } from '../supabase-data.js'
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

registrarColumnas('ordenes-compra', [
  { key: 'numero', label: 'Número' }, { key: 'pi', label: 'Proforma (PI)' }, { key: 'proveedor', label: 'Proveedor' },
  { key: 'fecha', label: 'Fecha' }, { key: 'moneda', label: 'Moneda' }, { key: 'subtotal', label: 'Subtotal' },
  { key: 'igv', label: 'IGV' }, { key: 'total', label: 'Total' }, { key: 'estado', label: 'Estado' }, { key: 'carpeta', label: 'Carpeta' }
])

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

    const carpetaNum = {}
    try { for (const c of (await query('carpetas_importacion', {})) || []) carpetaNum[c.id] = c.numero_carpeta } catch (_) {}
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
            <th data-col-tabla="ordenes-compra" data-col="numero"${colStyle('ordenes-compra','numero')}>Número</th>
            <th data-col-tabla="ordenes-compra" data-col="pi"${colStyle('ordenes-compra','pi')}>Proforma (PI)</th>
            <th data-col-tabla="ordenes-compra" data-col="proveedor"${colStyle('ordenes-compra','proveedor')}>Proveedor</th>
            <th data-col-tabla="ordenes-compra" data-col="fecha"${colStyle('ordenes-compra','fecha')}>Fecha</th>
            <th data-col-tabla="ordenes-compra" data-col="moneda"${colStyle('ordenes-compra','moneda')}>Moneda</th>
            <th data-col-tabla="ordenes-compra" data-col="subtotal"${colStyle('ordenes-compra','subtotal')}>Subtotal</th>
            <th data-col-tabla="ordenes-compra" data-col="igv"${colStyle('ordenes-compra','igv')}>IGV</th>
            <th data-col-tabla="ordenes-compra" data-col="total"${colStyle('ordenes-compra','total')}>Total</th>
            <th data-col-tabla="ordenes-compra" data-col="estado"${colStyle('ordenes-compra','estado')}>Estado</th>
            <th data-col-tabla="ordenes-compra" data-col="carpeta"${colStyle('ordenes-compra','carpeta')}>Carpeta</th>
            <th style="width:48px;"></th>
          </tr>
        </thead>
        <tbody>
    `
    ordenes.forEach(oc => {
      html += `
        <tr>
          <td data-col-tabla="ordenes-compra" data-col="numero"${colStyle('ordenes-compra','numero')}><strong>${oc.id}</strong></td>
          <td data-col-tabla="ordenes-compra" data-col="pi"${colStyle('ordenes-compra','pi')}>${oc.es_importacion
            ? `<strong>${_escCompras(oc.numero_proforma_proveedor || '—')}</strong><br><small style="color:var(--text-secondary);">${_escCompras(oc.incoterm || 'sin incoterm')}${oc.anticipo_porcentaje ? ' · anticipo ' + oc.anticipo_porcentaje + '%' : ''}</small>`
            : '<span style="color:var(--text-secondary);">—</span>'}</td>
          <td data-col-tabla="ordenes-compra" data-col="proveedor"${colStyle('ordenes-compra','proveedor')}>${proveedoresMap[oc.contact_id] || '-'}</td>
          <td data-col-tabla="ordenes-compra" data-col="fecha"${colStyle('ordenes-compra','fecha')}>${fechaDMY(oc.fecha, '-')}</td>
          <td data-col-tabla="ordenes-compra" data-col="moneda"${colStyle('ordenes-compra','moneda')}>${oc.currency || 'PEN'}</td>
          <td data-col-tabla="ordenes-compra" data-col="subtotal"${colStyle('ordenes-compra','subtotal')}>${(oc.total_subtotal || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
          <td data-col-tabla="ordenes-compra" data-col="igv"${colStyle('ordenes-compra','igv')}>${(oc.total_igv || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
          <td data-col-tabla="ordenes-compra" data-col="total"${colStyle('ordenes-compra','total')}><strong>${(oc.total_oc || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</strong></td>
          <td data-col-tabla="ordenes-compra" data-col="estado"${colStyle('ordenes-compra','estado')}><span class="badge badge-${oc.status || 'pending'}">${oc.status || 'pending'}</span></td>
          <td data-col-tabla="ordenes-compra" data-col="carpeta"${colStyle('ordenes-compra','carpeta')}>${oc.carpeta_importacion_id && carpetaNum[oc.carpeta_importacion_id] != null ? 'Carpeta ' + carpetaNum[oc.carpeta_importacion_id] : (oc.es_importacion ? '<span style="color:var(--text-secondary);">—</span>' : '')}</td>
          <td>${menuAccionesFila([
            { label: 'Ver', icono: '👁', onclick: `window.verOC(${oc.id})` },
            oc.es_importacion && !oc.carpeta_importacion_id ? { label: 'Completar PI', icono: '📝', onclick: `window.completarProformaOC(${oc.id})` } : null,
            oc.status === 'borrador' ? (oc.es_importacion
              ? { label: 'Confirmar Proforma', icono: '✅', onclick: `window.confirmarProformaOC(${oc.id})` }
              : { label: 'Confirmar', icono: '✅', onclick: `window.confirmarOC(${oc.id})` }) : null
          ])}</td>
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
          ${(parseFloat(d.cantidad) || 0).toLocaleString('en-US', { maximumFractionDigits: 2 })} kg x ${(parseFloat(d.precio_unitario) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 })} ${oc.currency} = ${(parseFloat(d.total) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${oc.currency}`
      })
      const detallesArray = await Promise.all(detallesPromises)
      detallesText = detallesArray.join('\n')
    }

    const mensaje = `
          OC #${oc.id}
          Proveedor: ${prov?.nombre || '-'}
          Fecha: ${fechaDMY(oc.fecha, '-')}
          Moneda: ${oc.currency || 'PEN'}
          Estado: ${oc.status || '-'}

          DETALLES:
          ${detallesText}

          TOTALES:
          Subtotal: ${oc.currency || 'PEN'} ${(oc.total_subtotal || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          IGV: ${oc.currency || 'PEN'} ${(oc.total_igv || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          Total: ${oc.currency || 'PEN'} ${(oc.total_oc || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              `

    alert(mensaje)
  } catch (error) {
    console.error('Error en verOC:', error)
    showToast('Error al ver la orden', 'danger')
  }
}


/**
 * Confirmar una PROFORMA (OC de importación): solo cambia el estado. NO crea
 * compra ni stock: la compra nace con el Commercial Invoice cuando embarcan.
 * Con la PI confirmada ya se puede abrir la carpeta (Importaciones → Nueva carpeta).
 */
window.confirmarProformaOC = async function (id) {
  try {
    const oc = await getOrderCompraById(id)
    if (!oc) { showToast('Proforma no encontrada', 'warning'); return }
    if (oc.status === 'confirmado') { showToast('Esta Proforma ya está confirmada', 'warning'); return }
    if (!confirm(`¿Confirmar la Proforma ${oc.numero_proforma_proveedor || oc.numero}?\n\nQueda aceptada con el proveedor. No crea compra ni mueve stock.`)) return
    const ok = await updateOrderCompra(id, { status: 'confirmado' })
    if (!ok) { showToast('No se pudo confirmar la Proforma', 'danger'); return }
    showToast('Proforma confirmada. Ya puedes abrir su carpeta en Importaciones.', 'success')
    await renderOrdenes()
  } catch (e) {
    console.error('confirmarProformaOC:', e)
    showToast('Error al confirmar la Proforma', 'danger')
  }
}

/**
 * Generar la Proforma (PI) de una compra de importación ya registrada
 * (caso histórico, ej. carpeta 8). Abre el formulario de OC con los datos y
 * las líneas de la compra; al guardar, la compra queda enlazada a la PI
 * (compras.orden_compra_id) y la PI aparece en "Nueva carpeta".
 * No guarda nada hasta que el usuario pulse Guardar.
 */
let _ocCompraOrigenId = null

// ─── Completar una Proforma ya guardada (datos que la PI no traía) ──────────
const CAMPOS_COMPLETAR_PI = [
  ['cpMarca', 'marca', 'Marca', 'text'], ['cpPuertoEmb', 'puerto_embarque', 'Puerto de embarque', 'text'],
  ['cpPuertoDest', 'puerto_destino', 'Puerto de destino', 'text'], ['cpPais', 'pais_origen', 'País de origen', 'text'],
  ['cpAnticipo', 'anticipo_porcentaje', 'Anticipo (%)', 'number'], ['cpTolerancia', 'tolerancia_porcentaje', 'Tolerancia cantidad (%)', 'number'],
  ['cpDiasAnt', 'dias_validez_anticipo', 'Plazo para pagar el anticipo (días)', 'number'], ['cpDiasEmb', 'dias_embarque', 'Plazo de embarque (días desde el anticipo)', 'number'],
  ['cpEntrega', 'entrega_pactada', 'Entrega pactada (ej. JULIO 2026)', 'text'], ['cpDiasSaldo', 'dias_saldo_desde_bl', 'Saldo: días desde el B/L', 'number'],
  ['cpValidez', 'validez_oferta', 'Validez de la oferta (hasta)', 'date']
]
let _cpOcId = null

window.completarProformaOC = async function (id) {
  const oc = await getOrderCompraById(id)
  if (!oc) { showToast('Proforma no encontrada', 'warning'); return }
  _cpOcId = id
  if (!document.getElementById('modal-completar-pi')) {
    document.body.insertAdjacentHTML('beforeend', `
    <div id="modal-completar-pi" class="modal">
      <div class="modal-content" style="max-width:820px; max-height:90vh; overflow-y:auto;">
        <div class="modal-header"><h3 class="modal-title" id="cpTitulo">Completar Proforma</h3>
          <button class="modal-close" onclick="closeModal('modal-completar-pi')">✕</button></div>
        <div style="padding:16px 20px;">
          <small style="display:block; margin-bottom:12px; color:var(--text-secondary);">Todo es opcional: llena solo lo que ya sepas. El flete y el seguro de una PI CIF se registran en el Commercial Invoice.</small>
          <div style="display:grid; grid-template-columns:repeat(3,1fr); gap:10px;">
            ${CAMPOS_COMPLETAR_PI.map(([i, , l, t]) => `<div class="form-group"><label>${l}</label><input type="${t}" id="${i}" ${t === 'number' ? 'step="1" min="0"' : ''}></div>`).join('')}
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="closeModal('modal-completar-pi')">Cancelar</button>
          <button class="btn btn-primary" onclick="window.guardarCompletarPI()">💾 Guardar</button>
        </div>
      </div>
    </div>`)
  }
  document.getElementById('cpTitulo').textContent = `Completar Proforma ${oc.numero_proforma_proveedor || oc.numero}`
  for (const [i, c] of CAMPOS_COMPLETAR_PI) document.getElementById(i).value = oc[c] ?? ''
  window.openModal('modal-completar-pi')
}

window.guardarCompletarPI = async function () {
  try {
    const oc = await getOrderCompraById(_cpOcId)
    const datos = {}
    for (const [i, c, , t] of CAMPOS_COMPLETAR_PI) {
      const val = document.getElementById(i).value.trim()
      datos[c] = val === '' ? null : (t === 'number' ? parseFloat(val) : val)
    }
    const err = _validarCamposPI({ ...datos, incoterm: oc.incoterm }, oc.fecha)
    if (err) { showToast(err, 'warning'); return }
    let ok = await updateOrderCompra(_cpOcId, datos)
    if (!ok) {   // sin el SQL 99 las 3 columnas nuevas no existen: guardar el resto
      const reducido = { ...datos }; for (const k of ['entrega_pactada', 'dias_saldo_desde_bl', 'validez_oferta']) delete reducido[k]
      ok = await updateOrderCompra(_cpOcId, reducido)
      if (ok) showToast('Guardado, pero faltan 3 campos del SQL 99 (entrega, saldo, validez). Córrelo y vuelve a completar.', 'warning')
    }
    if (!ok) { showToast('No se pudo guardar', 'danger'); return }
    window.closeModal('modal-completar-pi')
    showToast('Proforma actualizada', 'success')
    await renderOrdenes()
  } catch (e) { console.error(e); showToast('Error al guardar la Proforma', 'danger') }
}

/** Abrir el formulario de OC en blanco (descarta cualquier compra de origen pendiente). */
window.ocNueva = function () {
  _ocCompraOrigenId = null
  detallesOCEnCreacion = []
  _renderTablaDetalleOC()
  window.openModal('modal-nueva-oc')
}

window.ocDesdeCompra = async function (compraId) {
  try {
    const compra = await getCompraById(compraId)
    if (!compra) { showToast('Compra no encontrada', 'warning'); return }
    if (compra.orden_compra_id) { showToast('Esta compra ya tiene su Proforma', 'warning'); return }
    const detalles = (await getCompraDetalles(compraId)) || []
    if (!detalles.length) { showToast('La compra no tiene detalle', 'warning'); return }

    window.openModal('modal-nueva-oc')
    const form = document.getElementById('formNewOC'); if (form) form.reset()

    const sel = document.getElementById('ocProveedor')
    if (sel) { sel.value = String(compra.contact_id || ''); refrescarBuscador(sel) }
    if (typeof window._onCambiarProveedorOC === 'function') window._onCambiarProveedorOC()
    const set = (id, val) => { const e = document.getElementById(id); if (e && val != null) e.value = val }
    set('ocMoneda', compra.currency || 'USD')
    set('ocFecha', compra.fecha_emision || compra.fecha)
    set('ocTipoPago', compra.tipo_pago || 'credito')
    const chk = document.getElementById('ocEsImportacion'); if (chk) chk.checked = true
    window.ocToggleImportacion()

    const items = await getItems()
    const mapa = {}; for (const i of items || []) mapa[i.id] = i
    detallesOCEnCreacion = detalles.map(d => {
      const cant = parseFloat(d.cantidad) || 0
      const precio = parseFloat(d.precio_unitario) || 0
      const sub = parseFloat(d.subtotal) || cant * precio
      const it = mapa[d.item_id]
      return {
        item_id: d.item_id,
        nombre: it ? (it.sku ? `(${it.sku}) ${it.nombre}` : it.nombre) : `Item #${d.item_id}`,
        cantidad: cant, unidad_medida: d.unidad_medida || 'KG',
        peso_neto: cant, peso_bruto: null, bultos: null, partida_arancelaria: null,
        precio_unitario: precio, igv_porcentaje: 0,
        subtotal: parseFloat(sub.toFixed(2)), igv_monto: 0, total: parseFloat(sub.toFixed(2))
      }
    })
    _renderTablaDetalleOC()
    window.ocCalcularAnticipo()
    _ocCompraOrigenId = compraId
    showToast('Completa N° de PI, incoterm y anticipo de la Proforma y guarda. La compra quedará enlazada.', 'info')
  } catch (e) {
    console.error('ocDesdeCompra:', e)
    showToast('No se pudo preparar la Proforma desde la compra', 'danger')
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
        <td style="text-align:right;">${(parseFloat(d.precio_unitario) || 0).toLocaleString('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 6 })}</td>
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
    // Solo USD convierte (blindaje 2026-10-05)
    const tipoCambio = (moneda === 'USD' && tipoCambioVal) ? parseFloat(tipoCambioVal) : 1

    const cantidadTotal = detalles.reduce((s, d) => s + (parseFloat(d.cantidad) || 0), 0) || 1
    const subtotalC = parseFloat(oc.total_subtotal || 0)
    const igvC      = parseFloat(oc.total_igv || 0)
    const totalC    = parseFloat(oc.total_oc || 0)
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
      precio_unitario:        parseFloat((subtotalC / cantidadTotal).toFixed(6)) || 0,
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
      const costoPen = parseFloat((costoOriginal * tipoCambio).toFixed(6))
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


// ════════════════════════════════════════════════════════════════════════════
// OC DE IMPORTACIÓN (Proforma Invoice)
// ════════════════════════════════════════════════════════════════════════════
// El INCOTERM manda: con CIF/CFR/DAP el precio del proveedor ya incluye el
// flete (y el seguro), así que cargarlos otra vez en el costeo los cuenta dos
// veces. Con FOB/FCA/EXW sí son costo aparte. El modal lo impone solo.
const INCOTERMS_CON_FLETE_INCLUIDO = ['CIF', 'CFR', 'CIP', 'CPT', 'DAP', 'DDP']

export const incotermIncluyeFlete = i => INCOTERMS_CON_FLETE_INCLUIDO.includes(String(i || '').toUpperCase())

/** Campos que solo existen después de correr el SQL 93. */
const CAMPOS_OC_SQL93 = ['puerto_destino', 'tolerancia_porcentaje', 'dias_validez_anticipo', 'dias_embarque', 'marca',
  // SQL 99
  'entrega_pactada', 'dias_saldo_desde_bl', 'validez_oferta']

window.ocToggleImportacion = function () {
  const esImp = !!document.getElementById('ocEsImportacion')?.checked
  const sec = document.getElementById('ocSeccionImportacion')
  if (sec) sec.style.display = esImp ? '' : 'none'

  // La factura del exterior no lleva IGV peruano: el IGV de la importación
  // se paga con la DAM, no en la factura del proveedor.
  const igv = document.getElementById('newDetalleOCIGV')
  if (igv && esImp) igv.value = '0'

  const grupoDet = document.getElementById('ocDetalleGrupoImportacion')
  if (grupoDet) grupoDet.style.display = esImp ? 'grid' : 'none'

  if (esImp) window.ocOnIncoterm()
}

window.ocOnIncoterm = function () {
  const inc = document.getElementById('ocIncoterm')?.value || 'CIF'
  const incluido = incotermIncluyeFlete(inc)
  const flete = document.getElementById('ocFleteEstimado')
  const seguro = document.getElementById('ocSeguroEstimado')
  const aviso = document.getElementById('ocFleteAviso')

  for (const el of [flete, seguro]) {
    if (!el) continue
    el.disabled = incluido
    if (incluido) el.value = ''
    el.style.opacity = incluido ? '0.5' : ''
  }
  if (aviso) {
    aviso.textContent = incluido
      ? `${inc}: el precio YA incluye flete y seguro — no se cargan aparte. El desglose FOB / flete / seguro se registra después en el Commercial Invoice.`
      : `${inc}: el flete y el seguro son costo aparte y se registran en el ledger de la carpeta.`
    aviso.style.color = incluido ? 'var(--color-warning)' : 'var(--text-secondary)'
  }
  window.ocCalcularAnticipo()
}

window.ocCalcularAnticipo = function () {
  const pct = parseFloat(document.getElementById('ocAnticipoPct')?.value || 0)
  const total = (detallesOCEnCreacion || []).reduce((t, d) => t + (parseFloat(d.total) || 0), 0)
  const el = document.getElementById('ocAnticipoMonto')
  if (!el) return
  const moneda = document.getElementById('ocMoneda')?.value || 'USD'
  el.textContent = total && pct ? `Anticipo: ${moneda} ${formatNumber(total * pct / 100, 2)}` : ''
}

/** Lee los campos de importación del modal. */
function _datosImportacionOC() {
  const v = id => { const e = document.getElementById(id); return e && e.value ? String(e.value).trim() : '' }
  const n = id => { const x = parseFloat(v(id)); return Number.isFinite(x) ? x : null }
  if (!document.getElementById('ocEsImportacion')?.checked) return { es_importacion: false }
  return {
    es_importacion: true,
    numero_proforma_proveedor: v('ocNumeroProforma') || null,
    incoterm: v('ocIncoterm') || null,
    puerto_embarque: v('ocPuertoEmbarque') || null,
    pais_origen: v('ocPaisOrigen') || null,
    flete_estimado: n('ocFleteEstimado') || 0,
    seguro_estimado: n('ocSeguroEstimado') || 0,
    anticipo_porcentaje: n('ocAnticipoPct'),
    // --- SQL 93 ---
    puerto_destino: v('ocPuertoDestino') || null,
    tolerancia_porcentaje: n('ocToleranciaPct'),
    dias_validez_anticipo: n('ocDiasValidezAnticipo'),
    dias_embarque: n('ocDiasEmbarque'),
    marca: v('ocMarca') || null,
    // --- SQL 99 ---
    entrega_pactada: v('ocEntregaPactada') || null,
    dias_saldo_desde_bl: n('ocDiasSaldoBL'),
    validez_oferta: v('ocValidezOferta') || null
  }
}

// Reglas de la PI: importaciones/pi-validaciones.js (compartidas con Ver/Editar PI)
const _validarCamposPI = validarCamposPI

/** Campos opcionales de la PI que quedaron vacíos (para avisar, no para bloquear). */
function _camposPIFaltantes(imp) {
  const f = []
  if (!imp.puerto_embarque) f.push('puerto de embarque')
  if (!imp.pais_origen) f.push('país de origen')
  if (imp.anticipo_porcentaje == null) f.push('% de anticipo')
  if (imp.dias_saldo_desde_bl == null) f.push('plazo del saldo')
  if (imp.dias_embarque == null && !imp.entrega_pactada) f.push('fecha/plazo de embarque')
  return f
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

    const imp = _datosImportacionOC()
    if (imp.es_importacion) {
      if (!imp.numero_proforma_proveedor) {
        showToast('Falta el N° de proforma del proveedor (ej. NY 2491)', 'warning'); return
      }
      if (!imp.incoterm) { showToast('Elige el incoterm de la proforma', 'warning'); return }
      const errPI = _validarCamposPI(imp, fecha)
      if (errPI) { showToast(errPI, 'warning'); return }
      // La misma PI del mismo proveedor no se registra dos veces.
      const yaExiste = (await getOrderCompras() || []).find(o => o.es_importacion && o.contact_id === supplierId &&
        String(o.numero_proforma_proveedor || '').trim().toUpperCase() === imp.numero_proforma_proveedor.toUpperCase())
      if (yaExiste) { showToast(`Ya existe la proforma ${imp.numero_proforma_proveedor} de este proveedor (OC ${yaExiste.numero || yaExiste.id})`, 'warning'); return }
      const sinPeso = detallesOCEnCreacion.filter(d => !(parseFloat(d.peso_neto) > 0))
      if (sinPeso.length) {
        if (!confirm(`${sinPeso.length} linea(s) sin peso neto.\n\nSin peso, el flete y los gastos fisicos no se pueden prorratear por kilo.\n\n¿Guardar igual?`)) return
      }
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
      total_oc: totalMonto,
      ...imp
    }

    let ocGuardada = await addOrderCompra(ocPrincipal)

    // Los campos del SQL 93 pueden no existir todavia: si la BD los rechaza,
    // se reintenta sin ellos y se avisa, en vez de perder la OC entera.
    if (!ocGuardada || !ocGuardada.id) {
      const msg = ultimoErrorInsert()?.mensaje || ''
      if (/column|columna/i.test(msg) && CAMPOS_OC_SQL93.some(c => msg.includes(c))) {
        const reducido = { ...ocPrincipal }
        for (const c of CAMPOS_OC_SQL93) delete reducido[c]
        ocGuardada = await addOrderCompra(reducido)
        if (ocGuardada?.id) {
          showToast('OC creada, pero faltan campos del SQL 93 (puerto destino, tolerancia, plazos). Corre assets/sql/93 y vuelve a editarla.', 'warning')
        }
      }
    }
    if (!ocGuardada || !ocGuardada.id) {
      showToast('Error al crear la orden de compra: ' + (ultimoErrorInsert()?.mensaje || 'revisa la consola'), 'danger')
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
        peso_neto: detalle.peso_neto ?? null,
        peso_bruto: detalle.peso_bruto ?? null,
        bultos: detalle.bultos ?? null,
        partida_arancelaria: detalle.partida_arancelaria ?? null,
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

    // Proforma generada desde una compra: enlazarlas (compras.orden_compra_id)
    if (_ocCompraOrigenId) {
      const enlazado = await updateCompra(_ocCompraOrigenId, { orden_compra_id: ocGuardada.id })
      if (!enlazado) showToast('Proforma creada, pero no se pudo enlazar con la compra. Revisa el SQL 92.', 'warning')
      _ocCompraOrigenId = null
      if (typeof renderCompras === 'function') renderCompras()
    }

    if (imp.es_importacion) {
      const falt = _camposPIFaltantes(imp)
      showToast('Proforma creada. Confírmala para poder abrir su carpeta.' +
        (falt.length ? ` Quedó en blanco: ${falt.join(', ')} (se completa con «Completar PI» o con el CI).` : ''), falt.length ? 'info' : 'success')
    } else showToast('Orden de Compra creada exitosamente', 'success')
    window.closeModal('modal-nueva-oc')
    _ocCompraOrigenId = null
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
    document.getElementById('newDetalleOCDescuento').value = '0'

    // Importación: sin IGV peruano (se paga con la DAM) y con peso visible,
    // que es la base del prorrateo del flete y de los gastos físicos.
    const esImp = !!document.getElementById('ocEsImportacion')?.checked
    document.getElementById('newDetalleOCIGV').value = esImp ? '0' : '18'
    const grupoImp = document.getElementById('ocDetalleGrupoImportacion')
    if (grupoImp) grupoImp.style.display = esImp ? 'grid' : 'none'
    if (esImp) {
      // El peso neto suele ser la misma cantidad cuando se compra por kilo
      const unidad = document.getElementById('newDetalleOCUnidad')
      if (unidad && !unidad.value) unidad.value = 'KG'
    }

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
          <td style="text-align:right;">${(parseFloat(d.precio_unitario) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 })}</td>
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

    const numOrNull = id => { const x = parseFloat(document.getElementById(id)?.value); return Number.isFinite(x) ? x : null }

    detallesOCEnCreacion.push({
      item_id:         itemId,
      nombre:          sel?.selectedOptions[0]?.text || '',
      cantidad,
      unidad_medida:   unidad,
      // Importación: el peso es la base del prorrateo del flete y de los
      // gastos fisicos (estiba, almacen, transporte local).
      peso_neto:           numOrNull('newDetalleOCPesoNeto'),
      peso_bruto:          numOrNull('newDetalleOCPesoBruto'),
      bultos:              numOrNull('newDetalleOCBultos'),
      partida_arancelaria: document.getElementById('newDetalleOCPartida')?.value?.trim() || null,
      precio_unitario: precio,
      igv_porcentaje:  igvPct,
      subtotal:        parseFloat(subtotal.toFixed(2)),
      igv_monto:       parseFloat(igvMonto.toFixed(2)),
      total:           parseFloat(total.toFixed(2))
    })

    _renderTablaDetalleOC()
    window.ocCalcularAnticipo()
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
