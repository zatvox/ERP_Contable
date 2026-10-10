// ============================================================================
// inventario/reportes.js — parte de inventario.js (reorganizado 2026-09-25, sin cambios de lógica)
// Mapa completo de funciones: Claude outputs/glosario_funciones_erp.md
// ============================================================================
import { colStyle } from '../col-menu.js'
import { getItems, getLotes, getCategorias, getPartidas, getMarcas, getAlmacenes, getUbicaciones, getStockUbicaciones, getKardex, getVentas, getCompras, getContacts } from '../supabase-data.js'
import { showToast } from '../helpers.js'
import { getModuloConfig } from '../config-modulo.js'
import { cacheado } from '../data-cache.js'
import { crearReporte, nombreMes } from '../reportes.js'
import { visualKardexLote } from './reportes-visual-lote.js'

// ============================================================================
// REPORTES — Stock por Partida (bloque de reportes del módulo)
// ============================================================================
// Agrupa los lotes por (producto, código de partida): la partida es la
// etiqueta libre que agrupa varios lotes recibidos juntos en una misma guía
// (ver 23_codigo_partida_lotes.sql) — este reporte responde "¿cuánto stock
// total queda de la partida X?" sin tener que sumar lote por lote a mano.

function _poblarFiltroCategoriaReportePartidas(categorias) {
  const sel = document.getElementById('filtroReportePartidaCategoria')
  if (!sel || sel.options.length > 1) return
  categorias.forEach(c => {
    const opt = document.createElement('option')
    opt.value = c.id
    opt.textContent = c.nombre
    sel.appendChild(opt)
  })
}

