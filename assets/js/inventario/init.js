// ============================================================================
// inventario/init.js — parte de inventario.js (reorganizado 2026-09-25, sin cambios de lógica)
// Mapa completo de funciones: Claude outputs/glosario_funciones_erp.md
// ============================================================================
import { getCurrentUser } from '../auth-supabase.js'
import { registrarColumnas } from '../col-menu.js'
import { showToast } from '../helpers.js'
import { initModuleNavDropdowns, initSubtabs } from '../main.js'
import { renderConfiguracionTab, aplicarPreferenciasVista } from '../config-modulo.js'
import { convertirVarios } from '../buscador-select.js'
import { renderAlmacenes } from './almacenes-zonas.js'
import { renderCategorias, renderMarcas } from './catalogos.js'
import { cargarCategoriasSelect, cargarMarcasSelect, cargarProductosSelect } from './formularios.js'
import { renderHistorialMovimientos } from './historial-movimientos.js'
import { renderKardex } from './kardex.js'
import { renderLotes } from './lotes.js'
import './partidas.js'  // tabla legacy `partidas` — ya no tiene tab (ver Familias y atributos › Partidas)
import { renderFamilias } from './familias.js'
import { renderProductos } from './productos.js'
import { construirReporteInv, renderReportePartidas } from './reportes.js'

registrarColumnas('lotes', [
  { key: 'numero_lote',    label: 'Lote' },
  { key: 'partida',        label: 'Partida' },
  { key: 'codigo',         label: 'Código' },
  { key: 'producto',       label: 'Producto' },
  { key: 'stock',          label: 'Stock' },
  { key: 'unidad',         label: 'Unidad' },
  { key: 'unidades',       label: 'N° Unidades' },
  { key: 'peso_unidad',    label: 'Peso/Unidad' },
  { key: 'costo_unit',     label: 'Costo Unit.' },
  { key: 'costo_total',    label: 'Costo Total Lote' },
  { key: 'costo_cif',      label: 'Costo CIF / factura' },
  { key: 'costo_real',     label: 'Costo real (editable)' },
  { key: 'vencimiento',    label: 'Vencimiento' },
  { key: 'dias_restantes', label: 'Días Restantes' }
])

registrarColumnas('resumen-stock', [
  { key: 'sku',             label: 'SKU' },
  { key: 'producto',        label: 'Producto' },
  { key: 'categoria',       label: 'Categoría' },
  { key: 'lotes',           label: 'N° Lote' },
  { key: 'stock_total',     label: 'Stock Total' },
  { key: 'total_unidades',  label: 'Total Unidades' },
  { key: 'costo_promedio',  label: 'Costo Promedio Unit.' },
  { key: 'valor_total',     label: 'Valor Total Inventario' },
  { key: 'stock_critico',   label: 'Stock Crítico' },
  { key: 'acciones',        label: 'Acciones' }
])

registrarColumnas('stock-zonas', [
  { key: 'sel',       label: 'Seleccionar' },
  { key: 'codigo',    label: 'Código' },
  { key: 'producto',  label: 'Producto' },
  { key: 'categoria', label: 'Categoría' },
  { key: 'lote',      label: 'N° Lote' },
  { key: 'marca',     label: 'Marca' },
  { key: 'zona',      label: 'Almacén — Zona' },
  { key: 'cantidad',  label: 'Cantidad' },
  { key: 'unidades',  label: 'Unidades' },
  { key: 'peso_unidad', label: 'Peso/Unidad' },
  { key: 'moneda',    label: 'Moneda' },
  { key: 'tc',        label: 'T.C.' },
  { key: 'costo_orig', label: 'Costo Orig.' },
  { key: 'costo',     label: 'Costo S/.' },
  { key: 'acciones',  label: 'Acciones' }
])

registrarColumnas('stock-partida', [
  { key: 'partida',       label: 'Partida' },
  { key: 'sku',           label: 'SKU' },
  { key: 'producto',      label: 'Producto' },
  { key: 'lotes',         label: 'N° Lotes' },
  { key: 'cantidad',      label: 'Cantidad Total' },
  { key: 'costo_prom',    label: 'Costo Promedio' },
  { key: 'valor',         label: 'Valor Total' },
  { key: 'zonas',         label: 'Zona(s)' }
])

registrarColumnas('historial-movimientos', [
  { key: 'fecha',        label: 'Fecha' },
  { key: 'documento',    label: 'N° Documento' },
  { key: 'docReferencia', label: 'Doc. Referencia' },
  { key: 'contacto',     label: 'Contacto' },
  { key: 'producto',     label: 'Producto' },
  { key: 'lote',        label: 'Lote' },
  { key: 'tipo',        label: 'Tipo' },
  { key: 'desde',       label: 'Desde' },
  { key: 'a',           label: 'A' },
  { key: 'cantidad',    label: 'Cantidad' },
  { key: 'unidades',    label: 'Unidades' }
])

