// ============================================================================
// compras/guias-ingreso-nueva.js — parte de compras.js (reorganizado 2026-09-25, sin cambios de lógica)
// Mapa completo de funciones: Claude outputs/glosario_funciones_erp.md
// ============================================================================
import { S } from './state.js'
import { getCurrentUser } from '../auth-supabase.js'
import { getComprasPage, getCompraById, getCompraDetalles, getLoteById, getLotes, addLote, updateLote, getItems, getMarcas, getGuiasIngresoCompra, addGuiaIngresoCompra, addDetalleGuiaIngresoCompra, getTodosDetalleCompras, getTodosDetalleGuiasIngresoCompra, getAlmacenes, getUbicaciones, addStockUbicacion, getUbicacionVendors, addKardexMovimiento, ultimoErrorInsert, updateStockUbicacion, getStockUbicacionesByLote, generarAsientoGuiaRemision, addLoteBulto, recalcularLoteDesdeBultos } from '../supabase-data.js'
import { ASIENTOS_AUTO_COMPRAS_ACTIVO } from '../config-asientos-auto.js'
import { showToast, formatQty } from '../helpers.js'
import { convertirEnBuscador, refrescarBuscador } from '../buscador-select.js'
import { _invalidarCacheCompras } from './anulacion.js'
import { _escCompras } from './buscadores.js'
import { renderCompras } from './compras-lista.js'
import { _guardarEdicionGuiaIngreso } from './guias-ingreso-detalle.js'
import { _cargarComprasConGuia, renderGuias } from './guias-ingreso-lista.js'

window.abrirModalNuevaGuia = async function () {
  try {
    S._guiaLineas = []
    S._guiaIngresoEditId = null
    const form = document.getElementById('formNuevaGuia')
    if (form) form.reset()
    document.getElementById('ngInfoCompra').style.display = 'none'
    document.getElementById('ngFechaGuia').value = new Date().toISOString().split('T')[0]
    document.getElementById('tabla-detalle-guia').innerHTML =
      '<p style="text-align:center; color:var(--text-secondary); padding:20px;">Selecciona una compra para ver sus productos.</p>'

    const titulo = document.getElementById('ng-titulo-modal')
    if (titulo) titulo.textContent = 'Nueva Guía de Remisión'
    const aviso = document.getElementById('ng-edicion-aviso')
    if (aviso) aviso.style.display = 'none'
    const selCompra = document.getElementById('ngCompra')
    if (selCompra) selCompra.disabled = false
    const btnGuardar = document.getElementById('btnGuardarGuiaIngresoCompra')
    if (btnGuardar) btnGuardar.textContent = 'Guardar Guía (ingresa stock)'

    await _cargarComprasSelectGuia()
    window.openModal('modal-nueva-guia')
  } catch (error) {
    console.error('Error en abrirModalNuevaGuia:', error)
    showToast('Error al abrir el formulario de guía', 'danger')
  }
}

// Cuánto se ha recibido ya, por línea de compra (detalle_compra_id), sumando
// TODAS las guías NO anuladas de esa línea (una compra puede recibirse en
// varias guías parciales). Se usa tanto para decidir qué compras siguen
// "pendientes de guía" como para prellenar cada recepción con lo que falta,
// no con el total comprado de nuevo.
export async function _getCantidadesRecibidasPorDetalle() {
  const [guias, detallesGuia] = await Promise.all([
    getGuiasIngresoCompra(),
    getTodosDetalleGuiasIngresoCompra()
  ])
  const guiaAnulada = new Map((guias || []).map(g => [g.id, g.estado === 'anulada']))
  const acumulado = new Map() // detalle_compra_id -> cantidad recibida
  for (const dg of (detallesGuia || [])) {
    if (!dg.detalle_compra_id || guiaAnulada.get(dg.guia_id)) continue
    acumulado.set(dg.detalle_compra_id, (acumulado.get(dg.detalle_compra_id) || 0) + (parseFloat(dg.cantidad) || 0))
  }
  return acumulado
}

async function _cargarComprasSelectGuia() {
  const select = document.getElementById('ngCompra')
  if (!select) return

  // Solo compras de mercadería con algo pendiente de recibir: se compara,
  // línea por línea (detalle_compras.cantidad), lo comprado contra lo ya
  // recibido en TODAS sus guías no anuladas. Antes se ocultaba la compra con
  // la primera guía aunque fuera parcial — ahora sigue apareciendo hasta que
  // TODAS sus líneas queden cubiertas.
  const [{ data: compras }, todosDetalles, recibidoPorDetalle] = await Promise.all([
    getComprasPage({ pagina: 1, porPagina: 500 }),
    getTodosDetalleCompras(),
    _getCantidadesRecibidasPorDetalle()
  ])

  const detallesPorCompra = new Map()
  for (const d of (todosDetalles || [])) {
    if (!detallesPorCompra.has(d.compra_id)) detallesPorCompra.set(d.compra_id, [])
    detallesPorCompra.get(d.compra_id).push(d)
  }

  const tienePendiente = (compraId) => {
    const detalles = detallesPorCompra.get(compraId) || []
    if (detalles.length === 0) return true // sin líneas registradas: se muestra por seguridad
    return detalles.some(d => {
      const comprado = parseFloat(d.cantidad) || 0
      const recibido = recibidoPorDetalle.get(d.id) || 0
      return recibido + 0.0001 < comprado
    })
  }

  S._guiaComprasCache = (compras || []).filter(c => c.tipo_compra === 'mercaderia' && tienePendiente(c.id))

  select.innerHTML = '<option value="">-- Selecciona una compra registrada --</option>' +
    S._guiaComprasCache.map(c =>
      `<option value="${c.id}">${c.referencia} — ${c.proveedor_nombre} (${c.fecha_emision})</option>`
    ).join('')
  refrescarBuscador(select)
}

/* _guiaMarcasCache: movido a compras/state.js (S._guiaMarcasCache) */
/* _guiaZonasCache: movido a compras/state.js (S._guiaZonasCache) */   // [{id, nombre, almacen_id, almacenNombre}]
/* _guiaLotesPorItem: movido a compras/state.js (S._guiaLotesPorItem) */ // item_id -> [lotes existentes], para el datalist del N° de Lote
/* _guiaZonasNombre: movido a compras/state.js (S._guiaZonasNombre) */  // ubicacion_id -> "Almacén — Zona"
/* _guiaCompraActual: movido a compras/state.js (S._guiaCompraActual) */ // compra elegida en el modal (para comparar costos)

