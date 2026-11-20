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
  terminal: 'xterm-256color',
  cursor: {
    artificial: true,
    shape: 'line',
    blink: true,
    color: 'white',
  },
});
if (screen.tput) {
  screen.tput.colors = 256;
}

// ==============================================================================
// Monochrome + Active Orange Palette (256-Color Grayscale + Orange 208)
// ==============================================================================

const COLOR_ORANGE = 208;    // #ff8700 - ONLY for currently active/controlled element
const COLOR_WHITE = 255;     // #eeeeee - Primary bright text
const COLOR_LIGHT_GRAY = 250;// #bcbcbc - Secondary text / table headers
const COLOR_MID_GRAY = 244;  // #808080 - Muted labels / borders / inactive tabs
const COLOR_DARK_GRAY = 240; // #585858 - Subtle grid lines & inactive frames
const COLOR_CHARCOAL = 236;  // #303030 - Dark surface highlight

// Navigation State
const TABS = ['monitor', 'timetable', 'grades', 'messages', 'lunches'];
const TAB_LABELS = [
  ' 1: MONITOR ',
  ' 2: ROZVRH ',
  ' 3: ZNÁMKY ',
  ' 4: SPRÁVY ',
  ' 5: OBEDY ',
];
let activeTabIndex = 0;
let navFocus = 'topbar'; // 'topbar' | 'card'
let msgSubFocus = 'feed'; // 'feed' | 'filters' | 'search' (for Tab 4: SPRÁVY)
let dashboardData = loadLocalCacheIfExists() || getInitialState();
let isFetching = false;

// ==============================================================================
// Top Header Box (Monochrome Frame - Orange when Topbar is controlled)
// ==============================================================================

const headerBox = blessed.box({
  parent: screen,
  top: 0,
  left: 0,
  width: '100%',
  height: 5,
  tags: true,
  border: { type: 'line', fg: COLOR_ORANGE },
  label: ' [ EDUPAGE MONITOR - ssnd.edupage.org ] ',
  style: {
    border: { fg: COLOR_ORANGE },
    fg: 'white',
    bg: 'black',
  },
});

// ==============================================================================
// Bottom Footer Box (Minimal Monochrome Bar)
// ==============================================================================

