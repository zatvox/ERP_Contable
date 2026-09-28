// ============================================================================
// compras/notas.js — parte de compras.js (reorganizado 2026-09-25, sin cambios de lógica)
// Mapa completo de funciones: Claude outputs/glosario_funciones_erp.md
// ============================================================================
import { getCompras, getCompraById, addCompra, updateCompra, getLoteById, getLotesByCompraId, getItemById, getCuentasPagarByCompra, updateCuentaPagar, getNotaCreditoCompraDetalleByNota, addNotaCreditoCompraDetalle } from '../supabase-data.js'
import { showToast, formatNumber, formatQty } from '../helpers.js'
import { camposAnulacion, estaAnulado } from '../anulacion.js'
import { abrirModalNota, TIPO_NC, TIPO_ND, esNota, nombreTipoComprobante } from '../notas.js'
import { getModuloConfig } from '../config-modulo.js'
import { _invalidarCacheCompras } from './anulacion.js'
import { _calcularMontosDetalleCompra } from './compra-nueva.js'
import { renderCompras } from './compras-lista.js'

// ============================================================================
// NOTAS DE CRÉDITO Y DÉBITO — RECIBIDAS DEL PROVEEDOR
// ============================================================================
// Espejo de las notas de venta, pero aquí NO las emitimos nosotros: las emite
// el proveedor y nosotros las registramos. Por eso el número y la serie los
// digita el usuario copiando el documento físico (no hay correlativo propio).
//
// Efecto:
//   NC recibida → nos deben menos: reduce lo que hay que pagar y reduce el
//                 crédito fiscal del periodo.
//   ND recibida → nos cobran más: aumenta lo que hay que pagar.

window.abrirModalNotaCreditoCompra = function (compraId) { _abrirNotaCompra(compraId, TIPO_NC) }
window.abrirModalNotaDebitoCompra  = function (compraId) { _abrirNotaCompra(compraId, TIPO_ND) }

// ── Detalle por ítem dentro de la NC de compra (devolución al proveedor) ───
// Catálogo 09 SUNAT (motivos de NC), mapeo confirmado con Luis:
//   01/02 anulación total          -> sin detalle (importe = total, ya lo maneja notas.js)
//   03 corrección de descripción   -> detalle opcional, solo informativo (no dispara guía)
//   04 descuento GLOBAL            -> sin detalle por ítem (a propósito: es monto único, no por línea)
//   05 descuento por ítem          -> detalle requerido, solo ajusta precio (NO mueve stock)
//   06 devolución total            -> detalle requerido, SÍ dispara Guía de Devolución (mueve stock)
//   07 devolución por ítem         -> detalle requerido, SÍ dispara Guía de Devolución (mueve stock)
//   08 bonificación                -> detalle requerido, solo ajusta precio (NO mueve stock)
//   09 disminución en el valor     -> detalle requerido, solo ajusta precio (NO mueve stock)
//   10 otros conceptos             -> sin detalle forzado (catch-all)
const MOTIVOS_NCC_CON_DETALLE  = ['03', '05', '06', '07', '08', '09']
const MOTIVOS_NCC_REQUERIDO    = ['05', '06', '07', '08', '09']  // 03 es opcional
const MOTIVOS_NCC_DEVOLUCION   = ['06', '07']                    // disparan Guía de Devolución

let _ncCompraLineas = []        // lotes de la compra origen, candidatos a devolver
let _ncCompraOrigenId = null

/** Arma _ncCompraLineas a partir de los lotes de la compra que la NC referencia. Solo lotes que SIGUEN existiendo y con cantidad > 0 (lo demás ya se consumió/devolvió por completo). */
async function _prepararDetalleNotaCompra(compraOrigenId) {
  _ncCompraOrigenId = compraOrigenId
  const lotes = await getLotesByCompraId(compraOrigenId)
  const lineas = []
  for (const l of (lotes || [])) {
    if ((parseFloat(l.cantidad) || 0) <= 0) continue
    const item = await getItemById(l.item_id)
    lineas.push({
      loteId: l.id, itemId: l.item_id,
      nombre: item?.nombre || `Item #${l.item_id}`,
      numeroLote: l.numero_lote,
      unidadMedida: l.unidad_medida || item?.unidad_medida || 'UND',
      cantidadDisponible: parseFloat(l.cantidad) || 0,
      precioDefault: parseFloat(l.costo_unit_original ?? l.costo_unitario) || 0
    })
  }
  _ncCompraLineas = lineas
}

