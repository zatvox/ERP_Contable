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

export function crearBuscador(host, { opciones = [], valor = '', placeholder = 'Todos', onChange = null, limite = 200 } = {}) {
  let ops = opciones.map(o => ({ v: String(o.v), l: String(o.l), sub: o.sub || '', n: norm(o.l + ' ' + (o.sub || '')) }))
  let val = valor === null || valor === undefined ? '' : String(valor)
  host.classList.add('bv')
  host.innerHTML = `<button type="button" class="bv-btn"><span class="bv-txt"></span><span class="bv-car">▾</span></button>
    <div class="bv-panel" hidden><input type="text" class="bv-q" placeholder="Buscar..." autocomplete="off">
      <div class="bv-acc"><span class="bv-cnt"></span><a href="#" class="bv-clear">Limpiar</a></div><div class="bv-lista"></div></div>`
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
    q.value = ''; pintarLista(); panel.hidden = false; q.focus()
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
  document.addEventListener('click', cerrar)

  pintarBtn()
  return {
    get: () => val,
    set: v => { val = v === null || v === undefined ? '' : String(v); pintarBtn() },
    setOpciones: nuevas => { ops = nuevas.map(o => ({ v: String(o.v), l: String(o.l), sub: o.sub || '', n: norm(o.l + ' ' + (o.sub || '')) })); pintarBtn() }
  }
}
