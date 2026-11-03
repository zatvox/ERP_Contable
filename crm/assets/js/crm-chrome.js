// Detalles del CRM sobre el diseño JHIRO: color de empresa, selector de empresa,
// accesos internos (Panel / ERP) y textos configurables desde Configuración.
import { initCtx } from './web-data.js'

const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const { empresas, emp, staff } = await initCtx()

if (emp?.color) document.documentElement.style.setProperty('--emp', emp.color)

const actions = document.querySelector('.nav__actions')
if (actions && empresas.length > 1) {
  const w = document.createElement('div'); w.className = 'emp-pills'
  w.innerHTML = empresas.map(e => `<button type="button" class="emp-pill" style="--c:${esc(e.color)}" aria-pressed="${e.id === emp?.id}" data-emp="${e.id}" title="${esc(e.nombre_comercial)}">${esc(e.codigo || e.nombre_comercial)}</button>`).join('')
  actions.prepend(w)
  w.onclick = ev => {
    const b = ev.target.closest('[data-emp]'); if (!b) return
    try { localStorage.setItem('crm_emp', b.dataset.emp) } catch { /* ok */ }
    const u = new URL(location.href); u.searchParams.delete('id'); u.searchParams.set('emp', b.dataset.emp); location.href = u.toString()
  }
}

const links = document.getElementById('nav-links')
if (links && staff) {
  links.insertAdjacentHTML('beforeend',
    `<li><a href="panel.html?emp=${emp?.id ?? ''}" class="nav__link nav__link--int">Panel CRM</a></li><li><a href="../dashboard.html" class="nav__link nav__link--int">ERP</a></li>`)
}

// textos configurables (Panel → Configuración)
const t = document.getElementById('products-title')
if (t && emp?.titulo) t.textContent = emp.titulo
const p = t?.closest('.section-header')?.querySelector('p')
if (p && emp?.mensaje) p.textContent = emp.mensaje

// WhatsApp configurado → enlaces con data-wsp o wa.me
const wa = String(emp?.whatsapp || '').replace(/\D/g, '')
if (wa) document.querySelectorAll('a[href^="https://wa.me/"]').forEach(a => { a.href = `https://wa.me/${wa}` })
