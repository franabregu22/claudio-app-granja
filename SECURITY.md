# Security Hardening Plan - Granja Santo Tomás

## Estado Actual ✅
- [x] RLS en todas las tablas (SELECT auth, INSERT/UPDATE/DELETE dueño solo)
- [x] CORS restrictivo (solo https://santotomasapp.netlify.app)
- [x] Bearer token en Edge Function (EDGE_FUNCTION_SECRET)
- [x] Secrets en env vars (no hardcoded)
- [x] API keys rotadas

## Faltantes - CRÍTICOS 🔴

### 1. Rate Limiting en Login (Prevenir Fuerza Bruta)
**Riesgo**: Atacante puede probar miles de contraseñas/emails
**Solución**: Implementar rate limit en Edge Function de login
```
- Max 5 intentos fallidos por IP en 15 minutos
- Lockout temporal de 15 minutos
- Log de intentos fallidos
```

### 2. DDoS Protection
**Riesgo**: Atacante satura con requests
**Solución**:
- Supabase: 200 req/seg por IP (ya configurado)
- Netlify: usar Netlify DDoS protection (habilitado por defecto)
- Considerar: Cloudflare Free plan (CORS + DDoS)

### 3. SQL Injection Prevention
**Estado**: ✅ Supabase usa prepared statements
**Verificar**: Todas las queries usan parámetros, no string concatenation

### 4. XSS/CSRF Protection
**Estado**: ✅ React sanitiza por defecto
**Verificar**: No usar `dangerouslySetInnerHTML`

### 5. Validación de Entrada
**Faltante**: Validar datos en Edge Function y Cliente
```
- Email válido en login
- Montos > 0
- Fechas válidas
- Strings no vacíos
```

### 6. Logging & Monitoring
**Faltante**: Auditoría de acciones sensibles
```
- Intentos de login fallidos
- Cambios en datos financieros
- Accesos a Edge Function
```

### 7. Backup & Disaster Recovery
**Faltante**: Plan de recuperación ante compromiso
```
- Backups automáticos de BD (Supabase: habilitado)
- Regeneración rápida de keys
- Plan de incident response
```

## Prioridad de Implementación

### FASE 1 - ESTA SEMANA (Crítico)
1. **Rate limiting en login** ⚠️
   - Archivo: `supabase/functions/auth-rate-limit/index.ts` (nueva)
   - O: Agregar a Edge Function existente

2. **Validación de entrada** ⚠️
   - Archivos: `src/auth/LoginScreen.tsx`, `src/api/*.ts`
   - Usar: `zod` o `yup` para schemas

### FASE 2 - PRÓXIMA SEMANA
3. **Logging de auditoría** 
   - Nueva tabla: `audit_logs`
   - Registrar: logins, cambios financieros, accesos admin

4. **Monitoreo de alertas**
   - Supabase logs → email/Slack si:
     - Múltiples fallos de login
     - Cambios grandes en datos financieros
     - Accesos a Edge Function fallidos

### FASE 3 - ESTE MES
5. **Secrets rotation**
   - Plan mensual de regeneración
   - Versionado de keys

6. **Security headers HTTP**
   - `Strict-Transport-Security`
   - `X-Content-Type-Options: nosniff`
   - `X-Frame-Options: DENY`

## Checklist Seguridad Actual

- [x] RLS habilitado todas tablas
- [x] CORS restrictivo
- [x] Secrets en env vars
- [x] API keys rotadas
- [x] Bearer token Edge Function
- [ ] Rate limit login
- [ ] Validación entrada
- [ ] Logging auditoría
- [ ] Alertas de seguridad
- [ ] Monitoreo de errores
- [ ] Backup plan
- [ ] Security headers HTTP

## Comandos de Verificación

```bash
# Verificar RLS en todas las tablas
SELECT tablename FROM pg_tables 
WHERE schemaname = 'public' 
AND EXISTS (
  SELECT 1 FROM pg_policies 
  WHERE pg_policies.tablename = pg_tables.tablename
);

# Ver políticas activas
SELECT tablename, policyname, permissive 
FROM pg_policies 
WHERE schemaname = 'public';

# Ver intentos de acceso rechazados
SELECT * FROM pg_stat_statements 
WHERE query LIKE '%permission%' 
LIMIT 10;
```

## Recursos

- [OWASP Top 10](https://owasp.org/Top10/)
- [Supabase Security](https://supabase.com/docs/guides/security/row-level-security)
- [Netlify Security](https://docs.netlify.com/security/)
- [MercadoPago API Security](https://www.mercadopago.com/developers/en/docs/security/threats-and-prevention)
