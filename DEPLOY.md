# Deploying Usher

Usher runs on AWS in eu-west-2:

```
viewer ─▶ CloudFront ─▶ ALB ─┬─ Host $REGISTRY_HOST ─▶ ECS service: registry  ─▶ RDS Postgres
                             └─ Host $SITE_HOST     ─▶ ECS service: mock site
```

| Host | Service | What |
| --- | --- | --- |
| `$REGISTRY_HOST` (the apex domain) | registry | Front page, dashboard, signup and keys, the API agents knock on, `/usher.js`. The map viewer offers a fixed list of public forms; see Configuration. |
| `$SITE_HOST` (the `brightwater` subdomain) | mock site | Brightwater Motor, the fictional quote form for demos |

You create the AWS resources by hand, except the two ECR repositories: Terraform in `deploy/terraform/ecr` creates those and builds and pushes the images. This repository also provides the ECS task definitions and the scripts that migrate, deploy and back up. Throughout this file, `$REGISTRY_HOST` and `$SITE_HOST` stand for your two host names.

The MCP server is not hosted. It holds the agent's private key, so it runs where the agent runs (`npx`/`node` on the agent's machine, see the README), pointed at `https://$REGISTRY_HOST`.

## The quick way: Terraform

`deploy/terraform/ecr` and `deploy/terraform/usher` create everything new in eu-west-2 and change nothing that already exists. That covers:
- Usher's own VPC: two public subnets for the tasks and the ALB, and two private subnets for the database. There's no NAT gateway.
- The ALB, which accepts traffic only from CloudFront's origin-facing prefix list.
- The ECS cluster and both services, built from the templates in `deploy/ecs`.
- A small private Postgres: `db.t4g.micro`, single-AZ, 20 GB gp3, encrypted, 7 days of backups, reachable only from the registry's tasks.
- The five secrets, both certificates (eu-west-2 and us-east-1), and the CloudFront distribution with the cache policy described in step 7 below.

The database password never enters Terraform state: it is an ephemeral value passed only to write-only arguments. Terraform writes `DATABASE_URL`, and you fill the other four secrets.

```sh
# 1. Images (once per commit)
cd deploy/terraform/ecr && terraform init && terraform apply -var git_sha=$(git rev-parse --short=12 HEAD)

# 2. Phase 1: network, database, cluster, roles, secrets, certificate requests
cd ../usher && cp terraform.tfvars.example terraform.tfvars   # hosts, contact email, image_tag
terraform init && terraform apply
terraform output certificate_validation_records               # add these CNAMEs to DNS, unless route53_zone_id is set (then they're made for you)
../../../scripts/put-secrets.sh                               # model keys (asked), signing and admin keys (generated)

# 3. Phase 2, once both certificates show as issued: ALB listener, services, CloudFront
terraform apply -var certificates_issued=true                 # or set it in terraform.tfvars
terraform output dns_records                                  # point both hosts at CloudFront, unless route53_zone_id is set
terraform output -raw config_env > ../../ecs/config.env       # for scripts/ecs-deploy.sh and friends
```

Then:
- **Register the demo site** as in step 9. Set `MOCK_SITE_KEY` in `deploy/ecs/config.env` (and `mock_site_key` in `terraform.tfvars`), then run `scripts/ecs-deploy.sh "" mock-site`.
- **Later deploys:** push with the ECR stack, then run `scripts/ecs-deploy.sh <sha>`.
- **Smoke test:** step 10 applies as written.
- **State is local and gitignored.** It holds no secret values.

| Item | ≈ $/month |
| --- | --- |
| Registry on Fargate (1 vCPU, 2 GB) + demo site (0.25 vCPU, 0.5 GB) | 52 |
| RDS `db.t4g.micro`, 20 GB gp3 | 16 |
| ALB (base charge plus light use) | 20 |
| Public IPv4: 2 tasks plus the ALB's 2 | 15 |
| Secrets, logs, ECR, CloudFront at low traffic | 5 |
| **Total** | **≈ 108** |

These are rough on-demand London figures, before model spend. Without Terraform, the steps below build the same thing by hand.

## 0. Before you start

