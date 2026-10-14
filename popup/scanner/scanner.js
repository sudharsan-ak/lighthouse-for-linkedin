// -Poll for live background status ──────────────────────────────────────────
function pollStatus(done) {
  if (done) return;
  setTimeout(() => {
    chrome.storage.session.get(['status', 'progress', 'total', 'done'], data => {
      if (data.status) statusBox.textContent = data.status;
      if (data.progress && data.total) {
        progressFill.style.width = `${(data.progress / data.total) * 100}%`;
      }
      if (!data.done) pollStatus(false);
    });
  }, 500);
}

// -Run a single scan (used by queue processor) ───────────────────────────────
async function runQueuedScan(slug) {
  currentScanSlug = slug;
  isScanning = true;
  renderQueue();

  // Deliberately NOT clearing resultsDiv/resultsCompanyBanner here. If this is
  // a re-scan of the company currently on screen, the old results stay
  // visible (with the "Scanning..." status overlaid) until the new scan
  // actually completes and renderResults() does its own full replace below -
  // instead of the panel going blank the instant a re-scan starts. A scan of
  // a DIFFERENT company already clears resultsDiv itself when the user
  // navigates there (see currentSlug change elsewhere), so this is safe for
  // both the re-scan and fresh-company-navigation cases.
  errorDiv.style.display = 'none';
  errorDiv.style.color = '#c0392b';
  progressBar.style.display = 'block';
  progressFill.style.width = '0%';
  currentSlug = slug;
  companyEl.textContent = slug.replace(/-/g, ' ');
  statusBox.textContent = `Scanning ${slug.replace(/-/g, ' ')}...`;
  scanBtn.disabled = false;
  scanBtn.textContent = '➕ Add to Queue';
  if (stopScanBtn) { stopScanBtn.style.display = ''; stopScanBtn.disabled = false; stopScanBtn.textContent = '⏹ Stop'; }

  await chrome.storage.session.set({ manualScanDone: false, manualScanError: false, status: '' });

  return new Promise(resolve => {
    chrome.runtime.sendMessage({ action: 'start', companySlug: slug }, async response => {
      if (stopScanBtn) stopScanBtn.style.display = 'none';

      if (chrome.runtime.lastError || !response?.success) {
        if (response?.stopped) {
          // User-initiated stop: discard partial results, revert to whatever
          // was cached for this slug before the scan started (or the empty
          // "no results yet" state if nothing was cached).
          const cached = await getCached(slug);
          if (cached) {
            statusBox.textContent = `Stopped. Showing previous results (${cached.recruiters.length} recruiters).`;
            renderResults(cached.recruiters, cached.logoUrl);
          } else {
            statusBox.textContent = `Scan stopped.`;
            resultsDiv.innerHTML = '';
            resultsCompanyBanner.style.display = 'none';
          }
          progressBar.style.display = 'none';
        } else {
          statusBox.textContent = `❌ Error scanning ${slug.replace(/-/g, ' ')}.`;
          errorDiv.textContent = '❌ Something went wrong. Refresh the job page and try again.';
          errorDiv.style.display = 'block';
        }
      } else {
        progressFill.style.width = '100%';
        statusBox.textContent = `✅ Done! Found ${response.data.length} recruiters for ${slug.replace(/-/g, ' ')}.`;
        renderResults(response.data, response.logoUrl);
        if (response.data.length > 0) {
          await saveToCache(slug, response.data, response.logoUrl);
          // Re-evaluate observer notif, those recruiters are now cached so banner should clear
          if (_obsPending.slug === slug) showObserverNotif(slug, _obsPending.recruiters);
          // Clear profile notif if it was for this company
          if (_profileRecruiter?.companySlug === slug) hideProfileNotif();
        }
      }
      resolve();
    });
    pollStatus(false);
  });
}

stopScanBtn?.addEventListener('click', () => {
  if (!currentScanSlug) return;
  stopScanBtn.disabled = true;
  stopScanBtn.textContent = 'Stopping...';
  chrome.runtime.sendMessage({ action: 'stop', companySlug: currentScanSlug });
});

async function processQueue() {
  while (scanQueue.length > 0) {
    const { slug } = scanQueue.shift();
    saveQueue();
    await runQueuedScan(slug);
  }
  isScanning = false;
  currentScanSlug = null;
  scanBtn.disabled = false;
  scanBtn.textContent = '🔄 Re-scan';
  renderQueue();
}

