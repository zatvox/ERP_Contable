// ============================================================================
// shared/perfil-contacto.js — Validación del perfil del contacto al guardar una
// factura de compra o de venta (2026-11-06).
// Regla: contacts.activo = NULL → el contacto llegó por IMPORTACIÓN MASIVA y nunca
// se consultó su RUC (Decolecta), así que no sabemos si es agente de retención.
// Con RUC (11 dígitos) NO deja guardar hasta completar el perfil:
//   · «Consultar RUC ahora» → trae estado/condición/agente de retención y marca activo
//   · «Abrir contacto»       → editar a mano en el modal único
// Se omite para: contactos sin RUC (DNI, extranjeros/no domiciliados) y activo=true/false.
// Uso:  if (!(await validarPerfilContacto(contactId, { rol: 'proveedor' }))) return
// ============================================================================
import { getContactById, updateContact } from '../supabase-data.js'
import { consultarRUC } from '../sunat-api.js'
import { showToast } from '../helpers.js'

const _esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

export function perfilIncompleto(c) {
  if (!c) return false
  const ruc = String(c.nro_documento || '').trim()
  if (c.tipo_documento !== 'RUC' || !/^\d{11}$/.test(ruc)) return false   // DNI / no domiciliado: no aplica
  return c.activo === null || c.activo === undefined
}

export async function validarPerfilContacto(contactId, { rol = 'proveedor' } = {}) {
  let c = null
  try { c = await getContactById(parseInt(contactId)) } catch (e) { console.warn('validarPerfilContacto', e); return true }
  if (!perfilIncompleto(c)) return true
  return new Promise(resolve => {
    const ov = document.createElement('div')
    ov.style.cssText = 'position:fixed;inset:0;z-index:100000;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;padding:16px'
    ov.innerHTML = `<div style="max-width:480px;width:100%;background:var(--bg-secondary,#1e293b);border:1px solid var(--border-color,#334155);border-radius:16px;padding:22px;box-shadow:0 20px 50px rgba(0,0,0,.5)">
      <h3 style="margin:0 0 8px">⚠️ Perfil del ${_esc(rol)} incompleto</h3>
      <p style="margin:0 0 6px"><b>${_esc(c.nombre)}</b> · RUC ${_esc(c.nro_documento)}</p>
      <p style="margin:0 0 16px;color:var(--text-secondary,#94a3b8);font-size:.9rem">Este contacto vino por importación masiva y nunca se consultó su RUC, por eso no sabemos si es agente de retención. Actualízalo antes de guardar el documento.</p>
      <div id="pcMsg" style="min-height:18px;font-size:.85rem;margin-bottom:10px"></div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end">
        <button class="btn" id="pcCancel">Cancelar</button>
        <button class="btn" id="pcAbrir">Abrir contacto</button>
        <button class="btn btn-primary" id="pcConsultar">🔎 Consultar RUC ahora</button>
      </div></div>`
    document.body.appendChild(ov)
    const cerrar = (ok) => { ov.remove(); resolve(ok) }
    ov.querySelector('#pcCancel').onclick = () => cerrar(false)
    ov.querySelector('#pcAbrir').onclick = async () => {
      cerrar(false)
      try { const m = await import('./contacto-modal.js'); m.abrirModalContacto({ id: c.id }); showToast('Actualiza el contacto y vuelve a guardar el documento', 'info') } catch (e) { console.warn(e) }
    }
    ov.querySelector('#pcConsultar').onclick = async (ev) => {
      const b = ev.currentTarget, msg = ov.querySelector('#pcMsg')
      b.disabled = true; b.textContent = 'Consultando…'
      try {
        const d = await consultarRUC(String(c.nro_documento).trim())
        if (!d || d.error) throw new Error(d?.error || 'Sin respuesta de SUNAT')
        const patch = { activo: true, estado: d.estado || null, condicion: d.condicion || null }
        if (typeof d.esAgenteRetencion === 'boolean') { patch.es_agente_retencion_sunat = d.esAgenteRetencion; patch.sujeto_retencion = d.esAgenteRetencion }
        if (typeof d.esBuenContribuyente === 'boolean') patch.es_buen_contribuyente = d.esBuenContribuyente
        const r = await updateContact(c.id, patch)
        if (!r) throw new Error('No se pudo guardar el contacto')
        showToast(`Perfil actualizado: ${d.estado || '—'} / ${d.condicion || '—'}`, 'success')
        cerrar(true)
      } catch (e) {
        msg.style.color = '#ef4444'; msg.textContent = 'No se pudo consultar: ' + (e.message || e) + '. Usa «Abrir contacto».'
        b.disabled = false; b.textContent = '🔎 Reintentar'
      }
    }
  })
}
window.validarPerfilContacto = validarPerfilContacto
