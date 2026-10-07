// ============================================================================
// ventas/anulacion.js — parte de ventas.js (reorganizado 2026-09-25, sin cambios de lógica)
// Mapa completo de funciones: Claude outputs/glosario_funciones_erp.md
// ============================================================================
import { getLoteById, getVentaById, updateVenta, getCuentasCobrarByVenta, updateCuentaCobrar, reversarAsiento, ultimoErrorDelete, getKardexByVenta, deleteKardexMovimiento, getGuiasDespachoVenta, getGuiaDespachoVentaById, updateGuiaDespachoVenta, getDetalleGuiasDespachoVenta, recalcularLoteDesdeBultos, revertirBultosDeDetalleGuiaDespacho } from '../supabase-data.js'
import { showToast, formatNumber, formatQty } from '../helpers.js'
import { abrirModalAnulacion, camposAnulacion, estaAnulado, ESTADO_COMPROBANTE } from '../anulacion.js'
import { esNota, getMotivosNota } from '../notas.js'
import { _recalcularEstadoDespachoVenta, renderGuiasDespachoVenta } from './guias-despacho-lista.js'
import { _repVentasListos } from './reportes.js'
import { _guiaEstaVigente } from './ventas-editar.js'
import { _devolverAUnaZona, renderVentas } from './ventas-lista.js'

// ============================================================================
// ANULACIÓN DE FACTURAS DE VENTA
// ============================================================================
// Anular ≠ eliminar. El comprobante se conserva con su numeración (SUNAT lo
// exige) pero deja de contar en reportes, CxC e IGV.
//
// Orden de las validaciones — importa, porque cada bloqueo se resuelve en un
// sitio distinto del sistema:
//   1. Ya anulada          → nada que hacer.
//   2. Tiene cobros        → primero hay que revertir el cobro en Cuentas x
//                            Cobrar/Pagar; si no, quedaría plata cobrada
//                            contra un documento inexistente.
//   3. Tiene guías activas → primero se anulan las guías, que son las que
//                            devuelven el stock. Anular la venta no toca
//                            stock por sí sola (el stock lo mueve la guía).
//   4. CPE aceptado        → SUNAT ya lo recibió: legalmente se anula con Nota
//                            de Crédito, no borrando. Se avisa, pero se deja
//                            continuar marcándolo como anulado internamente.

