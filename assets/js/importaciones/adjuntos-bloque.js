// ============================================================================
// adjuntos-bloque.js — botón «📎 Adjuntar archivo» dentro de cada modal de la carpeta
// ============================================================================
// Un solo bloque reutilizable. Se monta SOLO cuando el modal se abre (observa la clase
// `active`), así no hay que tocar cada abridor. Los archivos van al expediente de la
// carpeta con el concepto del documento (CI → «invoice», BL → «bl», etc.): son los mismos
// que se ven en «Documentos de la carpeta», no una lista aparte.
//
//   · Modal de un documento que YA existe (ver / editar): sube y borra al instante.
//   · Modal de CREAR (diferido): los archivos quedan en una lista y se suben al
//     guardar, para no dejar archivos huérfanos si se cancela.
//
// Agregar un modal = una línea en MODALES.

import { getAdjuntos, subirAdjuntos, validarArchivoAdjunto, eliminarAdjunto } from '../supabase-data.js'
import { getCurrentUser } from '../auth-supabase.js'
import { showToast, formatNumber } from '../helpers.js'
import { comprimirAdjunto } from './adjuntos-carpeta.js'

const MODALES = {
  'modal-registrar-ci':       { concepto: 'invoice',  titulo: 'Commercial Invoice (PDF / foto)', diferido: true },
  'modal-editar-importacion': { concepto: 'invoice',  titulo: 'Commercial Invoice (PDF / foto)' },
  'modal-ver-pi':             { concepto: 'proforma', titulo: 'Proforma Invoice (PDF / foto)' },
  'modal-bl-carpeta':         { concepto: 'bl',       titulo: 'Bill of Lading (PDF / foto)' },
  'modal-dam-carpeta':        { concepto: 'dam',      titulo: 'DAM / DUA (PDF / foto)' },
  'modal-dam-boletin':        { concepto: 'boletin',  titulo: 'Boletín químico (PDF)' },
  'modal-guia-carpeta':       { concepto: 'guia',     titulo: 'Guía de remisión (PDF / foto)' }
}

const _pend = {}                      // modalId → [{file, concepto}]  (solo modales diferidos)
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const kb = b => `${formatNumber((parseFloat(b) || 0) / 1024, 0)} KB`
const carpetaId = () => window.carpetaActual?.id || null

function _host(modalId) {
  const m = document.getElementById(modalId); if (!m) return null
  let h = m.querySelector('.adjb')
  if (!h) {
    h = document.createElement('div'); h.className = 'adjb'
    const pie = m.querySelector('.modal-footer')
    if (pie) pie.parentNode.insertBefore(h, pie); else (m.querySelector('.modal-content') || m).appendChild(h)
  }
  return h
}

async function _pintar(modalId) {
  const cfg = MODALES[modalId]; const h = _host(modalId); if (!cfg || !h) return
  let filas = ''
  if (cfg.diferido) {
    const p = _pend[modalId] || []
    filas = p.length
      ? p.map((a, i) => `<div class="adjb-fila"><span>📎 ${esc(a.file.name)} <small>· ${kb(a.file.size)} · se sube al guardar</small></span><button type="button" class="adjb-x" title="Quitar" onclick="window.adjBloqueQuitar('${modalId}',${i})">✕</button></div>`).join('')
      : '<div class="adjb-vacio">Aún no adjuntas nada. Se subirá al guardar.</div>'
  } else {
    const id = carpetaId()
    const adjs = id ? (await getAdjuntos('carpeta_importacion', id)).filter(a => a.concepto === cfg.concepto) : []
    window._acCache = Object.assign(window._acCache || {}, Object.fromEntries(adjs.map(a => [a.id, a])))
    filas = adjs.length
      ? adjs.map(a => `<div class="adjb-fila"><span class="adj-thumb" data-adj-path="${esc(a.path)}" data-adj-nombre="${esc(a.nombre)}">…</span>
          <a href="#" onclick="event.preventDefault(); window.acDescargar(${a.id})" title="Descargar">${esc(a.nombre)}</a>
          <button type="button" class="adjb-x" title="Quitar del expediente" onclick="window.adjBloqueBorrar('${modalId}',${a.id},'${esc(a.nombre).replace(/'/g, '')}')">✕</button></div>`).join('')
      : '<div class="adjb-vacio">Sin archivo adjunto todavía.</div>'
  }
  h.innerHTML = `<div class="adjb-cab"><strong>📎 ${esc(cfg.titulo)}</strong>
      <button type="button" class="btn btn-secondary btn-small" onclick="window.adjBloqueAdjuntar('${modalId}')">＋ Adjuntar archivo</button></div>${filas}`
}

