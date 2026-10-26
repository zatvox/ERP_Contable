// ============================================================================
// PAGOS-PROVEEDOR.JS — Pagos de una carpeta de importación (SQL 94)
// ============================================================================
// Registra, desde pantalla y con el documento en la mano, cada giro de la
// carpeta: ANTICIPO y SALDO al proveedor del exterior, pagos al agente y
// devoluciones. Se llena con lo que dice la constancia del banco (BCP) y el
// mensaje SWIFT: monto transferido, comisión de transferencia, comisión SWIFT,
// cuenta de origen, beneficiario, BIC, código de operación y UETR.
//
// Qué hace al guardar:
//   1. Inserta la fila en `importacion_pagos`.
//   2. Las comisiones (transferencia + SWIFT) se registran como líneas de
//      costo `comision_bancaria` (gasto financiero) en el ledger de la carpeta.
//   3. Sube la constancia / SWIFT al expediente (adjuntos, entidad
//      'importacion_pago').
//
// NO mueve el banco ni genera asiento: eso es Tesorería (fase posterior).
// Asiento previsto (solo comentario):
//   anticipo → Dr 422 Anticipos a proveedores / Cr 104 Bancos (monto)
//   comisión → Dr 6771 Gastos financieros / Cr 104 Bancos
//   saldo    → Dr 4212 Facturas por pagar (o aplica el anticipo) / Cr 104 Bancos
// ============================================================================

import { query, insert, update, deleteRecord, ultimoErrorInsert, esperarContextoEmpresa } from '../supabase-client.js'
import { getCurrentUser } from '../auth-supabase.js'
import { showToast, formatNumber, fechaDMY } from '../helpers.js'
import { declararEmpresaModal } from '../empresa.js'
import { miniaturaArchivoHTML, pintarMiniaturaArchivo } from '../shared/adj-preview.js'
import { getBancos, ADJ_CONCEPTOS, subirAdjuntos, getAdjuntos, getUrlAdjunto, eliminarAdjuntosDe, validarArchivoAdjunto } from '../supabase-data.js'
import { getTipoCambioDia } from '../sunat-api.js'
import { crearLineaCosto } from './costos-ledger.js'

const num = x => parseFloat(x) || 0
const n2 = x => formatNumber(num(x), 2)
const _esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const $ = id => document.getElementById(id)
const v = id => ($(id)?.value ?? '').toString().trim()

export const TIPOS_PAGO = {
  anticipo:   'Anticipo al proveedor',
  saldo:      'Saldo al proveedor',
  pago_total: 'Pago total al proveedor',
  agente:     'Pago al agente / terceros',
  devolucion: 'Devolución del proveedor',
  otro:       'Otro'
}
const TIPOS_AL_PROVEEDOR = ['anticipo', 'saldo', 'pago_total']
const MARCA_COMISION = id => `Pago importación #${id}`

let _ctx = { carpetaId: null, carpeta: null, oc: null, proveedor: null, pagos: [], bancos: [] }
let _archivos = []

const carpetaActual = () => window.costeoActual?.carpeta_importacion_id || window.carpetaActual?.id || null

// ─── Carga ──────────────────────────────────────────────────────────────────
async function _cargar() {
  await esperarContextoEmpresa()
  const carpetaId = carpetaActual()
  _ctx = { carpetaId, carpeta: null, oc: null, proveedor: null, pagos: [], bancos: [] }
  if (!carpetaId) return false

  _ctx.carpeta = ((await query('carpetas_importacion', { id: carpetaId })) || [])[0] || null
  if (_ctx.carpeta?.orden_compra_id) {
    _ctx.oc = ((await query('orden_compra', { id: _ctx.carpeta.orden_compra_id })) || [])[0] || null
    if (_ctx.oc?.contact_id) _ctx.proveedor = ((await query('contacts', { id: _ctx.oc.contact_id })) || [])[0] || null
  }
  _ctx.pagos = ((await query('importacion_pagos', { carpeta_importacion_id: carpetaId })) || [])
    .sort((a, b) => String(a.fecha).localeCompare(String(b.fecha)) || a.id - b.id)
  try { _ctx.bancos = (await getBancos() || []).filter(b => b.activo !== false) } catch { _ctx.bancos = [] }
  return true
}

