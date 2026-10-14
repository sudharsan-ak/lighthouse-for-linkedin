export async function runScraper(companySlug, deps) {
  const {
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
    signal,
    onTabOpened,
  } = deps;

  // Throws if the caller requested a stop. Called at every major await
  // boundary (after each page load/search/keyword) so a stop takes effect
  // promptly instead of only between whole scan phases.
  function checkAbort() {
    if (signal?.aborted) {
      const err = new Error('Scan stopped by user');
      err.name = 'ScanStoppedError';
      throw err;
    }
  }

  // A plain checkAbort() between awaits is not enough on its own: the tab is
  // force-closed the instant Stop is clicked (background.js's 'stop' handler),
  // but a pending await on waitForTabLoad/sleep for that now-closed tab does
  // not reject immediately - it only settles whenever Chrome's extension API
  // gets around to noticing the tab is gone, which can take several seconds
  // and is what made the Stop button visibly linger on "Stopping...". This
  // wraps a promise so the abort signal itself interrupts it immediately,
  // regardless of what the wrapped promise is doing.
  function raceWithAbort(promise) {
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

  const peopleBaseUrl = `https://www.linkedin.com/company/${companySlug}/people/?facetGeoRegion=103644278`;

  const tab = await createTab(peopleBaseUrl);
  const tabId = tab.id;
  onTabOpened?.(tabId);

  try {
    checkAbort();
    await raceWithAbort(waitForTabLoad(tabId));
    await raceWithAbort(sleep(1500));
    checkAbort();

    let logoUrl = null;
    for (let attempt = 0; attempt < 3 && !logoUrl; attempt++) {
      checkAbort();
      if (attempt > 0) await raceWithAbort(sleep(1000));
      try {
        const logoResult = await raceWithAbort(chrome.scripting.executeScript({
          target: { tabId },
          func: () => {
            function getLicdnUrl(img) {
              if (!img) return null;
              if (img.closest('#global-nav, [class*="global-nav"], nav[aria-label]')) return null;
              for (const val of [img.src, img.getAttribute('data-delayed-url'), img.getAttribute('data-src')]) {
                if (val && val.includes('media.licdn.com') && !val.includes('ghost') && !val.includes('data:')) {
                  return val;
                }
              }
              return null;
            }

            const url1 = getLicdnUrl(document.querySelector('img.org-top-card-primary-content__logo'));
            if (url1) return url1;

            for (const sel of [
              '.org-top-card-primary-content__logo-container img[alt$=" logo"]',
              '[class*="org-top-card"] img[alt$=" logo"]',
            ]) {
              const url2 = getLicdnUrl(document.querySelector(sel));
              if (url2) return url2;
            }

            for (const sel of [
              'img.org-top-card__logo',
              'img.org-top-card-summary__logo',
              '[data-test-id="org-entity-logo"] img',
              '.org-top-card-primary-content__logo-container img',
            ]) {
              const url3 = getLicdnUrl(document.querySelector(sel));
              if (url3) return url3;
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
        logoUrl = logoResult[0]?.result || null;
      } catch (_) {}
    }

    checkAbort();
    chrome.storage.session.set({ status: 'Searching for recruiters...', progress: 1, total: 1 });

    const searchUrl = `${peopleBaseUrl}&keywords=${encodeURIComponent(SEARCH_QUERY)}`;
    await navigateTab(tabId, searchUrl);
    await raceWithAbort(waitForTabLoad(tabId));
    await raceWithAbort(sleep(1800));
    checkAbort();

    let results = await raceWithAbort(scrapeTab(tabId));
    let filtered = results.filter(r => isRecruiter(r.title));

    // Raw scrape returned nothing at all (not just zero recruiter-titled cards).
    // This is the structural-breakage signal, not a thin-pool signal: it means
    // the People-tab selectors likely stopped matching, since even a genuinely
    // recruiter-free company page still returns some raw cards. A thin pool
    // (results.length > 0 but filtered.length < 5) is unaffected by this branch
    // and keeps using the existing keyword-retry path below as before.
    if (results.length === 0 && resolveCompanyId && searchByCompanyId) {
      checkAbort();
      chrome.storage.session.set({ status: 'People tab returned nothing, trying company-ID search...' });
      const companyId = await resolveCompanyId(companySlug, tabId, { navigateTab, waitForTabLoad, sleep, signal });
      if (companyId) {
        const seen = new Set();
        const idResults = [];
        for (const kw of ['recruiter', 'talent acquisition', 'technical sourcer']) {
          checkAbort();
          const kwResults = await searchByCompanyId(companyId, kw, tabId, { navigateTab, waitForTabLoad, sleep, signal });
          for (const r of kwResults) {
            if (isRecruiter(r.title) && !seen.has(r.url)) {
              seen.add(r.url);
              idResults.push(r);
            }
          }
        }
        console.log(`[companyId fallback] ${companySlug}: companyId ${companyId}, found ${idResults.length} recruiters`);
        if (idResults.length > 0) {
          results = idResults;
          filtered = idResults;
        }
      }
    }

    if (filtered.length < 5 && results.length > 0) {
      checkAbort();
      chrome.storage.session.set({ status: `Only ${filtered.length} found. Trying keyword search...` });
      const seen = new Set(filtered.map(r => r.url));
      const extraResults = [...filtered];
      for (const kw of ['recruiter', 'talent', 'hiring']) {
        checkAbort();
        const kwUrl = `${peopleBaseUrl}&keywords=${encodeURIComponent(kw)}`;
        await navigateTab(tabId, kwUrl);
        await raceWithAbort(waitForTabLoad(tabId));
        await raceWithAbort(sleep(1800));
        const kwResults = await raceWithAbort(scrapeTab(tabId));
        for (const r of kwResults) {
          if (isRecruiter(r.title) && !seen.has(r.url)) {
            seen.add(r.url);
            extraResults.push(r);
          }
        }
      }
      filtered = extraResults;
    }

    let hiringFrameResults = [];
    if (filtered.length === 0) {
      checkAbort();
      chrome.storage.session.set({ status: 'No recruiters found by title. Scanning for #Hiring badges...' });

      await navigateTab(tabId, peopleBaseUrl);
      await raceWithAbort(waitForTabLoad(tabId));
      await raceWithAbort(sleep(1800));
      checkAbort();

      const allPeople = await raceWithAbort(scrapeTabWithHiringFrame(tabId));
      hiringFrameResults = allPeople.filter(r => r.hiringFrame);

      chrome.storage.session.set({
        status: hiringFrameResults.length > 0
          ? '? Found ' + hiringFrameResults.length + ' people with #Hiring frame.'
          : '?? No recruiters or #Hiring badges found.',
        done: true
      });
    }

    chrome.tabs.remove(tabId);

    const finalResults = filtered.length > 0 ? filtered : hiringFrameResults;

    chrome.storage.session.set({
      status: '? Done! Found ' + finalResults.length + ' people.',
      done: true,
      results: finalResults
    });

    return { recruiters: finalResults, logoUrl };
  } catch (err) {
    chrome.tabs.remove(tabId).catch(() => {});
    throw err;
  }
}
