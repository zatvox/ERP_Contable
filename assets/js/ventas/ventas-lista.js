// ============================================================================
// ventas/ventas-lista.js — parte de ventas.js (reorganizado 2026-09-25, sin cambios de lógica)
// Mapa completo de funciones: Claude outputs/glosario_funciones_erp.md
// ============================================================================
import { registrarColumnas, colStyle } from '../col-menu.js'
import { getLoteById, updateLote, getVentas, getVentaById, deleteVenta, getDetalleVentas, getCuentasCobrarByVenta, deleteCuentaCobrar, getCobrosByCxC, deleteCobro, ultimoErrorDelete, getStockUbicacionesByLote, addStockUbicacion, updateStockUbicacion, getKardexByVenta, deleteKardexMovimiento, getGuiasDespachoVenta, getTodosVentasAnticiposAplicados } from '../supabase-data.js'
import { showToast, formatNumber } from '../helpers.js'
import { menuAccionesFila } from '../main.js'
import { estaAnulado, badgeAnulado, ESTILO_FILA_ANULADA } from '../anulacion.js'
import { esNota, signoDocumento, badgeTipoDocumento } from '../notas.js'
import { _nombreCliente, _nombreVendedor } from './helpers.js'
import { _ventaRevertidaPorNC, _guiaEstaVigente } from './ventas-editar.js'
import { getSeries } from '../series.js'

// ============================================================================
// TAB: VENTAS (Facturas / Boletas + NUBEFACT CPE)
// ============================================================================

export let _ventasListaEnriquecida = null // cache: [{v, cliente, vendedor}]
let _ventasSort = { col: null, dir: 'asc' } // orden por columna (click en header), mismo patrón que compras.js

// Comparador genérico: números se comparan numéricamente, todo lo demás
// como texto (localeCompare 'es' con soporte numérico para que "2" < "10").
export function _compararValoresOrdenVentas(a, b) {
  if (a == null && b == null) return 0
  if (a == null) return -1
  if (b == null) return 1
  if (typeof a === 'number' && typeof b === 'number') return a - b
  return String(a).localeCompare(String(b), 'es', { numeric: true, sensitivity: 'base' })
}

function _flechaOrdenVentas(campo) {
  if (_ventasSort.col !== campo) return ''
  return _ventasSort.dir === 'asc' ? ' ▲' : ' ▼'
}

registrarColumnas('ventas', [
  { key: 'sel',         label: 'Seleccionar' },
  { key: 'comprobante', label: 'N° Comprobante' },
  { key: 'tipo',        label: 'Tipo' },
  { key: 'cliente',     label: 'Cliente' },
  { key: 'vendedor',    label: 'Vendedor' },
  { key: 'fecha',       label: 'Fecha' },
  { key: 'moneda',      label: 'Moneda' },
  { key: 'base',        label: 'Base Imp.' },
  { key: 'igv',         label: 'IGV' },
  { key: 'total',       label: 'Total' },
  { key: 'cpe',         label: 'CPE' },
  { key: 'despacho',    label: 'Guía de despacho' },
  { key: 'acciones',    label: 'Acciones' }
])

function _thOrdenableVentas(label, campo) {
  const oculto = colStyle('ventas', campo) !== ''
  return `<th data-col-tabla="ventas" data-col="${campo}" style="cursor:pointer; user-select:none;${oculto ? ' display:none;' : ''}" onclick="window.ordenarVentas('${campo}')" title="Ordenar por ${label}">${label}${_flechaOrdenVentas(campo)}</th>`
}

function _valorOrdenVenta({ v, cliente, vendedor }, campo) {
  switch (campo) {
    case 'comprobante': return `${v.serie || ''}-${String(v.correlativo || '').padStart(8, '0')}`
    case 'tipo':         return v.tipo_comprobante || ''
    case 'cliente':      return cliente || ''
    case 'vendedor':     return vendedor || ''
    case 'fecha':        return v.fecha_emision || ''
    case 'moneda':       return v.moneda || ''
    case 'base':         return parseFloat(v.base_imponible) || 0
    case 'igv':          return parseFloat(v.igv) || 0
    case 'total':        return parseFloat(v.total) || 0
    case 'cpe':          return v.cpe_estado || ''
    case 'despacho':     return _ORDEN_DESPACHO[_estadoDespachoVenta(v)] ?? 9
    default: return ''
  }
}

