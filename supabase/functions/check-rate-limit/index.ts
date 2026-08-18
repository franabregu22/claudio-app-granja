import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

// Rate limiting config
const MAX_ATTEMPTS = 5;
const WINDOW_MINUTES = 15;
const LOCKOUT_MINUTES = 15;

interface RateLimitResponse {
  allowed: boolean;
  attemptsRemaining: number;
  lockoutUntil?: string;
  message: string;
}

const getCorsHeaders = (origin: string | null) => {
  const allowedOrigins = [
    "https://santotomasapp.netlify.app",
    "http://localhost:5173",
    "http://localhost:3000",
  ];

  const corsOrigin = origin && allowedOrigins.includes(origin) ? origin : allowedOrigins[0];

  return {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": corsOrigin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
};

serve(async (req) => {
  const origin = req.headers.get("origin");
  const corsHeaders = getCorsHeaders(origin);

  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: corsHeaders,
    });
  }

  // Only POST allowed
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "POST only" }), {
      status: 405,
      headers: corsHeaders,
    });
  }

  try {
    const { ip, email, success, failureReason, userAgent } = await req.json();

    if (!ip) {
      return new Response(
        JSON.stringify({ error: "IP address required" }),
        { status: 400, headers: corsHeaders }
      );
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

    // 1. Log this attempt
    const { error: logError } = await supabase.from("login_attempts").insert({
      ip_address: ip,
      email: email || null,
      success: success || false,
      failure_reason: failureReason || null,
      user_agent: userAgent || null,
    });

    if (logError) {
      console.error("Error logging attempt:", logError);
    }

    // 2. Check if IP is currently locked out
    const lockoutWindowStart = new Date();
    lockoutWindowStart.setMinutes(lockoutWindowStart.getMinutes() - LOCKOUT_MINUTES);

    const { data: recentSuccessData } = await supabase
      .from("login_attempts")
      .select("created_at")
      .eq("ip_address", ip)
      .eq("success", true)
      .gte("created_at", lockoutWindowStart.toISOString())
      .order("created_at", { ascending: false })
      .limit(1);

    // If there's a recent successful login, reset the counter
    if (recentSuccessData && recentSuccessData.length > 0) {
      return new Response(
        JSON.stringify({
          allowed: true,
          attemptsRemaining: MAX_ATTEMPTS,
          message: "Rate limit check passed",
        } as RateLimitResponse),
        { status: 200, headers: corsHeaders }
      );
    }

    // 3. Count failed attempts in the time window
    const windowStart = new Date();
    windowStart.setMinutes(windowStart.getMinutes() - WINDOW_MINUTES);

    const { data: failedAttempts, count: failureCount } = await supabase
      .from("login_attempts")
      .select("*", { count: "exact" })
      .eq("ip_address", ip)
      .eq("success", false)
      .gte("created_at", windowStart.toISOString());

    if (!failureCount) {
      return new Response(
        JSON.stringify({
          allowed: true,
          attemptsRemaining: MAX_ATTEMPTS,
          message: "Rate limit check passed",
        } as RateLimitResponse),
        { status: 200, headers: corsHeaders }
      );
    }

    const failuresSinceWindow = failureCount;

    // 4. Check if locked out
    if (failuresSinceWindow >= MAX_ATTEMPTS) {
      const oldestFailedAttempt = failedAttempts?.[0];
      if (oldestFailedAttempt) {
        const lockoutUntil = new Date(oldestFailedAttempt.created_at);
        lockoutUntil.setMinutes(lockoutUntil.getMinutes() + LOCKOUT_MINUTES);

        if (new Date() < lockoutUntil) {
          return new Response(
            JSON.stringify({
              allowed: false,
              attemptsRemaining: 0,
              lockoutUntil: lockoutUntil.toISOString(),
              message: `Demasiados intentos fallidos. Intenta de nuevo en ${Math.ceil(
                (lockoutUntil.getTime() - new Date().getTime()) / 60000
              )} minutos.`,
            } as RateLimitResponse),
            { status: 429, headers: corsHeaders }
          );
        }
      }
    }

    // 5. Allow attempt, calculate remaining
    const attemptsRemaining = Math.max(0, MAX_ATTEMPTS - failuresSinceWindow);

    return new Response(
      JSON.stringify({
        allowed: true,
        attemptsRemaining,
        message: "Rate limit check passed",
      } as RateLimitResponse),
      { status: 200, headers: corsHeaders }
    );
  } catch (error) {
    console.error("Error:", error);
    return new Response(
      JSON.stringify({ error: "Internal server error" }),
      { status: 500, headers: corsHeaders }
    );
  }
});
