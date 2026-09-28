// ============================================================================
// compras/compra-nueva.js — parte de compras.js (reorganizado 2026-09-25, sin cambios de lógica)
// Mapa completo de funciones: Claude outputs/glosario_funciones_erp.md
// ============================================================================
import { getCurrentUser } from '../auth-supabase.js'
import { getCompraById, addCompra, addCompraDetalle, getSuppliers, getContactById, generarAsientoCompra, subirAdjuntoCompra, getUrlAdjuntoCompra, eliminarAdjuntoCompra } from '../supabase-data.js'
import { ASIENTOS_AUTO_COMPRAS_ACTIVO } from '../config-asientos-auto.js'
import { showToast, formatNumber, pintarDocumentoContacto } from '../helpers.js'
import { getModuloConfig } from '../config-modulo.js'
import { renderEditorCronograma, actualizarCronograma, leerCronograma } from '../cronograma.js'
import { _invalidarCacheCompras } from './anulacion.js'
import { _aplicarAnticiposSeleccionados, _cargarAnticiposDisponiblesProveedor } from './compra-servicio-anticipo.js'
import { renderCompras } from './compras-lista.js'
import { _crearCuentaPagarSiFactura, cargarItemsSelectDetalle } from './ordenes-compra.js'

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

export let _detallesCompraEnCreacion = []

// Tipo actualmente seleccionado en el modal unificado: 'mercaderia' | 'servicio' | 'anticipo'.
export let _tipoCompraActual = 'mercaderia'

/** Punto de entrada único del botón "+ Nueva Compra" — reemplaza a los
 * antiguos abrirModalNuevaCompraMercaderia/abrirModalCompraServicio, hoy
 * fusionados en un solo modal con selector de Tipo (2026-09-07). */
