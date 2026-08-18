// ============================================================================
// CRONOGRAMA.JS — Términos de pago y cuotas
// ============================================================================
// Módulo compartido por Ventas, Compras y Cuentas x Cobrar/Pagar.
//
// Un TÉRMINO DE PAGO define cómo se fracciona un total (porcentajes y días).
// Un CRONOGRAMA es ese término ya aplicado a un documento concreto: fechas y
// montos reales. El término se guarda como referencia de lo pactado; las
// cuotas son la verdad operativa.
//
// PERSONALIZADO: si el usuario edita las fechas o montos a mano, NO se crea un
// término nuevo en el catálogo — se marca el documento como
// `cronograma_personalizado` y ese cronograma vive solo en sus cuotas. Así el
// catálogo no se llena de "37/64/83 días" negociados una única vez.
// ============================================================================

import { getTerminosPago, getTerminosPagoCuotas, addTerminoPago, addTerminoPagoCuota } from './supabase-data.js'

let _terminosCache = null
let _cuotasTerminoCache = null

/** Catálogo completo con sus cuotas ya anidadas. */
export async function getTerminosConCuotas(forzar = false) {
  if (_terminosCache && !forzar) return _terminosCache
  const [terminos, cuotas] = await Promise.all([getTerminosPago(), getTerminosPagoCuotas()])
  _cuotasTerminoCache = cuotas || []
  _terminosCache = (terminos || [])
    .filter(t => t.activo !== false)
    .map(t => ({
      ...t,
      cuotas: _cuotasTerminoCache
        .filter(c => c.termino_id === t.id)
        .sort((a, b) => (a.orden || 0) - (b.orden || 0))
    }))
    .sort((a, b) => (a.orden || 0) - (b.orden || 0) || String(a.nombre).localeCompare(String(b.nombre)))
  return _terminosCache
}

export function invalidarCacheTerminos() { _terminosCache = null; _cuotasTerminoCache = null }

/**
 * Aplica un término sobre un documento y devuelve el cronograma.
 *
 * El redondeo es el punto delicado: repartir 1000 en tres cuotas de 33.33%
 * da 999.90 y faltarían 10 céntimos. Por eso las cuotas intermedias se
 * redondean a 2 decimales y la ÚLTIMA absorbe la diferencia — así la suma
 * de cuotas siempre es exactamente el total del documento.
 *
 * @param {object} termino  término con .cuotas
 * @param {number} total    importe del documento
 * @param {string} fechaEmision  'YYYY-MM-DD'
 * @returns {Array} [{ numero_cuota, fecha_vencimiento, monto, hito }]
 */
export function generarCronograma(termino, total, fechaEmision) {
  const importe = parseFloat(total) || 0
  const base = fechaEmision || new Date().toISOString().slice(0, 10)

  if (!termino?.cuotas?.length) {
    return [{ numero_cuota: 1, fecha_vencimiento: base, monto: parseFloat(importe.toFixed(2)), hito: null }]
  }

  const cuotas = []
  let acumulado = 0

  termino.cuotas.forEach((c, i) => {
    const esUltima = i === termino.cuotas.length - 1
    const monto = esUltima
      ? parseFloat((importe - acumulado).toFixed(2))
      : parseFloat((importe * (parseFloat(c.porcentaje) || 0) / 100).toFixed(2))
    acumulado = parseFloat((acumulado + monto).toFixed(2))

    cuotas.push({
      numero_cuota: i + 1,
      fecha_vencimiento: sumarDias(base, parseInt(c.dias) || 0),
      monto,
      hito: c.hito || null,
      porcentaje: parseFloat(c.porcentaje) || 0
    })
  })

  // Si el total era 0 o el redondeo dejó una cuota en negativo, se colapsa a
  // una sola cuota: una cuota de monto <= 0 rompería el CHECK de la tabla.
  const invalidas = cuotas.filter(c => c.monto <= 0)
  if (invalidas.length > 0) {
    return [{ numero_cuota: 1, fecha_vencimiento: base, monto: parseFloat(importe.toFixed(2)), hito: null }]
  }
  return cuotas
}

