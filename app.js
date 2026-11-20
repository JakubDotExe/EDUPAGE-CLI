#!/usr/bin/env node
/**
 * EduPage CLI - btop-style Terminal Monitor
 * Full-featured high-contrast interactive TUI with multi-tab navigation,
 * real-time schedule, Slovak GPA analytics, cafeteria menu, and homework viewer.
 */

const blessed = require('blessed');
const contrib = require('blessed-contrib');
const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

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
// Styles & Theme
// ==============================================================================

const STYLES = {
  table: {
    keys: true,
    vi: true,
    interactive: true,
    border: { type: 'line', fg: 'grey' },
    style: {
      border: { fg: 'grey' },
      header: { fg: 'cyan', bold: true },
      cell: { fg: 'white', selectedFg: 'black', selectedBg: 'white' },
    },
  },
};

// ==============================================================================
// Top Header Box
const headerBox = blessed.box({
  parent: screen,
  top: 0,
  left: 0,
  width: '100%',
  height: 5,
  tags: true,
  border: { type: 'line', fg: 'grey' },
  label: ' [ EDUPAGE BTOP MONITOR ] ',
  style: {
    border: { fg: 'grey' },
    fg: 'white',
    bg: 'black',
  },
});

// Bottom Footer Box
const footerBox = blessed.box({
  parent: screen,
  bottom: 0,
  left: 0,
  width: '100%',
  height: 3,
  tags: true,
  border: { type: 'line', fg: 'grey' },
  label: ' [ OVLÁDANIE & SKRATKY ] ',
  style: {
    border: { fg: 'grey' },
    fg: 'white',
    bg: 'black',
  },
  content: ' {bold}[1-5]{/bold} Výber karty  │  {bold}[← / →]{/bold} Prepínanie kariet  │  {bold}[Tab]{/bold} Prepínanie okien  │  {bold}[↑ / ↓]{/bold} Rolovanie  │  {bold}[r]{/bold} Obnoviť  │  {bold}[q / Esc]{/bold} Koniec',
});

// Content Container (Between Header and Footer)
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

// 1. Marks Trend (Braille line)
const lineGraph = monitorGrid.set(0, 0, 5, 6, contrib.line, {
  label: ' [ VÝVOJ PRIEMERU (GPA TREND) ] ',
  showLegend: true,
  xPadding: 2,
  xLabelPadding: 2,
  wholeNumbersOnly: false,
  minY: 1.0,
  maxY: 3.5,
  border: { type: 'line', fg: 'grey' },
  style: {
    line: 'green',
    text: 'white',
    baseline: 'grey',
    border: { fg: 'grey' },
  },
});

// 2. Marks Distribution (Bar chart)
const barGraph = monitorGrid.set(5, 0, 4, 6, contrib.bar, {
  label: ' [ ROZDELENIE ZNÁMOK (1 - 5) ] ',
  barWidth: 5,
  barSpacing: 3,
  xOffset: 2,
  maxHeight: 20,
  border: { type: 'line', fg: 'grey' },
  style: {
    border: { fg: 'grey' },
    text: 'white',
    barBgColor: 'cyan',
  },
});

// 3. Mini Lunch Box
const miniLunchBox = monitorGrid.set(9, 0, 3, 6, blessed.box, {
  label: ' [ DNEŠNÝ OBED ] ',
  tags: true,
  border: { type: 'line', fg: 'grey' },
  style: {
    border: { fg: 'grey' },
    fg: 'white',
    bg: 'black',
  },
});

// 4. Timetable Table
const timetableTable = monitorGrid.set(0, 6, 6, 6, contrib.table, {
  ...STYLES.table,
  label: ' [ DNEŠNÝ ROZVRH HODÍN ] ',
  columnSpacing: 1,
  columnWidth: [3, 11, 23, 16, 9],
  headers: ['#', 'ČAS', 'PREDMET', 'UČITEĽ', 'STAV'],
});

