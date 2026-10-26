// ============================================================================
// shared/adj-preview.js — Miniaturas de adjuntos (imagen o 1ra página de PDF)
// 2026-10-22. Se carga desde main.js en todas las páginas.
//
//  1) AUTOMÁTICO en cualquier <input type="file"> que acepte PDF/imagen:
//     al elegir archivos se pinta una fila de miniaturas debajo del input.
//     (Los <input> de Excel/CSV se ignoran.) Para excluir uno: data-sin-preview.
//  2) Listas propias: miniaturaArchivoHTML(i) + pintarMiniaturaArchivo(el, file)
//  3) Adjuntos YA guardados (bucket `adjuntos`): poner en el HTML
//       <span class="adj-thumb" data-adj-path="ruta" data-adj-nombre="x.pdf"></span>
//     y el observer los hidrata solo (URL firmada). Clic → visor grande.
// ============================================================================
import { getUrlAdjunto } from '../supabase-data.js'

const PDFJS = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/'
let _pdfjsProm = null
function _pdfjs() {
  if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib)
  if (_pdfjsProm) return _pdfjsProm
  _pdfjsProm = new Promise((ok, mal) => {
    const s = document.createElement('script')
    s.src = PDFJS + 'pdf.min.js'
    s.onload = () => { window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS + 'pdf.worker.min.js'; ok(window.pdfjsLib) }
    s.onerror = () => { _pdfjsProm = null; mal(new Error('No cargó pdf.js')) }
    document.head.appendChild(s)
  })
  return _pdfjsProm
}

const _esPdf = (tipo, nombre) => /pdf/i.test(tipo || '') || /\.pdf$/i.test(nombre || '')
const _esImg = (tipo, nombre) => /^image\//i.test(tipo || '') || /\.(jpe?g|png|webp|gif)$/i.test(nombre || '')

/** Dibuja la 1ra página del PDF (ArrayBuffer o URL) dentro de `el`. */
async function _pintarPdf(el, fuente) {
  try {
    const lib = await _pdfjs()
    const doc = await lib.getDocument(typeof fuente === 'string' ? { url: fuente } : { data: fuente }).promise
    const pag = await doc.getPage(1)
    const v0 = pag.getViewport({ scale: 1 })
    const escala = 112 / Math.max(v0.width, v0.height)   // 2× de 56 px → nítido
    const vp = pag.getViewport({ scale: escala })
    const cv = document.createElement('canvas')
    cv.width = Math.ceil(vp.width); cv.height = Math.ceil(vp.height)
    await pag.render({ canvasContext: cv.getContext('2d'), viewport: vp }).promise
    cv.style.objectFit = 'cover'
    el.innerHTML = ''; el.appendChild(cv)
    el.insertAdjacentHTML('beforeend', '<span class="adj-thumb-tag">PDF</span>')
  } catch (e) {
    el.innerHTML = 'PDF'
  }
}

/** HTML de una miniatura vacía (la llena pintarMiniaturaArchivo). */
export function miniaturaArchivoHTML(id = '') {
  return `<span class="adj-thumb" ${id ? `id="${id}"` : ''} title="Ver en grande">…</span>`
}

/** Llena `el` con la vista previa de un File local y abre el visor al hacer clic. */
export function pintarMiniaturaArchivo(el, file) {
  if (!el || !file) return
  const url = URL.createObjectURL(file)
  el.onclick = (ev) => { ev.preventDefault(); ev.stopPropagation(); abrirVisor(url, file.type, file.name) }
  el.title = `${file.name} — clic para ver en grande`
  if (_esImg(file.type, file.name)) el.innerHTML = `<img src="${url}" alt="">`
  else if (_esPdf(file.type, file.name)) file.arrayBuffer().then(b => _pintarPdf(el, b))
  else el.textContent = (file.name.split('.').pop() || 'archivo').toUpperCase().slice(0, 4)
}

