// What NODE_ENV=production requires of the registry's environment. The server refuses to start with
// any of these problems, rather than run a public deployment on demo defaults.

export type Env = Record<string, string | undefined>;

export const isProduction = (env: Env): boolean => env.NODE_ENV === 'production';

/** Every reason this environment can't run in production; empty when it can. */
export function productionProblems(env: Env): string[] {
  const problems: string[] = [];
  const need = (name: string, why: string) => {
    if (!env[name]?.trim()) problems.push(`${name} is required in production: ${why}.`);
  };
  need('REGISTRY_PUBLIC_URL', 'the public https URL, which is also the token issuer');
  if (env.REGISTRY_PUBLIC_URL && !/^https:\/\/[^/]+\/?$/.test(env.REGISTRY_PUBLIC_URL)) problems.push('REGISTRY_PUBLIC_URL must be an https origin, with no path.');
  need('DATABASE_URL', 'production state lives in Postgres');
  need('USHER_SIGNING_KEY', 'a generated key would change on every new database (npm run keygen)');
  need('USHER_DAILY_MODEL_BUDGET_USD', 'a hard daily cap on model spend, set on purpose');
  const budget = Number(env.USHER_DAILY_MODEL_BUDGET_USD);
  if (env.USHER_DAILY_MODEL_BUDGET_USD?.trim() && !(Number.isFinite(budget) && budget > 0)) problems.push('USHER_DAILY_MODEL_BUDGET_USD must be a positive number of dollars.');
  need('USHER_ADMIN_KEY', 'it signs in to /admin');
  if (env.USHER_ADMIN_KEY?.trim() && env.USHER_ADMIN_KEY.length < 32) problems.push('USHER_ADMIN_KEY must be at least 32 characters.');
  need('USHER_CONTACT_EMAIL', 'the privacy notice and security.txt name it');
  if (env.USHER_VIEWER === 'open' || env.USHER_VIEWER === '1') problems.push(`USHER_VIEWER=${env.USHER_VIEWER}: an open map viewer is for local demos only; in production visitors pick from a fixed list and owners map their own sites.`);
  if (env.USHER_ALLOW_PRIVATE === '1') problems.push('USHER_ALLOW_PRIVATE=1 is for local demos only: in production the viewer and claim checks must refuse private addresses.');
  for (const name of ['USHER_DEV_SITE_ORIGIN', 'USHER_DEV_SITE_KEY', 'USHER_DEV_SECRET_KEY', 'USHER_DEMO']) {
    if (env[name]) problems.push(`${name} is for local development only; unset it in production.`);
  }
  return problems;
}

/** Trusted proxy hops: TRUSTED_PROXY_HOPS, else 2 in production (CloudFront, then the ALB) and 0 elsewhere. */
export function proxyHops(env: Env): number {
  const raw = env.TRUSTED_PROXY_HOPS?.trim();
  if (!raw) return isProduction(env) ? 2 : 0;
  const hops = Number(raw);
  if (!Number.isInteger(hops) || hops < 0 || hops > 5) throw new Error('TRUSTED_PROXY_HOPS must be a whole number from 0 to 5.');
  return hops;
}
