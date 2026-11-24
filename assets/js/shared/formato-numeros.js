// ============================================================================
// shared/formato-numeros.js — ESTÁNDAR de importes en campos numéricos
// (2026-11-18) · se carga UNA vez para todo el sistema (import en helpers.js)
// ----------------------------------------------------------------------------
// Problema: <input type="number"> no admite separador de miles y usa el idioma
// del equipo ("1152,00"). Cambiarlo a texto rompería todo parseFloat(.value).
//
// Solución ("letrero encima del campo"):
//   · El input sigue siendo type=number y su .value NO cambia (1152.5).
//   · Fuera de foco se muestra encima un <span> con el número formateado
//     estilo ERP: 1,152.50 (coma de miles, punto decimal).
//   · Al enfocar, desaparece el letrero y se edita el número limpio.
//   · Decimales: se respetan los del valor; importes (total, monto, precio,
//     saldo…) se completan a mínimo 2. Máximo 6 (precio unitario).
//   · Pegar "1.152,00", "1,152.00" o "S/ 1,152.00" → se convierte solo.
//
// Exclusión (no son importes): atributo data-sin-miles, o id/name que
// coincida con año/orden/ubigeo/correlativo/dígitos/días/% (ver _EXCLUIR).
// Valores < 1000 igual se muestran con punto decimal (consistencia), sin coma.
// ============================================================================

const _EXCLUIR = /(^|[^a-z])(anio|ano|año|year|orden|ubigeo|correlativo|digitos|dias|porc|pct|nro_?cuota|cuota_?n|hora|minuto|zoom|escala|rango)/i
const _IMPORTE = /(total|importe|monto|subtotal|saldo|pago|cobro|precio|costo|valor|base|igv|abono|flete|retenc|percep|detracc|haber|debe|tc|tipo_?cambio|tipocambio|sueldo|neto|bruto)/i
const _SEL = 'input[type="number"]'
const _vistas = new WeakMap()       // input → span
let _css = false

function _asegurarCss() {
  if (_css) return
  _css = true
  const st = document.createElement('style')
  st.id = 'formato-numeros-css'
  st.textContent = `
    input.nm-on:not(:focus) { color: transparent !important; -webkit-text-fill-color: transparent !important; }
    input.nm-on:not(:focus)::-webkit-inner-spin-button, input.nm-on:not(:focus)::-webkit-outer-spin-button { opacity: 0; }
    .nm-vista { position: absolute; pointer-events: none; overflow: hidden; white-space: nowrap; box-sizing: border-box;
                display: flex; align-items: center; z-index: 1; font-variant-numeric: tabular-nums; }
    input.nm-sin-trans { transition: none !important; }
    .nm-vista[hidden] { display: none !important; }`
  document.head.appendChild(st)
}

const _clave = el => `${el.id || ''} ${el.name || ''} ${el.className || ''}`.toLowerCase()
function _excluido(el) {
  if (el.hasAttribute('data-sin-miles') || el.closest('[data-sin-miles]')) return true
  const min = parseFloat(el.min), max = parseFloat(el.max)
  if (min >= 1900 && max <= 2200) return true            // años
  return _EXCLUIR.test(_clave(el))
}

/** ¿Es importe? por id/name/clase, por su <label> o por el encabezado de su columna. */
function _esImporte(el) {
  if (el.hasAttribute('data-importe')) return true
  if (_IMPORTE.test(_clave(el))) return true
  const lab = el.labels?.[0]?.textContent || el.closest('.form-group')?.querySelector('label')?.textContent || ''
  if (lab && _IMPORTE.test(lab.toLowerCase())) return true
  const td = el.closest('td'), tabla = td?.closest('table')
  const th = tabla?.tHead?.rows?.[0]?.cells?.[td.cellIndex]
  return !!(th && _IMPORTE.test(th.textContent.toLowerCase()))
}