// ─── Resumen contra la Proforma ─────────────────────────────────────────────
function _resumen() {
  const oc = _ctx.oc
  const total = num(oc?.total_oc)
  const pct = num(oc?.anticipo_porcentaje)
  const monedaPI = oc?.currency || 'USD'
  const valido = p => p.estado !== 'observado'
  const alProv = _ctx.pagos.filter(p => TIPOS_AL_PROVEEDOR.includes(p.tipo) && valido(p))
  const mixta = alProv.some(p => p.moneda !== monedaPI)
  const pagado = alProv.filter(p => p.moneda === monedaPI).reduce((s, p) => s + num(p.monto_transferido), 0)
  const devuelto = _ctx.pagos.filter(p => p.tipo === 'devolucion' && valido(p) && p.moneda === monedaPI)
    .reduce((s, p) => s + num(p.monto_transferido), 0)
  const comisiones = _ctx.pagos.filter(valido).reduce((s, p) => s + num(p.comision_transferencia) + num(p.comision_swift), 0)
  return {
    total, pct, monedaPI, mixta,
    anticipoEsperado: total * pct / 100,
    pagado, devuelto, comisiones,
    pendiente: total - pagado + devuelto
  }
}

// ─── Modal ──────────────────────────────────────────────────────────────────
function _asegurarModal() {
  if ($('modal-pagos-proveedor')) return
  const tipos = Object.entries(TIPOS_PAGO).map(([k, t]) => `<option value="${k}">${t}</option>`).join('')
  document.body.insertAdjacentHTML('beforeend', `
  <div id="modal-pagos-proveedor" class="modal">
    <div class="modal-content" style="width:min(96vw, 980px); max-width:min(96vw, 980px); max-height:calc(100vh - 48px); overflow-y:auto;">
      <div class="modal-header">
        <h3 class="modal-title" id="ppTitulo">Pagos de la carpeta</h3>
        <button class="modal-close" onclick="window.cerrarPagosProveedor()">&times;</button>
      </div>
      <div style="padding:16px 20px 0;">
        <div id="ppResumen"></div>

        <strong class="mod-sec">Pagos registrados</strong>
        <div id="ppLista" class="table-container"></div>

        <div id="ppFormWrap" style="display:none;">
          <hr style="border:none; border-top:1px solid var(--border-color); margin:16px 0;">
          <strong class="mod-sec">Nuevo pago — datos de la constancia del banco</strong>
          <div style="display:grid; grid-template-columns:repeat(4, 1fr); gap:10px;">
            <div class="form-group"><label>Tipo de pago *</label>
              <select id="ppTipo" onchange="window.ppSugerirMonto()">${tipos}</select></div>
            <div class="form-group"><label>Fecha de operación *</label>
              <input type="date" id="ppFecha" onchange="window.ppTCDelDia()"></div>
            <div class="form-group"><label>Moneda *</label>
              <select id="ppMoneda" onchange="window.ppSugerirMonto()"><option>USD</option><option>PEN</option><option>EUR</option></select></div>
            <div class="form-group"><label>T.C. (S/ por US$) <span id="ppTCAviso" style="font-weight:400; color:var(--text-secondary); font-size:0.75rem;"></span></label>
              <div style="display:flex; gap:4px;"><input type="number" step="0.001" id="ppTC" oninput="this.dataset.auto='0'">
              <button type="button" class="btn btn-secondary btn-small" onclick="window.ppTCDelDia(true)" title="Traer el T.C. del día">⟳</button></div></div>

            <div class="form-group"><label>Monto transferido *</label>
              <input type="number" step="0.01" id="ppMonto" oninput="window.ppRecalcular()">
              <small id="ppSugerido" style="color:var(--text-secondary);"></small></div>
            <div class="form-group"><label>Comisión de transferencia</label>
              <input type="number" step="0.01" id="ppComTransf" value="0" oninput="window.ppRecalcular()"></div>
            <div class="form-group"><label>Comisión SWIFT</label>
              <input type="number" step="0.01" id="ppComSwift" value="0" oninput="window.ppRecalcular()"></div>
            <div class="form-group"><label>Total debitado</label>
              <input type="text" id="ppTotalDeb" readonly style="background:var(--bg-secondary,#f3f4f6); font-weight:600;"></div>

            <div class="form-group" style="grid-column:span 2;"><label>Cuenta de origen</label>
              <select id="ppCuenta"><option value="">— Sin cuenta —</option></select></div>
            <div class="form-group" style="grid-column:span 2;"><label>Estado</label>
              <select id="ppEstado"><option value="ejecutado">Ejecutado</option><option value="en_proceso">En proceso</option><option value="observado">Observado (no cuenta como pagado)</option></select></div>

            <details class="pp-banco" style="grid-column:span 4;"><summary>Datos de la constancia bancaria (beneficiario, SWIFT, código de operación)</summary>
            <div style="display:grid; grid-template-columns:repeat(4, 1fr); gap:10px; margin-top:10px;">
            <div class="form-group" style="grid-column:span 2;"><label>Beneficiario</label>
              <input type="text" id="ppBenef" maxlength="200"></div>
            <div class="form-group" style="grid-column:span 2;"><label>Banco del beneficiario</label>
              <input type="text" id="ppBancoBenef" maxlength="200"></div>

            <div class="form-group"><label>SWIFT / BIC</label>
              <input type="text" id="ppSwift" maxlength="20" style="text-transform:uppercase;"></div>
            <div class="form-group"><label>Código de operación</label>
              <input type="text" id="ppCodOp" maxlength="60"></div>
            <div class="form-group" style="grid-column:span 2;"><label>UETR (seguimiento SWIFT)</label>
              <input type="text" id="ppUetr" maxlength="60"></div>

            </div></details>

            <div class="form-group" style="grid-column:span 4;"><label>Referencia / observaciones</label>
              <input type="text" id="ppObs" maxlength="300" placeholder="Ej. Anticipo 30% PI NY 2491"></div>
          </div>

          <strong class="mod-sec">Documentos de este pago <span id="ppDocsN" class="pp-docs-n"></span></strong>
          <div id="ppDrop" class="pp-drop" tabindex="0">
            <div class="pp-drop-ico">📎</div>
            <div><strong>Arrastra aquí los documentos del pago</strong> o <label class="pp-drop-link">elígelos<input type="file" id="ppArchivos" multiple hidden data-sin-preview></label>
              <span class="pp-drop-hint">Constancia de transferencia · mensaje SWIFT · correo de confirmación (cualquier archivo, máx. 10 MB c/u; solo PDF e imágenes se previsualizan). También puedes pegar una captura con Ctrl+V.</span></div>
          </div>
          <div id="ppPendientes" class="pp-docs"></div>
          <div style="font-size:0.8rem; color:var(--text-secondary); margin-top:8px;">
            Al guardar, las comisiones pasan al costeo como <strong>gasto financiero</strong> (no inflan el inventario). Este registro no mueve el banco: eso lo hará Tesorería.
          </div>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-primary" id="ppBtnNuevo" onclick="window.ppNuevo()">+ Registrar pago</button>
        <button class="btn btn-primary" id="ppBtnGuardar" style="display:none;" onclick="window.ppGuardar()">💾 Guardar pago</button>
        <button class="btn btn-secondary" id="ppBtnCancelar" style="display:none;" onclick="window.ppCancelarBtn()">Cancelar</button>
        <button class="btn btn-secondary" onclick="window.cerrarPagosProveedor()">Cerrar</button>
      </div>
    </div>
  </div>`)
}

