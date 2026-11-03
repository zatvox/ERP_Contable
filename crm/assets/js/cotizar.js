import { $, $$, esc, num, money, arrancar, carrito, guardarCarrito, totales, supabase, wspUrl, getCatalogo } from './crm-core.js'

const { emp } = await arrancar('cot')
const app = $('#app')
if (!emp) { app.innerHTML = '<div class="vacio">Catálogo no disponible.</div>' } else {
  let paso = 1, lineas = carrito(emp.id), resultado = null
  const mon = emp.moneda_precio || 'PEN'
  const save = () => guardarCarrito(emp.id, lineas)

  const pasos = () => `<div class="steps">${['1 · Productos', '2 · Tus datos', '3 · Confirmación'].map((t, i) =>
    `<div class="step ${paso === i + 1 ? 'on' : paso > i + 1 ? 'done' : ''}">${t}</div>`).join('')}</div>`

  function vistaCarrito() {
    if (!lineas.length) return pasos() + `<div class="vacio"><h2>Tu cotización está vacía</h2><a class="btn" href="index.html?emp=${emp.id}">Ver catálogo</a></div>`
    const t = totales(lineas, emp.igv_incluido)
    return pasos() + `<div class="panel-box"><table class="t"><thead><tr><th></th><th>Producto</th><th class="num">Kg</th><th class="num">Precio/kg</th><th class="num">Importe</th><th></th></tr></thead><tbody>
      ${lineas.map((l, i) => `<tr><td>${l.foto ? `<img class="thumb" src="${esc(l.foto)}" alt="">` : ''}</td>
        <td><b>${esc(l.nombre)}</b><br><span class="muted">${esc(l.color)}${l.peso_caja ? ` · caja ${num(l.peso_caja)} kg` : ''}</span></td>
        <td class="num"><input class="in" style="width:90px;text-align:right" type="number" min="0.5" step="0.5" data-i="${i}" value="${l.cantidad_kg}"></td>
        <td class="num">${l.precio ? money(l.precio, mon) : '—'}</td><td class="num">${l.precio ? money(l.cantidad_kg * l.precio, mon) : '—'}</td>
        <td><button class="btn btn--o btn--sm" data-x="${i}">Quitar</button></td></tr>`).join('')}</tbody></table>
      ${t.total ? `<div class="tot" style="max-width:320px;margin-left:auto;margin-top:14px"><div><span>Subtotal</span><span>${money(t.subtotal, mon)}</span></div><div><span>IGV 18%</span><span>${money(t.igv, mon)}</span></div><div class="g"><span>Total estimado</span><span>${money(t.total, mon)}</span></div></div>` : ''}
      <p class="muted">Precios referenciales; la empresa confirma disponibilidad y precio final.</p>
      <p style="display:flex;gap:10px;justify-content:space-between;flex-wrap:wrap"><a class="btn btn--o" href="index.html?emp=${emp.id}">Seguir comprando</a><button class="btn btn--lg" id="sig">Continuar</button></p></div>`
  }

  function vistaDatos() {
    return pasos() + `<form class="panel-box form" id="f" novalidate>
      <div class="fg"><label>RUC / DNI *</label><input name="ruc" inputmode="numeric" maxlength="11" required></div>
      <div class="fg"><label>Razón social / Nombre *</label><input name="razon_social" required></div>
      <div class="fg"><label>Persona de contacto *</label><input name="nombre_contacto" required></div>
      <div class="fg"><label>Teléfono / WhatsApp *</label><input name="telefono" inputmode="tel" required></div>
      <div class="fg"><label>Correo *</label><input name="email" type="email" required></div>
      <div class="fg"><label>Dirección fiscal</label><input name="direccion_fiscal"></div>
      <div class="fg"><label>Dirección de entrega</label><input name="dir_entrega"></div>
      <div class="fg"><label>Distrito</label><input name="distrito_entrega"></div>
      <div class="fg full"><label>Referencia</label><input name="referencia_entrega"></div>
      <div class="fg full"><label>Notas</label><textarea name="notas" rows="3"></textarea></div>
      <div class="full" id="err"></div>
      <div class="full" style="display:flex;justify-content:space-between"><button type="button" class="btn btn--o" id="atras">Atrás</button><button class="btn btn--lg" id="env">Enviar cotización</button></div></form>`
  }

  function vistaOk() {
    const cuentas = Array.isArray(emp.cuentas_bancarias) ? emp.cuentas_bancarias : []
    const w = wspUrl(emp, `Hola, envié la cotización ${resultado.numero}`)
    return pasos() + `<div class="panel-box"><h2>¡Cotización ${esc(resultado.numero)} enviada!</h2>
      <p>Total referencial: <b>${money(resultado.total, mon)}</b>. Te contactaremos para confirmar.</p>
      ${cuentas.length ? `<h3>Cuentas para el pago</h3><div class="cuentas">${cuentas.map(c => `<div class="cuenta"><b>${esc(c.banco)}</b> <span class="muted">${esc(c.tipo || '')}</span><code>${esc(c.numero || '')}</code>${c.cci ? `<span class="muted">CCI ${esc(c.cci)}</span>` : ''}<br><span class="muted">${esc(c.titular || '')}</span></div>`).join('')}</div>` : ''}
      <h3>Adjuntar comprobante de pago (opcional)</h3>
      <label class="drop"><input id="comp" type="file" accept="image/*,application/pdf" hidden><span id="dropt">Toca para subir foto o PDF (máx. 5 MB)</span></label><div id="cmsg"></div>
      <p style="margin-top:16px;display:flex;gap:10px;flex-wrap:wrap">${w ? `<a class="btn btn--wsp" target="_blank" rel="noopener" href="${w}">Avisar por WhatsApp</a>` : ''}<a class="btn btn--o" href="index.html?emp=${emp.id}">Volver al catálogo</a></p></div>`
  }

  function render() {
    app.innerHTML = paso === 1 ? vistaCarrito() : paso === 2 ? vistaDatos() : vistaOk()
    if (paso === 1) {
      if ($('#sig')) $('#sig').onclick = () => { paso = 2; render() }
      $$('[data-i]').forEach(i => i.onchange = () => { const v = Number(i.value); if (v > 0) { lineas[i.dataset.i].cantidad_kg = v; save() } render() })
      $$('[data-x]').forEach(b => b.onclick = () => { lineas.splice(Number(b.dataset.x), 1); save(); render() })
    }
    if (paso === 2) {
      const f = $('#f')
      $('#atras').onclick = () => { paso = 1; render() }
      f.ruc.onblur = async () => {
        const r = f.ruc.value.trim()
        if (!/^(\d{8}|\d{11})$/.test(r)) return
        const { data } = await supabase.rpc('crm_buscar_ruc', { p_ruc: r })
        const rs = Array.isArray(data) ? data[0]?.razon_social : data?.razon_social
        if (rs && !f.razon_social.value) f.razon_social.value = rs
      }
      f.onsubmit = async e => {
        e.preventDefault()
        const v = Object.fromEntries(new FormData(f)), err = $('#err')
        const falta = ['ruc', 'razon_social', 'nombre_contacto', 'telefono', 'email'].find(k => !String(v[k] || '').trim())
        if (falta) { err.innerHTML = '<div class="msg msg--e">Completa los campos obligatorios (*).</div>'; return }
        if (!/^(\d{8}|\d{11})$/.test(v.ruc.trim())) { err.innerHTML = '<div class="msg msg--e">RUC (11 dígitos) o DNI (8).</div>'; return }
        $('#env').disabled = true; $('#env').textContent = 'Enviando…'
        const { data, error } = await supabase.rpc('crm_crear_cotizacion', {
          p_cliente: { ruc: v.ruc.trim(), razon_social: v.razon_social, nombre_contacto: v.nombre_contacto, email: v.email, telefono: v.telefono, direccion_fiscal: v.direccion_fiscal },
          p_entrega: { dir_entrega: v.dir_entrega, distrito_entrega: v.distrito_entrega, referencia_entrega: v.referencia_entrega },
          p_lineas: lineas.map(l => ({ catalogo_id: l.catalogo_id, cantidad_kg: l.cantidad_kg })),
          p_notas: v.notas || null, p_empresa: emp.id })
        if (error) { $('#env').disabled = false; $('#env').textContent = 'Enviar cotización'; err.innerHTML = `<div class="msg msg--e">${esc(error.message)}</div>`; return }
        resultado = data; lineas = []; save(); paso = 3; render()
      }
    }
    if (paso === 3 && $('#comp')) {
      $('#comp').onchange = async e => {
        const file = e.target.files[0]; if (!file) return
        if (file.size > 5 * 1024 * 1024) { $('#cmsg').innerHTML = '<div class="msg msg--e">Máximo 5 MB.</div>'; return }
        const nombre = file.name.replace(/[^\w.\-]+/g, '_'), path = `comprobantes/${resultado.id}/${Date.now()}-${nombre}`
        $('#dropt').textContent = 'Subiendo…'
        const up = await supabase.storage.from('crm-comprobantes').upload(path, file, { contentType: file.type, upsert: false })
        if (up.error) { $('#dropt').textContent = 'Toca para reintentar'; $('#cmsg').innerHTML = `<div class="msg msg--e">${esc(up.error.message)}</div>`; return }
        const { error } = await supabase.rpc('crm_adjuntar_comprobante', { p_cotizacion: resultado.id, p_path: path, p_nombre: file.name })
        $('#dropt').textContent = file.name
        $('#cmsg').innerHTML = error ? `<div class="msg msg--e">${esc(error.message)}</div>` : '<div class="msg msg--ok">Comprobante recibido. ¡Gracias!</div>'
      }
    }
  }
  const cat = await getCatalogo(emp.id, true)
  lineas = lineas.filter(l => cat.some(c => c.id === l.catalogo_id)).map(l => { const c = cat.find(x => x.id === l.catalogo_id); return { ...l, precio: c.precio || 0, nombre: c.nombre } })
  save(); render()
}
