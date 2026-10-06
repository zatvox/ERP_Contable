// ============================================================================
// TC-EN-VIVO.JS — T.C. que se llena solo según la fecha (2026-10-02)
// ============================================================================
// Patrón del sistema: el T.C. NO se escribe — sale de la fecha del documento
// (caché tipos_cambio → si no está, Decolecta 1 crédito; ver sunat-api.js).
// Se recalcula EN VIVO al cambiar la fecha o pasar la moneda a USD.
// Candado 🔒 al costado: abrirlo permite escribirlo a mano (y se respeta);
// cerrarlo vuelve al valor automático de la fecha.
// Uso:
//   const tc = vincularTCEnVivo({ idFecha, idMoneda, idTC, idAviso, tipo: 'venta'|'compra', onCambio })
//   tc.reiniciar()   // al abrir el modal (candado cerrado + recálculo)
// ============================================================================
import { getTCVenta, getTCCompra, textoAvisoTC } from './sunat-api.js'

const _vinculos = new Map()

function _fechaPlausible(f) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(f || '')) return false
  const y = parseInt(f.slice(0, 4))
  return y >= 2000 && f <= new Date().toISOString().slice(0, 10)   // SUNAT no publica TC futuro
}

export function vincularTCEnVivo({ idFecha, idMoneda, idTC, idAviso = null, tipo = 'venta', onCambio = null }) {
  if (_vinculos.has(idTC)) return _vinculos.get(idTC)
  const input = document.getElementById(idTC)
  if (!input) return { reiniciar() {}, actualizar() {} }

  // Candado al costado del input (se arma una sola vez)
  let btn = document.getElementById(`${idTC}-candado`)
  if (!btn) {
    const wrap = document.createElement('div')
    wrap.className = 'input-con-candado'
    input.parentNode.insertBefore(wrap, input)
    wrap.appendChild(input)
    btn = document.createElement('button')
    btn.type = 'button'
    btn.id = `${idTC}-candado`
    btn.className = 'btn-candado'
    btn.textContent = '🔒'
    btn.title = 'T.C. automático según la fecha — abrir para escribirlo a mano'
    wrap.appendChild(btn)
  }
  const aviso = () => idAviso ? document.getElementById(idAviso) : null
  let manual = false, seq = 0, timer = null

  const cerrar = () => {
    manual = false
    input.readOnly = true
    btn.textContent = '🔒'; btn.classList.remove('abierto')
    btn.title = 'T.C. automático según la fecha — abrir para escribirlo a mano'
  }

  async function actualizar() {
    if (manual) return
    // 2026-10-05: el T.C. se trae también en SOLES (referencia; no convierte montos)
    const fecha = document.getElementById(idFecha)?.value
    const av = aviso()
    if (!_fechaPlausible(fecha)) { if (av) av.textContent = 'Fecha inválida o futura: el T.C. no se consulta'; return }
    const mio = ++seq
    if (av) av.textContent = `Buscando T.C. ${tipo} del ${fecha}...`
    const r = await (tipo === 'compra' ? getTCCompra : getTCVenta)(fecha, { permitirApi: true })
    if (mio !== seq || manual) return            // llegó una respuesta vieja o el usuario abrió el candado
    if (r.error) { if (av) av.textContent = `⚠ ${r.error} — abre el candado e ingrésalo a mano`; return }
    input.value = r.tc.toFixed(3)
    if (av) av.textContent = textoAvisoTC(r, tipo)
    onCambio?.(r.tc)
  }

  const programar = () => { clearTimeout(timer); timer = setTimeout(actualizar, 500) }

  btn.addEventListener('click', () => {
    if (input.disabled) return                    // modo solo lectura del modal
    if (manual) { cerrar(); actualizar() }       // cerrar = volver al automático
    else {
      manual = true
      input.readOnly = false
      btn.textContent = '🔓'; btn.classList.add('abierto')
      btn.title = 'Volver al T.C. automático de la fecha'
      const av = aviso(); if (av) av.textContent = 'T.C. manual: se respeta lo que escribas'
      input.focus(); input.select()
    }
  })
  document.getElementById(idFecha)?.addEventListener('change', programar)
  if (idMoneda) document.getElementById(idMoneda)?.addEventListener('change', programar)
  input.addEventListener('input', () => { if (manual) onCambio?.(parseFloat(input.value) || 0) })

  cerrar()
  const api = {
    /** Al abrir el modal: candado cerrado y T.C. de la fecha actual del form. */
    reiniciar({ consultar = true } = {}) { cerrar(); if (consultar) actualizar() },
    /** Documento existente: deja su T.C. guardado, candado cerrado, sin consultar. */
    conservar() { cerrar(); seq++ },
    actualizar
  }
  _vinculos.set(idTC, api)
  return api
}
