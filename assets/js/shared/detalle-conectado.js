// ============================================================================
// shared/detalle-conectado.js — «Detalle conectado» (2026-11-23)
// ----------------------------------------------------------------------------
// Qué agrega a cualquier modal de detalle:
//   1) CIFRAS: total, cobrado/pagado, saldo, estado SUNAT… siempre arriba.
//   2) CADENA DOCUMENTAL clicable: Packing → Guía → Comprobante → CxC → Cobro → Banco (+ asientos),
//      cada nodo con estado y monto. Clic → CAJÓN lateral apilado (el modal de origen sigue visible).
//   3) SEMÁFORO de integridad: asiento cuadrado, guía emitida, SUNAT aceptado, cobrado, banco…
// Uso (una línea al abrir el modal):  montarConexiones('modal-editar-venta', 'venta', id)
// Tipos: venta · packing · guia_despacho · cxc · cobro · banco · asiento · compra · guia_ingreso · cxp · pago
// El cajón funciona en CUALQUIER página (vista rápida con datos propios); «Abrir ficha completa»
// usa el modal real si está en la página, o navega a su módulo con ?ver=tipo:id.
// ============================================================================
import { supabase } from '../supabase-client.js'
import { formatNumber, fechaDMY } from '../helpers.js'

const _esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const _n = v => parseFloat(v || 0) || 0
const _fm = (m, mon) => `${(mon || 'PEN') === 'USD' ? 'USD' : 'PEN'} ${formatNumber(_n(m))}`
const _pad = (n, l = 8) => String(n ?? '').padStart(l, '0')
const _ids = a => [...new Set((a || []).filter(x => x != null))]
const _TIPO_CP = { '01': 'Factura', '03': 'Boleta', '07': 'Nota de crédito', '08': 'Nota de débito', '12': 'Ticket', '91': 'Comprobante exterior' }
const _nomCP = t => _TIPO_CP[String(t || '').padStart(2, '0')] || 'Comprobante'

// ── Catálogo de tipos ───────────────────────────────────────────────────────
const TIPOS = {
  packing:       { ico: '📦', nom: 'Packing',            pagina: 'ventas.html',    fn: 'abrirModalPacking',             abrir: id => window.abrirModalPacking(id) },
  guia_despacho: { ico: '🚚', nom: 'Guía de despacho',   pagina: 'ventas.html',    fn: 'verDetalleGuiaDespachoVenta',   abrir: id => window.verDetalleGuiaDespachoVenta(id) },
  venta:         { ico: '🧾', nom: 'Comprobante',        pagina: 'ventas.html',    fn: 'editarVenta',                   abrir: id => window.editarVenta(id) },
  cxc:           { ico: '📥', nom: 'Cuenta por cobrar',  pagina: 'cobranzas.html' },
  cobro:         { ico: '💵', nom: 'Cobro',              pagina: 'cobranzas.html', fn: 'verDetalleCP',                  abrir: id => window.verDetalleCP('cobro', id) },
  banco:         { ico: '🏦', nom: 'Mov. bancario',      pagina: 'bancos.html' },
  asiento:       { ico: '📒', nom: 'Asiento contable',   pagina: 'contabilidad.html' },
  compra:        { ico: '🛒', nom: 'Compra',             pagina: 'compras.html',   fn: 'editarCompra',                  abrir: id => window.editarCompra(id) },
  guia_ingreso:  { ico: '📥', nom: 'Guía de ingreso',    pagina: 'compras.html',   fn: 'verDetalleGuiaIngreso',         abrir: id => window.verDetalleGuiaIngreso(id) },
  cxp:           { ico: '📤', nom: 'Cuenta por pagar',   pagina: 'cobranzas.html' },
  nota_venta:    { ico: '🧾', nom: 'Nota de venta',      pagina: 'ventas.html',    fn: 'verDetalleNotaVenta' },
  nota_compra:   { ico: '🛒', nom: 'Nota de compra',     pagina: 'compras.html',   fn: 'verDetalleNotaCompra' },
  pago:          { ico: '💸', nom: 'Pago a proveedor',   pagina: 'cobranzas.html', fn: 'verDetalleCP',                  abrir: id => window.verDetalleCP('pago', id) }
}
const _ALIAS = { nota_venta: 'venta', nota_compra: 'compra' }
const _puedeAbrirReal = t => !!TIPOS[t]?.fn && typeof window[TIPOS[t].fn] === 'function'
const _tienePagina = t => !!(TIPOS[t]?.fn && TIPOS[t]?.pagina)

function _css() {
  if (document.getElementById('dc-css')) return
  const l = document.createElement('link')
  l.id = 'dc-css'; l.rel = 'stylesheet'
  l.href = new URL('../../css/detalle-conectado.css', import.meta.url).href + '?v=20261124e'
  document.head.appendChild(l)
}

const _legible = t => { const x = String(t ?? '').replace(/_/g, ' ').trim(); return x ? x.charAt(0).toUpperCase() + x.slice(1) : x }

// ── Tono por estado ─────────────────────────────────────────────────────────
const _tono = est => {
  const e = String(est || '').toLowerCase()
  if (/anulad|rechaz|error|descuadrad/.test(e)) return 'bad'
  if (/pagad|cobrad|aceptad|procesad|completo|entregad|emitid|cerrad|vigente|aplicad|cuadrad|registrad|confirmad/.test(e)) return 'ok'
  if (/pendiente|parcial|borrador|enviad|por /.test(e)) return 'warn'
  return 'mute'
}

// ── Lectura de datos (cada loader devuelve {cifras, etapas, contable, checks}) ─
async function _contactos(ids) {
  ids = _ids(ids); if (!ids.length) return {}
  const { data } = await supabase.from('contacts').select('id, razon_social, nombre, numero_documento').in('id', ids)
  return Object.fromEntries((data || []).map(c => [c.id, c.razon_social || c.nombre || '']))
}
const _porId = a => Object.fromEntries((a || []).map(x => [x.id, x]))
const _saldoCxC = c => _n(c.monto_total) + _n(c.monto_notas_debito) - _n(c.monto_notas_credito) - _n(c.monto_cobrado) - _n(c.monto_retenido) - _n(c.monto_canjeado) - _n(c.monto_anticipo_aplicado)
const _saldoCxP = c => _n(c.monto_total) + _n(c.monto_notas_debito) - _n(c.monto_notas_credito) - _n(c.monto_pagado) - _n(c.monto_canjeado) - _n(c.monto_anticipo_aplicado)
const _numVenta = v => `${v.serie || ''}-${_pad(v.correlativo)}`
const _nodo = (k, id, rot, est, monto, sub) => ({ k, id, rot, est: _legible(est),  monto: monto || '', sub: sub || '', tono: _tono(est) })

