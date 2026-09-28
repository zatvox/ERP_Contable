// ============================================================================
// compras/guias-ingreso-lista.js — parte de compras.js (reorganizado 2026-09-25, sin cambios de lógica)
// Mapa completo de funciones: Claude outputs/glosario_funciones_erp.md
// ============================================================================
import { S } from './state.js'
import { getCurrentUser } from '../auth-supabase.js'
import { colStyle } from '../col-menu.js'
import { getCompraById, getLoteById, updateLote, deleteLote, getItems, getItemById, getMarcas, getGuiasIngresoCompra, getGuiaIngresoCompraById, updateGuiaIngresoCompra, deleteGuiaIngresoCompra, getDetalleGuiasIngresoCompra, getAlmacenes, getUbicaciones, getUbicacionVendors, addKardexMovimiento, getKardexByCompra, deleteKardexMovimiento, ultimoErrorDelete, updateStockUbicacion, getStockUbicacionesByLote, recalcularLoteDesdeBultos, getLoteBultosByLote, deleteLoteBulto } from '../supabase-data.js'
import { showToast } from '../helpers.js'
import { menuAccionesFila } from '../main.js'
import { estaAnulado, badgeAnulado, ESTILO_FILA_ANULADA } from '../anulacion.js'
import { _invalidarCacheCompras } from './anulacion.js'
import { _escCompras } from './buscadores.js'
import { _compararValoresOrden, _thOrdenable, renderCompras } from './compras-lista.js'
import { renderDevolucionesPendientes } from './devolucion-proveedor.js'

// ============================================================================
// GUÍA DE REMISIÓN (recepción de mercadería de una compra ya registrada)
// ============================================================================
// Flujo: la Compra se registra sin lote (solo cantidad/precio/proveedor).
// El stock recién se agrega a Inventario cuando se guarda la Guía de
// Remisión: se elige la compra, se confirma/ajusta la cantidad recibida por
// línea y se pide N° de Lote (obligatorio) + Marca (obligatorio) + Partida
// (opcional) por producto. Cada línea de la guía crea un registro en
// "lotes" (compra_id + guia_id para trazabilidad).

/* _guiaLineas: movido a compras/state.js (S._guiaLineas) */           // líneas de la compra seleccionada, con lote/marca/partida a rellenar
/* _guiaComprasCache: movido a compras/state.js (S._guiaComprasCache) */   // cache de compras para el <select> del modal
// Modo dual del modal-nueva-guia: null = creando una guía nueva; con un id =
// editando esa guía existente (window.editarGuiaIngreso la puso ahí). El
// mismo formulario/tabla se reusa para ambos casos — solo cambia el guardado.
/* _guiaIngresoEditId: movido a compras/state.js (S._guiaIngresoEditId) */
let _guiaComprasConGuiaSet = null // set de compra_id que YA tienen al menos 1 guía (para el badge en renderCompras)

export async function _cargarComprasConGuia(forzar = false) {
  if (_guiaComprasConGuiaSet && !forzar) return _guiaComprasConGuiaSet
  const guias = await getGuiasIngresoCompra()
  // Las guías anuladas ya retiraron su stock, así que la compra vuelve a estar
  // "pendiente de guía": no deben contar aquí o el badge diría "✓ Con Guía"
  // para una compra cuya mercadería ya no está en el almacén.
  _guiaComprasConGuiaSet = new Set(
    (guias || []).filter(g => g.estado !== 'anulada').map(g => g.compra_id)
  )
  return _guiaComprasConGuiaSet
}

let _guiasListaEnriquecida = null // cache: [{g, compra, detalles, productosLote, marcasTexto, zonasTexto}]
let _guiaSort = { col: null, dir: 'asc' } // orden por columna, tab Guías

function _valorOrdenGuia({ g, compra, detalles }, campo) {
  switch (campo) {
    case 'numero_guia':  return g.numero_guia || ''
    case 'fecha_guia':   return g.fecha_guia || ''
    case 'referencia':   return compra?.referencia || `Compra #${g.compra_id}`
    case 'proveedor':    return compra?.proveedor_nombre || ''
    case 'num_productos': return (detalles || []).length
    case 'observaciones': return g.observaciones || ''
    default: return ''
  }
}

window.ordenarGuias = async function (campo) {
  if (_guiaSort.col === campo) {
    _guiaSort.dir = _guiaSort.dir === 'asc' ? 'desc' : 'asc'
  } else {
    _guiaSort.col = campo
    _guiaSort.dir = 'asc'
  }
  await renderGuias()
}

