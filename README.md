# discord-meme-gate

A Discord bot that rations posting in a memes channel by engagement. To post
again, your **previous** post there has to have earned its keep — otherwise the
new one is deleted and you're told when you can try again.

The bot stores nothing. On every post it re-reads the channel's last 24h of
history from Discord, so restarts lose no state and there is no database to
run.

## The gate

Your previous post in the channel clears the gate if it has either:

- `REQUIRED_REACTS` reactions of `REQUIRED_EMOJI`, **or**
- `REQUIRED_REACTS` reactions of any *single* other emoji.

It's per-emoji, not additive: three different emoji at one react each doesn't
count, three of the same one does. Reacting to your own post won't help — the
bot strips those (see below).

If neither threshold is met, the new post is deleted and the author is DM'd how
many reacts they still need and when the block lifts. The 24h clock runs from
the timestamp of the under-reacted post, not from the blocked attempt, so
reaching the quota lifts the block immediately and waiting it out works too.

Anyone with the **Manage Messages** permission is exempt. If the history scan
fails for any reason, the bot fails open and allows the post.

## Features

Everything below is on top of the gate itself. **Stats briefing** and
**self-react stripping** work out of the box; the rest each post to a channel
you nominate and stay off while that channel is unset.

- **Stats briefing** — Mention the bot with "stats" ("@bot stats") in any channel it can see
  for an embed on the last 24h: memes posted (and by how many people),
  reactions given and the average, the current front-runner with a jump link,
  hall-of-fame inductions, and self-reacts confiscated. `STATS_COOLDOWN_S`
  throttles it globally (requests inside the window get an ⏳). In the memes
  channel the command message is deleted afterward, so it can't become the
  author's reactless "previous post" and lock them out.

- **Self-react stripping** — Any reaction a user adds to their own message in
  the memes channel is removed, so nobody can farm their own quota.

- **Hall of fame** — A post reaching `BEST_OF_REACTS` of `REQUIRED_EMOJI` is
  reposted to `BEST_OF_CHANNEL_ID`: a credit line (author and count) plus a
  *forward* of the original, which carries the image across where a bare link
  wouldn't. Duplicates are prevented by scanning the best-of channel's recent
  history, so it survives restarts.

- **Summoned inductions** — The bot watches reactions live only in the memes
  channel. Elsewhere, @-mention it in a **reply** to a message to check that
  one message on demand; it inducts the message if it clears the threshold,
  does nothing if it doesn't, and reacts ❓ if the lookup fails.

- **Daily winner announcement** — Once a day at a fixed wall-clock time, the
  top-`REQUIRED_EMOJI` post of the last 24h is announced in
  `GENERAL_CHANNEL_ID` and the winner's name goes into the bot's status. The
  schedule is recomputed each cycle from `ANNOUNCE_TZ`, so it doesn't drift
  across restarts or DST. A day with no reactions is skipped silently.

- **Deploy changelog** — On startup, if the checked-out commit differs from the
  one in its last such post, the bot posts the intervening commit subjects to
  `MODS_CHANNEL_ID`. No new commits means no post. It reads the git history of
  its own directory, so it only works on a git checkout.

## Setup

1. Create an application at https://discord.com/developers/applications, add a
   bot, and enable the **Message Content** privileged intent under
   Bot → Privileged Gateway Intents. The stats command reads message text; the
   gate itself doesn't.
2. Invite the bot with **Manage Messages** (to delete blocked posts and strip
   self-reacts), **Send Messages**, **Read Message History**, and **Add
   Reactions**.
3. Copy the config template and fill it in:
   ```
   cp .env.example .env
   ```
4. Install and run:
   ```
   npm install
   npm start
   ```

To get a channel ID, enable Developer Mode in Discord
(Settings → Advanced), then right-click a channel → Copy Channel ID.

## Configuration

All configuration is environment variables, read from `.env`. The bot exits
immediately with a message naming the offender if a required one is missing.

| Variable | Default | Purpose |
|---|---|---|
| `DISCORD_TOKEN` | — | **Required.** Your bot token. |
| `MEMES_CHANNEL_ID` | — | **Required.** The channel to gate. |
| `REQUIRED_EMOJI` | — | **Required.** The *name* of the custom server emoji that counts, without colons — for `:banana:`, use `banana`. |
| `REQUIRED_REACTS` | `3` | Reactions needed to clear the gate. |
| `BEST_OF_CHANNEL_ID` | unset | Hall-of-fame channel. Unset disables inductions. |
| `BEST_OF_REACTS` | `8` | Reactions needed for induction. |
| `GENERAL_CHANNEL_ID` | unset | Where the daily winner is announced. Unset disables the announcement. |
| `ANNOUNCE_HOUR` | `16` | Hour of the announcement, 24h clock. |
| `ANNOUNCE_MINUTE` | `20` | Minute of the announcement. |
| `ANNOUNCE_TZ` | `Europe/London` | IANA timezone the announcement time is read in. |
| `MODS_CHANNEL_ID` | unset | Where the deploy changelog posts. Unset disables it. |
| `STATS_COOLDOWN_S` | `30` | Global throttle on the stats command, in seconds. |

Optionally, a text channel literally named `logs` receives a report each time a
post is blocked. If no such channel exists, reports are skipped silently.

## Logging

The bot writes tagged lines to stdout, so a log tail or `journalctl` can be
filtered or counted per event type:

```
[READY] [SEEN] [EXEMPT] [ALLOW] [BLOCK] [DM_SENT] [DM_FAILED] [LOG_POST]
[SELF_REACT] [BEST_OF] [BEST_OF_SUMMON] [TOP_MEME] [TOP_NONE] [STATS]
[DEPLOY_POST] [ERROR]
```

## Misc

- Deleting your own under-reacted post removes it from history, so it stops
  gating you. Deleting flops is effectively a free retry.
- The hall-of-fame forward needs discord.js ≥ 14.17.
- The gate covers the single channel in `MEMES_CHANNEL_ID`. To gate several,
  extend the channel check to a list.
