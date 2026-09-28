// ============================================================================
// inventario/partidas.js — parte de inventario.js (reorganizado 2026-09-25, sin cambios de lógica)
// Mapa completo de funciones: Claude outputs/glosario_funciones_erp.md
// ============================================================================
import { getItems, getPartidas, addPartida, deletePartida } from '../supabase-data.js'
import { showToast } from '../helpers.js'

// ============================================================================
// PARTIDAS ARANCELARIAS
// ============================================================================

export async function renderPartidas() {
  try {
    const container = document.getElementById('tabla-partidas')
    if (!container) return

    const [partidas, productos] = await Promise.all([getPartidas(), getItems()])
    const prodMap = {}
    productos.forEach(p => { prodMap[p.id] = { nombre: p.nombre, sku: p.sku } })

    // Poblar el select de producto del modal "Nueva Partida"
    const selProd = document.getElementById('partProducto')
    if (selProd) {
      selProd.innerHTML = '<option value="">-- Selecciona --</option>' +
        productos.map(p => `<option value="${p.id}">${p.sku ? '(' + p.sku + ') ' : ''}${p.nombre}</option>`).join('')
    }

    if (!partidas || partidas.length === 0) {
      container.innerHTML = '<p style="text-align:center; color:var(--text-secondary); padding:20px;">Sin partidas registradas</p>'
      return
    }

    let html = `
      <table>
        <thead>
          <tr>
            <th>N° Partida</th><th>Código</th><th>Producto</th><th>Descripción</th>
            <th>Fecha Inicio</th><th>Fecha Fin</th><th>Estado</th><th>Acciones</th>
          </tr>
        </thead>
        <tbody>
    `

    partidas.forEach(p => {
      const badgeColor = p.status === 'activa' ? 'success' : p.status === 'cerrada' ? 'secondary' : 'danger'
      html += `<tr>
        <td><strong>${p.numero_partida}</strong></td>
        <td>${prodMap[p.product_id]?.sku || '-'}</td>
        <td>${prodMap[p.product_id]?.nombre || '-'}</td>
        <td style="font-size:0.85rem;">${p.descripcion || '-'}</td>
        <td>${p.fecha_inicio || '-'}</td>
        <td>${p.fecha_fin || '-'}</td>
        <td><span class="badge badge-${badgeColor}">${p.status || '-'}</span></td>
        <td>
          <button class="btn btn-small btn-danger" onclick="window.eliminarPartida(${p.id})">Eliminar</button>
        </td>
      </tr>`
    })

    html += '</tbody></table>'
    container.innerHTML = html
  } catch (e) {
    console.error('renderPartidas:', e)
    showToast('Error al cargar partidas', 'danger')
  }
}

window.guardarPartida = async function() {
  try {
    const productId    = parseInt(document.getElementById('partProducto')?.value || 0)
    const numero       = document.getElementById('partNumero')?.value?.trim()
    const descripcion  = document.getElementById('partDescripcion')?.value?.trim()
    const fechaInicio  = document.getElementById('partFechaInicio')?.value
    const fechaFin     = document.getElementById('partFechaFin')?.value || null
    const status       = document.getElementById('partStatus')?.value || 'activa'

    if (!productId || !numero || !fechaInicio) {
      showToast('Complete los campos requeridos (Producto, Número, Fecha Inicio)', 'warning')
      return
    }

    await addPartida({
      product_id:     productId,
      numero_partida: numero,
      descripcion:    descripcion || null,
      fecha_inicio:   fechaInicio,
      fecha_fin:      fechaFin,
      status
    })

    showToast('Partida creada exitosamente', 'success')
    window.closeModal('modal-nueva-partida')
    const form = document.getElementById('formNewPartida')
    if (form) form.reset()
    await renderPartidas()
  } catch (e) {
    console.error('guardarPartida:', e)
    showToast('Error: ' + e.message, 'danger')
  }
}

window.eliminarPartida = async function(id) {
  try {
    if (!confirm('¿Eliminar esta partida?')) return
    await deletePartida(id)
    showToast('Partida eliminada', 'success')
    await renderPartidas()
  } catch (e) {
    console.error('eliminarPartida:', e)
    showToast('Error al eliminar la partida', 'danger')
  }
}
