// ============================================================================
// inventario/historial-movimientos.js — parte de inventario.js (reorganizado 2026-09-25, sin cambios de lógica)
// Mapa completo de funciones: Claude outputs/glosario_funciones_erp.md
// ============================================================================
import { S } from './state.js'
import { getCurrentUser } from '../auth-supabase.js'
import { colStyle, colMenuHtml } from '../col-menu.js'
import { getItems, getLotes, getLoteById, getAlmacenes, getUbicaciones, getStockUbicaciones, addStockUbicacion, updateStockUbicacion, deleteStockUbicacion, updateLoteBulto, getKardex, addKardexMovimiento, obtenerSiguienteNumeroSecuencia } from '../supabase-data.js'
import { showToast, formatQty } from '../helpers.js'
import { _aplicarOrdenFilas } from './resumen-stock.js'

// ============================================================================
// HISTORIAL DE MOVIMIENTOS — vista global estilo Odoo (Inventario > Operaciones):
// 1 fila por producto+lote, para TODOS los tipos de movimiento (compras,
// ventas, traslados, devoluciones, ajustes), no solo traslados. No es una
// tabla nueva: kardex ya guarda cada movimiento con origen/destino (mismo
// modelo que stock.move de Odoo) — esto es solo un reporte sobre esa data.
//
// Nota: NO se muestra columna "Usuario/Contacto" — public.users tiene RLS
// que solo permite SELECT a admins, así que un usuario normal no podría
// resolver created_by -> nombre para las filas de otros usuarios.
// ============================================================================

const TIPOS_MOVIMIENTO_HISTORIAL = {
  entrada:            'Entrada (compra)',
  salida:             'Salida (venta)',
  ajuste_entrada:     'Ajuste — entrada',
  ajuste_salida:      'Ajuste — salida',
  devolucion_venta:   'Devolución de venta',
  devolucion_compra:  'Devolución de compra',
  traslado_salida:    'Traslado — salida',
  traslado_entrada:   'Traslado — entrada',
  traslado_interno:   'Traslado interno'
}

window._historialMovOrden = { col: 'fecha', dir: 'desc' }
let _historialMovFilasCache = []

