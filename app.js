const ENV_SOURCES = {
  prod: { label: "Prod", path: "data/generated/metrics_export.json" },
  dev: { label: "Dev", path: "data/generated/metrics_export.dev.json" },
};

const REFRESH_MS = 15 * 60 * 1000;

const state = {
  data: null,
  range: "24h",
  charts: {},
  env: "prod",
};

const rangeButtons = document.querySelectorAll(".range-toggle button");
const tabs = document.querySelectorAll(".tab");
const envSelect = document.getElementById("env-select");

function resolveEnv() {
  const params = new URLSearchParams(window.location.search);
  const env = params.get("env");
  return ENV_SOURCES[env] ? env : "prod";
}

function dataUrl() {
  return ENV_SOURCES[state.env]?.path || ENV_SOURCES.prod.path;
}

function parseTs(ts) {
  return new Date(ts).getTime();
}

function hoursFromRange(range) {
  if (range === "7d") return 7 * 24;
  if (range === "30d") return 30 * 24;
  return 24;
}

function withinRange(tsMs, range, nowMs) {
  const hours = hoursFromRange(range);
  const start = nowMs - hours * 60 * 60 * 1000;
  return tsMs >= start && tsMs <= nowMs;
}

function groupBy(array, keyFn) {
  const map = new Map();
  for (const item of array) {
    const key = keyFn(item);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(item);
  }
  return map;
}

function sum(array, mapper = (x) => x) {
  return array.reduce((acc, item) => acc + mapper(item), 0);
}

function formatNumber(value) {
  return new Intl.NumberFormat().format(value || 0);
}

function buildSeries(metricKey, filterFn) {
  const metricPoints = state.data?.timeseries?.[metricKey] || [];
  const nowMs = Date.now();
  const points = metricPoints
    .map((p) => ({ ...p, tsMs: parseTs(p.ts) }))
    .filter((p) => withinRange(p.tsMs, state.range, nowMs))
    .filter(filterFn || (() => true));

  const grouped = groupBy(points, (p) => p.ts);
  const labels = Array.from(grouped.keys()).sort();
  const values = labels.map((label) => sum(grouped.get(label), (p) => p.count));
  return { labels, values };
}

function buildTaggedSeries(metricKey, tagKey, filterFn) {
  const metricPoints = state.data?.timeseries?.[metricKey] || [];
  const nowMs = Date.now();
  const points = metricPoints
    .map((p) => ({ ...p, tsMs: parseTs(p.ts) }))
    .filter((p) => withinRange(p.tsMs, state.range, nowMs))
    .filter(filterFn || (() => true));

  const tags = Array.from(new Set(points.map((p) => p.tags?.[tagKey]).filter(Boolean)));
  const labels = Array.from(new Set(points.map((p) => p.ts))).sort();

  const series = tags.map((tag) => {
    const tagPoints = points.filter((p) => p.tags?.[tagKey] === tag);
    const grouped = groupBy(tagPoints, (p) => p.ts);
    const values = labels.map((label) => sum(grouped.get(label) || [], (p) => p.count));
    return { name: tag, data: values };
  });

  return { labels, series };
}

function buildTaggedStatusSeries(metricKey, tagKey, statusKey, statusValue) {
  return buildTaggedSeries(metricKey, tagKey, (p) => String(p.tags?.[statusKey]) === statusValue);
}