window.onSeleccionarCompraGuia = async function () {
  try {
    const compraId = parseInt(document.getElementById('ngCompra')?.value || 0)
    const infoDiv = document.getElementById('ngInfoCompra')
    const tablaDiv = document.getElementById('tabla-detalle-guia')

    if (!compraId) {
      infoDiv.style.display = 'none'
      tablaDiv.innerHTML = '<p style="text-align:center; color:var(--text-secondary); padding:20px;">Selecciona una compra para ver sus productos.</p>'
      S._guiaLineas = []
      return
    }

    const [compra, detalles, marcas, itemsList, almacenes, zonas] = await Promise.all([
      getCompraById(compraId),
      getCompraDetalles(compraId),
      getMarcas(),
      getItems(),
      getAlmacenes(),
      getUbicaciones()
    ])

    infoDiv.style.display = 'block'
    infoDiv.innerHTML = `
      <strong>Proveedor:</strong> ${compra?.proveedor_nombre || '-'} (${compra?.proveedor_ruc || '-'}) &nbsp;|&nbsp;
      <strong>Comprobante:</strong> ${compra?.serie ? compra.serie + '-' + compra.numero : (compra?.numero || '-')} &nbsp;|&nbsp;
      <strong>Fecha compra:</strong> ${compra?.fecha_emision || '-'}
    `

    const itemsMap = {}
    for (const it of (itemsList || [])) itemsMap[it.id] = it

    const almacenesMap = {}
    for (const a of (almacenes || [])) almacenesMap[a.id] = a

    S._guiaMarcasCache = marcas || []
    // Las zonas virtuales (Partners/Vendors, Partners/Customers) son solo
    // para el Kardex — nunca un destino real de recepción de mercadería.
    S._guiaZonasCache = (zonas || [])
      .filter(z => !almacenesMap[z.almacen_id]?.es_virtual)
      .map(z => ({
        id: z.id,
        nombre: z.nombre,
        almacen_id: z.almacen_id,
        almacenNombre: almacenesMap[z.almacen_id]?.nombre || `Almacén #${z.almacen_id}`
      }))

    // Lotes YA existentes de cada producto: se ofrecen en el campo "N° de
    // Lote" para poder recibir más mercadería sobre un lote abierto de ESTA
    // MISMA compra. Si el texto coincide pero es de otra compra (factura
    // distinta), no se ofrece para sumar — se crea aparte, a propósito:
    // identificación específica por adquisición, no por texto de lote.
    S._guiaCompraActual = await getCompraById(compraId)
    const lotesExistentes = await getLotes()
    S._guiaLotesPorItem = {}
    for (const lo of (lotesExistentes || [])) {
      if (!lo.item_id) continue
      ;(S._guiaLotesPorItem[lo.item_id] = S._guiaLotesPorItem[lo.item_id] || []).push(lo)
    }
    // Más recientes primero: el lote que se está recibiendo suele ser el último.
    Object.values(S._guiaLotesPorItem).forEach(arr =>
      arr.sort((a, b) => (b.fecha_ingreso || '').localeCompare(a.fecha_ingreso || '') || b.id - a.id))

    S._guiaZonasNombre = {}
    for (const z of S._guiaZonasCache) S._guiaZonasNombre[z.id] = `${z.almacenNombre} — ${z.nombre}`

    // Lo ya recibido en OTRAS guías (no anuladas) de esta misma compra: la
    // recepción arranca prellenada con lo PENDIENTE, no con el total
    // comprado de nuevo — si no, cada guía parcial adicional invitaría a
    // recibir el pedido entero otra vez por error.
    const recibidoPorDetalle = await _getCantidadesRecibidasPorDetalle()

    S._guiaLineas = (detalles || []).map(d => {
      const marcaDefault = itemsMap[d.item_id]?.marca_id || null
      const comprado = parseFloat(d.cantidad) || 0
      const yaRecibido = parseFloat((recibidoPorDetalle.get(d.id) || 0).toFixed(4))
      const pendiente = parseFloat(Math.max(0, comprado - yaRecibido).toFixed(4))
      return {
        detalle_compra_id: d.id,
        item_id:            d.item_id,
        nombre:              itemsMap[d.item_id]?.nombre || `Item #${d.item_id}`,
        sku:                 itemsMap[d.item_id]?.sku || '',
        unidad_medida:       d.unidad_medida,
        cantidad_comprada:   comprado,
        ya_recibido:         yaRecibido,
        unidades_compradas: parseFloat(d.unidades) || null,
        precio_unitario:     parseFloat(d.precio_unitario) || 0,
        marca_default_id:    marcaDefault,
        // Una línea comprada puede recibirse en 1 o más lotes/zonas distintos
        // (ej: 1000kg llegan repartidos en 2 lotes), y también en más de una
        // guía si la entrega llega incompleta. Se arranca con 1 recepción
        // precargada con lo PENDIENTE (si hay más de una recepción, el
        // usuario debe repartir el N° de unidades entre ellas manualmente).
        recepciones: [
          {
            cantidad: pendiente,
            numero_lote: '',
            marca_id: marcaDefault,
            codigo_partida: '', // texto libre y opcional: agrupa lotes de esta misma guía (no es Partida Arancelaria)
            ubicacion_id: '',
            cantidad_unidades: null,
            es_peso_variable: false,
            bultos: []   // packing list: peso individual por bulto cuando es_peso_variable=true
          }
        ]
      }
    })

    _renderTablaDetalleGuia()
  } catch (error) {
    console.error('Error en onSeleccionarCompraGuia:', error)
    showToast('Error al cargar el detalle de la compra', 'danger')
  }
}

// Antes de re-renderizar (agregar/quitar una recepción), se leen los
// valores actuales de los inputs de vuelta al estado _guiaLineas, para no
// perder lo que el usuario ya escribió.
export function _sincronizarRecepcionesGuiaDesdeDOM() {
  S._guiaLineas.forEach((l, idx) => {
    l.recepciones.forEach((r, subIdx) => {
      const cant = document.getElementById(`gc-${idx}-${subIdx}-cantidad`)
      const cantUnid = document.getElementById(`gc-${idx}-${subIdx}-unidades`)
      const lote = document.getElementById(`gc-${idx}-${subIdx}-lote`)
      const marca = document.getElementById(`gc-${idx}-${subIdx}-marca`)
      const codigoPartida = document.getElementById(`gc-${idx}-${subIdx}-codigopartida`)
      const zona = document.getElementById(`gc-${idx}-${subIdx}-zona`)
      const pesoVar = document.getElementById(`gc-${idx}-${subIdx}-pesovariable`)
      if (cant)    r.cantidad = parseFloat(cant.value || 0)
      if (cantUnid) r.cantidad_unidades = parseFloat(cantUnid.value || 0) || null
      if (lote)    r.numero_lote = lote.value?.trim() || ''
      if (marca)   r.marca_id = parseInt(marca.value || 0) || null
      if (codigoPartida) r.codigo_partida = codigoPartida.value?.trim() || ''
      if (zona)    r.ubicacion_id = parseInt(zona.value || 0) || null
      if (pesoVar) r.es_peso_variable = !!pesoVar.checked
      if (r.es_peso_variable && Array.isArray(r.bultos)) {
        r.bultos.forEach((b, bIdx) => {
          const inp = document.getElementById(`gc-${idx}-${subIdx}-bulto-${bIdx}`)
          if (inp) b.peso = parseFloat(inp.value || 0) || null
        })
      }
    })
  })
}

/** Una recepción "vacía" = el usuario no la tocó (o borró lo que traía
 * precargado) porque ese producto de la factura NO llegó en ESTA guía —
 * normal en una importación/entrega parcial (ej. factura con 2 artículos,
 * llega solo 1 primero). Se omite en silencio en vez de bloquear el guardado
 * con "Cantidad recibida inválida": el producto queda pendiente para una
 * guía posterior, igual que si nunca se hubiera agregado esa fila. Solo si
 * el usuario alcanzó a llenar ALGÚN otro campo (lote, marca, zona, unidades)
 * pero dejó la cantidad en 0 se sigue tratando como error real, para no
 * tragarse un dato a medio llenar por accidente. */
export function _esRecepcionVaciaGuia(r) {
  const cantidadVacia = !r.cantidad || r.cantidad <= 0
  const restoVacio = !r.numero_lote && !r.marca_id && !r.ubicacion_id && !r.cantidad_unidades &&
    !(Array.isArray(r.bultos) && r.bultos.some(b => (parseFloat(b.peso) || 0) > 0))
  return cantidadVacia && restoVacio
}

window.agregarRecepcionGuia = function (idx) {
  _sincronizarRecepcionesGuiaDesdeDOM()
  const l = S._guiaLineas[idx]
  if (!l) return
  l.recepciones.push({ cantidad: 0, numero_lote: '', marca_id: l.marca_default_id, codigo_partida: '', ubicacion_id: '', cantidad_unidades: null, es_peso_variable: false, bultos: [] })
  _renderTablaDetalleGuia()
}

window.quitarRecepcionGuia = function (idx, subIdx) {
  _sincronizarRecepcionesGuiaDesdeDOM()
  const l = S._guiaLineas[idx]
  if (!l) return
  l.recepciones.splice(subIdx, 1)
  if (l.recepciones.length === 0) {
    l.recepciones.push({ cantidad: l.cantidad_comprada, numero_lote: '', marca_id: l.marca_default_id, codigo_partida: '', ubicacion_id: '', cantidad_unidades: l.unidades_compradas, es_peso_variable: false, bultos: [] })
  }
  _renderTablaDetalleGuia()
}

