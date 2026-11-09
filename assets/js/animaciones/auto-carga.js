// ============================================================================
// animaciones/auto-carga.js — la animación aparece SOLO en procesos lentos
// ============================================================================
//
// REGLA: el overlay solo sale si el proceso dura (o se estima que durará)
// más de 4 s. Un guardado de 1 s nunca lo muestra — un overlay a cada rato
// cansa y pierde sentido.
//
// CÓMO DECIDE (sin adivinar):
//   1. Mide. Cada ejecución de un proceso anota cuánto demoró (promedio móvil
//      en localStorage, por proceso). La próxima vez, si el historial dice
//      ≥ 4 s, la animación sale desde el inicio. Un proceso nuevo parte con
//      su estimado inicial de la tabla (`estimadoMs`).
//   2. Red de seguridad. Si no había historial y el proceso pasa de 4 s,
//      el overlay aparece en ese momento.
//
// CÓMO SE ENGANCHA: sin tocar los módulos. `window.<nombre>` se intercepta
// con un setter: cuando el módulo asigne su función, queda envuelta. Sirve
// aunque el módulo cargue antes o después; los onclick="..." usan la envuelta.
//
// AGREGAR UN PROCESO = una línea en PROCESOS. Quitarlo = borrar la línea.

import { mostrarCarga, ocultarCarga, cargaActiva } from './cargador.js'

export const UMBRAL_MS = 4000
const LS = 'zv_carga_ritmo'

// nombre de window.fn → { titulo, estimadoMs (opcional: lo que se espera la 1ª vez) }
export const PROCESOS = {
  // Importaciones
  aplicarCostosLote:        { titulo: 'Aplicando costo final al lote', sub: 'Recosteando lotes, kardex y ventas', estimadoMs: 8000 },
  guardarLiqAgente:         { titulo: 'Guardando liquidación del agente', sub: 'Gastos, compras y cuentas por pagar', estimadoMs: 5000 },
  guardarGastoFactura:      { titulo: 'Registrando gasto', sub: 'Compra, cuenta por pagar y costeo' },
  guardarLineaCosto:        { titulo: 'Guardando línea de costo' },
  guardarBL:                { titulo: 'Guardando BL y contenedores' },
  guardarDAMCarpeta:        { titulo: 'Guardando DAM' },
  ddGuardar:                { titulo: 'Guardando declaración DAM' },
  ppGuardar:                { titulo: 'Registrando pago' },
  ppRegistrarBanco:         { titulo: 'Asentando pago en banco' },
  rciGuardar:               { titulo: 'Registrando factura comercial' },
  guardarPI:                { titulo: 'Guardando proforma' },
  guardarCambiosImportacion:{ titulo: 'Guardando importación' },
  eliminarImportacion:      { titulo: 'Eliminando importación' },
  // Compras
  guardarCompraMercaderia:  { titulo: 'Registrando compra', sub: 'Compra, cuenta por pagar y stock' },
  guardarCompraServicio:    { titulo: 'Registrando compra' },
  guardarCompraAnticipo:    { titulo: 'Registrando anticipo' },
  guardarEdicionCompra:     { titulo: 'Guardando compra', sub: 'Puede recostear guías y kardex' },
  guardarGuiaIngresoCompra: { titulo: 'Registrando guía de ingreso', sub: 'Lotes, stock y kardex' },
  guardarEdicionGuia:       { titulo: 'Guardando guía de ingreso' },
  ejecutarConfirmarCompra:  { titulo: 'Confirmando compra' },
  confirmarOC:              { titulo: 'Confirmando orden de compra' },
  anularCompra:             { titulo: 'Anulando compra', sub: 'Revirtiendo stock y cuentas' },
  anularGuiaIngreso:        { titulo: 'Anulando guía de ingreso' },
  eliminarCompra:           { titulo: 'Eliminando compra' },
  eliminarComprasSeleccionadas: { titulo: 'Eliminando compras', estimadoMs: 6000 },
  eliminarGuia:             { titulo: 'Eliminando guía' },
  eliminarGuiasSeleccionadas:{ titulo: 'Eliminando guías', estimadoMs: 6000 },
  // Ventas
  guardarNuevaVenta:        { titulo: 'Registrando venta', sub: 'Stock, kardex y cuenta por cobrar' },
  guardarEdicionVenta:      { titulo: 'Guardando venta' },
  guardarVentaAnticipo:     { titulo: 'Registrando anticipo' },
  guardarPacking:           { titulo: 'Guardando packing' },
  facturarPacking:          { titulo: 'Facturando packing' },
  guardarGuiaDespachoVenta: { titulo: 'Registrando guía de despacho' },
  guardarEdicionGuiaDespachoVenta: { titulo: 'Guardando guía de despacho' },
  anularVenta:              { titulo: 'Anulando venta', sub: 'Revirtiendo stock y cuentas' },
  anularGuiaDespachoVenta:  { titulo: 'Anulando guía de despacho' },
  eliminarVenta:            { titulo: 'Eliminando venta' },
  eliminarVentasSeleccionadas:{ titulo: 'Eliminando ventas', estimadoMs: 6000 },
  eliminarPackingSeleccionados:{ titulo: 'Eliminando packings', estimadoMs: 6000 },
  emitirCPEVenta:           { titulo: 'Emitiendo comprobante' },
  // Cobranzas / tesorería / contabilidad
  confirmarCobroMasivo:     { titulo: 'Registrando cobro masivo', estimadoMs: 6000 },
  registrarCobro:           { titulo: 'Registrando cobro' },
  registrarPagoProveedor:   { titulo: 'Registrando pago' },
  guardarTrasladoInterno:   { titulo: 'Registrando traslado', sub: 'Stock y kardex' },
  guardarAjusteKardex:      { titulo: 'Guardando ajuste de inventario' },
  cerrarPeriodoUI:          { titulo: 'Cerrando período contable', estimadoMs: 8000 },
  _pdt621Calcular:          { titulo: 'Calculando PDT 621', estimadoMs: 5000 },
  _pdt621Guardar:           { titulo: 'Guardando PDT 621' },
  cerrarRendicion:          { titulo: 'Cerrando rendición' },
  guardarReposicion:        { titulo: 'Guardando reposición' },
  confirmarAnulacion:       { titulo: 'Anulando documento' }
}

