// ============================================================================
// ventas/ventas-editar.js — parte de ventas.js (reorganizado 2026-09-25, sin cambios de lógica)
// Mapa completo de funciones: Claude outputs/glosario_funciones_erp.md
// ============================================================================
import { S } from './state.js'
import { getCustomers, getContactsByType, getVentas, getVentaById, updateVenta, getDetalleVentas, updateDetalleVenta, getCuentasCobrarByVenta, updateCuentaCobrar, getCuotasCobrarByCxC, deleteCuotaCobrar, getGuiasDespachoVenta } from '../supabase-data.js'
import { showToast, formatNumber } from '../helpers.js'
import { estaAnulado } from '../anulacion.js'
import { TIPO_NC, TIPO_ND, esNota, nombreTipoComprobante } from '../notas.js'
import { convertirEnBuscador, refrescarBuscador } from '../buscador-select.js'
import { renderEditorCronograma, actualizarCronograma, leerCronograma, cargarCuotasExistentes } from '../cronograma.js'
import { _invalidarCacheVentas } from './anulacion.js'
import { _poblarSelectClientes, _poblarSelectVendedores } from './helpers.js'
import { _esc } from './init.js'
import { _guardarCuotasDeCxC } from './venta-nueva.js'
import { _ventasListaEnriquecida, renderVentas } from './ventas-lista.js'
import { getSeries, seriesDeTipo, serieDefault, getSerie, siguienteCorrelativo, NOMBRE_TIPO_SERIE } from '../series.js'
import { generarNumeroVenta, getContactById } from '../supabase-data.js'

// ─── Editar Venta (solo cabecera: no se tocan líneas/stock ya descontado) ────

// ============================================================================
// EDITAR VENTA — con propagación en cascada a los documentos vinculados
// ============================================================================
// Una venta no vive sola: de ella cuelgan la Cuenta por Cobrar, sus cuotas,
// las guías de despacho y el asiento contable. Antes este modal solo tocaba
// tres campos de `ventas` y NADA se propagaba: si corregías el cliente, la
// CxC seguía apuntando al cliente viejo y Cobranzas mostraba la deuda a la
// persona equivocada.
//
// Ahora se edita en un solo lugar y los cambios bajan a los vinculados, pero
// respetando dos límites que no son negociables:
//   * Lo que ya movió dinero no se toca (cuotas con cobros, retenciones).
//   * Los importes NUNCA se editan: un comprobante emitido se corrige con
//     Nota de Crédito o Débito, no reescribiendo el total.

let _evContexto = null   // { venta, cxc, cuotas, guias, bloqueos }
let _evModoVista = true   // true = solo lectura (Ver Detalle), false = edición habilitada

/** ¿Esta guía cuenta como despacho activo (mercadería todavía afuera)?
 *  'anulada' = se anuló/eliminó la guía directamente (revierte y borra el
 *  kardex de esa guía). 'revertida' = su mercadería volvió por una Nota de
 *  Crédito (revierte y AGREGA un kardex de entrada, sin borrar el original)
 *  — ver sección 6.4 del manual de diseño. Ambas dejan de contar como
 *  despacho vigente; una guía 'emitida' normal sí cuenta. */
export function _guiaEstaVigente(g) {
  return !!g && g.estado !== 'anulada' && g.estado !== 'revertida'
}

/** ¿Esta venta quedó "revertida por NC" — sigue aceptada/vigente, pero sus
 *  Notas de Crédito activas ya cubrieron el 100% de su importe? Se calcula
 *  al vuelo (mismo criterio que `disponibleNC` en _abrirNotaVenta) en vez de
 *  guardar una columna: así nunca se confunde con una anulación real
 *  (comunicación de baja) — ver 6.4 del manual de diseño. Usa la lista ya
 *  cargada en memoria (_ventasListaEnriquecida), sin consultas extra. */
export function _ventaRevertidaPorNC(v) {
  if (esNota(v.tipo_comprobante) || estaAnulado(v)) return false
  const notas = (_ventasListaEnriquecida || []).map(x => x.v).filter(n => n.venta_referencia_id === v.id && !estaAnulado(n))
  if (notas.length === 0) return false
  const ncPrevias = notas.filter(n => String(n.tipo_comprobante) === TIPO_NC).reduce((s, n) => s + (parseFloat(n.total) || 0), 0)
  const ndPrevias = notas.filter(n => String(n.tipo_comprobante) === TIPO_ND).reduce((s, n) => s + (parseFloat(n.total) || 0), 0)
  if (ncPrevias <= 0) return false
  const disponible = parseFloat((parseFloat(v.total || 0) + ndPrevias - ncPrevias).toFixed(2))
  return disponible <= 0.01
}

