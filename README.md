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
```

Al iniciar, `shared/config/env.ts` valida que las cinco variables existan. Si falta alguna, la app falla de inmediato con un mensaje que indica cuáles faltan (sin imprimir valores). Las variables `VITE_*` forman parte del bundle cliente: no son secretos.

## Desarrollo

```bash
cd AdminWeb
npm install
npm run dev
```

El puerto predeterminado del dev server es `http://localhost:5173`; consultar
la URL que imprima Vite si ese puerto está ocupado.

## Build y deploy

```bash
npm run build          # genera dist/
npm run preview        # preview local de la build
firebase deploy        # solo tras verificar el proyecto de destino en Firebase CLI
```

La configuración de Firebase Hosting (`firebase.json`) sirve desde `dist/` con rewrites SPA y cache de assets. Confirmar el proyecto seleccionado antes de desplegar; este README no certifica el estado publicado.

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
