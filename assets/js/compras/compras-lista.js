// ============================================================================
// compras/compras-lista.js — parte de compras.js (reorganizado 2026-09-25, sin cambios de lógica)
// Mapa completo de funciones: Claude outputs/glosario_funciones_erp.md
// ============================================================================
import { S } from './state.js'
import { registrarColumnas, colStyle } from '../col-menu.js'
import { getCompras, deleteCompra, getCompraDetalles, getLotesByCompraId, deleteLote, getItems, getItemById, getGuiasIngresoCompra, deleteGuiaIngresoCompra, getDetalleGuiasIngresoCompra, getKardexByCompra, deleteKardexMovimiento, getTipoDocumentosMap, getNombreTipoDocumentoSync, getCuentasPagarByCompra, deleteCuentaPagar, getTodosComprasAnticiposAplicados, getPagosProveedoresByCompra, getPagosProveedoresByCxP, deletePagoProveedor, ultimoErrorDelete } from '../supabase-data.js'
import { showToast, formatNumber } from '../helpers.js'
import { menuAccionesFila } from '../main.js'
import { estaAnulado, badgeAnulado, ESTILO_FILA_ANULADA } from '../anulacion.js'
import { esNota, signoDocumento, badgeTipoDocumento } from '../notas.js'
import { getModuloConfig } from '../config-modulo.js'
import { _invalidarCacheCompras } from './anulacion.js'
import { _aplicarModoVistaEdicionCompra, _pintarLineasEdicionCompra } from './compras-editar.js'
import { _cargarComprasConGuia } from './guias-ingreso-lista.js'

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

registrarColumnas('compras', [
  { key: 'sel',          label: 'Seleccionar' },
  { key: 'id',           label: 'Id' },
  { key: 'proveedor',    label: 'Proveedor' },
  { key: 'fecha',        label: 'Fecha Emisión' },
  { key: 'comprobante',  label: 'Comprobante' },
  { key: 'referencia',   label: 'Referencia' },
  { key: 'descripcion',  label: 'Descripción' },
  { key: 'periodo',      label: 'Periodo' },
  { key: 'tipo',         label: 'Tipo Documento' },
  { key: 'total',        label: 'Total' },
  { key: 'estado_pago',  label: 'Estado Pago' },
  { key: 'stock',        label: 'Stock' },
  { key: 'acciones',     label: 'Acciones' }
])

registrarColumnas('guias-ingreso', [
  { key: 'sel',          label: 'Seleccionar' },
  { key: 'numero_guia',  label: 'N° Guía' },
  { key: 'fecha',        label: 'Fecha' },
  { key: 'referencia',   label: 'Compra (Referencia)' },
  { key: 'proveedor',    label: 'Proveedor' },
  { key: 'num_productos', label: '# Productos' },
  { key: 'productos',    label: 'Producto(s) / Lote(s)' },
  { key: 'marcas',       label: 'Marca(s)' },
  { key: 'zonas',        label: 'Almacén / Zona(s)' },
  { key: 'observaciones', label: 'Observaciones' },
  { key: 'estado',       label: 'Estado' },
  { key: 'acciones',     label: 'Acciones' }
])