export async function renderHistorialMovimientos() {
  try {
    const container = document.getElementById('content-historial')
    if (!container) return
    container.innerHTML = '<p style="text-align:center; color:var(--text-secondary); padding:20px;">Cargando...</p>'

    const [kardex, items, lotes, zonas, almacenes] = await Promise.all([
      getKardex(), getItems(true), getLotes(), getUbicaciones(), getAlmacenes()
    ])

    const itemsById = new Map((items || []).map(i => [i.id, i]))
    const lotesById = new Map((lotes || []).map(l => [l.id, l]))
    const zonasById = new Map((zonas || []).map(z => [z.id, z]))
    const almacenesById = new Map((almacenes || []).map(a => [a.id, a]))

    const zonaLabel = (zonaId) => {
      const z = zonasById.get(zonaId)
      if (!z) return '—'
      const alm = almacenesById.get(z.almacen_id)
      return `${alm?.nombre || '?'} — ${z.nombre}`
    }

    _historialMovFilasCache = (kardex || []).map(k => ({
      raw: k,
      fecha: k.fecha,
      documento: k.numero_documento || '—',
      docReferencia: k.documento_referencia || '—',
      producto: itemsById.get(k.item_id)?.nombre || itemsById.get(k.item_id)?.name || '(producto eliminado)',
      lote: lotesById.get(k.lote_id)?.numero_lote || '—',
      tipo: k.tipo_movimiento,
      tipoLabel: TIPOS_MOVIMIENTO_HISTORIAL[k.tipo_movimiento] || k.tipo_movimiento,
      desde: zonaLabel(k.ubicacion_origen_id),
      a: zonaLabel(k.ubicacion_destino_id),
      cantidadEntrada: parseFloat(k.cantidad_entrada) || 0,
      cantidadSalida: parseFloat(k.cantidad_salida) || 0,
      unidadEntrada: parseFloat(k.cantidad_unidades_entrada) || 0,
      unidadSalida: parseFloat(k.cantidad_unidades_salida) || 0
    }))

    const opcionesZonaHtml = (zonas || [])
      .slice()
      .sort((a, b) => (almacenesById.get(a.almacen_id)?.nombre || '').localeCompare(almacenesById.get(b.almacen_id)?.nombre || '') || (a.nombre || '').localeCompare(b.nombre || ''))
      .map(z => `<option value="${z.id}">${zonaLabel(z.id)}</option>`)
      .join('')

    const opcionesTipoHtml = Object.entries(TIPOS_MOVIMIENTO_HISTORIAL)
      .map(([value, label]) => `<option value="${value}">${label}</option>`)
      .join('')

    const hoy = new Date()
    const hace30 = new Date(hoy.getTime() - 30 * 24 * 60 * 60 * 1000)
    const toInputDate = (d) => d.toISOString().slice(0, 10)

    container.innerHTML = `
      ${colMenuHtml('historial-movimientos', 'historialColMenu', 'historialColMenuDropdown')}
      <div class="card-header" style="flex-direction:column; align-items:stretch; gap:10px;">
        <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:10px; padding-right:34px;">
          <h3 class="card-title">Historial de Movimientos</h3>
        </div>
        <div class="kardex-filtros-grid">
          <div class="kardex-filtros-fila">
            <input type="text" id="historialBuscarProducto" placeholder="Buscar producto o lote..." oninput="window.aplicarFiltrosHistorial()">
            <select id="historialFiltroTipo" onchange="window.aplicarFiltrosHistorial()">
              <option value="">Tipo: todos</option>${opcionesTipoHtml}
            </select>
            <select id="historialFiltroDesde" onchange="window.aplicarFiltrosHistorial()">
              <option value="">Desde: todas</option>${opcionesZonaHtml}
            </select>
          </div>
          <div class="kardex-filtros-fila">
            <select id="historialFiltroA" onchange="window.aplicarFiltrosHistorial()">
              <option value="">A: todas</option>${opcionesZonaHtml}
            </select>
            <input type="date" id="historialFechaDesde" value="${toInputDate(hace30)}" onchange="window.aplicarFiltrosHistorial()">
            <input type="date" id="historialFechaHasta" value="${toInputDate(hoy)}" onchange="window.aplicarFiltrosHistorial()">
          </div>
        </div>
      </div>
      <div id="historial-body"></div>
    `

    window.aplicarFiltrosHistorial()
  } catch (e) {
    console.error('renderHistorialMovimientos:', e)
    showToast('Error al cargar el historial de movimientos', 'danger')
  }
}

window.aplicarFiltrosHistorial = function () {
  const q = (document.getElementById('historialBuscarProducto')?.value || '').trim().toLowerCase()
  const tipo = document.getElementById('historialFiltroTipo')?.value || ''
  const desdeId = parseInt(document.getElementById('historialFiltroDesde')?.value || 0)
  const aId = parseInt(document.getElementById('historialFiltroA')?.value || 0)
  const fDesde = document.getElementById('historialFechaDesde')?.value || ''
  const fHasta = document.getElementById('historialFechaHasta')?.value || ''

  let filas = _historialMovFilasCache.filter(f => {
    if (q && !f.producto.toLowerCase().includes(q) && !f.lote.toLowerCase().includes(q)) return false
    if (tipo && f.tipo !== tipo) return false
    if (desdeId && f.raw.ubicacion_origen_id !== desdeId) return false
    if (aId && f.raw.ubicacion_destino_id !== aId) return false
    if (fDesde && f.fecha < fDesde) return false
    if (fHasta && f.fecha > fHasta) return false
    return true
  })

  _aplicarOrdenFilas(filas, window._historialMovOrden, {
    fecha:     f => f.fecha || '',
    documento: f => f.documento,
    docReferencia: f => f.docReferencia,
    producto:  f => f.producto,
    lote:      f => f.lote,
    tipo:      f => f.tipoLabel,
    desde:     f => f.desde,
    a:         f => f.a,
    cantidad:  f => f.cantidadEntrada - f.cantidadSalida,
    unidades:  f => f.unidadEntrada - f.unidadSalida
  })

  _pintarTablaHistorial(filas)
}

window.ordenarHistorialMovimientos = function (col) {
  const st = window._historialMovOrden
  if (st.col === col) { st.dir = st.dir === 'asc' ? 'desc' : 'asc' } else { st.col = col; st.dir = 'asc' }
  window.aplicarFiltrosHistorial()
}

