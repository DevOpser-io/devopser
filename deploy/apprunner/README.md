# Single-tenant deploy to AWS App Runner

One CloudFormation stack that stands up this app on AWS App Runner with its
own VPC, RDS PostgreSQL, ElastiCache Redis, interface VPC endpoints for the
AWS APIs the app calls, and the template's `NODE_ENV=production` Secrets
Manager pattern for DB creds and the session secret. Mirrors the structure
of the Elastic Beanstalk reference in [`../eb/`](../eb/README.md) and the
App Runner module in the DevOpser `slo-coach` repo, minus that app's
Dash0-specific pieces.

## Prerequisites

- `aws` CLI v2 with a working profile (SSO is fine; the script defaults to
  `AWS_PROFILE=DevRel`, so run `aws sso login --profile DevRel` first)
- Docker daemon running (Docker Desktop on macOS)
- `curl`
- Bedrock model access granted in the deploy region for the model behind
  `BEDROCK_MODEL_ID` (Bedrock console, Model access)

## First deploy

```bash
# from the repo root
SES_FROM_EMAIL=you@example.com ./deploy/apprunner/deploy.sh
```

Takes about 25 minutes on a cold run (RDS provisioning is the long pole).
The script is idempotent and finishes only after `https://<domain>/health`
returns 200. It prints the `*.awsapprunner.com` URL in the success banner.

Sign-in is by emailed link only (there is no password form), so pass a
sender on the first deploy or nobody can log in. See "Transactional email".

### Env overrides (deploy script defaults, nothing is hardcoded in the template)

| Var | Default | Purpose |
|---|---|---|
| `APP_NAME` | `slo-demo` | Stack basename, ECR repo, Secrets Manager prefix, service name |
| `AWS_REGION` | `eu-west-1` | Must match Bedrock model access |
| `AWS_PROFILE` | `DevRel` | AWS CLI profile (SSO) |
| `STACK_NAME` | `${APP_NAME}-stack` | CloudFormation stack name |
| `BEDROCK_MODEL_ID` | `eu.anthropic.claude-sonnet-4-6` | Cross-region EU inference profile. The app's code default is a `us.` profile that does not work in eu-west-1 |
| `SES_FROM_EMAIL` | `""` (email disabled) | Transactional-email sender. Only passed to CFN when non-empty, so re-runs without it keep the previous value |
| `SITE_BASE_URL` | `https://<App Runner domain>` | Canonical public origin baked into emailed sign-in links and the Google OAuth callback. Override once a custom domain fronts the service |
| `EXTERNAL_EGRESS` | `false` | `true` adds a NAT gateway so the container can reach non-AWS hosts (see "Networking") |
| `DEMO_FAULT_ERROR_RATE` | `0` | SLO demo only. Share (0 to 1) of non-health requests the app answers with 500 (`backend/middleware/demoFault.js`). Deploy with it set to stage an incident, re-run without it to stage the fix |
| `DEMO_FAULT_LATENCY_RATE` / `DEMO_FAULT_LATENCY_MS` | `0` / `900` | SLO demo only. Share of non-health requests delayed, and by how much |
| `DEVOPSER_APN_PRODUCT_CODE` | same as `deploy/eb` | AWS Partner attribution tag `aws-apn-id=pc:<code>` on the stack |

### CloudFormation parameters (all supplied by `deploy.sh`)

| Parameter | Default | Purpose |
|---|---|---|
| `AppName` | `slo-demo` | Basename and Secrets Manager prefix (`${AppName}/...`) |
| `BedrockModelId` | required | Model or inference-profile ID; no template default so the template stays region-agnostic |
| `CreateService` | `false` | Phase gate: the App Runner service is only created after an image exists in ECR |
| `ImageTag` | `latest` | ECR tag to run; the script passes a unique `v-<timestamp>-<sha>` per deploy |
| `CustomDomainParam` | `""` | CORS allowlist hostname(s); patched in by phase 3 |
| `SiteBaseUrlParam` | `""` | Delivered as `SITE_BASE_URL`; patched in by phase 3 |
| `SesFromEmail` | `""` | SES VPC endpoint, scoped send permission and `USE_SES=true` when set |
| `ExternalEgress` | `false` | NAT gateway, public subnet and internet gateway when `true` |
| `DemoFaultErrorRate` / `DemoFaultLatencyRate` / `DemoFaultLatencyMs` | `0` / `0` / `900` | Delivered as `DEMO_FAULT_*`; inert at the defaults |

