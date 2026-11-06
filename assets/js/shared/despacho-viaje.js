// shared/despacho-viaje.js — acciones del camión (2026-11-06)
// "Despachar" guarda hora_salida = ahora; "Entregado" guarda hora_llegada = ahora (y salida si faltaba).
// Se usa desde el mapa del CRM y desde el menú ⋮ de la lista de guías.
import { supabase } from '../supabase-client.js'
import { showToast } from '../helpers.js'
import { invalidateGuiasDespachoVentaCache } from '../supabase-data.js'

async function marcar(id, campos, soloSiNulo) {
  let q = supabase.from('guias_despacho_venta').update(campos).eq('id', id)
  if (soloSiNulo) q = q.is(soloSiNulo, null)
  const { data, error } = await q.select('id')
  if (error) { console.error('despacho-viaje:', error); showToast('No se pudo guardar: ' + error.message, 'danger'); return false }
  if (!data || !data.length) { showToast('Ese camión ya estaba marcado', 'warning'); return false }
  try { invalidateGuiasDespachoVentaCache() } catch (_) { /* sin caché */ }
  return true
}
export async function despacharGuia(id) {
  const ok = await marcar(id, { hora_salida: new Date().toISOString() }, 'hora_salida')
  if (ok) { showToast('🚚 Camión despachado: salió ahora', 'success'); document.dispatchEvent(new CustomEvent('viaje-actualizado')) }
  return ok
}
export async function entregarGuia(id, saleAhora = false) {
  const ahora = new Date().toISOString()
  const ok = await marcar(id, saleAhora ? { hora_llegada: ahora, hora_salida: ahora } : { hora_llegada: ahora }, 'hora_llegada')
  if (ok) { showToast('✅ Entrega confirmada', 'success'); document.dispatchEvent(new CustomEvent('viaje-actualizado')) }
  return ok
}
window.despacharGuia = async id => { if (await despacharGuia(id) && typeof window.renderGuiasDespachoVenta === 'function') try { window.renderGuiasDespachoVenta(true) } catch (_) {} }
window.entregarGuia = async id => { if (await entregarGuia(id) && typeof window.renderGuiasDespachoVenta === 'function') try { window.renderGuiasDespachoVenta(true) } catch (_) {} }
