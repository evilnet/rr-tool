#!/usr/bin/env tsx
/**
 * IRC network round-robin DNS management tool.
 *
 * Manages enabling/disabling IRC servers in the Route53 geo-routing pool
 * by swapping health checks between real server checks and a DEADHOST placeholder.
 *
 * Usage:
 *   ./rr-tool.ts status
 *   ./rr-tool.ts enable <server>
 *   ./rr-tool.ts disable <server>
 *   ./rr-tool.ts enable <server> -y    (skip confirmation)
 */

import {
  Route53Client,
  ListHealthChecksCommand,
  ListTagsForResourceCommand,
  ListResourceRecordSetsCommand,
  ChangeResourceRecordSetsCommand,
  ListHostedZonesCommand,
  CreateHealthCheckCommand,
  ChangeTagsForResourceCommand,
  type HealthCheck,
  type ResourceRecordSet,
  type Change,
} from "@aws-sdk/client-route-53";
import * as crypto from "crypto";
import { fromIni } from "@aws-sdk/credential-providers";
import * as readline from "readline";
import * as fs from "fs";
import * as path from "path";

const SETTINGS_PATH = path.join(path.dirname(new URL(import.meta.url).pathname), "settings.json");

interface Settings {
  domain: string;
  hostedZoneId: string;
  deadhostHealthCheckId: string;
  awsProfile: string;
  tagNameCorrections: Record<string, string>;
}

function loadSettings(): Settings {
  if (!fs.existsSync(SETTINGS_PATH)) {
    console.error(`Settings file not found: ${SETTINGS_PATH}`);
    console.error(`Run './rr-tool.ts configure' to create it.`);
    process.exit(1);
  }
  const raw = JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf-8"));
  const required = ["domain", "hostedZoneId", "deadhostHealthCheckId", "awsProfile"];
  for (const key of required) {
    if (!raw[key]) {
      console.error(`Settings missing required key '${key}'. Run './rr-tool.ts configure' to fix.`);
      process.exit(1);
    }
  }
  return {
    domain: raw.domain,
    hostedZoneId: raw.hostedZoneId,
    deadhostHealthCheckId: raw.deadhostHealthCheckId,
    awsProfile: raw.awsProfile,
    tagNameCorrections: raw.tagNameCorrections ?? {},
  };
}

function saveSettings(settings: Settings): void {
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + "\n");
}

function getClient(settings: Settings): Route53Client {
  return new Route53Client({
    region: "us-east-1",
    credentials: fromIni({ profile: settings.awsProfile }),
  });
}

function color(text: string, code: string): string {
  if (process.stdout.isTTY) {
    return `\x1b[${code}m${text}\x1b[0m`;
  }
  return text;
}

function confirm(prompt: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === "y");
    });
  });
}

interface HcMap {
  [server: string]: { ipv4?: string; ipv6?: string };
}

async function fetchHealthCheckMap(client: Route53Client, settings: Settings): Promise<HcMap> {
  const hcMap: HcMap = {};

  // Fetch all health checks (paginate)
  let marker: string | undefined;
  const allChecks: HealthCheck[] = [];
  do {
    const resp = await client.send(new ListHealthChecksCommand({ Marker: marker }));
    allChecks.push(...(resp.HealthChecks ?? []));
    marker = resp.IsTruncated ? resp.NextMarker : undefined;
  } while (marker);

  // Get tags for each health check
  for (const hc of allChecks) {
    const hcId = hc.Id!;
    if (hcId === settings.deadhostHealthCheckId) continue;

    const tagResp = await client.send(
      new ListTagsForResourceCommand({ ResourceType: "healthcheck", ResourceId: hcId })
    );
    const tags = tagResp.ResourceTagSet?.Tags ?? [];
    const name = tags.find((t) => t.Key === "Name")?.Value ?? "";

    // Parse tag like "myserver.example.com-ipv4"
    for (const suffix of ["-ipv4", "-ipv6"] as const) {
      if (!name.endsWith(suffix)) continue;
      // Skip non-IRC checks (e.g. www.example.com-web-ipv4)
      if (name.includes("-web")) continue;

      const proto = suffix.slice(1) as "ipv4" | "ipv6";
      const serverPart = name.slice(0, -suffix.length);
      if (!serverPart.endsWith(`.${settings.domain}`)) continue;

      let serverName = serverPart.slice(0, -(`.${settings.domain}`.length));
      serverName = settings.tagNameCorrections[serverName] ?? serverName;

      hcMap[serverName] ??= {};
      hcMap[serverName][proto] = hcId;
      break;
    }
  }

  return hcMap;
}

