// ============================================================================
// inventario/almacenes-zonas.js — parte de inventario.js (reorganizado 2026-09-25, sin cambios de lógica)
// Mapa completo de funciones: Claude outputs/glosario_funciones_erp.md
// ============================================================================
import { getAlmacenes, getAlmacenById, addAlmacen, updateAlmacen, deleteAlmacen, getUbicaciones, getUbicacionesByAlmacen, getUbicacionById, addUbicacion, updateUbicacion, deleteUbicacion, getStockUbicacionesByUbicacion } from '../supabase-data.js'
import { showToast } from '../helpers.js'

// ============================================================================
// ALMACENES Y ZONAS
// ============================================================================
// Etapa 1 del stock por zona: un almacén es una dirección fiscal (puede
// haber varias). Cada almacén tiene Zonas internas (tabla ubicaciones,
// tipo='zona'). El stock real por zona se calcula desde stock_ubicaciones
// (Etapa 1 de la Guía de Remisión / Etapa 2 traslados internos), no desde
// aquí; este tab solo administra el catálogo de almacenes y zonas.

let _almacenesCache = null

async function _cargarAlmacenesCache(forzar = false) {
  if (_almacenesCache && !forzar) return _almacenesCache
  _almacenesCache = await getAlmacenes()
  return _almacenesCache
}

export async function renderAlmacenes() {
  try {
    const container = document.getElementById('tabla-almacenes')
    if (!container) return

    const almacenes = await _cargarAlmacenesCache(true)

    // Poblar selects que dependen de la lista de almacenes
    const selectFiltro = document.getElementById('filtroZonaAlmacen')
    const selectModal = document.getElementById('zonaAlmacen')
    const opciones = (almacenes || []).map(a => `<option value="${a.id}">${a.nombre} (${a.codigo})</option>`).join('')
    if (selectFiltro) selectFiltro.innerHTML = '<option value="">-- Todos los almacenes --</option>' + opciones
    if (selectModal)  selectModal.innerHTML  = '<option value="">-- Selecciona --</option>' + opciones

    if (!almacenes || almacenes.length === 0) {
      container.innerHTML = '<p style="text-align:center; color:var(--text-secondary); padding:20px;">Sin almacenes registrados</p>'
    } else {
      let html = `
        <table>
          <thead>
            <tr>
              <th>Código</th><th>Nombre</th><th>Dirección</th><th>Ubigeo</th>
              <th>Principal</th><th>Estado</th><th>Acciones</th>
            </tr>
          </thead>
          <tbody>
      `
      for (const a of almacenes) {
        html += `
          <tr>
            <td><strong>${a.codigo}</strong></td>
            <td>${a.nombre}</td>
            <td>${a.direccion}</td>
            <td>${a.ubigeo || '-'}</td>
            <td>${a.es_principal ? '<span class="badge badge-success">Sí</span>' : '-'}</td>
            <td>${a.activo === false ? '<span class="badge badge-secondary">Inactivo</span>' : '<span class="badge badge-success">Activo</span>'}</td>
            <td style="white-space:nowrap;">
              <button class="btn btn-small btn-secondary" onclick="window.editarAlmacen(${a.id})">Editar</button>
              <button class="btn btn-small btn-danger" onclick="window.eliminarAlmacen(${a.id})">Eliminar</button>
            </td>
          </tr>
        `
      }
      html += '</tbody></table>'
      container.innerHTML = html
    }

    await window.renderZonas()
    // Stock por Zona ya no vive dentro de esta card (se movió al tab Resumen
    // Stock, con su propio filtro) — se renderiza solo, no en cascada aquí.
  } catch (error) {
    console.error('Error en renderAlmacenes:', error)
    showToast('Error al cargar los almacenes', 'danger')
  }
}

window.abrirModalNuevoAlmacen = function () {
  document.getElementById('modalAlmacenTitle').textContent = 'Nuevo Almacén'
  const form = document.getElementById('formNewAlmacen')
  if (form) form.reset()
  document.getElementById('almId').value = ''
  window.openModal('modal-nuevo-almacen')
}

