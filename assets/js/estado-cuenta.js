// ============================================================================
// ESTADO DE CUENTA DEL CLIENTE — vista previa + descarga PDF / PNG (2026-10-10)
// ============================================================================
// Uno o varios clientes (p. ej. la empresa y su vinculada) en un solo documento:
//   Cuadro 1 · Comprobantes pendientes: facturas/boletas con saldo propio o
//              canjeadas en letras que siguen vivas (una fila por artículo,
//              con packing y LOTE). Subtotal por moneda.
//   Cuadro 2 · Letras pendientes de esas facturas (incluye renovadas /
//              unificadas, cuyo origen se rastrea hasta la factura).
//   Saldo al corte = saldo propio de las facturas + saldo de las letras.
// Días: en facturas "Días" = desde la emisión y "Atraso" = vs. vencimiento;
// en letras "Días" = corte − vencimiento (negativo = faltan, positivo = vencida).
// Analogía: el cuadro 1 es lo que el cliente compró; el 2, cómo lo está pagando.
// ============================================================================

import { supabase } from './supabase-client.js'
import { formatNumber, fechaDMY, showToast } from './helpers.js'
import { getModuloConfig } from './config-modulo.js'

const _esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const _n = v => Math.round((parseFloat(v) || 0) * 100) / 100
const _hoy = () => new Date().toISOString().slice(0, 10)
const _dias = (desde, hasta) => (desde && hasta) ? Math.round((new Date(hasta + 'T00:00:00') - new Date(desde + 'T00:00:00')) / 86400000) : null
const _SIMB = m => (m === 'USD' ? 'US$' : 'S/')
const _ABIERTAS = ['cartera', 'banco', 'cobranza', 'parcial', 'protestada']

const _st = { sel: new Set(), corte: _hoy(), moneda: '', contactos: [], datos: null, cont: null, opts: {} }

function _empresa() {
  const c = (() => { try { return getModuloConfig('cobranzas') || {} } catch (_) { return {} } })()
  return {
    nombre: c.empresaNombre || 'JHIRO PERU S.A.C.',
    ruc: c.empresaRuc || '20600842995',
    direccion: c.empresaDireccion || 'Av. Santa Rosa Lt. 15 Mz. S Urb. San Gabriel — San Juan de Lurigancho, Lima',
    email: c.empresaEmail || 'gerencia@jhiroperu.com',
    telefono: c.empresaTelefono || '979050317',
    web: c.empresaWeb || 'https://jhiroperu.com',
    pie: c.textoPieEstadoCuenta || 'La línea de crédito será renovada a finales de julio y fines de diciembre de cada año, por lo tanto las cuentas deben estar en cero... ¡Gracias por su apoyo y confianza!'
  }
}

// ── Datos ────────────────────────────────────────────────────────────────────
async function _q(tabla, sel, fn) {
  let q = supabase.from(tabla).select(sel)
  if (fn) q = fn(q)
  const { data, error } = await q
  if (error) throw new Error(`${tabla}: ${error.message}`)
  return data || []
}
const _enLotes = async (tabla, sel, campo, ids) => {
  const out = []
  const u = [...new Set(ids.filter(Boolean))]
  for (let i = 0; i < u.length; i += 200) out.push(...await _q(tabla, sel, q => q.in(campo, u.slice(i, i + 200))))
  return out
}

function _saldoCxC(c) {
  return _n(parseFloat(c.monto_total || 0) + parseFloat(c.monto_notas_debito || 0) - parseFloat(c.monto_notas_credito || 0)
    - parseFloat(c.monto_cobrado || 0) - parseFloat(c.monto_retenido || 0) - parseFloat(c.monto_canjeado || 0) - parseFloat(c.monto_anticipo_aplicado || 0))
}
const _saldoLetra = l => _ABIERTAS.includes(l.estado) ? Math.max(0, _n(parseFloat(l.monto || 0) - parseFloat(l.monto_pagado || 0))) : 0

async function _cargarContactos() {
  const cxc = await _q('cuentas_cobrar', 'contact_id, estado')
  const ids = [...new Set(cxc.filter(c => c.estado !== 'anulado').map(c => c.contact_id))]
  const cts = await _enLotes('contacts', 'id, nombre, nro_documento', 'id', ids)
  _st.contactos = cts.sort((a, b) => String(a.nombre).localeCompare(String(b.nombre), 'es'))
}

