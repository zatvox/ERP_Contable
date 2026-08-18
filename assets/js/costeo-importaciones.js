// ============================================================================
// COSTEO-IMPORTACIONES.JS - Módulo Costeo de Importaciones (Async/Await)
// ============================================================================

import { getCurrentUser } from './auth-supabase.js'
import { getLotes, getItems,
  /*Comercial Invoice*/addComercialInvoice, getComercialInvoiceById, updateComercialInvoice, getComercialInvoices, deleteComercialInvoice,
  /*Bill Of Lading*/getBillOfLadings, getBillOfLadingById, addBillOfLading, updateBillOfLading, deleteBillOfLading, 
  /*DAM*/getDAMs, getDAMById, addDAM, getDAMByImportacionId, updateDAM, deleteDAM,
  /*Guía de Remisión*/getGuiasRemision, getGuiaRemisionById, addGuiaRemision, getGuiaRemisionByImportacionId, updateGuiaRemision, deleteGuiaRemision,
  /*Gastos Locales*/getGastosLocales, getGastoLocalById, addGastoLocal, getGastoLocalByImportacionId, updateGastoLocal, deleteGastoLocal,
  /*Pagos*/getPagos, getPagoById, addPago, getPagoByImportacionId, updatePago, deletePago,
  /*Detalle Comercial Invoice*/getDetalleCI, getDetalleCIById, getDetalleCIByComercialInvoiceId, addDetalleCI, updateDetalleCI, deleteDetalleCI, calcularTotalesCI, calcularCostoDetalleCI,
  /*Contactos y proveedores*/getContacts, getSuppliers, getSupplierById, addContact, updateContact, deleteContact,
  /*Asientos contables*/generarAsientoFacturaImportacion, generarAsientoLiquidacionDAM,
  generarAsientoGuiaRemision, getJournalEntryByReferencia, eliminarAsientoContable,
  /*Ordenes de Compra y detalles*/getOrderCompras, getOrderCompraById, getOrderCompraDetalles, getOrderCompraDetalleById
} from './supabase-data.js'
import { getTCCompra } from './sunat-api.js'
import { showToast, formatNumber, formatQty } from './helpers.js'

// ─── TC COMPRA automático para DAM ───────────────────────────────────────────

/**
 * Consulta TC COMPRA SBS para la fecha del formulario DAM y llena el campo.
 * Importaciones en USD → Art. 61° LIR → TC COMPRA.
 */
window.autoFetchTCCompraDAM = async function () {
  const campo = document.getElementById('newDAMTipoCambio')
  const aviso = document.getElementById('newDAMTCAviso')
  if (!campo) return

  const fecha = document.getElementById('newDAMFecha')?.value || null
  if (aviso) aviso.textContent = 'Consultando SBS...'

  const result = await getTCCompra(fecha)
  if (result.error) {
    if (aviso) aviso.textContent = `⚠️ ${result.error} — ingresa TC manualmente`
    showToast('No se pudo obtener el TC de SUNAT. Ingresa el tipo de cambio manualmente.', 'warning')
    return
  }

  campo.value = result.tc.toFixed(3)
  if (typeof calculoAutomaticoImpuestosNewDAM === 'function') calculoAutomaticoImpuestosNewDAM()
  if (aviso) aviso.textContent = `TC Compra SBS ${result.fecha}: S/. ${result.tc.toLocaleString('en-US', { minimumFractionDigits: 3, maximumFractionDigits: 3 })} — Art. 61° LIR`
}

// ─────────────────────────────────────────────────────────────────────────────

const COSTEO_KEY = 'costeoImportaciones_erp'
/*let costeoActual = null*/
let contenedorActual = null

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

    initTabsCosteo()
    await cargarProveedoresSelect()
    await cargarProductosSelectCosteo()
    await cargarImportacionesList()
    
    // Inicializar cálculos automáticos en vivo
    initCalculosAutomaticos()

    const costSeguroInput = document.getElementById('newCostoSeguro')
    const costoFleteInput = document.getElementById('newCostoFlete')
    const prodFOBInput = document.getElementById('newProdFOBSol')
    
    const triggerValidationFOB = () => window.validarCalculoFOB()
    
    if (costSeguroInput) costSeguroInput.addEventListener('change', triggerValidationFOB)
    if (costoFleteInput) costoFleteInput.addEventListener('change', triggerValidationFOB)
    if (prodFOBInput) prodFOBInput.addEventListener('change', triggerValidationFOB)
      
    // Cargar primera importación si existe
    const costeos = await getComercialInvoices()
    if (costeos && costeos.length > 0) {
      const selector = document.getElementById('costeoSelector')
      if (selector) {
        selector.value = costeos[0].id
        await window.cargarImportacionesEnSelect('costeoSelector')
      }
    }
  } catch (error) {
    console.error('Error en DOMContentLoaded:', error)
    showToast('Error al cargar el módulo de costeo', 'danger')
  }
})

window.validarCalculoFOB = function() {
  try {
    const costo_seguro = parseFloat(document.getElementById('newCostoSeguro')?.value || 0)
    const costo_flete = parseFloat(document.getElementById('newCostoFlete')?.value || 0)
    const totalValorNueva = parseFloat(document.getElementById('totalValorNueva')?.textContent || 0)
    const fobIngresado = parseFloat(document.getElementById('newProdFOBSol')?.value || 0)
    
    // Calcular FOB teórico: CIF - Flete - Seguro
    const fobTeorico = parseFloat((totalValorNueva - costo_flete - costo_seguro).toFixed(2))
    
    // Mostrar alerta si hay inconsistencia
    const alertaFOB = document.getElementById('alerta-fob-inconsistencia')
    const tolerancia = 0.01
    
    if (fobIngresado > 0 && Math.abs(fobTeorico - fobIngresado) > tolerancia) {
      if (alertaFOB) {
        alertaFOB.style.display = 'block'
        alertaFOB.innerHTML = `
          ⚠️ <strong>Inconsistencia en cálculo FOB</strong><br>
          FOB Teórico: $${fobTeorico.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} | FOB Ingresado: $${fobIngresado.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}<br>
          Diferencia: $${Math.abs(fobTeorico - fobIngresado).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}<br>
          <small>Revisa los costos de flete y seguro</small>
        `
      }
    } else {
      if (alertaFOB) {
        alertaFOB.style.display = 'none'
      }
    }
  } catch (error) {
    console.error('Error en validarCalculoFOB:', error)
  }
}

function initTabsCosteo() {
  const btns = document.querySelectorAll('#costeoTabs .tab-btn')
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
      
      if (tab === 'cabecera') await cargarCabecera()
      if (tab === 'detalle-ci') await renderDetalleCI()
      if (tab === 'billoflading') await renderBillOfLadings()
      if (tab === 'dam') await renderDAM()
      if (tab === 'productos') await cargarContenedoresEnSelect('productoContenedor')
      if (tab === 'guia-remision') await renderGuiaRemision()
      if (tab === 'gastos-locales') await renderGastosLocales()
      if (tab === 'pagos') await renderPagos()
      if (tab === 'despacho') await renderDespacho()
      if (tab === 'financieros') await renderFinancieros()
      if (tab === 'resumen') await renderResumenFinal()
    })
  })
}

// ============================================================================
// INICIALIZAR CÁLCULOS AUTOMÁTICOS EN VIVO
// ============================================================================

function initCalculosAutomaticos() {
  // =====================================================================
  // MODAL: NUEVO DETALLE CI - Costo Total = Cantidad Unid * Costo Unitario
  // =====================================================================
  const newNetoInput = document.getElementById('newDetalleCantidadNeto')
  const newUnitPriceInput = document.getElementById('newDetalleCostoUnit')
  const newTotalCostInput = document.getElementById('newDetalleCostoTotal')

  const calculateNewTotal = () => {
    if (newNetoInput && newUnitPriceInput && newTotalCostInput) {
      const qty = parseFloat(newNetoInput.value) || 0
      const unitPrice = parseFloat(newUnitPriceInput.value) || 0
      newTotalCostInput.value = (qty * unitPrice).toFixed(2)
      newTotalCostInput.dispatchEvent(new Event('input', { bubbles: true }))
    }
  }

  if (newNetoInput) newNetoInput.addEventListener('input', calculateNewTotal)
  if (newUnitPriceInput) newUnitPriceInput.addEventListener('input', calculateNewTotal)

  // =====================================================================
  // MODAL: EDITAR DETALLE CI - Costo Total = Cantidad Unid * Costo Unitario
  // =====================================================================
  const editNetoInput = document.getElementById('editDetalleCantidadNeto')
  const editUnitPriceInput = document.getElementById('editDetalleCostoUnit')
  const editTotalCostInput = document.getElementById('editDetalleCostoTotal')

  const calculateEditTotal = () => {
    if (editNetoInput && editUnitPriceInput && editTotalCostInput) {
      const qty = parseFloat(editNetoInput.value) || 0
      const unitPrice = parseFloat(editUnitPriceInput.value) || 0
      editTotalCostInput.value = (qty * unitPrice).toFixed(2)
      editTotalCostInput.dispatchEvent(new Event('input', { bubbles: true }))
    }
  }

  if (editNetoInput) editNetoInput.addEventListener('input', calculateEditTotal)
  if (editUnitPriceInput) editUnitPriceInput.addEventListener('input', calculateEditTotal)

  // =====================================================================
  // MODAL: NUEVO GASTO DESPACHO - Costo S/ = Costo USD * T.C.
  // =====================================================================
  const gastoUSDInput = document.getElementById('newGastoUSD')
  const gastoTCInput = document.getElementById('newGastoTC')
  const gastoSolInput = document.getElementById('newGastoSol')

  const calculateGastoSol = () => {
    if (gastoUSDInput && gastoTCInput && gastoSolInput) {
      const usd = parseFloat(gastoUSDInput.value) || 0
      const tc = parseFloat(gastoTCInput.value) || 0
      gastoSolInput.value = (usd * tc).toFixed(2)
      gastoSolInput.dispatchEvent(new Event('input', { bubbles: true }))
    }
  }

  if (gastoUSDInput) gastoUSDInput.addEventListener('input', calculateGastoSol)
  if (gastoTCInput) gastoTCInput.addEventListener('input', calculateGastoSol)

  // =====================================================================
  // MODAL: NUEVO GASTO LOCAL - Monto S/ = Monto USD * T.C.
  // =====================================================================
  const gastoLocalUSDInput = document.getElementById('newGastoLocalMontUSD')
  const gastoLocalTCInput = document.getElementById('newGastoLocalTC')
  const gastoLocalSolInput = document.getElementById('newGastoLocalMontoSol')

  const calculateGastoLocalSol = () => {
    if (gastoLocalUSDInput && gastoLocalTCInput && gastoLocalSolInput) {
      const usd = parseFloat(gastoLocalUSDInput.value) || 0
      const tc = parseFloat(gastoLocalTCInput.value) || 0
      gastoLocalSolInput.value = (usd * tc).toFixed(2)
      gastoLocalSolInput.dispatchEvent(new Event('input', { bubbles: true }))
    }
  }

  if (gastoLocalUSDInput) gastoLocalUSDInput.addEventListener('input', calculateGastoLocalSol)
  if (gastoLocalTCInput) gastoLocalTCInput.addEventListener('input', calculateGastoLocalSol)

  // =====================================================================
  // MODAL: NUEVO PAGO - Monto S/ = Monto USD * T.C.
  // =====================================================================
  const pagoUSDInput = document.getElementById('newPagoMontoUSD')
  const pagoTCInput = document.getElementById('newPagoTC')
  const pagoSolInput = document.getElementById('newPagoMontoSol')

  const calculatePagoSol = () => {
    if (pagoUSDInput && pagoTCInput && pagoSolInput) {
      const usd = parseFloat(pagoUSDInput.value) || 0
      const tc = parseFloat(pagoTCInput.value) || 0
      pagoSolInput.value = (usd * tc).toFixed(2)
      pagoSolInput.dispatchEvent(new Event('input', { bubbles: true }))
    }
  }

  if (pagoUSDInput) pagoUSDInput.addEventListener('input', calculatePagoSol)
  if (pagoTCInput) pagoTCInput.addEventListener('input', calculatePagoSol)

  // =====================================================================
  // MODAL: NUEVO PRODUCTO FOB - FOB S/ = FOB USD * T.C. (si existe)
  // =====================================================================
  const prodFOBUSDInput = document.getElementById('newProdFOBUSD')
  const prodQuantityInput = document.getElementById('newProdCantidad')
  const prodFOBSolInput = document.getElementById('newProdFOBSol')

  const calculateProdFOB = () => {
    if (prodFOBUSDInput && prodQuantityInput && prodFOBSolInput) {
      const fobUsd = parseFloat(prodFOBUSDInput.value) || 0
      const qty = parseFloat(prodQuantityInput.value) || 0
      const total = (fobUsd * qty)
      prodFOBSolInput.value = total.toFixed(2)
      prodFOBSolInput.dispatchEvent(new Event('input', { bubbles: true }))
    }
  }

  if (prodFOBUSDInput) prodFOBUSDInput.addEventListener('input', calculateProdFOB)
  if (prodQuantityInput) prodQuantityInput.addEventListener('input', calculateProdFOB)
}

