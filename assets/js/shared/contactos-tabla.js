// ============================================================================
// shared/contactos-tabla.js — Tabla estándar de contactos (2026-10-07)
// La misma tabla para Ventas → Clientes y Compras → Proveedores (cambia solo
// el rol por defecto del filtro). Patrón "tabla operativa" del estándar:
// header con botones + menú ⋮ de columnas en la esquina, barra de filtros,
// orden por columna, acciones por fila en ⋮, paginación y Exportar Excel.
//
//   montarTablaContactos('card-contactos-clientes', { tabla: 'contactos-clientes', rol: 'cliente', titulo: 'Clientes' })
// ============================================================================
import { getContacts, deleteContact, updateContact, tiposDeContacto, ultimoErrorDelete } from '../supabase-data.js'
import { showToast } from '../helpers.js'
import { registrarColumnas, colMenuHtml, colStyle, colsVisibles } from '../col-menu.js'
import { menuAccionesFila } from '../main.js'
import { abrirModalContacto, ROLES_CONTACTO, linkWhatsApp, esLinkMaps, telefonoDe } from './contacto-modal.js'

const POR_PAGINA = 50
const _inst = {}   // instId → { opts, f: filtros, sort, pagina, lista }
const _esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const GUION = '<span style="color:var(--text-secondary);">—</span>'
const ROL_COLOR = { cliente: 'info', proveedor: 'warning', vendedor: 'success' }

const COLS = [
  { key: 'nombre',    label: 'Nombre / Razón social' },
  { key: 'tipo_doc',  label: 'Tipo doc.', oculta: true },
  { key: 'nro_doc',   label: 'N° documento' },
  { key: 'roles',     label: 'Rol' },
  { key: 'telefono',  label: 'Teléfono' },
  { key: 'email',     label: 'Email' },
  { key: 'direccion', label: 'Dirección' },
  { key: 'distrito',  label: 'Distrito' },
  { key: 'pais',      label: 'País', oculta: true },
  { key: 'maps',      label: 'Ubicación (Maps)' },
  { key: 'retencion', label: 'Retención IGV', oculta: true },
  { key: 'sunat',     label: 'Estado SUNAT', oculta: true },
  { key: 'estado',    label: 'Estado' },
  { key: 'acciones',  label: 'Acciones' }
]

function _valor(c, key) {
  switch (key) {
    case 'nombre':    return (c.nombre || '').trim().toLowerCase()
    case 'tipo_doc':  return c.tipo_documento || ''
    case 'nro_doc':   return c.nro_documento || ''
    case 'roles':     return tiposDeContacto(c).join(',')
    case 'telefono':  return telefonoDe(c)
    case 'email':     return (c.email || '').toLowerCase()
    case 'direccion': return (c.direccion || '').toLowerCase()
    case 'distrito':  return (c.distrito || '').toLowerCase()
    case 'pais':      return (c.pais || '').toLowerCase()
    case 'maps':      return c.ubicacion_maps ? 0 : 1
    case 'retencion': return c.sujeto_retencion ? 0 : 1
    case 'sunat':     return c.estado || ''
    case 'estado':    return c.activo === false ? 1 : 0
    default: return ''
  }
}
/** Texto plano para Excel */
function _texto(c, key) {
  switch (key) {
    case 'nombre':    return c.nombre || ''
    case 'tipo_doc':  return c.tipo_documento || ''
    case 'nro_doc':   return c.nro_documento || ''
    case 'roles':     return tiposDeContacto(c).join(', ')
    case 'telefono':  return telefonoDe(c)
    case 'email':     return c.email || ''
    case 'direccion': return c.direccion || ''
    case 'distrito':  return c.distrito || ''
    case 'pais':      return c.pais || ''
    case 'maps':      return c.ubicacion_maps || ''
    case 'retencion': return c.sujeto_retencion ? 'Sí' : 'No'
    case 'sunat':     return [c.estado, c.condicion].filter(Boolean).join(' / ')
    case 'estado':    return c.activo === false ? 'Inactivo' : 'Activo'
    default: return ''
  }
}

