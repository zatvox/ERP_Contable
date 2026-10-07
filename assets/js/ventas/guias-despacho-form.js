// ============================================================================
// ventas/guias-despacho-form.js — parte de ventas.js (reorganizado 2026-09-25, sin cambios de lógica)
// Mapa completo de funciones: Claude outputs/glosario_funciones_erp.md
// ============================================================================
import { S } from './state.js'
import { getCurrentUser } from '../auth-supabase.js'
import { getCustomers, getLotes, getLoteById, updateLote, getVentas, getVentaById, getDetalleVentas, updateDetalleVenta, getAlmacenes, getStockUbicaciones, updateStockUbicacion, deleteStockUbicacion, getUbicacionCustomers, addKardexMovimiento, getGuiasDespachoVenta, getGuiaDespachoVentaById, addGuiaDespachoVenta, updateGuiaDespachoVenta, getDetalleGuiasDespachoVenta, getDetalleGuiasDespachoVentaByVenta, addDetalleGuiaDespachoVenta, deleteDetalleGuiaDespachoVenta, getLoteBultosDisponiblesZona, updateLoteBulto, recalcularLoteDesdeBultos } from '../supabase-data.js'
import { showToast, formatQty } from '../helpers.js'
import { getUbicaciones, getKardexByVenta } from '../supabase-data.js'
import { estaAnulado } from '../anulacion.js'
import { convertirEnBuscador, refrescarBuscador } from '../buscador-select.js'
import { _invalidarCacheVentas } from './anulacion.js'
import { _recalcularEstadoDespachoVenta, _revertirStockGuiaDespacho, renderGuiasDespachoVenta } from './guias-despacho-lista.js'
import { _refrescarStockLoteEnVivo } from './helpers.js'
import { _almacenes, _zonas } from './init.js'
import { _guiaEstaVigente, _setEv } from './ventas-editar.js'
import { renderVentas } from './ventas-lista.js'
import { serieGuiaDeComprobante, serieDeNumeroGuia, registrarUsoGuia, montarNumeroConSerie } from '../series.js'
export { _numGuiaDespacho }


/** Destino de la venta en el kardex según la serie de la guía (T001 →
 *  Partners/Customers, GN01 → Partners/90). Sin serie registrada o sin
 *  destino configurado → Partners/Customers, como siempre. */
async function _destinoKardexGuia(numeroGuia, customersZona) {
  const sg = await serieDeNumeroGuia(numeroGuia)
  return sg?.ubicacion_destino_id || customersZona?.id || null
}

/** N° de guía = [Serie ▾] + [Correlativo 🔒] (series.js montarNumeroConSerie).
 *  La serie se propone según el comprobante de la venta (FFFI/BBOL → T001,
 *  NV01 → GN01) y solo se puede elegir entre las series 09 activas. */
function _numGuiaDespacho() { return montarNumeroConSerie('gdNumeroGuia', { tipo: '09', onCambio: () => _sugerirDestinoGuia() }) }

// ── Destino de la guía (editable) — 2026-10-06 ───────────────────────────────
// Lista = ubicaciones de almacenes virtuales (Partners/…). Se PROPONE según la
// serie (series_documentos.ubicacion_destino_id; sin dato → Customers) y se
// re-propone al cambiar la serie, salvo que el usuario ya lo haya elegido a mano.
let _gdDestinoManual = false
async function _poblarDestinosGuia() {
  const sel = document.getElementById('gdDestino')
  if (!sel) return
  const alms = (_almacenes && _almacenes.length) ? _almacenes : ((await getAlmacenes().catch(() => [])) || [])
  const almVirt = new Set(alms.filter(a => a.es_virtual).map(a => a.id))
  const almNom = {}; alms.forEach(a => { almNom[a.id] = a.nombre })
  const ubic = (await getUbicaciones().catch(() => [])) || []
  const todas = ubic.filter(u => u.activo !== false && almNom[u.almacen_id] !== undefined)
    .map(u => ({ id: u.id, virtual: almVirt.has(u.almacen_id), label: `${almNom[u.almacen_id] || ''} / ${u.nombre}` }))
    .sort((a, b) => a.label.localeCompare(b.label))
  _gdDestinosReales = new Map(todas.filter(d => !d.virtual).map(d => [String(d.id), d.label]))
  const opt = (d) => `<option value="${d.id}">${_escGD(d.label)}</option>`
  const virt = todas.filter(d => d.virtual), reales = todas.filter(d => !d.virtual)
  const actual = sel.value
  sel.innerHTML =
    (virt.length ? `<optgroup label="Partners (virtual · no suma stock)">${virt.map(opt).join('')}</optgroup>` : '') +
    (reales.length ? `<optgroup label="Zonas reales (⚠ suman stock)">${reales.map(opt).join('')}</optgroup>` : '')
  if (actual && todas.some(d => String(d.id) === actual)) sel.value = actual
}
// id → etiqueta de las ubicaciones de almacenes REALES (no virtuales)
let _gdDestinosReales = new Map()
function _pintarInfoDestino(texto) {
  const info = document.getElementById('gdDestinoInfo')
  if (!info) return
  const v = document.getElementById('gdDestino')?.value || ''
  const real = _gdDestinosReales.has(v)
  info.textContent = real ? `⚠ Zona real: la mercadería vuelve a sumar stock aquí` : texto
  info.style.color = real ? 'var(--warning, #b45309)' : ''
}
/** Si el destino elegido es una zona real, pide confirmación. true = seguir. */
function _confirmarDestinoRealGuia() {
  const v = document.getElementById('gdDestino')?.value || ''
  if (!_gdDestinosReales.has(v)) return true
  return confirm(
    `El destino "${_gdDestinosReales.get(v)}" es una zona REAL del almacén.\n\n` +
    `La venta quedará despachada en el kardex y además la mercadería volverá a sumar stock en esa zona.\n\n¿Continuar?`
  )
}
const _escGD = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))

async function _sugerirDestinoGuia() {
  const sel = document.getElementById('gdDestino')
  const info = document.getElementById('gdDestinoInfo')
  if (!sel || _gdDestinoManual) return
  const numero = document.getElementById('gdNumeroGuia')?.value || ''
  const sg = await serieDeNumeroGuia(numero)
  const cust = await getUbicacionCustomers()
  const id = sg?.ubicacion_destino_id || cust?.id || null
  if (id) sel.value = String(id)
  if (info) _pintarInfoDestino(sg?.ubicacion_destino_id ? `Según serie ${sg.serie}` : 'Por defecto: Customers')
}

window._gdOnCambiarDestino = function () {
  _gdDestinoManual = true
  _pintarInfoDestino('Elegido a mano')
}

/** Prepara el selector de destino. Edición: toma el destino que ya usó la guía en el kardex. */
export async function _prepararDestinoGuia({ numeroGuia = null, ventaId = null } = {}) {
  _gdDestinoManual = false
  await _poblarDestinosGuia()
  if (numeroGuia && ventaId) {
    const ks = (await getKardexByVenta(ventaId).catch(() => [])) || []
    const k = ks.find(x => x.documento_referencia === numeroGuia && x.tipo_movimiento === 'salida' && x.ubicacion_destino_id)
    if (k) {
      const sel = document.getElementById('gdDestino')
      if (sel) sel.value = String(k.ubicacion_destino_id)
      _gdDestinoManual = true
      _pintarInfoDestino('Destino actual de la guía')
      return
    }
  }
  await _sugerirDestinoGuia()
}

/** Destino elegido en el modal (o el de la serie como respaldo). */
async function _destinoElegidoGuia(numeroGuia, customersZona) {
  const v = parseInt(document.getElementById('gdDestino')?.value || 0)
  return v || await _destinoKardexGuia(numeroGuia, customersZona)
}