/** Suma días a una fecha ISO sin que la zona horaria mueva el resultado. */
export function sumarDias(fechaIso, dias) {
  const [a, m, d] = String(fechaIso).slice(0, 10).split('-').map(Number)
  const fecha = new Date(Date.UTC(a, (m || 1) - 1, d || 1))
  fecha.setUTCDate(fecha.getUTCDate() + (parseInt(dias) || 0))
  return fecha.toISOString().slice(0, 10)
}

/**
 * Interpreta el texto libre de "término de pago" que traen sistemas externos
 * (ej. Odoo: "CONTADO", "45 DIAS", "60-75-90 DIAS") y arma un cronograma.
 * Se usa en las importaciones masivas, donde no hay UI para elegir el
 * término fila por fila — el Excel ya trae la condición pactada como texto.
 *
 * Reglas:
 *   - Vacío o contiene "CONTADO"     → usa el término "Contado" del catálogo
 *                                       (no personalizado: es un match real).
 *   - Uno o más números (días)       → una cuota POR CADA número encontrado,
 *                                       en partes iguales (Odoo no exporta el
 *                                       % de cada tramo). Como el texto no
 *                                       calza 1:1 con ningún nombre del
 *                                       catálogo, queda como
 *                                       `cronograma_personalizado` — no se
 *                                       crea un término nuevo por cada
 *                                       combinación rara que traiga el Excel.
 *   - Sin números reconocibles       → null; el llamador decide el fallback
 *                                       (término del contacto o Contado).
 *
 * @returns {{ cuotas, terminoId, personalizado } | null}
 */
export function cronogramaDesdeTexto(texto, total, fechaEmision, terminoContado) {
  const importe = parseFloat(total) || 0
  const base = fechaEmision || new Date().toISOString().slice(0, 10)
  const t = String(texto || '').trim().toUpperCase()

  if (!t || t.includes('CONTADO')) {
    return {
      cuotas: generarCronograma(terminoContado, importe, base),
      terminoId: terminoContado?.id || null,
      personalizado: false
    }
  }

  const dias = [...t.matchAll(/\d+/g)].map(m => parseInt(m[0], 10)).filter(n => !isNaN(n))
  if (dias.length === 0) return null
  dias.sort((a, b) => a - b)

  const cuotas = []
  let acumulado = 0
  dias.forEach((d, i) => {
    const esUltima = i === dias.length - 1
    const monto = esUltima
      ? parseFloat((importe - acumulado).toFixed(2))
      : parseFloat((importe / dias.length).toFixed(2))
    acumulado = parseFloat((acumulado + monto).toFixed(2))
    cuotas.push({ numero_cuota: i + 1, fecha_vencimiento: sumarDias(base, d), monto, hito: null })
  })

  // Mismo resguardo que generarCronograma: si el redondeo o un total <= 0
  // dejan una cuota en 0 o negativo, se colapsa a una sola cuota.
  if (cuotas.some(c => c.monto <= 0)) {
    return { cuotas: [{ numero_cuota: 1, fecha_vencimiento: base, monto: parseFloat(importe.toFixed(2)), hito: null }], terminoId: null, personalizado: true }
  }
  return { cuotas, terminoId: null, personalizado: true }
}

/** Saldo pendiente real de una cuota. */
export function saldoCuota(cuota) {
  return parseFloat(cuota.monto || 0)
       - parseFloat(cuota.monto_cobrado || cuota.monto_pagado || 0)
       - parseFloat(cuota.monto_retenido || 0)
       - parseFloat(cuota.monto_canjeado || 0)
}

/** Estado que corresponde a una cuota según sus importes. */
export function estadoCuota(cuota, esCobrar = true) {
  const saldo = saldoCuota(cuota)
  const aplicado = parseFloat(cuota.monto || 0) - saldo
  if (saldo <= 0.01) {
    return parseFloat(cuota.monto_canjeado || 0) >= parseFloat(cuota.monto || 0) - 0.01
      ? 'canjeado'
      : (esCobrar ? 'cobrado' : 'pagado')
  }
  return aplicado > 0.01 ? 'parcial' : 'pendiente'
}

