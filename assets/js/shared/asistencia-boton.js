// ============================================================================
// shared/asistencia-boton.js — Botón «Marcar» + modal de marcación (RRHH · R1/R2)
// Aparece en TODAS las páginas SOLO si el usuario logueado está vinculado a un
// empleado activo (empleados.user_id). La hora la pone el SERVIDOR (rrhh_marcar):
// el celular/PC del empleado no puede falsearla. El modal muestra el reloj oficial
// de Lima, confirma quién marca (nombre – documento) y preselecciona el siguiente paso.
// Requiere SQL 158 (marcas de almuerzo / otro).
// ============================================================================
import { supabase } from '../supabase-client.js'
import { showToast } from '../helpers.js'

let _estado = null
let _btn = null
let _offsetMs = 0          // servidor − navegador: el reloj del modal sigue la hora oficial
let _timer = null

export const TIPOS_MARCA = {
  entrada:          { icono: '🟢', label: 'Ingreso a labores' },
  almuerzo_salida:  { icono: '🍽️', label: 'Salida a almuerzo' },
  almuerzo_regreso: { icono: '↩️', label: 'Regreso de almuerzo' },
  salida:           { icono: '🔴', label: 'Salida de labores' },
  otro:             { icono: '📝', label: 'Otro (nota informativa)' }
}
// Ventana en la que se avisa del almuerzo (se puede marcar fuera de ella)
const ALMUERZO_DESDE = 12 * 60 + 30, ALMUERZO_HASTA = 13 * 60 + 30

const _esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const _hm = iso => iso ? new Date(iso).toLocaleTimeString('es-PE', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'America/Lima' }) : ''
const _ahora = () => new Date(Date.now() + _offsetMs)
const _minLimaAhora = () => { const [h, m] = _ahora().toLocaleTimeString('es-PE', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'America/Lima' }).split(':').map(Number); return h * 60 + m }
const _dowLima = () => ({ Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 })[_ahora().toLocaleDateString('en-US', { weekday: 'short', timeZone: 'America/Lima' })]
const _salidaHoy = est => est.horario_semanal?.[String(_dowLima())]?.s || est.hora_salida     // salida programada de HOY
const _toMin = hhmm => { const [h, m] = String(hhmm || '0:0').split(':').map(Number); return h * 60 + m }

/** Estado del día → qué marcas ya hay y cuál sigue. */
export function estadoDelDia(est) {
  const marcas = est.marcas || []
  const almS = marcas.find(m => m.tipo === 'almuerzo_salida')
  const almR = marcas.find(m => m.tipo === 'almuerzo_regreso')
  const terminado = !!est.salida
  const enAlmuerzo = !!almS && !almR
  let siguiente = null
  if (!est.entrada) siguiente = 'entrada'
  else if (terminado) siguiente = null
  else if (enAlmuerzo) siguiente = 'almuerzo_regreso'
  else if (!almS) siguiente = _minLimaAhora() >= _toMin(_salidaHoy(est)) - 30 ? 'salida' : 'almuerzo_salida'
  else siguiente = 'salida'
  const min = _minLimaAhora()
  const avisoAlmuerzo = !!est.entrada && !terminado && !almS && min >= ALMUERZO_DESDE && min <= ALMUERZO_HASTA
  return { almS, almR, terminado, enAlmuerzo, siguiente, avisoAlmuerzo }
}

/** Qué tipos se pueden elegir ahora (todos los que el servidor aceptaría). */
function tiposDisponibles(est, d) {
  if (!est.entrada) return ['entrada']
  if (d.terminado) return []
  const t = []
  if (!d.almS) t.push('almuerzo_salida')
  if (d.enAlmuerzo) t.push('almuerzo_regreso')
  if (!d.enAlmuerzo) t.push('salida')
  t.push('otro')
  return t
}

export async function initBotonAsistencia() {
  try {
    const hc = document.querySelector('.header-controls')
    if (!hc || document.getElementById('btnAsistencia')) return
    if (!await _cargarEstado()) return
    _btn = document.createElement('button')
    _btn.id = 'btnAsistencia'
    _btn.type = 'button'
    _btn.className = 'btn btn-small'
    _btn.addEventListener('click', () => abrirModalMarcar())
    hc.insertBefore(_btn, hc.firstChild)
    _pintar()
    setInterval(_pintar, 60000)       // el aviso de almuerzo aparece solo al entrar en la ventana
  } catch (e) { console.warn('asistencia-boton:', e.message) }
}

