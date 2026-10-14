import { searchLinkedInCompanies } from './company-search.js';
import { runScraper } from './scan-runner.js';
import { fetchLogoForSlug } from './logo-fetch.js';
import { autoScrollAndScrape, autoScrollAndScrapeWithHiringFrame } from './people-scrapers.js';
import { resolveCompanyId, searchByCompanyId } from './company-id-resolver.js';

// background.js � Service worker that orchestrates everything

// -- Side panel setup ----------------------------------------------------------

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});

chrome.action.onClicked.addListener(tab => {
  chrome.sidePanel.open({ tabId: tab.id }).catch(() => {});
});


// -- Recruiter filter patterns -------------------------------------------------

const SEARCH_QUERY = 'technical,recruiter,recruiting,talent,people,hiring,coordinator';

const RECRUITER_TITLE_PATTERNS = [
  /\brecruit/i,
  /\brecruiting\b/i,
  /\btalent\b/i,
  /\bsourc/i,
  /\brecruiting\s*coord/i,
  /\btalent\s*coord/i,
  /\bhr\s*coord/i,
  /\bpeople\s*coord/i,
  /\bacquisition\b/i,
];

const EXCLUDE_TITLE_PATTERNS = [
  /engineer/i,
  /software/i,
  /developer/i,
  /designer/i,
  /executive/i,
  /analyst/i,
  /marketing/i,
  /sales/i,
  /product/i,
  /finance/i,
  /legal/i,
  /\bdata\b/i,
  /devops/i,
  /network/i,
  /security/i,
  /customer/i,
  /account\s+exec/i,
  /deployment/i,
  /training/i,
  /writer/i,
  /payroll/i,
];

function isRecruiter(title) {
  if (!title || title.trim() === '') return false;
  const allowed = RECRUITER_TITLE_PATTERNS.some(p => p.test(title));
  if (!allowed) return false;
  const excluded = EXCLUDE_TITLE_PATTERNS.some(p => p.test(title));
  return !excluded;
}

// -- Cache helpers -------------------------------------------------------------

const CACHE_KEY = 'recruiterHistory';

function getStoredCache() {
  return new Promise(r => chrome.storage.local.get([CACHE_KEY], d => r(d[CACHE_KEY] || {})));
}

async function saveToStoredCache(slug, recruiters, logoUrl) {
  const cache = await getStoredCache();
  cache[slug] = {
    recruiters, logoUrl,
    scannedAt: Date.now(),
    displayName: cache[slug]?.displayName || slug.replace(/-/g, ' ')
  };
  return new Promise(r => chrome.storage.local.set({ [CACHE_KEY]: cache }, r));
}

// -- Auto-scan queue (runs even with panel closed) -----------------------------

const activeScans = new Map();  // slug -> { controller: AbortController } for scans currently running (manual or auto)
const autoQueue   = [];         // slugs waiting for auto-scan
let   autoWorking = false;
let   activeLogoFetch = null;   // { controller, tabId } for the single in-flight Refresh Logos fetch, or null

// Used throughout runScraper/scan helpers to bail out early at the next
// await boundary once a scan has been stopped. Throwing a distinct error type
// (rather than returning a sentinel) lets every caller's existing try/catch
// handle it uniformly without extra per-call-site checks.
class ScanStoppedError extends Error {
  constructor() { super('Scan stopped by user'); this.name = 'ScanStoppedError'; }
}