window.editarVenta = async function (id) {
  try {
    const v = await getVentaById(id)
    if (!v) { showToast('No se encontró la venta', 'danger'); return }

    if (estaAnulado(v)) {
      showToast('Este comprobante está anulado: no se puede editar', 'warning')
      return
    }

    // ── Contexto: todo lo que cuelga de esta venta ──────────────────────
    const [cxcs, guiasTodas, todasVentas, detalles] = await Promise.all([
      getCuentasCobrarByVenta(id), getGuiasDespachoVenta(true), getVentas(), getDetalleVentas(id)
    ])
    const cxc = (cxcs || [])[0] || null
    const cuotas = cxc ? await getCuotasCobrarByCxC(cxc.id) : []
    const guias = (guiasTodas || []).filter(g => g.venta_id === id && _guiaEstaVigente(g))
    const notas = (todasVentas || []).filter(x => x.venta_referencia_id === id && !estaAnulado(x))

    // Lo aplicado incluye retenciones, canjes y anticipos ya aplicados:
    // todos son dinero o deuda ya comprometida, aunque no haya entrado
    // efectivo ahora mismo.
    const aplicado = cxc
      ? parseFloat(cxc.monto_cobrado || 0) + parseFloat(cxc.monto_retenido || 0) + parseFloat(cxc.monto_canjeado || 0) + parseFloat(cxc.monto_anticipo_aplicado || 0)
      : 0

    const bloqueos = {
      cliente:    aplicado > 0.01 || notas.length > 0,
      moneda:     aplicado > 0.01,
      cronograma: aplicado > 0.01,
      numeracion: v.cpe_estado === 'aceptado',
      // Precio unitario / tipo IGV por línea: mismo criterio que numeración +
      // cliente. Un comprobante ACEPTADO por SUNAT no se corrige reescribiendo
      // el monto (eso es Nota de Crédito/Débito); y si ya hay cobros,
      // retenciones o canjes aplicados, o notas emitidas contra esta venta,
      // cambiar el total la descuadraría contra dinero que ya se movió.
      // (Pendiente: cuando el módulo de Contabilidad esté activo, agregar acá
      // el bloqueo por venta.asiento_id ya generado, para no dejarlo descuadrado.)
      precios:    v.cpe_estado === 'aceptado' || aplicado > 0.01 || notas.length > 0
    }

    _evContexto = { venta: v, cxc, cuotas, guias, notas, aplicado, bloqueos, detalles: detalles || [] }

    // ── Rellenar el formulario ──────────────────────────────────────────
    const numero = `${v.serie || ''}-${String(v.correlativo || '').padStart(8, '0')}`
    _setEv('ev-titulo', `Editar ${nombreTipoComprobante(v.tipo_comprobante)} ${numero}`)
    _valEv('evId', v.id)
    // Tipo: Factura ↔ Boleta editable (2026-10-02, caso BBOL-41 guardada como
    // Factura). Notas de crédito/débito NO cambian de tipo.
    {
      const selTipo = document.getElementById('evTipoComp')
      if (selTipo) {
        const editableTipo = v.tipo_comprobante === '01' || v.tipo_comprobante === '03'
        selTipo.innerHTML = editableTipo
          ? `<option value="01">01 — Factura</option><option value="03">03 — Boleta</option>`
          : `<option value="${_esc(v.tipo_comprobante)}">${_esc(v.tipo_comprobante)} — ${_esc(nombreTipoComprobante(v.tipo_comprobante))}</option>`
        selTipo.value = v.tipo_comprobante
        selTipo.dataset.editable = editableTipo ? '1' : ''
      }
    }
    _valEv('evSerie', v.serie || '')
    _valEv('evCorrelativo', String(v.correlativo || '').padStart(8, '0'))
    _valEv('evPeriodo', v.periodo_contable || (v.fecha_emision || '').slice(0, 7))
    _valEv('evFechaEmision', v.fecha_emision || '')
    _valEv('evMoneda', v.moneda || 'PEN')
    _valEv('evTipoCambio', parseFloat(v.tipo_cambio) || 1)
    _valEv('evDescripcion', v.descripcion || '')
    _valEv('evObservaciones', v.observaciones || '')

    _setEv('evBase', formatNumber(v.base_imponible))
    _setEv('evIgv', formatNumber(v.igv))
    _setEv('evTotal', `${v.moneda || 'PEN'} ${formatNumber(v.total)}`)
    _setEv('evEstadoPagoTexto', _etiquetaEstadoPago(cxc, aplicado))

    if (!S._clientes || S._clientes.length === 0) S._clientes = await getCustomers()
    _poblarSelectClientes()
    const selCli = document.getElementById('evContactId')
    if (selCli) {
      selCli.innerHTML = '<option value="">-- Selecciona --</option>' +
        S._clientes.map(c => `<option value="${c.id}">${_esc(c.razon_social || c.nombre || '')}</option>`).join('')
      selCli.value = v.contact_id || ''
    }
    if (!S._vendedores || S._vendedores.length === 0) { S._vendedores = await getContactsByType('vendedor'); _poblarSelectVendedores() }
    _valEv('evVendedor', v.vendedor_id || '')

    convertirEnBuscador('evContactId', { placeholder: 'Escribe el nombre o RUC...', sinResultados: 'Ningún cliente coincide' })
    convertirEnBuscador('evVendedor', { placeholder: 'Sin asignar — escribe para buscar...' })
    refrescarBuscador('evContactId')
    refrescarBuscador('evVendedor')
    window._onCambiarClienteEditarVenta()

    // Candados cerrados en cada apertura
    ;[['evSerie','btnCandadoEvSerie','aviso-ev-serie'],
      ['evCorrelativo','btnCandadoEvCorr','aviso-ev-corr'],
      ['evPeriodo','btnCandadoEvPeriodo','aviso-ev-periodo']].forEach(([i, b, a]) => {
      const inp = document.getElementById(i), btn = document.getElementById(b)
      if (inp) { inp.readOnly = true; inp.dataset.valorAutomatico = inp.value }
      if (btn) { btn.textContent = '🔒'; btn.classList.remove('abierto'); btn.disabled = !!bloqueos.numeracion }
      document.getElementById(a)?.classList.remove('visible')
    })

    window.onCambiarMonedaEdicion()
    _pintarAvisosEdicion()
    _evModoVista = true
    _aplicarModoVistaEdicionVenta()
    _pintarLineasEdicionVenta()
    await _pintarCronogramaEdicion()
    _pintarVinculados()

    window.openModal('modal-editar-venta')
  } catch (error) {
    console.error('Error en editarVenta:', error)
    showToast('Error al abrir la venta para editar: ' + error.message, 'danger')
  }
}

