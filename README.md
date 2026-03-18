# Case Organizer v4

Case Organizer is a full-stack legal case-management and document-organization platform built with Flask.  
It helps law practices structure, archive, and retrieve their case files, generate invoices, and manage internal communication — all within a private, self-hosted environment.

---

## Overview

Version 3 introduced secure email-based authentication, internal messaging, integrated invoicing, and Debian-package deployment for seamless installation on Linux servers.

Version 4 continues that foundation with a fully rebuilt Case Law module, a structured citation system, PDF editing integration, and a consistent custom UI component layer.

---

## Features

### Core System
- Built on **Flask 3.0** and **Werkzeug 3.0** with hardened routing and isolated session management.
- Fully Debian-packaged (`.deb`) for one-command deployment and auto-systemd integration.
- Secure password storage with **argon2-cffi** and **cryptography** modules.
- Configurable filesystem root (`fs-files`) for all case data.

### Authentication and Accounts
- Email-based login replacing the shared-password model.  
- Password reset via secure SMTP-delivered reset codes.  
- Users can update their username, email, and password independently.  
- Automatic logout after 10 minutes of inactivity for security.

### Administration
- Admins can:
  - Create users with temporary credentials.  
  - Promote or demote roles between *admin* and *standard*.  
  - Edit or delete user accounts.  
  - Update or relocate the root storage path live.  
  - Delete server files directly from the dashboard.

