# 🚜 FARM ERP - Sistema de Gestión Integral para Granja Avícola

**Granja Santo Tomás** - Argentina

---

## 📖 Documentación

### Para Entender el Proyecto

1. **[docs/README.md](./docs/README.md)** - Guía de documentación
2. **[docs/1_ARQUITECTURA_GENERAL.md](./docs/1_ARQUITECTURA_GENERAL.md)** - Arquitectura general
3. **[docs/2_ROADMAP_IMPLEMENTACION.md](./docs/2_ROADMAP_IMPLEMENTACION.md)** - Fases y timeline
4. **[docs/3_FLUJOS_OPERATIVOS_COMPLETOS.md](./docs/3_FLUJOS_OPERATIVOS_COMPLETOS.md)** - Ejemplos paso a paso

### Para Setup

- **[FASE_0_SETUP.md](./FASE_0_SETUP.md)** ← COMIENZA AQUÍ (Setup infraestructura)

---

## 🏗️ Estructura del Proyecto

```
farm-erp/
├── frontend/                 # React + TypeScript + Vite
│   ├── src/
│   │   ├── components/      # Componentes reutilizables
│   │   ├── pages/           # Pantallas principales
│   │   ├── hooks/           # Custom React hooks
│   │   ├── services/        # Llamadas a API/Supabase
│   │   ├── types/           # TypeScript types
│   │   ├── utils/           # Utilidades
│   │   ├── styles/          # CSS/Tailwind
│   │   ├── context/         # Context API
│   │   ├── App.tsx
│   │   └── main.tsx
│   ├── public/
│   ├── package.json
│   ├── tsconfig.json
│   ├── vite.config.ts
│   ├── tailwind.config.ts
│   └── postcss.config.cjs
│
├── backend/
│   ├── supabase/
│   │   ├── migrations/      # SQL migrations
│   │   └── functions/       # Supabase Functions
│   └── package.json
│
├── docs/                     # Documentación
│   ├── README.md
│   ├── 1_ARQUITECTURA_GENERAL.md
│   ├── 2_ROADMAP_IMPLEMENTACION.md
│   └── 3_FLUJOS_OPERATIVOS_COMPLETOS.md
│
├── .github/
│   └── workflows/           # GitHub Actions
│
├── .gitignore
├── .env.example
├── FASE_0_SETUP.md         # Setup inicial
└── README.md (este archivo)
```

---

## 🚀 Quick Start

### 1. Leer Documentación (5 min)

```bash
# Lee estos documentos en orden:
1. docs/README.md
2. docs/1_ARQUITECTURA_GENERAL.md
3. FASE_0_SETUP.md
```

### 2. Setup Infraestructura (FASE 0)

```bash
# Sigue los pasos en FASE_0_SETUP.md
# Duración: ~2 semanas con tareas paralelas
```

### 3. Desarrollo Local

```bash
cd frontend
npm install
npm run dev
```

---

## 📊 Stack Tecnológico

| Capa | Tecnología | Motivo |
|------|-----------|--------|
| **Frontend** | React 18 + TypeScript | Type-safe, modern |
| **Styling** | TailwindCSS | Rápido, responsive |
| **Backend** | Supabase (PostgreSQL) | Managed, simple, escalable |
| **Auth** | Supabase Auth | Integrado con DB |
| **Hosting** | Netlify + Supabase | Low-cost, reliable |
| **Versionado** | GitHub | Estándar, colaborativo |

---

## 🎯 Fases de Desarrollo

### FASE 0 (2 sem) - ACTUAL
- ✅ Repositorio y estructura
- ✅ Frontend boilerplate
- ✅ Supabase setup
- ✅ Auth configurada

### FASE 1 (2 sem)
- [ ] Autenticación funcional
- [ ] CRUD galpones y lotes
- [ ] RLS por empresa

### FASE 2 (2 sem)
- [ ] Producción diaria
- [ ] Clasificación de huevos
- [ ] Stock automático

### FASE 3 (3 sem)
- [ ] Ventas + Cobranza
- [ ] Cuentas por cobrar
- [ ] Clientes

...y más. Ver [docs/2_ROADMAP_IMPLEMENTACION.md](./docs/2_ROADMAP_IMPLEMENTACION.md)

---

## 🔐 Seguridad

- ✅ RLS (Row Level Security) en PostgreSQL
- ✅ Autenticación Supabase
- ✅ Variables de entorno en .env.local
- ✅ Secrets NO en Git (.gitignore)
- ✅ Audit log automático

---

## 📱 Características Principales (V1)

- ✅ Dashboard ejecutivo
- ✅ Producción y clasificación de huevos
- ✅ Alimento balanceado (por receta)
- ✅ Ventas + Cobranza
- ✅ Cuentas por cobrar/pagar
- ✅ Stock automático
- ✅ KPIs y alertas
- ✅ PWA responsive (móvil, tablet, desktop)

---

## 👤 Usuarios

### ADMIN (Dueño)
- Acceso total
- Ver/crear/editar/anular

### COLLABORATOR (Empleado)
- Registrar producción
- Registrar ventas/cobros
- Ver datos (no editar histórico)

---

## 🤝 Colaboradores

- Claudio (Product Owner)
- Claude (Development)

---

## 📝 Licencia

Privado - Granja Santo Tomás

---

## 📞 Contacto

Para dudas o cambios, referirse a los documentos en `/docs/`

---

**Estado:** FASE 0 en progreso 🚀

**Próxima revisión:** Cuando FASE 0 esté completada
