// ============================================================================
// shared/imprimir-reporte.js — «Imprimir reporte» (PDF A4 vertical) COMPARTIDO
// Un solo modal para TODOS los reportes (Centro de Estadísticas y pestañas Reportes de cada módulo).
// Cada motor entrega una "foto" (snapshot) con funciones perezosas; aquí se elige qué incluir
// (checkbox por sección), se arma el HTML con la cabecera multiempresa y se descarga el PDF
// reutilizando shared/pdf-documento.js (html2canvas + jsPDF, saltos de página limpios).
//
// snapshot = {
//   id, titulo, pregunta?, modulo?,
//   filtros:        () => string[]                         // «Período: 01/10 → 31/10», «Cliente: 2 sel.»…
//   kpis:           () => [{ label, texto, delta?:{txt,mala} }]
//   hallazgos:      () => string[]                         // frases de interpretación (texto plano)
//   graficos:       [{ id, nombre, ok, actual?, img: async () => dataURL }]
//   tabla:          ({ filas }) => { cab:[], filas:[{ c:[], n?:nivel, b?:negrita }], total?:[], nota? }
//   observaciones:  () => [{ nivel, titulo, detalle, accion }]
// }
// ============================================================================
import { emisorPDF, textoSobre, tinte, _esc, descargarPDFDesdeHTML, cssCabeceraPDF, htmlCabeceraPDF } from './pdf-documento.js'
import { empresaTrabajo } from '../empresa.js'
import { getCurrentUser } from '../auth-supabase.js'
import { showToast } from '../helpers.js'
import { NIVELES } from './observaciones-reporte.js'

const SECCIONES = [
  { g: 'Presentación', items: [
    { k: 'portada', ico: '🏢', t: 'Encabezado de la empresa', d: 'Logo, razón social, RUC, título del reporte, fecha y quién lo emitió.', def: true },
    { k: 'filtros', ico: '🎯', t: 'Filtros aplicados', d: 'Período, búsqueda y selecciones activas: el PDF queda trazable (qué se miró y qué no).', def: true }
  ] },
  { g: 'Resumen', items: [
    { k: 'kpis', ico: '🔢', t: 'Indicadores clave', d: 'Las tarjetas de cifras principales con su variación frente al período anterior.', def: true },
    { k: 'hallazgos', ico: '💡', t: 'Frases de interpretación', d: 'Hallazgos automáticos en lenguaje simple: qué subió, quién lidera, cuánto pesa el 80 %.', def: true }
  ] },
  { g: 'Gráficos', items: [
    { k: 'actual', ico: '📊', t: 'Gráfico actual', d: 'El gráfico que estás viendo ahora, con su medida y agrupación.', def: true },
    { k: 'vistas', ico: '🧩', t: 'Otras vistas', d: 'Elige cuáles sumar: Evolución, Pareto, Composición, Dona, Mapa de calor, Cascada, Apilado (solo las que aplican a este reporte).', def: false, sub: 'vistas' }
  ] },
  { g: 'Detalle', items: [
    { k: 'tabla', ico: '📋', t: 'Tabla de detalle', d: 'La tabla tal como está agrupada, con totales; el encabezado se repite en cada hoja.', def: true, sub: 'filas' }
  ] },
  { g: 'Control', items: [
    { k: 'observaciones', ico: '🔎', t: 'Observaciones y pendientes', d: 'Alarmas, irregularidades y curiosidades detectadas, con acción sugerida y casilla de responsable/fecha para ponerlo al día.', def: true },
    { k: 'firmas', ico: '✍️', t: 'Cuadro de revisión', d: 'Espacio para «Elaborado / Revisado / V°B°» al final del reporte.', def: false }
  ] }
]
const PRESETS = [
  ['⚡ Ejecutivo', ['portada', 'filtros', 'kpis', 'hallazgos', 'actual', 'observaciones']],
  ['📚 Completo', ['portada', 'filtros', 'kpis', 'hallazgos', 'actual', 'vistas', 'tabla', 'observaciones', 'firmas']],
  ['🧾 Solo datos', ['portada', 'filtros', 'tabla']],
  ['🚨 Pendientes', ['portada', 'filtros', 'observaciones', 'firmas']]
]

