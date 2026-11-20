#!/usr/bin/env node
/**
 * EduPage CLI - btop-style Terminal Monitor
 * Full-featured high-contrast interactive TUI with multi-tab navigation,
 * real-time schedule, Slovak GPA analytics, cafeteria menu, and homework viewer.
 */

// Fix drawille-canvas color mapping bug before loading blessed-contrib
const drawille = require('drawille-canvas-blessed-contrib');
drawille.colors = {
  black: 0,
  red: 1,
  green: 2,
  yellow: 3,
  blue: 4,
  magenta: 5,
  cyan: 6,
  white: 7,
};

const blessed = require('blessed');
const contrib = require('blessed-contrib');
const stripAnsi = require('strip-ansi');
const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

// Patch blessed-contrib Table formatting: prevents column collision, guarantees
// clean spacing between columns, and cleanly truncates long text with ellipses.
contrib.table.prototype.setData = function(table) {
  const self = this;
  const spacing = typeof self.options.columnSpacing === 'number' ? self.options.columnSpacing : 2;

  const dataToString = function(d) {
    let str = '';
    d.forEach(function(r, i) {
      const colsize = (self.options.columnWidth && self.options.columnWidth[i]) || 20;
      let raw = (r == null ? '' : r).toString();
      let strip = stripAnsi(raw);

      if (strip.length > colsize) {
        const visiblePart = colsize > 3 ? strip.slice(0, colsize - 1) + '…' : strip.slice(0, colsize);
        raw = visiblePart;
        strip = visiblePart;
      }

      const padNeeded = Math.max(0, colsize - strip.length);
      const pad = ' '.repeat(padNeeded);
      const gap = (i < d.length - 1) ? ' '.repeat(spacing) : '';

      str += raw + pad + gap;
    });
    return str;
  };

  const formatted = [];
  (table.data || []).forEach(function(d) {
    formatted.push(dataToString(d));
  });
  this.setContent(dataToString(table.headers || []));
  this.rows.setItems(formatted);
};

// Request terminal maximize on startup if supported
if (process.platform === 'win32') {
  try {
    process.stdout.write('\x1b[9;1t');
  } catch (e) {}
}

// ==============================================================================
// Screen Initialization
// ==============================================================================

const screen = blessed.screen({
  smartCSR: true,
  title: 'EDUPAGE BTOP MONITOR',
  fullUnicode: true,
  dockBorders: true,
  cursor: {
    artificial: true,
    shape: 'line',
    blink: true,
    color: 'white',
  },
});

// Navigation State
const TABS = ['monitor', 'timetable', 'grades', 'lunches', 'tasks'];
const TAB_LABELS = [
  ' 1: MONITOR ',
  ' 2: ROZVRH ',
  ' 3: ZNÁMKY ',
  ' 4: OBEDY ',
  ' 5: ÚLOHY ',
];
let activeTabIndex = 0;
let navFocus = 'topbar'; // 'topbar' | 'card'
let dashboardData = loadLocalCacheIfExists() || getInitialState();
let isFetching = false;

// ==============================================================================
// Top Header Box (Framed Master Header - Cyan Border)
// ==============================================================================

const headerBox = blessed.box({
  parent: screen,
  top: 0,
  left: 0,
  width: '100%',
  height: 5,
  tags: true,
  border: { type: 'line', fg: 'cyan' },
  label: ' [ EDUPAGE BTOP MONITOR - ssnd.edupage.org ] ',
  style: {
    border: { fg: 'cyan' },
    fg: 'white',
    bg: 'black',
  },
});

// ==============================================================================
// Bottom Footer Box (Framed Commands Bar - White Border)
// ==============================================================================

const footerBox = blessed.box({
  parent: screen,
  bottom: 0,
  left: 0,
  width: '100%',
  height: 3,
  tags: true,
  border: { type: 'line', fg: 'white' },
  label: ' [ OVLÁDANIE & SKRATKY ] ',
  style: {
    border: { fg: 'white' },
    fg: 'white',
    bg: 'black',
  },
  content: ' {bold}[1-5]{/bold} Výber karty  │  {bold}[← / →]{/bold} Prepínanie kariet  │  {bold}[Tab]{/bold} Prepínanie okien  │  {bold}[↑ / ↓]{/bold} Rolovanie tabuľky  │  {bold}[r]{/bold} Obnoviť  │  {bold}[q / Esc]{/bold} Koniec',
});

// ==============================================================================
// Content Container (Between Header and Footer)
// ==============================================================================

const contentArea = blessed.box({
  parent: screen,
  top: 5,
  left: 0,
  width: '100%',
  bottom: 3,
  style: {
    bg: 'black',
  },
});

// ==============================================================================
// TAB 1: MONITOR
// ==============================================================================

const viewMonitor = blessed.box({
  parent: contentArea,
  top: 0,
  left: 0,
  width: '100%',
  height: '100%',
  hidden: false,
});

const monitorGrid = new contrib.grid({ rows: 12, cols: 12, screen: viewMonitor });

// 1. Marks Trend (Braille line - Green Border)
const lineGraph = monitorGrid.set(0, 0, 5, 6, contrib.line, {
  label: ' [ VÝVOJ PRIEMERU (GPA TREND) ] ',
  showLegend: false,
  xPadding: 2,
  xLabelPadding: 1,
  wholeNumbersOnly: false,
  minY: 1.0,
  maxY: 3.5,
  border: { type: 'line', fg: 'green' },
  style: {
    line: 'green',
    text: 'green',
    baseline: 'black',
    border: { fg: 'green' },
  },
});

// 2. Marks Distribution (High-contrast btop-style horizontal meter - Cyan Border)
const distributionBox = monitorGrid.set(5, 0, 4, 6, blessed.box, {
  label: ' [ ROZDELENIE ZNÁMOK (1 - 5) ] ',
  tags: true,
  border: { type: 'line', fg: 'cyan' },
  style: {
    border: { fg: 'cyan' },
    fg: 'white',
    bg: 'black',
  },
});

// 3. Mini Lunch Box (Magenta Border)
const miniLunchBox = monitorGrid.set(9, 0, 3, 6, blessed.box, {
  label: ' [ DNEŠNÝ OBED ] ',
  tags: true,
  border: { type: 'line', fg: 'magenta' },
  style: {
    border: { fg: 'magenta' },
    fg: 'white',
    bg: 'black',
  },
});

// 4. Timetable Table (Yellow Border, Clean White on Black)
const timetableTable = monitorGrid.set(0, 6, 6, 6, contrib.table, {
  keys: true,
  interactive: true,
  label: ' [ DNEŠNÝ ROZVRH HODÍN ] ',
  border: { type: 'line', fg: 'yellow' },
  columnSpacing: 2,
  columnWidth: [4, 13, 26, 20, 10],
  headers: ['#', 'ČAS', 'PREDMET', 'UČITEĽ', 'STAV'],
  fg: 'white',
  selectedFg: 'black',
  selectedBg: 'white',
  style: {
    border: { fg: 'yellow' },
    header: { fg: 'cyan', bold: true },
  },
});

// 5. Current Lesson Progress Gauge (Green Border)
const lessonGauge = monitorGrid.set(6, 6, 2, 6, contrib.gauge, {
  label: ' [ PRIEBEH HODINY / PRESTÁVKA ] ',
  stroke: 'green',
  fill: 'white',
  border: { type: 'line', fg: 'green' },
  style: {
    border: { fg: 'green' },
  },
});

// 6. Mini Tasks Table (Cyan Border, Clean White on Black)
const miniTasksTable = monitorGrid.set(8, 6, 4, 6, contrib.table, {
  keys: true,
  interactive: true,
  label: ' [ AKTUÁLNE ZADANIA A PÍSOMKY ] ',
  border: { type: 'line', fg: 'cyan' },
  columnSpacing: 2,
  columnWidth: [11, 10, 18, 30],
  headers: ['TERMÍN', 'TYP', 'UČITEĽ', 'ZADANIE'],
  fg: 'white',
  selectedFg: 'black',
  selectedBg: 'white',
  style: {
    border: { fg: 'cyan' },
    header: { fg: 'cyan', bold: true },
  },
});

// ==============================================================================
// TAB 2: ROZVRH (Full-Screen EduPage Weekly Table + Left Control Sidebar)
// ==============================================================================

const viewTimetable = blessed.box({
  parent: contentArea,
  top: 0,
  left: 0,
  width: '100%',
  height: '100%',
  hidden: true,
});

const SIDEBAR_WIDTH = 34;

const timetableSidebar = blessed.box({
  parent: viewTimetable,
  top: 0,
  left: 0,
  width: SIDEBAR_WIDTH,
  height: '100%',
  tags: true,
  border: { type: 'line', fg: 'blue' },
  label: ' [ OVLÁDANIE ROZVRHU ] ',
  style: {
    border: { fg: 'blue' },
    fg: 'white',
    bg: 'black',
  },
});

const timetableMainBox = blessed.box({
  parent: viewTimetable,
  top: 0,
  left: SIDEBAR_WIDTH,
  width: `100%-${SIDEBAR_WIDTH}`,
  height: '100%',
  tags: true,
  scrollable: true,
  alwaysScroll: true,
  border: { type: 'line', fg: 'green' },
  label: ' [ TÝŽDENNÝ ROZVRH HODÍN ] ',
  style: {
    border: { fg: 'green' },
    fg: 'white',
    bg: 'black',
  },
});

// ==============================================================================
// TAB 3, 4, 5: EMPTY PLACEHOLDERS
// ==============================================================================

function createEmptyTabPlaceholder(labelText) {
  const container = blessed.box({
    parent: contentArea,
    top: 0,
    left: 0,
    width: '100%',
    height: '100%',
    hidden: true,
  });

  blessed.box({
    parent: container,
    top: 0,
    left: 0,
    width: '100%',
    height: '100%',
    tags: true,
    align: 'center',
    valign: 'middle',
    border: { type: 'line', fg: 'cyan' },
    label: ` [ ${labelText} ] `,
    style: {
      border: { fg: 'cyan' },
      fg: 'white',
      bg: 'black',
    },
    content: `{bold}{cyan-fg}${labelText}{/cyan-fg}{/bold}\n\n{white-fg}Karta je zatiaľ prázdna — bude doplnená neskôr.{/white-fg}`,
  });

  return container;
}

// ==============================================================================
// TAB 3: ZNÁMKY (Full-Screen Grades Overview, Per-Subject Tables & Pochvaly/Poznámky)
// ==============================================================================

const viewGrades = blessed.box({
  parent: contentArea,
  top: 0,
  left: 0,
  width: '100%',
  height: '100%',
  hidden: true,
});

const gradesSidebar = blessed.box({
  parent: viewGrades,
  top: 0,
  left: 0,
  width: SIDEBAR_WIDTH,
  height: '100%',
  tags: true,
  border: { type: 'line', fg: 'blue' },
  label: ' [ PREHĽAD & PREDMETY ] ',
  style: {
    border: { fg: 'blue' },
    fg: 'white',
    bg: 'black',
  },
});

const gradesMainBox = blessed.box({
  parent: viewGrades,
  top: 0,
  left: SIDEBAR_WIDTH,
  width: `100%-${SIDEBAR_WIDTH}`,
  height: '100%',
  tags: true,
  scrollable: true,
  alwaysScroll: true,
  border: { type: 'line', fg: 'green' },
  label: ' [ ZNÁMKY A HODNOTENIE ] ',
  style: {
    border: { fg: 'green' },
    fg: 'white',
    bg: 'black',
  },
});

// ==============================================================================
// TAB 4, 5: EMPTY PLACEHOLDERS
// ==============================================================================

const viewLunches = createEmptyTabPlaceholder('4: OBEDY');
const viewTasks = createEmptyTabPlaceholder('5: ÚLOHY');

// View Containers & Focusable Widgets Registry
const VIEW_CONTAINERS = [viewMonitor, viewTimetable, viewGrades, viewLunches, viewTasks];

const TAB_WIDGETS = [
  [timetableTable, miniTasksTable],
  [],
  [],
  [],
  [],
];
let activeWidgetIndex = 0;

// ==============================================================================
// Tab Navigation
// ==============================================================================

function hasCardSidebar(tabIdx = activeTabIndex) {
  return tabIdx === 1 || tabIdx === 2;
}

function updateFooter() {
  if (hasCardSidebar(activeTabIndex)) {
    if (navFocus === 'topbar') {
      footerBox.setContent(
        ' {bold}{cyan-fg}[HORNÁ LIŠTA]{/cyan-fg}{/bold}  {bold}[1-5 / ← / →]{/bold} Karty  │  {bold}[↓]{/bold} Vstúpiť do bočného panela karty  │  {bold}[r]{/bold} Obnoviť  │  {bold}[q / Esc]{/bold} Koniec'
      );
    } else if (activeTabIndex === 1) {
      footerBox.setContent(
        ' {bold}{yellow-fg}[ĽAVÁ LIŠTA - ROZVRH]{/yellow-fg}{/bold}  {bold}[↑ / ↓]{/bold} Voľba položky ({bold}↑ hore{/bold} = späť na karty)  │  {bold}[← / → / Enter]{/bold} Prepínať Aktuálny/Stály  │  {bold}[r]{/bold} Obnoviť  │  {bold}[q]{/bold} Koniec'
      );
    } else {
      footerBox.setContent(
        ' {bold}{yellow-fg}[ĽAVÁ LIŠTA - ZNÁMKY]{/yellow-fg}{/bold}  {bold}[↑ / ↓]{/bold} Prehľad / Pochvaly / Predmety ({bold}↑ hore{/bold} = späť na karty)  │  {bold}[← / →]{/bold} Rolovať tabuľku  │  {bold}[r]{/bold} Obnoviť  │  {bold}[q]{/bold} Koniec'
      );
    }
  } else {
    footerBox.setContent(
      ' {bold}[1-5]{/bold} Výber karty  │  {bold}[← / →]{/bold} Prepínanie kariet  │  {bold}[Tab]{/bold} Prepínanie okien  │  {bold}[↑ / ↓]{/bold} Rolovanie tabuľky  │  {bold}[r]{/bold} Obnoviť  │  {bold}[q / Esc]{/bold} Koniec'
    );
  }
}

