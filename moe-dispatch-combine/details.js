(function (root) {
  "use strict";

  const M = root.MoeModel;
  const ORDER = ["input", "router", "dispatch", "expert", "combine", "output"];
  const META = {
    input: { number: "01", title: "输入 token", tabs: ["Token 矩阵", "向量窗口"] },
    router: { number: "02", title: "Router", tabs: ["评分热力图", "Top-k 选择"] },
    dispatch: { number: "03", title: "Dispatch", tabs: ["rank 流量矩阵", "打包任务清单"] },
    expert: { number: "04", title: "Experts", tabs: ["专家负载", "向量变换"] },
    combine: { number: "05", title: "Combine", tabs: ["加权贡献", "返回与合成"] },
    output: { number: "06", title: "输出归位", tabs: ["输出矩阵", "原槽位顺序"] },
    about: { number: "?", title: "模型与来源", tabs: ["阅读边界"] }
  };
  const $ = (id) => document.getElementById(id);
  const signedColor = (v) => {
    const magnitude = Math.min(Math.abs(v) / 1.25, 1);
    return v >= 0 ? `rgba(235, 123, 146, ${(.16 + .70 * magnitude).toFixed(3)})` : `rgba(91, 146, 232, ${(.16 + .70 * magnitude).toFixed(3)})`;
  };
  const scoreColor = (v) => `rgba(108, 83, 216, ${Math.min(.85, .10 + Math.max(0, v) * .54).toFixed(3)})`;
  const f3 = (v) => Number(v).toFixed(3);
  const rankName = (rank) => `R${rank}`;
  const taskName = (route) => `R${route.srcRank}:T${route.token} → E${route.expert}`;
  const shapeTag = (text) => `<span class="shape-tag">${text}</span>`;
  const mathCard = (markup, note) => `<div class="math-card"><math display="block">${markup}</math><small>${note}</small></div>`;

  function heatmap(rows, cols, labelFor, valueFor, options = {}) {
    const focus = options.focusRow ?? -1;
    const cursor = Math.floor((options.progress ?? 1) * cols);
    let html = `<div class="tensor-grid" role="grid" aria-label="${options.aria || "数值热力图"}" style="grid-template-columns:48px repeat(${cols},minmax(7px,1fr))">`;
    for (let row = 0; row < rows; row++) {
      html += `<span class="tensor-label">${labelFor(row)}</span>`;
      for (let col = 0; col < cols; col++) {
        const value = valueFor(row, col);
        const color = options.colorFor ? options.colorFor(value, row, col) : signedColor(value);
        const opacity = col <= cursor ? 1 : .53;
        const selected = row === focus && col <= cursor ? " focus" : "";
        const title = `${labelFor(row)}, ${options.colPrefix || "d"}${(options.colStart || 0) + col}: ${f3(value)}`;
        html += `<span class="tensor-cell${selected}" data-token-row="${row}" title="${title}" style="background:${color};opacity:${opacity}"></span>`;
      }
    }
    html += `</div><div class="tensor-axis"><span>${options.colPrefix || "d"}${options.colStart || 0}</span><span>${options.colPrefix || "d"}${(options.colStart || 0) + cols - 1}</span></div>`;
    return html;
  }

  function metrics(entries) {
    return `<div class="small-metrics">${entries.map(([label, value]) => `<div><span>${label}</span><strong>${value}</strong></div>`).join("")}</div>`;
  }

  function routeList(routes) {
    return `<ul class="detail-list">${routes.map((route) => `<li><span>E${route.expert} · ${rankName(route.dstRank)}</span><b>${(route.weight * 100).toFixed(1)}%</b></li>`).join("")}</ul>`;
  }

  function create({ getModel, onModuleChange }) {
    const layer = $("detail-layer");
    const appShell = document.querySelector(".app-shell");
    const body = $("detail-body");
    const controls = $("detail-controls");
    const state = {
      module: null, sub: 0, rank: 0, token: 0, dimensionPage: 0, expertPage: 0,
      expert: 0, taskPage: 0, progress: 0, playing: false, frame: null,
      lastFrame: 0, lastRender: 0, restoreFocus: null
    };

    function model() { return getModel(); }
    function shapeFor(moduleName, x) {
      if (moduleName === "input" || moduleName === "output") return `[${x.ranks}, ${x.tokensPerRank}, ${x.hidden}] · BF16`;
      if (moduleName === "router") return `[${x.totalTokens}, ${x.totalExperts}] → Top-${x.topK}`;
      if (moduleName === "dispatch" || moduleName === "combine") return `${x.totalTasks} 任务 · ${M.formatBytes(x.allPayloadBytes)} 逻辑载荷`;
      if (moduleName === "expert") return `${x.totalExperts} 专家 · ${x.totalTasks} 任务`;
      return "确定性教学模型";
    }
    function pause() {
      state.playing = false;
      state.lastFrame = 0;
      if (state.frame !== null) cancelAnimationFrame(state.frame);
      state.frame = null;
      const button = $("detail-play");
      if (button) button.textContent = "▶ 播放";
    }
    function tick(time) {
      state.frame = null;
      if (!state.playing || layer.hidden) return;
      if (state.lastFrame) state.progress = Math.min(1, state.progress + (time - state.lastFrame) / 3000);
      state.lastFrame = time;
      if (time - state.lastRender > 75 || state.progress === 1) {
        state.lastRender = time;
        renderBody();
        const slider = $("detail-progress");
        if (slider) slider.value = String(Math.round(state.progress * 100));
      }
      if (state.progress >= 1) pause();
      else state.frame = requestAnimationFrame(tick);
    }
    function play() {
      if (state.playing) { pause(); return; }
      if (state.progress >= 1) state.progress = 0;
      state.playing = true;
      state.lastFrame = 0;
      state.lastRender = 0;
      const button = $("detail-play");
      if (button) button.textContent = "Ⅱ 暂停";
      state.frame = requestAnimationFrame(tick);
    }
    function autoPlay() {
      pause();
      state.progress = root.matchMedia("(prefers-reduced-motion: reduce)").matches ? 1 : 0;
      renderBody();
      const slider = $("detail-progress");
      if (slider) slider.value = String(Math.round(state.progress * 100));
      if (state.progress === 0 && state.module !== "about") play();
    }

    function open(moduleName, rank = state.rank) {
      const x = model();
      if (!META[moduleName]) return;
      if (layer.hidden) state.restoreFocus = document.activeElement;
      state.module = moduleName;
      state.sub = 0;
      state.rank = Math.max(0, Math.min(x.ranks - 1, rank));
      state.token = 0;
      state.expert = state.rank * x.expertsPerRank;
      state.dimensionPage = 0;
      state.expertPage = 0;
      state.taskPage = 0;
      state.progress = 0;
      layer.hidden = false;
      appShell.inert = true;
      if (moduleName !== "about") onModuleChange(ORDER.indexOf(moduleName));
      render();
      $("detail-close").focus();
      autoPlay();
    }
    function close() {
      pause();
      layer.hidden = true;
      appShell.inert = false;
      state.module = null;
      if (state.restoreFocus && typeof state.restoreFocus.focus === "function") state.restoreFocus.focus();
    }
    function setSub(next) {
      const max = META[state.module].tabs.length - 1;
      state.sub = Math.max(0, Math.min(max, next));
      state.taskPage = 0;
      state.progress = 0;
      render();
      autoPlay();
    }
    function shiftModule(direction) {
      if (state.module === "about") { close(); return; }
      const index = ORDER.indexOf(state.module) + direction;
      if (index < 0 || index >= ORDER.length) return;
      open(ORDER[index], state.rank);
    }
    function refreshModel() {
      if (layer.hidden || !state.module) return;
      const x = model();
      state.rank = Math.min(state.rank, x.ranks - 1);
      state.expert = Math.min(state.expert, x.totalExperts - 1);
      state.expertPage = Math.min(state.expertPage, Math.ceil(x.totalExperts / 32) - 1);
      state.dimensionPage = Math.min(state.dimensionPage, Math.ceil(x.hidden / 32) - 1);
      state.progress = 1;
      pause();
      render();
    }

    function renderControls() {
      const x = model();
      if (state.module === "about") { controls.innerHTML = ""; return; }
      const rankOptions = Array.from({ length: x.ranks }, (_, r) => `<option value="${r}" ${r === state.rank ? "selected" : ""}>R${r}</option>`).join("");
      const tokenOptions = Array.from({ length: x.tokensPerRank }, (_, t) => `<option value="${t}" ${t === state.token ? "selected" : ""}>T${t}</option>`).join("");
      let html = `<label>rank <select id="detail-rank">${rankOptions}</select></label>`;
      if (["input", "router", "combine", "output"].includes(state.module)) html += `<label>token <select id="detail-token">${tokenOptions}</select></label>`;
      if (["input", "expert", "combine", "output"].includes(state.module) && (state.module !== "combine" || state.sub === 1)) {
        const pages = Math.ceil(x.hidden / 32);
        html += `<label>向量窗口 <select id="detail-dim-page">${Array.from({ length: pages }, (_, page) => `<option value="${page}" ${page === state.dimensionPage ? "selected" : ""}>d${page * 32}–${Math.min(x.hidden - 1, page * 32 + 31)}</option>`).join("")}</select></label>`;
      }
      if (state.module === "router" && state.sub === 0) {
        html += `<label>专家窗口 <select id="detail-expert-page">${Array.from({ length: Math.ceil(x.totalExperts / 32) }, (_, page) => `<option value="${page}" ${page === state.expertPage ? "selected" : ""}>E${page * 32}–${Math.min(x.totalExperts - 1, page * 32 + 31)}</option>`).join("")}</select></label>`;
      }
      if (state.module === "expert") {
        html += `<label>expert <select id="detail-expert">${Array.from({ length: x.expertsPerRank }, (_, i) => {
          const e = state.rank * x.expertsPerRank + i;
          return `<option value="${e}" ${e === state.expert ? "selected" : ""}>E${e}</option>`;
        }).join("")}</select></label>`;
        if (state.sub === 1) {
          const taskCount = x.expertLoads[state.expert];
          html += `<label>任务页 <select id="detail-task-page">${Array.from({ length: Math.max(1, Math.ceil(taskCount / 16)) }, (_, page) => `<option value="${page}" ${page === state.taskPage ? "selected" : ""}>${page * 16 + 1}–${Math.min(taskCount, page * 16 + 16)}</option>`).join("")}</select></label>`;
        }
      }
      html += `<span class="small-stat">${x.totalTokens} token · ${x.totalTasks} 任务</span><button id="detail-play" class="mini-play" type="button">${state.playing ? "Ⅱ 暂停" : "▶ 播放"}</button><label>进度 <input id="detail-progress" type="range" min="0" max="100" value="${Math.round(state.progress * 100)}" aria-label="详细动画进度"></label>`;
      controls.innerHTML = html;
    }

    function render() {
      if (!state.module) return;
      const x = model(), meta = META[state.module];
      $("detail-number").textContent = meta.number;
      $("detail-title").textContent = meta.title;
      $("detail-shape").textContent = shapeFor(state.module, x);
      $("detail-subnav").innerHTML = meta.tabs.map((tab, index) => `<button type="button" role="tab" aria-selected="${index === state.sub}" class="${index === state.sub ? "active" : ""}" data-sub="${index}">${index + 1}. ${tab}</button>`).join("");
      $("detail-prev").disabled = state.module === "about" || state.module === ORDER[0];
      $("detail-next").disabled = state.module === "about" || state.module === ORDER[ORDER.length - 1];
      $("detail-advance").textContent = state.sub < meta.tabs.length - 1 ? "下一小节 →" : state.module === ORDER[ORDER.length - 1] || state.module === "about" ? "关闭详情 ×" : "下一模块 →";
      renderControls();
      renderBody();
    }

    function renderBody() {
      if (!state.module) return;
      const x = model();
      let html = "";
      if (state.module === "input") html = renderInput(x);
      if (state.module === "router") html = renderRouter(x);
      if (state.module === "dispatch") html = renderDispatch(x);
      if (state.module === "expert") html = renderExpert(x);
      if (state.module === "combine") html = renderCombine(x);
      if (state.module === "output") html = renderOutput(x);
      if (state.module === "about") html = renderAbout(x);
      body.innerHTML = html;
      $("detail-status").textContent = state.module === "about" ? "来源与教学边界" : `R${state.rank} · ${META[state.module].tabs[state.sub]} · ${Math.round(state.progress * 100)}%`;
      if (state.module === "dispatch" && state.sub === 0) drawTraffic(x);
    }

    function renderInput(x) {
      const start = state.dimensionPage * 32;
      if (state.sub === 0) {
        const grid = heatmap(x.tokensPerRank, 32, (t) => `T${t}`, (t, d) => M.inputValue(state.rank, t, start + d), {
          focusRow: state.token, progress: state.progress, colStart: start, aria: "输入 token 向量热力图"
        });
        return `<div class="detail-intro"><p>每条水平带是一份 token 向量。当前只展开 <strong>R${state.rank}</strong> 的 16 行与 32 个维度；下拉框可访问全部 ${x.hidden} 维。</p>${shapeTag(`X[R${state.rank}] ∈ ℝ^(16×${x.hidden})`)}</div><div class="viz-split"><div class="viz-main"><div class="viz-head"><span>输入矩阵 · 数值 −1 到 1</span><span>蓝负 · 红正</span></div>${grid}</div><aside class="viz-side">${metrics([["全模型 token", x.totalTokens], ["当前 rank", x.tokensPerRank], ["每 token", M.formatBytes(x.hidden * 2)], ["当前 rank 张量", M.formatBytes(x.tokensPerRank * x.hidden * 2)]])}${mathCard("<mi>X</mi><mo>∈</mo><msup><mi>ℝ</mi><mrow><mi>T</mi><mo>×</mo><mi>H</mi></mrow></msup>", "按 token 行与 hidden 维组织；此处数值为确定性的教学输入。")}</aside></div>`;
      }
      const values = Array.from({ length: 32 }, (_, d) => M.inputValue(state.rank, state.token, start + d));
      const bars = values.map((v, d) => `<div class="bar-column"><span>${f3(v)}</span><i style="height:${Math.max(5, Math.abs(v) * 75)}%;background:${signedColor(v)};opacity:${d <= state.progress * 31 ? 1 : .45}"></i><b>${start + d}</b></div>`).join("");
      return `<div class="detail-intro"><p>选中 <strong>R${state.rank}:T${state.token}</strong> 后，展开它的向量窗口；条高表示绝对值，蓝色为负，红色为正。</p>${shapeTag(`x[${state.rank},${state.token},${start}:${start + 32}]`)}</div><div class="viz-split"><div class="viz-main"><div class="viz-head"><span>32 个维度的逐项展开</span><span>每格 2 字节 · BF16 载荷估算</span></div><div class="bar-chart">${bars}</div></div><aside class="viz-side">${metrics([["选中 token", `R${state.rank}:T${state.token}`], ["维度总数", x.hidden], ["窗口首值", f3(values[0])], ["窗口末值", f3(values[31])]])}${mathCard("<msub><mi>x</mi><mrow><mi>r</mi><mo>,</mo><mi>t</mi></mrow></msub><mo>=</mo><mo>(</mo><msub><mi>x</mi><mn>0</mn></msub><mo>,</mo><mi>…</mi><mo>,</mo><msub><mi>x</mi><mrow><mi>H</mi><mo>−</mo><mn>1</mn></mrow></msub><mo>)</mo>", "窗口只裁切显示，不把 32 个可见元素说成完整向量。")}</aside></div>`;
    }

    function renderRouter(x) {
      const globalToken = state.rank * x.tokensPerRank + state.token;
      const selected = x.tokenRoutes[globalToken];
      if (state.sub === 0) {
        const start = state.expertPage * 32;
        const cols = Math.min(32, x.totalExperts - start);
        const grid = heatmap(x.tokensPerRank, cols, (t) => `T${t}`, (t, e) => M.scoreFor(state.rank * x.tokensPerRank + t, start + e, x.scenario), {
          focusRow: state.token, progress: state.progress, colPrefix: "E", colStart: start,
          colorFor: (v, t, e) => x.tokenRoutes[state.rank * x.tokensPerRank + t].some((r) => r.expert === start + e) ? scoreColor(v + .4) : scoreColor(v * .65),
          aria: "路由评分与选中专家热力图"
        });
        return `<div class="detail-intro"><p>Router 给每个 token 的 ${x.totalExperts} 个专家打分。矩阵展示 <strong>R${state.rank}</strong> 的全部 ${x.tokensPerRank} 行和一个 32 列专家窗口；较深的格子表示较高评分。</p>${shapeTag(`S[R${state.rank}] ∈ ℝ^(${x.tokensPerRank}×${x.totalExperts})`)}</div><div class="viz-split"><div class="viz-main"><div class="viz-head"><span>token × expert 评分矩阵</span><span>点击某行追踪 token</span></div>${grid}</div><aside class="viz-side">${metrics([["候选专家", x.totalExperts], ["每 token 激活", x.topK], ["当前 token", `T${state.token}`], ["首选专家", `E${selected[0].expert}`]])}<div class="viz-head" style="margin-top:16px"><span>当前 Top-${x.topK}</span></div>${routeList(selected)}${mathCard("<msub><mi>S</mi><mrow><mi>t</mi><mo>,</mo><mi>e</mi></mrow></msub><mo>→</mo><mtext>Top-k</mtext>", "评分是确定性教学值；实际 Router 可有不同函数与约束。")}</aside></div>`;
      }
      const rows = Array.from({ length: x.tokensPerRank }, (_, t) => {
        const routes = x.tokenRoutes[state.rank * x.tokensPerRank + t];
        const parts = routes.map((r, i) => `<div class="contribution-cell" title="E${r.expert}: ${(r.weight * 100).toFixed(1)}%" style="background:rgba(106,82,216,${(i < state.progress * x.topK ? .78 : .24).toFixed(2)})"><span>E${r.expert}<br>${(r.weight * 100).toFixed(0)}%</span></div>`).join("");
        return `<div class="contribution-row ${t === state.token ? "active" : ""}" style="--k:${x.topK}" data-token-row="${t}"><b>T${t}</b>${parts}<span>Σ = 1</span></div>`;
      }).join("");
      return `<div class="detail-intro"><p>每行保留评分最高的 <strong>${x.topK} 个专家</strong>，再把选中分数归一化。切换 Top-k 会重新建立全部任务与权重。</p>${shapeTag(`${x.tokensPerRank}×${x.topK} 选择`)}</div><div class="viz-split"><div class="viz-main"><div class="viz-head"><span>Top-k 选择 · 左至右按评分排序</span><span>当前 token：T${state.token}</span></div>${rows}</div><aside class="viz-side">${metrics([["选中任务", selected.length], ["权重之和", selected.reduce((sum, r) => sum + r.weight, 0).toFixed(6)], ["本地任务", selected.filter((r) => r.dstRank === state.rank).length], ["跨 rank 任务", selected.filter((r) => r.dstRank !== state.rank).length]])}${routeList(selected)}${mathCard("<msub><mi>w</mi><mrow><mi>t</mi><mo>,</mo><mi>e</mi></mrow></msub><mo>=</mo><mfrac><mrow><mi>exp</mi><mo>(</mo><msub><mi>S</mi><mrow><mi>t</mi><mo>,</mo><mi>e</mi></mrow></msub><mo>/</mo><mn>0.22</mn><mo>)</mo></mrow><mrow><munderover><mo>∑</mo><mrow><mi>j</mi><mo>∈</mo><mtext>Top-k</mtext></mrow><mrow></mrow></munderover><mrow><mi>exp</mi><mo>(</mo><msub><mi>S</mi><mrow><mi>t</mi><mo>,</mo><mi>j</mi></mrow></msub><mo>/</mo><mn>0.22</mn><mo>)</mo></mrow></mrow></mfrac>", "本教学模型以温度 0.22 对 Top-k 分数做 softmax，权重和为 1。")}</aside></div>`;
    }

    function renderDispatch(x) {
      if (state.sub === 0) {
        const destinations = Array.from({ length: x.ranks }, (_, dst) => x.traffic[state.rank * x.ranks + dst]);
        const cross = destinations.reduce((sum, count, dst) => sum + (dst === state.rank ? 0 : count), 0);
        return `<div class="detail-intro"><p>每格是 <strong>源 rank → 目标 rank</strong> 的专家任务数。EP${x.ranks} 时绘出完整 ${x.ranks}×${x.ranks} 矩阵；对角线是本地任务。</p>${shapeTag(`C ∈ ℕ^(${x.ranks}×${x.ranks})`)}</div><div class="viz-split"><div class="viz-main"><div class="viz-head"><span>Dispatch 流量矩阵</span><span>横轴目标 rank · 纵轴源 rank</span></div><canvas id="traffic-canvas" class="matrix-canvas" width="520" height="520" data-action="traffic-select" aria-label="点击源 rank 与目标 rank 的流量矩阵"></canvas><div class="density-legend"><span>0 条</span><span>任务数越多颜色越深</span></div></div><aside class="viz-side">${metrics([["总任务数", x.totalTasks], ["跨 rank 任务", x.crossRankTasks], [`R${state.rank} 发送`, x.tokensPerRank * x.topK], [`R${state.rank} 跨 rank`, cross]])}<div class="viz-head" style="margin-top:16px"><span>R${state.rank} 的目标分布</span></div><div class="density-bar">${destinations.map((count, dst) => `<i title="R${dst}: ${count}" style="width:${Math.max(.5, count / (x.tokensPerRank * x.topK) * 100)}%;background:${dst === state.rank ? "#b7c1d2" : "#8cb6ee"}"></i>`).join("")}</div><div class="density-legend"><span>本地 + 远端合计 ${destinations.reduce((a,b)=>a+b,0)}</span><span>单向跨 rank ${M.formatBytes(x.crossRankBytes)}</span></div>${mathCard("<msub><mi>C</mi><mrow><mi>r</mi><mo>,</mo><mi>q</mi></mrow></msub><mo>=</mo><mo>#</mo><mo>{</mo><mi>t</mi><mo>,</mo><mi>e</mi><mo>:</mo><mi>owner</mi><mo>(</mo><mi>e</mi><mo>)</mo><mo>=</mo><mi>q</mi><mo>}</mo>", "任务数来自完整路由模型，不是图上曲线的条数。")}</aside></div>`;
      }
      const routes = x.routes.filter((route) => route.srcRank === state.rank)
        .sort((a, b) => a.dstRank - b.dstRank || a.token - b.token || a.slot - b.slot);
      const revealed = Math.max(1, Math.round(state.progress * routes.length));
      const rows = routes.map((route, index) => `<tr class="${index < revealed ? "revealed" : ""}" data-token-row="${route.token}" style="opacity:${index < revealed ? 1 : .3};animation-delay:${(index % 12) * 14}ms"><td>${index}</td><td>R${route.srcRank}:T${route.token}</td><td>E${route.expert}</td><td>R${route.dstRank}</td><td>${(route.weight * 100).toFixed(1)}%</td><td>${route.srcRank === route.dstRank ? "本地" : "跨 rank"}</td></tr>`).join("");
      let offset = 0;
      const offsets = Array.from({ length: x.ranks }, (_, dst) => {
        const count = x.traffic[state.rank * x.ranks + dst], previous = offset;
        offset += count;
        return count ? `<li><span>发往 R${dst}</span><b>${count} 条 · 起始 ${previous}</b></li>` : "";
      }).join("");
      return `<div class="detail-intro"><p>R${state.rank} 的 ${x.tokensPerRank} 个 token 生成 <strong>${routes.length} 条任务记录</strong>。播放会依次显露记录；滚动可查看全部，来源 token 与目标专家从同一模型推导。</p>${shapeTag(`${routes.length}×(src,t,e,w,dst)`)}</div><div class="viz-split"><div class="viz-main"><div class="viz-head"><span>完整发送任务清单</span><span>已显露 ${revealed}/${routes.length}</span></div><table class="task-table"><thead><tr><th>#</th><th>来源</th><th>专家</th><th>目标</th><th>权重</th><th>路径</th></tr></thead><tbody>${rows}</tbody></table></div><aside class="viz-side">${metrics([["记录总数", routes.length], ["已显露", revealed], ["每记录 token 载荷", M.formatBytes(x.hidden * 2)], ["全部逻辑载荷", M.formatBytes(routes.length * x.hidden * 2)]])}<div class="viz-head" style="margin-top:16px"><span>按目标 rank 打包的前缀</span></div><ul class="detail-list">${offsets}</ul>${mathCard("<msub><mi>offset</mi><mi>q</mi></msub><mo>=</mo><munderover><mo>∑</mo><mrow><mi>j</mi><mo>&lt;</mo><mi>q</mi></mrow><mrow></mrow></munderover><msub><mi>C</mi><mrow><mi>r</mi><mo>,</mo><mi>j</mi></mrow></msub>", "前缀只是教学打包索引，不声明特定通信库的真实缓冲布局。")}</aside></div>`;
    }

    function renderExpert(x) {
      const local = Array.from({ length: x.expertsPerRank }, (_, i) => state.rank * x.expertsPerRank + i);
      if (state.sub === 0) {
        const max = Math.max(...local.map((e) => x.expertLoads[e]), 1);
        const bars = local.map((e) => `<div class="bar-column ${e === state.expert ? "active" : ""}" data-expert="${e}"><span>${x.expertLoads[e]} 条</span><i style="height:${Math.max(5, x.expertLoads[e] / max * 86 * state.progress)}%"></i><b>E${e}</b></div>`).join("");
        const loadMax = Math.max(...x.expertLoads);
        const heat = `<div class="tensor-grid" style="grid-template-columns:repeat(${x.totalExperts},minmax(2px,1fr));gap:1px">${Array.from(x.expertLoads, (count, expert) => `<span class="tensor-cell" title="E${expert}: ${count}" style="height:38px;min-width:2px;background:${scoreColor(count / Math.max(loadMax,1) * 1.5)}"></span>`).join("")}</div>`;
        return `<div class="detail-intro"><p>目标 rank 按专家收集来自所有源 rank 的任务。条高是 <strong>R${state.rank}</strong> 各专家的实际接收条数；下方细条保留全 ${x.totalExperts} 个专家的负载。</p>${shapeTag(`load[e], e=0…${x.totalExperts - 1}`)}</div><div class="viz-split"><div class="viz-main"><div class="viz-head"><span>R${state.rank} 的 ${x.expertsPerRank} 个专家</span><span>点击柱子查看数据变换</span></div><div class="bar-chart">${bars}</div><div class="viz-head" style="margin-top:21px"><span>所有专家的负载带</span><span>E0 → E${x.totalExperts - 1}</span></div>${heat}</div><aside class="viz-side">${metrics([["当前 rank 收到", local.reduce((sum,e)=>sum+x.expertLoads[e],0)], ["最忙专家", `E${Array.from(x.expertLoads).indexOf(loadMax)}`], ["最大任务数", loadMax], ["当前 E" + state.expert, x.expertLoads[state.expert]]])}<ul class="detail-list">${local.map((e)=>`<li><span>E${e}</span><b>${x.expertLoads[e]} token 副本</b></li>`).join("")}</ul>${mathCard("<msub><mi>L</mi><mi>e</mi></msub><mo>=</mo><mo>#</mo><mo>{</mo><mi>route</mi><mo>:</mo><mi>expert</mi><mo>=</mo><mi>e</mi><mo>}</mo>", "负载不均可形成热点；这不是计算时间的实测。")}</aside></div>`;
      }
      const all = x.routes.filter((route) => route.expert === state.expert);
      const page = all.slice(state.taskPage * 16, state.taskPage * 16 + 16);
      const start = state.dimensionPage * 32;
      const grid = heatmap(page.length, 32, (i) => `R${page[i].srcRank}:T${page[i].token}`, (i,d) => {
        const route = page[i], input = M.inputValue(route.srcRank, route.token, start + d);
        return input + state.progress * (M.expertValue(input, state.expert) - input);
      }, { progress: 1, colStart: start, aria: "专家输入到输出向量的逐步变化" });
      const first = page[0];
      const sampleInput = first ? M.inputValue(first.srcRank, first.token, start) : 0;
      return `<div class="detail-intro"><p>E${state.expert} 实际收到 <strong>${all.length} 份任务</strong>。热力图只显示当前 16 条任务页和 32 个维度；播放时每格从输入值连续变为教学专家输出值。</p>${shapeTag(`F_${state.expert}: [${all.length},${x.hidden}] → [${all.length},${x.hidden}]`)}</div><div class="viz-split"><div class="viz-main"><div class="viz-head"><span>专家向量变换 · 第 ${state.taskPage + 1} 页</span><span>进度 ${Math.round(state.progress * 100)}%</span></div>${grid}</div><aside class="viz-side">${metrics([["收到任务", all.length], ["当前页显示", page.length], ["首任务输入 d" + start, f3(sampleInput)], ["首任务输出 d" + start, f3(M.expertValue(sampleInput,state.expert))]])}<ul class="detail-list">${page.slice(0,8).map((route) => `<li><span>${taskName(route)}</span><b>${route.srcRank === state.rank ? "本地" : "跨 rank"}</b></li>`).join("")}</ul>${mathCard("<msub><mi>F</mi><mi>e</mi></msub><mo>(</mo><msub><mi>x</mi><mi>d</mi></msub><mo>)</mo><mo>=</mo><msub><mi>x</mi><mi>d</mi></msub><mo>(</mo><mn>1</mn><mo>+</mo><mn>0.003</mn><mi>e</mi><mo>)</mo><mo>+</mo><mn>0.015</mn><mo>(</mo><mi>e</mi><mo>mod</mo><mn>9</mn><mo>−</mo><mn>4</mn><mo>)</mo>", "F 是可视化用的逐维仿射函数，不代表真实 FFN。")}</aside></div>`;
    }

    function renderCombine(x) {
      const tokenRoutes = x.tokenRoutes[state.rank * x.tokensPerRank + state.token];
      if (state.sub === 0) {
        const rows = Array.from({ length: x.tokensPerRank }, (_, token) => {
          const routes = x.tokenRoutes[state.rank * x.tokensPerRank + token];
          const cells = routes.map((route) => {
            const input = M.inputValue(state.rank, token, 0);
            const contribution = route.weight * M.expertValue(input, route.expert);
            return `<div class="contribution-cell" title="E${route.expert}: ${f3(contribution)}" style="background:${signedColor(contribution * state.progress)}"></div>`;
          }).join("");
          const value = M.outputValue(x,state.rank,token,0);
          return `<div class="contribution-row ${token === state.token ? "active" : ""}" style="--k:${x.topK}" data-token-row="${token}"><b>T${token}</b>${cells}<span>${f3(value * state.progress)}</span></div>`;
        }).join("");
        const terms = tokenRoutes.map((route) => {
          const x0 = M.inputValue(state.rank,state.token,0);
          return `${f3(route.weight)}×${f3(M.expertValue(x0,route.expert))}`;
        }).join(" + ");
        return `<div class="detail-intro"><p>每行属于原 rank 的一个 token；${x.topK} 个彩格是返回的专家贡献。播放使贡献逐步累加，右侧数字回到<strong>原 token 槽位</strong>。</p>${shapeTag(`Y[R${state.rank}] ∈ ℝ^(${x.tokensPerRank}×${x.hidden})`)}</div><div class="viz-split"><div class="viz-main"><div class="viz-head"><span>token × 专家贡献 · 首个向量元素 d0</span><span>最后一列是当前累加值</span></div>${rows}</div><aside class="viz-side">${metrics([["返回任务", x.tokensPerRank * x.topK], ["选中 token", `T${state.token}`], ["权重和", tokenRoutes.reduce((sum,r)=>sum+r.weight,0).toFixed(6)], ["最终 y[d0]", f3(M.outputValue(x,state.rank,state.token,0))]])}<ul class="detail-list">${tokenRoutes.map((route)=>`<li><span>E${route.expert} → R${state.rank}:T${state.token}</span><b>${(route.weight*100).toFixed(1)}%</b></li>`).join("")}</ul>${mathCard("<msub><mi>y</mi><mrow><mi>t</mi><mo>,</mo><mi>d</mi></mrow></msub><mo>=</mo><munderover><mo>∑</mo><mrow><mi>j</mi><mo>=</mo><mn>1</mn></mrow><mi>K</mi></munderover><msub><mi>w</mi><mrow><mi>t</mi><mo>,</mo><mi>j</mi></mrow></msub><msub><mi>F</mi><msub><mi>e</mi><mi>j</mi></msub></msub><mo>(</mo><msub><mi>x</mi><mrow><mi>t</mi><mo>,</mo><mi>d</mi></mrow></msub><mo>)</mo>", `${terms} = ${f3(M.outputValue(x,state.rank,state.token,0))}`)}</aside></div>`;
      }
      const start = state.dimensionPage * 32;
      const grid = heatmap(x.tokensPerRank, 32, (t) => `T${t}`, (t,d) => {
        const input = M.inputValue(state.rank,t,start+d);
        return input + state.progress * (M.outputValue(x,state.rank,t,start+d)-input);
      }, { focusRow: state.token, progress: 1, colStart: start, aria: "Combine 返回并加权后的输出矩阵" });
      return `<div class="detail-intro"><p>专家侧任务可以乱序完成；Combine 按保存的 <strong>(原 rank, 原 token 槽位)</strong> 索引恢复结果。动画从输入矩阵过渡到合成输出。</p>${shapeTag(`index → (R${state.rank},T0…T${x.tokensPerRank-1})`)}</div><div class="viz-split"><div class="viz-main"><div class="viz-head"><span>恢复后的输出矩阵 · 当前窗口</span><span>蓝负 · 红正</span></div>${grid}</div><aside class="viz-side">${metrics([["输出行数", x.tokensPerRank], ["每行维度", x.hidden], ["当前 token", `R${state.rank}:T${state.token}`], ["当前 d" + start, f3(M.outputValue(x,state.rank,state.token,start))]])}${mathCard("<mi>slot</mi><mo>(</mo><mi>route</mi><mo>)</mo><mo>=</mo><mo>(</mo><mi>src_rank</mi><mo>,</mo><mi>src_token</mi><mo>)</mo>", "回传携带来源身份，不能把“图中飞回”当作完成确认。")}</aside></div>`;
    }

    function renderOutput(x) {
      const start = state.dimensionPage * 32;
      if (state.sub === 0) {
        const grid = heatmap(x.tokensPerRank, 32, (t)=>`T${t}`, (t,d)=>M.outputValue(x,state.rank,t,start+d), {
          focusRow: state.token, progress: state.progress, colStart: start, aria: "恢复原顺序后的输出矩阵"
        });
        return `<div class="detail-intro"><p>输出仍有 <strong>${x.totalTokens} 行 token</strong>，全量 shape 与输入相同。这里显示 R${state.rank} 的 16 行与当前 32 维窗口，而不是把可见窗口误作全量。</p>${shapeTag(`Y ∈ ℝ^(${x.totalTokens}×${x.hidden})`)}</div><div class="viz-split"><div class="viz-main"><div class="viz-head"><span>输出矩阵 · 原 token 顺序</span><span>点击某行追踪</span></div>${grid}</div><aside class="viz-side">${metrics([["输入 token", x.totalTokens], ["输出 token", x.totalTokens], ["输出总载荷", M.formatBytes(x.totalTokens*x.hidden*2)], ["当前首元素", f3(M.outputValue(x,state.rank,state.token,start))]])}${mathCard("<mtext>shape</mtext><mo>(</mo><mi>Y</mi><mo>)</mo><mo>=</mo><mtext>shape</mtext><mo>(</mo><mi>X</mi><mo>)</mo>", "行数恢复并不意味着值保持不变；值来自被选专家的加权结果。")}</aside></div>`;
      }
      const items = Array.from({length:x.tokensPerRank},(_,t)=>`<div class="order-item" data-token-row="${t}"><strong>R${state.rank}:T${t}</strong><span>x[d0] ${f3(M.inputValue(state.rank,t,0))}</span><br><span>y[d0] ${f3(M.outputValue(x,state.rank,t,0))}</span></div>`).join("");
      return `<div class="detail-intro"><p>按原 rank 与原槽位排列的 16 个输出。每格显示 <strong>同一个 token</strong> 的输入和加权后首元素，顺序没有因专家侧重排而改变。</p>${shapeTag(`R${state.rank}:T0 → R${state.rank}:T${x.tokensPerRank-1}`)}</div><div class="viz-split"><div class="viz-main"><div class="viz-head"><span>原槽位索引 · 输入 → 输出</span><span>点击任意 token</span></div><div class="order-list">${items}</div></div><aside class="viz-side">${metrics([["原 rank", `R${state.rank}`], ["槽位数", x.tokensPerRank], ["专家任务数", x.tokensPerRank*x.topK], ["返回输出数", x.tokensPerRank]])}${mathCard("<msub><mi>Y</mi><mrow><mi>r</mi><mo>,</mo><mi>t</mi></mrow></msub><mo>←</mo><mtext>Combine</mtext><mo>(</mo><msub><mi>route</mi><mrow><mi>r</mi><mo>,</mo><mi>t</mi></mrow></msub><mo>)</mo>", "每个源 token 对应一个输出槽位。")}</aside></div>`;
    }

    function renderAbout(x) {
      return `<div class="detail-intro"><p>本网站用完整参数规模的确定性<strong>教学数据</strong>演示 MoE 数据流。所有统计、矩阵、任务清单来自同一模型；它不是 DeepEP 实机 trace。</p>${shapeTag(`${x.ranks} rank · ${x.totalTokens} token · ${x.totalTasks} 任务`)}</div><div class="viz-split"><div class="viz-main">${metrics([["rank 数", x.ranks], ["专家数", x.totalExperts], ["Top-k", x.topK], ["hidden 维度", x.hidden], ["全部逻辑载荷/方向", M.formatBytes(x.allPayloadBytes)], ["跨 rank token 载荷/方向", M.formatBytes(x.crossRankBytes)]])}<div class="math-card"><strong>模型边界</strong><br>Router 分数、输入向量和逐维专家函数均为可复算的教学构造。BF16 只用于载荷字节估算；页面数值由 JavaScript Number 计算，不模拟 BF16 舍入。流量不含权重、索引、对齐、协议与重传。阶段动画不表示真实网络完成、同步或性能。</div></div><aside class="viz-side"><div class="viz-head"><span>来源</span></div><ul class="detail-list"><li><span>通信原理接口</span><b><a class="source-link" href="https://github.com/deepseek-ai/DeepEP" target="_blank" rel="noopener noreferrer">DeepEP 官方仓库 ↗</a></b></li><li><span>交互方式参考</span><b><a class="source-link" href="https://poloclub.github.io/transformer-explainer/" target="_blank" rel="noopener noreferrer">Transformer Explainer ↗</a></b></li></ul><div class="math-card">仅借鉴参考站的逐层展开与画布交互方式；本站的模型、图形、代码和文字独立实现。</div></aside></div>`;
    }

    function drawTraffic(x) {
      const canvas = $("traffic-canvas");
      if (!canvas) return;
      const context = canvas.getContext("2d");
      const cell = 520 / x.ranks;
      const max = Math.max(...x.traffic, 1);
      context.clearRect(0,0,520,520);
      for (let src=0; src<x.ranks; src++) for (let dst=0; dst<x.ranks; dst++) {
        const count=x.traffic[src*x.ranks+dst];
        const alpha=.08 + .82 * Math.sqrt(count/max);
        context.fillStyle=`rgba(105,82,218,${alpha})`;
        context.fillRect(dst*cell,src*cell,Math.max(1,cell-.5),Math.max(1,cell-.5));
      }
      context.strokeStyle="#e26b8d";
      context.lineWidth=Math.max(1.5,cell*.045);
      context.strokeRect(.5,state.rank*cell+.5,519,Math.max(1,cell-1));
      if (x.ranks<=8) {
        context.fillStyle="#536078";
        context.font="12px sans-serif";
        context.textAlign="center";
        context.textBaseline="middle";
        for(let src=0;src<x.ranks;src++) for(let dst=0;dst<x.ranks;dst++) {
          context.fillText(String(x.traffic[src*x.ranks+dst]),dst*cell+cell/2,src*cell+cell/2);
        }
      }
    }

    $("detail-close").addEventListener("click",close);
    $("detail-backdrop").addEventListener("click",close);
    $("detail-prev").addEventListener("click",()=>shiftModule(-1));
    $("detail-next").addEventListener("click",()=>shiftModule(1));
    $("detail-advance").addEventListener("click",()=>{
      if (state.sub<META[state.module].tabs.length-1) setSub(state.sub+1);
      else if(state.module==="about" || state.module===ORDER[ORDER.length-1]) close();
      else shiftModule(1);
    });
    $("detail-subnav").addEventListener("click",(event)=>{
      const button=event.target.closest("[data-sub]");
      if(button) setSub(Number(button.dataset.sub));
    });
    controls.addEventListener("change",(event)=>{
      const id=event.target.id, value=Number(event.target.value);
      if(id==="detail-rank") { state.rank=value; state.token=0; state.expert=state.rank*model().expertsPerRank; state.taskPage=0; }
      if(id==="detail-token") state.token=value;
      if(id==="detail-dim-page") state.dimensionPage=value;
      if(id==="detail-expert-page") state.expertPage=value;
      if(id==="detail-expert") { state.expert=value; state.taskPage=0; }
      if(id==="detail-task-page") state.taskPage=value;
      pause();
      render();
    });
    controls.addEventListener("click",(event)=>{
      if(event.target.id==="detail-play") play();
    });
    controls.addEventListener("input",(event)=>{
      if(event.target.id==="detail-progress") {
        pause();
        state.progress=Number(event.target.value)/100;
        renderBody();
      }
    });
    body.addEventListener("click",(event)=>{
      const row=event.target.closest("[data-token-row]");
      if(row) {
        pause();
        state.token=Number(row.dataset.tokenRow);
        renderControls();
        renderBody();
      }
      const expert=event.target.closest("[data-expert]");
      if(expert) {
        pause();
        state.expert=Number(expert.dataset.expert);
        setSub(1);
      }
      const traffic=event.target.closest("[data-action='traffic-select']");
      if(traffic) {
        const rect=traffic.getBoundingClientRect();
        const src=Math.min(model().ranks-1,Math.floor((event.clientY-rect.top)/rect.height*model().ranks));
        pause();
        state.rank=Math.max(0,src);
        render();
      }
    });
    document.addEventListener("keydown",(event)=>{
      if(layer.hidden) return;
      if(event.key==="Escape") { event.preventDefault(); close(); }
    });
    return { open, close, refreshModel, isOpen:()=>!layer.hidden, current:()=>state.module };
  }
  root.MoeDetails = { create };
})(window);