/**
 * Reparte un importe entre cuotas, de la más antigua a la más reciente.
 * Es la práctica estándar de cobranza: si el cliente paga sin decir a qué
 * cuota imputarlo, se salda primero lo más vencido.
 *
 * @returns {Array} [{ cuota, aplicado }]
 */
export function repartirEntreCuotas(cuotas, importe) {
  let restante = parseFloat(importe) || 0
  const aplicaciones = []

  const ordenadas = [...(cuotas || [])]
    .filter(c => saldoCuota(c) > 0.01 && c.estado !== 'anulado')
    .sort((a, b) => String(a.fecha_vencimiento).localeCompare(String(b.fecha_vencimiento)) || a.numero_cuota - b.numero_cuota)

  for (const cuota of ordenadas) {
    if (restante <= 0.01) break
    const aplicado = Math.min(saldoCuota(cuota), restante)
    aplicaciones.push({ cuota, aplicado: parseFloat(aplicado.toFixed(2)) })
    restante = parseFloat((restante - aplicado).toFixed(2))
  }

  return { aplicaciones, sobrante: restante }
}

// ============================================================================
// EDITOR DE CRONOGRAMA (UI reutilizable)
// ============================================================================
// Se pinta dentro de cualquier contenedor. Devuelve el cronograma en vivo con
// `leerCronograma(containerId)`, y avisa si las cuotas dejaron de sumar el
// total — que es el error más fácil de cometer al editar a mano.

const _cronogramas = new Map()

/**
 * @param {string} containerId
 * @param {object} opciones
 *   total        importe del documento
 *   fechaEmision 'YYYY-MM-DD'
 *   terminoId    término preseleccionado (opcional)
 *   soloLectura  boolean
 *   onCambio     callback({ cuotas, personalizado, terminoId })
 */
export async function renderEditorCronograma(containerId, opciones = {}) {
  const cont = document.getElementById(containerId)
  if (!cont) return

  const terminos = await getTerminosConCuotas()
  const aplica = opciones.aplicaA || 'venta'
  const disponibles = terminos.filter(t => t.aplica_a === 'ambos' || t.aplica_a === aplica)

  const estado = {
    containerId,
    total: parseFloat(opciones.total) || 0,
    fechaEmision: opciones.fechaEmision || new Date().toISOString().slice(0, 10),
    terminoId: opciones.terminoId || disponibles[0]?.id || null,
    personalizado: false,
    cuotas: [],
    soloLectura: !!opciones.soloLectura,
    onCambio: opciones.onCambio,
    terminos: disponibles,
    aplicaA: aplica
  }
  _cronogramas.set(containerId, estado)

  const termino = disponibles.find(t => t.id === estado.terminoId)
  estado.cuotas = generarCronograma(termino, estado.total, estado.fechaEmision)

  _pintar(containerId)
}

/** Recalcula el cronograma cuando cambia el total o la fecha del documento. */
export function actualizarCronograma(containerId, { total, fechaEmision } = {}) {
  const e = _cronogramas.get(containerId)
  if (!e) return
  if (total !== undefined) e.total = parseFloat(total) || 0
  if (fechaEmision) e.fechaEmision = fechaEmision

  // Un cronograma personalizado NO se regenera solo: el usuario ya definió
  // fechas a mano y pisarlas sería perder su trabajo. Solo se re-prorratea si
  // cambió el total, manteniendo las fechas que él puso.
  if (e.personalizado) {
    const sumaActual = e.cuotas.reduce((s, c) => s + (parseFloat(c.monto) || 0), 0)
    if (sumaActual > 0 && Math.abs(sumaActual - e.total) > 0.01) {
      const factor = e.total / sumaActual
      let acumulado = 0
      e.cuotas.forEach((c, i) => {
        const esUltima = i === e.cuotas.length - 1
        c.monto = esUltima
          ? parseFloat((e.total - acumulado).toFixed(2))
          : parseFloat((c.monto * factor).toFixed(2))
        acumulado = parseFloat((acumulado + c.monto).toFixed(2))
      })
    }
  } else {
    const termino = e.terminos.find(t => t.id === e.terminoId)
    e.cuotas = generarCronograma(termino, e.total, e.fechaEmision)
  }
  _pintar(containerId)
}