function switchTab(index) {
  if (index < 0) index = TABS.length - 1;
  if (index >= TABS.length) index = 0;

  activeTabIndex = index;
  activeWidgetIndex = 0;
  navFocus = 'topbar';

  VIEW_CONTAINERS.forEach((c, idx) => {
    if (idx === activeTabIndex) {
      c.show();
    } else {
      c.hide();
    }
  });

  updateHeader();
  updateFooter();

  if (activeTabIndex === 1) {
    renderTimetableCard();
    timetableSidebar.focus();
  } else if (activeTabIndex === 2) {
    renderGradesCard();
    gradesSidebar.focus();
  } else {
    const currentTabWidgets = TAB_WIDGETS[activeTabIndex];
    if (currentTabWidgets && currentTabWidgets.length > 0) {
      currentTabWidgets[0].focus();
    } else {
      VIEW_CONTAINERS[activeTabIndex].focus();
    }
  }

  screen.render();
}

// ==============================================================================
// Data Binding & Widget Updates
// ==============================================================================

function updateHeader() {
  const now = new Date();
  const timeStr = now.toTimeString().split(' ')[0];

  const user = dashboardData.user || 'Jakub Gallik';
  const school = dashboardData.school || 'ssnd.edupage.org';
  const nextBell = dashboardData.next_bell || '-';
  const gpa = dashboardData.gpa || '-';
  const standing = dashboardData.standing || '-';

  const standingColor = standing.includes('vyznamenan')
    ? '{green-fg}'
    : standing.includes('veľmi')
    ? '{cyan-fg}'
    : standing === 'Neprospel'
    ? '{red-fg}'
    : '{white-fg}';

  const statusBadge = isFetching
    ? '{yellow-fg}[SYNCING...]{/yellow-fg}'
    : '{green-fg}[ONLINE]{/green-fg}';

  const isTopFocused = navFocus === 'topbar' || !hasCardSidebar(activeTabIndex);
  headerBox.style.border.fg = isTopFocused ? 'cyan' : 'blue';
  headerBox.setLabel(' [ EDUPAGE BTOP MONITOR - ' + school + ' ] ');

  const tabButtons = TAB_LABELS.map((label, idx) => {
    if (idx === activeTabIndex) {
      return `{blue-bg}{white-fg}{bold}${label}{/bold}{/white-fg}{/blue-bg}`;
    }
    return `{cyan-fg}[${label.trim()}]{/cyan-fg}`;
  }).join('   ');

  const navHint = hasCardSidebar(activeTabIndex)
    ? (isTopFocused ? '  {yellow-fg}(↓ Vstúpiť do bočného panela){/yellow-fg}' : '  {yellow-fg}(BOČNÝ PANEL AKTÍVNY │ ↑ späť hore){/yellow-fg}')
    : '';

  headerBox.setContent(
    ` {bold}POUŽÍVATEĽ:{/bold} ${user}  │  {bold}PRIEMER:{/bold} {green-fg}{bold}${gpa}{/bold}{/green-fg}  │  {bold}PROSPECH:{/bold} ${standingColor}${standing}{/}  │  {bold}ZVONENIE:{/bold} {yellow-fg}${nextBell}{/yellow-fg}  │  {bold}ČAS:{/bold} ${timeStr}  ${statusBadge}\n` +
    ` {bold}KARTY:{/bold}  ${tabButtons}${navHint}`
  );
}

// ==============================================================================
// Helpers: Periods, Breaks & Live School Clock State
// ==============================================================================

const DEFAULT_PERIODS = [
  { period: '1', start: '07:55', end: '08:40', start_sec: 28500, end_sec: 31200 },
  { period: '2', start: '08:45', end: '09:30', start_sec: 31500, end_sec: 34200 },
  { period: '3', start: '09:40', end: '10:25', start_sec: 34800, end_sec: 37500 },
  { period: '4', start: '10:40', end: '11:25', start_sec: 38400, end_sec: 41100 },
  { period: '5', start: '11:30', end: '12:15', start_sec: 41400, end_sec: 44100 },
  { period: '6', start: '12:20', end: '13:05', start_sec: 44400, end_sec: 47100 },
  { period: '7', start: '13:35', end: '14:20', start_sec: 48900, end_sec: 51600 },
  { period: '8', start: '14:25', end: '15:10', start_sec: 51900, end_sec: 54600 },
];

const DEFAULT_BREAKS = [
  { id: '1-2', after_period: '1', before_period: '2', between: '1. ➔ 2. hodina', start: '08:40', end: '08:45', start_sec: 31200, end_sec: 31500, duration_min: 5, name: 'Malá prestávka' },
  { id: '2-3', after_period: '2', before_period: '3', between: '2. ➔ 3. hodina', start: '09:30', end: '09:40', start_sec: 34200, end_sec: 34800, duration_min: 10, name: 'Desiatová prestávka' },
  { id: '3-4', after_period: '3', before_period: '4', between: '3. ➔ 4. hodina', start: '10:25', end: '10:40', start_sec: 37500, end_sec: 38400, duration_min: 15, name: 'Veľká prestávka' },
  { id: '4-5', after_period: '4', before_period: '5', between: '4. ➔ 5. hodina', start: '11:25', end: '11:30', start_sec: 41100, end_sec: 41400, duration_min: 5, name: 'Malá prestávka' },
  { id: '5-6', after_period: '5', before_period: '6', between: '5. ➔ 6. hodina', start: '12:15', end: '12:20', start_sec: 44100, end_sec: 44400, duration_min: 5, name: 'Malá prestávka' },
  { id: '6-7', after_period: '6', before_period: '7', between: '6. ➔ 7. hodina', start: '13:05', end: '13:35', start_sec: 47100, end_sec: 48900, duration_min: 30, name: 'Obedná prestávka' },
  { id: '7-8', after_period: '7', before_period: '8', between: '7. ➔ 8. hodina', start: '14:20', end: '14:25', start_sec: 51600, end_sec: 51900, duration_min: 5, name: 'Malá prestávka' },
];

function getPeriodsSchedule() {
  const list = dashboardData.periods_schedule;
  return Array.isArray(list) && list.length >= 8 ? list : DEFAULT_PERIODS;
}

function getBreaksSchedule() {
  const list = dashboardData.breaks_schedule;
  return Array.isArray(list) && list.length > 0 ? list : DEFAULT_BREAKS;
}

function fitPlain(text, maxLen) {
  const clean = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  if (maxLen <= 0) return '';
  if (clean.length <= maxLen) return clean;
  return maxLen > 2 ? clean.slice(0, maxLen - 1) + '…' : clean.slice(0, maxLen);
}

function padVis(text, width, align = 'left') {
  const s = fitPlain(text, width);
  const diff = Math.max(0, width - s.length);
  if (align === 'center') {
    const left = Math.floor(diff / 2);
    return ' '.repeat(left) + s + ' '.repeat(diff - left);
  }
  if (align === 'right') {
    return ' '.repeat(diff) + s;
  }
  return s + ' '.repeat(diff);
}

function getLiveSchoolState(now = new Date()) {
  const nowSec = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();
  const jsDay = now.getDay();
  const todayIdx = (jsDay >= 1 && jsDay <= 5) ? jsDay - 1 : -1;
  const periods = getPeriodsSchedule();
  const breaks = getBreaksSchedule();

  const bellPeriod = periods.find((p) => p.start_sec != null && p.end_sec != null && nowSec >= p.start_sec && nowSec <= p.end_sec) || null;
  const bellBreak = breaks.find((b) => b.start_sec != null && b.end_sec != null && nowSec >= b.start_sec && nowSec <= b.end_sec) || null;

  const tt = dashboardData.timetable || [];
  const parsedLessons = tt.map((l) => {
    let startSec = l.start_sec;
    let endSec = l.end_sec;
    if (startSec == null && l.time && l.time.includes('-')) {
      const parts = l.time.split('-');
      const [sh, sm] = parts[0].trim().split(':').map(Number);
      const [eh, em] = parts[1].trim().split(':').map(Number);
      startSec = sh * 3600 + sm * 60;
      endSec = eh * 3600 + em * 60;
    }
    return { ...l, startSec, endSec };
  });

  const activeLessons = parsedLessons.filter(
    (l) => l.startSec != null && l.endSec != null && l.status !== 'ODPADLA' && l.status !== 'VOĽNO'
  );

  let mode = 'FREE';
  let currentLesson = null;
  let nextLesson = null;
  let prevLesson = null;
  let pct = 0;
  let remMin = 0;

  if (activeLessons.length > 0) {
    const firstLesson = activeLessons[0];
    const lastLesson = activeLessons[activeLessons.length - 1];

    for (let i = 0; i < activeLessons.length; i++) {
      const l = activeLessons[i];
      if (nowSec >= l.startSec && nowSec <= l.endSec) {
        currentLesson = l;
        nextLesson = activeLessons[i + 1] || null;
        break;
      }
      if (nowSec < l.startSec) {
        nextLesson = l;
        prevLesson = activeLessons[i - 1] || null;
        break;
      }
      prevLesson = l;
    }

    if (nowSec < firstLesson.startSec) {
      mode = 'BEFORE';
      remMin = Math.ceil((firstLesson.startSec - nowSec) / 60);
      pct = 0;
    } else if (currentLesson) {
      mode = 'LESSON';
      const totalSec = Math.max(1, currentLesson.endSec - currentLesson.startSec);
      const elapsedSec = Math.max(0, nowSec - currentLesson.startSec);
      remMin = Math.ceil(Math.max(0, currentLesson.endSec - nowSec) / 60);
      pct = Math.max(0, Math.min(100, Math.round((elapsedSec / totalSec) * 100)));
    } else if (nowSec > lastLesson.endSec) {
      mode = 'AFTER';
      pct = 100;
    } else if (prevLesson && nextLesson) {
      mode = 'BREAK';
      const totalBreak = Math.max(1, nextLesson.startSec - prevLesson.endSec);
      const elapsedBreak = Math.max(0, nowSec - prevLesson.endSec);
      remMin = Math.ceil(Math.max(0, nextLesson.startSec - nowSec) / 60);
      pct = Math.max(0, Math.min(100, Math.round((elapsedBreak / totalBreak) * 100)));
    }
  } else {
    pct = 100;
  }

  return {
    nowSec,
    todayIdx,
    bellPeriod,
    bellBreak,
    parsedLessons,
    activeLessons,
    mode,
    currentLesson,
    nextLesson,
    prevLesson,
    pct,
    remMin,
  };
}

function updateLiveProgress() {
  const live = getLiveSchoolState();
  const { nowSec, parsedLessons, activeLessons, mode, currentLesson, nextLesson, prevLesson, pct, remMin } = live;

  if (parsedLessons.length === 0) {
    lessonGauge.setLabel(' [ ROZVRH: Žiadne naplánované hodiny ] ');
    lessonGauge.setPercent(0);
  } else if (activeLessons.length === 0) {
    lessonGauge.setLabel(' [ VOĽNÝ DEŇ: Žiadne vyučovanie ] ');
    lessonGauge.setPercent(100);
  } else if (mode === 'BEFORE') {
    const firstLesson = activeLessons[0];
    const startStr = firstLesson.start || (firstLesson.time ? firstLesson.time.split('-')[0] : '08:45');
    lessonGauge.setLabel(` [ PRED VYUČOVANÍM: 1. hodina ${firstLesson.subject} začína o ${startStr} (zostáva ${remMin} min) ] `);
    lessonGauge.setPercent(0);
  } else if (mode === 'LESSON' && currentLesson) {
    lessonGauge.setLabel(` [ PREBIEHA: ${currentLesson.subject} (${currentLesson.time}) │ ${pct}% │ zostáva ${remMin} min ] `);
    lessonGauge.setPercent(pct);
  } else if (mode === 'AFTER') {
    lessonGauge.setLabel(' [ KONIEC VYUČOVANIA: Dnes absolvované všetky hodiny │ Voľno ] ');
    lessonGauge.setPercent(100);
  } else if (mode === 'BREAK' && prevLesson && nextLesson) {
    const totalBreak = Math.max(1, nextLesson.startSec - prevLesson.endSec);
    const breakType = totalBreak >= 900 ? 'VEĽKÁ PRESTÁVKA' : 'PRESTÁVKA';
    const nextStart = nextLesson.start || (nextLesson.time ? nextLesson.time.split('-')[0] : '');
    const nextRoom = nextLesson.room && nextLesson.room !== '-' ? ` (${nextLesson.room})` : '';
    lessonGauge.setLabel(` [ ${breakType}: do ${nextStart} │ Nasleduje: ${nextLesson.subject}${nextRoom} │ ${pct}% │ zostáva ${remMin} min ] `);
    lessonGauge.setPercent(pct);
  }

  // Live update monitor timetable table
  const updatedTtRows = parsedLessons.map((l) => {
    let st = l.status;
    if (l.status === 'ODPADLA') {
      st = 'ODPADLA';
    } else if (l.status === 'VOĽNO') {
      st = 'VOĽNO';
    } else if (currentLesson && l.period === currentLesson.period && l.subject === currentLesson.subject) {
      st = '>> TERAZ';
    } else if (nextLesson && l.period === nextLesson.period && l.subject === nextLesson.subject) {
      st = '> NA RADE';
    } else if (l.endSec != null && nowSec > l.endSec) {
      st = 'HOTOVO';
    } else {
      st = 'PLÁN';
    }
    return [
      l.period || '-',
      l.time || '-',
      l.subject || '-',
      l.teacher || '-',
      st,
    ];
  });

  timetableTable.setData({
    headers: ['#', 'ČAS', 'PREDMET', 'UČITEĽ', 'STAV'],
    data: updatedTtRows.length > 0 ? updatedTtRows : [['-', '-', 'Dnes nie sú naplánované žiadne hodiny', '-', '-']],
  });
}

// ==============================================================================
// TAB 2 (ROZVRH): Sidebar State, Navigation & Full-Screen Renderers
// ==============================================================================

