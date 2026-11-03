// ============================================================================
// LIBRO-CAJA.JS — Grilla editable estilo Excel
// ----------------------------------------------------------------------------
// La tesorera lleva años en una hoja de cálculo. Esto no imita el LOOK de
// Excel: imita sus GESTOS. Escribir directo en la celda, Tab para avanzar,
// la fila en blanco al final que crea el registro, la cabecera que no se va
// al hacer scroll, pegar un bloque desde Excel.
//
// MODELO: lee de la vista `v_libro_caja` (SQL 125), que une movimientos_banco
// con gastos. Una fila puede ser:
//   · egreso con gasto detrás  → compra de caja chica (la mayoría)
//   · ingreso sin gasto        → reposición, vuelto, reembolso recibido
//
// POR QUÉ NO ES SOLO "GASTOS": el Excel real tiene columna Ingreso (REC-124,
// REC-126…). Una grilla que solo escribiera gastos dejaría fuera la mitad de
// las filas y el saldo corrido nunca cuadraría.
// ============================================================================

import { supabase, insert, update, deleteRecord, ultimoErrorInsert, esperarContextoEmpresa } from '../supabase-client.js'
import { getCurrentUser } from '../auth-supabase.js'
import { getContacts } from '../supabase-data.js'
import { showToast, formatNumber, fechaDMY } from '../helpers.js'
import { menuAccionesFila } from '../main.js'
import { empresasDisponibles, empresaTrabajo } from '../empresa.js'

// ── Estado ──────────────────────────────────────────────────────────────────
let _cajaSel = ''          // '' = todas las cajas
let _filas = []
let _nueva = {}            // borrador de la fila en blanco del final
let _edit = null           // { idx, key }  idx === -1 → fila nueva
let _orden = { key: 'fecha', dir: 'asc' }
let _cat = { cajas: [], tiposDoc: [], categorias: [], contactos: [] }
let _panelCat = null
let _montado = false
let _pegando = false     // true mientras corre un pegado masivo

// Anchos ajustados a mano, por columna. Se guardan igual que el menú de
// columnas: la tesorera acomoda la tabla una vez y la encuentra así siempre.
const LS_ANCHOS = 'libroCajaAnchos'
let _anchos = (() => {
  try { return JSON.parse(localStorage.getItem(LS_ANCHOS) || '{}') || {} } catch { return {} }
})()
/**
 * Escala de fuente del usuario (Configuración → tamaño de texto). Los anchos
 * por defecto están calculados para escala 1; con 1.25 el mismo texto necesita
 * 25% más de columna o se trunca ("Octubre" salía "Oc…").
 */
function _escalaFuente() {
  const v = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--font-scale'))
  return (isNaN(v) || v <= 0) ? 1 : v
}
/** Ancho guardado por el usuario (píxeles reales, no se reescalan) o el
 *  por defecto ajustado a su escala de fuente. */
function _anchoDe(col) {
  const guardado = Number(_anchos[col.k])
  if (guardado) return guardado
  return Math.round(col.w * _escalaFuente())
}
function _guardarAnchos() {
  try { localStorage.setItem(LS_ANCHOS, JSON.stringify(_anchos)) } catch {}
}
window.lcResetAnchos = function () {
  _anchos = {}; _guardarAnchos(); _render()
  showToast('Anchos restablecidos', 'success', 1500)
}

const AMBITOS = { empresa: 'Empresa', familiar: 'Familiar' }
const DESTINOS = {
  gasto_operativo: 'Gasto operativo',
  costo_venta: 'Costo de venta',
  viatico_reembolsable: 'Viático reembolsable',
  gasto_personal: 'Gasto de personal',
  no_deducible: 'No deducible'
}

// ── Columnas ────────────────────────────────────────────────────────────────
// Las "generales" son las del Excel de la tesorera, en su mismo orden.
// Las "especiales" van al final, detrás del separador, para que la tabla
// muestre lo cotidiano sin scroll y lo avanzado quede a mano con la barra.
const COLS = [
  { k: 'mes_nombre',            t: 'Mes',        tipo: 'texto',    ro: true,  w: 84 },
  { k: 'fecha',                 t: 'Fecha',      tipo: 'fecha',    w: 106 },
  { k: 'numero_recibo',         t: 'N° Recibo',  tipo: 'texto',    w: 92 },
  { k: 'tipo_documento_id',     t: 'Tipo Doc',   tipo: 'catalogo', cat: 'tiposDoc',   w: 98 },
  { k: 'categoria_gasto_id',    t: 'Categoría',  tipo: 'catalogo', cat: 'categorias', w: 150 },
  { k: 'responsable_contact_id',t: 'Responsable',tipo: 'catalogo', cat: 'contactos',  w: 104 },
  { k: 'detalle',               t: 'Detalle',    tipo: 'texto',    w: 300 },
  { k: 'ingreso',               t: 'Ingreso',    tipo: 'numero',   w: 86 },
  { k: 'egreso',                t: 'Egreso',     tipo: 'numero',   w: 86 },
  { k: 'saldo',                 t: 'Saldo',      tipo: 'calc',     ro: true,  w: 96, soloUnaCaja: true },
  // ── a partir de aquí, las especiales
  { k: 'caja_nombre',  t: 'Caja',     tipo: 'texto', ro: true, w: 112, soloVariasCajas: true, especial: true },
  { k: 'ambito',       t: 'Ámbito',   tipo: 'enum',  opciones: AMBITOS,  w: 84, especial: true },
  { k: 'destino_costo',t: 'Destino',  tipo: 'enum',  opciones: DESTINOS, w: 118, especial: true },
  { k: 'deducible',    t: 'Ded.',     tipo: 'bool',  w: 46,  especial: true },
  { k: 'adjuntos',     t: '📎',       tipo: 'texto', ro: true, w: 38,  especial: true },
  { k: 'nota',         t: 'Nota',     tipo: 'texto', w: 110, especial: true }
]

// ── Utilidades ──────────────────────────────────────────────────────────────
const _esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const _hoyISO = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Lima' })
const _num = v => {
  // Acepta "S/ 3.000,00" (Perú/Excel), "3,000.50" (US) y "600,00".
  let t = String(v ?? '').replace(/[^\d.,-]/g, '')
  const c = t.lastIndexOf(','), d = t.lastIndexOf('.')
  if (c >= 0 && d >= 0) t = c > d ? t.replace(/\./g, '').replace(',', '.') : t.replace(/,/g, '')
  else if (c >= 0) t = /,\d{1,2}$/.test(t) ? t.replace(',', '.') : t.replace(/,/g, '')
  const n = Number(t); return isNaN(n) ? 0 : n
}
const _simbolo = m => (m === 'USD' ? '$' : 'S/')

/** Color estable a partir de un texto: los responsables no tienen catálogo
 *  propio (son `contacts`), pero igual necesitan un chip reconocible. */
function _colorDeTexto(txt) {
  let h = 0
  for (const ch of String(txt || '')) h = (h * 31 + ch.charCodeAt(0)) % 360
  return `hsl(${h} 58% 42%)`
}

function _colsVisibles() {
  const unaCaja = !!_cajaSel
  return COLS.filter(c => {
    if (c.soloUnaCaja && !unaCaja) return false
    if (c.soloVariasCajas && unaCaja) return false
    return true
  })
}

function _cajaById(id) { return _cat.cajas.find(c => c.id === Number(id)) || null }

/**
 * Mes y año con los que se abre una celda de fecha vacía.
 * Prioridad: lo que ya se escribió en la fila nueva → la última fila cargada
 * en pantalla → hoy. La fila anterior manda sobre "hoy" porque cargando el
 * Excel de octubre en noviembre, "hoy" obligaría a corregir mes y año en cada
 * fila, que es justo lo que se quiere evitar.
 */