// ─── Orden por columna (tabs Compras y Guías) ────────────────────────────────
// Comparador genérico: números se comparan numéricamente, todo lo demás como
// texto (localeCompare 'es' con soporte numérico para que "2" < "10").
export function _compararValoresOrden(a, b) {
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

// `tabla`/`colKey` son opcionales: si se pasan, el <th> queda enganchado al
// menú "⋮" de columnas de esa tabla (ver col-menu.js) — colKey por defecto
// es el mismo `campo` de orden, se puede pisar cuando difieren (ej. columna
// de orden 'fecha_emision' pero clave de columna 'fecha').
export function _thOrdenable(label, campo, sortState, funcOrdenar, tabla, colKey) {
  const oculta = tabla ? colStyle(tabla, colKey || campo) !== '' : false
  const attrsCol = tabla ? ` data-col-tabla="${tabla}" data-col="${colKey || campo}"` : ''
  const style = `cursor:pointer; user-select:none;${oculta ? ' display:none;' : ''}`
  return `<th${attrsCol} style="${style}" onclick="window.${funcOrdenar}('${campo}')" title="Ordenar por ${label}">${label}${_flechaOrden(sortState, campo)}</th>`
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

export async function renderCompras(forzar = false) {
  try {
    const container = document.getElementById('tabla-compras')
    if (!container) return

    const [, comprasConGuia, anticiposAplicadosTodos] = await Promise.all([
      getTipoDocumentosMap(),         // cacheado; garantiza nombres de tipo doc en carga lazy
      _cargarComprasConGuia(),
      getTodosComprasAnticiposAplicados()
    ])
    // Suma aplicada por cada compra tipo_compra='anticipo' — para el badge
    // "Aplicado X de Y" en la columna Stock.
    const aplicadoPorAnticipoCompra = new Map()
    for (const a of (anticiposAplicadosTodos || [])) {
      aplicadoPorAnticipoCompra.set(a.compra_anticipo_id, (aplicadoPorAnticipoCompra.get(a.compra_anticipo_id) || 0) + (parseFloat(a.monto_aplicado) || 0))
    }

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
            <th data-col-tabla="compras" data-col="sel" style="width:32px;${colStyle('compras','sel') ? 'display:none;' : ''}"><input type="checkbox" id="selAllCompras" onchange="window.toggleSeleccionTodasCompras(this.checked)" title="Seleccionar todas"></th>
            ${_thOrdenable('Id', 'id', _compSort, 'ordenarCompras', 'compras')}
            ${_thOrdenable('Proveedor', 'proveedor', _compSort, 'ordenarCompras', 'compras')}
            ${_thOrdenable('Fecha Emisión', 'fecha_emision', _compSort, 'ordenarCompras', 'compras', 'fecha')}
            ${_thOrdenable('Comprobante', 'comprobante', _compSort, 'ordenarCompras', 'compras')}
            ${_thOrdenable('Referencia', 'referencia', _compSort, 'ordenarCompras', 'compras')}
            ${_thOrdenable('Descripcion', 'descripcion', _compSort, 'ordenarCompras', 'compras')}
            ${_thOrdenable('Periodo', 'periodo', _compSort, 'ordenarCompras', 'compras')}
            ${_thOrdenable('Tipo Documento', 'tipo_comprobante', _compSort, 'ordenarCompras', 'compras', 'tipo')}
            ${_thOrdenable('Total', 'total', _compSort, 'ordenarCompras', 'compras')}
            ${_thOrdenable('Estado Pago', 'estado_pago', _compSort, 'ordenarCompras', 'compras')}
            <th data-col-tabla="compras" data-col="stock"${colStyle('compras','stock')}>Stock</th>
            <th data-col-tabla="compras" data-col="acciones"${colStyle('compras','acciones')}>Acciones</th>
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
      const badgeStock = c.tipo_compra === 'anticipo'
        ? (() => {
            const aplicado = aplicadoPorAnticipoCompra.get(c.id) || 0
            const total = parseFloat(c.total || 0)
            const saldo = parseFloat((total - aplicado).toFixed(2))
            return saldo <= 0.01
              ? '<span class="badge badge-success">💰 Aplicado íntegramente</span>'
              : `<span class="badge badge-warning" title="Aplicado ${aplicado.toFixed(2)} de ${total.toFixed(2)}">💰 Anticipo — saldo ${saldo.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>`
          })()
        : c.tipo_compra !== 'mercaderia'
        ? '<span class="badge badge-secondary">N/A (servicio)</span>'
        : (tieneGuia
            ? '<span class="badge badge-success">✓ Con Guía</span>'
            : '<span class="badge badge-warning">⏳ Pendiente Guía</span>')

      const anulada = estaAnulado(c)

      html += `
        <tr${anulada ? ` style="${ESTILO_FILA_ANULADA}"` : ''}>
          <td data-col-tabla="compras" data-col="sel"${colStyle('compras','sel')}>${anulada
            ? `<input type="checkbox" disabled title="Comprobante anulado">`
            : `<input type="checkbox" class="compra-sel" value="${c.id}" onchange="window.actualizarBotonEliminarComprasSeleccionadas()">`}</td>
          <td data-col-tabla="compras" data-col="id"${colStyle('compras','id')}><strong>${c.id}</strong></td>
          <td data-col-tabla="compras" data-col="proveedor"${colStyle('compras','proveedor')}>${c.proveedor_nombre || '-'}</td>
          <td data-col-tabla="compras" data-col="fecha"${colStyle('compras','fecha')}>${c.fecha_emision || '-'}</td>
          <td data-col-tabla="compras" data-col="comprobante"${colStyle('compras','comprobante')}>${comprobante}</td>
          <td data-col-tabla="compras" data-col="referencia"${colStyle('compras','referencia')}>${referencia || '-'}</td>
          <td data-col-tabla="compras" data-col="descripcion"${colStyle('compras','descripcion')}>${c.descripcion || '-'}</td>
          <td data-col-tabla="compras" data-col="periodo"${colStyle('compras','periodo')}>${periodo}</td>
          <td data-col-tabla="compras" data-col="tipo"${colStyle('compras','tipo')}>${esNota(c.tipo_comprobante)
                ? `${badgeTipoDocumento(c.tipo_comprobante)}${c.compra_referencia_id ? `<br><small style="color:var(--text-secondary);">ref. ${c.doc_referencia_serie || ''}-${c.doc_referencia_numero || ''}</small>` : ''}`
                : (c.tipo_comprobante ? `${c.tipo_comprobante} - ${getNombreTipoDocumentoSync(c.tipo_comprobante)}` : '-')}</td>
          <td data-col-tabla="compras" data-col="total"${colStyle('compras','total')}><strong style="${signoDocumento(c.tipo_comprobante) < 0 ? 'color:var(--color-danger);' : ''}">${formatNumber((parseFloat(c.total) || 0) * signoDocumento(c.tipo_comprobante))} ${c.currency || 'PEN'}</strong></td>
          <td data-col-tabla="compras" data-col="estado_pago"${colStyle('compras','estado_pago')}>${anulada ? badgeAnulado(c) : `<span class="badge badge-${badgePago}">${c.estado_pago || 'pendiente'}</span>`}</td>
          <td data-col-tabla="compras" data-col="stock"${colStyle('compras','stock')}>${anulada ? '<span class="badge badge-secondary">—</span>' : badgeStock}${c.adjunto_url ? ' <span title="Tiene documento adjunto">📎</span>' : ''}</td>
          <td data-col-tabla="compras" data-col="acciones" class="col-acciones" style="text-decoration:none; opacity:1;${colStyle('compras','acciones') ? ' display:none;' : ''}">
            ${menuAccionesFila(anulada
              ? [{ label: 'Ver motivo de anulación', icono: 'ℹ️', onclick: `window.verMotivoAnulacionCompra('compra', ${c.id})` }]
              : [
                  esNota(c.tipo_comprobante)
                    ? { label: 'Ver detalle', icono: '📋', onclick: `window.verDetalleNotaCompra(${c.id})` }
                    : { label: 'Ver detalle', icono: '📋', onclick: `window.editarCompra(${c.id})` },
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
    // El tbody se reconstruye entero en cada render: la selección anterior
    // ya no existe (checkboxes nuevos, todos sin marcar), así que el botón
    // de acción masiva debe volver a su estado oculto.
    window.actualizarBotonEliminarComprasSeleccionadas()
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

// ─── Editar Compra (cabecera + precio/IGV de línea si aún no hay guía procesada) ──
//
// Diferencia clave con "Editar Venta" en ventas.js: allá el precio se podía
// dejar editable sin drama porque la VENTA nunca mueve stock (solo la Guía
// de Despacho). Acá es al revés: es la GUÍA DE INGRESO la que crea el lote y
// graba su costo_unitario, que además ya puede haber alimentado el Kardex y
// mezclado costo con stock preexistente del mismo N° de lote (costeo
// promedio ponderado). Por eso el candado de precio es "¿ya tiene guía
// procesada?" en vez de "¿ya hay cobros/CPE aceptado?" — una vez que la
// guía corrió, el precio de la compra queda bloqueado: corregirlo ahí no
// movería el costo ya grabado en lotes/kardex.

/* _ecContexto: movido a compras/state.js (S._ecContexto) */   // { compra, detalles, cxp, guiasCompra, notas, bloqueos }
/* _ecModoVista: movido a compras/state.js (S._ecModoVista) */   // true = solo lectura (Ver Detalle), false = edición habilitada

window.editarCompra = async function (id) {
  try {
    const { getById } = await import('./supabase-client.js')
    const [c, detalles, cxps, guiasTodas, todasCompras, items] = await Promise.all([
      getById('compras', id),
      getCompraDetalles(id),
      getCuentasPagarByCompra(id),
      getGuiasIngresoCompra(),
      getCompras(),
      getItems()
    ])
    if (!c) { showToast('No se encontró la compra', 'danger'); return }

    const cxp = (cxps || [])[0] || null
    const guiasCompra = (guiasTodas || []).filter(g => g.compra_id === id)
    const notas = (todasCompras || []).filter(x => x.compra_referencia_id === id && !estaAnulado(x))
    const aplicado = parseFloat(cxp?.monto_pagado || 0)
    const itemsMap = {}
    for (const it of (items || [])) itemsMap[it.id] = it

    const bloqueos = {
      precios: guiasCompra.length > 0 || aplicado > 0.01 || notas.length > 0
    }
    S._ecContexto = { compra: c, detalles: detalles || [], cxp, guiasCompra, notas, aplicado, bloqueos, itemsMap }

    document.getElementById('ecId').value = c.id
    document.getElementById('ecReferencia').value = c.referencia || ''
    document.getElementById('ecFechaEmision').value = c.fecha_emision || ''
    document.getElementById('ecFechaRecepcion').value = c.fecha_recepcion || ''
    document.getElementById('ecNumeroComprobante').value = c.numero || ''
    document.getElementById('ecEstadoPago').value = c.estado_pago || 'pendiente'
    document.getElementById('ecMoneda').value = c.currency || 'PEN'
    document.getElementById('ecTipoCambio').value = c.tipo_cambio || 1

    S._ecModoVista = true
    _aplicarModoVistaEdicionCompra()
    _pintarLineasEdicionCompra()

    window.openModal('modal-editar-compra')
  } catch (error) {
    console.error('Error en editarCompra:', error)
    showToast('Error al abrir la compra para editar', 'danger')
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
    // deleteRecord() puede devolver false sin lanzar excepción — si no se
    // valida, el kardex queda huérfano y la compra se borra igual.
    const kardexCompra = await getKardexByCompra(id)
    for (const k of (kardexCompra || [])) {
      const okKardex = await deleteKardexMovimiento(k.id)
      if (!okKardex) {
        const motivo = ultimoErrorDelete()
        throw new Error(`No se pudo eliminar el movimiento de Kardex #${k.id}: ${motivo?.mensaje || 'motivo desconocido'}. Se detiene el borrado para no dejar el Kardex descuadrado.`)
      }
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
// SELECCIÓN MÚLTIPLE — checkbox por fila en la tabla de Compras (mismo
// patrón que Ventas: window.eliminarVentasSeleccionadas en ventas.js).
// ============================================================================

window.toggleSeleccionTodasCompras = function (checked) {
  document.querySelectorAll('.compra-sel:not(:disabled)').forEach(cb => { cb.checked = checked })
  window.actualizarBotonEliminarComprasSeleccionadas()
}

window.actualizarBotonEliminarComprasSeleccionadas = function () {
  const seleccionadas = document.querySelectorAll('.compra-sel:checked').length
  const btn = document.getElementById('btnEliminarComprasSeleccionadas')
  if (!btn) return
  btn.style.display = seleccionadas > 0 ? 'inline-flex' : 'none'
  btn.textContent = `🗑 Eliminar seleccionadas (${seleccionadas})`
}

// Reusa window.eliminarCompra por id — esa función YA trae sus propias
// validaciones y confirm() por compra (ventas pendientes, pagos aplicados,
// notas de crédito/débito, etc.), así que aquí solo se recorre la selección;
// no se duplica esa lógica de bloqueo.
window.eliminarComprasSeleccionadas = async function () {
  const ids = Array.from(document.querySelectorAll('.compra-sel:checked')).map(cb => parseInt(cb.value))
  if (ids.length === 0) { showToast('Selecciona al menos una compra', 'warning'); return }
  if (!confirm(`Vas a eliminar ${ids.length} compra(s). Cada una se validará individualmente (ventas, pagos o notas vinculadas la bloquearán). ¿Continuar?`)) return

  const btn = document.getElementById('btnEliminarComprasSeleccionadas')
  if (btn) { btn.disabled = true; btn.textContent = 'Eliminando...' }

  for (const id of ids) {
    await window.eliminarCompra(id)
  }

  if (btn) btn.disabled = false
}