export async function renderGuias(forzar = false) {
  try {
    renderDevolucionesPendientes(forzar).catch(e => console.warn('renderDevolucionesPendientes:', e.message))

    const container = document.getElementById('tabla-guias')
    if (!container) return

    if (!_guiasListaEnriquecida || forzar) {
      const guias = await getGuiasIngresoCompra()
      if (!guias || guias.length === 0) {
        _guiasListaEnriquecida = []
      } else {
        const [itemsList, marcas, zonas, almacenes] = await Promise.all([
          getItems(), getMarcas(), getUbicaciones(), getAlmacenes()
        ])
        const itemMap = {}
        for (const it of (itemsList || [])) itemMap[it.id] = it
        const marcaMap = {}
        for (const m of (marcas || [])) marcaMap[m.id] = m
        const almacenMap = {}
        for (const a of (almacenes || [])) almacenMap[a.id] = a
        const zonaMap = {}
        for (const z of (zonas || [])) zonaMap[z.id] = z

        // Todas las guías en paralelo (antes: una compra+detalle por vez, en
        // secuencia — con 20 guías eran 40 idas y vueltas a la BD una tras otra).
        const guiasOrdenadas = guias.sort((a, b) => b.id - a.id)
        const datosPorGuia = await Promise.all(
          guiasOrdenadas.map(g => Promise.all([
            getCompraById(g.compra_id),
            getDetalleGuiasIngresoCompra(g.id)
          ]))
        )

        _guiasListaEnriquecida = guiasOrdenadas.map((g, idx) => {
          const [compra, detalles] = datosPorGuia[idx]

          // Resumen agrupado por producto en vez de listar cada lote (con
          // guías de 10-20+ lotes la columna se volvía enorme): "Producto —
          // N lote(s) — cantidad total". El detalle lote por lote sigue
          // disponible al editar la guía.
          const porProducto = new Map()
          for (const d of (detalles || [])) {
            const nombre = itemMap[d.item_id]?.nombre || `Item #${d.item_id}`
            const unidad = itemMap[d.item_id]?.unidad_medida || 'KG'
            const acc = porProducto.get(nombre) || { lotes: 0, cantidad: 0, unidad }
            acc.lotes += 1
            acc.cantidad += parseFloat(d.cantidad) || 0
            porProducto.set(nombre, acc)
          }
          const productosLote = [...porProducto.entries()]
            .map(([nombre, acc]) => `${nombre} — ${acc.lotes} lote${acc.lotes === 1 ? '' : 's'} — ${acc.cantidad.toLocaleString('en-US', { maximumFractionDigits: 2 })} ${acc.unidad}`)
            .join('; ') || '-'
          const marcasTexto = [...new Set((detalles || []).map(d => marcaMap[d.marca_id]?.nombre).filter(Boolean))]
            .join(', ') || '-'
          const zonasTexto = [...new Set((detalles || []).map(d => {
            const z = zonaMap[d.ubicacion_id]
            if (!z) return null
            return `${almacenMap[z.almacen_id]?.nombre || '?'} — ${z.nombre}`
          }).filter(Boolean))].join(', ') || '-'

          return { g, compra, detalles, productosLote, marcasTexto, zonasTexto }
        })
      }
    }

    if (_guiasListaEnriquecida.length === 0) {
      container.innerHTML = '<p style="text-align:center; color:var(--text-secondary); padding:20px;">Sin guías de remisión registradas</p>'
      return
    }

    const busqueda = (document.getElementById('buscarGuia')?.value || '').trim().toLowerCase()
    const listaFiltrada = busqueda
      ? _guiasListaEnriquecida.filter(({ g, compra }) => {
          return `${g.numero_guia || ''} ${g.fecha_guia || ''} ${g.observaciones || ''} ${compra?.referencia || ''} ${compra?.proveedor_nombre || ''}`
            .toLowerCase().includes(busqueda)
        })
      : _guiasListaEnriquecida

    if (listaFiltrada.length === 0) {
      container.innerHTML = '<p style="text-align:center; color:var(--text-secondary); padding:20px;">Sin resultados para la búsqueda</p>'
      return
    }

    if (_guiaSort.col) {
      listaFiltrada.sort((a, b) => {
        const cmp = _compararValoresOrden(_valorOrdenGuia(a, _guiaSort.col), _valorOrdenGuia(b, _guiaSort.col))
        return _guiaSort.dir === 'asc' ? cmp : -cmp
      })
    }

    let html = `
      <table>
        <thead>
          <tr>
            <th data-col-tabla="guias-ingreso" data-col="sel" style="width:32px;${colStyle('guias-ingreso','sel') ? 'display:none;' : ''}"><input type="checkbox" id="selAllGuias" onchange="window.toggleSeleccionTodasGuias(this.checked)" title="Seleccionar todas"></th>
            ${_thOrdenable('N° Guía', 'numero_guia', _guiaSort, 'ordenarGuias', 'guias-ingreso')}
            ${_thOrdenable('Fecha', 'fecha_guia', _guiaSort, 'ordenarGuias', 'guias-ingreso', 'fecha')}
            ${_thOrdenable('Compra (Referencia)', 'referencia', _guiaSort, 'ordenarGuias', 'guias-ingreso')}
            ${_thOrdenable('Proveedor', 'proveedor', _guiaSort, 'ordenarGuias', 'guias-ingreso')}
            ${_thOrdenable('# Productos', 'num_productos', _guiaSort, 'ordenarGuias', 'guias-ingreso')}
            <th data-col-tabla="guias-ingreso" data-col="productos"${colStyle('guias-ingreso','productos')}>Producto(s) / Lote(s)</th>
            <th data-col-tabla="guias-ingreso" data-col="marcas"${colStyle('guias-ingreso','marcas')}>Marca(s)</th>
            <th data-col-tabla="guias-ingreso" data-col="zonas"${colStyle('guias-ingreso','zonas')}>Almacén / Zona(s)</th>
            ${_thOrdenable('Observaciones', 'observaciones', _guiaSort, 'ordenarGuias', 'guias-ingreso')}
            <th data-col-tabla="guias-ingreso" data-col="estado"${colStyle('guias-ingreso','estado')}>Estado</th>
            <th data-col-tabla="guias-ingreso" data-col="acciones"${colStyle('guias-ingreso','acciones')}>Acciones</th>
          </tr>
        </thead>
        <tbody>
    `

    listaFiltrada.forEach(({ g, compra, detalles, productosLote, marcasTexto, zonasTexto }) => {
      const gAnulada = estaAnulado(g)
      html += `
        <tr${gAnulada ? ` style="${ESTILO_FILA_ANULADA}"` : ''}>
          <td data-col-tabla="guias-ingreso" data-col="sel" style="text-decoration:none; opacity:1;${colStyle('guias-ingreso','sel') ? ' display:none;' : ''}">${gAnulada
            ? `<input type="checkbox" disabled title="Guía anulada: su stock ya fue retirado">`
            : `<input type="checkbox" class="gi-sel" value="${g.id}" onchange="window.actualizarBotonEliminarGuias()">`}</td>
          <td data-col-tabla="guias-ingreso" data-col="numero_guia"${colStyle('guias-ingreso','numero_guia')}><strong>${g.numero_guia}</strong></td>
          <td data-col-tabla="guias-ingreso" data-col="fecha"${colStyle('guias-ingreso','fecha')}>${g.fecha_guia || '-'}</td>
          <td data-col-tabla="guias-ingreso" data-col="referencia"${colStyle('guias-ingreso','referencia')}>${compra?.referencia || `Compra #${g.compra_id}`}</td>
          <td data-col-tabla="guias-ingreso" data-col="proveedor"${colStyle('guias-ingreso','proveedor')}>${compra?.proveedor_nombre || '-'}</td>
          <td data-col-tabla="guias-ingreso" data-col="num_productos" style="text-align:center;${colStyle('guias-ingreso','num_productos') ? ' display:none;' : ''}">${(detalles || []).length}</td>
          <td data-col-tabla="guias-ingreso" data-col="productos"${colStyle('guias-ingreso','productos')}><div class="clamp-lineas" title="${(productosLote || '').replace(/"/g, '&quot;')}">${productosLote}</div></td>
          <td data-col-tabla="guias-ingreso" data-col="marcas"${colStyle('guias-ingreso','marcas')}>${marcasTexto}</td>
          <td data-col-tabla="guias-ingreso" data-col="zonas"${colStyle('guias-ingreso','zonas')}>${zonasTexto}</td>
          <td data-col-tabla="guias-ingreso" data-col="observaciones"${colStyle('guias-ingreso','observaciones')}>${g.observaciones ? _escCompras(g.observaciones) : (gAnulada && g.motivo_anulacion ? `<em style="color:var(--text-secondary);">Anulado: ${_escCompras(g.motivo_anulacion)}</em>` : '-')}</td>
          <td data-col-tabla="guias-ingreso" data-col="estado"${colStyle('guias-ingreso','estado')}>${gAnulada ? badgeAnulado(g) : '<span class="badge badge-success">Emitida</span>'}</td>
          <td data-col-tabla="guias-ingreso" data-col="acciones" class="col-acciones" style="text-decoration:none; opacity:1;${colStyle('guias-ingreso','acciones') ? ' display:none;' : ''}">
            ${menuAccionesFila(gAnulada
              ? [{ label: 'Ver motivo de anulación', icono: 'ℹ️', onclick: `window.verMotivoAnulacionCompra('guia', ${g.id})` }]
              : [
                  { label: 'Ver detalle', icono: '📋', onclick: `window.verDetalleGuiaIngreso(${g.id})` },
                  { label: 'Editar cabecera', icono: '✏️', onclick: `window.editarGuia(${g.id})` },
                  { separador: true },
                  { label: 'Anular guía', icono: '🚫', onclick: `window.anularGuiaIngreso(${g.id})`, peligro: true },
                  { label: 'Eliminar', icono: '🗑️', onclick: `window.eliminarGuia(${g.id})`, peligro: true }
                ])}
          </td>
        </tr>
      `
    })
    html += '</tbody></table>'
    container.innerHTML = html
  } catch (error) {
    console.error('Error en renderGuias:', error)
    showToast('Error al cargar las guías de remisión', 'danger')
  }
}

window.filtrarGuias = async function () {
  await renderGuias()
}

// ─── Editar Guía (solo cabecera: N° guía, fecha, observaciones) ──────────────
// Las líneas (lote/marca/zona/cantidad) NO se editan aquí porque ya
// generaron stock real en Inventario (lotes + stock_ubicaciones). Para
// corregir cantidades hay que eliminar la guía (si no tiene ventas) y
// volver a registrarla.

window.editarGuia = async function (id) {
  try {
    const g = await getGuiaIngresoCompraById(id)
    if (!g) { showToast('No se encontró la guía', 'danger'); return }

    document.getElementById('egId').value = g.id
    document.getElementById('egNumeroGuia').value = g.numero_guia || ''
    document.getElementById('egFechaGuia').value = g.fecha_guia || ''
    document.getElementById('egObservaciones').value = g.observaciones || ''

    window.openModal('modal-editar-guia')
  } catch (error) {
    console.error('Error en editarGuia:', error)
    showToast('Error al abrir la guía para editar', 'danger')
  }
}

window.guardarEdicionGuia = async function () {
  try {
    const id = parseInt(document.getElementById('egId')?.value || 0)
    if (!id) { showToast('Guía inválida', 'danger'); return }

    const numeroGuia = document.getElementById('egNumeroGuia')?.value?.trim()
    const fechaGuia = document.getElementById('egFechaGuia')?.value
    const observaciones = document.getElementById('egObservaciones')?.value?.trim() || null

    if (!numeroGuia) { showToast('Ingresa el N° de Guía', 'warning'); return }
    if (!fechaGuia)  { showToast('Ingresa la fecha de la guía', 'warning'); return }

    const actualizado = await updateGuiaIngresoCompra(id, {
      numero_guia: numeroGuia,
      fecha_guia: fechaGuia,
      observaciones
    })

    if (!actualizado) { showToast('No se pudo actualizar la guía', 'danger'); return }

    showToast('Guía actualizada', 'success')
    window.closeModal('modal-editar-guia')
    await renderGuias(true)
  } catch (error) {
    console.error('Error en guardarEdicionGuia:', error)
    showToast('Error al actualizar la guía', 'danger')
  }
}

// ─── Eliminar Guía ────────────────────────────────────────────────────────────
// Al eliminar una guía se revierte el ingreso de stock que generó:
//   1) Por cada línea (detalle_guias_ingreso_compra) se verifica si el lote
//      creado ya tuvo alguna venta: se compara la cantidad ORIGINAL recibida
//      en esta guía (detalle.cantidad, inmutable) contra la cantidad ACTUAL
//      del lote (lotes.cantidad). Si actual < original, ya se vendió stock
//      de ese lote → SE BLOQUEA el borrado.
//   2) Si el lote ya no existe (se borró manualmente antes), no hay nada
//      que revertir para esa línea — se ignora, igual que en eliminarCompra.
//   3) Si todo está limpio: se borran los lotes (stock_ubicaciones se borra
//      solo por ON DELETE CASCADE) y luego la guía (detalle_guias_ingreso_
//      compra se borra solo por ON DELETE CASCADE). Importante: se borran
//      los LOTES primero, no solo la guía — lotes.guia_id es ON DELETE SET
//      NULL, así que borrar la guía sin borrar los lotes dejaría el stock
//      "huérfano" en Inventario en vez de revertirlo.
/**
 * Núcleo de la eliminación de una guía de ingreso.
 * @param {boolean} pedirConfirmacion  false en el borrado masivo (ya hubo un
 *        único confirm para todo el lote). Los bloqueos por stock ya vendido
 *        se lanzan como Error para que el masivo siga con las demás guías y
 *        reporte al final cuáles no pudo.
 */
/**
 * Calcula QUÉ habría que revertir para una guía de ingreso, sin escribir
 * nada en la base todavía. Lanza Error si algún lote/bulto de esta guía ya
 * tuvo consumo (venta, merma, etc.) — ni eliminar ni editar la guía es
 * seguro en ese caso. Reusado por _eliminarGuiaIngresoCore (borra todo) y
 * por window.guardarEdicionGuiaIngreso (revierte para reaplicar cambios).
 */
export async function _planRevertirGuiaIngreso(id) {
  const detalles = await getDetalleGuiasIngresoCompra(id)

  const vendidos = []
  const lotesABorrar = []     // lotes que quedan en 0 tras la reversión: se eliminan enteros
  const lotesADescontar = []  // lotes sin peso variable a los que esta guía sumó: se restan por aritmética
  const lotesConBultos = []   // lotes con peso variable: se resuelve borrando SUS bultos, no por resta

  for (const dg of (detalles || [])) {
    if (!dg.lote_id) continue
    const lote = await getLoteById(dg.lote_id)
    if (!lote) continue // ya no existe: nada que revertir para esta línea

    // ── Lotes con peso variable: lote_bultos es la fuente de verdad ────────
    // No se puede restar dg.cantidad a mano porque cantidad/cantidad_unidades
    // del lote se recalculan SIEMPRE desde la suma de sus bultos disponibles
    // (recalcularLoteDesdeBultos) — cualquier resta manual que no borre
    // también los bultos de esta guía queda pisada la próxima vez que algo
    // dispare ese recálculo, resucitando la cantidad "eliminada".
    if (lote.es_peso_variable) {
      const bultosLote = await getLoteBultosByLote(lote.id)
      const bultosDeEstaGuia = (bultosLote || []).filter(b => b.guia_ingreso_id === id)
      if (bultosDeEstaGuia.length === 0) continue // esta guía no aportó bultos a este lote

      const noDisponibles = bultosDeEstaGuia.filter(b => b.estado !== 'disponible')
      if (noDisponibles.length > 0) {
        const item = await getItemById(dg.item_id)
        vendidos.push(`${item?.nombre || 'Item #' + dg.item_id} (lote ${lote.numero_lote}): ${noDisponibles.length} bulto(s) de esta guía ya no está(n) disponible(s) (vendido/devuelto/merma)`)
        continue
      }

      const pesoARevertir = bultosDeEstaGuia.reduce((s, b) => s + (parseFloat(b.peso) || 0), 0)
      lotesConBultos.push({
        lote, bultosDeEstaGuia, ubicacion_id: dg.ubicacion_id, pesoARevertir,
        esTodoElLote: bultosDeEstaGuia.length === bultosLote.length
      })
      continue
    }

    // ── Lotes sin peso variable: heurística original por aritmética ────────
    const original = parseFloat(dg.cantidad) || 0
    const actual = parseFloat(lote.cantidad) || 0

    // Un lote puede haber sido CREADO por esta guía (lote.guia_id === id) o
    // ser un lote preexistente al que esta guía le sumó cantidad. En el
    // segundo caso no se puede borrar: hay que restar solo lo que aportó.
    const loCreoEstaGuia = lote.guia_id === id

    if (loCreoEstaGuia) {
      const vendido = parseFloat((original - actual).toFixed(4))
      if (vendido > 0) {
        const item = await getItemById(dg.item_id)
        vendidos.push(`${item?.nombre || 'Item #' + dg.item_id} (lote ${lote.numero_lote}): ${vendido} vendido de ${original}`)
      } else {
        lotesABorrar.push(lote.id)
      }
    } else {
      if (actual + 0.0001 < original) {
        const item = await getItemById(dg.item_id)
        vendidos.push(`${item?.nombre || 'Item #' + dg.item_id} (lote ${lote.numero_lote}): quedan ${actual} pero esta guía aportó ${original}`)
      } else {
        // dg.cantidad_unidades: unidades (cajas/bultos) que ESTA guía le
        // aportó a este lote preexistente. Antes se hardcodeaba en 0 porque
        // detalle_guias_ingreso_compra nunca guardaba este dato — por eso
        // lotes.cantidad_unidades nunca bajaba al editar/eliminar una guía
        // sobre un lote ya existente, aunque el peso (cantidad) sí bajaba
        // bien. Bug encontrado y corregido 2026-09-17.
        lotesADescontar.push({
          lote, cantidad: original, unidades: parseFloat(dg.cantidad_unidades) || 0,
          ubicacion_id: dg.ubicacion_id, item_id: dg.item_id
        })
      }
    }
  }

  if (vendidos.length > 0) {
    throw new Error(
      `ya hay ventas de esta guía (${vendidos.join(' | ')}). ` +
      `Anula/ajusta esas ventas para devolver el stock antes de editarla/eliminarla`
    )
  }

  const lotesConBultosCompletos = lotesConBultos.filter(l => l.esTodoElLote)
  const lotesConBultosParciales = lotesConBultos.filter(l => !l.esTodoElLote)
  return {
    lotesABorrar, lotesADescontar, lotesConBultos, lotesConBultosCompletos, lotesConBultosParciales,
    totalABorrar: lotesABorrar.length + lotesConBultosCompletos.length,
    totalADescontar: lotesADescontar.length + lotesConBultosParciales.length
  }
}

/**
 * Ejecuta el plan de _planRevertirGuiaIngreso: descuenta kardex/lotes/
 * stock_ubicaciones. NO borra la guía ni los lotes que quedan en 0 — eso lo
 * decide el llamador (eliminar borra todo; editar los borra para recrearlos
 * con los valores nuevos).
 */
export async function _aplicarReversionGuiaIngreso(id, plan) {
  // Kardex: se borran las filas de los lotes que se van a eliminar POR
  // COMPLETO — sin esto quedarían movimientos "fantasma" de lotes que ya no
  // existen. No se tocan lotes que solo se descuentan parcialmente: ese
  // kardex sigue siendo válido para lo que queda.
  const idsLotesABorrarCompleto = [...plan.lotesABorrar, ...plan.lotesConBultosCompletos.map(l => l.lote.id)]
  const guiaActual = await getGuiaIngresoCompraById(id)
  if (guiaActual?.compra_id && idsLotesABorrarCompleto.length > 0) {
    const kardexCompra = await getKardexByCompra(guiaActual.compra_id)
    for (const k of (kardexCompra || [])) {
      if (idsLotesABorrarCompleto.includes(k.lote_id)) {
        const okKardex = await deleteKardexMovimiento(k.id)
        if (!okKardex) {
          const motivo = ultimoErrorDelete()
          throw new Error(`No se pudo eliminar el movimiento de Kardex #${k.id}: ${motivo?.mensaje || 'motivo desconocido'}. Se detiene la reversión para no dejar el Kardex descuadrado.`)
        }
      }
    }
  }

  // Lotes sin peso variable: se resta lo que esta guía aportó, a ellos y a
  // su fila de stock_ubicaciones de la zona correspondiente. También se
  // resta cantidad_unidades (antes se ignoraba — ver comentario en
  // _planRevertirGuiaIngreso) y se deja un movimiento de Kardex "salida" de
  // corrección: sin esto, el saldo del lote bajaba en silencio y el Kardex
  // quedaba descuadrado respecto a lotes.cantidad/cantidad_unidades, sin
  // ningún rastro de por qué.
  if (plan.lotesADescontar.length > 0) {
    const vendorsZona = await getUbicacionVendors()
    const user = await getCurrentUser()
    for (const d of plan.lotesADescontar) {
      const nuevaCant = parseFloat(Math.max(0, (parseFloat(d.lote.cantidad) || 0) - d.cantidad).toFixed(4))
      const nuevaUnid = parseFloat(Math.max(0, (parseFloat(d.lote.cantidad_unidades) || 0) - d.unidades).toFixed(4))
      await updateLote(d.lote.id, { cantidad: nuevaCant, cantidad_unidades: nuevaUnid })

      if (d.ubicacion_id) {
        const filas = await getStockUbicacionesByLote(d.lote.id)
        const fila = (filas || []).find(f => f.ubicacion_id === d.ubicacion_id)
        if (fila) {
          await updateStockUbicacion(fila.id, {
            cantidad: parseFloat(Math.max(0, (parseFloat(fila.cantidad) || 0) - d.cantidad).toFixed(4)),
            cantidad_unidades: parseFloat(Math.max(0, (parseFloat(fila.cantidad_unidades) || 0) - d.unidades).toFixed(4))
          })
        }
      }

      const costoUnit = parseFloat(d.lote.costo_unitario || 0)
      await addKardexMovimiento({
        item_id: d.item_id, lote_id: d.lote.id,
        ubicacion_origen_id: d.ubicacion_id || null, ubicacion_destino_id: vendorsZona?.id || null,
        fecha: new Date().toISOString().slice(0, 10),
        tipo_movimiento: 'salida',
        concepto: `Corrección: guía de ingreso ${guiaActual?.numero_guia || '#' + id} editada/eliminada`,
        documento_referencia: guiaActual?.numero_guia || null,
        cantidad_entrada: 0, cantidad_salida: d.cantidad,
        cantidad_unidades_entrada: 0, cantidad_unidades_salida: d.unidades,
        costo_unitario: costoUnit,
        valor_entrada: 0, valor_salida: parseFloat((d.cantidad * costoUnit).toFixed(2)),
        moneda: d.lote.moneda || 'PEN', tipo_cambio: parseFloat(d.lote.tipo_cambio) || 1,
        costo_unit_original: parseFloat(d.lote.costo_unit_original ?? costoUnit),
        saldo_cantidad: nuevaCant, saldo_valor: parseFloat((nuevaCant * costoUnit).toFixed(2)),
        saldo_unidades: nuevaUnid,
        compra_id: guiaActual?.compra_id || null, created_by: user?.db_id || null
      })
    }
  }

  // Lotes con peso variable: se borran SOLO los bultos que esta guía trajo
  // y se recalcula el lote desde los que quedan (fuente de verdad real).
  // stock_ubicaciones se descuenta aparte porque, en Fase 1, sigue
  // escribiéndose en paralelo para compatibilidad con pantallas que aún no
  // leen v_stock_bultos_zona.
  for (const { lote, bultosDeEstaGuia, ubicacion_id, pesoARevertir, esTodoElLote } of plan.lotesConBultos) {
    for (const b of bultosDeEstaGuia) await deleteLoteBulto(b.id)

    if (!esTodoElLote) await recalcularLoteDesdeBultos(lote.id)
    // si esTodoElLote, el lote entero se borra en idsLotesABorrarCompleto;
    // recalcular no tiene sentido sobre un lote que va a desaparecer.

    if (ubicacion_id) {
      const filas = await getStockUbicacionesByLote(lote.id)
      const fila = (filas || []).find(f => f.ubicacion_id === ubicacion_id)
      if (fila) {
        await updateStockUbicacion(fila.id, {
          cantidad: parseFloat(Math.max(0, (parseFloat(fila.cantidad) || 0) - pesoARevertir).toFixed(4)),
          cantidad_unidades: parseFloat(Math.max(0, (parseFloat(fila.cantidad_unidades) || 0) - bultosDeEstaGuia.length).toFixed(4))
        })
      }
    }
  }
}

