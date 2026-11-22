const byId = id => document.getElementById(id);
const dateFormat = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone: "UTC" });
const shortDate = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

function dateLabel(value, format = dateFormat) {
  return value ? format.format(new Date(value + "T00:00:00Z")) : "Unknown";
}

function element(tag, className, label) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (label !== undefined) node.textContent = label;
  return node;
}

function rounded(value) {
  return Math.round(value).toString();
}

function shownValue(row) {
  const prefix = row.factor === 1 ? "" : "≈";
  return prefix + rounded(row.normalized);
}

function resultButton(row, className, label, select) {
  const button = element("button", className, label);
  button.type = "button";
  button.dataset.result = row.id;
  button.setAttribute("aria-controls", "evidence");
  button.addEventListener("click", () => select(row, true));
  return button;
}

function chart(results, select) {
  const root = byId("chart");
  if (!results.length) {
    root.append(element("p", "empty", "No comparable results with a known collection date."));
    return;
  }
  const plot = element("div", "plot");
  root.append(plot);
  const values = results.map(row => row.normalized);
  const lowest = Math.max(0, Math.floor((Math.min(...values) - 5) / 10) * 10);
  const highest = Math.ceil((Math.max(...values) + 5) / 10) * 10;
  const tickStep = Math.max(10, Math.ceil((highest - lowest) / 60) * 10);
  const y = value => (highest - value) / (highest - lowest);
  for (let value = lowest; value <= highest; value += tickStep) {
    const axis = element("div", "axis");
    axis.setAttribute("aria-hidden", "true");
    axis.style.top = y(value) * 100 + "%";
    axis.append(element("span", "tick", value.toString()));
    plot.append(axis);
  }
  const canvas = element("canvas");
  canvas.setAttribute("aria-hidden", "true");
  plot.append(canvas);
  const dates = results.map(row => Date.parse(row.collected));
  const period = dates.at(-1) - dates[0];
  const points = results.map((row, index) => {
    const x = period ? 0.12 + 0.76 * (dates[index] - dates[0]) / period : 0.5;
    const point = resultButton(row, "point", undefined, select);
    point.setAttribute("aria-label", dateLabel(row.collected) + ", " + row.provider + ", " + shownValue(row) + " mg/dL");
    point.style.left = x * 100 + "%";
    point.style.top = y(row.normalized) * 100 + "%";
    point.append(element("span", "point-value", shownValue(row)));
    const label = element("span", "point-date", dateLabel(row.collected, shortDate));
    label.setAttribute("aria-hidden", "true");
    label.style.left = x * 100 + "%";
    plot.append(point, label);
    return [x, y(row.normalized)];
  });
  const draw = () => {
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.round(plot.clientWidth * ratio);
    canvas.height = Math.round(plot.clientHeight * ratio);
    const ctx = canvas.getContext("2d");
    ctx.strokeStyle = "#1d694f";
    ctx.lineWidth = 2.5 * ratio;
    ctx.beginPath();
    for (const [x, y] of points) ctx.lineTo(x * canvas.width, y * canvas.height);
    ctx.stroke();
  };
  new ResizeObserver(draw).observe(plot);
}

function showSource(row, source, label) {
  const page = source?.page ?? 1;
  const marker = byId("line-marker");
  const image = byId("page-image");
  byId("source-label").textContent = source
    ? label + " · Page " + page + ", line " + source.line
    : "Report preview · Page " + page;
  const imagePath = "/reports/" + row.id + "-" + page + ".png";
  if (image.getAttribute("src") !== imagePath) image.src = imagePath;
  image.alt = row.provider + " report, page " + page + " of " + row.pageCount;
  marker.hidden = !source;
  byId("excerpt").hidden = !source;
  byId("excerpt").textContent = source?.text ?? "";
  byId("pdf-link").href = "/reports/" + row.id + ".pdf#page=" + page;
  if (source) {
    const [left, top, width, height] = source.box.map(value => (value * 100) + "%");
    Object.assign(marker.style, { left, top, width, height });
  }
}

