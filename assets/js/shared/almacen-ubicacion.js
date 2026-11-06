// shared/almacen-ubicacion.js — Modal "Ubicación del almacén" con mapa (2026-11-06)
// Eliges el punto exacto haciendo clic o arrastrando el pin; guarda almacenes.lat/lng (SQL 140).
// Se abre desde el mapa del CRM y desde el modal "Editar almacén" de Inventario:
//   window.abrirUbicacionAlmacen(almacenId, { centro:{lat,lng}, alGuardar:()=>{} })
import { getAlmacenById, updateAlmacen } from '../supabase-data.js'
import { showToast } from '../helpers.js'
import { cargarLeaflet } from './leaflet-carga.js'
import { coordsDeMaps, coordsDeTexto } from './maps-coords.js'

const ID = 'modal-almacen-ubic'
const esc = v => String(v ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
let _map = null, _pin = null, _alm = null, _cb = null

function asegurarModal() {
  if (document.getElementById(ID)) return
  const d = document.createElement('div'); d.id = ID; d.className = 'modal'
  d.innerHTML = `<div class="modal-content" style="max-width:760px">
    <div class="modal-header"><h3 class="modal-title" id="auTitulo">📍 Ubicación del almacén</h3><button class="modal-close" onclick="window.closeModal('${ID}')">✕</button></div>
    <div class="grid grid-2">
      <div class="form-group"><label>Código</label><input type="text" id="auCodigo" disabled></div>
      <div class="form-group"><label>Nombre *</label><input type="text" id="auNombre"></div>
    </div>
    <div class="form-group"><label>Dirección *</label><input type="text" id="auDireccion"></div>
    <div class="form-group"><label>Pega un link largo de Google Maps o coordenadas (−11.99, −77.00)</label>
      <div style="display:flex;gap:8px"><input type="text" id="auBuscar" placeholder="https://www.google.com/maps/…  ó  -11.9985, -77.0000" style="flex:1">
      <button class="btn btn-secondary btn-small" type="button" id="auIr">Ir</button><button class="btn btn-secondary btn-small" type="button" id="auGps">📡 Mi ubicación</button></div></div>
    <div id="auMapa" style="height:340px;border-radius:10px;border:1px solid var(--border-color)"></div>
    <div class="grid grid-2" style="margin-top:8px">
      <div class="form-group"><label>Latitud</label><input type="number" step="any" id="auLat"></div>
      <div class="form-group"><label>Longitud</label><input type="number" step="any" id="auLng"></div>
    </div>
    <small style="color:var(--text-secondary)">Haz clic en el mapa o arrastra el pin hasta tu portón. Tip: cambia a vista satélite (arriba a la derecha) para ver el techo.</small>
    <div class="modal-footer"><button class="btn btn-secondary" onclick="window.closeModal('${ID}')">Cancelar</button><button class="btn btn-primary" id="auGuardar">Guardar ubicación</button></div>
  </div>`
  document.body.appendChild(d)
  const $ = s => d.querySelector(s)
  const poner = (lat, lng, centrar = true) => {
    lat = +lat; lng = +lng; if (!isFinite(lat) || !isFinite(lng)) return
    if (!_pin) { _pin = window.L.marker([lat, lng], { draggable: true }).addTo(_map); _pin.on('dragend', () => { const p = _pin.getLatLng(); $('#auLat').value = p.lat.toFixed(6); $('#auLng').value = p.lng.toFixed(6) }) }
    else _pin.setLatLng([lat, lng])
    $('#auLat').value = lat.toFixed(6); $('#auLng').value = lng.toFixed(6)
    if (centrar) _map.setView([lat, lng], Math.max(_map.getZoom(), 16))
  }
  d._poner = poner
  $('#auIr').onclick = () => { const t = $('#auBuscar').value, c = coordsDeMaps(t) || coordsDeTexto(t); c ? poner(c.lat, c.lng) : showToast('No pude leer coordenadas de ese texto (los links cortos maps.app.goo.gl no sirven: abre el link y copia el largo)', 'warning') }
  $('#auGps').onclick = () => navigator.geolocation ? navigator.geolocation.getCurrentPosition(p => poner(p.coords.latitude, p.coords.longitude), () => showToast('No se pudo leer tu ubicación', 'warning'), { enableHighAccuracy: true }) : showToast('Tu navegador no da ubicación', 'warning')
  ;['#auLat', '#auLng'].forEach(s => $(s).addEventListener('change', () => poner($('#auLat').value, $('#auLng').value)))
  $('#auGuardar').onclick = async () => {
    const lat = parseFloat($('#auLat').value), lng = parseFloat($('#auLng').value), nombre = $('#auNombre').value.trim(), direccion = $('#auDireccion').value.trim()
    if (!isFinite(lat) || !isFinite(lng)) return showToast('Marca el punto en el mapa', 'warning')
    if (!nombre || !direccion) return showToast('Completa nombre y dirección', 'warning')
    const r = await updateAlmacen(_alm.id, { nombre, direccion, lat, lng })
    if (!r) return showToast('No se pudo guardar. ¿Corriste el SQL 140?', 'danger')
    showToast('Ubicación del almacén guardada', 'success'); window.closeModal(ID)
    try { _cb && await _cb({ lat, lng }) } catch (e) { console.error(e) }
  }
}

export async function abrirUbicacionAlmacen(almacenId, opts = {}) {
  try {
    const L = await cargarLeaflet(); asegurarModal()
    const a = await getAlmacenById(+almacenId); if (!a) return showToast('No se encontró el almacén', 'danger')
    _alm = a; _cb = opts.alGuardar || null
    const d = document.getElementById(ID), $ = s => d.querySelector(s)
    $('#auCodigo').value = a.codigo || ''; $('#auNombre').value = a.nombre || ''; $('#auDireccion').value = a.direccion || ''; $('#auBuscar').value = ''
    $('#auLat').value = ''; $('#auLng').value = ''
    window.openModal(ID)
    setTimeout(() => {
      if (_map) { _map.remove(); _map = null; _pin = null }
      const tiene = a.lat != null && a.lng != null, c = tiene ? { lat: +a.lat, lng: +a.lng } : (opts.centro || { lat: -11.9985, lng: -77.0 })
      _map = L.map('auMapa').setView([c.lat, c.lng], tiene ? 17 : 12)
      const osm = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(_map)
      const sat = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19, attribution: 'Esri' })
      L.control.layers({ 'Calles': osm, 'Satélite': sat }).addTo(_map)
      _map.on('click', e => d._poner(e.latlng.lat, e.latlng.lng, false))
      if (tiene) d._poner(c.lat, c.lng, false)
      _map.invalidateSize()
    }, 250)
  } catch (e) { console.error(e); showToast(e.message || 'No se pudo abrir el mapa', 'danger') }
}
window.abrirUbicacionAlmacen = abrirUbicacionAlmacen