async function _cargarDatos() {
  const ids = [..._st.sel]
  if (!ids.length) return null
  const [cxcs, letras, bancos] = await Promise.all([
    _enLotes('cuentas_cobrar', '*', 'contact_id', ids),
    _enLotes('letras_cambio', '*', 'contact_id', ids),
    _q('bancos', 'id, nombre, moneda')
  ])
  const letrasE = letras.filter(l => l.tipo === 'emitida')
  const vivas = letrasE.filter(l => _saldoLetra(l) > 0.005)
  // Origen de cada letra viva → factura (sigue renovaciones/unificaciones)
  let origen = []
  try { origen = await _q('letras_refinanciacion_origen', 'refinanciacion_id, letra_id') } catch (_) { origen = [] }
  const letraPorId = new Map(letrasE.map(l => [l.id, l]))
  const faltan = origen.map(o => o.letra_id).filter(id => !letraPorId.has(id))
  if (faltan.length) (await _enLotes('letras_cambio', '*', 'id', faltan)).forEach(l => letraPorId.set(l.id, l))
  const cxcDeLetra = (l, prof = 0) => {
    if (!l || prof > 8) return []
    if (l.cxc_id) return [l.cxc_id]
    if (!l.refinanciacion_id) return []
    return origen.filter(o => o.refinanciacion_id === l.refinanciacion_id).flatMap(o => cxcDeLetra(letraPorId.get(o.letra_id), prof + 1))
  }
  const cxcMap = new Map(cxcs.map(c => [c.id, c]))
  const faltanCxc = vivas.flatMap(l => cxcDeLetra(l)).filter(id => !cxcMap.has(id))
  if (faltanCxc.length) (await _enLotes('cuentas_cobrar', '*', 'id', faltanCxc)).forEach(c => cxcMap.set(c.id, c))
  const conLetras = new Set(vivas.flatMap(l => cxcDeLetra(l)))
  const facturas = [...cxcMap.values()].filter(c => c.estado !== 'anulado' && (_saldoCxC(c) > 0.009 || conLetras.has(c.id)))
    .filter(c => !_st.moneda || (c.moneda || 'PEN') === _st.moneda)
    .sort((a, b) => String(a.fecha_emision).localeCompare(String(b.fecha_emision)) || String(a.numero_comprobante).localeCompare(String(b.numero_comprobante)))

  // Detalle de la venta: artículo, lote, cajas, cantidad, packing
  const ventas = await _enLotes('ventas', 'id, packing_id, numero, fecha_vencimiento', 'id', facturas.map(f => f.venta_id))
  const dets = await _enLotes('detalle_ventas', 'venta_id, descripcion, cantidad, cantidad_unidades, unidad_medida, total_linea, lote_id', 'venta_id', ventas.map(v => v.id))
  const lotes = await _enLotes('lotes', 'id, numero_lote', 'id', dets.map(d => d.lote_id))
  let packs = []
  try { packs = await _enLotes('packing', 'id, numero', 'id', ventas.map(v => v.packing_id)) } catch (_) {}
  const ventaMap = new Map(ventas.map(v => [v.id, v]))
  const loteMap = new Map(lotes.map(l => [l.id, l.numero_lote]))
  const packMap = new Map(packs.map(p => [p.id, p.numero]))
  const contMap = new Map(_st.contactos.map(c => [c.id, c]))

  const docTxt = c => `${c.serie ? c.serie + '-' : ''}${String(c.numero_comprobante || '').replace(/^0+/, '')}`
  const filasF = facturas.map(c => {
    const v = ventaMap.get(c.venta_id)
    const lineas = dets.filter(d => d.venta_id === c.venta_id).map(d => ({
      articulo: d.descripcion || '', lote: loteMap.get(d.lote_id) || '—',
      cajas: parseFloat(d.cantidad_unidades) || 0, cantidad: parseFloat(d.cantidad) || 0, um: d.unidad_medida || '',
      precio: (parseFloat(d.cantidad) || 0) ? (parseFloat(d.total_linea) || 0) / parseFloat(d.cantidad) : 0,
      total: parseFloat(d.total_linea) || 0
    }))
    const total = _n(parseFloat(c.monto_total || 0) + parseFloat(c.monto_notas_debito || 0) - parseFloat(c.monto_notas_credito || 0))
    return {
      id: c.id, cliente: contMap.get(c.contact_id)?.nombre || '', moneda: c.moneda || 'PEN',
      packing: packMap.get(v?.packing_id) || '—', doc: docTxt(c), emision: c.fecha_emision, venc: c.fecha_vencimiento || v?.fecha_vencimiento,
      lineas: lineas.length ? lineas : [{ articulo: '(sin detalle)', lote: '—', cajas: 0, cantidad: 0, um: '', precio: 0, total }],
      total, cobrado: _n(parseFloat(c.monto_cobrado || 0) + parseFloat(c.monto_retenido || 0) + parseFloat(c.monto_anticipo_aplicado || 0)),
      canjeado: _n(c.monto_canjeado), saldo: _saldoCxC(c)
    }
  })
  const docPorCxc = new Map(facturas.map(c => [c.id, docTxt(c)]))
  const filasL = vivas.filter(l => !_st.moneda || (l.moneda || 'PEN') === _st.moneda)
    .sort((a, b) => String(a.fecha_vencimiento).localeCompare(String(b.fecha_vencimiento)))
    .map(l => {
      const dias = _dias(l.fecha_vencimiento, _st.corte)
      const est = l.estado === 'parcial' ? 'Parcial' : l.estado === 'protestada' ? 'Protestada' : (l.refinanciacion_id ? 'Renovada' : (['banco', 'cobranza'].includes(l.estado) ? 'En banco' : 'Vigente'))
      return {
        id: l.id, cliente: contMap.get(l.contact_id)?.nombre || '', moneda: l.moneda || 'PEN', dias, numero: l.numero_letra,
        emision: l.fecha_emision, venc: l.fecha_vencimiento,
        factura: [...new Set(cxcDeLetra(l).map(id => docPorCxc.get(id) || (cxcMap.get(id) ? docTxt(cxcMap.get(id)) : '')))].filter(Boolean).join(', ') || '—',
        importe: _n(l.monto), pagado: _n(l.monto_pagado), saldo: _saldoLetra(l), unico: l.numero_operacion || '',
        ubicacion: ['banco', 'cobranza'].includes(l.estado) ? (bancos.find(b => b.id === l.banco_id)?.nombre || 'Banco') : 'Cartera', estado: est
      }
    })
  const clientes = ids.map(id => contMap.get(id)).filter(Boolean)
  return { filasF, filasL, clientes, multiCliente: clientes.length > 1 }
}

