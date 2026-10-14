// company-id-resolver.js - companyId resolution + companyId-scoped global search.
//
// Fallback for when the company's People tab itself is scraped as structurally
// broken (zero raw cards returned, not just zero recruiter-titled cards, see
// runScraper in scan-runner.js). LinkedIn's People-tab DOM has changed before;
// a global people-search scoped by the `currentCompany` facet is a different,
// more stable surface, so it survives a People-tab layout change.
//
// Ported from the same technique already used by this project's LinkedIn
// Networking MCP tools (route B / resolveCompanyIdForSlug): read three
// independent DOM anchors on the company page, require 2 of 3 to agree on the
// same numeric ID before trusting it, never guess.

const COMPANY_ID_CACHE_KEY = 'companyIdCache';

function getCompanyIdCache() {
  return new Promise(r => chrome.storage.local.get([COMPANY_ID_CACHE_KEY], d => r(d[COMPANY_ID_CACHE_KEY] || {})));
}

async function setCachedCompanyId(slug, companyId) {
  const cache = await getCompanyIdCache();
  cache[slug] = { companyId, resolvedAt: Date.now() };
  return new Promise(r => chrome.storage.local.set({ [COMPANY_ID_CACHE_KEY]: cache }, r));
}

export async function getCachedCompanyId(slug) {
  const cache = await getCompanyIdCache();
  return cache[slug]?.companyId || null;
}

// Runs inside the page via chrome.scripting.executeScript. Reads the same
// three section anchors LinkedIn's own company page renders, by id first
// (componentkey as fallback), same pattern as the MCP tool's extractCompanyIdCandidates.
function extractCompanyIdCandidates() {
  const readAttr = (el, attr, pattern) => {
    const value = el?.getAttribute(attr) || '';
    const match = value.match(pattern);
    return match ? match[1] : null;
  };
  const read = (attrPrefix, pattern) => {
    const byId = document.querySelector(`[id^="${attrPrefix}"]`);
    const idMatch = readAttr(byId, 'id', pattern);
    if (idMatch) return idMatch;
    const byKey = document.querySelector(`[componentkey^="${attrPrefix}"]`);
    return readAttr(byKey, 'componentkey', pattern);
  };
  return {
    topCard: read('pages.topCard.', /^pages\.topCard\.(\d+)$/),
    followDrawer: read('organizationFollowDrawer-', /^organizationFollowDrawer-(\d+)$/),
    leaders: read('meetTheLeadersSection-', /^meetTheLeadersSection-(\d+)$/),
  };
}

// Promise race helper identical in purpose to the one in scan-runner.js: a
// force-closed tab does not make a pending waitForTabLoad/sleep reject right
// away, so wrap those awaits directly in the abort signal instead of only
// checking signal.aborted between them.
function raceWithAbort(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(Object.assign(new Error('Scan stopped by user'), { name: 'ScanStoppedError' }));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(Object.assign(new Error('Scan stopped by user'), { name: 'ScanStoppedError' }));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      v => { signal.removeEventListener('abort', onAbort); resolve(v); },
      e => { signal.removeEventListener('abort', onAbort); reject(e); }
    );
  });
}

// Resolves and caches the numeric company ID for a slug. Returns null (never a
// guess) when fewer than 2 of the 3 anchors agree. Navigates the caller's
// existing tab (same one runScraper already opened for the People-tab attempt)
// instead of opening a separate background tab.
export async function resolveCompanyId(slug, tabId, { navigateTab, waitForTabLoad, sleep, signal }) {
  const cached = await getCachedCompanyId(slug);
  if (cached) return cached;

  const url = `https://www.linkedin.com/company/${encodeURIComponent(slug)}/home/`;
  await navigateTab(tabId, url);
  await raceWithAbort(waitForTabLoad(tabId), signal);
  await raceWithAbort(sleep(2500), signal);

  const res = await raceWithAbort(chrome.scripting.executeScript({
    target: { tabId },
    func: extractCompanyIdCandidates,
  }), signal);
  const extracted = res[0]?.result || { topCard: null, followDrawer: null, leaders: null };

  const values = [extracted.topCard, extracted.followDrawer, extracted.leaders].filter(Boolean);
  const counts = new Map();
  for (const v of values) counts.set(v, (counts.get(v) || 0) + 1);
  let bestId = null;
  let bestCount = 0;
  for (const [id, count] of counts) {
    if (count > bestCount) { bestId = id; bestCount = count; }
  }

  if (bestId && bestCount >= 2) {
    await setCachedCompanyId(slug, bestId);
    return bestId;
  }
  return null;
}

// Global people-search scoped by the currentCompany facet. Company name is
// dropped from the keyword text since the facet already scopes results to the
// exact company, matches the MCP tool's buildSearchUrl behavior.
function buildCompanyScopedSearchUrl(keyword, companyId, page = 0) {
  const start = page * 10;
  const q = encodeURIComponent(keyword);
  return (
    `https://www.linkedin.com/search/results/people/` +
    `?keywords=${q}` +
    `&currentCompany=%5B%22${encodeURIComponent(companyId)}%22%5D` +
    `&origin=FACETED_SEARCH&start=${start}`
  );
}

