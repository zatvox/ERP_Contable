// ============================================================================
// ventas/cotizaciones.js — parte de ventas.js (reorganizado 2026-09-25, sin cambios de lógica)
// Mapa completo de funciones: Claude outputs/glosario_funciones_erp.md
// ============================================================================
import { S } from './state.js'
import { getCurrentUser } from '../auth-supabase.js'
import { getSalesQuotes, getSalesQuoteById, addSalesQuote, updateSalesQuote } from '../supabase-data.js'
import { showToast, formatNumber, formatQty } from '../helpers.js'
import { _nombreCliente } from './helpers.js'

// ============================================================================
// TAB: COTIZACIONES (legacy — se mantiene funcional)
// ============================================================================

export async function renderCotizaciones() {
  try {
    const cotizaciones = await getSalesQuotes()
    const container    = document.getElementById('tabla-cot')
    if (!container) return

    if (!cotizaciones || cotizaciones.length === 0) {
      container.innerHTML = '<p style="text-align:center; color:var(--text-secondary); padding:20px;">Sin cotizaciones</p>'
      return
    }

    let html = `
      <table>
        <thead>
          <tr>
            <th>Número</th><th>Cliente</th><th>Moneda</th>
            <th style="text-align:right;">Total</th>
            <th>Estado</th><th>Acciones</th>
          </tr>
        </thead>
        <tbody>
    `

    for (const cot of cotizaciones.sort((a,b) => b.id - a.id)) {
      const cliente = await _nombreCliente(cot.customer_id || cot.contact_id)
      html += `<tr>
        <td><strong>${cot.numero || cot.id}</strong></td>
        <td>${cliente}</td>
        <td>${cot.currency || cot.moneda || 'PEN'}</td>
        <td style="text-align:right;">${parseFloat(cot.total || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
        <td><span class="badge badge-${cot.status === 'confirmado' ? 'success' : 'secondary'}">${cot.status || 'borrador'}</span></td>
        <td>
          <button class="btn btn-small btn-secondary" onclick="window.verCotizacion(${cot.id})">Ver</button>
          ${cot.status !== 'confirmado' ? `<button class="btn btn-small btn-primary" onclick="window.confirmarCotizacion(${cot.id})">Confirmar</button>` : ''}
        </td>
      </tr>`
    }

    html += '</tbody></table>'
    container.innerHTML = html
  } catch (error) {
    console.error('renderCotizaciones:', error)
    showToast('Error al cargar cotizaciones', 'danger')
  }
}

window.verCotizacion = async function(id) {
  try {
    const cot     = await getSalesQuoteById(id)
    if (!cot) { showToast('No encontrada', 'warning'); return }
    const cliente = await _nombreCliente(cot.customer_id || cot.contact_id)
    alert(`COT #${cot.numero || cot.id}
Cliente: ${cliente}
Cantidad: ${formatQty(cot.cantidad || 0)}
Precio Unitario: ${cot.currency || 'PEN'} ${formatNumber(cot.precio_unitario)}
Subtotal: ${formatNumber(cot.subtotal)}
IGV: ${formatNumber(cot.igv)}
Total: ${formatNumber(cot.total)}
Estado: ${cot.status || '-'}`)
  } catch (e) {
    showToast('Error: ' + e.message, 'danger')
  }
}

window.confirmarCotizacion = async function(id) {
  // 2026-09-25 (migración 57, decisión de Luis): confirmar una cotización
  // SOLO cambia su estado. Antes además generaba asiento de venta + costo y
  // descontaba lotes.cantidad sin kardex (stock fantasma). La venta real, con
  // su asiento, stock y kardex, se registra en "Nueva Venta" + Guía de Despacho.
  try {
    if (!confirm('¿Marcar esta cotización como confirmada?\n\nNo mueve stock ni genera asientos: la venta se registra en "Nueva Venta".')) return
    const cot = await getSalesQuoteById(id)
    if (!cot) { showToast('No encontrada', 'warning'); return }
    if (cot.status === 'confirmado') { showToast('Ya fue confirmada', 'warning'); return }
    await updateSalesQuote(id, { status: 'confirmado' })
    showToast('Cotización confirmada ✅', 'success')
    await renderCotizaciones()
  } catch (e) {
    console.error('confirmarCotizacion:', e)
    showToast('Error: ' + e.message, 'danger')
  }
}

window.guardarCotizacion = async function() {
  try {
    const user       = await getCurrentUser()
    const customerId = parseInt(document.getElementById('cotCliente')?.value || 0)
    const loteId     = parseInt(document.getElementById('cotLote')?.value || 0)
    const cantidad   = parseInt(document.getElementById('cotCantidad')?.value || 0)
    const igvPct     = parseInt(document.getElementById('cotIGV')?.value || 18)
    const moneda     = document.getElementById('cotMoneda')?.value || 'PEN'
    const tipoPago   = document.getElementById('cotTipoPago')?.value || 'credito'

    if (!customerId || !loteId || !cantidad) {
      showToast('Complete todos los campos', 'warning')
      return
    }

    const lote = S._lotes.find(l => l.id === loteId)
    if (!lote) { showToast('Lote no encontrado', 'warning'); return }

    const precioUnitario = parseFloat(lote.costo_unitario || 0)
    const subtotal       = parseFloat((cantidad * precioUnitario).toFixed(2))
    const igvAmount      = parseFloat((subtotal * igvPct / 100).toFixed(2))
    const total          = parseFloat((subtotal + igvAmount).toFixed(2))

    await addSalesQuote({
      customer_id: customerId, lote_id: loteId, cantidad,
      precio_unitario: precioUnitario, igv: igvAmount, subtotal, total,
      currency: moneda, tipo_pago: tipoPago, status: 'borrador',
      user: user?.nombre || user?.email,
      fecha: new Date().toISOString().split('T')[0]
    })

    showToast('Cotización creada', 'success')
    window.closeModal('modal-nueva-cot')
    await renderCotizaciones()
    const form = document.getElementById('formNewCot')
    if (form) form.reset()
  } catch (e) {
    console.error('guardarCotizacion:', e)
    showToast('Error: ' + e.message, 'danger')
  }
}