async function _cargarEstado() {
  const { data, error } = await supabase.rpc('rrhh_mi_estado')
  if (error || !data) return false
  _estado = data
  if (data.epoch_ms) _offsetMs = Number(data.epoch_ms) - Date.now()
  return true
}

function _pintar() {
  if (!_btn || !_estado) return
  const d = estadoDelDia(_estado)
  _btn.disabled = false
  if (d.terminado) {
    _btn.textContent = `✔ ${_hm(_estado.entrada)} – ${_hm(_estado.salida)}`; _btn.className = 'btn btn-secondary btn-small'
    _btn.title = 'Jornada de hoy completa (clic para ver tus marcas)'
  } else if (!_estado.entrada) {
    _btn.textContent = '🟢 Marcar'; _btn.className = 'btn btn-primary btn-small'; _btn.title = 'Marcar ingreso (hora oficial de Lima)'
  } else if (d.enAlmuerzo) {
    _btn.textContent = '↩️ Marcar regreso'; _btn.className = 'btn btn-warning btn-small'; _btn.title = `Saliste a almuerzo a las ${_hm(d.almS.hora)}`
  } else if (d.avisoAlmuerzo) {
    _btn.textContent = '🍽️ Marcar almuerzo'; _btn.className = 'btn btn-warning btn-small'; _btn.title = 'Es hora de almuerzo (12:30–13:30). Puedes marcarlo más tarde si lo atrasas.'
  } else {
    _btn.textContent = '🔴 Marcar'; _btn.className = 'btn btn-primary btn-small'; _btn.title = `Ingresaste a las ${_hm(_estado.entrada)}`
  }
}