async function _eliminarGuiaIngresoCore(id, pedirConfirmacion = true) {
  const plan = await _planRevertirGuiaIngreso(id)

  if (pedirConfirmacion && !confirm(
    `Se eliminará la guía revirtiendo el stock ingresado:\n` +
    `  • ${plan.totalABorrar} lote(s) creados por esta guía se eliminarán.\n` +
    `  • ${plan.totalADescontar} lote(s) preexistentes solo se descontarán.\n\n¿Continuar?`
  )) return { cancelado: true }

  await _aplicarReversionGuiaIngreso(id, plan)

  // La guía se borra ANTES que los lotes. detalle_guias_ingreso_compra.lote_id
  // referencia a lotes SIN ON DELETE CASCADE: si se intentara borrar el lote
  // primero, Postgres rechaza el DELETE (23503) porque la línea de esta
  // misma guía todavía apunta a él — y como nadie revisaba el resultado de
  // deleteLote(), el error se tragaba en silencio: la guía quedaba
  // eliminada pero el lote sobrevivía intacto con la cantidad "revertida".
  const ok = await deleteGuiaIngresoCompra(id) // cascada: borra detalle_guias_ingreso_compra
  if (!ok) {
    const motivo = ultimoErrorDelete()
    throw new Error(motivo?.mensaje || 'no se pudo eliminar')
  }

  const idsLotesABorrarCompleto = [...plan.lotesABorrar, ...plan.lotesConBultosCompletos.map(l => l.lote.id)]
  for (const loteId of idsLotesABorrarCompleto) {
    const borrado = await deleteLote(loteId) // stock_ubicaciones y lote_bultos de ese lote se borran solos (ON DELETE CASCADE)
    if (!borrado) {
      const motivo = ultimoErrorDelete()
      console.error(`No se pudo eliminar el lote ${loteId} tras borrar la guía:`, motivo)
      showToast(
        `La guía se eliminó, pero el lote #${loteId} no se pudo borrar (${motivo?.mensaje || 'motivo desconocido'}). Revísalo manualmente en Inventario.`,
        'warning', 8000
      )
    }
  }

  return { cancelado: false, lotesBorrados: plan.totalABorrar, lotesDescontados: plan.totalADescontar }
}

