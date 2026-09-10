import type { Config } from '../config.js';
import type { Adapter } from '../types.js';
import { ClockifyAdapter } from './clockify.js';
import { JiraAdapter } from './jira.js';
import { TogglAdapter } from './toggl.js';

export interface AdapterInfo {
  id: string;
  label: string;
  /** Shown when picking a destination during `punch init`. */
  blurb: string;
  /** Config keys the user must supply, rendered into a config stub. */
  fields: Array<{ key: string; hint: string; secret?: boolean }>;
  create: (cfg: Config) => Adapter;
}

/**
 * The destination registry.
 *
 * Ordered by what we actually recommend, not by popularity: Toggl leads
 * because its free tier has no punitive request budget, so the tool works for
 * everyone on day one. Clockify has a larger install base but throttles new
 * free workspaces to roughly thirty requests an hour.
 */
export const ADAPTERS: AdapterInfo[] = [
  {
    id: 'toggl',
    label: 'Toggl Track',
    blurb: 'One API token, generous free tier. The easiest place to start.',
    fields: [
      { key: 'apiToken', hint: 'Profile settings → API token', secret: true },
      { key: 'workspaceId', hint: 'optional, defaults to your default workspace' },
    ],
    create: (cfg) => new TogglAdapter(cfg),
  },
  {
    id: 'jira',
    label: 'Jira (native worklogs)',
    blurb: 'Logs against issue keys picked up from your branch names. Needs no extra purchase.',
    fields: [
      { key: 'site', hint: 'your-team.atlassian.net' },
      { key: 'email', hint: 'your Atlassian account email', secret: true },
      { key: 'apiToken', hint: 'id.atlassian.com API tokens', secret: true },
      { key: 'fallbackIssue', hint: 'optional, e.g. KAN-13, for meetings and admin' },
    ],
    create: (cfg) => new JiraAdapter(cfg),
  },
  {
    id: 'clockify',
    label: 'Clockify',
    blurb:
      'Huge install base and a free tier. New free workspaces allow only ~30 API ' +
      'requests per hour, so push daily rather than weekly.',
    fields: [
      { key: 'apiKey', hint: 'Profile settings → API → generate', secret: true },
      { key: 'workspaceId', hint: 'optional, defaults to your active workspace' },
    ],
    create: (cfg) => new ClockifyAdapter(cfg),
  },
];

export function getAdapterInfo(id: string): AdapterInfo | undefined {
  return ADAPTERS.find((a) => a.id === id);
}

export function createAdapter(cfg: Config, requested?: string): Adapter {
  const configured = Object.keys(cfg.adapters);
  const chosen = requested ?? configured[0];

  if (!chosen) {
    throw new Error(
      'No destination configured. Run `punch destinations` to see the options, ' +
        'or `punch init` to set one up.',
    );
  }

  const info = getAdapterInfo(chosen);
  if (!info) {
    throw new Error(
      `Unknown destination "${chosen}". Available: ${ADAPTERS.map((a) => a.id).join(', ')}`,
    );
  }

  if (!cfg.adapters[chosen]) {
    throw new Error(
      `"${chosen}" is not configured yet. Add it under \`adapters:\` in your config:\n\n` +
        configStub(info),
    );
  }

  return info.create(cfg);
}

/** A paste-ready YAML block for a destination, with env: indirection for secrets. */
export function configStub(info: AdapterInfo): string {
  const lines = [`  ${info.id}:`];
  for (const field of info.fields) {
    const value = field.secret
      ? `env:${info.id.toUpperCase()}_${field.key.replace(/([A-Z])/g, '_$1').toUpperCase()}`
      : `<${field.key}>`;
    lines.push(`    ${field.key}: ${value}   # ${field.hint}`);
  }
  return `adapters:\n${lines.join('\n')}\n`;
}