async function _sugerirNumeroGuia(venta) {
  if (S._guiaDespachoEditId) return
  const sg = await serieGuiaDeComprobante(venta?.tipo_comprobante, venta?.serie)
  await _numGuiaDespacho()?.preparar({ serie: sg?.serie || null })
  const ancla = document.getElementById('gdNumeroGuia-serie')?.parentElement
  let hint = document.getElementById('gdNumeroGuiaInfo')
  if (!hint && ancla) {
    hint = document.createElement('small')
    hint.id = 'gdNumeroGuiaInfo'
    hint.style.cssText = 'color:var(--text-secondary); font-size:0.8rem;'
    ancla.insertAdjacentElement('afterend', hint)
  }
  if (hint) hint.textContent = sg ? `Serie ${sg.serie} según comprobante ${venta?.serie || ''}${sg.es_cpe ? '' : ' · física (no SUNAT)'}` : ''
}

// ============================================================================
// TAB: GUÍAS DE DESPACHO DE VENTA (espejo exacto de Guías de Remisión en
// Compras, ver compras.js). La Venta solo registra el comprobante; recién
// acá se elige lote+zona real y se descuenta stock/kardex. Una venta puede
// despacharse en varias guías (envíos parciales) — cada línea de venta
// puede repartirse entre varios lotes/zonas ("despachos"), igual que en
// Compras una línea comprada puede recibirse en varias "recepciones".
// ============================================================================

/* _guiaDespachoLineas: movido a ventas/state.js (S._guiaDespachoLineas) */   // [{ detalle_venta_id, item_id, nombre, unidad_medida, cantidad_vendida, cantidad_despachada_previa, despachos:[{cantidad, cantidad_unidades, ubicacion_id, lote_id, numero_lote}] }]
/* _guiaDespachoZonasCache: movido a ventas/state.js (S._guiaDespachoZonasCache) */
/* _guiasDespachoLista: movido a ventas/state.js (S._guiasDespachoLista) */   // cache de guias_despacho_venta enriquecidas para el tab
let _ventasPendientesGuiaCache = null

/** Ventas con estado_despacho pendiente o parcial (candidatas a recibir una guía). */
async function _cargarVentasPendientesDespacho(forzar = false) {
  if (_ventasPendientesGuiaCache && !forzar) return _ventasPendientesGuiaCache
  const [ventas, clientes] = await Promise.all([getVentas(), getCustomers()])
  const clientesMap = {}
  for (const c of (clientes || [])) clientesMap[c.id] = c
  _ventasPendientesGuiaCache = (ventas || [])
    // Una venta anulada nunca despachó nada y nunca va a despachar: aunque
    // su estado_despacho haya quedado en 'pendiente' (anular no lo toca),
    // no debe seguir apareciendo como candidata a Guía de Despacho.
    // Una Nota de Crédito/Débito se guarda como "una venta más" (tipo_comprobante
    // '07'/'08') y hereda estado_despacho='pendiente' por defecto aunque NUNCA
    // se despacha — no es una venta de mercadería, es un ajuste de otra venta.
    // Sin este filtro aparecía en el selector como si fuera una venta real.
    // Un anticipo de cliente (tipo_venta='anticipo') tampoco se despacha —
    // es solo el cobro adelantado, sin productos; se excluye igual que NC/ND.
    .filter(v => (v.estado_despacho === 'pendiente' || v.estado_despacho === 'parcial') && !estaAnulado(v) &&
      v.tipo_comprobante !== '07' && v.tipo_comprobante !== '08' && v.tipo_venta !== 'anticipo')
    .map(v => ({ ...v, clienteNombre: clientesMap[v.contact_id]?.razon_social || clientesMap[v.contact_id]?.nombre || '-' }))
    .sort((a, b) => new Date(b.fecha_emision || 0) - new Date(a.fecha_emision || 0))
  return _ventasPendientesGuiaCache
}

/** Zonas reales (no virtuales) donde el ítem tiene stock > 0. */
function _zonasConStockItem(itemId) {
  const almacenesMap = {}
  for (const a of (_almacenes || [])) almacenesMap[a.id] = a
  const zonaIds = new Set(
    (S._stockUbic || [])
      .filter(su => S._lotesMap[su.lote_id]?.item_id === itemId && (parseFloat(su.cantidad) || 0) > 0)
      .map(su => su.ubicacion_id)
  )
  return (_zonas || [])
    .filter(z => zonaIds.has(z.id) && !almacenesMap[z.almacen_id]?.es_virtual)
    .map(z => ({ id: z.id, nombre: z.nombre, almacenNombre: almacenesMap[z.almacen_id]?.nombre || '?' }))
}

/** Lotes con stock > 0 del ítem en la zona elegida, más antiguos primero (FIFO sugerido). */
function _lotesConStockZona(itemId, zonaId) {
  return (S._stockUbic || [])
    .filter(su => su.ubicacion_id === zonaId && S._lotesMap[su.lote_id]?.item_id === itemId && (parseFloat(su.cantidad) || 0) > 0)
    .map(su => ({
      stock_ubicacion_id: su.id,
      lote_id: su.lote_id,
      numero_lote: S._lotesMap[su.lote_id]?.numero_lote || '?',
      disponible: parseFloat(su.cantidad) || 0,
      disponibleUnid: parseFloat(su.cantidad_unidades) || 0
    }))
    .sort((a, b) => new Date(S._lotesMap[a.lote_id]?.fecha_ingreso || 0) - new Date(S._lotesMap[b.lote_id]?.fecha_ingreso || 0))
}

window.abrirModalNuevaGuiaDespacho = async function () {
  try {
    S._guiaDespachoLineas = []
    S._guiaDespachoEditId = null
    const form = document.getElementById('formNuevaGuiaDespacho')
    if (form) form.reset()
    await _numGuiaDespacho()?.preparar()   // T001 por defecto hasta elegir la venta
    await _prepararDestinoGuia()
    _numGuiaDespacho()?.bloquear(false)
    const _hint = document.getElementById('gdNumeroGuiaInfo'); if (_hint) _hint.textContent = ''
    document.getElementById('gdInfoVenta').style.display = 'none'
    document.getElementById('gdFechaGuia').value = new Date().toISOString().split('T')[0]
    document.getElementById('tabla-detalle-guia-despacho').innerHTML =
      '<p style="text-align:center; color:var(--text-secondary); padding:20px;">Selecciona una venta para ver sus productos pendientes.</p>'
    const aviso = document.getElementById('gd-edicion-aviso')
    if (aviso) aviso.style.display = 'none'
    _setEv('gd-titulo-modal', 'Nueva Guía de Despacho de Venta')
    const btnGuardar = document.getElementById('btnGuardarGuiaDespachoVenta')
    if (btnGuardar) { btnGuardar.textContent = 'Guardar Guía (descuenta stock)'; btnGuardar.onclick = () => window.guardarGuiaDespachoVenta() }

    const ventasPend = await _cargarVentasPendientesDespacho(true)
    const sel = document.getElementById('gdVenta')
    if (sel) {
      sel.disabled = false
      sel.innerHTML = '<option value="">-- Selecciona una venta pendiente/parcial --</option>' +
        ventasPend.map(v => `<option value="${v.id}">${v.serie || ''}-${String(v.correlativo || '').padStart(8,'0')} — ${v.clienteNombre} (${v.estado_despacho})</option>`).join('')
    }
    window.openModal('modal-nueva-guia-despacho')
  } catch (error) {
    console.error('Error en abrirModalNuevaGuiaDespacho:', error)
    showToast('Error al abrir el formulario de guía de despacho', 'danger')
  }
}

/* _guiaDespachoEditId: movido a ventas/state.js (S._guiaDespachoEditId) */   // null = modo "crear"; id de la guía = modo "editar" (mismo modal, mismo array _guiaDespachoLineas)

window.cerrarModalNuevaGuiaDespacho = function () {
  S._guiaDespachoEditId = null
  const selVenta = document.getElementById('gdVenta')
  if (selVenta) selVenta.disabled = false
  const aviso = document.getElementById('gd-edicion-aviso')
  if (aviso) aviso.style.display = 'none'
  _setEv('gd-titulo-modal', 'Nueva Guía de Despacho de Venta')
  const btn = document.getElementById('btnGuardarGuiaDespachoVenta')
  if (btn) { btn.textContent = 'Guardar Guía (descuenta stock)'; btn.onclick = () => window.guardarGuiaDespachoVenta() }
  window.closeModal('modal-nueva-guia-despacho')
}

