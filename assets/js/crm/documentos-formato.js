// ============================================================================
// crm/documentos-formato.js — CRM → 📄 Documentos (2026-11-11)
// Dos formatos formales con vista previa EDITABLE "como en el papel": lo que ves es exactamente el PDF.
//   · OP  = Orden de Producción (reserva de mercadería; sin precios ni crédito)
//   · SLC = Solicitud de Línea de Crédito
// Proveedor = empresa activa (Perfil → Multiempresa: logo, razón social, RUC, dirección). Cliente = contacto del ERP.
// Cada emisión guarda N° correlativo simple (OP-0001 / SLC-0001) y una copia de los datos (SQL 155).
// ============================================================================
import { supabase } from '../supabase-client.js'
import { showToast } from '../helpers.js'
import { emisorPDF, textoSobre, tinte, _esc, descargarPDFDesdeHTML } from '../shared/pdf-documento.js'
import { cargarCss } from '../shared/leaflet-carga.js'
import { crearBuscador } from '../shared/buscador-vivo.js'

const TAGLINE = 'Importación y distribución de hilos textiles industriales'
const TIPOS = {
  OP:  { nombre: 'Orden de Producción', sub: 'Compromiso de línea de producción periódica', icono: '🏭', desc: 'Reserva de mercadería mensual o semanal por cliente. Sin precios ni crédito.' },
  SLC: { nombre: 'Solicitud de Línea de Crédito', sub: 'Persona natural o jurídica · Cliente comercial', icono: '💳', desc: 'Solicitud formal de crédito con referencias comerciales y bancarias.' }
}
const hoy = () => new Intl.DateTimeFormat('es-PE', { timeZone: 'America/Lima', day: '2-digit', month: '2-digit', year: 'numeric' }).format(new Date())
const slug = s => String(s || 'sin-cliente').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40)
const fmtF = ts => ts ? new Intl.DateTimeFormat('es-PE', { timeZone: 'America/Lima', day: '2-digit', month: '2-digit', year: 'numeric' }).format(new Date(ts)) : '—'

/* ───────────────────────── Datos por defecto desde el contacto ───────────────────────── */
function prefill(tipo, c) {
  const f = { fecha: hoy() }
  if (c) {
    const tel = c.numero && c.numero !== '0' ? c.numero : '', doc = c.nro_documento && !/^0+$/.test(c.nro_documento) ? c.nro_documento : ''
    if (tipo === 'OP') Object.assign(f, { cli_razon: c.nombre, cli_doc: doc, dir: c.direccion || '', tel, mail: c.email || '', distrito: c.distrito || '' })
    else Object.assign(f, { sol_razon: c.nombre, sol_doc: doc, dir: c.direccion || '', tel, mail: c.email || '' })
  }
  return { f, c: {}, t: {} }
}

