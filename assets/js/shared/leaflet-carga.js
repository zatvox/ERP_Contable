// shared/leaflet-carga.js — carga Leaflet 1.9.4 (cdnjs) una sola vez. 2026-11-06
const LEAF = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/'
let _p = null
export function cargarLeaflet() {
  if (window.L) return Promise.resolve(window.L)
  if (_p) return _p
  _p = new Promise((ok, ko) => {
    const css = document.createElement('link'); css.rel = 'stylesheet'; css.href = LEAF + 'leaflet.min.css'; document.head.appendChild(css)
    const js = document.createElement('script'); js.src = LEAF + 'leaflet.min.js'; js.onload = () => ok(window.L)
    js.onerror = () => { _p = null; ko(new Error('No se pudo cargar el mapa (Leaflet). Revisa tu conexión.')) }
    document.head.appendChild(js)
  })
  return _p
}
export function cargarCss(href) {
  const nom = href.split('/').pop().split('?')[0]
  const ya = [...document.querySelectorAll('link[rel=stylesheet]')].find(l => l.href && l.href.includes(nom))
  if (ya) return ya.sheet ? Promise.resolve() : new Promise(ok => { ya.addEventListener('load', ok); ya.addEventListener('error', ok) })
  return new Promise(ok => { const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = href; l.onload = ok; l.onerror = ok; document.head.appendChild(l) })
}
