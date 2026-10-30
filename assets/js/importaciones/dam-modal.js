// ============================================================================
// DAM-MODAL.JS — DAM de la carpeta (Ver → Editar) + Ajustes de valor / contingencias
// ============================================================================
// Etapa 3 del ciclo: despacho en Aduanas.
//   · Modal único de la DAM (reemplaza a los 2 modales viejos nuevo/editar):
//     identificación, canal, levante, valor declarado, tributos, pesos y bultos,
//     cruces automáticos contra CI / BL, y la lista de ajustes de valor.
//   · «Ajustar valor»: registra duda razonable / ajuste de valor / otros como un
//     REGISTRO ADICIONAL (dam_autoliquidaciones). La DAM original NO se toca.
//   · «Enviar al costeo»: convierte los tributos pagados del ajuste en líneas del
//     ledger con su clasificación contable (ad valorem adicional = costo NIC 2,
//     IGV/IPM = crédito fiscal, intereses = gasto financiero).
// Guarda con tolerancia: si el SQL 104 aún no se corrió, graba lo básico y avisa.
// ============================================================================
import { query, insert, update, deleteRecord, ultimoErrorInsert, esperarContextoEmpresa } from '../supabase-client.js'
import { getCurrentUser } from '../auth-supabase.js'
import { showToast, formatNumber, fechaDMY } from '../helpers.js'
import { aplicarModoVerEditar } from '../shared/ver-editar.js'
import { declararEmpresaModal } from '../empresa.js'
import { getTipoCambioDia } from '../sunat-api.js'
import { crearLineaCosto } from './costos-ledger.js'
import { getContacts } from '../supabase-data.js'
import { MONTOS_FIJOS_PERCEPCION, PERCEPCION_NORMA } from './percepcion-montos-fijos.js'
import { convertirEnBuscador, refrescarBuscador } from '../buscador-select.js'
import { abrirModalContacto } from '../shared/contacto-modal.js'

const $ = id => document.getElementById(id)
const v = id => ($(id)?.value ?? '').toString().trim()
const num = x => { const n = parseFloat(String(x ?? '').replace(/,/g, '')); return isNaN(n) ? null : n }
const n0 = x => num(x) || 0
const n2 = x => formatNumber(n0(x), 2)
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

export const CANALES = { verde: ['Verde', '#10b981'], naranja: ['Naranja', '#f59e0b'], rojo: ['Rojo', '#ef4444'] }
export const MOTIVOS = { duda_razonable: 'Duda razonable (valor)', ajuste_valor: 'Ajuste de valor', error_clasificacion: 'Error de clasificación', otro: 'Otro' }
const ESTADOS_AJ = { pendiente: ['Pendiente', '#f59e0b'], pagada: ['Pagada', '#10b981'], desestimada: ['Desestimada', '#6b7280'] }

let _dam = null        // DAM abierta (null = nueva)
let _ref = { ci: null, bls: [] }
let _aj = null         // ajuste abierto (null = nuevo)
let _ajustes = []

const carpeta = () => window.carpetaActual || null
const ciActual = () => window.costeoActual?.id ? window.costeoActual : null

// ── Guardado tolerante a columnas que aún no existen (SQL sin correr) ──────────
async function _guardarTolerante(tabla, id, fila) {
  const quitadas = []
  let datos = { ...fila }
  for (let i = 0; i < 12; i++) {
    const res = id ? await update(tabla, id, datos) : await insert(tabla, datos)
    if (res) return { res, quitadas }
    const msg = ultimoErrorInsert()?.message || ''
    const m = msg.match(/Could not find the '([^']+)' column/i) || msg.match(/column "?([a-z_0-9]+)"? .*does not exist/i) || msg.match(/column "([a-z_0-9]+)" of relation/i)
    if (!m || !(m[1] in datos)) return { res: null, quitadas, error: msg }
    quitadas.push(m[1]); delete datos[m[1]]
  }
  return { res: null, quitadas, error: 'No se pudo guardar' }
}

// ── Fecha/hora del levante (timestamptz ⇄ datetime-local) ─────────────────────
const _aLocalInput = iso => {
  if (!iso) return ''
  const d = new Date(iso); if (isNaN(d)) return ''
  const p = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}
const _deLocalInput = s => s ? new Date(s).toISOString() : null
const _fechaHora = iso => { if (!iso) return ''; const d = new Date(iso); if (isNaN(d)) return ''; return `${fechaDMY(_aLocalInput(iso).slice(0, 10))} ${_aLocalInput(iso).slice(11)}` }

