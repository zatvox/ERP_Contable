// ============================================================================
// animaciones/cargador.js — overlay de carga del ERP
// Mapa completo de funciones: Claude outputs/glosario_funciones_erp.md
// ============================================================================
//
// QUÉ RESUELVE
// Una importación masiva real tarda ~1 minuto. Durante ese minuto la pantalla
// se veía igual que siempre y el botón decía "Importando..." en letra chica:
// no se sabe si avanza, si se colgó o cuánto falta. Este módulo oscurece todo
// lo de atrás, pone el logo de la empresa al frente y muestra progreso real.
//
// TRES IDEAS
//   1. El ritmo se calcula, no se fija. Un archivo de 5 documentos late
//      rápido; uno de 500 late lento. Un parpadeo nervioso durante un minuto
//      cansa; una animación lenta en medio segundo se ve trabada.
//   2. El progreso es real. Si quien llama pasa `total`, el aro se llena de
//      verdad y el tiempo restante se estima con el ritmo medido, no con un
//      número inventado.
//   3. El color y el logo salen de la empresa de trabajo — el mismo criterio
//      del riel de los modales: saber en qué empresa estás sin leer nada.
//
// USO
//   import { conCarga, actualizarCarga } from '../animaciones/index.js'
//
//   await conCarga({ titulo: 'Importando compras', total: grupos.size }, async () => {
//     for (const g of grupos) { ...; actualizarCarga() }
//   })
//
// También sirve suelto: mostrarCarga() ... ocultarCarga(). Siempre en un
// `finally`, para que un error no deje la pantalla tapada.

import { ESTILOS_CARGA, estiloActual, guardarEstilo, estiloPorId } from './catalogo-animaciones.js'

const RUTA_CSS = 'assets/css/animaciones.css'

let _overlay = null
let _estado = null      // { total, hechos, inicio, timer }
let _cssPuesto = false

// ── CSS: se inyecta solo, así ninguna página HTML necesita tocarse ─────────
function _asegurarCss() {
  if (_cssPuesto) return
  if (!document.querySelector(`link[href*="${RUTA_CSS}"]`)) {
    const l = document.createElement('link')
    l.rel = 'stylesheet'
    l.href = RUTA_CSS
    document.head.appendChild(l)
  }
  _cssPuesto = true
}

function _esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

// ── Identidad de la empresa de trabajo ────────────────────────────────────
// Import dinámico a propósito: si `empresa.js` todavía no resolvió su
// contexto, o la página no lo carga, el cargador igual funciona en gris.
async function _empresaActual() {
  try {
    const mod = await import('../empresa.js')
    const id = mod.empresaTrabajo?.()
    const e = id != null ? mod.empresaById?.(id) : null
    if (e) {
      return {
        color: e.color || '#3b82f6',
        logoUrl: e.logo_url || null,
        monograma: String(e.codigo || e.nombre_comercial || 'E').trim().charAt(0).toUpperCase(),
        nombre: e.nombre_comercial || e.codigo || e.razon_social || ''
      }
    }
  } catch (_) { /* sin contexto de empresa: se usa el neutro */ }
  return { color: '#3b82f6', logoUrl: null, monograma: 'E', nombre: '' }
}

// ── Ritmo: la velocidad sale del peso del trabajo ─────────────────────────
// 20 documentos → ~0.9 s por ciclo (ágil). 500 → ~2.4 s (calmo).
// El `tempo` del estilo lo ajusta después: el cine respira más lento que el
// anime aunque el archivo sea el mismo.
function _velocidad(total, tempo = 1) {
  const n = Number(total) > 0 ? Number(total) : 60
  const base = 0.75 + Math.min(n, 600) / 360        // 0.75 s … 2.42 s
  return (Math.round(base * tempo * 100) / 100) + 's'
}

function _formatearSegundos(s) {
  if (!isFinite(s) || s < 0) return ''
  if (s < 10) return 'unos segundos'
  if (s < 60) return `~${Math.round(s / 5) * 5} s`
  const m = Math.floor(s / 60)
  const r = Math.round((s % 60) / 15) * 15
  return r >= 60 || r === 0 ? `~${m + (r >= 60 ? 1 : 0)} min` : `~${m} min ${r} s`
}

const RADIO = 61
const PERIMETRO = 2 * Math.PI * RADIO

/**
 * Muestra el overlay de carga.
 * @param {object} opts
 * @param {string} opts.titulo     Qué está pasando. Ej. 'Importando compras'.
 * @param {string} [opts.subtitulo] Contexto. Ej. '47 documentos · BENJI'.
 * @param {number} [opts.total]    Si se pasa, el aro mide progreso real y se
 *                                 estima el tiempo restante. Si no, gira.
 * @param {string} [opts.estilo]   Fuerza un estilo del catálogo; por defecto
 *                                 el que el usuario eligió en Configuración.
 */
