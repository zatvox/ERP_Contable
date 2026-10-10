// ============================================================================
// compras/proveedores.js — Tab Proveedores (2026-10-07: usa la tabla y el modal
// ÚNICOS de contactos: shared/contactos-tabla.js + shared/contacto-modal.js).
// Versión anterior (tabla/modal propios): proveedores.backup_2026-10-07_contactos.js
// ============================================================================
import { montarTablaContactos } from '../shared/contactos-tabla.js'
import { abrirModalContacto } from '../shared/contacto-modal.js'
import { cargarProveedoresSelect } from './formularios.js'

export async function renderProveedores() {
  await montarTablaContactos('card-contactos-proveedores', { tabla: 'contactos-proveedores', rol: 'proveedor', titulo: 'Proveedores' })
}

// Compatibilidad: buscadores de OC / Nueva Compra y formularios
window.abrirModalNuevoProveedor = () => abrirModalContacto({ roles: ['proveedor'] })
window.abrirFormularioProveedor = window.abrirModalNuevoProveedor
window.editarProveedor = (id) => abrirModalContacto({ id })

window.addEventListener('contacto-guardado', () => { cargarProveedoresSelect().catch(e => console.warn('contacto-guardado (compras):', e)) })
