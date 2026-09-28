// ============================================================================
// inventario/traslados.js — parte de inventario.js (reorganizado 2026-09-25, sin cambios de lógica)
// Mapa completo de funciones: Claude outputs/glosario_funciones_erp.md
// ============================================================================
import { S } from './state.js'
import { getItems, getItemById, getLotes, getLoteById, getAlmacenes, getUbicaciones, getStockUbicaciones, addStockUbicacion, updateStockUbicacion, deleteStockUbicacion, getLoteBultosDisponiblesZona, getKardexById, deleteKardexMovimiento, ultimoErrorDelete } from '../supabase-data.js'
import { showToast, formatQty } from '../helpers.js'
import { refrescarBuscador } from '../buscador-select.js'
import { _fechaDDMMAAAA } from './kardex.js'

// ============================================================================
// TRASLADO INTERNO — MULTI-LÍNEA
// ============================================================================
// Un traslado interno ahora es un documento con cabecera (zona origen, zona
// destino, fecha, descripción, documento de referencia) y varias líneas
// (producto + lote + cantidad), igual que Nueva Compra/Nueva Venta. Cada
// línea sigue generando su propia fila de kardex (mismo tipo_movimiento
// 'traslado_interno'), así que editarTrasladoInterno/eliminarTrasladoInterno
// (que operan sobre UNA fila de kardex) no necesitan cambios.

/* _detallesTrasladoEnCreacion: movido a inventario/state.js (S._detallesTrasladoEnCreacion) */

// Estado transitorio del sub-modal "Agregar Producto al Traslado" cuando el
// lote elegido es de peso variable (bultos): cada bulto pesa distinto, así
// que en vez de teclear la cantidad se marcan bultos concretos (mismo patrón
// que Guía de Despacho en Ventas) y la cantidad se deriva de la selección.
let _tdEsPesoVariable = false
let _tdBultosDisponibles = []
let _tdBultosSeleccionados = []

async function _poblarZonasTraslado(zonaOrigenSeleccionada = null) {
  const [zonas, almacenes] = await Promise.all([getUbicaciones(), getAlmacenes()])
  const almacenMap = {}
  for (const a of (almacenes || [])) almacenMap[a.id] = a

  // Las zonas virtuales (Partners/Vendors, Partners/Customers) son solo para
  // el Kardex de compras/ventas — no son válidas como origen/destino de un
  // traslado interno real entre tus propias zonas.
  const zonasReales = (zonas || []).filter(z => !almacenMap[z.almacen_id]?.es_virtual)
  const opciones = (idExcluir) => zonasReales
    .filter(z => z.id !== idExcluir)
    .map(z => `<option value="${z.id}">${almacenMap[z.almacen_id]?.nombre || '?'} — ${z.nombre}</option>`)
    .join('')

  const selectOrigen = document.getElementById('tiZonaOrigen')
  const selectDestino = document.getElementById('tiZonaDestino')
  selectOrigen.innerHTML = '<option value="">-- Selecciona --</option>' +
    zonasReales.map(z => `<option value="${z.id}">${almacenMap[z.almacen_id]?.nombre || '?'} — ${z.nombre}</option>`).join('')
  selectDestino.innerHTML = '<option value="">-- Selecciona --</option>' + opciones(zonaOrigenSeleccionada ? parseInt(zonaOrigenSeleccionada) : null)

  if (zonaOrigenSeleccionada) {
    selectOrigen.value = zonaOrigenSeleccionada
    // Asignar .value a un <select> no dispara su evento 'change', y el
    // buscador con filtro (buscador-select.js) solo sincroniza el texto
    // visible en 'change' — sin esto el campo "Zona Origen" se veía vacío
    // (placeholder) aunque el select interno sí tenía el valor correcto.
    // Bug preexistente, no visible hasta ahora porque nadie había probado
    // en vivo un traslado prellenado con zona de origen (Luis, 2026-09-21).
    refrescarBuscador('tiZonaOrigen')
  }
}

window.abrirModalNuevoTraslado = async function (zonaOrigenIdPrefill = null) {
  try {
    S._detallesTrasladoEnCreacion = []
    await _poblarZonasTraslado(zonaOrigenIdPrefill)
    document.getElementById('tiFecha').value = new Date().toISOString().split('T')[0]
    document.getElementById('tiDescripcion').value = ''
    document.getElementById('tiDocumentoReferencia').value = ''
    _renderTablaDetalleTraslado()
    window.openModal('modal-traslado-interno')
  } catch (error) {
    console.error('Error en abrirModalNuevoTraslado:', error)
    showToast('Error al abrir el traslado', 'danger')
  }
}

