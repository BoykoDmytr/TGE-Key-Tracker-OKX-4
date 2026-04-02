// src/telegram.ts

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

async function sendToChat(chatId: string, text: string): Promise<void> {
  const botToken = requireEnv('TELEGRAM_BOT_TOKEN');
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  const payload = {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Telegram API error: ${res.status} ${errText}`);
  }
}

/** Send to the main channel (TELEGRAM_CHAT_ID) — existing Flow 1 */
export async function sendTelegram(text: string): Promise<void> {
  const chatId = requireEnv('TELEGRAM_CHAT_ID');
  await sendToChat(chatId, text);
}

/** Send to the debug/test channel (TELEGRAM_CHAT_ID_DEBUG) — Flow 2 top-ups */
export async function sendTelegramDebug(text: string): Promise<void> {
  const chatId = process.env.TELEGRAM_CHAT_ID_DEBUG;
  if (!chatId) {
    console.warn('[telegram] TELEGRAM_CHAT_ID_DEBUG not set, falling back to main channel');
    return sendTelegram(text);
  }
  await sendToChat(chatId, text);
}