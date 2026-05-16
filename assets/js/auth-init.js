// ============================================================================
// AUTH-INIT.JS - Inicialización de autenticación global
// ============================================================================
// Este archivo se carga en TODAS las páginas y maneja:
// - Validación de sesión
// - Redirección automática si no está autenticado
// - Expone funciones globales (logout, getCurrentUser)
// ============================================================================

import { login as supabaseLogin, logout as supabaseLogout, getCurrentUser as getSupabaseUser, isAuthenticated } from './auth-supabase.js'

const AUTH_KEY = 'erp_user_session'

// ============================================================================
// FUNCIONES GLOBALES - Disponibles en window para ser usadas desde HTML
// ============================================================================

/**
 * Login global - wrapper de auth-supabase
 */
window.login = async function(username, password) {
  try {
    const result = await supabaseLogin(username, password)
    return result
  } catch (error) {
    console.error('Error en login global:', error)
    return false
  }
}

/**
 * Logout global - wrapper de auth-supabase
 */
window.logout = function() {
  supabaseLogout()
}

/**
 * Obtener usuario actual
 */
window.getCurrentUser = function() {
  return getSupabaseUser()
}

/**
 * Verificar autenticación
 */
window.isUserAuthenticated = function() {
  return isAuthenticated()
}

// ============================================================================
// VALIDACIÓN AUTOMÁTICA DE SESIÓN
// ============================================================================

function validateSessionAndRedirect() {
  const currentPage = window.location.pathname.split('/').pop() || 'dashboard.html'
  const isLoginPage = currentPage === 'login.html' || currentPage === ''
  
  // Si es la página de login, no hacer validación
  if (isLoginPage) {
    return
  }
  
  // Si no está autenticado y no es login, redirigir
  if (!isAuthenticated()) {
    console.warn('Sesión no válida, redirigiendo a login...')
    window.location.href = 'login.html'
    return
  }
  
  // Si está autenticado, cargar datos del usuario en la UI
  const user = getSupabaseUser()
  if (user) {
    const userDisplay = document.getElementById('userDisplay')
    if (userDisplay) {
      userDisplay.textContent = user.nombre || user.username || 'Usuario'
    }
  }
}

// ============================================================================
// INICIALIZACIÓN
// ============================================================================

// Validar sesión cuando el DOM esté listo
document.addEventListener('DOMContentLoaded', () => {
  validateSessionAndRedirect()
})

// También validar inmediatamente si el DOM ya está listo
if (document.readyState === 'loading') {
  // DOM aún cargando, esperar DOMContentLoaded
} else {
  // DOM ya está listo
  validateSessionAndRedirect()
}

console.log('✅ Auth-init cargado correctamente')
