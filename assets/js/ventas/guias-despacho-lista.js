// ============================================================================
// ventas/guias-despacho-lista.js — parte de ventas.js (reorganizado 2026-09-25, sin cambios de lógica)
// Mapa completo de funciones: Claude outputs/glosario_funciones_erp.md
// ============================================================================
import { S } from './state.js'
import { registrarColumnas, colStyle } from '../col-menu.js'
import { getCustomers, getLoteById, getVentas, updateVenta, getDetalleVentas, ultimoErrorDelete, getKardexByVenta, deleteKardexMovimiento, getGuiasDespachoVenta, getGuiaDespachoVentaById, deleteGuiaDespachoVenta, getDetalleGuiasDespachoVenta, getDetalleGuiasDespachoVentaByVenta, invalidateGuiasDespachoVentaCache, recalcularLoteDesdeBultos, revertirBultosDeDetalleGuiaDespacho } from '../supabase-data.js'
import { showToast } from '../helpers.js'
import { menuAccionesFila } from '../main.js'
import { estaAnulado, badgeAnulado, ESTILO_FILA_ANULADA } from '../anulacion.js'
import { _invalidarCacheVentas } from './anulacion.js'
import { _esc } from './init.js'
import { _guiaEstaVigente } from './ventas-editar.js'
import { _compararValoresOrdenVentas, _devolverAUnaZona, renderVentas } from './ventas-lista.js'

/** Compara lo despachado (detalle_guias_despacho_venta) contra lo vendido (detalle_ventas) y actualiza ventas.estado_despacho. */
export async function _recalcularEstadoDespachoVenta(ventaId) {
  const [detalles, despachos] = await Promise.all([
    getDetalleVentas(ventaId),
    getDetalleGuiasDespachoVentaByVenta(ventaId)
  ])
  // Las guías anuladas ya devolvieron su stock, así que no cuentan como
  // despachado: si contaran, una venta con su única guía anulada seguiría
  // apareciendo como "despachada" y no se podría volver a despachar.
  const guiasVenta = await getGuiasDespachoVenta(true)
  const guiasAnuladas = new Set((guiasVenta || []).filter(g => !_guiaEstaVigente(g)).map(g => g.id))

  const despachadoPorDetalle = {}
  for (const d of (despachos || [])) {
    if (guiasAnuladas.has(d.guia_id)) continue
    despachadoPorDetalle[d.detalle_venta_id] = (despachadoPorDetalle[d.detalle_venta_id] || 0) + (parseFloat(d.cantidad) || 0)
  }
  let totalVendido = 0, totalDespachado = 0
  for (const d of (detalles || [])) {
    totalVendido += parseFloat(d.cantidad) || 0
    totalDespachado += Math.min(parseFloat(d.cantidad) || 0, despachadoPorDetalle[d.id] || 0)
  }
  let estado = 'pendiente'
  if (totalDespachado > 0 && totalDespachado + 0.0001 >= totalVendido) estado = 'despachado'
  else if (totalDespachado > 0) estado = 'parcial'
  await updateVenta(ventaId, { estado_despacho: estado })
}

// Lógica núcleo de eliminación (sin confirm ni toasts) — la usan tanto el
// borrado individual como el masivo. Lanza Error con mensaje claro si algo
// impide eliminar, para que el masivo pueda seguir con las demás y reportar
// al final cuáles fallaron.
/**
 * Revierte TODO el stock/kardex/bultos que una guía de despacho movió —
 * pero sin borrar la guía ni sus detalles (eso lo decide quien llama: al
 * eliminar se borra todo; al EDITAR se revierte esto y luego se vuelve a
 * aplicar con los valores nuevos sobre la misma guía). Aislado en su propio
 * helper para que ambos flujos compartan exactamente la misma lógica de
 * reversión — escribirla dos veces es como se cuelan descuadres de stock.
 */
