// ============================================================================
// inventario/stock-zona.js — parte de inventario.js (reorganizado 2026-09-25, sin cambios de lógica)
// Mapa completo de funciones: Claude outputs/glosario_funciones_erp.md
// ============================================================================
import { colStyle } from '../col-menu.js'
import { getItems, getLotes, getMarcas, getAlmacenes, getUbicaciones, getStockUbicaciones, getCategorias, getFamilias, getFamiliaLotes } from '../supabase-data.js'
import { showToast, pdfTablaUnaLinea } from '../helpers.js'
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

    // Familias (SQL 66): si el checkbox "Agrupar por familia" está activo,
    // los lotes de una misma familia se suman en una sola fila por zona.
    const agruparFamilia = !!document.getElementById('chkAgruparFamilia')?.checked
    const [stock, lotes, items, marcas, zonas, almacenes, categorias, familias, familiaLotes] = await Promise.all([
      getStockUbicaciones(),
      getLotes(),
      getItems(),
      getMarcas(),
      getUbicaciones(),
      getAlmacenes(),
      getCategorias(),
      agruparFamilia ? getFamilias().catch(() => []) : [],
      agruparFamilia ? getFamiliaLotes().catch(() => []) : []
    ])
    const familiaMap = {}
    for (const f of (familias || [])) familiaMap[f.id] = f
    // item_id|numero_lote(lower) -> familia_id
    const famDeLote = {}
    for (const fl of (familiaLotes || [])) {
      famDeLote[`${fl.item_id}|${String(fl.numero_lote || '').trim().toLowerCase()}`] = fl.familia_id
    }
    const catNombre = {}
    for (const c of (categorias || [])) catNombre[c.id] = c.nombre

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
          z?.nombre, almacen?.nombre,
          lote ? familiaMap[famDeLote[`${lote.item_id}|${String(lote.numero_lote || '').trim().toLowerCase()}`]]?.nombre : null
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
      const claveLote = `${lote.item_id}|${String(lote.numero_lote || '').trim().toLowerCase()}`
      const famId = agruparFamilia ? famDeLote[claveLote] : null
      const key = famId ? `F${famId}|${s.ubicacion_id}` : `${claveLote}|${s.ubicacion_id}`
      if (!gruposMap[key]) {
        gruposMap[key] = {
          familiaId: famId || null,
          itemIds: new Set(),
          numerosLote: new Set(),
          marcaIds: new Set(),
          itemId: lote.item_id,
          numeroLote: lote.numero_lote || '-',
          marcaId: lote.marca_id,
          ubicacion_id: s.ubicacion_id,
          cantidad: 0,
          unidades: 0,
          valor: 0,
          costos: new Set(),
          valorOrig: 0,
          valorTC: 0,
          costosOrig: new Set(),
          tcs: new Set(),
          monedas: new Set(),
          loteIds: []
        }
      }
      const g = gruposMap[key]
      g.cantidad += parseFloat(s.cantidad) || 0
      g.unidades += parseFloat(s.cantidad_unidades) || 0
      g.loteIds.push(s.lote_id)
      g.itemIds.add(lote.item_id)
      g.numerosLote.add(lote.numero_lote || '-')
      if (lote.marca_id) g.marcaIds.add(lote.marca_id)
      // Costo (2026-10-05): promedio ponderado por stock actual de todos los
      // ingresos (lotes.id) que comparten este N° de Lote en esta zona. Si
      // hubo >1 costo distinto se marca como "promedio" (celda sombreada).
      const cu = parseFloat(lote.costo_unitario) || 0
      g.valor += (parseFloat(s.cantidad) || 0) * cu
      g.costos.add(cu.toFixed(4))
      // Datos de la factura original (SQL 29: lotes.moneda / tipo_cambio /
      // costo_unit_original). Lotes antiguos sin esos campos = PEN, TC 1.
      const cantS = parseFloat(s.cantidad) || 0
      const mon = lote.moneda || 'PEN'
      const tc = parseFloat(lote.tipo_cambio) || 1
      const co = lote.costo_unit_original != null ? (parseFloat(lote.costo_unit_original) || 0) : (tc ? cu / tc : cu)
      g.monedas.add(mon)
      g.valorOrig += cantS * co
      g.valorTC += cantS * tc
      g.costosOrig.add(co.toFixed(4))
      g.tcs.add(tc.toFixed(4))
    }
    for (const g of Object.values(gruposMap)) {
      g.costo = g.cantidad > 0 ? g.valor / g.cantidad : 0
      g.esPromedio = g.costos.size > 1
      g.moneda = g.monedas.size > 1 ? 'Mixta' : [...g.monedas][0]
      // Costo original solo se promedia si todos los ingresos son de la
      // misma moneda — sumar USD con PEN no tiene sentido.
      g.costoOrig = g.monedas.size > 1 ? null : (g.cantidad > 0 ? g.valorOrig / g.cantidad : 0)
      g.costoOrigPromedio = g.monedas.size === 1 && g.costosOrig.size > 1
      g.tc = g.cantidad > 0 ? g.valorTC / g.cantidad : 1
      g.tcPromedio = g.tcs.size > 1
    }
    const filasAgrupadas = Object.values(gruposMap)

    // Textos por fila: una fila de familia junta varios productos/lotes/marcas.
    const _unicoOVarios = (set, fn) => set.size === 1 ? fn([...set][0]) : (set.size === 0 ? '-' : `Varios (${set.size})`)
    const txtSku = g => g.familiaId ? _unicoOVarios(g.itemIds, id => itemMap[id]?.sku || '-') : (itemMap[g.itemId]?.sku || '-')
    const txtProducto = g => g.familiaId ? (familiaMap[g.familiaId]?.nombre || 'Familia #' + g.familiaId) : (itemMap[g.itemId]?.nombre || 'Item #' + g.itemId)
    const txtCategoria = g => {
      const cats = new Set([...g.itemIds].map(id => itemMap[id]?.categoria_id))
      return _unicoOVarios(cats, c => catNombre[c] || '-')
    }
    const txtLote = g => g.familiaId ? `${g.numerosLote.size} lote${g.numerosLote.size === 1 ? '' : 's'}` : g.numeroLote
    const txtMarca = g => g.familiaId ? _unicoOVarios(g.marcaIds, id => marcaMap[id]?.nombre || '-') : (marcaMap[g.marcaId]?.nombre || '-')

    // Orden: por defecto se agrupa por zona (banners) igual que antes. Si el
    // usuario eligió una columna haciendo click en el encabezado, esa manda:
    // - con una sola zona filtrada (no hay banners) se ordena plano.
    // - con todas las zonas juntas, "Almacén — Zona" reordena los bloques;
    //   cualquier otra columna ordena DENTRO de cada bloque de zona, para no
    //   perder el agrupamiento visual que el banner promete.
    const stOrden = window._resumenStockOrden.zona
    const extractoresZona = {
      codigo:    g => txtSku(g),
      producto:  g => txtProducto(g),
      categoria: g => txtCategoria(g),
      lote:      g => txtLote(g),
      marca:     g => txtMarca(g),
      zona:      g => nombreZona(g),
      cantidad:  g => g.cantidad,
      unidades:  g => g.unidades,
      peso_unidad: g => g.unidades > 0 ? g.cantidad / g.unidades : 0,
      moneda:    g => g.moneda || '',
      tc:        g => g.tc,
      costo_orig: g => g.costoOrig ?? -1,
      costo:     g => g.costo
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
            ${_thOrden('zona', 'stock-zonas', 'categoria', 'Categoría')}
            ${_thOrden('zona', 'stock-zonas', 'lote', 'N° Lote')}
            ${_thOrden('zona', 'stock-zonas', 'marca', 'Marca')}
            ${_thOrden('zona', 'stock-zonas', 'zona', 'Almacén — Zona')}
            <th data-col-tabla="stock-zonas" data-col="cantidad" class="th-ordenable" style="text-align:right;${colStyle('stock-zonas','cantidad') ? ' display:none;' : ''}" onclick="window.ordenarResumenStock('cantidad')">Cantidad${_flechaOrden('zona', 'cantidad')}</th>
            <th data-col-tabla="stock-zonas" data-col="unidades" class="th-ordenable" style="text-align:right;${colStyle('stock-zonas','unidades') ? ' display:none;' : ''}" onclick="window.ordenarResumenStock('unidades')">Unidades${_flechaOrden('zona', 'unidades')}</th>
            <th data-col-tabla="stock-zonas" data-col="peso_unidad" class="th-ordenable" style="text-align:right;${colStyle('stock-zonas','peso_unidad') ? ' display:none;' : ''}" onclick="window.ordenarResumenStock('peso_unidad')" title="Cantidad ÷ Unidades de esta fila — no es el campo guardado en cada lote, ver nota en el código">Peso/Unidad${_flechaOrden('zona', 'peso_unidad')}</th>
            ${_thOrden('zona', 'stock-zonas', 'moneda', 'Moneda')}
            <th data-col-tabla="stock-zonas" data-col="tc" class="th-ordenable" style="text-align:right;${colStyle('stock-zonas','tc') ? ' display:none;' : ''}" onclick="window.ordenarResumenStock('tc')" title="Tipo de cambio de la factura original. Sombreado = promedio ponderado de varios ingresos">T.C.${_flechaOrden('zona', 'tc')}</th>
            <th data-col-tabla="stock-zonas" data-col="costo_orig" class="th-ordenable" style="text-align:right;${colStyle('stock-zonas','costo_orig') ? ' display:none;' : ''}" onclick="window.ordenarResumenStock('costo_orig')" title="Costo unitario en la moneda de la factura original">Costo Orig.${_flechaOrden('zona', 'costo_orig')}</th>
            <th data-col-tabla="stock-zonas" data-col="costo" class="th-ordenable" style="text-align:right;${colStyle('stock-zonas','costo') ? ' display:none;' : ''}" onclick="window.ordenarResumenStock('costo')" title="Costo unitario en soles. Sombreado = promedio ponderado de varios ingresos con distinto costo">Costo S/.${_flechaOrden('zona', 'costo')}</th>
            <th data-col-tabla="stock-zonas" data-col="acciones"${colStyle('stock-zonas','acciones')}>Acciones</th>
          </tr>
        </thead>
        <tbody>
    `
    let zonaAnterior = null
    for (const g of filasAgrupadas) {
      const etiquetaZona = nombreZona(g)
      const esFam = !!g.familiaId
      const tipLotes = esFam
        ? ' title="' + [...g.numerosLote].join(', ').replace(/"/g, '&quot;') + '"'
        : ''

      // Fila separadora por zona, solo cuando se ven todas juntas (sin
      // filtro) — puramente visual, no cambia los datos.
      if (!fZona && etiquetaZona !== zonaAnterior) {
        html += `<tr><td colspan="15" style="background:var(--bg-secondary); font-weight:bold; padding:6px 10px;">${etiquetaZona}</td></tr>`
        zonaAnterior = etiquetaZona
      }

      html += `
        <tr>
          <td data-col-tabla="stock-zonas" data-col="sel"${colStyle('stock-zonas','sel')}><input type="checkbox" class="stock-zona-sel"></td>
          <td data-col-tabla="stock-zonas" data-col="codigo"${colStyle('stock-zonas','codigo')}>${txtSku(g)}</td>
          <td data-col-tabla="stock-zonas" data-col="producto"${colStyle('stock-zonas','producto')}>${esFam ? '<span class="badge badge-info solo-pantalla" style="margin-right:6px;">Familia</span><strong>' + txtProducto(g) + '</strong>' : txtProducto(g)}</td>
          <td data-col-tabla="stock-zonas" data-col="categoria"${colStyle('stock-zonas','categoria')}>${txtCategoria(g)}</td>
          <td data-col-tabla="stock-zonas" data-col="lote"${colStyle('stock-zonas','lote')}${tipLotes}>${txtLote(g)}</td>
          <td data-col-tabla="stock-zonas" data-col="marca"${colStyle('stock-zonas','marca')}>${txtMarca(g)}</td>
          <td data-col-tabla="stock-zonas" data-col="zona"${colStyle('stock-zonas','zona')}>${etiquetaZona}</td>
          <td data-col-tabla="stock-zonas" data-col="cantidad" data-valor="${g.cantidad}" style="text-align:right; font-weight:bold;${colStyle('stock-zonas','cantidad') ? ' display:none;' : ''}">${g.cantidad.toLocaleString('en-US', { maximumFractionDigits: 2 })}</td>
          <td data-col-tabla="stock-zonas" data-col="unidades" data-valor="${g.unidades > 0 ? g.unidades : ''}" style="text-align:right;${colStyle('stock-zonas','unidades') ? ' display:none;' : ''}">${g.unidades > 0 ? g.unidades.toLocaleString('en-US', { maximumFractionDigits: 2 }) : '-'}</td>
          <td data-col-tabla="stock-zonas" data-col="peso_unidad" data-valor="${g.unidades > 0 ? g.cantidad / g.unidades : ''}" style="text-align:right;${colStyle('stock-zonas','peso_unidad') ? ' display:none;' : ''}" title="Cantidad ÷ Unidades de esta fila (suma de todas las facturas agrupadas)">${g.unidades > 0 ? (g.cantidad / g.unidades).toLocaleString('en-US', { maximumFractionDigits: 4 }) : '-'}</td>
          <td data-col-tabla="stock-zonas" data-col="moneda" class="${g.monedas.size > 1 ? 'costo-promedio' : ''}"${colStyle('stock-zonas','moneda')} title="${g.monedas.size > 1 ? 'Ingresos en distintas monedas: ' + [...g.monedas].join(' · ') : 'Moneda de la factura original'}">${g.moneda}</td>
          <td data-col-tabla="stock-zonas" data-col="tc" data-valor="${g.tc}" class="${g.tcPromedio ? 'costo-promedio' : ''}" style="text-align:right;${colStyle('stock-zonas','tc') ? ' display:none;' : ''}" title="${g.tcPromedio ? `Promedio ponderado de ${g.tcs.size} T.C.: ` + [...g.tcs].map(t => parseFloat(t).toFixed(3)).join(' · ') : 'T.C. de la factura original'}">${g.tc.toLocaleString('en-US', { minimumFractionDigits: 3, maximumFractionDigits: 4 })}</td>
          <td data-col-tabla="stock-zonas" data-col="costo_orig" data-valor="${g.costoOrig == null ? '' : g.costoOrig}" class="${g.costoOrigPromedio ? 'costo-promedio' : ''}" style="text-align:right;${colStyle('stock-zonas','costo_orig') ? ' display:none;' : ''}" title="${g.costoOrig == null ? 'Monedas distintas: ver Costo S/.' : g.costoOrigPromedio ? `Promedio ponderado de ${g.costosOrig.size} ingresos: ` + [...g.costosOrig].map(c => parseFloat(c).toFixed(2)).join(' · ') : 'Costo único de la factura original'}">${g.costoOrig == null ? '—' : ({ USD: '$ ', EUR: '€ ' }[g.moneda] || 'S/. ') + g.costoOrig.toLocaleString('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 4 })}</td>
          <td data-col-tabla="stock-zonas" data-col="costo" data-valor="${g.costo}" class="${g.esPromedio ? 'costo-promedio' : ''}" style="text-align:right;${colStyle('stock-zonas','costo') ? ' display:none;' : ''}" title="${g.esPromedio ? `Promedio ponderado de ${g.costos.size} ingresos: ` + [...g.costos].map(c => 'S/. ' + parseFloat(c).toFixed(2)).join(' · ') : 'Costo único del lote'}">S/. ${g.costo.toLocaleString('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 4 })}</td>
          <td data-col-tabla="stock-zonas" data-col="acciones"${colStyle('stock-zonas','acciones')}>${esFam ? '<span style="color:var(--text-secondary); font-size:0.8rem;" title="Desactiva Agrupar por familia para trasladar lote por lote">—</span>' : `<button class="btn btn-small btn-secondary" onclick="window.abrirModalTrasladoDesdeResumenZona(${g.itemId}, ${g.ubicacion_id})">Trasladar</button>`}</td>
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
// Texto de una celda para Excel/PDF, sin los elementos marcados
// .solo-pantalla (ej. la etiqueta "Familia" de las filas agrupadas).
function _textoCeldaExport(celda) {
  if (!celda) return ''
  const copia = celda.cloneNode(true)
  copia.querySelectorAll('.solo-pantalla').forEach(el => el.remove())
  return copia.textContent.trim().replace(/\s+/g, ' ')
}

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
  // Columnas numéricas (2026-10-05): se exportan como NÚMERO real (desde
  // data-valor, sin redondeo de pantalla) para poder aplicar fórmulas en
  // Excel. Costo S/. además con formato moneda soles; Costo Orig. sin
  // formato (puede ser USD o PEN según la fila — la moneda va en su columna).
  const FORMATO_NUM = {
    cantidad:    '#,##0.00',
    unidades:    '#,##0',
    peso_unidad: '#,##0.0000',
    tc:          '0.000',
    costo_orig:  '#,##0.0000',
    costo:       '"S/." #,##0.0000'
  }
  const filasArray = filasAExportar.map(tr =>
    ths.map(th => {
      const col = th.dataset.col
      const celda = tr.querySelector(`[data-col="${col}"]`)
      if (FORMATO_NUM[col] && celda?.dataset.valor !== undefined) {
        const n = parseFloat(celda.dataset.valor)
        return Number.isFinite(n) ? n : ''
      }
      return _textoCeldaExport(celda)
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
    // Formato numérico por columna (fila de datos empieza en la 5ta: título,
    // fecha, vacía, encabezados).
    ths.forEach((th, c) => {
      const fmt = FORMATO_NUM[th.dataset.col]
      if (!fmt || fmt === 'General') return
      for (let r = 0; r < filasArray.length; r++) {
        const cell = ws[XLSX.utils.encode_cell({ r: r + 4, c })]
        if (cell && cell.t === 'n') cell.z = fmt
      }
    })
    // Título ocupando todo el ancho de la tabla (misma idea que el PDF, que
    // pone el título como texto suelto arriba de la tabla).
    ws['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: Math.max(0, encabezados.length - 1) } }]
    // Ancho de columna autoajustado al contenido más largo (encabezado o
    // dato) — lo más cerca que xlsx community permite de "se ve prolijo".
    ws['!cols'] = encabezados.map((h, i) => {
      const maxLen = Math.max(h.length, ...filasArray.map(f => String(f[i] ?? '').length))
      return { wch: Math.min(Math.max(maxLen + 2, 8), 90) }   // sin cortar: texto en una sola línea
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
      return _textoCeldaExport(celda)
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
    const fechaHoy = new Date().toISOString().slice(0, 10)
    // Cada celda en UNA sola línea: la letra se ajusta sola para que entre
    // en la hoja (pdfTablaUnaLinea, helpers.js — 2026-10-06).
    const NUM = new Set(['cantidad', 'unidades', 'peso_unidad', 'tc', 'costo_orig', 'costo'])
    const derecha = new Set(ths.map((th, i) => NUM.has(th.dataset.col) ? i : -1).filter(i => i >= 0))
    pdfTablaUnaLinea({
      jsPDF, titulo: 'Resumen de Stock — Por Ubicación', subtitulo: `Generado: ${_fechaDDMMAAAA(fechaHoy)}`,
      head: encabezados, body: filasTexto, derecha, archivo: `Resumen_Stock_Por_Ubicacion_${fechaHoy}.pdf`
    })
    showToast(`PDF exportado: ${filasAExportar.length} fila(s), ${ths.length} columna(s) ✅`, 'success')
  } catch (e) {
    console.error('exportarStockZonasPDF:', e)
    showToast('Error al generar el PDF: ' + e.message, 'danger')
  }
}