window.ordenarVentas = function (campo) {
  if (_ventasSort.col === campo) {
    _ventasSort.dir = _ventasSort.dir === 'asc' ? 'desc' : 'asc'
  } else {
    _ventasSort.col = campo
    _ventasSort.dir = 'asc'
  }
  _pintarFilasVentas()
}

// El shell (header + input de búsqueda) se crea UNA sola vez; filtrar solo
// reescribe el <tbody> de #tabla-ventas-body, para no destruir el <input>
// en cada tecla (perdía el foco/cursor si se regeneraba todo el bloque).
// Suma aplicada por cada venta tipo_venta='anticipo' — para el badge
// "Aplicado X de Y" junto al tipo de comprobante. Se recarga junto con la
// lista principal (mismo patrón que aplicadoPorAnticipoCompra en compras.js).
let _aplicadoPorAnticipoVentaCache = new Map()

// ── Columna "Guía de despacho" (2026-09-28) ─────────────────────────────────
// Estado = ventas.estado_despacho (lo recalcula _recalcularEstadoDespachoVenta
// al emitir/editar/anular guías). Solo aplica a Factura/Boleta de mercadería
// vigentes: NC/ND, anticipos y anuladas no se despachan → 'na' (—).
// Debajo se listan los N° de las guías VIGENTES de esa venta.
let _guiasPorVentaCache = new Map() // venta_id -> ['T001-00000743', ...]
let _seriesNoCPE = new Set()        // 'tipo|serie' de series físicas (es_cpe=false): no se envían a NUBEFACT
const _ORDEN_DESPACHO = { pendiente: 0, parcial: 1, despachado: 2, na: 3 }

function _estadoDespachoVenta(v) {
  if (estaAnulado(v) || esNota(v.tipo_comprobante) || v.tipo_venta === 'anticipo') return 'na'
  return v.estado_despacho || 'pendiente'
}

function _badgeDespachoVenta(v) {
  const est = _estadoDespachoVenta(v)
  if (est === 'na') return '<span style="color:var(--text-secondary);">—</span>'
  const badge = est === 'despachado' ? '<span class="badge badge-success">Despachado</span>'
    : est === 'parcial' ? '<span class="badge badge-warning">Parcial</span>'
    : '<span class="badge badge-danger">Pendiente</span>'
  const guias = _guiasPorVentaCache.get(v.id) || []
  return badge + (guias.length ? `<br><small style="color:var(--text-secondary);">${guias.join('<br>')}</small>` : '')
}