// Atajo desde el botón "Trasladar" de una fila de Stock por Zona: abre el
// modal con esa zona ya como origen y esa línea (item/lote) ya cargada en
// el sub-modal de "Agregar Producto", lista para que solo ajusten cantidad.
window.abrirModalTraslado = async function (stockId) {
  try {
    const stockList = await getStockUbicaciones()
    const registro = (stockList || []).find(s => s.id === stockId)
    if (!registro) { showToast('No se encontró el registro de stock', 'danger'); return }
    const lote = await getLoteById(registro.lote_id)
    if (!lote) { showToast('No se encontró el lote', 'danger'); return }

    await window.abrirModalNuevoTraslado(registro.ubicacion_id)
    await window.abrirModalDetalleTraslado()

    const selProducto = document.getElementById('tdProducto')
    selProducto.value = lote.item_id
    refrescarBuscador('tdProducto') // ver nota en abrirModalTrasladoDesdeResumenZona
    await window.onCambiarProductoDetalleTraslado()
    const selLote = document.getElementById('tdLote')
    selLote.value = registro.lote_id
    refrescarBuscador('tdLote')
    await window.onCambiarLoteDetalleTraslado()
    // Si el lote es de peso variable, la cantidad se deriva de los bultos
    // que el usuario marque (no se prellena a mano: no hay forma de saber
    // de antemano CUÁLES bultos concretos suman ese kg).
    if (!_tdEsPesoVariable) document.getElementById('tdCantidad').value = registro.cantidad
  } catch (error) {
    console.error('Error en abrirModalTraslado:', error)
    showToast('Error al abrir el traslado', 'danger')
  }
}

// Atajo desde el botón "Trasladar" de una fila del resumen POR PRODUCTO
// (modo "General" de Resumen de Stock): a diferencia de abrirModalTraslado
// (que ya sabe zona+lote exactos porque viene de una fila de "Por
// Ubicación"), aquí el producto puede tener stock repartido en varios lotes
// y varias zonas a la vez, así que no hay un origen único que prellenar. Se
// abre el modal de Nuevo Traslado en blanco (igual que "+ Nuevo Traslado")
// y se le pide al usuario elegir la zona de origen y agregar ahí la línea
// del producto/lote que quiere mover.
window.abrirModalTrasladoDesdeProducto = async function (itemId) {
  try {
    await window.abrirModalNuevoTraslado()
    showToast('Elige la zona de origen y agrega el producto/lote a trasladar', 'info')
  } catch (error) {
    console.error('Error en abrirModalTrasladoDesdeProducto:', error)
    showToast('Error al abrir el traslado', 'danger')
  }
}

// Atajo desde el botón "Trasladar" de una fila del resumen "Por Ubicación"
// (modo "zona" de Resumen de Stock): a diferencia de abrirModalTraslado (que
// apuntaba a UN registro puntual de stock_ubicaciones), esa tabla ahora
// agrupa por N° de Lote (texto) + Zona sumando todas las facturas que
// comparten ese texto (ver renderStockZonas) — así que una fila ya no
// corresponde a un único lote_id. Se conoce producto y zona de antemano
// (vienen de la fila), así que solo falta que el usuario elija de cuál
// factura específica descontar en el selector de Lote, que ahora sí muestra
// N° Lote — N° Factura — fecha para poder distinguirlas (2026-09-21).
window.abrirModalTrasladoDesdeResumenZona = async function (itemId, zonaId) {
  try {
    await window.abrirModalNuevoTraslado(zonaId)
    await window.abrirModalDetalleTraslado()
    const selProducto = document.getElementById('tdProducto')
    selProducto.value = itemId
    // Mismo caso que "Zona Origen" en _poblarZonasTraslado: sin esto el
    // campo "Producto" se ve vacío (placeholder) aunque el select interno
    // ya tenga el valor correcto — refrescarBuscador fuerza la sincronía
    // visual que el 'change' automático no dispara.
    refrescarBuscador('tdProducto')
    await window.onCambiarProductoDetalleTraslado()
    showToast('Elige de cuál factura (N° Lote — N° Factura — fecha) quieres trasladar', 'info')
  } catch (error) {
    console.error('Error en abrirModalTrasladoDesdeResumenZona:', error)
    showToast('Error al abrir el traslado', 'danger')
  }
}