// ── Totales por moneda ───────────────────────────────────────────────────────
function _porMoneda(filas, campos) {
  const out = {}
  filas.forEach(f => {
    const m = f.moneda || 'PEN'
    out[m] ||= Object.fromEntries(campos.map(c => [c, 0]))
    campos.forEach(c => { out[m][c] = _n(out[m][c] + (parseFloat(f[c]) || 0)) })
  })
  return out
}
function _saldoFinal(d) {
  const fx = _porMoneda(d.filasF, ['saldo']), lx = _porMoneda(d.filasL, ['saldo'])
  const mons = [...new Set([...Object.keys(fx), ...Object.keys(lx)])].sort((a, b) => (a === 'USD' ? -1 : 1))
  return mons.map(m => ({ moneda: m, facturas: fx[m]?.saldo || 0, letras: lx[m]?.saldo || 0, total: _n((fx[m]?.saldo || 0) + (lx[m]?.saldo || 0)) }))
}

// ── Vista previa (hoja blanca, independiente del tema) ───────────────────────
const _CSS = `
.ecc-paper { background:#fff; color:#1f2937; font-family: 'Segoe UI', Arial, sans-serif; font-size:11px; padding:22px 26px; border-radius:6px; max-width:1180px; margin:0 auto; box-shadow:0 4px 18px rgba(0,0,0,.25); }
.ecc-head { display:flex; align-items:center; gap:16px; border-bottom:2px solid #111827; padding-bottom:8px; }
.ecc-head img { height:34px; }
.ecc-emp { font-size:9.5px; line-height:1.35; color:#374151; flex:1; }
.ecc-emp b { font-size:11px; color:#111827; }
.ecc-fecha { text-align:right; font-size:10px; color:#6b7280; }
.ecc-fecha b { display:block; font-size:15px; color:#b91c1c; }
.ecc-tit { text-align:center; font-size:16px; font-weight:800; letter-spacing:.5px; margin:10px 0 6px; text-decoration:underline; }
.ecc-cli { background:#fef3c7; border-left:4px solid #f59e0b; padding:6px 10px; margin-bottom:10px; font-size:11px; }
.ecc-cli div { line-height:1.5; } .ecc-cli span { color:#6b7280; display:inline-block; min-width:92px; }
.ecc-sec { font-size:11px; font-weight:800; text-transform:uppercase; letter-spacing:.4px; margin:12px 0 4px; color:#111827; }
.ecc-t { width:100%; border-collapse:collapse; font-size:10px; }
.ecc-t th { background:#111827; color:#fff; padding:4px 5px; text-align:left; font-weight:600; white-space:nowrap; }
.ecc-t td { padding:3px 5px; border-bottom:1px solid #e5e7eb; vertical-align:top; color:#1f2937; }
.ecc-t .r { text-align:right; white-space:nowrap; } .ecc-t .c { text-align:center; }
.ecc-t tr.doc-ini td { border-top:1px solid #9ca3af; }
.ecc-t tfoot td { background:#f3f4f6; font-weight:700; border-top:2px solid #111827; }
.ecc-venc { color:#b91c1c; font-weight:700; } .ecc-ok { color:#047857; }
.ecc-saldo { display:flex; justify-content:space-between; align-items:center; background:#fde68a; border:2px solid #f59e0b; padding:8px 12px; margin-top:12px; font-weight:800; font-size:13px; }
.ecc-saldo small { font-weight:500; font-size:10px; color:#374151; display:block; }
.ecc-pie { margin-top:10px; background:#fef3c7; padding:6px 10px; text-align:center; font-size:9.5px; font-weight:600; color:#374151; }
.ecc-vacio { padding:30px; text-align:center; color:#6b7280; }
/* Aislar la hoja de los estilos globales de tablas (tema oscuro) */
.ecc-paper table.ecc-t, .ecc-paper table.ecc-t tbody, .ecc-paper table.ecc-t thead, .ecc-paper table.ecc-t tfoot { background:#fff !important; border:0 !important; box-shadow:none !important; }
.ecc-paper table.ecc-t tr { background:#fff !important; height:auto !important; }
.ecc-paper table.ecc-t tr:hover td { background:#f9fafb !important; }
.ecc-paper table.ecc-t th { background:#111827 !important; color:#fff !important; padding:4px 5px !important; font-size:9.5px !important; line-height:1.25 !important; text-transform:none !important; letter-spacing:0 !important; position:static !important; border:0 !important; }
.ecc-paper table.ecc-t td { background:#fff !important; color:#1f2937 !important; padding:3px 5px !important; font-size:9.5px !important; line-height:1.3 !important; border:0 !important; border-bottom:1px solid #e5e7eb !important; opacity:1 !important; }
.ecc-paper table.ecc-t td small { color:#6b7280 !important; font-size:8.5px !important; }
.ecc-paper table.ecc-t tr.doc-ini td { border-top:1px solid #9ca3af !important; }
.ecc-paper table.ecc-t tfoot td { background:#f3f4f6 !important; font-weight:700 !important; border-top:2px solid #111827 !important; }
.ecc-paper table.ecc-t td.ecc-venc { color:#b91c1c !important; font-weight:700 !important; }
.ecc-paper table.ecc-t td.ecc-ok { color:#047857 !important; }
.ecc-paper table.ecc-t .r { text-align:right !important; } .ecc-paper table.ecc-t .c { text-align:center !important; }
.ecc-paper table.ecc-t td.art { min-width:170px; }
`

