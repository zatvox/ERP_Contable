# JHIRO ERP v2 — Guía de Configuración Completa

## Índice
1. [Nuevo Proyecto Supabase](#1-nuevo-proyecto-supabase)
2. [Ejecutar SQL de Migración](#2-ejecutar-sql-de-migración)
3. [APIs.pe — Consulta RUC/DNI](#3-apispe--consulta-rucdni)
4. [NUBEFACT — CPE Facturas y Boletas Electrónicas](#4-nubefact--cpe-facturas-y-boletas-electrónicas)
5. [Configurar config.js](#5-configurar-configjs)
6. [Verificación Final](#6-verificación-final)
7. [Archivos a Eliminar (Legacy)](#7-archivos-a-eliminar-legacy)

---

## 1. Nuevo Proyecto Supabase

Este ERP usa un **proyecto Supabase individual por empresa**. Cada empresa tiene su propia base de datos aislada.

### Pasos:

1. Ir a [https://supabase.com](https://supabase.com) e iniciar sesión
2. Click en **"New Project"**
3. Elegir organización y poner:
   - **Name:** `jhiro-erp-[nombre-empresa]` (ej: `jhiro-erp-empresa-abc`)
   - **Database Password:** Genera uno seguro y guárdalo
   - **Region:** `South America (São Paulo)` — más cercano a Perú
4. Esperar ~2 minutos a que el proyecto se inicialice
5. Ir a **Settings → API** y copiar:
   - **Project URL** → `https://xxxxx.supabase.co`
   - **anon public key** → clave larga que empieza con `eyJ...`

---

## 2. Ejecutar SQL de Migración

En el proyecto Supabase nuevo, ir a **SQL Editor** y ejecutar los archivos **en este orden exacto**:

### Orden de ejecución:

```
1. assets/sql/01_schema.sql       → Crea todas las tablas del ERP
2. assets/sql/02_functions.sql    → Crea funciones y triggers (partida doble, kardex, etc.)
3. assets/sql/03_rls_policies.sql → Habilita Row Level Security en todas las tablas
4. assets/sql/04_seed_data.sql    → Datos iniciales (PCGE, tipo documentos, diarios)
```

### Cómo ejecutar cada archivo:
1. Abrir **SQL Editor** en el dashboard de Supabase
2. Click en **"New query"**
3. Pegar el contenido completo del archivo SQL
4. Click en **"Run"** (o Ctrl+Enter)
5. Verificar que no haya errores en la consola inferior
6. Repetir para el siguiente archivo

### Verificar que todo esté bien:
```sql
-- Ejecutar en SQL Editor para ver las tablas creadas:
SELECT table_name FROM information_schema.tables 
WHERE table_schema = 'public' 
ORDER BY table_name;

-- Verificar políticas RLS:
SELECT tablename, COUNT(*) as politicas 
FROM pg_policies WHERE schemaname = 'public' 
GROUP BY tablename ORDER BY tablename;

-- Verificar funciones:
SELECT routine_name FROM information_schema.routines 
WHERE routine_schema = 'public' AND routine_type = 'FUNCTION'
ORDER BY routine_name;
```

---

## 3. APIs.pe — Consulta RUC/DNI

**APIs.pe** es el servicio para consultar datos de RUC (empresas) y DNI (personas) en tiempo real desde SUNAT/RENIEC. Es la opción más económica y confiable del mercado peruano.

### Precios (referencial, verificar en su web):
- Plan Básico: desde S/ 15/mes por 1,000 consultas
- Plan Business: desde S/ 60/mes por 10,000 consultas

### Registro:

1. Ir a [https://apis.pe](https://apis.pe)
2. Click en **"Registrarse"**
3. Completar el formulario con tu email
4. Verificar el email
5. Ir a **"Mi cuenta" → "Tokens"**
6. Click en **"Nuevo Token"**
7. Copiar el token generado (empieza con `Bearer ...`)
   - **IMPORTANTE:** Solo se muestra una vez. Guárdalo de inmediato.

### Probar el token (desde terminal o Postman):
```bash
curl -H "Authorization: Bearer TU_TOKEN_AQUI" \
     "https://api.apis.pe/v2/ruc?numero=20100070970"
```

Debe devolver un JSON con los datos del RUC de SUNAT.

---

## 4. NUBEFACT — CPE Facturas y Boletas Electrónicas

**NUBEFACT** es el OSE (Operador de Servicios Electrónicos) más usado en Perú para la emisión de comprobantes electrónicos (CPE). Es el recomendado para este ERP.

### Por qué NUBEFACT:
- Certificado como OSE por SUNAT
- API REST simple (no SOAP)
- Soporte 24/7
- Firma digital incluida en el servicio
- Ambiente de pruebas gratuito

### Precios (verificar en su web):
- Desde S/ 29/mes para hasta 300 comprobantes
- Planes más grandes disponibles

### Registro:

1. Ir a [https://nubefact.com](https://nubefact.com)
2. Click en **"Registrarse"** o **"Prueba gratis"**
3. Completar datos de la empresa:
   - RUC de la empresa
   - Razón social exacta (como aparece en SUNAT)
   - Representante legal
4. Esperar validación (puede tomar 24-48 horas para producción)
5. Para empezar inmediatamente, usar el **ambiente DEMO** (no envía a SUNAT)

### Obtener el Token API:

1. Ingresar al panel de NUBEFACT
2. Ir a **"Configuración" → "Token API"** (o "API Key")
3. Copiar el token completo

### Configurar las series de comprobantes:

Antes de emitir, debes registrar tus series ante SUNAT:

1. Ingresar a **SOL SUNAT** (clave SOL de la empresa)
2. Ir a: **Empresas → Mis Declaraciones y Pagos → Serie de Comprobante Electrónico**
3. Registrar las series que usarás (ej: F001, B001)
4. Informar las series a NUBEFACT en su panel de configuración

### Diferencia Demo vs Producción:

| Parámetro | Demo | Producción |
|-----------|------|------------|
| `AMBIENTE` | `'demo'` | `'produccion'` |
| Envío a SUNAT | ❌ No | ✅ Sí |
| Validez tributaria | ❌ No | ✅ Sí |
| Token | El mismo | El mismo |

---

## 5. Configurar config.js

Una vez obtenidos los tokens, editar el archivo `assets/js/config.js`:

```javascript
export const SUPABASE_CONFIG = {
  // Reemplazar con los datos de tu nuevo proyecto Supabase
  URL:      'https://TU-PROYECTO.supabase.co',
  ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...'   // tu anon key
}

export const SUNAT_CONFIG = {
  // NUBEFACT — para facturas y boletas electrónicas
  NUBEFACT_TOKEN: 'tu-token-de-nubefact-aqui',
  NUBEFACT_RUC:   '20XXXXXXXXX',    // RUC de tu empresa (11 dígitos)

  // Cambiar a 'produccion' cuando estés listo para SUNAT real
  AMBIENTE:       'demo',

  // APIs.pe — para autocomplete de RUC/DNI
  APIS_PE_TOKEN:  'tu-token-de-apis-pe-aqui'
}
```

### ⚠️ Seguridad importante:
- **NO subir config.js a GitHub público.** Agregar a `.gitignore`
- La `ANON_KEY` de Supabase es segura para el frontend — no es la `service_role` key
- Los tokens de NUBEFACT y APIs.pe son de uso exclusivo del servidor; en producción considerar un proxy backend

---

## 6. Verificación Final

### Checklist antes de usar en producción:

- [ ] Proyecto Supabase nuevo creado
- [ ] Los 4 archivos SQL ejecutados sin errores
- [ ] `config.js` actualizado con URL y ANON_KEY del proyecto nuevo
- [ ] Token NUBEFACT obtenido y configurado
- [ ] Token APIs.pe obtenido y configurado
- [ ] Probar login con usuario admin (contraseña por defecto: `admin123` — **cambiar inmediatamente**)
- [ ] Probar emisión de CPE en ambiente `demo` antes de pasar a `produccion`
- [ ] Cambiar contraseña del usuario admin desde la interfaz

### Cambiar contraseña del admin:

1. Iniciar sesión con `admin` / `admin123`
2. Ir a Configuración (si está disponible) o ejecutar directamente en SQL Editor:

```sql
-- Cambiar contraseña admin (requiere librería pgcrypto)
UPDATE public.users 
SET password_hash = crypt('NUEVA_CONTRASEÑA_SEGURA', gen_salt('bf'))
WHERE email = 'admin@empresa.com';
```

---

## 7. Archivos a Eliminar (Legacy)

Los siguientes archivos son del sistema anterior y pueden eliminarse una vez que la migración al nuevo Supabase esté completa:

### Archivos SQL obsoletos:
```
assets/sql/schema public tables.txt          ← esquema antiguo (reemplazado por 01_schema.sql)
assets/sql/RLS settings and policies of public tables.txt  ← RLS antiguo (reemplazado por 03_rls_policies.sql)
assets/sql/erp-rls-migration.sql             ← migración anterior (ya no necesaria)
```

### Verificar antes de eliminar:
No eliminar ningún archivo de `assets/js/` ni `assets/css/` pues todos son necesarios.

---

## Resumen de Archivos del ERP

```
erp_v2/
├── dashboard.html          ← Panel principal con KPIs
├── inventario.html/js      ← Productos, lotes, kardex valorizado
├── compras.html/js         ← Órdenes de compra, registro compras (Formato 8.1)
├── ventas.html/js          ← Facturas, boletas + CPE NUBEFACT
├── contabilidad.html/js    ← Plan cuentas, libro diario, balance, asientos
├── cobranzas.html/js       ← CxC, cobros, CxP, pagos proveedores
├── bancos.html/js          ← Cuentas bancarias, movimientos, conciliación
├── costeo-importaciones.html/js  ← DAM, gastos de importación
├── assets/
│   ├── js/
│   │   ├── config.js         ← ⚠️ CONFIGURAR AQUÍ tus credenciales
│   │   ├── supabase-client.js  ← Helper de conexión Supabase
│   │   ├── supabase-data.js    ← Capa de datos / domain functions
│   │   ├── sunat-api.js        ← NUBEFACT CPE + APIs.pe RUC/DNI
│   │   ├── auth-supabase.js    ← Autenticación
│   │   ├── helpers.js          ← Utilidades UI (showToast, etc.)
│   │   └── main.js             ← Inicialización + openModal/closeModal
│   ├── css/styles.css          ← Estilos del ERP
│   └── sql/
│       ├── 01_schema.sql       ← EJECUTAR PRIMERO
│       ├── 02_functions.sql    ← EJECUTAR SEGUNDO
│       ├── 03_rls_policies.sql ← EJECUTAR TERCERO
│       └── 04_seed_data.sql    ← EJECUTAR CUARTO
└── SETUP.md                ← Esta guía
```
