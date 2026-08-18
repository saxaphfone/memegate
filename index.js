// meme-gate bot
// Rule: to post in MEMES_CHANNEL_ID, your previous message there within the
// last 24h must have at least REQUIRED_REACTS reactions of REQUIRED_EMOJI —
// OR REQUIRED_REACTS reactions of any single other emoji, from that many
// distinct people (not the author). It's per-emoji, not additive: three
// different emoji at one react each doesn't count, three of the same one
// does. Stateless: Discord history is rescanned on every post. Mods exempt.

const {
  Client,
  GatewayIntentBits,
  PermissionFlagsBits,
  ActivityType,
  Partials,
  EmbedBuilder,
} = require('discord.js');
const { execSync } = require('child_process');
require('dotenv').config();

// Required.
const MEMES_CHANNEL_ID = process.env.MEMES_CHANNEL_ID;
const REQUIRED_EMOJI = process.env.REQUIRED_EMOJI; // custom emoji NAME (no colons)
// Optional: each of these channels turns a feature on. Leave one unset and the
// feature it drives simply doesn't run.
const GENERAL_CHANNEL_ID = process.env.GENERAL_CHANNEL_ID; // daily funniest-meme post
const MODS_CHANNEL_ID = process.env.MODS_CHANNEL_ID; // deploy changelog
const BEST_OF_CHANNEL_ID = process.env.BEST_OF_CHANNEL_ID; // hall of fame
const REQUIRED_REACTS = parseInt(process.env.REQUIRED_REACTS || '3', 10);
const BEST_OF_REACTS = parseInt(process.env.BEST_OF_REACTS || '8', 10);
const STATS_COOLDOWN_S = parseInt(process.env.STATS_COOLDOWN_S || '30', 10);
const ANNOUNCE_HOUR = parseInt(process.env.ANNOUNCE_HOUR || '16', 10);
const ANNOUNCE_MINUTE = parseInt(process.env.ANNOUNCE_MINUTE || '20', 10);
const ANNOUNCE_TZ = process.env.ANNOUNCE_TZ || 'Europe/London';
const COOLDOWN_MS = 24 * 60 * 60 * 1000;

// Without these three the bot can't do its one job, and the failure would be a
// silent one (an emoji name of `undefined` matches nothing), so say so and stop.
for (const key of ['DISCORD_TOKEN', 'MEMES_CHANNEL_ID', 'REQUIRED_EMOJI']) {
  if (!process.env[key]) {
    console.error(`[ERROR] ${key} is not set — see .env.example`);
    process.exit(1);
  }
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.MessageContent,
  ],
  // Reactions on messages the bot hasn't seen this run arrive partial —
  // fetch() below needs these to hydrate them.
  partials: [Partials.Message, Partials.Reaction],
});

// ---- Rolling 24h event log ----------------------------------------------
// A stripped self-react leaves nothing to rescan — the react is gone — so the
// "@bot stats" briefing keeps its own timestamps here. Pruned to the
// window on every write, so it's a true rolling 24h rather than a since-boot
// total. In-memory only: a restart clears it.
const events = Object.create(null);

function track(kind) {
  const now = Date.now();
  const times = events[kind] ?? [];
  times.push(now);
  events[kind] = times.filter((t) => now - t < COOLDOWN_MS);
}

function tally(kind) {
  const now = Date.now();
  return (events[kind] ?? []).filter((t) => now - t < COOLDOWN_MS).length;
}