window.onSeleccionarVentaGuiaDespacho = async function () {
  try {
    const ventaId = parseInt(document.getElementById('gdVenta')?.value || 0)
    const infoDiv = document.getElementById('gdInfoVenta')
    const tablaDiv = document.getElementById('tabla-detalle-guia-despacho')

    if (!ventaId) {
      infoDiv.style.display = 'none'
      tablaDiv.innerHTML = '<p style="text-align:center; color:var(--text-secondary); padding:20px;">Selecciona una venta para ver sus productos pendientes.</p>'
      S._guiaDespachoLineas = []
      return
    }

    const [venta, detalles, despachosVenta, almacenes] = await Promise.all([
      getVentaById(ventaId),
      getDetalleVentas(ventaId),
      getDetalleGuiasDespachoVentaByVenta(ventaId),
      getAlmacenes()
    ])

    const cliente = S._clientes.find(c => c.id === venta?.contact_id)
    infoDiv.style.display = 'block'
    infoDiv.innerHTML = `
      <strong>Cliente:</strong> ${cliente?.razon_social || cliente?.nombre || '-'} &nbsp;|&nbsp;
      <strong>Comprobante:</strong> ${venta?.serie || ''}-${String(venta?.correlativo || '').padStart(8,'0')} &nbsp;|&nbsp;
      <strong>Fecha venta:</strong> ${venta?.fecha_emision || '-'} &nbsp;|&nbsp;
      <strong>Estado despacho:</strong> ${venta?.estado_despacho || 'pendiente'}
    `
    await _sugerirNumeroGuia(venta)

    const almacenesMap = {}
    for (const a of (almacenes || [])) almacenesMap[a.id] = a
    S._guiaDespachoZonasCache = (_zonas || [])
      .filter(z => !almacenesMap[z.almacen_id]?.es_virtual)
      .map(z => ({ id: z.id, nombre: z.nombre, almacen_id: z.almacen_id, almacenNombre: almacenesMap[z.almacen_id]?.nombre || `Almacén #${z.almacen_id}` }))

    // Ya despachado por cada detalle_venta_id (sumando sus guías previas).
    // Las guías ANULADAS no cuentan: su stock ya volvió a Inventario, así que
    // esa cantidad está otra vez pendiente de despachar.
    const guiasDeEstaVenta = (await getGuiasDespachoVenta(true) || []).filter(g => g.venta_id === ventaId)
    const anuladasIds = new Set(guiasDeEstaVenta.filter(g => !_guiaEstaVigente(g)).map(g => g.id))

    const despachadoPorDetalle = {}
    for (const d of (despachosVenta || [])) {
      if (anuladasIds.has(d.guia_id)) continue
      despachadoPorDetalle[d.detalle_venta_id] = (despachadoPorDetalle[d.detalle_venta_id] || 0) + (parseFloat(d.cantidad) || 0)
    }

    S._guiaDespachoLineas = (detalles || [])
      .map(d => {
        const cantidadVendida = parseFloat(d.cantidad) || 0
        const yaDespachado = despachadoPorDetalle[d.id] || 0
        const pendiente = parseFloat((cantidadVendida - yaDespachado).toFixed(4))
        const itemRef = (S._items || []).find(it => it.id === d.item_id)
        return {
          detalle_venta_id: d.id,
          item_id: d.item_id,
          nombre: itemRef?.nombre || d.descripcion || `Item #${d.item_id}`,
          sku: itemRef?.sku || '',
          unidad_medida: d.unidad_medida,
          cantidad_vendida: cantidadVendida,
          cantidad_despachada_previa: yaDespachado,
          cantidad_pendiente: pendiente,
          // esPesoVariable/bultosDisponibles/bultosSeleccionados se llenan al
          // elegir un lote con lotes.es_peso_variable=true (Fase 2): ahí la
          // cantidad/unidades dejan de escribirse a mano y se derivan de qué
          // bultos concretos se marcan (mismo patrón que Fase 1 en compras,
          // pero seleccionando bultos existentes en vez de creando nuevos).
          despachos: pendiente > 0 ? [{
            cantidad: pendiente, cantidad_unidades: null, ubicacion_id: '', lote_id: '',
            esPesoVariable: false, bultosDisponibles: [], bultosSeleccionados: []
          }] : []
        }
      })
      .filter(l => l.cantidad_pendiente > 0)

    _renderTablaDetalleGuiaDespacho()
  } catch (error) {
    console.error('Error en onSeleccionarVentaGuiaDespacho:', error)
    showToast('Error al cargar el detalle de la venta', 'danger')
  }
}

function _sincronizarDespachosGuiaDesdeDOM() {
  S._guiaDespachoLineas.forEach((l, idx) => {
    l.despachos.forEach((desp, subIdx) => {
      const zona = document.getElementById(`gd-${idx}-${subIdx}-zona`)
      const lote = document.getElementById(`gd-${idx}-${subIdx}-lote`)
      if (zona) desp.ubicacion_id = parseInt(zona.value || 0) || ''
      if (lote) desp.lote_id = parseInt(lote.value || 0) || ''
      // Para peso variable, cantidad/cantidad_unidades se derivan SIEMPRE de
      // los bultos marcados (toggleBultoDespachoGuia ya los mantiene al día
      // en desp.cantidad/desp.cantidad_unidades) — los inputs son readonly,
      // leerlos del DOM aquí solo repetiría lo mismo o, peor, pisaría el
      // valor correcto con un string a medio formatear.
      if (!desp.esPesoVariable) {
        const cant = document.getElementById(`gd-${idx}-${subIdx}-cantidad`)
        const cantUnid = document.getElementById(`gd-${idx}-${subIdx}-unidades`)
        if (cant)     desp.cantidad = parseFloat(cant.value || 0)
        if (cantUnid) desp.cantidad_unidades = cantUnid.value !== '' ? parseFloat(cantUnid.value) : null
      }
    })
  })
}

window.agregarDespachoGuia = function (idx) {
  _sincronizarDespachosGuiaDesdeDOM()
  const l = S._guiaDespachoLineas[idx]
  if (!l) return
  l.despachos.push({
    cantidad: 0, cantidad_unidades: null, ubicacion_id: '', lote_id: '',
    esPesoVariable: false, bultosDisponibles: [], bultosSeleccionados: []
  })
  _renderTablaDetalleGuiaDespacho()
}

window.quitarDespachoGuia = function (idx, subIdx) {
  _sincronizarDespachosGuiaDesdeDOM()
  const l = S._guiaDespachoLineas[idx]
  if (!l) return
  l.despachos.splice(subIdx, 1)
  _renderTablaDetalleGuiaDespacho()
}

/** Al elegir zona en una fila de despacho: repuebla el select de lote de ESA fila con los lotes que tienen stock ahí, y si ya había un lote de peso variable elegido, refresca su lista de bultos disponibles EN LA NUEVA zona. */
window.onCambiarZonaDespachoGuia = async function (idx, subIdx) {
  _sincronizarDespachosGuiaDesdeDOM()
  // Mismo estándar que "Agregar Producto a la Venta": leer stock fresco
  // justo antes de poblar el select de Lote, no una foto vieja de cuando se
  // abrió el modal de la guía.
  await _refrescarStockLoteEnVivo()
  const l = S._guiaDespachoLineas[idx]
  const desp = l?.despachos[subIdx]
  if (desp) {
    // Cambiar de zona invalida cualquier selección de bultos previa (eran de
    // otra ubicación): se limpia y, si el lote sigue siendo válido para la
    // nueva zona, se re-carga la lista de bultos disponibles ahí.
    desp.bultosSeleccionados = []
    desp.bultosDisponibles = []
    if (desp.esPesoVariable && desp.lote_id && desp.ubicacion_id) {
      desp.bultosDisponibles = await getLoteBultosDisponiblesZona(desp.lote_id, desp.ubicacion_id)
    }
    desp.cantidad = 0
    desp.cantidad_unidades = desp.esPesoVariable ? 0 : desp.cantidad_unidades
  }
  _renderTablaDetalleGuiaDespacho()
}

