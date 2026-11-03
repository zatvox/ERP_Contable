# Landing de Genko — cómo está conectado

**Ubicación:** `erp_v2/landing/` — dentro del repo `zatvox/ERP_Contable`, que es lo que GitHub Pages publica.

## URLs una vez publicado
| Página | URL |
|---|---|
| Landing | `.../ERP_Contable/landing/` |
| Login del ERP | `.../ERP_Contable/login.html` |
| Catálogo CRM | `.../ERP_Contable/crm/` |

## Enlaces del landing (todos probados)
- "Ingresar" → `../login.html`
- Módulo CRM "Ver el catálogo" → `../crm/index.html`
- "Hablar con un asesor" → WhatsApp con mensaje predefinido
- Favicon → `../assets/img/genko-favicon.svg`

## Dónde se cambian las cosas
| Qué | Archivo | Línea |
|---|---|---|
| Número de WhatsApp | `assets/genko.js` | `WSP_NUMERO` |
| Mensaje de WhatsApp | `assets/genko.js` | `WSP_MENSAJE` |
| Silueta del geco (logo + caminante) | `assets/geco.png` | es una máscara: el PNG debe ser **negro con fondo transparente** |

## PENDIENTE DE DECISIÓN — qué ve quien entra a la raíz
Hoy `index.html` de la raíz redirige a `login.html`.

Para que la raíz muestre el landing, cambiar en `erp_v2/index.html`:
```html
<meta http-equiv="refresh" content="0;url=login.html">
```
por:
```html
<meta http-equiv="refresh" content="0;url=landing/">
```