function _fechaSugerida() {
  if (_nueva.fecha) return _nueva.fecha
  const ultima = _filas.length ? _filas[_filas.length - 1].fecha : null
  return ultima || _hoyISO()
}
function _monedaActual() { return _cajaSel ? (_cajaById(_cajaSel)?.moneda || 'PEN') : null }

// ============================================================================
// CARGA
// ============================================================================
async function _cargarCatalogos() {
  await esperarContextoEmpresa()
  const [cajas, tipos, cats, contactos] = await Promise.all([
    supabase.from('bancos').select('*').neq('activo', false).order('nombre'),
    supabase.from('tipos_documento_gasto').select('*').neq('activo', false).order('orden'),
    supabase.from('categorias_gasto').select('*').neq('activo', false).order('orden'),
    getContacts()
  ])
  if (tipos.error) showToast('Falta correr assets/sql/125_libro_caja.sql', 'error', 7000)
  _cat = {
    cajas: cajas.data || [],
    tiposDoc: tipos.data || [],
    categorias: cats.data || [],
    contactos: (contactos || []).map(c => ({ id: c.id, nombre: c.nombre }))
  }
}

async function _cargarFilas() {
  let q = supabase.from('v_libro_caja').select('*')
  if (_cajaSel) q = q.eq('caja_id', Number(_cajaSel))

  const desde = document.getElementById('lcDesde')?.value
  const hasta = document.getElementById('lcHasta')?.value
  if (desde) q = q.gte('fecha', desde)
  if (hasta) q = q.lte('fecha', hasta)

  const { data, error } = await q
    .order('fecha', { ascending: true })
    .order('orden', { ascending: true, nullsFirst: false })
    .order('movimiento_id', { ascending: true })
  if (error) {
    document.getElementById('lcGrid').innerHTML =
      `<p class="reporte-vacio" style="padding:16px;">${/does not exist/i.test(error.message)
        ? 'Falta correr assets/sql/125_libro_caja.sql'
        : _esc(error.message)}</p>`
    return false
  }
  _filas = data || []

  const buscar = (document.getElementById('lcBuscar')?.value || '').toLowerCase().trim()
  if (buscar) {
    const pal = buscar.split(/\s+/).filter(Boolean)
    _filas = _filas.filter(f => {
      const blob = [f.numero_recibo, f.detalle, f.categoria, f.responsable,
                    f.tipo_documento, f.caja_nombre, f.ingreso, f.egreso].join(' ').toLowerCase()
      return pal.every(p => blob.includes(p))
    })
  }
  return true
}

// ============================================================================
// RENDER
// ============================================================================
function _render() {
  _calcularSaldoCorrido()
  _pintarTotales()
  _pintarAviso()

  const cols = _colsVisibles()
  const idxPrimeraEspecial = cols.findIndex(c => c.especial)

  const thead = `<thead><tr>
    <th style="width:26px; min-width:26px;"></th>
    ${cols.map((c, i) => `
      <th class="lc-th${i === idxPrimeraEspecial ? ' lc-inicio-especial' : ''}${_orden.key === c.k ? ' lc-activa' : ''}"
          style="width:${_anchoDe(c)}px; min-width:${_anchoDe(c)}px;" data-k="${c.k}">
        <span class="lc-th-txt" onclick="window.lcOrdenar('${c.k}')">${_esc(c.t)}<span class="lc-orden-ind">${_orden.key === c.k ? (_orden.dir === 'asc' ? '▲' : '▼') : '⇅'}</span></span>
        <span class="lc-resizer" data-k="${c.k}" title="Arrastra para cambiar el ancho · doble clic para ajustar al contenido"></span>
      </th>`).join('')}
    <th class="lc-acciones">⋮</th>
  </tr></thead>`

  const filasOrdenadas = _ordenar(_filas)

  const tbody = `<tbody>
    ${filasOrdenadas.map((f, i) => _filaHTML(f, _filas.indexOf(f), cols, idxPrimeraEspecial)).join('')}
    ${_filaNuevaHTML(cols, idxPrimeraEspecial)}
  </tbody>`

  // Ancho exacto = estado + columnas visibles + acciones. Se calcula aquí
  // para que `table-layout: fixed` tenga una medida que respetar; si se deja
  // en `max-content`, el navegador reparte el sobrante a su criterio.
  const anchoTotal = 16 + cols.reduce((a, c) => a + _anchoDe(c), 0) + 34

  document.getElementById('lcGrid').innerHTML =
    `<div class="lc-wrap"><table class="lc-tabla" style="width:${anchoTotal}px">${thead}${tbody}</table></div>`
  _activarResizers()
}

function _filaHTML(f, idx, cols, idxEsp) {
  const estado = f._estado || ''
  const icono = { wait: '⏳', ok: '✔', err: '⚠' }[estado] || ''
  return `<tr data-idx="${idx}">
    <td class="lc-estado ${estado}">${icono}</td>
    ${cols.map((c, i) => _celdaHTML(f, idx, c, i === idxEsp)).join('')}
    <td class="lc-acciones">${menuAccionesFila([
      { icono: '👁', label: 'Ver detalle', onclick: `window.lcVerDetalle(${idx})` },
      { icono: '📎', label: 'Adjuntos',    onclick: `window.lcAdjuntos(${idx})` },
      { separador: true },
      { icono: '⤒', label: 'Insertar fila arriba', onclick: `window.lcInsertar(${idx}, 'arriba')` },
      { icono: '⤓', label: 'Insertar fila abajo',  onclick: `window.lcInsertar(${idx}, 'abajo')` },
      { icono: '↑', label: 'Mover arriba', onclick: `window.lcMover(${idx}, -1)` },
      { icono: '↓', label: 'Mover abajo',  onclick: `window.lcMover(${idx}, 1)` },
      { separador: true },
      { icono: '✕',  label: 'Eliminar',    onclick: `window.lcEliminar(${idx})`, peligro: true }
    ])}</td>
  </tr>`
}

function _celdaHTML(f, idx, col, esInicioEsp) {
  const clases = ['lc-celda']
  if (col.ro) clases.push('lc-ro')
  if (col.tipo === 'numero' || col.tipo === 'calc') clases.push('lc-num')
  if (col.k === 'numero_recibo' && f.nota) clases.push('lc-tiene-nota')

  return `<td class="${esInicioEsp ? 'lc-inicio-especial' : ''}"
             style="width:${_anchoDe(col)}px; min-width:${_anchoDe(col)}px;"
             data-idx="${idx}" data-key="${col.k}"
             ${col.ro ? '' : `onclick="window.lcEditar(${idx}, '${col.k}')"`}
             title="${_esc(col.k === 'numero_recibo' && f.nota ? f.nota : (col.tipo === 'texto' ? (f[col.k] ?? '') : ''))}">
    <span class="${clases.join(' ')}">${_valorHTML(f, col)}</span>
  </td>`
}

const _MESES = ['Enero','Febrero','Marzo','Abril','Mayo','Junio',
                'Julio','Agosto','Setiembre','Octubre','Noviembre','Diciembre']

function _valorHTML(f, col) {
  // El mes se arma aquí y no en la vista: `to_char(fecha,'TMMonth')` sigue el
  // locale de la base, que está en inglés y devolvía "October".
  if (col.k === 'mes_nombre') {
    const iso = f.fecha
    return iso ? _MESES[Number(String(iso).slice(5, 7)) - 1] || '' : ''
  }
  const v = f[col.k]
  switch (col.tipo) {
    case 'fecha':  return v ? fechaDMY(v) : ''
    case 'numero': return _num(v) ? formatNumber(_num(v)) : ''
    case 'calc':   return f._saldo == null ? '' :
      `<span style="${f._saldo < 0 ? 'color:var(--color-danger); font-weight:600;' : ''}">${formatNumber(f._saldo)}</span>`
    case 'bool':   return v ? '✔' : ''
    case 'enum':   return v ? _esc(col.opciones[v] || v) : ''
    case 'catalogo': {
      const item = _buscarEnCatalogo(col.cat, v)
      if (!item) return ''
      const color = item.color || _colorDeTexto(item.nombre)
      return `<span class="lc-chip" style="background:${_esc(color)}">${_esc(item.nombre)}</span>`
    }
    default: return _esc(v ?? '')
  }
}

