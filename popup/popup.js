const scanBtn = document.getElementById('scanBtn');
const stopScanBtn = document.getElementById('stopScanBtn');
const copyBtn = document.getElementById('copyBtn');
const resultsDiv = document.getElementById('results');
const resultsCompanyBanner = document.getElementById('resultsCompanyBanner');
const statusBox = document.getElementById('statusBox');
const errorDiv = document.getElementById('error');
const companyEl = document.getElementById('companyName');
const progressBar = document.getElementById('progressBar');
const progressFill = document.getElementById('progressFill');

const tabSearchBtn = document.getElementById('tabSearch');
const tabJobsBtn = document.getElementById('tabJobs');
const tabHistoryBtn = document.getElementById('tabHistory');
const searchPanel = document.getElementById('searchPanel');
const jobsPanel = document.getElementById('jobsPanel');
const bulkPanel = document.getElementById('bulkPanel');
const historyPanel = document.getElementById('historyPanel');
const historyList = document.getElementById('historyList');
const historySearch = document.getElementById('historySearch');
const clearSearchBtn = document.getElementById('clearSearchBtn');
const clearHistBtn = document.getElementById('clearHistoryBtn');
const exportCsvBtn = document.getElementById('exportCsvBtn');
const exportXlsxBtn = document.getElementById('exportXlsxBtn');
const exportBackupBtn = document.getElementById('exportBackupBtn');
const importCsvBtn = document.getElementById('importCsvBtn');
const importJsonBtn = document.getElementById('importJsonBtn');
const importXlsxBtn = document.getElementById('importXlsxBtn');
const importFileInput = document.getElementById('importFileInput');
const addRecruiterBtn = document.getElementById('addRecruiterBtn');
const refreshLogosBtn = document.getElementById('refreshLogosBtn');
const historyOptionsBtn = document.getElementById('historyOptionsBtn');
const historyOptionsMenu = document.getElementById('historyOptionsMenu');
const historyActionStatus = document.getElementById('historyActionStatus');
const manageMenuBtn = document.getElementById('manageMenuBtn');
const transferMenuBtn = document.getElementById('transferMenuBtn');

const observerNotif = document.getElementById('observerNotification');
const obsText = document.getElementById('obsText');
const obsShowBtn = document.getElementById('obsShowBtn');
const obsDismissBtn = document.getElementById('obsDismissBtn');

const profileNotif = document.getElementById('profileNotif');
const profileNotifText = document.getElementById('profileNotifText');
const profileNotifSubtext = document.getElementById('profileNotifSubtext');
const profileNotifEditWrap = document.getElementById('profileNotifEditWrap');
const profileCompanyInput = document.getElementById('profileCompanyInput');
const profileNotifAddBtn = document.getElementById('profileNotifAddBtn');
const profileNotifManualBtn = document.getElementById('profileNotifManualBtn');
const profileNotifAltBtn = document.getElementById('profileNotifAltBtn');
const profileNotifTitleWrap = document.getElementById('profileNotifTitleWrap');
const profileTitleInput = document.getElementById('profileTitleInput');
const profileNotifCompanyWrap = document.getElementById('profileNotifCompanyWrap');
const profileCompanyNameInput = document.getElementById('profileCompanyNameInput');
const profileNotifDismiss = document.getElementById('profileNotifDismiss');
const observerModal = document.getElementById('observerModal');
const obsModalTitle = document.getElementById('obsModalTitle');
const obsModalList = document.getElementById('obsModalList');
const obsModalSelCount = document.getElementById('obsModalSelCount');
const obsModalAddBtn = document.getElementById('obsModalAddBtn');
const obsModalCloseBtn = document.getElementById('obsModalCloseBtn');
const obsSelectAll = document.getElementById('obsSelectAll');
const obsDeselectAll = document.getElementById('obsDeselectAll');

const bulkTextarea = document.getElementById('bulkTextarea');
const bulkForceRescan = document.getElementById('bulkForceRescan');
const bulkSearchBtn = document.getElementById('bulkSearchBtn');
const bulkProgressBar = document.getElementById('bulkProgressBar');
const bulkProgressFill = document.getElementById('bulkProgressFill');
const bulkStatus = document.getElementById('bulkStatus');
const bulkResultsDiv = document.getElementById('bulkResults');

const companyMetaEl = document.getElementById('companyMeta');
const techStackEl = document.getElementById('techStack');

// const autoScanToggle = document.getElementById('autoScanToggle');
// const asStatus = document.getElementById('asStatus');

const scanQueue = [];
let isScanning = false;
let currentScanSlug = null;
let currentSlug = null;
let _onJobPage = false;
let _currentJobUrl = '';

function saveQueue() {
  chrome.storage.session.set({ manualScanQueue: scanQueue.map(q => q.slug) }).catch(() => {});
}

// chrome.storage.local.get(['autoScanEnabled'], ({ autoScanEnabled }) => {
//   const on = autoScanEnabled === true;
//   // autoScanToggle.checked = on;
//   asStatus.textContent = on ? 'ON' : 'OFF';
//   asStatus.classList.toggle('off', !on);
// });

// autoScanToggle.addEventListener('change', () => {
//   const on = autoScanToggle.checked;
//   chrome.storage.local.set({ autoScanEnabled: on });
//   asStatus.textContent = on ? 'ON' : 'OFF';
//   asStatus.classList.toggle('off', !on);
// });

function activateTab(activeBtn, activePanel, extraInit) {
  [tabSearchBtn, tabJobsBtn, tabHistoryBtn].forEach(btn => btn.classList.remove('active'));
  [searchPanel, jobsPanel, bulkPanel, historyPanel].forEach(panel => panel.classList.remove('active'));
  if (activeBtn) activeBtn.classList.add('active');
  // Reset menu button to ☰ whenever a real tab is activated
  if (activeBtn !== null) {
    tabMenuBtn.textContent = '☰';
    tabMenuBtn.classList.remove('active');
  }
  activePanel.classList.add('active');
  if (extraInit) extraInit();
}

