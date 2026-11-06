// ============================================================================
// rrhh/tabla.js — Tabla estándar del ERP para el módulo RRHH (2026-11-05)
// Cumple el estándar: ⋮ de columnas en la esquina, ⋮ de acciones por fila,
// orden asc/desc al tocar la columna, buscador, y confirmación pequeña.
//
//   montarTabla('card-id', { nombre, titulo, botones, cols, filas, acciones, vacio })
//   cols:  [{ key, label, val: f => valorOrdenable, html: f => celda, oculta?, der? }]
//   acciones: f => [{ icono, label, onclick, peligro, separador }]
// ============================================================================
import { registrarColumnas, colMenuHtml, colStyle } from '../col-menu.js'
import { menuAccionesFila } from '../main.js'

const _inst = {}
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

export function montarTabla(cardId, cfg) {
  const card = document.getElementById(cardId); if (!card) return
  let st = _inst[cardId]
  if (!st) {
    st = _inst[cardId] = { sort: cfg.sort || { col: cfg.cols[0].key, dir: 'asc' }, q: '' }
    registrarColumnas(cfg.nombre, [...cfg.cols.map(c => ({ key: c.key, label: c.label, oculta: c.oculta })), ...(cfg.acciones ? [{ key: 'acciones', label: 'Acciones' }] : [])])
    card.innerHTML = `
      ${colMenuHtml(cfg.nombre, `${cardId}-cm`, `${cardId}-cm-dd`)}
      <div class="card-header" style="flex-direction:column; align-items:stretch; gap:10px;">
        <div style="display:flex; justify-content:space-between; align-items:center; gap:10px; flex-wrap:wrap; padding-right:34px;">
          <h3 class="card-titulo-tab" id="${cardId}-tit"></h3>
          <div class="card-acciones" id="${cardId}-btn"></div>
        </div>
        <div id="${cardId}-sub"></div>
        ${cfg.buscar === false ? '' : `<div class="bsq-caja"><input class="bsq-input" id="${cardId}-q" type="text" placeholder="${esc(cfg.placeholder || 'Buscar…')}" oninput="window._rrTabla('${cardId}','q',this.value)"><button type="button" class="bsq-limpiar" onclick="window._rrTabla('${cardId}','limpiar')" title="Limpiar">✕</button></div>`}
      </div>
      <div id="${cardId}-cuerpo" class="table-container"></div>`
  }
  st.cfg = cfg
  document.getElementById(`${cardId}-tit`).innerHTML = cfg.titulo || ''
  document.getElementById(`${cardId}-btn`).innerHTML = cfg.botones || ''
  document.getElementById(`${cardId}-sub`).innerHTML = cfg.sub || ''
  _pintar(cardId)
}

function _pintar(id) {
  const st = _inst[id]; const { cfg, sort, q } = st
  const cuerpo = document.getElementById(`${id}-cuerpo`); if (!cuerpo) return
  const txt = q.trim().toLowerCase()
  let filas = (cfg.filas || []).filter(f => !txt || cfg.cols.some(c => String(c.val ? c.val(f) : '').toLowerCase().includes(txt)))
  const col = cfg.cols.find(c => c.key === sort.col)
  if (col) {
    const dir = sort.dir === 'asc' ? 1 : -1
    filas = [...filas].sort((a, b) => {
      const va = col.val(a), vb = col.val(b)
      if (va === vb) return 0
      return (va < vb ? -1 : 1) * dir
    })
  }
  if (!filas.length) { cuerpo.innerHTML = `<p style="text-align:center; color:var(--text-secondary); padding:24px;">${cfg.vacio || 'Sin datos'}</p>`; return }
  const th = c => {
    const act = sort.col === c.key
    const fl = act ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : ' <span class="rp-orden-hint">⇅</span>'
    return `<th data-col-tabla="${cfg.nombre}" data-col="${c.key}" style="cursor:pointer; user-select:none; white-space:nowrap;${c.der ? ' text-align:right;' : ''}${colStyle(cfg.nombre, c.key) ? ' display:none;' : ''}" onclick="window._rrTabla('${id}','sort','${c.key}')">${c.label}${fl}</th>`
  }
  const td = (c, f) => `<td data-col-tabla="${cfg.nombre}" data-col="${c.key}" style="${c.der ? 'text-align:right;' : ''}${colStyle(cfg.nombre, c.key) ? ' display:none;' : ''}">${c.html(f)}</td>`
  cuerpo.innerHTML = `<table><thead><tr>${cfg.cols.map(th).join('')}${cfg.acciones ? `<th data-col-tabla="${cfg.nombre}" data-col="acciones" style="width:60px;${colStyle(cfg.nombre, 'acciones') ? ' display:none;' : ''}">Acciones</th>` : ''}</tr></thead>
    <tbody>${filas.map(f => `<tr style="${cfg.estiloFila ? cfg.estiloFila(f) : ''}" ${cfg.dobleClic ? `ondblclick="${cfg.dobleClic(f)}"` : ''}>${cfg.cols.map(c => td(c, f)).join('')}${cfg.acciones ? `<td data-col-tabla="${cfg.nombre}" data-col="acciones" class="col-acciones"${colStyle(cfg.nombre, 'acciones')}>${menuAccionesFila(cfg.acciones(f))}</td>` : ''}</tr>`).join('')}</tbody></table>
    <div style="padding:8px 16px; color:var(--text-secondary); font-size:0.82rem;">${filas.length} registro(s)</div>`
}