window.anularVenta = async function (id) {
  try {
    const venta = await getVentaById(id)
    if (!venta) { showToast('No se encontró la venta', 'danger'); return }

    const numero = `${venta.serie || ''}-${String(venta.correlativo || '').padStart(8, '0')}`

    if (estaAnulado(venta)) {
      showToast(`${numero} ya está anulada`, 'info')
      return
    }

    // --- ¿Esta venta es una NC/ND que en su momento anuló a su comprobante
    //     origen? (motivo con anula_total:true, ver notas.js). Si es así,
    //     anularla debe revertir ese efecto — si no, el origen se queda
    //     huérfano en ANULADO para siempre (caso BBOL-00000012, 14/09: la
    //     boleta seguía "anulada" aunque la NC que la anuló ya no existía).
    //     Solo se reactiva si el motivo_anulacion del origen tiene la firma
    //     exacta que dejó ESTA nota al emitirse — así no se toca un origen
    //     anulado por otra razón ajena a esta nota.
    let origenAReactivar = null
    if (esNota(venta.tipo_comprobante) && venta.venta_referencia_id && venta.motivo_nota_codigo) {
      const motivos = await getMotivosNota(venta.tipo_comprobante)
      const motivoInfo = (motivos || []).find(m => String(m.codigo) === String(venta.motivo_nota_codigo))
      if (motivoInfo?.anula_total) {
        const origen = await getVentaById(venta.venta_referencia_id)
        const firmaEsperada = `Anulado por ${numero}:`
        if (origen && estaAnulado(origen) && (origen.motivo_anulacion || '').startsWith(firmaEsperada)) {
          origenAReactivar = origen
        }
      }
    }

    const bloqueos = []
    const efectos  = []

    if (origenAReactivar) {
      const numeroOrigen = `${origenAReactivar.serie || ''}-${String(origenAReactivar.correlativo || '').padStart(8, '0')}`
      efectos.push(`Reactivará el comprobante origen ${numeroOrigen} — quedó ANULADO cuando se emitió esta nota, y volverá a estado vigente.`)
    }

    // --- Cobros aplicados
    const cxcs = await getCuentasCobrarByVenta(id)
    let totalCobrado = 0
    for (const cxc of (cxcs || [])) {
      totalCobrado += (parseFloat(cxc.monto_cobrado) || 0) + (parseFloat(cxc.monto_retenido) || 0)
    }
    if (totalCobrado > 0.01) {
      bloqueos.push(`Tiene ${formatNumber(totalCobrado)} ya cobrado/retenido. Revierte los cobros en "Cuentas x Cobrar/Pagar" antes de anular.`)
    } else if ((cxcs || []).length > 0) {
      efectos.push(`Se anulará su Cuenta por Cobrar (${formatNumber(cxcs[0].monto_total)}).`)
    }

    // --- Guías de despacho activas (las que movieron stock)
    const guias = (await getGuiasDespachoVenta(true) || []).filter(g => g.venta_id === id && _guiaEstaVigente(g))
    if (guias.length > 0) {
      bloqueos.push(`Tiene ${guias.length} guía(s) de despacho activa(s) (${guias.map(g => g.numero_guia).join(', ')}). Anúlalas primero — son las que devuelven el stock a Inventario.`)
    }

    // --- Asiento contable
    if (venta.asiento_id) {
      efectos.push('Se generará un asiento de reversión (el asiento original no se borra).')
    }

    if (venta.cpe_estado === 'aceptado') {
      efectos.push('⚠ Este comprobante ya fue aceptado por SUNAT: ante la administración se anula emitiendo una Nota de Crédito. Aquí solo se marcará como anulado en tu sistema.')
    }

    efectos.push('Quedará como ANULADO con su número reservado; no se reutiliza la numeración.')
    efectos.push('Dejará de sumar en reportes, KPIs, dashboard e IGV del periodo.')

    abrirModalAnulacion({
      titulo: 'Anular Factura de Venta',
      documento: `${venta.tipo_comprobante === '01' ? 'Factura' : venta.tipo_comprobante === '03' ? 'Boleta' : 'Comprobante'} ${numero}`,
      detalle: `${venta.fecha_emision || ''} · ${venta.moneda || 'PEN'} ${formatNumber(venta.total)}`,
      efectos, bloqueos,
      onConfirmar: async ({ motivo, fecha, usuarioId }) => {
        // 1. Marcar el comprobante
        await updateVenta(id, {
          ...camposAnulacion({ motivo, fecha, usuarioId }),
          estado: 'anulada'
        })

        // 1b. Si vino de un PK, su cantidad vuelve a "pendiente" (estado del PK se recalcula)
        if (venta.packing_id) { try { await window.recalcularEstadoPacking?.(venta.packing_id) } catch (e) { console.warn('PK no recalculado:', e) } }

        // 2. Anular su cuenta por cobrar (ya validamos que no tiene cobros)
        for (const cxc of (cxcs || [])) {
          try {
            await updateCuentaCobrar(cxc.id, { estado: 'anulado' })
          } catch (e) {
            console.warn('CxC no anulada:', e.message)
          }
        }

        // 3. Reversar el asiento contable. Si falla, la anulación NO se
        //    revierte: el documento anulado es lo prioritario y el asiento se
        //    puede reversar a mano desde Contabilidad.
        if (venta.asiento_id) {
          try {
            await reversarAsiento(venta.asiento_id, usuarioId, `Anulación de venta ${numero}: ${motivo}`)
          } catch (e) {
            console.warn('Asiento no reversado:', e.message)
            showToast('Venta anulada ⚠️ el asiento no se pudo reversar: ' + e.message, 'warning')
          }
        }

        // 4. Reactivar el comprobante origen si esta nota lo había anulado
        //    (ver detección arriba, antes de abrir el modal).
        let origenReactivadoNumero = null
        if (origenAReactivar) {
          try {
            await updateVenta(origenAReactivar.id, {
              comprobante_anulado: false,
              estado_comprobante:  ESTADO_COMPROBANTE.VALIDO,
              estado:              'emitida',
              fecha_anulacion:     null,
              motivo_anulacion:    null,
              anulado_por:         null
            })
            origenReactivadoNumero = `${origenAReactivar.serie || ''}-${String(origenAReactivar.correlativo || '').padStart(8, '0')}`
          } catch (e) {
            console.warn('No se pudo reactivar el comprobante origen:', e.message)
            showToast('Nota anulada ⚠️ no se pudo reactivar el comprobante origen: ' + e.message, 'warning', 9000)
          }
        }

        _invalidarCacheVentas()
        showToast(
          `${numero} anulada ✅` + (origenReactivadoNumero ? ` — ${origenReactivadoNumero} reactivado` : ''),
          'success'
        )
        await renderVentas(true)
      }
    })
  } catch (e) {
    console.error('anularVenta:', e)
    showToast('Error al preparar la anulación: ' + e.message, 'danger')
  }
}

window.verMotivoAnulacion = async function (tipo, id) {
  try {
    const doc = tipo === 'venta' ? await getVentaById(id) : await getGuiaDespachoVentaById(id)
    if (!doc) return
    const etiqueta = tipo === 'venta'
      ? `${doc.serie || ''}-${String(doc.correlativo || '').padStart(8, '0')}`
      : doc.numero_guia
    const esRevertida = doc.estado === 'revertida'
    alert(
      `Documento: ${etiqueta}\n` +
      `Fecha de ${esRevertida ? 'reversión' : 'anulación'}: ${doc.fecha_anulacion || '(no registrada)'}\n\n` +
      `Motivo:\n${doc.motivo_anulacion || '(sin motivo registrado)'}`
    )
  } catch (e) {
    showToast('No se pudo leer el motivo: ' + e.message, 'danger')
  }
}

