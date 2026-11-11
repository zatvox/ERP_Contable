// ============================================================================
// ci-compra.js — el Commercial Invoice SIEMPRE tiene su Compra (y su CxP)
// ----------------------------------------------------------------------------
// LEY del sistema: un solo registro, se propaga solo. El CI que se registra en
// Importaciones es el comprobante del proveedor del exterior: va al Registro de
// Compras como comprobante 91 (no domiciliado), con su CxP, enlazado a la carpeta
// y a la OC/Proforma de la que salió. Los datos son los del CI (no los de la PI).
//
//   sincronizarCompraCI(ciId)       crea o actualiza la compra + detalle + CxP de ese CI
//   sincronizarComprasCarpeta(id)   lo mismo para todos los CI de la carpeta (autocuración)
//
// Es idempotente: puede llamarse las veces que sea; solo escribe lo que cambió.
// Qué se actualiza si la compra YA existía:
//   · totales / CxP si cambió el valor del CI
//   · líneas del detalle solo si la compra aún no tiene guías de ingreso (con guías hay stock
//     y kardex encima: ahí se avisa y se corrige a mano en Compras)
//   · lo pagado en la CxP se refleja desde los pagos de la carpeta (anticipo + saldo), no se teclea
// Sin SQL nuevo.
// ============================================================================
import { query, update, esperarContextoEmpresa } from '../supabase-client.js'
import { getCurrentUser } from '../auth-supabase.js'
import { getTipoCambioDia } from '../sunat-api.js'
import { getItems, getContactById, addCompra, addCompraDetalle, addCuentaPagar } from '../supabase-data.js'
import { anticipoDeCI } from './ci-multi.js'

const num = v => parseFloat(v) || 0
const r2 = v => Math.round((num(v) + Number.EPSILON) * 100) / 100
const norm = s => String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '')
const esMerc = c => ['mercaderia', 'importacion'].includes(String(c.tipo_compra || '').toLowerCase())
const _enCurso = new Set()

async function _compraDelCI(ci, carpetaId) {
  const todas = (await query('compras', { carpeta_importacion_id: carpetaId })) || []
  return todas.find(c => !c.anulado && c.comprobante_anulado !== true && esMerc(c) && norm(c.numero) === norm(ci.invoice_number)) || null
}

/** Lo ya pagado de ESTE CI según los pagos de la carpeta: su parte del anticipo + el saldo. */
async function _pagadoDelCI(ci, cis, carpetaId) {
  const [pagos, apps] = await Promise.all([
    query('importacion_pagos', { carpeta_importacion_id: carpetaId }),
    query('importacion_pago_aplicaciones', { carpeta_importacion_id: carpetaId })
  ])
  const vivos = new Set((pagos || []).filter(p => p.estado !== 'observado').map(p => p.id))
  const ap = (apps || []).filter(a => vivos.has(a.pago_id))
  const antPag = ap.filter(a => a.doc_tipo === 'oc_anticipo').reduce((t, a) => t + num(a.monto_doc), 0)
  const saldo = ap.filter(a => a.doc_tipo === 'ci_saldo' && Number(a.doc_id) === Number(ci.id)).reduce((t, a) => t + num(a.monto_doc), 0)
  return r2((antPag > 0 ? anticipoDeCI(ci, cis, antPag) : 0) + saldo)
}