window.onCambiarZonaOrigenTraslado = async function () {
  const zonaOrigenId = document.getElementById('tiZonaOrigen')?.value
  if (S._detallesTrasladoEnCreacion.length > 0) {
    showToast('Se limpiaron las líneas agregadas: pertenecían a la zona origen anterior', 'warning')
    S._detallesTrasladoEnCreacion = []
    _renderTablaDetalleTraslado()
  }
  await _poblarZonasTraslado(zonaOrigenId || null)
}

// Devuelve, para una zona origen dada, el stock disponible por item con
// detalle de lotes (item_id -> [{lote_id, numero_lote, numero_factura,
// fecha_ingreso, cantidad, cantidad_unidades, peso_por_unidad, es_peso_variable}]).
// numero_factura/fecha_ingreso se agregan para poder identificar cada capa
// de costo en el selector de Lote del sub-modal de traslado (ver
// onCambiarProductoDetalleTraslado) — con Identificación Específica por
// Adquisición (ver _buscarLoteExistente en compras.js) es normal que varias
// facturas compartan el mismo texto de N° de Lote, y sin más dato no hay
// forma de saber cuál es cuál al elegir de la lista.
async function _stockDisponiblePorItemEnZona(zonaOrigenId) {
  const [stock, lotes, items] = await Promise.all([getStockUbicaciones(), getLotes(), getItems()])
  const loteMap = {}
  for (const l of (lotes || [])) loteMap[l.id] = l
  const itemMap = {}
  for (const it of (items || [])) itemMap[it.id] = it

  const porItem = {}
  for (const s of (stock || [])) {
    if (s.ubicacion_id !== parseInt(zonaOrigenId)) continue
    const cantidad = parseFloat(s.cantidad) || 0
    if (cantidad <= 0) continue
    const lote = loteMap[s.lote_id]
    if (!lote) continue
    const itemId = lote.item_id
    if (!porItem[itemId]) porItem[itemId] = { item: itemMap[itemId], lotes: [] }
    porItem[itemId].lotes.push({
      lote_id: lote.id,
      numero_lote: lote.numero_lote,
      numero_factura: lote.numero_factura || '',
      fecha_ingreso: lote.fecha_ingreso || '',
      cantidad,
      cantidad_unidades: parseFloat(s.cantidad_unidades) || 0,
      peso_por_unidad: parseFloat(lote.peso_por_unidad) || 0,
      es_peso_variable: !!lote.es_peso_variable
    })
  }
  return porItem
}

window.abrirModalDetalleTraslado = async function () {
  const zonaOrigenId = document.getElementById('tiZonaOrigen')?.value
  if (!zonaOrigenId) { showToast('Selecciona primero la zona origen', 'warning'); return }

  const porItem = await _stockDisponiblePorItemEnZona(zonaOrigenId)
  window._tiStockPorItem = porItem

  const selProducto = document.getElementById('tdProducto')
  const ids = Object.keys(porItem)
  if (ids.length === 0) {
    selProducto.innerHTML = '<option value="">-- Sin stock en esa zona --</option>'
    showToast('No hay productos con stock en la zona origen seleccionada', 'warning')
  } else {
    selProducto.innerHTML = '<option value="">-- Selecciona --</option>' +
      ids.map(id => {
        const it = porItem[id].item
        const nombre = it?.nombre || 'Item #' + id
        return `<option value="${id}">${it?.sku ? '(' + it.sku + ') ' : ''}${nombre}</option>`
      }).join('')
  }
  document.getElementById('tdLote').innerHTML = '<option value="">-- Selecciona un producto primero --</option>'
  document.getElementById('tdCantidad').value = ''
  document.getElementById('tdDisponible').textContent = ''
  const inpUnid = document.getElementById('tdCantUnidades')
  if (inpUnid) inpUnid.value = ''
  _ocultarBultosTraslado()

  window.openModal('modal-detalle-traslado')
}

