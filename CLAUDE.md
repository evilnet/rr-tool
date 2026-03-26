# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

IRC network Route53 DNS management. The main tool (`rr-tool.ts`) manages enabling/disabling IRC servers in the geo-routing round-robin pool by swapping health checks between real server checks and a DEADHOST (always-fail) placeholder.

## Running the Tool

```bash
# Install dependencies
pnpm install

# Auto-discover settings from AWS (creates/updates settings.json)
./rr-tool.ts configure example.com myawsprofile

# Run directly (has shebang for npx tsx)
./rr-tool.ts status
./rr-tool.ts enable <server>
./rr-tool.ts disable <server>
./rr-tool.ts disable <server> -y   # skip confirmation
```

Requires AWS credentials configured (profile name is stored in `settings.json`).

## Architecture

**DNS routing chain:** `irc.<domain>` → `rr.<domain>` (latency-based, multiple AWS regions) → `geo-<region>.rr.<domain>` (weighted round-robin per region) → individual server A/AAAA records.

**Enable/disable mechanism:** Each server's DNS record has a health check. To disable a server, the tool swaps its real health check ID with the DEADHOST health check (an always-failing check on TCP port 99). To enable, it swaps back to the real health check. Both IPv4 and IPv6 records are updated together.

**Configuration (`settings.json`):**
- `domain` — the domain managed by this tool
- `hostedZoneId` — the Route53 hosted zone ID
- `deadhostHealthCheckId` — the always-fail health check used as placeholder
- `awsProfile` — AWS credentials profile name
- `tagNameCorrections` — maps typos in health check tag names to corrected versions

Run `./rr-tool.ts configure <domain> <aws-profile>` to auto-populate by querying AWS (finds the hosted zone by domain name and the deadhost health check by searching for a "deadhost" tag).

## Tech Stack

- TypeScript, run via `tsx` (no build step)
- `@aws-sdk/client-route-53` for Route53 API
- pnpm for package management
- No tests configured
