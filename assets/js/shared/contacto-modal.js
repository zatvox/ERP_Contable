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
import { getContacts, getContactById, addContact, updateContact, tiposDeContacto, errorDocumentoContacto } from '../supabase-data.js'
import { attachConsultaDocumento, pintarBadgeSunat } from '../sunat-api.js'
import { showToast } from '../helpers.js'
import { ultimoErrorInsert, ultimoErrorUpdate } from '../supabase-client.js'
import { catalogoDetraccion, tasaDe } from './detraccion.js'

/** Sección Detracción del perfil: llena el selector con el catálogo SUNAT y carga los valores del contacto. */
async function _poblarDetraccion(c) {
  const sel = $('ctDetrCodigo'); if (!sel) return
  const cat = await catalogoDetraccion()
  sel.innerHTML = '<option value="">— Sin definir —</option>' + cat.map(t => `<option value="${t.codigo}">${t.codigo} · ${t.descripcion} (${Number(t.porcentaje)} %)</option>`).join('')
  sel.value = c?.detraccion_codigo || ''
  $('ctDetrPct').value = c?.detraccion_pct ?? ''
  $('ctDetrQuien').value = c?.detraccion_paga_habitual || ''
  $('ctDetrCuenta').value = c?.detraccion_cuenta_bn || ''
  sel.onchange = () => { const t = tasaDe(cat, sel.value); if (t) $('ctDetrPct').value = t.porcentaje }
}

export const ROLES_CONTACTO = [
  { key: 'cliente',   label: 'Cliente',   plural: 'Clientes',    icono: '🛒' },
  { key: 'proveedor', label: 'Proveedor', plural: 'Proveedores', icono: '📦' },
  { key: 'vendedor',  label: 'Vendedor',  plural: 'Vendedores',  icono: '🧑‍💼' },
  { key: 'empleado',  label: 'Empleado',  plural: 'Empleados',   icono: '👷' }
]

