// ============================================================================
// INVENTARIO.JS - Módulo Inventario (Versión Async/Await)
// ============================================================================

import { getCurrentUser } from './auth-supabase.js'
import { getProducts, getLotes, addProduct, updateProduct, deleteProduct, addLote, updateLote, deleteLote } from './supabase-data.js'
import { showToast } from './helpers.js'

document.addEventListener('DOMContentLoaded', async () => {
  try {
    const user = getCurrentUser()
    const userDisplay = document.getElementById('userDisplay')
    if (userDisplay && user) {
      userDisplay.textContent = user.nombre || user.username
    }

    const loteUsuario = document.getElementById('loteUsuario')
    if (loteUsuario && user) {
      loteUsuario.value = user.username
    }

    initTabsInventario()
    await cargarProductosSelect()
    await renderProductos()
  } catch (error) {
    console.error('Error en DOMContentLoaded:', error)
    showToast('Error al cargar el módulo de inventario', 'danger')
  }
})

function initTabsInventario() {
  const btns = document.querySelectorAll('#inventarioTabs .tab-btn')
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

      if (tab === 'productos') await renderProductos()
      if (tab === 'lotes') await renderLotes()
      if (tab === 'resumen') await renderResumenStock()
    })
  })
}

// ============================================================================
// PRODUCTOS
// ============================================================================

async function renderProductos() {
  try {
    const productos = await getProducts()
    const container = document.getElementById('tabla-productos')

    if (!container) return

    if (!productos || productos.length === 0) {
      container.innerHTML = '<p style="text-align: center; color: var(--text-secondary); padding: 20px;">Sin productos</p>'
      return
    }

    let html = `
      <table>
        <thead>
          <tr>
            <th>SKU</th>
            <th>Nombre</th>
            <th>Descripción</th>
            <th>Categoría</th>
            <th>Stock Total</th>
            <th>Valor Inventario</th>
            <th>Estado</th>
            <th>Acciones</th>
          </tr>
        </thead>
        <tbody>
    `

    for (const prod of productos) {
      const lotes = await getLotes()
      const lotesProducto = lotes.filter(l => l.product_id === prod.id)
      const stockTotal = lotesProducto.reduce((sum, l) => sum + l.cantidad, 0)
      const valorTotal = lotesProducto.reduce((sum, l) => sum + (l.cantidad * l.costo_unitario), 0)
      const estado = prod.active ? 'Activo' : 'Inactivo'
      const badgeClass = prod.active ? 'badge-success' : 'badge-secondary'

      html += `
        <tr>
          <td><strong>${prod.sku}</strong></td>
          <td>${prod.name}</td>
          <td>${prod.description || '-'}</td>
          <td>${prod.category || '-'}</td>
          <td style="text-align: center; font-weight: bold;">${stockTotal}</td>
          <td>S/. ${valorTotal.toFixed(2)}</td>
          <td><span class="badge ${badgeClass}">${estado}</span></td>
          <td>
            <button class="btn btn-small btn-secondary" onclick="window.editarProducto(${prod.id})">Editar</button>
            <button class="btn btn-small btn-danger" onclick="window.eliminarProducto(${prod.id})">Eliminar</button>
          </td>
        </tr>
      `
    }

    html += '</tbody></table>'
    container.innerHTML = html
  } catch (error) {
    console.error('Error en renderProductos:', error)
    showToast('Error al cargar productos', 'danger')
  }
}

window.guardarProducto = async function () {
  try {
    const user = getCurrentUser()
    if (!user) {
      showToast('Usuario no autenticado', 'danger')
      return
    }

    const prod = {
      name: document.getElementById('prodNombre')?.value || '',
      sku: document.getElementById('prodSKU')?.value || '',
      description: document.getElementById('prodDescripcion')?.value || '',
      category: document.getElementById('prodCategoria')?.value || '',
      active: document.getElementById('prodActivo')?.value === 'true'
    }

    if (!prod.name || !prod.sku) {
      showToast('Complete campos requeridos', 'warning')
      return
    }

    await addProduct(prod)
    showToast('Producto creado exitosamente', 'success')
    window.closeModal('modal-nuevo-producto')
    await renderProductos()
    await cargarProductosSelect()
    const form = document.getElementById('formNewProducto')
    if (form) form.reset()
  } catch (error) {
    console.error('Error en guardarProducto:', error)
    showToast('Error al guardar producto', 'danger')
  }
}

window.editarProducto = async function (prodId) {
  try {
    const prod = await getProductById(prodId)
    if (!prod) return

    document.getElementById('prodNombre').value = prod.name
    document.getElementById('prodSKU').value = prod.sku
    document.getElementById('prodDescripcion').value = prod.description || ''
    document.getElementById('prodCategoria').value = prod.category || ''
    document.getElementById('prodActivo').value = prod.active ? 'true' : 'false'

    window.currentEditingProductId = prodId
    window.openModal('modal-nuevo-producto')
  } catch (error) {
    console.error('Error en editarProducto:', error)
    showToast('Error al editar producto', 'danger')
  }
}

