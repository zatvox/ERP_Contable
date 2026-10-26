// ============================================================================
// CARPETA-NUEVA.JS — Abrir una carpeta de importación desde 3 orígenes
// ============================================================================
// El modal viejo exigía una OC confirmada MÁS el Commercial Invoice, la
// Proforma y el producto principal. Eso hacía imposible el caso real:
//   · la compra directa (sin OC) es lo común con proveedores de confianza
//   · la carpeta nace en la etapa 1, cuando todavía no existe ningún CI
//
// Ahora la carpeta se abre desde:
//   1. UNA COMPRA YA REGISTRADA → hereda proveedor, fecha, moneda, T.C. y
//      crea el Commercial Invoice con las líneas de detalle_compras.
//   2. UNA OC-PROFORMA → hereda los datos del embarque (incoterm, puertos,
//      anticipo). La carpeta queda en etapa 1, sin CI: eso llega después.
//   3. DESDE CERO → solo la carpeta, para cargar todo a mano.
//
// Regla del incoterm: con CIF/CFR/DAP el precio del proveedor ya incluye el
// flete, así que el costeo NO debe volver a cargarlo. El modal lo avisa al
// crear y el ledger lo bloquea después.
// ============================================================================

import { supabase, insert, update, query, ultimoErrorInsert, esperarContextoEmpresa } from '../supabase-client.js'
import { getCurrentUser } from '../auth-supabase.js'
import { showToast, formatNumber, fechaDMY } from '../helpers.js'
import { getContacts, getCompraDetalles, getItems } from '../supabase-data.js'

const n2 = v => formatNumber(parseFloat(v) || 0, 2)
const n6 = v => formatNumber(parseFloat(v) || 0, 6)
const num = v => parseFloat(v) || 0

const INCOTERMS = ['FOB', 'CFR', 'CIF', 'CIP', 'CPT', 'FCA', 'FAS', 'EXW', 'DAP', 'DDP']
const INCOTERMS_CON_FLETE = ['CIF', 'CFR', 'CIP', 'CPT', 'DAP', 'DDP']
export const incluyeFlete = i => INCOTERMS_CON_FLETE.includes(String(i || '').toUpperCase())

let _origen = 'oc'
let _compraPI = null      // compra ya registrada que respalda la PI elegida (caso carpetas históricas)
let _compras = []
let _ocs = []
let _contactos = []
let _seleccion = null      // la compra o la OC elegida
let _lineas = []           // vista previa de las líneas

// ─────────────────────────────────────────────────────────────────────────────
// DATOS
// ─────────────────────────────────────────────────────────────────────────────
/** Compras de importación que todavía no tienen carpeta (sin DUAs). */
export async function getComprasSinCarpeta() {
  const { data, error } = await supabase.from('v_compras_importacion')
    .select('*').is('carpeta_importacion_id', null).order('fecha_emision', { ascending: false })
  if (error) {
    console.warn('getComprasSinCarpeta:', error.message)
    return { falta_sql: /does not exist|relation/i.test(error.message), filas: [] }
  }
  return { filas: (data || []).filter(c => !c.senal_dua) }
}

/** OC marcadas como importación que todavía no abrieron carpeta. */
export async function getOCsImportacion() {
  const filas = (await query('orden_compra', { es_importacion: true })) || []
  return filas.filter(o => !o.carpeta_importacion_id)
}

/** Siguiente número de carpeta sugerido, respetando el formato ya usado. */
export async function sugerirNumeroCarpeta() {
  const carpetas = (await query('carpetas_importacion', {})) || []
  let max = 0
  for (const c of carpetas) {
    const m = String(c.numero_carpeta || '').match(/(\d+)\s*$/)
    if (m) max = Math.max(max, parseInt(m[1]))
  }
  return { siguiente: max + 1, total: carpetas.length }
}