export async function renderVentas(forzar = false) {
  try {
    const container = document.getElementById('content-ventas')
    if (!container) return

    if (!_ventasListaEnriquecida || forzar) {
      const [ventas, anticiposAplicadosTodos, guiasDespacho] = await Promise.all([getVentas(), getTodosVentasAnticiposAplicados(), getGuiasDespachoVenta(true)])
      _guiasPorVentaCache = new Map()
      try { _seriesNoCPE = new Set((await getSeries(true)).filter(s => s.es_cpe === false).map(s => `${s.tipo_comprobante || s.tipo_documento}|${s.serie}`)) } catch { _seriesNoCPE = new Set() }
      for (const g of (guiasDespacho || []).filter(_guiaEstaVigente).sort((a, b) => a.id - b.id)) {
        if (!_guiasPorVentaCache.has(g.venta_id)) _guiasPorVentaCache.set(g.venta_id, [])
        _guiasPorVentaCache.get(g.venta_id).push(g.numero_guia)
      }
      _aplicadoPorAnticipoVentaCache = new Map()
      for (const a of (anticiposAplicadosTodos || [])) {
        _aplicadoPorAnticipoVentaCache.set(a.venta_anticipo_id, (_aplicadoPorAnticipoVentaCache.get(a.venta_anticipo_id) || 0) + (parseFloat(a.monto_aplicado) || 0))
      }
      const ventasOrdenadas = (ventas || []).sort((a, b) => b.id - a.id)
      _ventasListaEnriquecida = []
      for (const v of ventasOrdenadas) {
        const cliente = await _nombreCliente(v.contact_id)
        const vendedor = _nombreVendedor(v.vendedor_id)
        _ventasListaEnriquecida.push({ v, cliente, vendedor })
      }
    }

    if (!document.getElementById('buscarVenta')) {
      container.innerHTML = `
        <div class="col-menu card-corner-menu" id="ventasColMenu">
          <button type="button" class="card-menu-btn" onclick="window._colMenuToggle('ventas', 'ventasColMenu', 'ventasColMenuDropdown')" title="Elegir qué columnas mostrar">⋮</button>
          <div class="col-menu-dropdown" id="ventasColMenuDropdown"></div>
        </div>
        <div class="card-header" style="padding-right:34px;">
          <h3 class="card-title">Comprobantes de Venta</h3>
          <div style="display:flex; gap:8px;">
            <button id="btnEliminarVentasSeleccionadas" class="btn btn-danger btn-small" style="display:none;" onclick="window.eliminarVentasSeleccionadas()">🗑 Eliminar seleccionadas (0)</button>
            <button class="btn btn-secondary btn-small" onclick="window.abrirModalImportarVentas()">📥 Importar</button>
            <button class="btn btn-primary btn-small" onclick="window.abrirModalNuevaVenta()">+ Nueva Venta</button>
          </div>
        </div>
        <div style="padding:12px 16px; border-bottom:1px solid var(--border-color, #e0e0e0); display:flex; gap:12px; flex-wrap:wrap; align-items:center;">
          <input type="text" id="buscarVenta" placeholder="Buscar por comprobante, cliente, vendedor, moneda o tipo..." style="flex:1; min-width:260px; max-width:420px;" oninput="window.filtrarVentas()">
          <select id="filtroTipoComprobanteVentas" onchange="window.filtrarVentas()" style="max-width:180px;">
            <option value="">-- Todos los tipos --</option>
            <option value="01">Factura</option>
            <option value="03">Boleta</option>
            <option value="07">Nota de Crédito</option>
            <option value="08">Nota de Débito</option>
          </select>
          <select id="filtroAnuladasVentas" onchange="window.filtrarVentas()" style="max-width:210px;" title="Los comprobantes anulados se conservan pero no suman en reportes">
            <option value="activos" selected>Solo vigentes</option>
            <option value="todos">Vigentes y anulados</option>
            <option value="anulados">Solo anulados</option>
          </select>
          <select id="filtroDespachoVentas" onchange="window.filtrarVentas()" style="max-width:190px;" title="Estado de emisión de la guía de despacho">
            <option value="">Despacho: todos</option>
            <option value="pendiente">Pendiente</option>
            <option value="parcial">Parcial</option>
            <option value="despachado">Despachado</option>
            <option value="na">No aplica (NC/ND/anticipo)</option>
          </select>
        </div>
        <div class="table-container">
          <table>
            <thead>
              <tr>
                <th data-col-tabla="ventas" data-col="sel" style="width:32px;${colStyle('ventas','sel') ? 'display:none;' : ''}"><input type="checkbox" id="selAllVentas" onchange="window.toggleSeleccionTodasVentas(this.checked)" title="Seleccionar todas"></th>
                ${_thOrdenableVentas('N° Comprobante', 'comprobante')}
                ${_thOrdenableVentas('Tipo', 'tipo')}
                ${_thOrdenableVentas('Cliente', 'cliente')}
                ${_thOrdenableVentas('Vendedor', 'vendedor')}
                ${_thOrdenableVentas('Fecha', 'fecha')}
                ${_thOrdenableVentas('Moneda', 'moneda')}
                ${_thOrdenableVentas('Base Imp.', 'base')}
                ${_thOrdenableVentas('IGV', 'igv')}
                ${_thOrdenableVentas('Total', 'total')}
                ${_thOrdenableVentas('CPE', 'cpe')}
                ${_thOrdenableVentas('Guía', 'despacho')}
                <th data-col-tabla="ventas" data-col="acciones"${colStyle('ventas','acciones')}>Acciones</th>
              </tr>
            </thead>
            <tbody id="tabla-ventas-body"></tbody>
          </table>
        </div>
      `
    }

    _pintarFilasVentas()
  } catch (error) {
    console.error('renderVentas:', error)
    showToast('Error al cargar ventas', 'danger')
  }
}

