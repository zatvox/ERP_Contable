// ============================================================================
// VENTAS.JS - Módulo Ventas (Versión Async/Await)
// ============================================================================

import { getCurrentUser } from './auth-supabase.js'
import { getSalesQuotes, getSalesQuoteById, addSalesQuote, updateSalesQuote, getCustomers, addContact, getLotes } from './supabase-data.js'
import { showToast } from './helpers.js'

document.addEventListener('DOMContentLoaded', async () => {
  try {
    const user = getCurrentUser()
    const userDisplay = document.getElementById('userDisplay')
    if (userDisplay && user) {
      userDisplay.textContent = user.nombre || user.username
    }

    initTabsVentas()
    await cargarClientesSelect()
    await cargarLotesSelectVenta()
    await renderCotizaciones()
    await renderClientes()
  } catch (error) {
    console.error('Error en DOMContentLoaded:', error)
    showToast('Error al cargar el módulo de ventas', 'danger')
  }
})

function initTabsVentas() {
  const btns = document.querySelectorAll('#ventasTabs .tab-btn')
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

      if (tab === 'cotizaciones') await renderCotizaciones()
      if (tab === 'clientes') await renderClientes()
    })
  })
}

// ============================================================================
// COTIZACIONES
// ============================================================================

async function renderCotizaciones() {
  try {
    const cotizaciones = await getSalesQuotes()
    const container = document.getElementById('tabla-cot')

    if (!container) return

    if (!cotizaciones || cotizaciones.length === 0) {
      container.innerHTML = '<p style="text-align: center; color: var(--text-secondary); padding: 20px;">Sin cotizaciones</p>'
      return
    }

    let html = `
      <table>
        <thead>
          <tr>
            <th>Número</th>
            <th>Cliente</th>
            <th>Moneda</th>
            <th>Total</th>
            <th>Usuario</th>
            <th>Estado</th>
            <th>Acciones</th>
          </tr>
        </thead>
        <tbody>
    `

    for (const cot of cotizaciones) {
      const cli = await window.getCustomerById(cot.customer_id)
      html += `
        <tr>
          <td><strong>${cot.numero || cot.id}</strong></td>
          <td>${cli?.name || '-'}</td>
          <td>${cot.currency || 'PEN'}</td>
          <td>${cot.currency || 'PEN'} ${(cot.total || 0).toFixed(2)}</td>
          <td>${cot.user || '-'}</td>
          <td><span class="badge badge-${cot.status || 'borrador'}">${cot.status || 'borrador'}</span></td>
          <td>
            <button class="btn btn-small btn-secondary" onclick="window.verCotizacion(${cot.id})">Ver</button>
            ${cot.status === 'borrador' ? `<button class="btn btn-small btn-primary" onclick="window.confirmarCotizacion(${cot.id})">Confirmar</button>` : ''}
          </td>
        </tr>
      `
    }

    html += '</tbody></table>'
    container.innerHTML = html
  } catch (error) {
    console.error('Error en renderCotizaciones:', error)
    showToast('Error al cargar las cotizaciones', 'danger')
  }
}

window.verCotizacion = async function (id) {
  try {
    const cot = await getSalesQuoteById(id)
    if (!cot) {
      showToast('Cotización no encontrada', 'warning')
      return
    }

    const cli = await window.getCustomerById(cot.customer_id)
    const lote = await getLotes().then(lotes => lotes.find(l => l.id === cot.lote_id))

    const mensaje = `
    COT #${cot.numero || cot.id}
    Cliente: ${cli?.name || '-'}
    Cantidad: ${cot.cantidad || 0}
    Precio Unit: ${cot.currency || 'PEN'} ${(cot.precio_unitario || 0).toFixed(2)}
    Subtotal: ${cot.currency || 'PEN'} ${(cot.subtotal || 0).toFixed(2)}
    IGV: ${cot.currency || 'PEN'} ${(cot.igv || 0).toFixed(2)}
    Total: ${cot.currency || 'PEN'} ${(cot.total || 0).toFixed(2)}
    Usuario: ${cot.user || '-'}
    Estado: ${cot.status || '-'}
    `

    alert(mensaje)
  } catch (error) {
    console.error('Error en verCotizacion:', error)
    showToast('Error al ver la cotización', 'danger')
  }
}