function _buscarEnCatalogo(nombreCat, id) {
  if (id == null || id === '') return null
  return (_cat[nombreCat] || []).find(x => x.id === Number(id)) || null
}

function _filaNuevaHTML(cols, idxEsp) {
  const ph = {
    fecha: 'dd/mm/aaaa', numero_recibo: 'auto', detalle: 'Escribe aquí para crear la fila…',
    ingreso: '0.00', egreso: '0.00'
  }
  return `<tr class="lc-nueva" data-idx="-1">
    <td class="lc-estado wait">＋</td>
    ${cols.map((c, i) => {
      if (c.ro && c.k !== 'mes_nombre') return `<td class="${i === idxEsp ? 'lc-inicio-especial' : ''}"><span class="lc-celda lc-ro"></span></td>`
      const col = { ..._nueva }
      const f = { ...col, _saldo: null }
      return `<td class="${i === idxEsp ? 'lc-inicio-especial' : ''}" data-idx="-1" data-key="${c.k}"
                 ${c.ro ? '' : `onclick="window.lcEditar(-1, '${c.k}')"`}>
        <span class="lc-celda ${c.tipo === 'numero' ? 'lc-num' : ''}" data-ph="${_esc(ph[c.k] || '')}">${
          c.ro ? '' : _valorHTML(f, c)}</span>
      </td>`
    }).join('')}
    <td class="lc-acciones"></td>
  </tr>`
}

// ── Saldo corrido ───────────────────────────────────────────────────────────
// Solo tiene sentido con UNA caja y ordenado por fecha. Con varias cajas
// mezcladas la cifra no significa nada — por eso la columna desaparece.
function _calcularSaldoCorrido() {
  if (!_cajaSel) { _filas.forEach(f => { f._saldo = null }); return }
  const caja = _cajaById(_cajaSel)
  const hoy = Number(caja?.saldo_actual || 0)

  // Se reconstruye hacia atrás desde el saldo real de la caja: así la última
  // fila SIEMPRE coincide con lo que dice el sistema, aunque haya filtros.
  const porFecha = [..._filas].sort(_compararOrden)
  let acum = hoy
  for (let i = porFecha.length - 1; i >= 0; i--) {
    porFecha[i]._saldo = acum
    acum = acum - _num(porFecha[i].ingreso) + _num(porFecha[i].egreso)
  }
}

function _pintarTotales() {
  const cont = document.getElementById('lcTotales')
  if (!cont) return

  // Con varias cajas puede haber PEN y USD: sumarlas juntas sería inventar.
  const porMoneda = {}
  for (const f of _filas) {
    const m = f.moneda || 'PEN'
    porMoneda[m] = porMoneda[m] || { ing: 0, egr: 0 }
    porMoneda[m].ing += _num(f.ingreso)
    porMoneda[m].egr += _num(f.egreso)
  }

  const bloques = Object.entries(porMoneda).map(([m, t]) => `
    <div class="lc-total-item">
      <span class="lc-total-lbl">Ingresos ${_esc(m)}</span>
      <span class="lc-total-val" style="color:var(--color-success);">${_simbolo(m)} ${formatNumber(t.ing)}</span>
    </div>
    <div class="lc-total-item">
      <span class="lc-total-lbl">Egresos ${_esc(m)}</span>
      <span class="lc-total-val" style="color:var(--color-danger);">${_simbolo(m)} ${formatNumber(t.egr)}</span>
    </div>`).join('')

  let saldo = ''
  if (_cajaSel) {
    const caja = _cajaById(_cajaSel)
    const s = Number(caja?.saldo_actual || 0)
    saldo = `<div class="lc-total-item">
      <span class="lc-total-lbl">Saldo disponible</span>
      <span class="lc-total-val" style="color:${s < 0 ? 'var(--color-danger)' : 'var(--color-success)'};">
        ${_simbolo(caja?.moneda)} ${formatNumber(s)}</span></div>`
  }

  cont.innerHTML = (bloques || '<span style="color:var(--text-secondary);">Sin movimientos en el periodo.</span>') + saldo +
    `<div class="lc-total-item"><span class="lc-total-lbl">Filas</span>
       <span class="lc-total-val">${_filas.length}</span></div>`
}

function _pintarAviso() {
  const cont = document.getElementById('lcAviso')
  if (!cont) return
  if (_cajaSel) { cont.innerHTML = ''; return }
  // Respuesta a la pregunta de Luis: con varias cajas, la columna Saldo se
  // oculta sola y aparece este aviso ligero. Nada bloquea; solo se explica.
  const monedas = [...new Set(_filas.map(f => f.moneda))]
  cont.innerHTML = `<div class="lc-aviso">
    <span>ℹ️</span>
    <span>Viendo <strong>todas las cajas</strong>${monedas.length > 1 ? ` (${monedas.join(' y ')})` : ''}:
    se muestra la columna <strong>Caja</strong> y se oculta el <strong>saldo corrido</strong>,
    que solo tiene sentido sobre una sola caja ordenada por fecha.
    <a href="#" onclick="document.getElementById('lcCaja').focus(); return false;">Elige una caja</a> para verlo.</span>
  </div>`
}

/** Orden real del libro: fecha, luego el orden manual dentro del día. */
function _compararOrden(a, b) {
  return (a.fecha || '').localeCompare(b.fecha || '')
      || (Number(a.orden ?? a.movimiento_id) - Number(b.orden ?? b.movimiento_id))
      || (a.movimiento_id - b.movimiento_id)
}

function _ordenar(filas) {
  const k = _orden.key, dir = _orden.dir === 'asc' ? 1 : -1
  const col = COLS.find(c => c.k === k)
  return [...filas].sort((a, b) => {
    if (k === 'fecha') return _compararOrden(a, b) * dir
    let va = a[k], vb = b[k]
    if (col?.tipo === 'catalogo') { va = _buscarEnCatalogo(col.cat, va)?.nombre || ''; vb = _buscarEnCatalogo(col.cat, vb)?.nombre || '' }
    if (col?.tipo === 'numero' || col?.tipo === 'calc') return (_num(va) - _num(vb)) * dir
    return String(va ?? '').localeCompare(String(vb ?? ''), 'es') * dir
  })
}