/* ───────────────────────── HTML del documento (= vista previa = PDF) ───────────────────────── */
function trHTML(cols, vals, i, numerada) {
  return `<tr>${numerada ? `<td class="n">${i + 1}</td>` : ''}${cols.map((_, j) => `<td contenteditable="true" spellcheck="false">${_esc(vals?.[j] ?? '')}</td>`).join('')}<td class="x"><button type="button" class="rm" title="Quitar fila">×</button></td></tr>`
}
function htmlDocumento(tipo, E, D, numero) {
  const C = E.color, CT = textoSobre(C), C10 = tinte(C, 0.12), C25 = tinte(C, 0.3)
  const v = k => _esc((D.f || {})[k] ?? '')
  const fld = (k, cls = '') => `<span class="v f ${cls}" data-k="${k}" contenteditable="true" spellcheck="false">${v(k)}</span>`
  const row = (lab, k, cls = '', wide = false) => `<div class="r${wide ? ' w2' : ''}"><label>${lab}:</label>${fld(k, cls)}</div>`
  const fix = (lab, txt, wide = false) => `<div class="r${wide ? ' w2' : ''}"><label>${lab}:</label><span class="v">${_esc(txt)}</span></div>`
  const cb = (k, lab) => `<span class="cbw"><span class="cb" data-k="${k}" data-on="${(D.c || {})[k] ? 1 : 0}"></span> ${lab}</span>`
  const tabla = (id, heads, nCols, nFilas, numerada, anchos) => {
    const filas = (D.t || {})[id] || Array.from({ length: nFilas }, () => Array(nCols).fill(''))
    return `<table class="t" data-t="${id}" data-cols="${nCols}" data-num="${numerada ? 1 : 0}"><thead><tr>${heads.map((h, i) => `<th style="width:${anchos[i]}">${h}</th>`).join('')}<th class="x"></th></tr></thead>
      <tbody>${filas.map((r, i) => trHTML(Array(nCols).fill(0), r, i, numerada)).join('')}</tbody></table>`
  }
  const logo = E.logo ? `<img src="${_esc(E.logo)}" alt="" onerror="this.outerHTML='<b class=nm>${_esc(E.nombre)}</b>'">` : `<b class="nm">${_esc(E.nombre)}</b>`
  const T = TIPOS[tipo]
  const num = `<span class="v" data-numero="1">${numero ? _esc(numero) : '<i class="pend">se asigna al guardar</i>'}</span>`
  const prov = `<div class="sec">1. DATOS DEL PROVEEDOR</div><div class="g">${fix('Razón social', E.nombre)}${fix('RUC', E.ruc)}${fix('Dirección', E.direccion, true)}</div>`
  let cuerpo
  if (tipo === 'OP') {
    cuerpo = `
    <div class="meta"><div class="r"><label>N° de orden:</label>${num}</div><div class="r"><label>Fecha de emisión:</label>${fld('fecha')}</div></div>
    ${prov}
    <div class="sec">2. DATOS DEL CLIENTE</div>
    <div class="g">${row('Razón social / Nombre', 'cli_razon')}${row('RUC / DNI', 'cli_doc')}${row('Representante legal', 'rep')}${row('DNI', 'rep_dni')}${row('Dirección', 'dir')}${row('Teléfono', 'tel')}${row('Correo electrónico', 'mail')}${row('Distrito / Ciudad', 'distrito')}${row('Contacto', 'contacto', '', true)}</div>
    <div class="sec">3. DETALLE DE LA MERCADERÍA A PRODUCIR Y RESERVAR</div>
    ${tabla('items', ['N°', 'Artículo / Código', 'Título / Color', 'Presentación', 'Cantidad (kg)'], 4, 4, true, ['6%', '30%', '28%', '18%', '18%'])}
    <div class="tot"><b>Total reservado (kg):</b> <span data-total="1">0</span></div>
    <div class="sec">4. LÍNEA DE PRODUCCIÓN COMPROMETIDA</div>
    <div class="r fr"><label>Frecuencia:</label>${cb('f_sem', 'Semanal')}${cb('f_men', 'Mensual')}${cb('f_otra', 'Otra:')}<span class="v f" data-k="f_otra_txt" contenteditable="true" spellcheck="false">${v('f_otra_txt')}</span></div>
    <div class="g">${row('Volumen por periodo (kg)', 'volumen')}${row('Vigencia (meses)', 'vigencia')}${row('Fecha de inicio', 'inicio')}${row('Día de retiro / entrega', 'retiro')}</div>
    <div class="sec">5. DECLARACIÓN Y COMPROMISO DEL CLIENTE</div>
    <p class="decl">Yo, el cliente identificado en el punto 2, declaro mi interés en trabajar con ${_esc(E.nombre)} como mi proveedor y me comprometo a mantener una línea de producción/compra semanal o mensual por el volumen indicado en el punto 4. Entiendo que la mercadería detallada quedará reservada a mi nombre y no será ofrecida a terceros durante el tiempo de vigencia, y que los precios no se fijan en este documento: se pactarán según la lista vigente al momento de cada despacho. Me comprometo a retirarla dentro de los ${fld('dias_retiro', 'corto')} días calendario posteriores al aviso de disponibilidad; vencido ese plazo, ${_esc(E.nombre)} podrá liberar la reserva.</p>
    <div class="r obs"><label>Observaciones:</label><span class="v f ml" data-k="obs" contenteditable="true" spellcheck="false">${v('obs')}</span></div>
    <div class="sign"><div>EL CLIENTE<br><small>Firma · Nombre · DNI · Fecha</small></div><div>${_esc(E.nombre)}<br><small>Firma y sello · Nombre · Cargo · Fecha</small></div></div>`
  } else {
    cuerpo = `
    <div class="meta"><div class="r"><label>N° de solicitud:</label>${num}</div><div class="r"><label>Fecha:</label>${fld('fecha')}</div></div>
    ${prov}
    <div class="sec">2. DATOS DEL SOLICITANTE</div>
    <div class="g">${row('Razón social / Nombre', 'sol_razon')}${row('RUC / DNI', 'sol_doc')}${row('Representante legal', 'rep')}${row('DNI', 'rep_dni')}${row('Dirección fiscal', 'dir')}${row('Teléfono', 'tel')}${row('Correo electrónico', 'mail')}${row('Antigüedad del negocio', 'antig')}${row('Actividad / giro', 'giro')}${row('N° de trabajadores', 'ntrab')}</div>
    <div class="sec">3. LÍNEA DE CRÉDITO SOLICITADA</div>
    <div class="g">${row('Monto solicitado (S/)', 'monto')}${row('Plazo de pago (días)', 'plazo')}${row('Compras estimadas (kg / mes)', 'kgmes')}${row('Artículos de interés', 'articulos')}${row('Saldo en crédito actual (S/)', 'saldo')}${row('Forma de pago', 'forma')}</div>
    <div class="r fr"><label>Frecuencia de compra:</label>${cb('q_sem', 'Semanal')}${cb('q_quin', 'Quincenal')}${cb('q_men', 'Mensual')}</div>
    <div class="sec">4. REFERENCIAS COMERCIALES</div>
    ${tabla('refs', ['Empresa / Proveedor', 'Contacto', 'Teléfono', 'Línea otorgada (S/)'], 4, 3, false, ['34%', '26%', '18%', '22%'])}
    <div class="sec">5. REFERENCIAS BANCARIAS</div>
    <div class="g">${row('Banco', 'banco')}${row('Tipo de cuenta', 'tipocta')}${row('N° de cuenta / CCI', 'cuenta')}${row('Titular', 'titular')}</div>
    <div class="sec">6. DOCUMENTOS ADJUNTOS</div>
    <div class="r fr">${cb('d_dni', 'Copia de DNI del representante')}${cb('d_ruc', 'Ficha RUC')}${cb('d_poder', 'Vigencia de poder')}${cb('d_recibo', 'Recibo de servicio')}${cb('d_otro', 'Otro:')}<span class="v f" data-k="d_otro_txt" contenteditable="true" spellcheck="false">${v('d_otro_txt')}</span></div>
    <div class="sec">7. DECLARACIÓN Y AUTORIZACIÓN</div>
    <p class="decl">Declaro que la información consignada es veraz y autorizo a ${_esc(E.nombre)} a verificarla y a consultar mis referencias comerciales y bancarias. Manifiesto mi interés en mantener una relación comercial continua con el proveedor y me comprometo a cancelar las facturas en el plazo acordado. Entiendo que la línea de crédito está sujeta a evaluación y aprobación, que puede ser reducida, suspendida o cancelada por ${_esc(E.nombre)} ante retrasos o incumplimientos, y que el pago fuera de plazo podrá generar los recargos e intereses que se pacten.</p>
    <div class="sign"><div>EL SOLICITANTE<br><small>Firma · Nombre · DNI · Fecha</small></div><div>${_esc(E.nombre)}<br><small>Aprobación: Firma y sello · Cargo · Fecha</small></div></div>
    <div class="g interno">${row('Uso interno — Línea aprobada (S/)', 'aprob')}${row('Plazo aprobado (días)', 'plazo_aprob')}</div>`
  }
  return `<!doctype html><html><head><meta charset="utf-8"><title>${_esc(T.nombre)}</title><base href="${new URL('.', location.href).href}">
<style>
  * { box-sizing:border-box; -webkit-print-color-adjust:exact; print-color-adjust:exact; }
  body { font-family:Arial,Helvetica,sans-serif; font-size:10px; color:#111; margin:0; padding:38px 40px; background:#fff; line-height:1.35; }
  .hd { display:flex; justify-content:space-between; align-items:center; gap:14px; }
  .hd img { height:48px; max-width:230px; object-fit:contain; display:block; } .hd .nm { font-size:16px; } .tag { font-size:9.5px; color:#475569; text-align:right; max-width:260px; }
  .ttl { margin-top:8px; text-align:center; background:${C}; color:${CT}; border-radius:8px; padding:5px 10px; } .ttl b { display:block; font-size:15px; letter-spacing:.05em; } .ttl span { font-size:9.5px; opacity:.92; }
  .meta { display:flex; justify-content:space-between; gap:20px; margin-top:9px; } .meta .r { flex:1; }
  .sec { margin-top:8px; background:${C10}; border-left:4px solid ${C}; padding:4px 8px; font-weight:bold; font-size:10.5px; }
  .g { display:grid; grid-template-columns:1fr 1fr; gap:4px 20px; margin-top:5px; } .w2 { grid-column:1 / -1; }
  .r { display:flex; gap:5px; align-items:baseline; min-width:0; } .r label { flex:none; font-weight:bold; color:#374151; }
  .v { flex:1; min-width:24px; border-bottom:1px dotted #6b7280; min-height:14px; padding:0 3px; overflow-wrap:anywhere; display:inline-block; }
  .v.corto { flex:none; min-width:42px; text-align:center; } .v.ml { white-space:pre-wrap; min-height:30px; }
  .fr { margin-top:5px; gap:14px; align-items:center; flex-wrap:wrap; } .cbw { display:inline-flex; align-items:center; gap:5px; }
  .cb { display:inline-block; width:12px; height:12px; border:1.4px solid #111; border-radius:2px; text-align:center; line-height:10px; font-size:11px; font-weight:bold; flex:none; } .cb[data-on="1"]::after { content:'✔'; }
  table.t { width:100%; border-collapse:collapse; margin-top:7px; table-layout:fixed; } .t th { background:${C10}; border:1px solid ${C25}; padding:4px; font-size:9.5px; text-align:left; }
  .t td { border:1px solid #cbd5e1; padding:4px; height:21px; overflow-wrap:anywhere; vertical-align:top; } .t td.n { text-align:center; color:#6b7280; width:6%; }
  .tot { text-align:right; margin-top:5px; font-size:10.5px; } .tot span { display:inline-block; min-width:52px; border-bottom:1px solid #111; text-align:right; font-weight:bold; }
  .decl { margin:5px 0 0; text-align:justify; line-height:1.4; } .obs { margin-top:7px; }
  .sign { display:flex; justify-content:space-around; gap:30px; margin-top:34px; } .sign > div { width:44%; border-top:1px solid #111; text-align:center; padding-top:4px; font-size:10px; } .sign small { color:#6b7280; font-size:8.5px; }
  .interno { margin-top:10px; padding-top:8px; border-top:1px dashed #94a3b8; }
  .pie { margin-top:8px; text-align:center; color:#6b7280; font-size:8.5px; } i.pend { color:#94a3b8; font-size:9px; }
</style>
<style id="edit-css">
  [contenteditable="true"] { background:#fffbea; outline:1px dashed #d6c56a; cursor:text; } [contenteditable="true"]:hover { background:#fff6c2; }
  [contenteditable="true"]:focus { background:#fff6c2; outline:2px solid #3b82f6; } .cb { cursor:pointer; background:#fffbea; } .cb:hover { outline:2px solid #3b82f6; }
  .t th.x, .t td.x { width:0; padding:0 !important; border:0 !important; background:none !important; overflow:visible; position:relative; } .rm { position:absolute; left:5px; top:50%; margin-top:-9px; border:0; background:#fee2e2; color:#b91c1c; border-radius:4px; width:18px; height:18px; cursor:pointer; line-height:1; font-size:13px; }
</style></head><body>
  <div class="hd">${logo}<div class="tag">${_esc(TAGLINE)}</div></div>
  <div class="ttl"><b>${_esc(T.nombre.toUpperCase())}</b><span>${_esc(T.sub)}</span></div>
  ${cuerpo}
  <div class="pie">Documento de uso interno y comercial · ${_esc(E.nombre)} · Página 1</div>
</body></html>`
}
/** HTML limpio para PDF: sin edición, sin botones de fila, sin fondos amarillos. */
function limpiarHTML(htmlStr) {
  const d = new DOMParser().parseFromString(htmlStr, 'text/html')
  d.querySelectorAll('#edit-css, .x').forEach(n => n.remove())
  d.querySelectorAll('[contenteditable]').forEach(n => n.removeAttribute('contenteditable'))
  return '<!doctype html>' + d.documentElement.outerHTML
}

