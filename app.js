#!/usr/bin/env node
/**
 * EduPage CLI - btop-style Terminal Monitor
 * Modern full-screen responsive TUI with live Braille graphs, bar charts, gauges and tables.
 */

const blessed = require('blessed');
const contrib = require('blessed-contrib');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('os');
const fsp = require('fs');

// Initialize Blessed Screen
const screen = blessed.screen({
  smartCSR: true,
  title: 'EDUPAGE BTOP MONITOR',
  fullUnicode: true,
  dockBorders: true,
});

// 12x12 Responsive Layout Grid
const grid = new contrib.grid({ rows: 12, cols: 12, screen: screen });

// State
let dashboardData = getPlaceholderData();
let activeView = 'home'; // 'home' | 'grades'
let lessonProgressTimer = null;

// ==============================================================================
// Widgets Setup (Home Dashboard)
// ==============================================================================

// 1. Header Box (System / Session Bar)
const headerBox = grid.set(0, 0, 2, 12, blessed.box, {
  tags: true,
  border: { type: 'line' },
  style: {
    border: { fg: 'cyan' },
    fg: 'white',
  },
});

// 2. Marks Trend Graph (Braille curve)
const lineGraph = grid.set(2, 0, 4, 6, contrib.line, {
  label: ' MARKS TREND (GPA HISTORY) ',
  showLegend: true,
  xPadding: 3,
  xLabelPadding: 2,
  wholeNumbersOnly: false,
  minY: 1.0,
  maxY: 3.5,
  border: { type: 'line', fg: 'cyan' },
  style: {
    line: 'cyan',
    text: 'white',
    baseline: 'black',
    border: { fg: 'cyan' },
  },
});

// 3. Marks Distribution (Bar Chart)
const barGraph = grid.set(6, 0, 3, 6, contrib.bar, {
  label: ' MARKS DISTRIBUTION (1 - 5) ',
  barWidth: 6,
  barSpacing: 4,
  xOffset: 3,
  maxHeight: 12,
  border: { type: 'line', fg: 'cyan' },
  style: {
    border: { fg: 'cyan' },
    text: 'white',
    barBgColor: 'cyan',
  },
});

// 4. Today's Timetable Table
const timetableTable = grid.set(2, 6, 5, 6, contrib.table, {
  keys: true,
  interactive: true,
  label: ' TODAY TIMETABLE ',
  width: '100%',
  height: '100%',
  border: { type: 'line', fg: 'cyan' },
  columnSpacing: 2,
  columnWidth: [3, 11, 16, 7, 13, 11],
  headers: ['#', 'TIME', 'SUBJECT', 'ROOM', 'TEACHER', 'STATUS'],
  style: {
    border: { fg: 'cyan' },
    header: { fg: 'cyan', bold: true },
    cell: { fg: 'white', selectedFg: 'black', selectedBg: 'cyan' },
  },
});

// 5. Current Lesson Progress Gauge
const lessonGauge = grid.set(7, 6, 2, 6, contrib.gauge, {
  label: ' CURRENT LESSON PROGRESS ',
  stroke: 'cyan',
  fill: 'white',
  border: { type: 'line', fg: 'cyan' },
  style: {
    border: { fg: 'cyan' },
  },
});

// 6. Cafeteria & Today's Lunch
const lunchBox = grid.set(9, 0, 2, 6, blessed.box, {
  label: ' TODAY CAFETERIA & LUNCH ',
  tags: true,
  border: { type: 'line' },
  style: {
    border: { fg: 'cyan' },
    fg: 'white',
  },
});

// 7. Tasks & Deadlines
const tasksTable = grid.set(9, 6, 2, 6, contrib.table, {
  keys: true,
  interactive: true,
  label: ' PENDING TASKS & DEADLINES ',
  border: { type: 'line', fg: 'cyan' },
  columnSpacing: 2,
  columnWidth: [10, 8, 12, 24],
  headers: ['DUE', 'TYPE', 'AUTHOR', 'ASSIGNMENT'],
  style: {
    border: { fg: 'cyan' },
    header: { fg: 'cyan', bold: true },
    cell: { fg: 'white', selectedFg: 'black', selectedBg: 'cyan' },
  },
});

// 8. Bottom Navigation Bar
const footerBox = grid.set(11, 0, 1, 12, blessed.box, {
  tags: true,
  style: {
    bg: 'cyan',
    fg: 'black',
    bold: true,
  },
});