// ── Patrón Ver Detalle / Editar (toggle) ───────────────────────────────────
// Igual criterio que en Compras: el modal abre SIEMPRE en modo lectura
// (Ver Detalle) — campos deshabilitados, candados de serie/número/período
// ocultos, cronograma en solo lectura — con solo el botón "Editar" visible.
// Al activar edición se reaplican los bloqueos finos que ya existían
// (cliente/moneda/cronograma/precios según cobros, notas, SUNAT) llamando
// de nuevo a las mismas funciones que los calculan. Cancelar recarga la
// venta desde cero (editarVenta) para descartar cambios no guardados.
const _EV_CAMPOS_CABECERA = ['evFechaEmision', 'evMoneda', 'evTipoCambio', 'evDescripcion', 'evObservaciones', 'evVendedor']

function _disableBuscadorEv(selectId, disabled) {
  const sel = document.getElementById(selectId)
  if (!sel) return
  sel.disabled = disabled
  const inp = sel.parentElement?.querySelector('.bsq-input')
  if (inp) inp.disabled = disabled
}

function _aplicarModoVistaEdicionVenta() {
  const c = _evContexto
  if (!c) return

  for (const campoId of _EV_CAMPOS_CABECERA) {
    const el = document.getElementById(campoId)
    if (el) el.disabled = _evModoVista
  }
  _disableBuscadorEv('evContactId', _evModoVista || !!c.bloqueos.cliente)
  const selTipo = document.getElementById('evTipoComp')
  if (selTipo) selTipo.disabled = _evModoVista || !selTipo.dataset.editable || !!c.bloqueos.numeracion

  ;['btnCandadoEvSerie', 'btnCandadoEvCorr', 'btnCandadoEvPeriodo'].forEach(id => {
    const btn = document.getElementById(id)
    if (btn) btn.style.display = _evModoVista ? 'none' : ''
  })

  // Fuera de modo vista, se reaplican los candados finos que ya existían
  // (moneda/cliente según cobros/notas) — el bucle de arriba solo maneja el
  // apagado general de "estoy viendo, no editando".
  if (!_evModoVista) window.onCambiarMonedaEdicion()

  const numero = `${c.venta.serie || ''}-${String(c.venta.correlativo || '').padStart(8, '0')}`
  _setEv('ev-titulo', `${_evModoVista ? 'Detalle de' : 'Editar'} ${nombreTipoComprobante(c.venta.tipo_comprobante)} ${numero}`)

  const btnEditar = document.getElementById('evBtnEditar')
  const btnCancelar = document.getElementById('evBtnCancelarEdicion')
  const btnGuardar = document.getElementById('btnGuardarEdicionVenta')
  if (btnEditar) btnEditar.style.display = _evModoVista ? '' : 'none'
  if (btnCancelar) btnCancelar.style.display = _evModoVista ? 'none' : ''
  if (btnGuardar) btnGuardar.style.display = _evModoVista ? 'none' : ''
}

window.activarEdicionVenta = async function () {
  if (!_evContexto) return
  _evModoVista = false
  _aplicarModoVistaEdicionVenta()
  _pintarLineasEdicionVenta()
  await _pintarCronogramaEdicion()
}

window.cancelarEdicionVenta = function () {
  const id = _evContexto?.venta?.id
  if (!id) { window.closeModal('modal-editar-venta'); return }
  window.editarVenta(id)
}

function _etiquetaEstadoPago(cxc, aplicado) {
  if (!cxc) return 'Sin cuenta por cobrar'
  const total = parseFloat(cxc.monto_total || 0) + parseFloat(cxc.monto_notas_debito || 0) - parseFloat(cxc.monto_notas_credito || 0)
  if (aplicado >= total - 0.01) return 'Cobrado ✅'
  if (aplicado > 0.01) return `Parcial — aplicado ${formatNumber(aplicado)} de ${formatNumber(total)}`
  return 'Pendiente'
}

/** Avisa qué está bloqueado y por qué, antes de que el usuario lo intente. */
function _pintarAvisosEdicion() {
  const c = _evContexto
  const cont = document.getElementById('ev-avisos')
  if (!cont || !c) return

  const avisos = []
  if (c.aplicado > 0.01) {
    avisos.push({ t: 'warning', txt: `Esta venta ya tiene ${formatNumber(c.aplicado)} aplicado entre cobros, retenciones o canjes. No se pueden cambiar el cliente, la moneda ni el cronograma.` })
  }
  if (c.notas.length > 0) {
    avisos.push({ t: 'warning', txt: `Tiene ${c.notas.length} nota(s) de crédito/débito asociada(s). El cliente no se puede cambiar sin corregirlas primero.` })
  }
  if (c.venta.cpe_estado === 'aceptado') {
    avisos.push({ t: 'danger', txt: 'El comprobante ya fue aceptado por SUNAT. Cambiar serie, número o cliente aquí NO lo corrige ante SUNAT: eso se hace con Nota de Crédito o Comunicación de Baja.' })
  }
  if (c.guias.length > 0) {
    avisos.push({ t: 'info', txt: `Tiene ${c.guias.length} guía(s) de despacho emitida(s). Si cambias el cliente, revisa que el destino de la mercadería siga siendo correcto. Moneda y Tipo de Cambio SÍ se pueden cambiar sin problema: el costo de Kardex no depende de ellos (viene fijo del lote desde la compra) — solo se resincroniza la Cuenta por Cobrar.` })
  }
  if (c.venta.asiento_id) {
    avisos.push({ t: 'warning', txt: 'Esta venta ya tiene asiento contable generado. Si cambias moneda, tipo de cambio o precios, el asiento en Contabilidad NO se actualiza automáticamente — queda pendiente hasta activar ese módulo.' })
  }

  cont.innerHTML = avisos.length === 0
    ? '<div style="padding:9px 12px; border-radius:var(--radius-md); background:rgba(16,185,129,.12); color:var(--color-success); font-size:.85rem;">Sin cobros ni notas: se puede editar todo.</div>'
    : avisos.map(a => `<div style="padding:9px 12px; margin-bottom:6px; border-radius:var(--radius-md); font-size:.85rem; line-height:1.45;
        background:${a.t === 'danger' ? 'rgba(239,68,68,.12)' : a.t === 'warning' ? 'rgba(245,158,11,.12)' : 'rgba(59,130,246,.12)'};
        color:var(--${a.t === 'danger' ? 'color-danger' : a.t === 'warning' ? 'color-warning' : 'color-info'});">${_esc(a.txt)}</div>`).join('')
}

