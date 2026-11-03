import { $, $$, esc, num, money, arrancar, getCatalogo, imagenes, semLabel, agregar, toast, supabase, wspUrl } from './crm-core.js'

const { emp, staff } = await arrancar('cat')
const app = $('#app')
const id = Number(new URLSearchParams(location.search).get('id'))
const cat = emp ? await getCatalogo(emp.id, true) : []
const p = cat.find(x => x.id === id)
if (!p) {
  app.innerHTML = `<div class="vacio"><h2>Producto no encontrado</h2><a class="btn" href="index.html?emp=${emp?.id || ''}">Volver al catálogo</a></div>`
} else {
  const fotos = imagenes(p.fotos), hermanos = cat.filter(x => x.grupo === p.grupo && x.nombre === p.nombre)
  const caja = Number(p.peso_caja_kg) || 0
  app.innerHTML = `
    <p class="muted" style="margin-top:20px"><a href="index.html?emp=${emp.id}">Catálogo</a> / ${esc(p.grupo)}</p>
    <div class="prod">
      <div><div class="gal__main" id="gm">${fotos[0] ? `<img src="${esc(fotos[0])}" alt="${esc(p.nombre)}">` : '<div class="sinfoto">Sin foto</div>'}</div>
        ${fotos.length > 1 ? `<div class="gal__th">${fotos.map((f, i) => `<button class="${i ? '' : 'on'}" data-f="${esc(f)}"><img src="${esc(f)}" alt=""></button>`).join('')}</div>` : ''}</div>
      <div>
        <span class="sem sem--${p.semaforo}" style="position:static">${semLabel(p.semaforo)}</span>
        <h1 style="margin:10px 0 4px">${esc(p.nombre)}</h1>
        <div class="col">${p.color_nombre ? `<i style="background:${esc(p.color_hex || '#ccc')}"></i>${esc(p.color_nombre)} ${p.color_no ? '· ' + esc(p.color_no) : ''}` : ''}</div>
        ${hermanos.length > 1 ? `<div class="swatches">${hermanos.map(h => `<a class="swatch ${h.id === p.id ? 'on' : ''}" title="${esc(h.color_nombre || '')}" style="background:${esc(h.color_hex || '#ccc')}" href="producto.html?emp=${emp.id}&id=${h.id}"></a>`).join('')}</div>` : ''}
        <div style="margin:14px 0">${p.precio ? `<span class="precio-lg">${money(p.precio, p.moneda)}</span> <span class="muted">por kg · ${p.igv_incluido ? 'IGV incluido' : '+ IGV'}</span>` : '<span class="muted">Precio a consultar</span>'}</div>
        ${p.descripcion ? `<p>${esc(p.descripcion)}</p>` : ''}
        <div class="specs">
          ${caja ? `<div class="spec"><b>Peso por caja</b>${num(caja)} kg</div>` : ''}
          ${p.conos_por_caja ? `<div class="spec"><b>Conos por caja</b>${p.conos_por_caja}</div>` : ''}
          ${p.aplicaciones ? `<div class="spec" style="grid-column:1/-1"><b>Aplicaciones</b>${esc(p.aplicaciones)}</div>` : ''}
        </div>
        ${p.semaforo === 'agotado' ? `<p class="msg msg--e">Agotado por ahora. Consúltanos reposición.</p>
          ${wspUrl(emp, `Hola, consulto reposición de ${p.nombre} ${p.color_nombre || ''}`) ? `<a class="btn btn--wsp" target="_blank" rel="noopener" href="${wspUrl(emp, `Hola, consulto reposición de ${p.nombre} ${p.color_nombre || ''}`)}">Consultar por WhatsApp</a>` : ''}` : `
        <div class="qrow">
          <div><label>Kilos</label><div class="qty"><button data-s="-1">−</button><input id="kg" type="number" min="1" step="0.5" value="${caja || 10}"><button data-s="1">+</button></div></div>
          ${caja ? `<div><label>Cajas</label><div class="qty"><button data-c="-1">−</button><input id="cj" type="number" min="1" step="1" value="1"><button data-c="1">+</button></div></div>` : ''}
        </div>
        <div class="muted" id="sub"></div>
        <p style="margin-top:14px"><button class="btn btn--lg" id="add">Agregar a mi cotización</button></p>`}
        <div id="lotes"></div>
      </div>
    </div>`

  $$('.gal__th button').forEach(b => b.onclick = () => {
    $('#gm').innerHTML = `<img src="${esc(b.dataset.f)}" alt="">`
    $$('.gal__th button').forEach(x => x.classList.toggle('on', x === b))
  })
  const kg = $('#kg'), cj = $('#cj')
  if (kg) {
    const sub = () => { const k = Number(kg.value) || 0; $('#sub').textContent = p.precio ? `Subtotal estimado: ${money(k * p.precio, p.moneda)} (la cotización final la valida la empresa)` : '' }
    kg.oninput = () => { if (cj && caja) cj.value = Math.max(1, Math.round(kg.value / caja)); sub() }
    if (cj) cj.oninput = () => { kg.value = (cj.value * caja).toFixed(2).replace(/\.00$/, ''); sub() }
    $$('[data-s]').forEach(b => b.onclick = () => { kg.value = Math.max(0.5, Number(kg.value) + Number(b.dataset.s) * (caja || 1)); kg.oninput() })
    $$('[data-c]').forEach(b => b.onclick = () => { cj.value = Math.max(1, Number(cj.value) + Number(b.dataset.c)); cj.oninput() })
    sub()
    $('#add').onclick = () => {
      const k = Number(kg.value); if (!(k > 0)) return toast('Ingresa una cantidad válida')
      agregar(emp.id, p, k); toast('Agregado a tu cotización')
      setTimeout(() => location.href = `cotizar.html?emp=${emp.id}`, 600)
    }
  }
  if (staff?.esStaff) {
    const { data, error } = await supabase.rpc('crm_stock_lotes', { p_item_id: p.item_id, p_empresa: emp.id })
    const tot = (data || []).reduce((a, r) => a + Number(r.kg || 0), 0)
    $('#lotes').innerHTML = `<div class="panel-box" style="margin-top:20px"><h3>Stock real (solo interno)</h3>
      ${error ? `<p class="msg msg--e">${esc(error.message)}</p>` : `<table class="t"><thead><tr><th>Lote</th><th>Almacén / ubicación</th><th class="num">Kg</th><th class="num">Unid.</th></tr></thead><tbody>
      ${(data || []).map(r => `<tr><td>${esc(r.numero_lote)}</td><td>${esc(r.almacen)} · ${esc(r.ubicacion)}</td><td class="num">${num(r.kg)}</td><td class="num">${num(r.unidades, 0)}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">Sin stock</td></tr>'}
      </tbody><tfoot><tr><th colspan="2">Total</th><th class="num">${num(tot)}</th><th></th></tr></tfoot></table>`}</div>`
  }
}