- **Tools:** AWS CLI v2, Terraform 1.6 or later (`brew install terraform`), Docker with buildx (images are built for `linux/amd64`; Apple silicon emulates), Node 20 and `npm install` at the repository root, and `jq`. For backups, also the Session Manager plugin (`brew install --cask session-manager-plugin`).
- **Dry run:** it runs the production images on your host names, behind a local stand-in for CloudFront and the ALB. The stand-in ends TLS, keeps Host, sends `CloudFront-Forwarded-Proto: https` and a two-hop `X-Forwarded-For`, and sends `X-Forwarded-Proto: http`, as an ALB reached over http would. It covers production mode, cache headers, the signup flow and the end-to-end agent run. Port 443 must be free.

  ```sh
  REGISTRY_PUBLIC_URL=https://$REGISTRY_HOST USHER_SITE_URL=https://$SITE_HOST npm run dryrun
  ```
- **Config file:** copy `deploy/ecs/config.example.env` to `deploy/ecs/config.env` (gitignored). You fill it in as you go; every script reads it.

## 1. What you create by hand

Each resource's "Value for `config.env` / the app" is what you carry over.

| Create | Settings the app relies on | Value for `config.env` / the app |
| --- | --- | --- |
| **ECR** repositories `usher-registry`, `usher-mock-site` | **Made by Terraform in step 4**, not by hand: tags mutable (`:latest` moves), scan on push, the 20 newest images kept, untagged layers gone after a day | `AWS_ACCOUNT_ID`, `REGISTRY_REPO`, `SITE_REPO`. Repo URIs are `<account>.dkr.ecr.eu-west-2.amazonaws.com/<repo>` (`terraform output repositories`). |
| **RDS** PostgreSQL 16 | `db.t4g.micro`, 20 GB gp3, encrypted, **not** publicly accessible, automated backups on (7 days), deletion protection. Database `usher`, user `usher`. Security group: 5432 from the registry tasks' security group only. | The **endpoint**, for `DATABASE_URL` (step 3) |
| **Secrets Manager**: five plain-text secrets, `usher/DATABASE_URL`, `usher/MODEL_API_KEY`, `usher/BASETEN_API_KEY`, `usher/USHER_SIGNING_KEY`, `usher/USHER_ADMIN_KEY` | Values in step 3 | `SECRET_PREFIX=usher`. The ARNs are looked up by name when task definitions are rendered; to give one directly, set `SECRET_ARN_<NAME>`. |
| **CloudWatch log groups** `/ecs/usher-registry`, `/ecs/usher-mock-site` | Retention 30 days | none |
| **IAM execution role** (trusted by `ecs-tasks.amazonaws.com`) | `AmazonECSTaskExecutionRolePolicy`, plus `secretsmanager:GetSecretValue` on the five secrets | `EXECUTION_ROLE_ARN` |
| **IAM task role** for the registry | `ssmmessages:CreateControlChannel`, `CreateDataChannel`, `OpenControlChannel`, `OpenDataChannel` (ECS Exec, used by backups). The app calls no AWS API. | `TASK_ROLE_ARN` |
| **Security groups** | ALB: 443 inbound from the managed prefix list `com.amazonaws.global.cloudfront.origin-facing` only, so nothing can skip CloudFront and forge forwarded headers. Registry tasks: 4200 from the ALB's group. Mock site tasks: 4100 from the ALB's group. All three: outbound open (images, model APIs, sites the registry maps). | `TASK_SECURITY_GROUP`: the registry's, used by the migrate task |
| **Subnets** | Private subnets with a NAT gateway, in two or more availability zones. Public subnets work with `ASSIGN_PUBLIC_IP=ENABLED`. | `TASK_SUBNETS`, `ASSIGN_PUBLIC_IP` |
| **ACM certificates**, both covering `$REGISTRY_HOST` and `$SITE_HOST` | One in **eu-west-2** for the ALB; one in **us-east-1** for CloudFront (CloudFront only uses us-east-1) | none |
| **ALB**, internet-facing | HTTPS listener on 443 with the eu-west-2 certificate; idle timeout 120 s; default action: fixed 404. Target groups, type **ip**, HTTP: registry on 4200, mock site on 4100, health check `GET /healthz` expecting 200. Listener rules: host header `$REGISTRY_HOST` → registry target group; host header `$SITE_HOST` → mock site target group. | The **ALB DNS name**, for CloudFront's origin |
| **ECS cluster** (Fargate) | none | `ECS_CLUSTER` |
| **ECS services** `usher-registry`, `usher-mock-site` | Created in step 6, from the task definitions this repository registers | `REGISTRY_SERVICE`, `SITE_SERVICE` |
| **CloudFront distribution** | See step 7 | Its domain name, for DNS |