function _flechaOrdenHistorial(col) {
  const st = window._historialMovOrden
  if (st.col !== col) return ''
  return st.dir === 'asc' ? ' <span class="orden-flecha">▲</span>' : ' <span class="orden-flecha">▼</span>'
}

function _thOrdenHistorial(col, label, alinear) {
  const style = `${colStyle('historial-movimientos', col)}${alinear ? ` style="text-align:${alinear};"` : ''}`
  return `<th data-col-tabla="historial-movimientos" data-col="${col}" class="th-ordenable"${style} onclick="window.ordenarHistorialMovimientos('${col}')">${label}${_flechaOrdenHistorial(col)}</th>`
}

function _pintarTablaHistorial(filas) {
  const body = document.getElementById('historial-body')
  if (!body) return

  if (filas.length === 0) {
    body.innerHTML = '<p style="text-align:center; color:var(--text-secondary); padding:20px;">No hay movimientos con estos filtros.</p>'
    return
  }

  body.innerHTML = `
    <div class="table-container">
      <table class="tabla-datos" style="font-size:0.9rem;">
        <thead>
          <tr>
            ${_thOrdenHistorial('fecha', 'Fecha')}
            ${_thOrdenHistorial('documento', 'N° Documento')}
            ${_thOrdenHistorial('docReferencia', 'Doc. Referencia')}
            ${_thOrdenHistorial('producto', 'Producto')}
            ${_thOrdenHistorial('lote', 'Lote')}
            ${_thOrdenHistorial('tipo', 'Tipo')}
            ${_thOrdenHistorial('desde', 'Desde')}
            ${_thOrdenHistorial('a', 'A')}
            ${_thOrdenHistorial('cantidad', 'Cantidad', 'right')}
            ${_thOrdenHistorial('unidades', 'Unidades', 'right')}
          </tr>
        </thead>
        <tbody>
          ${filas.map(f => {
            const esTraslado = f.tipo === 'traslado_interno'
            let cantidadTxt, color
            if (esTraslado) {
              cantidadTxt = formatQty(f.cantidadEntrada)
              color = 'var(--text-secondary)'
            } else if (f.cantidadEntrada > 0) {
              cantidadTxt = '+' + formatQty(f.cantidadEntrada)
              color = 'var(--color-success)'
            } else {
              cantidadTxt = '-' + formatQty(f.cantidadSalida)
              color = 'var(--color-danger)'
            }
            let unidadesTxt, colorUnid
            if (esTraslado) {
              unidadesTxt = formatQty(f.unidadEntrada)
              colorUnid = 'var(--text-secondary)'
            } else if (f.cantidadEntrada > 0) {
              unidadesTxt = '+' + formatQty(f.unidadEntrada)
              colorUnid = 'var(--color-success)'
            } else {
              unidadesTxt = '-' + formatQty(f.unidadSalida)
              colorUnid = 'var(--color-danger)'
            }
            return `
              <tr>
                <td data-col-tabla="historial-movimientos" data-col="fecha"${colStyle('historial-movimientos', 'fecha')}>${f.fecha ? new Date(f.fecha + 'T00:00:00').toLocaleDateString('es-PE') : '-'}</td>
                <td data-col-tabla="historial-movimientos" data-col="documento"${colStyle('historial-movimientos', 'documento')}>${f.documento}</td>
                <td data-col-tabla="historial-movimientos" data-col="docReferencia"${colStyle('historial-movimientos', 'docReferencia')}>${f.docReferencia}</td>
                <td data-col-tabla="historial-movimientos" data-col="producto"${colStyle('historial-movimientos', 'producto')}>${f.producto}</td>
                <td data-col-tabla="historial-movimientos" data-col="lote"${colStyle('historial-movimientos', 'lote')}>${f.lote}</td>
                <td data-col-tabla="historial-movimientos" data-col="tipo"${colStyle('historial-movimientos', 'tipo')}>${f.tipoLabel}</td>
                <td data-col-tabla="historial-movimientos" data-col="desde"${colStyle('historial-movimientos', 'desde')}>${f.desde}</td>
                <td data-col-tabla="historial-movimientos" data-col="a"${colStyle('historial-movimientos', 'a')}>${f.a}</td>
                <td data-col-tabla="historial-movimientos" data-col="cantidad"${colStyle('historial-movimientos', 'cantidad')} style="text-align:right; color:${color}; font-weight:600;">${cantidadTxt}</td>
                <td data-col-tabla="historial-movimientos" data-col="unidades"${colStyle('historial-movimientos', 'unidades')} style="text-align:right; color:${colorUnid}; font-weight:600;">${unidadesTxt}</td>
              </tr>`
          }).join('')}
        </tbody>
        <tfoot>
          ${_filaTotalesHistorial(filas)}
        </tfoot>
      </table>
    </div>`
}

