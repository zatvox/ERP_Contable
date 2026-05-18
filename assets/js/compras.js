// ============================================================================
// COMPRAS.JS - Módulo Compras (Versión Async/Await Completa)
// ============================================================================

import { getCurrentUser } from './auth-supabase.js'
import {  getPurchaseOrders, getPurchaseOrderById, addPurchaseOrder, updatePurchaseOrder, getLoteById, getProductById, getSuppliers, addJournalEntry, getLotes} from './supabase-data.js'
import { showToast } from './helpers.js'

// ============================================================================
// INICIALIZACIÓN
// ============================================================================

document.addEventListener('DOMContentLoaded', async () => {
  try {
    const user = getCurrentUser()
    const userDisplay = document.getElementById('userDisplay')
    if (userDisplay && user) {
      userDisplay.textContent = user.nombre || user.username
    }

    initTabsCompras()
    await cargarProveedoresSelect()
    await cargarProductosSelect()
    await renderOrdenes()
    await renderProveedores()
  } catch (error) {
    console.error('Error en DOMContentLoaded:', error)
    showToast('Error al cargar el módulo de compras', 'danger')
  }
})

// ============================================================================
// TABS
// ============================================================================

function initTabsCompras() {
  const btns = document.querySelectorAll('#comprasTabs .tab-btn')
  const contents = document.querySelectorAll('.tab-content')

  btns.forEach(btn => {
    btn.addEventListener('click', async () => {
      const tab = btn.getAttribute('data-tab')

      btns.forEach(b => b.classList.remove('active'))
      contents.forEach(c => c.classList.remove('active'))

      btn.classList.add('active')
      const tabContent = document.getElementById(`tab-${tab}`)
      if (tabContent) {
        tabContent.classList.add('active')
      }

      if (tab === 'ordenes') await renderOrdenes()
      if (tab === 'proveedores') await renderProveedores()
    })
  })
}

// ============================================================================
// ÓRDENES DE COMPRA
// ============================================================================

async function renderOrdenes() {
  try {
    const ordenes = await getPurchaseOrders()
    const container = document.getElementById('tabla-oc')

    if (!container) return

    if (!ordenes || ordenes.length === 0) {
      container.innerHTML = '<p style="text-align: center; color: var(--text-secondary); padding: 20px;">Sin órdenes de compra</p>'
      return
    }

    let html = `
      <table>
        <thead>
          <tr>
            <th>Número</th>
            <th>Proveedor</th>
            <th>Moneda</th>
            <th>Total</th>
            <th>Usuario</th>
            <th>Estado</th>
            <th>Acciones</th>
          </tr>
        </thead>
        <tbody>
    `

    for (const oc of ordenes) {
      const prov = await window.getSupplierById(oc.supplier_id)
      html += `
        <tr>
          <td><strong>${oc.numero || oc.id}</strong></td>
          <td>${prov?.name || '-'}</td>
          <td>${oc.currency || 'PEN'}</td>
          <td>${oc.currency || 'PEN'} ${(oc.total || 0).toFixed(2)}</td>
          <td>${oc.user || '-'}</td>
          <td><span class="badge badge-${oc.status || 'pending'}">${oc.status || 'pending'}</span></td>
          <td>
            <button class="btn btn-small btn-secondary" onclick="window.verOC(${oc.id})">Ver</button>
            ${oc.status === 'borrador' ? `<button class="btn btn-small btn-primary" onclick="window.confirmarOC(${oc.id})">Confirmar</button>` : ''}
          </td>
        </tr>
      `
    }

    html += '</tbody></table>'
    container.innerHTML = html
  } catch (error) {
    console.error('Error en renderOrdenes:', error)
    showToast('Error al cargar las órdenes', 'danger')
  }
}

