// ============================================================================
// tenant-switch.js — Cambiar de tenant (cliente) sin cerrar sesión (SQL 167).
// Solo aparece si tu cuenta tiene acceso a 2+ tenants (contador, superadmin).
// Un tenant a la vez: al cambiar se limpia el contexto local y se recarga el ERP.
// ============================================================================
import { supabase } from '../supabase-client.js'

const CLAVES_LS = ['jhiro_empresas_activas', 'jhiro_empresa_trabajo', 'jhiro_ambito_familiar']

export function limpiarContextoLocal() {
  try {
    for (const base of CLAVES_LS) {
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const k = localStorage.key(i)
        if (k && k.startsWith(base)) localStorage.removeItem(k)      // incluye variantes por usuario (_claveLS)
      }
    }
    for (let i = sessionStorage.length - 1; i >= 0; i--) {
      const k = sessionStorage.key(i)
      if (k && k.startsWith('jhiro_cache_')) sessionStorage.removeItem(k)
    }
  } catch { /* storage bloqueado: se ignora */ }
}

export async function listarMisTenants() {
  const { data, error } = await supabase.rpc('mis_tenants')
  return error ? [] : (data || [])
}

export async function cambiarTenant(id) {
  const { data, error } = await supabase.rpc('cambiar_tenant', { p_tenant: id })
  if (error) throw new Error(error.message)
  limpiarContextoLocal()
  return data
}

export async function initTenantSwitch() {
  const caja = document.querySelector('.sidebar-user')
  if (!caja || document.getElementById('tenantSwitch')) return
  const lista = (await listarMisTenants()).filter(t => t.activo)
  if (lista.length < 2) return
  const wrap = document.createElement('div')
  wrap.id = 'tenantSwitch'
  wrap.style.cssText = 'margin:6px 0'
  wrap.innerHTML = '<label style="display:block;font-size:.7rem;opacity:.7">Cliente (tenant)</label>' +
    '<select style="width:100%;font-size:.8rem">' +
    lista.map(t => `<option value="${t.tenant_id}" ${t.actual ? 'selected' : ''}>${String(t.nombre).replace(/[<>&"]/g, '')}</option>`).join('') + '</select>'
  const sel = wrap.querySelector('select')
  sel.onchange = async () => {
    sel.disabled = true
    try { await cambiarTenant(Number(sel.value)); location.href = 'dashboard.html' }
    catch (e) { alert('No se pudo cambiar: ' + e.message); sel.disabled = false; location.reload() }
  }
  caja.insertBefore(wrap, caja.querySelector('.btn-logout'))
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => setTimeout(initTenantSwitch, 600))
else setTimeout(initTenantSwitch, 600)