function dateRow(title, date, provenance, source, row) {
  const wrapper = element("div", "date-row");
  const value = element("dd");
  if (source) {
    const button = element("button", "", dateLabel(date));
    button.type = "button";
    const label = title === "Collected" ? "Collection date" : "Report date";
    button.setAttribute("aria-label", "Show " + label.toLowerCase() + " in the report");
    button.addEventListener("click", () => showSource(row, source, label));
    value.append(button);
  } else {
    value.textContent = dateLabel(date);
  }
  value.append(element("span", "", provenance));
  wrapper.append(element("dt", "", title), value);
  return wrapper;
}

function renderEvidence(row) {
  byId("provider").textContent = row.provider;
  byId("original").textContent = row.result ? row.result.value + " " + row.result.unit : "Unknown";
  byId("lab-range").textContent = row.result ? row.result.range + " " + row.result.unit : "Unknown";
  byId("conversion").textContent = row.factor === 1 ? "Already in mg/dL."
    : row.factor ? row.result.value + " mmol/L × " + row.factor + " = " + row.normalized.toFixed(2) + " mg/dL (≈" + rounded(row.normalized) + " mg/dL)"
    : "Comparison unavailable. " + row.reasons.join(". ") + ".";
  showSource(row, row.source, "LDL result");
  const dates = byId("dates");
  dates.replaceChildren(
    dateRow("Collected", row.collected, row.collectionSource ? "PDF · page " + row.collectionSource.page : "No verified collection date", row.collectionSource, row),
    dateRow("Reported", row.reported, row.reportSource ? "PDF · page " + row.reportSource.page : "No verified report date", row.reportSource, row),
    ...row.deliveries.map(delivery => dateRow("Received", delivery.received, delivery.channel + " · fixture metadata")),
  );
  if (!row.deliveries.length) dates.append(dateRow("Received", null, "No delivery metadata"));
}

function render({ results, review, change, deliveries }) {
  const all = [...results, ...review];
  const select = (row, interact = false) => {
    for (const control of document.querySelectorAll("button[data-result]")) {
      control.setAttribute("aria-pressed", String(control.dataset.result === row.id));
    }
    renderEvidence(row);
    if (interact) {
      history.replaceState(null, "", "/?result=" + row.id + "#evidence");
      if (matchMedia("(max-width: 800px)").matches) byId("evidence").scrollIntoView({ block: "start" });
    }
  };
  if (change === null) {
    byId("answer").textContent = "Two comparable results with known collection dates are needed to calculate a change.";
  } else {
    const signed = (change > 0 ? "+" : "") + rounded(change);
    const first = results[0];
    const last = results.at(-1);
    const observed = change > 0 ? "rose" : change < 0 ? "fell" : "held steady";
    byId("answer").textContent = "Direct serum LDL " + observed + " from " + shownValue(first)
      + " to " + shownValue(last) + " mg/dL between " + dateLabel(first.collected)
      + " and " + dateLabel(last.collected) + ".";
    byId("delta").textContent = signed + " mg/dL";
    byId("delta").hidden = false;
  }
  byId("total").textContent = all.length + " reports · " + new Set(all.map(row => row.provider)).size + " labs";
  for (const row of results) {
    const item = element("li");
    const button = resultButton(row, "result-row", undefined, select);
    const info = element("span");
    info.append(element("strong", "", dateLabel(row.collected)), element("small", "", row.provider));
    button.append(info, element("span", "result-number", shownValue(row) + " mg/dL"));
    item.append(button);
    byId("results").append(item);
  }
  for (const row of deliveries) {
    const provider = all.find(report => report.id === row.documentId).provider;
    byId("receipt-list").append(element("li", "", dateLabel(row.received) + " · " + provider + " · " + row.channel));
  }
  for (const row of review) {
    const item = element("li");
    item.append(resultButton(row, "", row.provider + " · " + row.reasons.join(". "), select));
    byId("review-list").append(item);
  }
  byId("review").hidden = !review.length;
  byId("receipts").hidden = !deliveries.length;
  byId("dashboard").hidden = false;
  chart(results, select);
  const requested = new URL(location.href).searchParams.get("result");
  const selection = all.find(row => row.id === requested) ?? results.at(-1) ?? review[0];
  byId("evidence").hidden = !selection;
  if (selection) select(selection);
}

try {
  const response = await fetch("/timeline.json");
  if (!response.ok) throw new Error("Timeline request failed");
  render(await response.json());
} catch (error) {
  console.error(error);
  byId("answer").textContent = "The timeline could not load. Restart the local demo with npm start.";
}
