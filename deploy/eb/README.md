# Single-tenant deploy to AWS Elastic Beanstalk

One CloudFormation stack that stands up the DevOpser template on EB with its
own VPC, RDS PostgreSQL, ElastiCache Redis, and the template's
`NODE_ENV=production` Secrets Manager pattern for DB creds.

## First deploy

```bash
# from the repo root
./deploy/eb/deploy.sh
```

Takes ~20 minutes on a cold run (RDS provision is the long pole).
At the end the script prints the `*.elasticbeanstalk.com` URL.

### Env overrides

| Var | Default | Purpose |
|---|---|---|
| `APP_NAME` | `devopser-demo` | Stack, ECR repo, SM prefix, EB app name |
| `AWS_REGION` | `us-east-1` | Must match Bedrock region |
| `STACK_NAME` | `${APP_NAME}-stack` | CloudFormation stack name |
| `DEVOPSER_APN_PRODUCT_CODE` | `6ydf4kme1p7fqu1vp1wy1uxoc` | AWS Partner attribution code (see below) |

### Attribution tag

Every resource the stack creates carries `aws-apn-id=pc:<DEVOPSER_APN_PRODUCT_CODE>`
(AWS Partner Revenue Measurement). It lets AWS attribute the usage of this free
template to the DevOpser Marketplace listing; it adds nothing to your bill and
grants DevOpser no access to your account. Change the value only if AWS gives
you a different code.

## Subsequent deploys

Re-running `deploy.sh` builds a fresh image with a new `VersionLabel`
(timestamp + git SHA), pushes it to ECR, uploads a new bundle, and points
the EB env at it. EB performs a rolling replace — brief downtime because
the environment is `SingleInstance` (no ALB).

The generated DB password + session secret are cached in
`deploy/eb/.params.local` (git-ignored) so re-runs don't rotate them.

## Destroy

```bash
aws cloudformation delete-stack --stack-name devopser-demo-stack
```

RDS has `DeletionPolicy: Snapshot` — a final snapshot is kept.
ECR has `EmptyOnDelete: true` so images don't block teardown.
The bundle bucket is **not** deleted by CFN — drain and delete manually:

```bash
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
BUCKET="devopser-demo-eb-bundles-${ACCOUNT_ID}-us-east-1"
aws s3 rm "s3://${BUCKET}" --recursive
aws s3api delete-bucket --bucket "${BUCKET}"
```

## Architecture

See `../../../.claude/plans/sleepy-dreaming-backus.md` for the full plan,
including the monthly cost breakdown, the `KUBERNETES_SERVICE_HOST`
workaround, and the NAT-vs-VPC-endpoints decision.

## Troubleshooting

### "security token invalid" during deploy

MFA session expired. Re-run:

```bash
eval "$(aws configure export-credentials --format env)"
./deploy/eb/deploy.sh
```

### EB environment in `Severe` health after deploy

Tail container logs:

```bash
aws logs tail "/aws/elasticbeanstalk/devopser-demo-env/var/log/eb-docker/containers/eb-current-app/stdouterr.log" --follow
```

Common causes:
- `DATABASE CONFIG: Detected local environment, forcing development mode`
  → `KUBERNETES_SERVICE_HOST=1` option is missing from `aws:elasticbeanstalk:application:environment`.
- `access denied to secret devopser-demo/db/*`
  → Instance profile policy scope doesn't match the secret name prefix.
- RDS connection refused → RDS security group isn't permitting the EB SG.

### Chat returns 500 but login works

Bedrock model access not granted in the deploy region, or the
instance profile is missing `bedrock:InvokeModel`. Verify:

```bash
aws bedrock list-foundation-models --region us-east-1 \
  | grep anthropic.claude-sonnet-4-5
```

## Not covered

- Custom domain + ACM cert — extend `cloudformation.yaml` with an
  `AWS::CertificateManager::Certificate` and an `aws:elbv2:listener` block
  when ready to move off the EB default URL.
- SES — flip `USE_SES=true` in the env option settings after you have a
  verified sender identity in us-east-1.
- `triggerDeployment()` — single-tenant doesn't need the
  multi-tenant publish flow; see the `devopser-deploy` skill's
  `cross-account.md` when that changes.