async function _asientosDe(ids) {
  ids = _ids(ids); if (!ids.length) return []
  const { data } = await supabase.from('journal_entries').select('id, numero_asiento, total_debe, total_haber, descripcion').in('id', ids)
  return data || []
}
const _nodoAsiento = a => _nodo('asiento', a.id, a.numero_asiento || `AS-${_pad(a.id, 6)}`, Math.abs(_n(a.total_debe) - _n(a.total_haber)) < 0.01 ? 'Cuadrado' : 'Descuadrado', _fm(a.total_debe, 'PEN'))

async function _cadenaVenta(v) {
  const [pk, gd, cx, nt] = await Promise.all([
    supabase.from('packing').select('id, numero, cot_numero, estado, total, moneda').or(`venta_id.eq.${v.id}${v.packing_id ? `,id.eq.${v.packing_id}` : ''}`),
    supabase.from('guias_despacho_venta').select('id, numero_guia, estado, fecha_guia').eq('venta_id', v.id),
    supabase.from('cuentas_cobrar').select('*').eq('venta_id', v.id),
    supabase.from('ventas').select('id, tipo_comprobante, serie, correlativo, total, moneda, estado, comprobante_anulado').eq('venta_referencia_id', v.id)
  ])
  const packs = pk.data || [], guias = gd.data || [], cxcs = cx.data || [], notas = nt.data || []
  const cobros = cxcs.length ? ((await supabase.from('cobros').select('*').in('cxc_id', cxcs.map(c => c.id))).data || []) : []
  const movs = cobros.length ? ((await supabase.from('movimientos_banco').select('id, banco_id, fecha, tipo, monto, cobro_id, asiento_id').in('cobro_id', cobros.map(c => c.id))).data || []) : []
  const asientos = await _asientosDe([v.asiento_id, ...cobros.map(c => c.asiento_id), ...cxcs.map(c => c.asiento_id)])
  const cxc = cxcs[0]
  const mon = v.moneda || 'PEN'
  const total = _n(v.total), cobrado = cxc ? _n(cxc.monto_cobrado) + _n(cxc.monto_retenido) : 0
  const saldo = cxc ? Math.max(0, _saldoCxC(cxc)) : total
  const vigGuias = guias.filter(g => !/anulad/i.test(g.estado || ''))
  const esCot = p => /^COT/i.test(p.numero || '')
  const etapas = [
    { nom: 'Cot', k: 'packing', items: packs.filter(p => p.cot_numero || esCot(p)).map(p => _nodo('packing', p.id, p.cot_numero || p.numero, esCot(p) ? p.estado : 'Convertida', _fm(p.total, p.moneda))), vacio: null },
    { nom: 'PK', k: 'packing', items: packs.filter(p => !esCot(p)).map(p => _nodo('packing', p.id, p.numero || `PK #${p.id}`, p.estado, _fm(p.total, p.moneda))), vacio: v.tipo_venta === 'anticipo' ? null : 'Sin PK' },
    { nom: 'Comprobante', k: 'venta', items: [_nodo('venta', v.id, `${_nomCP(v.tipo_comprobante)} ${_numVenta(v)}`, v.comprobante_anulado ? 'Anulado' : (v.cpe_estado || v.estado), _fm(total, mon))].concat(notas.map(n => _nodo('venta', n.id, `${_nomCP(n.tipo_comprobante)} ${_numVenta(n)}`, n.comprobante_anulado ? 'Anulado' : n.estado, _fm(n.total, n.moneda)))) },
    { nom: 'Guía despacho', k: 'guia_despacho', items: guias.map(g => _nodo('guia_despacho', g.id, g.numero_guia || `Guía #${g.id}`, g.estado, '', fechaDMY(g.fecha_guia))), vacio: 'Sin guía' },
    { nom: 'Por cobrar', k: 'cxc', items: cxcs.map(c => _nodo('cxc', c.id, `CxC #${c.id}`, c.estado, _fm(saldo, c.moneda), 'saldo')), vacio: 'Sin CxC' },
    { nom: 'Cobros', k: 'cobro', items: cobros.map(c => _nodo('cobro', c.id, c.numero_recibo ? `Recibo ${c.numero_recibo}` : `Cobro #${c.id}`, 'Aplicado', _fm(c.monto, c.moneda), fechaDMY(c.fecha))), vacio: 'Sin cobros' },
    { nom: 'Banco', k: 'banco', items: movs.map(m => _nodo('banco', m.id, `Mov. ${_pad(m.id, 6)}`, 'Registrado', _fm(m.monto, 'PEN'), fechaDMY(m.fecha))), vacio: cobros.length ? 'Sin mov. bancario' : null }
  ]
  const cuadra = asientos.every(a => Math.abs(_n(a.total_debe) - _n(a.total_haber)) < 0.01)
  const conBanco = cobros.filter(c => c.banco_id).length
  const checks = [
    { ok: !!v.asiento_id, t: v.asiento_id ? 'Asiento generado' : 'Sin asiento contable' },
    ...(asientos.length ? [{ ok: cuadra, t: cuadra ? 'Asientos cuadrados' : 'Asiento descuadrado' }] : []),
    ...(['01', '03'].includes(String(v.tipo_comprobante).padStart(2, '0')) ? [{ ok: v.cpe_estado === 'aceptado', t: v.cpe_estado === 'aceptado' ? 'SUNAT aceptó' : `SUNAT: ${v.cpe_estado || 'sin enviar'}` }] : []),
    ...(v.tipo_venta === 'anticipo' ? [] : [{ ok: vigGuias.length > 0 || v.estado_despacho === 'despachado', t: vigGuias.length ? 'Despachado con guía' : 'Sin guía de despacho' }]),
    ...(cxc ? [{ ok: saldo <= 0.01, t: saldo <= 0.01 ? 'Cobrado al 100 %' : `Saldo por cobrar ${_fm(saldo, mon)}` }] : [{ ok: false, t: 'Sin cuenta por cobrar' }]),
    ...(conBanco ? [{ ok: movs.length >= conBanco, t: movs.length >= conBanco ? 'Cobros en banco' : 'Cobro sin mov. bancario' }] : [])
  ]
  const cifras = [
    { k: 'Total', v: _fm(total, mon), big: true },
    { k: 'Cobrado', v: _fm(cobrado, mon) },
    { k: 'Saldo', v: _fm(saldo, mon), tono: saldo <= 0.01 ? 'ok' : 'warn' },
    { k: 'SUNAT', v: v.cpe_estado || '—', tono: _tono(v.cpe_estado) },
    { k: 'Despacho', v: v.estado_despacho || (vigGuias.length ? 'Con guía' : 'Pendiente'), tono: _tono(v.estado_despacho) }
  ]
  return { cifras, etapas, contable: asientos.map(_nodoAsiento), checks }
}

