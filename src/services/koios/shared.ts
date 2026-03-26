export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function getBoundedIntEnv(
  envKey: string,
  defaultValue: number,
  min: number,
  max: number
): number {
  const rawValue = process.env[envKey];
  if (!rawValue) return defaultValue;

  const parsed = Number.parseInt(rawValue, 10);
  if (Number.isNaN(parsed) || parsed < min || parsed > max) {
    return defaultValue;
  }
  return parsed;
}

export function getBooleanEnv(envKey: string, defaultValue = false): boolean {
  const rawValue = process.env[envKey];
  if (!rawValue) return defaultValue;
  const normalized = rawValue.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}
