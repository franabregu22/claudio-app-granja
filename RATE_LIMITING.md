# Rate Limiting - Prevención de Fuerza Bruta

## ¿Qué es?
Sistema de protección contra ataques de fuerza bruta en el login. Bloquea IPs después de múltiples intentos fallidos.

## Configuración

- **Max intentos**: 5 fallos
- **Ventana de tiempo**: 15 minutos
- **Lockout**: 15 minutos después de alcanzar max intentos

## Cómo Funciona

### 1. Usuario intenta login
```
Usuario escribe email + password
```

### 2. Validación cliente-side
```typescript
// Valida formato antes de enviar
loginSchema.safeParse({ email, password })
```

### 3. Verificación de rate limit
```typescript
// Obtiene IP del usuario
// Consulta tabla login_attempts
// Si hay 5+ fallos en últimos 15 min → BLOQUEADO
// Si está bloqueado → Error + tiempo de espera
// Si permitido → Continúa
```

### 4. Intento de login
```typescript
// Intenta autenticar con Supabase
supabase.auth.signInWithPassword(...)
```

### 5. Log de resultado
```typescript
// Éxito: log en login_attempts con success=true
// Error: log en login_attempts con success=false + motivo
```

## Base de Datos

### Tabla: `login_attempts`

| Campo | Tipo | Descripción |
|-------|------|-------------|
| id | uuid | ID único |
| ip_address | text | IP del usuario |
| email | text | Email intentado (nullable) |
| success | boolean | ¿Login exitoso? |
| failure_reason | text | Motivo si falló |
| user_agent | text | Navegador/cliente |
| created_at | timestamptz | Timestamp |

**Índices**:
- `idx_login_attempts_ip_created` - Búsquedas por IP rápidas
- `idx_login_attempts_created` - Limpieza de registros viejos

**RLS**:
- Solo `dueño` puede ver intentos (para auditoría)
- Append-only (sin delete/update)

## Edge Function: `check-rate-limit`

**Endpoint**: `POST /functions/v1/check-rate-limit`

**Input**:
```json
{
  "ip": "192.168.1.1",
  "email": "user@example.com",
  "success": false,
  "failureReason": "Invalid password",
  "userAgent": "Mozilla/5.0..."
}
```

**Output (Permitido)**:
```json
{
  "allowed": true,
  "attemptsRemaining": 3,
  "message": "Rate limit check passed"
}
```

**Output (Bloqueado)**:
```json
{
  "allowed": false,
  "attemptsRemaining": 0,
  "lockoutUntil": "2026-08-18T15:30:00Z",
  "message": "Demasiados intentos fallidos. Intenta de nuevo en 12 minutos."
}
```

## Flujo de Usuario

### Caso 1: Login exitoso
```
1. Ingresa email + password
2. ✅ Rate limit check OK
3. ✅ Login exitoso
4. Redirige a app
5. Log: success=true
```

### Caso 2: Login fallido (primeros 4 intentos)
```
1. Ingresa email + password
2. ✅ Rate limit check OK (3 intentos previos)
3. ❌ Login fallido
4. Error: "Email o contraseña inválidos"
5. Log: success=false, reason="invalid email"
6. Puede reintentar
```

### Caso 3: Login bloqueado por rate limit
```
1. Ingresa email + password
2. ❌ Rate limit check FAIL (5+ intentos en últimos 15 min)
3. Error: "Demasiados intentos. Intenta en 12 minutos"
4. Log: success=false, reason="rate limit"
5. No puede reintentar hasta esperar
```

## Seguridad

### ✅ Previene
- Ataques de fuerza bruta (probar miles de contraseñas)
- Enumeración de usuarios (testing múltiples emails)
- DDoS de login (saturar con requests)

### ✅ Protecciones adicionales
- Tracking por IP (no por usuario)
- Fail-open (si rate limit check falla, permite login)
- Log de todos los intentos (auditoría)
- User-Agent capturado (detectar bots)

### ⚠️ Limitaciones
- No protege contra ataques desde múltiples IPs
- Usuarios legítimos en red compartida pueden afectarse
- Requiere CORS funcional para obtener IP

## Testing

### Test 1: 5 fallos seguidos
```
1. Intenta login 5 veces con contraseña incorrecta
Resultado: Bloqueado en 6to intento ✓
```

### Test 2: Espera y reintenta
```
1. Intenta 5 veces (bloqueado)
2. Espera 15+ minutos
3. Intenta de nuevo
Resultado: Permitido después de lockout ✓
```

### Test 3: Login exitoso reinicia contador
```
1. Intenta 3 veces (falla)
2. Login exitoso
3. Intenta 5 veces más
Resultado: Contador se reinicia en login exitoso ✓
```

## Monitoreo

### Ver intentos fallidos en últimos 15 min
```sql
SELECT ip_address, COUNT(*) as attempt_count
FROM login_attempts
WHERE success = false
  AND created_at > NOW() - INTERVAL '15 minutes'
GROUP BY ip_address
ORDER BY attempt_count DESC;
```

### Ver IPs bloqueadas
```sql
SELECT DISTINCT ip_address, COUNT(*) as total_attempts
FROM login_attempts
WHERE success = false
  AND created_at > NOW() - INTERVAL '15 minutes'
HAVING COUNT(*) >= 5
ORDER BY total_attempts DESC;
```

### Ver log completo de un usuario
```sql
SELECT * FROM login_attempts
WHERE email = 'user@example.com'
ORDER BY created_at DESC
LIMIT 20;
```

## Ajustes Futuros

Si necesitas cambiar:
- **MAX_ATTEMPTS**: Cambiar en `check-rate-limit/index.ts` línea 9
- **WINDOW_MINUTES**: Línea 10
- **LOCKOUT_MINUTES**: Línea 11
- Después: Deployar Edge Function (`supabase functions deploy check-rate-limit`)