// The author's most recent earlier message in the channel, or null if their
// last one is older than 24h (an expired gate can't block anyone).
async function previousMessage(message) {
  const cutoff = message.createdTimestamp - COOLDOWN_MS;
  let before = message.id;
  for (;;) {
    const batch = await message.channel.messages.fetch({ limit: 100, before }); // newest first
    for (const m of batch.values()) {
      if (m.createdTimestamp < cutoff) return null;
      if (m.author.id === message.author.id) return m;
    }
    if (batch.size < 100) return null;
    before = batch.lastKey();
  }
}

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;

  // "@bot stats", from any channel on the server.
  if (isStatsRequest(message)) {
    await postStats(message).catch((err) =>
      console.error(`[ERROR] stats briefing failed: ${err.message}`)
    );
    return;
  }

  // "@bot" in a reply, outside the memes channel: check the replied-to message.
  if (isBestOfSummon(message)) {
    await handleBestOfSummon(message).catch((err) =>
      console.error(`[ERROR] best-of summon failed: ${err.message}`)
    );
    return;
  }

  if (message.channelId !== MEMES_CHANNEL_ID) return;
  console.log(`[SEEN] ${message.author.tag}`);

  if (message.member?.permissions.has(PermissionFlagsBits.ManageMessages)) {
    console.log(`[EXEMPT] ${message.author.tag}`);
    return; // mods exempt
  }

  let prev;
  try {
    prev = await previousMessage(message);
  } catch (err) {
    console.error(`[ERROR] history scan failed: ${err.message}`);
    return;
  }
  if (!prev) {
    console.log(`[ALLOW] ${message.author.tag} — no prior post in 24h window`);
    return;
  }

  const requiredCount =
    prev.reactions.cache.find((r) => r.emoji.name === REQUIRED_EMOJI)?.count ?? 0;
  let bestOtherName = null;
  let bestOtherCount = 0;
  for (const r of prev.reactions.cache.values()) {
    if (r.emoji.name === REQUIRED_EMOJI) continue;
    if (r.count > bestOtherCount) {
      bestOtherCount = r.count;
      bestOtherName = r.emoji.name ?? r.emoji.toString();
    }
  }

  if (requiredCount >= REQUIRED_REACTS || bestOtherCount >= REQUIRED_REACTS) {
    console.log(
      `[ALLOW] ${message.author.tag} — met quota (${REQUIRED_EMOJI} ${requiredCount}/${REQUIRED_REACTS}` +
        `, best other ${bestOtherName ?? 'none'} ${bestOtherCount}/${REQUIRED_REACTS})`
    );
    return;
  }

  const needed = REQUIRED_REACTS - requiredCount;
  const unblockAt = prev.createdTimestamp + COOLDOWN_MS;
  const minsLeft = Math.ceil((unblockAt - Date.now()) / 60000);
  const timeLeft = `${Math.floor(minsLeft / 60)}h ${minsLeft % 60}m`;
  const unix = Math.floor(unblockAt / 1000);

  await message.delete().catch(() => {});
  console.log(
    `[BLOCK] ${message.author.tag} needed=${needed} ${REQUIRED_EMOJI}=${requiredCount}/${REQUIRED_REACTS}` +
      ` bestOther=${bestOtherName ?? 'none'}:${bestOtherCount}/${REQUIRED_REACTS}`
  );

  let dmFailed = false;
  await message.author
    .send(
      `Your last post in <#${MEMES_CHANNEL_ID}> needs **${needed}** more :${REQUIRED_EMOJI}: react${needed === 1 ? '' : 's'} ` +
        `— or ${REQUIRED_REACTS} reacts of any other single emoji stacked together (same emoji, different people). ` +
        `Hit either and you can post right away — otherwise you can post again in **${timeLeft}** (<t:${unix}:F>).`
    )
    .then(() => console.log(`[DM_SENT] ${message.author.tag}`))
    .catch(() => {
      dmFailed = true;
      console.log(`[DM_FAILED] ${message.author.tag}`);
    });

  const logsChannel = message.guild.channels.cache.find((c) => c.name === 'logs');
  if (logsChannel) {
    logsChannel
      .send(
        `DM'd ${message.author}: post blocked in <#${MEMES_CHANNEL_ID}> — needs ${needed} more :${REQUIRED_EMOJI}: ` +
          `(or ${REQUIRED_REACTS} of any other single emoji stacked), unlocked <t:${unix}:R>.` +
          (dmFailed ? ' (DM failed — their DMs are closed.)' : '')
      )
      .then(() => console.log('[LOG_POST] sent'))
      .catch(() => {});
  }
});

