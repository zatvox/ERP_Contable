// ============================================================================
// ventas/clientes.js — parte de ventas.js (reorganizado 2026-09-25, sin cambios de lógica)
// Mapa completo de funciones: Claude outputs/glosario_funciones_erp.md
// ============================================================================
import { getCustomers, getContactById, addContact, updateContact, deleteContact } from '../supabase-data.js'
import { pintarBadgeSunat } from '../sunat-api.js'
import { showToast } from '../helpers.js'
import { getModuloConfig } from '../config-modulo.js'
import { _poblarSelectClientes } from './helpers.js'

// ============================================================================
// TAB: CLIENTES
// ============================================================================

// Paginación: 50 clientes por página, con caché para no re-consultar la BD
const CLI_POR_PAGINA = getModuloConfig('ventas').itemsPorPagina || 50
let _cliPagina = 1
let _cliLista = null
let _cliEditandoId = null   // null = modo crear, id = modo editar

export async function renderClientes(forzar = false) {
  try {
    const container = document.getElementById('tabla-clientes')
    if (!container) return

    if (!_cliLista || forzar) {
      _cliLista = await getCustomers()
      _cliPagina = 1
    }

    // Búsqueda en vivo (contiene, sobre la lista ya cacheada — sin red)
    const busqueda = (document.getElementById('buscarCliente')?.value || '').trim().toLowerCase()
    const clientes = busqueda
      ? _cliLista.filter(c => `${c.nombre || ''} ${c.nro_documento || ''}`.toLowerCase().includes(busqueda))
      : _cliLista

    if (!clientes || clientes.length === 0) {
      container.innerHTML = `<p style="text-align:center; color:var(--text-secondary); padding:20px;">${busqueda ? 'Sin resultados para la búsqueda' : 'Sin clientes'}</p>`
      return
    }

    const totalPaginas = Math.max(1, Math.ceil(clientes.length / CLI_POR_PAGINA))
    if (_cliPagina > totalPaginas) _cliPagina = totalPaginas
    if (_cliPagina < 1) _cliPagina = 1
    const inicio = (_cliPagina - 1) * CLI_POR_PAGINA
    const pagina = clientes.slice(inicio, inicio + CLI_POR_PAGINA)

    const paginador = `
      <div style="display:flex; justify-content:space-between; align-items:center; padding:12px 16px;">
        <span style="color:var(--text-secondary); font-size:0.85rem;">
          Mostrando ${inicio + 1}–${inicio + pagina.length} de ${clientes.length} clientes
        </span>
        <div style="display:flex; gap:8px; align-items:center;">
          <button class="btn btn-small btn-secondary" onclick="window.cambiarPaginaClientes(-1)" ${_cliPagina <= 1 ? 'disabled' : ''}>← Anterior</button>
          <span style="font-size:0.85rem;">Página ${_cliPagina} de ${totalPaginas}</span>
          <button class="btn btn-small btn-secondary" onclick="window.cambiarPaginaClientes(1)" ${_cliPagina >= totalPaginas ? 'disabled' : ''}>Siguiente →</button>
        </div>
      </div>
    `

    let html = paginador + `<table>
      <thead>
        <tr>
          <th>Nombre</th><th>Nro Documento</th><th>Email</th>
          <th>Teléfono</th><th>Dirección</th><th>Estado</th><th>Acciones</th>
        </tr>
      </thead>
      <tbody>`

    pagina.forEach(c => {
      html += `<tr>
        <td><strong>${c.nombre || c.razon_social || '-'}</strong></td>
        <td>${c.nro_documento || '-'}</td>
        <td>${c.email || '-'}</td>
        <td>${c.telefono || c.numero || '-'}</td>
        <td style="font-size:0.82rem;">${c.direccion || '-'}</td>
        <td><span class="badge badge-${c.activo === false ? 'danger' : 'success'}">${c.activo === false ? 'Inactivo' : 'Activo'}</span></td>
        <td>
          <button class="btn btn-small btn-secondary" onclick="window.editarCliente(${c.id})">Editar</button>
          <button class="btn btn-small btn-danger" onclick="window.eliminarCliente(${c.id})">Eliminar</button>
        </td>
      </tr>`
    })

    html += '</tbody></table>' + paginador
    container.innerHTML = html
  } catch (e) {
    console.error('renderClientes:', e)
    showToast('Error al cargar clientes', 'danger')
  }
}

