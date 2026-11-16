import { assertSafeToken } from './util.js';

export const AZURE_ZONE_TYPES = ['private', 'public'];

export function validateAzureConfig(c) {
  assertSafeToken('subscription ID', c.subscriptionId, /^[0-9a-f-]{36}$/i);
  assertSafeToken('resource group', c.resourceGroup, /^[\w\-.()]{1,90}$/);
  const zoneType = c.zoneType || 'private';
  if (!AZURE_ZONE_TYPES.includes(zoneType)) throw new Error('zoneType must be private or public');
  const out = { zoneType, subscriptionId: c.subscriptionId, resourceGroup: c.resourceGroup, tenantId: '', clientId: '', clientSecret: '' };
  if (c.tenantId || c.clientId || c.clientSecret) {
    assertSafeToken('tenant ID', c.tenantId, /^[0-9a-f-]{36}$/i);
    assertSafeToken('client ID', c.clientId, /^[0-9a-f-]{36}$/i);
    if (!c.clientSecret) throw new Error('Client secret is required with tenant/client ID');
    Object.assign(out, { tenantId: c.tenantId, clientId: c.clientId, clientSecret: c.clientSecret });
  }
  return out;
}

async function defaultClientFactory(cfg) {
  const identity = await import('@azure/identity');
  const credential = cfg.clientId
    ? new identity.ClientSecretCredential(cfg.tenantId, cfg.clientId, cfg.clientSecret)
    : new identity.DefaultAzureCredential();
  if (cfg.zoneType === 'public') {
    const { DnsManagementClient } = await import('@azure/arm-dns');
    return new DnsManagementClient(credential, cfg.subscriptionId);
  }
  const { PrivateDnsManagementClient } = await import('@azure/arm-privatedns');
  return new PrivateDnsManagementClient(credential, cfg.subscriptionId);
}

/**
 * Normalise the two SDKs: Private DNS takes (rg, zone, type, name), public DNS takes (rg, zone, name, type).
 */
function adapter(c, zoneType) {
  const pub = zoneType === 'public';
  return {
    put: (rg, zone, type, name, params) =>
      pub ? c.recordSets.createOrUpdate(rg, zone, name, type, params) : c.recordSets.createOrUpdate(rg, zone, type, name, params),
    del: (rg, zone, type, name) => (pub ? c.recordSets.delete(rg, zone, name, type) : c.recordSets.delete(rg, zone, type, name)),
    getZone: (rg, zone) => (pub ? c.zones.get(rg, zone) : c.privateZones.get(rg, zone)),
  };
}

export function createAzureProvider(target, { clientFactory = defaultClientFactory } = {}) {
  const cfg = validateAzureConfig(target.config);
  const zone = target.zone.replace(/\.$/, '');
  let clientPromise;
  const client = () => (clientPromise ??= Promise.resolve(clientFactory(cfg)).then((c) => adapter(c, cfg.zoneType)));

  async function setType(name, type, ips, ttl) {
    const c = await client();
    if (!ips.length) {
      try {
        await c.del(cfg.resourceGroup, zone, type, name);
      } catch (e) {
        if (e?.statusCode !== 404) throw e;
      }
      return;
    }
    const params =
      type === 'A'
        ? { ttl, aRecords: ips.map((ipv4Address) => ({ ipv4Address })) }
        : { ttl, aaaaRecords: ips.map((ipv6Address) => ({ ipv6Address })) };
    params.metadata = { managedBy: 'github-meta-dns-pool' };
    await c.put(cfg.resourceGroup, zone, type, name, params);
  }

  return {
    async apply(name, { a = [], aaaa = [], ttl }) {
      await setType(name, 'A', a, ttl);
      await setType(name, 'AAAA', aaaa, ttl);
    },
    async remove(name) {
      await setType(name, 'A', [], 0);
      await setType(name, 'AAAA', [], 0);
    },
    async test() {
      const c = await client();
      const z = await c.getZone(cfg.resourceGroup, zone);
      return `Connected to Azure ${cfg.zoneType === 'public' ? 'public' : 'Private'} DNS zone ${z?.name ?? zone}`;
    },
  };
}