/** "1152.5" → "1,152.50" (importe) · "2.875" → "2.875" · máx 6 decimales. */
export function formatoMiles(valor, { importe = false } = {}) {
  const s = String(valor ?? '').trim()
  if (s === '' || isNaN(Number(s))) return ''
  const n = Number(s)
  const crudos = (s.split('.')[1] || '').replace(/e.*$/i, '').length
  // Más de 6 decimales = ruido de coma flotante (7407.406800000001): se recorta sin rellenar ceros
  const dec = crudos > 6 ? 0 : crudos
  const min = importe ? Math.max(2, dec) : dec
  return n.toLocaleString('en-US', { minimumFractionDigits: min, maximumFractionDigits: Math.max(min, 6) })
}

/** Texto pegado de Excel/banco → número JS. "1.152,00"→1152 · "1,152.00"→1152 · "S/ 1 152,5"→1152.5 */
export function parsearImporte(txt) {
  let t = String(txt ?? '').replace(/[^\d.,\-]/g, '')
  if (!t) return NaN
  const uc = t.lastIndexOf(','), up = t.lastIndexOf('.')
  if (uc > -1 && up > -1) {                 // ambos: el ÚLTIMO es el decimal
    t = uc > up ? t.replace(/\./g, '').replace(',', '.') : t.replace(/,/g, '')
  } else if (uc > -1) {                     // solo comas: decimal si hay 1 y ≤2 dígitos después
    const partes = t.split(',')
    t = (partes.length === 2 && partes[1].length <= 2) ? partes.join('.') : partes.join('')
  } else if (up > -1) {
    const partes = t.split('.')
    if (partes.length > 2) t = partes.join('')            // 1.152.300 → miles
    else if (partes[1].length === 3 && partes[0].length <= 3 && /^-?\d{1,3}$/.test(partes[0])) t = partes.join('')  // 1.152 → 1152
  }
  return parseFloat(t)
}

function _vista(el) {
  let sp = _vistas.get(el)
  if (sp && sp.isConnected) return sp
  if (!el.parentNode) return null
  // El letrero debe vivir en el MISMO contenedor con scroll que el input (si no, al hacer
  // scroll en el modal se quedaría flotando): el padre del input pasa a ser su referencia.
  const pa = el.parentNode
  if (pa.nodeType === 1 && getComputedStyle(pa).position === 'static') { pa.style.position = 'relative'; pa.dataset.nmRel = '1' }
  sp = document.createElement('span')
  sp.className = 'nm-vista'
  sp.setAttribute('aria-hidden', 'true')
  el.insertAdjacentElement('afterend', sp)
  _vistas.set(el, sp)
  return sp
}

function _pintar(el) {
  if (!el.isConnected || el.type !== 'number' || _excluido(el)) { _quitar(el); return }
  const txt = formatoMiles(el.value, { importe: _esImporte(el) })
  const enFoco = document.activeElement === el
  // Sin valor, en foco o invisible → sin letrero
  if (!txt || enFoco || !el.offsetParent) { el.classList.remove('nm-on'); const s = _vistas.get(el); if (s) s.hidden = true; return }
  const sp = _vista(el); if (!sp) return
  const cs = getComputedStyle(el)
  // Color REAL del texto: se lee una vez antes de volverlo transparente (las transiciones CSS
  // harían leer un color intermedio). Se refresca si cambia disabled/readonly.
  const est = (el.disabled ? 'd' : '') + (el.readOnly ? 'r' : '')
  if (el._nmColor == null || el._nmEst !== est) {
    el.classList.add('nm-sin-trans'); el.classList.remove('nm-on')
    el._nmColor = getComputedStyle(el).color; el._nmEst = est
    el.classList.remove('nm-sin-trans')
  }
  const color = el._nmColor
  // Mismo tamaño y tipografía que el input
  Object.assign(sp.style, {
    width: el.offsetWidth + 'px', height: el.offsetHeight + 'px',
    paddingLeft: (parseFloat(cs.paddingLeft) + parseFloat(cs.borderLeftWidth)) + 'px',
    paddingRight: (parseFloat(cs.paddingRight) + parseFloat(cs.borderRightWidth)) + 'px',
    font: cs.font, letterSpacing: cs.letterSpacing, color, opacity: el.disabled ? cs.opacity : '',
    justifyContent: (cs.textAlign === 'right' || cs.textAlign === 'end') ? 'flex-end' : (cs.textAlign === 'center' ? 'center' : 'flex-start')
  })
  // Posición: se mide en pantalla (funciona dentro de <td>, modales, flex/grid)
  sp.hidden = false
  sp.style.left = '0px'; sp.style.top = '0px'
  const r0 = sp.getBoundingClientRect(), ri = el.getBoundingClientRect()
  // Si el modal está animando (transform: scale), los rects vienen escalados
  const k = sp.offsetWidth ? (r0.width / sp.offsetWidth) || 1 : 1
  const L = Math.round((ri.left - r0.left) / k), T = Math.round((ri.top - r0.top) / k)
  sp.style.left = L + 'px'
  sp.style.top = T + 'px'
  // Modales que entran animados (translate/scale): volver a medir hasta que la posición se estabilice
  const pos = L + ',' + T
  if (sp._nmPos !== pos) { sp._nmPos = pos; setTimeout(() => _programar(el), 250) }
  sp.textContent = txt
  sp.hidden = false
  el.classList.add('nm-on')
}
function _quitar(el) {
  el.classList.remove('nm-on')
  const s = _vistas.get(el); if (s) { s.remove(); _vistas.delete(el) }
}

