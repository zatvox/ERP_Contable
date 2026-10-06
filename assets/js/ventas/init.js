// ============================================================================
// ventas/init.js — parte de ventas.js (reorganizado 2026-09-25, sin cambios de lógica)
// Mapa completo de funciones: Claude outputs/glosario_funciones_erp.md
// ============================================================================
import { S } from './state.js'
import { getCurrentUser } from '../auth-supabase.js'
import { getCustomers, getContactsByType, getLotes, getItems, getTipoDocumentosMap, getAlmacenes, getUbicaciones, getStockUbicaciones } from '../supabase-data.js'
import { attachRucAutocomplete, attachConsultaDocumento, getTCVenta, textoAvisoTC } from '../sunat-api.js'
import { showToast } from '../helpers.js'
import { initModuleNavDropdowns, initSubtabs } from '../main.js'
import { convertirEnBuscador } from '../buscador-select.js'
import { renderConfiguracionTab, aplicarPreferenciasVista } from '../config-modulo.js'
import { renderClientes } from './clientes.js'
import { renderCotizaciones } from './cotizaciones.js'
import { renderPacking } from './packing.js'
import { renderSeriesConfig } from './series-config.js'
import { renderGuiasDespachoVenta } from './guias-despacho-lista.js'
import { _poblarSelectClientes, _poblarSelectItems, _poblarSelectLotes, _poblarSelectVendedores } from './helpers.js'
import { construirReporteVentas } from './reportes.js'
import { renderVentas } from './ventas-lista.js'

// Escapa HTML al inyectar texto libre en innerHTML (nombres de cliente,
// motivos de anulación, mensajes de error, etc.) — mismo helper que ya
// existe en cada módulo del ERP (bancos.js, cobranzas.js, anulacion.js...);
// ventas.js lo llamaba en varios sitios pero nunca lo definía (bug real:
// ReferenceError: _esc is not defined al abrir "Editar Venta", entre otros).
export function _esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

// ============================================================================
// ESTADO LOCAL
// ============================================================================

/* _clientes: movido a ventas/state.js (S._clientes) */
/* _items: movido a ventas/state.js (S._items) */
/* _lotes: movido a ventas/state.js (S._lotes) */
/* _vendedores: movido a ventas/state.js (S._vendedores) */    // contacts con tipo_contacto incluye 'vendedor'
/* _ventaLineas: movido a ventas/state.js (S._ventaLineas) */   // líneas del modal de nueva venta
/* _ventaLineaEditIdx: movido a ventas/state.js (S._ventaLineaEditIdx) */   // índice en _ventaLineas que se está editando (null = agregando una nueva)
export let _almacenes = []
export let _zonas     = []     // ubicaciones (con almacen_id)
/* _stockUbic: movido a ventas/state.js (S._stockUbic) */     // stock_ubicaciones: cuánto de cada lote hay en cada zona
/* _lotesMap: movido a ventas/state.js (S._lotesMap) */     // lote.id -> lote (para resolver item_id/fecha_ingreso rápido)

// Tipo actualmente seleccionado en el modal unificado de Nueva Venta:
// 'mercaderia' | 'anticipo' — espejo de _tipoCompraActual en compras.js.
/* _tipoVentaActual: movido a ventas/state.js (S._tipoVentaActual) */
/* _anticiposVentaDisponiblesCache: movido a ventas/state.js (S._anticiposVentaDisponiblesCache) */

// ============================================================================
// INIT
// ============================================================================

