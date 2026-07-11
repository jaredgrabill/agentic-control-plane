import process from 'node:process';

/**
 * Environment-backed configuration with loud failures: a missing required
 * variable names itself and where to set it, because "undefined is not a
 * function" three services later is not operator UX.
 */
export function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(
      `missing required environment variable ${name} — set it in the service environment (see .env.example)`,
    );
  }
  return value;
}

export function env(name: string, fallback: string): string {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

export function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) {
    throw new Error(`environment variable ${name}=${JSON.stringify(raw)} is not an integer`);
  }
  return parsed;
}
