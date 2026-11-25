// ============================================================================
// shared/ayuda.js — Ayuda contextual (?) (2026-11-22)
// ============================================================================
// · Los textos viven en assets/js/ayuda/<pagina>.js (+ global.js); cada entrada se ancla a un elemento por selector CSS,
//   así que NO hay que tocar los HTML. Entradas nuevas = una línea en el catálogo.
// · Globito: al dejar el mouse 1.5 s sobre un elemento con ayuda aparece una burbuja corta; se cierra sola a los 7 s.
// · (?) visible solo en títulos de pestañas y filtros (q:true). Click en (?) = abre la burbuja al instante.
// · «Ver más» abre un panel a la DERECHA con la explicación completa y «¿Te sirvió?» (estadística en SQL 162).
// · Silencioso si falta el SQL 162: la ayuda funciona igual, solo no cuenta votos.
// ============================================================================
import { supabase } from '../supabase-client.js'

const PAGINA = (location.pathname.split('/').pop() || 'index').replace(/\.html$/, '')
const ESPERA_MS = 1500, VIDA_MS = 7000
let _entradas = [], _bub = null, _panel = null, _timer = null, _vida = null, _obs = null, _aplicarT = null

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
const md = s => esc(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`(.+?)`/g, '<code>$1</code>')

function _css() {
  if (document.getElementById('css-ayuda')) return
  const l = document.createElement('link'); l.id = 'css-ayuda'; l.rel = 'stylesheet'
  l.href = new URL('../../css/ayuda.css?v=2', import.meta.url).href; document.head.appendChild(l)
}

/** Helper de los catálogos: E(clave, selector, título, globito, [párrafos…], {txt, q, pv}) */
export const E = (k, sel, t, tip, ver = null, o = {}) => ({ k, sel, t, tip, ver, ...o })

async function _cargarCatalogos() {
  const base = new URL('../ayuda/', import.meta.url).href
  const lista = ['global', PAGINA]
  const res = await Promise.all(lista.map(n => import(base + n + '.js?v=2').then(m => m.default || []).catch(() => [])))
  _entradas = res.flat()
}

function _coincide(el, o) { return !o.txt || (el.textContent || '').replace(/\s+/g, ' ').toLowerCase().includes(o.txt.toLowerCase()) }