window.toggleSeleccionTodasGuia = function (idx, marcarTodas) {
  const l = S._guiaLineas[idx]
  if (!l) return
  l.recepciones.forEach((r, subIdx) => {
    const chk = document.getElementById(`gc-${idx}-${subIdx}-sel`)
    if (chk) chk.checked = marcarTodas
  })
}

// Edición masiva: aplica Marca / Partida / Zona a las filas marcadas con
// checkbox dentro de UN mismo producto (no re-renderiza toda la tabla, solo
// pisa los <select>/<input> de las filas seleccionadas, para no perder lo
// que el usuario ya escribió en otras filas). N° de Lote y Cantidad quedan
// fuera a propósito: son datos únicos por fila, no tiene sentido copiarlos.
window.aplicarEdicionMasivaGuia = function (idx) {
  const l = S._guiaLineas[idx]
  if (!l) return

  const marcaVal = document.getElementById(`gm-${idx}-marca`)?.value || ''
  const partidaVal = document.getElementById(`gm-${idx}-partida`)?.value?.trim() || ''
  const zonaVal = document.getElementById(`gm-${idx}-zona`)?.value || ''

  if (!marcaVal && !partidaVal && !zonaVal) {
    showToast('Elige al menos un valor (Marca, Partida o Zona) para aplicar', 'warning')
    return
  }

  let filasAfectadas = 0
  l.recepciones.forEach((r, subIdx) => {
    const chk = document.getElementById(`gc-${idx}-${subIdx}-sel`)
    if (!chk?.checked) return
    filasAfectadas++

    if (marcaVal) {
      r.marca_id = parseInt(marcaVal)
      const marcaEl = document.getElementById(`gc-${idx}-${subIdx}-marca`)
      if (marcaEl) marcaEl.value = marcaVal
    }
    if (partidaVal) {
      r.codigo_partida = partidaVal
      const partidaEl = document.getElementById(`gc-${idx}-${subIdx}-codigopartida`)
      if (partidaEl) partidaEl.value = partidaVal
    }
    if (zonaVal) {
      r.ubicacion_id = parseInt(zonaVal)
      const zonaEl = document.getElementById(`gc-${idx}-${subIdx}-zona`)
      if (zonaEl) zonaEl.value = zonaVal
    }
  })

  if (filasAfectadas === 0) {
    showToast('No hay filas seleccionadas', 'warning')
    return
  }
  showToast(`Aplicado a ${filasAfectadas} fila(s)`, 'success')
}