Also set `REGISTRY_HOST`, `SITE_HOST`, `CONTACT_EMAIL` (named on `/privacy` and in `security.txt`) and `DAILY_MODEL_BUDGET_USD` in `config.env`.

## 2. Generate keys

```sh
npm run keygen                       # one line of JSON: the token signing key (USHER_SIGNING_KEY)
openssl rand -base64 32              # the admin key (USHER_ADMIN_KEY): /admin and the demo's layout switch
```

The signing key is a private Ed25519 JWK. Its public half is what `/.well-known/usher-keys.json` publishes. Keep the admin key in your password manager.

## 3. Create the secrets

Pipe values in, so they never appear on a command line, in shell history or in a file:

```sh
npm run --silent keygen | aws secretsmanager create-secret --name usher/USHER_SIGNING_KEY --secret-string file:///dev/stdin
read -rs v && printf %s "$v" | aws secretsmanager create-secret --name usher/USHER_ADMIN_KEY --secret-string file:///dev/stdin; unset v
read -rs v && printf %s "$v" | aws secretsmanager create-secret --name usher/MODEL_API_KEY --secret-string file:///dev/stdin; unset v
read -rs v && printf %s "$v" | aws secretsmanager create-secret --name usher/BASETEN_API_KEY --secret-string file:///dev/stdin; unset v
read -rs v && printf %s "$v" | aws secretsmanager create-secret --name usher/DATABASE_URL --secret-string file:///dev/stdin; unset v
```

`DATABASE_URL` is `postgres://usher:<password>@<RDS endpoint>:5432/usher?sslmode=no-verify`. RDS requires TLS; `no-verify` encrypts without pinning the RDS certificate authority.

## 4. Create ECR, build and push

```sh
cd deploy/terraform/ecr
terraform init
terraform apply -var git_sha=$(git rev-parse --short=12 HEAD)
```

This creates the two repositories, then runs `scripts/ecr-push.sh`. The script builds both images for `linux/amd64`, tags each with the git SHA and `latest`, logs in to ECR and pushes them. It refuses uncommitted changes, so a SHA tag always means that commit. Applying again with a new SHA rebuilds and pushes; the same SHA does nothing.

State is local (`deploy/terraform/ecr/terraform.tfstate`, gitignored). It holds no secrets, only the repositories. To push without Terraform once the repositories exist, run `scripts/ecr-push.sh` (it reads `deploy/ecs/config.env`).

| Image | Size (uncompressed / in ECR) | Contents |
| --- | --- | --- |
| registry | 857 MB / ≈ 360 MB | Node 20 slim, production dependencies, Chromium's headless shell for the keeper and the map viewer (2.6 GB before; that image carried three full browsers) |
| mock site | 136 MB / ≈ 52 MB | Node 20 Alpine, the site and the bundled server-side check |

Both are multi-stage builds that run as the unprivileged `node` user, listen on `PORT`, and declare a `HEALTHCHECK` on `/healthz`.

## 5. Run the migrations

```sh
scripts/ecs-migrate.sh            # the current commit's image
```

The script registers `deploy/ecs/migrate.json` (the registry image, command `node --import tsx packages/registry/scripts/db.ts migrate`, only `DATABASE_URL`). It then runs the task once and waits, and fails if the migration did. The command it runs:

```sh
aws ecs run-task --cluster "$ECS_CLUSTER" --launch-type FARGATE --task-definition usher-migrate \
  --network-configuration "awsvpcConfiguration={subnets=[$TASK_SUBNETS],securityGroups=[$TASK_SECURITY_GROUP],assignPublicIp=DISABLED}"
```

The registry also migrates on start. Migrations take a Postgres advisory lock, so the two never race.

## 6. Register and deploy both services

```sh
scripts/ecs-deploy.sh             # the current commit's images, both services; or: scripts/ecs-deploy.sh <sha> registry|mock-site|both
```

