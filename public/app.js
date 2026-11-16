const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v == null) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  if (res.status === 401 && path !== '/login') {
    showLogin();
    throw new Error('Session expired');
  }
  if (res.status === 204) return null;
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
}

const state = { targets: [], records: [], sections: [], limits: null };
const fmtTime = (t) => (t ? new Date(t).toLocaleString() : '—');
const fmtShort = (t) => {
  if (!t) return '—';
  const d = new Date(t);
  return d.toDateString() === new Date().toDateString() ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : d.toLocaleString([], { dateStyle: 'short', timeStyle: 'short' });
};
const fmtDur = (s) => (s % 86400 === 0 ? `${s / 86400}d` : s % 3600 === 0 ? `${s / 3600}h` : s % 60 === 0 ? `${s / 60}m` : `${s}s`);

let toastTimer;
function toast(msg, isErr = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.toggle('err', isErr);
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 6000);
}

async function busy(btn, fn) {
  btn.disabled = true;
  try {
    return await fn();
  } finally {
    btn.disabled = false;
  }
}

// ---------- auth
function showLogin() {
  $('#app-view').hidden = true;
  $('#login-view').hidden = false;
  $('#password').focus();
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#login-error').textContent = '';
  try {
    await api('/login', { method: 'POST', body: { password: $('#password').value } });
    $('#password').value = '';
    await boot();
  } catch (err) {
    $('#login-error').textContent = err.message;
  }
});

$('#logout').addEventListener('click', async () => {
  await api('/logout', { method: 'POST' }).catch(() => {});
  showLogin();
});

