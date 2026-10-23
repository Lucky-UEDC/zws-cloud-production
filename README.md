# ZWS Cloud — PRODUCTION (https://zwscloud.in)

> This repository deploys to the live production VPS. Never run experiments, test builds, or throwaway migrations against it. Development lives in `zws-cloud-panel` (`dev.zwscloud.com`) and must stay completely separated.

# UltraEdge Datacenter Platform

![Version](https://img.shields.io/badge/version-1.1.0-blue)
![Node.js](https://img.shields.io/badge/Node.js-22+-green)
![Next.js](https://img.shields.io/badge/Next.js-15-black)
![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue)
![Prisma](https://img.shields.io/badge/Prisma-6.19-2D3748)
![Docker](https://img.shields.io/badge/Docker-Compose-2496ED)
![License](https://img.shields.io/badge/License-MIT-yellow)

> **Enterprise-grade cloud infrastructure platform** for deploying, managing, and scaling high-performance compute instances with NVMe storage, dedicated resources, and predictable pricing.

---

## 🏗️ Architecture Overview

```mermaid
graph TB
    subgraph "Edge"
        CF[Cloudflare CDN/WAF]
        CT[Cloudflare Tunnel]
    end
    
    subgraph "App VPS (103.216.171.253)"
        NG[Nginx Reverse Proxy :80/443]
        APP[Next.js App :13000]
        WRK[Worker/VNC Proxy :13001]
        SCH[Scheduler :13101]
        RD[Redis :6379]
    end
    
    subgraph "DB VPS (External)"
        PG[(PostgreSQL 14 :5432)]
        CT2[Cloudflared Tunnel]
    end
    
    CF -->|SSL Termination| NG
    NG -->|Proxy| APP
    NG -->|Proxy| WRK
    APP --> RD
    WRK --> RD
    SCH --> RD
    APP -.->|Cloudflare Tunnel| PG
    CT2 -.->|Tunnel| PG
```

### Infrastructure Stack

| Layer | Technology | Version | Purpose |
|-------|------------|---------|---------|
| **Runtime** | Node.js | 22+ | Application runtime |
| **Framework** | Next.js | 15 (App Router) | Full-stack React framework |
| **Language** | TypeScript | 5.7 | Type-safe development |
| **Database** | PostgreSQL | 14 | Primary data store |
| **ORM** | Prisma | 6.19 | Type-safe database access |
| **Cache/Queue** | Redis | 7 | Sessions, queues, caching |
| **Reverse Proxy** | Nginx | 1.18 | SSL termination, rate limiting |
| **Tunneling** | Cloudflare Tunnel | - | Secure DB connectivity |
| **Containerization** | Docker Compose | - | Multi-service orchestration |
| **SSL** | Let's Encrypt | - | Auto-renewing certificates |
| **Process Manager** | Docker | - | Container health management |

---

## ✨ Feature Matrix

### 🔐 Authentication & Security
| Feature | Status | Description |
|---------|--------|-------------|
| Email/Password Auth | ✅ **Enabled** | bcrypt + JWT tokens, secure cookies |
| WhatsApp OTP (Evolution API) | ✅ **Enabled** | Production-ready, verified delivery |
| Two-Factor (TOTP) | ✅ **Enabled** | Authenticator apps (Google Auth, Authy) |
| Trusted Devices | ✅ **Enabled** | 30-day MFA skip per device |
| Recovery Codes | ✅ **Enabled** | One-time use backup codes |
| Session Management | ✅ **Enabled** | Secure HTTP-only cookies, rotation |
| Rate Limiting | ✅ **Enabled** | Per-endpoint (auth: 3/s, api: 10/s) |
| CSP/Security Headers | ✅ **Enabled** | Strict CSP, HSTS, X-Frame-Options |

### 👨‍💼 Admin Panel (`/admin`)
| Feature | Status | Description |
|---------|--------|-------------|
| Dashboard Analytics | ✅ **Enabled** | Real-time metrics, revenue, orders, users |
| Customer Management | ✅ **Enabled** | Full CRUD, impersonation, billing history |
| Product Catalog | ✅ **Enabled** | Fixed VPS, Dedicated, Custom configurations |
| Order Management | ✅ **Enabled** | Full lifecycle, provisioning queue |
| Invoice Generation | ✅ **Enabled** | PDF + HTML, auto-email, numbering |
| Payment Gateway Config | ✅ **Enabled** | Razorpay, PhonePe, Cashfree, Wallet |
| WhatsApp CRM | ✅ **Enabled** | Evolution API, conversations, campaigns |
| Analytics Overview | ✅ **Enabled** | Events, traffic sources, devices, geo |
| Domain/Gateway Manager | ✅ **Enabled** | Multi-domain, gateway routing |
| System Settings | ✅ **Enabled** | Appearance, SMTP, billing, integrations |
| Audit Logs | ✅ **Enabled** | Full admin action tracking |

### 👤 Client Area (`/client-area`)
| Feature | Status | Description |
|---------|--------|-------------|
| Dashboard | ✅ **Enabled** | Services, billing, notifications |
| Compute Instances | ✅ **Enabled** | VPS management, power controls |
| VNC Console | ✅ **Enabled** | noVNC integration, full console access |
| Bandwidth Monitoring | ✅ **Enabled** | Real-time charts, historical data |
| Invoice/Payment History | ✅ **Enabled** | Full history, PDF download |
| Support Tickets | ✅ **Enabled** | Threaded, priority, SLA tracking |
| Profile & Security | ✅ **Enabled** | 2FA, billing address, API keys |
| Wallet System | ✅ **Enabled** | Credits, top-up, auto-pay |

### ☁️ Provisioning & Infrastructure
| Feature | Status | Description |
|---------|--------|-------------|
| Proxmox Integration | ✅ **Enabled** | API-based, multi-node support |
| VM Lifecycle | ✅ **Enabled** | Create, start, stop, restart, delete |
| OS Templates | ✅ **Enabled** | Ubuntu, Debian, AlmaLinux, Rocky, Windows |
| Network/IP Management | ✅ **Enabled** | IP pools, assignments, VLANs |
| Backup & Snapshots | ✅ **Enabled** | Scheduled, manual, retention policies |
| Custom Configurations | ✅ **Enabled** | CPU, RAM, Storage, Bandwidth per order |
| Dedicated Servers | ✅ **Enabled** | Bare metal provisioning workflow |

### 💳 Payments & Billing
| Feature | Status | Description |
|---------|--------|-------------|
| Razorpay | ⚠️ **Config Required** | Domain enabled, needs API keys |
| PhonePe | ✅ **Enabled** | Production, webhooks configured |
| Cashfree | ✅ **Enabled** | Production, webhooks configured |
| Wallet System | ✅ **Enabled** | Internal credits, auto-pay |
| Coupons/Discounts | ✅ **Enabled** | %, fixed, first-order, bulk |
| Billing Cycles | ✅ **Enabled** | 1, 3, 6, 12, 24, 36 months |
| Tax/GST | ✅ **Enabled** | Configurable rates, INR pricing |
| Refunds | ✅ **Enabled** | Full/partial, automated |

### 🌐 Marketing & Public Pages
| Feature | Status | Description |
|---------|--------|-------------|
| Homepage | ✅ **Enabled** | Hero, trust strip, pricing preview, features |
| Pricing Page | ✅ **Enabled** | Dynamic catalog, regional pricing |
| Checkout Flow | ✅ **Enabled** | Multi-step, OS selection, SSH keys |
| Blog/CMS | ✅ **Enabled** | Markdown editor, SEO, categories |
| Knowledge Base | ✅ **Enabled** | Categories, search, article versioning |
| Status Page | ✅ **Enabled** | Real-time, component status |
| Compare Pages | ✅ **Enabled** | vs AWS Lightsail, Azure, DigitalOcean |
| Location Pages | ✅ **Enabled** | Mumbai, Bangalore, Delhi NCR, India |

### 📊 Monitoring & Observability
| Feature | Status | Description |
|---------|--------|-------------|
| Health Endpoint | ✅ **Enabled** | `/api/health` - comprehensive checks |
| Structured Logging | ✅ **Enabled** | Pino-based, JSON, levels |
| Error Tracking | ✅ **Enabled** | Sentry-compatible, error boundaries |
| Self-Test Suite | ✅ **Enabled** | Docker profile, smoke tests |
| Analytics Events | ✅ **Enabled** | Page views, interactions, conversions |
| Real-time Metrics | ✅ **Enabled** | WebSocket, Server-Sent Events |

### 💾 Backup & Disaster Recovery
| Feature | Status | Description |
|---------|--------|-------------|
| App Backups | ✅ **Enabled** | Merge-only restore, no data loss |
| DB Backups (pgBackRest) | ✅ **Enabled** | Daily, weekly, monthly, PITR |
| Artifact Restore | ✅ **Enabled** | SQL.gz, .dump, schema validation |
| Backup Schedules | ✅ **Enabled** | Configurable cron, retention |
| Restore Validation | ✅ **Enabled** | Automated test restores |

---

## 📁 Project Structure

```
ultraedge-datacenter/
├── app/                              # Next.js App Router
│   ├── (emails)/                     # Email templates (transactional, marketing)
│   ├── (user)/                       # User-specific route group
│   ├── admin/                        # Admin panel (45+ routes)
│   │   ├── analytics/                # Analytics dashboard
│   │   ├── customers/                # Customer management
│   │   ├── payments/                 # Gateway config, transactions
│   │   ├── products/                 # Catalog management
│   │   ├── settings/                 # System configuration
│   │   ├── support/                  # Tickets, WhatsApp CRM
│   │   └── ...
│   ├── api/                          # API routes (37+ endpoints)
│   │   ├── auth/                     # Registration, login, 2FA, MFA
│   │   ├── checkout/                 # Payment processing
│   │   ├── payments/                 # Webhooks, status, webhooks
│   │   ├── admin/                    # Admin-only endpoints
│   │   ├── whatsapp/                 # Evolution API integration
│   │   └── ...
│   ├── checkout/                     # Multi-step checkout flow
│   ├── client-area/                  # Customer dashboard (15 routes)
│   ├── [marketing-pages]/            # 30+ public pages
│   │   ├── pricing/, features/, compare/, blog/, status/
│   │   ├── vps-hosting-*, dedicated-server-*, cloud-vps/
│   │   └── ...
│   ├── globals.css                   # Global styles, Tailwind v4
│   ├── layout.tsx                    # Root layout, theme injection
│   ├── page.tsx                      # Homepage
│   └── theme.css                     # CSS variables (Design System)
│
├── components/                       # React Components
│   ├── admin/                        # Admin-specific (20+)
│   ├── auth/                         # Auth forms, shells, OTP
│   ├── catalog/                      # Product cards, specs, pricing
│   ├── checkout/                     # Checkout steps, payment
│   ├── client/                       # Client area components
│   ├── effects/                      # Background animations (dot grid, glow)
│   ├── layout/                       # Navbar, Footer, Container, Sidebar
│   ├── marketing/                    # Hero, Features, Testimonials, CTA
│   ├── payments/                     # Payment modals, bridges
│   ├── ui/                           # 45+ Radix-based primitives
│   │   ├── button, card, badge, dialog, dropdown, select, etc.
│   │   ├── form, input, textarea, checkbox, radio
│   │   ├── table, tabs, tooltip, toast, sheet, drawer
│   │   └── ...
│   └── ...
│
├── lib/                              # Core Libraries
│   ├── payments/                     # Payment gateway logic
│   │   ├── payment-gateway-admin.ts  # Admin gateway management
│   │   ├── runtime-payment-resolver.ts # Runtime gateway resolution
│   │   ├── gateway-registry.ts       # Gateway definitions
│   │   └── domain-gateway-resolver.ts # Domain-specific config
│   ├── db.ts                         # Prisma client (singleton)
│   ├── settings.ts                   # Settings management
│   ├── runtime-config.ts             # Runtime configuration
│   ├── runtime-domain.ts             # Domain utilities
│   ├── runtime-site-url.ts           # URL generation
│   ├── auth-validation.ts            # Auth validation helpers
│   ├── checkout-bootstrap.ts         # Checkout initialization
│   ├── checkout-shared.ts            # Shared checkout logic
│   ├── currency-format.ts            # INR formatting
│   ├── product-features.ts           # Feature/spec generation
│   ├── public-products.ts            # Public product queries
│   ├── regional-pricing.ts           # Geo-based pricing
│   ├── schema-health.ts              # Database health checks
│   ├── platform-config.ts            # Platform configuration
│   ├── runtime-fallbacks.ts          # Fallback configurations
│   ├── seo/                          # Metadata, sitemap, robots
│   └── ...
│
├── prisma/
│   ├── schema.prisma                 # Database schema (150+ models)
│   └── migrations/                   # 15+ migration files
│
├── public/
│   ├── install.sh                    # One-line installer
│   └── install-source.sh             # Source-based installer
│
├── scripts/                          # 30+ Operational Scripts
│   ├── domain-migrate.ts             # Domain migration utility
│   ├── validate-migrations.ts        # Migration validation
│   ├── payment-reconcile-worker.ts   # Payment reconciliation
│   ├── provision-worker.ts           # VM provisioning
│   ├── node-telemetry-worker.ts      # Node metrics collection
│   ├── vm-telemetry-worker.ts        # VM metrics collection
│   ├── whatsapp-worker.ts            # WhatsApp message processing
│   ├── backup-health.ts              # Backup monitoring
│   ├── db-check.ts                   # Database integrity
│   ├── repair-production-state.ts    # State repair
│   └── ...
│
├── docker-compose.yml                # 6-service stack
├── Dockerfile                        # Multi-stage build (Node 22, Prisma, Chrome)
├── next.config.mjs                   # Next.js config (standalone, security headers)
├── package.json                      # Dependencies (pnpm 11.5, Node 22+)
├── pnpm-lock.yaml                    # Lockfile
├── tsconfig.json                     # TypeScript config (strict)
├── eslint.config.mjs                 # ESLint flat config
├── .gitignore                        # Comprehensive ignores
└── README.md                         # This file
```

---

## 🚀 Installation & Deployment

### Quick Start (Production)

```bash
# Fresh Ubuntu 22.04+ VPS
curl -fsSL https://zwscloud.com/install.sh | sudo bash

# Or with source installer
curl -fsSL https://zwscloud.com/install-source.sh | sudo bash
```

The installer:
1. Installs Docker, Docker Compose, Cloudflared, git, curl, OpenSSL
2. Clones repository to `/var/www/myrdphub`
3. Creates `.env` from `.env.example`
3. Generates origin SSL certs for Nginx container
4. Bootstraps PostgreSQL via Cloudflare Tunnel
5. Starts all services: `docker compose --profile db-tunnel up -d --build --remove-orphans`

### Docker Compose Services

```yaml
services:
  app:          # Next.js app (port 13000)
  worker:       # VNC/Console proxy (port 13001)
  scheduler:    # Background jobs (port 13101)
  redis:        # Redis 7 (cache, queues, sessions)
  migrate:      # Prisma migrations (one-shot)
  backup:       # Backup service (on-demand)
  self-test:    # Smoke tests (on-demand)
  db-tunnel:    # Cloudflare tunnel to external DB (profile)
  postgres:     # Local DB (profile: local-db)
```

### Environment Configuration

```bash
# Required
NODE_ENV=production
SITE_DOMAIN=zwscloud.com
APP_URL=https://zwscloud.com
NEXTAUTH_URL=https://zwscloud.com
NEXTAUTH_SECRET=<32-byte-base64>
DATABASE_URL=postgresql://user:pass@host:5432/db?schema=public
REDIS_URL=redis://redis:6379/0
ENCRYPTION_KEY=<32-byte-hex>

# Optional: Payment Gateways
RAZORPAY_KEY_ID=
RAZORPAY_KEY_SECRET=
RAZORPAY_WEBHOOK_SECRET=
PHONEPE_MERCHANT_ID=
PHONEPE_CLIENT_ID=
PHONEPE_CLIENT_SECRET=
CASHFREE_APP_ID=
CASHFREE_SECRET_KEY=

# Optional: WhatsApp (Evolution API)
EVOLUTION_API_URL=
EVOLUTION_INSTANCE=
EVOLUTION_API_KEY=
EVOLUTION_INSTANCE_TOKEN=

# Optional: Cloudflare Tunnel
CF_TUNNEL_TOKEN=
CLOUDFLARE_TUNNEL_ENABLED=false
```

### SSL Certificates

```bash
# Automatic via Let's Encrypt (certbot)
certbot certonly --standalone -d zwscloud.com -d www.zwscloud.com \
  --non-interactive --agree-tos --email admin@zwscloud.com

# Certs stored at /etc/letsencrypt/live/zwscloud.com/
# Auto-renewal via systemd timer
```

---

## ⚙️ Configuration

### Database Migrations
```bash
# Run migrations
docker compose run --rm migrate

# Or with pnpm (local dev)
pnpm db:migrate

# Validate migration state
pnpm db:validate:migrations
```

### Payment Gateway Setup
1. Navigate to `/admin/payments/gateways`
2. Configure each gateway:
   - **Razorpay**: Key ID, Key Secret, Webhook Secret, Merchant Name
   - **PhonePe**: Merchant ID, Client ID, Client Secret, Client Version
   - **Cashfree**: App ID, Secret Key, Webhook Secret
3. Enable gateway, set priority, test connection

### Domain Configuration
```bash
# Primary domain managed via admin panel or database
# Domain migration utility:
DOMAIN_MIGRATE_FROM="old.com,www.old.com" pnpm domain:migrate --checks
```

### WhatsApp (Evolution API)
1. Deploy Evolution API separately
2. Create instance, get API key
3. Configure webhook: `https://yourdomain.com/api/whatsapp/webhook`
4. Add credentials in admin: `/admin/settings` → WhatsApp

---

## 🛠️ Development

### Prerequisites
- Node.js 22+
- pnpm 11.5+
- Docker & Docker Compose
- PostgreSQL 14+ (or Cloudflare Tunnel)
- Redis 7+

### Commands
```bash
# Install dependencies
pnpm install

# Development server
pnpm dev

# Build (production)
pnpm build

# Type checking
pnpm typecheck

# Linting
pnpm lint

# Unit tests
pnpm test

# Production tests
pnpm test:production

# Database
pnpm db:push          # Push schema (dev)
pnpm db:migrate       # Run migrations
pnpm db:studio        # Prisma Studio
pnpm db:generate      # Generate Prisma Client

# Docker
docker compose build
docker compose up -d
docker compose logs -f app
docker compose run --rm migrate
docker compose run --rm backup backup
docker compose run --rm self-test

# Scripts
pnpm domain:migrate --checks
pnpm payment:reconcile:worker
pnpm provision:worker
```

### Code Quality
```bash
# Pre-commit checks (run before PR)
pnpm typecheck && pnpm lint && pnpm build
```

---

## 📚 API Documentation

### Base URL
```
https://zwscloud.com/api
```

### Authentication
| Method | Header | Description |
|--------|--------|-------------|
| Session | `Cookie` | HTTP-only, secure, same-site |
| Admin | `Cookie` | Admin session, role-based |

### Key Endpoints

#### Auth
```
POST   /api/auth/register          # Register new account
POST   /api/auth/login             # Email/password login
POST   /api/auth/logout            # Logout
POST   /api/auth/2fa               # 2FA verification
POST   /api/auth/phone/signup/start # WhatsApp OTP start
POST   /api/auth/phone/signup/verify # WhatsApp OTP verify
```

#### Payments
```
POST   /api/payments/create        # Create payment order
POST   /api/payments/webhook       # Gateway webhooks (razorpay/phonepe/cashfree)
GET    /api/payments/status        # Payment status
POST   /api/payments/verify        # Verify payment
```

#### Admin (requires admin role)
```
GET    /api/admin/payments/gateways     # List gateways
POST   /api/admin/payments/gateways     # Save gateway
GET    /api/admin/products              # List products
POST   /api/admin/products              # Create product
GET    /api/admin/customers             # List customers
GET    /api/admin/orders                # List orders
GET    /api/admin/analytics/overview    # Analytics data
```

#### Client Area
```
GET    /api/client/services           # User's services
GET    /api/client/invoices           # User's invoices
POST   /api/client/services/:id/power # Power control
GET    /api/client/services/:id/vnc   # VNC connection
```

### Rate Limits
| Endpoint | Limit |
|----------|-------|
| Auth (login, register, 2FA) | 3 req/s |
| API routes | 10 req/s |
| Payment webhooks | 40 req/s burst |
| VNC/Console proxy | 40 req/s burst |

---

## 🏥 Health & Monitoring

### Health Endpoint
```bash
curl https://zwscloud.com/api/health
```

Returns comprehensive checks:
- Database connectivity
- Redis connectivity
- Prisma schema health
- Payment gateway runtime
- WhatsApp connection
- Queue health
- Telemetry freshness
- DNS/SSL status
- Backup status

### Container Health Checks
```bash
# All containers have health checks
docker compose ps

# Expected: all "healthy" or "running"
```

### Logs
```bash
# Application logs
docker compose logs -f app
docker compose logs -f worker
docker compose logs -f scheduler

# Nginx logs
tail -f /var/log/nginx/access.log
tail -f /var/log/nginx/error.log

# Systemd journal
journalctl -u nginx -f
```

---

## 🔒 Security

### Headers (via Nginx + Next.js)
```
X-Frame-Options: DENY
X-Content-Type-Options: nosniff
Referrer-Policy: strict-origin-when-cross-origin
Permissions-Policy: geolocation=(), microphone=(), camera=()
Strict-Transport-Security: max-age=31536000; includeSubDomains; preload
Content-Security-Policy: [strict policy]
```

### Encryption
- **Secrets**: AES-256-GCM (ENCRYPTION_KEY)
- **Passwords**: bcrypt (cost 12)
- **JWT**: HS256 (NEXTAUTH_SECRET)
- **Database**: TLS via Cloudflare Tunnel

### Secrets Management
- Never commit `.env` files (in `.gitignore`)
- Encrypted credentials in database (AES-256-GCM)
- Runtime decryption only when needed
- Masked in admin UI (`••••••••`)

---

## 📦 Backup & Restore

### Create Backup
```bash
# App backup (database + uploads + config)
docker compose run --rm backup backup

# Or specific scope
docker compose run --rm backup backup --scope=database
docker compose run --rm backup backup --scope=files
```

### Restore
```bash
# Dry run (safe)
docker compose run --rm backup restore --file=backup-2026-08-25.sql.gz --dry-run

# Actual restore (merge-only, creates rollback first)
docker compose run --rm backup restore --file=backup-2026-08-25.sql.gz
```

### PostgreSQL Backups (pgBackRest)
```bash
# On DB VPS
pgbackrest --stanza=main backup --type=full
pgbackrest --stanza=main backup --type=incr
pgbackrest --stanza=main restore --delta --target=latest
```

---

## 🔧 Troubleshooting

### Common Issues

| Issue | Diagnosis | Resolution |
|-------|-----------|------------|
| App unhealthy | `docker compose ps` shows unhealthy | Check `docker compose logs app`, verify DB/Redis connectivity |
| 503 on `/api/health` | Health checks failing | Check individual check failures in response |
| Payment gateway "unsupported" | Missing credentials | Configure in `/admin/payments/gateways` |
| WhatsApp not sending | Evolution API issue | Verify instance status, webhook URL, API key |
| SSL certificate error | Cert expired/missing | Run certbot, reload nginx |
| DB connection failed | Tunnel down | Check `db-tunnel` container, Cloudflare credentials |

### Debug Commands
```bash
# Check all services
docker compose ps --format "table {{.Names}}\t{{.Status}}\t{{.Health}}"

# Database connectivity
docker exec myrdphub-app-1 pg_isready -h host.docker.internal -p 15432

# Redis connectivity
docker exec myrdphub-redis-1 redis-cli ping

# Nginx config test
nginx -t && systemctl reload nginx

# Prisma migration status
docker compose run --rm migrate sh -c "npx prisma migrate status"
```

---

## 🤝 Contributing

### Branch Strategy
- `current` → Main development branch
- `main` → Stable releases (protected)
- Feature branches: `feat/feature-name`
- Fix branches: `fix/issue-description`

### Pull Request Process
1. Create feature branch from `current`
2. Implement changes with tests
3. Run `pnpm typecheck && pnpm lint && pnpm build`
4. Open PR against `current`
5. CI must pass (lint, typecheck, build, tests)
6. Code review required
7. Squash merge to `current`

### Release Process
```bash
# Tag release
git tag -a v1.1.0-ultraedge-redesign -m "UltraEdge Datacenter redesign"
git push origin --tags

# Deploy via Docker
docker compose pull
docker compose up -d --build --remove-orphans
docker compose run --rm migrate
```

---

## 📄 License

MIT License - see [LICENSE](LICENSE) for details.

---

## 📞 Support & Contact

- **Website**: https://ultraedgedatacenter.com
- **Documentation**: https://ultraedgedatacenter.com/docs
- **Status Page**: https://status.ultraedgedatacenter.com
- **Support Email**: support@zwscloud.com
- **Sales Email**: sales@ultraedgedatacenter.com
- **Abuse Reports**: abuse@ultraedgedatacenter.com

---

## 🙏 Acknowledgments

- **Next.js Team** - For the incredible App Router
- **Prisma Team** - For type-safe database access
- **Radix UI** - For accessible component primitives
- **Tailwind CSS** - For utility-first styling
- **Cloudflare** - For Tunnel and CDN infrastructure
- **Let's Encrypt** - For free SSL certificates
- **Evolution API** - For WhatsApp integration
- **Proxmox VE** - For virtualization platform

---

**Built with ❤️ by the UltraEdge Datacenter Team**

*Last updated: August 2026 | Version 1.1.0*