// ============================================================================
// EMPRESA.JS — Contexto multiempresa (switch estilo Odoo)
// ============================================================================
// Se carga en TODAS las páginas desde auth-init.js, con top-level await, para
// que el contexto esté listo ANTES de que cualquier módulo consulte Supabase.
//
// EL MODELO (decisión de Luis, 2026-10-14):
//
//   · EMPRESAS ACTIVAS  (varias)  → gobiernan la LECTURA.
//     Son los lentes bifocales: permiten VER dos almacenes a la vez para un
//     reporte combinado. Se inyectan como `.in('empresa_id', [...])` en el
//     punto central de supabase-client.js.
//
//   · EMPRESA DE TRABAJO (una)    → gobierna la ESCRITURA.
//     Cuando FIRMAS un documento, firmas con un solo sello: no existe una
//     factura "de las dos empresas". Todo INSERT lleva esta empresa.
//     Si hay 2+ activas, los modales obligan a confirmarla en un selector.
//
// Al cambiar de empresa se RECARGA la página (igual que Odoo). Es deliberado:
// hay caché en memoria, en sessionStorage y estado en los módulos; recargar es
// la única forma barata de garantizar que no quede un dato de la empresa
// anterior pintado en pantalla.
// ============================================================================

import { supabase, registrarContextoEmpresa, fromSinFiltro } from './supabase-client.js'
import { setSufijoEmpresaCache } from './data-cache.js'
import { getCurrentUser } from './auth-supabase.js'

const LS_ACTIVAS  = 'jhiro_empresas_activas'
const LS_TRABAJO  = 'jhiro_empresa_trabajo'

let _empresas = []      // todas las que este usuario puede ver
let _activas  = []      // ids marcados en el switch (lectura)
let _trabajo  = null    // id de la empresa de trabajo (escritura)
let _listo    = false

// El contexto se REGISTRA al cargar el módulo, no al terminar el init, para
// que cualquier consulta que llegue antes pueda esperarlo en vez de salir sin
// filtro. La promesa es el semáforo: hasta que no se resuelve, el helper CRUD
// no deja pasar ninguna lectura de una tabla con dueño.
let _resolverCtx
const _ctxPromesa = new Promise(res => { _resolverCtx = res })

registrarContextoEmpresa({
  activas: () => _activas,
  trabajo: () => _trabajo,
  listo:   () => _listo,
  promesa: _ctxPromesa
})

// Red de seguridad: si la consulta inicial se cuelga, el semáforo se abre
// igual a los 10 s. Con el contexto vacío el filtro deja todo fuera (no
// adentro), así que el peor caso es una pantalla vacía y un aviso en consola,
// nunca datos de otra empresa.
const _timeoutCtx = setTimeout(() => {
  if (!_listo) {
    console.error('[multiempresa] el contexto no se resolvió en 10 s. Las tablas saldrán vacías hasta recargar.')
    _listo = true
    _resolverCtx()
  }
}, 10000)

function _abrirSemaforo() { clearTimeout(_timeoutCtx); _listo = true; _resolverCtx() }

// ── Lectura del contexto ─────────────────────────────────────────────────────

export function empresasDisponibles() { return _empresas }
export function empresasActivas()     { return _activas.slice() }
export function empresaTrabajo()      { return _trabajo }
export function contextoEmpresaListo(){ return _listo }
export function esMultiEmpresaActiva(){ return _activas.length > 1 }
export function empresaById(id)       { return _empresas.find(e => e.id === Number(id)) || null }
export function nombreEmpresa(id) {
  const e = empresaById(id)
  return e ? (e.codigo || e.nombre_comercial || e.razon_social) : `Empresa ${id}`
}
/** Clave de caché: dos selecciones distintas no pueden compartir dataset. */
function _sufijoCache() { return 'e' + _activas.slice().sort((a, b) => a - b).join('-') + '_' }

// ── Persistencia (por usuario, para que no se filtre entre cuentas) ─────────