/** Badge "💰 Anticipo — saldo X" / "💰 Aplicado íntegramente" para ventas
 * tipo_venta='anticipo' — espejo del badgeStock de compras.js. Vacío para
 * ventas de mercadería normales. */
function _badgeAnticipoVenta(v) {
  if (v.tipo_venta !== 'anticipo') return ''
  const aplicado = _aplicadoPorAnticipoVentaCache.get(v.id) || 0
  const total = parseFloat(v.total || 0)
  const saldo = parseFloat((total - aplicado).toFixed(2))
  return saldo <= 0.01
    ? '<br><span class="badge badge-success">💰 Aplicado íntegramente</span>'
    : `<br><span class="badge badge-warning" title="Aplicado ${aplicado.toFixed(2)} de ${total.toFixed(2)}">💰 Anticipo — saldo ${saldo.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>`
}

function _pintarFilasVentas() {
  const tbody = document.getElementById('tabla-ventas-body')
  if (!tbody) return

  const statusBadge = (v) => {
    // El estado de anulación manda sobre el estado CPE: una factura anulada
    // no debe verse como "CPE OK" aunque haya sido aceptada en su momento.
    if (estaAnulado(v)) return badgeAnulado(v)
    if (_seriesNoCPE.has(`${v.tipo_comprobante}|${v.serie}`)) return '<span class="badge badge-secondary" title="Serie física: no se envía a NUBEFACT">📄 Físico</span>'
    const cpe = v.cpe_estado
    if (cpe === 'aceptado')  return '<span class="badge badge-success">CPE OK</span>'
    if (cpe === 'rechazado') return '<span class="badge badge-danger">CPE Error</span>'
    if (cpe === 'enviando')  return '<span class="badge badge-info">Enviando</span>'
    if (cpe === 'baja')      return '<span class="badge badge-secondary">Baja</span>'
    return '<span class="badge badge-secondary">Sin enviar</span>'
  }

  const busqueda = (document.getElementById('buscarVenta')?.value || '').trim().toLowerCase()
  const modoAnul = document.getElementById('filtroAnuladasVentas')?.value || 'activos'
  const fTipo = document.getElementById('filtroTipoComprobanteVentas')?.value || ''
  const fDesp = document.getElementById('filtroDespachoVentas')?.value || ''

  let listaFiltrada = (_ventasListaEnriquecida || []).filter(({ v }) => {
    const anul = estaAnulado(v)
    if (modoAnul === 'activos'  && anul) return false
    if (modoAnul === 'anulados' && !anul) return false
    if (fTipo && String(v.tipo_comprobante) !== fTipo) return false
    if (fDesp && _estadoDespachoVenta(v) !== fDesp) return false
    return true
  })

  if (busqueda) {
    listaFiltrada = listaFiltrada.filter(({ v, cliente, vendedor }) => {
      const comprobante = `${v.serie || ''}-${String(v.correlativo || '').padStart(8, '0')}`
      return `${comprobante} ${cliente || ''} ${vendedor || ''} ${v.moneda || ''} ${v.tipo_comprobante || ''}`
        .toLowerCase().includes(busqueda)
    })
  }

  if (_ventasSort.col) {
    listaFiltrada.sort((a, b) => {
      const cmp = _compararValoresOrdenVentas(_valorOrdenVenta(a, _ventasSort.col), _valorOrdenVenta(b, _ventasSort.col))
      return _ventasSort.dir === 'asc' ? cmp : -cmp
    })
  }

  if (listaFiltrada.length === 0) {
    tbody.innerHTML = `<tr><td colspan="13" style="text-align:center;">${busqueda ? 'Sin resultados para la búsqueda' : (modoAnul === 'anulados' ? 'No hay comprobantes anulados' : 'Sin ventas registradas')}</td></tr>`
    return
  }

  let html = ''
  for (const { v, cliente, vendedor } of listaFiltrada) {
    // Las notas de crédito se muestran en negativo (y en rojo) para que la
    // columna Total se pueda leer como una suma: es lo que espera el contador.
    const signo = signoDocumento(v.tipo_comprobante)
    const bi  = parseFloat(v.base_imponible || 0) * signo
    const igv = parseFloat(v.igv || 0) * signo
    const tot = parseFloat(v.total || 0) * signo
    const estiloMonto = signo < 0 ? ' color:var(--color-danger);' : ''
    const aceptado  = v.cpe_estado === 'aceptado'
    const anulada   = estaAnulado(v)
    const revertida = !anulada && _ventaRevertidaPorNC(v)

    html += `<tr${anulada ? ` style="${ESTILO_FILA_ANULADA}"` : ''}>
      <td data-col-tabla="ventas" data-col="sel"${colStyle('ventas','sel')}>${aceptado || anulada
        ? `<input type="checkbox" disabled title="${anulada ? 'Comprobante anulado' : 'No se puede eliminar: CPE aceptado por SUNAT'}">`
        : `<input type="checkbox" class="venta-sel" value="${v.id}" onchange="window.actualizarBotonEliminarVentasSeleccionadas()">`}</td>
      <td data-col-tabla="ventas" data-col="comprobante"${colStyle('ventas','comprobante')}><strong>${v.serie || ''}-${String(v.correlativo || '').padStart(8,'0')}</strong></td>
      <td data-col-tabla="ventas" data-col="tipo"${colStyle('ventas','tipo')}>${badgeTipoDocumento(v.tipo_comprobante)}${v.venta_referencia_id ? `<br><small style="color:var(--text-secondary);">ref. ${v.doc_referencia_serie || ''}-${String(v.doc_referencia_numero || '').padStart(8,'0')}</small>` : ''}${_badgeAnticipoVenta(v)}</td>
      <td data-col-tabla="ventas" data-col="cliente"${colStyle('ventas','cliente')}>${cliente}</td>
      <td data-col-tabla="ventas" data-col="vendedor"${colStyle('ventas','vendedor')}>${vendedor}</td>
      <td data-col-tabla="ventas" data-col="fecha"${colStyle('ventas','fecha')}>${v.fecha_emision || '-'}</td>
      <td data-col-tabla="ventas" data-col="moneda"${colStyle('ventas','moneda')}>${v.moneda || 'PEN'}</td>
      <td data-col-tabla="ventas" data-col="base" style="text-align:right;${estiloMonto}${colStyle('ventas','base') ? ' display:none;' : ''}">${formatNumber(bi)}</td>
      <td data-col-tabla="ventas" data-col="igv" style="text-align:right;${estiloMonto}${colStyle('ventas','igv') ? ' display:none;' : ''}">${formatNumber(igv)}</td>
      <td data-col-tabla="ventas" data-col="total" style="text-align:right; font-weight:bold;${estiloMonto}${colStyle('ventas','total') ? ' display:none;' : ''}">${formatNumber(tot)}</td>
      <td data-col-tabla="ventas" data-col="cpe"${colStyle('ventas','cpe')}>${statusBadge(v)}${revertida ? ` <span class="badge badge-warning" title="Sus Notas de Crédito ya cubrieron el 100% del importe — sigue aceptado en SUNAT, no está anulado">REVERTIDO</span>` : ''}</td>
      <td data-col-tabla="ventas" data-col="despacho"${colStyle('ventas','despacho')}>${_badgeDespachoVenta(v)}</td>
      <td data-col-tabla="ventas" data-col="acciones" class="col-acciones" style="text-decoration:none; opacity:1;${colStyle('ventas','acciones') ? ' display:none;' : ''}">
        ${menuAccionesFila([
          esNota(v.tipo_comprobante) && { label: 'Ver detalle', icono: '📋', onclick: `window.verDetalleNotaVenta(${v.id})` },
          ...(anulada
            ? [
                { label: 'Ver motivo de anulación', icono: 'ℹ️', onclick: `window.verMotivoAnulacion('venta', ${v.id})` }
              ]
            : [
                (!v.cpe_estado || v.cpe_estado === 'no_enviado') && !_seriesNoCPE.has(`${v.tipo_comprobante}|${v.serie}`) && (esNota(v.tipo_comprobante)
                  ? { label: 'Emitir Nota (SUNAT)', icono: '📤', onclick: `window.emitirNotaVenta(${v.id})` }
                  : { label: 'Emitir CPE', icono: '📤', onclick: `window.emitirCPEVenta(${v.id})` }),
                v.nubefact_enlace && { label: 'Ver PDF', icono: '📄', href: v.nubefact_enlace },
                !v.asiento_id && { label: 'Generar asiento', icono: '📑', onclick: `window.generarAsientoDeVenta(${v.id})` },
                !esNota(v.tipo_comprobante) && { label: 'Ver detalle', icono: '📋', onclick: `window.editarVenta(${v.id})` },
                { separador: true },
                { label: 'Nota de Crédito', icono: '↩️', onclick: `window.abrirModalNotaCredito(${v.id})` },
                { label: 'Nota de Débito', icono: '↪️', onclick: `window.abrirModalNotaDebito(${v.id})` },
                { separador: true },
                { label: 'Anular comprobante', icono: '🚫', onclick: `window.anularVenta(${v.id})`, peligro: true },
                { label: 'Eliminar', icono: '🗑️', onclick: `window.eliminarVenta(${v.id})`, peligro: true }
              ])
        ])}
      </td>
    </tr>`
  }
  tbody.innerHTML = html
}

