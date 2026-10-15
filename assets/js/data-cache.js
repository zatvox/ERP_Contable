// ============================================================================
// DATA-CACHE.JS — Capa de caché para lecturas pesadas (reportes/dashboard)
// ============================================================================
// Estrategia de rendimiento a largo plazo, en 3 niveles:
//
//   1. Memoria (Map)          -> instantáneo dentro de la misma pantalla.
//   2. sessionStorage         -> sobrevive cambios de tab/pestaña del módulo
//                                y navegación entre páginas del ERP, se limpia
//                                al cerrar el navegador (no queda data vieja).
//   3. Supabase               -> solo si venció el TTL o se invalidó a mano.
//
// Regla de oro: TODA escritura (insert/update/delete) debe llamar a
// `invalidar('<prefijo>')` para que el siguiente reporte no muestre data vieja.
// Los reportes son lecturas agregadas: un TTL corto (5 min) es suficiente y
// evita cientos de round-trips a Supabase al mover filtros de una tabla
// dinámica, que es donde el sistema se sentía lento.
//
// Cuando una tabla supere ~50k filas conviene migrar ese dataset puntual a una
// VISTA MATERIALIZADA en Postgres y leerla desde aquí igual (la firma no
// cambia): `cacheado('kardex:2026', () => supabase.from('v_kardex_mes')...)`.
// ============================================================================

const MEM = new Map()
const PREFIJO = 'jhiro_cache_'

// MULTIEMPRESA: la caché se recarga con la página al cambiar de empresa, pero
// sessionStorage SOBREVIVE a la recarga. Sin este sufijo, Benji vería el
// dataset de Jhiro durante 5 minutos. Dos selecciones distintas = dos cachés.
let _sufijoEmpresa = ''
export function setSufijoEmpresaCache(s) { _sufijoEmpresa = s || '' }
function _k(clave) { return _sufijoEmpresa + clave }

// Mientras el sufijo esté vacío el contexto de empresa todavía no se resolvió.
// Guardar con una clave sin empresa es peligroso: la siguiente carga, ya en
// otra empresa, podría acertarle a esa misma clave y servir datos ajenos. En
// esa ventana la caché se desactiva — se consulta siempre a Supabase, que ya
// viene filtrado. Perder unos milisegundos es barato; mezclar empresas no.
function _cacheActiva() { return _sufijoEmpresa !== '' }
const TTL_DEFECTO = 5 * 60 * 1000   // 5 minutos
const MAX_PERSIST_BYTES = 900 * 1024 // no persistir payloads gigantes en sessionStorage

let _statsHits = 0
let _statsMiss = 0

/**
 * Devuelve el dataset cacheado o lo pide con `fetcher`.
 * @param {string}   clave     identificador estable, ej. 'ventas:2026-08'
 * @param {Function} fetcher   () => Promise<any>
 * @param {object}   opciones  { ttl, persistir }
 */
export async function cacheado(clave, fetcher, opciones = {}) {
  const ttl       = opciones.ttl ?? TTL_DEFECTO
  const persistir = opciones.persistir !== false
  const ahora     = Date.now()

  if (!_cacheActiva()) return await fetcher()

  const enMemoria = MEM.get(_k(clave))
  if (enMemoria && (ahora - enMemoria.t) < ttl) { _statsHits++; return enMemoria.v }

  if (persistir) {
    try {
      const crudo = sessionStorage.getItem(PREFIJO + _k(clave))
      if (crudo) {
        const entrada = JSON.parse(crudo)
        if ((ahora - entrada.t) < ttl) {
          MEM.set(_k(clave), entrada)
          _statsHits++
          return entrada.v
        }
        sessionStorage.removeItem(PREFIJO + _k(clave))
      }
    } catch (e) { /* storage lleno o JSON corrupto: se ignora y se re-consulta */ }
  }

  _statsMiss++
  const valor = await fetcher()
  const entrada = { t: ahora, v: valor }
  MEM.set(_k(clave), entrada)

  if (persistir) {
    try {
      const serializado = JSON.stringify(entrada)
      if (serializado.length < MAX_PERSIST_BYTES) {
        sessionStorage.setItem(PREFIJO + _k(clave), serializado)
      }
    } catch (e) {
      // QuotaExceeded: limpiamos lo viejo y seguimos solo con memoria.
      limpiarPersistencia()
    }
  }
  return valor
}

/** Invalida por prefijo: invalidar('ventas') borra 'ventas', 'ventas:2026-08', etc. */
export function invalidar(prefijo) {
  // MULTIEMPRESA: las claves llevan delante el sufijo de empresas activas
  // ('e1_ventas:2026-08'). Se ignora ese sufijo al comparar, así una escritura
  // en Benji también limpia lo cacheado de Jhiro: invalidar de más es
  // inofensivo; dejar en pantalla data vieja de otra empresa no lo es.
  const _sinSufijo = (k) => k.replace(/^e[\d-]+_/, '')
  const _coincide  = (k) => {
    const c = _sinSufijo(k)
    return c === prefijo || c.startsWith(prefijo + ':')
  }
  for (const k of Array.from(MEM.keys())) {
    if (_coincide(k)) MEM.delete(k)
  }
  try {
    for (let i = sessionStorage.length - 1; i >= 0; i--) {
      const k = sessionStorage.key(i)
      if (!k || !k.startsWith(PREFIJO)) continue
      if (_coincide(k.slice(PREFIJO.length))) sessionStorage.removeItem(k)
    }
  } catch (e) { /* noop */ }
}

/** Invalida varios prefijos de una sola vez. */
export function invalidarVarios(prefijos = []) { prefijos.forEach(invalidar) }

export function invalidarTodo() {
  MEM.clear()
  limpiarPersistencia()
}

function limpiarPersistencia() {
  try {
    for (let i = sessionStorage.length - 1; i >= 0; i--) {
      const k = sessionStorage.key(i)
      if (k && k.startsWith(PREFIJO)) sessionStorage.removeItem(k)
    }
  } catch (e) { /* noop */ }
}

/** Precarga en paralelo varios datasets (para el arranque de un módulo). */
export async function precargar(defs = []) {
  return Promise.all(defs.map(d => cacheado(d.clave, d.fetcher, d.opciones)))
}

export function estadisticasCache() {
  const total = _statsHits + _statsMiss
  return {
    hits: _statsHits,
    miss: _statsMiss,
    ratio: total ? Math.round((_statsHits / total) * 100) : 0,
    enMemoria: MEM.size
  }
}

// Disponible en consola para depurar sin abrir el código.
window.jhiroCache = { invalidar, invalidarTodo, estadisticasCache }