function _claveLS(base) {
  const u = getCurrentUser()
  return `${base}_u${u?.id || u?.email || 'anon'}`
}
function _guardar() {
  try {
    localStorage.setItem(_claveLS(LS_ACTIVAS), JSON.stringify(_activas))
    localStorage.setItem(_claveLS(LS_TRABAJO), String(_trabajo ?? ''))
  } catch { /* modo privado: el contexto vive sólo en esta pestaña */ }
}
function _leer() {
  try {
    const a = JSON.parse(localStorage.getItem(_claveLS(LS_ACTIVAS)) || 'null')
    const t = localStorage.getItem(_claveLS(LS_TRABAJO))
    return { activas: Array.isArray(a) ? a.map(Number) : null, trabajo: t ? Number(t) : null }
  } catch { return { activas: null, trabajo: null } }
}

// ── Inicialización ───────────────────────────────────────────────────────────

export async function initEmpresaContexto() {
  if (_listo) return

  const user = getCurrentUser()

  // Las empresas que este usuario puede ver. `empresas_permitidas` NULL o
  // vacío = todas (no rompe al admin ni a usuarios creados antes del SQL 87).
  const { data, error } = await supabase
    .from('empresa_config')
    .select('id, codigo, ruc, razon_social, nombre_comercial, color, orden, activo, logo_url, igv_porcentaje, moneda_base')
    .eq('activo', true)
    .order('orden', { ascending: true })

  if (error) {
    console.error('Multiempresa: no se pudo leer empresa_config', error)
    _abrirSemaforo()              // sin empresas ⇒ el filtro deja todo fuera
    return
  }

  // OJO: getCurrentUser() devuelve `id` = UUID de auth.users y `db_id` = bigint
  // de public.users. La FK y las policies usan el bigint; filtrar por el UUID
  // da error de tipo y deja al usuario sin permisos sin avisar.
  let permitidas = null
  const uid = user?.db_id ?? null
  if (uid != null) {
    const { data: u, error: eU } = await supabase
      .from('users').select('empresas_permitidas, empresa_id_default').eq('id', uid).maybeSingle()
    if (eU) console.warn('Multiempresa: no se pudieron leer los permisos del usuario', eU)
    if (u?.empresas_permitidas?.length) permitidas = u.empresas_permitidas.map(Number)
    if (u?.empresa_id_default) _trabajo = Number(u.empresa_id_default)
  }

  _empresas = (data || []).filter(e => !permitidas || permitidas.includes(e.id))
  if (!_empresas.length) _empresas = data || []     // nunca dejarlo sin empresa

  // Restaura la última selección, descartando ids que ya no puede ver.
  const guardado = _leer()
  const idsOk = new Set(_empresas.map(e => e.id))
  _activas = (guardado.activas || []).filter(id => idsOk.has(id))
  if (!_activas.length) _activas = [_trabajo && idsOk.has(_trabajo) ? _trabajo : _empresas[0].id]

  _trabajo = (guardado.trabajo && _activas.includes(guardado.trabajo))
    ? guardado.trabajo
    : _activas[0]

  _guardar()
  setSufijoEmpresaCache(_sufijoCache())
  _abrirSemaforo()                // a partir de aquí las consultas pasan filtradas

  console.log(`🏢 Multiempresa: activas [${_activas.map(nombreEmpresa).join(', ')}] · trabajo: ${nombreEmpresa(_trabajo)}`)

  // El contexto se resuelve con await, así que puede terminar DESPUÉS de que
  // DOMContentLoaded ya disparó. Si esperáramos sólo a ese evento, el handler
  // correría con la lista de empresas todavía vacía, se auto-ocultaría y el
  // chip no aparecería nunca — sin ningún error en consola. Por eso se monta
  // aquí mismo cuando el DOM ya está listo, y el listener queda sólo como
  // respaldo para el caso contrario. Montar dos veces es inofensivo: cada
  // paso comprueba si ya está hecho.
  if (document.readyState !== 'loading') montarUIEmpresa()
}

/** Idempotente: se puede llamar varias veces sin duplicar nada. */
export function montarUIEmpresa() {
  montarSwitchEmpresa()
  pintarLogoEmpresa()
  _envolverOpenModal()
}

// ── Cambios ──────────────────────────────────────────────────────────────────