// ─────────────────────────────────────────────────────────────────────────────
// MODAL
// ─────────────────────────────────────────────────────────────────────────────
function _asegurarModal() {
  if (document.getElementById('modal-nueva-carpeta')) return
  const html = `
  <div id="modal-nueva-carpeta" class="modal">
    <div class="modal-content" style="width:min(96vw, 1100px); max-width:min(96vw, 1100px); max-height:calc(100vh - 48px); overflow-y:auto;">
      <div class="modal-header">
        <h3 class="modal-title">Nueva carpeta de importación</h3>
        <button class="modal-close" onclick="window.cerrarModalNuevaCarpeta()">&times;</button>
      </div>

      <div style="padding:16px 20px 0;">
        <strong style="display:block; margin-bottom:4px; color:var(--text-secondary); font-size:0.85rem; text-transform:uppercase; letter-spacing:0.03em;">¿De dónde nace la carpeta?</strong>
        <small style="display:block; margin-bottom:10px; color:var(--text-secondary); line-height:1.4;">
          La carpeta es el expediente de la importación. Lo normal es que nazca de una <strong>Proforma (PI)</strong> confirmada; si la PI ya tiene su compra registrada, el Commercial Invoice se arma con esa compra.
        </small>
        <div id="cnOrigenChips" style="display:flex; flex-wrap:wrap; gap:6px; margin-bottom:14px;">
          <button type="button" class="reporte-chip on" data-origen="oc" onclick="window.cnOrigen('oc')">Desde una Proforma (PI)</button>
          <button type="button" class="reporte-chip" data-origen="compra" onclick="window.cnOrigen('compra')">Desde una compra (sin PI)</button>
          <button type="button" class="reporte-chip" data-origen="cero" onclick="window.cnOrigen('cero')">Desde cero</button>
        </div>

        <div class="form-group" id="cnGrupoSelector">
          <label id="cnSelectorLabel">Compra de importación</label>
          <select id="cnSelector" onchange="window.cnSeleccionar()">
            <option value="">-- Selecciona --</option>
          </select>
          <small id="cnSelectorAviso" style="color:var(--text-secondary);"></small>
        </div>

        <div id="cnPreview"></div>

        <hr style="border:none; border-top:1px solid var(--border-color); margin:14px 0;">
        <strong style="display:block; margin-bottom:8px; color:var(--text-secondary); font-size:0.85rem; text-transform:uppercase; letter-spacing:0.03em;">Datos de la carpeta</strong>
        <div style="display:grid; grid-template-columns:1fr 1.6fr 1fr 0.8fr; gap:10px;">
          <div class="form-group">
            <label>N° de carpeta *</label>
            <input type="text" id="cnNumero" placeholder="15">
            <small id="cnNumeroAviso" style="color:var(--text-secondary);"></small>
          </div>
          <div class="form-group">
            <label>Proveedor *</label>
            <select id="cnProveedor"><option value="">-- Selecciona --</option></select>
          </div>
          <div class="form-group">
            <label>Fecha de apertura *</label>
            <input type="date" id="cnFecha">
          </div>
          <div class="form-group">
            <label>Moneda</label>
            <select id="cnMoneda">
              <option value="USD">USD</option>
              <option value="PEN">PEN</option>
            </select>
          </div>
        </div>
        <div style="display:grid; grid-template-columns:1fr 3fr; gap:10px;">
          <div class="form-group">
            <label>Incoterm</label>
            <select id="cnIncoterm" onchange="window.cnIncotermCambio()">
              <option value="">— Elegir —</option>
              ${INCOTERMS.map(i => `<option value="${i}">${i}</option>`).join('')}
            </select>
          </div>
          <div id="cnIncotermAviso" style="align-self:center;"></div>
        </div>
        <div id="cnDesglose" style="display:none; margin-bottom:10px;">
          <div style="display:grid; grid-template-columns:1fr 1fr 1fr; gap:10px;">
            <div class="form-group"><label>Flete incluido en el precio <span style="font-weight:400; color:var(--text-secondary);">(opcional)</span></label>
              <input type="number" step="0.01" min="0" id="cnFleteIncl" oninput="window.cnDesgloseCalc()"></div>
            <div class="form-group"><label>Seguro incluido <span style="font-weight:400; color:var(--text-secondary);">(opcional)</span></label>
              <input type="number" step="0.01" min="0" id="cnSeguroIncl" oninput="window.cnDesgloseCalc()"></div>
            <div class="form-group"><label>Valor FOB resultante</label>
              <input type="text" id="cnFobCalc" readonly style="background:var(--bg-secondary,#f3f4f6);"></div>
          </div>
          <small style="color:var(--text-secondary);">Es solo el desglose del precio CIF (FOB = total − flete − seguro). No es costo adicional. Si el CI aún no lo detalla, déjalo en blanco y complétalo en la pestaña 1 · Commercial Invoice.</small>
        </div>
        <div class="form-group">
          <label>Descripción</label>
          <input type="text" id="cnDescripcion" placeholder="Ej: 150/48 RW NIM — 2 contenedores">
        </div>
      </div>

      <div class="modal-footer">
        <button class="btn btn-secondary" onclick="window.cerrarModalNuevaCarpeta()">Cancelar</button>
        <button class="btn btn-primary" id="cnBtnCrear" onclick="window.crearCarpetaImportacion()">&#128193; Crear carpeta</button>
      </div>
    </div>
  </div>`
  document.body.insertAdjacentHTML('beforeend', html)
}