// ---- Hall of fame --------------------------------------------------------
// A meme that reaches BEST_OF_REACTS gets enshrined in the best-of channel:
// a credit line, then a *forward* of the original — a forward carries the
// image across, a bare link doesn't. Every react past the threshold fires
// this again: the first induction posts, and each later one edits the credit
// line so its count keeps climbing instead of freezing at the induction
// number. Restarts forget everything, so the credit line is relocated from
// the best-of channel's own history (it embeds the message id via its link);
// the cache just saves the round trip within a run.
//
// Per-meme work is serialized through a lock so two near-simultaneous reacts
// can't both post (a duplicate the history scan wouldn't yet see) and so a
// later react's edit can't race the initial post.
const bestOfCredits = new Map(); // message.id -> the bot's credit Message
const bestOfLocks = new Map(); // message.id -> tail of its work queue

function withBestOfLock(id, fn) {
  const prev = bestOfLocks.get(id) ?? Promise.resolve();
  const next = prev.then(fn, fn); // run regardless of the prior link's outcome
  bestOfLocks.set(id, next);
  next.finally(() => {
    if (bestOfLocks.get(id) === next) bestOfLocks.delete(id); // last link, tidy up
  });
  return next;
}

async function findCredit(channel, messageId) {
  const recent = await channel.messages.fetch({ limit: 100 });
  return recent.find((m) => m.author.id === client.user.id && m.content.includes(messageId)) ?? null;
}

function announceBestOf(message, count) {
  if (!BEST_OF_CHANNEL_ID) return Promise.resolve();
  return withBestOfLock(message.id, () => doAnnounceBestOf(message, count));
}

async function doAnnounceBestOf(message, count) {
  let channel;
  try {
    channel = await client.channels.fetch(BEST_OF_CHANNEL_ID);
  } catch (err) {
    console.error(`[ERROR] best-of lookup failed: ${err.message}`);
    return;
  }

  const emoji = channel.guild.emojis.cache.find((e) => e.name === REQUIRED_EMOJI);
  const content = `<@${message.author.id}> with ${count} ${emoji ?? `:${REQUIRED_EMOJI}:`} ${message.url}`;

  // Already enshrined? Edit the count instead of re-posting. Consult this
  // run's cache first, then fall back to the channel history (survives
  // restarts, which clear the cache).
  let credit = bestOfCredits.get(message.id) ?? null;
  if (!credit) {
    try {
      credit = await findCredit(channel, message.id);
    } catch (err) {
      console.error(`[ERROR] best-of lookup failed: ${err.message}`);
      return;
    }
  }

  if (credit) {
    bestOfCredits.set(message.id, credit);
    if (credit.content === content) return; // count unchanged, nothing to edit
    try {
      await credit.edit(content);
      console.log(`[BEST_OF_UPDATE] ${message.author.tag} count=${count} msg=${message.id}`);
    } catch (err) {
      console.error(`[ERROR] best-of edit failed: ${err.message}`);
    }
    return;
  }

  // First induction: post the credit line, then forward.
  let posted;
  try {
    posted = await channel.send(content);
    await message.forward(channel);
    bestOfCredits.set(message.id, posted); // only after the forward lands
    console.log(`[BEST_OF] ${message.author.tag} count=${count} msg=${message.id}`);
  } catch (err) {
    // A credit line with no forward is the one state nothing can repair: the
    // history lookup reads it as done, so the meme would stay imageless
    // forever. Undo it — the next react tries again from scratch.
    await posted?.delete().catch(() => {});
    console.error(`[ERROR] best-of post failed: ${err.message}`);
  }
}

