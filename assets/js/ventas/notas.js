// ============================================================================
// ventas/notas.js — parte de ventas.js (reorganizado 2026-09-25, sin cambios de lógica)
// Mapa completo de funciones: Claude outputs/glosario_funciones_erp.md
// ============================================================================
import { getLoteById, updateLote, getItemById, addVenta, getVentas, getVentaById, getCuentasCobrarByVenta, updateCuentaCobrar, generarNumeroVenta, getStockUbicacionesByLote, addStockUbicacion, updateStockUbicacion, getUbicacionCustomers, addKardexMovimiento, getGuiasDespachoVenta, updateGuiaDespachoVenta, getDetalleGuiasDespachoVentaByVenta, recalcularLoteDesdeBultos, getLoteBultosByLote, reingresarBultosPorNotaCredito, addNotaCreditoVentaDetalle, getNotaCreditoVentaDetalleByNota } from '../supabase-data.js'
import { showToast, formatNumber, formatQty } from '../helpers.js'
import { estaAnulado } from '../anulacion.js'
import { abrirModalNota, TIPO_NC, TIPO_ND, esNota, nombreTipoComprobante } from '../notas.js'
import { getModuloConfig } from '../config-modulo.js'
import { _invalidarCacheVentas } from './anulacion.js'
import { _recalcularEstadoDespachoVenta } from './guias-despacho-lista.js'
import { _nombreCliente } from './helpers.js'
import { _guiaEstaVigente } from './ventas-editar.js'
import { renderVentas } from './ventas-lista.js'

// ============================================================================
// NOTAS DE CRÉDITO Y DÉBITO — EMITIDAS AL CLIENTE
// ============================================================================
// Una nota se guarda como una venta más, con tipo_comprobante '07' o '08' y
// apuntando a la venta que modifica (venta_referencia_id). Su importe se
// guarda en positivo; el signo lo aplican los reportes vía signoDocumento().
//
// Efecto sobre la Cuenta por Cobrar del comprobante origen:
//   NC → sube `monto_notas_credito` (baja el saldo exigible)
//   ND → sube `monto_notas_debito`  (sube el saldo exigible)
// Si el motivo anula la operación (01, 02 o 06 del Catálogo 09), además se
// marca la venta original como anulada y su CxC como 'anulado'.

window.abrirModalNotaCredito = function (ventaId) { _abrirNotaVenta(ventaId, TIPO_NC) }
window.abrirModalNotaDebito  = function (ventaId) { _abrirNotaVenta(ventaId, TIPO_ND) }

// ── Devolución de mercadería dentro de una NC ───────────────────────────────
// Solo aplica a Notas de Crédito sobre una venta que SÍ tiene guía de
// despacho (algo realmente salió del almacén). Si no hay guía, la NC es
// puramente un ajuste monetario (como era antes) — nunca salió mercadería,
// no hay nada que reingresar a Kardex.
//
// Patrón de reingreso (ver 46_nota_credito_devolucion_stock.sql): el bulto
// vendido NO se "resucita" tal cual (ese registro es el historial de ESA
// venta) — pasa a estado='devuelto_cliente' y se crea un BULTO NUEVO
// 'disponible' con bulto_origen_id apuntando al vendido, porque casi nunca
// pesa exactamente igual al repesarlo en recepción.
let _ncDevLineas = []       // líneas de despacho de la venta con algo pendiente de devolver
let _ncDevTieneDespacho = false

/** Arma _ncDevLineas a partir de las guías de despacho (no anuladas) de la venta. Cada línea de peso variable trae sus bultos vendidos aún reingresables (no devueltos antes); las de peso fijo traen la cantidad despachada como tope. */
async function _prepararDevolucionStockNota(ventaId) {
  const guiasVenta = (await getGuiasDespachoVenta(true) || []).filter(g => g.venta_id === ventaId && _guiaEstaVigente(g))
  if (guiasVenta.length === 0) { _ncDevTieneDespacho = false; _ncDevLineas = []; return }
  const guiaPorId = new Map(guiasVenta.map(g => [g.id, g.numero_guia || `#${g.id}`]))

  const detalles = await getDetalleGuiasDespachoVentaByVenta(ventaId)
  const lineas = []
  for (const dg of (detalles || [])) {
    if (!dg.lote_id) continue
    const [lote, item] = await Promise.all([getLoteById(dg.lote_id), getItemById(dg.item_id)])
    if (!lote) continue
    const guiaNumero = guiaPorId.get(dg.guia_id) || ''

    if (lote.es_peso_variable) {
      const bultosLote = await getLoteBultosByLote(lote.id)
      const vendidos = (bultosLote || []).filter(b => b.detalle_guia_despacho_id === dg.id && b.estado === 'vendido')
      if (vendidos.length === 0) continue
      lineas.push({
        detalleGuiaId: dg.id, itemId: dg.item_id, nombre: item?.nombre || `Item #${dg.item_id}`,
        loteId: lote.id, numeroLote: lote.numero_lote, ubicacionId: dg.ubicacion_id, guiaNumero, guiaId: dg.guia_id,
        unidadMedida: lote.unidad_medida || 'KG', esPesoVariable: true,
        bultos: vendidos.map(b => ({ id: b.id, peso: parseFloat(b.peso) || 0 }))
      })
    } else {
      lineas.push({
        detalleGuiaId: dg.id, itemId: dg.item_id, nombre: item?.nombre || `Item #${dg.item_id}`,
        loteId: dg.lote_id, numeroLote: dg.numero_lote, ubicacionId: dg.ubicacion_id, guiaNumero, guiaId: dg.guia_id,
        unidadMedida: item?.unidad_medida || 'KG', esPesoVariable: false,
        cantidadDespachada: parseFloat(dg.cantidad) || 0
      })
    }
  }
  _ncDevTieneDespacho = true
  _ncDevLineas = lineas
}