![Admin Account Demo](https://raw.githubusercontent.com/LORDINFINITY12/Case-Organizer_V3/main/static/img/Admin-Account-Demo.png)

### UI and UX
- Flattened, consistent styling across all pages.

![Index Demo](https://raw.githubusercontent.com/LORDINFINITY12/Case-Organizer_V3/main/static/img/Index-Demo.png)

- Password-visibility toggle on login form.

![Login Screen Visibility Toggle](https://raw.githubusercontent.com/LORDINFINITY12/Case-Organizer_V3/main/static/img/Login-Screen-Visibility-Toggle.png)
  
- Dark/light theme compatibility.
  
![Dark Light Comparison](https://raw.githubusercontent.com/LORDINFINITY12/Case-Organizer_V3/6ff68df9a6dc9505ce0906b14b0bf2394f2e13f0/static/img/Dark-Light-Comparison.png)

- Clear disabled states and keyboard-focus polish.
- Custom **Long-List Dropdown** component replaces all native `<select>` elements for consistent, scroll-limited dropdowns in both light and dark themes.
- Tab-style toggle buttons for binary choices (e.g. "We're Representing").
- Dropdown panels automatically flip upward when near the bottom of the viewport.
- **Markdown rendering** in Case Notes ("Additional Notes") and Case Law briefs, with live preview in search results.
- AFK-aware session keepalive — active typing and in-browser processing no longer trigger premature auto-logout.

### Case Management
- Create, edit, and organize structured case directories:

   ```none
  fs-files/
    YYYY/
      MMM/
        Petitioner v. Respondent/
          Note.json
          Petitions_Applications/
          Orders_Judgments/
          Primary_Documents/
    Case_Law/
      Category/
        Case Type/
          YYYY/
            Petitioner v. Respondent/
    Invoices/
  ```
- **Dual-tab Manage Case** interface:
  - Name lookup pre-fills year/month automatically.
  - Notes stay synchronized with the active case.
- Integrated **Case Law** module:
  - Upload, tag, and search case-law documents.
  - Tabbed search with admin-only delete access.
  - **Court/Forum selection** — Supreme Court, Federal Court, Privy Council, and all current and historical Indian High Courts with a searchable dropdown.
  - **Structured citation system** — per-row entries for INSC, SCC, SCC Online, SCR, and AIR formats, each auto-formatting based on journal rules (volume, court abbreviation, page number). Multiple citations per case supported.
  - **Edit Case Law** — full metadata editing (court, citations, classification, notes) via the View/Edit Note modal, with database and note.json kept in sync.
  - Legacy free-text citations auto-migrate to structured rows where parseable; unrecognised entries are flagged with a banner for manual correction.
  - **Citation search tab** — search by journal, year, volume, and page number against the normalised citations table.
  - Bidirectional year sync between the Decision Year field and all citation row year inputs; new citation rows auto-populate year from existing context.
  - Integer-only enforcement on citation Year, Volume, and Page/Entry fields.
- Auto-naming of files:
  ```none
  (DDMMYYYY) TYPE DOMAIN Petitioner v. Respondent.ext
  ```
  Reference files keep original names with case suffix.

### Invoicing
- Full PDF invoice generator using **ReportLab**.  
- Accessible both globally and per-case.  
- Dual save: global `Invoices/` archive and per-case folder.  
- Context-aware UI disables irrelevant controls until a case is selected.

![Invoice Demo](https://raw.githubusercontent.com/LORDINFINITY12/Case-Organizer_V3/4a578a2495b1cf28401fe3ca64c637b04afa63bf/static/img/Invoice-Demo.png)

### Internal Messaging
- Built-in mailbox for users to send, receive, and read messages.  
- Asynchronous SMTP notifications prevent UI blocking.  
- Optional performance logging for slower servers.

![Messaging Demo](https://raw.githubusercontent.com/LORDINFINITY12/Case-Organizer_V3/51bdc11f04bb0f170bff08d7eed46b2b6f7cd680/static/img/Messagin-Demo.png)

### Search and Retrieval
- Multi-filter search:
  - Year / Month
  - Petitioner / Respondent
  - Domain + Subcategory
  - Citation (journal / year / volume / page)
  - Free-text queries
- Fast indexed search across Notes, Case Law, and Invoices.

![Case Law Search Demo](https://raw.githubusercontent.com/LORDINFINITY12/Case-Organizer_V3/main/static/img/Case-Law-Search-Demo.png)

### PDF Editing Suite
- PDF editing hub with PDF24-style workflow: drag/drop uploads, per-tool options,
  progress tracking, and one-click downloads.
- Tools included: Merge, Split (ranges/odd-even/visual), Compress (Rectal/Photon),
  Remove Pages, Rearrange Pages with thumbnails, Flatten PDFs, OCR with language
  picker + DPI presets, Add Page Numbers, and Image-to-PDF with ordering/preview.
- Jobs auto-delete 5 minutes after completion; Start toggles to Cancel to clear
  selections and reset the tool state.
- Integrated as the **BentoPDF** suite with a unified tool-search hub, wrapped in the Case Organizer top bar and theming.

> **Attribution:** The PDF editing suite is built on top of [BentoPDF](https://github.com/alam00000/bentopdf) by alam00000, used and adapted under its original licence. All credit for the underlying PDF tool framework goes to the BentoPDF project.

![PDF Editing Tools](https://raw.githubusercontent.com/LORDINFINITY12/Case-Organizer_V3/main/static/img/PDF-Editing-Tools.png)

---

## Requirements

```text
Flask>=3.0
Werkzeug>=3.0
pdfminer.six>=20221105
python-docx>=1.1.0
argon2-cffi>=23.1.0
cryptography>=41.0.0
reportlab>=3.6.12
pypdf>=4.0.0
Pillow>=10.0.0
```

Python 3.10 or newer is required.

System packages for PDF tooling (recommended):
- `tesseract-ocr` (+ language packs such as `tesseract-ocr-all`)
- `poppler-utils` (for `pdftoppm` thumbnails/OCR rendering)
- `qpdf` (flattening + Rectal compression)
- `ghostscript` (Photon compression)

---

## Installation

### Option 1 – From Source

```bash
git clone https://github.com/<your-org>/case-organizer-v3.git
cd case-organizer-v3
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python3 app.py
```

Access the app at:

```none
http://localhost:5000
```

---

### Option 2 – Debian Package

```bash
# Download the latest release
wget https://github.com/LORDINFINITY12/case-organizer-v3/releases/download/v4.0.3/case-organizer_4.0.3_all.deb

# Install the package
sudo dpkg -i case-organizer_4.0.3_all.deb

# Enable and start the service
sudo systemctl enable --now case-organizer.service
```

Once active, Case Organizer runs automatically on boot.  
Logs are available via:

```bash
journalctl -u case-organizer.service
```

---

## First-Run Setup

1. **Storage and Users**  
   On first launch you’ll be redirected to `/setup`.  
   Select your storage root (`fs-files`) and define allowed users.

2. **Email Configuration**  
   Provide SMTP details for outgoing mail (password resets and notifications).

3. **Login**  
   Sign in using your registered email and password.

---

## Development Notes

- Configuration stored dynamically in `caseorg_config.py`.  
- Allowed file types: `.pdf`, `.docx`, `.txt`, `.png`, `.jpg`, `.jpeg`, `.json`.  
- Diagnostic routes:  
  - `/ping` – basic health check  
  - `/__routes` – list all Flask routes

---

---

## Attributions

| Component | Author | Repository |
|-----------|--------|------------|
| BentoPDF — PDF editing suite | alam00000 | https://github.com/alam00000/bentopdf |

The PDF editing tools integrated into Case Organizer (Merge, Split, Compress, OCR, Rearrange, and others) are sourced from the BentoPDF project. BentoPDF is embedded and served within the Case Organizer interface; all credit for the PDF tooling framework belongs to its original author.

---

**License:** GNU AGPL v3.0 with Additional Terms (see LICENSE for details)
**Current Release:** v4.0.3 (March 2026)
