import type { Config } from '../config.js';
import { resolveSecret } from '../config.js';
import { HttpClient } from '../adapters/http.js';
import { appendManualSignal, existingManualSignals, knownSignalIds } from '../store.js';
import type { Signal } from '../types.js';
import { parseManualEntry } from './manual.js';
import { localDate } from '../util/time.js';

/**
 * Slack as a capture surface.
 *
 * The point isn't Slack, it's *when* you're there: you are already in the app
 * during the meeting, on the laptop or the phone, and terminal isn't open.
 * Typing (or dictating) "last one hour helping Priya with the deploy" the
 * moment it happens beats reconstructing it on Friday.
 *
 * Deliberately a **poll**, not a bot. A slash-command bot needs a public
 * webhook endpoint, which means hosting a server, which breaks the promise
 * that nothing about punchcard leaves your machine. Polling a conversation
 * with a user token keeps everything local.
 *
 * Messages become ordinary manual signals in the local ledger, so `preview`
 * stays fast and works offline — the network is only touched by `punch sync`.
 */

const SLACK_API = 'https://slack.com/api';

/**
 * App manifest, offered for copy-paste at app creation time.
 *
 * Slack's "From a manifest" flow declares the scopes up front, which removes
 * the two ways this setup usually goes wrong: not finding the User Token
 * Scopes box, and adding the scopes as *bot* scopes instead (a bot is not in
 * the DM you have with yourself, so it can never read it).
 */
export const SLACK_APP_MANIFEST = `# punchcard Slack app manifest.
#
# Paste at api.slack.com/apps -> Create an App -> "From a manifest".
#
# Deliberately minimal: display information and user scopes, nothing else.
# A previous version also set an explicit \`settings:\` block, and Slack rejected
# the install as "requesting administrative permissions" even though none of
# these scopes is an admin scope. Declaring only what is needed avoids Slack
# inferring org-level capability from keys that were only ever set to false.
#
# Scopes, and why each is needed:
#   im:history  read the messages in the DM you have with yourself
#   im:read     find that DM (Slack will not "open" a DM with yourself)
#   im:write    fallback for workspaces where opening it does work
#
# No channel access, no file access, nobody else's messages.
# punchcard polls; it never posts.
display_information:
  name: punchcard

oauth_config:
  scopes:
    user:
      - im:history
      - im:read
      - im:write
`;


interface SlackMessage {
  ts: string;
  text?: string;
  user?: string;
  subtype?: string;
  bot_id?: string;
}

export interface SlackSyncResult {
  scanned: number;
  imported: number;
  skipped: number;
  /** Messages that looked like an attempt to log time but had no duration. */
  unparsed: string[];
}