interface RrRecord {
  serverName: string;
  region: string;
  proto: "ipv4" | "ipv6";
  setIdentifier: string;
  currentHcId: string | undefined;
  fullRecord: ResourceRecordSet;
}

async function fetchRrRecords(client: Route53Client, settings: Settings): Promise<RrRecord[]> {
  const records: RrRecord[] = [];

  let startName: string | undefined;
  let startType: string | undefined;
  let startId: string | undefined;
  let truncated = true;

  while (truncated) {
    const resp = await client.send(
      new ListResourceRecordSetsCommand({
        HostedZoneId: settings.hostedZoneId,
        StartRecordName: startName,
        StartRecordType: startType,
        StartRecordIdentifier: startId,
      })
    );

    for (const rec of resp.ResourceRecordSets ?? []) {
      const name = rec.Name ?? "";
      const rrSuffix = `.rr.${settings.domain}.`;
      if (!name.startsWith("geo-") || !name.endsWith(rrSuffix)) continue;
      if (rec.Weight === undefined) continue;

      const region = name.slice("geo-".length, name.indexOf(rrSuffix));
      const dnsName = rec.AliasTarget?.DNSName ?? "";
      const domainSuffix = `.${settings.domain}.`;
      if (!dnsName.endsWith(domainSuffix)) continue;

      const serverName = dnsName.slice(0, -domainSuffix.length);
      const proto = rec.Type === "A" ? "ipv4" : "ipv6";

      records.push({
        serverName,
        region,
        proto,
        setIdentifier: rec.SetIdentifier!,
        currentHcId: rec.HealthCheckId,
        fullRecord: rec,
      });
    }

    truncated = resp.IsTruncated ?? false;
    if (truncated) {
      startName = resp.NextRecordName;
      startType = resp.NextRecordType;
      startId = resp.NextRecordIdentifier;
    }
  }

  return records;
}

interface ServerRecord {
  setIdentifier: string;
  currentHcId: string | undefined;
  realHcId: string | undefined;
  isDisabled: boolean;
  fullRecord: ResourceRecordSet;
}

interface ServerInfo {
  region: string;
  records: { ipv4?: ServerRecord; ipv6?: ServerRecord };
}

type ServerMap = Record<string, ServerInfo>;

async function buildServerMap(client: Route53Client, settings: Settings): Promise<ServerMap> {
  const [hcMap, rrRecords] = await Promise.all([
    fetchHealthCheckMap(client, settings),
    fetchRrRecords(client, settings),
  ]);

  const servers: ServerMap = {};

  for (const rec of rrRecords) {
    servers[rec.serverName] ??= { region: rec.region, records: {} };

    const realHcId = hcMap[rec.serverName]?.[rec.proto];
    const isDisabled = rec.currentHcId === settings.deadhostHealthCheckId;

    servers[rec.serverName].records[rec.proto] = {
      setIdentifier: rec.setIdentifier,
      currentHcId: rec.currentHcId,
      realHcId,
      isDisabled,
      fullRecord: rec.fullRecord,
    };
  }

  return servers;
}

async function cmdStatus(client: Route53Client, settings: Settings) {
  const servers = await buildServerMap(client, settings);

  console.log();
  console.log(color("IRC Round-Robin Status", "1"));
  console.log("=".repeat(60));
  console.log(
    `${"Server".padEnd(22)} ${"Region".padEnd(20)} ${"IPv4".padEnd(10)} ${"IPv6".padEnd(10)}`
  );
  console.log("-".repeat(60));

  for (const name of Object.keys(servers).sort()) {
    const info = servers[name];
    const fmt = (proto: "ipv4" | "ipv6") => {
      const rec = info.records[proto];
      if (!rec) return "(none)";
      return rec.isDisabled ? color("DISABLED", "31") : color("ACTIVE", "32");
    };
    console.log(`${name.padEnd(22)} ${info.region.padEnd(20)} ${fmt("ipv4").padEnd(10)} ${fmt("ipv6")}`);
  }
  console.log();
}