function _pintarResumen() {
  const r = _resumen()
  const mon = r.monedaPI
  if (!_ctx.oc) {
    $('ppResumen').innerHTML = `<div class="info-card" style="padding:10px 14px; border-left:4px solid var(--color-warning,#f59e0b); background:var(--bg-secondary,#f9fafb); border-radius:6px;">
      Esta carpeta no está enlazada a una Proforma (PI). Puedes registrar pagos igual, pero no habrá comparación contra el total pactado.</div>`
    return
  }
  const pct = r.total > 0 ? Math.min(100, (r.pagado / r.total) * 100) : 0
  const tarjeta = (t, val, extra = '') => `<div style="flex:1; min-width:150px; padding:10px 12px; border:1px solid var(--border-color); border-radius:8px;">
      <div style="font-size:0.72rem; text-transform:uppercase; color:var(--text-secondary); letter-spacing:0.03em;">${t}</div>
      <div style="font-size:1.1rem; font-weight:600;">${val}</div>${extra}</div>`
  $('ppResumen').innerHTML = `
    <div style="margin-bottom:6px; font-size:0.9rem;">Proforma <strong>${_esc(_ctx.oc.numero_proforma_proveedor || _ctx.oc.numero)}</strong>
      · ${_esc(_ctx.proveedor?.nombre || 'Proveedor')} · Incoterm ${_esc(_ctx.oc.incoterm || '—')}</div>
    <div style="display:flex; gap:10px; flex-wrap:wrap;">
      ${tarjeta('Total PI', `${mon} ${n2(r.total)}`)}
      ${tarjeta(`Anticipo pactado (${n2(r.pct)}%)`, `${mon} ${n2(r.anticipoEsperado)}`)}
      ${tarjeta('Pagado al proveedor', `${mon} ${n2(r.pagado)}`, `<div style="height:5px; background:var(--border-color); border-radius:3px; margin-top:6px;"><div style="height:5px; width:${pct}%; background:var(--color-success,#16a34a); border-radius:3px;"></div></div>`)}
      ${tarjeta('Por pagar', `${mon} ${n2(r.pendiente)}`)}
      ${tarjeta('Comisiones bancarias', `${mon} ${n2(r.comisiones)}`)}
    </div>
    ${r.mixta ? '<div style="margin-top:6px; font-size:0.8rem; color:var(--color-warning,#b45309);">⚠️ Hay pagos en otra moneda que la PI: no se suman al avance.</div>' : ''}`
}

