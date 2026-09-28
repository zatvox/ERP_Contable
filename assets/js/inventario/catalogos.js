// ============================================================================
// inventario/catalogos.js — parte de inventario.js (reorganizado 2026-09-25, sin cambios de lógica)
// Mapa completo de funciones: Claude outputs/glosario_funciones_erp.md
// ============================================================================
import { getCurrentUser } from '../auth-supabase.js'
import { getCategorias, getCategoriaById, addCategoria, updateCategoria, deleteCategoria, getMarcas, getMarcaById, addMarca, updateMarca, deleteMarca } from '../supabase-data.js'
import { showToast } from '../helpers.js'
import { cargarCategoriasSelect, cargarMarcasSelect } from './formularios.js'

// ============================================================================
// CATEGORÍAS
// ============================================================================

export async function renderCategorias() {
  try {
    const categorias = await getCategorias()
    const container = document.getElementById('tabla-categorias')

    if (!container) return

    if (!categorias || categorias.length === 0) {
      container.innerHTML = '<p style="text-align: center; color: var(--text-secondary); padding: 20px;">Sin categorías</p>'
      return
    }

    let html = `
      <table>
        <thead>
          <tr>
            <th>Nombre</th>
            <th>Descripción</th>
            <th>Estado</th>
            <th>Acciones</th>
          </tr>
        </thead>
        <tbody>
    `

    categorias.forEach(cat => {
      const estado = cat.activo ? 'Activo' : 'Inactivo'
      const badgeClass = cat.activo ? 'badge-success' : 'badge-secondary'

      html += `
        <tr>
          <td><strong>${cat.nombre}</strong></td>
          <td>${cat.descripcion || '-'}</td>
          <td><span class="badge ${badgeClass}">${estado}</span></td>
          <td>
            <button class="btn btn-small btn-secondary" onclick="window.editarCategoria(${cat.id})">Editar</button>
            <button class="btn btn-small btn-danger" onclick="window.eliminarCategoria(${cat.id})">Eliminar</button>
          </td>
        </tr>
      `
    })

    html += '</tbody></table>'
    container.innerHTML = html
  } catch (error) {
    console.error('Error en renderCategorias:', error)
    showToast('Error al cargar categorías', 'danger')
  }
}

window.guardarCategoria = async function () {
  try {
    const user = await getCurrentUser()
    if (!user) {
      showToast('Usuario no autenticado', 'danger')
      return
    }

    const cat = {
      nombre: document.getElementById('catNombre')?.value || '',
      descripcion: document.getElementById('catDescripcion')?.value || '',
      activo: document.getElementById('catActivo')?.value === 'true'
    }

    if (!cat.nombre) {
      showToast('Complete los campos requeridos', 'warning')
      return
    }

    if (window.editingCategoriaId) {
      await updateCategoria(window.editingCategoriaId, cat)
      showToast('Categoría actualizada exitosamente', 'success')
      window.editingCategoriaId = null
    } else {
      await addCategoria(cat)
      showToast('Categoría creada exitosamente', 'success')
    }

    window.closeModal('modal-nueva-categoria')
    await renderCategorias()
    await cargarCategoriasSelect()
    const form = document.getElementById('formNewCategoria')
    if (form) form.reset()
  } catch (error) {
    console.error('Error en guardarCategoria:', error)
    showToast('Error al guardar categoría', 'danger')
  }
}

window.editarCategoria = async function (catId) {
  try {
    const cat = await getCategoriaById(catId)
    if (!cat) return

    document.getElementById('catNombre').value = cat.nombre
    document.getElementById('catDescripcion').value = cat.descripcion || ''
    document.getElementById('catActivo').value = cat.activo ? 'true' : 'false'

    window.editingCategoriaId = catId
    window.openModal('modal-nueva-categoria')
  } catch (error) {
    console.error('Error en editarCategoria:', error)
    showToast('Error al editar categoría', 'danger')
  }
}

