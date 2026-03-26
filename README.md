# rr-tool

A CLI tool for managing IRC servers in an AWS Route53 geo-routing round-robin DNS pool.

## How It Works

The tool manages a multi-tier DNS routing setup:

```
irc.example.com
  └── rr.example.com (latency-based routing by AWS region)
        ├── geo-us-east-1.rr.example.com (weighted round-robin)
        │     ├── server-a.example.com (weight 100, health-checked)
        │     └── server-b.example.com (weight 100, health-checked)
        ├── geo-eu-central-1.rr.example.com
        │     └── server-c.example.com (weight 100, health-checked)
        └── ...
```

Each server in the pool has a TCP health check on port 6667 (IRC). To disable a server, the tool swaps its real health check with a "DEADHOST" health check that always fails, causing Route53 to stop routing traffic to it. To re-enable, it swaps the real health check back.

## Prerequisites

- [Node.js](https://nodejs.org/) (v18+)
- [pnpm](https://pnpm.io/)
- AWS credentials with Route53 access, configured as a named profile in `~/.aws/credentials`
- A Route53 hosted zone with the DNS structure described above
- A "DEADHOST" health check (a TCP check on an unreachable port, tagged with "DEADHOST")

## Setup

```bash
# Install dependencies
pnpm install

# Configure by auto-discovering settings from AWS
./rr-tool.ts configure example.com myawsprofile
```

The `configure` command queries AWS to find the hosted zone ID and DEADHOST health check ID, then writes them to `settings.json`.

## Usage

```bash
# Show the status of all servers in the RR pool
./rr-tool.ts status

# Disable a server (removes it from the pool via DEADHOST health check swap)
./rr-tool.ts disable myserver

# Re-enable a server (restores its real health check)
./rr-tool.ts enable myserver

# Add a new server to the pool (creates DNS records, health checks, and geo records)
./rr-tool.ts add myserver 1.2.3.4 us-east-1              # IPv4 only
./rr-tool.ts add myserver 1.2.3.4 us-east-1 2001:db8::1  # IPv4 + IPv6

# Skip confirmation prompts
./rr-tool.ts disable myserver -y
```

### Commands

| Command | Description |
|---------|-------------|
| `status` | Show all servers in the RR pool and whether they are active or disabled |
| `enable <server>` | Restore a server's real health check, making it active in the pool |
| `disable <server>` | Swap a server's health check with DEADHOST, removing it from the pool |
| `add <server> <ipv4> <region> [ipv6]` | Add a new server with DNS records, health checks, and geo routing |
| `configure <domain> <aws-profile>` | Auto-discover settings from AWS and write `settings.json` |

### Configuration

All settings are stored in `settings.json` (created by `configure`):

| Key | Description |
|-----|-------------|
| `domain` | The domain being managed |
| `hostedZoneId` | Route53 hosted zone ID |
| `deadhostHealthCheckId` | ID of the always-failing DEADHOST health check |
| `awsProfile` | AWS credentials profile name |
| `tagNameCorrections` | Optional map to correct typos in health check tag names |

## License

This project is licensed under the GNU General Public License v3.0 - see the [LICENSE](LICENSE) file for details.
