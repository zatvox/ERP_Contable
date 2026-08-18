// ============================================================================
// USUARIOS.JS — Gestión de usuarios del sistema
// ============================================================================
// Crea usuarios en auth.users vía supabase.auth.signUp() (envía email de
// confirmación). Al confirmar, el trigger fn_on_auth_user_created crea el
// registro en public.users automáticamente.
// ============================================================================

import { supabase } from './supabase-client.js'
import { getCurrentUser } from './auth-supabase.js'
import { showToast } from './helpers.js'

// ============================================================================
// INIT
// ============================================================================

document.addEventListener('DOMContentLoaded', async () => {
  // El cache de auth se puebla de forma asíncrona (auth-init.js). Si se leyera
  // de inmediato, `user` sería null y el guard de abajo se saltaría, dejando
  // entrar a cualquiera que escriba la URL a mano. Por eso esperamos a que el
  // perfil esté disponible antes de decidir.
  let user = getCurrentUser()
  for (let i = 0; i < 40 && !user; i++) {
    await new Promise(r => setTimeout(r, 120))
    user = getCurrentUser()
  }

  // Solo admins pueden ver este módulo
  if (!user || String(user.role || '').toLowerCase() !== 'admin') {
    document.querySelector('.content').innerHTML = `
      <div class="card" style="padding:40px; text-align:center;">
        <h2 style="color:var(--color-danger)">Acceso restringido</h2>
        <p>Solo los administradores pueden gestionar usuarios.</p>
        <a href="dashboard.html" class="btn btn-primary" style="margin-top:16px;">Ir al Dashboard</a>
      </div>`
    return
  }

  await window.cargarUsuarios()
})

// ============================================================================
// LISTAR USUARIOS
// ============================================================================

