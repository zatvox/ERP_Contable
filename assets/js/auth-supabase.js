// ============================================================================
// AUTH-SUPABASE.JS - Autenticación ERP via Supabase Auth
// ============================================================================
// Usa supabase.auth.* (auth.users) + tabla public.agentes para el perfil.
// Misma tabla y patrón que el Task Manager — no se necesita erp_usuarios.
// No se necesita service_role key: el JWT del usuario autenticado habilita
// el rol 'authenticated' en las políticas RLS.
// ============================================================================

import { supabase } from './supabase-client.js'

let _userCache = null  // { id, email, nombre, foto_url, estado }

// ============================================================================
// INICIALIZACIÓN DE AUTH STATE
// Llamar una vez desde auth-init.js antes de cualquier uso
// ============================================================================

export async function initAuthState() {
  const { data: { session } } = await supabase.auth.getSession()

  if (session) {
    await _populateCache(session)
  }

  // IMPORTANTE: no se debe hacer ninguna llamada autenticada (supabase.from(),
  // supabase.auth.getSession(), etc.) de forma síncrona dentro del callback de
  // onAuthStateChange. GoTrueClient mantiene un lock exclusivo mientras
  // despacha el evento, y cualquier llamada anidada que intente re-adquirir
  // ese mismo lock (como el .from('users') de _populateCache) se queda
  // esperando para siempre → deadlock. Esto ocurre en cada login y también
  // cada vez que el token se auto-refresca en segundo plano, lo cual explica
  // por qué el guardado se colgaba de forma intermitente sin error en consola.
  // Fix recomendado por Supabase: diferir con setTimeout para salir del
  // contexto síncrono del callback antes de hacer la llamada anidada.
  supabase.auth.onAuthStateChange((event, session) => {
    if (session) {
      setTimeout(() => { _populateCache(session) }, 0)
    } else {
      _userCache = null
      if (!window.location.pathname.includes('login.html')) {
        window.location.href = 'login.html'
      }
    }
  })
}

async function _populateCache(session) {
  // Lee perfil desde public.users (vinculado por auth_id = auth.uid())
  const { data: perfil } = await supabase
    .from('users')
    .select('id, email, nombre, role, active')
    .eq('auth_id', session.user.id)
    .single()

  _userCache = {
    id:      session.user.id,           // UUID de auth.users
    db_id:   perfil?.id   || null,      // bigint de public.users (para FKs)
    email:   session.user.email,
    nombre:  perfil?.nombre || session.user.user_metadata?.nombre || session.user.email,
    role:    perfil?.role   || session.user.user_metadata?.role   || 'user',
    active:  perfil?.active ?? true
  }
}

// ============================================================================
// AUTENTICACIÓN
// ============================================================================

/**
 * Login con email y contraseña.
 * Retorna { success: true } o { success: false, message: '...' }
 */
export async function login(email, password) {
  try {
    const { data, error } = await supabase.auth.signInWithPassword({ email, password })

    if (error || !data.user) {
      const msg = error?.message === 'Invalid login credentials'
        ? 'Correo o contraseña incorrectos'
        : (error?.message || 'Error al iniciar sesión')
      return { success: false, message: msg }
    }

    await _populateCache(data.session)
    return { success: true }

  } catch (err) {
    console.error('Error en login:', err)
    return { success: false, message: 'Error de conexión' }
  }
}

/**
 * Obtener el usuario actual (sincrónico — usa el cache).
 * Cache poblado en initAuthState() antes de DOMContentLoaded.
 */
export function getCurrentUser() {
  return _userCache
}

/**
 * Verificar si hay sesión activa (sincrónico — usa el cache).
 */
export function isAuthenticated() {
  return _userCache !== null
}

/**
 * Logout — cierra sesión en Supabase y redirige a login.
 */
export async function logout() {
  _userCache = null
  await supabase.auth.signOut()
  window.location.href = 'login.html'
}
