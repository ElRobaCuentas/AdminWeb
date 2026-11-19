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

El monitor vive en `monitor/` y se ejecuta aparte del panel. Su MVP quedó
implementado, desplegado y validado operativamente el **18/11/2026**. El
[documento principal de PULSO](https://github.com/ElRobaCuentas/BurritoDocs/blob/main/PULSO.md)
explica funcionamiento, indicadores, límites y evidencia; aquí se mantienen los
procedimientos para desarrollar, probar y operar sus componentes.

### Entornos y configuración

Prerrequisitos: Node.js **>=24.12.0**, dependencias de AdminWeb y
`monitor/worker`, Firebase CLI y Java 21 para emuladores. Las pruebas de navegador
usan Chrome/Chromium instalado o Edge; `PULSO_CHROME` permite indicar su ruta.
En Windows, el runner de integración utiliza el JBR de Android Studio.

| Entorno | Uso y configuración |
|---------|---------------------|
| Base local | `npm run dev` usa loopback:8787 y habilita `/evaluate`, pero por sí solo no configura fuente, bus ni D1. |
| `memory-local` | D1 `pulso-memory-local` con binding `PULSO_DB`, `remote:false`, memoria `d1-local` y umbrales del MVP. Por defecto apunta a RTDB:9000, namespace `demo-pulso-memory`; hay que completar bus y token local. |
| `operative` | Comprobación manual local de la fuente pública operativa. Requiere bus explícito; `runScheduledCheck` la rechaza con `operative-manual-only`. No usar para el sandbox. |
| `production` | Worker `pulso-monitor`, modo `cloudflare`, memoria `d1`, D1 `pulso-memory-production`, bus `AHK-459`; configuración completa en `monitor/worker/wrangler.jsonc`. |
| Central `pulso-local` | Auth:19099 y RTDB:19000, proyecto `demo-pulso-api`. No carga `.env` operativo; proxy HTTP loopback hacia `PULSO_WORKER_ORIGIN` (por defecto :8787). |

La API requiere `PULSO_ADMIN_PROJECT_ID`, `PULSO_ADMIN_RTDB_ORIGIN` y
`PULSO_ADMIN_RTDB_NAMESPACE`. En emuladores, proyecto/namespace deben coincidir
y empezar con `demo-`; en producción corresponden a `burritounmsm` y su RTDB.
Sin configuración válida la autorización falla cerrado.

Central usa `VITE_PULSO_API_ORIGIN` en producción (ver Variables de entorno).
`PULSO_CENTRAL_ORIGIN` fija el origen permitido del panel. El cliente reutiliza
el ID token de la sesión; no se configura otra contraseña ni se guardan tokens
administrativos en el Worker. `FIREBASE_ID_TOKEN` solo se necesita para la
lectura del tracking en el modo local autenticado.

### Desarrollo local con memoria y Central

1. Desde la raíz de AdminWeb, iniciar `npm run emulators:pulso` en una terminal.
   Reserva 19000/19099/14400/14500 y carga las reglas versionadas de FirebaseLab.
2. Preparar identidad Auth local, su nodo `/administradores/{uid}` y el tracking
   de prueba. Los fixtures de `monitor/worker/tests/pulsoScreen.integration.test.ts`
   muestran el alta, perfil y datos necesarios; el comando de emuladores no los
   crea por sí solo. Nunca usar credenciales ni datos operativos.
3. En `monitor/worker/.dev.vars.memory-local` (ignorado por Git), configurar el
   destino de esos emuladores y un ID token temporal emitido por su Auth:

```dotenv
BUS_ID=PULSO-LOCAL
RTDB_ORIGIN=http://127.0.0.1:19000
RTDB_NAMESPACE=demo-pulso-api
PULSO_ADMIN_PROJECT_ID=demo-pulso-api
PULSO_ADMIN_RTDB_ORIGIN=http://127.0.0.1:19000
PULSO_ADMIN_RTDB_NAMESPACE=demo-pulso-api
FIREBASE_ID_TOKEN=<ID_TOKEN_TEMPORAL_DEL_EMULADOR>
```

4. Desde `monitor/worker`, aplicar las migraciones locales y arrancar el Worker:

```bash
npx wrangler d1 migrations apply pulso-memory-local --env memory-local --local
npm run dev -- --env memory-local
```

5. Para simular comprobaciones cada minuto, abrir otra terminal en
   `monitor/worker` y ejecutar `npm run watch:local`; Ctrl+C detiene ese reloj.
   Wrangler expone la entrada de prueba, pero no dispara el cron automáticamente.
   Para una comprobación manual: `GET http://127.0.0.1:8787/evaluate` con
   `X-Pulso-Local: 1`. La API de lectura no exige esa cabecera: usa Bearer.
6. En otra terminal, desde AdminWeb, ejecutar `npm run dev:pulso`, iniciar sesión
   con la cuenta del emulador y abrir `/pulso`. El token temporal del lector debe
   renovarse si vence; no es una solución de autenticación continua de producción.

Los tres procesos (emuladores, Worker y Vite) son distintos; `watch:local` es
opcional para el reloj simulado. Ninguno de estos pasos requiere desplegar.

### Pruebas y comprobaciones previas

Desde la raíz de AdminWeb:

```bash
node --test monitor/tests/evaluateTracking.test.ts
npm run test:pulso
npm run test:pulso:integration
npm run lint
npm run build
```

Desde `monitor/worker`:

```bash
npm run typecheck
npm test
npm run test:api:integration
```

Las integraciones de pantalla y API arrancan Auth/RTDB y D1 locales y preparan
sus propios fixtures. Ejecutarlas secuencialmente, con 19000/19099/14400/14500
libres; no dejar `emulators:pulso` abierto para esas suites. Los runners rechazan
puertos ocupados y no reutilizan un emulador ajeno.

La integración histórica `npm run test:integration` del Worker es distinta:
requiere Auth:9099/RTDB:9000, namespace `demo-el-burrito-i03i04`, reglas del
laboratorio que permitan `/privado/{uid}` al propio usuario y denieguen el tracking
a esa identidad. No inicia esos emuladores. Habilitarla con
`PULSO_RUN_EMULATOR_TESTS=1`; sin esa variable queda omitida, no aprobada.
La evidencia histórica de las 237 pruebas está en PULSO §9; no sustituye una
ejecución actual de las suites.

### Migraciones y publicación en producción

Las migraciones `0001`, `0002` y `0003` ya están aplicadas en producción.
Para mantenimiento futuro, revisar primero cuenta, entorno, binding, UUID y
migraciones pendientes contra `wrangler.jsonc`. D1 no se migra al publicar Central.
El orden es **migración compatible → Worker → comprobación → Hosting**; ante
incompatibilidad o pérdida de integridad, detener la secuencia.

Desde `monitor/worker`, los comandos de referencia son:

```bash
npx wrangler deploy --env production --dry-run
npx wrangler d1 migrations list pulso-memory-production --env production --remote
npx wrangler d1 migrations apply pulso-memory-production --env production --remote
npx wrangler deploy --env production
npx wrangler tail --env production
```

El dry-run no publica ni migra D1; no sustituye la inspección del destino remoto.
Aplicar solo migraciones pendientes y autorizadas. No borrar tablas ni repetir
SQL de inicialización. Verificar integridad y conservación de datos antes de
continuar; no confundir una ejecución cron correcta con un incidente de fuente.

Después de verificar el Worker y sus comprobaciones, desde AdminWeb:

```bash
npm run build
firebase deploy --only hosting --project burritounmsm
```

Confirmar `VITE_PULSO_API_ORIGIN`, el proyecto de destino, release finalizado,
correspondencia de los archivos publicados con `dist/`, rewrite `/pulso`, CORS y
rechazo de consultas sin autorización. Verificar además con sesión administrativa;
no registrar tokens ni URLs autenticadas. `/evaluate` debe seguir bloqueado en
remoto. Las referencias de publicación y compatibilidad de rollback están en
[PULSO §8](https://github.com/ElRobaCuentas/BurritoDocs/blob/main/PULSO.md#8-operación-en-producción).

### Mantenimiento de la vigilancia

Ante falta de comprobaciones nuevas, contrastar antigüedad en Central, salida de
`wrangler tail`, trigger/interruptor y último registro D1. La configuración se
valida antes de leer tracking. Revisar `memory-*`/errores de configuración como
fallos del monitor; una fuente inaccesible puede estar correctamente registrada.
No ejecutar evaluaciones remotas ni alterar el bus para probar el monitor.

Para suspender con autorización, cambiar en `env.production` de `wrangler.jsonc`
`PULSO_SCHEDULE_ENABLED` a la cadena `"false"` y `triggers.crons` a `[]`; publicar
el Worker con el procedimiento anterior y comprobar la propagación. El
interruptor apagado devuelve `schedule-disabled` en el handler programado sin
evaluar ni persistir; omitir la clave `crons` no elimina triggers publicados.
Los cambios de cron pueden tardar hasta 15 minutos. La API sigue leyendo D1 si su
configuración y autorización son válidas; los registros se vuelven antiguos.

No limpiar memoria, cerrar incidentes ni simular inactividad para apagar el cron.
Para reanudar, restaurar ambos valores, publicar y verificar ejecuciones nuevas;
la memoria compatible conserva el período y los incidentes. Cambiar umbrales o
`state_version` requiere revisar compatibilidad, no reinicializar automáticamente.
Los parámetros y la retirada de triggers se describen también en la
[referencia oficial de Wrangler](https://developers.cloudflare.com/workers/wrangler/commands/d1/)
y en [Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/).

## Build y deploy

```bash
npm run build          # genera dist/
npm run preview        # preview local de la build
firebase deploy        # solo tras verificar el proyecto de destino en Firebase CLI
```

La configuración de Firebase Hosting (`firebase.json`) sirve desde `dist/` con rewrites SPA y cache de assets. Confirmar el proyecto seleccionado antes de desplegar; las referencias de publicación de PULSO están en su documento principal, y Firebase Console sigue siendo la fuente autoritativa del historial de versiones.

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

- [Versionado y publicación](https://github.com/ElRobaCuentas/BurritoDocs/blob/main/VERSIONADO_Y_PUBLICACION.md): política del MVP e identificación de despliegues de Central y PULSO.
- [Arquitectura](https://github.com/ElRobaCuentas/BurritoDocs/blob/main/ARCHITECTURE.md): flujos e implementación entre aplicaciones.
- [PULSO](https://github.com/ElRobaCuentas/BurritoDocs/blob/main/PULSO.md): referencia técnica y operativa del monitor y validación de su MVP.
- [Esquema Firebase](https://github.com/ElRobaCuentas/BurritoDocs/blob/main/FIREBASE_SCHEMA.md): nodos, payloads y permisos.
- [Decisiones](https://github.com/ElRobaCuentas/BurritoDocs/blob/main/DECISIONS.md): criterios arquitectónicos.
- [Diagnóstico](https://github.com/ElRobaCuentas/BurritoDocs/blob/main/TROUBLESHOOTING.md): problemas conocidos y limitaciones.

Las instrucciones específicas para asistentes se mantienen en [AGENTS.md](AGENTS.md).
