// ============================================================================
// shared/detraccion.js — Detracciones (SPOT) en COMPRAS de SERVICIOS (2026-11-11)
// ----------------------------------------------------------------------------
// Un solo componente para todos los flujos (LEY: un solo registro, cero doble digitación):
//   · montarDetraccion(host, {prefijo})  → caja embebida en los modales de compra (servicio) y gasto del costeo
//   · abrirModalDetraccion(compraId)      → modal suelto para editar / regularizar / registrar constancia (lista de compras y CxP)
//   · detraccionAutomatica(...)           → detección SIN pantalla (registro automático de gastos de importación)
//   · espejoCxP(compra)                   → copia el resumen de la compra a su Cuenta por Pagar
// Reglas (SUNAT, Anexo 3 R.S. 183-2004): solo servicios GRAVADOS con IGV, factura (01), importe de la operación > S/ 700 (monto_minimo del catálogo).
// El monto SIEMPRE es en soles y se redondea al sol (Math.round: 0.50 sube). Tasas y códigos salen de `detraccion_tasas` (editable; por_verificar).
// Modelo de la CxP: queda por el TOTAL; detracción = parte del total que se paga aparte
//   · camino A (deposita el PROVEEDOR): pagamos el total y se registra su constancia aquí (detraccion_estado='depositada', pagada_por='proveedor').
//   · camino B (depositamos NOSOTROS): en Cobranzas → Pagar detracción (medio 'detraccion', egreso de nuestro banco) + pago del neto.
// Semántica de compras.detraccion_pagada_por: 'quién la deposita' (intención mientras está pendiente; real cuando está depositada).
//
// ── NOTAS PARA LA SESIÓN DE CONTABILIDAD (pendientes; NO hay asientos todavía — gancho comentado) ─────────────────────
//   · Registrar la compra: la detracción NO cambia el asiento de la factura (42 por el total, IGV 40111). Solo informa.
//   · Pago de la detracción por nosotros (pagos_proveedores.medio_pago='detraccion'): Debe 42xx cuenta por pagar al proveedor / Haber 104x banco de origen.
//     El depósito va a la cuenta de detracciones DEL PROVEEDOR (no es una cuenta nuestra): se guarda en detraccion_cuenta_bn y detraccion_operacion.
//   · Deposita el proveedor: sin asiento nuestro; solo evidencia (constancia) para sustentar crédito fiscal y gasto.
//   · Crédito fiscal IGV: se usa recién desde el período en que se acredita el depósito → reporte «Detracciones por depositar» (compras.detraccion_estado='pendiente').
//   · Si la factura es en USD: el monto en soles usa T.C. venta; al pagar se recalcula con el T.C. venta de la fecha del voucher (pagos_proveedores.monto_pen).
// ============================================================================
import { query } from '../supabase-client.js'
import { getContactById, updateContact, updateCompra, updateCuentaPagar, subirAdjuntoCompra } from '../supabase-data.js'
import { getTCVenta } from '../sunat-api.js'
import { showToast } from '../helpers.js'

export const DETR_MIN_DEFAULT = 700
const num = x => { const n = parseFloat(String(x ?? '').replace(/,/g, '')); return isNaN(n) ? 0 : n }
const r2 = x => Math.round((num(x) + Number.EPSILON) * 100) / 100
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
const sim = m => (m === 'USD' ? 'US$' : 'S/')
const nf = (x, d = 2) => num(x).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })

// ── Catálogo ──────────────────────────────────────────────────────────────────
let _cat = null
export async function catalogoDetraccion(forzar = false) {
  if (_cat && !forzar) return _cat
  try { _cat = ((await query('detraccion_tasas', { activo: true })) || []).sort((a, b) => (a.orden || 0) - (b.orden || 0)) }
  catch { _cat = [] }   // aún sin SQL 157
  return _cat
}
export const tasaDe = (cat, codigo) => (cat || []).find(c => c.codigo === codigo) || null

