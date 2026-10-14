# LinkedIn Job Toolkit

A Chrome extension (Manifest V3) that assists with job hunting on LinkedIn: finds recruiters at any company, captures job descriptions, and drafts application answers. Opens as a persistent side panel and works in the background even when the panel is closed.

---

<img width="565" height="883" alt="image" src="https://github.com/user-attachments/assets/156a54f0-0ab2-45bf-9964-289a96ccd806" />

---

## Features

| Feature | Description |
|---|---|
| **Find Recruiters** | Scans a company's LinkedIn People tab in the background and returns a filtered recruiter list |
| **Scan Queue** | Queue multiple companies while a scan is running |
| **Observer Mode** | Watches the People tab as you browse and surfaces recruiters not found in the automated scan |
| **History Tab** | Searchable history of all scanned companies with bulk copy/export per company |
| **Bulk Scan** | Paste a list of company names and scan them all in sequence |
| **Import / Export** | Export recruiters as CSV or XLSX; full JSON backup and restore |
| **📋 JD** | One-click copy of job title, link, and description from any LinkedIn job page |
| **✎ Paste JD** | Manually paste a job description to save it to your local JD file |
| **📷 Paste JD IMG** | Paste job description screenshots — saved as image files with markdown links |
| **Answer** | AI-generated answers to job application questions using your profile + the JD |
| **Company Meta** | Shows employee count, visa status, experience required, and tech stack for the current job |
| **Send to Outreach** *(personal)* | Sends selected recruiter links to a local server endpoint that appends them to a personal outreach tracking file - not for general use |

→ [Full feature details](docs/features.md)

---

## Installation

1. Clone or download this repository
2. Open Chrome → `chrome://extensions`
3. Enable **Developer mode** (top right)
4. Click **Load unpacked** and select the extension folder
5. Press `Alt+R` (`Cmd+Shift+R` on Mac) to open the side panel

→ [Setup, file structure & permissions](docs/setup.md)

---

## Usage

1. Open any LinkedIn job posting
2. Press `Alt+R` to open the side panel
3. Click **🚀 Find Recruiters**
4. Use checkboxes + **Copy Selected Links** to grab the profiles you want

---

<img width="513" height="878" alt="Import-Export" src="https://github.com/user-attachments/assets/82c0a7a5-8990-469c-9364-0444b920ce26" />

---

## License

MIT