tabSearchBtn.addEventListener('click', () => {
  historySearch.value = '';
  clearSearchBtn.style.display = 'none';
  activateTab(tabSearchBtn, searchPanel);
});

tabJobsBtn.addEventListener('click', () => {
  historySearch.value = '';
  clearSearchBtn.style.display = 'none';
  activateTab(tabJobsBtn, jobsPanel, () => { globalThis.renderJobsPanel?.(); });
});

tabHistoryBtn.addEventListener('click', () => activateTab(tabHistoryBtn, historyPanel, () => {
  renderHistory();
}));

// ☰ Tab menu (Bulk Scan, future extras)
const tabMenuBtn = document.getElementById('tabMenuBtn');
const tabMenuDropdown = document.getElementById('tabMenuDropdown');

let _prevTabBtn = tabSearchBtn;
let _prevPanel = searchPanel;

function exitSubView() {
  tabMenuBtn.textContent = '☰';
  tabMenuBtn.classList.remove('active');
  if (_prevTabBtn === tabHistoryBtn) {
    activateTab(tabHistoryBtn, historyPanel, () => { renderHistory(); });
  } else {
    activateTab(_prevTabBtn, _prevPanel);
  }
}

tabMenuBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  if (tabMenuBtn.classList.contains('active')) {
    // Currently showing a sub-view — act as back button
    exitSubView();
    return;
  }
  const open = tabMenuDropdown.style.display !== 'none';
  tabMenuDropdown.style.display = open ? 'none' : 'block';
});
document.addEventListener('click', () => { tabMenuDropdown.style.display = 'none'; });

// Close all dropdowns + modals when user clicks outside the popup window onto the webpage
window.addEventListener('blur', () => {
  tabMenuDropdown.style.display = 'none';
  const resultsOpts = document.getElementById('resultsOptionsMenu');
  if (resultsOpts) resultsOpts.style.display = 'none';
  const jobsOpts = document.getElementById('jobsOptionsDropdown');
  if (jobsOpts) jobsOpts.style.display = 'none';
  const seenClear = document.getElementById('seenClearDropdown');
  if (seenClear) seenClear.style.display = 'none';
  const histOpts = document.getElementById('historyOptionsMenu');
  if (histOpts) histOpts.style.display = 'none';
  const pasteJd = document.getElementById('pasteJdModal');
  if (pasteJd) pasteJd.classList.remove('open');
  const addRecruiter = document.getElementById('addRecruiterModal');
  if (addRecruiter) addRecruiter.classList.remove('open');
  const myProfile = document.getElementById('myProfileModal');
  if (myProfile) myProfile.classList.remove('open');
  const answerModal = document.getElementById('answerModal');
  if (answerModal) answerModal.classList.remove('open');
});

document.getElementById('tabMenuSettings').addEventListener('click', () => {
  tabMenuDropdown.style.display = 'none';
  globalThis._openSettingsModal?.();
});

document.getElementById('tabMenuBulk').addEventListener('click', () => {
  _prevTabBtn = [tabSearchBtn, tabJobsBtn, tabHistoryBtn].find(b => b.classList.contains('active')) || tabSearchBtn;
  _prevPanel = [searchPanel, jobsPanel, historyPanel].find(p => p.classList.contains('active')) || searchPanel;
  historySearch.value = '';
  clearSearchBtn.style.display = 'none';
  tabMenuDropdown.style.display = 'none';
  activateTab(null, bulkPanel);
  tabMenuBtn.textContent = 'Bulk Scan';
  tabMenuBtn.classList.add('active');
});

chrome.runtime.onMessage.addListener((request) => {
  if (request.action === 'scanComplete') {
    if (request.companySlug !== currentSlug) return;
    getCached(request.companySlug).then(cached => {
      if (!cached) return;
      const count = cached.recruiters.length;
      statusBox.textContent = `Auto-scanned! Found ${count} recruiter${count !== 1 ? 's' : ''}.`;
      progressBar.style.display = 'block';
      progressFill.style.width = '100%';
      if (count > 0) {
        renderResults(cached.recruiters);
        scanBtn.textContent = 'Re-scan';
      }
    });
  }

  if (request.action === 'profileRecruiterFound') {
    clearTimeout(_profileWaitTimer);
    handleProfileCheckResult({ ...request, status: 'recruiter_found' });
    return;
  }

  if (request.action === 'profileCheckResult') {
    clearTimeout(_profileWaitTimer);
    handleProfileCheckResult(request);
    return;
  }

  if (request.action === 'observedRecruiters') {
    const { companySlug, recruiters } = request;
    if (!recruiters?.length) return;
    let combined = recruiters;
    if (_obsPending.slug === companySlug && _obsPending.recruiters.length) {
      const incomingUrls = new Set(recruiters.map(r => r.url));
      const prevOnly = _obsPending.recruiters.filter(r => !incomingUrls.has(r.url));
      combined = [...recruiters, ...prevOnly];
    }
    showObserverNotif(companySlug, combined);
  }
});

document.getElementById('statusRefreshBtn').addEventListener('click', () => {
  currentEmployeeCount = null;
  currentVisaStatus = null;
  currentExperience = null;
  companyMetaEl.style.display = 'none';
  techStackEl.style.display = 'none';
  statusBox.textContent = 'Refreshing...';

  _lastPollUrl = '';
  _lastPeopleUrl = '';
  _lastProfilePollUrl = '';
  _lastCompanyPageSlug = '';

  initPanel();
});
