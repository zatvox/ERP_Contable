// ============================================================================
// ventas/clientes.js — Tab Clientes (2026-10-07: usa la tabla y el modal
// ÚNICOS de contactos: shared/contactos-tabla.js + shared/contacto-modal.js).
// Versión anterior (tabla/modal propios): clientes.backup_2026-10-07_contactos.js
// ============================================================================
import { getCustomers, getContactsByType } from '../supabase-data.js'
import { montarTablaContactos } from '../shared/contactos-tabla.js'
import { abrirModalContacto } from '../shared/contacto-modal.js'
import { _poblarSelectClientes, _poblarSelectVendedores } from './helpers.js'
import { S } from './state.js'

export async function renderClientes() {
  await montarTablaContactos('card-contactos-clientes', { tabla: 'contactos-clientes', rol: 'cliente', titulo: 'Clientes' })
}

// Compatibilidad: Nueva Venta, PK y Cotización siguen llamando a estas funciones
window.abrirFormularioCliente = () => abrirModalContacto({ roles: ['cliente'] })
window.editarCliente = (id) => abrirModalContacto({ id })

// Alta/edición de cualquier contacto → listas en memoria y selects de Ventas al día
window.addEventListener('contacto-guardado', async () => {
  try {
    const [clientes, vendedores] = await Promise.all([getCustomers(), getContactsByType('vendedor')])
    S._clientes = clientes
    S._vendedores = vendedores
    _poblarSelectClientes()
    _poblarSelectVendedores()
  } catch (e) { console.warn('contacto-guardado (ventas):', e) }
})
