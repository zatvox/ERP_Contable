// ============================================================================
// AUTH-INIT.JS - Inicialización global de autenticación
// ============================================================================
// Se carga en TODAS las páginas. Usa top-level await para restaurar la
// sesión de Supabase Auth (localStorage) ANTES de que DOMContentLoaded
// dispare, garantizando que getCurrentUser() ya funciona sincrónicamente
// en los módulos de cada página.
// ============================================================================

import {
  initAuthState,
  login      as supabaseLogin,
  logout     as supabaseLogout,
  getCurrentUser,
  isAuthenticated
} from './auth-supabase.js'

// Top-level await — restaura sesión antes de que el DOM esté listo
await initAuthState()

// ── Funciones globales ────────────────────────────────────────────────────────

/** Login global — retorna { success, message } */
window.login = async function(email, password) {
  return await supabaseLogin(email, password)
}

window.logout = function() {
  supabaseLogout()
}

window.getCurrentUser = function() {
  return getCurrentUser()
}

window.isUserAuthenticated = function() {
  return isAuthenticated()
}

// ── Validar sesión al cargar la página ───────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  const pagina = window.location.pathname.split('/').pop() || 'dashboard.html'
  const esLogin = pagina === 'login.html' || pagina === ''

  if (esLogin) return

  if (!isAuthenticated()) {
    console.warn('Sin sesión activa — redirigiendo a login...')
    window.location.href = 'login.html'
    return
  }

  // Mostrar nombre del usuario en el header
  const user = getCurrentUser()
  if (user) {
    const el = document.getElementById('userDisplay')
    if (el) el.textContent = user.nombre || user.email || 'Usuario'
  }
})

console.log('✅ Auth-init cargado')