function _celda(c, key) {
  switch (key) {
    case 'nombre':    return `<strong>${_esc(c.nombre || '—')}</strong>`
    case 'tipo_doc':  return _esc(c.tipo_documento || '—')
    case 'nro_doc':   return `<span style="font-variant-numeric:tabular-nums;">${_esc(c.nro_documento || '—')}</span>`
    case 'roles':     return tiposDeContacto(c).map(r => {
      const def = ROLES_CONTACTO.find(x => x.key === r)
      return `<span class="badge badge-${ROL_COLOR[r] || 'secondary'}" style="margin:1px 2px 1px 0;">${def ? def.label : _esc(r)}</span>`
    }).join('') || GUION
    case 'telefono': {
      const t = telefonoDe(c); if (!t) return GUION
      const wa = linkWhatsApp(t)
      return wa ? `<a href="${wa}" target="_blank" rel="noopener" title="Abrir WhatsApp" style="white-space:nowrap; color:var(--color-success); font-weight:600;">💬 ${_esc(t)}</a>` : _esc(t)
    }
    case 'email':     return c.email ? `<a href="mailto:${_esc(c.email)}" style="color:var(--color-info);">${_esc(c.email)}</a>` : GUION
    case 'direccion': return c.direccion ? `<span style="font-size:0.82rem;">${_esc(c.direccion)}</span>` : GUION
    case 'distrito':  return _esc(c.distrito || '—')
    case 'pais':      return _esc(c.pais || '—')
    case 'maps':      return c.ubicacion_maps
      ? `<a href="${_esc(c.ubicacion_maps)}" target="_blank" rel="noopener" title="${_esc(c.ubicacion_maps)}" style="white-space:nowrap; color:var(--color-info); font-weight:600;">📍 Ver mapa${esLinkMaps(c.ubicacion_maps) ? '' : ' ⚠'}</a>`
      : `<span style="color:var(--text-secondary); font-size:0.8rem;">Sin ubicación</span>`
    case 'retencion': return c.sujeto_retencion ? '<span class="badge badge-warning">Sí</span>' : GUION
    case 'sunat':     return c.estado ? `<span class="badge badge-${c.estado === 'ACTIVO' && (c.condicion || 'HABIDO') === 'HABIDO' ? 'success' : 'danger'}">${_esc(c.estado)}${c.condicion ? ' · ' + _esc(c.condicion) : ''}</span>` : GUION
    case 'estado':    return `<span class="badge badge-${c.activo === false ? 'danger' : 'success'}">${c.activo === false ? 'Inactivo' : 'Activo'}</span>`
    default: return ''
  }
}

// ─── Montaje ────────────────────────────────────────────────────────────────
export async function montarTablaContactos(containerId, opts) {
  const card = document.getElementById(containerId)
  if (!card) return
  const instId = containerId
  if (!_inst[instId]) {
    registrarColumnas(opts.tabla, COLS)
    _inst[instId] = { opts, f: { q: '', rol: opts.rol || '', estado: 'activo', ubic: '' }, sort: { col: 'nombre', dir: 'asc' }, pagina: 1, lista: null }
    _esqueleto(card, instId)
  }
  await refrescarTablaContactos(instId, true)
}