export async function mostrarCarga({ titulo = 'Procesando...', subtitulo = '', total = 0, estilo = null } = {}) {
  _asegurarCss()
  ocultarCarga(true)   // nunca dos overlays encima

  const est = estiloPorId(estilo || estiloActual())
  const emp = await _empresaActual()
  const indet = !(Number(total) > 0)

  const el = document.createElement('div')
  el.className = 'carga-overlay'
  el.setAttribute('role', 'status')
  el.setAttribute('aria-live', 'polite')
  el.dataset.estilo = est.id
  el.dataset.indeterminado = indet ? '1' : '0'
  el.style.setProperty('--emp', emp.color)
  el.style.setProperty('--carga-vel', _velocidad(total, est.tempo))

  const marca = emp.logoUrl
    ? `<img src="${_esc(emp.logoUrl)}" alt="${_esc(emp.nombre)}">`
    : _esc(emp.monograma)

  el.innerHTML = `
    <div class="carga-fondo"></div>
    <!-- Telón: lo que cubre la pantalla entera. Cuelga del overlay y no de la
         escena porque la escena se anima con transform, y un transform crea
         bloque contenedor: un position:fixed adentro se quedaría del tamaño
         de la escena en vez de cubrir la ventana. -->
    <div class="carga-telon">${est.decoradoFondo || ''}</div>
    <div class="carga-escena">
      <!-- El decorado va DENTRO del emblema a propósito: así su centro (50% 50%)
           es el centro del logo. Colgado de la escena, su centro caía entre el
           logo y el bloque de texto y los aros quedaban descuadrados hacia
           abajo. Los efectos a pantalla completa (líneas de anime, bandas de
           cine) usan position:fixed y no dependen de este contenedor. -->
      <div class="carga-emblema">
        <div class="carga-decorado">${est.decorado}</div>
        <svg class="carga-aro" viewBox="0 0 132 132" aria-hidden="true">
          <circle class="pista"  cx="66" cy="66" r="${RADIO}"></circle>
          <circle class="avance" cx="66" cy="66" r="${RADIO}"
                  stroke-dasharray="${PERIMETRO}" stroke-dashoffset="${PERIMETRO}"></circle>
        </svg>
        <div class="carga-logo">${marca}</div>
      </div>
      <div class="carga-texto">
        <h4 class="carga-titulo">${_esc(titulo)}</h4>
        <p class="carga-sub">${_esc(subtitulo || emp.nombre)}</p>
        <div class="carga-barra"><i></i></div>
        <p class="carga-detalle"></p>
      </div>
    </div>`

  document.body.appendChild(el)
  requestAnimationFrame(() => el.classList.add('visible'))

  _overlay = el
  _estado = { total: Number(total) || 0, hechos: 0, inicio: Date.now(), timer: null }

  // Refresco del tiempo restante aunque quien llama no avise seguido: en una
  // importación el bucle puede tardar segundos entre documento y documento.
  _estado.timer = setInterval(() => _pintarDetalle(), 1000)
  _pintarDetalle()
  return el
}

/**
 * Avanza el progreso.
 * @param {number} [hechos] Absoluto. Si se omite, suma 1.
 * @param {string} [etiqueta] Qué se está procesando ahora (ej. el N° de
 *                 documento). Va DELANTE del conteo, no en su lugar: ver qué
 *                 documento se atascó sin perder el "faltan ~38 s".
 */
export function actualizarCarga(hechos, etiqueta) {
  if (!_overlay || !_estado) return
  _estado.hechos = (hechos == null) ? _estado.hechos + 1 : Number(hechos) || 0
  if (etiqueta != null) _estado.texto = etiqueta

  if (_estado.total > 0) {
    const frac = Math.max(0, Math.min(1, _estado.hechos / _estado.total))
    const avance = _overlay.querySelector('.carga-aro .avance')
    if (avance) avance.setAttribute('stroke-dashoffset', String(PERIMETRO * (1 - frac)))
    const barra = _overlay.querySelector('.carga-barra > i')
    if (barra) barra.style.width = `${(frac * 100).toFixed(1)}%`
  }
  _pintarDetalle()
}

/**
 * Cambia el título a mitad de camino y, si hace falta, arranca una fase nueva.
 * Los importadores tienen dos: primero validan el archivo entero y recién
 * después escriben. Son dos conteos distintos, no uno solo que va al doble.
 *
 * @param {string} [titulo]
 * @param {string} [subtitulo]
 * @param {number} [total] Si se pasa, reinicia el contador y el cronómetro.
 */
export function tituloCarga(titulo, subtitulo, total) {
  if (!_overlay || !_estado) return
  const t = _overlay.querySelector('.carga-titulo')
  if (t && titulo != null) t.textContent = titulo
  const s = _overlay.querySelector('.carga-sub')
  if (s && subtitulo != null) s.textContent = subtitulo

  if (total == null) return
  _estado.total = Number(total) || 0
  _estado.hechos = 0
  _estado.texto = ''
  _estado.inicio = Date.now()     // el ritmo de escribir no es el de validar
  _overlay.dataset.indeterminado = _estado.total > 0 ? '0' : '1'
  const avance = _overlay.querySelector('.carga-aro .avance')
  if (avance) avance.setAttribute('stroke-dashoffset', String(PERIMETRO))
  const barra = _overlay.querySelector('.carga-barra > i')
  if (barra) barra.style.width = '0%'
  _pintarDetalle()
}

