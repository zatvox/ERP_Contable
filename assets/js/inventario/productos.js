// ============================================================================
// inventario/productos.js — parte de inventario.js (reorganizado 2026-09-25, sin cambios de lógica)
// Mapa completo de funciones: Claude outputs/glosario_funciones_erp.md
// ============================================================================
import { getCurrentUser } from '../auth-supabase.js'
import { getItems, addItem, updateItem, deleteItem, getItemById, getLotes, getCategorias, getMarcas } from '../supabase-data.js'
import { showToast } from '../helpers.js'
import { cargarProductosSelect } from './formularios.js'
import { renderLotes } from './lotes.js'

// ============================================================================
// PRODUCTOS
// ============================================================================

// Cache para filtros (se llena una sola vez por carga, sin N+1)
let _prodCache = null

async function _cargarDatosProductos(forzar = false) {
  if (_prodCache && !forzar) return _prodCache
  // Una sola consulta por tabla, en paralelo (antes: getLotes por cada producto)
  const [productos, lotes, categorias, marcas] = await Promise.all([
    getItems(), getLotes(), getCategorias(), getMarcas()
  ])
  const catMap = {}, marMap = {}, stockMap = {}, valorMap = {}
  ;(categorias || []).forEach(c => { catMap[c.id] = c.nombre })
  ;(marcas || []).forEach(m => { marMap[m.id] = m.nombre })
  ;(lotes || []).forEach(l => {
    // lotes usa item_id/cantidad, NO product_id/stock (esas columnas no existen en la BD)
    stockMap[l.item_id] = (stockMap[l.item_id] || 0) + (parseFloat(l.cantidad) || 0)
    valorMap[l.item_id] = (valorMap[l.item_id] || 0) + (parseFloat(l.cantidad) || 0) * (parseFloat(l.costo_unitario) || 0)
  })
  _prodCache = { productos: productos || [], categorias: categorias || [], catMap, marMap, stockMap, valorMap }
  return _prodCache
}

function _poblarFiltroCategorias(categorias) {
  const sel = document.getElementById('filtroProdCategoria')
  if (!sel || sel.options.length > 1) return
  categorias.forEach(c => {
    const opt = document.createElement('option')
    opt.value = c.id
    opt.textContent = c.nombre
    sel.appendChild(opt)
  })
}

