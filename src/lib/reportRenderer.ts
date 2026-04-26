/**
 * Report Renderer
 * ─────────────────────────────────────────────────────────────────────────
 * Takes a ReportData object (computed by reportData.ts) and produces a
 * single-file HTML document with embedded CSS — usable both as a standalone
 * .html file and, with MS Office MIME envelope, as a Word .doc that opens
 * directly in Microsoft Word / Pages / LibreOffice.
 *
 * Design constraints:
 *   - Self-contained: no external CSS, no fonts from CDN — Word can't load
 *     them and the file should also work emailed as an attachment.
 *   - Print-friendly: A4 page size, page-break hints, conservative colors.
 *   - Word-compatible: avoid CSS Grid, gap, modern position values; use
 *     tables and inline styles where it matters. Light shadows / no
 *     gradients in the Word path.
 */

import type {
  ReportData,
  ReportSummary,
  ActivityBreakdown,
  StakeholderProjectMatrix,
  TimelineDay,
  TimelineWeek,
  DriverRow,
  PeriodComparison,
  NotableItem,
} from './reportData';

// ── Public API ────────────────────────────────────────────────────────

/**
 * Render the report to HTML. Add `forWord=true` to wrap with MS Office
 * MIME headers so a saved .doc file opens directly in Word.
 */
export function renderReport(data: ReportData, forWord = false): string {
  const body = renderBody(data);
  const css = renderCss(forWord);

  if (forWord) {
    // Word-compatible HTML: declare xmlns + Office namespace. Word renders
    // most CSS but ignores complex layouts (flex/grid/transforms). We keep
    // the content table-based and only use inline styles where necessary.
    return `<!DOCTYPE html>
<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40">
<head>
<meta charset="utf-8">
<meta name="ProgId" content="Word.Document">
<meta name="Generator" content="Microsoft Word 15">
<meta name="Originator" content="Microsoft Word 15">
<title>${escapeHtml(`Zeiterfassung Report — ${data.periodLabel}`)}</title>
<!--[if gte mso 9]><xml><w:WordDocument><w:View>Print</w:View><w:Zoom>100</w:Zoom></w:WordDocument></xml><![endif]-->
<style>${css}</style>
</head>
<body>${body}</body>
</html>`;
  }

  return `<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(`Zeiterfassung Report — ${data.periodLabel}`)}</title>
<style>${css}</style>
</head>
<body>${body}</body>
</html>`;
}

/**
 * Trigger a browser download of the report.
 * Filename derived from period label + format.
 */