// ── Repintado en lote (un frame) ────────────────────────────────────────────
const _pend = new Set(); let _raf = 0
function _programar(el) {
  _pend.add(el)
  if (!_raf) _raf = requestAnimationFrame(() => { _raf = 0; const l = [..._pend]; _pend.clear(); l.forEach(_pintar) })
}
const _ro = window.ResizeObserver ? new ResizeObserver(ents => ents.forEach(e => _programar(e.target))) : null

function _enganchar(el) {
  if (el._nmOk) return
  el._nmOk = true
  _asegurarCss()
  el.addEventListener('focus', () => _pintar(el))
  el.addEventListener('blur', () => _programar(el))
  el.addEventListener('input', () => { if (document.activeElement !== el) _programar(el) })
  el.addEventListener('change', () => _programar(el))
  el.addEventListener('paste', ev => {
    const txt = ev.clipboardData?.getData('text') ?? ''
    if (/^-?\d+(\.\d+)?$/.test(txt.trim())) return              // ya es un número limpio: comportamiento normal
    const n = parsearImporte(txt)
    if (isNaN(n)) return
    ev.preventDefault()
    el.value = String(n)
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
  })
  _ro?.observe(el)
  _programar(el)
}

// ── Valores puestos por código (el.value = x no dispara eventos) ────────────
;(function _hookValue() {
  const d = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')
  if (!d?.set || HTMLInputElement.prototype._nmHook) return
  HTMLInputElement.prototype._nmHook = true
  Object.defineProperty(HTMLInputElement.prototype, 'value', {
    configurable: true, enumerable: d.enumerable,
    get() { return d.get.call(this) },
    set(v) { d.set.call(this, v); if (this._nmOk) _programar(this) }
  })
})()

// ── Inputs que aparecen después (modales, tablas re-pintadas) ───────────────
function _escanear(raiz) {
  if (raiz.nodeType !== 1) return
  if (raiz.matches?.(_SEL)) _enganchar(raiz)
  raiz.querySelectorAll?.(_SEL).forEach(_enganchar)
}
function _iniciar() {
  _escanear(document.body)
  new MutationObserver(muts => {
    for (const m of muts) {
      m.addedNodes.forEach(n => _escanear(n))
      if (m.type === 'attributes' && m.target.matches?.(_SEL)) _programar(m.target)
    }
  }).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['type', 'disabled', 'readonly', 'hidden', 'style'] })
  // Modales/pestañas que se muestran: re-ubicar letreros
  document.addEventListener('click', () => setTimeout(() => document.querySelectorAll('input.nm-on, ' + _SEL).forEach(el => el._nmOk && _programar(el)), 60), true)
  const _reubicar = () => document.querySelectorAll('input.nm-on').forEach(el => _programar(el))
  document.addEventListener('animationend', _reubicar, true)
  document.addEventListener('transitionend', _reubicar, true)
  window.addEventListener('resize', () => document.querySelectorAll(_SEL).forEach(el => el._nmOk && _programar(el)))
}
if (!window.__formatoNumeros) {
  window.__formatoNumeros = true
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', _iniciar)
  else _iniciar()
}
window.formatoMiles = formatoMiles
window.parsearImporte = parsearImporte