// ---- Best-of, summoned by reply ------------------------------------------
// Outside the memes channel the bot doesn't watch reacts land in real time —
// that'd mean scanning every channel — so it's summoned instead: @-mention it
// in a reply to a message, and it checks that one message's REQUIRED_EMOJI
// count on demand, inducting it into best-of via the same announceBestOf()
// path a memes-channel react would.
function isBestOfSummon(message) {
  if (message.channelId === MEMES_CHANNEL_ID) return false; // handled by reacts there
  if (!message.reference?.messageId) return false;
  return message.mentions.users.has(client.user.id);
}

async function handleBestOfSummon(message) {
  console.log(`[BEST_OF_SUMMON] requested by ${message.author.tag} in #${message.channel.name ?? 'dm'}`);

  let target;
  try {
    target = await message.channel.messages.fetch(message.reference.messageId);
  } catch (err) {
    console.error(`[ERROR] best-of summon fetch failed: ${err.message}`);
    await message.react('❓').catch(() => {});
    return;
  }

  const reaction = target.reactions.cache.find((r) => r.emoji.name === REQUIRED_EMOJI);
  let count = 0;
  if (reaction) {
    try {
      // Same self-react/bot exclusion as the organic best-of check below —
      // a summon shouldn't induct on an inflated count the reaction listener
      // would've turned down.
      const reactors = await reaction.users.fetch();
      count = reactors.filter((u) => !u.bot && u.id !== target.author.id).size;
    } catch (err) {
      console.error(`[ERROR] best-of summon count failed: ${err.message}`);
      await message.react('❓').catch(() => {});
      return;
    }
  }

  if (count >= BEST_OF_REACTS) {
    await announceBestOf(target, count);
  }
}

// Self-reacts would let someone farm their own gate quota — and any emoji
// stack can meet it, not just REQUIRED_EMOJI — so strip any react a user puts
// on their own message in the memes channel, whatever emoji it is.
client.on('messageReactionAdd', async (reaction, user) => {
  if (user.bot || reaction.message.channelId !== MEMES_CHANNEL_ID) return;

  try {
    if (reaction.partial) await reaction.fetch();
    if (reaction.message.partial) await reaction.message.fetch();
  } catch (err) {
    console.error(`[ERROR] self-react fetch failed: ${err.message}`);
    return;
  }

  if (reaction.message.author.id === user.id) {
    const emojiName = reaction.emoji.name ?? reaction.emoji.toString();
    await reaction.users.remove(user.id).catch(() => {});
    track('selfReacts');
    console.log(`[SELF_REACT] removed ${user.tag}'s own :${emojiName}: react`);
    return; // count read below would still include the react we just stripped
  }

  // Hall-of-fame induction stays REQUIRED_EMOJI-only — the gate's alt-emoji
  // path is just another way to unlock posting, not a second currency for fame.
  if (reaction.emoji.name !== REQUIRED_EMOJI) return;
  if (reaction.count < BEST_OF_REACTS) return;

  // reaction.count can still include a self-react whose strip is in flight
  // (the count only drops when the remove event comes back), which would
  // enshrine a meme a react early with an inflated number — so count the
  // reactors ourselves, minus the author and bots.
  let reactors;
  try {
    reactors = await reaction.users.fetch();
  } catch (err) {
    console.error(`[ERROR] best-of count failed: ${err.message}`);
    return; // the next react retries
  }
  const count = reactors.filter((u) => !u.bot && u.id !== reaction.message.author.id).size;
  if (count >= BEST_OF_REACTS) await announceBestOf(reaction.message, count);
});

// ---- Daily funniest-meme announcement ----------------------------------

const ANNOUNCE_PREFIX = 'congratulations to ';