// Fila de totales al pie de la tabla — se recalcula en cada render de
// _pintarTablaHistorial(), es decir cada vez que cambia un filtro o el
// orden: siempre refleja SOLO las filas visibles con esos filtros, no el
// total general. Traslados no suman/restan al neto (no cambian el stock
// total, solo su ubicación) — se muestran aparte, informativos.
function _filaTotalesHistorial(filas) {
  let entradas = 0, salidas = 0, traslados = 0
  let unidEntradas = 0, unidSalidas = 0, unidTraslados = 0
  for (const f of filas) {
    if (f.tipo === 'traslado_interno') {
      traslados += f.cantidadEntrada
      unidTraslados += f.unidadEntrada
    } else if (f.cantidadEntrada > 0) {
      entradas += f.cantidadEntrada
      unidEntradas += f.unidadEntrada
    } else {
      salidas += f.cantidadSalida
      unidSalidas += f.unidadSalida
    }
  }
  const neto = entradas - salidas
  const colorNeto = neto > 0 ? 'var(--color-success)' : (neto < 0 ? 'var(--color-danger)' : 'var(--text-secondary)')
  const signoNeto = neto > 0 ? '+' : ''

  const netoUnid = unidEntradas - unidSalidas
  const colorNetoUnid = netoUnid > 0 ? 'var(--color-success)' : (netoUnid < 0 ? 'var(--color-danger)' : 'var(--text-secondary)')
  const signoNetoUnid = netoUnid > 0 ? '+' : ''

  return `
    <tr style="font-weight:600; border-top:2px solid var(--border-color);">
      <td data-col-tabla="historial-movimientos" data-col="fecha"${colStyle('historial-movimientos', 'fecha')}>Total — ${filas.length} mov.</td>
      <td data-col-tabla="historial-movimientos" data-col="documento"${colStyle('historial-movimientos', 'documento')}></td>
      <td data-col-tabla="historial-movimientos" data-col="docReferencia"${colStyle('historial-movimientos', 'docReferencia')}></td>
      <td data-col-tabla="historial-movimientos" data-col="producto"${colStyle('historial-movimientos', 'producto')}></td>
      <td data-col-tabla="historial-movimientos" data-col="lote"${colStyle('historial-movimientos', 'lote')}></td>
      <td data-col-tabla="historial-movimientos" data-col="tipo"${colStyle('historial-movimientos', 'tipo')}></td>
      <td data-col-tabla="historial-movimientos" data-col="desde"${colStyle('historial-movimientos', 'desde')}></td>
      <td data-col-tabla="historial-movimientos" data-col="a"${colStyle('historial-movimientos', 'a')} style="font-size:0.78rem; font-weight:400; color:var(--text-secondary); text-align:right;">
        Entradas: <span style="color:var(--color-success); font-weight:600;">+${formatQty(entradas)}</span> ·
        Salidas: <span style="color:var(--color-danger); font-weight:600;">-${formatQty(salidas)}</span>
        ${traslados > 0 ? ` · Traslados: ${formatQty(traslados)}` : ''}
      </td>
      <td data-col-tabla="historial-movimientos" data-col="cantidad"${colStyle('historial-movimientos', 'cantidad')} style="text-align:right; color:${colorNeto};">Neto: ${signoNeto}${formatQty(neto)}</td>
      <td data-col-tabla="historial-movimientos" data-col="unidades"${colStyle('historial-movimientos', 'unidades')} style="text-align:right; color:${colorNetoUnid};">Neto: ${signoNetoUnid}${formatQty(netoUnid)}</td>
    </tr>`
}