// ==============================================================================
// Full Screen Grades Overlay
// ==============================================================================

const fullGradesBox = blessed.box({
  parent: screen,
  top: 0,
  left: 0,
  width: '100%',
  height: '100%',
  hidden: true,
  border: { type: 'line' },
  style: {
    border: { fg: 'cyan' },
    bg: 'black',
  },
});

const fullGradesSummary = blessed.box({
  parent: fullGradesBox,
  top: 0,
  left: 0,
  width: '100%-2',
  height: 3,
  tags: true,
  border: { type: 'line' },
  style: {
    border: { fg: 'cyan' },
    fg: 'white',
  },
});

const fullGradesTable = contrib.table({
  parent: fullGradesBox,
  keys: true,
  interactive: true,
  top: 3,
  left: 0,
  width: '100%-2',
  height: '100%-6',
  border: { type: 'line', fg: 'cyan' },
  columnSpacing: 2,
  columnWidth: [11, 20, 14, 8, 24, 22],
  headers: ['DATE', 'SUBJECT', 'MARK', 'WEIGHT', 'ASSIGNMENT', 'NOTE / TEACHER'],
  style: {
    border: { fg: 'cyan' },
    header: { fg: 'cyan', bold: true },
    cell: { fg: 'white', selectedFg: 'black', selectedBg: 'cyan' },
  },
});

const fullGradesFooter = blessed.box({
  parent: fullGradesBox,
  bottom: 0,
  left: 0,
  width: '100%-2',
  height: 1,
  tags: true,
  content: ' {bold}[ESC / b / 1]{/bold} Back to Monitor   {bold}[UP/DOWN]{/bold} Scroll Table   {bold}[q]{/bold} Quit',
  style: {
    bg: 'cyan',
    fg: 'black',
  },
});

// ==============================================================================
// Rendering & Update Functions
// ==============================================================================

function updateHeader() {
  const now = new Date();
  const timeStr = now.toTimeString().split(' ')[0];
  const dateStr = now.toISOString().split('T')[0];

  const user = dashboardData.user || 'Jakub Gallik';
  const school = dashboardData.school || 'ssnd.edupage.org';
  const nextBell = dashboardData.next_bell || '-';
  const lastRefresh = dashboardData.time || timeStr;

  headerBox.setContent(
    ` {bold}{cyan-fg}EDUPAGE BTOP MONITOR [v1.2]{/cyan-fg}{/bold}               {green-fg}[ONLINE]{/green-fg}\n` +
    ` USER: {bold}${user}{/bold} | HOST: {cyan-fg}${school}{/cyan-fg} | DATE: ${dateStr} | TIME: {bold}${timeStr}{/bold} | NEXT BELL: {yellow-fg}${nextBell}{/yellow-fg} | REFRESH: ${lastRefresh}`
  );
}

