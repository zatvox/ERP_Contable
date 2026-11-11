// ============================================================================
// shared/buscador-vivo.js — ESTÁNDAR "Buscador desplegable en vivo" (2026-11-11)
// Mismo look que el filtro de Reportes de Ventas (.rp-ms) pero de SELECCIÓN ÚNICA:
// botón ▾ → panel con caja "Buscar..." que filtra mientras escribes → clic en la fila elige y cierra.
// Sin checkboxes. Enter elige la primera coincidencia, Esc cierra. Cierra al hacer clic fuera.
//
// Uso:
//   import { crearBuscador } from '../shared/buscador-vivo.js'
//   const bv = crearBuscador(host, {
//     opciones: [{ v: '12', l: 'ACME S.A.C.', sub: 'RUC 2060…' }],   // v = valor, l = etiqueta, sub = detalle opcional
//     valor: '', placeholder: 'Todos (clientes)', onChange: (v, op) => {}
//   })
//   bv.get() → valor actual ('' si ninguno) · bv.set(v) · bv.setOpciones([...])
// Requiere los estilos .bv-* de styles.css.
// ============================================================================
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const norm = s => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')

export function crearBuscador(host, { opciones = [], valor = '', placeholder = 'Todos', onChange = null, limite = 200, nuevo = null, flotante = false } = {}) {
  let ops = opciones.map(o => ({ v: String(o.v), l: String(o.l), sub: o.sub || '', n: norm(o.l + ' ' + (o.sub || '')) }))
  let val = valor === null || valor === undefined ? '' : String(valor)
  host.classList.add('bv')
  host.innerHTML = `<button type="button" class="bv-btn"><span class="bv-txt"></span><span class="bv-car">▾</span></button>
    <div class="bv-panel" hidden><input type="text" class="bv-q" placeholder="Buscar..." autocomplete="off">
      <div class="bv-acc"><span class="bv-cnt"></span><a href="#" class="bv-clear">Limpiar</a></div><div class="bv-lista"></div>${nuevo ? `<a href="#" class="bv-nuevo">＋ ${esc(nuevo.label || 'Nuevo')}</a>` : ''}</div>`
  const btn = host.querySelector('.bv-btn'), txt = host.querySelector('.bv-txt'), panel = host.querySelector('.bv-panel')
  const q = host.querySelector('.bv-q'), lista = host.querySelector('.bv-lista'), cnt = host.querySelector('.bv-cnt')

  const pintarBtn = () => {
    const o = ops.find(x => x.v === val)
    txt.textContent = o ? o.l : placeholder
    btn.classList.toggle('activo', !!o); btn.title = o ? o.l : ''
  }
  const pintarLista = () => {
    const t = norm(q.value.trim())
    const f = ops.filter(o => !t || t.split(/\s+/).every(w => o.n.includes(w)))
    cnt.textContent = f.length > limite ? `${limite}+ de ${f.length}` : `${f.length} resultado${f.length === 1 ? '' : 's'}`
    lista.innerHTML = f.slice(0, limite).map(o => `<div class="bv-op ${o.v === val ? 'sel' : ''}" data-v="${esc(o.v)}"><span>${esc(o.l)}</span>${o.sub ? `<small>${esc(o.sub)}</small>` : ''}</div>`).join('') || '<small class="bv-vacio">Sin coincidencias</small>'
  }
  const cerrar = () => { panel.hidden = true }
  const elegir = v => { val = v; pintarBtn(); cerrar(); onChange && onChange(val, ops.find(x => x.v === val) || null) }
  const abrir = () => {
    document.querySelectorAll('.bv-panel').forEach(p => { p.hidden = true })
    q.value = ''; pintarLista(); panel.hidden = false
    if (flotante) {            // dentro de modales con scroll el panel absoluto se recorta: se ancla con position:fixed
      const r = btn.getBoundingClientRect()
      panel.style.position = 'fixed'; panel.style.zIndex = '3000'
      panel.style.minWidth = Math.max(r.width, 300) + 'px'
      const alto = Math.min(panel.offsetHeight || 340, 400)
      const abajo = window.innerHeight - r.bottom
      panel.style.left = Math.min(r.left, window.innerWidth - Math.max(r.width, 300) - 12) + 'px'
      panel.style.top = (abajo < alto + 12 && r.top > alto ? Math.max(8, r.top - alto - 4) : r.bottom + 4) + 'px'
    }
    q.focus()
  }

  btn.addEventListener('click', e => { e.stopPropagation(); panel.hidden ? abrir() : cerrar() })
  panel.addEventListener('click', e => e.stopPropagation())
  q.addEventListener('input', pintarLista)
  q.addEventListener('keydown', e => {
    if (e.key === 'Escape') { cerrar(); btn.focus() }
    if (e.key === 'Enter') { e.preventDefault(); const p = lista.querySelector('.bv-op'); if (p) elegir(p.dataset.v) }
  })
  lista.addEventListener('click', e => { const o = e.target.closest('.bv-op'); if (o) elegir(o.dataset.v) })
  host.querySelector('.bv-clear').addEventListener('click', e => { e.preventDefault(); elegir('') })
  host.querySelector('.bv-nuevo')?.addEventListener('click', e => { e.preventDefault(); const t = q.value.trim(); cerrar(); nuevo.onClick && nuevo.onClick(t) })
  document.addEventListener('click', cerrar)

  pintarBtn()
  return {
    get: () => val,
    host, btn,
    setDisabled: b => { btn.disabled = !!b },
    set: v => { val = v === null || v === undefined ? '' : String(v); pintarBtn() },
    setOpciones: nuevas => { ops = nuevas.map(o => ({ v: String(o.v), l: String(o.l), sub: o.sub || '', n: norm(o.l + ' ' + (o.sub || '')) })); pintarBtn() }
  }
}