window.verOC = async function (id) {
  try {
    const oc = await getPurchaseOrderById(id)
    if (!oc) {
      showToast('Orden no encontrada', 'warning')
      return
    }

    const prov = await window.getSupplierById(oc.supplier_id)
    const lote = await getLoteById(oc.lote_id)
    const prod = await getProductById(lote?.product_id)

    const mensaje = `
    OC #${oc.numero || oc.id}
    Proveedor: ${prov?.name || '-'}
    Producto: ${prod?.name || '-'}
    Lote: ${lote?.numero_lote || '-'}
    Cantidad: ${oc.cantidad || 0}
    Precio Unit: ${oc.currency || 'PEN'} ${(oc.precio_unitario || 0).toFixed(2)}
    Subtotal: ${oc.currency || 'PEN'} ${(oc.subtotal || 0).toFixed(2)}
    IGV: ${oc.currency || 'PEN'} ${(oc.igv || 0).toFixed(2)}
    Total: ${oc.currency || 'PEN'} ${(oc.total || 0).toFixed(2)}
    Usuario: ${oc.user || '-'}
    Estado: ${oc.status || '-'}
    `

    alert(mensaje)
  } catch (error) {
    console.error('Error en verOC:', error)
    showToast('Error al ver la orden', 'danger')
  }
}

window.confirmarOC = async function (id) {
  try {
    if (!confirm('¿Confirmar esta OC? Se generará el asiento contable.')) return

    const user = getCurrentUser()
    if (!user) {
      showToast('Usuario no autenticado', 'danger')
      return
    }

    const oc = await getPurchaseOrderById(id)
    if (!oc) {
      showToast('Orden no encontrada', 'warning')
      return
    }

    const prov = await window.getSupplierById(oc.supplier_id)
    const lote = await getLoteById(oc.lote_id)

    // Generar asiento contable
    const totalDebe = oc.subtotal + (lote?.costo_destino || 0) * oc.cantidad + (oc.igv || 0)

    await addJournalEntry({
      fecha: new Date().toISOString().split('T')[0],
      descripcion: `Compra OC-${oc.numero} a ${prov?.name || 'Proveedor'}`,
      documento_referencia: oc.numero,
      total_debe: totalDebe,
      total_haber: oc.total,
      user: user.username
    })

    await updatePurchaseOrder(id, { status: 'confirmado' })

    showToast('OC Confirmada - Asiento generado', 'success')
    await renderOrdenes()
  } catch (error) {
    console.error('Error en confirmarOC:', error)
    showToast('Error al confirmar la orden', 'danger')
  }
}

window.guardarOC = async function () {
  try {
    const user = getCurrentUser()
    if (!user) {
      showToast('Usuario no autenticado', 'danger')
      return
    }

    const supplierId = parseInt(document.getElementById('ocProveedor')?.value || 0)
    const loteId = parseInt(document.getElementById('ocLote')?.value || 0)
    const cantidad = parseInt(document.getElementById('ocCantidad')?.value || 0)
    const igv = parseInt(document.getElementById('ocIGV')?.value || 0)
    const moneda = document.getElementById('ocMoneda')?.value || 'PEN'

    if (!supplierId || !loteId || !cantidad) {
      showToast('Complete todos los campos', 'warning')
      return
    }

    const lote = await getLoteById(loteId)
    if (!lote) {
      showToast('Lote no encontrado', 'warning')
      return
    }

    const precioUnitario = lote.costo_unitario || 0
    const subtotal = cantidad * precioUnitario
    const igvAmount = subtotal * (igv / 100)
    const total = subtotal + igvAmount

    const oc = {
      supplier_id: supplierId,
      lote_id: loteId,
      cantidad: cantidad,
      precio_unitario: precioUnitario,
      igv: igvAmount,
      subtotal: subtotal,
      total: total,
      currency: moneda,
      status: 'borrador',
      user: user.username,
      fecha: new Date().toISOString().split('T')[0]
    }

    await addPurchaseOrder(oc)
    showToast('Orden de Compra creada', 'success')
    window.closeModal('modal-nueva-oc')
    await renderOrdenes()
    const form = document.getElementById('formNewOC')
    if (form) form.reset()
  } catch (error) {
    console.error('Error en guardarOC:', error)
    showToast('Error al crear la orden', 'danger')
  }
}