/** HTML de la sección de devolución, inyectada en #nota-extra del modal genérico. Vacío si la venta no tiene guía de despacho. */
function _renderDevolucionStockNota() {
  if (!_ncDevTieneDespacho) return ''
  if (_ncDevLineas.length === 0) {
    return `<div style="margin-top:6px; padding:10px 12px; border-radius:var(--radius-md); background:var(--bg-secondary); font-size:0.82rem; color:var(--text-secondary);">
      Esta venta tiene guía de despacho, pero ya no queda nada pendiente de devolver (todo lo despachado ya fue devuelto o vendido nuevamente).
    </div>`
  }
  const filas = _ncDevLineas.map((l, idx) => {
    if (l.esPesoVariable) {
      const bultosHtml = l.bultos.map((b, bIdx) => `
        <div style="display:flex; align-items:center; gap:6px; padding:4px 0;">
          <input type="checkbox" id="ncDev-${idx}-b${bIdx}-chk" onchange="window.toggleBultoDevolucionNota(${idx},${bIdx})">
          <label for="ncDev-${idx}-b${bIdx}-chk" style="min-width:70px;">Bulto #${b.id}</label>
          <span style="color:var(--text-secondary); font-size:0.78rem;">vendido: ${b.peso.toFixed(2)} ${l.unidadMedida}</span>
          <span style="font-size:0.78rem;">devuelto:</span>
          <input type="number" id="ncDev-${idx}-b${bIdx}-peso" value="${b.peso}" step="0.01" min="0.01" style="width:80px;" disabled>
        </div>`).join('')
      return `
        <div style="border:1px solid var(--border-color); border-radius:var(--radius-md); padding:10px 12px; margin-bottom:8px;">
          <strong>${l.nombre}</strong> <span style="color:var(--text-secondary); font-size:0.8rem;">— lote ${l.numeroLote} (peso variable)</span>
          ${bultosHtml}
        </div>`
    }
    return `
      <div style="border:1px solid var(--border-color); border-radius:var(--radius-md); padding:10px 12px; margin-bottom:8px; display:flex; align-items:center; gap:10px; flex-wrap:wrap;">
        <div><strong>${l.nombre}</strong> <span style="color:var(--text-secondary); font-size:0.8rem;">— lote ${l.numeroLote}</span></div>
        <span style="color:var(--text-secondary); font-size:0.78rem;">despachado: ${l.cantidadDespachada} ${l.unidadMedida}</span>
        <label style="font-size:0.78rem;">Cantidad a devolver:</label>
        <input type="number" id="ncDev-${idx}-cantidad" value="0" step="0.01" min="0" max="${l.cantidadDespachada}" style="width:90px;" oninput="window._actualizarAvisoMotivoIncorrectoNota()">
      </div>`
  }).join('')

  return `
    <div id="ncDev-requerido-aviso" style="display:none; margin-top:10px; padding:8px 10px; border-radius:var(--radius-md); background:rgba(245,158,11,.14); color:var(--color-warning); font-size:0.8rem;">
      El motivo elegido es una devolución: selecciona qué se devuelve para reingresarlo al stock.
    </div>
    <div id="ncDev-motivo-incorrecto-aviso" style="display:none; margin-top:10px; padding:8px 10px; border-radius:var(--radius-md); background:rgba(245,158,11,.14); color:var(--color-warning); font-size:0.8rem;">
      ⚠ Marcaste mercadería para devolver, pero el motivo elegido no es de devolución ("06"/"07") ni anula la operación completa — revisa que el motivo sea el correcto: al emitir la nota, lo marcado aquí SIEMPRE reingresa a Inventario, sin importar el motivo elegido.
    </div>
    <div style="margin-top:10px;">
      <strong style="display:block; margin-bottom:6px; font-size:0.85rem;">📦 Devolución de mercadería (esta venta tiene guía de despacho)</strong>
      <small style="display:block; margin-bottom:8px; color:var(--text-secondary);">
        Marca/ingresa lo que el cliente realmente devuelve. Se reingresa a la MISMA zona de donde salió (se puede reubicar después con un Traslado Interno). El importe de la nota se sigue ingresando arriba: no se calcula solo, tú decides cuánto vale la devolución.
      </small>
      ${filas}
    </div>`
}

