// ============================================================================
// shared/contacto-modal.js — Modal ÚNICO "Nuevo / Editar contacto" (2026-10-07)
// Lo usan Ventas (Clientes, Nueva Venta, PK, Cotización) y Compras
// (Proveedores, buscadores). Un contacto puede tener varios roles a la vez:
// Cliente / Proveedor / Vendedor (contacts.tipo_contacto text[]).
//
// API:
//   abrirModalContacto({ roles: ['cliente'] })   → crear con rol(es) sugeridos
//   abrirModalContacto({ id })                   → editar
// Al guardar dispara en window:
//   'contacto-guardado' { contacto, nuevo }  (módulos y tablas escuchan)
//   'cliente-creado'    contacto             (compat. Nuevo PK: nuevo + rol cliente)
// Requiere SQL 76 (contacts.ubicacion_maps).
// ============================================================================
import { getContacts, getContactById, addContact, updateContact, tiposDeContacto } from '../supabase-data.js'
import { attachConsultaDocumento, pintarBadgeSunat } from '../sunat-api.js'
import { showToast } from '../helpers.js'

export const ROLES_CONTACTO = [
  { key: 'cliente',   label: 'Cliente',   plural: 'Clientes',    icono: '🛒' },
  { key: 'proveedor', label: 'Proveedor', plural: 'Proveedores', icono: '📦' },
  { key: 'vendedor',  label: 'Vendedor',  plural: 'Vendedores',  icono: '🧑‍💼' }
]

let _editId = null
let _rolesSel = new Set()
let _rolesExtra = []        // roles fuera de los chips (empleado/otro): se conservan al guardar

const _esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const $ = (id) => document.getElementById(id)
const SEC = 'display:block; margin:16px 0 8px; color:var(--text-secondary); font-size:0.85rem; text-transform:uppercase; letter-spacing:0.03em;'

// ─── Utilidades públicas (también las usa la tabla) ─────────────────────────
/** Coordenadas "lat, lng" → link de Maps; "www…" → https://www… */
export function normalizarLinkMaps(v) {
  const s = String(v || '').trim()
  if (!s) return ''
  const m = /^(-?\d{1,2}\.\d+)\s*,\s*(-?\d{1,3}\.\d+)$/.exec(s)
  if (m) return `https://www.google.com/maps?q=${m[1]},${m[2]}`
  if (/^www\./i.test(s)) return 'https://' + s
  return s
}
export function esLinkMaps(v) {
  return /^https?:\/\/(www\.)?(google\.[a-z.]+\/maps|maps\.google\.[a-z.]+|maps\.app\.goo\.gl|goo\.gl\/maps|waze\.com)/i.test(String(v || ''))
}
/** wa.me: solo dígitos; celular peruano de 9 dígitos (9xxxxxxxx) → +51. */
export function linkWhatsApp(tel) {
  let d = String(tel || '').replace(/\D/g, '')
  if (!d || /^0+$/.test(d)) return ''
  if (d.length === 9 && d.startsWith('9')) d = '51' + d
  return d.length >= 9 ? `https://wa.me/${d}` : ''
}
export function telefonoDe(c) {
  const t = c?.telefono || (c?.numero && c.numero !== '0' ? c.numero : '')
  return t || ''
}

