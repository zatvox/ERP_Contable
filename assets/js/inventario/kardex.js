// ============================================================================
// inventario/kardex.js — parte de inventario.js (reorganizado 2026-09-25, sin cambios de lógica)
// Mapa completo de funciones: Claude outputs/glosario_funciones_erp.md
// ============================================================================
import { getItems, getLotes, getLotesByItemId, getAlmacenes, getUbicaciones, getKardexByItem, getVentas, getCompras, getContacts } from '../supabase-data.js'
import { showToast } from '../helpers.js'
import { convertirEnBuscador } from '../buscador-select.js'
import { _escInv } from './ajuste-inventario.js'

// ============================================================================
// KARDEX VALORIZADO (Método Promedio Ponderado)
// ============================================================================

export async function renderKardex() {
  try {
    // Items en vivo (no de una foto vieja) — mismo estándar que el resto del
    // sistema: refrescar la fuente de datos justo antes de poblar el select.
    const [items, zonas, almacenes] = await Promise.all([getItems(true), getUbicaciones(), getAlmacenes()])
    const container = document.getElementById('content-kardex')
    if (!container) return

    // Select real convertido a buscador (convertirEnBuscador), mismo
    // componente que Ventas/Compras — reemplaza el datalist nativo que tenía
    // antes (funcionaba, pero sin resaltado de coincidencias, sin botón de
    // limpiar y con estilo inconsistente entre navegadores).
    const itemsOrdenados = items
      .slice()
      .sort((a, b) => (a.nombre || a.name || '').localeCompare(b.nombre || b.name || ''))
    const opcionesHtml = itemsOrdenados.map(i => {
      const label = `${i.codigo || i.sku ? '(' + (i.codigo || i.sku) + ') ' : ''}${i.nombre || i.name}`
      return `<option value="${i.id}">${label}</option>`
    }).join('')

    // Opciones de zona (Almacén — Zona) para los filtros "Desde"/"A" —
    // incluye las zonas virtuales Partners/Customers y Partners/Vendors, que
    // ya son filas normales de `ubicaciones` (así el filtro también sirve
    // para ver solo las entradas/salidas hacia/desde afuera del almacén).
    const almacenMapTmp = {}
    for (const a of (almacenes || [])) almacenMapTmp[a.id] = a
    const opcionesZonaHtml = (zonas || [])
      .slice()
      .sort((a, b) => (almacenMapTmp[a.almacen_id]?.nombre || '').localeCompare(almacenMapTmp[b.almacen_id]?.nombre || '') || (a.nombre || '').localeCompare(b.nombre || ''))
      .map(z => `<option value="${z.id}">${almacenMapTmp[z.almacen_id]?.nombre || '?'} — ${z.nombre}</option>`)
      .join('')

    // Header en dos filas: título + acciones arriba (space-between), y
    // filtros abajo en 2 filas de 3 columnas fijas (buscador/lote/tipo arriba,
    // desde/a/mes abajo) — antes era un grid auto-fit de 1 sola fila con 6
    // campos, que reordenaba todo según el ancho disponible. Los botones de
    // lote/tipo usan .filtro-selectlike (mismo look que los <select> de al
    // lado) en vez de .btn-secondary, para que se vean como parte de la
    // barra de filtros y no como un botón de acción suelto.
    container.innerHTML = `
      <div class="col-menu card-corner-menu" id="kardexColMenu">
        <button type="button" class="card-menu-btn" onclick="window.toggleMenuColumnasKardex(event)" title="Elegir qué columnas mostrar">⋮</button>
        <div class="col-menu-dropdown" id="kardexColMenuDropdown"></div>
      </div>
      <div class="card-header" style="flex-direction:column; align-items:stretch; gap:10px;">
        <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:10px; padding-right:34px;">
          <h3 class="card-title">Kardex Valorizado — Promedio Ponderado</h3>
          <div style="display:flex; gap:8px; flex-wrap:wrap;">
            <button class="btn btn-primary btn-small" onclick="window.cargarKardex()">Ver Kardex</button>
            <button class="btn btn-secondary btn-small" onclick="window.abrirModalAjusteKardex()">+ Ajuste Inventario</button>
            <button class="btn btn-secondary btn-small" onclick="window.exportarKardexExcel()" title="Exporta las filas seleccionadas (o todas si no marcas ninguna) con las columnas actualmente visibles">📊 Exportar Excel</button>
          </div>
        </div>
        <div class="kardex-filtros-grid">
          <div class="kardex-filtros-fila">
            <select id="kardexItemSelect" onchange="window._poblarLoteFiltroKardex()">
              <option value="">-- Selecciona un producto --</option>${opcionesHtml}
            </select>
            <div class="col-menu" id="kardexFiltroLoteMenu">
              <button type="button" class="filtro-selectlike" onclick="window.toggleFiltroLoteKardex(event)" title="Filtrar por lote (varios a la vez)">
                <span id="kardexFiltroLoteLabel">Todos los lotes</span>
              </button>
              <div class="col-menu-dropdown" id="kardexFiltroLoteDropdown"></div>
            </div>
            <div class="col-menu" id="kardexFiltroTipoMenu">
              <button type="button" class="filtro-selectlike" onclick="window.toggleFiltroTipoKardex(event)" title="Filtrar por tipo de movimiento (varios a la vez)">
                <span id="kardexFiltroTipoLabel">Todos los tipos</span>
              </button>
              <div class="col-menu-dropdown" id="kardexFiltroTipoDropdown"></div>
            </div>
          </div>
          <div class="kardex-filtros-fila">
            <select id="kardexFiltroDesde" title="Filtrar por zona de origen (Desde)">
              <option value="">Desde: todas</option>${opcionesZonaHtml}
            </select>
            <select id="kardexFiltroA" title="Filtrar por zona de destino (A)">
              <option value="">A: todas</option>${opcionesZonaHtml}
            </select>
            <input type="month" id="kardexFiltroMes" title="Filtrar por mes">
          </div>
        </div>
      </div>
      <div id="kardex-body" style="padding:10px;">
        <p style="text-align:center; color:var(--text-secondary);">Escribe o selecciona un producto para ver su kardex.</p>
      </div>
    `
    convertirEnBuscador('kardexItemSelect', { placeholder: 'Escribe para buscar producto...', sinResultados: 'Sin productos' })
    _kardexLotesDisponibles = []
    _kardexLotesSeleccionados.clear()
    _kardexTiposSeleccionados.clear()
    _pintarMenuFiltroLoteKardex()
    _pintarMenuFiltroTipoKardex()
    _actualizarLabelFiltroLoteKardex()
    _actualizarLabelFiltroTipoKardex()
  } catch (e) {
    console.error('renderKardex:', e)
    showToast('Error al cargar kardex', 'danger')
  }
}