function _pintarLista() {
  const filas = _ctx.pagos
  if (!filas.length) {
    $('ppLista').innerHTML = '<p style="text-align:center; color:var(--text-secondary); padding:14px;">Todavía no hay pagos registrados en esta carpeta.</p>'
    return
  }
  const badge = e => ({ ejecutado: ['Ejecutado', 'success'], en_proceso: ['En proceso', 'warning'], observado: ['Observado', 'danger'] }[e] || [e, 'info'])
  $('ppLista').innerHTML = `<table class="data-table"><thead><tr>
      <th>Fecha</th><th>Tipo</th><th class="text-right">Monto</th><th class="text-right">Comisiones</th><th class="text-right">Debitado</th>
      <th>Cód. operación</th><th>Estado</th><th>Docs</th><th></th></tr></thead><tbody>${filas.map(p => {
        const [lbl, col] = badge(p.estado)
        return `<tr>
          <td>${fechaDMY(p.fecha)}</td>
          <td>${_esc(TIPOS_PAGO[p.tipo] || p.tipo)}</td>
          <td class="text-right">${p.moneda} ${n2(p.monto_transferido)}</td>
          <td class="text-right">${n2(num(p.comision_transferencia) + num(p.comision_swift))}</td>
          <td class="text-right"><strong>${p.moneda} ${n2(p.monto_total_debitado)}</strong></td>
          <td>${_esc(p.codigo_operacion || '—')}</td>
          <td><span class="badge badge-${col}">${lbl}</span></td>
          <td><button class="btn btn-secondary btn-small" onclick="window.ppVerAdjuntos(${p.id})">📎</button></td>
          <td><button class="btn btn-danger btn-small" onclick="window.ppEliminar(${p.id})" title="Eliminar pago">🗑</button></td>
        </tr>`
      }).join('')}</tbody></table><div id="ppAdjuntosVista" style="font-size:0.85rem; margin-top:6px;"></div>`
}

async function _repintar() {
  _pintarResumen()
  _pintarLista()
}

// ─── Apertura ───────────────────────────────────────────────────────────────
window.abrirPagosProveedor = async function () {
  if (!carpetaActual()) { showToast('Selecciona primero una carpeta', 'warning'); return }
  _asegurarModal()
  await _cargar()
  declararEmpresaModal('modal-pagos-proveedor', _ctx.carpeta?.empresa_id)
  $('ppTitulo').textContent = `Pagos de la carpeta ${_ctx.carpeta?.numero_carpeta || _ctx.carpetaId}`
  delete $('modal-pagos-proveedor').dataset.modo
  window.ppCancelar()
  await _repintar()
  window.openModal('modal-pagos-proveedor')
}


