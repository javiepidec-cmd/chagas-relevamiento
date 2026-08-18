# chagas-relevamiento

> PWA para relevamiento entomológico de viviendas en operativos de Chagas —
> Ministerio de Salud Pública de Corrientes.

Aplicación web instalable que corre en el celular de los operarios de campo.
Permite capturar viviendas con GPS + datos entomológicos completos **funcionando
sin conexión**, y sincroniza automáticamente contra Google Sheets cuando vuelve
la red.

Reemplaza a la app genérica `pwa-captura-puntos` y se especializa en un solo
tipo de operativo: **captura de vinchucas y análisis de viviendas para vigilancia
de Chagas**.

- **URL pública:** https://javiepidec-cmd.github.io/chagas-relevamiento/
- **Repositorio:** `javiepidec-cmd/chagas-relevamiento`

---

## Qué hace

Para cada vivienda relevada, el operario captura en el celular:

1. **Ubicación GPS** — colocada en el mapa o tomada del GPS actual, con detección
   automática de departamento y municipio contra los polígonos de Corrientes.
2. **Persona responsable de la vivienda** — apellido, nombres y DNI (opcional).
3. **Estado de la vivienda** (Evaluada, Cerrada, etc — desde `CEREBRO`).
4. **Evaluación entomológica** — conteos de T. infestans (intra/peridomicilio,
   adultos/ninfas), otras especies, insecticida aplicado.
5. **Habitantes y características constructivas** — rangos etarios, techo y pared
   colonizables.
6. **Animales domiciliarios** — cantidad y estructuras.
7. **Captura entomológica parasitológica** — insectos capturados e infección
   natural por T. cruzi (ID±/PD±).

Cada visita queda como una fila en la hoja `BD` del Google Sheet. Volver a
la misma vivienda en otra fecha genera una fila nueva (snapshot temporal, no
sobrescribe).

---

## Stack técnico