// Genera el correlativo de documento estilo Odoo: "{codigo almacén}/INT/{n° con padding a 5 dígitos}"
// (ej. "SJLP/INT/00393"). Un solo traslado (varios productos/lotes) comparte
// el MISMO numero_documento en todas sus líneas de kardex — así se puede
// reconstruir el documento completo agrupando por este campo, igual que en
// Odoo. Si la migración 56 (tabla+función en Supabase) todavía no corrió, o
// falla la llamada, se devuelve null y el traslado se guarda igual (sin
// numero_documento) en vez de bloquear la operación por esto.
export async function _generarNumeroDocumentoTraslado(almacen) {
  try {
    if (!almacen?.id) return null
    const numero = await obtenerSiguienteNumeroSecuencia(almacen.id, 'INT')
    const codigo = (almacen.codigo || 'ALM').toString().trim()
    return `${codigo}/INT/${String(numero).padStart(5, '0')}`
  } catch (e) {
    console.warn('No se pudo generar número de documento (¿falta correr 56_secuencias_documentos_traslados.sql?):', e)
    return null
  }
}

window.guardarTrasladoInterno = async function () {
  const btn = document.getElementById('btnGuardarTrasladoInterno')
  if (btn?.disabled) return
  try {
    const user = await getCurrentUser()
    if (!user) { showToast('Usuario no autenticado', 'danger'); return }

    const zonaOrigenId = parseInt(document.getElementById('tiZonaOrigen')?.value || 0)
    const zonaDestinoId = parseInt(document.getElementById('tiZonaDestino')?.value || 0)
    const fecha = document.getElementById('tiFecha')?.value
    const descripcion = document.getElementById('tiDescripcion')?.value?.trim() || null
    const documentoReferencia = document.getElementById('tiDocumentoReferencia')?.value?.trim() || null

    if (!zonaOrigenId)  { showToast('Selecciona la zona origen', 'warning'); return }
    if (!zonaDestinoId) { showToast('Selecciona la zona destino', 'warning'); return }
    if (zonaOrigenId === zonaDestinoId) { showToast('La zona destino debe ser distinta a la zona origen', 'warning'); return }
    if (!fecha)         { showToast('Ingresa la fecha', 'warning'); return }
    if (S._detallesTrasladoEnCreacion.length === 0) { showToast('Agrega al menos un producto', 'warning'); return }

    if (btn) { btn.disabled = true; btn.textContent = 'Guardando...' }

    const [zonas, almacenes] = await Promise.all([getUbicaciones(), getAlmacenes()])
    const zonaOrigen = (zonas || []).find(z => z.id === zonaOrigenId)
    const zonaDestino = (zonas || []).find(z => z.id === zonaDestinoId)

    // Un solo número de documento para TODO el traslado (todas las líneas lo
    // comparten), generado UNA vez antes del loop — no por línea.
    const almacenOrigenObj = (almacenes || []).find(a => a.id === zonaOrigen?.almacen_id)
    const numeroDocumento = await _generarNumeroDocumentoTraslado(almacenOrigenObj)

    for (const linea of S._detallesTrasladoEnCreacion) {
      const stockList = await getStockUbicaciones()
      const origen = stockList.find(s => s.lote_id === linea.lote_id && s.ubicacion_id === zonaOrigenId)
      const disponible = parseFloat(origen?.cantidad || 0)
      const disponibleUnid = parseFloat(origen?.cantidad_unidades || 0)
      const unidades = parseFloat(linea.cantidad_unidades) || 0
      if (!origen || linea.cantidad > disponible) {
        showToast(`Stock insuficiente para ${linea.item_nombre} (lote ${linea.numero_lote}): disponible ${disponible.toLocaleString('en-US', { maximumFractionDigits: 2 })}`, 'danger')
        continue
      }
      if (unidades > 0 && unidades > disponibleUnid) {
        showToast(`Unidades insuficientes para ${linea.item_nombre} (lote ${linea.numero_lote}): disponible ${disponibleUnid.toLocaleString('en-US', { maximumFractionDigits: 2 })} und`, 'danger')
        continue
      }

      const lote = await getLoteById(linea.lote_id)
      const costoUnitario = parseFloat(lote?.costo_unitario || 0)

      // 1) Descontar (o eliminar) la fila de origen
      const restante = parseFloat((disponible - linea.cantidad).toFixed(4))
      const restanteUnid = Math.max(0, parseFloat((disponibleUnid - unidades).toFixed(4)))
      if (restante <= 0) {
        await deleteStockUbicacion(origen.id)
      } else {
        await updateStockUbicacion(origen.id, { cantidad: restante, cantidad_unidades: restanteUnid })
      }

      // 2) Sumar (o crear) la fila de destino
      const destinoExistente = stockList.find(s => s.lote_id === linea.lote_id && s.ubicacion_id === zonaDestinoId)
      if (destinoExistente) {
        const nuevaCantidadDestino = parseFloat(((parseFloat(destinoExistente.cantidad) || 0) + linea.cantidad).toFixed(4))
        const nuevaUnidadesDestino = parseFloat(((parseFloat(destinoExistente.cantidad_unidades) || 0) + unidades).toFixed(4))
        await updateStockUbicacion(destinoExistente.id, { cantidad: nuevaCantidadDestino, cantidad_unidades: nuevaUnidadesDestino })
      } else {
        await addStockUbicacion({ lote_id: linea.lote_id, ubicacion_id: zonaDestinoId, cantidad: linea.cantidad, cantidad_unidades: unidades })
      }

      // 3) Kardex: una fila por línea (mismo criterio granular que compras/ventas)
      // saldo_cantidad/saldo_unidades quedan como el saldo que dejó la
      // ZONA ORIGEN (no lotes.cantidad total: un traslado no cambia el
      // total del lote, solo su distribución entre zonas).
      await addKardexMovimiento({
        item_id:              linea.item_id,
        lote_id:              linea.lote_id,
        almacen_id:           zonaOrigen?.almacen_id || null,
        almacen_destino_id:   zonaDestino?.almacen_id || null,
        ubicacion_origen_id:  zonaOrigenId,
        ubicacion_destino_id: zonaDestinoId,
        fecha,
        tipo_movimiento:      'traslado_interno',
        concepto:             'Traslado interno entre zonas',
        descripcion,
        documento_referencia: documentoReferencia,
        numero_documento:     numeroDocumento,
        // Traslado interno: la MISMA cantidad sale de origen y entra a
        // destino en esta única fila (antes se guardaba cantidad_entrada=0,
        // lo que hacía que cualquier cálculo por zona basado en
        // sum(entrada)-sum(salida) — reportes, vista stock_ubicaciones —
        // contara el traslado como una fuga real de inventario en vez de
        // un simple cambio de zona). saldo_cantidad/saldo_unidades siguen
        // representando el saldo de la ZONA ORIGEN, no cambian.
        cantidad_salida:      linea.cantidad,
        cantidad_entrada:     linea.cantidad,
        cantidad_unidades_entrada: unidades,
        cantidad_unidades_salida:  unidades,
        costo_unitario:       costoUnitario,
        valor_entrada:        0,
        valor_salida:         parseFloat((linea.cantidad * costoUnitario).toFixed(2)),
        moneda:               lote?.moneda || 'PEN',
        tipo_cambio:           parseFloat(lote?.tipo_cambio) || 1,
        costo_unit_original:   parseFloat(lote?.costo_unit_original ?? costoUnitario),
        saldo_cantidad:       restante,
        saldo_valor:          parseFloat((restante * costoUnitario).toFixed(2)),
        saldo_unidades:       restanteUnid,
        created_by:           user.db_id
      })

      // 4) Peso variable: mover los bultos CONCRETOS a la zona destino.
      // stock_ubicaciones ya quedó correcto arriba (agregado en kg), pero
      // lote_bultos es la fuente de verdad real para estos productos —
      // Compras/Ventas la usan directo (getLoteBultosDisponiblesZona) para
      // saber qué bultos hay en cada zona. No se toca lotes.cantidad ni se
      // recalcula el lote: un traslado no cambia el total del lote, solo
      // dónde están físicamente sus bultos.
      if (linea.es_peso_variable && linea.bultos_seleccionados?.length) {
        for (const bultoId of linea.bultos_seleccionados) {
          await updateLoteBulto(bultoId, { ubicacion_id: zonaDestinoId })
        }
      }
    }

    showToast('Traslado registrado', 'success')
    window.closeModal('modal-traslado-interno')
    S._detallesTrasladoEnCreacion = []
    const form = document.getElementById('formTrasladoInterno')
    if (form) form.reset()
    await window.renderResumenStockUnificado()
  } catch (error) {
    console.error('Error en guardarTrasladoInterno:', error)
    showToast('Error al registrar el traslado', 'danger')
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Trasladar' }
  }
}
