// ============================================================================
// compras/cuenta-gasto-nueva.js — Crear una CUENTA DE GASTO (clase 6) sin salir de Compras
// ============================================================================
// Entradas:
//   · selector "Cuenta de gasto" del modal de servicio → opción "+ Nueva cuenta de gasto"
//   · Compras → Configuración → "Cuentas de gasto" → botón "Nueva cuenta de gasto"
//
// REGLAS (PCGE Perú / buenas prácticas, acordadas con Luis 2026-11-23):
//   · La cuenta CUELGA de un grupo oficial (632 Asesoría, 635 Alquileres…): el
//     código debe empezar con el código del grupo; el sistema sugiere el
//     siguiente libre siguiendo el patrón de las cuentas hermanas (misma longitud).
//   · Hereda de una cuenta hermana: tipo, categoría, nivel, subgrupo, naturaleza
//     deudora (así los reportes la clasifican igual que sus vecinas).
//   · SOLO PEN: los libros se llevan en soles; el gasto en USD se convierte con
//     el T.C. del día. Los pares PEN/USD son para cuentas monetarias (caja, bancos, CxP).
//   · BLOQUEADO crear en 60 (compras), 61 (variación de existencias) y 69 (costo de
//     ventas): las alimentan inventario y costeo; crearlas a mano descuadra el costo.
//   · 609 (costos vinculados a compras: flete, seguro, derechos) se permite con aviso:
//     normalmente va al costo del inventario vía costeo de importaciones (NIC 2).
//   · El plan de cuentas es GLOBAL (sin columna empresa): la cuenta nueva la ven
//     Jhiro y Benji. Se desactiva, no se borra.
//
// NOTA PARA LA SESIÓN DE CONTABILIDAD: estas cuentas nacen con saldo 0 y sin
// asociación a empresa; el mapeo concepto→cuenta de los asientos de compra de
// servicio sale del código elegido en csCuentaGasto.
// ============================================================================

import { getAccounts } from '../supabase-data.js'
import { insert, ultimoErrorInsert } from '../supabase-client.js'
import { showToast } from '../helpers.js'
import { refrescarBuscador } from '../buscador-select.js'
import { _escCompras as esc } from './buscadores.js'

// Grupos oficiales (PCGE) ofrecidos. Los de 60/61/69 NO están (bloqueados).
const GRUPOS = [
  { cod: '609', nombre: 'Costos vinculados con las compras', aviso: 'Flete, seguro y derechos de aduana de una compra de mercadería son costo del inventario (NIC 2), no gasto: normalmente se cargan por el costeo de importaciones. Crea aquí solo si tu contador lo indica.' },
  { cod: '631', nombre: 'Transporte, correos y gastos de viaje' },
  { cod: '632', nombre: 'Asesoría y consultoría' },
  { cod: '633', nombre: 'Producción encargada a terceros' },
  { cod: '634', nombre: 'Mantenimiento y reparaciones' },
  { cod: '635', nombre: 'Alquileres' },
  { cod: '636', nombre: 'Servicios básicos (luz, agua, internet, teléfono)' },
  { cod: '637', nombre: 'Publicidad, publicaciones y relaciones públicas' },
  { cod: '638', nombre: 'Servicios de contratistas' },
  { cod: '639', nombre: 'Otros servicios prestados por terceros' },
  { cod: '641', nombre: 'Tributos — gobierno central' },
  { cod: '643', nombre: 'Tributos — gobierno local' },
  { cod: '651', nombre: 'Seguros' },
  { cod: '653', nombre: 'Suscripciones' },
  { cod: '654', nombre: 'Licencias y derechos de vigencia' },
  { cod: '656', nombre: 'Suministros' },
  { cod: '659', nombre: 'Otras cargas de gestión' },
  { cod: '671', nombre: 'Gastos en operaciones de endeudamiento y otros' },
  { cod: '679', nombre: 'Otros gastos financieros (comisiones bancarias)' }
]

const norm = t => String(t ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/\s+/g, ' ').trim()
const esClase6 = a => String(a.codigo || '').trim().startsWith('6')