export async function renderProductos(forzar = false) {
  try {
    const container = document.getElementById('tabla-productos')
    if (!container) return

    const { productos, categorias, catMap, marMap, stockMap, valorMap } = await _cargarDatosProductos(forzar)
    _poblarFiltroCategorias(categorias)

    // Filtros (por defecto: stock > 0 y estado activo) + búsqueda en vivo
    const fCat    = document.getElementById('filtroProdCategoria')?.value || ''
    const fStock  = document.getElementById('filtroProdStock')?.value ?? 'con'
    const fEstado = document.getElementById('filtroProdEstado')?.value ?? 'activo'
    const fBusqueda = (document.getElementById('buscarProducto')?.value || '').trim().toLowerCase()

    const filtrados = productos.filter(p => {
      const stock = stockMap[p.id] || 0
      if (fCat && String(p.categoria_id) !== fCat) return false
      if (fStock === 'con' && stock <= 0) return false
      if (fStock === 'sin' && stock > 0) return false
      if (fEstado === 'activo' && !p.activo) return false
      if (fEstado === 'inactivo' && p.activo) return false
      if (fBusqueda) {
        const texto = `${p.nombre || ''} ${p.sku || ''}`.toLowerCase()
        if (!texto.includes(fBusqueda)) return false
      }
      return true
    })

    if (filtrados.length === 0) {
      container.innerHTML = '<p style="text-align: center; color: var(--text-secondary); padding: 20px;">Sin productos que coincidan con los filtros</p>'
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
            <th>Marca</th>
            <th>Stock Total</th>
            <th>Valor Inventario</th>
            <th>Estado</th>
            <th>Acciones</th>
          </tr>
        </thead>
        <tbody>
    `

    for (const prod of filtrados) {
      const stockTotal = stockMap[prod.id] || 0
      const valorTotal = valorMap[prod.id] || 0
      const estado = prod.activo ? 'Activo' : 'Inactivo'
      const badgeClass = prod.activo ? 'badge-success' : 'badge-secondary'

      html += `
        <tr>
          <td><strong>${prod.sku}</strong></td>
          <td>${prod.nombre}</td>
          <td>${prod.descripcion || '-'}</td>
          <td>${catMap[prod.categoria_id] || '-'}</td>
          <td>${marMap[prod.marca_id] || '-'}</td>
          <td style="text-align: center; font-weight: bold;">${stockTotal.toLocaleString('en-US', { maximumFractionDigits: 2 })}</td>
          <td>S/. ${valorTotal.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
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

window.aplicarFiltrosProductos = async function () {
  await renderProductos()  // usa cache, solo re-filtra
}

// ID del producto en edición (null = modo crear)
let _prodEditandoId = null

function _leerFormProducto() {
  return {
    nombre: document.getElementById('prodNombre')?.value || '',
    sku: document.getElementById('prodSKU')?.value || '',
    unidad_medida: document.getElementById('prodUnidadMedida')?.value || '',
    descripcion: document.getElementById('prodDescripcion')?.value || '',
    categoria_id: parseInt(document.getElementById('prodCategoria')?.value || 0) || null,
    marca_id: parseInt(document.getElementById('prodMarca')?.value || 0) || null,
    tipo_item: 'mercaderia',
    activo: document.getElementById('prodActivo')?.value === 'true'
  }
}

function _resetModalProducto() {
  _prodEditandoId = null
  const titulo = document.getElementById('modalProductoTitle')
  if (titulo) titulo.textContent = 'Nuevo Producto'
  const form = document.getElementById('formNewProducto')
  if (form) form.reset()
}

window.abrirModalNuevoProducto = function () {
  _resetModalProducto()
  window.openModal('modal-nuevo-producto')
}

window.guardarProducto = async function () {
  try {
    const user = await getCurrentUser()
    if (!user) {
      showToast('Usuario no autenticado', 'danger')
      return
    }

    const prod = _leerFormProducto()  // sin 'id': la columna es GENERATED ALWAYS

    if (!prod.nombre || !prod.sku) {
      showToast('Complete campos requeridos', 'warning')
      return
    }

    if (_prodEditandoId) {
      await updateItem(_prodEditandoId, prod)
      showToast('Producto actualizado', 'success')
    } else {
      await addItem(prod)
      showToast('Producto creado exitosamente', 'success')
    }

    window.closeModal('modal-nuevo-producto')
    _resetModalProducto()
    await renderProductos(true)
    await cargarProductosSelect()
  } catch (error) {
    console.error('Error en guardarProducto:', error)
    showToast('Error al guardar producto', 'danger')
  }
}

window.editarProducto = async function (prodId) {
  try {
    const prod = await getItemById(prodId)
    if (!prod) return

    // Columnas reales: nombre, sku, descripcion, unidad_medida, categoria_id, marca_id, activo
    document.getElementById('prodNombre').value = prod.nombre || ''
    document.getElementById('prodSKU').value = prod.sku || ''
    document.getElementById('prodUnidadMedida').value = prod.unidad_medida || ''
    document.getElementById('prodDescripcion').value = prod.descripcion || ''
    document.getElementById('prodCategoria').value = prod.categoria_id || ''
    document.getElementById('prodMarca').value = prod.marca_id || ''
    document.getElementById('prodActivo').value = prod.activo ? 'true' : 'false'

    _prodEditandoId = prodId
    const titulo = document.getElementById('modalProductoTitle')
    if (titulo) titulo.textContent = `Editar Producto #${prodId}`
    window.openModal('modal-nuevo-producto')
  } catch (error) {
    console.error('Error en editarProducto:', error)
    showToast('Error al editar producto', 'danger')
  }
}

window.eliminarProducto = async function (prodId) {
  try {
    if (!confirm('¿Estás seguro de que deseas eliminar este producto?')) return

    await deleteItem(prodId)
    showToast('Producto eliminado', 'success')
    await renderProductos(true)
    await renderLotes(true)
    await cargarProductosSelect()
  } catch (error) {
    console.error('Error en eliminarProducto:', error)
    showToast('Error al eliminar producto', 'danger')
  }
}