// ============================================================================
// MODAL DE LA DAM
// ============================================================================
function _asegurarModalDAM() {
  if ($('modal-dam-carpeta')) return
  document.body.insertAdjacentHTML('beforeend', `
  <div id="modal-dam-carpeta" class="modal">
    <div class="modal-content" style="width:min(96vw, 980px); max-width:min(96vw, 980px); max-height:calc(100vh - 48px); overflow-y:auto;">
      <div class="modal-header">
        <h3 class="modal-title" id="dmTitulo">DAM</h3>
        <button class="modal-close" onclick="window.cerrarDAM()">&times;</button>
      </div>
      <div style="padding:6px 20px 0;">
        <div class="costeo-selector dm-carpeta"><label>Carpeta:</label><select id="dmCarpeta" disabled></select></div>
        <div class="dm-nota" style="margin-bottom:4px;">La DAM se registra en la carpeta abierta. Datos de la <b>DAM completa</b> del agente (Hoja A, B, C y DAV); lo marcado «consulta SUNAT» sale de la consulta de levante por N° de DUA.</div>
        <div class="la-steps" id="dmSteps"></div>
        <section class="la-panel" data-p="1">
        <strong class="mod-sec">Identificación del despacho</strong>
        <div style="display:grid; grid-template-columns:repeat(4, 1fr); gap:10px;">
          <div class="form-group" style="grid-column:span 2;"><label>N° de DAM * <span class="bl-en">(Hoja A · «No Declaración», ej. 118-2026-10-436155-01-7-00)</span></label><input type="text" id="dmNro" maxlength="40"></div>
          <div class="form-group"><label>Fecha de numeración * <span class="bl-en">(Hoja A · «Fch. Numeración»)</span></label><input type="date" id="dmFecha" onchange="window.dmTC()"></div>
          <div class="form-group"><label>Canal de control <span class="bl-en">(consulta SUNAT · semáforo)</span></label>
            <select id="dmCanal"><option value="">— sin canal —</option><option value="verde">🟢 Verde</option><option value="naranja">🟠 Naranja</option><option value="rojo">🔴 Rojo</option></select></div>
          <div class="form-group"><label>Modalidad de despacho <span class="bl-en">(consulta SUNAT)</span></label>
            <select id="dmModalidad"><option value="">—</option><option>Anticipado</option><option>Excepcional</option><option>Diferido</option><option>Urgente</option></select></div>
          <div class="form-group" style="grid-column:span 2;"><label>Agente de aduana <span class="bl-en">(Hoja A · 8.1 Declarante)</span></label><select id="dmAgente"><option value="">—</option></select></div>
          <div class="form-group"><label>Estado <span class="bl-en">(sale de los pagos)</span></label>
            <select id="dmEstado" data-siempre-lectura><option value="pendiente">Pendiente</option><option value="pagado">Pagado</option></select></div>
          <div class="form-group" style="grid-column:span 2;"><label>Depósito temporal / terminal <span class="bl-en">(Hoja A · 4.1 Terminal de Almacenamiento)</span></label><select id="dmDeposito"><option value="">—</option></select></div>
          <div class="form-group"><label>Levante autorizado <span class="bl-en">(consulta SUNAT · «Fecha levante»)</span></label><input type="datetime-local" id="dmLevante"></div>
        </div>
        <strong class="mod-sec" style="margin-top:14px;">Transporte y embarque <span class="bl-en">(Hoja A · casillas 3 y 7)</span></strong>
        <div style="display:grid; grid-template-columns:repeat(4, 1fr); gap:10px;">
          <div class="form-group" style="grid-column:span 2;"><label>Empresa de transporte <span class="bl-en">(Hoja A · 3.1)</span></label><input type="text" id="dmEmpTrans" maxlength="80" placeholder="Ej: TRANSMERIDIAN S.A.C."></div>
          <div class="form-group"><label>N° de manifiesto <span class="bl-en">(Hoja A · 3.2)</span></label><input type="text" id="dmManifiesto" maxlength="30" placeholder="Ej: 1182026764"></div>
          <div class="form-group"><label>Fecha término descarga <span class="bl-en">(Hoja A · 3.4 Fch.Term.Desc/Embar)</span></label><input type="date" id="dmLlegada"></div>
          <div class="form-group"><label>Puerto de embarque <span class="bl-en">(Hoja A · 7.6, ej. SHANGHAI)</span></label><input type="text" id="dmPuerto" maxlength="60"></div>
          <div class="form-group"><label>Doc. de transporte <span class="bl-en">(Hoja A · 7.8 = N° B/L)</span></label><input type="text" id="dmDocTrans" maxlength="40" placeholder="Ej: YIJH60111600"></div>
        </div>

        </section>
        <section class="la-panel" data-p="2">
        <strong class="mod-sec">Valor en aduana declarado <small style="text-transform:none; letter-spacing:0; font-weight:400;">(original de la DAM; los ajustes se registran aparte)</small></strong>
        <div class="dm-auto-aviso"><span>🪄 Los valores, tributos y pesos se llenan solos con tu CI y BL (ad valorem 6 % · IGV 15.5 % · IPM 2.5 %). Puedes editarlos: los editados se marcan en ámbar y los cruces del final avisan la diferencia.</span>
          <button type="button" class="btn btn-secondary btn-small" data-solo-edicion onclick="window.dmAuto(true)" title="Vuelve a calcular todo con el CI y el BL">↺ Valores automáticos</button></div>
        <div style="display:grid; grid-template-columns:repeat(4, 1fr); gap:10px;">
          <div class="form-group"><label>FOB USD <span class="bl-en">(Hoja A · 6.1 / Hoja C · 3.1)</span></label><input type="number" id="dmFOB" step="0.001" oninput="window.dmEdita(this)"></div>
          <div class="form-group"><label>Flete USD <span class="bl-en">(Hoja A · 6.2 / Hoja C · 3.2)</span></label><input type="number" id="dmFlete" step="0.01" oninput="window.dmEdita(this)"></div>
          <div class="form-group"><label>Seguro USD <span class="bl-en">(Hoja A · 6.3 / Hoja C · 3.3)</span></label><input type="number" id="dmSeguro" step="0.01" oninput="window.dmEdita(this)"></div>
          <div class="form-group"><label>CIF USD <span class="bl-en">(Hoja A · 6.5 «Valor aduana» = FOB + flete + seguro)</span></label><input type="number" id="dmCIF" step="0.001" data-siempre-lectura></div>
        </div>

        <strong class="mod-sec">Tributos liquidados</strong>
        <div style="display:grid; grid-template-columns:repeat(4, 1fr); gap:10px;">
          <div class="form-group"><label>Ad valorem USD <span class="bl-en">(Hoja C · 4.1 Ad/Valorem)</span></label><input type="number" id="dmAdv" step="0.01" oninput="window.dmEdita(this)"></div>
          <div class="form-group"><label>IPM USD <span class="bl-en">(Hoja C · 4.5 Imp. Prom. Municipal)</span></label><input type="number" id="dmIPM" step="0.01" oninput="window.dmEdita(this)"></div>
          <div class="form-group"><label>IGV USD <span class="bl-en">(Hoja C · 4.6 Imp. Gral. Ventas)</span></label><input type="number" id="dmIGV" step="0.01" oninput="window.dmEdita(this)"></div>
          <div class="form-group"><label>Total liquidación USD <span class="bl-en">(Hoja C · 4.13 Total)</span></label><input type="number" id="dmTotal" step="0.01" data-siempre-lectura></div>
          <div class="form-group"><label>Percepción S/ <span class="bl-en">(Constancia de percepción IGV · «Total en soles»)</span></label><input type="number" id="dmPercep" step="0.01" oninput="window.dmEdita(this)"></div>
          <div class="form-group"><label>Último día de pago <span class="bl-en">(liquidación · vencimiento)</span></label><input type="date" id="dmUltimoDia" onchange="window.dmPasos()"></div>
          <div class="form-group"><label>TLC aplicable <span class="bl-en">(ad valorem liberado)</span></label><select id="dmTLC"><option value="">No</option><option value="1">Sí, por TLC</option></select></div>
          <div class="form-group"><label>Fecha de pago de tributos <span class="bl-en">(se llena sola al registrar el pago)</span></label><input type="date" id="dmFechaPago" data-siempre-lectura title="Sale del pago registrado más abajo (Pago de tributos)"></div>
          <div class="form-group"><label>T.C. venta SUNAT <button type="button" class="btn btn-secondary btn-small" data-solo-edicion onclick="window.dmTC(true)" title="Consultar T.C. de la fecha de pago">⟳</button></label><input type="number" id="dmTC" step="0.001" oninput="window.dmAuto()"></div>
          <div class="form-group"><label>Subpartida nacional <span class="bl-en">(Hoja A · 7.19)</span></label><input type="text" id="dmSubpartida" maxlength="10" inputmode="numeric" placeholder="10 dígitos" oninput="window.dmAuto()"></div>
        </div>
        <div id="dmTCaviso" style="font-size:.78rem; color:var(--text-secondary); margin-top:-4px;"></div>
        <div style="display:flex; gap:10px; align-items:center; flex-wrap:wrap; margin-top:2px;"><select id="dmTasaPerc" onchange="window.dmAuto()" style="width:auto; padding:4px 8px; font-size:.78rem;" title="Tasa de percepción de tu empresa"><option value="3.5">Tasa 3.5 % (general)</option><option value="5">Tasa 5 % (bienes usados)</option><option value="10">Tasa 10 % (1ª importación / no habido)</option></select><div id="dmPercNota" class="dm-nota" style="margin:0; flex:1; min-width:260px;"></div></div>

        </section>
        <section class="la-panel" data-p="3">
        <div id="dmPagosHost" style="margin-top:6px;"></div>
        </section>

        <section class="la-panel" data-p="4">
        <strong class="mod-sec">Mercadería despachada</strong>
        <div style="display:grid; grid-template-columns:repeat(4, 1fr); gap:10px;">
          <div class="form-group"><label>Bultos <span class="bl-en">(Hoja A · 7.12 Cant. Bult.)</span></label><input type="number" id="dmBultos" step="1" oninput="window.dmEdita(this)"></div>
          <div class="form-group"><label>Peso bruto (kg) <span class="bl-en">(Hoja A · 7.15 Peso Bruto)</span></label><input type="number" id="dmPesoBruto" step="0.001" oninput="window.dmEdita(this)"></div>
          <div class="form-group"><label>Peso neto (kg) <span class="bl-en">(Hoja A · 7.14 Peso Neto)</span></label><input type="number" id="dmPesoNeto" step="0.001" oninput="window.dmEdita(this)"></div>
        </div>

        </section>
        <section class="la-panel" data-p="5">
        <strong class="mod-sec">Cruces automáticos <small style="text-transform:none; letter-spacing:0; font-weight:400;">(DAM contra CI y BL)</small></strong>
        <div id="dmAuditoria" class="dm-cruces"></div>

        <div id="dmBloqueAjustes">
          <strong class="mod-sec">Ajustes de valor y contingencias <small style="text-transform:none; letter-spacing:0; font-weight:400;">(se suman a la DAM, no la reemplazan)</small></strong>
          <div id="dmAjustes"></div>
        </div>
        </section>
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" onclick="window.dmIr(window.dmPasoActual - 1)">‹ Anterior</button>
        <button class="btn btn-secondary" onclick="window.dmIr(window.dmPasoActual + 1)">Siguiente ›</button>
        <button class="btn btn-secondary" id="dmBtnDeclaracion" onclick="window.abrirDeclaracionDAM()">📋 Declaración completa</button>
        <button class="btn btn-secondary" id="dmBtnAjustar" onclick="window.abrirAjusteValor()">⚖️ Ajustar valor</button>
        <button class="btn btn-secondary" id="dmBtnCosteo" data-solo-lectura onclick="window.enviarDAMCosteo()" title="Crea las líneas de tributos de la DAM en el costeo">➡ Tributos al costeo</button>
        <button class="btn btn-secondary" data-solo-lectura onclick="window.cerrarDAM()">Cerrar</button>
        <button class="btn btn-primary" data-solo-lectura onclick="window.dmEditar()">✏️ Editar</button>
        <button class="btn btn-secondary" data-solo-edicion onclick="window.dmCancelar()">Cancelar</button>
        <button class="btn btn-primary" data-solo-edicion onclick="window.guardarDAMCarpeta()">💾 Guardar DAM</button>
      </div>
    </div>
  </div>`)
}

const CAMPOS_DAM = [
  ['dmNro', 'numero_dam'], ['dmFecha', 'fecha_dam'], ['dmCanal', 'canal_aduanero'], ['dmModalidad', 'modalidad_despacho'],
  ['dmAgente', 'agente_aduana'], ['dmEstado', 'estado'], ['dmDeposito', 'deposito_temporal'], ['dmLlegada', 'fecha_llegada'],
  ['dmFOB', 'valor_fob'], ['dmFlete', 'flete_maritimo'], ['dmSeguro', 'seguro_maritimo'],
  ['dmAdv', 'ad_valorem_usd'], ['dmIPM', 'imp_usd'], ['dmIGV', 'igv_usd'], ['dmPercep', 'percepcion'],
  ['dmFechaPago', 'fecha_pago'], ['dmEmpTrans', 'empresa_transporte'], ['dmManifiesto', 'nro_manifiesto'], ['dmDocTrans', 'doc_transporte'], ['dmPuerto', 'puerto_origen'], ['dmUltimoDia', 'ultimo_dia_pago'], ['dmSubpartida', 'subpartida'], ['dmTC', 'tipo_cambio'], ['dmBultos', 'bultos'], ['dmPesoBruto', 'peso_bruto_kg'], ['dmPesoNeto', 'peso_neto_kg']
]
const NUEVAS_DAM = ['empresa_transporte', 'nro_manifiesto', 'doc_transporte', 'puerto_origen', 'ultimo_dia_pago', 'tlc_aplica', 'subpartida', 'canal_aduanero', 'modalidad_despacho', 'agente_aduana', 'deposito_temporal', 'fecha_llegada', 'fecha_levante', 'bultos', 'peso_bruto_kg', 'peso_neto_kg']