function updateKpis() {
  const nowMs = Date.now();
  const commandPoints = (state.data?.timeseries?.["command.invoked"] || []).filter(
    (p) => p.tags?.status === "ok"
  );
  const commandTotal = sum(
    commandPoints.filter((p) => withinRange(parseTs(p.ts), state.range, nowMs)),
    (p) => p.count
  );

  const fetchPoints = state.data?.timeseries?.["external.fetch"] || [];
  const fetchOk = sum(
    fetchPoints.filter(
      (p) => p.tags?.status === "ok" && withinRange(parseTs(p.ts), state.range, nowMs)
    ),
    (p) => p.count
  );
  const fetchErr = sum(
    fetchPoints.filter(
      (p) => p.tags?.status === "error" && withinRange(parseTs(p.ts), state.range, nowMs)
    ),
    (p) => p.count
  );

  const dmPoints = state.data?.timeseries?.["dm.fail"] || [];
  const dmTotal = sum(
    dmPoints.filter((p) => withinRange(parseTs(p.ts), state.range, nowMs)),
    (p) => p.count
  );
  const dmFeatures = new Set(
    dmPoints.filter((p) => withinRange(parseTs(p.ts), state.range, nowMs)).map((p) => p.tags?.feature)
  );

  const schedPoints = state.data?.timeseries?.["scheduler.run"] || [];
  const schedOk = sum(
    schedPoints.filter(
      (p) => p.tags?.status === "ok" && withinRange(parseTs(p.ts), state.range, nowMs)
    ),
    (p) => p.count
  );
  const schedErr = sum(
    schedPoints.filter(
      (p) => p.tags?.status === "error" && withinRange(parseTs(p.ts), state.range, nowMs)
    ),
    (p) => p.count
  );

  document.getElementById("kpi-commands").textContent = formatNumber(commandTotal);
  document.getElementById("kpi-commands-meta").textContent = `${formatNumber(commandTotal)} events`;
  document.getElementById("kpi-fetch").textContent = formatNumber(fetchOk + fetchErr);
  document.getElementById("kpi-fetch-meta").textContent = `${formatNumber(fetchOk)} ok • ${formatNumber(fetchErr)} error`;
  document.getElementById("kpi-dm").textContent = formatNumber(dmTotal);
  document.getElementById("kpi-dm-meta").textContent = `${dmFeatures.size} features impacted`;
  document.getElementById("kpi-scheduler").textContent = formatNumber(schedOk + schedErr);
  document.getElementById("kpi-scheduler-meta").textContent = `${formatNumber(schedOk)} ok • ${formatNumber(schedErr)} error`;
}

function renderTopList(containerId, rows) {
  const container = document.getElementById(containerId);
  container.innerHTML = "";
  if (!rows.length) {
    container.innerHTML = '<div class="row"><span class="row__label">No data</span></div>';
    return;
  }
  rows.forEach((row) => {
    const div = document.createElement("div");
    div.className = "row";
    div.innerHTML = `<span class="row__label">${row.label}</span><span class="row__value">${formatNumber(
      row.value
    )}</span>`;
    container.appendChild(div);
  });
}

function updateTopTables() {
  const nowMs = Date.now();
  const commandPoints = state.data?.timeseries?.["command.invoked"] || [];
  const commandTotals = new Map();
  commandPoints
    .filter((p) => p.tags?.status === "ok" && withinRange(parseTs(p.ts), state.range, nowMs))
    .forEach((p) => {
      const key = p.tags?.cmd || "unknown";
      commandTotals.set(key, (commandTotals.get(key) || 0) + p.count);
    });
  const topCommands = Array.from(commandTotals.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([cmd, count]) => ({ label: cmd, value: count }));
  renderTopList("top-commands", topCommands);

  const errorTotals = new Map();
  Object.entries(state.data?.timeseries || {}).forEach(([metric, points]) => {
    points
      .filter((p) => withinRange(parseTs(p.ts), state.range, nowMs))
      .forEach((p) => {
        const status = String(p.tags?.status || "").toLowerCase();
        if (metric === "dm.fail" || status === "error") {
          const label = metric === "dm.fail"
            ? `dm.fail (${p.tags?.feature || "unknown"})`
            : `${metric} (${p.tags?.status || "error"})`;
          errorTotals.set(label, (errorTotals.get(label) || 0) + p.count);
        }
      });
  });

  const topErrors = Array.from(errorTotals.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([label, count]) => ({ label, value: count }));
  renderTopList("top-errors", topErrors);
}

function initChart(id) {
  const el = document.getElementById(id);
  if (!el) return null;
  if (state.charts[id]) return state.charts[id];
  const chart = echarts.init(el);
  state.charts[id] = chart;
  return chart;
}