/** Desde la hoja: abre el modal de pago al frente, con el formulario listo y el monto sugerido por la PI. */
window.abrirPagoRapido = async function (tipo = 'anticipo') {
  if (!carpetaActual()) { showToast('Selecciona primero una carpeta', 'warning'); return }
  _asegurarModal()
  await _cargar()
  declararEmpresaModal('modal-pagos-proveedor', _ctx.carpeta?.empresa_id)
  $('ppTitulo').textContent = `${TIPOS_PAGO[tipo] || 'Pago'} · Carpeta ${_ctx.carpeta?.numero_carpeta || _ctx.carpetaId}`
  $('modal-pagos-proveedor').dataset.modo = 'rapido'
  await _repintar()
  window.ppNuevo(tipo)
  window.openModal('modal-pagos-proveedor')
  setTimeout(() => $('ppMonto')?.focus(), 80)
}

window.cerrarPagosProveedor = function () { window.closeModal('modal-pagos-proveedor'); const m = $('modal-pagos-proveedor'); if (m) delete m.dataset.modo; window.renderHojaCosteo?.() }

window.ppNuevo = function (tipoInicial) {
  _archivos = []
  $('ppFormWrap').style.display = ''
  $('ppBtnNuevo').style.display = 'none'
  $('ppBtnGuardar').style.display = ''
  $('ppBtnCancelar').style.display = ''

  const oc = _ctx.oc
  $('ppFecha').value = new Date().toISOString().slice(0, 10)
  $('ppMoneda').value = oc?.currency || 'USD'
  const yaHayAnticipo = _ctx.pagos.some(p => p.tipo === 'anticipo' && p.estado !== 'observado')
  $('ppTipo').value = (typeof tipoInicial === 'string' && TIPOS_PAGO[tipoInicial]) ? tipoInicial : (yaHayAnticipo ? 'saldo' : 'anticipo')
  $('ppMonto').value = ''
  $('ppComTransf').value = '0'; $('ppComSwift').value = '0'
  $('ppEstado').value = 'ejecutado'
  $('ppBenef').value = _ctx.proveedor?.nombre || ''
  ;['ppBancoBenef', 'ppSwift', 'ppCodOp', 'ppUetr', 'ppObs'].forEach(i => { $(i).value = '' })
  _cablearDrop(); _archivos = []; _pintarDocs()
  $('ppTC').dataset.auto = '1'

  const bancos = _ctx.bancos
  $('ppCuenta').innerHTML = '<option value="">— Sin cuenta —</option>' + bancos.map(b =>
    `<option value="${b.id}">${_esc(b.nombre)} — ${_esc(b.numero_cuenta || '')} (${b.moneda || ''})</option>`).join('')

  window.ppSugerirMonto()
  window.ppTCDelDia()
  window.ppRecalcular()
}

window.ppCancelarBtn = function () { if ($('modal-pagos-proveedor')?.dataset.modo === 'rapido') window.cerrarPagosProveedor(); else window.ppCancelar() }

window.ppCancelar = function () {
  _archivos = []
  if ($('ppFormWrap')) $('ppFormWrap').style.display = 'none'
  if ($('ppBtnNuevo')) $('ppBtnNuevo').style.display = ''
  if ($('ppBtnGuardar')) $('ppBtnGuardar').style.display = 'none'
  if ($('ppBtnCancelar')) $('ppBtnCancelar').style.display = 'none'
}

/** Sugiere el monto según el tipo (anticipo = % de la PI; saldo = lo que falta). */
window.ppSugerirMonto = function () {
  const r = _resumen()
  const tipo = v('ppTipo')
  const el = $('ppSugerido'); if (!el) return
  const mon = v('ppMoneda')
  if (!_ctx.oc || mon !== r.monedaPI) { el.textContent = ''; return }
  let sug = 0
  if (tipo === 'anticipo') sug = r.anticipoEsperado
  else if (tipo === 'saldo') sug = Math.max(0, r.pendiente)
  else if (tipo === 'pago_total') sug = Math.max(0, r.pendiente)
  el.textContent = sug > 0 ? `Según la PI: ${mon} ${n2(sug)}` : ''
  if (sug > 0 && !num(v('ppMonto'))) $('ppMonto').value = sug.toFixed(2)
  window.ppRecalcular()
}

