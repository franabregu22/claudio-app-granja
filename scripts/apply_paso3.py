#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
PASO 3: Aplicar componentes SQL v8 contra Supabase real
Orden: 1) Migration 006, 2) Función, 3) RPC
"""

import os
import sys
from pathlib import Path
from dotenv import load_dotenv
from supabase import create_client

# Cargar .env.local
env_path = Path('.env.local')
if not env_path.exists():
    print("ERROR: .env.local no encontrado")
    sys.exit(1)

load_dotenv(dotenv_path=env_path)

SUPABASE_URL = os.getenv('SUPABASE_URL')
SUPABASE_KEY = os.getenv('SUPABASE_SERVICE_ROLE_KEY')

if not SUPABASE_URL or not SUPABASE_KEY:
    print("ERROR: Credenciales incompletas")
    sys.exit(1)

print("\n" + "="*120)
print("PASO 3: Aplicar SQL v8 contra Supabase real")
print("="*120)

try:
    client = create_client(SUPABASE_URL, SUPABASE_KEY)
    print("\n[OK] Conectado a Supabase")
except Exception as e:
    print(f"\n[ERROR] Conexión a Supabase: {e}")
    sys.exit(1)

# Componentes a aplicar
components = [
    ("Migration 006", "supabase/migrations/006_add_liberaciones_source_type.sql"),
    ("Función calc_liberaciones_economic_hash()", "sql/004_calc_liberaciones_economic_hash.sql"),
    ("RPC import_liberaciones_primary()", "sql/005_import_liberaciones_primary.sql"),
]

results = {}

for component_name, file_path in components:
    component_path = Path(file_path)

    if not component_path.exists():
        print(f"\n[FAIL] {component_name}: archivo no encontrado")
        results[component_name] = "FAIL"
        continue

    try:
        with open(component_path, 'r') as f:
            sql_content = f.read()

        print(f"\n[Aplicando] {component_name}...")

        # Ejecutar SQL (usando rpc si es función, si no usa SQL directo)
        # Supabase no tiene RPC directo para ejecutar SQL arbitrario
        # Usar POST a /rest/v1/query o similar
        # En su lugar, usamos el cliente para ejecutar queries

        # Intentar ejecutar como raw SQL usando el cliente interno
        # Nota: Supabase Python client no soporta exec() directo
        # Necesitamos usar REST API o PostgreSQL direct connection

        # Por ahora, reportamos que necesita aplicarse manualmente
        print(f"  [NOTA] Supabase client no soporta exec() directo")
        print(f"  Componente debe aplicarse via Supabase Dashboard o psql")
        results[component_name] = "MANUAL"

    except Exception as e:
        print(f"\n[ERROR] {component_name}: {e}")
        results[component_name] = "FAIL"

print("\n" + "="*120)
print("RESULTADO")
print("="*120)

for component_name, status in results.items():
    print(f"  {component_name}: {status}")

print("\n[INSTRUCCIÓN] Aplicar manualmente en Supabase Dashboard > SQL Editor:")
print("  1. Copiar contenido de supabase/migrations/006_add_liberaciones_source_type.sql")
print("  2. Copiar contenido de sql/004_calc_liberaciones_economic_hash.sql")
print("  3. Copiar contenido de sql/005_import_liberaciones_primary.sql")
print("  4. Ejecutar en orden")