/** Devuelve el cronograma tal como está en pantalla. */
export function leerCronograma(containerId) {
  const e = _cronogramas.get(containerId)
  if (!e) return null
  return {
    terminoId: e.terminoId,
    personalizado: e.personalizado,
    cuotas: e.cuotas.map(c => ({ ...c })),
    suma: parseFloat(e.cuotas.reduce((s, c) => s + (parseFloat(c.monto) || 0), 0).toFixed(2)),
    total: e.total,
    cuadra: Math.abs(e.cuotas.reduce((s, c) => s + (parseFloat(c.monto) || 0), 0) - e.total) < 0.02
  }
}

function _pintar(containerId) {
  const e = _cronogramas.get(containerId)
  const cont = document.getElementById(containerId)
  if (!e || !cont) return

  const suma = parseFloat(e.cuotas.reduce((s, c) => s + (parseFloat(c.monto) || 0), 0).toFixed(2))
  const dif = parseFloat((e.total - suma).toFixed(2))
  const cuadra = Math.abs(dif) < 0.02

  cont.innerHTML = `
    <div class="cronograma">
      <div class="cronograma-cabecera">
        <div class="form-group" style="margin:0; min-width:220px;">
          <label style="font-size:0.8rem;">Condición de pago</label>
          <select id="crono-termino-${containerId}" ${e.soloLectura ? 'disabled' : ''}>
            ${e.soloLectura ? '' : '<option value="__nuevo">+ Nuevo término de pago...</option>'}
            ${e.terminos.map(t => `<option value="${t.id}" ${t.id === e.terminoId && !e.personalizado ? 'selected' : ''}>${_esc(t.nombre)}</option>`).join('')}
            <option value="__personalizado" ${e.personalizado ? 'selected' : ''}>✎ Personalizado</option>
          </select>
        </div>
        ${e.personalizado ? `
          <div class="cronograma-aviso-personalizado">
            Cronograma editado a mano. No se guardará como término nuevo: queda solo en este documento.
          </div>` : ''}
      </div>

      <div class="table-container">
        <table class="cronograma-tabla">
          <thead>
            <tr>
              <th style="width:50px;">Cuota</th>
              <th>Vencimiento</th>
              <th style="width:70px; text-align:center;" title="Días desde la fecha de emisión">Días</th>
              <th style="text-align:right;">Importe</th>
              <th>Concepto / hito</th>
              ${e.soloLectura ? '' : '<th style="width:40px;"></th>'}
            </tr>
          </thead>
          <tbody>
            ${e.cuotas.map((c, i) => `
              <tr>
                <td style="text-align:center; font-weight:600;">${c.numero_cuota}</td>
                <td><input type="date" value="${c.fecha_vencimiento}" ${e.soloLectura ? 'disabled' : ''}
                           data-crono="fecha" data-idx="${i}" style="max-width:160px;"></td>
                <td style="text-align:center; color:var(--text-secondary);">${_diasDesdeEmision(e.fechaEmision, c.fecha_vencimiento)}</td>
                <td style="text-align:right;"><input type="number" step="0.01" min="0.01" value="${(parseFloat(c.monto) || 0).toFixed(2)}"
                           ${e.soloLectura ? 'disabled' : ''} data-crono="monto" data-idx="${i}"
                           style="max-width:130px; text-align:right;"></td>
                <td><input type="text" value="${_esc(c.hito || '')}" placeholder="Opcional"
                           ${e.soloLectura ? 'disabled' : ''} data-crono="hito" data-idx="${i}"></td>
                ${e.soloLectura ? '' : `<td>${e.cuotas.length > 1
                  ? `<button type="button" class="btn btn-small btn-danger" data-crono="quitar" data-idx="${i}">✕</button>`
                  : ''}</td>`}
              </tr>`).join('')}
          </tbody>
          <tfoot>
            <tr class="rp-total">
              <td colspan="3"><strong>Suma de cuotas</strong></td>
              <td style="text-align:right;">
                <strong style="color:${cuadra ? 'var(--color-success)' : 'var(--color-danger)'};">${_num(suma)}</strong>
              </td>
              <td colspan="${e.soloLectura ? 1 : 2}">
                ${cuadra
                  ? '<span style="color:var(--color-success); font-size:0.82rem;">✓ Cuadra con el total</span>'
                  : `<span style="color:var(--color-danger); font-size:0.82rem;">Difiere ${_num(dif)} del total (${_num(e.total)})</span>`}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>

      ${e.soloLectura ? '' : `
        <div style="display:flex; gap:8px; margin-top:8px;">
          <button type="button" class="btn btn-small btn-secondary" data-crono="agregar">+ Agregar cuota</button>
          <button type="button" class="btn btn-small btn-secondary" data-crono="reestablecer">↺ Volver al término</button>
          <button type="button" class="btn btn-small btn-secondary" data-crono="prorratear">= Prorratear al total</button>
        </div>`}
    </div>`

  _bind(containerId)
  if (typeof e.onCambio === 'function') e.onCambio(leerCronograma(containerId))
}