/** Sugiere el código según el texto del servicio (palabras_clave del catálogo); si nada calza → 037 «Demás servicios». */
export function sugerirCodigo(texto, cat) {
  const t = norm(texto); let mejor = null, largo = 0
  for (const c of (cat || [])) {
    if (c.codigo === '037') continue
    for (const k of String(c.palabras_clave || '').split(',')) {
      const kk = norm(k).trim()
      if (kk && t.includes(kk) && kk.length > largo) { mejor = c; largo = kk.length }
    }
  }
  return mejor || tasaDe(cat, '037') || (cat || [])[0] || null
}

/** ¿Corresponde detracción? (sin pantalla). totalPen = total del comprobante en soles. */
export function evaluarDetraccion({ tipoCompra = 'servicio', tipoComprobante = '01', igvMonto, total, moneda, tc, minimo }) {
  const totalPen = r2(num(total) * (moneda === 'USD' ? (num(tc) || 1) : 1))
  if (tipoCompra && tipoCompra !== 'servicio') return { sugiere: false, visible: false, totalPen, motivo: 'La detracción solo se gestiona en compras de servicio.' }
  if (tipoComprobante && tipoComprobante !== '01') return { sugiere: false, visible: false, totalPen, motivo: 'Solo las facturas (01) llevan detracción.' }
  if (!(num(igvMonto) > 0)) return { sugiere: false, visible: true, totalPen, motivo: 'Sin IGV (exonerado/inafecto/exterior): no se detrae.' }
  const min = num(minimo) || DETR_MIN_DEFAULT
  if (totalPen <= min) return { sugiere: false, visible: true, totalPen, motivo: `Importe S/ ${nf(totalPen)} ≤ S/ ${min}: no se detrae.` }
  return { sugiere: true, visible: true, totalPen, motivo: `Servicio gravado por S/ ${nf(totalPen)} (> S/ ${min}): corresponde detracción.` }
}
/** Fecha límite aprox. del depósito cuando el comprador es el obligado: el 5.º día hábil del mes siguiente a la anotación en el Registro de Compras
 *  (o antes, si se paga el comprobante). No descuenta feriados: verificar con SUNAT/contador. Entrada/salida 'YYYY-MM-DD'. */
