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
const TABS = ['monitor', 'grades', 'timetable', 'lunches', 'tasks'];
const TAB_LABELS = [
  ' 1: MONITOR ',
  ' 2: ZNÁMKY ',
  ' 3: ROZVRH ',
  ' 4: OBEDY ',
  ' 5: ÚLOHY ',
];
let activeTabIndex = 0;
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
// TAB 2: ZNÁMKY
// ==============================================================================

const viewGrades = blessed.box({
  parent: contentArea,
  top: 0,
  left: 0,
  width: '100%',
  height: '100%',
  hidden: true,
});

const gradesGrid = new contrib.grid({ rows: 12, cols: 12, screen: viewGrades });

// Subjects Table (Left, 4 cols - Yellow Border)
const subjectsTable = gradesGrid.set(0, 0, 12, 4, contrib.table, {
  keys: true,
  interactive: true,
  label: ' [ PREDMETY ] ',
  border: { type: 'line', fg: 'yellow' },
  columnSpacing: 2,
  columnWidth: [10, 9, 9, 7],
  headers: ['PREDMET', 'PRIEMER', 'ÚSPECH', 'POČET'],
  fg: 'white',
  selectedFg: 'black',
  selectedBg: 'white',
  style: {
    border: { fg: 'yellow' },
    header: { fg: 'cyan', bold: true },
  },
});

// Full Grades Table (Right, 8 cols - Green Border)
const fullGradesTable = gradesGrid.set(0, 4, 12, 8, contrib.table, {
  keys: true,
  interactive: true,
  label: ' [ VŠETKY ZAPÍSANÉ ZNÁMKY ] ',
  border: { type: 'line', fg: 'green' },
  columnSpacing: 2,
  columnWidth: [11, 9, 8, 6, 34, 26],
  headers: ['DÁTUM', 'PREDMET', 'ZNÁMKA', 'VÁHA', 'ZADANIE / UDALOSŤ', 'POZNÁMKA / UČITEĽ'],
  fg: 'white',
  selectedFg: 'black',
  selectedBg: 'white',
  style: {
    border: { fg: 'green' },
    header: { fg: 'cyan', bold: true },
  },
});

// ==============================================================================
// TAB 3: ROZVRH
// ==============================================================================

const viewTimetable = blessed.box({
  parent: contentArea,
  top: 0,
  left: 0,
  width: '100%',
  height: '100%',
  hidden: true,
});

const timetableInfoBox = blessed.box({
  parent: viewTimetable,
  top: 0,
  left: 0,
  width: '100%',
  height: 3,
  tags: true,
  border: { type: 'line', fg: 'green' },
  label: ' [ TÝŽDENNÝ ROZVRH HODÍN ] ',
  style: {
    border: { fg: 'green' },
    fg: 'white',
    bg: 'black',
  },
});

const fullTimetableTable = contrib.table({
  parent: viewTimetable,
  top: 3,
  left: 0,
  width: '100%',
  height: '100%-3',
  keys: true,
  interactive: true,
  border: { type: 'line', fg: 'green' },
  label: ' [ ROZVRH HODÍN SO SKUPINAMI A UČEBNAMI ] ',
  columnSpacing: 2,
  columnWidth: [4, 13, 30, 22, 24, 12, 36],
  headers: ['HOD', 'ČAS', 'PREDMET', 'UČITEĽ', 'UČEBŇA', 'STAV', 'TÉMA HODINY'],
  fg: 'white',
  selectedFg: 'black',
  selectedBg: 'white',
  style: {
    border: { fg: 'green' },
    header: { fg: 'cyan', bold: true },
  },
});

// ==============================================================================
// TAB 4: OBEDY
// ==============================================================================

const viewLunches = blessed.box({
  parent: contentArea,
  top: 0,
  left: 0,
  width: '100%',
  height: '100%',
  hidden: true,
});