export function _renderTablaDetalleGuia() {
  const container = document.getElementById('tabla-detalle-guia')
  if (!container) return

  if (!S._guiaLineas || S._guiaLineas.length === 0) {
    container.innerHTML = '<p style="text-align:center; color:var(--text-secondary); padding:20px;">Esta compra no tiene productos en su detalle.</p>'
    return
  }

  const marcaOptions = (S._guiaMarcasCache || []).map(m => `<option value="${m.id}">${m.nombre}</option>`).join('')
  const zonaOptions = (S._guiaZonasCache || [])
    .map(z => `<option value="${z.id}">${z.almacenNombre} — ${z.nombre}</option>`).join('')

  let html = ''
  S._guiaLineas.forEach((l, idx) => {
    const totalRecibido = l.recepciones.reduce((s, r) => s + (parseFloat(r.cantidad) || 0), 0)
    // Verde cuando esta guía completa exactamente lo PENDIENTE (comprado
    // menos lo ya recibido en otras guías) — no lo comprado total, que ya no
    // es la referencia correcta a partir de la segunda guía parcial.
    const pendienteLinea = parseFloat(Math.max(0, l.cantidad_comprada - (l.ya_recibido || 0)).toFixed(4))
    const colorTotal = Math.abs(totalRecibido - pendienteLinea) < 0.0001 ? 'var(--color-success)' : 'var(--color-warning)'
    const infoYaRecibido = l.ya_recibido > 0
      ? `Ya recibido: ${formatQty(l.ya_recibido)} &nbsp;|&nbsp; Pendiente: ${formatQty(pendienteLinea)} &nbsp;|&nbsp; `
      : ''

    html += `
      <div style="border:1px solid var(--border-color); border-radius:var(--radius-md); margin-bottom:14px; padding:12px;">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
          <strong>${l.sku ? '(' + l.sku + ') ' : ''}${l.nombre}</strong>
          <span style="font-size:0.85rem;">
            Comprado: ${formatQty(l.cantidad_comprada)} ${l.unidad_medida || ''} &nbsp;|&nbsp;
            ${infoYaRecibido}
            Recibiendo: <strong style="color:${colorTotal};">${formatQty(totalRecibido)}</strong>
          </span>
        </div>
        ${l.recepciones.length > 1 ? `
        <div style="display:flex; flex-wrap:wrap; align-items:end; gap:10px; margin-bottom:8px; padding:8px 10px; background:var(--bg-secondary); border-radius:var(--radius-sm);">
          <div style="font-size:0.78rem; color:var(--text-secondary); align-self:center;">Editar filas seleccionadas:</div>
          <div>
            <label style="font-size:0.72rem; display:block; color:var(--text-secondary);">Marca</label>
            <select id="gm-${idx}-marca" style="min-width:110px;"><option value="">-- Sin cambio --</option>${marcaOptions}</select>
          </div>
          <div>
            <label style="font-size:0.72rem; display:block; color:var(--text-secondary);">Partida</label>
            <input type="text" id="gm-${idx}-partida" placeholder="Ej: LT.26027" style="width:120px;">
          </div>
          <div>
            <label style="font-size:0.72rem; display:block; color:var(--text-secondary);">Almacén / Zona</label>
            <select id="gm-${idx}-zona" style="min-width:160px;"><option value="">-- Sin cambio --</option>${zonaOptions}</select>
          </div>
          <button type="button" class="btn btn-small btn-secondary" onclick="window.aplicarEdicionMasivaGuia(${idx})">Aplicar a seleccionadas</button>
        </div>
        ` : ''}
        <datalist id="lotes-item-${l.item_id}">
          ${(S._guiaLotesPorItem[l.item_id] || []).map(lo =>
            `<option value="${_escCompras(lo.numero_lote || '')}">${(parseFloat(lo.cantidad) || 0).toLocaleString('en-US', { maximumFractionDigits: 2 })} ${lo.unidad_medida || 'KG'} · costo ${(parseFloat(lo.costo_unitario) || 0).toFixed(4)}</option>`
          ).join('')}
        </datalist>
        <div style="overflow-x:auto;">
        <table style="min-width:920px;">
          <thead>
            <tr>
              ${l.recepciones.length > 1 ? `<th><input type="checkbox" id="gsel-${idx}-all" title="Seleccionar todas" onchange="window.toggleSeleccionTodasGuia(${idx}, this.checked)"></th>` : ''}
              <th>Cantidad (${l.unidad_medida || 'KG'}) *</th><th title="Obligatorio salvo cuando 'Peso Variable' está marcado (ahí se calcula solo del packing list). Sin esto el lote no puede calcular su peso por unidad.">N° de Unidades *</th>
              <th title="Marca el peso por unidad como aproximado (no exacto). Se usa al vender para saber si pedir unidades exactas o dejarlas estimadas.">Peso Variable</th>
              <th>N° de Lote *</th><th>Marca *</th>
              <th>Partida <span style="font-weight:400; color:var(--text-secondary);" title="Código que agrupa varios lotes de esta misma guía (ej. varios lotes 'LT.26027-01, -02, -03...' comparten la partida 'LT.26027'). Opcional.">(opcional)</span></th>
              <th>Almacén / Zona *</th><th></th>
            </tr>
          </thead>
          <tbody>
    `
    const colspanBultos = l.recepciones.length > 1 ? 8 : 7
    l.recepciones.forEach((r, subIdx) => {
      const soloLecturaCantidad = r.es_peso_variable ? 'readonly style="width:100px; background:var(--bg-secondary);" title="Se calcula solo del detalle de bultos de abajo"' : 'style="width:100px;"'
      const soloLecturaUnidades = r.es_peso_variable ? 'readonly style="width:90px; background:var(--bg-secondary);" title="Se calcula solo del detalle de bultos de abajo"' : 'style="width:90px;"'
      html += `
        <tr>
          ${l.recepciones.length > 1 ? `<td><input type="checkbox" id="gc-${idx}-${subIdx}-sel"></td>` : ''}
          <td><input type="number" id="gc-${idx}-${subIdx}-cantidad" value="${r.cantidad}" step="0.01" min="0" ${soloLecturaCantidad}></td>
          <td><input type="number" id="gc-${idx}-${subIdx}-unidades" value="${r.cantidad_unidades ?? ''}" placeholder="Ej: 10" step="1" min="0" ${soloLecturaUnidades}></td>
          <td style="text-align:center;"><input type="checkbox" id="gc-${idx}-${subIdx}-pesovariable" ${r.es_peso_variable ? 'checked' : ''}></td>
          <td>
            <input type="text" id="gc-${idx}-${subIdx}-lote" value="${r.numero_lote}" placeholder="Nuevo o existente..."
                   list="lotes-item-${l.item_id}" autocomplete="off" style="width:150px;">
            <div id="gc-${idx}-${subIdx}-loteaviso" class="lote-aviso"></div>
          </td>
          <td><select id="gc-${idx}-${subIdx}-marca" style="min-width:110px;">
                <option value="">-- Selecciona --</option>${marcaOptions}
              </select></td>
          <td><input type="text" id="gc-${idx}-${subIdx}-codigopartida" value="${r.codigo_partida || ''}" placeholder="Ej: LT.26027" style="width:120px;"></td>
          <td><select id="gc-${idx}-${subIdx}-zona" style="min-width:160px;">
                <option value="">-- Selecciona --</option>${zonaOptions}
              </select></td>
          <td>${l.recepciones.length > 1 ? `<button type="button" class="btn btn-small btn-danger" onclick="window.quitarRecepcionGuia(${idx}, ${subIdx})">✕</button>` : ''}</td>
        </tr>
      `
      if (r.es_peso_variable) {
        // Packing list de esta recepción: peso individual por bulto/caja.
        // cantidad y cantidad_unidades de arriba se recalculan solos desde
        // esta lista (ver _sincronizarCantidadDesdeBultos) — nunca se
        // escriben a mano cuando el producto es peso variable.
        if (!Array.isArray(r.bultos) || r.bultos.length === 0) r.bultos = [{ peso: null }]
        const sumaBultos = r.bultos.reduce((s, b) => s + (parseFloat(b.peso) || 0), 0)
        html += `
        <tr>
          <td colspan="${colspanBultos}" style="background:var(--bg-secondary); padding:10px 14px;">
            <div style="font-size:0.78rem; color:var(--text-secondary); margin-bottom:6px;">
              📦 Packing list — peso por bulto (${l.unidad_medida || 'KG'}). Total:
              <strong id="gc-${idx}-${subIdx}-bultostotal">${sumaBultos.toFixed(2)}</strong>
              en <strong>${r.bultos.length}</strong> bulto(s).
            </div>
            <div style="display:flex; flex-wrap:wrap; gap:8px;">
              ${r.bultos.map((b, bIdx) => `
                <div style="display:flex; align-items:center; gap:4px;">
                  <input type="number" id="gc-${idx}-${subIdx}-bulto-${bIdx}" value="${b.peso ?? ''}"
                         placeholder="Bulto ${bIdx + 1}" step="0.01" min="0" style="width:90px;">
                  ${r.bultos.length > 1 ? `<button type="button" class="btn btn-small btn-danger" onclick="window.quitarBultoGuia(${idx},${subIdx},${bIdx})">✕</button>` : ''}
                </div>
              `).join('')}
            </div>
            <button type="button" class="btn btn-small btn-secondary" style="margin-top:8px;" onclick="window.agregarBultoGuia(${idx},${subIdx})">+ Agregar bulto</button>
          </td>
        </tr>
        `
      }
    })
    html += `
          </tbody>
        </table>
        </div>
        <button type="button" class="btn btn-small btn-secondary" style="margin-top:6px;" onclick="window.agregarRecepcionGuia(${idx})">+ Agregar otro lote/zona para este producto</button>
      </div>
    `
  })

  // Resumen general de la guía (mismo formato de tarjetas que "Detalles de
  // Productos" en Nueva Compra): totales agregados de TODAS las líneas y
  // recepciones, con separador de miles.
  const cantidadTotalGuia = S._guiaLineas.reduce((s, l) =>
    s + l.recepciones.reduce((s2, r) => s2 + (parseFloat(r.cantidad) || 0), 0), 0)
  const unidadesTotalGuia = S._guiaLineas.reduce((s, l) =>
    s + l.recepciones.reduce((s2, r) => s2 + (parseFloat(r.cantidad_unidades) || 0), 0), 0)
  const lotesTotalGuia = S._guiaLineas.reduce((s, l) =>
    s + l.recepciones.filter(r => (r.numero_lote || '').trim()).length, 0)

  html += `
    <div style="margin-top:10px; padding: 15px; background-color: var(--bg-secondary); border-radius: var(--radius-md); display: grid; grid-template-columns: repeat(3, 1fr); gap: 15px;">
      <div style="text-align: center;">
        <div style="font-size: 12px; color: var(--text-secondary);">Cantidad Total</div>
        <div style="font-size: 18px; font-weight: 600; color: var(--text-primary);" id="guiaTotalCantidad">${cantidadTotalGuia.toLocaleString('en-US', { maximumFractionDigits: 2 })}</div>
      </div>
      <div style="text-align: center;">
        <div style="font-size: 12px; color: var(--text-secondary);">N° Total Unidades</div>
        <div style="font-size: 18px; font-weight: 600; color: var(--text-primary);" id="guiaTotalUnidades">${unidadesTotalGuia.toLocaleString('en-US', { maximumFractionDigits: 2 })}</div>
      </div>
      <div style="text-align: center;">
        <div style="font-size: 12px; color: var(--text-secondary);">N° Total de Lotes</div>
        <div style="font-size: 18px; font-weight: 600; color: var(--text-primary);" id="guiaTotalLotes">${lotesTotalGuia.toLocaleString('en-US')}</div>
      </div>
    </div>
  `

  container.innerHTML = html

  // Preseleccionar marca/valores guardados en el estado (incluye la marca
  // default del producto y lo que el usuario ya había escrito antes de
  // agregar/quitar una recepción).
  S._guiaLineas.forEach((l, idx) => {
    l.recepciones.forEach((r, subIdx) => {
      const cant = document.getElementById(`gc-${idx}-${subIdx}-cantidad`)
      const cantUnid = document.getElementById(`gc-${idx}-${subIdx}-unidades`)
      const lote = document.getElementById(`gc-${idx}-${subIdx}-lote`)
      const marca = document.getElementById(`gc-${idx}-${subIdx}-marca`)
      const codigoPartida = document.getElementById(`gc-${idx}-${subIdx}-codigopartida`)
      const zona = document.getElementById(`gc-${idx}-${subIdx}-zona`)
      const pesoVar = document.getElementById(`gc-${idx}-${subIdx}-pesovariable`)
      if (cant)  cant.value = r.cantidad
      if (cantUnid) cantUnid.value = r.cantidad_unidades ?? ''
      if (lote)  lote.value = r.numero_lote
      if (marca && r.marca_id) marca.value = r.marca_id
      if (codigoPartida) codigoPartida.value = r.codigo_partida || ''
      if (zona && r.ubicacion_id) zona.value = r.ubicacion_id
      if (pesoVar) pesoVar.checked = !!r.es_peso_variable

      // Mismo estándar de buscador con filtrado en vivo que Ventas y
      // Traslado Interno de Inventario — estos selects se recrean enteros en
      // cada render (container.innerHTML = html arriba), así que se vuelven
      // a envolver cada vez sobre el <select> nuevo.
      if (marca) { convertirEnBuscador(marca, { placeholder: 'Escribe la marca...', sinResultados: 'Sin marcas' }); refrescarBuscador(marca) }
      if (zona)  { convertirEnBuscador(zona,  { placeholder: 'Escribe el almacén o zona...', sinResultados: 'Sin zonas' }); refrescarBuscador(zona) }

      // Cuando es peso variable, cantidad/unidades son de solo lectura
      // (se calculan del packing list de abajo) — no se les pone listener
      // de edición manual.
      if (!r.es_peso_variable) {
        cant?.addEventListener('input', () => { r.cantidad = parseFloat(cant.value || 0); _actualizarTotalesRecepcionGuia() })
        cantUnid?.addEventListener('input', () => { r.cantidad_unidades = parseFloat(cantUnid.value || 0) || null; _actualizarTotalesRecepcionGuia() })
      }
      lote?.addEventListener('input', () => {
        r.numero_lote = lote.value?.trim() || ''
        _avisarLoteExistente(idx, subIdx, l, r)
        _actualizarTotalesRecepcionGuia()
      })
      _avisarLoteExistente(idx, subIdx, l, r)
      codigoPartida?.addEventListener('input', () => { r.codigo_partida = codigoPartida.value?.trim() || '' })
      pesoVar?.addEventListener('change', () => {
        r.es_peso_variable = !!pesoVar.checked
        if (r.es_peso_variable && (!Array.isArray(r.bultos) || r.bultos.length === 0)) r.bultos = [{ peso: null }]
        _renderTablaDetalleGuia()
      })

      // Packing list: un input por bulto, cada uno recalcula cantidad/unidades.
      if (r.es_peso_variable && Array.isArray(r.bultos)) {
        r.bultos.forEach((b, bIdx) => {
          const bultoInp = document.getElementById(`gc-${idx}-${subIdx}-bulto-${bIdx}`)
          bultoInp?.addEventListener('input', () => {
            b.peso = parseFloat(bultoInp.value || 0) || null
            _sincronizarCantidadDesdeBultos(idx, subIdx)
          })
        })
      }
    })
  })
}

