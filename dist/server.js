// src/server.ts
import 'dotenv/config';
import express from 'express';
import * as pinoHttpNS from 'pino-http';
import { verifyTenderlySignature } from './tenderly/verify.js';
import { extractTransfersFromReceipt } from './tenderly/parseTransfers.js';
import { getPublicClient, getExplorerTxUrl } from './evm/provider.js';
import { getErc20MetaCached, formatUnitsSafe } from './evm/erc20MetaCache.js';
import { isDuplicate, markDuplicate } from './dedupe.js';
import { sendTelegram } from './telegram.js';
import { formatNumberWithCommas } from './utils/formatNumberWithCommas.js';
// Flow 2: top-up polling
import { addDistributor } from './polling/distributorStore.js';
import { startTopUpPoller } from './polling/topUpPoller.js';
const app = express();
// ✅ GLOBAL MIN AMOUNT FILTER (tokens)
const MIN_TOKEN_AMOUNT = 5000;
// DistributorCreated event topic0
const DISTRIBUTOR_CREATED_TOPIC0 = '0xe31b7f4b4f3b6042afb5723869d989be921bea013625e326792f25a623ea6c20';
// ====== BOOT LOG ======
console.log('[boot] server.ts version=2026-04-02 allTokensMode=ON topUpPoller=ON');
console.log('[boot] NODE_ENV=%s PORT=%s', process.env.NODE_ENV, process.env.PORT);
console.log('[boot] CHAINS=%s', process.env.CHAINS || '(not set)');
console.log('[boot] INTERACTION_CONTRACT=%s', process.env.INTERACTION_CONTRACT || '(not set)');
console.log('[boot] THRESHOLDS_JSON=%s', process.env.THRESHOLDS_JSON ? '(set)' : '(not set)');
console.log('[boot] TOKEN_LABELS_JSON=%s', process.env.TOKEN_LABELS_JSON ? '(set)' : '(not set)');
console.log('[boot] TENDERLY_SIGNING_KEY=%s', process.env.TENDERLY_SIGNING_KEY ? '(set)' : '(not set)');
console.log('[boot] TELEGRAM_CHAT_ID_DEBUG=%s', process.env.TELEGRAM_CHAT_ID_DEBUG ? '(set)' : '(not set)');
console.log('[boot] TOPUP_POLL_INTERVAL_MS=%s', process.env.TOPUP_POLL_INTERVAL_MS || '60000 (default)');
const pinoHttp = pinoHttpNS.default ?? pinoHttpNS;
app.use(pinoHttp());
// ====== ROUTES ======
app.get('/health', (_req, res) => res.status(200).send('ok'));
app.get('/webhooks/tenderly', (_req, res) => res.status(200).send('ok - use POST here'));
// ====== TELEGRAM MARKDOWNV2 HELPERS ======
function escMdV2(s) {
    return s.replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
}
function escMdV2Url(url) {
    return url.replace(/\\/g, '\\\\').replace(/\)/g, '\\)');
}
// ====== EXTRACT DISTRIBUTOR ADDRESS FROM RECEIPT LOGS ======
async function extractDistributorAddresses(receipt, chainKey) {
    const logs = receipt?.logs ?? [];
    for (const log of logs) {
        const topics = log.topics ?? [];
        if (!topics[0] || typeof topics[0] !== 'string')
            continue;
        if (topics[0].toLowerCase() !== DISTRIBUTOR_CREATED_TOPIC0)
            continue;
        // DistributorCreated(address owner, address operator, address token, address distributorAddress)
        // topics[0] = event sig
        // For indexed params: topics[1]=owner, topics[2]=operator, topics[3]=token
        // distributorAddress is in the non-indexed data OR it could be 4th topic
        // Let's check both patterns:
        // Pattern 1: all 4 params indexed -> topics[1]=owner, topics[2]=operator, topics[3]=token
        // and distributorAddress in data
        // Pattern 2: some indexed differently
        // Based on the event signature, let's parse from data if available,
        // or from the last topic
        let distributorAddr = null;
        // Try: if data has at least 32 bytes (one address in data)
        const data = log.data || '0x';
        if (data.length >= 66) {
            // distributorAddress is the first 32-byte word in data
            distributorAddr = '0x' + data.slice(26, 66); // remove 0x + 12 bytes padding
        }
        else if (topics.length >= 4) {
            // All 4 params indexed, distributorAddress could be in topics
            // Actually unlikely for 4 params. Let's try last topic.
            distributorAddr = '0x' + topics[3].slice(-40);
        }
        if (distributorAddr && distributorAddr.length === 42) {
            console.log(`[server] DistributorCreated detected on ${chainKey}: ${distributorAddr}`);
            await addDistributor(chainKey, distributorAddr);
        }
    }
}
// ====== WEBHOOK HANDLER ======
app.post('/webhooks/tenderly', express.raw({ type: 'application/json' }), async (req, res) => {
    const startedAt = Date.now();
    try {
        // ---- headers debug ----
        const signature = (req.header('x-tenderly-signature') || '').trim();
        const date = (req.header('date') || '').trim();
        const contentType = (req.header('content-type') || '').trim();
        const ua = (req.header('user-agent') || '').trim();
        const rawLen = Buffer.isBuffer(req.body) ? req.body.length : 0;
        req.log.info({
            method: req.method,
            path: req.path,
            contentType,
            ua,
            signaturePresent: Boolean(signature),
            datePresent: Boolean(date),
            rawLen,
        }, 'tenderly webhook received');
        // ---- signing key ----
        const signingKey = process.env.TENDERLY_SIGNING_KEY || '';
        if (!signingKey) {
            req.log.error('Missing TENDERLY_SIGNING_KEY');
            return res.status(500).send('Missing TENDERLY_SIGNING_KEY');
        }
        // ---- verify signature ----
        const okSig = verifyTenderlySignature({
            signingKey,
            signature,
            date,
            rawBody: req.body,
        });
        if (!okSig) {
            req.log.warn({
                signature: signature ? signature.slice(0, 12) + '…' : '(missing)',
                date,
                rawLen,
            }, 'Invalid Tenderly signature');
            return res.status(400).send('Invalid signature');
        }
        // ---- parse body ----
        let body;
        try {
            body = JSON.parse(req.body.toString('utf8'));
        }
        catch (e) {
            req.log.error({ err: e?.message || e }, 'Failed to JSON.parse body');
            return res.status(400).send('Bad JSON');
        }
        req.log.info({
            event_type: body?.event_type,
            hasAlert: Boolean(body?.alert),
            topKeys: body ? Object.keys(body).slice(0, 20) : [],
        }, 'payload parsed');
        // Tenderly event types
        const eventType = body?.event_type;
        if (eventType === 'TEST') {
            req.log.info('TEST event - ignoring');
            return res.status(200).send('ok');
        }
        if (eventType !== 'ALERT') {
            req.log.info({ eventType }, 'Non-ALERT event - ignored');
            return res.status(200).send('ignored');
        }
        // Extract network + txHash (Tenderly payload differs by alert type)
        const networkRaw = body?.alert?.network || body?.network || body?.data?.network || body?.transaction?.network;
        const txHashRaw = body?.alert?.tx_hash || body?.tx_hash || body?.transaction?.hash || body?.data?.tx_hash;
        const network = networkRaw != null ? String(networkRaw) : undefined;
        const txHash = txHashRaw != null ? String(txHashRaw) : undefined;
        req.log.info({ network, txHash }, 'extracted network/txHash');
        if (!network || !txHash) {
            req.log.warn({ network, txHash }, 'Missing network or txHash in Tenderly payload');
            return res.status(200).send('ok');
        }
        const chainKey = normalizeTenderlyNetwork(network);
        if (!chainKey) {
            req.log.warn({ network }, 'Unsupported network');
            return res.status(200).send('ok');
        }
        req.log.info({ network, chainKey }, 'network mapped');
        // allowlist chains (optional)
        const allow = new Set((process.env.CHAINS || '').split(',').map((s) => s.trim()).filter(Boolean));
        req.log.info({ allow: [...allow] }, 'chains allowlist');
        if (allow.size && !allow.has(chainKey)) {
            req.log.info({ chainKey }, 'chain not in allowlist - ignored');
            return res.status(200).send('ok');
        }
        // Interaction contract
        const interactionAddr = (process.env.INTERACTION_CONTRACT || '').toLowerCase();
        if (!interactionAddr) {
            req.log.error('Missing INTERACTION_CONTRACT');
            return res.status(500).send('Missing INTERACTION_CONTRACT');
        }
        // Create client
        req.log.info({ chainKey }, 'creating public client');
        const client = getPublicClient(chainKey);
        // Fetch tx
        req.log.info({ txHash }, 'fetching transaction');
        const tx = await client.getTransaction({ hash: txHash });
        req.log.info({
            txTo: tx?.to || null,
            txFrom: tx?.from || null,
        }, 'transaction fetched');
        if (!tx.to || tx.to.toLowerCase() !== interactionAddr) {
            req.log.info({ txTo: tx?.to || null, interactionAddr }, 'tx.to != INTERACTION_CONTRACT (not our interaction) - ignored');
            return res.status(200).send('ok');
        }
        // Receipt + transfers
        req.log.info({ txHash }, 'fetching receipt');
        const receipt = await client.getTransactionReceipt({ hash: txHash });
        req.log.info({
            logsCount: receipt?.logs?.length ?? 0,
            status: receipt?.status,
            blockNumber: receipt?.blockNumber?.toString?.() ?? receipt?.blockNumber,
        }, 'receipt fetched');
        // ===== FLOW 2: Extract DistributorCreated events and track addresses =====
        try {
            await extractDistributorAddresses(receipt, chainKey);
        }
        catch (err) {
            req.log.warn({ err: err?.message }, 'Failed to extract DistributorCreated addresses (non-fatal)');
        }
        // ===== FLOW 1: Process ERC-20 transfers (unchanged logic) =====
        const transfers = extractTransfersFromReceipt(receipt);
        req.log.info({ transfersCount: transfers.length }, 'parsed transfers');
        if (!transfers.length)
            return res.status(200).send('ok');
        // Thresholds / labels
        const thresholds = safeJson(process.env.THRESHOLDS_JSON || '{}');
        const thresholdsLower = {};
        for (const [addr, human] of Object.entries(thresholds || {}))
            thresholdsLower[addr.toLowerCase()] = String(human);
        const strictMode = Object.keys(thresholdsLower).length > 0;
        const tokenLabels = safeJson(process.env.TOKEN_LABELS_JSON || '{}');
        const tokenLabelsLower = {};
        for (const [addr, label] of Object.entries(tokenLabels || {}))
            tokenLabelsLower[addr.toLowerCase()] = String(label);
        req.log.info({
            strictMode,
            thresholdsKeys: Object.keys(thresholdsLower).slice(0, 20),
            labelsKeys: Object.keys(tokenLabelsLower).slice(0, 20),
        }, 'loaded thresholds/labels');
        // Process transfers
        let sentCount = 0;
        for (const t of transfers) {
            const tokenAddrLower = t.token.toLowerCase();
            const threshHuman = thresholdsLower[tokenAddrLower] ?? null;
            req.log.info({
                token: t.token,
                from: t.from,
                to: t.to,
                logIndex: t.logIndex,
                value: t.value.toString(),
                hasThreshold: Boolean(threshHuman),
                threshold: threshHuman,
            }, 'transfer candidate');
            // strict mode: only tokens in thresholds
            if (strictMode && !threshHuman) {
                req.log.info({ token: t.token }, 'skip: token not in thresholds (strictMode)');
                continue;
            }
            const dedupeKey = `${chainKey}:${txHash}:${t.logIndex}:${tokenAddrLower}:${t.to.toLowerCase()}`;
            const dup = await isDuplicate(dedupeKey);
            req.log.info({ dedupeKey, dup }, 'dedupe check');
            if (dup)
                continue;
            // meta
            req.log.info({ token: t.token }, 'fetching token meta');
            const meta = await getErc20MetaCached(client, t.token);
            const amountHuman = formatUnitsSafe(t.value, meta.decimals);
            // ✅ GLOBAL FILTER: skip if amount < 5000 tokens
            const amountNum = Number(amountHuman);
            if (!Number.isNaN(amountNum) && amountNum < MIN_TOKEN_AMOUNT) {
                req.log.info({ amountHuman, MIN_TOKEN_AMOUNT }, 'skip: amount below global minimum');
                continue;
            }
            function compareHuman(amount, threshold) {
                const a = Number(amount);
                const b = Number(threshold);
                if (Number.isNaN(a) || Number.isNaN(b))
                    return false;
                return a >= b;
            }
            // threshold compare: if there is a per-token threshold -> enforce it, else allow (non-strict)
            const pass = threshHuman ? compareHuman(amountHuman, String(threshHuman)) : true;
            req.log.info({
                token: t.token,
                symbol: meta.symbol,
                decimals: meta.decimals,
                amountHuman,
                threshold: threshHuman,
                pass,
            }, 'meta + amount');
            if (!pass)
                continue;
            const explorer = getExplorerTxUrl(chainKey, txHash);
            const networkPretty = chainKey === 'bsc_testnet' ? 'BSC Testnet' :
                chainKey === 'bsc' ? 'BSC' :
                    chainKey === 'base' ? 'Base' :
                        chainKey === 'arbitrum' ? 'Arbitrum' :
                            chainKey === 'ethereum' ? 'Ethereum' :
                                chainKey === 'avalanche' ? 'Avalanche' :
                                    chainKey === 'optimism' ? 'Optimism' :
                                        chainKey;
            const label = tokenLabelsLower[tokenAddrLower] || meta.symbol;
            const amountLine = `${formatNumberWithCommas(amountHuman)} $${label}`;
            function escHtml(s) {
                return s
                    .replace(/&/g, '&amp;')
                    .replace(/</g, '&lt;')
                    .replace(/>/g, '&gt;')
                    .replace(/"/g, '&quot;')
                    .replace(/'/g, '&#39;');
            }
            const message = `⚡ <b>${escHtml('NEW OKX DEPOSIT DETECTED')}</b>\n\n` +
                `Amount: ${escHtml(amountLine)}\n` +
                `Network: ${escHtml(networkPretty)}\n` +
                `<a href="${escHtml(explorer)}">${escHtml('View on Scan')}</a>\n\n` +
                `<a href="https://t.me/cryptohornettg/1354">Refback 45%</a>`;
            req.log.info({ messagePreview: message.slice(0, 200) }, 'sending telegram');
            await sendTelegram(message);
            sentCount++;
            await markDuplicate(dedupeKey);
            req.log.info({ dedupeKey }, 'marked duplicate');
        }
        req.log.info({ sentCount, ms: Date.now() - startedAt }, 'webhook processed');
        return res.status(200).send('ok');
    }
    catch (err) {
        req.log?.error?.({
            err: err?.message || err,
            stack: err?.stack,
            ms: Date.now() - startedAt,
        }, 'Error handling webhook');
        return res.status(500).send('error');
    }
});
// ====== START ======
const port = Number(process.env.PORT || 8080);
app.listen(port, () => {
    console.log(`Listening on :${port}`);
    // Start Flow 2: top-up poller (loads addresses from Supabase)
    startTopUpPoller().catch((err) => console.error('[boot] Failed to start topUpPoller:', err?.message));
});
function normalizeTenderlyNetwork(net) {
    const n = String(net).toLowerCase().trim();
    if (n === '56')
        return 'bsc';
    if (n === '97')
        return 'bsc_testnet';
    if (n === '8453')
        return 'base';
    if (n === '42161')
        return 'arbitrum';
    if (n === '1')
        return 'ethereum';
    if (n === '43114')
        return 'avalanche';
    if (n === '10')
        return 'optimism';
    if (n.includes('bsc') && n.includes('test'))
        return 'bsc_testnet';
    if (n.includes('bsc') || n.includes('bnb'))
        return 'bsc';
    if (n.includes('base'))
        return 'base';
    if (n.includes('arbitrum'))
        return 'arbitrum';
    if (n.includes('eth') || n.includes('ethereum'))
        return 'ethereum';
    if (n.includes('avax') || n.includes('avalanche'))
        return 'avalanche';
    if (n.includes('op') || n.includes('optimism'))
        return 'optimism';
    return null;
}
function safeJson(s) {
    try {
        return JSON.parse(s);
    }
    catch {
        return {};
    }
}