const lunchesInfoBox = blessed.box({
  parent: viewLunches,
  top: 0,
  left: 0,
  width: '100%',
  height: 4,
  tags: true,
  border: { type: 'line', fg: 'magenta' },
  label: ' [ ŠKOLSKÁ JEDÁLEŇ ] ',
  style: {
    border: { fg: 'magenta' },
    fg: 'white',
    bg: 'black',
  },
});

const fullLunchesTable = contrib.table({
  parent: viewLunches,
  top: 4,
  left: 0,
  width: '100%',
  height: '100%-4',
  keys: true,
  interactive: true,
  border: { type: 'line', fg: 'cyan' },
  label: ' [ JEDÁLNY LÍSTOK NA DNES ] ',
  columnSpacing: 2,
  columnWidth: [4, 65, 10, 18, 12],
  headers: ['#', 'NÁZOV JEDLA', 'GRAMÁŽ', 'ALERGÉNY', 'OBJEDNANÉ'],
  fg: 'white',
  selectedFg: 'black',
  selectedBg: 'white',
  style: {
    border: { fg: 'cyan' },
    header: { fg: 'cyan', bold: true },
  },
});

// ==============================================================================
// TAB 5: ÚLOHY
// ==============================================================================

const viewTasks = blessed.box({
  parent: contentArea,
  top: 0,
  left: 0,
  width: '100%',
  height: '100%',
  hidden: true,
});

const tasksInfoBox = blessed.box({
  parent: viewTasks,
  top: 0,
  left: 0,
  width: '100%',
  height: 3,
  tags: true,
  border: { type: 'line', fg: 'blue' },
  label: ' [ PREHĽAD POVINNOSTÍ ] ',
  style: {
    border: { fg: 'blue' },
    fg: 'white',
    bg: 'black',
  },
});

const fullTasksTable = contrib.table({
  parent: viewTasks,
  top: 3,
  left: 0,
  width: '100%',
  height: '100%-3',
  keys: true,
  interactive: true,
  border: { type: 'line', fg: 'green' },
  label: ' [ ZOZNAM DOMÁCICH ÚLOH, TESTOV A ZADANÍ ] ',
  columnSpacing: 2,
  columnWidth: [12, 12, 22, 90],
  headers: ['TERMÍN', 'TYP', 'UČITEĽ', 'TEXT ZADANIA'],
  fg: 'white',
  selectedFg: 'black',
  selectedBg: 'white',
  style: {
    border: { fg: 'green' },
    header: { fg: 'cyan', bold: true },
  },
});

// View Containers & Focusable Widgets Registry
const VIEW_CONTAINERS = [viewMonitor, viewGrades, viewTimetable, viewLunches, viewTasks];

const TAB_WIDGETS = [
  [timetableTable, miniTasksTable],
  [fullGradesTable, subjectsTable],
  [fullTimetableTable],
  [fullLunchesTable],
  [fullTasksTable],
];
let activeWidgetIndex = 0;

// ==============================================================================
// Tab Navigation
// ==============================================================================