function _bind(containerId) {
  const e = _cronogramas.get(containerId)
  const cont = document.getElementById(containerId)
  if (!e || !cont) return

  const sel = document.getElementById(`crono-termino-${containerId}`)
  sel?.addEventListener('change', () => {
    if (sel.value === '__nuevo') {
      // Vuelve el select a lo que estaba mientras se decide en el modal —
      // si el usuario cancela, no debe quedar pegado en "+ Nuevo".
      sel.value = e.personalizado ? '__personalizado' : String(e.terminoId ?? '')
      _abrirModalNuevoTermino(containerId)
      return
    }
    if (sel.value === '__personalizado') {
      e.personalizado = true
    } else {
      e.personalizado = false
      e.terminoId = parseInt(sel.value)
      const t = e.terminos.find(x => x.id === e.terminoId)
      e.cuotas = generarCronograma(t, e.total, e.fechaEmision)
    }
    _pintar(containerId)
  })

  // Cualquier edición manual marca el cronograma como personalizado: es lo
  // que evita que un cambio de total lo regenere y borre lo que el usuario
  // acaba de escribir.
  cont.querySelectorAll('[data-crono="fecha"], [data-crono="monto"], [data-crono="hito"]').forEach(inp => {
    inp.addEventListener('change', () => {
      const i = parseInt(inp.getAttribute('data-idx'))
      const campo = inp.getAttribute('data-crono')
      if (!e.cuotas[i]) return
      if (campo === 'monto') e.cuotas[i].monto = parseFloat(inp.value) || 0
      else if (campo === 'fecha') e.cuotas[i].fecha_vencimiento = inp.value
      else e.cuotas[i].hito = inp.value.trim() || null
      e.personalizado = true
      _pintar(containerId)
    })
  })

  cont.querySelectorAll('[data-crono="quitar"]').forEach(btn => {
    btn.addEventListener('click', () => {
      const i = parseInt(btn.getAttribute('data-idx'))
      e.cuotas.splice(i, 1)
      e.cuotas.forEach((c, idx) => { c.numero_cuota = idx + 1 })
      e.personalizado = true
      _pintar(containerId)
    })
  })

  cont.querySelector('[data-crono="agregar"]')?.addEventListener('click', () => {
    const ultima = e.cuotas[e.cuotas.length - 1]
    e.cuotas.push({
      numero_cuota: e.cuotas.length + 1,
      fecha_vencimiento: sumarDias(ultima?.fecha_vencimiento || e.fechaEmision, 30),
      monto: 0.01, hito: null
    })
    e.personalizado = true
    _pintar(containerId)
  })

  cont.querySelector('[data-crono="reestablecer"]')?.addEventListener('click', () => {
    e.personalizado = false
    const t = e.terminos.find(x => x.id === e.terminoId)
    e.cuotas = generarCronograma(t, e.total, e.fechaEmision)
    _pintar(containerId)
  })

  // Ajusta los importes para que sumen el total, respetando las proporciones
  // que el usuario ya definió. Resuelve el caso típico: editó las fechas y
  // ahora los céntimos no cuadran.
  cont.querySelector('[data-crono="prorratear"]')?.addEventListener('click', () => {
    const suma = e.cuotas.reduce((s, c) => s + (parseFloat(c.monto) || 0), 0)
    if (suma <= 0) return
    const factor = e.total / suma
    let acumulado = 0
    e.cuotas.forEach((c, i) => {
      const esUltima = i === e.cuotas.length - 1
      c.monto = esUltima
        ? parseFloat((e.total - acumulado).toFixed(2))
        : parseFloat((c.monto * factor).toFixed(2))
      acumulado = parseFloat((acumulado + c.monto).toFixed(2))
    })
    _pintar(containerId)
  })
}

