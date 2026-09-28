// ============================================================================
// inventario/resumen-stock.js — parte de inventario.js (reorganizado 2026-09-25, sin cambios de lógica)
// Mapa completo de funciones: Claude outputs/glosario_funciones_erp.md
// ============================================================================
import { colStyle } from '../col-menu.js'
import { getItems, getLotes, getCategorias, getStockUbicaciones } from '../supabase-data.js'
import { showToast } from '../helpers.js'
import { getModuloConfig } from '../config-modulo.js'
import { renderStockZonas } from './stock-zona.js'

// ============================================================================
// RESUMEN DE STOCK
// ============================================================================

function _poblarFiltroCategoriasResumen(categorias) {
  const sel = document.getElementById('filtroResumenCategoria')
  if (!sel || sel.options.length > 1) return
  categorias.forEach(c => {
    const opt = document.createElement('option')
    opt.value = c.id
    opt.textContent = c.nombre
    sel.appendChild(opt)
  })
}

// ============================================================================
// RESUMEN DE STOCK — tabla única con botón de agrupamiento
// ============================================================================
// Antes eran 2 subtabs con 2 tablas (renderResumenStock = por producto,
// renderStockZonas = por lote+zona), ambas ya sobre la misma fuente de
// verdad (stock_ubicaciones / kardex). Luis pidió fusionarlas en una sola
// tabla-vista con un botón que cambia el nivel de agrupamiento (2026-09-10).
// Las dos funciones de render se mantienen separadas por legibilidad, pero
// comparten contenedor ("tabla-resumen") y barra de filtros — el dispatcher
// de abajo decide cuál pintar según el modo activo.
window._resumenStockModo = 'general'

window.setModoResumenStock = async function (modo) {
  window._resumenStockModo = modo
  document.querySelectorAll('#resumenStockModoToggle .subtab').forEach(b => {
    b.classList.toggle('active', b.getAttribute('data-modo') === modo)
  })
  const zonaWrap = document.getElementById('filtroResumenZonaWrap')
  if (zonaWrap) zonaWrap.hidden = (modo !== 'zona')
  // Exportar Excel/PDF (con checkboxes) solo existe en "Por Ubicación" —
  // "General" no tiene columna de selección.
  const exportarWrap = document.getElementById('resumenStockExportarWrap')
  if (exportarWrap) exportarWrap.hidden = (modo !== 'zona')
  await window.renderResumenStockUnificado()
}

window.renderResumenStockUnificado = async function () {
  if (window._resumenStockModo === 'zona') {
    await renderStockZonas()
  } else {
    await renderResumenStock()
  }
}

// Disparador de los filtros compartidos (Buscar, Categoría, Stock Total,
// Zona) — se llama por nombre desde los oninput/onchange del HTML, así que
// tiene que existir en window pase lo que pase. Se perdió en la fusión del
// 10/09 (renderResumenStockUnificado la reemplazó pero nadie volvió a
// definir este nombre, que el HTML seguía llamando) — bug real, no de
// "tiempo real": cada tecla tiraba un TypeError y no llegaba a re-renderizar
// nada. Ver nota de auditoría más abajo para cómo se evita que se repita.
window.aplicarFiltrosResumenStock = async function () {
  await window.renderResumenStockUnificado()
}

// Texto de la columna "N° Lote" en el resumen por producto: si son pocos
// lotes los lista todos, si son muchos (ej. un producto con 78 lotes) corta
// a los primeros 2 y deja el resto en un title="" (tooltip al pasar el mouse)
// para no romper el ancho de la tabla.
function _formatearListaLotes(numeros, maxVisibles = 2) {
  if (!numeros || numeros.length === 0) return '-'
  if (numeros.length <= maxVisibles) return numeros.join(', ')
  const visibles = numeros.slice(0, maxVisibles).join(', ')
  return `<span title="${numeros.join(', ')}">${visibles} +${numeros.length - maxVisibles} más</span>`
}