// ============================================================================
// KARDEX — Filtros de Lote y Tipo de Movimiento como MULTISELECT (checklist
// en dropdown, mismo patrón visual que el menú "⚙️ Columnas"). Selección
// vacía = "todos" (no filtra), igual que antes con el <select> en blanco.
// ============================================================================
let _kardexLotesDisponibles = [] // [{id, numero_lote}] del producto elegido
const _kardexLotesSeleccionados = new Set()
const _kardexTiposSeleccionados = new Set()

const KARDEX_TIPOS_MOV = [
  { value: 'entrada', label: 'Entrada (compra)' },
  { value: 'salida', label: 'Salida (venta)' },
  { value: 'traslado_interno', label: 'Traslado interno' },
  { value: 'ajuste_entrada', label: 'Ajuste — entrada' },
  { value: 'ajuste_salida', label: 'Ajuste — salida' }
]

// Puebla el filtro de Lote con los lotes DEL PRODUCTO elegido (no todos los
// lotes del sistema) — se llama al cambiar de producto en el buscador.
window._poblarLoteFiltroKardex = async function () {
  const itemId = parseInt(document.getElementById('kardexItemSelect')?.value || 0)
  _kardexLotesSeleccionados.clear()
  if (!itemId) {
    _kardexLotesDisponibles = []
  } else {
    const [lotes, movs] = await Promise.all([getLotesByItemId(itemId), getKardexByItem(itemId)])
    // Solo lotes con al menos un movimiento de kardex real. Un lote sin
    // movimientos (ej. "fantasma": una edición de guía borró su kardex pero
    // el lote en sí no se pudo eliminar — ver _guardarEdicionGuiaIngreso en
    // compras.js, bug encontrado 2026-09-16) no sirve para filtrar y solo
    // confunde en este dropdown.
    const idsConMovimiento = new Set((movs || []).map(m => m.lote_id))
    _kardexLotesDisponibles = (lotes || [])
      .filter(l => idsConMovimiento.has(l.id))
      .slice()
      .sort((a, b) => (a.numero_lote || '').localeCompare(b.numero_lote || '', 'es', { numeric: true }))
  }
  _pintarMenuFiltroLoteKardex()
  _actualizarLabelFiltroLoteKardex()
}

function _pintarMenuFiltroLoteKardex() {
  const dd = document.getElementById('kardexFiltroLoteDropdown')
  if (!dd) return
  if (_kardexLotesDisponibles.length === 0) {
    dd.innerHTML = '<span style="padding:4px 6px; font-size:0.85rem; color:var(--text-secondary);">Elige un producto primero</span>'
    return
  }
  dd.innerHTML = _kardexLotesDisponibles.map(l => `
    <label><input type="checkbox" data-lote-id="${l.id}" ${_kardexLotesSeleccionados.has(l.id) ? 'checked' : ''} onchange="window._toggleFiltroLoteKardex(${l.id}, this.checked)"> ${_escInv(l.numero_lote || ('#' + l.id))}</label>
  `).join('')
}

function _pintarMenuFiltroTipoKardex() {
  const dd = document.getElementById('kardexFiltroTipoDropdown')
  if (!dd) return
  dd.innerHTML = KARDEX_TIPOS_MOV.map(t => `
    <label><input type="checkbox" data-tipo="${t.value}" ${_kardexTiposSeleccionados.has(t.value) ? 'checked' : ''} onchange="window._toggleFiltroTipoKardex('${t.value}', this.checked)"> ${t.label}</label>
  `).join('')
}