/** Al elegir lote en una fila de despacho: si el lote es de peso variable (bultos), carga la lista de bultos disponibles en esa zona para que el usuario los marque uno por uno (Cantidad/Unidades pasan a ser de solo lectura, calculadas de la selección). Si no, mantiene el comportamiento anterior (sugerir N° de Unidades según peso_por_unidad). */
window.onCambiarLoteDespachoGuia = async function (idx, subIdx) {
  _sincronizarDespachosGuiaDesdeDOM()
  const l = S._guiaDespachoLineas[idx]
  const desp = l?.despachos[subIdx]
  if (desp) {
    const lote = desp.lote_id ? S._lotesMap[desp.lote_id] : null
    if (lote?.es_peso_variable) {
      desp.esPesoVariable = true
      desp.bultosSeleccionados = []
      desp.cantidad = 0
      desp.cantidad_unidades = 0
      desp.bultosDisponibles = desp.ubicacion_id ? await getLoteBultosDisponiblesZona(desp.lote_id, desp.ubicacion_id) : []
    } else {
      desp.esPesoVariable = false
      desp.bultosDisponibles = []
      desp.bultosSeleccionados = []
      if (lote?.peso_por_unidad && lote.peso_por_unidad > 0) {
        desp.cantidad_unidades = parseFloat(((desp.cantidad || 0) / lote.peso_por_unidad).toFixed(2))
      }
    }
  }
  _renderTablaDetalleGuiaDespacho()
}

/** Al cambiar la cantidad de una fila de despacho: re-sugiere N° de Unidades si el lote elegido trackea peso por unidad. No aplica a peso variable (el input es readonly ahí). */
window.onCambiarCantidadDespachoGuia = function (idx, subIdx) {
  _sincronizarDespachosGuiaDesdeDOM()
  const l = S._guiaDespachoLineas[idx]
  const desp = l?.despachos[subIdx]
  if (desp && !desp.esPesoVariable) {
    const lote = desp.lote_id ? S._lotesMap[desp.lote_id] : null
    if (lote?.peso_por_unidad && lote.peso_por_unidad > 0) {
      desp.cantidad_unidades = parseFloat(((desp.cantidad || 0) / lote.peso_por_unidad).toFixed(2))
    }
  }
  _renderTablaDetalleGuiaDespacho()
}

/**
 * Marca/desmarca un bulto en una fila de despacho de peso variable y
 * recalcula cantidad/cantidad_unidades como la suma/cuenta de lo
 * seleccionado (mismo patrón que la lista de empaque de Fase 1 en compras,
 * pero aquí se SELECCIONAN bultos ya existentes en vez de crearlos).
 * Bloquea seleccionar un bulto que ya está marcado en OTRA fila de este
 * mismo guardado (evita vender el mismo bulto físico dos veces).
 */
window.toggleBultoDespachoGuia = function (idx, subIdx, bultoId) {
  _sincronizarDespachosGuiaDesdeDOM()
  const l = S._guiaDespachoLineas[idx]
  const desp = l?.despachos[subIdx]
  if (!desp) return

  const yaSeleccionado = desp.bultosSeleccionados.includes(bultoId)
  if (!yaSeleccionado) {
    const usadoEnOtraFila = S._guiaDespachoLineas.some((ll, i2) =>
      ll.despachos.some((d2, s2) => (i2 !== idx || s2 !== subIdx) && (d2.bultosSeleccionados || []).includes(bultoId))
    )
    if (usadoEnOtraFila) {
      showToast('Ese bulto ya fue asignado a otra línea de esta guía', 'warning')
      return
    }
    desp.bultosSeleccionados.push(bultoId)
  } else {
    desp.bultosSeleccionados = desp.bultosSeleccionados.filter(id => id !== bultoId)
  }

  const seleccionados = (desp.bultosDisponibles || []).filter(b => desp.bultosSeleccionados.includes(b.id))
  desp.cantidad = parseFloat(seleccionados.reduce((s, b) => s + (parseFloat(b.peso) || 0), 0).toFixed(4))
  desp.cantidad_unidades = seleccionados.length

  _renderTablaDetalleGuiaDespacho()
}

