import os
import psycopg2
from pathlib import Path

# Read .env.local
env_path = Path('.env.local')
with open(env_path) as f:
    for line in f:
        line = line.strip()
        if not line or line.startswith('#'):
            continue
        if '=' in line:
            key, value = line.split('=', 1)
            os.environ[key.strip()] = value.strip()

# Get Supabase connection details
SUPABASE_URL = os.environ.get('SUPABASE_URL', '')
API_KEY = os.environ.get('SUPABASE_SERVICE_ROLE_KEY', '')

# Extract PostgreSQL connection from SUPABASE_URL
if 'supabase.co' in SUPABASE_URL:
    project_ref = SUPABASE_URL.replace('https://', '').replace('.supabase.co', '')
    db_host = f'{project_ref}.supabase.co'
else:
    print("[ERROR] Cannot parse Supabase URL")
    exit(1)

db_name = 'postgres'
db_user = 'postgres'
db_port = 5432

print(f"[INFO] Connecting to {db_host}:{db_port}/{db_name}...")

try:
    conn = psycopg2.connect(
        host=db_host,
        port=db_port,
        database=db_name,
        user=db_user,
        password=API_KEY,
        sslmode='require'
    )

    cursor = conn.cursor()

    # Read and execute SQL file
    with open('supabase/sql/008_reconciliation_rpc.sql', 'r') as f:
        sql_content = f.read()

    # Execute SQL
    print("[INFO] Executing SQL functions...")
    cursor.execute(sql_content)
    conn.commit()

    print("[SUCCESS] Functions deployed successfully")
    cursor.close()
    conn.close()

except Exception as e:
    print(f"[ERROR] {str(e)}")
    exit(1)