// Advierte cuando el usuario ya marcó mercadería para devolver pero el
// motivo elegido no es de devolución (06/07) ni anula la operación
// completa (ej. lo dejó marcado bajo "04 — Descuento global"). El reingreso
// de onEmitir NO filtra por motivo: lo que esté marcado en el checklist al
// emitir SIEMPRE reingresa a Inventario — este aviso es solo para que el
// usuario confirme que el motivo elegido tiene sentido con eso, no para
// decirle que "no va a pasar nada" (antes decía eso y era falso). Caso que
// originó este checklist: BBOL-00000012, motivo 01 sin nada marcado a mano
// — ver project_historial_movimientos_correlativo.md.
window._actualizarAvisoMotivoIncorrectoNota = function () {
  const aviso = document.getElementById('ncDev-motivo-incorrecto-aviso')
  if (!aviso) return
  const sel = document.getElementById('notaMotivo')
  const motivo = sel?.value
  const anulaTotal = sel?.selectedOptions?.[0]?.getAttribute('data-anula') === '1'
  const esMotivoDevolucion = motivo === '06' || motivo === '07' || anulaTotal
  const seleccion = _leerDevolucionStockNota()
  aviso.style.display = (!esMotivoDevolucion && seleccion.length > 0) ? 'block' : 'none'
}

window.toggleBultoDevolucionNota = function (idx, bIdx) {
  const chk = document.getElementById(`ncDev-${idx}-b${bIdx}-chk`)
  const inp = document.getElementById(`ncDev-${idx}-b${bIdx}-peso`)
  if (inp) inp.disabled = !chk?.checked
  window._actualizarAvisoMotivoIncorrectoNota()
}

/** Marca Y BLOQUEA todas las líneas del checklist de devolución al 100% —
 *  se usa cuando el motivo elegido anula/revierte la operación completa (ver
 *  onMotivoCambio en _abrirNotaVenta): con guía activa, un motivo "anula
 *  todo" no deja otra opción que devolver TODA la mercadería, así que el
 *  checklist se bloquea (no solo se premarca) para que no se pueda guardar
 *  una devolución parcial con un motivo que dice "total". Al salir de un
 *  motivo así, vuelve al estado normal editable. */
function _ncDevMarcarTodo(bloquear) {
  _ncDevLineas.forEach((l, idx) => {
    if (l.esPesoVariable) {
      l.bultos.forEach((b, bIdx) => {
        const chk = document.getElementById(`ncDev-${idx}-b${bIdx}-chk`)
        const inp = document.getElementById(`ncDev-${idx}-b${bIdx}-peso`)
        if (chk) { chk.checked = bloquear; chk.disabled = bloquear }
        if (inp) {
          if (bloquear) inp.value = b.peso
          inp.disabled = true // solo se habilita al marcar el checkbox a mano (toggleBultoDevolucionNota)
        }
      })
    } else {
      const inp = document.getElementById(`ncDev-${idx}-cantidad`)
      if (inp) {
        inp.value = bloquear ? l.cantidadDespachada : 0
        inp.disabled = bloquear
      }
    }
  })
  window._actualizarAvisoMotivoIncorrectoNota()
}

/** Lee del DOM lo que el usuario seleccionó/tipeó. Solo incluye líneas con algo realmente marcado (>0). */
function _leerDevolucionStockNota() {
  const seleccion = []
  _ncDevLineas.forEach((l, idx) => {
    if (l.esPesoVariable) {
      const bultos = []
      l.bultos.forEach((b, bIdx) => {
        const chk = document.getElementById(`ncDev-${idx}-b${bIdx}-chk`)
        if (!chk?.checked) return
        const peso = parseFloat(document.getElementById(`ncDev-${idx}-b${bIdx}-peso`)?.value || 0)
        if (peso > 0) bultos.push({ bultoId: b.id, pesoDevuelto: peso })
      })
      if (bultos.length > 0) seleccion.push({ ...l, bultos })
    } else {
      const cantidad = parseFloat(document.getElementById(`ncDev-${idx}-cantidad`)?.value || 0)
      if (cantidad > 0) seleccion.push({ ...l, cantidadDevuelta: Math.min(cantidad, l.cantidadDespachada) })
    }
  })
  return seleccion
}