function updateWidgets() {
  updateHeader();

  // 1. Line Graph (Marks trend)
  const trend = dashboardData.trend || { x: ['01.10', '15.10', '01.11', '15.11'], y: [1.0, 1.25, 1.35, 1.45] };
  if (trend.x && trend.x.length > 0) {
    lineGraph.setData([
      {
        title: 'GPA Trend',
        x: trend.x,
        y: trend.y,
        style: { line: 'cyan' },
      },
    ]);
  }

  // 2. Bar Graph (Distribution 1-5)
  const dist = dashboardData.distribution || { titles: ['1', '2', '3', '4', '5'], data: [12, 6, 2, 0, 0] };
  barGraph.setData({
    titles: dist.titles,
    data: dist.data,
  });

  // 3. Timetable Table
  const ttRows = (dashboardData.timetable || []).map((l) => [
    l.period || '-',
    l.time || '-',
    l.subject || '-',
    l.room || '-',
    l.teacher || '-',
    l.status === 'CURRENT' ? '>> CURRENT' : (l.status === 'NEXT' ? '> NEXT' : `[${l.status}]`),
  ]);
  timetableTable.setData({
    headers: ['#', 'TIME', 'SUBJECT', 'ROOM', 'TEACHER', 'STATUS'],
    data: ttRows.length > 0 ? ttRows : [['-', '-', 'No scheduled lessons', '-', '-', '-']],
  });

  // 4. Lesson Progress Gauge
  const prog = dashboardData.lesson_progress || 0;
  lessonGauge.setPercent(prog);

  // 5. Lunch Box
  const lunch = dashboardData.lunches;
  if (lunch) {
    let lines = [];
    const statusCol = lunch.ordered_meal ? '{green-fg}' : '{red-fg}';
    lines.push(` STATUS: ${statusCol}{bold}[${lunch.status || 'ORDERED: ' + lunch.ordered_meal}]{/bold}{/}`);
    if (lunch.serving) lines.push(` Serving: {dim}${lunch.serving}{/dim}`);
    if (lunch.menus && lunch.menus.length > 0) {
      lunch.menus.slice(0, 3).forEach((m) => {
        const sel = m.selected ? '{green-fg}>>{/green-fg} ' : '   ';
        lines.push(`${sel}{bold}[${m.number}]{/bold} ${m.name.slice(0, 48)}`);
      });
    }
    lunchBox.setContent(lines.join('\n'));
  } else {
    lunchBox.setContent(' {dim}No cafeteria data for today.{/dim}');
  }

  // 6. Tasks Table
  const taskRows = (dashboardData.tasks || []).map((t) => [
    t.date || '-',
    t.type || 'TASK',
    t.author || '-',
    (t.text || '-').slice(0, 32),
  ]);
  tasksTable.setData({
    headers: ['DUE', 'TYPE', 'AUTHOR', 'ASSIGNMENT'],
    data: taskRows.length > 0 ? taskRows : [['-', 'INFO', 'System', 'No pending tasks or deadlines']],
  });

  // 7. Footer Box
  const gpa = dashboardData.gpa || '-';
  const totalMarks = dashboardData.total_marks || 0;
  footerBox.setContent(
    `  [1] ALL GRADES (${totalMarks} marks, GPA: ${gpa})    [2] TIMETABLE    [r] REFRESH    [q] QUIT`
  );

  // 8. Full Grades Overlay Update
  const subjectsSummary = (dashboardData.subjects || [])
    .map((s) => `{bold}${s.name.slice(0, 10)}{/bold}: ${s.avg}`)
    .join('  |  ');
  fullGradesSummary.setContent(
    ` {bold}{cyan-fg}ALL GRADES OVERVIEW{/cyan-fg}{/bold}  |  TOTAL: {bold}${totalMarks}{/bold}  |  OVERALL GPA: {bold}${gpa}{/bold}\n` +
    ` ${subjectsSummary || 'No subject data'}`
  );

  const allGradesRows = (dashboardData.all_grades || []).map((g) => [
    g.date || '-',
    g.subject || '-',
    g.grade || '-',
    g.weight || '-',
    (g.title || '-').slice(0, 24),
    (g.comment || '-').slice(0, 22),
  ]);
  fullGradesTable.setData({
    headers: ['DATE', 'SUBJECT', 'MARK', 'WEIGHT', 'ASSIGNMENT', 'NOTE / TEACHER'],
    data: allGradesRows.length > 0 ? allGradesRows : [['-', '-', '-', '-', 'No grades recorded', '-']],
  });

  screen.render();
}

function showFullGrades() {
  activeView = 'grades';
  fullGradesBox.show();
  fullGradesTable.focus();
  screen.render();
}

function hideFullGrades() {
  activeView = 'home';
  fullGradesBox.hide();
  timetableTable.focus();
  screen.render();
}

// ==============================================================================
// Data Synchronization (Python Bridge)
// ==============================================================================

function fetchEdupageData(callback) {
  footerBox.setContent('  [...] Fetching live EduPage data in background...');
  screen.render();

  // Find python executable (prefer .venv)
  const isWin = process.platform === 'win32';
  const venvPy = path.join(__dirname, '.venv', isWin ? 'Scripts' : 'bin', isWin ? 'python.exe' : 'python');
  const pythonCmd = fsp.existsSync(venvPy) ? venvPy : (isWin ? 'python' : 'python3');

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
    if (code === 0 && stdoutData.trim()) {
      try {
        const parsed = JSON.parse(stdoutData.trim());
        dashboardData = parsed;
        // Save cache for instantaneous subsequent launches
        try {
          const cachePath = path.join(fs.homedir(), '.edupage', 'dashboard_cache.json');
          fsp.writeFileSync(cachePath, JSON.stringify(parsed, null, 2), 'utf-8');
        } catch (e) {}
      } catch (err) {}
    }
    updateWidgets();
    if (callback) callback();
  });
}