// ── Agente de aduana y Depósito temporal: buscador de contactos (nombre o RUC) ──
// El value de cada opción es la razón social (así se guarda en dams.agente_aduana /
// deposito_temporal sin tocar la BD); el texto muestra "Razón social — RUC".
let _contactosDAM = [], _pendienteContacto = null
const _opcionesContactos = () => '<option value="">—</option>' + _contactosDAM
  .map(c => `<option value="${esc(c.nombre)}">${esc(c.nombre)}${c.nro_documento ? ' — ' + esc(c.nro_documento) : ''}</option>`).join('')

async function _cargarContactosDAM() {
  try { _contactosDAM = ((await getContacts(true)) || []).filter(c => c.nombre).sort((a, b) => a.nombre.localeCompare(b.nombre, 'es')) } catch (e) { console.warn('contactos DAM:', e) }
  for (const id of ['dmAgente', 'dmDeposito']) {
    const sel = $(id); if (!sel) continue
    const actual = sel.value
    sel.innerHTML = _opcionesContactos(); sel.value = actual
    refrescarBuscador(sel)
  }
}
function _montarBuscadoresDAM() {
  const cfg = {
    dmAgente: { placeholder: 'Escribe el nombre o RUC del agente...', label: 'Agregar agente de aduana (contacto nuevo)' },
    dmDeposito: { placeholder: 'Escribe el nombre o RUC del depósito / terminal...', label: 'Agregar depósito o terminal (contacto nuevo)' }
  }
  for (const [id, c] of Object.entries(cfg)) {
    const sel = $(id); if (!sel) continue
    convertirEnBuscador(sel, { placeholder: c.placeholder, sinResultados: 'Ningún contacto coincide',
      alCrearNuevo: { label: c.label, onClick: () => { _pendienteContacto = id; abrirModalContacto({ roles: ['proveedor'] }) } } })
  }
}
/** Pone un valor guardado en el select; si ya no está en contactos (renombrado/borrado) lo conserva como opción. */
function _ponerContacto(id, valor) {
  const sel = $(id); if (!sel) return
  if (valor && ![...sel.options].some(o => o.value === valor)) sel.insertAdjacentHTML('beforeend', `<option value="${esc(valor)}">${esc(valor)}</option>`)
  sel.value = valor || ''
  refrescarBuscador(sel)
}
window.addEventListener('contacto-guardado', async e => {
  const c = e.detail?.contacto
  await _cargarContactosDAM()
  if (_pendienteContacto && c?.nombre && !c._eliminado) { _ponerContacto(_pendienteContacto, c.nombre); showToast(`${c.nombre} seleccionado`, 'success') }
  _pendienteContacto = null
})

function _volcarDAM(dam, ref) {
  for (const [id, col] of CAMPOS_DAM) { if (id === 'dmAgente' || id === 'dmDeposito') { _ponerContacto(id, dam?.[col] || ''); continue } const el = $(id); if (el) el.value = dam?.[col] ?? '' }
  $('dmLevante').value = _aLocalInput(dam?.fecha_levante)
  $('dmTLC').value = dam?.tlc_aplica ? '1' : ''
  document.querySelectorAll('#modal-dam-carpeta input[type=number]').forEach(el => { if (el.id in AUTO_TOL) { el.dataset.auto = '1'; el.dataset.manual = dam ? '1' : '' } })
  if (!dam) $('dmEstado').value = 'pendiente'
  if (!dam && !$('dmSubpartida').value) $('dmSubpartida').value = (ref?.ci?.detalles || []).map(d => d.partida_arancelaria).find(Boolean) || ''
  $('dmTCaviso').textContent = ''
  if (!dam) window.dmAuto(true); else window.dmRecalcular()
}


// ── Valores automáticos (CI + BL + tasas) — editables ────────────────────────
const TASAS_DAM = { adv: 6, igv: 15.5, ipm: 2.5 }
const AUTO_TOL = { dmFOB: 0.05, dmFlete: 0.05, dmSeguro: 0.05, dmAdv: 1, dmIPM: 1, dmIGV: 1, dmPercep: 1, dmBultos: 0.5, dmPesoBruto: 0.5, dmPesoNeto: 0.5 }


// ── Percepción IGV en importación (S/) ───────────────────────────────────────
// Ley 29173 art. 19 + DS 104-2026-EF (vigente desde 18/06/2026; tabla en percepcion-montos-fijos.js):
//   base = valor en aduana + todos los tributos (ad valorem, IGV, IPM) × T.C. de la fecha de pago
//   tasa 3.5 % general · 5 % bienes usados · 10 % primera importación / no habido / omisos
//   «Mercancías sensibles al fraude» (54 subpartidas): se paga el MAYOR entre (tasa × base) y
//   (monto fijo S/ por unidad × unidades de la DAM). Solo KG se multiplica solo (peso neto).
const IDX_TASA = { 3.5: 1, 5: 2, 10: 3 }

window.calcularPercepcion = function ({ baseSoles, kg, subpartida, tasa = 3.5 }) {
  const porcentaje = baseSoles * tasa / 100
  const fila = MONTOS_FIJOS_PERCEPCION[String(subpartida || '').replace(/\D/g, '')]
  const unidad = fila?.[0] || null, fijoUnit = fila ? fila[IDX_TASA[tasa] || 1] : 0
  const fijo = unidad === 'KG' ? fijoUnit * kg : 0
  return { monto: Math.max(porcentaje, fijo), porcentaje, fijoUnit, fijo, unidad, usaFijo: fijo > porcentaje }
}

const _tasaPerc = () => Number($('dmTasaPerc')?.value) || 3.5

function _autoPercep() {
  const nota = $('dmPercNota'), tc = n0(v('dmTC'))
  const cif = n0(v('dmFOB')) + n0(v('dmFlete')) + n0(v('dmSeguro'))
  const trib = n0(v('dmAdv')) + n0(v('dmIGV')) + n0(v('dmIPM'))
  if (!cif) { if (nota) nota.textContent = ''; return null }
  if (!tc) { if (nota) nota.textContent = 'Indica la fecha de pago de tributos para traer el T.C. (la percepción se calcula en soles).'; return null }
  const sub = v('dmSubpartida'), subN = String(sub || '').replace(/\D/g, ''), tasa = _tasaPerc(), kg = n0(v('dmPesoNeto'))
  const base = (cif + trib) * tc
  const r = window.calcularPercepcion({ baseSoles: base, kg, subpartida: sub, tasa })
  let txt = `${tasa} % × S/ ${base.toLocaleString('es-PE', { maximumFractionDigits: 0 })} = <b>S/ ${r.porcentaje.toFixed(2)}</b>`
  if (r.unidad === 'KG') txt += ` · monto fijo SUNAT (${PERCEPCION_NORMA.decreto}) S/ ${r.fijoUnit} × ${kg.toLocaleString('es-PE')} kg = <b>S/ ${r.fijo.toFixed(2)}</b> → se paga el <b>${r.usaFijo ? 'monto fijo' : 'porcentaje'}</b>`
  else if (r.unidad) txt += ` · ⚠ esta subpartida es sensible al fraude y su monto fijo es por ${r.unidad} (S/ ${r.fijoUnit}): multiplícalo por las unidades de la DAM y escribe la percepción`
  else if (subN.length === 10) txt += ' · esa subpartida NO está en la lista de mercancías sensibles al fraude: solo aplica el porcentaje'
  else txt += ' · indica la subpartida para saber si aplica el monto fijo de SUNAT'
  if (nota) nota.innerHTML = txt
  return (r.unidad && r.unidad !== 'KG') ? null : r.monto
}

function _autoBase() {
  const { ci, bls } = _ref, a = {}
  if (ci) { a.dmFOB = n0(ci.valor_total_final_fob); a.dmFlete = n0(ci.costo_flete); a.dmSeguro = n0(ci.costo_seguro); a.dmPesoNeto = n0(ci.cantidad_total_neto) }
  if (bls?.length) { a.dmBultos = bls.reduce((t, b) => t + n0(b.bultos), 0); a.dmPesoBruto = bls.reduce((t, b) => t + n0(b.peso_bruto), 0) }
  return a
}
function _autoTributos() {   // sobre el CIF que hay en pantalla
  const cif = n0(v('dmFOB')) + n0(v('dmFlete')) + n0(v('dmSeguro'))
  // La aduana liquida en USD enteros: cada tributo se redondea y el total es la suma de los redondeados.
  const adv = Math.round(cif * TASAS_DAM.adv / 100)
  return { dmAdv: adv, dmIGV: Math.round((cif + adv) * TASAS_DAM.igv / 100), dmIPM: Math.round((cif + adv) * TASAS_DAM.ipm / 100) }
}
const _redondea = (id, x) => x ? String(+x.toFixed(['dmFOB', 'dmPesoBruto', 'dmPesoNeto'].includes(id) ? 3 : 2)) : ''