export async function syncSlack(cfg: Config): Promise<SlackSyncResult> {
  const slack = cfg.slack;
  if (!slack?.token) {
    throw new Error(
      'Slack is not configured. Add:\n\n' +
        '  slack:\n    token: env:SLACK_USER_TOKEN\n\n' +
        'Create an app at api.slack.com/apps, add the user-token scopes ' +
        'im:history and im:write, install it to your workspace, and copy the ' +
        'User OAuth Token (xoxp-...).',
    );
  }

  const token = resolveSecret(slack.token, 'slack.token');
  assertUsableToken(token);
  assertUsableChannel(slack.channel);

  const http = new HttpClient({
    baseUrl: SLACK_API,
    headers: { Authorization: `Bearer ${token}` },
    minIntervalMs: 1200, // Slack's conversations.history tier is ~50/minute.
    onThrottle: (waitMs) =>
      process.stderr.write(`  slack throttled; waiting ${Math.round(waitMs / 1000)}s\n`),
  });

  const me = await call<{ user_id: string }>(http, 'auth.test', {});
  const channel = slack.channel ?? (await selfDmChannel(http, me.user_id));

  // Only look back a bounded window: re-reading all history on every sync
  // would be slow and would re-litigate messages already in the ledger.
  const lookbackDays = slack.lookbackDays ?? 14;
  const oldest = ((Date.now() - lookbackDays * 86400_000) / 1000).toFixed(6);

  const history = await call<{ messages: SlackMessage[] }>(http, 'conversations.history', {
    channel,
    oldest,
    limit: '200',
  });

  const seen = knownSignalIds();
  const result: SlackSyncResult = { scanned: 0, imported: 0, skipped: 0, unparsed: [] };

  // Earliest start already claimed per day, seeded from what is on file so a
  // second sync stacks behind the first rather than on top of it.
  const claimed = new Map<string, number>();
  for (const signal of existingManualSignals()) {
    const day = localDate(signal.start);
    claimed.set(day, Math.min(claimed.get(day) ?? signal.start, signal.start));
  }

  // Oldest first, so each new entry stacks behind the one before it.
  const ordered = [...(history.messages ?? [])].sort((a, b) => Number(a.ts) - Number(b.ts));

  for (const message of ordered) {
    // Ignore joins, topic changes, and anything a bot wrote.
    if (message.subtype || message.bot_id) continue;
    // In a shared channel, only your own messages are your timesheet.
    if (slack.channel && message.user && message.user !== me.user_id) continue;

    const text = (message.text ?? '').trim();
    if (!text) continue;

    result.scanned++;

    // The Slack ts is a stable per-message id, so re-syncing is idempotent.
    const id = `slack:${message.ts}`;
    if (seen.has(id)) {
      result.skipped++;
      continue;
    }

    // Anchor the entry so it ends where the earliest already-claimed manual
    // block on that day begins, rather than at the message timestamp.
    //
    // People log in bursts: three messages in five minutes, each saying "last
    // half an hour". Anchored at their timestamps they all reach backwards
    // over the same minutes, and the timeline sweep then clips two of them to
    // almost nothing. Stacking them backwards preserves what each person
    // actually said while still never double-counting a minute.
    const messageAt = Number(message.ts) * 1000;
    const day = localDate(messageAt);
    const at = Math.min(messageAt, claimed.get(day) ?? messageAt);

    const parsed = parseManualEntry(stripSlackMarkup(text), { at });

    if (!parsed) {
      // No duration stated. We never guess one — "I worked on the API today"
      // says what, not how long.
      result.unparsed.push(text.slice(0, 80));
      continue;
    }

    const signal: Signal = { ...parsed, id, detail: 'logged in Slack' };
    appendManualSignal(signal);

    const startedOn = localDate(signal.start);
    claimed.set(startedOn, Math.min(claimed.get(startedOn) ?? signal.start, signal.start));

    result.imported++;
  }

  return result;
}

/**
 * Reject the wrong kind of token before spending a request on it.
 *
 * Slack hands out four credentials that all look like tokens, and only one can
 * read your own DMs. Failing here with the prefix named is far kinder than a
 * generic `invalid_auth` from the API, which sends people back to hunt through
 * four identical-looking strings.
 */
export function assertUsableToken(token: string): void {
  const wrong: Record<string, string> = {
    'xapp-': 'an App-Level Token, used for Socket Mode connections',
    'xoxe-': 'an App Configuration Token, used for the app manifest API',
    'xoxb-': 'a Bot User OAuth Token; a bot is not in the DM you have with yourself',
  };

  for (const [prefix, what] of Object.entries(wrong)) {
    if (token.startsWith(prefix)) {
      throw new Error(
        `That is ${what}.\n\n` +
          'punchcard needs the User OAuth Token, which starts with xoxp-.\n' +
          'Find it at api.slack.com/apps, your app, OAuth & Permissions, ' +
          'OAuth Tokens, User OAuth Token. It only appears once the app is ' +
          'installed to the workspace.',
      );
    }
  }

  if (!token.startsWith('xoxp-')) {
    throw new Error(
      'slack.token does not look like a User OAuth Token. Expected it to start ' +
        'with xoxp-. See api.slack.com/apps, OAuth & Permissions.',
    );
  }
}

