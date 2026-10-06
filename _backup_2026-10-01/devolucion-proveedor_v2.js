// ============================================================================
// compras/devolucion-proveedor.js — parte de compras.js (reorganizado 2026-09-25, sin cambios de lógica)
// Mapa completo de funciones: Claude outputs/glosario_funciones_erp.md
// ============================================================================
import { getCurrentUser } from '../auth-supabase.js'
import { getCompras, getCompraById, updateCompra, getLoteById, updateLote, getItemById, getUbicaciones, getUbicacionVendors, addKardexMovimiento, getKardexByCompra, deleteKardexMovimiento, ultimoErrorDelete, updateStockUbicacion, getStockUbicacionesByLote, recalcularLoteDesdeBultos, getLoteBultosByLote, updateLoteBulto, revertirBultosDeDetalleGuiaDevolucion, getLoteBultosPorDetalleGuiaDevolucion, getNotaCreditoCompraDetalleByNota, getNotaCreditoCompraDetalleByCompraOrigen, getGuiasDevolucionCompra, getGuiaDevolucionCompraById, addGuiaDevolucionCompra, updateGuiaDevolucionCompra, deleteGuiaDevolucionCompra, getDetalleGuiasDevolucionCompra, getDetalleGuiasDevolucionCompraByNotaDetalle, getTodosDetalleGuiasDevolucionCompra, addDetalleGuiaDevolucionCompra } from '../supabase-data.js'
import { showToast } from '../helpers.js'
import { getSerie, siguienteNumeroGuia, registrarUsoGuia } from '../series.js'
import { menuAccionesFila } from '../main.js'
import { estaAnulado } from '../anulacion.js'
import { TIPO_NC } from '../notas.js'
import { _invalidarCacheCompras } from './anulacion.js'
import { renderCompras } from './compras-lista.js'
import { renderGuias } from './guias-ingreso-lista.js'

// ============================================================================
// GUÍA DE DEVOLUCIÓN A PROVEEDOR — segundo paso del flujo de devolución.
// ============================================================================
// La NC (arriba) solo DECLARA qué se debe devolver — no toca stock. Esta guía
// es la que de verdad lo saca: descuenta lotes.cantidad, marca bultos de peso
// variable como devuelto_proveedor, y registra Kardex salida hacia la zona
// virtual Partners/Vendors (espejo exacto de la entrada de Compras). Ver
// 53_devolucion_compra.sql y notas de diseño al inicio de _abrirNotaCompra.

/** Recalcula compras.estado_devolucion de una NC comparando lo declarado (nota_credito_compra_detalle) contra lo ya cubierto por guías de devolución. */
async function _recalcularEstadoDevolucionNota(notaCompraId) {
  const detalleNota = await getNotaCreditoCompraDetalleByNota(notaCompraId)
  if (!detalleNota || detalleNota.length === 0) return
  const totalDeclarado = detalleNota.reduce((s, d) => s + (parseFloat(d.cantidad) || 0), 0)

  const todasLasGuiasDetalle = await getTodosDetalleGuiasDevolucionCompra()
  const idsDetalleNota = new Set(detalleNota.map(d => d.id))
  const totalDevuelto = (todasLasGuiasDetalle || [])
    .filter(dg => idsDetalleNota.has(dg.nota_credito_compra_detalle_id))
    .reduce((s, dg) => s + (parseFloat(dg.cantidad) || 0), 0)

  let estado = 'pendiente'
  if (totalDevuelto >= totalDeclarado - 0.0001) estado = 'completa'
  else if (totalDevuelto > 0.0001) estado = 'parcial'

  await updateCompra(notaCompraId, { estado_devolucion: estado })
}

// Ocultar/mostrar el contenido de la card "Devoluciones a Proveedor
// pendientes" (botón de esquina en el header). Estado persistido en
// localStorage para que quede como el usuario lo dejó entre sesiones —
// mismo criterio que colVisibles_* en col-menu.js.
const _LS_DEVOLUCIONES_COLAPSADA = 'cardColapsada_devolucionesPendientes'

function _aplicarEstadoToggleDevolucionesPendientes(colapsada) {
  const body = document.getElementById('devolucionesPendientesBody')
  const btn = document.getElementById('btnToggleDevolucionesPendientes')
  if (body) body.style.display = colapsada ? 'none' : ''
  if (btn) {
    btn.textContent = colapsada ? '▸' : '▾'
    btn.title = colapsada ? 'Mostrar esta sección' : 'Ocultar esta sección'
  }
}