let ttSection = 'HODINY';      // 'HODINY' | 'PRESTAVKY'
let ttScope = 'WEEK';          // 'WEEK' | 0 | 1 | 2 | 3 | 4
let ttVariant = 'ACTUAL';      // 'ACTUAL' | 'REGULAR'
let sidebarCursor = 0;         // 0..7

const SIDEBAR_ITEMS = [
  { id: 'WEEK', label: 'HODINY --- CELÝ TÝŽDEŇ' },
  { id: 'DAY_0', label: 'Pondelok', dayIdx: 0 },
  { id: 'DAY_1', label: 'Utorok', dayIdx: 1 },
  { id: 'DAY_2', label: 'Streda', dayIdx: 2 },
  { id: 'DAY_3', label: 'Štvrtok', dayIdx: 3 },
  { id: 'DAY_4', label: 'Piatok', dayIdx: 4 },
  { id: 'TYP_TOGGLE', label: 'TYP ROZVRHU' },
  { id: 'PRESTAVKY', label: 'PRESTÁVKY (Rozpis)' },
];

function applySidebarItem(cursorIdx, isToggle = false) {
  const item = SIDEBAR_ITEMS[cursorIdx];
  if (!item) return;

  if (item.id === 'WEEK') {
    ttSection = 'HODINY';
    ttScope = 'WEEK';
    if (isToggle) ttVariant = ttVariant === 'ACTUAL' ? 'REGULAR' : 'ACTUAL';
  } else if (typeof item.dayIdx === 'number') {
    ttSection = 'HODINY';
    ttScope = item.dayIdx;
    if (isToggle) ttVariant = ttVariant === 'ACTUAL' ? 'REGULAR' : 'ACTUAL';
  } else if (item.id === 'TYP_TOGGLE') {
    ttSection = 'HODINY';
    if (isToggle) ttVariant = ttVariant === 'ACTUAL' ? 'REGULAR' : 'ACTUAL';
  } else if (item.id === 'PRESTAVKY') {
    ttSection = isToggle && ttSection === 'PRESTAVKY' ? 'HODINY' : 'PRESTAVKY';
  }
}

function getWeekDataByVariant(variant) {
  if (variant === 'REGULAR' && dashboardData.regular_week_timetable && Object.keys(dashboardData.regular_week_timetable).length > 0) {
    return dashboardData.regular_week_timetable;
  }
  return dashboardData.week_timetable || {};
}

function padRawLine(text, width) {
  const s = String(text == null ? '' : text);
  if (s.length <= width) return s + ' '.repeat(width - s.length);
  return s.slice(0, width - 1) + '…';
}

function renderTimetableSidebar(live) {
  const isFocused = activeTabIndex === 1 && navFocus === 'card';
  timetableSidebar.style.border.fg = isFocused ? 'yellow' : 'cyan';
  timetableSidebar.setLabel(isFocused ? ' [ ĽAVÁ LIŠTA (AKTÍVNA) ] ' : ' [ ĽAVÁ LIŠTA (↓ Vstup) ] ');

  const weekMap = getWeekDataByVariant(ttVariant);
  const dayKeys = Object.keys(weekMap).sort();
  const { todayIdx, mode, currentLesson, nextLesson, bellPeriod, bellBreak, remMin } = live;

  const lines = [];

  // 1. Live Clock Status Banner (High-contrast bright foreground on black/blue)
  lines.push(' {bold}{cyan-fg}══ AKTUÁLNE PRÁVE TERAZ ══{/cyan-fg}{/bold}');
  if (mode === 'LESSON' && currentLesson) {
    const roomStr = currentLesson.room && currentLesson.room !== '-' ? currentLesson.room : '-';
    const hdr = ` ● ${currentLesson.period}. HODINA: ${currentLesson.subject_short || currentLesson.subject}`;
    lines.push(` {blue-bg}{white-fg}{bold}${padRawLine(hdr, 30)}{/bold}{/white-fg}{/blue-bg}`);
    lines.push(` {green-fg}{bold}${fitPlain(currentLesson.subject, 30)}{/bold}{/green-fg}`);
    lines.push(` {white-fg}Čas: ${currentLesson.time} (ešte ${remMin} min){/white-fg}`);
    lines.push(` {cyan-fg}Učebňa: ${fitPlain(roomStr, 22)}{/cyan-fg}`);
  } else if (mode === 'BREAK' && nextLesson) {
    const durBreak = bellBreak ? `${bellBreak.duration_min} min` : '';
    const bTitle = bellBreak ? `${bellBreak.after_period}.➔${bellBreak.before_period}.` : 'PRESTÁVKA';
    const hdr = ` ● PRESTÁVKA ${bTitle}${durBreak ? ' (' + durBreak + ')' : ''}`;
    lines.push(` {blue-bg}{yellow-fg}{bold}${padRawLine(hdr, 30)}{/bold}{/yellow-fg}{/blue-bg}`);
    lines.push(` {yellow-fg}{bold}Nasleduje: ${fitPlain(nextLesson.subject, 19)}{/bold}{/yellow-fg}`);
    lines.push(` {white-fg}Začiatok o ${nextLesson.start || '-'} (za ${remMin} min){/white-fg}`);
  } else if (bellPeriod) {
    const hdr = ` ● ${bellPeriod.period}. HODINA (${bellPeriod.start}-${bellPeriod.end})`;
    lines.push(` {blue-bg}{white-fg}{bold}${padRawLine(hdr, 30)}{/bold}{/white-fg}{/blue-bg}`);
    lines.push(' {cyan-fg}Aktuálne máš voľno / odpadla{/cyan-fg}');
  } else if (bellBreak) {
    const hdr = ` ● PRESTÁVKA ${bellBreak.between}`;
    lines.push(` {blue-bg}{yellow-fg}{bold}${padRawLine(hdr, 30)}{/bold}{/yellow-fg}{/blue-bg}`);
    lines.push(` {white-fg}${bellBreak.name} (${bellBreak.duration_min} min){/white-fg}`);
  } else if (mode === 'BEFORE' && nextLesson) {
    lines.push(' {cyan-fg}{bold}● PRED VYUČOVANÍM{/bold}{/cyan-fg}');
    lines.push(` {white-fg}1. hod o ${nextLesson.start || '-'} (za ${remMin} min){/white-fg}`);
  } else {
    lines.push(' {cyan-fg}● MIMO VYUČOVANIA (Voľno){/cyan-fg}');
  }

  lines.push('{cyan-fg}────────────────────────────────{/cyan-fg}');
  lines.push(' {bold}{white-fg}MENU ZOBRAZENIA:{/white-fg}{/bold}');

  // 2. Interactive Sidebar Menu Items (High contrast: white-on-blue cursor)
  SIDEBAR_ITEMS.forEach((item, idx) => {
    const cursorHere = isFocused && sidebarCursor === idx;
    const isDay = typeof item.dayIdx === 'number';
    const isToday = isDay && item.dayIdx === todayIdx;

    if (idx === 6) {
      lines.push('{cyan-fg}────────────────────────────────{/cyan-fg}');
      lines.push(' {bold}{white-fg}TYP ROZVRHU (←/→/Enter):{/white-fg}{/bold}');
    }
    if (idx === 7) {
      lines.push('{cyan-fg}────────────────────────────────{/cyan-fg}');
    }

    let active = false;
    if (item.id === 'WEEK') active = ttSection === 'HODINY' && ttScope === 'WEEK';
    else if (isDay) active = ttSection === 'HODINY' && ttScope === item.dayIdx;
    else if (item.id === 'TYP_TOGGLE') active = ttSection === 'HODINY';
    else if (item.id === 'PRESTAVKY') active = ttSection === 'PRESTAVKY';

    if (item.id === 'TYP_TOGGLE') {
      const modeStr = ttVariant === 'ACTUAL'
        ? ' ◉ Aktuálny  ○ Stály'
        : ' ○ Aktuálny  ◉ Stály';
      if (cursorHere) {
        lines.push(`{blue-bg}{white-fg}{bold}${padRawLine(modeStr, 32)}{/bold}{/white-fg}{/blue-bg}`);
      } else {
        const col = ttVariant === 'ACTUAL' ? 'green-fg' : 'yellow-fg';
        lines.push(`{${col}}{bold}${padRawLine(modeStr, 32)}{/bold}{/${col}}`);
      }
      return;
    }

    let rawText = item.label;
    if (isToday) rawText += ' [DNES]';

    let formattedLine;
    if (isDay) {
      const branch = item.dayIdx === 4 ? '└─' : '├─';
      formattedLine = active ? ` ▶ ${branch} ${rawText}` : `   ${branch} ${rawText}`;
    } else {
      formattedLine = active ? ` ▶ ${rawText}` : `   ${rawText}`;
    }

    if (cursorHere) {
      lines.push(`{blue-bg}{white-fg}{bold}${padRawLine(formattedLine, 32)}{/bold}{/white-fg}{/blue-bg}`);
    } else if (active) {
      const activeCol = item.id === 'PRESTAVKY' ? 'yellow-fg' : 'green-fg';
      lines.push(`{${activeCol}}{bold}${padRawLine(formattedLine, 32)}{/bold}{/${activeCol}}`);
    } else if (isToday) {
      lines.push(`{cyan-fg}{bold}${padRawLine(formattedLine, 32)}{/bold}{/cyan-fg}`);
    } else {
      lines.push(`{white-fg}${padRawLine(formattedLine, 32)}{/white-fg}`);
    }
  });

  // 3. Live Compact Bell Timeline (Always highlights active period or break with high contrast)
  lines.push('{cyan-fg}────────────────────────────────{/cyan-fg}');
  lines.push(' {bold}{white-fg}DNES ZVONENIA (HOD/PREST.):{/white-fg}{/bold}');
  const periods = getPeriodsSchedule();
  const breaks = getBreaksSchedule();
  const todayKey = todayIdx >= 0 ? dayKeys[todayIdx] : null;
  const todayLessons = todayKey && weekMap[todayKey] ? weekMap[todayKey].lessons : [];

  periods.forEach((p, idx) => {
    const les = todayLessons.find((l) => String(l.period) === String(p.period));
    const isNowPeriod = bellPeriod && String(bellPeriod.period) === String(p.period);
    const subjTxt = les
      ? (les.is_cancelled ? `${les.subject_short}[ODP]` : les.subject_short)
      : '---';
    const pLine = `${p.period}. ${p.start}-${p.end} ${subjTxt}`;
    if (isNowPeriod) {
      lines.push(` {blue-bg}{white-fg}{bold}${padRawLine('▶ ' + pLine + ' [TERAZ]', 30)}{/bold}{/white-fg}{/blue-bg}`);
    } else {
      const col = les && les.is_cancelled ? 'red-fg' : (les ? 'white-fg' : 'cyan-fg');
      lines.push(` {${col}}  ${fitPlain(pLine, 28)}{/${col}}`);
    }

    const br = breaks[idx];
    if (br) {
      const isNowBreak = bellBreak && bellBreak.id === br.id;
      if (isNowBreak) {
        const bText = `▶ PREST. ${br.start}-${br.end} (${br.duration_min}m)`;
        lines.push(` {blue-bg}{yellow-fg}{bold}${padRawLine(bText, 30)}{/bold}{/yellow-fg}{/blue-bg}`);
      }
    }
  });

  timetableSidebar.setContent(lines.join('\n'));
}