/**
 * Slack addresses conversations by id, not by name.
 *
 * Reading a named channel would also need channels:history or groups:history,
 * which the shipped manifest deliberately does not request: the self-DM keeps
 * punchcard's reach to a conversation containing nothing but your own notes.
 */
export function assertUsableChannel(channel?: string): void {
  if (!channel) return;

  if (!/^[CGD][A-Z0-9]{6,}$/.test(channel)) {
    throw new Error(
      `slack.channel is "${channel}", which looks like a channel name rather than an id.\n\n` +
        'Either remove it to use the DM you have with yourself (recommended, and what ' +
        'the shipped manifest is scoped for), or use the channel id: open the channel ' +
        'in Slack, click its name, and copy the ID at the bottom of that dialog. Reading ' +
        'a channel also needs the channels:history scope, which the default manifest ' +
        'does not request.',
    );
  }
}

/**
 * Find the DM you have with yourself.
 *
 * `conversations.open` with your own user id returns channel_not_found: Slack
 * treats the self-DM as a conversation that already exists rather than one you
 * open. So it has to be located by listing your IM conversations and matching
 * on your own user id, which is why the manifest asks for im:read.
 */
async function selfDmChannel(http: HttpClient, userId: string): Promise<string> {
  try {
    const list = await call<{ channels: Array<{ id: string; user?: string }> }>(
      http,
      'users.conversations',
      { types: 'im', limit: '1000' },
    );

    const self = (list.channels ?? []).find((c) => c.user === userId);
    if (self) return self.id;
  } catch (err) {
    const message = (err as Error).message;
    if (message.includes('missing_scope')) {
      throw new Error(
        'Slack needs the im:read scope to find the DM you have with yourself.\n\n' +
          'Open your app at api.slack.com/apps, go to OAuth & Permissions, add ' +
          'im:read under User Token Scopes, then reinstall the app and copy the ' +
          'new User OAuth Token. Reinstalling is required whenever scopes change.',
      );
    }
    throw err;
  }

  // Fall back to opening it, which works for some workspace configurations.
  const opened = await call<{ channel: { id: string } }>(http, 'conversations.open', {
    users: userId,
  });
  return opened.channel.id;
}

/**
 * Slack's Web API returns HTTP 200 for logical failures, with `ok: false` and
 * an error code in the body — so a plain response.ok check silently succeeds
 * on an expired token.
 */
async function call<T>(
  http: HttpClient,
  method: string,
  params: Record<string, string>,
): Promise<T> {
  const query = new URLSearchParams(params).toString();
  const body = await http.get<{ ok: boolean; error?: string } & T>(
    `/${method}${query ? `?${query}` : ''}`,
  );

  if (!body.ok) {
    throw new Error(`slack ${method}: ${body.error ?? 'unknown error'}${hint(body.error)}`);
  }
  return body;
}

function hint(error?: string): string {
  if (error === 'missing_scope') return ': add the im:history and im:write user-token scopes';
  if (error === 'invalid_auth' || error === 'token_revoked') return ': regenerate the user token';
  if (error === 'not_in_channel') return ': invite yourself to that channel first';
  return '';
}

/**
 * Flatten Slack's markup so it doesn't end up in a client-facing description:
 * user mentions, channel links, and URL syntax.
 */
export function stripSlackMarkup(text: string): string {
  return text
    .replace(/<@[A-Z0-9]+\|([^>]+)>/g, '$1')
    .replace(/<@([A-Z0-9]+)>/g, '')
    .replace(/<#[A-Z0-9]+\|([^>]+)>/g, '#$1')
    .replace(/<(https?:\/\/[^|>]+)\|([^>]+)>/g, '$2')
    .replace(/<(https?:\/\/[^>]+)>/g, '$1')
    .replace(/[*_~`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