function css() {
  if (document.getElementById('irCss')) return
  const s = document.createElement('style'); s.id = 'irCss'
  s.textContent = `
  .ir-ov{position:fixed;inset:0;z-index:4000;background:rgba(2,6,23,.62);display:flex;align-items:center;justify-content:center;padding:18px;backdrop-filter:blur(2px)}
  .ir-m{background:var(--bg-secondary,#1e293b);color:var(--text-primary,#e5e7eb);border:1px solid var(--border-color,#334155);border-radius:16px;width:min(760px,100%);max-height:92vh;display:flex;flex-direction:column;box-shadow:0 24px 60px rgba(0,0,0,.45)}
  .ir-h{display:flex;justify-content:space-between;gap:12px;padding:18px 22px 12px;border-bottom:1px solid var(--border-color,#334155)}
  .ir-h h3{margin:0;font-size:1.15rem}.ir-h p{margin:2px 0 0;color:var(--text-secondary,#94a3b8);font-size:.85rem}
  .ir-x{background:none;border:0;color:var(--text-secondary,#94a3b8);font-size:1.5rem;cursor:pointer;line-height:1}
  .ir-b{padding:14px 22px;overflow:auto;flex:1}
  .ir-pre{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:12px}.ir-pre small{color:var(--text-secondary,#94a3b8);margin-right:2px}
  .ir-pre button{border:1px solid var(--border-color,#334155);background:var(--bg-tertiary,#0f172a);color:inherit;border-radius:999px;padding:5px 12px;font-size:.82rem;cursor:pointer}
  .ir-pre button:hover{border-color:#3b82f6;color:#60a5fa}
  .ir-g{margin:14px 0 6px;font-size:.72rem;letter-spacing:.08em;text-transform:uppercase;color:var(--text-secondary,#94a3b8);font-weight:700}
  .ir-i{display:flex;gap:12px;align-items:flex-start;padding:10px 12px;border:1px solid var(--border-color,#334155);border-radius:12px;margin-bottom:8px;cursor:pointer;transition:.15s;background:var(--bg-tertiary,rgba(15,23,42,.35))}
  .ir-i:hover{border-color:#3b82f6}.ir-i.on{border-color:#3b82f6;background:color-mix(in srgb,#3b82f6 11%,transparent)}.ir-i.off{opacity:.45;cursor:not-allowed}
  .ir-i input[type=checkbox]{margin-top:4px;width:17px;height:17px;accent-color:#3b82f6;flex:none}
  .ir-ico{font-size:1.25rem;line-height:1.2;flex:none}.ir-t{font-weight:700;font-size:.93rem}.ir-d{font-size:.8rem;color:var(--text-secondary,#94a3b8);margin-top:2px;line-height:1.35}
  .ir-sub{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}.ir-sub label{display:flex;gap:6px;align-items:center;font-size:.8rem;border:1px solid var(--border-color,#334155);border-radius:8px;padding:3px 9px;cursor:pointer}
  .ir-sub select{background:var(--bg-primary,#0f172a);color:inherit;border:1px solid var(--border-color,#334155);border-radius:8px;padding:3px 8px;font-size:.8rem}
  .ir-f{display:flex;justify-content:space-between;align-items:center;gap:10px;padding:12px 22px;border-top:1px solid var(--border-color,#334155)}
  .ir-f small{color:var(--text-secondary,#94a3b8)}.ir-f .bt{display:flex;gap:8px}
  .ir-btn{border:1px solid var(--border-color,#334155);background:var(--bg-tertiary,#0f172a);color:inherit;border-radius:10px;padding:9px 16px;cursor:pointer;font-weight:600}
  .ir-btn.p{background:#2563eb;border-color:#2563eb;color:#fff}.ir-btn:disabled{opacity:.6;cursor:wait}
  @media(max-width:560px){.ir-f{flex-direction:column;align-items:stretch}}`
  document.head.appendChild(s)
}

