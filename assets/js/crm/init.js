// CAPA 3 · FLUJO — pestañas, estado y eventos del módulo CRM.
import { showToast } from '../helpers.js'
import { initModuleNavDropdowns } from '../main.js'
import { empresaTrabajo, contextoEmpresaListo } from '../empresa.js'
import { empresasActivasCtx } from '../supabase-client.js'
import * as D from './crm-data.js'
import * as U from './crm-ui.js'

const $ = (s, r = document) => r.querySelector(s)
const $$ = (s, r = document) => [...r.querySelectorAll(s)]
const vista = n => $('#crm-' + n)
let yo = null, emp = null, tab = 'cot', timer = null
const S = { fEst: '', fQ: '', fMias: false, dias: null }
const fail = (e) => showToast(e?.message || String(e), 'error')

async function esperarEmpresa() {
  for (let i = 0; i < 50 && !contextoEmpresaListo(); i++) await new Promise(r => setTimeout(r, 100))
  const t = empresaTrabajo(); return Number(t?.id ?? t) || null
}

// ---------- pestañas ----------
const TABS = { cot: tCot, cli: tCli, stk: tStk, pre: tPre, cat: tCat, web: tWeb, map: tMapa, doc: tDoc }
function ir(t) {
  if (!TABS[t]) t = 'cot'
  if (['pre', 'cat', 'web'].includes(t) && !yo.esGestor) t = 'cot'
  tab = t; clearInterval(timer)
  $$('#crmTabs .tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === t))
  $$('.tab-content').forEach(c => c.classList.toggle('active', c.id === 'tab-' + t))
  document.querySelectorAll('#crmTabs .module-nav-group').forEach(g => g.classList.toggle('group-active', !!g.querySelector('.tab-btn.active')))
  TABS[t]().catch(e => { vista(t).innerHTML = U.err(e.message) })
}

// ---------- COTIZACIONES ----------
async function tCot() {
  const v = vista('cot'); if (!v.innerHTML) v.innerHTML = U.skel()
  // Bandeja unificada (SQL 136): web + cotizaciones ERP + PK facturados sin guía, por N° de COT
  let rows
  try { rows = await D.getBandeja(emp, S.fTodo) } catch (e) { v.innerHTML = U.err('No se pudo cargar la bandeja (¿corriste el SQL 136?): ' + e.message); return }
  v.innerHTML = U.htmlBandeja({ rows, ...S, yo })
  $('#fq').oninput = e => { S.fQ = U.norm(e.target.value); clearTimeout(tCot._t); tCot._t = setTimeout(tCot, 300) }
  $('#fe').onchange = e => { S.fEst = e.target.value; tCot() }
  $('#fm').onchange = e => { S.fMias = e.target.checked; tCot() }
  $('#ft').onchange = e => { S.fTodo = e.target.checked; tCot() }
  $('#crm-refrescar').onclick = () => tCot()
  abrirFilas(v)
  $('#crm-live').textContent = 'En vivo · ' + new Date().toLocaleTimeString('es-PE', { hour: '2-digit', minute: '2-digit' })
}
/** Clic en una fila/tarjeta: web → detalle; ERP → módulo con el buscador prefiltrado. */
function abrirFilas(raiz) {
  $$('[data-ref]', raiz).forEach(el => el.onclick = () => {
    const [origen, id] = el.dataset.ref.split(/:(.*)/)
    if (origen === 'web') detalleCot(id)
    else if (el.dataset.url) location.href = el.dataset.url
  })
}
async function detalleCot(id) {
  const box = $('#crm-det-body'); box.innerHTML = U.skel(); window.openModal('modal-crm-det')
  try {
    const full = await D.getCotizacionFull(id)
    const [margen, users] = await Promise.all([yo.esGestor ? D.getMargenCot(id).catch(() => []) : [], yo.role === 'admin' ? D.getUsuariosCRM() : []])
    box.innerHTML = U.htmlDetalleCot(full, margen, users, yo)
    const upd = async (patch, msg) => { try { await D.updCotizacion(id, patch); showToast(msg, 'success'); detalleCot(id); tCot() } catch (e) { fail(e) } }
    $('#gs').onclick = () => upd({ estado: $('#se').value, estado_pago: $('#sp').value }, 'Estado actualizado')
    if ($('#ga')) $('#ga').onclick = () => upd({ vendedor_id: $('#su').value ? Number($('#su').value) : null }, 'Asignación guardada')
    if ($('#tom')) $('#tom').onclick = () => upd({ vendedor_id: yo.id }, 'Cotización tomada')
    if ($('#cvpk')) $('#cvpk').onclick = async () => {
      if (!confirm('Se creará la cotización en Ventas → Packing con estos productos y precios. ¿Continuar?')) return
      try {
        await D.convertirAPacking(id)
        showToast('Convertida en cotización ERP ✅', 'success')
        window.closeModal('modal-crm-det'); tCot()
      } catch (e) { fail(e) }
    }
    if ($('#vc')) $('#vc').onclick = async () => { try { window.open(await D.urlComprobante(full.c.comprobante_path), '_blank', 'noopener') } catch (e) { fail(e) } }
    $('#na').onclick = async () => {
      if (!$('#nd').value.trim()) return showToast('Escribe un detalle', 'warning')
      try { await D.addSeguimiento({ cotizacion_id: id, tipo: $('#nt').value, detalle: $('#nd').value.trim(), user_id: yo.id, proxima_accion: $('#np').value || null }); detalleCot(id) } catch (e) { fail(e) }
    }
  } catch (e) { box.innerHTML = U.err(e.message) }
}

// ---------- CLIENTES ----------
async function tCli() {
  const v = vista('cli'); v.innerHTML = U.skel()
  const [cl, co] = await Promise.all([D.getClientes(), D.getCotResumen(emp)])
  const agg = {}; co.forEach(r => { const a = agg[r.cliente_id] ||= { n: 0, t: 0 }; a.n++; if (['aceptada', 'pagada', 'convertida'].includes(r.estado)) a.t += Number(r.total) })
  v.innerHTML = U.htmlClientes(cl, agg)
  $('#cq').oninput = e => { $('#cb').innerHTML = U.filasClientes(cl, agg, U.norm(e.target.value)) }
}

// ---------- STOCK ----------
async function tStk() {
  const v = vista('stk'); if (!v.innerHTML) v.innerHTML = U.skel()
  const cargar = async () => {
    const q = $('#sq')?.value || ''
    const data = await D.getStockLotes(emp)
    v.innerHTML = `<div class="card"><input id="sq" placeholder="Buscar artículo o lote…" value="${U.esc(q)}" style="max-width:260px;margin-bottom:8px"> <small style="color:var(--text-secondary)">Stock real del ERP · se refresca cada 30 s</small><div id="sk">${U.htmlStock(data, q)}</div></div>`
    $('#sq').oninput = () => { $('#sk').innerHTML = U.htmlStock(data, $('#sq').value) }
  }
  await cargar(); timer = setInterval(() => document.hidden || cargar().catch(() => {}), 30000)
}

// ---------- PRECIOS (gestor) ----------
let _precios = []
async function tPre() {
  const v = vista('pre'); v.innerHTML = U.skel()
  const cfg = await D.getConfigPrecios(emp)
  if (!cfg) { v.innerHTML = U.err('Sin configuración de precios para esta empresa. Corre el SQL 133.'); return }
  S.dias ||= cfg.periodo_dias
  const [res, guias, cats, fam, precios] = await Promise.all([
    D.getDespachoResumen(emp, S.dias), D.getDespachoGuias(emp, S.dias), D.getCategorias(), D.getMargenesFamilia(emp), D.getPrecios(emp, true)])
  _precios = precios
  v.innerHTML = `<div class="card" id="pre-desp">${U.htmlDespacho(res?.[0], S.dias, guias)}</div>
    <div class="card" style="margin-top:14px" id="pre-cfg">${U.htmlConfigPrecios(cfg, cats, fam)}</div>
    <div class="card" style="margin-top:14px" id="pre-lotes">${U.htmlPrecios(precios)}</div>`
  $('#pd-ok').onclick = () => { S.dias = Number($('#pd-dias').value) || cfg.periodo_dias; tPre() }
  $('#cp-save').onclick = async () => {
    try {
      await D.saveConfigPrecios(emp, { margen_objetivo_pct: Number($('#cp-obj').value), margen_minimo_pct: Number($('#cp-min').value), incluir_despacho: $('#cp-inc').value === '1',
        despacho_base: $('#cp-base').value, periodo_dias: Number($('#cp-dias').value), flete_kg_max: Number($('#cp-fkg').value) })
      showToast('Reglas guardadas', 'success'); S.dias = null; tPre()
    } catch (e) { fail(e) }
  }
  $('#fam-save').onclick = async () => {
    try {
      for (const k of cats) {
        const o = $(`.fam-o[data-c="${k.id}"]`).value, m = $(`.fam-m[data-c="${k.id}"]`).value
        if (o === '' && m === '') await D.delMargenFamilia(emp, k.id)
        else await D.saveMargenFamilia({ empresa_id: emp, categoria_id: k.id, margen_objetivo_pct: Number(o || cfg.margen_objetivo_pct), margen_minimo_pct: Number(m || cfg.margen_minimo_pct) })
      }
      showToast('Márgenes por familia guardados', 'success'); tPre()
    } catch (e) { fail(e) }
  }
  $('#pq').oninput = e => { $('#p-tabla').innerHTML = U.filasPrecios(_precios, U.norm(e.target.value)) }
  $('#p-stock').onchange = async e => { _precios = await D.getPrecios(emp, e.target.checked); $('#p-tabla').innerHTML = U.filasPrecios(_precios, U.norm($('#pq').value)) }
  $('#p-apl-sel').onclick = async () => {
    const sel = $$('.p-sel:checked').map(c => ({ lote_id: Number(c.dataset.l), margen_pct: Number($(`.p-m[data-l="${c.dataset.l}"]`).value) }))
    if (!sel.length) return showToast('Marca al menos un lote', 'warning')
    await aplicar(sel)
  }
  $('#p-apl-all').onclick = () => { if (confirm('Se recalculará el precio de lista de TODOS los lotes con stock usando su margen vigente. ¿Continuar?')) aplicar(null) }
}
async function aplicar(lotes) {
  try { const r = await D.aplicarPrecios(emp, lotes); showToast(`Precios aplicados: ${r.aplicados}${r.sin_costo ? ` · sin costo: ${r.sin_costo}` : ''}`, 'success'); tPre() } catch (e) { fail(e) }
}

// ---------- CATÁLOGO WEB (gestor) ----------
let _manifest = null
const imgs = f => (Array.isArray(f) ? f : []).map(p => (!p ? '' : /^https?:/i.test(p) ? p : String(p).replace(/^\/?crm\//, 'crm/'))).filter(Boolean)
const matchFoto = (m, nombre) => { const nn = U.norm(nombre); let best = null, sc = 0
  for (const f of m) { const s = U.norm(f.slug || f.archivo).split(/[^a-z0-9]+/).filter(t => t.length > 2).filter(t => nn.includes(t)).length; if (s > sc) { sc = s; best = f } }
  return sc >= 2 ? best.ruta : null }
async function tCat() {
  const v = vista('cat'); v.innerHTML = U.skel()
  const [items, cc] = await Promise.all([D.getItems(), D.getCatCfg(emp)])
  _manifest ||= await D.getManifest()
  const cfg = new Map(cc.map(c => [c.item_id, c]))
  let q = '', solo = ''
  v.innerHTML = U.htmlCatalogo()
  const pint = () => { $('#cb').innerHTML = U.filasCatalogo(items, cfg, q, solo, imgs); $$('#cb tr[data-i]').forEach(tr => tr.onclick = () => editarItem(items.find(x => x.id === Number(tr.dataset.i)), cfg.get(Number(tr.dataset.i)))) }
  $('#iq').oninput = e => { q = U.norm(e.target.value); pint() }
  $('#is').onchange = e => { solo = e.target.value; pint() }
  $('#ps').onclick = async () => {
    if (!confirm('Se publicarán en el catálogo web todos los artículos con stock en esta empresa. ¿Continuar?')) return
    try {
      const st = await D.getStockLotes(emp); const con = new Set(st.filter(r => Number(r.kg) > 0).map(r => r.item_id)); let n = 0
      for (const i of items) {
        if (!con.has(i.id)) continue
        const c = cfg.get(i.id), f = !imgs(c?.fotos).length ? matchFoto(_manifest, i.nombre) : null
        if (c) await D.updCatCfg(c.id, { publicado: true, ...(f ? { fotos: [f] } : {}) }); else await D.insCatCfg({ empresa_id: emp, item_id: i.id, publicado: true, fotos: f ? [f] : [] })
        n++
      }
      showToast(`${n} artículo(s) publicados`, 'success'); tCat()
    } catch (e) { fail(e) }
  }
  $('#av').onclick = async () => {
    try {
      let n = 0
      for (const i of items) { const c = cfg.get(i.id); if (imgs(c?.fotos).length) continue; const f = matchFoto(_manifest, i.nombre); if (!f) continue
        if (c) await D.updCatCfg(c.id, { fotos: [f] }); else await D.insCatCfg({ empresa_id: emp, item_id: i.id, fotos: [f] }); n++ }
      showToast(`${n} foto(s) vinculadas`, 'success'); tCat()
    } catch (e) { fail(e) }
  }
  pint()
}
function editarItem(item, c) {
  const v = c || { publicado: false, orden_display: 100, fotos: [] }
  let fotos = [...(v.fotos || [])]
  $('#crm-cat-body').innerHTML = U.htmlEditarItem(item, v, _manifest || []); window.openModal('modal-crm-cat')
  const pf = () => { $('#fs').innerHTML = fotos.map((f, i) => `<span style="position:relative"><img src="${U.esc(imgs([f])[0])}" alt="" style="height:60px;border-radius:6px"><button type="button" data-q="${i}" class="btn btn-small" style="position:absolute;top:-6px;right:-6px;padding:0 6px">×</button></span>`).join('') || '<small>Sin fotos</small>'
    $$('[data-q]').forEach(b => b.onclick = () => { fotos.splice(Number(b.dataset.q), 1); pf() }) }
  pf()
  $('#fm').onchange = e => { if (e.target.value) { fotos.push(e.target.value); pf(); e.target.value = '' } }
  $('#fu').onchange = async e => { const f = e.target.files[0]; if (!f) return; try { fotos.push(await D.subirFoto(item.id, f)); pf() } catch (x) { fail(x) } }
  $('#ef').onsubmit = async e => {
    e.preventDefault()
    const fd = new FormData(e.target), g = k => { const x = String(fd.get(k) ?? '').trim(); return x === '' ? null : x }, n = k => g(k) === null ? null : Number(g(k))
    try {
      await D.upsertCatCfg({ empresa_id: emp, item_id: item.id, publicado: !!fd.get('publicado'), nombre_web: g('nombre_web'), grupo: g('grupo'), color_nombre: g('color_nombre'), color_no: g('color_no'),
        color_hex: g('color_hex'), descripcion_web: g('descripcion_web'), aplicaciones: g('aplicaciones'), fotos, precio_lista: n('precio_lista'), peso_caja_kg: n('peso_caja_kg'),
        conos_por_caja: n('conos_por_caja'), stock_minimo_kg: n('stock_minimo_kg'), orden_display: n('orden_display') ?? 100 })
      showToast('Guardado', 'success'); window.closeModal('modal-crm-cat'); tCat()
    } catch (x) { $('#er').innerHTML = U.err(x.message) }
  }
}

// ---------- WEB Y FLETE (gestor) ----------
async function tWeb() {
  const v = vista('web'); v.innerHTML = U.skel()
  const [c, zonas, reglas] = await Promise.all([D.getConfigWeb(emp), D.getZonas(), D.getReglas()])
  if (!c) { v.innerHTML = U.err('Sin configuración para esta empresa (SQL 131).'); return }
  v.innerHTML = U.htmlWeb(c, zonas, reglas)
  let cuentas = Array.isArray(c.cuentas_bancarias) ? [...c.cuentas_bancarias] : []
  const pcu = () => { $('#w-cu').innerHTML = cuentas.map((x, i) => `<div style="display:grid;grid-template-columns:repeat(5,1fr) auto;gap:6px;margin-bottom:6px">${['banco', 'tipo', 'numero', 'cci', 'titular'].map(k => `<input data-k="${k}" data-i="${i}" placeholder="${k}" value="${U.esc(x[k] || '')}">`).join('')}<button class="btn btn-small" data-d="${i}">Quitar</button></div>`).join('')
    $$('[data-k]').forEach(el => el.oninput = () => { cuentas[el.dataset.i][el.dataset.k] = el.value }); $$('[data-d]').forEach(b => b.onclick = () => { cuentas.splice(Number(b.dataset.d), 1); pcu() }) }
  pcu(); $('#w-ac').onclick = () => { cuentas.push({}); pcu() }
  $('#w-save').onclick = async () => {
    try { await D.saveConfigWeb(emp, { whatsapp: $('#w-wsp').value.replace(/\D/g, '') || null, moneda_precio: $('#w-mon').value, semaforo_poco_kg: Number($('#w-poco').value) || 100,
      titulo: $('#w-tit').value || null, mensaje: $('#w-msg').value || null, mostrar_precios: $('#w-mp').checked, igv_incluido: $('#w-igv').checked, cuentas_bancarias: cuentas.filter(x => x.banco || x.numero) })
      showToast('Configuración guardada', 'success') } catch (e) { fail(e) }
  }
  $('#r-add').onclick = async () => { try { await D.saveRegla({ hasta_km: 30, recargo_pen: 100, etiqueta: 'Nuevo tramo' }); tWeb() } catch (e) { fail(e) } }
  $$('.r-del').forEach(b => b.onclick = async () => { if (confirm('¿Quitar este tramo?')) { try { await D.delRegla(Number(b.dataset.id)); tWeb() } catch (e) { fail(e) } } })
  $('#r-save').onclick = async () => { try { for (const r of reglas) { const k = s => $(`.${s}[data-id="${r.id}"]`).value
    await D.saveRegla({ id: r.id, hasta_km: Number(k('r-km')), recargo_pen: Number(k('r-rec')), etiqueta: k('r-et') }) } showToast('Tramos guardados', 'success') } catch (e) { fail(e) } }
  $('#z-save').onclick = async () => { try { for (const z of zonas) await D.saveZona({ id: z.id, km: Number($(`.z-km[data-id="${z.id}"]`).value), activo: $(`.z-on[data-id="${z.id}"]`).checked }); showToast('Distancias guardadas', 'success') } catch (e) { fail(e) } }
  $('#s-go').onclick = async () => { try { const r = (await D.fleteCalc(emp, $('#s-dis').value, Number($('#s-kg').value) || 0))[0]
    $('#s-res').textContent = !r ? '' : r.estado === 'cotizar' ? `Cotizar aparte${r.km != null ? ' · ~' + r.km + ' km' : ' (distrito no reconocido)'}` : `${r.estado === 'incluido' ? 'Incluido' : 'S/ ' + r.recargo} · ~${r.km} km` } catch (e) { fail(e) } }
}

async function tMapa() {
  const v = vista('map'); v.innerHTML = U.skel()
  const DIAS = 7
  const activas = (empresasActivasCtx() || []).map(Number).filter(Boolean), emps = activas.length ? activas : [emp]
  const [rows, ents, orgs] = await Promise.all([
    D.getBandeja(emp, false),
    Promise.all(emps.map(e => D.getMapaEntregas(e, DIAS).catch(() => null))),
    Promise.all(emps.map(e => D.getMapaOrigen(e).then(r => [e, (r || [])[0]]).catch(() => [e, null])))
  ])
  const ent = ents.every(x => x === null) ? null : ents.flatMap(x => x || [])
  v.innerHTML = '<div class="card" id="mp-card" style="padding:10px"></div><div id="mp-flujo" style="margin-top:14px"></div>'
  document.getElementById('mp-flujo').innerHTML = U.htmlMapaFlujo(rows)
  abrirFilas(v)
  try {
    if (!ent) throw new Error('Corre el SQL 140 para activar el mapa.')
    const { renderMapaEntregas } = await import('./mapa-entregas.js')
    await renderMapaEntregas(document.getElementById('mp-card'), { rows: ent, dias: DIAS, empresas: orgs.map(([id, o]) => ({ id, codigo: o && o.empresa_codigo, color: o && o.empresa_color })), origenes: Object.fromEntries(orgs.map(([e, o]) => [e, o || {}])), alRefrescar: () => tMapa() })
  } catch (e) { document.getElementById('mp-card').innerHTML = U.err(e.message) }
}

// ---------- DOCUMENTOS (Orden de Producción · Solicitud de Línea de Crédito) ----------
async function tDoc() {
  const v = vista('doc'); v.innerHTML = U.skel()
  const { renderDocumentos } = await import('./documentos-formato.js')
  await renderDocumentos(v, { emp })
}

// ---------- arranque ----------
async function init() {
  try {
    yo = await D.getYo(); emp = await esperarEmpresa()
    const raiz = $('#crm-root')
    if (!yo?.esStaff) { raiz.innerHTML = U.err('El CRM es solo para usuarios Oficina, Vendedor o Administrador.'); return }
    if (!emp) { raiz.innerHTML = U.err('Elige una empresa de trabajo en el selector de la cabecera.'); return }
    $$('[data-gestor]').forEach(el => { el.style.display = yo.esGestor ? '' : 'none' })
    $('#crmTabs').addEventListener('click', e => { const b = e.target.closest('.tab-btn'); if (b) { location.hash = b.dataset.tab; ir(b.dataset.tab) } })
    initModuleNavDropdowns('#crmTabs')
    D.suscribirCotizaciones(() => { if (tab === 'cot' && !$('#modal-crm-det').classList.contains('show')) tCot().catch(() => {}) })
    ir((location.hash || '#cot').slice(1))
  } catch (e) { console.error('[CRM]', e); $('#crm-root').innerHTML = U.err(e.message) }
}
init()