window.ppRecalcular = function () {
  const t = num(v('ppMonto')) + num(v('ppComTransf')) + num(v('ppComSwift'))
  if ($('ppTotalDeb')) $('ppTotalDeb').value = `${v('ppMoneda')} ${n2(t)}`
}

window.ppTCDelDia = async function (forzar = false) {
  const campo = $('ppTC'), aviso = $('ppTCAviso')
  if (!campo) return
  if (!forzar && campo.dataset.auto !== '1') return
  if (v('ppMoneda') === 'PEN' && !forzar) { /* igual guardamos el T.C. del día como referencia */ }
  if (aviso) aviso.textContent = 'Buscando…'
  try {
    const r = await getTipoCambioDia(v('ppFecha') || null, { permitirApi: forzar })
    const tc = (r && (r.venta || r.compra || r.tc)) || null
    if (!tc) { if (aviso) aviso.textContent = '— ingrésalo a mano'; return }
    campo.value = parseFloat(tc).toFixed(3); campo.dataset.auto = '1'
    if (aviso) aviso.textContent = `(${(r && r.fecha) || v('ppFecha')})`
  } catch { if (aviso) aviso.textContent = '— ingrésalo a mano' }
}

// ─── Documentos del pago (varios, cada uno con su tipo) ────────────────────
const _TIPOS_DOC_PAGO = ['voucher', 'swift', 'correo', 'contrato', 'otro']
const _adivinarTipo = nombre => {
  const n = String(nombre || '').toLowerCase()
  if (/swift|mt103|gpi|uetr/.test(n)) return 'swift'
  if (/correo|mail|email|outlook|confirm|gmail/.test(n)) return 'correo'
  if (/contrato|contract|sales/.test(n)) return 'contrato'
  if (/voucher|constancia|transf|pago|bcp|operaci/.test(n)) return 'voucher'
  return _archivos.some(a => a.concepto === 'voucher') ? (_archivos.some(a => a.concepto === 'swift') ? 'correo' : 'swift') : 'voucher'
}

function _pintarDocs() {
  const lista = $('ppPendientes'); if (!lista) return
  const n = _archivos.length
  if ($('ppDocsN')) $('ppDocsN').textContent = n ? `· ${n}` : ''
  lista.innerHTML = _archivos.map((a, i) => {
    const opts = _TIPOS_DOC_PAGO.map(k => `<option value="${k}"${a.concepto === k ? ' selected' : ''}>${_esc(ADJ_CONCEPTOS[k] || k)}</option>`).join('')
    return `<div class="pp-doc">
      <div class="pp-doc-vista">${miniaturaArchivoHTML(`ppThumb${i}`)}</div>
      <div class="pp-doc-info"><div class="pp-doc-nombre" title="${_esc(a.file.name)}">${_esc(a.file.name)}</div>
        <div class="pp-doc-peso">${formatNumber(a.file.size / 1024, 0)} KB</div></div>
      <select onchange="window.ppTipoDoc(${i}, this.value)" aria-label="Tipo de documento">${opts}</select>
      <button type="button" class="pp-doc-x" onclick="window.ppQuitarDoc(${i})" title="Quitar">✕</button></div>`
  }).join('')
  _archivos.forEach((a, i) => pintarMiniaturaArchivo($(`ppThumb${i}`), a.file))
}

function _agregarDocs(files) {
  const errores = []
  for (const f of files || []) {
    const err = validarArchivoAdjunto(f)
    if (err) { errores.push(err); continue }
    if (_archivos.some(a => a.file.name === f.name && a.file.size === f.size)) continue
    _archivos.push({ file: f, concepto: _adivinarTipo(f.name) })
  }
  _pintarDocs()
  if (errores.length) showToast(errores[0], 'warning')
}

window.ppTipoDoc = (i, t) => { if (_archivos[i]) _archivos[i].concepto = t }
window.ppQuitarDoc = i => { _archivos.splice(i, 1); _pintarDocs() }