window.abrirModalNuevaCompra = function () {
  _detallesCompraEnCreacion = []
  _totalesCompraManual = false
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

/** Pinta el RUC/DNI del proveedor elegido debajo de su selector — reutilizable
 * en cualquier selector de Proveedor de Compras (Orden de Compra, Nueva
 * Compra). getSuppliers() ya está cacheado por getContacts() internamente,
 * así que llamarlo de nuevo aquí no pega otra vez a la BD. */
async function _pintarDocProveedorCompras(selectId, infoId) {
  const supplierId = parseInt(document.getElementById(selectId)?.value || 0)
  if (!supplierId) { pintarDocumentoContacto(infoId, null); return }
  const proveedores = await getSuppliers()
  pintarDocumentoContacto(infoId, proveedores.find(p => p.id === supplierId) || null)
}

/** Orden de Compra: mismo patrón que Nueva Compra. */
window._onCambiarProveedorOC = function () {
  _pintarDocProveedorCompras('ocProveedor', 'ocProveedorDocInfo')
}

/** Se llama al elegir proveedor: precarga el término habitual de ESE proveedor
 * y refresca la lista de anticipos disponibles de ese mismo proveedor. */
window.onCambiarProveedorCompra = function () {
  _pintarDocProveedorCompras('nqProveedor', 'nqProveedorDocInfo')
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
export function _calcularMontosDetalleCompra(cantidad, precio, descuento, igvValor) {
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
      glosa:           '', // vacío = usa el nombre del ítem; editable en la tabla para anotar algo distinto (ej. "incluye flete")
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

// Si el usuario edita Subtotal o IGV a mano (ajuste por redondeo contra el
// comprobante físico del proveedor), dejamos de pisarlos con la suma del
// detalle en cada render — hasta que presione "↺ Recalcular desde el detalle".
let _totalesCompraManual = false

function _renderTablaDetalleCompra() {
  const container = document.getElementById('tabla-detalle-nueva-compra')
  if (container) {
    if (!_detallesCompraEnCreacion || _detallesCompraEnCreacion.length === 0) {
      container.innerHTML = '<p style="text-align: center; color: var(--text-secondary); padding: 20px;">Sin productos agregados</p>'
    } else {
      let html = `<table>
        <thead>
          <tr>
            <th>Producto</th><th>Glosa</th><th>Cantidad</th><th>Unidad</th>
            <th style="text-align:right;">P. Unitario</th>
            <th style="text-align:right;">Total</th>
            <th>N° Unidades</th><th></th>
          </tr>
        </thead>
        <tbody>`
      _detallesCompraEnCreacion.forEach((d, idx) => {
        html += `<tr>
          <td>${d.nombre || `Item #${d.item_id}`}</td>
          <td><input type="text" value="${(d.glosa || '').replace(/"/g, '&quot;')}" placeholder="${(d.nombre || '').replace(/"/g, '&quot;')}" oninput="window._setGlosaDetalleCompra(${idx}, this.value)" style="width:100%; min-width:120px;"></td>
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
  const totIgv  = _detallesCompraEnCreacion.reduce((s, d) => s + (parseFloat(d.igv_monto) || 0), 0)
  const elCant = document.getElementById('totalCantidadCompra')
  const elUnid = document.getElementById('totalUnidadesCompra')
  const elSub  = document.getElementById('totalSubtotalCompra')
  const elIgv  = document.getElementById('totalIGVCompra')
  const elTot  = document.getElementById('totalMontoCompra')
  if (elCant) elCant.textContent = totCant.toLocaleString('en-US', { maximumFractionDigits: 2 })
  if (elUnid) elUnid.textContent = totUnid.toLocaleString('en-US', { maximumFractionDigits: 2 })

  // Subtotal/IGV: en modo automático (el usuario no los tocó) siguen la suma
  // del detalle. En modo manual se respeta lo que el usuario escribió.
  if (!_totalesCompraManual) {
    if (elSub) elSub.value = totSub.toFixed(2)
    if (elIgv) elIgv.value = totIgv.toFixed(2)
  }
  window._recalcularTotalCompraDesdeInputs()

  const btnReset = document.getElementById('btnRecalcularTotalesCompra')
  if (btnReset) btnReset.style.display = _totalesCompraManual ? '' : 'none'

  _refrescarCronogramaCompra()
}

window._setGlosaDetalleCompra = function (idx, valor) {
  if (_detallesCompraEnCreacion[idx]) _detallesCompraEnCreacion[idx].glosa = valor
}

/** Total = Subtotal + IGV, siempre recalculado desde lo que se ve en pantalla
 *  (sea la suma automática del detalle o lo que el usuario haya tipeado). */
window._recalcularTotalCompraDesdeInputs = function () {
  const sub = parseFloat(document.getElementById('totalSubtotalCompra')?.value || 0)
  const igv = parseFloat(document.getElementById('totalIGVCompra')?.value || 0)
  const elTot = document.getElementById('totalMontoCompra')
  if (elTot) elTot.textContent = (sub + igv).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

window._onEditarTotalesCompra = function () {
  _totalesCompraManual = true
  const btnReset = document.getElementById('btnRecalcularTotalesCompra')
  if (btnReset) btnReset.style.display = ''
  window._recalcularTotalCompraDesdeInputs()
}

window._recalcularTotalesCompraDesdeDetalle = function () {
  _totalesCompraManual = false
  _renderTablaDetalleCompra()
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
    // Subtotal/IGV vienen del input (igual a la suma del detalle salvo que el
    // usuario los haya ajustado a mano por redondeo contra el comprobante
    // físico) — el Total de cabecera siempre es Subtotal + IGV, nunca la suma
    // de líneas directa, para que cuadre con lo que se ve en pantalla.
    const subtotalC = parseFloat(document.getElementById('totalSubtotalCompra')?.value || 0)
      || _detallesCompraEnCreacion.reduce((s, d) => s + (parseFloat(d.subtotal) || 0), 0)
    const igvC      = parseFloat(document.getElementById('totalIGVCompra')?.value || 0)
      || _detallesCompraEnCreacion.reduce((s, d) => s + (parseFloat(d.igv_monto) || 0), 0)
    const totalC    = parseFloat((subtotalC + igvC).toFixed(2))
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
        descripcion:     (d.glosa || '').trim() || d.nombre || `Item #${d.item_id}`,
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
    _totalesCompraManual = false
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