- **Frontend:** HTML/JS vanilla + [Leaflet.js](https://leafletjs.com/) (mapa) +
  [Turf.js](https://turfjs.org/) (detección point-in-polygon) + IndexedDB
  (cola local) + Service Worker (cache offline).
- **Backend:** Google Apps Script como Web App, con Google Sheets como base
  de datos.
- **Hosting:** GitHub Pages.
- **Diseño:** paleta institucional MSP + tipografía Barlow.

---

## Estructura de archivos

```
chagas-relevamiento/
├── index.html                     # UI completa (login + operativo + app + mapa)
├── app.js                         # Lógica: sesión, mapa, IndexedDB, sync, formularios
├── sw.js                          # Service Worker (CACHE_VERSION = "captura-v7")
├── poligonos.js                   # Polígonos KML de municipios de Corrientes
├── manifest.json                  # Metadatos PWA
├── icon.svg                       # Ícono institucional
├── apps_script_puntos_v3.gs       # Backend (se pega en Apps Script, no lo lee GitHub Pages)
└── README.md                      # Este archivo
```

---

## Estructura de la hoja `BD` (Google Sheets)

50 columnas fijas, en este orden:

| Col | Header | Descripción |
|-----|--------|-------------|
| A   | `DEPARTAMENTO` | Auto (Turf.js sobre KML) |
| B   | `MUNICIPIO` | Auto (Turf.js sobre KML) |
| C   | `LOCALIDAD` | Manual, 1 vez por sesión de operativo |
| D   | `ZONA` | Rural / Urbana / Periurbana |
| E   | `T_EFECTOR` | Provincial / Municipal / Nacional |
| F   | `NOMBRE_EFECTOR` | Auto (usuario logueado) |
| G   | `N_VIVIENDA` | Numérico, manual |
| H   | `APELLIDO_NOMBRES` | Persona responsable de la vivienda |
| I   | `DNI` | Opcional |
| J   | `FECHA` | Día del relevamiento (YYYY-MM-DD) |
| K   | `ESTADO_VIVIENDA` | Dropdown ← `CEREBRO!AC` |
| L–O | `TI_HH_ID_AD`, `TI_HH_ID_N`, `TI_HH_PD_AD`, `TI_HH_PD_N` | Conteos T. infestans H/H |
| P–S | `TI_PRES_ID_AD`, `TI_PRES_ID_N`, `TI_PRES_PD_AD`, `TI_PRES_PD_N` | Presencia Sí/No (derivada) |
| T   | `OTRA_ESPECIE` | Dropdown ← `CEREBRO!AE` |
| U–V | `OTRA_ESP_ID`, `OTRA_ESP_PD` | Conteos otra especie |
| W   | `INSECTICIDA_TIPO` | Dropdown ← `CEREBRO!AG` |
| X   | `INSECTICIDA_CANT` | Monodosis |
| Y–AA | `HAB_0_4`, `HAB_5_19`, `HAB_TOTAL` | Habitantes por rango etario |
| AB–AC | `TECHO_COLONIZABLE`, `PARED_COLONIZABLE` | Sí/No |
| AD–AG | `ANIM_PERROS`, `ANIM_GATOS`, `ANIM_GALLINAS`, `ANIM_CABRAS` | Cantidades |
| AH–AI | `GALLINERO`, `CORRAL` | Chico/Mediano/Grande |
| AJ–AK | `OTRAS_ESTR_ANIMAL`, `OTRAS_ESTR_CANT` | Otras estructuras |
| AL   | `CAPTURA_N_INSECTOS` | Total capturados |
| AM–AP | `TCRUZI_ID_NEG`, `TCRUZI_ID_POS`, `TCRUZI_PD_NEG`, `TCRUZI_PD_POS` | Infección natural |
| AQ–AS | `LATITUD`, `LONGITUD`, `PRECISION` | Geo |
| AT   | `UUID` | Identificador único de fila (para idempotencia) |
| AU   | `FECHA_CARGA` | Timestamp de guardado en el dispositivo |
| AV–AW | `OP_CORREO`, `OP_NOMBRE` | Trazabilidad del operario |
| AX   | `__ELIMINADO` | Columna de control (soft-delete futuro) |

**Derivación silenciosa de `TI_PRES_*`:** al guardar en el cliente, cada
`TI_HH_*` genera automáticamente su `TI_PRES_*` correspondiente
(`>0 → "Sí"`, `0 → "No"`, vacío → vacío). El operario no lo carga a mano.

Otras hojas compartidas con `pwa-captura-puntos` (mismo Sheet ID):

- **`USUARIOS_APP`** — pool de operarios con estado APROBADO/PENDIENTE/RECHAZADO.
- **`CEREBRO`** — listas de valores dinámicos:
  - Col `AC` — estados de vivienda
  - Col `AE` — especies (T. sordida, T. platensis, ...)
  - Col `AG` — tipos de insecticida

---

## Deploy — primera vez

### 1. Backend (Google Apps Script)

1. Abrí el proyecto de Apps Script vinculado al Google Sheet.
2. Pegá el contenido de `apps_script_puntos_v3.gs` (reemplazando lo que hubiera).
3. Guardá y ejecutá `setup()` desde el editor (menú Ejecutar → `setup`).
   Autorizá los permisos de Sheets. Esto crea la hoja `BD` con los 50 headers
   si no existe.
4. Ejecutá `testDropdowns()` para verificar que las columnas `AC`, `AE`, `AG`
   de `CEREBRO` están bien mapeadas (los resultados salen en Logs).
5. **Implementar → Nueva implementación**: tipo `Aplicación web`, ejecutar como
   `Yo`, acceso `Cualquiera`. Copiá la URL del deploy.

### 2. Frontend

1. Clonar / crear el repo `chagas-relevamiento` bajo `javiepidec-cmd`.
2. Copiar los archivos: `index.html`, `app.js`, `sw.js`, `poligonos.js`,
   `manifest.json`, `icon.svg`.
3. En `app.js`, línea `CONFIG.endpointSync`, reemplazar la URL por la del
   deploy nuevo del Apps Script.
4. Push a la rama `main`.
5. Activar GitHub Pages: Settings → Pages → Source: `main` / root.
6. Verificar que la app carga en https://javiepidec-cmd.github.io/chagas-relevamiento/.

### 3. Instalación en el celular del operario

1. Abrir la URL en Chrome / Safari desde el celular.
2. Menú del navegador → "Instalar app" (o "Agregar a pantalla de inicio").
3. Aparece ícono en el escritorio del celular.
4. Al abrir por primera vez pide permiso de GPS y de notificaciones.

---

## Deploy — actualizaciones

### Backend

Cada cambio al archivo `.gs` requiere **"Nueva implementación"** (no
"Actualizar existente"). La URL cambia con cada deploy; hay que actualizar
`CONFIG.endpointSync` en `app.js` y hacer push.

### Frontend

Al bumpear `CACHE_VERSION` en `sw.js`, el operario debe:

1. Desinstalar la PWA del escritorio del celular.
2. Borrar datos del sitio en el navegador.
3. Reinstalar.

De lo contrario sigue viendo la versión vieja cacheada.

---

## Flujo del operario

1. Abre la PWA desde el ícono del escritorio.
2. **Login** con su correo (primera vez requiere conexión; despues puede offline).
3. **Inicio de operativo:** define `Localidad`, `Zona` y `Tipo de efector` una
   vez. Persiste hasta que use el botón "Cambiar" en la user-bar.
4. La app pide permiso de GPS y centra el mapa.
5. Para cargar una vivienda:
   - Toca **"Colocar punto"** y luego toca el mapa, o **"Mi ubicación"** para
     usar el GPS actual.
   - Se abre el formulario con 5 bloques colapsables: el primero
     (vivienda + responsable) es obligatorio, los otros 4 opcionales.
   - Toca **"Guardar vivienda"** → queda en cola local (amarillo).
6. Al haber conexión, se sincroniza automáticamente y pasa a verde.

---

## Convenciones críticas

### CORS con Apps Script

El cliente usa `Content-Type: text/plain;charset=utf-8` (no `application/json`)
para evitar el preflight OPTIONS que Apps Script no responde.

### Idempotencia

Cada vivienda se guarda con un `UUID` generado con `crypto.randomUUID()`. El
backend chequea si el UUID ya existe en `BD` antes de insertar, así que un
reintento de sincronización nunca duplica filas.

### Coordenadas

GeoJSON usa formato `[lng, lat]`, **no** `[lat, lng]`. Turf.js espera GeoJSON.

### Polígonos KML

Parseados con `parseMunisKMLtoGeoJSON()`. Extrae:

- `NOMB_MUNI` → `properties.muni`
- `NOMB_DEPT` → `properties.depto`

### Aprobación de usuarios

Se hace **manual editando la celda de la columna C de `USUARIOS_APP`** (cambiar
`PENDIENTE` → `APROBADO`). No hay endpoint de admin todavía.

---

## Recursos

| Recurso | Valor |
|---------|-------|
| Google Sheet ID | `1sFtfwXux8qxiwsqcTUhpGZQNktK2YsnHVdRpxBL7UbE` |
| Secret compartido | En `apps_script_puntos_v3.gs` y `app.js` (variable `CONFIG.secret`) |
| Repo padre / genérico | `pwa-captura-puntos` (queda para otros usos) |

---

## Roadmap / pendientes

- [ ] Rol de administrador en `USUARIOS_APP` + endpoint para aprobar sin editar
      la celda a mano.
- [ ] Email automático de bienvenida al aprobar un usuario nuevo.
- [ ] Botón "Nueva visita a esta vivienda" que pre-carga N° vivienda y
      coordenadas de una fila ya guardada.
- [ ] Exportador a formato planilla papel (una fila por persona)
      desde la hoja `BD`.

---

*Ministerio de Salud Pública de la Provincia de Corrientes — Argentina.*
