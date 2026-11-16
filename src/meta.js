import { ipSections } from './picker.js';

export function createMetaFetcher({ repo, url, token, fetchImpl = globalThis.fetch, logger = console }) {
  async function refresh() {
    const prev = repo.latestMeta();
    const headers = {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'github-meta-dns-pool',
      'X-GitHub-Api-Version': '2022-11-28',
    };
    if (prev?.etag) headers['If-None-Match'] = prev.etag;
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetchImpl(url, { headers });
    if (res.status === 304 && prev) {
      repo.touchMeta();
      return { changed: false, meta: prev.json };
    }
    if (!res.ok) throw new Error(`GitHub meta fetch failed: HTTP ${res.status}`);
    const json = await res.json();
    if (!ipSections(json).length) throw new Error('GitHub meta response contained no IP sections');
    const changed = !prev || JSON.stringify(prev.json) !== JSON.stringify(json);
    repo.saveMeta(json, res.headers.get('etag'));
    logger.info?.(`[meta] refreshed (${changed ? 'changed' : 'unchanged'})`);
    return { changed, meta: json };
  }

  function current() {
    return repo.latestMeta();
  }

  return { refresh, current };
}