window.actualizarProducto = async function (prodId) {
  try {
    const user = getCurrentUser()
    if (!user) {
      showToast('Usuario no autenticado', 'danger')
      return
    }

    const prod = {
      name: document.getElementById('prodNombre').value,
      sku: document.getElementById('prodSKU').value,
      description: document.getElementById('prodDescripcion').value,
      category: document.getElementById('prodCategoria').value,
      active: document.getElementById('prodActivo').value === 'true'
    }

    await updateProduct(prodId, prod)
    showToast('Producto actualizado', 'success')
    window.closeModal('modal-nuevo-producto')
    await renderProductos()
    await cargarProductosSelect()
  } catch (error) {
    console.error('Error en actualizarProducto:', error)
    showToast('Error al actualizar producto', 'danger')
  }
}

window.eliminarProducto = async function (prodId) {
  try {
    if (!confirm('¿Estás seguro de que deseas eliminar este producto?')) return

    await deleteProduct(prodId)
    showToast('Producto eliminado', 'success')
    await renderProductos()
    await renderLotes()
    await cargarProductosSelect()
  } catch (error) {
    console.error('Error en eliminarProducto:', error)
    showToast('Error al eliminar producto', 'danger')
  }
}

// ============================================================================
// LOTES
// ============================================================================

async function renderLotes() {
  try {
    const lotes = await getLotes()
    const container = document.getElementById('tabla-lotes')

    if (!container) return

    if (!lotes || lotes.length === 0) {
      container.innerHTML = '<p style="text-align: center; color: var(--text-secondary); padding: 20px;">Sin lotes</p>'
      return
    }

    let html = `
      <table>
        <thead>
          <tr>
            <th>Lote</th>
            <th>Producto</th>
            <th>Stock</th>
            <th>Costo Unit.</th>
            <th>Costo Destino</th>
            <th>Costo Total Lote</th>
            <th>Vencimiento</th>
            <th>Días Restantes</th>
            <th>Acciones</th>
          </tr>
        </thead>
        <tbody>
    `

    const hoy = new Date()

    for (const lote of lotes) {
      const prod = await getProductById(lote.product_id)
      const vencimiento = new Date(lote.fecha_vencimiento)
      const diasRestantes = Math.ceil((vencimiento - hoy) / (1000 * 60 * 60 * 24))
      const costoTotalLote = (lote.cantidad || 0) * (lote.costo_unitario || 0)

      let colorDias = 'color: var(--color-success);'
      if (diasRestantes < 0) colorDias = 'color: var(--color-danger); font-weight: bold;'
      else if (diasRestantes < 30) colorDias = 'color: var(--color-warning); font-weight: bold;'

      html += `
        <tr>
          <td><strong>${lote.numero_lote || '-'}</strong></td>
          <td>${prod?.name || '-'}</td>
          <td style="text-align: center; font-weight: bold;">${lote.cantidad || 0}</td>
          <td>S/. ${(lote.costo_unitario || 0).toFixed(2)}</td>
          <td>S/. ${(lote.costo_destino || 0).toFixed(2)}</td>
          <td>S/. ${costoTotalLote.toFixed(2)}</td>
          <td>${window.formatDate(lote.fecha_vencimiento)}</td>
          <td style="${colorDias}">${diasRestantes} días</td>
          <td>
            <button class="btn btn-small btn-secondary" onclick="window.editarLote(${lote.id})">Editar</button>
            <button class="btn btn-small btn-danger" onclick="window.eliminarLote(${lote.id})">Eliminar</button>
          </td>
        </tr>
      `
    }

    html += '</tbody></table>'
    container.innerHTML = html
  } catch (error) {
    console.error('Error en renderLotes:', error)
    showToast('Error al cargar lotes', 'danger')
  }
}

window.guardarLote = async function () {
  try {
    const user = getCurrentUser()
    if (!user) {
      showToast('Usuario no autenticado', 'danger')
      return
    }

    const productId = parseInt(document.getElementById('loteProducto')?.value || 0)
    const numeroLote = document.getElementById('loteNumero')?.value || ''
    const stock = parseInt(document.getElementById('loteStock')?.value || 0)
    const costoUnitario = parseFloat(document.getElementById('loteCosto')?.value || 0)
    const costoDestino = parseFloat(document.getElementById('loteDestino')?.value || 0)
    const fechaVencimiento = document.getElementById('loteVencimiento')?.value || ''

    if (!productId || !numeroLote || !stock || !costoUnitario || !fechaVencimiento) {
      showToast('Complete todos los campos requeridos', 'warning')
      return
    }

    const lote = {
      product_id: productId,
      numero_lote: numeroLote,
      cantidad: stock,
      costo_unitario: costoUnitario,
      costo_destino: costoDestino,
      fecha_vencimiento: fechaVencimiento,
      created_by: user.username
    }

    await addLote(lote)
    showToast('Lote creado exitosamente', 'success')
    window.closeModal('modal-nuevo-lote')
    await renderLotes()
    const form = document.getElementById('formNewLote')
    if (form) form.reset()
  } catch (error) {
    console.error('Error en guardarLote:', error)
    showToast('Error al crear lote', 'danger')
  }
}