// Etiqueta + color reutilizada del modal "Nueva Venta" (misma paleta que
// _badgeTipoIGV) para que ambos lugares se vean consistentes.
function _badgeTipoIGVEdicion(tipoBase) {
  const map = {
    gravada:   { label: 'Gravada 18%', color: 'var(--color-info)' },
    exonerada: { label: 'Exonerada',   color: 'var(--color-warning)' },
    inafecta:  { label: 'Inafecta',    color: 'var(--text-secondary)' }
  }
  const m = map[tipoBase] || { label: tipoBase || '-', color: 'var(--text-secondary)' }
  return `<span style="display:inline-block; padding:2px 8px; border-radius:999px; font-size:0.75rem; font-weight:600; color:#fff; background:${m.color}; white-space:nowrap;">${m.label}</span>`
}

/**
 * Tabla de líneas del comprobante en "Editar Venta": precio_unitario y tipo
 * de IGV quedan editables (cantidad NO — ya se despachó el stock real). Al
 * tocar un campo se recalcula Subtotal/IGV/Total de esa fila y los totales
 * del pie en vivo, con window.onCambiarLineaPrecioEdicion. Si
 * bloqueos.precios está activo, los campos quedan solo-lectura y se explica
 * el motivo en #ev-precios-aviso (mismo patrón que los otros candados).
 */
function _pintarLineasEdicionVenta() {
  const c = _evContexto
  const cont = document.getElementById('ev-lineas')
  const aviso = document.getElementById('ev-precios-aviso')
  if (!cont || !c) return

  if (aviso) {
    if (c.bloqueos.precios) {
      const motivo = c.venta.cpe_estado === 'aceptado'
        ? 'el comprobante ya fue aceptado por SUNAT'
        : (c.notas.length > 0
          ? 'tiene notas de crédito/débito asociadas'
          : 'ya tiene cobros, retenciones o canjes aplicados')
      aviso.textContent = `Precio y tipo de IGV bloqueados: ${motivo}. Para corregir el monto, usa una Nota de Crédito o Débito.`
      aviso.style.color = 'var(--color-warning)'
    } else {
      aviso.textContent = 'Puedes corregir el precio unitario y el tipo de IGV de cada línea — la cantidad y el lote no se tocan aquí.'
      aviso.style.color = 'var(--text-secondary)'
    }
  }

  if (c.detalles.length === 0) {
    cont.innerHTML = `<tr><td colspan="8" style="text-align:center; color:var(--text-secondary); padding:14px;">Esta venta no tiene líneas registradas.</td></tr>`
    return
  }

  cont.innerHTML = c.detalles.map((d, idx) => `
    <tr>
      <td>${(() => {
        const it = (S._items || []).find(i => i.id === d.item_id)
        return it ? _esc(`${it.sku ? '(' + it.sku + ') ' : ''}${it.nombre || ''}`) : _esc(d.descripcion || '')
      })()}</td>
      <td style="text-align:right;">${(parseFloat(d.cantidad) || 0).toLocaleString('en-US', { maximumFractionDigits: 3 })}</td>
      <td>${_esc(d.unidad_medida || '-')}</td>
      <td style="text-align:right;">
        <input type="number" step="0.01" min="0.01" value="${parseFloat(d.precio_unitario || 0)}"
          id="evLineaPrecio-${idx}" style="width:100px; text-align:right;" ${(_evModoVista || c.bloqueos.precios) ? 'disabled' : ''}
          oninput="window.onCambiarLineaPrecioEdicion(${idx})">
      </td>
      <td>
        <select id="evLineaTipo-${idx}" ${(_evModoVista || c.bloqueos.precios) ? 'disabled' : ''} onchange="window.onCambiarLineaPrecioEdicion(${idx})">
          <option value="gravada"${d.tipo_base === 'gravada' ? ' selected' : ''}>Gravada 18%</option>
          <option value="gravada_incluido" title="El precio unitario que escribas ya trae el IGV incluido; se normaliza a la base al guardar.">Gravada 18% (incluido)</option>
          <option value="exonerada"${d.tipo_base === 'exonerada' ? ' selected' : ''}>Exonerada</option>
          <option value="inafecta"${d.tipo_base === 'inafecta' ? ' selected' : ''}>Inafecta</option>
        </select>
      </td>
      <td style="text-align:right;" id="evLineaSubtotal-${idx}">${parseFloat(d.subtotal || 0).toFixed(2)}</td>
      <td style="text-align:right;" id="evLineaIgv-${idx}">${parseFloat(d.igv_monto || 0).toFixed(2)}</td>
      <td style="text-align:right; font-weight:600;" id="evLineaTotal-${idx}">${parseFloat(d.total_linea || 0).toFixed(2)}</td>
    </tr>
  `).join('')
}