async function cmdEnable(client: Route53Client, settings: Settings, server: string, skipConfirm: boolean) {
  const servers = await buildServerMap(client, settings);

  if (!(server in servers)) {
    console.error(`Error: Unknown server '${server}'. Available servers:`);
    for (const name of Object.keys(servers).sort()) {
      console.error(`  - ${name}`);
    }
    process.exit(1);
  }

  const info = servers[server];
  const changes: { proto: string; oldHc: string; newHc: string; record: ResourceRecordSet }[] = [];

  for (const proto of ["ipv4", "ipv6"] as const) {
    const rec = info.records[proto];
    if (!rec) continue;
    if (!rec.isDisabled) {
      console.log(`  ${proto}: already active`);
      continue;
    }
    if (!rec.realHcId) {
      console.error(`  ${proto}: no real health check found, skipping`);
      continue;
    }
    changes.push({
      proto,
      oldHc: rec.currentHcId!,
      newHc: rec.realHcId,
      record: { ...rec.fullRecord, HealthCheckId: rec.realHcId },
    });
  }

  if (changes.length === 0) {
    console.log(`${server} is already fully active.`);
    return;
  }

  console.log(`\nEnabling ${server} in ${info.region}:`);
  for (const c of changes) {
    console.log(`  ${c.proto}: ${c.oldHc.slice(0, 12)}... (DEADHOST) -> ${c.newHc.slice(0, 12)}... (real)`);
  }

  if (!skipConfirm) {
    const ok = await confirm("\nProceed? [y/N] ");
    if (!ok) {
      console.log("Aborted.");
      return;
    }
  }

  const resp = await client.send(
    new ChangeResourceRecordSetsCommand({
      HostedZoneId: settings.hostedZoneId,
      ChangeBatch: {
        Changes: changes.map((c) => ({ Action: "UPSERT", ResourceRecordSet: c.record })),
      },
    })
  );

  console.log(`\nDone. Change ${resp.ChangeInfo?.Id} — ${resp.ChangeInfo?.Status}`);
}

async function cmdDisable(client: Route53Client, settings: Settings, server: string, skipConfirm: boolean) {
  const servers = await buildServerMap(client, settings);

  if (!(server in servers)) {
    console.error(`Error: Unknown server '${server}'. Available servers:`);
    for (const name of Object.keys(servers).sort()) {
      console.error(`  - ${name}`);
    }
    process.exit(1);
  }

  const info = servers[server];
  const changes: { proto: string; oldHc: string; record: ResourceRecordSet }[] = [];

  for (const proto of ["ipv4", "ipv6"] as const) {
    const rec = info.records[proto];
    if (!rec) continue;
    if (rec.isDisabled) {
      console.log(`  ${proto}: already disabled`);
      continue;
    }
    changes.push({
      proto,
      oldHc: rec.currentHcId!,
      record: { ...rec.fullRecord, HealthCheckId: settings.deadhostHealthCheckId },
    });
  }

  if (changes.length === 0) {
    console.log(`${server} is already fully disabled.`);
    return;
  }

  console.log(`\nDisabling ${server} in ${info.region}:`);
  for (const c of changes) {
    console.log(`  ${c.proto}: ${c.oldHc.slice(0, 12)}... (real) -> DEADHOST`);
  }

  if (!skipConfirm) {
    const ok = await confirm("\nProceed? [y/N] ");
    if (!ok) {
      console.log("Aborted.");
      return;
    }
  }

  const resp = await client.send(
    new ChangeResourceRecordSetsCommand({
      HostedZoneId: settings.hostedZoneId,
      ChangeBatch: {
        Changes: changes.map((c) => ({ Action: "UPSERT", ResourceRecordSet: c.record })),
      },
    })
  );

  console.log(`\nDone. Change ${resp.ChangeInfo?.Id} — ${resp.ChangeInfo?.Status}`);
}

