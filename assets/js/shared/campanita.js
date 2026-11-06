// ============================================================================
// shared/campanita.js — 🔔 Campanita de avisos (2026-11-05)
// ============================================================================
// Un solo lugar para los avisos del sistema. Dos fuentes:
//   1. GUARDADOS (tabla notificaciones, SQL 136): "se generó una cotización por
//      debajo del PV de lista", etc. Se marcan leídos al abrirlos.
//   2. CALCULADOS (RPC avisos_por_despachar): PK ya facturados cuyo día de emisión
//      pasó y siguen sin guía. No se "leen": desaparecen solos al emitir la guía.
// Cada aviso es un ENLACE al módulo con el buscador ya filtrado por el cliente
// (?tab=…&q=…; lo aplica main.js). Si el SQL 136 no está, no muestra nada.
// API para otros módulos: crearAviso(), resolverAviso().
// ============================================================================
import { supabase, empresasActivasCtx, empresaTrabajoCtx } from '../supabase-client.js'
import { getCurrentUser } from '../auth-supabase.js'

const _esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
let _btn = null, _panel = null, _guardados = [], _calculados = [], _timer = null

function _cargarCss() {
  if (document.getElementById('css-campanita')) return
  const l = document.createElement('link')
  l.id = 'css-campanita'; l.rel = 'stylesheet'
  l.href = new URL('../../css/campanita.css', import.meta.url).href
  document.head.appendChild(l)
}

/** Enlace al módulo con el buscador prefiltrado por cliente. */
export function urlConBusqueda(pagina, tab, q) {
  return `${pagina}?tab=${encodeURIComponent(tab)}${q ? '&q=' + encodeURIComponent(q) : ''}`
}

/** Crea (o refresca) un aviso abierto por documento y tipo. Nunca rompe el flujo que lo llama. */
export async function crearAviso({ tipo, titulo, detalle = null, url = null, ref_tabla = null, ref_id = null, severidad = 'aviso', empresa_id = null }) {
  try {
    const user = await getCurrentUser()
    const fila = { tipo, titulo, detalle, url, ref_tabla, ref_id: ref_id != null ? String(ref_id) : null, severidad,
      empresa_id: empresa_id ?? empresaTrabajoCtx(), created_by: user?.db_id || null }
    if (fila.ref_id) {
      const { data } = await supabase.from('notificaciones').select('id').eq('tipo', tipo).eq('ref_tabla', ref_tabla).eq('ref_id', fila.ref_id).is('leida_at', null).limit(1)
      if (data?.[0]) { await supabase.from('notificaciones').update({ titulo, detalle, url, severidad }).eq('id', data[0].id); _refrescarLuego(); return }
    }
    const { error } = await supabase.from('notificaciones').insert(fila)
    if (error) console.warn('crearAviso:', error.message)
    _refrescarLuego()
  } catch (e) { console.warn('crearAviso:', e.message) }
}

/** Marca como resuelto (leído) el aviso abierto de ese documento: ya no aplica. */
export async function resolverAviso(tipo, ref_tabla, ref_id) {
  try {
    await supabase.from('notificaciones').update({ leida_at: new Date().toISOString() })
      .eq('tipo', tipo).eq('ref_tabla', ref_tabla).eq('ref_id', String(ref_id)).is('leida_at', null)
    _refrescarLuego()
  } catch (e) { console.warn('resolverAviso:', e.message) }
}

const _refrescarLuego = () => { clearTimeout(_timer); _timer = setTimeout(_cargar, 400) }

async function _cargar() {
  try {
    const emps = (empresasActivasCtx() || []).map(Number).filter(Boolean)
    const [g, c] = await Promise.all([
      supabase.from('notificaciones').select('*').is('leida_at', null).order('created_at', { ascending: false }).limit(40),
      emps.length ? supabase.rpc('avisos_por_despachar', { p_empresas: emps }) : Promise.resolve({ data: [] })
    ])
    _guardados = g.error ? [] : (g.data || [])
    _calculados = c.error ? [] : (c.data || [])
    if (g.error && c.error) { _btn?.setAttribute('hidden', ''); return }   // SQL 136 sin correr: silencioso
    _btn?.removeAttribute('hidden')
    _pintar()
  } catch (e) { console.warn('campanita:', e.message) }
}

function _hace(iso) {
  const m = Math.round((Date.now() - new Date(iso)) / 60000)
  if (m < 1) return 'ahora'; if (m < 60) return `hace ${m} min`
  const h = Math.round(m / 60); if (h < 24) return `hace ${h} h`
  return `hace ${Math.round(h / 24)} d`
}