function _cablearDrop() {
  const z = $('ppDrop'); if (!z || z.dataset.listo) return
  z.dataset.listo = '1'
  $('ppArchivos').addEventListener('change', e => { _agregarDocs([...e.target.files]); e.target.value = '' })
  ;['dragenter', 'dragover'].forEach(ev => z.addEventListener(ev, e => { e.preventDefault(); z.classList.add('sobre') }))
  ;['dragleave', 'drop'].forEach(ev => z.addEventListener(ev, e => { e.preventDefault(); z.classList.remove('sobre') }))
  z.addEventListener('drop', e => _agregarDocs([...(e.dataTransfer?.files || [])]))
  // Pegar capturas / archivos con Ctrl+V mientras el modal de pagos está abierto
  document.addEventListener('paste', e => {
    if (!$('modal-pagos-proveedor')?.classList.contains('show') || $('ppFormWrap')?.style.display === 'none') return
    const fs = [...(e.clipboardData?.files || [])]
    if (fs.length) { e.preventDefault(); _agregarDocs(fs) }
  })
}

// ─── Guardar ────────────────────────────────────────────────────────────────
window.ppGuardar = async function () {
  const btn = $('ppBtnGuardar')
  try {
    const monto = num(v('ppMonto'))
    if (!v('ppFecha')) throw new Error('Falta la fecha de la operación')
    if (monto <= 0) throw new Error('El monto transferido debe ser mayor a 0')
    if (num(v('ppTC')) <= 0) throw new Error('Falta el tipo de cambio')
    const cod = v('ppCodOp')
    if (cod && _ctx.pagos.some(p => p.codigo_operacion === cod)) throw new Error(`El código de operación ${cod} ya está registrado en esta carpeta`)

    const tipo = v('ppTipo')
    const r = _resumen()
    if (_ctx.oc && TIPOS_AL_PROVEEDOR.includes(tipo) && v('ppMoneda') === r.monedaPI && v('ppEstado') !== 'observado') {
      if (monto > r.pendiente + 0.005 &&
          !confirm(`Este pago (${n2(monto)}) supera lo que falta pagar de la PI (${r.monedaPI} ${n2(r.pendiente)}).\n\n¿Registrarlo igual?`)) return
    }

    btn.disabled = true; btn.textContent = 'Guardando…'
    const user = await getCurrentUser()
    const fila = {
      carpeta_importacion_id: _ctx.carpetaId,
      orden_compra_id: _ctx.oc?.id || null,
      tipo, fecha: v('ppFecha'), moneda: v('ppMoneda'), tipo_cambio: num(v('ppTC')),
      monto_transferido: monto,
      comision_transferencia: num(v('ppComTransf')),
      comision_swift: num(v('ppComSwift')),
      cuenta_origen_id: v('ppCuenta') ? parseInt(v('ppCuenta')) : null,
      beneficiario: v('ppBenef') || null,
      banco_beneficiario: v('ppBancoBenef') || null,
      swift_bic: v('ppSwift').toUpperCase() || null,
      referencia: v('ppObs') || null,
      codigo_operacion: cod || null,
      uetr: v('ppUetr') || null,
      estado: v('ppEstado'),
      created_by: user?.db_id || null
    }
    const guardado = await insert('importacion_pagos', fila)
    if (!guardado?.id) {
      const msg = ultimoErrorInsert()?.message || ultimoErrorInsert()?.mensaje || ''
      if (/importacion_pagos|relation|does not exist/i.test(msg)) throw new Error('Falta correr assets/sql/94_importacion_pagos_e_incoterm.sql')
      throw new Error(msg || 'No se pudo registrar el pago (¿la carpeta está cerrada?)')
    }

    const avisos = []
    // Comisiones → ledger (gasto financiero)
    for (const [monto_c, etiqueta] of [[fila.comision_transferencia, 'Comisión de transferencia'], [fila.comision_swift, 'Comisión SWIFT']]) {
      if (monto_c <= 0) continue
      try {
        await crearLineaCosto({
          tipo: 'voucher_bancario', tipo_comprobante: null, serie: null, numero: null,
          proveedor_id: null, fecha_emision: fila.fecha, moneda: fila.moneda, tipo_cambio: fila.tipo_cambio,
          monto_sin_igv: monto_c, igv_monto: 0, monto_total: monto_c,
          estado_pago: 'pagado', es_provisional: false, sustentado: true,
          empresa_id: _ctx.carpeta?.empresa_id ?? undefined
        }, {
          carpeta_importacion_id: _ctx.carpetaId, grupo: 'financiero',
          concepto: `${etiqueta} — ${TIPOS_PAGO[tipo] || tipo}`, concepto_codigo: 'comision_bancaria',
          clasificacion: 'gasto_financiero', entra_costo_contable: false, entra_costo_gestion: true,
          moneda: fila.moneda, tipo_cambio: fila.tipo_cambio, monto_moneda: monto_c, igv_monto: 0,
          base_prorrateo: 'valor_fob', es_provisional: false, observaciones: MARCA_COMISION(guardado.id)
        }, user?.db_id)
      } catch (e) {
        console.error('Comisión al ledger:', e)
        avisos.push(`${etiqueta} no pasó al costeo (${e.message}); regístrala en Costos.`)
      }
    }

    if (_archivos.length) {
      const res = await subirAdjuntos('importacion_pago', guardado.id, _archivos, user?.db_id)
      if (res?.errores?.length) avisos.push(`${res.ok} adjunto(s) subidos. ${res.errores[0]}${_archivos.some(a => a.concepto === 'correo') ? ' (si es el tipo «Correo», corre assets/sql/102_adjuntos_concepto_correo.sql)' : ''}`)
    }

    showToast(avisos.length ? `Pago registrado. ${avisos[0]}` : 'Pago registrado', avisos.length ? 'warning' : 'success')
    await _cargar(); window.ppCancelar(); await _repintar()
    if (typeof window.renderCostosLedger === 'function') window.renderCostosLedger()
    if ($('modal-pagos-proveedor')?.dataset.modo === 'rapido') window.cerrarPagosProveedor(); else window.renderHojaCosteo?.()
  } catch (e) {
    console.error('ppGuardar:', e)
    showToast(e.message || 'No se pudo guardar el pago', 'danger')
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '💾 Guardar pago' }
  }
}