// One backwards scan of the last 24h of the memes channel, feeding both the
// daily announcement (which only wants `top`) and the stats briefing. `top` is
// null when nothing in the window has a single react.
async function memesDigest(channel) {
  const cutoff = Date.now() - COOLDOWN_MS;
  const digest = { posts: 0, posters: new Set(), reacts: 0, shutouts: 0, top: null };
  let before;
  for (;;) {
    const batch = await channel.messages.fetch({ limit: 100, ...(before && { before }) }); // newest first
    for (const m of batch.values()) {
      if (m.createdTimestamp < cutoff) return digest;
      if (m.author.bot) continue;
      const count =
        m.reactions.cache.find((r) => r.emoji.name === REQUIRED_EMOJI)?.count ?? 0;
      digest.posts++;
      digest.posters.add(m.author.id);
      digest.reacts += count;
      if (count === 0) digest.shutouts++;
      if (count > (digest.top?.count ?? 0)) digest.top = { message: m, count };
    }
    if (batch.size < 100) return digest;
    before = batch.lastKey();
  }
}

function setFunniestStatus(username) {
  client.user.setPresence({
    activities: [
      {
        type: ActivityType.Custom,
        name: 'funniest',
        state: `funniest user in the past day is @${username}`,
      },
    ],
  });
}

async function dailyAnnounce() {
  if (!GENERAL_CHANNEL_ID) return;
  try {
    const memes = await client.channels.fetch(MEMES_CHANNEL_ID);
    const { top } = await memesDigest(memes);
    if (!top) {
      console.log(`[TOP_NONE] no :${REQUIRED_EMOJI}: reacts in the last 24h — skipping announcement`);
      return;
    }
    const general = await client.channels.fetch(GENERAL_CHANNEL_ID);
    const emoji = general.guild.emojis.cache.find((e) => e.name === REQUIRED_EMOJI);
    await general.send(
      `${ANNOUNCE_PREFIX}<@${top.message.author.id}> who posted the funniest meme in the last 24 hours with ${top.count} ${emoji ?? `:${REQUIRED_EMOJI}:`}'s. ${top.message.url}`
    );
    setFunniestStatus(top.message.author.username);
    console.log(`[TOP_MEME] ${top.message.author.tag} count=${top.count}`);
  } catch (err) {
    console.error(`[ERROR] daily announce failed: ${err.message}`);
  }
}

// ---- "@bot stats" briefing ----------------------------------------------
// Works in any channel the bot can see. Two sources, deliberately: Discord's
// own history for everything durable (memes, reacts, hall-of-fame inductions),
// and the in-memory event log for the enforcement actions that deleted their
// own evidence. Only the second half resets on restart, and the footer owns up
// to it rather than passing a 20-minute total off as a day's worth.

let lastStatsAt = 0;

function isStatsRequest(message) {
  if (!message.mentions.users.has(client.user.id)) return false;
  return /\bstats?\b/i.test(message.content.replace(/<@[!&]?\d+>/g, ' '));
}

function plural(n, word) {
  return `\`${n}\` ${word}${n === 1 ? '' : 's'}`;
}

// Bot posts in the best-of channel come in pairs — credit line, then the
// forward — and only the credit line carries text, so it's the one to count.
async function recentInductions() {
  const channel = await client.channels.fetch(BEST_OF_CHANNEL_ID);
  const recent = await channel.messages.fetch({ limit: 100 });
  const cutoff = Date.now() - COOLDOWN_MS;
  return recent.filter(
    (m) => m.author.id === client.user.id && m.content.includes('/channels/') && m.createdTimestamp >= cutoff
  ).size;
}