function renderWeeklyGrid(live) {
  const weekMap = getWeekDataByVariant(ttVariant);
  const dayKeys = Object.keys(weekMap).sort();
  const periods = getPeriodsSchedule();
  const { todayIdx, bellPeriod, bellBreak, mode } = live;

  const boxWidth = timetableMainBox.width && timetableMainBox.width > 40 ? timetableMainBox.width : Math.max(80, screen.width - SIDEBAR_WIDTH);
  const innerW = Math.max(84, boxWidth - 3);
  const dayColW = 10;
  const colW = Math.max(9, Math.floor((innerW - dayColW - 10) / 8));
  const compactMode = colW < 11;

  const variantBanner = ttVariant === 'ACTUAL'
    ? '{green-fg}{bold}REŽIM: AKTUÁLNY ROZVRH (vrátane zmien a odpadnutí){/bold}{/green-fg}'
    : '{yellow-fg}{bold}REŽIM: STACIONÁRNY ROZVRH (stály základný rozvrh bez zmien){/bold}{/yellow-fg}';

  const liveNote = bellBreak
    ? `{yellow-fg}{bold}Prebieha prestávka ${bellBreak.between} (${bellBreak.start}-${bellBreak.end}){/bold}{/yellow-fg}`
    : (bellPeriod
      ? `{green-fg}{bold}Aktuálne zvonenie: ${bellPeriod.period}. hodina (${bellPeriod.start}-${bellPeriod.end}){/bold}{/green-fg}`
      : '{cyan-fg}Mimo vyučovania{/cyan-fg}');

  const out = [];
  out.push(` ${variantBanner}   │   ${liveNote}`);
  out.push(' {white-fg}Bunka: [Skratka] / Čas od-do / Trieda (Učebňa) / Učiteľ   │   Legenda: {red-fg}{bold}ODP=Odpadla{/bold}{/red-fg} {yellow-fg}{bold}ZMN=Zmena{/bold}{/yellow-fg} {cyan-fg}{bold}UDL=Udalosť{/bold}{/cyan-fg}{/white-fg}');

  const hLine = (left, mid, right, fill = '─') => {
    const segs = [fill.repeat(dayColW)];
    for (let i = 0; i < 8; i++) segs.push(fill.repeat(colW));
    return left + segs.join(mid) + right;
  };

  // Header row (Period number + time)
  out.push(`{cyan-fg}${hLine('┌', '┬', '┐')}{/cyan-fg}`);
  let hdr1 = '{cyan-fg}│{/cyan-fg}' + `{bold}{white-fg}${padVis('DEŇ', dayColW, 'center')}{/white-fg}{/bold}`;
  let hdr2 = '{cyan-fg}│{/cyan-fg}' + ' '.repeat(dayColW);

  periods.forEach((p) => {
    const isNowP = bellPeriod && String(bellPeriod.period) === String(p.period);
    const pLabel = compactMode ? `${p.period}. HOD` : `${p.period}. HODINA`;
    const tLabel = compactMode ? `${p.start.replace(/^0/, '')}-${p.end.replace(/^0/, '')}` : `${p.start}-${p.end}`;
    const hdrTag = isNowP ? '{blue-bg}{white-fg}{bold}' : '{cyan-fg}{bold}';
    const timeTag = isNowP ? '{blue-bg}{yellow-fg}{bold}' : '{white-fg}';
    hdr1 += '{cyan-fg}│{/cyan-fg}' + `${hdrTag}${padVis(pLabel, colW, 'center')}{/}`;
    hdr2 += '{cyan-fg}│{/cyan-fg}' + `${timeTag}${padVis(tLabel, colW, 'center')}{/}`;
  });
  hdr1 += '{cyan-fg}│{/cyan-fg}';
  hdr2 += '{cyan-fg}│{/cyan-fg}';
  out.push(hdr1);
  out.push(hdr2);
  out.push(`{cyan-fg}${hLine('├', '┼', '┤')}{/cyan-fg}`);

  // 5 Day Rows
  const defaultDayNames = ['Pondelok', 'Utorok', 'Streda', 'Štvrtok', 'Piatok'];
  for (let dIdx = 0; dIdx < 5; dIdx++) {
    const dKey = dayKeys[dIdx];
    const dInfo = dKey ? weekMap[dKey] : null;
    const dayName = dInfo ? dInfo.day_name : defaultDayNames[dIdx];
    const isToday = dInfo ? dInfo.is_today : dIdx === todayIdx;
    const dateShort = dInfo && dInfo.date ? dInfo.date.slice(5).split('-').reverse().join('.') + '.' : '';
    const lessons = dInfo ? (dInfo.lessons || []) : [];

    const boxH = timetableMainBox.height || 37;
    const fourLineCells = boxH >= 32;

    const lineCount = fourLineCells ? 4 : 3;
    const rowLines = Array.from({ length: lineCount }, () => '');

    // Day column (Crisp white-on-blue for today)
    const dayTagStart = isToday ? '{blue-bg}{white-fg}{bold}' : '{white-fg}{bold}';
    rowLines[0] = `{cyan-fg}│{/cyan-fg}${dayTagStart}${padVis(dayName.toUpperCase(), dayColW, 'center')}{/}`;
    rowLines[1] = `{cyan-fg}│{/cyan-fg}${isToday ? '{yellow-fg}{bold}' : '{cyan-fg}'}${padVis(isToday ? '[DNES]' : dateShort, dayColW, 'center')}{/}`;
    if (lineCount >= 3) rowLines[2] = `{cyan-fg}│{/cyan-fg}${isToday && dateShort ? '{white-fg}' + padVis(dateShort, dayColW, 'center') + '{/}' : ' '.repeat(dayColW)}`;
    if (lineCount >= 4) rowLines[3] = `{cyan-fg}│{/cyan-fg}${' '.repeat(dayColW)}`;

    // 8 Period cells
    for (let pNum = 1; pNum <= 8; pNum++) {
      const les = lessons.find((l) => String(l.period) === String(pNum));
      const pDef = periods[pNum - 1];
      const isNowCell = isToday && bellPeriod && String(bellPeriod.period) === String(pNum);
      const isNextAfterBreak = isToday && bellBreak && String(bellBreak.before_period) === String(pNum);

      const sep = isNowCell ? '{yellow-fg}│{/yellow-fg}' : (isNextAfterBreak ? '{yellow-fg}│{/yellow-fg}' : '{cyan-fg}│{/cyan-fg}');

      if (!les) {
        rowLines[0] += sep + (isNowCell ? `{blue-bg}{white-fg}{bold}${padVis('VOĽNO', colW, 'center')}{/}` : ' '.repeat(colW));
        rowLines[1] += sep + `{cyan-fg}${padVis('-', colW, 'center')}{/cyan-fg}`;
        if (lineCount >= 3) rowLines[2] += sep + ' '.repeat(colW);
        if (lineCount >= 4) rowLines[3] += sep + ' '.repeat(colW);
        continue;
      }

      // Line 1: Skratka + Status Tag
      let sTitle = les.subject_short || fitPlain(les.subject, 5).toUpperCase();
      let titleTagStart = '{white-fg}{bold}';
      let titleTagEnd = '{/bold}{/white-fg}';
      if (isNowCell && !les.is_cancelled) {
        sTitle = `▶ ${sTitle} ◀`;
        titleTagStart = '{blue-bg}{white-fg}{bold}';
        titleTagEnd = '{/bold}{/white-fg}{/blue-bg}';
      } else if (les.is_cancelled) {
        sTitle = `${sTitle} [ODP]`;
        titleTagStart = '{red-fg}{bold}';
        titleTagEnd = '{/bold}{/red-fg}';
      } else if (les.is_changed) {
        sTitle = `${sTitle} [ZMN]`;
        titleTagStart = '{yellow-fg}{bold}';
        titleTagEnd = '{/bold}{/yellow-fg}';
      } else if (les.is_event) {
        sTitle = `${sTitle} [UDL]`;
        titleTagStart = '{cyan-fg}{bold}';
        titleTagEnd = '{/bold}{/cyan-fg}';
      } else if (isNextAfterBreak && mode === 'BREAK') {
        sTitle = `> ${sTitle}`;
        titleTagStart = '{yellow-fg}{bold}';
        titleTagEnd = '{/bold}{/yellow-fg}';
      }

      // Line 2: Čas (od-do)
      const timeVal = les.time || (pDef ? `${pDef.start}-${pDef.end}` : '-');
      const timeDisplay = compactMode ? timeVal.replace(/\b0/g, '') : timeVal;

      // Line 3: Trieda & Učebňa
      const clsTxt = les.class_name && les.class_name !== '-' ? les.class_name : '';
      const rmTxt = les.room_short && les.room_short !== '-' ? les.room_short : '';
      const clsRoom = clsTxt && rmTxt ? `${clsTxt}(${rmTxt})` : (rmTxt || clsTxt || '-');

      // Line 4: Učiteľ
      const tcTxt = les.teacher_short && les.teacher_short !== '-' ? les.teacher_short : (les.teacher || '-');

      const timeCol = les.is_cancelled ? '{red-fg}' : '{cyan-fg}';
      const clsCol = les.is_cancelled ? '{red-fg}' : '{white-fg}';
      const tcCol = les.is_cancelled ? '{red-fg}' : '{green-fg}';

      if (lineCount === 4) {
        rowLines[0] += sep + `${titleTagStart}${padVis(sTitle, colW, 'center')}${titleTagEnd}`;
        rowLines[1] += sep + `${timeCol}${padVis(timeDisplay, colW, 'center')}{/}`;
        rowLines[2] += sep + `${clsCol}${padVis(clsRoom, colW, 'center')}{/}`;
        rowLines[3] += sep + `${tcCol}${padVis(tcTxt, colW, 'center')}{/}`;
      } else {
        rowLines[0] += sep + `${titleTagStart}${padVis(sTitle, colW, 'center')}${titleTagEnd}`;
        rowLines[1] += sep + `${timeCol}${padVis(timeDisplay, colW, 'center')}{/}`;
        rowLines[2] += sep + `${clsCol}${padVis(rmTxt + ' ' + (les.teacher_code || tcTxt), colW, 'center')}{/}`;
      }
    }

    rowLines.forEach((ln) => out.push(ln + '{cyan-fg}│{/cyan-fg}'));
    out.push(`{cyan-fg}${dIdx < 4 ? hLine('├', '┼', '┤') : hLine('└', '┴', '┘')}{/cyan-fg}`);
  }

  timetableMainBox.setLabel(` [ ROZVRH HODÍN: CELÝ TÝŽDEŇ (${ttVariant === 'ACTUAL' ? 'AKTUÁLNY' : 'STACIONÁRNY'}) ] `);
  timetableMainBox.setContent(out.join('\n'));
}

function renderSingleDayView(dayIndex, live) {
  const weekMap = getWeekDataByVariant(ttVariant);
  const dayKeys = Object.keys(weekMap).sort();
  const periods = getPeriodsSchedule();
  const breaks = getBreaksSchedule();
  const defaultDayNames = ['Pondelok', 'Utorok', 'Streda', 'Štvrtok', 'Piatok'];

  const dKey = dayKeys[dayIndex];
  const dInfo = dKey ? weekMap[dKey] : null;
  const dayName = dInfo ? dInfo.day_name : defaultDayNames[dayIndex];
  const dateStr = dInfo ? dInfo.date : '';
  const isToday = dInfo ? dInfo.is_today : dayIndex === live.todayIdx;
  const lessons = dInfo ? (dInfo.lessons || []) : [];

  const boxWidth = timetableMainBox.width && timetableMainBox.width > 40 ? timetableMainBox.width : Math.max(80, screen.width - SIDEBAR_WIDTH);
  const innerW = Math.max(78, boxWidth - 4);

  const wH = 5;
  const wTime = 13;
  const wShort = 7;
  const wCls = 14;
  const wRoom = 14;
  const wTeach = 18;
  const wStat = 14;
  const wSubj = Math.max(16, innerW - (wH + wTime + wShort + wCls + wRoom + wTeach + wStat + 9));

  const borderLine = (l, m, r) => l + [
    '─'.repeat(wH), '─'.repeat(wTime), '─'.repeat(wShort), '─'.repeat(wSubj),
    '─'.repeat(wCls), '─'.repeat(wRoom), '─'.repeat(wTeach), '─'.repeat(wStat),
  ].join(m) + r;

  const variantBanner = ttVariant === 'ACTUAL'
    ? '{green-fg}{bold}AKTUÁLNY ROZVRH (zmeny a odpadnutia){/bold}{/green-fg}'
    : '{yellow-fg}{bold}STACIONÁRNY ROZVRH (stály bez zmien){/bold}{/yellow-fg}';

  const lines = [];
  lines.push(` {bold}{cyan-fg}${dayName.toUpperCase()} ${dateStr}{/cyan-fg}${isToday ? ' {blue-bg}{white-fg} DNES {/}' : ''}{/bold}   │   Režim: ${variantBanner}`);
  lines.push(`{cyan-fg}${borderLine('┌', '┬', '┐')}{/cyan-fg}`);
  lines.push(
    '{cyan-fg}│{/cyan-fg}' +
    `{bold}{cyan-fg}${padVis('HOD', wH, 'center')}{/bold}{/cyan-fg}{cyan-fg}│{/cyan-fg}` +
    `{bold}{cyan-fg}${padVis('ČAS (OD-DO)', wTime, 'center')}{/bold}{/cyan-fg}{cyan-fg}│{/cyan-fg}` +
    `{bold}{cyan-fg}${padVis('SKR.', wShort, 'center')}{/bold}{/cyan-fg}{cyan-fg}│{/cyan-fg}` +
    `{bold}{cyan-fg}${padVis('PREDMET / UDALOSŤ', wSubj)}{/bold}{/cyan-fg}{cyan-fg}│{/cyan-fg}` +
    `{bold}{cyan-fg}${padVis('TRIEDA / SK.', wCls)}{/bold}{/cyan-fg}{cyan-fg}│{/cyan-fg}` +
    `{bold}{cyan-fg}${padVis('UČEBŇA', wRoom)}{/bold}{/cyan-fg}{cyan-fg}│{/cyan-fg}` +
    `{bold}{cyan-fg}${padVis('UČITEĽ', wTeach)}{/bold}{/cyan-fg}{cyan-fg}│{/cyan-fg}` +
    `{bold}{cyan-fg}${padVis('STAV', wStat, 'center')}{/bold}{/cyan-fg}{cyan-fg}│{/cyan-fg}`
  );
  lines.push(`{cyan-fg}${borderLine('├', '┼', '┤')}{/cyan-fg}`);

  periods.forEach((p, idx) => {
    const les = lessons.find((l) => String(l.period) === String(p.period));
    const isNow = isToday && live.bellPeriod && String(live.bellPeriod.period) === String(p.period);

    if (!les) {
      const rowColor = isNow ? '{yellow-fg}{bold}' : '{cyan-fg}';
      lines.push(
        '{cyan-fg}│{/cyan-fg}' +
        `${rowColor}${padVis(p.period + '.', wH, 'center')}{/}{cyan-fg}│{/cyan-fg}` +
        `${rowColor}${padVis(`${p.start}-${p.end}`, wTime, 'center')}{/}{cyan-fg}│{/cyan-fg}` +
        `${rowColor}${padVis('-', wShort, 'center')}{/}{cyan-fg}│{/cyan-fg}` +
        `${rowColor}${padVis('Voľná hodina', wSubj)}{/}{cyan-fg}│{/cyan-fg}` +
        `${rowColor}${padVis('-', wCls)}{/}{cyan-fg}│{/cyan-fg}` +
        `${rowColor}${padVis('-', wRoom)}{/}{cyan-fg}│{/cyan-fg}` +
        `${rowColor}${padVis('-', wTeach)}{/}{cyan-fg}│{/cyan-fg}` +
        `${rowColor}${padVis(isNow ? '>> TERAZ VOĽNO' : 'VOĽNO', wStat, 'center')}{/}{cyan-fg}│{/cyan-fg}`
      );
    } else {
      const clsGrp = les.group ? `${les.class_name} (${les.group})` : (les.class_name || '-');
      let stText = les.status || 'PLÁN';
      let fgCol = 'white-fg';
      if (isNow && !les.is_cancelled) {
        stText = `>> TERAZ (${live.pct}%)`;
        fgCol = 'green-fg';
      } else if (les.is_cancelled) {
        stText = 'ODPADLA';
        fgCol = 'red-fg';
      } else if (les.is_changed) {
        stText = 'ZMENA';
        fgCol = 'yellow-fg';
      } else if (les.is_event) {
        stText = 'UDALOSŤ';
        fgCol = 'cyan-fg';
      }

      const rowPrefix = isNow && !les.is_cancelled ? '{blue-bg}{white-fg}{bold}' : `{${fgCol}}`;
      const rowEnd = '{/}';
      lines.push(
        '{cyan-fg}│{/cyan-fg}' +
        `${rowPrefix}${padVis(p.period + '.', wH, 'center')}${rowEnd}{cyan-fg}│{/cyan-fg}` +
        `${rowPrefix}${padVis(les.time || `${p.start}-${p.end}`, wTime, 'center')}${rowEnd}{cyan-fg}│{/cyan-fg}` +
        `${rowPrefix}${padVis(les.subject_short || '-', wShort, 'center')}${rowEnd}{cyan-fg}│{/cyan-fg}` +
        `${rowPrefix}${padVis(les.subject || '-', wSubj)}${rowEnd}{cyan-fg}│{/cyan-fg}` +
        `${rowPrefix}${padVis(clsGrp, wCls)}${rowEnd}{cyan-fg}│{/cyan-fg}` +
        `${rowPrefix}${padVis(les.room || '-', wRoom)}${rowEnd}{cyan-fg}│{/cyan-fg}` +
        `${rowPrefix}${padVis(les.teacher || '-', wTeach)}${rowEnd}{cyan-fg}│{/cyan-fg}` +
        `${rowPrefix}${padVis(stText, wStat, 'center')}${rowEnd}{cyan-fg}│{/cyan-fg}`
      );
    }

    const br = breaks[idx];
    if (br) {
      const isNowBreak = isToday && live.bellBreak && live.bellBreak.id === br.id;
      const brSummary = `   ··· Prestávka ${br.between}: ${br.start} - ${br.end} (${br.duration_min} min · ${br.name}) ${isNowBreak ? '◀ PRÁVE PREBIEHA!' : ''}···`;
      const brTag = isNowBreak ? '{blue-bg}{yellow-fg}{bold}' : '{cyan-fg}';
      lines.push(`{cyan-fg}│{/cyan-fg}${brTag}${padVis(brSummary, innerW)}{/}{cyan-fg}│{/cyan-fg}`);
    }
  });

  lines.push(`{cyan-fg}${borderLine('└', '┴', '┘')}{/cyan-fg}`);

  timetableMainBox.setLabel(` [ ROZVRH: ${dayName.toUpperCase()} (${ttVariant === 'ACTUAL' ? 'AKTUÁLNY' : 'STACIONÁRNY'}) ] `);
  timetableMainBox.setContent(lines.join('\n'));
}

