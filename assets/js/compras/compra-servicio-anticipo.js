// ============================================================================
// compras/compra-servicio-anticipo.js — parte de compras.js (reorganizado 2026-09-25, sin cambios de lógica)
// Mapa completo de funciones: Claude outputs/glosario_funciones_erp.md
// ============================================================================
import { getCurrentUser } from '../auth-supabase.js'
import { getCompras, addCompra, addCompraDetalle, getContactById, updateCuentaPagar, getTodosComprasAnticiposAplicados, addCompraAnticipoAplicado, subirAdjuntoCompra } from '../supabase-data.js'
import { showToast } from '../helpers.js'
import { estaAnulado } from '../anulacion.js'
import { _escCompras } from './buscadores.js'
import { _detallesCompraEnCreacion, _tipoCompraActual } from './compra-nueva.js'
import { renderCompras } from './compras-lista.js'
import { _crearCuentaPagarSiFactura } from './ordenes-compra.js'

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

export async function _cargarAnticiposDisponiblesProveedor() {
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
export async function _aplicarAnticiposSeleccionados(compraDestino, cxpDestino, userId) {
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