export function _renderTablaDetalleGuiaDespacho() {
  const container = document.getElementById('tabla-detalle-guia-despacho')
  if (!container) return

  if (!S._guiaDespachoLineas || S._guiaDespachoLineas.length === 0) {
    container.innerHTML = '<p style="text-align:center; color:var(--text-secondary); padding:20px;">Esta venta no tiene productos pendientes de despacho.</p>'
    return
  }

  const zonaOptions = (S._guiaDespachoZonasCache || [])
    .map(z => `<option value="${z.id}">${z.almacenNombre} — ${z.nombre}</option>`).join('')

  let html = ''
  S._guiaDespachoLineas.forEach((l, idx) => {
    const totalDespachando = l.despachos.reduce((s, d) => s + (parseFloat(d.cantidad) || 0), 0)
    const colorTotal = Math.abs(totalDespachando - l.cantidad_pendiente) < 0.0001 ? 'var(--color-success)' : 'var(--color-warning)'

    html += `
      <div style="border:1px solid var(--border-color); border-radius:var(--radius-md); margin-bottom:14px; padding:12px;">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
          <strong>${l.sku ? '(' + l.sku + ') ' : ''}${l.nombre}</strong>
          <span style="font-size:0.85rem;">
            Vendido: ${formatQty(l.cantidad_vendida)} ${l.unidad_medida || ''} &nbsp;|&nbsp;
            Ya despachado: ${formatQty(l.cantidad_despachada_previa)} &nbsp;|&nbsp;
            Pendiente: ${formatQty(l.cantidad_pendiente)} &nbsp;|&nbsp;
            Despachando ahora: <strong style="color:${colorTotal};">${formatQty(totalDespachando)}</strong>
          </span>
        </div>
        <div style="overflow-x:auto;">
        <table style="min-width:760px;">
          <thead>
            <tr>
              <th>Cantidad (${l.unidad_medida || 'KG'}) *</th><th>Unidad</th><th>Peso x Unid.</th><th>N° de Unidades</th>
              <th>Almacén / Zona *</th><th>N° de Lote *</th><th></th>
            </tr>
          </thead>
          <tbody>
    `
    l.despachos.forEach((desp, subIdx) => {
      const lotesDeZona = desp.ubicacion_id ? _lotesConStockZona(l.item_id, desp.ubicacion_id) : []
      // El lote ya asignado a ESTA fila (al editar una guía existente) puede
      // no traer stock disponible > 0 en esa zona: su cantidad ya está
      // "reservada" por esta misma guía, así que _lotesConStockZona no lo
      // devuelve. Sin su <option>, `select.value = desp.lote_id` (más abajo)
      // falla en silencio y el desplegable se ve en blanco. Se agrega a mano
      // si falta, para que siempre se pueda preseleccionar correctamente.
      const yaIncluido = lotesDeZona.some(lo => String(lo.lote_id) === String(desp.lote_id))
      if (desp.lote_id && !yaIncluido) {
        const loteAsignado = S._lotesMap[desp.lote_id]
        lotesDeZona.push({
          lote_id: desp.lote_id,
          numero_lote: loteAsignado?.numero_lote || `#${desp.lote_id}`,
          disponible: parseFloat(desp.cantidad) || 0,
          disponibleUnid: 0,
          _reservadoAqui: true
        })
      }
      const loteOptions = lotesDeZona.map(lo =>
        `<option value="${lo.lote_id}">${lo.numero_lote} — ${lo._reservadoAqui ? 'reservado en esta guía' : `disp: ${formatQty(lo.disponible)}${lo.disponibleUnid > 0 ? ' / ' + formatQty(lo.disponibleUnid) + ' und' : ''}`}</option>`
      ).join('')
      const pesoPorUnidad = desp.lote_id ? S._lotesMap[desp.lote_id]?.peso_por_unidad : null
      const soloLectura = desp.esPesoVariable
      html += `
        <tr>
          <td><input type="number" id="gd-${idx}-${subIdx}-cantidad" value="${desp.cantidad}" step="0.01" min="0" style="width:100px;" ${soloLectura ? 'readonly' : ''} onchange="window.onCambiarCantidadDespachoGuia(${idx}, ${subIdx})"></td>
          <td><input type="text" id="gd-${idx}-${subIdx}-unidadmedida" value="${l.unidad_medida || ''}" readonly size="4" style="width:auto; max-width:60px; background:var(--bg-primary); color:var(--text-secondary);"></td>
          <td><input type="text" id="gd-${idx}-${subIdx}-pesounidad" value="${pesoPorUnidad ? formatQty(pesoPorUnidad) : ''}" readonly size="6" style="width:auto; max-width:80px; background:var(--bg-primary); color:var(--text-secondary);"></td>
          <td><input type="number" id="gd-${idx}-${subIdx}-unidades" value="${desp.cantidad_unidades ?? ''}" placeholder="Ej: 10" step="1" min="0" style="width:90px;" ${soloLectura ? 'readonly' : ''}></td>
          <td><select id="gd-${idx}-${subIdx}-zona" style="min-width:160px;" onchange="window.onCambiarZonaDespachoGuia(${idx}, ${subIdx})">
                <option value="">-- Selecciona --</option>${zonaOptions}
              </select></td>
          <td><select id="gd-${idx}-${subIdx}-lote" style="min-width:200px;" ${!desp.ubicacion_id ? 'disabled' : ''} onchange="window.onCambiarLoteDespachoGuia(${idx}, ${subIdx})">
                <option value="">${desp.ubicacion_id ? '-- Selecciona lote (FIFO sugerido primero) --' : '-- Elige zona --'}</option>${loteOptions}
              </select></td>
          <td>${l.despachos.length > 1 ? `<button type="button" class="btn btn-small btn-danger" onclick="window.quitarDespachoGuia(${idx}, ${subIdx})">✕</button>` : ''}</td>
        </tr>
      `
      if (desp.esPesoVariable) {
        const otrosSeleccionados = new Set()
        S._guiaDespachoLineas.forEach((ll, i2) => ll.despachos.forEach((d2, s2) => {
          if (i2 !== idx || s2 !== subIdx) (d2.bultosSeleccionados || []).forEach(id => otrosSeleccionados.add(id))
        }))
        const bultos = desp.bultosDisponibles || []
        const checklist = bultos.length === 0
          ? '<span style="color:var(--text-secondary); font-size:0.85rem;">No hay bultos disponibles de este lote en esa zona.</span>'
          : bultos.map(b => {
              const marcado = (desp.bultosSeleccionados || []).includes(b.id)
              const usadoEnOtraFila = otrosSeleccionados.has(b.id)
              return `
                <label style="display:inline-flex; align-items:center; gap:4px; margin:2px 10px 2px 0; ${usadoEnOtraFila ? 'opacity:0.4;' : ''}">
                  <input type="checkbox" ${marcado ? 'checked' : ''} ${usadoEnOtraFila ? 'disabled' : ''}
                    onchange="window.toggleBultoDespachoGuia(${idx}, ${subIdx}, ${b.id})">
                  ${b.codigo_bulto || ('Bulto #' + b.id)} — ${formatQty(b.peso)} ${l.unidad_medida || ''}${usadoEnOtraFila ? ' (usado en otra línea)' : ''}
                </label>`
            }).join('')
        html += `
          <tr>
            <td colspan="7" style="background:var(--bg-secondary); padding:8px 10px;">
              <div style="font-size:0.8rem; color:var(--text-secondary); margin-bottom:4px;">Peso variable — marca los bultos concretos a despachar:</div>
              ${checklist}
            </td>
          </tr>
        `
      }
    })
    html += `
          </tbody>
        </table>
        </div>
        <button type="button" class="btn btn-small btn-secondary" style="margin-top:6px;" onclick="window.agregarDespachoGuia(${idx})">+ Agregar otro lote/zona para este producto</button>
      </div>
    `
  })

  container.innerHTML = html

  // Preseleccionar valores guardados en el estado + listeners para no perder foco al escribir.
  // Estos selects se recrean enteros en cada render (container.innerHTML =
  // html), así que convertirEnBuscador() se vuelve a llamar cada vez —
  // envuelve el <select> NUEVO, no queda ninguno del render anterior sin
  // wrapper (mismo patrón que Traslado Interno en Inventario: tdProducto/
  // tdLote).
  S._guiaDespachoLineas.forEach((l, idx) => {
    l.despachos.forEach((desp, subIdx) => {
      const cant = document.getElementById(`gd-${idx}-${subIdx}-cantidad`)
      const cantUnid = document.getElementById(`gd-${idx}-${subIdx}-unidades`)
      const zona = document.getElementById(`gd-${idx}-${subIdx}-zona`)
      const lote = document.getElementById(`gd-${idx}-${subIdx}-lote`)
      if (zona && desp.ubicacion_id) zona.value = desp.ubicacion_id
      if (lote && desp.lote_id) lote.value = desp.lote_id

      cant?.addEventListener('input', () => { desp.cantidad = parseFloat(cant.value || 0) })
      cantUnid?.addEventListener('input', () => { desp.cantidad_unidades = cantUnid.value !== '' ? parseFloat(cantUnid.value) : null })

      if (zona) {
        convertirEnBuscador(zona, { placeholder: 'Escribe el almacén o zona...', sinResultados: 'Sin zonas con stock' })
        refrescarBuscador(zona)
      }
      if (lote) {
        convertirEnBuscador(lote, { placeholder: 'Escribe el N° de lote...', sinResultados: 'Sin lotes disponibles' })
        refrescarBuscador(lote)
      }
    })
  })
}