// ─── Markup (se inyecta una sola vez en el <body>) ──────────────────────────
function _asegurarModal() {
  if ($('modal-contacto')) return
  const m = document.createElement('div')
  m.id = 'modal-contacto'
  m.className = 'modal'
  m.innerHTML = `
  <div class="modal-content" style="width:min(94vw, 780px); max-width:min(94vw, 780px); max-height:calc(100vh - 48px); overflow-y:auto;">
    <div class="modal-header">
      <h3 class="modal-title" id="ctTitulo">Nuevo contacto</h3>
      <button class="modal-close" onclick="window.closeModal('modal-contacto')">&times;</button>
    </div>
    <form id="ctForm" onsubmit="return false" style="padding:4px 20px 8px;">
      <div id="ctInfo" style="display:none; padding:12px 14px; background:var(--bg-secondary); border-radius:var(--radius-md); border-left:3px solid var(--color-info); font-size:0.88rem; line-height:1.6; margin-top:10px;"></div>

      <strong style="${SEC}">Rol del contacto</strong>
      <div class="reporte-chips" id="ctRoles" style="display:flex; gap:8px; flex-wrap:wrap;">
        ${ROLES_CONTACTO.map(r => `<button type="button" class="reporte-chip" data-rol="${r.key}" onclick="window._ctToggleRol('${r.key}')">${r.icono} ${r.label}</button>`).join('')}
      </div>
      <small style="display:block; margin-top:6px; color:var(--text-secondary); font-size:0.78rem;">Puedes marcar varios: un mismo RUC puede ser cliente y proveedor a la vez.</small>

      <strong style="${SEC}">Identificación</strong>
      <div class="ct-grid" style="display:grid; grid-template-columns:1fr 2fr; gap:12px;">
        <div class="form-group" style="margin:0;">
          <label>Tipo documento *</label>
          <select id="ctTipoDoc">
            <option value="RUC">RUC</option><option value="DNI">DNI</option><option value="CE">Carné ext.</option>
            <option value="pasaporte">Pasaporte</option><option value="VAT">VAT (extranjero)</option><option value="otro">Otro</option>
          </select>
        </div>
        <div class="form-group" style="margin:0;">
          <label>N° documento *</label>
          <div style="display:flex; gap:6px;">
            <input type="text" id="ctNroDoc" placeholder="11 dígitos" style="flex:1;" oninput="window._ctOnDoc()">
            <button type="button" class="btn btn-secondary btn-small" id="ctBtnConsultar">🔍 Consultar</button>
          </div>
          <small id="ctDocAviso" style="display:none; color:var(--color-warning);"></small>
        </div>
      </div>
      <div class="form-group" style="margin:12px 0 0;">
        <label>Nombre / Razón social *</label>
        <input type="text" id="ctNombre" placeholder="Se completa con Consultar (RUC/DNI)">
      </div>
      <div id="ctSunat" class="sunat-datos-box" style="display:none; margin-top:12px;">
        <div class="sunat-datos-title">📋 Datos SUNAT</div>
        <div class="sunat-datos-grid">
          <div class="sunat-dato"><span class="sunat-dato-label">Estado</span><span class="sunat-dato-valor badge badge-secondary" id="ctEstadoSunat">—</span></div>
          <div class="sunat-dato"><span class="sunat-dato-label">Condición</span><span class="sunat-dato-valor badge badge-secondary" id="ctCondicionSunat">—</span></div>
          <div class="sunat-dato"><span class="sunat-dato-label">Buen contribuyente</span><span class="sunat-dato-valor badge badge-secondary" id="ctBuenContribSunat">—</span></div>
          <div class="sunat-dato"><span class="sunat-dato-label">Agente retención</span><span class="sunat-dato-valor badge badge-secondary" id="ctAgenteRetSunat">—</span></div>
        </div>
      </div>

      <strong style="${SEC}">Contacto</strong>
      <div class="ct-grid" style="display:grid; grid-template-columns:1fr 1fr; gap:12px;">
        <div class="form-group" style="margin:0;">
          <label>Teléfono / WhatsApp</label>
          <input type="text" id="ctTelefono" placeholder="987 654 321">
        </div>
        <div class="form-group" style="margin:0;">
          <label>Email</label>
          <input type="email" id="ctEmail" placeholder="correo@empresa.com">
        </div>
      </div>

      <strong style="${SEC}">Dirección y ubicación</strong>
      <div class="form-group" style="margin:0;">
        <label>Dirección</label>
        <input type="text" id="ctDireccion" placeholder="Av. / Jr. / Calle, número">
      </div>
      <div class="ct-grid" style="display:grid; grid-template-columns:1fr 1fr; gap:12px; margin-top:12px;">
        <div class="form-group" style="margin:0;"><label>Distrito</label><input type="text" id="ctDistrito"></div>
        <div class="form-group" style="margin:0;"><label>País</label><input type="text" id="ctPais" value="Perú"></div>
      </div>
      <div class="form-group" style="margin:12px 0 0;">
        <label>📍 Ubicación en Google Maps</label>
        <div style="display:flex; gap:6px; flex-wrap:wrap;">
          <input type="text" id="ctMaps" placeholder="Pega el enlace de Maps o coordenadas (-12.0464, -77.0428)" style="flex:1; min-width:220px;" oninput="window._ctOnMaps()">
          <button type="button" class="btn btn-secondary btn-small" onclick="window._ctBuscarMaps()" title="Abre Google Maps con la dirección para copiar el enlace (Compartir → Copiar vínculo)">🔎 Buscar en Maps</button>
          <button type="button" class="btn btn-secondary btn-small" id="ctBtnProbarMaps" onclick="window._ctProbarMaps()" disabled title="Abrir el enlace pegado">↗ Probar</button>
        </div>
        <small id="ctMapsAviso" style="display:block; margin-top:4px; color:var(--text-secondary); font-size:0.78rem;"></small>
      </div>

      <strong style="${SEC}">Condiciones</strong>
      <div style="display:flex; gap:22px; flex-wrap:wrap; margin-bottom:6px;">
        <label style="display:flex; align-items:center; gap:8px; cursor:pointer;"><input type="checkbox" id="ctRetencion" style="width:auto; flex:none; margin:0;"> Sujeto a retención IGV (agente de retención SUNAT)</label>
        <label style="display:flex; align-items:center; gap:8px; cursor:pointer;"><input type="checkbox" id="ctActivo" checked style="width:auto; flex:none; margin:0;"> Activo</label>
      </div>
    </form>
    <div class="modal-footer">
      <button class="btn" onclick="window.closeModal('modal-contacto')">Cancelar</button>
      <button class="btn btn-primary" id="ctBtnGuardar" onclick="window._ctGuardar()">💾 Guardar contacto</button>
    </div>
  </div>`
  document.body.appendChild(m)

  attachConsultaDocumento({
    btnId: 'ctBtnConsultar', tipoDocId: 'ctTipoDoc', numeroId: 'ctNroDoc',
    nombreId: 'ctNombre', direccionId: 'ctDireccion', distritoId: 'ctDistrito', paisId: 'ctPais',
    sunatSectionId: 'ctSunat', estadoId: 'ctEstadoSunat', condicionId: 'ctCondicionSunat',
    buenContribuyenteId: 'ctBuenContribSunat', agenteRetencionId: 'ctRetencion',
    agenteRetencionBadgeId: 'ctAgenteRetSunat'
  })
  $('ctTipoDoc').addEventListener('change', () => {
    const t = $('ctTipoDoc').value
    $('ctNroDoc').placeholder = t === 'RUC' ? '11 dígitos' : (t === 'DNI' ? '8 dígitos' : 'N° de documento')
    window._ctOnDoc()
  })
}