// ── Redimensionado de columnas con el mouse (como en Excel) ────────────────
// Se engancha una vez por render sobre el contenedor: un listener por tirador
// se acumularía en cada repintado.
function _activarResizers() {
  const wrap = document.querySelector('.lc-wrap')
  if (!wrap || wrap.dataset.resizers === '1') return
  wrap.dataset.resizers = '1'

  let activo = null

  wrap.addEventListener('mousedown', e => {
    const tirador = e.target.closest('.lc-resizer')
    if (!tirador) return
    e.preventDefault()
    e.stopPropagation()
    const th = tirador.closest('th')
    activo = { k: tirador.dataset.k, x0: e.clientX, w0: th.getBoundingClientRect().width }
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  })

  document.addEventListener('mousemove', e => {
    if (!activo) return
    const w = Math.max(36, Math.round(activo.w0 + (e.clientX - activo.x0)))
    _anchos[activo.k] = w
    // Se pinta en vivo sin re-renderizar toda la tabla: con 40 filas el
    // re-render en cada pixel se siente pegajoso.
    document.querySelectorAll(`th[data-k="${activo.k}"], td[data-key="${activo.k}"]`)
      .forEach(el => { el.style.width = w + 'px'; el.style.minWidth = w + 'px' })
    const tabla = document.querySelector('.lc-tabla')
    if (tabla) {
      const total = 16 + _colsVisibles().reduce((a, c) => a + _anchoDe(c), 0) + 34
      tabla.style.width = total + 'px'
    }
  })

  document.addEventListener('mouseup', () => {
    if (!activo) return
    activo = null
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
    _guardarAnchos()
  })

  // Doble clic en el tirador: ajusta la columna a su contenido más largo
  wrap.addEventListener('dblclick', e => {
    const tirador = e.target.closest('.lc-resizer')
    if (!tirador) return
    e.preventDefault(); e.stopPropagation()
    const k = tirador.dataset.k
    let max = 60
    document.querySelectorAll(`td[data-key="${k}"] .lc-celda`).forEach(el => {
      const clon = el.cloneNode(true)
      clon.style.cssText = 'position:absolute; visibility:hidden; white-space:nowrap; width:auto;'
      document.body.appendChild(clon)
      max = Math.max(max, clon.scrollWidth + 18)
      clon.remove()
    })
    _anchos[k] = Math.min(max, 520)
    _guardarAnchos()
    _render()
  })
}

window.lcOrdenar = function (key) {
  if (_orden.key === key) _orden.dir = _orden.dir === 'asc' ? 'desc' : 'asc'
  else _orden = { key, dir: 'asc' }
  _render()
}

/** true cuando la tabla está en su orden natural (fecha asc).
 *  Insertar y mover filas solo tienen sentido ahí: con la tabla ordenada por
 *  monto o por categoría, "la fila de abajo" no significa nada. */
function _enOrdenNatural() { return _orden.key === 'fecha' && _orden.dir === 'asc' }

// ============================================================================
// EDICIÓN DE CELDA
// ============================================================================
window.lcEditar = function (idx, key) {
  const col = COLS.find(c => c.k === key)
  if (!col || col.ro) return
  _cerrarEdicion(false)

  const td = document.querySelector(`td[data-idx="${idx}"][data-key="${key}"]`)
  if (!td) return
  const fila = idx === -1 ? _nueva : _filas[idx]
  const valor = fila?.[key] ?? ''

  td.classList.add('lc-editando')
  _edit = { idx, key }

  // Las columnas de lista usan un selector PROPIO, no <select> nativo.
  // El popup nativo del navegador ignora el tema oscuro (sale blanco sobre
  // blanco en Windows) y además no sabe mostrar los chips de color, que es
  // justo lo que la tesorera usa para reconocer la fila de un vistazo.
  if (col.tipo === 'catalogo' || col.tipo === 'enum' || col.tipo === 'bool') {
    td.innerHTML = `<span class="lc-celda">${_valorHTML(fila, col)}</span>`
    _abrirSelector(col, td, idx, valor)
    return
  }

  let html
  // La fecha llega precargada para que la tesorera escriba SOLO el día: el mes
  // y el año se heredan. Se precarga una única vez — si la celda ya tiene
  // fecha, no se pisa.
  if (col.tipo === 'fecha')       html = `<input type="date" value="${_esc(valor || _fechaSugerida())}">`
  else if (col.tipo === 'numero') html = `<input type="number" step="0.01" value="${_num(valor) || ''}">`
  else                            html = `<input type="text" value="${_esc(valor ?? '')}">`

  td.innerHTML = html
  const campo = td.querySelector('input')
  campo.focus()
  if (campo.select) try { campo.select() } catch {}
  campo.addEventListener('keydown', e => _teclas(e, idx, key))
  campo.addEventListener('blur', () => setTimeout(() => {
    if (_edit && _edit.idx === idx && _edit.key === key) _cerrarEdicion(true)
  }, 120))
}

function _teclas(e, idx, key) {
  const cols = _colsVisibles().filter(c => !c.ro)
  const pos = cols.findIndex(c => c.k === key)

  if (e.key === 'Escape') { e.preventDefault(); _cerrarEdicion(false); return }
  if (e.key === 'Enter') {
    e.preventDefault()
    _cerrarEdicion(true)
    const sig = idx === -1 ? -1 : (idx + 1 < _filas.length ? idx + 1 : -1)
    setTimeout(() => window.lcEditar(sig, key), 60)
    return
  }
  if (e.key === 'Tab') {
    e.preventDefault()
    _cerrarEdicion(true)
    const d = e.shiftKey ? -1 : 1
    const sigCol = cols[pos + d]
    setTimeout(() => {
      if (sigCol) window.lcEditar(idx, sigCol.k)
      else if (d > 0) window.lcEditar(idx === -1 ? -1 : idx + 1, cols[0].k)
    }, 60)
  }
}

function _cerrarEdicion(guardar) {
  if (!_edit) return
  const { idx, key } = _edit
  const td = document.querySelector(`td[data-idx="${idx}"][data-key="${key}"].lc-editando`)
  _edit = null
  _cerrarSelector()
  if (!td) return
  const campo = td.querySelector('input')
  const bruto = campo ? campo.value : null
  td.classList.remove('lc-editando')

  if (!guardar || bruto === null) { _render(); return }

  const col = COLS.find(c => c.k === key)
  let valor = bruto
  if (col.tipo === 'numero') valor = _num(bruto)
  else if (bruto === '') valor = null

  _aplicarValor(idx, key, valor)
}

/** Único punto por el que pasa todo cambio de celda, venga de un input o del selector. */
function _aplicarValor(idx, key, valor) {
  if (idx === -1) {
    _nueva[key] = valor
    // Ingreso y Egreso son excluyentes, como en el Excel
    if (key === 'ingreso' && valor) _nueva.egreso = 0
    if (key === 'egreso' && valor) _nueva.ingreso = 0
    _render()
    _intentarCrearFilaNueva()
  } else {
    const fila = _filas[idx]
    if (!fila) { _render(); return }
    if (String(fila[key] ?? '') === String(valor ?? '')) { _render(); return }
    fila[key] = valor
    _guardarCelda(idx, key, valor)
  }
}

// ── Selector propio (reemplaza al <select> nativo) ──────────────────────────
let _selector = null
let _selIdxActivo = 0

function _opcionesDe(col) {
  if (col.tipo === 'bool') return [{ id: true, nombre: 'Sí' }, { id: false, nombre: 'No' }]
  if (col.tipo === 'enum') return Object.entries(col.opciones).map(([k, t]) => ({ id: k, nombre: t }))
  return (_cat[col.cat] || []).map(it => ({
    id: it.id, nombre: it.nombre, color: it.color || _colorDeTexto(it.nombre)
  }))
}

function _cerrarSelector() {
  if (_selector) { _selector.remove(); _selector = null }
}

