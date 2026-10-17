'use strict';

// Telegram delivery preflight.
//
//   npm run harness:telegram-check            (sends one test message)
//   npm run harness:telegram-check --no-send  (validates the token without sending)
//
// The counterpart to `harness:angel-check`, for the other channel that has to work on go-live day.
// It answers one question - "will an alert actually reach the chat?" - before a real signal depends
// on it, rather than discovering a bad chat id or a revoked token the first time a trade fires.
//
// It forces the client to live mode for the test, so the check works (and stays meaningful) while
// PUBLISH_MODE is still `shadow`. Nothing is written to the database and no secret is printed.

const config = require('../src/config');
const { TelegramClient, istDateTime } = require('../src/telegram');

const noSend = process.argv.slice(2).includes('--no-send');

function pass(label, detail) {
  console.log(`PASS  ${label}${detail ? `  - ${detail}` : ''}`);
}
function fail(label, detail) {
  console.log(`FAIL  ${label}${detail ? `  - ${detail}` : ''}`);
}
function info(label, detail) {
  console.log(`      ${label}${detail ? `  - ${detail}` : ''}`);
}

async function getMe(token, apiRoot, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${apiRoot}/bot${token}/getMe`, { signal: controller.signal });
    const body = await response.json().catch(() => null);
    if (!response.ok || !body || !body.ok) {
      return { ok: false, error: `getMe responded ${response.status} ${JSON.stringify(body).slice(0, 160)}` };
    }
    return { ok: true, bot: body.result };
  } catch (error) {
    return { ok: false, error: error.message };
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const { botToken: token, chatId, apiRoot, timeoutMs } = config.telegram;

  console.log('Trading Factory Telegram preflight');
  info('token', token ? `${token.slice(0, 8)}...${token.slice(-4)} (${token.length} chars, not shown in full)` : 'NOT SET');
  info('chat id', chatId || 'NOT SET');
  info('publish mode', `${config.publish.mode} (the test overrides this; PUBLISH_MODE is not touched)`);
  console.log('');

  if (!token || !chatId) {
    fail('credentials present', 'both TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are required');
    info('hint', 'a bot token comes from @BotFather; the chat id is the recipient chat');
    process.exitCode = 1;
    return;
  }
  pass('credentials present');

  const me = await getMe(token, apiRoot, timeoutMs);
  if (!me.ok) {
    fail('bot token accepted by Telegram', me.error);
    process.exitCode = 1;
    return;
  }
  pass('bot token accepted by Telegram', `@${me.bot.username} (id ${me.bot.id})`);

  if (noSend) {
    info('send step skipped', '--no-send was passed; nothing was delivered');
    return;
  }

  const client = new TelegramClient({ mode: 'live' });
  const text = [
    'TRADING FACTORY - CHANNEL TEST',
    'This is a one-off wiring check, not a signal.',
    `Sent ${istDateTime()} IST`,
    'If you can read this, alerts will reach this chat once publishing goes live.',
  ].join('\n');

  const result = await client.send(text);
  if (result.delivered) {
    pass('test message delivered', 'check the chat to confirm it arrived somewhere a human reads');
  } else {
    fail('test message delivered', result.error || result.skipped || 'unknown reason');
    info('hint', 'a 400 usually means the chat id is wrong, or the bot was never started in that chat');
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(`telegram preflight crashed: ${error && error.message ? error.message : error}`);
  process.exitCode = 1;
});