function _masFrecuente(arr, def) {
  const c = {}; arr.forEach(x => { c[x] = (c[x] || 0) + 1 })
  const k = Object.entries(c).sort((a, b) => b[1] - a[1])[0]
  return k ? Number(k[0]) : def
}

/** Propone el siguiente código libre bajo `grupo`, con la longitud de las cuentas hermanas. */
export function sugerirCodigoCuentaGasto(grupo, cuentas) {
  const codigos = cuentas.map(a => String(a.codigo).trim())
  const hijas = codigos.filter(c => c.startsWith(grupo) && c !== grupo)
  const largo = hijas.length ? _masFrecuente(hijas.map(c => c.length), 6)
                             : _masFrecuente(codigos.filter(c => c.startsWith('6') && c.length >= 6).map(c => c.length), 6)
  const mismas = hijas.filter(c => c.length === largo).map(c => BigInt(c))
  let n = mismas.length ? mismas.reduce((m, x) => (x > m ? x : m)) + 1n : BigInt(grupo + '1'.repeat(Math.max(largo - grupo.length, 1)))
  const usados = new Set(codigos)
  while (usados.has(String(n))) n += 1n
  const cod = String(n)
  return cod.startsWith(grupo) && cod.length === largo ? cod : ''   // '' = se agotó la serie: escribir a mano
}

/** Fila a insertar: clona la cuenta hermana más cercana (hereda clasificación). */
function _filaNueva({ grupo, codigo, nombre }, cuentas) {
  const g = GRUPOS.find(x => x.cod === grupo)
  const c6 = cuentas.filter(a => esClase6(a) && a.naturaleza_saldo === 'deudor')
  const hermana = c6.find(a => String(a.codigo).trim().startsWith(grupo)) ||
                  c6.find(a => String(a.codigo).trim().startsWith(grupo.slice(0, 2))) || c6[0]
  if (!hermana) throw new Error('No hay ninguna cuenta de gasto en tu plan para tomar como modelo.')
  const mismoGrupo = String(hermana.codigo).trim().startsWith(grupo)
  const padreExiste = cuentas.some(a => String(a.codigo).trim() === grupo)
  return {
    codigo, nombre,
    tipo: hermana.tipo,
    categoria_balance: hermana.categoria_balance,
    nivel: hermana.nivel,
    codigo_padre: padreExiste ? grupo : (mismoGrupo && hermana.codigo_padre ? hermana.codigo_padre : grupo),
    moneda: 'PEN',
    permite_conciliacion: false,
    grupo_reporte: hermana.grupo_reporte,
    subgrupo: hermana.subgrupo,
    subgrupo_fino: mismoGrupo ? hermana.subgrupo_fino : g.nombre,
    naturaleza_saldo: 'deudor',
    saldo_debe: 0, saldo_haber: 0, activo: true
  }
}

const $ = id => document.getElementById(id)

function _asegurarModal() {
  if ($('modal-cuenta-gasto')) return
  document.body.insertAdjacentHTML('beforeend', `
  <div id="modal-cuenta-gasto" class="modal" style="z-index:2500;">
    <div class="modal-content" style="width:min(96vw, 560px); max-width:min(96vw, 560px);">
      <div class="modal-header">
        <h3 class="modal-title">➕ Nueva cuenta de gasto</h3>
        <button class="modal-close" onclick="closeModal('modal-cuenta-gasto')">&times;</button>
      </div>
      <div style="padding:14px 20px;">
        <div class="form-group">
          <label>Grupo (plan contable) *</label>
          <select id="cgGrupo" onchange="window._cgGrupoCambio()">
            <option value="">— Elige el tipo de gasto —</option>
            ${GRUPOS.map(g => `<option value="${g.cod}">${g.cod} · ${esc(g.nombre)}</option>`).join('')}
          </select>
          <small style="color:var(--text-secondary);">La cuenta nueva cuelga de este grupo. No se crean cuentas en 60, 61 ni 69: las mueven inventario y costeo.</small>
        </div>
        <div id="cgAviso" class="dm-nota" style="display:none; margin-bottom:10px;"></div>
        <div class="form-group">
          <label>Nombre de la cuenta *</label>
          <input type="text" id="cgNombre" maxlength="120" placeholder="Ej: SERVICIO DE VIGILANCIA" oninput="window._cgResumen()">
        </div>
        <div class="form-group">
          <label>Código *</label>
          <div style="display:flex; gap:8px; align-items:center;">
            <input type="text" id="cgCodigo" inputmode="numeric" maxlength="9" style="max-width:160px;" oninput="window._cgResumen()">
            <button type="button" class="btn btn-secondary btn-small" onclick="window._cgGrupoCambio()" title="Volver al código sugerido">↻ Sugerido</button>
          </div>
        </div>
        <div id="cgResumen" class="dm-nota" style="font-size:0.85rem;"></div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" onclick="closeModal('modal-cuenta-gasto')">Cancelar</button>
        <button class="btn btn-primary" id="cgBtnGuardar" onclick="window._cgGuardar()">Crear cuenta</button>
      </div>
    </div>
  </div>`)
}

