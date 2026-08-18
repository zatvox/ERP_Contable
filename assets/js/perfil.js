// ============================================================================
// PERFIL.JS — Mi Perfil (para todos los usuarios)
// ============================================================================
// Sustituye a "Usuarios" como módulo visible por defecto: cualquier usuario
// entra aquí a ver sus datos, cambiar su contraseña y ajustar sus preferencias
// de la aplicación. La gestión de usuarios (crear, asignar roles) sigue
// existiendo en usuarios.html, pero su enlace en el sidebar está marcado con
// `data-solo-admin` y solo se muestra si el rol es admin.
// ============================================================================

import { supabase } from './supabase-client.js'
import { getCurrentUser, logout } from './auth-supabase.js'
import { getVentas, getCompras, getJournalEntries } from './supabase-data.js'
import { showToast, formatNumber } from './helpers.js'
import { initModuleNavDropdowns } from './main.js'
import { renderConfiguracionTab, aplicarPreferenciasVista, getModuloConfig } from './config-modulo.js'
import { cacheado, invalidarTodo } from './data-cache.js'

const MODULO = 'perfil'

const MODULOS_DISPONIBLES = [
  { href: 'dashboard.html',    icono: '📊', label: 'Dashboard' },
  { href: 'inventario.html',   icono: '📦', label: 'Inventario' },
  { href: 'compras.html',      icono: '🛒', label: 'Compras' },
  { href: 'ventas.html',       icono: '📈', label: 'Ventas' },
  { href: 'cobranzas.html',    icono: '💰', label: 'Cuentas x Cobrar/Pagar' },
  { href: 'bancos.html',       icono: '🏦', label: 'Bancos' },
  { href: 'contabilidad.html', icono: '📑', label: 'Contabilidad' },
  { href: 'usuarios.html',     icono: '👤', label: 'Usuarios', soloAdmin: true }
]

let _user = null
let _actividadCargada = false

document.addEventListener('DOMContentLoaded', async () => {
  try {
    aplicarPreferenciasVista(MODULO)
    initTabs()
    initModuleNavDropdowns('#perfilTabs')

    await _esperarUsuario()
    pintarDatos()
    pintarAccesos()

    renderConfiguracionTab(MODULO, 'perfil-config-container', {
      onGuardar: () => showToast('Preferencias guardadas ✅', 'success')
    })

    const inputPwd = document.getElementById('nuevaPasswordPropia')
    if (inputPwd) inputPwd.addEventListener('input', evaluarFuerza)
  } catch (e) {
    console.error('perfil DOMContentLoaded:', e)
    showToast('Error al cargar el perfil: ' + e.message, 'danger')
  }
})

function initTabs() {
  const btns     = document.querySelectorAll('#perfilTabs .tab-btn')
  const contents = document.querySelectorAll('.tab-content')
  btns.forEach(btn => {
    btn.addEventListener('click', () => {
      btns.forEach(b => b.classList.remove('active'))
      contents.forEach(c => c.classList.remove('active'))
      btn.classList.add('active')
      const nombre = btn.getAttribute('data-tab')
      document.getElementById(`tab-${nombre}`)?.classList.add('active')
      if (nombre === 'actividad') cargarActividad()
    })
  })
}

// El cache de auth se llena de forma asíncrona; esperamos un momento antes de
// pintar para no mostrar "—" al usuario en la primera carga.
async function _esperarUsuario() {
  for (let i = 0; i < 40; i++) {
    _user = getCurrentUser()
    if (_user) return
    await new Promise(r => setTimeout(r, 120))
  }
}

// ============================================================================
// DATOS
// ============================================================================

function pintarDatos() {
  if (!_user) {
    _set('perfil-nombre-grande', 'Sesión no disponible')
    return
  }
  const nombre = _user.nombre || _user.email || 'Usuario'
  const iniciales = nombre.trim().split(/\s+/).slice(0, 2).map(p => p[0]).join('').toUpperCase()

  _set('perfil-avatar', iniciales || '?')
  _set('perfil-nombre-grande', nombre)
  _set('perfil-email-chico', _user.email || '')
  _set('userDisplay', nombre)

  const rol = String(_user.role || 'user').toLowerCase()
  const badge = document.getElementById('perfil-badge-rol')
  if (badge) {
    badge.textContent = _nombreRol(rol)
    badge.className = 'badge ' + (rol === 'admin' ? 'badge-danger' : rol === 'contador' ? 'badge-warning' : 'badge-info')
  }

  _valor('perfilNombre', _user.nombre || '')
  _valor('perfilEmail', _user.email || '')
  _valor('perfilRol', _nombreRol(rol))

  _set('perfil-sesion-info', `${_user.email || ''} · ${_user.active === false ? 'Cuenta inactiva' : 'Cuenta activa'}`)
}