async function _cadenaCompra(c) {
  const [gi, cp, nt] = await Promise.all([
    supabase.from('guias_ingreso_compra').select('id, numero_guia, estado, fecha_guia').eq('compra_id', c.id),
    supabase.from('cuentas_pagar').select('*').eq('compra_id', c.id),
    supabase.from('compras').select('id, tipo_comprobante, serie, numero, total, moneda, estado').eq('compra_referencia_id', c.id)
  ])
  const guias = gi.data || [], cxps = cp.data || [], notasC = nt.data || []
  const pagos = cxps.length ? ((await supabase.from('pagos_proveedores').select('*').in('cxp_id', cxps.map(x => x.id))).data || []) : []
  const movs = pagos.length ? ((await supabase.from('movimientos_banco').select('id, banco_id, fecha, tipo, monto, pago_proveedor_id').in('pago_proveedor_id', pagos.map(p => p.id))).data || []) : []
  const asientos = await _asientosDe([c.asiento_id, ...cxps.map(x => x.asiento_id), ...pagos.map(p => p.asiento_id)])
  const cxp = cxps[0], mon = c.moneda || 'PEN'
  const total = _n(c.total), pagado = cxp ? _n(cxp.monto_pagado) : 0
  const saldo = cxp ? Math.max(0, _saldoCxP(cxp)) : total
  const vig = guias.filter(g => !/anulad/i.test(g.estado || ''))
  const etapas = [
    { nom: 'Compra', k: 'compra', items: [_nodo('compra', c.id, `${_nomCP(c.tipo_comprobante)} ${c.serie || ''}-${c.numero || ''}`, c.estado || 'Registrada', _fm(total, mon))].concat(notasC.map(n => _nodo('compra', n.id, `${_nomCP(n.tipo_comprobante)} ${n.serie || ''}-${n.numero || ''}`, n.estado || 'Registrada', _fm(n.total, n.moneda)))) },
    { nom: 'Guía ingreso', k: 'guia_ingreso', items: guias.map(g => _nodo('guia_ingreso', g.id, g.numero_guia || `Guía #${g.id}`, g.estado, '', fechaDMY(g.fecha_guia))), vacio: 'Sin guía' },
    { nom: 'Por pagar', k: 'cxp', items: cxps.map(x => _nodo('cxp', x.id, `CxP #${x.id}`, x.estado, _fm(saldo, x.moneda), 'saldo')), vacio: 'Sin CxP' },
    { nom: 'Pagos', k: 'pago', items: pagos.map(p => _nodo('pago', p.id, `Pago #${p.id}`, 'Aplicado', _fm(p.monto, p.moneda), fechaDMY(p.fecha))), vacio: 'Sin pagos' },
    { nom: 'Banco', k: 'banco', items: movs.map(m => _nodo('banco', m.id, `Mov. ${_pad(m.id, 6)}`, 'Registrado', _fm(m.monto, 'PEN'), fechaDMY(m.fecha))), vacio: pagos.some(p => p.banco_id) ? 'Sin mov. bancario' : null }
  ]
  const cuadra = asientos.every(a => Math.abs(_n(a.total_debe) - _n(a.total_haber)) < 0.01)
  const conBanco = pagos.filter(p => p.banco_id).length
  const checks = [
    { ok: asientos.length > 0, t: asientos.length ? 'Asiento generado' : 'Sin asiento contable' },
    ...(asientos.length ? [{ ok: cuadra, t: cuadra ? 'Asientos cuadrados' : 'Asiento descuadrado' }] : []),
    { ok: vig.length > 0, t: vig.length ? 'Mercadería recibida (guía)' : 'Sin guía de ingreso' },
    ...(cxp ? [{ ok: saldo <= 0.01, t: saldo <= 0.01 ? 'Pagado al 100 %' : `Saldo por pagar ${_fm(saldo, mon)}` }] : [{ ok: false, t: 'Sin cuenta por pagar' }]),
    ...(conBanco ? [{ ok: movs.length >= conBanco, t: movs.length >= conBanco ? 'Pagos en banco' : 'Pago sin mov. bancario' }] : [])
  ]
  const cifras = [
    { k: 'Total', v: _fm(total, mon), big: true },
    { k: 'Pagado', v: _fm(pagado, mon) },
    { k: 'Saldo', v: _fm(saldo, mon), tono: saldo <= 0.01 ? 'ok' : 'warn' },
    { k: 'Guía', v: vig.length ? `${vig.length} vigente(s)` : 'Pendiente', tono: vig.length ? 'ok' : 'warn' }
  ]
  return { cifras, etapas, contable: asientos.map(_nodoAsiento), checks }
}