The script renders `deploy/ecs/registry.json` and `mock-site.json` with your account, region, image tag, hosts and secret ARNs. It registers them, updates the services, waits until both are stable, and prints each `/healthz`.

**The first time,** the services don't exist yet. The script registers the task definitions and stops with their ARNs. Create each service in the cluster from its task definition:
- Fargate, desired count 1, your subnets, the matching security group and target group (registry: container port 4200; mock site: 4100);
- rolling deployment with the circuit breaker and rollback on;
- health-check grace period 120 s (registry) or 30 s (mock site);
- for the registry, **ECS Exec on** (`--enable-execute-command`), which backups use.

Then run the script again.

| Task definition | Size | Environment | Secrets |
| --- | --- | --- | --- |
| `usher-registry` | 1 vCPU, 2 GB (Chromium) | `NODE_ENV=production`, `PORT=4200`, `REGISTRY_PUBLIC_URL`, `TRUSTED_PROXY_HOPS=2`, `USHER_DAILY_MODEL_BUDGET_USD`, `USHER_CONTACT_EMAIL`, `USHER_SEED=mock-site`, `USHER_SEED_ORIGIN`, `USHER_KEEPER_ORIGINS` | all five |
| `usher-mock-site` | 0.25 vCPU, 0.5 GB | `NODE_ENV=production`, `PORT=4100`, `USHER_REGISTRY_URL`, `USHER_SITE_ORIGIN`, `USHER_SITE_KEY` | `USHER_ADMIN_KEY` |
| `usher-migrate` | 0.25 vCPU, 0.5 GB | none | `DATABASE_URL` |

Logs go to CloudWatch (`awslogs`, the groups above).

## 7. CloudFront

One distribution, both hosts.

**General settings**
- Alternate domain names: `$REGISTRY_HOST` and `$SITE_HOST`.
- Certificate: the us-east-1 one.
- Viewer protocol policy: redirect HTTP to HTTPS.
- Price class: North America and Europe is enough.

**Origin:** the ALB's DNS name.
- Protocol: **HTTPS only**. With the Host header forwarded, CloudFront checks the ALB's certificate against `$REGISTRY_HOST` or `$SITE_HOST`, which the eu-west-2 certificate covers.
- **Origin response timeout: 60 s.** A map viewer compile can take 20–40 s when a picked form isn't cached yet.
- Keep-alive timeout: 5 s.

**Behaviours**

| Path pattern | Cache policy | Origin request policy | Methods |
| --- | --- | --- | --- |
| `/usher.js`, `/usher/*`, `/.well-known/*`, `/spec/*`, `/og.png`, `/robots.txt` | **custom `usher-static`**: TTLs min 0, default 0, max 31536000; cache key: **Host header**, no cookies, no query strings; gzip and brotli on | none (Host goes with the cache key) | GET, HEAD |
| Default (`*`): knock, maps, sessions, rules, drift, dashboard, signup, viewer, admin, front page | **CachingDisabled** | **AllViewerAndCloudFrontHeaders-2022-06** | all |

Why these settings:
- **Host in the cache key:** one distribution serves two hosts, and both answer `/.well-known/…` differently, with different site keys. Without Host in the cache key, one host's claim file would be served for the other. The managed CachingOptimized policy leaves Host out, so it can't be used here.
- **Default TTL 0:** CloudFront caches only what the origin says to. Static routes send `public, max-age`. The versioned site script (`/usher/<version>.js`) is immutable for a year. `/usher.js` and the key set are 5 minutes, so a deploy or a key rotation reaches sites quickly. Specifications and `usher-site.json` are 1 hour; images, `robots.txt` and `security.txt` are 1 day. Everything else, including errors, is `Cache-Control: no-store`.
- **AllViewerAndCloudFrontHeaders:** it forwards Host (the ALB routes on it), cookies, query strings and `CloudFront-Forwarded-Proto`. The registry trusts that header first for the scheme, then `X-Forwarded-Proto`. Plain **AllViewer** also works with an HTTPS origin, because the ALB's `X-Forwarded-Proto` is then `https`.
- **Client addresses:** CloudFront puts the viewer in `X-Forwarded-For` and the ALB appends CloudFront's address. With `TRUSTED_PROXY_HOPS=2`, the registry takes the entry two from the right, so a client can't forge its address for rate limits.

