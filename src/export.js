const relName = (name) => (name === '@' ? '@' : name);

function exportRows(records) {
  const rows = [];
  for (const r of records) {
    for (const ip of r.state?.ips || []) {
      rows.push({ name: relName(r.name), type: ip.includes(':') ? 'AAAA' : 'A', ttl: r.ttl, value: ip, record: r });
    }
  }
  return rows.sort((x, y) => x.name.localeCompare(y.name) || x.type.localeCompare(y.type) || x.value.localeCompare(y.value));
}

/** BIND-style zone file fragment with the records currently published for a target. */
export function toZoneFile(target, records, { visibility, now = new Date() } = {}) {
  const rows = exportRows(records);
  const width = Math.max(1, ...rows.map((r) => r.name.length));
  const lines = [
    `; Exported by github-meta-dns-pool at ${now.toISOString()}`,
    `; Target: ${target.name} (${target.type}, ${visibility} zone)`,
    `; Records are randomly rotated; this is a point-in-time snapshot.`,
    `$ORIGIN ${target.zone}.`,
  ];
  let last = null;
  for (const row of rows) {
    if (row.record !== last) {
      last = row.record;
      lines.push(`; ${row.name}: sections ${row.record.sections.join(',')} · ${row.record.families} · rotates every ${row.record.intervalSec}s`);
    }
    lines.push(`${row.name.padEnd(width)} ${String(row.ttl).padStart(6)} IN ${row.type.padEnd(4)} ${row.value}`);
  }
  return lines.join('\n') + '\n';
}

export function toExportJson(target, records, { visibility, now = new Date() } = {}) {
  return {
    exportedAt: now.toISOString(),
    target: { id: target.id, name: target.name, type: target.type, zone: target.zone, visibility },
    records: records.map((r) => ({
      name: r.name,
      fqdn: r.name === '@' ? target.zone : `${r.name}.${target.zone}`,
      ttl: r.ttl,
      sections: r.sections,
      families: r.families,
      enabled: r.enabled,
      lastRotatedAt: r.lastRotatedAt ? new Date(r.lastRotatedAt).toISOString() : null,
      a: (r.state?.ips || []).filter((ip) => !ip.includes(':')),
      aaaa: (r.state?.ips || []).filter((ip) => ip.includes(':')),
    })),
  };
}