/** Llena lo automático. forzar=true pisa también lo que el usuario editó. */
window.dmAuto = function (forzar) {
  if (forzar === true) document.querySelectorAll('#modal-dam-carpeta [data-auto]').forEach(el => { el.dataset.manual = '' })
  const poner = a => { for (const [id, val] of Object.entries(a)) { const el = $(id); if (el && el.dataset.manual !== '1') el.value = _redondea(id, val) } }
  poner(_autoBase()); poner(_autoTributos())
  const pc = _autoPercep(); if (pc != null) poner({ dmPercep: pc })
  window.dmRecalcular()
}
function _autoTodos() { const a = { ..._autoBase(), ..._autoTributos() }; const pc = _autoPercep(); if (pc != null) a.dmPercep = pc; return a }

function _marcarEditados() {
  const a = _autoTodos()
  for (const id of Object.keys(AUTO_TOL)) {
    const el = $(id); if (!el) continue
    const hay = a[id] != null && v(id) !== '' && Math.abs(n0(v(id)) - n0(a[id])) > AUTO_TOL[id]
    el.classList.toggle('dm-editado', !!hay)
    el.title = hay ? `Editado. Valor automático: ${_redondea(id, a[id])}` : ''
  }
}

window.dmEdita = function (el) {
  const a = _autoTodos()
  // Solo deja de ser "manual" si coincide EXACTO con el automático (la tolerancia AUTO_TOL es solo para
  // resaltar en ámbar; usarla aquí pisaba lo que el usuario escribía: 2963 → 2964 con tolerancia 1).
  el.dataset.manual = (a[el.id] != null && el.value !== '' && Math.abs(n0(el.value) - n0(a[el.id])) < 0.005) ? '' : '1'
  window.dmAuto()
}

window.dmRecalcular = function () {
  const fob = n0(v('dmFOB')), fl = n0(v('dmFlete')), sg = n0(v('dmSeguro'))
  $('dmCIF').value = (fob + fl + sg) ? (fob + fl + sg).toFixed(3) : ''
  const tot = n0(v('dmAdv')) + n0(v('dmIPM')) + n0(v('dmIGV'))
  $('dmTotal').value = tot ? tot.toFixed(2) : ''
  _marcarEditados()
  _pintarCruces()
}

window.dmTC = async function (forzar) {
  const pagada = v('dmFechaPago'); const f = pagada || v('dmFecha'); const aviso = $('dmTCaviso')
  if (!f) { if (forzar === true) showToast('Primero indica la fecha de numeración de la DAM', 'warning'); return }
  if (!forzar && v('dmTC') && _dam?.tipo_cambio) return
  aviso.textContent = 'Consultando T.C. SUNAT…'
  try {
    const r = await getTipoCambioDia(f, { permitirApi: forzar === true })
    if (r?.venta) { $('dmTC').value = Number(r.venta).toFixed(3); aviso.textContent = `T.C. venta SUNAT del ${fechaDMY(f)}: ${Number(r.venta).toFixed(3)} (${r.origen})${pagada ? '' : ' · ESTIMADO con la fecha de numeración: se actualiza solo al registrar el pago'}`; window.dmAuto() }
    else aviso.textContent = r?.error || 'Sin T.C. guardado para esa fecha: pulsa ⟳ para consultarlo.'
  } catch { aviso.textContent = 'No se pudo consultar el T.C.' }
}

// ── Cruces DAM ⇄ CI ⇄ BL ──────────────────────────────────────────────────────
function _pintarCruces() {
  const host = $('dmAuditoria'); if (!host) return
  const { ci, bls } = _ref
  if (!ci) { host.innerHTML = '<div class="dm-nota">Sin Commercial Invoice para comparar.</div>'; return }
  const sBL = k => bls.reduce((t, b) => t + n0(b[k]), 0)
  const filas = []
  const fila = (lbl, dam, otro, otroTxt, tol, nota) => {
    if (!n0(dam) || !n0(otro)) return
    const d = n0(dam) - n0(otro)
    const ok = Math.abs(d) <= tol
    filas.push(`<div class="dm-cruce ${ok ? 'ok' : 'warn'}"><span class="dm-cruce-ico">${ok ? '✔' : '⚠'}</span>
      <div><b>${lbl}</b> · DAM ${n2(dam)} · ${otroTxt} ${n2(otro)}${ok ? '' : ` · <b>diferencia ${d > 0 ? '+' : ''}${n2(d)}</b>`}${!ok && nota ? `<div class="dm-nota">${nota}</div>` : ''}</div></div>`)
  }
  if (bls.length) {
    fila('Bultos', v('dmBultos'), sBL('bultos'), 'BL', 0.5)
    fila('Peso bruto (kg)', v('dmPesoBruto'), sBL('peso_bruto'), 'BL', 0.5, 'El peso bruto del despacho puede diferir del BL si el terminal pesó el contenedor; confírmalo con tu agente.')
  }
  fila('Peso neto (kg)', v('dmPesoNeto'), ci.cantidad_total_neto, 'CI', 0.5)
  fila('FOB (USD)', v('dmFOB'), ci.valor_total_final_fob, 'CI', 0.05, 'La DAM trae un FOB distinto al del CI (suele ser un ajuste que el agente suma a la factura). Pídele que te diga el concepto.')
  fila('Flete (USD)', v('dmFlete'), ci.costo_flete, 'CI', 0.05)
  fila('Seguro (USD)', v('dmSeguro'), ci.costo_seguro, 'CI', 0.05)
  fila('CIF (USD)', v('dmCIF'), ci.valor_total_final_ci, 'factura CI', 0.05, 'El CIF de la DAM es distinto al total de la factura del proveedor.')
  const blFlete = n0(sBL('flete_prepago_usd')) + n0(sBL('flete_destino_usd'))
  const cny = sBL('flete_prepago_cny')
  if (bls.length && (blFlete || cny)) {
    filas.push(`<div class="dm-cruce info"><span class="dm-cruce-ico">ℹ</span><div><b>Flete del BL</b> · USD ${n2(sBL('flete_prepago_usd'))} prepagado${cny ? ` + CNY ${n2(cny)}` : ''}${sBL('flete_destino_usd') ? ` + USD ${n2(sBL('flete_destino_usd'))} por cobrar en destino` : ''} · flete declarado en la DAM: USD ${n2(v('dmFlete'))}</div></div>`)
  }
  host.innerHTML = filas.length ? filas.join('') : '<div class="dm-nota">Aún no hay datos para cruzar: completa la DAM y el BL.</div>'
}

// ── Ajustes (lista dentro del modal de la DAM) ───────────────────────────────
export async function cargarAjustes(damId) {
  if (!damId) return []
  const r = await query('dam_autoliquidaciones', { dam_id: damId })
  return (r || []).sort((a, b) => String(a.fecha).localeCompare(String(b.fecha)))
}

async function _pintarAjustes() {
  const host = $('dmAjustes'); if (!host) return
  const bloque = $('dmBloqueAjustes')
  if (!_dam) { bloque.style.display = 'none'; return }
  bloque.style.display = ''
  _ajustes = await cargarAjustes(_dam.id)
  if (!_ajustes.length) { host.innerHTML = '<div class="dm-nota">Sin ajustes. Si Aduanas notifica duda razonable o pide más tributos, pulsa «⚖️ Ajustar valor».</div>'; return }
  const tot = a => n0(a.ad_valorem_usd) + n0(a.ipm_usd) + n0(a.igv_usd) + n0(a.intereses_usd)
  host.innerHTML = `<div style="overflow-x:auto;"><table class="dm-tabla"><thead><tr><th>Motivo</th><th>N° liquidación</th><th>Notificada</th><th>Pagada</th><th style="text-align:right;">Valor adicional</th><th style="text-align:right;">Tributos pagados</th><th>Estado</th><th></th></tr></thead><tbody>
    ${_ajustes.map(a => {
      const [et, col] = ESTADOS_AJ[a.estado] || ESTADOS_AJ.pendiente
      const envia = a.estado === 'pagada' && !a.enviada_costeo
      return `<tr><td>${esc(MOTIVOS[a.motivo] || a.motivo)}</td><td>${esc(a.numero)}</td><td>${a.fecha_notificacion ? fechaDMY(a.fecha_notificacion) : '—'}</td><td>${a.fecha_pago ? fechaDMY(a.fecha_pago) : '—'}</td>
        <td style="text-align:right;">${n0(a.valor_adicional_usd) ? '+ $ ' + n2(a.valor_adicional_usd) : '—'}</td><td style="text-align:right;"><b>$ ${n2(tot(a))}</b></td>
        <td><span class="cr-chip" style="--c:${col};">${et}</span>${a.enviada_costeo ? ' <span class="cr-chip" style="--c:#3b82f6;">En costeo</span>' : ''}</td>
        <td style="white-space:nowrap;"><button type="button" class="btn btn-secondary btn-small" onclick="window.abrirAjusteValor(${a.id})">👁 Ver</button>
          ${envia ? `<button type="button" class="btn btn-primary btn-small" onclick="window.enviarAjusteCosteo(${a.id})">➡ Enviar al costeo</button>` : ''}</td></tr>`
    }).join('')}</tbody></table></div>`
}

