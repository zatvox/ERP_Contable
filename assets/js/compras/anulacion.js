// ============================================================================
// compras/anulacion.js — parte de compras.js (reorganizado 2026-09-25, sin cambios de lógica)
// Mapa completo de funciones: Claude outputs/glosario_funciones_erp.md
// ============================================================================
import { getCompraById, updateCompra, getLoteById, updateLote, getItemById, getGuiasIngresoCompra, getGuiaIngresoCompraById, updateGuiaIngresoCompra, getDetalleGuiasIngresoCompra, getKardexByCompra, deleteKardexMovimiento, getCuentasPagarByCompra, updateCuentaPagar, ultimoErrorDelete, updateStockUbicacion, getStockUbicacionesByLote, reversarAsiento, getNotaCreditoCompraDetalleByNota, getTodosDetalleGuiasDevolucionCompra } from '../supabase-data.js'
import { showToast, formatNumber, formatQty } from '../helpers.js'
import { abrirModalAnulacion, camposAnulacion, estaAnulado } from '../anulacion.js'
import { TIPO_NC } from '../notas.js'
import { renderCompras } from './compras-lista.js'
import { _cargarComprasConGuia, renderGuias } from './guias-ingreso-lista.js'
import { _repComprasListos } from './reportes.js'

// ============================================================================
// ANULACIÓN DE FACTURAS DE COMPRA
// ============================================================================
// Espejo exacto de la anulación de ventas. Las validaciones cambian de lado:
//   * en vez de cobros, se revisan los PAGOS al proveedor;
//   * en vez de guías de despacho (que sacan stock), se revisan las guías de
//     INGRESO (que lo metieron): mientras la guía siga activa, hay mercadería
//     en el almacén sustentada por un comprobante que se quiere anular.

window.anularCompra = async function (id) {
  try {
    const compra = await getCompraById(id)
    if (!compra) { showToast('No se encontró la compra', 'danger'); return }

    const comprobante = `${compra.tipo_comprobante || ''} ${compra.serie || ''}-${compra.numero || ''}`.trim()

    if (estaAnulado(compra)) {
      showToast(`${comprobante} ya está anulada`, 'info')
      return
    }

    const bloqueos = []
    const efectos  = []

    // --- Pagos aplicados (vía cuentas_pagar)
    const cxps = await getCuentasPagarByCompra(id)
    let totalPagado = 0
    for (const cxp of (cxps || [])) totalPagado += parseFloat(cxp.monto_pagado) || 0

    if (totalPagado > 0.01) {
      bloqueos.push(`Tiene ${formatNumber(totalPagado)} ya pagado al proveedor. Revierte los pagos en "Cuentas x Cobrar/Pagar" antes de anular.`)
    } else if ((cxps || []).length > 0) {
      efectos.push(`Se anulará su Cuenta por Pagar (${formatNumber(cxps[0].monto_total)}).`)
    }

    // --- Guías de ingreso activas: son las que metieron el stock
    const guias = (await getGuiasIngresoCompra(true) || []).filter(g => g.compra_id === id && g.estado !== 'anulada')
    if (guias.length > 0) {
      bloqueos.push(`Tiene ${guias.length} guía(s) de ingreso activa(s) (${guias.map(g => g.numero_guia).join(', ')}). Anúlalas primero — son las que retiran el stock de Inventario.`)
    }

    // --- NC de devolución con stock ya retirado por una Guía de Devolución:
    // anular la NC sin revertir esa guía dejaría el stock afuera sin ninguna
    // NC que lo respalde.
    if (String(compra.tipo_comprobante) === TIPO_NC && compra.estado_devolucion && compra.estado_devolucion !== 'pendiente') {
      const detalleNota = await getNotaCreditoCompraDetalleByNota(id)
      const idsDetalle = new Set((detalleNota || []).map(d => d.id))
      const todasLasGuiasDetalle = await getTodosDetalleGuiasDevolucionCompra()
      const guiasIds = new Set((todasLasGuiasDetalle || []).filter(dg => idsDetalle.has(dg.nota_credito_compra_detalle_id)).map(dg => dg.guia_id))
      if (guiasIds.size > 0) {
        bloqueos.push(`Esta NC ya tiene ${guiasIds.size} Guía(s) de Devolución que retiraron stock (estado: ${compra.estado_devolucion}). Elimínalas primero en la pestaña Guía de Remisión — revierten el stock automáticamente.`)
      }
    }

    if (compra.asiento_id) {
      efectos.push('Se generará un asiento de reversión (el asiento original no se borra).')
    }

    efectos.push('Quedará como ANULADA con estado de comprobante "0"; ya no suma al crédito fiscal del periodo.')
    efectos.push('Dejará de aparecer en reportes de compras, KPIs y dashboard.')

    abrirModalAnulacion({
      titulo: 'Anular Factura de Compra',
      documento: comprobante || `Compra #${compra.id}`,
      detalle: `${compra.proveedor_nombre || ''} · ${compra.fecha_emision || ''} · ${compra.currency || 'PEN'} ${formatNumber(compra.total)}`,
      efectos, bloqueos,
      onConfirmar: async ({ motivo, fecha, usuarioId }) => {
        await updateCompra(id, camposAnulacion({ motivo, fecha, usuarioId }))

        for (const cxp of (cxps || [])) {
          try {
            await updateCuentaPagar(cxp.id, { estado: 'anulado' })
          } catch (e) {
            console.warn('CxP no anulada:', e.message)
          }
        }

        if (compra.asiento_id) {
          try {
            await reversarAsiento(compra.asiento_id, usuarioId, `Anulación de compra ${comprobante}: ${motivo}`)
          } catch (e) {
            console.warn('Asiento no reversado:', e.message)
            showToast('Compra anulada ⚠️ el asiento no se pudo reversar: ' + e.message, 'warning')
          }
        }

        _invalidarCacheCompras()
        showToast(`${comprobante} anulada ✅`, 'success')
        await renderCompras(true)
      }
    })
  } catch (e) {
    console.error('anularCompra:', e)
    showToast('Error al preparar la anulación: ' + e.message, 'danger')
  }
}