export async function _revertirStockGuiaDespacho(id) {
  const guiaActual = await getGuiaDespachoVentaById(id)
  if (!guiaActual) throw new Error(`Guía #${id}: no se encontró`)

  const detalles = await getDetalleGuiasDespachoVenta(id)

  // Revertir stock. _devolverAUnaZona actualiza lote.cantidad + la fila
  // espejo de stock_ubicaciones. Para lotes de peso variable (bultos), el
  // valor que escribe en lote.cantidad ahí es solo intermedio: se pisa abajo
  // con recalcularLoteDesdeBultos, que es la fuente de verdad real para esos
  // productos (mismo patrón dual-write que Fase 1 en compras — stock_
  // ubicaciones se mantiene en paralelo aunque el lote se recalcule aparte).
  const lotesPesoVariableTocados = new Set()
  for (const dg of (detalles || [])) {
    await _devolverAUnaZona(dg.lote_id, dg.ubicacion_id, parseFloat(dg.cantidad) || 0, parseFloat(dg.cantidad_unidades) || 0)
    const lote = dg.lote_id ? await getLoteById(dg.lote_id) : null
    if (lote?.es_peso_variable) {
      // Revierte a 'disponible' los bultos concretos que esta línea marcó
      // 'vendido', ANTES de borrar la guía (mismo orden que el fix de
      // compras: revertir/desvincular referencias primero, borrar después).
      await revertirBultosDeDetalleGuiaDespacho(dg.id, dg.ubicacion_id)
      lotesPesoVariableTocados.add(dg.lote_id)
    }
  }
  // Recalcular cada lote de peso variable UNA sola vez, después de revertir
  // TODOS sus bultos (no por línea) — evita recalcular con bultos aún a
  // medio revertir si la guía tocó el mismo lote en más de una línea.
  for (const loteId of lotesPesoVariableTocados) {
    await recalcularLoteDesdeBultos(loteId)
  }

  // Kardex: se borran las filas 'salida' de esta venta que correspondan a
  // los lotes tocados por esta guía específica (documento_referencia =
  // numero_guia de esta guía).
  if (guiaActual.venta_id) {
    const kardexVenta = await getKardexByVenta(guiaActual.venta_id)
    for (const k of (kardexVenta || [])) {
      if (k.documento_referencia === guiaActual.numero_guia) {
        const okKardex = await deleteKardexMovimiento(k.id)
        if (!okKardex) {
          const motivo = ultimoErrorDelete()
          throw new Error(`No se pudo eliminar el movimiento de Kardex #${k.id} de la guía ${guiaActual.numero_guia}: ${motivo?.mensaje || 'motivo desconocido'}. Se detiene el borrado para no dejar el Kardex descuadrado.`)
        }
      }
    }
  }

  return { guiaActual, detalles: detalles || [] }
}

async function _eliminarGuiaDespachoCore(id) {
  const { guiaActual, detalles } = await _revertirStockGuiaDespacho(id)

  const ok = await deleteGuiaDespachoVenta(id) // detalle_guias_despacho_venta se borra solo (ON DELETE CASCADE)
  if (!ok) {
    const motivo = ultimoErrorDelete()
    throw new Error(`Guía ${guiaActual.numero_guia}: ${motivo?.mensaje || 'no se pudo eliminar'}`)
  }

  if (guiaActual.venta_id) await _recalcularEstadoDespachoVenta(guiaActual.venta_id)
  return { numero: guiaActual.numero_guia, ventaId: guiaActual.venta_id, lineas: detalles?.length || 0 }
}

window.eliminarGuiaDespachoVenta = async function (id) {
  try {
    const detalles = await getDetalleGuiasDespachoVenta(id)
    if (!confirm(
      `Se eliminará la guía de despacho y se revertirá el stock (${detalles?.length || 0} línea(s)) a Inventario. ¿Continuar?`
    )) return

    await _eliminarGuiaDespachoCore(id)

    _invalidarCacheVentas()
    showToast('Guía de despacho eliminada: stock revertido en Inventario', 'success')
    await renderGuiasDespachoVenta(true)
    await renderVentas(true)
  } catch (error) {
    console.error('Error en eliminarGuiaDespachoVenta:', error)
    showToast('Error al eliminar la guía: ' + error.message, 'danger')
  }
}