/** Días de plazo entre la fecha de emisión y el vencimiento de una cuota. */
function _diasDesdeEmision(fechaEmision, fechaVencimiento) {
  if (!fechaEmision || !fechaVencimiento) return '—'
  const [a1, m1, d1] = String(fechaEmision).slice(0, 10).split('-').map(Number)
  const [a2, m2, d2] = String(fechaVencimiento).slice(0, 10).split('-').map(Number)
  if (!a1 || !a2) return '—'
  const t1 = Date.UTC(a1, (m1 || 1) - 1, d1 || 1)
  const t2 = Date.UTC(a2, (m2 || 1) - 1, d2 || 1)
  return Math.round((t2 - t1) / 86400000)
}

function _num(v) { return (parseFloat(v) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) }
function _esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

/**
 * Carga en el editor un cronograma YA guardado (las cuotas reales del
 * documento) en vez del que se recalcularía desde el término.
 *
 * Es importante al EDITAR: las cuotas guardadas son la verdad del documento
 * — incluyen las fechas que el usuario negoció a mano en su momento. Si el
 * editor las regenerara desde el término, se perderían silenciosamente.
 */
export function cargarCuotasExistentes(containerId, cuotas) {
  const e = _cronogramas.get(containerId)
  if (!e || !cuotas?.length) return

  e.cuotas = [...cuotas]
    .sort((a, b) => (a.numero_cuota || 0) - (b.numero_cuota || 0))
    .map((q, i) => ({
      numero_cuota: i + 1,
      fecha_vencimiento: String(q.fecha_vencimiento || '').slice(0, 10),
      monto: parseFloat(q.monto) || 0,
      hito: q.hito || null,
      // Se conserva el id para saber cuáles ya existían (hoy se regeneran
      // todas, pero el dato queda por si más adelante se hace incremental).
      id: q.id || null
    }))

  // Si el cronograma guardado no coincide con lo que generarían el término y
  // la fecha de emisión, significa que se editó a mano: se marca como
  // personalizado para que un cambio de total no lo regenere y lo pise.
  const termino = e.terminos.find(t => t.id === e.terminoId)
  const teorico = generarCronograma(termino, e.total, e.fechaEmision)
  const igual = teorico.length === e.cuotas.length && teorico.every((t, i) =>
    t.fecha_vencimiento === e.cuotas[i].fecha_vencimiento &&
    Math.abs(t.monto - e.cuotas[i].monto) < 0.01)
  e.personalizado = !igual

  _pintar(containerId)
}

// ============================================================================
// CREAR TÉRMINO DE PAGO AL VUELO (desde Nueva Venta / Nueva Compra)
// ============================================================================
// Antes solo se podía dar de alta un término desde Cobranzas → Términos de
// Pago, lejos de donde realmente se nota que hace falta uno: a mitad de
// facturar, cuando el cliente pide una condición que se repite seguido. Este
// modal se inyecta en el DOM la primera vez que se necesita (funciona igual
// en ventas.html, compras.html o cualquier página que use cronograma.js, sin
// que cada una tenga que declarar el modal en su HTML) y, al guardar,
// selecciona el término recién creado en el cronograma que lo pidió.

const MODAL_TERMINO_RAPIDO_ID = 'modal-crono-nuevo-termino'
let _terminoRapidoCuotas = []
let _terminoRapidoContainerId = null