export async function sincronizarCompraCI(ciId, { silencioso = true } = {}) {
  if (!ciId || _enCurso.has(ciId)) return null
  _enCurso.add(ciId)
  try {
    await esperarContextoEmpresa()
    const ci = ((await query('comercial_invoices', { id: ciId })) || [])[0]
    if (!ci || !ci.carpeta_importacion_id) return null
    const carpeta = ((await query('carpetas_importacion', { id: ci.carpeta_importacion_id })) || [])[0]
    if (!carpeta) return null
    const cis = ((await query('comercial_invoices', { carpeta_importacion_id: carpeta.id })) || []).sort((a, b) => a.id - b.id)
    const lineas = (await query('detalle_comercial_invoice', { comercial_invoice_id: ci.id })) || []
    const total = r2(ci.valor_total_final_ci)
    if (!ci.invoice_number || total <= 0) return null
    const kg = lineas.reduce((t, l) => t + num(l.cantidad_neto), 0) || num(ci.cantidad_total_neto)
    const pagado = await _pagadoDelCI(ci, cis, carpeta.id)

    let compra = await _compraDelCI(ci, carpeta.id)
    let creada = false
    if (!compra) {
      const user = await getCurrentUser()
      const pi = carpeta.orden_compra_id ? ((await query('orden_compra', { id: carpeta.orden_compra_id })) || [])[0] : null
      const prov = await getContactById(ci.contact_id || carpeta.proveedor_id)
      const moneda = pi?.currency || 'USD'
      const fecha = String(ci.fecha).slice(0, 10)
      let tc = 1
      try { const r = await getTipoCambioDia(fecha, { permitirApi: true }); tc = num(r?.compra || r?.tc) || 1 } catch { /* se queda en 1 y el usuario lo corrige */ }
      const items = await getItems()
      const mapa = Object.fromEntries((items || []).map(i => [i.id, i]))
      compra = await addCompra({
        referencia: ci.invoice_number, tipo_referencia: 'compra_directa', tipo_comprobante: '91',
        serie: null, numero: ci.invoice_number,
        periodo_mes: parseInt(fecha.slice(5, 7)), periodo_ano: parseInt(fecha.slice(0, 4)),
        fecha_emision: fecha, fecha_recepcion: fecha,
        contact_id: prov?.id || ci.contact_id, proveedor_ruc: prov?.nro_documento || '-', proveedor_nombre: prov?.nombre || '-',
        proveedor_domiciliado: false,
        tipo_compra: 'mercaderia',
        descripcion: `Importación · Carpeta ${carpeta.numero_carpeta || ''} · ${ci.product || prov?.nombre || ''}`.trim(),
        unidad_medida: 'KG', cantidad: kg, total_unidades: num(ci.total_unidades) || null,
        precio_unitario: kg > 0 ? parseFloat((total / kg).toFixed(6)) : 0,
        base_imponible_gravada: 0, base_imponible_no_gravada: total, igv_gravado: 0,
        subtotal: total, total, currency: moneda, tipo_cambio: tc,
        estado_pago: 'pendiente', asiento_id: null,
        orden_compra_id: carpeta.orden_compra_id || null, carpeta_importacion_id: carpeta.id,
        empresa_id: carpeta.empresa_id ?? undefined, created_by: user?.db_id
      })
      if (!compra?.id) throw new Error('No se pudo registrar la compra del CI ' + ci.invoice_number)
      for (const l of lineas) {
        const it = mapa[l.product_id]
        const cant = num(l.cantidad_neto), sub = r2(cant * num(l.costo_unitario))
        await addCompraDetalle({
          compra_id: compra.id, item_id: l.product_id,
          descripcion: it ? (it.sku ? `(${it.sku}) ${it.nombre}` : it.nombre) : 'Artículo ' + l.product_id,
          unidad_medida: it?.unidad_medida || 'KG', cantidad: cant, unidades: num(l.cantidad_unid) || null,
          precio_unitario: num(l.costo_unitario), subtotal: sub,
          tipo_base: 'no_gravada', igv_porcentaje: 0, igv_monto: 0, total_linea: sub
        })
      }
      await addCuentaPagar({
        contact_id: compra.contact_id, compra_id: compra.id, tipo_comprobante: '91', serie: null, numero_comprobante: ci.invoice_number,
        fecha_emision: fecha, fecha_vencimiento: null, moneda, tipo_cambio: tc, monto_total: total, monto_pagado: 0, estado: 'pendiente',
        empresa_id: carpeta.empresa_id ?? undefined, created_by: user?.db_id
      })
      creada = true
    } else {
      // Ya existe: si el CI cambió de valor, la compra y la CxP lo siguen
      if (Math.abs(num(compra.total) - total) > 0.005) {
        await update('compras', compra.id, { subtotal: total, total, base_imponible_no_gravada: total, base_imponible_gravada: 0, igv_gravado: 0,
          cantidad: kg, precio_unitario: kg > 0 ? parseFloat((total / kg).toFixed(6)) : 0, total_unidades: num(ci.total_unidades) || null })
        const cx0 = ((await query('cuentas_pagar', { compra_id: compra.id })) || [])[0]
        if (cx0) await update('cuentas_pagar', cx0.id, { monto_total: total })
        const guias = (await query('guias_ingreso_compra', { compra_id: compra.id })) || []
        if (!guias.length) {
          const det = (await query('detalle_compras', { compra_id: compra.id })) || []
          if (det.length === lineas.length) {
            for (let i = 0; i < det.length; i++) {
              const l = lineas[i], cant = num(l.cantidad_neto), sub = r2(cant * num(l.costo_unitario))
              await update('detalle_compras', det[i].id, { item_id: l.product_id, cantidad: cant, unidades: num(l.cantidad_unid) || null, precio_unitario: num(l.costo_unitario), subtotal: sub, total_linea: sub })
            }
          }
        } else if (!silencioso) window.showToast?.('El CI cambió de valor y la compra ya tiene guías: revisa las líneas en Compras', 'warning')
      }
    }

    // CxP: lo pagado sale de los pagos de la carpeta (única fuente)
    const cx = ((await query('cuentas_pagar', { compra_id: compra.id })) || [])[0]
    if (cx && Math.abs(num(cx.monto_pagado) - Math.min(pagado, total)) > 0.005 && !(await _tienePagosManuales(cx.id))) {
      const mp = Math.min(pagado, total)
      const estado = mp >= total - 0.005 ? 'pagado' : (mp > 0 ? 'parcial' : 'pendiente')
      await update('cuentas_pagar', cx.id, { monto_pagado: mp, estado })
      await update('compras', compra.id, { estado_pago: estado })
    }
    if (creada && !silencioso) window.showToast?.(`CI ${ci.invoice_number} registrado también en Compras y Cuentas por Pagar`, 'success')
    return { compraId: compra.id, creada }
  } catch (e) {
    console.warn('sincronizarCompraCI:', e)
    if (!silencioso) window.showToast?.(e.message || 'No se pudo sincronizar el CI con Compras', 'warning')
    return null
  } finally { _enCurso.delete(ciId) }
}

// Si alguien ya pagó esa CxP desde Cobranzas (pagos_proveedores) no la pisamos: ahí manda el pago manual.
async function _tienePagosManuales(cxpId) {
  try { return ((await query('pagos_proveedores', { cxp_id: cxpId })) || []).length > 0 } catch { return false }
}

const _ult = {}
export async function sincronizarComprasCarpeta(carpetaId, { forzar = false, silencioso = true } = {}) {
  if (!carpetaId) return
  if (!forzar && _ult[carpetaId] && Date.now() - _ult[carpetaId] < 20000) return
  _ult[carpetaId] = Date.now()
  const cis = (await query('comercial_invoices', { carpeta_importacion_id: carpetaId })) || []
  let nuevas = 0
  for (const ci of cis) { const r = await sincronizarCompraCI(ci.id, { silencioso }); if (r?.creada) nuevas++ }
  if (nuevas) window.showToast?.(`${nuevas} CI de esta carpeta no estaban en Compras: ya se registraron (con su CxP)`, 'success', 5000)
  return nuevas
}

window.sincronizarCompraCI = sincronizarCompraCI
window.sincronizarComprasCarpeta = sincronizarComprasCarpeta
