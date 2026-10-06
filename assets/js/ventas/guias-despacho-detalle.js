// ============================================================================
// ventas/guias-despacho-detalle.js — parte de ventas.js (reorganizado 2026-09-25, sin cambios de lógica)
// Mapa completo de funciones: Claude outputs/glosario_funciones_erp.md
// ============================================================================
import { S } from './state.js'
import { getLoteById, getItemById, getVentaById, getDetalleVentas, getAlmacenes, getUbicaciones, getGuiasDespachoVenta, getGuiaDespachoVentaById, getDetalleGuiasDespachoVenta, getDetalleGuiasDespachoVentaByVenta } from '../supabase-data.js'
import { showToast, formatQty } from '../helpers.js'
import { estaAnulado } from '../anulacion.js'
import { _renderTablaDetalleGuiaDespacho, _numGuiaDespacho } from './guias-despacho-form.js'
import { _refrescarStockLoteEnVivo } from './helpers.js'
import { _esc, _zonas } from './init.js'
import { _guiaEstaVigente, _setEv, _valEv } from './ventas-editar.js'

/**
 * Abre el mismo modal de "Nueva Guía de Despacho" pero precargado con los
 * datos de una guía YA emitida, para corregir cantidad/lote/zona sin tener
 * que eliminarla y volverla a crear (perdiendo el N° de guía y teniendo que
 * volver a escribir todo). Al guardar (guardarEdicionGuiaDespachoVenta) se
 * revierte el stock/kardex que esta guía había movido y se vuelve a aplicar
 * con los valores nuevos, sobre la MISMA fila de guías_despacho_venta.
 *
 * Los lotes de peso variable (bultos) quedan fuera de este editor: reconstruir
 * qué bultos concretos estaban marcados es frágil, así que para esos casos se
 * sigue pidiendo eliminar + recrear (más seguro que arriesgar un descuadre).
 */
// ── Ver Detalle de Guía de Despacho (solo lectura, SIEMPRE disponible) ─────
// Mismo criterio que verDetalleGuiaIngreso en Compras: antes, la única
// forma de ver el detalle lote-por-lote de una guía de despacho era
// "Editar guía", que además puede rechazar la edición completa (lotes de
// peso variable: "elimínala y créala de nuevo") — con eso, esas guías no
// se podían ni ver. Este modal separa "ver" de "editar": siempre abre, y
// su botón Editar delega a window.editarGuiaDespachoVenta tal cual (con
// sus mismas validaciones, que nunca fueron el problema).
function _asegurarModalDetalleGuiaDespacho() {
  if (document.getElementById('modal-detalle-guia-despacho')) return
  const div = document.createElement('div')
  div.id = 'modal-detalle-guia-despacho'
  div.className = 'modal'
  div.innerHTML = `
    <div class="modal-content" id="dgd-content" style="width:min(94vw, 900px); max-width:min(94vw, 900px); max-height:90vh; overflow-y:auto;">
      <div class="modal-header">
        <h3 class="modal-title" id="dgd-titulo-modal">Detalle de Guía de Despacho</h3>
        <button class="modal-close" onclick="window.closeModal('modal-detalle-guia-despacho')">&times;</button>
      </div>
      <div style="padding:20px; display:flex; flex-direction:column; gap:14px;">
        <div id="dgd-cabecera" style="padding:12px 14px; background:var(--bg-secondary); border-radius:var(--radius-md); border-left:3px solid var(--color-info); font-size:0.88rem; line-height:1.6;"></div>
        <div id="dgd-detalle"></div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" onclick="window.closeModal('modal-detalle-guia-despacho')">Cerrar</button>
        <button class="btn btn-primary" id="dgdBtnEditar">✏️ Editar guía</button>
      </div>
    </div>`
  document.body.appendChild(div)
}

