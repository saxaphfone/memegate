// Back-up script: refresh the react counts on best-of credit lines.
//
// The bot only rewrites a credit line when a *new* react lands on the meme
// (or someone summons it), so every meme inducted before that behaviour
// shipped — and every meme nobody has reacted to since — still shows the
// count it went in on. This walks the best-of channel's recent history,
// recounts each credited meme from its source message, and edits the lines
// that have fallen behind.
//
// Not part of the service. Run it by hand, from the server (it needs the
// same .env), and expect to run it once:
//
//   node scripts/backfill-best-of.js            # dry run, prints what it'd do
//   node scripts/backfill-best-of.js --apply    # actually edits
//
// Flags: --limit=N (history depth, default 100), --allow-lower (see below).

const { Client, GatewayIntentBits } = require('discord.js');
require('dotenv').config();

const BEST_OF_CHANNEL_ID = process.env.BEST_OF_CHANNEL_ID || '(CHANNEL ID)';
const REQUIRED_EMOJI = process.env.REQUIRED_EMOJI || '(EMOJI)';

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const ALLOW_LOWER = args.includes('--allow-lower');
const LIMIT = parseInt(args.find((a) => a.startsWith('--limit='))?.split('=')[1] || '100', 10);

// The credit line the bot writes:
//   <@authorId> with N <:stnlee:id> https://discord.com/channels/g/c/m
const CREDIT = /^<@!?(\d+)> with (\d+) (?:<a?:\w+:\d+>|:\w+:) (https:\/\/(?:\w+\.)?discord(?:app)?\.com\/channels\/\d+\/(\d+)\/(\d+))/;

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.MessageContent,
  ],
});

// Same count the live path uses: reactors of :stnlee:, minus bots and the
// meme's own author, so a backfill can't write a number the listener would
// never have produced.
async function recount(source) {
  const reaction = source.reactions.cache.find((r) => r.emoji.name === REQUIRED_EMOJI);
  if (!reaction) return 0;
  const reactors = await reaction.users.fetch();
  return reactors.filter((u) => !u.bot && u.id !== source.author.id).size;
}

client.once('clientReady', async () => {
  const stats = { scanned: 0, credits: 0, edited: 0, current: 0, skipped: 0, failed: 0 };
  try {
    const channel = await client.channels.fetch(BEST_OF_CHANNEL_ID);
    const emoji = channel.guild.emojis.cache.find((e) => e.name === REQUIRED_EMOJI);
    const history = await channel.messages.fetch({ limit: LIMIT });
    stats.scanned = history.size;

    // Oldest first, so the output reads in the order the channel does.
    for (const credit of [...history.values()].reverse()) {
      if (credit.author.id !== client.user.id) continue;
      const match = CREDIT.exec(credit.content);
      if (!match) continue; // a forward, or something a human posted
      stats.credits++;

      const [, authorId, shown, url, channelId, messageId] = match;
      let source;
      try {
        const sourceChannel = await client.channels.fetch(channelId);
        source = await sourceChannel.messages.fetch(messageId);
      } catch (err) {
        // Deleted meme, or a channel the bot lost access to. Leave the
        // credit line alone — there's nothing left to count.
        console.log(`skip  ${messageId} (source gone: ${err.message})`);
        stats.skipped++;
        continue;
      }

      let count;
      try {
        count = await recount(source);
      } catch (err) {
        console.log(`fail  ${messageId} (count failed: ${err.message})`);
        stats.failed++;
        continue;
      }

      // The live count only ever ratchets up — removing a react doesn't fire
      // the listener — so by default this won't walk a number backwards
      // either, however many people have since unreacted.
      if (count === Number(shown)) {
        stats.current++;
        continue;
      }
      if (count < Number(shown) && !ALLOW_LOWER) {
        console.log(`hold  ${messageId} ${shown} -> ${count} (lower; --allow-lower to write it)`);
        stats.skipped++;
        continue;
      }

      const content = `<@${authorId}> with ${count} ${emoji ?? `:${REQUIRED_EMOJI}:`} ${url}`;
      if (!APPLY) {
        console.log(`would ${messageId} ${shown} -> ${count}`);
        stats.edited++;
        continue;
      }
      try {
        await credit.edit(content);
        console.log(`edit  ${messageId} ${shown} -> ${count}`);
        stats.edited++;
        await new Promise((r) => setTimeout(r, 1000)); // stay clear of edit rate limits
      } catch (err) {
        console.log(`fail  ${messageId} (edit failed: ${err.message})`);
        stats.failed++;
      }
    }
  } catch (err) {
    console.error(`fatal: ${err.message}`);
    process.exitCode = 1;
  }

  console.log(
    `\n${APPLY ? 'applied' : 'dry run'}: ${stats.scanned} messages scanned, ` +
      `${stats.credits} credit lines, ${stats.edited} ${APPLY ? 'edited' : 'to edit'}, ` +
      `${stats.current} already current, ${stats.skipped} skipped, ${stats.failed} failed`
  );
  if (!APPLY && stats.edited) console.log('re-run with --apply to write these.');
  await client.destroy();
});

client.login(process.env.DISCORD_TOKEN);
