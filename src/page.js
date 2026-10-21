/**
 * The page.
 *
 * Every number on it comes from a statement DuckDB ran over the Parquet file:
 *
 *   the KPI strip     one aggregate, this year against the one before
 *   running totals    a grid whose FROM is a monthly query with window functions
 *   the charts        bound to those grids, so they follow what the grid holds
 *   the tabs          a pivot, a region-to-store drill-down, a demand pivot by
 *                     week and the order lines, each a grid over the pushdown
 *                     source: filter, sort, group, pivot, quick search and
 *                     paging are SQL
 *
 * The year is baked into each view's FROM clause, so the row groups of other
 * years are skipped by their statistics and never fetched.
 */

import { recordingConnection } from './duckdb.js';
import { LATEST_YEAR } from './config.js';
import {
  DEMAND_COLUMNS, LINE_COLUMNS, LINE_FIELDS, MONTHLY_COLUMNS, PACK_COLUMNS, REGION_COLUMNS, YEARS,
  categoryFrom, demandFrom, fmt, monthlyFrom, salesFrom, storesFrom,
} from './sales.js';

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

const num = (value) => (typeof value === 'bigint' ? Number(value) : (value == null ? null : Number(value)));

const TABS = [
  { id: 'pack', label: 'The pack', blurb: 'Revenue by category and month, totalled across and down. A pivot: the columns are the months DuckDB finds.' },
  { id: 'region', label: 'Region to store', blurb: 'Open a region to see its stores. Each level is its own GROUP BY, run when you open it.' },
  { id: 'demand', label: 'Demand by week', blurb: 'Units by product by week, the shape a demand planner works from. Open a category to see its products.' },
  { id: 'lines', label: 'Order lines', blurb: 'Every order line of the year. Search, filter, sort and page: each one is a query.' },
];