/* ───────────────────────── Editor (modal con la hoja en un iframe) ───────────────────────── */
async function abrirEditor({ tipo, emp, contacto, registro, alGuardar }) {
  const E = await emisorPDF({ empresa_id: emp })
  const estado = { id: registro?.id || null, numero: registro?.numero || null }
  const D = registro ? registro.datos : prefill(tipo, contacto)
  const T = TIPOS[tipo]
  const ov = document.createElement('div'); ov.className = 'dfm-ov'
  ov.innerHTML = `<div class="dfm-bar"><b>${T.icono} ${_esc(T.nombre)}</b><span class="dfm-num" id="dfmNum">${estado.numero ? _esc(estado.numero) : 'Nuevo'}</span>
    <span class="dfm-hint">Escribe directo sobre la hoja · los casilleros se marcan con un clic · lo que ves es el PDF</span>
    <span class="dfm-sp"></span><button type="button" data-a="fila" class="dfm-btn">＋ Fila</button><button type="button" data-a="borrador" class="dfm-btn">⬇ Solo descargar</button>
    <button type="button" data-a="guardar" class="dfm-btn pri">💾 Guardar y descargar PDF</button><button type="button" data-a="cerrar" class="dfm-btn">✕</button></div>
    <div class="dfm-hoja"><iframe title="${_esc(T.nombre)}"></iframe></div>`
  document.body.appendChild(ov); document.body.classList.add('dfm-abierto')
  const ifr = ov.querySelector('iframe'); let doc = null
  const cerrar = () => { ov.remove(); document.body.classList.remove('dfm-abierto') }
  const ajustar = () => { if (doc) ifr.style.height = Math.max(1123, doc.documentElement.scrollHeight + 4) + 'px' }
  const recalcular = () => {
    const tot = doc.querySelector('[data-total]'); if (!tot) return
    const t = doc.querySelector('table[data-t="items"]'); let s = 0
    t.tBodies[0].querySelectorAll('tr').forEach(tr => { const c = tr.querySelectorAll('td[contenteditable]')[3]; s += parseFloat(String(c?.textContent || '').replace(/,/g, '.').replace(/[^0-9.]/g, '')) || 0 })
    tot.textContent = s.toLocaleString('es-PE', { maximumFractionDigits: 2 })
  }
  const renumerar = () => doc.querySelectorAll('table[data-num="1"]').forEach(t => [...t.tBodies[0].rows].forEach((r, i) => { const n = r.querySelector('td.n'); if (n) n.textContent = i + 1 }))
  const leer = () => ({
    f: Object.fromEntries([...doc.querySelectorAll('.f[data-k]')].map(e => [e.dataset.k, (e.classList.contains('ml') ? e.innerText : e.textContent).trim()])),
    c: Object.fromEntries([...doc.querySelectorAll('.cb[data-k]')].map(e => [e.dataset.k, e.dataset.on === '1' ? 1 : 0])),
    t: Object.fromEntries([...doc.querySelectorAll('table[data-t]')].map(t => [t.dataset.t, [...t.tBodies[0].rows].map(r => [...r.querySelectorAll('td[contenteditable]')].map(td => td.textContent.trim()))]))
  })
  const nombreCliente = d => d.f.cli_razon || d.f.sol_razon || ''
  const ponerNumero = txt => { const el = doc.querySelector('[data-numero]'); if (el) el.textContent = txt; ov.querySelector('#dfmNum').textContent = txt }
  async function emitir(guardar) {
    const d = leer()
    if (guardar) {
      if (!estado.id) {
        const { data, error } = await supabase.rpc('crm_doc_emitir', { p_empresa: emp, p_tipo: tipo, p_contact_id: contacto?.id ?? registro?.contact_id ?? null, p_cliente: nombreCliente(d), p_datos: d })
        if (error) throw new Error(/does not exist|schema cache/i.test(error.message) ? 'Falta correr el SQL 155 para guardar el historial (puedes usar "Solo descargar").' : error.message)
        estado.id = data[0].doc_id; estado.numero = data[0].doc_numero
      } else {
        const { error } = await supabase.from('crm_documentos_formato').update({ datos: d, cliente_nombre: nombreCliente(d) || null, updated_at: new Date().toISOString() }).eq('id', estado.id)
        if (error) throw new Error(error.message)
      }
      ponerNumero(estado.numero)
    } else ponerNumero(estado.numero || 'BORRADOR')
    await descargarPDFDesdeHTML(limpiarHTML('<!doctype html>' + doc.documentElement.outerHTML), `${estado.numero || 'BORRADOR-' + tipo}_${slug(nombreCliente(d))}.pdf`)
    if (guardar && alGuardar) alGuardar()
  }
  ov.addEventListener('click', async e => {
    const b = e.target.closest('[data-a]'); if (!b) return
    const a = b.dataset.a
    if (a === 'cerrar') { if (confirm('¿Cerrar el editor? Los cambios no guardados se perderán.')) cerrar(); return }
    if (a === 'fila') {
      const t = doc.querySelector('table[data-t]'); if (!t) return
      const n = +t.dataset.cols; t.tBodies[0].insertAdjacentHTML('beforeend', trHTML(Array(n).fill(0), [], t.tBodies[0].rows.length, t.dataset.num === '1'))
      renumerar(); ajustar(); return
    }
    b.disabled = true; const txt = b.textContent; b.textContent = 'Generando…'
    try { await emitir(a === 'guardar'); showToast(a === 'guardar' ? `Guardado como ${estado.numero} y descargado` : 'PDF descargado (borrador, sin guardar)', 'success') }
    catch (err) { console.error(err); showToast(err.message || 'No se pudo generar el PDF', 'error') }
    finally { b.disabled = false; b.textContent = txt }
  })
  ifr.onload = () => {
    doc = ifr.contentDocument
    doc.addEventListener('click', e => {
      const c = e.target.closest('.cb'); if (c) { c.dataset.on = c.dataset.on === '1' ? '0' : '1'; return }
      const r = e.target.closest('.rm'); if (r) { const tb = r.closest('tbody'); if (tb.rows.length > 1) { r.closest('tr').remove(); renumerar(); recalcular(); ajustar() } else showToast('Deja al menos una fila', 'warning') }
    })
    doc.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.target.classList?.contains('ml')) e.preventDefault() })
    doc.addEventListener('paste', e => { e.preventDefault(); const t = (e.clipboardData || window.clipboardData).getData('text/plain'); doc.execCommand('insertText', false, t.replace(/\s*\n\s*/g, e.target.classList?.contains('ml') ? '\n' : ' ')) })
    doc.addEventListener('input', () => { recalcular(); ajustar() })
    recalcular(); ajustar()
  }
  ifr.srcdoc = htmlDocumento(tipo, E, D, estado.numero)
}