async function _abrirNotaVenta(ventaId, tipoNota) {
  try {
    const venta = await getVentaById(ventaId)
    if (!venta) { showToast('No se encontró la venta', 'danger'); return }

    const numeroOrigen = `${venta.serie || ''}-${String(venta.correlativo || '').padStart(8, '0')}`
    const bloqueos = []

    if (estaAnulado(venta)) {
      bloqueos.push('El comprobante ya está anulado: no se le pueden emitir notas.')
    }
    if (esNota(venta.tipo_comprobante)) {
      bloqueos.push('Este documento ya es una nota. Las notas se emiten sobre facturas o boletas, no sobre otras notas.')
    }

    // Total ya afectado por notas previas: una NC no puede llevar el
    // comprobante a un importe negativo.
    const todas = await getVentas()
    const notasPrevias = (todas || []).filter(v => v.venta_referencia_id === ventaId && !estaAnulado(v))
    const ncPrevias = notasPrevias.filter(v => String(v.tipo_comprobante) === TIPO_NC)
      .reduce((s, v) => s + (parseFloat(v.total) || 0), 0)
    const ndPrevias = notasPrevias.filter(v => String(v.tipo_comprobante) === TIPO_ND)
      .reduce((s, v) => s + (parseFloat(v.total) || 0), 0)

    const totalOrigen = parseFloat(venta.total || 0)
    const disponibleNC = parseFloat((totalOrigen + ndPrevias - ncPrevias).toFixed(2))

    if (tipoNota === TIPO_NC && disponibleNC <= 0.01 && bloqueos.length === 0) {
      bloqueos.push(`El comprobante ya está totalmente acreditado con notas previas (${formatNumber(ncPrevias)}).`)
    }

    const cxcs = await getCuentasCobrarByVenta(ventaId)
    const cxc = (cxcs || [])[0] || null
    const saldo = cxc
      ? parseFloat(cxc.monto_total || 0) + parseFloat(cxc.monto_notas_debito || 0)
        - parseFloat(cxc.monto_notas_credito || 0) - parseFloat(cxc.monto_cobrado || 0) - parseFloat(cxc.monto_retenido || 0)
        - parseFloat(cxc.monto_anticipo_aplicado || 0)
      : totalOrigen

    const cliente = await _nombreCliente(venta.contact_id)
    const cfg = getModuloConfig('ventas')
    // SUNAT (RS 097-2012) exige que la serie de la nota inicie con la misma
    // letra que el comprobante que modifica: 'F' si es Factura, 'B' si es
    // Boleta. Antes se usaba siempre la serie de Factura (FC01/FD01) sin
    // importar el origen.
    const esBoletaOrigen = String(venta.tipo_comprobante) === '03'
    const serieSugerida = tipoNota === TIPO_NC
      ? (esBoletaOrigen ? (cfg.serieNotaCreditoBoleta || 'BC01') : (cfg.serieNotaCredito || 'FC01'))
      : (esBoletaOrigen ? (cfg.serieNotaDebitoBoleta  || 'BD01') : (cfg.serieNotaDebito  || 'FD01'))
    const correlativo = await generarNumeroVenta(tipoNota, serieSugerida)

    // Devolución de mercadería: solo tiene sentido en una NC (una ND nunca
    // "devuelve" stock, suma valor). Se arma ANTES de abrir el modal para
    // que la sección ya esté lista si el motivo elegido es de devolución.
    if (tipoNota === TIPO_NC) {
      await _prepararDevolucionStockNota(ventaId)
    } else {
      _ncDevTieneDespacho = false
      _ncDevLineas = []
    }

    await abrirModalNota({
      tipoNota, contexto: 'venta',
      documento: `${nombreTipoComprobante(venta.tipo_comprobante)} ${numeroOrigen}`,
      detalle: `${cliente} · ${venta.fecha_emision || ''} · ${venta.moneda || 'PEN'} ${formatNumber(totalOrigen)}`,
      totalOrigen: disponibleNC,
      saldoOrigen: saldo,
      igvPorcentaje: parseFloat(cfg.igvDefault) || 18,
      serieSugerida,
      numeroSugerido: String(correlativo).padStart(8, '0'),
      bloqueos,
      // Modal ancho + detalle de mercadería ARRIBA de los importes cuando hay
      // guía de despacho de por medio — mismo estándar que Compras, salvo que
      // aquí los importes de la NC los sigue escribiendo el usuario a mano
      // (soloReposicionar): el detalle de devolución trae cantidades/lotes,
      // no el precio de venta, así que no hay de dónde sumar el importe solo.
      anchoAmplio: _ncDevTieneDespacho,
      renderExtra: () => _renderDevolucionStockNota(),
      onMotivoCambio: (motivo, anulaTotal) => {
        window.setModoDetalleNota?.(_ncDevTieneDespacho, { soloReposicionar: true })
        // Los motivos '06' (devolución total) y '07' (devolución por ítem)
        // del Catálogo 09 SUNAT son los que exigen seleccionar qué se
        // devuelve; el resto (descuentos, correcciones, etc.) la dejan
        // opcional aunque haya guía de despacho.
        const aviso = document.getElementById('ncDev-requerido-aviso')
        if (aviso) aviso.style.display = (_ncDevTieneDespacho && (motivo === '06' || motivo === '07')) ? 'block' : 'none'

        // Motivo que anula la operación completa (ej. '01') con guía activa:
        // TODA la mercadería despachada vuelve a Inventario, no es opcional
        // — se premarca el 100% del checklist en vez de dejarlo vacío a la
        // espera de que el usuario recuerde marcarlo a mano (así se perdió
        // el reingreso de BBOL-00000012, ver project_historial_movimientos_correlativo.md).
        // Al salir de un motivo "anula todo" se vuelve a limpiar, para no
        // dejar mercadería marcada por accidente si el usuario cambia de
        // opinión sobre el motivo.
        if (_ncDevTieneDespacho) _ncDevMarcarTodo(anulaTotal)

        window._actualizarAvisoMotivoIncorrectoNota()
      },
      validarExtra: () => {
        if (!_ncDevTieneDespacho) return { ok: true }
        const sel = document.getElementById('notaMotivo')
        const motivo = sel?.value
        const anulaTotal = sel?.selectedOptions?.[0]?.getAttribute('data-anula') === '1'
        const esMotivoDevolucion = motivo === '06' || motivo === '07' || anulaTotal
        if (!esMotivoDevolucion) return { ok: true }
        const seleccion = _leerDevolucionStockNota()
        if (seleccion.length === 0) {
          return { ok: false, mensaje: 'El motivo elegido implica devolución de mercadería y la venta tiene guía de despacho: selecciona qué se devuelve para reingresarlo al stock (o cambia el motivo si no corresponde devolver mercadería).' }
        }
        // Motivo "anula todo" con guía activa: no hay devolución parcial que
        // valga — si alguna línea quedó sin marcar al 100%, no se guarda
        // (defensa extra: el checklist ya viene bloqueado al 100% desde
        // _ncDevMarcarTodo, esto cubre que igual se intente forzar).
        if (anulaTotal) {
          const completo = _ncDevLineas.every((l, idx) => {
            if (l.esPesoVariable) {
              return l.bultos.every((b, bIdx) => document.getElementById(`ncDev-${idx}-b${bIdx}-chk`)?.checked)
            }
            const val = parseFloat(document.getElementById(`ncDev-${idx}-cantidad`)?.value || 0)
            return val >= l.cantidadDespachada - 0.0001
          })
          if (!completo) {
            return { ok: false, mensaje: 'Este motivo anula/revierte el 100% de la operación: no se puede dejar mercadería sin devolver. Marca todas las líneas o elige otro motivo.' }
          }
        }
        return { ok: true }
      },
      onEmitir: async (d) => {
        // 0. Si va a reingresar mercadería de una guía, confirmar ANTES de
        // escribir nada — con el detalle producto por producto (y de qué
        // guía sale cada uno) y avisando qué más se mueve (kardex, guía).
        if (_ncDevTieneDespacho) {
          const seleccionConfirmar = _leerDevolucionStockNota()
          if (seleccionConfirmar.length > 0) {
            const porGuia = new Map()
            for (const l of seleccionConfirmar) {
              const key = l.guiaNumero || '(sin guía)'
              const cantidad = l.esPesoVariable
                ? l.bultos.reduce((s, b) => s + (b.pesoDevuelto || 0), 0)
                : l.cantidadDevuelta
              if (!porGuia.has(key)) porGuia.set(key, [])
              porGuia.get(key).push(`  • ${l.nombre} — lote ${l.numeroLote} — ${formatQty(cantidad)} ${l.unidadMedida}`)
            }
            const bloques = [...porGuia.entries()]
              .map(([guia, filas]) => `Guía ${guia} pasará a REVERTIDA:\n${filas.join('\n')}`)
              .join('\n\n')
            const mensaje = `Esta nota va a reingresar mercadería a Inventario:\n\n${bloques}\n\n` +
              `Se generará un movimiento de INGRESO en Kardex por cada línea.` +
              (d.anulaTotal ? '\nEl comprobante origen quedará marcado como anulado.' : '') +
              `\n\n¿Confirmas guardar la nota?`
            if (!window.confirm(mensaje)) {
              const cancelado = new Error('Emisión cancelada por el usuario')
              cancelado.cancelado = true
              throw cancelado
            }
          }
        }

        // 1. Crear la nota como un documento de venta propio
        const nota = await addVenta({
          numero: `${d.serie}-${String(d.numero || '').padStart(8, '0')}`,
          tipo_comprobante: tipoNota,
          serie: d.serie,
          correlativo: d.numero,
          contact_id: venta.contact_id,
          fecha_emision: d.fecha,
          fecha_vencimiento: null,
          periodo_contable: (d.fecha || '').slice(0, 7),
          moneda: venta.moneda || 'PEN',
          tipo_cambio: parseFloat(venta.tipo_cambio) || 1,
          base_imponible: parseFloat(d.base.toFixed(2)),
          igv: parseFloat(d.igv.toFixed(2)),
          total: parseFloat(d.importe.toFixed(2)),
          estado: 'emitida',
          estado_pago: 'pendiente',
          cpe_estado: 'no_enviado',
          vendedor_id: venta.vendedor_id || null,
          descripcion: d.descripcion,
          observaciones: `${d.motivoTexto} — ref. ${numeroOrigen}`,
          // Referencia al documento que modifica (FK + los campos de texto
          // que exige el CPE/SUNAT)
          venta_referencia_id: ventaId,
          doc_referencia_tipo: venta.tipo_comprobante,
          doc_referencia_serie: venta.serie,
          doc_referencia_numero: String(venta.correlativo || ''),
          motivo_nota_codigo: d.motivo,
          motivo_nota_texto: d.motivoTexto,
          created_by: d.usuarioId
        })

        // 1.5. Reingreso de stock por devolución (si el usuario marcó algo)
        if (_ncDevTieneDespacho) {
          const seleccion = _leerDevolucionStockNota()
          if (seleccion.length > 0) {
            try {
              const lotesPesoVariableTocados = new Set()
              for (const linea of seleccion) {
                if (linea.esPesoVariable) {
                  const devoluciones = linea.bultos.map(b => ({
                    bultoVendidoId: b.bultoId, pesoDevuelto: b.pesoDevuelto, ubicacionId: linea.ubicacionId
                  }))
                  const resultado = await reingresarBultosPorNotaCredito(devoluciones, nota.id, d.usuarioId)
                  for (let i = 0; i < resultado.length; i++) {
                    const r = resultado[i]
                    lotesPesoVariableTocados.add(r.loteId)
                    await addNotaCreditoVentaDetalle({
                      nota_venta_id: nota.id, venta_origen_id: ventaId, item_id: linea.itemId,
                      lote_id: r.loteId, cantidad: devoluciones[i].pesoDevuelto, unidad_medida: linea.unidadMedida,
                      lote_bulto_nuevo_id: r.bultoNuevo?.id || null, reingresa_stock: true, created_by: d.usuarioId
                    })
                  }
                } else {
                  const lote = await getLoteById(linea.loteId)
                  const nuevaCantidadLote = parseFloat(((parseFloat(lote?.cantidad) || 0) + linea.cantidadDevuelta).toFixed(4))
                  // Unidades: se derivan de peso_por_unidad (mismo criterio
                  // que Despacho/Traslados) — esta devolución no declara
                  // unidades por línea, así que no hay un dato real que leer,
                  // pero sí un peso_por_unidad confiable del lote. Antes esto
                  // se ignoraba por completo: el peso volvía al lote pero las
                  // unidades se quedaban desfasadas.
                  const unidadesDevueltas = (lote?.peso_por_unidad && lote.peso_por_unidad > 0)
                    ? parseFloat((linea.cantidadDevuelta / lote.peso_por_unidad).toFixed(2))
                    : 0
                  const nuevaUnidadesLote = parseFloat(((parseFloat(lote?.cantidad_unidades) || 0) + unidadesDevueltas).toFixed(4))
                  await updateLote(linea.loteId, { cantidad: nuevaCantidadLote, cantidad_unidades: nuevaUnidadesLote })

                  const filas = await getStockUbicacionesByLote(linea.loteId)
                  const fila = (filas || []).find(f => f.ubicacion_id === linea.ubicacionId)
                  if (fila) {
                    await updateStockUbicacion(fila.id, {
                      cantidad: parseFloat(((parseFloat(fila.cantidad) || 0) + linea.cantidadDevuelta).toFixed(4)),
                      cantidad_unidades: parseFloat(((parseFloat(fila.cantidad_unidades) || 0) + unidadesDevueltas).toFixed(4))
                    })
                  } else {
                    await addStockUbicacion({
                      lote_id: linea.loteId, ubicacion_id: linea.ubicacionId,
                      cantidad: linea.cantidadDevuelta, cantidad_unidades: unidadesDevueltas
                    })
                  }

                  await addNotaCreditoVentaDetalle({
                    nota_venta_id: nota.id, venta_origen_id: ventaId, item_id: linea.itemId,
                    lote_id: linea.loteId, cantidad: linea.cantidadDevuelta, unidad_medida: linea.unidadMedida,
                    reingresa_stock: true, created_by: d.usuarioId
                  })
                }
              }

              // Lotes con bultos: recalcular cantidad/cantidad_unidades desde
              // los bultos disponibles reales (los de peso fijo ya se
              // actualizaron directamente arriba, no se tocan de nuevo).
              for (const loteId of lotesPesoVariableTocados) await recalcularLoteDesdeBultos(loteId)

              // Kardex: un movimiento 'entrada' por línea devuelta, desde la
              // zona virtual Partners/Customers (espejo exacto de la salida
              // que hizo la guía de despacho) hacia la zona real de recepción.
              const customersZona = await getUbicacionCustomers()
              for (const linea of seleccion) {
                const loteActual = await getLoteById(linea.loteId)
                const costoUnitLote = parseFloat(loteActual?.costo_unitario || 0)
                const cantidadLinea = linea.esPesoVariable
                  ? linea.bultos.reduce((s, b) => s + (b.pesoDevuelto || 0), 0)
                  : linea.cantidadDevuelta
                // Unidades del movimiento de Kardex: antes quedaba
                // hardcodeado en 0 aunque el lote/stock_ubicaciones SÍ ya
                // recibían las unidades correctas más arriba — esto dejaba
                // el propio Kardex (y por tanto la vista stock_ubicaciones,
                // que se calcula desde acá) mostrando 0 unidades en la
                // devolución. Peso variable: 1 bulto devuelto = 1 unidad
                // (mismo criterio que recalcularLoteDesdeBultos). Peso fijo:
                // se deriva de peso_por_unidad, igual que arriba.
                const unidadesLinea = linea.esPesoVariable
                  ? linea.bultos.length
                  : ((loteActual?.peso_por_unidad && loteActual.peso_por_unidad > 0)
                      ? parseFloat((cantidadLinea / loteActual.peso_por_unidad).toFixed(2))
                      : 0)
                await addKardexMovimiento({
                  item_id: linea.itemId, lote_id: linea.loteId,
                  ubicacion_origen_id: customersZona?.id || null, ubicacion_destino_id: linea.ubicacionId,
                  fecha: d.fecha, tipo_movimiento: 'entrada', concepto: 'Devolución de cliente (Nota de Crédito)',
                  documento_referencia: `${d.serie}-${d.numero}`,
                  cantidad_entrada: cantidadLinea, cantidad_salida: 0,
                  cantidad_unidades_entrada: unidadesLinea, cantidad_unidades_salida: 0,
                  costo_unitario: costoUnitLote,
                  valor_entrada: parseFloat((cantidadLinea * costoUnitLote).toFixed(2)), valor_salida: 0,
                  moneda: loteActual?.moneda || 'PEN', tipo_cambio: parseFloat(loteActual?.tipo_cambio) || 1,
                  costo_unit_original: parseFloat(loteActual?.costo_unit_original ?? costoUnitLote),
                  saldo_cantidad: parseFloat(loteActual?.cantidad || 0),
                  saldo_valor: parseFloat(((parseFloat(loteActual?.cantidad) || 0) * costoUnitLote).toFixed(2)),
                  saldo_unidades: parseFloat(loteActual?.cantidad_unidades || 0),
                  venta_id: ventaId, created_by: d.usuarioId
                })
              }

              // Guías: si TODO lo pendiente de una guía quedó cubierto en esta
              // devolución, esa guía pasa a 'revertida' — no 'anulada', porque
              // a diferencia de anular/eliminar una guía (que BORRA su kardex
              // de salida), acá el kardex de salida original se queda intacto
              // y solo se agregó el de entrada arriba (ver 6.4 del manual). Si
              // solo se devolvió una parte, la guía se deja como estaba: no
              // existe "revertida parcial".
              try {
                const lineasPorGuia = new Map()
                for (const l of _ncDevLineas) {
                  if (!l.guiaId) continue
                  if (!lineasPorGuia.has(l.guiaId)) lineasPorGuia.set(l.guiaId, [])
                  lineasPorGuia.get(l.guiaId).push(l)
                }
                for (const [guiaId, lineasGuia] of lineasPorGuia) {
                  const totalmenteCubierta = lineasGuia.every(l => {
                    const sel = seleccion.find(s => s.detalleGuiaId === l.detalleGuiaId)
                    if (!sel) return false
                    return l.esPesoVariable
                      ? l.bultos.every(b => (sel.bultos || []).some(sb => sb.bultoId === b.id))
                      : (sel.cantidadDevuelta || 0) >= l.cantidadDespachada - 0.0001
                  })
                  if (totalmenteCubierta) {
                    await updateGuiaDespachoVenta(guiaId, {
                      estado: 'revertida',
                      fecha_anulacion: d.fecha,
                      motivo_anulacion: `Revertida por NC ${d.serie}-${d.numero}: ${d.motivoTexto}`,
                      anulado_por: d.usuarioId
                    })
                  }
                }
              } catch (eGuia) {
                console.error('Error marcando guía como revertida:', eGuia)
                showToast('Nota emitida ⚠️ el stock reingresó pero no se pudo actualizar el estado de la guía: ' + eGuia.message, 'warning', 9000)
              }

              // Con la(s) guía(s) ya marcadas (o no) como revertidas, el
              // % despachado de la venta origen puede haber bajado.
              try { await _recalcularEstadoDespachoVenta(ventaId) } catch (e) { console.warn('estado_despacho tras NC:', e.message) }

              showToast('Stock reingresado a Inventario por la devolución', 'success')
            } catch (eDev) {
              console.error('Error reingresando stock por NC:', eDev)
              showToast('Nota emitida ⚠️ el reingreso de stock falló: ' + eDev.message + ' — revísalo manualmente en Inventario', 'warning', 9000)
            }
          }
        }

        // 2. Ajustar la Cuenta por Cobrar del comprobante original
        if (cxc) {
          try {
            const campos = tipoNota === TIPO_NC
              ? { monto_notas_credito: parseFloat((parseFloat(cxc.monto_notas_credito || 0) + d.importe).toFixed(2)) }
              : { monto_notas_debito:  parseFloat((parseFloat(cxc.monto_notas_debito || 0) + d.importe).toFixed(2)) }

            // Si la NC deja el saldo en cero, la cuenta queda saldada.
            const nuevoSaldo = parseFloat(cxc.monto_total || 0)
              + parseFloat(cxc.monto_notas_debito || 0) + (tipoNota === TIPO_ND ? d.importe : 0)
              - parseFloat(cxc.monto_notas_credito || 0) - (tipoNota === TIPO_NC ? d.importe : 0)
              - parseFloat(cxc.monto_cobrado || 0) - parseFloat(cxc.monto_retenido || 0)
              - parseFloat(cxc.monto_anticipo_aplicado || 0)
            if (nuevoSaldo <= 0.01) campos.estado = d.anulaTotal ? 'anulado' : 'cobrado'

            await updateCuentaCobrar(cxc.id, campos)
          } catch (e) {
            console.warn('CxC no ajustada por la nota:', e.message)
            showToast('Nota emitida ⚠️ no se pudo ajustar la Cuenta por Cobrar: ' + e.message, 'warning')
          }
        }

        // 3. Ya NO se marca el comprobante origen como anulado aquí (hasta
        // 2026-09-15 sí se hacía, con camposAnulacion + estado:'anulada').
        // SUNAT distingue dos mecanismos: comunicación de baja (deja el
        // comprobante oficialmente anulado, solo procede sin efecto económico
        // todavía) vs. Nota de Crédito (el comprobante queda "registrado pero
        // neutralizado" — sigue vigente/aceptado). Emitir una NC nunca debe
        // anular el comprobante origen — ver 6.4 del manual de diseño. El
        // aviso de "revertido por NC" se calcula al vuelo para mostrarlo
        // (ver disponibleNC más arriba y el badge en la tabla de Ventas), sin
        // tocar comprobante_anulado/estado_comprobante.

        _invalidarCacheVentas()
        showToast(`${tipoNota === TIPO_NC ? 'Nota de Crédito' : 'Nota de Débito'} ${d.serie}-${d.numero} emitida ✅`, 'success')
        void nota
        await renderVentas(true)
      }
    })
  } catch (e) {
    console.error('_abrirNotaVenta:', e)
    showToast('Error al preparar la nota: ' + e.message, 'danger')
  }
}