function _nombreRol(rol) {
  return ({ admin: 'Administrador (acceso total)', contador: 'Contador', user: 'Usuario' })[rol] || rol
}

function pintarAccesos() {
  const cont = document.getElementById('perfil-accesos')
  if (!cont) return
  const esAdmin = String(_user?.role || '').toLowerCase() === 'admin'
  cont.innerHTML = MODULOS_DISPONIBLES
    .filter(m => !m.soloAdmin || esAdmin)
    .map(m => `
      <a href="${m.href}" class="card" style="padding:12px; text-align:center; text-decoration:none; color:inherit; display:block;">
        <div style="font-size:1.5rem;">${m.icono}</div>
        <div style="font-size:0.8rem; margin-top:4px;">${m.label}</div>
      </a>`).join('')
}

window.guardarPerfil = async function() {
  try {
    const nombre = document.getElementById('perfilNombre')?.value?.trim()
    if (!nombre) { showToast('El nombre no puede estar vacío', 'warning'); return }
    if (!_user?.db_id) { showToast('No se pudo identificar tu usuario en la base de datos', 'danger'); return }

    const { error } = await supabase.from('users').update({ nombre }).eq('id', _user.db_id)
    if (error) throw error

    // Se refleja también en el metadata de Auth para que otras pantallas que
    // leen del token muestren el nombre nuevo sin esperar a recargar el perfil.
    await supabase.auth.updateUser({ data: { nombre } })

    _user.nombre = nombre
    pintarDatos()
    const msg = document.getElementById('perfil-guardado-msg')
    if (msg) { msg.style.display = 'inline'; setTimeout(() => { msg.style.display = 'none' }, 2500) }
    showToast('Perfil actualizado ✅', 'success')
  } catch (e) {
    console.error('guardarPerfil:', e)
    showToast('Error al guardar: ' + e.message, 'danger')
  }
}

// ============================================================================
// SEGURIDAD
// ============================================================================

function evaluarFuerza() {
  const v = document.getElementById('nuevaPasswordPropia')?.value || ''
  const el = document.getElementById('password-fuerza')
  if (!el) return
  if (!v) { el.textContent = ''; return }

  let puntos = 0
  if (v.length >= 8)  puntos++
  if (v.length >= 12) puntos++
  if (/[A-Z]/.test(v) && /[a-z]/.test(v)) puntos++
  if (/\d/.test(v))   puntos++
  if (/[^A-Za-z0-9]/.test(v)) puntos++

  const niveles = [
    { txt: 'Muy débil', color: 'var(--color-danger)' },
    { txt: 'Débil', color: 'var(--color-danger)' },
    { txt: 'Aceptable', color: 'var(--color-warning)' },
    { txt: 'Buena', color: 'var(--color-info)' },
    { txt: 'Fuerte', color: 'var(--color-success)' },
    { txt: 'Muy fuerte', color: 'var(--color-success)' }
  ]
  const n = niveles[puntos]
  el.innerHTML = `Seguridad: <strong style="color:${n.color};">${n.txt}</strong>${v.length < 8 ? ' — mínimo 8 caracteres' : ''}`
}

window.cambiarPasswordPropia = async function() {
  const nueva     = document.getElementById('nuevaPasswordPropia')?.value || ''
  const confirmar = document.getElementById('confirmarPasswordPropia')?.value || ''

  if (nueva.length < 8)      { showToast('La contraseña debe tener al menos 8 caracteres.', 'warning'); return }
  if (nueva !== confirmar)   { showToast('Las contraseñas no coinciden.', 'warning'); return }

  try {
    const { error } = await supabase.auth.updateUser({ password: nueva })
    if (error) throw error
    showToast('Contraseña actualizada correctamente ✅', 'success')
    _valor('nuevaPasswordPropia', '')
    _valor('confirmarPasswordPropia', '')
    _set('password-fuerza', '')
  } catch (e) {
    showToast('Error: ' + e.message, 'danger')
  }
}