/** Resuelve cualquier tipo a su cadena (sube hasta la venta o la compra raíz). */
async function _cadenaDe(tipo, id) {
  const uno = async (t, cols, idv = id) => (await supabase.from(t).select(cols).eq('id', idv).maybeSingle()).data
  let raiz = null
  if (tipo === 'venta') raiz = ['venta', id]
  else if (tipo === 'packing') { const d = await uno('packing', 'venta_id'); if (d?.venta_id) raiz = ['venta', d.venta_id] }
  else if (tipo === 'guia_despacho') { const d = await uno('guias_despacho_venta', 'venta_id'); if (d?.venta_id) raiz = ['venta', d.venta_id] }
  else if (tipo === 'cxc') { const d = await uno('cuentas_cobrar', 'venta_id'); if (d?.venta_id) raiz = ['venta', d.venta_id] }
  else if (tipo === 'cobro') { const c = await uno('cobros', 'cxc_id'); if (c?.cxc_id) { const d = await uno('cuentas_cobrar', 'venta_id', c.cxc_id); if (d?.venta_id) raiz = ['venta', d.venta_id] } }
  else if (tipo === 'banco') { const m = await uno('movimientos_banco', 'cobro_id, pago_proveedor_id'); if (m?.cobro_id) return _cadenaDe('cobro', m.cobro_id); if (m?.pago_proveedor_id) return _cadenaDe('pago', m.pago_proveedor_id) }
  else if (tipo === 'nota_venta') { const d = await uno('ventas', 'venta_referencia_id'); raiz = ['venta', d?.venta_referencia_id || id] }
  else if (tipo === 'nota_compra') { const d = await uno('compras', 'compra_referencia_id'); raiz = ['compra', d?.compra_referencia_id || id] }
  else if (tipo === 'cuota_cxc') { const d = await uno('cuotas_cobrar', 'cxc_id'); if (d?.cxc_id) return _cadenaDe('cxc', d.cxc_id) }
  else if (tipo === 'cuota_cxp') { const d = await uno('cuotas_pagar', 'cxp_id'); if (d?.cxp_id) return _cadenaDe('cxp', d.cxp_id) }
  else if (tipo === 'letra') {
    const l = await uno('letras_cambio', 'venta_id, compra_id, cxc_id, cxp_id')
    if (l?.venta_id) raiz = ['venta', l.venta_id]; else if (l?.compra_id) raiz = ['compra', l.compra_id]
    else if (l?.cxc_id) return _cadenaDe('cxc', l.cxc_id); else if (l?.cxp_id) return _cadenaDe('cxp', l.cxp_id)
  }
  else if (tipo === 'compra') raiz = ['compra', id]
  else if (tipo === 'guia_ingreso') { const d = await uno('guias_ingreso_compra', 'compra_id'); if (d?.compra_id) raiz = ['compra', d.compra_id] }
  else if (tipo === 'cxp') { const d = await uno('cuentas_pagar', 'compra_id'); if (d?.compra_id) raiz = ['compra', d.compra_id] }
  else if (tipo === 'pago') { const p = await uno('pagos_proveedores', 'cxp_id'); if (p?.cxp_id) return _cadenaDe('cxp', p.cxp_id) }
  else if (tipo === 'asiento') {
    const [v, c, cp, pg, mb] = await Promise.all(['ventas', 'compras', 'cobros', 'pagos_proveedores', 'movimientos_banco'].map(t => supabase.from(t).select('id').eq('asiento_id', id).limit(1)))
    if (v.data?.[0]) raiz = ['venta', v.data[0].id]
    else if (c.data?.[0]) raiz = ['compra', c.data[0].id]
    else if (cp.data?.[0]) return _cadenaDe('cobro', cp.data[0].id)
    else if (pg.data?.[0]) return _cadenaDe('pago', pg.data[0].id)
    else if (mb.data?.[0]) return _cadenaDe('banco', mb.data[0].id)
  }
  if (!raiz) return null
  if (raiz[0] === 'venta') { const v = await uno('ventas', '*', raiz[1]); return v ? _cadenaVenta(v) : null }
  const c = await uno('compras', '*', raiz[1])
  return c ? _cadenaCompra(c) : null
}

// ── Pintado ─────────────────────────────────────────────────────────────────
function _htmlNodo(n, actual) {
  const es = actual && actual.k === n.k && String(actual.id) === String(n.id)
  return `<button type="button" class="dc-nodo dc-${n.tono}${es ? ' dc-actual' : ''}" data-dc-k="${n.k}" data-dc-id="${n.id}" title="${es ? 'Estás aquí' : 'Ver ' + _esc(TIPOS[n.k]?.nom || '')}">
      <span class="dc-n-rot">${TIPOS[n.k]?.ico || ''} ${_esc(n.rot)}</span>
      <span class="dc-n-met">${n.est ? `<i class="dc-pto"></i>${_esc(n.est)}` : ''}${n.monto ? `<b>${_esc(n.monto)}</b>` : ''}${n.sub ? `<em>${_esc(n.sub)}</em>` : ''}</span>
    </button>`
}

const _CORTO = { packing: 'PK', guia_despacho: 'Guía', venta: '', cxc: 'CxC', cobro: '', banco: 'Banco', asiento: '', compra: '', guia_ingreso: 'Guía', cxp: 'CxP', pago: '' }
const _abierto = () => { try { return localStorage.getItem('dc-abierto') === '1' } catch { return false } }
const _setAbierto = v => { try { localStorage.setItem('dc-abierto', v ? '1' : '0') } catch {} }

/** Una «píldora» del paso a paso: punto de estado + etiqueta corta. Sin montos (eso va en el detalle). */
function _pildora(e, actual) {
  if (!e.items.length) return e.vacio ? `<span class="dc-p dc-p-vacio" title="${_esc(e.vacio)}">${_esc(e.nom)}<em>—</em></span>` : ''
  if (e.items.length > 1) {
    const hay = e.items.some(n => actual && actual.k === n.k && String(actual.id) === String(n.id))
    return `<button type="button" class="dc-p dc-${e.items.some(n => n.tono === 'warn') ? 'warn' : 'ok'}${hay ? ' dc-actual' : ''}" data-dc-mas="1" title="Ver los ${e.items.length}">${_esc(e.nom)}<b>×${e.items.length}</b></button>`
  }
  const n = e.items[0], es = actual && actual.k === n.k && String(actual.id) === String(n.id)
  return `<button type="button" class="dc-p dc-${n.tono}${es ? ' dc-actual' : ''}" data-dc-k="${n.k}" data-dc-id="${n.id}" title="${_esc(`${n.rot}${n.est ? ' · ' + n.est : ''}${n.monto ? ' · ' + n.monto : ''}`)}"><i class="dc-pto"></i>${_esc(n.rot)}</button>`
}

function _htmlItems(e, actual) {
  const MAX = 2, vis = [...e.items].sort((a, b) => (actual && actual.k === b.k && String(actual.id) === String(b.id)) - (actual && actual.k === a.k && String(actual.id) === String(a.id)))
  if (vis.length <= MAX) return vis.map(n => _htmlNodo(n, actual)).join('')
  return vis.slice(0, MAX).map(n => _htmlNodo(n, actual)).join('') + `<button type="button" class="dc-mas" data-dc-resto="1">+${vis.length - MAX} más</button><div class="dc-resto" hidden>${vis.slice(MAX).map(n => _htmlNodo(n, actual)).join('')}</div>`
}

