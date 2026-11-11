export const ROLES = ['admin', 'client'] as const;
export type Role = typeof ROLES[number];

const USERNAME_RE = /^[A-Za-z0-9_.-]{1,64}$/;
// bcrypt ignores everything past 72 bytes, so longer passwords would be silently truncated.
const MAX_PASSWORD_BYTES = 72;
const MIN_PASSWORD = { admin: 16, client: 12 } as const;

export function isValidRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}

export function validateUsername(value: unknown): string | null {
  if (typeof value !== 'string' || !USERNAME_RE.test(value)) {
    return 'Username must be 1-64 characters: letters, digits, dot, dash or underscore';
  }
  return null;
}

export function validatePassword(value: unknown, role: Role): string | null {
  if (typeof value !== 'string') return 'Password is required';
  const min = MIN_PASSWORD[role];
  if (value.length < min) return `Password must be at least ${min} characters for ${role} users`;
  if (Buffer.byteLength(value, 'utf8') > MAX_PASSWORD_BYTES) return `Password must be at most ${MAX_PASSWORD_BYTES} bytes`;
  return null;
}

export function validateEmail(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
    return 'Invalid email address';
  }
  return null;
}