async function cargarImportacionesList() {
  try {
    const costeos = await getComercialInvoices()
    const selector = document.getElementById('costeoSelector')
    if (!selector) return
 
    selector.innerHTML = '<option value="">-- Selecciona una importación --</option>'
    costeos.forEach(costeo => {
      selector.innerHTML += `<option value="${costeo.id}">${costeo.invoice_number}</option>`
    })
    
    // Cargar ordenes de compra en el selector de nueva importación
    const ordenCompras = await getOrderCompras()
    const OCselector = document.getElementById('selectorNewImportacionOC')
    if (OCselector) {
      OCselector.innerHTML = '<option value="">-- Selecciona --</option>'
      ordenCompras.forEach(oc => {
        OCselector.innerHTML += `<option value="${oc.id}">${oc.numero}</option>`
      })
    }

    // Cargar proveedores en el selector de nueva importación
    const suppliers = await getSuppliers()
    const provSelector = document.getElementById('newProvId')
    if (provSelector) {
      provSelector.innerHTML = '<option value="">-- Selecciona --</option>'
      suppliers.forEach(supplier => {
        provSelector.innerHTML += `<option value="${supplier.id}">${supplier.nombre || supplier.razon_social}</option>`
      })
    }
  } catch (error) {
    console.error('Error en cargarImportacionesList:', error)
  }
}

window.cargarImportacionesEnSelect = async function(selectId) {
  try {
    const costeos = await getComercialInvoices()
    const select = document.getElementById(selectId)

    if (!select) return

    select.innerHTML = '<option value="">-- Selecciona una importación --</option>'
    costeos.forEach(imp => {
      select.innerHTML += `<option value="${imp.id}">${imp.invoice_number}</option>`
    })
  } catch (error) {
    console.error('Error en cargarImportacionesEnSelect:', error)
  }
}

window.cargarImportacion = async function () {
  try {
    const selector = document.getElementById('costeoSelector')
    if (!selector) return
 
    const importacionId = selector.value
    if (!importacionId) {
      showToast('Selecciona una importación', 'warning')
      return
    }
 
    const costeos = await getComercialInvoices()
    window.costeoActual = costeos.find(imp => imp.id === parseInt(importacionId))
 
    if (!window.costeoActual) {
      showToast('Importación no encontrada', 'danger')
      return
    }
 
    // NUEVO: Cargar detalles y recalcular totales
    const detalles = await getDetalleCIByComercialInvoiceId(window.costeoActual.id)
    window.costeoActual.detalles = detalles || []
 
    // Recalcular totales
    const totales = await calcularTotalesCI(window.costeoActual.id)
    window.costeoActual.total_unidades = totales.total_unidades
    window.costeoActual.cantidad_total_neto = totales.cantidad_total_neto
    window.costeoActual.cantidad_total_gross = totales.cantidad_total_gross
    window.costeoActual.valor_total_final_ci = totales.valor_total_final_ci
 
    await cargarCabecera()
    await renderDetalleCI()
    await renderBillOfLadings()
    //await renderContenedores()
    //await actualizarCabecera()
    await renderDAM()
    await renderGuiaRemision()
    await renderGastosLocales()
    await renderPagos()
 
    mostrarOcultarBotonesEdicion()
  } catch (error) {
    console.error('Error en cargarImportacion:', error)
    showToast('Error al cargar importación', 'danger')
  }
}

// ============================================================================
// FUNCIÓN: Confirmar y usar FOB teórico
// ============================================================================
 
window.confirmarFOBTeorico = async function () {
  try {
    if (!window.costeoTemporalSinGuardar || !window.totalesTemporales) {
      showToast('Error al procesar confirmación', 'danger')
      return
    }
    
    await updateComercialInvoice(window.costeoTemporalSinGuardar, window.totalesTemporales)
    
    showToast('Importación creada con FOB teórico ajustado', 'success')

    detallesCIEnCreacion = []
    _ocContextImportacion = null
    
    await cargarImportacionesList()
    const selector = document.getElementById('costeoSelector')
    if (selector && window.costeoTemporalSinGuardar) {
      selector.value = window.costeoTemporalSinGuardar
      await cargarImportacion()
    }
    
    document.getElementById('formNewImportacion').reset()
    window.closeModal('modal-confirmacion-fob')
    window.closeModal('modal-nueva-importacion')
    
    window.costeoTemporalSinGuardar = null
    window.totalesTemporales = null
  } catch (error) {
    console.error('Error en confirmarFOBTeorico:', error)
    showToast('Error al guardar importación', 'danger')
  }
}
 
window.cancelarFOBTeorico = async function () {
  try {
    if (window.costeoTemporalSinGuardar) {
      await deleteComercialInvoice(window.costeoTemporalSinGuardar)
    }
    
    window.costeoTemporalSinGuardar = null
    window.totalesTemporales = null
    
    window.closeModal('modal-confirmacion-fob')
    showToast('Importación no guardada. Revisa los valores de FOB, flete y seguro', 'warning')
  } catch (error) {
    console.error('Error en cancelarFOBTeorico:', error)
    showToast('Error al cancelar', 'danger')
  }
}

window.corregirFOBManualmente = async function () {
  try {
    window.closeModal('modal-confirmacion-fob')
    
    // Enfocar campo de flete o seguro para que el usuario lo corrija
    const costoFleteInput = document.getElementById('newCostoFlete')
    if (costoFleteInput) {
      costoFleteInput.focus()
      costoFleteInput.select()
    }
    
    showToast('Edita los valores de Flete y/o Seguro y vuelve a crear la importación', 'info')
  } catch (error) {
    console.error('Error en corregirFOBManualmente:', error)
  }
}
 
async function inicializarModalNuevaImportacion() {
  try {
    detallesCIEnCreacion = []
    _ocContextImportacion = null
    const tablaDetalle = document.getElementById('tabla-detalle-nueva-importacion')
    if (tablaDetalle) tablaDetalle.innerHTML = '<p style="text-align: center; color: var(--text-secondary); padding: 20px;">Selecciona una Orden de Compra para cargar los productos</p>'
    actualizarTotalesEnCreacion()
    await cargarImportacionesList()
    // Resetear campos auto-llenados
    const ocSel = document.getElementById('selectorNewImportacionOC')
    if (ocSel) ocSel.value = ''
    const provSel = document.getElementById('newProvId')
    if (provSel) provSel.value = ''
  } catch (error) {
    console.error('Error en inicializarModalNuevaImportacion:', error)
  }
}

window.crearImportacion = async function () {
  try {
    const user = await getCurrentUser()
    if (!user) {
      showToast('Usuario no autenticado', 'danger')
      return
    }
 
    const numero = document.getElementById('newInvoice')?.value || ''
    // Priorizar contact_id de la OC cargada; fallback al selector de proveedor
    const contact_id = _ocContextImportacion?.oc?.contact_id
      || parseInt(document.getElementById('newProvId')?.value || 0) || null
    const fecha = document.getElementById('newFecha')?.value || null
    const proforma_number = document.getElementById('newProforma')?.value || ''
    const product = document.getElementById('newProducto')?.value || ''
    const terminos_delivery = document.getElementById('newTerminosDelivery')?.value || 'FOB'
    const terminos_payment = document.getElementById('newTerminosPayment')?.value || ''
    const costo_seguro = parseFloat(document.getElementById('newCostoSeguro')?.value || 0)
    const costo_flete = parseFloat(document.getElementById('newCostoFlete')?.value || 0)
    const puerto_embarque = document.getElementById('newPuertoEmbarque')?.value || ''
    const pais_origen = document.getElementById('newPaisOrigen')?.value || ''
 
    if (!numero) {
      showToast('Ingresa el número de factura comercial', 'warning')
      return
    }
 
    const newCosteo = {
      fecha: fecha,
      contact_id: contact_id > 0 ? contact_id : null,
      invoice_number: numero,
      proforma_number: proforma_number,
      product: product,
      status: 'borrador',
      created_by: user.id,
      terminos_delivery: terminos_delivery,
      terminos_payment: terminos_payment,
      costo_seguro: costo_seguro,
      costo_flete: costo_flete,
      puerto_embarque: puerto_embarque,
      pais_origen: pais_origen,
      total_unidades: 0,
      cantidad_total_neto: 0,
      cantidad_total_gross: 0,
      valor_total_final_ci: 0,
      valor_total_final_fob: 0
    }
 
    const resultado = await addComercialInvoice(newCosteo)
    if (!resultado) {
      showToast('Error al guardar la importación', 'danger')
      return
    }
 
    if (detallesCIEnCreacion && detallesCIEnCreacion.length > 0) {
      for (const detalle of detallesCIEnCreacion) {
        const detalleConCI = {
          ...detalle,
          comercial_invoice_id: resultado.id
        }
        await addDetalleCI(detalleConCI)
      }
    }
 
    const totales = await calcularTotalesCI(resultado.id)
    
    // CÁLCULO FOB
    const valor_fob_teorico = parseFloat((totales.valor_total_final_ci - costo_flete - costo_seguro).toFixed(2))
    totales.valor_total_final_fob = valor_fob_teorico
    
    // VALIDACIÓN FOB CON CONFIRMACIÓN
    const fob_ingresado = parseFloat(document.getElementById('newProdFOBSol')?.value || 0)
    const tolerancia = 0.01
    
    if (fob_ingresado > 0 && Math.abs(valor_fob_teorico - fob_ingresado) > tolerancia) {
      // Guardar datos temporalmente para posible corrección
      window.costeoTemporalSinGuardar = resultado.id
      window.totalesTemporales = totales
      
      // Abrir modal de confirmación
      document.getElementById('modalConfirmacionFOB_teorico').textContent = valor_fob_teorico.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
      document.getElementById('modalConfirmacionFOB_ingresado').textContent = fob_ingresado.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
      document.getElementById('modalConfirmacionFOB_diferencia').textContent = Math.abs(valor_fob_teorico - fob_ingresado).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
      
      window.openModal('modal-confirmacion-fob')
      return
    }
    
    await updateComercialInvoice(resultado.id, totales)
 
    showToast('Importación creada exitosamente', 'success')

    detallesCIEnCreacion = []
    _ocContextImportacion = null

    await cargarImportacionesList()
    const selector = document.getElementById('costeoSelector')
    if (selector && resultado.id) {
      selector.value = resultado.id
      await cargarImportacion()
    }

    document.getElementById('formNewImportacion').reset()
    window.closeModal('modal-nueva-importacion')
  } catch (error) {
    console.error('Error en crearImportacion:', error)
    showToast('Error al crear importación', 'danger')
  }
}

function mostrarOcultarBotonesEdicion() {
  try {
    const btnEditar = document.getElementById('btnEditarImportacion')
    const btnEliminar = document.getElementById('btnEliminarImportacion')
 
    if (window.costeoActual && window.costeoActual.id) {
      // Mostrar botones
      if (btnEditar) btnEditar.style.display = 'inline-block'
      if (btnEliminar) btnEliminar.style.display = 'inline-block'
    } else {
      // Ocultar botones
      if (btnEditar) btnEditar.style.display = 'none'
      if (btnEliminar) btnEliminar.style.display = 'none'
    }
  } catch (error) {
    console.error('Error en mostrarOcultarBotonesEdicion:', error)
  }
}

window.editarImportacion = async function () {
  try {
    if (!window.costeoActual || !window.costeoActual.id) {
      showToast('Selecciona una importación primero', 'warning')
      return
    }
 
    // Cargar proveedores para el selector
    const suppliers = await getSuppliers()
    const provSelector = document.getElementById('editProvId')
    if (provSelector) {
      provSelector.innerHTML = '<option value="">-- Selecciona --</option>'
      suppliers.forEach(supplier => {
        provSelector.innerHTML += `<option value="${supplier.id}">${supplier.nombre || supplier.razon_social}</option>`
      })
      provSelector.value = window.costeoActual.contact_id || ''
    }
 
    // Llenar formulario con datos actuales
    document.getElementById('editInvoice').value = window.costeoActual.invoice_number || ''
    document.getElementById('editProforma').value = window.costeoActual.proforma_number || ''
    document.getElementById('editProducto').value = window.costeoActual.product || ''
    document.getElementById('editFecha').value = window.costeoActual.fecha || ''
    document.getElementById('editEstado').value = window.costeoActual.status || 'borrador'
    document.getElementById('editTerminosDelivery').value = window.costeoActual.terminos_delivery || 'FOB'
    document.getElementById('editTerminosPayment').value = window.costeoActual.terminos_payment || ''
    document.getElementById('editCostoSeguro').value = window.costeoActual.costo_seguro || 0
    document.getElementById('editCostoFlete').value = window.costeoActual.costo_flete || 0
    document.getElementById('editPuertoEmbarque').value = window.costeoActual.puerto_embarque || ''
    document.getElementById('editPaisOrigen').value = window.costeoActual.pais_origen || ''

    // Abrir modal
    window.openModal('modal-editar-importacion')
  } catch (error) {
    console.error('Error en editarImportacion:', error)
    showToast('Error al abrir formulario de edición', 'danger')
  }
}