async function postStats(message) {
  // Each briefing is up to a few history fetches, so one impatient user with a
  // keyboard shouldn't be able to turn it into a rate-limit problem.
  if (Date.now() - lastStatsAt < STATS_COOLDOWN_S * 1000) {
    await message.react('⏳').catch(() => {});
    return;
  }
  lastStatsAt = Date.now();
  console.log(`[STATS] requested by ${message.author.tag} in #${message.channel.name ?? 'dm'}`);

  let digest = null;
  try {
    digest = await memesDigest(await client.channels.fetch(MEMES_CHANNEL_ID));
  } catch (err) {
    console.error(`[ERROR] stats memes scan failed: ${err.message}`);
  }

  let inductions = null;
  if (BEST_OF_CHANNEL_ID) {
    try {
      inductions = await recentInductions();
    } catch (err) {
      console.error(`[ERROR] stats best-of scan failed: ${err.message}`);
    }
  }

  const emoji = message.guild?.emojis.cache.find((x) => x.name === REQUIRED_EMOJI) ?? `:${REQUIRED_EMOJI}:`;

  const economy = digest
    ? `\`${digest.posts}\` memes from \`${digest.posters.size}\` posters, ` +
      `\`${digest.reacts}\` ${emoji} handed out\n` +
      `averaging \`${digest.posts ? (digest.reacts / digest.posts).toFixed(1) : '0.0'}\` a meme` +
      (digest.shutouts ? ` — \`${digest.shutouts}\` got absolutely nothing` : '')
    : 'the memes channel would not open its books.';

  const frontRunner = digest?.top
    ? `<@${digest.top.message.author.id}> with \`${digest.top.count}\` ${emoji} — [the evidence](${digest.top.message.url})`
    : 'nobody. not a single react out there.';

  const embed = new EmbedBuilder()
    .setColor(0xf1c40f)
    .setTitle('meme intelligence briefing')
    .setDescription('previous 24 hours report')
    .addFields(
      { name: 'the meme economy', value: economy },
      { name: 'current front-runner', value: frontRunner },
      {
        name: 'hall of fame',
        value: !BEST_OF_CHANNEL_ID
          ? 'no best-of channel configured'
          : inductions === null
            ? 'best-of unreachable'
            : `${plural(inductions, 'induction')} into <#${BEST_OF_CHANNEL_ID}>`,
        inline: true,
      },
      {
        name: 'nice try',
        value: `${plural(tally('selfReacts'), 'self-react')} confiscated`,
        inline: true,
      }
    )
    .setTimestamp();

  // In the memes channel the command would otherwise become the author's
  // "previous post" — a reactless one that locks them out — so it gets cleaned
  // up, and the briefing goes out as a plain message rather than a reply to
  // something about to vanish.
  const inMemes = message.channelId === MEMES_CHANNEL_ID;
  try {
    if (inMemes) {
      await message.channel.send({ content: `<@${message.author.id}>`, embeds: [embed] });
      await message.delete().catch(() => {});
    } else {
      await message.reply({ embeds: [embed], allowedMentions: { repliedUser: false } });
    }
  } catch (err) {
    console.error(`[ERROR] stats reply failed: ${err.message}`);
  }
}

// ---- Wall-clock scheduling (DST-safe, no tz dependency) -----------------
// The daily announcement fires at a fixed local time (ANNOUNCE_HOUR:MINUTE
// in ANNOUNCE_TZ) rather than a rolling 24h-from-last-post interval, so it
// doesn't creep across the day on restarts. Node has no built-in "give me
// the UTC offset for this zone at this instant", so we derive it by
// formatting a UTC instant into the zone and diffing — two passes converge
// even across a DST transition, since the offset can only shift once.
function tzOffsetMs(date, tz) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
    .formatToParts(date)
    .reduce((acc, p) => ((acc[p.type] = p.value), acc), {});
  const asUTC = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour === '24' ? 0 : parts.hour,
    parts.minute,
    parts.second
  );
  return asUTC - date.getTime();
}