// 5. Current Lesson Progress Gauge
const lessonGauge = monitorGrid.set(6, 6, 2, 6, contrib.gauge, {
  label: ' [ PRIEBEH HODINY / PRESTÁVKA ] ',
  stroke: 'green',
  fill: 'white',
  border: { type: 'line', fg: 'grey' },
  style: {
    border: { fg: 'grey' },
  },
});

// 6. Mini Tasks Table
const miniTasksTable = monitorGrid.set(8, 6, 4, 6, contrib.table, {
  ...STYLES.table,
  label: ' [ AKTUÁLNE ZADANIA A PÍSOMKY ] ',
  columnSpacing: 1,
  columnWidth: [10, 10, 14, 20],
  headers: ['TERMÍN', 'TYP', 'UČITEĽ', 'ZADANIE'],
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

// Subjects Table (Left, 4 cols)
const subjectsTable = gradesGrid.set(0, 0, 12, 4, contrib.table, {
  ...STYLES.table,
  label: ' [ PREDMETY ] ',
  columnSpacing: 1,
  columnWidth: [8, 8, 8, 6],
  headers: ['PREDMET', 'PRIEMER', 'ÚSPECH', 'POČET'],
});

// Full Grades Table (Right, 8 cols)
const fullGradesTable = gradesGrid.set(0, 4, 12, 8, contrib.table, {
  ...STYLES.table,
  label: ' [ VŠETKY ZAPÍSANÉ ZNÁMKY ] ',
  columnSpacing: 1,
  columnWidth: [10, 8, 14, 5, 26, 20],
  headers: ['DÁTUM', 'PREDMET', 'ZNÁMKA', 'VÁHA', 'ZADANIE / UDALOSŤ', 'POZNÁMKA / UČITEĽ'],
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

const fullTimetableTable = contrib.table({
  parent: viewTimetable,
  top: 0,
  left: 0,
  width: '100%',
  height: '100%',
  ...STYLES.table,
  label: ' [ KOMPLETNÝ ROZVRH HODÍN SO SKUPINAMI A UČEBNAMI ] ',
  columnSpacing: 2,
  columnWidth: [4, 13, 26, 20, 16, 11, 26],
  headers: ['HOD', 'ČAS', 'PREDMET', 'UČITEĽ', 'UČEBŇA', 'STAV', 'TÉMA HODINY'],
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
  border: { type: 'line', fg: 'grey' },
  label: ' [ ŠKOLSKÁ JEDÁLEŇ ] ',
  style: {
    border: { fg: 'grey' },
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
  ...STYLES.table,
  label: ' [ JEDÁLNY LÍSTOK NA DNES ] ',
  columnSpacing: 2,
  columnWidth: [4, 46, 8, 14, 11],
  headers: ['#', 'NÁZOV JEDLA', 'GRAMÁŽ', 'ALERGÉNY', 'OBJEDNANÉ'],
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
  border: { type: 'line', fg: 'grey' },
  label: ' [ PREHĽAD POVINNOSTÍ ] ',
  style: {
    border: { fg: 'grey' },
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
  ...STYLES.table,
  label: ' [ ZOZNAM DOMÁCICH ÚLOH, TESTOV A ZADANÍ ] ',
  columnSpacing: 2,
  columnWidth: [12, 14, 22, 50],
  headers: ['TERMÍN', 'TYP', 'UČITEĽ', 'TEXT ZADANIA'],
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

// Focus indicator styling
function setupTableFocus(tableWidget) {
  if (!tableWidget || !tableWidget.rows) return;
  tableWidget.rows.on('focus', () => {
    tableWidget.style.border.fg = 'green';
    screen.render();
  });
  tableWidget.rows.on('blur', () => {
    tableWidget.style.border.fg = 'grey';
    screen.render();
  });
}

// disabled
// disabled
// disabled
// disabled
// disabled
// disabled
// disabled

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
  const totalMarks = dashboardData.total_marks || 0;

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
    return `{grey-fg}[${label.trim()}]{/grey-fg}`;
  }).join('   ');

  headerBox.setContent(
    ` {bold}POUŽÍVATEĽ:{/bold} ${user}  │  {bold}PRIEMER (GPA):{/bold} {green-fg}{bold}${gpa}{/bold}{/green-fg}  │  {bold}PROSPECH:{/bold} ${standingColor}{bold}${standing}{/bold}{/}  │  {bold}ZNÁMOK:{/bold} ${totalMarks}  │  {bold}ZVONENIE:{/bold} {yellow-fg}${nextBell}{/yellow-fg}  │  {bold}ČAS:{/bold} ${timeStr}  ${statusBadge}\n` +
    ` {bold}KARTY:{/bold}  ${tabButtons}`
  );
}

function updateWidgets() {
  updateHeader();

  // 1. Line Graph
  const trend = dashboardData.trend || { x: [], y: [] };
  if (trend.x && trend.x.length > 0) {
    lineGraph.setData([
      {
        title: 'GPA Trend',
        x: trend.x,
        y: trend.y,
        style: { line: 'green' },
      },
    ]);
  }

  // 2. Bar Graph
  const dist = dashboardData.distribution || { titles: ['1', '2', '3', '4', '5'], data: [0, 0, 0, 0, 0] };
  barGraph.setData({
    titles: dist.titles,
    data: dist.data,
  });

  // 3. Timetable Table (Monitor)
  const ttList = dashboardData.timetable || [];
  let currentLesson = null;
  const ttRows = ttList.map((l) => {
    let st = l.status || 'OK';
    if (st === 'CURRENT') {
      st = '>> TERAZ';
      currentLesson = l;
    } else if (st === 'NEXT') {
      st = '> NA RAD';
    } else if (st === 'DONE') {
      st = 'HOTOVO';
    } else if (st === 'CANCELLED') {
      st = 'ODPADLA';
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
    data: ttRows.length > 0 ? ttRows : [['-', '-', 'Dnes nie sú naplánované žiadne hodiny', '-', '-']],
  });

  // 4. Lesson Progress Gauge
  const prog = dashboardData.lesson_progress || 0;
  if (currentLesson) {
    lessonGauge.setLabel(' [ PREBIEHA: ' + currentLesson.subject + ' (' + prog + '%) ] ');
  } else {
    lessonGauge.setLabel(' [ PRESTÁVKA / VOĽNO (DO ' + (dashboardData.next_bell || '-') + ') ] ');
  }
  lessonGauge.setPercent(prog);

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
    (g.title || '-').slice(0, 26),
    (g.comment || '-').slice(0, 20),
  ]);
  fullGradesTable.setData({
    headers: ['DÁTUM', 'PREDMET', 'ZNÁMKA', 'VÁHA', 'ZADANIE / UDALOSŤ', 'POZNÁMKA / UČITEĽ'],
    data: allGradesRows.length > 0 ? allGradesRows : [['-', '-', '-', '-', 'Žiadne zapísané známky', '-']],
  });

  // 8. Timetable View
  const fullTtRows = ttList.map((l) => [
    l.period || '-',
    l.time || '-',
    l.subject || '-',
    l.teacher || '-',
    l.room || '-',
    l.status === 'CURRENT' ? '>> TERAZ' : (l.status === 'NEXT' ? '> NA RADE' : (l.status === 'DONE' ? 'HOTOVO' : `[${l.status}]`)),
    l.topic || '-',
  ]);
  fullTimetableTable.setData({
    headers: ['HOD', 'ČAS', 'PREDMET', 'UČITEĽ', 'UČEBŇA', 'STAV', 'TÉMA HODINY'],
    data: fullTtRows.length > 0 ? fullTtRows : [['-', '-', 'Dnes nie sú naplánované žiadne hodiny', '-', '-', '-', '-']],
  });

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

// Left / Right Tab Switching
screen.key(['left', 'h', '['], () => {
  switchTab((activeTabIndex - 1 + TABS.length) % TABS.length);
});

screen.key(['right', 'l', ']'], () => {
  switchTab((activeTabIndex + 1) % TABS.length);
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
  screen.render();
}, 1000);

fetchEdupageData();
