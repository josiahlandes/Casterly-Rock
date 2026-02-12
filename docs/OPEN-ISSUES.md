# Open Issues

Tracked gaps, bugs, and feature needs for Casterly-Rock.

---

## ISSUE-001: File Type Support Gaps

**Status:** Open
**Priority:** High
**Opened:** 2026-02-12
**Category:** Feature — Document Handling

### Summary

Tyrion's toolkit is text/code-first. It has zero capability for the document, spreadsheet, image, and media file types a personal assistant encounters daily.

### Current State

| File Type | Read | Modify | Write/Create | Notes |
|-----------|:----:|:------:|:------------:|-------|
| `.ts` `.js` `.py` `.go` `.rs` `.java` `.c/.cpp` | Yes | Yes | Yes | Full support via coding tools |
| `.json` `.yaml` `.yml` `.xml` | Yes | Yes | Yes | Full support |
| `.md` `.html` `.css` `.scss` | Yes | Yes | Yes | Full support |
| `.sh` `.bash` `.zsh` | Yes | Yes | Yes | Full support |
| `.svg` | Yes | Yes | Yes | XML-based, works as text |
| `.csv` | Partial | Partial | Partial | Raw text only — no column/row awareness |
| `.pdf` | **No** | **No** | **No** | Detected as binary, skipped |
| `.docx` | **No** | **No** | **No** | No parser |
| `.doc` | **No** | **No** | **No** | No parser (legacy format) |
| `.xlsx` / `.xls` | **No** | **No** | **No** | No parser |
| `.numbers` | **No** | **No** | **No** | Apple-proprietary, no parser |
| `.pptx` | **No** | **No** | **No** | No parser |
| `.png` `.jpg` `.gif` `.webp` | **No** | **No** | **No** | Binary, skipped |
| `.mp3` `.wav` `.ogg` | **No** | **No** | **No** | Binary, flagged sensitive |
| `.mp4` `.mov` `.webm` | **No** | **No** | **No** | Binary |
| `.zip` `.tar` `.gz` | **No** | **No** | **No** | No unpacker |

### Proposed Solution

Add document handler modules under `src/coding/tools/` (or a new `src/handlers/` directory) using these libraries:

| Gap | npm Package | Adds |
|-----|-------------|------|
| PDF read | `pdf-parse` or `pdfjs-dist` | Extract text from PDFs |
| DOCX read | `mammoth` | Word → text/HTML extraction |
| DOCX write | `docx` | Programmatic Word doc creation |
| XLSX/XLS read/write | `exceljs` | Full spreadsheet support |
| CSV structured parse | `csv-parser` / `csv-stringify` | Column-aware read/write |
| Image processing | `sharp` | Resize, convert, read metadata |
| MIME detection | `file-type` | Auto-detect unknown file types |
| Archive unpacking | `extract-zip` / `tar` | Open .zip / .tar.gz |

### Suggested Priority Order

1. **PDF** + **DOCX** + **XLSX** — covers invoices, contracts, budgets, receipts
2. **CSV structured parsing** — lightweight win, useful for data import/export
3. **Image processing** — resize, convert, metadata for photos/screenshots
4. **MIME detection** — safety net for unknown files
5. **Archive support** — .zip/.tar.gz unpacking

### Constraints

- All processing must stay local (privacy-first principle).
- Sensitive document content must never be logged raw.
- New handlers must integrate with the existing tool registry pattern.

---

*Add new issues below using the next sequential ID (ISSUE-002, etc.).*