let _tiene4ta = false
let _tieneDetr = false
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
  <div class="modal-content ct-modal">
    <div class="modal-header">
      <h3 class="modal-title" id="ctTitulo">Nuevo contacto</h3>
      <button class="modal-close" onclick="window.closeModal('modal-contacto')">&times;</button>
    </div>
    <form id="ctForm" onsubmit="return false" class="ct-form">
      <div id="ctInfo"></div>
      <div class="ct-hero">
        <div class="ct-av" id="ctAv">?</div>
        <div class="ct-hero-info">
          <div class="ct-hero-nom" id="ctHNom">Nuevo contacto</div>
          <div class="ct-hero-sub" id="ctHSub">Completa la identificación para empezar</div>
          <div class="ct-hero-ins" id="ctHIns"></div>
        </div>
        <div class="ct-hero-acc" id="ctHAcc"></div>
      </div>

      <div class="dt-tabs ct-tabs" id="ctTabs">
        <button type="button" class="dt-tab ct-tab activa" data-ct="0"><span class="dt-ico">🪪</span>Identidad<span class="ct-dot" id="ctDot0"></span></button>
        <button type="button" class="dt-tab ct-tab" data-ct="1"><span class="dt-ico">📍</span>Contacto y ubicación<span class="ct-dot" id="ctDot1"></span></button>
        <button type="button" class="dt-tab ct-tab" data-ct="2"><span class="dt-ico">⚖️</span>Fiscal<span class="ct-dot" id="ctDot2"></span></button>
      </div>

      <!-- ── 1. Identidad ── -->
      <section class="ct-panel" data-ctp="0">
        <div class="ct-lbl">¿Qué es para ti? <small>puedes marcar varios</small></div>
        <div class="ct-roles" id="ctRoles">
          ${ROLES_CONTACTO.map(r => `<button type="button" class="ct-rol" data-rol="${r.key}" onclick="window._ctToggleRol('${r.key}')"><span class="ct-rol-ic">${r.icono}</span><span>${r.label}</span><i class="ct-rol-ck">✓</i></button>`).join('')}
        </div>

        <div class="ct-grid ct-g-doc">
          <div class="form-group">
            <label>Tipo documento *</label>
            <select id="ctTipoDoc">
              <option value="RUC">RUC</option><option value="DNI">DNI</option><option value="CE">Carné ext.</option>
              <option value="pasaporte">Pasaporte</option><option value="VAT">VAT (extranjero)</option>
            </select>
          </div>
          <div class="form-group">
            <label>N° documento *</label>
            <div class="ct-inline">
              <input type="text" id="ctNroDoc" placeholder="11 dígitos" oninput="window._ctOnDoc()" autocomplete="off">
              <button type="button" class="btn btn-secondary btn-small ct-consultar" id="ctBtnConsultar">🔍 Consultar SUNAT / RENIEC</button>
            </div>
            <small id="ctDocAviso" class="ct-aviso" style="display:none;"></small>
          </div>
        </div>
        <div class="form-group">
          <label>Nombre / Razón social *</label>
          <input type="text" id="ctNombre" placeholder="Se completa solo con Consultar (RUC/DNI)">
        </div>

        <div id="ctSunat" class="ct-sunat" style="display:none;">
          <div class="ct-sunat-t">🛡️ Verificado en SUNAT</div>
          <div class="ct-sunat-g">
            <div><span>Estado</span><b class="badge badge-secondary" id="ctEstadoSunat">—</b></div>
            <div><span>Condición</span><b class="badge badge-secondary" id="ctCondicionSunat">—</b></div>
            <div><span>Buen contribuyente</span><b class="badge badge-secondary" id="ctBuenContribSunat">—</b></div>
            <div><span>Agente retención</span><b class="badge badge-secondary" id="ctAgenteRetSunat">—</b></div>
          </div>
        </div>
      </section>

      <!-- ── 2. Contacto y ubicación ── -->
      <section class="ct-panel" data-ctp="1" hidden>
        <div class="ct-lbl">Cómo comunicarte</div>
        <div class="ct-grid">
          <div class="form-group"><label>📱 Teléfono / WhatsApp</label><input type="text" id="ctTelefono" placeholder="987 654 321"></div>
          <div class="form-group"><label>✉️ Email</label><input type="email" id="ctEmail" placeholder="correo@empresa.com"></div>
        </div>

        <div class="ct-lbl">Dónde está</div>
        <div class="form-group"><label>Dirección</label><input type="text" id="ctDireccion" placeholder="Av. / Jr. / Calle, número"></div>
        <div class="ct-grid">
          <div class="form-group"><label>Distrito</label><input type="text" id="ctDistrito"></div>
          <div class="form-group"><label>País</label><input type="text" id="ctPais" value="Perú"></div>
        </div>
        <div class="form-group">
          <label>📍 Ubicación en Google Maps</label>
          <div class="ct-inline">
            <input type="text" id="ctMaps" placeholder="Pega el enlace de Maps o coordenadas (-12.0464, -77.0428)" oninput="window._ctOnMaps()">
            <button type="button" class="btn btn-secondary btn-small" onclick="window._ctBuscarMaps()" title="Abre Google Maps con la dirección para copiar el enlace (Compartir → Copiar vínculo)">🔎 Buscar en Maps</button>
            <button type="button" class="btn btn-secondary btn-small" id="ctBtnProbarMaps" onclick="window._ctProbarMaps()" disabled title="Abrir el enlace pegado">↗ Probar</button>
          </div>
          <small id="ctMapsAviso" class="ct-aviso"></small>
        </div>
      </section>

      <!-- ── 3. Fiscal ── -->
      <section class="ct-panel" data-ctp="2" hidden>
        <div class="ct-sw-fila">
          <label class="ct-sw"><input type="checkbox" id="ctActivo" checked><span class="ct-sw-bar"></span><span class="ct-sw-tx"><b>Contacto activo</b><small>Si lo desactivas deja de salir en los buscadores</small></span></label>
          <label class="ct-sw" id="ctSwRet"><input type="checkbox" id="ctRetencion"><span class="ct-sw-bar"></span><span class="ct-sw-tx"><b>Agente de retención IGV</b><small>SUNAT lo designó agente: se le aplica retención</small></span></label>
        </div>

        <div class="ct-card" id="ctCard4ta" title="Renta de 4ta categoría: si presentó el Form. 1609 y SUNAT le aprobó suspensión, no se le retiene en Recibos por Honorarios ese año (vence el 31/12).">
          <div class="ct-card-t">🧑‍💼 Renta de 4ta categoría <small>Recibos por honorarios</small></div>
          <div class="ct-grid ct-g-4ta">
            <div class="form-group"><label>Suspensión — año vigente</label><input type="number" id="ct4taAnio" min="2020" max="2100" placeholder="Ej: 2026"></div>
            <div class="form-group"><label>Constancia / referencia (Form. 1609)</label><input type="text" id="ct4taRef" maxlength="60" placeholder="Opcional"></div>
          </div>
        </div>

        <div class="ct-card" id="ctDetrBox" title="Detracción (SPOT): se usa al registrar compras de servicios de este proveedor. El modal de compra la consulta y la completa; aquí también se puede editar.">
          <div class="ct-card-t">🧾 Detracción (SPOT) <small>aplica cuando es proveedor</small></div>
          <div class="ct-grid ct-g-detr">
            <div class="form-group"><label>Código habitual de su servicio</label><select id="ctDetrCodigo"><option value="">— Sin definir —</option></select></div>
            <div class="form-group"><label>%</label><input type="number" id="ctDetrPct" step="0.01" min="0" max="100"></div>
            <div class="form-group"><label>¿Quién deposita?</label><select id="ctDetrQuien"><option value="">— Sin definir —</option><option value="proveedor">El proveedor</option><option value="nosotros">Nosotros</option></select></div>
            <div class="form-group"><label>Cuenta de detracciones (Banco de la Nación)</label><input type="text" id="ctDetrCuenta" maxlength="40" placeholder="N° de cuenta"></div>
          </div>
        </div>
        <div id="ctFiscVacio" class="ct-vacio" style="display:none;">Para este tipo de documento no hay datos fiscales adicionales: la retención IGV y la detracción aplican a RUC, y la suspensión de 4ta a RUC 10 (persona natural con negocio).</div>
      </section>
    </form>
    <div class="modal-footer ct-foot">
      <div class="ct-nav">
        <button type="button" class="btn" id="ctPrev" onclick="window._ctNav(-1)">← Anterior</button>
        <button type="button" class="btn" id="ctNext" onclick="window._ctNav(1)">Siguiente →</button>
      </div>
      <div class="ct-foot-r">
        <button class="btn" onclick="window.closeModal('modal-contacto')">Cancelar</button>
        <button class="btn btn-primary" id="ctBtnGuardar" onclick="window._ctGuardar()">💾 Guardar contacto</button>
      </div>
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
  $('ctTabs').addEventListener('click', e => { const t = e.target.closest('[data-ct]'); if (t) window._ctIr(Number(t.dataset.ct)) })
  const _ref = () => window._ctRefrescar()
  $('ctForm').addEventListener('input', _ref)
  $('ctForm').addEventListener('change', _ref)
  new MutationObserver(_ref).observe($('ctSunat'), { subtree: true, childList: true, characterData: true, attributes: true })
  $('ctTipoDoc').addEventListener('change', () => {
    const t = $('ctTipoDoc').value
    $('ctNroDoc').placeholder = t === 'RUC' ? '11 dígitos' : (t === 'DNI' ? '8 dígitos' : 'N° de documento')
    window._ctOnDoc()
  })
}