/**
 * Recalcula r.cantidad (suma de pesos) y r.cantidad_unidades (conteo de
 * bultos con peso > 0) desde el packing list, y refleja el resultado en los
 * inputs de solo-lectura de Cantidad/N° de Unidades sin re-renderizar toda
 * la tabla (evita perder el foco del input de peso que se está tecleando).
 */
function _sincronizarCantidadDesdeBultos(idx, subIdx) {
  const l = S._guiaLineas[idx]
  const r = l?.recepciones?.[subIdx]
  if (!r || !Array.isArray(r.bultos)) return

  const bultosConPeso = r.bultos.filter(b => (parseFloat(b.peso) || 0) > 0)
  r.cantidad = parseFloat(bultosConPeso.reduce((s, b) => s + (parseFloat(b.peso) || 0), 0).toFixed(4))
  r.cantidad_unidades = bultosConPeso.length

  const cant = document.getElementById(`gc-${idx}-${subIdx}-cantidad`)
  const cantUnid = document.getElementById(`gc-${idx}-${subIdx}-unidades`)
  const total = document.getElementById(`gc-${idx}-${subIdx}-bultostotal`)
  if (cant) cant.value = r.cantidad
  if (cantUnid) cantUnid.value = r.cantidad_unidades
  if (total) total.textContent = r.cantidad.toFixed(2)
  _actualizarTotalesRecepcionGuia()
}

window.agregarBultoGuia = function (idx, subIdx) {
  _sincronizarRecepcionesGuiaDesdeDOM()
  const r = S._guiaLineas[idx]?.recepciones?.[subIdx]
  if (!r) return
  if (!Array.isArray(r.bultos)) r.bultos = []
  r.bultos.push({ peso: null })
  _renderTablaDetalleGuia()
}

window.quitarBultoGuia = function (idx, subIdx, bultoIdx) {
  _sincronizarRecepcionesGuiaDesdeDOM()
  const r = S._guiaLineas[idx]?.recepciones?.[subIdx]
  if (!r || !Array.isArray(r.bultos)) return
  r.bultos.splice(bultoIdx, 1)
  if (r.bultos.length === 0) r.bultos.push({ peso: null })
  _sincronizarCantidadDesdeBultos(idx, subIdx)
  _renderTablaDetalleGuia()
}

// Actualiza en vivo el "Recibiendo: X" de cada línea sin re-renderizar toda
// la tabla (evita perder el foco del input mientras se escribe).
function _actualizarTotalesRecepcionGuia() {
  // Sincroniza el DOM al estado y vuelve a pintar (simple y suficiente
  // para este volumen de filas).
  _sincronizarRecepcionesGuiaDesdeDOM()
  const spans = document.querySelectorAll('#tabla-detalle-guia > div')
  S._guiaLineas.forEach((l, idx) => {
    const totalRecibido = l.recepciones.reduce((s, r) => s + (parseFloat(r.cantidad) || 0), 0)
    const el = spans[idx]?.querySelector('strong[style]')
    if (el) el.textContent = totalRecibido.toLocaleString('en-US', { maximumFractionDigits: 2 })
  })

  const elCant = document.getElementById('guiaTotalCantidad')
  const elUnid = document.getElementById('guiaTotalUnidades')
  if (elCant) {
    const cantidadTotalGuia = S._guiaLineas.reduce((s, l) =>
      s + l.recepciones.reduce((s2, r) => s2 + (parseFloat(r.cantidad) || 0), 0), 0)
    elCant.textContent = cantidadTotalGuia.toLocaleString('en-US', { maximumFractionDigits: 2 })
  }
  if (elUnid) {
    const unidadesTotalGuia = S._guiaLineas.reduce((s, l) =>
      s + l.recepciones.reduce((s2, r) => s2 + (parseFloat(r.cantidad_unidades) || 0), 0), 0)
    elUnid.textContent = unidadesTotalGuia.toLocaleString('en-US', { maximumFractionDigits: 2 })
  }
  const elLotes = document.getElementById('guiaTotalLotes')
  if (elLotes) {
    const lotesTotalGuia = S._guiaLineas.reduce((s, l) =>
      s + l.recepciones.filter(r => (r.numero_lote || '').trim()).length, 0)
    elLotes.textContent = lotesTotalGuia.toLocaleString('en-US')
  }
}

window.cerrarModalNuevaGuia = function () {
  // Si ya eligió una compra o escribió algo, cerrar sin avisar perdería el
  // trabajo (compra seleccionada + lote/marca/zona por línea ya tipeados).
  const compraId     = document.getElementById('ngCompra')?.value
  const numeroGuia    = document.getElementById('ngNumeroGuia')?.value?.trim()
  const observaciones = document.getElementById('ngObservaciones')?.value?.trim()
  const hayEdicion = !!compraId || !!numeroGuia || !!observaciones
  if (hayEdicion && !confirm('Vas a perder los datos ingresados en esta guía. ¿Cerrar de todas formas?')) return
  S._guiaIngresoEditId = null
  window.closeModal('modal-nueva-guia')
}

/**
 * Aplica una lista de recepciones YA VALIDADAS a una guía de ingreso: crea o
 * suma lotes (promedio ponderado si el lote ya existía), actualiza
 * stock_ubicaciones, inserta el movimiento de entrada en Kardex, registra
 * bultos si aplica (peso variable), y crea la línea en
 * detalle_guias_ingreso_compra. Reusado por window.guardarGuiaIngresoCompra
 * (guía nueva) y window.guardarEdicionGuiaIngreso (revertir + reaplicar).
 * @returns {number} totalValorGuia — para el asiento de valuación de inventario.
 */
