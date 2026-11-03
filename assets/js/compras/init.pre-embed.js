// ============================================================================
// compras/init.js — parte de compras.js (reorganizado 2026-09-25, sin cambios de lógica)
// Mapa completo de funciones: Claude outputs/glosario_funciones_erp.md
// ============================================================================
import { getCurrentUser } from '../auth-supabase.js'
import { getTipoDocumentosMap } from '../supabase-data.js'
import { getTCCompra, attachConsultaDocumento, textoAvisoTC } from '../sunat-api.js'
import { showToast } from '../helpers.js'
import { initModuleNavDropdowns, initSubtabs } from '../main.js'
import { renderConfiguracionTab, aplicarPreferenciasVista } from '../config-modulo.js'
import { _activarBuscadoresCompras } from './buscadores.js'
import { renderCompras } from './compras-lista.js'
import { cargarCuentasGastoSelect, cargarItemsSelect, cargarProveedoresSelect } from './formularios.js'
import { renderGuias } from './guias-ingreso-lista.js'
import { renderOrdenes } from './ordenes-compra.js'
import { renderProveedores } from './proveedores.js'
import { construirReporteCompras } from './reportes.js'

// ─── Tipo de Cambio automático ────────────────────────────────────────────────

/**
 * Consulta el TC COMPRA SBS para la fecha indicada y llena #ccTipoCambio.
 * Usar en compras/importaciones en USD (Art. 61° LIR).
 */
export async function _autoFetchTCCompra(fecha = null, permitirApi = false) {
  const campo = document.getElementById('ccTipoCambio')
  const aviso = document.getElementById('ccTCAviso')
  if (!campo) return

  if (aviso) aviso.textContent = permitirApi ? 'Consultando TC SUNAT...' : 'Buscando TC guardado...'
  const result = await getTCCompra(fecha, { permitirApi })

  if (result.error) {
    if (aviso) aviso.textContent = `⚠️ ${result.error} — ingresa TC manualmente`
    if (!result.sinCache) showToast('No se pudo obtener el TC de SUNAT. Ingresa el tipo de cambio manualmente.', 'warning')
    return
  }

  campo.value = result.tc.toFixed(3)
  if (aviso) aviso.textContent = textoAvisoTC(result, 'compra')
}

/** Botón "🔎 Consultar" del modal Confirmar Compra (antes llamaba al de Nueva Compra por error). */
window.consultarTCConfirmarCompra = async function () {
  const btn = document.getElementById('btnAutoTCCompra')
  if (btn) btn.disabled = true
  try { await _autoFetchTCCompra(document.getElementById('ccFecha')?.value || null, true) }
  finally { if (btn) btn.disabled = false }
}

// 2026-09-25 (reorganización): aquí había una 1ª definición de
// window.autoFetchTCCompra (modal de confirmar OC) que la 2ª definición
// (sección MONEDA Y TIPO DE CAMBIO) SIEMPRE pisaba al cargar el archivo →
// nunca se ejecutaba. Se quitó para que el orden de carga de los submódulos
// no pueda cambiar cuál gana.

// ─────────────────────────────────────────────────────────────────────────────

// ============================================================================
// INICIALIZACIÓN
// ============================================================================

document.addEventListener('DOMContentLoaded', async () => {
  try {
    const user = await getCurrentUser()
    const userDisplay = document.getElementById('userDisplay')
    if (userDisplay && user) {
      userDisplay.textContent = user.nombre || user.email
    }

    aplicarPreferenciasVista('compras')
    initTabsCompras()
    // Lazy loading: solo se carga el tab visible (Compras, por defecto ahora
    // que Órdenes de Compra está en standby) + selects de los modales.
    // El tab Proveedores se carga recién al hacer click.
    await Promise.all([
      getTipoDocumentosMap(),   // precarga cache para getNombreTipoDocumentoSync
      cargarProveedoresSelect(),
      cargarItemsSelect(),
      cargarCuentasGastoSelect(),
      renderCompras()           // solo el tab activo por defecto
    ])

    // Se convierten DESPUÉS de cargar las opciones, para que el buscador ya
    // tenga la lista completa desde el primer foco.
    _activarBuscadoresCompras()

    // Botón "Consultar" en el modal Nuevo Proveedor (RUC o DNI, según Tipo Documento)
    // Consultar RUC/DNI: ahora vive en el modal único (shared/contacto-modal.js)
  } catch (error) {
    console.error('Error en DOMContentLoaded:', error)
    showToast('Error al cargar el módulo de compras', 'danger')
  }
})

// ============================================================================
// TABS
// ============================================================================

function initTabsCompras() {
  const btns = document.querySelectorAll('#comprasTabs .tab-btn')
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

      if (tab === 'ordenes') await renderOrdenes()
      if (tab === 'compras') await renderCompras()
      if (tab === 'guias') await renderGuias()
      if (tab === 'proveedores') await renderProveedores()
      if (tab === 'configuracion') renderConfiguracionTab('compras', 'tab-configuracion')
      if (tab === 'reportes') {
        const activo = document.querySelector('#com-subtabs-reportes .subtab.active')?.getAttribute('data-sub') || 'repcm-evolucion'
        await construirReporteCompras(activo)
      }
    })
  })

  initSubtabs('#com-subtabs-reportes', (panel) => construirReporteCompras(panel))

  // Convierte la fila de tabs (agrupada en dropdowns dentro del header) en un
  // submenú desplegable estilo Odoo. No reemplaza el listener de arriba, solo
  // agrega abrir/cerrar y resaltar el grupo activo.
  initModuleNavDropdowns('#comprasTabs')
}
