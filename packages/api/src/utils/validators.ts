import { z } from 'zod';

export const passwordSchema = z
  .string()
  .min(12, 'Password must have at least 12 characters')
  .max(72, 'Password must be at most 72 characters')
  .refine(
    pass => /[a-z]/.test(pass) && /[A-Z]/.test(pass),
    'Password must include both lower and upper case characters',
  )
  .refine(pass => /\d/.test(pass), 'Password must include at least one number')
  .refine(
    pass => /[!@#$%^&*(),.?":{}|<>;\-+=]/.test(pass),
    'Password must include at least one special character',
  );

export const validatePassword = (password: string) => {
  if (!password || password.length < 12 || password.length > 64) {
    return false;
  }
  // Must include both lower and upper case
  if (!/[a-z]/.test(password) || !/[A-Z]/.test(password)) {
    return false;
  }
  // Must include at least one number
  if (!/\d/.test(password)) {
    return false;
  }
  // Must include at least one special character (any non-alphanumeric)
  if (!/\W/.test(password)) {
    return false;
  }
  return true;
};