// -Resume a manual scan that was running while the panel was closed ──────────
function pollForManualScanCompletion(slug) {
  const interval = setInterval(async () => {
    const sd = await new Promise(r =>
      chrome.storage.session.get(['manualScanSlug', 'manualScanDone', 'manualScanError', 'status'], r)
    );
    if (sd.status) statusBox.textContent = sd.status;
    if (sd.manualScanSlug !== slug) { clearInterval(interval); return; }
    if (!sd.manualScanDone) return; // still running

    clearInterval(interval);
    isScanning = false;
    currentScanSlug = null;
    progressFill.style.width = '100%';
    renderQueue();

    if (sd.manualScanError) {
      statusBox.textContent = `❌ Error scanning ${slug.replace(/-/g, ' ')}.`;
      errorDiv.textContent = '❌ Something went wrong. Refresh the job page and try again.';
      errorDiv.style.display = 'block';
      scanBtn.disabled = false;
      scanBtn.textContent = '🚀 Find Recruiters';
      return;
    }

    const cached = await getCached(slug);
    if (cached) {
      statusBox.textContent = `✅ Done! Found ${cached.recruiters.length} recruiters for ${slug.replace(/-/g, ' ')}.`;
      renderResults(cached.recruiters, cached.logoUrl);
      scanBtn.disabled = false;
      scanBtn.textContent = '🔄 Re-scan';
    }
    // Continue any queued items that survived a panel close
    if (scanQueue.length > 0) {
      processQueue();
    }
  }, 500);
}

// -Scan button ───────────────────────────────────────────────────────────────
scanBtn.addEventListener('click', async () => {
  const isRescan = scanBtn.textContent.includes('Re-scan');

  errorDiv.style.display = 'none';
  errorDiv.style.color = '#c0392b';

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (tab?.url?.match(/linkedin\.com\/in\/[^/?#]+/) && _profileRecruiter?.mode === 'new') {
    const inlineCompanyInput = document.querySelector('.profile-inline-company-input');
    const companyName = (inlineCompanyInput?.value || _profileRecruiter.companyName || companyEl.textContent || '').trim();
    hideProfileNotif();
    await performExternalSearch(companyName, 'Scan');
    return;
  }

  let slug = extractCompanySlug(tab);
  if (!slug) {
    statusBox.textContent = 'Detecting company from job posting...';
    slug = await getCompanySlugFromJobPage(tab.id);
  }

  // -Non-LinkedIn page handling ──────────────────────────────────────────────
  if (!tab.url?.includes('linkedin.com')) {
    if (currentSlug) {
      // Already resolved via disambiguation — use it (covers re-scan)
      slug = currentSlug;
    } else {
      // Slug not resolved yet — run LinkedIn search + disambiguation flow
      await performExternalSearch(companyEl.textContent.trim(), 'Scan');
      return;
    }
  }

  if (!slug) {
    errorDiv.textContent = '❌ Could not detect the company. Make sure a job is selected on the right pane.';
    errorDiv.style.display = 'block';
    return;
  }

  // If already scanning, add to queue instead
  if (isScanning) {
    const alreadyQueued = scanQueue.some(q => q.slug === slug) || currentScanSlug === slug;
    if (!alreadyQueued) {
      scanQueue.push({ slug });
      saveQueue();
      renderQueue();
      statusBox.textContent = `⏳ Added "${slug.replace(/-/g, ' ')}" to queue (position ${scanQueue.length}).`;
    } else {
      statusBox.textContent = `ℹ️ "${slug.replace(/-/g, ' ')}" is already in the queue.`;
    }
    return;
  }

  // Not scanning — check cache first (unless re-scan)
  if (!isRescan) {
    const cached = await getCached(slug);
    if (cached) {
      currentSlug = slug;
      companyEl.textContent = slug.replace(/-/g, ' ');
      const age     = Math.round((Date.now() - cached.scannedAt) / 60000);
      const ageText = age < 60 ? `${age}m ago` : age < 1440 ? `${Math.round(age / 60)}h ago` : `${Math.floor(age / 1440)}d ${Math.floor((age % 1440) / 60)}h ago`;
      statusBox.textContent = `✅ Loaded from cache (scanned ${ageText}). ${cached.recruiters.length} recruiters.`;
      progressBar.style.display = 'block';
      progressFill.style.width = '100%';
      renderResults(cached.recruiters);
      scanBtn.textContent = '🔄 Re-scan';
      errorDiv.style.display = 'block';
      errorDiv.style.color = '#0a66c2';
      errorDiv.textContent = `💡 Showing cached results. Click "Re-scan" to fetch fresh data.`;
      return;
    }
  }
  // Re-scan: deliberately NOT deleting the cache entry here. The existing
  // cached results (and resultsDiv) stay as-is while the scan runs in the
  // background; saveToCache() on success fully overwrites this slug's entry
  // with the fresh results, which is what actually drops anyone no longer
  // found (e.g. someone who left the company). Deleting upfront only caused
  // the panel to blank out the instant Re-scan was clicked, before any new
  // data existed yet.

  // Start scan immediately
  await runQueuedScan(slug);

  // Process any queued items after the first scan
  if (scanQueue.length > 0) {
    processQueue();
  } else {
    isScanning = false;
    currentScanSlug = null;
    scanBtn.disabled = false;
    scanBtn.textContent = '🔄 Re-scan';
    renderQueue();
  }
});

// -Copy all button ───────────────────────────────────────────────────────────
copyBtn?.addEventListener('click', () => {
  navigator.clipboard.writeText(copyBtn?.dataset.text || '').then(() => {
    if (copyBtn) { copyBtn.textContent = '✅ Copied!'; setTimeout(() => { copyBtn.textContent = '📋 Copy All as Text'; }, 2000); }
  });
});