function _actualizarLabelFiltroLoteKardex() {
  const label = document.getElementById('kardexFiltroLoteLabel')
  if (!label) return
  const n = _kardexLotesSeleccionados.size
  label.textContent = n === 0 ? 'Todos los lotes' : n === 1
    ? (_kardexLotesDisponibles.find(l => _kardexLotesSeleccionados.has(l.id))?.numero_lote || '1 lote')
    : `${n} lotes seleccionados`
}

function _actualizarLabelFiltroTipoKardex() {
  const label = document.getElementById('kardexFiltroTipoLabel')
  if (!label) return
  const n = _kardexTiposSeleccionados.size
  label.textContent = n === 0 ? 'Todos los tipos' : n === 1
    ? (KARDEX_TIPOS_MOV.find(t => _kardexTiposSeleccionados.has(t.value))?.label || '1 tipo')
    : `${n} tipos seleccionados`
}

window._toggleFiltroLoteKardex = function (loteId, checked) {
  if (checked) _kardexLotesSeleccionados.add(loteId); else _kardexLotesSeleccionados.delete(loteId)
  _actualizarLabelFiltroLoteKardex()
}

window._toggleFiltroTipoKardex = function (tipo, checked) {
  if (checked) _kardexTiposSeleccionados.add(tipo); else _kardexTiposSeleccionados.delete(tipo)
  _actualizarLabelFiltroTipoKardex()
}

window.toggleFiltroLoteKardex = function (ev) {
  ev?.stopPropagation()
  const menu = document.getElementById('kardexFiltroLoteMenu')
  if (!menu) return
  const abriendo = !menu.classList.contains('open')
  document.getElementById('kardexFiltroTipoMenu')?.classList.remove('open')
  if (abriendo) _pintarMenuFiltroLoteKardex()
  menu.classList.toggle('open', abriendo)
}

window.toggleFiltroTipoKardex = function (ev) {
  ev?.stopPropagation()
  const menu = document.getElementById('kardexFiltroTipoMenu')
  if (!menu) return
  const abriendo = !menu.classList.contains('open')
  document.getElementById('kardexFiltroLoteMenu')?.classList.remove('open')
  if (abriendo) _pintarMenuFiltroTipoKardex()
  menu.classList.toggle('open', abriendo)
}

// Cierra cualquier menú .col-menu abierto (Columnas, Lote, Tipo) al hacer
// click fuera — un solo listener global para los 3, registrado una vez.
if (!window._kardexMenusListener) {
  window._kardexMenusListener = true
  document.addEventListener('click', (ev) => {
    document.querySelectorAll('.col-menu.open').forEach(menu => {
      if (!menu.contains(ev.target)) menu.classList.remove('open')
    })
  })
}

let _kardexOrdenFecha = 'asc' // 'asc' | 'desc' — se conserva entre recargas hasta que el usuario haga click en el header

// Ojo: NO se usa `new Date(fecha).toLocaleDateString()` acá — `fecha` viene
// como 'AAAA-MM-DD' (fecha sin hora) de Supabase, y JS la interpreta como
// medianoche UTC; en un huso horario negativo (Perú, UTC-5) eso muestra el
// día ANTERIOR al convertir a hora local (23/08 se veía como 22/08). Se
// parsea el string directo, sin pasar por Date, para evitar ese corrimiento.
export function _fechaDDMMAAAA(fechaISO) {
  if (!fechaISO) return '-'
  const m = String(fechaISO).match(/^(\d{4})-(\d{2})-(\d{2})/)
  return m ? `${m[3]}/${m[2]}/${m[1]}` : fechaISO
}

/** Invierte el orden de la tabla por fecha y vuelve a pintar (sin re-pedir datos, ya están cargados en pantalla). */
window.ordenarKardexPorFecha = function () {
  _kardexOrdenFecha = _kardexOrdenFecha === 'asc' ? 'desc' : 'asc'
  window.cargarKardex()
}

// ============================================================================
// KARDEX — Menú de columnas mostrar/ocultar (persistido en localStorage)
// ============================================================================
// Cada <th>/<td> de la tabla lleva un atributo data-col="clave" — ocultar una
// columna solo pone display:none en esas celdas (la tabla no usa
// table-layout:fixed, así que el resto se reacomoda solo, sin huecos ni
// desbordes). El estado se guarda por navegador, no por usuario del sistema.
const KARDEX_COLS_KEY = 'kardexColumnasVisibles'

