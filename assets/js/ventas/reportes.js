// ============================================================================
// ventas/reportes.js — parte de ventas.js (reorganizado 2026-09-25, sin cambios de lógica)
// Mapa completo de funciones: Claude outputs/glosario_funciones_erp.md
// ============================================================================
import { getCustomers, getLotes, getItems, getVentas, getTodosDetalleVentas, getSuppliers, getContactsByType, getCuentasCobrar, getCompras } from '../supabase-data.js'
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
    const [ventas, clientes, detalles, items, lotes, proveedores, vendedores] = await Promise.all([
      cacheado('ventas', getVentas),
      cacheado('clientes', getCustomers),
      cacheado('detalle_ventas_todos', getTodosDetalleVentas),
      cacheado('items', getItems),
      cacheado('lotes', getLotes),
      cacheado('proveedores', getSuppliers),
      cacheado('vendedores', () => getContactsByType('vendedor'))
    ])

    const cliMap = {};   (clientes || []).forEach(c => { cliMap[c.id] = c.razon_social || c.nombre })
    const itemMap = {};  (items || []).forEach(i => { itemMap[i.id] = i })
    const ventaMap = {}; (ventas || []).forEach(v => { ventaMap[v.id] = v })
    const provMap = {};  (proveedores || []).forEach(p => { provMap[p.id] = p.razon_social || p.nombre })
    const loteMap = {};  (lotes || []).forEach(l => { loteMap[l.id] = l })
    // Vendedor (2026-10-02): dimensión + filtro en todos los reportes y tab propio.
    const vendMap = {};  (vendedores || []).forEach(p => { vendMap[p.id] = p.razon_social || p.nombre })
    const _vend = (v) => v?.vendedor_id ? (vendMap[v.vendedor_id] || `Vendedor ${v.vendedor_id}`) : '(sin vendedor)'
    const _filtroVendedor = (rows) => ({ key: 'vendedor', label: 'Vendedor', tipo: 'select', opciones: Array.from(new Set(rows.map(r => r.vendedor))).sort() })
    const _dimVendedor = { key: 'vendedor', label: 'Vendedor' }
    // N° de documento (FFFI-00000480) para identificar la venta en cualquier
    // reporte (2026-10-02: "Comprobante" agrupaba solo por Factura/Boleta).
    const _numDoc = (v) => v?.numero || (v?.serie ? `${v.serie}-${String(v.correlativo || '').padStart(8, '0')}` : '(sin comprobante)')
    const _dimComprobante = { key: 'comprobante', label: 'Comprobante' }
    const _dimTipo = { key: 'tipo_comprobante', label: 'Tipo' }
    // Fecha con granularidad Año/Mes/Día (motor reportes.js) y Moneda
    const _dimFecha = { key: 'fecha', label: 'Fecha', tipo: 'fecha', granularidad: 'mes' }
    const _dimMoneda = { key: 'moneda', label: 'Moneda' }
    // T.C. promedio PONDERADO de las ventas en USD del grupo (las PEN no cuentan)
    const _medTC = (campoBase) => ({ key: 'tc', label: 'T.C. (USD)', agg: 'ratio', formato: 'tc',
      num: f => f.moneda === 'USD' ? (f[campoBase] || 0) * (f.tc || 0) : 0,
      den: f => f.moneda === 'USD' ? (f[campoBase] || 0) : 0 })
    const _medCosto = { key: 'costo', label: 'Costo (S/)', agg: 'sum', formato: 'money' }
    // Costo (en soles) de cada venta = Σ cantidad × costo_unitario de sus líneas
    const costoPorVenta = {}
    ;(detalles || []).forEach(d => {
      costoPorVenta[d.venta_id] = (costoPorVenta[d.venta_id] || 0) + (parseFloat(d.cantidad || 0) * parseFloat(d.costo_unitario || 0))
    })

    // Un comprobante anulado no vendió nada: se excluye de TODOS los reportes
    // (facturación, márgenes, despacho). Queda visible solo en el listado.
    const activas = (ventas || []).filter(v => !estaAnulado(v))

    // Las notas de crédito entran con signo negativo para que cualquier
    // agrupación (por mes, cliente, producto) dé la venta NETA real.
    const filas = activas.map(v => {
      const sg = signoDocumento(v.tipo_comprobante)
      return {
        cliente: cliMap[v.contact_id] || `ID ${v.contact_id}`,
        vendedor: _vend(v),
        mes: nombreMes((v.fecha_emision || '').slice(0, 7)),
        fecha: v.fecha_emision || '',
        comprobante: _numDoc(v),
        tipo_comprobante: nombreTipoComprobante(v.tipo_comprobante),
        moneda: v.moneda || 'PEN',
        estado_pago: v.estado_pago || 'pendiente',
        estado_despacho: v.estado_despacho || 'pendiente',
        tc: parseFloat(v.tipo_cambio || 1) || 1,
        costo: parseFloat(((costoPorVenta[v.id] || 0) * sg).toFixed(2)),
        base: parseFloat(v.base_imponible || 0) * sg,
        igv: parseFloat(v.igv || 0) * sg,
        total: parseFloat(v.total || 0) * sg
      }
    })

    const filtrosBase = [
      { key: 'buscar', label: 'Buscar', tipo: 'texto', campos: ['cliente', 'comprobante'], placeholder: 'Cliente o comprobante...' },
      { key: 'tipo_comprobante', label: 'Tipo', tipo: 'select', opciones: Array.from(new Set(filas.map(f => f.tipo_comprobante))).sort() },
      { key: 'moneda', label: 'Moneda', tipo: 'select', opciones: ['PEN', 'USD'] },
      { key: 'rango', label: 'Emisión', tipo: 'rango', campo: 'fecha' },
      _filtroVendedor(filas)
    ]
    const medidasBase = [
      { key: 'base', label: 'Base imponible', agg: 'sum', formato: 'money' },
      { key: 'igv', label: 'IGV', agg: 'sum', formato: 'money' },
      { key: 'total', label: 'Total', agg: 'sum', formato: 'money' },
      _medCosto,
      _medTC('base')
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
          _dimFecha, _dimComprobante, _dimTipo,
          _dimMoneda, { key: 'cliente', label: 'Cliente' }, _dimVendedor
        ],
        medidas: medidasBase, filtros: filtrosBase, medidasPorDefecto: ['base', 'igv', 'total', 'costo'],
        agruparPorDefecto: ['fecha'], orden: { key: '_etiqueta', dir: 'asc' }, kpis: kpisBase
      })
    }

    if (panelId === 'repv-clientes') {
      crearReporte('repv-clientes', {
        id: 'repv-clientes',
        titulo: 'Ventas por cliente',
        descripcion: 'Concentración de ventas: cuánto pesa cada cliente en tu facturación.',
        datos: filas,
        dimensiones: [
          { key: 'cliente', label: 'Cliente' }, _dimFecha,
          _dimMoneda, { key: 'estado_pago', label: 'Estado de pago' }, _dimVendedor, _dimComprobante
        ],
        medidas: medidasBase, filtros: filtrosBase, medidasPorDefecto: ['base', 'igv', 'total', 'costo'],
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
          _dimFecha, { key: 'estado_pago', label: 'Estado de pago' }, _dimVendedor, _dimComprobante, _dimMoneda
        ],
        medidas: [{ key: 'total', label: 'Total facturado', agg: 'sum', formato: 'money' }, _medCosto, _medTC('total')],
        medidasPorDefecto: ['total', 'costo'],
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
          vendedor: _vend(v),
          comprobante: _numDoc(v),
          lote: d.lote_id ? (loteMap[d.lote_id]?.numero_lote || `Lote ${d.lote_id}`) : '(sin lote)',
          mes: nombreMes((v.fecha_emision || '').slice(0, 7)),
          fecha: v.fecha_emision || '',
          moneda: v.moneda || 'PEN',
          con_costo: costo > 0 ? 'Con costo' : 'Sin costo registrado',
          cantidad: cant,
          precio_unitario: pu,
          ingreso,
          ingreso_orig: ingresoOriginal,
          tc,
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
            _dimFecha, _dimMoneda, _dimVendedor, _dimComprobante
          ],
          medidas: [
            { key: 'cantidad', label: 'Cantidad', agg: 'sum', formato: 'qty' },
            { key: 'ingreso', label: 'Ingreso (S/)', agg: 'sum', formato: 'money' },
            { key: 'precio_unitario', label: 'Precio unit. prom.', agg: 'avg', formato: 'money4' },
            _medCosto,
            _medTC('ingreso_orig')
          ],
          medidasPorDefecto: ['cantidad', 'ingreso', 'precio_unitario', 'costo'],
          filtros: [
            { key: 'buscar', label: 'Buscar', tipo: 'texto', campos: ['producto', 'sku', 'cliente', 'comprobante'], placeholder: 'Producto, cliente o comprobante...' },
            { key: 'moneda', label: 'Moneda', tipo: 'select', opciones: ['PEN', 'USD'] },
            { key: 'rango', label: 'Fecha', tipo: 'rango', campo: 'fecha' },
            _filtroVendedor(filasDet)
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
            { key: 'lote', label: 'Lote' }, _dimFecha, { key: 'con_costo', label: 'Costo registrado' }, _dimVendedor, _dimComprobante, _dimMoneda
          ],
          medidas: [
            { key: 'ingreso', label: 'Ingreso', agg: 'sum', formato: 'money' },
            { key: 'costo', label: 'Costo', agg: 'sum', formato: 'money' },
            { key: 'margen', label: 'Margen bruto', agg: 'sum', formato: 'money', semaforo: true },
            // Ponderado: Σ margen / Σ ingreso (antes promedio simple de % por línea)
            { key: 'margen_pct', label: '% margen', agg: 'ratio', num: f => f.margen * 100, den: f => f.ingreso, formato: 'pct' },
            _medTC('ingreso_orig')
          ],
          medidasPorDefecto: ['ingreso', 'costo', 'margen', 'margen_pct'],
          filtros: [
            { key: 'buscar', label: 'Buscar', tipo: 'texto', campos: ['producto', 'cliente', 'vendedor', 'comprobante', 'lote'], placeholder: 'Producto, cliente, lote o comprobante...' },
            { key: 'con_costo', label: 'Costo', tipo: 'select', opciones: ['Con costo', 'Sin costo registrado'], valorDefecto: sinCosto > 0 ? 'Con costo' : '' },
            { key: 'rango', label: 'Fecha', tipo: 'rango', campo: 'fecha' },
            _filtroVendedor(filasDet)
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
      // T.C. de la COMPRA de cada lote (cabecera de la factura de compra;
      // si no hay compra enlazada, el T.C. guardado en el lote). 2026-10-05.
      const compras = await cacheado('compras', getCompras).catch(() => [])
      const compraMap = {}
      ;(compras || []).forEach(c => { compraMap[c.id] = c })
      ;(lotes || []).forEach(l => {
        const it = itemMap[l.item_id] || {}
        const tcCompraLote = parseFloat(compraMap[l.compra_id]?.tipo_cambio) || parseFloat(l.tipo_cambio) || 1
        const base = {
          tc_compra: tcCompraLote,
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
            documento: '(sin ventas)', cliente: '(sin ventas)', vendedor: '(sin ventas)', fecha_venta: '', mes: '',
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
            documento: _numDoc(v),
            cliente: cliMap[v.contact_id] || '(sin cliente)',
            vendedor: _vend(v),
            fecha_venta: v.fecha_emision || '',
            mes: nombreMes((v.fecha_emision || '').slice(0, 7)),
            moneda: v.moneda || 'PEN',
            cantidad_vendida: cant,
            precio_unitario: pu,
            ingreso, costo: costoTotal, ingreso_orig: ingresoOriginal, tc,
            // Importe en USD: venta en USD tal cual; venta en soles ÷ su T.C.
            // (T.C. SUNAT guardado en la venta — ver SQL 68 / 2026-10-05)
            ingreso_usd: v.moneda === 'USD' ? ingresoOriginal : (tc > 0 ? ingresoOriginal / tc : 0),
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
          { key: 'documento', label: 'Comprobante' },
          { key: 'fecha_venta', label: 'Fecha de venta', tipo: 'fecha', granularidad: 'mes' },
          { key: 'fecha_compra', label: 'Fecha de compra', tipo: 'fecha', granularidad: 'mes' },
          _dimVendedor, _dimMoneda
        ],
        medidas: [
          { key: 'cantidad_vendida', label: 'Cant. vendida', agg: 'sum', formato: 'qty' },
          { key: 'saldo_lote', label: 'Saldo en stock', agg: 'max', formato: 'qty' },
          // Precio unitario de venta (2026-10-05): promedio PONDERADO por
          // cantidad = Σ ingreso / Σ cantidad, así al agrupar varias ventas
          // da el precio real promedio. En soles (todo convertido con el TC
          // de cada venta) y en USD (solo las ventas en dólares, igual que T.C.).
          { key: 'pu_soles', label: 'P.U. venta (S/)', agg: 'ratio', formato: 'money4',
            num: f => f.ingreso || 0, den: f => f.cantidad_vendida || 0 },
          // P.U. en USD de TODAS las ventas: las de soles ÷ su T.C. de venta
          { key: 'pu_usd', label: 'P.U. venta (USD)', agg: 'ratio', formato: 'money4',
            num: f => f.ingreso_usd || 0, den: f => f.cantidad_vendida || 0 },
          // Base imponible (sin IGV) en la moneda del comprobante — agrupar
          // por Moneda para no mezclar USD con PEN.
          { key: 'base_doc', label: 'Base imp. venta (moneda doc.)', agg: 'sum', formato: 'money', calc: f => f.ingreso_orig || 0 },
          { key: 'ingreso', label: 'Ingreso (S/)', agg: 'sum', formato: 'money' },
          { key: 'cu_soles', label: 'Costo unit. (S/)', agg: 'ratio', formato: 'money4',
            num: f => f.costo || 0, den: f => f.cantidad_vendida || 0 },
          { key: 'costo', label: 'Costo (S/)', agg: 'sum', formato: 'money' },
          { key: 'margen', label: 'Margen bruto (S/)', agg: 'sum', formato: 'money', semaforo: true },
          { key: 'margen_pct', label: '% margen', agg: 'ratio', num: f => f.margen * 100, den: f => f.ingreso, formato: 'pct' },
          // T.C. de la venta (comprobante) y de la compra (lote), ponderados
          // por cantidad vendida. En ventas/compras en soles = T.C. SUNAT de
          // referencia guardado en el documento (2026-10-05).
          { key: 'tc_venta', label: 'T.C. venta', agg: 'ratio', formato: 'tc',
            num: f => (f.cantidad_vendida || 0) * (f.tc || 0), den: f => f.tc ? (f.cantidad_vendida || 0) : 0 },
          { key: 'tc_compra', label: 'T.C. compra', agg: 'ratio', formato: 'tc',
            num: f => (f.cantidad_vendida || f.saldo_lote || 0) * (f.tc_compra || 0), den: f => (f.cantidad_vendida || f.saldo_lote || 0) }
        ],
        medidasPorDefecto: ['cantidad_vendida', 'saldo_lote', 'pu_soles', 'pu_usd', 'ingreso', 'costo', 'margen', 'margen_pct', 'tc_venta', 'tc_compra'],
        filtros: [
          { key: 'buscar', label: 'Buscar', tipo: 'texto', campos: ['lote', 'producto', 'proveedor', 'cliente', 'documento'], placeholder: 'Lote, producto, cliente o comprobante...' },
          { key: 'estado_lote', label: 'Estado', tipo: 'select', opciones: ['Con ventas', 'Sin ventas'] },
          { key: 'compra', label: 'Fecha de compra', tipo: 'rango', campo: 'fecha_compra' },
          { key: 'venta', label: 'Fecha de venta', tipo: 'rango', campo: 'fecha_venta' },
          _filtroVendedor(filasLote)
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

    if (panelId === 'repv-vendedor') {
      // Desempeño por vendedor: una fila por comprobante (NC en negativo), todo
      // en SOLES (USD × TC de la venta). Margen = base − costo de sus líneas
      // (costo del lote vendido). Cobrado/pendiente desde su Cuenta por Cobrar.
      const cxcs = await cacheado('cuentas_cobrar', getCuentasCobrar).catch(() => [])
      const cxcPorVenta = {}
      ;(cxcs || []).forEach(c => { if (c.venta_id) cxcPorVenta[c.venta_id] = c })
      const detPorVenta = {}
      ;(detalles || []).forEach(d => { (detPorVenta[d.venta_id] = detPorVenta[d.venta_id] || []).push(d) })

      // 2026-10-06: UNA FILA POR LÍNEA (producto + lote) del comprobante, para
      // poder agrupar por Producto / Lote / Moneda y sacar los datos de
      // COMISIÓN en USD. Los importes de cabecera (base, total, cobrado,
      // pendiente) se reparten entre las líneas según su peso en el subtotal,
      // así la suma por comprobante sigue igual que antes.
      //
      // Comisión (la calcula Luis aparte en Excel) — margen en USD:
      //   Base imp. USD  = base sin IGV de la línea; venta en soles ÷ T.C. de la venta
      //   Costo USD      = kg × costo unit. USD del lote = precio de FACTURA de
      //                    compra (sin gastos de importación); compra en soles
      //                    ÷ T.C. de esa compra (T.C. venta SUNAT, SQL 68)
      //   Margen USD     = Base imp. USD − Costo USD
      const compras = await cacheado('compras', getCompras).catch(() => [])
      const compraMap = {}
      ;(compras || []).forEach(c => { compraMap[c.id] = c })
      const _costoLoteUSD = (lote) => {
        if (!lote) return { cu: 0, tc: 0 }
        const compra = compraMap[lote.compra_id]
        const mon = lote.moneda || compra?.currency || 'PEN'
        const tcC = parseFloat(compra?.tipo_cambio) || parseFloat(lote.tipo_cambio) || 1
        const cuPen = parseFloat(lote.costo_unitario) || 0
        const tcLote = parseFloat(lote.tipo_cambio) || 1
        const cuOrig = lote.costo_unit_original != null
          ? (parseFloat(lote.costo_unit_original) || 0)
          : (mon === 'USD' ? cuPen / tcLote : cuPen)
        return { cu: mon === 'USD' ? cuOrig : (tcC > 0 ? cuOrig / tcC : 0), tc: tcC }
      }

      const filasVend = []
      activas.forEach(v => {
        const sg = signoDocumento(v.tipo_comprobante)
        const nota = esNota(v.tipo_comprobante)
        const tcV = parseFloat(v.tipo_cambio) || 1          // T.C. guardado en la venta (también en soles)
        const tcConv = v.moneda === 'USD' ? tcV : 1         // solo USD convierte a soles
        const c = cxcPorVenta[v.id]
        const cobradoDoc = c ? (parseFloat(c.monto_cobrado || 0) + parseFloat(c.monto_retenido || 0) + parseFloat(c.monto_canjeado || 0) + parseFloat(c.monto_anticipo_aplicado || 0)) : 0
        const pendienteDoc = c ? Math.max(0, parseFloat(c.monto_total || 0) - cobradoDoc) : 0
        const baseDoc = parseFloat(v.base_imponible || 0)
        const totalDoc = parseFloat(v.total || 0)
        const comun = {
          vendedor: _vend(v),
          cliente: cliMap[v.contact_id] || '(sin cliente)',
          mes: nombreMes((v.fecha_emision || '').slice(0, 7)),
          fecha: v.fecha_emision || '',
          comprobante: _numDoc(v),
          tipo_comprobante: nombreTipoComprobante(v.tipo_comprobante),
          moneda: v.moneda || 'PEN',
          es_nota: nota,
          n_comp: nota ? null : _numDoc(v),
          clientes: nota ? null : (cliMap[v.contact_id] || '(sin cliente)')
        }
        let dets = detPorVenta[v.id] || []
        const sumSub = dets.reduce((s, d) => s + (parseFloat(d.subtotal) || 0), 0)
        if (dets.length === 0) dets = [null]   // comprobante sin líneas (servicio/anticipo): una fila
        dets.forEach(d => {
          const p = d ? (sumSub > 0 ? (parseFloat(d.subtotal) || 0) / sumSub : 1 / dets.length) : 1
          const cant = d ? parseFloat(d.cantidad || 0) : 0
          const cuSoles = d ? parseFloat(d.costo_unitario || 0) : 0
          const lote = d?.lote_id ? loteMap[d.lote_id] : null
          const it = d ? (itemMap[d.item_id] || {}) : {}
          const baseLineaDoc = baseDoc * p * sg                     // moneda del comprobante
          const baseSoles = baseLineaDoc * tcConv
          const costoSoles = cant * cuSoles * sg
          const baseUSD = v.moneda === 'USD' ? baseLineaDoc : (tcV > 0 ? baseLineaDoc / tcV : 0)
          const { cu: cuUSD, tc: tcC } = _costoLoteUSD(lote)
          const costoUSD = cant * cuUSD * sg
          filasVend.push({
            ...comun,
            producto: d ? (it.nombre || `Item ${d.item_id}`) : '(sin detalle)',
            lote: d ? (lote?.numero_lote || (d.lote_id ? `Lote ${d.lote_id}` : '(sin lote)')) : '(sin detalle)',
            base_orig: baseLineaDoc,
            tc: tcV,
            tc_compra: tcC,
            base: parseFloat(baseSoles.toFixed(2)),
            total: parseFloat((totalDoc * p * sg * tcConv).toFixed(2)),
            costo: parseFloat(costoSoles.toFixed(2)),
            margen: parseFloat((baseSoles - costoSoles).toFixed(2)),
            kg: cant * sg,
            base_usd: baseUSD,
            costo_usd: costoUSD,
            margen_usd: baseUSD - costoUSD,
            cobrado: parseFloat((cobradoDoc * p * tcConv).toFixed(2)),
            pendiente: parseFloat((pendienteDoc * p * tcConv).toFixed(2)),
            ticket_den: nota ? 0 : p,
            sin_costo: d && !(cuSoles > 0) ? 1 : 0
          })
        })
      })

      crearReporte('repv-vendedor', {
        id: 'repv-vendedor',
        titulo: 'Desempeño por vendedor',
        descripcion: 'Ventas, margen y cobranza de cada vendedor en soles, y datos para COMISIÓN en USD: Base imp. USD (ventas en soles ÷ su T.C.) − Costo USD (kg × precio de factura de compra del lote; compras en soles ÷ su T.C.) = Margen USD. Las NC restan. Agrupa por Producto / Lote / Moneda para el detalle.',
        datos: filasVend,
        dimensiones: [
          _dimVendedor, _dimFecha, { key: 'cliente', label: 'Cliente' },
          _dimComprobante, _dimTipo, _dimMoneda,
          { key: 'producto', label: 'Producto' }, { key: 'lote', label: 'Lote' }
        ],
        medidas: [
          { key: 'base', label: 'Ventas sin IGV (S/)', agg: 'sum', formato: 'money' },
          { key: 'total', label: 'Ventas con IGV (S/)', agg: 'sum', formato: 'money' },
          { key: 'n_comp', label: 'N° comprobantes', agg: 'distinct', formato: 'int' },
          { key: 'ticket', label: 'Ticket promedio (S/)', agg: 'ratio', num: f => f.es_nota ? 0 : f.base, den: f => f.ticket_den, formato: 'money' },
          { key: 'kg', label: 'Cantidad vendida', agg: 'sum', formato: 'qty' },
          { key: 'clientes', label: 'Clientes atendidos', agg: 'distinct', formato: 'int' },
          { key: 'costo', label: 'Costo (S/)', agg: 'sum', formato: 'money' },
          { key: 'margen', label: 'Margen bruto (S/)', agg: 'sum', formato: 'money', semaforo: true },
          { key: 'margen_pct', label: '% margen', agg: 'ratio', num: f => f.margen * 100, den: f => f.base, formato: 'pct' },
          { key: 'cobrado', label: 'Cobrado (S/)', agg: 'sum', formato: 'money' },
          { key: 'pendiente', label: 'Por cobrar (S/)', agg: 'sum', formato: 'money' },
          // ---- Datos para COMISIÓN, en USD (2026-10-06) ----
          { key: 'pu_venta_usd', label: 'P.U. venta (USD)', agg: 'ratio', formato: 'money4', num: f => f.base_usd, den: f => f.kg },
          { key: 'cu_usd', label: 'Costo unit. (USD)', agg: 'ratio', formato: 'money4', num: f => f.costo_usd, den: f => f.kg },
          { key: 'base_usd', label: 'Base imp. venta (USD)', agg: 'sum', formato: 'money' },
          { key: 'costo_usd', label: 'Costo total (USD)', agg: 'sum', formato: 'money' },
          { key: 'margen_usd', label: 'Margen (USD)', agg: 'sum', formato: 'money', semaforo: true },
          { key: 'margen_usd_pct', label: '% margen (USD)', agg: 'ratio', num: f => f.margen_usd * 100, den: f => f.base_usd, formato: 'pct' },
          { key: 'tc_venta', label: 'T.C. venta', agg: 'ratio', formato: 'tc', num: f => Math.abs(f.kg) * f.tc, den: f => Math.abs(f.kg) },
          { key: 'tc_compra', label: 'T.C. compra', agg: 'ratio', formato: 'tc', num: f => Math.abs(f.kg) * f.tc_compra, den: f => f.tc_compra ? Math.abs(f.kg) : 0 }
        ],
        filtros: [
          { key: 'buscar', label: 'Buscar', tipo: 'texto', campos: ['vendedor', 'cliente', 'comprobante', 'producto', 'lote'], placeholder: 'Vendedor, cliente, comprobante, producto o lote...' },
          _filtroVendedor(filasVend),
          { key: 'rango', label: 'Emisión', tipo: 'rango', campo: 'fecha' }
        ],
        agruparPorDefecto: ['vendedor'],
        medidasPorDefecto: ['base', 'n_comp', 'ticket', 'clientes', 'margen', 'margen_pct', 'cobrado', 'pendiente'],
        kpis: (f) => {
          const base = f.reduce((s, x) => s + x.base, 0)
          const marg = f.reduce((s, x) => s + x.margen, 0)
          const pend = f.reduce((s, x) => s + x.pendiente, 0)
          const sinC = f.reduce((s, x) => s + x.sin_costo, 0)
          return [
            { label: 'Ventas sin IGV (S/)', valor: base, formato: 'money' },
            { label: 'Margen bruto (S/)', valor: marg, formato: 'money', color: marg >= 0 ? 'var(--color-success)' : 'var(--color-danger)',
              sub: sinC ? `⚠ ${sinC} línea(s) sin costo inflan el margen` : '' },
            { label: '% margen', valor: base ? marg / base * 100 : 0, formato: 'pct' },
            { label: 'Por cobrar (S/)', valor: pend, formato: 'money', color: 'var(--color-warning)' },
            { label: 'Vendedores', valor: new Set(f.map(x => x.vendedor)).size, formato: 'int' }
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
