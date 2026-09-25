(function (root) {
  "use strict";

  const M = root.MoeModel;
  const $ = (id) => document.getElementById(id);
  const svg = $("scene");
  const WORLD = { x: 0, y: 0, w: 1740, h: 830 };
  const COLUMNS = [
    { module: "input", x: 66, label: "INPUT", subtitle: "token × hidden" },
    { module: "router", x: 337, label: "ROUTER", subtitle: "score → Top-k" },
    { module: "dispatch", x: 608, label: "DISPATCH", subtitle: "pack · exchange" },
    { module: "expert", x: 879, label: "EXPERTS", subtitle: "local compute" },
    { module: "combine", x: 1150, label: "COMBINE", subtitle: "return · weighted sum" },
    { module: "output", x: 1421, label: "OUTPUT", subtitle: "original slot" }
  ];
  const WIDTH = 205, TOP = 117, HEIGHT = 584;
  const laneY = (lane) => 201 + lane * 59;
  const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
  const rankLabel = (lane, model) => model.ranks === 8 ? `R${lane}` : `R${lane * 8}–${lane * 8 + 7}`;
  const state = {
    preset: "ep8", scenario: "balanced", topK: 4, speed: 1,
    phase: 0, progress: 1, playing: false, frame: null, lastTime: 0, lastPaint: 0,
    box: { ...WORLD }, drag: null, dragged: false
  };
  let model = M.buildModel(state);
  let details;

  function esc(text) {
    return String(text).replace(/[&<>"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" })[character]);
  }
  function rect(x, y, w, h, fill, attrs = "") {
    return `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}" ${attrs}/>`;
  }
  function text(x, y, value, className = "", attrs = "") {
    return `<text x="${x}" y="${y}" class="${className}" ${attrs}>${esc(value)}</text>`;
  }
  function stageOpacity(phase, order) {
    if (phase < state.phase) return .94;
    if (phase > state.phase) return .52;
    return order <= state.progress + .005 ? .98 : .24;
  }
  function bandPath(x1, y1, x2, y2) {
    const reach = (x2 - x1) * .46;
    return `M${x1},${y1} C${x1 + reach},${y1} ${x2 - reach},${y2} ${x2},${y2}`;
  }
  function trafficGroups() {
    return M.groupedTraffic(model, 8);
  }
  function laneTotals(groups, source) {
    return Array.from({ length: 8 }, (_, lane) => {
      let value = 0;
      for (let other = 0; other < 8; other++) value += groups[source ? lane * 8 + other : other * 8 + lane];
      return value;
    });
  }
  function flows(groups, type) {
    const isDispatch = type === "dispatch";
    const x1 = isDispatch ? 542 : 1087;
    const x2 = isDispatch ? 876 : 1420;
    const maximum = Math.max(...groups);
    const bands = [];
    const glints = [];
    for (let src = 0; src < 8; src++) {
      for (let dst = 0; dst < 8; dst++) {
        const count = groups[src * 8 + dst];
        if (!count) continue;
        const from = isDispatch ? src : dst;
        const to = isDispatch ? dst : src;
        const inset = (isDispatch ? dst : src) * 1.5 - 5.25;
        const d = bandPath(x1, laneY(from) + inset, x2, laneY(to) + inset);
        const width = (1.3 + 7.3 * Math.sqrt(count / maximum)).toFixed(1);
        const delay = ((src * 17 + dst * 7) % 23) / 23;
        bands.push(`<path class="flow-band ${type}" d="${d}" stroke-width="${width}" data-visual-phase="${isDispatch ? 2 : 4}" data-order="${delay.toFixed(3)}" data-count="${count}"><title>${rankLabel(src, model)} → ${rankLabel(dst, model)} · ${count} 任务</title></path>`);
        glints.push(`<path class="flow-glint ${type}" d="${d}" stroke-width="${Math.max(1, Number(width) * .32).toFixed(1)}" style="animation-delay:-${(delay * 1.35).toFixed(2)}s"></path>`);
      }
    }
    return bands.join("") + glints.join("");
  }
  function inputFlows() {
    return Array.from({ length: 8 }, (_, lane) => {
      const y = laneY(lane) + 7;
      return `<path class="flow-band input" d="${bandPath(272, y, 335, y)}" stroke-width="8" data-visual-phase="0" data-order="${(lane / 8).toFixed(3)}"/>`;
    }).join("");
  }
  function bank(lane, x, y, isOutput) {
    let markup = "";
    for (let token = 0; token < 16; token++) {
      const px = x + token * 8.5;
      const fill = isOutput ? "#b9aaf4" : "#98baf0";
      markup += rect(px, y, 6.2, 15, fill, `rx="1.3" class="${isOutput ? "output-stripe" : "bank-stripe"}" data-visual-phase="${isOutput ? 5 : 0}" data-order="${(token / 16).toFixed(3)}"`);
    }
    return markup;
  }
  function cardBase(column, index, model) {
    const { x, label, subtitle, module } = column;
    const count = module === "input" || module === "output"
      ? `${model.totalTokens} token · H${model.hidden}`
      : module === "router" ? `${model.totalExperts} experts · Top-${model.topK}`
      : module === "expert" ? `${model.totalExperts} experts`
      : `${model.totalTasks} tasks`;
    let shape = rect(x, TOP, WIDTH, HEIGHT, "white", `rx="12" class="module-frame"`);
    shape += text(x + 18, TOP + 33, `${String(index + 1).padStart(2, "0")}`, "module-index");
    shape += text(x + 18, TOP + 61, label, "module-label");
    shape += text(x + 18, TOP + 83, count, "module-count");
    shape += text(x + WIDTH - 31, TOP + 52, "⊕", "expand-icon");
    shape += rect(x + 17, TOP + 99, WIDTH - 34, 1, "#edf0f5");
    shape += text(x + 18, TOP + HEIGHT - 22, subtitle, "column-subtitle");
    return shape;
  }
  function inputCard(column) {
    let html = "";
    const groupSize = model.ranks / 8;
    for (let lane = 0; lane < 8; lane++) {
      const y = laneY(lane);
      html += text(column.x + 18, y - 11, rankLabel(lane, model), "rank-label");
      html += text(column.x + 188, y - 11, `${groupSize * model.tokensPerRank} T`, "rank-count", `text-anchor="end"`);
      html += bank(lane, column.x + 18, y - 1, false);
      html += rect(column.x + 18, y + 21, 171, 1, "#eef2f7");
    }
    return html;
  }
  function routerCard(column, groups) {
    let html = "";
    const max = Math.max(...groups);
    for (let row = 0; row < 8; row++) {
      const y = laneY(row);
      html += text(column.x + 18, y - 10, rankLabel(row, model), "rank-label");
      for (let dst = 0; dst < 8; dst++) {
        const count = groups[row * 8 + dst];
        const alpha = .16 + .69 * (count / max);
        const fill = `rgba(104,80,218,${alpha.toFixed(3)})`;
        html += rect(column.x + 18 + dst * 21.2, y - 1, 18.2, 20, fill,
          `rx="2" class="router-cell" data-visual-phase="1" data-order="${((row * 8 + dst) / 64).toFixed(3)}" aria-label="${rankLabel(row, model)} → ${rankLabel(dst, model)} · ${count} 次选择"`);
      }
    }
    html += text(column.x + 18, TOP + HEIGHT - 45, "源 rank × 目标 rank", "rank-count");
    return html;
  }
  function dispatchCard(column, groups) {
    const totals = laneTotals(groups, false);
    const maximum = Math.max(...totals);
    let html = "";
    for (let lane = 0; lane < 8; lane++) {
      const y = laneY(lane);
      html += text(column.x + 18, y - 11, rankLabel(lane, model), "rank-label");
      html += text(column.x + 187, y - 11, `${totals[lane]}`, "rank-count", `text-anchor="end"`);
      html += rect(column.x + 18, y, 171, 17, "#f0f4fb", `rx="2"`);
      html += rect(column.x + 18, y, 171 * totals[lane] / maximum, 17, "#a5c5f5",
        `rx="2" data-visual-phase="2" data-order="${(lane / 8).toFixed(3)}"`);
      for (let src = 0; src < 8; src++) {
        const count = groups[src * 8 + lane];
        if (!count) continue;
        html += rect(column.x + 20 + 167 * src / 8, y + 3, Math.max(1.5, 167 * count / (totals[lane] * 1.7)), 11,
          src === lane ? "#6e84d7" : "#69a3ed", `opacity=".76" data-visual-phase="2" data-order="${((lane * 8 + src) / 64).toFixed(3)}"`);
      }
    }
    return html;
  }
  function expertCard(column) {
    let html = "";
    const perGroup = model.totalExperts / 8;
    const groupTotals = Array.from({ length: 8 }, (_, lane) => {
      let sum = 0;
      for (let e = lane * perGroup; e < (lane + 1) * perGroup; e++) sum += model.expertLoads[e];
      return sum;
    });
    const groupMax = Math.max(...groupTotals);
    for (let lane = 0; lane < 8; lane++) {
      const y = laneY(lane);
      const first = lane * perGroup, last = first + perGroup - 1;
      html += text(column.x + 18, y - 10, `E${first}–${last}`, "rank-label");
      html += text(column.x + 188, y - 10, `${groupTotals[lane]}`, "rank-count", `text-anchor="end"`);
      const showCount = Math.min(perGroup, 16);
      const block = 170 / showCount;
      for (let i = 0; i < showCount; i++) {
        let load = 0;
        for (let e = first + Math.floor(i * perGroup / showCount); e < first + Math.floor((i + 1) * perGroup / showCount); e++) load += model.expertLoads[e];
        const normalized = Math.min(1, load / (groupMax / showCount * 1.4));
        const fill = `rgba(103,82,218,${(.22 + normalized * .68).toFixed(3)})`;
        html += rect(column.x + 18 + i * block, y - 1, block - 2, 21, fill,
          `rx="2" class="expert-cell" data-visual-phase="3" data-order="${((lane * showCount + i) / (8 * showCount)).toFixed(3)}" aria-label="E${first + i} · ${load} 任务"`);
      }
    }
    return html;
  }
  function combineCard(column, groups) {
    const totals = laneTotals(groups, true);
    const maximum = Math.max(...totals);
    let html = "";
    for (let lane = 0; lane < 8; lane++) {
      const y = laneY(lane);
      html += text(column.x + 18, y - 11, rankLabel(lane, model), "rank-label");
      html += text(column.x + 188, y - 11, `${totals[lane]}`, "rank-count", `text-anchor="end"`);
      html += rect(column.x + 18, y, 171, 17, "#f3f0ff", `rx="2"`);
      let cursor = 0;
      for (let dst = 0; dst < 8; dst++) {
        const count = groups[lane * 8 + dst];
        if (!count) continue;
        const width = 171 * count / totals[lane];
        html += rect(column.x + 18 + cursor, y, Math.max(1, width - 1.2), 17, dst === lane ? "#8c72df" : "#b0a1ee",
          `rx="1" data-visual-phase="4" data-order="${((lane * 8 + dst) / 64).toFixed(3)}" aria-label="${rankLabel(dst, model)} 返回 ${count} 项"`);
        cursor += width;
      }
    }
    return html;
  }
  function outputCard(column) {
    let html = "";
    const groupSize = model.ranks / 8;
    for (let lane = 0; lane < 8; lane++) {
      const y = laneY(lane);
      html += text(column.x + 18, y - 11, rankLabel(lane, model), "rank-label");
      html += text(column.x + 188, y - 11, `${groupSize * model.tokensPerRank} T`, "rank-count", `text-anchor="end"`);
      html += bank(lane, column.x + 18, y - 1, true);
      html += rect(column.x + 18, y + 21, 171, 1, "#eef2f7");
    }
    return html;
  }
  function renderScene() {
    const groups = trafficGroups();
    const def = `<defs>
      <pattern id="dot-grid" width="28" height="28" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r=".7" fill="#edf1f6"/></pattern>
      <filter id="soft-shadow" x="-15%" y="-12%" width="130%" height="135%"><feDropShadow dx="0" dy="5" stdDeviation="6" flood-color="#8692a8" flood-opacity=".11"/></filter>
    </defs>`;
    let html = def + rect(-3000, -2000, 8000, 5000, "url(#dot-grid)", `class="world-grid"`);
    html += text(69, 70, `${model.ranks / 8} rank / 泳道`, "column-title");
    html += text(1627, 70, `${model.label} · K${model.topK} · H${model.hidden}`, "column-subtitle", `text-anchor="end"`);
    html += inputFlows() + flows(groups, "dispatch") + flows(groups, "combine");
    COLUMNS.forEach((column, index) => {
      let inside = cardBase(column, index, model);
      if (column.module === "input") inside += inputCard(column);
      if (column.module === "router") inside += routerCard(column, groups);
      if (column.module === "dispatch") inside += dispatchCard(column, groups);
      if (column.module === "expert") inside += expertCard(column);
      if (column.module === "combine") inside += combineCard(column, groups);
      if (column.module === "output") inside += outputCard(column);
      inside += rect(column.x, TOP, WIDTH, HEIGHT, "transparent", `rx="12" class="module-hit"`);
      html += `<g class="module-card${index === state.phase ? " active" : ""}" data-module="${column.module}" tabindex="0" role="button" aria-label="展开${column.label}详细动画">${inside}</g>`;
    });
    html += `<g aria-hidden="true">${rect(797, 365, 78, 51, "white", `rx="9" class="center-badge"`)}${text(836, 389, model.totalTasks.toLocaleString(), "center-number")}${text(836, 404, "tasks", "center-caption")}</g>`;
    html += `<g aria-hidden="true">${rect(1335, 365, 79, 51, "white", `rx="9" class="center-badge"`)}${text(1374, 389, model.totalTokens.toLocaleString(), "center-number")}${text(1374, 404, "tokens", "center-caption")}</g>`;
    svg.innerHTML = html;
    updateAnimation();
  }
  function updateAnimation() {
    svg.querySelectorAll("[data-visual-phase]").forEach((element) => {
      const phase = Number(element.dataset.visualPhase);
      const order = Number(element.dataset.order || 0);
      const opacity = stageOpacity(phase, order);
      element.style.opacity = String(opacity);
      if (element.classList.contains("flow-band")) element.classList.toggle("active", phase === state.phase);
    });
    svg.querySelectorAll(".flow-glint").forEach((element) => {
      const phase = element.classList.contains("dispatch") ? 2 : 4;
      element.classList.toggle("active", phase === state.phase && state.playing);
    });
    svg.querySelectorAll(".module-card").forEach((element, index) => {
      element.classList.toggle("active", index === state.phase);
    });
  }
  function setBox(box) {
    state.box = box;
    svg.setAttribute("viewBox", `${box.x} ${box.y} ${box.w} ${box.h}`);
  }
  function homeBox() {
    return root.innerWidth <= 780 ? { x: 34, y: 0, w: 560, h: 830 } : { ...WORLD };
  }
  function zoom(factor, clientX, clientY) {
    const bounds = svg.getBoundingClientRect();
    const fx = clamp((clientX - bounds.left) / bounds.width, 0, 1);
    const fy = clamp((clientY - bounds.top) / bounds.height, 0, 1);
    const nextW = clamp(state.box.w * factor, 460, 5200);
    const nextH = state.box.h * nextW / state.box.w;
    setBox({
      x: state.box.x + fx * (state.box.w - nextW),
      y: state.box.y + fy * (state.box.h - nextH),
      w: nextW, h: nextH
    });
  }
  function pause() {
    state.playing = false;
    state.lastTime = 0;
    if (state.frame !== null) cancelAnimationFrame(state.frame);
    state.frame = null;
    renderControls();
    updateAnimation();
  }
  function tick(time) {
    state.frame = null;
    if (!state.playing) return;
    if (state.lastTime) state.progress += (time - state.lastTime) * state.speed / 2000;
    state.lastTime = time;
    if (state.progress >= 1) {
      if (state.phase === 5) { state.progress = 1; pause(); return; }
      state.phase++;
      state.progress = 0;
      renderControls();
    }
    if (time - state.lastPaint > 35) {
      state.lastPaint = time;
      updateAnimation();
      $("scrub").value = String(Math.round((state.phase + state.progress) * 100));
    }
    state.frame = requestAnimationFrame(tick);
  }
  function play() {
    if (state.playing) { pause(); return; }
    if (state.phase === 5 && state.progress >= 1) { state.phase = 0; state.progress = 0; }
    else if (state.progress >= 1) {
      state.phase = Math.min(5, state.phase + 1);
      state.progress = 0;
    }
    state.playing = true;
    state.lastTime = 0;
    renderControls();
    updateAnimation();
    state.frame = requestAnimationFrame(tick);
  }
  function setPhase(phase, progress = 1) {
    pause();
    state.phase = clamp(phase, 0, 5);
    state.progress = clamp(progress, 0, 1);
    renderControls();
    updateAnimation();
  }
  function renderControls() {
    $("play").innerHTML = state.playing ? "Ⅱ <span>暂停</span>" : "▶ <span>播放</span>";
    $("play").setAttribute("aria-label", state.playing ? "暂停" : "播放");
    $("previous").disabled = state.phase === 0;
    $("next").disabled = state.phase === 5;
    $("scrub").value = String(Math.round((state.phase + state.progress) * 100));
    document.querySelectorAll("[data-phase]").forEach((button) => {
      const phase = Number(button.dataset.phase);
      button.classList.toggle("active", phase === state.phase);
      button.classList.toggle("past", phase < state.phase);
      button.setAttribute("aria-pressed", String(phase === state.phase));
    });
    $("metric-tokens").textContent = `${model.totalTokens.toLocaleString()} token`;
    $("metric-tasks").textContent = `${model.totalTasks.toLocaleString()} 专家任务`;
    $("metric-cross").textContent = `跨 rank ${model.crossRankTasks.toLocaleString()}`;
    $("metric-bytes").textContent = `单向 ${M.formatBytes(model.crossRankBytes)}`;
  }
  function rebuild() {
    pause();
    state.preset = $("preset").value;
    state.scenario = $("scenario").value;
    state.topK = Number($("topk").value);
    model = M.buildModel(state);
    state.phase = 0;
    state.progress = 1;
    renderControls();
    renderScene();
    details.refreshModel();
  }
  function openModule(name) {
    pause();
    details.open(name, 0);
  }

  details = root.MoeDetails.create({
    getModel: () => model,
    onModuleChange: (index) => setPhase(index)
  });
  renderControls();
  renderScene();
  setBox(homeBox());

  $("preset").addEventListener("change", () => {
    const preset = M.PRESETS[$("preset").value];
    $("topk").value = String(preset.defaultK);
    rebuild();
  });
  $("scenario").addEventListener("change", rebuild);
  $("topk").addEventListener("change", rebuild);
  $("speed").addEventListener("change", () => { state.speed = Number($("speed").value); });
  $("play").addEventListener("click", play);
  $("previous").addEventListener("click", () => setPhase(state.phase - 1));
  $("next").addEventListener("click", () => setPhase(state.phase + 1));
  $("about").addEventListener("click", () => openModule("about"));
  $("stage-buttons").addEventListener("click", (event) => {
    const button = event.target.closest("[data-phase]");
    if (button) setPhase(Number(button.dataset.phase));
  });
  $("scrub").addEventListener("input", () => {
    const value = Number($("scrub").value) / 100;
    setPhase(Math.floor(Math.min(value, 5)), value >= 5 ? value - 5 : value % 1);
  });
  $("zoom-in").addEventListener("click", () => {
    const box = svg.getBoundingClientRect();
    zoom(.78, box.left + box.width / 2, box.top + box.height / 2);
  });
  $("zoom-out").addEventListener("click", () => {
    const box = svg.getBoundingClientRect();
    zoom(1.28, box.left + box.width / 2, box.top + box.height / 2);
  });
  $("fit").addEventListener("click", () => setBox(homeBox()));
  root.addEventListener("resize", () => {
    if ((root.innerWidth <= 780) !== (state.box.w === 560)) setBox(homeBox());
  });
  svg.addEventListener("wheel", (event) => {
    event.preventDefault();
    zoom(event.deltaY > 0 ? 1.13 : .885, event.clientX, event.clientY);
  }, { passive: false });
  svg.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    state.drag = { x: event.clientX, y: event.clientY, box: { ...state.box }, module: event.target.closest(".module-card")?.dataset.module };
    state.dragged = false;
    svg.setPointerCapture(event.pointerId);
  });
  svg.addEventListener("pointermove", (event) => {
    if (!state.drag) return;
    const dx = event.clientX - state.drag.x, dy = event.clientY - state.drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 5) state.dragged = true;
    if (!state.dragged) return;
    svg.classList.add("dragging");
    const bounds = svg.getBoundingClientRect();
    setBox({
      ...state.drag.box,
      x: state.drag.box.x - dx * state.drag.box.w / bounds.width,
      y: state.drag.box.y - dy * state.drag.box.h / bounds.height
    });
  });
  const endDrag = (event) => {
    const module = event.type === "pointerup" && !state.dragged ? state.drag?.module : null;
    state.drag = null;
    svg.classList.remove("dragging");
    setTimeout(() => { state.dragged = false; }, 0);
    if (module) openModule(module);
  };
  svg.addEventListener("pointerup", endDrag);
  svg.addEventListener("pointercancel", endDrag);
  svg.addEventListener("keydown", (event) => {
    if ((event.key === "Enter" || event.key === " ") && event.target.classList.contains("module-card")) {
      event.preventDefault();
      openModule(event.target.dataset.module);
    }
  });
})(window);
