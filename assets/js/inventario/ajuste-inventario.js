// ============================================================================
// inventario/ajuste-inventario.js — parte de inventario.js (reorganizado 2026-09-25, sin cambios de lógica)
// Mapa completo de funciones: Claude outputs/glosario_funciones_erp.md
// ============================================================================
import { getCurrentUser } from '../auth-supabase.js'
import { getItems, getLotes, getLoteById, updateLote, getAlmacenes, getUbicaciones, getStockUbicacionesByLote, addKardexMovimiento } from '../supabase-data.js'
import { showToast } from '../helpers.js'
import { renderKardex } from './kardex.js'
import { _repInvListos } from './reportes.js'

// ============================================================================
// AJUSTE DE INVENTARIO (KARDEX) — botón que estaba sin implementar
// ============================================================================
// El modal `modal-ajuste-kardex` existía en el HTML pero sus dos funciones
// nunca se escribieron, así que ambos botones lanzaban TypeError.
//
// Un ajuste corrige una diferencia entre el stock del sistema y el conteo
// físico. Como el costeo es por identificación específica, el ajuste se aplica
// SIEMPRE contra un lote concreto: sin lote no se sabría a qué costo entra o
// sale la mercadería. Por eso el selector muestra lotes, no solo productos.

// Sugiere N° de Unidades a partir del peso_por_unidad del lote elegido y la
// Cantidad ya tecleada — mismo criterio que Despacho (Ventas) y Traslados.
// El campo se queda editable: esto solo rellena un valor de partida, el
// usuario lo puede corregir a mano (ej. una caja abierta a la mitad).
window._sugerirUnidadesAjusteKardex = function () {
  const sel = document.getElementById('ajusteKardexItem')
  const inpCant = document.getElementById('ajusteKardexCant')
  const inpUnid = document.getElementById('ajusteKardexUnidades')
  if (!sel || !inpCant || !inpUnid) return

  const pesoPorUnidad = parseFloat(sel.selectedOptions[0]?.getAttribute('data-peso-por-unidad') || '')
  const cantidad = parseFloat(inpCant.value || 0)
  if (pesoPorUnidad > 0 && cantidad > 0) {
    inpUnid.value = parseFloat((cantidad / pesoPorUnidad).toFixed(2))
  }
}

window.abrirModalAjusteKardex = async function () {
  try {
    const [lotes, items, zonas, almacenes] = await Promise.all([getLotes(), getItems(), getUbicaciones(), getAlmacenes()])
    const itemMap = {}
    items.forEach(i => { itemMap[i.id] = i })
    const almacenMap = {}
    ;(almacenes || []).forEach(a => { almacenMap[a.id] = a })

    const sel = document.getElementById('ajusteKardexItem')
    if (sel) {
      const conStock = lotes
        .filter(l => l.item_id)
        .sort((a, b) => (itemMap[a.item_id]?.nombre || '').localeCompare(itemMap[b.item_id]?.nombre || ''))
      sel.innerHTML = '<option value="">-- Selecciona lote --</option>' + conStock.map(l => {
        const it = itemMap[l.item_id]
        return `<option value="${l.id}" data-costo="${l.costo_unitario || 0}" data-peso-por-unidad="${l.peso_por_unidad || ''}">${(it?.nombre || 'Item ' + l.item_id)} · Lote ${l.numero_lote || l.id} (stock ${parseFloat(l.cantidad || 0)})</option>`
      }).join('')

      // Precargar el costo del lote elegido: en un ajuste de entrada casi
      // siempre se usa el mismo costo que ya tiene el lote. De paso, sugerir
      // N° de Unidades apenas se elige el lote (mismo criterio que Despacho/
      // Traslados: cantidad ÷ peso_por_unidad), por si ya hay algo tecleado
      // en Cantidad.
      sel.onchange = () => {
        const costo = sel.selectedOptions[0]?.getAttribute('data-costo')
        const inp = document.getElementById('ajusteKardexCosto')
        if (inp && costo) inp.value = parseFloat(costo).toFixed(4)
        window._sugerirUnidadesAjusteKardex()
      }
    }

    const inpCant = document.getElementById('ajusteKardexCant')
    if (inpCant) inpCant.oninput = () => window._sugerirUnidadesAjusteKardex()

    // Zona real (almacén no virtual) donde vive físicamente el ajuste. Desde
    // 50_stock_ubicaciones_vista_kardex.sql, "Por Zona" es una VISTA calculada
    // desde kardex.ubicacion_origen_id/ubicacion_destino_id — sin zona aquí,
    // el ajuste movería lotes.cantidad pero jamás aparecería en ninguna zona
    // (ver memoria project_desincronizacion_lotes_stock_kardex).
    const selZona = document.getElementById('ajusteKardexZona')
    if (selZona) {
      const zonasReales = (zonas || []).filter(z => !almacenMap[z.almacen_id]?.es_virtual)
      selZona.innerHTML = '<option value="">-- Selecciona zona --</option>' +
        zonasReales
          .sort((a, b) => (almacenMap[a.almacen_id]?.nombre || '').localeCompare(almacenMap[b.almacen_id]?.nombre || '') || (a.nombre || '').localeCompare(b.nombre || ''))
          .map(z => `<option value="${z.id}">${almacenMap[z.almacen_id]?.nombre || '?'} — ${z.nombre}</option>`)
          .join('')
    }

    const fecha = document.getElementById('ajusteKardexFecha')
    if (fecha) fecha.value = new Date().toISOString().split('T')[0]
    ;['ajusteKardexCant', 'ajusteKardexUnidades', 'ajusteKardexConcepto'].forEach(id => {
      const el = document.getElementById(id); if (el) el.value = ''
    })

    window.openModal('modal-ajuste-kardex')
  } catch (e) {
    console.error('abrirModalAjusteKardex:', e)
    showToast('Error al abrir el ajuste: ' + e.message, 'danger')
  }
}

