// ============================================================================
// inventario/stock-zona.js — parte de inventario.js (reorganizado 2026-09-25, sin cambios de lógica)
// Mapa completo de funciones: Claude outputs/glosario_funciones_erp.md
// ============================================================================
import { colStyle } from '../col-menu.js'
import { getItems, getLotes, getMarcas, getAlmacenes, getUbicaciones, getStockUbicaciones } from '../supabase-data.js'
import { showToast } from '../helpers.js'
import { _fechaDDMMAAAA } from './kardex.js'
import { _aplicarOrdenFilas, _flechaOrden, _thOrden } from './resumen-stock.js'

// ============================================================================
// STOCK POR ZONA Y TRASLADOS INTERNOS (Etapa 2)
// ============================================================================
// stock_ubicaciones es la fuente de verdad de "cuánto de cada lote hay en
// cada zona". Un traslado interno mueve cantidad entre dos filas (mismo
// lote_id, distinto ubicacion_id) sin tocar lotes.cantidad ni el costeo, y
// deja rastro en kardex con tipo_movimiento='traslado_interno'.

export async function renderStockZonas() {
  try {
    const container = document.getElementById('tabla-resumen')
    if (!container) return

    const [stock, lotes, items, marcas, zonas, almacenes] = await Promise.all([
      getStockUbicaciones(),
      getLotes(),
      getItems(),
      getMarcas(),
      getUbicaciones(),
      getAlmacenes()
    ])

    const almacenMap = {}
    for (const a of (almacenes || [])) almacenMap[a.id] = a
    const zonaMap = {}
    for (const z of (zonas || [])) zonaMap[z.id] = z
    const loteMap = {}
    for (const l of (lotes || [])) loteMap[l.id] = l
    const itemMap = {}
    for (const it of (items || [])) itemMap[it.id] = it
    const marcaMap = {}
    for (const m of (marcas || [])) marcaMap[m.id] = m

    // Poblar el filtro de zona (Almacén — Zona), preservando la selección
    // actual si sigue siendo válida — mismo patrón que filtroZonaAlmacen.
    const selFiltro = document.getElementById('filtroZonaStock')
    const valorPrevio = selFiltro?.value || ''
    if (selFiltro) {
      const opcionesZona = (zonas || [])
        .slice()
        .sort((a, b) => (almacenMap[a.almacen_id]?.nombre || '').localeCompare(almacenMap[b.almacen_id]?.nombre || '') || (a.nombre || '').localeCompare(b.nombre || ''))
        .map(z => `<option value="${z.id}">${almacenMap[z.almacen_id]?.nombre || '?'} — ${z.nombre}</option>`)
        .join('')
      selFiltro.innerHTML = '<option value="">-- Todas las zonas --</option>' + opcionesZona
      selFiltro.value = valorPrevio
    }
    const fZona = parseInt(selFiltro?.value || 0) || ''

    // Buscador global libre — actualiza en vivo con cada tecla (oninput,
    // mismo patrón que "buscarResumenStock" en el tab General), y busca en
    // producto, SKU, lote, marca y zona a la vez (antes solo dejaba elegir
    // un producto de una lista, uno por uno).
    const fBusqueda = (document.getElementById('buscarResumenStock')?.value || '').trim().toLowerCase()

    let stockConCantidad = (stock || []).filter(s => (parseFloat(s.cantidad) || 0) > 0)
    if (fZona) stockConCantidad = stockConCantidad.filter(s => s.ubicacion_id === fZona)
    if (fBusqueda) {
      stockConCantidad = stockConCantidad.filter(s => {
        const lote = loteMap[s.lote_id]
        const item = lote ? itemMap[lote.item_id] : null
        const marca = lote?.marca_id ? marcaMap[lote.marca_id] : null
        const z = zonaMap[s.ubicacion_id]
        const almacen = z ? almacenMap[z.almacen_id] : null
        const texto = [
          item?.nombre, item?.sku, item?.codigo,
          lote?.numero_lote, marca?.nombre,
          z?.nombre, almacen?.nombre
        ].filter(Boolean).join(' ').toLowerCase()
        return texto.includes(fBusqueda)
      })
    }

    if (stockConCantidad.length === 0) {
      container.innerHTML = (fZona || fBusqueda)
        ? '<p style="text-align:center; color:var(--text-secondary); padding:20px;">Sin stock con ese filtro.</p>'
        : '<p style="text-align:center; color:var(--text-secondary); padding:20px;">Sin stock registrado por zona todavía (se genera al recibir una Guía de Remisión).</p>'
      return
    }

    // Sin filtro de zona: se agrupa visualmente por Almacén—Zona (ordenando
    // por ahí primero) para que "agrupar" y "filtrar" sean la misma lista,
    // solo que sin filtro se ven todas las zonas juntas por bloques.
    const nombreZona = (g) => {
      const z = zonaMap[g.ubicacion_id]
      const a = z ? almacenMap[z.almacen_id] : null
      return `${a?.nombre || '?'} — ${z?.nombre || 'Zona #' + g.ubicacion_id}`
    }

    // Agrupa por Producto + N° de Lote (texto) + Zona: a nivel de BD cada
    // factura crea su propio `lotes.id` aunque comparta el mismo texto de
    // N° de Lote — es Identificación Específica por Adquisición a propósito
    // (ver _buscarLoteExistente en compras.js: LIR Art. 62°c / NIC 2 párr.
    // 24, costo distinto por tipo de cambio/factura, no se puede fusionar ni
    // promediar). Pero esta tabla solo responde "cuánto hay AHORA de este
    // lote en esta zona", así que se suman visualmente — el detalle por
    // factura sigue intacto en Kardex → Historial de Movimientos, y el
    // selector de Lote del modal de Traslado (ver
    // abrirModalTrasladoDesdeResumenZona) deja elegir de cuál factura
    // específica se descuenta. Reportado por Luis: lote SD60729 con 6 filas
    // idénticas en vez de 1 sumada (2026-09-21).
    const gruposMap = {}
    for (const s of stockConCantidad) {
      const lote = loteMap[s.lote_id]
      if (!lote) continue
      const key = `${lote.item_id}|${String(lote.numero_lote || '').trim().toLowerCase()}|${s.ubicacion_id}`
      if (!gruposMap[key]) {
        gruposMap[key] = {
          itemId: lote.item_id,
          numeroLote: lote.numero_lote || '-',
          marcaId: lote.marca_id,
          ubicacion_id: s.ubicacion_id,
          cantidad: 0,
          unidades: 0,
          loteIds: []
        }
      }
      const g = gruposMap[key]
      g.cantidad += parseFloat(s.cantidad) || 0
      g.unidades += parseFloat(s.cantidad_unidades) || 0
      g.loteIds.push(s.lote_id)
    }
    const filasAgrupadas = Object.values(gruposMap)

    // Orden: por defecto se agrupa por zona (banners) igual que antes. Si el
    // usuario eligió una columna haciendo click en el encabezado, esa manda:
    // - con una sola zona filtrada (no hay banners) se ordena plano.
    // - con todas las zonas juntas, "Almacén — Zona" reordena los bloques;
    //   cualquier otra columna ordena DENTRO de cada bloque de zona, para no
    //   perder el agrupamiento visual que el banner promete.
    const stOrden = window._resumenStockOrden.zona
    const extractoresZona = {
      codigo:    g => itemMap[g.itemId]?.sku || '',
      producto:  g => itemMap[g.itemId]?.nombre || '',
      lote:      g => g.numeroLote || '',
      marca:     g => marcaMap[g.marcaId]?.nombre || '',
      zona:      g => nombreZona(g),
      cantidad:  g => g.cantidad,
      unidades:  g => g.unidades,
      peso_unidad: g => g.unidades > 0 ? g.cantidad / g.unidades : 0
    }
    if (!fZona && stOrden.col && stOrden.col !== 'zona') {
      const getCol = extractoresZona[stOrden.col]
      const factor = stOrden.dir === 'desc' ? -1 : 1
      filasAgrupadas.sort((a, b) => {
        const z = nombreZona(a).localeCompare(nombreZona(b))
        if (z !== 0) return z
        const va = getCol(a), vb = getCol(b)
        const cmp = (typeof va === 'string' || typeof vb === 'string')
          ? String(va ?? '').localeCompare(String(vb ?? ''), 'es', { numeric: true, sensitivity: 'base' })
          : (va || 0) - (vb || 0)
        return cmp * factor
      })
    } else if (stOrden.col) {
      _aplicarOrdenFilas(filasAgrupadas, stOrden, extractoresZona)
    } else {
      filasAgrupadas.sort((a, b) => nombreZona(a).localeCompare(nombreZona(b)) || (a.numeroLote || '').localeCompare(b.numeroLote || ''))
    }

    let html = `
      <table>
        <thead>
          <tr>
            <th data-col-tabla="stock-zonas" data-col="sel"${colStyle('stock-zonas','sel')}><input type="checkbox" id="stockZonasSelAll" title="Seleccionar todo" onchange="window._stockZonasToggleSelTodo(this.checked)"></th>
            ${_thOrden('zona', 'stock-zonas', 'codigo', 'Código')}
            ${_thOrden('zona', 'stock-zonas', 'producto', 'Producto')}
            ${_thOrden('zona', 'stock-zonas', 'lote', 'N° Lote')}
            ${_thOrden('zona', 'stock-zonas', 'marca', 'Marca')}
            ${_thOrden('zona', 'stock-zonas', 'zona', 'Almacén — Zona')}
            <th data-col-tabla="stock-zonas" data-col="cantidad" class="th-ordenable" style="text-align:right;${colStyle('stock-zonas','cantidad') ? ' display:none;' : ''}" onclick="window.ordenarResumenStock('cantidad')">Cantidad${_flechaOrden('zona', 'cantidad')}</th>
            <th data-col-tabla="stock-zonas" data-col="unidades" class="th-ordenable" style="text-align:right;${colStyle('stock-zonas','unidades') ? ' display:none;' : ''}" onclick="window.ordenarResumenStock('unidades')">Unidades${_flechaOrden('zona', 'unidades')}</th>
            <th data-col-tabla="stock-zonas" data-col="peso_unidad" class="th-ordenable" style="text-align:right;${colStyle('stock-zonas','peso_unidad') ? ' display:none;' : ''}" onclick="window.ordenarResumenStock('peso_unidad')" title="Cantidad ÷ Unidades de esta fila — no es el campo guardado en cada lote, ver nota en el código">Peso/Unidad${_flechaOrden('zona', 'peso_unidad')}</th>
            <th data-col-tabla="stock-zonas" data-col="acciones"${colStyle('stock-zonas','acciones')}>Acciones</th>
          </tr>
        </thead>
        <tbody>
    `
    let zonaAnterior = null
    for (const g of filasAgrupadas) {
      const item = itemMap[g.itemId]
      const marca = g.marcaId ? marcaMap[g.marcaId] : null
      const etiquetaZona = nombreZona(g)

      // Fila separadora por zona, solo cuando se ven todas juntas (sin
      // filtro) — puramente visual, no cambia los datos.
      if (!fZona && etiquetaZona !== zonaAnterior) {
        html += `<tr><td colspan="10" style="background:var(--bg-secondary); font-weight:bold; padding:6px 10px;">${etiquetaZona}</td></tr>`
        zonaAnterior = etiquetaZona
      }

      html += `
        <tr>
          <td data-col-tabla="stock-zonas" data-col="sel"${colStyle('stock-zonas','sel')}><input type="checkbox" class="stock-zona-sel"></td>
          <td data-col-tabla="stock-zonas" data-col="codigo"${colStyle('stock-zonas','codigo')}>${item?.sku || '-'}</td>
          <td data-col-tabla="stock-zonas" data-col="producto"${colStyle('stock-zonas','producto')}>${item?.nombre || 'Item #' + g.itemId}</td>
          <td data-col-tabla="stock-zonas" data-col="lote"${colStyle('stock-zonas','lote')}>${g.numeroLote}</td>
          <td data-col-tabla="stock-zonas" data-col="marca"${colStyle('stock-zonas','marca')}>${marca?.nombre || '-'}</td>
          <td data-col-tabla="stock-zonas" data-col="zona"${colStyle('stock-zonas','zona')}>${etiquetaZona}</td>
          <td data-col-tabla="stock-zonas" data-col="cantidad" style="text-align:right; font-weight:bold;${colStyle('stock-zonas','cantidad') ? ' display:none;' : ''}">${g.cantidad.toLocaleString('en-US', { maximumFractionDigits: 2 })}</td>
          <td data-col-tabla="stock-zonas" data-col="unidades" style="text-align:right;${colStyle('stock-zonas','unidades') ? ' display:none;' : ''}">${g.unidades > 0 ? g.unidades.toLocaleString('en-US', { maximumFractionDigits: 2 }) : '-'}</td>
          <td data-col-tabla="stock-zonas" data-col="peso_unidad" style="text-align:right;${colStyle('stock-zonas','peso_unidad') ? ' display:none;' : ''}" title="Cantidad ÷ Unidades de esta fila (suma de todas las facturas agrupadas)">${g.unidades > 0 ? (g.cantidad / g.unidades).toLocaleString('en-US', { maximumFractionDigits: 4 }) : '-'}</td>
          <td data-col-tabla="stock-zonas" data-col="acciones"${colStyle('stock-zonas','acciones')}><button class="btn btn-small btn-secondary" onclick="window.abrirModalTrasladoDesdeResumenZona(${g.itemId}, ${g.ubicacion_id})">Trasladar</button></td>
        </tr>
      `
    }
    html += '</tbody></table>'
    container.innerHTML = html
  } catch (error) {
    console.error('Error en renderStockZonas:', error)
    showToast('Error al cargar el stock por zona', 'danger')
  }
}
window.renderStockZonas = renderStockZonas

