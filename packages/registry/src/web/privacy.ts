// The privacy notice (/privacy), robots.txt and security.txt. Plain words, one page. It describes
// what this code does; change it when the code changes.

import { html, page } from './html.ts';
import { DEFAULT_RETENTION_DAYS } from '../registry.ts';

const REPOSITORY = 'https://github.com/rhys-looma/Usher';

export function privacyPage(o: { contact?: string; url: string }): string {
  const contact = o.contact ? html`<a href="mailto:${o.contact}">${o.contact}</a>` : 'the people who run this service';
  return page(
    'Privacy',
    html`<h1>Privacy</h1>
<p class="lede">What Usher keeps, and what it never sees. Questions, or a request to see or delete what we hold about you: ${contact}.</p>

<div class="card"><h2>The "I run a site with forms" form</h2>
<p>We store what you send: your site's address, your email address and your note, with the time and whether a person or an agent sent it. We use it only to reply to you about Usher. It is kept until you ask us to delete it, and only the people who run Usher can read it.</p></div>

<div class="card"><h2>The site script on websites that use Usher</h2>
<p>The script never reads or sends what anyone types, and it never tracks people. It sets no cookies.</p>
<ul>
<li><b>For everyone:</b> it fetches the map for the page it is on, sending only the page's address. If the form no longer matches its map, it reports the form's structure (its fields and buttons, never their contents) so the map can be rebuilt.</li>
<li><b>In your browser:</b> it keeps two small notes in local storage: which map it last fetched for a page, and that a changed form was already reported. Neither says anything about you.</li>
<li><b>Only when an AI agent has knocked</b> and been let in does it log what the agent did, by meaning ("filled the email field", "pressed submit"), never with the values.</li>
</ul></div>

<div class="card"><h2>Agent sessions</h2>
<p>When an agent knocks, we record which agent it was (the public key it identified itself with), the site, what it came to do, and the actions logged above. The site's owner can read their own sites' sessions in their dashboard. Sessions are deleted after ${DEFAULT_RETENTION_DAYS} days, or sooner if the site's owner sets a shorter time.</p></div>

<div class="card"><h2>Maps</h2>
<p>Maps describe the structure of public forms: labels, field types and buttons. They never hold values. When a map is built, the page's structure and a screenshot of it are sent to the AI models that label it (Muse Spark from Meta, and Muse Spark Open through Baseten).</p></div>

<div class="card"><h2>Cookies and addresses</h2>
<p>The only cookies are the ones that keep a site owner or an administrator signed in. They are strictly necessary, so there is no cookie banner. Your IP address is used in memory to limit how often one address can call us, and it is never stored.</p></div>

<div class="card"><h2>Where it runs</h2>
<p>Usher runs on Amazon Web Services in London (eu-west-2). The code is open: <a href="${REPOSITORY}">${REPOSITORY}</a>.</p></div>`,
  );
}

export const ROBOTS = 'User-agent: *\nAllow: /\n';

/** RFC 9116. Expires 180 days after the server started (under a year, as the RFC asks); a deploy renews it. */
export function securityTxt(o: { contact?: string; url: string; started: Date }): string | null {
  if (!o.contact) return null;
  const expires = new Date(o.started.getTime() + 180 * 86_400_000);
  return [
    `Contact: mailto:${o.contact}`,
    `Expires: ${expires.toISOString().replace(/\.\d{3}Z$/, 'Z')}`,
    `Canonical: ${o.url}/.well-known/security.txt`,
    `Policy: ${REPOSITORY}/blob/main/docs/security.md`,
    'Preferred-Languages: en',
    '',
  ].join('\n');
}
