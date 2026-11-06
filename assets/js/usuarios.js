// ============================================================================
// USUARIOS.JS — Altas/ediciones de usuarios del sistema (tab de RRHH, rediseño 2026-11-05)
// La lista (tabla estándar) y las acciones de activar/eliminar viven en rrhh.js.
// Crea usuarios con supabase.auth.signUp() usando un cliente TEMPORAL sin sesión:
// así, si Supabase no exige confirmar el correo, el administrador NO queda logueado
// como el usuario nuevo. El trigger fn_on_auth_user_created crea la fila en public.users.
// ============================================================================
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.39.3/+esm'
import { SUPABASE_CONFIG } from './config.js'
import { supabase, update } from './supabase-client.js'
import { showToast } from './helpers.js'

const $ = id => document.getElementById(id)
const _esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
const _validEmail = e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)

function _msg(id, html, ok = false) {
  ['crear-usuario-error', 'crear-usuario-ok'].forEach(x => { $(x).style.display = 'none' })
  if (!html) return
  const el = $(ok ? 'crear-usuario-ok' : 'crear-usuario-error')
  el.innerHTML = html; el.style.display = 'block'
}

// id = null → nuevo usuario; id → editar nombre/rol (el correo no se cambia aquí)
window.abrirModalUsuario = async function (id = null) {
  window.cerrarMenuAcciones?.()
  _msg('')
  let u = null
  if (id) u = (await supabase.from('users').select('id, email, nombre, role, active').eq('id', id).single()).data
  $('usuId').value = u?.id || ''
  $('usuModalTitulo').textContent = u ? 'Editar usuario' : 'Nuevo usuario'
  $('nuevoNombre').value = u?.nombre || ''
  $('nuevoEmail').value = u?.email || ''; $('nuevoEmail').disabled = !!u
  $('nuevoPassword').value = ''; $('usuGrpPass').style.display = u ? 'none' : ''
  $('nuevoRole').value = u?.role === 'admin' ? 'admin' : (u?.role || 'oficina')
  $('nuevoRole').disabled = u?.role === 'admin'      // el rol admin solo se toca en la base de datos
  window.openModal('modal-usuario')
}

window.guardarUsuario = async function () {
  const id = Number($('usuId').value || 0)
  const nombre = $('nuevoNombre').value.trim()
  const email = $('nuevoEmail').value.trim()
  const password = $('nuevoPassword').value
  const role = $('nuevoRole').value
  ;['nuevoNombre', 'nuevoEmail', 'nuevoPassword'].forEach(x => $(x).classList.remove('invalido'))
  const faltan = []
  if (!nombre) faltan.push('nuevoNombre')
  if (!id && !_validEmail(email)) faltan.push('nuevoEmail')
  if (!id && password.length < 8) faltan.push('nuevoPassword')
  if (faltan.length) { faltan.forEach(x => $(x).classList.add('invalido')); _msg('⚠️ Revisa los campos marcados en rojo (*): nombre, correo válido y contraseña de 8+ caracteres.'); return }

  const btn = $('btnCrearUsuario'); btn.disabled = true
  try {
    if (id) {
      const cambios = { nombre }
      if (!$('nuevoRole').disabled) cambios.role = role
      if (!await update('users', id, cambios)) throw new Error('no se pudo guardar')
      showToast('Usuario actualizado ✔', 'success')
    } else {
      const temp = createClient(SUPABASE_CONFIG.URL, SUPABASE_CONFIG.ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } })
      const { data, error } = await temp.auth.signUp({ email, password, options: { data: { nombre, role } } })
      if (error) throw error
      const pendiente = !data?.user?.confirmed_at && !data?.user?.email_confirmed_at
      showToast(pendiente ? 'Usuario creado: debe confirmar su correo para entrar' : 'Usuario creado y activo ✔', 'success')
    }
    window.closeModal('modal-usuario')
    await window.cargarUsuarios?.()
  } catch (err) {
    let m = err.message || 'Error al guardar el usuario'
    if (/already (been )?registered/i.test(m)) m = 'Este correo ya está registrado.'
    else if (/invalid email/i.test(m)) m = 'El correo ingresado no es válido.'
    else if (/signup is disabled/i.test(m)) m = 'El registro está desactivado en Supabase (Authentication → Settings → «Disable sign ups»).'
    _msg('⚠️ ' + _esc(m))
  } finally { btn.disabled = false }
}

window.cambiarPasswordPropia = async function () {
  const nueva = $('nuevaPasswordPropia').value, confirmar = $('confirmarPasswordPropia').value
  if (nueva.length < 8) { showToast('La contraseña debe tener al menos 8 caracteres.', 'warning'); return }
  if (nueva !== confirmar) { showToast('Las contraseñas no coinciden.', 'warning'); return }
  const { error } = await supabase.auth.updateUser({ password: nueva })
  if (error) { showToast('Error: ' + error.message, 'danger'); return }
  showToast('Contraseña actualizada ✔', 'success')
  $('nuevaPasswordPropia').value = ''; $('confirmarPasswordPropia').value = ''
  window.closeModal('modal-password')
}

window.togglePassword = function () { const i = $('nuevoPassword'); i.type = i.type === 'password' ? 'text' : 'password' }
