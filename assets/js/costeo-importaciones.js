// ============================================================================
// COSTEO-IMPORTACIONES.JS - Módulo Costeo de Importaciones (Async/Await)
// ============================================================================

import { getCurrentUser } from './auth-supabase.js'
import { getLotes, getSuppliers } from './supabase-data.js'
import { showToast } from './helpers.js'

const COSTEO_KEY = 'costeoImportaciones_erp'
let costeoActual = null
let contenedorActual = null

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

    initTabsCosteo()
    await cargarProveedoresSelect()
    await cargarProductosSelectCosteo()
    await cargarImportacionesList()

    // Cargar primera importación si existe
    const importaciones = window.getCosteoImportacionesLocal()
    if (importaciones && importaciones.length > 0) {
      const selector = document.getElementById('costeoSelector')
      if (selector) {
        selector.value = importaciones[0].id
        await cargarImportacion()
      }
    }
  } catch (error) {
    console.error('Error en DOMContentLoaded:', error)
    showToast('Error al cargar el módulo de costeo', 'danger')
  }
})

function initTabsCosteo() {
  const btns = document.querySelectorAll('#costeoTabs .tab-btn')
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

      if (tab === 'contenedores') await renderContenedores()
      if (tab === 'productos') await cargarContenedoresEnSelect('productoContenedor')
      if (tab === 'cif') await renderCIF()
      if (tab === 'impuestos') await renderImpuestos()
      if (tab === 'despacho') await renderDespacho()
      if (tab === 'financieros') await renderFinancieros()
      if (tab === 'resumen') await renderResumenFinal()
    })
  })
}

// ============================================================================
// GESTIÓN LOCAL DE IMPORTACIONES (localStorage)
// ============================================================================

window.getCosteoImportacionesLocal = function () {
  const stored = localStorage.getItem(COSTEO_KEY)
  return stored ? JSON.parse(stored) : []
}

function saveCosteoImportacionesLocal(importaciones) {
  localStorage.setItem(COSTEO_KEY, JSON.stringify(importaciones))
}

async function cargarImportacionesList() {
  try {
    const importaciones = window.getCosteoImportacionesLocal()
    const select = document.getElementById('costeoSelector')

    if (!select) return

    select.innerHTML = '<option value="">-- Nueva Importación --</option>'
    importaciones.forEach(imp => {
      select.innerHTML += `<option value="${imp.id}">${imp.numero} - ${imp.descripcion}</option>`
    })
  } catch (error) {
    console.error('Error en cargarImportacionesList:', error)
  }
}

async function cargarImportacion() {
  try {
    const selector = document.getElementById('costeoSelector')
    if (!selector) return

    const importacionId = selector.value
    if (!importacionId) {
      showToast('Selecciona una importación', 'warning')
      return
    }

    const importaciones = window.getCosteoImportacionesLocal()
    costeoActual = importaciones.find(imp => imp.id === importacionId)

    if (!costeoActual) {
      showToast('Importación no encontrada', 'danger')
      return
    }

    await cargarCabecera()
    await renderContenedores()
  } catch (error) {
    console.error('Error en cargarImportacion:', error)
    showToast('Error al cargar importación', 'danger')
  }
}

window.crearImportacion = async function () {
  try {
    const user = getCurrentUser()
    if (!user) {
      showToast('Usuario no autenticado', 'danger')
      return
    }

    const numero = document.getElementById('costeoNumero')?.value || ''
    const descripcion = document.getElementById('costeoDescripcion')?.value || ''

    if (!numero || !descripcion) {
      showToast('Complete todos los campos', 'warning')
      return
    }

    const newImportacion = {
      id: Date.now().toString(),
      numero: numero,
      descripcion: descripcion,
      cabecera: {},
      contenedores: [],
      createdBy: user.username,
      createdAt: new Date().toISOString()
    }

    const importaciones = window.getCosteoImportacionesLocal()
    importaciones.push(newImportacion)
    saveCosteoImportacionesLocal(importaciones)

    showToast('Importación creada', 'success')
    await cargarImportacionesList()
    const selector = document.getElementById('costeoSelector')
    if (selector) {
      selector.value = newImportacion.id
      await cargarImportacion()
    }

    document.getElementById('formNewCosteo').reset()
    window.closeModal('modal-nueva-importacion')
  } catch (error) {
    console.error('Error en crearImportacion:', error)
    showToast('Error al crear importación', 'danger')
  }
}

// ============================================================================
// CABECERA DE IMPORTACIÓN
// ============================================================================