// ============================================================================
// Orden asc/desc al hacer click en el encabezado — compartido entre los 2
// modos de Resumen de Stock (cada modo tiene su propia columna/dirección
// activa, porque no tienen las mismas columnas). 2026-09-10.
// ============================================================================
window._resumenStockOrden = {
  general: { col: null, dir: 'asc' },
  zona:    { col: null, dir: 'asc' }
}

window.ordenarResumenStock = async function (col) {
  const st = window._resumenStockOrden[window._resumenStockModo]
  if (st.col === col) {
    st.dir = st.dir === 'asc' ? 'desc' : 'asc'
  } else {
    st.col = col
    st.dir = 'asc'
  }
  await window.renderResumenStockUnificado()
}

// Aplica en sitio el orden activo sobre un array de "filas" ya calculadas,
// según un mapa { columna: fila => valorComparable }. No hace nada si no hay
// columna de orden elegida todavía (se deja el orden natural de cada modo).
export function _aplicarOrdenFilas(filas, estado, extractores) {
  if (!estado.col || !extractores[estado.col]) return
  const get = extractores[estado.col]
  const factor = estado.dir === 'desc' ? -1 : 1
  filas.sort((a, b) => {
    const va = get(a)
    const vb = get(b)
    const cmp = (typeof va === 'string' || typeof vb === 'string')
      ? String(va ?? '').localeCompare(String(vb ?? ''), 'es', { numeric: true, sensitivity: 'base' })
      : (va || 0) - (vb || 0)
    return cmp * factor
  })
}

// Encabezado <th> completo, clicable para ordenar: mantiene los mismos
// data-col-tabla/data-col/colStyle(...) que ya usa el menú "⋮" de columnas
// (para que ocultar/mostrar columnas siga funcionando igual) y le suma la
// clase 'th-ordenable' + el onclick + la flechita (▲/▼) cuando es la
// columna por la que está ordenado activamente ese modo.
export function _flechaOrden(modo, col) {
  const st = window._resumenStockOrden[modo]
  if (st.col !== col) return ''
  return st.dir === 'asc' ? ' <span class="orden-flecha">▲</span>' : ' <span class="orden-flecha">▼</span>'
}

export function _thOrden(modo, tablaId, col, label) {
  return `<th data-col-tabla="${tablaId}" data-col="${col}" class="th-ordenable"${colStyle(tablaId, col)} onclick="window.ordenarResumenStock('${col}')">${label}${_flechaOrden(modo, col)}</th>`
}