/** Recalcula Subtotal/IGV/Total de UNA línea (en memoria, sobre _evContexto.detalles) y los totales del pie. */
window.onCambiarLineaPrecioEdicion = function (idx) {
  const c = _evContexto
  const d = c?.detalles?.[idx]
  if (!d) return

  const precio = Math.max(0, parseFloat(document.getElementById(`evLineaPrecio-${idx}`)?.value || 0))
  const tipoBase = document.getElementById(`evLineaTipo-${idx}`)?.value || 'gravada'
  const cantidad = parseFloat(d.cantidad) || 0

  // "Gravada 18% (incluido)" es solo un modo de captura (igual que en
  // Agregar Producto/Editar Línea de venta): el precio que se escribe ya
  // trae el IGV incluido, y se normaliza a la base SIN IGV antes de guardar
  // — tipo_base se persiste como 'gravada' (el CHECK de detalle_ventas no
  // tiene un valor aparte para esto).
  const igvIncluido = tipoBase === 'gravada_incluido'
  const tipoBaseGuardar = igvIncluido ? 'gravada' : tipoBase
  const igvPct = (tipoBase === 'gravada' || igvIncluido) ? 18 : 0

  let subtotal, igvMonto, totalLinea, precioGuardar
  if (igvIncluido && cantidad > 0) {
    totalLinea = parseFloat((cantidad * precio).toFixed(2))
    subtotal   = parseFloat((totalLinea / 1.18).toFixed(2))
    igvMonto   = parseFloat((totalLinea - subtotal).toFixed(2))
    precioGuardar = parseFloat((subtotal / cantidad).toFixed(4))
  } else {
    subtotal  = parseFloat((cantidad * precio).toFixed(2))
    igvMonto  = parseFloat((subtotal * igvPct / 100).toFixed(2))
    totalLinea = parseFloat((subtotal + igvMonto).toFixed(2))
    precioGuardar = precio
  }

  // Se guarda en memoria (no en BD todavía) — recién se persiste al confirmar
  // "Guardar y propagar cambios", igual que el resto del formulario.
  d._precioNuevo = precioGuardar
  d._tipoBaseNuevo = tipoBaseGuardar
  d._subtotalNuevo = subtotal
  d._igvMontoNuevo = igvMonto
  d._totalLineaNuevo = totalLinea

  _setEv(`evLineaSubtotal-${idx}`, subtotal.toFixed(2))
  _setEv(`evLineaIgv-${idx}`, igvMonto.toFixed(2))
  _setEv(`evLineaTotal-${idx}`, totalLinea.toFixed(2))

  _recalcularTotalesEdicionVenta()
}

/**
 * Suma las líneas (con sus valores editados si los hay), refresca
 * Base/IGV/Total del pie y — si el cronograma no está bloqueado — le avisa
 * el nuevo total para que sus cuotas se re-prorrateen contra ESE monto y no
 * contra el total viejo con el que se abrió el editor. Sin esto, "Prorratear
 * al total" del cronograma seguiría prorrateando contra el monto original.
 */
function _recalcularTotalesEdicionVenta() {
  const c = _evContexto
  if (!c) return
  let base = 0, igv = 0, total = 0
  for (const d of c.detalles) {
    base  += d._subtotalNuevo   ?? parseFloat(d.subtotal || 0)
    igv   += d._igvMontoNuevo   ?? parseFloat(d.igv_monto || 0)
    total += d._totalLineaNuevo ?? parseFloat(d.total_linea || 0)
  }
  base = parseFloat(base.toFixed(2)); igv = parseFloat(igv.toFixed(2)); total = parseFloat(total.toFixed(2))
  _setEv('evBase', formatNumber(base))
  _setEv('evIgv', formatNumber(igv))
  _setEv('evTotal', `${document.getElementById('evMoneda')?.value || 'PEN'} ${formatNumber(total)}`)

  if (c.cxc && !c.bloqueos.cronograma) {
    actualizarCronograma('ev-cronograma', { total })
  }
}

/** Lista los documentos que cuelgan de la venta y qué les va a pasar. */
function _pintarVinculados() {
  const c = _evContexto
  const cont = document.getElementById('ev-vinculados')
  if (!cont || !c) return

  const filas = []
  if (c.cxc) {
    filas.push({
      doc: `Cuenta por Cobrar — ${c.cxc.tipo_comprobante || ''} ${c.cxc.serie || ''}-${c.cxc.numero_comprobante || ''}`,
      detalle: `${c.cxc.moneda || 'PEN'} ${formatNumber(c.cxc.monto_total)} · estado ${c.cxc.estado}`,
      efecto: 'Se actualizarán cliente, serie/número, fechas, moneda y tipo de cambio.'
    })
  }
  if (c.cuotas.length > 0) {
    const conCobro = c.cuotas.filter(q => (parseFloat(q.monto_cobrado) || 0) + (parseFloat(q.monto_retenido) || 0) > 0.01).length
    filas.push({
      doc: `${c.cuotas.length} cuota(s) del cronograma`,
      detalle: conCobro > 0 ? `${conCobro} con cobros aplicados` : 'ninguna cobrada',
      efecto: conCobro > 0
        ? 'NO se modifican: ya tienen dinero aplicado.'
        : 'Se reemplazan por el cronograma que dejes arriba.'
    })
  }
  c.guias.forEach(g => filas.push({
    doc: `Guía de despacho ${g.numero_guia}`, detalle: g.fecha_guia || '',
    efecto: 'No se modifica (el stock ya se movió).'
  }))
  c.notas.forEach(n => filas.push({
    doc: `${nombreTipoComprobante(n.tipo_comprobante)} ${n.serie || ''}-${String(n.correlativo || '').padStart(8, '0')}`,
    detalle: `${n.moneda || 'PEN'} ${formatNumber(n.total)}`,
    efecto: 'No se modifica. Si cambias serie/número, su referencia se actualiza.'
  }))
  if (c.venta.asiento_id) filas.push({
    doc: `Asiento contable AS-${String(c.venta.asiento_id).padStart(6, '0')}`, detalle: '',
    efecto: 'No se regenera automáticamente. Si cambias la fecha o el tipo de cambio, revísalo en Contabilidad.'
  })

  cont.innerHTML = filas.length === 0
    ? '<p style="color:var(--text-secondary); font-size:.85rem;">Esta venta no tiene documentos vinculados todavía.</p>'
    : `<div class="table-container"><table>
        <thead><tr><th>Documento</th><th>Detalle</th><th>Al guardar</th></tr></thead>
        <tbody>${filas.map(f => `<tr>
          <td style="font-size:.84rem;"><strong>${_esc(f.doc)}</strong></td>
          <td style="font-size:.84rem; color:var(--text-secondary);">${_esc(f.detalle)}</td>
          <td style="font-size:.82rem;">${_esc(f.efecto)}</td>
        </tr>`).join('')}</tbody></table></div>`
}