document.addEventListener('DOMContentLoaded', async () => {
  try {
    const user = await getCurrentUser()
    const userDisplay = document.getElementById('userDisplay')
    if (userDisplay && user) userDisplay.textContent = user.nombre || user.email

    aplicarPreferenciasVista('ventas')
    initTabsVentas()
    await getTipoDocumentosMap()

    // Pre-carga en paralelo
    const [clientes, items, lotes, vendedores, almacenes, zonas, stockUbic] = await Promise.all([
      getCustomers(), getItems(), getLotes(), getContactsByType('vendedor'),
      getAlmacenes(), getUbicaciones(), getStockUbicaciones()
    ])
    S._clientes = clientes
    S._items    = items
    S._lotes    = lotes
    S._vendedores = vendedores
    _almacenes  = almacenes
    _zonas      = zonas
    S._stockUbic  = stockUbic
    S._lotesMap   = {}
    for (const lo of (S._lotes || [])) S._lotesMap[lo.id] = lo

    _poblarSelectClientes()
    _poblarSelectItems()
    _poblarSelectLotes()
    _poblarSelectVendedores()

    // Selects largos (cientos de opciones) convertidos en buscadores con
    // filtrado en vivo. El <select> original sigue existiendo oculto, así que
    // todo el código que lee .value o escucha 'change' funciona igual.
    convertirEnBuscador('ventaContactId', {
      placeholder: 'Escribe el nombre o RUC del cliente...',
      sinResultados: 'Ningún cliente coincide',
      alCrearNuevo: { label: 'Registrar cliente nuevo', onClick: () => window.abrirFormularioCliente?.() }
    })
    convertirEnBuscador('ventaItemSelect', { placeholder: 'Escribe el producto o SKU...', sinResultados: 'Sin productos con stock' })
    convertirEnBuscador('ventaVendedor', { placeholder: 'Sin asignar — escribe para buscar...', sinResultados: 'Sin vendedores' })
    convertirEnBuscador('cotCliente', { placeholder: 'Escribe el nombre del cliente...' })
    convertirEnBuscador('gdVenta', { placeholder: 'Escribe el N° de venta o cliente...', sinResultados: 'Sin ventas pendientes de despacho' })

    // Cotizaciones en standby: no se precarga (tab oculto en el HTML)
    await Promise.all([renderVentas(), renderClientes()])

    // Fecha de hoy en formulario venta
    const hoy = new Date().toISOString().split('T')[0]
    const fVenta = document.getElementById('ventaFechaEmision')
    if (fVenta) fVenta.value = hoy

    // RUC autocomplete en modal de nueva venta
    attachRucAutocomplete('ventaClienteRUC', 'ventaClienteNombre', 'ventaClienteDireccion', 'ventaClienteEstado')

    // Botón "Consultar" en el modal Nuevo Cliente (RUC o DNI, según Tipo Documento)
    attachConsultaDocumento({
      btnId: 'btnConsultarCliRUC', tipoDocId: 'cliTipoDocumento', numeroId: 'cliRUC',
      nombreId: 'cliNombre', direccionId: 'cliDireccion', distritoId: 'cliDistrito', paisId: 'cliPais',
      sunatSectionId: 'cliDatosSunat', estadoId: 'cliEstadoSunat', condicionId: 'cliCondicionSunat',
      buenContribuyenteId: 'cliBuenContribuyenteSunat', agenteRetencionId: 'cliSujetoRetencion',
      agenteRetencionBadgeId: 'cliAgenteRetencionSunat'
    })

    // TC automático (SBS/APIs.pe) DESACTIVADO temporalmente: el endpoint no
    // responde en este entorno (ERR_SSL_PROTOCOL_ERROR). El campo de tipo de
    // cambio queda 100% editable a mano y no se auto-consulta en cada cambio
    // de moneda/fecha. Se reactivará cuando se integre la API propia del
    // usuario. El botón "↻ Auto" (autoFetchTCVenta) sigue disponible por si
    // se quiere probar manualmente.
    // const selMoneda  = document.getElementById('ventaMoneda')
    // const inputFecha = document.getElementById('ventaFechaEmision')
    // if (selMoneda) selMoneda.addEventListener('change', () => _actualizarTCVenta())
    // if (inputFecha) inputFecha.addEventListener('change', () => _actualizarTCVenta())
  } catch (error) {
    console.error('DOMContentLoaded ventas:', error)
    showToast('Error al cargar el módulo de ventas', 'danger')
  }
})

// ─── Tipo de Cambio automático ────────────────────────────────────────────────

/**
 * Consulta el TC VENTA SBS para la fecha del formulario y lo llena.
 * Se omite si la moneda es PEN (TC = 1).
 */
async function _actualizarTCVenta() {
  const moneda = document.getElementById('ventaMoneda')?.value
  const campo  = document.getElementById('ventaTipoCambio')
  const aviso  = document.getElementById('ventaTCAviso')
  const badge  = document.getElementById('ventaTCTipo')
  if (!campo) return

  if (moneda !== 'USD') {
    campo.value = '1.000'
    if (aviso) aviso.textContent = ''
    return
  }

  const fecha = document.getElementById('ventaFechaEmision')?.value || null
  if (aviso) aviso.textContent = 'Consultando TC SUNAT...'

  // Botón "Consultar": caché tipos_cambio → si no está, Decolecta (1 crédito)
  const result = await getTCVenta(fecha, { permitirApi: true })
  if (result.error) {
    if (aviso) aviso.textContent = `⚠️ ${result.error} — ingresa TC manualmente`
    showToast(`No se pudo obtener el TC: ${result.error}`, 'warning')
    return
  }

  campo.value = result.tc.toFixed(3)
  if (badge) { badge.textContent = 'VENTA SUNAT'; badge.style.color = 'var(--color-info)' }
  if (aviso) aviso.textContent = textoAvisoTC(result, 'venta')
}

/** Botón "🔎 Consultar" del T.C. en el formulario de venta */
window.autoFetchTCVenta = async function () {
  const btn = document.getElementById('btnAutoTC')
  if (btn) btn.disabled = true
  await _actualizarTCVenta()
  if (btn) btn.disabled = false
}

// ─────────────────────────────────────────────────────────────────────────────

function initTabsVentas() {
  const btns     = document.querySelectorAll('#ventasTabs .tab-btn')
  const contents = document.querySelectorAll('.tab-content')
  btns.forEach(btn => {
    btn.addEventListener('click', async () => {
      const tab = btn.getAttribute('data-tab')
      btns.forEach(b => b.classList.remove('active'))
      contents.forEach(c => c.classList.remove('active'))
      btn.classList.add('active')
      const tabContent = document.getElementById(`tab-${tab}`)
      if (tabContent) tabContent.classList.add('active')

      if (tab === 'ventas')       await renderVentas()
      if (tab === 'guias-despacho') await renderGuiasDespachoVenta()
      if (tab === 'cotizaciones') await renderCotizaciones()
      if (tab === 'packing')      await renderPacking(true)
      if (tab === 'clientes')     await renderClientes()
      if (tab === 'configuracion') { renderConfiguracionTab('ventas', 'tab-configuracion'); await renderSeriesConfig('tab-configuracion') }
      if (tab === 'reportes') {
        const activo = document.querySelector('#ven-subtabs-reportes .subtab.active')?.getAttribute('data-sub') || 'repv-evolucion'
        await construirReporteVentas(activo)
      }
    })
  })

  initSubtabs('#ven-subtabs-reportes', (panel) => construirReporteVentas(panel))

  // Convierte la fila de tabs (agrupada en dropdowns dentro del header) en un
  // submenú desplegable estilo Odoo. No reemplaza el listener de arriba, solo
  // agrega abrir/cerrar y resaltar el grupo activo.
  initModuleNavDropdowns('#ventasTabs')
}