async function renderResumenStock() {
  try {
    // Kardex (vía la vista stock_ubicaciones) es la fuente de verdad de
    // CANTIDADES — el mismo dato que ya usa el subtab "Por Zona". lotes
    // solo se consulta aquí para costo_unitario (dato de costeo, no de
    // cantidad, y no forma parte del problema de desincronización) y para
    // poder listar productos con stock=0. Antes este resumen sumaba
    // lotes.cantidad directo, que es un campo mantenido a mano por cada
    // flujo (compra/venta/traslado/nota/ajuste) y puede desincronizarse de
    // kardex — por eso a veces no coincidía con "Por Zona".
    const [productos, stockUbic, lotes, categorias] = await Promise.all([getItems(), getStockUbicaciones(), getLotes(), getCategorias()])
    const container = document.getElementById('tabla-resumen')

    if (!container) return

    _poblarFiltroCategoriasResumen(categorias || [])

    // Filtros (mismo patrón que tab Productos): categoría, stock y búsqueda
    // en vivo por nombre/SKU. Por defecto solo se muestra lo que tiene
    // stock, igual que en Productos.
    const fCat = document.getElementById('filtroResumenCategoria')?.value || ''
    const fStock = document.getElementById('filtroResumenStock')?.value ?? 'con'
    const fBusqueda = (document.getElementById('buscarResumenStock')?.value || '').trim().toLowerCase()

    const loteMap = {}
    ;(lotes || []).forEach(l => { loteMap[l.id] = l })

    // Agrega stock_ubicaciones (por lote+zona) a nivel de producto, sumando
    // todas las zonas reales de todos sus lotes — mismas filas que ve "Por
    // Zona", solo que agrupadas distinto.
    const stockPorProducto = {}
    ;(stockUbic || []).forEach(s => {
      const lote = loteMap[s.lote_id]
      if (!lote) return
      const acc = stockPorProducto[lote.item_id] || { cantidad: 0, unidades: 0, lotesSet: new Set(), valor: 0 }
      const cant = parseFloat(s.cantidad) || 0
      acc.cantidad += cant
      acc.unidades += parseFloat(s.cantidad_unidades) || 0
      acc.valor += cant * (parseFloat(lote.costo_unitario) || 0)
      acc.lotesSet.add(s.lote_id)
      stockPorProducto[lote.item_id] = acc
    })

    const productosFiltrados = (productos || []).filter(p => {
      const stock = stockPorProducto[p.id]?.cantidad || 0
      if (fCat && String(p.categoria_id) !== fCat) return false
      if (fStock === 'con' && stock <= 0) return false
      if (fStock === 'sin' && stock > 0) return false
      if (fBusqueda) {
        const texto = `${p.nombre || ''} ${p.sku || ''}`.toLowerCase()
        if (!texto.includes(fBusqueda)) return false
      }
      return true
    })

    const umbralCritico = getModuloConfig('inventario').stockCritico

    if (productosFiltrados.length === 0) {
      container.innerHTML = '<p style="text-align: center; color: var(--text-secondary); padding: 20px;">Sin productos que coincidan con los filtros</p>'
      return
    }

    // Se calculan todos los valores de cada fila ANTES de pintar (en vez de
    // ir directo del array de productos al html) para poder ordenarlas por
    // cualquier columna, no solo por el orden en que vino getItems().
    const filas = productosFiltrados.map(prod => {
      const acc = stockPorProducto[prod.id] || { cantidad: 0, unidades: 0, lotesSet: null, valor: 0 }
      const stockTotal = acc.cantidad
      const totalUnidades = acc.unidades
      const loteIds = acc.lotesSet ? Array.from(acc.lotesSet) : []
      const numerosLote = loteIds.map(id => loteMap[id]?.numero_lote).filter(Boolean)
      const valorTotal = acc.valor
      const costoPromedio = stockTotal > 0 ? valorTotal / stockTotal : 0
      const critico = stockTotal < umbralCritico
      return { prod, stockTotal, totalUnidades, numerosLote, valorTotal, costoPromedio, critico }
    })

    _aplicarOrdenFilas(filas, window._resumenStockOrden.general, {
      sku:            f => f.prod.sku || '',
      producto:       f => f.prod.nombre || '',
      lotes:          f => f.numerosLote.join(', '),
      stock_total:    f => f.stockTotal,
      total_unidades: f => f.totalUnidades,
      costo_promedio: f => f.costoPromedio,
      valor_total:    f => f.valorTotal,
      stock_critico:  f => f.critico ? 1 : 0
    })

    let html = `
      <table>
        <thead>
          <tr>
            ${_thOrden('general', 'resumen-stock', 'sku', 'SKU')}
            ${_thOrden('general', 'resumen-stock', 'producto', 'Producto')}
            ${_thOrden('general', 'resumen-stock', 'lotes', 'N° Lote')}
            ${_thOrden('general', 'resumen-stock', 'stock_total', 'Stock Total')}
            ${_thOrden('general', 'resumen-stock', 'total_unidades', 'Total Unidades')}
            ${_thOrden('general', 'resumen-stock', 'costo_promedio', 'Costo Promedio Unit.')}
            ${_thOrden('general', 'resumen-stock', 'valor_total', 'Valor Total Inventario')}
            ${_thOrden('general', 'resumen-stock', 'stock_critico', `Stock Crítico (&lt;${umbralCritico})`)}
            <th data-col-tabla="resumen-stock" data-col="acciones"${colStyle('resumen-stock','acciones')}>Acciones</th>
          </tr>
        </thead>
        <tbody>
    `

    let totalInventario = 0
    let totalStockGeneral = 0
    let totalUnidadesGeneral = 0

    for (const fila of filas) {
      const { prod, stockTotal, totalUnidades, numerosLote, valorTotal, costoPromedio, critico } = fila
      const listaLotes = _formatearListaLotes(numerosLote)

      totalInventario += valorTotal
      totalStockGeneral += stockTotal
      totalUnidadesGeneral += totalUnidades

      const colorCritico = critico ? 'background-color: #ea6868; color: #991b1b;' : ''

      html += `
        <tr style="${colorCritico}">
          <td data-col-tabla="resumen-stock" data-col="sku"${colStyle('resumen-stock','sku')}><strong>${prod.sku}</strong></td>
          <td data-col-tabla="resumen-stock" data-col="producto"${colStyle('resumen-stock','producto')}>${prod.nombre}</td>
          <td data-col-tabla="resumen-stock" data-col="lotes"${colStyle('resumen-stock','lotes')}>${listaLotes}</td>
          <td data-col-tabla="resumen-stock" data-col="stock_total" style="text-align: center; font-weight: bold;${colStyle('resumen-stock','stock_total') ? ' display:none;' : ''}">${stockTotal.toLocaleString('en-US', { maximumFractionDigits: 2 })}</td>
          <td data-col-tabla="resumen-stock" data-col="total_unidades" style="text-align: center;${colStyle('resumen-stock','total_unidades') ? ' display:none;' : ''}">${totalUnidades.toLocaleString('en-US', { maximumFractionDigits: 2 })}</td>
          <td data-col-tabla="resumen-stock" data-col="costo_promedio"${colStyle('resumen-stock','costo_promedio')}>S/. ${costoPromedio.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
          <td data-col-tabla="resumen-stock" data-col="valor_total"${colStyle('resumen-stock','valor_total')}>S/. ${valorTotal.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
          <td data-col-tabla="resumen-stock" data-col="stock_critico" style="text-align: center;${colStyle('resumen-stock','stock_critico') ? ' display:none;' : ''}">${critico ? '⚠️ SÍ' : 'NO'}</td>
          <td data-col-tabla="resumen-stock" data-col="acciones"${colStyle('resumen-stock','acciones')}><button class="btn btn-small btn-secondary" onclick="window.abrirModalTrasladoDesdeProducto(${prod.id})">Trasladar</button></td>
        </tr>
      `
    }

    html += `
        </tbody>
        <tfoot>
          <tr style="border-top: 2px solid var(--border-color); font-weight: bold;">
            <td data-col-tabla="resumen-stock" data-col="sku"${colStyle('resumen-stock','sku')}></td>
            <td data-col-tabla="resumen-stock" data-col="producto"${colStyle('resumen-stock','producto')}>TOTAL INVENTARIO</td>
            <td data-col-tabla="resumen-stock" data-col="lotes"${colStyle('resumen-stock','lotes')}></td>
            <td data-col-tabla="resumen-stock" data-col="stock_total" style="text-align: center;${colStyle('resumen-stock','stock_total') ? ' display:none;' : ''}">${totalStockGeneral.toLocaleString('en-US', { maximumFractionDigits: 2 })}</td>
            <td data-col-tabla="resumen-stock" data-col="total_unidades" style="text-align: center;${colStyle('resumen-stock','total_unidades') ? ' display:none;' : ''}">${totalUnidadesGeneral.toLocaleString('en-US', { maximumFractionDigits: 2 })}</td>
            <td data-col-tabla="resumen-stock" data-col="costo_promedio"${colStyle('resumen-stock','costo_promedio')}></td>
            <td data-col-tabla="resumen-stock" data-col="valor_total"${colStyle('resumen-stock','valor_total')}>S/. ${totalInventario.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
            <td data-col-tabla="resumen-stock" data-col="stock_critico"${colStyle('resumen-stock','stock_critico')}></td>
            <td data-col-tabla="resumen-stock" data-col="acciones"${colStyle('resumen-stock','acciones')}></td>
          </tr>
        </tfoot>
      </table>
    `

    container.innerHTML = html
  } catch (error) {
    console.error('Error en renderResumenStock:', error)
    showToast('Error al cargar resumen', 'danger')
  }
}