export async function renderReportePartidas() {
  try {
    const container = document.getElementById('tabla-reporte-partidas')
    if (!container) return

    const [lotes, items, categorias, zonas, almacenes, stockUbic] = await Promise.all([
      getLotes(), getItems(), getCategorias(), getUbicaciones(), getAlmacenes(), getStockUbicaciones()
    ])

    _poblarFiltroCategoriaReportePartidas(categorias || [])

    const itemMap = {}
    ;(items || []).forEach(i => { itemMap[i.id] = i })
    const almacenMap = {}
    ;(almacenes || []).forEach(a => { almacenMap[a.id] = a })
    const zonaMap = {}
    ;(zonas || []).forEach(z => { zonaMap[z.id] = z })
    const nombreZona = (ubicacionId) => {
      const z = zonaMap[ubicacionId]
      if (!z) return null
      return `${almacenMap[z.almacen_id]?.nombre || '?'} — ${z.nombre}`
    }

    const soloConPartida = (document.getElementById('filtroReporteSoloConPartida')?.value ?? '1') === '1'
    const fCat = document.getElementById('filtroReportePartidaCategoria')?.value || ''
    const fBusqueda = (document.getElementById('buscarReportePartida')?.value || '').trim().toLowerCase()

    // Agrupar por producto + código de partida. Cantidades desde kardex
    // (vista stock_ubicaciones, la fuente de verdad — igual que Resumen de
    // Stock), NO desde lotes.cantidad, que puede estar desincronizado: por
    // eso salían partidas con 0.00 (2026-10-05). Solo partidas con stock > 0.
    const loteMap = {}
    ;(lotes || []).forEach(l => { loteMap[l.id] = l })
    const grupos = new Map()
    for (const su of (stockUbic || [])) {
      const cant = parseFloat(su.cantidad) || 0
      if (cant <= 0) continue
      const l = loteMap[su.lote_id]
      if (!l) continue
      const partida = (l.codigo_partida || '').trim()
      if (soloConPartida && !partida) continue

      const item = itemMap[l.item_id]
      if (fCat && String(item?.categoria_id) !== fCat) continue

      const clave = `${l.item_id}||${partida}`
      const acc = grupos.get(clave) || { item_id: l.item_id, partida, lotesSet: new Set(), cantidad: 0, valor: 0, zonas: new Set() }
      acc.lotesSet.add(String(l.numero_lote || l.id).trim().toLowerCase())
      acc.cantidad += cant
      acc.valor += cant * (parseFloat(l.costo_unitario) || 0)
      const zn = nombreZona(su.ubicacion_id)
      if (zn) acc.zonas.add(zn)
      grupos.set(clave, acc)
    }

    let filas = [...grupos.values()].map(g => ({ ...g, lotes: g.lotesSet.size }))

    if (fBusqueda) {
      filas = filas.filter(g => {
        const nombreProd = itemMap[g.item_id]?.nombre || ''
        const sku = itemMap[g.item_id]?.sku || ''
        return `${g.partida} ${nombreProd} ${sku}`.toLowerCase().includes(fBusqueda)
      })
    }

    filas.sort((a, b) =>
      (itemMap[a.item_id]?.nombre || '').localeCompare(itemMap[b.item_id]?.nombre || '') ||
      a.partida.localeCompare(b.partida)
    )

    if (filas.length === 0) {
      container.innerHTML = '<p style="text-align: center; color: var(--text-secondary); padding: 20px;">Sin datos para los filtros seleccionados</p>'
      return
    }

    let html = `
      <table>
        <thead>
          <tr>
            <th data-col-tabla="stock-partida" data-col="partida"${colStyle('stock-partida','partida')}>Partida</th>
            <th data-col-tabla="stock-partida" data-col="sku"${colStyle('stock-partida','sku')}>SKU</th>
            <th data-col-tabla="stock-partida" data-col="producto"${colStyle('stock-partida','producto')}>Producto</th>
            <th data-col-tabla="stock-partida" data-col="lotes" style="text-align:center;${colStyle('stock-partida','lotes') ? ' display:none;' : ''}">N° Lotes</th>
            <th data-col-tabla="stock-partida" data-col="cantidad" style="text-align:right;${colStyle('stock-partida','cantidad') ? ' display:none;' : ''}">Cantidad Total</th>
            <th data-col-tabla="stock-partida" data-col="costo_prom" style="text-align:right;${colStyle('stock-partida','costo_prom') ? ' display:none;' : ''}">Costo Promedio</th>
            <th data-col-tabla="stock-partida" data-col="valor" style="text-align:right;${colStyle('stock-partida','valor') ? ' display:none;' : ''}">Valor Total</th>
            <th data-col-tabla="stock-partida" data-col="zonas"${colStyle('stock-partida','zonas')}>Zona(s)</th>
          </tr>
        </thead>
        <tbody>
    `

    let valorGranTotal = 0
    for (const g of filas) {
      const item = itemMap[g.item_id]
      const costoProm = g.cantidad > 0 ? g.valor / g.cantidad : 0
      valorGranTotal += g.valor

      html += `
        <tr>
          <td data-col-tabla="stock-partida" data-col="partida"${colStyle('stock-partida','partida')}><strong>${g.partida || '-'}</strong></td>
          <td data-col-tabla="stock-partida" data-col="sku"${colStyle('stock-partida','sku')}>${item?.sku || '-'}</td>
          <td data-col-tabla="stock-partida" data-col="producto"${colStyle('stock-partida','producto')}>${item?.nombre || `Item #${g.item_id}`}</td>
          <td data-col-tabla="stock-partida" data-col="lotes" style="text-align:center;${colStyle('stock-partida','lotes') ? ' display:none;' : ''}">${g.lotes}</td>
          <td data-col-tabla="stock-partida" data-col="cantidad" style="text-align:right; font-weight:bold;${colStyle('stock-partida','cantidad') ? ' display:none;' : ''}">${g.cantidad.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
          <td data-col-tabla="stock-partida" data-col="costo_prom" style="text-align:right;${colStyle('stock-partida','costo_prom') ? ' display:none;' : ''}">S/. ${costoProm.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
          <td data-col-tabla="stock-partida" data-col="valor" style="text-align:right;${colStyle('stock-partida','valor') ? ' display:none;' : ''}">S/. ${g.valor.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
          <td data-col-tabla="stock-partida" data-col="zonas" style="font-size:0.82rem;${colStyle('stock-partida','zonas') ? ' display:none;' : ''}">${[...g.zonas].join(', ') || '-'}</td>
        </tr>
      `
    }

    html += `
        </tbody>
        <tfoot>
          <tr style="border-top: 2px solid var(--border-color); font-weight: bold;">
            <td data-col-tabla="stock-partida" data-col="partida"${colStyle('stock-partida','partida')}></td>
            <td data-col-tabla="stock-partida" data-col="sku"${colStyle('stock-partida','sku')}></td>
            <td data-col-tabla="stock-partida" data-col="producto"${colStyle('stock-partida','producto')}>TOTAL</td>
            <td data-col-tabla="stock-partida" data-col="lotes"${colStyle('stock-partida','lotes')}></td>
            <td data-col-tabla="stock-partida" data-col="cantidad"${colStyle('stock-partida','cantidad')}></td>
            <td data-col-tabla="stock-partida" data-col="costo_prom"${colStyle('stock-partida','costo_prom')}></td>
            <td data-col-tabla="stock-partida" data-col="valor" style="text-align: right;${colStyle('stock-partida','valor') ? ' display:none;' : ''}">S/. ${valorGranTotal.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
            <td data-col-tabla="stock-partida" data-col="zonas"${colStyle('stock-partida','zonas')}></td>
          </tr>
        </tfoot>
      </table>
    `

    container.innerHTML = html
  } catch (error) {
    console.error('Error en renderReportePartidas:', error)
    showToast('Error al cargar el reporte de partidas', 'danger')
  }
}

window.aplicarFiltrosReportePartidas = async function () {
  await renderReportePartidas()
}
// ============================================================================
// REPORTES GERENCIALES DE INVENTARIO — Fase 2
// ============================================================================
// Se arman sobre lotes, stock por ubicación y kardex, cruzando con el catálogo
// (producto, categoría, marca, partida). Todo pasa por data-cache.js para que
// mover un filtro no vuelva a consultar Supabase.

export const _repInvListos = {}

export async function construirReporteInv(panelId) {
  if (_repInvListos[panelId]) return
  _repInvListos[panelId] = true
  const cont = document.getElementById(panelId)
  if (cont) cont.innerHTML = '<div class="card"><p class="reporte-vacio">Calculando reporte…</p></div>'

  try {
    const [items, lotes, categorias, marcas, partidas, stockUbic, ubicaciones, almacenes] = await Promise.all([
      cacheado('items', getItems),
      cacheado('lotes', getLotes),
      cacheado('categorias', getCategorias),
      cacheado('marcas', getMarcas),
      cacheado('partidas', getPartidas),
      cacheado('stock_ubicaciones', getStockUbicaciones),
      cacheado('ubicaciones', getUbicaciones),
      cacheado('almacenes', getAlmacenes)
    ])

    const itemMap = {};      (items || []).forEach(i => { itemMap[i.id] = i })
    const catMap = {};       (categorias || []).forEach(c => { catMap[c.id] = c.nombre })
    const marcaMap = {};     (marcas || []).forEach(m => { marcaMap[m.id] = m.nombre })
    const partidaMap = {};   (partidas || []).forEach(p => { partidaMap[p.item_id] = p.codigo || p.partida || p.nombre })
    const almMap = {};       (almacenes || []).forEach(a => { almMap[a.id] = a.nombre })
    const ubicMap = {};      (ubicaciones || []).forEach(u => { ubicMap[u.id] = u })

    const _prod = (id) => itemMap[id]?.nombre || `Item ${id}`

    // Una fila por lote: es el grano natural del costeo por identificación específica.
    const filasLotes = (lotes || []).map(l => {
      const it = itemMap[l.item_id] || {}
      const cant = parseFloat(l.cantidad) || 0
      const costo = parseFloat(l.costo_unitario) || 0
      return {
        producto: _prod(l.item_id),
        sku: it.sku || '—',
        categoria: catMap[it.categoria_id] || '(sin categoría)',
        marca: marcaMap[it.marca_id] || '(sin marca)',
        partida: partidaMap[l.item_id] || '(sin partida)',
        lote: l.numero_lote || `#${l.id}`,
        estado_stock: cant <= 0 ? '3 · Agotado' : (cant <= (parseFloat(getModuloConfig('inventario').stockCritico) || 5) ? '1 · Crítico' : '2 · Normal'),
        fecha_ingreso: l.fecha_ingreso || l.created_at?.slice(0, 10) || '',
        mes_ingreso: nombreMes((l.fecha_ingreso || l.created_at || '').slice(0, 7)),
        cantidad: cant,
        costo_unitario: costo,
        valor: parseFloat((cant * costo).toFixed(2))
      }
    })

    if (panelId === 'repi-valorizacion') {
      crearReporte('repi-valorizacion', {
        id: 'repi-valorizacion',
        titulo: 'Valorización del inventario',
        descripcion: 'Cuánto dinero hay parado en stock. Agrupa por categoría, marca, partida o producto para ver dónde está concentrado.',
        datos: filasLotes,
        dimensiones: [
          { key: 'categoria', label: 'Categoría' }, { key: 'marca', label: 'Marca' },
          { key: 'producto', label: 'Producto' }, { key: 'partida', label: 'Partida' },
          { key: 'estado_stock', label: 'Estado' }
        ],
        medidas: [
          { key: 'cantidad', label: 'Cantidad', agg: 'sum', formato: 'qty' },
          { key: 'valor', label: 'Valor', agg: 'sum', formato: 'money' },
          { key: 'costo_unitario', label: 'Costo unit. prom.', agg: 'avg', formato: 'money4' }
        ],
        filtros: [
          { key: 'buscar', label: 'Buscar', tipo: 'texto', campos: ['producto', 'sku', 'lote'], placeholder: 'Producto, SKU o lote...' },
          { key: 'categoria', label: 'Categoría', tipo: 'select', opciones: Array.from(new Set(filasLotes.map(f => f.categoria))).sort() },
          { key: 'estado_stock', label: 'Estado', tipo: 'select', opciones: ['1 · Crítico', '2 · Normal', '3 · Agotado'] }
        ],
        agruparPorDefecto: ['categoria'],
        kpis: (f) => [
          { label: 'Valor total', valor: f.reduce((s, x) => s + x.valor, 0), formato: 'money', color: 'var(--color-success)' },
          { label: 'Unidades', valor: f.reduce((s, x) => s + x.cantidad, 0), formato: 'qty' },
          { label: 'Lotes', valor: f.length, formato: 'int' },
          { label: 'Productos distintos', valor: new Set(f.map(x => x.producto)).size, formato: 'int' }
        ]
      })
    }

    if (panelId === 'repi-lotes') {
      // Grano por ubicación física: dónde está cada lote y cuánto hay ahí.
      const filasUbic = (stockUbic || []).map(su => {
        const l = (lotes || []).find(x => x.id === su.lote_id) || {}
        const it = itemMap[l.item_id] || {}
        const u  = ubicMap[su.ubicacion_id] || {}
        const cant = parseFloat(su.cantidad) || 0
        const costo = parseFloat(l.costo_unitario) || 0
        return {
          almacen: almMap[u.almacen_id] || '(sin almacén)',
          zona: u.nombre || u.codigo || `Ubic. ${su.ubicacion_id}`,
          producto: _prod(l.item_id),
          sku: it.sku || '—',
          lote: l.numero_lote || `#${su.lote_id}`,
          categoria: catMap[it.categoria_id] || '(sin categoría)',
          cantidad: cant,
          valor: parseFloat((cant * costo).toFixed(2))
        }
      })

      crearReporte('repi-lotes', {
        id: 'repi-lotes',
        titulo: 'Stock por lote y ubicación',
        descripcion: 'Dónde está físicamente cada lote. Sirve para preparar despachos y para el conteo cíclico.',
        datos: filasUbic,
        dimensiones: [
          { key: 'almacen', label: 'Almacén' }, { key: 'zona', label: 'Zona' },
          { key: 'producto', label: 'Producto' }, { key: 'lote', label: 'Lote' },
          { key: 'categoria', label: 'Categoría' },
          { key: 'fecha_ingreso', label: 'Fecha de ingreso', tipo: 'fecha', granularidad: 'mes' }
        ],
        medidas: [
          { key: 'cantidad', label: 'Cantidad', agg: 'sum', formato: 'qty' },
          { key: 'valor', label: 'Valor', agg: 'sum', formato: 'money' }
        ],
        filtros: [
          { key: 'buscar', label: 'Buscar', tipo: 'texto', campos: ['producto', 'sku', 'lote', 'zona'], placeholder: 'Producto, lote o zona...' },
          { key: 'almacen', label: 'Almacén', tipo: 'select', opciones: Array.from(new Set(filasUbic.map(f => f.almacen))).sort() }
        ],
        agruparPorDefecto: ['almacen', 'zona'],
        kpis: (f) => [
          { label: 'Unidades ubicadas', valor: f.reduce((s, x) => s + x.cantidad, 0), formato: 'qty' },
          { label: 'Valor ubicado', valor: f.reduce((s, x) => s + x.valor, 0), formato: 'money' },
          { label: 'Ubicaciones con stock', valor: new Set(f.map(x => `${x.almacen}|${x.zona}`)).size, formato: 'int' }
        ]
      })
    }

    if (panelId === 'repi-rotacion' || panelId === 'repi-kardex') {
      const kardex = await cacheado('kardex', getKardex)
      const loteMap = {}; (lotes || []).forEach(l => { loteMap[l.id] = l.numero_lote || `#${l.id}` })

      // Comprobante + contacto del movimiento (venta → cliente, compra → proveedor).
      // Traslados / ajustes no tienen contraparte: se agrupan como "(sin …)".
      const [ventasK, comprasK, contactsK] = await Promise.all([
        cacheado('ventas', getVentas).catch(() => []),
        cacheado('compras', getCompras).catch(() => []),
        cacheado('contacts', getContacts).catch(() => [])
      ])
      const ventaMapK = {}; (ventasK || []).forEach(v => { ventaMapK[v.id] = v })
      const compraMapK = {}; (comprasK || []).forEach(c => { compraMapK[c.id] = c })
      const contactMapK = {}; (contactsK || []).forEach(c => { contactMapK[c.id] = c })
      const _docYContacto = (k) => {
        if (k.venta_id) {
          const v = ventaMapK[k.venta_id]
          if (!v) return { comprobante: `Venta #${k.venta_id}`, contacto: '(venta eliminada)' }
          return { comprobante: `${v.serie || ''}-${String(v.correlativo || '').padStart(8, '0')}`,
                   contacto: contactMapK[v.contact_id]?.nombre || '(sin contacto)' }
        }
        if (k.compra_id) {
          const c = compraMapK[k.compra_id]
          if (!c) return { comprobante: `Compra #${k.compra_id}`, contacto: '(compra eliminada)' }
          return { comprobante: `${c.serie || ''}-${c.numero || ''}`,
                   contacto: contactMapK[c.contact_id]?.nombre || c.proveedor_nombre || '(sin contacto)' }
        }
        return { comprobante: '(sin comprobante)', contacto: '(sin contacto)' }
      }

      // Clase de movimiento (solo vista, la BD no cambia): tipo_movimiento
      // mezcla casos que contablemente son distintos — una devolución a
      // proveedor también es 'salida' y una NC de cliente también es
      // 'entrada'. Se separan por el concepto que graba cada flujo.
      const _clase = (k) => {
        const t = k.tipo_movimiento || k.tipo || ''
        const c = String(k.concepto || '')
        if (t === 'traslado_interno') return 'Traslado'
        if (t === 'ajuste_entrada') return 'Ajuste (+)'
        if (t === 'ajuste_salida') return 'Ajuste (−)'
        if (/devoluci[oó]n de cliente/i.test(c)) return 'Devolución cliente'
        if (/devoluci[oó]n a proveedor/i.test(c)) return 'Devolución proveedor'
        if (/^correcci[oó]n/i.test(c)) return 'Corrección compra'
        if (/^venta/i.test(c)) return 'Venta'
        if (/^compra/i.test(c)) return 'Compra'
        if (t === 'salida') return 'Salida (otra)'
        if (t === 'entrada') return 'Entrada (otra)'
        return t || '(sin tipo)'
      }

      const filasK = (kardex || []).map(k => {
        const it = itemMap[k.item_id] || {}
        const entrada = parseFloat(k.cantidad_entrada || 0) || 0
        const salida  = parseFloat(k.cantidad_salida || 0) || 0
        const vEnt = parseFloat(k.valor_entrada || 0) || 0
        const vSal = parseFloat(k.valor_salida || 0) || 0
        const clase = _clase(k)
        // Cantidad "del movimiento" (traslado: entrada = salida, se cuenta una vez)
        const cantMov = Math.max(entrada, salida)
        const costoU = parseFloat(k.costo_unitario) || (cantMov ? Math.max(vEnt, vSal) / cantMov : 0)
        return {
          producto: _prod(k.item_id),
          sku: it.sku || '—',
          categoria: catMap[it.categoria_id] || '(sin categoría)',
          lote: k.lote_id ? (loteMap[k.lote_id] || `#${k.lote_id}`) : '(sin lote)',
          tipo: clase,
          ..._docYContacto(k),
          mes: nombreMes((k.fecha || '').slice(0, 7)),
          fecha: k.fecha || '',
          entrada, salida,
          valor_entrada: vEnt,
          valor_salida: vSal,
          neto: entrada - salida,
          neto_valor: vEnt - vSal,
          costo_venta: clase === 'Venta' ? vSal : (clase === 'Devolución cliente' ? -vEnt : 0),
          _cant_mov: cantMov,
          _costo_u: costoU
        }
      })

      if (panelId === 'repi-kardex') {
        const ORDEN_CLASES = ['Compra', 'Venta', 'Devolución cliente', 'Devolución proveedor', 'Corrección compra', 'Traslado', 'Ajuste (+)', 'Ajuste (−)', 'Entrada (otra)', 'Salida (otra)']
        const clases = Array.from(new Set(filasK.map(f => f.tipo)))
          .sort((a, b) => (ORDEN_CLASES.indexOf(a) + 1 || 99) - (ORDEN_CLASES.indexOf(b) + 1 || 99))
        crearReporte('repi-kardex', {
          id: 'repi-kardex',
          titulo: 'Kardex resumido (valorizado)',
          descripcion: 'Entradas y salidas por producto, lote, tipo de movimiento y mes, con su valorización. Costo de ventas = salidas por venta − devoluciones de clientes.',
          datos: filasK,
          dimensiones: [
            { key: 'mes', label: 'Fecha', tipo: 'fecha', campo: 'fecha' }, { key: 'producto', label: 'Producto' },
            { key: 'lote', label: 'Lote' },
            { key: 'tipo', label: 'Tipo de movimiento' }, { key: 'categoria', label: 'Categoría' },
            { key: 'comprobante', label: 'N° comprobante' }, { key: 'contacto', label: 'Contacto' }
          ],
          medidas: [
            { key: 'entrada', label: 'Entradas (cant.)', agg: 'sum', formato: 'qty' },
            { key: 'salida', label: 'Salidas (cant.)', agg: 'sum', formato: 'qty' },
            { key: 'neto', label: 'Neto (cant.)', agg: 'sum', formato: 'qty', semaforo: true },
            { key: 'valor_entrada', label: 'Valor entradas', agg: 'sum', formato: 'money' },
            { key: 'valor_salida', label: 'Valor salidas', agg: 'sum', formato: 'money' },
            { key: 'neto_valor', label: 'Neto (valor)', agg: 'sum', formato: 'money', semaforo: true },
            // Ponderado por kg: Σ(costo × kg) / Σ kg. Con 1 lote = su costo exacto.
            { key: 'costo_unitario', label: 'Costo unitario', agg: 'ratio', formato: 'money4',
              num: f => f._costo_u * f._cant_mov, den: f => f._cant_mov, requiereDim: 'lote' },
            { key: 'costo_venta', label: 'Costo de ventas', agg: 'sum', formato: 'money' }
          ],
          filtros: [
            { key: 'buscar', label: 'Buscar', tipo: 'texto', campos: ['producto', 'sku', 'lote', 'comprobante', 'contacto'], placeholder: 'Producto, SKU, lote, comprobante o contacto...' },
            { key: 'rango', label: 'Fecha', tipo: 'rango', campo: 'fecha' },
            { key: 'tipo', label: 'Tipo de movimiento', tipo: 'multi', opciones: clases }
          ],
          agruparPorDefecto: ['mes'], orden: { key: '_etiqueta', dir: 'asc' },
          medidasPorDefecto: ['entrada', 'salida', 'valor_entrada', 'valor_salida', 'neto_valor', 'costo_venta'],
          // 1 lote → ciclo de vida (columnas + stock + agotamiento); 2+ lotes → mapa de calor
          visual: (filtrados, ctx) => visualKardexLote(filtrados, filasK, ctx)
        })
      }

      if (panelId === 'repi-rotacion') {
        // Rotación: compara lo que salió en el período contra el stock actual.
        // Un índice bajo con mucho stock = capital inmovilizado.
        // Solo cuenta como "salida" la venta real (tipo_movimiento='salida');
        // un traslado_interno no saca nada de la empresa, solo cambia de zona
        // — contarlo aquí inflaba "Salidas históricas" y podía marcar como
        // "con rotación" un producto que en realidad nunca se vendió.
        const salidaPorProducto = {}
        filasK.filter(k => k.tipo === 'Venta').forEach(k => {
          salidaPorProducto[k.producto] = (salidaPorProducto[k.producto] || 0) + k.salida
        })
        const stockPorProducto = {}
        const valorPorProducto = {}
        const ultimaSalida = {}
        filasLotes.forEach(l => {
          stockPorProducto[l.producto] = (stockPorProducto[l.producto] || 0) + l.cantidad
          valorPorProducto[l.producto] = (valorPorProducto[l.producto] || 0) + l.valor
        })
        filasK.filter(k => k.tipo === 'Venta' && k.salida > 0).forEach(k => {
          if (!ultimaSalida[k.producto] || k.fecha > ultimaSalida[k.producto]) ultimaSalida[k.producto] = k.fecha
        })

        const hoy = new Date()
        const datos = Object.keys({ ...stockPorProducto, ...salidaPorProducto }).map(prod => {
          const stock = stockPorProducto[prod] || 0
          const salidas = salidaPorProducto[prod] || 0
          const ult = ultimaSalida[prod] || ''
          const diasSinVender = ult ? Math.floor((hoy - new Date(ult + 'T00:00:00')) / 86400000) : null
          return {
            producto: prod,
            estado: salidas === 0 ? '1 · Sin movimiento nunca'
                  : diasSinVender > 180 ? '2 · Más de 180 días sin salir'
                  : diasSinVender > 90  ? '3 · 90-180 días sin salir'
                  : '4 · Con rotación',
            ultima_salida: ult || '(nunca)',
            stock, salidas,
            valor_inmovilizado: salidas === 0 ? (valorPorProducto[prod] || 0) : 0,
            valor: valorPorProducto[prod] || 0,
            rotacion: stock > 0 ? parseFloat((salidas / stock).toFixed(2)) : 0
          }
        })

        crearReporte('repi-rotacion', {
          id: 'repi-rotacion',
          titulo: 'Rotación y stock sin movimiento',
          descripcion: 'Detecta capital inmovilizado: productos con stock que no salen hace mucho, o que nunca han salido.',
          datos,
          dimensiones: [{ key: 'estado', label: 'Estado de rotación' }, { key: 'producto', label: 'Producto' }],
          medidas: [
            { key: 'stock', label: 'Stock actual', agg: 'sum', formato: 'qty' },
            { key: 'salidas', label: 'Salidas históricas', agg: 'sum', formato: 'qty' },
            { key: 'valor', label: 'Valor en stock', agg: 'sum', formato: 'money' },
            { key: 'valor_inmovilizado', label: 'Valor inmovilizado', agg: 'sum', formato: 'money' },
            { key: 'rotacion', label: 'Índice rotación', agg: 'avg', formato: 'money' }
          ],
          filtros: [
            { key: 'producto', label: 'Producto', tipo: 'texto', campos: ['producto'], placeholder: 'Buscar...' },
            { key: 'estado', label: 'Estado', tipo: 'select', opciones: ['1 · Sin movimiento nunca', '2 · Más de 180 días sin salir', '3 · 90-180 días sin salir', '4 · Con rotación'] }
          ],
          agruparPorDefecto: ['estado'], orden: { key: '_etiqueta', dir: 'asc' },
          medidasPorDefecto: ['stock', 'salidas', 'valor'],
          kpis: (f) => {
            const muertos = f.filter(x => x.estado.startsWith('1') || x.estado.startsWith('2'))
            return [
              { label: 'Valor en stock', valor: f.reduce((s, x) => s + x.valor, 0), formato: 'money' },
              { label: 'Productos sin rotar', valor: muertos.length, formato: 'int', color: 'var(--color-danger)' },
              { label: 'Capital inmovilizado', valor: muertos.reduce((s, x) => s + x.valor, 0), formato: 'money', color: 'var(--color-danger)' }
            ]
          }
        })
      }
    }
  } catch (e) {
    console.error('construirReporteInv:', e)
    _repInvListos[panelId] = false
    if (cont) cont.innerHTML = `<div class="card"><p class="reporte-vacio">No se pudo construir el reporte: ${e.message}</p></div>`
  }
}