function _abrirSelector(col, td, idx, valorActual) {
  _cerrarSelector()
  const opciones = _opcionesDe(col)
  const editable = col.tipo === 'catalogo' && !!TABLA_DE_CAT[col.cat]
  const conBuscador = opciones.length > 7

  const p = document.createElement('div')
  p.className = 'lc-selector'
  p.innerHTML = `
    ${conBuscador ? `<div class="lc-sel-buscar"><input type="text" placeholder="Buscar…" autocomplete="off"></div>` : ''}
    <div class="lc-sel-lista"></div>
    <div class="lc-sel-pie">
      <button type="button" class="lc-sel-limpiar">✕ Vaciar celda</button>
      ${editable ? `<button type="button" class="lc-sel-editar">✎ Editar lista…</button>` : ''}
    </div>`
  // El posicionamiento NO puede depender de que el CSS haya cargado: si el
  // navegador sirve una versión cacheada de libro-caja.css sin la regla
  // `.lc-selector`, el panel pierde `position:fixed` y cae al final del body,
  // fuera de la pantalla. Se fija inline, que siempre gana.
  p.style.position = 'fixed'
  p.style.zIndex = '10001'
  document.body.appendChild(p)
  _selector = p

  const lista = p.querySelector('.lc-sel-lista')
  const buscador = p.querySelector('.lc-sel-buscar input')

  const pintar = (filtro = '') => {
    const f = filtro.trim().toLowerCase()
    const vis = f ? opciones.filter(o => o.nombre.toLowerCase().includes(f)) : opciones
    _selIdxActivo = Math.max(0, vis.findIndex(o => String(o.id) === String(valorActual)))
    lista.innerHTML = vis.length
      ? vis.map((o, i) => `
          <div class="lc-sel-item${String(o.id) === String(valorActual) ? ' sel' : ''}${i === _selIdxActivo ? ' activo' : ''}"
               data-id="${_esc(String(o.id))}" data-i="${i}">
            ${o.color ? `<span class="lc-sel-punto" style="background:${_esc(o.color)}"></span>` : '<span class="lc-sel-punto vacio"></span>'}
            <span class="lc-sel-txt">${_esc(o.nombre)}</span>
            ${String(o.id) === String(valorActual) ? '<span class="lc-sel-check">✓</span>' : ''}
          </div>`).join('')
      : `<div class="lc-sel-vacio">Sin coincidencias</div>`
    lista.querySelectorAll('.lc-sel-item').forEach(el => {
      el.addEventListener('mousedown', ev => {
        ev.preventDefault()
        _elegir(col, idx, el.dataset.id)
      })
    })
  }
  pintar()

  // Posición: debajo de la celda, y arriba si no cabe.
  // Se recalcula en el frame siguiente porque recién ahí el panel tiene altura
  // real, y porque cualquier scroll disparado al enfocar ya ocurrió.
  const colocar = () => {
    if (!_selector) return
    const r = td.getBoundingClientRect()
    // Ancho FIJO y acotado: `min-width` le gana a `max-width` en CSS, así que
    // copiar el ancho de la celda estiraba el panel a 1692px y lo mandaba
    // fuera de la pantalla.
    const ancho = Math.max(240, Math.min(r.width, 340))
    p.style.width = `${ancho}px`
    const alto = p.offsetHeight || 220
    const abajo = window.innerHeight - r.bottom
    p.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - ancho - 12))}px`
    // En ambas ramas se acota al viewport: antes la rama de "abajo" podía
    // dejar el pie del panel por debajo del borde inferior.
    p.style.top = abajo > alto + 12
      ? `${Math.min(r.bottom + 4, window.innerHeight - alto - 8)}px`
      : `${Math.max(8, Math.min(r.top - alto - 4, window.innerHeight - alto - 8))}px`
  }
  p.style.visibility = 'hidden'
  colocar()
  requestAnimationFrame(() => { colocar(); if (_selector) _selector.style.visibility = 'visible' })
  window.addEventListener('scroll', colocar, { passive: true, once: true })

  p.querySelector('.lc-sel-limpiar').addEventListener('mousedown', ev => {
    ev.preventDefault(); _elegir(col, idx, '')
  })
  const btnEd = p.querySelector('.lc-sel-editar')
  if (btnEd) btnEd.addEventListener('mousedown', ev => {
    ev.preventDefault()
    _cerrarSelector()
    _edit = null
    td.classList.remove('lc-editando')
    _abrirPanelCatalogo(col, td)
  })

  const teclado = e => {
    const items = [...lista.querySelectorAll('.lc-sel-item')]
    if (e.key === 'Escape') { e.preventDefault(); _edit = null; _cerrarSelector(); _render(); return }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      _selIdxActivo = Math.max(0, Math.min(items.length - 1, _selIdxActivo + (e.key === 'ArrowDown' ? 1 : -1)))
      items.forEach((el, i) => el.classList.toggle('activo', i === _selIdxActivo))
      items[_selIdxActivo]?.scrollIntoView({ block: 'nearest' })
      return
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault()
      const el = items[_selIdxActivo]
      if (el) _elegir(col, idx, el.dataset.id, e.key === 'Tab')
    }
  }
  // preventScroll: sin esto el navegador desplaza la página para "mostrar" el
  // panel y lo deja justo donde no se ve.
  if (buscador) {
    buscador.focus({ preventScroll: true })
    buscador.addEventListener('input', () => pintar(buscador.value))
    buscador.addEventListener('keydown', teclado)
  } else {
    p.tabIndex = -1
    p.focus({ preventScroll: true })
    p.addEventListener('keydown', teclado)
  }

  setTimeout(() => document.addEventListener('mousedown', function cerrar(e) {
    if (_selector && !_selector.contains(e.target)) {
      _selector.remove(); _selector = null
      _edit = null
      document.removeEventListener('mousedown', cerrar)
      _render()
    }
  }), 0)
}

function _elegir(col, idx, idTexto, avanzar = false) {
  let valor = idTexto === '' ? null : idTexto
  if (valor !== null) {
    if (col.tipo === 'catalogo') valor = Number(valor)
    else if (col.tipo === 'bool') valor = valor === 'true'
  }
  _edit = null
  _cerrarSelector()
  const td = document.querySelector(`td[data-idx="${idx}"][data-key="${col.k}"].lc-editando`)
  if (td) td.classList.remove('lc-editando')
  _aplicarValor(idx, col.k, valor)

  if (avanzar) {
    const cols = _colsVisibles().filter(c => !c.ro)
    const sig = cols[cols.findIndex(c => c.k === col.k) + 1]
    if (sig) setTimeout(() => window.lcEditar(idx, sig.k), 80)
  }
}

// ============================================================================
// PERSISTENCIA
// ============================================================================
// Campos que viven en `gastos` y campos que viven en `movimientos_banco`.
// Algunos viven en los dos y hay que escribirlos en ambos para que la vista
// y el saldo de la caja no se contradigan.
const EN_GASTO = new Set(['numero_recibo','tipo_documento_id','categoria_gasto_id',
  'responsable_contact_id','detalle','nota','ambito','destino_costo','deducible','fecha'])
const EN_MOVIMIENTO = new Set(['fecha','detalle','categoria_gasto_id','responsable_contact_id','ambito'])

async function _guardarCelda(idx, key, valor) {
  const fila = _filas[idx]
  fila._estado = 'wait'; _render()

  try {
    // Monto: cambia el movimiento y, si hay gasto detrás, también su monto
    if (key === 'ingreso' || key === 'egreso') {
      const monto = _num(valor)
      if (monto <= 0) throw new Error('El monto debe ser mayor a 0')
      const tipo = key === 'ingreso' ? 'ingreso' : 'egreso'
      if (!await update('movimientos_banco', fila.movimiento_id, { monto, tipo })) throw new Error('movimiento')
      if (fila.gasto_id && tipo === 'egreso') {
        if (!await update('gastos', fila.gasto_id, { monto })) throw new Error('gasto')
      }
      fila[key === 'ingreso' ? 'egreso' : 'ingreso'] = 0
      fila.tipo_movimiento = tipo
    } else {
      if (EN_GASTO.has(key) && fila.gasto_id) {
        const payload = { [key]: valor }
        if (key === 'ambito') payload.empresa_id = valor === 'familiar' ? null : (empresaTrabajo() || null)
        if (!await update('gastos', fila.gasto_id, payload)) throw new Error('gasto')
      }
      if (EN_MOVIMIENTO.has(key)) {
        const campoMov = key === 'detalle' ? 'concepto' : key
        const payload = { [campoMov]: valor }
        if (key === 'ambito') payload.empresa_id = valor === 'familiar' ? null : (empresaTrabajo() || null)
        if (!await update('movimientos_banco', fila.movimiento_id, payload)) throw new Error('movimiento')
      }
      if (key === 'tipo_documento_id' && !fila.gasto_id) {
        throw new Error('Esta fila es un ingreso: no lleva tipo de documento')
      }
    }

    fila._estado = 'ok'
    _render()
    setTimeout(() => { fila._estado = ''; _render() }, 1400)
    await _refrescarSaldoCaja()
  } catch (err) {
    fila._estado = 'err'
    showToast(`No se guardó: ${err.message || ultimoErrorInsert()?.message || 'error'}`, 'error', 5000)
    await window.lcRecargar()
  }
}

/** Crea la fila nueva cuando ya tiene lo mínimo: caja, fecha, detalle y monto. */
async function _intentarCrearFilaNueva() {
  const n = _nueva
  const cajaId = Number(_cajaSel || n.caja_id)
  if (!cajaId) return
  if (!n.fecha || !n.detalle) return
  const ingreso = _num(n.ingreso), egreso = _num(n.egreso)
  if (!ingreso && !egreso) return

  const caja = _cajaById(cajaId)
  const esEgreso = egreso > 0
  if (esEgreso && !n.categoria_gasto_id) {
    showToast('Falta la categoría para crear el gasto', 'warning')
    return
  }

  const user = getCurrentUser()
  // El ámbito lo decide la CATEGORÍA antes que la caja: el gasto de mercado
  // es familiar aunque salga de la caja de la empresa. Al revés (heredarlo de
  // la caja) es el error que mezclaría lo familiar dentro de Jhiro.
  const catSel = _buscarEnCatalogo('categorias', n.categoria_gasto_id)
  const ambito = n.ambito || catSel?.ambito_sugerido || caja?.ambito || 'empresa'
  const empresaId = ambito === 'familiar' ? null : (caja?.empresa_id || empresaTrabajo() || null)
  const base = {
    ambito, empresa_id: empresaId,
    created_by: user?.db_id || null
  }

  const comunes = {
    banco_id: cajaId,
    fecha: n.fecha,
    // Si viene de "Insertar fila aquí", ya trae su posición dentro del día.
    ...(n._orden != null ? { orden: n._orden } : {}),
    categoria_gasto_id: n.categoria_gasto_id || null,
    responsable_contact_id: n.responsable_contact_id || null,
    sede_id: caja?.sede_id || null,
    referencia: n.numero_recibo || null,
    ...base
  }

  // 1a) El ingreso, si lo hay. Cuando la fila trae ingreso Y egreso son dos
  // hechos distintos: el ingreso no lleva gasto detrás (no es una compra).
  if (ingreso > 0) {
    const movIn = await insert('movimientos_banco', {
      ...comunes, tipo: 'ingreso', monto: ingreso,
      concepto: esEgreso ? `Ingreso · ${n.detalle}` : n.detalle
    })
    if (!movIn) {
      showToast(`No se creó el ingreso: ${ultimoErrorInsert()?.message || 'error'}`, 'error', 6000)
      return
    }
    if (!esEgreso) {
      showToast('Fila creada', 'success', 1500)
      _nueva = { fecha: n.fecha }
      await window.lcRecargar()
      return
    }
  }

  // 1b) El egreso: es lo que mueve el saldo y lo que nace como gasto.
  const mov = await insert('movimientos_banco', {
    ...comunes, tipo: 'egreso', monto: egreso, concepto: n.detalle
  })
  if (!mov) { showToast(`No se creó el movimiento: ${ultimoErrorInsert()?.message || 'error'}`, 'error', 6000); return }

  // 2) Si es egreso, nace también el gasto con su detalle contable
  if (esEgreso) {
    let numero = n.numero_recibo
    if (!numero) {
      const { data } = await supabase.rpc('siguiente_numero_recibo', { p_caja_id: cajaId })
      numero = data || `REC-${Date.now() % 100000}`
    }
    const tipoDoc = _buscarEnCatalogo('tiposDoc', n.tipo_documento_id)
    const cat = _buscarEnCatalogo('categorias', n.categoria_gasto_id)

    const gasto = await insert('gastos', {
      numero_recibo: numero,
      fecha: n.fecha,
      caja_id: cajaId,
      sede_id: caja?.sede_id || null,
      destino_costo: n.destino_costo || cat?.destino_sugerido || 'gasto_operativo',
      categoria_gasto_id: n.categoria_gasto_id,
      responsable_contact_id: n.responsable_contact_id || null,
      detalle: n.detalle,
      moneda: caja?.moneda || 'PEN',
      monto: egreso,
      tipo_documento_id: n.tipo_documento_id || null,
      // tipo_sustento lo deriva el trigger del SQL 125 desde el catálogo
      tipo_sustento: tipoDoc?.sustento_base || 'sin_documento',
      // Deducible solo si es de empresa, con factura (sustento real, no
      // pendiente) y la categoría lo permite. Familiar/sin doc → nunca.
      deducible: (() => {
        const amb = ambito
        const dest = n.destino_costo || cat?.destino_sugerido
        return amb === 'empresa' && dest !== 'no_deducible' && cat?.deducible_defecto === true &&
               tipoDoc?.sustento_base === 'factura' && !/pendiente/i.test(tipoDoc?.nombre || '')
      })(),
      nota: n.nota || null,
      movimiento_id: mov.id,
      ...base
    })
    if (!gasto) {
      // Rollback manual: un movimiento sin gasto es un egreso huérfano que
      // nadie podrá clasificar después.
      await deleteRecord('movimientos_banco', mov.id)
      showToast(`No se creó el gasto: ${ultimoErrorInsert()?.message || 'error'}`, 'error', 6000)
      return
    }
  }

  showToast('Fila creada', 'success', 1500)
  _nueva = { fecha: n.fecha }      // la fecha se queda: normalmente se cargan varias del mismo día
  await window.lcRecargar()
  // Durante un pegado NO se reabre el editor: el blur de ese input volvía a
  // disparar la creación con la fila siguiente a medio llenar y duplicaba
  // movimientos.
  if (!_pegando) setTimeout(() => window.lcEditar(-1, 'detalle'), 80)
}

async function _refrescarSaldoCaja() {
  if (!_cajaSel) return
  const { data } = await supabase.from('bancos').select('*').eq('id', Number(_cajaSel)).maybeSingle()
  if (data) {
    const i = _cat.cajas.findIndex(c => c.id === data.id)
    if (i >= 0) _cat.cajas[i] = data
  }
}

// ============================================================================
// ACCIONES DE FILA
// ============================================================================
window.lcEliminar = async function (idx) {
  const f = _filas[idx]
  if (!f) return
  const monto = _num(f.ingreso) || _num(f.egreso)
  if (!confirm(`¿Eliminar la fila "${f.detalle}" por ${_simbolo(f.moneda)} ${formatNumber(monto)}?`)) return

  if (f.gasto_id) {
    if (!await update('gastos', f.gasto_id, { anulado: true, motivo_anulacion: 'Eliminado desde el Libro de caja' })) {
      showToast('No se pudo anular el gasto', 'error'); return
    }
  }
  if (!await deleteRecord('movimientos_banco', f.movimiento_id)) {
    showToast('No se pudo eliminar el movimiento de caja', 'error'); return
  }
  showToast('Fila eliminada', 'success')
  await window.lcRecargar()
}

// ============================================================================
// INSERTAR Y MOVER FILAS
// ============================================================================
// El orden solo existe DENTRO de una fecha: entre días manda el calendario.
// Por eso insertar hereda la fecha de la fila de referencia y mover se detiene
// en el borde del día, ofreciendo cambiar la fecha en vez de hacerlo callado.

/** Filas del mismo día que `fila`, en el orden que ve el usuario. */
function _filasDelDia(fila) {
  return _filas.filter(f => f.fecha === fila.fecha).sort(_compararOrden)
}
function _ord(f) { return Number(f.orden ?? f.movimiento_id) }

/**
 * Prepara la fila nueva para que caiga junto a `idx`.
 * No crea nada todavía: deja el borrador listo y abre el Detalle, igual que
 * cuando se escribe en la fila ＋ del final.
 */
window.lcInsertar = function (idx, donde) {
  if (!_enOrdenNatural()) {
    showToast('Ordena por Fecha (↑) para insertar en una posición concreta', 'warning', 5000)
    return
  }
  const ref = _filas[idx]
  if (!ref) return

  const dia = _filasDelDia(ref)
  const pos = dia.findIndex(f => f.movimiento_id === ref.movimiento_id)
  const vecina = donde === 'arriba' ? dia[pos - 1] : dia[pos + 1]

  // Promedio con la vecina: así se intercala sin renumerar el resto.
  let orden
  if (vecina) orden = (_ord(ref) + _ord(vecina)) / 2
  else orden = donde === 'arriba' ? _ord(ref) - 1 : _ord(ref) + 1

  _nueva = { fecha: ref.fecha, _orden: orden }
  showToast(`Fila nueva ${donde === 'arriba' ? 'antes' : 'después'} de ${ref.numero_recibo || 'esta fila'} · escribe el detalle`, 'info', 4000)
  _render()
  setTimeout(() => window.lcEditar(-1, 'detalle'), 100)
}

/** Intercambia la fila con su vecina del mismo día. */
window.lcMover = async function (idx, paso) {
  if (!_enOrdenNatural()) {
    showToast('Ordena por Fecha (↑) para mover filas', 'warning', 5000)
    return
  }
  const fila = _filas[idx]
  if (!fila) return

  const dia = _filasDelDia(fila)
  const pos = dia.findIndex(f => f.movimiento_id === fila.movimiento_id)
  const vecina = dia[pos + paso]

  if (!vecina) {
    // Está en el borde de su día: mover más allá es cambiar de fecha.
    const otraFecha = paso < 0
      ? new Date(new Date(fila.fecha + 'T12:00:00').getTime() - 86400000)
      : new Date(new Date(fila.fecha + 'T12:00:00').getTime() + 86400000)
    const iso = otraFecha.toLocaleDateString('en-CA')
    if (!confirm(
      `"${fila.detalle}" ya es ${paso < 0 ? 'la primera' : 'la última'} fila del ${fechaDMY(fila.fecha)}.\n\n` +
      `Moverla más allá significa cambiarle la fecha a ${fechaDMY(iso)}.\n\n¿Cambiar la fecha?`)) return
    fila.fecha = iso
    await _guardarCelda(idx, 'fecha', iso)
    return
  }

  // Se intercambian los órdenes. Si ambas tienen el mismo (por el sembrado
  // inicial) se usa el id para desempatar.
  const a = _ord(fila), b = _ord(vecina)
  const nuevoA = a === b ? b + paso * 0.5 : b
  const nuevoB = a === b ? a : a

  fila._estado = 'wait'; _render()
  const ok1 = await update('movimientos_banco', fila.movimiento_id, { orden: nuevoA })
  const ok2 = a === b ? true : await update('movimientos_banco', vecina.movimiento_id, { orden: nuevoB })
  if (!ok1 || !ok2) { showToast('No se pudo mover la fila', 'error'); fila._estado = 'err'; _render(); return }
  await window.lcRecargar()
}

window.lcVerDetalle = function (idx) {
  const f = _filas[idx]
  if (!f) return
  if (!f.gasto_id) { showToast('Esta fila es un ingreso de caja, no tiene ficha de gasto', 'info'); return }
  window.abrirModalGasto(f.gasto_id)
}

window.lcAdjuntos = function (idx) {
  const f = _filas[idx]
  if (!f) return
  if (!f.gasto_id) { showToast('Solo los gastos llevan comprobante adjunto', 'info'); return }
  window.abrirModalGasto(f.gasto_id)
}

// ============================================================================
// EDITAR LA LISTA DE UNA COLUMNA (desde la propia columna)
// ============================================================================
const TABLA_DE_CAT = { tiposDoc: 'tipos_documento_gasto', categorias: 'categorias_gasto' }

function _abrirPanelCatalogo(col, anchorTd) {
  _cerrarPanelCat()
  const items = _cat[col.cat] || []
  const p = document.createElement('div')
  p.className = 'lc-cat-panel'
  p.innerHTML = `
    <div class="lc-cat-head">
      <strong>Lista de ${_esc(col.t)}</strong>
      <button type="button" class="btn btn-secondary btn-small" onclick="window.lcCatAgregar('${col.cat}')">+ Agregar</button>
    </div>
    ${items.map(it => `
      <div class="lc-cat-item">
        <input type="color" value="${_esc(it.color || '#64748b')}"
               onchange="window.lcCatGuardar('${col.cat}', ${it.id}, 'color', this.value)">
        <input type="text" value="${_esc(it.nombre)}"
               onchange="window.lcCatGuardar('${col.cat}', ${it.id}, 'nombre', this.value)">
        <button type="button" title="Quitar de la lista" style="background:none; border:none; cursor:pointer; color:var(--color-danger);"
                onclick="window.lcCatDesactivar('${col.cat}', ${it.id})">✕</button>
      </div>`).join('')}
    <div style="padding:8px 6px 2px; font-size:.76rem; color:var(--text-secondary); line-height:1.4;">
      Quitar una opción no borra lo ya registrado: solo deja de ofrecerse.
    </div>`

  p.style.position = 'fixed'
  p.style.zIndex = '10002'
  document.body.appendChild(p)
  const r = anchorTd.getBoundingClientRect()
  p.style.top = `${Math.min(r.bottom + 4, window.innerHeight - p.offsetHeight - 10)}px`
  p.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - p.offsetWidth - 8))}px`
  _panelCat = p

  setTimeout(() => document.addEventListener('click', function cerrar(e) {
    if (_panelCat && !_panelCat.contains(e.target)) { _cerrarPanelCat(); document.removeEventListener('click', cerrar) }
  }), 0)
}