function _htmlBloque(d, actual, cerrado) {
  const etapas = d.etapas.filter(e => e.items.length || e.vacio)
  const alertas = d.checks.filter(c => !c.ok)
  const get = k => d.cifras.find(c => c.k === k)
  const tot = get('Total'), sal = get('Saldo')
  const abierto = cerrado ? false : _abierto()
  return `
    <div class="dc-res">
      <div class="dc-top">
        <div class="dc-kp"><span>Total</span><b>${_esc(tot?.v || '')}</b></div>
        ${sal ? `<div class="dc-kp dc-t-${sal.tono || 'ok'}"><span>Saldo</span><b>${_esc(sal.v)}</b></div>` : ''}
        <button type="button" class="dc-alt ${alertas.length ? 'warn' : 'ok'}" data-dc-toggle="1" aria-expanded="${abierto}">${alertas.length ? `⚠ ${alertas.length} alerta${alertas.length > 1 ? 's' : ''}` : '✓ En orden'}<span class="dc-car">▾</span></button>
      </div>
      <div class="dc-paso" role="list">${etapas.map((e, i) => `${i ? '<span class="dc-flecha" aria-hidden="true">›</span>' : ''}${_pildora(e, actual)}`).join('')}</div>
      <div class="dc-det"${abierto ? '' : ' hidden'}>
        <div class="dc-cifras">${d.cifras.filter(c => !['Total', 'Saldo'].includes(c.k)).map(c => `<div class="dc-cifra${c.tono ? ' dc-t-' + c.tono : ''}"><span>${_esc(c.k)}</span><b>${_esc(c.v)}</b></div>`).join('')}</div>
        <div class="dc-cadena" role="list">${etapas.map((e, i) => `
          ${i ? '<span class="dc-flecha" aria-hidden="true">›</span>' : ''}
          <div class="dc-etapa" role="listitem"><div class="dc-e-nom">${_esc(e.nom)}</div>
            ${e.items.length ? _htmlItems(e, actual) : `<div class="dc-vacio">${_esc(e.vacio)}</div>`}
          </div>`).join('')}
        </div>
        ${d.contable.length ? `<div class="dc-contable"><span class="dc-e-nom">Contable</span>${d.contable.map(n => _htmlNodo(n, actual)).join('')}</div>` : ''}
        <div class="dc-semaforo">${d.checks.map(c => `<span class="dc-chk ${c.ok ? 'ok' : 'warn'}">${c.ok ? '✓' : '⚠'} ${_esc(c.t)}</span>`).join('')}</div>
      </div>
    </div>`
}

/** Despliega / pliega el detalle (recuerda la elección). */
function _alternarDetalle(raiz, forzar) {
  const det = raiz.querySelector('.dc-det'), btn = raiz.querySelector('[data-dc-toggle]')
  if (!det) return
  const abrir = forzar ?? det.hidden
  det.hidden = !abrir; btn?.setAttribute('aria-expanded', String(abrir)); _setAbierto(abrir)
}

/** Monta el bloque al inicio del cuerpo de un modal (o dentro de un elemento host). */
export async function montarConexiones(destino, tipo, id, opc = {}) {
  _css()
  try {
    let host = typeof destino === 'string' ? document.getElementById(destino) : destino
    if (!host) return
    if (host.classList.contains('modal')) {
      const cont = host.querySelector('.modal-content') || host
      let h = cont.querySelector(':scope > .dc-host')
      if (!h) {
        h = document.createElement('div'); h.className = 'dc-host'
        const cab = cont.querySelector(':scope > .modal-header')
        cab ? cab.after(h) : cont.prepend(h)
      }
      host = h
    }
    host.dataset.dcTipo = tipo; host.dataset.dcId = String(id)
    host.innerHTML = '<div class="dc-cargando">Cargando conexiones…</div>'
    const d = await _cadenaDe(tipo, id)
    if (host.dataset.dcId !== String(id)) return          // se abrió otro documento mientras cargaba
    if (!d) { host.innerHTML = ''; host.style.display = 'none'; return }
    host.style.display = ''
    host.innerHTML = _htmlBloque(d, { k: _ALIAS[tipo] || tipo, id })
    host.onclick = ev => {
      const mr = ev.target.closest('[data-dc-resto]'); if (mr) { const r = mr.nextElementSibling; r.hidden = !r.hidden; mr.textContent = r.hidden ? `+${r.children.length} más` : 'Ver menos'; return }
      if (ev.target.closest('[data-dc-toggle],[data-dc-mas]')) return _alternarDetalle(host, ev.target.closest('[data-dc-mas]') ? true : undefined)
      const b = ev.target.closest('.dc-nodo,.dc-p[data-dc-k]'); if (!b) return
      if (b.classList.contains('dc-actual') && !opc.permitirActual) return
      abrirCajon(b.dataset.dcK, b.dataset.dcId)
    }
  } catch (e) { console.warn('montarConexiones:', e) }
}