// ── Abrir / guardar la DAM ─────────────────────────────────────────────────
window.abrirDAM = async function (id) {
  try {
    await esperarContextoEmpresa()
    const ci = ciActual()
    if (!ci) { showToast('Esta carpeta aún no tiene Commercial Invoice: registra primero el CI', 'warning'); return }
    _asegurarModalDAM()
    _montarBuscadoresDAM()
    await _cargarContactosDAM()
    _dam = id ? ((await query('dams', { id })) || [])[0] || null : null
    const bls = (await query('bill_of_ladings', { importacion_id: ci.id })) || []
    _ref = { ci, bls }
    const selC = document.getElementById('costeoSelector')
    const txtC = selC?.selectedOptions?.[0]?.text || carpeta()?.numero_carpeta || ''
    $('dmCarpeta').innerHTML = `<option>${esc(txtC)}</option>`
    $('dmTitulo').textContent = _dam ? `DAM ${_dam.numero_dam}` : 'Nueva DAM'
    declararEmpresaModal('modal-dam-carpeta', carpeta()?.empresa_id)
    _volcarDAM(_dam, _ref)
    $('dmBtnDeclaracion').style.display = _dam ? '' : 'none'
    $('dmBtnAjustar').style.display = _dam ? '' : 'none'
    aplicarModoVerEditar('modal-dam-carpeta', !!_dam)
    window.openModal('modal-dam-carpeta')
    _pintarPagosDAM()
    window.dmIr(1)
    await _pintarAjustes()
  } catch (e) { console.error('abrirDAM:', e); showToast('No se pudo abrir la DAM', 'danger') }
}
function _pintarPagosDAM() {
  const h = $('dmPagosHost'); if (!h) return
  const _ob = t => window.hcObligacion?.(t, _dam?.id)
  const pend = [['dam_tributos', _ob('dam_tributos')], ['dam_percepcion', _ob('dam_percepcion')]].filter(([, o]) => o && o.estado !== 'pagado')
  const btnTodo = _dam && pend.length ? `<div class="dm-pagar-bar"><span>💳 ${pend.length === 2 ? 'Tributos y percepción pendientes' : (pend[0][0] === 'dam_tributos' ? 'Tributos pendientes' : 'Percepción pendiente')}</span>
      <button type="button" class="btn btn-primary btn-small" onclick="window.dmPagarTodo()">＋ Pagar ${pend.length === 2 ? 'tributos y percepción' : (pend[0][0] === 'dam_tributos' ? 'tributos' : 'percepción')}</button></div>` : ''
  h.innerHTML = _dam ? btnTodo + window.pagosBloqueHtml?.('dam_tributos', _dam.id, 'Pago de tributos') + window.pagosBloqueHtml?.('dam_percepcion', _dam.id, 'Pago de percepción')
    : '<div class="dm-nota">Guarda la DAM para registrar el pago de sus tributos y de la percepción.</div>'
}
/** Tras registrar/editar/eliminar un pago: refresca el estado derivado de la DAM y del ajuste abiertos. */
window.onPagosCambiaron = async () => {
  try {
    document.querySelectorAll('[data-pg-doc]').forEach(el => { el.innerHTML = window.pagosBloqueHtml?.(el.dataset.pgDoc, el.dataset.pgId || null, el.dataset.pgTit) || '' })
    if (_dam && $('modal-dam-carpeta')?.classList.contains('show')) {
      _dam = ((await query('dams', { id: _dam.id })) || [])[0] || _dam
      for (const id of ['dmEstado', 'dmFechaPago', 'dmTC']) { const col = CAMPOS_DAM.find(c => c[0] === id)?.[1]; if (col && $(id)) $(id).value = _dam[col] ?? '' }
      _pintarPagosDAM()
    }
    if (_aj && $('modal-dam-ajuste')?.classList.contains('show')) {
      _aj = ((await query('dam_autoliquidaciones', { id: _aj.id })) || [])[0] || _aj
      for (const [id, col] of [['ajEstado', 'estado'], ['ajFechaPago', 'fecha_pago'], ['ajTC', 'tipo_cambio']]) if ($(id)) $(id).value = _aj[col] ?? ''
      _pintarPagosAjuste()
    }
  } catch (e) { console.warn('onPagosCambiaron', e) }
}
window.dmPagarTodo = () => {
  const sel = ['dam_tributos', 'dam_percepcion'].filter(t => { const o = window.hcObligacion?.(t, _dam?.id); return o && o.estado !== 'pagado' }).map(t => `${t}:${_dam.id}`)
  window.abrirPagoRapido(sel.length ? sel : 'tributos')
}
// ── Etapas (como la liquidación del agente) ────────────────────────────────
window.dmPasoActual = 1
const _PASOS_DAM = [['Declaración', '📋'], ['Valor y tributos', '🧾'], ['Pagos', '💳'], ['Mercadería', '📦'], ['Cruces y ajustes', '⚖️']]
function _pintarPasosDAM() {
  const host = $('dmSteps'); if (!host) return
  const pend = _dam ? ['dam_tributos', 'dam_percepcion'].some(t => { const o = window.hcObligacion?.(t, _dam.id); return o && o.estado !== 'pagado' }) : false
  const est = [
    v('dmNro') && v('dmFecha') ? 'ok' : '',
    n0(v('dmCIF')) > 0 ? (v('dmUltimoDia') ? 'ok' : 'warn') : '',
    !_dam ? '' : (pend ? 'warn' : 'ok'),
    n0(v('dmPesoBruto')) > 0 ? 'ok' : '',
    ''
  ]
  host.innerHTML = _PASOS_DAM.map(([t, ico], i) => `<button type="button" class="la-step ${est[i]} ${window.dmPasoActual === i + 1 ? 'act' : ''}" onclick="window.dmIr(${i + 1})"><span class="la-dot">${est[i] === 'ok' ? '✓' : est[i] === 'warn' ? '!' : i + 1}</span>${ico} ${t}</button>`).join('<span class="la-sep"></span>')
}
window.dmPasos = _pintarPasosDAM
window.dmIr = n => {
  n = Math.max(1, Math.min(5, n)); window.dmPasoActual = n
  document.querySelectorAll('#modal-dam-carpeta .la-panel').forEach(p => { p.style.display = Number(p.dataset.p) === n ? '' : 'none' })
  _pintarPasosDAM()
}
window.editarDAM = id => window.abrirDAM(id)
window.abrirNuevaDAM = () => window.abrirDAM()
window.dmEditar = () => aplicarModoVerEditar('modal-dam-carpeta', false)
window.dmCancelar = () => { if (_dam) { _volcarDAM(_dam, _ref); aplicarModoVerEditar('modal-dam-carpeta', true) } else window.cerrarDAM() }
window.cerrarDAM = () => { window.closeModal('modal-dam-carpeta'); window.renderHojaCosteo?.(); window.renderDAM?.() }