window.filtrarVentas = function () {
  _pintarFilasVentas()
}

// ─── Eliminar Venta ───────────────────────────────────────────────────────────
// Orden correcto para eliminar una venta sin descuadrar Inventario/CxC:
//   1) Si el comprobante ya fue ACEPTADO por NUBEFACT/SUNAT (cpe_estado ===
//      'aceptado'), NO se puede simplemente borrar: legalmente hay que anular
//      con una Nota de Crédito. Se bloquea el borrado.
//   2) Si la CxC de esta venta ya tiene algo cobrado (monto_cobrado > 0), se
//      bloquea: primero hay que revertir/anular ese cobro en Cobranzas.
//   3) Si pasa ambas validaciones: se devuelve el stock. Se usa el Kardex
//      ('salida' con venta_id) como fuente PRECISA, porque ahí sí queda un
//      movimiento por cada lote+zona realmente tocado — a diferencia de
//      detalle_ventas, que solo guarda UN lote_id "representativo" por
//      línea (el primer lote FIFO) con la cantidad total de la línea. Si
//      una línea consumió 2 lotes, revertir solo por detalle_ventas le
//      devolvía TODO al primer lote y dejaba el segundo con menos stock
//      del real, y luego eliminarGuia/eliminarCompra fallaba con un falso
//      "ya hay ventas" sobre ese segundo lote. Solo se cae al método
//      antiguo (detalle_ventas) si la venta es de antes de que existiera
//      el Kardex y no tiene movimientos que revertir.
// Devuelve cantidad+unidades a un lote y, si aplica, a la fila específica de
// stock_ubicaciones de esa zona (se recrea si ya no existe). Compartida por
// _eliminarVentaCore y por eliminarGuiaDespachoVenta (ambos revierten stock
// consumido por una salida de venta).
export async function _devolverAUnaZona(loteId, ubicacionId, cantidad, unidades = 0) {
  if (!loteId || !cantidad) return
  const lote = await getLoteById(loteId)
  if (!lote) return
  await updateLote(loteId, {
    cantidad: parseFloat(((parseFloat(lote.cantidad) || 0) + cantidad).toFixed(4)),
    cantidad_unidades: parseFloat(((parseFloat(lote.cantidad_unidades) || 0) + (unidades || 0)).toFixed(4))
  })
  if (!ubicacionId) return
  const filasLote = await getStockUbicacionesByLote(loteId)
  const filaZona = (filasLote || []).find(f => f.ubicacion_id === ubicacionId)
  if (filaZona) {
    await updateStockUbicacion(filaZona.id, {
      cantidad: parseFloat(((parseFloat(filaZona.cantidad) || 0) + cantidad).toFixed(4)),
      cantidad_unidades: parseFloat(((parseFloat(filaZona.cantidad_unidades) || 0) + (unidades || 0)).toFixed(4))
    })
  } else {
    await addStockUbicacion({ lote_id: loteId, ubicacion_id: ubicacionId, cantidad, cantidad_unidades: unidades || 0 })
  }
}

