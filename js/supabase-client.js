// Supabase browser client factory, intentionally unused by the production app
// until a separately reviewed cutover. Supply only a project URL and a
// publishable key (or legacy anon JWT) from runtime configuration.
const SUPABASE_JS_URL = 'https://esm.sh/@supabase/supabase-js@2';

function jwtRole(key) {
  const parts = key.split('.');
  if (parts.length !== 3 || typeof atob !== 'function') return null;
  try {
    const segment = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = segment + '='.repeat((4 - segment.length % 4) % 4);
    const claims = JSON.parse(atob(padded));
    return typeof claims.role === 'string' ? claims.role : null;
  } catch (_) {
    return null;
  }
}

function validateClientConfig(config) {
  const url = typeof config?.url === 'string' ? config.url.trim() : '';
  const publishableKey = typeof config?.publishableKey === 'string'
    ? config.publishableKey.trim()
    : '';

  if (!url) throw new TypeError('A Supabase project URL is required.');
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error();
  } catch (_) {
    throw new TypeError('The Supabase project URL must be a valid HTTP(S) URL.');
  }
  if (!publishableKey) throw new TypeError('A Supabase publishable key is required.');

  const role = jwtRole(publishableKey);
  if (publishableKey.toLowerCase().startsWith('sb_secret_') || role === 'service_role') {
    throw new TypeError('Service-role/secret keys must never be used in browser code.');
  }
  if (!publishableKey.toLowerCase().startsWith('sb_publishable_') && role !== 'anon') {
    throw new TypeError('Use a Supabase publishable key or a legacy anon key.');
  }

  return { url, publishableKey };
}

/**
 * Lazily loads Supabase JS so the live Firebase app has no Supabase network or
 * auth side effects until a caller explicitly creates this separate client.
 */
export async function createSupabaseClient(config) {
  const { url, publishableKey } = validateClientConfig(config);
  const { createClient } = await import(SUPABASE_JS_URL);
  return createClient(url, publishableKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true
    }
  });
}