function setAreaChart(chart, { labels, values, name, color }) {
  chart.setOption({
    grid: { left: 20, right: 20, top: 20, bottom: 30, containLabel: true },
    xAxis: {
      type: "category",
      data: labels.map((l) => new Date(l).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })),
      axisLabel: { color: "#9ca3af" },
      axisLine: { lineStyle: { color: "rgba(148,163,184,0.2)" } },
    },
    yAxis: {
      type: "value",
      axisLabel: { color: "#9ca3af" },
      splitLine: { lineStyle: { color: "rgba(148,163,184,0.1)" } },
    },
    tooltip: { trigger: "axis" },
    series: [
      {
        name,
        type: "line",
        data: values,
        smooth: true,
        areaStyle: { color: color || "rgba(56,189,248,0.25)" },
        lineStyle: { color: color || "#38bdf8" },
        symbol: "none",
      },
    ],
  });
}

function setStackedArea(chart, labels, series) {
  chart.setOption({
    grid: { left: 20, right: 20, top: 20, bottom: 30, containLabel: true },
    tooltip: { trigger: "axis" },
    legend: {
      textStyle: { color: "#9ca3af" },
      top: 0,
    },
    xAxis: {
      type: "category",
      data: labels.map((l) => new Date(l).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })),
      axisLabel: { color: "#9ca3af" },
      axisLine: { lineStyle: { color: "rgba(148,163,184,0.2)" } },
    },
    yAxis: {
      type: "value",
      axisLabel: { color: "#9ca3af" },
      splitLine: { lineStyle: { color: "rgba(148,163,184,0.1)" } },
    },
    series: series.map((s) => ({
      name: s.name,
      type: "line",
      stack: "total",
      smooth: true,
      data: s.data,
      symbol: "none",
      areaStyle: { opacity: 0.2 },
    })),
  });
}

function setBarChart(chart, labels, series) {
  chart.setOption({
    grid: { left: 20, right: 20, top: 20, bottom: 40, containLabel: true },
    tooltip: { trigger: "axis" },
    legend: { textStyle: { color: "#9ca3af" } },
    xAxis: {
      type: "category",
      data: labels.map((l) => new Date(l).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })),
      axisLabel: { color: "#9ca3af" },
      axisLine: { lineStyle: { color: "rgba(148,163,184,0.2)" } },
    },
    yAxis: {
      type: "value",
      axisLabel: { color: "#9ca3af" },
      splitLine: { lineStyle: { color: "rgba(148,163,184,0.1)" } },
    },
    series: series.map((s) => ({
      name: s.name,
      type: "bar",
      data: s.data,
      stack: "total",
    })),
  });
}