window.guardarCambiosImportacion = async function () {
  try {
    if (!window.costeoActual || !window.costeoActual.id) {
      showToast('No hay importación seleccionada', 'danger')
      return
    }
 
    const invoice = document.getElementById('editInvoice')?.value || ''
    const proforma = document.getElementById('editProforma')?.value || ''
    const producto = document.getElementById('editProducto')?.value || ''
    const fecha = document.getElementById('editFecha')?.value || null
    const estado = document.getElementById('editEstado')?.value || 'borrador'
    const contactId = parseInt(document.getElementById('editProvId')?.value || 0)
    const terminosDelivery = document.getElementById('editTerminosDelivery')?.value || 'FOB'
    const terminosPayment = document.getElementById('editTerminosPayment')?.value || ''
    const costo_seguro = parseFloat(document.getElementById('editCostoSeguro')?.value || 0)
    const costo_flete = parseFloat(document.getElementById('editCostoFlete')?.value || 0)
    const puerto_embarque = document.getElementById('editPuertoEmbarque')?.value || ''
    const pais_origen = document.getElementById('editPaisOrigen')?.value || ''

    if (!invoice || !proforma || !producto || !fecha) {
      showToast('Completa todos los campos requeridos', 'warning')
      return
    }
 
    // Datos actualizados
    const datosActualizados = {
      invoice_number: invoice,
      proforma_number: proforma,
      product: producto,
      fecha: fecha,
      status: estado,
      contact_id: contactId > 0 ? contactId : null,
      terminos_delivery: terminosDelivery,
      terminos_payment: terminosPayment,
      costo_seguro: costo_seguro,
      costo_flete: costo_flete,
      puerto_embarque: puerto_embarque,
      pais_origen: pais_origen
    }
 
    // Actualizar en BD
    const resultado = await updateComercialInvoice(window.costeoActual.id, datosActualizados)
    if (!resultado) {
      showToast('Error al guardar cambios', 'danger')
      return
    }
 
    // Actualizar variable local
    window.costeoActual = resultado
 
    // Actualizar UI
    await cargarCabecera()
    await cargarImportacionesList()
 
    showToast('Importación actualizada', 'success')
    window.closeModal('modal-editar-importacion')
  } catch (error) {
    console.error('Error en guardarCambiosImportacion:', error)
    showToast('Error al guardar cambios', 'danger')
  }
}
 
window.eliminarImportacion = async function () {
  try {
    if (!window.costeoActual || !window.costeoActual.id) {
      showToast('Selecciona una importación primero', 'warning')
      return
    }
 
    // Confirmar eliminación
    const confirmMsg = `¿Estás seguro que deseas eliminar la importación "${window.costeoActual.invoice_number}"?\n\nEsta acción también eliminará todos los detalles, Bill of Lading, DAM, gastos locales y pagos asociados.`
    
    if (!confirm(confirmMsg)) {
      return
    }
 
    // Mostrar confirmación adicional
    if (!confirm('Esta acción es irreversible. ¿Continuar?')) {
      return
    }
 
    // Eliminar de BD (con CASCADE, se eliminan todos los relacionados)
    const resultado = await deleteComercialInvoice(window.costeoActual.id)
    if (!resultado) {
      showToast('Error al eliminar importación', 'danger')
      return
    }
 
    showToast('Importación eliminada', 'success')
 
    // Limpiar variables
    window.costeoActual = null
    detallesCIEnCreacion = []
 
    // Recargar selector
    await cargarImportacionesList()
 
    // Limpiar contenido
    const selector = document.getElementById('costeoSelector')
    if (selector) {
      selector.value = ''
    }
 
    // Limpiar tabs
    document.getElementById('tabla-detalle-nueva-importacion').innerHTML = '<p style="text-align: center; color: var(--text-secondary); padding: 20px;">Sin detalles</p>'
    
    // Ocultar botones de edición
    mostrarOcultarBotonesEdicion()
 
    // Resetear formulario
    document.getElementById('formNewImportacion').reset()
  } catch (error) {
    console.error('Error en eliminarImportacion:', error)
    showToast('Error al eliminar importación', 'danger')
  }
}

window.cargarOCDesdeNewImportacion = async function () {
  try {
    const orderCompraId = document.getElementById('selectorNewImportacionOC')?.value || null
    if (!orderCompraId) return

    const oc = await getOrderCompraById(parseInt(orderCompraId))
    if (!oc) { showToast('Orden de compra no encontrada', 'danger'); return }

    const detallesOC = await getOrderCompraDetalles(oc.id) || []
    if (detallesOC.length === 0) {
      showToast('La OC seleccionada no tiene productos. Agrégalos en el módulo de Compras primero.', 'warning')
      return
    }

    // Mapa de items para obtener nombres
    const items = await getItems()
    const itemsMap = {}
    items.forEach(i => { itemsMap[i.id] = i })

    // Proveedor
    const proveedores = await getSuppliers()
    const prov = proveedores.find(p => p.id === oc.contact_id) || null

    // Guardar contexto (para crearImportacion)
    _ocContextImportacion = { oc, detallesOC, prov }

    // Auto-fill: Proveedor (select value)
    const provSelect = document.getElementById('newProvId')
    if (provSelect && oc.contact_id) provSelect.value = oc.contact_id

    // Auto-fill: Fecha
    const fechaEl = document.getElementById('newFecha')
    if (fechaEl) fechaEl.value = oc.fecha || ''

    // Auto-fill: Producto principal = nombres de productos de la OC (únicos, separados por coma)
    const nombresProductos = detallesOC
      .map(d => itemsMap[d.item_id]?.nombre || itemsMap[d.item_id]?.name || `Artículo #${d.item_id}`)
      .filter((v, i, a) => a.indexOf(v) === i)
      .join(', ')
    const productoEl = document.getElementById('newProducto')
    if (productoEl) productoEl.value = nombresProductos

    // Construir detallesCIEnCreacion a partir de los detalles de la OC
    detallesCIEnCreacion = detallesOC.map(d => {
      const item = itemsMap[d.item_id]
      const nombre = item?.nombre || item?.name || `Artículo #${d.item_id}`
      const cantidadNeto  = parseFloat(d.cantidad || 0)
      const costoUnitario = parseFloat(d.precio_unitario || 0)
      // subtotal de la OC = valor FOB (sin IGV); si no existe usar cantidad * precio
      const costoTotal    = parseFloat(d.subtotal || (cantidadNeto * costoUnitario) || 0)
      return {
        lote:            '',
        producto:        nombre,
        cantidad_neto:   cantidadNeto,
        cantidad_gross:  cantidadNeto,   // igual al neto por defecto; el usuario puede editar el CI después
        cantidad_unid:   0,
        costo_unitario:  costoUnitario,
        costo_total:     costoTotal
      }
    })

    // Renderizar tabla (solo lectura — sin botón Eliminar)
    await renderDetallesCIEnCreacion(true)
    showToast(`OC ${oc.numero} cargada: ${detallesOC.length} producto(s)`, 'success')
  } catch (error) {
    console.error('Error en cargarOCDesdeNewImportacion:', error)
    showToast('Error al cargar datos de la OC', 'danger')
  }
}


// ============================================================================
// VARIABLES GLOBALES
// ============================================================================
 
let detallesCIEnCreacion = []   // Array temporal para detalles mientras se crea la CI
let _ocContextImportacion = null // Contexto de la OC vinculada al modal nueva importación
 
// ============================================================================
// FUNCIÓN: abrirModalDetalleDesdeCrear
// Abre modal de detalle desde el modal de nueva importación
// ============================================================================
 
window.abrirModalDetalleDesdeCrear = async function () {
  try {
    const invoiceNumber = document.getElementById('newInvoice')?.value || ''
    
    // VALIDACIÓN: Si no hay invoice_number, mostrar alerta
    if (!invoiceNumber || invoiceNumber.trim() === '') {
      document.getElementById('alerta-invoice-vacio').style.display = 'block'
      setTimeout(() => {
        document.getElementById('alerta-invoice-vacio').style.display = 'none'
      }, 3000)
      return
    }
 
    // Actualizar título del modal con el invoice_number
    document.getElementById('tituloModalDetalle').textContent = `Agregando producto en importación: ${invoiceNumber}`
 
    // Cargar productos en el select
    await cargarProductosEnSelectDetalle()
    
    // Limpiar formulario
    document.getElementById('formNewDetalle').reset()
    document.getElementById('alerta-invoice-vacio').style.display = 'none'
 
    // Abrir modal
    window.openModal('modal-nuevo-detalle-ci')
  } catch (error) {
    console.error('Error en abrirModalDetalleDesdeCrear:', error)
    showToast('Error al abrir formulario', 'danger')
  }
}

async function renderDetalleCI() {
  try {
    if (!window.costeoActual || !window.costeoActual.id) {
      console.warn("No hay una importación seleccionada.")
      return
    }
 
    const tabla = document.getElementById('tabla-detalle-ci')
    if (!tabla) return
 
    const detalles = await getDetalleCIByComercialInvoiceId(window.costeoActual.id)
 
    if (!detalles || detalles.length === 0) {
      tabla.innerHTML = '<p style="text-align: center; color: var(--text-secondary); padding: 20px;">Sin detalles</p>'
      return
    }
 
    let html = `
      <table>
        <thead>
          <tr>
            <th>Lote</th>
            <th>Producto</th>
            <th>Cant Neto Kg</th>
            <th>Cant Gross Kg</th>
            <th>Cantidad Unid</th>
            <th>Costo Unit $</th>
            <th>Costo Total $</th>
            <th>Acciones</th>
          </tr>
        </thead>
        <tbody>
    `
 
    detalles.forEach(detalle => {
      html += `
        <tr>
          <td>${detalle.lote || '-'}</td>
          <td><strong>${detalle.producto || '-'}</strong></td>
          <td>${(detalle.cantidad_neto || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
          <td>${(detalle.cantidad_gross || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
          <td>${formatQty(detalle.cantidad_unid || 0)}</td>
          <td>$${(detalle.costo_unitario || 0).toLocaleString('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 4 })}</td>
          <td>$${(detalle.costo_total || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
          <td>
            <button class="btn btn-small btn-secondary" onclick="window.editarDetalleCI('${detalle.id}')">Editar</button>
            <button class="btn btn-small btn-danger" onclick="window.eliminarDetalleCI('${detalle.id}')">Eliminar</button>
          </td>
        </tr>
      `
    })
 
    html += '</tbody></table>'
    tabla.innerHTML = html
  } catch (error) {
    console.error('Error en renderDetalleCI:', error)
    showToast('Error al cargar detalle CI', 'danger')
  }
}

async function renderDetallesCabecera() {
  try {
    if (!window.costeoActual || !window.costeoActual.id) {
      return
    }
 
    const tabla = document.getElementById('tabla-detalles-cabecera')
    if (!tabla) return
 
    const detalles = await getDetalleCIByComercialInvoiceId(window.costeoActual.id)
    const productos = await getItems()
    const detallesConProductos = detalles.map(detalle => {
      const producto = productos.find(p => p.id === detalle.producto)
      return {
        ...detalle,
        producto: producto ? producto.nombre : 'Producto no encontrado'
      }
    })
    if (!detalles || detalles.length === 0) {
      tabla.innerHTML = '<p style="text-align: center; color: var(--text-secondary); padding: 20px;">Sin detalles agregados</p>'
      return
    }
 
    let html = `
      <table>
        <thead>
          <tr>
            <th>Lote</th>
            <th>Producto</th>
            <th>Cant Neto (Kg)</th>
            <th>Cant Gross (Kg)</th>
            <th>Cantidad (Unid)</th>
            <th>Costo Unit ($)</th>
            <th>Costo Total ($)</th>
            <th>Acciones</th>
          </tr>
        </thead>
        <tbody>
    `
 
    detallesConProductos.forEach(detalle => {
      html += `
        <tr>
          <td>${detalle.lote || '-'}</td>
          <td><strong>${detalle.producto || '-'}</strong></td>
          <td>${(detalle.cantidad_neto || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
          <td>${(detalle.cantidad_gross || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
          <td>${formatQty(detalle.cantidad_unid || 0)}</td>
          <td>\$${(detalle.costo_unitario || 0).toLocaleString('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 4 })}</td>
          <td>\$${(detalle.costo_total || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
          <td>
            <button class="btn btn-small btn-secondary" onclick="window.editarDetalleCI('${detalle.id}')">✏️ Editar</button>
            <button class="btn btn-small btn-danger" onclick="window.eliminarDetalleCI('${detalle.id}')">🗑️ Eliminar</button>
          </td>
        </tr>
      `
    })
 
    html += '</tbody></table>'
    tabla.innerHTML = html
  } catch (error) {
    console.error('Error en renderDetallesCabecera:', error)
  }
}

/*Detalles en creación de importación (sin guardar aún)
  readOnly=true: se usa cuando los detalles vienen de la OC (no se pueden eliminar aquí) */
