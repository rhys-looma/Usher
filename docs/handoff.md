# When a task finishes

An owner chooses, per task, what the person gets when a run finishes. The setting is on the task's page in the dashboard, under **When it finishes**. A task with no setting and no retrieve page stays in the assistant.

This applies to Usher's hosted path, where Usher fills the form in its own browser. An assistant driving the person's own browser already has their session, so it only needs the retrieve page.

## The options

| Option | What the person gets | What your site needs |
| --- | --- | --- |
| **Stay in the assistant** | What you choose to return, and your message. No link. | Nothing |
| **Tell them how to retrieve it** | The reference and a link to your own retrieve page, where they enter it | A page where people can find a result |
| **Open it on your site** | A one-time link straight to their result | A small route on your server |

Whichever you choose, you also set:

- **What it returns:** everything your result page shows, only the reference, or nothing. A person told to retrieve a result always gets the reference, since they need it.
- **Your message:** up to 300 characters, shown word for word. Use it for what happens next, such as when documents arrive or who to call.

## Opening it on your site

Usher fills the form in its own browser, so your site's session belongs to that browser, not the person's. Usher never copies that session across. Instead, your server starts a new one for the person, in three steps:

1. **When the result is created,** your server records which Usher session asked for it. The server check you already use gives you `check.claims.sid`.
2. **When the run finishes,** Usher signs a one-time token for that session and gives the person a link to your route.
3. **When the person opens it,** your server checks the token, finds the result by session and starts its own session.

### With Node

```js
import { createUsherCheck, sendHandoffPage } from '@usher/site-middleware';

const usher = createUsherCheck({ registry: 'https://your-registry.example', origin: 'https://your-site.example', intent: 'your.task' });

// Where the result is created.
const check = await usher.check(req, { form, action: 'form.submit' });
if (check.status === 'knock_required') return usher.reject(req, res, check, 'form.submit');
if (check.status === 'ok') saveResult({ ...result, usherSession: check.claims.sid });

// The new route. GET shows a page; only POST uses the token up.
app.get('/usher/handoff', (req, res) => sendHandoffPage(res, req.query.token));
app.post('/usher/handoff', async (req, res) => {
  const opened = await usher.openHandoff(req, req.body.token);
  const result = opened.ok && findResultByUsherSession(opened.sid);
  if (!result) return res.redirect('/retrieve');
  startNewSession(res, result); // your own cookie, as after any sign-in
  res.redirect(resultPageFor(result));
});
```

`saveResult`, `findResultByUsherSession`, `startNewSession` and `resultPageFor` stand for your own code.

`@usher/site-middleware` isn't on npm yet. Build it from [`packages/site-middleware`](../packages/site-middleware) in this repository, or follow the checks below.

Then choose **Open it on your site** on the task's page and enter the route.

### With another language

The token is a JWT signed with Ed25519. On the POST, check all of these and refuse anything else:

| Check | Value |
| --- | --- |
| Header | `alg` is `EdDSA`, `typ` is `usher+jwt` |
| Signature | Against the key with that `kid` at `<registry>/.well-known/usher-keys.json` |
| `scope` | Exactly `handoff`. **An agent's ordinary token must never open a session.** |
| `iss` | Your registry |
| `origin` | Your site |
| `exp` | Not passed |
| `jti` | Not seen before. Record it until `exp`. |

Then look up the result by `sid`.

## What to check before switching it on

- **POST only:** use the token up on the POST, never the GET. Chat apps fetch links to draw previews, and that would spend it before the person clicks.
- **More than one server:** `openHandoff` remembers used tokens in memory. If you run several instances, pass a shared `replay` cache, or a token could be used once on each.
- **A new session:** start a new one rather than adding to the visitor's current session, and don't merge it into an account they're already signed in to. Someone could send a person a link to their own result.
- **Limit what it opens:** anyone holding the link in its 15 minutes can open that result. Buying, changing details or seeing other records should still ask for proof.
- **Keep a retrieve page:** if the link has expired or been used, send the person there. Set it on the task's page too.
- **Logs:** the token appears in the address on the GET. It's short-lived and single-use, but leave it out of your logs if you can.

Usher never sees your session or anyone's answers. Your server decides who gets in, and can refuse any handoff.