// ── Selección múltiple ──────────────────────────────────────────────────────
// Las guías anuladas quedan fuera de la selección: su stock YA se revirtió al
// anularlas, así que eliminarlas en lote junto a guías vigentes aplicaría la
// reversión dos veces sobre el mismo lote.

window.toggleSeleccionTodasGuiasDespacho = function (checked) {
  document.querySelectorAll('.gd-sel:not(:disabled)').forEach(cb => { cb.checked = checked })
  window.actualizarBotonEliminarGuiasDespacho()
}

window.actualizarBotonEliminarGuiasDespacho = function () {
  const n = document.querySelectorAll('.gd-sel:checked').length
  const btn = document.getElementById('btnEliminarGuiasDespachoSel')
  if (!btn) return
  btn.style.display = n > 0 ? 'inline-flex' : 'none'
  btn.textContent = `🗑 Eliminar seleccionadas (${n})`
}

window.eliminarGuiasDespachoSeleccionadas = async function () {
  const ids = Array.from(document.querySelectorAll('.gd-sel:checked')).map(cb => parseInt(cb.value))
  if (ids.length === 0) { showToast('Selecciona al menos una guía', 'warning'); return }

  if (!confirm(
    `Se eliminarán ${ids.length} guía(s) de despacho y se devolverá su stock (kg y unidades) a Inventario.\n\n` +
    `También se recalculará el estado de despacho de las ventas afectadas.\n\n` +
    `Esta acción no se puede deshacer. ¿Continuar?`
  )) return

  const btn = document.getElementById('btnEliminarGuiasDespachoSel')
  if (btn) { btn.disabled = true; btn.textContent = 'Eliminando...' }

  let ok = 0
  const errores = []
  for (const id of ids) {
    try {
      await _eliminarGuiaDespachoCore(id)
      ok++
    } catch (e) {
      console.error(`Error eliminando guía de despacho ${id}:`, e)
      errores.push(e.message || `Guía #${id}: error inesperado`)
    }
  }

  if (ok > 0) showToast(`${ok} guía(s) eliminada(s): stock devuelto a Inventario`, 'success')
  if (errores.length > 0) showToast(`${errores.length} no se pudo(eron) eliminar: ${errores.join(' | ')}`, 'danger', 8000)

  if (btn) { btn.disabled = false }
  _invalidarCacheVentas()
  await renderGuiasDespachoVenta(true)
  await renderVentas(true)
}

// Orden por columna (click en header) — mismo patrón que _ventasSort en este
// mismo archivo (comparador genérico _compararValoresOrdenVentas reusado).
let _guiasDespachoSort = { col: null, dir: 'asc' }

function _flechaOrdenGuiasDespacho(campo) {
  if (_guiasDespachoSort.col !== campo) return ''
  return _guiasDespachoSort.dir === 'asc' ? ' ▲' : ' ▼'
}

function _thOrdenableGuiasDespacho(label, campo) {
  const oculto = colStyle('guias-despacho', campo) !== ''
  return `<th data-col-tabla="guias-despacho" data-col="${campo}" style="cursor:pointer; user-select:none;${oculto ? ' display:none;' : ''}" onclick="window.ordenarGuiasDespacho('${campo}')" title="Ordenar por ${label}">${label}${_flechaOrdenGuiasDespacho(campo)}</th>`
}

function _valorOrdenGuiaDespacho(g, campo) {
  switch (campo) {
    case 'numero_guia': return g.numero_guia || ''
    case 'venta':        return g.ventaNumero || ''
    case 'cliente':      return g.clienteNombre || ''
    case 'fecha':        return g.fecha_guia || ''
    case 'estado':       return estaAnulado(g) ? 'anulada' : 'emitida'
    default: return ''
  }
}

