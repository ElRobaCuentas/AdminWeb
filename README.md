# AdminWeb — Panel de Administración Web

Panel web para la gestión de conductores, buses y asignaciones por fecha del sistema **El Burrito**. Permitido solo para usuarios cuyo UID existe en `/administradores/` en Firebase RTDB.

## Stack

| Tecnología | Versión | Propósito |
|------------|---------|-----------|
| React | 19.x | Framework UI |
| TypeScript | 6.x | Tipado estricto |
| Vite | 8.x | Build tool y dev server |
| Firebase JS SDK | 12.x | Auth + Realtime Database |
| react-router-dom | 7.x | Navegación SPA |
| Zustand | 5.x | Estado global |
| Oxlint | 1.75+ | Linting |

## Arquitectura

```
src/
├── App.tsx                          ← Auth gate: sesión → verificación de rol (checking/admin/denied/error)
├── index.css                        ← Punto de entrada de estilos (importa src/styles/*)
├── styles/                          ← Sistema de diseño (tokens + layout + componentes + overlays + pantallas)
├── screen/
│   └── LoginScreen.tsx              ← Formulario de login (DNI + contraseña)
├── navigation/
│   └── AdminNavigator.tsx           ← Rutas del panel (envueltas por el AppShell)
├── features/admin/
│   ├── screen/
│   │   ├── ChoferesScreen.tsx       ← Gestión de conductores (crear, editar, activar/desactivar)
│   │   ├── BusesScreen.tsx          ← Gestión de buses (crear, activar/desactivar, eliminar)
│   │   ├── AsignacionesScreen.tsx   ← Formulario y listado por fecha, editar horarios
│   │   └── AdminsScreen.tsx         ← Gestión de administradores
│   ├── components/
│   │   └── TurnosEditor.tsx         ← Editor reutilizable de turnos
│   ├── services/
│   │   ├── admin_service.ts         ← Toda la lógica CRUD (Firebase Auth + RTDB)
│   │   └── admin_check.ts           ← Verificación de rol admin en /administradores/{uid}
│   └── utils/
│       ├── turno.ts                 ← Modelo/validación/format de turnos
│       └── turnoDraft.ts            ← Estado de edición de turnos
└── shared/
    ├── config/
    │   ├── env.ts                   ← Validación de variables VITE_FIREBASE_*
    │   └── firebase.ts              ← Inicialización de Firebase (Auth + RTDB)
    ├── layout/
    │   ├── AppShell.tsx             ← Sidebar + topbar + drawer móvil; provee la sesión (admin)
    │   └── SessionContext.tsx       ← Contexto con los datos del admin en sesión
    ├── ui/                          ← Primitivas reutilizables (Button, Field, Card, Modal, Toast…)
    └── utils/
        ├── dni.ts                   ← Normalización y validación de DNI (8 dígitos)
        ├── format.ts                ← Formateo de fechas y nombres de admin
        ├── date.ts                  ← Fechas de calendario America/Lima
        └── timeout.ts               ← Helper con timeout para reads de RTDB
```

## Interfaz y diseño

La interfaz usa un **sistema de diseño propio basado en CSS con tokens** (sin dependencias de UI). `src/index.css` solo importa las hojas de `src/styles/`:

| Hoja | Contenido |
|------|-----------|
| `tokens.css` | Variables de diseño (colores, espaciado, radios, sombras, tipografía) |
| `base.css` | Reset, tipografía base e interacciones globales |
| `layout.css` | App shell: sidebar, topbar, contenido y drawer móvil |
| `components.css` | Primitivas reutilizables (botones, campos, cards, badges, etc.) |
| `overlays.css` | Modal, diálogo de confirmación y toasts |
| `screens.css` | Login, pantallas de auth y asignaciones |