**WAF:** none is needed. If you attach one:
- No bot rules: no Bot Control, and nothing that blocks "AI crawlers". They block exactly the agents Usher lets in.
- In the core rule set, exclude `SizeRestrictions_BODY`. It caps bodies at 8 KB, and agents post maps of up to 256 KB.

## 8. DNS

Point both hosts at the CloudFront distribution's domain name (`dxxxx.cloudfront.net`):
- the apex as an ALIAS/ANAME, or Route 53 alias, or a CNAME flattened at the apex;
- `$SITE_HOST` as a CNAME.

If the DNS is Cloudflare, keep both records **DNS only**. Cloudflare's proxy would add a third hop and its own bot protection.

## 9. Register the demo site

The demo site signs up like any other site:
1. Open `https://$REGISTRY_HOST/sites/new` and enter `https://$SITE_HOST`. Save both keys. Step 2 there shows the tag, which loads `https://$REGISTRY_HOST/usher.js`.
2. Set `MOCK_SITE_KEY` in `config.env` to the site key, then run `scripts/ecs-deploy.sh "" mock-site`. The demo site now carries its tag and serves its claim file.
3. Back on the signup page, press **Check now**. The dashboard opens.

The registry seeds the demo site's maps on start, so the first agent run needs no model calls.

## 10. Smoke test

- [ ] `curl https://$REGISTRY_HOST/healthz` returns `ok: true` and `storage: postgres`. CloudWatch shows `production` in the registry's start line.
- [ ] `curl -sI https://$REGISTRY_HOST/` shows `strict-transport-security` and `cache-control: no-store`. `curl -sI https://$REGISTRY_HOST/usher.js` shows `max-age=300` and, on the second request, `x-cache: Hit from cloudfront`.
- [ ] `https://$REGISTRY_HOST/.well-known/usher-keys.json` lists one key whose `kid` matches your signing key. `https://$SITE_HOST/.well-known/usher-site.json` holds the demo site's key, not Usher's.
- [ ] `/privacy`, `/robots.txt` and `/.well-known/security.txt` load and name your contact.
- [ ] **Knock from an MCP client:** add the README's MCP entry with `USHER_REGISTRY_URL=https://$REGISTRY_HOST`, then call `knock` with `{"url":"https://$SITE_HOST/quote/driver"}`. You get a token and a map.
- [ ] **Try it:** the front page offers eleven forms to pick (Brightwater Health first), and no address box. Picking one shows its map (from the cache after the first refresh). A POST with `url=` and no dashboard sign-in is refused. Signed in, an address on your own origin maps, and another site's is refused.
- [ ] **Dashboard sign-in:** sign in at `/dashboard` with `https://$SITE_HOST` and its secret key. The sign-in cookie is `Secure`.
- [ ] **Agent run against the demo site:** this uses recorded model responses (add `--live` for the models) and switches the demo to layout B and back.

  ```sh
  npm run e2e:remote -- --registry https://$REGISTRY_HOST --site https://$SITE_HOST --secret uss_… --admin-key …
  ```
- [ ] **Refused agent:** an unknocked `POST https://$SITE_HOST/api/quote` returns 403 `knock_required` and appears under blocked attempts on the dashboard.
- [ ] **Interest form:** send the front page's form, then find it at `/admin` after signing in with the admin key.
- [ ] **Status:** `/status` with the admin key shows this build's SHA, `postgres`, today's spend against the cap, and the keeper's last run (after its first pass).

## Operations

**`/status`** answers to the admin key: sign in at `/admin`, or send `Authorization: Bearer <admin key>`. It reports:
- the version (the image's git SHA);
- uptime and the store;
- model spend today against the daily cap;
- the keeper's last run (when, how many forms, each outcome, cost, and the map viewer's picker refresh);
- agent sessions and blocked attempts in the last 24 hours.

It answers JSON for monitors (`Accept: application/json`) and a page for people:

```bash
curl -s -H "Authorization: Bearer $USHER_ADMIN_KEY" -H 'Accept: application/json' https://$REGISTRY_HOST/status
```

