// ============================================================================
// ventas/reportes.js — parte de ventas.js (reorganizado 2026-09-25, sin cambios de lógica)
// Mapa completo de funciones: Claude outputs/glosario_funciones_erp.md
// ============================================================================
import { getCustomers, getLotes, getItems, getVentas, getTodosDetalleVentas, getSuppliers } from '../supabase-data.js'
import { estaAnulado } from '../anulacion.js'
import { esNota, signoDocumento, nombreTipoComprobante } from '../notas.js'
import { cacheado } from '../data-cache.js'
import { crearReporte, nombreMes } from '../reportes.js'

// ============================================================================
// REPORTES GERENCIALES DE VENTAS — Fase 2
// ============================================================================
// El margen se calcula con el costo_unitario que quedó registrado en cada
// línea de detalle_ventas (costeo por identificación específica, LIR Art. 62°).
// Las líneas sin costo se excluyen del margen pero sí cuentan en la venta,
// y el reporte lo advierte para que no se lea un margen engañoso.

export const _repVentasListos = {}

export async function construirReporteVentas(panelId) {
  if (_repVentasListos[panelId]) return
  _repVentasListos[panelId] = true
  const cont = document.getElementById(panelId)
  if (cont) cont.innerHTML = '<div class="card"><p class="reporte-vacio">Calculando reporte…</p></div>'

  try {
    const [ventas, clientes, detalles, items, lotes, proveedores] = await Promise.all([
      cacheado('ventas', getVentas),
      cacheado('clientes', getCustomers),
      cacheado('detalle_ventas_todos', getTodosDetalleVentas),
      cacheado('items', getItems),
      cacheado('lotes', getLotes),
      cacheado('proveedores', getSuppliers)
    ])

    const cliMap = {};   (clientes || []).forEach(c => { cliMap[c.id] = c.razon_social || c.nombre })
    const itemMap = {};  (items || []).forEach(i => { itemMap[i.id] = i })
    const ventaMap = {}; (ventas || []).forEach(v => { ventaMap[v.id] = v })
    const provMap = {};  (proveedores || []).forEach(p => { provMap[p.id] = p.razon_social || p.nombre })
    const loteMap = {};  (lotes || []).forEach(l => { loteMap[l.id] = l })

    // Un comprobante anulado no vendió nada: se excluye de TODOS los reportes
    // (facturación, márgenes, despacho). Queda visible solo en el listado.
    const activas = (ventas || []).filter(v => !estaAnulado(v))

    // Las notas de crédito entran con signo negativo para que cualquier
    // agrupación (por mes, cliente, producto) dé la venta NETA real.
    const filas = activas.map(v => {
      const sg = signoDocumento(v.tipo_comprobante)
      return {
        cliente: cliMap[v.contact_id] || `ID ${v.contact_id}`,
        mes: nombreMes((v.fecha_emision || '').slice(0, 7)),
        fecha: v.fecha_emision || '',
        comprobante: v.numero || `${v.serie || ''}-${v.correlativo || ''}`,
        tipo_comprobante: nombreTipoComprobante(v.tipo_comprobante),
        moneda: v.moneda || 'PEN',
        estado_pago: v.estado_pago || 'pendiente',
        estado_despacho: v.estado_despacho || 'pendiente',
        base: parseFloat(v.base_imponible || 0) * sg,
        igv: parseFloat(v.igv || 0) * sg,
        total: parseFloat(v.total || 0) * sg
      }
    })

    const filtrosBase = [
      { key: 'buscar', label: 'Buscar', tipo: 'texto', campos: ['cliente', 'comprobante'], placeholder: 'Cliente o comprobante...' },
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
      { label: 'Total vendido', valor: f.reduce((s, x) => s + x.total, 0), formato: 'money', color: 'var(--color-success)' },
      { label: 'IGV (débito fiscal)', valor: f.reduce((s, x) => s + x.igv, 0), formato: 'money' },
      { label: 'Comprobantes', valor: f.length, formato: 'int' },
      { label: 'Ticket promedio', valor: f.length ? f.reduce((s, x) => s + x.total, 0) / f.length : 0, formato: 'money' }
    ]

    if (panelId === 'repv-evolucion') {
      crearReporte('repv-evolucion', {
        id: 'repv-evolucion',
        titulo: 'Evolución de las ventas',
        descripcion: 'Ventas mes a mes, cruzables por tipo de comprobante, moneda o cliente.',
        datos: filas,
        dimensiones: [
          { key: 'mes', label: 'Mes' }, { key: 'tipo_comprobante', label: 'Comprobante' },
          { key: 'moneda', label: 'Moneda' }, { key: 'cliente', label: 'Cliente' }
        ],
        medidas: medidasBase, filtros: filtrosBase,
        agruparPorDefecto: ['mes'], orden: { key: '_etiqueta', dir: 'asc' }, kpis: kpisBase
      })
    }

    if (panelId === 'repv-clientes') {
      crearReporte('repv-clientes', {
        id: 'repv-clientes',
        titulo: 'Ventas por cliente',
        descripcion: 'Concentración de ventas: cuánto pesa cada cliente en tu facturación.',
        datos: filas,
        dimensiones: [
          { key: 'cliente', label: 'Cliente' }, { key: 'mes', label: 'Mes' },
          { key: 'moneda', label: 'Moneda' }, { key: 'estado_pago', label: 'Estado de pago' }
        ],
        medidas: medidasBase, filtros: filtrosBase,
        agruparPorDefecto: ['cliente'], kpis: kpisBase
      })
    }

    if (panelId === 'repv-despacho') {
      // Las notas de crédito/débito no se despachan: se excluyen para que no
      // aparezcan eternamente como "pendientes de despacho".
      const filasDespacho = activas
        .filter(v => !esNota(v.tipo_comprobante))
        .map(v => filas[activas.indexOf(v)])
        .filter(Boolean)
      crearReporte('repv-despacho', {
        id: 'repv-despacho',
        titulo: 'Estado de despacho de las ventas',
        descripcion: 'Facturado vs entregado. Las ventas pendientes o parciales necesitan su Guía de Despacho para que el stock se descuente. Las notas de crédito/débito no aparecen aquí porque no mueven mercadería.',
        datos: filasDespacho,
        dimensiones: [
          { key: 'estado_despacho', label: 'Estado de despacho' }, { key: 'cliente', label: 'Cliente' },
          { key: 'mes', label: 'Mes' }, { key: 'estado_pago', label: 'Estado de pago' }
        ],
        medidas: [{ key: 'total', label: 'Total facturado', agg: 'sum', formato: 'money' }],
        filtros: [
          ...filtrosBase,
          { key: 'estado_despacho', label: 'Despacho', tipo: 'select', opciones: Array.from(new Set(filas.map(f => f.estado_despacho))).sort() }
        ],
        agruparPorDefecto: ['estado_despacho'],
        kpis: (f) => {
          const pend = f.filter(x => x.estado_despacho !== 'despachado')
          return [
            { label: 'Total facturado', valor: f.reduce((s, x) => s + x.total, 0), formato: 'money' },
            { label: 'Sin despachar', valor: pend.reduce((s, x) => s + x.total, 0), formato: 'money', color: 'var(--color-warning)', sub: `${pend.length} venta(s)` },
            { label: 'Comprobantes', valor: f.length, formato: 'int' }
          ]
        }
      })
    }

    if (panelId === 'repv-productos' || panelId === 'repv-margen') {
      const filasDet = (detalles || []).map(d => {
        const v = ventaMap[d.venta_id] || {}
        if (estaAnulado(v)) return null
        const it = itemMap[d.item_id] || {}
        const cant  = parseFloat(d.cantidad || 0)
        const pu    = parseFloat(d.precio_unitario || 0)
        const costo = parseFloat(d.costo_unitario || 0)
        const tc    = parseFloat(v.tipo_cambio || 1) || 1
        // El costo (lote.costo_unitario) SIEMPRE está en soles. El ingreso viene en
        // la moneda de la venta: si la venta es en USD hay que convertirlo a soles
        // con el TC de esa venta antes de restar el costo, o el margen mezcla monedas.
        const ingresoOriginal = parseFloat(d.subtotal || (cant * pu) || 0)
        const ingreso = (v.moneda === 'USD') ? parseFloat((ingresoOriginal * tc).toFixed(2)) : ingresoOriginal
        const costoTotal = parseFloat((cant * costo).toFixed(2))
        return {
          producto: it.nombre || d.descripcion || `Item ${d.item_id}`,
          sku: it.sku || '—',
          cliente: cliMap[v.contact_id] || '(sin cliente)',
          mes: nombreMes((v.fecha_emision || '').slice(0, 7)),
          fecha: v.fecha_emision || '',
          moneda: v.moneda || 'PEN',
          con_costo: costo > 0 ? 'Con costo' : 'Sin costo registrado',
          cantidad: cant,
          precio_unitario: pu,
          ingreso,
          costo: costoTotal,
          margen: parseFloat((ingreso - costoTotal).toFixed(2)),
          margen_pct: ingreso > 0 ? parseFloat(((ingreso - costoTotal) / ingreso * 100).toFixed(1)) : 0
        }
      }).filter(Boolean)

      if (panelId === 'repv-productos') {
        crearReporte('repv-productos', {
          id: 'repv-productos',
          titulo: 'Ventas por producto',
          descripcion: 'Qué productos mueven tu facturación y a qué precio promedio se venden.',
          datos: filasDet,
          dimensiones: [
            { key: 'producto', label: 'Producto' }, { key: 'cliente', label: 'Cliente' },
            { key: 'mes', label: 'Mes' }, { key: 'moneda', label: 'Moneda' }
          ],
          medidas: [
            { key: 'cantidad', label: 'Cantidad', agg: 'sum', formato: 'qty' },
            { key: 'ingreso', label: 'Ingreso', agg: 'sum', formato: 'money' },
            { key: 'precio_unitario', label: 'Precio unit. prom.', agg: 'avg', formato: 'money4' }
          ],
          filtros: [
            { key: 'buscar', label: 'Buscar', tipo: 'texto', campos: ['producto', 'sku', 'cliente'], placeholder: 'Producto o cliente...' },
            { key: 'moneda', label: 'Moneda', tipo: 'select', opciones: ['PEN', 'USD'] },
            { key: 'rango', label: 'Fecha', tipo: 'rango', campo: 'fecha' }
          ],
          agruparPorDefecto: ['producto'],
          kpis: (f) => [
            { label: 'Ingreso total', valor: f.reduce((s, x) => s + x.ingreso, 0), formato: 'money' },
            { label: 'Unidades vendidas', valor: f.reduce((s, x) => s + x.cantidad, 0), formato: 'qty' },
            { label: 'Productos distintos', valor: new Set(f.map(x => x.producto)).size, formato: 'int' }
          ]
        })
      }

      if (panelId === 'repv-margen') {
        const sinCosto = filasDet.filter(f => f.con_costo === 'Sin costo registrado').length
        crearReporte('repv-margen', {
          id: 'repv-margen',
          titulo: 'Margen bruto por producto y cliente',
          descripcion: sinCosto > 0
            ? `Ingreso menos costo del lote vendido. ⚠ ${sinCosto} línea(s) no tienen costo registrado y aparecen con margen = ingreso: filtra por "Con costo" para leer el margen real.`
            : 'Ingreso menos costo del lote efectivamente vendido (identificación específica).',
          datos: filasDet,
          dimensiones: [
            { key: 'producto', label: 'Producto' }, { key: 'cliente', label: 'Cliente' },
            { key: 'mes', label: 'Mes' }, { key: 'con_costo', label: 'Costo registrado' }
          ],
          medidas: [
            { key: 'ingreso', label: 'Ingreso', agg: 'sum', formato: 'money' },
            { key: 'costo', label: 'Costo', agg: 'sum', formato: 'money' },
            { key: 'margen', label: 'Margen bruto', agg: 'sum', formato: 'money', semaforo: true },
            { key: 'margen_pct', label: '% margen', agg: 'avg', formato: 'pct' }
          ],
          filtros: [
            { key: 'buscar', label: 'Buscar', tipo: 'texto', campos: ['producto', 'cliente'], placeholder: 'Producto o cliente...' },
            { key: 'con_costo', label: 'Costo', tipo: 'select', opciones: ['Con costo', 'Sin costo registrado'], valorDefecto: sinCosto > 0 ? 'Con costo' : '' },
            { key: 'rango', label: 'Fecha', tipo: 'rango', campo: 'fecha' }
          ],
          agruparPorDefecto: ['producto'],
          kpis: (f) => {
            const ing = f.reduce((s, x) => s + x.ingreso, 0)
            const cos = f.reduce((s, x) => s + x.costo, 0)
            return [
              { label: 'Ingreso', valor: ing, formato: 'money' },
              { label: 'Costo', valor: cos, formato: 'money', color: 'var(--color-danger)' },
              { label: 'Margen bruto', valor: ing - cos, formato: 'money', color: (ing - cos) >= 0 ? 'var(--color-success)' : 'var(--color-danger)' },
              { label: '% margen', valor: ing ? ((ing - cos) / ing * 100) : 0, formato: 'pct' }
            ]
          }
        })
      }
    }
    if (panelId === 'repv-lote') {
      // Ficha de vida completa del lote: nace en la compra (proveedor, fecha,
      // costo en soles) y de ahí se sigue cada venta que lo consumió, hasta el
      // total/margen final. Incluye lotes SIN ventas todavía (stock 100% intacto)
      // para dar visión de ciclo de vida completo, no solo de lo ya vendido.
      const filasLote = []
      ;(lotes || []).forEach(l => {
        const it = itemMap[l.item_id] || {}
        const base = {
          lote: l.numero_lote || `Lote ${l.id}`,
          producto: it.nombre || `Item ${l.item_id}`,
          proveedor: provMap[l.proveedor_id] || '(sin proveedor)',
          fecha_compra: l.fecha_ingreso || '',
          costo_unitario_lote: parseFloat(l.costo_unitario || 0),
          saldo_lote: parseFloat(l.cantidad || 0)
        }
        const detallesLote = (detalles || []).filter(d => {
          if (String(d.lote_id) !== String(l.id)) return false
          const v = ventaMap[d.venta_id]
          return v && !estaAnulado(v)
        })
        if (detallesLote.length === 0) {
          filasLote.push({
            ...base,
            documento: '(sin ventas)', cliente: '(sin ventas)', fecha_venta: '', mes: '',
            moneda: '—', cantidad_vendida: 0, precio_unitario: 0, ingreso: 0, costo: 0,
            margen: 0, margen_pct: 0, estado_lote: 'Sin ventas'
          })
          return
        }
        detallesLote.forEach(d => {
          const v = ventaMap[d.venta_id] || {}
          const cant = parseFloat(d.cantidad || 0)
          const pu   = parseFloat(d.precio_unitario || 0)
          const costoUnit = parseFloat(d.costo_unitario || l.costo_unitario || 0)
          const tc = parseFloat(v.tipo_cambio || 1) || 1
          const ingresoOriginal = parseFloat(d.subtotal || (cant * pu) || 0)
          const ingreso = (v.moneda === 'USD') ? parseFloat((ingresoOriginal * tc).toFixed(2)) : ingresoOriginal
          const costoTotal = parseFloat((cant * costoUnit).toFixed(2))
          filasLote.push({
            ...base,
            documento: v.numero || `${v.serie || ''}-${v.correlativo || ''}`,
            cliente: cliMap[v.contact_id] || '(sin cliente)',
            fecha_venta: v.fecha_emision || '',
            mes: nombreMes((v.fecha_emision || '').slice(0, 7)),
            moneda: v.moneda || 'PEN',
            cantidad_vendida: cant,
            precio_unitario: pu,
            ingreso, costo: costoTotal,
            margen: parseFloat((ingreso - costoTotal).toFixed(2)),
            margen_pct: ingreso > 0 ? parseFloat(((ingreso - costoTotal) / ingreso * 100).toFixed(1)) : 0,
            estado_lote: 'Con ventas'
          })
        })
      })

      crearReporte('repv-lote', {
        id: 'repv-lote',
        titulo: 'Rentabilidad por lote',
        descripcion: 'Ciclo de vida del lote: nace en la compra (proveedor, fecha, costo en soles) y de ahí se listan todas sus ventas hasta el margen final. Ingreso ya convertido a soles con el TC de cada venta.',
        datos: filasLote,
        dimensiones: [
          { key: 'lote', label: 'Lote' }, { key: 'producto', label: 'Producto' },
          { key: 'proveedor', label: 'Proveedor' }, { key: 'cliente', label: 'Cliente' },
          { key: 'documento', label: 'Venta (comprobante)' }, { key: 'mes', label: 'Mes de venta' }
        ],
        medidas: [
          { key: 'cantidad_vendida', label: 'Cant. vendida', agg: 'sum', formato: 'qty' },
          { key: 'saldo_lote', label: 'Saldo en stock', agg: 'max', formato: 'qty' },
          { key: 'ingreso', label: 'Ingreso (S/)', agg: 'sum', formato: 'money' },
          { key: 'costo', label: 'Costo (S/)', agg: 'sum', formato: 'money' },
          { key: 'margen', label: 'Margen bruto (S/)', agg: 'sum', formato: 'money', semaforo: true },
          { key: 'margen_pct', label: '% margen', agg: 'avg', formato: 'pct' }
        ],
        filtros: [
          { key: 'buscar', label: 'Buscar', tipo: 'texto', campos: ['lote', 'producto', 'proveedor', 'cliente'], placeholder: 'Lote, producto, proveedor o cliente...' },
          { key: 'estado_lote', label: 'Estado', tipo: 'select', opciones: ['Con ventas', 'Sin ventas'] },
          { key: 'compra', label: 'Fecha de compra', tipo: 'rango', campo: 'fecha_compra' },
          { key: 'venta', label: 'Fecha de venta', tipo: 'rango', campo: 'fecha_venta' }
        ],
        agruparPorDefecto: ['lote'],
        kpis: (f) => {
          const ing = f.reduce((s, x) => s + x.ingreso, 0)
          const cos = f.reduce((s, x) => s + x.costo, 0)
          const lotesDistintos = new Set(f.map(x => x.lote))
          const sinVender = new Set(f.filter(x => x.estado_lote === 'Sin ventas').map(x => x.lote))
          return [
            { label: 'Lotes en el reporte', valor: lotesDistintos.size, formato: 'int' },
            { label: 'Lotes sin vender aún', valor: sinVender.size, formato: 'int', color: 'var(--color-warning)' },
            { label: 'Ingreso total (S/)', valor: ing, formato: 'money' },
            { label: 'Margen bruto (S/)', valor: ing - cos, formato: 'money', color: (ing - cos) >= 0 ? 'var(--color-success)' : 'var(--color-danger)' },
            { label: '% margen', valor: ing ? ((ing - cos) / ing * 100) : 0, formato: 'pct' }
          ]
        }
      })
    }
  } catch (e) {
    console.error('construirReporteVentas:', e)
    _repVentasListos[panelId] = false
    if (cont) cont.innerHTML = `<div class="card"><p class="reporte-vacio">No se pudo construir el reporte: ${e.message}</p></div>`
  }
}
