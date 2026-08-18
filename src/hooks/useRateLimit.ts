import { useState } from 'react';

interface RateLimitResponse {
  allowed: boolean;
  attemptsRemaining: number;
  lockoutUntil?: string;
  message: string;
}

export function useRateLimit() {
  const [isChecking, setIsChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const getClientIp = (): Promise<string> => {
    return fetch('https://api.ipify.org?format=json')
      .then((res) => res.json())
      .then((data) => data.ip)
      .catch(() => 'unknown');
  };

  const checkRateLimit = async (email?: string, success?: boolean, failureReason?: string): Promise<RateLimitResponse | null> => {
    setIsChecking(true);
    setError(null);

    try {
      const ip = await getClientIp();
      const userAgent = navigator.userAgent;

      const response = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/check-rate-limit`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}`,
          },
          body: JSON.stringify({
            ip,
            email,
            success: success ?? false,
            failureReason,
            userAgent,
          }),
        }
      );

      const data = (await response.json()) as RateLimitResponse;

      if (response.status === 429) {
        setError(data.message);
        return data;
      }

      if (!response.ok) {
        setError('Error al verificar rate limit');
        return null;
      }

      return data;
    } catch (err) {
      console.error('Rate limit check failed:', err);
      // Fail open - allow attempt if rate limit check fails
      return {
        allowed: true,
        attemptsRemaining: 5,
        message: 'Rate limit check unavailable',
      };
    } finally {
      setIsChecking(false);
    }
  };

  return {
    checkRateLimit,
    isChecking,
    error,
  };
}