window.guardarGuiaDespachoVenta = async function () {
  const btn = document.getElementById('btnGuardarGuiaDespachoVenta')
  if (btn?.disabled) return
  if (btn) { btn.disabled = true; btn.textContent = 'Guardando...' }
  try {
    const user = await getCurrentUser()
    if (!user) { showToast('Usuario no autenticado', 'danger'); return }

    const ventaId       = parseInt(document.getElementById('gdVenta')?.value || 0)
    const numeroGuia     = document.getElementById('gdNumeroGuia')?.value?.trim()
    const fechaGuia      = document.getElementById('gdFechaGuia')?.value
    const observaciones  = document.getElementById('gdObservaciones')?.value?.trim() || null

    if (!ventaId)     { showToast('Selecciona la venta que estás despachando', 'warning'); return }
    if (!numeroGuia)  { showToast('Ingresa el N° de Guía', 'warning'); return }
    if (!fechaGuia)   { showToast('Ingresa la fecha de la guía', 'warning'); return }
    if (!S._guiaDespachoLineas || S._guiaDespachoLineas.length === 0) { showToast('Esta venta no tiene productos pendientes', 'warning'); return }

    _sincronizarDespachosGuiaDesdeDOM()

    // Validar cantidad + zona + lote en cada despacho, y que no se despache
    // más de lo pendiente por línea, antes de escribir nada. Cuando hay
    // varias líneas del MISMO producto (mismo nombre) el mensaje de error
    // no alcanza para distinguir cuál falta — se agrega "línea N de M" +
    // la cantidad pendiente de esa línea puntual.
    // reservaZona acumula, POR lote+zona, lo que ya se validó en despachos
    // anteriores de este mismo guardado — necesario porque varias líneas
    // (incluso de productos distintos) pueden repartirse del mismo
    // lote+zona, y comparar cada una por separado contra el stock crudo
    // permitiría "reservar" el mismo stock más de una vez.
    const reservaZona = new Map() // filaStockId -> { cantidad, unidades } ya reservado en este guardado
    const despachosValidados = []
    const totalLineas = S._guiaDespachoLineas.length
    for (const [i, l] of S._guiaDespachoLineas.entries()) {
      const etiquetaLinea = totalLineas > 1 ? `"${l.nombre}" (línea ${i + 1} de ${totalLineas}, pendiente ${formatQty(l.cantidad_pendiente)})` : `"${l.nombre}"`
      let totalLinea = 0
      for (const d of l.despachos) {
        if (!d.cantidad || d.cantidad <= 0) continue // fila vacía: se ignora, no bloquea
        if (!d.ubicacion_id) { showToast(`Falta el Almacén/Zona en ${etiquetaLinea}`, 'warning'); return }
        if (!d.lote_id)      { showToast(`Falta el Lote en ${etiquetaLinea}`, 'warning'); return }

        const filaStock = (S._stockUbic || []).find(su => su.lote_id === d.lote_id && su.ubicacion_id === d.ubicacion_id)
        if (!filaStock) {
          showToast(`Stock insuficiente para ${etiquetaLinea} en el lote/zona elegidos (disponible 0).`, 'danger')
          return
        }

        const yaReservado = reservaZona.get(filaStock.id) || { cantidad: 0, unidades: 0 }
        const disponible = parseFloat(filaStock.cantidad || 0) - yaReservado.cantidad
        const disponibleUnid = parseFloat(filaStock.cantidad_unidades || 0) - yaReservado.unidades
        if (d.cantidad > disponible) {
          showToast(`Stock insuficiente para ${etiquetaLinea} en el lote/zona elegidos (disponible ${formatQty(disponible)}).`, 'danger')
          return
        }
        if ((d.cantidad_unidades || 0) > 0 && d.cantidad_unidades > disponibleUnid) {
          showToast(`Unidades insuficientes para ${etiquetaLinea} en el lote/zona elegidos (disponible ${formatQty(disponibleUnid)} und).`, 'danger')
          return
        }
        // Peso variable: la cantidad SIEMPRE debe venir de bultos marcados
        // (toggleBultoDespachoGuia ya la deriva ahí) — si por algún motivo
        // llegó en 0 bultos pero con cantidad > 0 (desincronización de
        // estado), se bloquea en vez de vender "cantidad sin bultos".
        if (d.esPesoVariable && (!d.bultosSeleccionados || d.bultosSeleccionados.length === 0)) {
          showToast(`Marca al menos un bulto para ${etiquetaLinea} (lote de peso variable)`, 'warning')
          return
        }

        reservaZona.set(filaStock.id, { cantidad: yaReservado.cantidad + d.cantidad, unidades: yaReservado.unidades + (d.cantidad_unidades || 0) })

        totalLinea += d.cantidad
        despachosValidados.push({
          detalle_venta_id: l.detalle_venta_id,
          item_id: l.item_id,
          cantidad: d.cantidad,
          cantidad_unidades: d.cantidad_unidades || 0,
          ubicacion_id: d.ubicacion_id,
          lote_id: d.lote_id,
          filaStockId: filaStock.id,
          bultosSeleccionados: d.esPesoVariable ? [...(d.bultosSeleccionados || [])] : null
        })
      }
      if (totalLinea - l.cantidad_pendiente > 0.0001) {
        showToast(`${etiquetaLinea}: estás despachando ${formatQty(totalLinea)} pero solo hay ${formatQty(l.cantidad_pendiente)} pendiente.`, 'danger')
        return
      }
    }

    if (despachosValidados.length === 0) { showToast('No hay cantidades a despachar', 'warning'); return }
    if (!_confirmarDestinoRealGuia()) return

    const venta = await getVentaById(ventaId)

    const guia = await addGuiaDespachoVenta({
      venta_id:      ventaId,
      numero_guia:   numeroGuia,
      fecha_guia:    fechaGuia,
      observaciones,
      created_by:    user.db_id
    })

    if (!guia?.id) { showToast('No se pudo registrar la guía de despacho', 'danger'); return }
    await registrarUsoGuia(numeroGuia)

    // Destino de la salida en el Kardex: lo define la serie de la guía
    // (T001 → Partners/Customers, GN01 → Partners/90). Fallback Customers.
    const customersZona = await getUbicacionCustomers()
    const destinoKardexId = await _destinoElegidoGuia(numeroGuia, customersZona)
    const destinoReal = _gdDestinosReales.has(String(destinoKardexId))

    // Copia local de las filas de stock_ubicaciones tocadas, para decrementar
    // ACUMULATIVAMENTE cuando varios despachos comparten el mismo
    // filaStockId (mismo lote+zona) — si se leyera cada vez de _stockUbic
    // (caché sin refrescar durante el loop) se pisaría el descuento anterior
    // en vez de sumarlo.
    const stockLocalPorFila = new Map()
    for (const su of (S._stockUbic || [])) stockLocalPorFila.set(su.id, { ...su })

    for (const d of despachosValidados) {
      const lote = await getLoteById(d.lote_id)
      const esPesoVariable = d.bultosSeleccionados && d.bultosSeleccionados.length > 0

      // Peso variable: NO se resta a mano — el lote se recalcula desde sus
      // bultos DESPUÉS de marcarlos 'vendido' (más abajo, una vez que existe
      // el id de detalle_guias_despacho_venta que necesitan). Estos valores
      // son provisionales solo para no dejar variables sin definir; el
      // Kardex usa los definitivos, calculados después del recálculo.
      let nuevaCantidadLote, nuevaUnidadesLote
      if (esPesoVariable) {
        nuevaCantidadLote = parseFloat(lote?.cantidad || 0)
        nuevaUnidadesLote = parseFloat(lote?.cantidad_unidades || 0)
      } else {
        nuevaCantidadLote = parseFloat(((parseFloat(lote?.cantidad) || 0) - d.cantidad).toFixed(4))
        nuevaUnidadesLote = Math.max(0, parseFloat(((parseFloat(lote?.cantidad_unidades) || 0) - (d.cantidad_unidades || 0)).toFixed(4)))
        await updateLote(d.lote_id, { cantidad: nuevaCantidadLote, cantidad_unidades: nuevaUnidadesLote })
      }

      const filaStock = stockLocalPorFila.get(d.filaStockId)
      const nuevaCantidadZona = parseFloat(((parseFloat(filaStock?.cantidad) || 0) - d.cantidad).toFixed(4))
      const nuevaUnidadesZona = Math.max(0, parseFloat(((parseFloat(filaStock?.cantidad_unidades) || 0) - (d.cantidad_unidades || 0)).toFixed(4)))
      if (filaStock) { filaStock.cantidad = nuevaCantidadZona; filaStock.cantidad_unidades = nuevaUnidadesZona } // acumular para el próximo despacho de esta misma fila
      if (nuevaCantidadZona <= 0) {
        await deleteStockUbicacion(d.filaStockId)
        stockLocalPorFila.delete(d.filaStockId)
      } else {
        await updateStockUbicacion(d.filaStockId, { cantidad: nuevaCantidadZona, cantidad_unidades: nuevaUnidadesZona })
      }

      // El detalle de guía de despacho se inserta ANTES del Kardex: si el
      // lote es de peso variable, marcar los bultos vendidos necesita el id
      // de esta fila (detalle_guia_despacho_id), y el recálculo del lote que
      // sigue debe terminar antes de armar el saldo del Kardex.
      const detalleGuia = await addDetalleGuiaDespachoVenta({
        guia_id:            guia.id,
        detalle_venta_id:   d.detalle_venta_id,
        item_id:            d.item_id,
        cantidad:           d.cantidad,
        cantidad_unidades:  d.cantidad_unidades || 0,
        numero_lote:        lote?.numero_lote || '',
        lote_id:            d.lote_id,
        ubicacion_id:       d.ubicacion_id
      })

      if (esPesoVariable) {
        for (const bultoId of d.bultosSeleccionados) {
          // Destino zona real → 'custodiado' y el bulto pasa físicamente a esa zona.
          await updateLoteBulto(bultoId, {
            estado: destinoReal ? 'custodiado' : 'vendido',
            ...(destinoReal ? { ubicacion_id: destinoKardexId } : {}),
            detalle_venta_id: d.detalle_venta_id,
            detalle_guia_despacho_id: detalleGuia?.id || null
          })
        }
        const recalc = await recalcularLoteDesdeBultos(d.lote_id)
        nuevaCantidadLote = recalc.cantidad
        nuevaUnidadesLote = recalc.cantidad_unidades
      }

      // Kardex: salida de la zona real hacia Partners/Customers (externo).
      // costo_unitario viene del lote (costeo por identificación específica).
      // saldo_* usa nuevaCantidadLote/nuevaUnidadesLote YA definitivos
      // (recalculados desde bultos arriba si aplica).
      const costoUnitLote = parseFloat(lote?.costo_unitario || 0)
      await addKardexMovimiento({
        item_id:              d.item_id,
        lote_id:               d.lote_id,
        ubicacion_origen_id:   d.ubicacion_id,
        ubicacion_destino_id:  destinoKardexId,
        fecha:                 fechaGuia,
        tipo_movimiento:       'salida',
        concepto:              'Venta - salida de almacén (guía de despacho)' + (destinoReal ? ' → zona real' : ''),
        documento_referencia:  numeroGuia,
        // Destino = zona REAL (no virtual): la mercadería entra a esa zona en
        // la MISMA fila (como un traslado) para que stock_ubicaciones la sume.
        cantidad_entrada:      destinoReal ? d.cantidad : 0,
        cantidad_salida:       d.cantidad,
        cantidad_unidades_entrada: destinoReal ? (d.cantidad_unidades || 0) : 0,
        cantidad_unidades_salida:  d.cantidad_unidades || 0,
        costo_unitario:        costoUnitLote,
        valor_entrada:         destinoReal ? parseFloat((d.cantidad * costoUnitLote).toFixed(2)) : 0,
        valor_salida:          parseFloat((d.cantidad * costoUnitLote).toFixed(2)),
        moneda:                lote?.moneda || 'PEN',
        tipo_cambio:            parseFloat(lote?.tipo_cambio) || 1,
        costo_unit_original:    parseFloat(lote?.costo_unit_original ?? costoUnitLote),
        saldo_cantidad:        (destinoReal && !esPesoVariable) ? nuevaCantidadLote + d.cantidad : nuevaCantidadLote,
        saldo_valor:           parseFloat((((destinoReal && !esPesoVariable) ? nuevaCantidadLote + d.cantidad : nuevaCantidadLote) * costoUnitLote).toFixed(2)),
        saldo_unidades:        (destinoReal && !esPesoVariable) ? nuevaUnidadesLote + (d.cantidad_unidades || 0) : nuevaUnidadesLote,
        venta_id:              ventaId,
        created_by:            user.db_id
      })

      // Trazabilidad rápida en detalle_ventas (referencial): si la línea se
      // despachó de un solo lote, queda ese lote/zona; si se repartió entre
      // varios, queda el ÚLTIMO — para el detalle exacto por lote, la fuente
      // real es detalle_guias_despacho_venta.
      await updateDetalleVenta(d.detalle_venta_id, {
        lote_id: d.lote_id,
        ubicacion_id: d.ubicacion_id,
        costo_unitario: costoUnitLote
      })
    }

    // Recalcular estado_despacho de la venta: comparar total despachado
    // (incluye esta guía recién guardada) contra el total vendido.
    await _recalcularEstadoDespachoVenta(ventaId)

    showToast('Guía de despacho registrada: stock actualizado en Inventario', 'success')
    window.cerrarModalNuevaGuiaDespacho()
    S._guiaDespachoLineas = []

    // Refrescar cachés locales de stock/lotes (se acaban de consumir).
    const [lotesFrescos, stockFresco] = await Promise.all([getLotes(), getStockUbicaciones()])
    S._lotes = lotesFrescos
    S._stockUbic = stockFresco
    S._lotesMap = {}
    for (const lo of (S._lotes || [])) S._lotesMap[lo.id] = lo

    await renderGuiasDespachoVenta(true)
    await renderVentas(true)
  } catch (error) {
    console.error('Error en guardarGuiaDespachoVenta:', error)
    showToast('Error: ' + error.message, 'danger')
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Guardar Guía (descuenta stock)' }
  }
}