function _aviso(titulo, detalle = '', color = 'warning') {
  return `
    <div style="padding:12px 14px; background:var(--bg-secondary); border-radius:var(--radius-md);
                border-left:3px solid var(--color-${color}); font-size:0.88rem; line-height:1.6; margin-top:10px;">
      <strong>${titulo}</strong>
      ${detalle ? `<div style="color:var(--text-secondary); margin-top:4px;">${detalle}</div>` : ''}
    </div>`
}

window.cnOrigen = async function (origen) {
  _origen = origen
  _seleccion = null
  _lineas = []
  _compraPI = null
  document.querySelectorAll('#cnOrigenChips .reporte-chip').forEach(b =>
    b.classList.toggle('on', b.dataset.origen === origen))
  document.getElementById('cnPreview').innerHTML = ''
  const grupo = document.getElementById('cnGrupoSelector')
  if (grupo) grupo.style.display = origen === 'cero' ? 'none' : ''
  await _llenarSelector()
}

async function _llenarSelector() {
  const sel = document.getElementById('cnSelector')
  const lbl = document.getElementById('cnSelectorLabel')
  const aviso = document.getElementById('cnSelectorAviso')
  if (!sel) return

  if (_origen === 'cero') { if (aviso) aviso.textContent = ''; return }

  if (_origen === 'compra') {
    if (lbl) lbl.textContent = 'Compra de importación'
    const r = await getComprasSinCarpeta()
    if (r.falta_sql) {
      sel.innerHTML = '<option value="">(falta correr el SQL 93)</option>'
      if (aviso) aviso.innerHTML = 'Corre <code>assets/sql/93_proveedor_no_domiciliado_y_campos_pi.sql</code>: es el que reconoce qué compras son de importación.'
      return
    }
    _compras = r.filas
    sel.innerHTML = '<option value="">-- Selecciona --</option>' + _compras.map(c =>
      `<option value="${c.id}">${c.documento || c.referencia} · ${c.proveedor_nombre} · ${c.currency} ${n2(c.total)} · ${fechaDMY(c.fecha_emision)}</option>`).join('')
    if (aviso) aviso.textContent = _compras.length
      ? `${_compras.length} compra(s) de proveedor del exterior sin carpeta. Las DUAs no aparecen: no abren carpeta.`
      : 'No hay compras de importación sin carpeta.'
  } else {
    if (lbl) lbl.textContent = 'Proforma Invoice (PI) sin carpeta'
    _ocs = await getOCsImportacion()
    sel.innerHTML = '<option value="">-- Selecciona --</option>' + _ocs.map(o =>
      `<option value="${o.id}">${o.numero_proforma_proveedor ? 'PI ' + o.numero_proforma_proveedor : o.numero} · ${o.currency} ${n2(o.total_oc)} · ${fechaDMY(o.fecha)}${o.status === 'confirmado' ? '' : ' · ⚠ ' + (o.status || 'borrador')}</option>`).join('')
    if (aviso) aviso.textContent = _ocs.length
      ? `${_ocs.length} Proforma(s) sin carpeta. Las marcadas ⚠ aún no están confirmadas.`
      : 'No hay Proformas pendientes. Créala en Compras → Órdenes de Compra marcando "Es importación", o genérala desde una compra ya registrada (Compras → ⋮ → Generar Proforma).'
  }
}

