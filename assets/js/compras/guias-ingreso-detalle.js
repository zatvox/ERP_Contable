// ============================================================================
// compras/guias-ingreso-detalle.js — parte de compras.js (reorganizado 2026-09-25, sin cambios de lógica)
// Mapa completo de funciones: Claude outputs/glosario_funciones_erp.md
// ============================================================================
import { S } from './state.js'
import { getCurrentUser } from '../auth-supabase.js'
import { getCompraById, getCompraDetalles, getLoteById, getLotes, deleteLote, getItems, getMarcas, getGuiaIngresoCompraById, updateGuiaIngresoCompra, getDetalleGuiasIngresoCompra, deleteDetalleGuiaIngresoCompra, getAlmacenes, getUbicaciones, ultimoErrorDelete, generarAsientoGuiaRemision, getLoteBultosByLote } from '../supabase-data.js'
import { ASIENTOS_AUTO_COMPRAS_ACTIVO } from '../config-asientos-auto.js'
import { showToast, formatQty } from '../helpers.js'
import { _invalidarCacheCompras } from './anulacion.js'
import { _escCompras } from './buscadores.js'
import { renderCompras } from './compras-lista.js'
import { _aplicarReversionGuiaIngreso, _cargarComprasConGuia, _planRevertirGuiaIngreso, renderGuias } from './guias-ingreso-lista.js'
import { _aplicarRecepcionesAGuiaIngreso, _esRecepcionVaciaGuia, _getCantidadesRecibidasPorDetalle, _renderTablaDetalleGuia, _sincronizarRecepcionesGuiaDesdeDOM } from './guias-ingreso-nueva.js'

// ── Editar líneas de una Guía de Ingreso (cantidad/lote/marca/zona) ────────
// Reusa TODO el formulario/tabla de "Nueva Guía" (modal-nueva-guia,
// _guiaLineas, _renderTablaDetalleGuia, _sincronizarRecepcionesGuiaDesdeDOM)
// en un "modo edición": se precarga con lo que esta guía ya recibió, el
// usuario corrige cantidad/lote/marca/partida/zona (incluso packing list de
// bultos si es peso variable), y al guardar se hace REVERTIR + REAPLICAR
// sobre la MISMA guía — igual patrón que "Editar Guía de Despacho" en
// Ventas. _planRevertirGuiaIngreso ya bloquea todo el intento si algún lote
// de esta guía tuvo consumo (venta/merma) desde que se recibió: no se puede
// editar con seguridad en ese caso.
// ── Ver Detalle de Guía de Ingreso (solo lectura, SIEMPRE disponible) ──────
// Antes, la única forma de ver el detalle lote-por-lote de una guía era
// "Editar líneas", que bloquea de entrada si algún lote ya tuvo consumo
// (venta/merma) — con eso, una guía ya vendida no se podía ni siquiera
// VER. Este modal separa "ver" de "editar": siempre se puede abrir, y su
// botón Editar delega a window.editarGuiaIngreso (que sigue bloqueando
// ahí, correctamente, si corresponde — ese candado nunca fue el bug).
function _asegurarModalDetalleGuiaIngreso() {
  if (document.getElementById('modal-detalle-guia-ingreso')) return
  const div = document.createElement('div')
  div.id = 'modal-detalle-guia-ingreso'
  div.className = 'modal'
  div.innerHTML = `
    <div class="modal-content" id="dgi-content" style="width:min(94vw, 980px); max-width:min(94vw, 980px); max-height:90vh; overflow-y:auto;">
      <div class="modal-header">
        <h3 class="modal-title" id="dgi-titulo-modal">Detalle de Guía de Ingreso</h3>
        <button class="modal-close" onclick="window.closeModal('modal-detalle-guia-ingreso')">&times;</button>
      </div>
      <div style="padding:20px; display:flex; flex-direction:column; gap:14px;">
        <div id="dgi-cabecera" style="padding:12px 14px; background:var(--bg-secondary); border-radius:var(--radius-md); border-left:3px solid var(--color-info); font-size:0.88rem; line-height:1.6;"></div>
        <div id="dgi-detalle"></div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" onclick="window.closeModal('modal-detalle-guia-ingreso')">Cerrar</button>
        <button class="btn btn-primary" id="dgiBtnEditar">✏️ Editar líneas</button>
      </div>
    </div>`
  document.body.appendChild(div)
}