async function cargarCabecera() {
  try {
    if (!costeoActual) return

    const cabecera = costeoActual.cabecera || {}
    document.getElementById('costeoProveedor').value = cabecera.supplier_id || ''
    document.getElementById('costeoFechaZarpue').value = cabecera.fecha_zarpue || ''
    document.getElementById('costeoFechaEta').value = cabecera.fecha_eta || ''
    document.getElementById('costeoIncoterm').value = cabecera.incoterm || 'FOB'
  } catch (error) {
    console.error('Error en cargarCabecera:', error)
  }
}

window.actualizarCabecera = async function () {
  try {
    if (!costeoActual) {
      showToast('Carga una importación primero', 'warning')
      return
    }

    costeoActual.cabecera = {
      supplier_id: parseInt(document.getElementById('costeoProveedor')?.value || 0),
      fecha_zarpue: document.getElementById('costeoFechaZarpue')?.value || '',
      fecha_eta: document.getElementById('costeoFechaEta')?.value || '',
      incoterm: document.getElementById('costeoIncoterm')?.value || 'FOB'
    }

    const importaciones = window.getCosteoImportacionesLocal()
    const idx = importaciones.findIndex(imp => imp.id === costeoActual.id)
    if (idx !== -1) {
      importaciones[idx] = costeoActual
      saveCosteoImportacionesLocal(importaciones)
    }

    showToast('Cabecera actualizada', 'success')
  } catch (error) {
    console.error('Error en actualizarCabecera:', error)
    showToast('Error al actualizar cabecera', 'danger')
  }
}

// ============================================================================
// CONTENEDORES
// ============================================================================

async function renderContenedores() {
  try {
    if (!costeoActual) return

    const contenedores = costeoActual.contenedores || []
    const container = document.getElementById('tabla-contenedores')

    if (!container) return

    let html = `
      <table>
        <thead>
          <tr>
            <th>Contenedor</th>
            <th>Tipo</th>
            <th>Peso (kg)</th>
            <th>Volumen (m³)</th>
            <th>Acciones</th>
          </tr>
        </thead>
        <tbody>
    `

    if (contenedores.length === 0) {
      html += '<tr><td colspan="5" style="text-align: center; padding: 20px;">Sin contenedores</td></tr>'
    } else {
      contenedores.forEach(cont => {
        html += `
          <tr>
            <td><strong>${cont.numero || '-'}</strong></td>
            <td>${cont.tipo || '-'}</td>
            <td>${cont.peso || 0}</td>
            <td>${cont.volumen || 0}</td>
            <td>
              <button class="btn btn-small btn-secondary" onclick="window.editarContenedor('${cont.id}')">Editar</button>
              <button class="btn btn-small btn-danger" onclick="window.eliminarContenedor('${cont.id}')">Eliminar</button>
            </td>
          </tr>
        `
      })
    }

    html += '</tbody></table>'
    container.innerHTML = html
  } catch (error) {
    console.error('Error en renderContenedores:', error)
    showToast('Error al cargar contenedores', 'danger')
  }
}

window.crearContenedor = async function () {
  try {
    if (!costeoActual) {
      showToast('Carga una importación primero', 'warning')
      return
    }

    const numero = document.getElementById('contNumero')?.value || ''
    const tipo = document.getElementById('contTipo')?.value || '20FT'
    const peso = parseFloat(document.getElementById('contPeso')?.value || 0)
    const volumen = parseFloat(document.getElementById('contVolumen')?.value || 0)

    if (!numero) {
      showToast('Ingresa el número de contenedor', 'warning')
      return
    }

    const newCont = {
      id: Date.now().toString(),
      numero: numero,
      tipo: tipo,
      peso: peso,
      volumen: volumen
    }

    costeoActual.contenedores.push(newCont)

    const importaciones = window.getCosteoImportacionesLocal()
    const idx = importaciones.findIndex(imp => imp.id === costeoActual.id)
    if (idx !== -1) {
      importaciones[idx] = costeoActual
      saveCosteoImportacionesLocal(importaciones)
    }

    showToast('Contenedor creado', 'success')
    window.closeModal('modal-nuevo-contenedor')
    await renderContenedores()
    document.getElementById('formNewContenedor').reset()
  } catch (error) {
    console.error('Error en crearContenedor:', error)
    showToast('Error al crear contenedor', 'danger')
  }
}

window.editarContenedor = async function (contId) {
  try {
    if (!costeoActual) return

    contenedorActual = costeoActual.contenedores.find(c => c.id === contId)
    if (!contenedorActual) return

    document.getElementById('editContNumero').value = contenedorActual.numero
    document.getElementById('editContTipo').value = contenedorActual.tipo
    document.getElementById('editContPeso').value = contenedorActual.peso
    document.getElementById('editContVolumen').value = contenedorActual.volumen

    window.openModal('modal-editar-contenedor')
  } catch (error) {
    console.error('Error en editarContenedor:', error)
    showToast('Error al editar contenedor', 'danger')
  }
}