async function processAutoQueue() {
  if (autoWorking) return;
  autoWorking = true;
  while (autoQueue.length > 0) {
    const slug = autoQueue.shift();
    if (activeScans.has(slug)) continue; // already being scanned manually
    const controller = new AbortController();
    activeScans.set(slug, { controller });
    chrome.storage.session.set({ autoScanSlug: slug, autoScanQueue: [...autoQueue] }).catch(() => {});
    try {
      const { recruiters, logoUrl } = await runScraper(slug, {
        createTab,
        waitForTabLoad,
        sleep,
        navigateTab,
        scrapeTab,
        scrapeTabWithHiringFrame,
        isRecruiter,
        SEARCH_QUERY,
        resolveCompanyId,
        searchByCompanyId,
        signal: controller.signal,
      });
      if (recruiters.length > 0) await saveToStoredCache(slug, recruiters, logoUrl);
      chrome.runtime.sendMessage({ action: 'scanComplete', companySlug: slug, count: recruiters.length }).catch(() => {});
    } catch (e) {}
    activeScans.delete(slug);
  }
  chrome.storage.session.set({ autoScanSlug: null, autoScanQueue: [] }).catch(() => {});
  autoWorking = false;
}

function enqueueAutoScan(slug) {
  if (activeScans.has(slug) || autoQueue.includes(slug)) return;
  autoQueue.push(slug);
  chrome.storage.session.set({ autoScanQueue: [...autoQueue] }).catch(() => {});
  processAutoQueue();
}

// -- Watch for LinkedIn job URL changes (works with panel closed) --------------