export async function _aplicarRecepcionesAGuiaIngreso(guia, compra, compraId, recepcionesValidadas, user, fechaGuia, numeroGuia) {
  // Ubicación virtual "Partners/Vendors": origen de TODO ingreso por
  // compra en el Kardex (el proveedor es externo, no una zona real de
  // tu almacén). Se resuelve una sola vez para toda la guía.
  const vendorsZona = await getUbicacionVendors()
  let totalValorGuia = 0

  for (const l of recepcionesValidadas) {
    // Peso por unidad = cantidad total (peso/medida) / N° de unidades
    // físicas (bultos/cajas). cantidad_unidades es OPCIONAL y NUNCA debe
    // igualarse a cantidad — son dos dimensiones distintas (antes se
    // confundían y el "peso por unidad" quedaba mal calculado).
    const pesoPorUnidad = l.cantidadUnidades && l.cantidadUnidades > 0
      ? parseFloat((l.cantidad / l.cantidadUnidades).toFixed(4))
      : null

    // costo_unitario SIEMPRE en soles: l.precio_unitario viene en la
    // moneda original de la compra (detalle_compras.precio_unitario), se
    // convierte aquí con el tipo_cambio de la compra (PEN => tipo_cambio=1,
    // no cambia nada).
    const monedaCompra = compra?.currency || 'PEN'
    // Blindaje 2026-10-05: desde ahora una compra en SOLES guarda el T.C. SUNAT del día
    // como referencia (≠ 1). Solo se CONVIERTE cuando la moneda es USD.
    const tipoCambioCompra = monedaCompra === 'USD' ? (parseFloat(compra?.tipo_cambio) || 1) : 1
    const costoOriginal = parseFloat(l.precio_unitario) || 0
    const costoPen = parseFloat((costoOriginal * tipoCambioCompra).toFixed(4))

    // ¿El N° de lote ya existe para este producto? Si el usuario lo eligió
    // del datalist (o lo escribió igual), se SUMA al lote existente en vez
    // de crear un duplicado. `l.loteExistenteId` lo resolvió la validación
    // previa, que ya preguntó qué hacer si los costos no coincidían.
    let lote = null
    let cantidadResultante = l.cantidad
    let costoFinalLote = costoPen

    if (l.loteExistenteId) {
      const existente = await getLoteById(l.loteExistenteId)
      if (!existente) throw new Error(`El lote ${l.numeroLote} ya no existe`)

      const cantPrevia = parseFloat(existente.cantidad) || 0
      const unidPrevias = parseFloat(existente.cantidad_unidades) || 0
      cantidadResultante = parseFloat((cantPrevia + l.cantidad).toFixed(4))
      const unidadesResultantes = parseFloat((unidPrevias + (l.cantidadUnidades || 0)).toFixed(4))

      // Costo: si el usuario aceptó fusionar con costos distintos, se
      // recalcula como promedio ponderado sobre la cantidad total. Si los
      // costos coincidían, el promedio da exactamente el mismo número.
      const costoPrevio = parseFloat(existente.costo_unitario) || 0
      costoFinalLote = cantidadResultante > 0
        ? parseFloat((((cantPrevia * costoPrevio) + (l.cantidad * costoPen)) / cantidadResultante).toFixed(4))
        : costoPen

      await updateLote(existente.id, {
        cantidad:          cantidadResultante,
        cantidad_unidades: unidadesResultantes,
        costo_unitario:    costoFinalLote,
        // El peso por unidad se recalcula sobre el acumulado, no se pisa
        // con el de esta recepción sola.
        peso_por_unidad:   unidadesResultantes > 0
          ? parseFloat((cantidadResultante / unidadesResultantes).toFixed(4))
          : existente.peso_por_unidad
      })
      lote = { ...existente, id: existente.id }
    } else {
      lote = await addLote({
        item_id:            l.item_id,
        proveedor_id:       compra?.contact_id || null,
        numero_lote:        l.numeroLote,
        numero_factura:     compra?.numero || null,
        codigo_partida:     l.codigoPartida,
        marca_id:           l.marcaId,
        costo_unitario:     costoPen,
        moneda:             monedaCompra,
        tipo_cambio:         tipoCambioCompra,
        costo_unit_original: costoOriginal,
        costo_estado:       'definitivo',
        cantidad:           l.cantidad,
        unidad_medida:      l.unidadMedida,
        // lotes.cantidad_unidades es NOT NULL DEFAULT 0: pasar `null`
        // explícito pisa el DEFAULT y Postgres rechaza el insert (23502).
        // l.cantidadUnidades sigue en null más arriba para no confundir
        // "0 unidades" con "no se ingresó" en los cálculos de peso_por_unidad.
        cantidad_unidades:  l.cantidadUnidades || 0,
        peso_por_unidad:    pesoPorUnidad,
        es_peso_variable:   l.esPesoVariable,
        ubicacion_id:       l.ubicacionId,
        fecha_ingreso:      fechaGuia,
        compra_id:          compraId,
        guia_id:            guia.id,
        created_by:         user.db_id
      })
      if (!lote?.id) {
        const motivo = ultimoErrorInsert ? ultimoErrorInsert() : null
        throw new Error(
          `no se pudo crear el lote "${l.numeroLote}" (${motivo?.mensaje || 'motivo desconocido — revisa la consola'}). ` +
          `Si ese N° de Lote ya existe para este producto y esta compra, es probable que un lote anterior no se haya podido borrar — revisa Inventario antes de reintentar.`
        )
      }
    }

    if (lote?.id) {
      // stock_ubicaciones: si el lote ya tenía stock en ESA zona, se suma
      // a esa fila; si entra a una zona nueva, se crea la fila. (Un mismo
      // lote puede estar repartido en varias zonas.)
      const filasZona = l.loteExistenteId ? await getStockUbicacionesByLote(lote.id) : []
      const filaMisma = (filasZona || []).find(f => f.ubicacion_id === l.ubicacionId)
      if (filaMisma) {
        await updateStockUbicacion(filaMisma.id, {
          cantidad:          parseFloat(((parseFloat(filaMisma.cantidad) || 0) + l.cantidad).toFixed(4)),
          cantidad_unidades: parseFloat(((parseFloat(filaMisma.cantidad_unidades) || 0) + (l.cantidadUnidades || 0)).toFixed(4))
        })
      } else {
        await addStockUbicacion({
          lote_id:           lote.id,
          ubicacion_id:      l.ubicacionId,
          cantidad:          l.cantidad,
          cantidad_unidades: l.cantidadUnidades || 0
        })
      }

      // Kardex: entrada de Partners/Vendors (externo) a la zona real
      // elegida. Saldo = la cantidad del lote recién creado (costeo por
      // identificación específica: cada lote lleva su propio saldo).
      const costoTotalLinea = parseFloat((l.cantidad * costoPen).toFixed(2))
      totalValorGuia += costoTotalLinea
      await addKardexMovimiento({
        item_id:              l.item_id,
        lote_id:               lote.id,
        ubicacion_origen_id:   vendorsZona?.id || null,
        ubicacion_destino_id:  l.ubicacionId,
        fecha:                 fechaGuia,
        tipo_movimiento:       'entrada',
        concepto:              'Compra - ingreso a almacén',
        documento_referencia:  numeroGuia,
        cantidad_entrada:      l.cantidad,
        cantidad_salida:       0,
        cantidad_unidades_entrada: l.cantidadUnidades || 0,
        cantidad_unidades_salida:  0,
        costo_unitario:        costoPen,
        valor_entrada:         costoTotalLinea,
        valor_salida:          0,
        moneda:                monedaCompra,
        tipo_cambio:            tipoCambioCompra,
        costo_unit_original:    costoOriginal,
        // Saldo = cantidad ACUMULADA del lote tras esta entrada. Antes se
        // escribía solo `l.cantidad`, así que al recibir sobre un lote ya
        // existente el kardex mostraba un saldo menor al real.
        saldo_cantidad:        cantidadResultante,
        saldo_valor:           parseFloat((cantidadResultante * costoFinalLote).toFixed(2)),
        saldo_unidades:        l.cantidadUnidades || 0,
        compra_id:             compraId,
        created_by:            user.db_id
      })

      // Packing list: un lote_bultos por caja/bolsa con su peso real. Con
      // esto, lotes.cantidad/cantidad_unidades dejan de ser lo que se
      // escribió a mano arriba y pasan a ser la suma/conteo real de los
      // bultos (recalcularLoteDesdeBultos pisa lo que puso addLote/updateLote).
      if (l.esPesoVariable && Array.isArray(l.bultos) && l.bultos.length > 0) {
        const pesosValidos = l.bultos
          .map(b => parseFloat(b.peso) || 0)
          .filter(p => p > 0)
        for (const peso of pesosValidos) {
          await addLoteBulto({
            lote_id:        lote.id,
            peso,
            unidad_medida:  l.unidadMedida,
            ubicacion_id:   l.ubicacionId,
            estado:         'disponible',
            guia_ingreso_id: guia.id,
            fecha_ingreso:  fechaGuia,
            created_by:     user.db_id
          })
        }
        if (pesosValidos.length > 0) await recalcularLoteDesdeBultos(lote.id)
      }
    }

    await addDetalleGuiaIngresoCompra({
      guia_id:             guia.id,
      detalle_compra_id:   l.detalle_compra_id,
      item_id:             l.item_id,
      cantidad:            l.cantidad,
      cantidad_unidades:   l.cantidadUnidades || 0,
      numero_lote:         l.numeroLote,
      marca_id:            l.marcaId,
      codigo_partida:      l.codigoPartida,
      ubicacion_id:        l.ubicacionId,
      lote_id:             lote?.id || null
    })
  }

  return totalValorGuia
}