window.guardarDAMCarpeta = async function () {
  try {
    const ci = ciActual(); if (!ci) throw new Error('Falta el Commercial Invoice de la carpeta')
    if (!v('dmNro')) throw new Error('Falta el N° de DAM')
    if (!v('dmFecha')) throw new Error('Falta la fecha de numeración')
    const fechaPago = v('dmFechaPago') || null, tc = num(v('dmTC')) || 0
    const adv = n0(v('dmAdv')), ipm = n0(v('dmIPM')), igv = n0(v('dmIGV')), per = n0(v('dmPercep'))
    if (fechaPago && fechaPago < v('dmFecha')) throw new Error('La fecha de pago de tributos no puede ser anterior a la fecha de la DAM')
    if ((adv + ipm + igv + per > 0 || v('dmEstado') === 'pagado') && !(tc >= 1 && tc <= 10)) throw new Error('Ingresa el T.C. venta SUNAT (usa ⟳)')

    const fila = { importacion_id: ci.id }
    for (const [id, col] of CAMPOS_DAM) {
      const val = v(id)
      fila[col] = val === '' ? null : (/^(valor_|flete|seguro|ad_valorem|imp_usd|igv_usd|percepcion|tipo_cambio|peso_|bultos)/.test(col) ? num(val) : val)
    }
    fila.fecha_levante = _deLocalInput(v('dmLevante'))
    fila.tlc_aplica = v('dmTLC') === '1'
    fila.valor_cif = num(v('dmCIF')) || 0
    fila.total_liquidacion = adv + ipm + igv
    fila.total_liquidacion_sol = tc ? +((adv + ipm + igv) * tc).toFixed(2) : 0
    if (!_dam && carpeta()?.id) fila.carpeta_importacion_id = carpeta().id
    for (const k of ['ad_valorem_usd', 'imp_usd', 'igv_usd', 'percepcion', 'valor_fob', 'flete_maritimo', 'seguro_maritimo']) if (fila[k] == null) fila[k] = 0

    const { res, quitadas, error } = await _guardarTolerante('dams', _dam?.id, fila)
    if (!res) throw new Error(error || 'No se pudo guardar la DAM')
    const nuevas = quitadas.filter(c => NUEVAS_DAM.includes(c) || c === 'fecha_pago')
    if (nuevas.length) showToast('DAM guardada SIN algunos campos nuevos: falta correr assets/sql/120_alertas_campos_dam_bl.sql', 'warning')
    else showToast('DAM guardada', 'success')
    window.closeModal('modal-dam-carpeta')
    window.renderHojaCosteo?.(); window.renderDAM?.()
  } catch (e) { showToast(e.message || 'No se pudo guardar la DAM', 'danger') }
}

// ============================================================================
// MODAL «AJUSTAR VALOR»
// ============================================================================
function _asegurarModalAjuste() {
  if ($('modal-dam-ajuste')) return
  document.body.insertAdjacentHTML('beforeend', `
  <div id="modal-dam-ajuste" class="modal">
    <div class="modal-content" style="width:min(96vw, 900px); max-width:min(96vw, 900px); max-height:calc(100vh - 48px); overflow-y:auto;">
      <div class="modal-header">
        <h3 class="modal-title" id="ajTitulo">Ajustar valor</h3>
        <button class="modal-close" onclick="window.cerrarAjusteValor()">&times;</button>
      </div>
      <div style="padding:6px 20px 0;">
        <div class="dm-explica">💡 Esto <b>no cambia</b> la DAM original. Registra lo que Aduanas te pidió después (duda razonable, más tributos) como un ajuste adicional. Así ves siempre el valor declarado y el valor final por separado.</div>

        <strong class="mod-sec">Qué pasó</strong>
        <div style="display:grid; grid-template-columns:repeat(4, 1fr); gap:10px;">
          <div class="form-group" style="grid-column:span 2;"><label>Motivo</label>
            <select id="ajMotivo">${Object.entries(MOTIVOS).map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select></div>
          <div class="form-group"><label>N° de notificación</label><input type="text" id="ajNotif" maxlength="40" placeholder="118-2026-34680"></div>
          <div class="form-group"><label>Fecha de notificación</label><input type="date" id="ajFechaNotif"></div>
          <div class="form-group"><label>N° de liquidación de cobranza <small style="font-weight:400;">(llega con o después de la notificación; es lo que se paga en el banco)</small></label><input type="text" id="ajNumero" maxlength="40" placeholder="118-329439-26"></div>
          <div class="form-group"><label>Fecha de liquidación *</label><input type="date" id="ajFecha"></div>
          <div class="form-group"><label>Fecha de pago</label><input type="date" id="ajFechaPago" onchange="window.ajTC()"></div>
          <div class="form-group"><label>T.C. venta SUNAT <button type="button" class="btn btn-secondary btn-small" onclick="window.ajTC(true)" title="Consultar T.C.">⟳</button></label><input type="number" id="ajTC" step="0.001"></div>
        </div>

        <strong class="mod-sec">Diferencia de valor <small style="text-transform:none; letter-spacing:0; font-weight:400;">(duda razonable)</small></strong>
        <div style="display:grid; grid-template-columns:repeat(4, 1fr); gap:10px;">
          <div class="form-group" style="grid-column:span 2;"><label>Indicador de precios de SUNAT</label><input type="text" id="ajIndicador" maxlength="60" placeholder="118-10-2026-80787 (Item 4)"></div>
          <div class="form-group"><label>FOB unitario declarado <button type="button" class="ojo-btn" onclick="window.ajVerFuenteFOB()" title="Ver la DAM de donde sale: FOB declarado ÷ kg neto" aria-label="Ver la DAM de origen">↗</button></label><input type="number" id="ajFobDecl" step="0.000001" oninput="window.ajRecalcular()"><small id="ajFobDeclFuente" style="color:var(--text-secondary); font-size:.75rem;"></small></div>
          <div class="form-group"><label>FOB unitario de referencia</label><input type="number" id="ajFobRef" step="0.000001" oninput="window.ajRecalcular()"></div>
          <div class="form-group" style="grid-column:span 2;"><label>Valor adicional en aduana USD <small style="font-weight:400;">(referencia − declarado) × kg neto</small></label><input type="number" id="ajValorAdic" step="0.01" oninput="window.ajRecalcular(true)"></div>
          <div class="form-group" style="grid-column:span 2; align-self:end;"><button type="button" class="btn btn-secondary" data-solo-edicion onclick="window.ajEstimarTributos()">🧮 Estimar tributos con las tasas de la DAM</button></div>
        </div>

        <strong class="mod-sec">Tributos que pagaste por este ajuste</strong>
        <div style="display:grid; grid-template-columns:repeat(5, 1fr); gap:10px;">
          <div class="form-group"><label>Ad valorem USD</label><input type="number" id="ajAdv" step="0.01" oninput="window.ajRecalcular(true)"></div>
          <div class="form-group"><label>IPM USD</label><input type="number" id="ajIPM" step="0.01" oninput="window.ajRecalcular(true)"></div>
          <div class="form-group"><label>IGV USD</label><input type="number" id="ajIGV" step="0.01" oninput="window.ajRecalcular(true)"></div>
          <div class="form-group"><label>Intereses USD</label><input type="number" id="ajInt" step="0.01" oninput="window.ajRecalcular(true)"></div>
          <div class="form-group"><label>Total pagado USD</label><input type="number" id="ajTotal" step="0.01" data-siempre-lectura></div>
        </div>
        <div id="ajDestino" class="dm-nota"></div>

        <strong class="mod-sec">Garantía y estado</strong>
        <div style="display:grid; grid-template-columns:repeat(4, 1fr); gap:10px;">
          <div class="form-group"><label>Garantía</label>
            <select id="ajGarTipo"><option value="">Ninguna</option><option value="deposito">Depósito</option><option value="carta_fianza">Carta fianza</option><option value="poliza">Póliza</option></select></div>
          <div class="form-group"><label>Monto de la garantía USD</label><input type="number" id="ajGarMonto" step="0.01"></div>
          <div class="form-group"><label>Estado <span class="bl-en">(sale de los pagos; «Desestimada» se elige aquí)</span></label>
            <select id="ajEstado"><option value="pendiente">Pendiente de pago</option><option value="pagada" disabled>Pagada</option><option value="desestimada">Desestimada (se sustentó el precio)</option></select></div>
          <div id="ajPagosHost" style="grid-column:span 4;"></div>
          <div class="form-group" style="grid-column:span 4;"><label>Observaciones</label><textarea id="ajObs" rows="2"></textarea></div>
        </div>
        <div class="dm-nota" id="ajAdjuntos">📎 Adjunta la notificación, la orden de garantía y la liquidación desde «Documentos de la carpeta» (tipos: Notificación de Aduanas, Autoliquidación, Liquidación).
          <button type="button" class="btn btn-secondary btn-small" onclick="window.abrirAdjuntosCarpeta?.()">Abrir documentos</button></div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-danger" id="ajBtnEliminar" data-solo-edicion onclick="window.eliminarAjusteValor()">🗑 Eliminar</button>
        <button class="btn btn-secondary" data-solo-lectura onclick="window.cerrarAjusteValor()">Cerrar</button>
        <button class="btn btn-primary" data-solo-lectura onclick="window.ajEditar()">✏️ Editar</button>
        <button class="btn btn-secondary" data-solo-edicion onclick="window.ajCancelar()">Cancelar</button>
        <button class="btn btn-primary" data-solo-edicion onclick="window.guardarAjusteValor()">💾 Guardar ajuste</button>
      </div>
    </div>
  </div>`)
}

const CAMPOS_AJ = [
  ['ajMotivo', 'motivo'], ['ajNotif', 'numero_notificacion'], ['ajFechaNotif', 'fecha_notificacion'], ['ajNumero', 'numero'], ['ajFecha', 'fecha'],
  ['ajFechaPago', 'fecha_pago'], ['ajTC', 'tipo_cambio'], ['ajIndicador', 'indicador_precio'], ['ajFobDecl', 'fob_unitario_declarado'],
  ['ajFobRef', 'fob_unitario_referencia'], ['ajValorAdic', 'valor_adicional_usd'], ['ajAdv', 'ad_valorem_usd'], ['ajIPM', 'ipm_usd'], ['ajIGV', 'igv_usd'],
  ['ajInt', 'intereses_usd'], ['ajGarTipo', 'garantia_tipo'], ['ajGarMonto', 'garantia_monto'], ['ajEstado', 'estado'], ['ajObs', 'observaciones']
]
const NUEVAS_AJ = ['numero_notificacion', 'fecha_notificacion', 'fecha_pago', 'indicador_precio', 'fob_unitario_declarado', 'fob_unitario_referencia', 'valor_adicional_usd']

