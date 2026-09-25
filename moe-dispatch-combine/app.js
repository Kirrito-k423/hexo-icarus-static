(() => {
  "use strict";

  const rankCount = 4;
  const tokensPerRank = 2;
  const expertsPerRank = 2;
  const hiddenBytes = 4096 * 2; // 教学估算：H=4096，BF16=2 字节。
  const balanced = [[0, 3], [2, 5], [1, 4], [3, 6], [4, 1], [6, 0], [7, 2], [5, 3]];
  const hotspot = [[2, 5], [2, 6], [2, 0], [2, 7], [2, 4], [2, 1], [6, 2], [2, 3]];
  const firstWeights = [.7, .65, .6, .75, .55, .7, .65, .6];
  const phases = [
    { title: "01 / 路由", subtitle: "先看每个 token 被分配到哪些专家", copy: "Router 决定每个 token 的 Top-k 专家。选中的 token 用红色边框标出；线条显示它将产生的专家任务。", callout: "路由只决定目的地。此时还没有跨 rank 传输。" },
    { title: "02 / Dispatch", subtitle: "token 副本移动到专家所在 rank", copy: "Dispatch 为每条专家任务发送一份 token 副本，并保存来源位置。跨 rank 的路线要经过通信，本 rank 路线可在本地完成。", callout: "图上的粒子是逻辑数据流；到达图中终点不等于真实网络完成。" },
    { title: "03 / 专家计算", subtitle: "每个专家处理收到的副本", copy: "同一个专家可能接收来自不同 rank 的 token。这里用可手算的标量变换演示，真实专家通常是向量上的 FFN。", callout: "示例函数 Fₑ(x[0]) = x[0] + 4(e+1)，仅用于理解数据从哪里来。" },
    { title: "04 / Combine", subtitle: "专家结果沿来源信息回到原 rank", copy: "Combine 把每条专家任务的结果发回最初的 token 所在 rank，并利用保存的 token 槽位定位。", callout: "返回的是专家结果，不能把这一步理解为再次发送原始输入。" },
    { title: "05 / 恢复顺序", subtitle: "按路由权重合成并写回原槽位", copy: "来自多个专家的结果按权重相加。即使 Dispatch 改变了专家侧布局，输出仍对应最初的 token 顺序。", callout: "Top-1 的示例权重为 1；Top-2 的两个示例权重之和为 1。" }
  ];

  const $ = (id) => document.getElementById(id);
  const ui = {
    flow: $("flow"), scenario: $("scenario"), topk: $("topk"), speed: $("speed"), showAll: $("show-all"),
    play: $("play"), prev: $("prev"), next: $("next"), reset: $("reset"), scrub: $("scrub"),
    phaseTitle: $("phase-title"), phaseSubtitle: $("phase-subtitle"), stageCopy: $("stage-copy"),
    stageCallout: $("stage-callout"), selectedId: $("selected-id"), tokenSelect: $("token-select"), tokenDetail: $("token-detail"),
    copies: $("copies"), remote: $("remote"), payload: $("payload"), busiest: $("busiest")
  };
  const state = { scenario: "balanced", topk: 2, phase: 0, progress: 0, selected: "R0:T0", playing: false, speed: 1, showAll: false };
  let model;
  let lastFrame = 0;
  let frameHandle = null;

  function buildModel() {
    const choices = state.scenario === "hotspot" ? hotspot : balanced;
    const tokens = [];
    const routes = [];
    const counts = Array(rankCount * expertsPerRank).fill(0);
    for (let rank = 0; rank < rankCount; rank++) {
      for (let slot = 0; slot < tokensPerRank; slot++) {
        const index = rank * tokensPerRank + slot;
        const token = { key: `R${rank}:T${slot}`, rank, slot, x: 12 + rank * 20 + slot * 3 };
        tokens.push(token);
        for (let selection = 0; selection < state.topk; selection++) {
          const expert = choices[index][selection];
          const owner = Math.floor(expert / expertsPerRank);
          const weight = state.topk === 1 ? 1 : selection === 0 ? firstWeights[index] : 1 - firstWeights[index];
          const value = token.x + 4 * (expert + 1);
          routes.push({ token, expert, owner, weight, value, selection });
          counts[expert]++;
        }
      }
    }
    return { tokens, routes, counts, remote: routes.filter((route) => route.owner !== route.token.rank).length };
  }

  function tokenX(slot) { return 169 + slot * 75; }
  function expertX(expert) { return 565 + (expert % 2) * 77; }
  function outputX(slot) { return 1022 + slot * 75; }
  function rowY(rank) { return 154 + rank * 108; }
  function dispatchPath(route) {
    const x1 = tokenX(route.token.slot) + 21, y1 = rowY(route.token.rank);
    const x2 = expertX(route.expert) - 28, y2 = rowY(route.owner);
    return `M ${x1} ${y1} C ${x1 + 180} ${y1}, ${x2 - 150} ${y2}, ${x2} ${y2}`;
  }
  function combinePath(route) {
    const x1 = expertX(route.expert) + 28, y1 = rowY(route.owner);
    const x2 = outputX(route.token.slot) - 21, y2 = rowY(route.token.rank);
    return `M ${x1} ${y1} C ${x1 + 150} ${y1}, ${x2 - 160} ${y2}, ${x2} ${y2}`;
  }
  function fmt(n) { return n.toFixed(1); }
  function resultFor(token) {
    return model.routes.filter((r) => r.token.key === token.key).reduce((sum, r) => sum + r.weight * r.value, 0);
  }

  function drawFlow() {
    const lanes = Array.from({ length: rankCount }, (_, rank) => {
      const cy = rowY(rank);
      return `<g><rect class="rank-lane" x="17" y="${cy - 43}" width="1166" height="86" rx="13"/><text class="rank-label" x="39" y="${cy - 2}">R${rank}</text><text class="rank-detail" x="39" y="${cy + 14}">rank ${rank}</text><line class="row-divider" x1="100" y1="${cy - 29}" x2="100" y2="${cy + 29}"/></g>`;
    }).join("");

    const routeType = state.phase >= 3 ? "combine" : "dispatch";
    const paths = model.routes.map((route, index) => {
      const focus = route.token.key === state.selected;
      const klass = ["flow-line", routeType, focus ? "focus" : state.showAll ? "all-visible" : "", !focus && !state.showAll ? "secondary" : ""].join(" ");
      const path = routeType === "dispatch" ? dispatchPath(route) : combinePath(route);
      return `<path id="route-${index}" class="${klass}" d="${path}"/>`;
    }).join("");

    const tokenNodes = model.tokens.map((token) => {
      const selected = token.key === state.selected ? "selected" : "";
      const muted = state.phase >= 3 ? "node-muted" : "";
      const y = rowY(token.rank), x = tokenX(token.slot);
      return `<g class="node-click ${selected} ${muted}" data-token="${token.key}" role="button" tabindex="0" aria-label="追踪 ${token.key}，输入首元素 ${token.x}"><circle class="input-node" cx="${x}" cy="${y}" r="22"/><text class="node-text" x="${x}" y="${y}">T${token.slot}</text><text class="node-value" x="${x}" y="${y + 35}">x[0]=${token.x}</text></g>`;
    }).join("");

    const expertNodes = Array.from({ length: rankCount * expertsPerRank }, (_, expert) => {
      const y = rowY(Math.floor(expert / expertsPerRank)), x = expertX(expert);
      const highlighted = model.routes.some((r) => r.expert === expert && r.token.key === state.selected);
      return `<g class="${highlighted ? "" : "node-muted"}"><rect class="expert-box" x="${x - 26}" y="${y - 24}" width="52" height="48" rx="9"/><text class="expert-text" x="${x}" y="${y - 3}">E${expert}</text><text class="expert-count" x="${x}" y="${y + 13}">${model.counts[expert]} 份</text></g>`;
    }).join("");

    const outputNodes = model.tokens.map((token) => {
      const selected = token.key === state.selected ? "selected" : "";
      const muted = state.phase < 3 ? "node-muted" : "";
      const x = outputX(token.slot), y = rowY(token.rank);
      const value = state.phase === 4 ? `y[0]=${fmt(resultFor(token))}` : "原槽位";
      return `<g class="node-click ${selected} ${muted}" data-token="${token.key}" role="button" tabindex="0" aria-label="追踪 ${token.key} 的输出槽位"><circle class="output-node" cx="${x}" cy="${y}" r="22"/><text class="node-text output-text" x="${x}" y="${y}">T${token.slot}</text><text class="node-value" x="${x}" y="${y + 35}">${value}</text></g>`;
    }).join("");

    const packetType = state.phase === 1 || state.phase === 3 ? routeType : "";
    const packets = packetType ? model.routes.map((route, index) => {
      const focus = route.token.key === state.selected ? "focus" : "";
      return `<circle id="packet-${index}" class="packet ${packetType} ${focus}" r="${focus ? 8 : 5}" cx="0" cy="0"/>`;
    }).join("") : "";

    ui.flow.innerHTML = `<text class="svg-head" x="125" y="69">原 rank · 输入 token</text><text class="svg-head" x="535" y="69">目标 rank · Experts</text><text class="svg-head" x="969" y="69">原 rank · 输出槽位</text>${lanes}<g class="routes">${paths}</g>${tokenNodes}${expertNodes}${outputNodes}<g class="packets">${packets}</g><text class="phase-note" x="25" y="576">每条线对应一次专家任务；同 rank 路线是本地路径。</text>`;
    updatePackets();
  }

  function updatePackets() {
    if (state.phase !== 1 && state.phase !== 3) return;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const travel = reducedMotion ? (state.progress >= .5 ? 1 : 0) : state.progress;
    model.routes.forEach((_, index) => {
      const path = $("route-" + index);
      const packet = $("packet-" + index);
      if (!path || !packet) return;
      const point = path.getPointAtLength(path.getTotalLength() * travel);
      packet.setAttribute("cx", point.x.toFixed(2));
      packet.setAttribute("cy", point.y.toFixed(2));
    });
  }

  function renderDetail() {
    const token = model.tokens.find((t) => t.key === state.selected) || model.tokens[0];
    const routes = model.routes.filter((r) => r.token.key === token.key);
    const terms = routes.map((r) => `${fmt(r.weight)} × ${r.value}`).join(" + ");
    ui.selectedId.textContent = token.key;
    ui.stageCopy.textContent = phases[state.phase].copy;
    ui.stageCallout.textContent = phases[state.phase].callout;
    ui.tokenSelect.value = token.key;
    ui.tokenDetail.innerHTML = `<div class="fact"><span>来源</span><b>Rank ${token.rank} · token 槽位 ${token.slot}</b></div><div class="fact"><span>输入示意值 x[0]</span><b>${token.x}</b></div><div class="fact"><span>专家任务</span><b>${routes.length} 份副本</b></div><div class="route-list"><h4>每份副本去哪里</h4>${routes.map((r) => `<div class="route-card"><div class="route-top"><span>E${r.expert} · Rank ${r.owner}</span><small>${r.owner === token.rank ? "本地" : "跨 rank"}</small></div><p>权重 ${fmt(r.weight)} · F${r.expert}(x[0]) = ${token.x} + ${4 * (r.expert + 1)} = ${r.value}</p></div>`).join("")}</div><div class="formula"><small>Combine · 按原槽位汇合</small><div>${terms}</div><b>y[${token.slot}, 0] = ${fmt(resultFor(token))}</b></div>`;
  }

  function renderMetrics() {
    ui.copies.textContent = String(model.routes.length);
    ui.remote.textContent = `${model.remote} / ${model.routes.length}`;
    ui.payload.textContent = `${(model.remote * hiddenBytes / 1024).toFixed(0)} KiB`;
    const max = Math.max(...model.counts);
    ui.busiest.textContent = `E${model.counts.indexOf(max)} · ${max} 份`;
  }

  function renderControls() {
    const phase = phases[state.phase];
    ui.phaseTitle.textContent = phase.title;
    ui.phaseSubtitle.textContent = phase.subtitle;
    ui.scrub.value = String(Math.round(state.progress * 100));
    ui.play.innerHTML = state.playing ? "Ⅱ <span>暂停</span>" : "▶ <span>播放</span>";
    ui.play.setAttribute("aria-label", state.playing ? "暂停" : "播放");
    ui.prev.disabled = state.phase === 0;
    ui.next.disabled = state.phase === phases.length - 1;
    document.querySelectorAll(".step").forEach((button, index) => {
      button.classList.toggle("active", index === state.phase);
      button.classList.toggle("past", index < state.phase);
      button.setAttribute("aria-current", index === state.phase ? "step" : "false");
    });
  }

  function render() {
    model = buildModel();
    drawFlow();
    renderDetail();
    renderMetrics();
    renderControls();
  }

  function pause() { state.playing = false; lastFrame = 0; if (frameHandle !== null) cancelAnimationFrame(frameHandle); frameHandle = null; renderControls(); }
  function goToPhase(phase) { state.phase = Math.max(0, Math.min(phases.length - 1, phase)); state.progress = 0; pause(); render(); }
  function tick(timestamp) {
    frameHandle = null;
    if (!state.playing) return;
    if (lastFrame) state.progress += (timestamp - lastFrame) * state.speed / 2200;
    lastFrame = timestamp;
    if (state.progress >= 1) {
      if (state.phase === phases.length - 1) { state.progress = 1; pause(); }
      else { state.phase++; state.progress = 0; render(); }
    }
    ui.scrub.value = String(Math.round(state.progress * 100));
    updatePackets();
    if (state.playing) frameHandle = requestAnimationFrame(tick);
  }

  ui.scenario.addEventListener("change", () => { state.scenario = ui.scenario.value; state.progress = 0; pause(); render(); });
  ui.topk.addEventListener("change", () => { state.topk = Number(ui.topk.value); state.progress = 0; pause(); render(); });
  ui.speed.addEventListener("change", () => { state.speed = Number(ui.speed.value); });
  ui.showAll.addEventListener("change", () => { state.showAll = ui.showAll.checked; drawFlow(); });
  ui.tokenSelect.addEventListener("change", () => { state.selected = ui.tokenSelect.value; render(); });
  ui.flow.addEventListener("click", (event) => { const node = event.target.closest("[data-token]"); if (node) { state.selected = node.dataset.token; render(); } });
  ui.flow.addEventListener("keydown", (event) => { const node = event.target.closest("[data-token]"); if (node && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); state.selected = node.dataset.token; render(); } });
  ui.scrub.addEventListener("input", () => { state.progress = Number(ui.scrub.value) / 100; pause(); updatePackets(); });
  ui.play.addEventListener("click", () => {
    if (state.playing) { pause(); return; }
    if (state.phase === phases.length - 1 && state.progress >= 1) { state.phase = 0; state.progress = 0; render(); }
    state.playing = true; lastFrame = 0; renderControls(); frameHandle = requestAnimationFrame(tick);
  });
  ui.prev.addEventListener("click", () => goToPhase(state.phase - 1));
  ui.next.addEventListener("click", () => goToPhase(state.phase + 1));
  ui.reset.addEventListener("click", () => goToPhase(0));
  document.querySelectorAll(".step").forEach((button) => button.addEventListener("click", () => goToPhase(Number(button.dataset.phase))));
  document.addEventListener("keydown", (event) => {
    if (["INPUT", "SELECT", "TEXTAREA", "BUTTON"].includes(document.activeElement.tagName)) return;
    if (event.key === " ") { event.preventDefault(); ui.play.click(); }
    if (event.key === "ArrowRight") { event.preventDefault(); ui.next.click(); }
    if (event.key === "ArrowLeft") { event.preventDefault(); ui.prev.click(); }
  });

  ui.tokenSelect.innerHTML = Array.from({ length: rankCount * tokensPerRank }, (_, i) => `<option value="R${Math.floor(i / tokensPerRank)}:T${i % tokensPerRank}">R${Math.floor(i / tokensPerRank)}:T${i % tokensPerRank}</option>`).join("");
  render();
})();