/* ───────────────────────── Pestaña CRM → Documentos ───────────────────────── */
export async function renderDocumentos(cont, { emp }) {
  await cargarCss(new URL('../../css/documentos-formato.css', import.meta.url).href)
  cont.innerHTML = '<div class="dfm-skel">Cargando…</div>'
  const [rc, rh] = await Promise.all([
    supabase.from('contacts').select('id,nombre,tipo_documento,nro_documento,direccion,distrito,email,numero,tipo_contacto').overlaps('tipo_contacto', ['cliente']).order('nombre').limit(4000),
    supabase.from('crm_documentos_formato').select('id,tipo,numero,contact_id,cliente_nombre,datos,created_at,updated_at').eq('empresa_id', emp).order('created_at', { ascending: false }).limit(150)
  ])
  if (rc.error) showToast('No pude cargar los clientes: ' + rc.error.message, 'error')
  const clientes = rc.data || [], hist = rh.data || [], sinSQL = !!rh.error
  const etiqueta = c => `${c.nombre}${c.nro_documento && !/^0+$/.test(c.nro_documento) ? ' · ' + c.nro_documento : ''}`
  const porId = new Map(clientes.map(c => [String(c.id), c]))
  const filas = () => hist.length ? hist.map(h => `<tr><td><b>${_esc(h.numero)}</b></td><td>${_esc(TIPOS[h.tipo]?.nombre || h.tipo)}</td><td>${_esc(h.cliente_nombre || '— en blanco —')}</td><td>${fmtF(h.created_at)}</td>
      <td class="dfm-acc"><button class="btn btn-small" data-ab="${h.id}">✏️ Abrir y editar</button> <button class="btn btn-small btn-secondary" data-pdf="${h.id}">⬇ PDF</button></td></tr>`).join('')
    : `<tr><td colspan="5" class="dfm-vacio">${sinSQL ? 'Corre el SQL 155 para activar el historial (mientras tanto puedes generar y descargar borradores).' : 'Aún no emitiste documentos.'}</td></tr>`
  cont.innerHTML = `<div class="card dfm-card"><h3>📄 Documentos formales</h3>
    <p class="dfm-sub">Elige un cliente (o déjalo vacío para un formato en blanco), abre la hoja y complétala como en el papel. Se descarga en PDF con el logo y datos de la empresa activa.</p>
    <div class="dfm-pick"><label>Cliente</label><div id="dfmCli"></div></div>
    <div class="dfm-tipos">${Object.entries(TIPOS).map(([k, t]) => `<button type="button" class="dfm-tipo" data-nuevo="${k}"><span class="ic">${t.icono}</span><b>${_esc(t.nombre)}</b><small>${_esc(t.desc)}</small><em>Abrir hoja →</em></button>`).join('')}</div></div>
    <div class="card dfm-card"><h3>Historial</h3><div class="dfm-tabla"><table class="data-table"><thead><tr><th>N°</th><th>Documento</th><th>Cliente</th><th>Fecha</th><th></th></tr></thead><tbody id="dfmHist">${filas()}</tbody></table></div></div>`
  const bvCli = crearBuscador(cont.querySelector('#dfmCli'), { opciones: clientes.map(c => ({ v: c.id, l: c.nombre, sub: c.nro_documento && !/^0+$/.test(c.nro_documento) ? `${c.tipo_documento || 'Doc'} ${c.nro_documento}` : '' })), placeholder: 'Sin cliente (formato en blanco)' })
  const refrescar = () => renderDocumentos(cont, { emp })
  cont.querySelectorAll('[data-nuevo]').forEach(b => b.onclick = () => {
    const c = porId.get(bvCli.get()) || null
    abrirEditor({ tipo: b.dataset.nuevo, emp, contacto: c, alGuardar: refrescar }).catch(e => showToast(e.message, 'error'))
  })
  cont.querySelector('#dfmHist').onclick = async e => {
    const ab = e.target.closest('[data-ab]'), pf = e.target.closest('[data-pdf]'); if (!ab && !pf) return
    const h = hist.find(x => String(x.id) === (ab || pf).dataset[ab ? 'ab' : 'pdf'])
    if (ab) return abrirEditor({ tipo: h.tipo, emp, registro: h, alGuardar: refrescar }).catch(e => showToast(e.message, 'error'))
    try { showToast('Generando PDF…', 'info', 2000); const E = await emisorPDF({ empresa_id: emp })
      await descargarPDFDesdeHTML(limpiarHTML(htmlDocumento(h.tipo, E, h.datos, h.numero)), `${h.numero}_${slug(h.cliente_nombre)}.pdf`) } catch (er) { showToast(er.message, 'error') }
  }
}