window.cambiarPaginaClientes = async function (delta) {
  _cliPagina += delta
  await renderClientes()  // usa caché, solo cambia de página
}

window.filtrarClientes = async function () {
  _cliPagina = 1  // cada nueva búsqueda vuelve a la página 1
  await renderClientes()  // usa caché, solo re-filtra (sin red)
}

function _resetModalCliente() {
  _cliEditandoId = null
  const titulo = document.getElementById('modalClienteTitle')
  if (titulo) titulo.textContent = 'Nuevo Cliente'
  const form = document.getElementById('formNewCliente')
  if (form) form.reset()
  // form.reset() no toca los spans "Datos SUNAT" (no son campos de formulario).
  ;['cliEstadoSunat', 'cliCondicionSunat', 'cliBuenContribuyenteSunat', 'cliAgenteRetencionSunat'].forEach(id => {
    const el = document.getElementById(id)
    if (el) { pintarBadgeSunat(el, '—', 'secondary'); delete el.dataset.value }
  })
  const tipoDocEl = document.getElementById('cliTipoDocumento')
  if (tipoDocEl) tipoDocEl.dispatchEvent(new Event('change'))
}

window.abrirFormularioCliente = function() {
  _resetModalCliente()
  window.openModal('modal-nuevo-cliente')
}

window.guardarCliente = async function() {
  try {
    // Columnas reales de contacts (assets/sql/01_schema.sql + script 44):
    // nombre, tipo_documento, nro_documento, email, numero, direccion,
    // distrito, pais, tipo_contacto (text[]), sujeto_retencion (boolean).
    // Antes el checkbox mandaba "sujeto_retencion" pero esa columna no
    // existía todavía en contacts (se confundía con compras.sujeto_
    // retencion, que es por COMPRA, no por cliente) — rompía el insert con
    // PGRST204 en silencio. Script 44 agregó la columna real; este guardado
    // ahora es un espejo de window.guardarProveedor (compras.js) + el flag.
    const datos = {
      nombre:         document.getElementById('cliNombre')?.value || '',
      tipo_documento: document.getElementById('cliTipoDocumento')?.value || '',
      nro_documento:  document.getElementById('cliRUC')?.value || '',
      email:          document.getElementById('cliEmail')?.value || '',
      numero:         document.getElementById('cliPhone')?.value || '',
      direccion:      document.getElementById('cliDireccion')?.value || '',
      distrito:       document.getElementById('cliDistrito')?.value || '',
      pais:           document.getElementById('cliPais')?.value || '',
      sujeto_retencion: !!document.getElementById('cliSujetoRetencion')?.checked,
      // Datos SUNAT (llenados por "Consultar" si Tipo Documento = RUC; quedan
      // vacíos/null si es DNI o si nunca se consultó — no bloquean el guardado).
      estado:    document.getElementById('cliEstadoSunat')?.textContent === '—' ? null : (document.getElementById('cliEstadoSunat')?.textContent || null),
      condicion: document.getElementById('cliCondicionSunat')?.textContent === '—' ? null : (document.getElementById('cliCondicionSunat')?.textContent || null),
      es_buen_contribuyente: (() => {
        const v = document.getElementById('cliBuenContribuyenteSunat')?.dataset.value
        return v === 'true' ? true : (v === 'false' ? false : null)
      })(),
      es_agente_retencion_sunat: (() => {
        const v = document.getElementById('cliAgenteRetencionSunat')?.dataset.value
        return v === 'true' ? true : (v === 'false' ? false : null)
      })()
    }

    let resultado
    if (_cliEditandoId) {
      // Al editar NO se toca tipo_contacto (conserva su lista actual)
      resultado = await updateContact(_cliEditandoId, datos)
    } else {
      resultado = await addContact({ ...datos, tipo_contacto: ['cliente'] })  // text[] en la BD
    }

    if (!resultado) {
      showToast('Error al guardar el cliente en base de datos', 'danger')
      return
    }

    showToast(_cliEditandoId ? 'Cliente actualizado' : 'Cliente creado exitosamente', 'success')
    window.closeModal('modal-nuevo-cliente')
    _resetModalCliente()
    _poblarSelectClientes()
    await renderClientes(true)
  } catch (e) {
    console.error('guardarCliente:', e)
    showToast('Error: ' + e.message, 'danger')
  }
}