function _htmlPaper(d) {
  const e = _empresa()
  const corte = fechaDMY(_st.corte)
  const fm = v => formatNumber(v, 2)
  const totF = _porMoneda(d.filasF, ['total', 'cobrado', 'canjeado', 'saldo'])
  const totL = _porMoneda(d.filasL, ['importe', 'pagado', 'saldo'])
  const cli = d.multiCliente
  const filasF = d.filasF.map(f => f.lineas.map((ln, i) => {
    const atraso = _dias(f.venc, _st.corte)
    return `<tr class="${i === 0 ? 'doc-ini' : ''}">
      ${i === 0 ? `<td>${_esc(f.packing)}</td><td><b>${_esc(f.doc)}</b>${cli ? `<br><small style="color:#6b7280;">${_esc(f.cliente)}</small>` : ''}</td><td>${fechaDMY(f.emision)}</td>` : '<td></td><td></td><td></td>'}
      <td class="art">${_esc(ln.articulo)}</td><td>${_esc(ln.lote)}</td>
      <td class="r">${ln.cajas ? formatNumber(ln.cajas, 0) : ''}</td><td class="r">${formatNumber(ln.cantidad, 2)}</td>
      <td class="r">${formatNumber(ln.precio, 2)}</td><td class="r">${fm(ln.total)}</td>
      ${i === 0 ? `<td class="c">${f.moneda}</td><td class="r">${fm(f.total)}</td><td class="r">${f.cobrado ? fm(f.cobrado) : '—'}</td><td class="r">${f.canjeado ? fm(f.canjeado) : '—'}</td>
        <td class="r"><b>${fm(f.saldo)}</b></td><td class="r">${_dias(f.emision, _st.corte) ?? '—'}</td>
        <td class="r ${atraso > 0 && f.saldo > 0.009 ? 'ecc-venc' : ''}">${f.saldo > 0.009 && atraso !== null ? (atraso > 0 ? '+' : '') + atraso : '—'}</td>`
        : '<td></td><td></td><td></td><td></td><td></td><td></td><td></td>'}
    </tr>`
  }).join('')).join('')
  const pieF = Object.entries(totF).map(([m, t]) => `<tr><td colspan="9">Subtotal comprobantes ${m}</td><td class="c">${m}</td><td class="r">${fm(t.total)}</td><td class="r">${fm(t.cobrado)}</td><td class="r">${fm(t.canjeado)}</td><td class="r">${_SIMB(m)} ${fm(t.saldo)}</td><td colspan="2"></td></tr>`).join('')
  const filasL = d.filasL.map(l => `<tr>
      <td class="r ${l.dias > 0 ? 'ecc-venc' : 'ecc-ok'}">${l.dias === null ? '—' : (l.dias > 0 ? '+' : '') + l.dias}</td>
      <td><b>${_esc(l.numero)}</b>${cli ? `<br><small style="color:#6b7280;">${_esc(l.cliente)}</small>` : ''}</td>
      <td>${fechaDMY(l.emision)}</td><td>${fechaDMY(l.venc)}</td><td>${_esc(l.factura)}</td><td class="c">${l.moneda}</td>
      <td class="r">${fm(l.importe)}</td><td class="r">${l.pagado ? fm(l.pagado) : '—'}</td><td class="r"><b>${fm(l.saldo)}</b></td>
      <td>${_esc(l.unico || '')}</td><td>${_esc(l.ubicacion)}</td><td>${_esc(l.estado)}</td></tr>`).join('')
  const pieL = Object.entries(totL).map(([m, t]) => `<tr><td colspan="5">Subtotal letras ${m}</td><td class="c">${m}</td><td class="r">${fm(t.importe)}</td><td class="r">${fm(t.pagado)}</td><td class="r">${_SIMB(m)} ${fm(t.saldo)}</td><td colspan="3"></td></tr>`).join('')
  const saldos = _saldoFinal(d)
  return `<div class="ecc-paper" id="ecc-paper">
    <div class="ecc-head">
      <img src="assets/img/logo-jhiro.png" alt="JHIRO" crossorigin="anonymous">
      <div class="ecc-emp"><b>${_esc(e.nombre)}</b> · RUC ${_esc(e.ruc)}<br>${_esc(e.direccion)}<br>${_esc(e.email)} · Tel. ${_esc(e.telefono)} · ${_esc(e.web)}</div>
      <div class="ecc-fecha">Saldo al<b>${corte}</b></div>
    </div>
    <div class="ecc-tit">ESTADO DE CUENTA</div>
    <div class="ecc-cli">${d.clientes.map(c => `<div><span>RUC ${_esc(c.nro_documento || '—')}</span> <b>${_esc(c.nombre)}</b></div>`).join('')}</div>

    <div class="ecc-sec">1 · Comprobantes pendientes (${d.filasF.length})</div>
    ${d.filasF.length ? `<table class="ecc-t"><thead><tr>
      <th>Packing</th><th>Comprobante</th><th>Emisión</th><th>Artículo</th><th>Lote</th><th class="r">Cajas</th><th class="r">Cantidad</th><th class="r">Precio</th><th class="r">Importe</th>
      <th class="c">Mon.</th><th class="r">Total doc.</th><th class="r">Cobrado</th><th class="r">En letras</th><th class="r">Saldo</th><th class="r">Días</th><th class="r">Atraso</th>
    </tr></thead><tbody>${filasF}</tbody><tfoot>${pieF}</tfoot></table>` : '<div class="ecc-vacio">Sin comprobantes pendientes.</div>'}

    <div class="ecc-sec">2 · Letras pendientes (${d.filasL.length})</div>
    ${d.filasL.length ? `<table class="ecc-t"><thead><tr>
      <th class="r" title="− faltan días · + vencida">Días</th><th>N° Letra</th><th>Emisión</th><th>Vencimiento</th><th>Factura</th><th class="c">Mon.</th>
      <th class="r">Importe</th><th class="r">Pagado</th><th class="r">Saldo</th><th>N° único</th><th>Banco</th><th>Estado</th>
    </tr></thead><tbody>${filasL}</tbody><tfoot>${pieL}</tfoot></table>` : '<div class="ecc-vacio">Sin letras pendientes.</div>'}

    ${saldos.map(s => `<div class="ecc-saldo"><div>SALDO AL ${corte} (${s.moneda})<small>Comprobantes ${_SIMB(s.moneda)} ${fm(s.facturas)} + Letras ${_SIMB(s.moneda)} ${fm(s.letras)}</small></div><div>${_SIMB(s.moneda)} ${fm(s.total)}</div></div>`).join('') || '<div class="ecc-saldo"><div>SALDO</div><div>0.00</div></div>'}
    <div class="ecc-pie">${_esc(e.pie)}</div>
  </div>`
}