function _volcarAjuste(a) {
  for (const [id, col] of CAMPOS_AJ) { const el = $(id); if (el) el.value = a?.[col] ?? (id === 'ajMotivo' ? 'duda_razonable' : id === 'ajEstado' ? 'pendiente' : '') }
  if (!a && _dam) {   // ajuste nuevo: FOB unitario declarado = FOB de la DAM ÷ kg neto
    const kg = n0(_dam.peso_neto_kg) || n0(_ref.ci?.cantidad_total_neto)
    if (kg && n0(_dam.valor_fob)) $('ajFobDecl').value = (n0(_dam.valor_fob) / kg).toFixed(6)
  }
  if (_dam) {   // de dónde sale el FOB unitario declarado
    const kg = n0(_dam.peso_neto_kg) || n0(_ref?.ci?.cantidad_total_neto)
    const h = $('ajFobDeclFuente'); if (h) h.textContent = n0(_dam.valor_fob) && kg ? `DAM ${_dam.numero_dam}: FOB US$ ${n2(_dam.valor_fob)} ÷ ${n2(kg)} kg` : ''
  }
  window.ajRecalcular()
}

window.ajRecalcular = function (manual) {
  if (manual !== true) {   // al cambiar los FOB unitarios se recalcula el valor adicional
    const kg = n0(_dam?.peso_neto_kg) || n0(_ref.ci?.cantidad_total_neto)
    const d = num(v('ajFobDecl')), r = num(v('ajFobRef'))
    if (kg && d != null && r != null && r > d) $('ajValorAdic').value = ((r - d) * kg).toFixed(2)
  }
  const tot = n0(v('ajAdv')) + n0(v('ajIPM')) + n0(v('ajIGV')) + n0(v('ajInt'))
  $('ajTotal').value = tot ? tot.toFixed(2) : ''
  $('ajDestino').innerHTML = tot ? `Al enviarlo al costeo: ad valorem <b>$ ${n2(v('ajAdv'))}</b> → costo de la mercadería (NIC 2) · IGV + IPM <b>$ ${n2(n0(v('ajIGV')) + n0(v('ajIPM')))}</b> → crédito fiscal · intereses <b>$ ${n2(v('ajInt'))}</b> → gasto financiero. El valor adicional (<b>$ ${n2(v('ajValorAdic'))}</b>) solo es base de tributos: no se le paga al proveedor.` : ''
}

window.ajEstimarTributos = function () {
  const adic = n0(v('ajValorAdic')); if (!adic) { showToast('Primero indica el valor adicional (o los FOB unitarios)', 'warning'); return }
  const cif = n0(_dam?.valor_cif) || (n0(_dam?.valor_fob) + n0(_dam?.flete_maritimo) + n0(_dam?.seguro_maritimo))
  const tAdv = cif && n0(_dam?.ad_valorem_usd) ? n0(_dam.ad_valorem_usd) / cif : 0.06
  const base = cif + n0(_dam?.ad_valorem_usd)
  const tIgv = base && n0(_dam?.igv_usd) ? n0(_dam.igv_usd) / base : 0.155
  const tIpm = base && n0(_dam?.imp_usd) ? n0(_dam.imp_usd) / base : 0.025
  const adv = adic * tAdv
  $('ajAdv').value = adv.toFixed(2); $('ajIGV').value = ((adic + adv) * tIgv).toFixed(2); $('ajIPM').value = ((adic + adv) * tIpm).toFixed(2)
  window.ajRecalcular(true)
  showToast('Estimación con las tasas de tu DAM. Cámbiala por los montos exactos de la liquidación.', 'info')
}

window.ajTC = async function (forzar) {
  const f = v('ajFechaPago') || v('ajFecha'); if (!f) { if (forzar === true) showToast('Indica la fecha de pago', 'warning'); return }
  if (!forzar && v('ajTC')) return
  try {
    const r = await getTipoCambioDia(f, { permitirApi: forzar === true })
    if (r?.venta) $('ajTC').value = Number(r.venta).toFixed(3)
    else if (forzar === true) showToast(r?.error || 'Sin T.C. para esa fecha', 'warning')
  } catch { if (forzar === true) showToast('No se pudo consultar el T.C.', 'danger') }
}

function _pintarPagosAjuste() {
  const h = $('ajPagosHost'); if (!h) return
  h.innerHTML = _aj?.id ? window.pagosBloqueHtml?.('ajuste_valor', _aj.id, 'Pago del ajuste de valor') : '<div class="dm-nota">Guarda el ajuste para registrar su pago.</div>'
}
/** Abre la declaración de la DAM (Hoja A) encima del ajuste: ahí está el FOB declarado del que sale el unitario. */
window.ajVerFuenteFOB = async function () {
  if (!_dam) { showToast('Esta DAM aún no está registrada', 'warning'); return }
  await window.abrirDeclaracionDAM?.(_dam.id)
  const m = $('modal-dam-declaracion'); if (m) { document.body.appendChild(m); m.style.zIndex = 2300 }
}
window.abrirAjusteValor = async function (ajusteId) {
  try {
    await esperarContextoEmpresa()
    if (!($('modal-dam-carpeta')?.classList.contains('show') && _dam)) {   // abierto desde la hoja: tomar la DAM de la carpeta
      const ci = ciActual(); if (!ci) { showToast('Esta carpeta aún no tiene Commercial Invoice', 'warning'); return }
      _dam = ((await query('dams', { importacion_id: ci.id })) || [])[0] || null
      _ref = { ci, bls: (await query('bill_of_ladings', { importacion_id: ci.id })) || [] }
    }
    if (!_dam) { showToast('Primero registra la DAM de la carpeta', 'warning'); return }
    _asegurarModalAjuste()
    _aj = ajusteId ? ((await query('dam_autoliquidaciones', { id: ajusteId })) || [])[0] || null : null
    $('ajTitulo').textContent = _aj ? `Ajuste ${_aj.numero}` : `Ajustar valor · DAM ${_dam.numero_dam}`
    _volcarAjuste(_aj)
    $('ajBtnEliminar').style.display = _aj && !_aj.enviada_costeo ? '' : 'none'
    aplicarModoVerEditar('modal-dam-ajuste', !!_aj)
    if (_aj?.enviada_costeo) $('ajDestino').innerHTML += '<br>🔒 Ya está en el costeo: para corregir montos edita sus líneas en el ledger de costos.'
    { const m = $('modal-dam-ajuste'); document.body.appendChild(m); m.style.zIndex = 2100 }   // siempre por encima de la DAM abierta
    window.openModal('modal-dam-ajuste')
    _pintarPagosAjuste()
  } catch (e) { console.error('abrirAjusteValor:', e); showToast('No se pudo abrir el ajuste', 'danger') }
}
window.ajEditar = () => {
  aplicarModoVerEditar('modal-dam-ajuste', false)
  if (_aj?.enviada_costeo) ['ajAdv', 'ajIPM', 'ajIGV', 'ajInt', 'ajEstado'].forEach(id => { $(id).disabled = true })
}
window.ajCancelar = () => { if (_aj) { _volcarAjuste(_aj); aplicarModoVerEditar('modal-dam-ajuste', true) } else window.cerrarAjusteValor() }
window.cerrarAjusteValor = async () => {
  window.closeModal('modal-dam-ajuste')
  if ($('modal-dam-carpeta')?.classList.contains('show')) await _pintarAjustes()
  window.renderHojaCosteo?.()
}

window.guardarAjusteValor = async function () {
  try {
    if (!_dam) throw new Error('Falta la DAM')
    if (!v('ajNumero') && !v('ajNotif')) throw new Error('Indica el N° de notificación o el N° de liquidación')
    if (!v('ajNumero') && v('ajEstado') === 'pagada') throw new Error('Un ajuste pagado necesita el N° de la liquidación de cobranza que se pagó')
    if (!v('ajFecha')) throw new Error('Falta la fecha de liquidación')
    if (v('ajEstado') === 'pagada' && !v('ajFechaPago')) throw new Error('Un ajuste pagado necesita su fecha de pago')
    if (v('ajEstado') === 'pagada' && n0(v('ajTotal')) > 0 && !(n0(v('ajTC')) >= 1)) throw new Error('Ingresa el T.C. venta SUNAT (usa ⟳)')
    const fila = { dam_id: _dam.id }
    for (const [id, col] of CAMPOS_AJ) {
      const val = v(id)
      fila[col] = val === '' ? null : (/^(tipo_cambio|ad_valorem|ipm|igv|intereses|valor_adicional|fob_unitario|garantia_monto)/.test(col) ? num(val) : val)
    }
    for (const k of ['ad_valorem_usd', 'ipm_usd', 'igv_usd', 'intereses_usd', 'valor_adicional_usd']) if (fila[k] == null) fila[k] = 0
    if (!fila.garantia_tipo) { fila.garantia_tipo = null; fila.garantia_monto = 0 }
    const { res, quitadas, error } = await _guardarTolerante('dam_autoliquidaciones', _aj?.id, fila)
    if (!res) throw new Error(/duplicate|unique/i.test(error || '') ? 'Ya existe un ajuste con ese N° de liquidación en esta DAM' : (error || 'No se pudo guardar el ajuste'))
    if (quitadas.some(c => NUEVAS_AJ.includes(c))) showToast('Ajuste guardado SIN algunos campos: falta correr assets/sql/104_dam_levante_ajustes_declaracion.sql', 'warning')
    else showToast('Ajuste guardado', 'success')
    await window.cerrarAjusteValor()
  } catch (e) { showToast(e.message || 'No se pudo guardar el ajuste', 'danger') }
}