function _cerrarPanelCat() { if (_panelCat) { _panelCat.remove(); _panelCat = null } }

window.lcCatGuardar = async function (cat, id, campo, valor) {
  const tabla = TABLA_DE_CAT[cat]
  if (!tabla) return
  if (!await update(tabla, id, { [campo]: valor })) { showToast('No se pudo guardar', 'error'); return }
  const item = _buscarEnCatalogo(cat, id)
  if (item) item[campo] = valor
  showToast('Lista actualizada', 'success', 1200)
  _render()
}

window.lcCatAgregar = async function (cat) {
  const tabla = TABLA_DE_CAT[cat]
  if (!tabla) return
  const nombre = prompt(`Nombre de la nueva opción:`)
  if (!nombre) return
  const codigo = nombre.toUpperCase().replace(/[^A-Z0-9]+/g, '_').slice(0, 30)

  let extra = {}
  if (cat === 'tiposDoc') {
    const base = prompt(
      'Tratamiento tributario de esta etiqueta:\n\n' +
      '1 = Factura\n2 = Boleta\n3 = Recibo por honorarios\n4 = Vale\n5 = Sin documento (no deduce)',
      '5')
    extra = { sustento_base: { '1':'factura','2':'boleta','3':'recibo_honorarios','4':'vale','5':'sin_documento' }[base] || 'sin_documento' }
  }

  const fila = await insert(tabla, { codigo, nombre, color: '#64748b', orden: 500, ...extra })
  if (!fila) { showToast(`No se pudo agregar: ${ultimoErrorInsert()?.message || 'error'}`, 'error'); return }
  _cat[cat].push(fila)
  showToast('Opción agregada', 'success')
  _cerrarPanelCat()
  _render()
}

