// Site apps (LU-57): the tools a site's assistant app shows, generated from its plans, one per
// journey: the name from the intent (quote.health_insurance is get_health_insurance_quote, unless
// the owner renames it), the description from the journey's title and the site's own guidance, and
// the parameters from the plan's ask_first by semantic key, with the site's labels, its options and
// its formats. The hosted server (packages/mcp/src/site-app.ts) registers them; the dashboard shows
// the same list for the owner to rename, hide and describe.

import type { Registry, SiteApp } from './registry.ts';

/** A tool name from an intent: quote.health_insurance is get_health_insurance_quote; contact.callback is request_callback. */
export function toolNameFor(intent: string): string {
  const [verb, ...rest] = intent.split('.');
  const object = rest.join('_');
  const name = verb === 'quote' ? `get_${object}_quote` : verb === 'contact' ? `request_${object}` : verb === 'apply' ? `apply_for_${object}` : `${verb}_${object}`;
  return name.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '').slice(0, 64);
}

/** A parameter name from a semantic key: person.first_name is person_first_name. */
export const paramFor = (key: string) => key.replace(/[^A-Za-z0-9_]+/g, '_');

export interface SiteToolParam {
  name: string;
  key: string;
  description: string;
  options?: string[];
  required: boolean;
}

export interface SiteTool {
  name: string;
  intent: string;
  url: string;
  title: string;
  description: string;
  params: SiteToolParam[];
  /** Hidden by the owner (listed only for the dashboard). */
  hidden?: boolean;
}

/** The tools a site's app shows, from its plans and the owner's settings (renamed, hidden, described). */
export async function siteTools(registry: Registry, origin: string, app: SiteApp, options: { includeHidden?: boolean } = {}): Promise<SiteTool[]> {
  const name = await registry.displayName(origin);
  const rules = (await registry.storage.getPolicy(origin))?.text;
  const out: SiteTool[] = [];
  for (const journey of await registry.journeys(origin)) {
    const own = app.tools?.[journey.intent] ?? {};
    if (own.hidden && !options.includeHidden) continue;
    const found = await registry.browserPlanFor(`${origin}${journey.start}`, journey.intent);
    if (!found) continue;
    const params: SiteToolParam[] = found.view.ask_first.map((a) => ({
      name: paramFor(a.key),
      key: a.key,
      description: [a.label, a.theirs ? 'Their own answer: only as they said it; Usher puts it back to them before anything is submitted.' : '', a.format ? `As ${a.format}.` : '', a.only_if ? `Only ${a.only_if}.` : ''].filter(Boolean).join(' '),
      ...(a.options && !a.more_options && { options: a.options }),
      required: a.required,
    }));
    const title = `${journey.title.replace(/^(.)/, (c) => c.toUpperCase())} from ${name}`;
    const description = [
      own.description?.trim() || `${title}.`,
      'Give what the person has told you by these parameters, or their own words in details. Usher fills the form on the site; anything missing, and anything that is theirs to decide (the site\'s own wording, word for word, and the final step), comes back as a short set of questions for them, which you put to them and answer with usher_confirm. Never answer for them.',
      `Runs under ${name}'s rules${rules ? `: ${rules.trim()}` : '.'}`,
    ].join(' ');
    out.push({ name: own.name?.trim() || toolNameFor(journey.intent), intent: journey.intent, url: `${origin}${journey.start}`, title, description, params, ...(own.hidden && { hidden: true }) });
  }
  return out;
}


const RESERVED = new Set(['usher_confirm', 'usher_cancel', 'usher_fill', 'knock', 'get_plan', 'prepare_run', 'plan_status', 'get_map', 'submit_map', 'report_run']);

/**
 * The owner's settings for each journey's tool, checked: a name of lower-case letters, digits and
 * underscores (3 to 64, unique, none of Usher's own), a description in plain words of at most 600
 * characters, and whether it is hidden. Empty means the generated one.
 */
