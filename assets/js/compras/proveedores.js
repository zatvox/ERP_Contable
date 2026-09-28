// ============================================================================
// compras/proveedores.js — parte de compras.js (reorganizado 2026-09-25, sin cambios de lógica)
// Mapa completo de funciones: Claude outputs/glosario_funciones_erp.md
// ============================================================================
import { getCurrentUser } from '../auth-supabase.js'
import { getSuppliers, addContact, getContactById, updateContact, deleteContact } from '../supabase-data.js'
import { pintarBadgeSunat } from '../sunat-api.js'
import { showToast } from '../helpers.js'
import { cargarProveedoresSelect } from './formularios.js'

// ============================================================================
// PROVEEDORES
// ============================================================================
// El ingreso a almacén (creación de lotes) se hace desde el tab "Guía de
// Remisión" (window.guardarGuiaIngresoCompra), no al registrar la compra.

// Paginación: 50 proveedores por página, con caché para no re-consultar la BD
const PROV_POR_PAGINA = 50
let _provPagina = 1
let _provLista = null

export async function renderProveedores(forzar = false) {
  try {
    const container = document.getElementById('tabla-proveedores')
    if (!container) return

    if (!_provLista || forzar) {
      _provLista = await getSuppliers()
      _provPagina = 1
    }

    // Búsqueda en vivo (contiene, sobre la lista ya cacheada — sin red)
    const busqueda = (document.getElementById('buscarProveedor')?.value || '').trim().toLowerCase()
    const proveedores = busqueda
      ? _provLista.filter(p => `${p.nombre || ''} ${p.nro_documento || ''}`.toLowerCase().includes(busqueda))
      : _provLista

    if (!proveedores || proveedores.length === 0) {
      container.innerHTML = `<p style="text-align: center; color: var(--text-secondary); padding: 20px;">${busqueda ? 'Sin resultados para la búsqueda' : 'Sin proveedores'}</p>`
      return
    }

    const totalPaginas = Math.max(1, Math.ceil(proveedores.length / PROV_POR_PAGINA))
    if (_provPagina > totalPaginas) _provPagina = totalPaginas
    if (_provPagina < 1) _provPagina = 1
    const inicio = (_provPagina - 1) * PROV_POR_PAGINA
    const pagina = proveedores.slice(inicio, inicio + PROV_POR_PAGINA)

    const paginador = `
      <div style="display:flex; justify-content:space-between; align-items:center; padding:12px 16px;">
        <span style="color:var(--text-secondary); font-size:0.85rem;">
          Mostrando ${inicio + 1}–${inicio + pagina.length} de ${proveedores.length} proveedores
        </span>
        <div style="display:flex; gap:8px; align-items:center;">
          <button class="btn btn-small btn-secondary" onclick="window.cambiarPaginaProveedores(-1)" ${_provPagina <= 1 ? 'disabled' : ''}>← Anterior</button>
          <span style="font-size:0.85rem;">Página ${_provPagina} de ${totalPaginas}</span>
          <button class="btn btn-small btn-secondary" onclick="window.cambiarPaginaProveedores(1)" ${_provPagina >= totalPaginas ? 'disabled' : ''}>Siguiente →</button>
        </div>
      </div>
    `

    let html = paginador + `
      <table>
        <thead>
          <tr>
            <th>Nombre</th>
            <th>Nro Documento</th>
            <th>Email</th>
            <th>Teléfono</th>
            <th>Dirección</th>
            <th>Pais</th>
            <th>Acciones</th>
          </tr>
        </thead>
        <tbody>
    `

    pagina.forEach(p => {
      html += `
        <tr>
          <td>${p.nombre || '-'}</td>
          <td>${p.nro_documento || '-'}</td>
          <td>${p.email || '-'}</td>
          <td>${p.telefono || p.numero || '-'}</td>
          <td>${p.direccion || '-'}</td>
          <td>${p.pais || '-'}</td>
          <td>
            <button class="btn btn-small btn-secondary" onclick="window.editarProveedor(${p.id})">Editar</button>
            <button class="btn btn-small btn-danger" onclick="window.eliminarProveedor(${p.id})">Eliminar</button>
          </td>
        </tr>
      `
    })

    html += '</tbody></table>' + paginador
    container.innerHTML = html
  } catch (error) {
    console.error('Error en renderProveedores:', error)
    showToast('Error al cargar los proveedores', 'danger')
  }
}