window.eliminarGuia = async function (id) {
  try {
    const r = await _eliminarGuiaIngresoCore(id, true)
    if (r?.cancelado) return

    _invalidarCacheCompras()
    showToast('Guía eliminada: stock revertido en Inventario', 'success')
    await _cargarComprasConGuia(true)
    await renderGuias(true)
    await renderCompras(true)
  } catch (error) {
    console.error('Error en eliminarGuia:', error)
    showToast('No se pudo eliminar la guía: ' + error.message, 'danger', 7000)
  }
}

// ── Selección múltiple ──────────────────────────────────────────────────────
// Las guías anuladas no entran: su stock ya se retiró al anularlas, y volver
// a revertirlo dejaría el inventario en negativo.

window.toggleSeleccionTodasGuias = function (checked) {
  document.querySelectorAll('.gi-sel:not(:disabled)').forEach(cb => { cb.checked = checked })
  window.actualizarBotonEliminarGuias()
}

window.actualizarBotonEliminarGuias = function () {
  const n = document.querySelectorAll('.gi-sel:checked').length
  const btn = document.getElementById('btnEliminarGuiasSel')
  if (!btn) return
  btn.style.display = n > 0 ? 'inline-flex' : 'none'
  btn.textContent = `🗑 Eliminar seleccionadas (${n})`
}