async function renderDetallesCIEnCreacion(readOnly = false) {
  try {
    const tabla = document.getElementById('tabla-detalle-nueva-importacion')
    if (!tabla) return

    if (!detallesCIEnCreacion || detallesCIEnCreacion.length === 0) {
      tabla.innerHTML = '<p style="text-align: center; color: var(--text-secondary); padding: 20px;">Selecciona una Orden de Compra para cargar los productos</p>'
      actualizarTotalesEnCreacion()
      return
    }

    let html = `
      <table style="width: 100%; border-collapse: collapse;">
        <thead style="background-color: var(--bg-secondary);">
          <tr>
            <th style="padding: 10px; text-align: left; border-bottom: 1px solid var(--border-color);">Producto</th>
            <th style="padding: 10px; text-align: right; border-bottom: 1px solid var(--border-color);">Neto Kg</th>
            <th style="padding: 10px; text-align: right; border-bottom: 1px solid var(--border-color);">Gross Kg</th>
            <th style="padding: 10px; text-align: right; border-bottom: 1px solid var(--border-color);">Unid</th>
            <th style="padding: 10px; text-align: right; border-bottom: 1px solid var(--border-color);">Costo Unit $</th>
            <th style="padding: 10px; text-align: right; border-bottom: 1px solid var(--border-color);">Total $</th>
            ${readOnly ? '' : '<th style="padding: 10px; border-bottom: 1px solid var(--border-color);">Acciones</th>'}
          </tr>
        </thead>
        <tbody>
    `

    detallesCIEnCreacion.forEach((detalle, index) => {
      html += `
        <tr style="border-bottom: 1px solid var(--border-color);">
          <td style="padding: 10px;"><strong>${detalle.producto || '-'}</strong></td>
          <td style="padding: 10px; text-align: right;">${(detalle.cantidad_neto || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
          <td style="padding: 10px; text-align: right;">${(detalle.cantidad_gross || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
          <td style="padding: 10px; text-align: right;">${formatQty(detalle.cantidad_unid || 0)}</td>
          <td style="padding: 10px; text-align: right;">$${(detalle.costo_unitario || 0).toLocaleString('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 4 })}</td>
          <td style="padding: 10px; text-align: right;">$${(detalle.costo_total || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
          ${readOnly ? '' : `<td style="padding: 10px;">
            <button class="btn btn-small btn-danger" onclick="window.eliminarDetalleEnCreacion(${index})">Eliminar</button>
          </td>`}
        </tr>
      `
    })

    html += '</tbody></table>'
    tabla.innerHTML = html
    actualizarTotalesEnCreacion()
  } catch (error) {
    console.error('Error en renderDetallesCIEnCreacion:', error)
  }
}
 
function actualizarTotalesEnCreacion() {
  try {
    if (!detallesCIEnCreacion || detallesCIEnCreacion.length === 0) {
      document.getElementById('totalUnidadesNueva').textContent = '0'
      document.getElementById('totalNetoNueva').textContent = '0'
      document.getElementById('totalGrossNueva').textContent = '0'
      document.getElementById('totalValorNueva').textContent = '0.00'
      return
    }
 
    const totales = detallesCIEnCreacion.reduce((acc, detalle) => {
      return {
        unidades: acc.unidades + (detalle.cantidad_unid || 0),
        neto: acc.neto + (detalle.cantidad_neto || 0),
        gross: acc.gross + (detalle.cantidad_gross || 0),
        valor: acc.valor + (detalle.costo_total || 0)
      }
    }, { unidades: 0, neto: 0, gross: 0, valor: 0 })
 
    document.getElementById('totalUnidadesNueva').textContent = totales.unidades.toString()
    document.getElementById('totalNetoNueva').textContent = totales.neto.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    document.getElementById('totalGrossNueva').textContent = totales.gross.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    document.getElementById('totalValorNueva').textContent = totales.valor.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  } catch (error) {
    console.error('Error en actualizarTotalesEnCreacion:', error)
  }
}
 
window.eliminarDetalleEnCreacion = async function (index) {
  try {
    if (index < 0 || index >= detallesCIEnCreacion.length) return
 
    detallesCIEnCreacion.splice(index, 1)
    await renderDetallesCIEnCreacion()
    showToast('Producto eliminado', 'success')
  } catch (error) {
    console.error('Error en eliminarDetalleEnCreacion:', error)
    showToast('Error al eliminar producto', 'danger')
  }
}
 
window.cerrarModalDetalleCI = function () {
  window.closeModal('modal-nuevo-detalle-ci')
  document.getElementById('formNewDetalle').reset()
}

window.crearDetalleCI = async function () {
  try {
    const invoiceNumber = document.getElementById('newInvoice')?.value || ''
    
    // VALIDACIÓN: Invoice_number debe existir
    if (!invoiceNumber || invoiceNumber.trim() === '') {
      showToast('Ingresa el número de Commercial Invoice', 'warning')
      return
    }
 
    const lote = document.getElementById('newDetalleLote')?.value || ''
    const producto = document.getElementById('newDetalleProducto')?.value || ''
    const cantidadNeto = parseFloat(document.getElementById('newDetalleCantidadNeto')?.value || 0)
    const cantidadGross = parseFloat(document.getElementById('newDetalleCantidadGross')?.value || 0)
    const cantidadUnid = parseInt(document.getElementById('newDetalleCantidadUnid')?.value || 0)
    const costoUnitario = parseFloat(document.getElementById('newDetalleCostoUnit')?.value || 0)
 
    if (!producto || !cantidadUnid || !costoUnitario) {
      showToast('Completa los campos requeridos (producto, cantidad, costo)', 'warning')
      return
    }
 
    const costoTotal = calcularCostoDetalleCI(cantidadNeto, costoUnitario)
 
    // CREAR OBJETO TEMPORAL (sin ID, se generará al guardar en BD)
    const newDetalle = {
      lote: lote,
      producto: producto,
      cantidad_neto: cantidadNeto,
      cantidad_gross: cantidadGross,
      cantidad_unid: cantidadUnid,
      costo_unitario: costoUnitario,
      costo_total: costoTotal
    }
 
    // AGREGAR AL ARRAY TEMPORAL
    detallesCIEnCreacion.push(newDetalle)
 
    // ACTUALIZAR TABLA DE DETALLES
    await renderDetallesCIEnCreacion()
 
    // CERRAR MODAL Y LIMPIAR FORMULARIO
    window.closeModal('modal-nuevo-detalle-ci')
    document.getElementById('formNewDetalle').reset()
 
    showToast('Producto agregado', 'success')
  } catch (error) {
    console.error('Error en crearDetalleCI:', error)
    showToast('Error al agregar producto', 'danger')
  }
}

window.editarDetalleCI = async function (detalleId) {
  try {
    if (!detalleId) return
 
    const detalle = await getDetalleCIById(detalleId)
    if (!detalle) {
      showToast('Detalle no encontrado', 'danger')
      return
    }
 
    window.detalleActual = detalle
    
    // Cargar productos en el select
    await cargarProductosEnSelectEditDetalle(detalle.producto)
    
    document.getElementById('editDetalleLote').value = detalle.lote || ''
    document.getElementById('editDetalleProducto').value = detalle.producto || ''
    document.getElementById('editDetalleCantidadNeto').value = detalle.cantidad_neto || 0
    document.getElementById('editDetalleCantidadGross').value = detalle.cantidad_gross || 0
    document.getElementById('editDetalleCantidadUnid').value = detalle.cantidad_unid || 0
    document.getElementById('editDetalleCostoUnit').value = detalle.costo_unitario || 0
 
    window.openModal('modal-editar-detalle-ci')
  } catch (error) {
    console.error('Error en editarDetalleCI:', error)
    showToast('Error al editar detalle', 'danger')
  }
}
 
window.actualizarDetalleCI = async function () {
  try {
    if (!window.detalleActual) return
 
    const cantidadNeto = parseInt(document.getElementById('editDetalleCantidadNeto')?.value || 0)
    const costoUnitario = parseFloat(document.getElementById('editDetalleCostoUnit')?.value || 0)
    const costoTotal = calcularCostoDetalleCI(cantidadNeto, costoUnitario)
 
    const datosActualizados = {
      lote: document.getElementById('editDetalleLote')?.value || '',
      producto: document.getElementById('editDetalleProducto')?.value || '',
      cantidad_neto: parseFloat(document.getElementById('editDetalleCantidadNeto')?.value || 0),
      cantidad_gross: parseFloat(document.getElementById('editDetalleCantidadGross')?.value || 0),
      cantidad_unid: parseInt(document.getElementById('editDetalleCantidadUnid')?.value || 0),
      costo_unitario: costoUnitario,
      costo_total: costoTotal
    }
 
    const resultado = await updateDetalleCI(window.detalleActual.id, datosActualizados)
    if (!resultado) {
      showToast('Error al actualizar detalle', 'danger')
      return
    }
 
    showToast('Detalle actualizado', 'success')
    window.closeModal('modal-editar-detalle-ci')
    
    // Recalcular totales y actualizar
    const totales = await calcularTotalesCI(window.costeoActual.id)
    await updateComercialInvoice(window.costeoActual.id, totales)
    
    await renderDetalleCI()
    await cargarCabecera()
  } catch (error) {
    console.error('Error en actualizarDetalleCI:', error)
    showToast('Error al actualizar detalle', 'danger')
  }
}
 
window.eliminarDetalleCI = async function (detalleId) {
  try {
    if (!detalleId) return
    if (!confirm('¿Eliminar este detalle?')) return
 
    const resultado = await deleteDetalleCI(detalleId)
    if (!resultado) {
      showToast('Error al eliminar detalle', 'danger')
      return
    }
 
    showToast('Detalle eliminado', 'success')
    
    // Recalcular totales y actualizar
    const totales = await calcularTotalesCI(window.costeoActual.id)
    await updateComercialInvoice(window.costeoActual.id, totales)
    
    await renderDetalleCI()
    await cargarCabecera()
  } catch (error) {
    console.error('Error en eliminarDetalleCI:', error)
    showToast('Error al eliminar detalle', 'danger')
  }
}

// ============================================================================
// FUNCIÓN: cargarCabecera (ACTUALIZADA)
// ============================================================================
 
async function cargarCabecera() {
  try {
    if (!window.costeoActual) return
    const proveedores = await getSuppliers()
    const proveedor = proveedores.find(p => p.id === window.costeoActual.contact_id)
    const nombreProveedor = proveedor ? (proveedor.nombre || proveedor.razon_social) : 'N/A'

    document.getElementById('cabProveedor').value = nombreProveedor
    document.getElementById('cabInvoice').value = window.costeoActual.invoice_number || ''
    document.getElementById('cabProforma').value = window.costeoActual.proforma_number || ''
    document.getElementById('cabProducto').value = window.costeoActual.product || ''
    document.getElementById('cabFecha').value = window.costeoActual.fecha || ''
    document.getElementById('cabEstado').value = window.costeoActual.status || 'borrador'
    document.getElementById('cabCostoSeguro').value = window.costeoActual.costo_seguro || 0
    document.getElementById('cabCostoFlete').value = window.costeoActual.costo_flete || 0
    document.getElementById('cabPuertoEmbarque').value = window.costeoActual.puerto_embarque || ''
    document.getElementById('cabPaisOrigen').value = window.costeoActual.pais_origen || ''
    document.getElementById('cabPagado').value = window.costeoActual.pagado || 'Pendiente'
    
    // NUEVO: Campos adicionales
    document.getElementById('cabTerminosDelivery').value = window.costeoActual.terminos_delivery || 'FOB'
    document.getElementById('cabTerminosPayment').value = window.costeoActual.terminos_payment || ''
    document.getElementById('cabTotalUnidades').value = window.costeoActual.total_unidades || 0
    document.getElementById('cabCantidadTotalNeto').value = window.costeoActual.cantidad_total_neto || 0
    document.getElementById('cabCantidadTotalGross').value = window.costeoActual.cantidad_total_gross || 0
    document.getElementById('cabValorTotalCIF').value = (window.costeoActual.valor_total_final_ci || 0).toFixed(2)
    document.getElementById('cabValorTotalFOB').value = (window.costeoActual.valor_total_final_fob || 0).toFixed(2)
    
    showToast('Cabecera cargada', 'success')
    // Cargar detalles en el tab 1
    await renderDetallesCabecera()
  } catch (error) {
    console.error('Error en cargarCabecera:', error)
  }
}

// ============================================================================
// ASIENTOS CONTABLES DE IMPORTACIÓN
// ============================================================================

window.confirmarFacturaImportacion = async function () {
  try {
    if (!window.costeoActual || !window.costeoActual.id) {
      showToast('Carga una importación primero', 'warning')
      return
    }

    if (!confirm('¿Generar el asiento contable "Importación - Factura proveedor" para esta importación?')) return

    const user = await getCurrentUser()
    await generarAsientoFacturaImportacion(window.costeoActual.id, user?.id)
    showToast('Asiento de factura de importación generado', 'success')
  } catch (error) {
    console.error('Error en confirmarFacturaImportacion:', error)
    showToast(error.message || 'Error al generar el asiento de factura de importación', 'danger')
  }
}

window.liquidarDAM = async function (damId) {
  try {
    if (!confirm('¿Generar el asiento contable "Importación - Liquidación impuestos" para esta DAM?')) return

    const user = await getCurrentUser()
    await generarAsientoLiquidacionDAM(damId, user?.id)
    showToast('Asiento de liquidación de DAM generado', 'success')
  } catch (error) {
    console.error('Error en liquidarDAM:', error)
    showToast(error.message || 'Error al generar el asiento de liquidación DAM', 'danger')
  }
}