/** HTML de la sección de detalle por ítem, inyectada en #nota-extra del modal genérico. */
// ============================================================================
// VER DETALLE DE UNA NOTA DE CRÉDITO/DÉBITO YA EMITIDA (solo lectura)
// ============================================================================
// Las NC/ND de compras nunca populan detalle_compras (su línea real vive en
// nota_credito_compra_detalle) — por eso el modal genérico "Editar Compra"
// las mostraba como "no tiene líneas registradas". Este modal reemplaza a
// Editar para estas filas (nunca llevan botón Editar, solo Ver detalle) y
// muestra lo mismo que ya existe para ventas (verDetalleNotaVenta).

function _asegurarModalDetalleNotaCompra() {
  if (document.getElementById('modal-detalle-nota-compra')) return
  const div = document.createElement('div')
  div.id = 'modal-detalle-nota-compra'
  div.className = 'modal'
  div.innerHTML = `
    <div class="modal-content" id="ndc-content" style="width:min(94vw, 700px); max-width:min(94vw, 700px);">
      <div class="modal-header">
        <h3 class="modal-title">Detalle de la nota</h3>
        <button class="modal-close" onclick="window.closeModal('modal-detalle-nota-compra')">&times;</button>
      </div>
      <div style="padding:20px; display:flex; flex-direction:column; gap:14px;">
        <div id="ndc-cabecera" style="padding:12px 14px; background:var(--bg-secondary); border-radius:var(--radius-md); border-left:3px solid var(--color-info); font-size:0.88rem; line-height:1.6;"></div>
        <div id="ndc-detalle"></div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" onclick="window.closeModal('modal-detalle-nota-compra')">Cerrar</button>
      </div>
    </div>`
  document.body.appendChild(div)
}