/** Aplica una selección nueva y recarga. `trabajo` opcional. */
export function aplicarSeleccion(activas, trabajo = null) {
  // Si el contexto aún no terminó de armarse, `_trabajo` todavía tiene el
  // valor provisional (la empresa por defecto del usuario) y guardarlo
  // pisaría la selección real del usuario. El chip se monta después de
  // `_abrirSemaforo()`, así que por UI esto no pasa; esto protege del caso
  // de llamar a la API desde fuera.
  if (!_listo) { console.warn('[multiempresa] cambio de empresa ignorado: el contexto aún no está listo'); return }
  const idsOk = new Set(_empresas.map(e => e.id))
  const limpias = [...new Set((activas || []).map(Number))].filter(id => idsOk.has(id))
  if (!limpias.length) return

  _activas = limpias
  _trabajo = limpias.includes(Number(trabajo)) ? Number(trabajo)
           : (limpias.includes(_trabajo) ? _trabajo : limpias[0])
  _guardar()
  window.location.reload()
}

window.empresaSoloEsta   = (id) => aplicarSeleccion([Number(id)], Number(id))
window.empresaToggle     = (id) => {
  id = Number(id)
  const next = _activas.includes(id) ? _activas.filter(x => x !== id) : [..._activas, id]
  if (!next.length) return                       // nunca cero empresas
  aplicarSeleccion(next, next.includes(_trabajo) ? _trabajo : next[0])
}
window.empresaSetTrabajo = (id) => aplicarSeleccion(
  _activas.includes(Number(id)) ? _activas : [..._activas, Number(id)], Number(id))
window.empresaTodas      = () => aplicarSeleccion(_empresas.map(e => e.id), _trabajo)

// ── El switch en la cabecera ──────────────────────────────────────────────────

function _esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

export function montarSwitchEmpresa() {
  const header = document.querySelector('.header')
  if (!header || document.getElementById('switchEmpresa')) return
  if (!_empresas.length) return

  const trab  = empresaById(_trabajo)
  const extra = _activas.length - 1
  const etiqueta = `${_esc(nombreEmpresa(_trabajo))}${extra > 0 ? ` <span class="emp-extra">+${extra}</span>` : ''}`

  const cont = document.createElement('div')
  cont.id = 'switchEmpresa'
  cont.className = 'emp-switch'
  cont.innerHTML = `
    <button type="button" class="emp-chip" onclick="window._empAbrirPanel(this, event)"
            title="Empresa de trabajo: ${_esc(nombreEmpresa(_trabajo))}">
      <span class="emp-punto" style="background:${_esc(trab?.color || '#2563eb')}"></span>
      <span class="emp-nombre">${etiqueta}</span>
      <span class="emp-caret">▾</span>
    </button>`
  header.appendChild(cont)

  // Barra de color: con 2+ empresas activas es lo que evita emitir un
  // documento en la empresa equivocada. Un semáforo, no un adorno.
  // Con 2+ empresas activas las tablas muestran filas de todas y no hay una
  // columna que diga de quién es cada una. En vez de tocar las ~20 funciones
  // que pintan tablas, se declara el estado UNA vez, debajo de la cabecera:
  // qué estás viendo y dónde se guarda. Una tabla combinada se lee bien si
  // sabes de antemano que es combinada.
  if (_activas.length > 1 && !document.querySelector('.emp-barra-aviso')) {
    const vistas = _activas.map(id => {
      const e = empresaById(id)
      return `<span class="emp-pill" style="--emp:${_esc(e?.color || '#2563eb')}">${_esc(nombreEmpresa(id))}</span>`
    }).join('')
    const barra = document.createElement('div')
    barra.className = 'emp-barra-aviso'
    barra.style.setProperty('--emp', trab?.color || '#2563eb')
    barra.innerHTML = `
      <span class="emp-barra-txt">Viendo ${vistas}</span>
      <span class="emp-barra-sep">·</span>
      <span class="emp-barra-txt">se guarda en <strong>${_esc(nombreEmpresa(_trabajo))}</strong></span>`
    barra.title = 'Las tablas muestran las empresas marcadas. Lo que crees se guardará en la empresa de trabajo.'
    header.insertAdjacentElement('afterend', barra)
  }
}