async function createHealthCheck(
  client: Route53Client,
  ip: string,
  tagName: string,
): Promise<string> {
  const resp = await client.send(
    new CreateHealthCheckCommand({
      CallerReference: crypto.randomUUID(),
      HealthCheckConfig: {
        IPAddress: ip,
        Port: 6667,
        Type: "TCP",
        RequestInterval: 30,
        FailureThreshold: 3,
        MeasureLatency: false,
        Inverted: false,
        Disabled: false,
        EnableSNI: false,
      },
    })
  );
  const hcId = resp.HealthCheck!.Id!;

  await client.send(
    new ChangeTagsForResourceCommand({
      ResourceType: "healthcheck",
      ResourceId: hcId,
      AddTags: [{ Key: "Name", Value: tagName }],
    })
  );

  return hcId;
}

async function findExistingRegions(client: Route53Client, settings: Settings): Promise<Set<string>> {
  const regions = new Set<string>();
  let startName: string | undefined;
  let startType: string | undefined;
  let startId: string | undefined;
  let truncated = true;

  while (truncated) {
    const resp = await client.send(
      new ListResourceRecordSetsCommand({
        HostedZoneId: settings.hostedZoneId,
        StartRecordName: startName,
        StartRecordType: startType,
        StartRecordIdentifier: startId,
      })
    );

    for (const rec of resp.ResourceRecordSets ?? []) {
      if (rec.Name === `rr.${settings.domain}.` && rec.Region) {
        regions.add(rec.Region);
      }
    }

    truncated = resp.IsTruncated ?? false;
    if (truncated) {
      startName = resp.NextRecordName;
      startType = resp.NextRecordType;
      startId = resp.NextRecordIdentifier;
    }
  }

  return regions;
}