/**
 * Guarda la edición de una guía YA emitida (abierta con editarGuiaDespachoVenta):
 * valida los despachos nuevos igual que al crear, y solo si todo cuadra
 * revierte el stock/kardex que la guía había movido y lo vuelve a aplicar con
 * los valores nuevos — sobre la MISMA fila de guías_despacho_venta (mismo N°
 * de guía, mismo id), sin pasar por eliminar+recrear.
 */
window.guardarEdicionGuiaDespachoVenta = async function () {
  const btn = document.getElementById('btnGuardarGuiaDespachoVenta')
  if (btn?.disabled) return
  const guiaId = S._guiaDespachoEditId
  if (!guiaId) { showToast('No hay guía en edición', 'danger'); return }
  if (btn) { btn.disabled = true; btn.textContent = 'Guardando...' }
  try {
    const user = await getCurrentUser()
    if (!user) { showToast('Usuario no autenticado', 'danger'); return }

    const ventaId       = parseInt(document.getElementById('gdVenta')?.value || 0)
    const numeroGuia     = document.getElementById('gdNumeroGuia')?.value?.trim()
    const fechaGuia      = document.getElementById('gdFechaGuia')?.value
    const observaciones  = document.getElementById('gdObservaciones')?.value?.trim() || null

    if (!ventaId)    { showToast('Venta inválida', 'danger'); return }
    if (!numeroGuia) { showToast('Ingresa el N° de Guía', 'warning'); return }
    if (!fechaGuia)  { showToast('Ingresa la fecha de la guía', 'warning'); return }
    if (!S._guiaDespachoLineas || S._guiaDespachoLineas.length === 0) { showToast('No hay productos en esta guía', 'warning'); return }

    const guiaOriginal = await getGuiaDespachoVentaById(guiaId)
    if (!guiaOriginal) { showToast('La guía ya no existe', 'danger'); return }
    if (numeroGuia !== guiaOriginal.numero_guia) {
      const existe = (await getGuiasDespachoVenta(true) || []).some(g => g.id !== guiaId && g.numero_guia === numeroGuia && _guiaEstaVigente(g))
      if (existe) { showToast(`Ya existe la guía ${numeroGuia}`, 'danger'); return }
    }

    _sincronizarDespachosGuiaDesdeDOM()

    // Misma validación que guardarGuiaDespachoVenta: cantidad/zona/lote por
    // línea, sin pasarse de lo pendiente — que ya excluye la reserva vieja de
    // esta misma guía (ver editarGuiaDespachoVenta), así que reusar el mismo
    // lote/zona con la misma cantidad de antes siempre pasa esta validación.
    const reservaZona = new Map()
    const despachosValidados = []
    const totalLineas = S._guiaDespachoLineas.length
    for (const [i, l] of S._guiaDespachoLineas.entries()) {
      const etiquetaLinea = totalLineas > 1 ? `"${l.nombre}" (línea ${i + 1} de ${totalLineas}, pendiente ${formatQty(l.cantidad_pendiente)})` : `"${l.nombre}"`
      let totalLinea = 0
      for (const d of l.despachos) {
        if (!d.cantidad || d.cantidad <= 0) continue
        if (!d.ubicacion_id) { showToast(`Falta el Almacén/Zona en ${etiquetaLinea}`, 'warning'); return }
        if (!d.lote_id)      { showToast(`Falta el Lote en ${etiquetaLinea}`, 'warning'); return }

        const filaStock = (S._stockUbic || []).find(su => su.lote_id === d.lote_id && su.ubicacion_id === d.ubicacion_id)
        if (!filaStock) {
          showToast(`Stock insuficiente para ${etiquetaLinea} en el lote/zona elegidos (disponible 0).`, 'danger')
          return
        }
        const yaReservado = reservaZona.get(filaStock.id) || { cantidad: 0, unidades: 0 }
        const disponible = parseFloat(filaStock.cantidad || 0) - yaReservado.cantidad
        const disponibleUnid = parseFloat(filaStock.cantidad_unidades || 0) - yaReservado.unidades
        if (d.cantidad > disponible) {
          showToast(`Stock insuficiente para ${etiquetaLinea} en el lote/zona elegidos (disponible ${formatQty(disponible)}).`, 'danger')
          return
        }
        if ((d.cantidad_unidades || 0) > 0 && d.cantidad_unidades > disponibleUnid) {
          showToast(`Unidades insuficientes para ${etiquetaLinea} en el lote/zona elegidos (disponible ${formatQty(disponibleUnid)} und).`, 'danger')
          return
        }
        if (d.esPesoVariable) {
          showToast(`"${l.nombre}" quedó en un lote de peso variable: este editor no soporta bultos. Elimina la guía y créala de nuevo.`, 'danger')
          return
        }

        reservaZona.set(filaStock.id, { cantidad: yaReservado.cantidad + d.cantidad, unidades: yaReservado.unidades + (d.cantidad_unidades || 0) })
        totalLinea += d.cantidad
        despachosValidados.push({
          detalle_venta_id: l.detalle_venta_id, item_id: l.item_id,
          cantidad: d.cantidad, cantidad_unidades: d.cantidad_unidades || 0,
          ubicacion_id: d.ubicacion_id, lote_id: d.lote_id, filaStockId: filaStock.id
        })
      }
      if (totalLinea - l.cantidad_pendiente > 0.0001) {
        showToast(`${etiquetaLinea}: estás despachando ${formatQty(totalLinea)} pero solo hay ${formatQty(l.cantidad_pendiente)} pendiente.`, 'danger')
        return
      }
    }

    if (despachosValidados.length === 0) { showToast('No hay cantidades a despachar', 'warning'); return }
    if (!_confirmarDestinoRealGuia()) return

    if (!confirm(
      `Se revertirá el stock/kardex que la guía ${guiaOriginal.numero_guia} había movido y se volverá a aplicar con los valores nuevos.\n\n¿Confirmar?`
    )) { if (btn) { btn.disabled = false; btn.textContent = 'Guardar cambios (recalcula stock)' }; return }

    // ── 1) Revertir TODO lo que esta guía había movido (sin borrar la guía) ──
    await _revertirStockGuiaDespacho(guiaId)
    const detallesViejos = await getDetalleGuiasDespachoVenta(guiaId)
    for (const dv of (detallesViejos || [])) await deleteDetalleGuiaDespachoVenta(dv.id)

    // ── 2) Cabecera de la guía (mismo id, mismo N° salvo que se haya editado) ─
    await updateGuiaDespachoVenta(guiaId, { numero_guia: numeroGuia, fecha_guia: fechaGuia, observaciones })

    // ── 3) Aplicar los despachos nuevos sobre la MISMA guía — idéntico al
    //       loop de guardarGuiaDespachoVenta, salvo que no vuelve a crear la
    //       fila de guías_despacho_venta (ya existe, recién actualizada). ──
    await _refrescarStockLoteEnVivo()
    const customersZona = await getUbicacionCustomers()
    const destinoKardexId = await _destinoElegidoGuia(numeroGuia, customersZona)
    const destinoReal = _gdDestinosReales.has(String(destinoKardexId))
    await registrarUsoGuia(numeroGuia)
    const stockLocalPorFila = new Map()
    for (const su of (S._stockUbic || [])) stockLocalPorFila.set(su.id, { ...su })

    for (const d of despachosValidados) {
      const lote = await getLoteById(d.lote_id)
      const nuevaCantidadLote = parseFloat(((parseFloat(lote?.cantidad) || 0) - d.cantidad).toFixed(4))
      const nuevaUnidadesLote = Math.max(0, parseFloat(((parseFloat(lote?.cantidad_unidades) || 0) - (d.cantidad_unidades || 0)).toFixed(4)))
      await updateLote(d.lote_id, { cantidad: nuevaCantidadLote, cantidad_unidades: nuevaUnidadesLote })

      const filaStock = stockLocalPorFila.get(d.filaStockId)
      const nuevaCantidadZona = parseFloat(((parseFloat(filaStock?.cantidad) || 0) - d.cantidad).toFixed(4))
      const nuevaUnidadesZona = Math.max(0, parseFloat(((parseFloat(filaStock?.cantidad_unidades) || 0) - (d.cantidad_unidades || 0)).toFixed(4)))
      if (filaStock) { filaStock.cantidad = nuevaCantidadZona; filaStock.cantidad_unidades = nuevaUnidadesZona }
      if (nuevaCantidadZona <= 0) {
        await deleteStockUbicacion(d.filaStockId)
        stockLocalPorFila.delete(d.filaStockId)
      } else {
        await updateStockUbicacion(d.filaStockId, { cantidad: nuevaCantidadZona, cantidad_unidades: nuevaUnidadesZona })
      }

      await addDetalleGuiaDespachoVenta({
        guia_id:            guiaId,
        detalle_venta_id:   d.detalle_venta_id,
        item_id:            d.item_id,
        cantidad:           d.cantidad,
        cantidad_unidades:  d.cantidad_unidades || 0,
        numero_lote:        lote?.numero_lote || '',
        lote_id:            d.lote_id,
        ubicacion_id:       d.ubicacion_id
      })

      const costoUnitLote = parseFloat(lote?.costo_unitario || 0)
      await addKardexMovimiento({
        item_id:              d.item_id,
        lote_id:               d.lote_id,
        ubicacion_origen_id:   d.ubicacion_id,
        ubicacion_destino_id:  destinoKardexId,
        fecha:                 fechaGuia,
        tipo_movimiento:       'salida',
        concepto:              'Venta - salida de almacén (guía de despacho, editada)' + (destinoReal ? ' → zona real' : ''),
        documento_referencia:  numeroGuia,
        // Destino = zona REAL (no virtual): la mercadería entra a esa zona en
        // la MISMA fila (como un traslado) para que stock_ubicaciones la sume.
        cantidad_entrada:      destinoReal ? d.cantidad : 0,
        cantidad_salida:       d.cantidad,
        cantidad_unidades_entrada: destinoReal ? (d.cantidad_unidades || 0) : 0,
        cantidad_unidades_salida:  d.cantidad_unidades || 0,
        costo_unitario:        costoUnitLote,
        valor_entrada:         destinoReal ? parseFloat((d.cantidad * costoUnitLote).toFixed(2)) : 0,
        valor_salida:          parseFloat((d.cantidad * costoUnitLote).toFixed(2)),
        moneda:                lote?.moneda || 'PEN',
        tipo_cambio:            parseFloat(lote?.tipo_cambio) || 1,
        costo_unit_original:    parseFloat(lote?.costo_unit_original ?? costoUnitLote),
        saldo_cantidad:        destinoReal ? nuevaCantidadLote + d.cantidad : nuevaCantidadLote,
        saldo_valor:           parseFloat(((destinoReal ? nuevaCantidadLote + d.cantidad : nuevaCantidadLote) * costoUnitLote).toFixed(2)),
        saldo_unidades:        destinoReal ? nuevaUnidadesLote + (d.cantidad_unidades || 0) : nuevaUnidadesLote,
        venta_id:              ventaId,
        created_by:            user.db_id
      })

      await updateDetalleVenta(d.detalle_venta_id, {
        lote_id: d.lote_id,
        ubicacion_id: d.ubicacion_id,
        costo_unitario: costoUnitLote
      })
    }

    await _recalcularEstadoDespachoVenta(ventaId)

    showToast(`Guía ${numeroGuia} actualizada: stock recalculado ✅`, 'success')
    window.cerrarModalNuevaGuiaDespacho()
    S._guiaDespachoLineas = []

    const [lotesFrescos, stockFresco] = await Promise.all([getLotes(), getStockUbicaciones()])
    S._lotes = lotesFrescos
    S._stockUbic = stockFresco
    S._lotesMap = {}
    for (const lo of (S._lotes || [])) S._lotesMap[lo.id] = lo

    _invalidarCacheVentas()
    await renderGuiasDespachoVenta(true)
    await renderVentas(true)
  } catch (error) {
    console.error('Error en guardarEdicionGuiaDespachoVenta:', error)
    showToast('Error al guardar la edición de la guía: ' + error.message, 'danger')
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Guardar cambios (recalcula stock)' }
  }
}