window.cnSeleccionar = async function () {
  const id = parseInt(document.getElementById('cnSelector')?.value || 0)
  const prev = document.getElementById('cnPreview')
  _seleccion = null; _lineas = []
  if (!id) { if (prev) prev.innerHTML = ''; return }

  const set = (campo, v) => { const e = document.getElementById(campo); if (e && v != null) e.value = v }

  if (_origen === 'compra') {
    const c = _compras.find(x => x.id === id)
    if (!c) return
    _seleccion = c
    set('cnProveedor', c.contact_id)
    set('cnFecha', c.fecha_emision)
    set('cnMoneda', c.currency || 'USD')
    set('cnDescripcion', `Importación ${c.documento || c.referencia} — ${c.proveedor_nombre}`)
    set('cnIncoterm', '')

    _lineas = await _lineasDeCompra(id)

    const totalLineas = _lineas.reduce((t, l) => t + l.costo_total, 0)
    const dif = Math.abs(totalLineas - num(c.subtotal))
    if (prev) prev.innerHTML = `
      ${_aviso(`Se creará la carpeta + el Commercial Invoice con ${_lineas.length} línea(s)`,
        `Proveedor ${c.proveedor_nombre}${c.proveedor_pais ? ' · ' + c.proveedor_pais : ''} · ${c.currency} ${n2(c.total)}. La compra queda enlazada a la carpeta.`, 'info')}
      ${_tablaLineas()}
      ${dif > 0.01 ? _aviso('El detalle no suma el subtotal de la compra',
        `Líneas: ${n2(totalLineas)} · subtotal de la compra: ${n2(c.subtotal)}. Revisa el detalle antes de costear.`) : ''}
      ${_avisoIncotermCompra(c)}`
  } else {
    const o = _ocs.find(x => x.id === id)
    if (!o) return
    _seleccion = o
    set('cnProveedor', o.contact_id)
    set('cnFecha', o.fecha)
    set('cnMoneda', o.currency || 'USD')
    set('cnDescripcion', `Importación PI ${o.numero_proforma_proveedor || o.numero}`)
    set('cnIncoterm', o.incoterm || '')

    // ¿La PI ya tiene su compra registrada? (carpetas históricas: la compra ES el CI)
    _compraPI = null
    const { data: compraPI } = await supabase.from('v_compras_importacion')
      .select('*').eq('orden_compra_id', id).is('carpeta_importacion_id', null).limit(1)
    if (compraPI && compraPI.length) {
      _compraPI = compraPI[0]
      _lineas = await _lineasDeCompra(_compraPI.id)
    }

    const anticipo = num(o.total_oc) * num(o.anticipo_porcentaje) / 100
    if (prev) prev.innerHTML = (o.status === 'confirmado' ? '' : _aviso(`Esta Proforma está en estado "${o.status || 'borrador'}"`,
        'Lo normal es confirmarla antes de abrir la carpeta (Compras → Órdenes de Compra → Confirmar Proforma). Si sigues, se te pedirá confirmación.')) +
      (_compraPI
        ? _aviso(`Esta PI ya tiene su compra registrada (${_compraPI.documento || _compraPI.referencia})`,
            `Se creará la carpeta + el Commercial Invoice con ${_lineas.length} línea(s) de esa compra, y la compra queda enlazada a la carpeta.`, 'info') + _tablaLineas()
        : '') +
      (_compraPI ? '' : _aviso(
      `Se creará la carpeta en etapa 1, sin Commercial Invoice`,
      `${o.incoterm || '—'}${o.puerto_embarque ? ' · ' + o.puerto_embarque : ''}${o.puerto_destino ? ' → ' + o.puerto_destino : ''} · total ${o.currency} ${n2(o.total_oc)}` +
      (anticipo ? ` · anticipo ${n2(o.anticipo_porcentaje)}% = ${o.currency} ${n2(anticipo)}` : '') +
      `. El CI llega en la etapa 2, cuando embarque.`, 'info'))
  }
  window.cnIncotermCambio()
}

/** Total de las líneas de la compra que alimenta el CI (0 si no hay compra). */
const _totalCI = () => _lineas.reduce((t, l) => t + l.costo_total, 0)

window.cnDesgloseCalc = function () {
  const f = num(document.getElementById('cnFleteIncl')?.value)
  const sg = num(document.getElementById('cnSeguroIncl')?.value)
  const out = document.getElementById('cnFobCalc'); if (!out) return
  out.value = _totalCI() > 0 ? n2(_totalCI() - f - sg) : ''
  out.style.color = (f + sg) >= _totalCI() && (f + sg) > 0 ? 'var(--color-danger)' : ''
}