let _cuentas = []
let _alCrear = null

window.abrirModalCuentaGasto = async function (opciones = {}) {
  _alCrear = opciones.alCrear || null
  _asegurarModal()
  _cuentas = await getAccounts() || []
  $('cgGrupo').value = ''; $('cgNombre').value = ''; $('cgCodigo').value = ''; $('cgAviso').style.display = 'none'
  window._cgResumen()
  window.openModal('modal-cuenta-gasto')
}

window._cgGrupoCambio = function () {
  const grupo = $('cgGrupo').value
  const g = GRUPOS.find(x => x.cod === grupo)
  const av = $('cgAviso')
  av.style.display = g?.aviso ? '' : 'none'; av.textContent = g?.aviso || ''
  $('cgCodigo').value = grupo ? sugerirCodigoCuentaGasto(grupo, _cuentas) : ''
  window._cgResumen()
}

window._cgResumen = function () {
  const grupo = $('cgGrupo').value, cod = $('cgCodigo').value.trim(), nom = $('cgNombre').value.trim()
  const g = GRUPOS.find(x => x.cod === grupo)
  $('cgResumen').innerHTML = g
    ? `Se creará <strong>${esc(cod || '—')}</strong> · ${esc(nom || '—')}<br>Gasto de naturaleza <strong>deudora</strong>, en <strong>PEN</strong>, dentro de <strong>${g.cod} ${esc(g.nombre)}</strong>. El plan de cuentas es único: la verán Jhiro y Benji.`
    : 'Elige el grupo para ver el código sugerido.'
}

function _validar() {
  const grupo = $('cgGrupo').value, cod = $('cgCodigo').value.trim(), nombre = $('cgNombre').value.trim().replace(/\s+/g, ' ')
  if (!grupo) return { error: 'Elige el grupo del plan contable.' }
  if (nombre.length < 3) return { error: 'Escribe el nombre de la cuenta.' }
  if (!/^\d+$/.test(cod)) return { error: 'El código solo lleva dígitos.' }
  if (!cod.startsWith(grupo) || cod === grupo) return { error: `El código debe empezar con ${grupo} y tener más dígitos (ej. ${sugerirCodigoCuentaGasto(grupo, _cuentas) || grupo + '101'}).` }
  if (cod.length > 9) return { error: 'El código es demasiado largo (máximo 9 dígitos).' }
  if (_cuentas.some(a => String(a.codigo).trim() === cod)) return { error: `Ya existe una cuenta con el código ${cod}.` }
  const dup = _cuentas.find(a => String(a.codigo).trim().startsWith(grupo) && norm(a.nombre) === norm(nombre))
  if (dup) return { error: `Ya existe "${dup.nombre}" (${dup.codigo}) en ese grupo: úsala en vez de crear otra.` }
  return { grupo, cod, nombre }
}