/*
window.calculoAutomaticoLiquidacionTotalNewDAM = async function () {
  try {
    const valorCIF = parseFloat(document.getElementById('newDAMValorCIF')?.value || 0)
    const advalorem = parseFloat(document.getElementById('newDAMAdValorem')?.value || 0)
    const impUSD = ((valorCIF + advalorem) * 0.02 || 0).toFixed(2) // Ejemplo: 2% de IMP en USD
    const igvUSD = ((valorCIF + advalorem) * 0.16 || 0).toFixed(2) // Ejemplo: 16% de IGV en USD
    document.getElementById('newDAMImpUSD').value = parseFloat(impUSD).toFixed(2) || 0
    document.getElementById('newDAMIGVUSD').value = parseFloat(igvUSD).toFixed(2) || 0
    document.getElementById('newDAMTotalLiquidacion').value = parseFloat(advalorem) + parseFloat(impUSD) + parseFloat(igvUSD)
  } catch (error) {
    console.error('Error en calculoAutomaticoLiquidacionTotalNewDAM:', error)
    showToast('Error al calcular impuestos', 'danger')
  }
}

window.actualizarCabecera = async function () {
  try {
    if (!window.costeoActual) {
      showToast('Carga una importación primero', 'warning')
      return
    }
 
    const datosActualizados = {
      contact_id: parseInt(document.getElementById('cabProveedor')?.value || 0) || null,
      invoice_number: document.getElementById('cabInvoice')?.value || '',
      proforma_number: document.getElementById('cabProforma')?.value || '',
      product: document.getElementById('cabProducto')?.value || '',
      fecha: document.getElementById('cabFecha')?.value || null,
      status: document.getElementById('cabEstado')?.value || 'borrador',
      costo_seguro: parseFloat(document.getElementById('cabCostoSeguro')?.value || 0),
      costo_flete: parseFloat(document.getElementById('cabCostoFlete')?.value || 0),
      puerto_embarque: document.getElementById('cabPuertoEmbarque')?.value || '',
      pais_origen: document.getElementById('cabPaisOrigen')?.value || '',
      pagado: document.getElementById('cabPagado')?.value || '',
      // NUEVO: Campos actualizados
      terminos_delivery: document.getElementById('cabTerminosDelivery')?.value || 'FOB',
      terminos_payment: document.getElementById('cabTerminosPayment')?.value || ''
    }
 
    const resultado = await updateComercialInvoice(window.costeoActual.id, datosActualizados)
    if (!resultado) {
      showToast('Error al actualizar cabecera', 'danger')
      return
    }
 
    window.costeoActual = resultado
    showToast('Cabecera actualizada '+datosActualizados.contact_id, 'success')
  } catch (error) {
    console.error('Error en actualizarCabecera:', error)
    showToast('Error al actualizar cabecera', 'danger')
  }
}
*/
// ============================================================================
// BILL OF LADING
// ============================================================================

async function renderBillOfLadings() {
  try {
    if (!window.costeoActual || !window.costeoActual.id) {
    console.warn("No hay una importación seleccionada.");
    return; 
    }
    const bill = document.getElementById('tabla-billoflading')
    if (!bill) return

    // Obtener TODOS los bill of ladings y filtrar por importación actual
    const allBLs = await getBillOfLadings()
    const billoflading = allBLs.filter(bl => bl.importacion_id === window.costeoActual.id) || []

    if (billoflading.length === 0) {
      bill.innerHTML = '<tr><td colspan="5" style="text-align: center; padding: 20px;">Sin Bill of Ladings</td></tr>'
      return
    }

    let html = `
      <table>
        <thead>
          <tr>
            <th>ID</th>
            <th>Número de BL</th>
            <th>Número de Contenedor</th>
            <th>Número de Precinto</th>
            <th>Fecha</th>
            <th>Estado</th>
            <th>Acciones</th>
          </tr>
        </thead>
        <tbody>
    `

    billoflading.forEach(bl => {
      html += `
        <tr>
          <td><strong>${bl.id || '-'}</strong></td>
          <td><strong>${bl.nro_bill_lading || '-'}</strong></td>
          <td>${bl.contenedor_number || '-'}</td>
          <td>${bl.numero_precinto || '-'}</td>
          <td>${bl.fecha || '-'}</td>
          <td>${bl.estado || '-'}</td>
          <td>
            <button class="btn btn-small btn-secondary" onclick="window.editarBL('${bl.id}')">Editar</button>
            <button class="btn btn-small btn-danger" onclick="window.eliminarBL('${bl.id}')">Eliminar</button>
          </td>
        </tr>
      `
    })
    
    html += '</tbody></table>'
    bill.innerHTML = html
  } catch (error) {
    console.error('Error en renderBillOfLadings:', error)
    showToast('Error al cargar Bill of Lading', 'danger')
  }
}

window.crearBillOfLading = async function () {
  try {
    // Obtener ID de importación del selector en el modal
    const importacionId = document.getElementById('newBLImportacionSelector')?.value || null
    if (!importacionId) {
      showToast('Selecciona una importación', 'warning')
      return
    }

    const numeroBL = document.getElementById('newBL')?.value || ''
    const numeroContenedorBL = document.getElementById('newContenedorBL')?.value || ''
    const fechaBL = document.getElementById('newFechaBL')?.value || null
    const estadoBL = document.getElementById('newEstadoBL')?.value || 'pendiente'

    if (!numeroBL || !numeroContenedorBL) {
      showToast('Ingresa el número de BL y contenedor', 'warning')
      return
    }

    const newBL = {
      importacion_id: parseInt(importacionId),
      nro_bill_lading: numeroBL,
      contenedor_number: numeroContenedorBL,
      fecha: fechaBL,
      estado: estadoBL
    }

    const resultado = await addBillOfLading(newBL)
    if (!resultado) {
      showToast('Error al guardar Bill of Lading', 'danger')
      return
    }

    showToast('Bill of Lading creado', 'success')
    window.closeModal('modal-nuevo-BL')
    
    // Si el BL creado es de la importación actual, actualizar la vista
    if (parseInt(importacionId) === window.costeoActual?.id) {
      await renderBillOfLadings()
    }
    
    document.getElementById('formNewBL').reset()
  } catch (error) {
    console.error('Error en crearBillOfLading:', error)
    showToast('Error al crear Bill of Lading', 'danger')
  }
}

window.eliminarBL = async function (blId) {
  try {
    if (!confirm('¿Eliminar este Bill of Lading?')) return

    const resultado = await deleteBillOfLading(blId)
    if (!resultado) {
      showToast('Error al eliminar Bill of Lading', 'danger')
      return
    }

    showToast('Bill of Lading eliminado', 'success')
    await renderBillOfLadings()
  } catch (error) {
    console.error('Error en eliminarBL:', error)
    showToast('Error al eliminar Bill of Lading', 'danger')
  }
}

async function cargarContenedoresEnSelect(selectId) {
  try {
    const select = document.getElementById(selectId)
    if (!select) return
 
    // ✅ OBTENER DESDE SUPABASE, NO DESDE costeoActual.contenedores
    const allContenedores = await getBillOfLadings()
    
    // Filtrar por importación actual SI existe
    const contenedores = window.costeoActual 
      ? allContenedores.filter(c => c.importacion_id === window.costeoActual.id)
      : []
 
    select.innerHTML = '<option value="">-- Selecciona Contenedor --</option>'
    contenedores.forEach(c => {
      select.innerHTML += `<option value="${c.id}">${c.contenedor_number}</option>`
    })
  } catch (error) {
    console.error('Error en cargarContenedoresEnSelect:', error)
  }
}

window.editarBL = async function (blId) {
  const el = document.getElementById('id-' + blId);
  console.log('Elemento encontrado:', el)
  try {
    const bl = await getBillOfLadingById(blId)
    if (!bl) {
      showToast('Bill of Lading no encontrado', 'danger')
      return
    }

    window.blActual = bl

    document.getElementById('editBLNumero').value = bl.nro_bill_lading || null
    document.getElementById('editBLContenedor').value = bl.contenedor_number || ''
    document.getElementById('editBLPrecinto').value = bl.numero_precinto || ''
    document.getElementById('editBLFecha').value = bl.fecha || ''
    document.getElementById('editBLEstado').value = bl.estado || 'pendiente'

    window.openModal('modal-editar-BL')
  } catch (error) {
    console.error('Error en editarBL:', error)
    showToast('Error al abrir formulario de edición', 'danger')
  }
}

window.guardarCambiosBL = async function () {
  try {
    if (!window.blActual || !window.blActual.id) {
      showToast('No hay Bill of Lading seleccionado para editar', 'danger')
      return
    }

    const numeroBL = document.getElementById('editBLNumero')?.value || ''
    const numeroContenedorBL = document.getElementById('editBLContenedor')?.value || ''
    const fechaBL = document.getElementById('editBLFecha')?.value || null

    if (!numeroBL || !numeroContenedorBL) {
      showToast('Completa los campos requeridos', 'warning')
      return
    }

    const datosActualizados = {
      nro_bill_lading: numeroBL,
      contenedor_number: numeroContenedorBL,
      fecha: fechaBL,
      estado: document.getElementById('editBLEstado')?.value || 'pendiente'
    }

    const resultado = await updateBillOfLading(window.blActual.id, datosActualizados)
    if (!resultado) {
      showToast('Error al guardar cambios en la base de datos', 'danger')
      return
    }

    showToast('Bill of Lading actualizado exitosamente', 'success')
    window.closeModal('modal-editar-BL')
    
    if (window.costeoActual && window.costeoActual.id === window.blActual.importacion_id) {
      await renderBillOfLadings()
    }

    window.blActual = null
  } catch (error) {
    console.error('Error en guardarCambiosBL:', error)
    showToast('Error al actualizar Bill of Lading', 'danger')
  }
}

window.cancelarEditarBL = function () {
  window.closeModal('modal-editar-BL')
  document.getElementById('formEditBL').reset()
  window.blActual = null
}
// ============================================================================
// DAM (Declaración Aduanal de Mercancías)
// ============================================================================

async function renderDAM() {
  try {
    if (!window.costeoActual || !window.costeoActual.id) {
      console.warn("No hay una importación seleccionada.")
      return
    }
 
    const tabla = document.getElementById('tabla-dam')
    if (!tabla) return
 
    const dams = await getDAMByImportacionId(window.costeoActual.id)
 
    if (!dams || dams.length === 0) {
      tabla.innerHTML = '<p style="text-align: center; color: var(--text-secondary); padding: 20px;">Sin registros</p>'
      return
    }
 
    let html = `
      <table>
        <thead>
          <tr>
            <th>Número DAM</th>
            <th>Fecha</th>
            <th>AdValorem USD</th>
            <th>IMP USD</th>
            <th>IGV USD</th>
            <th>Total Liquidación</th>
            <th>Percepcion</th>
            <th>Estado</th>
            <th>Acciones</th>
          </tr>
        </thead>
        <tbody>
    `
 
    dams.forEach(dam => {
      html += `
        <tr>
          <td><strong>${dam.numero_dam || '-'}</strong></td>
          <td>${dam.fecha_dam || '-'}</td>
          <td>$${(dam.ad_valorem_usd || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
          <td>$${(dam.imp_usd || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
          <td>$${(dam.igv_usd || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
          <td>$${(dam.total_liquidacion || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
          <td>S/ ${(dam.percepcion || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
          <td><span class="badge ${dam.estado === 'pagado' ? 'badge-success' : 'badge-warning'}">${dam.estado}</span></td>
          <td>
            <button class="btn btn-small btn-secondary" onclick="window.editarDAM('${dam.id}')">Editar</button>
            <button class="btn btn-small btn-danger" onclick="window.eliminarDAM('${dam.id}')">Eliminar</button>
            <button class="btn btn-small btn-primary" onclick="window.liquidarDAM('${dam.id}')">Generar Asiento</button>
          </td>
        </tr>
      `
    })

    html += '</tbody></table>'
    tabla.innerHTML = html
  } catch (error) {
    console.error('Error en renderDAM:', error)
    showToast('Error al cargar DAM', 'danger')
  }
}
 
window.crearDAM = async function () {
  try {
    const importacionId = document.getElementById('newDAMImportacionSelector')?.value || null
    if (!importacionId) {
      showToast('Selecciona una importación', 'warning')
      return
    }
 
    const numeroDam = document.getElementById('newDAMNumero')?.value || ''
    const fechaDam = document.getElementById('newDAMFecha')?.value || null
 
    if (!numeroDam || !fechaDam) {
      showToast('Completa los campos requeridos', 'warning')
      return
    }
 
    // NUEVOS CAMPOS DEL MODAL
    const valorCIF = parseFloat(document.getElementById('newDAMValorCIF')?.value || 0)
    const fleteMaritimo = parseFloat(document.getElementById('newDAMFleteMaritimo')?.value || 0)
    const seguroMaritimo = parseFloat(document.getElementById('newDAMSeguroMaritimo')?.value || 0)
    const valorFOB = parseFloat(document.getElementById('newDAMValorFOB')?.value || 0)
    const adValoremUSD = parseFloat(document.getElementById('newDAMAdValorem')?.value || 0)
    const impUSD = parseFloat(document.getElementById('newDAMImpUSD')?.value || 0)
    const igvUSD = parseFloat(document.getElementById('newDAMIGVUSD')?.value || 0)
    const totalLiquidacion = parseFloat(document.getElementById('newDAMTotalLiquidacion')?.value || 0)
    const percepcion = parseFloat(document.getElementById('newDAMPercepcion')?.value || 0)
    const tipoCambio = parseFloat(document.getElementById('newDAMTipoCambio')?.value || 3.45)
    const estado = document.getElementById('newDAMEstado')?.value || 'pendiente'
 
    const newDAM = {
      importacion_id: parseInt(importacionId),
      numero_dam: numeroDam,
      fecha_dam: fechaDam,
      valor_cif: valorCIF,
      flete_maritimo: fleteMaritimo,
      seguro_maritimo: seguroMaritimo,
      valor_fob: valorFOB,
      ad_valorem_usd: adValoremUSD,
      imp_usd: impUSD,
      igv_usd: igvUSD,
      total_liquidacion: totalLiquidacion,
      percepcion: percepcion,
      tipo_cambio: tipoCambio,
      estado: estado
    }
 
    const resultado = await addDAM(newDAM)
    if (!resultado) {
      showToast('Error al guardar DAM', 'danger')
      return
    }
 
    showToast('DAM creada exitosamente', 'success')
    window.closeModal('modal-nuevo-dam')
    
    if (parseInt(importacionId) === window.costeoActual?.id) {
      await renderDAM()
    }
    
    document.getElementById('formNewDAM').reset()
  } catch (error) {
    console.error('Error en crearDAM:', error)
    showToast('Error al crear DAM', 'danger')
  }
}