window.confirmarCotizacion = async function (id) {
  try {
    if (!confirm('¿Confirmar esta Cotización?')) return

    const user = getCurrentUser()
    if (!user) {
      showToast('Usuario no autenticado', 'danger')
      return
    }

    const cot = await getSalesQuoteById(id)
    if (!cot) {
      showToast('Cotización no encontrada', 'warning')
      return
    }

    await updateSalesQuote(id, { status: 'confirmado' })

    showToast('Cotización Confirmada', 'success')
    await renderCotizaciones()
  } catch (error) {
    console.error('Error en confirmarCotizacion:', error)
    showToast('Error al confirmar la cotización', 'danger')
  }
}

window.guardarCotizacion = async function () {
  try {
    const user = getCurrentUser()
    if (!user) {
      showToast('Usuario no autenticado', 'danger')
      return
    }

    const customerId = parseInt(document.getElementById('cotCliente')?.value || 0)
    const loteId = parseInt(document.getElementById('cotLote')?.value || 0)
    const cantidad = parseInt(document.getElementById('cotCantidad')?.value || 0)
    const igv = parseInt(document.getElementById('cotIGV')?.value || 0)
    const moneda = document.getElementById('cotMoneda')?.value || 'PEN'

    if (!customerId || !loteId || !cantidad) {
      showToast('Complete todos los campos', 'warning')
      return
    }

    const lote = await getLotes().then(lotes => lotes.find(l => l.id === loteId))
    if (!lote) {
      showToast('Lote no encontrado', 'warning')
      return
    }

    const precioUnitario = lote.costo_unitario || 0
    const subtotal = cantidad * precioUnitario
    const igvAmount = subtotal * (igv / 100)
    const total = subtotal + igvAmount

    const cot = {
      customer_id: customerId,
      lote_id: loteId,
      cantidad: cantidad,
      precio_unitario: precioUnitario,
      igv: igvAmount,
      subtotal: subtotal,
      total: total,
      currency: moneda,
      status: 'borrador',
      user: user.username,
      fecha: new Date().toISOString().split('T')[0]
    }

    await addSalesQuote(cot)
    showToast('Cotización creada', 'success')
    window.closeModal('modal-nueva-cot')
    await renderCotizaciones()
    const form = document.getElementById('formNewCot')
    if (form) form.reset()
  } catch (error) {
    console.error('Error en guardarCotizacion:', error)
    showToast('Error al crear la cotización', 'danger')
  }
}

// ============================================================================
// CLIENTES
// ============================================================================

async function renderClientes() {
  try {
    const clientes = await getCustomers()
    const container = document.getElementById('tabla-clientes')

    if (!container) return

    if (!clientes || clientes.length === 0) {
      container.innerHTML = '<p style="text-align: center; color: var(--text-secondary); padding: 20px;">Sin clientes</p>'
      return
    }

    let html = `
      <table>
        <thead>
          <tr>
            <th>Nombre</th>
            <th>RUC</th>
            <th>Email</th>
            <th>Teléfono</th>
            <th>Ciudad</th>
            <th>Moneda</th>
          </tr>
        </thead>
        <tbody>
    `

    clientes.forEach(c => {
      html += `
        <tr>
          <td>${c.name || '-'}</td>
          <td>${c.ruc || '-'}</td>
          <td>${c.email || '-'}</td>
          <td>${c.phone || '-'}</td>
          <td>${c.ciudad || '-'}</td>
          <td>${c.currency || '-'}</td>
        </tr>
      `
    })

    html += '</tbody></table>'
    container.innerHTML = html
  } catch (error) {
    console.error('Error en renderClientes:', error)
    showToast('Error al cargar los clientes', 'danger')
  }
}

window.guardarCliente = async function () {
  try {
    const user = getCurrentUser()
    if (!user) {
      showToast('Usuario no autenticado', 'danger')
      return
    }

    const cli = {
      name: document.getElementById('cliNombre')?.value || '',
      ruc: document.getElementById('cliRUC')?.value || '',
      email: document.getElementById('cliEmail')?.value || '',
      phone: document.getElementById('cliPhone')?.value || '',
      ciudad: document.getElementById('cliCiudad')?.value || '',
      currency: document.getElementById('cliMoneda')?.value || 'PEN',
      tipo_contacto: 'Cliente'
    }

    if (!cli.name || !cli.ruc) {
      showToast('Complete los campos requeridos', 'warning')
      return
    }

    await addCustomer(cli)
    showToast('Cliente guardado', 'success')
    window.closeModal('modal-nuevo-cliente')
    await renderClientes()
    await cargarClientesSelect()
    const form = document.getElementById('formNewCliente')
    if (form) form.reset()
  } catch (error) {
    console.error('Error en guardarCliente:', error)
    showToast('Error al guardar el cliente', 'danger')
  }
}