// ── UI ───────────────────────────────────────────────────────────────────────
function _htmlSelector() {
  const sel = _st.sel
  const txt = !sel.size ? 'Elige cliente(s)…' : sel.size === 1 ? (_st.contactos.find(c => sel.has(c.id))?.nombre || '1 cliente') : `${sel.size} clientes`
  return `<div class="rp-ms" id="ecc-ms" style="min-width:300px;">
    <button type="button" class="rp-ms-btn ${sel.size ? 'activo' : ''}"><span class="rp-ms-txt">${_esc(txt)}</span> <span>▾</span></button>
    <div class="rp-ms-panel" hidden style="min-width:340px;">
      <input type="text" class="rp-ms-buscar" placeholder="Buscar cliente o RUC...">
      <div class="rp-ms-acc"><a href="#" data-ecc-limpiar>Limpiar</a></div>
      <div class="rp-ms-lista">${_st.contactos.map(c => `<label class="rp-ms-op" data-txt="${_esc((c.nombre + ' ' + (c.nro_documento || '')).toLowerCase())}">
        <input type="checkbox" value="${c.id}" ${sel.has(c.id) ? 'checked' : ''}> <span>${_esc(c.nombre)} <small style="color:var(--text-secondary);">${_esc(c.nro_documento || '')}</small></span></label>`).join('')}</div>
    </div></div>`
}

export async function renderEstadoCuentaCliente(cont, opts = {}) {
  _st.cont = cont; _st.opts = opts
  cont.innerHTML = '<p style="text-align:center; padding:20px;">Cargando clientes…</p>'
  try { await _cargarContactos() } catch (e) { cont.innerHTML = `<p style="color:var(--color-danger);">Error: ${_esc(e.message)}</p>`; return }
  cont.innerHTML = `<style>${_CSS}</style>
    <div class="card reporte-card">
      <div class="card-header">
        <div><h3 class="card-title">Estado de cuenta del cliente</h3>
          <div class="reporte-desc">Comprobantes pendientes (con lote) y letras por cobrar de uno o varios clientes. Descárgalo en PDF (A4) o PNG para enviarlo.</div></div>
        <div style="display:flex; gap:8px; flex-wrap:wrap;">
          ${opts.onMovimientos ? '<button class="btn btn-secondary btn-small" id="ecc-mov" title="Tabla dinámica de todos los movimientos (cargos y abonos)">📊 Movimientos</button>' : ''}
          <button class="btn btn-secondary btn-small" id="ecc-png">⬇ PNG</button>
          <button class="btn btn-primary btn-small" id="ecc-pdf">⬇ PDF</button>
        </div>
      </div>
      <div class="reporte-filtros">
        <div class="reporte-filtro"><label>Cliente(s)</label><div id="ecc-sel">${_htmlSelector()}</div></div>
        <div class="reporte-filtro"><label>Saldo al</label><input type="date" id="ecc-corte" value="${_st.corte}"></div>
        <div class="reporte-filtro"><label>Moneda</label><select id="ecc-moneda"><option value="">Todas</option><option value="USD" ${_st.moneda === 'USD' ? 'selected' : ''}>USD</option><option value="PEN" ${_st.moneda === 'PEN' ? 'selected' : ''}>PEN</option></select></div>
      </div>
      <div id="ecc-prev" style="padding:14px; background:var(--bg-tertiary, rgba(127,127,127,.12)); border-radius:var(--radius-md); overflow-x:auto;"></div>
    </div>`
  _bind()
  await _refrescar()
}