let _panelEmp = null
function _cerrarPanelEmp() { if (_panelEmp) { _panelEmp.remove(); _panelEmp = null } }

window._empAbrirPanel = function (boton, ev) {
  if (ev) ev.stopPropagation()
  if (_panelEmp) { _cerrarPanelEmp(); return }

  const filas = _empresas.map(e => {
    const activa  = _activas.includes(e.id)
    const trabaja = e.id === _trabajo
    return `
      <div class="emp-fila${activa ? ' activa' : ''}">
        <label class="emp-check" title="Ver/ocultar esta empresa en los reportes">
          <input type="checkbox" ${activa ? 'checked' : ''} onchange="window.empresaToggle(${e.id})">
        </label>
        <button type="button" class="emp-fila-nombre" onclick="window.empresaSoloEsta(${e.id})"
                title="Trabajar sólo en ${_esc(e.razon_social)}">
          <span class="emp-punto" style="background:${_esc(e.color || '#2563eb')}"></span>
          <span>
            <strong>${_esc(e.codigo || e.nombre_comercial)}</strong>
            <small>${_esc(e.ruc)}</small>
          </span>
        </button>
        <button type="button" class="emp-sello${trabaja ? ' on' : ''}"
                onclick="window.empresaSetTrabajo(${e.id})"
                title="${trabaja ? 'Es la empresa de trabajo: aquí se guardan los documentos nuevos' : 'Usar como empresa de trabajo'}">
          ${trabaja ? '✍️' : '○'}
        </button>
      </div>`
  }).join('')

  const p = document.createElement('div')
  p.className = 'acciones-menu emp-panel'
  p.innerHTML = `
    <div class="emp-panel-head">
      <strong>Empresa</strong>
      <small>✔ = la ves en reportes · ✍️ = donde se guarda</small>
    </div>
    ${filas}
    <div class="acciones-separador"></div>
    <button type="button" class="acciones-item" onclick="window.empresaTodas()">
      <span class="acciones-icono">🌐</span><span>Ver todas las empresas</span></button>
    <a class="acciones-item" href="perfil.html#multiempresa" target="_self">
      <span class="acciones-icono">⚙️</span><span>Gestionar empresas y permisos</span></a>`

  document.body.appendChild(p)
  const r = boton.getBoundingClientRect()
  p.style.position = 'fixed'
  p.style.top  = `${r.bottom + 6}px`
  p.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - p.offsetWidth - 8))}px`
  p.style.zIndex = 9999
  requestAnimationFrame(() => p.classList.add('visible'))   // .acciones-menu nace en opacity:0
  _panelEmp = p

  setTimeout(() => {
    document.addEventListener('click', function cerrar(e) {
      if (_panelEmp && !_panelEmp.contains(e.target)) { _cerrarPanelEmp(); document.removeEventListener('click', cerrar) }
    })
  }, 0)
}

// El logo del sidebar sigue a la empresa de trabajo (hoy dice "JHIRO" fijo en
// las 10 páginas: con el switch en Benji eso desorienta).
export function pintarLogoEmpresa() {
  const logo = document.querySelector('.sidebar-logo')
  if (logo && _trabajo) {
    const e = empresaById(_trabajo)
    logo.textContent = e?.codigo || e?.nombre_comercial || 'ERP'
    logo.style.color = e?.color || ''
  }
}



// ============================================================================
// GUARDA: no crear un documento a partir de otro de OTRA empresa
// ============================================================================
// Con 2+ empresas activas las listas muestran documentos de todas (ese es el
// sentido del multi-select). Pero emitir una NC desde una factura de Jhiro
// estando en Benji crearía un documento mestizo. La BD ya lo frena cuando la
// nota toca lotes, pero no cuando es una NC sin detalle de stock.
//
// Puedes MIRAR el archivo de otra empresa; no puedes firmar encima de él.
export async function exigirEmpresaDeTrabajo(tabla, id, queEs = 'Este documento') {
  const emp = _trabajo
  if (emp == null || id == null) return true
  try {
    const { data } = await fromSinFiltro(tabla).select('empresa_id').eq('id', id).maybeSingle()
    if (!data || Number(data.empresa_id) === Number(emp)) return true
    const msg = `${queEs} es de ${nombreEmpresa(data.empresa_id)} y estás trabajando en `
              + `${nombreEmpresa(emp)}. Cambia la empresa de trabajo en el switch de la cabecera.`
    if (typeof window.showToast === 'function') window.showToast(msg, 'warning', 9000)
    else alert(msg)
    return false
  } catch { return true }   // ante la duda no se bloquea: el candado de la BD sigue detrás
}

// ============================================================================
// CINTILLO DE EMPRESA EN LOS MODALES
// ============================================================================
// Todo modal de crear, editar o eliminar dice de qué empresa es el registro
// que tienes delante. Dos piezas, deliberadamente calladas:
//
//   · RIEL — 3 px del color de la empresa en el borde superior del modal.
//     Se lee de reojo, sin leerlo. Es el mismo truco del color en el switch.
//   · EMBLEMA — monograma sobre chip tintado + código en versalitas con
//     letter-spacing amplio + RUC en cifras tabulares, pequeño y atenuado.
//     Sin fuente externa: el peso visual lo da el tratamiento, no un archivo
//     que haya que descargar y que falle sin internet.
//
// En CREAR manda la empresa de trabajo (el registro todavía no existe).
// En EDITAR y ELIMINAR manda el `empresa_id` DEL REGISTRO: si estás en Benji
// mirando una factura de Jhiro, el modal dice JHIRO y el riel avisa del
// desajuste. Mentirte con BENJI sería peor que no poner nada.
//
// Un modal nuevo queda cubierto solo. Para corregir la empresa mostrada:
//   marcarEmpresaModal('modal-x', idEmpresa)
//   await marcarEmpresaModalDesdeRegistro('modal-x', 'ventas', ventaId)

// Sub-modales y utilitarios: no llevan cintillo propio. Una línea de venta no
// es un documento, y duplicar el riel sobre el modal padre es ruido.
const RE_MODAL_SIN_CINTILLO = /linea|adjunt|buscador|ayuda|columnas|detalle-nota|^modal-empresa$/i

// Modales que crean registros del CATÁLOGO COMPARTIDO (sin empresa_id):
// productos, categorías, marcas, partidas, contactos, términos de pago.
// Decirles "se guardará en BENJI" sería mentira: ese producto lo van a ver
// las tres. Llevan un cintillo propio que lo afirma — es exactamente la duda
// que surge al ver la tabla de Productos vacía en una empresa sin lotes.
// 'pagos-proveedor' es un registro OPERATIVO de la carpeta (tiene empresa), no el catálogo de proveedores.
const RE_MODAL_COMPARTIDO = /^(?!modal-pagos-proveedor$).*(producto|categoria|marca|partida|cliente|proveedor|contacto|termino-pago)/i

function _inicial(e) {
  const t = (e?.codigo || e?.nombre_comercial || e?.razon_social || '?').trim()
  return t.charAt(0).toUpperCase()
}

/** Cintillo neutro para el catálogo compartido. */
function _cintilloCompartidoHTML() {
  const n = _empresas.length || 3
  return {
    color: 'var(--text-secondary)',
    emblema: `
      <div class="emp-emblema emp-compartido" title="Este registro pertenece al catálogo compartido: lo ven todas las empresas.">
        <span class="emp-mono">⇄</span>
        <span class="emp-ident">
          <strong>Compartido</strong>
          <small>las ${n} empresas</small>
        </span>
      </div>`
  }
}

/** Emblema + riel. `empresaId` null ⇒ empresa de trabajo. */
function _cintilloHTML(empresaId = null, desajuste = false) {
  const e = empresaById(empresaId ?? _trabajo)
  if (!e) return { riel: '', emblema: '' }
  const color = e.color || '#2563eb'
  const emblema = `
    <div class="emp-emblema${desajuste ? ' desajuste' : ''}" style="--emp:${_esc(color)}"
         title="${_esc(e.razon_social)} · RUC ${_esc(e.ruc)}">
      <span class="emp-mono">${_esc(_inicial(e))}</span>
      <span class="emp-ident">
        <strong>${_esc(e.codigo || e.nombre_comercial)}</strong>
        <small>${_esc(e.ruc)}</small>
      </span>
      ${desajuste ? `<span class="emp-desajuste-nota">estás en ${_esc(nombreEmpresa(_trabajo))}</span>` : ''}
    </div>`
  return { color, emblema }
}

function _pintarCintillo(modal, empresaId = null, desajuste = false) {
  if (!modal) return
  const contenido = modal.querySelector('.modal-content')
  const header = modal.querySelector('.modal-header')
  if (!contenido || !header) return

  modal.querySelectorAll('.emp-emblema').forEach(n => n.remove())
  const { color, emblema } = (empresaId === 'compartido')
    ? _cintilloCompartidoHTML()
    : _cintilloHTML(empresaId, desajuste)
  if (!color) return

  // El riel es una SOMBRA INTERIOR del propio .modal-content, no un <div>.
  // Un div con margen negativo peleaba con el scroll interno del modal y
  // terminaba flotando 32 px adentro; una sombra inset no ocupa layout, se
  // queda pegada al borde y respeta las esquinas redondeadas.
  contenido.style.setProperty('--emp', color)
  contenido.classList.toggle('emp-desajuste', !!desajuste)
  contenido.classList.toggle('emp-riel-compartido', empresaId === 'compartido')
  contenido.classList.add('emp-con-riel')

  const cerrar = header.querySelector('.modal-close')
  if (cerrar) cerrar.insertAdjacentHTML('beforebegin', emblema)
  else header.insertAdjacentHTML('beforeend', emblema)
}

/** Corrige la empresa que muestra un modal ya abierto. */
export function marcarEmpresaModal(idModal, empresaId) {
  const modal = document.getElementById(idModal)
  if (!modal || empresaId == null) return
  _pintarCintillo(modal, empresaId, Number(empresaId) !== Number(_trabajo))
}

/** Igual, leyendo el `empresa_id` directamente del registro. */
export async function marcarEmpresaModalDesdeRegistro(idModal, tabla, id) {
  if (id == null) return
  try {
    const { data } = await fromSinFiltro(tabla).select('empresa_id').eq('id', id).maybeSingle()
    if (data?.empresa_id != null) marcarEmpresaModal(idModal, data.empresa_id)
  } catch { /* se queda con la empresa de trabajo */ }
}

function _montarCintilloEnModal(id) {
  const modal = document.getElementById(id)
  if (!modal || !_listo) return
  if (RE_MODAL_SIN_CINTILLO.test(id)) return
  // Sub-modal: si ya hay otro modal abierto, este flota encima — sin riel.
  if ([...document.querySelectorAll('.modal.show')].some(m => m !== modal)) return

  // Un modal de EDITAR declara de quién es el registro con una línea antes de
  // abrirse:  modal.dataset.empresaId = venta.empresa_id
  // Sin eso se asume la empresa de trabajo, que es lo correcto al CREAR.
  if (RE_MODAL_COMPARTIDO.test(id)) { _pintarCintillo(modal, 'compartido'); return }

  const declarada = modal.dataset?.empresaId
  if (declarada) {
    _pintarCintillo(modal, Number(declarada), Number(declarada) !== Number(_trabajo))
  } else {
    _pintarCintillo(modal)
  }
}

/** Para los modales de editar: una línea antes de abrirlos. */
export function declararEmpresaModal(idModal, empresaId) {
  const m = document.getElementById(idModal)
  if (!m) return
  if (empresaId == null) delete m.dataset.empresaId
  else m.dataset.empresaId = String(empresaId)
}

function _envolverOpenModal() {
  if (window._empOpenModalEnvuelto) return
  const original = window.openModal
  if (typeof original !== 'function') return
  window.openModal = function (id) {
    try { _montarCintilloEnModal(id) } catch (e) { console.warn('cintillo de empresa:', e) }
    return original(id)
  }
  window._empOpenModalEnvuelto = true
}

document.addEventListener('DOMContentLoaded', montarUIEmpresa)
