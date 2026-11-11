// ============================================================================
// shared/asistencia-boton.js — Botón Ingreso/Salida en la cabecera (RRHH · R1)
// Aparece en TODAS las páginas SOLO si el usuario logueado está vinculado a un
// empleado activo (empleados.user_id). La hora la pone el SERVIDOR (rrhh_marcar):
// el celular/PC del empleado no puede falsearla. Si el SQL 135 no está o el
// usuario no es empleado, no se muestra nada (silencioso a propósito).
// ============================================================================
import { supabase } from '../supabase-client.js'
import { showToast } from '../helpers.js'

let _estado = null
let _btn = null

const _hm = iso => iso ? new Date(iso).toLocaleTimeString('es-PE', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'America/Lima' }) : ''

export async function initBotonAsistencia() {
  try {
    const hc = document.querySelector('.header-controls')
    if (!hc || document.getElementById('btnAsistencia')) return
    const { data, error } = await supabase.rpc('rrhh_mi_estado')
    if (error || !data) return
    _estado = data
    _btn = document.createElement('button')
    _btn.id = 'btnAsistencia'
    _btn.type = 'button'
    _btn.className = 'btn btn-small'
    _btn.addEventListener('click', _alClick)
    hc.insertBefore(_btn, hc.firstChild)
    _pintar()
  } catch (e) { console.warn('asistencia-boton:', e.message) }
}

function _pintar() {
  if (!_btn || !_estado) return
  const { entrada, salida } = _estado
  if (!entrada) {
    _btn.textContent = '🟢 Marcar'; _btn.className = 'btn btn-primary btn-small'; _btn.disabled = false
    _btn.title = 'Marcar ingreso (hora oficial de Lima)'
  } else if (!salida) {
    _btn.textContent = '🔴 Marcar'; _btn.className = 'btn btn-warning btn-small'; _btn.disabled = false
    _btn.title = `Marcar salida · ingresaste a las ${_hm(entrada)}`
  } else {
    _btn.textContent = `✔ ${_hm(entrada)} – ${_hm(salida)}`; _btn.className = 'btn btn-secondary btn-small'; _btn.disabled = true
    _btn.title = 'Jornada de hoy completa'
  }
}

async function _alClick() {
  if (!_estado) return
  const tipo = _estado.entrada ? 'salida' : 'entrada'
  if (tipo === 'salida' && !confirm('¿Marcar tu SALIDA ahora?')) return
  _btn.disabled = true
  const { data, error } = await supabase.rpc('rrhh_marcar', { p_empleado_id: _estado.empleado_id, p_tipo: tipo })
  if (error) { showToast(error.message || 'No se pudo marcar', 'danger'); _pintar(); return }
  _estado = { ..._estado, entrada: data.entrada, salida: data.salida }
  _pintar()
  showToast(`${tipo === 'entrada' ? 'Ingreso' : 'Salida'} registrado a las ${data.hora_lima} (hora de Lima) ✔`, 'success', 6000)
}
