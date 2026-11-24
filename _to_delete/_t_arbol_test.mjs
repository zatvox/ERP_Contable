import { renderTablaReporte, construirArbol, filasVisibles, matrizCruzada } from '../assets/js/shared/arbol-reporte.js'
import { analizar } from '../assets/js/shared/observaciones-reporte.js'
const datos=[]; const cl=['A','B','C','','D']; 
for(let i=0;i<60;i++) datos.push({fecha:`2026-${String(1+i%3).padStart(2,'0')}-10`, cliente:cl[i%5], mon:i%2?'USD':'PEN', total:(i%7===0?-50:100+i), costo:80})
const calc=(fs,ms)=>Object.fromEntries(ms.map(m=>[m.key, fs.reduce((s,f)=>s+(m.calc?m.calc(f):f[m.key]||0),0)]))
const MES=['Ene','Feb','Mar']; 
const res=(f,k)=>k==='fecha'? MES[+f.fecha.slice(5,7)-1]+' 2026' : (f[k]===''?'(sin dato)':String(f[k]))
const vo=v=>{const m=/^([A-Za-z]{3})\s(\d{4})$/.exec(v); return m? +m[2]*100+MES.indexOf(m[1])+1 : v}
const estado={agrupar:['fecha','cliente','mon'],ordenKey:null,ordenDir:'desc',nivelAbierto:1,exc:{},pesa:false,vista:'arbol'}
const ctx={config:{dimensiones:[{key:'fecha',label:'Fecha',tipo:'fecha'},{key:'cliente',label:'Cliente'},{key:'mon',label:'Moneda'}]},estado,filtrados:datos,medidas:[{key:'total',label:'Total',formato:'money',semaforo:true}],resolver:res,calc,fmt:(v)=>v.toFixed(2),valorOrd:vo,labelDim:k=>k,colorMedida:()=>'',csv:()=>{}}
let r=renderTablaReporte(ctx,()=>'plana'); console.log('arbol rows', (r.html.match(/<tr class="rp-nodo/g)||[]).length, 'alertas', /rp-alerta/.test(r.html), 'delta', /rp-d /.test(r.html))
estado.pesa=true; r=renderTablaReporte(ctx,()=>'plana'); console.log('80/20 resto', /rp-resto/.test(r.html))
estado.vista='cruzada'; estado.agrupar=['cliente','fecha']; r=renderTablaReporte(ctx,()=>'plana'); console.log('cruzada', /rp-x/.test(r.html), matrizCruzada(ctx).colKeys)
console.log(analizar({medida:{label:'Total'},total:5000,series:[{label:'a',v:100},{label:'b',v:300},{label:'c',v:0},{label:'d',v:1},{label:'e',v:5}],ranking:[{k:'X',v:900},{k:'Y',v:50},{k:'Z',v:-20}],dimLabel:'Cliente',medidas:[{label:'Pendiente',valor:2000}],registros:10,sinDato:3,campoSinDato:'Cliente'}).map(o=>o.nivel+': '+o.titulo))
estado.vista='arbol'; estado.agrupar=['fecha','cliente']; const a=construirArbol(ctx); console.log(a.raiz.map(n=>[n.label,n.vals.total,n.prev&&n.prev.label]))
r=renderTablaReporte(ctx,()=>'p'); console.log(/rp-d /.test(r.html), (r.html.match(/rp-d [a-z]+/g)||[]).length)