## How the three phases work

1. **Infra.** VPC (2 AZs, private-only subnets), RDS, Redis, ECR, Secrets
   Manager entries, IAM roles, VPC connector, interface endpoints. No
   service yet: App Runner can't be created before its image exists.
2. **Image and service.** Builds the repo-root `Dockerfile`, wraps it with
   `Dockerfile.apprunner`, pushes to ECR, then re-deploys the stack with
   `CreateService=true` and the fresh `ImageTag`. CloudFormation blocks
   until the service reaches `RUNNING`.
3. **CORS and origin patch.** Reads the service's default domain from the
   stack outputs and re-deploys with `CustomDomainParam=<domain>` and
   `SiteBaseUrlParam=https://<domain>`. Required by `AGENTS.md`, "CORS for
   deployed environments": `backend/server.js` is default-deny CORS, and
   without this the first browser call to `/api/preview/generate` returns
   a 500 that looks like a broken LLM. `SITE_BASE_URL` is the origin the
   app writes into sign-in emails and the OAuth callback; until it is set,
   magic-link requests answer 500 in production. The domain only exists
   after the service does, so a same-template self-reference is
   impossible, hence the extra pass. CloudFormation blocks until the
   env-var rollout finishes, then the script curls `/health` and only
   prints success on a 200.

Re-runs skip phase 3 when the parameters already match, and phase 1 never
touches the running service (omitted parameters keep their previous values).

## Transactional email (SES)

Set `SES_FROM_EMAIL=<sender>` on a deploy. The script creates the SES
email identity with the CLI if it does not exist yet (outside the stack,
so an address already verified for another stack never conflicts). SES
emails a verification link to that address on first create. Click it
before expecting delivery. The stack then provisions the SES API
interface VPC endpoint (the service has VPC-only egress, so without the
endpoint SES calls hang), scoped `ses:SendEmail`/`ses:SendRawEmail` on
the instance role, and `USE_SES=true` plus `SES_FROM_EMAIL` on the
service.

Sandbox caveat: a fresh account can only send TO verified addresses until
AWS grants production access. The DevRel account already has it.

## Subsequent deploys

Re-running `deploy.sh` builds a fresh image with a new tag and rolls the
service onto it (App Runner does a rolling replace, no downtime). No secret
material passes through the script or CloudFormation parameters: the
Express session secret is generated in-stack (`${APP_NAME}/app/session-secret`)
and delivered via App Runner `RuntimeEnvironmentSecrets` (stack updates
don't regenerate it, so logins survive re-deploys). The RDS master password
is generated inside Secrets Manager (`GenerateSecretString`) and consumed
by RDS via a dynamic reference. It is the same `${APP_NAME}/db/password`
secret the app resolves through `DB_PASSWORD_SECRET_NAME`.

## Migrations

`Dockerfile.apprunner` wraps the repo-root image because the root image
can't be used as-is: `backend/migrate.sh` shells out to the `aws` CLI (not
installed in the base image) to fetch the five `${APP_NAME}/db/*` secrets,
and the base `CMD` boots the server without migrating. The wrapper installs
`awscli` and `curl` and swaps in `entrypoint.sh`, which runs
`backend/migrate.sh` and then `exec node server.js`. Migrations run on every
instance start (safe, sequelize tracks applied migrations in
`SequelizeMeta`). The health check (`/health`, 20s interval, unhealthy
threshold 20) gives cold starts time to migrate before App Runner gives up.

## Image platform

Images are built with `--platform linux/amd64`. App Runner only runs x86_64
containers, so on an arm64 Mac the build cross-compiles under emulation
(slower build, correct runtime).

## Networking