window._toggleDevolucionesPendientes = function () {
  const colapsadaAhora = document.getElementById('devolucionesPendientesBody')?.style.display === 'none'
  const nuevoEstado = !colapsadaAhora
  try { localStorage.setItem(_LS_DEVOLUCIONES_COLAPSADA, nuevoEstado ? '1' : '0') } catch {}
  _aplicarEstadoToggleDevolucionesPendientes(nuevoEstado)
}

// ── Pantalla "Devoluciones pendientes" (dentro del tab Guía de Remisión) ───
export async function renderDevolucionesPendientes(forzar = false) {
  const card = document.getElementById('card-devoluciones-pendientes')
  const container = document.getElementById('tabla-devoluciones-pendientes')
  if (!card || !container) return

  const contEmitidas = document.getElementById('tabla-guias-devolucion-emitidas')

  // La tarjeta siempre se muestra (no se oculta) — lista TODAS las NC de
  // devolución (motivo 06/07), sin importar su estado_devolucion. Si no hay
  // ninguna, se muestra un mensaje vacío pero la tarjeta se queda visible.
  card.style.display = 'block'

  // El botón de colapsar/expandir vive en HTML estático (no se repinta con
  // innerHTML), así que su estado inicial se aplica una sola vez por carga
  // de página, leyendo lo último guardado en localStorage.
  const btnToggle = document.getElementById('btnToggleDevolucionesPendientes')
  if (btnToggle && !btnToggle.dataset.init) {
    btnToggle.dataset.init = '1'
    let colapsada = false
    try { colapsada = localStorage.getItem(_LS_DEVOLUCIONES_COLAPSADA) === '1' } catch {}
    _aplicarEstadoToggleDevolucionesPendientes(colapsada)
  }

  const [todas, guiasEmitidas] = await Promise.all([getCompras(forzar), getGuiasDevolucionCompra(forzar)])
  const notasDevolucion = (todas || []).filter(c =>
    String(c.tipo_comprobante) === TIPO_NC && !!c.estado_devolucion && !estaAnulado(c)
  )

  if (notasDevolucion.length === 0) {
    container.innerHTML = '<p style="text-align:center; color:var(--text-secondary); padding:16px;">Aún no hay Notas de Crédito con devolución de mercadería (motivo 06/07).</p>'
  } else {
    const filas = await Promise.all(notasDevolucion.map(async nota => {
      const detalleNota = await getNotaCreditoCompraDetalleByNota(nota.id)
      const totalDeclarado = (detalleNota || []).reduce((s, d) => s + (parseFloat(d.cantidad) || 0), 0)
      const compraOrigen = nota.compra_referencia_id ? await getCompraById(nota.compra_referencia_id) : null
      return { nota, compraOrigen, itemsCount: (detalleNota || []).length, totalDeclarado }
    }))
    filas.sort((a, b) => b.nota.id - a.nota.id)

    const ESTADO_LABEL = { pendiente: 'Pendiente', parcial: 'Parcial', completa: 'Completo' }
    const ESTADO_BADGE = { pendiente: 'badge-info', parcial: 'badge-warning', completa: 'badge-success' }

    container.innerHTML = `
      <table>
        <thead>
          <tr>
            <th>Nota de Crédito</th><th>Compra origen</th><th>Proveedor</th>
            <th>Ítems declarados</th><th>Estado</th><th>Acciones</th>
          </tr>
        </thead>
        <tbody>
          ${filas.map(({ nota, compraOrigen, itemsCount, totalDeclarado }) => `
            <tr>
              <td><strong>${nota.serie || ''}-${nota.numero || ''}</strong></td>
              <td>${compraOrigen ? (compraOrigen.referencia || `Compra #${compraOrigen.id}`) : '-'}</td>
              <td>${nota.proveedor_nombre || '-'}</td>
              <td>${itemsCount} línea(s) — ${totalDeclarado.toLocaleString('en-US', { maximumFractionDigits: 2 })}</td>
              <td><span class="badge ${ESTADO_BADGE[nota.estado_devolucion] || 'badge-secondary'}">${ESTADO_LABEL[nota.estado_devolucion] || nota.estado_devolucion}</span></td>
              <td>${nota.estado_devolucion === 'completa'
                ? '<span style="color:var(--text-secondary); font-size:0.82rem;">Ya cubierta</span>'
                : `<button class="btn btn-primary btn-small" onclick="window.abrirModalGuiaDevolucion(${nota.id})">Emitir Guía de Devolución</button>`}</td>
            </tr>`).join('')}
        </tbody>
      </table>`
  }

  if (contEmitidas) {
    if (!guiasEmitidas || guiasEmitidas.length === 0) {
      contEmitidas.innerHTML = ''
    } else {
      const comprasMap = {}
      for (const c of (todas || [])) comprasMap[c.id] = c
      const ordenadas = [...guiasEmitidas].sort((a, b) => b.id - a.id)
      contEmitidas.innerHTML = `
        <strong style="display:block; margin:10px 0 6px; font-size:0.85rem;">Guías de Devolución emitidas</strong>
        <table>
          <thead><tr><th>N° Guía</th><th>Fecha</th><th>Compra origen</th><th>Proveedor</th><th>Observaciones</th><th>Acciones</th></tr></thead>
          <tbody>
            ${ordenadas.map(g => {
              const compra = comprasMap[g.compra_id]
              return `<tr>
                <td><strong>${g.numero_guia}</strong></td>
                <td>${g.fecha_guia || '-'}</td>
                <td>${compra?.referencia || `Compra #${g.compra_id}`}</td>
                <td>${compra?.proveedor_nombre || '-'}</td>
                <td>${g.observaciones || '-'}</td>
                <td class="col-acciones">${menuAccionesFila([
                  { label: 'Editar cabecera', icono: '✏️', onclick: `window.editarGuiaDevolucion(${g.id})` },
                  { label: 'Eliminar (revierte stock)', icono: '🗑️', onclick: `window.eliminarGuiaDevolucion(${g.id})`, peligro: true }
                ])}</td>
              </tr>`
            }).join('')}
          </tbody>
        </table>`
    }
  }
}