// Lógica núcleo de reversión (sin confirm() ni toasts) — la usan tanto
// eliminarVenta (una sola, con confirm) como eliminarVentasSeleccionadas
// (varias, con un solo confirm para todo el lote). Lanza Error con un
// mensaje claro si no se puede eliminar (CPE aceptado, CxC cobrada, etc).
async function _eliminarVentaCore(id) {
  const venta = await getVentaById(id)
  if (!venta) throw new Error('No se encontró la venta')

  const numeroVenta = `${venta.serie || ''}-${String(venta.correlativo || '').padStart(8, '0')}`

  if (venta.cpe_estado === 'aceptado') {
    throw new Error(`${numeroVenta}: ya fue aceptado por SUNAT/NUBEFACT, debe anularse con Nota de Crédito`)
  }

  const cxcs = await getCuentasCobrarByVenta(id)
  // Se revisa cobrado Y retenido: una retención de IGV salda parte de la CxC
  // sin que entre efectivo, así que monto_cobrado puede seguir en 0 y aun así
  // haber movimiento aplicado que no se puede borrar en silencio.
  const cxcCobrada = (cxcs || []).find(c =>
    (parseFloat(c.monto_cobrado) || 0) > 0 || (parseFloat(c.monto_retenido) || 0) > 0)
  if (cxcCobrada) {
    throw new Error(`${numeroVenta}: ya tiene un cobro o retención registrada en Cuentas por Cobrar, revierte ese movimiento primero`)
  }

  // Notas de crédito/débito que apuntan a esta venta: `ventas.venta_referencia_id`
  // es una FK a la propia tabla, así que borrar la venta original con notas
  // vivas falla por restricción de clave foránea (error 23503 → 409 en la API).
  const notasDeEstaVenta = (await getVentas() || []).filter(v => v.venta_referencia_id === id)
  if (notasDeEstaVenta.length > 0) {
    const nums = notasDeEstaVenta.map(n => `${n.serie || ''}-${String(n.correlativo || '').padStart(8, '0')}`).join(', ')
    throw new Error(`${numeroVenta}: tiene ${notasDeEstaVenta.length} nota(s) de crédito/débito (${nums}). Elimínalas primero.`)
  }

  // No se puede borrar una venta que ya tiene guía(s) de despacho: primero
  // hay que borrar las guías (eso sí revierte su stock/kardex), recién
  // entonces la venta queda libre para eliminarse.
  const todasGuias = await getGuiasDespachoVenta()
  const guiasVenta = (todasGuias || []).filter(g => g.venta_id === id)
  if (guiasVenta.length > 0) {
    const numeros = guiasVenta.map(g => g.numero_guia).join(', ')
    throw new Error(`${numeroVenta}: tiene ${guiasVenta.length} guía(s) de despacho (${numeros}). Elimina primero esa(s) guía(s) antes de borrar la venta.`)
  }

  const detalles = await getDetalleVentas(id)
  const kardexVenta = await getKardexByVenta(id)
  const salidasKardex = (kardexVenta || []).filter(k => k.tipo_movimiento === 'salida' && k.lote_id)

  if (salidasKardex.length > 0) {
    // Fuente precisa: un movimiento de kardex por cada lote+zona
    // realmente consumido por esta venta.
    for (const k of salidasKardex) {
      await _devolverAUnaZona(k.lote_id, k.ubicacion_origen_id, parseFloat(k.cantidad_salida) || 0, parseFloat(k.cantidad_unidades_salida) || 0)
    }
  } else {
    // Fallback para ventas de antes del Kardex (sin movimientos que
    // revertir): usa detalle_ventas.lote_id, best-effort si una línea
    // consumió más de un lote por FIFO.
    for (const d of (detalles || [])) {
      await _devolverAUnaZona(d.lote_id, d.ubicacion_id, parseFloat(d.cantidad) || 0, parseFloat(d.cantidad_unidades) || 0)
    }
  }

  for (const c of (cxcs || [])) {
    // `cobros.cxc_id` referencia la cuenta por cobrar: si quedara algún cobro
    // (aunque sea de monto 0), el DELETE de la CxC fallaría por FK.
    const cobrosCxC = await getCobrosByCxC(c.id)
    for (const cb of (cobrosCxC || [])) await deleteCobro(cb.id)
    await deleteCuentaCobrar(c.id)
  }

  // Kardex: se borran las filas 'salida' que generó esta venta (aún en
  // pruebas — sin esto quedarían movimientos de una venta ya borrada).
  // deleteRecord() puede devolver false sin lanzar excepción (ver
  // supabase-client.js) — si no se valida, el kardex queda huérfano y la
  // venta se borra igual, descuadrando el reporte de Kardex en silencio
  // (caso real: guía T001-00000464, fila kardex #394 nunca se eliminó).
  for (const k of (kardexVenta || [])) {
    const okKardex = await deleteKardexMovimiento(k.id)
    if (!okKardex) {
      const motivo = ultimoErrorDelete()
      throw new Error(`No se pudo eliminar el movimiento de Kardex #${k.id}: ${motivo?.mensaje || 'motivo desconocido'}. Se detiene el borrado para no dejar el Kardex descuadrado.`)
    }
  }

  const ok = await deleteVenta(id)
  if (!ok) {
    const motivo = ultimoErrorDelete()
    throw new Error(
      `${numeroVenta}: no se pudo eliminar — ${motivo?.mensaje || 'error desconocido'} ` +
      `Si no quieres perder el rastro del documento, anúlala en vez de eliminarla.`
    )
  }

  return numeroVenta
}

