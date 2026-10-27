// ============================================================================
// shared/detalle-tabs.js — Modales de DETALLE (solo lectura) por pestañas
// 2026-10-27 · Estilo de la barra de pasos de "Liquidación del agente", pero
// las pestañas son libres (no hay orden: todo está lleno).
//
// Uso: pinta el detalle como siempre (bloques separados por <h4>) y luego
//   tabularDetalle(body, { cabecera, primerTab, mapa, unir, extra, dosColumnas })
// · Cada <h4> abre una pestaña; el <h4> queda dentro del panel como título.
// · cabecera: HTML fijo arriba (resumen). Si usarPrimerBloqueComoCabecera,
//   el primer elemento del body se vuelve la cabecera.
// · mapa: { 'prefijo del h4': ['icono', 'Etiqueta corta'] }
// · unir: prefijos de h4 que se pegan a la pestaña anterior.
// · extra: [{ icono, titulo, badge, html }] pestañas añadidas al final.
// · Insignias de la cabecera con data-dt-ir="Etiqueta" saltan a esa pestaña.
// ============================================================================

const _badgeDe = txt => {
  const m = String(txt).match(/\((\d+)\)\s*$/) || String(txt).match(/—\s*(\d+)\s+\w+/)
  return m ? m[1] : ''
}

export function tabularDetalle(body, opc = {}) {
  if (!body) return
  const { cabecera = '', usarPrimerBloqueComoCabecera = false, primerTab = ['📋', 'Datos'],
          mapa = {}, unir = [], extra = [], dosColumnas = true, recordar = null } = opc
  const nodos = [...body.children]
  let cabNode = null
  if (usarPrimerBloqueComoCabecera && nodos.length && nodos[0].tagName !== 'H4') cabNode = nodos.shift()

  const secciones = []
  let actual = { icono: primerTab[0], label: primerTab[1], badge: '', nodos: [] }
  const etiqueta = h => {
    const t = h.textContent.trim()
    const k = Object.keys(mapa).find(p => t.replace(/^[^\wÁÉÍÓÚÑáéíóúñ]+/, '').startsWith(p) || t.startsWith(p))
    return k ? mapa[k] : [t.match(/^\p{Extended_Pictographic}/u)?.[0] || '•', t.replace(/^\p{Extended_Pictographic}\s*/u, '').replace(/\s*\(.*$/, '').slice(0, 22)]
  }
  for (const n of nodos) {
    if (n.tagName === 'H4') {
      const t = n.textContent.trim()
      const pegar = unir.some(p => t.replace(/^[^\wÁÉÍÓÚÑáéíóúñ]+/, '').startsWith(p))
      const esInicio = secciones.length === 0 && actual.nodos.length === 0   // h4 al inicio → es la 1ra pestaña
      if (!pegar && !esInicio) {
        secciones.push(actual)
        const [ico, lab] = etiqueta(n)
        actual = { icono: ico, label: lab, badge: _badgeDe(t), nodos: [] }
      }
      n.classList.add('dt-h4')
    }
    actual.nodos.push(n)
  }
  secciones.push(actual)
  const sec = secciones.filter(s => s.nodos.length)
  for (const x of extra) sec.push({ icono: x.icono, label: x.titulo, badge: x.badge || '', html: x.html })

  const wrap = document.createElement('div')
  wrap.className = 'dt-wrap'
  const cab = document.createElement('div')
  cab.className = 'dt-cab'
  if (cabNode) cab.appendChild(cabNode)
  if (cabecera) cab.insertAdjacentHTML('beforeend', cabecera)
  const tabs = document.createElement('div')
  tabs.className = 'dt-tabs'
  const panels = document.createElement('div')
  panels.className = 'dt-panels'
  sec.forEach((s, i) => {
    const b = document.createElement('button')
    b.type = 'button'; b.className = 'dt-tab'; b.dataset.dtKey = s.label
    b.innerHTML = `<span class="dt-ico">${s.icono}</span>${s.label}${s.badge ? `<span class="dt-badge">${s.badge}</span>` : ''}`
    b.onclick = () => _ir(wrap, i, recordar)
    tabs.appendChild(b)
    const p = document.createElement('section')
    p.className = 'dt-panel'
    if (s.html != null) p.innerHTML = s.html
    else s.nodos.forEach(n => p.appendChild(n))
    if (i === 0 && dosColumnas) p.querySelector('table.table-compact')?.classList.add('dt-2col')
    panels.appendChild(p)
  })
  body.innerHTML = ''
  if (cab.childNodes.length) wrap.appendChild(cab)
  wrap.appendChild(tabs)
  wrap.appendChild(panels)
  body.appendChild(wrap)
  wrap.addEventListener('click', ev => {
    const ir = ev.target.closest('[data-dt-ir]')
    if (!ir) return
    const i = sec.findIndex(s => s.label === ir.dataset.dtIr)
    if (i >= 0) { ev.preventDefault(); _ir(wrap, i, recordar) }
  })
  let ini = 0
  if (recordar) { try { const k = sessionStorage.getItem('dt_' + recordar); const j = sec.findIndex(s => s.label === k); if (j >= 0) ini = j } catch {} }
  _ir(wrap, ini, null)
  return wrap
}

function _ir(wrap, i, recordar) {
  wrap.querySelectorAll('.dt-tab').forEach((b, k) => b.classList.toggle('activa', k === i))
  wrap.querySelectorAll('.dt-panel').forEach((p, k) => { p.hidden = k !== i })
  if (recordar) { try { sessionStorage.setItem('dt_' + recordar, wrap.querySelectorAll('.dt-tab')[i]?.dataset.dtKey || '') } catch {} }
}

/** Insignia de la cabecera: ok=true ✓ verde, false ⚠ ámbar; ir = etiqueta de la pestaña. */
export const dtInsignia = (texto, ok = true, ir = '') =>
  `<span class="dt-ins ${ok ? 'ok' : 'warn'}" ${ir ? `data-dt-ir="${ir}" title="Ver ${ir}"` : ''}>${ok ? '✓' : '⚠'} ${texto}</span>`
