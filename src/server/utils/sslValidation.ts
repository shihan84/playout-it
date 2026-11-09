const LABEL = '[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?';
const DOMAIN_RE = new RegExp(`^(?:${LABEL}\\.)+[a-zA-Z]{2,63}$`);
const EMAIL_RE = new RegExp(`^[A-Za-z0-9._%+-]{1,64}@(?:${LABEL}\\.)+[a-zA-Z]{2,63}$`);

/** Fully qualified hostname only (letters, digits, hyphens, dots); no shell or path characters. */
export function isValidDomain(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 253 && DOMAIN_RE.test(value);
}

/** Conservative email check for the certbot registration address. */
export function isValidEmail(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 254 && EMAIL_RE.test(value);
}