window.editarDAM = async function (damId) {
  try {
    if (!damId) {
      showToast('ID de DAM no válido', 'danger')
      return
    }
 
    const dam = await getDAMById(damId)
    if (!dam) {
      showToast('DAM no encontrada', 'danger')
      return
    }
 
    // Guardar el ID del DAM siendo editado
    window.damActual = dam
 
    // Llenar formulario de edición
    document.getElementById('editDAMNumero').value = dam.numero_dam || ''
    document.getElementById('editDAMFecha').value = dam.fecha_dam || ''
    document.getElementById('editDAMValorCIF').value = (dam.valor_cif || 0).toFixed(2)
    document.getElementById('editDAMFleteMaritimo').value = (dam.flete_maritimo || 0).toFixed(2)
    document.getElementById('editDAMSeguroMaritimo').value = (dam.seguro_maritimo || 0).toFixed(2)
    document.getElementById('editDAMValorFOB').value = (dam.valor_fob || 0).toFixed(2)
    document.getElementById('editDAMAdValorem').value = (dam.ad_valorem_usd || 0).toFixed(2)
    document.getElementById('editDAMImpUSD').value = (dam.imp_usd || 0).toFixed(2)
    document.getElementById('editDAMIGVUSD').value = (dam.igv_usd || 0).toFixed(2)
    document.getElementById('editDAMTotalLiquidacion').value = (dam.total_liquidacion || 0).toFixed(2)
    document.getElementById('editDAMPercepcion').value = (dam.percepcion || 0).toFixed(2)
    document.getElementById('editDAMTipoCambio').value = (dam.tipo_cambio || 3.45).toFixed(3)
    document.getElementById('editDAMEstado').value = dam.estado || 'pendiente'
 
    // Abrir modal
    window.openModal('modal-editar-dam')
  } catch (error) {
    console.error('Error en editarDAM:', error)
    showToast('Error al abrir formulario de edición', 'danger')
  }
}

window.eliminarDAM = async function (damId) {
  try {
    if (!confirm('¿Eliminar esta DAM?')) return

    const resultado = await deleteDAM(damId)
    if (!resultado) {
      showToast('Error al eliminar DAM', 'danger')
      return
    }

    showToast('DAM eliminada', 'success')
    await renderDAM()
  } catch (error) {
    console.error('Error en eliminarDAM:', error)
    showToast('Error al eliminar DAM', 'danger')
  }
}

window.guardarCambiosDAM = async function () {
  try {
    if (!window.damActual || !window.damActual.id) {
      showToast('No hay DAM seleccionada para editar', 'danger')
      return
    }
 
    const numeroDam = document.getElementById('editDAMNumero')?.value || ''
    const fechaDam = document.getElementById('editDAMFecha')?.value || null
 
    if (!numeroDam || !fechaDam) {
      showToast('Completa los campos requeridos', 'warning')
      return
    }
 
    const datosActualizados = {
      numero_dam: numeroDam,
      fecha_dam: fechaDam,
      valor_cif: parseFloat(document.getElementById('editDAMValorCIF')?.value || 0),
      flete_maritimo: parseFloat(document.getElementById('editDAMFleteMaritimo')?.value || 0),
      seguro_maritimo: parseFloat(document.getElementById('editDAMSeguroMaritimo')?.value || 0),
      valor_fob: parseFloat(document.getElementById('editDAMValorFOB')?.value || 0),
      ad_valorem_usd: parseFloat(document.getElementById('editDAMAdValorem')?.value || 0),
      imp_usd: parseFloat(document.getElementById('editDAMImpUSD')?.value || 0),
      igv_usd: parseFloat(document.getElementById('editDAMIGVUSD')?.value || 0),
      total_liquidacion: parseFloat(document.getElementById('editDAMTotalLiquidacion')?.value || 0),
      percepcion: parseFloat(document.getElementById('editDAMPercepcion')?.value || 0),
      tipo_cambio: parseFloat(document.getElementById('editDAMTipoCambio')?.value || 3.45),
      estado: document.getElementById('editDAMEstado')?.value || 'pendiente'
    }
 
    const resultado = await updateDAM(window.damActual.id, datosActualizados)
    if (!resultado) {
      showToast('Error al guardar cambios en la base de datos', 'danger')
      return
    }
 
    showToast('DAM actualizada exitosamente', 'success')
    window.closeModal('modal-editar-dam')
    
    // Recargar tabla si es la misma importación
    if (window.costeoActual && window.costeoActual.id === window.damActual.importacion_id) {
      await renderDAM()
    }
 
    window.damActual = null
  } catch (error) {
    console.error('Error en guardarCambiosDAM:', error)
    showToast('Error al actualizar DAM', 'danger')
  }
}
 
window.cancelarEditarDAM = function () {
  window.closeModal('modal-editar-dam')
  document.getElementById('formEditDAM').reset()
  window.damActual = null
}

window.cargarDatosInvoiceNewDam = async function () {
  try {
    const invoiceId = document.getElementById('newDAMImportacionSelector')?.value || null
    if (!invoiceId) {
      showToast('Selecciona una importación', 'warning')
      return
    }
    const invoice = await getComercialInvoiceById(invoiceId)
    if (!invoice) {
      showToast('Importación no encontrada', 'danger')
      return
    }

    document.getElementById('newDAMSeguroMaritimo').value = (invoice.costo_seguro || 0).toFixed(2)
    document.getElementById('newDAMFleteMaritimo').value = (invoice.costo_flete || 0).toFixed(2)
    document.getElementById('newDAMValorCIF').value = (invoice.valor_total_final_ci || 0).toFixed(2)
    document.getElementById('newDAMValorFOB').value = (invoice.valor_total_final_fob || 0).toFixed(2)
   
    await window.calculoAutomaticoImpuestosNewDAM()

  } catch (error) {
    console.error('Error en cargarDatosInvoiceNewDam:', error)
    showToast('Error al cargar datos de la importación', 'danger')
  }
}

window.calculoAutomaticoImpuestosNewDAM = async function () {
  try {
    const seguro = parseFloat(document.getElementById('newDAMSeguroMaritimo')?.value || 0)
    const flete = parseFloat(document.getElementById('newDAMFleteMaritimo')?.value || 0)
    const valorFOB = parseFloat(document.getElementById('newDAMValorFOB')?.value || 0)

    const valorCIF = parseFloat(valorFOB) + parseFloat(seguro) + parseFloat(flete)
    const advalorem = parseFloat(await (valorCIF)) * 0.06 // Ejemplo: 6% de ad valorem
    const baseImponible = parseFloat(valorCIF + advalorem)

    const impUSD = parseFloat(baseImponible * 0.025) // Ejemplo: 2% de IMP en USD
    const igvUSD = parseFloat(baseImponible * 0.155) // Ejemplo: 16% de IGV en USD
    const totalLiquidacion = parseFloat(advalorem) + parseFloat(impUSD) + parseFloat(igvUSD)
    const tipocambio = parseFloat(document.getElementById('newDAMTipoCambio')?.value || 0) // Ejemplo: tipo de cambio fijo para el cálculo
    const percepcion = parseFloat((valorCIF + advalorem + impUSD + igvUSD)*0.035*tipocambio)

    document.getElementById('newDAMValorCIF').value = valorCIF.toFixed(2)
    document.getElementById('newDAMAdValorem').value = advalorem.toFixed(0)
    document.getElementById('newDAMImpUSD').value = impUSD.toFixed(0)
    document.getElementById('newDAMIGVUSD').value = igvUSD.toFixed(0)
    document.getElementById('newDAMTotalLiquidacion').value = totalLiquidacion.toFixed(0)
    document.getElementById('newDAMPercepcion').value = percepcion.toFixed(2)
    showToast('Impuestos calculados', 'success')

  } catch (error) {
    console.error('Error en calculoAutomaticoImpuestosNewDAM:', error)
    showToast('Error al calcular impuestos', 'danger')
  }
}

// ============================================================================
// GUÍA DE REMISIÓN
// ============================================================================

async function renderGuiaRemision() {
  try {
    if (!window.costeoActual || !window.costeoActual.id) {
      console.warn("No hay una importación seleccionada.")
      return
    }

    const tabla = document.getElementById('tabla-guia-remision')
    if (!tabla) return

    const guias = await getGuiaRemisionByImportacionId(window.costeoActual.id)
    const proveedores = await getSuppliers() // Para mostrar nombre de proveedor en la tabla

    if (!guias || guias.length === 0) {
      tabla.innerHTML = '<p style="text-align: center; color: var(--text-secondary); padding: 20px;">Sin registros</p>'
      return
    }
     // Crear mapa de proveedores para búsqueda O(1)
    const proveedoresMap = {}
    if (proveedores && proveedores.length > 0) {
      proveedores.forEach(p => {
        proveedoresMap[p.id] = p.nombre || 'Sin nombre'
      })
    }

    let html = `
      <table>
        <thead>
          <tr>
            <th>Número Guía</th>
            <th>Proveedor</th>
            <th>Fecha</th>
            <th>Peso Bruto (Kg)</th>
            <th>Destino</th>
            <th>DAM Relacionado</th>
            <th>Estado</th>
            <th>Acciones</th>
          </tr>
        </thead>
        <tbody>
    `

    guias.forEach(guia => {
      const nombreProveedor = proveedoresMap[guia.proveedor_id] || proveedoresMap[guia.proveedor] || '-'
      html += `
        <tr>
          <td><strong>${guia.numero_guia || '-'}</strong></td>
          <td>${nombreProveedor}</td>
          <td>${guia.fecha_guia || '-'}</td>
          <td>${(guia.peso_bruto || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
          <td>${guia.lugar_destino || '-'}</td>
          <td>${guia.dam_relacionado || '-'}</td>
          <td><span class="badge badge-info">${guia.estado}</span></td>
          <td>
            <button class="btn btn-small btn-secondary" onclick="window.editarGuia('${guia.id}')">Editar</button>
            <button class="btn btn-small btn-danger" onclick="window.eliminarGuia('${guia.id}')">Eliminar</button>
          </td>
        </tr>
      `
    })

    html += '</tbody></table>'
    tabla.innerHTML = html
  } catch (error) {
    console.error('Error en renderGuiaRemision:', error)
    showToast('Error al cargar guías', 'danger')
  }
}

window.crearGuiaRemision = async function () {
  try {
    const importacionId = document.getElementById('newGuiaImportacionSelector')?.value || null
    const proveedor = document.getElementById('newGuiaProveedorSelector')?.value || ''

    if (!importacionId || !proveedor) {
      showToast('Selecciona una importación y un proveedor', 'warning')
      return
    }

    const numeroGuia = document.getElementById('newGuiaNumero')?.value || ''
    const fechaGuia = document.getElementById('newGuiaFecha')?.value || null
    const pesoBruto = parseFloat(document.getElementById('newGuiaPesoBruto')?.value || 0)
    const lugarDestino = document.getElementById('newGuiaDestino')?.value || ''
    const damRelacionado = document.getElementById('newGuiaDAMs')?.value || ''
    const estado = document.getElementById('newGuiaEstado')?.value || 'en_transito'
    const monto = parseFloat(document.getElementById('newGuiaMonto')?.value || 0)

    if (!numeroGuia || !fechaGuia) {
      showToast('Completa los campos requeridos', 'warning')
      return
    }

    const newGuia = {
      importacion_id: parseInt(importacionId),
      proveedor: parseInt(proveedor),
      numero_guia: numeroGuia,
      fecha_guia: fechaGuia,
      peso_bruto: pesoBruto,
      lugar_destino: lugarDestino,
      dam_relacionado: damRelacionado,
      estado: estado
    }

    const resultado = await addGuiaRemision(newGuia)
    if (!resultado) {
      showToast('Error al guardar guía', 'danger')
      return
    }

    // Si se indicó un valor de mercadería, generar también el asiento
    // contable "Valuación de inventario" (journal_entries + journal_entry_lines)
    // vinculado a esta guía mediante documento_referencia = numero_guia.
    if (monto > 0) {
      try {
        const user = await getCurrentUser()
        await generarAsientoGuiaRemision({
          monto,
          documento_referencia: numeroGuia,
          descripcion: `Guía de Remisión - Ingreso a almacén (${numeroGuia})`,
          contact_id: parseInt(proveedor),
          fecha: fechaGuia,
          userId: user?.id
        })
        showToast('Guía de remisión creada y asiento de valuación de inventario generado', 'success')
      } catch (errorAsiento) {
        console.error('Error generando asiento de guía de remisión:', errorAsiento)
        showToast(errorAsiento.message || 'Guía creada, pero no se pudo generar el asiento contable', 'warning')
      }
    } else {
      showToast('Guía de remisión creada', 'success')
    }

    window.closeModal('modal-nueva-guia')

    if (parseInt(importacionId) === window.costeoActual?.id) {
      await renderGuiaRemision()
    }

    document.getElementById('formNewGuia').reset()
  } catch (error) {
    console.error('Error en crearGuiaRemision:', error)
    showToast('Error al crear guía', 'danger')
  }
}