async function cmdAdd(
  client: Route53Client,
  settings: Settings,
  serverName: string,
  ipv4: string,
  ipv6: string | undefined,
  region: string,
  skipConfirm: boolean,
) {
  // Check if server already exists in the RR pool
  const servers = await buildServerMap(client, settings);
  if (serverName in servers) {
    console.error(`Error: Server '${serverName}' already exists in the RR pool (region: ${servers[serverName].region}).`);
    process.exit(1);
  }

  // Check if the region already has latency records
  const existingRegions = await findExistingRegions(client, settings);
  const isNewRegion = !existingRegions.has(region);

  // Plan what we'll create
  console.log(`\nAdding server '${serverName}' to the RR pool in ${region}:\n`);

  console.log("  DNS records:");
  console.log(`    A    ${serverName}.${settings.domain} → ${ipv4}`);
  if (ipv6) {
    console.log(`    AAAA ${serverName}.${settings.domain} → ${ipv6}`);
  }

  console.log("\n  Health checks (TCP port 6667):");
  console.log(`    ${serverName}.${settings.domain}-ipv4 → ${ipv4}`);
  if (ipv6) {
    console.log(`    ${serverName}.${settings.domain}-ipv6 → ${ipv6}`);
  }

  if (isNewRegion) {
    console.log(`\n  New region '${region}' — will create latency records on rr.${settings.domain}`);
  }

  console.log("\n  Geo RR records:");
  console.log(`    geo-${region}.rr.${settings.domain} A   → ${serverName}.${settings.domain} (weight 100)`);
  if (ipv6) {
    console.log(`    geo-${region}.rr.${settings.domain} AAAA → ${serverName}.${settings.domain} (weight 100)`);
  }

  if (!skipConfirm) {
    const ok = await confirm("\nProceed? [y/N] ");
    if (!ok) {
      console.log("Aborted.");
      return;
    }
  }

  // 1. Create health checks
  console.log("\nCreating health checks...");
  const hcIpv4Id = await createHealthCheck(client, ipv4, `${serverName}.${settings.domain}-ipv4`);
  console.log(`  ipv4: ${hcIpv4Id}`);

  let hcIpv6Id: string | undefined;
  if (ipv6) {
    hcIpv6Id = await createHealthCheck(client, ipv6, `${serverName}.${settings.domain}-ipv6`);
    console.log(`  ipv6: ${hcIpv6Id}`);
  }

  // 2. Create DNS records in a single batch
  console.log("\nCreating DNS records...");
  const changes: Change[] = [];

  // A record for server.<domain>
  changes.push({
    Action: "UPSERT",
    ResourceRecordSet: {
      Name: `${serverName}.${settings.domain}.`,
      Type: "A",
      TTL: 300,
      ResourceRecords: [{ Value: ipv4 }],
    },
  });

  // AAAA record
  if (ipv6) {
    changes.push({
      Action: "UPSERT",
      ResourceRecordSet: {
        Name: `${serverName}.${settings.domain}.`,
        Type: "AAAA",
        TTL: 300,
        ResourceRecords: [{ Value: ipv6 }],
      },
    });
  }

  // Latency-based records on rr.<domain> for new regions
  if (isNewRegion) {
    changes.push({
      Action: "CREATE",
      ResourceRecordSet: {
        Name: `rr.${settings.domain}.`,
        Type: "A",
        SetIdentifier: `geo-${region}`,
        Region: region,
        AliasTarget: {
          HostedZoneId: settings.hostedZoneId,
          DNSName: `geo-${region}.rr.${settings.domain}.`,
          EvaluateTargetHealth: true,
        },
      },
    });
    changes.push({
      Action: "CREATE",
      ResourceRecordSet: {
        Name: `rr.${settings.domain}.`,
        Type: "AAAA",
        SetIdentifier: `geo-${region}`,
        Region: region,
        AliasTarget: {
          HostedZoneId: settings.hostedZoneId,
          DNSName: `geo-${region}.rr.${settings.domain}.`,
          EvaluateTargetHealth: true,
        },
      },
    });
  }

  // Weighted geo records
  changes.push({
    Action: "CREATE",
    ResourceRecordSet: {
      Name: `geo-${region}.rr.${settings.domain}.`,
      Type: "A",
      SetIdentifier: `ircd-${serverName}-ipv4`,
      Weight: 100,
      AliasTarget: {
        HostedZoneId: settings.hostedZoneId,
        DNSName: `${serverName}.${settings.domain}.`,
        EvaluateTargetHealth: false,
      },
      HealthCheckId: hcIpv4Id,
    },
  });

  if (ipv6 && hcIpv6Id) {
    changes.push({
      Action: "CREATE",
      ResourceRecordSet: {
        Name: `geo-${region}.rr.${settings.domain}.`,
        Type: "AAAA",
        SetIdentifier: `ircd-${serverName}-ipv6`,
        Weight: 100,
        AliasTarget: {
          HostedZoneId: settings.hostedZoneId,
          DNSName: `${serverName}.${settings.domain}.`,
          EvaluateTargetHealth: false,
        },
        HealthCheckId: hcIpv6Id,
      },
    });
  }

  const resp = await client.send(
    new ChangeResourceRecordSetsCommand({
      HostedZoneId: settings.hostedZoneId,
      ChangeBatch: { Changes: changes },
    })
  );

  console.log(`\nDone. Change ${resp.ChangeInfo?.Id} — ${resp.ChangeInfo?.Status}`);
  console.log(`\nServer '${serverName}' added and active in the ${region} RR pool.`);
}

