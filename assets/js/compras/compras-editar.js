// ============================================================================
// compras/compras-editar.js — parte de compras.js (reorganizado 2026-09-25, sin cambios de lógica)
// Mapa completo de funciones: Claude outputs/glosario_funciones_erp.md
// ============================================================================
import { S } from './state.js'
import { getCurrentUser } from '../auth-supabase.js'
import { updateCompra, getCompraDetalles, updateCompraDetalle, getLoteById, deleteLote, getGuiasIngresoCompra, getDetalleGuiasIngresoCompra, deleteDetalleGuiaIngresoCompra, updateCuentaPagar, getLoteBultosByLote } from '../supabase-data.js'
import { showToast } from '../helpers.js'
import { _calcularMontosDetalleCompra } from './compra-nueva.js'
import { renderCompras } from './compras-lista.js'
import { _aplicarReversionGuiaIngreso, _planRevertirGuiaIngreso } from './guias-ingreso-lista.js'
import { _aplicarRecepcionesAGuiaIngreso } from './guias-ingreso-nueva.js'

// ── Patrón Ver Detalle / Editar (toggle) ───────────────────────────────────
// El modal abre SIEMPRE en modo lectura (Ver Detalle): título dinámico,
// campos de cabecera deshabilitados, solo el botón "Editar" visible. Al
// hacer clic en Editar se habilitan los campos (respetando los bloqueos de
// precio ya existentes por guía/pago/nota) y aparecen Cancelar/Guardar.
// Cancelar simplemente vuelve a cargar la compra desde cero (editarCompra)
// para descartar cualquier cambio no guardado y regresar a modo lectura.
const _EC_CAMPOS_CABECERA = ['ecReferencia', 'ecFechaEmision', 'ecFechaRecepcion', 'ecNumeroComprobante', 'ecMoneda', 'ecTipoCambio', 'ecEstadoPago']

export function _aplicarModoVistaEdicionCompra() {
  const c = S._ecContexto
  if (!c) return

  for (const campoId of _EC_CAMPOS_CABECERA) {
    const el = document.getElementById(campoId)
    if (el) el.disabled = S._ecModoVista
  }

  const titulo = document.getElementById('ec-titulo-modal')
  if (titulo) titulo.textContent = (S._ecModoVista ? 'Detalle de Compra' : 'Editar Compra') + (c.compra.referencia ? ` — ${c.compra.referencia}` : '')

  const btnEditar = document.getElementById('ecBtnEditar')
  const btnCancelar = document.getElementById('ecBtnCancelarEdicion')
  const btnGuardar = document.getElementById('ecBtnGuardar')
  if (btnEditar) btnEditar.style.display = S._ecModoVista ? '' : 'none'
  if (btnCancelar) btnCancelar.style.display = S._ecModoVista ? 'none' : ''
  if (btnGuardar) btnGuardar.style.display = S._ecModoVista ? 'none' : ''
}

window.activarEdicionCompra = function () {
  if (!S._ecContexto) return
  S._ecModoVista = false
  _aplicarModoVistaEdicionCompra()
  _pintarLineasEdicionCompra()
}

window.cancelarEdicionCompra = function () {
  const id = S._ecContexto?.compra?.id
  if (!id) { window.closeModal('modal-editar-compra'); return }
  window.editarCompra(id)
}

/** Tabla de líneas del modal Editar Compra: precio_unitario y tipo de IGV editables si !bloqueos.precios (y solo fuera de modo Ver Detalle). Mismo set de opciones que "Nueva Compra" (newDetalleCompraIGV: 18/18-inc/10/0). */
export function _pintarLineasEdicionCompra() {
  const c = S._ecContexto
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
      <td>${(() => {
        const it = c.itemsMap?.[d.item_id]
        return it ? `${it.sku ? '(' + it.sku + ') ' : ''}${it.nombre || ''}` : (d.descripcion || '')
      })()}</td>
      <td style="text-align:right;">${(parseFloat(d.cantidad) || 0).toLocaleString('en-US', { maximumFractionDigits: 3 })}</td>
      <td>${d.unidad_medida || '-'}</td>
      <td style="text-align:right;">
        <input type="number" step="0.0001" min="0.0001" value="${parseFloat(d.precio_unitario || 0)}"
          id="ecLineaPrecio-${idx}" style="width:100px; text-align:right;" ${(S._ecModoVista || c.bloqueos.precios) ? 'disabled' : ''}
          oninput="window.onCambiarLineaPrecioEdicionCompra(${idx})">
      </td>
      <td>
        <select id="ecLineaTipo-${idx}" ${(S._ecModoVista || c.bloqueos.precios) ? 'disabled' : ''} onchange="window.onCambiarLineaPrecioEdicionCompra(${idx})">
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
  const c = S._ecContexto
  const d = c?.detalles?.[idx]
  if (!d) return

  const precio = Math.max(0, parseFloat(document.getElementById(`ecLineaPrecio-${idx}`)?.value || 0))
  const igvValor = document.getElementById(`ecLineaTipo-${idx}`)?.value || '18'
  const cantidad = parseFloat(d.cantidad) || 0

  const { subtotal, igvMonto, total, igvPct, precioNeto } = _calcularMontosDetalleCompra(cantidad, precio, 0, igvValor)

  d._precioNuevo = precioNeto   // se guarda sin IGV (2026-10-09)
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
  const c = S._ecContexto
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
    const c = S._ecContexto
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
    // En SOLES el T.C. es solo referencia (no convierte el costo): recostear
    // solo si cambió la moneda o el T.C. de una compra en USD (2026-10-05).
    if ((monedaCambio || (tcCambio && moneda === 'USD')) && c.guiasCompra.length > 0) {
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
    S._ecContexto = null
    S._ecModoVista = true
    await renderCompras(true)
  } catch (error) {
    console.error('Error en guardarEdicionCompra:', error)
    showToast('Error al actualizar la compra', 'danger')
  }
}
