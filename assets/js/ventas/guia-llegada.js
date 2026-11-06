// ============================================================================
// ventas/guia-llegada.js — "Dirección de entrega" (punto de llegada) de la Guía de Despacho (2026-11-05, SQL 136)
// ============================================================================
// SUNAT (RCP, art. 19.2 num. 1, acápite 1.9) pide la DIRECCIÓN DEL PUNTO DE LLEGADA; del
// destinatario solo exige nombre y RUC. Por eso puede ser distinta del domicilio fiscal.
// Se propone, en este orden:
//   1. La ubicación de despacho del PK (si el vendedor puso una dirección distinta),
//   2. La dirección registrada del cliente (Contactos).
// Siempre editable. Con ubigeo/distrito: confirmar con el contador si tu emisor lo valida.
// ============================================================================
import { supabase } from '../supabase-client.js'
import { coordsDeMaps, coordsDeTexto } from '../shared/maps-coords.js'

const _$ = id => document.getElementById(id)
/** ISO → valor de <input type=datetime-local> en hora local */
const aLocal = iso => { if (!iso) return ''; const d = new Date(iso); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16) }
const _mapsOk = v => !v || /^https?:\/\//i.test(v)

/** Rellena los campos. `guia` = fila de la guía (modo edición) o null. */
export async function prefillLlegada(venta, cliente, guia = null) {
  const set = (id, v) => { const el = _$(id); if (el) el.value = v ?? '' }
  const nota = _$('gdLlegadaNota')
  if (guia && (guia.punto_llegada_direccion || guia.punto_llegada_distrito)) {
    set('gdLlegadaDir', guia.punto_llegada_direccion); set('gdLlegadaDistrito', guia.punto_llegada_distrito); set('gdLlegadaMaps', guia.punto_llegada_maps_url)
    set('gdLlegadaCoord', guia.punto_llegada_lat != null ? `${guia.punto_llegada_lat}, ${guia.punto_llegada_lng}` : '')
    set('gdHoraSalida', aLocal(guia.hora_salida))
    if (nota) nota.textContent = 'Dirección guardada en esta guía.'
    return
  }
  let pk = null
  if (venta?.packing_id) {
    const { data } = await supabase.from('packing').select('numero, despacho_lat, despacho_lng, termino_despacho, despacho_usa_dir_cliente, despacho_direccion, despacho_distrito, despacho_maps_url').eq('id', venta.packing_id).maybeSingle()
    pk = data || null
  }
  set('gdHoraSalida', ''); set('gdLlegadaCoord', pk?.despacho_lat != null ? `${pk.despacho_lat}, ${pk.despacho_lng}` : '')
  const dirCli = cliente?.direccion || '', disCli = cliente?.distrito || ''
  if (pk?.termino_despacho === 'despacho' && pk.despacho_usa_dir_cliente === false && pk.despacho_direccion) {
    set('gdLlegadaDir', pk.despacho_direccion); set('gdLlegadaDistrito', pk.despacho_distrito); set('gdLlegadaMaps', pk.despacho_maps_url)
    if (nota) nota.textContent = `Tomada de la ubicación de despacho del ${pk.numero}.`
  } else {
    set('gdLlegadaDir', dirCli); set('gdLlegadaDistrito', pk?.despacho_distrito || disCli); set('gdLlegadaMaps', pk?.despacho_maps_url || '')
    if (nota) nota.textContent = pk?.termino_despacho === 'recoge_cliente'
      ? 'El PK dice "recoge el cliente": se propone la dirección registrada; cámbiala si retiran en otro punto.'
      : 'Tomada de la dirección registrada del cliente. Puedes cambiarla: el punto de llegada no tiene que ser el domicilio fiscal.'
  }
}

export function leerLlegada() {
  return {
    punto_llegada_direccion: _$('gdLlegadaDir')?.value.trim() || null,
    punto_llegada_distrito: _$('gdLlegadaDistrito')?.value.trim() || null,
    punto_llegada_maps_url: _$('gdLlegadaMaps')?.value.trim() || null,
    ...(() => { const c = coordsDeTexto(_$('gdLlegadaCoord')?.value) || coordsDeMaps(_$('gdLlegadaMaps')?.value); return { punto_llegada_lat: c?.lat ?? null, punto_llegada_lng: c?.lng ?? null } })(),
    hora_salida: _$('gdHoraSalida')?.value ? new Date(_$('gdHoraSalida').value).toISOString() : null
  }
}

/** Devuelve un mensaje de error o null. La dirección del punto de llegada es obligatoria en la guía. */
export function validarLlegada() {
  const l = leerLlegada()
  if (!l.punto_llegada_direccion) return 'Falta la dirección de entrega (punto de llegada): SUNAT la exige en la guía.'
  if (!_mapsOk(l.punto_llegada_maps_url)) return 'El link de Maps debe empezar con http:// o https://'
  return null
}