function _aplicar() {
  for (const e of _entradas) {
    let els = []
    try { els = [...document.querySelectorAll(e.sel)] } catch (_) { continue }
    for (const el of els) {
      if (el.dataset.ay || !_coincide(el, e) || el.closest('.ay-bub, .ay-panel')) continue
      el.dataset.ay = e.k
      if (e.q) {
        const q = document.createElement('i'); q.className = 'ay-q'; q.textContent = '?'; q.dataset.ayQ = e.k; q.title = ''
        const campo = /^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName)
        if (campo) {
          // El (?) va SIEMPRE junto al título del campo («Estado (?)»), nunca suelto debajo del control
          const lab = (el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`)) || el.closest('label')
            || el.parentElement?.querySelector(':scope > label') || el.closest('.form-group, .reporte-filtro, .filtro-grupo')?.querySelector('label')
          if (lab) lab.appendChild(q); else el.insertAdjacentElement('beforebegin', q)
        } else el.appendChild(q)
      }
    }
  }
}
const _aplicarLuego = () => { clearTimeout(_aplicarT); _aplicarT = setTimeout(_aplicar, 250) }

const _entrada = k => _entradas.find(e => e.k === k)

function _cerrarBub() { clearTimeout(_timer); clearTimeout(_vida); _bub?.remove(); _bub = null }

function _mostrarBub(el, e) {
  _cerrarBub()
  _bub = document.createElement('div'); _bub.className = 'ay-bub'; _bub.setAttribute('role', 'tooltip')
  _bub.innerHTML = `<div class="ay-bub-t">${md(e.tip)}</div>${e.pv ? '<div class="ay-pv">Por verificar</div>' : ''}${e.ver ? '<a href="#" class="ay-mas">Ver más ›</a>' : ''}`
  document.body.appendChild(_bub)
  const r = el.getBoundingClientRect(), b = _bub.getBoundingClientRect()
  let x = r.left + r.width / 2 - b.width / 2, y = r.bottom + 8
  if (y + b.height > innerHeight - 8) y = Math.max(8, r.top - b.height - 8)
  x = Math.min(Math.max(8, x), innerWidth - b.width - 8)
  _bub.style.left = x + 'px'; _bub.style.top = y + 'px'
  _bub.addEventListener('mouseenter', () => clearTimeout(_vida))
  _bub.addEventListener('mouseleave', () => { _vida = setTimeout(_cerrarBub, 1500) })
  _bub.querySelector('.ay-mas')?.addEventListener('click', ev => { ev.preventDefault(); _cerrarBub(); abrirPanel(e.k) })
  _vida = setTimeout(_cerrarBub, VIDA_MS)
  supabase.rpc('ayuda_registrar', { p_clave: e.k, p_tipo: 'burbuja', p_pagina: PAGINA }).then(() => {}, () => {})
}

function _cerrarPanel() { _panel?.remove(); _panel = null; document.removeEventListener('keydown', _escPanel) }
const _escPanel = ev => { if (ev.key === 'Escape') _cerrarPanel() }

function _cuerpoHtml(ver) {
  let html = '', lista = []
  const flush = () => { if (lista.length) { html += `<ul>${lista.map(i => `<li>${md(i)}</li>`).join('')}</ul>`; lista = [] } }
  for (const p of ver || []) {
    if (p.startsWith('• ')) { lista.push(p.slice(2)); continue }
    flush()
    html += p.startsWith('## ') ? `<h4>${md(p.slice(3))}</h4>` : `<p>${md(p)}</p>`
  }
  flush(); return html
}

export async function abrirPanel(k) {
  const e = _entrada(k); if (!e) return
  _cerrarPanel()
  _panel = document.createElement('div'); _panel.className = 'ay-panel'
  _panel.innerHTML = `<div class="ay-fondo"></div><aside class="ay-drawer" role="dialog" aria-label="Ayuda">
      <header><b>❓ ${esc(e.t || 'Ayuda')}</b><button type="button" class="ay-x" aria-label="Cerrar">✕</button></header>
      <div class="ay-cuerpo">${e.pv ? '<div class="ay-pv grande">⚠ Por verificar: este texto depende de una regla que aún no se confirmó.</div>' : ''}<p class="ay-resumen">${md(e.tip)}</p>${_cuerpoHtml(e.ver)}</div>
      <footer id="ay-voto"><span>¿Te sirvió esta ayuda?</span>
        <button type="button" data-v="1">👍 Sí</button><button type="button" data-v="0">👎 No</button></footer></aside>`
  document.body.appendChild(_panel)
  requestAnimationFrame(() => _panel?.classList.add('abierto'))
  _panel.querySelector('.ay-fondo').addEventListener('click', _cerrarPanel)
  _panel.querySelector('.ay-x').addEventListener('click', _cerrarPanel)
  document.addEventListener('keydown', _escPanel)
  supabase.rpc('ayuda_registrar', { p_clave: k, p_tipo: 'panel', p_pagina: PAGINA }).then(() => {}, () => {})
  const pie = _panel.querySelector('#ay-voto')
  const gracias = (txt) => { pie.innerHTML = `<span class="ay-gracias">${txt}</span>` }
  const enviar = async (util, com) => {
    const { error } = await supabase.rpc('ayuda_votar', { p_clave: k, p_util: util, p_comentario: com || null, p_pagina: PAGINA })
    gracias(error ? 'No se pudo guardar tu voto.' : util ? '¡Gracias! 🙌' : 'Gracias, lo revisaremos para mejorarla.')
  }
  pie.querySelectorAll('button[data-v]').forEach(b => b.addEventListener('click', () => {
    if (b.dataset.v === '1') return enviar(true)
    pie.innerHTML = `<div class="ay-com"><textarea rows="2" maxlength="300" placeholder="¿Qué faltó o qué no se entendió? (opcional)"></textarea><button type="button" class="ay-env">Enviar</button></div>`
    pie.querySelector('.ay-env').addEventListener('click', () => enviar(false, pie.querySelector('textarea').value))
  }))
  supabase.rpc('ayuda_mi_voto', { p_clave: k }).then(({ data }) => { if (data && data.util != null && _panel) gracias(data.util ? 'Ya marcaste esta ayuda como útil 👍' : 'Ya marcaste que no te sirvió 👎') }, () => {})
}

function _eventos() {
  document.addEventListener('mouseover', ev => {
    const el = ev.target.closest?.('[data-ay]')
    if (!el || el.closest('.ay-bub, .ay-panel')) return
    if (el.dataset.ayArm) return
    el.dataset.ayArm = '1'
    const e = _entrada(el.dataset.ay); if (!e) return
    clearTimeout(_timer); _timer = setTimeout(() => _mostrarBub(el, e), ESPERA_MS)
    const fin = () => { clearTimeout(_timer); delete el.dataset.ayArm; el.removeEventListener('mouseleave', fin) }
    el.addEventListener('mouseleave', fin)
  })
  document.addEventListener('click', ev => {
    const q = ev.target.closest?.('.ay-q')
    if (q) { ev.preventDefault(); ev.stopPropagation(); const e = _entrada(q.dataset.ayQ); if (e) _mostrarBub(q, e); return }
    if (_bub && !_bub.contains(ev.target)) _cerrarBub()
  }, true)
  document.addEventListener('keydown', ev => { if (ev.key === 'Escape') _cerrarBub() })
}

export async function initAyuda() {
  if (window.__ayudaOk) return; window.__ayudaOk = true
  _css(); await _cargarCatalogos(); if (!_entradas.length) return
  _aplicar(); _eventos()
  _obs = new MutationObserver(_aplicarLuego); _obs.observe(document.body, { childList: true, subtree: true })
  window.abrirAyuda = abrirPanel
}