window.cnIncotermCambio = function () {
  const i = document.getElementById('cnIncoterm')?.value || ''
  const des = document.getElementById('cnDesglose')
  if (des) { des.style.display = (i && incluyeFlete(i) && _lineas.length) ? '' : 'none'; window.cnDesgloseCalc() }
  const box = document.getElementById('cnIncotermAviso'); if (!box) return
  box.innerHTML = !i ? '<small style="color:var(--text-secondary);">Sin incoterm no se puede validar si el flete ya viene en el precio.</small>'
    : incluyeFlete(i)
      ? `<small style="color:var(--color-warning,#b45309);">${i}: el precio YA incluye flete y seguro — el costeo no debe cargarlos aparte (se contarían dos veces).</small>`
      : `<small style="color:var(--text-secondary);">${i}: el flete y el seguro internacional van como líneas del ledger.</small>`
}

/** Líneas de una compra, en el formato del Commercial Invoice. */
async function _lineasDeCompra(compraId) {
  const detalles = (await getCompraDetalles(compraId)) || []
  const items = await getItems()
  const mapa = {}; for (const i of items || []) mapa[i.id] = i
  return detalles.map(d => ({
    product_id: d.item_id,
    nombre: mapa[d.item_id] ? (mapa[d.item_id].sku ? `(${mapa[d.item_id].sku}) ${mapa[d.item_id].nombre}` : mapa[d.item_id].nombre) : (d.descripcion || `Item #${d.item_id}`),
    cantidad_neto: num(d.cantidad),
    cantidad_gross: num(d.cantidad),
    cantidad_unid: 0,
    costo_unitario: num(d.precio_unitario),
    costo_total: num(d.subtotal) || num(d.cantidad) * num(d.precio_unitario)
  }))
}

function _avisoIncotermCompra(c) {
  // Sin incoterm registrado no se puede saber si el importe ya trae el flete.
  return _aviso('Confirma el incoterm de esta compra',
    'Si el proveedor factura CIF/CFR, el importe YA incluye flete y seguro y no hay que volver a cargarlos en el costeo. ' +
    'Si es FOB, el flete y el seguro van como líneas del ledger. Lo defines al registrar los costos.', 'info')
}

function _tablaLineas() {
  if (!_lineas.length) return ''
  const total = _lineas.reduce((t, l) => t + l.costo_total, 0)
  const kg = _lineas.reduce((t, l) => t + l.cantidad_neto, 0)
  return `
    <div class="table-container" style="margin-top:10px; max-height:240px; overflow-y:auto;">
      <table class="table">
        <thead><tr><th>Producto</th><th style="text-align:right">Cantidad</th><th style="text-align:right">Costo unit.</th><th style="text-align:right">Total</th></tr></thead>
        <tbody>
          ${_lineas.map(l => `<tr>
            <td>${l.nombre}</td>
            <td style="text-align:right">${n2(l.cantidad_neto)}</td>
            <td style="text-align:right">${n6(l.costo_unitario)}</td>
            <td style="text-align:right">${n2(l.costo_total)}</td>
          </tr>`).join('')}
        </tbody>
        <tfoot><tr style="font-weight:700; background:var(--bg-secondary);">
          <td>TOTAL</td><td style="text-align:right">${n2(kg)}</td><td></td><td style="text-align:right">${n2(total)}</td>
        </tr></tfoot>
      </table>
    </div>`
}

window.abrirModalNuevaCarpeta = async function () {
  await esperarContextoEmpresa()
  _asegurarModal()
  _seleccion = null; _lineas = []; _compraPI = null

  if (!_contactos.length) _contactos = (await getContacts()) || []
  const prov = document.getElementById('cnProveedor')
  if (prov) {
    prov.innerHTML = '<option value="">-- Selecciona --</option>' +
      _contactos.map(c => `<option value="${c.id}">${c.nombre}${c.pais && c.pais !== 'Perú' ? ' · ' + c.pais : ''}</option>`).join('')
  }

  const { siguiente, total } = await sugerirNumeroCarpeta()
  const numero = document.getElementById('cnNumero')
  if (numero) numero.value = String(siguiente)
  const av = document.getElementById('cnNumeroAviso')
  if (av) av.textContent = `${total} carpeta(s) registradas. Puedes cambiar el número.`

  const f = document.getElementById('cnFecha')
  if (f) f.value = new Date().toISOString().slice(0, 10)
  document.getElementById('cnDescripcion').value = ''
  document.getElementById('cnPreview').innerHTML = ''

  await window.cnOrigen(_origen)
  window.openModal('modal-nueva-carpeta')
}