// ---------- tabs
function selectTab(name) {
  for (const b of $$('[role="tab"]')) b.setAttribute('aria-selected', String(b.dataset.tab === name));
  for (const p of $$('.tab')) p.hidden = p.id !== `tab-${name}`;
  if (name === 'logs') loadLogs();
}
for (const b of $$('[role="tab"]')) b.addEventListener('click', () => selectTab(b.dataset.tab));
$('nav[role="tablist"]').addEventListener('keydown', (e) => {
  if (!['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
  const tabs = $$('[role="tab"]');
  const i = tabs.indexOf(document.activeElement);
  const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
  next.focus();
  selectTab(next.dataset.tab);
});

// ---------- meta
async function loadMeta() {
  const m = await api('/meta');
  state.sections = m.sections;
  $('#meta-status').textContent = m.fetchedAt
    ? `Meta: ${m.sections.length} sections · ${fmtTime(m.fetchedAt)}`
    : 'Meta: not loaded yet';
}
$('#meta-refresh').addEventListener('click', (e) =>
  busy(e.currentTarget, async () => {
    try {
      const r = await api('/meta/refresh', { method: 'POST' });
      await loadMeta();
      toast(r.changed ? 'GitHub meta updated; affected records will rotate.' : 'GitHub meta unchanged.');
      await loadRecords();
    } catch (err) {
      toast(err.message, true);
    }
  })
);

// ---------- targets
function targetDetails(t) {
  const c = t.config || {};
  if (t.type === 'bind9') return `${c.server}:${c.port}${c.tsigKeyName ? ` · key ${c.tsigKeyName}` : ' · no TSIG'}${c.useTcp ? ' · TCP' : ''}`;
  if (t.type === 'cloudflare') return `zone ${c.zoneId} · token ${c.apiTokenSet ? 'set' : 'missing'}`;
  if (t.type === 'azure') return `${c.zoneType === 'public' ? 'public' : 'private'} zone · ${c.resourceGroup} · ${c.clientId ? `SP ${c.clientId}` : 'managed identity'}`;
  return '';
}

async function loadTargets() {
  state.targets = await api('/targets');
  const tbody = $('#targets-table tbody');
  tbody.replaceChildren(
    ...state.targets.map((t) =>
      h(
        'tr',
        {},
        h('td', {}, t.name),
        h('td', {}, t.type, h('div', {}, h('span', { class: `badge badge-${t.visibility}` }, t.visibility))),
        h('td', { class: 'mono' }, t.zone),
        h('td', { class: 'muted' }, targetDetails(t)),
        h(
          'td',
          { class: 'actions-cell' },
          h('button', { type: 'button', onclick: (e) => testTarget(t, e.currentTarget) }, 'Test'),
          h('a', { class: 'button', href: `/api/targets/${t.id}/export?format=zone`, download: '', title: 'Download current records as a BIND zone file' }, 'Export zone'),
          h('a', { class: 'button', href: `/api/targets/${t.id}/export?format=json`, download: '', title: 'Download current records as JSON' }, 'JSON'),
          h('button', { type: 'button', onclick: () => openTargetDialog(t) }, 'Edit'),
          h('button', { type: 'button', class: 'danger', onclick: () => deleteTarget(t) }, 'Delete')
        )
      )
    )
  );
  $('#targets-empty').hidden = state.targets.length > 0;
}

function testTarget(t, btn) {
  return busy(btn, async () => {
    const r = await api(`/targets/${t.id}/test`, { method: 'POST' }).catch((e) => ({ ok: false, message: e.message }));
    toast(`${t.name}: ${r.message}`, !r.ok);
  });
}

async function deleteTarget(t) {
  if (!confirm(`Delete target "${t.name}"?`)) return;
  try {
    await api(`/targets/${t.id}`, { method: 'DELETE' });
    await loadTargets();
  } catch (err) {
    toast(err.message, true);
  }
}

let editingTarget = null;
function showTypeFields(type) {
  for (const f of $$('#target-form .type-fields')) f.hidden = f.dataset.type !== type;
}
$('#t-type').addEventListener('change', (e) => showTypeFields(e.target.value));

function openTargetDialog(t = null) {
  editingTarget = t;
  const form = $('#target-form');
  form.reset();
  $('#target-error').textContent = '';
  $('#target-dialog-title').textContent = t ? `Edit target: ${t.name}` : 'New target';
  $('#t-type').value = t?.type || 'bind9';
  $('#t-type').disabled = !!t;
  $('#t-name').value = t?.name || '';
  $('#t-zone').value = t?.zone || '';
  showTypeFields($('#t-type').value);
  for (const input of $$('[data-cfg]', form)) {
    const v = t?.config?.[input.dataset.cfg];
    if (input.type === 'checkbox') input.checked = !!v;
    else if (v != null) input.value = v;
    if (input.dataset.secret !== undefined) {
      input.placeholder = t?.config?.[`${input.dataset.cfg}Set`] ? '•••••• (unchanged)' : '';
    }
  }
  $('#target-dialog').showModal();
}
$('#new-target').addEventListener('click', () => openTargetDialog());

$('#target-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const type = $('#t-type').value;
  const config = {};
  for (const input of $$(`.type-fields[data-type="${type}"] [data-cfg]`)) {
    config[input.dataset.cfg] = input.type === 'checkbox' ? input.checked : input.type === 'number' ? Number(input.value) : input.value.trim();
  }
  const body = { type, name: $('#t-name').value.trim(), zone: $('#t-zone').value.trim(), config };
  try {
    if (editingTarget) await api(`/targets/${editingTarget.id}`, { method: 'PUT', body });
    else await api('/targets', { method: 'POST', body });
    $('#target-dialog').close();
    await loadTargets();
    toast('Target saved.');
  } catch (err) {
    $('#target-error').textContent = err.message;
  }
});

// ---------- records
async function loadRecords() {
  state.records = await api('/records');
  const tbody = $('#records-table tbody');
  tbody.replaceChildren(
    ...state.records.map((r) => {
      const status = !r.enabled ? 'disabled' : r.state?.status || 'pending';
      return h(
        'tr',
        {},
        h('td', {}, h('div', { class: 'mono' }, r.name === '@' ? r.target.zone : `${r.name}.${r.target.zone}`), h('div', { class: 'muted' }, `${r.families} · ${r.count} IPs`)),
        h('td', {}, r.target.name, h('div', { class: 'muted' }, r.target.type)),
        h('td', { class: 'muted' }, r.sections.join(', ')),
        h('td', {}, h('div', { class: 'ips mono' }, (r.state?.ips || []).map((ip) => h('span', { class: 'chip' }, ip)))),
        h('td', { class: 'nowrap' }, `${r.ttl}s / ${fmtDur(r.intervalSec)}`, h('div', { class: 'muted' }, r.enabled ? `next ${fmtShort(r.nextRotationAt)}` : '')),
        h(
          'td',
          {},
          h('span', { class: status === 'ok' ? 'status-ok' : status === 'error' ? 'status-error' : 'status-info' }, status),
          r.state?.error ? h('div', { class: 'muted' }, r.state.error) : null,
          r.lastRotatedAt ? h('div', { class: 'muted nowrap', title: fmtTime(r.lastRotatedAt) }, `at ${fmtShort(r.lastRotatedAt)}`) : null
        ),
        h(
          'td',
          { class: 'actions-cell' },
          h('button', { type: 'button', onclick: (e) => rotateNow(r, e.currentTarget) }, 'Rotate now'),
          h('button', { type: 'button', onclick: () => openRecordDialog(r) }, 'Edit'),
          h('button', { type: 'button', class: 'danger', onclick: () => deleteRecord(r) }, 'Delete')
        )
      );
    })
  );
  $('#records-empty').hidden = state.records.length > 0;
}

function rotateNow(r, btn) {
  return busy(btn, async () => {
    try {
      const res = await api(`/records/${r.id}/rotate`, { method: 'POST' });
      toast(res.ok ? `${r.name}: ${res.ips.join(', ')}` : `${r.name}: ${res.error}`, !res.ok);
      await loadRecords();
    } catch (err) {
      toast(err.message, true);
    }
  });
}

async function deleteRecord(r) {
  if (!confirm(`Delete record "${r.name}" and remove it from DNS?`)) return;
  try {
    await api(`/records/${r.id}`, { method: 'DELETE' });
    await loadRecords();
    toast('Record deleted.');
  } catch (err) {
    toast(err.message, true);
  }
}

let editingRecord = null;
function openRecordDialog(r = null) {
  if (!state.targets.length) return toast('Create a target first.', true);
  editingRecord = r;
  const form = $('#record-form');
  form.reset();
  $('#record-error').textContent = '';
  $('#r-preview').replaceChildren();
  $('#record-dialog-title').textContent = r ? `Edit record: ${r.name}` : 'New record';
  $('#r-target').replaceChildren(...state.targets.map((t) => h('option', { value: t.id }, `${t.name} (${t.type} · ${t.zone})`)));
  const selected = new Set(r?.sections || ['web']);
  $('#r-sections').replaceChildren(
    ...state.sections.map((s) =>
      h(
        'label',
        { class: 'check' },
        h('input', { type: 'checkbox', name: 'sections', value: s.name, checked: selected.has(s.name) }),
        s.name,
        h('span', { class: 'muted' }, ` ${s.v4}·v4 ${s.v6}·v6`)
      )
    )
  );
  if (state.limits) {
    $('#r-count').max = state.limits.maxCount;
    $('#r-ttl').min = state.limits.minTtl;
    $('#r-interval').min = state.limits.minInterval;
  }
  if (r) {
    $('#r-name').value = r.name;
    $('#r-target').value = r.targetId;
    $('#r-families').value = r.families;
    $('#r-count').value = r.count;
    $('#r-ttl').value = r.ttl;
    $('#r-interval').value = r.intervalSec;
    $('#r-enabled').checked = r.enabled;
  } else {
    $('#r-families').value = 'v4';
  }
  $('#record-dialog').showModal();
}
$('#new-record').addEventListener('click', () => openRecordDialog());

function recordBody() {
  return {
    name: $('#r-name').value.trim(),
    targetId: Number($('#r-target').value),
    sections: $$('#r-sections input:checked').map((i) => i.value),
    families: $('#r-families').value,
    count: Number($('#r-count').value),
    ttl: Number($('#r-ttl').value),
    intervalSec: Number($('#r-interval').value),
    enabled: $('#r-enabled').checked,
  };
}

$('#r-preview-btn').addEventListener('click', async () => {
  const b = recordBody();
  const out = $('#r-preview');
  try {
    const p = await api('/preview', { method: 'POST', body: { sections: b.sections, families: b.families, count: b.count } });
    out.replaceChildren(
      h('div', { class: 'muted' }, `Pool: ${p.poolSize} CIDRs (${p.poolV4} v4, ${p.poolV6} v6). Sample pick:`),
      h('div', { class: 'ips mono' }, [...p.a, ...p.aaaa].map((ip) => h('span', { class: 'chip' }, ip)))
    );
  } catch (err) {
    out.replaceChildren(h('span', { class: 'error' }, err.message));
  }
});

$('#record-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const submit = e.submitter || $('#record-form button[type="submit"]');
  await busy(submit, async () => {
    try {
      const body = recordBody();
      const res = editingRecord
        ? await api(`/records/${editingRecord.id}`, { method: 'PUT', body })
        : await api('/records', { method: 'POST', body });
      $('#record-dialog').close();
      await loadRecords();
      if (res.result && !res.result.ok) toast(`Saved, but publish failed: ${res.result.error}`, true);
      else toast('Record saved.');
    } catch (err) {
      $('#record-error').textContent = err.message;
    }
  });
});

