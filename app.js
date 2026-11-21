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
// Light Blue, Slate Blue & Cool Grayscale Palette (256-Color)
// ==============================================================================

const COLOR_ORANGE = 208;       // #ff8700 - ONLY for currently active/controlled element
const COLOR_ICE_BLUE = 117;     // #87d7ff - Bright light sky/ice blue (active bells, now tags, highlight stats)
const COLOR_LIGHT_BLUE = 153;   // #afd7ff - Soft pale light blue (svetlunkomodrá - subject names, primary highlights)
const COLOR_SLATE_BLUE = 110;   // #87afd7 - Medium slate blue (category titles, table headers)
const COLOR_STEEL_BLUE = 67;    // #5f87af - Subtle steel blue (borders, frames, grid lines)
const COLOR_DARK_NAVY = 24;     // #005f87 - Dark navy slate background tint for active banners
const COLOR_WHITE = 255;        // #eeeeee - Primary bright white text
const COLOR_LIGHT_GRAY = 250;   // #bcbcbc - Secondary text / table details
const COLOR_MID_GRAY = 244;     // #808080 - Muted labels / timestamps
const COLOR_DARK_GRAY = 240;    // #585858 - Subtle muted lines / inactive
const COLOR_CHARCOAL = 236;     // #303030 - Dark surface highlight

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
let lunchDayCursor = 0;
let lunchSubFocus = 'sidebar'; // 'sidebar' | 'button' | 'rating'
let lunchRatingQuality = 5;
let lunchRatingQuantity = 5;
let lunchRatingField = 'quality'; // 'quality' | 'quantity'
let lunchActionFeedback = null;
let lunchActionTimer = null;

// In-CLI Modal Overlays State
let activeModal = null; // null | 'confirm_lunch' | 'compose_message'
let confirmModalPendingDay = null;
let confirmModalPendingAction = 'signoff'; // 'signoff' | 'order'
let confirmModalExecuting = false;
let confirmModalFeedback = null;

// Tab 4 Compose Message State (Multi-recipient: Classes, Teachers, Students)
let composeStep = 'recipients'; // 'recipients' | 'body'
let composeSearchQuery = '';
let composeRecipientCursor = 0;
let composeSelectedRecipients = []; // Array of recipient objects: { id, name, type, type_label, detail }
let composeBody = '';
let composeFeedback = null;
let composeExecuting = false;
let lastModalClosedAt = 0; // Debounce guard to prevent race condition when closing modals with Esc
let lastModalEnterAt = 0;  // Debounce guard to prevent duplicate enter/return events on Windows

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
// Bottom Footer Box (Minimal Light-Blue / Gray Bar)
// ==============================================================================