const clavePref = id => 'zv_imprimir_' + id
function leerPref(id) { try { return JSON.parse(localStorage.getItem(clavePref(id)) || 'null') } catch { return null } }
function guardarPref(id, v) { try { localStorage.setItem(clavePref(id), JSON.stringify(v)) } catch { /* sin almacenamiento */ } }

export function abrirImprimirReporte(snap) {
  css(); document.getElementById('irOv')?.remove()
  const pref = leerPref(snap.id) || {}
  const graf = snap.graficos || []
  const tieneKpis = (() => { try { return (snap.kpis?.() || []).length > 0 } catch { return false } })()
  const disp = { kpis: tieneKpis, hallazgos: !!snap.hallazgos, actual: graf.some(g => g.ok), vistas: graf.filter(g => g.ok).length > 1, tabla: !!snap.tabla, observaciones: !!snap.observaciones }
  const sel = new Set(pref.sel || SECCIONES.flatMap(g => g.items).filter(i => i.def).map(i => i.k))
  const vistasSel = new Set(pref.vistas || [])
  let filas = pref.filas || '30'

  const subHtml = k => {
    if (k === 'vistas') return `<div class="ir-sub">${graf.filter(g => g.ok).map(g => `<label><input type="checkbox" data-v="${_esc(g.id)}" ${vistasSel.has(g.id) ? 'checked' : ''}>${_esc(g.nombre)}</label>`).join('')}</div>`
    if (k === 'filas') return `<div class="ir-sub"><label>Filas: <select data-filas><option value="15">Top 15</option><option value="30">Top 30</option><option value="60">Top 60</option><option value="0">Todas</option></select></label></div>`
    return ''
  }
  const ov = document.createElement('div'); ov.className = 'ir-ov'; ov.id = 'irOv'
  ov.innerHTML = `<div class="ir-m" role="dialog" aria-label="Imprimir reporte">
    <div class="ir-h"><div><h3>🖨️ Imprimir reporte</h3><p>${_esc(snap.titulo)} · PDF A4 vertical</p></div><button class="ir-x" type="button" aria-label="Cerrar">×</button></div>
    <div class="ir-b">
      <div class="ir-pre"><small>Atajos:</small>${PRESETS.map(([n], i) => `<button type="button" data-p="${i}">${n}</button>`).join('')}</div>
      ${SECCIONES.map(g => `<div class="ir-g">${g.g}</div>${g.items.map(i => {
        const ok = i.k === 'portada' || i.k === 'filtros' || i.k === 'firmas' ? true : disp[i.k]
        return `<label class="ir-i ${sel.has(i.k) && ok ? 'on' : ''} ${ok ? '' : 'off'}" data-k="${i.k}">
          <input type="checkbox" ${sel.has(i.k) && ok ? 'checked' : ''} ${ok ? '' : 'disabled'}>
          <span class="ir-ico">${i.ico}</span><span style="flex:1"><div class="ir-t">${i.t}</div><div class="ir-d">${ok ? i.d : 'No aplica a este reporte.'}</div>${i.sub && ok ? subHtml(i.sub) : ''}</span></label>`
      }).join('')}`).join('')}
    </div>
    <div class="ir-f"><small id="irCuenta"></small><div class="bt"><button class="ir-btn" type="button" data-c>Cancelar</button><button class="ir-btn p" type="button" id="irGo">📄 Generar PDF</button></div></div>
  </div>`
  document.body.appendChild(ov)
  const $ = s => ov.querySelector(s)
  const cerrar = () => ov.remove()
  const selFilas = $('[data-filas]'); if (selFilas) selFilas.value = filas

  const refrescar = () => {
    ov.querySelectorAll('.ir-i').forEach(l => { const k = l.dataset.k, cb = l.querySelector('input[type=checkbox]'); if (!cb.disabled) { cb.checked = sel.has(k); l.classList.toggle('on', cb.checked) } })
    const n = [...sel].filter(k => ov.querySelector(`.ir-i[data-k="${k}"] input:not(:disabled)`)).length
    $('#irCuenta').textContent = `${n} sección(es) seleccionada(s)`
    $('#irGo').disabled = n === 0
  }
  ov.querySelectorAll('.ir-i').forEach(l => {
    l.addEventListener('click', e => {
      if (l.classList.contains('off')) return
      if (e.target.closest('.ir-sub')) { if (e.target.matches('[data-v]')) { e.target.checked ? vistasSel.add(e.target.dataset.v) : vistasSel.delete(e.target.dataset.v); if (e.target.checked) sel.add('vistas'); refrescar() } return }
      if (e.target.tagName !== 'INPUT') e.preventDefault()
      const k = l.dataset.k; sel.has(k) ? sel.delete(k) : sel.add(k)
      if (k === 'vistas' && sel.has('vistas') && !vistasSel.size) graf.filter(g => g.ok && !g.actual).slice(0, 3).forEach(g => { vistasSel.add(g.id); const c = l.querySelector(`[data-v="${g.id}"]`); if (c) c.checked = true })
      refrescar()
    })
  })
  selFilas?.addEventListener('change', () => { filas = selFilas.value })
  ov.querySelectorAll('[data-p]').forEach(b => b.addEventListener('click', () => { sel.clear(); PRESETS[+b.dataset.p][1].forEach(k => sel.add(k)); if (sel.has('vistas') && !vistasSel.size) graf.filter(g => g.ok).forEach(g => { vistasSel.add(g.id); const c = ov.querySelector(`[data-v="${g.id}"]`); if (c) c.checked = true }); refrescar() }))
  $('.ir-x').addEventListener('click', cerrar); $('[data-c]').addEventListener('click', cerrar)
  ov.addEventListener('mousedown', e => { if (e.target === ov) cerrar() })
  refrescar()

  $('#irGo').addEventListener('click', async () => {
    const btn = $('#irGo'); btn.disabled = true
    const estado = t => { btn.textContent = '⏳ ' + t }
    try {
      guardarPref(snap.id, { sel: [...sel], vistas: [...vistasSel], filas })
      const permitidas = [...sel].filter(k => ov.querySelector(`.ir-i[data-k="${k}"] input:not(:disabled)`))
      await generarPDF(snap, new Set(permitidas), vistasSel, +filas, estado)
      cerrar()
    } catch (e) { console.error('imprimir-reporte', e); showToast('No se pudo generar el PDF: ' + (e.message || e), 'danger'); btn.disabled = false; btn.textContent = '📄 Generar PDF' }
  })
}