function renderBreaksView(live) {
  const breaks = getBreaksSchedule();
  const boxWidth = timetableMainBox.width && timetableMainBox.width > 40 ? timetableMainBox.width : Math.max(80, screen.width - SIDEBAR_WIDTH);
  const innerW = Math.max(76, boxWidth - 4);

  const wId = 6;
  const wBetw = 18;
  const wTime = 15;
  const wDur = 10;
  const wType = 22;
  const wBar = Math.max(14, innerW - (wId + wBetw + wTime + wDur + wType + 7));

  const hLine = (l, m, r) => l + [
    '─'.repeat(wId), '─'.repeat(wBetw), '─'.repeat(wTime),
    '─'.repeat(wDur), '─'.repeat(wType), '─'.repeat(wBar),
  ].join(m) + r;

  const lines = [];
  lines.push(' {bold}{yellow-fg}PREHĽAD ŠKOLSKÝCH PRESTÁVOK A ZVONENÍ{/yellow-fg}{/bold}   │   {white-fg}Časy vychádzajú z oficiálneho rozpisu zvonení školy.{/white-fg}');
  lines.push('');
  lines.push(`{yellow-fg}${hLine('┌', '┬', '┐')}{/yellow-fg}`);
  lines.push(
    '{yellow-fg}│{/yellow-fg}' +
    `{bold}{cyan-fg}${padVis('#', wId, 'center')}{/bold}{/cyan-fg}{yellow-fg}│{/yellow-fg}` +
    `{bold}{cyan-fg}${padVis('MEDZI HODINAMI', wBetw, 'center')}{/bold}{/cyan-fg}{yellow-fg}│{/yellow-fg}` +
    `{bold}{cyan-fg}${padVis('ČAS PRESTÁVKY', wTime, 'center')}{/bold}{/cyan-fg}{yellow-fg}│{/yellow-fg}` +
    `{bold}{cyan-fg}${padVis('DĹŽKA', wDur, 'center')}{/bold}{/cyan-fg}{yellow-fg}│{/yellow-fg}` +
    `{bold}{cyan-fg}${padVis('TYP PRESTÁVKY', wType)}{/bold}{/cyan-fg}{yellow-fg}│{/yellow-fg}` +
    `{bold}{cyan-fg}${padVis('VIZUALIZÁCIA / STAV', wBar)}{/bold}{/cyan-fg}{yellow-fg}│{/yellow-fg}`
  );
  lines.push(`{yellow-fg}${hLine('├', '┼', '┤')}{/yellow-fg}`);

  breaks.forEach((b, i) => {
    const isNowBreak = live.bellBreak && live.bellBreak.id === b.id;
    const barUnits = Math.max(2, Math.min(18, Math.round((b.duration_min / 30) * 18)));
    const barStr = '█'.repeat(barUnits);
    const col = b.duration_min >= 25 ? 'magenta-fg' : (b.duration_min >= 15 ? 'yellow-fg' : (b.duration_min >= 10 ? 'cyan-fg' : 'green-fg'));
    const statusLabel = isNowBreak ? `${barStr} ▶ PRÁVE PREBIEHA` : `${barStr}`;
    const wrapStart = isNowBreak ? '{blue-bg}{yellow-fg}{bold}' : '{white-fg}';
    const wrapEnd = '{/}';

    lines.push(
      '{yellow-fg}│{/yellow-fg}' +
      `${wrapStart}${padVis(`${i + 1}.`, wId, 'center')}${wrapEnd}{yellow-fg}│{/yellow-fg}` +
      `${wrapStart}${padVis(b.between, wBetw, 'center')}${wrapEnd}{yellow-fg}│{/yellow-fg}` +
      `${wrapStart}${padVis(`${b.start} - ${b.end}`, wTime, 'center')}${wrapEnd}{yellow-fg}│{/yellow-fg}` +
      `${isNowBreak ? wrapStart : `{${col}}{bold}`}${padVis(`${b.duration_min} min`, wDur, 'center')}${wrapEnd}{yellow-fg}│{/yellow-fg}` +
      `${isNowBreak ? wrapStart : `{${col}}`}${padVis(b.name, wType)}${wrapEnd}{yellow-fg}│{/yellow-fg}` +
      `${isNowBreak ? wrapStart : `{${col}}`}${padVis(statusLabel, wBar)}${wrapEnd}{yellow-fg}│{/yellow-fg}`
    );
  });

  lines.push(`{yellow-fg}${hLine('└', '┴', '┘')}{/yellow-fg}`);
  lines.push('');
  if (live.bellBreak) {
    lines.push(` {blue-bg}{yellow-fg}{bold} ● AKTUÁLNA PRESTÁVKA: ${live.bellBreak.between} (${live.bellBreak.start} - ${live.bellBreak.end}, ${live.bellBreak.duration_min} min) {/}`);
  } else if (live.bellPeriod) {
    lines.push(` {cyan-fg}{bold}● Momentálne prebieha ${live.bellPeriod.period}. vyučovacia hodina (${live.bellPeriod.start} - ${live.bellPeriod.end}).{/bold}{/cyan-fg}`);
  } else {
    lines.push(' {white-fg}● Momentálne je mimo času školských prestávok.{/white-fg}');
  }

  timetableMainBox.setLabel(' [ PRESTÁVKY A ROZPIS ZVONENIA ] ');
  timetableMainBox.setContent(lines.join('\n'));
}

function renderTimetableCard() {
  const live = getLiveSchoolState();
  renderTimetableSidebar(live);

  if (ttSection === 'PRESTAVKY') {
    renderBreaksView(live);
  } else if (ttScope === 'WEEK') {
    renderWeeklyGrid(live);
  } else {
    renderSingleDayView(ttScope, live);
  }
}

// ==============================================================================
// TAB 3 (ZNÁMKY): Left Sidebar, Overview, Subject Tables & Pochvaly/Poznámky
// ==============================================================================

let gradesCursor = 0; // 0 = PREHĽAD, 1 = POCHVALY/POZNÁMKY, 2..N = Konkrétny predmet

function getGradeColorTag(val) {
  const n = parseFloat(String(val).replace(',', '.'));
  if (!isNaN(n)) {
    if (n < 1.5) return 'green-fg';
    if (n < 2.5) return 'cyan-fg';
    if (n < 3.5) return 'yellow-fg';
    if (n < 4.5) return 'magenta-fg';
    return 'red-fg';
  }
  const s = String(val || '');
  if (s.endsWith('%')) {
    const pct = parseFloat(s);
    if (pct >= 90) return 'green-fg';
    if (pct >= 75) return 'cyan-fg';
    if (pct >= 60) return 'yellow-fg';
    if (pct >= 50) return 'magenta-fg';
    return 'red-fg';
  }
  return 'white-fg';
}

function getGradesSidebarItems() {
  const subjs = dashboardData.subjects || [];
  const comms = dashboardData.commendations || [];
  const items = [
    { id: 'OVERVIEW', type: 'OVERVIEW', label: 'PREHĽAD (Všetky známky)' },
    { id: 'COMMENDATIONS', type: 'COMMENDATIONS', label: `POCHVALY / POZNÁMKY (${comms.length})` },
  ];
  subjs.forEach((s, idx) => {
    const code = (s.short || s.name || '-').padEnd(4, ' ');
    const full = fitPlain(s.full_name || s.name || '-', 13).padEnd(13, ' ');
    const avg = (s.avg || '-').padStart(4, ' ');
    items.push({
      id: `SUBJ_${idx}`,
      type: 'SUBJECT',
      subject: s,
      subjectIndex: idx,
      label: `${code} ${full} [${avg}]`,
    });
  });
  return items;
}

function renderGradesSidebar() {
  const isFocused = activeTabIndex === 2 && navFocus === 'card';
  gradesSidebar.style.border.fg = isFocused ? 'yellow' : 'cyan';
  gradesSidebar.setLabel(isFocused ? ' [ ĽAVÁ LIŠTA (AKTÍVNA) ] ' : ' [ ĽAVÁ LIŠTA (↓ Vstup) ] ');

  const items = getGradesSidebarItems();
  if (gradesCursor >= items.length) gradesCursor = Math.max(0, items.length - 1);

  const gpa = dashboardData.gpa || '-';
  const standing = dashboardData.standing || '-';
  const totalMarks = dashboardData.total_marks || 0;
  const subjCount = (dashboardData.subjects || []).length;
  const commCount = (dashboardData.commendations || []).length;

  const lines = [];
  lines.push(' {bold}{cyan-fg}══ ŠTUDIJNÝ SÚHRN (SR) ══{/cyan-fg}{/bold}');
  lines.push(` {blue-bg}{white-fg}{bold}${padRawLine(` ● CELKOVÝ PRIEMER: ${gpa}`, 30)}{/bold}{/white-fg}{/blue-bg}`);
  lines.push(` {green-fg}{bold}${fitPlain(standing, 30)}{/bold}{/green-fg}`);
  lines.push(` {white-fg}Známok: ${totalMarks}  │  Predmetov: ${subjCount}{/white-fg}`);
  lines.push(` {cyan-fg}Pochvaly / Poznámky: ${commCount}{/cyan-fg}`);
  lines.push('{cyan-fg}────────────────────────────────{/cyan-fg}');
  lines.push(' {bold}{white-fg}HLAVNÉ ZÁLOŽKY:{/white-fg}{/bold}');

  // Render fixed top 2 items (OVERVIEW and COMMENDATIONS)
  for (let idx = 0; idx < Math.min(2, items.length); idx++) {
    const it = items[idx];
    const cursorHere = isFocused && gradesCursor === idx;
    const active = gradesCursor === idx;
    const text = `${active ? ' ▶ ' : '   '}${it.label}`;
    if (cursorHere) {
      lines.push(`{blue-bg}{white-fg}{bold}${padRawLine(text, 32)}{/bold}{/white-fg}{/blue-bg}`);
    } else if (active) {
      const col = idx === 1 ? 'yellow-fg' : 'green-fg';
      lines.push(`{${col}}{bold}${padRawLine(text, 32)}{/bold}{/${col}}`);
    } else {
      lines.push(`{white-fg}${padRawLine(text, 32)}{/white-fg}`);
    }
  }

  lines.push('{cyan-fg}────────────────────────────────{/cyan-fg}');
  lines.push(` {bold}{white-fg}PREDMETY (${subjCount}) [↑/↓ Výber]:{/white-fg}{/bold}`);

  const subjItems = items.slice(2);
  const boxH = gradesSidebar.height || 37;
  const availRows = Math.max(6, boxH - 14);

  let startIdx = 0;
  const activeSubjOffset = Math.max(0, gradesCursor - 2);
  if (subjItems.length > availRows) {
    startIdx = Math.max(0, Math.min(subjItems.length - availRows, activeSubjOffset - Math.floor(availRows / 2)));
  }
  const endIdx = Math.min(subjItems.length, startIdx + availRows);

  if (startIdx > 0) {
    lines.push(` {cyan-fg}  ▲ Ďalšie predmety vyššie (${startIdx}){/cyan-fg}`);
  }

  for (let sIdx = startIdx; sIdx < endIdx; sIdx++) {
    const globalIdx = sIdx + 2;
    const it = subjItems[sIdx];
    const cursorHere = isFocused && gradesCursor === globalIdx;
    const active = gradesCursor === globalIdx;
    const s = it.subject;
    const avgCol = getGradeColorTag(s.avg);
    const branch = sIdx === subjItems.length - 1 ? '└─' : '├─';
    const rawLine = `${active ? '▶' : ' '} ${branch} ${it.label}`;

    if (cursorHere) {
      lines.push(`{blue-bg}{white-fg}{bold}${padRawLine(' ' + rawLine, 32)}{/bold}{/white-fg}{/blue-bg}`);
    } else if (active) {
      lines.push(`{${avgCol}}{bold}${padRawLine(' ' + rawLine, 32)}{/bold}{/${avgCol}}`);
    } else {
      lines.push(`{white-fg}   ${branch} {bold}${(s.short || s.name || '-').padEnd(4, ' ')}{/bold} ${fitPlain(s.full_name || s.name, 13).padEnd(13, ' ')} {${avgCol}}[${(s.avg || '-').padStart(4, ' ')}]{/${avgCol}} {/white-fg}`);
    }
  }

  if (endIdx < subjItems.length) {
    lines.push(` {cyan-fg}  ▼ Ďalšie predmety nižšie (${subjItems.length - endIdx}){/cyan-fg}`);
  }

  gradesSidebar.setContent(lines.join('\n'));
}

