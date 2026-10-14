export async function fetchLogoForSlug(slug, { createTab, waitForTabLoad, sleep, signal, onTabOpened }) {
  function checkAbort() {
    if (signal?.aborted) {
      const err = new Error('Logo fetch stopped by user');
      err.name = 'ScanStoppedError';
      throw err;
    }
  }

  // Same reasoning as scan-runner.js's raceWithAbort: the tab is force-closed
  // the instant Stop is clicked, but a pending waitForTabLoad/sleep/
  // executeScript for that now-closed tab does not reject immediately on its
  // own - it only settles once Chrome's extension API notices, which lags
  // visibly. Wrapping the await in the abort signal interrupts it at once.
  function raceWithAbort(promise) {
    if (!signal) return promise;
    if (signal.aborted) return Promise.reject(Object.assign(new Error('Logo fetch stopped by user'), { name: 'ScanStoppedError' }));
    return new Promise((resolve, reject) => {
      const onAbort = () => reject(Object.assign(new Error('Logo fetch stopped by user'), { name: 'ScanStoppedError' }));
      signal.addEventListener('abort', onAbort, { once: true });
      promise.then(
        v => { signal.removeEventListener('abort', onAbort); resolve(v); },
        e => { signal.removeEventListener('abort', onAbort); reject(e); }
      );
    });
  }

  const url = `https://www.linkedin.com/company/${slug}/`;
  const tab = await createTab(url);
  onTabOpened?.(tab.id);
  try {
    checkAbort();
    await raceWithAbort(waitForTabLoad(tab.id));
    await raceWithAbort(sleep(1000));
    checkAbort();
    let logoUrl = null;
    // Trimmed from 3 attempts/1s gaps to 2/600ms: the alt-text selector below
    // is reliable on a loaded page (unlike the old dead CSS-class selectors
    // this replaced), so the retry loop only needs to cover a logo image
    // still lazy-loading its data-delayed-url right after page load, not
    // genuine selector flakiness.
    for (let attempt = 0; attempt < 2 && !logoUrl; attempt++) {
      checkAbort();
      if (attempt > 0) await raceWithAbort(sleep(600));
      try {
        const res = await raceWithAbort(chrome.scripting.executeScript({
          target: { tabId: tab.id },
          args: [slug],
          func: (companySlug) => {
            // LinkedIn's company page no longer exposes stable CSS classes on
            // the logo image (confirmed against a real saved company page,
            // Oct 2026 - every org-top-card-* selector matched nothing). The
            // reliable signal is the img's own alt text, which LinkedIn always
            // renders as "View company: <Name>" on the real uploaded logo
            // image, cross-checked against the enclosing link pointing back
            // to this exact company's own /company/<slug>/ page (so a
            // same-page "affiliated pages" or "people also viewed" card for a
            // DIFFERENT company can never be picked up by mistake). A company
            // with no uploaded logo renders an SVG placeholder instead of an
            // <img> here, so this naturally returns null for those, not a
            // wrong/default graphic.
            const candidates = Array.from(document.querySelectorAll('img[alt^="View company:"]'));
            for (const img of candidates) {
              const href = img.closest('a')?.href || '';
              if (!href.includes(`/company/${companySlug}/`)) continue;
              for (const val of [img.src, img.getAttribute('data-delayed-url'), img.getAttribute('data-src')]) {
                if (val && val.includes('media.licdn.com') && !val.includes('ghost') && !val.includes('data:')) {
                  return val;
                }
              }
            }

            for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
              try {
                const d = JSON.parse(s.textContent);
                const val = d?.logo || d?.image;
                const u = typeof val === 'string' ? val : val?.url;
                if (u && u.includes('licdn.com')) return u;
              } catch (e) {}
            }
            return null;
          }
        }));
        logoUrl = res[0]?.result || null;
      } catch (_) {}
    }
    chrome.tabs.remove(tab.id).catch(() => {});
    return logoUrl;
  } catch (err) {
    chrome.tabs.remove(tab.id).catch(() => {});
    throw err;
  }
}
