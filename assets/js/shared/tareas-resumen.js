// shared/tareas-resumen.js — línea «Tienes N tareas pendientes (M vencidas)» en el Dashboard. Silencioso si falta el SQL 161.
import { supabase } from '../supabase-client.js'

export async function montarResumenTareas(destino = '.content') {
  try {
    const { data, error } = await supabase.rpc('tareas_mis_numeros')
    if (error || !data) return
    const { pendientes = 0, vencidas = 0, te_bloquean = 0 } = data
    if (!pendientes && !te_bloquean) return
    if (!document.getElementById('css-tareas')) { const l = document.createElement('link'); l.id = 'css-tareas'; l.rel = 'stylesheet'; l.href = new URL('../../css/tareas.css?v=1', import.meta.url).href; document.head.appendChild(l) }
    const cont = document.querySelector(destino) || document.body
    const d = document.createElement('div'); d.className = 'tk-dash'
    d.innerHTML = `✅ <span>Tienes <b>${pendientes}</b> tarea(s) pendiente(s)${vencidas ? ` · <b class="rojo">${vencidas} vencida(s)</b>` : ''}${te_bloquean ? ` · <b>${te_bloquean}</b> persona(s) te esperan` : ''}</span><a href="tareas.html" class="btn btn-secondary btn-small" style="text-decoration:none;">Ver tareas</a>`
    cont.insertBefore(d, cont.firstChild)
  } catch (e) { console.warn('tareas-resumen:', e.message) }
}