function renderGradesOverview() {
  const boxWidth = gradesMainBox.width && gradesMainBox.width > 40 ? gradesMainBox.width : Math.max(80, screen.width - SIDEBAR_WIDTH);
  const innerW = Math.max(82, boxWidth - 4);

  const subjs = dashboardData.subjects || [];
  const distData = (dashboardData.distribution && dashboardData.distribution.data) || [0, 0, 0, 0, 0];
  const distLabels = ['Výborný', 'Chválitebný', 'Dobrý', 'Dostatočný', 'Nedostatočný'];
  const distColors = ['green-fg', 'cyan-fg', 'yellow-fg', 'magenta-fg', 'red-fg'];
  const totalClassified = distData.reduce((a, b) => a + b, 0);
  const maxDist = Math.max(...distData, 1);

  const trend = dashboardData.trend || { x: [], y: [] };
  const rawTx = trend.x || [];
  const rawTy = trend.y || [];

  // 1. Top Dual Panel: Left = GPA Trend Chart, Right = Grade Distribution Table
  const leftW = Math.floor((innerW - 3) / 2);
  const rightW = innerW - leftW - 3;

  const topLine = `┌${'─'.repeat(leftW)}┬${'─'.repeat(rightW)}┐`;
  const midLine = `├${'─'.repeat(leftW)}┼${'─'.repeat(rightW)}┤`;
  const botLine = `└${'─'.repeat(leftW)}┴${'─'.repeat(rightW)}┘`;

  // Sample up to maxPts so each column is at least 6 chars wide (fits '●1.88' and '15.09' without truncation)
  const plotAreaW = Math.max(12, leftW - 7);
  const maxPts = Math.max(2, Math.min(8, Math.floor(plotAreaW / 6)));
  let tx = rawTx;
  let ty = rawTy;
  if (rawTy.length > maxPts) {
    const step = (rawTy.length - 1) / (maxPts - 1);
    tx = [];
    ty = [];
    for (let i = 0; i < maxPts; i++) {
      const idx = Math.round(i * step);
      tx.push(rawTx[idx]);
      ty.push(rawTy[idx]);
    }
  }
  const plotCount = ty.length;
  const colStep = plotCount > 0 ? Math.max(6, Math.floor(plotAreaW / plotCount)) : 6;

  // Build 6 lines for Left GPA Trend Chart
  const chartRows = [];
  const yLevels = [1.0, 1.5, 2.0, 2.5, 3.0];

  yLevels.forEach((lvl) => {
    let rowChars = '';
    for (let i = 0; i < plotCount; i++) {
      const val = ty[i];
      const closestLvl = yLevels.reduce((prev, curr) => (Math.abs(curr - val) < Math.abs(prev - val) ? curr : prev));
      const cellStr = closestLvl === lvl ? `●${val.toFixed(2)}` : (val <= lvl ? '  │  ' : '  ·  ');
      rowChars += padVis(cellStr, colStep, 'center');
    }
    const labelStr = ` ${lvl.toFixed(1)} ┤`;
    const colTag = lvl <= 1.5 ? 'green-fg' : (lvl <= 2.0 ? 'cyan-fg' : 'yellow-fg');
    chartRows.push(`{white-fg}${labelStr}{/white-fg}{${colTag}}{bold}${padRawLine(rowChars, leftW - 6)}{/bold}{/${colTag}}`);
  });

  let xAxisBody = '';
  for (let i = 0; i < plotCount; i++) {
    xAxisBody += padVis(tx[i] || '', colStep, 'center');
  }
  chartRows.push(`{cyan-fg}${padRawLine('     └' + xAxisBody, leftW)}{/cyan-fg}`);

  // Build 6 lines for Right Grade Distribution
  const distRows = [];
  const barMaxW = Math.max(8, rightW - 31);
  for (let i = 0; i < 5; i++) {
    const cnt = distData[i] || 0;
    const pct = totalClassified > 0 ? ((cnt / totalClassified) * 100).toFixed(1) : '0.0';
    const bLen = Math.round((cnt / maxDist) * barMaxW);
    const bar = (bLen > 0 ? '█'.repeat(bLen) : '░').padEnd(barMaxW, ' ');
    const cTag = distColors[i];
    const linePlain = ` ${i + 1} ${distLabels[i].padEnd(12, ' ')} `;
    const rightStats = ` ${String(cnt).padStart(2, ' ')}x (${pct.padStart(5, ' ')}%)`;
    const padRem = Math.max(0, rightW - (linePlain.length + bar.length + rightStats.length));
    distRows.push(
      `{white-fg}{bold}${linePlain}{/bold}{/white-fg}{${cTag}}${bar}{/${cTag}}{white-fg}{bold}${rightStats}{/bold}{/white-fg}${' '.repeat(padRem)}`
    );
  }
  const passCount = distData[0] + distData[1] + distData[2] + distData[3];
  const passRate = totalClassified > 0 ? ((passCount / totalClassified) * 100).toFixed(1) : '0.0';
  const summaryTxt = ` Spolu: ${totalClassified} zn. │ Priemer SR: ${dashboardData.gpa || '-'} │ Úspešnosť: ${passRate}%`;
  distRows.push(`{cyan-fg}{bold}${padRawLine(summaryTxt, rightW)}{/bold}{/cyan-fg}`);

  const out = [];
  out.push(`{cyan-fg}${topLine}{/cyan-fg}`);
  out.push(
    `{cyan-fg}│{/cyan-fg}{bold}{green-fg}${padRawLine(' VÝVOJ PRIEMERU (CHRONOLOGICKÝ GRAF GPA)', leftW)}{/green-fg}{/bold}` +
    `{cyan-fg}│{/cyan-fg}{bold}{cyan-fg}${padRawLine(' ROZDELENIE ZNÁMOK (1 - 5) & CELKOVÁ ŠTATISTIKA', rightW)}{/cyan-fg}{/bold}{cyan-fg}│{/cyan-fg}`
  );
  out.push(`{cyan-fg}${midLine}{/cyan-fg}`);
  for (let r = 0; r < 6; r++) {
    out.push(`{cyan-fg}│{/cyan-fg}${chartRows[r]}{cyan-fg}│{/cyan-fg}${distRows[r]}{cyan-fg}│{/cyan-fg}`);
  }
  out.push(`{cyan-fg}${botLine}{/cyan-fg}`);

  // 2. Bottom Full-Width Table of All Subjects
  const wShort = 6;
  const wSubj = 29;
  const wCnt = 6;
  const wPct = 9;
  const wAvg = 9;
  const wFin = 6;
  const wVerb = 14;
  const wMarks = Math.max(16, innerW - (wShort + wSubj + wCnt + wPct + wAvg + wFin + wVerb + 9));

  const tLine = (l, m, r) => l + [
    '─'.repeat(wShort), '─'.repeat(wSubj), '─'.repeat(wMarks), '─'.repeat(wCnt),
    '─'.repeat(wPct), '─'.repeat(wAvg), '─'.repeat(wFin), '─'.repeat(wVerb),
  ].join(m) + r;

  out.push(`{cyan-fg}${tLine('┌', '┬', '┐')}{/cyan-fg}`);
  out.push(
    '{cyan-fg}│{/cyan-fg}' +
    `{bold}{cyan-fg}${padVis('SKR.', wShort, 'center')}{/bold}{/cyan-fg}{cyan-fg}│{/cyan-fg}` +
    `{bold}{cyan-fg}${padVis('NÁZOV PREDMETU', wSubj)}{/bold}{/cyan-fg}{cyan-fg}│{/cyan-fg}` +
    `{bold}{cyan-fg}${padVis('ZAPÍSANÉ ZNÁMKY (CHRONOLOGICKY)', wMarks)}{/bold}{/cyan-fg}{cyan-fg}│{/cyan-fg}` +
    `{bold}{cyan-fg}${padVis('POČ.', wCnt, 'center')}{/bold}{/cyan-fg}{cyan-fg}│{/cyan-fg}` +
    `{bold}{cyan-fg}${padVis('PRIEM.%', wPct, 'center')}{/bold}{/cyan-fg}{cyan-fg}│{/cyan-fg}` +
    `{bold}{cyan-fg}${padVis('PRIEMER', wAvg, 'center')}{/bold}{/cyan-fg}{cyan-fg}│{/cyan-fg}` +
    `{bold}{cyan-fg}${padVis('VYS.', wFin, 'center')}{/bold}{/cyan-fg}{cyan-fg}│{/cyan-fg}` +
    `{bold}{cyan-fg}${padVis('KLASIFIKÁCIA', wVerb, 'center')}{/bold}{/cyan-fg}{cyan-fg}│{/cyan-fg}`
  );
  out.push(`{cyan-fg}${tLine('├', '┼', '┤')}{/cyan-fg}`);

  subjs.forEach((s) => {
    const col = getGradeColorTag(s.avg);
    const marksStr = (s.marks_preview && s.marks_preview.length > 0)
      ? s.marks_preview.join(', ')
      : '-';
    out.push(
      '{cyan-fg}│{/cyan-fg}' +
      `{bold}{white-fg}${padVis(s.short || s.name, wShort, 'center')}{/white-fg}{/bold}{cyan-fg}│{/cyan-fg}` +
      `{white-fg}${padVis(s.full_name || s.name, wSubj)}{/white-fg}{cyan-fg}│{/cyan-fg}` +
      `{cyan-fg}${padVis(marksStr, wMarks)}{/cyan-fg}{cyan-fg}│{/cyan-fg}` +
      `{white-fg}${padVis(String(s.count || 0), wCnt, 'center')}{/white-fg}{cyan-fg}│{/cyan-fg}` +
      `{white-fg}${padVis(s.percent || '-', wPct, 'center')}{/white-fg}{cyan-fg}│{/cyan-fg}` +
      `{bold}{${col}}${padVis(s.avg || '-', wAvg, 'center')}{/${col}}{/bold}{cyan-fg}│{/cyan-fg}` +
      `{bold}{${col}}${padVis(s.final_grade || '-', wFin, 'center')}{/${col}}{/bold}{cyan-fg}│{/cyan-fg}` +
      `{${col}}${padVis(s.verbal || '-', wVerb, 'center')}{/${col}}{cyan-fg}│{/cyan-fg}`
    );
  });

  out.push(`{cyan-fg}${tLine('└', '┴', '┘')}{/cyan-fg}`);

  gradesMainBox.setLabel(' [ PREHĽAD VŠETKÝCH ZNÁMOK, GRAF PRIEMERU A PREDMETY ] ');
  gradesMainBox.setContent(out.join('\n'));
}