for (const btn of $$('dialog [data-close]')) btn.addEventListener('click', () => btn.closest('dialog').close());

// ---------- logs
async function loadLogs() {
  const logs = await api('/logs');
  $('#logs-table tbody').replaceChildren(
    ...logs.map((l) =>
      h(
        'tr',
        {},
        h('td', { class: 'muted' }, fmtTime(l.at)),
        h('td', { class: 'mono' }, l.recordName || '—'),
        h('td', {}, h('span', { class: `status-${l.result}` }, l.result)),
        h('td', { class: 'mono' }, l.ips ? l.ips.join(', ') : '', l.message ? h('div', { class: 'muted' }, l.message) : null)
      )
    )
  );
}
$('#reload-logs').addEventListener('click', loadLogs);

// ---------- boot
let pollTimer;
async function boot() {
  try {
    const s = await api('/session');
    state.limits = s.limits;
  } catch {
    return showLogin();
  }
  $('#login-view').hidden = true;
  $('#app-view').hidden = false;
  await Promise.all([loadMeta(), loadTargets(), loadRecords()]).catch((e) => toast(e.message, true));
  clearInterval(pollTimer);
  pollTimer = setInterval(() => {
    if ($('#app-view').hidden || document.hidden) return;
    loadRecords().catch(() => {});
    loadMeta().catch(() => {});
  }, 30000);
}
boot();