function _pintarRoles() {
  document.querySelectorAll('#ctRoles [data-rol]').forEach(b => b.classList.toggle('on', _rolesSel.has(b.dataset.rol)))
  window._ctRefrescar && window._ctRefrescar()
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

// ─── Navegación por pestañas + cabecera viva ───────────────────────────────
let _ctTab = 0
window._ctIr = (i) => {
  _ctTab = Math.max(0, Math.min(2, i))
  document.querySelectorAll('#ctTabs .ct-tab').forEach((b, k) => b.classList.toggle('activa', k === _ctTab))
  document.querySelectorAll('#modal-contacto .ct-panel').forEach((p, k) => { p.hidden = k !== _ctTab })
  $('ctPrev').style.visibility = _ctTab === 0 ? 'hidden' : ''
  $('ctNext').style.visibility = _ctTab === 2 ? 'hidden' : ''
}
window._ctNav = (d) => window._ctIr(_ctTab + d)

const _COLORES = ['#6366f1', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#14b8a6']
window._ctRefrescar = () => {
  if (!$('ctAv')) return
  const nombre = ($('ctNombre').value || '').trim(), nro = ($('ctNroDoc').value || '').trim(), tipo = $('ctTipoDoc').value
  const ini = nombre.split(/\s+/).filter(w => /[A-Za-zÁÉÍÓÚÑ]/.test(w)).slice(0, 2).map(w => w[0]).join('').toUpperCase()
  const av = $('ctAv')
  av.textContent = ini || '＋'
  let h = 0; for (const ch of nombre) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  av.style.background = nombre ? `linear-gradient(135deg, ${_COLORES[h % 8]}, ${_COLORES[(h + 3) % 8]})` : ''
  $('ctHNom').textContent = nombre || (_editId ? 'Editar contacto' : 'Nuevo contacto')
  $('ctHSub').textContent = nro ? `${tipo || 'Doc'} ${nro}${_editId ? ' · #' + _editId : ''}` : 'Completa la identificación para empezar'

  const ins = []
  ROLES_CONTACTO.filter(r => _rolesSel.has(r.key)).forEach(r => ins.push(`<span class="ct-pill rol">${r.icono} ${r.label}</span>`))
  const est = _sunatVal('ctEstadoSunat'), con = _sunatVal('ctCondicionSunat')
  if (est) ins.push(`<span class="ct-pill ${est === 'ACTIVO' ? 'ok' : 'mal'}">SUNAT ${_esc(est)}</span>`)
  if (con) ins.push(`<span class="ct-pill ${con === 'HABIDO' ? 'ok' : 'mal'}">${_esc(con)}</span>`)
  if ($('ctRetencion').checked && tipo === 'RUC') ins.push('<span class="ct-pill warn">Agente retención</span>')
  if (!$('ctActivo').checked) ins.push('<span class="ct-pill mal">Inactivo</span>')
  $('ctHIns').innerHTML = ins.join('')

  const acc = []
  const wa = linkWhatsApp($('ctTelefono').value), mp = normalizarLinkMaps($('ctMaps').value), em = ($('ctEmail').value || '').trim()
  if (wa) acc.push(`<a href="${wa}" target="_blank" rel="noopener" title="WhatsApp">💬</a>`)
  if (em) acc.push(`<a href="mailto:${_esc(em)}" title="Enviar email">✉️</a>`)
  if (/^https?:\/\//i.test(mp)) acc.push(`<a href="${_esc(mp)}" target="_blank" rel="noopener" title="Abrir en Maps">📍</a>`)
  $('ctHAcc').innerHTML = acc.join('')

  // Campos fiscales según tipo de documento y rol
  const esRuc = tipo === 'RUC', esRuc10 = esRuc && nro.startsWith('10')
  const v4 = esRuc10, vRet = esRuc, vDetr = esRuc && _rolesSel.has('proveedor')
  $('ctCard4ta').style.display = v4 ? '' : 'none'
  $('ctSwRet').style.display = vRet ? '' : 'none'
  $('ctDetrBox').style.display = vDetr ? '' : 'none'
  $('ctFiscVacio').style.display = (v4 || vRet || vDetr) ? 'none' : ''
  window._ctVis = { v4, vRet, vDetr }

  // Estado de cada pestaña: ✓ completa · ⚠ falta lo obligatorio
  const ok0 = _rolesSel.size && nro && nombre
  const llenos1 = ['ctTelefono', 'ctEmail', 'ctDireccion', 'ctDistrito', 'ctMaps'].filter(i => ($(i).value || '').trim()).length
  const fisc = [vRet && $('ctRetencion').checked, v4 && $('ct4taAnio').value, vDetr && $('ctDetrCodigo').value].filter(Boolean).length
  const dot = (i, cls, tx) => { const d = $('ctDot' + i); d.className = 'ct-dot ' + cls; d.textContent = tx }
  dot(0, ok0 ? 'ok' : 'warn', ok0 ? '✓' : '!')
  dot(1, llenos1 ? 'ok' : '', llenos1 ? llenos1 + '/5' : '')
  dot(2, fisc ? 'ok' : '', fisc ? String(fisc) : '')
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

  // Contacto antiguo con tipo "otro": queda en blanco para obligar a elegir uno válido
  $('ctTipoDoc').value = (c?.tipo_documento && String(c.tipo_documento).toLowerCase() !== 'otro') ? c.tipo_documento : (c ? '' : 'RUC')
  $('ctNroDoc').value = c?.nro_documento || ''
  $('ctNombre').value = c?.nombre || ''
  $('ctTelefono').value = telefonoDe(c)
  $('ctEmail').value = c?.email || ''
  $('ctDireccion').value = c?.direccion || ''
  $('ctDistrito').value = c?.distrito || ''
  $('ctPais').value = c?.pais || 'Perú'
  $('ctMaps').value = c?.ubicacion_maps || ''
  $('ctRetencion').checked = !!c?.sujeto_retencion
  $('ct4taAnio').value = c?.suspension_4ta_anio || ''; $('ct4taRef').value = c?.suspension_4ta_constancia || ''; _tiene4ta = !!c && 'suspension_4ta_anio' in c
  _tieneDetr = !!c && 'detraccion_codigo' in c
  _poblarDetraccion(c)
  $('ctActivo').checked = c ? c.activo !== false : true
  _pintarSunat(c || {})
  $('ctTipoDoc').dispatchEvent(new Event('change'))   // visibilidad bloque SUNAT + placeholder
  window._ctOnMaps()
  window._ctIr(0); window._ctRefrescar()
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

  if (!_rolesSel.size) { showToast('Elige al menos un rol: Cliente, Proveedor o Vendedor', 'warning'); window._ctIr(0); return }
  if (!tipo) { showToast('Elige el tipo de documento (el tipo "Otro" ya no existe)', 'warning'); window._ctIr(0); $('ctTipoDoc').focus(); return }
  if (!nro) { showToast('Ingresa el N° de documento', 'warning'); window._ctIr(0); $('ctNroDoc').focus(); return }
  const errDoc = errorDocumentoContacto(tipo, nro)
  if (errDoc) { showToast(errDoc, 'warning', 7000); window._ctIr(0); $('ctNroDoc').focus(); return }
  if (tipo === 'RUC' && !/^\d{11}$/.test(nro)) { showToast('El RUC debe tener 11 dígitos', 'warning'); return }
  if (tipo === 'DNI' && !/^\d{8}$/.test(nro)) { showToast('El DNI debe tener 8 dígitos', 'warning'); return }
  if (!nombre) { showToast('Ingresa el nombre o razón social', 'warning'); window._ctIr(0); $('ctNombre').focus(); return }
  if (maps && !/^https?:\/\//i.test(maps)) { showToast('La ubicación debe ser un enlace (https://…) o coordenadas', 'warning'); window._ctIr(1); return }
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
    sujeto_retencion: !!$('ctRetencion').checked && tipo === 'RUC',
    activo: !!$('ctActivo').checked,
    tipo_contacto: roles,
    estado: _sunatVal('ctEstadoSunat'),
    condicion: _sunatVal('ctCondicionSunat'),
    es_buen_contribuyente: _sunatBool('ctBuenContribSunat'),
    es_agente_retencion_sunat: _sunatBool('ctAgenteRetSunat'),
    // Renta 4ta (SQL 142): solo se envía si la columna existe o el usuario llenó el dato (así no rompe si falta el SQL)
    ...(((window._ctVis?.v4) && (_tiene4ta || $('ct4taAnio').value)) ? { suspension_4ta_anio: parseInt($('ct4taAnio').value) || null, suspension_4ta_constancia: ($('ct4taRef').value || '').trim() || null } : {}),
    // Detracción (SQL 157): solo si la columna existe o el usuario llenó algo (no rompe si falta el SQL)
    ...(((window._ctVis?.vDetr) && (_tieneDetr || $('ctDetrCodigo').value || $('ctDetrCuenta').value || $('ctDetrQuien').value)) ? { detraccion_codigo: $('ctDetrCodigo').value || null, detraccion_pct: parseFloat($('ctDetrPct').value) || null, detraccion_paga_habitual: $('ctDetrQuien').value || null, detraccion_cuenta_bn: ($('ctDetrCuenta').value || '').trim() || null } : {})
  }

  if (btn) { btn.disabled = true; btn.textContent = 'Guardando...' }
  try {
    const eraNuevo = !_editId
    const r = eraNuevo ? await addContact(datos) : await updateContact(_editId, datos)
    if (!r) { { const er = eraNuevo ? ultimoErrorInsert() : ultimoErrorUpdate(); showToast('No se pudo guardar: ' + (er?.mensaje || 'error desconocido (revisa la consola)'), 'danger', 8000) }; return }
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