function renderCommendationsView() {
  const boxWidth = gradesMainBox.width && gradesMainBox.width > 40 ? gradesMainBox.width : Math.max(80, screen.width - SIDEBAR_WIDTH);
  const innerW = Math.max(82, boxWidth - 4);
  const comms = dashboardData.commendations || [];
  const allGrades = dashboardData.all_grades || [];

  const pochvalyCnt = comms.filter((c) => c.category === 'POCHVALA').length;
  const poznamkyCnt = comms.filter((c) => c.category === 'POZNÁMKA').length;

  const out = [];
  out.push(
    ` {bold}{yellow-fg}OFICIÁLNE POCHVALY, POZNÁMKY A OPATRENIA VO VÝCHOVE{/yellow-fg}{/bold}   │   ` +
    `{green-fg}{bold}Pochvaly: ${pochvalyCnt}{/bold}{/green-fg}  │  {red-fg}{bold}Poznámky / Pokarhania: ${poznamkyCnt}{/bold}{/red-fg}`
  );

  const wNum = 4;
  const wDate = 16;
  const wCat = 10;
  const wSubj = 11;
  const wTeach = 16;
  const wState = 17;
  const wText = Math.max(20, innerW - (wNum + wDate + wCat + wSubj + wTeach + wState + 8));

  const cLine = (l, m, r) => l + [
    '─'.repeat(wNum), '─'.repeat(wDate), '─'.repeat(wCat), '─'.repeat(wSubj),
    '─'.repeat(wTeach), '─'.repeat(wState), '─'.repeat(wText),
  ].join(m) + r;

  out.push(`{yellow-fg}${cLine('┌', '┬', '┐')}{/yellow-fg}`);
  out.push(
    '{yellow-fg}│{/yellow-fg}' +
    `{bold}{cyan-fg}${padVis('#', wNum, 'center')}{/bold}{/cyan-fg}{yellow-fg}│{/yellow-fg}` +
    `{bold}{cyan-fg}${padVis('DÁTUM A ČAS', wDate, 'center')}{/bold}{/cyan-fg}{yellow-fg}│{/yellow-fg}` +
    `{bold}{cyan-fg}${padVis('DRUH', wCat, 'center')}{/bold}{/cyan-fg}{yellow-fg}│{/yellow-fg}` +
    `{bold}{cyan-fg}${padVis('PREDMET', wSubj)}{/bold}{/cyan-fg}{yellow-fg}│{/yellow-fg}` +
    `{bold}{cyan-fg}${padVis('UČITEĽ', wTeach)}{/bold}{/cyan-fg}{yellow-fg}│{/yellow-fg}` +
    `{bold}{cyan-fg}${padVis('STAV', wState, 'center')}{/bold}{/cyan-fg}{yellow-fg}│{/yellow-fg}` +
    `{bold}{cyan-fg}${padVis('TEXT POCHVALY / POZNÁMKY', wText)}{/bold}{/cyan-fg}{yellow-fg}│{/yellow-fg}`
  );
  out.push(`{yellow-fg}${cLine('├', '┼', '┤')}{/yellow-fg}`);

  if (comms.length === 0) {
    out.push(
      '{yellow-fg}│{/yellow-fg}' +
      `{white-fg}${padVis('-', wNum, 'center')}{/white-fg}{yellow-fg}│{/yellow-fg}` +
      `{white-fg}${padVis('-', wDate, 'center')}{/white-fg}{yellow-fg}│{/yellow-fg}` +
      `{cyan-fg}${padVis('INFO', wCat, 'center')}{/cyan-fg}{yellow-fg}│{/yellow-fg}` +
      `{white-fg}${padVis('Správanie', wSubj)}{/white-fg}{yellow-fg}│{/yellow-fg}` +
      `{white-fg}${padVis('-', wTeach)}{/white-fg}{yellow-fg}│{/yellow-fg}` +
      `{white-fg}${padVis('-', wState, 'center')}{/white-fg}{yellow-fg}│{/yellow-fg}` +
      `{white-fg}${padVis('Zatiaľ nemáš žiadne zapísané pochvaly ani poznámky.', wText)}{/white-fg}{yellow-fg}│{/yellow-fg}`
    );
  } else {
    comms.forEach((c, idx) => {
      const col = c.category === 'POCHVALA' ? 'green-fg' : (c.category === 'POZNÁMKA' ? 'red-fg' : 'cyan-fg');
      out.push(
        '{yellow-fg}│{/yellow-fg}' +
        `{white-fg}${padVis(`${idx + 1}.`, wNum, 'center')}{/white-fg}{yellow-fg}│{/yellow-fg}` +
        `{white-fg}${padVis(c.date || '-', wDate, 'center')}{/white-fg}{yellow-fg}│{/yellow-fg}` +
        `{bold}{${col}}${padVis(c.category || 'ZÁZNAM', wCat, 'center')}{/${col}}{/bold}{yellow-fg}│{/yellow-fg}` +
        `{white-fg}${padVis(c.subject || 'Správanie', wSubj)}{/white-fg}{yellow-fg}│{/yellow-fg}` +
        `{white-fg}${padVis(c.teacher || '-', wTeach)}{/white-fg}{yellow-fg}│{/yellow-fg}` +
        `{cyan-fg}${padVis(c.state || '-', wState, 'center')}{/cyan-fg}{yellow-fg}│{/yellow-fg}` +
        `{bold}{${col}}${padVis(c.text || '-', wText)}{/${col}}{/bold}{yellow-fg}│{/yellow-fg}`
      );
    });
  }
  out.push(`{yellow-fg}${cLine('└', '┴', '┘')}{/yellow-fg}`);
  out.push('');

  // Second Table: Recent Grades Overview with Teachers & Details
  out.push(' {bold}{cyan-fg}PREHĽAD POSLEDNÝCH ZNÁMOK, KOMENTÁROV A VYUČUJÚCICH{/cyan-fg}{/bold}');
  const gWithNotes = allGrades.filter((g) => g.note && g.note !== '-' && g.note.trim() !== '');
  const listToRender = gWithNotes.length > 0 ? gWithNotes : allGrades.slice(0, 12);

  const gwDate = 12;
  const gwSubj = 8;
  const gwGrd = 14;
  const gwWgt = 6;
  const gwTitle = 34;
  const gwNote = Math.max(18, innerW - (gwDate + gwSubj + gwGrd + gwWgt + gwTitle + 7));

  const gLine = (l, m, r) => l + [
    '─'.repeat(gwDate), '─'.repeat(gwSubj), '─'.repeat(gwGrd),
    '─'.repeat(gwWgt), '─'.repeat(gwTitle), '─'.repeat(gwNote),
  ].join(m) + r;

  out.push(`{cyan-fg}${gLine('┌', '┬', '┐')}{/cyan-fg}`);
  out.push(
    '{cyan-fg}│{/cyan-fg}' +
    `{bold}{cyan-fg}${padVis('DÁTUM', gwDate, 'center')}{/bold}{/cyan-fg}{cyan-fg}│{/cyan-fg}` +
    `{bold}{cyan-fg}${padVis('PREDM.', gwSubj, 'center')}{/bold}{/cyan-fg}{cyan-fg}│{/cyan-fg}` +
    `{bold}{cyan-fg}${padVis('HODNOTENIE', gwGrd, 'center')}{/bold}{/cyan-fg}{cyan-fg}│{/cyan-fg}` +
    `{bold}{cyan-fg}${padVis('VÁHA', gwWgt, 'center')}{/bold}{/cyan-fg}{cyan-fg}│{/cyan-fg}` +
    `{bold}{cyan-fg}${padVis('ZADANIE / PÍSOMKA / UDALOSŤ', gwTitle)}{/bold}{/cyan-fg}{cyan-fg}│{/cyan-fg}` +
    `{bold}{cyan-fg}${padVis('VYUČUJÚCI & POZNÁMKA', gwNote)}{/bold}{/cyan-fg}{cyan-fg}│{/cyan-fg}`
  );
  out.push(`{cyan-fg}${gLine('├', '┼', '┤')}{/cyan-fg}`);

  listToRender.forEach((g) => {
    const col = getGradeColorTag(g.grade);
    const noteOrTeacher = g.note
      ? `${g.teacher && g.teacher !== '-' ? g.teacher + ' │ ' : ''}${g.note}`
      : (g.teacher && g.teacher !== '-' ? g.teacher : (g.comment || '-'));
    out.push(
      '{cyan-fg}│{/cyan-fg}' +
      `{white-fg}${padVis(g.date || '-', gwDate, 'center')}{/white-fg}{cyan-fg}│{/cyan-fg}` +
      `{bold}{white-fg}${padVis(g.subject || '-', gwSubj, 'center')}{/white-fg}{/bold}{cyan-fg}│{/cyan-fg}` +
      `{bold}{${col}}${padVis(g.grade || '-', gwGrd, 'center')}{/${col}}{/bold}{cyan-fg}│{/cyan-fg}` +
      `{white-fg}${padVis(g.weight || '1', gwWgt, 'center')}{/white-fg}{cyan-fg}│{/cyan-fg}` +
      `{white-fg}${padVis(g.title || '-', gwTitle)}{/white-fg}{cyan-fg}│{/cyan-fg}` +
      `{cyan-fg}${padVis(noteOrTeacher, gwNote)}{/cyan-fg}{cyan-fg}│{/cyan-fg}`
    );
  });
  out.push(`{cyan-fg}${gLine('└', '┴', '┘')}{/cyan-fg}`);

  gradesMainBox.setLabel(' [ POCHVALY, POZNÁMKY A KOMENTÁRE UČITEĽOV ] ');
  gradesMainBox.setContent(out.join('\n'));
}

function renderSubjectDetailView(subj) {
  const boxWidth = gradesMainBox.width && gradesMainBox.width > 40 ? gradesMainBox.width : Math.max(80, screen.width - SIDEBAR_WIDTH);
  const innerW = Math.max(82, boxWidth - 4);

  const avgCol = getGradeColorTag(subj.avg);
  const sDist = subj.distribution || [0, 0, 0, 0, 0];
  const gRows = subj.grades || [];

  const out = [];

  // 1. Top Framed Subject Card
  out.push(`{cyan-fg}┌${'─'.repeat(innerW)}┐{/cyan-fg}`);
  const titleLine = ` PREDMET: ${(subj.short || subj.name || '-')} — ${subj.full_name || subj.name || '-'}   │   VYUČUJÚCI: ${subj.teacher || '-'}`;
  out.push(`{cyan-fg}│{/cyan-fg}{blue-bg}{white-fg}{bold}${padRawLine(titleLine, innerW)}{/bold}{/white-fg}{/blue-bg}{cyan-fg}│{/cyan-fg}`);
  out.push(`{cyan-fg}├${'─'.repeat(innerW)}┤{/cyan-fg}`);

  const statsLine = ` VÁŽENÝ PRIEMER: ${subj.avg || '-'}   │   PRIEMER V %: ${subj.percent || '-'}   │   ZNÁMKA NA VYSVEDČENÍ: ${subj.final_grade || '-'} (${subj.verbal || '-'})   │   POČET ZNÁMOK: ${subj.count || 0}`;
  out.push(`{cyan-fg}│{/cyan-fg}{bold}{${avgCol}}${padRawLine(statsLine, innerW)}{/${avgCol}}{/bold}{cyan-fg}│{/cyan-fg}`);

  const distSummary = ` ROZDELENIE ZNÁMOK:  [1 Výborný]: ${sDist[0]}x  │  [2 Chválitebný]: ${sDist[1]}x  │  [3 Dobrý]: ${sDist[2]}x  │  [4 Dostatočný]: ${sDist[3]}x  │  [5 Nedostatočný]: ${sDist[4]}x`;
  out.push(`{cyan-fg}│{/cyan-fg}{white-fg}${padRawLine(distSummary, innerW)}{/white-fg}{cyan-fg}│{/cyan-fg}`);
  out.push(`{cyan-fg}└${'─'.repeat(innerW)}┘{/cyan-fg}`);
  out.push('');

  // 2. Detailed Table of All Grades in Subject
  const wIdx = 4;
  const wDate = 12;
  const wGrd = 15;
  const wNum = 9;
  const wPts = 12;
  const wWgt = 6;
  const wCavg = 10;
  const wTeach = 20;
  const wTitle = Math.max(18, innerW - (wIdx + wDate + wGrd + wNum + wPts + wWgt + wCavg + wTeach + 9));

  const sLine = (l, m, r) => l + [
    '─'.repeat(wIdx), '─'.repeat(wDate), '─'.repeat(wGrd), '─'.repeat(wNum),
    '─'.repeat(wPts), '─'.repeat(wWgt), '─'.repeat(wCavg), '─'.repeat(wTitle), '─'.repeat(wTeach),
  ].join(m) + r;

  out.push(`{cyan-fg}${sLine('┌', '┬', '┐')}{/cyan-fg}`);
  out.push(
    '{cyan-fg}│{/cyan-fg}' +
    `{bold}{cyan-fg}${padVis('#', wIdx, 'center')}{/bold}{/cyan-fg}{cyan-fg}│{/cyan-fg}` +
    `{bold}{cyan-fg}${padVis('DÁTUM', wDate, 'center')}{/bold}{/cyan-fg}{cyan-fg}│{/cyan-fg}` +
    `{bold}{cyan-fg}${padVis('HODNOTENIE', wGrd, 'center')}{/bold}{/cyan-fg}{cyan-fg}│{/cyan-fg}` +
    `{bold}{cyan-fg}${padVis('ZNÁMKA', wNum, 'center')}{/bold}{/cyan-fg}{cyan-fg}│{/cyan-fg}` +
    `{bold}{cyan-fg}${padVis('BODY / %', wPts, 'center')}{/bold}{/cyan-fg}{cyan-fg}│{/cyan-fg}` +
    `{bold}{cyan-fg}${padVis('VÁHA', wWgt, 'center')}{/bold}{/cyan-fg}{cyan-fg}│{/cyan-fg}` +
    `{bold}{cyan-fg}${padVis('PRIEM.TR.', wCavg, 'center')}{/bold}{/cyan-fg}{cyan-fg}│{/cyan-fg}` +
    `{bold}{cyan-fg}${padVis('NÁZOV ZADANIA / PÍSOMKY / TÉMA', wTitle)}{/bold}{/cyan-fg}{cyan-fg}│{/cyan-fg}` +
    `{bold}{cyan-fg}${padVis('ZAPÍSAL (UČITEĽ)', wTeach)}{/bold}{/cyan-fg}{cyan-fg}│{/cyan-fg}`
  );
  out.push(`{cyan-fg}${sLine('├', '┼', '┤')}{/cyan-fg}`);

  if (gRows.length === 0) {
    out.push(
      '{cyan-fg}│{/cyan-fg}' +
      `{white-fg}${padVis('-', wIdx, 'center')}{/white-fg}{cyan-fg}│{/cyan-fg}` +
      `{white-fg}${padVis('-', wDate, 'center')}{/white-fg}{cyan-fg}│{/cyan-fg}` +
      `{white-fg}${padVis('-', wGrd, 'center')}{/white-fg}{cyan-fg}│{/cyan-fg}` +
      `{white-fg}${padVis('-', wNum, 'center')}{/white-fg}{cyan-fg}│{/cyan-fg}` +
      `{white-fg}${padVis('-', wPts, 'center')}{/white-fg}{cyan-fg}│{/cyan-fg}` +
      `{white-fg}${padVis('-', wWgt, 'center')}{/white-fg}{cyan-fg}│{/cyan-fg}` +
      `{white-fg}${padVis('-', wCavg, 'center')}{/white-fg}{cyan-fg}│{/cyan-fg}` +
      `{white-fg}${padVis('Žiadne známky v tomto predmete.', wTitle)}{/white-fg}{cyan-fg}│{/cyan-fg}` +
      `{white-fg}${padVis('-', wTeach)}{/white-fg}{cyan-fg}│{/cyan-fg}`
    );
  } else {
    gRows.forEach((g, idx) => {
      const col = getGradeColorTag(g.numeric_val !== '-' ? g.numeric_val : g.grade);
      out.push(
        '{cyan-fg}│{/cyan-fg}' +
        `{white-fg}${padVis(`${idx + 1}.`, wIdx, 'center')}{/white-fg}{cyan-fg}│{/cyan-fg}` +
        `{white-fg}${padVis(g.date || '-', wDate, 'center')}{/white-fg}{cyan-fg}│{/cyan-fg}` +
        `{bold}{${col}}${padVis(g.grade || '-', wGrd, 'center')}{/${col}}{/bold}{cyan-fg}│{/cyan-fg}` +
        `{bold}{${col}}${padVis(g.numeric_val || '-', wNum, 'center')}{/${col}}{/bold}{cyan-fg}│{/cyan-fg}` +
        `{cyan-fg}${padVis(g.points_str || '-', wPts, 'center')}{/cyan-fg}{cyan-fg}│{/cyan-fg}` +
        `{white-fg}${padVis(g.weight || '1', wWgt, 'center')}{/white-fg}{cyan-fg}│{/cyan-fg}` +
        `{yellow-fg}${padVis(g.class_avg || '-', wCavg, 'center')}{/yellow-fg}{cyan-fg}│{/cyan-fg}` +
        `{white-fg}${padVis(g.title || '-', wTitle)}{/white-fg}{cyan-fg}│{/cyan-fg}` +
        `{green-fg}${padVis(g.teacher || '-', wTeach)}{/green-fg}{cyan-fg}│{/cyan-fg}`
      );
    });
  }

  out.push(`{cyan-fg}${sLine('└', '┴', '┘')}{/cyan-fg}`);

  gradesMainBox.setLabel(` [ PREDMET: ${(subj.short || subj.name || '').toUpperCase()} — ${(subj.full_name || subj.name || '').toUpperCase()} ] `);
  gradesMainBox.setContent(out.join('\n'));
}