let _gdvNotaId = null
let _gdvCompraOrigenId = null
let _gdvLineas = []   // líneas pendientes de devolver de la NC seleccionada

window.abrirModalGuiaDevolucion = async function (notaCompraId) {
  try {
    const nota = await getCompraById(notaCompraId)
    if (!nota) { showToast('No se encontró la Nota de Crédito', 'danger'); return }
    if (estaAnulado(nota)) { showToast('Esta Nota de Crédito está anulada', 'warning'); return }

    const compraOrigen = nota.compra_referencia_id ? await getCompraById(nota.compra_referencia_id) : null
    _gdvNotaId = notaCompraId
    _gdvCompraOrigenId = nota.compra_referencia_id || null

    const detalleNota = await getNotaCreditoCompraDetalleByNota(notaCompraId)
    const lineas = []
    for (const d of (detalleNota || [])) {
      const yaDevuelto = (await getDetalleGuiasDevolucionCompraByNotaDetalle(d.id) || [])
        .reduce((s, dg) => s + (parseFloat(dg.cantidad) || 0), 0)
      const pendiente = parseFloat(((parseFloat(d.cantidad) || 0) - yaDevuelto).toFixed(4))
      if (pendiente <= 0.0001) continue

      const [lote, item] = await Promise.all([getLoteById(d.lote_id), getItemById(d.item_id)])
      if (!lote) continue

      if (lote.es_peso_variable) {
        const bultosLote = await getLoteBultosByLote(lote.id)
        const disponibles = (bultosLote || []).filter(b => b.estado === 'disponible')
        if (disponibles.length === 0) continue
        const zonas = await getUbicaciones()
        const zonasMap = {}
        for (const z of (zonas || [])) zonasMap[z.id] = z.nombre
        lineas.push({
          notaDetalleId: d.id, itemId: d.item_id, nombre: item?.nombre || `Item #${d.item_id}`,
          loteId: lote.id, numeroLote: lote.numero_lote, unidadMedida: lote.unidad_medida || 'KG',
          esPesoVariable: true, pendiente,
          bultos: disponibles.map(b => ({ id: b.id, peso: parseFloat(b.peso) || 0, ubicacionId: b.ubicacion_id, zonaNombre: zonasMap[b.ubicacion_id] || '?' }))
        })
      } else {
        const filasStock = await getStockUbicacionesByLote(lote.id)
        const zonas = await getUbicaciones()
        const zonasMap = {}
        for (const z of (zonas || [])) zonasMap[z.id] = z.nombre
        const zonasConStock = (filasStock || [])
          .filter(f => (parseFloat(f.cantidad) || 0) > 0)
          .map(f => ({ id: f.ubicacion_id, nombre: zonasMap[f.ubicacion_id] || '?', disponible: parseFloat(f.cantidad) || 0 }))
        if (zonasConStock.length === 0) continue
        lineas.push({
          notaDetalleId: d.id, itemId: d.item_id, nombre: item?.nombre || `Item #${d.item_id}`,
          loteId: lote.id, numeroLote: lote.numero_lote, unidadMedida: lote.unidad_medida || item?.unidad_medida || 'UND',
          esPesoVariable: false, pendiente, zonasConStock
        })
      }
    }
    _gdvLineas = lineas

    document.getElementById('gdvInfoNota').innerHTML = `
      <div style="font-size:0.72rem; text-transform:uppercase; letter-spacing:.4px; color:var(--text-secondary);">Cubre la Nota de Crédito</div>
      <div style="font-weight:600; font-size:1.05rem; margin-top:2px;">${_escGdv(nota.serie || '')}-${_escGdv(nota.numero || '')}</div>
      <div style="font-size:0.85rem; color:var(--text-secondary); margin-top:2px;">
        ${_escGdv(nota.proveedor_nombre || '-')} · Compra origen: ${compraOrigen ? _escGdv(compraOrigen.referencia || `#${compraOrigen.id}`) : '-'}
      </div>
    `
    // Devolución a proveedor también usa la serie T001 (decisión Luis,
    // 2026-10-02): se sugiere el siguiente número, editable. Destino en el
    // kardex sigue siendo Partners/Vendors (no el destino de la serie, que
    // es para ventas).
    let _numSug = ''
    try { _numSug = await siguienteNumeroGuia(await getSerie('09', 'T001')) } catch { /* sin serie 09 aún */ }
    document.getElementById('gdvNumeroGuia').value = _numSug
    document.getElementById('gdvFechaGuia').value = new Date().toISOString().split('T')[0]
    document.getElementById('gdvObservaciones').value = ''
    _setEvGdv('gdv-titulo-modal', 'Emitir Guía de Devolución')

    _renderTablaDetalleGuiaDevolucion()
    window.openModal('modal-guia-devolucion')
  } catch (e) {
    console.error('abrirModalGuiaDevolucion:', e)
    showToast('Error al preparar la guía de devolución: ' + e.message, 'danger')
  }
}

window.cerrarModalGuiaDevolucion = function () {
  _gdvNotaId = null; _gdvCompraOrigenId = null; _gdvLineas = []
  window.closeModal('modal-guia-devolucion')
}

function _renderTablaDetalleGuiaDevolucion() {
  const cont = document.getElementById('tabla-detalle-guia-devolucion')
  if (!cont) return
  if (_gdvLineas.length === 0) {
    cont.innerHTML = '<p style="text-align:center; color:var(--text-secondary); padding:20px;">No queda nada pendiente por devolver en esta NC (ya se cubrió con guías anteriores).</p>'
    return
  }

  const filas = _gdvLineas.map((l, idx) => {
    if (l.esPesoVariable) {
      const bultosHtml = l.bultos.map((b, bIdx) => `
        <label style="display:flex; align-items:center; gap:6px; padding:3px 0; font-weight:400; cursor:pointer;">
          <input type="checkbox" id="gdv-${idx}-b${bIdx}-chk">
          <span>Bulto #${b.id} — ${b.peso.toFixed(2)} ${_escGdv(l.unidadMedida)}</span>
          <span style="color:var(--text-secondary); font-size:0.78rem;">(${_escGdv(b.zonaNombre)})</span>
        </label>`).join('')
      return `
        <tr style="border-top:1px solid var(--border-color);">
          <td style="padding:8px 10px; vertical-align:top;">
            <strong>${_escGdv(l.nombre)}</strong>
            <div style="color:var(--text-secondary); font-size:0.78rem;">lote ${_escGdv(l.numeroLote)} · peso variable</div>
          </td>
          <td style="text-align:right; white-space:nowrap; color:var(--text-secondary); font-size:0.85rem; padding:8px 10px; vertical-align:top;">${l.pendiente} ${_escGdv(l.unidadMedida)}</td>
          <td colspan="2" style="padding:8px 10px;">${bultosHtml}</td>
        </tr>`
    }
    return `
      <tr style="border-top:1px solid var(--border-color);">
        <td style="padding:8px 10px;">
          <strong>${_escGdv(l.nombre)}</strong>
          <div style="color:var(--text-secondary); font-size:0.78rem;">lote ${_escGdv(l.numeroLote)}</div>
        </td>
        <td style="text-align:right; white-space:nowrap; color:var(--text-secondary); font-size:0.85rem; padding:8px 10px;">${l.pendiente} ${_escGdv(l.unidadMedida)}</td>
        <td style="width:120px; padding:8px 10px;">
          <input type="number" id="gdv-${idx}-cantidad" value="0" step="0.01" min="0" max="${l.pendiente}" style="width:100%;">
        </td>
        <td style="width:220px; padding:8px 10px;">
          <select id="gdv-${idx}-zona" style="width:100%;">
            ${l.zonasConStock.map(z => `<option value="${z.id}">${_escGdv(z.nombre)} (disp: ${z.disponible})</option>`).join('')}
          </select>
        </td>
      </tr>`
  }).join('')

  cont.innerHTML = `
    <div style="border:1px solid var(--border-color); border-radius:var(--radius-md); overflow:hidden; overflow-x:auto;">
      <table style="width:100%; border-collapse:collapse; margin:0;">
        <thead>
          <tr style="background:var(--bg-secondary);">
            <th style="text-align:left; padding:8px 10px; font-size:0.78rem;">Producto / Lote</th>
            <th style="text-align:right; padding:8px 10px; font-size:0.78rem;">Pendiente</th>
            <th style="text-align:left; padding:8px 10px; font-size:0.78rem;">Cantidad a devolver</th>
            <th style="text-align:left; padding:8px 10px; font-size:0.78rem;">Zona de salida</th>
          </tr>
        </thead>
        <tbody>${filas}</tbody>
      </table>
    </div>`
}

window.guardarGuiaDevolucionCompra = async function () {
  const btn = document.getElementById('btnGuardarGuiaDevolucion')
  try {
    if (!_gdvNotaId || !_gdvCompraOrigenId) { showToast('Guía inválida', 'danger'); return }
    const numeroGuia = document.getElementById('gdvNumeroGuia')?.value?.trim()
    const fechaGuia = document.getElementById('gdvFechaGuia')?.value
    const observaciones = document.getElementById('gdvObservaciones')?.value?.trim() || null
    if (!numeroGuia) { showToast('Ingresa el N° de Guía', 'warning'); return }
    if (!fechaGuia)  { showToast('Ingresa la fecha de la guía', 'warning'); return }

    const seleccionFija = []      // peso fijo: { linea, cantidad, ubicacionId }
    const seleccionVariable = []  // peso variable: { linea, bulto }
    _gdvLineas.forEach((l, idx) => {
      if (l.esPesoVariable) {
        l.bultos.forEach((b, bIdx) => {
          const chk = document.getElementById(`gdv-${idx}-b${bIdx}-chk`)
          if (chk?.checked) seleccionVariable.push({ linea: l, bulto: b })
        })
      } else {
        const cantidad = parseFloat(document.getElementById(`gdv-${idx}-cantidad`)?.value || 0)
        const ubicacionId = parseInt(document.getElementById(`gdv-${idx}-zona`)?.value || 0)
        if (cantidad > 0 && ubicacionId) seleccionFija.push({ linea: l, cantidad: Math.min(cantidad, l.pendiente), ubicacionId })
      }
    })

    if (seleccionFija.length === 0 && seleccionVariable.length === 0) {
      showToast('Selecciona o ingresa al menos una línea a devolver', 'warning')
      return
    }

    if (btn) { btn.disabled = true; btn.textContent = 'Guardando…' }
    const user = getCurrentUser()
    const usuarioId = user?.db_id || null

    const guia = await addGuiaDevolucionCompra({
      compra_id: _gdvCompraOrigenId, numero_guia: numeroGuia, fecha_guia: fechaGuia,
      observaciones, created_by: usuarioId
    })
    if (!guia?.id) throw new Error('No se pudo crear la guía')
    await registrarUsoGuia(numeroGuia)

    const vendorsZona = await getUbicacionVendors()
    const lotesTocados = new Set()

    // Líneas de peso fijo: una fila de detalle + descuento directo del lote/zona + kardex
    for (const { linea, cantidad, ubicacionId } of seleccionFija) {
      const dg = await addDetalleGuiaDevolucionCompra({
        guia_id: guia.id, nota_credito_compra_detalle_id: linea.notaDetalleId,
        item_id: linea.itemId, cantidad, numero_lote: linea.numeroLote,
        lote_id: linea.loteId, ubicacion_id: ubicacionId
      })

      const lote = await getLoteById(linea.loteId)
      const nuevaCantidad = parseFloat(Math.max(0, (parseFloat(lote?.cantidad) || 0) - cantidad).toFixed(4))
      // Unidades: se derivan de peso_por_unidad (mismo criterio que ya usa
      // eliminarGuiaDevolucion) — esta guía nunca declaró unidades por
      // línea, pero sí hay un peso_por_unidad confiable del lote.
      const unidadesDevueltasFija = (lote?.peso_por_unidad && lote.peso_por_unidad > 0)
        ? parseFloat((cantidad / lote.peso_por_unidad).toFixed(2))
        : 0
      const nuevaCantidadUnidades = parseFloat(Math.max(0, (parseFloat(lote?.cantidad_unidades) || 0) - unidadesDevueltasFija).toFixed(4))
      await updateLote(linea.loteId, { cantidad: nuevaCantidad, cantidad_unidades: nuevaCantidadUnidades })

      const filas = await getStockUbicacionesByLote(linea.loteId)
      const fila = (filas || []).find(f => f.ubicacion_id === ubicacionId)
      if (fila) {
        await updateStockUbicacion(fila.id, {
          cantidad: parseFloat(Math.max(0, (parseFloat(fila.cantidad) || 0) - cantidad).toFixed(4)),
          cantidad_unidades: parseFloat(Math.max(0, (parseFloat(fila.cantidad_unidades) || 0) - unidadesDevueltasFija).toFixed(4))
        })
      }

      const costoUnit = parseFloat(lote?.costo_unitario || 0)
      await addKardexMovimiento({
        item_id: linea.itemId, lote_id: linea.loteId,
        ubicacion_origen_id: ubicacionId, ubicacion_destino_id: vendorsZona?.id || null,
        fecha: fechaGuia, tipo_movimiento: 'salida', concepto: 'Devolución a proveedor (Guía de Devolución)',
        documento_referencia: numeroGuia,
        cantidad_entrada: 0, cantidad_salida: cantidad,
        cantidad_unidades_entrada: 0, cantidad_unidades_salida: unidadesDevueltasFija,
        costo_unitario: costoUnit,
        valor_entrada: 0, valor_salida: parseFloat((cantidad * costoUnit).toFixed(2)),
        moneda: lote?.moneda || 'PEN', tipo_cambio: parseFloat(lote?.tipo_cambio) || 1,
        costo_unit_original: parseFloat(lote?.costo_unit_original ?? costoUnit),
        saldo_cantidad: nuevaCantidad, saldo_valor: parseFloat((nuevaCantidad * costoUnit).toFixed(2)),
        saldo_unidades: nuevaCantidadUnidades,
        compra_id: _gdvCompraOrigenId, created_by: usuarioId
      })
    }

    // Líneas de peso variable: una fila de detalle por bulto + el bulto pasa a devuelto_proveedor
    const kardexPorZona = new Map()  // agrupa bultos por (loteId, ubicacionId) para un solo movimiento de kardex
    for (const { linea, bulto } of seleccionVariable) {
      const dg = await addDetalleGuiaDevolucionCompra({
        guia_id: guia.id, nota_credito_compra_detalle_id: linea.notaDetalleId,
        item_id: linea.itemId, cantidad: bulto.peso, numero_lote: linea.numeroLote,
        lote_id: linea.loteId, ubicacion_id: bulto.ubicacionId
      })
      await updateLoteBulto(bulto.id, {
        estado: 'devuelto_proveedor', nota_credito_compra_id: _gdvNotaId, detalle_guia_devolucion_id: dg?.id || null
      })
      lotesTocados.add(linea.loteId)

      const key = `${linea.loteId}|${bulto.ubicacionId}`
      const acc = kardexPorZona.get(key) || { itemId: linea.itemId, loteId: linea.loteId, ubicacionId: bulto.ubicacionId, cantidad: 0, unidades: 0 }
      acc.cantidad += bulto.peso
      acc.unidades += 1   // cada bulto retirado = 1 unidad (mismo criterio que recalcularLoteDesdeBultos)
      kardexPorZona.set(key, acc)
    }
    for (const loteId of lotesTocados) await recalcularLoteDesdeBultos(loteId)
    for (const { itemId, loteId, ubicacionId, cantidad, unidades } of kardexPorZona.values()) {
      const lote = await getLoteById(loteId)
      const costoUnit = parseFloat(lote?.costo_unitario || 0)
      await addKardexMovimiento({
        item_id: itemId, lote_id: loteId,
        ubicacion_origen_id: ubicacionId, ubicacion_destino_id: vendorsZona?.id || null,
        fecha: fechaGuia, tipo_movimiento: 'salida', concepto: 'Devolución a proveedor (Guía de Devolución)',
        documento_referencia: numeroGuia,
        cantidad_entrada: 0, cantidad_salida: cantidad,
        cantidad_unidades_entrada: 0, cantidad_unidades_salida: unidades,
        costo_unitario: costoUnit,
        valor_entrada: 0, valor_salida: parseFloat((cantidad * costoUnit).toFixed(2)),
        moneda: lote?.moneda || 'PEN', tipo_cambio: parseFloat(lote?.tipo_cambio) || 1,
        costo_unit_original: parseFloat(lote?.costo_unit_original ?? costoUnit),
        saldo_cantidad: parseFloat(lote?.cantidad || 0), saldo_valor: parseFloat(((parseFloat(lote?.cantidad) || 0) * costoUnit).toFixed(2)),
        saldo_unidades: parseFloat(lote?.cantidad_unidades || 0),
        compra_id: _gdvCompraOrigenId, created_by: usuarioId
      })
    }

    await _recalcularEstadoDevolucionNota(_gdvNotaId)

    _invalidarCacheCompras()
    showToast(`Guía de Devolución ${numeroGuia} emitida ✅ — stock retirado de Inventario`, 'success')
    window.cerrarModalGuiaDevolucion()
    await renderGuias(true)
    await renderCompras(true)
  } catch (e) {
    console.error('guardarGuiaDevolucionCompra:', e)
    showToast('No se pudo guardar la guía de devolución: ' + e.message, 'danger', 7000)
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Guardar Guía (retira stock)' }
  }
}

// ── Editar (solo cabecera) / Eliminar (revierte stock) Guía de Devolución ──
window.editarGuiaDevolucion = async function (id) {
  try {
    const g = await getGuiaDevolucionCompraById(id)
    if (!g) { showToast('No se encontró la guía', 'danger'); return }
    document.getElementById('egdId').value = g.id
    document.getElementById('egdNumeroGuia').value = g.numero_guia || ''
    document.getElementById('egdFechaGuia').value = g.fecha_guia || ''
    document.getElementById('egdObservaciones').value = g.observaciones || ''
    window.openModal('modal-editar-guia-devolucion')
  } catch (e) {
    console.error('editarGuiaDevolucion:', e)
    showToast('Error al abrir la guía para editar', 'danger')
  }
}

window.guardarEdicionGuiaDevolucion = async function () {
  try {
    const id = parseInt(document.getElementById('egdId')?.value || 0)
    if (!id) { showToast('Guía inválida', 'danger'); return }
    const numeroGuia = document.getElementById('egdNumeroGuia')?.value?.trim()
    const fechaGuia = document.getElementById('egdFechaGuia')?.value
    const observaciones = document.getElementById('egdObservaciones')?.value?.trim() || null
    if (!numeroGuia) { showToast('Ingresa el N° de Guía', 'warning'); return }
    if (!fechaGuia)  { showToast('Ingresa la fecha de la guía', 'warning'); return }

    const ok = await updateGuiaDevolucionCompra(id, { numero_guia: numeroGuia, fecha_guia: fechaGuia, observaciones })
    if (!ok) { showToast('No se pudo actualizar la guía', 'danger'); return }

    showToast('Guía actualizada', 'success')
    window.closeModal('modal-editar-guia-devolucion')
    await renderGuias(true)
  } catch (e) {
    console.error('guardarEdicionGuiaDevolucion:', e)
    showToast('Error al actualizar la guía', 'danger')
  }
}

/**
 * Elimina una Guía de Devolución revirtiendo lo que había retirado:
 *   - Líneas de peso fijo: se suma la cantidad de vuelta al lote y a su zona.
 *   - Líneas de peso variable: el/los bulto(s) que esta línea marcó vuelven a
 *     'disponible' (revertirBultosDeDetalleGuiaDevolucion) y el lote se
 *     recalcula desde sus bultos reales.
 *   - Kardex: se borran los movimientos cuyo documento_referencia sea el N°
 *     de esta guía (se generaron con ese mismo número al emitirla).
 *   - La(s) NC que esta guía cubría vuelven a 'pendiente'/'parcial'.
 */
window.eliminarGuiaDevolucion = async function (id) {
  try {
    const guia = await getGuiaDevolucionCompraById(id)
    if (!guia) { showToast('No se encontró la guía', 'danger'); return }

    if (!confirm(`Se eliminará la guía ${guia.numero_guia} revirtiendo el stock retirado. ¿Continuar?`)) return

    const detalles = await getDetalleGuiasDevolucionCompra(id)
    const notasATocar = new Set()
    const lotesTocadosBultos = new Set()

    for (const dg of (detalles || [])) {
      notasATocar.add(dg.nota_credito_compra_detalle_id)

      const bultosDeEstaLinea = await getLoteBultosPorDetalleGuiaDevolucion(dg.id)
      if (bultosDeEstaLinea && bultosDeEstaLinea.length > 0) {
        await revertirBultosDeDetalleGuiaDevolucion(dg.id)
        lotesTocadosBultos.add(dg.lote_id)
      } else if (dg.lote_id) {
        const lote = await getLoteById(dg.lote_id)
        if (lote) {
          const cantidadDevuelta = parseFloat(dg.cantidad) || 0
          const nuevaCantidad = parseFloat(((parseFloat(lote.cantidad) || 0) + cantidadDevuelta).toFixed(4))
          // Unidades: se derivan de peso_por_unidad (mismo criterio que ya usa
          // Despacho/Traslados) en vez de guardar una columna nueva — esta
          // guía nunca declaró unidades por línea, así que no hay un dato
          // real que leer, pero sí un peso_por_unidad confiable del lote.
          const unidadesDevueltas = (lote.peso_por_unidad && lote.peso_por_unidad > 0)
            ? parseFloat((cantidadDevuelta / lote.peso_por_unidad).toFixed(2))
            : 0
          const nuevaCantidadUnidades = parseFloat(((parseFloat(lote.cantidad_unidades) || 0) + unidadesDevueltas).toFixed(4))
          await updateLote(dg.lote_id, { cantidad: nuevaCantidad, cantidad_unidades: nuevaCantidadUnidades })
          if (dg.ubicacion_id) {
            const filas = await getStockUbicacionesByLote(dg.lote_id)
            const fila = (filas || []).find(f => f.ubicacion_id === dg.ubicacion_id)
            if (fila) {
              await updateStockUbicacion(fila.id, {
                cantidad: parseFloat(((parseFloat(fila.cantidad) || 0) + cantidadDevuelta).toFixed(4)),
                cantidad_unidades: parseFloat(((parseFloat(fila.cantidad_unidades) || 0) + unidadesDevueltas).toFixed(4))
              })
            }
          }
        }
      }
    }
    for (const loteId of lotesTocadosBultos) await recalcularLoteDesdeBultos(loteId)

    // Kardex de esta guía: se identifican por documento_referencia (el N° de
    // guía, único), filtrando dentro del kardex de la compra origen.
    if (guia.compra_id) {
      const kardexCompra = await getKardexByCompra(guia.compra_id)
      for (const k of (kardexCompra || [])) {
        if (k.documento_referencia === guia.numero_guia && k.tipo_movimiento === 'salida') {
          const okKardex = await deleteKardexMovimiento(k.id)
          if (!okKardex) {
            const motivo = ultimoErrorDelete()
            throw new Error(`No se pudo eliminar el movimiento de Kardex #${k.id}: ${motivo?.mensaje || 'motivo desconocido'}. Se detiene la reversión.`)
          }
        }
      }
    }

    const ok = await deleteGuiaDevolucionCompra(id) // cascada: borra detalle_guias_devolucion_compra
    if (!ok) {
      const motivo = ultimoErrorDelete()
      throw new Error(motivo?.mensaje || 'no se pudo eliminar')
    }

    // Recalcular estado_devolucion de todas las NC que esta guía cubría.
    // Como nota_credito_compra_detalle_id ya no es resoluble tras el borrado
    // en cascada, se usa el detalle leído ANTES de eliminar.
    const notaIdsPorDetalle = {}
    for (const dg of (detalles || [])) {
      if (!(dg.nota_credito_compra_detalle_id in notaIdsPorDetalle)) {
        const d = (await getNotaCreditoCompraDetalleByCompraOrigen(guia.compra_id) || []).find(x => x.id === dg.nota_credito_compra_detalle_id)
        if (d) notaIdsPorDetalle[dg.nota_credito_compra_detalle_id] = d.nota_compra_id
      }
    }
    const notasUnicas = new Set(Object.values(notaIdsPorDetalle))
    for (const notaId of notasUnicas) await _recalcularEstadoDevolucionNota(notaId)

    _invalidarCacheCompras()
    showToast(`Guía ${guia.numero_guia} eliminada: stock revertido en Inventario`, 'success')
    await renderGuias(true)
    await renderCompras(true)
  } catch (e) {
    console.error('eliminarGuiaDevolucion:', e)
    showToast('No se pudo eliminar la guía: ' + e.message, 'danger', 7000)
  }
}

function _setEvGdv(id, texto) { const el = document.getElementById(id); if (el) el.textContent = texto }
function _escGdv(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])) }
