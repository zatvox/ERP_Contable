// ============================================================================
// ventas/cpe-asiento.js — parte de ventas.js (reorganizado 2026-09-25, sin cambios de lógica)
// Mapa completo de funciones: Claude outputs/glosario_funciones_erp.md
// ============================================================================
import { getCurrentUser } from '../auth-supabase.js'
import { getContactById, getVentaById, updateVenta, getDetalleVentas, generarAsientoVenta } from '../supabase-data.js'
import { emitirCPE, emitirNota } from '../sunat-api.js'
import { showToast } from '../helpers.js'
import { TIPO_NC, esNota } from '../notas.js'
import { renderVentas } from './ventas-lista.js'

// ============================================================================
// CPE — Emitir Comprobante Electrónico con NUBEFACT
// ============================================================================

window.emitirCPEVenta = async function(ventaId) {
  try {
    const venta   = await getVentaById(ventaId)
    const lineas  = await getDetalleVentas(ventaId)
    const cliente = await getContactById(venta.contact_id)

    // Construir datos del cliente para NUBEFACT
    const ventaConCliente = {
      ...venta,
      cliente_tipo_doc:   cliente?.tipo_documento === 'RUC' ? '6' : '1',
      cliente_doc:        cliente?.ruc || cliente?.dni || '',
      cliente_nombre:     cliente?.razon_social || cliente?.nombre || '',
      cliente_direccion:  cliente?.direccion || '',
      cliente_email:      cliente?.email || ''
    }

    showToast('Emitiendo CPE con NUBEFACT...', 'info')

    const resultado = await emitirCPE(ventaConCliente, lineas, null)

    if (!resultado.ok) {
      showToast('Error NUBEFACT: ' + resultado.error, 'danger')
      // Si el error es de configuración (token/RUC no puestos aún, típico en
      // modo de prueba) NO se marca 'rechazado' — SUNAT nunca llegó a ver el
      // comprobante, así que "rechazado" sería engañoso. Se deja como estaba
      // para poder reintentar sin confusión cuando se configure NUBEFACT.
      if (!/no configurado/i.test(resultado.error || '')) {
        await updateVenta(ventaId, { cpe_estado: 'rechazado' })
      }
      return
    }

    await updateVenta(ventaId, {
      cpe_estado:       'aceptado',
      nubefact_id:      resultado.nubefact_id,
      nubefact_enlace:  resultado.enlace_pdf,
      nubefact_qr:      resultado.qr,
      nubefact_hash:    resultado.hash,
      xml_url:          resultado.enlace_xml,
      pdf_url:          resultado.enlace_pdf
    })

    showToast('CPE emitido y aceptado por SUNAT ✅', 'success')
    await renderVentas(true)
  } catch (e) {
    console.error('emitirCPEVenta:', e)
    showToast('Error al emitir CPE: ' + e.message, 'danger')
  }
}

// Emisión electrónica de Notas de Crédito/Débito (tipo_comprobante 07/08).
// Usa emitirNota() en vez de emitirCPE(): arma los campos adicionales que
// NUBEFACT exige para notas (documento_que_se_modifica_*, tipo_de_nota_de_
// crédito/débito según catálogo 09/10 SUNAT) — antes el botón "Emitir CPE"
// de una fila de nota llamaba por error a emitirCPEVenta(), que no incluye
// esos campos y la nota quedaba mal formada ante NUBEFACT.
window.emitirNotaVenta = async function(notaId) {
  try {
    const nota    = await getVentaById(notaId)
    if (!nota) { showToast('No se encontró la nota', 'danger'); return }
    if (!esNota(nota.tipo_comprobante)) { showToast('Este comprobante no es una nota', 'warning'); return }
    if (!nota.doc_referencia_tipo || !nota.doc_referencia_serie || !nota.doc_referencia_numero) {
      showToast('La nota no tiene registrado el comprobante que modifica: no se puede emitir', 'danger')
      return
    }

    const lineas  = await getDetalleVentas(notaId)
    const cliente = await getContactById(nota.contact_id)

    const notaConCliente = {
      ...nota,
      cliente_tipo_doc:   cliente?.tipo_documento === 'RUC' ? '6' : '1',
      cliente_doc:        cliente?.ruc || cliente?.dni || '',
      cliente_nombre:     cliente?.razon_social || cliente?.nombre || '',
      cliente_direccion:  cliente?.direccion || '',
      cliente_email:      cliente?.email || ''
    }
    const docRef = {
      tipo:   nota.doc_referencia_tipo,
      serie:  nota.doc_referencia_serie,
      numero: nota.doc_referencia_numero
    }

    showToast(`Emitiendo ${nota.tipo_comprobante === TIPO_NC ? 'Nota de Crédito' : 'Nota de Débito'} con NUBEFACT...`, 'info')

    const resultado = await emitirNota(notaConCliente, lineas, docRef, null)

    if (!resultado.ok) {
      showToast('Error NUBEFACT: ' + (resultado.error || 'la nota fue rechazada'), 'danger')
      // Mismo criterio que emitirCPEVenta: un error de configuración (sin
      // token/RUC, modo de prueba) no es un rechazo real de SUNAT.
      if (!/no configurado/i.test(resultado.error || '')) {
        await updateVenta(notaId, { cpe_estado: 'rechazado' })
      }
      return
    }

    await updateVenta(notaId, {
      cpe_estado:      'aceptado',
      nubefact_enlace: resultado.enlace_pdf,
      xml_url:         resultado.enlace_xml,
      pdf_url:         resultado.enlace_pdf
    })

    showToast('Nota emitida y aceptada por SUNAT ✅', 'success')
    await renderVentas(true)
  } catch (e) {
    console.error('emitirNotaVenta:', e)
    showToast('Error al emitir la nota: ' + e.message, 'danger')
  }
}

// ============================================================================
// GENERAR ASIENTO DE VENTA
// ============================================================================

window.generarAsientoDeVenta = async function(ventaId) {
  try {
    const user = await getCurrentUser()
    await generarAsientoVenta(ventaId, user?.id)
    showToast('Asiento contable generado ✅', 'success')
    await renderVentas(true)
  } catch (e) {
    showToast('Error al generar asiento: ' + e.message, 'danger')
  }
}