- **Tema claro:** cian `#00AEEF`, gris `#F5F5F5`, fondo blanco y texto `#222222`. Tipografía **Barlow** y **Barlow Condensed**, cargadas desde Google Fonts en `index.html`.
- **App shell** (`shared/layout/AppShell.tsx`): sidebar tipo línea de ruta + topbar en escritorio; drawer en móvil. Muestra la identidad del admin en sesión y expone los datos vía `SessionContext`/`useSession`. Las rutas (`AdminNavigator`) se renderizan dentro del shell.
- **Primitivas** (`shared/ui/`): `Button`, `Field`, `Card`/`CardHeader`, `StatCard`, `StatusBadge`/`Badge`, `ToggleSwitch`, `Modal`/`ConfirmDialog`, `Toast` (+ `useToast` en `toastContext.ts`), `EmptyState`/`Spinner`/`LoadingScreen`, `PageHeader` e `Icon` (set de iconos SVG propio).
- **Confirmaciones y avisos:** no se usa `window.confirm`; las acciones se confirman con `ConfirmDialog` y los resultados se comunican con toasts.

## Autenticación y autorización

El acceso usa DNI y contraseña (`{dni}@admin.com`) y requiere que el UID
exista en `/administradores/{uid}`. Un fallo de red o el timeout de 10 s
muestra "No se pudo verificar" con opción de reintentar; no se interpreta
como una denegación de permisos.