/** Visor a pantalla completa (imagen o PDF). Esc o clic afuera cierra. */
export function abrirVisor(url, tipo, nombre) {
  const d = document.createElement('div')
  d.className = 'adj-visor'
  d.innerHTML = `<button class="adj-visor-cerrar" title="Cerrar">✕</button>` +
    (_esImg(tipo, nombre) ? `<img src="${url}" alt="">` : `<iframe src="${url}"></iframe>`)
  const cerrar = () => { d.remove(); document.removeEventListener('keydown', esc, true) }
  const esc = e => { if (e.key === 'Escape') { e.stopPropagation(); cerrar() } }
  d.addEventListener('click', e => { if (e.target === d || e.target.classList.contains('adj-visor-cerrar')) cerrar() })
  document.addEventListener('keydown', esc, true)
  document.body.appendChild(d)
}
window.abrirVisorAdjunto = abrirVisor

// ── 1) Automático en inputs de archivo ──────────────────────────────────────
const _aceptaPreview = inp => {
  if (inp.hasAttribute('data-sin-preview')) return false
  const acc = (inp.getAttribute('accept') || '').toLowerCase()
  return !acc || /pdf|image|\.jpe?g|\.png|\.webp/.test(acc)
}
// Fase de CAPTURA: corre antes del onchange del input (que a veces limpia value).
document.addEventListener('change', (ev) => {
  const inp = ev.target
  if (!(inp instanceof HTMLInputElement) || inp.type !== 'file' || !_aceptaPreview(inp)) return
  let cont = inp._adjThumbs
  if (!cont || !cont.isConnected) {
    cont = document.createElement('div')
    cont.className = 'adj-thumbs-input'
    inp.insertAdjacentElement('afterend', cont)
    inp._adjThumbs = cont
  }
  cont.innerHTML = ''
  // Los que tienen lista propia (Cobranzas) muestran la miniatura en esa lista
  if (inp.hasAttribute('data-preview-lista')) return
  for (const f of [...(inp.files || [])].slice(0, 10)) {
    const s = document.createElement('span'); s.className = 'adj-thumb'
    cont.appendChild(s); pintarMiniaturaArchivo(s, f)
  }
}, true)
// Si el código limpia el input (input.value=''), quita las miniaturas viejas.
setInterval(() => {
  document.querySelectorAll('.adj-thumbs-input').forEach(c => {
    const inp = c.previousElementSibling
    if (!inp || inp.type !== 'file' || !inp.files?.length) c.innerHTML = ''
  })
}, 800)

// ── 3) Adjuntos ya guardados: hidratar <span class="adj-thumb" data-adj-path> ─
const _cacheUrl = new Map()
async function _hidratar(el) {
  el.dataset.ok = '1'
  const path = el.dataset.adjPath, nombre = el.dataset.adjNombre || path
  try {
    let url = _cacheUrl.get(path)
    if (!url) { url = await getUrlAdjunto(path, 3600); _cacheUrl.set(path, url) }
    if (!url) throw new Error('sin url')
    el.title = `${nombre} — clic para ver en grande`
    el.onclick = (ev) => { ev.preventDefault(); ev.stopPropagation(); abrirVisor(url, '', nombre) }
    if (_esImg('', nombre) || _esImg('', path)) el.innerHTML = `<img src="${url}" alt="" loading="lazy">`
    else if (_esPdf('', nombre) || _esPdf('', path)) await _pintarPdf(el, url)
    else el.textContent = (nombre.split('.').pop() || '').toUpperCase().slice(0, 4)
  } catch { el.textContent = '—' }
}
const _scan = (root = document) => root.querySelectorAll?.('.adj-thumb[data-adj-path]:not([data-ok])').forEach(_hidratar)
new MutationObserver(muts => { for (const m of muts) for (const n of m.addedNodes) if (n.nodeType === 1) { if (n.matches?.('.adj-thumb[data-adj-path]:not([data-ok])')) _hidratar(n); else _scan(n) } })
  .observe(document.documentElement, { childList: true, subtree: true })
_scan()