The service uses `EgressType: VPC` through a VPC connector so it can reach
RDS and Redis in private subnets. Every AWS API the app calls at runtime is
reached via an interface VPC endpoint: Secrets Manager, STS (the Bedrock
client calls `GetCallerIdentity` on first use; without the endpoint the
first chat hangs until the SDK times out), `bedrock-runtime`, and SES when
email is enabled. There is no NAT gateway by default, so the container has
no route to the public internet.

Set `EXTERNAL_EGRESS=true` when the app needs a non-AWS host: Google OAuth
or the OpenAI/Anthropic
providers. That adds a public subnet, internet gateway and a single-AZ NAT
gateway (about $35/month). AWS-API traffic keeps using the endpoints.

## Rough monthly cost (eu-west-1, demo sizes, mostly idle)

| Item | ~$/mo |
|---|---|
| App Runner 0.25 vCPU / 0.5 GB, min 1 instance | 3 to 10 |
| RDS `db.t4g.micro` single-AZ + 20 GB gp3 | 16 |
| ElastiCache `cache.t4g.micro`, 1 node | 12 |
| 3 interface VPC endpoints x 2 AZs (4 with SES) | 48 to 64 |
| Secrets Manager (6 secrets) + ECR storage | 3 |
| **Total** | **~85 to 105** |

Add about $35 for the NAT gateway when `EXTERNAL_EGRESS=true`.

## Destroy

```bash
./deploy/apprunner/delete.sh --yes-delete-everything
```

Running it without the flag prints the data-loss warning and exits. It
deletes the stack (RDS keeps a final snapshot via `DeletionPolicy:
Snapshot`; ECR has `EmptyOnDelete: true` so images don't block teardown),
then purges the `${APP_NAME}/` secrets without the 30-day recovery window.
Otherwise a re-deploy under the same name fails with "secret is scheduled
for deletion". The retained RDS snapshot still costs storage; delete it
manually when you're sure. The SES sender identity is left in place.

## Troubleshooting

### "aws sts get-caller-identity failed"

SSO session expired: `aws sso login --profile DevRel` and re-run.

### Service stuck rolling back or health check fails

Tail the application logs (the deploy script prints the exact command):

```bash
aws logs tail "/aws/apprunner/slo-demo/<service-id>/application" --region eu-west-1 --follow
```

Common causes:
- `CONFIG: ALLOW_LOCAL_PRODUCTION_OVERRIDE=true, downgrading NODE_ENV to development`
  means that override is set on the service; it must never be.
- `access denied to secret slo-demo/db/*` means the instance-role policy
  scope doesn't match the secret name prefix.
- Secret fetch hangs or times out: the Secrets Manager interface endpoint
  is missing or its security group doesn't allow 443 from the connector SG.
- RDS connection refused: `SgDb` isn't permitting 5432 from `SgConnector`.

### Chat returns 500 but the page loads

Two distinct causes, in order of likelihood:
1. `CORS blocked origin` in the logs: phase 3 didn't run. Re-run
   `deploy.sh` (it converges) or check the `CUSTOM_DOMAIN` env var on the
   service.
2. Bedrock access: model access not granted in eu-west-1 for the
   `BEDROCK_MODEL_ID` inference profile, or the instance role is missing
   `bedrock:InvokeModel*` on both the inference-profile and (region-wide)
   foundation-model ARNs.

### Sign-in email never arrives

The SES identity is not verified yet (click the link SES sent to the
sender address), or `SES_FROM_EMAIL` was never passed so `USE_SES=false`
and the app falls back to SMTP secrets that don't exist. Check:

```bash
aws sesv2 get-email-identity --region eu-west-1 --email-identity <sender> --query VerifiedForSendingStatus
```

## Not covered

- Custom domain + ACM. Associate one with
  `aws apprunner associate-custom-domain`, then append the hostname to
  `CUSTOM_DOMAIN` in addition to the default domain, not instead of, and
  re-run `deploy.sh` with `SITE_BASE_URL=https://<custom hostname>`.
- `triggerDeployment()`. Single-tenant doesn't need the multi-tenant
  publish flow; see the `devopser-deploy` skill's `cross-account.md` when
  that changes.
