// shared/maps-coords.js — saca latitud/longitud de un enlace de Google Maps (2026-11-06)
// Soporta los enlaces LARGOS (…/@-12.04,-77.03,17z · …!3d-12.04!4d-77.03 · ?q=-12.04,-77.03 · ll=). Los enlaces
// cortos (maps.app.goo.gl) no se pueden leer desde el navegador: se devuelve null y la pantalla pide pegar las coordenadas.
const _ok = (a, b) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a) <= 90 && Math.abs(b) <= 180
export function coordsDeMaps(url) {
  const s = decodeURIComponent(String(url || ''))
  const pats = [/@(-?\d+\.\d+),(-?\d+\.\d+)/, /!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/, /[?&](?:q|ll|query|destination)=(-?\d+\.\d+)[, ](-?\d+\.\d+)/]
  for (const p of pats) { const m = s.match(p); if (m && _ok(+m[1], +m[2])) return { lat: +m[1], lng: +m[2] } }
  return null
}
/** "−12.0464, −77.0428" → {lat,lng} */
export function coordsDeTexto(t) {
  const m = String(t || '').replace(/[−–]/g, '-').match(/(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)/)
  return m && _ok(+m[1], +m[2]) ? { lat: +m[1], lng: +m[2] } : null
}