function _pintar() {
  if (!_btn) return
  const n = _guardados.length + _calculados.length
  const b = _btn.querySelector('.campanita-badge')
  b.textContent = n > 99 ? '99+' : n; b.hidden = !n
  _btn.classList.toggle('con-avisos', n > 0)
  if (!_panel) return
  const g = _guardados.map(a => `<a class="camp-item ${a.severidad}" href="${_esc(a.url || '#')}" data-nid="${a.id}">
      <span class="camp-ico">${a.severidad === 'alerta' ? '🚨' : a.severidad === 'info' ? 'ℹ️' : '⚠️'}</span>
      <span class="camp-txt"><b>${_esc(a.titulo)}</b>${a.detalle ? `<small>${_esc(a.detalle)}</small>` : ''}<em>${_hace(a.created_at)}</em></span></a>`).join('')
  const c = _calculados.map(a => {
    const q = a.cliente || ''
    const tab = 'ventas'
    const msg = a.estado_despacho === 'guia_parcial' ? 'tiene guía parcial: falta despachar el resto' : 'sigue sin guía de despacho'
    const dias = a.dias > 0 ? `${a.dias} día${a.dias === 1 ? '' : 's'}` : 'hoy'
    return `<a class="camp-item recordatorio" href="${_esc(urlConBusqueda('ventas.html', tab, q))}">
      <span class="camp-ico">📦</span>
      <span class="camp-txt"><b>${_esc(a.cot_numero || a.numero)} · ${_esc(q || 'Cliente')}</b>
      <small>${_esc(a.ultima_factura || '')} ${msg} (${a.termino_despacho === 'recoge_cliente' ? 'recoge el cliente' : 'despacho'})</small><em>desde hace ${dias}</em></span></a>`
  }).join('')
  _panel.querySelector('.camp-lista').innerHTML = (g || c)
    ? `${g ? `<div class="camp-grupo">Avisos</div>${g}` : ''}${c ? `<div class="camp-grupo">Recordatorios amigables · por despachar</div>${c}` : ''}`
    : '<div class="camp-vacio">Todo en orden por ahora 🎉</div>'
  _panel.querySelector('.camp-leer').hidden = !_guardados.length
}

async function _marcarLeida(id) {
  try { await supabase.from('notificaciones').update({ leida_at: new Date().toISOString() }).eq('id', id) } catch (_) { /* best-effort */ }
}

export function initCampanita() {
  const hc = document.querySelector('.header-controls')
  if (!hc || document.getElementById('btnCampanita')) return
  _cargarCss()
  _btn = document.createElement('button')
  _btn.id = 'btnCampanita'; _btn.type = 'button'; _btn.className = 'campanita-btn'; _btn.hidden = true
  _btn.title = 'Avisos y recordatorios'
  _btn.innerHTML = '<span class="campanita-ico">🔔</span><span class="campanita-badge" hidden>0</span>'
  hc.insertBefore(_btn, hc.firstChild)

  _panel = document.createElement('div')
  _panel.className = 'camp-panel'; _panel.hidden = true
  _panel.innerHTML = `<div class="camp-cab"><strong>🔔 Avisos</strong>
      <button type="button" class="camp-leer" hidden>Marcar leídos</button></div><div class="camp-lista"></div>`
  document.body.appendChild(_panel)

  const cerrar = () => { _panel.hidden = true }
  _btn.addEventListener('click', e => {
    e.stopPropagation()
    if (!_panel.hidden) { cerrar(); return }
    const r = _btn.getBoundingClientRect()
    _panel.style.top = (r.bottom + 8) + 'px'
    _panel.style.right = Math.max(8, window.innerWidth - r.right) + 'px'
    _panel.hidden = false; _cargar()
  })
  document.addEventListener('click', e => { if (!_panel.contains(e.target)) cerrar() })
  document.addEventListener('keydown', e => { if (e.key === 'Escape') cerrar() })
  _panel.querySelector('.camp-leer').addEventListener('click', async () => {
    await Promise.all(_guardados.map(a => _marcarLeida(a.id))); _guardados = []; _pintar()
  })
  _panel.addEventListener('click', e => {
    const a = e.target.closest('a[data-nid]')
    if (a) _marcarLeida(a.dataset.nid)       // se marca leída y el enlace navega normalmente
  })

  _cargar()
  setInterval(_cargar, 3 * 60 * 1000)
  window.addEventListener('focus', _cargar)
  window.addEventListener('aviso-nuevo', _refrescarLuego)
}