window.cambiarPaginaProveedores = async function (delta) {
  _provPagina += delta
  await renderProveedores()  // usa caché, solo cambia de página
}

window.filtrarProveedores = async function () {
  _provPagina = 1  // cada nueva búsqueda vuelve a la página 1
  await renderProveedores()  // usa caché, solo re-filtra (sin red)
}

// ID del proveedor en edición (null = modo crear)
let _provEditandoId = null

function _resetModalProveedor() {
  _provEditandoId = null
  const titulo = document.getElementById('modalProveedorTitle')
  if (titulo) titulo.textContent = 'Nuevo Proveedor'
  const form = document.getElementById('formNewProveedor')
  if (form) form.reset()
  // form.reset() no toca los spans "Datos SUNAT" (no son campos de formulario).
  ;['provEstadoSunat', 'provCondicionSunat', 'provBuenContribuyenteSunat', 'provAgenteRetencionSunat'].forEach(id => {
    const el = document.getElementById(id)
    if (el) { pintarBadgeSunat(el, '—', 'secondary'); delete el.dataset.value }
  })
  const tipoDocEl = document.getElementById('provTipoDocumento')
  if (tipoDocEl) tipoDocEl.dispatchEvent(new Event('change'))
}

window.abrirModalNuevoProveedor = function () {
  _resetModalProveedor()
  window.openModal('modal-nuevo-proveedor')
}

window.editarProveedor = async function (provId) {
  try {
    const p = await getContactById(provId)
    if (!p) { showToast('Proveedor no encontrado', 'danger'); return }

    document.getElementById('provNombre').value = p.nombre || ''
    document.getElementById('provTipoDocumento').value = p.tipo_documento || ''
    document.getElementById('provRUC').value = p.nro_documento || ''
    document.getElementById('provEmail').value = p.email || ''
    document.getElementById('provPhone').value = p.telefono || p.numero || ''
    document.getElementById('provDireccion').value = p.direccion || ''
    document.getElementById('provDistrito').value = p.distrito || ''
    document.getElementById('provPais').value = p.pais || ''
    const chkRet = document.getElementById('provSujetoRetencion')
    if (chkRet) chkRet.checked = !!p.sujeto_retencion

    // Datos SUNAT guardados de una consulta previa (si el contacto es RUC).
    pintarBadgeSunat(document.getElementById('provEstadoSunat'), p.estado || '—', p.estado === 'ACTIVO' ? 'success' : (p.estado ? 'danger' : 'secondary'))
    pintarBadgeSunat(document.getElementById('provCondicionSunat'), p.condicion || '—', p.condicion === 'HABIDO' ? 'success' : (p.condicion ? 'danger' : 'secondary'))
    const bcEl = document.getElementById('provBuenContribuyenteSunat')
    if (bcEl) {
      pintarBadgeSunat(bcEl, p.es_buen_contribuyente === true ? 'Sí' : (p.es_buen_contribuyente === false ? 'No' : '—'), p.es_buen_contribuyente === true ? 'success' : 'secondary')
      bcEl.dataset.value = p.es_buen_contribuyente === null || p.es_buen_contribuyente === undefined ? '' : String(p.es_buen_contribuyente)
    }
    const arEl = document.getElementById('provAgenteRetencionSunat')
    if (arEl) {
      pintarBadgeSunat(arEl, p.es_agente_retencion_sunat === true ? 'Sí' : (p.es_agente_retencion_sunat === false ? 'No' : '—'), p.es_agente_retencion_sunat === true ? 'success' : 'secondary')
      arEl.dataset.value = p.es_agente_retencion_sunat === null || p.es_agente_retencion_sunat === undefined ? '' : String(p.es_agente_retencion_sunat)
    }
    // Dispara el toggle de visibilidad del bloque "Datos SUNAT" según el
    // tipo_documento recién cargado (attachConsultaDocumento escucha 'change').
    const tipoDocEl = document.getElementById('provTipoDocumento')
    if (tipoDocEl) tipoDocEl.dispatchEvent(new Event('change'))

    _provEditandoId = provId
    const titulo = document.getElementById('modalProveedorTitle')
    if (titulo) titulo.textContent = `Editar Proveedor #${provId}`
    window.openModal('modal-nuevo-proveedor')
  } catch (error) {
    console.error('Error en editarProveedor:', error)
    showToast('Error al editar proveedor', 'danger')
  }
}