window.limpiarDatosLocales = function() {
  if (!confirm('¿Borrar tus preferencias guardadas en este navegador (tema, densidad, filtros y caché)?\n\nTus datos del sistema NO se tocan.')) return
  try {
    invalidarTodo()
    Object.keys(localStorage)
      .filter(k => k.startsWith('jhiro_config_') || k === 'erp_theme' || k === 'erp_sidebar_collapsed')
      .forEach(k => localStorage.removeItem(k))
    showToast('Datos locales limpiados. Recargando...', 'success')
    setTimeout(() => location.reload(), 1200)
  } catch (e) {
    showToast('Error: ' + e.message, 'danger')
  }
}

window.logout = logout

// ============================================================================
// ACTIVIDAD
// ============================================================================

async function cargarActividad() {
  if (_actividadCargada) return
  _actividadCargada = true
  const cont = document.getElementById('perfil-actividad-tabla')

  try {
    const miId = _user?.db_id
    const [ventas, compras, asientos] = await Promise.all([
      cacheado('ventas', getVentas),
      cacheado('compras', getCompras),
      cacheado('asientos', getJournalEntries)
    ])

    const mias = (arr) => (arr || []).filter(x => miId && (x.created_by === miId || x.user_id === miId))
    const misVentas   = mias(ventas)
    const misCompras  = mias(compras)
    const misAsientos = mias(asientos)

    _set('kpi-act-ventas',   String(misVentas.length))
    _set('kpi-act-compras',  String(misCompras.length))
    _set('kpi-act-asientos', String(misAsientos.length))

    const registros = [
      ...misVentas.map(v  => ({ tipo: 'Venta',   doc: `${v.serie || ''}-${v.numero || v.numero_documento || ''}`, fecha: v.fecha_emision || v.fecha || '', monto: parseFloat(v.total || 0), destino: 'ventas.html' })),
      ...misCompras.map(c => ({ tipo: 'Compra',  doc: `${c.serie || ''}-${c.numero || ''}`, fecha: c.fecha_emision || '', monto: parseFloat(c.total || 0), destino: 'compras.html' })),
      ...misAsientos.map(a => ({ tipo: 'Asiento', doc: a.numero || a.numero_asiento || `#${a.id}`, fecha: a.fecha || '', monto: parseFloat(a.total_debe || a.total || 0), destino: 'contabilidad.html' }))
    ].sort((x, y) => (y.fecha || '').localeCompare(x.fecha || '')).slice(0, 40)

    _set('kpi-act-ultimo', registros[0]?.fecha || 'Sin registros')

    if (!cont) return
    if (registros.length === 0) {
      cont.innerHTML = `<p class="reporte-vacio">Todavía no hay registros creados por tu usuario.${miId ? '' : '<br><small>No se pudo identificar tu ID en la base de datos.</small>'}</p>`
      return
    }

    cont.innerHTML = `
      <table>
        <thead><tr><th>Fecha</th><th>Tipo</th><th>Documento</th><th style="text-align:right;">Monto</th><th></th></tr></thead>
        <tbody>
          ${registros.map(r => `<tr>
            <td>${r.fecha || '-'}</td>
            <td><span class="badge badge-info">${r.tipo}</span></td>
            <td>${_esc(r.doc)}</td>
            <td style="text-align:right;">${formatNumber(r.monto)}</td>
            <td><a href="${r.destino}" class="btn btn-small btn-secondary">Ir al módulo</a></td>
          </tr>`).join('')}
        </tbody>
      </table>`
  } catch (e) {
    console.error('cargarActividad:', e)
    if (cont) cont.innerHTML = `<p class="reporte-vacio">No se pudo cargar la actividad: ${_esc(e.message)}</p>`
  }
}

// ============================================================================
// UTILIDADES
// ============================================================================

function _set(id, txt)   { const el = document.getElementById(id); if (el) el.textContent = txt }
function _valor(id, v)   { const el = document.getElementById(id); if (el) el.value = v }
function _esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

void getModuloConfig
