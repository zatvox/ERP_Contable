// init.js — arranque de tareas.html (usa el cliente y el contexto multiempresa reales del ERP).
import { supabase, esperarContextoEmpresa, empresasActivasCtx, empresaTrabajoCtx } from '../supabase-client.js'
import { getCurrentUser } from '../auth-supabase.js'
import { setClient } from './tareas-data.js'
import { iniciar } from './tareas-ui.js'

async function esperarUsuario() { for (let i = 0; i < 40 && !getCurrentUser(); i++) await new Promise(r => setTimeout(r, 150)); return getCurrentUser() }

document.addEventListener('DOMContentLoaded', async () => {
  try {
    setClient(supabase)
    await esperarUsuario()
    try { await esperarContextoEmpresa() } catch (_) { /* sin multiempresa */ }
    const activas = (empresasActivasCtx() || []).map(Number).filter(Boolean)
    await iniciar({ empresaId: Number(empresaTrabajoCtx()) || activas[0] || 1, empresas: activas.length ? activas : null })
  } catch (e) { console.error('tareas init:', e); document.getElementById('tk-lista').innerHTML = '<p class="tk-vacio">No se pudo cargar Tareas: ' + e.message + '</p>' }
})