window.guardarAjusteKardex = async function () {
  try {
    const loteId    = parseInt(document.getElementById('ajusteKardexItem')?.value || 0)
    const zonaId    = parseInt(document.getElementById('ajusteKardexZona')?.value || 0)
    const tipo      = document.getElementById('ajusteKardexTipo')?.value
    const fecha     = document.getElementById('ajusteKardexFecha')?.value
    const cantidad  = parseFloat(document.getElementById('ajusteKardexCant')?.value || 0)
    const unidades  = parseFloat(document.getElementById('ajusteKardexUnidades')?.value || 0) || 0
    const costo     = parseFloat(document.getElementById('ajusteKardexCosto')?.value || 0)
    const concepto  = document.getElementById('ajusteKardexConcepto')?.value?.trim()

    if (!loteId)       { showToast('Selecciona el lote a ajustar', 'warning'); return }
    if (!zonaId)       { showToast('Selecciona el almacén/zona del ajuste', 'warning'); return }
    if (!fecha)        { showToast('Ingresa la fecha del ajuste', 'warning'); return }
    if (cantidad < 0)  { showToast('La cantidad no puede ser negativa', 'warning'); return }
    // Cantidad en 0 SÍ se permite: es el caso de una corrección que solo
    // toca N° de Unidades sin mover peso (ej. arreglar un desfase histórico
    // de unidades que quedó mal por un bug ya corregido, sin alterar el
    // stock en kg que ya está bien). Lo único que no tiene sentido es un
    // ajuste que no mueve absolutamente nada.
    if (cantidad <= 0 && unidades <= 0) {
      showToast('Ingresa una Cantidad o un N° de Unidades mayor a 0', 'warning'); return
    }
    if (!concepto)     { showToast('Indica el motivo del ajuste (queda registrado en el kardex)', 'warning'); return }

    const lote = await getLoteById(loteId)
    if (!lote) { showToast('Lote no encontrado', 'danger'); return }

    const esEntrada = tipo === 'ajuste_entrada'
    const stockActual = parseFloat(lote.cantidad || 0)

    if (!esEntrada && cantidad > stockActual + 0.0001) {
      showToast(`No puedes retirar ${cantidad}: el lote solo tiene ${stockActual}`, 'warning')
      return
    }

    // stock_ubicaciones es una VISTA calculada desde kardex (ver
    // 50_stock_ubicaciones_vista_kardex.sql) — validamos contra lo que esa
    // zona tiene realmente, no solo contra el total del lote, para no dejar
    // una zona en negativo aunque el lote en general sí tenga stock.
    if (!esEntrada) {
      const filasZona = await getStockUbicacionesByLote(loteId)
      const filaZona = (filasZona || []).find(f => f.ubicacion_id === zonaId)
      const disponibleZona = parseFloat(filaZona?.cantidad || 0)
      if (cantidad > disponibleZona + 0.0001) {
        showToast(`Esa zona solo tiene ${disponibleZona} de este lote (el lote en total tiene ${stockActual}). Elige la zona correcta o ajusta primero un traslado.`, 'warning')
        return
      }
    }

    const nuevaCantidad = parseFloat((esEntrada ? stockActual + cantidad : stockActual - cantidad).toFixed(4))
    const unidadesActuales = parseFloat(lote.cantidad_unidades || 0)
    const nuevaCantidadUnidades = parseFloat(Math.max(0, esEntrada ? unidadesActuales + unidades : unidadesActuales - unidades).toFixed(4))
    const costoUnitario = costo > 0 ? costo : (parseFloat(lote.costo_unitario) || 0)
    const valor = parseFloat((cantidad * costoUnitario).toFixed(2))

    const user = await getCurrentUser()

    await addKardexMovimiento({
      item_id:              lote.item_id,
      lote_id:              lote.id,
      // Fuente de verdad de "Por Zona" desde 50_stock_ubicaciones_vista_kardex.sql:
      // sin esto el ajuste mueve lotes.cantidad pero no aparece en ninguna zona.
      ubicacion_origen_id:  esEntrada ? null : zonaId,
      ubicacion_destino_id: esEntrada ? zonaId : null,
      fecha,
      tipo_movimiento:      tipo,
      concepto,
      descripcion:          `Ajuste de inventario — lote ${lote.numero_lote || lote.id}`,
      documento_referencia: `AJUSTE-${new Date().toISOString().slice(0, 10)}`,
      cantidad_entrada:     esEntrada ? cantidad : 0,
      cantidad_salida:      esEntrada ? 0 : cantidad,
      cantidad_unidades_entrada: esEntrada ? unidades : 0,
      cantidad_unidades_salida:  esEntrada ? 0 : unidades,
      costo_unitario:       costoUnitario,
      valor_entrada:        esEntrada ? valor : 0,
      valor_salida:         esEntrada ? 0 : valor,
      // saldo_cantidad/saldo_valor/saldo_unidades: antes no se enviaban acá
      // (a diferencia de compras/ventas), así que quedaban NULL/0 en la fila
      // de Kardex de todo ajuste — igual criterio que entrada/salida: es el
      // total del LOTE (no de la zona), porque el ajuste sí cambia
      // lote.cantidad/cantidad_unidades directamente.
      saldo_cantidad:       nuevaCantidad,
      saldo_valor:          parseFloat((nuevaCantidad * costoUnitario).toFixed(2)),
      saldo_unidades:       nuevaCantidadUnidades,
      created_by:           user?.db_id || null
    })

    // El ajuste ya registraba unidades en el Kardex (arriba) pero nunca las
    // aplicaba al lote — mismo patrón de bug encontrado en los flujos de
    // Compras (ver compras.js, 2026-09-17): el peso se actualizaba, las
    // unidades se quedaban pegadas en el valor viejo.
    await updateLote(lote.id, { cantidad: nuevaCantidad, cantidad_unidades: nuevaCantidadUnidades })

    showToast(`Ajuste registrado ✅ — el lote pasó de ${stockActual} a ${nuevaCantidad}`, 'success')
    window.closeModal('modal-ajuste-kardex')

    // El ajuste altera stock y valorización: hay que invalidar el caché para
    // que los reportes gerenciales no muestren las cifras anteriores.
    _invalidarCacheInventario()
    await renderKardex()
  } catch (e) {
    console.error('guardarAjusteKardex:', e)
    showToast('Error al guardar el ajuste: ' + e.message, 'danger')
  }
}

function _invalidarCacheInventario() {
  import('./data-cache.js').then(({ invalidarVarios }) => {
    invalidarVarios(['lotes', 'kardex', 'stock_ubicaciones', 'items'])
  }).catch(() => {})
  Object.keys(_repInvListos).forEach(k => { _repInvListos[k] = false })
}

export function _escInv(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}
