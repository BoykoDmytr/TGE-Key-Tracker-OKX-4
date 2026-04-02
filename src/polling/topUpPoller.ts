// src/polling/topUpPoller.ts
import { type ChainKey, getPublicClient, getExplorerTxUrl } from '../evm/provider.js';
import { getErc20MetaCached, formatUnitsSafe } from '../evm/erc20MetaCache.js';
import { isDuplicate, markDuplicate } from '../dedupe.js';
import { sendTelegramDebug } from '../telegram.js';
import { formatNumberWithCommas } from '../utils/formatNumberWithCommas.js';
import { getDistributors, getActiveChains, touchDistributor, totalTracked } from './distributorStore.js';

const TRANSFER_TOPIC0 = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

const POLL_INTERVAL_MS = Number(process.env.TOPUP_POLL_INTERVAL_MS || 60_000);
const MIN_AMOUNT = Number(process.env.TOPUP_MIN_AMOUNT || 5000);

// Track last checked block per chain
const lastCheckedBlock = new Map<ChainKey, bigint>();

const NETWORK_PRETTY: Record<ChainKey, string> = {
  bsc: 'BSC',
  bsc_testnet: 'BSC Testnet',
  base: 'Base',
  arbitrum: 'Arbitrum',
  ethereum: 'Ethereum',
  avalanche: 'Avalanche',
  optimism: 'Optimism',
};

// Address explorers (for address, not tx)
const DEFAULT_ADDRESS_EXPLORERS: Record<ChainKey, string> = {
  bsc: 'https://bscscan.com/address/',
  bsc_testnet: 'https://testnet.bscscan.com/address/',
  base: 'https://basescan.org/address/',
  arbitrum: 'https://arbiscan.io/address/',
  ethereum: 'https://etherscan.io/address/',
  avalanche: 'https://snowtrace.io/address/',
  optimism: 'https://optimistic.etherscan.io/address/',
};

function escHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function shortenAddress(addr: string): string {
  return `${addr.slice(0, 10)}...${addr.slice(-6)}`;
}

async function initBlockForChain(chainKey: ChainKey): Promise<bigint> {
  const existing = lastCheckedBlock.get(chainKey);
  if (existing) return existing;

  try {
    const client = getPublicClient(chainKey) as any;
    const blockNumber: bigint = await client.getBlockNumber();
    lastCheckedBlock.set(chainKey, blockNumber);
    console.log(`[topUpPoller] initialized ${chainKey} at block ${blockNumber}`);
    return blockNumber;
  } catch (err: any) {
    console.error(`[topUpPoller] failed to init block for ${chainKey}: ${err?.message}`);
    return 0n;
  }
}

async function pollChain(chainKey: ChainKey): Promise<void> {
  const addresses = getDistributors(chainKey);
  if (addresses.length === 0) return;

  const client = getPublicClient(chainKey) as any;

  let fromBlock = lastCheckedBlock.get(chainKey);
  if (!fromBlock) {
    fromBlock = await initBlockForChain(chainKey);
    if (fromBlock === 0n) return;
  }

  let latestBlock: bigint;
  try {
    latestBlock = await client.getBlockNumber();
  } catch (err: any) {
    console.error(`[topUpPoller] ${chainKey} getBlockNumber failed: ${err?.message}`);
    return;
  }

  // Nothing new
  if (latestBlock <= fromBlock) return;

  // Limit block range to avoid huge queries (max 2000 blocks per poll)
  const MAX_BLOCK_RANGE = 2000n;
  const effectiveFrom = latestBlock - fromBlock > MAX_BLOCK_RANGE
    ? latestBlock - MAX_BLOCK_RANGE
    : fromBlock + 1n;

  // Build padded addresses for topics[2] filter
  const paddedAddresses = addresses.map(
    (addr) => ('0x' + addr.slice(2).padStart(64, '0')) as `0x${string}`
  );

  try {
    const logs = await client.request({
      method: 'eth_getLogs',
      params: [{
        fromBlock: `0x${effectiveFrom.toString(16)}`,
        toBlock: `0x${latestBlock.toString(16)}`,
        topics: [
          TRANSFER_TOPIC0,  // topic[0] = Transfer event
          null,              // topic[1] = from (anyone)
          paddedAddresses,   // topic[2] = to (one of our addresses)
        ],
      }],
    });

    if (logs && logs.length > 0) {
      console.log(`[topUpPoller] ${chainKey}: found ${logs.length} Transfer logs in blocks ${effectiveFrom}-${latestBlock}`);
    }

    for (const log of (logs || [])) {
      await processTransferLog(chainKey, log, client);
    }
  } catch (err: any) {
    console.error(`[topUpPoller] ${chainKey} getLogs failed: ${err?.message}`);
    // Don't update lastCheckedBlock on error so we retry
    return;
  }

  lastCheckedBlock.set(chainKey, latestBlock);
}

