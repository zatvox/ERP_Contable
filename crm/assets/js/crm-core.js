// ============================================================================
// CRM-CORE.JS — cliente Supabase, empresa activa, tema, carrito y cabecera
// El CRM es una VISTA de la BD del ERP: el visitante solo llama a funciones
// públicas (rpc) que devuelven columnas seguras; nunca toca tablas.
// ============================================================================
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.39.3/+esm'
import { SUPABASE_CONFIG } from '../../../assets/js/config.js'

export const supabase = createClient(SUPABASE_CONFIG.URL, SUPABASE_CONFIG.ANON_KEY)

// ---------- utilidades ----------
export const $ = (s, r = document) => r.querySelector(s)
export const $$ = (s, r = document) => [...r.querySelectorAll(s)]
export const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
export const num = (v, d = 2) => Number(v || 0).toLocaleString('es-PE', { minimumFractionDigits: d, maximumFractionDigits: d })
export const money = (v, moneda = 'PEN') => (moneda === 'USD' ? 'US$ ' : 'S/ ') + num(v)
export const fecha = v => v ? new Date(v).toLocaleDateString('es-PE', { day: '2-digit', month: '2-digit', year: 'numeric' }) : ''
export const fechaHora = v => v ? new Date(v).toLocaleString('es-PE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : ''
export const norm = s => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')

export function toast(msg, ms = 3200) {
  const t = document.createElement('div'); t.className = 'toast'; t.textContent = msg
  document.body.appendChild(t); setTimeout(() => t.remove(), ms)
}

export function fotoUrl(p) {
  if (!p) return ''
  return /^https?:/i.test(p) ? p : String(p).replace(/^\/?crm\//, '')
}
export const imagenes = fotos => (Array.isArray(fotos) ? fotos : []).map(fotoUrl).filter(Boolean)

// ---------- tema claro/oscuro ----------
export function initTema() {
  let t = null
  try { t = localStorage.getItem('crm_tema') } catch { /* sin storage */ }
  if (!t) t = matchMedia('(prefers-color-scheme: dark)').matches ? 'oscuro' : 'claro'
  document.documentElement.dataset.tema = t
}
export function alternarTema() {
  const t = document.documentElement.dataset.tema === 'oscuro' ? 'claro' : 'oscuro'
  document.documentElement.dataset.tema = t
  try { localStorage.setItem('crm_tema', t) } catch { /* ok */ }
}

// ---------- sesión / rol (solo staff) ----------
let _staff
export async function getStaff() {
  if (_staff !== undefined) return _staff
  _staff = null
  try {
    const { data: { session } } = await supabase.auth.getSession()
    if (!session) return null
    const { data } = await supabase.from('users').select('id, nombre, role, active').eq('auth_id', session.user.id).maybeSingle()
    if (data && data.active !== false) {
      _staff = { ...data, email: session.user.email,
        esStaff: ['admin', 'oficina', 'vendedor'].includes(data.role),
        esGestor: ['admin', 'oficina'].includes(data.role) }
    }
  } catch { /* anónimo */ }
  return _staff
}

// ---------- empresas (color, whatsapp, cuentas) ----------
let _empresas
export async function getEmpresas() {
  if (_empresas) return _empresas
  const { data, error } = await supabase.rpc('crm_empresas_publicas')
  if (error) console.error('[CRM] empresas:', error.message)
  _empresas = data || []
  // el personal ve todas las empresas, aunque aún no publiquen nada
  const st = await getStaff()
  if (st?.esStaff) {
    const { data: todas } = await supabase.from('empresa_config').select('id, codigo, nombre_comercial, color').order('id')
    const ids = new Set(_empresas.map(e => e.id))
    ;(todas || []).forEach(e => { if (!ids.has(e.id)) _empresas.push({ ...e, whatsapp: null, titulo: null, mensaje: null, mostrar_precios: true, igv_incluido: true, moneda_precio: 'PEN', cuentas_bancarias: [] }) })
    _empresas.sort((a, b) => a.id - b.id)
  }
  return _empresas
}
export function empresaActualId(empresas) {
  const q = new URLSearchParams(location.search).get('emp')
  let id = q ? Number(q) : null
  if (!id) { try { id = Number(localStorage.getItem('crm_emp')) || null } catch { /* ok */ } }
  if (!empresas.some(e => e.id === id)) id = empresas[0]?.id ?? null
  return id
}
export function setEmpresa(id) {
  try { localStorage.setItem('crm_emp', String(id)) } catch { /* ok */ }
  const u = new URL(location.href); u.searchParams.set('emp', id); location.href = u.toString()
}
export function pintarEmpresa(emp) {
  if (emp?.color) document.documentElement.style.setProperty('--emp', emp.color)
}

// ---------- catálogo ----------
let _cat = { t: 0, emp: null, data: [] }
export async function getCatalogo(empId, forzar = false) {
  if (!forzar && _cat.emp === empId && Date.now() - _cat.t < 15000) return _cat.data
  const { data, error } = await supabase.rpc('crm_catalogo', { p_empresa: empId })
  if (error) { console.error('[CRM] catálogo:', error.message); return _cat.data }
  _cat = { t: Date.now(), emp: empId, data: data || [] }
  return _cat.data
}
export const semLabel = s => ({ disponible: 'Disponible', poco: 'Poco stock', agotado: 'Agotado' }[s] || s)

// ---------- carrito (por empresa, en sessionStorage) ----------
const ckey = e => `crm_carrito_${e}`
export function carrito(empId) { try { return JSON.parse(sessionStorage.getItem(ckey(empId)) || '[]') } catch { return [] } }
export function guardarCarrito(empId, l) { try { sessionStorage.setItem(ckey(empId), JSON.stringify(l)) } catch { /* ok */ } }
export function agregar(empId, p, kg) {
  const c = carrito(empId); const i = c.findIndex(x => x.catalogo_id === p.id)
  const l = { catalogo_id: p.id, nombre: p.nombre, grupo: p.grupo, color: p.color_nombre || '', cantidad_kg: kg,
              peso_caja: p.peso_caja_kg || null, precio: p.precio || 0, foto: imagenes(p.fotos)[0] || '' }
  if (i >= 0) c[i] = l; else c.push(l)
  guardarCarrito(empId, c)
}

// ---------- totales (solo vista previa: el servidor recalcula con precios de la BD) ----------
export function totales(lineas, igvIncluido, pct = 18) {
  const s = lineas.reduce((a, l) => a + (l.cantidad_kg || 0) * (l.precio || 0), 0)
  return igvIncluido
    ? { subtotal: s / (1 + pct / 100), igv: s - s / (1 + pct / 100), total: s }
    : { subtotal: s, igv: s * pct / 100, total: s * (1 + pct / 100) }
}

// ---------- cabecera ----------
export async function cabecera(activa, empresas, emp) {
  const staff = await getStaff()
  const n = carrito(emp?.id).length
  const host = $('#top')
  host.className = 'top'
  host.innerHTML = `
    <div class="wrap top__in">
      <a class="marca" href="index.html${emp ? '?emp=' + emp.id : ''}">
        <img src="../assets/img/genko-geco.png" alt="Genko">
        <span>${esc(emp?.nombre_comercial || 'Genko')}<small>Catálogo · CRM</small></span>
      </a>
      ${empresas.length > 1 ? `<div class="emp-pills">${empresas.map(e =>
        `<button class="emp-pill" style="--c:${esc(e.color)}" aria-pressed="${e.id === emp?.id}" data-emp="${e.id}">${esc(e.codigo || e.nombre_comercial)}</button>`).join('')}</div>` : ''}
      <nav class="nav">
        <a href="index.html?emp=${emp?.id}" class="${activa === 'cat' ? 'on' : ''}">Catálogo</a>
        <a href="cotizar.html?emp=${emp?.id}" class="${activa === 'cot' ? 'on' : ''}">Mi cotización${n ? `<span class="badge-n">${n}</span>` : ''}</a>
        ${staff?.esStaff ? `<a href="panel.html?emp=${emp?.id}" class="${activa === 'panel' ? 'on' : ''}">Panel interno</a>` : ''}
        ${staff ? `<a href="../dashboard.html" title="Volver al ERP">ERP</a>` : ''}
        <button id="btn-tema" title="Cambiar tema" aria-label="Cambiar tema">◐</button>
      </nav>
    </div>`
  $('#btn-tema').onclick = alternarTema
  $$('.emp-pill').forEach(b => b.onclick = () => setEmpresa(b.dataset.emp))
  return staff
}

export function pie(emp) {
  const f = $('#pie'); if (!f) return
  f.className = 'pie'
  f.innerHTML = `<div class="wrap" style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap">
    <span>© ${new Date().getFullYear()} ${esc(emp?.nombre_comercial || '')}</span><span>Genko <small>by ZatVox</small></span></div>`
}

export function wspUrl(emp, texto) {
  const n = String(emp?.whatsapp || '').replace(/\D/g, '')
  return n ? `https://wa.me/${n}?text=${encodeURIComponent(texto || '')}` : null
}

// arranque común
export async function arrancar(activa) {
  initTema()
  const empresas = await getEmpresas()
  const id = empresaActualId(empresas)
  const emp = empresas.find(e => e.id === id) || null
  pintarEmpresa(emp)
  const staff = await cabecera(activa, empresas, emp)
  pie(emp)
  return { empresas, emp, staff }
}