export function downloadReport(data: ReportData, format: 'html' | 'word'): void {
  const html = renderReport(data, format === 'word');
  const mime = format === 'word'
    ? 'application/msword;charset=utf-8'
    : 'text/html;charset=utf-8';
  const ext = format === 'word' ? 'doc' : 'html';

  // Sanitise period label for filename
  const slug = (data.periodLabel || 'report')
    .replace(/[^a-zA-Z0-9äöüÄÖÜß ]+/g, '-')
    .replace(/\s+/g, '_')
    .toLowerCase();
  const filename = `zeiterfassung-report-${slug}.${ext}`;

  // Word in particular needs a BOM to render umlauts correctly
  const blob = format === 'word'
    ? new Blob(['\uFEFF', html], { type: mime })
    : new Blob([html], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Free the blob URL after a tick
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ── HTML body ─────────────────────────────────────────────────────────

function renderBody(d: ReportData): string {
  const blocks: string[] = [renderHeader(d), renderScopeDisclaimer()];
  // Management Summary as a prominent prose block right after the
  // disclaimer. Only rendered when the user kept some text.
  if (d.narratives.managementSummary && d.narratives.managementSummary.trim()) {
    blocks.push(renderManagementSummary(d.narratives.managementSummary));
  }
  if (d.summary) blocks.push(renderSummary(d.summary, d.narratives.bySection.summary));
  if (d.activity) blocks.push(renderActivity(d.activity, d.narratives.bySection.activity));
  if (d.stakeholderProject) blocks.push(renderStakeholderProject(d.stakeholderProject, d.narratives.bySection.stakeholderProject));
  if (d.driver) blocks.push(renderDriver(d.driver, d.narratives.bySection.driver));
  if (d.comparison) blocks.push(renderComparison(d.comparison, d.narratives.bySection.comparison));
  if (d.timeline) blocks.push(renderTimeline(d.timeline, d.includeNotes, d.narratives.bySection.timeline));
  if (d.notable) blocks.push(renderNotable(d.notable, d.narratives.bySection.notable));
  blocks.push(renderFooter(d));
  return blocks.join('\n');
}

/**
 * Management Summary box right after the scope disclaimer. Visually
 * distinct from regular sections — slightly heavier border and a different
 * accent so the executive reader knows this is the framing paragraph.
 */
function renderManagementSummary(text: string): string {
  return `
<aside class="r-mgmt-summary">
  <div class="r-mgmt-tag">Management Summary</div>
  ${renderProse(text)}
</aside>`;
}

/**
 * Wrap a multi-line user-edited string in <p> tags. Empty lines split
 * paragraphs. Single newlines are preserved as <br>.
 */
function renderProse(text: string): string {
  if (!text || !text.trim()) return '';
  const paragraphs = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  return paragraphs
    .map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`)
    .join('\n');
}

/**
 * Per-section commentary block. Rendered inside the section, just below
 * the title. Empty narrative → no block.
 */
function renderSectionNarrative(text: string | undefined): string {
  if (!text || !text.trim()) return '';
  return `<div class="r-narrative">${renderProse(text)}</div>`;
}

/**
 * Scope-disclaimer callout right after the header. The audience for this
 * report is management — they need to know up-front that the numbers
 * represent BOOKED time on stakeholders/projects, not a complete record
 * of presence or working time. Spontaneous interactions (Ganggespräche,
 * kurze Telefonate, spontane Besuche von Stakeholdern im Büro etc.) are
 * not systematically captured. Without this callout the totals can be
 * misread as a timesheet.
 */
function renderScopeDisclaimer(): string {
  return `
<aside class="r-disclaimer">
  <div class="r-disclaimer-tag">Hinweis zur Datengrundlage</div>
  <p>
    Die folgenden Zahlen zeigen die <strong>auf Stakeholder und Projekte gebuchte Wall-Clock-Zeit</strong>.
    Sie sind <strong>keine vollständige Erfassung der Präsenz- oder Arbeitszeit</strong>:
    Spontane Aktivitäten ohne Stakeholder-Bezug — Ganggespräche, kurze Telefonate,
    spontane Besuche von Stakeholdern im Büro etc. — werden nicht systematisch erfasst.
  </p>
</aside>`;
}

function renderHeader(d: ReportData): string {
  const generated = formatDateTime(d.generatedAt);
  return `
<header class="r-header">
  <div class="r-header-line">ZEITERFASSUNG · MONATSBERICHT</div>
  <h1 class="r-title">${escapeHtml(d.periodLabel)}</h1>
  <div class="r-header-meta">
    <span><strong>${escapeHtml(d.ownerName)}</strong></span>
    <span class="r-sep">·</span>
    <span>erstellt am ${escapeHtml(generated)}</span>
  </div>
</header>`;
}

function renderSummary(s: ReportSummary, narrative?: string): string {
  const cards = [
    { label: 'Gesamtstunden', value: `${s.totalHours.toFixed(1)}h`, hint: 'Wall-Clock' },
    { label: 'Arbeitstage', value: `${s.workdays}`, hint: 'mit Erfassung' },
    { label: 'Ø / Arbeitstag', value: `${s.avgPerWorkday.toFixed(1)}h`, hint: `${s.avgVsGoalPct.toFixed(0)}% vom Soll (8.4h)` },
    { label: 'Produktivitätsquote', value: `${s.productivityPct.toFixed(0)}%`, hint: `${s.productiveHours.toFixed(1)}h Produktiv` },
    { label: 'Stakeholder', value: `${s.stakeholderCount}`, hint: 'berührt' },
    { label: 'Projekte', value: `${s.projectCount}`, hint: 'berührt' },
  ];
  const cells = cards.map((c) => `
    <td class="r-kpi">
      <div class="r-kpi-value">${escapeHtml(c.value)}</div>
      <div class="r-kpi-label">${escapeHtml(c.label)}</div>
      <div class="r-kpi-hint">${escapeHtml(c.hint)}</div>
    </td>`).join('');

  return `
<section class="r-section">
  <h2 class="r-section-title">Executive Summary</h2>
  ${renderSectionNarrative(narrative)}
  <table class="r-kpi-grid"><tr>${cells}</tr></table>
</section>`;
}

function renderActivity(a: ActivityBreakdown, narrative?: string): string {
  const taetigkeit = renderBarTable('Tätigkeit', a.byTaetigkeit);
  const fmt = renderBarTable('Format', a.byFormat);
  return `
<section class="r-section">
  <h2 class="r-section-title">Aktivitäts-Verteilung</h2>
  ${renderSectionNarrative(narrative)}
  ${taetigkeit}
  ${fmt}
</section>`;
}

function renderBarTable(headerLabel: string, rows: { name: string; hours: number; pct: number }[]): string {
  if (rows.length === 0) return `<p class="r-empty">— keine Daten —</p>`;
  const trs = rows.map((r) => `
    <tr>
      <td class="r-name">${escapeHtml(r.name)}</td>
      <td class="r-num">${r.hours.toFixed(1)}h</td>
      <td class="r-num r-pct">${r.pct.toFixed(0)}%</td>
      <td class="r-bar"><div class="r-bar-fill" style="width:${Math.max(0, Math.min(100, r.pct)).toFixed(0)}%"></div></td>
    </tr>`).join('');
  return `
<table class="r-table r-bar-table">
  <thead>
    <tr><th>${escapeHtml(headerLabel)}</th><th class="r-num">Stunden</th><th class="r-num">Anteil</th><th class="r-bar-head">Verteilung</th></tr>
  </thead>
  <tbody>${trs}</tbody>
</table>`;
}

function renderStakeholderProject(s: StakeholderProjectMatrix, narrative?: string): string {
  const stTab = renderBarTable('Stakeholder', s.stakeholders);
  const prTab = renderBarTable('Projekt', s.projects);

  const matrix = renderMatrix(s);

  return `
<section class="r-section">
  <h2 class="r-section-title">Stakeholder &amp; Projekte</h2>
  ${renderSectionNarrative(narrative)}
  ${stTab}
  ${prTab}
  <h3 class="r-subtitle">Stakeholder × Projekt</h3>
  ${matrix}
</section>`;
}

function renderMatrix(m: StakeholderProjectMatrix): string {
  if (m.matrixStakeholderOrder.length === 0 || m.matrixProjectOrder.length === 0) {
    return `<p class="r-empty">— keine Daten —</p>`;
  }
  const head = `<tr><th></th>${m.matrixProjectOrder.map((p) => `<th class="r-num">${escapeHtml(p)}</th>`).join('')}<th class="r-num">Total</th></tr>`;
  const rows = m.matrixStakeholderOrder.map((sh) => {
    const cells = m.matrixProjectOrder.map((pr) => {
      const v = m.matrix[sh]?.[pr] || 0;
      return `<td class="r-num">${v > 0 ? v.toFixed(1) : '·'}</td>`;
    }).join('');
    const total = m.matrixProjectOrder.reduce((s, pr) => s + (m.matrix[sh]?.[pr] || 0), 0);
    return `<tr><td class="r-name">${escapeHtml(sh)}</td>${cells}<td class="r-num r-total">${total.toFixed(1)}</td></tr>`;
  }).join('');
  return `<table class="r-table r-matrix"><thead>${head}</thead><tbody>${rows}</tbody></table>`;
}

function renderDriver(driver: DriverRow[], narrative?: string): string {
  if (driver.length === 0) {
    return `
<section class="r-section">
  <h2 class="r-section-title">Aufwandstreiber</h2>
  <p class="r-empty">— keine Daten —</p>
</section>`;
  }
  const trs = driver.map((d, idx) => `
    <tr>
      <td class="r-rank">${idx + 1}</td>
      <td class="r-name">${escapeHtml(d.label)}</td>
      <td class="r-num">${d.hours.toFixed(1)}h</td>
      <td class="r-num">${d.pct.toFixed(0)}%</td>
      <td class="r-num">${d.daysActive}</td>
    </tr>`).join('');
  return `
<section class="r-section">
  <h2 class="r-section-title">Aufwandstreiber</h2>
  ${renderSectionNarrative(narrative)}
  <p class="r-section-hint">Top-Kombinationen Stakeholder × Projekt nach Stunden, sortiert absteigend.</p>
  <table class="r-table r-driver">
    <thead>
      <tr><th>#</th><th>Stakeholder · Projekt</th><th class="r-num">Stunden</th><th class="r-num">Anteil</th><th class="r-num">Tage aktiv</th></tr>
    </thead>
    <tbody>${trs}</tbody>
  </table>
</section>`;
}

function renderComparison(c: PeriodComparison, narrative?: string): string {
  const fmtDelta = (delta: number, pct: number | null, isPercentMetric = false): string => {
    const sign = delta > 0 ? '+' : '';
    const abs = isPercentMetric ? `${sign}${delta.toFixed(1)} pp` : `${sign}${delta.toFixed(1)}`;
    const pctStr = pct === null ? '—' : `${sign}${pct.toFixed(0)}%`;
    return `${abs} · ${pctStr}`;
  };

  const trs = c.rows.map((r) => {
    const isPct = r.label === 'Produktivitätsquote';
    const cls = r.delta > 0 ? 'r-up' : r.delta < 0 ? 'r-down' : 'r-flat';
    return `
      <tr>
        <td class="r-name">${escapeHtml(r.label)}</td>
        <td class="r-num">${r.current.toFixed(1)}${isPct ? '%' : ''}</td>
        <td class="r-num r-prev">${r.previous.toFixed(1)}${isPct ? '%' : ''}</td>
        <td class="r-num ${cls}">${fmtDelta(r.delta, r.deltaPct, isPct)}</td>
      </tr>`;
  }).join('');

  const shifts = c.topShifts.map((s) => {
    const moveLabel = s.rankPrevious === null
      ? '↑ neu'
      : s.rankPrevious === s.rankCurrent
        ? '— gleich'
        : s.rankPrevious > s.rankCurrent
          ? `↑ +${s.rankPrevious - s.rankCurrent}`
          : `↓ ${s.rankCurrent - s.rankPrevious}`;
    return `
      <tr>
        <td class="r-rank">${s.rankCurrent}</td>
        <td class="r-name">${escapeHtml(s.name)}</td>
        <td class="r-num">${s.currentHours.toFixed(1)}h</td>
        <td class="r-num r-prev">${s.previousHours.toFixed(1)}h</td>
        <td class="r-num">${escapeHtml(moveLabel)}</td>
      </tr>`;
  }).join('');

  return `
<section class="r-section">
  <h2 class="r-section-title">Veränderung gegenüber ${escapeHtml(c.prevLabel)}</h2>
  ${renderSectionNarrative(narrative)}
  <p class="r-section-hint">Vergleichszeitraum: ${escapeHtml(formatDateRange(c.prevStart, c.prevEnd))}</p>
  <table class="r-table r-compare">
    <thead>
      <tr><th>Kennzahl</th><th class="r-num">Aktuell</th><th class="r-num r-prev">Vorzeitraum</th><th class="r-num">Δ · %</th></tr>
    </thead>
    <tbody>${trs}</tbody>
  </table>
  <h3 class="r-subtitle">Stakeholder-Ranking</h3>
  <table class="r-table r-compare">
    <thead>
      <tr><th>#</th><th>Stakeholder</th><th class="r-num">Aktuell</th><th class="r-num r-prev">Vorzeitraum</th><th class="r-num">Bewegung</th></tr>
    </thead>
    <tbody>${shifts || '<tr><td colspan="5" class="r-empty">—</td></tr>'}</tbody>
  </table>
</section>`;
}

function renderTimeline(t: { days: TimelineDay[]; weeks: TimelineWeek[] }, includeNotes: boolean, narrative?: string): string {
  const dayRows = t.days.map((d) => `
    <tr>
      <td class="r-name">${escapeHtml(d.weekday)} ${escapeHtml(formatShortDate(d.date))}</td>
      <td class="r-num">${d.hours.toFixed(1)}h</td>
      <td>${escapeHtml(d.dominantStakeholder || '—')} <span class="r-sep">›</span> ${escapeHtml(d.dominantProject || '—')}</td>
      ${includeNotes ? `<td class="r-notes">${d.notes.length > 0 ? d.notes.map(escapeHtml).join(' · ') : ''}</td>` : ''}
    </tr>`).join('');

  const weekRows = t.weeks.map((w) => `
    <tr>
      <td class="r-name">${escapeHtml(w.weekLabel)}</td>
      <td class="r-num">${w.totalHours.toFixed(1)}h</td>
      <td class="r-num">${w.days.length}</td>
      <td class="r-num">${(w.days.length > 0 ? w.totalHours / w.days.length : 0).toFixed(1)}h</td>
    </tr>`).join('');

  return `
<section class="r-section">
  <h2 class="r-section-title">Zeitverlauf</h2>
  ${renderSectionNarrative(narrative)}
  <h3 class="r-subtitle">Tagesweise</h3>
  <table class="r-table r-timeline">
    <thead>
      <tr><th>Tag</th><th class="r-num">Stunden</th><th>Schwerpunkt</th>${includeNotes ? '<th>Notizen</th>' : ''}</tr>
    </thead>
    <tbody>${dayRows || '<tr><td colspan="4" class="r-empty">—</td></tr>'}</tbody>
  </table>
  <h3 class="r-subtitle">Wochenweise</h3>
  <table class="r-table r-timeline">
    <thead>
      <tr><th>Woche</th><th class="r-num">Stunden</th><th class="r-num">Tage</th><th class="r-num">Ø/Tag</th></tr>
    </thead>
    <tbody>${weekRows || '<tr><td colspan="4" class="r-empty">—</td></tr>'}</tbody>
  </table>
</section>`;
}

function renderNotable(items: NotableItem[], narrative?: string): string {
  if (items.length === 0) {
    return `
<section class="r-section">
  <h2 class="r-section-title">Auffälligkeiten</h2>
  ${renderSectionNarrative(narrative)}
  <p class="r-empty">— keine Auffälligkeiten im Zeitraum —</p>
</section>`;
  }
  const trs = items.map((it) => {
    const kindLabel = it.kind === 'high' ? 'Mehrarbeit'
      : it.kind === 'low' ? 'Schwacher Tag'
      : it.kind === 'longSession' ? 'Lange Session'
      : 'Tagesserie';
    return `
      <tr>
        <td class="r-kind">${escapeHtml(kindLabel)}</td>
        <td class="r-name">${escapeHtml(it.label)}</td>
        <td class="r-num">${escapeHtml(it.value)}</td>
        <td class="r-detail">${escapeHtml(it.detail || '')}</td>
      </tr>`;
  }).join('');
  return `
<section class="r-section">
  <h2 class="r-section-title">Auffälligkeiten</h2>
  ${renderSectionNarrative(narrative)}
  <table class="r-table r-notable"><tbody>${trs}</tbody></table>
</section>`;
}

function renderFooter(d: ReportData): string {
  return `
<footer class="r-footer">
  <hr class="r-hr">
  <p>Generiert von Zeiterfassung · pseudonyme Erfassung · ${escapeHtml(formatDateTime(d.generatedAt))}</p>
  <p class="r-tiny">
    Berechnungslogik: Totals folgen dem Wall-Clock-Modell (überlappende Einträge zählen einmal);
    pro Dimension werden Stakeholder voll angerechnet (Multistakeholder-Einträge zählen für jeden Stakeholder einzeln).
    Datengrundlage siehe Hinweis am Anfang des Reports.
  </p>
</footer>`;
}

// ── CSS ──────────────────────────────────────────────────────────────

function renderCss(forWord: boolean): string {
  // Word does not respect modern CSS reliably. We use a more conservative
  // base in the Word path: explicit table widths, no flex, conservative
  // colors. Both paths share the same look but Word path strips effects.
  const base = `
body {
  font-family: 'Calibri', 'Helvetica Neue', Arial, sans-serif;
  color: #1a1814;
  background: #ffffff;
  font-size: 11pt;
  line-height: 1.45;
  margin: 0;
  padding: 0;
}
@page {
  size: A4;
  margin: 1.5cm 1.8cm;
}
.r-header {
  border-bottom: 2px solid #c9a962;
  padding-bottom: 12pt;
  margin-bottom: 18pt;
}
.r-header-line {
  font-size: 9pt;
  letter-spacing: 0.15em;
  text-transform: uppercase;
  color: #6f6a62;
  margin-bottom: 4pt;
}
.r-title {
  font-size: 22pt;
  font-weight: 700;
  margin: 0;
  color: #1a1814;
}
.r-header-meta {
  font-size: 10pt;
  color: #5f5d58;
  margin-top: 4pt;
}
.r-sep { color: #c9a962; padding: 0 4pt; }
.r-disclaimer {
  background: #fdf6e0;
  border: 1px solid #e5cf8b;
  border-left: 4px solid #c9a962;
  padding: 10pt 14pt;
  margin-bottom: 18pt;
  page-break-inside: avoid;
}
/* Management Summary — prominent prose block right after the disclaimer.
   Slightly heavier than disclaimer, slate-grey accent so it reads as
   "framing analysis" rather than "warning". */
.r-mgmt-summary {
  background: #f4f6fb;
  border: 1px solid #d6dceb;
  border-left: 4px solid #4a5b8a;
  padding: 12pt 16pt;
  margin-bottom: 18pt;
  page-break-inside: avoid;
}
.r-mgmt-tag {
  font-size: 9pt;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: #4a5b8a;
  margin-bottom: 5pt;
}
.r-mgmt-summary p {
  margin: 0 0 6pt 0;
  font-size: 10.5pt;
  line-height: 1.55;
  color: #2c3346;
}
.r-mgmt-summary p:last-child {
  margin-bottom: 0;
}
/* Per-section commentary block sits right after the section title.
   Visually subtle so it complements the data without overpowering it. */
.r-narrative {
  margin-bottom: 10pt;
  padding: 6pt 10pt;
  background: #fafaf7;
  border-left: 3px solid #c9a962;
  page-break-inside: avoid;
}
.r-narrative p {
  margin: 0 0 4pt 0;
  font-size: 10pt;
  line-height: 1.5;
  color: #3d3a35;
  font-style: italic;
}
.r-narrative p:last-child { margin-bottom: 0; }
.r-disclaimer-tag {
  font-size: 9pt;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: #8a6f1f;
  margin-bottom: 4pt;
}
.r-disclaimer p {
  margin: 0;
  font-size: 10pt;
  line-height: 1.5;
  color: #4d3f15;
}
.r-section {
  margin-bottom: 22pt;
  page-break-inside: avoid;
}
.r-section-title {
  font-size: 14pt;
  font-weight: 700;
  color: #1a1814;
  border-bottom: 1px solid #e8e5e0;
  padding-bottom: 4pt;
  margin: 0 0 10pt;
}
.r-section-hint {
  font-size: 9pt;
  color: #6f6a62;
  font-style: italic;
  margin: -6pt 0 8pt;
}
.r-subtitle {
  font-size: 11pt;
  font-weight: 600;
  color: #1a1814;
  margin: 12pt 0 6pt;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.r-table {
  width: 100%;
  border-collapse: collapse;
  margin-bottom: 8pt;
  font-size: 10pt;
}
.r-table th, .r-table td {
  padding: 5pt 7pt;
  border: 1px solid #e8e5e0;
  vertical-align: top;
}
.r-table th {
  background: #f6f5f2;
  font-weight: 700;
  text-align: left;
  color: #1a1814;
}
.r-table .r-num {
  text-align: right;
  font-variant-numeric: tabular-nums;
  font-family: 'Consolas', 'Menlo', monospace;
  white-space: nowrap;
}
.r-table .r-name {
  font-weight: 600;
}
.r-table .r-pct {
  color: #6f6a62;
}
.r-table .r-rank {
  font-weight: 700;
  color: #c9a962;
  text-align: center;
  width: 28pt;
}
.r-table .r-total {
  font-weight: 700;
  background: #f6f5f2;
}
.r-empty {
  color: #9a9491;
  font-style: italic;
  font-size: 10pt;
}
.r-footer {
  margin-top: 24pt;
  border-top: 1px solid #e8e5e0;
  padding-top: 10pt;
  font-size: 9pt;
  color: #6f6a62;
}
.r-hr { display: none; }
.r-tiny { font-size: 8.5pt; color: #9a9491; margin-top: 4pt; }

/* KPI grid */
.r-kpi-grid {
  width: 100%;
  border-collapse: separate;
  border-spacing: 6pt;
  margin: 0;
  table-layout: fixed;
}
.r-kpi {
  background: #f9f7f3;
  border: 1px solid #e8d8b0;
  padding: 8pt 10pt;
  vertical-align: top;
  border-radius: 4pt;
}
.r-kpi-value {
  font-size: 18pt;
  font-weight: 700;
  color: #1a1814;
  font-variant-numeric: tabular-nums;
  font-family: 'Consolas', 'Menlo', monospace;
  line-height: 1.1;
}
.r-kpi-label {
  font-size: 9pt;
  color: #5f5d58;
  margin-top: 3pt;
  font-weight: 600;
}
.r-kpi-hint {
  font-size: 8.5pt;
  color: #9a9491;
  margin-top: 2pt;
}

/* Bar visualisation in tables */
.r-bar-table th.r-bar-head { width: 28%; }
.r-bar {
  padding: 0 6pt;
}
.r-bar-fill {
  height: 8pt;
  background: #c9a962;
  border-radius: 2pt;
  display: inline-block;
  vertical-align: middle;
}

/* Comparison delta direction */
.r-up { color: #2e7d32; font-weight: 600; }
.r-down { color: #c62828; font-weight: 600; }
.r-flat { color: #6f6a62; }
.r-prev { color: #6f6a62; }
.r-detail { color: #5f5d58; font-size: 9pt; }
.r-kind {
  font-size: 9pt;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: #6f6a62;
  font-weight: 600;
}
.r-notes { color: #5f5d58; font-size: 9pt; }
`;
  if (forWord) {
    // Word ignores some CSS and renders a few tags oddly. Keep this
    // appendix tiny — most styles already work in Word.
    return base + `
.r-bar-fill { display: inline-block; }
.r-kpi-grid { border-spacing: 0; }
.r-kpi { padding: 6pt 8pt; }
`;
  }
  return base;
}

// ── Utilities ────────────────────────────────────────────────────────

function escapeHtml(s: string): string {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function formatShortDate(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.`;
}

function formatDateRange(start: string | null, end: string | null): string {
  if (!start || !end) return '—';
  return `${formatShortDate(start)} – ${formatShortDate(end)}`;
}
