// src/polling/distributorStore.ts
import type { ChainKey } from '../evm/provider.js';

const TTL_DAYS = Number(process.env.TOPUP_DISTRIBUTOR_TTL_DAYS || 30);
const TTL_MS = TTL_DAYS * 24 * 3600 * 1000;

/** address (lowercased) -> expiresAtMs */
type TrackedEntry = Map<string, number>;

/** chainKey -> Map<address, expiresAt> */
const store = new Map<ChainKey, TrackedEntry>();

export function addDistributor(chainKey: ChainKey, address: string): void {
  const addr = address.toLowerCase();
  let chain = store.get(chainKey);
  if (!chain) {
    chain = new Map();
    store.set(chainKey, chain);
  }
  chain.set(addr, Date.now() + TTL_MS);
  console.log(`[distributorStore] added ${addr} on ${chainKey} (TTL=${TTL_DAYS}d, total=${chain.size})`);
}

/** Refresh TTL when a top-up is detected */
export function touchDistributor(chainKey: ChainKey, address: string): void {
  const addr = address.toLowerCase();
  const chain = store.get(chainKey);
  if (chain?.has(addr)) {
    chain.set(addr, Date.now() + TTL_MS);
  }
}

/** Get all non-expired addresses for a chain */
export function getDistributors(chainKey: ChainKey): string[] {
  const chain = store.get(chainKey);
  if (!chain) return [];
  const now = Date.now();
  const result: string[] = [];
  for (const [addr, exp] of chain) {
    if (exp < now) {
      chain.delete(addr);
    } else {
      result.push(addr);
    }
  }
  return result;
}

/** Get all chains that have tracked distributors */
export function getActiveChains(): ChainKey[] {
  const result: ChainKey[] = [];
  for (const [chainKey, chain] of store) {
    // cleanup expired first
    const now = Date.now();
    for (const [addr, exp] of chain) {
      if (exp < now) chain.delete(addr);
    }
    if (chain.size > 0) result.push(chainKey);
  }
  return result;
}

/** Total tracked addresses across all chains */
export function totalTracked(): number {
  let total = 0;
  for (const chain of store.values()) {
    total += chain.size;
  }
  return total;
}