export function buildPage({ root, LG, createChart, createKPI, connection, totalLines }) {
  const built = {
    ready: false,
    year: LATEST_YEAR,
    tab: 'pack',
    grids: {},
    charts: {},
    timing: {},
    kpi: null,
    kpiValues: null,
    totalLines,
  };

  /* ---------------------------------------------------------------- */
  /* The frame                                                         */
  /* ---------------------------------------------------------------- */

  root.textContent = '';
  root.className = 'app';

  const header = el('header', 'masthead');
  const titleRow = el('div', 'title-row');
  titleRow.append(el('h1', null, 'The monthly pack, live'));
  const controls = el('div', 'head-controls');
  const yearLabel = el('label', 'year-label', 'Reporting year');
  yearLabel.htmlFor = 'year';
  const yearSelect = el('select', 'year-select');
  yearSelect.id = 'year';
  for (const year of YEARS) {
    const option = el('option', null, String(year));
    option.value = String(year);
    yearSelect.append(option);
  }
  const themeButton = el('button', 'theme-button', 'Dark theme');
  themeButton.type = 'button';
  themeButton.dataset.themeToggle = '';
  controls.append(yearLabel, yearSelect, themeButton);
  titleRow.append(controls);
  header.append(titleRow);
  const lede = el('p', 'lede');
  lede.textContent =
    'Finance closes the month on revenue, margin and orders; operations plans next month from units by product by week. '
    + `Here both read the same ${fmt.int(totalLines)} order lines of a retailer’s ten years of trading, straight from one Parquet file, `
    + 'with every total, running total, pivot and drill-down computed by DuckDB in your browser as you ask for it.';
  header.append(lede);
  root.append(header);

  const kpiHost = el('section', 'kpi-strip');
  kpiHost.setAttribute('aria-label', 'Headline figures for the reporting year');
  root.append(kpiHost);
  const kpiTiming = el('p', 'timing');
  kpiTiming.dataset.timing = 'kpi';
  root.append(kpiTiming);

  const monthCard = el('section', 'card');
  monthCard.setAttribute('aria-labelledby', 'month-title');
  const monthTitle = el('h2', null, 'Month by month: running total and period over period');
  monthTitle.id = 'month-title';
  const monthChart = el('div', 'chart-box');
  monthChart.dataset.chart = 'trend';
  const monthGridHost = el('div', 'grid-host short');
  monthGridHost.dataset.grid = 'monthly';
  const monthTiming = el('p', 'timing');
  monthTiming.dataset.timing = 'monthly';
  monthCard.append(monthTitle, el('p', 'blurb', 'Year to date, change on the month before and on the same month a year earlier: window functions in the query behind the grid, with the chart reading the grid’s rows.'), monthChart, monthGridHost, monthTiming);
  root.append(monthCard);

  const marginCard = el('section', 'card');
  marginCard.setAttribute('aria-labelledby', 'margin-title');
  const marginTitle = el('h2', null, 'Margin by category');
  marginTitle.id = 'margin-title';
  const marginBody = el('div', 'two-up');
  const marginChart = el('div', 'chart-box');
  marginChart.dataset.chart = 'margin';
  const marginGridHost = el('div', 'grid-host short');
  marginGridHost.dataset.grid = 'categories';
  marginBody.append(marginChart, marginGridHost);
  const marginTiming = el('p', 'timing');
  marginTiming.dataset.timing = 'categories';
  marginCard.append(marginTitle, marginBody, marginTiming);
  root.append(marginCard);

  const tabCard = el('section', 'card');
  tabCard.setAttribute('aria-label', 'Reports');
  const tabList = el('div', 'tabs');
  tabList.setAttribute('role', 'tablist');
  tabList.setAttribute('aria-label', 'Reports');
  const panels = {};
  const tabButtons = {};
  for (const tab of TABS) {
    const button = el('button', 'tab', tab.label);
    button.type = 'button';
    button.id = `tab-${tab.id}`;
    button.dataset.tab = tab.id;
    button.setAttribute('role', 'tab');
    button.setAttribute('aria-controls', `panel-${tab.id}`);
    button.addEventListener('click', () => { void selectTab(tab.id); });
    button.addEventListener('keydown', (event) => {
      const at = TABS.findIndex((t) => t.id === tab.id);
      const next = { ArrowRight: at + 1, ArrowLeft: at - 1, Home: 0, End: TABS.length - 1 }[event.key];
      if (next == null) return;
      event.preventDefault();
      const target = TABS[(next + TABS.length) % TABS.length];
      void selectTab(target.id);
      tabButtons[target.id].focus();
    });
    tabButtons[tab.id] = button;
    tabList.append(button);

    const panel = el('div', 'panel');
    panel.id = `panel-${tab.id}`;
    panel.dataset.panel = tab.id;
    panel.setAttribute('role', 'tabpanel');
    panel.setAttribute('aria-labelledby', `tab-${tab.id}`);
    panel.append(el('p', 'blurb', tab.blurb));
    if (tab.id === 'lines') {
      const search = el('input', 'search');
      search.type = 'search';
      search.placeholder = 'Search product, store or category';
      search.setAttribute('aria-label', 'Search order lines');
      search.dataset.search = '';
      let pending = 0;
      search.addEventListener('input', () => {
        clearTimeout(pending);
        pending = setTimeout(() => built.grids.lines?.grid.filters.quick(search.value.trim()), 250);
      });
      panel.append(search);
    }
    const host = el('div', 'grid-host tall');
    host.dataset.grid = tab.id;
    const timing = el('p', 'timing');
    timing.dataset.timing = tab.id;
    panel.append(host, timing);
    panels[tab.id] = { panel, host, timing };
    tabCard.append(panel);
  }
  tabCard.prepend(tabList);
  root.append(tabCard);

  const footer = el('footer', 'colophon');
  footer.append(
    'Data: ',
    Object.assign(el('a', null, 'Contoso Data Generator V2'), { href: 'https://github.com/sql-bi/Contoso-Data-Generator-V2-Data', rel: 'noopener' }),
    ' by SQLBI, MIT licence. Amounts in US dollars. Engine: DuckDB-Wasm. Grid: Lattice Grid.',
  );
  root.append(footer);

  /* ---------------------------------------------------------------- */
  /* Timing: what DuckDB did for each view                             */
  /* ---------------------------------------------------------------- */

  /**
   * A recording connection for one view. Statements that arrive close together
   * are one interaction; the readout says how many there were, how long the
   * engine took from the first to the last, and how many rows they ran over.
   */
  function connectionFor(key, scans) {
    const slot = built.timing[key] = { statements: 0, ms: 0, scanned: null, at: 0, first: 0, last: 0 };
    const node = key === 'kpi' ? kpiTiming : (key === 'monthly' ? monthTiming : (key === 'categories' ? marginTiming : panels[key].timing));
    return recordingConnection(connection, (entry) => {
      const now = performance.now();
      if (now - slot.last > 600) { slot.statements = 0; slot.first = now - entry.ms; slot.scanned = null; }
      slot.statements += 1;
      slot.last = now;
      slot.ms = Math.round(now - slot.first);
      if (scans && entry.matched != null) slot.scanned = entry.matched;
      node.textContent = `DuckDB: ${slot.statements} ${slot.statements === 1 ? 'statement' : 'statements'}, ${fmt.ms(slot.ms)}`
        + (slot.scanned != null ? `, ${fmt.int(slot.scanned)} rows scanned` : '');
      node.dataset.ms = String(slot.ms);
      node.dataset.statements = String(slot.statements);
      if (slot.scanned != null) node.dataset.scanned = String(slot.scanned);
      slot.sql = entry.sql;
    });
  }

  /* ---------------------------------------------------------------- */
  /* Grids                                                             */
  /* ---------------------------------------------------------------- */

  function mountGrid(key, host, { from, fields, columns, rowKey, extra = {}, scans = false, quickColumns }) {
    built.grids[key]?.grid.destroy?.();
    host.textContent = '';
    const adapter = LG.duckdbAdapter({ connection: connectionFor(key, scans), from, fields, ...(quickColumns ? { quickColumns } : {}) });
    const source = LG.createPushdownSource({
      adapter, compute: LG, pageSize: 100, aggregates: { default: 'engine-if-identical' },
    });
    const grid = LG.createGrid(host, { rowKey, columns, source, showTotalInHeader: false, ...extra });
    built.grids[key] = { grid, source, adapter };
    return built.grids[key];
  }

  function ensureChart(key, box, spec, gridKey) {
    built.charts[key]?.destroy?.();
    box.textContent = '';
    try {
      built.charts[key] = createChart({ grid: built.grids[gridKey].grid, container: box, ...spec });
    } catch (error) {
      box.append(el('p', 'chart-error', `This chart could not be drawn: ${error.message}`));
      console.error('[sales demo] chart', key, error);
    }
  }

  function mountMonthly() {
    mountGrid('monthly', monthGridHost, {
      from: monthlyFrom(built.year),
      fields: ['period', 'year', 'revenue', 'running_revenue', 'change_on_month', 'revenue_last_year', 'change_on_year', 'margin', 'orders'],
      columns: MONTHLY_COLUMNS,
      rowKey: 'period',
      extra: { sort: [{ col: 'period', dir: 'asc' }] },
    });
    ensureChart('trend', monthChart, {
      type: 'line', x: 'period', y: 'revenue', legend: false, title: `Revenue by month, ${built.year}`,
    }, 'monthly');
  }

  function mountCategories() {
    mountGrid('categories', marginGridHost, {
      from: categoryFrom(built.year),
      fields: ['category', 'revenue', 'margin', 'margin_rate'],
      columns: [
        { field: 'category', title: 'Category', layout: { width: 210 } },
        { field: 'revenue', title: 'Revenue', type: 'number', format: { style: 'currency', currency: 'USD', currencyDisplay: 'narrowSymbol', notation: 'compact', maxDecimals: 1 }, layout: { width: 100 } },
        { field: 'margin', title: 'Margin', type: 'number', format: { style: 'currency', currency: 'USD', currencyDisplay: 'narrowSymbol', notation: 'compact', maxDecimals: 1 }, layout: { width: 100 } },
        { field: 'margin_rate', title: 'Margin rate', type: 'number', format: { style: 'percent', decimals: 1 }, layout: { width: 110 } },
      ],
      rowKey: 'category',
      extra: { sort: [{ col: 'margin_rate', dir: 'desc' }] },
    });
    ensureChart('margin', marginChart, {
      type: 'horizontalBar', x: 'category', y: 'margin_rate', legend: false, title: 'Gross margin rate by category',
    }, 'categories');
  }

  const TAB_BUILDERS = {
    pack: () => mountGrid('pack', panels.pack.host, {
      from: salesFrom(built.year),
      fields: ['line_id', 'category', 'period', 'revenue'],
      columns: PACK_COLUMNS,
      rowKey: 'line_id',
      scans: true,
      extra: { pivot: { enabled: true, groupTotals: 'after', totalsLabel: 'Year' }, grandTotalRow: 'bottom', groupDefaultExpanded: 0 },
    }),
    region: () => mountGrid('region', panels.region.host, {
      from: storesFrom(built.year),
      fields: ['country', 'store', 'revenue', 'margin', 'orders', 'quantity'],
      columns: REGION_COLUMNS,
      rowKey: 'store',
      scans: true,
      extra: { grandTotalRow: 'bottom', groupDefaultExpanded: 0 },
    }),
    demand: () => mountGrid('demand', panels.demand.host, {
      from: demandFrom(built.year),
      fields: ['category', 'product', 'week', 'quantity'],
      columns: DEMAND_COLUMNS,
      rowKey: 'product',
      scans: true,
      extra: { pivot: { enabled: true, groupTotals: 'after', totalsLabel: 'Year' }, grandTotalRow: 'bottom', groupDefaultExpanded: 0 },
    }),
    lines: () => {
      const search = panels.lines.panel.querySelector('[data-search]');
      if (search) search.value = '';
      return mountGrid('lines', panels.lines.host, {
        from: salesFrom(built.year),
        fields: LINE_FIELDS,
        columns: LINE_COLUMNS,
        rowKey: 'line_id',
        scans: true,
        /* Quick search reads these three text columns, not every column of the file. */
        quickColumns: ['product', 'store', 'category'],
        extra: {
          pagination: { enabled: true, pageSize: 50, pageSizes: [25, 50, 100] },
          toolPanel: { side: 'right', panels: ['filters', 'columns'] },
          showTotalInHeader: true,
        },
      });
    },
  };

  /** Tabs whose grid is built for the current year. */
  const mounted = new Set();

  async function selectTab(id) {
    built.tab = id;
    for (const tab of TABS) {
      const on = tab.id === id;
      tabButtons[tab.id].setAttribute('aria-selected', String(on));
      tabButtons[tab.id].tabIndex = on ? 0 : -1;
      tabButtons[tab.id].classList.toggle('active', on);
      panels[tab.id].panel.hidden = !on;
    }
    if (!mounted.has(id)) {
      mounted.add(id);
      TAB_BUILDERS[id]();
    }
  }

  /* ---------------------------------------------------------------- */
  /* The KPI strip                                                     */
  /* ---------------------------------------------------------------- */

  const kpi = createKPI(kpiHost, {
    rows: [],
    rowKey: 'id',
    columns: 5,
    ariaLabel: 'Headline figures for the reporting year',
    nullText: '—',
    tiles: [
      { id: 'revenue', label: 'Revenue', aggregation: 'max', field: 'revenue', format: { type: 'compact', currency: 'USD', locale: 'en-US', decimals: 2 } },
      { id: 'margin', label: 'Gross margin', aggregation: 'max', field: 'margin', format: { type: 'compact', currency: 'USD', locale: 'en-US', decimals: 2 } },
      { id: 'marginRate', label: 'Margin rate', aggregation: 'max', field: 'marginRate', format: { type: 'percent', decimals: 1 } },
      { id: 'orders', label: 'Orders', aggregation: 'max', field: 'orders', format: { type: 'number', decimals: 0 } },
      { id: 'yoy', label: 'Revenue vs last year', aggregation: 'max', field: 'yoy', format: { type: 'percent', decimals: 1 } },
    ],
  });
  built.kpi = kpi;

  async function refreshKpi() {
    const conn = connectionFor('kpi', false);
    const result = await conn.query(
      `SELECT year, sum(revenue) AS revenue, sum(margin) AS margin, sum(orders) AS orders FROM ${salesFrom(built.year - 1, built.year)} GROUP BY year`,
    );
    const byYear = new Map(result.toArray().map((r) => { const o = r.toJSON(); return [Number(o.year), o]; }));
    const now = byYear.get(built.year);
    const before = byYear.get(built.year - 1);
    const revenue = num(now?.revenue);
    const margin = num(now?.margin);
    const prior = num(before?.revenue);
    built.kpiValues = {
      revenue, margin, marginRate: revenue ? margin / revenue : null,
      orders: num(now?.orders), yoy: prior ? revenue / prior - 1 : null,
    };
    kpi.setRows([{ id: 'now', ...built.kpiValues }]);
  }

  /* ---------------------------------------------------------------- */
  /* Year and theme                                                    */
  /* ---------------------------------------------------------------- */

  async function setYear(year) {
    built.year = year;
    yearSelect.value = String(year);
    mounted.clear();
    for (const tab of TABS) {
      built.grids[tab.id]?.grid.destroy?.();
      delete built.grids[tab.id];
      panels[tab.id].host.textContent = '';
    }
    mountMonthly();
    mountCategories();
    await Promise.all([refreshKpi(), selectTab(built.tab)]);
  }
  yearSelect.addEventListener('change', () => { void setYear(Number(yearSelect.value)); });

  const darkQuery = window.matchMedia?.('(prefers-color-scheme: dark)');
  function setTheme(theme) {
    document.documentElement.dataset.theme = theme;
    themeButton.textContent = theme === 'dark' ? 'Light theme' : 'Dark theme';
    themeButton.setAttribute('aria-pressed', String(theme === 'dark'));
    built.theme = theme;
  }
  themeButton.addEventListener('click', () => setTheme(built.theme === 'dark' ? 'light' : 'dark'));
  setTheme(darkQuery?.matches ? 'dark' : 'light');

  built.start = async () => {
    mountMonthly();
    mountCategories();
    await Promise.all([refreshKpi(), selectTab('pack')]);
  };
  built.selectTab = selectTab;
  built.setYear = setYear;
  built.destroy = () => {
    for (const { grid } of Object.values(built.grids)) grid.destroy?.();
    for (const chart of Object.values(built.charts)) chart.destroy?.();
  };
  return built;
}