window.eliminarVenta = async function (id) {
  try {
    const venta = await getVentaById(id)
    if (!venta) { showToast('No se encontró la venta', 'danger'); return }

    if (!confirm(
      `Se eliminará la venta ${venta.serie || ''}-${String(venta.correlativo || '').padStart(8,'0')}, ` +
      `su detalle y se devolverá el stock a Inventario. ¿Continuar?`
    )) return

    const numeroVenta = await _eliminarVentaCore(id)
    showToast(`Venta ${numeroVenta} eliminada: stock devuelto a Inventario`, 'success')
    await renderVentas(true)
  } catch (error) {
    console.error('Error en eliminarVenta:', error)
    showToast(error.message || 'Error al eliminar la venta', 'danger')
  }
}

// ─── Eliminación masiva (checkbox) ───────────────────────────────────────────
// Reusa _eliminarVentaCore por cada id marcado, un solo confirm() para todo
// el lote, y un resumen al final (cuántas se borraron / cuántas fallaron y
// por qué) en vez de un toast por fila.
window.toggleSeleccionTodasVentas = function (checked) {
  document.querySelectorAll('.venta-sel:not(:disabled)').forEach(cb => { cb.checked = checked })
  window.actualizarBotonEliminarVentasSeleccionadas()
}

window.actualizarBotonEliminarVentasSeleccionadas = function () {
  const seleccionadas = document.querySelectorAll('.venta-sel:checked').length
  const btn = document.getElementById('btnEliminarVentasSeleccionadas')
  if (!btn) return
  btn.style.display = seleccionadas > 0 ? 'inline-flex' : 'none'
  btn.textContent = `🗑 Eliminar seleccionadas (${seleccionadas})`
}

