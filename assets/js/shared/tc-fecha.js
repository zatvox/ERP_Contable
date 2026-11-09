// ============================================================================
// shared/tc-fecha.js — LEY DEL SISTEMA (2026-11-09): el T.C. sigue a la FECHA.
// Todo campo de tipo de cambio que depende de una fecha se actualiza SOLO al
// cambiar esa fecha (tabla de T.C. SUNAT; venta para cobros/ventas, compra
// para pagos/compras). El usuario puede corregirlo a mano después; si vuelve a
// cambiar la fecha, se vuelve a traer el del día.
//   · tcDelDia(fecha, lado)            → número o null
//   · marcarTC(input, ok, titulo)       → destello verde (actualizado) o borde
//                                         ámbar (no hay T.C. para esa fecha)
//   · vincularTCaFecha({ fecha, tc, lado, cuando, onCambio })
// ============================================================================
import { getTipoCambioDia } from '../sunat-api.js'
import { fechaDMY } from '../helpers.js'

const _el = x => typeof x === 'string' ? document.getElementById(x) : x

export async function tcDelDia(fecha, lado = 'venta') {
  if (!fecha) return null
  try {
    const r = await getTipoCambioDia(fecha, { permitirApi: false })
    const v = lado === 'compra' ? r?.compra : r?.venta
    return v > 0 ? v : null
  } catch { return null }
}

export function marcarTC(input, ok, titulo = '') {
  const el = _el(input); if (!el) return
  el.classList.remove('tc-actualizado', 'tc-sin-dato')
  void el.offsetWidth   // reinicia la animación
  el.classList.add(ok ? 'tc-actualizado' : 'tc-sin-dato')
  if (titulo) el.title = titulo
}

/** Engancha una fecha a su T.C. (idempotente por input). */
export function vincularTCaFecha({ fecha, tc, lado = 'venta', cuando = null, onCambio = null }) {
  const f = _el(fecha), t = _el(tc)
  if (!f || !t || f.dataset.tcVinculado) return
  f.dataset.tcVinculado = '1'
  f.addEventListener('change', async () => {
    if (cuando && !cuando()) return
    const l = typeof lado === 'function' ? lado() : lado
    const v = await tcDelDia(f.value, l)
    if (v) { t.value = v; marcarTC(t, true, `T.C. ${l} SUNAT del ${fechaDMY(f.value)}`) }
    else marcarTC(t, false, `No hay T.C. registrado para el ${fechaDMY(f.value)}: revisa el valor`)
    onCambio?.(v)
  })
}
window.tcDelDia = tcDelDia