// ── Buscador respaldado por un <select> (para el código que ya lee/escribe select.value) ────────────
// Mismo nombre y misma forma que buscador-select.js (`convertirEnBuscador`, `refrescarBuscador`, `alCrearNuevo`),
// pero con el look estándar .bv y el «＋ Nuevo» al pie. El <select> original queda oculto y sigue siendo la fuente
// de verdad: `select.value = x` también actualiza el botón, y elegir dispara `change`.
const _sel = new WeakMap()
export function convertirEnBuscador(selector, o = {}) {
  const select = typeof selector === 'string' ? document.getElementById(selector) : selector
  if (!select) return null
  if (_sel.has(select)) return _sel.get(select)
  const host = document.createElement('div'); host.className = 'bv-block'
  select.parentNode.insertBefore(host, select); select.style.display = 'none'
  if (select.required) { select.required = false; select.dataset.eraRequired = '1' }   // oculto + required bloquearía el submit nativo
  const leer = () => [...select.options].filter(x => x.value !== '').map(x => ({ v: x.value, l: x.textContent.trim() }))
  const nuevo = o.alCrearNuevo ? { label: o.alCrearNuevo.label, onClick: o.alCrearNuevo.onClick } : null
  const bv = crearBuscador(host, { opciones: leer(), valor: select.value, placeholder: o.placeholder || 'Buscar…', flotante: true, nuevo,
    onChange: v => { select.value = v; select.dispatchEvent(new Event('change', { bubbles: true })) } })
  const d = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')
  Object.defineProperty(select, 'value', { configurable: true, get() { return d.get.call(this) }, set(v) { d.set.call(this, v); bv.set(d.get.call(this)) } })
  const refrescar = () => { bv.setOpciones(leer()); bv.set(select.value); bv.setDisabled(select.disabled) }
  new MutationObserver(refrescar).observe(select, { childList: true, attributes: true, attributeFilter: ['disabled'] })
  refrescar()
  const api = { refrescar, bv }
  _sel.set(select, api)
  return api
}
export function refrescarBuscador(selector) {
  const select = typeof selector === 'string' ? document.getElementById(selector) : selector
  _sel.get(select)?.refrescar()
}

// ── Buscador de CONTACTOS (proveedor / transportista / agente…) con «＋ Nuevo contacto» ─────────────
// host: div vacío. roles: ['proveedor'] filtra; null = todos. Al crear un contacto nuevo queda elegido solo.
export async function buscadorContacto(host, { roles = null, valor = '', placeholder = 'Buscar contacto por nombre o RUC…', onChange = null, rolNuevo = 'proveedor' } = {}) {
  const { getContacts } = await import('../supabase-data.js')
  const filtra = c => c.activo !== false && (!roles || (Array.isArray(c.tipo_contacto) ? c.tipo_contacto : [c.tipo_contacto]).some(t => roles.includes(String(t || '').toLowerCase())))
  let lista = []
  const aOps = () => lista.map(c => ({ v: c.id, l: c.nombre || c.razon_social || ('Contacto ' + c.id), sub: [c.tipo_documento, c.nro_documento].filter(Boolean).join(' ') }))
  const cargar = async forzar => { lista = ((await getContacts(forzar)) || []).filter(filtra).sort((a, b) => String(a.nombre || '').localeCompare(String(b.nombre || ''))) }
  await cargar(false)
  const bv = crearBuscador(host, { opciones: aOps(), valor, placeholder, flotante: true,
    nuevo: { label: 'Nuevo contacto', onClick: async () => { const m = await import('./contacto-modal.js'); m.abrirModalContacto({ roles: [rolNuevo] }) } },
    onChange: v => onChange && onChange(lista.find(c => String(c.id) === String(v)) || null) })
  host.classList.add('bv-block')
  window.addEventListener('contacto-guardado', async ev => {
    if (!host.isConnected) return
    await cargar(true); bv.setOpciones(aOps())
    const c = ev.detail?.contacto
    if (c?.id && ev.detail?.nuevo && lista.some(x => x.id === c.id)) { bv.set(c.id); onChange && onChange(lista.find(x => x.id === c.id)) }
  })
  return { ...bv, contacto: () => lista.find(c => String(c.id) === String(bv.get())) || null,
    setPorRuc: (ruc, nombre) => { const c = lista.find(x => ruc && String(x.nro_documento) === String(ruc)) || lista.find(x => nombre && String(x.nombre || '').toLowerCase() === String(nombre).toLowerCase()); bv.set(c ? c.id : '') ; return c || null } }
}