// ─── Adjuntos / eliminar ────────────────────────────────────────────────────
window.ppVerAdjuntos = async function (id) {
  const box = $('ppAdjuntosVista'); if (!box) return
  const adjs = await getAdjuntos('importacion_pago', id)
  if (!adjs.length) { box.innerHTML = 'Este pago no tiene documentos adjuntos.'; return }
  box.innerHTML = `<div class="pp-guardados">${adjs.map(a => `<div class="pp-guardado">
      <span class="adj-thumb" data-adj-path="${_esc(a.path)}" data-adj-nombre="${_esc(a.nombre)}">…</span>
      <div><div class="pp-doc-nombre" title="${_esc(a.nombre)}">${_esc(a.nombre)}</div><div class="pp-doc-peso">${_esc(ADJ_CONCEPTOS[a.concepto] || a.concepto)}</div></div></div>`).join('')}</div>`
}

window.ppEliminar = async function (id) {
  const p = _ctx.pagos.find(x => x.id === id); if (!p) return
  if (!confirm(`¿Eliminar el pago de ${p.moneda} ${n2(p.monto_transferido)} del ${fechaDMY(p.fecha)}?\n\nSe quitan también sus comisiones del costeo y sus documentos.`)) return
  try {
    const lineas = ((await query('importacion_costos', { carpeta_importacion_id: _ctx.carpetaId })) || [])
      .filter(l => l.observaciones === MARCA_COMISION(id))
    for (const l of lineas) await deleteRecord('importacion_costos', l.id)
    await eliminarAdjuntosDe('importacion_pago', id)
    const ok = await deleteRecord('importacion_pagos', id)
    if (!ok) throw new Error('No se pudo eliminar (¿la carpeta está cerrada?)')
    showToast('Pago eliminado', 'success')
    await _cargar(); await _repintar(); window.renderHojaCosteo?.()
    if (typeof window.renderCostosLedger === 'function') window.renderCostosLedger()
  } catch (e) { showToast(e.message || 'No se pudo eliminar', 'danger') }
}

export default { abrirPagosProveedor: window.abrirPagosProveedor, TIPOS_PAGO }