function loadLocalCacheIfExists() {
  try {
    const cachePath = path.join(fs.homedir(), '.edupage', 'dashboard_cache.json');
    if (fsp.existsSync(cachePath)) {
      const cached = JSON.parse(fsp.readFileSync(cachePath, 'utf-8'));
      if (cached && cached.user) {
        dashboardData = cached;
      }
    }
  } catch (e) {}
}

function getPlaceholderData() {
  return {
    user: 'Jakub Gallik',
    subdomain: 'ssnd',
    school: 'ssnd.edupage.org',
    date: new Date().toISOString().split('T')[0],
    time: new Date().toTimeString().split(' ')[0],
    next_bell: '09:40 [BREAK]',
    lesson_progress: 55,
    gpa: '1.45',
    total_marks: 24,
    trend: {
      x: ['01.10', '12.10', '24.10', '04.11', '16.11'],
      y: [1.1, 1.25, 1.35, 1.4, 1.45],
    },
    distribution: {
      titles: ['1', '2', '3', '4', '5'],
      data: [13, 7, 3, 1, 0],
    },
    subjects: [
      { name: 'Matematika', count: 6, avg: '1.33' },
      { name: 'Slovenský jazyk', count: 5, avg: '1.60' },
      { name: 'Anglický jazyk', count: 4, avg: '1.25' },
      { name: 'Informatika', count: 5, avg: '1.00' },
      { name: 'Fyzika', count: 4, avg: '1.75' },
    ],
    timetable: [
      { period: '1', time: '08:00-08:45', subject: 'Slovenský jazyk', room: 'U204', teacher: 'Mgr. Nováková', status: 'OK' },
      { period: '2', time: '08:55-09:40', subject: 'Matematika', room: 'U102', teacher: 'Mgr. Horváth', status: 'CURRENT' },
      { period: '3', time: '09:55-10:40', subject: 'Anglický jazyk', room: 'U105', teacher: 'Ing. Kováč', status: 'NEXT' },
      { period: '4', time: '10:50-11:35', subject: 'Informatika', room: 'INF1', teacher: 'RNDr. Čierny', status: 'OK' },
      { period: '5', time: '11:45-12:30', subject: 'Telesná výchova', room: 'TEL', teacher: 'Mgr. Balog', status: 'CANCELLED' },
    ],
    lunches: {
      title: 'Obed',
      ordered_meal: 'A',
      status: 'ORDERED: A',
      serving: '11:30 - 13:30',
      menus: [
        { number: '1', name: 'Polievka šošovicová so zeleninou', allergens: '1, 9', selected: false },
        { number: 'A', name: 'Kurací plátok na prírodno, ryža, šalát', allergens: '1, 7', selected: true },
        { number: 'B', name: 'Cestoviny so syrovou omáčkou a brokolicou', allergens: '1, 3, 7', selected: false },
      ],
    },
    tasks: [
      { date: '2026-11-24', type: 'HOMEWORK', author: 'Mgr. Horváth', text: 'Príklady 14-22 zo zbierky úloh' },
      { date: '2026-11-25', type: 'BIG_EXAM', author: 'Ing. Kováč', text: 'Polročný test z gramatiky Unit 1-4' },
    ],
    all_grades: [],
  };
}

// ==============================================================================
// Keyboard Handlers & Screen Events
// ==============================================================================

screen.key(['escape', 'q', 'C-c'], () => {
  if (activeView === 'grades') {
    hideFullGrades();
  } else {
    process.exit(0);
  }
});

screen.key(['1', 'g'], () => {
  if (activeView === 'home') {
    showFullGrades();
  } else {
    hideFullGrades();
  }
});

screen.key(['b'], () => {
  if (activeView === 'grades') {
    hideFullGrades();
  }
});

screen.key(['r'], () => {
  fetchEdupageData();
});

screen.on('resize', () => {
  updateWidgets();
});

// ==============================================================================
// App Initialization
// ==============================================================================

// 1. Load local cache first for instant UI response
loadLocalCacheIfExists();

// 2. Render initial frame
updateWidgets();
timetableTable.focus();

// 3. Live clock tick every second
setInterval(() => {
  updateHeader();
  screen.render();
}, 1000);

// 4. Fetch live data from EduPage
fetchEdupageData();