function _pintarDetalle() {
  if (!_overlay || !_estado) return
  const d = _overlay.querySelector('.carga-detalle')
  if (!d) return

  const prefijo = _estado.texto ? `${_estado.texto} · ` : ''
  if (_estado.total <= 0) { d.textContent = _estado.texto || ''; return }

  const { hechos, total, inicio } = _estado
  const transcurrido = (Date.now() - inicio) / 1000
  let cola = ''
  // Recién con 2 documentos el ritmo medido significa algo; antes la
  // estimación sale de un solo dato y baila feo.
  if (hechos >= 2 && transcurrido > 1.5 && hechos < total) {
    const restante = (total - hechos) * (transcurrido / hechos)
    const txt = _formatearSegundos(restante)
    if (txt) cola = ` · faltan ${txt}`
  }
  d.textContent = `${prefijo}${hechos} de ${total}${cola}`
}

/** Quita el overlay. `inmediato` salta la transición de salida. */
export function ocultarCarga(inmediato = false) {
  if (_estado?.timer) clearInterval(_estado.timer)
  _estado = null
  const el = _overlay
  _overlay = null
  if (!el) return
  // Barrido: si por cualquier motivo quedó otro overlay colgado en el DOM, se
  // va con este. Tapar la pantalla es el peor estado posible para dejar algo.
  if (inmediato) {
    document.querySelectorAll('.carga-overlay').forEach(o => o.remove())
    return
  }
  el.classList.remove('visible')
  el.classList.add('saliendo')
  setTimeout(() => el.remove(), 300)
}

/**
 * Envoltura segura: muestra, ejecuta y oculta pase lo que pase.
 * Devuelve lo que devuelva `fn` y deja pasar sus errores sin tragárselos.
 */
export async function conCarga(opts, fn) {
  await mostrarCarga(opts)
  try {
    return await fn()
  } finally {
    ocultarCarga()
  }
}

// ============================================================================
// CATÁLOGO: elegir el estilo y verlo antes de elegirlo
// ============================================================================
// El modal se arma desde JS para no repetir markup en las 10 páginas.
window.abrirCatalogoAnimaciones = function () {
  _asegurarCss()
  document.getElementById('modal-catalogo-animaciones')?.remove()

  const actual = estiloActual()
  const m = document.createElement('div')
  m.id = 'modal-catalogo-animaciones'
  m.className = 'modal active'
  m.style.display = 'flex'
  m.innerHTML = `
    <div class="modal-content" style="max-width:720px;">
      <div class="modal-header">
        <h3 class="modal-title">Animación de carga</h3>
        <button class="modal-close" data-cerrar>✕</button>
      </div>
      <div style="padding:20px;">
        <p class="imp-resumen">Es lo que se ve mientras corre un proceso largo (una importación masiva, por ejemplo).
          La velocidad no se elige: se calcula según cuánto pese la carga. Haz clic en una tarjeta para verla 3 segundos.</p>
        <div class="anim-rejilla">
          ${ESTILOS_CARGA.map(e => `
            <button type="button" class="anim-tarjeta ${e.id === actual ? 'activa' : ''}" data-estilo="${e.id}">
              <span class="anim-familia">${_esc(e.familia)}</span>
              <b>${_esc(e.nombre)}${e.id === actual ? ' ✓' : ''}</b>
              <small>${_esc(e.descripcion)}</small>
            </button>`).join('')}
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" data-cerrar>Cerrar</button>
      </div>
    </div>`

  m.addEventListener('click', async (ev) => {
    if (ev.target.closest('[data-cerrar]') || ev.target === m) { m.remove(); return }
    const card = ev.target.closest('.anim-tarjeta')
    if (!card) return
    const id = card.dataset.estilo
    guardarEstilo(id)
    m.querySelectorAll('.anim-tarjeta').forEach(c => {
      c.classList.toggle('activa', c.dataset.estilo === id)
      const b = c.querySelector('b')
      if (b) b.textContent = b.textContent.replace(' ✓', '') + (c.dataset.estilo === id ? ' ✓' : '')
    })
    // Vista previa con un progreso falso, para ver el aro llenarse.
    const est = estiloPorId(id)
    await mostrarCarga({ titulo: est.nombre, subtitulo: 'Vista previa', total: 30, estilo: id })
    let n = 0
    const iv = setInterval(() => { actualizarCarga(n += 3) }, 100)
    setTimeout(() => { clearInterval(iv); ocultarCarga() }, 3000)
  })

  document.body.appendChild(m)
}

// Atajo para la consola y para botones sueltos: window.mostrarCarga(...)
window.mostrarCargaERP = mostrarCarga
window.ocultarCargaERP = ocultarCarga