function _esqueleto(card, id) {
  const { opts, f } = _inst[id]
  const sel = 'style="width:100%;"'
  card.innerHTML = `
    ${colMenuHtml(opts.tabla, `${id}-colmenu`, `${id}-colmenu-dd`)}
    <div class="card-header" style="flex-direction:column; align-items:stretch; gap:12px;">
      <div style="display:flex; justify-content:space-between; align-items:center; gap:10px; flex-wrap:wrap; padding-right:34px;">
        <h3 class="card-title">${_esc(opts.titulo)}</h3>
        <div style="display:flex; gap:8px; flex-wrap:wrap;">
          <button class="btn btn-secondary btn-small" onclick="window._ctTabla('${id}','excel')">📊 Exportar Excel</button>
          <button class="btn btn-primary btn-small" onclick="window._ctTabla('${id}','nuevo')">+ Nuevo contacto</button>
        </div>
      </div>
      <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(150px, 1fr)); gap:10px; align-items:end;">
        <div class="form-group" style="margin:0; grid-column:span 2;">
          <label style="font-size:0.75rem;">Buscar</label>
          <input type="text" placeholder="Nombre, RUC/DNI, teléfono, email, distrito..." value="${_esc(f.q)}" oninput="window._ctTabla('${id}','q',this.value)" ${sel}>
        </div>
        <div class="form-group" style="margin:0;">
          <label style="font-size:0.75rem;">Rol</label>
          <select onchange="window._ctTabla('${id}','rol',this.value)" ${sel}>
            <option value="">Todos los roles</option>
            ${ROLES_CONTACTO.map(r => `<option value="${r.key}" ${f.rol === r.key ? 'selected' : ''}>${r.plural}</option>`).join('')}
          </select>
        </div>
        <div class="form-group" style="margin:0;">
          <label style="font-size:0.75rem;">Estado</label>
          <select onchange="window._ctTabla('${id}','estado',this.value)" ${sel}>
            <option value="activo" selected>Activos</option><option value="inactivo">Inactivos</option><option value="">Todos</option>
          </select>
        </div>
        <div class="form-group" style="margin:0;">
          <label style="font-size:0.75rem;">Ubicación</label>
          <select onchange="window._ctTabla('${id}','ubic',this.value)" ${sel}>
            <option value="">Todas</option><option value="con">📍 Con ubicación</option><option value="sin">Sin ubicación</option>
          </select>
        </div>
      </div>
    </div>
    <div id="${id}-cuerpo" class="table-container"><p style="text-align:center; color:var(--text-secondary); padding:20px;">Cargando...</p></div>`
}

function _filtrados(id) {
  const { f, sort, lista } = _inst[id]
  const q = f.q.trim().toLowerCase()
  let out = (lista || []).filter(c => {
    if (f.rol && !tiposDeContacto(c).includes(f.rol)) return false
    if (f.estado === 'activo' && c.activo === false) return false
    if (f.estado === 'inactivo' && c.activo !== false) return false
    if (f.ubic === 'con' && !c.ubicacion_maps) return false
    if (f.ubic === 'sin' && c.ubicacion_maps) return false
    if (q && !`${c.nombre || ''} ${c.nro_documento || ''} ${telefonoDe(c)} ${c.email || ''} ${c.distrito || ''} ${c.direccion || ''}`.toLowerCase().includes(q)) return false
    return true
  })
  const dir = sort.dir === 'asc' ? 1 : -1
  out.sort((a, b) => {
    const va = _valor(a, sort.col), vb = _valor(b, sort.col)
    if (va < vb) return -dir
    if (va > vb) return dir
    return (a.nombre || '').trim().localeCompare((b.nombre || '').trim())
  })
  return out
}

