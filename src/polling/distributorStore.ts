// src/polling/distributorStore.ts
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { ChainKey } from '../evm/provider.js';

const TTL_DAYS = Number(process.env.TOPUP_DISTRIBUTOR_TTL_DAYS || 30);

// ---- Supabase client (lazy init) ----
let supabase: SupabaseClient | null = null;

function getSupabase(): SupabaseClient {
  if (supabase) return supabase;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  }

  supabase = createClient(url, key);
  return supabase;
}

// ---- In-memory cache (refreshed periodically from DB) ----
const cache = new Map<ChainKey, Set<string>>();
let cacheLoadedAt = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // refresh cache every 5 min

async function ensureCache(): Promise<void> {
  if (Date.now() - cacheLoadedAt < CACHE_TTL_MS && cache.size > 0) return;
  await refreshCache();
}

async function refreshCache(): Promise<void> {
  try {
    const cutoff = new Date(Date.now() - TTL_DAYS * 24 * 3600 * 1000).toISOString();

    const { data, error } = await getSupabase()
      .from('tracked_distributors')
      .select('chain_key, address')
      .gte('last_seen_at', cutoff);

    if (error) {
      console.error('[distributorStore] cache refresh error:', error.message);
      return;
    }

    cache.clear();
    for (const row of data || []) {
      const chainKey = row.chain_key as ChainKey;
      let set = cache.get(chainKey);
      if (!set) {
        set = new Set();
        cache.set(chainKey, set);
      }
      set.add(row.address.toLowerCase());
    }

    cacheLoadedAt = Date.now();
    const total = Array.from(cache.values()).reduce((s, set) => s + set.size, 0);
    console.log(`[distributorStore] cache refreshed: ${total} addresses across ${cache.size} chains`);
  } catch (err: any) {
    console.error('[distributorStore] cache refresh exception:', err?.message);
  }
}

// ---- Public API ----

export async function addDistributor(chainKey: ChainKey, address: string): Promise<void> {
  const addr = address.toLowerCase();

  try {
    const { error } = await getSupabase()
      .from('tracked_distributors')
      .upsert(
        {
          chain_key: chainKey,
          address: addr,
          last_seen_at: new Date().toISOString(),
        },
        { onConflict: 'chain_key,address' }
      );

    if (error) {
      console.error('[distributorStore] addDistributor error:', error.message);
      return;
    }

    // Update local cache immediately
    let set = cache.get(chainKey);
    if (!set) {
      set = new Set();
      cache.set(chainKey, set);
    }
    set.add(addr);

    console.log(`[distributorStore] added ${addr} on ${chainKey}`);
  } catch (err: any) {
    console.error('[distributorStore] addDistributor exception:', err?.message);
  }
}

export async function touchDistributor(chainKey: ChainKey, address: string): Promise<void> {
  const addr = address.toLowerCase();

  try {
    const { error } = await getSupabase()
      .from('tracked_distributors')
      .update({ last_seen_at: new Date().toISOString() })
      .eq('chain_key', chainKey)
      .eq('address', addr);

    if (error) {
      console.error('[distributorStore] touchDistributor error:', error.message);
    }
  } catch (err: any) {
    console.error('[distributorStore] touchDistributor exception:', err?.message);
  }
}

export async function getDistributors(chainKey: ChainKey): Promise<string[]> {
  await ensureCache();
  const set = cache.get(chainKey);
  return set ? Array.from(set) : [];
}

export async function getActiveChains(): Promise<ChainKey[]> {
  await ensureCache();
  return Array.from(cache.keys()).filter((k) => {
    const set = cache.get(k);
    return set && set.size > 0;
  });
}

export async function totalTracked(): Promise<number> {
  await ensureCache();
  let total = 0;
  for (const set of cache.values()) total += set.size;
  return total;
}

/** Remove addresses older than TTL_DAYS. Called automatically every hour. */
export async function cleanupExpired(): Promise<void> {
  try {
    const cutoff = new Date(Date.now() - TTL_DAYS * 24 * 3600 * 1000).toISOString();

    const { error, count } = await getSupabase()
      .from('tracked_distributors')
      .delete()
      .lt('last_seen_at', cutoff);

    if (error) {
      console.error('[distributorStore] cleanup error:', error.message);
      return;
    }

    console.log(`[distributorStore] cleanup: removed ${count ?? 0} expired entries`);
    await refreshCache();
  } catch (err: any) {
    console.error('[distributorStore] cleanup exception:', err?.message);
  }
}

/** Load cache from DB at boot + schedule hourly cleanup */
export async function initStore(): Promise<void> {
  await refreshCache();

  setInterval(() => {
    cleanupExpired().catch((err) =>
      console.error('[distributorStore] scheduled cleanup error:', err?.message)
    );
  }, 60 * 60 * 1000);
}