// Checkbox "seleccionar todo" del header de "Por Ubicación" — mismo patrón
// que _kardexToggleSelTodo.
window._stockZonasToggleSelTodo = function (checked) {
  document.querySelectorAll('#tabla-resumen .stock-zona-sel').forEach(chk => { chk.checked = checked })
}

// ============================================================================
// RESUMEN DE STOCK "POR UBICACIÓN" — Exportar a Excel / PDF
// ============================================================================
// Mismo patrón que exportarKardexExcel: lee directamente del DOM ya
// renderizado (mismas columnas visibles del menú ⚙️, mismo filtro/orden
// aplicado), exporta solo las filas marcadas con checkbox o todas si no se
// marcó ninguna. Solo aplica al modo "Por Ubicación" (filasAgrupadas, una
// fila por N° de Lote + Zona) — en modo "General" no hay checkboxes.
function _filasVisiblesStockZonas() {
  const tabla = document.querySelector('#tabla-resumen table')
  if (!tabla) return null

  const thsExcluidos = new Set(['sel', 'acciones'])
  const ths = Array.from(tabla.querySelectorAll('thead th'))
    .filter(th => th.style.display !== 'none' && !thsExcluidos.has(th.dataset.col))

  const filasDatos = Array.from(tabla.querySelectorAll('tbody tr'))
    .filter(tr => tr.querySelector('.stock-zona-sel')) // descarta los banners de zona (sin checkbox)

  const marcadas = filasDatos.filter(tr => tr.querySelector('.stock-zona-sel')?.checked)
  const filasAExportar = marcadas.length > 0 ? marcadas : filasDatos

  return { ths, filasAExportar }
}