export async function refrescarTablaContactos(id, recargar = false) {
  const st = _inst[id]; if (!st) return
  if (recargar || !st.lista) st.lista = (await getContacts().catch(() => [])) || []
  const cuerpo = document.getElementById(`${id}-cuerpo`)
  if (!cuerpo) return
  const tabla = st.opts.tabla
  const filas = _filtrados(id)
  const total = filas.length
  const paginas = Math.max(1, Math.ceil(total / POR_PAGINA))
  st.pagina = Math.min(Math.max(1, st.pagina), paginas)
  const ini = (st.pagina - 1) * POR_PAGINA
  const pag = filas.slice(ini, ini + POR_PAGINA)
  const conUbic = filas.filter(c => c.ubicacion_maps).length

  const th = (c) => {
    if (c.key === 'acciones') return `<th data-col-tabla="${tabla}" data-col="acciones"${colStyle(tabla, 'acciones')} style="width:60px;">Acciones</th>`
    const activa = st.sort.col === c.key
    const flecha = activa ? (st.sort.dir === 'asc' ? ' ▲' : ' ▼') : ' <span class="rp-orden-hint">⇅</span>'
    const oculto = colStyle(tabla, c.key) ? ' display:none;' : ''
    return `<th data-col-tabla="${tabla}" data-col="${c.key}" style="cursor:pointer; user-select:none; white-space:nowrap;${oculto}" onclick="window._ctTabla('${id}','sort','${c.key}')">${c.label}${flecha}</th>`
  }
  const td = (c, col) => {
    if (col.key === 'acciones') {
      const tel = telefonoDe(c), wa = linkWhatsApp(tel)
      return `<td data-col-tabla="${tabla}" data-col="acciones" class="col-acciones"${colStyle(tabla, 'acciones')}>${menuAccionesFila([
        { icono: '✏️', label: 'Editar', onclick: `window._ctTabla('${id}','editar',${c.id})` },
        c.ubicacion_maps ? { icono: '📍', label: 'Abrir en Maps', href: c.ubicacion_maps } : null,
        wa ? { icono: '💬', label: 'WhatsApp', href: wa } : null,
        c.email ? { icono: '✉️', label: 'Enviar email', href: `mailto:${c.email}`, target: '_self' } : null,
        { separador: true },
        { icono: '✕', label: 'Eliminar', peligro: true, onclick: `window._ctTabla('${id}','eliminar',${c.id})` }
      ])}</td>`
    }
    const oculto = colStyle(tabla, col.key) ? ' style="display:none;"' : ''
    return `<td data-col-tabla="${tabla}" data-col="${col.key}"${oculto}>${_celda(c, col.key)}</td>`
  }
  const paginador = `
    <div style="display:flex; justify-content:space-between; align-items:center; gap:10px; flex-wrap:wrap; padding:10px 16px;">
      <span style="color:var(--text-secondary); font-size:0.85rem;">
        ${total ? `${ini + 1}–${ini + pag.length} de ${total}` : '0'} contactos · 📍 ${conUbic} con ubicación
      </span>
      ${paginas > 1 ? `<div style="display:flex; gap:8px; align-items:center;">
        <button class="btn btn-small btn-secondary" onclick="window._ctTabla('${id}','pag',-1)" ${st.pagina <= 1 ? 'disabled' : ''}>← Anterior</button>
        <span style="font-size:0.85rem;">Página ${st.pagina} de ${paginas}</span>
        <button class="btn btn-small btn-secondary" onclick="window._ctTabla('${id}','pag',1)" ${st.pagina >= paginas ? 'disabled' : ''}>Siguiente →</button>
      </div>` : ''}
    </div>`

  cuerpo.innerHTML = !total
    ? `<p style="text-align:center; color:var(--text-secondary); padding:24px;">Sin contactos para estos filtros</p>`
    : `<table><thead><tr>${COLS.map(th).join('')}</tr></thead>
       <tbody>${pag.map(c => `<tr ondblclick="window._ctTabla('${id}','editar',${c.id})" style="${c.activo === false ? 'opacity:0.6;' : ''}">${COLS.map(col => td(c, col)).join('')}</tr>`).join('')}</tbody></table>
       ${paginador}`
}

// ─── Acciones ───────────────────────────────────────────────────────────────
window._ctTabla = async function (id, accion, arg) {
  const st = _inst[id]; if (!st) return
  switch (accion) {
    case 'q':      st.f.q = arg || ''; st.pagina = 1; return refrescarTablaContactos(id)
    case 'rol':    st.f.rol = arg; st.pagina = 1; return refrescarTablaContactos(id)
    case 'estado': st.f.estado = arg; st.pagina = 1; return refrescarTablaContactos(id)
    case 'ubic':   st.f.ubic = arg; st.pagina = 1; return refrescarTablaContactos(id)
    case 'pag':    st.pagina += arg; return refrescarTablaContactos(id)
    case 'sort':
      st.sort = st.sort.col === arg ? { col: arg, dir: st.sort.dir === 'asc' ? 'desc' : 'asc' } : { col: arg, dir: 'asc' }
      return refrescarTablaContactos(id)
    case 'nuevo':  return abrirModalContacto({ roles: st.opts.rol ? [st.opts.rol] : [] })
    case 'editar': window.cerrarMenuAcciones?.(); return abrirModalContacto({ id: arg })
    case 'eliminar': window.cerrarMenuAcciones?.(); return _eliminar(id, arg)
    case 'excel':  return _exportar(id)
  }
}