window.lcCatDesactivar = async function (cat, id) {
  const tabla = TABLA_DE_CAT[cat]
  const item = _buscarEnCatalogo(cat, id)
  if (!tabla || !item) return
  if (!confirm(`¿Quitar "${item.nombre}" de la lista?\n\nLo ya registrado con esa opción no se toca.`)) return
  if (!await update(tabla, id, { activo: false })) { showToast('No se pudo quitar', 'error'); return }
  _cat[cat] = _cat[cat].filter(x => x.id !== Number(id))
  showToast('Opción quitada de la lista', 'success')
  _cerrarPanelCat()
  _render()
}

// ============================================================================
// PEGAR DESDE EXCEL
// ============================================================================
// Pegar un bloque es lo que permite migrar el Excel de octubre de una vez.
// Orden esperado de columnas = el de la grilla visible, empezando por Fecha.
async function _pegarDesdeExcel(texto, sinConfirmar = false) {
  if (!_cajaSel) { showToast('Elige una caja antes de pegar', 'warning'); return }
  const filas = texto.trim().split(/\r?\n/).map(l => l.split('\t'))
  if (!filas.length) return
  if (!sinConfirmar &&
      !confirm(`Vas a pegar ${filas.length} fila(s) en "${_cajaById(_cajaSel)?.nombre}".\n\n` +
               `Orden esperado: Fecha · N° Recibo · Tipo Doc · Categoría · Responsable · Detalle · Ingreso · Egreso\n\n¿Continuar?`)) return

  let ok = 0, fallos = []
  _pegando = true
  for (const [i, celdas] of filas.entries()) {
    const [fecha, recibo, tipoDoc, categoria, responsable, detalle, ing, egr] = celdas
    const fechaISO = _parseFecha(fecha)
    if (!fechaISO || !detalle) { fallos.push(`Fila ${i + 1}: falta fecha o detalle`); continue }

    _nueva = {
      fecha: fechaISO,
      numero_recibo: (recibo || '').trim() || null,
      tipo_documento_id: _porNombre('tiposDoc', tipoDoc),
      categoria_gasto_id: _porNombre('categorias', categoria),
      responsable_contact_id: _porNombre('contactos', responsable),
      detalle: detalle.trim(),
      ingreso: _num(ing),
      egreso: _num(egr)
    }
    if (!_nueva.ingreso && !_nueva.egreso) { fallos.push(`Fila ${i + 1}: sin monto`); continue }
    if (_nueva.egreso && !_nueva.categoria_gasto_id) { fallos.push(`Fila ${i + 1}: categoría "${categoria}" no existe`); continue }

    const antes = _filas.length
    await _intentarCrearFilaNueva()
    ok++
  }
  _pegando = false
  _nueva = {}
  showToast(`${ok} fila(s) pegada(s)${fallos.length ? ` · ${fallos.length} con problemas` : ''}`,
            fallos.length ? 'warning' : 'success', 6000)
  if (fallos.length) console.warn('[libro-caja] filas no pegadas:\n' + fallos.join('\n'))
  await window.lcRecargar()
}