async function _pintarCronogramaEdicion() {
  const c = _evContexto
  const cont = document.getElementById('ev-cronograma')
  if (!cont || !c) return

  if (!c.cxc) {
    cont.innerHTML = '<p style="color:var(--text-secondary); font-size:.85rem;">Esta venta no generó Cuenta por Cobrar (no es factura), así que no tiene cronograma.</p>'
    return
  }

  await renderEditorCronograma('ev-cronograma', {
    total: parseFloat(c.cxc.monto_total) || 0,
    fechaEmision: c.venta.fecha_emision,
    terminoId: c.cxc.termino_pago_id || null,
    aplicaA: 'venta',
    soloLectura: _evModoVista || c.bloqueos.cronograma
  })

  // Si ya existen cuotas guardadas, se muestran ESAS y no un cronograma
  // recalculado: son la verdad del documento, incluidas las fechas que el
  // usuario negoció a mano en su momento.
  if (c.cuotas.length > 0) {
    cargarCuotasExistentes('ev-cronograma', c.cuotas)
  }

  if (c.bloqueos.cronograma) {
    cont.insertAdjacentHTML('beforeend',
      '<div style="margin-top:6px; font-size:.78rem; color:var(--color-warning);">Cronograma en solo lectura: ya hay cobros aplicados. Para reprogramar, revierte primero los cobros en Cuentas x Cobrar/Pagar.</div>')
  }
}

window.onCambiarFechaEmisionEdicion = function () {
  const fecha = document.getElementById('evFechaEmision')?.value
  if (!fecha) return
  const per = document.getElementById('evPeriodo')
  if (per && per.readOnly) { per.value = fecha.slice(0, 7); per.dataset.valorAutomatico = per.value }
  if (!_evContexto?.bloqueos.cronograma) actualizarCronograma('ev-cronograma', { fechaEmision: fecha })
}

window.onCambiarMonedaEdicion = function () {
  const moneda = document.getElementById('evMoneda')?.value
  const grupo = document.getElementById('evTipoCambioGroup')
  const inp = document.getElementById('evTipoCambio')
  const bloqueada = !!_evContexto?.bloqueos.moneda
  if (grupo) grupo.style.display = moneda === 'USD' ? '' : 'none'
  if (moneda !== 'USD' && inp) inp.value = 1
  const sel = document.getElementById('evMoneda')
  if (sel) sel.disabled = bloqueada
  const aviso = document.getElementById('ev-cliente-aviso')
  const selCli = document.getElementById('evContactId')
  if (selCli) selCli.disabled = !!_evContexto?.bloqueos.cliente
  if (aviso) aviso.textContent = _evContexto?.bloqueos.cliente ? 'Bloqueado: la venta ya tiene cobros o notas.' : ''
}

/** Cambio Factura ↔ Boleta en Editar: si la serie actual no es del nuevo
 *  tipo, se propone la serie por defecto del tipo y su siguiente número. */
window._onCambiarTipoEdicionVenta = async function () {
  const c = _evContexto
  const tipo = document.getElementById('evTipoComp')?.value
  const serieEl = document.getElementById('evSerie')
  const corrEl = document.getElementById('evCorrelativo')
  if (!c || !tipo || !serieEl) return
  const lista = await seriesDeTipo(tipo).catch(() => [])
  const serieActual = serieEl.value.trim().toUpperCase()
  if (lista.length && !lista.some(x => x.serie === serieActual)) {
    const def = lista.find(x => x.por_defecto) || lista[0]
    serieEl.value = def.serie
    const maxUsado = (await generarNumeroVenta(tipo, def.serie)) - 1
    if (corrEl) corrEl.value = String(siguienteCorrelativo(def, maxUsado)).padStart(8, '0')
    showToast(`La serie ${serieActual} no es de ${NOMBRE_TIPO_SERIE[tipo]}: se propone ${def.serie}-${corrEl?.value}. Puedes ajustarla con el candado.`, 'info', 7000)
  } else {
    showToast(`Serie ${serieActual} válida para ${NOMBRE_TIPO_SERIE[tipo]} — se conserva la numeración.`, 'success')
  }
}