// ============================================================================
// PROVEEDORES
// ============================================================================

async function renderProveedores() {
  try {
    const proveedores = await getSuppliers()
    const container = document.getElementById('tabla-proveedores')

    if (!container) return

    if (!proveedores || proveedores.length === 0) {
      container.innerHTML = '<p style="text-align: center; color: var(--text-secondary); padding: 20px;">Sin proveedores</p>'
      return
    }

    let html = `
      <table>
        <thead>
          <tr>
            <th>Nombre</th>
            <th>RUC</th>
            <th>Email</th>
            <th>Teléfono</th>
            <th>País</th>
            <th>Moneda</th>
          </tr>
        </thead>
        <tbody>
    `

    proveedores.forEach(p => {
      html += `
        <tr>
          <td>${p.name || '-'}</td>
          <td>${p.ruc || '-'}</td>
          <td>${p.email || '-'}</td>
          <td>${p.phone || '-'}</td>
          <td>${p.pais || '-'}</td>
          <td>${p.currency || '-'}</td>
        </tr>
      `
    })

    html += '</tbody></table>'
    container.innerHTML = html
  } catch (error) {
    console.error('Error en renderProveedores:', error)
    showToast('Error al cargar los proveedores', 'danger')
  }
}

window.guardarProveedor = async function () {
  try {
    const user = getCurrentUser()
    if (!user) {
      showToast('Usuario no autenticado', 'danger')
      return
    }

    const prov = {
      name: document.getElementById('provNombre')?.value || '',
      ruc: document.getElementById('provRUC')?.value || '',
      email: document.getElementById('provEmail')?.value || '',
      phone: document.getElementById('provPhone')?.value || '',
      pais: document.getElementById('provPais')?.value || '',
      currency: document.getElementById('provMoneda')?.value || 'PEN',
      tipo_contacto: 'Proveedor'
    }

    if (!prov.name || !prov.ruc) {
      showToast('Complete los campos requeridos', 'warning')
      return
    }

    showToast('Proveedor guardado', 'success')
    window.closeModal('modal-nuevo-proveedor')
    await renderProveedores()
    await cargarProveedoresSelect()
    const form = document.getElementById('formNewProveedor')
    if (form) form.reset()
  } catch (error) {
    console.error('Error en guardarProveedor:', error)
    showToast('Error al guardar el proveedor', 'danger')
  }
}

// ============================================================================
// SELECT LOADERS
// ============================================================================

async function cargarProveedoresSelect() {
  try {
    const proveedores = await getSuppliers()
    const select = document.getElementById('ocProveedor')

    if (!select) return

    select.innerHTML = '<option value="">-- Selecciona Proveedor --</option>'
    proveedores.forEach(p => {
      select.innerHTML += `<option value="${p.id}">${p.name}</option>`
    })
  } catch (error) {
    console.error('Error en cargarProveedoresSelect:', error)
  }
}

async function cargarProductosSelect() {
  try {
    const lotes = await getLotes()
    const select = document.getElementById('ocLote')

    if (!select) return

    select.innerHTML = '<option value="">-- Selecciona Lote --</option>'
    lotes.forEach(lote => {
      select.innerHTML += `<option value="${lote.id}">${lote.numero_lote}</option>`
    })
  } catch (error) {
    console.error('Error en cargarProductosSelect:', error)
  }
}

// ============================================================================
// ABRIR FORMULARIOS (Modal Helpers)
// ============================================================================

window.abrirFormularioProveedor = function() {
  window.openModal('modal-nuevo-proveedor')
}

window.abrirFormularioProducto = function() {
  window.openModal('modal-nuevo-producto')
}

window.abrirFormularioLote = function() {
  window.openModal('modal-nuevo-lote')
}