function _porNombre(cat, texto) {
  if (!texto) return null
  const t = texto.trim().toLowerCase()
  const lista = _cat[cat] || []
  // El orden importa: sin esto, "Recibo" caía en "Recibo por honorarios"
  // (startsWith acertaba primero) y los gastos quedaban con el sustento
  // equivocado. Exacto → código → prefijo, y el prefijo sólo si es único.
  const exacto = lista.find(x => x.nombre.trim().toLowerCase() === t)
  if (exacto) return exacto.id
  const porCodigo = lista.find(x => (x.codigo || '').trim().toLowerCase() === t)
  if (porCodigo) return porCodigo.id
  const prefijo = lista.filter(x => x.nombre.trim().toLowerCase().startsWith(t))
  return prefijo.length === 1 ? prefijo[0].id : null
}

function _parseFecha(v) {
  if (!v) return null
  const t = String(v).trim()
  let m = t.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/)   // dd/mm/aaaa
  if (m) {
    const [, d, mo, a] = m
    const anio = a.length === 2 ? `20${a}` : a
    return `${anio}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`
  }
  m = t.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  return m ? t : null
}

// ============================================================================
// MONTAJE
// ============================================================================
export async function montarLibroCaja() {
  if (_montado) { await window.lcRecargar(); return }
  const cont = document.getElementById('tab-libro')
  if (!cont) return

  await _cargarCatalogos()

  const hoy = _hoyISO()
  const ini = `${hoy.slice(0, 7)}-01`

  cont.innerHTML = `
    <div class="card">
      <div class="lc-barra">
        <div class="form-group">
          <label>Caja</label>
          <select id="lcCaja" onchange="window.lcCambiarCaja(this.value)">
            <option value="">-- Todas las cajas --</option>
            ${_cat.cajas.map(c => `<option value="${c.id}">${_esc(c.nombre)} · ${_esc(c.moneda)}</option>`).join('')}
          </select>
        </div>
        <div class="form-group"><label>Desde</label><input type="date" id="lcDesde" value="${ini}" onchange="window.lcRecargar()"></div>
        <div class="form-group"><label>Hasta</label><input type="date" id="lcHasta" value="${hoy}" onchange="window.lcRecargar()"></div>
        <div class="form-group" style="flex:1; min-width:220px;">
          <label>Buscar</label>
          <input type="text" id="lcBuscar" placeholder="En todas las columnas…" oninput="window.lcRecargar()">
        </div>
        <button class="btn btn-secondary btn-small" onclick="window.lcPegar()">📋 Pegar desde Excel</button>
        <button class="btn btn-secondary btn-small" onclick="window.lcResetAnchos()"
                title="Restablecer el ancho de las columnas">⇔</button>
        <button class="btn btn-secondary btn-small" onclick="window.lcRecargar()">↻</button>
      </div>

      <div id="lcAviso"></div>
      <div id="lcTotales" class="lc-totales"></div>
      <div id="lcGrid">Cargando...</div>

      <small style="display:block; margin-top:10px; color:var(--text-secondary); line-height:1.5;">
        <strong>Tab</strong> avanza de celda · <strong>Enter</strong> baja una fila · <strong>Esc</strong> cancela ·
        escribe en la última fila (＋) para crear un registro · en Tipo Doc y Categoría, <strong>✎ Editar lista…</strong>
        agrega o renombra opciones · <strong>arrastra el borde de una columna</strong> para cambiar su ancho
        (doble clic la ajusta al contenido).
      </small>
    </div>`

  _montado = true
  await window.lcRecargar()

  // Pegado directo con Ctrl+V sobre la grilla
  document.addEventListener('paste', e => {
    const tab = document.getElementById('tab-libro')
    if (!tab || !tab.classList.contains('active')) return
    if (_edit) return                       // si está editando una celda, pegar normal
    const texto = (e.clipboardData || window.clipboardData)?.getData('text')
    if (texto && texto.includes('\t')) { e.preventDefault(); _pegarDesdeExcel(texto) }
  })
}

window.lcCambiarCaja = async function (v) {
  _cajaSel = v
  _nueva = {}
  await window.lcRecargar()
}

window.lcRecargar = async function () {
  // El saldo de la caja lo mueve un trigger en la BD con cada movimiento, así
  // que el valor en memoria queda viejo apenas se registra una fila.
  await _refrescarSaldoCaja()
  if (await _cargarFilas()) _render()
}

/** Pega un bloque TSV sin pasar por el portapapeles. */
window.lcPegarTexto = async function (texto, sinConfirmar = false) {
  await _pegarDesdeExcel(texto, sinConfirmar)
}

window.lcPegar = async function () {
  try {
    const texto = await navigator.clipboard.readText()
    if (!texto || !texto.includes('\t')) { showToast('El portapapeles no tiene filas de Excel', 'warning'); return }
    await _pegarDesdeExcel(texto)
  } catch {
    showToast('Copia las filas en Excel y usa Ctrl+V sobre la grilla', 'info', 5000)
  }
}