async function generarPDF(snap, sel, vistasSel, nFilas, estado) {
  estado('Preparando…')
  const E = await emisorPDF({ empresa_id: empresaTrabajo() })
  const C = E.color, CT = textoSobre(C), C10 = tinte(C, 0.10), C25 = tinte(C, 0.25)
  const user = getCurrentUser()?.nombre || ''
  const ahora = new Date(), fecha = ahora.toLocaleDateString('es-PE') + ' ' + ahora.toLocaleTimeString('es-PE', { hour: '2-digit', minute: '2-digit' })
  const sec = (ico, titulo, cuerpo) => `<div class="sec"><div class="h">${ico} ${_esc(titulo)}</div>${cuerpo}</div>`
  const partes = []

  if (sel.has('portada')) {
    partes.push(htmlCabeceraPDF(E, { colorTitulo: C, titulo: 'REPORTE', numero: snap.modulo || '' }))
    partes.push(`<div class="tit"><h1>${_esc(snap.titulo)}</h1>${snap.pregunta ? `<div class="preg">❓ ${_esc(snap.pregunta)}</div>` : ''}<div class="meta">Emitido el ${_esc(fecha)}${user ? ' · por ' + _esc(user) : ''}</div></div>`)
  } else partes.push(`<div class="tit"><h1>${_esc(snap.titulo)}</h1><div class="meta">${_esc(E.nombre)} · ${_esc(fecha)}</div></div>`)

  if (sel.has('filtros')) {
    const f = (snap.filtros?.() || []).filter(Boolean)
    partes.push(sec('🎯', 'Filtros aplicados', f.length ? `<div class="chips">${f.map(x => `<span>${_esc(x)}</span>`).join('')}</div>` : '<div class="mut">Sin filtros: se incluye toda la información disponible.</div>'))
  }
  if (sel.has('kpis')) {
    estado('Indicadores…')
    const k = snap.kpis?.() || []
    if (k.length) partes.push(sec('🔢', 'Indicadores clave', `<div class="kpis">${k.map(x => `<div class="kpi"><div class="kl">${_esc(x.label)}</div><div class="kv">${_esc(x.texto)}</div>${x.delta ? `<div class="kd ${x.delta.mala ? 'mal' : 'bien'}">${_esc(x.delta.txt)}</div>` : ''}${x.sub && !x.delta ? `<div class="kd" style="color:#6b7280;font-weight:400">${_esc(x.sub)}</div>` : ''}</div>`).join('')}</div>`))
  }
  if (sel.has('hallazgos')) {
    const h = snap.hallazgos?.() || []
    if (h.length) partes.push(sec('💡', 'Qué dicen los datos', `<ul class="ul">${h.map(x => `<li>${_esc(x)}</li>`).join('')}</ul>`))
  }
  const graf = snap.graficos || []
  const lista = []
  if (sel.has('actual')) { const a = graf.find(g => g.actual && g.ok) || graf.find(g => g.ok); if (a) lista.push(a) }
  if (sel.has('vistas')) graf.filter(g => g.ok && vistasSel.has(g.id) && !lista.includes(g)).forEach(g => lista.push(g))
  for (let i = 0; i < lista.length; i++) {
    estado(`Dibujando gráfico ${i + 1}/${lista.length}…`)
    let img = null; try { img = await lista[i].img() } catch (e) { console.warn('grafico', lista[i].id, e) }
    partes.push(sec('📊', lista[i].nombre + (lista[i].detalle ? ' — ' + lista[i].detalle : ''), img ? `<img class="gr" src="${img}">` : '<div class="mut">No se pudo dibujar este gráfico con los filtros actuales.</div>'))
  }
  if (sel.has('tabla')) {
    estado('Armando tabla…')
    const t = snap.tabla?.({ filas: nFilas })
    if (t && t.filas.length) {
      const ind = n => (n || 0) * 14
      const cuerpo = t.filas.map(f => `<tr class="${f.b ? 'b' : ''}">${f.c.map((c, i) => `<td class="${i ? 'n' : ''}"${i === 0 && f.n ? ` style="padding-left:${6 + ind(f.n)}px"` : ''}>${_esc(c)}</td>`).join('')}</tr>`).join('')
      partes.push(`<div class="sec"><div class="h">📋 Detalle</div></div><table class="dt"><thead><tr>${t.cab.map((c, i) => `<th class="${i ? 'n' : ''}">${_esc(c)}</th>`).join('')}</tr></thead><tbody>${cuerpo}</tbody>${t.total ? `<tfoot><tr class="tot">${t.total.map((c, i) => `<td class="${i ? 'n' : ''}">${_esc(c)}</td>`).join('')}</tr></tfoot>` : ''}</table>${t.nota ? `<div class="mut" style="margin-top:4px">${_esc(t.nota)}</div>` : ''}`)
    }
  }
  if (sel.has('observaciones')) {
    estado('Analizando observaciones…')
    const o = snap.observaciones?.() || []
    const cnt = n => o.filter(x => x.nivel === n).length
    const resumen = o.length ? `<div class="chips">${['alarma', 'revisar', 'curioso'].filter(n => cnt(n)).map(n => `<span style="border-color:${NIVELES[n].color};color:${NIVELES[n].color}">${NIVELES[n].ico} ${cnt(n)} ${NIVELES[n].txt.toLowerCase()}${cnt(n) > 1 && n !== 'revisar' ? 's' : ''}</span>`).join('')}</div>` : ''
    partes.push(`<div class="sec"><div class="h">🔎 Observaciones y pendientes</div><div class="mut">Indicadores detectados automáticamente con los datos y filtros de este reporte. Cada punto debe tener un responsable y una fecha de regularización.</div>${resumen}</div>`)
    if (!o.length) partes.push('<div class="ok">✅ No se detectaron irregularidades con los filtros actuales. Revisar igualmente los pendientes propios del módulo.</div>')
    else partes.push(`<table class="ob"><tbody>${o.map(x => { const N = NIVELES[x.nivel]; return `<tr><td style="width:6px;background:${N.color};padding:0"></td><td style="background:${N.bg}"><div class="ot"><span>${N.ico}</span> <b>${_esc(x.titulo)}</b> <i style="color:${N.color}">${N.txt}</i></div><div class="od">${_esc(x.detalle)}</div>${x.accion ? `<div class="oa">→ ${_esc(x.accion)}</div>` : ''}<div class="of">☐ Resuelto &nbsp;·&nbsp; Responsable: ______________ &nbsp;·&nbsp; Fecha límite: ___/___/______</div></td></tr>` }).join('')}</tbody></table>`)
  }
  if (sel.has('firmas')) partes.push(`<div class="firmas"><div><span></span>Elaborado por</div><div><span></span>Revisado por</div><div><span></span>V°B° Gerencia</div></div>`)

  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    *{box-sizing:border-box} body{font-family:Arial,Helvetica,sans-serif;color:#111827;font-size:11px}
    ${cssCabeceraPDF(C, CT)}
    .tit{margin:14px 0 10px;padding-bottom:8px;border-bottom:2px solid ${C}} .tit h1{margin:0;font-size:20px;color:${C}} .preg{margin-top:4px;font-size:12px;color:#374151;font-style:italic} .meta{margin-top:4px;color:#6b7280;font-size:10px}
    .sec{margin-top:12px} .h{font-size:13px;font-weight:700;color:${C};border-bottom:1px solid ${C25};padding-bottom:3px;margin-bottom:7px}
    .chips span{display:inline-block;border:1px solid #d1d5db;border-radius:999px;padding:3px 10px;margin:0 5px 5px 0;font-size:10px;background:#f9fafb} .mut{color:#6b7280;font-size:10px}
    .kpis{display:flex;flex-wrap:wrap;gap:8px} .kpi{flex:1 1 150px;border:1px solid ${C25};border-left:4px solid ${C};border-radius:8px;padding:8px 10px;background:${C10}} .kl{font-size:9px;text-transform:uppercase;letter-spacing:.05em;color:#4b5563} .kv{font-size:17px;font-weight:700;margin-top:2px} .kd{font-size:9.5px;margin-top:2px;font-weight:700} .kd.bien{color:#059669} .kd.mal{color:#dc2626}
    .ul{margin:0;padding-left:16px;line-height:1.6;font-size:11px} .gr{display:block;width:100%;border:1px solid #e5e7eb;border-radius:8px}
    table{border-collapse:collapse;width:100%} .dt th{background:${C};color:${CT};padding:6px;font-size:10px;text-align:left} .dt td{padding:5px 6px;border-bottom:1px solid #e5e7eb;font-size:10px} .dt tr:nth-child(even) td{background:#f9fafb} .dt .n{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap} .dt tr.b td{font-weight:700;background:${C10}} .dt .tot td{font-weight:800;border-top:2px solid ${C};background:${C10}}
    .ob td{padding:8px 10px;border-bottom:2px solid #fff;vertical-align:top} .ot{font-size:11.5px} .ot i{font-size:9px;font-style:normal;font-weight:700;text-transform:uppercase;margin-left:4px} .od{margin-top:2px;color:#374151} .oa{margin-top:3px;color:#111827;font-weight:700} .of{margin-top:6px;color:#6b7280;font-size:9.5px}
    .ok{margin-top:8px;padding:10px 12px;border-radius:8px;background:#ecfdf5;color:#065f46;font-weight:700}
    .firmas{display:flex;gap:30px;margin-top:46px;padding:0 10px} .firmas div{flex:1;text-align:center;font-size:10px;color:#374151} .firmas span{display:block;border-top:1px solid #111827;margin-bottom:4px;height:1px}
  </style></head><body>${partes.join('')}</body></html>`
  estado('Generando PDF…')
  const nombre = `${String(snap.titulo || 'reporte').replace(/[^\w]+/g, '_')}_${ahora.toISOString().slice(0, 10)}.pdf`
  await descargarPDFDesdeHTML(html, nombre, { numerar: `${E.nombre} · ${snap.titulo}` })
}