const footerBox = blessed.box({
  parent: screen,
  bottom: 0,
  left: 0,
  width: '100%',
  height: 3,
  tags: true,
  border: { type: 'line', fg: COLOR_STEEL_BLUE },
  label: ' [ SKRATKY ] ',
  style: {
    border: { fg: COLOR_STEEL_BLUE },
    fg: 'white',
    bg: 'black',
  },
  content: ' {153-fg}[1-5]{/153-fg} {244-fg}Karty{/244-fg}  {67-fg}│{/67-fg}  {153-fg}[Šípky]{/153-fg} {244-fg}Pohyb{/244-fg}  {67-fg}│{/67-fg}  {153-fg}[r]{/153-fg} {244-fg}Obnoviť{/244-fg}  {67-fg}│{/67-fg}  {153-fg}[q]{/153-fg} {244-fg}Koniec{/244-fg}',
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

// 1. Marks Trend (Cyan/Light Blue line on steel blue border)
const lineGraph = monitorGrid.set(0, 0, 5, 6, contrib.line, {
  label: ' [ VÝVOJ PRIEMERU ] ',
  showLegend: false,
  xPadding: 2,
  xLabelPadding: 1,
  wholeNumbersOnly: false,
  minY: 1.0,
  maxY: 3.5,
  border: { type: 'line', fg: COLOR_STEEL_BLUE },
  style: {
    line: 'cyan',
    text: 'white',
    baseline: 'black',
    border: { fg: COLOR_STEEL_BLUE },
  },
});

// 2. Marks Distribution (Light blue bars on steel blue border)
const distributionBox = monitorGrid.set(5, 0, 4, 6, blessed.box, {
  label: ' [ ROZDELENIE ZNÁMOK (1 - 5) ] ',
  tags: true,
  border: { type: 'line', fg: COLOR_STEEL_BLUE },
  style: {
    border: { fg: COLOR_STEEL_BLUE },
    fg: 'white',
    bg: 'black',
  },
});

// 3. Mini Lunch Box (Steel blue border)
const miniLunchBox = monitorGrid.set(9, 0, 3, 6, blessed.box, {
  label: ' [ DNEŠNÝ OBED ] ',
  tags: true,
  border: { type: 'line', fg: COLOR_STEEL_BLUE },
  style: {
    border: { fg: COLOR_STEEL_BLUE },
    fg: 'white',
    bg: 'black',
  },
});

// 4. Timetable Table (Light blue headers; orange selection when focused)
const timetableTable = monitorGrid.set(0, 6, 6, 6, contrib.table, {
  keys: true,
  interactive: true,
  label: ' [ DNEŠNÝ ROZVRH ] ',
  border: { type: 'line', fg: COLOR_STEEL_BLUE },
  columnSpacing: 2,
  columnWidth: [4, 13, 26, 20, 10],
  headers: ['#', 'ČAS', 'PREDMET', 'UČITEĽ', 'STAV'],
  fg: 'white',
  selectedFg: 'black',
  selectedBg: COLOR_ORANGE,
  style: {
    border: { fg: COLOR_STEEL_BLUE },
    header: { fg: 153, bold: true },
  },
});

// 5. Current Lesson Progress Gauge (Cyan / Ice Blue stroke)
const lessonGauge = monitorGrid.set(6, 6, 2, 6, contrib.gauge, {
  label: ' [ PRIEBEH VYUČOVANIA ] ',
  stroke: 'cyan',
  fill: 'white',
  border: { type: 'line', fg: COLOR_STEEL_BLUE },
  style: {
    border: { fg: COLOR_STEEL_BLUE },
  },
});

// 6. Mini Tasks Table (Light blue headers; orange selection when focused)
const miniTasksTable = monitorGrid.set(8, 6, 4, 6, contrib.table, {
  keys: true,
  interactive: true,
  label: ' [ ÚLOHY A PÍSOMKY ] ',
  border: { type: 'line', fg: COLOR_STEEL_BLUE },
  columnSpacing: 2,
  columnWidth: [11, 10, 18, 30],
  headers: ['TERMÍN', 'TYP', 'UČITEĽ', 'ZADANIE'],
  fg: 'white',
  selectedFg: 'black',
  selectedBg: COLOR_ORANGE,
  style: {
    border: { fg: COLOR_STEEL_BLUE },
    header: { fg: 153, bold: true },
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
  border: { type: 'line', fg: COLOR_STEEL_BLUE },
  label: ' [ ROZVRH ] ',
  style: {
    border: { fg: COLOR_STEEL_BLUE },
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
  border: { type: 'line', fg: COLOR_STEEL_BLUE },
  label: ' [ TÝŽDENNÝ ROZVRH ] ',
  style: {
    border: { fg: COLOR_STEEL_BLUE },
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
    border: { type: 'line', fg: COLOR_STEEL_BLUE },
    label: ` [ ${labelText} ] `,
    style: {
      border: { fg: COLOR_STEEL_BLUE },
      fg: 'white',
      bg: 'black',
    },
    content: `{bold}{153-fg}${labelText}{/153-fg}{/bold}\n\n{244-fg}Zatiaľ prázdne.{/244-fg}`,
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
  border: { type: 'line', fg: COLOR_STEEL_BLUE },
  label: ' [ PREDMETY ] ',
  style: {
    border: { fg: COLOR_STEEL_BLUE },
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
  border: { type: 'line', fg: COLOR_STEEL_BLUE },
  label: ' [ ZNÁMKY ] ',
  style: {
    border: { fg: COLOR_STEEL_BLUE },
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
  border: { type: 'line', fg: COLOR_STEEL_BLUE },
  label: ' [ FILTRE ] ',
  style: {
    border: { fg: COLOR_STEEL_BLUE },
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
  border: { type: 'line', fg: COLOR_STEEL_BLUE },
  label: ' [ HĽADAŤ ] ',
  style: {
    border: { fg: COLOR_STEEL_BLUE },
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
  border: { type: 'line', fg: COLOR_STEEL_BLUE },
  label: ' [ SPRÁVY ] ',
  style: {
    border: { fg: COLOR_STEEL_BLUE },
    fg: 'white',
    bg: 'black',
  },
});

// ==============================================================================
// TAB 5: OBEDY (Cafeteria Lunches, Left Day Switching & Cancel / Rating Controls)
// ==============================================================================

const viewLunches = blessed.box({
  parent: contentArea,
  top: 0,
  left: 0,
  width: '100%',
  height: '100%',
  hidden: true,
});

const lunchesSidebar = blessed.box({
  parent: viewLunches,
  top: 0,
  left: 0,
  width: SIDEBAR_WIDTH,
  height: '100%',
  tags: true,
  border: { type: 'line', fg: COLOR_STEEL_BLUE },
  label: ' [ DNI ] ',
  style: {
    border: { fg: COLOR_STEEL_BLUE },
    fg: 'white',
    bg: 'black',
  },
});

const lunchesMainBox = blessed.box({
  parent: viewLunches,
  top: 0,
  left: SIDEBAR_WIDTH,
  width: `100%-${SIDEBAR_WIDTH}`,
  height: '100%',
  tags: true,
  scrollable: true,
  alwaysScroll: true,
  border: { type: 'line', fg: COLOR_STEEL_BLUE },
  label: ' [ OBED ] ',
  style: {
    border: { fg: COLOR_STEEL_BLUE },
    fg: 'white',
    bg: 'black',
  },
});

// ==============================================================================
// IN-CLI POPUP MODALS: CONFIRM LUNCH SIGN-OFF & COMPOSE MESSAGE
// ==============================================================================

const confirmLunchModal = blessed.box({
  parent: screen,
  top: 'center',
  left: 'center',
  width: 66,
  height: 14,
  tags: true,
  border: { type: 'line', fg: 196 },
  style: {
    border: { fg: 196 },
    bg: 'black',
    fg: 'white',
  },
  hidden: true,
  shadow: true,
});

const composeModal = blessed.box({
  parent: screen,
  top: 'center',
  left: 'center',
  width: 76,
  height: 25,
  tags: true,
  border: { type: 'line', fg: COLOR_ORANGE },
  style: {
    border: { fg: COLOR_ORANGE },
    bg: 'black',
    fg: 'white',
  },
  hidden: true,
  shadow: true,
});

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
  return tabIdx === 1 || tabIdx === 2 || tabIdx === 3 || tabIdx === 4;
}

function updateMonitorFocusStyles() {
  const isMonitorCard = activeTabIndex === 0 && navFocus === 'card';
  const ttFocused = isMonitorCard && activeWidgetIndex === 0;
  const tasksFocused = isMonitorCard && activeWidgetIndex === 1;

  timetableTable.style.border.fg = ttFocused ? COLOR_ORANGE : COLOR_STEEL_BLUE;
  if (timetableTable.rows && timetableTable.rows.style && timetableTable.rows.style.selected) {
    timetableTable.rows.style.selected.bg = ttFocused ? COLOR_ORANGE : COLOR_CHARCOAL;
    timetableTable.rows.style.selected.fg = ttFocused ? 'black' : 'white';
  }

  miniTasksTable.style.border.fg = tasksFocused ? COLOR_ORANGE : COLOR_STEEL_BLUE;
  if (miniTasksTable.rows && miniTasksTable.rows.style && miniTasksTable.rows.style.selected) {
    miniTasksTable.rows.style.selected.bg = tasksFocused ? COLOR_ORANGE : COLOR_CHARCOAL;
    miniTasksTable.rows.style.selected.fg = tasksFocused ? 'black' : 'white';
  }
}

function updateFooter() {
  if (activeModal === 'confirm_lunch') {
    footerBox.setContent(' {153-fg}[Enter / y]{/153-fg} {bold}Potvrdiť akciu{/bold}  {67-fg}│{/67-fg}  {153-fg}[Esc / n]{/153-fg} {244-fg}Zrušiť dialóg{/244-fg}');
    return;
  }
  if (activeModal === 'compose_message') {
    footerBox.setContent(' {153-fg}[↑/↓]{/153-fg} {244-fg}Učiteľ{/244-fg}  {67-fg}│{/67-fg}  {153-fg}[Enter]{/153-fg} {bold}Výber / Odoslať{/bold}  {67-fg}│{/67-fg}  {153-fg}[Tab]{/153-fg} {244-fg}Prepínať polia{/244-fg}  {67-fg}│{/67-fg}  {153-fg}[Esc]{/153-fg} {244-fg}Zrušiť{/244-fg}');
    return;
  }

  if (activeTabIndex === 3 && navFocus === 'card') {
    footerBox.setContent(
      ' {153-fg}[1-5]{/153-fg} {244-fg}Karty{/244-fg}  {67-fg}│{/67-fg}  {153-fg}[m / c]{/153-fg} {bold}{153-fg}+ Nová správa{/153-fg}{/bold}  {67-fg}│{/67-fg}  {153-fg}[↑/↓]{/153-fg} {244-fg}Pohyb{/244-fg}  {67-fg}│{/67-fg}  {153-fg}[←/→/Tab]{/153-fg} {244-fg}Panel{/244-fg}  {67-fg}│{/67-fg}  {153-fg}[Space]{/153-fg} {244-fg}Filter{/244-fg}  {67-fg}│{/67-fg}  {153-fg}[/]{/153-fg} {244-fg}Hľadať{/244-fg}  {67-fg}│{/67-fg}  {153-fg}[r]{/153-fg} {244-fg}Obnoviť{/244-fg}  {67-fg}│{/67-fg}  {153-fg}[q]{/153-fg} {244-fg}Koniec{/244-fg}'
    );
  } else if (activeTabIndex === 4 && navFocus === 'card') {
    if (lunchSubFocus === 'sidebar') {
      footerBox.setContent(
        ' {153-fg}[1-5]{/153-fg} {244-fg}Karty{/244-fg}  {67-fg}│{/67-fg}  {153-fg}[↑/↓]{/153-fg} {244-fg}Výber dňa{/244-fg}  {67-fg}│{/67-fg}  {153-fg}[→ / Tab]{/153-fg} {bold}{153-fg}Prejsť na obed{/153-fg}{/bold}  {67-fg}│{/67-fg}  {153-fg}[r]{/153-fg} {244-fg}Obnoviť{/244-fg}  {67-fg}│{/67-fg}  {153-fg}[q]{/153-fg} {244-fg}Koniec{/244-fg}'
      );
    } else if (lunchSubFocus === 'button') {
      footerBox.setContent(
        ' {153-fg}[Enter]{/153-fg} {bold}{196-fg}Odhlásiť / Prihlásiť obed{/196-fg}{/bold}  {67-fg}│{/67-fg}  {153-fg}[↓]{/153-fg} {244-fg}Hodnotiť jedlo{/244-fg}  {67-fg}│{/67-fg}  {153-fg}[←]{/153-fg} {244-fg}Dni{/244-fg}  {67-fg}│{/67-fg}  {153-fg}[q]{/153-fg} {244-fg}Koniec{/244-fg}'
      );
    } else {
      footerBox.setContent(
        ' {153-fg}[1-5]{/153-fg} {244-fg}Hviezdičky{/244-fg}  {67-fg}│{/67-fg}  {153-fg}[Tab]{/153-fg} {244-fg}Kvalita / Porcia{/244-fg}  {67-fg}│{/67-fg}  {153-fg}[Enter]{/153-fg} {bold}{153-fg}Odoslať hodnotenie{/153-fg}{/bold}  {67-fg}│{/67-fg}  {153-fg}[↑]{/153-fg} {244-fg}Tlačidlo{/244-fg}  {67-fg}│{/67-fg}  {153-fg}[←]{/153-fg} {244-fg}Dni{/244-fg}'
      );
    }
  } else {
    footerBox.setContent(
      ' {153-fg}[1-5]{/153-fg} {244-fg}Karty{/244-fg}  {67-fg}│{/67-fg}  {153-fg}[Šípky]{/153-fg} {244-fg}Pohyb{/244-fg}  {67-fg}│{/67-fg}  {153-fg}[Enter]{/153-fg} {244-fg}Výber{/244-fg}  {67-fg}│{/67-fg}  {153-fg}[r]{/153-fg} {244-fg}Obnoviť{/244-fg}  {67-fg}│{/67-fg}  {153-fg}[q]{/153-fg} {244-fg}Koniec{/244-fg}'
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
  } else if (activeTabIndex === 4) {
    lunchSubFocus = 'sidebar';
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
  } else if (activeTabIndex === 4) {
    renderLunchesCard();
    lunchesSidebar.focus();
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
    : '{153-fg}[ONLINE]{/153-fg}';

  const isTopFocused = navFocus === 'topbar';
  headerBox.style.border.fg = isTopFocused ? COLOR_ORANGE : COLOR_STEEL_BLUE;
  headerBox.setLabel(' [ EDUPAGE MONITOR - ' + school + ' ] ');

  const tabButtons = TAB_LABELS.map((label, idx) => {
    if (idx === activeTabIndex) {
      if (isTopFocused) {
        return `{208-bg}{black-fg}{bold}${label}{/bold}{/black-fg}{/208-bg}`;
      }
      return `{24-bg}{153-fg}{bold}${label}{/bold}{/153-fg}{/24-bg}`;
    }
    return `{244-fg}${label.trim()}{/244-fg}`;
  }).join('   ');

  headerBox.setContent(
    ` {110-fg}POUŽÍVATEĽ:{/110-fg} {white-fg}{bold}${user}{/bold}{/white-fg}  {67-fg}│{/67-fg}  {110-fg}PRIEMER:{/110-fg} {153-fg}{bold}${gpa}{/bold}{/153-fg}  {67-fg}│{/67-fg}  {110-fg}PROSPECH:{/110-fg} {250-fg}${standing}{/250-fg}  {67-fg}│{/67-fg}  {110-fg}ZVONENIE:{/110-fg} {117-fg}${nextBell}{/117-fg}  {67-fg}│{/67-fg}  {110-fg}ČAS:{/110-fg} {250-fg}${timeStr}{/250-fg}  ${statusBadge}\n` +
    ` {110-fg}KARTY:{/110-fg}  ${tabButtons}`
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

function padVisTagged(taggedText, width, align = 'left') {
  const plain = String(taggedText || '').replace(/\{[^}]+\}/g, '');
  const diff = Math.max(0, width - plain.length);
  if (align === 'center') {
    const left = Math.floor(diff / 2);
    return ' '.repeat(left) + taggedText + ' '.repeat(diff - left);
  }
  if (align === 'right') {
    return ' '.repeat(diff) + taggedText;
  }
  return taggedText + ' '.repeat(diff);
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
  timetableSidebar.style.border.fg = isFocused ? COLOR_ORANGE : COLOR_STEEL_BLUE;
  timetableSidebar.setLabel(' [ ROZVRH ] ');

  const weekMap = getWeekDataByVariant(ttVariant);
  const dayKeys = Object.keys(weekMap).sort();
  const { todayIdx, mode, currentLesson, nextLesson, bellPeriod, bellBreak, remMin } = live;

  const lines = [];

  // 1. Live Clock Status Banner (Soft Light Blue / Navy tint)
  lines.push(' {110-fg}AKTUÁLNE{/110-fg}');
  if (mode === 'LESSON' && currentLesson) {
    const roomStr = currentLesson.room && currentLesson.room !== '-' ? currentLesson.room : '-';
    const hdr = ` ● ${currentLesson.period}. HODINA: ${currentLesson.subject_short || currentLesson.subject}`;
    lines.push(` {24-bg}{153-fg}{bold}${padRawLine(hdr, 30)}{/bold}{/153-fg}{/24-bg}`);
    lines.push(` {white-fg}${fitPlain(currentLesson.subject, 30)}{/white-fg}`);
    lines.push(` {250-fg}${currentLesson.time} (${remMin} min) · ${fitPlain(roomStr, 12)}{/250-fg}`);
  } else if (mode === 'BREAK' && nextLesson) {
    const durBreak = bellBreak ? `${bellBreak.duration_min} min` : '';
    const bTitle = bellBreak ? `${bellBreak.after_period}.➔${bellBreak.before_period}.` : 'PRESTÁVKA';
    const hdr = ` ● PRESTÁVKA ${bTitle}${durBreak ? ' (' + durBreak + ')' : ''}`;
    lines.push(` {24-bg}{153-fg}{bold}${padRawLine(hdr, 30)}{/bold}{/153-fg}{/24-bg}`);
    lines.push(` {250-fg}Ďalej: ${fitPlain(nextLesson.subject, 22)}{/250-fg}`);
    lines.push(` {244-fg}O ${nextLesson.start || '-'} (za ${remMin} min){/244-fg}`);
  } else if (bellPeriod) {
    const hdr = ` ● ${bellPeriod.period}. HODINA (${bellPeriod.start}-${bellPeriod.end})`;
    lines.push(` {24-bg}{153-fg}{bold}${padRawLine(hdr, 30)}{/bold}{/153-fg}{/24-bg}`);
    lines.push(' {244-fg}Voľná hodina{/244-fg}');
  } else if (bellBreak) {
    const hdr = ` ● PRESTÁVKA ${bellBreak.between}`;
    lines.push(` {24-bg}{153-fg}{bold}${padRawLine(hdr, 30)}{/bold}{/153-fg}{/24-bg}`);
    lines.push(` {250-fg}${bellBreak.name} (${bellBreak.duration_min} min){/250-fg}`);
  } else if (mode === 'BEFORE' && nextLesson) {
    lines.push(' {153-fg}{bold}● PRED VYUČOVANÍM{/bold}{/153-fg}');
    lines.push(` {244-fg}1. hod o ${nextLesson.start || '-'} (za ${remMin} min){/244-fg}`);
  } else {
    lines.push(' {244-fg}● MIMO VYUČOVANIA{/244-fg}');
  }

  lines.push('{67-fg}────────────────────────────────{/67-fg}');
  lines.push(' {110-fg}ZOBRAZENIE{/110-fg}');

  // 2. Interactive Sidebar Menu Items (Orange ONLY on controlled item)
  SIDEBAR_ITEMS.forEach((item, idx) => {
    const cursorHere = isFocused && sidebarCursor === idx;
    const isDay = typeof item.dayIdx === 'number';
    const isToday = isDay && item.dayIdx === todayIdx;

    if (idx === 6) {
      lines.push('{67-fg}────────────────────────────────{/67-fg}');
      lines.push(' {110-fg}REŽIM ROZVRHU{/110-fg}');
    }
    if (idx === 7) {
      lines.push('{67-fg}────────────────────────────────{/67-fg}');
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
      lines.push(`{153-fg}{bold}${padRawLine(formattedLine, 32)}{/bold}{/153-fg}`);
    } else if (isToday) {
      lines.push(`{117-fg}${padRawLine(formattedLine, 32)}{/117-fg}`);
    } else {
      lines.push(`{244-fg}${padRawLine(formattedLine, 32)}{/244-fg}`);
    }
  });

  // 3. Live Compact Bell Timeline (Light Blue / Navy Accent)
  lines.push('{67-fg}────────────────────────────────{/67-fg}');
  lines.push(' {110-fg}DNES ZVONENIA{/110-fg}');
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
      lines.push(` {24-bg}{117-fg}{bold}${padRawLine('▸ ' + pLine + ' [TERAZ]', 30)}{/bold}{/117-fg}{/24-bg}`);
    } else {
      const col = les ? '250-fg' : '244-fg';
      lines.push(` {${col}}  ${fitPlain(pLine, 28)}{/${col}}`);
    }

    const br = breaks[idx];
    if (br) {
      const isNowBreak = bellBreak && bellBreak.id === br.id;
      if (isNowBreak) {
        const bText = `▸ PREST. ${br.start}-${br.end} (${br.duration_min}m)`;
        lines.push(` {24-bg}{117-fg}{bold}${padRawLine(bText, 30)}{/bold}{/117-fg}{/24-bg}`);
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
    ? '{153-fg}{bold}AKTUÁLNY ROZVRH{/bold}{/153-fg}'
    : '{250-fg}{bold}STACIONÁRNY ROZVRH{/bold}{/250-fg}';

  const liveNote = bellBreak
    ? `{110-fg}Prestávka ${bellBreak.between} (${bellBreak.start}-${bellBreak.end}){/110-fg}`
    : (bellPeriod
      ? `{117-fg}${bellPeriod.period}. hodina (${bellPeriod.start}-${bellPeriod.end}){/117-fg}`
      : '{244-fg}Mimo vyučovania{/244-fg}');

  const out = [];
  out.push(` ${variantBanner}   {67-fg}│{/67-fg}   ${liveNote}`);

  const hLine = (left, mid, right, fill = '─') => {
    const segs = [fill.repeat(dayColW)];
    for (let i = 0; i < 8; i++) segs.push(fill.repeat(colW));
    return left + segs.join(mid) + right;
  };

  // Header row (Period number + time)
  out.push(`{67-fg}${hLine('┌', '┬', '┐')}{/67-fg}`);
  let hdr1 = '{67-fg}│{/67-fg}' + `{bold}{110-fg}${padVis('DEŇ', dayColW, 'center')}{/110-fg}{/bold}`;
  let hdr2 = '{67-fg}│{/67-fg}' + ' '.repeat(dayColW);

  periods.forEach((p) => {
    const isNowP = bellPeriod && String(bellPeriod.period) === String(p.period);
    const pLabel = compactMode ? `${p.period}. HOD` : `${p.period}. HODINA`;
    const tLabel = compactMode ? `${p.start.replace(/^0/, '')}-${p.end.replace(/^0/, '')}` : `${p.start}-${p.end}`;
    const hdrTag = isNowP ? '{24-bg}{117-fg}{bold}' : '{153-fg}{bold}';
    const timeTag = isNowP ? '{24-bg}{153-fg}' : '{244-fg}';
    hdr1 += '{67-fg}│{/67-fg}' + `${hdrTag}${padVis(pLabel, colW, 'center')}{/}`;
    hdr2 += '{67-fg}│{/67-fg}' + `${timeTag}${padVis(tLabel, colW, 'center')}{/}`;
  });
  hdr1 += '{67-fg}│{/67-fg}';
  hdr2 += '{67-fg}│{/67-fg}';
  out.push(hdr1);
  out.push(hdr2);
  out.push(`{67-fg}${hLine('├', '┼', '┤')}{/67-fg}`);

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

    // Day column (Light-Blue / Slate / Gray)
    const dayTagStart = isToday ? '{24-bg}{117-fg}{bold}' : '{110-fg}{bold}';
    rowLines[0] = `{67-fg}│{/67-fg}${dayTagStart}${padVis(dayName.toUpperCase(), dayColW, 'center')}{/}`;
    rowLines[1] = `{67-fg}│{/67-fg}${isToday ? '{24-bg}{153-fg}{bold}' : '{244-fg}'}${padVis(isToday ? '[DNES]' : dateShort, dayColW, 'center')}{/}`;
    if (lineCount >= 3) rowLines[2] = `{67-fg}│{/67-fg}${isToday && dateShort ? '{244-fg}' + padVis(dateShort, dayColW, 'center') + '{/}' : ' '.repeat(dayColW)}`;
    if (lineCount >= 4) rowLines[3] = `{67-fg}│{/67-fg}${' '.repeat(dayColW)}`;

    // 8 Period cells
    for (let pNum = 1; pNum <= 8; pNum++) {
      const les = lessons.find((l) => String(l.period) === String(pNum));
      const pDef = periods[pNum - 1];
      const isNowCell = isToday && bellPeriod && String(bellPeriod.period) === String(pNum);
      const isNextAfterBreak = isToday && bellBreak && String(bellBreak.before_period) === String(pNum);

      const sep = '{67-fg}│{/67-fg}';

      if (!les) {
        rowLines[0] += sep + (isNowCell ? `{24-bg}{117-fg}${padVis('VOĽNO', colW, 'center')}{/}` : ' '.repeat(colW));
        rowLines[1] += sep + `{240-fg}${padVis('·', colW, 'center')}{/240-fg}`;
        if (lineCount >= 3) rowLines[2] += sep + ' '.repeat(colW);
        if (lineCount >= 4) rowLines[3] += sep + ' '.repeat(colW);
        continue;
      }

      // Line 1: Skratka + Status Tag
      let sTitle = les.subject_short || fitPlain(les.subject, 5).toUpperCase();
      let titleTagStart = '{153-fg}{bold}';
      let titleTagEnd = '{/bold}{/153-fg}';
      if (isNowCell && !les.is_cancelled) {
        sTitle = `▸ ${sTitle} ◂`;
        titleTagStart = '{24-bg}{117-fg}{bold}';
        titleTagEnd = '{/bold}{/117-fg}{/24-bg}';
      } else if (les.is_cancelled) {
        sTitle = `${sTitle} [ODP]`;
        titleTagStart = '{240-fg}';
        titleTagEnd = '{/240-fg}';
      } else if (les.is_changed) {
        sTitle = `${sTitle} [ZMN]`;
        titleTagStart = '{117-fg}{bold}';
        titleTagEnd = '{/bold}{/117-fg}';
      } else if (les.is_event) {
        sTitle = `${sTitle} [UDL]`;
        titleTagStart = '{110-fg}{bold}';
        titleTagEnd = '{/bold}{/110-fg}';
      } else if (isNextAfterBreak && mode === 'BREAK') {
        sTitle = `> ${sTitle}`;
        titleTagStart = '{117-fg}{bold}';
        titleTagEnd = '{/bold}{/117-fg}';
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

    rowLines.forEach((ln) => out.push(ln + '{67-fg}│{/67-fg}'));
    out.push(`{67-fg}${dIdx < 4 ? hLine('├', '┼', '┤') : hLine('└', '┴', '┘')}{/67-fg}`);
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
    ? '{153-fg}AKTUÁLNY{/153-fg}'
    : '{250-fg}STACIONÁRNY{/250-fg}';

  const lines = [];
  lines.push(` {bold}{153-fg}${dayName.toUpperCase()} ${dateStr}{/153-fg}${isToday ? ' {24-bg}{117-fg} DNES {/}' : ''}{/bold}   {67-fg}│{/67-fg}   {110-fg}Režim:{/110-fg} ${variantBanner}`);
  lines.push(`{67-fg}${borderLine('┌', '┬', '┐')}{/67-fg}`);
  lines.push(
    '{67-fg}│{/67-fg}' +
    `{bold}{110-fg}${padVis('HOD', wH, 'center')}{/bold}{/110-fg}{67-fg}│{/67-fg}` +
    `{bold}{110-fg}${padVis('ČAS', wTime, 'center')}{/bold}{/110-fg}{67-fg}│{/67-fg}` +
    `{bold}{110-fg}${padVis('SKR.', wShort, 'center')}{/bold}{/110-fg}{67-fg}│{/67-fg}` +
    `{bold}{110-fg}${padVis('PREDMET', wSubj)}{/bold}{/110-fg}{67-fg}│{/67-fg}` +
    `{bold}{110-fg}${padVis('TRIEDA', wCls)}{/bold}{/110-fg}{67-fg}│{/67-fg}` +
    `{bold}{110-fg}${padVis('UČEBŇA', wRoom)}{/bold}{/110-fg}{67-fg}│{/67-fg}` +
    `{bold}{110-fg}${padVis('UČITEĽ', wTeach)}{/bold}{/110-fg}{67-fg}│{/67-fg}` +
    `{bold}{110-fg}${padVis('STAV', wStat, 'center')}{/bold}{/110-fg}{67-fg}│{/67-fg}`
  );
  lines.push(`{67-fg}${borderLine('├', '┼', '┤')}{/67-fg}`);

  periods.forEach((p, idx) => {
    const les = lessons.find((l) => String(l.period) === String(p.period));
    const isNow = isToday && live.bellPeriod && String(live.bellPeriod.period) === String(p.period);

    if (!les) {
      const rowColor = isNow ? '{24-bg}{117-fg}{bold}' : '{244-fg}';
      lines.push(
        '{67-fg}│{/67-fg}' +
        `${rowColor}${padVis(p.period + '.', wH, 'center')}{/}{67-fg}│{/67-fg}` +
        `${rowColor}${padVis(`${p.start}-${p.end}`, wTime, 'center')}{/}{67-fg}│{/67-fg}` +
        `${rowColor}${padVis('-', wShort, 'center')}{/}{67-fg}│{/67-fg}` +
        `${rowColor}${padVis('Voľná hodina', wSubj)}{/}{67-fg}│{/67-fg}` +
        `${rowColor}${padVis('-', wCls)}{/}{67-fg}│{/67-fg}` +
        `${rowColor}${padVis('-', wRoom)}{/}{67-fg}│{/67-fg}` +
        `${rowColor}${padVis('-', wTeach)}{/}{67-fg}│{/67-fg}` +
        `${rowColor}${padVis(isNow ? 'TERAZ VOĽNO' : 'VOĽNO', wStat, 'center')}{/}{67-fg}│{/67-fg}`
      );
    } else {
      const clsGrp = les.group ? `${les.class_name} (${les.group})` : (les.class_name || '-');
      let stText = les.status || 'PLÁN';
      let fgCol = '153-fg';
      if (isNow && !les.is_cancelled) {
        stText = `TERAZ (${live.pct}%)`;
        fgCol = '117-fg';
      } else if (les.is_cancelled) {
        stText = 'ODPADLA';
        fgCol = '240-fg';
      } else if (les.is_changed) {
        stText = 'ZMENA';
        fgCol = '117-fg';
      } else if (les.is_event) {
        stText = 'UDALOSŤ';
        fgCol = '110-fg';
      }

      const rowPrefix = isNow && !les.is_cancelled ? '{24-bg}{117-fg}{bold}' : `{${fgCol}}`;
      const rowEnd = '{/}';
      lines.push(
        '{67-fg}│{/67-fg}' +
        `${rowPrefix}${padVis(p.period + '.', wH, 'center')}${rowEnd}{67-fg}│{/67-fg}` +
        `${rowPrefix}${padVis(les.time || `${p.start}-${p.end}`, wTime, 'center')}${rowEnd}{67-fg}│{/67-fg}` +
        `${rowPrefix}${padVis(les.subject_short || '-', wShort, 'center')}${rowEnd}{67-fg}│{/67-fg}` +
        `${rowPrefix}${padVis(les.subject || '-', wSubj)}${rowEnd}{67-fg}│{/67-fg}` +
        `${rowPrefix}${padVis(clsGrp, wCls)}${rowEnd}{67-fg}│{/67-fg}` +
        `${rowPrefix}${padVis(les.room || '-', wRoom)}${rowEnd}{67-fg}│{/67-fg}` +
        `${rowPrefix}${padVis(les.teacher || '-', wTeach)}${rowEnd}{67-fg}│{/67-fg}` +
        `${rowPrefix}${padVis(stText, wStat, 'center')}${rowEnd}{67-fg}│{/67-fg}`
      );
    }

    const br = breaks[idx];
    if (br) {
      const isNowBreak = isToday && live.bellBreak && live.bellBreak.id === br.id;
      const brSummary = `   · Prestávka ${br.between}: ${br.start} - ${br.end} (${br.duration_min} min · ${br.name}) ${isNowBreak ? '◀ PREBIEHA' : ''}`;
      const brTag = isNowBreak ? '{24-bg}{117-fg}{bold}' : '{244-fg}';
      lines.push(`{67-fg}│{/67-fg}${brTag}${padVis(brSummary, innerW)}{/}{67-fg}│{/67-fg}`);
    }
  });

  lines.push(`{67-fg}${borderLine('└', '┴', '┘')}{/67-fg}`);

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
  lines.push(`{67-fg}${hLine('┌', '┬', '┐')}{/67-fg}`);
  lines.push(
    '{67-fg}│{/67-fg}' +
    `{bold}{110-fg}${padVis('#', wId, 'center')}{/bold}{/110-fg}{67-fg}│{/67-fg}` +
    `{bold}{110-fg}${padVis('MEDZI HODINAMI', wBetw, 'center')}{/bold}{/110-fg}{67-fg}│{/67-fg}` +
    `{bold}{110-fg}${padVis('ČAS', wTime, 'center')}{/bold}{/110-fg}{67-fg}│{/67-fg}` +
    `{bold}{110-fg}${padVis('TRVANIE', wDur, 'center')}{/bold}{/110-fg}{67-fg}│{/67-fg}` +
    `{bold}{110-fg}${padVis('NÁZOV', wType)}{/bold}{/110-fg}{67-fg}│{/67-fg}`
  );
  lines.push(`{67-fg}${hLine('├', '┼', '┤')}{/67-fg}`);

  breaks.forEach((b, i) => {
    const isNowBreak = live.bellBreak && live.bellBreak.id === b.id;
    const wrapStart = isNowBreak ? '{24-bg}{117-fg}{bold}' : '{153-fg}';
    const mutedStart = isNowBreak ? '{24-bg}{117-fg}{bold}' : '{250-fg}';
    const wrapEnd = '{/}';
    const typeLabel = isNowBreak ? `${b.name}  [PRÁVE PREBIEHA]` : b.name;

    lines.push(
      '{67-fg}│{/67-fg}' +
      `${mutedStart}${padVis(`${i + 1}.`, wId, 'center')}${wrapEnd}{67-fg}│{/67-fg}` +
      `${wrapStart}${padVis(b.between, wBetw, 'center')}${wrapEnd}{67-fg}│{/67-fg}` +
      `${mutedStart}${padVis(`${b.start} - ${b.end}`, wTime, 'center')}${wrapEnd}{67-fg}│{/67-fg}` +
      `${wrapStart}{bold}${padVis(`${b.duration_min} min`, wDur, 'center')}{/bold}${wrapEnd}{67-fg}│{/67-fg}` +
      `${mutedStart}${padVis(typeLabel, wType)}${wrapEnd}{67-fg}│{/67-fg}`
    );
  });

  lines.push(`{67-fg}${hLine('└', '┴', '┘')}{/67-fg}`);

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
  if (val === null || val === undefined || val === '-' || val === '') return '244-fg';
  const n = parseFloat(String(val).replace(',', '.'));
  if (!isNaN(n)) {
    if (n <= 1.50) return 'green-fg';
    if (n <= 2.20) return 'cyan-fg';
    if (n <= 2.80) return 'yellow-fg';
    if (n <= 3.50) return 'magenta-fg';
    return 'red-fg';
  }
  const s = String(val).trim();
  if (s.endsWith('%')) {
    const pct = parseFloat(s);
    if (!isNaN(pct)) {
      if (pct >= 90) return 'green-fg';
      if (pct >= 75) return 'cyan-fg';
      if (pct >= 60) return 'yellow-fg';
      if (pct >= 50) return 'magenta-fg';
      return 'red-fg';
    }
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
  gradesSidebar.style.border.fg = isFocused ? COLOR_ORANGE : COLOR_STEEL_BLUE;
  gradesSidebar.setLabel(' [ ZNÁMKY ] ');

  const items = getGradesSidebarItems();
  if (gradesCursor >= items.length) gradesCursor = Math.max(0, items.length - 1);

  const gpa = dashboardData.gpa || '-';
  const gpaCol = getGradeColorTag(gpa);
  const standing = dashboardData.standing || '-';
  const totalMarks = dashboardData.total_marks || 0;
  const subjCount = (dashboardData.subjects || []).length;

  const lines = [];
  lines.push(' {110-fg}SÚHRN{/110-fg}');
  lines.push(` {24-bg}{bold}{${gpaCol}}${padRawLine(` ● PRIEMER: ${gpa}`, 30)}{/${gpaCol}}{/bold}{/24-bg}`);
  lines.push(` {250-fg}${fitPlain(standing, 30)}{/250-fg}`);
  lines.push(` {244-fg}Známok: ${totalMarks}  ·  Predmetov: ${subjCount}{/244-fg}`);
  lines.push('{67-fg}────────────────────────────────{/67-fg}');
  lines.push(' {110-fg}ZOBRAZENIE{/110-fg}');

  // Render fixed top 2 items (OVERVIEW and COMMENDATIONS)
  for (let idx = 0; idx < Math.min(2, items.length); idx++) {
    const it = items[idx];
    const cursorHere = isFocused && gradesCursor === idx;
    const active = gradesCursor === idx;
    const text = `${active ? ' ▸ ' : '   '}${it.label}`;
    if (cursorHere) {
      lines.push(`{208-bg}{black-fg}{bold}${padRawLine(text, 32)}{/bold}{/black-fg}{/208-bg}`);
    } else if (active) {
      lines.push(`{153-fg}{bold}${padRawLine(text, 32)}{/bold}{/153-fg}`);
    } else {
      lines.push(`{244-fg}${padRawLine(text, 32)}{/244-fg}`);
    }
  }

  lines.push('{67-fg}────────────────────────────────{/67-fg}');
  lines.push(` {110-fg}PREDMETY (${subjCount}){/110-fg}`);

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
    lines.push(` {244-fg}  ▲ (${startIdx}){/244-fg}`);
  }

  for (let sIdx = startIdx; sIdx < endIdx; sIdx++) {
    const globalIdx = sIdx + 2;
    const it = subjItems[sIdx];
    const cursorHere = isFocused && gradesCursor === globalIdx;
    const active = gradesCursor === globalIdx;
    const s = it.subject;
    const avgCol = getGradeColorTag(s.avg);
    const branch = sIdx === subjItems.length - 1 ? '└─' : '├─';
    const rawLine = `${active ? '▸' : ' '} ${branch} ${it.label}`;

    if (cursorHere) {
      lines.push(`{208-bg}{black-fg}{bold}${padRawLine(' ' + rawLine, 32)}{/bold}{/black-fg}{/208-bg}`);
    } else if (active) {
      lines.push(`{153-fg}{bold}${padRawLine(' ' + rawLine, 32)}{/bold}{/153-fg}`);
    } else {
      lines.push(`{67-fg}   ${branch}{/67-fg} {bold}{white-fg}${(s.short || s.name || '-').padEnd(4, ' ')}{/white-fg}{/bold} {244-fg}${fitPlain(s.full_name || s.name, 13).padEnd(13, ' ')}{/244-fg} {bold}{${avgCol}}[${(s.avg || '-').padStart(4, ' ')}]{/${avgCol}}{/bold}`);
    }
  }

  if (endIdx < subjItems.length) {
    lines.push(` {244-fg}  ▼ (${subjItems.length - endIdx}){/244-fg}`);
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
      let cellStr = '  ·  ';
      if (closestLvl === lvl) {
        const ptCol = getGradeColorTag(val);
        cellStr = `{${ptCol}}{bold}●${val.toFixed(2)}{/bold}{/${ptCol}}`;
      } else if (val <= lvl) {
        cellStr = '  │  ';
      }
      rowChars += padVisTagged(cellStr, colStep, 'center');
    }
    const labelStr = ` ${lvl.toFixed(1)} ┤`;
    chartRows.push(`{244-fg}${labelStr}{/244-fg}${padVisTagged(rowChars, leftW - 6)}`);
  });

  let xAxisBody = '';
  for (let i = 0; i < plotCount; i++) {
    xAxisBody += padVis(tx[i] || '', colStep, 'center');
  }
  chartRows.push(`{244-fg}${padRawLine('     └' + xAxisBody, leftW)}{/244-fg}`);

  // Build 6 lines for Right Grade Distribution
  const distRows = [];
  const barMaxW = Math.max(8, rightW - 31);
  const distColors = ['green-fg', 'cyan-fg', 'yellow-fg', 'magenta-fg', 'red-fg'];
  for (let i = 0; i < 5; i++) {
    const cnt = distData[i] || 0;
    const pct = totalClassified > 0 ? ((cnt / totalClassified) * 100).toFixed(1) : '0.0';
    const bLen = Math.round((cnt / maxDist) * barMaxW);
    const bar = (bLen > 0 ? '█'.repeat(bLen) : '·').padEnd(barMaxW, ' ');
    const linePlain = ` ${i + 1} ${distLabels[i].padEnd(12, ' ')} `;
    const rightStats = ` ${String(cnt).padStart(2, ' ')}x (${pct.padStart(5, ' ')}%)`;
    const padRem = Math.max(0, rightW - (linePlain.length + bar.length + rightStats.length));
    const dColor = distColors[i];
    distRows.push(
      `{250-fg}${linePlain}{/250-fg}{${dColor}}{bold}${bar}{/bold}{/${dColor}}{244-fg}${rightStats}{/244-fg}${' '.repeat(padRem)}`
    );
  }
  const passCount = distData[0] + distData[1] + distData[2] + distData[3];
  const passRate = totalClassified > 0 ? ((passCount / totalClassified) * 100).toFixed(1) : '0.0';
  const gpaOverall = dashboardData.gpa || '-';
  const gpaOverallCol = getGradeColorTag(gpaOverall);
  const summaryTxt = ` Spolu: ${totalClassified}   │   Priemer: {bold}{${gpaOverallCol}}${gpaOverall}{/${gpaOverallCol}}{/bold}   │   Úspešnosť: ${passRate}%`;
  distRows.push(`{110-fg}${padRawLine(summaryTxt, rightW)}{/110-fg}`);

  const out = [];
  out.push(`{67-fg}${topLine}{/67-fg}`);
  out.push(
    `{67-fg}│{/67-fg}{bold}{153-fg}${padRawLine(' VÝVOJ PRIEMERU', leftW)}{/153-fg}{/bold}` +
    `{67-fg}│{/67-fg}{bold}{153-fg}${padRawLine(' DISTRIBÚCIA ZNÁMOK (1 - 5)', rightW)}{/153-fg}{/bold}{67-fg}│{/67-fg}`
  );
  out.push(`{67-fg}${midLine}{/67-fg}`);
  for (let r = 0; r < 6; r++) {
    out.push(`{67-fg}│{/67-fg}${chartRows[r]}{67-fg}│{/67-fg}${distRows[r]}{67-fg}│{/67-fg}`);
  }
  out.push(`{67-fg}${botLine}{/67-fg}`);

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

  out.push(`{67-fg}${tLine('┌', '┬', '┐')}{/67-fg}`);
  out.push(
    '{67-fg}│{/67-fg}' +
    `{bold}{110-fg}${padVis('SKR.', wShort, 'center')}{/bold}{/110-fg}{67-fg}│{/67-fg}` +
    `{bold}{110-fg}${padVis('PREDMET', wSubj)}{/bold}{/110-fg}{67-fg}│{/67-fg}` +
    `{bold}{110-fg}${padVis('ZNÁMKY', wMarks)}{/bold}{/110-fg}{67-fg}│{/67-fg}` +
    `{bold}{110-fg}${padVis('POČ.', wCnt, 'center')}{/bold}{/110-fg}{67-fg}│{/67-fg}` +
    `{bold}{110-fg}${padVis('%', wPct, 'center')}{/bold}{/110-fg}{67-fg}│{/67-fg}` +
    `{bold}{110-fg}${padVis('PRIEMER', wAvg, 'center')}{/bold}{/110-fg}{67-fg}│{/67-fg}` +
    `{bold}{110-fg}${padVis('VYS.', wFin, 'center')}{/bold}{/110-fg}{67-fg}│{/67-fg}` +
    `{bold}{110-fg}${padVis('HODNOTENIE', wVerb, 'center')}{/bold}{/110-fg}{67-fg}│{/67-fg}`
  );
  out.push(`{67-fg}${tLine('├', '┼', '┤')}{/67-fg}`);

  subjs.forEach((s) => {
    const avgCol = getGradeColorTag(s.avg);
    const finCol = getGradeColorTag(s.final_grade);
    const marksPreviewList = s.marks_preview || [];
    let marksTagged = '{244-fg}-{/244-fg}';
    if (marksPreviewList.length > 0) {
      const parts = [];
      let curLen = 0;
      for (const m of marksPreviewList) {
        const mStr = String(m);
        if (curLen + mStr.length + 2 > wMarks) break;
        const col = getGradeColorTag(m);
        parts.push(`{${col}}{bold}${mStr}{/bold}{/${col}}`);
        curLen += mStr.length + 2;
      }
      marksTagged = parts.join('{240-fg}, {/240-fg}');
    }

    out.push(
      '{67-fg}│{/67-fg}' +
      `{bold}{white-fg}${padVis(s.short || s.name, wShort, 'center')}{/white-fg}{/bold}{67-fg}│{/67-fg}` +
      `{250-fg}${padVis(s.full_name || s.name, wSubj)}{/250-fg}{67-fg}│{/67-fg}` +
      `${padVisTagged(marksTagged, wMarks)}{67-fg}│{/67-fg}` +
      `{244-fg}${padVis(String(s.count || 0), wCnt, 'center')}{/244-fg}{67-fg}│{/67-fg}` +
      `{244-fg}${padVis(s.percent || '-', wPct, 'center')}{/244-fg}{67-fg}│{/67-fg}` +
      `{bold}{${avgCol}}${padVis(s.avg || '-', wAvg, 'center')}{/${avgCol}}{/bold}{67-fg}│{/67-fg}` +
      `{bold}{${finCol}}${padVis(s.final_grade || '-', wFin, 'center')}{/${finCol}}{/bold}{67-fg}│{/67-fg}` +
      `{bold}{${finCol}}${padVis(s.verbal || '-', wVerb, 'center')}{/${finCol}}{/bold}{67-fg}│{/67-fg}`
    );
  });

  out.push(`{67-fg}${tLine('└', '┴', '┘')}{/67-fg}`);

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
    ` {bold}{153-fg}POCHVALY A POZNÁMKY{/153-fg}{/bold}   {67-fg}│{/67-fg}   ` +
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

  out.push(`{67-fg}${cLine('┌', '┬', '┐')}{/67-fg}`);
  out.push(
    '{67-fg}│{/67-fg}' +
    `{bold}{110-fg}${padVis('#', wNum, 'center')}{/bold}{/110-fg}{67-fg}│{/67-fg}` +
    `{bold}{110-fg}${padVis('DÁTUM', wDate, 'center')}{/bold}{/110-fg}{67-fg}│{/67-fg}` +
    `{bold}{110-fg}${padVis('DRUH', wCat, 'center')}{/bold}{/110-fg}{67-fg}│{/67-fg}` +
    `{bold}{110-fg}${padVis('PREDMET', wSubj)}{/bold}{/110-fg}{67-fg}│{/67-fg}` +
    `{bold}{110-fg}${padVis('UČITEĽ', wTeach)}{/bold}{/110-fg}{67-fg}│{/67-fg}` +
    `{bold}{110-fg}${padVis('STAV', wState, 'center')}{/bold}{/110-fg}{67-fg}│{/67-fg}` +
    `{bold}{110-fg}${padVis('TEXT', wText)}{/bold}{/110-fg}{67-fg}│{/67-fg}`
  );
  out.push(`{67-fg}${cLine('├', '┼', '┤')}{/67-fg}`);

  if (comms.length === 0) {
    out.push(
      '{67-fg}│{/67-fg}' +
      `{244-fg}${padVis('-', wNum, 'center')}{/244-fg}{67-fg}│{/67-fg}` +
      `{244-fg}${padVis('-', wDate, 'center')}{/244-fg}{67-fg}│{/67-fg}` +
      `{244-fg}${padVis('-', wCat, 'center')}{/244-fg}{67-fg}│{/67-fg}` +
      `{244-fg}${padVis('Správanie', wSubj)}{/244-fg}{67-fg}│{/67-fg}` +
      `{244-fg}${padVis('-', wTeach)}{/244-fg}{67-fg}│{/67-fg}` +
      `{244-fg}${padVis('-', wState, 'center')}{/244-fg}{67-fg}│{/67-fg}` +
      `{244-fg}${padVis('Žiadne záznamy.', wText)}{/244-fg}{67-fg}│{/67-fg}`
    );
  } else {
    comms.forEach((c, idx) => {
      out.push(
        '{67-fg}│{/67-fg}' +
        `{244-fg}${padVis(`${idx + 1}.`, wNum, 'center')}{/244-fg}{67-fg}│{/67-fg}` +
        `{250-fg}${padVis(c.date || '-', wDate, 'center')}{/250-fg}{67-fg}│{/67-fg}` +
        `{bold}{153-fg}${padVis(c.category || 'ZÁZNAM', wCat, 'center')}{/153-fg}{/bold}{67-fg}│{/67-fg}` +
        `{250-fg}${padVis(c.subject || 'Správanie', wSubj)}{/250-fg}{67-fg}│{/67-fg}` +
        `{250-fg}${padVis(c.teacher || '-', wTeach)}{/250-fg}{67-fg}│{/67-fg}` +
        `{244-fg}${padVis(c.state || '-', wState, 'center')}{/244-fg}{67-fg}│{/67-fg}` +
        `{white-fg}${padVis(c.text || '-', wText)}{/white-fg}{67-fg}│{/67-fg}`
      );
    });
  }
  out.push(`{67-fg}${cLine('└', '┴', '┘')}{/67-fg}`);
  out.push('');

  // Second Table: Recent Grades Overview with Teachers & Details
  out.push(' {bold}{153-fg}KOMENTÁRE K ZNÁMKAM{/153-fg}{/bold}');
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

  out.push(`{67-fg}${gLine('┌', '┬', '┐')}{/67-fg}`);
  out.push(
    '{67-fg}│{/67-fg}' +
    `{bold}{110-fg}${padVis('DÁTUM', gwDate, 'center')}{/bold}{/110-fg}{67-fg}│{/67-fg}` +
    `{bold}{110-fg}${padVis('PREDM.', gwSubj, 'center')}{/bold}{/110-fg}{67-fg}│{/67-fg}` +
    `{bold}{110-fg}${padVis('ZNÁMKA', gwGrd, 'center')}{/bold}{/110-fg}{67-fg}│{/67-fg}` +
    `{bold}{110-fg}${padVis('VÁHA', gwWgt, 'center')}{/bold}{/110-fg}{67-fg}│{/67-fg}` +
    `{bold}{110-fg}${padVis('UDALOSŤ', gwTitle)}{/bold}{/110-fg}{67-fg}│{/67-fg}` +
    `{bold}{110-fg}${padVis('VYUČUJÚCI / POZNÁMKA', gwNote)}{/bold}{/110-fg}{67-fg}│{/67-fg}`
  );
  out.push(`{67-fg}${gLine('├', '┼', '┤')}{/67-fg}`);

  listToRender.forEach((g) => {
    const noteOrTeacher = g.note
      ? `${g.teacher && g.teacher !== '-' ? g.teacher + ' · ' : ''}${g.note}`
      : (g.teacher && g.teacher !== '-' ? g.teacher : (g.comment || '-'));
    out.push(
      '{67-fg}│{/67-fg}' +
      `{244-fg}${padVis(g.date || '-', gwDate, 'center')}{/244-fg}{67-fg}│{/67-fg}` +
      `{bold}{white-fg}${padVis(g.subject || '-', gwSubj, 'center')}{/white-fg}{/bold}{67-fg}│{/67-fg}` +
      `{bold}{117-fg}${padVis(g.grade || '-', gwGrd, 'center')}{/117-fg}{/bold}{67-fg}│{/67-fg}` +
      `{244-fg}${padVis(g.weight || '1', gwWgt, 'center')}{/244-fg}{67-fg}│{/67-fg}` +
      `{250-fg}${padVis(g.title || '-', gwTitle)}{/250-fg}{67-fg}│{/67-fg}` +
      `{244-fg}${padVis(noteOrTeacher, gwNote)}{/244-fg}{67-fg}│{/67-fg}`
    );
  });
  out.push(`{67-fg}${gLine('└', '┴', '┘')}{/67-fg}`);

  gradesMainBox.setLabel(' [ POCHVALY A POZNÁMKY ] ');
  gradesMainBox.setContent(out.join('\n'));
}

function renderSubjectDetailView(subj) {
  const boxWidth = gradesMainBox.width && gradesMainBox.width > 40 ? gradesMainBox.width : Math.max(80, screen.width - SIDEBAR_WIDTH);
  const innerW = Math.max(82, boxWidth - 4);

  const avgCol = getGradeColorTag(subj.avg);
  const finCol = getGradeColorTag(subj.final_grade);
  const sDist = subj.distribution || [0, 0, 0, 0, 0];
  const gRows = subj.grades || [];

  const out = [];

  // 1. Top Framed Subject Card
  out.push(`{67-fg}┌${'─'.repeat(innerW)}┐{/67-fg}`);
  const titleLine = ` ${(subj.short || subj.name || '-')} — ${subj.full_name || subj.name || '-'}   │   VYUČUJÚCI: ${subj.teacher || '-'}`;
  out.push(`{67-fg}│{/67-fg}{24-bg}{153-fg}{bold}${padRawLine(titleLine, innerW)}{/bold}{/153-fg}{/24-bg}{67-fg}│{/67-fg}`);
  out.push(`{67-fg}├${'─'.repeat(innerW)}┤{/67-fg}`);

  const statsLine = ` PRIEMER: {bold}{${avgCol}}${subj.avg || '-'}{/${avgCol}}{/bold}   │   PERCENTÁ: {bold}{${getGradeColorTag(subj.percent)}}${subj.percent || '-'}{/${getGradeColorTag(subj.percent)}}{/bold}   │   VYSVEDČENIE: {bold}{${finCol}}${subj.final_grade || '-'} (${subj.verbal || '-'}){/${finCol}}{/bold}   │   POČET ZNÁMOK: ${subj.count || 0}`;
  out.push(`{67-fg}│{/67-fg}${padVisTagged(statsLine, innerW)}{67-fg}│{/67-fg}`);

  const distColors = ['green-fg', 'cyan-fg', 'yellow-fg', 'magenta-fg', 'red-fg'];
  const distParts = [1, 2, 3, 4, 5].map((g, i) => `{${distColors[i]}}[${g}]: ${sDist[i]}x{/${distColors[i]}}`).join('   ·   ');
  const distSummary = ` DISTRIBÚCIA:  ${distParts}`;
  out.push(`{67-fg}│{/67-fg}${padVisTagged(distSummary, innerW)}{67-fg}│{/67-fg}`);
  out.push(`{67-fg}└${'─'.repeat(innerW)}┘{/67-fg}`);
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

  out.push(`{67-fg}${sLine('┌', '┬', '┐')}{/67-fg}`);
  out.push(
    '{67-fg}│{/67-fg}' +
    `{bold}{110-fg}${padVis('#', wIdx, 'center')}{/bold}{/110-fg}{67-fg}│{/67-fg}` +
    `{bold}{110-fg}${padVis('DÁTUM', wDate, 'center')}{/bold}{/110-fg}{67-fg}│{/67-fg}` +
    `{bold}{110-fg}${padVis('HODNOTENIE', wGrd, 'center')}{/bold}{/110-fg}{67-fg}│{/67-fg}` +
    `{bold}{110-fg}${padVis('ZNÁMKA', wNum, 'center')}{/bold}{/110-fg}{67-fg}│{/67-fg}` +
    `{bold}{110-fg}${padVis('BODY / %', wPts, 'center')}{/bold}{/110-fg}{67-fg}│{/67-fg}` +
    `{bold}{110-fg}${padVis('VÁHA', wWgt, 'center')}{/bold}{/110-fg}{67-fg}│{/67-fg}` +
    `{bold}{110-fg}${padVis('PRIEM.TR.', wCavg, 'center')}{/bold}{/110-fg}{67-fg}│{/67-fg}` +
    `{bold}{110-fg}${padVis('UDALOSŤ / TÉMA', wTitle)}{/bold}{/110-fg}{67-fg}│{/67-fg}` +
    `{bold}{110-fg}${padVis('UČITEĽ', wTeach)}{/bold}{/110-fg}{67-fg}│{/67-fg}`
  );
  out.push(`{67-fg}${sLine('├', '┼', '┤')}{/67-fg}`);

  if (gRows.length === 0) {
    out.push(
      '{67-fg}│{/67-fg}' +
      `{244-fg}${padVis('-', wIdx, 'center')}{/244-fg}{67-fg}│{/67-fg}` +
      `{244-fg}${padVis('-', wDate, 'center')}{/244-fg}{67-fg}│{/67-fg}` +
      `{244-fg}${padVis('-', wGrd, 'center')}{/244-fg}{67-fg}│{/67-fg}` +
      `{244-fg}${padVis('-', wNum, 'center')}{/244-fg}{67-fg}│{/67-fg}` +
      `{244-fg}${padVis('-', wPts, 'center')}{/244-fg}{67-fg}│{/67-fg}` +
      `{244-fg}${padVis('-', wWgt, 'center')}{/244-fg}{67-fg}│{/67-fg}` +
      `{244-fg}${padVis('-', wCavg, 'center')}{/244-fg}{67-fg}│{/67-fg}` +
      `{244-fg}${padVis('Žiadne známky.', wTitle)}{/244-fg}{67-fg}│{/67-fg}` +
      `{244-fg}${padVis('-', wTeach)}{/244-fg}{67-fg}│{/67-fg}`
    );
  } else {
    gRows.forEach((g, idx) => {
      const gCol = getGradeColorTag(g.numeric_val !== '-' ? g.numeric_val : g.grade);
      out.push(
        '{67-fg}│{/67-fg}' +
        `{244-fg}${padVis(`${idx + 1}.`, wIdx, 'center')}{/244-fg}{67-fg}│{/67-fg}` +
        `{250-fg}${padVis(g.date || '-', wDate, 'center')}{/250-fg}{67-fg}│{/67-fg}` +
        `{bold}{${gCol}}${padVis(g.grade || '-', wGrd, 'center')}{/${gCol}}{/bold}{67-fg}│{/67-fg}` +
        `{bold}{${gCol}}${padVis(g.numeric_val || '-', wNum, 'center')}{/${gCol}}{/bold}{67-fg}│{/67-fg}` +
        `{bold}{${getGradeColorTag(g.points_str)}}${padVis(g.points_str || '-', wPts, 'center')}{/${getGradeColorTag(g.points_str)}}{/bold}{67-fg}│{/67-fg}` +
        `{244-fg}${padVis(g.weight || '1', wWgt, 'center')}{/244-fg}{67-fg}│{/67-fg}` +
        `{244-fg}${padVis(g.class_avg || '-', wCavg, 'center')}{/244-fg}{67-fg}│{/67-fg}` +
        `{white-fg}${padVis(g.title || '-', wTitle)}{/white-fg}{67-fg}│{/67-fg}` +
        `{250-fg}${padVis(g.teacher || '-', wTeach)}{/250-fg}{67-fg}│{/67-fg}`
      );
    });
  }

  out.push(`{67-fg}${sLine('└', '┴', '┘')}{/67-fg}`);

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
    openComposeMessageModal();
    return;
  }
  if (msgFilterCursor === 1) {
    const allChecked = MESSAGE_CATEGORIES.every((c) => msgFilterChecked[c.key]);
    const nextState = !allChecked;
    MESSAGE_CATEGORIES.forEach((c) => {
      msgFilterChecked[c.key] = nextState;
    });
  } else if (msgFilterCursor >= 2 && msgFilterCursor <= MESSAGE_CATEGORIES.length + 1) {
    const cat = MESSAGE_CATEGORIES[msgFilterCursor - 2];
    msgFilterChecked[cat.key] = !msgFilterChecked[cat.key];
  } else if (msgFilterCursor === MESSAGE_CATEGORIES.length + 2) {
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
  messagesSidebar.style.border.fg = isFilterFocused ? COLOR_ORANGE : COLOR_STEEL_BLUE;
  messagesSidebar.setLabel(' [ SPRÁVY & FILTRE ] ');

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

  // Row 0: COMPOSE MESSAGE BUTTON
  const composeBtnText = ' ✉ + POSLAŤ SPRÁVU [m] ';
  const composeFocused = isFilterFocused && msgFilterCursor === 0;
  if (composeFocused) {
    lines.push(`{208-bg}{black-fg}{bold}${padRawLine(composeBtnText, 32)}{/bold}{/black-fg}{/208-bg}`);
  } else {
    lines.push(`{117-bg}{black-fg}{bold}${padRawLine(composeBtnText, 32)}{/bold}{/black-fg}{/117-bg}`);
  }
  lines.push('');

  lines.push(' {110-fg}ZOBRAZENÉ{/110-fg}');
  lines.push(` {24-bg}{153-fg}{bold}${padRawLine(` ● ${filtered.length} / ${all.length} SPRÁV`, 30)}{/bold}{/153-fg}{/24-bg}`);
  if (msgSearchQuery.trim()) {
    lines.push(` {250-fg}${fitPlain(`Hľadané: "${msgSearchQuery.trim()}"`, 30)}{/250-fg}`);
  }
  lines.push('{67-fg}────────────────────────────────{/67-fg}');
  lines.push(' {110-fg}KATEGÓRIE{/110-fg}');
  lines.push('');

  // Row 1: VŠETKY TYPY
  const row1Focused = isFilterFocused && msgFilterCursor === 1;
  const markAll = allChecked ? '[x]' : '[ ]';
  const row1Text = ` ${row1Focused ? '▸' : ' '} ${markAll} VŠETKY (${all.length})`;
  if (row1Focused) {
    lines.push(`{208-bg}{black-fg}{bold}${padRawLine(row1Text, 32)}{/bold}{/black-fg}{/208-bg}`);
  } else if (allChecked) {
    lines.push(`{153-fg}{bold}${padRawLine(row1Text, 32)}{/bold}{/153-fg}`);
  } else {
    lines.push(`{244-fg}${padRawLine(row1Text, 32)}{/244-fg}`);
  }
  lines.push('');

  // Rows 2..7: Individual Category Checkboxes
  MESSAGE_CATEGORIES.forEach((cat, idx) => {
    const itemIdx = idx + 2;
    const isHere = isFilterFocused && msgFilterCursor === itemIdx;
    const checked = !!msgFilterChecked[cat.key];
    const boxMark = checked ? '[x]' : '[ ]';
    const cnt = countsByCat[cat.key] || 0;
    const labelPart = fitPlain(cat.label, 19).padEnd(19, ' ');
    const rawRow = ` ${isHere ? '▸' : ' '} ${boxMark} ${labelPart} (${String(cnt).padStart(2, ' ')})`;

    if (isHere) {
      lines.push(`{208-bg}{black-fg}{bold}${padRawLine(rawRow, 32)}{/bold}{/black-fg}{/208-bg}`);
    } else if (checked) {
      lines.push(`{153-fg}   [x] ${labelPart}{/153-fg} {244-fg}(${String(cnt).padStart(2, ' ')}){/244-fg}`);
    } else {
      lines.push(`{244-fg}   [ ] ${labelPart} (${String(cnt).padStart(2, ' ')}){/244-fg}`);
    }
    lines.push('');
  });

  // Row 8: Reset Filters & Search
  const resetIdx = MESSAGE_CATEGORIES.length + 2;
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
  messagesSearchBox.style.border.fg = isSearchFocused ? COLOR_ORANGE : COLOR_STEEL_BLUE;
  messagesSearchBox.setLabel(' [ HĽADAŤ ] ');

  const filteredCount = getFilteredNotifications().length;
  const totalCount = getAllNotificationsList().length;

  let queryDisplay = '';
  if (isSearchFocused) {
    queryDisplay = `{208-fg}{bold}Hľadať:{/bold}{/208-fg} {white-fg}${msgSearchQuery}{/white-fg}{208-fg}█{/208-fg}`;
  } else if (msgSearchQuery.trim()) {
    queryDisplay = `{110-fg}Hľadať:{/110-fg} {153-fg}{bold}${msgSearchQuery}{/bold}{/153-fg}`;
  } else {
    queryDisplay = '{244-fg}Hľadať text alebo predmet...{/244-fg}';
  }

  const rightStat = `{110-fg}${filteredCount} / ${totalCount}{/110-fg}`;
  messagesSearchBox.setContent(` ${queryDisplay}    {67-fg}│{/67-fg}    {153-fg}[m]{/153-fg} {117-fg}+Poslať správu{/117-fg}    {67-fg}│{/67-fg}    ${rightStat}`);
}

function renderMessagesFeed() {
  const isFeedFocused = activeTabIndex === 3 && navFocus === 'card' && msgSubFocus === 'feed';
  messagesFeedBox.style.border.fg = isFeedFocused ? COLOR_ORANGE : COLOR_STEEL_BLUE;
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

      out.push(` {67-fg}${leftDash}{/67-fg}{24-bg}{153-fg}{bold}${labelBlock}{/bold}{/153-fg}{/24-bg}{67-fg}${rightDash}{/67-fg}`);
      out.push('');
    }

    const cardW = innerW - 2;

    // Header Row inside card: TIME │ [BADGE] │ PREDMET │ OD │ TERMÍN
    const timeStr = n.time && n.time !== '-' ? n.time : '     ';
    const badgeStr = `[${n.badge || 'OZNAM'}]`;
    const subjPart = n.subject ? `  ·  ${n.subject}` : '';
    const authorPart = n.author ? `  ·  ${n.author}` : '';
    const duePart = n.due_date ? `  ·  Termín: ${n.due_date}` : '';

    out.push(` {67-fg}┌${'─'.repeat(cardW)}┐{/67-fg}`);
    out.push(
      ` {67-fg}│{/67-fg} {110-fg}${timeStr}{/110-fg}  {153-fg}{bold}${badgeStr}{/bold}{/153-fg}${subjPart ? '{white-fg}' + subjPart + '{/white-fg}' : ''}${authorPart ? '{250-fg}' + authorPart + '{/250-fg}' : ''}${duePart ? '{117-fg}' + duePart + '{/117-fg}' : ''}`
    );
    out.push(` {67-fg}├${'─'.repeat(cardW)}┤{/67-fg}`);

    // Wrapped Body Lines with breathing room
    const bodyLines = wrapTextToLines(n.text || '-', cardW - 4);
    bodyLines.forEach((bLine) => {
      out.push(` {67-fg}│{/67-fg}{white-fg}  ${padRawLine(bLine, cardW - 2)}{/white-fg}{67-fg}│{/67-fg}`);
    });

    // Optional Attachments line inside card
    if (Array.isArray(n.attachments) && n.attachments.length > 0) {
      const attStr = `  Príloha: ${n.attachments.join(', ')}`;
      out.push(` {67-fg}│{/67-fg}{110-fg}${padRawLine(attStr, cardW)}{/110-fg}{67-fg}│{/67-fg}`);
    }

    out.push(` {67-fg}└${'─'.repeat(cardW)}┘{/67-fg}`);
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

  // 1. Line Graph (Light Cyan / Blue line)
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
        style: { line: 'cyan' },
      },
    ]);
  }

  // 2. Marks Distribution Box (Soft Light-Blue bars + Slate/Gray details)
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
    distLines.push(` {250-fg}${gradeNum}  ${label}{/250-fg} {153-fg}${paddedBar}{/153-fg} {bold}{white-fg}${countStr}{/white-fg}{/bold}  {244-fg}${pctStr}{/244-fg}`);
  });
  const passCount = distData[0] + distData[1] + distData[2] + distData[3];
  const passRate = totalMarks > 0 ? ((passCount / totalMarks) * 100).toFixed(1) : '0.0';
  distLines.push(` {110-fg}SPOLU:{/110-fg} {white-fg}${totalMarks}{/white-fg}  {67-fg}│{/67-fg}  {110-fg}PRIEMER:{/110-fg} {153-fg}{bold}${dashboardData.gpa || '-'}{/bold}{/153-fg}  {67-fg}│{/67-fg}  {110-fg}ÚSPEŠNOSŤ:{/110-fg} {250-fg}${passRate}%{/250-fg}`);
  distributionBox.setContent(distLines.join('\n'));

  // 3. Live Monitor Timetable & Progress Calculation
  updateLiveProgress();

  // 4. Mini Lunch Box (Light Blue / Slate accents)
  const lunch = dashboardData.lunches;
  if (lunch) {
    let lines = [];
    lines.push(` {110-fg}STAV:{/110-fg} {153-fg}{bold}${lunch.status || 'OBJEDNANÉ: ' + lunch.ordered_meal}{/bold}{/153-fg}`);
    if (lunch.serving) lines.push(` {110-fg}VÝDAJ:{/110-fg} {250-fg}${lunch.serving}{/250-fg}`);
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

  // 9. Tab 5 Lunches View (Days Sidebar + Menu Table + Cancel & Rating)
  renderLunchesCard();

  // 10. Modals (if active)
  if (activeModal === 'confirm_lunch') renderConfirmLunchModal();
  else if (activeModal === 'compose_message') renderComposeModal();

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
    lunches_week: [],
    teachers_directory: [],
    tasks: [],
    notifications: [],
    all_grades: [],
    commendations: [],
  };
}

// ==============================================================================
// Python Subcommand Action Runner (For Sign-off, Rating, Send Message)
// ==============================================================================

function runPythonAction(subcommandArgs, callback) {
  const isWin = process.platform === 'win32';
  const venvPy = path.join(__dirname, '.venv', isWin ? 'Scripts' : 'bin', isWin ? 'python.exe' : 'python');
  const pythonCmd = fs.existsSync(venvPy) ? venvPy : (isWin ? 'python' : 'python3');

  const proc = spawn(pythonCmd, ['cli.py', ...subcommandArgs], {
    cwd: __dirname,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  proc.stdout.on('data', (d) => { stdout += d.toString(); });
  proc.stderr.on('data', (d) => { stderr += d.toString(); });

  proc.on('close', (code) => {
    let result = null;
    try {
      result = JSON.parse(stdout.trim());
    } catch (e) {
      result = { success: code === 0, message: stdout.trim() || stderr.trim() };
    }
    if (callback) callback(code === 0, result);
  });
}

// ==============================================================================
// TAB 5 (OBEDY): Cafeteria Lunches, Day Switching, Cancel Button & Meal Rating
// ==============================================================================

function getLunchesDays() {
  if (Array.isArray(dashboardData.lunches_week) && dashboardData.lunches_week.length > 0) {
    return dashboardData.lunches_week;
  }
  const today = new Date();
  const dayNames = ['Pondelok', 'Utorok', 'Streda', 'Štvrtok', 'Piatok'];
  const dayShorts = ['PO', 'UT', 'ST', 'ŠT', 'PI'];
  const res = [];
  const currDay = today.getDay();
  const mondayOffset = currDay === 0 ? -6 : 1 - currDay;
  for (let i = 0; i < 5; i++) {
    const d = new Date(today);
    d.setDate(today.getDate() + mondayOffset + i);
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const dFmt = `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`;
    const dShort = `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.`;
    res.push({
      date: iso,
      day_name: dayNames[i],
      day_short: dayShorts[i],
      date_formatted: dFmt,
      date_short: dShort,
      is_today: d.toDateString() === today.toDateString(),
      is_past: d < today,
      has_meal: true,
      title: 'Polievka šutolica, Cestoviny bez posýpky, Posýpka maková na cestoviny',
      ordered_meal: 'A',
      status: 'OBJEDNANÉ: Menu A',
      serving: '11:00 - 14:00',
      can_be_changed_until: null,
      menus: [
        { number: '1', name: 'Polievka šutolica', allergens: '1', weight: '250', selected: false },
        { number: '2', name: 'Cestoviny bez posýpky', allergens: '1, 3', weight: '200', selected: true },
        { number: '3', name: 'Posýpka maková na cestoviny', allergens: '', weight: '60', selected: true },
        { number: '4', name: 'Prírodná ovocná šťava 100%', allergens: '', weight: '200', selected: false },
      ],
    });
  }
  return res;
}

function renderLunchesSidebar() {
  const isSidebarFocused = activeTabIndex === 4 && navFocus === 'card' && lunchSubFocus === 'sidebar';
  lunchesSidebar.style.border.fg = isSidebarFocused ? COLOR_ORANGE : COLOR_STEEL_BLUE;
  lunchesSidebar.setLabel(' [ DNI V TÝŽDNI ] ');

  const days = getLunchesDays();
  if (lunchDayCursor >= days.length) lunchDayCursor = Math.max(0, days.length - 1);

  const lines = [];
  lines.push(' {bold}{153-fg}VÝBER DŇA{/153-fg}{/bold}');
  lines.push(' {67-fg}──────────────────────────────{/67-fg}');
  lines.push('');

  days.forEach((day, idx) => {
    if (days.length === 10) {
      if (idx === 0) {
        lines.push(' {110-fg}{bold}► TENTO TÝŽDEŇ{/bold}{/110-fg}');
        lines.push('');
      } else if (idx === 5) {
        lines.push('');
        lines.push(' {110-fg}{bold}► BUDÚCI TÝŽDEŇ{/bold}{/110-fg}');
        lines.push('');
      }
    }

    const isCursorHere = isSidebarFocused && idx === lunchDayCursor;
    const isSelected = idx === lunchDayCursor;
    const todayTag = day.is_today ? ' [DNES]' : '';
    const namePart = `${day.day_name} ${day.date_short}${todayTag}`;

    let statusBadge = '';
    if (day.ordered_meal) {
      statusBadge = `{green-fg}● Obj (${day.ordered_meal}){/green-fg}`;
    } else if (day.has_meal) {
      statusBadge = `{red-fg}○ Odhlásené{/red-fg}`;
    } else {
      statusBadge = `{244-fg}- Nevarí sa{/244-fg}`;
    }

    const leftPrefix = isCursorHere ? '▸ ' : (isSelected ? '• ' : '  ');
    const rawRow = `${leftPrefix}${fitPlain(namePart, 17).padEnd(17, ' ')} ${day.ordered_meal ? '[Obj]' : (day.has_meal ? '[Odh]' : '[-] ')}`;

    if (isCursorHere) {
      lines.push(`{208-bg}{black-fg}{bold}${padRawLine(rawRow, 32)}{/bold}{/black-fg}{/208-bg}`);
    } else if (isSelected) {
      lines.push(`{117-fg}{bold}  ${namePart}{/bold}{/117-fg}`);
      lines.push(`     ${statusBadge}`);
    } else {
      lines.push(`{250-fg}  ${namePart}{/250-fg}`);
      lines.push(`     ${statusBadge}`);
    }
    lines.push('');
  });

  lines.push(' {67-fg}──────────────────────────────{/67-fg}');
  lines.push(' {244-fg}[↑/↓] Výber dňa{/244-fg}');
  lines.push(' {244-fg}[→ / Tab] Prejsť na obed{/244-fg}');

  lunchesSidebar.setContent(lines.join('\n'));
}

function renderLunchesMain() {
  const days = getLunchesDays();
  const day = days[lunchDayCursor] || days[0];

  const isBtnFocused = activeTabIndex === 4 && navFocus === 'card' && lunchSubFocus === 'button';
  const isRatingFocused = activeTabIndex === 4 && navFocus === 'card' && lunchSubFocus === 'rating';
  const isCardActive = activeTabIndex === 4 && navFocus === 'card';
  const isSidebarFocused = isCardActive && lunchSubFocus === 'sidebar';

  lunchesMainBox.style.border.fg = isCardActive && !isSidebarFocused ? COLOR_ORANGE : COLOR_STEEL_BLUE;
  lunchesMainBox.setLabel(` [ JEDÁLNY LÍSTOK: ${day.day_name.toUpperCase()} ${day.date_short} ] `);

  const boxW = lunchesMainBox.width && lunchesMainBox.width > 40
    ? lunchesMainBox.width
    : Math.max(78, screen.width - SIDEBAR_WIDTH);
  const innerW = Math.max(72, boxW - 6);

  const lines = [];
  lines.push('');

  // 1. Header Banner
  const titleStr = `JEDÁLNY LÍSTOK: ${day.day_name.toUpperCase()} ${day.date_formatted}`;
  lines.push(` {bold}{153-fg}${titleStr}{/153-fg}{/bold}`);
  lines.push(
    ` {244-fg}Výdaj obeda:{/244-fg} {153-fg}${day.serving}{/153-fg}   {67-fg}│{/67-fg}   ` +
    `{244-fg}Stav:{/244-fg} ${day.ordered_meal ? '{green-fg}{bold}● OBJEDNANÉ (Menu ' + day.ordered_meal + '){/bold}{/green-fg}' : (day.has_meal ? '{red-fg}{bold}○ ODHLÁSENÉ{/bold}{/red-fg}' : '{244-fg}NEVARÍ SA{/244-fg}')}`
  );
  lines.push(` {67-fg}${'─'.repeat(innerW)}{/67-fg}`);
  lines.push('');

  // 2. ČERVENÉ TLAČIDLO NA ODHLÁSENIE (Above menu)
  if (day.has_meal) {
    if (day.ordered_meal) {
      const btnText = '   [ X ODHLÁSIŤ OBED ]   ';
      if (isBtnFocused) {
        lines.push(` {208-bg}{black-fg}{bold} ▶▶ [ X ODHLÁSIŤ OBED ] ◀◀ {/bold}{/black-fg}{/208-bg}   {244-fg}(Stlačte Enter pre potvrdenie odhlásenia){/244-fg}`);
      } else {
        lines.push(` {white-fg}{196-bg}{bold}${btnText}{/bold}{/196-bg}{/white-fg}`);
      }
    } else {
      const btnText = '   [ + PRIHLÁSIŤ OBED (Menu A) ]   ';
      if (isBtnFocused) {
        lines.push(` {208-bg}{black-fg}{bold} ▶▶ [ + PRIHLÁSIŤ OBED (Menu A) ] ◀◀ {/bold}{/black-fg}{/208-bg}   {244-fg}(Stlačte Enter pre prihlásenie){/244-fg}`);
      } else {
        lines.push(` {black-fg}{46-bg}{bold}${btnText}{/bold}{/46-bg}{/black-fg}`);
      }
    }
  } else {
    lines.push(' {244-fg}[ V tento deň jedáleň nevarí ]{/244-fg}');
  }

  if (lunchActionFeedback) {
    lines.push(` ${lunchActionFeedback}`);
  }
  lines.push('');

  // 3. MENU TABLE
  lines.push(' {bold}{110-fg}ROZPIS JEDÁL:{/110-fg}{/bold}');
  const colChod = 10;
  const colGramaz = 10;
  const colAlergeny = 14;
  const colJedlo = Math.max(26, innerW - (colChod + colGramaz + colAlergeny + 10));

  lines.push(` {67-fg}┌${'─'.repeat(colChod + 2)}┬${'─'.repeat(colJedlo + 2)}┬${'─'.repeat(colGramaz + 2)}┬${'─'.repeat(colAlergeny + 2)}┐{/67-fg}`);
  lines.push(` {67-fg}│{/67-fg} {153-fg}CHOD${' '.repeat(colChod - 4)}{/153-fg} {67-fg}│{/67-fg} {153-fg}NÁZOV POKRMU${' '.repeat(Math.max(0, colJedlo - 12))}{/153-fg} {67-fg}│{/67-fg} {153-fg}GRAMÁŽ${' '.repeat(colGramaz - 6)}{/153-fg} {67-fg}│{/67-fg} {153-fg}ALERGÉNY${' '.repeat(colAlergeny - 8)}{/153-fg} {67-fg}│{/67-fg}`);
  lines.push(` {67-fg}├${'─'.repeat(colChod + 2)}┼${'─'.repeat(colJedlo + 2)}┼${'─'.repeat(colGramaz + 2)}┼${'─'.repeat(colAlergeny + 2)}┤{/67-fg}`);

  if (day.menus && day.menus.length > 0) {
    day.menus.forEach((m, mIdx) => {
      let chodName = `Chod ${mIdx + 1}`;
      const lower = (m.name || '').toLowerCase();
      if (lower.includes('polievka')) chodName = 'Polievka';
      else if (lower.includes('chlieb') || lower.includes('pečivo')) chodName = 'Pečivo';
      else if (lower.includes('stehno') || lower.includes('mäso') || lower.includes('rezeň') || lower.includes('cestoviny') || lower.includes('rizoto') || lower.includes('gulaš')) chodName = 'Hlavné';
      else if (lower.includes('zemiak') || lower.includes('ryža') || lower.includes('posýpka')) chodName = 'Príloha';
      else if (lower.includes('šalát') || lower.includes('uhorka') || lower.includes('kapust')) chodName = 'Šalát';
      else if (lower.includes('voda') || lower.includes('šťava') || lower.includes('čaj') || lower.includes('nápoj')) chodName = 'Nápoj';
      else if (lower.includes('ovocie') || lower.includes('jablko') || lower.includes('hrozno')) chodName = 'Dezert';

      const chStr = fitPlain(chodName, colChod).padEnd(colChod, ' ');
      const nameStr = fitPlain(m.name || '-', colJedlo).padEnd(colJedlo, ' ');
      const grStr = fitPlain(m.weight ? `${m.weight}g` : '-', colGramaz).padEnd(colGramaz, ' ');
      const alStr = fitPlain(m.allergens || '-', colAlergeny).padEnd(colAlergeny, ' ');

      lines.push(` {67-fg}│{/67-fg} {244-fg}${chStr}{/244-fg} {67-fg}│{/67-fg} {white-fg}${nameStr}{/white-fg} {67-fg}│{/67-fg} {250-fg}${grStr}{/250-fg} {67-fg}│{/67-fg} {110-fg}${alStr}{/110-fg} {67-fg}│{/67-fg}`);
    });
  } else {
    const rawLines = wrapTextToLines(day.title || 'Žiadne podrobnosti o jedle.', colJedlo);
    rawLines.forEach((rl, rIdx) => {
      const chStr = (rIdx === 0 ? 'Obed' : '').padEnd(colChod, ' ');
      const nameStr = fitPlain(rl, colJedlo).padEnd(colJedlo, ' ');
      const grStr = '-'.padEnd(colGramaz, ' ');
      const alStr = '-'.padEnd(colAlergeny, ' ');
      lines.push(` {67-fg}│{/67-fg} {244-fg}${chStr}{/244-fg} {67-fg}│{/67-fg} {white-fg}${nameStr}{/white-fg} {67-fg}│{/67-fg} {250-fg}${grStr}{/250-fg} {67-fg}│{/67-fg} {110-fg}${alStr}{/110-fg} {67-fg}│{/67-fg}`);
    });
  }
  lines.push(` {67-fg}└${'─'.repeat(colChod + 2)}┴${'─'.repeat(colJedlo + 2)}┴${'─'.repeat(colGramaz + 2)}┴${'─'.repeat(colAlergeny + 2)}┘{/67-fg}`);
  lines.push('');

  // 4. HODNOTENIE JEDLA (Rating Area)
  lines.push(' {bold}{153-fg}★ HODNOTENIE JEDLA{/153-fg}{/bold}');
  lines.push(' {67-fg}────────────────────────────────────────────────────────────{/67-fg}');

  const starRender = (val) => {
    return [1, 2, 3, 4, 5].map((n) => (n <= val ? '{117-fg}★{/117-fg}' : '{240-fg}☆{/240-fg}')).join(' ');
  };

  const isQualFocused = isRatingFocused && lunchRatingField === 'quality';
  const isQuanFocused = isRatingFocused && lunchRatingField === 'quantity';

  const qualBtns = [1, 2, 3, 4, 5].map((n) => {
    if (n === lunchRatingQuality) {
      return isQualFocused ? `{208-bg}{black-fg}{bold}[ ${n}★ ]{/bold}{/black-fg}{/208-bg}` : `{153-bg}{black-fg}[ ${n}★ ]{/black-fg}{/153-bg}`;
    }
    return `{240-fg}[ ${n} ]{/240-fg}`;
  }).join(' ');

  const quanBtns = [1, 2, 3, 4, 5].map((n) => {
    if (n === lunchRatingQuantity) {
      return isQuanFocused ? `{208-bg}{black-fg}{bold}[ ${n}★ ]{/bold}{/black-fg}{/208-bg}` : `{153-bg}{black-fg}[ ${n}★ ]{/black-fg}{/153-bg}`;
    }
    return `{240-fg}[ ${n} ]{/240-fg}`;
  }).join(' ');

  lines.push(`  ${isQualFocused ? '{208-fg}▶{/208-fg}' : ' '} {250-fg}Kvalita jedla:{/250-fg}     ${qualBtns}   ${starRender(lunchRatingQuality)}`);
  lines.push(`  ${isQuanFocused ? '{208-fg}▶{/208-fg}' : ' '} {250-fg}Množstvo / Porcia:{/250-fg} ${quanBtns}   ${starRender(lunchRatingQuantity)}`);
  lines.push('');

  if (isRatingFocused) {
    lines.push(`  {208-bg}{black-fg}{bold} [ ENTER: ODOSLAŤ HODNOTENIE ] {/bold}{/black-fg}{/208-bg}   {244-fg}[1-5: Nastaviť hviezdičky │ Tab: Prepínať kvalitu/porciu]{/244-fg}`);
  } else {
    lines.push(`  {240-bg}{250-fg} [ ODOSLAŤ HODNOTENIE ] {/250-fg}{/240-bg}   {244-fg}(Zamerajte hodnotenie šípkou dole pre odoslanie){/244-fg}`);
  }

  lunchesMainBox.setContent(lines.join('\n'));
}

function renderLunchesCard() {
  renderLunchesSidebar();
  renderLunchesMain();
}

// ==============================================================================
// IN-CLI POPUP MODALS: CONFIRM LUNCH & COMPOSE MESSAGE HANDLERS
// ==============================================================================

function openConfirmLunchModal(day, actionType) {
  confirmModalPendingDay = day;
  confirmModalPendingAction = actionType || 'signoff';
  confirmModalExecuting = false;
  confirmModalFeedback = null;
  activeModal = 'confirm_lunch';
  renderConfirmLunchModal();
  confirmLunchModal.show();
  confirmLunchModal.focus();
  updateFooter();
  screen.render();
}

function closeConfirmLunchModal() {
  lastModalClosedAt = Date.now();
  activeModal = null;
  confirmModalPendingDay = null;
  confirmModalFeedback = null;
  confirmModalExecuting = false;
  confirmLunchModal.hide();
  updateFooter();
  renderLunchesCard();
  screen.render();
}

function renderConfirmLunchModal() {
  const day = confirmModalPendingDay;
  if (!day) return;

  const isSignoff = confirmModalPendingAction === 'signoff';
  const title = isSignoff ? '▲ POTVRDENIE ODHLÁSENIA OBEDA ▲' : '▲ POTVRDENIE PRIHLÁSENIA OBEDA ▲';
  const actionWord = isSignoff ? 'odhlásiť' : 'prihlásiť';
  const colTag = isSignoff ? '196' : '46';

  const lines = [];
  lines.push('');
  lines.push(` {center}{bold}{${colTag}-fg}${title}{/${colTag}-fg}{/bold}{/center}`);
  lines.push(' {67-fg}────────────────────────────────────────────────────────────{/67-fg}');
  lines.push('');
  lines.push(`  Naozaj si prajete {bold}{white-fg}${actionWord}{/white-fg}{/bold} obed na:`);
  lines.push(`  {bold}{153-fg}${day.day_name} ${day.date_formatted}{/153-fg}{/bold}`);
  lines.push('');
  lines.push(`  {244-fg}Výdaj:{/244-fg} {white-fg}${day.serving}{/white-fg}`);
  lines.push(`  {244-fg}Stav pred akciou:{/244-fg} {white-fg}${day.status}{/white-fg}`);
  lines.push('');

  if (confirmModalExecuting) {
    lines.push('  {center}{yellow-fg}{bold}⏳ Prebieha komunikácia so serverom EduPage...{/bold}{/yellow-fg}{/center}');
  } else if (confirmModalFeedback) {
    lines.push(`  {center}${confirmModalFeedback}{/center}`);
  } else {
    const confirmBtn = isSignoff
      ? '{white-fg}{196-bg}{bold} [ ENTER ] POTVRDIŤ ODHLÁSENIE {/bold}{/196-bg}{/white-fg}'
      : '{black-fg}{46-bg}{bold} [ ENTER ] POTVRDIŤ PRIHLÁSENIE {/bold}{/46-bg}{/black-fg}';
    lines.push(`  {center}${confirmBtn}     {244-fg}[ ESC / N ] ZRUŠIŤ{/244-fg}{/center}`);
  }

  confirmLunchModal.setContent(lines.join('\n'));
}

function executeConfirmLunchAction() {
  if (!confirmModalPendingDay || confirmModalExecuting) return;
  confirmModalExecuting = true;
  confirmModalFeedback = null;
  renderConfirmLunchModal();
  screen.render();

  const day = confirmModalPendingDay;
  const isSignoff = confirmModalPendingAction === 'signoff';
  const subcmd = isSignoff ? 'lunch-signoff' : 'lunch-order';
  const args = isSignoff ? [subcmd, '--date', day.date] : [subcmd, '--date', day.date, '--menu', 'A'];

  runPythonAction(args, (success, result) => {
    confirmModalExecuting = false;
    if (success && result && result.success) {
      confirmModalFeedback = `{green-fg}{bold}✓ ${result.message || 'Akcia úspešná!'}{/bold}{/green-fg}`;
      if (isSignoff) {
        day.ordered_meal = null;
        day.status = 'ODHLÁSENÉ / NEOBJEDNANÉ';
      } else {
        day.ordered_meal = 'A';
        day.status = 'OBJEDNANÉ: Menu A';
      }
      lunchActionFeedback = confirmModalFeedback;
      renderConfirmLunchModal();
      screen.render();
      setTimeout(() => {
        closeConfirmLunchModal();
      }, 1000);
    } else {
      const errMsg = (result && (result.error || result.message)) || 'Akcia zlyhala.';
      confirmModalFeedback = `{red-fg}{bold}✗ ${errMsg}{/bold}{/red-fg}`;
      renderConfirmLunchModal();
      screen.render();
    }
  });
}

function executeSubmitRating() {
  const days = getLunchesDays();
  const day = days[lunchDayCursor] || days[0];
  if (!day || !day.has_meal) return;

  lunchActionFeedback = '{yellow-fg}⏳ Odosielam hodnotenie jedla...{/yellow-fg}';
  renderLunchesCard();
  screen.render();

  const args = [
    'lunch-rate',
    '--date', day.date,
    '--quality', String(lunchRatingQuality),
    '--quantity', String(lunchRatingQuantity),
  ];

  runPythonAction(args, (success, result) => {
    if (success && result && result.success) {
      lunchActionFeedback = `{green-fg}{bold}✓ ${result.message || 'Hodnotenie úspešne odoslané!'}{/bold}{/green-fg}`;
    } else {
      const err = (result && (result.error || result.message)) || 'Nepodarilo sa odoslať hodnotenie.';
      lunchActionFeedback = `{red-fg}{bold}✗ ${err}{/bold}{/red-fg}`;
    }
    renderLunchesCard();
    screen.render();
    if (lunchActionTimer) clearTimeout(lunchActionTimer);
    lunchActionTimer = setTimeout(() => {
      lunchActionFeedback = null;
      renderLunchesCard();
      screen.render();
    }, 4000);
  });
}

function getFilteredRecipients() {
  const all = (dashboardData.recipients_directory && dashboardData.recipients_directory.length > 0)
    ? dashboardData.recipients_directory
    : (dashboardData.teachers_directory || []).map((t) => ({
        id: t.id,
        name: t.name,
        type: 'TEACHER',
        type_label: 'UČITEĽ',
        detail: `Učiteľ · Kabinet: ${t.classroom || '-'}`,
      }));

  const q = composeSearchQuery.trim().toLowerCase();
  if (!q) return all.slice(0, 9);
  return all.filter((r) => {
    const nameMatch = (r.name || '').toLowerCase().includes(q);
    const detailMatch = (r.detail || '').toLowerCase().includes(q);
    const typeMatch = (r.type_label || '').toLowerCase().includes(q);
    return nameMatch || detailMatch || typeMatch;
  }).slice(0, 9);
}

function openComposeMessageModal() {
  activeModal = 'compose_message';
  composeStep = 'recipients';
  composeSearchQuery = '';
  composeRecipientCursor = 0;
  composeSelectedRecipients = [];
  composeBody = '';
  composeFeedback = null;
  composeExecuting = false;
  renderComposeModal();
  composeModal.show();
  composeModal.focus();
  updateFooter();
  screen.render();
}

function closeComposeModal() {
  lastModalClosedAt = Date.now();
  activeModal = null;
  composeModal.hide();
  updateFooter();
  if (activeTabIndex === 3) {
    renderMessagesCard();
  }
  screen.render();
}

function renderComposeModal() {
  const lines = [];
  lines.push('');
  lines.push(' {bold}{153-fg}✉ POSLAŤ SPRÁVU (UČITELIA / TRIEDY / ŽIACI){/153-fg}{/bold}');
  lines.push(' {67-fg}────────────────────────────────────────────────────────────────────────{/67-fg}');
  lines.push('');

  // 1. Tags of currently selected recipients
  const tagList = composeSelectedRecipients.map((r) => {
    let typeBg = '117-bg';
    if (r.type === 'CLASS') typeBg = '31-bg';
    else if (r.type === 'TEACHER') typeBg = '24-bg';
    else if (r.type === 'STUDENT') typeBg = '23-bg';
    return `{${typeBg}}{white-fg} [✓] ${r.name} {/white-fg}{/${typeBg}}`;
  }).join(' ');

  if (composeSelectedRecipients.length > 0) {
    lines.push(` {bold}{250-fg}Príjemcovia ({white-fg}${composeSelectedRecipients.length}{/white-fg}):{/250-fg}{/bold} ${tagList}`);
  } else {
    lines.push(' {244-fg}Príjemcovia: (zatiaľ nikto nevybraný — vyberte zo zoznamu nižšie){/244-fg}');
  }
  lines.push('');

  if (composeStep === 'recipients') {
    lines.push(` {208-fg}{bold}Hľadať príjemcu (meno / trieda):{/bold}{/208-fg} [ {white-fg}${composeSearchQuery}{/white-fg}{208-fg}█{/208-fg} ]`);
    lines.push('');
    lines.push(' {110-fg}NAŠEPKÁVAČ (↑ / ↓ výber  │  Enter pridať/odobrať  │  Tab text správy):{/110-fg}');

    const recs = getFilteredRecipients();
    if (recs.length === 0) {
      lines.push('   {244-fg}Žiaden príjemca nevyhovuje hľadaniu.{/244-fg}');
    } else {
      if (composeRecipientCursor >= recs.length) composeRecipientCursor = recs.length - 1;
      if (composeRecipientCursor < 0) composeRecipientCursor = 0;

      recs.forEach((r, idx) => {
        const isHere = idx === composeRecipientCursor;
        const isSel = composeSelectedRecipients.some((x) => x.id === r.id);
        const checkMark = isSel ? '{green-fg}[✓]{/green-fg}' : '{244-fg}[ ]{/244-fg}';
        const typeTag = `[${r.type_label || 'OSOBA'}]`.padEnd(9, ' ');
        const nameCol = fitPlain(r.name, 26).padEnd(26, ' ');
        const detCol = fitPlain(r.detail || '-', 28);
        const rawRow = ` ${isHere ? '▸' : ' '} ${checkMark} ${typeTag} ${nameCol} │ ${detCol}`;
        if (isHere) {
          lines.push(`{208-bg}{black-fg}{bold}${padRawLine(rawRow, 70)}{/bold}{/black-fg}{/208-bg}`);
        } else {
          lines.push(`{250-fg}${rawRow}{/250-fg}`);
        }
      });
    }

    lines.push('');
    lines.push(' {67-fg}────────────────────────────────────────────────────────────────────────{/67-fg}');
    if (composeFeedback) {
      lines.push(` ${composeFeedback}`);
    } else {
      lines.push(' {153-fg}[Enter / Medzerník]{/153-fg} Pridať/Odobrať   │   {153-fg}[Backspace]{/153-fg} Zmazať tag   │   {153-fg}[Tab]{/153-fg} Text správy   │   {153-fg}[Esc]{/153-fg} Zrušiť');
    }
  } else {
    // Step: Body
    lines.push(' {208-fg}{bold}Text správy:{/bold}{/208-fg}   {110-fg}[Tab: vrátiť sa k úprave príjemcov]{/110-fg}');
    lines.push(' {67-fg}┌──────────────────────────────────────────────────────────────────────┐{/67-fg}');

    const bodyDisplay = composeBody || '';
    const bodyLines = wrapTextToLines(bodyDisplay + '█', 68);
    for (let i = 0; i < Math.max(5, bodyLines.length); i++) {
      const lineText = fitPlain(bodyLines[i] || '', 68).padEnd(68, ' ');
      lines.push(` {67-fg}│{/67-fg} {white-fg}${lineText}{/white-fg} {67-fg}│{/67-fg}`);
    }
    lines.push(' {67-fg}└──────────────────────────────────────────────────────────────────────┘{/67-fg}');
    lines.push('');

    if (composeExecuting) {
      lines.push(` {yellow-fg}{bold}⏳ Odosielam správu pre ${composeSelectedRecipients.length} príjemcov...{/bold}{/yellow-fg}`);
    } else if (composeFeedback) {
      lines.push(` ${composeFeedback}`);
    } else {
      lines.push(' {white-fg}{117-bg}{bold} [ ENTER / Ctrl+S ] ODOSLAŤ SPRÁVU {/bold}{/117-bg}{/white-fg}   {244-fg}[Tab: Príjemcovia │ Esc: Zrušiť]{/244-fg}');
    }
  }

  composeModal.setContent(lines.join('\n'));
}

function executeSendMessage() {
  if (!composeSelectedRecipients || composeSelectedRecipients.length === 0 || composeExecuting) {
    composeFeedback = '{red-fg}Vyberte aspoň jedného príjemcu pred odoslaním.{/red-fg}';
    renderComposeModal();
    screen.render();
    return;
  }
  if (!composeBody.trim()) {
    composeFeedback = '{red-fg}Zadajte text správy pred odoslaním.{/red-fg}';
    renderComposeModal();
    screen.render();
    return;
  }

  composeExecuting = true;
  composeFeedback = null;
  renderComposeModal();
  screen.render();

  const recipientIds = composeSelectedRecipients.map((r) => r.id).join(';');
  const args = [
    'send-message',
    '--recipient', recipientIds,
    '--body', composeBody.trim(),
  ];

  runPythonAction(args, (success, result) => {
    composeExecuting = false;
    if (success && result && result.success) {
      composeFeedback = `{green-fg}{bold}✓ ${result.message || 'Správa bola úspešne odoslaná!'}{/bold}{/green-fg}`;
      renderComposeModal();
      screen.render();
      setTimeout(() => {
        closeComposeModal();
        fetchEdupageData();
      }, 1200);
    } else {
      const err = (result && (result.error || result.message)) || 'Odoslanie správy zlyhalo.';
      composeFeedback = `{red-fg}{bold}✗ ${err}{/bold}{/red-fg}`;
      renderComposeModal();
      screen.render();
    }
  });
}

function handleModalKeypress(ch, key) {
  if (!activeModal || !key) return;

  const isEnterKey = key.name === 'enter' || key.name === 'return' || ch === '\r' || ch === '\n';
  if (isEnterKey) {
    if (Date.now() - lastModalEnterAt < 220) {
      return;
    }
    lastModalEnterAt = Date.now();
  }

  if (activeModal === 'confirm_lunch') {
    if (key.name === 'escape' || key.name === 'n' || key.name === 'q') {
      closeConfirmLunchModal();
      return;
    }
    if (isEnterKey || key.name === 'y') {
      executeConfirmLunchAction();
      return;
    }
    return;
  }

  if (activeModal === 'compose_message') {
    if (key.name === 'escape') {
      closeComposeModal();
      return;
    }

    if (composeStep === 'recipients') {
      const recs = getFilteredRecipients();
      if (key.name === 'up' || (key.name === 'k' && key.ctrl)) {
        if (composeRecipientCursor > 0) composeRecipientCursor -= 1;
        renderComposeModal();
        screen.render();
        return;
      }
      if (key.name === 'down' || (key.name === 'j' && key.ctrl)) {
        if (composeRecipientCursor < recs.length - 1) composeRecipientCursor += 1;
        renderComposeModal();
        screen.render();
        return;
      }
      if (isEnterKey || (key.name === 'space' && composeSearchQuery.length === 0)) {
        if (recs[composeRecipientCursor]) {
          const target = recs[composeRecipientCursor];
          const existIdx = composeSelectedRecipients.findIndex((x) => x.id === target.id);
          if (existIdx >= 0) {
            composeSelectedRecipients.splice(existIdx, 1);
            composeFeedback = `{yellow-fg}Odobraný príjemca: ${target.name}{/yellow-fg}`;
          } else {
            composeSelectedRecipients.push(target);
            composeFeedback = `{green-fg}Pridaný príjemca: ${target.name}{/green-fg}`;
          }
          composeSearchQuery = '';
          composeRecipientCursor = 0;
          renderComposeModal();
          screen.render();
        }
        return;
      }
      if (key.name === 'tab') {
        if (composeSelectedRecipients.length > 0) {
          composeStep = 'body';
          composeFeedback = null;
        } else {
          composeFeedback = '{yellow-fg}Vyberte aspoň jedného príjemcu.{/yellow-fg}';
        }
        renderComposeModal();
        screen.render();
        return;
      }
      if (key.name === 'backspace') {
        if (composeSearchQuery.length > 0) {
          composeSearchQuery = composeSearchQuery.slice(0, -1);
          composeRecipientCursor = 0;
        } else if (composeSelectedRecipients.length > 0) {
          const popped = composeSelectedRecipients.pop();
          composeFeedback = `{yellow-fg}Odobraný príjemca: ${popped.name}{/yellow-fg}`;
        }
        renderComposeModal();
        screen.render();
        return;
      }
      if (key.name === 'delete' || (key.ctrl && key.name === 'u')) {
        if (composeSearchQuery.length > 0) {
          composeSearchQuery = '';
        } else {
          composeSelectedRecipients = [];
          composeFeedback = '{yellow-fg}Zoznam príjemcov bol vyprázdnený.{/yellow-fg}';
        }
        composeRecipientCursor = 0;
        renderComposeModal();
        screen.render();
        return;
      }
      if (ch && !key.ctrl && !key.meta && ch.length === 1 && ch.charCodeAt(0) >= 32) {
        composeSearchQuery += ch;
        composeRecipientCursor = 0;
        renderComposeModal();
        screen.render();
        return;
      }
    } else if (composeStep === 'body') {
      if (key.name === 'tab') {
        composeStep = 'recipients';
        renderComposeModal();
        screen.render();
        return;
      }
      if ((key.ctrl && key.name === 's') || isEnterKey) {
        executeSendMessage();
        return;
      }
      if (key.name === 'backspace') {
        composeBody = composeBody.slice(0, -1);
        renderComposeModal();
        screen.render();
        return;
      }
      if (key.name === 'delete' || (key.ctrl && key.name === 'u')) {
        composeBody = '';
        renderComposeModal();
        screen.render();
        return;
      }
      if (ch && !key.ctrl && !key.meta && ch.length === 1 && ch.charCodeAt(0) >= 32) {
        composeBody += ch;
        renderComposeModal();
        screen.render();
        return;
      }
    }
  }
}

// ==============================================================================
// Keyboard Handlers & Two-Level Navigation (Topbar <-> Card Sidebar)
// ==============================================================================

function isMessagesSearchActive() {
  return activeTabIndex === 3 && navFocus === 'card' && msgSubFocus === 'search';
}

// Handle typing inside the Tab 4 Search Box and Tab 5 Star Ratings
screen.on('keypress', (ch, key) => {
  if (activeModal) {
    handleModalKeypress(ch, key);
    return;
  }

  // If on Tab 5 card (Lunches), typing numbers 1-5 immediately sets stars!
  if (activeTabIndex === 4 && navFocus === 'card') {
    const rawDigit = ch || (key && key.name);
    const digit = parseInt(rawDigit, 10);
    if (digit >= 1 && digit <= 5) {
      lunchSubFocus = 'rating';
      if (lunchRatingField === 'quantity') {
        lunchRatingQuantity = digit;
      } else {
        lunchRatingQuality = digit;
      }
      updateFooter();
      renderLunchesCard();
      screen.render();
      return;
    }
  }

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

// Direct Number Tab Switching [1 - 5] or Rating Star Selection on Tab 5
screen.key(['1', '2', '3', '4', '5'], (ch, key) => {
  if (activeModal) return;
  if (isMessagesSearchActive()) return;

  const rawDigit = ch || (key && key.name);
  const digit = parseInt(rawDigit, 10);

  if (activeTabIndex === 4 && navFocus === 'card') {
    if (digit >= 1 && digit <= 5) {
      lunchSubFocus = 'rating';
      if (lunchRatingField === 'quantity') {
        lunchRatingQuantity = digit;
      } else {
        lunchRatingQuality = digit;
      }
      updateFooter();
      renderLunchesCard();
      screen.render();
      return;
    }
  }

  const tabIdx = digit - 1;
  if (tabIdx >= 0 && tabIdx < TABS.length) {
    switchTab(tabIdx);
  }
});

// Bracket Tab Switching always available when not typing in search box
screen.key(['['], () => {
  if (activeModal || isMessagesSearchActive()) return;
  switchTab((activeTabIndex - 1 + TABS.length) % TABS.length);
});
screen.key([']'], () => {
  if (activeModal || isMessagesSearchActive()) return;
  switchTab((activeTabIndex + 1) % TABS.length);
});

// Quick Search Activation on Tab 4 with '/' or 'f'
screen.key(['/', 'f'], () => {
  if (activeModal) return;
  if (activeTabIndex === 3 && !isMessagesSearchActive()) {
    navFocus = 'card';
    msgSubFocus = 'search';
    updateHeader();
    updateFooter();
    renderMessagesCard();
    screen.render();
  }
});

// Compose Message Shortcut on Tab 4 with 'm' or 'c'
screen.key(['m', 'c'], () => {
  if (activeModal || isMessagesSearchActive()) return;
  if (activeTabIndex === 3) {
    openComposeMessageModal();
  }
});

// Left / Right Arrows: Switch Tabs when on Topbar; operate inside Card when in Sidebar/Feed
screen.key(['left', 'h'], (_, key) => {
  if (activeModal || isMessagesSearchActive()) return;
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
  } else if (activeTabIndex === 4 && navFocus === 'card') {
    lunchSubFocus = 'sidebar';
    updateFooter();
    renderLunchesCard();
    screen.render();
  } else {
    switchTab((activeTabIndex - 1 + TABS.length) % TABS.length);
  }
});

screen.key(['right', 'l'], () => {
  if (activeModal || isMessagesSearchActive()) return;
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
  } else if (activeTabIndex === 4 && navFocus === 'card') {
    if (lunchSubFocus === 'sidebar') {
      lunchSubFocus = 'button';
      updateFooter();
      renderLunchesCard();
      screen.render();
    }
  } else {
    switchTab((activeTabIndex + 1) % TABS.length);
  }
});

// PageUp / PageDown for fast scrolling through earlier notifications
screen.key(['pageup'], () => {
  if (activeModal) return;
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
  if (activeModal) return;
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
  if (activeModal) return;
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
    const maxFilterIdx = MESSAGE_CATEGORIES.length + 2;
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
  } else if (activeTabIndex === 4) {
    const days = getLunchesDays();
    if (navFocus === 'topbar') {
      navFocus = 'card';
      lunchSubFocus = 'sidebar';
      updateHeader();
      updateFooter();
      renderLunchesCard();
      screen.render();
    } else if (lunchSubFocus === 'sidebar') {
      if (lunchDayCursor < days.length - 1) {
        lunchDayCursor += 1;
        renderLunchesCard();
        screen.render();
      }
    } else if (lunchSubFocus === 'button') {
      lunchSubFocus = 'rating';
      lunchRatingField = 'quality';
      updateFooter();
      renderLunchesCard();
      screen.render();
    } else if (lunchSubFocus === 'rating') {
      if (lunchRatingField === 'quality') {
        lunchRatingField = 'quantity';
        renderLunchesCard();
        screen.render();
      }
    }
  }
});

// Up Arrow: Move cursor up inside Card Sidebar/Feed; exit back to Topbar from top item
screen.key(['up', 'k'], (_, key) => {
  if (activeModal) return;
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
  } else if (activeTabIndex === 4 && navFocus === 'card') {
    if (lunchSubFocus === 'rating') {
      if (lunchRatingField === 'quantity') {
        lunchRatingField = 'quality';
        renderLunchesCard();
        screen.render();
      } else {
        lunchSubFocus = 'button';
        updateFooter();
        renderLunchesCard();
        screen.render();
      }
    } else if (lunchSubFocus === 'button') {
      navFocus = 'topbar';
      updateHeader();
      updateFooter();
      renderLunchesCard();
      screen.render();
    } else if (lunchSubFocus === 'sidebar') {
      if (lunchDayCursor > 0) {
        lunchDayCursor -= 1;
        renderLunchesCard();
        screen.render();
      } else {
        navFocus = 'topbar';
        updateHeader();
        updateFooter();
        renderLunchesCard();
        screen.render();
      }
    }
  }
});

// Enter / Space: Activate or toggle checkbox inside Sidebar
screen.key(['enter', 'space'], (_, key) => {
  if (activeModal) return;
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
  } else if (activeTabIndex === 4 && navFocus === 'card') {
    if (lunchSubFocus === 'button') {
      const days = getLunchesDays();
      const day = days[lunchDayCursor] || days[0];
      if (day && day.has_meal) {
        const actionType = day.ordered_meal ? 'signoff' : 'order';
        openConfirmLunchModal(day, actionType);
      }
    } else if (lunchSubFocus === 'rating') {
      executeSubmitRating();
    }
  }
});

// Tab / Shift-Tab widget focus cycling inside Monitor tab or Tab 4 sub-areas
screen.key(['tab'], () => {
  if (activeModal) return;
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
  if (activeTabIndex === 4) {
    navFocus = 'card';
    if (lunchSubFocus === 'sidebar') {
      lunchSubFocus = 'button';
    } else if (lunchSubFocus === 'button') {
      lunchSubFocus = 'rating';
      lunchRatingField = 'quality';
    } else if (lunchSubFocus === 'rating') {
      if (lunchRatingField === 'quality') {
        lunchRatingField = 'quantity';
      } else {
        lunchRatingField = 'quality';
        lunchSubFocus = 'sidebar';
      }
    }
    updateFooter();
    renderLunchesCard();
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
  if (activeModal) return;
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
  if (activeTabIndex === 4) {
    navFocus = 'card';
    if (lunchSubFocus === 'rating') {
      if (lunchRatingField === 'quantity') {
        lunchRatingField = 'quality';
      } else {
        lunchSubFocus = 'button';
      }
    } else if (lunchSubFocus === 'button') {
      lunchSubFocus = 'sidebar';
    } else if (lunchSubFocus === 'sidebar') {
      lunchSubFocus = 'rating';
      lunchRatingField = 'quantity';
    }
    updateFooter();
    renderLunchesCard();
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

// Refresh (ignored when typing into search box or modals)
screen.key(['r'], () => {
  if (activeModal) return;
  if (!isMessagesSearchActive()) fetchEdupageData();
});

// Quit (Esc exits modal, or search input first, then exits)
screen.key(['escape'], () => {
  if (Date.now() - lastModalClosedAt < 350) {
    return;
  }
  if (activeModal) {
    if (activeModal === 'confirm_lunch') closeConfirmLunchModal();
    else if (activeModal === 'compose_message') closeComposeModal();
    return;
  }
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
  if (activeModal) return;
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