window.cargarUsuarios = async function () {
  const contenedor = document.getElementById('tabla-usuarios')
  contenedor.innerHTML = '<p style="text-align:center; color:var(--text-secondary);">Cargando...</p>'

  try {
    // Solo admins ven todos — RLS lo garantiza en public.users
    const { data: usuarios, error } = await supabase
      .from('users')
      .select('id, email, nombre, role, active, created_at')
      .order('id', { ascending: true })

    if (error) throw error

    if (!usuarios || usuarios.length === 0) {
      contenedor.innerHTML = '<p style="text-align:center; color:var(--text-secondary); padding:20px;">No hay usuarios registrados.</p>'
      return
    }

    const html = `
      <table class="tabla-datos" style="font-size:0.9rem;">
        <thead>
          <tr>
            <th>#</th>
            <th>Nombre</th>
            <th>Email</th>
            <th>Rol</th>
            <th>Estado</th>
            <th>Creado</th>
          </tr>
        </thead>
        <tbody>
          ${usuarios.map(u => `
            <tr>
              <td>${u.id}</td>
              <td>${_esc(u.nombre || '-')}</td>
              <td>${_esc(u.email || '-')}</td>
              <td><span class="badge badge-${_badgeRole(u.role)}">${_labelRole(u.role)}</span></td>
              <td>
                ${u.active
                  ? '<span class="badge badge-success">Activo</span>'
                  : '<span class="badge badge-danger">Inactivo</span>'}
              </td>
              <td>${u.created_at ? new Date(u.created_at).toLocaleDateString('es-PE') : '-'}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>`

    contenedor.innerHTML = html

  } catch (err) {
    console.error('Error cargando usuarios:', err)
    contenedor.innerHTML = `
      <div style="padding:16px; color:var(--color-danger);">
        Error: ${err.message || 'No se pudo cargar la lista de usuarios'}
        ${err.message?.includes('policy') || err.code === '42501'
          ? '<br><small>Verifica que ejecutaste 05_usuarios.sql y que tienes política RLS para admin.</small>'
          : ''}
      </div>`
  }
}

// ============================================================================
// CREAR USUARIO
// ============================================================================

window.crearUsuario = async function () {
  const nombre   = document.getElementById('nuevoNombre').value.trim()
  const email    = document.getElementById('nuevoEmail').value.trim()
  const password = document.getElementById('nuevoPassword').value
  const role     = document.getElementById('nuevoRole').value

  const errDiv = document.getElementById('crear-usuario-error')
  const okDiv  = document.getElementById('crear-usuario-ok')
  const btn    = document.getElementById('btnCrearUsuario')

  errDiv.style.display = 'none'
  okDiv.style.display  = 'none'

  // Validaciones
  if (!nombre) return _showError(errDiv, 'El nombre es obligatorio.')
  if (!email)  return _showError(errDiv, 'El correo electrónico es obligatorio.')
  if (!_validEmail(email)) return _showError(errDiv, 'Ingresa un correo válido.')
  if (password.length < 8) return _showError(errDiv, 'La contraseña debe tener al menos 8 caracteres.')

  btn.disabled    = true
  btn.textContent = 'Creando usuario...'

  try {
    // signUp crea en auth.users + envía email de confirmación
    // El trigger fn_on_auth_user_created creará el registro en public.users
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: { nombre, role }   // → raw_user_meta_data (disponible en trigger)
      }
    })

    if (error) throw error

    const user = data?.user
    const confirmacionRequerida = !user?.confirmed_at && !user?.email_confirmed_at

    okDiv.innerHTML = confirmacionRequerida
      ? `✅ Usuario <strong>${_esc(nombre)}</strong> creado exitosamente.<br>
         Se envió un correo de confirmación a <strong>${_esc(email)}</strong>.<br>
         <small>El usuario deberá confirmar su correo antes de iniciar sesión.</small>`
      : `✅ Usuario <strong>${_esc(nombre)}</strong> creado e inmediatamente activo.<br>
         <small>(Confirmación de email desactivada en Supabase — modo desarrollo)</small>`

    okDiv.style.display = 'block'

    // Limpiar campos
    document.getElementById('nuevoNombre').value    = ''
    document.getElementById('nuevoEmail').value     = ''
    document.getElementById('nuevoPassword').value  = ''
    document.getElementById('nuevoRole').value      = 'user'

    // Recargar lista
    await window.cargarUsuarios()

  } catch (err) {
    console.error('Error creando usuario:', err)

    let msg = err.message || 'Error al crear usuario'
    if (msg.includes('already registered') || msg.includes('already been registered')) {
      msg = 'Este correo ya está registrado.'
    } else if (msg.includes('invalid email')) {
      msg = 'El correo ingresado no es válido.'
    } else if (msg.includes('Password')) {
      msg = 'La contraseña no cumple los requisitos de Supabase (mínimo 8 caracteres).'
    } else if (msg.includes('signup is disabled')) {
      msg = 'El registro de nuevos usuarios está desactivado en Supabase.<br>' +
            '<small>Ve a Authentication → Settings → desactiva "Disable sign ups".</small>'
    }

    _showError(errDiv, msg)
  } finally {
    btn.disabled    = false
    btn.textContent = '✉️ Crear Usuario y Enviar Invitación'
  }
}

// ============================================================================
// CAMBIAR CONTRASEÑA PROPIA
// ============================================================================

window.cambiarPasswordPropia = async function () {
  const nueva    = document.getElementById('nuevaPasswordPropia').value
  const confirmar = document.getElementById('confirmarPasswordPropia').value

  if (nueva.length < 8) {
    showToast('La contraseña debe tener al menos 8 caracteres.', 'error')
    return
  }
  if (nueva !== confirmar) {
    showToast('Las contraseñas no coinciden.', 'error')
    return
  }

  const { error } = await supabase.auth.updateUser({ password: nueva })

  if (error) {
    showToast('Error: ' + error.message, 'error')
    return
  }

  showToast('Contraseña actualizada correctamente.', 'success')
  document.getElementById('nuevaPasswordPropia').value  = ''
  document.getElementById('confirmarPasswordPropia').value = ''
}

// ============================================================================
// UTILIDADES UI
// ============================================================================

window.togglePassword = function () {
  const input = document.getElementById('nuevoPassword')
  input.type = input.type === 'password' ? 'text' : 'password'
}

function _showError(el, msg) {
  el.innerHTML = '⚠️ ' + msg
  el.style.display = 'block'
}

function _validEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
}

function _esc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function _badgeRole(role) {
  const map = { admin: 'primary', contador: 'info', user: 'secondary' }
  return map[role] || 'secondary'
}

function _labelRole(role) {
  const map = { admin: 'Admin', contador: 'Contador', user: 'Usuario' }
  return map[role] || role || 'Usuario'
}
