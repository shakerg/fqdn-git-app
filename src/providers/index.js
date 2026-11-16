import { createBind9Provider, validateBind9Config } from './bind9.js';
import { createCloudflareProvider, validateCloudflareConfig } from './cloudflare.js';
import { createAzureProvider, validateAzureConfig } from './azure.js';

export const SECRET_FIELDS = {
  bind9: ['tsigSecret'],
  cloudflare: ['apiToken'],
  azure: ['clientSecret'],
};

export const VALIDATORS = {
  bind9: validateBind9Config,
  cloudflare: validateCloudflareConfig,
  azure: validateAzureConfig,
};

export function createProviderFactory(overrides = {}) {
  const factories = {
    bind9: createBind9Provider,
    cloudflare: createCloudflareProvider,
    azure: createAzureProvider,
    ...overrides,
  };
  return (target) => {
    const f = factories[target.type];
    if (!f) throw new Error(`Unknown target type ${target.type}`);
    return f(target);
  };
}

/** Whether a target publishes into a private or public zone. Cloudflare zones are always public. */
export function targetVisibility(type, config = {}) {
  if (type === 'cloudflare') return 'public';
  if (type === 'azure') return config.zoneType === 'public' ? 'public' : 'private';
  return config.visibility === 'public' ? 'public' : 'private';
}

/** Return config with secret fields replaced by a boolean "set" marker. */
export function redactConfig(type, config) {
  const out = { ...config };
  for (const k of SECRET_FIELDS[type] || []) {
    out[`${k}Set`] = !!out[k];
    delete out[k];
  }
  return out;
}