document.addEventListener('DOMContentLoaded', async () => {
  try {
    const user = await getCurrentUser()
    const userDisplay = document.getElementById('userDisplay')
    if (userDisplay && user) {
      userDisplay.textContent = user.nombre || user.email
    }

    const loteUsuario = document.getElementById('loteUsuario')
    if (loteUsuario && user) {
      loteUsuario.value = user.email
    }

    aplicarPreferenciasVista('inventario')
    initTabsInventario()
    // Selects con muchos productos/lotes: buscador con filtrado en vivo.
    convertirVarios([
      { id: 'loteProducto',    placeholder: 'Escribe el producto o SKU...', sinResultados: 'Sin productos' },
      { id: 'partProducto',    placeholder: 'Escribe el producto o SKU...', sinResultados: 'Sin productos' },
      { id: 'tdProducto',      placeholder: 'Escribe el producto...',       sinResultados: 'Sin productos en esa zona' },
      { id: 'tdLote',          placeholder: 'Escribe el N° de lote...',     sinResultados: 'Sin lotes disponibles' },
      { id: 'tiZonaOrigen',    placeholder: 'Escribe el almacén o zona...', sinResultados: 'Sin zonas' },
      { id: 'tiZonaDestino',   placeholder: 'Escribe el almacén o zona...', sinResultados: 'Sin zonas' },
      { id: 'ajusteKardexItem', placeholder: 'Escribe el producto o lote...', sinResultados: 'Sin lotes' },
      { id: 'zonaAlmacen',     placeholder: 'Escribe el almacén...',        sinResultados: 'Sin almacenes' }
    ])
    await cargarProductosSelect()
    await cargarCategoriasSelect()
    await cargarMarcasSelect()
    await renderProductos()
  } catch (error) {
    console.error('Error en DOMContentLoaded:', error)
    showToast('Error al cargar el módulo de inventario', 'danger')
  }
})

function initTabsInventario() {
  const btns = document.querySelectorAll('#inventarioTabs .tab-btn')
  const contents = document.querySelectorAll('.tab-content')

  btns.forEach(btn => {
    btn.addEventListener('click', async () => {
      const tab = btn.getAttribute('data-tab')

      btns.forEach(b => b.classList.remove('active'))
      contents.forEach(c => c.classList.remove('active'))

      btn.classList.add('active')
      const tabContent = document.getElementById(`tab-${tab}`)
      if (tabContent) {
        tabContent.classList.add('active')
      }

      if (tab === 'productos')  await renderProductos()
      if (tab === 'lotes')      await renderLotes()
      if (tab === 'resumen') await window.renderResumenStockUnificado()
      if (tab === 'atributos')  await _renderSubtabAtributos()
      if (tab === 'kardex')     await renderKardex()
      if (tab === 'historial')  await renderHistorialMovimientos()
      if (tab === 'reportes-gerenciales') {
        const activo = document.querySelector('#inv-subtabs-reportes .subtab.active')?.getAttribute('data-sub') || 'repi-valorizacion'
        await construirReporteInv(activo)
      }
      if (tab === 'configuracion') {
        // Configuración tiene sus propios subtabs (General / Almacenes) —
        // se carga el que esté activo en ese momento.
        const activo = document.querySelector('#inv-subtabs-config .subtab.active')?.getAttribute('data-sub') || 'cfg-general'
        if (activo === 'cfg-general') renderConfiguracionTab('inventario', 'cfg-general')
        if (activo === 'cfg-almacenes') await renderAlmacenes()
      }
    })
  })

  initSubtabs('#inv-subtabs-reportes', (panel) => construirReporteInv(panel))

  // Familias y atributos (2026-10-05): Familias · Categorías · Marcas ·
  // Partidas en subtabs internos de un solo botón del menú Catálogo.
  initSubtabs('#inv-subtabs-atributos', () => _renderSubtabAtributos())

  // Resumen Stock: ya no son 2 subtabs con 2 tablas — es una sola tabla-vista
  // con un botón de agrupamiento (window.setModoResumenStock), ver bloque
  // "RESUMEN DE STOCK" más abajo.

  // Subtabs de Configuración: General (parámetros del módulo) y Almacenes
  // (estructura física de almacenes/zonas — antes vivía como tab aparte del
  // menú principal, se movió aquí por ser configuración, no operación diaria).
  initSubtabs('#inv-subtabs-config', async (panel) => {
    if (panel === 'cfg-general') renderConfiguracionTab('inventario', 'cfg-general')
    if (panel === 'cfg-almacenes') await renderAlmacenes()
  })

  // Convierte la fila de tabs (ahora agrupada en dropdowns dentro del header)
  // en un submenú desplegable estilo Odoo. No reemplaza el listener de arriba,
  // solo agrega abrir/cerrar y resaltar el grupo activo.
  initModuleNavDropdowns('#inventarioTabs')
}

async function _renderSubtabAtributos() {
  const activo = document.querySelector('#inv-subtabs-atributos .subtab.active')?.getAttribute('data-sub') || 'atr-familias'
  if (activo === 'atr-familias')   await renderFamilias()
  if (activo === 'atr-categorias') await renderCategorias()
  if (activo === 'atr-marcas')     await renderMarcas()
  if (activo === 'atr-partidas')   await renderReportePartidas()
}