// ============================================================================
// VER DETALLE DE UNA NOTA DE CRÉDITO/DÉBITO YA EMITIDA
// ============================================================================
// Muestra las glosas (ítem/lote/cantidad) que componen el importe de la
// nota — leídas de `nota_credito_venta_detalle`. Se arma SIEMPRE, sin
// importar el motivo usado (antes solo se preguntaba por esto para 06/07;
// ahora con el premarcado automático de _ncDevMarcarTodo una NC motivo "01"
// con guía activa también genera detalle, y hay que poder revisarlo).
// Si la nota no tiene filas de detalle (ninguna reingresó stock), se avisa
// en vez de mostrar una tabla vacía.

function _asegurarModalDetalleNotaVenta() {
  if (document.getElementById('modal-detalle-nota-venta')) return
  const div = document.createElement('div')
  div.id = 'modal-detalle-nota-venta'
  div.className = 'modal'
  div.innerHTML = `
    <div class="modal-content" id="ndv-content" style="width:min(94vw, 700px); max-width:min(94vw, 700px);">
      <div class="modal-header">
        <h3 class="modal-title">Detalle de la nota</h3>
        <button class="modal-close" onclick="window.closeModal('modal-detalle-nota-venta')">&times;</button>
      </div>
      <div style="padding:20px; display:flex; flex-direction:column; gap:14px;">
        <div id="ndv-cabecera" style="padding:12px 14px; background:var(--bg-secondary); border-radius:var(--radius-md); border-left:3px solid var(--color-info); font-size:0.88rem; line-height:1.6;"></div>
        <div id="ndv-detalle"></div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" onclick="window.closeModal('modal-detalle-nota-venta')">Cerrar</button>
      </div>
    </div>`
  document.body.appendChild(div)
}