function renderGradesCard() {
  renderGradesSidebar();
  const items = getGradesSidebarItems();
  const selected = items[gradesCursor] || items[0];

  if (!selected || selected.type === 'OVERVIEW') {
    renderGradesOverview();
  } else if (selected.type === 'COMMENDATIONS') {
    renderCommendationsView();
  } else if (selected.type === 'SUBJECT' && selected.subject) {
    renderSubjectDetailView(selected.subject);
  }
}

function updateWidgets() {
  updateHeader();
  updateFooter();

  // 1. Line Graph (5 sampled dates max to avoid x-axis text wrapping)
  const rawTrend = dashboardData.trend || { x: [], y: [] };
  if (rawTrend.x && rawTrend.x.length > 0) {
    let tx = rawTrend.x;
    let ty = rawTrend.y;
    if (tx.length > 5) {
      const step = (tx.length - 1) / 4;
      const idxs = [0, Math.round(step), Math.round(step * 2), Math.round(step * 3), tx.length - 1];
      tx = idxs.map((i) => rawTrend.x[i]);
      ty = idxs.map((i) => rawTrend.y[i]);
    }
    lineGraph.setData([
      {
        title: 'GPA',
        x: tx,
        y: ty,
        style: { line: 'green' },
      },
    ]);
  }

  // 2. High-contrast btop-style Grade Distribution Box
  const distData = (dashboardData.distribution && dashboardData.distribution.data) || [0, 0, 0, 0, 0];
  const distLabels = ['Výborný', 'Chválitebný', 'Dobrý', 'Dostatočný', 'Nedostatočný'];
  const distColors = ['green-fg', 'cyan-fg', 'yellow-fg', 'magenta-fg', 'red-fg'];
  const maxCount = Math.max(...distData, 1);
  const totalMarks = distData.reduce((a, b) => a + b, 0);

  let distLines = [];
  distData.forEach((count, i) => {
    const gradeNum = i + 1;
    const label = distLabels[i].padEnd(12, ' ');
    const color = distColors[i];
    const pct = totalMarks > 0 ? ((count / totalMarks) * 100).toFixed(1) : '0.0';
    const barLen = Math.round((count / maxCount) * 22);
    const barStr = barLen > 0 ? '█'.repeat(barLen) : '░';
    const paddedBar = barStr.padEnd(23, ' ');
    const countStr = String(count).padStart(2, ' ');
    const pctStr = `(${pct}%)`.padStart(7, ' ');
    distLines.push(` {bold}${gradeNum}{/bold}  ${label} {${color}}${paddedBar}{/${color}} {bold}${countStr}{/bold}  {cyan-fg}${pctStr}{/cyan-fg}`);
  });
  const passCount = distData[0] + distData[1] + distData[2] + distData[3];
  const passRate = totalMarks > 0 ? ((passCount / totalMarks) * 100).toFixed(1) : '0.0';
  distLines.push(` {bold}SPOLU:{/bold} ${totalMarks} známok  │  {bold}PRIEMER:{/bold} {green-fg}${dashboardData.gpa || '-'}{/green-fg}  │  {bold}ÚSPEŠNOSŤ:{/bold} ${passRate}%`);
  distributionBox.setContent(distLines.join('\n'));

  // 3. Live Monitor Timetable & Progress Calculation
  updateLiveProgress();

  // 4. Mini Lunch Box (Monitor)
  const lunch = dashboardData.lunches;
  if (lunch) {
    let lines = [];
    const statusCol = lunch.ordered_meal ? '{green-fg}' : '{red-fg}';
    lines.push(` {bold}STAV OBJEDNÁVKY:{/bold} ${statusCol}[${lunch.status || 'OBJEDNANÉ: ' + lunch.ordered_meal}]{/}`);
    if (lunch.serving) lines.push(` {bold}VÝDAJ OBEDA:{/bold} {white-fg}${lunch.serving}{/white-fg}`);
    if (lunch.menus && lunch.menus.length > 0) {
      lunch.menus.slice(0, 3).forEach((m) => {
        const numStr = m.number ? `[${m.number}] ` : '';
        lines.push(` • ${numStr}${m.name.slice(0, 48)}`);
      });
    }
    miniLunchBox.setContent(lines.join('\n'));
  } else {
    miniLunchBox.setContent(' {white-fg}Žiadne informácie o jedálni na dnešný deň.{/white-fg}');
  }

  // 5. Mini Tasks Table (Monitor)
  const taskRows = (dashboardData.tasks || []).map((t) => [
    t.date || '-',
    t.type || 'ÚLOHA',
    t.author || '-',
    (t.text || '-').slice(0, 32),
  ]);
  miniTasksTable.setData({
    headers: ['TERMÍN', 'TYP', 'UČITEĽ', 'ZADANIE'],
    data: taskRows.length > 0 ? taskRows : [['-', 'INFO', 'EduPage', 'Žiadne nevyriešené úlohy']],
  });

  // 6. Tab 2 Timetable View (Sidebar + Full-Screen Grid / Day / Breaks)
  renderTimetableCard();

  // 7. Tab 3 Grades View (Sidebar + Overview / Pochvaly / Subject Detail)
  renderGradesCard();

  screen.render();
}

// ==============================================================================
// Data Synchronization (Python dump-json Bridge)
// ==============================================================================

function fetchEdupageData(callback) {
  if (isFetching) return;
  isFetching = true;
  updateHeader();
  screen.render();

  const isWin = process.platform === 'win32';
  const venvPy = path.join(__dirname, '.venv', isWin ? 'Scripts' : 'bin', isWin ? 'python.exe' : 'python');
  const pythonCmd = fs.existsSync(venvPy) ? venvPy : (isWin ? 'python' : 'python3');

  const proc = spawn(pythonCmd, ['cli.py', 'dump-json'], {
    cwd: __dirname,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdoutData = '';
  let stderrData = '';

  proc.stdout.on('data', (chunk) => {
    stdoutData += chunk.toString();
  });

  proc.stderr.on('data', (chunk) => {
    stderrData += chunk.toString();
  });

  proc.on('close', (code) => {
    isFetching = false;
    if (code === 0 && stdoutData.trim()) {
      try {
        const parsed = JSON.parse(stdoutData.trim());
        if (parsed && parsed.user) {
          dashboardData = parsed;
          try {
            const cacheDir = path.join(os.homedir(), '.edupage');
            if (!fs.existsSync(cacheDir)) {
              fs.mkdirSync(cacheDir, { recursive: true });
            }
            fs.writeFileSync(path.join(cacheDir, 'dashboard_cache.json'), JSON.stringify(parsed, null, 2), 'utf-8');
          } catch (e) {}
        }
      } catch (err) {}
    }
    updateWidgets();
    if (callback) callback();
  });
}

function loadLocalCacheIfExists() {
  try {
    const cachePath = path.join(os.homedir(), '.edupage', 'dashboard_cache.json');
    if (fs.existsSync(cachePath)) {
      const content = fs.readFileSync(cachePath, 'utf-8');
      const parsed = JSON.parse(content);
      if (parsed && parsed.user) {
        return parsed;
      }
    }
  } catch (e) {}
  return null;
}

function getInitialState() {
  return {
    user: 'Načítavam...',
    subdomain: 'ssnd',
    school: 'ssnd.edupage.org',
    date: new Date().toISOString().split('T')[0],
    time: new Date().toTimeString().split(' ')[0],
    next_bell: '-',
    lesson_progress: 0,
    gpa: '-',
    standing: 'Synchronizujem...',
    total_marks: 0,
    trend: { x: [], y: [] },
    distribution: { titles: ['1', '2', '3', '4', '5'], data: [0, 0, 0, 0, 0] },
    subjects: [],
    timetable: [],
    periods_schedule: DEFAULT_PERIODS,
    breaks_schedule: DEFAULT_BREAKS,
    week_timetable: {},
    regular_week_timetable: {},
    lunches: null,
    tasks: [],
    all_grades: [],
    commendations: [],
  };
}

// ==============================================================================
// Keyboard Handlers & Two-Level Navigation (Topbar <-> Card Sidebar)
// ==============================================================================

// Direct Number Tab Switching [1 - 5]
screen.key(['1'], () => switchTab(0));
screen.key(['2'], () => switchTab(1));
screen.key(['3'], () => switchTab(2));
screen.key(['4'], () => switchTab(3));
screen.key(['5'], () => switchTab(4));

// Bracket Tab Switching always available globally
screen.key(['['], () => switchTab((activeTabIndex - 1 + TABS.length) % TABS.length));
screen.key([']'], () => switchTab((activeTabIndex + 1) % TABS.length));

// Left / Right Arrows: Switch Tabs when on Topbar; operate inside Card when in Sidebar
screen.key(['left', 'h'], () => {
  if (activeTabIndex === 1 && navFocus === 'card') {
    applySidebarItem(sidebarCursor, true);
    renderTimetableCard();
    screen.render();
  } else if (activeTabIndex === 2 && navFocus === 'card') {
    if (typeof gradesMainBox.scroll === 'function') gradesMainBox.scroll(-4);
    screen.render();
  } else {
    switchTab((activeTabIndex - 1 + TABS.length) % TABS.length);
  }
});

screen.key(['right', 'l'], () => {
  if (activeTabIndex === 1 && navFocus === 'card') {
    applySidebarItem(sidebarCursor, true);
    renderTimetableCard();
    screen.render();
  } else if (activeTabIndex === 2 && navFocus === 'card') {
    if (typeof gradesMainBox.scroll === 'function') gradesMainBox.scroll(4);
    screen.render();
  } else {
    switchTab((activeTabIndex + 1) % TABS.length);
  }
});

// Down Arrow: Enter Card Sidebar from Topbar, or move cursor down inside Sidebar
screen.key(['down', 'j'], () => {
  if (activeTabIndex === 1) {
    if (navFocus === 'topbar') {
      navFocus = 'card';
      updateHeader();
      updateFooter();
      renderTimetableCard();
      screen.render();
    } else if (sidebarCursor < SIDEBAR_ITEMS.length - 1) {
      sidebarCursor += 1;
      applySidebarItem(sidebarCursor, false);
      renderTimetableCard();
      screen.render();
    }
  } else if (activeTabIndex === 2) {
    const gItems = getGradesSidebarItems();
    if (navFocus === 'topbar') {
      navFocus = 'card';
      updateHeader();
      updateFooter();
      renderGradesCard();
      screen.render();
    } else if (gradesCursor < gItems.length - 1) {
      gradesCursor += 1;
      if (typeof gradesMainBox.scrollTo === 'function') gradesMainBox.scrollTo(0);
      renderGradesCard();
      screen.render();
    }
  }
});

// Up Arrow: Move cursor up inside Card Sidebar; exit back to Topbar from top item
screen.key(['up', 'k'], () => {
  if (activeTabIndex === 1 && navFocus === 'card') {
    if (sidebarCursor > 0) {
      sidebarCursor -= 1;
      applySidebarItem(sidebarCursor, false);
      renderTimetableCard();
      screen.render();
    } else {
      navFocus = 'topbar';
      updateHeader();
      updateFooter();
      renderTimetableCard();
      screen.render();
    }
  } else if (activeTabIndex === 2 && navFocus === 'card') {
    if (gradesCursor > 0) {
      gradesCursor -= 1;
      if (typeof gradesMainBox.scrollTo === 'function') gradesMainBox.scrollTo(0);
      renderGradesCard();
      screen.render();
    } else {
      navFocus = 'topbar';
      updateHeader();
      updateFooter();
      renderGradesCard();
      screen.render();
    }
  }
});

// Enter / Space: Activate or toggle item inside Sidebar
screen.key(['enter', 'space'], () => {
  if (activeTabIndex === 1 && navFocus === 'card') {
    applySidebarItem(sidebarCursor, true);
    renderTimetableCard();
    screen.render();
  } else if (activeTabIndex === 2 && navFocus === 'card') {
    renderGradesCard();
    screen.render();
  }
});

// Tab / Shift-Tab widget focus cycling inside Monitor tab
screen.key(['tab'], () => {
  const widgets = TAB_WIDGETS[activeTabIndex];
  if (widgets && widgets.length > 1) {
    activeWidgetIndex = (activeWidgetIndex + 1) % widgets.length;
    widgets[activeWidgetIndex].focus();
    screen.render();
  }
});

screen.key(['S-tab'], () => {
  const widgets = TAB_WIDGETS[activeTabIndex];
  if (widgets && widgets.length > 1) {
    activeWidgetIndex = (activeWidgetIndex - 1 + widgets.length) % widgets.length;
    widgets[activeWidgetIndex].focus();
    screen.render();
  }
});

// Refresh
screen.key(['r'], () => {
  fetchEdupageData();
});

// Quit
screen.key(['escape', 'q', 'C-c'], () => {
  process.exit(0);
});

// Responsive resize
screen.on('resize', () => {
  updateWidgets();
});

// ==============================================================================
// App Launch
// ==============================================================================

switchTab(0);
updateWidgets();

setInterval(() => {
  updateHeader();
  updateLiveProgress();
  if (activeTabIndex === 1) {
    renderTimetableCard();
  }
  screen.render();
}, 1000);

fetchEdupageData();
