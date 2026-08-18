-- Track login attempts for rate limiting
CREATE TABLE IF NOT EXISTS public.login_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ip_address text NOT NULL,
  email text,
  success boolean NOT NULL,
  failure_reason text,
  user_agent text,
  created_at timestamptz DEFAULT now()
);

-- Index for fast lookups by IP
CREATE INDEX IF NOT EXISTS idx_login_attempts_ip_created
ON login_attempts(ip_address, created_at DESC);

-- Index for cleanup queries
CREATE INDEX IF NOT EXISTS idx_login_attempts_created
ON login_attempts(created_at DESC);

-- Enable RLS
ALTER TABLE login_attempts ENABLE ROW LEVEL SECURITY;

-- Only dueño can view login attempts (for auditing)
CREATE POLICY "login_attempts_select_dueño" ON login_attempts
  FOR SELECT USING (is_dueño());

-- Only service role can insert (from Edge Function)
-- No delete/update policies - append-only audit log
