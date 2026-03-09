(() => {
  "use strict";

  const SAVE_DB_KEY = "dct_save_db_v1";
  const LAST_KEYWORD_KEY = "dct_last_keyword_v1";
  const TUTORIAL_KEY = "dct_tutorial_seen";

  const COLS = 20;
  const ROWS = 14;
  const TILE = 32;
  const BASE = { FLOOR: 0, WALL: 1, HUB: 3 };
  const ENTITY = { CABLE: "cable", RACK: "rack", COOLING: "cooling", POWER: "power" };
  const TOOL = { INSPECT: "inspect", CABLE: "cable", RACK: "rack", COOLING: "cooling", POWER: "power", BULLDOZE: "bulldoze" };

  const COSTS = {
    cable: 5,
    rack: 50,
    cooling: 40,
    power: 40,
    rackUpgradeBase: 65
  };
  const SELL_REFUND_RATE = 0.5;

  const GLOBAL_UPGRADE_BASE = {
    networkSpeed: 140,
    coolingEfficiency: 125,
    powerEfficiency: 125,
    packetValue: 160
  };

  const TOOL_INFO = {
    inspect: "Inspect tiles and buildings. Select racks to upgrade or remove.",
    cable: "Lay cable paths from racks to the hub. Cables auto-connect.",
    rack: "Server rack. Generates packets when powered, cooled, and connected.",
    cooling: "Cooling unit. Supports heat in a radius of 3 tiles.",
    power: "Power unit. Supplies power in a radius of 3 tiles.",
    bulldoze: "Remove placed structures and get a partial refund."
  };

  const el = {
    canvas: document.getElementById("gameCanvas"),
    moneyValue: document.getElementById("moneyValue"),
    incomeValue: document.getElementById("incomeValue"),
    packetsValue: document.getElementById("packetsValue"),
    timeValue: document.getElementById("timeValue"),
    activeRacksValue: document.getElementById("activeRacksValue"),
    troubleRacksValue: document.getElementById("troubleRacksValue"),
    toolDesc: document.getElementById("toolDesc"),
    inspectContent: document.getElementById("inspectContent"),
    upgradeSummary: document.getElementById("upgradeSummary"),
    activityFeed: document.getElementById("activityFeed"),
    toastLayer: document.getElementById("toastLayer"),
    goalChip: document.getElementById("goalChip"),
    pauseBtn: document.getElementById("pauseBtn"),
    saveBtn: document.getElementById("saveBtn"),
    resetBtn: document.getElementById("resetBtn"),
    switchProfileBtn: document.getElementById("switchProfileBtn"),
    toolbar: document.getElementById("toolbar"),
    upgradesBtn: document.getElementById("upgradesBtn"),
    startOverlay: document.getElementById("startOverlay"),
    keywordInput: document.getElementById("keywordInput"),
    keywordStatus: document.getElementById("keywordStatus"),
    loadKeywordBtn: document.getElementById("loadKeywordBtn"),
    tutorialOverlay: document.getElementById("tutorialOverlay"),
    tutorialCloseBtn: document.getElementById("tutorialCloseBtn"),
    upgradeOverlay: document.getElementById("upgradeOverlay"),
    closeUpgradesBtn: document.getElementById("closeUpgradesBtn"),
    failureOverlay: document.getElementById("failureOverlay"),
    loadAutosaveBtn: document.getElementById("loadAutosaveBtn"),
    restartBtn: document.getElementById("restartBtn")
  };

  const ctx = el.canvas.getContext("2d");

  let state = null;
  let running = false;
  let paused = false;
  let hover = null;
  let selected = null;
  let currentTool = TOOL.INSPECT;
  let lastFrame = performance.now();
  let simAccumulator = 0;
  let displayMoney = 0;
  let lastNoMoneyToastAt = 0;
  let hudSnapshot = null;

  function createDefaultState() {
    const base = [];
    const entities = [];

    for (let y = 0; y < ROWS; y += 1) {
      base[y] = [];
      entities[y] = [];
      for (let x = 0; x < COLS; x += 1) {
        const edge = x === 0 || y === 0 || x === COLS - 1 || y === ROWS - 1;
        base[y][x] = edge ? BASE.WALL : BASE.FLOOR;
        entities[y][x] = null;
      }
    }

    const hub = { x: COLS - 4, y: 2 };
    base[hub.y][hub.x] = BASE.HUB;

    return {
      base,
      entities,
      hub,
      money: 150,
      totalPackets: 0,
      totalRevenue: 0,
      timeSeconds: 0,
      rackIdCounter: 1,
      packets: [],
      incomeEvents: [],
      collapseMeter: 0,
      warningsFlash: 0,
      activity: [],
      currentKeyword: "",
      currentKeyId: "",
      tool: TOOL.INSPECT,
      upgrades: {
        networkSpeed: 0,
        coolingEfficiency: 0,
        powerEfficiency: 0,
        packetValue: 0
      }
    };
  }

  function normalizeKeyword(raw) {
    return String(raw || "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, "")
      .slice(0, 24);
  }

  function getSaveDb() {
    try {
      const raw = localStorage.getItem(SAVE_DB_KEY);
      if (!raw) return { profiles: {} };
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || !parsed.profiles) return { profiles: {} };
      return parsed;
    } catch (err) {
      console.warn("Failed to parse save DB", err);
      return { profiles: {} };
    }
  }

  function setSaveDb(db) {
    localStorage.setItem(SAVE_DB_KEY, JSON.stringify(db));
  }

  function getAllKeywords() {
    const db = getSaveDb();
    return Object.keys(db.profiles).sort((a, b) => {
      const ta = db.profiles[a]?.updatedAt || 0;
      const tb = db.profiles[b]?.updatedAt || 0;
      return tb - ta;
    });
  }

  function loadProfile(keyword) {
    const db = getSaveDb();
    const entry = db.profiles[keyword];
    if (!entry) return null;
    const restored = restoreState(entry.data);
    restored.currentKeyword = keyword;
    return restored;
  }

  function deleteProfile(keyword) {
    const db = getSaveDb();
    delete db.profiles[keyword];
    setSaveDb(db);
  }

  function migrateLegacySingleSaveIfPresent() {
    const legacyKeys = ["dct_save_v1", "dct_autosave_v1"];
    const hasDb = getAllKeywords().length > 0;
    if (hasDb) return;

    let payload = null;
    for (const key of legacyKeys) {
      const raw = localStorage.getItem(key);
      if (raw) {
        payload = raw;
        break;
      }
    }
    if (!payload) return;

    try {
      const data = JSON.parse(payload);
      const db = getSaveDb();
      db.profiles.legacy = { data, updatedAt: Date.now() };
      setSaveDb(db);
      localStorage.setItem(LAST_KEYWORD_KEY, "legacy");
    } catch (err) {
      console.warn("Legacy migration failed", err);
    }
  }

  function packStateForSave(s) {
    return {
      base: s.base,
      entities: s.entities,
      hub: s.hub,
      money: s.money,
      totalPackets: s.totalPackets,
      totalRevenue: s.totalRevenue,
      timeSeconds: s.timeSeconds,
      rackIdCounter: s.rackIdCounter,
      upgrades: s.upgrades,
      collapseMeter: s.collapseMeter
    };
  }

  function restoreState(saved) {
    const fresh = createDefaultState();
    const merged = {
      ...fresh,
      ...saved,
      packets: [],
      incomeEvents: [],
      warningsFlash: 0,
      activity: []
    };

    for (let y = 0; y < ROWS; y += 1) {
      for (let x = 0; x < COLS; x += 1) {
        const ent = merged.entities[y][x];
        if (ent && ent.type === ENTITY.RACK) {
          ent.genTimer = typeof ent.genTimer === "number" ? ent.genTimer : 0;
          ent.totalProfit = ent.totalProfit || 0;
          ent.totalPackets = ent.totalPackets || 0;
          ent.level = ent.level || 1;
          ent.totalInvested = ent.totalInvested || COSTS.rack;
          ent.status = "idle";
          ent.connected = false;
          ent.powerRatio = 0;
          ent.coolingRatio = 0;
        }
      }
    }

    return merged;
  }

  async function keywordToKeyId(keyword) {
    const text = `dct:${keyword}`;
    if (window.crypto?.subtle) {
      const data = new TextEncoder().encode(text);
      const digest = await window.crypto.subtle.digest("SHA-256", data);
      return Array.from(new Uint8Array(digest))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
    }
    return `legacy_${btoa(text).replace(/=/g, "")}`;
  }

  function canUseRemoteStorage() {
    return window.location.protocol === "https:" || window.location.hostname === "localhost";
  }

  async function loadProfileRemote(keyId) {
    if (!canUseRemoteStorage()) return null;
    const res = await fetch(`/api/load?key=${encodeURIComponent(keyId)}`, {
      method: "GET",
      cache: "no-store"
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`remote_load_${res.status}`);
    const payload = await res.json();
    return payload?.save || null;
  }

  async function saveProfileRemote(keyId, savePayload) {
    if (!canUseRemoteStorage()) return false;
    const res = await fetch("/api/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: keyId, save: savePayload })
    });
    if (!res.ok) throw new Error(`remote_save_${res.status}`);
    return true;
  }

  function saveGame() {
    if (!state?.currentKeyword) return;
    const payload = packStateForSave(state);
    const db = getSaveDb();
    db.profiles[state.currentKeyword] = {
      data: payload,
      updatedAt: Date.now()
    };
    setSaveDb(db);
    localStorage.setItem(LAST_KEYWORD_KEY, state.currentKeyword);
    if (state.currentKeyId) {
      saveProfileRemote(state.currentKeyId, payload).catch(() => {
        // Keep silent; local save remains the fallback.
      });
    }
  }

  function refreshKeywordStatus() {
    const keys = getAllKeywords();
    if (!keys.length) {
      el.keywordStatus.textContent = "No profile found on this browser yet. Enter a keyword to create one.";
      return;
    }
    el.keywordStatus.textContent = "Private mode: saved keywords are never listed.";
  }

  function openKeywordOverlay() {
    el.startOverlay.classList.add("show");
    const last = localStorage.getItem(LAST_KEYWORD_KEY) || "";
    el.keywordInput.value = last;
    refreshKeywordStatus();
    if (running) {
      paused = true;
      el.pauseBtn.textContent = "Resume";
    }
  }

  async function loadOrCreateByKeyword(rawKeyword) {
    const keyword = normalizeKeyword(rawKeyword);
    if (!keyword) {
      showToast("Enter a valid keyword", "bad");
      return;
    }

    const keyId = await keywordToKeyId(keyword);
    let existing = null;
    try {
      const remoteSave = await loadProfileRemote(keyId);
      if (remoteSave) {
        existing = restoreState(remoteSave);
      }
    } catch (err) {
      showToast("Remote save unavailable, using local backup.", "warn");
    }
    if (!existing) {
      existing = loadProfile(keyword);
    }

    state = existing || createDefaultState();
    state.currentKeyword = keyword;
    state.currentKeyId = keyId;
    running = true;
    paused = false;
    selected = null;
    setTool(TOOL.INSPECT);
    displayMoney = state.money;
    el.pauseBtn.textContent = "Pause";
    pushActivity(`Profile unlocked.`, "good");
    showToast("Profile loaded.", "good");
    saveGame();
    el.startOverlay.classList.remove("show");
    if (!localStorage.getItem(TUTORIAL_KEY)) {
      el.tutorialOverlay.classList.add("show");
    }
  }

  function inBounds(x, y) {
    return x >= 0 && y >= 0 && x < COLS && y < ROWS;
  }

  function isWalkableCableNode(x, y) {
    const b = state.base[y][x];
    const ent = state.entities[y][x];
    if (b === BASE.HUB) return true;
    if (!ent) return false;
    return ent.type === ENTITY.CABLE || ent.type === ENTITY.RACK;
  }

  function neighbors4(x, y) {
    return [
      [x + 1, y],
      [x - 1, y],
      [x, y + 1],
      [x, y - 1]
    ].filter(([nx, ny]) => inBounds(nx, ny));
  }

  function findPathToHub(startX, startY) {
    const key = (x, y) => `${x},${y}`;
    const queue = [[startX, startY]];
    const seen = new Set([key(startX, startY)]);
    const parent = new Map();

    while (queue.length) {
      const [cx, cy] = queue.shift();
      if (cx === state.hub.x && cy === state.hub.y) {
        const path = [];
        let cur = key(cx, cy);
        while (cur) {
          const [px, py] = cur.split(",").map(Number);
          path.push({ x: px, y: py });
          cur = parent.get(cur);
        }
        path.reverse();
        return path;
      }

      for (const [nx, ny] of neighbors4(cx, cy)) {
        if (!isWalkableCableNode(nx, ny)) continue;
        const nk = key(nx, ny);
        if (seen.has(nk)) continue;
        seen.add(nk);
        parent.set(nk, key(cx, cy));
        queue.push([nx, ny]);
      }
    }

    return null;
  }

  function recalcCableVariantsAround(x, y) {
    const candidates = [[x, y], ...neighbors4(x, y)];
    for (const [cx, cy] of candidates) {
      const ent = state.entities[cy][cx];
      if (!ent || ent.type !== ENTITY.CABLE) continue;
      const conn = cableConnections(cx, cy);
      const h = conn.left || conn.right;
      const v = conn.up || conn.down;
      ent.variantId = h && !v ? 4 : v && !h ? 5 : 6;
    }
  }

  function cableConnections(x, y) {
    const canConnect = (nx, ny) => {
      if (!inBounds(nx, ny)) return false;
      const base = state.base[ny][nx];
      const ent = state.entities[ny][nx];
      if (base === BASE.HUB) return true;
      if (!ent) return false;
      return ent.type === ENTITY.CABLE || ent.type === ENTITY.RACK;
    };

    return {
      up: canConnect(x, y - 1),
      down: canConnect(x, y + 1),
      left: canConnect(x - 1, y),
      right: canConnect(x + 1, y)
    };
  }

  function powerCapacityFor(unit) {
    const base = 4;
    return base + state.upgrades.powerEfficiency;
  }

  function coolingCapacityFor(unit) {
    const base = 4;
    return base + state.upgrades.coolingEfficiency;
  }

  function getCoverageAt(x, y) {
    const radius = 3;
    let power = 0;
    let cooling = 0;

    for (let yy = Math.max(0, y - radius); yy <= Math.min(ROWS - 1, y + radius); yy += 1) {
      for (let xx = Math.max(0, x - radius); xx <= Math.min(COLS - 1, x + radius); xx += 1) {
        const dist = Math.abs(xx - x) + Math.abs(yy - y);
        if (dist > radius) continue;
        const ent = state.entities[yy][xx];
        if (!ent) continue;
        if (ent.type === ENTITY.POWER) power += powerCapacityFor(ent);
        if (ent.type === ENTITY.COOLING) cooling += coolingCapacityFor(ent);
      }
    }

    return { power, cooling };
  }

  function rackStats(rack) {
    const level = rack.level || 1;
    const genInterval = Math.max(0.7, 2.5 - (level - 1) * 0.45);
    const packetValue = 5 + (level - 1) * 2;
    const powerNeed = 1 + (level - 1) * 0.5;
    const heatNeed = 1 + (level - 1) * 0.6;
    return { genInterval, packetValue, powerNeed, heatNeed };
  }

  function globalPacketMultiplier() {
    return 1 + state.upgrades.packetValue * 0.25;
  }

  function packetSpeedTilesPerSec() {
    return 4.3 + state.upgrades.networkSpeed * 1.4;
  }

  function spawnPacketForRack(rack, x, y) {
    const path = findPathToHub(x, y);
    if (!path || path.length < 2) {
      rack.status = "disconnected";
      return;
    }

    state.packets.push({
      rackId: rack.id,
      path,
      segment: 0,
      progress: 0,
      alive: true,
      x,
      y,
      value: Math.round(rackStats(rack).packetValue * globalPacketMultiplier()),
      fizzleTimer: 0
    });
  }

  function updateSimulation(dt) {
    state.timeSeconds += dt;
    if (state.warningsFlash > 0) state.warningsFlash = Math.max(0, state.warningsFlash - dt);

    let activeRacks = 0;
    let troubleRacks = 0;

    for (let y = 0; y < ROWS; y += 1) {
      for (let x = 0; x < COLS; x += 1) {
        const ent = state.entities[y][x];
        if (!ent || ent.type !== ENTITY.RACK) continue;

        const stats = rackStats(ent);
        const coverage = getCoverageAt(x, y);
        const path = findPathToHub(x, y);

        const powerRatio = Math.min(1, coverage.power / stats.powerNeed);
        const coolingRatio = Math.min(1, coverage.cooling / stats.heatNeed);
        const connected = !!path;

        ent.powerRatio = powerRatio;
        ent.coolingRatio = coolingRatio;
        ent.connected = connected;

        const healthy = connected && powerRatio >= 1 && coolingRatio >= 1;
        if (healthy) {
          ent.status = "active";
          activeRacks += 1;
          ent.genTimer += dt;
          const intervalBoost = 1 + state.upgrades.networkSpeed * 0.12;
          if (ent.genTimer >= stats.genInterval / intervalBoost) {
            ent.genTimer = 0;
            spawnPacketForRack(ent, x, y);
          }
        } else {
          if (!connected) ent.status = "disconnected";
          else if (powerRatio < 1 && coolingRatio < 1) ent.status = "critical";
          else if (powerRatio < 1) ent.status = "low_power";
          else ent.status = "overheat";

          const partialEff = connected ? Math.min(powerRatio, coolingRatio) : 0;
          if (partialEff > 0.35) {
            ent.genTimer += dt * partialEff * 0.35;
            if (ent.genTimer >= stats.genInterval * 2.2) {
              ent.genTimer = 0;
              spawnPacketForRack(ent, x, y);
            }
          }

          troubleRacks += 1;
        }
      }
    }

    // Failure pressure: too many troubled racks for too long.
    if (activeRacks + troubleRacks >= 3) {
      const troubleRatio = troubleRacks / (activeRacks + troubleRacks);
      if (troubleRatio >= 0.7) {
        state.collapseMeter += dt;
        state.warningsFlash = 0.25;
      } else {
        state.collapseMeter = Math.max(0, state.collapseMeter - dt * 1.5);
      }
    } else {
      state.collapseMeter = Math.max(0, state.collapseMeter - dt);
    }

    if (state.collapseMeter > 45) {
      paused = true;
      el.failureOverlay.classList.add("show");
      saveGame(true);
    }

    updatePackets(dt);
  }

  function updatePackets(dt) {
    const speed = packetSpeedTilesPerSec();

    for (const packet of state.packets) {
      if (!packet.alive) continue;

      const path = packet.path;
      const nextIndex = packet.segment + 1;
      if (nextIndex >= path.length) {
        packet.alive = false;
        continue;
      }

      const from = path[packet.segment];
      const to = path[nextIndex];

      if (!isWalkableCableNode(to.x, to.y)) {
        packet.alive = false;
        packet.fizzleTimer = 0.2;
        continue;
      }

      packet.progress += dt * speed;
      while (packet.progress >= 1 && packet.alive) {
        packet.progress -= 1;
        packet.segment += 1;

        if (packet.segment >= path.length - 1) {
          packet.alive = false;
          onPacketDelivered(packet);
          break;
        }
      }

      if (packet.alive) {
        const p0 = path[packet.segment];
        const p1 = path[packet.segment + 1];
        packet.x = p0.x + (p1.x - p0.x) * packet.progress;
        packet.y = p0.y + (p1.y - p0.y) * packet.progress;
      }
    }

    state.packets = state.packets.filter((p) => p.alive || p.fizzleTimer > 0);
    for (const packet of state.packets) {
      if (!packet.alive && packet.fizzleTimer > 0) {
        packet.fizzleTimer -= dt;
      }
    }
  }

  function onPacketDelivered(packet) {
    state.money += packet.value;
    state.totalPackets += 1;
    state.totalRevenue += packet.value;
    state.incomeEvents.push({ t: state.timeSeconds, v: packet.value });

    for (let y = 0; y < ROWS; y += 1) {
      for (let x = 0; x < COLS; x += 1) {
        const ent = state.entities[y][x];
        if (!ent || ent.type !== ENTITY.RACK) continue;
        if (ent.id === packet.rackId) {
          ent.totalPackets = (ent.totalPackets || 0) + 1;
          ent.totalProfit = (ent.totalProfit || 0) + packet.value;
          return;
        }
      }
    }
  }

  function pruneIncomeHistory() {
    const cutoff = state.timeSeconds - 60;
    state.incomeEvents = state.incomeEvents.filter((e) => e.t >= cutoff);
  }

  function incomePerMinute() {
    pruneIncomeHistory();
    return Math.round(state.incomeEvents.reduce((sum, e) => sum + e.v, 0));
  }

  function formatMoney(v) {
    return `$${Math.floor(v).toLocaleString()}`;
  }

  function formatClock(sec) {
    const s = Math.floor(sec % 60);
    const m = Math.floor(sec / 60);
    return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }

  function pushActivity(text, tone = "") {
    state.activity.unshift({ text, tone, t: state.timeSeconds });
    if (state.activity.length > 10) state.activity.length = 10;
  }

  function showToast(text, tone = "") {
    const toast = document.createElement("div");
    toast.className = `toast ${tone}`.trim();
    toast.textContent = text;
    el.toastLayer.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = "0";
      toast.style.transform = "translateY(4px)";
      setTimeout(() => toast.remove(), 180);
    }, 1600);
  }

  function markStatChanged(statEl) {
    if (!statEl) return;
    statEl.classList.remove("changed");
    // Force reflow so repeated updates can retrigger the animation.
    void statEl.offsetWidth;
    statEl.classList.add("changed");
    setTimeout(() => statEl.classList.remove("changed"), 320);
  }

  function gatherRackCounts() {
    let total = 0;
    let trouble = 0;
    for (let y = 0; y < ROWS; y += 1) {
      for (let x = 0; x < COLS; x += 1) {
        const ent = state.entities[y][x];
        if (!ent || ent.type !== ENTITY.RACK) continue;
        total += 1;
        if (ent.status !== "active") trouble += 1;
      }
    }
    return { total, trouble };
  }

  function goalText() {
    if (state.money < 500) return `Tier 1: Reach $500 (${Math.floor(state.money)}/500)`;
    if (state.totalPackets < 200) return `Tier 2: Deliver 200 packets (${state.totalPackets}/200)`;

    let highRacks = 0;
    for (let y = 0; y < ROWS; y += 1) {
      for (let x = 0; x < COLS; x += 1) {
        const ent = state.entities[y][x];
        if (ent && ent.type === ENTITY.RACK && ent.level >= 2) highRacks += 1;
      }
    }

    if (highRacks < 4) return `Tier 3: Build 4 racks level 2+ (${highRacks}/4)`;
    return "All tiers complete. Optimize your profit engine.";
  }

  function updateHud() {
    displayMoney += (state.money - displayMoney) * 0.15;
    if (Math.abs(state.money - displayMoney) < 0.5) displayMoney = state.money;

    const racks = gatherRackCounts();
    const income = incomePerMinute();
    const nextSnapshot = {
      money: Math.floor(state.money),
      income,
      packets: state.totalPackets,
      activeRacks: Math.max(0, racks.total - racks.trouble),
      troubleRacks: racks.trouble
    };

    if (hudSnapshot) {
      if (nextSnapshot.money !== hudSnapshot.money) markStatChanged(el.moneyValue.parentElement);
      if (nextSnapshot.income !== hudSnapshot.income) markStatChanged(el.incomeValue.parentElement);
      if (nextSnapshot.packets !== hudSnapshot.packets) markStatChanged(el.packetsValue.parentElement);
      if (nextSnapshot.activeRacks !== hudSnapshot.activeRacks) markStatChanged(el.activeRacksValue.parentElement);
      if (nextSnapshot.troubleRacks !== hudSnapshot.troubleRacks) markStatChanged(el.troubleRacksValue.parentElement);
    }
    hudSnapshot = nextSnapshot;

    el.moneyValue.textContent = formatMoney(displayMoney);
    el.incomeValue.textContent = formatMoney(income);
    el.packetsValue.textContent = state.totalPackets.toLocaleString();
    el.timeValue.textContent = formatClock(state.timeSeconds);
    el.activeRacksValue.textContent = String(nextSnapshot.activeRacks);
    el.troubleRacksValue.textContent = String(nextSnapshot.troubleRacks);
    el.goalChip.textContent = goalText();

    if (racks.trouble > 0 && state.warningsFlash > 0) {
      el.troubleRacksValue.parentElement.classList.add("flash");
    } else {
      el.troubleRacksValue.parentElement.classList.remove("flash");
    }

    el.upgradeSummary.innerHTML = `
      <div class="upgrade-row"><span>Network Speed</span><b>Lv ${state.upgrades.networkSpeed}</b></div>
      <div class="upgrade-row"><span>Cooling Efficiency</span><b>Lv ${state.upgrades.coolingEfficiency}</b></div>
      <div class="upgrade-row"><span>Power Efficiency</span><b>Lv ${state.upgrades.powerEfficiency}</b></div>
      <div class="upgrade-row"><span>Packet Compression</span><b>Lv ${state.upgrades.packetValue}</b></div>
    `;
    el.activityFeed.innerHTML = state.activity
      .map((item) => `<div class="feed-item ${item.tone || ""}">${item.text}</div>`)
      .join("") || "<div class='inspect-empty'>No activity yet.</div>";
    updateToolAffordability();
  }

  function setTool(tool) {
    currentTool = tool;
    state.tool = tool;
    for (const btn of document.querySelectorAll(".tool[data-tool]")) {
      btn.classList.toggle("active", btn.dataset.tool === tool);
    }
    el.toolDesc.textContent = TOOL_INFO[tool] || "";
  }

  function getCostForTool(tool) {
    if (tool === TOOL.CABLE) return COSTS.cable;
    if (tool === TOOL.RACK) return COSTS.rack;
    if (tool === TOOL.COOLING) return COSTS.cooling;
    if (tool === TOOL.POWER) return COSTS.power;
    return 0;
  }

  function updateToolAffordability() {
    document.querySelectorAll(".tool[data-tool]").forEach((btn) => {
      const tool = btn.dataset.tool;
      const cost = getCostForTool(tool);
      const locked = cost > 0 && state.money < cost;
      btn.classList.toggle("disabled", locked);
    });
  }

  function pointerToTile(evt) {
    const rect = el.canvas.getBoundingClientRect();
    const px = (evt.clientX - rect.left) * (el.canvas.width / rect.width);
    const py = (evt.clientY - rect.top) * (el.canvas.height / rect.height);
    const tx = Math.floor(px / TILE);
    const ty = Math.floor(py / TILE);
    if (!inBounds(tx, ty)) return null;
    return { x: tx, y: ty };
  }

  function canPlaceAt(tool, x, y) {
    const base = state.base[y][x];
    const ent = state.entities[y][x];

    if (tool === TOOL.BULLDOZE) {
      return !!ent;
    }

    if (base === BASE.WALL || base === BASE.HUB) return false;
    if (ent) return false;

    if (tool === TOOL.CABLE || tool === TOOL.RACK || tool === TOOL.POWER || tool === TOOL.COOLING) {
      return base === BASE.FLOOR;
    }

    return false;
  }

  function placeEntity(tool, x, y) {
    const cost = getCostForTool(tool);
    if (state.money < cost) return;

    if (tool === TOOL.CABLE) {
      state.entities[y][x] = { type: ENTITY.CABLE, variantId: 4 };
      recalcCableVariantsAround(x, y);
    } else if (tool === TOOL.RACK) {
      state.entities[y][x] = {
        type: ENTITY.RACK,
        id: state.rackIdCounter++,
        level: 1,
        totalInvested: COSTS.rack,
        genTimer: 0,
        totalPackets: 0,
        totalProfit: 0,
        status: "idle",
        connected: false,
        powerRatio: 0,
        coolingRatio: 0
      };
      recalcCableVariantsAround(x, y);
    } else if (tool === TOOL.POWER) {
      state.entities[y][x] = { type: ENTITY.POWER };
    } else if (tool === TOOL.COOLING) {
      state.entities[y][x] = { type: ENTITY.COOLING };
    }

    state.money -= cost;
    pushActivity(`Built ${tool} at (${x},${y}) for $${cost}`, "good");
    showToast(`Built ${tool} (-$${cost})`, "good");
    selected = { x, y };
  }

  function getSellValue(ent) {
    if (!ent) return 0;
    if (ent.type === ENTITY.CABLE) return Math.round(COSTS.cable * SELL_REFUND_RATE);
    if (ent.type === ENTITY.POWER) return Math.round(COSTS.power * SELL_REFUND_RATE);
    if (ent.type === ENTITY.COOLING) return Math.round(COSTS.cooling * SELL_REFUND_RATE);
    if (ent.type === ENTITY.RACK) {
      const invested = ent.totalInvested || COSTS.rack;
      return Math.round(invested * SELL_REFUND_RATE);
    }
    return 0;
  }

  function removeEntityAt(x, y) {
    const ent = state.entities[y][x];
    if (!ent) return 0;
    const refund = getSellValue(ent);

    state.entities[y][x] = null;
    state.money += refund;
    recalcCableVariantsAround(x, y);
    pushActivity(`Bulldozed ${ent.type} at (${x},${y}), refunded $${refund}`, "warn");
    showToast(`Refund +$${refund}`, "good");
    return refund;
  }

  function tryActionAt(tile) {
    if (!tile || !running || el.startOverlay.classList.contains("show")) return;
    const { x, y } = tile;

    if (currentTool === TOOL.INSPECT) {
      selected = { x, y };
      return;
    }

    if (currentTool === TOOL.BULLDOZE) {
      if (canPlaceAt(TOOL.BULLDOZE, x, y)) {
        removeEntityAt(x, y);
        selected = { x, y };
      }
      return;
    }

    const cost = getCostForTool(currentTool);
    if (state.money < cost) {
      if (state.timeSeconds - lastNoMoneyToastAt > 0.8) {
        showToast(`Need $${cost - Math.floor(state.money)} more`, "bad");
        lastNoMoneyToastAt = state.timeSeconds;
      }
      return;
    }
    if (!canPlaceAt(currentTool, x, y)) return;

    placeEntity(currentTool, x, y);
  }

  function rackUpgradeCost(level) {
    return Math.round(COSTS.rackUpgradeBase * (1 + (level - 1) * 0.8));
  }

  function renderInspectPanel() {
    if (!selected) {
      el.inspectContent.innerHTML = "<div class='inspect-empty'>Select a tile or building.</div>";
      return;
    }

    const { x, y } = selected;
    if (!inBounds(x, y)) {
      el.inspectContent.innerHTML = "<div class='inspect-empty'>Out of bounds.</div>";
      return;
    }

    const base = state.base[y][x];
    const ent = state.entities[y][x];

    const row = (k, v) => `<div><span>${k}</span><strong>${v}</strong></div>`;

    if (!ent) {
      const baseName = base === BASE.WALL ? "Wall" : base === BASE.HUB ? "Hub" : "Floor";
      el.inspectContent.innerHTML = `<div class='inspect-list'>${row("Tile", baseName)}${row("Coords", `${x}, ${y}`)}</div>`;
      return;
    }

    if (ent.type === ENTITY.RACK) {
      const stats = rackStats(ent);
      const statusText = {
        active: "Active",
        disconnected: "Disconnected",
        overheat: "Overheated",
        low_power: "Low Power",
        critical: "Critical",
        idle: "Idle"
      }[ent.status] || ent.status;

      const upgradeCost = ent.level < 3 ? rackUpgradeCost(ent.level) : null;

      let html = `<div class='inspect-list'>
        ${row("Type", "Server Rack")}
        ${row("Coords", `${x}, ${y}`)}
        ${row("Level", `${ent.level}/3`)}
        ${row("Status", statusText)}
        ${row("Connected", ent.connected ? "Yes" : "No")}
        ${row("Power", `${Math.round(ent.powerRatio * 100)}%`)}
        ${row("Cooling", `${Math.round(ent.coolingRatio * 100)}%`)}
        ${row("Interval", `${stats.genInterval.toFixed(2)}s`)}
        ${row("Packet Value", `$${Math.round(stats.packetValue * globalPacketMultiplier())}`)}
        ${row("Packets", ent.totalPackets || 0)}
        ${row("Profit", `$${Math.round(ent.totalProfit || 0)}`)}
        ${row("Sell Value", `$${getSellValue(ent)}`)}
      </div>`;

      html += `<div class='inspect-actions'>`;
      if (upgradeCost !== null) {
        const dis = state.money < upgradeCost ? "disabled" : "";
        html += `<button class='ui-btn' id='rackUpgradeBtn' ${dis}>Upgrade Rack ($${upgradeCost})</button>`;
      }
      html += ` <button class='ui-btn danger' id='rackSellBtn'>Sell Rack</button></div>`;
      el.inspectContent.innerHTML = html;

      const upBtn = document.getElementById("rackUpgradeBtn");
      if (upBtn) {
        upBtn.onclick = () => {
          if (ent.level >= 3) return;
          const cost = rackUpgradeCost(ent.level);
          if (state.money < cost) return;
          state.money -= cost;
          ent.level += 1;
          ent.totalInvested = (ent.totalInvested || COSTS.rack) + cost;
          pushActivity(`Rack (${x},${y}) upgraded to Lv ${ent.level} for $${cost}`, "good");
          showToast(`Rack upgraded to Lv ${ent.level}`, "good");
          renderInspectPanel();
        };
      }

      const sellBtn = document.getElementById("rackSellBtn");
      sellBtn.onclick = () => {
        removeEntityAt(x, y);
        renderInspectPanel();
      };

      return;
    }

    if (ent.type === ENTITY.CABLE) {
      const variant = ent.variantId === 4 ? "Horizontal" : ent.variantId === 5 ? "Vertical" : "Corner/Node";
      el.inspectContent.innerHTML = `<div class='inspect-list'>
        ${row("Type", "Cable")}
        ${row("Variant", `${variant} (${ent.variantId})`)}
        ${row("Coords", `${x}, ${y}`)}
        ${row("Sell Value", `$${getSellValue(ent)}`)}
      </div>
      <div class='inspect-actions'><button class='ui-btn danger' id='sellCableBtn'>Remove Cable</button></div>`;
      document.getElementById("sellCableBtn").onclick = () => {
        removeEntityAt(x, y);
        renderInspectPanel();
      };
      return;
    }

    if (ent.type === ENTITY.POWER || ent.type === ENTITY.COOLING) {
      const type = ent.type === ENTITY.POWER ? "Power Unit" : "Cooling Unit";
      const amount = ent.type === ENTITY.POWER ? powerCapacityFor(ent) : coolingCapacityFor(ent);
      el.inspectContent.innerHTML = `<div class='inspect-list'>
        ${row("Type", type)}
        ${row("Radius", "3 tiles")}
        ${row("Capacity", amount)}
        ${row("Coords", `${x}, ${y}`)}
        ${row("Sell Value", `$${getSellValue(ent)}`)}
      </div>
      <div class='inspect-actions'><button class='ui-btn danger' id='sellUtilBtn'>Sell Unit</button></div>`;
      document.getElementById("sellUtilBtn").onclick = () => {
        removeEntityAt(x, y);
        renderInspectPanel();
      };
    }
  }

  function globalUpgradeCost(key) {
    const lvl = state.upgrades[key];
    return Math.round(GLOBAL_UPGRADE_BASE[key] * (1 + lvl * 0.75));
  }

  function prettyUpgradeName(key) {
    if (key === "networkSpeed") return "Network Speed";
    if (key === "coolingEfficiency") return "Cooling Efficiency";
    if (key === "powerEfficiency") return "Power Efficiency";
    return "Packet Compression";
  }

  function globalUpgradeEffectText(key, lvl) {
    if (key === "networkSpeed") {
      return `Packet speed +${(lvl * 1.4).toFixed(1)} tiles/s, rack cycle boost +${Math.round(lvl * 12)}%`;
    }
    if (key === "coolingEfficiency") {
      return `Each cooling unit capacity +${lvl}`;
    }
    if (key === "powerEfficiency") {
      return `Each power unit capacity +${lvl}`;
    }
    return `Packet value multiplier x${(1 + lvl * 0.25).toFixed(2)}`;
  }

  function openUpgradeOverlay() {
    if (!running || !state) return;
    const keys = ["networkSpeed", "coolingEfficiency", "powerEfficiency", "packetValue"];
    for (const key of keys) {
      const cost = globalUpgradeCost(key);
      const lvl = state.upgrades[key];
      const costEl = document.getElementById(`cost-${key}`);
      const effectEl = document.getElementById(`effect-${key}`);
      costEl.textContent = `Lv ${lvl} -> ${lvl + 1} | $${cost}`;
      effectEl.textContent = globalUpgradeEffectText(key, lvl + 1);
      const btn = document.querySelector(`.upgrade-btn[data-upgrade='${key}']`);
      btn.disabled = state.money < cost;
    }
    el.upgradeOverlay.classList.add("show");
  }

  function drawFloor(x, y) {
    const px = x * TILE;
    const py = y * TILE;
    ctx.fillStyle = "#151b2e";
    ctx.fillRect(px, py, TILE, TILE);
    ctx.fillStyle = "#1b2340";
    ctx.fillRect(px + 2, py + 2, TILE - 4, TILE - 4);
    ctx.fillStyle = "#0f1424";
    ctx.fillRect(px, py + TILE - 1, TILE, 1);
    ctx.fillRect(px + TILE - 1, py, 1, TILE);
  }

  function drawWall(x, y) {
    const px = x * TILE;
    const py = y * TILE;
    ctx.fillStyle = "#2a2f3a";
    ctx.fillRect(px, py, TILE, TILE);
    ctx.fillStyle = "#3b4252";
    ctx.fillRect(px, py, TILE, 4);
    ctx.fillStyle = "#1e222b";
    ctx.fillRect(px, py + 28, TILE, 4);
    ctx.fillStyle = "#4c566a";
    ctx.fillRect(px + 4, py + 8, 24, 2);
    ctx.fillRect(px + 4, py + 14, 24, 2);
    ctx.fillRect(px + 4, py + 20, 24, 2);
  }

  function drawHub(x, y, t) {
    drawFloor(x, y);
    const px = x * TILE;
    const py = y * TILE;
    const pulse = 0.6 + Math.sin(t * 3.1) * 0.2;

    ctx.fillStyle = "#24304f";
    ctx.fillRect(px + 6, py + 6, 20, 20);
    ctx.fillStyle = "#4da3ff";
    ctx.fillRect(px + 10, py + 10, 12, 12);

    ctx.fillStyle = "#7cc4ff";
    ctx.fillRect(px + 14, py + 4, 4, 4);
    ctx.fillRect(px + 14, py + 24, 4, 4);
    ctx.fillRect(px + 4, py + 14, 4, 4);
    ctx.fillRect(px + 24, py + 14, 4, 4);

    ctx.strokeStyle = `rgba(124,196,255,${pulse})`;
    ctx.lineWidth = 2;
    ctx.strokeRect(px + 9, py + 9, 14, 14);
  }

  function drawCable(x, y) {
    drawFloor(x, y);
    const px = x * TILE;
    const py = y * TILE;
    const c = cableConnections(x, y);

    ctx.fillStyle = "#f0b84b";
    ctx.fillRect(px + 14, py + 14, 4, 4);

    if (c.left) ctx.fillRect(px + 2, py + 14, 14, 4);
    if (c.right) ctx.fillRect(px + 16, py + 14, 14, 4);
    if (c.up) ctx.fillRect(px + 14, py + 2, 4, 14);
    if (c.down) ctx.fillRect(px + 14, py + 16, 4, 14);

    ctx.fillStyle = "#ffd24d";
    ctx.fillRect(px + 15, py + 15, 2, 2);
    if (c.left) ctx.fillRect(px + 2, py + 15, 13, 2);
    if (c.right) ctx.fillRect(px + 17, py + 15, 13, 2);
    if (c.up) ctx.fillRect(px + 15, py + 2, 2, 13);
    if (c.down) ctx.fillRect(px + 15, py + 17, 2, 13);
  }

  function drawRack(x, y, ent) {
    drawFloor(x, y);
    const px = x * TILE;
    const py = y * TILE;

    ctx.fillStyle = "#0f1117";
    ctx.fillRect(px + 8, py + 4, 16, 24);

    ctx.fillStyle = "#1f2430";
    for (let i = 0; i < 4; i += 1) {
      ctx.fillRect(px + 10, py + 7 + i * 4, 12, 2);
    }

    ctx.fillStyle = "#41d17d";
    ctx.fillRect(px + 10, py + 23, 3, 2);
    ctx.fillStyle = "#4da3ff";
    ctx.fillRect(px + 15, py + 23, 3, 2);
    ctx.fillStyle = "#ffd24d";
    ctx.fillRect(px + 20, py + 23, 2, 2);

    if (ent.level > 1) {
      ctx.strokeStyle = "#7df3a4";
      ctx.lineWidth = 1.5;
      ctx.strokeRect(px + 7, py + 3, 18, 26);
    }

    if (ent.status !== "active") {
      let color = "rgba(70,120,180,0.30)";
      if (ent.status === "overheat") color = "rgba(255,110,70,0.45)";
      if (ent.status === "low_power") color = "rgba(255,205,90,0.35)";
      if (ent.status === "critical") color = "rgba(255,80,80,0.45)";
      if (ent.status === "disconnected") color = "rgba(90,130,170,0.35)";
      ctx.fillStyle = color;
      ctx.fillRect(px + 2, py + 2, 28, 28);
    }
  }

  function drawPower(x, y) {
    drawFloor(x, y);
    const px = x * TILE;
    const py = y * TILE;

    ctx.fillStyle = "#3a2d1f";
    ctx.fillRect(px + 7, py + 6, 18, 20);

    ctx.fillStyle = "#ffd24d";
    ctx.beginPath();
    ctx.moveTo(px + 17, py + 8);
    ctx.lineTo(px + 11, py + 17);
    ctx.lineTo(px + 15, py + 17);
    ctx.lineTo(px + 13, py + 24);
    ctx.lineTo(px + 21, py + 14);
    ctx.lineTo(px + 17, py + 14);
    ctx.closePath();
    ctx.fill();
  }

  function drawCooling(x, y) {
    drawFloor(x, y);
    const px = x * TILE;
    const py = y * TILE;

    ctx.fillStyle = "#22313f";
    ctx.fillRect(px + 6, py + 6, 20, 20);

    ctx.fillStyle = "#9ad9ff";
    ctx.beginPath();
    ctx.arc(px + 16, py + 16, 6, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = "#22313f";
    ctx.fillRect(px + 15, py + 9, 2, 14);
    ctx.fillRect(px + 9, py + 15, 14, 2);
  }

  function drawCoveragePreview(tile) {
    if (!tile) return;
    if (!(currentTool === TOOL.POWER || currentTool === TOOL.COOLING)) return;

    const { x, y } = tile;
    const valid = canPlaceAt(currentTool, x, y);

    ctx.save();
    ctx.globalAlpha = 0.22;
    ctx.fillStyle = currentTool === TOOL.POWER ? (valid ? "#ffb965" : "#ff5e5e") : (valid ? "#8ddfff" : "#ff5e5e");

    for (let yy = y - 3; yy <= y + 3; yy += 1) {
      for (let xx = x - 3; xx <= x + 3; xx += 1) {
        if (!inBounds(xx, yy)) continue;
        if (Math.abs(xx - x) + Math.abs(yy - y) > 3) continue;
        ctx.fillRect(xx * TILE, yy * TILE, TILE, TILE);
      }
    }

    ctx.restore();
  }

  function drawHover() {
    if (!hover) return;

    const valid = canPlaceAt(currentTool, hover.x, hover.y);
    const px = hover.x * TILE;
    const py = hover.y * TILE;

    if (currentTool !== TOOL.INSPECT) {
      ctx.strokeStyle = valid ? "#41d17d" : "#ff5e5e";
      ctx.lineWidth = 2;
      ctx.strokeRect(px + 1.5, py + 1.5, TILE - 3, TILE - 3);
    }
  }

  function drawSelection() {
    if (!selected || !inBounds(selected.x, selected.y)) return;
    const px = selected.x * TILE;
    const py = selected.y * TILE;

    ctx.strokeStyle = "#7cc4ff";
    ctx.lineWidth = 2;
    ctx.strokeRect(px + 2, py + 2, TILE - 4, TILE - 4);
  }

  function drawPackets() {
    for (const packet of state.packets) {
      const cx = packet.x * TILE + TILE / 2;
      const cy = packet.y * TILE + TILE / 2;

      if (packet.alive) {
        const glow = 6 + Math.sin(performance.now() * 0.01) * 1.2;
        const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, glow);
        grad.addColorStop(0, "rgba(220,244,255,1)");
        grad.addColorStop(0.6, "rgba(124,196,255,0.75)");
        grad.addColorStop(1, "rgba(124,196,255,0)");
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(cx, cy, glow, 0, Math.PI * 2);
        ctx.fill();
      } else if (packet.fizzleTimer > 0) {
        const a = Math.max(0, packet.fizzleTimer / 0.2);
        ctx.fillStyle = `rgba(255,120,120,${a})`;
        ctx.beginPath();
        ctx.arc(cx, cy, 4 * a, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  function drawMap() {
    ctx.clearRect(0, 0, el.canvas.width, el.canvas.height);

    const t = state.timeSeconds;

    for (let y = 0; y < ROWS; y += 1) {
      for (let x = 0; x < COLS; x += 1) {
        const b = state.base[y][x];
        if (b === BASE.WALL) drawWall(x, y);
        else if (b === BASE.HUB) drawHub(x, y, t);
        else drawFloor(x, y);
      }
    }

    for (let y = 0; y < ROWS; y += 1) {
      for (let x = 0; x < COLS; x += 1) {
        const ent = state.entities[y][x];
        if (!ent) continue;
        if (ent.type === ENTITY.CABLE) drawCable(x, y);
        if (ent.type === ENTITY.RACK) drawRack(x, y, ent);
        if (ent.type === ENTITY.POWER) drawPower(x, y);
        if (ent.type === ENTITY.COOLING) drawCooling(x, y);
      }
    }

    drawCoveragePreview(hover);
    drawSelection();
    drawHover();
    drawPackets();

    if (paused && running && !el.failureOverlay.classList.contains("show")) {
      ctx.fillStyle = "rgba(10, 14, 24, 0.55)";
      ctx.fillRect(0, 0, el.canvas.width, el.canvas.height);
      ctx.fillStyle = "#d8e5ff";
      ctx.font = "bold 22px Trebuchet MS";
      ctx.fillText("PAUSED", el.canvas.width / 2 - 45, el.canvas.height / 2);
    }
  }

  function render() {
    if (!state) return;
    updateHud();
    renderInspectPanel();
    drawMap();
  }

  function gameLoop(now) {
    const dt = Math.min(0.05, (now - lastFrame) / 1000);
    lastFrame = now;

    if (running && !paused && !el.failureOverlay.classList.contains("show")) {
      simAccumulator += dt;
      while (simAccumulator >= 0.1) {
        updateSimulation(0.1);
        simAccumulator -= 0.1;
      }
    }

    render();
    requestAnimationFrame(gameLoop);
  }

  function bindEvents() {
    el.canvas.addEventListener("pointermove", (evt) => {
      hover = pointerToTile(evt);
    });

    el.canvas.addEventListener("pointerleave", () => {
      hover = null;
    });

    el.canvas.addEventListener("pointerdown", (evt) => {
      const tile = pointerToTile(evt);
      tryActionAt(tile);
    });

    el.toolbar.addEventListener("click", (evt) => {
      const btn = evt.target.closest("button");
      if (!btn) return;
      const tool = btn.dataset.tool;
      if (tool) setTool(tool);
    });

    el.upgradesBtn.addEventListener("click", openUpgradeOverlay);

    document.querySelectorAll(".upgrade-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const key = btn.dataset.upgrade;
        const cost = globalUpgradeCost(key);
        if (state.money < cost) return;
        state.money -= cost;
        state.upgrades[key] += 1;
        const name = prettyUpgradeName(key);
        pushActivity(`${name} upgraded to Lv ${state.upgrades[key]} for $${cost}`, "good");
        showToast(`${name} upgraded`, "good");
        openUpgradeOverlay();
      });
    });

    el.closeUpgradesBtn.addEventListener("click", () => {
      el.upgradeOverlay.classList.remove("show");
    });

    el.pauseBtn.addEventListener("click", () => {
      if (!running) return;
      paused = !paused;
      el.pauseBtn.textContent = paused ? "Resume" : "Pause";
    });

    el.saveBtn.addEventListener("click", () => {
      if (!state) return;
      saveGame();
      showToast(`Saved "${state.currentKeyword}"`, "good");
    });

    el.resetBtn.addEventListener("click", () => {
      if (!state?.currentKeyword) return;
      if (!confirm(`Delete save profile "${state.currentKeyword}" and start fresh?`)) return;
      const oldKey = state.currentKeyword;
      const oldKeyId = state.currentKeyId;
      deleteProfile(oldKey);
      state = createDefaultState();
      state.currentKeyword = oldKey;
      state.currentKeyId = oldKeyId;
      running = true;
      paused = false;
      selected = null;
      setTool(TOOL.INSPECT);
      displayMoney = state.money;
      saveGame();
      pushActivity(`Profile "${oldKey}" reset.`, "warn");
      showToast(`Reset "${oldKey}"`, "warn");
    });

    el.switchProfileBtn.addEventListener("click", () => {
      openKeywordOverlay();
    });

    el.loadKeywordBtn.addEventListener("click", () => {
      loadOrCreateByKeyword(el.keywordInput.value).catch(() => {
        showToast("Could not open profile", "bad");
      });
    });

    el.keywordInput.addEventListener("keydown", (evt) => {
      if (evt.key === "Enter") {
        evt.preventDefault();
        loadOrCreateByKeyword(el.keywordInput.value).catch(() => {
          showToast("Could not open profile", "bad");
        });
      }
    });

    el.tutorialCloseBtn.addEventListener("click", () => {
      el.tutorialOverlay.classList.remove("show");
      localStorage.setItem(TUTORIAL_KEY, "1");
    });

    el.loadAutosaveBtn.addEventListener("click", () => {
      const keyword = state?.currentKeyword;
      const keyId = state?.currentKeyId;
      const loaded = keyword ? loadProfile(keyword) : null;
      state = loaded || createDefaultState();
      state.currentKeyword = keyword || "default";
      state.currentKeyId = keyId || "";
      paused = false;
      el.pauseBtn.textContent = "Pause";
      el.failureOverlay.classList.remove("show");
      pushActivity(`Recovered profile "${state.currentKeyword}" after failure.`, "warn");
    });

    el.restartBtn.addEventListener("click", () => {
      const currentKeyword = state?.currentKeyword || normalizeKeyword(el.keywordInput.value) || "default";
      const currentKeyId = state?.currentKeyId || "";
      state = createDefaultState();
      state.currentKeyword = currentKeyword;
      state.currentKeyId = currentKeyId;
      paused = false;
      el.pauseBtn.textContent = "Pause";
      el.failureOverlay.classList.remove("show");
      saveGame();
    });

    // Close overlays by clicking dim background.
    [el.upgradeOverlay, el.tutorialOverlay].forEach((overlay) => {
      overlay.addEventListener("click", (evt) => {
        if (evt.target === overlay) overlay.classList.remove("show");
      });
    });
  }

  function periodicSave() {
    if (running && state) {
      saveGame(true);
    }
  }

  function init() {
    state = createDefaultState();
    displayMoney = state.money;
    migrateLegacySingleSaveIfPresent();
    openKeywordOverlay();

    bindEvents();
    setTool(TOOL.INSPECT);

    setInterval(periodicSave, 15000);
    requestAnimationFrame((t) => {
      lastFrame = t;
      requestAnimationFrame(gameLoop);
    });
  }

  init();
})();