function updateCharts() {
  const commands = buildSeries("command.invoked", (p) => p.tags?.status === "ok");
  const fetchOk = buildSeries("external.fetch", (p) => p.tags?.status === "ok");
  const fetchErr = buildSeries("external.fetch", (p) => p.tags?.status === "error");

  const commandsChart = initChart("chart-commands");
  if (commandsChart) {
    setAreaChart(commandsChart, {
      labels: commands.labels,
      values: commands.values,
      name: "Commands",
      color: "#38bdf8",
    });
  }

  const fetchChart = initChart("chart-fetch");
  if (fetchChart) {
    fetchChart.setOption({
      grid: { left: 20, right: 20, top: 20, bottom: 30, containLabel: true },
      tooltip: { trigger: "axis" },
      legend: { textStyle: { color: "#9ca3af" } },
      xAxis: {
        type: "category",
        data: fetchOk.labels.map((l) => new Date(l).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })),
        axisLabel: { color: "#9ca3af" },
        axisLine: { lineStyle: { color: "rgba(148,163,184,0.2)" } },
      },
      yAxis: {
        type: "value",
        axisLabel: { color: "#9ca3af" },
        splitLine: { lineStyle: { color: "rgba(148,163,184,0.1)" } },
      },
      series: [
        {
          name: "OK",
          type: "line",
          data: fetchOk.values,
          smooth: true,
          symbol: "none",
          lineStyle: { color: "#34d399" },
          areaStyle: { color: "rgba(52,211,153,0.15)" },
        },
        {
          name: "Error",
          type: "line",
          data: fetchErr.values,
          smooth: true,
          symbol: "none",
          lineStyle: { color: "#f43f5e" },
          areaStyle: { color: "rgba(244,63,94,0.15)" },
        },
      ],
    });
  }

  const mixData = buildTaggedSeries("command.invoked", "cmd", (p) => p.tags?.status === "ok");
  const topMix = mixData.series.sort((a, b) => sum(b.data) - sum(a.data)).slice(0, 6);
  const commandMixChart = initChart("chart-command-mix");
  if (commandMixChart) {
    setStackedArea(commandMixChart, mixData.labels, topMix);
  }

  const fetchSources = buildTaggedSeries("external.fetch", "source", (p) => p.tags?.status === "ok");
  const fetchErrors = buildTaggedSeries("external.fetch", "source", (p) => p.tags?.status === "error");
  const fetchSourceChart = initChart("chart-fetch-source");
  if (fetchSourceChart) {
    const labels = Array.from(new Set([...fetchSources.labels, ...fetchErrors.labels])).sort();
    const merged = [];
    fetchSources.series.forEach((series) => merged.push({ name: `${series.name} OK`, data: series.data }));
    fetchErrors.series.forEach((series) => merged.push({ name: `${series.name} Error`, data: series.data }));
    setBarChart(fetchSourceChart, labels, merged);
  }

  const schedulerData = buildTaggedSeries("scheduler.run", "name");
  const schedulerChart = initChart("chart-scheduler");
  if (schedulerChart) {
    const okSeries = buildTaggedStatusSeries("scheduler.run", "name", "status", "ok");
    const errSeries = buildTaggedStatusSeries("scheduler.run", "name", "status", "error");
    const labels = Array.from(new Set([...okSeries.labels, ...errSeries.labels])).sort();
    const series = [
      ...okSeries.series.map((s) => ({ name: `${s.name} OK`, data: s.data })),
      ...errSeries.series.map((s) => ({ name: `${s.name} Error`, data: s.data })),
    ];
    setBarChart(schedulerChart, labels, series);
  }

  const dmData = buildTaggedSeries("dm.fail", "feature");
  const dmChart = initChart("chart-dm");
  if (dmChart) {
    setStackedArea(dmChart, dmData.labels, dmData.series);
  }
}

function updateLastUpdated() {
  const label = document.getElementById("last-updated");
  const envLabel = document.getElementById("env-label");
  if (envLabel) envLabel.textContent = ENV_SOURCES[state.env]?.label || "Prod";
  if (!state.data?.meta?.generated_at) {
    label.textContent = "No data";
    return;
  }
  const dt = new Date(state.data.meta.generated_at);
  label.textContent = `Updated ${dt.toLocaleString()}`;
}

async function loadData() {
  const res = await fetch(`${dataUrl()}?t=${Date.now()}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  state.data = data;
  updateLastUpdated();
  updateKpis();
  updateTopTables();
  updateCharts();
}

function attachHandlers() {
  if (envSelect) {
    envSelect.value = state.env;
    envSelect.addEventListener("change", () => {
      state.env = envSelect.value;
      const params = new URLSearchParams(window.location.search);
      if (state.env === "prod") {
        params.delete("env");
      } else {
        params.set("env", state.env);
      }
      const query = params.toString();
      const nextUrl = query ? `${window.location.pathname}?${query}` : window.location.pathname;
      window.history.replaceState(null, "", nextUrl);
      void loadData();
    });
  }

  rangeButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      rangeButtons.forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      state.range = btn.dataset.range;
      updateKpis();
      updateTopTables();
      updateCharts();
    });
  });

  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      tabs.forEach((t) => t.classList.remove("active"));
      document.querySelectorAll(".tab-panel").forEach((panel) => panel.classList.remove("active"));
      tab.classList.add("active");
      const panel = document.getElementById(tab.dataset.tab);
      panel.classList.add("active");
      updateCharts();
    });
  });

  window.addEventListener("resize", () => {
    Object.values(state.charts).forEach((chart) => chart.resize());
  });
}

async function boot() {
  state.env = resolveEnv();
  attachHandlers();
  try {
    await loadData();
  } catch (err) {
    console.error("Failed to load metrics", err);
    document.getElementById("last-updated").textContent = "Failed to load";
  }
  setInterval(loadData, REFRESH_MS);
}

boot();