/** Vuelve el sub-modal al modo normal (cantidad tecleada a mano) — se llama al cambiar de producto/lote o al reabrir el modal. */
function _ocultarBultosTraslado() {
  _tdEsPesoVariable = false
  _tdBultosDisponibles = []
  _tdBultosSeleccionados = []
  const grupo = document.getElementById('tdBultosGroup')
  if (grupo) grupo.style.display = 'none'
  const cant = document.getElementById('tdCantidad')
  const unid = document.getElementById('tdCantUnidades')
  if (cant) cant.readOnly = false
  if (unid) unid.readOnly = false
}

window.onCambiarProductoDetalleTraslado = async function () {
  const itemId = document.getElementById('tdProducto')?.value
  const selLote = document.getElementById('tdLote')
  const porItem = window._tiStockPorItem || {}
  const entry = porItem[itemId]

  if (!entry) {
    selLote.innerHTML = '<option value="">-- Selecciona un producto primero --</option>'
    return
  }

  // Resta lo que ya se agregó de este mismo lote en líneas previas de este
  // traslado, para no dejar reservar más de lo que realmente queda.
  // Etiqueta "N° Lote — N° Factura — fecha": con Identificación Específica
  // por Adquisición (compras.js _buscarLoteExistente) es normal que el mismo
  // texto de N° de Lote aparezca varias veces en esta lista (una vez por
  // factura), así que sin factura+fecha no había forma de distinguir cuál
  // capa de costo se estaba escogiendo (Luis lo reportó al ver 6 lotes
  // idénticos "SD60729" en el selector, 2026-09-21).
  selLote.innerHTML = '<option value="">-- Selecciona --</option>' +
    entry.lotes.map(l => {
      const yaAgregadoKg = S._detallesTrasladoEnCreacion
        .filter(d => d.lote_id === l.lote_id)
        .reduce((s, d) => s + (parseFloat(d.cantidad) || 0), 0)
      const yaAgregadoUnid = S._detallesTrasladoEnCreacion
        .filter(d => d.lote_id === l.lote_id)
        .reduce((s, d) => s + (parseFloat(d.cantidad_unidades) || 0), 0)
      const disponible = parseFloat((l.cantidad - yaAgregadoKg).toFixed(4))
      const disponibleUnid = parseFloat((l.cantidad_unidades - yaAgregadoUnid).toFixed(4))
      const etiqueta = `${l.numero_lote} — ${l.numero_factura || 's/factura'} — ${_fechaDDMMAAAA(l.fecha_ingreso)}`
      return `<option value="${l.lote_id}" data-disponible="${disponible}" data-disponible-unid="${disponibleUnid}" data-peso-por-unidad="${l.peso_por_unidad || 0}" data-peso-variable="${l.es_peso_variable ? '1' : '0'}">${etiqueta} (disp. ${disponible.toLocaleString('en-US', { maximumFractionDigits: 2 })})</option>`
    }).join('')

  document.getElementById('tdCantidad').value = ''
  document.getElementById('tdDisponible').textContent = ''
  const inpUnid = document.getElementById('tdCantUnidades')
  if (inpUnid) inpUnid.value = ''
  _ocultarBultosTraslado()
}

/**
 * Al elegir lote: si es de peso variable, carga la lista de bultos
 * disponibles de ESE lote en la zona origen (misma zona todo el traslado)
 * para que el usuario los marque uno por uno — Cantidad/N° Unidades pasan a
 * ser de solo lectura, derivadas de la selección. Si no, mantiene el
 * comportamiento anterior (cantidad tecleada a mano).
 */
window.onCambiarLoteDetalleTraslado = async function () {
  const selLote = document.getElementById('tdLote')
  const opt = selLote?.options[selLote.selectedIndex]
  const disponible = parseFloat(opt?.getAttribute('data-disponible') || 0)
  const disponibleUnid = parseFloat(opt?.getAttribute('data-disponible-unid') || 0)
  const esPesoVariable = opt?.getAttribute('data-peso-variable') === '1'
  const cantInput = document.getElementById('tdCantidad')
  cantInput.max = disponible
  document.getElementById('tdDisponible').textContent = `Disponible: ${disponible.toLocaleString('en-US', { maximumFractionDigits: 2 })} kg` +
    (disponibleUnid > 0 ? ` / ${disponibleUnid.toLocaleString('en-US', { maximumFractionDigits: 2 })} und` : '')

  const loteId = parseInt(selLote?.value || 0)
  const zonaOrigenId = parseInt(document.getElementById('tiZonaOrigen')?.value || 0)

  if (esPesoVariable && loteId && zonaOrigenId) {
    _tdEsPesoVariable = true
    _tdBultosSeleccionados = []
    _tdBultosDisponibles = await getLoteBultosDisponiblesZona(loteId, zonaOrigenId)
    cantInput.value = 0
    cantInput.readOnly = true
    const unid = document.getElementById('tdCantUnidades')
    if (unid) { unid.value = 0; unid.readOnly = true }
    const grupo = document.getElementById('tdBultosGroup')
    if (grupo) grupo.style.display = 'block'
    _renderBultosTraslado()
  } else {
    _ocultarBultosTraslado()
    window.onCambiarCantidadDetalleTraslado()
  }
}

