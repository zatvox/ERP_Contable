// ============================================================================
// AUTH-SUPABASE.JS - Autenticación para JHIRO ERP V3
// ============================================================================

import { supabase, getAll, insert, update } from './supabase-client.js'

const AUTH_KEY = 'erp_user_session'

// ============================================================================
// AUTENTICACIÓN
// ============================================================================

/**
 * Login: verifica usuario en tabla users
 */
export async function login(username, password) {
  try {
    const { data, error } = await supabase
      .from('users')
      .select('*')
      .eq('username', username)
      .eq('password_hash', password)
      .single()

    if (error || !data) {
      console.error('Login error:', error)
      return false
    }

    // Guardar sesión
    const session = {
      userId: data.id,
      username: data.username,
      nombre: data.nombre,
      email: data.email,
      role: data.role,
      loginAt: new Date().toISOString()
    }

    localStorage.setItem(AUTH_KEY, JSON.stringify(session))
    return true
  } catch (error) {
    console.error('Error en login:', error)
    return false
  }
}

/**
 * Obtener usuario actual
 */
export function getCurrentUser() {
  const session = localStorage.getItem(AUTH_KEY)
  if (!session) {
    window.location.href = 'login.html'
    return null
  }
  return JSON.parse(session)
}

/**
 * Logout
 */
export function logout() {
  localStorage.removeItem(AUTH_KEY)
  window.location.href = 'login.html'
}

/**
 * Verificar si está autenticado
 */
export function isAuthenticated() {
  return !!localStorage.getItem(AUTH_KEY)
}

/**
 * Cambiar contraseña
 */
export async function changePassword(currentPassword, newPassword) {
  try {
    const user = getCurrentUser()
    if (!user) return false

    // Obtener usuario actual de BD
    const { data, error: fetchError } = await supabase
      .from('users')
      .select('*')
      .eq('id', user.userId)
      .single()

    if (fetchError || data.password_hash !== currentPassword) {
      return false
    }

    // Actualizar contraseña
    const { error: updateError } = await supabase
      .from('users')
      .update({ password_hash: newPassword })
      .eq('id', user.userId)

    return !updateError
  } catch (error) {
    console.error('Error en changePassword:', error)
    return false
  }
}

/**
 * Crear nuevo usuario (solo admin)
 */
export async function createUser(userData) {
  try {
    const result = await insert('users', {
      username: userData.username,
      password_hash: userData.password,
      nombre: userData.nombre,
      email: userData.email,
      role: userData.role || 'user',
      active: true
    })

    return result ? true : false
  } catch (error) {
    console.error('Error creando usuario:', error)
    return false
  }
}

/**
 * Obtener todos los usuarios (admin)
 */
export async function getUsers() {
  try {
    const { data, error } = await supabase
      .from('users')
      .select('*')

    if (error) {
      console.error('Error fetching users:', error)
      return []
    }

    return data || []
  } catch (error) {
    console.error('Error en getUsers:', error)
    return []
  }
}

// ============================================================================
// REDIRECCIÓN AUTOMÁTICA
// ============================================================================

if (!isAuthenticated() && !window.location.pathname.includes('login.html')) {
  window.location.href = 'login.html'
}