function _kardexColDefs() {
  return [
    { key: 'sel',        label: 'Seleccionar' },
    { key: 'id',         label: 'ID' },
    { key: 'fecha',      label: 'Fecha' },
    { key: 'tipo',       label: 'Tipo Movimiento' },
    { key: 'concepto',   label: 'Concepto' },
    { key: 'contacto',   label: 'Contacto' },
    { key: 'docref',     label: 'Doc. Referencia' },
    { key: 'lote',       label: 'Lote' },
    { key: 'desde',      label: 'Desde' },
    { key: 'a',          label: 'A' },
    { key: 'entrada',    label: 'Entrada' },
    { key: 'salida',     label: 'Salida' },
    { key: 'unidentrada', label: 'Unid. Entrada' },
    { key: 'unidsalida',  label: 'Unid. Salida' },
    { key: 'costounit',  label: 'Costo Unit.' },
    { key: 'costototal', label: 'Costo Total' },
    { key: 'saldocant',  label: 'Saldo Cant.' },
    { key: 'saldovalor', label: 'Saldo Valor' },
    { key: 'tc',         label: 'T.C.' },
    { key: 'acciones',   label: 'Acciones' }
  ]
}

function _kardexColsVisibles() {
  let guardado = {}
  try { guardado = JSON.parse(localStorage.getItem(KARDEX_COLS_KEY) || '{}') } catch { guardado = {} }
  const cols = {}
  for (const c of _kardexColDefs()) cols[c.key] = guardado[c.key] !== false // todas visibles por defecto
  return cols
}

function _kardexColStyle(cols, key) {
  return cols[key] ? '' : ' style="display:none;"'
}

// Pinta los checkboxes del menú desplegable (una sola vez; los toggles luego
// solo tocan display, no vuelven a pintar la tabla).
function _pintarMenuColumnasKardex() {
  const dd = document.getElementById('kardexColMenuDropdown')
  if (!dd) return
  const cols = _kardexColsVisibles()
  dd.innerHTML = _kardexColDefs().map(c => `
    <label><input type="checkbox" data-colkey="${c.key}" ${cols[c.key] ? 'checked' : ''} onchange="window._toggleColumnaKardex('${c.key}', this.checked)"> ${c.label}</label>
  `).join('')
}

window.toggleMenuColumnasKardex = function (ev) {
  ev?.stopPropagation()
  const menu = document.getElementById('kardexColMenu')
  if (!menu) return
  const abriendo = !menu.classList.contains('open')
  if (abriendo) _pintarMenuColumnasKardex()
  menu.classList.toggle('open', abriendo)
}

// Cierra el menú al hacer click fuera — se registra una sola vez por carga
// de página (el listener vive en window, no en el menú que se re-pinta).
if (!window._kardexColMenuListener) {
  window._kardexColMenuListener = true
  document.addEventListener('click', (ev) => {
    const menu = document.getElementById('kardexColMenu')
    if (menu && !menu.contains(ev.target)) menu.classList.remove('open')
  })
}

window._toggleColumnaKardex = function (key, visible) {
  const cols = _kardexColsVisibles()
  cols[key] = visible
  localStorage.setItem(KARDEX_COLS_KEY, JSON.stringify(cols))
  document.querySelectorAll(`#kardex-body [data-col="${key}"]`).forEach(el => {
    el.style.display = visible ? '' : 'none'
  })
}

// Checkbox "seleccionar todo" del header — marca/desmarca todas las filas de
// datos (la fila de totales no tiene checkbox).
window._kardexToggleSelTodo = function (checked) {
  document.querySelectorAll('#kardex-body .kardex-sel').forEach(chk => { chk.checked = checked })
}

// ============================================================================
// KARDEX — Exportar a Excel (respeta filas marcadas y columnas visibles)
// ============================================================================
// Lee directamente del DOM ya renderizado (no vuelve a pedir datos ni
// recalcula nada): así lo que se exporta es exactamente "lo que se ve" en
// pantalla — mismas columnas mostradas/ocultas del menú ⚙️ Columnas, mismo
// orden, mismo filtro aplicado. Si el usuario marcó checkboxes, exporta solo
// esas filas; si no marcó ninguna, exporta todas las filas visibles.
window.exportarKardexExcel = async function () {
  const tabla = document.querySelector('#kardex-body table')
  if (!tabla) { showToast('Primero carga un Kardex para poder exportarlo', 'warning'); return }

  // Columnas a exportar: las visibles del thead, sin el checkbox ni Acciones
  // (no son datos exportables).
  const thsExcluidos = new Set(['sel', 'acciones'])
  const ths = Array.from(tabla.querySelectorAll('thead th'))
    .filter(th => th.style.display !== 'none' && !thsExcluidos.has(th.dataset.col))

  if (ths.length === 0) { showToast('No hay columnas visibles para exportar', 'warning'); return }

  const filasDatos = Array.from(tabla.querySelectorAll('tbody tr'))
    .filter(tr => !tr.classList.contains('kardex-fila-totales') && tr.dataset.movId)

  const marcadas = filasDatos.filter(tr => tr.querySelector('.kardex-sel')?.checked)
  const filasAExportar = marcadas.length > 0 ? marcadas : filasDatos

  if (filasAExportar.length === 0) { showToast('No hay movimientos para exportar', 'warning'); return }

  const filasJson = filasAExportar.map(tr => {
    const fila = {}
    for (const th of ths) {
      const key = th.dataset.col
      const label = th.textContent.trim().replace(/[▲▼]/g, '').trim()
      const celda = tr.querySelector(`[data-col="${key}"]`)
      fila[label] = celda ? celda.textContent.trim().replace(/\s+/g, ' ') : ''
    }
    return fila
  })

  try {
    const XLSX = await import('https://cdn.jsdelivr.net/npm/xlsx@0.18.5/+esm')
    const ws = XLSX.utils.json_to_sheet(filasJson)
    // Ancho de columna al texto más largo: cada celda en una sola línea (2026-10-06)
    const _cab = Object.keys(filasJson[0] || {})
    ws['!cols'] = _cab.map(k => ({ wch: Math.min(90, Math.max(k.length, ...filasJson.map(f => String(f[k] ?? '').length)) + 2) }))
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Kardex')

    const nombreProducto = document.getElementById('kardexItemSelect')?.selectedOptions?.[0]?.textContent?.trim() || 'Producto'
    const fechaHoy = new Date().toISOString().slice(0, 10)
    XLSX.writeFile(wb, `Kardex_${nombreProducto.replace(/[^\w\-]+/g, '_')}_${fechaHoy}.xlsx`)

    showToast(`Excel exportado: ${filasAExportar.length} fila(s), ${ths.length} columna(s) ✅`, 'success')
  } catch (e) {
    console.error('exportarKardexExcel:', e)
    showToast('Error al generar el Excel: ' + e.message, 'danger')
  }
}