window.verDetalleGuiaIngreso = async function (id) {
  try {
    const guia = await getGuiaIngresoCompraById(id)
    if (!guia) { showToast('No se encontró la guía', 'danger'); return }

    const [compra, detalles, itemsList, marcas, zonas, almacenes] = await Promise.all([
      getCompraById(guia.compra_id),
      getDetalleGuiasIngresoCompra(id),
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

    let detalleHtml
    if (!detalles || detalles.length === 0) {
      detalleHtml = `<div style="padding:14px; border-radius:var(--radius-md); background:var(--bg-secondary); font-size:0.85rem; color:var(--text-secondary);">
        Esta guía no tiene líneas registradas.
      </div>`
    } else {
      const filas = detalles.map(d => {
        const item = itemMap[d.item_id]
        const marca = marcaMap[d.marca_id]?.nombre || '-'
        const z = zonaMap[d.ubicacion_id]
        const zona = z ? `${almacenMap[z.almacen_id]?.nombre || '?'} — ${z.nombre}` : '-'
        return `<tr style="border-top:1px solid var(--border-color);">
          <td style="padding:8px 10px;">${item ? `${item.sku ? '(' + item.sku + ') ' : ''}${item.nombre || ''}` : `Item #${d.item_id}`}</td>
          <td style="padding:8px 10px;">${d.numero_lote || '-'}</td>
          <td style="padding:8px 10px;">${marca}</td>
          <td style="padding:8px 10px;">${d.codigo_partida || '-'}</td>
          <td style="padding:8px 10px;">${zona}</td>
          <td style="padding:8px 10px; text-align:right;">${formatQty(parseFloat(d.cantidad) || 0)} ${item?.unidad_medida || ''}</td>
        </tr>`
      }).join('')
      detalleHtml = `
        <div style="border:1px solid var(--border-color); border-radius:var(--radius-md); overflow:hidden; overflow-x:auto;">
          <table style="width:100%; border-collapse:collapse; margin:0;">
            <thead><tr style="background:var(--bg-secondary);">
              <th style="text-align:left; padding:8px 10px; font-size:0.78rem;">Producto</th>
              <th style="text-align:left; padding:8px 10px; font-size:0.78rem;">Lote</th>
              <th style="text-align:left; padding:8px 10px; font-size:0.78rem;">Marca</th>
              <th style="text-align:left; padding:8px 10px; font-size:0.78rem;">Partida</th>
              <th style="text-align:left; padding:8px 10px; font-size:0.78rem;">Almacén / Zona</th>
              <th style="text-align:right; padding:8px 10px; font-size:0.78rem;">Cantidad</th>
            </tr></thead>
            <tbody>${filas}</tbody>
          </table>
        </div>`
    }

    _asegurarModalDetalleGuiaIngreso()
    document.getElementById('dgi-titulo-modal').textContent = `Detalle de Guía ${guia.numero_guia || ''}`
    document.getElementById('dgi-cabecera').innerHTML = `
      <div style="font-size:0.72rem; text-transform:uppercase; letter-spacing:.4px; color:var(--text-secondary);">Guía de Ingreso</div>
      <div style="font-weight:600; font-size:1.05rem; margin-top:2px;">${guia.numero_guia || ''} — ${guia.fecha_guia || ''}</div>
      <div style="font-size:0.85rem; color:var(--text-secondary); margin-top:2px;">
        ${compra?.proveedor_nombre || '-'} · Compra: ${compra?.referencia || 'Compra #' + guia.compra_id}
        ${guia.observaciones ? ` · ${_escCompras(guia.observaciones)}` : ''}
      </div>`
    document.getElementById('dgi-detalle').innerHTML = detalleHtml

    const btnEditar = document.getElementById('dgiBtnEditar')
    if (btnEditar) btnEditar.onclick = () => { window.closeModal('modal-detalle-guia-ingreso'); window.editarGuiaIngreso(id) }

    window.openModal('modal-detalle-guia-ingreso')
  } catch (e) {
    console.error('verDetalleGuiaIngreso:', e)
    showToast('Error al cargar el detalle de la guía: ' + e.message, 'danger')
  }
}

window.editarGuiaIngreso = async function (id) {
  try {
    // Verificación temprana: si algo de esta guía ya se vendió, no tiene
    // caso abrir el formulario de edición — se bloquea antes de armarlo.
    // (Ver Detalle, arriba, NUNCA pasa por este candado — solo Editar.)
    await _planRevertirGuiaIngreso(id)

    const guia = await getGuiaIngresoCompraById(id)
    if (!guia) { showToast('No se encontró la guía', 'danger'); return }

    const [compra, detallesGuia, todosDetallesCompra, marcas, itemsList, almacenes, zonas] = await Promise.all([
      getCompraById(guia.compra_id),
      getDetalleGuiasIngresoCompra(id),
      getCompraDetalles(guia.compra_id),
      getMarcas(),
      getItems(),
      getAlmacenes(),
      getUbicaciones()
    ])

    if (!detallesGuia || detallesGuia.length === 0) {
      showToast('Esta guía no tiene líneas registradas para editar', 'warning')
      return
    }

    const itemsMap = {}
    for (const it of (itemsList || [])) itemsMap[it.id] = it
    const almacenesMap = {}
    for (const a of (almacenes || [])) almacenesMap[a.id] = a
    const detalleCompraMap = {}
    for (const d of (todosDetallesCompra || [])) detalleCompraMap[d.id] = d

    S._guiaMarcasCache = marcas || []
    S._guiaZonasCache = (zonas || [])
      .filter(z => !almacenesMap[z.almacen_id]?.es_virtual)
      .map(z => ({
        id: z.id, nombre: z.nombre, almacen_id: z.almacen_id,
        almacenNombre: almacenesMap[z.almacen_id]?.nombre || `Almacén #${z.almacen_id}`
      }))
    S._guiaZonasNombre = {}
    for (const z of S._guiaZonasCache) S._guiaZonasNombre[z.id] = `${z.almacenNombre} — ${z.nombre}`

    S._guiaCompraActual = compra
    const lotesExistentes = await getLotes()
    S._guiaLotesPorItem = {}
    for (const lo of (lotesExistentes || [])) {
      if (!lo.item_id) continue
      ;(S._guiaLotesPorItem[lo.item_id] = S._guiaLotesPorItem[lo.item_id] || []).push(lo)
    }
    Object.values(S._guiaLotesPorItem).forEach(arr =>
      arr.sort((a, b) => (b.fecha_ingreso || '').localeCompare(a.fecha_ingreso || '') || b.id - a.id))

    // Lo recibido en OTRAS guías (no anuladas) de esta misma compra: sirve
    // de referencia de "pendiente" — la propia contribución de ESTA guía no
    // cuenta como "ya recibido" porque es justo lo que se está reeditando.
    const recibidoTodas = await _getCantidadesRecibidasPorDetalle()
    const recibidoEnEstaGuia = new Map()
    for (const dg of detallesGuia) {
      if (!dg.detalle_compra_id) continue
      recibidoEnEstaGuia.set(dg.detalle_compra_id, (recibidoEnEstaGuia.get(dg.detalle_compra_id) || 0) + (parseFloat(dg.cantidad) || 0))
    }

    // Agrupa las líneas de esta guía por detalle_compra_id (una línea de
    // compra pudo recibirse en 1 o más lotes/zonas dentro de esta MISMA
    // guía) y arma cada recepción con los valores actuales, editables.
    const porDetalleCompra = new Map()
    for (const dg of detallesGuia) {
      if (!porDetalleCompra.has(dg.detalle_compra_id)) porDetalleCompra.set(dg.detalle_compra_id, [])
      porDetalleCompra.get(dg.detalle_compra_id).push(dg)
    }

    S._guiaLineas = []
    for (const [detalleCompraId, dgs] of porDetalleCompra) {
      const d = detalleCompraMap[detalleCompraId]
      if (!d) continue // línea de compra borrada: no hay nada que editar aquí

      const comprado = parseFloat(d.cantidad) || 0
      const recibidoOtras = parseFloat(((recibidoTodas.get(detalleCompraId) || 0) - (recibidoEnEstaGuia.get(detalleCompraId) || 0)).toFixed(4))
      const yaRecibido = Math.max(0, recibidoOtras)

      const recepciones = []
      for (const dg of dgs) {
        const lote = dg.lote_id ? await getLoteById(dg.lote_id) : null
        const esPesoVariable = !!lote?.es_peso_variable
        let bultos = []
        if (esPesoVariable && lote) {
          const bultosLote = await getLoteBultosByLote(lote.id)
          bultos = (bultosLote || [])
            .filter(b => b.guia_ingreso_id === id)
            .map(b => ({ peso: parseFloat(b.peso) || null }))
          if (bultos.length === 0) bultos = [{ peso: null }]
        }
        recepciones.push({
          cantidad: parseFloat(dg.cantidad) || 0,
          numero_lote: dg.numero_lote || '',
          marca_id: dg.marca_id || null,
          codigo_partida: dg.codigo_partida || '',
          ubicacion_id: dg.ubicacion_id || '',
          cantidad_unidades: lote?.cantidad_unidades || null,
          es_peso_variable: esPesoVariable,
          bultos
        })
      }

      S._guiaLineas.push({
        detalle_compra_id: detalleCompraId,
        item_id:            d.item_id,
        nombre:              itemsMap[d.item_id]?.nombre || `Item #${d.item_id}`,
        sku:                 itemsMap[d.item_id]?.sku || '',
        unidad_medida:       d.unidad_medida,
        cantidad_comprada:   comprado,
        ya_recibido:         yaRecibido,
        unidades_compradas: parseFloat(d.unidades) || null,
        precio_unitario:     parseFloat(d.precio_unitario) || 0,
        marca_default_id:    itemsMap[d.item_id]?.marca_id || null,
        recepciones
      })
    }

    // Prepara el modal en modo edición (mismo formulario de "Nueva Guía").
    const form = document.getElementById('formNuevaGuia')
    if (form) { /* no .reset(): se prellena a mano abajo */ }
    document.getElementById('ngNumeroGuia').value = guia.numero_guia || ''
    document.getElementById('ngFechaGuia').value = guia.fecha_guia || ''
    document.getElementById('ngObservaciones').value = guia.observaciones || ''

    const selCompra = document.getElementById('ngCompra')
    if (selCompra) {
      selCompra.innerHTML = `<option value="${compra?.id}" selected>${compra?.referencia || 'Compra #' + compra?.id} — ${compra?.proveedor_nombre || ''}</option>`
      selCompra.disabled = true
    }
    document.getElementById('ngInfoCompra').style.display = 'block'
    document.getElementById('ngInfoCompra').innerHTML = `
      <strong>Proveedor:</strong> ${compra?.proveedor_nombre || '-'} (${compra?.proveedor_ruc || '-'}) &nbsp;|&nbsp;
      <strong>Comprobante:</strong> ${compra?.serie ? compra.serie + '-' + compra.numero : (compra?.numero || '-')} &nbsp;|&nbsp;
      <strong>Fecha compra:</strong> ${compra?.fecha_emision || '-'}
    `

    const titulo = document.getElementById('ng-titulo-modal')
    if (titulo) titulo.textContent = `Editar Guía ${guia.numero_guia || ''}`
    const aviso = document.getElementById('ng-edicion-aviso')
    if (aviso) {
      aviso.style.display = 'block'
      aviso.textContent = '⚠ Editando una guía ya procesada: al guardar se revierte el stock/kardex que generó y se vuelve a aplicar con los valores corregidos. Bloqueado si algún lote de esta guía ya tuvo ventas.'
    }
    const btnGuardar = document.getElementById('btnGuardarGuiaIngresoCompra')
    if (btnGuardar) btnGuardar.textContent = 'Guardar Cambios (revierte y reaplica stock)'

    S._guiaIngresoEditId = id

    _renderTablaDetalleGuia()
    window.openModal('modal-nueva-guia')
  } catch (error) {
    console.error('Error en editarGuiaIngreso:', error)
    showToast('No se puede editar esta guía: ' + error.message, 'danger', 7000)
  }
}

/**
 * Guarda la edición de líneas de una guía de ingreso ya existente:
 * revierte el stock/kardex/lotes que generó (mismo plan que eliminarla),
 * borra sus líneas viejas y las reaplica con los valores corregidos sobre
 * el MISMO id de guía. Se vuelve a calcular el plan de reversión justo
 * antes de escribir, por si algo cambió desde que se abrió el modal.
 */
export async function _guardarEdicionGuiaIngreso() {
  const btn = document.getElementById('btnGuardarGuiaIngresoCompra')
  if (btn?.disabled) return
  if (btn) { btn.disabled = true; btn.textContent = 'Guardando...' }
  try {
    const id = S._guiaIngresoEditId
    if (!id) { showToast('No hay ninguna guía en edición', 'danger'); return }

    const user = await getCurrentUser()
    if (!user) { showToast('Usuario no autenticado', 'danger'); return }

    const numeroGuia = document.getElementById('ngNumeroGuia')?.value?.trim()
    const fechaGuia = document.getElementById('ngFechaGuia')?.value
    const observaciones = document.getElementById('ngObservaciones')?.value?.trim() || null

    if (!numeroGuia) { showToast('Ingresa el N° de Guía', 'warning'); return }
    if (!fechaGuia)  { showToast('Ingresa la fecha de la guía', 'warning'); return }
    if (!S._guiaLineas || S._guiaLineas.length === 0) { showToast('No hay líneas para guardar', 'warning'); return }

    _sincronizarRecepcionesGuiaDesdeDOM()

    const guiaOriginal = await getGuiaIngresoCompraById(id)
    if (!guiaOriginal) { showToast('La guía ya no existe', 'danger'); return }
    const compraId = guiaOriginal.compra_id
    const compra = await getCompraById(compraId)

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
        // Ver misma validación (y su motivo) en window.guardarGuiaIngresoCompra.
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
          codigoPartida:      (r.codigo_partida || '').trim() || null,
          ubicacionId:        r.ubicacion_id,
          esPesoVariable:     !!r.es_peso_variable,
          bultos:             r.es_peso_variable ? (r.bultos || []) : null,
          loteExistenteId:    null
        })
      }
    }

    if (recepcionesValidadas.length === 0) {
      showToast('Ingresa la cantidad recibida de al menos un producto', 'warning')
      return
    }

    // Re-verificación justo antes de escribir: si algo cambió desde que se
    // abrió el modal (ej. otra pestaña vendió stock de este mismo lote),
    // se bloquea recién aquí en vez de dejar el revertir a medias.
    const plan = await _planRevertirGuiaIngreso(id)

    // ── Punto sin retorno: a partir de aquí se escribe en la base ──────────
    await _aplicarReversionGuiaIngreso(id, plan)

    // Líneas viejas de esta guía: se borran ANTES de intentar borrar los
    // lotes que quedaron en 0. Igual que en _eliminarGuiaIngresoCore:
    // detalle_guias_ingreso_compra.lote_id no tiene ON DELETE CASCADE, así
    // que si se intenta borrar el lote mientras esta misma guía todavía lo
    // referencia, Postgres rechaza el DELETE (23503) — y como antes nadie
    // revisaba el resultado con más que un console.error, el lote "fantasma"
    // sobrevivía con su cantidad original, sin kardex que lo respalde, y
    // seguía apareciendo en los filtros de lote de Inventario (bug real,
    // encontrado 2026-09-16 con el lote TT01-2368 de HILADO POLYESTER
    // 75D/72F SIM tras corregirlo a SD60729). A diferencia de eliminarGuia,
    // aquí NO se borra la guía — sigue siendo el mismo id, mismo historial
    // de auditoría — solo sus líneas se reemplazan por las reaplicadas abajo.
    const detallesViejos = await getDetalleGuiasIngresoCompra(id)
    for (const dv of (detallesViejos || [])) await deleteDetalleGuiaIngresoCompra(dv.id)

    const idsLotesABorrarCompleto = [...plan.lotesABorrar, ...plan.lotesConBultosCompletos.map(l => l.lote.id)]
    const lotesNoBorrados = []
    for (const loteId of idsLotesABorrarCompleto) {
      const borrado = await deleteLote(loteId) // stock_ubicaciones y lote_bultos de ese lote se borran solos (ON DELETE CASCADE)
      if (!borrado) {
        const motivo = ultimoErrorDelete()
        console.error(`No se pudo eliminar el lote ${loteId} al editar la guía ${id}:`, motivo)
        lotesNoBorrados.push(loteId)
      }
    }
    // Antes esto solo avisaba con un toast y SEGUÍA adelante reaplicando
    // las líneas nuevas — si el lote que no se pudo borrar comparte N° de
    // Lote + compra con la línea que se está reaplicando, el intento de
    // crear un lote nuevo choca contra el índice único (item_id, numero_lote,
    // compra_id) y falla en silencio (insert() devuelve null sin lanzar
    // excepción), dejando la línea de la guía guardada SIN lote_id — el bug
    // confirmado 2026-09-22 en la guía T003-0003689 (lote 193 no se pudo
    // borrar, quedó "fantasma", y la reaplicación generó una línea huérfana).
    // Se detiene aquí: mejor un error claro que datos inconsistentes.
    if (lotesNoBorrados.length > 0) {
      throw new Error(
        `no se pudo revertir el/los lote(s) #${lotesNoBorrados.join(', #')} (quedaron con su cantidad original, sin kardex). ` +
        `No se guardó ningún cambio en esta guía. Revisa esos lotes en Inventario — probablemente alguna otra tabla todavía los referencia — antes de reintentar la edición.`
      )
    }

    const actualizadaCabecera = await updateGuiaIngresoCompra(id, {
      numero_guia: numeroGuia,
      fecha_guia: fechaGuia,
      observaciones
    })
    if (!actualizadaCabecera) { showToast('No se pudo actualizar la cabecera de la guía', 'danger'); return }

    const guia = { id, compra_id: compraId }
    const totalValorGuia = await _aplicarRecepcionesAGuiaIngreso(guia, compra, compraId, recepcionesValidadas, user, fechaGuia, numeroGuia)

    if (ASIENTOS_AUTO_COMPRAS_ACTIVO && totalValorGuia > 0.01) {
      try {
        await generarAsientoGuiaRemision({
          monto: totalValorGuia,
          documento_referencia: numeroGuia,
          descripcion: `Guía de Remisión - Edición (${numeroGuia})`,
          contact_id: compra?.contact_id || null,
          fecha: fechaGuia,
          userId: user?.db_id
        })
      } catch (errorAsiento) {
        console.error('Error generando asiento tras editar guía de ingreso:', errorAsiento)
        showToast(errorAsiento.message || 'Guía actualizada, pero no se pudo generar el asiento de valuación de inventario', 'warning')
      }
    }

    showToast('Guía actualizada: stock/kardex revertido y reaplicado', 'success')
    S._guiaIngresoEditId = null
    window.closeModal('modal-nueva-guia')
    S._guiaLineas = []
    _invalidarCacheCompras()
    await _cargarComprasConGuia(true)
    await renderGuias(true)
    await renderCompras(true)
  } catch (error) {
    console.error('Error en _guardarEdicionGuiaIngreso:', error)
    showToast('Error al guardar la edición: ' + error.message, 'danger', 7000)
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = S._guiaIngresoEditId ? 'Guardar Cambios (revierte y reaplica stock)' : 'Guardar Guía (ingresa stock)' }
  }
}