window.guardarGuiaIngresoCompra = async function () {
  // Modo edición: el mismo botón/modal se reusa para "Editar Guía de
  // Ingreso" (window.editarGuiaIngreso la puso en este modo) — se delega a
  // la ruta de revertir + reaplicar en vez de crear una guía nueva.
  if (S._guiaIngresoEditId) { await _guardarEdicionGuiaIngreso(); return }

  const btn = document.getElementById('btnGuardarGuiaIngresoCompra')
  if (btn?.disabled) return
  if (btn) { btn.disabled = true; btn.textContent = 'Guardando...' }
  try {
    const user = await getCurrentUser()
    if (!user) { showToast('Usuario no autenticado', 'danger'); return }

    const compraId    = parseInt(document.getElementById('ngCompra')?.value || 0)
    const numeroGuia   = document.getElementById('ngNumeroGuia')?.value?.trim()
    const fechaGuia    = document.getElementById('ngFechaGuia')?.value
    const observaciones = document.getElementById('ngObservaciones')?.value?.trim() || null

    if (!compraId)   { showToast('Selecciona la compra que estás recibiendo', 'warning'); return }
    if (!numeroGuia) { showToast('Ingresa el N° de Guía', 'warning'); return }
    if (!fechaGuia)  { showToast('Ingresa la fecha de la guía', 'warning'); return }
    if (!S._guiaLineas || S._guiaLineas.length === 0) { showToast('Esta compra no tiene productos', 'warning'); return }

    _sincronizarRecepcionesGuiaDesdeDOM()

    // Validar Lote + Marca + Zona + Cantidad en cada recepción de cada línea
    // antes de escribir nada.
    const recepcionesValidadas = []
    for (const l of S._guiaLineas) {
      for (const r of l.recepciones) {
        // Entrega parcial: este producto de la factura simplemente no llegó
        // en ESTA guía — se omite sin error (ver _esRecepcionVaciaGuia).
        if (_esRecepcionVaciaGuia(r)) continue
        if (!r.cantidad || r.cantidad <= 0) { showToast(`Cantidad recibida inválida para "${l.nombre}"`, 'warning'); return }
        if (!r.numero_lote)                 { showToast(`Falta el N° de Lote de "${l.nombre}"`, 'warning'); return }
        if (!r.marca_id)                    { showToast(`Falta la Marca de "${l.nombre}"`, 'warning'); return }
        if (!r.ubicacion_id)                { showToast(`Falta el Almacén/Zona de "${l.nombre}"`, 'warning'); return }
        // N° de Unidades obligatorio cuando NO es peso variable: sin esto,
        // peso_por_unidad queda null y el lote no puede sugerir unidades al
        // vender (bug recurrente de 13 lotes corregido el 05/09/2026 vía
        // backfill — esta validación evita que se repita). Cuando SÍ es peso
        // variable, cantidad_unidades se calcula solo del packing list.
        if (!r.es_peso_variable && (!r.cantidad_unidades || r.cantidad_unidades <= 0)) {
          showToast(`Falta el N° de Unidades (bultos/cajas) de "${l.nombre}"`, 'warning')
          return
        }

        recepcionesValidadas.push({
          detalle_compra_id: l.detalle_compra_id,
          item_id:           l.item_id,
          nombreProducto:    l.nombre,
          precio_unitario:   l.precio_unitario,
          unidadMedida:       l.unidad_medida || 'KG',
          cantidad:           r.cantidad,
          cantidadUnidades:   r.cantidad_unidades || null,
          numeroLote:         r.numero_lote,
          marcaId:            r.marca_id,
          codigoPartida:      (r.codigo_partida || '').trim() || null, // opcional: agrupa lotes de esta guía
          ubicacionId:        r.ubicacion_id,
          esPesoVariable:     !!r.es_peso_variable,
          bultos:             r.es_peso_variable ? (r.bultos || []) : null,  // packing list, solo si es_peso_variable
          loteExistenteId:    null   // lo resuelve el bloque de abajo
        })
      }
    }

    if (recepcionesValidadas.length === 0) {
      showToast('Ingresa la cantidad recibida de al menos un producto', 'warning')
      return
    }

    const compra = await getCompraById(compraId)

    // ── ¿Alguna recepción va sobre un lote que ya existe? ──────────────────
    // Se resuelve ANTES de escribir nada, porque si los costos no coinciden
    // hay que preguntar y una respuesta negativa cancela toda la guía.
    const conflictosCosto = []
    for (const rec of recepcionesValidadas) {
      // Compara solo contra lotes de ESTA MISMA compra — identificación
      // específica por adquisición: un mismo texto de lote en otra factura
      // nunca entra aquí, se crea como fila nueva más abajo (addLote).
      const existente = _buscarLoteExistente(rec.item_id, rec.numeroLote, compraId)
      if (!existente) continue

      rec.loteExistenteId = existente.id

      const costoExistente = parseFloat(existente.costo_unitario) || 0
      const tcConv = (compra?.currency || 'PEN') === 'USD' ? (parseFloat(compra?.tipo_cambio) || 1) : 1 // PEN no convierte (blindaje 2026-10-05)
      const costoNuevo = parseFloat(((parseFloat(rec.precio_unitario) || 0) * tcConv).toFixed(4))
      if (Math.abs(costoExistente - costoNuevo) >= 0.0001) {
        conflictosCosto.push({ rec, existente, costoExistente, costoNuevo })
      }
    }

    if (conflictosCosto.length > 0) {
      // A esta altura ya es SIEMPRE la misma compra_id (identificación
      // específica por adquisición se resolvió arriba, en _buscarLoteExistente).
      // Si aun así el costo no coincide, es una corrección real dentro de la
      // misma factura (ej. precio_unitario tipeado distinto entre líneas de
      // una misma guía) — ahí sí tiene sentido preguntar si promediar.
      const detalle = conflictosCosto.map(c =>
        `• ${c.rec.nombreProducto} — lote ${c.rec.numeroLote}\n` +
        `    ya registrado en esta factura: ${(parseFloat(c.existente.cantidad) || 0).toLocaleString('en-US', { maximumFractionDigits: 2 })} ${c.existente.unidad_medida || 'KG'} a S/ ${c.costoExistente.toFixed(4)}\n` +
        `    ingresando ahora: ${c.rec.cantidad.toLocaleString('en-US', { maximumFractionDigits: 2 })} ${c.rec.unidadMedida} a S/ ${c.costoNuevo.toFixed(4)}`
      ).join('\n\n')

      const fusionar = confirm(
        `⚠ ${conflictosCosto.length} lote(s) de ESTA MISMA factura ya existían con OTRO costo unitario:\n\n${detalle}\n\n` +
        `Aceptar = SUMAR al lote existente recalculando su costo como promedio ponderado (correcto si es una corrección de precio dentro de la misma factura).\n` +
        `Cancelar = no guardar (revisa el precio unitario o el N° de lote antes de reintentar).`
      )
      if (!fusionar) {
        showToast('Guía no guardada: cambia el N° de lote para separar los ingresos de distinto costo', 'warning')
        return
      }
    }

    const guia = await addGuiaIngresoCompra({
      compra_id:     compraId,
      numero_guia:   numeroGuia,
      fecha_guia:    fechaGuia,
      observaciones,
      created_by:    user.db_id
    })

    if (!guia?.id) { showToast('No se pudo registrar la guía de remisión', 'danger'); return }

    const totalValorGuia = await _aplicarRecepcionesAGuiaIngreso(guia, compra, compraId, recepcionesValidadas, user, fechaGuia, numeroGuia)

    // Asiento de valuación de inventario (20111 debe / 611511 haber).
    // Detrás del mismo candado de desarrollo que la factura de compra.
    if (ASIENTOS_AUTO_COMPRAS_ACTIVO && totalValorGuia > 0.01) {
      try {
        await generarAsientoGuiaRemision({
          monto: totalValorGuia,
          documento_referencia: numeroGuia,
          descripcion: `Guía de Remisión - Ingreso a almacén (${numeroGuia})`,
          contact_id: compra?.contact_id || null,
          fecha: fechaGuia,
          userId: user?.db_id
        })
      } catch (errorAsiento) {
        console.error('Error generando asiento de guía de ingreso (compra doméstica):', errorAsiento)
        showToast(errorAsiento.message || 'Guía registrada, pero no se pudo generar el asiento de valuación de inventario', 'warning')
      }
    }

    showToast('Guía registrada: stock actualizado en Inventario', 'success')
    // Cierre directo (no cerrarModalNuevaGuia): la guía ya se guardó, así
    // que preguntar "¿vas a perder los datos?" aquí sería un falso aviso
    // sobre datos que ya están en la base.
    window.closeModal('modal-nueva-guia')
    S._guiaLineas = []
    // Lotes, stock y kardex cambiaron: sin esto los reportes y el kardex
    // seguirían mostrando las cifras cacheadas de antes de la guía.
    _invalidarCacheCompras()
    await _cargarComprasConGuia(true)
    await renderGuias(true)
    await renderCompras(true)
  } catch (error) {
    console.error('Error en guardarGuiaIngresoCompra:', error)
    showToast('Error: ' + error.message, 'danger')
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Guardar Guía (ingresa stock)' }
  }
}