function _bind() {
  const c = _st.cont
  const box = c.querySelector('#ecc-ms')
  const panel = box.querySelector('.rp-ms-panel')
  box.querySelector('.rp-ms-btn').onclick = ev => { ev.stopPropagation(); panel.hidden = !panel.hidden; if (!panel.hidden) box.querySelector('.rp-ms-buscar').focus() }
  panel.onclick = ev => ev.stopPropagation()
  if (!window.__eccCierre) { window.__eccCierre = true; document.addEventListener('click', () => document.querySelectorAll('#ecc-ms .rp-ms-panel').forEach(p => { p.hidden = true })) }
  box.querySelector('.rp-ms-buscar').oninput = ev => {
    const q = ev.target.value.toLowerCase().trim()
    box.querySelectorAll('.rp-ms-op').forEach(l => { l.hidden = !!q && !l.dataset.txt.includes(q) })
  }
  const actualizarBtn = () => {
    const s = _st.sel
    box.querySelector('.rp-ms-txt').textContent = !s.size ? 'Elige cliente(s)…' : s.size === 1 ? (_st.contactos.find(x => s.has(x.id))?.nombre || '1 cliente') : `${s.size} clientes`
    box.querySelector('.rp-ms-btn').classList.toggle('activo', s.size > 0)
  }
  box.querySelectorAll('.rp-ms-op input').forEach(i => i.onchange = () => {
    const id = parseInt(i.value); if (i.checked) _st.sel.add(id); else _st.sel.delete(id)
    actualizarBtn(); _refrescar()
  })
  box.querySelector('[data-ecc-limpiar]').onclick = ev => { ev.preventDefault(); _st.sel.clear(); box.querySelectorAll('.rp-ms-op input').forEach(i => { i.checked = false }); actualizarBtn(); _refrescar() }
  c.querySelector('#ecc-corte').onchange = ev => { _st.corte = ev.target.value || _hoy(); _refrescar(false) }
  c.querySelector('#ecc-moneda').onchange = ev => { _st.moneda = ev.target.value; _refrescar() }
  c.querySelector('#ecc-pdf').onclick = () => _pdf()
  c.querySelector('#ecc-png').onclick = () => _png()
  const mov = c.querySelector('#ecc-mov'); if (mov) mov.onclick = () => _st.opts.onMovimientos()
}

let _token = 0
async function _refrescar(recargar = true) {
  const prev = _st.cont.querySelector('#ecc-prev')
  if (!_st.sel.size) { prev.innerHTML = '<div class="ecc-paper"><div class="ecc-vacio">Elige uno o más clientes para ver su estado de cuenta.</div></div>'; _st.datos = null; return }
  const t = ++_token
  if (recargar || !_st.datos) {
    prev.innerHTML = '<div class="ecc-paper"><div class="ecc-vacio">Cargando…</div></div>'
    try { const d = await _cargarDatos(); if (t !== _token) return; _st.datos = d }
    catch (e) { prev.innerHTML = `<div class="ecc-paper"><div class="ecc-vacio" style="color:#b91c1c;">Error: ${_esc(e.message)}</div></div>`; return }
  } else {
    // solo cambió la fecha de corte: recalcula días de letras
    _st.datos.filasL.forEach(l => { l.dias = _dias(l.venc, _st.corte) })
  }
  prev.innerHTML = _htmlPaper(_st.datos)
}

function _nombreArchivo(ext) {
  const c = _st.datos?.clientes || []
  const base = c.length === 1 ? c[0].nombre : `${c.length}_clientes`
  return `Estado_de_cuenta_${String(base).replace(/[^\w]+/g, '_').slice(0, 40)}_${_st.corte}.${ext}`
}

async function _imgDataUrl(src) {
  const r = await fetch(src); const b = await r.blob()
  return await new Promise(res => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.readAsDataURL(b) })
}