window.cargarKardex = async function() {
  const itemId  = parseInt(document.getElementById('kardexItemSelect')?.value || 0)
  const filtroMes   = document.getElementById('kardexFiltroMes')?.value
  const filtroLotes = _kardexLotesSeleccionados // Set<number>, vacío = todos
  const filtroTipos = _kardexTiposSeleccionados // Set<string>, vacío = todos
  const filtroDesde = parseInt(document.getElementById('kardexFiltroDesde')?.value || 0) || null
  const filtroA     = parseInt(document.getElementById('kardexFiltroA')?.value || 0) || null
  const body    = document.getElementById('kardex-body')

  if (!itemId) { showToast('Escribe y selecciona un producto de la lista', 'warning'); return }
  if (body) body.innerHTML = '<p style="padding:20px;">Cargando...</p>'

  try {
    const [items, zonas, almacenes, lotes, ventas, compras, contacts] = await Promise.all([
      getItems(), getUbicaciones(), getAlmacenes(), getLotes(), getVentas(), getCompras(), getContacts()
    ])
    const item  = items.find(i => i.id === itemId)
    let movs    = await getKardexByItem(itemId)

    if (filtroMes)   movs = movs.filter(m => (m.fecha || '').startsWith(filtroMes))
    if (filtroLotes.size) movs = movs.filter(m => filtroLotes.has(m.lote_id))
    if (filtroTipos.size) movs = movs.filter(m => filtroTipos.has(m.tipo_movimiento))
    if (filtroDesde) movs = movs.filter(m => m.ubicacion_origen_id === filtroDesde)
    if (filtroA)     movs = movs.filter(m => m.ubicacion_destino_id === filtroA)

    movs = movs.sort((a, b) => (new Date(a.fecha) - new Date(b.fecha) || a.id - b.id) * (_kardexOrdenFecha === 'desc' ? -1 : 1))

    // "Desde" / "A": Almacén/Zona real, o Partners/Vendors — Partners/Customers
    // para el lado externo (proveedor/cliente), estilo Odoo.
    const almacenMap = {}
    for (const a of (almacenes || [])) almacenMap[a.id] = a
    const zonaNombre = (ubicacionId) => {
      if (!ubicacionId) return '-'
      const z = (zonas || []).find(x => x.id === ubicacionId)
      if (!z) return `Zona #${ubicacionId}`
      return `${almacenMap[z.almacen_id]?.nombre || '?'}/${z.nombre}`
    }

    // El kardex guarda lote_id, no el número. Con el costeo por
    // identificación específica el lote es la información más importante de
    // cada fila: es lo que explica por qué dos salidas del mismo producto
    // tienen costos unitarios distintos.
    const loteMap = {}
    for (const l of (lotes || [])) loteMap[l.id] = l
    const loteEtiqueta = (loteId) => {
      if (!loteId) return '<span style="color:var(--text-secondary);">—</span>'
      const l = loteMap[loteId]
      // Un lote borrado (guía eliminada) deja el movimiento huérfano: se
      // muestra el id para poder rastrearlo en vez de un guión mudo.
      if (!l) return `<span style="color:var(--color-warning);" title="El lote ya no existe">#${loteId}</span>`
      return `<span title="Lote ${l.numero_lote} · costo unit. ${(parseFloat(l.costo_unitario) || 0).toFixed(4)}">${_escInv(l.numero_lote || ('#' + loteId))}</span>`
    }

    // Contacto (cliente si el movimiento viene de una venta, proveedor si
    // viene de una compra) — un traslado interno o un ajuste de inventario
    // no tiene contraparte externa, se muestra un guión.
    const ventaMap = {}
    for (const v of (ventas || [])) ventaMap[v.id] = v
    const compraMap = {}
    for (const c of (compras || [])) compraMap[c.id] = c
    const contactMap = {}
    for (const c of (contacts || [])) contactMap[c.id] = c
    const contactoEtiqueta = (m) => {
      const guion = '<span style="color:var(--text-secondary);">—</span>'
      if (m.venta_id) {
        const v = ventaMap[m.venta_id]
        const nombre = v ? contactMap[v.contact_id]?.nombre : null
        return nombre ? _escInv(nombre) : (v ? guion : `<span style="color:var(--color-warning);" title="La venta ya no existe">#${m.venta_id}</span>`)
      }
      if (m.compra_id) {
        const c = compraMap[m.compra_id]
        const nombre = c ? (contactMap[c.contact_id]?.nombre || c.proveedor_nombre) : null
        return nombre ? _escInv(nombre) : (c ? guion : `<span style="color:var(--color-warning);" title="La compra ya no existe">#${m.compra_id}</span>`)
      }
      return guion
    }

    const cols = _kardexColsVisibles()

    const totalEntradas = movs.filter(m => m.cantidad_entrada > 0).reduce((s, m) => s + parseFloat(m.cantidad_entrada || 0), 0)
    const totalSalidas  = movs.filter(m => m.cantidad_salida  > 0).reduce((s, m) => s + parseFloat(m.cantidad_salida  || 0), 0)

    // items NO tiene columnas stock_actual/costo_promedio (por eso estas
    // tarjetas siempre daban 0) — se calculan igual que en "Resumen de
    // Stock": stock físico real = suma de lotes.cantidad de este producto,
    // costo promedio = valor total / stock total.
    const lotesItem  = (lotes || []).filter(l => l.item_id === itemId)
    const stockActual = lotesItem.reduce((s, l) => s + (parseFloat(l.cantidad) || 0), 0)
    const valorTotal   = lotesItem.reduce((s, l) => s + (parseFloat(l.cantidad) || 0) * (parseFloat(l.costo_unitario) || 0), 0)
    const costoPromedio = stockActual > 0 ? valorTotal / stockActual : 0

    let html = `
      <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(160px,1fr)); gap:12px; margin-bottom:15px;">
        <div class="card" style="padding:12px; text-align:center;">
          <div style="font-size:0.8rem; color:var(--text-secondary);">Stock Actual</div>
          <div style="font-size:1.4rem; font-weight:bold;">${stockActual.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
        </div>
        <div class="card" style="padding:12px; text-align:center;">
          <div style="font-size:0.8rem; color:var(--text-secondary);">Costo Promedio</div>
          <div style="font-size:1.4rem; font-weight:bold; color:var(--color-info);">S/ ${costoPromedio.toLocaleString('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 4 })}</div>
        </div>
        <div class="card" style="padding:12px; text-align:center;">
          <div style="font-size:0.8rem; color:var(--text-secondary);">Valor Total</div>
          <div style="font-size:1.4rem; font-weight:bold; color:var(--color-success);">S/ ${valorTotal.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
        </div>
        <div class="card" style="padding:12px; text-align:center;">
          <div style="font-size:0.8rem; color:var(--text-secondary);">Entradas (período)</div>
          <div style="font-size:1.2rem; font-weight:bold; color:var(--color-success);">+${totalEntradas.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
        </div>
        <div class="card" style="padding:12px; text-align:center;">
          <div style="font-size:0.8rem; color:var(--text-secondary);">Salidas (período)</div>
          <div style="font-size:1.2rem; font-weight:bold; color:var(--color-danger);">-${totalSalidas.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
        </div>
      </div>

      <div class="table-container">
        <table>
          <thead>
            <tr>
              <th data-col="sel"${_kardexColStyle(cols, 'sel')}><input type="checkbox" id="kardexSelAll" title="Seleccionar todo" onchange="window._kardexToggleSelTodo(this.checked)"></th>
              <th data-col="id"${_kardexColStyle(cols, 'id')}>ID</th>
              <th data-col="fecha" style="cursor:pointer; user-select:none; white-space:nowrap; min-width:110px;${cols.fecha ? '' : ' display:none;'}" onclick="window.ordenarKardexPorFecha()" title="Ordenar por fecha">Fecha ${_kardexOrdenFecha === 'asc' ? '▲' : '▼'}</th><th data-col="tipo"${_kardexColStyle(cols, 'tipo')}>Tipo Movimiento</th><th data-col="concepto"${_kardexColStyle(cols, 'concepto')}>Concepto</th>
              <th data-col="contacto"${_kardexColStyle(cols, 'contacto')}>Contacto</th>
              <th data-col="docref"${_kardexColStyle(cols, 'docref')}>Doc. Ref.</th><th data-col="lote"${_kardexColStyle(cols, 'lote')}>Lote</th><th data-col="desde"${_kardexColStyle(cols, 'desde')}>Desde</th><th data-col="a"${_kardexColStyle(cols, 'a')}>A</th>
              <th data-col="entrada" style="text-align:right;${cols.entrada ? '' : ' display:none;'}">Entrada</th>
              <th data-col="salida" style="text-align:right;${cols.salida ? '' : ' display:none;'}">Salida</th>
              <th data-col="unidentrada" style="text-align:right;${cols.unidentrada ? '' : ' display:none;'}">Unid. Entrada</th>
              <th data-col="unidsalida" style="text-align:right;${cols.unidsalida ? '' : ' display:none;'}">Unid. Salida</th>
              <th data-col="costounit" style="text-align:right;${cols.costounit ? '' : ' display:none;'}">Costo Unit.</th>
              <th data-col="costototal" style="text-align:right;${cols.costototal ? '' : ' display:none;'}">Costo Total</th>
              <th data-col="saldocant" style="text-align:right;${cols.saldocant ? '' : ' display:none;'}">Saldo Cant.</th>
              <th data-col="saldovalor" style="text-align:right;${cols.saldovalor ? '' : ' display:none;'}">Saldo Valor</th>
              <th data-col="tc" style="text-align:right;${cols.tc ? '' : ' display:none;'}">T.C.</th>
              <th data-col="acciones"${_kardexColStyle(cols, 'acciones')}>Acciones</th>
            </tr>
          </thead>
          <tbody>
    `

    if (movs.length === 0) {
      const colsVisibles = Object.values(cols).filter(Boolean).length
      html += `<tr><td colspan="${colsVisibles}" style="text-align:center;">Sin movimientos en este período.</td></tr>`
    } else {
      let totEntrada = 0, totSalida = 0, totValorEntrada = 0, totValorSalida = 0
      let totUnidEntrada = 0, totUnidSalida = 0
      movs.forEach(m => {
        const entrada      = parseFloat(m.cantidad_entrada || 0)
        const salida       = parseFloat(m.cantidad_salida  || 0)
        const unidEntrada  = parseFloat(m.cantidad_unidades_entrada || 0)
        const unidSalida   = parseFloat(m.cantidad_unidades_salida  || 0)
        const costoUnit    = parseFloat(m.costo_unitario   || 0)
        const valorEntradaMov = parseFloat(m.valor_entrada || 0)
        const valorSalidaMov  = parseFloat(m.valor_salida  || 0)
        // costo_total se reemplazó por valor_entrada/valor_salida (mismo
        // patrón que cantidad_entrada/cantidad_salida): solo uno de los dos
        // es distinto de 0 por fila, así que sumarlos da el valor de ESTE
        // movimiento puntual (para la columna). Para el TOTAL del período no
        // se suman entre sí — mezclaría compras con costo de venta — se
        // acumulan por separado (totValorEntrada / totValorSalida).
        // Traslado interno: valor_entrada = valor_salida (mismo costo entra y
        // sale), así que el valor del movimiento es uno solo, no la suma.
        const costoTotal   = m.tipo_movimiento === 'traslado_interno'
          ? Math.max(valorEntradaMov, valorSalidaMov)
          : valorEntradaMov + valorSalidaMov
        const saldoCant    = parseFloat(m.saldo_cantidad   || 0)
        const saldoValor   = parseFloat(m.saldo_valor      || 0)
        const tipoColor    = m.tipo_movimiento?.includes('entrada') || m.tipo_movimiento === 'entrada'
          ? 'color:var(--color-success)' : 'color:var(--color-danger)'
        const tipoCambioMov = parseFloat(m.tipo_cambio || 1)

        totEntrada += entrada
        totSalida += salida
        totUnidEntrada += unidEntrada
        totUnidSalida  += unidSalida
        totValorEntrada += valorEntradaMov
        totValorSalida  += valorSalidaMov

        html += `<tr data-mov-id="${m.id}">
          <td data-col="sel"${_kardexColStyle(cols, 'sel')}><input type="checkbox" class="kardex-sel" value="${m.id}"></td>
          <td data-col="id" style="font-size:0.82rem; color:var(--text-secondary);${cols.id ? '' : ' display:none;'}">${m.id}</td>
          <td data-col="fecha" style="white-space:nowrap;${cols.fecha ? '' : ' display:none;'}">${_fechaDDMMAAAA(m.fecha)}</td>
          <td data-col="tipo"${_kardexColStyle(cols, 'tipo')}><span style="${tipoColor}; font-weight:bold;">${m.tipo_movimiento || '-'}</span></td>
          <td data-col="concepto"${_kardexColStyle(cols, 'concepto')}>${m.concepto || '-'}</td>
          <td data-col="contacto" style="font-size:0.82rem;${cols.contacto ? '' : ' display:none;'}">${contactoEtiqueta(m)}</td>
          <td data-col="docref" style="font-size:0.82rem;${cols.docref ? '' : ' display:none;'}">${m.documento_referencia || '-'}</td>
          <td data-col="lote" style="font-size:0.82rem; font-weight:600;${cols.lote ? '' : ' display:none;'}">${loteEtiqueta(m.lote_id)}</td>
          <td data-col="desde" style="font-size:0.82rem;${cols.desde ? '' : ' display:none;'}">${zonaNombre(m.ubicacion_origen_id)}</td>
          <td data-col="a" style="font-size:0.82rem;${cols.a ? '' : ' display:none;'}">${zonaNombre(m.ubicacion_destino_id)}</td>
          <td data-col="entrada" style="text-align:right; color:var(--color-success);${cols.entrada ? '' : ' display:none;'}">${entrada > 0 ? entrada.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : ''}</td>
          <td data-col="salida" style="text-align:right; color:var(--color-danger);${cols.salida ? '' : ' display:none;'}">${salida > 0 ? salida.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : ''}</td>
          <td data-col="unidentrada" style="text-align:right; color:var(--color-success);${cols.unidentrada ? '' : ' display:none;'}">${unidEntrada > 0 ? unidEntrada.toLocaleString('en-US', { maximumFractionDigits: 2 }) : ''}</td>
          <td data-col="unidsalida" style="text-align:right; color:var(--color-danger);${cols.unidsalida ? '' : ' display:none;'}">${unidSalida > 0 ? unidSalida.toLocaleString('en-US', { maximumFractionDigits: 2 }) : ''}</td>
          <td data-col="costounit" style="text-align:right;${cols.costounit ? '' : ' display:none;'}">${costoUnit.toLocaleString('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 4 })}</td>
          <td data-col="costototal" style="text-align:right;${cols.costototal ? '' : ' display:none;'}">${costoTotal.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
          <td data-col="saldocant" style="text-align:right; font-weight:bold;${cols.saldocant ? '' : ' display:none;'}">${saldoCant.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
          <td data-col="saldovalor" style="text-align:right; font-weight:bold;${cols.saldovalor ? '' : ' display:none;'}">${saldoValor.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
          <td data-col="tc" style="text-align:right;${cols.tc ? '' : ' display:none;'}">${tipoCambioMov.toFixed(3)}</td>
          <td data-col="acciones"${_kardexColStyle(cols, 'acciones')}>${m.tipo_movimiento === 'traslado_interno' ? `
            <button class="btn btn-small btn-secondary" onclick="window.editarTrasladoInterno(${m.id})">Editar</button>
            <button class="btn btn-small btn-danger" onclick="window.eliminarTrasladoInterno(${m.id})">Eliminar</button>
          ` : ''}</td>
        </tr>`
      })

      // Fila de totales: un <td data-col> por columna (sin colspan) para que
      // cada columna se pueda ocultar de forma independiente sin descuadrar
      // el resto — "Totales del período:" se ancla en la última columna de
      // texto ("A") en vez de un colspan fijo sobre las primeras N columnas.
      html += `<tr class="kardex-fila-totales" style="border-top:2px solid var(--border-color); font-weight:bold;">
        <td data-col="sel"${_kardexColStyle(cols, 'sel')}></td>
        <td data-col="id"${_kardexColStyle(cols, 'id')}></td>
        <td data-col="fecha"${_kardexColStyle(cols, 'fecha')}></td>
        <td data-col="tipo"${_kardexColStyle(cols, 'tipo')}></td>
        <td data-col="concepto"${_kardexColStyle(cols, 'concepto')}></td>
        <td data-col="contacto"${_kardexColStyle(cols, 'contacto')}></td>
        <td data-col="docref"${_kardexColStyle(cols, 'docref')}></td>
        <td data-col="lote"${_kardexColStyle(cols, 'lote')}></td>
        <td data-col="desde"${_kardexColStyle(cols, 'desde')}></td>
        <td data-col="a" style="text-align:right;${cols.a ? '' : ' display:none;'}">Totales del período:</td>
        <td data-col="entrada" style="text-align:right; color:var(--color-success);${cols.entrada ? '' : ' display:none;'}">${totEntrada.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
        <td data-col="salida" style="text-align:right; color:var(--color-danger);${cols.salida ? '' : ' display:none;'}">${totSalida.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
        <td data-col="unidentrada" style="text-align:right; color:var(--color-success);${cols.unidentrada ? '' : ' display:none;'}">${totUnidEntrada.toLocaleString('en-US', { maximumFractionDigits: 2 })}</td>
        <td data-col="unidsalida" style="text-align:right; color:var(--color-danger);${cols.unidsalida ? '' : ' display:none;'}">${totUnidSalida.toLocaleString('en-US', { maximumFractionDigits: 2 })}</td>
        <td data-col="costounit"${_kardexColStyle(cols, 'costounit')}></td>
        <td data-col="costototal" style="text-align:right; font-size:0.82rem;${cols.costototal ? '' : ' display:none;'}">
          ${totValorEntrada > 0 ? `<div style="color:var(--color-success);">+${totValorEntrada.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>` : ''}
          ${totValorSalida > 0 ? `<div style="color:var(--color-danger);">-${totValorSalida.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>` : ''}
        </td>
        <td data-col="saldocant"${_kardexColStyle(cols, 'saldocant')}></td>
        <td data-col="saldovalor"${_kardexColStyle(cols, 'saldovalor')}></td>
        <td data-col="tc"${_kardexColStyle(cols, 'tc')}></td>
        <td data-col="acciones"${_kardexColStyle(cols, 'acciones')}></td>
      </tr>`
    }

    html += '</tbody></table></div>'
    body.innerHTML = html
  } catch (e) {
    console.error('cargarKardex:', e)
    body.innerHTML = `<p style="color:var(--color-danger); text-align:center; padding:20px;">Error al cargar el kardex: ${e.message}</p>`
  }
}