window.verDetalleGuiaDespachoVenta = async function (id) {
  try {
    const guia = await getGuiaDespachoVentaById(id)
    if (!guia) { showToast('No se encontró la guía', 'danger'); return }

    const [venta, detalles, almacenes, zonas] = await Promise.all([
      getVentaById(guia.venta_id),
      getDetalleGuiasDespachoVenta(id),
      getAlmacenes(), getUbicaciones()
    ])

    const cliente = (S._clientes || []).find(c => c.id === venta?.contact_id)
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
      const filas = await Promise.all(detalles.map(async d => {
        const [item, lote] = await Promise.all([
          d.item_id ? getItemById(d.item_id) : null,
          d.lote_id ? getLoteById(d.lote_id) : null
        ])
        const z = zonaMap[d.ubicacion_id]
        const zona = z ? `${almacenMap[z.almacen_id]?.nombre || '?'} — ${z.nombre}` : '-'
        return `<tr style="border-top:1px solid var(--border-color);">
          <td style="padding:8px 10px;">${item ? `${item.sku ? '(' + item.sku + ') ' : ''}${item.nombre || ''}` : `Item #${d.item_id}`}</td>
          <td style="padding:8px 10px;">${lote?.numero_lote || d.lote_id || '-'}</td>
          <td style="padding:8px 10px;">${zona}</td>
          <td style="padding:8px 10px; text-align:right;">${formatQty(parseFloat(d.cantidad) || 0)} ${item?.unidad_medida || ''}</td>
        </tr>`
      }))
      detalleHtml = `
        <div style="border:1px solid var(--border-color); border-radius:var(--radius-md); overflow:hidden; overflow-x:auto;">
          <table style="width:100%; border-collapse:collapse; margin:0;">
            <thead><tr style="background:var(--bg-secondary);">
              <th style="text-align:left; padding:8px 10px; font-size:0.78rem;">Producto</th>
              <th style="text-align:left; padding:8px 10px; font-size:0.78rem;">Lote</th>
              <th style="text-align:left; padding:8px 10px; font-size:0.78rem;">Almacén / Zona</th>
              <th style="text-align:right; padding:8px 10px; font-size:0.78rem;">Cantidad</th>
            </tr></thead>
            <tbody>${filas.join('')}</tbody>
          </table>
        </div>`
    }

    _asegurarModalDetalleGuiaDespacho()
    document.getElementById('dgd-titulo-modal').textContent = `Detalle de Guía ${guia.numero_guia || ''}`
    document.getElementById('dgd-cabecera').innerHTML = `
      <div style="font-size:0.72rem; text-transform:uppercase; letter-spacing:.4px; color:var(--text-secondary);">Guía de Despacho</div>
      <div style="font-weight:600; font-size:1.05rem; margin-top:2px;">${guia.numero_guia || ''} — ${guia.fecha_guia || ''}</div>
      <div style="font-size:0.85rem; color:var(--text-secondary); margin-top:2px;">
        ${_esc(cliente?.razon_social || cliente?.nombre || '-')} · Venta: ${venta?.serie || ''}-${String(venta?.correlativo || '').padStart(8, '0')}
        ${guia.observaciones ? ` · ${_esc(guia.observaciones)}` : ''}
      </div>`
    document.getElementById('dgd-detalle').innerHTML = detalleHtml

    const btnEditar = document.getElementById('dgdBtnEditar')
    if (btnEditar) btnEditar.onclick = () => { window.closeModal('modal-detalle-guia-despacho'); window.editarGuiaDespachoVenta(id) }

    window.openModal('modal-detalle-guia-despacho')
  } catch (e) {
    console.error('verDetalleGuiaDespachoVenta:', e)
    showToast('Error al cargar el detalle de la guía: ' + e.message, 'danger')
  }
}

window.editarGuiaDespachoVenta = async function (id) {
  try {
    const guia = await getGuiaDespachoVentaById(id)
    if (!guia) { showToast('No se encontró la guía', 'danger'); return }
    if (estaAnulado(guia)) { showToast('Esta guía está anulada: no se puede editar', 'warning'); return }

    const detallesEstaGuia = await getDetalleGuiasDespachoVenta(id)

    await _refrescarStockLoteEnVivo()
    const tienePesoVariable = (detallesEstaGuia || []).some(dg => S._lotesMap[dg.lote_id]?.es_peso_variable)
    if (tienePesoVariable) {
      showToast('Esta guía tiene lotes de peso variable (bultos): por ahora, para corregirla, elimínala y créala de nuevo.', 'warning', 7000)
      return
    }

    S._guiaDespachoEditId = id
    const ventaId = guia.venta_id

    const [venta, detallesVenta, despachosVenta, almacenes] = await Promise.all([
      getVentaById(ventaId), getDetalleVentas(ventaId), getDetalleGuiasDespachoVentaByVenta(ventaId), getAlmacenes()
    ])

    const cliente = S._clientes.find(c => c.id === venta?.contact_id)
    const infoDiv = document.getElementById('gdInfoVenta')
    if (infoDiv) {
      infoDiv.style.display = 'block'
      infoDiv.innerHTML = `
        <strong>Cliente:</strong> ${_esc(cliente?.razon_social || cliente?.nombre || '-')} &nbsp;|&nbsp;
        <strong>Comprobante:</strong> ${venta?.serie || ''}-${String(venta?.correlativo || '').padStart(8,'0')} &nbsp;|&nbsp;
        <strong>Fecha venta:</strong> ${venta?.fecha_emision || '-'} &nbsp;|&nbsp;
        <strong>Estado despacho:</strong> ${venta?.estado_despacho || 'pendiente'}
      `
    }

    const almacenesMap = {}
    for (const a of (almacenes || [])) almacenesMap[a.id] = a
    S._guiaDespachoZonasCache = (_zonas || [])
      .filter(z => !almacenesMap[z.almacen_id]?.es_virtual)
      .map(z => ({ id: z.id, nombre: z.nombre, almacen_id: z.almacen_id, almacenNombre: almacenesMap[z.almacen_id]?.nombre || `Almacén #${z.almacen_id}` }))

    // Igual que onSeleccionarVentaGuiaDespacho, pero excluyendo ESTA guía de
    // "ya despachado" — es la que se está editando, así que su propia
    // reserva de stock se libera para poder redistribuirla.
    const guiasDeEstaVenta = (await getGuiasDespachoVenta(true) || []).filter(g => g.venta_id === ventaId)
    const anuladasIds = new Set(guiasDeEstaVenta.filter(g => !_guiaEstaVigente(g)).map(g => g.id))
    const despachadoPorDetalle = {}
    for (const d of (despachosVenta || [])) {
      if (anuladasIds.has(d.guia_id) || d.guia_id === id) continue
      despachadoPorDetalle[d.detalle_venta_id] = (despachadoPorDetalle[d.detalle_venta_id] || 0) + (parseFloat(d.cantidad) || 0)
    }

    const porDetalleEstaGuia = {}
    for (const dg of (detallesEstaGuia || [])) {
      if (!porDetalleEstaGuia[dg.detalle_venta_id]) porDetalleEstaGuia[dg.detalle_venta_id] = []
      porDetalleEstaGuia[dg.detalle_venta_id].push(dg)
    }

    S._guiaDespachoLineas = (detallesVenta || [])
      .map(d => {
        const cantidadVendida = parseFloat(d.cantidad) || 0
        const yaDespachadoOtras = despachadoPorDetalle[d.id] || 0
        const pendiente = parseFloat((cantidadVendida - yaDespachadoOtras).toFixed(4))
        const filasEstaGuia = porDetalleEstaGuia[d.id] || []
        const despachos = filasEstaGuia.length > 0
          ? filasEstaGuia.map(dg => ({
              cantidad: parseFloat(dg.cantidad) || 0,
              cantidad_unidades: parseFloat(dg.cantidad_unidades) || 0,
              ubicacion_id: dg.ubicacion_id || '', lote_id: dg.lote_id || '',
              esPesoVariable: false, bultosDisponibles: [], bultosSeleccionados: []
            }))
          : (pendiente > 0 ? [{ cantidad: pendiente, cantidad_unidades: null, ubicacion_id: '', lote_id: '', esPesoVariable: false, bultosDisponibles: [], bultosSeleccionados: [] }] : [])
        // detalle_ventas.descripcion puede venir vacío en filas antiguas —
        // se completa con el nombre real del ítem (ya cacheado en _items)
        // antes de caer al fallback genérico "Item #id".
        const itemRef = (S._items || []).find(it => it.id === d.item_id)
        return {
          detalle_venta_id: d.id, item_id: d.item_id,
          nombre: itemRef?.nombre || d.descripcion || `Item #${d.item_id}`,
          sku: itemRef?.sku || '',
          unidad_medida: d.unidad_medida,
          cantidad_vendida: cantidadVendida,
          cantidad_despachada_previa: yaDespachadoOtras,
          cantidad_pendiente: pendiente,
          despachos
        }
      })
      .filter(l => l.despachos.length > 0)

    const selVenta = document.getElementById('gdVenta')
    if (selVenta) {
      selVenta.innerHTML = `<option value="${ventaId}">${venta?.serie || ''}-${String(venta?.correlativo || '').padStart(8,'0')} — ${_esc(cliente?.razon_social || cliente?.nombre || '-')}</option>`
      selVenta.value = String(ventaId)
      selVenta.disabled = true
    }
    await _numGuiaDespacho()?.establecer(guia.numero_guia || '')   // serie ▾ + N° 🔒 (se conserva el original)
    _valEv('gdFechaGuia', guia.fecha_guia || '')
    _valEv('gdObservaciones', guia.observaciones || '')

    _setEv('gd-titulo-modal', `Editar Guía de Despacho ${guia.numero_guia}`)
    const aviso = document.getElementById('gd-edicion-aviso')
    if (aviso) {
      aviso.style.display = 'block'
      aviso.textContent = 'Editando una guía ya emitida: al guardar se revierte el stock/kardex anterior y se vuelve a aplicar con estos valores — no hace falta eliminar y recrear.'
    }
    const btn = document.getElementById('btnGuardarGuiaDespachoVenta')
    if (btn) { btn.textContent = 'Guardar cambios (recalcula stock)'; btn.onclick = () => window.guardarEdicionGuiaDespachoVenta() }

    _renderTablaDetalleGuiaDespacho()
    window.openModal('modal-nueva-guia-despacho')
  } catch (error) {
    console.error('Error en editarGuiaDespachoVenta:', error)
    showToast('Error al abrir la guía para editar: ' + error.message, 'danger')
  }
}