async function cmdConfigure(awsProfile: string, domain: string) {
  console.log(`\nInitializing settings for domain '${domain}' using AWS profile '${awsProfile}'...`);

  const client = new Route53Client({
    region: "us-east-1",
    credentials: fromIni({ profile: awsProfile }),
  });

  // Find hosted zone for domain
  console.log(`\nSearching for hosted zone for '${domain}'...`);
  let hostedZoneId: string | undefined;
  let zoneMarker: string | undefined;
  do {
    const resp = await client.send(new ListHostedZonesCommand({ Marker: zoneMarker }));
    for (const zone of resp.HostedZones ?? []) {
      if (zone.Name === `${domain}.`) {
        hostedZoneId = zone.Id!.replace("/hostedzone/", "");
        break;
      }
    }
    zoneMarker = resp.IsTruncated ? resp.NextMarker : undefined;
  } while (!hostedZoneId && zoneMarker);

  if (!hostedZoneId) {
    console.error(`Could not find hosted zone for '${domain}'.`);
    process.exit(1);
  }
  console.log(`  Found hosted zone: ${hostedZoneId}`);

  // Find deadhost health check by searching tags for 'deadhost'
  console.log(`\nSearching for deadhost health check...`);
  let deadhostHcId: string | undefined;
  let hcMarker: string | undefined;
  const allChecks: HealthCheck[] = [];
  do {
    const resp = await client.send(new ListHealthChecksCommand({ Marker: hcMarker }));
    allChecks.push(...(resp.HealthChecks ?? []));
    hcMarker = resp.IsTruncated ? resp.NextMarker : undefined;
  } while (hcMarker);

  for (const hc of allChecks) {
    const tagResp = await client.send(
      new ListTagsForResourceCommand({ ResourceType: "healthcheck", ResourceId: hc.Id! })
    );
    const tags = tagResp.ResourceTagSet?.Tags ?? [];
    const name = (tags.find((t) => t.Key === "Name")?.Value ?? "").toLowerCase();
    if (name.includes("deadhost")) {
      deadhostHcId = hc.Id!;
      console.log(`  Found deadhost health check: ${deadhostHcId} (tag: "${tags.find((t) => t.Key === "Name")?.Value}")`);
      break;
    }
  }

  if (!deadhostHcId) {
    console.error(`Could not find a health check with 'deadhost' in its Name tag.`);
    process.exit(1);
  }

  // Load existing settings to preserve tagNameCorrections, or start fresh
  let tagNameCorrections: Record<string, string> = {};
  if (fs.existsSync(SETTINGS_PATH)) {
    try {
      const existing = JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf-8"));
      tagNameCorrections = existing.tagNameCorrections ?? {};
    } catch {}
  }

  const settings: Settings = {
    domain,
    hostedZoneId,
    deadhostHealthCheckId: deadhostHcId,
    awsProfile,
    tagNameCorrections,
  };

  saveSettings(settings);
  console.log(`\nSettings saved to ${SETTINGS_PATH}`);
  console.log(JSON.stringify(settings, null, 2));
}

async function main() {
  const args = process.argv.slice(2);
  const skipConfirm = args.includes("-y") || args.includes("--yes");
  const positional = args.filter((a) => a !== "-y" && a !== "--yes");

  const command = positional[0];
  const server = positional[1];

  if (!command || !["status", "enable", "disable", "add", "configure"].includes(command)) {
    console.log("Usage: rr-tool.ts <command> [args] [-y]");
    console.log();
    console.log("Commands:");
    console.log("  status                                        Show RR pool server status");
    console.log("  enable <server>                               Enable a server in the RR pool");
    console.log("  disable <server>                              Disable a server in the RR pool");
    console.log("  add <server> <ipv4> <region> [ipv6]           Add a new server to the RR pool");
    console.log("  configure <domain> <aws-profile>               Auto-discover settings from AWS");
    console.log();
    console.log("Options:");
    console.log("  -y, --yes           Skip confirmation prompt");
    process.exit(1);
  }

  if (command === "configure") {
    const domain = positional[1];
    const awsProfile = positional[2];
    if (!domain || !awsProfile) {
      console.error("Usage: rr-tool.ts configure <domain> <aws-profile>");
      console.error("Example: ./rr-tool.ts configure example.com myawsprofile");
      process.exit(1);
    }
    await cmdConfigure(awsProfile, domain);
    return;
  }

  const settings = loadSettings();
  const client = getClient(settings);

  if (command === "status") {
    await cmdStatus(client, settings);
  } else if (command === "add") {
    const addServer = positional[1];
    const addIpv4 = positional[2];
    const addRegion = positional[3];
    const addIpv6 = positional[4];
    if (!addServer || !addIpv4 || !addRegion) {
      console.error("Usage: rr-tool.ts add <server> <ipv4> <region> [ipv6]");
      console.error("Example: rr-tool.ts add myserver 1.2.3.4 us-east-1 2001:db8::1");
      process.exit(1);
    }
    await cmdAdd(client, settings, addServer, addIpv4, addIpv6, addRegion, skipConfirm);
  } else if (command === "enable" || command === "disable") {
    if (!server) {
      console.error(`Error: ${command} requires a server name.`);
      process.exit(1);
    }
    if (command === "enable") {
      await cmdEnable(client, settings, server, skipConfirm);
    } else {
      await cmdDisable(client, settings, server, skipConfirm);
    }
  }
}

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