/** Marca/desmarca un bulto en el sub-modal y recalcula Cantidad/N° Unidades como suma/cuenta de lo seleccionado. */
window.toggleBultoTraslado = function (bultoId) {
  const yaMarcado = _tdBultosSeleccionados.includes(bultoId)
  _tdBultosSeleccionados = yaMarcado
    ? _tdBultosSeleccionados.filter(id => id !== bultoId)
    : [..._tdBultosSeleccionados, bultoId]

  const seleccionados = _tdBultosDisponibles.filter(b => _tdBultosSeleccionados.includes(b.id))
  const cantidad = parseFloat(seleccionados.reduce((s, b) => s + (parseFloat(b.peso) || 0), 0).toFixed(4))
  const cantInput = document.getElementById('tdCantidad')
  const unidInput = document.getElementById('tdCantUnidades')
  if (cantInput) cantInput.value = cantidad
  if (unidInput) unidInput.value = seleccionados.length

  _renderBultosTraslado()
}

/**
 * Pinta el checklist de bultos del sub-modal. Los bultos ya elegidos en OTRA
 * línea de este mismo traslado (mismo lote, línea distinta) quedan
 * deshabilitados — evita trasladar el mismo bulto físico dos veces en un
 * solo documento.
 */
function _renderBultosTraslado() {
  const cont = document.getElementById('tdBultosLista')
  const resumen = document.getElementById('tdBultosResumen')
  if (!cont) return

  const loteId = parseInt(document.getElementById('tdLote')?.value || 0)
  const usadosEnOtrasLineas = new Set()
  for (const d of S._detallesTrasladoEnCreacion) {
    if (d.lote_id === loteId) for (const id of (d.bultos_seleccionados || [])) usadosEnOtrasLineas.add(id)
  }

  if (_tdBultosDisponibles.length === 0) {
    cont.innerHTML = '<span style="color:var(--text-secondary); font-size:0.85rem;">No hay bultos disponibles de este lote en la zona origen.</span>'
  } else {
    cont.innerHTML = _tdBultosDisponibles.map(b => {
      const marcado = _tdBultosSeleccionados.includes(b.id)
      const usadoEnOtraLinea = usadosEnOtrasLineas.has(b.id)
      return `
        <label style="display:inline-flex; align-items:center; gap:4px; margin:2px 10px 2px 0; ${usadoEnOtraLinea ? 'opacity:0.4;' : ''}">
          <input type="checkbox" ${marcado ? 'checked' : ''} ${usadoEnOtraLinea ? 'disabled' : ''}
            onchange="window.toggleBultoTraslado(${b.id})">
          ${b.codigo_bulto || ('Bulto #' + b.id)} — ${formatQty(b.peso)} kg${usadoEnOtraLinea ? ' (usado en otra línea)' : ''}
        </label>`
    }).join('')
  }

  const seleccionados = _tdBultosDisponibles.filter(b => _tdBultosSeleccionados.includes(b.id))
  if (resumen) {
    resumen.textContent = seleccionados.length > 0
      ? `${seleccionados.length} bulto(s) seleccionado(s) — ${formatQty(seleccionados.reduce((s, b) => s + (parseFloat(b.peso) || 0), 0))} kg en total`
      : 'Marca al menos un bulto para trasladar.'
  }
}