window.ordenarGuiasDespacho = function (campo) {
  if (_guiasDespachoSort.col === campo) {
    _guiasDespachoSort.dir = _guiasDespachoSort.dir === 'asc' ? 'desc' : 'asc'
  } else {
    _guiasDespachoSort.col = campo
    _guiasDespachoSort.dir = 'asc'
  }
  renderGuiasDespachoVenta(false)
}

export async function renderGuiasDespachoVenta(forzar = false) {
  try {
    const container = document.getElementById('tabla-guias-despacho')
    if (!container) return

    if (!S._guiasDespachoLista || forzar) {
      invalidateGuiasDespachoVentaCache()
      const [guias, ventas, clientes] = await Promise.all([getGuiasDespachoVenta(true), getVentas(), getCustomers()])
      const ventasMap = {}
      for (const v of (ventas || [])) ventasMap[v.id] = v
      const clientesMap = {}
      for (const c of (clientes || [])) clientesMap[c.id] = c
      S._guiasDespachoLista = (guias || []).map(g => {
        const v = ventasMap[g.venta_id]
        return {
          ...g,
          ventaNumero: v ? `${v.serie || ''}-${String(v.correlativo || '').padStart(8,'0')}` : `Venta #${g.venta_id}`,
          clienteNombre: v ? (clientesMap[v.contact_id]?.razon_social || clientesMap[v.contact_id]?.nombre || '-') : '-'
        }
      }).sort((a, b) => new Date(b.fecha_guia || 0) - new Date(a.fecha_guia || 0))
    }

    const busqueda = (document.getElementById('buscarGuiaDespacho')?.value || '').trim().toLowerCase()
    const lista = busqueda
      ? S._guiasDespachoLista.filter(g => `${g.numero_guia || ''} ${g.clienteNombre || ''} ${g.ventaNumero || ''}`.toLowerCase().includes(busqueda))
      : [...S._guiasDespachoLista]

    if (_guiasDespachoSort.col) {
      lista.sort((a, b) => {
        const cmp = _compararValoresOrdenVentas(_valorOrdenGuiaDespacho(a, _guiasDespachoSort.col), _valorOrdenGuiaDespacho(b, _guiasDespachoSort.col))
        return _guiasDespachoSort.dir === 'asc' ? cmp : -cmp
      })
    }

    if (!lista || lista.length === 0) {
      container.innerHTML = `<p style="text-align:center; color:var(--text-secondary); padding:20px;">${busqueda ? 'Sin resultados para la búsqueda' : 'Sin guías de despacho registradas'}</p>`
      return
    }

    container.innerHTML = `
      <table>
        <thead>
          <tr>
            <th data-col-tabla="guias-despacho" data-col="sel" style="width:32px;${colStyle('guias-despacho','sel') ? 'display:none;' : ''}"><input type="checkbox" id="selAllGuiasDespacho" onchange="window.toggleSeleccionTodasGuiasDespacho(this.checked)" title="Seleccionar todas"></th>
            ${_thOrdenableGuiasDespacho('N° Guía', 'numero_guia')}
            ${_thOrdenableGuiasDespacho('Venta', 'venta')}
            ${_thOrdenableGuiasDespacho('Cliente', 'cliente')}
            ${_thOrdenableGuiasDespacho('Fecha', 'fecha')}
            ${_thOrdenableGuiasDespacho('Estado', 'estado')}
            <th data-col-tabla="guias-despacho" data-col="observaciones"${colStyle('guias-despacho','observaciones')}>Observaciones</th>
            <th data-col-tabla="guias-despacho" data-col="acciones"${colStyle('guias-despacho','acciones')}>Acciones</th>
          </tr>
        </thead>
        <tbody>
          ${lista.map(g => {
            const anulada   = estaAnulado(g)
            const revertida = !anulada && g.estado === 'revertida'
            const inactiva  = anulada || revertida
            return `
            <tr${anulada ? ` style="${ESTILO_FILA_ANULADA}"` : (revertida ? ' style="opacity:.7;"' : '')}>
              <td data-col-tabla="guias-despacho" data-col="sel" style="text-decoration:none; opacity:1;${colStyle('guias-despacho','sel') ? ' display:none;' : ''}">${inactiva
                ? `<input type="checkbox" disabled title="${anulada ? 'Guía anulada' : 'Guía revertida'}: su stock ya fue revertido">`
                : `<input type="checkbox" class="gd-sel" value="${g.id}" onchange="window.actualizarBotonEliminarGuiasDespacho()">`}</td>
              <td data-col-tabla="guias-despacho" data-col="numero_guia"${colStyle('guias-despacho','numero_guia')}>${g.numero_guia}</td>
              <td data-col-tabla="guias-despacho" data-col="venta"${colStyle('guias-despacho','venta')}>${g.ventaNumero}</td>
              <td data-col-tabla="guias-despacho" data-col="cliente"${colStyle('guias-despacho','cliente')}>${g.clienteNombre}</td>
              <td data-col-tabla="guias-despacho" data-col="fecha"${colStyle('guias-despacho','fecha')}>${g.fecha_guia || '-'}</td>
              <td data-col-tabla="guias-despacho" data-col="estado"${colStyle('guias-despacho','estado')}>${anulada ? badgeAnulado(g) : (revertida ? `<span class="badge badge-warning" title="Su mercadería reingresó por una Nota de Crédito${g.motivo_anulacion ? ' — ' + _esc(g.motivo_anulacion) : ''}">REVERTIDA</span>` : '<span class="badge badge-success">Emitida</span>')}</td>
              <td data-col-tabla="guias-despacho" data-col="observaciones"${colStyle('guias-despacho','observaciones')}>${g.observaciones ? _esc(g.observaciones) : (inactiva && g.motivo_anulacion ? `<em style="color:var(--text-secondary);">${anulada ? 'Anulado' : 'Revertida'}: ${_esc(g.motivo_anulacion)}</em>` : '-')}</td>
              <td data-col-tabla="guias-despacho" data-col="acciones" class="col-acciones" style="text-decoration:none; opacity:1;${colStyle('guias-despacho','acciones') ? ' display:none;' : ''}">
                ${menuAccionesFila(inactiva
                  ? [{ label: anulada ? 'Ver motivo de anulación' : 'Ver detalle de reversión', icono: 'ℹ️', onclick: `window.verMotivoAnulacion('guia', ${g.id})` }]
                  : [
                      { label: 'Ver detalle', icono: '📋', onclick: `window.verDetalleGuiaDespachoVenta(${g.id})` },
                      { label: 'Editar guía', icono: '✏️', onclick: `window.editarGuiaDespachoVenta(${g.id})` },
                      { label: 'Anular guía', icono: '🚫', onclick: `window.anularGuiaDespachoVenta(${g.id})`, peligro: true },
                      { label: 'Eliminar', icono: '🗑️', onclick: `window.eliminarGuiaDespachoVenta(${g.id})`, peligro: true }
                    ])}
              </td>
            </tr>`
          }).join('')}
        </tbody>
      </table>
    `
  } catch (error) {
    console.error('Error en renderGuiasDespachoVenta:', error)
    showToast('Error al cargar las guías de despacho', 'danger')
  }
}

window.filtrarGuiasDespacho = function () {
  renderGuiasDespachoVenta(false)
}

registrarColumnas('guias-despacho', [
  { key: 'sel',           label: 'Seleccionar' },
  { key: 'numero_guia',   label: 'N° Guía' },
  { key: 'venta',         label: 'Venta' },
  { key: 'cliente',       label: 'Cliente' },
  { key: 'fecha',         label: 'Fecha' },
  { key: 'estado',        label: 'Estado' },
  { key: 'observaciones', label: 'Observaciones' },
  { key: 'acciones',      label: 'Acciones' }
])