function nextAnnounceTime() {
  const now = new Date();
  const todayParts = new Intl.DateTimeFormat('en-US', {
    timeZone: ANNOUNCE_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
    .formatToParts(now)
    .reduce((acc, p) => ((acc[p.type] = p.value), acc), {});

  const targetFor = (y, m, d) => {
    const wallUTC = Date.UTC(y, m - 1, d, ANNOUNCE_HOUR, ANNOUNCE_MINUTE, 0);
    // Two passes: the first offset estimate can be wrong by an hour right
    // around a DST transition, so refine once against its own result.
    let target = wallUTC - tzOffsetMs(new Date(wallUTC), ANNOUNCE_TZ);
    target = wallUTC - tzOffsetMs(new Date(target), ANNOUNCE_TZ);
    return target;
  };

  let target = targetFor(todayParts.year, todayParts.month, todayParts.day);
  if (target <= now.getTime()) {
    const tomorrow = new Date(target + 24 * 60 * 60 * 1000);
    const tParts = new Intl.DateTimeFormat('en-US', {
      timeZone: ANNOUNCE_TZ,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
      .formatToParts(tomorrow)
      .reduce((acc, p) => ((acc[p.type] = p.value), acc), {});
    target = targetFor(tParts.year, tParts.month, tParts.day);
  }
  return new Date(target);
}

function scheduleAnnounce() {
  const delay = nextAnnounceTime().getTime() - Date.now();
  setTimeout(async () => {
    await dailyAnnounce();
    scheduleAnnounce();
  }, delay);
}

// ---- Deploy changelog post ----------------------------------------------

const DEPLOY_PREFIX = 'deployed `';

// The bot's last "deployed `sha`" post in the mods channel anchors the diff,
// same trick as the daily announcement anchor above. No prior post (fresh
// channel) or an unchanged sha (crash restart, not a new deploy) fall back
// to showing just the latest commit / posting nothing, respectively.
async function announceDeploy() {
  if (!MODS_CHANNEL_ID) return;
  let sha;
  try {
    sha = execSync('git rev-parse --short HEAD', { cwd: __dirname }).toString().trim();
  } catch (err) {
    console.error(`[ERROR] deploy sha lookup failed: ${err.message}`);
    return;
  }

  try {
    const mods = await client.channels.fetch(MODS_CHANNEL_ID);
    const recent = await mods.messages.fetch({ limit: 50 });
    const last = recent.find(
      (m) => m.author.id === client.user.id && m.content.startsWith(DEPLOY_PREFIX)
    );
    const prevSha = last?.content.match(/`([0-9a-f]+)`/)?.[1];
    if (prevSha === sha) return; // same code, just a restart

    const range = prevSha ? `${prevSha}..${sha}` : '-1';
    const log = execSync(`git log --oneline ${range}`, { cwd: __dirname }).toString().trim();
    const notes = log
      .split('\n')
      .filter(Boolean)
      .map((l) => `- ${l.replace(/^[0-9a-f]+\s/, '')}`)
      .join('\n');

    await mods.send(`${DEPLOY_PREFIX}${sha}\`${notes ? '\n' + notes : ''}`);
    console.log(`[DEPLOY_POST] ${sha}`);
  } catch (err) {
    console.error(`[ERROR] deploy announce failed: ${err.message}`);
  }
}

client.once('ready', async () => {
  console.log(`[READY] Logged in as ${client.user.tag}`);

  await announceDeploy();

  if (!GENERAL_CHANNEL_ID) return; // no announcement channel, nothing to schedule

  // Fixed wall-clock schedule (ANNOUNCE_HOUR:MINUTE in ANNOUNCE_TZ) rather
  // than 24h-from-last-post, so restarts don't drift the announcement time.
  // The last announcement's winner is restored to the status, which Discord
  // clears on reconnect; nextAnnounceTime() is always strictly in the
  // future, so this can't cause a double-post even on a restart moments
  // after today's announcement fired.
  try {
    const general = await client.channels.fetch(GENERAL_CHANNEL_ID);
    const recent = await general.messages.fetch({ limit: 50 });
    const last = recent.find(
      (m) => m.author.id === client.user.id && m.content.startsWith(ANNOUNCE_PREFIX)
    );
    const winnerId = last?.content.match(/<@(\d+)>/)?.[1];
    if (winnerId) {
      const winner = await client.users.fetch(winnerId).catch(() => null);
      if (winner) setFunniestStatus(winner.username);
    }
  } catch (err) {
    console.error(`[ERROR] announce status restore failed: ${err.message}`);
  }
  scheduleAnnounce();
});

client.login(process.env.DISCORD_TOKEN);
