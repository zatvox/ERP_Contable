// Marca del catálogo público: todo sale de la empresa del código (?c=). Sin selector de empresas,
// sin accesos al ERP ni al panel: esta página es solo la vista del cliente final.
import { initCtx } from './web-data.js'

const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const { emp } = await initCtx()

// Sin código válido: pantalla neutra (no revela empresas ni rutas internas)
if (!emp) {
  document.title = 'Catálogo no disponible'
  document.body.innerHTML = `<main style="min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;text-align:center;font-family:system-ui,sans-serif;background:#0b1220;color:#cbd5e1">
    <div><div style="font-size:2.4rem">🧵</div><h1 style="font-size:1.3rem;margin:10px 0 6px;color:#f1f5f9">Catálogo no disponible</h1>
    <p style="margin:0;opacity:.75">Usa el enlace que te compartió tu proveedor.</p></div></main>`
} else {
  const nombre = emp.nombre_comercial || ''
  if (emp.color) document.documentElement.style.setProperty('--emp', emp.color)

  // Textos: el nombre de la empresa reemplaza cualquier "JHIRO" fijo del diseño original
  const cambiar = t => t.replace(/JHIRO/g, nombre)
  document.title = cambiar(document.title.replace(/—.*$/, '')).trim() ? `${document.title.replace(/—.*$/, '').trim()} — ${nombre}` : nombre
  const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
  for (let n = w.nextNode(); n; n = w.nextNode()) if (n.nodeValue.includes('JHIRO')) n.nodeValue = cambiar(n.nodeValue)
  document.querySelectorAll('[alt],[aria-label],[title]').forEach(el => ['alt', 'aria-label', 'title'].forEach(a => { const v = el.getAttribute(a); if (v && v.includes('JHIRO')) el.setAttribute(a, cambiar(v)) }))

  // Logo de la empresa (o su nombre como marca si no tiene logo)
  document.querySelectorAll('.nav__logo, .footer__brand a, .footer__logo').forEach(a => {
    const img = a.querySelector('img'); if (!img) return
    if (emp.logo_url) { img.src = emp.logo_url; img.alt = nombre; img.classList.add('emp-logo') }
    else { img.replaceWith(Object.assign(document.createElement('span'), { className: 'emp-wordmark', textContent: nombre })) }
  })
  document.body.classList.add('emp-lista')

  // Textos configurables (Panel → Web y flete)
  const t = document.getElementById('products-title')
  if (t && emp.titulo) t.textContent = emp.titulo
  const p = t?.closest('.section-header')?.querySelector('p')
  if (p && emp.mensaje) p.textContent = emp.mensaje

  // Nosotros: texto propio de la marca original → fuera del menú público
  document.querySelectorAll('a[href="about.html"]').forEach(a => a.closest('li')?.remove())

  // WhatsApp configurado
  const wa = String(emp.whatsapp || '').replace(/\D/g, '')
  if (wa) document.querySelectorAll('a[href^="https://wa.me/"]').forEach(a => { a.href = `https://wa.me/${wa}` })
}