function switchTab(index) {
  if (index < 0) index = TABS.length - 1;
  if (index >= TABS.length) index = 0;

  activeTabIndex = index;
  activeWidgetIndex = 0;

  VIEW_CONTAINERS.forEach((c, idx) => {
    if (idx === activeTabIndex) {
      c.show();
    } else {
      c.hide();
    }
  });

  updateHeader();

  const currentTabWidgets = TAB_WIDGETS[activeTabIndex];
  if (currentTabWidgets && currentTabWidgets.length > 0) {
    currentTabWidgets[0].focus();
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

  headerBox.setLabel(' [ EDUPAGE BTOP MONITOR - ' + school + ' ] ');

  const tabButtons = TAB_LABELS.map((label, idx) => {
    if (idx === activeTabIndex) {
      return `{black-bg}{white-fg}{bold}${label}{/bold}{/black-bg}`;
    }
    return `{cyan-fg}[${label.trim()}]{/cyan-fg}`;
  }).join('   ');

  headerBox.setContent(
    ` {bold}POUŽÍVATEĽ:{/bold} ${user}  │  {bold}PRIEMER:{/bold} {green-fg}{bold}${gpa}{/bold}{/green-fg}  │  {bold}PROSPECH:{/bold} ${standingColor}${standing}{/}  │  {bold}ZVONENIE:{/bold} {yellow-fg}${nextBell}{/yellow-fg}  │  {bold}ČAS:{/bold} ${timeStr}  ${statusBadge}\n` +
    ` {bold}KARTY:{/bold}  ${tabButtons}`
  );
}

// Active Timetable Day State (0=Pondelok, 1=Utorok, 2=Streda, 3=Štvrtok, 4=Piatok, 5=Celý týždeň)
let selectedDayIndex = (new Date().getDay() + 6) % 7;
if (selectedDayIndex > 4) selectedDayIndex = 0;

function updateLiveProgress() {
  const now = new Date();
  const nowSec = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();
  const tt = dashboardData.timetable || [];

  if (!tt || tt.length === 0) {
    lessonGauge.setLabel(' [ ROZVRH: Žiadne naplánované hodiny ] ');
    lessonGauge.setPercent(0);
    return;
  }

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

  if (activeLessons.length === 0) {
    lessonGauge.setLabel(' [ VOĽNÝ DEŇ: Žiadne vyučovanie ] ');
    lessonGauge.setPercent(100);
    return;
  }

  const firstLesson = activeLessons[0];
  const lastLesson = activeLessons[activeLessons.length - 1];

  let current = null;
  let next = null;
  let prev = null;

  for (let i = 0; i < activeLessons.length; i++) {
    const l = activeLessons[i];
    if (nowSec >= l.startSec && nowSec <= l.endSec) {
      current = l;
      next = activeLessons[i + 1] || null;
      break;
    }
    if (nowSec < l.startSec) {
      next = l;
      prev = activeLessons[i - 1] || null;
      break;
    }
    prev = l;
  }

  if (nowSec < firstLesson.startSec) {
    const remSec = firstLesson.startSec - nowSec;
    const remMin = Math.ceil(remSec / 60);
    const startStr = firstLesson.start || (firstLesson.time ? firstLesson.time.split('-')[0] : '08:45');
    lessonGauge.setLabel(` [ PRED VYUČOVANÍM: 1. hodina ${firstLesson.subject} začína o ${startStr} (zostáva ${remMin} min) ] `);
    lessonGauge.setPercent(0);
  } else if (current) {
    const totalSec = Math.max(1, current.endSec - current.startSec);
    const elapsedSec = Math.max(0, nowSec - current.startSec);
    const remSec = Math.max(0, current.endSec - nowSec);
    const remMin = Math.ceil(remSec / 60);
    const pct = Math.max(0, Math.min(100, Math.round((elapsedSec / totalSec) * 100)));
    lessonGauge.setLabel(` [ PREBIEHA: ${current.subject} (${current.time}) │ ${pct}% │ zostáva ${remMin} min ] `);
    lessonGauge.setPercent(pct);
  } else if (nowSec > lastLesson.endSec) {
    lessonGauge.setLabel(' [ KONIEC VYUČOVANIA: Dnes absolvované všetky hodiny │ Voľno ] ');
    lessonGauge.setPercent(100);
  } else if (prev && next) {
    const totalBreak = Math.max(1, next.startSec - prev.endSec);
    const elapsedBreak = Math.max(0, nowSec - prev.endSec);
    const remSec = Math.max(0, next.startSec - nowSec);
    const remMin = Math.ceil(remSec / 60);
    const pct = Math.max(0, Math.min(100, Math.round((elapsedBreak / totalBreak) * 100)));
    const breakType = totalBreak >= 900 ? 'VEĽKÁ PRESTÁVKA' : 'PRESTÁVKA';
    const nextStart = next.start || (next.time ? next.time.split('-')[0] : '');
    const nextRoom = next.room && next.room !== '-' ? ` (${next.room})` : '';
    lessonGauge.setLabel(` [ ${breakType}: do ${nextStart} │ Nasleduje: ${next.subject}${nextRoom} │ ${pct}% │ zostáva ${remMin} min ] `);
    lessonGauge.setPercent(pct);
  }

  // Live update monitor timetable table
  const updatedTtRows = parsedLessons.map((l) => {
    let st = l.status;
    if (l.status === 'ODPADLA') {
      st = 'ODPADLA';
    } else if (l.status === 'VOĽNO') {
      st = 'VOĽNO';
    } else if (current && l.period === current.period && l.subject === current.subject) {
      st = '>> TERAZ';
    } else if (next && l.period === next.period && l.subject === next.subject) {
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

function updateTimetableTab() {
  const weekTt = dashboardData.week_timetable || {};
  const dayKeys = Object.keys(weekTt).sort();
  const dayNames = ['Pondelok', 'Utorok', 'Streda', 'Štvrtok', 'Piatok'];

  let pills = [];
  for (let i = 0; i < 5; i++) {
    const k = dayKeys[i];
    const dInfo = k ? weekTt[k] : null;
    const name = dInfo ? dInfo.day_name : dayNames[i];
    const isToday = dInfo ? dInfo.is_today : false;
    const todayMarker = isToday ? ' [DNES]' : '';
    if (selectedDayIndex === i) {
      pills.push(`{black-bg}{green-fg}{bold} ${name}${todayMarker} {/}`);
    } else if (isToday) {
      pills.push(`{cyan-fg}[${name}*]{/}`);
    } else {
      pills.push(`{grey-fg}${name}{/}`);
    }
  }
  if (selectedDayIndex === 5) {
    pills.push('{black-bg}{green-fg}{bold} CELÝ TÝŽDEŇ {/}');
  } else {
    pills.push('{grey-fg}Celý týždeň{/}');
  }

  timetableInfoBox.setContent(
    ` ${pills.join('  │  ')}\n` +
    ' {grey-fg}Navigácia: [← / →] Dni │ [W] Celý týždeň │ [P] Pondelok │ [U] Utorok │ [S] Streda │ [T] Štvrtok │ [F] Piatok{/}'
  );

  let rows = [];
  if (selectedDayIndex === 5) {
    dayKeys.forEach((k) => {
      const dInfo = weekTt[k];
      if (dInfo && dInfo.lessons && dInfo.lessons.length > 0) {
        dInfo.lessons.forEach((l) => {
          rows.push([
            `${dInfo.day_name.slice(0, 2)} ${l.period || '-'}`,
            l.time || '-',
            l.subject || '-',
            l.teacher || '-',
            l.room || '-',
            l.status || '-',
            l.topic || '-',
          ]);
        });
      }
    });
  } else {
    const selectedKey = dayKeys[selectedDayIndex];
    const dInfo = selectedKey ? weekTt[selectedKey] : null;
    if (dInfo && dInfo.lessons && dInfo.lessons.length > 0) {
      rows = dInfo.lessons.map((l) => [
        l.period || '-',
        l.time || '-',
        l.subject || '-',
        l.teacher || '-',
        l.room || '-',
        l.status || '-',
        l.topic || '-',
      ]);
    } else if (dashboardData.timetable && selectedDayIndex === ((new Date().getDay() + 6) % 7)) {
      rows = dashboardData.timetable.map((l) => [
        l.period || '-',
        l.time || '-',
        l.subject || '-',
        l.teacher || '-',
        l.room || '-',
        l.status || '-',
        l.topic || '-',
      ]);
    }
  }

  fullTimetableTable.setData({
    headers: ['HOD', 'ČAS', 'PREDMET', 'UČITEĽ', 'UČEBŇA', 'STAV', 'TÉMA HODINY'],
    data: rows.length > 0 ? rows : [['-', '-', 'V tento deň nie sú naplánované žiadne hodiny (voľno / prázdniny)', '-', '-', '-', '-']],
  });
}

function updateWidgets() {
  updateHeader();

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
    distLines.push(` {bold}${gradeNum}{/bold}  ${label} {${color}}${paddedBar}{/${color}} {bold}${countStr}{/bold}  {grey-fg}${pctStr}{/grey-fg}`);
  });
  const passCount = distData[0] + distData[1] + distData[2] + distData[3];
  const passRate = totalMarks > 0 ? ((passCount / totalMarks) * 100).toFixed(1) : '0.0';
  distLines.push(` {bold}SPOLU:{/bold} ${totalMarks} známok  │  {bold}PRIEMER:{/bold} {green-fg}${dashboardData.gpa || '-'}{/green-fg}  │  {bold}ÚSPEŠNOSŤ:{/bold} ${passRate}%`);
  distributionBox.setContent(distLines.join('\n'));

  // 3. Live Timetable & Progress Calculation
  updateLiveProgress();

  // 4. Tab 3 Timetable View
  updateTimetableTab();

  // 5. Mini Lunch Box (Monitor)
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
    miniLunchBox.setContent(' {grey-fg}Žiadne informácie o jedálni na dnešný deň.{/grey-fg}');
  }

  // 6. Mini Tasks Table (Monitor)
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

  // 7. Grades View
  const subjRows = (dashboardData.subjects || []).map((s) => [
    s.name || '-',
    s.avg || '-',
    s.percent || '-',
    String(s.count || 0),
  ]);
  subjectsTable.setData({
    headers: ['PREDMET', 'PRIEMER', 'ÚSPECH', 'POČET'],
    data: subjRows.length > 0 ? subjRows : [['-', '-', '-', '-']],
  });

  const allGradesRows = (dashboardData.all_grades || []).map((g) => [
    g.date || '-',
    g.subject || '-',
    g.grade || '-',
    g.weight || '-',
    g.title || '-',
    g.comment || '-',
  ]);
  fullGradesTable.setData({
    headers: ['DÁTUM', 'PREDMET', 'ZNÁMKA', 'VÁHA', 'ZADANIE / UDALOSŤ', 'POZNÁMKA / UČITEĽ'],
    data: allGradesRows.length > 0 ? allGradesRows : [['-', '-', '-', '-', 'Žiadne zapísané známky', '-']],
  });

  // 8. Timetable View (Managed by updateTimetableTab())
  updateTimetableTab();

  // 9. Lunches View
  if (lunch) {
    lunchesInfoBox.setContent(
      ` {bold}STAV OBJEDNÁVKY:{/bold} ${lunch.ordered_meal ? '{green-fg}[OBJEDNANÉ: ' + lunch.ordered_meal + ']{/green-fg}' : '{red-fg}[NEOBJEDNANÉ]{/red-fg}'}   │   ` +
      ` {bold}ČAS VÝDAJA:{/bold} ${lunch.serving || '-'}   │   ` +
      ` {bold}JEDÁLEŇ:{/bold} Spojená škola sv. Jána Bosca\n` +
      ` {bold}MENU NA DNES:{/bold} ${(lunch.title || '').replace(/\n/g, ' | ').slice(0, 80)}`
    );
    const menuRows = (lunch.menus || []).map((m) => [
      m.number ? String(m.number) : '•',
      m.name || '-',
      m.weight ? `${m.weight}g` : '-',
      m.allergens || '-',
      lunch.ordered_meal && m.number === lunch.ordered_meal ? '>> ÁNO' : 'NIE',
    ]);
    fullLunchesTable.setData({
      headers: ['#', 'NÁZOV JEDLA', 'GRAMÁŽ', 'ALERGÉNY', 'OBJEDNANÉ'],
      data: menuRows.length > 0 ? menuRows : [['-', 'Dnes nie je k dispozícii menu', '-', '-', '-']],
    });
  } else {
    lunchesInfoBox.setContent(' {grey-fg}Žiadne údaje o dnešnom obede.{/grey-fg}');
    fullLunchesTable.setData({
      headers: ['#', 'NÁZOV JEDLA', 'GRAMÁŽ', 'ALERGÉNY', 'OBJEDNANÉ'],
      data: [['-', 'Žiadne údaje', '-', '-', '-']],
    });
  }

  // 10. Tasks View
  const taskCount = dashboardData.tasks ? dashboardData.tasks.length : 0;
  const nextTask = taskCount > 0 ? `${dashboardData.tasks[0].date} (${dashboardData.tasks[0].text.slice(0, 35)})` : 'Žiadny';
  tasksInfoBox.setContent(
    ` {bold}NEVYRIEŠENÉ ZADANIA:{/bold} ${taskCount} úloh a písomiek  │  {bold}NAJBLIŽŠÍ TERMÍN:{/bold} ${nextTask}`
  );

  const fullTasksRows = (dashboardData.tasks || []).map((t) => [
    t.date || '-',
    t.type || 'ÚLOHA',
    t.author || '-',
    t.text || '-',
  ]);
  fullTasksTable.setData({
    headers: ['TERMÍN', 'TYP', 'UČITEĽ', 'TEXT ZADANIA'],
    data: fullTasksRows.length > 0 ? fullTasksRows : [['-', 'INFO', 'EduPage', 'Žiadne nevyriešené úlohy']],
  });

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
    lunches: null,
    tasks: [],
    all_grades: [],
  };
}

// ==============================================================================
// Keyboard Handlers & Navigation
// ==============================================================================

// Direct Number Tab Switching [1 - 5]
screen.key(['1'], () => switchTab(0));
screen.key(['2'], () => switchTab(1));
screen.key(['3'], () => switchTab(2));
screen.key(['4'], () => switchTab(3));
screen.key(['5'], () => switchTab(4));

// Left / Right Tab Switching or Day Switching in Rozvrh
screen.key(['['], () => {
  switchTab((activeTabIndex - 1 + TABS.length) % TABS.length);
});

screen.key([']'], () => {
  switchTab((activeTabIndex + 1) % TABS.length);
});

screen.key(['left', 'h'], () => {
  if (activeTabIndex === 2) {
    selectedDayIndex = (selectedDayIndex - 1 + 6) % 6;
    updateTimetableTab();
    screen.render();
  } else {
    switchTab((activeTabIndex - 1 + TABS.length) % TABS.length);
  }
});

screen.key(['right', 'l'], () => {
  if (activeTabIndex === 2) {
    selectedDayIndex = (selectedDayIndex + 1) % 6;
    updateTimetableTab();
    screen.render();
  } else {
    switchTab((activeTabIndex + 1) % TABS.length);
  }
});

// Timetable Day Quick Keys (when inside Tab 3: Rozvrh)
screen.key(['p', 'P'], () => {
  if (activeTabIndex === 2) {
    selectedDayIndex = 0; // Pondelok
    updateTimetableTab();
    screen.render();
  }
});

screen.key(['u', 'U'], () => {
  if (activeTabIndex === 2) {
    selectedDayIndex = 1; // Utorok
    updateTimetableTab();
    screen.render();
  }
});

screen.key(['s', 'S'], () => {
  if (activeTabIndex === 2) {
    selectedDayIndex = 2; // Streda
    updateTimetableTab();
    screen.render();
  }
});

screen.key(['t', 'T'], () => {
  if (activeTabIndex === 2) {
    selectedDayIndex = 3; // Štvrtok
    updateTimetableTab();
    screen.render();
  }
});

screen.key(['f', 'F'], () => {
  if (activeTabIndex === 2) {
    selectedDayIndex = 4; // Piatok
    updateTimetableTab();
    screen.render();
  }
});

screen.key(['w', 'W'], () => {
  if (activeTabIndex === 2) {
    selectedDayIndex = 5; // Celý týždeň
    updateTimetableTab();
    screen.render();
  }
});

// Tab / Shift-Tab widget focus cycling inside active tab
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
  screen.render();
}, 1000);

fetchEdupageData();
