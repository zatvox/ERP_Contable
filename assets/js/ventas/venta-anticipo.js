// ============================================================================
// ventas/venta-anticipo.js — parte de ventas.js (reorganizado 2026-09-25, sin cambios de lógica)
// Mapa completo de funciones: Claude outputs/glosario_funciones_erp.md
// ============================================================================
import { S } from './state.js'
import { getCurrentUser } from '../auth-supabase.js'
import { addVenta, getVentas, addDetalleVenta, addCuentaCobrar, updateCuentaCobrar, generarNumeroVenta, getTodosVentasAnticiposAplicados, addVentaAnticipoAplicado } from '../supabase-data.js'
import { showToast } from '../helpers.js'
import { estaAnulado } from '../anulacion.js'
import { _esc } from './init.js'
import { renderVentas } from './ventas-lista.js'

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
  S._tipoVentaActual = tipo

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
  if (S._tipoVentaActual === 'anticipo') return window.guardarVentaAnticipo()
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
  if (S._tipoVentaActual === 'anticipo') return 0 // no aplica: un anticipo no recibe otro anticipo
  return S._ventaLineas.reduce((s, l) => s + (parseFloat(l.total_linea) || 0), 0)
}

export async function _cargarAnticiposDisponiblesCliente() {
  const wrap = document.getElementById('tvAnticiposDisponibles')
  const lista = document.getElementById('tvAnticiposLista')
  if (!wrap || !lista) return

  const contactId = parseInt(document.getElementById('ventaContactId')?.value || 0)
  if (!contactId || S._tipoVentaActual === 'anticipo') {
    wrap.style.display = 'none'
    lista.innerHTML = ''
    S._anticiposVentaDisponiblesCache = []
    return
  }

  try {
    S._anticiposVentaDisponiblesCache = await _obtenerAnticiposVentaDisponibles(contactId)
  } catch (e) {
    console.error('Error cargando anticipos disponibles del cliente:', e)
    S._anticiposVentaDisponiblesCache = []
  }

  if (S._anticiposVentaDisponiblesCache.length === 0) {
    wrap.style.display = 'none'
    lista.innerHTML = ''
    return
  }

  wrap.style.display = ''
  lista.innerHTML = S._anticiposVentaDisponiblesCache.map(a => `
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
    const a = S._anticiposVentaDisponiblesCache.find(x => x.id === anticipoId)
    const totalActual = _totalActualFormularioVenta()
    if (a) input.value = Math.min(a.saldo, totalActual > 0 ? totalActual : a.saldo).toFixed(2)
  }
}

/** Aplica los anticipos marcados en el modal contra la CxC recién creada de
 * `ventaDestino`. Se llama después de crear la CxC en guardarNuevaVenta (solo
 * tipo Mercadería; Anticipo nunca llama esto). */
export async function _aplicarAnticiposVentaSeleccionados(ventaDestino, cxcDestino, userId) {
  if (!ventaDestino?.id || !S._anticiposVentaDisponiblesCache.length) return

  let totalAplicado = 0
  for (const a of S._anticiposVentaDisponiblesCache) {
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