window._cgGuardar = async function () {
  const v = _validar()
  if (v.error) { showToast(v.error, 'warning'); return }
  const btn = $('cgBtnGuardar'); if (btn.disabled) return
  btn.disabled = true
  try {
    const fila = _filaNueva({ grupo: v.grupo, codigo: v.cod, nombre: v.nombre }, _cuentas)
    const creada = await insert('plan_cuentas', fila)
    if (!creada) {
      const e = ultimoErrorInsert?.()
      showToast('No se pudo crear la cuenta' + (e?.mensaje ? ': ' + e.mensaje : ' (¿código duplicado?)'), 'danger', 7000)
      return
    }
    window.closeModal('modal-cuenta-gasto')
    showToast(`Cuenta ${v.cod} creada`, 'success')
    // Refresca el selector del modal de servicio y deja la cuenta elegida
    const { cargarCuentasGastoSelect } = await import('./formularios.js')
    await cargarCuentasGastoSelect()
    const sel = $('csCuentaGasto')
    if (sel) { sel.value = v.cod; refrescarBuscador(sel) }
    window.dispatchEvent(new CustomEvent('zv-cuenta-gasto-creada', { detail: { codigo: v.cod } }))
    if (typeof _alCrear === 'function') _alCrear(creada)
  } catch (e) {
    console.error('Error creando cuenta de gasto:', e)
    showToast(e.message || 'Error al crear la cuenta', 'danger')
  } finally { btn.disabled = false }
}

// ----------------------------------------------------------------------------
// Sección de Configuración de Compras: guía + lista + botón
// ----------------------------------------------------------------------------
export async function montarCuentasGastoConfig(contenedorId) {
  const cont = $(contenedorId); if (!cont) return
  const pintar = async () => {
    const cuentas = (await getAccounts() || []).filter(esClase6)
      .sort((a, b) => String(a.codigo).localeCompare(String(b.codigo), 'es', { numeric: true }))
    const q = norm($(contenedorId + '-q')?.value || '')
    const vis = q ? cuentas.filter(a => norm(a.codigo + ' ' + a.nombre).includes(q)) : cuentas
    cont.innerHTML = `
      <div class="dm-nota" style="margin-bottom:8px;">
        <strong>Cómo elegir bien:</strong> servicios facturados por terceros van en <strong>63</strong> (632 asesoría, 634 mantenimiento, 635 alquileres, 636 servicios básicos…).
        Flete, seguro y aduana de una <em>compra de mercadería</em> son <strong>costo del inventario</strong> (609/costeo), no gasto 63.
        Un gasto es deducible si cumple causalidad y tiene comprobante a tu nombre; pagos desde S/ 2,000 (o US$ 500) deben hacerse por medio bancarizado.
        Los libros van en soles (cuentas nuevas solo PEN). Valida con tu contador los casos dudosos.
      </div>
      <div style="display:flex; gap:8px; align-items:center; margin-bottom:8px; flex-wrap:wrap;">
        <input type="text" id="${contenedorId}-q" value="${esc($(contenedorId + '-q')?.value || '')}" placeholder="Buscar cuenta o código…" style="max-width:260px;">
        <button type="button" class="btn btn-primary btn-small" id="${contenedorId}-nueva">➕ Nueva cuenta de gasto</button>
        <small style="color:var(--text-secondary);">${vis.length} de ${cuentas.length} cuentas de la clase 6</small>
      </div>
      <div style="max-height:320px; overflow:auto;">
        <table style="width:100%;"><thead><tr><th>Código</th><th>Nombre</th><th>Grupo</th><th>Estado</th></tr></thead>
        <tbody>${vis.map(a => `<tr><td><strong>${esc(a.codigo)}</strong></td><td>${esc(a.nombre)}</td><td>${esc(a.subgrupo_fino || a.subgrupo || '')}</td><td>${a.activo === false ? 'Inactiva' : 'Activa'}</td></tr>`).join('') || '<tr><td colspan="4">Sin resultados</td></tr>'}</tbody></table>
      </div>`
    $(contenedorId + '-nueva').onclick = () => window.abrirModalCuentaGasto({ alCrear: pintar })
    const qi = $(contenedorId + '-q'); qi.oninput = () => { const pos = qi.selectionStart; pintar().then(() => { const n = $(contenedorId + '-q'); n.focus(); n.setSelectionRange(pos, pos) }) }
  }
  await pintar()
}