const footerBox = blessed.box({
  parent: screen,
  bottom: 0,
  left: 0,
  width: '100%',
  height: 3,
  tags: true,
  border: { type: 'line', fg: COLOR_DARK_GRAY },
  label: ' [ SKRATKY ] ',
  style: {
    border: { fg: COLOR_DARK_GRAY },
    fg: 'white',
    bg: 'black',
  },
  content: ' {250-fg}[1-5]{/250-fg} {244-fg}Karty{/244-fg}  {240-fg}│{/240-fg}  {250-fg}[Šípky]{/250-fg} {244-fg}Pohyb{/244-fg}  {240-fg}│{/240-fg}  {250-fg}[r]{/250-fg} {244-fg}Obnoviť{/244-fg}  {240-fg}│{/240-fg}  {250-fg}[q]{/250-fg} {244-fg}Koniec{/244-fg}',
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

// 1. Marks Trend (Monochrome white line on dark gray border)
const lineGraph = monitorGrid.set(0, 0, 5, 6, contrib.line, {
  label: ' [ VÝVOJ PRIEMERU ] ',
  showLegend: false,
  xPadding: 2,
  xLabelPadding: 1,
  wholeNumbersOnly: false,
  minY: 1.0,
  maxY: 3.5,
  border: { type: 'line', fg: COLOR_DARK_GRAY },
  style: {
    line: 'white',
    text: 'white',
    baseline: 'black',
    border: { fg: COLOR_DARK_GRAY },
  },
});

// 2. Marks Distribution (Monochrome)
const distributionBox = monitorGrid.set(5, 0, 4, 6, blessed.box, {
  label: ' [ ROZDELENIE ZNÁMOK (1 - 5) ] ',
  tags: true,
  border: { type: 'line', fg: COLOR_DARK_GRAY },
  style: {
    border: { fg: COLOR_DARK_GRAY },
    fg: 'white',
    bg: 'black',
  },
});

// 3. Mini Lunch Box (Monochrome)
const miniLunchBox = monitorGrid.set(9, 0, 3, 6, blessed.box, {
  label: ' [ DNEŠNÝ OBED ] ',
  tags: true,
  border: { type: 'line', fg: COLOR_DARK_GRAY },
  style: {
    border: { fg: COLOR_DARK_GRAY },
    fg: 'white',
    bg: 'black',
  },
});

// 4. Timetable Table (Monochrome; orange selection when focused)
const timetableTable = monitorGrid.set(0, 6, 6, 6, contrib.table, {
  keys: true,
  interactive: true,
  label: ' [ DNEŠNÝ ROZVRH ] ',
  border: { type: 'line', fg: COLOR_DARK_GRAY },
  columnSpacing: 2,
  columnWidth: [4, 13, 26, 20, 10],
  headers: ['#', 'ČAS', 'PREDMET', 'UČITEĽ', 'STAV'],
  fg: 'white',
  selectedFg: 'black',
  selectedBg: COLOR_ORANGE,
  style: {
    border: { fg: COLOR_DARK_GRAY },
    header: { fg: 'white', bold: true },
  },
});

// 5. Current Lesson Progress Gauge (Monochrome)
const lessonGauge = monitorGrid.set(6, 6, 2, 6, contrib.gauge, {
  label: ' [ PRIEBEH VYUČOVANIA ] ',
  stroke: 'white',
  fill: 'white',
  border: { type: 'line', fg: COLOR_DARK_GRAY },
  style: {
    border: { fg: COLOR_DARK_GRAY },
  },
});

// 6. Mini Tasks Table (Monochrome; orange selection when focused)
const miniTasksTable = monitorGrid.set(8, 6, 4, 6, contrib.table, {
  keys: true,
  interactive: true,
  label: ' [ ÚLOHY A PÍSOMKY ] ',
  border: { type: 'line', fg: COLOR_DARK_GRAY },
  columnSpacing: 2,
  columnWidth: [11, 10, 18, 30],
  headers: ['TERMÍN', 'TYP', 'UČITEĽ', 'ZADANIE'],
  fg: 'white',
  selectedFg: 'black',
  selectedBg: COLOR_ORANGE,
  style: {
    border: { fg: COLOR_DARK_GRAY },
    header: { fg: 'white', bold: true },
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
  border: { type: 'line', fg: COLOR_DARK_GRAY },
  label: ' [ ROZVRH ] ',
  style: {
    border: { fg: COLOR_DARK_GRAY },
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
  border: { type: 'line', fg: COLOR_DARK_GRAY },
  label: ' [ TÝŽDENNÝ ROZVRH ] ',
  style: {
    border: { fg: COLOR_DARK_GRAY },
    fg: 'white',
    bg: 'black',
  },
});

// ==============================================================================
// EMPTY PLACEHOLDER HELPER
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
    border: { type: 'line', fg: COLOR_DARK_GRAY },
    label: ` [ ${labelText} ] `,
    style: {
      border: { fg: COLOR_DARK_GRAY },
      fg: 'white',
      bg: 'black',
    },
    content: `{bold}{white-fg}${labelText}{/white-fg}{/bold}\n\n{244-fg}Zatiaľ prázdne.{/244-fg}`,
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
  border: { type: 'line', fg: COLOR_DARK_GRAY },
  label: ' [ PREDMETY ] ',
  style: {
    border: { fg: COLOR_DARK_GRAY },
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
  border: { type: 'line', fg: COLOR_DARK_GRAY },
  label: ' [ ZNÁMKY ] ',
  style: {
    border: { fg: COLOR_DARK_GRAY },
    fg: 'white',
    bg: 'black',
  },
});

// ==============================================================================
// TAB 4: SPRÁVY (Timeline Notifications, Left Checkbox Filters & Top Search Bar)
// ==============================================================================

const viewMessages = blessed.box({
  parent: contentArea,
  top: 0,
  left: 0,
  width: '100%',
  height: '100%',
  hidden: true,
});

const messagesSidebar = blessed.box({
  parent: viewMessages,
  top: 0,
  left: 0,
  width: SIDEBAR_WIDTH,
  height: '100%',
  tags: true,
  border: { type: 'line', fg: COLOR_DARK_GRAY },
  label: ' [ FILTRE ] ',
  style: {
    border: { fg: COLOR_DARK_GRAY },
    fg: 'white',
    bg: 'black',
  },
});

const messagesSearchBox = blessed.box({
  parent: viewMessages,
  top: 0,
  left: SIDEBAR_WIDTH,
  width: `100%-${SIDEBAR_WIDTH}`,
  height: 3,
  tags: true,
  border: { type: 'line', fg: COLOR_DARK_GRAY },
  label: ' [ HĽADAŤ ] ',
  style: {
    border: { fg: COLOR_DARK_GRAY },
    fg: 'white',
    bg: 'black',
  },
});

const messagesFeedBox = blessed.box({
  parent: viewMessages,
  top: 3,
  left: SIDEBAR_WIDTH,
  width: `100%-${SIDEBAR_WIDTH}`,
  bottom: 0,
  tags: true,
  scrollable: true,
  alwaysScroll: true,
  border: { type: 'line', fg: COLOR_DARK_GRAY },
  label: ' [ SPRÁVY ] ',
  style: {
    border: { fg: COLOR_DARK_GRAY },
    fg: 'white',
    bg: 'black',
  },
});

// ==============================================================================
// TAB 5: EMPTY PLACEHOLDER
// ==============================================================================

const viewLunches = createEmptyTabPlaceholder('5: OBEDY');

// View Containers & Focusable Widgets Registry
const VIEW_CONTAINERS = [viewMonitor, viewTimetable, viewGrades, viewMessages, viewLunches];

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
  return tabIdx === 1 || tabIdx === 2 || tabIdx === 3;
}

function updateMonitorFocusStyles() {
  const isMonitorCard = activeTabIndex === 0 && navFocus === 'card';
  const ttFocused = isMonitorCard && activeWidgetIndex === 0;
  const tasksFocused = isMonitorCard && activeWidgetIndex === 1;

  timetableTable.style.border.fg = ttFocused ? COLOR_ORANGE : COLOR_DARK_GRAY;
  if (timetableTable.rows && timetableTable.rows.style && timetableTable.rows.style.selected) {
    timetableTable.rows.style.selected.bg = ttFocused ? COLOR_ORANGE : COLOR_CHARCOAL;
    timetableTable.rows.style.selected.fg = ttFocused ? 'black' : 'white';
  }

  miniTasksTable.style.border.fg = tasksFocused ? COLOR_ORANGE : COLOR_DARK_GRAY;
  if (miniTasksTable.rows && miniTasksTable.rows.style && miniTasksTable.rows.style.selected) {
    miniTasksTable.rows.style.selected.bg = tasksFocused ? COLOR_ORANGE : COLOR_CHARCOAL;
    miniTasksTable.rows.style.selected.fg = tasksFocused ? 'black' : 'white';
  }
}

function updateFooter() {
  if (activeTabIndex === 3 && navFocus === 'card') {
    footerBox.setContent(
      ' {250-fg}[1-5]{/250-fg} {244-fg}Karty{/244-fg}  {240-fg}│{/240-fg}  {250-fg}[↑/↓]{/250-fg} {244-fg}Pohyb{/244-fg}  {240-fg}│{/240-fg}  {250-fg}[←/→/Tab]{/250-fg} {244-fg}Panel{/244-fg}  {240-fg}│{/240-fg}  {250-fg}[Space]{/250-fg} {244-fg}Filter{/244-fg}  {240-fg}│{/240-fg}  {250-fg}[/]{/250-fg} {244-fg}Hľadať{/244-fg}  {240-fg}│{/240-fg}  {250-fg}[r]{/250-fg} {244-fg}Obnoviť{/244-fg}  {240-fg}│{/240-fg}  {250-fg}[q]{/250-fg} {244-fg}Koniec{/244-fg}'
    );
  } else {
    footerBox.setContent(
      ' {250-fg}[1-5]{/250-fg} {244-fg}Karty{/244-fg}  {240-fg}│{/240-fg}  {250-fg}[Šípky]{/250-fg} {244-fg}Pohyb{/244-fg}  {240-fg}│{/240-fg}  {250-fg}[Enter]{/250-fg} {244-fg}Výber{/244-fg}  {240-fg}│{/240-fg}  {250-fg}[r]{/250-fg} {244-fg}Obnoviť{/244-fg}  {240-fg}│{/240-fg}  {250-fg}[q]{/250-fg} {244-fg}Koniec{/244-fg}'
    );
  }
}

function switchTab(index) {
  if (index < 0) index = TABS.length - 1;
  if (index >= TABS.length) index = 0;

  activeTabIndex = index;
  activeWidgetIndex = 0;
  navFocus = 'topbar';
  if (activeTabIndex === 3) {
    msgSubFocus = 'feed';
  }

  VIEW_CONTAINERS.forEach((c, idx) => {
    if (idx === activeTabIndex) {
      c.show();
    } else {
      c.hide();
    }
  });

  updateHeader();
  updateFooter();
  updateMonitorFocusStyles();

  if (activeTabIndex === 1) {
    renderTimetableCard();
    timetableSidebar.focus();
  } else if (activeTabIndex === 2) {
    renderGradesCard();
    gradesSidebar.focus();
  } else if (activeTabIndex === 3) {
    renderMessagesCard();
    messagesFeedBox.focus();
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

  const statusBadge = isFetching
    ? '{244-fg}[SYNC]{/244-fg}'
    : '{250-fg}[ONLINE]{/250-fg}';

  const isTopFocused = navFocus === 'topbar';
  headerBox.style.border.fg = isTopFocused ? COLOR_ORANGE : COLOR_DARK_GRAY;
  headerBox.setLabel(' [ EDUPAGE MONITOR - ' + school + ' ] ');

  const tabButtons = TAB_LABELS.map((label, idx) => {
    if (idx === activeTabIndex) {
      if (isTopFocused) {
        return `{208-bg}{black-fg}{bold}${label}{/bold}{/black-fg}{/208-bg}`;
      }
      return `{238-bg}{white-fg}{bold}${label}{/bold}{/white-fg}{/238-bg}`;
    }
    return `{244-fg}${label.trim()}{/244-fg}`;
  }).join('   ');

  headerBox.setContent(
    ` {244-fg}POUŽÍVATEĽ:{/244-fg} {white-fg}{bold}${user}{/bold}{/white-fg}  {240-fg}│{/240-fg}  {244-fg}PRIEMER:{/244-fg} {white-fg}{bold}${gpa}{/bold}{/white-fg}  {240-fg}│{/240-fg}  {244-fg}PROSPECH:{/244-fg} {250-fg}${standing}{/250-fg}  {240-fg}│{/240-fg}  {244-fg}ZVONENIE:{/244-fg} {white-fg}${nextBell}{/white-fg}  {240-fg}│{/240-fg}  {244-fg}ČAS:{/244-fg} {250-fg}${timeStr}{/250-fg}  ${statusBadge}\n` +
    ` {244-fg}KARTY:{/244-fg}  ${tabButtons}`
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
  timetableSidebar.style.border.fg = isFocused ? COLOR_ORANGE : COLOR_DARK_GRAY;
  timetableSidebar.setLabel(' [ ROZVRH ] ');

  const weekMap = getWeekDataByVariant(ttVariant);
  const dayKeys = Object.keys(weekMap).sort();
  const { todayIdx, mode, currentLesson, nextLesson, bellPeriod, bellBreak, remMin } = live;

  const lines = [];

  // 1. Live Clock Status Banner (Monochrome)
  lines.push(' {244-fg}AKTUÁLNE{/244-fg}');
  if (mode === 'LESSON' && currentLesson) {
    const roomStr = currentLesson.room && currentLesson.room !== '-' ? currentLesson.room : '-';
    const hdr = ` ● ${currentLesson.period}. HODINA: ${currentLesson.subject_short || currentLesson.subject}`;
    lines.push(` {236-bg}{white-fg}{bold}${padRawLine(hdr, 30)}{/bold}{/white-fg}{/236-bg}`);
    lines.push(` {white-fg}${fitPlain(currentLesson.subject, 30)}{/white-fg}`);
    lines.push(` {250-fg}${currentLesson.time} (${remMin} min) · ${fitPlain(roomStr, 12)}{/250-fg}`);
  } else if (mode === 'BREAK' && nextLesson) {
    const durBreak = bellBreak ? `${bellBreak.duration_min} min` : '';
    const bTitle = bellBreak ? `${bellBreak.after_period}.➔${bellBreak.before_period}.` : 'PRESTÁVKA';
    const hdr = ` ● PRESTÁVKA ${bTitle}${durBreak ? ' (' + durBreak + ')' : ''}`;
    lines.push(` {236-bg}{white-fg}{bold}${padRawLine(hdr, 30)}{/bold}{/white-fg}{/236-bg}`);
    lines.push(` {250-fg}Ďalej: ${fitPlain(nextLesson.subject, 22)}{/250-fg}`);
    lines.push(` {244-fg}O ${nextLesson.start || '-'} (za ${remMin} min){/244-fg}`);
  } else if (bellPeriod) {
    const hdr = ` ● ${bellPeriod.period}. HODINA (${bellPeriod.start}-${bellPeriod.end})`;
    lines.push(` {236-bg}{white-fg}{bold}${padRawLine(hdr, 30)}{/bold}{/white-fg}{/236-bg}`);
    lines.push(' {244-fg}Voľná hodina{/244-fg}');
  } else if (bellBreak) {
    const hdr = ` ● PRESTÁVKA ${bellBreak.between}`;
    lines.push(` {236-bg}{white-fg}{bold}${padRawLine(hdr, 30)}{/bold}{/white-fg}{/236-bg}`);
    lines.push(` {250-fg}${bellBreak.name} (${bellBreak.duration_min} min){/250-fg}`);
  } else if (mode === 'BEFORE' && nextLesson) {
    lines.push(' {white-fg}{bold}● PRED VYUČOVANÍM{/bold}{/white-fg}');
    lines.push(` {244-fg}1. hod o ${nextLesson.start || '-'} (za ${remMin} min){/244-fg}`);
  } else {
    lines.push(' {244-fg}● MIMO VYUČOVANIA{/244-fg}');
  }

  lines.push('{240-fg}────────────────────────────────{/240-fg}');
  lines.push(' {244-fg}ZOBRAZENIE{/244-fg}');

  // 2. Interactive Sidebar Menu Items (Orange ONLY on controlled item)
  SIDEBAR_ITEMS.forEach((item, idx) => {
    const cursorHere = isFocused && sidebarCursor === idx;
    const isDay = typeof item.dayIdx === 'number';
    const isToday = isDay && item.dayIdx === todayIdx;

    if (idx === 6) {
      lines.push('{240-fg}────────────────────────────────{/240-fg}');
      lines.push(' {244-fg}REŽIM ROZVRHU{/244-fg}');
    }
    if (idx === 7) {
      lines.push('{240-fg}────────────────────────────────{/240-fg}');
    }

    let active = false;
    if (item.id === 'WEEK') active = ttSection === 'HODINY' && ttScope === 'WEEK';
    else if (isDay) active = ttSection === 'HODINY' && ttScope === item.dayIdx;
    else if (item.id === 'TYP_TOGGLE') active = ttSection === 'HODINY';
    else if (item.id === 'PRESTAVKY') active = ttSection === 'PRESTAVKY';

    if (item.id === 'TYP_TOGGLE') {
      const modeStr = ttVariant === 'ACTUAL'
        ? ' ◉ Aktuálny   ○ Stály'
        : ' ○ Aktuálny   ◉ Stály';
      if (cursorHere) {
        lines.push(`{208-bg}{black-fg}{bold}${padRawLine(modeStr, 32)}{/bold}{/black-fg}{/208-bg}`);
      } else {
        lines.push(`{white-fg}${padRawLine(modeStr, 32)}{/white-fg}`);
      }
      return;
    }

    let rawText = item.label;
    if (isToday) rawText += ' [DNES]';

    let formattedLine;
    if (isDay) {
      const branch = item.dayIdx === 4 ? '└─' : '├─';
      formattedLine = active ? ` ▸ ${branch} ${rawText}` : `   ${branch} ${rawText}`;
    } else {
      formattedLine = active ? ` ▸ ${rawText}` : `   ${rawText}`;
    }

    if (cursorHere) {
      lines.push(`{208-bg}{black-fg}{bold}${padRawLine(formattedLine, 32)}{/bold}{/black-fg}{/208-bg}`);
    } else if (active) {
      lines.push(`{white-fg}{bold}${padRawLine(formattedLine, 32)}{/bold}{/white-fg}`);
    } else if (isToday) {
      lines.push(`{250-fg}${padRawLine(formattedLine, 32)}{/250-fg}`);
    } else {
      lines.push(`{244-fg}${padRawLine(formattedLine, 32)}{/244-fg}`);
    }
  });

  // 3. Live Compact Bell Timeline (Monochrome)
  lines.push('{240-fg}────────────────────────────────{/240-fg}');
  lines.push(' {244-fg}DNES ZVONENIA{/244-fg}');
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
      lines.push(` {236-bg}{white-fg}{bold}${padRawLine('▸ ' + pLine + ' [TERAZ]', 30)}{/bold}{/white-fg}{/236-bg}`);
    } else {
      const col = les ? '250-fg' : '240-fg';
      lines.push(` {${col}}  ${fitPlain(pLine, 28)}{/${col}}`);
    }

    const br = breaks[idx];
    if (br) {
      const isNowBreak = bellBreak && bellBreak.id === br.id;
      if (isNowBreak) {
        const bText = `▸ PREST. ${br.start}-${br.end} (${br.duration_min}m)`;
        lines.push(` {236-bg}{white-fg}{bold}${padRawLine(bText, 30)}{/bold}{/white-fg}{/236-bg}`);
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
    ? '{white-fg}{bold}AKTUÁLNY ROZVRH{/bold}{/white-fg}'
    : '{250-fg}{bold}STACIONÁRNY ROZVRH{/bold}{/250-fg}';

  const liveNote = bellBreak
    ? `{250-fg}Prestávka ${bellBreak.between} (${bellBreak.start}-${bellBreak.end}){/250-fg}`
    : (bellPeriod
      ? `{white-fg}${bellPeriod.period}. hodina (${bellPeriod.start}-${bellPeriod.end}){/white-fg}`
      : '{244-fg}Mimo vyučovania{/244-fg}');

  const out = [];
  out.push(` ${variantBanner}   {240-fg}│{/240-fg}   ${liveNote}`);

  const hLine = (left, mid, right, fill = '─') => {
    const segs = [fill.repeat(dayColW)];
    for (let i = 0; i < 8; i++) segs.push(fill.repeat(colW));
    return left + segs.join(mid) + right;
  };

  // Header row (Period number + time)
  out.push(`{240-fg}${hLine('┌', '┬', '┐')}{/240-fg}`);
  let hdr1 = '{240-fg}│{/240-fg}' + `{bold}{250-fg}${padVis('DEŇ', dayColW, 'center')}{/250-fg}{/bold}`;
  let hdr2 = '{240-fg}│{/240-fg}' + ' '.repeat(dayColW);

  periods.forEach((p) => {
    const isNowP = bellPeriod && String(bellPeriod.period) === String(p.period);
    const pLabel = compactMode ? `${p.period}. HOD` : `${p.period}. HODINA`;
    const tLabel = compactMode ? `${p.start.replace(/^0/, '')}-${p.end.replace(/^0/, '')}` : `${p.start}-${p.end}`;
    const hdrTag = isNowP ? '{238-bg}{white-fg}{bold}' : '{white-fg}{bold}';
    const timeTag = isNowP ? '{238-bg}{250-fg}' : '{244-fg}';
    hdr1 += '{240-fg}│{/240-fg}' + `${hdrTag}${padVis(pLabel, colW, 'center')}{/}`;
    hdr2 += '{240-fg}│{/240-fg}' + `${timeTag}${padVis(tLabel, colW, 'center')}{/}`;
  });
  hdr1 += '{240-fg}│{/240-fg}';
  hdr2 += '{240-fg}│{/240-fg}';
  out.push(hdr1);
  out.push(hdr2);
  out.push(`{240-fg}${hLine('├', '┼', '┤')}{/240-fg}`);

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

    // Day column (Monochrome)
    const dayTagStart = isToday ? '{238-bg}{white-fg}{bold}' : '{250-fg}{bold}';
    rowLines[0] = `{240-fg}│{/240-fg}${dayTagStart}${padVis(dayName.toUpperCase(), dayColW, 'center')}{/}`;
    rowLines[1] = `{240-fg}│{/240-fg}${isToday ? '{white-fg}{bold}' : '{244-fg}'}${padVis(isToday ? '[DNES]' : dateShort, dayColW, 'center')}{/}`;
    if (lineCount >= 3) rowLines[2] = `{240-fg}│{/240-fg}${isToday && dateShort ? '{244-fg}' + padVis(dateShort, dayColW, 'center') + '{/}' : ' '.repeat(dayColW)}`;
    if (lineCount >= 4) rowLines[3] = `{240-fg}│{/240-fg}${' '.repeat(dayColW)}`;

    // 8 Period cells
    for (let pNum = 1; pNum <= 8; pNum++) {
      const les = lessons.find((l) => String(l.period) === String(pNum));
      const pDef = periods[pNum - 1];
      const isNowCell = isToday && bellPeriod && String(bellPeriod.period) === String(pNum);
      const isNextAfterBreak = isToday && bellBreak && String(bellBreak.before_period) === String(pNum);

      const sep = '{240-fg}│{/240-fg}';

      if (!les) {
        rowLines[0] += sep + (isNowCell ? `{236-bg}{white-fg}${padVis('VOĽNO', colW, 'center')}{/}` : ' '.repeat(colW));
        rowLines[1] += sep + `{240-fg}${padVis('·', colW, 'center')}{/240-fg}`;
        if (lineCount >= 3) rowLines[2] += sep + ' '.repeat(colW);
        if (lineCount >= 4) rowLines[3] += sep + ' '.repeat(colW);
        continue;
      }

      // Line 1: Skratka + Status Tag
      let sTitle = les.subject_short || fitPlain(les.subject, 5).toUpperCase();
      let titleTagStart = '{white-fg}{bold}';
      let titleTagEnd = '{/bold}{/white-fg}';
      if (isNowCell && !les.is_cancelled) {
        sTitle = `▸ ${sTitle} ◂`;
        titleTagStart = '{238-bg}{white-fg}{bold}';
        titleTagEnd = '{/bold}{/white-fg}{/238-bg}';
      } else if (les.is_cancelled) {
        sTitle = `${sTitle} [ODP]`;
        titleTagStart = '{240-fg}';
        titleTagEnd = '{/240-fg}';
      } else if (les.is_changed) {
        sTitle = `${sTitle} [ZMN]`;
        titleTagStart = '{250-fg}{bold}';
        titleTagEnd = '{/bold}{/250-fg}';
      } else if (les.is_event) {
        sTitle = `${sTitle} [UDL]`;
        titleTagStart = '{250-fg}{bold}';
        titleTagEnd = '{/bold}{/250-fg}';
      } else if (isNextAfterBreak && mode === 'BREAK') {
        sTitle = `> ${sTitle}`;
        titleTagStart = '{white-fg}{bold}';
        titleTagEnd = '{/bold}{/white-fg}';
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

      const timeCol = les.is_cancelled ? '{240-fg}' : '{244-fg}';
      const clsCol = les.is_cancelled ? '{240-fg}' : '{250-fg}';
      const tcCol = les.is_cancelled ? '{240-fg}' : '{244-fg}';

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

    rowLines.forEach((ln) => out.push(ln + '{240-fg}│{/240-fg}'));
    out.push(`{240-fg}${dIdx < 4 ? hLine('├', '┼', '┤') : hLine('└', '┴', '┘')}{/240-fg}`);
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
    ? '{white-fg}AKTUÁLNY{/white-fg}'
    : '{250-fg}STACIONÁRNY{/250-fg}';

  const lines = [];
  lines.push(` {bold}{white-fg}${dayName.toUpperCase()} ${dateStr}{/white-fg}${isToday ? ' {238-bg}{white-fg} DNES {/}' : ''}{/bold}   {240-fg}│{/240-fg}   {244-fg}Režim:{/244-fg} ${variantBanner}`);
  lines.push(`{240-fg}${borderLine('┌', '┬', '┐')}{/240-fg}`);
  lines.push(
    '{240-fg}│{/240-fg}' +
    `{bold}{250-fg}${padVis('HOD', wH, 'center')}{/bold}{/250-fg}{240-fg}│{/240-fg}` +
    `{bold}{250-fg}${padVis('ČAS', wTime, 'center')}{/bold}{/250-fg}{240-fg}│{/240-fg}` +
    `{bold}{250-fg}${padVis('SKR.', wShort, 'center')}{/bold}{/250-fg}{240-fg}│{/240-fg}` +
    `{bold}{250-fg}${padVis('PREDMET', wSubj)}{/bold}{/250-fg}{240-fg}│{/240-fg}` +
    `{bold}{250-fg}${padVis('TRIEDA', wCls)}{/bold}{/250-fg}{240-fg}│{/240-fg}` +
    `{bold}{250-fg}${padVis('UČEBŇA', wRoom)}{/bold}{/250-fg}{240-fg}│{/240-fg}` +
    `{bold}{250-fg}${padVis('UČITEĽ', wTeach)}{/bold}{/250-fg}{240-fg}│{/240-fg}` +
    `{bold}{250-fg}${padVis('STAV', wStat, 'center')}{/bold}{/250-fg}{240-fg}│{/240-fg}`
  );
  lines.push(`{240-fg}${borderLine('├', '┼', '┤')}{/240-fg}`);

  periods.forEach((p, idx) => {
    const les = lessons.find((l) => String(l.period) === String(p.period));
    const isNow = isToday && live.bellPeriod && String(live.bellPeriod.period) === String(p.period);

    if (!les) {
      const rowColor = isNow ? '{white-fg}{bold}' : '{240-fg}';
      lines.push(
        '{240-fg}│{/240-fg}' +
        `${rowColor}${padVis(p.period + '.', wH, 'center')}{/}{240-fg}│{/240-fg}` +
        `${rowColor}${padVis(`${p.start}-${p.end}`, wTime, 'center')}{/}{240-fg}│{/240-fg}` +
        `${rowColor}${padVis('-', wShort, 'center')}{/}{240-fg}│{/240-fg}` +
        `${rowColor}${padVis('Voľná hodina', wSubj)}{/}{240-fg}│{/240-fg}` +
        `${rowColor}${padVis('-', wCls)}{/}{240-fg}│{/240-fg}` +
        `${rowColor}${padVis('-', wRoom)}{/}{240-fg}│{/240-fg}` +
        `${rowColor}${padVis('-', wTeach)}{/}{240-fg}│{/240-fg}` +
        `${rowColor}${padVis(isNow ? 'TERAZ VOĽNO' : 'VOĽNO', wStat, 'center')}{/}{240-fg}│{/240-fg}`
      );
    } else {
      const clsGrp = les.group ? `${les.class_name} (${les.group})` : (les.class_name || '-');
      let stText = les.status || 'PLÁN';
      let fgCol = 'white-fg';
      if (isNow && !les.is_cancelled) {
        stText = `TERAZ (${live.pct}%)`;
        fgCol = 'white-fg';
      } else if (les.is_cancelled) {
        stText = 'ODPADLA';
        fgCol = '240-fg';
      } else if (les.is_changed) {
        stText = 'ZMENA';
        fgCol = '250-fg';
      } else if (les.is_event) {
        stText = 'UDALOSŤ';
        fgCol = '250-fg';
      }

      const rowPrefix = isNow && !les.is_cancelled ? '{238-bg}{white-fg}{bold}' : `{${fgCol}}`;
      const rowEnd = '{/}';
      lines.push(
        '{240-fg}│{/240-fg}' +
        `${rowPrefix}${padVis(p.period + '.', wH, 'center')}${rowEnd}{240-fg}│{/240-fg}` +
        `${rowPrefix}${padVis(les.time || `${p.start}-${p.end}`, wTime, 'center')}${rowEnd}{240-fg}│{/240-fg}` +
        `${rowPrefix}${padVis(les.subject_short || '-', wShort, 'center')}${rowEnd}{240-fg}│{/240-fg}` +
        `${rowPrefix}${padVis(les.subject || '-', wSubj)}${rowEnd}{240-fg}│{/240-fg}` +
        `${rowPrefix}${padVis(clsGrp, wCls)}${rowEnd}{240-fg}│{/240-fg}` +
        `${rowPrefix}${padVis(les.room || '-', wRoom)}${rowEnd}{240-fg}│{/240-fg}` +
        `${rowPrefix}${padVis(les.teacher || '-', wTeach)}${rowEnd}{240-fg}│{/240-fg}` +
        `${rowPrefix}${padVis(stText, wStat, 'center')}${rowEnd}{240-fg}│{/240-fg}`
      );
    }

    const br = breaks[idx];
    if (br) {
      const isNowBreak = isToday && live.bellBreak && live.bellBreak.id === br.id;
      const brSummary = `   · Prestávka ${br.between}: ${br.start} - ${br.end} (${br.duration_min} min · ${br.name}) ${isNowBreak ? '◀ PREBIEHA' : ''}`;
      const brTag = isNowBreak ? '{238-bg}{white-fg}{bold}' : '{244-fg}';
      lines.push(`{240-fg}│{/240-fg}${brTag}${padVis(brSummary, innerW)}{/}{240-fg}│{/240-fg}`);
    }
  });

  lines.push(`{240-fg}${borderLine('└', '┴', '┘')}{/240-fg}`);

  timetableMainBox.setLabel(` [ ROZVRH: ${dayName.toUpperCase()} ] `);
  timetableMainBox.setContent(lines.join('\n'));
}

function renderBreaksView(live) {
  const breaks = getBreaksSchedule();
  const boxWidth = timetableMainBox.width && timetableMainBox.width > 40 ? timetableMainBox.width : Math.max(80, screen.width - SIDEBAR_WIDTH);
  const innerW = Math.max(76, boxWidth - 4);

  const wId = 6;
  const wBetw = 22;
  const wTime = 18;
  const wDur = 12;
  const wType = Math.max(20, innerW - (wId + wBetw + wTime + wDur + 6));

  const hLine = (l, m, r) => l + [
    '─'.repeat(wId), '─'.repeat(wBetw), '─'.repeat(wTime),
    '─'.repeat(wDur), '─'.repeat(wType),
  ].join(m) + r;

  const lines = [];
  lines.push(`{240-fg}${hLine('┌', '┬', '┐')}{/240-fg}`);
  lines.push(
    '{240-fg}│{/240-fg}' +
    `{bold}{250-fg}${padVis('#', wId, 'center')}{/bold}{/250-fg}{240-fg}│{/240-fg}` +
    `{bold}{250-fg}${padVis('MEDZI HODINAMI', wBetw, 'center')}{/bold}{/250-fg}{240-fg}│{/240-fg}` +
    `{bold}{250-fg}${padVis('ČAS', wTime, 'center')}{/bold}{/250-fg}{240-fg}│{/240-fg}` +
    `{bold}{250-fg}${padVis('TRVANIE', wDur, 'center')}{/bold}{/250-fg}{240-fg}│{/240-fg}` +
    `{bold}{250-fg}${padVis('NÁZOV', wType)}{/bold}{/250-fg}{240-fg}│{/240-fg}`
  );
  lines.push(`{240-fg}${hLine('├', '┼', '┤')}{/240-fg}`);

  breaks.forEach((b, i) => {
    const isNowBreak = live.bellBreak && live.bellBreak.id === b.id;
    const wrapStart = isNowBreak ? '{238-bg}{white-fg}{bold}' : '{white-fg}';
    const mutedStart = isNowBreak ? '{238-bg}{white-fg}{bold}' : '{250-fg}';
    const wrapEnd = '{/}';
    const typeLabel = isNowBreak ? `${b.name}  [PRÁVE PREBIEHA]` : b.name;

    lines.push(
      '{240-fg}│{/240-fg}' +
      `${mutedStart}${padVis(`${i + 1}.`, wId, 'center')}${wrapEnd}{240-fg}│{/240-fg}` +
      `${wrapStart}${padVis(b.between, wBetw, 'center')}${wrapEnd}{240-fg}│{/240-fg}` +
      `${mutedStart}${padVis(`${b.start} - ${b.end}`, wTime, 'center')}${wrapEnd}{240-fg}│{/240-fg}` +
      `${wrapStart}{bold}${padVis(`${b.duration_min} min`, wDur, 'center')}{/bold}${wrapEnd}{240-fg}│{/240-fg}` +
      `${mutedStart}${padVis(typeLabel, wType)}${wrapEnd}{240-fg}│{/240-fg}`
    );
  });

  lines.push(`{240-fg}${hLine('└', '┴', '┘')}{/240-fg}`);

  timetableMainBox.setLabel(' [ PRESTÁVKY ] ');
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
    if (n <= 2.0) return 'white-fg';
    if (n <= 3.5) return '250-fg';
    return '244-fg';
  }
  return 'white-fg';
}

function getGradesSidebarItems() {
  const subjs = dashboardData.subjects || [];
  const comms = dashboardData.commendations || [];
  const items = [
    { id: 'OVERVIEW', type: 'OVERVIEW', label: 'PREHĽAD' },
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
  gradesSidebar.style.border.fg = isFocused ? COLOR_ORANGE : COLOR_DARK_GRAY;
  gradesSidebar.setLabel(' [ ZNÁMKY ] ');

  const items = getGradesSidebarItems();
  if (gradesCursor >= items.length) gradesCursor = Math.max(0, items.length - 1);

  const gpa = dashboardData.gpa || '-';
  const standing = dashboardData.standing || '-';
  const totalMarks = dashboardData.total_marks || 0;
  const subjCount = (dashboardData.subjects || []).length;

  const lines = [];
  lines.push(' {244-fg}SÚHRN{/244-fg}');
  lines.push(` {236-bg}{white-fg}{bold}${padRawLine(` ● PRIEMER: ${gpa}`, 30)}{/bold}{/white-fg}{/236-bg}`);
  lines.push(` {250-fg}${fitPlain(standing, 30)}{/250-fg}`);
  lines.push(` {244-fg}Známok: ${totalMarks}  ·  Predmetov: ${subjCount}{/244-fg}`);
  lines.push('{240-fg}────────────────────────────────{/240-fg}');
  lines.push(' {244-fg}ZOBRAZENIE{/244-fg}');

  // Render fixed top 2 items (OVERVIEW and COMMENDATIONS)
  for (let idx = 0; idx < Math.min(2, items.length); idx++) {
    const it = items[idx];
    const cursorHere = isFocused && gradesCursor === idx;
    const active = gradesCursor === idx;
    const text = `${active ? ' ▸ ' : '   '}${it.label}`;
    if (cursorHere) {
      lines.push(`{208-bg}{black-fg}{bold}${padRawLine(text, 32)}{/bold}{/black-fg}{/208-bg}`);
    } else if (active) {
      lines.push(`{white-fg}{bold}${padRawLine(text, 32)}{/bold}{/white-fg}`);
    } else {
      lines.push(`{244-fg}${padRawLine(text, 32)}{/244-fg}`);
    }
  }

  lines.push('{240-fg}────────────────────────────────{/240-fg}');
  lines.push(` {244-fg}PREDMETY (${subjCount}){/244-fg}`);

  const subjItems = items.slice(2);
  const boxH = gradesSidebar.height || 37;
  const availRows = Math.max(6, boxH - 13);

  let startIdx = 0;
  const activeSubjOffset = Math.max(0, gradesCursor - 2);
  if (subjItems.length > availRows) {
    startIdx = Math.max(0, Math.min(subjItems.length - availRows, activeSubjOffset - Math.floor(availRows / 2)));
  }
  const endIdx = Math.min(subjItems.length, startIdx + availRows);

  if (startIdx > 0) {
    lines.push(` {240-fg}  ▲ (${startIdx}){/240-fg}`);
  }

  for (let sIdx = startIdx; sIdx < endIdx; sIdx++) {
    const globalIdx = sIdx + 2;
    const it = subjItems[sIdx];
    const cursorHere = isFocused && gradesCursor === globalIdx;
    const active = gradesCursor === globalIdx;
    const s = it.subject;
    const branch = sIdx === subjItems.length - 1 ? '└─' : '├─';
    const rawLine = `${active ? '▸' : ' '} ${branch} ${it.label}`;

    if (cursorHere) {
      lines.push(`{208-bg}{black-fg}{bold}${padRawLine(' ' + rawLine, 32)}{/bold}{/black-fg}{/208-bg}`);
    } else if (active) {
      lines.push(`{white-fg}{bold}${padRawLine(' ' + rawLine, 32)}{/bold}{/white-fg}`);
    } else {
      lines.push(`{240-fg}   ${branch}{/240-fg} {white-fg}${(s.short || s.name || '-').padEnd(4, ' ')}{/white-fg} {244-fg}${fitPlain(s.full_name || s.name, 13).padEnd(13, ' ')}{/244-fg} {250-fg}[${(s.avg || '-').padStart(4, ' ')}]{/250-fg}`);
    }
  }

  if (endIdx < subjItems.length) {
    lines.push(` {240-fg}  ▼ (${subjItems.length - endIdx}){/240-fg}`);
  }

  gradesSidebar.setContent(lines.join('\n'));
}

function renderGradesOverview() {
  const boxWidth = gradesMainBox.width && gradesMainBox.width > 40 ? gradesMainBox.width : Math.max(80, screen.width - SIDEBAR_WIDTH);
  const innerW = Math.max(82, boxWidth - 4);

  const subjs = dashboardData.subjects || [];
  const distData = (dashboardData.distribution && dashboardData.distribution.data) || [0, 0, 0, 0, 0];
  const distLabels = ['Výborný', 'Chválitebný', 'Dobrý', 'Dostatočný', 'Nedostatočný'];
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
    chartRows.push(`{244-fg}${labelStr}{/244-fg}{white-fg}${padRawLine(rowChars, leftW - 6)}{/white-fg}`);
  });

  let xAxisBody = '';
  for (let i = 0; i < plotCount; i++) {
    xAxisBody += padVis(tx[i] || '', colStep, 'center');
  }
  chartRows.push(`{244-fg}${padRawLine('     └' + xAxisBody, leftW)}{/244-fg}`);

  // Build 6 lines for Right Grade Distribution
  const distRows = [];
  const barMaxW = Math.max(8, rightW - 31);
  for (let i = 0; i < 5; i++) {
    const cnt = distData[i] || 0;
    const pct = totalClassified > 0 ? ((cnt / totalClassified) * 100).toFixed(1) : '0.0';
    const bLen = Math.round((cnt / maxDist) * barMaxW);
    const bar = (bLen > 0 ? '█'.repeat(bLen) : '·').padEnd(barMaxW, ' ');
    const linePlain = ` ${i + 1} ${distLabels[i].padEnd(12, ' ')} `;
    const rightStats = ` ${String(cnt).padStart(2, ' ')}x (${pct.padStart(5, ' ')}%)`;
    const padRem = Math.max(0, rightW - (linePlain.length + bar.length + rightStats.length));
    distRows.push(
      `{250-fg}${linePlain}{/250-fg}{white-fg}${bar}{/white-fg}{244-fg}${rightStats}{/244-fg}${' '.repeat(padRem)}`
    );
  }
  const passCount = distData[0] + distData[1] + distData[2] + distData[3];
  const passRate = totalClassified > 0 ? ((passCount / totalClassified) * 100).toFixed(1) : '0.0';
  const summaryTxt = ` Spolu: ${totalClassified}   │   Priemer: ${dashboardData.gpa || '-'}   │   Úspešnosť: ${passRate}%`;
  distRows.push(`{250-fg}${padRawLine(summaryTxt, rightW)}{/250-fg}`);

  const out = [];
  out.push(`{240-fg}${topLine}{/240-fg}`);
  out.push(
    `{240-fg}│{/240-fg}{bold}{white-fg}${padRawLine(' VÝVOJ PRIEMERU', leftW)}{/white-fg}{/bold}` +
    `{240-fg}│{/240-fg}{bold}{white-fg}${padRawLine(' DISTRIBÚCIA ZNÁMOK (1 - 5)', rightW)}{/white-fg}{/bold}{240-fg}│{/240-fg}`
  );
  out.push(`{240-fg}${midLine}{/240-fg}`);
  for (let r = 0; r < 6; r++) {
    out.push(`{240-fg}│{/240-fg}${chartRows[r]}{240-fg}│{/240-fg}${distRows[r]}{240-fg}│{/240-fg}`);
  }
  out.push(`{240-fg}${botLine}{/240-fg}`);

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

  out.push(`{240-fg}${tLine('┌', '┬', '┐')}{/240-fg}`);
  out.push(
    '{240-fg}│{/240-fg}' +
    `{bold}{250-fg}${padVis('SKR.', wShort, 'center')}{/bold}{/250-fg}{240-fg}│{/240-fg}` +
    `{bold}{250-fg}${padVis('PREDMET', wSubj)}{/bold}{/250-fg}{240-fg}│{/240-fg}` +
    `{bold}{250-fg}${padVis('ZNÁMKY', wMarks)}{/bold}{/250-fg}{240-fg}│{/240-fg}` +
    `{bold}{250-fg}${padVis('POČ.', wCnt, 'center')}{/bold}{/250-fg}{240-fg}│{/240-fg}` +
    `{bold}{250-fg}${padVis('%', wPct, 'center')}{/bold}{/250-fg}{240-fg}│{/240-fg}` +
    `{bold}{250-fg}${padVis('PRIEMER', wAvg, 'center')}{/bold}{/250-fg}{240-fg}│{/240-fg}` +
    `{bold}{250-fg}${padVis('VYS.', wFin, 'center')}{/bold}{/250-fg}{240-fg}│{/240-fg}` +
    `{bold}{250-fg}${padVis('HODNOTENIE', wVerb, 'center')}{/bold}{/250-fg}{240-fg}│{/240-fg}`
  );
  out.push(`{240-fg}${tLine('├', '┼', '┤')}{/240-fg}`);

  subjs.forEach((s) => {
    const marksStr = (s.marks_preview && s.marks_preview.length > 0)
      ? s.marks_preview.join(', ')
      : '-';
    out.push(
      '{240-fg}│{/240-fg}' +
      `{bold}{white-fg}${padVis(s.short || s.name, wShort, 'center')}{/white-fg}{/bold}{240-fg}│{/240-fg}` +
      `{250-fg}${padVis(s.full_name || s.name, wSubj)}{/250-fg}{240-fg}│{/240-fg}` +
      `{white-fg}${padVis(marksStr, wMarks)}{/white-fg}{240-fg}│{/240-fg}` +
      `{244-fg}${padVis(String(s.count || 0), wCnt, 'center')}{/244-fg}{240-fg}│{/240-fg}` +
      `{244-fg}${padVis(s.percent || '-', wPct, 'center')}{/244-fg}{240-fg}│{/240-fg}` +
      `{bold}{white-fg}${padVis(s.avg || '-', wAvg, 'center')}{/white-fg}{/bold}{240-fg}│{/240-fg}` +
      `{bold}{white-fg}${padVis(s.final_grade || '-', wFin, 'center')}{/white-fg}{/bold}{240-fg}│{/240-fg}` +
      `{250-fg}${padVis(s.verbal || '-', wVerb, 'center')}{/250-fg}{240-fg}│{/240-fg}`
    );
  });

  out.push(`{240-fg}${tLine('└', '┴', '┘')}{/240-fg}`);

  gradesMainBox.setLabel(' [ PREHĽAD ZNÁMOK ] ');
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
    ` {bold}{white-fg}POCHVALY A POZNÁMKY{/white-fg}{/bold}   {240-fg}│{/240-fg}   ` +
    `{250-fg}Pochvaly: ${pochvalyCnt}   ·   Poznámky: ${poznamkyCnt}{/250-fg}`
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

  out.push(`{240-fg}${cLine('┌', '┬', '┐')}{/240-fg}`);
  out.push(
    '{240-fg}│{/240-fg}' +
    `{bold}{250-fg}${padVis('#', wNum, 'center')}{/bold}{/250-fg}{240-fg}│{/240-fg}` +
    `{bold}{250-fg}${padVis('DÁTUM', wDate, 'center')}{/bold}{/250-fg}{240-fg}│{/240-fg}` +
    `{bold}{250-fg}${padVis('DRUH', wCat, 'center')}{/bold}{/250-fg}{240-fg}│{/240-fg}` +
    `{bold}{250-fg}${padVis('PREDMET', wSubj)}{/bold}{/250-fg}{240-fg}│{/240-fg}` +
    `{bold}{250-fg}${padVis('UČITEĽ', wTeach)}{/bold}{/250-fg}{240-fg}│{/240-fg}` +
    `{bold}{250-fg}${padVis('STAV', wState, 'center')}{/bold}{/250-fg}{240-fg}│{/240-fg}` +
    `{bold}{250-fg}${padVis('TEXT', wText)}{/bold}{/250-fg}{240-fg}│{/240-fg}`
  );
  out.push(`{240-fg}${cLine('├', '┼', '┤')}{/240-fg}`);

  if (comms.length === 0) {
    out.push(
      '{240-fg}│{/240-fg}' +
      `{244-fg}${padVis('-', wNum, 'center')}{/244-fg}{240-fg}│{/240-fg}` +
      `{244-fg}${padVis('-', wDate, 'center')}{/244-fg}{240-fg}│{/240-fg}` +
      `{244-fg}${padVis('-', wCat, 'center')}{/244-fg}{240-fg}│{/240-fg}` +
      `{244-fg}${padVis('Správanie', wSubj)}{/244-fg}{240-fg}│{/240-fg}` +
      `{244-fg}${padVis('-', wTeach)}{/244-fg}{240-fg}│{/240-fg}` +
      `{244-fg}${padVis('-', wState, 'center')}{/244-fg}{240-fg}│{/240-fg}` +
      `{244-fg}${padVis('Žiadne záznamy.', wText)}{/244-fg}{240-fg}│{/240-fg}`
    );
  } else {
    comms.forEach((c, idx) => {
      out.push(
        '{240-fg}│{/240-fg}' +
        `{244-fg}${padVis(`${idx + 1}.`, wNum, 'center')}{/244-fg}{240-fg}│{/240-fg}` +
        `{250-fg}${padVis(c.date || '-', wDate, 'center')}{/250-fg}{240-fg}│{/240-fg}` +
        `{bold}{white-fg}${padVis(c.category || 'ZÁZNAM', wCat, 'center')}{/white-fg}{/bold}{240-fg}│{/240-fg}` +
        `{250-fg}${padVis(c.subject || 'Správanie', wSubj)}{/250-fg}{240-fg}│{/240-fg}` +
        `{250-fg}${padVis(c.teacher || '-', wTeach)}{/250-fg}{240-fg}│{/240-fg}` +
        `{244-fg}${padVis(c.state || '-', wState, 'center')}{/244-fg}{240-fg}│{/240-fg}` +
        `{white-fg}${padVis(c.text || '-', wText)}{/white-fg}{240-fg}│{/240-fg}`
      );
    });
  }
  out.push(`{240-fg}${cLine('└', '┴', '┘')}{/240-fg}`);
  out.push('');

  // Second Table: Recent Grades Overview with Teachers & Details
  out.push(' {bold}{white-fg}KOMENTÁRE K ZNÁMKAM{/white-fg}{/bold}');
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

  out.push(`{240-fg}${gLine('┌', '┬', '┐')}{/240-fg}`);
  out.push(
    '{240-fg}│{/240-fg}' +
    `{bold}{250-fg}${padVis('DÁTUM', gwDate, 'center')}{/bold}{/250-fg}{240-fg}│{/240-fg}` +
    `{bold}{250-fg}${padVis('PREDM.', gwSubj, 'center')}{/bold}{/250-fg}{240-fg}│{/240-fg}` +
    `{bold}{250-fg}${padVis('ZNÁMKA', gwGrd, 'center')}{/bold}{/250-fg}{240-fg}│{/240-fg}` +
    `{bold}{250-fg}${padVis('VÁHA', gwWgt, 'center')}{/bold}{/250-fg}{240-fg}│{/240-fg}` +
    `{bold}{250-fg}${padVis('UDALOSŤ', gwTitle)}{/bold}{/250-fg}{240-fg}│{/240-fg}` +
    `{bold}{250-fg}${padVis('VYUČUJÚCI / POZNÁMKA', gwNote)}{/bold}{/250-fg}{240-fg}│{/240-fg}`
  );
  out.push(`{240-fg}${gLine('├', '┼', '┤')}{/240-fg}`);

  listToRender.forEach((g) => {
    const noteOrTeacher = g.note
      ? `${g.teacher && g.teacher !== '-' ? g.teacher + ' · ' : ''}${g.note}`
      : (g.teacher && g.teacher !== '-' ? g.teacher : (g.comment || '-'));
    out.push(
      '{240-fg}│{/240-fg}' +
      `{244-fg}${padVis(g.date || '-', gwDate, 'center')}{/244-fg}{240-fg}│{/240-fg}` +
      `{bold}{white-fg}${padVis(g.subject || '-', gwSubj, 'center')}{/white-fg}{/bold}{240-fg}│{/240-fg}` +
      `{bold}{white-fg}${padVis(g.grade || '-', gwGrd, 'center')}{/white-fg}{/bold}{240-fg}│{/240-fg}` +
      `{244-fg}${padVis(g.weight || '1', gwWgt, 'center')}{/244-fg}{240-fg}│{/240-fg}` +
      `{250-fg}${padVis(g.title || '-', gwTitle)}{/250-fg}{240-fg}│{/240-fg}` +
      `{244-fg}${padVis(noteOrTeacher, gwNote)}{/244-fg}{240-fg}│{/240-fg}`
    );
  });
  out.push(`{240-fg}${gLine('└', '┴', '┘')}{/240-fg}`);

  gradesMainBox.setLabel(' [ POCHVALY A POZNÁMKY ] ');
  gradesMainBox.setContent(out.join('\n'));
}

function renderSubjectDetailView(subj) {
  const boxWidth = gradesMainBox.width && gradesMainBox.width > 40 ? gradesMainBox.width : Math.max(80, screen.width - SIDEBAR_WIDTH);
  const innerW = Math.max(82, boxWidth - 4);

  const sDist = subj.distribution || [0, 0, 0, 0, 0];
  const gRows = subj.grades || [];

  const out = [];

  // 1. Top Framed Subject Card
  out.push(`{240-fg}┌${'─'.repeat(innerW)}┐{/240-fg}`);
  const titleLine = ` ${(subj.short || subj.name || '-')} — ${subj.full_name || subj.name || '-'}   │   VYUČUJÚCI: ${subj.teacher || '-'}`;
  out.push(`{240-fg}│{/240-fg}{236-bg}{white-fg}{bold}${padRawLine(titleLine, innerW)}{/bold}{/white-fg}{/236-bg}{240-fg}│{/240-fg}`);
  out.push(`{240-fg}├${'─'.repeat(innerW)}┤{/240-fg}`);

  const statsLine = ` PRIEMER: ${subj.avg || '-'}   │   PERCENTÁ: ${subj.percent || '-'}   │   VYSVEDČENIE: ${subj.final_grade || '-'} (${subj.verbal || '-'})   │   POČET ZNÁMOK: ${subj.count || 0}`;
  out.push(`{240-fg}│{/240-fg}{white-fg}${padRawLine(statsLine, innerW)}{/white-fg}{240-fg}│{/240-fg}`);

  const distSummary = ` DISTRIBÚCIA:  [1]: ${sDist[0]}x   ·   [2]: ${sDist[1]}x   ·   [3]: ${sDist[2]}x   ·   [4]: ${sDist[3]}x   ·   [5]: ${sDist[4]}x`;
  out.push(`{240-fg}│{/240-fg}{244-fg}${padRawLine(distSummary, innerW)}{/244-fg}{240-fg}│{/240-fg}`);
  out.push(`{240-fg}└${'─'.repeat(innerW)}┘{/240-fg}`);
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

  out.push(`{240-fg}${sLine('┌', '┬', '┐')}{/240-fg}`);
  out.push(
    '{240-fg}│{/240-fg}' +
    `{bold}{250-fg}${padVis('#', wIdx, 'center')}{/bold}{/250-fg}{240-fg}│{/240-fg}` +
    `{bold}{250-fg}${padVis('DÁTUM', wDate, 'center')}{/bold}{/250-fg}{240-fg}│{/240-fg}` +
    `{bold}{250-fg}${padVis('HODNOTENIE', wGrd, 'center')}{/bold}{/250-fg}{240-fg}│{/240-fg}` +
    `{bold}{250-fg}${padVis('ZNÁMKA', wNum, 'center')}{/bold}{/250-fg}{240-fg}│{/240-fg}` +
    `{bold}{250-fg}${padVis('BODY / %', wPts, 'center')}{/bold}{/250-fg}{240-fg}│{/240-fg}` +
    `{bold}{250-fg}${padVis('VÁHA', wWgt, 'center')}{/bold}{/250-fg}{240-fg}│{/240-fg}` +
    `{bold}{250-fg}${padVis('PRIEM.TR.', wCavg, 'center')}{/bold}{/250-fg}{240-fg}│{/240-fg}` +
    `{bold}{250-fg}${padVis('UDALOSŤ / TÉMA', wTitle)}{/bold}{/250-fg}{240-fg}│{/240-fg}` +
    `{bold}{250-fg}${padVis('UČITEĽ', wTeach)}{/bold}{/250-fg}{240-fg}│{/240-fg}`
  );
  out.push(`{240-fg}${sLine('├', '┼', '┤')}{/240-fg}`);

  if (gRows.length === 0) {
    out.push(
      '{240-fg}│{/240-fg}' +
      `{244-fg}${padVis('-', wIdx, 'center')}{/244-fg}{240-fg}│{/240-fg}` +
      `{244-fg}${padVis('-', wDate, 'center')}{/244-fg}{240-fg}│{/240-fg}` +
      `{244-fg}${padVis('-', wGrd, 'center')}{/244-fg}{240-fg}│{/240-fg}` +
      `{244-fg}${padVis('-', wNum, 'center')}{/244-fg}{240-fg}│{/240-fg}` +
      `{244-fg}${padVis('-', wPts, 'center')}{/244-fg}{240-fg}│{/240-fg}` +
      `{244-fg}${padVis('-', wWgt, 'center')}{/244-fg}{240-fg}│{/240-fg}` +
      `{244-fg}${padVis('-', wCavg, 'center')}{/244-fg}{240-fg}│{/240-fg}` +
      `{244-fg}${padVis('Žiadne známky.', wTitle)}{/244-fg}{240-fg}│{/240-fg}` +
      `{244-fg}${padVis('-', wTeach)}{/244-fg}{240-fg}│{/240-fg}`
    );
  } else {
    gRows.forEach((g, idx) => {
      out.push(
        '{240-fg}│{/240-fg}' +
        `{244-fg}${padVis(`${idx + 1}.`, wIdx, 'center')}{/244-fg}{240-fg}│{/240-fg}` +
        `{250-fg}${padVis(g.date || '-', wDate, 'center')}{/250-fg}{240-fg}│{/240-fg}` +
        `{bold}{white-fg}${padVis(g.grade || '-', wGrd, 'center')}{/white-fg}{/bold}{240-fg}│{/240-fg}` +
        `{white-fg}${padVis(g.numeric_val || '-', wNum, 'center')}{/white-fg}{240-fg}│{/240-fg}` +
        `{250-fg}${padVis(g.points_str || '-', wPts, 'center')}{/250-fg}{240-fg}│{/240-fg}` +
        `{244-fg}${padVis(g.weight || '1', wWgt, 'center')}{/244-fg}{240-fg}│{/240-fg}` +
        `{244-fg}${padVis(g.class_avg || '-', wCavg, 'center')}{/244-fg}{240-fg}│{/240-fg}` +
        `{white-fg}${padVis(g.title || '-', wTitle)}{/white-fg}{240-fg}│{/240-fg}` +
        `{250-fg}${padVis(g.teacher || '-', wTeach)}{/250-fg}{240-fg}│{/240-fg}`
      );
    });
  }

  out.push(`{240-fg}${sLine('└', '┴', '┘')}{/240-fg}`);

  gradesMainBox.setLabel(` [ ${(subj.short || subj.name || '').toUpperCase()} — ${(subj.full_name || subj.name || '').toUpperCase()} ] `);
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

// ==============================================================================
// TAB 4 (SPRÁVY): Left Checkbox Filters, Top Search Bar & Scrollable Day-Divided Feed
// ==============================================================================

const MESSAGE_CATEGORIES = [
  { key: 'SPRAVY', label: 'Správy a oznamy' },
  { key: 'ZNAMKY', label: 'Známky a pochvaly' },
  { key: 'SUPLOVANIE', label: 'Suplovanie a rozvrh' },
  { key: 'ULOHY', label: 'Úlohy a písomky' },
  { key: 'DOCHADZKA', label: 'Dochádzka a príchod' },
  { key: 'OSTATNE', label: 'Jedáleň a ostatné' },
];

let msgFilterChecked = {
  SPRAVY: true,
  ZNAMKY: true,
  SUPLOVANIE: true,
  ULOHY: true,
  DOCHADZKA: true,
  OSTATNE: true,
};
let msgFilterCursor = 0; // 0 = VŠETKY TYPY, 1..6 = jednotlivých 6 kategórií, 7 = VYČISTIŤ HĽADANIE
let msgSearchQuery = '';

function getCategoryMeta(catKey) {
  return MESSAGE_CATEGORIES.find((c) => c.key === catKey) || MESSAGE_CATEGORIES[0];
}

function getAllNotificationsList() {
  const raw = dashboardData.notifications;
  if (Array.isArray(raw) && raw.length > 0) {
    return raw;
  }
  // Fallback if notifications array isn't populated yet
  const fallback = [];
  (dashboardData.tasks || []).forEach((t, i) => {
    fallback.push({
      id: `task_${i}`,
      date: t.date || '-',
      time: '08:00',
      category: 'ULOHY',
      badge: t.type || 'ÚLOHA',
      author: t.author || 'Učiteľ',
      recipient: '',
      subject: '',
      due_date: t.date || '',
      text: t.text || '-',
      attachments: [],
    });
  });
  (dashboardData.all_grades || []).slice(0, 15).forEach((g, i) => {
    fallback.push({
      id: `grd_${i}`,
      date: g.date || '-',
      time: '12:00',
      category: 'ZNAMKY',
      badge: 'ZNÁMKA',
      author: g.teacher || 'Učiteľ',
      recipient: '',
      subject: g.subject || '',
      due_date: '',
      text: `Známka ${g.grade} (${g.title || 'Hodnotenie'})`,
      attachments: [],
    });
  });
  return fallback;
}

function getFilteredNotifications() {
  const all = getAllNotificationsList();
  const q = msgSearchQuery.trim().toLowerCase();

  return all.filter((n) => {
    const cat = n.category || 'OSTATNE';
    if (!msgFilterChecked[cat]) return false;

    if (!q) return true;
    const hay = [
      n.text || '',
      n.subject || '',
      n.author || '',
      n.badge || '',
      n.recipient || '',
      n.date || '',
    ].join(' ').toLowerCase();
    return hay.includes(q);
  });
}

function formatDaySeparatorTitle(dateIso) {
  if (!dateIso || dateIso === '-') return 'NEZNÁMY DÁTUM';
  const now = new Date();
  const todayIso = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const parts = dateIso.split('-').map(Number);
  if (parts.length !== 3 || isNaN(parts[0])) return dateIso;

  const dt = new Date(parts[0], parts[1] - 1, parts[2]);
  const dayNames = ['NEDEĽA', 'PONDELOK', 'UTOROK', 'STREDA', 'ŠTVRTOK', 'PIATOK', 'SOBOTA'];
  const dayName = dayNames[dt.getDay()] || '';
  const dFmt = `${String(parts[2]).padStart(2, '0')}.${String(parts[1]).padStart(2, '0')}.${parts[0]}`;

  if (dateIso === todayIso) {
    return `DNES — ${dayName} ${dFmt}`;
  }

  const tParts = todayIso.split('-').map(Number);
  if (tParts.length === 3) {
    const todayDt = new Date(tParts[0], tParts[1] - 1, tParts[2]);
    const diffDays = Math.round((todayDt - dt) / (1000 * 60 * 60 * 24));
    if (diffDays === 1) {
      return `VČERA — ${dayName} ${dFmt}`;
    }
  }
  return `${dayName} — ${dFmt}`;
}

function wrapTextToLines(text, maxLineWidth) {
  const width = Math.max(24, maxLineWidth);
  const paragraphs = String(text || '-').split('\n');
  const wrapped = [];

  paragraphs.forEach((para) => {
    const trimmed = para.replace(/\s+/g, ' ').trim();
    if (!trimmed) return;
    const words = trimmed.split(' ');
    let currentLine = '';

    words.forEach((word) => {
      if (word.length > width) {
        if (currentLine) {
          wrapped.push(currentLine);
          currentLine = '';
        }
        for (let i = 0; i < word.length; i += width) {
          wrapped.push(word.slice(i, i + width));
        }
      } else if (!currentLine) {
        currentLine = word;
      } else if (currentLine.length + 1 + word.length <= width) {
        currentLine += ' ' + word;
      } else {
        wrapped.push(currentLine);
        currentLine = word;
      }
    });

    if (currentLine) {
      wrapped.push(currentLine);
    }
  });

  return wrapped.length > 0 ? wrapped : ['-'];
}

function toggleMessageFilterAtCursor() {
  if (msgFilterCursor === 0) {
    const allChecked = MESSAGE_CATEGORIES.every((c) => msgFilterChecked[c.key]);
    const nextState = !allChecked;
    MESSAGE_CATEGORIES.forEach((c) => {
      msgFilterChecked[c.key] = nextState;
    });
  } else if (msgFilterCursor >= 1 && msgFilterCursor <= MESSAGE_CATEGORIES.length) {
    const cat = MESSAGE_CATEGORIES[msgFilterCursor - 1];
    msgFilterChecked[cat.key] = !msgFilterChecked[cat.key];
  } else if (msgFilterCursor === MESSAGE_CATEGORIES.length + 1) {
    msgSearchQuery = '';
    MESSAGE_CATEGORIES.forEach((c) => {
      msgFilterChecked[c.key] = true;
    });
  }
  if (typeof messagesFeedBox.scrollTo === 'function') {
    messagesFeedBox.scrollTo(0);
  }
}

function renderMessagesSidebar() {
  const isFilterFocused = activeTabIndex === 3 && navFocus === 'card' && msgSubFocus === 'filters';
  messagesSidebar.style.border.fg = isFilterFocused ? COLOR_ORANGE : COLOR_DARK_GRAY;
  messagesSidebar.setLabel(' [ FILTRE ] ');

  const all = getAllNotificationsList();
  const filtered = getFilteredNotifications();
  const countsByCat = {};
  MESSAGE_CATEGORIES.forEach((c) => {
    countsByCat[c.key] = 0;
  });
  all.forEach((n) => {
    const k = n.category || 'OSTATNE';
    countsByCat[k] = (countsByCat[k] || 0) + 1;
  });

  const allChecked = MESSAGE_CATEGORIES.every((c) => msgFilterChecked[c.key]);

  const lines = [];
  lines.push(' {244-fg}ZOBRAZENÉ{/244-fg}');
  lines.push(` {236-bg}{white-fg}{bold}${padRawLine(` ● ${filtered.length} / ${all.length} SPRÁV`, 30)}{/bold}{/white-fg}{/236-bg}`);
  if (msgSearchQuery.trim()) {
    lines.push(` {250-fg}${fitPlain(`Hľadané: "${msgSearchQuery.trim()}"`, 30)}{/250-fg}`);
  }
  lines.push('{240-fg}────────────────────────────────{/240-fg}');
  lines.push(' {244-fg}KATEGÓRIE{/244-fg}');
  lines.push('');

  // Row 0: VŠETKY TYPY
  const row0Focused = isFilterFocused && msgFilterCursor === 0;
  const markAll = allChecked ? '[x]' : '[ ]';
  const row0Text = ` ${row0Focused ? '▸' : ' '} ${markAll} VŠETKY (${all.length})`;
  if (row0Focused) {
    lines.push(`{208-bg}{black-fg}{bold}${padRawLine(row0Text, 32)}{/bold}{/black-fg}{/208-bg}`);
  } else if (allChecked) {
    lines.push(`{white-fg}{bold}${padRawLine(row0Text, 32)}{/bold}{/white-fg}`);
  } else {
    lines.push(`{244-fg}${padRawLine(row0Text, 32)}{/244-fg}`);
  }
  lines.push('');

  // Rows 1..6: Individual Category Checkboxes
  MESSAGE_CATEGORIES.forEach((cat, idx) => {
    const itemIdx = idx + 1;
    const isHere = isFilterFocused && msgFilterCursor === itemIdx;
    const checked = !!msgFilterChecked[cat.key];
    const boxMark = checked ? '[x]' : '[ ]';
    const cnt = countsByCat[cat.key] || 0;
    const labelPart = fitPlain(cat.label, 19).padEnd(19, ' ');
    const rawRow = ` ${isHere ? '▸' : ' '} ${boxMark} ${labelPart} (${String(cnt).padStart(2, ' ')})`;

    if (isHere) {
      lines.push(`{208-bg}{black-fg}{bold}${padRawLine(rawRow, 32)}{/bold}{/black-fg}{/208-bg}`);
    } else if (checked) {
      lines.push(`{white-fg}   [x] ${labelPart}{/white-fg} {244-fg}(${String(cnt).padStart(2, ' ')}){/244-fg}`);
    } else {
      lines.push(`{240-fg}   [ ] ${labelPart} (${String(cnt).padStart(2, ' ')}){/240-fg}`);
    }
    lines.push('');
  });

  // Row 7: Reset Filters & Search
  const resetIdx = MESSAGE_CATEGORIES.length + 1;
  const resetFocused = isFilterFocused && msgFilterCursor === resetIdx;
  const resetText = ` ${resetFocused ? '▸' : ' '} [↺] Resetovať filtre`;
  if (resetFocused) {
    lines.push(`{208-bg}{black-fg}{bold}${padRawLine(resetText, 32)}{/bold}{/black-fg}{/208-bg}`);
  } else {
    lines.push(`{244-fg}${padRawLine(resetText, 32)}{/244-fg}`);
  }

  messagesSidebar.setContent(lines.join('\n'));
}

function renderMessagesSearchBox() {
  const isSearchFocused = activeTabIndex === 3 && navFocus === 'card' && msgSubFocus === 'search';
  messagesSearchBox.style.border.fg = isSearchFocused ? COLOR_ORANGE : COLOR_DARK_GRAY;
  messagesSearchBox.setLabel(' [ HĽADAŤ ] ');

  const filteredCount = getFilteredNotifications().length;
  const totalCount = getAllNotificationsList().length;

  let queryDisplay = '';
  if (isSearchFocused) {
    queryDisplay = `{208-fg}{bold}Hľadať:{/bold}{/208-fg} {white-fg}${msgSearchQuery}{/white-fg}{208-fg}█{/208-fg}`;
  } else if (msgSearchQuery.trim()) {
    queryDisplay = `{250-fg}Hľadať:{/250-fg} {white-fg}{bold}${msgSearchQuery}{/bold}{/white-fg}`;
  } else {
    queryDisplay = '{244-fg}Hľadať text alebo predmet...{/244-fg}';
  }

  const rightStat = `{244-fg}${filteredCount} / ${totalCount}{/244-fg}`;
  messagesSearchBox.setContent(` ${queryDisplay}    {240-fg}│{/240-fg}    ${rightStat}`);
}

function renderMessagesFeed() {
  const isFeedFocused = activeTabIndex === 3 && navFocus === 'card' && msgSubFocus === 'feed';
  messagesFeedBox.style.border.fg = isFeedFocused ? COLOR_ORANGE : COLOR_DARK_GRAY;
  messagesFeedBox.setLabel(' [ SPRÁVY ] ');

  const boxWidth = messagesFeedBox.width && messagesFeedBox.width > 45
    ? messagesFeedBox.width
    : Math.max(82, screen.width - SIDEBAR_WIDTH);
  const innerW = Math.max(76, boxWidth - 6);

  const items = getFilteredNotifications();
  const out = [];

  if (items.length === 0) {
    out.push('');
    out.push(' {244-fg}Žiadne záznamy.{/244-fg}');
    messagesFeedBox.setContent(out.join('\n'));
    return;
  }

  let currentDay = null;
  const dayCounts = {};
  items.forEach((n) => {
    const d = n.date || '-';
    dayCounts[d] = (dayCounts[d] || 0) + 1;
  });

  items.forEach((n) => {
    const d = n.date || '-';
    if (d !== currentDay) {
      if (currentDay !== null) {
        out.push('');
      }
      currentDay = d;
      const dayTitle = formatDaySeparatorTitle(d);
      const labelBlock = ` ${dayTitle} (${dayCounts[d] || 1}) `;
      const lineTotal = Math.max(10, innerW - labelBlock.length);
      const leftDash = '─'.repeat(4);
      const rightDash = '─'.repeat(Math.max(4, lineTotal - 4));

      out.push(` {240-fg}${leftDash}{/240-fg}{236-bg}{white-fg}{bold}${labelBlock}{/bold}{/white-fg}{/236-bg}{240-fg}${rightDash}{/240-fg}`);
      out.push('');
    }

    const cardW = innerW - 2;

    // Header Row inside card: TIME │ [BADGE] │ PREDMET │ OD │ TERMÍN
    const timeStr = n.time && n.time !== '-' ? n.time : '     ';
    const badgeStr = `[${n.badge || 'OZNAM'}]`;
    const subjPart = n.subject ? `  ·  ${n.subject}` : '';
    const authorPart = n.author ? `  ·  ${n.author}` : '';
    const duePart = n.due_date ? `  ·  Termín: ${n.due_date}` : '';
    const headerPlain = ` ${timeStr}  ${badgeStr}${subjPart}${authorPart}${duePart}`;

    out.push(` {240-fg}┌${'─'.repeat(cardW)}┐{/240-fg}`);
    out.push(
      ` {240-fg}│{/240-fg}{bold}{250-fg}${padRawLine(headerPlain, cardW)}{/250-fg}{/bold}{240-fg}│{/240-fg}`
    );
    out.push(` {240-fg}├${'─'.repeat(cardW)}┤{/240-fg}`);

    // Wrapped Body Lines with breathing room
    const bodyLines = wrapTextToLines(n.text || '-', cardW - 4);
    bodyLines.forEach((bLine) => {
      out.push(` {240-fg}│{/240-fg}{white-fg}  ${padRawLine(bLine, cardW - 2)}{/white-fg}{240-fg}│{/240-fg}`);
    });

    // Optional Attachments line inside card
    if (Array.isArray(n.attachments) && n.attachments.length > 0) {
      const attStr = `  Príloha: ${n.attachments.join(', ')}`;
      out.push(` {240-fg}│{/240-fg}{244-fg}${padRawLine(attStr, cardW)}{/244-fg}{240-fg}│{/240-fg}`);
    }

    out.push(` {240-fg}└${'─'.repeat(cardW)}┘{/240-fg}`);
    out.push('');
  });

  messagesFeedBox.setContent(out.join('\n'));
}

function renderMessagesCard() {
  renderMessagesSidebar();
  renderMessagesSearchBox();
  renderMessagesFeed();
}

function updateWidgets() {
  updateHeader();
  updateFooter();
  updateMonitorFocusStyles();

  // 1. Line Graph (Monochrome white line)
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
        style: { line: 'white' },
      },
    ]);
  }

  // 2. Monochrome Grade Distribution Box
  const distData = (dashboardData.distribution && dashboardData.distribution.data) || [0, 0, 0, 0, 0];
  const distLabels = ['Výborný', 'Chválitebný', 'Dobrý', 'Dostatočný', 'Nedostatočný'];
  const maxCount = Math.max(...distData, 1);
  const totalMarks = distData.reduce((a, b) => a + b, 0);

  let distLines = [];
  distData.forEach((count, i) => {
    const gradeNum = i + 1;
    const label = distLabels[i].padEnd(12, ' ');
    const pct = totalMarks > 0 ? ((count / totalMarks) * 100).toFixed(1) : '0.0';
    const barLen = Math.round((count / maxCount) * 22);
    const barStr = barLen > 0 ? '█'.repeat(barLen) : '·';
    const paddedBar = barStr.padEnd(23, ' ');
    const countStr = String(count).padStart(2, ' ');
    const pctStr = `(${pct}%)`.padStart(7, ' ');
    distLines.push(` {250-fg}${gradeNum}  ${label}{/250-fg} {white-fg}${paddedBar}{/white-fg} {bold}{white-fg}${countStr}{/white-fg}{/bold}  {244-fg}${pctStr}{/244-fg}`);
  });
  const passCount = distData[0] + distData[1] + distData[2] + distData[3];
  const passRate = totalMarks > 0 ? ((passCount / totalMarks) * 100).toFixed(1) : '0.0';
  distLines.push(` {244-fg}SPOLU:{/244-fg} {white-fg}${totalMarks}{/white-fg}  {240-fg}│{/240-fg}  {244-fg}PRIEMER:{/244-fg} {white-fg}{bold}${dashboardData.gpa || '-'}{/bold}{/white-fg}  {240-fg}│{/240-fg}  {244-fg}ÚSPEŠNOSŤ:{/244-fg} {250-fg}${passRate}%{/250-fg}`);
  distributionBox.setContent(distLines.join('\n'));

  // 3. Live Monitor Timetable & Progress Calculation
  updateLiveProgress();

  // 4. Mini Lunch Box (Monochrome)
  const lunch = dashboardData.lunches;
  if (lunch) {
    let lines = [];
    lines.push(` {244-fg}STAV:{/244-fg} {white-fg}{bold}${lunch.status || 'OBJEDNANÉ: ' + lunch.ordered_meal}{/bold}{/white-fg}`);
    if (lunch.serving) lines.push(` {244-fg}VÝDAJ:{/244-fg} {250-fg}${lunch.serving}{/250-fg}`);
    if (lunch.menus && lunch.menus.length > 0) {
      lunch.menus.slice(0, 3).forEach((m) => {
        const numStr = m.number ? `[${m.number}] ` : '';
        lines.push(` {250-fg}• ${numStr}${m.name.slice(0, 48)}{/250-fg}`);
      });
    }
    miniLunchBox.setContent(lines.join('\n'));
  } else {
    miniLunchBox.setContent(' {244-fg}Žiadne informácie o jedálni na dnešný deň.{/244-fg}');
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

  // 8. Tab 4 Messages View (Left Checkbox Filters + Top Search + Day-Divided Feed)
  renderMessagesCard();

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
    notifications: [],
    all_grades: [],
    commendations: [],
  };
}

// ==============================================================================
// Keyboard Handlers & Two-Level Navigation (Topbar <-> Card Sidebar)
// ==============================================================================

function isMessagesSearchActive() {
  return activeTabIndex === 3 && navFocus === 'card' && msgSubFocus === 'search';
}

// Handle typing inside the Tab 4 Search Box
screen.on('keypress', (ch, key) => {
  if (!isMessagesSearchActive() || !key) return;

  if (key.name === 'backspace') {
    msgSearchQuery = msgSearchQuery.slice(0, -1);
    if (typeof messagesFeedBox.scrollTo === 'function') messagesFeedBox.scrollTo(0);
    renderMessagesCard();
    screen.render();
    return;
  }

  if (key.name === 'delete' || (key.ctrl && key.name === 'u')) {
    msgSearchQuery = '';
    if (typeof messagesFeedBox.scrollTo === 'function') messagesFeedBox.scrollTo(0);
    renderMessagesCard();
    screen.render();
    return;
  }

  if (
    ['up', 'down', 'left', 'right', 'enter', 'return', 'escape', 'tab', 'pageup', 'pagedown'].includes(
      key.name
    )
  ) {
    return;
  }

  if (ch && !key.ctrl && !key.meta && ch.length === 1 && ch.charCodeAt(0) >= 32) {
    msgSearchQuery += ch;
    if (typeof messagesFeedBox.scrollTo === 'function') messagesFeedBox.scrollTo(0);
    renderMessagesCard();
    screen.render();
  }
});

// Direct Number Tab Switching [1 - 5] (ignored when typing into search box)
screen.key(['1'], () => {
  if (!isMessagesSearchActive()) switchTab(0);
});
screen.key(['2'], () => {
  if (!isMessagesSearchActive()) switchTab(1);
});
screen.key(['3'], () => {
  if (!isMessagesSearchActive()) switchTab(2);
});
screen.key(['4'], () => {
  if (!isMessagesSearchActive()) switchTab(3);
});
screen.key(['5'], () => {
  if (!isMessagesSearchActive()) switchTab(4);
});

// Bracket Tab Switching always available when not typing in search box
screen.key(['['], () => {
  if (!isMessagesSearchActive()) switchTab((activeTabIndex - 1 + TABS.length) % TABS.length);
});
screen.key([']'], () => {
  if (!isMessagesSearchActive()) switchTab((activeTabIndex + 1) % TABS.length);
});

// Quick Search Activation on Tab 4 with '/' or 'f'
screen.key(['/', 'f'], () => {
  if (activeTabIndex === 3 && !isMessagesSearchActive()) {
    navFocus = 'card';
    msgSubFocus = 'search';
    updateHeader();
    updateFooter();
    renderMessagesCard();
    screen.render();
  }
});

// Left / Right Arrows: Switch Tabs when on Topbar; operate inside Card when in Sidebar/Feed
screen.key(['left', 'h'], (_, key) => {
  if (isMessagesSearchActive()) return;
  if (key && key.name === 'h' && activeTabIndex === 3 && navFocus === 'card') {
    // Allow 'h' or 'left' to switch from Feed to Left Checkboxes
  }
  if (activeTabIndex === 1 && navFocus === 'card') {
    applySidebarItem(sidebarCursor, true);
    renderTimetableCard();
    screen.render();
  } else if (activeTabIndex === 2 && navFocus === 'card') {
    if (typeof gradesMainBox.scroll === 'function') gradesMainBox.scroll(-4);
    screen.render();
  } else if (activeTabIndex === 3 && navFocus === 'card') {
    msgSubFocus = 'filters';
    updateFooter();
    renderMessagesCard();
    screen.render();
  } else {
    switchTab((activeTabIndex - 1 + TABS.length) % TABS.length);
  }
});

screen.key(['right', 'l'], () => {
  if (isMessagesSearchActive()) return;
  if (activeTabIndex === 1 && navFocus === 'card') {
    applySidebarItem(sidebarCursor, true);
    renderTimetableCard();
    screen.render();
  } else if (activeTabIndex === 2 && navFocus === 'card') {
    if (typeof gradesMainBox.scroll === 'function') gradesMainBox.scroll(4);
    screen.render();
  } else if (activeTabIndex === 3 && navFocus === 'card') {
    msgSubFocus = 'feed';
    updateFooter();
    renderMessagesCard();
    screen.render();
  } else {
    switchTab((activeTabIndex + 1) % TABS.length);
  }
});

// PageUp / PageDown for fast scrolling through earlier notifications
screen.key(['pageup'], () => {
  if (activeTabIndex === 3) {
    if (typeof messagesFeedBox.scroll === 'function') messagesFeedBox.scroll(-12);
    renderMessagesCard();
    screen.render();
  } else if (activeTabIndex === 2 && typeof gradesMainBox.scroll === 'function') {
    gradesMainBox.scroll(-10);
    screen.render();
  }
});

screen.key(['pagedown'], () => {
  if (activeTabIndex === 3) {
    if (typeof messagesFeedBox.scroll === 'function') messagesFeedBox.scroll(12);
    renderMessagesCard();
    screen.render();
  } else if (activeTabIndex === 2 && typeof gradesMainBox.scroll === 'function') {
    gradesMainBox.scroll(10);
    screen.render();
  }
});

// Down Arrow: Enter Card from Topbar, move cursor down inside Sidebar, or scroll notifications feed
screen.key(['down', 'j'], (_, key) => {
  if (isMessagesSearchActive() && key && key.name === 'j') return;

  if (activeTabIndex === 0) {
    if (navFocus === 'topbar') {
      navFocus = 'card';
      updateHeader();
      updateFooter();
      updateMonitorFocusStyles();
      const widgets = TAB_WIDGETS[0];
      if (widgets && widgets[activeWidgetIndex]) widgets[activeWidgetIndex].focus();
      screen.render();
    }
  } else if (activeTabIndex === 1) {
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
  } else if (activeTabIndex === 3) {
    const maxFilterIdx = MESSAGE_CATEGORIES.length + 1;
    if (navFocus === 'topbar') {
      navFocus = 'card';
      msgSubFocus = 'feed';
      updateHeader();
      updateFooter();
      renderMessagesCard();
      screen.render();
    } else if (msgSubFocus === 'search') {
      msgSubFocus = 'feed';
      updateFooter();
      renderMessagesCard();
      screen.render();
    } else if (msgSubFocus === 'filters') {
      if (msgFilterCursor < maxFilterIdx) {
        msgFilterCursor += 1;
        renderMessagesCard();
        screen.render();
      }
    } else if (msgSubFocus === 'feed') {
      if (typeof messagesFeedBox.scroll === 'function') {
        messagesFeedBox.scroll(3);
      }
      screen.render();
    }
  }
});

// Up Arrow: Move cursor up inside Card Sidebar/Feed; exit back to Topbar from top item
screen.key(['up', 'k'], (_, key) => {
  if (isMessagesSearchActive() && key && key.name === 'k') return;

  if (activeTabIndex === 0 && navFocus === 'card') {
    const widgets = TAB_WIDGETS[0];
    const currentW = widgets && widgets[activeWidgetIndex];
    const selectedRow = currentW && currentW.rows ? currentW.rows.selected : 0;
    if (!selectedRow || selectedRow <= 0) {
      navFocus = 'topbar';
      updateHeader();
      updateFooter();
      updateMonitorFocusStyles();
      headerBox.focus();
      screen.render();
    }
  } else if (activeTabIndex === 1 && navFocus === 'card') {
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
  } else if (activeTabIndex === 3 && navFocus === 'card') {
    if (msgSubFocus === 'search') {
      navFocus = 'topbar';
      updateHeader();
      updateFooter();
      renderMessagesCard();
      screen.render();
    } else if (msgSubFocus === 'filters') {
      if (msgFilterCursor > 0) {
        msgFilterCursor -= 1;
        renderMessagesCard();
        screen.render();
      } else {
        navFocus = 'topbar';
        updateHeader();
        updateFooter();
        renderMessagesCard();
        screen.render();
      }
    } else if (msgSubFocus === 'feed') {
      const currentScroll = typeof messagesFeedBox.getScroll === 'function' ? messagesFeedBox.getScroll() : 0;
      if (currentScroll > 0 && typeof messagesFeedBox.scroll === 'function') {
        messagesFeedBox.scroll(-3);
        screen.render();
      } else {
        msgSubFocus = 'search';
        updateFooter();
        renderMessagesCard();
        screen.render();
      }
    }
  }
});

// Enter / Space: Activate or toggle checkbox inside Sidebar
screen.key(['enter', 'space'], (_, key) => {
  if (isMessagesSearchActive()) {
    if (key && (key.name === 'enter' || key.name === 'return')) {
      msgSubFocus = 'feed';
      updateFooter();
      renderMessagesCard();
      screen.render();
    }
    return;
  }

  if (activeTabIndex === 1 && navFocus === 'card') {
    applySidebarItem(sidebarCursor, true);
    renderTimetableCard();
    screen.render();
  } else if (activeTabIndex === 2 && navFocus === 'card') {
    renderGradesCard();
    screen.render();
  } else if (activeTabIndex === 3 && navFocus === 'card') {
    if (msgSubFocus === 'filters') {
      toggleMessageFilterAtCursor();
      renderMessagesCard();
      screen.render();
    }
  }
});

// Tab / Shift-Tab widget focus cycling inside Monitor tab or Tab 4 sub-areas
screen.key(['tab'], () => {
  if (activeTabIndex === 3) {
    navFocus = 'card';
    const order = ['feed', 'filters', 'search'];
    const nextIdx = (order.indexOf(msgSubFocus) + 1) % order.length;
    msgSubFocus = order[nextIdx];
    updateHeader();
    updateFooter();
    renderMessagesCard();
    screen.render();
    return;
  }
  const widgets = TAB_WIDGETS[activeTabIndex];
  if (widgets && widgets.length > 1) {
    navFocus = 'card';
    activeWidgetIndex = (activeWidgetIndex + 1) % widgets.length;
    updateHeader();
    updateMonitorFocusStyles();
    widgets[activeWidgetIndex].focus();
    screen.render();
  }
});

screen.key(['S-tab'], () => {
  if (activeTabIndex === 3) {
    navFocus = 'card';
    const order = ['feed', 'filters', 'search'];
    const prevIdx = (order.indexOf(msgSubFocus) - 1 + order.length) % order.length;
    msgSubFocus = order[prevIdx];
    updateHeader();
    updateFooter();
    renderMessagesCard();
    screen.render();
    return;
  }
  const widgets = TAB_WIDGETS[activeTabIndex];
  if (widgets && widgets.length > 1) {
    navFocus = 'card';
    activeWidgetIndex = (activeWidgetIndex - 1 + widgets.length) % widgets.length;
    updateHeader();
    updateMonitorFocusStyles();
    widgets[activeWidgetIndex].focus();
    screen.render();
  }
});

// Refresh (ignored when typing into search box)
screen.key(['r'], () => {
  if (!isMessagesSearchActive()) fetchEdupageData();
});

// Quit (Esc exits search input first if search input is active)
screen.key(['escape'], () => {
  if (isMessagesSearchActive()) {
    msgSubFocus = 'feed';
    updateFooter();
    renderMessagesCard();
    screen.render();
    return;
  }
  process.exit(0);
});

screen.key(['q'], () => {
  if (!isMessagesSearchActive()) {
    process.exit(0);
  }
});

screen.key(['C-c'], () => {
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
