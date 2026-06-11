# Capa `shared/` — Guía para desarrolladores

Código transversal compartido entre las vistas de RAICE (rector, admin, docente, superadmin, portal-acudiente).

Objetivo: que cualquier constante, utilidad, regla de negocio o acceso a datos viva en **un solo lugar** y no duplicado en cada HTML.

---

## 1. Cómo funciona (patrón `window.RAICE`)

Cada módulo es un **IIFE** (función autoejecutada) que registra sus exports en el objeto global `window.RAICE`:

```js
(function(R) {
  R.miFuncion = function() { ... };
})(window.RAICE = window.RAICE || {});
```

Los HTML cargan los módulos como `<script src>` **regulares** (no `type="module"`) en el `<head>`, ANTES del script principal:

```html
<script src="/shared/constants/index.js"></script>
<script src="/shared/utils/index.js"></script>
<script src="/shared/data/apiClient.js"></script>
<script src="/shared/data/repositories.js"></script>
<script src="/shared/domain/index.js"></script>
```

Y al inicio del script principal se desestructura lo que se necesita:

```js
<script>
  var { DAYS_OF_WEEK, CASE_STATUS_LABELS } = window.RAICE;
  var { escapeHtml, showToast, logout } = window.RAICE;
  var { createApiClient } = window.RAICE;
  // ...
```

### ⚠️ Por qué NO usar `type="module"`

Se intentó con `import/export` ES y **rompió la app**. Los `<script type="module">` se difieren (defer) y se ejecutan al final del parsing, PERO los scripts secundarios regulares (PWA, Supabase Realtime) se ejecutan antes e intentaban usar funciones que el module aún no había definido → `X is not a function`.

El patrón IIFE + `window.RAICE` carga todo de forma síncrona y en orden. **No volver a `type="module"`.**

---

## 2. Estructura

```
shared/
├── constants/index.js       Constantes puras (días, etiquetas, colores, pills)
├── utils/
│   ├── index.js             Utilidades (escapeHtml, logout, showToast, checkAuth,
│   │                        avatarColor, formatDate, deriveProfileData, etc.)
│   ├── printObservador.js   Impresión del observador del estudiante
│   └── pwa.js               Banners PWA (update / offline)
├── data/
│   ├── apiClient.js         createApiClient() — cliente HTTP con auth + sede filter
│   ├── realtime.js          initRealtime() — setup Supabase parametrizado
│   └── repositories.js      Funciones de acceso a datos (fetchX, createX, ...)
└── domain/index.js          Reglas de negocio puras (gradeLbl, classifyRisk, ...)
```

### Regla de dependencia (AGENTS.md §3.1)
- `domain` y `utils` NO dependen de nada (funciones puras).
- `data` puede usar `domain`/`utils`.
- Ningún módulo shared debe tener lógica acoplada al DOM de UNA vista específica.

---

## 3. Cómo agregar algo nuevo

### Una constante compartida
En `constants/index.js`:
```js
R.MI_CONSTANTE = { ... };
```
Luego en el HTML: `var { MI_CONSTANTE } = window.RAICE;`

### Una utilidad pura
En `utils/index.js`:
```js
R.miUtil = function(arg) { return ...; };
```

### Un acceso a datos (repository)
En `data/repositories.js`. Convención: `fetchX` para lectura, `createX/updateX/deleteX` para escritura. Recibe `apiFn` (el cliente) como primer parámetro:
```js
R.fetchMiEntidad = async function(apiFn) {
  var r = await apiFn('/raice/mi-entidad');
  return r.ok ? (r.data.items || []) : [];
};
```
Uso en el HTML: `const items = await window.RAICE.fetchMiEntidad(fetchAPI);`

### ¿Cuándo extraer a repository y cuándo no?
- **Sí** si el endpoint se usa en **2+ vistas** (elimina duplicación).
- **No** si solo lo usa **una vista** (sería indirección sin beneficio — dejarlo inline con `fetchAPI`).

---

## 4. Cliente API

```js
// rector (con filtro de sede, sin auto-logout)
var api = createApiClient({ getActiveSede: () => _activeSede });

// docente/superadmin (con auto-logout en 401)
var fetchAPI = createApiClient({ onUnauthorized: () => logout() });
```
`API_URL` está encapsulado dentro del módulo — no se define en los HTML.

---

## 5. Despliegue

El código fuente vive en `RAICE MIGRACION/`. Para desplegar se copia a la carpeta del repo Git (`RAICE 060626/`) y se hace push (Vercel auto-despliega).

⚠️ El archivo `pages/api/[...path].js` tiene corchetes en el nombre — usar `Copy-Item -LiteralPath`.

---

## 6. Estado de la migración

Etapas 1-4 de AGENTS.md §10 completadas (shared/constants, utils, data, domain).
Etapa 5 (presentation) pendiente — hacer incremental al desarrollar features, NO big-bang.
