// ============================================================================
// compras/reportes.js — parte de compras.js (reorganizado 2026-09-25, sin cambios de lógica)
// Mapa completo de funciones: Claude outputs/glosario_funciones_erp.md
// ============================================================================
import { getCompras, getCompraDetalles, getItems, getSuppliers } from '../supabase-data.js'
import { estaAnulado } from '../anulacion.js'
import { signoDocumento } from '../notas.js'
import { cacheado } from '../data-cache.js'
import { crearReporte, nombreMes } from '../reportes.js'

// ============================================================================
// REPORTES GERENCIALES DE COMPRAS — Fase 2
// ============================================================================

export const _repComprasListos = {}

export async function construirReporteCompras(panelId) {
  if (_repComprasListos[panelId]) return
  _repComprasListos[panelId] = true
  const cont = document.getElementById(panelId)
  if (cont) cont.innerHTML = '<div class="card"><p class="reporte-vacio">Calculando reporte…</p></div>'

  try {
    const [compras, proveedores, detalles, items] = await Promise.all([
      cacheado('compras', getCompras),
      cacheado('proveedores', getSuppliers),
      cacheado('compra_detalles', getCompraDetalles),
      cacheado('items', getItems)
    ])

    const provMap = {}; (proveedores || []).forEach(p => { provMap[p.id] = p.razon_social || p.nombre })
    const itemMap = {}; (items || []).forEach(i => { itemMap[i.id] = i })
    const compraMap = {}; (compras || []).forEach(c => { compraMap[c.id] = c })

    // Las compras anuladas no dan crédito fiscal ni cuentan como gasto.
    // Las notas de crédito recibidas entran en negativo: reducen la compra
    // neta y el crédito fiscal del periodo.
    const filas = (compras || []).filter(c => !estaAnulado(c)).map(c => {
      const sg = signoDocumento(c.tipo_comprobante)
      const total = parseFloat(c.total || 0) * sg
      const pagado = parseFloat(c.monto_pagado || 0) * sg
      return {
        proveedor: provMap[c.contact_id] || `ID ${c.contact_id}`,
        mes: nombreMes((c.fecha_emision || '').slice(0, 7)),
        fecha: c.fecha_emision || '',
        comprobante: `${c.tipo_comprobante || ''} ${c.serie || ''}-${c.numero || ''}`,
        tipo_comprobante: c.tipo_comprobante === '01' ? 'Factura' : (c.tipo_comprobante === '03' ? 'Boleta' : (c.tipo_comprobante === '91' ? 'Invoice (No Domiciliado)' : (c.tipo_comprobante || 'Otro'))),
        moneda: c.currency || c.moneda || 'PEN',
        estado_pago: c.estado_pago || 'pendiente',
        base: parseFloat(c.base_imponible_gravada || c.subtotal || 0) * sg,
        igv: parseFloat(c.igv_gravado || c.igv || 0) * sg,
        total,
        pendiente: sg > 0 ? Math.max(0, total - pagado) : total
      }
    })

    const filtrosBase = [
      { key: 'buscar', label: 'Buscar', tipo: 'texto', campos: ['proveedor', 'comprobante'], placeholder: 'Proveedor o comprobante...' },
      { key: 'tipo_comprobante', label: 'Comprobante', tipo: 'select', opciones: Array.from(new Set(filas.map(f => f.tipo_comprobante))).sort() },
      { key: 'moneda', label: 'Moneda', tipo: 'select', opciones: ['PEN', 'USD'] },
      { key: 'rango', label: 'Emisión', tipo: 'rango', campo: 'fecha' }
    ]
    const medidasBase = [
      { key: 'base', label: 'Base imponible', agg: 'sum', formato: 'money' },
      { key: 'igv', label: 'IGV', agg: 'sum', formato: 'money' },
      { key: 'total', label: 'Total', agg: 'sum', formato: 'money' }
    ]
    const kpisBase = (f) => [
      { label: 'Total comprado', valor: f.reduce((s, x) => s + x.total, 0), formato: 'money', color: 'var(--color-info)' },
      { label: 'IGV (crédito fiscal)', valor: f.reduce((s, x) => s + x.igv, 0), formato: 'money' },
      { label: 'Documentos', valor: f.length, formato: 'int' },
      { label: 'Compra promedio', valor: f.length ? f.reduce((s, x) => s + x.total, 0) / f.length : 0, formato: 'money' }
    ]

    if (panelId === 'repcm-evolucion') {
      crearReporte('repcm-evolucion', {
        id: 'repcm-evolucion',
        titulo: 'Evolución de las compras',
        descripcion: 'Cuánto se compró mes a mes, cruzable por tipo de comprobante y moneda.',
        datos: filas,
        dimensiones: [
          { key: 'mes', label: 'Mes' }, { key: 'tipo_comprobante', label: 'Comprobante' },
          { key: 'moneda', label: 'Moneda' }, { key: 'proveedor', label: 'Proveedor' }
        ],
        medidas: medidasBase, filtros: filtrosBase,
        agruparPorDefecto: ['mes'], orden: { key: '_etiqueta', dir: 'asc' }, kpis: kpisBase
      })
    }

    if (panelId === 'repcm-proveedores') {
      crearReporte('repcm-proveedores', {
        id: 'repcm-proveedores',
        titulo: 'Compras por proveedor',
        descripcion: 'Concentración de compras: quiénes son tus proveedores principales y cuánto representan.',
        datos: filas,
        dimensiones: [
          { key: 'proveedor', label: 'Proveedor' }, { key: 'moneda', label: 'Moneda' },
          { key: 'mes', label: 'Mes' }, { key: 'tipo_comprobante', label: 'Comprobante' }
        ],
        medidas: medidasBase, filtros: filtrosBase,
        agruparPorDefecto: ['proveedor'], kpis: kpisBase
      })
    }

    if (panelId === 'repcm-pagos') {
      crearReporte('repcm-pagos', {
        id: 'repcm-pagos',
        titulo: 'Estado de pago de las compras',
        descripcion: 'Qué compras están pagadas, parciales o pendientes. El detalle de saldos vive en Cuentas x Cobrar/Pagar.',
        datos: filas,
        dimensiones: [
          { key: 'estado_pago', label: 'Estado de pago' }, { key: 'proveedor', label: 'Proveedor' },
          { key: 'mes', label: 'Mes' }, { key: 'moneda', label: 'Moneda' }
        ],
        medidas: [
          { key: 'total', label: 'Total', agg: 'sum', formato: 'money' },
          { key: 'pendiente', label: 'Pendiente', agg: 'sum', formato: 'money', semaforo: true }
        ],
        filtros: [
          ...filtrosBase,
          { key: 'estado_pago', label: 'Estado', tipo: 'select', opciones: Array.from(new Set(filas.map(f => f.estado_pago))).sort() }
        ],
        agruparPorDefecto: ['estado_pago'],
        kpis: (f) => [
          { label: 'Total', valor: f.reduce((s, x) => s + x.total, 0), formato: 'money' },
          { label: 'Pendiente de pago', valor: f.reduce((s, x) => s + x.pendiente, 0), formato: 'money', color: 'var(--color-danger)' },
          { label: 'Documentos', valor: f.length, formato: 'int' }
        ]
      })
    }

    if (panelId === 'repcm-productos') {
      const filasDet = (detalles || []).map(d => {
        const c = compraMap[d.compra_id] || {}
        if (estaAnulado(c)) return null
        const it = itemMap[d.item_id] || {}
        const cant = parseFloat(d.cantidad || 0)
        const pu   = parseFloat(d.precio_unitario || d.costo_unitario || 0)
        return {
          producto: it.nombre || d.descripcion || `Item ${d.item_id}`,
          sku: it.sku || '—',
          proveedor: provMap[c.contact_id] || '(sin proveedor)',
          mes: nombreMes((c.fecha_emision || '').slice(0, 7)),
          fecha: c.fecha_emision || '',
          moneda: c.currency || c.moneda || 'PEN',
          cantidad: cant,
          precio_unitario: pu,
          total: parseFloat(d.total_linea || d.subtotal || (cant * pu) || 0)
        }
      }).filter(Boolean)

      crearReporte('repcm-productos', {
        id: 'repcm-productos',
        titulo: 'Compras por producto',
        descripcion: 'Qué se compra más y a qué precio. Agrupa por producto y proveedor para comparar precios entre proveedores.',
        datos: filasDet,
        dimensiones: [
          { key: 'producto', label: 'Producto' }, { key: 'proveedor', label: 'Proveedor' },
          { key: 'mes', label: 'Mes' }, { key: 'moneda', label: 'Moneda' }
        ],
        medidas: [
          { key: 'cantidad', label: 'Cantidad', agg: 'sum', formato: 'qty' },
          { key: 'total', label: 'Importe', agg: 'sum', formato: 'money' },
          { key: 'precio_unitario', label: 'Precio unit. prom.', agg: 'avg', formato: 'money4' }
        ],
        filtros: [
          { key: 'buscar', label: 'Buscar', tipo: 'texto', campos: ['producto', 'sku', 'proveedor'], placeholder: 'Producto o proveedor...' },
          { key: 'moneda', label: 'Moneda', tipo: 'select', opciones: ['PEN', 'USD'] },
          { key: 'rango', label: 'Fecha', tipo: 'rango', campo: 'fecha' }
        ],
        agruparPorDefecto: ['producto'],
        kpis: (f) => [
          { label: 'Importe total', valor: f.reduce((s, x) => s + x.total, 0), formato: 'money' },
          { label: 'Unidades', valor: f.reduce((s, x) => s + x.cantidad, 0), formato: 'qty' },
          { label: 'Productos distintos', valor: new Set(f.map(x => x.producto)).size, formato: 'int' }
        ]
      })
    }
  } catch (e) {
    console.error('construirReporteCompras:', e)
    _repComprasListos[panelId] = false
    if (cont) cont.innerHTML = `<div class="card"><p class="reporte-vacio">No se pudo construir el reporte: ${e.message}</p></div>`
  }
}