window.adjBloqueAdjuntar = function (modalId) {
  const cfg = MODALES[modalId]; if (!cfg) return
  if (!cfg.diferido && !carpetaId()) { showToast('Selecciona primero una carpeta', 'warning'); return }
  const inp = document.createElement('input'); inp.type = 'file'; inp.multiple = true
  inp.accept = 'application/pdf,image/*,.xlsx,.xls,.doc,.docx'; inp.setAttribute('data-sin-preview', '1')
  inp.onchange = async () => {
    const listos = [], errores = []
    for (const f of inp.files) {
      const c = await comprimirAdjunto(f); const err = validarArchivoAdjunto(c)
      if (err) errores.push(err); else listos.push({ file: c, concepto: cfg.concepto })
    }
    if (errores.length) showToast(errores[0], 'danger')
    if (!listos.length) return
    if (cfg.diferido) { (_pend[modalId] = _pend[modalId] || []).push(...listos); return _pintar(modalId) }
    const user = await getCurrentUser()
    const res = await subirAdjuntos('carpeta_importacion', carpetaId(), listos, user?.db_id)
    showToast(res?.errores?.length ? `${res.ok} subido(s). ${res.errores[0]}` : `${res.ok} documento(s) agregados`, res?.errores?.length ? 'warning' : 'success')
    document.dispatchEvent(new Event('adj-carpeta-cambio'))
    window.renderHojaCosteo?.()
  }
  inp.click()
}
window.adjBloqueQuitar = (modalId, i) => { (_pend[modalId] || []).splice(i, 1); _pintar(modalId) }
window.adjBloqueBorrar = async function (modalId, id, nombre) {
  if (!confirm(`¿Quitar "${nombre}" del expediente?\n\nSe borra el archivo y no se puede deshacer.`)) return
  try { await eliminarAdjunto(id); showToast('Documento eliminado', 'success'); document.dispatchEvent(new Event('adj-carpeta-cambio')); window.renderHojaCosteo?.() }
  catch (e) { showToast(e.message || 'No se pudo eliminar', 'danger') }
}
/** Sube lo que quedó en la lista de un modal de CREAR (se llama justo después de guardar). */
window.adjBloqueSubirPendientes = async function (modalId) {
  const p = _pend[modalId] || []; const id = carpetaId()
  if (!p.length || !id) return
  const user = await getCurrentUser()
  const res = await subirAdjuntos('carpeta_importacion', id, p, user?.db_id)
  _pend[modalId] = []
  showToast(res?.errores?.length ? `${res.ok} adjunto(s) subidos. ${res.errores[0]}` : `${res.ok} adjunto(s) subidos`, res?.errores?.length ? 'warning' : 'success')
  document.dispatchEvent(new Event('adj-carpeta-cambio'))
}

// ── Montaje: cuando un modal registrado se abre (o se crea ya abierto) ─────────
function _revisar(el) {
  if (!el?.id || !MODALES[el.id]) return
  if (el.classList.contains('active') || el.classList.contains('show') || el.style.display === 'flex' || el.style.display === 'block') {
    if (MODALES[el.id].diferido && el.dataset.adjb !== 'abierto') _pend[el.id] = []   // CI nuevo: lista limpia
    el.dataset.adjb = 'abierto'; _pintar(el.id)
  } else el.dataset.adjb = ''
}
const _ver = new MutationObserver(muts => {
  for (const m of muts) {
    if (m.type === 'attributes') _revisar(m.target)
    else m.addedNodes.forEach(n => { if (n.nodeType === 1) { _revisar(n); n.querySelectorAll?.('.modal').forEach(_revisar) } })
  }
})
_ver.observe(document.body, { attributes: true, attributeFilter: ['class', 'style'], subtree: true, childList: true })
document.addEventListener('adj-carpeta-cambio', () => {
  for (const id of Object.keys(MODALES)) { const m = document.getElementById(id); if (m?.dataset.adjb === 'abierto' && !MODALES[id].diferido) _pintar(id) }
})
Object.keys(MODALES).forEach(id => _revisar(document.getElementById(id)))

// ── Estilo (mismo lenguaje que el resto: línea punteada, chips discretos) ─────
if (!document.getElementById('adjb-css')) {
  const st = document.createElement('style'); st.id = 'adjb-css'
  st.textContent = `.adjb{margin:10px 20px 14px;padding:10px 14px;border:1px dashed var(--border-color,#334155);border-radius:10px;background:var(--bg-secondary,rgba(255,255,255,.03))}
  .adjb-cab{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:6px;font-size:.88rem}
  .adjb-fila{display:flex;align-items:center;gap:10px;padding:5px 0;font-size:.84rem;border-top:1px solid var(--border-color,#334155)}
  .adjb-fila:first-of-type{border-top:0}.adjb-fila a{flex:1;color:var(--color-link,#93c5fd);text-decoration:none}.adjb-fila span{flex:1}
  .adjb-x{margin-left:auto;background:none;border:0;color:var(--text-secondary,#94a3b8);cursor:pointer;font-size:.9rem}.adjb-x:hover{color:#ef4444}
  .adjb-fila .adj-thumb{flex:0 0 84px!important;width:84px;height:52px;overflow:hidden;border-radius:6px}.adjb-fila .adj-thumb img,.adjb-fila .adj-thumb canvas{width:100%;height:100%;object-fit:cover}
  .adjb-vacio{font-size:.8rem;color:var(--text-secondary,#94a3b8)}`
  document.head.appendChild(st)
}