window.editarAlmacen = async function (id) {
  try {
    const a = await getAlmacenById(id)
    if (!a) { showToast('No se encontró el almacén', 'danger'); return }

    document.getElementById('modalAlmacenTitle').textContent = 'Editar Almacén'
    document.getElementById('almId').value = a.id
    document.getElementById('almCodigo').value = a.codigo || ''
    document.getElementById('almNombre').value = a.nombre || ''
    document.getElementById('almDireccion').value = a.direccion || ''
    document.getElementById('almUbigeo').value = a.ubigeo || ''
    document.getElementById('almEstablecimientoSunat').value = a.establecimiento_sunat || ''
    document.getElementById('almPrincipal').checked = !!a.es_principal

    window.openModal('modal-nuevo-almacen')
  } catch (error) {
    console.error('Error en editarAlmacen:', error)
    showToast('Error al abrir el almacén', 'danger')
  }
}

window.guardarAlmacen = async function () {
  try {
    const id = parseInt(document.getElementById('almId')?.value || 0)
    const codigo = document.getElementById('almCodigo')?.value?.trim()
    const nombre = document.getElementById('almNombre')?.value?.trim()
    const direccion = document.getElementById('almDireccion')?.value?.trim()
    const ubigeo = document.getElementById('almUbigeo')?.value?.trim() || null
    const establecimientoSunat = document.getElementById('almEstablecimientoSunat')?.value?.trim() || null
    const esPrincipal = document.getElementById('almPrincipal')?.checked || false

    if (!codigo || !nombre || !direccion) {
      showToast('Completa código, nombre y dirección', 'warning')
      return
    }

    const data = { codigo, nombre, direccion, ubigeo, establecimiento_sunat: establecimientoSunat, es_principal: esPrincipal }

    const resultado = id ? await updateAlmacen(id, data) : await addAlmacen(data)
    if (!resultado) { showToast('No se pudo guardar el almacén (¿código duplicado?)', 'danger'); return }

    showToast(id ? 'Almacén actualizado' : 'Almacén creado', 'success')
    window.closeModal('modal-nuevo-almacen')
    await renderAlmacenes()
  } catch (error) {
    console.error('Error en guardarAlmacen:', error)
    showToast('Error al guardar el almacén', 'danger')
  }
}

window.eliminarAlmacen = async function (id) {
  try {
    const almacen = await getAlmacenById(id)
    if (almacen?.es_virtual) {
      showToast('"Partners" es una ubicación virtual usada por el Kardex de compras/ventas — no se puede eliminar.', 'danger')
      return
    }

    const zonas = await getUbicacionesByAlmacen(id)
    if (zonas && zonas.length > 0) {
      showToast(
        `No se puede eliminar: este almacén tiene ${zonas.length} zona(s) registrada(s). Elimina las zonas primero.`,
        'danger'
      )
      return
    }

    if (!confirm('¿Eliminar este almacén?')) return

    const ok = await deleteAlmacen(id)
    if (!ok) { showToast('No se pudo eliminar el almacén (puede tener lotes o movimientos asociados)', 'danger'); return }

    showToast('Almacén eliminado', 'success')
    await renderAlmacenes()
  } catch (error) {
    console.error('Error en eliminarAlmacen:', error)
    showToast('Error al eliminar el almacén', 'danger')
  }
}

// ─── Zonas (ubicaciones) ──────────────────────────────────────────────────────