window.verDetalleNotaVenta = async function (notaId) {
  try {
    const nota = await getVentaById(notaId)
    if (!nota) { showToast('No se encontró la nota', 'danger'); return }

    const numero = `${nota.serie || ''}-${String(nota.correlativo || '').padStart(8, '0')}`
    const detalles = await getNotaCreditoVentaDetalleByNota(notaId)

    let detalleHtml
    if (!detalles || detalles.length === 0) {
      detalleHtml = `<div style="padding:14px; border-radius:var(--radius-md); background:var(--bg-secondary); font-size:0.85rem; color:var(--text-secondary);">
        Esta nota no tiene registrado un detalle de devolución de mercadería — no se marcó nada en el checklist de devolución al emitirla (o el importe corresponde a algo que no mueve stock, ej. un descuento).
      </div>`
    } else {
      const filas = await Promise.all(detalles.map(async d => {
        const [item, lote] = await Promise.all([
          d.item_id ? getItemById(d.item_id) : null,
          d.lote_id ? getLoteById(d.lote_id) : null
        ])
        return `<tr style="border-top:1px solid var(--border-color);">
          <td style="padding:8px 10px;">${item?.nombre || `Item #${d.item_id}`}</td>
          <td style="padding:8px 10px;">${lote?.numero_lote || d.lote_id || '-'}</td>
          <td style="padding:8px 10px; text-align:right;">${formatQty(parseFloat(d.cantidad) || 0)} ${d.unidad_medida || ''}</td>
        </tr>`
      }))
      detalleHtml = `
        <div>
          <strong style="display:block; margin-bottom:6px; font-size:0.85rem;">📦 Mercadería reingresada a Inventario</strong>
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

    _asegurarModalDetalleNotaVenta()
    document.getElementById('ndv-cabecera').innerHTML = `
      <div style="font-size:0.72rem; text-transform:uppercase; letter-spacing:.4px; color:var(--text-secondary);">${nombreTipoComprobante(nota.tipo_comprobante)}</div>
      <div style="font-weight:600; font-size:1.05rem; margin-top:2px;">${numero}</div>
      <div style="font-size:0.85rem; color:var(--text-secondary); margin-top:2px;">
        ${nota.motivo_nota_codigo ? `Motivo ${nota.motivo_nota_codigo} — ${nota.motivo_nota_texto || ''}` : ''}
        ${nota.doc_referencia_serie ? ` · ref. ${nota.doc_referencia_serie}-${String(nota.doc_referencia_numero || '').padStart(8, '0')}` : ''}
        ${nota.moneda ? ` · ${nota.moneda} ${formatNumber(nota.total)}` : ''}
      </div>`
    document.getElementById('ndv-detalle').innerHTML = detalleHtml
    window.openModal('modal-detalle-nota-venta')
  } catch (e) {
    console.error('verDetalleNotaVenta:', e)
    showToast('Error al cargar el detalle de la nota: ' + e.message, 'danger')
  }
}