// ── Fichas de vista rápida (cajón) ──────────────────────────────────────────
const _vacio = v => v == null || v === '' || v === '—' || v === '—'
async function _bancosMap(ids) {
  ids = _ids(ids); if (!ids.length) return {}
  const { data } = await supabase.from('bancos').select('id, nombre, banco, numero_cuenta, moneda').in('id', ids)
  return Object.fromEntries((data || []).map(b => [b.id, `${b.nombre || b.banco || 'Cuenta'}${b.numero_cuenta ? ' · ' + b.numero_cuenta : ''}${b.moneda ? ' (' + b.moneda + ')' : ''}`]))
}
const _tbl = (tit, cab, filas) => filas.length ? `<h4 class="dc-sub">${_esc(tit)}</h4><table class="dc-tabla${cab.length === 4 && cab[1] === 'Medio' ? ' dc-tl' : ''}"><thead><tr>${cab.map(c => `<th>${_esc(c)}</th>`).join('')}</tr></thead><tbody>${filas.map(f => `<tr>${f.map(x => `<td>${x}</td>`).join('')}</tr>`).join('')}</tbody></table>` : ''
const _fila = (k, v) => `<tr><td>${_esc(k)}</td><td>${v}</td></tr>`
async function _ficha(tipo, id) {
  const get = async (t, cols = '*') => (await supabase.from(t).select(cols).eq('id', id).maybeSingle()).data
  let titulo = `${TIPOS[tipo].nom} #${id}`, sub = '', filas = [], tabla = '', kpis = []
  if (tipo === 'venta') {
    const v = await get('ventas'); if (!v) return null
    const cli = (await _contactos([v.contact_id]))[v.contact_id]
    titulo = `${_nomCP(v.tipo_comprobante)} ${_numVenta(v)}`; sub = cli || ''
    filas = [['Emisión', fechaDMY(v.fecha_emision)], ['Vencimiento', fechaDMY(v.fecha_vencimiento)], ['Moneda / T.C.', `${v.moneda || 'PEN'} · ${v.tipo_cambio ?? '—'}`], ['Base', _fm(v.base_imponible, v.moneda)], ['IGV', _fm(v.igv, v.moneda)], ['Total', `<b>${_fm(v.total, v.moneda)}</b>`], ['SUNAT', _esc(v.cpe_estado || '—')], ['Despacho', _esc(v.estado_despacho || '—')], ['Pago', _esc(v.estado_pago || '—')]]
    const det = (await supabase.from('detalle_ventas').select('descripcion, cantidad, precio_unitario, total_linea').eq('venta_id', id)).data || []
    if (det.length) tabla = `<table class="dc-tabla"><thead><tr><th>Producto</th><th>Cant.</th><th>P.U.</th><th>Total</th></tr></thead><tbody>${det.map(l => `<tr><td>${_esc(l.descripcion || '')}</td><td>${formatNumber(_n(l.cantidad), 2)}</td><td>${formatNumber(_n(l.precio_unitario), 4)}</td><td>${formatNumber(_n(l.total_linea))}</td></tr>`).join('')}</tbody></table>`
  } else if (tipo === 'packing') {
    const p = await get('packing'); if (!p) return null
    const cli = (await _contactos([p.contact_id]))[p.contact_id]
    titulo = p.numero || `PK #${id}`; sub = cli || ''
    filas = [['Emisión', fechaDMY(p.fecha_emision)], ['Validez', fechaDMY(p.fecha_validez)], ['Moneda', p.moneda || 'PEN'], ['Subtotal', _fm(p.subtotal, p.moneda)], ['IGV', _fm(p.igv, p.moneda)], ['Total', `<b>${_fm(p.total, p.moneda)}</b>`], ['Estado', _esc(p.estado || '—')], ['O/C del cliente', _esc(p.orden_compra_cliente || '—')]]
  } else if (tipo === 'guia_despacho') {
    const g = await get('guias_despacho_venta'); if (!g) return null
    titulo = `Guía ${g.numero_guia || '#' + id}`
    filas = [['Fecha', fechaDMY(g.fecha_guia)], ['Estado', _esc(g.estado || '—')], ['Llegada', _esc([g.punto_llegada_direccion, g.punto_llegada_distrito].filter(Boolean).join(' · ') || '—')], ['Observaciones', _esc(g.observaciones || '—')]]
  } else if (tipo === 'cxc' || tipo === 'cxp') {
    const esC = tipo === 'cxc'
    const c = await get(esC ? 'cuentas_cobrar' : 'cuentas_pagar'); if (!c) return null
    const nom = (await _contactos([c.contact_id]))[c.contact_id]
    const saldo = esC ? _saldoCxC(c) : _saldoCxP(c)
    titulo = `${esC ? 'CxC' : 'CxP'} #${id}`; sub = nom || ''
    const col = esC ? 'cxc_id' : 'cxp_id'
    const [cuo, mv] = await Promise.all([
      supabase.from(esC ? 'cuotas_cobrar' : 'cuotas_pagar').select('*').eq(col, id).order('numero_cuota'),
      supabase.from(esC ? 'cobros' : 'pagos_proveedores').select('*').eq(col, id).order('fecha')
    ])
    const cuotas = cuo.data || [], movs = mv.data || []
    const bk = await _bancosMap(movs.map(m => m.banco_id))
    const mon = c.moneda
    kpis = [['Total', _fm(c.monto_total, mon)], [esC ? 'Cobrado' : 'Pagado', _fm(esC ? c.monto_cobrado : c.monto_pagado, mon)], ...(esC && _n(c.monto_retenido) ? [['Retenido', _fm(c.monto_retenido, mon)]] : []), ...(_n(c.monto_notas_credito) ? [['Notas crédito', _fm(c.monto_notas_credito, mon)]] : []), ['Saldo', _fm(Math.max(0, saldo), mon), saldo <= 0.01 ? 'ok' : 'warn']]
    filas = [['Comprobante', _esc(`${_nomCP(c.tipo_comprobante)} ${c.serie || ''}-${c.numero_comprobante || ''}`)], ['Emisión', fechaDMY(c.fecha_emision)], ['Vence', fechaDMY(c.fecha_vencimiento)], ['Estado', _esc(c.estado || '—')], ...(mon === 'USD' ? [['T.C.', c.tipo_cambio ?? '—']] : [])]
    tabla = _tbl('Cuotas', ['N°', 'Vence', 'Monto', esC ? 'Cobrado' : 'Pagado', 'Estado'], cuotas.length > 1 || (cuotas[0] && cuotas[0].hito) ? cuotas.map(q => [q.numero_cuota + (q.hito ? ` · ${_esc(q.hito)}` : ''), fechaDMY(q.fecha_vencimiento), formatNumber(_n(q.monto)), formatNumber(_n(esC ? q.monto_cobrado : q.monto_pagado)), _esc(_legible(q.estado))]) : [])
      + _tbl(esC ? 'Cobros recibidos' : 'Pagos realizados', ['Fecha', 'Medio', esC ? 'Cuenta destino' : 'Cuenta origen', 'Monto'], movs.map(m => [fechaDMY(m.fecha), _esc(_legible(m.medio_pago || '—')), _esc(bk[m.banco_id] || (m.banco_id ? '—' : 'Sin cuenta')), formatNumber(_n(m.monto))]))
  } else if (tipo === 'cobro' || tipo === 'pago') {
    const esC = tipo === 'cobro'
    const c = await get(esC ? 'cobros' : 'pagos_proveedores'); if (!c) return null
    const nom = (await _contactos([c.contact_id]))[c.contact_id]
    const bk = await _bancosMap([c.banco_id])
    titulo = esC ? (c.numero_recibo ? `Recibo ${c.numero_recibo}` : `Cobro #${id}`) : `Pago #${id}`; sub = nom || ''
    kpis = [['Monto', _fm(c.monto, c.moneda)], ...(esC && _n(c.monto_retencion) > 0 ? [['Retención IGV', _fm(c.monto_retencion, c.moneda)]] : []), ...(esC && _n(c.saldo_favor_monto) > 0 ? [['Saldo a favor usado', _fm(c.saldo_favor_monto, c.moneda)]] : [])]
    filas = [['Fecha', fechaDMY(c.fecha)], [esC ? 'Cuenta destino' : 'Cuenta origen', _esc(bk[c.banco_id] || (c.banco_id ? '—' : 'Sin cuenta bancaria'))], ['Medio', _esc(_legible(c.medio_pago || '—'))], ['N° operación', _esc(c.numero_operacion || c.referencia || '—')], ...(c.moneda === 'USD' ? [['T.C.', c.tipo_cambio ?? '—']] : []), ...(esC && c.numero_comprobante_retencion ? [['Comprobante de retención', _esc(c.numero_comprobante_retencion)]] : []), ['Observaciones', _esc(c.observaciones || '—')]]
  } else if (tipo === 'banco') {
    const m = await get('movimientos_banco'); if (!m) return null
    const b = m.banco_id ? (await supabase.from('bancos').select('nombre, moneda, numero_cuenta').eq('id', m.banco_id).maybeSingle()).data : null
    titulo = `Movimiento ${_pad(m.id, 6)}`; sub = b ? `${b.nombre} · ${b.numero_cuenta || ''}` : ''
    filas = [['Fecha', fechaDMY(m.fecha)], ['Tipo', _esc(m.tipo || '—')], ['Monto', `<b>${_fm(m.monto, b?.moneda)}</b>`], ['Saldo posterior', m.saldo_posterior != null ? _fm(m.saldo_posterior, b?.moneda) : '—'], ['Concepto', _esc(m.concepto || '—')], ['Conciliado', m.reconciliado ? 'Sí' : 'No']]
  } else if (tipo === 'asiento') {
    const a = await get('journal_entries'); if (!a) return null
    const lin = (await supabase.from('journal_entry_lines').select('account_id, debe, haber, descripcion').eq('journal_entry_id', id)).data || []
    const cu = _porId((await supabase.from('plan_cuentas').select('id, codigo, nombre').in('id', _ids(lin.map(l => l.account_id)))).data)
    titulo = a.numero_asiento || `AS-${_pad(id, 6)}`; sub = a.descripcion || ''
    filas = [['Fecha', fechaDMY(a.fecha)], ['Periodo', _esc(a.periodo_contable || '—')], ['Total debe', _fm(a.total_debe, 'PEN')], ['Total haber', _fm(a.total_haber, 'PEN')]]
    tabla = `<table class="dc-tabla"><thead><tr><th>Cuenta</th><th>Debe</th><th>Haber</th></tr></thead><tbody>${lin.map(l => { const c = cu[l.account_id]; return `<tr><td>${_esc(c ? `${c.codigo} ${c.nombre}` : (l.descripcion || l.account_id))}</td><td>${_n(l.debe) ? formatNumber(l.debe) : ''}</td><td>${_n(l.haber) ? formatNumber(l.haber) : ''}</td></tr>` }).join('')}</tbody></table>`
  } else if (tipo === 'compra') {
    const c = await get('compras'); if (!c) return null
    titulo = `${_nomCP(c.tipo_comprobante)} ${c.serie || ''}-${c.numero || ''}`; sub = c.proveedor_nombre || ''
    filas = [['Emisión', fechaDMY(c.fecha_emision)], ['Recepción', fechaDMY(c.fecha_recepcion)], ['Moneda / T.C.', `${c.moneda || 'PEN'} · ${c.tipo_cambio ?? '—'}`], ['Total', `<b>${_fm(c.total, c.moneda)}</b>`], ['Referencia', _esc(c.referencia || '—')], ['Estado', _esc(c.estado || '—')]]
  } else if (tipo === 'guia_ingreso') {
    const g = await get('guias_ingreso_compra'); if (!g) return null
    titulo = `Guía ${g.numero_guia || '#' + id}`
    filas = [['Fecha', fechaDMY(g.fecha_guia)], ['Estado', _esc(g.estado || '—')], ['Observaciones', _esc(g.observaciones || '—')]]
  }
  return { titulo, sub, filas: filas.filter(([, v]) => !_vacio(v)), tabla, kpis }
}

