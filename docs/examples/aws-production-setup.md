---
id: example-aws-prod
title: AWS Production Setup
created_at: "2026-04-04T10:00:00Z"
updated_at: "2026-04-04T10:00:00Z"
pinned: false
archived: false
tags:
  - aws
  - production
  - devops
folder: credentials
encrypted: false
---

# AWS Production Setup

Production environment for the main application. All services are in **ap-southeast-2 (Sydney)**.

## Access Credentials

:::secret[AWS Root Account]
Access Key ID: AKIA4EXAMPLE7XBZHQ2K
Secret Access Key: wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY
Account ID: 123456789012
Region: ap-southeast-2
Console URL: https://123456789012.signin.aws.amazon.com/console
:::

## Database

PostgreSQL on RDS — `db.r6g.large`, Multi-AZ enabled, daily snapshots retained for 14 days.

```
Host: prod-db.c7example.ap-southeast-2.rds.amazonaws.com
Port: 5432
Database: appdb_production
```

:::secret[Production Database]
username: app_admin
password: Kx9$mP2vL8nQ4wR7jT1yB6hD3fA0sE5u
host: prod-db.c7example.ap-southeast-2.rds.amazonaws.com
port: 5432
database: appdb_production
connection_string: postgresql://app_admin:Kx9$mP2vL8nQ4wR7jT1yB6hD3fA0sE5u@prod-db.c7example.ap-southeast-2.rds.amazonaws.com:5432/appdb_production
:::

## Redis Cache

ElastiCache cluster — 2 nodes, `cache.r6g.large`, encryption at rest enabled.

:::secret[Redis Production]
host: prod-cache.example.0001.apse2.cache.amazonaws.com
port: 6379
password: rEdIs_PrOd_2026_sEcUrE_tOkEn_xYz
connection_string: rediss://:rEdIs_PrOd_2026_sEcUrE_tOkEn_xYz@prod-cache.example.0001.apse2.cache.amazonaws.com:6379
:::

## API Keys

:::secret[Stripe Production]
publishable_key: pk_test_51Example7890abcdefghijklmnopqrstuvwxyz
secret_key: sk_test_51Example0987654321zyxwvutsrqponmlkjihg
webhook_secret: whsec_ExAmPlE1234567890abcdefghijklmnop
:::

:::secret[SendGrid SMTP]
username: apikey
password: SG.ExAmPlEkEy.abcdefghijklmnopqrstuvwxyz1234567890ABCD
smtp_host: smtp.sendgrid.net
smtp_port: 587
from_email: noreply@example.com
:::

:::secret[Cloudflare API]
email: admin@example.com
api_key: c2547eb745079dac9320b638f5e225cf483cc
zone_id: 023e105f4ecef8ad9ca31a8372d0c353
account_id: 372e67954025e0ba6aaa6d586b9e0b59
:::

## SSH Access

:::secret[Production Server SSH]
hostname: prod-app-01.example.com
port: 22
username: deploy
private_key: -----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAACmFlczI1Ni1jdHIA
EXAMPLE_KEY_DATA_TRUNCATED_FOR_DEMO
-----END OPENSSH PRIVATE KEY-----
:::

## Deployment

Deployed via GitHub Actions. On push to `main`:

1. Build Docker image → push to ECR
2. Update ECS task definition
3. Rolling deployment (2 min health check grace)

**Rollback:** Set the ECS service to the previous task definition revision:
```bash
aws ecs update-service --cluster prod --service app --task-definition app:PREVIOUS_REVISION
```

## Monitoring

- **Dashboard:** https://grafana.example.com/d/prod-overview
- **Alerts:** PagerDuty escalation policy "Production App"
- **Logs:** CloudWatch log group `/ecs/prod-app`

## Notes

- Database credentials rotate every 90 days (next rotation: 2026-07-01)
- SSL certificates auto-renew via ACM
- Backup verification tested monthly — last test: 2026-03-15 ✓