window.exportarStockZonasExcel = async function () {
  if (window._resumenStockModo !== 'zona') { showToast('Cambia a "Por Ubicación" para exportar esta tabla', 'warning'); return }
  const datos = _filasVisiblesStockZonas()
  if (!datos || datos.ths.length === 0) { showToast('No hay columnas visibles para exportar', 'warning'); return }
  const { ths, filasAExportar } = datos
  if (filasAExportar.length === 0) { showToast('No hay filas para exportar', 'warning'); return }

  // Encabezados en MAYÚSCULAS (xlsx community no soporta color/negrita real
  // de celda al escribir — ver decisión 2026-09-22) + fila de título y fecha
  // arriba, igual que el PDF (doc.text('Resumen de Stock...') + fecha),
  // para que ambos exportables se lean como el mismo reporte.
  const encabezados = ths.map(th => th.textContent.trim().replace(/[▲▼]/g, '').trim().toUpperCase())
  const filasArray = filasAExportar.map(tr =>
    ths.map(th => {
      const celda = tr.querySelector(`[data-col="${th.dataset.col}"]`)
      return celda ? celda.textContent.trim().replace(/\s+/g, ' ') : ''
    })
  )

  try {
    const XLSX = await import('https://cdn.jsdelivr.net/npm/xlsx@0.18.5/+esm')
    const fechaHoy = new Date().toISOString().slice(0, 10)
    const aoa = [
      ['RESUMEN DE STOCK — POR UBICACIÓN'],
      [`Generado: ${_fechaDDMMAAAA(fechaHoy)}`],
      [],
      encabezados,
      ...filasArray
    ]
    const ws = XLSX.utils.aoa_to_sheet(aoa)
    // Título ocupando todo el ancho de la tabla (misma idea que el PDF, que
    // pone el título como texto suelto arriba de la tabla).
    ws['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: Math.max(0, encabezados.length - 1) } }]
    // Ancho de columna autoajustado al contenido más largo (encabezado o
    // dato) — lo más cerca que xlsx community permite de "se ve prolijo".
    ws['!cols'] = encabezados.map((h, i) => {
      const maxLen = Math.max(h.length, ...filasArray.map(f => String(f[i] ?? '').length))
      return { wch: Math.min(Math.max(maxLen + 2, 10), 40) }
    })
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Stock por Ubicación')
    XLSX.writeFile(wb, `Resumen_Stock_Por_Ubicacion_${fechaHoy}.xlsx`)
    showToast(`Excel exportado: ${filasAExportar.length} fila(s), ${ths.length} columna(s) ✅`, 'success')
  } catch (e) {
    console.error('exportarStockZonasExcel:', e)
    showToast('Error al generar el Excel: ' + e.message, 'danger')
  }
}

window.exportarStockZonasPDF = async function () {
  if (window._resumenStockModo !== 'zona') { showToast('Cambia a "Por Ubicación" para exportar esta tabla', 'warning'); return }
  const datos = _filasVisiblesStockZonas()
  if (!datos || datos.ths.length === 0) { showToast('No hay columnas visibles para exportar', 'warning'); return }
  const { ths, filasAExportar } = datos
  if (filasAExportar.length === 0) { showToast('No hay filas para exportar', 'warning'); return }

  const encabezados = ths.map(th => th.textContent.trim().replace(/[▲▼]/g, '').trim())
  const filasTexto = filasAExportar.map(tr =>
    ths.map(th => {
      const celda = tr.querySelector(`[data-col="${th.dataset.col}"]`)
      return celda ? celda.textContent.trim().replace(/\s+/g, ' ') : ''
    })
  )

  try {
    const { jsPDF } = await import('https://cdn.jsdelivr.net/npm/jspdf@2.5.2/+esm')
    // 2do intento (2026-09-21): el build "+esm" de jsdelivr de jspdf-autotable
    // NO exporta una función callable `autoTable(doc, opts)` como default —
    // eso era para el paquete instalado vía bundler/npm, que internamente
    // comparte la misma instancia de `jspdf`. Este build empaqueta su propia
    // copia de jsPDF aparte, así que su export por defecto es en realidad
    // `applyPlugin(jsPDFClass)`: una función que PARCHA la clase que le pases,
    // agregándole `.autoTable()` al prototipo (confirmado inspeccionando el
    // bundle: exporta `applyPlugin` junto con `default` como alias del mismo).
    // Por eso el 1er intento tiró "autoTable is not a function" al llamarlo
    // como `autoTable(doc, opts)` en vez de como `applyPlugin(jsPDF)`.
    const { applyPlugin } = await import('https://cdn.jsdelivr.net/npm/jspdf-autotable@3.8.4/+esm')
    applyPlugin(jsPDF)
    const doc = new jsPDF({ orientation: 'landscape' })
    const fechaHoy = new Date().toISOString().slice(0, 10)
    doc.setFontSize(12)
    doc.text('Resumen de Stock — Por Ubicación', 14, 12)
    doc.setFontSize(9)
    doc.text(`Generado: ${_fechaDDMMAAAA(fechaHoy)}`, 14, 18)
    doc.autoTable({ head: [encabezados], body: filasTexto, startY: 22, styles: { fontSize: 8 } })
    doc.save(`Resumen_Stock_Por_Ubicacion_${fechaHoy}.pdf`)
    showToast(`PDF exportado: ${filasAExportar.length} fila(s), ${ths.length} columna(s) ✅`, 'success')
  } catch (e) {
    console.error('exportarStockZonasPDF:', e)
    showToast('Error al generar el PDF: ' + e.message, 'danger')
  }
}
