// ============================================================================
// rrhh/cargos.js — Selector múltiple de cargos agrupados por área (2026-11-05)
// Convierte un <input id="..."> en un campo con chips + panel con buscador y casillas.
// El valor sigue guardándose como texto separado por comas en el input original
// (columna empleados.cargo), así no cambia la base de datos.
// Para agregar cargos nuevos al catálogo: edita CARGOS_POR_AREA.
// ============================================================================
export const CARGOS_POR_AREA = {
  'Logística y almacén': ['Chofer', 'Cargador', 'Almacenero'],
  'Ventas y comercial': ['Vendedor', 'Asesor comercial', 'Ejecutivo de cuentas', 'Jefe de ventas', 'Televendedor', 'Cobrador', 'Atención al cliente', 'Post-venta', 'Promotor / impulsador'],
  'Administrativo': ['Administrador', 'Asistente administrativo', 'Auxiliar administrativo', 'Oficina general', 'Recepcionista', 'Secretaria', 'Asistente de gerencia', 'Mensajero'],
  'Contabilidad y finanzas': ['Contador', 'Asistente contable', 'Auxiliar contable', 'Tesorero(a)', 'Cajero(a)', 'Facturación y cobranzas', 'Cuentas por pagar', 'Analista de costos'],
  'Importaciones y compras': ['Analista de importaciones', 'Asistente de comercio exterior', 'Documentación de embarques', 'Comprador', 'Coordinador de compras'],
  'Calidad y producción': ['Control de calidad', 'Supervisor de calidad', 'Operario de rebobinado / conos', 'Operario de producción'],
  'Recursos humanos': ['Encargado(a) de RRHH', 'Asistente de planilla'],
  'Gerencia y dirección': ['Gerente general', 'Gerente comercial', 'Gerente de operaciones', 'Director', 'Socio'],
  'Sistemas y soporte': ['Desarrollador', 'Soporte TI', 'Analista de datos'],
  'Servicios generales': ['Limpieza', 'Seguridad / vigilancia', 'Mantenimiento', 'Conserje']
}
const _esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const _norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim()
const _inst = {}

/** extras: cargos ya usados en fichas que no están en el catálogo (se muestran en «Otros»). */
export function montarSelectorCargos(inputId, extras = []) {
  const input = document.getElementById(inputId); if (!input) return null
  if (_inst[inputId]) { _inst[inputId].extras = extras; _inst[inputId].refrescar(); return _inst[inputId] }
  input.type = 'hidden'
  const caja = document.createElement('div')
  caja.className = 'cg-caja'
  caja.innerHTML = `<div class="cg-campo" tabindex="0"><span class="cg-chips"></span><span class="cg-ph">Elige uno o varios cargos…</span><span class="cg-flecha">▾</span></div>
    <div class="cg-panel"><input type="text" class="cg-buscar" placeholder="Buscar cargo o escribir uno nuevo…" autocomplete="off"><div class="cg-lista"></div></div>`
  input.parentNode.insertBefore(caja, input.nextSibling)
  const campo = caja.querySelector('.cg-campo'), panel = caja.querySelector('.cg-panel'), buscar = caja.querySelector('.cg-buscar'), lista = caja.querySelector('.cg-lista'), chips = caja.querySelector('.cg-chips'), ph = caja.querySelector('.cg-ph')
  const api = { extras, input }
  const sel = () => new Set(input.value.split(',').map(x => x.trim()).filter(Boolean))
  const guardar = set => { input.value = [...set].join(', '); input.dispatchEvent(new Event('change', { bubbles: true })); pintarChips(); pintarLista() }
  function pintarChips() {
    const s = [...sel()]
    chips.innerHTML = s.map(c => `<span class="cg-chip">${_esc(c)}<b data-q="${_esc(c)}" title="Quitar">×</b></span>`).join('')
    ph.style.display = s.length ? 'none' : ''
  }
  function pintarLista() {
    const q = _norm(buscar.value), s = sel()
    const todos = new Set(Object.values(CARGOS_POR_AREA).flat())
    const grupos = { ...CARGOS_POR_AREA }
    const otros = [...new Set([...api.extras, ...s])].filter(c => !todos.has(c))
    if (otros.length) grupos['Otros (ya usados)'] = otros
    let html = '', hay = false
    for (const [area, cargos] of Object.entries(grupos)) {
      const vis = cargos.filter(c => !q || _norm(c).includes(q) || _norm(area).includes(q))
      if (!vis.length) continue
      hay = true
      html += `<div class="cg-area">${_esc(area)}</div>` + vis.map(c => `<label class="cg-item"><input type="checkbox" data-c="${_esc(c)}" ${s.has(c) ? 'checked' : ''}> ${_esc(c)}</label>`).join('')
    }
    const nuevo = buscar.value.trim()
    if (nuevo && ![...todos, ...otros].some(c => _norm(c) === _norm(nuevo))) html += `<div class="cg-nuevo" data-nuevo="${_esc(nuevo)}">＋ Agregar «${_esc(nuevo)}» como cargo nuevo</div>`
    else if (!hay) html = '<div class="cg-vacio">Sin coincidencias</div>'
    lista.innerHTML = html
  }
  function posicionar() {
    const r = campo.getBoundingClientRect(), alto = 300
    const ancho = Math.max(r.width, 320); panel.style.width = ancho + 'px'; panel.style.left = Math.min(r.left, window.innerWidth - ancho - 12) + 'px'
    panel.style.top = (window.innerHeight - r.bottom < alto && r.top > alto) ? (r.top - alto - 3) + 'px' : (r.bottom + 3) + 'px'
  }
  const abrir = () => { pintarLista(); caja.classList.add('abierta'); posicionar(); buscar.focus() }
  const cerrar = () => { caja.classList.remove('abierta'); buscar.value = '' }
  campo.addEventListener('click', e => { if (e.target.dataset.q) return; caja.classList.contains('abierta') ? cerrar() : abrir() })
  chips.addEventListener('click', e => { const q = e.target.dataset?.q; if (q != null) { const s = sel(); s.delete(q); guardar(s) } })
  buscar.addEventListener('input', pintarLista)
  buscar.addEventListener('keydown', e => { if (e.key === 'Escape') cerrar(); if (e.key === 'Enter') { e.preventDefault(); lista.querySelector('.cg-nuevo')?.click() } })
  lista.addEventListener('change', e => { const c = e.target.dataset?.c; if (c == null) return; const s = sel(); e.target.checked ? s.add(c) : s.delete(c); guardar(s) })
  lista.addEventListener('click', e => { const n = e.target.dataset?.nuevo; if (n) { const s = sel(); s.add(n); buscar.value = ''; guardar(s); buscar.focus() } })
  document.addEventListener('mousedown', e => { if (caja.classList.contains('abierta') && !caja.contains(e.target)) cerrar() })
  window.addEventListener('scroll', e => { if (caja.classList.contains('abierta') && !panel.contains(e.target)) posicionar() }, true)
  window.addEventListener('resize', () => { if (caja.classList.contains('abierta')) posicionar() })
  api.refrescar = () => { pintarChips(); if (caja.classList.contains('abierta')) pintarLista() }
  api.refrescar()
  return (_inst[inputId] = api)
}