window.editarLote = async function (loteId) {
  try {
    const lote = await getLoteById(loteId)
    if (!lote) return

    document.getElementById('editLoteNumero').value = lote.numero_lote
    document.getElementById('editLoteStock').value = lote.cantidad
    document.getElementById('editLoteCosto').value = lote.costo_unitario
    document.getElementById('editLoteDestino').value = lote.costo_destino || 0
    document.getElementById('editLoteVencimiento').value = lote.fecha_vencimiento

    window.editingLoteId = loteId
    window.openModal('modal-editar-lote')
  } catch (error) {
    console.error('Error en editarLote:', error)
    showToast('Error al editar lote', 'danger')
  }
}

window.actualizarLote = async function () {
  try {
    if (!window.editingLoteId) {
      showToast('Error: No se identificó el lote', 'danger')
      return
    }

    const loteId = window.editingLoteId
    const lote = {
      cantidad: parseInt(document.getElementById('editLoteStock').value),
      costo_unitario: parseFloat(document.getElementById('editLoteCosto').value),
      costo_destino: parseFloat(document.getElementById('editLoteDestino').value),
      fecha_vencimiento: document.getElementById('editLoteVencimiento').value
    }

    await updateLote(loteId, lote)
    showToast('Lote actualizado', 'success')
    window.closeModal('modal-editar-lote')
    await renderLotes()
    window.editingLoteId = null
  } catch (error) {
    console.error('Error en actualizarLote:', error)
    showToast('Error al actualizar lote', 'danger')
  }
}

window.eliminarLote = async function (loteId) {
  try {
    const lote = await getLoteById(loteId)
    if (!lote) return

    if (!confirm(`¿Eliminar lote "${lote.numero_lote}"?`)) return

    await deleteLote(loteId)
    showToast('Lote eliminado', 'success')
    await renderLotes()
  } catch (error) {
    console.error('Error en eliminarLote:', error)
    showToast('Error al eliminar lote', 'danger')
  }
}

// ============================================================================
// RESUMEN DE STOCK
// ============================================================================

async function renderResumenStock() {
  try {
    const productos = await getProducts()
    const lotes = await getLotes()
    const container = document.getElementById('tabla-resumen')

    if (!container) return

    let html = `
      <table>
        <thead>
          <tr>
            <th>SKU</th>
            <th>Producto</th>
            <th>Stock Total</th>
            <th>Cantidad Lotes</th>
            <th>Costo Promedio Unit.</th>
            <th>Valor Total Inventario</th>
            <th>Stock Crítico (&lt;5)</th>
          </tr>
        </thead>
        <tbody>
    `

    let totalInventario = 0

    for (const prod of productos) {
      const lotesProducto = lotes.filter(l => l.product_id === prod.id)
      const stockTotal = lotesProducto.reduce((sum, l) => sum + l.cantidad, 0)
      const cantidadLotes = lotesProducto.length
      const valorTotal = lotesProducto.reduce((sum, l) => sum + (l.cantidad * l.costo_unitario), 0)
      const costoPromedio = stockTotal > 0 ? valorTotal / stockTotal : 0
      const critico = stockTotal < 5

      totalInventario += valorTotal

      const colorCritico = critico ? 'background-color: #ea6868; color: #991b1b;' : ''

      html += `
        <tr style="${colorCritico}">
          <td><strong>${prod.sku}</strong></td>
          <td>${prod.name}</td>
          <td style="text-align: center; font-weight: bold;">${stockTotal}</td>
          <td style="text-align: center;">${cantidadLotes}</td>
          <td>S/. ${costoPromedio.toFixed(2)}</td>
          <td>S/. ${valorTotal.toFixed(2)}</td>
          <td style="text-align: center;">${critico ? '⚠️ SÍ' : 'NO'}</td>
        </tr>
      `
    }

    html += `
        </tbody>
        <tfoot>
          <tr style="border-top: 2px solid var(--border-color); font-weight: bold;">
            <td colspan="5">TOTAL INVENTARIO</td>
            <td colspan="2" style="text-align: right;">S/. ${totalInventario.toFixed(2)}</td>
          </tr>
        </tfoot>
      </table>
    `

    container.innerHTML = html
  } catch (error) {
    console.error('Error en renderResumenStock:', error)
    showToast('Error al cargar resumen', 'danger')
  }
}

// ============================================================================
// CARGAR SELECTS
// ============================================================================

async function cargarProductosSelect() {
  try {
    const productos = await getProducts()
    const select = document.getElementById('loteProducto')

    if (!select) return

    select.innerHTML = '<option value="">-- Selecciona --</option>'
    productos.forEach(p => {
      select.innerHTML += `<option value="${p.id}">${p.name} (${p.sku})</option>`
    })
  } catch (error) {
    console.error('Error en cargarProductosSelect:', error)
  }
}

window.abrirModalLote = function() {
  cargarProductosSelect()
  window.openModal('modal-nuevo-lote')
}