window.eliminarCategoria = async function (catId) {
  try {
    const cat = await getCategoriaById(catId)
    if (!cat) return

    if (!confirm(`¿Eliminar categoría "${cat.nombre}"?`)) return

    await deleteCategoria(catId)
    showToast('Categoría eliminada', 'success')
    await renderCategorias()
    await cargarCategoriasSelect()
  } catch (error) {
    console.error('Error en eliminarCategoria:', error)
    showToast('Error al eliminar categoría', 'danger')
  }
}

// ============================================================================
// MARCAS
// ============================================================================

export async function renderMarcas() {
  try {
    const marcas = await getMarcas()
    const container = document.getElementById('tabla-marcas')

    if (!container) return

    if (!marcas || marcas.length === 0) {
      container.innerHTML = '<p style="text-align: center; color: var(--text-secondary); padding: 20px;">Sin marcas</p>'
      return
    }

    let html = `
      <table>
        <thead>
          <tr>
            <th>Nombre</th>
            <th>Descripción</th>
            <th>País de Origen</th>
            <th>Estado</th>
            <th>Acciones</th>
          </tr>
        </thead>
        <tbody>
    `

    marcas.forEach(mar => {
      const estado = mar.activo ? 'Activo' : 'Inactivo'
      const badgeClass = mar.activo ? 'badge-success' : 'badge-secondary'

      html += `
        <tr>
          <td><strong>${mar.nombre}</strong></td>
          <td>${mar.descripcion || '-'}</td>
          <td>${mar.pais_origen || '-'}</td>
          <td><span class="badge ${badgeClass}">${estado}</span></td>
          <td>
            <button class="btn btn-small btn-secondary" onclick="window.editarMarca(${mar.id})">Editar</button>
            <button class="btn btn-small btn-danger" onclick="window.eliminarMarca(${mar.id})">Eliminar</button>
          </td>
        </tr>
      `
    })

    html += '</tbody></table>'
    container.innerHTML = html
  } catch (error) {
    console.error('Error en renderMarcas:', error)
    showToast('Error al cargar marcas', 'danger')
  }
}

window.guardarMarca = async function () {
  try {
    const user = await getCurrentUser()
    if (!user) {
      showToast('Usuario no autenticado', 'danger')
      return
    }

    const mar = {
      nombre: document.getElementById('marNombre')?.value || '',
      descripcion: document.getElementById('marDescripcion')?.value || '',
      pais_origen: document.getElementById('marPais')?.value || '',
      activo: document.getElementById('marActivo')?.value === 'true'
    }

    if (!mar.nombre) {
      showToast('Complete los campos requeridos', 'warning')
      return
    }

    if (window.editingMarcaId) {
      await updateMarca(window.editingMarcaId, mar)
      showToast('Marca actualizada exitosamente', 'success')
      window.editingMarcaId = null
    } else {
      await addMarca(mar)
      showToast('Marca creada exitosamente', 'success')
    }

    window.closeModal('modal-nueva-marca')
    await renderMarcas()
    await cargarMarcasSelect()
    const form = document.getElementById('formNewMarca')
    if (form) form.reset()
  } catch (error) {
    console.error('Error en guardarMarca:', error)
    showToast('Error al guardar marca', 'danger')
  }
}

window.editarMarca = async function (marId) {
  try {
    const mar = await getMarcaById(marId)
    if (!mar) return

    document.getElementById('marNombre').value = mar.nombre
    document.getElementById('marDescripcion').value = mar.descripcion || ''
    document.getElementById('marPais').value = mar.pais_origen || ''
    document.getElementById('marActivo').value = mar.activo ? 'true' : 'false'

    window.editingMarcaId = marId
    window.openModal('modal-nueva-marca')
  } catch (error) {
    console.error('Error en editarMarca:', error)
    showToast('Error al editar marca', 'danger')
  }
}

window.eliminarMarca = async function (marId) {
  try {
    const mar = await getMarcaById(marId)
    if (!mar) return

    if (!confirm(`¿Eliminar marca "${mar.nombre}"?`)) return

    await deleteMarca(marId)
    showToast('Marca eliminada', 'success')
    await renderMarcas()
    await cargarMarcasSelect()
  } catch (error) {
    console.error('Error en eliminarMarca:', error)
    showToast('Error al eliminar marca', 'danger')
  }
}