window.actualizarContenedor = async function () {
  try {
    if (!contenedorActual) return

    contenedorActual.numero = document.getElementById('editContNumero')?.value || ''
    contenedorActual.tipo = document.getElementById('editContTipo')?.value || '20FT'
    contenedorActual.peso = parseFloat(document.getElementById('editContPeso')?.value || 0)
    contenedorActual.volumen = parseFloat(document.getElementById('editContVolumen')?.value || 0)

    const importaciones = window.getCosteoImportacionesLocal()
    const idx = importaciones.findIndex(imp => imp.id === costeoActual.id)
    if (idx !== -1) {
      importaciones[idx] = costeoActual
      saveCosteoImportacionesLocal(importaciones)
    }

    showToast('Contenedor actualizado', 'success')
    window.closeModal('modal-editar-contenedor')
    await renderContenedores()
  } catch (error) {
    console.error('Error en actualizarContenedor:', error)
    showToast('Error al actualizar contenedor', 'danger')
  }
}

window.eliminarContenedor = async function (contId) {
  try {
    if (!costeoActual) return
    if (!confirm('¿Eliminar este contenedor?')) return

    costeoActual.contenedores = costeoActual.contenedores.filter(c => c.id !== contId)

    const importaciones = window.getCosteoImportacionesLocal()
    const idx = importaciones.findIndex(imp => imp.id === costeoActual.id)
    if (idx !== -1) {
      importaciones[idx] = costeoActual
      saveCosteoImportacionesLocal(importaciones)
    }

    showToast('Contenedor eliminado', 'success')
    await renderContenedores()
  } catch (error) {
    console.error('Error en eliminarContenedor:', error)
    showToast('Error al eliminar contenedor', 'danger')
  }
}

async function cargarContenedoresEnSelect(selectId) {
  try {
    if (!costeoActual) return

    const select = document.getElementById(selectId)
    if (!select) return

    const contenedores = costeoActual.contenedores || []
    select.innerHTML = '<option value="">-- Selecciona Contenedor --</option>'
    contenedores.forEach(c => {
      select.innerHTML += `<option value="${c.id}">${c.numero}</option>`
    })
  } catch (error) {
    console.error('Error en cargarContenedoresEnSelect:', error)
  }
}

// ============================================================================
// PLACEHOLDERS PARA OTROS TABS (CIF, IMPUESTOS, DESPACHO, FINANCIEROS)
// ============================================================================

async function renderCIF() {
  showToast('Tab de CIF en construcción', 'info')
}

async function renderImpuestos() {
  showToast('Tab de Impuestos en construcción', 'info')
}

async function renderDespacho() {
  showToast('Tab de Despacho en construcción', 'info')
}

async function renderFinancieros() {
  showToast('Tab de Financieros en construcción', 'info')
}

async function renderResumenFinal() {
  try {
    if (!costeoActual) {
      showToast('Carga una importación primero', 'warning')
      return
    }

    const container = document.getElementById('content-resumen')
    if (!container) return

    const contenedores = costeoActual.contenedores || []
    let html = `
      <div style="padding: 20px;">
        <h3>Resumen de Importación: ${costeoActual.numero}</h3>
        <p>Descripción: ${costeoActual.descripcion}</p>
        <p>Contenedores: ${contenedores.length}</p>
        <p>Peso Total: ${contenedores.reduce((sum, c) => sum + c.peso, 0)} kg</p>
        <p>Volumen Total: ${contenedores.reduce((sum, c) => sum + c.volumen, 0)} m³</p>
      </div>
    `

    container.innerHTML = html
  } catch (error) {
    console.error('Error en renderResumenFinal:', error)
    showToast('Error al cargar resumen', 'danger')
  }
}

// ============================================================================
// SELECT LOADERS
// ============================================================================

async function cargarProveedoresSelect() {
  try {
    const proveedores = await getSuppliers()
    const select = document.getElementById('costeoProveedor')

    if (!select) return

    select.innerHTML = '<option value="">-- Selecciona Proveedor --</option>'
    proveedores.forEach(p => {
      select.innerHTML += `<option value="${p.id}">${p.name}</option>`
    })
  } catch (error) {
    console.error('Error en cargarProveedoresSelect:', error)
  }
}

async function cargarProductosSelectCosteo() {
  try {
    const lotes = await getLotes()
    const select = document.getElementById('costeoProducto')

    if (!select) return

    select.innerHTML = '<option value="">-- Selecciona Lote --</option>'
    lotes.forEach(lote => {
      select.innerHTML += `<option value="${lote.id}">${lote.numero_lote}</option>`
    })
  } catch (error) {
    console.error('Error en cargarProductosSelectCosteo:', error)
  }
}