export function _invalidarCacheVentas() {
  import('../data-cache.js').then(({ invalidarVarios }) => {
    invalidarVarios(['ventas', 'detalle_ventas', 'cuentas_cobrar', 'lotes', 'stock_ubicaciones', 'kardex'])
  }).catch(() => {})
  Object.keys(_repVentasListos).forEach(k => { _repVentasListos[k] = false })
}

// ============================================================================
// ANULACIÓN DE GUÍAS DE DESPACHO DE VENTA
// ============================================================================
// Diferencia con "Eliminar": eliminar borra el registro y su numeración se
// pierde; anular conserva la guía como documento histórico (su número queda
// reservado) pero revierte todos sus efectos:
//   * devuelve la cantidad y las unidades al lote y a su zona de origen,
//   * borra los movimientos de kardex que generó esa guía,
//   * recalcula el estado de despacho de la venta (vuelve a quedar pendiente
//     o parcial, según lo que quede realmente despachado).

window.anularGuiaDespachoVenta = async function (id) {
  try {
    const guia = await getGuiaDespachoVentaById(id)
    if (!guia) { showToast('No se encontró la guía', 'danger'); return }

    if (estaAnulado(guia)) {
      showToast(`La guía ${guia.numero_guia} ya está anulada`, 'info')
      return
    }

    const detalles = await getDetalleGuiasDespachoVenta(id)
    const bloqueos = []

    // Si la venta ya fue anulada, la guía debería anularse igual (de hecho es
    // el orden correcto: guía primero). No se bloquea nada por eso.
    const venta = guia.venta_id ? await getVentaById(guia.venta_id) : null

    const totalKg = (detalles || []).reduce((s, d) => s + (parseFloat(d.cantidad) || 0), 0)

    const efectos = [
      `Se devolverán ${formatQty(totalKg)} a Inventario, a los mismos lotes y zonas de donde salieron (${detalles?.length || 0} línea(s)).`,
      'Se eliminarán los movimientos de kardex que generó esta guía.',
      'La venta volverá a figurar como pendiente o parcialmente despachada.',
      'La guía queda registrada como ANULADA; su número no se reutiliza.'
    ]

    abrirModalAnulacion({
      titulo: 'Anular Guía de Despacho',
      documento: `Guía ${guia.numero_guia}`,
      detalle: venta
        ? `Venta ${venta.serie || ''}-${String(venta.correlativo || '').padStart(8, '0')} · ${guia.fecha_guia || ''}`
        : (guia.fecha_guia || ''),
      efectos, bloqueos,
      onConfirmar: async ({ motivo, fecha, usuarioId }) => {
        // 1. Devolver el stock línea por línea. Igual que en eliminar: para
        //    lotes de peso variable, _devolverAUnaZona solo deja un valor
        //    intermedio en lote.cantidad (se pisa abajo con
        //    recalcularLoteDesdeBultos, la fuente de verdad real) y además
        //    hay que revertir los bultos concretos a 'disponible'.
        const lotesPesoVariableTocados = new Set()
        for (const dg of (detalles || [])) {
          await _devolverAUnaZona(
            dg.lote_id, dg.ubicacion_id,
            parseFloat(dg.cantidad) || 0,
            parseFloat(dg.cantidad_unidades) || 0
          )
          const lote = dg.lote_id ? await getLoteById(dg.lote_id) : null
          if (lote?.es_peso_variable) {
            await revertirBultosDeDetalleGuiaDespacho(dg.id, dg.ubicacion_id)
            lotesPesoVariableTocados.add(dg.lote_id)
          }
        }
        for (const loteId of lotesPesoVariableTocados) {
          await recalcularLoteDesdeBultos(loteId)
        }

        // 2. Borrar el kardex de esta guía (se identifica por documento_referencia)
        if (guia.venta_id) {
          const kardexVenta = await getKardexByVenta(guia.venta_id)
          for (const k of (kardexVenta || [])) {
            if (k.documento_referencia === guia.numero_guia) {
              const okKardex = await deleteKardexMovimiento(k.id)
              if (!okKardex) {
                const motivo = ultimoErrorDelete()
                throw new Error(`No se pudo eliminar el movimiento de Kardex #${k.id} de la guía ${guia.numero_guia}: ${motivo?.mensaje || 'motivo desconocido'}. Se detiene la anulación para no dejar el Kardex descuadrado.`)
              }
            }
          }
        }

        // 3. Marcar la guía como anulada (el detalle se conserva: es el
        //    sustento de qué se había despachado y por eso se pudo revertir)
        await updateGuiaDespachoVenta(id, camposAnulacion(
          { motivo, fecha, usuarioId }, { usaEstadoComprobante: false }
        ))

        // 4. Recalcular el estado de despacho de la venta
        if (guia.venta_id) await _recalcularEstadoDespachoVenta(guia.venta_id)

        _invalidarCacheVentas()
        showToast(`Guía ${guia.numero_guia} anulada ✅ — stock devuelto a Inventario`, 'success')
        await renderGuiasDespachoVenta(true)
        await renderVentas(true)
      }
    })
  } catch (e) {
    console.error('anularGuiaDespachoVenta:', e)
    showToast('Error al preparar la anulación: ' + e.message, 'danger')
  }
}
