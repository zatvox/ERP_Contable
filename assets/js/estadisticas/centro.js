// ============================================================================
// estadisticas/centro.js — Pantalla "Estadísticas" del dashboard: elige Módulo → Reporte,
// captura sus datos (cosecha.js) y los entrega al motor (motor.js). Deep link: ?m=ventas&r=repv-clientes
// ============================================================================
import { MODULOS, reportesDe, buscarReporte } from './catalogo.js'
import { cosechar, precargar } from './cosecha.js'
import { montar } from './motor.js'

const host = document.getElementById('zv-stats')
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
let modulo = null, reporteId = null, desmontar = null, token = 0

function cabecera() {
  const reps = reportesDe(modulo)
  return `<div class="zc-nav">
    <div class="zc-mods">${MODULOS.map(m => `<button type="button" class="zc-mod ${m.id === modulo ? 'on' : ''}" data-m="${m.id}"><span>${m.ico}</span>${esc(m.nombre)}</button>`).join('')}</div>
    <div class="zc-reps">${reps.map(r => `<button type="button" class="zc-rep ${r.id === reporteId ? 'on' : ''}" data-r="${r.id}" title="${esc(r.pregunta)}">${esc(r.nombre)}</button>`).join('')}</div>
  </div><div id="zcCuerpo"></div>`
}

function ruta(m, r) { try { const u = new URL(location.href); u.searchParams.set('m', m); if (r) u.searchParams.set('r', r); history.replaceState(null, '', u) } catch (e) {} }

async function abrir(m, r) {
  const mi = ++token
  modulo = m; reporteId = r || reportesDe(m)[0]?.id || null
  if (desmontar) { try { desmontar() } catch (e) {} desmontar = null }
  host.innerHTML = cabecera(); ruta(modulo, reporteId)
  host.querySelectorAll('.zc-mod').forEach(b => b.addEventListener('click', () => { abrir(b.dataset.m) }))
  host.querySelectorAll('.zc-rep').forEach(b => b.addEventListener('click', () => { abrir(modulo, b.dataset.r) }))
  const cuerpo = host.querySelector('#zcCuerpo'), meta = buscarReporte(reporteId)
  if (!meta) { cuerpo.innerHTML = '<div class="zs-vacio">Este módulo no tiene reportes.</div>'; return }
  if (meta.custom) { cuerpo.innerHTML = `<div class="zs-vacio">«${esc(meta.nombre)}» es un reporte especial. <a href="${esc(meta.m)}.html">Ábrelo en el módulo →</a></div>`; return }
  cuerpo.innerHTML = `<div class="zc-load"><div class="zc-spin"></div><b id="zcEstado">Preparando…</b><small>Se cargan los datos reales del módulo, solo la primera vez.</small></div>`
  try {
    const cfg = await cosechar(modulo, reporteId, { onEstado: t => { if (mi === token) { const e = cuerpo.querySelector('#zcEstado'); if (e) e.textContent = t } } })
    if (mi !== token) return
    cuerpo.innerHTML = ''
    desmontar = montar(cuerpo, cfg, meta)
  } catch (err) {
    if (mi !== token) return
    cuerpo.innerHTML = `<div class="zs-vacio">⚠️ ${esc(err.message)}<br><button type="button" class="zs-btn" id="zcReint">Reintentar</button></div>`
    cuerpo.querySelector('#zcReint')?.addEventListener('click', () => abrir(modulo, reporteId))
  }
}

let iniciado = false
function iniciar() {
  if (iniciado) return; iniciado = true
  const q = new URLSearchParams(location.search)
  const m = MODULOS.some(x => x.id === q.get('m')) ? q.get('m') : MODULOS[1].id
  abrir(m, q.get('r'))
  MODULOS.forEach(x => { if (x.id !== m) setTimeout(() => precargar(x.id), 4000) })
}

// Mostrar/ocultar filtros globales del dashboard según la pestaña
function sincronizar() {
  const activa = document.querySelector('#dashTabs .tab-btn.active')?.dataset.tab
  const f = document.getElementById('dashFiltrosCard'); if (f) f.style.display = activa === 'estadisticas' ? 'none' : ''
  const t = document.querySelector('.page-title'); if (t && activa === 'estadisticas') t.textContent = 'Estadísticas'; else if (t) t.textContent = 'Dashboard'
  if (activa === 'estadisticas') iniciar()
}
document.querySelectorAll('#dashTabs .tab-btn').forEach(b => b.addEventListener('click', () => setTimeout(sincronizar, 0)))
window.addEventListener('load', () => {
  if (new URLSearchParams(location.search).get('m')) document.querySelector('#dashTabs .tab-btn[data-tab="estadisticas"]')?.click()
  sincronizar()
})
