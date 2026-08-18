import { useState } from 'react';
import { z } from 'zod';

interface UseFormValidationOptions<T> {
  schema: z.ZodSchema<T>;
  onSubmit: (data: T) => Promise<void> | void;
}

export function useFormValidation<T>(options: UseFormValidationOptions<T>) {
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [generalError, setGeneralError] = useState<string | null>(null);

  const validate = (data: unknown): data is T => {
    const result = options.schema.safeParse(data);
    if (result.success) {
      setErrors({});
      return true;
    }

    const newErrors: Record<string, string> = {};
    const zodError = result.error as any;
    zodError.errors?.forEach((error: any) => {
      const path = error.path.join('.');
      newErrors[path] = error.message;
    });
    setErrors(newErrors);
    return false;
  };

  const handleSubmit = async (data: unknown) => {
    setGeneralError(null);

    if (!validate(data)) {
      return;
    }

    setIsSubmitting(true);
    try {
      await options.onSubmit(data);
    } catch (err) {
      setGeneralError(err instanceof Error ? err.message : 'Error desconocido');
    } finally {
      setIsSubmitting(false);
    }
  };

  return {
    errors,
    isSubmitting,
    generalError,
    validate,
    handleSubmit,
    clearErrors: () => setErrors({}),
    clearError: (field: string) => {
      setErrors((prev) => {
        const newErrors = { ...prev };
        delete newErrors[field];
        return newErrors;
      });
    },
  };
}