// ── Historial de ritmo (promedio móvil por proceso) ─────────────────────────
function _leer() { try { return JSON.parse(localStorage.getItem(LS) || '{}') } catch (_) { return {} } }
function _anotar(clave, ms) {
  try {
    const h = _leer()
    const prev = h[clave]
    h[clave] = prev ? Math.round(prev * 0.5 + ms * 0.5) : Math.round(ms)
    localStorage.setItem(LS, JSON.stringify(h))
  } catch (_) { /* sin storage: solo pierde el aprendizaje */ }
}
export function estimadoMs(clave) {
  const h = _leer()[clave]
  return h != null ? h : (PROCESOS[clave]?.estimadoMs || 0)
}

let _activos = 0

/** Ejecuta `fn` y muestra el overlay solo si es (o resulta) un proceso de más de 4 s. */
export async function conCargaAuto(clave, opts, fn) {
  // Anidado (un proceso lento llama a otro) o ya hay overlay: no se apila otro.
  if (_activos > 0 || cargaActiva()) return fn()
  _activos++
  const t0 = Date.now()
  let timer = null, terminado = false
  const mostrar = async () => {
    await mostrarCarga({ titulo: opts.titulo, subtitulo: opts.sub || '' })
    if (terminado) ocultarCarga(true)      // terminó mientras se armaba
  }
  if (estimadoMs(clave) >= UMBRAL_MS) mostrar()
  else timer = setTimeout(mostrar, UMBRAL_MS)
  try {
    return await fn()
  } finally {
    terminado = true
    if (timer) clearTimeout(timer)
    _activos--
    ocultarCarga()
    _anotar(clave, Date.now() - t0)
  }
}

// ── Enganche por setter: no importa el orden de carga de los módulos ───────
function _envolver(nombre, fn) {
  if (typeof fn !== 'function' || fn.__autoCarga) return fn
  const w = function (...args) { return conCargaAuto(nombre, PROCESOS[nombre], () => fn.apply(this, args)) }
  w.__autoCarga = true
  w.__original = fn
  return w
}
export function instalarAutoCarga() {
  if (window.__autoCargaInstalada) return
  window.__autoCargaInstalada = true
  for (const nombre of Object.keys(PROCESOS)) {
    let actual = _envolver(nombre, window[nombre])
    try {
      Object.defineProperty(window, nombre, {
        configurable: true, enumerable: true,
        get() { return actual },
        set(v) { actual = _envolver(nombre, v) }
      })
    } catch (_) { /* propiedad no configurable: se deja como estaba */ }
  }
}
instalarAutoCarga()
