import { $, $$, esc, num, money, fecha, fechaHora, norm, toast, arrancar, supabase, imagenes, fotoUrl, getEmpresas } from './crm-core.js'

const { emp, staff } = await arrancar('panel')
const app = $('#app')
const ESTADOS = ['enviada', 'en_revision', 'cotizada', 'aceptada', 'pagada', 'convertida', 'perdida', 'cancelada']
const lbl = s => String(s || '').replace('_', ' ')

if (!staff?.esStaff) {
  app.innerHTML = `<div class="vacio"><h2>Acceso restringido</h2><p>El panel es solo para usuarios Oficina, Vendedor o Administrador.</p>
    <a class="btn" href="../login.html">Iniciar sesión</a></div>`
} else if (!emp) {
  app.innerHTML = '<div class="vacio"><h2>Sin empresas con catálogo</h2><p>Publica al menos un artículo desde la pestaña Catálogo (requiere crear la fila de configuración vía SQL 131).</p></div>'
} else {
  const TABS = [['cot', 'Cotizaciones'], ['cli', 'Clientes'], ['stk', 'Stock y lotes']]
  if (staff.esGestor) TABS.push(['cat', 'Catálogo'], ['cfg', 'Configuración'])
  let tab = (location.hash || '#cot').slice(1); if (!TABS.some(t => t[0] === tab)) tab = 'cot'
  let manifest = null
  const view = () => $('#vista')

  app.innerHTML = `<div class="hero"><h1>Panel CRM · ${esc(emp.nombre_comercial)}</h1><p>Datos reales del ERP, solo lectura salvo cotizaciones, seguimiento y catálogo web. <span class="live" id="live">En vivo</span></p></div>
    <div class="tabs" id="tabs">${TABS.map(t => `<button data-t="${t[0]}">${t[1]}</button>`).join('')}</div><div id="vista"></div>
    <div class="drawer" id="dr"><div class="drawer__bg"></div><div class="drawer__box" id="drb"></div></div>`
  $('#tabs').onclick = e => { const b = e.target.closest('[data-t]'); if (b) ir(b.dataset.t) }
  $('.drawer__bg').onclick = () => $('#dr').classList.remove('abierto')
  const abrir = html => { $('#drb').innerHTML = html; $('#dr').classList.add('abierto') }
  const cerrar = () => $('#dr').classList.remove('abierto')
  const live = () => { $('#live').textContent = 'En vivo · ' + new Date().toLocaleTimeString('es-PE', { hour: '2-digit', minute: '2-digit' }) }
  let timer = null
  function ir(t) {
    tab = t; location.hash = t; clearInterval(timer)
    $$('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.t === t));
    ({ cot: tCot, cli: tCli, stk: tStk, cat: tCat, cfg: tCfg })[t]()
  }

  // ---------------- COTIZACIONES ----------------
  let fEst = '', fQ = '', fMias = false
  async function tCot() {
    view().innerHTML = '<div class="skel" style="height:200px"></div>'
    const { data, error } = await supabase.from('crm_cotizaciones').select('*').eq('empresa_id', emp.id).order('created_at', { ascending: false }).limit(500)
    if (error) { view().innerHTML = `<div class="msg msg--e">${esc(error.message)}</div>`; return }
    const rows = data || []
    const k = e => rows.filter(r => r.estado === e).length
    const mesIni = new Date(); mesIni.setDate(1); mesIni.setHours(0, 0, 0, 0)
    const ventaMes = rows.filter(r => ['aceptada', 'pagada', 'convertida'].includes(r.estado) && new Date(r.created_at) >= mesIni).reduce((a, r) => a + Number(r.total), 0)
    const sinAsig = rows.filter(r => !r.vendedor_id && !['perdida', 'cancelada'].includes(r.estado)).length
    const lista = rows.filter(r => (!fEst || r.estado === fEst) && (!fMias || r.vendedor_id === staff.id) &&
      (!fQ || norm(`${r.numero} ${r.razon_social} ${r.contacto_nombre}`).includes(fQ)))
    view().innerHTML = `
      <div class="kpis"><div class="kpi"><b>${k('enviada')}</b><span>Nuevas</span></div><div class="kpi"><b>${k('en_revision') + k('cotizada')}</b><span>En proceso</span></div>
        <div class="kpi"><b>${sinAsig}</b><span>Sin asignar</span></div><div class="kpi"><b>${money(ventaMes)}</b><span>Cerrado este mes</span></div></div>
      <div class="filtros"><input class="in" id="fq" placeholder="Buscar N°, cliente…" value="${esc(fQ)}">
        <select class="in" id="fe"><option value="">Todos los estados</option>${ESTADOS.map(s => `<option ${fEst === s ? 'selected' : ''} value="${s}">${lbl(s)}</option>`).join('')}</select>
        <label style="display:flex;gap:6px;align-items:center"><input type="checkbox" id="fm" ${fMias ? 'checked' : ''}> Solo mías</label></div>
      <div class="panel-box" style="overflow-x:auto"><table class="t"><thead><tr><th>N°</th><th>Fecha</th><th>Cliente</th><th>Estado</th><th>Pago</th><th class="num">Total</th><th>Asignada</th></tr></thead><tbody>
      ${lista.map(r => `<tr class="click" data-id="${r.id}"><td><b>${esc(r.numero)}</b></td><td>${fecha(r.created_at)}</td><td>${esc(r.razon_social)}<br><span class="muted">${esc(r.contacto_nombre || '')}</span></td>
        <td><span class="chip chip--${r.estado}">${lbl(r.estado)}</span></td><td>${esc(r.estado_pago)}</td><td class="num">${money(r.total, r.moneda)}</td>
        <td>${r.vendedor_id ? (r.vendedor_id === staff.id ? 'Yo' : '#' + r.vendedor_id) : '<span class="muted">—</span>'}</td></tr>`).join('') || '<tr><td colspan="7" class="muted">Sin cotizaciones</td></tr>'}</tbody></table></div>`
    $('#fq').oninput = e => { fQ = norm(e.target.value); clearTimeout(tCot._t); tCot._t = setTimeout(tCot, 300) }
    $('#fe').onchange = e => { fEst = e.target.value; tCot() }
    $('#fm').onchange = e => { fMias = e.target.checked; tCot() }
    $$('tr.click').forEach(tr => tr.onclick = () => detalleCot(tr.dataset.id))
    live()
  }

  async function detalleCot(id) {
    abrir('<div class="skel" style="height:200px"></div>')
    const [c, d, s] = await Promise.all([
      supabase.from('crm_cotizaciones').select('*').eq('id', id).single(),
      supabase.from('crm_cotizacion_detalle').select('*').eq('cotizacion_id', id).order('orden_linea'),
      supabase.from('crm_seguimiento').select('*').eq('cotizacion_id', id).order('created_at', { ascending: false })])
    const r = c.data; if (!r) return abrir(`<div class="msg msg--e">${esc(c.error?.message || 'No encontrada')}</div>`)
    let users = []
    if (staff.role === 'admin') users = (await supabase.from('users').select('id,nombre,role').in('role', ['admin', 'oficina', 'vendedor'])).data || []
    abrir(`<p style="display:flex;justify-content:space-between"><b style="font-size:1.2rem">${esc(r.numero)}</b><button class="btn btn--o btn--sm" id="cl">Cerrar</button></p>
      <div class="specs"><div class="spec"><b>Cliente</b>${esc(r.razon_social)}</div><div class="spec"><b>Contacto</b>${esc(r.contacto_nombre || '')}<br>${esc(r.contacto_telefono || '')}<br>${esc(r.contacto_email || '')}</div>
        <div class="spec"><b>Entrega</b>${esc(r.dir_entrega || '—')} ${esc(r.distrito_entrega || '')}</div><div class="spec"><b>Notas del cliente</b>${esc(r.notas_cliente || '—')}</div></div>
      <table class="t"><thead><tr><th>Producto</th><th class="num">Kg</th><th class="num">P/kg</th><th class="num">Importe</th></tr></thead><tbody>
      ${(d.data || []).map(l => `<tr><td>${esc(l.producto_nombre)}<br><span class="muted">${esc(l.color_nombre || '')}</span></td><td class="num">${num(l.cantidad_kg)}</td><td class="num">${num(l.precio_unitario)}</td><td class="num">${num(l.importe)}</td></tr>`).join('')}</tbody></table>
      <div class="tot" style="margin:12px 0"><div><span>Subtotal</span><span>${money(r.subtotal, r.moneda)}</span></div><div><span>IGV</span><span>${money(r.igv, r.moneda)}</span></div><div class="g"><span>Total</span><span>${money(r.total, r.moneda)}</span></div></div>
      <div class="filtros"><select class="in" id="se">${ESTADOS.map(x => `<option value="${x}" ${r.estado === x ? 'selected' : ''}>${lbl(x)}</option>`).join('')}</select>
        <select class="in" id="sp">${['pendiente', 'parcial', 'pagado'].map(x => `<option ${r.estado_pago === x ? 'selected' : ''}>${x}</option>`).join('')}</select>
        <button class="btn btn--sm" id="gs">Guardar estado</button>
        ${users.length ? `<select class="in" id="su"><option value="">Sin asignar</option>${users.map(u => `<option value="${u.id}" ${r.vendedor_id === u.id ? 'selected' : ''}>${esc(u.nombre)} (${u.role})</option>`).join('')}</select><button class="btn btn--sm btn--o" id="ga">Asignar</button>`
          : (!r.vendedor_id ? '<button class="btn btn--sm btn--o" id="tom">Tomar cotización</button>' : '')}</div>
      ${r.comprobante_path ? '<p><button class="btn btn--o btn--sm" id="vc">Ver comprobante de pago</button></p>' : ''}
      <h3>Seguimiento</h3>
      <div class="filtros"><select class="in" id="nt">${['nota', 'llamada', 'whatsapp', 'correo', 'visita', 'pago'].map(x => `<option>${x}</option>`).join('')}</select>
        <input class="in" id="nd" style="flex:1" placeholder="Detalle…"><input class="in" type="date" id="np" title="Próxima acción"><button class="btn btn--sm" id="na">Agregar</button></div>
      <ul class="tl">${(s.data || []).map(x => `<li><b>${esc(x.tipo)}</b> · ${fechaHora(x.created_at)}<br>${esc(x.detalle)}${x.proxima_accion ? `<br><span class="muted">Próx.: ${fecha(x.proxima_accion)}</span>` : ''}</li>`).join('') || '<li class="muted">Sin movimientos</li>'}</ul>`)
    $('#cl').onclick = cerrar
    const upd = async (patch, msg) => { const { error } = await supabase.from('crm_cotizaciones').update(patch).eq('id', id); if (error) return toast(error.message); toast(msg); detalleCot(id); tCot() }
    $('#gs').onclick = () => upd({ estado: $('#se').value, estado_pago: $('#sp').value }, 'Estado actualizado')
    if ($('#ga')) $('#ga').onclick = () => upd({ vendedor_id: $('#su').value ? Number($('#su').value) : null }, 'Asignación guardada')
    if ($('#tom')) $('#tom').onclick = () => upd({ vendedor_id: staff.id }, 'Cotización tomada')
    if ($('#vc')) $('#vc').onclick = async () => {
      const { data, error } = await supabase.storage.from('crm-comprobantes').createSignedUrl(r.comprobante_path, 120)
      error ? toast(error.message) : window.open(data.signedUrl, '_blank', 'noopener')
    }
    $('#na').onclick = async () => {
      if (!$('#nd').value.trim()) return toast('Escribe un detalle')
      const { error } = await supabase.from('crm_seguimiento').insert({ cotizacion_id: id, tipo: $('#nt').value, detalle: $('#nd').value.trim(), user_id: staff.id, proxima_accion: $('#np').value || null })
      if (error) return toast(error.message)
      detalleCot(id)
    }
  }

  // ---------------- CLIENTES ----------------
  async function tCli() {
    view().innerHTML = '<div class="skel" style="height:200px"></div>'
    const [cl, co] = await Promise.all([
      supabase.from('crm_clientes').select('*').order('created_at', { ascending: false }).limit(500),
      supabase.from('crm_cotizaciones').select('cliente_id,total,estado').eq('empresa_id', emp.id)])
    if (cl.error) { view().innerHTML = `<div class="msg msg--e">${esc(cl.error.message)}</div>`; return }
    const agg = {}; (co.data || []).forEach(r => { const a = agg[r.cliente_id] ||= { n: 0, t: 0 }; a.n++; if (['aceptada', 'pagada', 'convertida'].includes(r.estado)) a.t += Number(r.total) })
    view().innerHTML = `<div class="filtros"><input class="in" id="cq" placeholder="Buscar cliente o RUC…"></div><div class="panel-box" style="overflow-x:auto"><table class="t"><thead><tr><th>RUC</th><th>Razón social</th><th>Contacto</th><th class="num">Cotiz.</th><th class="num">Cerrado</th><th>ERP</th></tr></thead><tbody id="cb"></tbody></table></div>`
    const pint = q => { $('#cb').innerHTML = (cl.data || []).filter(c => !q || norm(`${c.ruc} ${c.razon_social}`).includes(q)).map(c => `<tr><td>${esc(c.ruc)}</td><td>${esc(c.razon_social)}</td>
      <td>${esc(c.nombre_contacto || '')}<br><span class="muted">${esc(c.telefono || '')} ${esc(c.email || '')}</span></td><td class="num">${agg[c.id]?.n || 0}</td><td class="num">${num(agg[c.id]?.t || 0)}</td>
      <td>${c.contact_id ? '<span class="chip chip--pagada">Vinculado</span>' : '<span class="muted">—</span>'}</td></tr>`).join('') || '<tr><td colspan="6" class="muted">Sin clientes</td></tr>' }
    pint(''); $('#cq').oninput = e => pint(norm(e.target.value)); live()
  }

  // ---------------- STOCK Y LOTES (ERP en vivo) ----------------
  async function tStk() {
    const cargar = async () => {
      const { data, error } = await supabase.rpc('crm_stock_lotes', { p_empresa: emp.id })
      if (error) { view().innerHTML = `<div class="msg msg--e">${esc(error.message)}</div>`; return }
      const por = {}; (data || []).forEach(r => { (por[r.item_nombre] ||= []).push(r) })
      const q = $('#sq')?.value || ''
      view().innerHTML = `<div class="filtros"><input class="in" id="sq" placeholder="Buscar artículo o lote…" value="${esc(q)}"><span class="muted">Stock real del ERP, se refresca solo cada 30 s</span></div><div class="panel-box" style="overflow-x:auto"><table class="t"><thead><tr><th>Artículo / lote</th><th>Almacén · ubicación</th><th class="num">Kg</th><th class="num">Unid.</th><th class="num">Kg/unid.</th><th>Ingreso</th></tr></thead><tbody>
      ${Object.entries(por).filter(([n, ls]) => !q || norm(n + ls.map(l => l.numero_lote).join(' ')).includes(norm(q))).map(([n, ls]) =>
        `<tr><td colspan="2"><b>${esc(n)}</b></td><td class="num"><b>${num(ls.reduce((a, l) => a + Number(l.kg), 0))}</b></td><td colspan="3"></td></tr>` +
        ls.map(l => `<tr class="lote-row"><td>&nbsp;&nbsp;${esc(l.numero_lote)}</td><td>${esc(l.almacen)} · ${esc(l.ubicacion)}</td><td class="num">${num(l.kg)}</td><td class="num">${num(l.unidades, 0)}</td><td class="num">${num(l.peso_por_unidad)}</td><td>${fecha(l.fecha_ingreso)}</td></tr>`).join('')).join('') || '<tr><td colspan="6" class="muted">Sin stock</td></tr>'}</tbody></table></div>`
      $('#sq').oninput = () => { clearTimeout(cargar._t); cargar._t = setTimeout(cargar, 250) }
      live()
    }
    await cargar(); timer = setInterval(() => document.hidden || cargar(), 30000)
  }

  // ---------------- CATÁLOGO WEB (gestor) ----------------
  async function getManifest() {
    if (manifest) return manifest
    try { manifest = await (await fetch('assets/fotos/manifest.json')).json() } catch { manifest = [] }
    return manifest
  }
  async function tCat() {
    view().innerHTML = '<div class="skel" style="height:200px"></div>'
    const [it, cc] = await Promise.all([
      supabase.from('items').select('id,nombre,precio_venta,activo').eq('activo', true).order('nombre').limit(2000),
      supabase.from('crm_catalogo_config').select('*').eq('empresa_id', emp.id)])
    if (it.error) { view().innerHTML = `<div class="msg msg--e">${esc(it.error.message)}</div>`; return }
    const cfg = new Map((cc.data || []).map(c => [c.item_id, c]))
    let q = '', solo = ''
    const pint = () => {
      const l = (it.data || []).filter(i => (!q || norm(i.nombre).includes(q)) && (!solo || (solo === 'pub' ? cfg.get(i.id)?.publicado : !cfg.get(i.id)?.publicado)))
      $('#cb').innerHTML = l.map(i => { const c = cfg.get(i.id); return `<tr class="click" data-i="${i.id}"><td>${c?.publicado ? '<span class="chip chip--pagada">Publicado</span>' : '<span class="chip">Oculto</span>'}</td>
        <td>${esc(i.nombre)}</td><td>${esc(c?.grupo || '')}</td><td class="num">${num(c?.precio_lista || i.precio_venta || 0)}</td><td>${imagenes(c?.fotos).length ? `<img class="thumb" src="${esc(imagenes(c.fotos)[0])}" alt="">` : ''}</td></tr>` }).join('') || '<tr><td colspan="5" class="muted">Sin artículos</td></tr>'
      $$('#cb tr.click').forEach(tr => tr.onclick = () => editar(it.data.find(x => x.id === Number(tr.dataset.i)), cfg.get(Number(tr.dataset.i))))
    }
    view().innerHTML = `<div class="filtros"><input class="in" id="iq" placeholder="Buscar artículo del ERP…"><select class="in" id="is"><option value="">Todos</option><option value="pub">Publicados</option><option value="no">No publicados</option></select><button class="btn btn--sm" id="ps">Publicar artículos con stock</button><button class="btn btn--o btn--sm" id="av">Auto-vincular fotos</button></div>
      <p class="muted">Los artículos vienen del ERP. Aquí defines qué se publica y cómo se ve (foto, grupo, color, precio de lista).</p>
      <div class="panel-box" style="overflow-x:auto"><table class="t"><thead><tr><th>Estado</th><th>Artículo</th><th>Grupo</th><th class="num">Precio/kg</th><th>Foto</th></tr></thead><tbody id="cb"></tbody></table></div>`
    $('#iq').oninput = e => { q = norm(e.target.value); pint() }
    $('#is').onchange = e => { solo = e.target.value; pint() }
    $('#ps').onclick = async () => {
      if (!confirm('Se publicarán en el catálogo web todos los artículos que tienen stock en esta empresa (con foto si coincide con el catálogo viejo). ¿Continuar?')) return
      const { data: st, error: e1 } = await supabase.rpc('crm_stock_lotes', { p_empresa: emp.id })
      if (e1) return toast(e1.message)
      const conStock = new Set((st || []).filter(r => Number(r.kg) > 0).map(r => r.item_id))
      const m = await getManifest(); let n = 0
      const foto = nombre => { const nn = norm(nombre); let best = null, sc = 0
        for (const f of m) { const toks = norm(f.slug || f.archivo).split(/[^a-z0-9]+/).filter(t => t.length > 2); const s = toks.filter(t => nn.includes(t)).length; if (s > sc) { sc = s; best = f } }
        return sc >= 2 ? best.ruta : null }
      for (const i of it.data) {
        if (!conStock.has(i.id)) continue
        const c = cfg.get(i.id), f = !imagenes(c?.fotos).length ? foto(i.nombre) : null
        const { error } = c ? await supabase.from('crm_catalogo_config').update({ publicado: true, ...(f ? { fotos: [f] } : {}) }).eq('id', c.id)
          : await supabase.from('crm_catalogo_config').insert({ empresa_id: emp.id, item_id: i.id, publicado: true, fotos: f ? [f] : [] })
        if (!error) n++
      }
      toast(`${n} artículo(s) publicados`); tCat()
    }
    $('#av').onclick = async () => {
      const m = await getManifest(); let n = 0
      for (const i of it.data) {
        const c = cfg.get(i.id); if (imagenes(c?.fotos).length) continue
        const nn = norm(i.nombre)
        let mejor = null, sc = 0
        for (const f of m) { const toks = norm(f.slug || f.archivo).split(/[^a-z0-9]+/).filter(t => t.length > 2); const s = toks.filter(t => nn.includes(t)).length; if (s > sc) { sc = s; mejor = f } }
        if (mejor && sc >= 2) {
          const fila = { empresa_id: emp.id, item_id: i.id, fotos: [mejor.ruta] }
          const { error } = c ? await supabase.from('crm_catalogo_config').update({ fotos: [mejor.ruta] }).eq('id', c.id) : await supabase.from('crm_catalogo_config').insert(fila)
          if (!error) n++
        }
      }
      toast(`${n} foto(s) vinculadas`); tCat()
    }
    pint(); live()
  }

  async function editar(item, c) {
    const m = await getManifest()
    const v = c || { publicado: false, orden_display: 100, fotos: [] }
    let fotos = [...(v.fotos || [])]
    const campo = (k, l, t = 'text', extra = '') => `<div class="fg"><label>${l}</label><input name="${k}" type="${t}" ${extra} value="${esc(v[k] ?? '')}"></div>`
    abrir(`<p style="display:flex;justify-content:space-between"><b>${esc(item.nombre)}</b><button class="btn btn--o btn--sm" id="cl">Cerrar</button></p>
      <form class="form" id="ef"><div class="fg full"><label><input type="checkbox" name="publicado" ${v.publicado ? 'checked' : ''} style="width:auto"> Publicado en el catálogo</label></div>
      ${campo('nombre_web', 'Nombre web (vacío = nombre ERP)')}${campo('grupo', 'Grupo / categoría')}${campo('color_nombre', 'Color')}${campo('color_no', 'N° de color')}
      ${campo('color_hex', 'Color (hex #RRGGBB)')}${campo('precio_lista', 'Precio de lista por kg (vacío = precio ERP)', 'number', 'step="0.01"')}
      ${campo('peso_caja_kg', 'Peso por caja (kg)', 'number', 'step="0.01"')}${campo('conos_por_caja', 'Conos por caja', 'number')}
      ${campo('stock_minimo_kg', 'Poco stock bajo (kg)', 'number')}${campo('orden_display', 'Orden', 'number')}
      <div class="fg full"><label>Descripción</label><textarea name="descripcion_web" rows="2">${esc(v.descripcion_web || '')}</textarea></div>
      <div class="fg full"><label>Aplicaciones</label><textarea name="aplicaciones" rows="2">${esc(v.aplicaciones || '')}</textarea></div>
      <div class="fg full"><label>Fotos</label><div id="fs" class="filtros"></div>
        <select class="in" id="fm"><option value="">+ Agregar del catálogo viejo…</option>${m.map(f => `<option value="${esc(f.ruta)}">${esc(f.slug || f.archivo)}</option>`).join('')}</select>
        <label class="drop" style="margin-top:8px"><input id="fu" type="file" accept="image/*" hidden>Subir nueva foto</label></div>
      <div class="full" id="er"></div><div class="full"><button class="btn btn--lg">Guardar</button></div></form>`)
    const pf = () => { $('#fs').innerHTML = fotos.map((f, i) => `<span style="position:relative"><img class="thumb" src="${esc(fotoUrl(f))}" alt=""><button type="button" data-q="${i}" class="btn btn--sm" style="position:absolute;top:-6px;right:-6px;padding:0 6px">×</button></span>`).join('') || '<span class="muted">Sin fotos</span>'
      $$('[data-q]').forEach(b => b.onclick = () => { fotos.splice(Number(b.dataset.q), 1); pf() }) }
    pf()
    $('#cl').onclick = cerrar
    $('#fm').onchange = e => { if (e.target.value) { fotos.push(e.target.value); pf(); e.target.value = '' } }
    $('#fu').onchange = async e => {
      const f = e.target.files[0]; if (!f) return
      const path = `items/${item.id}/${Date.now()}-${f.name.replace(/[^\w.\-]+/g, '_')}`
      const up = await supabase.storage.from('crm-catalogo').upload(path, f, { contentType: f.type })
      if (up.error) return toast(up.error.message)
      fotos.push(supabase.storage.from('crm-catalogo').getPublicUrl(path).data.publicUrl); pf()
    }
    $('#ef').onsubmit = async e => {
      e.preventDefault()
      const fd = new FormData(e.target), g = k => { const x = String(fd.get(k) ?? '').trim(); return x === '' ? null : x }
      const n = k => g(k) === null ? null : Number(g(k))
      const row = { empresa_id: emp.id, item_id: item.id, publicado: !!fd.get('publicado'), nombre_web: g('nombre_web'), grupo: g('grupo'), color_nombre: g('color_nombre'), color_no: g('color_no'),
        color_hex: g('color_hex'), descripcion_web: g('descripcion_web'), aplicaciones: g('aplicaciones'), fotos, precio_lista: n('precio_lista'), peso_caja_kg: n('peso_caja_kg'),
        conos_por_caja: n('conos_por_caja'), stock_minimo_kg: n('stock_minimo_kg'), orden_display: n('orden_display') ?? 100 }
      const { error } = await supabase.from('crm_catalogo_config').upsert(row, { onConflict: 'empresa_id,item_id' })
      if (error) { $('#er').innerHTML = `<div class="msg msg--e">${esc(error.message)}</div>`; return }
      toast('Guardado'); cerrar(); tCat()
    }
  }

  // ---------------- CONFIGURACIÓN (gestor) ----------------
  async function tCfg() {
    const { data: c, error } = await supabase.from('crm_config').select('*').eq('empresa_id', emp.id).maybeSingle()
    if (error || !c) { view().innerHTML = `<div class="msg msg--e">${esc(error?.message || 'Sin configuración para esta empresa (corre el SQL 131).')}</div>`; return }
    let cuentas = Array.isArray(c.cuentas_bancarias) ? [...c.cuentas_bancarias] : []
    const pcu = () => { $('#cu').innerHTML = cuentas.map((x, i) => `<div class="cuenta"><div class="fg"><input class="in" data-k="banco" data-i="${i}" placeholder="Banco" value="${esc(x.banco || '')}"></div>
      <div class="fg"><input class="in" data-k="tipo" data-i="${i}" placeholder="Tipo (Cta. cte. soles)" value="${esc(x.tipo || '')}"></div><div class="fg"><input class="in" data-k="numero" data-i="${i}" placeholder="N° de cuenta" value="${esc(x.numero || '')}"></div>
      <div class="fg"><input class="in" data-k="cci" data-i="${i}" placeholder="CCI" value="${esc(x.cci || '')}"></div><div class="fg"><input class="in" data-k="titular" data-i="${i}" placeholder="Titular" value="${esc(x.titular || '')}"></div>
      <button type="button" class="btn btn--o btn--sm" data-d="${i}">Quitar</button></div>`).join('')
      $$('[data-k]').forEach(el => el.oninput = () => { cuentas[el.dataset.i][el.dataset.k] = el.value })
      $$('[data-d]').forEach(b => b.onclick = () => { cuentas.splice(Number(b.dataset.d), 1); pcu() }) }
    view().innerHTML = `<form class="panel-box form" id="cf">
      <div class="fg"><label>WhatsApp (solo dígitos con país)</label><input name="whatsapp" value="${esc(c.whatsapp || '')}" placeholder="51956217972"></div>
      <div class="fg"><label>Moneda de precios</label><select name="moneda_precio"><option ${c.moneda_precio === 'PEN' ? 'selected' : ''}>PEN</option><option ${c.moneda_precio === 'USD' ? 'selected' : ''}>USD</option></select></div>
      <div class="fg full"><label>Título del catálogo</label><input name="titulo" value="${esc(c.titulo || '')}"></div>
      <div class="fg full"><label>Mensaje de bienvenida</label><textarea name="mensaje" rows="2">${esc(c.mensaje || '')}</textarea></div>
      <div class="fg"><label>Poco stock bajo (kg)</label><input name="semaforo_poco_kg" type="number" value="${esc(c.semaforo_poco_kg)}"></div>
      <div class="fg"><label><input type="checkbox" name="mostrar_precios" ${c.mostrar_precios ? 'checked' : ''} style="width:auto"> Mostrar precios al público</label><br><label><input type="checkbox" name="igv_incluido" ${c.igv_incluido ? 'checked' : ''} style="width:auto"> Precio de lista incluye IGV</label></div>
      <div class="full"><h3>Cuentas bancarias (se muestran al confirmar la cotización)</h3><div class="cuentas" id="cu"></div><button type="button" class="btn btn--o btn--sm" id="ac">+ Agregar cuenta</button></div>
      <div class="full" id="er"></div><div class="full"><button class="btn btn--lg">Guardar configuración</button></div></form>`
    pcu(); $('#ac').onclick = () => { cuentas.push({}); pcu() }
    $('#cf').onsubmit = async e => {
      e.preventDefault(); const fd = new FormData(e.target)
      const { error } = await supabase.from('crm_config').update({ whatsapp: (fd.get('whatsapp') || '').replace(/\D/g, '') || null, moneda_precio: fd.get('moneda_precio'),
        titulo: fd.get('titulo') || null, mensaje: fd.get('mensaje') || null, semaforo_poco_kg: Number(fd.get('semaforo_poco_kg')) || 100,
        mostrar_precios: !!fd.get('mostrar_precios'), igv_incluido: !!fd.get('igv_incluido'), cuentas_bancarias: cuentas.filter(x => x.banco || x.numero) }).eq('empresa_id', emp.id)
      $('#er').innerHTML = error ? `<div class="msg msg--e">${esc(error.message)}</div>` : '<div class="msg msg--ok">Configuración guardada.</div>'
    }
  }

  // ---------------- TIEMPO REAL ----------------
  supabase.channel('crm-cot').on('postgres_changes', { event: '*', schema: 'public', table: 'crm_cotizaciones' }, p => {
    if (tab === 'cot' && !$('#dr').classList.contains('abierto')) tCot()
    if (p.eventType === 'INSERT') toast('Nueva cotización recibida')
  }).subscribe()

  window.addEventListener('hashchange', () => { const h = location.hash.slice(1); if (h !== tab && TABS.some(t => t[0] === h)) ir(h) })
  ir(tab)
}