function _asegurarModalTerminoRapido() {
  if (document.getElementById(MODAL_TERMINO_RAPIDO_ID)) return

  const div = document.createElement('div')
  div.id = MODAL_TERMINO_RAPIDO_ID
  div.className = 'modal'
  div.innerHTML = `
    <div class="modal-content" style="max-width: 560px;">
      <div class="modal-header">
        <h3 class="modal-title">Nuevo Término de Pago</h3>
        <button class="modal-close" type="button" data-crt="cerrar">✕</button>
      </div>
      <div style="padding:20px; display:flex; flex-direction:column; gap:14px;">
        <div style="display:grid; grid-template-columns:2fr 1fr; gap:12px;">
          <div class="form-group">
            <label>Nombre *</label>
            <input type="text" id="crtNombre" placeholder="Ej: Crédito 90 días">
          </div>
          <div class="form-group">
            <label>Tipo</label>
            <select id="crtTipo">
              <option value="credito">Crédito</option>
              <option value="contado">Contado</option>
              <option value="hito">Por hito / evento</option>
            </select>
          </div>
        </div>
        <div id="crtCuotasBody"></div>
        <div>
          <button type="button" class="btn btn-small btn-secondary" data-crt="agregar">+ Agregar cuota</button>
        </div>
      </div>
      <div class="modal-footer">
        <button type="button" class="btn btn-secondary" data-crt="cerrar">Cancelar</button>
        <button type="button" class="btn btn-primary" data-crt="guardar">💾 Guardar Término</button>
      </div>
    </div>`
  document.body.appendChild(div)

  div.querySelectorAll('[data-crt="cerrar"]').forEach(b => b.addEventListener('click', _cerrarModalTerminoRapido))
  div.querySelector('[data-crt="agregar"]').addEventListener('click', () => {
    const ultima = _terminoRapidoCuotas[_terminoRapidoCuotas.length - 1]
    _terminoRapidoCuotas.push({ porcentaje: 0, dias: (ultima?.dias || 0) + 30, hito: '' })
    _pintarCuotasTerminoRapido()
  })
  div.querySelector('[data-crt="guardar"]').addEventListener('click', _guardarTerminoRapido)
  document.getElementById('crtTipo').addEventListener('change', (ev) => {
    // "Contado" es siempre 1 cuota a 0 días — no tiene sentido dejar editar
    // porcentaje/días en ese caso.
    if (ev.target.value === 'contado') {
      _terminoRapidoCuotas = [{ porcentaje: 100, dias: 0, hito: '' }]
      _pintarCuotasTerminoRapido(true)
    }
  })
}

function _pintarCuotasTerminoRapido(soloLecturaContado = false) {
  const body = document.getElementById('crtCuotasBody')
  if (!body) return
  const suma = _terminoRapidoCuotas.reduce((s, c) => s + (parseFloat(c.porcentaje) || 0), 0)
  body.innerHTML = `
    <div class="table-container">
      <table>
        <thead><tr><th>%</th><th>Días</th><th>Hito (opcional)</th>${soloLecturaContado ? '' : '<th></th>'}</tr></thead>
        <tbody>
          ${_terminoRapidoCuotas.map((c, i) => `
            <tr>
              <td><input type="number" step="0.01" min="0" max="100" value="${c.porcentaje}" data-crt-cuota="pct" data-i="${i}" style="max-width:90px;" ${soloLecturaContado ? 'disabled' : ''}></td>
              <td><input type="number" step="1" min="0" value="${c.dias}" data-crt-cuota="dias" data-i="${i}" style="max-width:90px;" ${soloLecturaContado ? 'disabled' : ''}></td>
              <td><input type="text" value="${_esc(c.hito || '')}" data-crt-cuota="hito" data-i="${i}" ${soloLecturaContado ? 'disabled' : ''}></td>
              ${soloLecturaContado ? '' : `<td>${_terminoRapidoCuotas.length > 1 ? `<button type="button" class="btn btn-small btn-danger" data-crt-quitar="${i}">✕</button>` : ''}</td>`}
            </tr>`).join('')}
        </tbody>
      </table>
    </div>
    <small style="color:${Math.abs(suma - 100) < 0.02 ? 'var(--color-success)' : 'var(--color-danger)'};">Suma: ${suma.toFixed(2)}% ${Math.abs(suma - 100) < 0.02 ? '✓' : '(debe sumar 100%)'}</small>`

  body.querySelectorAll('[data-crt-cuota]').forEach(inp => {
    inp.addEventListener('input', () => {
      const i = parseInt(inp.getAttribute('data-i'))
      const campo = inp.getAttribute('data-crt-cuota')
      if (!_terminoRapidoCuotas[i]) return
      if (campo === 'pct') _terminoRapidoCuotas[i].porcentaje = parseFloat(inp.value) || 0
      else if (campo === 'dias') _terminoRapidoCuotas[i].dias = parseInt(inp.value) || 0
      else _terminoRapidoCuotas[i].hito = inp.value.trim()
    })
  })
  body.querySelectorAll('[data-crt-quitar]').forEach(btn => {
    btn.addEventListener('click', () => {
      _terminoRapidoCuotas.splice(parseInt(btn.getAttribute('data-crt-quitar')), 1)
      _pintarCuotasTerminoRapido()
    })
  })
}