// ── Cajón lateral apilado ───────────────────────────────────────────────────
const _pila = []   // [{ tipo, id, titulo }]
function _migas() {
  return _pila.map((p, i) => i === _pila.length - 1
    ? `<span class="dc-miga-act">${TIPOS[p.tipo].ico} ${_esc(p.titulo)}</span>`
    : `<button type="button" class="dc-miga" data-dc-miga="${i}">${_esc(p.titulo)}</button><span class="dc-sep">›</span>`).join('')
}
function _cajon() {
  let el = document.getElementById('dc-cajon')
  if (el) return el
  el = document.createElement('div'); el.id = 'dc-cajon'; el.className = 'dc-cajon'
  el.innerHTML = '<div class="dc-vel"></div><aside class="dc-panel" role="dialog" aria-label="Documento vinculado"><header class="dc-cab"><nav class="dc-migas"></nav><button type="button" class="dc-x" aria-label="Cerrar">✕</button></header><div class="dc-cuerpo"></div></aside>'
  document.body.appendChild(el)
  el.querySelector('.dc-vel').onclick = () => cerrarCajon()
  el.querySelector('.dc-x').onclick = () => cerrarCajon()
  el.addEventListener('click', ev => {
    const m = ev.target.closest('[data-dc-miga]'); if (m) { _pila.length = +m.dataset.dcMiga + 1; _pintarCajon(); return }
    const mr = ev.target.closest('[data-dc-resto]'); if (mr) { const r = mr.nextElementSibling; r.hidden = !r.hidden; mr.textContent = r.hidden ? `+${r.children.length} más` : 'Ver menos'; return }
    if (ev.target.closest('[data-dc-toggle],[data-dc-mas]')) return _alternarDetalle(el.querySelector('.dc-cuerpo'), ev.target.closest('[data-dc-mas]') ? true : undefined)
    const n = ev.target.closest('.dc-nodo,.dc-p[data-dc-k]'); if (n && !n.classList.contains('dc-actual')) return abrirCajon(n.dataset.dcK, n.dataset.dcId)
    const f = ev.target.closest('[data-dc-full]'); if (f) abrirFicha(f.dataset.dcFull, f.dataset.dcFid)
  })
  document.addEventListener('keydown', ev => { if (ev.key === 'Escape' && _pila.length) { ev.stopPropagation(); _pila.length > 1 ? (_pila.pop(), _pintarCajon()) : cerrarCajon() } }, true)
  return el
}