window.eliminarAjusteValor = async function () {
  if (!_aj || _aj.enviada_costeo) return
  if (!confirm('¿Eliminar este ajuste? (La DAM original no se toca)')) return
  const ok = await deleteRecord('dam_autoliquidaciones', _aj.id)
  if (!ok) { showToast('No se pudo eliminar el ajuste', 'danger'); return }
  showToast('Ajuste eliminado', 'success')
  await window.cerrarAjusteValor()
}

// ── Enviar el ajuste al costeo (ledger) ────────────────────────────────────
window.enviarAjusteCosteo = async function (ajusteId) {
  try {
    const a = ((await query('dam_autoliquidaciones', { id: ajusteId })) || [])[0]
    if (!a) throw new Error('Ajuste no encontrado')
    if (a.enviada_costeo) { showToast('Este ajuste ya está en el costeo', 'info'); return }
    if (a.estado !== 'pagada') throw new Error('Solo se envía al costeo un ajuste pagado')
    const c = carpeta(); if (!c) throw new Error('Sin carpeta de importación')
    const tc = n0(a.tipo_cambio); if (tc < 1) throw new Error('El ajuste no tiene T.C.: edítalo y usa ⟳')
    const lineas = [
      ['ad_valorem_adic', 'Ad Valorem adicional (' + (MOTIVOS[a.motivo] || 'ajuste') + ')', 'tributos', 'inventario', n0(a.ad_valorem_usd)],
      ['igv', 'IGV adicional (' + (MOTIVOS[a.motivo] || 'ajuste') + ')', 'tributos', 'credito_fiscal', n0(a.igv_usd)],
      ['ipm', 'IPM adicional (' + (MOTIVOS[a.motivo] || 'ajuste') + ')', 'tributos', 'credito_fiscal', n0(a.ipm_usd)],
      ['interes', 'Intereses de la liquidación ' + a.numero, 'financiero', 'gasto_financiero', n0(a.intereses_usd)]
    ].filter(l => l[4] > 0)
    if (!lineas.length) throw new Error('El ajuste no tiene montos que enviar')
    const total = lineas.reduce((t, l) => t + l[4], 0)
    const lista = lineas.map(l => `  · ${l[1]}: $ ${n2(l[4])}`).join('\n')
    if (!confirm(`Se crearán ${lineas.length} línea(s) en el costeo de la carpeta ${c.numero_carpeta}:\n${lista}\n\nTotal $ ${n2(total)} · T.C. ${tc}. ¿Continuar?`)) return
    const user = await getCurrentUser()
    const fechaDoc = a.fecha_pago || a.fecha
    const doc = {
      tipo: 'autoliquidacion', tipo_comprobante: '50', numero: a.numero, proveedor_id: null, fecha_emision: fechaDoc,
      moneda: 'USD', tipo_cambio: tc, monto_sin_igv: total, igv_monto: 0, monto_total: total, estado_pago: 'pagado',
      es_provisional: false, sustentado: true, observaciones: 'Liquidación SUNAT · ' + (MOTIVOS[a.motivo] || a.motivo) + (a.numero_notificacion ? ' · Notif. ' + a.numero_notificacion : ''),
      empresa_id: c.empresa_id ?? undefined
    }
    let documentoId = null
    for (const [cod, nombre, grupo, clasif, monto] of lineas) {
      const linea = {
        carpeta_importacion_id: c.id, grupo, concepto: nombre, concepto_codigo: cod, clasificacion: clasif,
        moneda: 'USD', tipo_cambio: tc, monto_moneda: monto, igv_monto: 0, base_prorrateo: 'valor_fob',
        es_provisional: false, observaciones: 'Generado desde el ajuste de valor de la DAM'
      }
      const r = await crearLineaCosto(documentoId ? { id: documentoId } : doc, linea, user?.db_id)
      documentoId = r.documentoId
    }
    await update('dam_autoliquidaciones', a.id, { enviada_costeo: true })
    showToast(`Listo: ${lineas.length} línea(s) en el costeo`, 'success')
    await _pintarAjustes()
    window.renderHojaCosteo?.(); window.renderCostosLedger?.()
  } catch (e) { console.error('enviarAjusteCosteo:', e); showToast(e.message || 'No se pudo enviar al costeo', 'danger') }
}

// ── Enviar los tributos de la DAM ORIGINAL al costeo (ledger) ────────────────
window.enviarDAMCosteo = async function () {
  try {
    const d = _dam; if (!d) throw new Error('Guarda primero la DAM')
    if (d.estado !== 'pagado') throw new Error('La DAM debe estar pagada (con fecha de pago y T.C.) para enviar sus tributos')
    const c = carpeta(); if (!c) throw new Error('Sin carpeta de importación')
    const tc = n0(d.tipo_cambio); if (tc < 1) throw new Error('La DAM no tiene T.C.: edítala y usa ⟳')
    const previas = ((await query('importacion_costos', { carpeta_importacion_id: c.id })) || [])
      .filter(k => !k.anulado && ['ad_valorem', 'igv', 'ipm', 'percepcion'].includes(k.concepto_codigo) && !/adicional/i.test(k.concepto || ''))
    if (previas.length) throw new Error(`El costeo ya tiene ${previas.length} línea(s) de tributos de esta carpeta. Para no duplicar, revísalas en «Costos» antes de enviar.`)
    const lineas = [
      ['ad_valorem', 'Ad Valorem', 'tributos', 'inventario', n0(d.ad_valorem_usd), 'USD'],
      ['igv', 'IGV importación', 'tributos', 'credito_fiscal', n0(d.igv_usd), 'USD'],
      ['ipm', 'IPM', 'tributos', 'credito_fiscal', n0(d.imp_usd), 'USD'],
      ['percepcion', 'Percepción IGV importación', 'tributos', 'percepcion', n0(d.percepcion), 'PEN']
    ].filter(l => l[4] > 0)
    if (!lineas.length) throw new Error('La DAM no tiene tributos para enviar')
    const lista = lineas.map(l => `  · ${l[1]}: ${l[5] === 'PEN' ? 'S/' : '$'} ${n2(l[4])}`).join('\n')
    if (!confirm(`Se crearán ${lineas.length} línea(s) de tributos en el costeo de la carpeta ${c.numero_carpeta}:\n${lista}\n\nT.C. ${tc}. ¿Continuar?`)) return
    const user = await getCurrentUser()
    const total = n0(d.ad_valorem_usd) + n0(d.igv_usd) + n0(d.imp_usd)
    const doc = {
      tipo: 'dam', tipo_comprobante: '50', numero: d.numero_dam, proveedor_id: null, fecha_emision: d.fecha_pago || d.fecha_dam,
      moneda: 'USD', tipo_cambio: tc, monto_sin_igv: total, igv_monto: 0, monto_total: total, estado_pago: 'pagado',
      es_provisional: false, sustentado: true, observaciones: 'Tributos de la DAM ' + d.numero_dam, empresa_id: c.empresa_id ?? undefined
    }
    let documentoId = null
    for (const [cod, nombre, grupo, clasif, monto, mon] of lineas) {
      const r = await crearLineaCosto(documentoId ? { id: documentoId } : doc, {
        carpeta_importacion_id: c.id, grupo, concepto: nombre, concepto_codigo: cod, clasificacion: clasif,
        moneda: mon, tipo_cambio: tc, monto_moneda: monto, igv_monto: 0, base_prorrateo: 'valor_fob', es_provisional: false,
        observaciones: 'Generado desde la DAM'
      }, user?.db_id)
      documentoId = r.documentoId
    }
    showToast(`Listo: ${lineas.length} línea(s) de tributos en el costeo`, 'success')
    window.renderHojaCosteo?.(); window.renderCostosLedger?.()
  } catch (e) { console.error('enviarDAMCosteo:', e); showToast(e.message || 'No se pudo enviar al costeo', 'danger') }
}

export default { cargarAjustes, CANALES, MOTIVOS }