function _pintarRoles() {
  document.querySelectorAll('#ctRoles [data-rol]').forEach(b => b.classList.toggle('on', _rolesSel.has(b.dataset.rol)))
}
window._ctToggleRol = (rol) => {
  _rolesSel.has(rol) ? _rolesSel.delete(rol) : _rolesSel.add(rol)
  _pintarRoles()
}

/** Aviso en vivo: largo del documento + duplicado (otro contacto con el mismo N°). */
window._ctOnDoc = async () => {
  const t = $('ctTipoDoc')?.value, n = ($('ctNroDoc')?.value || '').trim()
  const av = $('ctDocAviso'); if (!av) return
  let msg = ''
  if (n && t === 'RUC' && !/^\d{11}$/.test(n)) msg = 'El RUC debe tener 11 dígitos'
  else if (n && t === 'DNI' && !/^\d{8}$/.test(n)) msg = 'El DNI debe tener 8 dígitos'
  else if (n) {
    const dup = ((await getContacts().catch(() => [])) || []).find(c => String(c.nro_documento) === n && c.id !== _editId)
    if (dup) msg = `Ya existe: ${dup.nombre} (${tiposDeContacto(dup).join(', ') || 'sin rol'}). Al guardar te propongo agregarle el rol.`
  }
  av.textContent = msg; av.style.display = msg ? '' : 'none'
}