// ── Modal ───────────────────────────────────────────────────────────────────
export async function abrirModalMarcar(empleadoAdmin = null) {
  // empleadoAdmin = { empleado_id, nombre, tipo_documento, nro_documento, entrada, salida, marcas, hora_entrada, hora_salida }: el admin marca por otra persona
  let est = empleadoAdmin
  if (!est) {
    if (!_estado) return
    if (!await _cargarEstado()) return
    est = _estado
  } else if (!est.epoch_ms) {
    const r = await supabase.rpc('rrhh_hora_lima'); if (r.data?.epoch_ms) _offsetMs = Number(r.data.epoch_ms) - Date.now()
  }
  const d = estadoDelDia(est)
  const disp = tiposDisponibles(est, d)
  const doc = [est.tipo_documento, est.nro_documento].filter(Boolean).join(' ')
  const marcasHtml = [
    est.entrada ? `🟢 Ingreso ${_hm(est.entrada)}` : '',
    ...(est.marcas || []).map(m => `${TIPOS_MARCA[m.tipo]?.icono || ''} ${TIPOS_MARCA[m.tipo]?.label?.split(' (')[0] || m.tipo} ${_hm(m.hora)}${m.nota ? ' · ' + _esc(m.nota) : ''}`),
    est.salida ? `🔴 Salida ${_hm(est.salida)}` : ''
  ].filter(Boolean)

  document.getElementById('modalMarcar')?.remove()
  clearInterval(_timer)
  const m = document.createElement('div')
  m.id = 'modalMarcar'; m.className = 'modal show'; m.style.zIndex = 3000
  m.innerHTML = `<div class="modal-content ui-moderna" style="width:min(94vw,440px); max-width:min(94vw,440px); padding:20px;">
    <div class="modal-header" style="padding:0 0 10px;"><h3 class="modal-title">🕐 Registrar marcación</h3>
      <button class="modal-close" id="mmCerrar">&times;</button></div>
    <div style="display:flex; flex-direction:column; gap:12px;">
      <div class="form-group" style="margin:0;"><label>Persona que marca</label>
        <input type="text" value="${_esc(est.nombre || '—')}${doc ? ' – ' + _esc(doc) : ''}" readonly style="font-weight:600;"></div>
      <div style="text-align:center; padding:10px; border-radius:12px; background:var(--bg-secondary); border:1px solid var(--border-color);">
        <div id="mmFecha" style="font-size:0.85rem; color:var(--text-secondary);"></div>
        <div id="mmReloj" style="font-size:2rem; font-weight:700; font-variant-numeric:tabular-nums;"></div>
        <small style="color:var(--text-secondary);">Hora oficial de Lima (la fija el servidor)</small>
      </div>
      ${disp.length ? `<div class="form-group" style="margin:0;"><label>¿Qué vas a marcar?</label>
        <select id="mmTipo">${disp.map(t => `<option value="${t}" ${t === d.siguiente ? 'selected' : ''}>${TIPOS_MARCA[t].icono} ${TIPOS_MARCA[t].label}${t === d.siguiente ? '  ← sugerido' : ''}</option>`).join('')}</select></div>
      <div class="form-group" id="mmNotaBox" style="margin:0; display:none;"><label>Nota *</label>
        <input type="text" id="mmNota" maxlength="120" placeholder="Ej: trámite en el banco, cita médica…"></div>` : '<div class="rr-aviso" style="margin:0;">La jornada de hoy ya está completa.</div>'}
      ${d.avisoAlmuerzo && d.siguiente !== 'almuerzo_salida' ? '' : ''}
      ${marcasHtml.length ? `<div style="font-size:0.85rem; color:var(--text-secondary); line-height:1.6;"><strong style="color:var(--text-primary);">Marcas de hoy</strong><br>${marcasHtml.join('<br>')}</div>` : ''}
    </div>
    <div style="display:flex; gap:8px; justify-content:flex-end; margin-top:16px;">
      <button class="btn btn-secondary btn-small" id="mmNo">Cancelar</button>
      ${disp.length ? '<button class="btn btn-primary btn-small" id="mmSi">✔ Confirmar marcación</button>' : ''}
    </div></div>`
  document.body.appendChild(m)
  const cerrar = () => { clearInterval(_timer); m.remove() }
  m.querySelector('#mmCerrar').onclick = cerrar; m.querySelector('#mmNo').onclick = cerrar
  m.addEventListener('click', e => { if (e.target === m) cerrar() })

  const pintarReloj = () => {
    const n = _ahora()
    m.querySelector('#mmReloj').textContent = n.toLocaleTimeString('es-PE', { hour12: false, timeZone: 'America/Lima' })
    m.querySelector('#mmFecha').textContent = n.toLocaleDateString('es-PE', { weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'America/Lima' })
  }
  pintarReloj(); _timer = setInterval(pintarReloj, 1000)
  if (!disp.length) return

  const sel = m.querySelector('#mmTipo'), notaBox = m.querySelector('#mmNotaBox')
  const alAlternar = () => { notaBox.style.display = sel.value === 'otro' ? '' : 'none' }
  sel.onchange = alAlternar; alAlternar()

  m.querySelector('#mmSi').onclick = async () => {
    const tipo = sel.value, nota = m.querySelector('#mmNota').value.trim()
    if (tipo === 'otro' && nota.length < 3) { m.querySelector('#mmNota').classList.add('invalido'); showToast('Escribe una nota para «Otro»', 'warning'); return }
    if (tipo === 'salida' && !d.almS && est.hora_salida && _minLimaAhora() < _toMin(_salidaHoy(est)) - 30 &&
        !confirm('Vas a marcar SALIDA DE LABORES antes de tu hora de salida y sin almuerzo. ¿Continuar?')) return
    const b = m.querySelector('#mmSi'); b.disabled = true
    const { data, error } = await supabase.rpc('rrhh_marcar', { p_empleado_id: est.empleado_id, p_tipo: tipo, p_nota: tipo === 'otro' ? nota : null })
    if (error) {
      b.disabled = false
      showToast(/schema cache|function .* does not exist|p_nota/.test(error.message) ? 'Falta ejecutar el SQL 158_rrhh_marcas_almuerzo.sql' : (error.message || 'No se pudo marcar'), 'danger'); return
    }
    cerrar()
    showToast(`${TIPOS_MARCA[tipo].label.split(' (')[0]} registrado a las ${data.hora_lima} (hora de Lima) ✔`, 'success', 6000)
    if (!empleadoAdmin) { await _cargarEstado(); _pintar() }
    window.dispatchEvent(new CustomEvent('asistencia:marcada', { detail: { empleado_id: est.empleado_id, tipo } }))
  }
}
window.abrirModalMarcar = abrirModalMarcar