window.eliminarGuiasSeleccionadas = async function () {
  const ids = Array.from(document.querySelectorAll('.gi-sel:checked')).map(cb => parseInt(cb.value))
  if (ids.length === 0) { showToast('Selecciona al menos una guía', 'warning'); return }

  if (!confirm(
    `Se eliminarán ${ids.length} guía(s) de ingreso y se revertirá el stock que agregaron a Inventario.\n\n` +
    `Las guías cuyo stock ya se vendió NO se eliminarán y se te informará cuáles.\n\n` +
    `Esta acción no se puede deshacer. ¿Continuar?`
  )) return

  const btn = document.getElementById('btnEliminarGuiasSel')
  if (btn) { btn.disabled = true; btn.textContent = 'Eliminando...' }

  // El número de guía se resuelve ANTES de borrarla: después ya no existe y
  // el mensaje de error diría solo "#id", que no le sirve a nadie.
  const guias = await getGuiasIngresoCompra()
  const numeroPorId = new Map((guias || []).map(g => [g.id, g.numero_guia]))

  let ok = 0
  const errores = []
  for (const id of ids) {
    try {
      const r = await _eliminarGuiaIngresoCore(id, false)
      if (!r?.cancelado) ok++
    } catch (e) {
      console.error(`Error eliminando guía ${id}:`, e)
      errores.push(`${numeroPorId.get(id) || '#' + id}: ${e.message}`)
    }
  }

  if (ok > 0) showToast(`${ok} guía(s) eliminada(s): stock revertido en Inventario`, 'success')
  if (errores.length > 0) showToast(`${errores.length} no se pudo(eron) eliminar → ${errores.join(' | ')}`, 'danger', 10000)

  if (btn) { btn.disabled = false }
  _invalidarCacheCompras()
  await _cargarComprasConGuia(true)
  await renderGuias(true)
  await renderCompras(true)
}