let lastAutoUrl = '';

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (!changeInfo.url) return;
  if (changeInfo.url === lastAutoUrl) return;
  if (!changeInfo.url.includes('linkedin.com/jobs')) return;
  lastAutoUrl = changeInfo.url;

  const { autoScanEnabled } = await new Promise(r => chrome.storage.local.get(['autoScanEnabled'], r));
  if (!autoScanEnabled) return;

  setTimeout(async () => {
    let slug = null;
    try {
      const res = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          const sels = [
            '.job-details-jobs-unified-top-card__company-name a',
            '.jobs-unified-top-card__company-name a',
            '.jobs-details-top-card__company-url',
            '.topcard__org-name-link',
            '.job-details-jobs-unified-top-card__primary-description-without-tagline a[href*="/company/"]',
          ];
          for (const sel of sels) {
            const el = document.querySelector(sel);
            if (!el?.href) continue;
            const m = el.href.match(/\/company\/([^/?#]+)/);
            if (!m) continue;
            const s = m[1].toLowerCase().replace(/\/$/, '').split('?')[0];
            if (!['linkedin', 'jobs', 'showcase'].includes(s)) return s;
          }
          const pane = document.querySelector(
            '.jobs-search__job-details--wrapper, .scaffold-layout__detail, .job-view-layout, .jobs-details'
          );
          if (pane) {
            for (const el of pane.querySelectorAll('a[href*="/company/"]')) {
              const r = el.getBoundingClientRect();
              if (!r.width || !r.height) continue;
              const m = el.href.match(/\/company\/([^/?#]+)/);
              if (!m) continue;
              const s = m[1].toLowerCase().replace(/\/$/, '').split('?')[0];
              if (!['linkedin', 'jobs', 'showcase'].includes(s)) return s;
            }
          }
          return null;
        }
      });
      slug = res[0]?.result;
    } catch (e) {}

    if (!slug) return;
    const cache = await getStoredCache();
    if (cache[slug]) return; // already cached
    enqueueAutoScan(slug);
  }, 1000);
});

// -- Manual scan entry point ---------------------------------------------------

chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  if (request.action === 'start') {
    const slug = request.companySlug;
    const controller = new AbortController();
    const scanEntry = { controller, tabId: null };
    activeScans.set(slug, scanEntry);
    // Track in session so popup can recover if the panel is closed mid-scan
    chrome.storage.session.set({ manualScanSlug: slug, manualScanDone: false, manualScanError: false }).catch(() => {});
    runScraper(slug, {
      createTab,
      waitForTabLoad,
      sleep,
      navigateTab,
      scrapeTab,
      scrapeTabWithHiringFrame,
      isRecruiter,
      SEARCH_QUERY,
      resolveCompanyId,
      searchByCompanyId,
      signal: controller.signal,
      onTabOpened: tabId => { scanEntry.tabId = tabId; },
    })
      .then(async ({ recruiters, logoUrl }) => {
        activeScans.delete(slug);
        // Always persist to local cache so results survive panel close/reopen
        if (recruiters.length > 0) await saveToStoredCache(slug, recruiters, logoUrl);
        chrome.storage.session.set({ manualScanDone: true, manualScanLogoUrl: logoUrl || null }).catch(() => {});
        sendResponse({ success: true, data: recruiters, logoUrl });
      })
      .catch(err => {
        activeScans.delete(slug);
        const stopped = err?.name === 'ScanStoppedError';
        // Deliberately not saving anything to cache on a user-initiated stop -
        // partial results are discarded, the panel reverts to whatever was
        // cached before this scan started (see scanner.js).
        chrome.storage.session.set({ manualScanDone: true, manualScanError: !stopped }).catch(() => {});
        sendResponse({ success: false, error: err.message, stopped });
      });
    return true;
  }

  if (request.action === 'stop') {
    const slug = request.companySlug;
    const entry = activeScans.get(slug);
    if (!entry) {
      sendResponse({ success: false, error: 'No active scan for this company' });
      return true;
    }
    entry.controller.abort();
    // Close the tab immediately rather than waiting for the aborted promise
    // chain to unwind - the scan may be mid-await on a page load that won't
    // check the abort signal again until that await resolves.
    if (entry.tabId != null) chrome.tabs.remove(entry.tabId).catch(() => {});
    sendResponse({ success: true });
    return true;
  }

  if (request.action === 'fetchLogo') {
    const controller = new AbortController();
    activeLogoFetch = { controller, tabId: null };
    fetchLogoForSlug(request.companySlug, {
      createTab,
      waitForTabLoad,
      sleep,
      signal: controller.signal,
      onTabOpened: tabId => { if (activeLogoFetch) activeLogoFetch.tabId = tabId; },
    })
      .then(logoUrl => { activeLogoFetch = null; sendResponse({ logoUrl }); })
      .catch(() => { activeLogoFetch = null; sendResponse({ logoUrl: null }); });
    return true;
  }

  if (request.action === 'stopLogoFetch') {
    if (activeLogoFetch) {
      activeLogoFetch.controller.abort();
      // Close the tab immediately rather than waiting for the aborted promise
      // to unwind, same reasoning as the main scan stop handler above: the
      // fetch may be mid-await on a page load that won't re-check the signal
      // until that load resolves on its own.
      if (activeLogoFetch.tabId != null) chrome.tabs.remove(activeLogoFetch.tabId).catch(() => {});
      activeLogoFetch = null;
    }
    sendResponse({ success: true });
    return true;
  }

  if (request.action === 'searchCompanies') {
    searchLinkedInCompanies(request.companyName, { createTab, waitForTabLoad, sleep })
      .then(companies => sendResponse({ success: true, companies }))
      .catch(() => sendResponse({ success: false, companies: [] }));
    return true;
  }
});

// -- Helpers -------------------------------------------------------------------

function createTab(url) {
  return new Promise(resolve => chrome.tabs.create({ url, active: false }, resolve));
}

function navigateTab(tabId, url) {
  return new Promise(resolve => chrome.tabs.update(tabId, { url }, resolve));
}

function waitForTabLoad(tabId) {
  return new Promise(resolve => {
    const timeout = setTimeout(resolve, 15000);
    function listener(id, info) {
      if (id === tabId && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        clearTimeout(timeout);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId, tab => {
      if (tab && tab.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        clearTimeout(timeout);
        resolve();
      }
    });
  });
}

async function scrapeTab(tabId, maxPeople = 80) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: autoScrollAndScrape,
    args: [maxPeople],
  });
  return results[0]?.result || [];
}

// -- NEW: separate scrape function for #Hiring frame detection -----------------
// Completely isolated � only called when filtered.length === 0
async function scrapeTabWithHiringFrame(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: autoScrollAndScrapeWithHiringFrame,
  });
  return results[0]?.result || [];
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