window.eliminarVentasSeleccionadas = async function () {
  const ids = Array.from(document.querySelectorAll('.venta-sel:checked')).map(cb => parseInt(cb.value))
  if (ids.length === 0) { showToast('Selecciona al menos una venta', 'warning'); return }

  if (!confirm(
    `Se eliminarán ${ids.length} venta(s), su detalle, y se devolverá el stock (kg y unidades) a Inventario. ` +
    `Esta acción no se puede deshacer. ¿Continuar?`
  )) return

  const btn = document.getElementById('btnEliminarVentasSeleccionadas')
  if (btn) { btn.disabled = true; btn.textContent = 'Eliminando...' }

  let ok = 0
  const errores = []
  for (const id of ids) {
    try {
      await _eliminarVentaCore(id)
      ok++
    } catch (error) {
      console.error(`Error eliminando venta ${id}:`, error)
      errores.push(error.message || `Venta #${id}: error inesperado`)
    }
  }

  if (ok > 0) showToast(`${ok} venta(s) eliminada(s): stock devuelto a Inventario`, 'success')
  if (errores.length > 0) {
    showToast(`${errores.length} venta(s) no se pudieron eliminar: ${errores.join(' | ')}`, 'danger')
  }

  if (btn) { btn.disabled = false }
  await renderVentas(true)
}