// ============================================================================
// LOTES EXISTENTES EN LA GUÍA DE INGRESO
// ============================================================================
// Antes, guardar una guía SIEMPRE hacía `addLote(...)`: si escribías un N° de
// lote que ya existía, quedaban dos filas en `lotes` con el mismo número y el
// stock partido entre ambas. En el Kardex (que agrupa por lote_id) el lote
// "viejo" seguía con su cantidad original y el nuevo aparecía aparte, así que
// ninguno mostraba la cantidad real del lote.
//
// Ahora el campo ofrece los lotes que ya existen del producto y, si eliges
// uno, la mercadería SE SUMA a ese lote en vez de crear otro.
//
// Identificación Específica por ADQUISICIÓN (LIR Art. 62° inciso c) / NIC 2
// párr. 24 — aprobado por contabilidad): la unidad de identificación es la
// compra/factura, no el texto que escribe el usuario en "N° de Lote". Un
// mismo texto de lote puede repetirse entre facturas distintas (common
// cuando el proveedor reutiliza su propia numeración) — eso NUNCA debe
// fusionarse ni promediarse, porque el costo real (y su tipo de cambio) es
// distinto por adquisición. Por eso _buscarLoteExistente exige tanto el
// texto del lote COMO la misma compra_id:
//   * mismo texto + misma compra  → es la misma adquisición, se suma a esa
//     fila (con aviso si el costo no cuadra, ver conflictosCosto abajo).
//   * mismo texto + compra distinta → nunca es un match: se crea una fila
//     nueva en `lotes` sin preguntar (índice único ahora es
//     (item_id, numero_lote, compra_id), ver 43_lote_bultos.sql).
function _buscarLoteExistente(itemId, numeroLote, compraId) {
  const num = String(numeroLote || '').trim().toLowerCase()
  if (!num) return null
  return (S._guiaLotesPorItem[itemId] || []).find(lo =>
    String(lo.numero_lote || '').trim().toLowerCase() === num &&
    lo.compra_id === compraId) || null
}

/** Solo para el aviso en pantalla: ¿este texto de lote ya existe pero en OTRA compra? */
function _buscarLoteEnOtraCompra(itemId, numeroLote, compraId) {
  const num = String(numeroLote || '').trim().toLowerCase()
  if (!num) return null
  return (S._guiaLotesPorItem[itemId] || []).find(lo =>
    String(lo.numero_lote || '').trim().toLowerCase() === num &&
    lo.compra_id !== compraId) || null
}

/** Costo unitario en soles que tendría esta recepción (para comparar con el lote existente). */
function _costoRecepcionPen(linea, compra) {
  const tc = parseFloat(compra?.tipo_cambio) || 1
  return parseFloat(((parseFloat(linea.precio_unitario) || 0) * tc).toFixed(4))
}

function _avisarLoteExistente(idx, subIdx, linea, recepcion) {
  const el = document.getElementById(`gc-${idx}-${subIdx}-loteaviso`)
  if (!el) return

  const compraId = S._guiaCompraActual?.id
  const existente = _buscarLoteExistente(linea.item_id, recepcion.numero_lote, compraId)

  if (!existente) {
    const enOtraCompra = _buscarLoteEnOtraCompra(linea.item_id, recepcion.numero_lote, compraId)
    el.className = 'lote-aviso'
    if (enOtraCompra) {
      // Mismo texto de N° de lote, pero de otra factura: identificación
      // específica por adquisición → se crea como capa de costo aparte,
      // no se fusiona ni se pregunta.
      el.innerHTML = `<span style="color:var(--color-info);">↪ Este N° ya existe en otra factura (S/ ${(parseFloat(enOtraCompra.costo_unitario) || 0).toFixed(4)}). Se creará como registro aparte — no se fusiona.</span>`
    } else {
      el.innerHTML = recepcion.numero_lote
        ? '<span style="color:var(--color-success);">Lote nuevo</span>'
        : ''
    }
    return
  }

  const costoExistente = parseFloat(existente.costo_unitario) || 0
  const costoNuevo = _costoRecepcionPen(linea, S._guiaCompraActual)
  const mismoCosto = Math.abs(costoExistente - costoNuevo) < 0.0001
  const zona = existente.ubicacion_id ? (S._guiaZonasNombre[existente.ubicacion_id] || '') : ''

  el.className = 'lote-aviso ' + (mismoCosto ? 'ok' : 'alerta')
  el.innerHTML = mismoCosto
    ? `↪ Ya existe: ${(parseFloat(existente.cantidad) || 0).toLocaleString('en-US', { maximumFractionDigits: 2 })} ${existente.unidad_medida || 'KG'}${zona ? ' en ' + _escCompras(zona) : ''}. <strong>Se sumará a ese lote.</strong>`
    : `⚠ Ya existe con costo distinto (S/ ${costoExistente.toFixed(4)} vs S/ ${costoNuevo.toFixed(4)}). Se preguntará al guardar.`
}