// Sugiere N° de Unidades a partir del peso_por_unidad del lote elegido,
// igual criterio que en Nueva Venta.
window.onCambiarCantidadDetalleTraslado = function () {
  const selLote = document.getElementById('tdLote')
  const opt = selLote?.options[selLote.selectedIndex]
  const inpUnid = document.getElementById('tdCantUnidades')
  if (!opt || !inpUnid) return
  const pesoPorUnidad = parseFloat(opt.getAttribute('data-peso-por-unidad') || 0)
  const esPesoVariable = opt.getAttribute('data-peso-variable') === '1'
  const cantidad = parseFloat(document.getElementById('tdCantidad')?.value || 0)
  if (pesoPorUnidad > 0) {
    inpUnid.value = parseFloat((cantidad / pesoPorUnidad).toFixed(2))
    inpUnid.placeholder = esPesoVariable ? 'Aproximado (peso variable) — ajusta si hace falta' : ''
  } else {
    inpUnid.value = ''
    inpUnid.placeholder = 'Este lote no trackea unidades'
  }
}

window.agregarLineaTraslado = function () {
  const itemId = parseInt(document.getElementById('tdProducto')?.value || 0)
  const loteId = parseInt(document.getElementById('tdLote')?.value || 0)
  const cantidad = parseFloat(document.getElementById('tdCantidad')?.value || 0)
  const cantidadUnidades = parseFloat(document.getElementById('tdCantUnidades')?.value || 0) || 0
  const selLote = document.getElementById('tdLote')
  const opt = selLote?.options[selLote.selectedIndex]
  const disponible = parseFloat(opt?.getAttribute('data-disponible') || 0)
  const disponibleUnid = parseFloat(opt?.getAttribute('data-disponible-unid') || 0)

  if (!itemId || !loteId) { showToast('Selecciona producto y lote', 'warning'); return }

  // Peso variable: la cantidad SIEMPRE sale de los bultos marcados
  // (toggleBultoTraslado ya la deriva ahí) — si llegó en 0 sin bultos
  // marcados, se bloquea en vez de "trasladar" cantidad sin bultos reales.
  if (_tdEsPesoVariable && _tdBultosSeleccionados.length === 0) {
    showToast('Marca al menos un bulto para trasladar (lote de peso variable)', 'warning')
    return
  }

  if (!cantidad || cantidad <= 0) { showToast('Ingresa una cantidad válida', 'warning'); return }
  if (!_tdEsPesoVariable && cantidad > disponible) {
    showToast(`No hay stock suficiente: disponible ${disponible.toLocaleString('en-US', { maximumFractionDigits: 2 })} kg`, 'danger')
    return
  }
  if (!_tdEsPesoVariable && cantidadUnidades > 0 && cantidadUnidades > disponibleUnid) {
    showToast(`No hay unidades suficientes: disponible ${disponibleUnid.toLocaleString('en-US', { maximumFractionDigits: 2 })} und`, 'danger')
    return
  }

  const porItem = window._tiStockPorItem || {}
  const item = porItem[itemId]?.item

  S._detallesTrasladoEnCreacion.push({
    item_id: itemId,
    item_nombre: item?.nombre || `Item #${itemId}`,
    item_sku: item?.sku || '-',
    lote_id: loteId,
    numero_lote: opt.textContent.split(' (disp.')[0],
    cantidad,
    cantidad_unidades: cantidadUnidades,
    es_peso_variable: _tdEsPesoVariable,
    bultos_seleccionados: _tdEsPesoVariable ? [..._tdBultosSeleccionados] : null
  })

  window.closeModal('modal-detalle-traslado')
  _renderTablaDetalleTraslado()
}

window.quitarLineaTraslado = function (idx) {
  S._detallesTrasladoEnCreacion.splice(idx, 1)
  _renderTablaDetalleTraslado()
}