export function checkToolSettings(input: Record<string, { name?: string; description?: string; hidden?: boolean }>, intents: string[]): { tools: NonNullable<SiteApp['tools']> } | { problems: string[] } {
  const tools: NonNullable<SiteApp['tools']> = {};
  const problems: string[] = [];
  const names = new Map<string, string>();
  for (const intent of intents) {
    const own = input[intent] ?? {};
    const name = (own.name ?? '').trim();
    const description = (own.description ?? '').replace(/[\u0000-\u0008\u000b-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim();
    const effective = name || toolNameFor(intent);
    if (name && !/^[a-z][a-z0-9_]{2,63}$/.test(name)) problems.push(`"${name}" isn't a tool name: lower-case letters, digits and underscores, 3 to 64, starting with a letter.`);
    else if (RESERVED.has(effective)) problems.push(`"${effective}" is one of Usher's own tools.`);
    else if (names.has(effective)) problems.push(`Two tools would be called "${effective}".`);
    names.set(effective, intent);
    if (description.length > 600) problems.push(`The description for ${intentLabelOf(intent)} is longer than 600 characters.`);
    const entry = { ...(name && { name }), ...(description && { description }), ...(own.hidden && { hidden: true }) };
    if (Object.keys(entry).length) tools[intent] = entry;
  }
  return problems.length ? { problems } : { tools };
}

const intentLabelOf = (intent: string) => intent.split('.').slice(1).join(' ').replace(/[_-]+/g, ' ') || intent;

/** Things a person might say to an assistant that would use the app: plain, with nobody's details. */
export function examplePrompts(name: string, tools: Pick<SiteTool, 'title' | 'intent' | 'hidden'>[]): string[] {
  const out: string[] = [];
  for (const t of tools.filter((x) => !x.hidden)) {
    const what = t.title.replace(new RegExp(` from ${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`), '').replace(/^(.)/, (c) => c.toLowerCase());
    out.push(`Get me a ${what} from ${name}.`, `I'd like a ${what} from ${name}. Ask me for whatever you need, then show me the price.`);
  }
  if (out.length) out.push(`What can ${name} do for me here?`);
  return out;
}

/**
 * What a directory listing asks for (Claude's connectors, ChatGPT's apps), filled in from the site's
 * app: the name, short and long descriptions, the endpoint, the tools with their annotations, the
 * example prompts, the logo, and how data is handled. The owner adds their own contact and policy
 * links before submitting.
 */
export interface DirectoryPack {
  name: string;
  short_description: string;
  long_description: string;
  endpoint: string;
  authentication: string;
  tools: { name: string; title: string; description: string; read_only: boolean; destructive: boolean; open_world: boolean }[];
  example_prompts: string[];
  logo?: string;
  data_handling: string;
  site: string;
  to_add: string[];
}

export function directoryPack(input: { name: string; origin: string; endpoint: string; tools: SiteTool[]; logo?: string; registry: string }): DirectoryPack {
  const visible = input.tools.filter((t) => !t.hidden);
  const what = visible.map((t) => t.title.replace(/ from .*$/, '').toLowerCase());
  const list = what.length > 1 ? `${what.slice(0, -1).join(', ')} and ${what.at(-1)}` : (what[0] ?? 'its forms');
  return {
    name: input.name,
    short_description: `${list.replace(/^(.)/, (c) => c.toUpperCase())} from ${input.name}, in the chat.`.slice(0, 80),
    long_description: `${input.name}'s assistant app gets you a ${list} without leaving the chat. Tell your assistant what you need in your own words; it asks for anything missing, shows you ${input.name}'s own wording for every declaration and consent, and submits only when you say so. Run by Usher under ${input.name}'s rules.`,
    endpoint: input.endpoint,
    authentication: 'None: no account is needed. Each connection gets its own short-lived key from Usher.',
    tools: [
      ...visible.map((t) => ({ name: t.name, title: t.title, description: t.description, read_only: false, destructive: false, open_world: true })),
      { name: 'usher_confirm', title: 'Submit with the person\'s answers', description: 'Goes on with the person\'s own answers to the questions the site asked.', read_only: false, destructive: false, open_world: true },
      { name: 'usher_cancel', title: 'Abandon a fill', description: 'Stops a fill; nothing more is entered or submitted.', read_only: false, destructive: false, open_world: false },
    ],
    example_prompts: examplePrompts(input.name, visible),
    ...(input.logo && { logo: input.logo }),
    data_handling: `Usher fills ${input.name}'s own forms in its own browser for the person and keeps none of what they typed: no values are stored, logged or used for training. Sessions keep which fields were filled, by name, never their contents. ${input.registry}/privacy`,
    site: input.origin,
    to_add: ['Your support contact (an email address or page).', `${input.name}'s privacy policy link.`, 'Your terms of service link, if the directory asks for one.', 'Screenshots: the cards in a chat (the theme page shows them).'],
  };
}

/** The pack as Markdown, to read or paste into a directory's form. */
export function directoryPackMarkdown(p: DirectoryPack): string {
  return [
    `# ${p.name}: assistant app directory submission`,
    '',
    `- **Name:** ${p.name}`,
    `- **Short description:** ${p.short_description}`,
    `- **MCP server URL:** ${p.endpoint}`,
    `- **Authentication:** ${p.authentication}`,
    `- **Website:** ${p.site}`,
    '',
    '## Description',
    '',
    p.long_description,
    '',
    '## Tools',
    '',
    ...p.tools.map((t) => `- \`${t.name}\` (${t.title}): ${t.description} Read-only: ${t.read_only ? 'yes' : 'no'}; destructive: ${t.destructive ? 'yes' : 'no'}; acts on the open web: ${t.open_world ? 'yes' : 'no'}.`),
    '',
    '## Example prompts',
    '',
    ...p.example_prompts.map((e) => `- ${e}`),
    '',
    '## Data handling',
    '',
    p.data_handling,
    '',
    '## Still to add',
    '',
    ...p.to_add.map((t) => `- ${t}`),
    '',
    p.logo ? 'The logo is in the JSON version of this pack, as a PNG.' : 'No logo yet: set one on the theme page.',
    '',
  ].join('\n');
}