function _abrirModalNuevoTermino(containerId) {
  _asegurarModalTerminoRapido()
  _terminoRapidoContainerId = containerId
  _terminoRapidoCuotas = [{ porcentaje: 100, dias: 30, hito: '' }]
  document.getElementById('crtNombre').value = ''
  document.getElementById('crtTipo').value = 'credito'
  _pintarCuotasTerminoRapido()
  window.openModal?.(MODAL_TERMINO_RAPIDO_ID)
}

function _cerrarModalTerminoRapido() {
  window.closeModal?.(MODAL_TERMINO_RAPIDO_ID)
}

async function _guardarTerminoRapido() {
  const nombre = document.getElementById('crtNombre')?.value?.trim()
  const tipo = document.getElementById('crtTipo')?.value || 'credito'
  if (!nombre) { alert('El nombre es obligatorio'); return }
  if (_terminoRapidoCuotas.length === 0) { alert('Agrega al menos una cuota'); return }

  const suma = _terminoRapidoCuotas.reduce((s, c) => s + (parseFloat(c.porcentaje) || 0), 0)
  if (Math.abs(suma - 100) > 0.02) { alert(`Los porcentajes deben sumar 100% (suman ${suma.toFixed(2)}%)`); return }
  if (_terminoRapidoCuotas.some(c => (parseFloat(c.porcentaje) || 0) <= 0)) { alert('Ninguna cuota puede ser 0%'); return }

  try {
    // aplica_a queda en 'ambos': un término creado al vuelo desde Ventas o
    // Compras es igual de válido para el otro lado — no hay razón para
    // limitarlo al módulo donde se lo creó.
    const nuevo = await addTerminoPago({ nombre, tipo, aplica_a: 'ambos', descripcion: null, activo: true, orden: 99 })
    if (!nuevo?.id) throw new Error('no se pudo crear el término (¿nombre duplicado?)')

    for (let i = 0; i < _terminoRapidoCuotas.length; i++) {
      const c = _terminoRapidoCuotas[i]
      await addTerminoPagoCuota({
        termino_id: nuevo.id, orden: i + 1,
        porcentaje: parseFloat(c.porcentaje), dias: parseInt(c.dias) || 0,
        hito: c.hito || null
      })
    }

    invalidarCacheTerminos()
    const containerId = _terminoRapidoContainerId
    _cerrarModalTerminoRapido()

    if (containerId) {
      const e = _cronogramas.get(containerId)
      if (e) {
        const todos = await getTerminosConCuotas(true)
        e.terminos = todos.filter(t => t.aplica_a === 'ambos' || t.aplica_a === e.aplicaA)
        e.terminoId = nuevo.id
        e.personalizado = false
        e.cuotas = generarCronograma(e.terminos.find(t => t.id === nuevo.id), e.total, e.fechaEmision)
        _pintar(containerId)
      }
    }
  } catch (e) {
    alert('Error al guardar el término: ' + e.message)
  }
}
