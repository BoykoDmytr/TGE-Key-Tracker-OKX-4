// src/polling/topUpPoller.ts
import { getPublicClient, getExplorerTxUrl } from '../evm/provider.js';
import { getErc20MetaCached, formatUnitsSafe } from '../evm/erc20MetaCache.js';
import { isDuplicate, markDuplicate } from '../dedupe.js';
import { sendTelegramDebug } from '../telegram.js';
import { formatNumberWithCommas } from '../utils/formatNumberWithCommas.js';
import { getDistributors, getActiveChains, touchDistributor, totalTracked, initStore, } from './distributorStore.js';
const TRANSFER_TOPIC0 = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const POLL_INTERVAL_MS = Number(process.env.TOPUP_POLL_INTERVAL_MS || 60_000);
const MIN_AMOUNT = Number(process.env.TOPUP_MIN_AMOUNT || 5000);
// Track last checked block per chain
const lastCheckedBlock = new Map();
const NETWORK_PRETTY = {
    bsc: 'BSC',
    bsc_testnet: 'BSC Testnet',
    base: 'Base',
    arbitrum: 'Arbitrum',
    ethereum: 'Ethereum',
    avalanche: 'Avalanche',
    optimism: 'Optimism',
};
function escHtml(s) {
    return s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
function shortenAddress(addr) {
    return `${addr.slice(0, 10)}...${addr.slice(-6)}`;
}
async function initBlockForChain(chainKey) {
    const existing = lastCheckedBlock.get(chainKey);
    if (existing)
        return existing;
    try {
        const client = getPublicClient(chainKey);
        const blockNumber = await client.getBlockNumber();
        lastCheckedBlock.set(chainKey, blockNumber);
        console.log(`[topUpPoller] initialized ${chainKey} at block ${blockNumber}`);
        return blockNumber;
    }
    catch (err) {
        console.error(`[topUpPoller] failed to init block for ${chainKey}: ${err?.message}`);
        return 0n;
    }
}
async function pollChain(chainKey) {
    const addresses = await getDistributors(chainKey);
    if (addresses.length === 0)
        return;
    const client = getPublicClient(chainKey);
    let fromBlock = lastCheckedBlock.get(chainKey);
    if (!fromBlock) {
        fromBlock = await initBlockForChain(chainKey);
        if (fromBlock === 0n)
            return;
    }
    let latestBlock;
    try {
        latestBlock = await client.getBlockNumber();
    }
    catch (err) {
        console.error(`[topUpPoller] ${chainKey} getBlockNumber failed: ${err?.message}`);
        return;
    }
    // Nothing new
    if (latestBlock <= fromBlock)
        return;
    // Limit block range to avoid huge queries (max 2000 blocks per poll)
    const MAX_BLOCK_RANGE = 2000n;
    const effectiveFrom = latestBlock - fromBlock > MAX_BLOCK_RANGE
        ? latestBlock - MAX_BLOCK_RANGE
        : fromBlock + 1n;
    // Build padded addresses for topics[2] filter
    const paddedAddresses = addresses.map((addr) => ('0x' + addr.slice(2).padStart(64, '0')));
    try {
        const logs = await client.request({
            method: 'eth_getLogs',
            params: [{
                    fromBlock: `0x${effectiveFrom.toString(16)}`,
                    toBlock: `0x${latestBlock.toString(16)}`,
                    topics: [
                        TRANSFER_TOPIC0, // topic[0] = Transfer event
                        null, // topic[1] = from (anyone)
                        paddedAddresses, // topic[2] = to (one of our addresses)
                    ],
                }],
        });
        if (logs && logs.length > 0) {
            console.log(`[topUpPoller] ${chainKey}: found ${logs.length} Transfer logs in blocks ${effectiveFrom}-${latestBlock}`);
        }
        for (const log of (logs || [])) {
            await processTransferLog(chainKey, log, client);
        }
    }
    catch (err) {
        console.error(`[topUpPoller] ${chainKey} getLogs failed: ${err?.message}`);
        // Don't update lastCheckedBlock on error so we retry
        return;
    }
    lastCheckedBlock.set(chainKey, latestBlock);
}
async function processTransferLog(chainKey, log, client) {
    try {
        const topics = log.topics || [];
        if (topics.length < 3)
            return;
        const tokenAddress = (log.address || '').toLowerCase();
        const fromRaw = topics[1];
        const toRaw = topics[2];
        if (!fromRaw || !toRaw)
            return;
        const from = ('0x' + fromRaw.slice(-40));
        const to = ('0x' + toRaw.slice(-40)).toLowerCase();
        const txHash = log.transactionHash;
        const logIndex = typeof log.logIndex === 'string'
            ? parseInt(log.logIndex, 16)
            : Number(log.logIndex ?? 0);
        // Dedupe
        const dedupeKey = `topup:${chainKey}:${txHash}:${logIndex}:${tokenAddress}:${to}`;
        const dup = await isDuplicate(dedupeKey);
        if (dup)
            return;
        // Parse value from data
        const data = log.data;
        if (!data || data === '0x')
            return;
        const value = BigInt(data);
        if (value === 0n)
            return;
        // Get token metadata
        const meta = await getErc20MetaCached(client, tokenAddress);
        const amountHuman = formatUnitsSafe(value, meta.decimals);
        const amountNum = Number(amountHuman);
        // Filter by min amount
        if (!Number.isNaN(amountNum) && amountNum < MIN_AMOUNT)
            return;
        // Refresh TTL for the distributor in Supabase
        await touchDistributor(chainKey, to);
        const networkPretty = NETWORK_PRETTY[chainKey] || chainKey;
        const amountLine = `${formatNumberWithCommas(amountHuman)} $${meta.symbol}`;
        const explorerTx = getExplorerTxUrl(chainKey, txHash);
        const distributorShort = shortenAddress(to);
        const message = `💰 <b>${escHtml('NEW TOP-UP DETECTED')}</b>\n\n` +
            `Amount: ${escHtml(amountLine)}\n` +
            `Network: ${escHtml(networkPretty)}\n` +
            `Distributor: <code>${escHtml(distributorShort)}</code>\n` +
            `<a href="${escHtml(explorerTx)}">${escHtml('View on Scan')}</a>`;
        console.log(`[topUpPoller] ${chainKey}: top-up ${amountLine} to ${distributorShort} tx=${txHash.slice(0, 18)}...`);
        await sendTelegramDebug(message);
        await markDuplicate(dedupeKey);
    }
    catch (err) {
        console.error(`[topUpPoller] processTransferLog error: ${err?.message}`);
    }
}
let pollerTimer = null;
async function pollAllChains() {
    const chains = await getActiveChains();
    if (chains.length === 0)
        return;
    const total = await totalTracked();
    console.log(`[topUpPoller] polling ${chains.length} chains, ${total} tracked addresses`);
    await Promise.allSettled(chains.map((chainKey) => pollChain(chainKey)));
}
export async function startTopUpPoller() {
    console.log(`[topUpPoller] starting with interval=${POLL_INTERVAL_MS}ms, minAmount=${MIN_AMOUNT}`);
    // Load addresses from Supabase into cache
    await initStore();
    // Initial poll after a short delay
    setTimeout(() => {
        pollAllChains().catch((err) => console.error('[topUpPoller] initial poll error:', err?.message));
    }, 5_000);
    pollerTimer = setInterval(() => {
        pollAllChains().catch((err) => console.error('[topUpPoller] poll error:', err?.message));
    }, POLL_INTERVAL_MS);
}
export function stopTopUpPoller() {
    if (pollerTimer) {
        clearInterval(pollerTimer);
        pollerTimer = null;
        console.log('[topUpPoller] stopped');
    }
}
