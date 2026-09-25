(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.MoeModel = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";

  const PRESETS = Object.freeze({
    ep8: { label: "EP8", ranks: 8, tokensPerRank: 16, expertsPerRank: 4, hidden: 4096, defaultK: 4 },
    ep64: { label: "EP64", ranks: 64, tokensPerRank: 16, expertsPerRank: 4, hidden: 7168, defaultK: 8 }
  });

  function hash32(value) {
    let x = value | 0;
    x = Math.imul(x ^ (x >>> 16), 0x7feb352d);
    x = Math.imul(x ^ (x >>> 15), 0x846ca68b);
    return (x ^ (x >>> 16)) >>> 0;
  }

  function scoreFor(globalToken, expert, scenario) {
    const seed = Math.imul(globalToken + 1, 0x9e3779b1) ^ Math.imul(expert + 1, 0x85ebca6b);
    const base = hash32(seed) / 0xffffffff;
    if (scenario === "hotspot") return base + (expert === 2 ? 1.55 : expert === 3 ? 0.65 : 0);
    return base;
  }

  function inputValue(rank, token, dimension) {
    const seed = Math.imul(rank + 3, 73856093) ^ Math.imul(token + 5, 19349663) ^ Math.imul(dimension + 7, 83492791);
    return (hash32(seed) / 0xffffffff) * 2 - 1;
  }

  function expertValue(input, expert) {
    // 可手算的教学变换，不代表真实专家 FFN。
    return input * (1 + expert * 0.003) + ((expert % 9) - 4) * 0.015;
  }

  function buildModel(options) {
    const preset = PRESETS[options.preset] || PRESETS.ep8;
    const scenario = options.scenario === "hotspot" ? "hotspot" : "balanced";
    const topK = Math.max(1, Math.min(Number(options.topK) || preset.defaultK, preset.ranks * preset.expertsPerRank));
    const totalExperts = preset.ranks * preset.expertsPerRank;
    const totalTokens = preset.ranks * preset.tokensPerRank;
    const routes = [];
    const tokenRoutes = Array.from({ length: totalTokens }, () => []);
    const expertLoads = new Uint32Array(totalExperts);
    const traffic = new Uint32Array(preset.ranks * preset.ranks);
    let crossRankTasks = 0;

    for (let globalToken = 0; globalToken < totalTokens; globalToken++) {
      const srcRank = Math.floor(globalToken / preset.tokensPerRank);
      const token = globalToken % preset.tokensPerRank;
      const candidates = Array.from({ length: totalExperts }, (_, expert) => ({ expert, score: scoreFor(globalToken, expert, scenario) }));
      candidates.sort((a, b) => b.score - a.score || a.expert - b.expert);
      const chosen = candidates.slice(0, topK);
      const high = chosen[0].score;
      const expScores = chosen.map((item) => Math.exp((item.score - high) / 0.22));
      const normalizer = expScores.reduce((a, b) => a + b, 0);

      chosen.forEach((item, slot) => {
        const dstRank = Math.floor(item.expert / preset.expertsPerRank);
        const route = {
          index: routes.length, globalToken, srcRank, token, expert: item.expert, dstRank,
          slot, score: item.score, weight: expScores[slot] / normalizer
        };
        routes.push(route);
        tokenRoutes[globalToken].push(route);
        expertLoads[item.expert]++;
        traffic[srcRank * preset.ranks + dstRank]++;
        if (srcRank !== dstRank) crossRankTasks++;
      });
    }

    return {
      ...preset, preset: options.preset in PRESETS ? options.preset : "ep8", scenario, topK,
      totalExperts, totalTokens, totalTasks: routes.length, routes, tokenRoutes,
      expertLoads, traffic, crossRankTasks,
      crossRankBytes: crossRankTasks * preset.hidden * 2,
      allPayloadBytes: routes.length * preset.hidden * 2
    };
  }

  function outputValue(model, rank, token, dimension) {
    const input = inputValue(rank, token, dimension);
    const globalToken = rank * model.tokensPerRank + token;
    return model.tokenRoutes[globalToken].reduce((sum, route) => sum + route.weight * expertValue(input, route.expert), 0);
  }

  function groupedTraffic(model, laneCount = 8) {
    const groupSize = model.ranks / laneCount;
    const groups = new Uint32Array(laneCount * laneCount);
    for (let src = 0; src < model.ranks; src++) {
      for (let dst = 0; dst < model.ranks; dst++) {
        const from = Math.floor(src / groupSize), to = Math.floor(dst / groupSize);
        groups[from * laneCount + to] += model.traffic[src * model.ranks + dst];
      }
    }
    return groups;
  }

  function formatBytes(bytes) {
    if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
    return `${(bytes / 1024).toFixed(1)} KiB`;
  }

  return { PRESETS, buildModel, scoreFor, inputValue, expertValue, outputValue, groupedTraffic, formatBytes };
});