async function processTransferLog(chainKey: ChainKey, log: any, client: any): Promise<void> {
  try {
    const topics = log.topics || [];
    if (topics.length < 3) return;

    const tokenAddress = (log.address || '').toLowerCase() as `0x${string}`;
    const fromRaw = topics[1];
    const toRaw = topics[2];

    if (!fromRaw || !toRaw) return;

    const from = ('0x' + fromRaw.slice(-40)) as `0x${string}`;
    const to = ('0x' + toRaw.slice(-40)).toLowerCase();
    const txHash = log.transactionHash as string;
    const logIndex = typeof log.logIndex === 'string'
      ? parseInt(log.logIndex, 16)
      : Number(log.logIndex ?? 0);

    // Dedupe
    const dedupeKey = `topup:${chainKey}:${txHash}:${logIndex}:${tokenAddress}:${to}`;
    const dup = await isDuplicate(dedupeKey);
    if (dup) return;

    // Parse value from data
    const data = log.data as string;
    if (!data || data === '0x') return;
    const value = BigInt(data);
    if (value === 0n) return;

    // Get token metadata
    const meta = await getErc20MetaCached(client, tokenAddress);
    const amountHuman = formatUnitsSafe(value, meta.decimals);
    const amountNum = Number(amountHuman);

    // Filter by min amount
    if (!Number.isNaN(amountNum) && amountNum < MIN_AMOUNT) return;

    // Refresh TTL for the distributor
    touchDistributor(chainKey, to);

    const networkPretty = NETWORK_PRETTY[chainKey] || chainKey;
    const amountLine = `${formatNumberWithCommas(amountHuman)} $${meta.symbol}`;
    const explorerTx = getExplorerTxUrl(chainKey, txHash);
    const distributorShort = shortenAddress(to);

    const message =
      `💰 <b>${escHtml('NEW TOP-UP DETECTED')}</b>\n\n` +
      `Amount: ${escHtml(amountLine)}\n` +
      `Network: ${escHtml(networkPretty)}\n` +
      `Distributor: <code>${escHtml(distributorShort)}</code>\n` +
      `<a href="${escHtml(explorerTx)}">${escHtml('View on Scan')}</a>`;

    console.log(`[topUpPoller] ${chainKey}: top-up ${amountLine} to ${distributorShort} tx=${txHash.slice(0, 18)}...`);
    await sendTelegramDebug(message);
    await markDuplicate(dedupeKey);
  } catch (err: any) {
    console.error(`[topUpPoller] processTransferLog error: ${err?.message}`);
  }
}

let pollerTimer: ReturnType<typeof setInterval> | null = null;

async function pollAllChains(): Promise<void> {
  const chains = getActiveChains();
  if (chains.length === 0) return;

  console.log(`[topUpPoller] polling ${chains.length} chains, ${totalTracked()} tracked addresses`);

  // Poll all chains in parallel
  await Promise.allSettled(
    chains.map((chainKey) => pollChain(chainKey))
  );
}

export function startTopUpPoller(): void {
  console.log(`[topUpPoller] starting with interval=${POLL_INTERVAL_MS}ms, minAmount=${MIN_AMOUNT}`);

  // Initial poll after a short delay to let server boot
  setTimeout(() => {
    pollAllChains().catch((err) =>
      console.error('[topUpPoller] initial poll error:', err?.message)
    );
  }, 5_000);

  pollerTimer = setInterval(() => {
    pollAllChains().catch((err) =>
      console.error('[topUpPoller] poll error:', err?.message)
    );
  }, POLL_INTERVAL_MS);
}

export function stopTopUpPoller(): void {
  if (pollerTimer) {
    clearInterval(pollerTimer);
    pollerTimer = null;
    console.log('[topUpPoller] stopped');
  }
}