window._ctOnMaps = () => {
  const v = normalizarLinkMaps($('ctMaps')?.value)
  const av = $('ctMapsAviso'), btn = $('ctBtnProbarMaps')
  if (btn) btn.disabled = !/^https?:\/\//i.test(v)
  if (!av) return
  if (!v) { av.textContent = 'En Maps: busca el lugar → Compartir → Copiar vínculo, y pégalo aquí.'; av.style.color = 'var(--text-secondary)'; return }
  if (esLinkMaps(v)) { av.textContent = '✓ Enlace de Maps válido'; av.style.color = 'var(--color-success)' }
  else { av.textContent = '⚠ No parece un enlace de Google Maps (se guardará si confirmas)'; av.style.color = 'var(--color-warning)' }
}
window._ctBuscarMaps = () => {
  const q = [$('ctDireccion')?.value, $('ctDistrito')?.value, $('ctPais')?.value].map(s => (s || '').trim()).filter(Boolean).join(', ')
  if (!q) { showToast('Escribe primero la dirección o el distrito', 'warning'); return }
  window.open(`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`, '_blank', 'noopener')
}
window._ctProbarMaps = () => {
  const v = normalizarLinkMaps($('ctMaps')?.value)
  if (/^https?:\/\//i.test(v)) window.open(v, '_blank', 'noopener')
}

function _sunatVal(id) {
  const t = $(id)?.textContent
  return !t || t === '—' ? null : t
}
function _sunatBool(id) {
  const v = $(id)?.dataset.value
  return v === 'true' ? true : (v === 'false' ? false : null)
}
function _pintarSunat(c = {}) {
  pintarBadgeSunat($('ctEstadoSunat'), c.estado || '—', c.estado === 'ACTIVO' ? 'success' : (c.estado ? 'danger' : 'secondary'))
  pintarBadgeSunat($('ctCondicionSunat'), c.condicion || '—', c.condicion === 'HABIDO' ? 'success' : (c.condicion ? 'danger' : 'secondary'))
  const bc = $('ctBuenContribSunat'), ar = $('ctAgenteRetSunat')
  const b = c.es_buen_contribuyente, a = c.es_agente_retencion_sunat
  pintarBadgeSunat(bc, b === true ? 'Sí' : (b === false ? 'No' : '—'), b === true ? 'success' : 'secondary')
  bc.dataset.value = b === true || b === false ? String(b) : ''
  pintarBadgeSunat(ar, a === true ? 'Sí' : (a === false ? 'No' : '—'), a === true ? 'success' : 'secondary')
  ar.dataset.value = a === true || a === false ? String(a) : ''
}

// ─── Abrir ──────────────────────────────────────────────────────────────────
export async function abrirModalContacto({ id = null, roles = [] } = {}) {
  _asegurarModal()
  document.body.appendChild($('modal-contacto'))   // siempre encima de otros modales abiertos (PK, Nueva Venta…)
  $('ctForm').reset()
  _editId = null; _rolesExtra = []
  let c = null
  if (id) {
    c = await getContactById(Number(id))
    if (!c) { showToast('Contacto no encontrado', 'warning'); return }
    _editId = c.id
  }
  const rolesC = c ? tiposDeContacto(c) : roles
  _rolesSel = new Set(rolesC.filter(r => ROLES_CONTACTO.some(x => x.key === r)))
  _rolesExtra = rolesC.filter(r => !ROLES_CONTACTO.some(x => x.key === r))
  _pintarRoles()

  $('ctTitulo').textContent = c ? 'Editar contacto' : 'Nuevo contacto'
  const info = $('ctInfo')
  if (c) {
    info.style.display = ''
    info.innerHTML = `<div style="font-size:0.72rem; text-transform:uppercase; letter-spacing:.4px; color:var(--text-secondary);">Contacto #${c.id}</div>
      <div style="font-weight:600; font-size:1.05rem; margin-top:2px;">${_esc(c.nombre)}</div>
      <div style="font-size:0.85rem; color:var(--text-secondary); margin-top:2px;">${_esc(c.tipo_documento || '')} ${_esc(c.nro_documento || '')}</div>`
  } else { info.style.display = 'none'; info.innerHTML = '' }

  $('ctTipoDoc').value = c?.tipo_documento || 'RUC'
  $('ctNroDoc').value = c?.nro_documento || ''
  $('ctNombre').value = c?.nombre || ''
  $('ctTelefono').value = telefonoDe(c)
  $('ctEmail').value = c?.email || ''
  $('ctDireccion').value = c?.direccion || ''
  $('ctDistrito').value = c?.distrito || ''
  $('ctPais').value = c?.pais || 'Perú'
  $('ctMaps').value = c?.ubicacion_maps || ''
  $('ctRetencion').checked = !!c?.sujeto_retencion
  $('ctActivo').checked = c ? c.activo !== false : true
  _pintarSunat(c || {})
  $('ctTipoDoc').dispatchEvent(new Event('change'))   // visibilidad bloque SUNAT + placeholder
  window._ctOnMaps()
  window.openModal('modal-contacto')
  setTimeout(() => (c ? $('ctNombre') : $('ctNroDoc'))?.focus(), 60)
}

// ─── Guardar ────────────────────────────────────────────────────────────────
window._ctGuardar = async () => {
  const btn = $('ctBtnGuardar')
  if (btn?.disabled) return
  const tipo = $('ctTipoDoc').value
  const nro = ($('ctNroDoc').value || '').trim()
  const nombre = ($('ctNombre').value || '').trim()
  const tel = ($('ctTelefono').value || '').trim()
  const maps = normalizarLinkMaps($('ctMaps').value)

  if (!_rolesSel.size) { showToast('Elige al menos un rol: Cliente, Proveedor o Vendedor', 'warning'); return }
  if (!nro) { showToast('Ingresa el N° de documento', 'warning'); $('ctNroDoc').focus(); return }
  if (tipo === 'RUC' && !/^\d{11}$/.test(nro)) { showToast('El RUC debe tener 11 dígitos', 'warning'); return }
  if (tipo === 'DNI' && !/^\d{8}$/.test(nro)) { showToast('El DNI debe tener 8 dígitos', 'warning'); return }
  if (!nombre) { showToast('Ingresa el nombre o razón social', 'warning'); $('ctNombre').focus(); return }
  if (maps && !/^https?:\/\//i.test(maps)) { showToast('La ubicación debe ser un enlace (https://…) o coordenadas', 'warning'); return }
  if (maps && !esLinkMaps(maps) && !confirm('El enlace no parece de Google Maps. ¿Guardarlo igual?')) return

  const roles = [...ROLES_CONTACTO.map(r => r.key).filter(k => _rolesSel.has(k)), ..._rolesExtra]
  const todos = (await getContacts().catch(() => [])) || []

  if (!_editId) {
    // Mismo N° de documento ya registrado → sumar los roles al existente (nro_documento es UNIQUE)
    const dup = todos.find(c => String(c.nro_documento) === nro)
    if (dup) {
      const actuales = tiposDeContacto(dup)
      const nuevos = roles.filter(r => !actuales.includes(r))
      if (!nuevos.length) { showToast(`${dup.nombre} ya está registrado con esos roles`, 'info'); window.closeModal('modal-contacto'); _emitir(dup, false); return }
      if (!confirm(`El documento ${nro} ya existe: ${dup.nombre} (${actuales.join(', ') || 'sin rol'}).\n\n¿Agregarle el rol ${nuevos.join(', ')}?`)) return
      const r = await updateContact(dup.id, { tipo_contacto: [...actuales, ...nuevos] })
      if (!r) { showToast('No se pudo actualizar el contacto existente', 'danger'); return }
      showToast(`Rol agregado a ${dup.nombre}`, 'success')
      window.closeModal('modal-contacto')
      _emitir({ ...dup, tipo_contacto: [...actuales, ...nuevos] }, true)
      return
    }
  } else {
    const anterior = todos.find(c => c.id === _editId)
    const quitados = tiposDeContacto(anterior).filter(r => !roles.includes(r))
    if (quitados.length && !confirm(`Vas a quitar el rol ${quitados.join(', ')}: dejará de aparecer en esa lista (sus documentos no se tocan). ¿Continuar?`)) return
  }

  const datos = {
    nombre, tipo_documento: tipo, nro_documento: nro,
    email: ($('ctEmail').value || '').trim() || null,
    telefono: tel || null,
    numero: tel || '0',
    direccion: ($('ctDireccion').value || '').trim(),
    distrito: ($('ctDistrito').value || '').trim(),
    pais: ($('ctPais').value || '').trim() || 'Perú',
    ubicacion_maps: maps || null,
    sujeto_retencion: !!$('ctRetencion').checked,
    activo: !!$('ctActivo').checked,
    tipo_contacto: roles,
    estado: _sunatVal('ctEstadoSunat'),
    condicion: _sunatVal('ctCondicionSunat'),
    es_buen_contribuyente: _sunatBool('ctBuenContribSunat'),
    es_agente_retencion_sunat: _sunatBool('ctAgenteRetSunat')
  }

  if (btn) { btn.disabled = true; btn.textContent = 'Guardando...' }
  try {
    const eraNuevo = !_editId
    const r = eraNuevo ? await addContact(datos) : await updateContact(_editId, datos)
    if (!r) { showToast('No se pudo guardar. ¿Corriste el SQL 76 (ubicacion_maps)? Revisa la consola.', 'danger', 7000); return }
    const fila = (typeof r === 'object' && r.id) ? r : { ...datos, id: _editId }
    showToast(eraNuevo ? 'Contacto creado' : 'Contacto actualizado', 'success')
    window.closeModal('modal-contacto')
    _emitir(fila, eraNuevo)
  } catch (e) {
    console.error('_ctGuardar:', e)
    showToast('Error al guardar: ' + e.message, 'danger')
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '💾 Guardar contacto' }
  }
}

function _emitir(contacto, nuevo) {
  window.dispatchEvent(new CustomEvent('contacto-guardado', { detail: { contacto, nuevo } }))
  if (nuevo && tiposDeContacto(contacto).includes('cliente')) window.dispatchEvent(new CustomEvent('cliente-creado', { detail: contacto }))
}

window.abrirModalContacto = abrirModalContacto