function _renderTablaDetalleTraslado() {
  const container = document.getElementById('tabla-detalle-traslado')
  if (container) {
    if (S._detallesTrasladoEnCreacion.length === 0) {
      container.innerHTML = '<p style="text-align: center; color: var(--text-secondary); padding: 20px;">Sin productos agregados</p>'
    } else {
      let html = `<table>
        <thead><tr><th>Código</th><th>Producto</th><th>Lote</th><th style="text-align:right;">Cantidad (kg)</th><th style="text-align:right;">N° Unid.</th><th></th></tr></thead>
        <tbody>`
      S._detallesTrasladoEnCreacion.forEach((d, idx) => {
        html += `<tr>
          <td>${d.item_sku || '-'}</td>
          <td>${d.item_nombre}</td>
          <td>${d.numero_lote}</td>
          <td style="text-align:right; font-weight:bold;">${(parseFloat(d.cantidad) || 0).toLocaleString('en-US', { maximumFractionDigits: 2 })}</td>
          <td style="text-align:right;">${(parseFloat(d.cantidad_unidades) || 0) > 0 ? (parseFloat(d.cantidad_unidades) || 0).toLocaleString('en-US', { maximumFractionDigits: 2 }) : '-'}</td>
          <td><button type="button" class="btn btn-small btn-danger" onclick="window.quitarLineaTraslado(${idx})">✕</button></td>
        </tr>`
      })
      html += '</tbody></table>'
      container.innerHTML = html
    }
  }

  const totCant = S._detallesTrasladoEnCreacion.reduce((s, d) => s + (parseFloat(d.cantidad) || 0), 0)
  const elCant = document.getElementById('tiTotalCantidad')
  const elLin = document.getElementById('tiTotalLineas')
  if (elCant) elCant.textContent = totCant.toLocaleString('en-US', { maximumFractionDigits: 2 })
  if (elLin) elLin.textContent = S._detallesTrasladoEnCreacion.length
}

// ============================================================================
// EDITAR / ELIMINAR TRASLADO INTERNO
// ============================================================================
// Un traslado interno es una sola fila de kardex (tipo_movimiento =
// 'traslado_interno') que movió cantidad de una zona origen a una zona
// destino en stock_ubicaciones. Revertirlo es el inverso exacto de
// guardarTrasladoInterno: restar/eliminar en destino, sumar/crear en origen.
//
// Antes de revertir se valida que la zona destino todavía tenga esa cantidad
// disponible AHORA — si parte de ese stock ya se vendió o se volvió a
// trasladar a una tercera zona después, revertir crearía stock negativo, así
// que se bloquea con un mensaje claro (mismo criterio que eliminarGuia /
// eliminarCompra).
//
// "Editar" no muta el movimiento en sitio: revierte el traslado y reabre el
// modal de Traslado prellenado con los datos anteriores, para que el usuario
// corrija y vuelva a guardar. Esto evita recalcular deltas contra un stock
// que pudo haber cambiado, y es consistente con cómo se tratan compras y
// ventas en este sistema (no se editan documentos posteados, se recrean).

async function _revertirTrasladoInterno(mov) {
  const stockList = await getStockUbicaciones()
  const cantidad = parseFloat(mov.cantidad_salida || 0)
  const unidades = parseFloat(mov.cantidad_unidades_salida || 0)

  const destino = stockList.find(s => s.lote_id === mov.lote_id && s.ubicacion_id === mov.ubicacion_destino_id)
  const disponibleDestino = parseFloat(destino?.cantidad || 0)
  const disponibleUnidDestino = parseFloat(destino?.cantidad_unidades || 0)

  if (disponibleDestino < cantidad) {
    throw new Error(`No se puede revertir: en la zona destino solo quedan ${disponibleDestino.toLocaleString('en-US', { maximumFractionDigits: 2 })} unidades de este lote (se trasladaron ${cantidad.toLocaleString('en-US', { maximumFractionDigits: 2 })}). Parte de ese stock ya se vendió o se volvió a trasladar desde ahí.`)
  }

  // Restar (o eliminar) la fila de destino
  const restanteDestino = parseFloat((disponibleDestino - cantidad).toFixed(4))
  const restanteUnidDestino = Math.max(0, parseFloat((disponibleUnidDestino - unidades).toFixed(4)))
  if (restanteDestino <= 0) {
    await deleteStockUbicacion(destino.id)
  } else {
    await updateStockUbicacion(destino.id, { cantidad: restanteDestino, cantidad_unidades: restanteUnidDestino })
  }

  // Sumar (o crear) la fila de origen
  const origen = stockList.find(s => s.lote_id === mov.lote_id && s.ubicacion_id === mov.ubicacion_origen_id)
  let origenStockId
  if (origen) {
    const nuevaCantidadOrigen = parseFloat(((parseFloat(origen.cantidad) || 0) + cantidad).toFixed(4))
    const nuevaUnidadesOrigen = parseFloat(((parseFloat(origen.cantidad_unidades) || 0) + unidades).toFixed(4))
    await updateStockUbicacion(origen.id, { cantidad: nuevaCantidadOrigen, cantidad_unidades: nuevaUnidadesOrigen })
    origenStockId = origen.id
  } else {
    const nuevo = await addStockUbicacion({ lote_id: mov.lote_id, ubicacion_id: mov.ubicacion_origen_id, cantidad, cantidad_unidades: unidades })
    origenStockId = nuevo.id
  }

  const okKardex = await deleteKardexMovimiento(mov.id)
  if (!okKardex) {
    const motivo = ultimoErrorDelete()
    throw new Error(`No se pudo eliminar el movimiento de Kardex #${mov.id} del traslado interno: ${motivo?.mensaje || 'motivo desconocido'}. Se detiene la reversión para no dejar el Kardex descuadrado.`)
  }
  return { origenStockId }
}