// ── PDF A4 horizontal: todas las columnas en el ancho de la hoja; filas en varias páginas
async function _pdf() {
  const d = _st.datos
  if (!d) { showToast('Elige al menos un cliente', 'warning'); return }
  try {
    const { jsPDF } = await import('https://cdn.jsdelivr.net/npm/jspdf@2.5.2/+esm')
    const { applyPlugin } = await import('https://cdn.jsdelivr.net/npm/jspdf-autotable@3.8.4/+esm')
    applyPlugin(jsPDF)
    const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' })
    const W = doc.internal.pageSize.getWidth(), M = 8
    const e = _empresa(), corte = fechaDMY(_st.corte), fm = v => formatNumber(v, 2)
    let logo = null
    try { logo = await _imgDataUrl('assets/img/logo-jhiro.png') } catch (_) {}
    const cabecera = () => {
      if (logo) { try { doc.addImage(logo, 'PNG', M, 6, 30, 9) } catch (_) {} }
      doc.setFontSize(8).setFont('helvetica', 'bold').setTextColor(20)
      doc.text(`${e.nombre}  ·  RUC ${e.ruc}`, M + 34, 8.5)
      doc.setFont('helvetica', 'normal').setFontSize(6.8).setTextColor(70)
      doc.text(e.direccion, M + 34, 12)
      doc.text(`${e.email} · Tel. ${e.telefono} · ${e.web}`, M + 34, 15)
      doc.setFontSize(7).setTextColor(110).text('Saldo al', W - M, 8, { align: 'right' })
      doc.setFontSize(12).setFont('helvetica', 'bold').setTextColor(185, 28, 28).text(corte, W - M, 14, { align: 'right' })
      doc.setDrawColor(17).setLineWidth(0.5).line(M, 18, W - M, 18)
    }
    cabecera()
    doc.setTextColor(17).setFontSize(13).setFont('helvetica', 'bold').text('ESTADO DE CUENTA', W / 2, 25, { align: 'center' })
    let y = 29
    doc.setFillColor(254, 243, 199).rect(M, y, W - 2 * M, 4.5 * d.clientes.length + 2, 'F')
    doc.setFontSize(8)
    d.clientes.forEach((c, i) => { doc.setFont('helvetica', 'normal').setTextColor(90).text(`RUC ${c.nro_documento || '—'}`, M + 2, y + 4.5 + i * 4.5); doc.setFont('helvetica', 'bold').setTextColor(17).text(c.nombre, M + 30, y + 4.5 + i * 4.5) })
    y += 4.5 * d.clientes.length + 6
    const estilos = { fontSize: 6.8, cellPadding: 1.1, overflow: 'linebreak', textColor: 30, lineColor: [229, 231, 235], lineWidth: 0.1 }
    const head = { fillColor: [17, 24, 39], textColor: 255, fontStyle: 'bold', fontSize: 6.8 }
    const foot = { fillColor: [243, 244, 246], textColor: 17, fontStyle: 'bold' }
    const comun = { margin: { left: M, right: M, top: 22 }, tableWidth: W - 2 * M, styles: estilos, headStyles: head, footStyles: foot, showFoot: 'lastPage',
      didDrawPage: (data) => { if (data.pageNumber > 1) cabecera(); doc.setFontSize(6.5).setTextColor(130).text(`Página ${doc.internal.getNumberOfPages()}`, W - M, doc.internal.pageSize.getHeight() - 4, { align: 'right' }) } }
    const sec = (t) => { doc.setFontSize(8.5).setFont('helvetica', 'bold').setTextColor(17).text(t, M, y); y += 1.5 }

    sec(`1 · COMPROBANTES PENDIENTES (${d.filasF.length})`)
    const bodyF = []
    d.filasF.forEach(f => f.lineas.forEach((ln, i) => {
      const atraso = _dias(f.venc, _st.corte)
      bodyF.push([
        i ? '' : f.packing, i ? '' : (d.multiCliente ? `${f.doc}\n${f.cliente}` : f.doc), i ? '' : fechaDMY(f.emision),
        ln.articulo, ln.lote, ln.cajas ? formatNumber(ln.cajas, 0) : '', formatNumber(ln.cantidad, 2), formatNumber(ln.precio, 2), fm(ln.total),
        i ? '' : f.moneda, i ? '' : fm(f.total), i ? '' : (f.cobrado ? fm(f.cobrado) : '—'), i ? '' : (f.canjeado ? fm(f.canjeado) : '—'),
        i ? '' : fm(f.saldo), i ? '' : String(_dias(f.emision, _st.corte) ?? '—'),
        i ? '' : (f.saldo > 0.009 && atraso !== null ? (atraso > 0 ? '+' : '') + atraso : '—')
      ])
    }))
    const totF = _porMoneda(d.filasF, ['total', 'cobrado', 'canjeado', 'saldo'])
    doc.autoTable({ ...comun, startY: y,
      head: [['Packing', 'Comprobante', 'Emisión', 'Artículo', 'Lote', 'Cajas', 'Cantidad', 'Precio', 'Importe', 'Mon.', 'Total doc.', 'Cobrado', 'En letras', 'Saldo', 'Días', 'Atraso']],
      body: bodyF.length ? bodyF : [['', 'Sin comprobantes pendientes', '', '', '', '', '', '', '', '', '', '', '', '', '', '']],
      foot: Object.entries(totF).map(([m, t]) => [{ content: `Subtotal comprobantes ${m}`, colSpan: 9 }, m, fm(t.total), fm(t.cobrado), fm(t.canjeado), `${_SIMB(m)} ${fm(t.saldo)}`, '', '']),
      columnStyles: { 3: { cellWidth: 62 }, 5: { halign: 'right' }, 6: { halign: 'right' }, 7: { halign: 'right' }, 8: { halign: 'right' }, 9: { halign: 'center' }, 10: { halign: 'right' }, 11: { halign: 'right' }, 12: { halign: 'right' }, 13: { halign: 'right', fontStyle: 'bold' }, 14: { halign: 'right' }, 15: { halign: 'right' } },
      didParseCell: (c) => { if (c.section === 'body' && c.column.index === 15 && String(c.cell.raw).startsWith('+')) c.cell.styles.textColor = [185, 28, 28] }
    })
    y = doc.lastAutoTable.finalY + 6
    if (y > doc.internal.pageSize.getHeight() - 30) { doc.addPage(); cabecera(); y = 26 }
    sec(`2 · LETRAS PENDIENTES (${d.filasL.length})`)
    const totL = _porMoneda(d.filasL, ['importe', 'pagado', 'saldo'])
    doc.autoTable({ ...comun, startY: y,
      head: [['Días', 'N° Letra', 'Emisión', 'Vencimiento', 'Factura', 'Mon.', 'Importe', 'Pagado', 'Saldo', 'N° único', 'Banco', 'Estado']],
      body: d.filasL.length ? d.filasL.map(l => [l.dias === null ? '—' : (l.dias > 0 ? '+' : '') + l.dias, d.multiCliente ? `${l.numero}\n${l.cliente}` : l.numero, fechaDMY(l.emision), fechaDMY(l.venc), l.factura, l.moneda, fm(l.importe), l.pagado ? fm(l.pagado) : '—', fm(l.saldo), l.unico || '', l.ubicacion, l.estado])
        : [['', 'Sin letras pendientes', '', '', '', '', '', '', '', '', '', '']],
      foot: Object.entries(totL).map(([m, t]) => [{ content: `Subtotal letras ${m}`, colSpan: 5 }, m, fm(t.importe), fm(t.pagado), `${_SIMB(m)} ${fm(t.saldo)}`, '', '', '']),
      columnStyles: { 0: { halign: 'right' }, 5: { halign: 'center' }, 6: { halign: 'right' }, 7: { halign: 'right' }, 8: { halign: 'right', fontStyle: 'bold' } },
      didParseCell: (c) => { if (c.section === 'body' && c.column.index === 0) c.cell.styles.textColor = String(c.cell.raw).startsWith('+') ? [185, 28, 28] : [4, 120, 87] }
    })
    y = doc.lastAutoTable.finalY + 5
    const saldos = _saldoFinal(d)
    if (y + 10 * saldos.length + 14 > doc.internal.pageSize.getHeight()) { doc.addPage(); cabecera(); y = 26 }
    saldos.forEach(s => {
      doc.setFillColor(253, 230, 138).setDrawColor(245, 158, 11).setLineWidth(0.6).rect(M, y, W - 2 * M, 9, 'FD')
      doc.setTextColor(17).setFont('helvetica', 'bold').setFontSize(10).text(`SALDO AL ${corte} (${s.moneda})`, M + 3, y + 5.2)
      doc.setFont('helvetica', 'normal').setFontSize(7).text(`Comprobantes ${_SIMB(s.moneda)} ${fm(s.facturas)} + Letras ${_SIMB(s.moneda)} ${fm(s.letras)}`, M + 75, y + 5.2)
      doc.setFont('helvetica', 'bold').setFontSize(12).text(`${_SIMB(s.moneda)} ${fm(s.total)}`, W - M - 3, y + 6, { align: 'right' })
      y += 11
    })
    doc.setFillColor(254, 243, 199).rect(M, y, W - 2 * M, 8, 'F')
    doc.setFont('helvetica', 'bold').setFontSize(7).setTextColor(60)
    doc.text(doc.splitTextToSize(e.pie, W - 2 * M - 6), W / 2, y + 3.5, { align: 'center' })
    doc.save(_nombreArchivo('pdf'))
    showToast('PDF generado ✅', 'success')
  } catch (e) { console.error('estado cuenta PDF:', e); showToast('Error al generar el PDF: ' + e.message, 'danger') }
}

// ── PNG: foto de la vista previa (para WhatsApp)
async function _png() {
  const el = _st.cont.querySelector('#ecc-paper')
  if (!el || !_st.datos) { showToast('Elige al menos un cliente', 'warning'); return }
  try {
    const mod = await import('https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/+esm')
    const html2canvas = mod.default || mod
    const canvas = await html2canvas(el, { scale: 2, backgroundColor: '#ffffff', useCORS: true, windowWidth: Math.max(1200, el.scrollWidth) })
    const a = document.createElement('a')
    a.href = canvas.toDataURL('image/png'); a.download = _nombreArchivo('png'); a.click()
    showToast('PNG generado ✅', 'success')
  } catch (e) { console.error('estado cuenta PNG:', e); showToast('Error al generar el PNG: ' + e.message, 'danger') }
}
