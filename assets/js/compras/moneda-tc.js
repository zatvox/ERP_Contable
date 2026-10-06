// ============================================================================
// compras/moneda-tc.js — parte de compras.js (reorganizado 2026-09-25, sin cambios de lógica)
// Mapa completo de funciones: Claude outputs/glosario_funciones_erp.md
// ============================================================================
import { getTCCompra, textoAvisoTC } from '../sunat-api.js'

// ============================================================================
// MONEDA Y TIPO DE CAMBIO EN LOS MODALES DE COMPRA
// ============================================================================
// La empresa compra casi todo importado, así que el valor por defecto es USD
// y el campo de Tipo de Cambio se muestra desde el inicio (antes había que
// cambiar la moneda para que apareciera, y como el <select> ya venía en USD
// tras un form.reset() el bloque quedaba oculto con una compra en dólares).
// Al pasar a PEN el T.C. se oculta y se fija en 1: en soles no hay conversión.

function _aplicarMonedaCompra({ idMoneda, idGrupoTC, idInputTC, idAviso, autoFetch }) {
  const moneda = document.getElementById(idMoneda)?.value || 'USD'
  const grupo  = document.getElementById(idGrupoTC)
  const inputTC = document.getElementById(idInputTC)
  const aviso  = document.getElementById(idAviso)
  const esUSD  = moneda === 'USD'

  // 2026-10-05: el T.C. se muestra y se guarda también en SOLES como
  // referencia SUNAT (no convierte el costo: guias-ingreso-nueva solo
  // convierte cuando la moneda es USD).
  if (grupo) grupo.style.display = ''
  void esUSD; void aviso

  // Si el T.C. quedó vacío o en 1 se intenta traer el del día: en USD un
  // T.C. de 1 descuadraría todo el costeo en soles.
  if (inputTC && (!inputTC.value || parseFloat(inputTC.value) === 1) && typeof autoFetch === 'function') {
    autoFetch(true)   // automático = solo TC guardado (no consume crédito)
  }
}

// Un solo set de campos de Moneda/T.C. compartido por los 3 tipos de compra
// (Mercadería/Servicio/Anticipo) desde que se unificó el modal (2026-09-07).
window.onCambiarMonedaCompra = function () {
  _aplicarMonedaCompra({
    idMoneda: 'nqMoneda', idGrupoTC: 'nqTipoCambioGroup',
    idInputTC: 'nqTipoCambio', idAviso: 'nqTCAviso',
    autoFetch: window.autoFetchTCCompra
  })
}

/**
 * Trae el T.C. COMPRA de la SBS para la fecha del formulario.
 * Se usa COMPRA (no venta) porque el Art. 61° de la LIR manda ese tipo para
 * registrar adquisiciones; en Ventas se usa el T.C. VENTA, por eso son dos
 * funciones distintas y no una sola compartida.
 */
async function _traerTCCompraA(idInputTC, idAviso, idFecha, idBoton, soloCache = false) {
  const campo = document.getElementById(idInputTC)
  const aviso = document.getElementById(idAviso)
  const btn   = document.getElementById(idBoton)
  if (!campo) return

  if (btn) btn.disabled = true
  if (aviso) aviso.textContent = soloCache ? 'Buscando TC guardado...' : 'Consultando TC SUNAT...'

  try {
    const fecha = document.getElementById(idFecha)?.value || null
    const result = await getTCCompra(fecha, { permitirApi: !soloCache })
    if (result.error) {
      if (aviso) aviso.textContent = result.sinCache ? `${result.error} (o ingrésalo manualmente)` : `⚠ ${result.error} — ingrésalo manualmente`
      return
    }
    campo.value = result.tc.toFixed(3)
    if (aviso) aviso.textContent = textoAvisoTC(result, 'compra')
  } catch (e) {
    if (aviso) aviso.textContent = `⚠ No se pudo consultar (${e.message}) — ingrésalo manualmente`
  } finally {
    if (btn) btn.disabled = false
  }
}

window.autoFetchTCCompra = function (soloCache = false) {
  return _traerTCCompraA('nqTipoCambio', 'nqTCAviso', 'nqFecha', 'btnAutoTCNuevaCompra', soloCache === true)
}