// ============================================================================
// SELECT LOADERS
// ============================================================================

async function cargarClientesSelect() {
  try {
    const clientes = await getCustomers()
    const select = document.getElementById('cotCliente')

    if (!select) return

    select.innerHTML = '<option value="">-- Selecciona Cliente --</option>'
    clientes.forEach(c => {
      select.innerHTML += `<option value="${c.id}">${c.name}</option>`
    })
  } catch (error) {
    console.error('Error en cargarClientesSelect:', error)
  }
}

async function cargarLotesSelectVenta() {
  try {
    const lotes = await getLotes()
    const select = document.getElementById('cotLote')

    if (!select) return

    select.innerHTML = '<option value="">-- Selecciona Lote --</option>'
    lotes.forEach(lote => {
      select.innerHTML += `<option value="${lote.id}">${lote.numero_lote}</option>`
    })
  } catch (error) {
    console.error('Error en cargarLotesSelectVenta:', error)
  }
}

/*
function verCotizacion(id) {
  const cot = getSalesQuoteById(id);
  const cli = getCustomerById(cot.customerId);
  const lote = getLoteById(cot.loteId);
  const prod = getProductById(lote.productId);

  alert(`
COT #${cot.numero}
Cliente: ${cli.name}
Producto: ${prod.name}
Lote: ${lote.numeroLote}
Cantidad: ${cot.cantidad}
Precio Venta: ${cot.currency} ${cot.precioUnitario}
Costo Unit: ${cot.currency} ${lote.costoUnitario}
Subtotal: ${cot.currency} ${cot.subtotal}
IGV: ${cot.currency} ${cot.igv}
Total: ${cot.currency} ${cot.total}
Usuario: ${cot.user}
Estado: ${cot.status}
  `);
}

function confirmarCotizacion(id) {
  if (!confirm('¿Confirmar cotización? Se generará el asiento contable.')) return;

  const cot = getSalesQuoteById(id);
  const cli = getCustomerById(cot.customerId);
  const lote = getLoteById(cot.loteId);

  // Reducir stock
  lote.stock -= cot.cantidad;

  // Asiento 1: CxC + Ventas + IGV
  const lineas1 = [
    {
      accountId: 3,
      tipo: 'debe',
      cuenta: '121201',
      nombre: 'CUENTAS POR COBRAR - FACTURAS (M.N.)',
      importe: cot.total
    },
    {
      accountId: 15,
      tipo: 'haber',
      cuenta: '701111',
      nombre: 'VENTAS DE PRODUCTOS - M.N.',
      importe: cot.subtotal
    }
  ];

  if (cot.igv > 0) {
    lineas1.push({
      accountId: 13,
      tipo: 'haber',
      cuenta: '181111',
      nombre: 'IGV POR PAGAR EN VENTAS',
      importe: cot.igv
    });
  }

  addJournalEntry({
    fecha: new Date().toISOString().split('T')[0],
    descripcion: `Venta COT-${cot.numero} a ${cli.name}`,
    documentoReferencia: cot.numero,
    lineas: lineas1,
    totalDebe: cot.total,
    totalHaber: cot.total,
    user: getCurrentUser().username
  });

  // Asiento 2: Costo de Venta
  const costoCantidad = lote.costoUnitario * cot.cantidad;
  const lineas2 = [
    {
      accountId: 17,
      tipo: 'debe',
      cuenta: '601111',
      nombre: 'COSTO DE VENTAS - M.N.',
      importe: costoCantidad
    },
    {
      accountId: 7,
      tipo: 'haber',
      cuenta: '141111',
      nombre: 'INVENTARIO - MERCANCÍA IMPORTADA',
      importe: costoCantidad
    }
  ];

  addJournalEntry({
    fecha: new Date().toISOString().split('T')[0],
    descripcion: `Costo Venta COT-${cot.numero}`,
    documentoReferencia: cot.numero,
    lineas: lineas2,
    totalDebe: costoCantidad,
    totalHaber: costoCantidad,
    user: getCurrentUser().username
  });

  updateSalesQuote(id, { status: 'confirmado' });
  const data = getCurrentData();
  updateData(data);

  showToast('Cotización Confirmada - Asientos generados', 'success');
  renderCotizaciones();
}

function guardarCotizacion() {
  const user = getCurrentUser();
  const customerId = parseInt(document.getElementById('cotCliente').value);
  const loteId = parseInt(document.getElementById('cotLote').value);
  const cantidad = parseInt(document.getElementById('cotCantidad').value);
  const precio = parseFloat(document.getElementById('cotPrecio').value);
  const igv = parseInt(document.getElementById('cotIGV').value);

  if (!customerId || !loteId || !cantidad || !precio) {
    showToast('Complete todos los campos', 'warning');
    return;
  }

  const lote = getLoteById(loteId);
  if (lote.stock < cantidad) {
    showToast('Stock insuficiente', 'danger');
    return;
  }

  const subtotal = cantidad * precio;
  const igvAmount = subtotal * (igv / 100);
  const total = subtotal + igvAmount;

  const cli = getCustomerById(customerId);
  const cot = {
    customerId: customerId,
    loteId: loteId,
    cantidad: cantidad,
    precioUnitario: precio,
    igv: igvAmount,
    subtotal: subtotal,
    total: total,
    currency: cli.currency,
    status: 'borrador',
    user: user.username,
    fecha: new Date().toISOString().split('T')[0]
  };

  addSalesQuote(cot);
  showToast('Cotización creada', 'success');
  closeModal('modal-nueva-cot');
  renderCotizaciones();
  document.getElementById('formNewCot').reset();
}

// ============================================================================
// CLIENTES
// ============================================================================

function renderClientes() {
  const clientes = getCustomers();
  const container = document.getElementById('tabla-clientes');

  let html = `
    <table>
      <thead>
        <tr>
          <th>Nombre</th>
          <th>RUC</th>
          <th>Email</th>
          <th>Teléfono</th>
          <th>Moneda</th>
        </tr>
      </thead>
      <tbody>
  `;

  clientes.forEach(c => {
    html += `
      <tr>
        <td>${c.name}</td>
        <td>${c.ruc}</td>
        <td>${c.email}</td>
        <td>${c.phone}</td>
        <td>${c.currency}</td>
      </tr>
    `;
  });

  html += '</tbody></table>';
  container.innerHTML = html;
}

function guardarCliente() {
  const user = getCurrentUser();
  const data = getCurrentData();

  const cli = {
    name: document.getElementById('cliNombre').value,
    ruc: document.getElementById('cliRUC').value,
    email: document.getElementById('cliEmail').value,
    phone: document.getElementById('cliPhone').value,
    currency: document.getElementById('cliMoneda').value
  };

  if (!cli.name || !cli.ruc) {
    showToast('Complete campos requeridos', 'warning');
    return;
  }

  cli.id = Math.max(...data.customers.map(c => c.id), 0) + 1;
  data.customers.push(cli);
  updateData(data);

  showToast('Cliente creado', 'success');
  closeModal('modal-nuevo-cliente');
  renderClientes();
  cargarClientesSelect();
  document.getElementById('formNewCliente').reset();
}

// ============================================================================
// CARGAR SELECTS
// ============================================================================

function cargarClientesSelect() {
  const clientes = getCustomers();
  const select = document.getElementById('cotCliente');
  
  select.innerHTML = '<option value="">-- Selecciona --</option>';
  clientes.forEach(c => {
    select.innerHTML += `<option value="${c.id}">${c.name}</option>`;
  });
}

function cargarLotesSelectVenta() {
  const lotes = getLotes();
  const select = document.getElementById('cotLote');
  
  select.innerHTML = '<option value="">-- Selecciona --</option>';
  lotes.forEach(l => {
    const prod = getProductById(l.productId);
    select.innerHTML += `<option value="${l.id}">${prod.name} - ${l.numeroLote} (Stock: ${l.stock})</option>`;
  });
}*/