window._rrTabla = function (id, accion, arg) {
  const st = _inst[id]; if (!st) return
  if (accion === 'q') st.q = arg || ''
  if (accion === 'limpiar') { st.q = ''; const i = document.getElementById(`${id}-q`); if (i) i.value = '' }
  if (accion === 'sort') st.sort = st.sort.col === arg ? { col: arg, dir: st.sort.dir === 'asc' ? 'desc' : 'asc' } : { col: arg, dir: 'asc' }
  _pintar(id)
}

// Confirmación pequeña (reemplaza a confirm()/prompt()). Devuelve Promise<{ok, valor}>.
export function confirmarPequeno({ titulo, texto, okLabel = 'Confirmar', peligro = false, campo = null, campo2 = null }) {
  return new Promise(resolve => {
    window.cerrarMenuAcciones?.()
    const m = document.createElement('div')
    m.className = 'modal show'; m.style.zIndex = 3000
    m.innerHTML = `<div class="modal-content" style="max-width:420px; width:min(92vw,420px); padding:20px;">
      <h3 style="margin:0 0 8px;">${esc(titulo)}</h3>
      <p style="margin:0 0 12px; color:var(--text-secondary); font-size:0.92rem; line-height:1.45;">${texto}</p>
      ${campo ? `<div class="form-group" style="margin:0 0 12px;"><label>${esc(campo.label)}</label><input id="cp-campo" type="${campo.type || 'text'}" value="${esc(campo.valor || '')}" placeholder="${esc(campo.placeholder || '')}"></div>` : ''}
      ${campo2 ? `<div class="form-group" style="margin:0 0 12px;"><label>${esc(campo2.label)}</label><input id="cp-campo2" type="${campo2.type || 'text'}" value="${esc(campo2.valor || '')}" placeholder="${esc(campo2.placeholder || '')}"></div>` : ''}
      <div style="display:flex; gap:8px; justify-content:flex-end;">
        <button class="btn btn-secondary btn-small" id="cp-no">Cancelar</button>
        <button class="btn ${peligro ? 'btn-danger' : 'btn-primary'} btn-small" id="cp-si">${esc(okLabel)}</button>
      </div></div>`
    document.body.appendChild(m)
    const cerrar = ok => { const valor = m.querySelector('#cp-campo')?.value ?? null; const valor2 = m.querySelector('#cp-campo2')?.value ?? null; m.remove(); resolve({ ok, valor, valor2 }) }
    m.querySelector('#cp-no').onclick = () => cerrar(false)
    m.querySelector('#cp-si').onclick = () => cerrar(true)
    m.addEventListener('click', e => { if (e.target === m) cerrar(false) })
    m.querySelector('#cp-campo')?.focus()
  })
}