window.renderZonas = async function () {
  try {
    const container = document.getElementById('tabla-zonas')
    if (!container) return

    const almacenId = parseInt(document.getElementById('filtroZonaAlmacen')?.value || 0)
    const zonas = almacenId ? await getUbicacionesByAlmacen(almacenId) : await getUbicaciones()

    if (!zonas || zonas.length === 0) {
      container.innerHTML = '<p style="text-align:center; color:var(--text-secondary); padding:20px;">Sin zonas registradas</p>'
      return
    }

    const almacenes = await _cargarAlmacenesCache()
    const almacenNombre = {}
    for (const a of (almacenes || [])) almacenNombre[a.id] = `${a.nombre} (${a.codigo})`

    let html = `
      <table>
        <thead>
          <tr>
            <th>Almacén</th><th>Código</th><th>Nombre</th><th>Tipo</th><th>Estado</th><th>Acciones</th>
          </tr>
        </thead>
        <tbody>
    `
    for (const z of zonas) {
      html += `
        <tr>
          <td>${almacenNombre[z.almacen_id] || `Almacén #${z.almacen_id}`}</td>
          <td><strong>${z.codigo}</strong></td>
          <td>${z.nombre}</td>
          <td>${z.tipo || 'zona'}</td>
          <td>${z.activo === false ? '<span class="badge badge-secondary">Inactiva</span>' : '<span class="badge badge-success">Activa</span>'}</td>
          <td style="white-space:nowrap;">
            <button class="btn btn-small btn-secondary" onclick="window.editarZona(${z.id})">Editar</button>
            <button class="btn btn-small btn-danger" onclick="window.eliminarZona(${z.id})">Eliminar</button>
          </td>
        </tr>
      `
    }
    html += '</tbody></table>'
    container.innerHTML = html
  } catch (error) {
    console.error('Error en renderZonas:', error)
    showToast('Error al cargar las zonas', 'danger')
  }
}

window.abrirModalNuevaZona = async function () {
  await _cargarAlmacenesCache()
  document.getElementById('modalZonaTitle').textContent = 'Nueva Zona'
  const form = document.getElementById('formNewZona')
  if (form) form.reset()
  document.getElementById('zonaId').value = ''

  // Preseleccionar el almacén del filtro, si hay uno elegido
  const filtroAlmacen = document.getElementById('filtroZonaAlmacen')?.value || ''
  const selectModal = document.getElementById('zonaAlmacen')
  if (selectModal) {
    selectModal.innerHTML = '<option value="">-- Selecciona --</option>' +
      (_almacenesCache || []).map(a => `<option value="${a.id}">${a.nombre} (${a.codigo})</option>`).join('')
    if (filtroAlmacen) selectModal.value = filtroAlmacen
  }

  window.openModal('modal-nueva-zona')
}

window.editarZona = async function (id) {
  try {
    const z = await getUbicacionById(id)
    if (!z) { showToast('No se encontró la zona', 'danger'); return }

    await _cargarAlmacenesCache()
    const selectModal = document.getElementById('zonaAlmacen')
    if (selectModal) {
      selectModal.innerHTML = '<option value="">-- Selecciona --</option>' +
        (_almacenesCache || []).map(a => `<option value="${a.id}">${a.nombre} (${a.codigo})</option>`).join('')
    }

    document.getElementById('modalZonaTitle').textContent = 'Editar Zona'
    document.getElementById('zonaId').value = z.id
    document.getElementById('zonaAlmacen').value = z.almacen_id
    document.getElementById('zonaCodigo').value = z.codigo || ''
    document.getElementById('zonaNombre').value = z.nombre || ''
    document.getElementById('zonaTipo').value = z.tipo || 'zona'

    window.openModal('modal-nueva-zona')
  } catch (error) {
    console.error('Error en editarZona:', error)
    showToast('Error al abrir la zona', 'danger')
  }
}

window.guardarZona = async function () {
  try {
    const id = parseInt(document.getElementById('zonaId')?.value || 0)
    const almacenId = parseInt(document.getElementById('zonaAlmacen')?.value || 0)
    const codigo = document.getElementById('zonaCodigo')?.value?.trim()
    const nombre = document.getElementById('zonaNombre')?.value?.trim()
    const tipo = document.getElementById('zonaTipo')?.value || 'zona'

    if (!almacenId) { showToast('Selecciona el almacén', 'warning'); return }
    if (!codigo || !nombre) { showToast('Completa código y nombre', 'warning'); return }

    const data = { almacen_id: almacenId, codigo, nombre, tipo }

    const resultado = id ? await updateUbicacion(id, data) : await addUbicacion(data)
    if (!resultado) { showToast('No se pudo guardar la zona (¿código duplicado en ese almacén?)', 'danger'); return }

    showToast(id ? 'Zona actualizada' : 'Zona creada', 'success')
    window.closeModal('modal-nueva-zona')
    await window.renderZonas()
  } catch (error) {
    console.error('Error en guardarZona:', error)
    showToast('Error al guardar la zona', 'danger')
  }
}

window.eliminarZona = async function (id) {
  try {
    const stock = await getStockUbicacionesByUbicacion(id)
    const conStock = (stock || []).filter(s => (parseFloat(s.cantidad) || 0) > 0)
    if (conStock.length > 0) {
      showToast(
        `No se puede eliminar: esta zona todavía tiene stock (${conStock.length} lote(s)). Traslada el stock a otra zona primero.`,
        'danger'
      )
      return
    }

    if (!confirm('¿Eliminar esta zona?')) return

    const ok = await deleteUbicacion(id)
    if (!ok) { showToast('No se pudo eliminar la zona', 'danger'); return }

    showToast('Zona eliminada', 'success')
    await window.renderZonas()
  } catch (error) {
    console.error('Error en eliminarZona:', error)
    showToast('Error al eliminar la zona', 'danger')
  }
}