export function limiteDeposito(fechaISO) {
  if (!fechaISO) return null
  const [y0, m0] = String(fechaISO).slice(0, 10).split('-').map(Number)
  let y = y0, m = m0   // m0 es 1-12 → el índice del mes siguiente es m0
  if (m > 11) { y++; m = 0 }
  const dt = new Date(y, m, 1); let n = 0
  for (;;) { const w = dt.getDay(); if (w !== 0 && w !== 6 && ++n === 5) break; dt.setDate(dt.getDate() + 1) }
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`
}
export const calcMontoDetraccion = (totalPen, pct) => (num(pct) > 0 ? Math.round(num(totalPen) * num(pct) / 100) : 0)

/** Resumen de la compra → columnas espejo de cuentas_pagar (solo si aplica, así no rompe sin el SQL). */
export function espejoCxP(c) {
  if (!c?.detraccion_aplica) return {}
  return { detraccion_aplica: true, detraccion_codigo: c.detraccion_codigo ?? null, detraccion_pct: c.detraccion_pct ?? null,
    detraccion_monto: c.detraccion_monto ?? null, detraccion_estado: c.detraccion_estado || 'pendiente',
    detraccion_pagada_por: c.detraccion_pagada_por ?? null, detraccion_fecha: c.detraccion_fecha ?? null, detraccion_operacion: c.detraccion_operacion ?? null }
}

/** Detección + valores SIN pantalla (registro automático de gastos del costeo). Devuelve {} si no aplica o falta el SQL. */
export async function detraccionAutomatica({ proveedorId, texto, tipoComprobante, igvMonto, total, moneda, tc }) {
  try {
    const cat = await catalogoDetraccion(); if (!cat.length) return {}
    const perfil = proveedorId ? await getContactById(proveedorId) : null
    const cod = (perfil?.detraccion_codigo && tasaDe(cat, perfil.detraccion_codigo)) || sugerirCodigo(texto, cat)
    const ev = evaluarDetraccion({ tipoComprobante, igvMonto, total, moneda, tc, minimo: cod?.monto_minimo })
    if (!ev.sugiere || !cod) return {}
    const pct = num(perfil?.detraccion_codigo === cod.codigo && perfil?.detraccion_pct ? perfil.detraccion_pct : cod.porcentaje)
    return { detraccion_aplica: true, detraccion_codigo: cod.codigo, detraccion_pct: pct, detraccion_monto: calcMontoDetraccion(ev.totalPen, pct),
      detraccion_estado: 'pendiente', detraccion_pagada_por: perfil?.detraccion_paga_habitual || 'proveedor', detraccion_cuenta_bn: perfil?.detraccion_cuenta_bn || null }
  } catch (e) { console.warn('detraccionAutomatica', e); return {} }
}

/** Chip para listas (Compras / CxP). */
export function badgeDetraccion(c) {
  if (!c?.detraccion_aplica) return ''
  const m = `S/ ${nf(c.detraccion_monto, 0)}`
  return c.detraccion_estado === 'depositada'
    ? `<span class="badge" style="background:rgba(16,185,129,.15);color:#10b981;" title="Detracción depositada${c.detraccion_pagada_por ? ' por ' + c.detraccion_pagada_por : ''}">✔ Detr. ${m}</span>`
    : `<span class="badge" style="background:rgba(245,158,11,.18);color:#f59e0b;" title="Detracción por depositar">🧾 Detr. ${m} por depositar</span>`
}

// ── Componente embebido ───────────────────────────────────────────────────────
/**
 * Monta la caja «Detracción» en `host`. Devuelve el controlador:
 *   .actualizar({ tipoCompra, tipoComprobante, igvMonto, total, moneda, tc, proveedorId, texto })  → recalcula/auto-detecta
 *   .leer()   → { valores, perfilPatch, error }   (valores = columnas de compras.detraccion_*)
 *   .cargar(compra) → rellena desde una compra existente (edición)
 */
export async function montarDetraccion(host, { prefijo = 'dt', conDeposito = true } = {}) {
  const p = prefijo, $ = id => document.getElementById(p + id)
  const cat = await catalogoDetraccion()
  const st = { manualAplica: false, manualCodigo: false, manualMonto: false, ctx: {}, perfil: null, perfilId: null }
  host.innerHTML = `<div style="margin-top:10px; padding:10px 12px; border:1px solid var(--border-color); border-radius:var(--radius-md); background:var(--bg-secondary);">
    <div style="display:flex; justify-content:space-between; align-items:center; gap:8px; flex-wrap:wrap;">
      <strong>🧾 Detracción (SPOT)</strong>
      <label style="display:flex; gap:6px; align-items:center; font-size:.85rem; cursor:pointer;"><input type="checkbox" id="${p}Aplica"> Aplica detracción</label>
    </div>
    <div id="${p}Aviso" style="font-size:.8rem; color:var(--text-secondary); margin:4px 0 6px;"></div>
    <div id="${p}Campos" style="display:none;">
      <div style="display:grid; grid-template-columns:2.2fr .7fr 1fr 1fr; gap:10px;">
        <div class="form-group"><label>Código / servicio (SUNAT)</label><select id="${p}Codigo"><option value="">— Elige —</option>${cat.map(c => `<option value="${esc(c.codigo)}">${esc(c.codigo)} · ${esc(c.descripcion)} (${nf(c.porcentaje, 0)} %)</option>`).join('')}</select></div>
        <div class="form-group"><label>%</label><input type="number" id="${p}Pct" step="0.01" min="0" max="100"></div>
        <div class="form-group"><label>Detracción (S/)</label><input type="number" id="${p}Monto" step="1" min="0"></div>
        <div class="form-group"><label id="${p}LblNeto">Neto al proveedor</label><input type="number" id="${p}Neto" readonly disabled></div>
      </div>
      <div style="display:grid; grid-template-columns:1fr 1.4fr; gap:10px;">
        <div class="form-group"><label>¿Quién la deposita?</label><select id="${p}Quien"><option value="proveedor">El proveedor</option><option value="nosotros">Nosotros</option></select></div>
        <div class="form-group"><label>Cuenta de detracciones del proveedor (Banco de la Nación)</label><input type="text" id="${p}Cuenta" maxlength="40" placeholder="N° de cuenta — se guarda en el perfil del proveedor"></div>
      </div>
      ${conDeposito ? `<label style="display:flex; gap:6px; align-items:center; font-size:.85rem; cursor:pointer; margin:2px 0 6px;"><input type="checkbox" id="${p}Ya"> Ya está depositada (tengo la constancia)</label>
      <div id="${p}YaBox" style="display:none; grid-template-columns:1fr 1.4fr; gap:10px;">
        <div class="form-group"><label>Fecha del depósito</label><input type="date" id="${p}Fecha"></div>
        <div class="form-group"><label>N° de operación / constancia</label><input type="text" id="${p}Op" maxlength="60"></div>
      </div>` : ''}
    </div></div>`

  const ev = id => $(id)
  const pintarNeto = () => {
    const c = st.ctx, total = num(c.total), pct = num($('Pct').value)
    const detrDoc = c.moneda === 'USD' ? r2(total * pct / 100) : num($('Monto').value)
    ev('Neto').value = Math.max(0, r2(total - detrDoc)).toFixed(2)
    ev('LblNeto').textContent = `Neto al proveedor (${sim(c.moneda)})`
  }
  const recalcMonto = () => {
    if (st.manualMonto) { pintarNeto(); return }
    const e = evaluarDetraccion({ ...st.ctx, minimo: 0 })
    $('Monto').value = calcMontoDetraccion(e.totalPen, $('Pct').value) || ''
    pintarNeto()
  }
  const setCodigo = (cod, pct) => { $('Codigo').value = cod?.codigo || ''; $('Pct').value = pct ?? cod?.porcentaje ?? '' }
  const mostrarCampos = () => { $('Campos').style.display = $('Aplica').checked ? '' : 'none' }

  $('Aplica').onchange = () => { st.manualAplica = true; mostrarCampos(); if ($('Aplica').checked) { if (!$('Codigo').value) autoCodigo(); recalcMonto() } }
  $('Codigo').onchange = () => { st.manualCodigo = true; const c = tasaDe(cat, $('Codigo').value); $('Pct').value = c ? c.porcentaje : ''; st.manualMonto = false; recalcMonto() }
  $('Pct').oninput = () => { st.manualMonto = false; recalcMonto() }
  $('Monto').oninput = () => { st.manualMonto = true; pintarNeto() }
  if (conDeposito) $('Ya').onchange = () => { $('YaBox').style.display = $('Ya').checked ? 'grid' : 'none' }

  function autoCodigo() {
    if (st.manualCodigo) return
    const pf = st.perfil, delPerfil = pf?.detraccion_codigo ? tasaDe(cat, pf.detraccion_codigo) : null
    const cod = delPerfil || sugerirCodigo(st.ctx.texto, cat)
    if (!cod) return
    setCodigo(cod, delPerfil && num(pf.detraccion_pct) ? pf.detraccion_pct : cod.porcentaje)
  }

  const ctrl = {
    cat, st,
    async actualizar(ctx = {}) {
      const cambioProv = ctx.proveedorId !== undefined && ctx.proveedorId !== st.perfilId
      st.ctx = { ...st.ctx, ...ctx }
      if (cambioProv) {
        st.perfilId = ctx.proveedorId || null
        st.perfil = st.perfilId ? await getContactById(st.perfilId).catch(() => null) : null
        if (st.perfil) {
          if (st.perfil.detraccion_paga_habitual) $('Quien').value = st.perfil.detraccion_paga_habitual
          if (st.perfil.detraccion_cuenta_bn) $('Cuenta').value = st.perfil.detraccion_cuenta_bn
          else if (cambioProv) $('Cuenta').value = ''
        }
      }
      const c = st.ctx
      const cod = tasaDe(cat, $('Codigo').value) || (st.perfil?.detraccion_codigo && tasaDe(cat, st.perfil.detraccion_codigo)) || sugerirCodigo(c.texto, cat)
      const e = evaluarDetraccion({ ...c, minimo: cod?.monto_minimo })
      host.style.display = e.visible ? '' : 'none'
      if (!e.visible) { $('Aplica').checked = false; mostrarCampos(); return }
      if (!cat.length) { $('Aviso').textContent = '⚠ Falta correr el SQL 157 (catálogo de detracciones).'; return }
      let aviso = e.motivo
      if (c.moneda === 'USD' && e.sugiere) aviso += ' En dólares el monto en soles es un estimado: se recalcula al pagar con el T.C. venta de la fecha del voucher.'
      if (!st.manualAplica) { $('Aplica').checked = e.sugiere; mostrarCampos() }
      $('Aviso').textContent = aviso
      if ($('Aplica').checked) { autoCodigo(); recalcMonto() }
    },
    cargar(compra) {
      if (!compra) return
      st.manualAplica = true; st.manualCodigo = true; st.manualMonto = true
      $('Aplica').checked = !!compra.detraccion_aplica; mostrarCampos()
      setCodigo(tasaDe(cat, compra.detraccion_codigo), compra.detraccion_pct ?? '')
      $('Monto').value = compra.detraccion_monto ?? ''
      if (compra.detraccion_pagada_por) $('Quien').value = compra.detraccion_pagada_por
      if (compra.detraccion_cuenta_bn) $('Cuenta').value = compra.detraccion_cuenta_bn
      if (conDeposito) {
        $('Ya').checked = compra.detraccion_estado === 'depositada'; $('YaBox').style.display = $('Ya').checked ? 'grid' : 'none'
        $('Fecha').value = compra.detraccion_fecha || ''; $('Op').value = compra.detraccion_operacion || ''
      }
      pintarNeto()
    },
    leer() {
      if (!$('Aplica').checked) return { valores: { detraccion_aplica: false, detraccion_estado: 'no_aplica', detraccion_codigo: null, detraccion_pct: null, detraccion_monto: null, detraccion_pagada_por: null, detraccion_fecha: null, detraccion_operacion: null }, perfilPatch: {}, error: null }
      const codigo = $('Codigo').value, pct = num($('Pct').value), monto = num($('Monto').value)
      if (!codigo) return { error: 'Detracción: elige el código del servicio.' }
      if (!(pct > 0)) return { error: 'Detracción: indica el porcentaje.' }
      if (!(monto > 0)) return { error: 'Detracción: el monto en soles debe ser mayor a 0.' }
      const ya = conDeposito && $('Ya').checked
      const cuenta = $('Cuenta').value.trim(), quien = $('Quien').value
      const valores = { detraccion_aplica: true, detraccion_codigo: codigo, detraccion_pct: pct, detraccion_monto: monto,
        detraccion_estado: ya ? 'depositada' : 'pendiente', detraccion_pagada_por: quien,
        detraccion_fecha: ya ? ($('Fecha').value || null) : null, detraccion_operacion: ya ? ($('Op').value.trim() || null) : null, detraccion_cuenta_bn: cuenta || null }
      // Perfil del proveedor: se completa lo que esté vacío; la cuenta se actualiza si cambió
      const pf = st.perfil || {}, perfilPatch = {}
      if (!pf.detraccion_codigo) { perfilPatch.detraccion_codigo = codigo; perfilPatch.detraccion_pct = pct }
      if (!pf.detraccion_paga_habitual) perfilPatch.detraccion_paga_habitual = quien
      if (cuenta && cuenta !== (pf.detraccion_cuenta_bn || '')) perfilPatch.detraccion_cuenta_bn = cuenta
      return { valores, perfilPatch, error: null, contactId: st.perfilId }
    }
  }
  return ctrl
}

/** Guarda el resultado de leer() en la compra, su(s) CxP, el documento del costeo y el perfil del proveedor. */
export async function guardarDetraccionCompra({ compraId, valores, perfilPatch, contactId }) {
  if (!(await updateCompra(compraId, valores))) throw new Error('No se pudo guardar la detracción en la compra (¿corriste el SQL 157?)')
  const espejo = valores.detraccion_aplica ? espejoCxP(valores) : { detraccion_aplica: false, detraccion_estado: 'no_aplica', detraccion_codigo: null, detraccion_pct: null, detraccion_monto: null, detraccion_pagada_por: null, detraccion_fecha: null, detraccion_operacion: null }
  const cxps = (await query('cuentas_pagar', { compra_id: compraId })) || []
  for (const x of cxps.filter(x => x.estado !== 'anulado')) await updateCuentaPagar(x.id, espejo)
  try {
    const docs = (await query('documentos_importacion', { compra_id: compraId })) || []
    const { update } = await import('../supabase-client.js')
    for (const d of docs) await update('documentos_importacion', d.id, { detraccion_monto: valores.detraccion_aplica ? valores.detraccion_monto : null, detraccion_estado: valores.detraccion_estado })
  } catch (e) { console.warn('espejo documentos_importacion', e) }
  if (contactId && perfilPatch && Object.keys(perfilPatch).length) { try { await updateContact(contactId, perfilPatch) } catch (e) { console.warn('perfil detracción', e) } }
}

// ── Modal suelto (editar / regularizar / registrar constancia) ────────────────
export async function abrirModalDetraccion(compraId, { alGuardar } = {}) {
  const compra = (await query('compras', { id: compraId }))?.[0]
  if (!compra) { showToast('No se encontró la compra', 'danger'); return }
  const ov = document.createElement('div')
  ov.style.cssText = 'position:fixed;inset:0;z-index:100000;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;padding:16px'
  ov.innerHTML = `<div style="max-width:760px;width:100%;max-height:92vh;overflow:auto;background:var(--bg-secondary,#1e293b);border:1px solid var(--border-color,#334155);border-radius:16px;padding:20px;box-shadow:0 20px 50px rgba(0,0,0,.5)">
    <h3 style="margin:0 0 4px">🧾 Detracción · ${esc(compra.tipo_comprobante || '')} ${esc(compra.serie || '')}-${esc(compra.numero || '')}</h3>
    <div style="font-size:.85rem;color:var(--text-secondary);margin-bottom:6px">${esc(compra.proveedor_nombre || '')} · Total ${sim(compra.currency)} ${nf(compra.total)}</div>
    <div id="dtmHost"></div>
    <div class="form-group" style="margin-top:8px"><label>Constancia de depósito (opcional — PDF o imagen)</label><input type="file" id="dtmArchivo" accept="application/pdf,image/jpeg,image/png"></div>
    <div id="dtmMsg" style="min-height:18px;font-size:.85rem;margin:6px 0;color:#ef4444"></div>
    <div style="display:flex;gap:8px;justify-content:flex-end"><button class="btn" id="dtmCancel">Cancelar</button><button class="btn btn-primary" id="dtmOk">💾 Guardar</button></div></div>`
  document.body.appendChild(ov)
  const ctrl = await montarDetraccion(ov.querySelector('#dtmHost'), { prefijo: 'dtm' })
  await ctrl.actualizar({ tipoCompra: compra.tipo_compra, tipoComprobante: compra.tipo_comprobante, igvMonto: compra.igv_gravado, total: compra.total, moneda: compra.currency || 'PEN', tc: compra.tipo_cambio, proveedorId: compra.contact_id, texto: compra.descripcion })
  if (compra.detraccion_aplica || compra.detraccion_estado !== 'no_aplica') ctrl.cargar(compra)
  else document.getElementById('dtmAplica').checked = true, document.getElementById('dtmAplica').dispatchEvent(new Event('change'))
  const cerrar = () => ov.remove()
  ov.querySelector('#dtmCancel').onclick = cerrar
  ov.querySelector('#dtmOk').onclick = async (e) => {
    const r = ctrl.leer(), msg = ov.querySelector('#dtmMsg')
    if (r.error) { msg.textContent = r.error; return }
    e.currentTarget.disabled = true
    try {
      await guardarDetraccionCompra({ compraId, valores: r.valores, perfilPatch: r.perfilPatch, contactId: compra.contact_id })
      const f = ov.querySelector('#dtmArchivo').files?.[0]
      if (f) { try { await subirAdjuntoCompra(compraId, f) } catch (er) { console.warn(er); showToast('Detracción guardada, pero no se pudo subir la constancia', 'warning') } }
      showToast('Detracción guardada ✔', 'success'); cerrar(); await alGuardar?.()
      window.dispatchEvent(new CustomEvent('zv-detraccion-guardada', { detail: { compraId } }))
    } catch (er) { msg.textContent = er.message || String(er); e.currentTarget.disabled = false }
  }
}
window.abrirModalDetraccion = (id, opts) => abrirModalDetraccion(id, opts)