El primer administrador se crea manualmente en Firebase Console (cuenta
Auth y nodo RTDB). Los siguientes se crean desde el panel. El flujo técnico
completo se mantiene en la [arquitectura compartida](https://github.com/ElRobaCuentas/BurritoDocs/blob/main/ARCHITECTURE.md).

## Módulos del panel

| Módulo | Ruta | Descripción |
|--------|------|-------------|
| **Asignaciones** | `/` (`/asignaciones` redirige) | Formulario de creación y listado por fecha con horarios, placa, conductor y fecha de creación cuando está disponible. Permite editar horarios o cancelar asignaciones |
| **Choferes** | `/choferes` | Crear, listar, editar y activar/desactivar conductores. Desactivar conserva su cuenta y su historial (no se elimina). Cada creación genera una cuenta Firebase Auth (`{dni}@conductor.com`) y el nodo en `/choferes/{dni}` |
| **Buses** | `/buses` | Crear, listar, activar/desactivar y eliminar buses. Al crear, se inicializa `/ubicacion_buses/{placa}` con `isActive: false` |
| **Administradores** | `/admins` | Crear, editar y retirar el acceso administrativo. Crear genera cuenta Firebase Auth (`{dni}@admin.com`) y nodo en `/administradores/{uid}`. Retirar acceso borra solo el nodo RTDB; la cuenta Auth se elimina manualmente en Firebase Console |

### Asignaciones y turnos

- Una asignación activa por conductor + fecha; un solo bus.
- `turnos` es un array de intervalos `{ inicio, fin }` en minutos; mínimo uno, mismo día, sin solapamientos y ordenado.
- `horaInicio`/`horaFin` se mantienen como espejo del primer turno para compatibilidad.
- Los turnos no inician ni detienen el tracking del conductor; el conductor sigue usando el bus asignado.
- Al crear no se comprueba que el bus esté libre; sí se bloquea su eliminación si tiene una asignación activa o futura.

Los contratos de nodos, campos y permisos se mantienen en el
[esquema Firebase](https://github.com/ElRobaCuentas/BurritoDocs/blob/main/FIREBASE_SCHEMA.md),
sin duplicarlos en este README.

Desactivar un conductor conserva su cuenta e historial: no cancela sus
asignaciones ni detiene por sí solo el tracking de BurritoDriverApp.

## Variables de entorno

Copia `.env.example` a `.env` y completa los valores de tu proyecto Firebase:

```bash
VITE_FIREBASE_API_KEY=
VITE_FIREBASE_AUTH_DOMAIN=
VITE_FIREBASE_DATABASE_URL=
VITE_FIREBASE_PROJECT_ID=
VITE_FIREBASE_APP_ID=
VITE_PULSO_API_ORIGIN=
```

Al iniciar, `shared/config/env.ts` valida que las cinco variables de Firebase
existan. Si falta alguna, la app falla de inmediato con un mensaje que indica
cuáles faltan (sin imprimir valores). Las variables `VITE_*` forman parte del
bundle cliente: no son secretos.

`VITE_PULSO_API_ORIGIN` es opcional en local: sin ella, PULSO sigue usando el
proxy `/api/pulso`. En una build de producción sí es necesaria para que la
pantalla alcance el Worker remoto; debe ser un origen HTTPS sin ruta, query ni
credenciales (el cliente añade `/api/pulso`). Su ausencia no impide iniciar el
panel: el error aparece solo al abrir `/pulso`.

## Desarrollo

```bash
cd AdminWeb
npm install
npm run dev
```

El puerto predeterminado del dev server es `http://localhost:5173`; consultar
la URL que imprima Vite si ese puerto está ocupado.

## Monitor PULSO (local y despliegue remoto)

El monitor de seguimiento vive en `monitor/` y se ejecuta aparte del panel:

```bash
cd monitor/worker
npm run dev           # Wrangler en http://127.0.0.1:8787 (comprobación manual /evaluate)
npm run watch:local   # dispara la comprobación programada cada minuto; Ctrl+C la detiene
```

La comprobación programada reutiliza el evaluador, la memoria D1 local y el registro de incidentes; el entorno `memory-local` permite simularla en desarrollo, mientras el Worker desplegado en `production` ya ejecuta el cron de un minuto con la vigilancia activa. El diseño completo y el estado del despliegue en Cloudflare están en la [arquitectura compartida](https://github.com/ElRobaCuentas/BurritoDocs/blob/main/ARCHITECTURE.md) (§3.2 y §3.2.1).

### API de lectura para Central (pantalla `/pulso`)

`GET /api/pulso` (`http://127.0.0.1:8787/api/pulso`) expone el último estado
—incluido `observedState.observedTripStartedAt`—, la última comprobación y los
incidentes guardados en D1, **sin ejecutar el
evaluador**. Autoriza con el ID token de la sesión de Central
(`Authorization: Bearer`), que Firebase verifica contra `/administradores/{uid}`
con las reglas existentes: no se define una contraseña adicional. Requiere la
memoria D1 ya descrita y, además, estas variables de autorización en la
configuración del Worker (`wrangler.jsonc` / `.dev.vars`):

```bash
PULSO_ADMIN_PROJECT_ID=
PULSO_ADMIN_RTDB_ORIGIN=       # https://burritounmsm-default-rtdb.firebaseio.com o loopback demo-*
PULSO_ADMIN_RTDB_NAMESPACE=
```

Sin esas variables la API falla cerrado (503). Central la consume en la ruta
`/pulso` del menú lateral con la sesión de administrador existente: no hay
segunda autenticación ni pantalla de login adicional. En desarrollo se ejecuta
junto al Worker de arriba, desde la raíz de AdminWeb:

```bash
npm run emulators:pulso  # Auth 19099 + RTDB 19000 (proyecto demo-pulso-api)
npm run dev:pulso        # Central en modo pulso-local; proxy /api/pulso al Worker del monitor
```

La pantalla consulta al entrar y cada 60 segundos mientras permanece montada; el
botón Actualizar lanza la misma consulta, sin solapamientos. Al salir se cancela
la consulta pendiente y se limpian los temporizadores. Un fallo conserva los
últimos datos con su antigüedad y avisa de que no se pudo confirmar si hay
comprobaciones nuevas; una denegación los retira. La advertencia de datos
antiguos se mantiene y el refresco no rejuvenece la comprobación.

El modo `pulso-local` solo actúa en desarrollo y no carga el `.env` operativo;
el proxy acepta únicamente orígenes HTTP de loopback (`PULSO_WORKER_ORIGIN`,
por defecto `http://127.0.0.1:8787`). Pruebas de la pantalla y su integración
local: `npm run test:pulso` y `npm run test:pulso:integration` (exigen los
puertos 19000/19099/14400/14500 libres).

### Entorno `production` desplegado (vigilancia activa)

`monitor/worker/wrangler.jsonc` incluye un entorno separado `production`
(`name: pulso-monitor`, `workers_dev: true`, `preview_urls: false`) con D1
`pulso-memory-production`, `PULSO_EXECUTION=cloudflare`, `PULSO_MEMORY=d1`,
`PULSO_SCHEDULE_ENABLED: "true"` y `triggers.crons: ["* * * * *"]`. La D1 remota
está creada, migrada y en uso, y su UUID está configurado.

El Worker está desplegado en **`https://pulso-monitor.elburrito.workers.dev`** y
sirve `GET /api/pulso`. La API de Cloudflare confirmó el binding `PULSO_DB`, el
interruptor encendido, el origen de Central configurado y el cron de un minuto.
La ejecución remota exige configuración completa y falla cerrado: no consulta
Firebase ni escribe en D1 si falta un valor. Con el interruptor apagado, el
handler programado registra `schedule-disabled` y no evalúa; `production` lo
mantiene encendido.

La D1 remota tiene aplicadas las migraciones `0001`, `0002` y `0003` y registra
las comprobaciones reales del bus AHK-459; el historial se poda a 7 días. Valores
confirmados:

| Valor | Ubicación | Nota |
|-------|-----------|------|
| Origen de Central | `PULSO_CENTRAL_ORIGIN` | `https://burritounmsm.web.app`, configurado |
| Origen del Worker | `VITE_PULSO_API_ORIGIN` | `https://pulso-monitor.elburrito.workers.dev`, usado por la build publicada |

La API remota mantiene el contrato y la autorización por token de administrador;
habilita CORS solo para el origen exacto de Central, responde `OPTIONS` 204 para
`GET` + `Authorization`, rechaza peticiones de navegador con otro origen y
continúa leyendo únicamente `SELECT` de D1. `/evaluate` sigue siendo
exclusivamente local.

Comprobaciones HTTPS realizadas sobre la URL pública: `GET` sin token `401`,
token malformado `401`, origen ajeno `403` sin CORS, preflight de Central `204`,
preflights con `POST` o cabeceras extra `403`, `POST` `405` y `/evaluate` `403`
incluso con cabecera local. Esas comprobaciones no usaron un token válido ni
consultaron la ubicación operativa del bus; las tres tablas D1 seguían vacías.

Central fue compilada con `VITE_PULSO_API_ORIGIN` —configurada manualmente en
`.env`, sin leer ni modificar el archivo— y publicada con
`firebase deploy --only hosting --project burritounmsm`. La primera publicación
quedó en release `1794779471348000` (versión `1952a1f1e616bfa3`, `2026-11-15`),
con la versión previa `004ca7b34e3d9821` como referencia de rollback; aprobaron
el lint y las 20 pruebas de cliente. Después se publicó el refresco automático:
release `1794782963690000` (versión `3b69ad434e3d33d7`,
`2026-11-15T22:49:23.690Z`), con `1952a1f1e616bfa3` como rollback, tras aprobar
el lint, las 26 pruebas de cliente y las 8 de integración local. La publicación
del inicio observado quedó en release `1795033146333000` (versión
`3026576fcc32c269`, `2026-11-18T20:19:06.333Z`), con `3b69ad434e3d33d7` como
rollback, tras aprobar 237 pruebas automatizadas, typecheck, lint y build. En
todas, los archivos publicados coinciden byte a byte con `dist/` y `/pulso`
resuelve a `index.html`; el build apunta a la API y al proyecto `burritounmsm`,
sin marcadores de sandbox ni endpoints de emulador. La comprobación manual del
refresco y de los dos indicadores con una sesión administrativa real y un
recorrido activo nuevo queda pendiente.

La validación administrativa real se completó en producción: con una cuenta
administrativa habitual, PULSO mostró «Sin registros de PULSO» y «Todavía no hay
comprobaciones guardadas para el bus AHK-459», sin errores de acceso ni de
conectividad; en ese momento las tres tablas D1 seguían vacías. No se solicitaron
ni registraron contraseñas o tokens. Las notificaciones externas siguen
pospuestas.

`npx wrangler deploy --env production --dry-run` valida la configuración sin
autenticar ni crear recursos. El orden que se siguió —crear D1, aplicar las
migraciones, completar valores, desplegar el Worker, verificar la API, publicar
Central y activar interruptor y cron— está en la
[arquitectura compartida](https://github.com/ElRobaCuentas/BurritoDocs/blob/main/ARCHITECTURE.md)
(§3.2.1). Todo se ejecutó con autorización, la lectura autenticada quedó validada
y la vigilancia corre cada minuto. Queda pendiente la validación operativa de los
dos indicadores durante un recorrido activo nuevo con el Motorola y la
comprobación manual del refresco con una sesión administrativa real.

### Inicio observado del recorrido y su duración

La migración `0003_tracking_observed_start.sql` agrega
`tracking_state.observed_trip_started_at`, que guarda la hora de la primera
comprobación que observó `isActive:true` y se conserva ante interrupciones,
recuperaciones, fuente inaccesible y reinicios; se limpia solo al observar
`isActive:false`. Central muestra «Inicio observado del recorrido (Lima)» y
«Tiempo de recorrido observado». No es la hora de INICIAR en BurritoDriverApp ni
tiempo continuo de GPS: la duración incluye cortes de conexión y, si no se
observó el `false` intermedio, dos recorridos pueden unirse. Un período anterior
sin inicio confiable muestra «Sin información disponible» / «No calculable»; uno
inactivo, «No aplica». Con datos antiguos, error o fuente distinta de `ok`, la
duración se limita a la última comprobación guardada. Detalle y límites:
[arquitectura compartida](https://github.com/ElRobaCuentas/BurritoDocs/blob/main/ARCHITECTURE.md) §3.2.

## Build y deploy

```bash
npm run build          # genera dist/
npm run preview        # preview local de la build
firebase deploy        # solo tras verificar el proyecto de destino en Firebase CLI
```

La configuración de Firebase Hosting (`firebase.json`) sirve desde `dist/` con rewrites SPA y cache de assets. Confirmar el proyecto seleccionado antes de desplegar; el release publicado y su validación están registrados arriba, y Firebase Console sigue siendo la fuente autoritativa del historial de versiones.

## Linting

```bash
npm run lint           # ejecuta Oxlint
```

## Compatibilidad

- **Plataforma:** web (cualquier navegador moderno)
- **No es móvil:** este panel es exclusivamente web, no tiene versión móvil
- **Firebase Hosting:** el destino depende del proyecto seleccionado en Firebase CLI.

## Documentación relacionada

La documentación compartida está en [BurritoDocs](https://github.com/ElRobaCuentas/BurritoDocs)
(`C:\Movil\docs` en el workspace):

- [Arquitectura](https://github.com/ElRobaCuentas/BurritoDocs/blob/main/ARCHITECTURE.md): flujos e implementación entre aplicaciones.
- [Esquema Firebase](https://github.com/ElRobaCuentas/BurritoDocs/blob/main/FIREBASE_SCHEMA.md): nodos, payloads y permisos.
- [Decisiones](https://github.com/ElRobaCuentas/BurritoDocs/blob/main/DECISIONS.md): criterios arquitectónicos.
- [Diagnóstico](https://github.com/ElRobaCuentas/BurritoDocs/blob/main/TROUBLESHOOTING.md): problemas conocidos y limitaciones.

Las instrucciones específicas para asistentes se mantienen en [AGENTS.md](AGENTS.md).