window.editarCliente = async function(id) {
  try {
    const c = await getContactById(id)
    if (!c) { showToast('Cliente no encontrado', 'warning'); return }

    document.getElementById('cliNombre').value = c.nombre || ''
    document.getElementById('cliTipoDocumento').value = c.tipo_documento || ''
    document.getElementById('cliRUC').value    = c.nro_documento || ''
    document.getElementById('cliEmail').value  = c.email || ''
    document.getElementById('cliPhone').value  = c.telefono || c.numero || ''
    document.getElementById('cliDireccion').value = c.direccion || ''
    document.getElementById('cliDistrito').value  = c.distrito || ''
    document.getElementById('cliPais').value      = c.pais || ''
    const chkRet = document.getElementById('cliSujetoRetencion')
    if (chkRet) chkRet.checked = !!c.sujeto_retencion

    // Datos SUNAT guardados de una consulta previa (si el contacto es RUC).
    pintarBadgeSunat(document.getElementById('cliEstadoSunat'), c.estado || '—', c.estado === 'ACTIVO' ? 'success' : (c.estado ? 'danger' : 'secondary'))
    pintarBadgeSunat(document.getElementById('cliCondicionSunat'), c.condicion || '—', c.condicion === 'HABIDO' ? 'success' : (c.condicion ? 'danger' : 'secondary'))
    const bcEl = document.getElementById('cliBuenContribuyenteSunat')
    if (bcEl) {
      pintarBadgeSunat(bcEl, c.es_buen_contribuyente === true ? 'Sí' : (c.es_buen_contribuyente === false ? 'No' : '—'), c.es_buen_contribuyente === true ? 'success' : 'secondary')
      bcEl.dataset.value = c.es_buen_contribuyente === null || c.es_buen_contribuyente === undefined ? '' : String(c.es_buen_contribuyente)
    }
    const arEl = document.getElementById('cliAgenteRetencionSunat')
    if (arEl) {
      pintarBadgeSunat(arEl, c.es_agente_retencion_sunat === true ? 'Sí' : (c.es_agente_retencion_sunat === false ? 'No' : '—'), c.es_agente_retencion_sunat === true ? 'success' : 'secondary')
      arEl.dataset.value = c.es_agente_retencion_sunat === null || c.es_agente_retencion_sunat === undefined ? '' : String(c.es_agente_retencion_sunat)
    }
    // Dispara el toggle de visibilidad del bloque "Datos SUNAT" según el
    // tipo_documento recién cargado (attachConsultaDocumento escucha 'change').
    const tipoDocEl = document.getElementById('cliTipoDocumento')
    if (tipoDocEl) tipoDocEl.dispatchEvent(new Event('change'))

    _cliEditandoId = id
    const titulo = document.getElementById('modalClienteTitle')
    if (titulo) titulo.textContent = `Editar Cliente #${id}`
    window.openModal('modal-nuevo-cliente')
  } catch (e) {
    console.error('editarCliente:', e)
    showToast('Error al editar cliente', 'danger')
  }
}

window.eliminarCliente = async function(id) {
  try {
    if (!confirm('¿Eliminar este cliente? Esta acción no se puede deshacer.')) return
    await deleteContact(id)
    showToast('Cliente eliminado', 'success')
    _poblarSelectClientes()
    await renderClientes(true)
  } catch (e) {
    console.error('eliminarCliente:', e)
    showToast('Error al eliminar cliente. Puede tener documentos asociados.', 'danger')
  }
}
