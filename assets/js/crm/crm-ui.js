// CAPA 2 · UI — funciones puras que devuelven HTML (sin llamadas a Supabase).
export const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
export const num = (v, d = 2) => Number(v || 0).toLocaleString('es-PE', { minimumFractionDigits: d, maximumFractionDigits: d })
export const money = (v, m = 'PEN') => (m === 'USD' ? 'US$ ' : 'S/ ') + num(v)
export const fecha = v => v ? new Date(v).toLocaleDateString('es-PE', { day: '2-digit', month: '2-digit', year: 'numeric' }) : ''
export const fechaHora = v => v ? new Date(v).toLocaleString('es-PE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : ''
export const norm = s => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
export const lbl = s => String(s || '').replace('_', ' ')
export const ESTADOS = ['enviada', 'en_revision', 'cotizada', 'aceptada', 'pagada', 'convertida', 'perdida', 'cancelada']

const COL = { verde: '#16a34a', amarillo: '#d97706', rojo: '#dc2626', sin_costo: '#6b7280', sin_precio: '#6b7280' }
export const sem = s => s ? `<span title="Semáforo de margen" style="display:inline-flex;align-items:center;gap:5px;font-size:.78rem"><i style="width:10px;height:10px;border-radius:50%;background:${COL[s] || '#6b7280'};display:inline-block"></i>${s === 'sin_costo' ? 'sin costo' : s === 'sin_precio' ? 'sin precio' : esc(s)}</span>` : '<span style="color:var(--text-secondary)">—</span>'
export const chip = (t, c = 'var(--text-secondary)') => `<span style="display:inline-block;padding:2px 8px;border-radius:10px;font-size:.74rem;border:1px solid ${c};color:${c}">${esc(t)}</span>`
export const kpi = (v, l, sub = '') => `<div class="kpi-card"><div class="kpi-label">${esc(l)}</div><div class="kpi-value">${v}</div>${sub ? `<div class="kpi-sub">${sub}</div>` : ''}</div>`
export const skel = () => '<div style="padding:40px;text-align:center;color:var(--text-secondary)">Cargando…</div>'
export const err = m => `<div style="padding:12px;border-radius:8px;background:rgba(220,38,38,.1);color:var(--color-danger)">${esc(m)}</div>`
export const tabla = (heads, rows, vacio = 'Sin datos') =>
  `<div style="overflow-x:auto"><table><thead><tr>${heads.map(h => `<th${h.startsWith('#') ? ' style="text-align:right"' : ''}>${esc(h.replace(/^#/, ''))}</th>`).join('')}</tr></thead><tbody>${rows.join('') || `<tr><td colspan="${heads.length}" style="color:var(--text-secondary)">${esc(vacio)}</td></tr>`}</tbody></table></div>`
const R = 'style="text-align:right"'

export function htmlCotizaciones({ rows, sems, fEst, fQ, fMias, yo }) {
  const k = e => rows.filter(r => r.estado === e).length
  const ini = new Date(); ini.setDate(1); ini.setHours(0, 0, 0, 0)
  const mes = rows.filter(r => ['aceptada', 'pagada', 'convertida'].includes(r.estado) && new Date(r.created_at) >= ini).reduce((a, r) => a + Number(r.total), 0)
  const sinA = rows.filter(r => !r.vendedor_id && !['perdida', 'cancelada'].includes(r.estado)).length
  const lista = rows.filter(r => (!fEst || r.estado === fEst) && (!fMias || r.vendedor_id === yo.id) && (!fQ || norm(`${r.numero} ${r.razon_social} ${r.contacto_nombre}`).includes(fQ)))
  return `<div class="grid grid-4" style="margin-bottom:14px">${kpi(k('enviada'), 'Nuevas')}${kpi(k('en_revision') + k('cotizada'), 'En proceso')}${kpi(sinA, 'Sin asignar')}${kpi(money(mes), 'Cerrado este mes')}</div>
  <div class="card"><div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px;align-items:center">
    <input id="fq" placeholder="Buscar N°, cliente…" value="${esc(fQ)}" style="max-width:240px">
    <select id="fe" style="max-width:200px"><option value="">Todos los estados</option>${ESTADOS.map(s => `<option value="${s}" ${fEst === s ? 'selected' : ''}>${lbl(s)}</option>`).join('')}</select>
    <label style="display:flex;gap:6px;align-items:center;font-weight:normal"><input type="checkbox" id="fm" ${fMias ? 'checked' : ''} style="width:auto"> Solo mías</label>
    <span style="margin-left:auto;font-size:.8rem;color:var(--text-secondary)" id="crm-live">En vivo</span></div>
  ${tabla(['N°', 'Fecha', 'Cliente', 'Estado', 'Pago', 'Margen', '#Total', 'Flete', 'Asignada'], lista.map(r => `<tr data-id="${r.id}" style="cursor:pointer">
    <td><b>${esc(r.numero)}</b></td><td>${fecha(r.created_at)}</td><td>${esc(r.razon_social)}<br><small style="color:var(--text-secondary)">${esc(r.contacto_nombre || '')}</small></td>
    <td>${chip(lbl(r.estado))}</td><td>${esc(r.estado_pago)}</td><td>${sem(sems[r.id])}</td><td ${R}>${money(r.total, r.moneda)}</td>
    <td>${r.flete_estado === 'cotizar' ? chip('cotizar', '#d97706') : r.flete_soles != null ? 'S/ ' + num(r.flete_soles, 0) : '—'}</td>
    <td>${r.vendedor_id ? (r.vendedor_id === yo.id ? 'Yo' : '#' + r.vendedor_id) : '—'}</td></tr>`), 'Sin cotizaciones')}</div>`
}

// ---- BANDEJA UNIFICADA (SQL 136) — una fila por COT, mostrando el ÚLTIMO documento emitido
export const FLUJO = {
  cotizacion:         { t: 'Cotización',        c: '#6b7280', i: '📝' },
  pk:                 { t: 'PK',                c: '#2563eb', i: '📦' },
  facturado_sin_guia: { t: 'Facturado · sin guía', c: '#d97706', i: '🧾' },
  guia_parcial:       { t: 'Guía parcial',      c: '#7c3aed', i: '🚚' },
  por_retirar:        { t: 'Por retirar',       c: '#0d9488', i: '🏭' },
  despachado:         { t: 'Despachado',        c: '#16a34a', i: '✅' }
}
const flujoChip = e => { const f = FLUJO[e] || { t: e, c: '#6b7280' }; return chip(f.t, f.c) }
const despLabel = r => r.termino_despacho === 'despacho' ? `🚚 ${esc(r.distrito || '')}${r.maps_url ? ` <a href="${esc(r.maps_url)}" target="_blank" rel="noopener" onclick="event.stopPropagation()" title="Abrir en Google Maps">📍</a>` : ''}`
  : r.termino_despacho === 'recoge_cliente' ? '🏭 Recoge' : '<span style="color:var(--text-secondary)">—</span>'
const espera = r => r.dias_espera == null ? '' : (r.dias_espera <= 0 ? 'hoy' : `${r.dias_espera} d`)
const colorEspera = r => r.dias_espera >= 3 ? 'var(--color-danger)' : r.dias_espera >= 1 ? 'var(--color-warning)' : 'inherit'

/** Destino al hacer clic: la cotización web abre su detalle; lo del ERP lleva al módulo con el buscador prefiltrado. */
export function destinoBandeja(r) {
  if (r.origen === 'web') return null
  const q = encodeURIComponent(['cotizacion', 'pk'].includes(r.estado_flujo) ? (r.doc_actual || r.cot_numero || '') : (r.cliente || ''))
  const tab = ['cotizacion', 'pk'].includes(r.estado_flujo) ? 'packing' : 'ventas'
  return `ventas.html?tab=${tab}&q=${q}`
}

export function htmlBandeja({ rows, fEst, fQ, fMias, fTodo, yo }) {
  const k = e => rows.filter(r => r.estado_flujo === e).length
  const lista = rows.filter(r => (!fEst || r.estado_flujo === fEst) && (!fMias || r.vendedor_id === yo.id) &&
    (!fQ || norm(`${r.cot_numero} ${r.doc_actual} ${r.cliente}`).includes(fQ)))
  return `<div class="grid grid-4" style="margin-bottom:14px">${kpi(k('facturado_sin_guia'), 'Facturado · sin guía')}${kpi(k('guia_parcial'), 'Guía parcial')}${kpi(k('por_retirar'), 'Por retirar')}${kpi(k('cotizacion') + k('pk'), 'Cotizaciones y PK abiertos')}</div>
  <div class="card"><div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px;align-items:center">
    <input id="fq" placeholder="Buscar COT, documento, cliente…" value="${esc(fQ)}" style="max-width:260px">
    <select id="fe" style="max-width:210px"><option value="">Todos los estados</option>${Object.entries(FLUJO).map(([k2, f]) => `<option value="${k2}" ${fEst === k2 ? 'selected' : ''}>${f.i} ${f.t}</option>`).join('')}</select>
    <label style="display:flex;gap:6px;align-items:center;font-weight:normal"><input type="checkbox" id="fm" ${fMias ? 'checked' : ''} style="width:auto"> Solo mías</label>
    <label style="display:flex;gap:6px;align-items:center;font-weight:normal" title="Incluye lo ya despachado y los PK directos"><input type="checkbox" id="ft" ${fTodo ? 'checked' : ''} style="width:auto"> Ver también despachados</label>
    <button class="btn btn-small" id="crm-refrescar" title="Actualizar">↻</button>
    <span style="margin-left:auto;font-size:.8rem;color:var(--text-secondary)" id="crm-live">En vivo</span></div>
  ${tabla(['COT', 'Último documento', 'Fecha', 'Cliente', 'Estado', 'Despacho', 'Margen', '#Total', 'Espera'], lista.map(r => `<tr data-ref="${esc(r.origen)}:${esc(r.ref_id)}" data-url="${esc(destinoBandeja(r) || '')}" style="cursor:pointer${r.estado_flujo === 'por_retirar' ? ';background:rgba(13,148,136,.07)' : ''}">
    <td><b>${esc(r.cot_numero || '—')}</b>${r.bajo_pv_lista ? ' <span title="Se cotizó por debajo del PV de lista" style="color:var(--color-warning)">⚠</span>' : ''}</td>
    <td>${chip(r.doc_tipo)} ${esc(r.doc_actual)}</td><td>${fecha(r.fecha_doc)}</td>
    <td>${esc(r.cliente || '')}</td><td>${flujoChip(r.estado_flujo)}</td><td>${despLabel(r)}</td>
    <td>${r.origen === 'web' ? sem(r.semaforo) : '<span style="color:var(--text-secondary)">—</span>'}</td>
    <td ${R}>${money(r.total, r.moneda)}</td><td style="text-align:right;color:${colorEspera(r)}">${espera(r)}</td></tr>`), 'Nada pendiente por ahora 🎉')}</div>`
}

/** "Mapa" del flujo: una columna por estado. "Por retirar" va resaltada con su propio color. */
export function htmlMapaFlujo(rows) {
  const cols = ['cotizacion', 'pk', 'facturado_sin_guia', 'guia_parcial', 'por_retirar']
  const col = e => { const f = FLUJO[e], items = rows.filter(r => r.estado_flujo === e)
    return `<div style="flex:1 1 210px;min-width:210px;border-radius:12px;border:1px solid ${f.c}${e === 'por_retirar' ? ';box-shadow:0 0 0 2px rgba(13,148,136,.25)' : ''};background:var(--bg-secondary,rgba(0,0,0,.03))">
      <div style="padding:8px 12px;border-bottom:1px solid ${f.c};color:${f.c};font-weight:600">${f.i} ${f.t} <span style="float:right">${items.length}</span></div>
      <div style="padding:8px;display:flex;flex-direction:column;gap:8px;max-height:62vh;overflow:auto">${items.map(r => `<div data-url="${esc(destinoBandeja(r) || '')}" data-ref="${esc(r.origen)}:${esc(r.ref_id)}" style="cursor:pointer;padding:8px 10px;border-radius:8px;background:var(--bg-primary);border-left:3px solid ${f.c}">
        <b>${esc(r.cot_numero || r.doc_actual)}</b> <small style="color:var(--text-secondary)">${esc(r.doc_tipo)} ${esc(r.doc_actual)}</small><br>${esc(r.cliente || '')}<br>
        <small>${despLabel(r)} · ${money(r.total, r.moneda)}${r.dias_espera != null ? ` · <span style="color:${colorEspera(r)}">${espera(r)}</span>` : ''}</small></div>`).join('') || '<small style="color:var(--text-secondary)">—</small>'}</div></div>` }
  return `<div class="card"><div style="display:flex;gap:12px;overflow-x:auto;align-items:flex-start">${cols.map(col).join('')}</div>
    <small style="color:var(--text-secondary)">Solo se ven documentos vigentes: un PK anulado junto con su factura desaparece de aquí.</small></div>`
}

export function htmlDetalleCot({ c: r, d, s }, margen, users, yo) {
  const mg = new Map((margen || []).map(m => [m.detalle_id, m]))
  const g = yo.esGestor
  return `<div class="modal-header"><h3 class="modal-title">${esc(r.numero)}</h3><button class="modal-close" onclick="window.closeModal('modal-crm-det')">✕</button></div>
  <div style="padding:16px;display:flex;flex-direction:column;gap:12px;max-height:75vh;overflow:auto">
  <div class="grid grid-2"><div><b>Cliente</b><br>${esc(r.razon_social)}<br><small>${esc(r.contacto_nombre || '')} · ${esc(r.contacto_telefono || '')} · ${esc(r.contacto_email || '')}</small></div>
    <div><b>Entrega</b><br>${esc(r.dir_entrega || '—')} · ${esc(r.distrito_entrega || '')}<br><small>${r.flete_estado ? `Flete: ${r.flete_estado === 'cotizar' ? 'cotizar aparte' : r.flete_estado === 'incluido' ? 'incluido' : 'S/ ' + num(r.flete_soles, 0)}${r.km_aprox != null ? ' · ~' + num(r.km_aprox, 1) + ' km' : ''}` : ''}</small></div></div>
  ${r.notas_cliente ? `<div><b>Notas del cliente</b><br>${esc(r.notas_cliente)}</div>` : ''}
  ${tabla(['Producto', '#Kg', '#P/kg', ...(g ? ['#Costo/kg', '#Margen', 'Semáforo'] : []), '#Importe'], d.map(l => { const m = mg.get(l.id); return `<tr><td>${esc(l.producto_nombre)}<br><small style="color:var(--text-secondary)">${esc(l.color_nombre || '')}</small></td><td ${R}>${num(l.cantidad_kg)}</td><td ${R}>${num(l.precio_unitario)}</td>${g ? `<td ${R}>${m?.costo_kg != null ? num(m.costo_kg) : '—'}</td><td ${R}>${m?.margen_pct != null ? num(m.margen_pct) + '%' : '—'}</td><td>${sem(m?.semaforo)}</td>` : ''}<td ${R}>${num(l.importe)}</td></tr>` }))}
  <div style="text-align:right">Subtotal ${money(r.subtotal, r.moneda)} · IGV ${money(r.igv, r.moneda)} · <b>Total ${money(r.total, r.moneda)}</b></div>
  <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
    <select id="se" style="max-width:170px">${ESTADOS.map(x => `<option value="${x}" ${r.estado === x ? 'selected' : ''}>${lbl(x)}</option>`).join('')}</select>
    <select id="sp" style="max-width:130px">${['pendiente', 'parcial', 'pagado'].map(x => `<option ${r.estado_pago === x ? 'selected' : ''}>${x}</option>`).join('')}</select>
    <button class="btn btn-primary btn-small" id="gs">Guardar estado</button>
    ${users.length ? `<select id="su" style="max-width:200px"><option value="">Sin asignar</option>${users.map(u => `<option value="${u.id}" ${r.vendedor_id === u.id ? 'selected' : ''}>${esc(u.nombre)} (${u.role})</option>`).join('')}</select><button class="btn btn-small" id="ga">Asignar</button>`
      : (!r.vendedor_id ? '<button class="btn btn-small" id="tom">Tomar cotización</button>' : '')}
    ${r.comprobante_path ? '<button class="btn btn-small" id="vc">Ver comprobante</button>' : ''}
    ${r.packing_id ? chip('Ya es cotización ERP', '#16a34a') : '<button class="btn btn-primary btn-small" id="cvpk" title="Crea la cotización COT-xxxx en Ventas → Packing con estos productos y precios">➡ Convertir en cotización ERP</button>'}</div>
  <h4 style="margin:4px 0">Seguimiento</h4>
  <div style="display:flex;gap:8px;flex-wrap:wrap"><select id="nt" style="max-width:130px">${['nota', 'llamada', 'whatsapp', 'correo', 'visita', 'pago'].map(x => `<option>${x}</option>`).join('')}</select>
    <input id="nd" placeholder="Detalle…" style="flex:1;min-width:160px"><input type="date" id="np" title="Próxima acción" style="max-width:150px"><button class="btn btn-small" id="na">Agregar</button></div>
  <ul style="list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:6px">${s.map(x => `<li><b>${esc(x.tipo)}</b> · ${fechaHora(x.created_at)}<br>${esc(x.detalle)}${x.proxima_accion ? `<br><small style="color:var(--text-secondary)">Próx.: ${fecha(x.proxima_accion)}</small>` : ''}</li>`).join('') || '<li style="color:var(--text-secondary)">Sin movimientos</li>'}</ul></div>`
}

export function htmlClientes(cl, agg) {
  return `<div class="card"><input id="cq" placeholder="Buscar cliente o RUC…" style="max-width:280px;margin-bottom:10px">
  <div id="cb">${filasClientes(cl, agg, '')}</div></div>`
}
export function filasClientes(cl, agg, q) {
  return tabla(['RUC', 'Razón social', 'Contacto', '#Cotiz.', '#Cerrado', 'ERP'], cl.filter(c => !q || norm(`${c.ruc} ${c.razon_social}`).includes(q)).map(c => `<tr><td>${esc(c.ruc)}</td><td>${esc(c.razon_social)}</td>
    <td>${esc(c.nombre_contacto || '')}<br><small style="color:var(--text-secondary)">${esc(c.telefono || '')} ${esc(c.email || '')}</small></td><td ${R}>${agg[c.id]?.n || 0}</td><td ${R}>${num(agg[c.id]?.t || 0)}</td><td>${c.contact_id ? chip('Vinculado', '#16a34a') : '—'}</td></tr>`), 'Sin clientes')
}

export function htmlStock(data, q) {
  const por = {}; data.forEach(r => (por[r.item_nombre] ||= []).push(r))
  const rows = Object.entries(por).filter(([n, ls]) => !q || norm(n + ls.map(l => l.numero_lote).join(' ')).includes(norm(q))).map(([n, ls]) =>
    `<tr style="background:var(--bg-secondary,rgba(0,0,0,.04))"><td colspan="2"><b>${esc(n)}</b></td><td ${R}><b>${num(ls.reduce((a, l) => a + Number(l.kg), 0))}</b></td><td colspan="3"></td></tr>` +
    ls.map(l => `<tr><td>&nbsp;&nbsp;${esc(l.numero_lote)}</td><td>${esc(l.almacen)} · ${esc(l.ubicacion)}</td><td ${R}>${num(l.kg)}</td><td ${R}>${num(l.unidades, 0)}</td><td ${R}>${num(l.peso_por_unidad)}</td><td>${fecha(l.fecha_ingreso)}</td></tr>`).join(''))
  return tabla(['Artículo / lote', 'Almacén · ubicación', '#Kg', '#Unid.', '#Kg/unid.', 'Ingreso'], rows, 'Sin stock')
}

// ---- PRECIOS
export function htmlDespacho(r, dias, guias) {
  const sinDatos = !r || !r.n_guias
  const caja = (t, v, sub) => `<div class="kpi-card"><div class="kpi-label">${t}</div><div class="kpi-value">${v}</div><div class="kpi-sub">${sub}</div></div>`
  return `<div class="card-header" style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px"><div class="card-title">🚚 Costo de despacho real (desde las guías)</div>
    <div style="display:flex;gap:6px;align-items:center;font-size:.85rem">Últimos <input type="number" id="pd-dias" value="${dias}" min="7" max="730" style="width:80px"> días <button class="btn btn-small" id="pd-ok">Ver</button></div></div>
  ${sinDatos ? '<p style="color:var(--text-secondary);padding:8px">Aún no hay guías de despacho con gasto enlazado en el periodo. Registra los gastos de cargadores/flete en Tesorería enlazándolos a la guía.</p>' : `
  <div class="grid grid-4">${caja('Por despacho', money(r.por_despacho), `${r.n_guias} guías · (con+sin guía) ÷ guías`)}
   ${caja('Por kg despachado', 'S/ ' + num(r.por_kg, 4), `${num(r.kg, 0)} kg · gasto ÷ kg`)}
   ${caja('Solo gastos con guía', `S/ ${num(r.por_despacho_estricto)} / viaje`, `S/ ${num(r.por_kg_estricto, 4)} por kg`)}
   ${caja('Gasto del periodo', money(Number(r.gasto_con_guia) + Number(r.gasto_sin_guia)), `S/ ${num(r.gasto_sin_guia)} aún sin enlazar a guía`)}</div>
  <details style="margin-top:10px"><summary style="cursor:pointer">Ver detalle por guía</summary>${tabla(['Guía', 'Fecha', '#Kg', '#Gasto S/', '#S/ por kg'], (guias || []).map(g => `<tr><td>${esc(g.numero_guia)}</td><td>${fecha(g.fecha_guia)}</td><td ${R}>${num(g.kg, 0)}</td><td ${R}>${num(g.gasto_pen)}</td><td ${R}>${g.pen_por_kg != null ? num(g.pen_por_kg, 4) : '—'}</td></tr>`), 'Sin guías')}</details>`}`
}

export function htmlConfigPrecios(c, cats, fam) {
  const fm = new Map(fam.map(f => [f.categoria_id, f]))
  return `<div class="card-header"><div class="card-title">⚙️ Reglas de margen</div></div>
  <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px">
   <div class="form-group"><label>Margen objetivo % (sobre el precio)</label><input type="number" id="cp-obj" step="0.1" value="${c.margen_objetivo_pct}"></div>
   <div class="form-group"><label>Margen mínimo %</label><input type="number" id="cp-min" step="0.1" value="${c.margen_minimo_pct}"></div>
   <div class="form-group"><label>Despacho en el costo</label><select id="cp-inc"><option value="1" ${c.incluir_despacho ? 'selected' : ''}>Sumar al costo</option><option value="0" ${!c.incluir_despacho ? 'selected' : ''}>No sumar</option></select></div>
   <div class="form-group"><label>Base del despacho</label><select id="cp-base"><option value="kg" ${c.despacho_base === 'kg' ? 'selected' : ''}>Por kg</option><option value="despacho" ${c.despacho_base === 'despacho' ? 'selected' : ''}>Por despacho (se reparte en el pedido)</option></select></div>
   <div class="form-group"><label>Periodo de cálculo (días)</label><input type="number" id="cp-dias" value="${c.periodo_dias}"></div>
   <div class="form-group"><label>Flete: cotizar aparte sobre (kg)</label><input type="number" id="cp-fkg" value="${c.flete_kg_max}"></div></div>
  <button class="btn btn-primary btn-small" id="cp-save">Guardar reglas</button>
  <details style="margin-top:12px"><summary style="cursor:pointer">Margen por familia (vacío = usa el general)</summary>
   ${tabla(['Familia', '#Objetivo %', '#Mínimo %'], cats.map(k => { const f = fm.get(k.id); return `<tr><td>${esc(k.nombre)}</td><td ${R}><input class="fam-o" data-c="${k.id}" type="number" step="0.1" value="${f?.margen_objetivo_pct ?? ''}" style="width:90px"></td><td ${R}><input class="fam-m" data-c="${k.id}" type="number" step="0.1" value="${f?.margen_minimo_pct ?? ''}" style="width:90px"></td></tr>` }))}
   <button class="btn btn-small" id="fam-save" style="margin-top:8px">Guardar familias</button></details>`
}

export function htmlPrecios(rows, cfgMoneda) {
  const mon = rows[0]?.moneda || cfgMoneda || 'PEN'
  return `<div class="card-header" style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:8px"><div class="card-title">💲 Precio de lista por lote (${mon}/kg ${rows[0]?.igv_incluido ? 'con IGV' : 'sin IGV'})</div>
   <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center"><input id="pq" placeholder="Buscar artículo o lote…" style="max-width:220px"><label style="font-weight:normal;display:flex;gap:4px;align-items:center"><input type="checkbox" id="p-stock" checked style="width:auto">Solo con stock</label>
   <button class="btn btn-primary btn-small" id="p-apl-sel">Aplicar seleccionados</button><button class="btn btn-small" id="p-apl-all">Aplicar a todos (margen vigente)</button></div></div>
   <p style="font-size:.8rem;color:var(--text-secondary)">Costo = costo comercial del lote × TC${rows[0]?.tc ? ' (' + num(rows[0].tc, 4) + ')' : ''} + despacho. Cambia el margen del lote y pulsa Aplicar: el precio se calcula en el servidor y el catálogo web lo toma solo.</p>
   <div id="p-tabla">${filasPrecios(rows, '')}</div>`
}
export function filasPrecios(rows, q) {
  return tabla(['', 'Artículo / lote', '#Stock kg', '#Costo base', '#Despacho', '#Costo total', '#Margen %', '#Precio sugerido', '#Precio actual', '#Margen real', 'Semáforo'],
    rows.filter(r => !q || norm(`${r.item_nombre} ${r.numero_lote} ${r.categoria}`).includes(q)).map(r => `<tr>
    <td><input type="checkbox" class="p-sel" data-l="${r.lote_id}" style="width:auto"></td>
    <td>${esc(r.item_nombre)}<br><small style="color:var(--text-secondary)">${esc(r.numero_lote)} · ${esc(r.categoria || '')}${r.publicado ? ' · 🌐' : ''}</small></td>
    <td ${R}>${num(r.stock_kg, 0)}</td><td ${R}>${r.costo_base != null ? num(r.costo_base) : '—'}</td><td ${R}>${num(r.despacho_kg, 3)}</td><td ${R}>${r.costo_total != null ? num(r.costo_total) : '—'}</td>
    <td ${R}><input type="number" class="p-m" data-l="${r.lote_id}" step="0.1" value="${r.margen_aplicado_pct}" style="width:80px" title="${r.margen_lista_pct == null ? 'heredado' : 'fijado en este lote'}"></td>
    <td ${R}>${r.precio_sugerido != null ? num(r.precio_sugerido) : '—'}</td><td ${R}>${r.precio_actual != null ? '<b>' + num(r.precio_actual) + '</b>' : '—'}</td>
    <td ${R}>${r.margen_real_pct != null ? num(r.margen_real_pct) + '%' : '—'}</td><td>${sem(r.semaforo)}</td></tr>`), 'Sin lotes con costo')
}

// ---- CATÁLOGO WEB
export function htmlCatalogo() {
  return `<div class="card"><div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px"><input id="iq" placeholder="Buscar artículo del ERP…" style="max-width:260px">
   <select id="is" style="max-width:170px"><option value="">Todos</option><option value="pub">Publicados</option><option value="no">No publicados</option></select>
   <button class="btn btn-primary btn-small" id="ps">Publicar artículos con stock</button><button class="btn btn-small" id="av">Auto-vincular fotos</button>
   <a class="btn btn-small" href="crm/index.html" target="_blank" rel="noopener">🛍 Ver catálogo web ↗</a></div>
   <p style="font-size:.8rem;color:var(--text-secondary)">Los artículos vienen del ERP. El precio sale del lote (pestaña Precios); el «precio manual» solo sirve para forzar uno.</p><div id="cb"></div></div>`
}
export function filasCatalogo(items, cfg, q, solo, imgs) {
  const l = items.filter(i => (!q || norm(i.nombre).includes(q)) && (!solo || (solo === 'pub' ? cfg.get(i.id)?.publicado : !cfg.get(i.id)?.publicado)))
  return tabla(['Estado', 'Artículo', 'Grupo', '#Precio manual', 'Foto'], l.map(i => { const c = cfg.get(i.id); const im = imgs(c?.fotos); return `<tr data-i="${i.id}" style="cursor:pointer"><td>${c?.publicado ? chip('Publicado', '#16a34a') : chip('Oculto')}</td><td>${esc(i.nombre)}</td><td>${esc(c?.grupo || '')}</td><td ${R}>${c?.precio_lista ? num(c.precio_lista) : '—'}</td><td>${im.length ? `<img src="${esc(im[0])}" alt="" style="height:34px;border-radius:4px">` : ''}</td></tr>` }), 'Sin artículos')
}
export function htmlEditarItem(item, v, manifest) {
  const f = (k, l, t = 'text', ex = '') => `<div class="form-group"><label>${l}</label><input name="${k}" type="${t}" ${ex} value="${esc(v[k] ?? '')}"></div>`
  return `<div class="modal-header"><h3 class="modal-title">${esc(item.nombre)}</h3><button class="modal-close" onclick="window.closeModal('modal-crm-cat')">✕</button></div>
  <form id="ef" style="padding:16px;display:grid;grid-template-columns:1fr 1fr;gap:10px;max-height:75vh;overflow:auto">
   <label style="grid-column:1/-1;font-weight:normal"><input type="checkbox" name="publicado" ${v.publicado ? 'checked' : ''} style="width:auto"> Publicado en el catálogo web</label>
   ${f('nombre_web', 'Nombre web (vacío = nombre ERP)')}${f('grupo', 'Grupo / categoría')}${f('color_nombre', 'Color')}${f('color_no', 'N° de color')}${f('color_hex', 'Color hex #RRGGBB')}
   ${f('precio_lista', 'Precio manual por kg (vacío = usa el del lote)', 'number', 'step="0.01"')}${f('peso_caja_kg', 'Peso por caja (kg)', 'number', 'step="0.01"')}${f('conos_por_caja', 'Conos por caja', 'number')}${f('stock_minimo_kg', 'Poco stock bajo (kg)', 'number')}${f('orden_display', 'Orden', 'number')}
   <div class="form-group" style="grid-column:1/-1"><label>Descripción</label><textarea name="descripcion_web" rows="2">${esc(v.descripcion_web || '')}</textarea></div>
   <div class="form-group" style="grid-column:1/-1"><label>Aplicaciones</label><textarea name="aplicaciones" rows="2">${esc(v.aplicaciones || '')}</textarea></div>
   <div class="form-group" style="grid-column:1/-1"><label>Fotos</label><div id="fs" style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:6px"></div>
    <select id="fm"><option value="">+ Agregar del catálogo viejo…</option>${manifest.map(m => `<option value="${esc(m.ruta)}">${esc(m.slug || m.archivo)}</option>`).join('')}</select>
    <input id="fu" type="file" accept="image/*" style="margin-top:6px"></div>
   <div id="er" style="grid-column:1/-1"></div><div style="grid-column:1/-1"><button class="btn btn-primary">Guardar</button></div></form>`
}

// ---- WEB + FLETE
export function htmlWeb(c, zonas, reglas) {
  return `<div class="card"><div class="card-header"><div class="card-title">🌐 Catálogo web · ${esc(c.titulo || '')}</div></div>
  <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px">
   <div class="form-group"><label>WhatsApp (dígitos con país)</label><input id="w-wsp" value="${esc(c.whatsapp || '')}" placeholder="51956217972"></div>
   <div class="form-group"><label>Moneda de precios</label><select id="w-mon"><option ${c.moneda_precio === 'PEN' ? 'selected' : ''}>PEN</option><option ${c.moneda_precio === 'USD' ? 'selected' : ''}>USD</option></select></div>
   <div class="form-group"><label>Poco stock bajo (kg)</label><input id="w-poco" type="number" value="${esc(c.semaforo_poco_kg)}"></div>
   <div class="form-group" style="grid-column:1/-1"><label>Título</label><input id="w-tit" value="${esc(c.titulo || '')}"></div>
   <div class="form-group" style="grid-column:1/-1"><label>Mensaje de bienvenida</label><textarea id="w-msg" rows="2">${esc(c.mensaje || '')}</textarea></div>
   <label style="font-weight:normal"><input type="checkbox" id="w-mp" ${c.mostrar_precios ? 'checked' : ''} style="width:auto"> Mostrar precios al público</label>
   <label style="font-weight:normal"><input type="checkbox" id="w-igv" ${c.igv_incluido ? 'checked' : ''} style="width:auto"> Precio incluye IGV</label></div>
  <h4>Cuentas bancarias (al confirmar la cotización)</h4><div id="w-cu"></div><button class="btn btn-small" id="w-ac">+ Agregar cuenta</button>
  <div style="margin-top:10px"><button class="btn btn-primary" id="w-save">Guardar configuración web</button></div></div>
  <div class="card" style="margin-top:14px"><div class="card-header"><div class="card-title">🚚 Flete por distrito</div></div>
   <p style="font-size:.8rem;color:var(--text-secondary)">Km en línea recta desde San Juan de Lurigancho (aproximados: ajústalos si conoces la ruta real). Más de la cantidad máxima de kg, o un distrito no listado, se cotiza aparte.</p>
   <h4>Tramos</h4>${tabla(['Hasta km', 'Recargo S/', 'Etiqueta', ''], reglas.map(r => `<tr><td><input class="r-km" data-id="${r.id}" type="number" step="0.1" value="${r.hasta_km}" style="width:90px"></td><td><input class="r-rec" data-id="${r.id}" type="number" value="${r.recargo_pen}" style="width:90px"></td><td><input class="r-et" data-id="${r.id}" value="${esc(r.etiqueta || '')}"></td><td><button class="btn btn-small r-del" data-id="${r.id}">Quitar</button></td></tr>`))}
   <button class="btn btn-small" id="r-add">+ Tramo</button> <button class="btn btn-primary btn-small" id="r-save">Guardar tramos</button>
   <h4 style="margin-top:14px">Simulador</h4><div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center"><input id="s-dis" placeholder="Distrito" list="dl-dis" style="max-width:200px"><input id="s-kg" type="number" placeholder="kg" value="500" style="max-width:100px"><button class="btn btn-small" id="s-go">Calcular</button><span id="s-res"></span></div>
   <datalist id="dl-dis">${zonas.map(z => `<option value="${esc(z.distrito)}">`).join('')}</datalist>
   <h4 style="margin-top:14px">Distritos (${zonas.length})</h4>
   ${tabla(['Distrito', '#Km', 'Activo'], zonas.map(z => `<tr><td>${esc(z.distrito)}</td><td ${R}><input class="z-km" data-id="${z.id}" type="number" step="0.1" value="${z.km}" style="width:90px"></td><td><input class="z-on" data-id="${z.id}" type="checkbox" ${z.activo ? 'checked' : ''} style="width:auto"></td></tr>`))}
   <button class="btn btn-primary btn-small" id="z-save" style="margin-top:8px">Guardar distancias</button></div>`
}

export const htmlMapa = () => `<div class="card" style="text-align:center;padding:50px"><h3>🗺 Mapa de clientes y entregas</h3><p style="color:var(--text-secondary)">En desarrollo. Mostrará cotizaciones y entregas por distrito.</p></div>`