// ============================================================================
// ANULACIÓN DE GUÍAS DE INGRESO DE COMPRA
// ============================================================================
// Anular una guía de ingreso RETIRA del almacén lo que ella había metido.
// Por eso, a diferencia de la guía de despacho, aquí sí hay que validar antes:
// si parte de esa mercadería ya se vendió o se trasladó, el stock actual del
// lote es menor que lo ingresado y retirarlo dejaría cantidades negativas.
// En ese caso se bloquea y se indica exactamente qué lote es el problema.

window.anularGuiaIngreso = async function (id) {
  try {
    const guia = await getGuiaIngresoCompraById(id)
    if (!guia) { showToast('No se encontró la guía', 'danger'); return }

    if (estaAnulado(guia)) {
      showToast(`La guía ${guia.numero_guia} ya está anulada`, 'info')
      return
    }

    const detalles = await getDetalleGuiasIngresoCompra(id)
    const bloqueos = []
    const aRetirar = []
    let totalKg = 0

    for (const dg of (detalles || [])) {
      if (!dg.lote_id) continue
      const lote = await getLoteById(dg.lote_id)
      if (!lote) continue // el lote ya no existe: nada que retirar por esta línea

      const ingresado = parseFloat(dg.cantidad) || 0
      const actual    = parseFloat(lote.cantidad) || 0
      totalKg += ingresado

      // Da igual si el lote lo creó esta guía o ya existía: en ambos casos se
      // retira EXACTAMENTE lo que esta guía aportó. Lo único que hay que
      // garantizar es que esa cantidad siga disponible.
      if (actual + 0.0001 < ingresado) {
        const item = await getItemById(dg.item_id)
        const consumido = parseFloat((ingresado - actual).toFixed(4))
        bloqueos.push(
          `${item?.nombre || 'Item #' + dg.item_id} (lote ${lote.numero_lote}): ingresaron ${formatQty(ingresado)} pero solo quedan ${formatQty(actual)} ` +
          `— ya se consumieron ${formatQty(consumido)}. Anula primero la venta o el traslado que los consumió.`
        )
      } else {
        aRetirar.push({ lote, dg, ingresado, compartido: lote.guia_id !== id })
      }
    }

    const compra = guia.compra_id ? await getCompraById(guia.compra_id) : null

    const compartidos = aRetirar.filter(x => x.compartido).length
    const efectos = [
      `Se retirarán ${formatQty(totalKg)} de Inventario de ${aRetirar.length} lote(s).` +
        (compartidos > 0
          ? ` ${compartidos} de ellos son lotes preexistentes: solo se descuenta lo que esta guía aportó, el resto del lote se mantiene.`
          : ' Los lotes quedarán en cero.'),
      'Se eliminarán los movimientos de kardex que generó esta guía.',
      'La compra volverá a figurar como pendiente de guía.',
      'La guía queda registrada como ANULADA; su número no se reutiliza.'
    ]

    abrirModalAnulacion({
      titulo: 'Anular Guía de Ingreso',
      documento: `Guía ${guia.numero_guia}`,
      detalle: compra
        ? `Compra ${compra.serie || ''}-${compra.numero || ''} · ${compra.proveedor_nombre || ''} · ${guia.fecha_guia || ''}`
        : (guia.fecha_guia || ''),
      efectos, bloqueos,
      onConfirmar: async ({ motivo, fecha, usuarioId }) => {
        // 1. Retirar el stock: se descuenta lo ingresado del lote y de sus
        //    ubicaciones. Como ya validamos que nadie lo consumió, el lote
        //    queda en 0 y sus filas de stock_ubicaciones también. También se
        //    descuentan las unidades (dg.cantidad_unidades, lo que ESTA línea
        //    aportó) — antes se ignoraban, mismo bug que en _planRevertirGuiaIngreso.
        for (const { lote, dg, ingresado } of aRetirar) {
          const nuevaCantidad = parseFloat(Math.max(0, (parseFloat(lote.cantidad) || 0) - ingresado).toFixed(4))
          const unidadesARetirar = parseFloat(dg.cantidad_unidades) || 0
          const nuevaUnidades = parseFloat(Math.max(0, (parseFloat(lote.cantidad_unidades) || 0) - unidadesARetirar).toFixed(4))
          await updateLote(lote.id, { cantidad: nuevaCantidad, cantidad_unidades: nuevaUnidades })

          // Se descuenta primero de la zona a la que esta guía ingresó; solo
          // si ahí no alcanza se toma del resto (caso raro: hubo traslados).
          const filas = await getStockUbicacionesByLote(lote.id)
          const ordenadas = [...(filas || [])].sort((a, b) =>
            (b.ubicacion_id === dg.ubicacion_id ? 1 : 0) - (a.ubicacion_id === dg.ubicacion_id ? 1 : 0))

          let porDescontar = ingresado
          let unidPorDescontar = unidadesARetirar
          for (const f of ordenadas) {
            if (porDescontar <= 0 && unidPorDescontar <= 0) break
            const disponible = parseFloat(f.cantidad) || 0
            const quita = Math.min(disponible, porDescontar)
            const disponibleUnid = parseFloat(f.cantidad_unidades) || 0
            const quitaUnid = Math.min(disponibleUnid, unidPorDescontar)
            await updateStockUbicacion(f.id, {
              cantidad: parseFloat((disponible - quita).toFixed(4)),
              cantidad_unidades: parseFloat((disponibleUnid - quitaUnid).toFixed(4))
            })
            porDescontar = parseFloat((porDescontar - quita).toFixed(4))
            unidPorDescontar = parseFloat((unidPorDescontar - quitaUnid).toFixed(4))
          }
        }

        // 2. Borrar el kardex de esta guía (filtrando por los lotes tocados,
        //    para no borrar movimientos de otras guías de la misma compra)
        if (guia.compra_id) {
          const idsLotes = aRetirar.map(x => x.lote.id)
          const kardexCompra = await getKardexByCompra(guia.compra_id)
          for (const k of (kardexCompra || [])) {
            if (idsLotes.includes(k.lote_id)) {
              const okKardex = await deleteKardexMovimiento(k.id)
              if (!okKardex) {
                const motivo = ultimoErrorDelete()
                throw new Error(`No se pudo eliminar el movimiento de Kardex #${k.id}: ${motivo?.mensaje || 'motivo desconocido'}. Se detiene la anulación para no dejar el Kardex descuadrado.`)
              }
            }
          }
        }

        // 3. Marcar la guía como anulada
        await updateGuiaIngresoCompra(id, camposAnulacion(
          { motivo, fecha, usuarioId }, { usaEstadoComprobante: false }
        ))

        _invalidarCacheCompras()
        showToast(`Guía ${guia.numero_guia} anulada ✅ — stock retirado de Inventario`, 'success')
        await _cargarComprasConGuia(true)
        await renderGuias(true)
        await renderCompras(true)
      }
    })
  } catch (e) {
    console.error('anularGuiaIngreso:', e)
    showToast('Error al preparar la anulación: ' + e.message, 'danger')
  }
}

window.verMotivoAnulacionCompra = async function (tipo, id) {
  try {
    const doc = tipo === 'compra' ? await getCompraById(id) : await getGuiaIngresoCompraById(id)
    if (!doc) return
    const etiqueta = tipo === 'compra'
      ? `${doc.tipo_comprobante || ''} ${doc.serie || ''}-${doc.numero || ''}`.trim()
      : doc.numero_guia
    alert(
      `Documento: ${etiqueta}\n` +
      `Fecha de anulación: ${doc.fecha_anulacion || '(no registrada)'}\n\n` +
      `Motivo:\n${doc.motivo_anulacion || '(sin motivo registrado)'}`
    )
  } catch (e) {
    showToast('No se pudo leer el motivo: ' + e.message, 'danger')
  }
}

export function _invalidarCacheCompras() {
  import('../data-cache.js').then(({ invalidarVarios }) => {
    invalidarVarios(['compras', 'compra_detalles', 'cuentas_pagar', 'lotes', 'stock_ubicaciones', 'kardex'])
  }).catch(() => {})
  Object.keys(_repComprasListos).forEach(k => { _repComprasListos[k] = false })
}
