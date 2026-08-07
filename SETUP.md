# Instrucciones de Configuración Inicial

## Paso 1: Configurar el esquema en Supabase

1. Ve a tu proyecto de Supabase en https://app.supabase.com
2. Abre el **SQL Editor** (en el menú lateral izquierdo)
3. Crea una **Nueva query** y copia-pega el contenido de **`supabase/sql/001_schema.sql`**
4. Haz clic en **Run** (▶ en la parte superior)
5. Espera a que complete sin errores

## Paso 2: Crear las funciones y triggers

1. Crea una **Nueva query** en el SQL Editor
2. Copia-pega el contenido de **`supabase/sql/002_functions.sql`**
3. Haz clic en **Run**
4. Espera a que complete sin errores

## Paso 3: Aplicar las políticas de seguridad (RLS)

1. Crea una **Nueva query** en el SQL Editor
2. Copia-pega el contenido de **`supabase/sql/003_rls_policies.sql`**
3. Haz clic en **Run**
4. Espera a que complete sin errores

## Paso 4: Crear la cuenta del dueño

1. Ve a **Authentication → Users** en tu proyecto de Supabase
2. Haz clic en **Create new user** (botón superior derecho)
3. Ingresa:
   - Email: tu email (ej: `dueño@granja.com`)
   - Password: una contraseña fuerte
   - Confirm password: confirma la contraseña
4. Haz clic en **Create user**
5. Copia el **User ID** (UUID) que aparece

Ahora ejecuta el siguiente SQL en el SQL Editor para promover esa cuenta a dueño:

```sql
update perfiles set rol='dueño' where id='<PEGA_EL_UUID_AQUI>';
```

Reemplaza `<PEGA_EL_UUID_AQUI>` con el UUID que copiaste.

## Paso 5: Obtener las credenciales de Supabase

1. Ve a **Project Settings** (ícono de engranaje, abajo a la izquierda)
2. Haz clic en **API** en el menú lateral
3. Copia:
   - **Project URL** → pega en `VITE_SUPABASE_URL`
   - **Anon public key** → pega en `VITE_SUPABASE_ANON_KEY`

## Paso 6: Configurar el archivo `.env.local`

1. Crea un archivo `.env.local` en la raíz del proyecto (al lado de `package.json`)
2. Pega:
   ```
   VITE_SUPABASE_URL=https://xxxxx.supabase.co
   VITE_SUPABASE_ANON_KEY=eyJhbGc...................
   ```
3. Guarda el archivo

## Paso 7: Ejecutar la app en desarrollo

```bash
npm run dev
```

Abre http://localhost:5173 en tu navegador e inicia sesión con tu email y contraseña del dueño.

## Crear cuentas para repartidores

Repite el "Paso 4" pero sin ejecutar el SQL de promoción — automáticamente se crea como `repartidor`.

Ejemplo de credenciales:
- Email: `repartidor1@granja.com`
- Password: `password123`

## Troubleshooting

**Error: "Missing Supabase environment variables"**
- Verifica que `.env.local` tiene las dos variables y que están en la raíz del proyecto
- Reinicia el servidor de desarrollo (`npm run dev`)

**Error al acceder a las tablas desde la app**
- Verifica que corristeuaron los tres SQL en orden (001, 002, 003)
- Verifica que el usuario está logueado correctamente

**RLS bloquea una operación esperada**
- Verifica que el rol del usuario es correcto (`perfiles.rol`)
- Si es un repartidor, solo puede marcar pedidos como entregados, no crear/editar