// Scrapes global search-result cards. Verified directly against a real saved
// search-results page (jsdom test against actual captured HTML, Oct 2026),
// not assumed - every prior version of this function was tested only against
// assumptions about the markup and broke on real cards.
//
// Two confirmed facts about the real markup:
// 1. role="listitem" marks each card's boundary, no stable class names exist
//    (fully hashed CSS classes).
// 2. A card's own subject has MULTIPLE a[href="/in/..."] anchors pointing to
//    their own profile (outer card-wrapping anchor + inner name anchor + any
//    other same-profile refs), while a mutual-connection's name/avatar link
//    inside the same card points to a DIFFERENT profile and appears only
//    once. Picking "the last anchor" (a prior version of this function) or
//    "the first anchor" both pick up a mutual connection's link on any card
//    that has a mutual-connections line, misidentifying that connection as
//    the card's subject and losing the real person entirely. The correct,
//    verified signal is: the card's real subject is whichever href repeats
//    most often among that card's anchors.
function scrapeGlobalSearchResults() {
  const items = [];
  const seen = new Set();

  const outerCards = document.querySelectorAll('[role="listitem"]');

  for (const outerCard of outerCards) {
    const anchors = Array.from(outerCard.querySelectorAll('a[href*="/in/"]'));
    if (anchors.length === 0) continue;

    const hrefCounts = new Map();
    for (const a of anchors) {
      const href = a.href.split('?')[0].replace(/\/$/, '') + '/';
      hrefCounts.set(href, (hrefCounts.get(href) || 0) + 1);
    }
    let url = null;
    let bestCount = 0;
    for (const [href, count] of hrefCounts) {
      if (count > bestCount) { url = href; bestCount = count; }
    }
    if (!url || seen.has(url)) continue;

    // The inner (clean) name anchor matching that href: the one whose own
    // direct children include real text, not the outer card-wrapping anchor
    // (which nests everything several levels deep with no direct text).
    const nameLink = anchors.find(a => {
      const href = a.href.split('?')[0].replace(/\/$/, '') + '/';
      if (href !== url) return false;
      return Array.from(a.childNodes).some(
        n => n.nodeType === Node.TEXT_NODE && n.textContent.trim().length > 1
      );
    });
    if (!nameLink) continue;

    const nameTextNode = Array.from(nameLink.childNodes).find(
      n => n.nodeType === Node.TEXT_NODE && n.textContent.trim().length > 1
    );
    const name = (nameTextNode?.textContent || '').trim();
    if (!name || name.length < 2) continue;

    seen.add(url);

    // Pending (a connection request already sent) no longer excludes the
    // card outright - it's tagged instead, so a person you already reached
    // out to still shows up in results rather than silently disappearing.
    const cardText = outerCard.innerText || outerCard.textContent || '';
    const isPending = cardText.includes('Pending');

    // Scope paragraph extraction to the name link's own containing block
    // (its parent's parent, the small wrapper that holds exactly the name
    // <p>, title <p>, and location <p>), not the whole outer card, so the
    // mutual-connections line, Message button, and AI-snippet paragraph
    // never enter this list.
    const fieldsContainer = nameLink.closest('p')?.parentElement || outerCard;
    const isDegreeOnly = t => /^[•·]?\s*(1st|2nd|3rd\+?)$/i.test(t);
    const paragraphs = Array.from(fieldsContainer.querySelectorAll('p'))
      .map(p => (p.textContent || '').trim())
      .filter(Boolean);
    const contentParas = paragraphs.filter(t => !t.startsWith(name) && !isDegreeOnly(t));
    const title = contentParas[0] || '';
    const location = contentParas[1] || '';

    const img = outerCard.querySelector('img[src*="licdn.com"], img[src*="media.licdn"]');
    const photoUrl = (img?.src && !img.src.includes('ghost')) ? img.src : '';

    items.push({ name, title, location, url, photoUrl, pending: isPending });
  }
  return items;
}

// Runs the companyId-scoped global search for one keyword, paginating up to
// maxPages (10 cards/page, same as LinkedIn's own global search). Stops early
// once a page returns no new cards (LinkedIn repeats the last page past the
// real result count rather than returning empty). Reuses the caller's
// existing tab instead of opening a new one per page.
export async function searchByCompanyId(companyId, keyword, tabId, { navigateTab, waitForTabLoad, sleep, signal }, maxPages = 3) {
  const seen = new Set();
  const all = [];

  for (let page = 0; page < maxPages; page++) {
    if (signal?.aborted) throw Object.assign(new Error('Scan stopped by user'), { name: 'ScanStoppedError' });
    const url = buildCompanyScopedSearchUrl(keyword, companyId, page);
    await navigateTab(tabId, url);
    await raceWithAbort(waitForTabLoad(tabId), signal);
    await raceWithAbort(sleep(2000), signal);
    const res = await raceWithAbort(chrome.scripting.executeScript({
      target: { tabId },
      func: scrapeGlobalSearchResults,
    }), signal);
    const pageResults = res[0]?.result || [];

    let newCount = 0;
    for (const r of pageResults) {
      if (!seen.has(r.url)) {
        seen.add(r.url);
        all.push(r);
        newCount++;
      }
    }

    if (newCount === 0) break;
    if (page < maxPages - 1) await raceWithAbort(sleep(1500), signal);
  }

  return all;
}