**Daily model spend:** the registry writes one JSON line to its logs at start (today so far) and when each UTC day ends (`"final": true`). In CloudWatch Logs Insights:

```
fields @timestamp, day, spent_usd, cap_usd, final | filter event = "daily_model_spend" | sort @timestamp desc
```

The cap covers every model call: map viewer compiles, the picker refresh (which also loads nothing once the day's budget is spent), the keeper, rules and explanations.

## Backups

- **Automated:** RDS takes a daily snapshot, kept for the retention period you set (7 days), with point-in-time restore inside that window.
- **On demand, one command each:**

  ```sh
  scripts/db-backup.sh dump                          # backups/usher-<UTC time>.dump (gitignored)
  scripts/db-backup.sh restore backups/usher-….dump  # asks you to type the database name first
  ```

  The database is never public. The script reads `DATABASE_URL` from Secrets Manager and tunnels through the running registry task with ECS Exec port forwarding. It runs `pg_dump --format=custom` or `pg_restore --clean --single-transaction` from the `postgres:16` image in Docker. It needs ECS Exec on the registry service, the task role above, and the Session Manager plugin.

## Configuration (registry)

| Variable | Production | Meaning |
| --- | --- | --- |
| `NODE_ENV` | `production` | Refuses to start without the settings marked "required", or with `USHER_ALLOW_PRIVATE` or the development keys set. |
| `REGISTRY_PUBLIC_URL` | required, https | The URL agents and sites use. It is the token issuer, so it must not change once sites trust it. Cookies are `Secure` and HSTS is sent when it is https. |
| `DATABASE_URL` | required | Postgres. Migrations run on start (and by the migrate task). |
| `USHER_SIGNING_KEY` | required | The token signing key (`npm run keygen`). |
| `USHER_RETIRED_KEYS` | no | JSON array of earlier public JWKs to keep publishing after a rotation, for at least 10 minutes. |
| `USHER_DAILY_MODEL_BUDGET_USD` | required | Hard daily cap on model spend across all models. Once reached, compiles and rules stop until midnight UTC; cached maps keep working. |
| `USHER_ADMIN_KEY` | required, 32+ characters | Signs in to `/admin`. |
| `USHER_CONTACT_EMAIL` | required | Named on `/privacy` and in `/.well-known/security.txt`. |
| `TRUSTED_PROXY_HOPS` | 2 by default | Proxies in front whose forwarded headers are trusted: CloudFront and the ALB. The client is the `X-Forwarded-For` entry this many from the right. The scheme is `CloudFront-Forwarded-Proto`, else `X-Forwarded-Proto`. Use 1 for an ALB alone; 0 trusts nothing forwarded (the default outside production). |
| `MODEL_API_KEY` | for compiles, rules, explanations | Meta Model API key (Muse Spark). |
| `BASETEN_API_KEY` | for the classifier | Baseten key (Muse Spark Open). `USHER_OPEN_MODEL` overrides the model id. |
| `USHER_HOSTED_MCP` | on | Hosted MCP at `/mcp` (docs/hosted-mcp.md): `usher_fill` for assistants, on joined sites only, in the registry's Chromium. `off` turns it off. |
| `USHER_KEEPER_ORIGINS` | the demo site's URL | The only origins the keeper opens, comma-separated (none if unset). It loads pages in a browser, which can be redirected anywhere, so it visits only sites we control. |
| `USHER_ACCEPT_MAPS` | on | Maps agents submit are stored private to their agent, and served to every agent once a second agent or the keeper verifies them (docs/security.md). `0` refuses submissions. |
| `USHER_SEED`, `USHER_SEED_ORIGIN` | `mock-site`, the demo site's URL | Seeds the demo site's maps on start. In production this never registers or claims the site. |
| `USHER_VIEWER` | refused as `open` | Unset: visitors pick from a fixed list of public forms, and signed-in owners map pages on their own origin. `open` lets anyone map any address: local demos only. |
| `USHER_ALLOW_PRIVATE` | refused | `1` lets the viewer and claim checks reach private addresses: local demos only. |
| `PORT`, `HOST` | 4200, 0.0.0.0 | Where it listens. |

## Configuration (the demo site)

| Variable | Meaning |
| --- | --- |
| `USHER_REGISTRY_URL` | The registry's public URL. |
| `USHER_SITE_ORIGIN` | The site's public origin. Behind CloudFront the Host header alone doesn't say https. It also makes the site's cookie `Secure`. |
| `USHER_SITE_KEY` | The site key from `/sites/new`. It goes in the tag and the claim file. |
| `USHER_ADMIN_KEY` | Required to switch the form layout at `/__admin` (the drift demo). |
| `PORT` | 4100. |

## Locked down for now

Everything an outsider could steer, closed for launch, to reopen one at a time:

| What | State | Why it is closed | To reopen |
| --- | --- | --- | --- |
| Map viewer (`/viewer`, "Try it") | A fixed list of eleven forms (the demo site's two journeys and nine public ones); owners map their own origin; `open` refused | An open address box let anyone probe other sites from our servers, and a redirect or the page's own requests reached a private address in a test | Done: see docs/security.md, "The map viewer". Every browser request is now checked against the address it resolves to |
| Keeper | Only `USHER_KEEPER_ORIGINS` (the demo site) | Same browser, and it visits any registered site, claimed or not | The same egress proxy; then claimed sites only |
| Agents' shared maps (`POST /maps`) | Accepted, private to their agent until verified by a second agent or the keeper; 20 an hour per identity | An agent's keys and locators are its word, so a hostile agent could mislabel a form | Done: the verification ladder (docs/security.md) |

Still open and accepted:
- **Knocks** create a session row for any site, at up to 120 a minute per address. Sessions are deleted after 90 days.
- **Drift reports** need the site key, which is public, so anyone can flag a form as drifted. That adds a flag and a log line; agents still get maps by their live form.

A CloudFront or WAF rate-based rule (for example, 2,000 requests per 5 minutes per IP) caps both cheaply.

## Hardening in place

- **Production refuses to start** without its settings (above).
- **Outbound requests to addresses outsiders choose** (a site's claim file, an agent's key directory, robots.txt) go only to public internet addresses, checked on the address actually connected to. They never follow redirects, and responses are capped at 1 MB.
- **Rate limits per client address:**
  - Per minute: knocks 120, drift reports 60, session events 1,200, other writes 300, reads 600.
  - Per hour: registering sites and claim checks 20, the interest form 5, sign-ins 30.
  - Per site key on drift and blocked reports.
  - Memory for these limits is bounded, and addresses are never stored.
- **A hard daily cap** on model spend.
- **Body limits:** JSON bodies up to 256 KB; form bodies up to 20 KB.
- **No private addresses:** claim checks refuse private and loopback addresses, and every request the map viewer's browser makes is checked against the address it resolves to.
- **CORS** only on the endpoints the site script calls.
- **Headers:**
  - HTML pages send a strict Content Security Policy and `X-Frame-Options: DENY`.
  - Every response sends `nosniff`, `Referrer-Policy` and, unless its route caches, `Cache-Control: no-store`. HSTS is sent over https.
- **Keys and cookies:**
  - Secret keys are stored as SHA-256 hashes.
  - The only cookies are the dashboard and admin sign-ins: signed, HttpOnly, SameSite and Secure. They are strictly necessary, so there is no cookie banner.
- **Containers** run as an unprivileged user.

## Estimated monthly cost

Fargate on-demand, Linux/x86, London, one task each, all month. These are rough figures; check them in the AWS pricing calculator.

| Service | Size | ≈ $/month |
| --- | --- | --- |
| Registry | 1 vCPU, 2 GB | 41 |
| Mock site | 0.25 vCPU, 0.5 GB | 10 |
| **Both services** | | **≈ 52** |

Not included:
- RDS `db.t4g.micro`: about $16 a month.
- The ALB, CloudFront, NAT, secrets and logs, which you run.
- Model spend, capped at `DAILY_MODEL_BUDGET_USD` a day.

Running on Graviton (ARM64) would cut the Fargate figure by about 20%. It needs the images built for `linux/arm64` and `cpuArchitecture: ARM64` in the task definitions.

## Locally

```sh
docker compose up --build -d      # Postgres, the registry and the demo site, development settings
npm run e2e:remote                # 12 checks against the stack, recorded model responses
docker compose down -v            # stop and delete the local database
```

The addresses and development keys are in `docker-compose.yml`, for local use only.
