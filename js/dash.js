(() => {
  const page = document.documentElement.getAttribute("data-page");
  if (page !== "dash") return;

  const CONFIG = {
    DASH_ENDPOINT: "https://n8n.clinicaexperts.com.br/webhook/dash",
    MONEY_IS_CENTS: true,
  };

  const formatters = {
    int: new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 0 }),
    percent2: new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
    brl: new Intl.NumberFormat("pt-BR", {
      style: "currency",
      currency: "BRL",
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }),
    // Sem centavos (útil para KPIs grandes que podem quebrar linha)
    brl0: new Intl.NumberFormat("pt-BR", {
      style: "currency",
      currency: "BRL",
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }),
  };

  const utils = {
    getDateString(date) {
      const y = date.getFullYear();
      const m = String(date.getMonth() + 1).padStart(2, "0");
      const d = String(date.getDate()).padStart(2, "0");
      return `${y}-${m}-${d}`;
    },
    today() {
      return this.getDateString(new Date());
    },
    firstDayOfMonth() {
      const d = new Date();
      d.setDate(1);
      return this.getDateString(d);
    },
    toNumber(v) {
      const n = Number(v);
      return Number.isFinite(n) ? n : 0;
    },
    normalizeMoney(v) {
      const n = this.toNumber(v);
      return CONFIG.MONEY_IS_CENTS ? n / 100 : n;
    },
    formatBRL(v) {
      return formatters.brl.format(this.toNumber(v));
    },
    formatBRL0(v) {
      return formatters.brl0.format(this.toNumber(v));
    },
    formatInt(v) {
      return formatters.int.format(this.toNumber(v));
    },
    formatPercent(v, decimals = 2) {
      const n = this.toNumber(v);
      return (
        new Intl.NumberFormat("pt-BR", {
          minimumFractionDigits: decimals,
          maximumFractionDigits: decimals,
        }).format(n) + "%"
      );
    },
    dateLabel(dateLike) {
      if (!dateLike) return "";
      const s = String(dateLike);
      return s.length >= 10 ? s.slice(0, 10) : s;
    },
    formatDayMonth(dateLike) {
      const iso = this.dateLabel(dateLike);
      const parts = iso.split("-");
      if (parts.length >= 3) {
        const mm = parts[1];
        const dd = String(parts[2]).slice(0, 2);
        return `${dd}/${mm}`;
      }
      return iso;
    },
    getCssVar(name, fallback) {
      try {
        const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
        return v || fallback;
      } catch {
        return fallback;
      }
    },
  };

  if (window.Chart && window.ChartDataLabels) {
    window.Chart.register(window.ChartDataLabels);
  }

  // =========================================================
  // Data Labels (Chart.js)
  // - até 15 pontos: mostra todos
  // - acima de 15: mostra 1 a cada 2 (mantém o último)
  // =========================================================
  function shouldShowDataLabel(ctx) {
    const count = (ctx?.chart?.data?.labels || []).length;
    if (count <= 15) return true;
    const i = ctx.dataIndex;
    return i % 2 === 0 || i === count - 1;
  }

  function dataLabelFont(ctx) {
    const count = (ctx?.chart?.data?.labels || []).length;
    return { weight: "700", size: count > 15 ? 10 : 12 };
  }

  function baseDataLabelsOptions({ datasetOffset = false } = {}) {
    return {
      color: utils.getCssVar("--color-text-primary", "#ffffff"),
      textStrokeColor: "rgba(0,0,0,0.55)",
      textStrokeWidth: 3,

      display: shouldShowDataLabel,
      anchor: "end",
      align: "top",
      clamp: true,
      clip: false,

      // Em gráficos com 2 linhas (Meta/Google) dá um deslocamento por dataset
      offset: (ctx) => {
        const count = (ctx?.chart?.data?.labels || []).length;
        const base = count > 15 ? 4 : 6;
        if (!datasetOffset) return base;
        // Ajuste pensado pro gráfico de Investimento:
        // - deixa os rótulos do Google (datasetIndex=1) mais próximos da linha amarela
        // - empurra um pouco os rótulos da Meta (datasetIndex=0) pra evitar “misturar”
        const idx = ctx.datasetIndex || 0;
        if (idx === 0) return base + (count > 15 ? 8 : 10); // Meta: mais distante
        return base; // Google: mais perto
      },

      formatter: (value) => String(Math.round(Number(value) || 0)),
      font: dataLabelFont,
    };
  }


  const $id = (id) => document.getElementById(id);

  const el = {
    entryStartInput: $id("entryStartDate"),
    entryEndInput: $id("entryEndDate"),
    applyEntryOnly: $id("applyEntryOnly"),
    clearEntryDates: $id("clearEntryDates"),

    salesCanvas: $id("salesChart"),
    cacDay: $id("cac-day"),
    cacMonth: $id("cac-month"),
    cacRange: $id("cac-range"),

    investmentCanvas: $id("investmentChart"),
    invMeta: $id("inv-meta"),
    invGoogle: $id("inv-google"),
    invTotal: $id("inv-total"),

    cplCanvas: $id("cplChart"),
    cplValue: $id("cpl-month"),
    clicksValue: $id("clicks"),
    cpcValue: $id("cpc"),
    cpmValue: $id("cpm"),

    leadsCanvas: $id("leadsChart"),
    leadsTotalValue: $id("leads-month"),
    ctrValue: $id("ctr"),
    leadsGoalValue: $id("leads-goal"),

    kpiSubscribers: $id("assistants"),
    kpiSalesDay: $id("sales-day"),
    kpiSalesMonth: $id("sales-month"),
    kpiMonthly: $id("monthly-total"),
    kpiAnnual: $id("annual-total"),
    conversionValue: $id("conversion"),
  };

  const charts = {
    investment: null,
    leadsDaily: null,
    salesDaily: null,
    cplDaily: null,
    destroy(key) {
      const c = this[key];
      if (!c) return;
      try { c.destroy(); } catch { }
      this[key] = null;
    },
  };

  const state = {
    abortController: null,
    totals: {
      investment_total: 0,
      leads_total: 0,
      clicks_total: 0,
      impressions_total: 0,
    },
  };

  const api = {
    buildUrl(base, paramsObj) {
      const params = new URLSearchParams();
      Object.entries(paramsObj || {}).forEach(([k, v]) => {
        if (v !== null && v !== undefined && String(v).trim() !== "") params.set(k, v);
      });
      params.set("_ts", Date.now());
      return `${base}?${params.toString()}`;
    },
    async fetchDash(paramsObj, signal) {
      const url = this.buildUrl(CONFIG.DASH_ENDPOINT, paramsObj);
      const res = await fetch(url, { signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    },
  };

  function getFirstResultObject(res) {
    if (res && typeof res === "object" && Array.isArray(res.res) && res.res[0] && typeof res.res[0] === "object") {
      return res.res[0];
    }
    if (Array.isArray(res) && res[0] && typeof res[0] === "object") return res[0];
    if (res && typeof res === "object") return res;
    return null;
  }

  function normalizeRows(payload) {
    if (Array.isArray(payload)) {
      const first = payload[0];
      if (first && typeof first === "object" && Array.isArray(first.investment)) return first.investment;
      return payload;
    }
    if (!payload || typeof payload !== "object") return [];
    if (Array.isArray(payload.investment)) return payload.investment;

    if (Array.isArray(payload.res)) {
      const first = payload.res[0];
      if (first && Array.isArray(first.investment)) return first.investment;
      if (Array.isArray(first)) return first;
    }

    if (Array.isArray(payload.data)) return payload.data;
    if (Array.isArray(payload.items)) return payload.items;
    if (Array.isArray(payload.result)) return payload.result;

    const vals = Object.values(payload);
    if (vals.length && vals.every((v) => v && typeof v === "object" && !Array.isArray(v))) return vals;
    return [];
  }

  function renderKpis(res) {
    const first = getFirstResultObject(res);
    if (!first) return;

    const kpis = first.kpis || {};

    if (el.cacDay) el.cacDay.textContent = utils.formatBRL(kpis.cac_diario);
    if (el.cacMonth) el.cacMonth.textContent = utils.formatBRL(kpis.cac_mes);
    if (el.cacRange) el.cacRange.textContent = utils.formatBRL(kpis.cac_range);

    const subs = (Array.isArray(first.subscribers) ? first.subscribers : [])[0] || {};
    if (el.kpiSubscribers) el.kpiSubscribers.textContent = utils.formatInt(subs.total_subscribers);

    if (el.kpiSalesDay) el.kpiSalesDay.textContent = utils.formatInt(kpis.vendas_hoje);
    if (el.kpiSalesMonth) el.kpiSalesMonth.textContent = utils.formatInt(kpis.vendas_mes);
    if (el.kpiMonthly) el.kpiMonthly.textContent = utils.formatInt(kpis.planos_mensais);
    if (el.kpiAnnual) el.kpiAnnual.textContent = utils.formatInt(kpis.planos_anuais);

    if (el.conversionValue) el.conversionValue.textContent = utils.formatPercent(kpis.conversion_pct, 2);
  }

  function renderInvestment(res) {
    const first = getFirstResultObject(res);
    const investmentRaw =
      first && Array.isArray(first.investment) ? first.investment :
        (res && Array.isArray(res.investment) ? res.investment : (res?.investment ?? res));

    const rows = normalizeRows(investmentRaw)
      .map((r) => ({
        created_at: r?.created_at,
        facebook_amount: utils.normalizeMoney(r?.facebook_amount),
        google_amount: utils.normalizeMoney(r?.google_amount),
      }))
      .filter((r) => r.created_at)
      .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));

    const totalFacebook = rows.reduce((acc, r) => acc + utils.toNumber(r.facebook_amount), 0);
    const totalGoogle = rows.reduce((acc, r) => acc + utils.toNumber(r.google_amount), 0);
    const total = totalFacebook + totalGoogle;

    state.totals.investment_total = total;

    // KPIs de investimento sem centavos (evita quebra de linha em valores altos)
    if (el.invMeta) el.invMeta.textContent = utils.formatBRL0(totalFacebook);
    if (el.invGoogle) el.invGoogle.textContent = utils.formatBRL0(totalGoogle);
    if (el.invTotal) el.invTotal.textContent = utils.formatBRL0(total);

    if (!el.investmentCanvas || !window.Chart) return;

    const labels = rows.map((r) => utils.formatDayMonth(r.created_at));
    const facebookData = rows.map((r) => utils.toNumber(r.facebook_amount));
    const googleData = rows.map((r) => utils.toNumber(r.google_amount));

    charts.destroy("investment");

    const facebookColor = utils.getCssVar("--color-facebook-dark", "#3b82f6");
    const googleColor = utils.getCssVar("--color-google-dark", "#f59e0b");

    charts.investment = new window.Chart(el.investmentCanvas.getContext("2d"), {
      type: "line",
      data: {
        labels,
        datasets: [
          {
            label: "Meta",
            data: facebookData,
            tension: 0.25,
            borderColor: facebookColor,
            backgroundColor: facebookColor,
            borderWidth: 2,
            pointRadius: 2,
            pointHoverRadius: 4,
            fill: false,
          },
          {
            label: "Google",
            data: googleData,
            tension: 0.35,
            borderColor: googleColor,
            backgroundColor: googleColor,
            borderWidth: 2,
            pointRadius: 2,
            pointHoverRadius: 4,
            fill: false,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: "index", intersect: false },
        plugins: {
          legend: { display: true, position: "bottom" },
          tooltip: {
            callbacks: {
              label: (ctx) => `${ctx.dataset.label}: ${utils.formatBRL(ctx.parsed?.y)}`,
            },
          },
          datalabels: baseDataLabelsOptions({ datasetOffset: true }),
        },
        layout: {
          padding: { top: 18 },
        },
        scales: {
          x: { grid: { display: false }, ticks: { maxRotation: 0, autoSkip: true } },
          y: { beginAtZero: true, grace: "12%", ticks: { callback: (v) => utils.formatBRL(v) } },
        },
      },
    });
  }

  function renderLeads(res) {
    const first = getFirstResultObject(res);
    if (!first) return;

    const kpis = first.kpis || {};

    const totalLeads = utils.toNumber(kpis.total_leads);
    state.totals.leads_total = totalLeads;
    if (el.leadsTotalValue) el.leadsTotalValue.textContent = utils.formatInt(totalLeads);

    const clicksTotal = utils.toNumber(kpis.clicks_total);
    state.totals.clicks_total = clicksTotal;
    if (el.clicksValue) el.clicksValue.textContent = utils.formatInt(clicksTotal);

    const impressionsTotal = utils.toNumber(kpis.impressions_total);
    state.totals.impressions_total = impressionsTotal;

    if (el.ctrValue) el.ctrValue.textContent = utils.formatPercent(kpis.ctr_pct, 2);
    if (el.leadsGoalValue) el.leadsGoalValue.textContent = utils.formatPercent(kpis.meta_pct, 2);

    const leadsDaily = Array.isArray(first.leads_daily) ? first.leads_daily : [];
    renderLeadsDailyChart(leadsDaily);
  }

  function renderSales(res) {
    const first = getFirstResultObject(res);
    if (!first) return;

    const salesDaily = Array.isArray(first.sales_daily) ? first.sales_daily : [];
    renderSalesDailyChart(salesDaily);
  }

  function renderCostKpis() {
    const inv = utils.toNumber(state.totals.investment_total);
    const leads = utils.toNumber(state.totals.leads_total);
    const clicks = utils.toNumber(state.totals.clicks_total);
    const impressions = utils.toNumber(state.totals.impressions_total);

    if (el.cplValue) el.cplValue.textContent = utils.formatBRL(leads > 0 ? inv / leads : 0);
    if (el.cpcValue) el.cpcValue.textContent = utils.formatBRL(clicks > 0 ? inv / clicks : 0);

    if (el.cpmValue) {
      el.cpmValue.textContent = impressions > 0 ? utils.formatBRL((inv / impressions) * 1000) : "–";
    }
  }

  function renderLeadsDailyChart(leadsDailyRaw) {
    if (!el.leadsCanvas || !window.Chart) return;

    const rows = (Array.isArray(leadsDailyRaw) ? leadsDailyRaw : [])
      .map((r) => ({ day: utils.dateLabel(r?.day), leads_count: utils.toNumber(r?.leads_count) }))
      .filter((r) => r.day)
      .sort((a, b) => String(a.day).localeCompare(String(b.day)));

    charts.destroy("leadsDaily");

    const lineColor = utils.getCssVar("--color-success-dark", "#22c55e");

    charts.leadsDaily = new window.Chart(el.leadsCanvas.getContext("2d"), {
      type: "line",
      data: {
        labels: rows.map((r) => utils.formatDayMonth(r.day)),
        datasets: [
          {
            label: "Leads",
            data: rows.map((r) => r.leads_count),
            tension: 0.25,
            borderColor: lineColor,
            backgroundColor: lineColor,
            borderWidth: 2,
            pointRadius: 2,
            pointHoverRadius: 4,
            fill: false,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: "index", intersect: false },
        plugins: {
          legend: { display: true, position: "bottom" },
          tooltip: {
            callbacks: {
              label: (ctx) => `Leads: ${utils.formatInt(ctx.parsed?.y)}`,
            },
          },
          datalabels: baseDataLabelsOptions(),
        },
        layout: {
          padding: { top: 18 },
        },
        scales: {
          x: { grid: { display: false }, ticks: { maxRotation: 0, autoSkip: true } },
          y: { beginAtZero: true, grace: "12%", ticks: { callback: (v) => utils.formatInt(v) } },
        },
      },
    });
  }

  function renderSalesDailyChart(salesDailyRaw) {
    if (!el.salesCanvas || !window.Chart) return;

    const rows = (Array.isArray(salesDailyRaw) ? salesDailyRaw : [])
      .map((r) => ({ day: utils.dateLabel(r?.day), records_count: utils.toNumber(r?.records_count) }))
      .filter((r) => r.day)
      .sort((a, b) => String(a.day).localeCompare(String(b.day)));

    charts.destroy("salesDaily");

    const lineColor = utils.getCssVar("--color-purple-dark", utils.getCssVar("--color-purple", "#7c3aed"));

    charts.salesDaily = new window.Chart(el.salesCanvas.getContext("2d"), {
      type: "line",
      data: {
        labels: rows.map((r) => utils.formatDayMonth(r.day)),
        datasets: [
          {
            label: "Vendas",
            data: rows.map((r) => r.records_count),
            tension: 0.25,
            borderColor: lineColor,
            backgroundColor: lineColor,
            borderWidth: 2,
            pointRadius: 2,
            pointHoverRadius: 4,
            fill: false,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: "index", intersect: false },
        plugins: {
          legend: { display: true, position: "bottom" },
          tooltip: {
            callbacks: {
              label: (ctx) => `Vendas: ${utils.formatInt(ctx.parsed?.y)}`,
            },
          },
          datalabels: baseDataLabelsOptions(),
        },
        layout: {
          padding: { top: 18 },
        },
        scales: {
          x: { grid: { display: false }, ticks: { maxRotation: 0, autoSkip: true } },
          y: { beginAtZero: true, grace: "12%", ticks: { callback: (v) => utils.formatInt(v) } },
        },
      },
    });
  }

  function renderCpl(res) {
    const first = getFirstResultObject(res);
    if (!first) return;

    const cplDaily = Array.isArray(first.cpl_daily) ? first.cpl_daily : [];
    renderCplDailyChart(cplDaily);
  }

  function renderCplDailyChart(cplDailyRaw) {
    if (!el.cplCanvas || !window.Chart) return;

    const rows = (Array.isArray(cplDailyRaw) ? cplDailyRaw : [])
      .map((r) => ({ day: utils.dateLabel(r?.day), cpl: utils.toNumber(r?.cpl) }))
      .filter((r) => r.day)
      .sort((a, b) => String(a.day).localeCompare(String(b.day)));

    charts.destroy("cplDaily");

    const lineColor = utils.getCssVar("--color-warning-dark", utils.getCssVar("--color-warning", "#f50b70"));

    charts.cplDaily = new window.Chart(el.cplCanvas.getContext("2d"), {
      type: "line",
      data: {
        labels: rows.map((r) => utils.formatDayMonth(r.day)),
        datasets: [
          {
            label: "CPL",
            data: rows.map((r) => r.cpl),
            tension: 0.25,
            borderColor: lineColor,
            backgroundColor: lineColor,
            borderWidth: 2,
            pointRadius: 2,
            pointHoverRadius: 4,
            fill: false,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: "index", intersect: false },
        plugins: {
          legend: { display: true, position: "bottom" },
          tooltip: {
            callbacks: {
              label: (ctx) => `CPL: ${utils.formatBRL(ctx.parsed?.y)}`,
            },
          },
          datalabels: baseDataLabelsOptions(),
        },
        layout: {
          padding: { top: 18 },
        },
        scales: {
          x: { grid: { display: false }, ticks: { maxRotation: 0, autoSkip: true } },
          y: { beginAtZero: true, grace: "12%", ticks: { callback: (v) => utils.formatBRL(v) } },
        },
      },
    });
  }

  async function sendDatesToN8n() {
    const entryStart = el.entryStartInput?.value || "";
    const entryEnd = el.entryEndInput?.value || "";
    if (!entryStart || !entryEnd) return;

    if (state.abortController) {
      try { state.abortController.abort(); } catch { }
    }
    state.abortController = new AbortController();

    const params = { entry_start: entryStart, entry_end: entryEnd };

    try {
      const res = await api.fetchDash(params, state.abortController.signal);

      renderKpis(res);
      renderInvestment(res);
      renderLeads(res);
      renderCostKpis();
      renderSales(res);
      renderCpl(res);
    } catch (err) {
      if (err?.name === "AbortError") return;
    }
  }

  function initializeDates() {
    const start = utils.firstDayOfMonth();
    const end = utils.today();
    if (el.entryStartInput) el.entryStartInput.value = start;
    if (el.entryEndInput) el.entryEndInput.value = end;
  }

  function clearDates() {
    initializeDates();
    sendDatesToN8n();
  }

  function setupEventListeners() {
    el.applyEntryOnly?.addEventListener("click", sendDatesToN8n);
    el.clearEntryDates?.addEventListener("click", clearDates);

    const onEnter = (e) => {
      if (e.key !== "Enter") return;
      sendDatesToN8n();
    };

    el.entryStartInput?.addEventListener("keypress", onEnter);
    el.entryEndInput?.addEventListener("keypress", onEnter);
  }

  function init() {
    initializeDates();
    setupEventListeners();
    sendDatesToN8n();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
