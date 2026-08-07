# Granja Santo Tomás — App de Pedidos PWA

App para gestionar pedidos de la granja, con soporte para múltiples usuarios (dueño + repartidores) y sincronización en tiempo real via Supabase.

## Requisitos previos

- Node.js 18+
- Un proyecto de Supabase creado (URL + anon key)

## Primeros pasos

### 1. Configurar Supabase

Ejecuta los siguientes scripts en el **SQL Editor** de tu proyecto de Supabase, **en este orden**:

1. `supabase/sql/001_schema.sql` — crea las tablas y tipos
2. `supabase/sql/002_functions.sql` — crea funciones y triggers
3. `supabase/sql/003_rls_policies.sql` — configura las políticas de seguridad

### 2. Crear la cuenta del dueño

1. Ve a **Authentication → Users** en el panel de Supabase
2. Haz clic en "Create new user"
3. Ingresa el email y contraseña del dueño
4. En el SQL editor, corre:
   ```sql
   update perfiles set rol='dueño' where id='<uuid-del-usuario>';
   ```
   (reemplaza `<uuid-del-usuario>` con el ID que aparece en la tabla `perfiles`)

### 3. Configurar variables de entorno

1. Copia `.env.example` a `.env.local`:
   ```bash
   cp .env.example .env.local
   ```
2. Pega tu `VITE_SUPABASE_URL` y `VITE_SUPABASE_ANON_KEY` en el archivo

### 4. Instalar dependencias

```bash
npm install
```

### 5. Ejecutar en desarrollo

```bash
npm run dev
```

La app abrirá en `http://localhost:5173`

## Creando cuentas de repartidores

1. Ve a **Authentication → Users** en Supabase
2. Haz clic en "Create new user"
3. Ingresa email y contraseña
4. Listo — la cuenta se crea automáticamente como `repartidor` (gracias al trigger)

Si un repartidor olvida su contraseña, resetéala desde el panel de Supabase.

## Build para producción

```bash
npm run build
```

Genera la carpeta `dist/` lista para desplegar en Netlify, Vercel, o cualquier host estático.

### Desplegar en Netlify

1. Crea una cuenta en [Netlify](https://netlify.com)
2. Conecta tu repositorio de GitHub
3. En **Environment variables**, agrega:
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_ANON_KEY`
4. Netlify construye automáticamente e despliega cada push

## Estructura del proyecto

```
src/
├── auth/              # Login, AuthProvider, useAuth hook
├── api/               # Funciones para Supabase (pedidos, clientes, precios)
├── hooks/             # React Query hooks (usePedidos, useClientes, etc.)
├── features/pedidos/  # Componentes de la UI (PedidosApp, ListaPedidos, FormPedido)
├── lib/               # Cliente de Supabase
├── types/             # Tipos TypeScript
└── constants/         # CATEGORIAS, etc.
```

## Características

- ✅ Login seguro con email + contraseña (Supabase Auth)
- ✅ Dos roles: Dueño (todo) y Repartidor (solo marcar entregado)
- ✅ Sincronización en tiempo real (Realtime de Supabase)
- ✅ Instalable como PWA (app nativa en celular)
- ✅ Offline-first para shell de la app (precaching del JS/CSS)
- ✅ Interfaz responsive y touch-friendly

## Notas técnicas

- **Estado de servidor**: React Query + Supabase Realtime
- **Seguridad**: RLS (Row Level Security) en Supabase
- **UI**: React + Tailwind CSS
- **Build**: Vite
- **Hosting recomendado**: Netlify

## Próximas mejoras

- Soporte offline real (cola de escrituras sincronizadas al conectar)
- Reportes y analíticas por categoría
- Edición de cliente/precios desde la UI
- Notificaciones push para nuevos pedidos