window.verDetalleNotaCompra = async function (notaId) {
  try {
    const nota = await getCompraById(notaId)
    if (!nota) { showToast('No se encontró la nota', 'danger'); return }

    const numero = nota.serie ? `${nota.serie}-${nota.numero}` : (nota.numero || nota.referencia || '')
    const detalles = await getNotaCreditoCompraDetalleByNota(notaId)

    let detalleHtml
    if (!detalles || detalles.length === 0) {
      detalleHtml = `<div style="padding:14px; border-radius:var(--radius-md); background:var(--bg-secondary); font-size:0.85rem; color:var(--text-secondary);">
        Esta nota no tiene registrado un detalle de devolución de mercadería — no se referenció ningún lote al emitirla (o el importe corresponde a algo que no mueve stock, ej. un ajuste de precio).
      </div>`
    } else {
      const filas = await Promise.all(detalles.map(async d => {
        const [item, lote] = await Promise.all([
          d.item_id ? getItemById(d.item_id) : null,
          d.lote_id ? getLoteById(d.lote_id) : null
        ])
        return `<tr style="border-top:1px solid var(--border-color);">
          <td style="padding:8px 10px;">${item ? `${item.sku ? '(' + item.sku + ') ' : ''}${item.nombre || ''}` : `Item #${d.item_id}`}</td>
          <td style="padding:8px 10px;">${lote?.numero_lote || d.lote_id || '-'}</td>
          <td style="padding:8px 10px; text-align:right;">${formatQty(parseFloat(d.cantidad) || 0)} ${d.unidad_medida || ''}</td>
        </tr>`
      }))
      detalleHtml = `
        <div>
          <strong style="display:block; margin-bottom:6px; font-size:0.85rem;">📦 Mercadería referenciada</strong>
          <div style="border:1px solid var(--border-color); border-radius:var(--radius-md); overflow:hidden; overflow-x:auto;">
            <table style="width:100%; border-collapse:collapse; margin:0;">
              <thead><tr style="background:var(--bg-secondary);">
                <th style="text-align:left; padding:8px 10px; font-size:0.78rem;">Producto</th>
                <th style="text-align:left; padding:8px 10px; font-size:0.78rem;">Lote</th>
                <th style="text-align:right; padding:8px 10px; font-size:0.78rem;">Cantidad</th>
              </tr></thead>
              <tbody>${filas.join('')}</tbody>
            </table>
          </div>
        </div>`
    }

    _asegurarModalDetalleNotaCompra()
    document.getElementById('ndc-cabecera').innerHTML = `
      <div style="font-size:0.72rem; text-transform:uppercase; letter-spacing:.4px; color:var(--text-secondary);">${nombreTipoComprobante(nota.tipo_comprobante)}</div>
      <div style="font-weight:600; font-size:1.05rem; margin-top:2px;">${numero}</div>
      <div style="font-size:0.85rem; color:var(--text-secondary); margin-top:2px;">
        ${nota.motivo_nota_codigo ? `Motivo ${nota.motivo_nota_codigo} — ${nota.motivo_nota_texto || ''}` : ''}
        ${nota.doc_referencia_serie ? ` · ref. ${nota.doc_referencia_serie}-${String(nota.doc_referencia_numero || '').padStart(8, '0')}` : ''}
        ${nota.currency ? ` · ${nota.currency} ${formatNumber(nota.total)}` : ''}
      </div>`
    document.getElementById('ndc-detalle').innerHTML = detalleHtml
    window.openModal('modal-detalle-nota-compra')
  } catch (e) {
    console.error('verDetalleNotaCompra:', e)
    showToast('Error al cargar el detalle de la nota: ' + e.message, 'danger')
  }
}

function _renderDetalleNotaCompra() {
  if (_ncCompraLineas.length === 0) {
    return `<div id="nccDetalle-bloque" style="display:none; margin-top:6px; padding:10px 12px; border-radius:var(--radius-md); background:var(--bg-secondary); font-size:0.82rem; color:var(--text-secondary);">
      No quedan lotes disponibles de la compra origen para referenciar en el detalle (ya se consumieron o devolvieron por completo).
    </div>`
  }
  const igvDefault = String(getModuloConfig('compras').igvDefault ?? 18)
  const filas = _ncCompraLineas.map((l, idx) => `
    <tr style="border-top:1px solid var(--border-color);">
      <td style="text-align:center; width:36px; padding:8px 10px;"><input type="checkbox" id="nccDet-${idx}-chk" onchange="window.toggleLineaDetalleNotaCompra(${idx})"></td>
      <td style="padding:8px 10px;">
        <strong>${_escNcc(l.nombre)}</strong>
        <div style="color:var(--text-secondary); font-size:0.78rem;">lote ${_escNcc(l.numeroLote)}</div>
      </td>
      <td style="text-align:right; white-space:nowrap; color:var(--text-secondary); font-size:0.85rem; padding:8px 10px;">${l.cantidadDisponible} ${_escNcc(l.unidadMedida)}</td>
      <td style="width:100px; padding:8px 10px;">
        <input type="number" id="nccDet-${idx}-cantidad" value="${l.cantidadDisponible}" step="0.01" min="0.01" max="${l.cantidadDisponible}" style="width:100%;" disabled oninput="window.onCambiarLineaDetalleNotaCompra(${idx})">
      </td>
      <td style="width:110px; padding:8px 10px;">
        <input type="number" id="nccDet-${idx}-precio" value="${l.precioDefault}" step="0.0001" min="0" style="width:100%;" disabled oninput="window.onCambiarLineaDetalleNotaCompra(${idx})">
      </td>
      <td style="width:130px; padding:8px 10px;">
        <select id="nccDet-${idx}-igv" style="width:100%;" disabled onchange="window.onCambiarLineaDetalleNotaCompra(${idx})">
          <option value="18"${igvDefault === '18' ? ' selected' : ''}>18%</option>
          <option value="18-inc" title="El precio unitario ya incluye el IGV.">18% (incluido)</option>
          <option value="10"${igvDefault === '10' ? ' selected' : ''}>10%</option>
          <option value="0"${igvDefault === '0' ? ' selected' : ''}>Exonerada</option>
        </select>
      </td>
      <td style="text-align:right; padding:8px 10px; font-weight:600;" id="nccDet-${idx}-total">0.00</td>
    </tr>`).join('')

  return `
    <div id="nccDetalle-bloque" style="display:none; margin-top:10px;">
      <div id="nccDet-requerido-aviso" style="display:none; margin-bottom:10px; padding:10px 12px; border-radius:var(--radius-md); background:rgba(245,158,11,.14); color:var(--color-warning); font-size:0.82rem;">
        Este motivo exige detalle por ítem: selecciona al menos una línea.
      </div>
      <strong style="display:block; margin-bottom:4px; font-size:0.9rem;">📦 Detalle de la Nota de Crédito</strong>
      <small style="display:block; margin-bottom:10px; color:var(--text-secondary); line-height:1.4;">
        Solo puedes referenciar lotes de la compra que esta NC modifica. Si el motivo es Devolución (06/07), al emitir la NC quedará pendiente de "Guía de Devolución" en el tab Guía de Remisión — la mercadería sale del stock recién cuando emitas esa guía, no aquí.
        Los importes de la nota (arriba) se calculan solos sumando lo que marques aquí.
      </small>
      <div style="border:1px solid var(--border-color); border-radius:var(--radius-md); overflow:hidden; overflow-x:auto;">
        <table style="width:100%; border-collapse:collapse; margin:0;">
          <thead>
            <tr style="background:var(--bg-secondary);">
              <th style="width:36px;"></th>
              <th style="text-align:left; padding:8px 10px; font-size:0.78rem;">Producto / Lote</th>
              <th style="text-align:right; padding:8px 10px; font-size:0.78rem;">Disponible</th>
              <th style="text-align:left; padding:8px 10px; font-size:0.78rem;">Cantidad</th>
              <th style="text-align:left; padding:8px 10px; font-size:0.78rem;">Precio unit.</th>
              <th style="text-align:left; padding:8px 10px; font-size:0.78rem;">Tipo IGV</th>
              <th style="text-align:right; padding:8px 10px; font-size:0.78rem;">Total línea</th>
            </tr>
          </thead>
          <tbody>${filas}</tbody>
          <tfoot>
            <tr style="border-top:2px solid var(--border-color); background:var(--bg-secondary); font-weight:600;">
              <td colspan="6" style="text-align:right; padding:8px 10px;">Total seleccionado:</td>
              <td style="text-align:right; padding:8px 10px;" id="nccDet-total-general">0.00</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>`
}

function _escNcc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])) }

window.toggleLineaDetalleNotaCompra = function (idx) {
  const chk = document.getElementById(`nccDet-${idx}-chk`)
  const inpCant = document.getElementById(`nccDet-${idx}-cantidad`)
  const inpPrecio = document.getElementById(`nccDet-${idx}-precio`)
  const selIgv = document.getElementById(`nccDet-${idx}-igv`)
  if (inpCant)  inpCant.disabled = !chk?.checked
  if (inpPrecio) inpPrecio.disabled = !chk?.checked
  if (selIgv)   selIgv.disabled = !chk?.checked
  window.onCambiarLineaDetalleNotaCompra(idx)
}

/** Recalcula el total de una línea del detalle y, con eso, los 3 campos de importes de la nota (arriba, en modo lectura mientras el detalle está activo). */
window.onCambiarLineaDetalleNotaCompra = function (idx) {
  const chk = document.getElementById(`nccDet-${idx}-chk`)
  const totalCell = document.getElementById(`nccDet-${idx}-total`)
  if (!chk?.checked) {
    if (totalCell) totalCell.textContent = '0.00'
    _recalcularTotalesDetalleNotaCompra()
    return
  }
  const cantidad = parseFloat(document.getElementById(`nccDet-${idx}-cantidad`)?.value || 0)
  const precio   = parseFloat(document.getElementById(`nccDet-${idx}-precio`)?.value || 0)
  const igvValor = document.getElementById(`nccDet-${idx}-igv`)?.value || '18'
  const { total } = _calcularMontosDetalleCompra(cantidad, precio, 0, igvValor)
  if (totalCell) totalCell.textContent = total.toFixed(2)
  _recalcularTotalesDetalleNotaCompra()
}

/** Suma todas las líneas marcadas y escribe el resultado en los 3 campos de importes de la nota vía el hook que expone notas.js. */
function _recalcularTotalesDetalleNotaCompra() {
  let base = 0, igv = 0, importe = 0
  _ncCompraLineas.forEach((l, idx) => {
    const chk = document.getElementById(`nccDet-${idx}-chk`)
    if (!chk?.checked) return
    const cantidad = parseFloat(document.getElementById(`nccDet-${idx}-cantidad`)?.value || 0)
    const precio   = parseFloat(document.getElementById(`nccDet-${idx}-precio`)?.value || 0)
    const igvValor = document.getElementById(`nccDet-${idx}-igv`)?.value || '18'
    const r = _calcularMontosDetalleCompra(cantidad, precio, 0, igvValor)
    base += r.subtotal; igv += r.igvMonto; importe += r.total
  })
  const totalGeneral = document.getElementById('nccDet-total-general')
  if (totalGeneral) totalGeneral.textContent = importe.toFixed(2)
  window.setTotalesNotaDesdeDetalle?.({ base, igv, importe })
}

/** Lee del DOM lo que el usuario marcó/tipeó. Solo líneas con checkbox marcado y cantidad > 0. */
function _leerDetalleNotaCompra() {
  const seleccion = []
  _ncCompraLineas.forEach((l, idx) => {
    const chk = document.getElementById(`nccDet-${idx}-chk`)
    if (!chk?.checked) return
    const cantidad = parseFloat(document.getElementById(`nccDet-${idx}-cantidad`)?.value || 0)
    const precio   = parseFloat(document.getElementById(`nccDet-${idx}-precio`)?.value || 0)
    if (cantidad > 0) seleccion.push({ ...l, cantidad: Math.min(cantidad, l.cantidadDisponible), precioUnitario: precio })
  })
  return seleccion
}

async function _abrirNotaCompra(compraId, tipoNota) {
  try {
    const compra = await getCompraById(compraId)
    if (!compra) { showToast('No se encontró la compra', 'danger'); return }

    const numeroOrigen = `${compra.serie || ''}-${compra.numero || ''}`
    const bloqueos = []

    if (estaAnulado(compra)) {
      bloqueos.push('El comprobante ya está anulado: no se le pueden registrar notas.')
    }
    if (esNota(compra.tipo_comprobante)) {
      bloqueos.push('Este documento ya es una nota. Las notas se registran sobre facturas, no sobre otras notas.')
    }

    const todas = await getCompras()
    const notasPrevias = (todas || []).filter(c => c.compra_referencia_id === compraId && !estaAnulado(c))
    const ncPrevias = notasPrevias.filter(c => String(c.tipo_comprobante) === TIPO_NC)
      .reduce((s, c) => s + (parseFloat(c.total) || 0), 0)
    const ndPrevias = notasPrevias.filter(c => String(c.tipo_comprobante) === TIPO_ND)
      .reduce((s, c) => s + (parseFloat(c.total) || 0), 0)

    const totalOrigen = parseFloat(compra.total || 0)
    const disponibleNC = parseFloat((totalOrigen + ndPrevias - ncPrevias).toFixed(2))

    if (tipoNota === TIPO_NC && disponibleNC <= 0.01 && bloqueos.length === 0) {
      bloqueos.push(`El comprobante ya está totalmente acreditado con notas previas (${formatNumber(ncPrevias)}).`)
    }

    const cxps = await getCuentasPagarByCompra(compraId)
    const cxp = (cxps || [])[0] || null
    const saldo = cxp
      ? parseFloat(cxp.monto_total || 0) + parseFloat(cxp.monto_notas_debito || 0)
        - parseFloat(cxp.monto_notas_credito || 0) - parseFloat(cxp.monto_pagado || 0)
        - parseFloat(cxp.monto_anticipo_aplicado || 0)
      : totalOrigen

    const cfg = getModuloConfig('compras')

    // Detalle por ítem: solo tiene sentido en una NC sobre una compra de
    // mercadería (una ND nunca referencia lotes; un ajuste de servicio tampoco).
    if (tipoNota === TIPO_NC && compra.tipo_compra === 'mercaderia') {
      await _prepararDetalleNotaCompra(compraId)
    } else {
      _ncCompraLineas = []
      _ncCompraOrigenId = null
    }

    await abrirModalNota({
      tipoNota, contexto: 'compra',
      documento: `${compra.tipo_comprobante || ''} ${numeroOrigen}`.trim(),
      detalle: `${compra.proveedor_nombre || ''} · ${compra.fecha_emision || ''} · ${compra.currency || 'PEN'} ${formatNumber(totalOrigen)}`,
      totalOrigen: disponibleNC,
      saldoOrigen: saldo,
      igvPorcentaje: parseFloat(cfg.igvDefault) || 18,
      serieSugerida: '',
      numeroSugerido: '',
      bloqueos,
      anchoAmplio: tipoNota === TIPO_NC && _ncCompraLineas.length > 0,
      renderExtra: () => _renderDetalleNotaCompra(),
      onMotivoCambio: (motivo) => {
        const bloque = document.getElementById('nccDetalle-bloque')
        const conDetalle = MOTIVOS_NCC_CON_DETALLE.includes(motivo)
        if (bloque) bloque.style.display = conDetalle ? 'block' : 'none'
        const aviso = document.getElementById('nccDet-requerido-aviso')
        if (aviso) aviso.style.display = MOTIVOS_NCC_REQUERIDO.includes(motivo) ? 'block' : 'none'

        // Con detalle visible, los importes de la nota se calculan solos
        // sumando las líneas marcadas — el bloque de totales se mueve al
        // final y queda de solo lectura (window.setModoDetalleNota, en
        // notas.js). Sin detalle, vuelve a ser editable a mano arriba.
        window.setModoDetalleNota?.(conDetalle)
        if (conDetalle) _recalcularTotalesDetalleNotaCompra()
      },
      validarExtra: () => {
        const motivo = document.getElementById('notaMotivo')?.value
        if (!MOTIVOS_NCC_REQUERIDO.includes(motivo)) return { ok: true }
        const seleccion = _leerDetalleNotaCompra()
        if (seleccion.length === 0) {
          return { ok: false, mensaje: 'Este motivo exige detalle por ítem: selecciona al menos un lote de la compra origen (o cambia el motivo si no corresponde).' }
        }
        return { ok: true }
      },
      onEmitir: async (d) => {
        if (!d.serie || !d.numero) {
          throw new Error('Copia la serie y el número exactos de la nota que te envió el proveedor')
        }

        const base = parseFloat(d.base.toFixed(2))
        const igv  = parseFloat(d.igv.toFixed(2))
        const tot  = parseFloat(d.importe.toFixed(2))

        // Detalle por ítem (si el motivo lo trae) — se lee ANTES de crear la
        // NC porque el modal se cierra apenas onEmitir resuelve.
        const detalleSeleccionado = (tipoNota === TIPO_NC && MOTIVOS_NCC_CON_DETALLE.includes(d.motivo))
          ? _leerDetalleNotaCompra() : []
        const esDevolucionStock = MOTIVOS_NCC_DEVOLUCION.includes(d.motivo) && detalleSeleccionado.length > 0

        const nota = await addCompra({
          referencia:             `${tipoNota === TIPO_NC ? 'NC' : 'ND'}-${d.serie}-${d.numero}`,
          tipo_referencia:        'nota',
          tipo_comprobante:       tipoNota,
          serie:                  d.serie,
          numero:                 d.numero,
          periodo_mes:            parseInt(d.fecha.slice(5, 7)),
          periodo_ano:            parseInt(d.fecha.slice(0, 4)),
          fecha_emision:          d.fecha,
          fecha_recepcion:        d.fecha,
          contact_id:             compra.contact_id,
          proveedor_ruc:          compra.proveedor_ruc || '-',
          proveedor_nombre:       compra.proveedor_nombre || '-',
          // Se marca como 'servicio' porque una nota no ingresa mercadería:
          // si fuera 'mercaderia' el sistema le pediría Guía de Ingreso.
          tipo_compra:            'servicio',
          descripcion:            d.descripcion,
          unidad_medida:          'UND',
          cantidad:               1,
          precio_unitario:        base,
          base_imponible_gravada: base,
          igv_gravado:            igv,
          subtotal:               base,
          total:                  tot,
          currency:               compra.currency || 'PEN',
          tipo_cambio:            parseFloat(compra.tipo_cambio) || 1,
          estado_pago:            'pendiente',
          compra_referencia_id:   compraId,
          doc_referencia_tipo:    compra.tipo_comprobante,
          doc_referencia_serie:   compra.serie,
          doc_referencia_numero:  String(compra.numero || ''),
          motivo_nota_codigo:     d.motivo,
          motivo_nota_texto:      d.motivoTexto,
          estado_devolucion:      esDevolucionStock ? 'pendiente' : null,
          created_by:             d.usuarioId
        })

        // addCompra devuelve null si el INSERT falló en Supabase (RLS, CHECK,
        // NOT NULL, etc.) — sin este control la UI seguía de largo y mostraba
        // "Nota registrada ✅" aunque la fila nunca se guardó (bug real
        // encontrado 2026-09-03: al CHECK de tipo_comprobante le faltaba '07').
        if (!nota?.id) {
          throw new Error('Supabase rechazó el registro de la nota (revisa la consola del navegador para el detalle exacto). No se guardó nada.')
        }

        // Guardar el detalle por ítem (declarativo: no mueve stock). Si el
        // motivo es devolución (06/07), estado_devolucion='pendiente' ya
        // quedó marcado arriba — la Guía de Devolución es la que después
        // realmente saca la mercadería (pantalla "Devoluciones pendientes").
        if (detalleSeleccionado.length > 0 && nota?.id) {
          for (const linea of detalleSeleccionado) {
            await addNotaCreditoCompraDetalle({
              nota_compra_id: nota.id, compra_origen_id: compraId,
              item_id: linea.itemId, lote_id: linea.loteId,
              cantidad: linea.cantidad, precio_unitario: linea.precioUnitario,
              unidad_medida: linea.unidadMedida, created_by: d.usuarioId
            })
          }
        }

        // Ajustar la Cuenta por Pagar del comprobante original
        if (cxp) {
          try {
            const campos = tipoNota === TIPO_NC
              ? { monto_notas_credito: parseFloat((parseFloat(cxp.monto_notas_credito || 0) + tot).toFixed(2)) }
              : { monto_notas_debito:  parseFloat((parseFloat(cxp.monto_notas_debito || 0) + tot).toFixed(2)) }

            const nuevoSaldo = parseFloat(cxp.monto_total || 0)
              + parseFloat(cxp.monto_notas_debito || 0) + (tipoNota === TIPO_ND ? tot : 0)
              - parseFloat(cxp.monto_notas_credito || 0) - (tipoNota === TIPO_NC ? tot : 0)
              - parseFloat(cxp.monto_pagado || 0) - parseFloat(cxp.monto_anticipo_aplicado || 0)
            if (nuevoSaldo <= 0.01) campos.estado = d.anulaTotal ? 'anulado' : 'pagado'

            await updateCuentaPagar(cxp.id, campos)
          } catch (e) {
            console.warn('CxP no ajustada por la nota:', e.message)
            showToast('Nota registrada ⚠️ no se pudo ajustar la Cuenta por Pagar: ' + e.message, 'warning')
          }
        }

        // Motivo de anulación total: el comprobante original queda anulado
        if (d.anulaTotal && tipoNota === TIPO_NC) {
          await updateCompra(compraId, camposAnulacion({
            motivo: `Anulado por NC ${d.serie}-${d.numero}: ${d.motivoTexto}`,
            fecha: d.fecha, usuarioId: d.usuarioId
          }))
        }

        _invalidarCacheCompras()
        showToast(
          `${tipoNota === TIPO_NC ? 'Nota de Crédito' : 'Nota de Débito'} ${d.serie}-${d.numero} registrada ✅` +
          (d.anulaTotal ? ' — el comprobante origen quedó anulado' : ''),
          'success'
        )
        await renderCompras(true)
      }
    })
  } catch (e) {
    console.error('_abrirNotaCompra:', e)
    showToast('Error al preparar la nota: ' + e.message, 'danger')
  }
}