window.editarGuia = async function (guiaId) {
  showToast('Función de edición en desarrollo', 'info')
}

window.eliminarGuia = async function (guiaId) {
  try {
    if (!confirm('¿Eliminar esta guía? Si tiene un asiento de valuación de inventario asociado, también se eliminará.')) return

    const guia = await getGuiaRemisionById(guiaId)

    const resultado = await deleteGuiaRemision(guiaId)
    if (!resultado) {
      showToast('Error al eliminar guía', 'danger')
      return
    }

    // Eliminar también el asiento "Valuación de inventario" vinculado (si existe)
    if (guia?.numero_guia) {
      const asiento = await getJournalEntryByReferencia('Guía Remisión', guia.numero_guia)
      if (asiento) {
        await eliminarAsientoContable(asiento.id)
      }
    }

    showToast('Guía eliminada', 'success')
    await renderGuiaRemision()
  } catch (error) {
    console.error('Error en eliminarGuia:', error)
    showToast('Error al eliminar guía', 'danger')
  }
}

window.cargarDatosBLenGuia = async function () {
  try {
    const importacionId = document.getElementById('newGuiaImportacionSelector')?.value || null
    if (!importacionId) {
      document.getElementById('newGuiaNroContenedor').value = ''
      document.getElementById('newGuiaPrecinto').value = ''
      document.getElementById('newGuiaPesoBruto').value = ''
      return
    }
    const allDAMs = await getDAMs()
    const allBLs = await getBillOfLadings()
    const damRelacionado = allDAMs.find(d => d.importacion_id === parseInt(importacionId))
    const bl = allBLs.find(b => b.importacion_id === parseInt(importacionId))

    if (!bl) {
      document.getElementById('newGuiaNroContenedor').value = ''
      document.getElementById('newGuiaPrecinto').value = ''
      document.getElementById('newGuiaPesoBruto').value = ''
      return
    }

    document.getElementById('newGuiaNroContenedor').value = bl.contenedor_number || ''
    document.getElementById('newGuiaPrecinto').value = bl.numero_precinto || ''
    document.getElementById('newGuiaPesoBruto').value = (bl.peso_bruto || 0).toFixed(2)
    document.getElementById('newGuiaDAMs').value = damRelacionado ? `${damRelacionado.numero_dam}` : ''
  } catch (error) {
    console.error('Error en cargarDatosBLenGuia:', error)
  }
}
// ============================================================================
// GASTOS LOCALES
// ============================================================================
/*
async function renderGastosLocales() {
  try {
    if (!window.costeoActual || !window.costeoActual.id) {
      console.warn("No hay una importación seleccionada.")
      return
    }

    const tabla = document.getElementById('tabla-gastos-locales')
    if (!tabla) return

    const gastos = await getGastoLocalByImportacionId(window.costeoActual.id)

    if (!gastos || gastos.length === 0) {
      tabla.innerHTML = '<p style="text-align: center; color: var(--text-secondary); padding: 20px;">Sin registros</p>'
      return
    }

    let html = `
      <table>
        <thead>
          <tr>
            <th>Concepto</th>
            <th>Tipo</th>
            <th>Monto USD</th>
            <th>Monto S/</th>
            <th>IGV %</th>
            <th>Estado</th>
            <th>Acciones</th>
          </tr>
        </thead>
        <tbody>
    `

    gastos.forEach(gasto => {
      html += `
        <tr>
          <td><strong>${gasto.concepto || '-'}</strong></td>
          <td>${gasto.tipo_gasto || '-'}</td>
          <td>$${(gasto.monto_usd || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
          <td>S/ ${(gasto.monto_sol || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
          <td>${(gasto.igv || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%</td>
          <td><span class="badge ${gasto.estado === 'pagado' ? 'badge-success' : 'badge-warning'}">${gasto.estado}</span></td>
          <td>
            <button class="btn btn-small btn-secondary" onclick="window.editarGastoLocal('${gasto.id}')">Editar</button>
            <button class="btn btn-small btn-danger" onclick="window.eliminarGastoLocal('${gasto.id}')">Eliminar</button>
          </td>
        </tr>
      `
    })

    html += '</tbody></table>'
    tabla.innerHTML = html
  } catch (error) {
    console.error('Error en renderGastosLocales:', error)
    showToast('Error al cargar gastos', 'danger')
  }
}*/

window.crearGastoLocal = async function () {
  try {
    const importacionId = document.getElementById('newGastoLocalImportacionSelector')?.value || null
    if (!importacionId) {
      showToast('Selecciona una importación', 'warning')
      return
    }

    const provId = document.getElementById('newGastoLocalProveedorSelector')?.value || null
    const proveedor = await getSupplierById(provId)
    if (!proveedor) {
      showToast('No se encontró el proveedor', 'warning')
      return
    }
    
    const fecha = document.getElementById('newGastoLocalFecha')?.value || null
    const prov = proveedor.nombre || 'Proveedor desconocido'
    const tipoGasto = document.getElementById('newGastoLocalTipo')?.value || ''
    const montoUSD = parseFloat(document.getElementById('newGastoLocalMontUSD')?.value || 0)
    const tc = parseFloat(document.getElementById('newGastoLocalTC')?.value || 3.37)
    const montoSol = parseFloat(document.getElementById('newGastoLocalMontoSol')?.value || 0)
    const documento = document.getElementById('newGastoLocalDocumento')?.value || ''
    const acreedor = document.getElementById('newGastoLocalAcreedor')?.value || ''
    const igv = parseFloat(document.getElementById('newGastoLocalIGV')?.value || 0)
    const estado = document.getElementById('newGastoLocalEstado')?.value || 'pendiente'

    if (!concepto || !tipoGasto || !montoUSD) {
      showToast('Completa los campos requeridos', 'warning')
      return
    }

    const newGasto = {
      importacion_id: parseInt(importacionId),
      concepto: concepto,
      tipo_gasto: tipoGasto,
      monto_usd: montoUSD,
      monto_sol: montoSol,
      tipo_cambio: tc,
      numero_documento: documento,
      fecha: fecha,
      acreedor: acreedor,
      igv: igv,
      estado: estado
    }

    const resultado = await addGastoLocal(newGasto)
    if (!resultado) {
      showToast('Error al guardar gasto', 'danger')
      return
    }

    showToast('Gasto local creado', 'success')
    window.closeModal('modal-nuevo-gasto-local')
    
    if (parseInt(importacionId) === window.costeoActual?.id) {
      await renderGastosLocales()
    }
    
    document.getElementById('formNewGastoLocal').reset()
  } catch (error) {
    console.error('Error en crearGastoLocal:', error)
    showToast('Error al crear gasto', 'danger')
  }
}
/*
window.editarGastoLocal = async function (gastoId) {
  showToast('Función de edición en desarrollo', 'info')
}
*/
window.eliminarGastoLocal = async function (gastoId) {
  try {
    if (!confirm('¿Eliminar este gasto?')) return

    const resultado = await deleteGastoLocal(gastoId)
    if (!resultado) {
      showToast('Error al eliminar gasto', 'danger')
      return
    }

    showToast('Gasto eliminado', 'success')
    await renderGastosLocales()
  } catch (error) {
    console.error('Error en eliminarGastoLocal:', error)
    showToast('Error al eliminar gasto', 'danger')
  }
}

// ============================================================================
// FUNCIONES PARA GASTOS LOCALES
// ============================================================================
 
window.calcularSubtotalGastoLocal = function () {
  try {
    const cantidad = parseFloat(document.getElementById('newGastoLocalCantidad')?.value || 0)
    const precioUnitario = parseFloat(document.getElementById('newGastoLocalPrecioUnitario')?.value || 0)
    
    const subtotal = cantidad * precioUnitario
    document.getElementById('newGastoLocalSubtotal').value = subtotal.toFixed(2)
    
    // Calcular total con IGV
    calcularTotalGastoLocal()
  } catch (error) {
    console.error('Error en calcularSubtotalGastoLocal:', error)
  }
}
 
window.calcularTotalGastoLocal = function () {
  try {
    const subtotal = parseFloat(document.getElementById('newGastoLocalSubtotal')?.value || 0)
    const igvPorcentaje = parseFloat(document.getElementById('newGastoLocalIGV')?.value || 0)
    
    const igv = subtotal * (igvPorcentaje / 100)
    const total = subtotal + igv
    
    document.getElementById('newGastoLocalTotal').value = total.toFixed(2)
  } catch (error) {
    console.error('Error en calcularTotalGastoLocal:', error)
  }
}
 
window.crearGastoLocal = async function () {
  try {
    const importacionId = document.getElementById('newGastoLocalImportacionSelector')?.value || null
    const contactId = document.getElementById('newGastoLocalContactId')?.value || null
    const numero = document.getElementById('newGastoLocalNumero')?.value || ''
    const cantidad = parseFloat(document.getElementById('newGastoLocalCantidad')?.value || 0)
    const precioUnitario = parseFloat(document.getElementById('newGastoLocalPrecioUnitario')?.value || 0)
    const igv = parseFloat(document.getElementById('newGastoLocalIGV')?.value || 0)
    const currency = document.getElementById('newGastoLocalCurrency')?.value || 'USD'
    const status = document.getElementById('newGastoLocalStatus')?.value || 'pendiente'
 
    if (!contactId) {
      showToast('Selecciona un proveedor', 'warning')
      return
    }
 
    if (!numero) {
      showToast('Ingresa el número de documento', 'warning')
      return
    }
 
    if (cantidad <= 0 || precioUnitario <= 0) {
      showToast('Cantidad y precio deben ser mayores a 0', 'warning')
      return
    }
 
    // Calcular valores
    const subtotal = cantidad * precioUnitario
    const igvMonto = subtotal * (igv / 100)
    const total = subtotal + igvMonto
 
    const newGastoLocal = {
      numero: numero,
      lote_id: importacionId ? parseInt(importacionId) : null,
      contact_id: parseInt(contactId),
      cantidad: cantidad,
      precio_unitario: precioUnitario,
      subtotal: subtotal,
      igv: igvMonto,
      total: total,
      currency: currency,
      status: status
    }
 
    const resultado = await addLocalExpense(newGastoLocal)
    if (!resultado) {
      showToast('Error al guardar gasto local', 'danger')
      return
    }
 
    showToast('Gasto local creado exitosamente', 'success')
    window.closeModal('modal-nuevo-gasto-local')
    
    if (importacionId && parseInt(importacionId) === window.costeoActual?.id) {
      await renderGastosLocales()
    }
    
    document.getElementById('formNewGastoLocal').reset()
  } catch (error) {
    console.error('Error en crearGastoLocal:', error)
    showToast('Error al crear gasto local', 'danger')
  }
}
 
async function renderGastosLocales() {
  try {
    if (!window.costeoActual || !window.costeoActual.id) {
      console.warn("No hay una importación seleccionada.")
      return
    }
 
    const tabla = document.getElementById('tabla-gastos-locales')
    if (!tabla) return
 
    const gastosLocales = await getGastoLocalByImportacionId(window.costeoActual.id)
    const contacts = await getContacts()
 
    if (!gastosLocales || gastosLocales.length === 0) {
      tabla.innerHTML = '<p style="text-align: center; color: var(--text-secondary); padding: 20px;">Sin registros</p>'
      return
    }
 
    // Crear mapa de contacts
    const contactsMap = {}
    if (contacts && contacts.length > 0) {
      contacts.forEach(c => {
        contactsMap[c.id] = c.nombre || 'Sin nombre'
      })
    }
 
    let html = `
      <table>
        <thead>
          <tr>
            <th>Número</th>
            <th>Proveedor</th>
            <th>Cantidad</th>
            <th>Precio Unit.</th>
            <th>Subtotal</th>
            <th>IGV</th>
            <th>Total</th>
            <th>Moneda</th>
            <th>Estado</th>
            <th>Acciones</th>
          </tr>
        </thead>
        <tbody>
    `
 
    gastosLocales.forEach(gasto => {
      const nombreProveedor = contactsMap[gasto.contact_id] || '-'
      
      html += `
        <tr>
          <td><strong>${gasto.numero || '-'}</strong></td>
          <td>${nombreProveedor}</td>
          <td>${(gasto.cantidad || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
          <td>${(gasto.precio_unitario || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
          <td>${(gasto.subtotal || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
          <td>${(gasto.igv || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
          <td><strong>${(gasto.total || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</strong></td>
          <td>${gasto.currency || '-'}</td>
          <td><span class="badge ${gasto.status === 'pagado' ? 'badge-success' : 'badge-warning'}">${gasto.status}</span></td>
          <td>
            <button class="btn btn-small btn-secondary" onclick="window.editarGastoLocal('${gasto.id}')">Editar</button>
            <button class="btn btn-small btn-danger" onclick="window.eliminarGastoLocal('${gasto.id}')">Eliminar</button>
          </td>
        </tr>
      `
    })
 
    html += '</tbody></table>'
    tabla.innerHTML = html
  } catch (error) {
    console.error('Error en renderGastosLocales:', error)
    showToast('Error al cargar gastos locales', 'danger')
  }
}
 