window.eliminarTrasladoInterno = async function (kardexId) {
  if (!confirm('¿Eliminar este traslado interno? El stock trasladado se devolverá a la zona de origen.')) return
  try {
    const mov = await getKardexById(kardexId)
    if (!mov) { showToast('No se encontró el movimiento', 'danger'); return }
    if (mov.tipo_movimiento !== 'traslado_interno') {
      showToast('Solo se pueden eliminar traslados internos desde aquí', 'warning')
      return
    }

    await _revertirTrasladoInterno(mov)

    showToast('Traslado eliminado y stock devuelto a la zona de origen', 'success')
    await window.renderResumenStockUnificado()
    if (document.getElementById('kardexItemSelect')?.value) await window.cargarKardex()
  } catch (error) {
    console.error('Error en eliminarTrasladoInterno:', error)
    showToast(error.message || 'Error al eliminar el traslado', 'danger')
  }
}

window.editarTrasladoInterno = async function (kardexId) {
  if (!confirm('Para editar, el traslado se eliminará (devolviendo el stock a origen) y se abrirá el formulario con los datos anteriores para que los corrijas y lo guardes de nuevo. ¿Continuar?')) return
  try {
    const mov = await getKardexById(kardexId)
    if (!mov) { showToast('No se encontró el movimiento', 'danger'); return }
    if (mov.tipo_movimiento !== 'traslado_interno') {
      showToast('Solo se pueden editar traslados internos desde aquí', 'warning')
      return
    }

    const datosPrevios = {
      cantidad:             parseFloat(mov.cantidad_salida || 0),
      cantidadUnidades:     parseFloat(mov.cantidad_unidades_salida || 0),
      zonaOrigenId:         mov.ubicacion_origen_id,
      zonaDestinoId:        mov.ubicacion_destino_id,
      fecha:                mov.fecha,
      descripcion:          mov.descripcion || '',
      documentoReferencia:  mov.documento_referencia || ''
    }

    const lote = await getLoteById(mov.lote_id)
    const item = lote ? await getItemById(lote.item_id) : null

    await _revertirTrasladoInterno(mov)

    showToast('Traslado revertido. Corrige los datos y guarda de nuevo.', 'success')
    await window.renderResumenStockUnificado()
    if (document.getElementById('kardexItemSelect')?.value) await window.cargarKardex()

    // Reabre el modal multi-línea con la cabecera prellenada y esta línea ya
    // cargada (revertida), lista para ajustar cantidad/zona/lote si hace falta.
    await window.abrirModalNuevoTraslado(datosPrevios.zonaOrigenId)
    document.getElementById('tiZonaDestino').value = datosPrevios.zonaDestinoId
    if (datosPrevios.fecha) document.getElementById('tiFecha').value = datosPrevios.fecha
    document.getElementById('tiDescripcion').value = datosPrevios.descripcion
    document.getElementById('tiDocumentoReferencia').value = datosPrevios.documentoReferencia

    S._detallesTrasladoEnCreacion.push({
      item_id: lote?.item_id || null,
      item_nombre: item?.nombre || `Item #${lote?.item_id ?? '?'}`,
      lote_id: mov.lote_id,
      numero_lote: lote?.numero_lote || '-',
      cantidad: datosPrevios.cantidad,
      cantidad_unidades: datosPrevios.cantidadUnidades
    })
    _renderTablaDetalleTraslado()
  } catch (error) {
    console.error('Error en editarTrasladoInterno:', error)
    showToast(error.message || 'Error al editar el traslado', 'danger')
  }
}