export function abrirCajon(tipo, id) {
  if (!TIPOS[tipo]) return
  _css(); _cajon()
  const i = _pila.findIndex(p => p.tipo === tipo && String(p.id) === String(id))
  if (i >= 0) _pila.length = i + 1; else _pila.push({ tipo, id, titulo: TIPOS[tipo].nom })
  _pintarCajon()
}
export function cerrarCajon() { _pila.length = 0; document.getElementById('dc-cajon')?.classList.remove('abierto') }

async function _pintarCajon() {
  const el = _cajon(), top = _pila[_pila.length - 1]
  if (!top) return cerrarCajon()
  el.classList.add('abierto')
  el.querySelector('.dc-migas').innerHTML = _migas()
  const cuerpo = el.querySelector('.dc-cuerpo')
  cuerpo.innerHTML = '<div class="dc-cargando">Cargando…</div>'
  const token = `${top.tipo}:${top.id}:${_pila.length}`
  el.dataset.token = token
  try {
    const [f, d] = await Promise.all([_ficha(top.tipo, top.id), _cadenaDe(top.tipo, top.id)])
    if (el.dataset.token !== token) return
    if (!f) { cuerpo.innerHTML = '<p class="dc-vacio">No se encontró el documento (¿es de otra empresa?).</p>'; return }
    top.titulo = f.titulo
    el.querySelector('.dc-migas').innerHTML = _migas()
    const full = TIPOS[top.tipo].fn
    cuerpo.innerHTML = `
      <div class="dc-titulo"><h3>${_esc(f.titulo)}</h3>${f.sub ? `<p>${_esc(f.sub)}</p>` : ''}</div>
      ${d ? _htmlBloque(d, { k: top.tipo, id: top.id }, true) : ''}
      ${f.kpis?.length ? `<div class="dc-kpis">${f.kpis.map(([k, v, t]) => `<div class="dc-kpi${t ? ' dc-t-' + t : ''}"><span>${_esc(k)}</span><b>${_esc(v)}</b></div>`).join('')}</div>` : ''}
      <table class="dc-ficha"><tbody>${f.filas.map(([k, v]) => _fila(k, v)).join('')}</tbody></table>
      ${f.tabla || ''}
      ${full ? `<div class="dc-pie"><button type="button" class="btn btn-secondary" data-dc-full="${top.tipo}" data-dc-fid="${top.id}">Abrir ficha completa ↗</button></div>` : ''}`
  } catch (e) { console.warn('cajón:', e); cuerpo.innerHTML = `<p class="dc-vacio">No se pudo cargar: ${_esc(e.message)}</p>` }
}

/** Ficha completa: modal real si está en esta página; si no, navega al módulo con ?ver=tipo:id. */
export function abrirFicha(tipo, id) {
  const t = TIPOS[tipo]; if (!t) return
  if (_puedeAbrirReal(tipo)) { cerrarCajon(); return t.abrir(id) }
  if (_tienePagina(tipo)) location.href = `${t.pagina}?ver=${tipo}:${id}`
}

// ── Enlace profundo ?ver=tipo:id (lo usa «Abrir ficha completa» entre módulos) ──
function _enlaceProfundo() {
  const p = new URLSearchParams(location.search).get('ver'); if (!p) return
  const [tipo, id] = p.split(':'); const t = TIPOS[tipo]; if (!t?.fn) return
  let n = 0
  const timer = setInterval(() => {
    if (typeof window[t.fn] === 'function') {
      clearInterval(timer)
      try { const u = new URL(location.href); u.searchParams.delete('ver'); history.replaceState(null, '', u) } catch {}
      setTimeout(() => t.abrir(Number(id)), 600)
    } else if (++n > 40) clearInterval(timer)
  }, 250)
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', _enlaceProfundo); else _enlaceProfundo()

// ── Engancha los modales de detalle que se arman en otros módulos (sin tocar sus archivos) ──
const _ENGANCHES = [
  { fn: 'verDetalleGuiaIngreso', tipo: 'guia_ingreso', modal: 'modal-detalle-guia-ingreso', id: (...a) => a[0] },
  { fn: 'verDetalleNotaVenta',   tipo: 'nota_venta',   modal: 'modal-detalle-nota-venta',   id: (...a) => a[0] },
  { fn: 'verDetalleNotaCompra',  tipo: 'nota_compra',  modal: 'modal-detalle-nota-compra',  id: (...a) => a[0] },
  { fn: 'verDetalleLetra',       tipo: 'letra',        cuerpo: 'detalle-cp-body',           id: (...a) => a[0] },
  { fn: 'verDetalleCuota',       tipo: a => (a[0] === 'cxc' ? 'cuota_cxc' : 'cuota_cxp'), cuerpo: 'detalle-cp-body', id: (...a) => a[1] }
]
function _enganchar() {
  let faltan = 0
  for (const e of _ENGANCHES) {
    const f = window[e.fn]
    if (typeof f !== 'function') { faltan++; continue }
    if (f.__dc) continue
    const w = async function (...a) {
      const r = await f.apply(this, a)
      try {
        const tipo = typeof e.tipo === 'function' ? e.tipo(a) : e.tipo, id = e.id(...a)
        if (e.cuerpo) {
          const body = document.getElementById(e.cuerpo); if (!body) return r
          body.querySelector(':scope > .dc-host')?.remove()
          body.insertAdjacentHTML('afterbegin', '<div class="dc-host"></div>')
          montarConexiones(body.firstElementChild, tipo, id)
        } else montarConexiones(e.modal, tipo, id)
      } catch (x) { console.warn('detalle-conectado/enganche', e.fn, x) }
      return r
    }
    w.__dc = true; window[e.fn] = w
  }
  return faltan
}
{ let n = 0; const t = setInterval(() => { if (_enganchar() === 0 || ++n > 20) clearInterval(t) }, 500) }

window.abrirCajonDoc = abrirCajon
window.montarConexiones = montarConexiones