window.guardarEdicionVenta = async function () {
  const btn = document.getElementById('btnGuardarEdicionVenta')
  if (btn?.disabled) return
  try {
    const c = _evContexto
    const id = parseInt(document.getElementById('evId')?.value || 0)
    if (!id || !c) { showToast('Venta inválida', 'danger'); return }

    const serie      = document.getElementById('evSerie')?.value?.trim().toUpperCase()
    const tipoComp   = document.getElementById('evTipoComp')?.value || c.venta.tipo_comprobante
    const correl     = document.getElementById('evCorrelativo')?.value?.trim()
    const periodo    = document.getElementById('evPeriodo')?.value?.trim()
    const fechaEmi   = document.getElementById('evFechaEmision')?.value
    const contactId  = parseInt(document.getElementById('evContactId')?.value || 0) || c.venta.contact_id
    const vendedorId = parseInt(document.getElementById('evVendedor')?.value || 0) || null
    const moneda     = document.getElementById('evMoneda')?.value || c.venta.moneda
    const tipoCambio = moneda === 'USD' ? (parseFloat(document.getElementById('evTipoCambio')?.value || 0) || 1) : 1
    const descripcion   = document.getElementById('evDescripcion')?.value?.trim() || null
    const observaciones = document.getElementById('evObservaciones')?.value?.trim() || null

    if (!fechaEmi) { showToast('La fecha de emisión es obligatoria', 'warning'); return }
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(periodo || '')) {
      showToast('El período contable debe tener el formato AAAA-MM', 'warning'); return
    }
    if (moneda === 'USD' && tipoCambio <= 1) {
      showToast('Ingresa el tipo de cambio para una venta en dólares', 'warning'); return
    }

    // ── Validación Tipo ↔ Serie ↔ Cliente (mismo criterio que Nueva Venta) ──
    if (tipoComp === '01' || tipoComp === '03') {
      const seriesTipo = await seriesDeTipo(tipoComp).catch(() => null)
      if (seriesTipo?.length && !seriesTipo.some(x => x.serie === serie)) {
        const otra = (await getSeries().catch(() => [])).find(x => x.serie === serie)
        showToast(otra
          ? `La serie ${serie} es de ${NOMBRE_TIPO_SERIE[otra.tipo_documento] || otra.tipo_documento}, no de ${NOMBRE_TIPO_SERIE[tipoComp]}.`
          : `La serie ${serie} no está registrada para ${NOMBRE_TIPO_SERIE[tipoComp]} (Configuración → Series).`, 'danger', 8000)
        return
      }
      const cli = await getContactById(contactId)
      const docCli = String(cli?.nro_documento || '').replace(/\D/g, '')
      const esDNI = String(cli?.tipo_documento || '').toUpperCase() === 'DNI' || docCli.length === 8
      if (tipoComp === '01' && esDNI) {
        showToast('Una Factura no se emite a DNI: el cliente necesita RUC. Con DNI corresponde Boleta.', 'danger', 8000)
        return
      }
      if (tipoComp === '03' && docCli.length === 11 && tipoComp !== c.venta.tipo_comprobante &&
          !confirm('El cliente tiene RUC y la estás pasando a BOLETA (no le sirve para crédito fiscal). ¿Continuar?')) return
    }

    // Numeración duplicada: solo se valida si realmente cambió.
    const numeroNuevo = `${serie}-${String(correl).padStart(8, '0')}`
    const numeroViejo = `${c.venta.serie || ''}-${String(c.venta.correlativo || '').padStart(8, '0')}`
    if (numeroNuevo !== numeroViejo) {
      const existe = (await getVentas() || []).some(v => v.id !== id && v.numero === numeroNuevo)
      if (existe) { showToast(`Ya existe el comprobante ${numeroNuevo}`, 'danger'); return }
    }

    // Precio unitario / tipo IGV por línea: si bloqueos.precios está activo
    // (CPE aceptado, cobros/retenciones/canjes aplicados, o notas asociadas)
    // los totales quedan exactamente como estaban — ninguna línea se toca.
    let huboCambioPrecios = false
    const detallesCambiados = []
    let nuevoBase = 0, nuevoIgv = 0, nuevoTotal = 0
    if (c.bloqueos.precios) {
      nuevoBase  = parseFloat(c.venta.base_imponible) || 0
      nuevoIgv   = parseFloat(c.venta.igv) || 0
      nuevoTotal = parseFloat(c.venta.total) || 0
    } else {
      for (const d of c.detalles) {
        const precioOriginal = parseFloat(d.precio_unitario || 0)
        const tipoOriginal   = d.tipo_base
        const subtotal    = d._subtotalNuevo   ?? parseFloat(d.subtotal || 0)
        const igvMonto    = d._igvMontoNuevo   ?? parseFloat(d.igv_monto || 0)
        const totalLinea  = d._totalLineaNuevo ?? parseFloat(d.total_linea || 0)
        nuevoBase += subtotal; nuevoIgv += igvMonto; nuevoTotal += totalLinea

        const precioCambio = d._precioNuevo != null && Math.abs(d._precioNuevo - precioOriginal) > 0.0001
        const tipoCambio_  = d._tipoBaseNuevo != null && d._tipoBaseNuevo !== tipoOriginal
        if (precioCambio || tipoCambio_) {
          huboCambioPrecios = true
          detallesCambiados.push({
            id: d.id,
            precio_unitario: d._precioNuevo ?? precioOriginal,
            tipo_base: d._tipoBaseNuevo ?? tipoOriginal,
            igv_porcentaje: (d._tipoBaseNuevo ?? tipoOriginal) === 'gravada' ? 18 : 0,
            subtotal, igv_monto: igvMonto, total_linea: totalLinea
          })
        }
      }
      if (huboCambioPrecios && nuevoTotal <= 0) {
        showToast('El total de la venta no puede quedar en 0 o negativo', 'warning')
        return
      }
    }

    // Cronograma — se valida contra el total NUEVO (con los precios ya
    // editados), no contra el total viejo con el que se abrió el editor:
    // si se cambia precio y cronograma en la misma pasada, tienen que
    // cuadrar entre sí, no cada uno contra un total distinto.
    let crono = null
    if (!c.bloqueos.cronograma && c.cxc) {
      crono = leerCronograma('ev-cronograma')
      if (crono && Math.abs(crono.suma - nuevoTotal) > 0.01) {
        showToast(`Las cuotas suman ${formatNumber(crono.suma)} pero el total es ${formatNumber(nuevoTotal)}. Usa "= Prorratear al total".`, 'warning')
        return
      }
    }

    // Resumen de la cascada para que el usuario confirme lo que va a pasar.
    const cambios = []
    const cambioTipo = tipoComp !== c.venta.tipo_comprobante
    if (cambioTipo) cambios.push(`tipo (${nombreTipoComprobante(c.venta.tipo_comprobante)} → ${nombreTipoComprobante(tipoComp)})`)
    if (contactId !== c.venta.contact_id) cambios.push('cliente')
    if (numeroNuevo !== numeroViejo) cambios.push('serie/número')
    if (fechaEmi !== c.venta.fecha_emision) cambios.push('fecha de emisión')
    if (periodo !== c.venta.periodo_contable) cambios.push('período contable')
    if (moneda !== c.venta.moneda) cambios.push('moneda')
    if (Math.abs(tipoCambio - (parseFloat(c.venta.tipo_cambio) || 1)) > 0.0001) cambios.push('tipo de cambio')
    if (crono?.cuotas?.length) cambios.push('cronograma de pago')
    if (huboCambioPrecios) cambios.push(`precio/IGV de ${detallesCambiados.length} línea(s) — nuevo total ${formatNumber(nuevoTotal)}`)

    if (cambios.length === 0) {
      showToast('No hay cambios que guardar', 'info')
      return
    }
    if (!confirm(
      `Se actualizará ${cambios.join(', ')} en la venta ${numeroViejo}` +
      (cambioTipo && c.venta.asiento_id ? ` (el asiento contable ya generado NO se regenera)` : '') +
      (c.cxc ? `, y se propagará a su Cuenta por Cobrar${crono ? ' y su cronograma de cuotas' : ''}.` : '.') +
      `\n\n¿Confirmar?`
    )) return

    if (btn) { btn.disabled = true; btn.textContent = 'Guardando...' }

    // ── 1) La venta ────────────────────────────────────────────────────
    const fechaVenc = crono?.cuotas?.length
      ? crono.cuotas[crono.cuotas.length - 1].fecha_vencimiento
      : c.venta.fecha_vencimiento

    const okVenta = await updateVenta(id, {
      tipo_comprobante: tipoComp,
      contact_id: contactId, vendedor_id: vendedorId,
      serie, correlativo: correl.replace(/^0+/, '') || correl,
      numero: numeroNuevo,
      fecha_emision: fechaEmi, fecha_vencimiento: fechaVenc,
      periodo_contable: periodo, moneda, tipo_cambio: tipoCambio,
      descripcion, observaciones,
      termino_pago_id: crono?.terminoId ?? c.venta.termino_pago_id,
      cronograma_personalizado: crono ? !!crono.personalizado : c.venta.cronograma_personalizado,
      base_imponible: parseFloat(nuevoBase.toFixed(2)),
      igv:            parseFloat(nuevoIgv.toFixed(2)),
      total:          parseFloat(nuevoTotal.toFixed(2))
    })
    if (!okVenta) throw new Error('no se pudo actualizar la venta')

    // ── 1b) Líneas con precio/IGV corregido ─────────────────────────────
    // Solo las que realmente cambiaron — el resto de detalle_ventas queda
    // intacto (cantidad, lote_id, etc. no se tocan desde este modal).
    if (detallesCambiados.length > 0) {
      for (const dc of detallesCambiados) {
        try {
          await updateDetalleVenta(dc.id, {
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

    // ── 2) Cuenta por Cobrar ───────────────────────────────────────────
    // Sin esto, Cobranzas seguiría mostrando la deuda con los datos viejos.
    // monto_total se sincroniza siempre con el total recién calculado —
    // si hubo cambio de precio es el motivo principal; si no lo hubo, es el
    // mismo valor de antes y no cambia nada.
    if (c.cxc) {
      try {
        await updateCuentaCobrar(c.cxc.id, {
          ...(c.cxc.tipo_comprobante !== undefined ? { tipo_comprobante: tipoComp } : {}),
          contact_id: contactId, serie, numero_comprobante: correl.replace(/^0+/, '') || correl,
          fecha_emision: fechaEmi, fecha_vencimiento: fechaVenc,
          moneda, tipo_cambio: tipoCambio,
          monto_total: parseFloat(nuevoTotal.toFixed(2)),
          termino_pago_id: crono?.terminoId ?? c.cxc.termino_pago_id,
          cronograma_personalizado: crono ? !!crono.personalizado : c.cxc.cronograma_personalizado
        })
      } catch (e) {
        console.warn('CxC no actualizada:', e.message)
        showToast('Venta guardada ⚠️ la Cuenta por Cobrar no se actualizó: ' + e.message, 'warning')
      }
    }

    // ── 3) Cuotas ──────────────────────────────────────────────────────
    // Se reemplazan enteras: reconciliar altas/bajas/cambios de orden una por
    // una es más frágil que regenerarlas, y aquí ya validamos que ninguna
    // tiene dinero aplicado.
    if (crono?.cuotas?.length && c.cxc) {
      try {
        for (const q of c.cuotas) await deleteCuotaCobrar(q.id)
        await _guardarCuotasDeCxC(c.cxc.id, crono)
      } catch (e) {
        console.warn('Cuotas no regeneradas:', e.message)
        showToast('⚠️ El cronograma no se pudo regenerar: ' + e.message, 'warning')
      }
    }

    // ── 4) Notas que referencian esta venta ────────────────────────────
    if ((numeroNuevo !== numeroViejo || cambioTipo) && c.notas.length > 0) {
      for (const n of c.notas) {
        try {
          await updateVenta(n.id, {
            ...(cambioTipo ? { doc_referencia_tipo: tipoComp } : {}),
            doc_referencia_serie: serie,
            doc_referencia_numero: correl.replace(/^0+/, '') || correl
          })
        } catch (e) { console.warn(`Nota ${n.id} no actualizada:`, e.message) }
      }
    }

    _invalidarCacheVentas()
    showToast(`Venta ${numeroNuevo} actualizada ✅ — ${cambios.length} cambio(s) propagado(s)`, 'success')
    window.closeModal('modal-editar-venta')
    _evModoVista = true
    await renderVentas(true)
  } catch (error) {
    console.error('Error en guardarEdicionVenta:', error)
    showToast('Error al actualizar la venta: ' + error.message, 'danger')
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Guardar y propagar cambios' }
  }
}

export function _setEv(id, txt) { const el = document.getElementById(id); if (el) el.textContent = txt }
export function _valEv(id, v)   { const el = document.getElementById(id); if (el) el.value = v }