window.cerrarModalNuevaCarpeta = function () {
  window.closeModal('modal-nueva-carpeta')
  _seleccion = null; _lineas = []
}

// ─────────────────────────────────────────────────────────────────────────────
// CREAR
// ─────────────────────────────────────────────────────────────────────────────
window.crearCarpetaImportacion = async function () {
  const btn = document.getElementById('cnBtnCrear')
  try {
    const v = id => { const e = document.getElementById(id); return e && e.value ? String(e.value).trim() : '' }
    const numero = v('cnNumero')
    const proveedorId = v('cnProveedor') ? parseInt(v('cnProveedor')) : null
    const fecha = v('cnFecha')

    if (!numero) throw new Error('Falta el número de carpeta')
    if (!proveedorId) throw new Error('Elige el proveedor')
    if (!fecha) throw new Error('Falta la fecha de apertura')
    if (_origen !== 'cero' && !_seleccion) throw new Error('Elige la Proforma o la compra de origen')
    if (_origen === 'oc' && _seleccion.status !== 'confirmado' &&
        !confirm(`La Proforma está en estado "${_seleccion.status || 'borrador'}".\n\n¿Abrir la carpeta igual?`)) return

    const repetidas = (await query('carpetas_importacion', { numero_carpeta: numero })) || []
    if (repetidas.length) throw new Error(`Ya existe una carpeta con el número "${numero}"`)

    btn.disabled = true; btn.textContent = 'Creando…'
    const user = await getCurrentUser()

    // Compra que alimenta el Commercial Invoice: la elegida, o la que ya respalda la PI.
    const compraBase = _origen === 'compra' ? _seleccion : (_origen === 'oc' ? _compraPI : null)
    const incoterm = v('cnIncoterm') || null
    // Desglose del precio CIF (solo si hay CI y el incoterm ya incluye flete)
    const conDesglose = !!(compraBase && incoterm && incluyeFlete(incoterm))
    const fleteIncl = conDesglose ? num(v('cnFleteIncl')) : 0
    const seguroIncl = conDesglose ? num(v('cnSeguroIncl')) : 0
    if (fleteIncl < 0 || seguroIncl < 0) throw new Error('Flete y seguro no pueden ser negativos')
    if (conDesglose && (fleteIncl + seguroIncl) >= _totalCI() && (fleteIncl + seguroIncl) > 0)
      throw new Error('Flete + seguro no pueden igualar o superar el total del CI: el FOB saldría en cero o negativo')

    const carpeta = {
      numero_carpeta: numero,
      descripcion: v('cnDescripcion') || null,
      proveedor_id: proveedorId,
      fecha_apertura: fecha,
      moneda_costeo: v('cnMoneda') || 'USD',
      estado: 'abierta',
      origen: _origen === 'cero' ? 'manual' : (_origen === 'oc' ? 'orden_compra' : 'compra'),
      compra_origen_id: compraBase ? compraBase.id : null,
      incoterm,
      orden_compra_id: _origen === 'oc' ? _seleccion.id : null,
      created_by: user?.db_id
    }

    if (_origen === 'compra') {
      carpeta.fob_total_usd = num(_seleccion.subtotal)
      carpeta.cif_total_usd = num(_seleccion.subtotal)
      carpeta.tipo_cambio = num(_seleccion.tipo_cambio) || 3.75
    } else if (_origen === 'oc') {
      if (compraBase) carpeta.tipo_cambio = num(compraBase.tipo_cambio) || undefined
      carpeta.fob_total_usd = num(_seleccion.total_oc)
      carpeta.flete_usd = num(_seleccion.flete_estimado)
      carpeta.seguro_usd = num(_seleccion.seguro_estimado)
      carpeta.cif_total_usd = num(_seleccion.total_oc) + num(_seleccion.flete_estimado) + num(_seleccion.seguro_estimado)
    }

    let filaCarpeta = await insert('carpetas_importacion', carpeta)
    // Sin el SQL 94 la columna incoterm no existe: se reintenta sin ella.
    if (!filaCarpeta?.id && /incoterm/i.test(ultimoErrorInsert()?.mensaje || ultimoErrorInsert()?.message || '')) {
      const { incoterm: _omit, ...sinIncoterm } = carpeta
      filaCarpeta = await insert('carpetas_importacion', sinIncoterm)
      if (filaCarpeta?.id) showToast('Carpeta creada sin incoterm: corre assets/sql/94 y edítalo.', 'warning')
    }
    if (!filaCarpeta?.id) throw new Error(ultimoErrorInsert()?.mensaje || ultimoErrorInsert()?.message || 'No se pudo crear la carpeta')
    const carpetaId = filaCarpeta.id

    // ── Con compra (directa o respaldando la PI): crear el Commercial Invoice ──
    if (compraBase) {
      const ci = await insert('comercial_invoices', {
        contact_id: proveedorId,
        invoice_number: compraBase.documento || compraBase.referencia,
        fecha: compraBase.fecha_emision || fecha,   // la fecha del CI es la de la compra, no la de apertura
        product: v('cnDescripcion') || null,
        terminos_delivery: incoterm || 'FOB',
        // Con origen PI, el CI hereda lo que ya dice la Proforma
        ...(_origen === 'oc' ? {
          proforma_number: _seleccion.numero_proforma_proveedor || null,
          puerto_embarque: _seleccion.puerto_embarque || null,
          pais_origen: _seleccion.pais_origen || null,
          terminos_payment: _seleccion.anticipo_porcentaje != null
            ? `${num(_seleccion.anticipo_porcentaje)}% advance - ${parseFloat((100 - num(_seleccion.anticipo_porcentaje)).toFixed(2))}% ${_seleccion.dias_saldo_desde_bl != null ? 'within ' + _seleccion.dias_saldo_desde_bl + ' days from B/L date' : 'balance'}`
            : null
        } : {}),
        total_unidades: _lineas.reduce((t, l) => t + (l.cantidad_unid || 0), 0),
        cantidad_total_neto: _lineas.reduce((t, l) => t + l.cantidad_neto, 0),
        cantidad_total_gross: _lineas.reduce((t, l) => t + l.cantidad_gross, 0),
        valor_total_final_ci: _lineas.reduce((t, l) => t + l.costo_total, 0),
        // FOB = total − flete − seguro (con CIF/CFR/...); en FOB/EXW coincide con el total
        costo_flete: fleteIncl,
        costo_seguro: seguroIncl,
        valor_total_final_fob: parseFloat((_lineas.reduce((t, l) => t + l.costo_total, 0) - fleteIncl - seguroIncl).toFixed(2)),
        carpeta_importacion_id: carpetaId,
        status: 'confirmado',
        created_by: user?.db_id
      })
      if (ci?.id) {
        await update('carpetas_importacion', carpetaId, { comercial_invoice_id: ci.id })
        let fallidas = 0
        for (const l of _lineas) {
          const fila = await insert('detalle_comercial_invoice', {
            comercial_invoice_id: ci.id,
            product_id: l.product_id,
            lote: '',
            cantidad_neto: l.cantidad_neto,
            cantidad_gross: l.cantidad_gross,
            cantidad_unid: l.cantidad_unid || 0,
            costo_unitario: l.costo_unitario,
            costo_total: l.costo_total
          })
          if (!fila) fallidas++
        }
        if (fallidas) showToast(`${fallidas} línea(s) del detalle no se pudieron guardar`, 'warning')
      } else {
        showToast('Carpeta creada, pero el Commercial Invoice falló: ' + (ultimoErrorInsert()?.mensaje || ''), 'warning')
      }
      // Enlazar la compra con su carpeta
      await update('compras', compraBase.id, { carpeta_importacion_id: carpetaId })
    }

    // ── Origen OC: enlazar la OC ──────────────────────────────────────────
    if (_origen === 'oc') {
      await update('orden_compra', _seleccion.id, { carpeta_importacion_id: carpetaId })
    }

    showToast(`Carpeta ${numero} creada`, 'success')
    window.cerrarModalNuevaCarpeta()

    // Recargar el selector del módulo y abrir la carpeta recién creada
    if (typeof window.cargarImportacionesList === 'function') await window.cargarImportacionesList()
    const sel = document.getElementById('costeoSelector')
    if (sel) {
      sel.value = String(carpetaId)
      if (typeof window.cargarImportacion === 'function') await window.cargarImportacion()
    }
  } catch (e) {
    console.error('crearCarpetaImportacion:', e)
    showToast(e.message || 'No se pudo crear la carpeta', 'danger')
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '📁 Crear carpeta' }
  }
}

export default { abrirModalNuevaCarpeta: window.abrirModalNuevaCarpeta, getComprasSinCarpeta, getOCsImportacion }