window.editarGastoLocal = async function (gastoId) {
  showToast('Función de edición en desarrollo', 'info')
}
 
// ============================================================================
// PAGOS
// ============================================================================

async function renderPagos() {
  try {
    if (!window.costeoActual || !window.costeoActual.id) {
      console.warn("No hay una importación seleccionada.")
      return
    }

    const tabla = document.getElementById('tabla-pagos')
    if (!tabla) return

    const pagos = await getPagoByImportacionId(window.costeoActual.id)

    if (!pagos || pagos.length === 0) {
      tabla.innerHTML = '<p style="text-align: center; color: var(--text-secondary); padding: 20px;">Sin registros</p>'
      return
    }

    let html = `
      <table>
        <thead>
          <tr>
            <th>Tipo de Pago</th>
            <th>Referencia</th>
            <th>Monto USD</th>
            <th>Monto S/</th>
            <th>Fecha</th>
            <th>Medio</th>
            <th>Acciones</th>
          </tr>
        </thead>
        <tbody>
    `

    pagos.forEach(pago => {
      html += `
        <tr>
          <td><strong>${pago.tipo_pago || '-'}</strong></td>
          <td>${pago.referencia || '-'}</td>
          <td>$${(pago.monto_usd || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
          <td>S/ ${(pago.monto_sol || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
          <td>${pago.fecha_pago || '-'}</td>
          <td>${pago.medio_pago || '-'}</td>
          <td>
            <button class="btn btn-small btn-secondary" onclick="window.editarPago('${pago.id}')">Editar</button>
            <button class="btn btn-small btn-danger" onclick="window.eliminarPago('${pago.id}')">Eliminar</button>
          </td>
        </tr>
      `
    })

    html += '</tbody></table>'
    tabla.innerHTML = html
  } catch (error) {
    console.error('Error en renderPagos:', error)
    showToast('Error al cargar pagos', 'danger')
  }
}

window.crearPago = async function () {
  try {
    const importacionId = document.getElementById('newPagoImportacionSelector')?.value || null
    if (!importacionId) {
      showToast('Selecciona una importación', 'warning')
      return
    }

    const tipoPago = document.getElementById('newPagoTipo')?.value || ''
    const referencia = document.getElementById('newPagoReferencia')?.value || ''
    const montoUSD = parseFloat(document.getElementById('newPagoMontoUSD')?.value || 0)
    const tc = parseFloat(document.getElementById('newPagoTC')?.value || 3.37)
    const montoSol = parseFloat(document.getElementById('newPagoMontoSol')?.value || 0)
    const fechaPago = document.getElementById('newPagoFecha')?.value || null
    const medioPago = document.getElementById('newPagoMedio')?.value || ''
    const comprobante = document.getElementById('newPagoComprobante')?.value || ''
    const banco = document.getElementById('newPagoBanco')?.value || ''
    const observaciones = document.getElementById('newPagoObservaciones')?.value || ''

    if (!tipoPago || !montoUSD || !fechaPago || !medioPago) {
      showToast('Completa los campos requeridos', 'warning')
      return
    }

    const newPago = {
      importacion_id: parseInt(importacionId),
      tipo_pago: tipoPago,
      referencia: referencia,
      monto_usd: montoUSD,
      monto_sol: montoSol,
      tipo_cambio: tc,
      fecha_pago: fechaPago,
      medio_pago: medioPago,
      numero_comprobante: comprobante,
      banco: banco,
      observaciones: observaciones
    }

    const resultado = await addPago(newPago)
    if (!resultado) {
      showToast('Error al guardar pago', 'danger')
      return
    }

    showToast('Pago creado', 'success')
    window.closeModal('modal-nuevo-pago')
    
    if (parseInt(importacionId) === window.costeoActual?.id) {
      await renderPagos()
    }
    
    document.getElementById('formNewPago').reset()
  } catch (error) {
    console.error('Error en crearPago:', error)
    showToast('Error al crear pago', 'danger')
  }
}

window.editarPago = async function (pagoId) {
  showToast('Función de edición en desarrollo', 'info')
}

window.eliminarPago = async function (pagoId) {
  try {
    if (!confirm('¿Eliminar este pago?')) return

    const resultado = await deletePago(pagoId)
    if (!resultado) {
      showToast('Error al eliminar pago', 'danger')
      return
    }

    showToast('Pago eliminado', 'success')
    await renderPagos()
  } catch (error) {
    console.error('Error en eliminarPago:', error)
    showToast('Error al eliminar pago', 'danger')
  }
}

// ============================================================================
// SELECT LOADERS
// ============================================================================

async function cargarProveedoresSelect() {
  try {
    const proveedores = await getSuppliers()
    const selectGuia = document.getElementById('newGuiaProveedorSelector')
    const selectGasto = document.getElementById('newGastoLocalProveedorSelector')

    if (selectGuia) {
      selectGuia.innerHTML = '<option value="">-- Selecciona Proveedor --</option>'
      proveedores.forEach(p => {
        selectGuia.innerHTML += `<option value="${p.id}">${p.nombre}</option>`
      })
    }

    if (selectGasto) {
      selectGasto.innerHTML = '<option value="">-- Selecciona Proveedor --</option>'
      proveedores.forEach(p => {
        selectGasto.innerHTML += `<option value="${p.id}">${p.nombre}</option>`
      })
    }
  } catch (error) {
    console.error('Error en cargarProveedoresSelect:', error)
  }
}

async function cargarProductosSelectCosteo() {
  try {
    const lotes = await getLotes()
    const select = document.getElementById('costeoProducto')

    if (!select) return

    select.innerHTML = '<option value="">-- Selecciona Lote --</option>'
    lotes.forEach(lote => {
      select.innerHTML += `<option value="${lote.id}">${lote.numero_lote}</option>`
    })
  } catch (error) {
    console.error('Error en cargarProductosSelectCosteo:', error)
  }
}

// Cargar productos en el select del modal de nuevo detalle
async function cargarProductosEnSelectDetalle() {
  try {
    const productos = await getItems()
    const select = document.getElementById('newDetalleProducto')
    
    if (!select) return
    
    select.innerHTML = '<option value="">-- Selecciona un producto --</option>'
    productos.forEach(prod => {
      const nombre = prod.nombre || 'Producto sin nombre'
      select.innerHTML += `<option value="${prod.id}">${nombre}</option>`
    })
  } catch (error) {
    console.error('Error al cargar productos en select:', error)
    showToast('Error al cargar productos', 'danger')
  }
}

// Cargar productos en el select del modal de editar detalle
async function cargarProductosEnSelectEditDetalle(productoActual) {
  try {
    const productos = await getItems()
    const select = document.getElementById('editDetalleProducto')
    
    if (!select) return
    
    select.innerHTML = '<option value="">-- Selecciona un producto --</option>'
    productos.forEach(prod => {
      const nombre = prod.nombre || 'Producto sin nombre'
      const id = prod.id || ''
      select.innerHTML += `<option value="${id}">${nombre}</option>`
    })
    
    // Seleccionar el producto actual
    if (productoActual) {
      select.value = productoActual
    }
  } catch (error) {
    console.error('Error al cargar productos en select de editar:', error)
    showToast('Error al cargar productos', 'danger')
  }
}

// ============================================================================
// ABRIR FORMULARIOS (Modal Helpers)
// ============================================================================

window.abrirFormularioProveedorCosteo = function() {
  window.openModal('modal-nuevo-proveedor')
}

window.abrirFormularioProductoCosteo = function() {
  // Abre el modal para crear productos y recarga el select después
  showToast('Los productos se crean desde el módulo de Inventario', 'info')
}

window.guardarProveedorDesdeCosteo = async function () {
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
      tipo_contacto: ['proveedor']  // text[] en la BD
    }

    if (!prov.nombre || !prov.nro_documento) {
      showToast('Complete los campos requeridos', 'warning')
      return
    }

    // Guardar en Supabase
    const resultado = await addContact(prov)
    if (!resultado) {
      showToast('Error al guardar el proveedor en base de datos', 'danger')
      return
    }

    showToast('Proveedor guardado exitosamente', 'success')
    window.closeModal('modal-nuevo-proveedor')
    await cargarProveedoresSelect()
    const form = document.getElementById('formNewProveedor')
    if (form) form.reset()
  } catch (error) {
    console.error('Error en guardarProveedorDesdeCosteo:', error)
    showToast('Error al guardar el proveedor: ' + error.message, 'danger')
  }
}

// ============================================================================
// DAM — CÁLCULO AUTOMÁTICO DE IMPUESTOS (formulario de edición)
// ============================================================================
// Mismo cálculo que window.calculoAutomaticoImpuestosNewDAM, aplicado a los
// campos "editDAM*" del modal de edición. Fórmulas sin cambios (Ad Valorem
// 6%, IMP 2.5%, IGV 15.5%, Percepción 3.5%) — mantenidas idénticas al
// formulario de creación para no introducir criterios tributarios nuevos.
window.calculoAutomaticoImpuestosEditDAM = async function () {
  try {
    const seguro = parseFloat(document.getElementById('editDAMSeguroMaritimo')?.value || 0)
    const flete = parseFloat(document.getElementById('editDAMFleteMaritimo')?.value || 0)
    const valorFOB = parseFloat(document.getElementById('editDAMValorFOB')?.value || 0)

    const valorCIF = parseFloat(valorFOB) + parseFloat(seguro) + parseFloat(flete)
    const advalorem = parseFloat(valorCIF) * 0.06 // 6% de ad valorem
    const baseImponible = parseFloat(valorCIF + advalorem)

    const impUSD = parseFloat(baseImponible * 0.025) // 2.5% de IMP en USD
    const igvUSD = parseFloat(baseImponible * 0.155) // 15.5% de IGV en USD
    const totalLiquidacion = parseFloat(advalorem) + parseFloat(impUSD) + parseFloat(igvUSD)
    const tipocambio = parseFloat(document.getElementById('editDAMTipoCambio')?.value || 0)
    const percepcion = parseFloat((valorCIF + advalorem + impUSD + igvUSD) * 0.035 * tipocambio)

    document.getElementById('editDAMValorCIF').value = valorCIF.toFixed(2)
    document.getElementById('editDAMAdValorem').value = advalorem.toFixed(0)
    document.getElementById('editDAMImpUSD').value = impUSD.toFixed(0)
    document.getElementById('editDAMIGVUSD').value = igvUSD.toFixed(0)
    document.getElementById('editDAMTotalLiquidacion').value = totalLiquidacion.toFixed(0)
    document.getElementById('editDAMPercepcion').value = percepcion.toFixed(2)
    showToast('Impuestos recalculados', 'success')
  } catch (error) {
    console.error('Error en calculoAutomaticoImpuestosEditDAM:', error)
    showToast('Error al calcular impuestos', 'danger')
  }
}

// ============================================================================
// GASTOS LOCALES — Toggle campo Detracción
// ============================================================================
// Nota: el onchange que dispara esta función está comentado en el HTML
// (modal-nuevo-gasto-local, checkbox "newGastoLocalAplicaDetraccion").
// Se deja implementada por si se reactiva el atributo onchange.
window.toggleCampoDetraccionGastoLocal = function () {
  const checkbox = document.getElementById('newGastoLocalAplicaDetraccion')
  const campoContenedor = document.getElementById('campoDetraccionGastoLocal')
  if (campoContenedor) {
    campoContenedor.style.display = checkbox?.checked ? '' : 'none'
  }
}

// ============================================================================
// EXPORTAR RESUMEN A PDF
// ============================================================================
// No hay librería PDF cargada en costeo-importaciones.html (sin jsPDF/
// html2pdf). Se usa impresión nativa del navegador acotada al tab "Resumen
// Final" — el usuario elige "Guardar como PDF" en el diálogo de impresión.
// Si se prefiere descarga automática sin diálogo, hay que agregar una
// librería (jsPDF o html2pdf) por CDN: decisión pendiente de confirmar.
window.exportarPDF = function () {
  try {
    const resumen = document.getElementById('tab-resumen')
    if (!resumen) { showToast('No hay resumen para exportar', 'warning'); return }

    const ventana = window.open('', '_blank')
    ventana.document.write(`
      <html>
        <head>
          <title>Resumen Costeo Importación — ${window.costeoActual?.invoice_number || ''}</title>
          <style>
            body { font-family: Arial, sans-serif; padding: 20px; }
            table { width: 100%; border-collapse: collapse; margin-bottom: 15px; }
            th, td { border: 1px solid #ccc; padding: 6px 8px; text-align: left; }
          </style>
        </head>
        <body>${resumen.innerHTML}</body>
      </html>
    `)
    ventana.document.close()
    ventana.focus()
    setTimeout(() => { ventana.print() }, 300)
  } catch (error) {
    console.error('Error en exportarPDF:', error)
    showToast('Error al exportar PDF', 'danger')
  }
}