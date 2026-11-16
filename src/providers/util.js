export function fqdn(name, zone) {
  const z = zone.replace(/\.$/, '');
  return name === '@' ? z : `${name}.${z}`;
}

export function assertSafeToken(label, value, re = /^[A-Za-z0-9._:\-+/=]+$/) {
  if (typeof value !== 'string' || !re.test(value)) throw new Error(`Invalid ${label}`);
}