window.eliminarProveedor = async function (provId) {
  try {
    if (!confirm('¿Eliminar este proveedor? Esta acción no se puede deshacer.')) return

    const ok = await deleteContact(provId)
    if (!ok) {
      showToast('No se pudo eliminar: el contacto tiene documentos asociados (compras, CxP, etc.)', 'warning')
      return
    }
    showToast('Proveedor eliminado', 'success')
    await renderProveedores(true)
    await cargarProveedoresSelect()
  } catch (error) {
    console.error('Error en eliminarProveedor:', error)
    showToast('Error al eliminar proveedor', 'danger')
  }
}

window.guardarProveedor = async function () {
  try {
    const user = await getCurrentUser()
    if (!user) {
      showToast('Usuario no autenticado', 'danger')
      return
    }

    const prov = {
      nombre: document.getElementById('provNombre')?.value || '',
      tipo_documento: document.getElementById('provTipoDocumento')?.value || '',
      nro_documento: document.getElementById('provRUC')?.value || '',
      email: document.getElementById('provEmail')?.value || '',
      numero: document.getElementById('provPhone')?.value || '',
      direccion: document.getElementById('provDireccion')?.value || '',
      distrito: document.getElementById('provDistrito')?.value || '',
      pais: document.getElementById('provPais')?.value || '',
      sujeto_retencion: !!document.getElementById('provSujetoRetencion')?.checked,
      // Datos SUNAT (llenados por "Consultar" si Tipo Documento = RUC).
      estado:    document.getElementById('provEstadoSunat')?.textContent === '—' ? null : (document.getElementById('provEstadoSunat')?.textContent || null),
      condicion: document.getElementById('provCondicionSunat')?.textContent === '—' ? null : (document.getElementById('provCondicionSunat')?.textContent || null),
      es_buen_contribuyente: (() => {
        const v = document.getElementById('provBuenContribuyenteSunat')?.dataset.value
        return v === 'true' ? true : (v === 'false' ? false : null)
      })(),
      es_agente_retencion_sunat: (() => {
        const v = document.getElementById('provAgenteRetencionSunat')?.dataset.value
        return v === 'true' ? true : (v === 'false' ? false : null)
      })()
    }

    let resultado
    if (_provEditandoId) {
      // Al editar NO se toca tipo_contacto (conserva su lista actual)
      resultado = await updateContact(_provEditandoId, prov)
    } else {
      resultado = await addContact({ ...prov, tipo_contacto: ['proveedor'] })  // text[] en la BD
    }

    if (!resultado) {
      showToast('Error al guardar el proveedor en base de datos', 'danger')
      return
    }

    showToast(_provEditandoId ? 'Proveedor actualizado' : 'Proveedor guardado exitosamente', 'success')
    window.closeModal('modal-nuevo-proveedor')
    _resetModalProveedor()
    await renderProveedores(true)
    await cargarProveedoresSelect()
  } catch (error) {
    console.error('Error en guardarProveedor:', error)
    showToast('Error al guardar el proveedor', 'danger')
  }
}