async function _eliminar(id, contactoId) {
  const st = _inst[id]
  const c = (st.lista || []).find(x => x.id === contactoId)
  if (!c) return
  const roles = tiposDeContacto(c)
  const rolTabla = st.f.rol || st.opts.rol
  // Si tiene otros roles, lo correcto es quitar solo el rol de esta lista
  if (rolTabla && roles.includes(rolTabla) && roles.length > 1) {
    if (!confirm(`${c.nombre} también es ${roles.filter(r => r !== rolTabla).join(', ')}.\n\n¿Quitarle solo el rol "${rolTabla}"? (no se borra el contacto)`)) return
    const r = await updateContact(c.id, { tipo_contacto: roles.filter(x => x !== rolTabla) })
    if (!r) { showToast('No se pudo quitar el rol', 'danger'); return }
    showToast(`Rol ${rolTabla} retirado de ${c.nombre}`, 'success')
    window.dispatchEvent(new CustomEvent('contacto-guardado', { detail: { contacto: { ...c, tipo_contacto: roles.filter(x => x !== rolTabla) }, nuevo: false } }))
    return
  }
  if (!confirm(`¿Eliminar a ${c.nombre}? Esta acción no se puede deshacer.\n\nSi tiene documentos, mejor desmárcalo como "Activo" desde Editar.`)) return
  const ok = await deleteContact(c.id)
  if (!ok) {
    const m = ultimoErrorDelete?.()
    showToast(`No se pudo eliminar: tiene documentos asociados${m?.mensaje ? ' (' + m.mensaje + ')' : ''}. Puedes marcarlo como Inactivo.`, 'warning', 7000)
    return
  }
  showToast('Contacto eliminado', 'success')
  window.dispatchEvent(new CustomEvent('contacto-guardado', { detail: { contacto: { ...c, _eliminado: true }, nuevo: false } }))
}

async function _exportar(id) {
  const st = _inst[id]
  const vis = colsVisibles(st.opts.tabla)
  const cols = COLS.filter(c => c.key !== 'acciones' && vis[c.key])
  const filas = _filtrados(id)
  const aoa = [cols.map(c => c.label), ...filas.map(c => cols.map(col => _texto(c, col.key)))]
  const nombre = `${st.opts.titulo}_${new Date().toISOString().slice(0, 10)}`
  try {
    const XLSX = await import('https://cdn.jsdelivr.net/npm/xlsx@0.18.5/+esm')
    const ws = XLSX.utils.aoa_to_sheet(aoa)
    ws['!cols'] = cols.map((c, i) => ({ wch: Math.min(60, Math.max(10, ...aoa.map(f => String(f[i] ?? '').length + 2))) }))
    ws['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: aoa.length - 1, c: cols.length - 1 } }) }
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, st.opts.titulo.slice(0, 31))
    XLSX.writeFile(wb, `${nombre}.xlsx`)
  } catch (e) {
    console.warn('SheetJS no cargó, exporto CSV:', e)
    const csv = aoa.map(f => f.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\r\n')
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }))
    a.download = `${nombre}.csv`; a.click()
  }
}

// Cualquier alta/edición/baja de contacto refresca todas las tablas montadas
window.addEventListener('contacto-guardado', () => {
  Object.keys(_inst).forEach(id => refrescarTablaContactos(id, true))
})
