// GAC Counter Planner, browser edition. Runs inside a signed-in swgoh.gg tab (needs GAC Insight access).
// Nothing is uploaded anywhere: it reads swgoh.gg with your own login, plans in the page, and shows a report.
//   GAC.run({ me: '<your ally code>', opp: '<opponent ally code>' })        full run with a progress box and a report
//   or step by step: setup, stage1, stageDefense, stageCounters, stageFleetOptions, planOffense, stageCharOptions, planDefense
(() => {
  'use strict';
  const G = (window.GAC = { v: 1, cfg: null, st: {}, log: [] });
  const SOLID = 0.75, GL_BONUS = 20000;
  const SUPPORT = 'https://ko-fi.com/croder';  // tip jar link; the Support button stays hidden if this is empty
  const PROTECT_COST = 150000;  // spending a unit that a top meta defense needs counts like this much extra power on offense
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const tnow = () => performance.now();
  const norm = s => [...s].map(ch => (ch.trim() ? ch : ' ')).join('').split(' ').filter(Boolean).join(' ');
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const wilson = (p, n, z) => { const d = 1 + z * z / n; return (p + z * z / (2 * n) - z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / d; };
  const relicLevel = t => (t == null ? null : (t <= 1 ? -1 : t - 2));
  const say = m => { G.log.push(m); if (G.ui) G.ui(m); };
  G.calls = 0;  // requests made to swgoh.gg, shown in the report footer
  // Every request goes through here: spaced out (about 7 a second at most) and, if swgoh.gg says "too many requests"
  // (HTTP 429) or is briefly unavailable, it waits as long as the site asks and tries again instead of giving up.
  const gate = { next: 0 };
  const polite = async u => {
    for (let attempt = 0; attempt < 6; attempt++) {
      const slot = Math.max(Date.now(), gate.next); gate.next = slot + 150;
      if (slot > Date.now()) await sleep(slot - Date.now());
      G.calls++;
      const r = await fetch(u, { credentials: 'same-origin' });
      if (r.status !== 429 && r.status !== 503) return r;
      const asked = parseInt(r.headers.get('retry-after') || '', 10);
      const ms = Math.min(asked > 0 ? asked * 1000 : 5000 * Math.pow(2, attempt), 90000);
      say('swgoh.gg asked us to slow down, waiting ' + Math.round(ms / 1000) + ' seconds');
      gate.next = Date.now() + ms;
      await sleep(ms);
    }
    throw new Error('swgoh.gg is limiting requests right now. Wait a few minutes and try again.');
  };
  const rawJson = async u => { const r = await polite(u); if (!r.ok) throw new Error(u + ' returned ' + r.status); return r.json(); };
  const dataOf = async u => { const j = await rawJson(u); return j.data || j; };
  const page = async u => new DOMParser().parseFromString(await (await polite(u)).text(), 'text/html');
  const disjoint = (set, arr) => { for (const x of arr) if (set.has(x)) return false; return true; };
  const pct = (x, d = 1) => (x * 100).toFixed(d) + '%';

  G.setup = cfg => {
    G.cfg = Object.assign({ minRelic: 5, minStars: 1, z: 1.28, league: 'KYBER', squadSize: 3, minLive: 500, dChars: 15, dFleets: 3,
      earmark: [], top: 8, seconds: 8, minDefBattles: 50, minPct: 0.6, minBattles: 5, metaLeads: 40, protectTop: 20 }, cfg);
    G.st = {}; G.log = [];
    return G.cfg;
  };

  // ---------------------------------------------------------------- stage 1: units, datacron sets, your roster
  G.stage1 = async () => {
    const c = G.cfg, st = G.st;
    say('Reading units, datacron sets and your roster');
    const [units, sets, me] = await Promise.all([dataOf('/api/units/'), dataOf('/api/datacron-sets/'), rawJson('/api/player/' + c.me + '/')]);
    st.meta = {}; st.names = {};
    for (const u of units) { st.meta[u.base_id] = { id: u.base_id, name: u.name, align: u.alignment, cats: u.categories || [], type: u.combat_type, gl: u.is_galactic_legend }; st.names[u.base_id] = u.name; }
    st.live = new Set(sets.filter(s => s.expiration_time && Date.parse(String(s.expiration_time).replace(' ', 'T')) > Date.now()).map(s => s.id));
    const pu = (me.units || (me.data && me.data.units) || []).map(u => u.data || u);  // each unit arrives wrapped as { data: {...} }
    st.owned = {};
    for (const u of pu) if ((u.rarity || 0) >= c.minStars) st.owned[u.base_id] = u;
    st.crons = (me.datacrons || (me.data && me.data.datacrons) || []).filter(d => st.live.has(d.set_id));
    st.isShip = b => ((st.meta[b] || {}).type === 2) || (b in st.owned && st.owned[b].combat_type === 2);
    st.isFleet = b => st.isShip(b) && b.startsWith('CAPITAL');
    st.can = b => b in st.owned && (st.isShip(b) || (relicLevel(st.owned[b].relic_tier) ?? -1) >= c.minRelic);
    st.canOff = b => st.can(b) && !c.earmark.includes(b);
    st.value = b => ((st.owned[b] && st.owned[b].power) || 0) + ((st.meta[b] || {}).gl ? GL_BONUS : 0);
    st.nm = b => st.names[b] || b;
    return { units: Object.keys(st.owned).length, crons: st.crons.length, liveSets: [...st.live] };
  };

  // ---------------------------------------------------------------- stage: the opponent's most recent week of the right size
  G.parseRound = async (base, ev, rd) => {
    const doc = await page(base + ev + '/' + rd + '/');
    const owner = doc.title.split("'s GAC")[0];
    const head = [...doc.querySelectorAll('main *')].find(e => !e.children.length && norm(e.textContent).endsWith("'s attacks / " + owner + "'s defenses"));
    if (!head) return { event: ev, round: rd, battles: [], missing: true };
    const battles = [];
    for (const card of head.parentElement.querySelectorAll('.gac-counters-battle-summary')) {
      const t = norm(card.textContent), side = card.querySelector('.gac-counters-battle-summary__side--defense');
      if (!side) continue;
      let dc = null;
      const d = side.querySelector('[data-player-datacron-tooltip-app]');
      if (d) { try { const j = JSON.parse(d.getAttribute('data-player-datacron-tooltip-app')); dc = { set: j.set_id, tier: j.derived && j.derived.tier }; } catch (e) { /* ignore */ } }
      for (const L of side.querySelectorAll('[class~="gac-battle-portrait-layout"]')) {
        const lead = L.querySelector('[class*="gac-battle-portrait-layout__lead"] [data-unit-def-tooltip-app]');
        const ids = [...L.querySelectorAll('[data-unit-def-tooltip-app]')].map(u => u.getAttribute('data-unit-def-tooltip-app'));
        const leadId = lead ? lead.getAttribute('data-unit-def-tooltip-app') : ids[0];
        battles.push({ lead: leadId, units: [leadId, ...ids.filter(x => x !== leadId)], dc, outcome: (t.match(/Outcome ([A-Za-z]+)/) || [])[1] });
      }
    }
    return { event: ev, round: rd, owner, battles };
  };

  G.stageDefense = async () => {
    const c = G.cfg, st = G.st, base = '/p/' + c.opp + '/gac-history/';
    say('Reading the opponent\'s GAC history');
    const idx = await page(base);
    st.owner = idx.title.split("'s GAC")[0];
    const evs = [], seen = new Set();
    for (const a of idx.querySelectorAll('a[href]')) {
      const m = a.getAttribute('href').match(/gac-history[/](O[0-9]+)[/]([0-9])[/]/);
      if (m && !seen.has(m[1])) { seen.add(m[1]); evs.push(m[1]); }
    }
    evs.sort((a, b) => +b.slice(1) - +a.slice(1));
    const charSquad = b => !st.isFleet(b.lead);
    for (const ev of evs.slice(0, 10)) {
      const probe = await G.parseRound(base, ev, 2);
      if (!probe.battles.some(b => charSquad(b) && b.units.length === c.squadSize)) continue;  // wrong squad size (3v3 vs 5v5) or empty
      say('Using the ' + new Date(+ev.slice(1)).toISOString().slice(0, 10) + ' week (' + c.squadSize + 'v' + c.squadSize + ')');
      const rounds = [];
      for (const rd of [1, 2, 3]) rounds.push(rd === 2 ? probe : await G.parseRound(base, ev, rd));
      st.event = ev;
      const board = new Map();
      for (const r of rounds) for (const b of r.battles) {
        let key;
        if (st.isFleet(b.lead)) key = [b.lead, ...b.units.slice(1).sort()];
        else if (b.units.length === c.squadSize) key = [b.lead, ...b.units.slice(1).sort()];
        else continue;
        const k = key.join('|');
        const e = board.get(k) || { squad: key, rounds: new Set(), sets: {} };
        e.rounds.add(r.round);
        if (b.dc) e.sets[b.dc.set] = (e.sets[b.dc.set] || 0) + 1;
        board.set(k, e);
      }
      st.board = [...board.values()].map(e => ({ squad: e.squad, seen: e.rounds.size, sets: Object.keys(e.sets).map(Number).sort((a, b) => a - b) }));
      return { owner: st.owner, event: ev, squads: st.board.length };
    }
    throw new Error('No recent ' + c.squadSize + 'v' + c.squadSize + ' week with data found for that opponent');
  };

  // ---------------------------------------------------------------- stage: counters from Insight
  const insightUrl = (lead, fleet, c) => '/api/v1/gac/battle/battles/?g=1&show_cleanups=false&exclude_expired_datacrons=true&league=' + c.league
    + (fleet ? '&combat_type=2' : '&squad_size=' + c.squadSize) + '&d_lead=' + lead;

  G.stageCounters = async () => {
    const c = G.cfg, st = G.st;
    st.counters = {};
    const leads = [...new Set(st.board.map(b => b.squad[0]))];
    say('Finding counters for ' + leads.length + ' defending leads');
    for (const lead of leads) {
      const d = await dataOf(insightUrl(lead, st.isFleet(lead), c));
      st.counters[lead] = { total: d.totalCount, rows: d.battles.filter(b => b.count >= c.minBattles && b.percentage >= c.minPct)
        .map(b => [b.attackLeadId, b.attackMemberIds, b.defenseMemberIds, b.count, b.percentage, b.attackReinforcementIds || [], b.defenseReinforcementIds || []]) };
      await sleep(80);
    }
    return Object.fromEntries(leads.map(l => [l, st.counters[l].rows.length]));
  };

  // ---------------------------------------------------------------- stage: how well each of your capital ships holds on defense
  const summarize = async (lead, fleet, c) => {
    const d = await dataOf(insightUrl(lead, fleet, c));
    const groups = new Map();
    for (const b of d.battles) {
      const m = [...b.defenseMemberIds].sort(), r = [...(b.defenseReinforcementIds || [])].sort();
      const k = m.join(',') + '|' + r.join(',');
      const g = groups.get(k) || { m, r, n: 0, w: 0 };
      g.n += b.count; g.w += b.count * b.percentage;
      groups.set(k, g);
    }
    return [...groups.values()].filter(g => g.n >= 30).map(g => ({ units: fleet ? [lead, ...g.m, ...g.r] : [lead, ...g.m], n: g.n, atkWin: g.w / g.n }));
  };

  G.stageFleetOptions = async () => {
    const c = G.cfg, st = G.st;
    st.fleetOpts = [];
    const ships = Object.keys(st.owned).filter(b => st.isFleet(b));
    say('Checking how your ' + ships.length + ' capital ships hold on defense');
    for (const s of ships) { st.fleetOpts.push(...(await summarize(s, true, c))); await sleep(80); }
    return st.fleetOpts.length;
  };

  // ---------------------------------------------------------------- swgoh.gg's own ranking of defense squads for the last season of this size
  // One page (top 100 squads: how often each was placed and how often it held). It tells us which squads are worth checking
  // against Kyber results, so we look up a few dozen leads instead of 150.
  G.stageMeta = async () => {
    const c = G.cfg, st = G.st;
    st.metaSquads = [];
    try {
      const d = await dataOf('/api/v1/gac/config-data/');
      const sid = ((d.latestBattleSeasonIdsBySquadSize || []).find(x => +x.squadSize === c.squadSize) || {}).seasonId;
      say('Reading the season\'s best-holding defense squads');
      const doc = await page('/gac/squads/?sort=percent&cutoff=0.1' + (sid ? '&season_id=' + sid : ''));
      const num = (n, k) => parseFloat(String(n).replace(/,/g, '')) * (k === 'K' ? 1e3 : k === 'M' ? 1e6 : 1);
      for (const tr of doc.querySelectorAll('main tr')) {
        const units = [...tr.querySelectorAll('[data-unit-def-tooltip-app]')].map(u => u.getAttribute('data-unit-def-tooltip-app'));
        const m = norm(tr.textContent).match(/([0-9.,]+)([KM]?) ([0-9.]+)% ([0-9.]+)/);
        if (units.length === c.squadSize && m) st.metaSquads.push({ units, seen: num(m[1], m[2]), hold: parseFloat(m[3]) / 100, banners: parseFloat(m[4]) });
      }
    } catch (e) { st.metaSquads = []; }  // never fatal: the planner falls back to your strongest units
    return st.metaSquads.length;
  };

  // ---------------------------------------------------------------- shared helpers: defense picking, datacrons
  const pickDefense = (options, k, blocked, can, z, minN, must) => {
    const cands = [];
    for (const o of options) if (o.n >= minN && disjoint(blocked, o.units) && o.units.every(can))
      cands.push({ units: o.units, n: o.n, hold: 1 - o.atkWin, lb: wilson(1 - o.atkWin, o.n, z) });
    cands.sort((a, b) => b.lb - a.lb);
    const pools = must.map(lead => cands.filter(c => c.units[0] === lead).slice(0, 15));
    const top = { n: -1, s: -1, pick: [] };
    const rec = (i, used, picked, s) => {
      if (i === pools.length) { if (picked.length > top.n || (picked.length === top.n && s > top.s)) { top.n = picked.length; top.s = s; top.pick = picked.slice(); } return; }
      for (const c of pools[i]) if (disjoint(used, c.units)) { const u2 = new Set(used); c.units.forEach(x => u2.add(x)); rec(i + 1, u2, picked.concat([c]), s + c.lb); }
      rec(i + 1, used, picked, s);
    };
    rec(0, new Set(), [], 0);
    const chosen = top.pick.slice(0, k), taken = new Set();
    chosen.forEach(c => c.units.forEach(x => taken.add(x)));
    const fixed = chosen.length;
    for (const c of cands) if (chosen.length < k && disjoint(taken, c.units)) { chosen.push(c); c.units.forEach(x => taken.add(x)); }
    for (let pass = 0; pass < 6; pass++) {
      let improved = false;
      for (let i = fixed; i < chosen.length; i++) {
        const others = new Set();
        chosen.forEach((c, j) => { if (j !== i) c.units.forEach(x => others.add(x)); });
        for (const c of cands) {
          if (c.lb <= chosen[i].lb) break;
          if (disjoint(others, c.units) && !chosen.includes(c)) { chosen[i] = c; improved = true; break; }
        }
      }
      if (!improved) break;
    }
    return { chosen, options: cands.length };
  };

  const hungarian = cost => {
    const n = cost.length, m = cost[0].length, INF = 1e18;
    const u = new Array(n + 1).fill(0), v = new Array(m + 1).fill(0), p = new Array(m + 1).fill(0), way = new Array(m + 1).fill(0);
    for (let i = 1; i <= n; i++) {
      p[0] = i; let j0 = 0;
      const minv = new Array(m + 1).fill(INF), used = new Array(m + 1).fill(false);
      do {
        used[j0] = true;
        const i0 = p[j0]; let delta = INF, j1 = 0;
        for (let j = 1; j <= m; j++) if (!used[j]) {
          const cur = cost[i0 - 1][j - 1] - u[i0] - v[j];
          if (cur < minv[j]) { minv[j] = cur; way[j] = j0; }
          if (minv[j] < delta) { delta = minv[j]; j1 = j; }
        }
        for (let j = 0; j <= m; j++) { if (used[j]) { u[p[j]] += delta; v[j] -= delta; } else minv[j] -= delta; }
        j0 = j1;
      } while (p[j0] !== 0);
      do { const j1 = way[j0]; p[j0] = p[j1]; j0 = j1; } while (j0);
    }
    const ans = new Array(n).fill(0);
    for (let j = 1; j <= m; j++) if (p[j]) ans[p[j] - 1] = j - 1;
    return ans;
  };

  const fit = (units, cron, st) => {
    let score = 0; const why = [];
    cron.tiers.forEach((t, i) => {
      if (!t.ability_id || i + 1 > cron.tier) return;
      const ty = t.scope_target_type, tid = String(t.scope_target_id), tn = t.scope_target_name;
      const hit = units.filter(u => { const m = st.meta[u] || {}; return (ty === 2 && String(m.align) === tid) || (ty === 3 && (m.cats || []).includes(tn)) || (ty === 4 && u === tid); }).length;
      if (hit) { score += hit / units.length; why.push(tn + ' ' + hit + '/' + units.length); }
    });
    return [score + 0.05 * cron.tier / 9, why];
  };

  const assignCrons = (squads, pool, st) => {
    if (!squads.length || !pool.length) return squads.map(() => null);
    const table = squads.map(u => pool.map(c => fit(u, c, st)));
    const m = Math.max(pool.length, squads.length);
    const cost = squads.map((_, i) => Array.from({ length: m }, (_, j) => (j < pool.length ? -table[i][j][0] : 0)));
    return hungarian(cost).map((j, i) => (j < pool.length ? { cron: pool[j], why: table[i][j][1] } : null));
  };

  // ---------------------------------------------------------------- plan the offense (and choose fleets together with defense)
  G.planOffense = () => {
    const c = G.cfg, st = G.st;
    const board = st.board.filter(b => !((st.counters[b.squad[0]] || {}).total < c.minLive));
    st.dropped = st.board.filter(b => (st.counters[b.squad[0]] || {}).total < c.minLive).map(b => ({ squad: b.squad, battles: st.counters[b.squad[0]].total }));
    // units the season's best defenses need: spend them on offense only when nothing else gives a solid counter
    st.protect = new Set();
    if (st.metaSquads && st.metaSquads.length) {
      const top = st.metaSquads.filter(m => m.units.every(st.can)).sort((a, b) => wilson(b.hold, b.seen, c.z) - wilson(a.hold, a.seen, c.z)).slice(0, c.protectTop);
      top.forEach(m => m.units.forEach(u => st.protect.add(u)));
    }
    st.cands = new Map();
    for (const b of board) {
      const lead = b.squad[0], rows = (st.counters[lead] || {}).rows || [];
      let raw = [];
      if (st.isFleet(lead)) {
        const obs = new Set(b.squad), pooled = new Map();
        for (const r of rows) {
          const core = new Set([lead, ...r[2]]), dset = new Set([...core, ...r[6]]);
          let w;
          if ([...dset].every(x => obs.has(x))) w = dset.size / obs.size;
          else if ([...core].every(x => obs.has(x))) w = 0.5 * core.size / obs.size;
          else continue;
          const k = [r[0], [...r[1]].sort().join(','), [...r[5]].sort().join(',')].join('|');
          const e = pooled.get(k) || { att: [r[0], ...[...r[1]].sort(), ...[...r[5]].sort()], n: 0, wn: 0 };
          e.n += w * r[3]; e.wn += w * r[3] * r[4];
          pooled.set(k, e);
        }
        raw = [...pooled.values()].filter(e => e.n >= 5).map(e => ({ att: e.att, n: e.n, p: e.wn / e.n }));
      } else {
        const mem = b.squad.slice(1);
        const exact = rows.filter(r => r[2].length === mem.length && r[2].every(x => mem.includes(x)));
        const use = exact.length >= 3 ? exact : rows;
        raw = use.map(r => ({ att: [r[0], ...r[1]], n: r[3], p: r[4] }));
      }
      const out = [], seen = new Set();
      for (const o of raw) {
        const key = o.att.join('|');
        if (seen.has(key) || !o.att.every(st.canOff)) continue;
        seen.add(key);
        const lb = wilson(o.p, o.n, c.z);
        out.push({ att: o.att, n: o.n, p: o.p, lb, cost: o.att.reduce((s, u) => s + st.value(u) + (st.protect.has(u) ? PROTECT_COST : 0), 0), tier: lb >= SOLID ? 'solid' : (o.p >= SOLID ? 'promising' : 'marginal') });
      }
      out.sort((x, y) => y.lb - x.lb);
      let keep;
      if (st.isFleet(lead)) keep = out.slice(0, 20);
      else {
        const cheap = out.filter(x => x.lb >= SOLID).sort((x, y) => x.cost - y.cost).slice(0, c.top);
        keep = out.slice(0, c.top).concat(cheap.filter(x => !out.slice(0, c.top).includes(x)));
      }
      st.cands.set(b, keep);
    }
    const dopts = (st.fleetOpts || []);
    const must = c.earmark.filter(st.isFleet);
    const solve = (group, fleetJoint) => {
      const order = group.slice().sort((a, b) => (st.cands.get(a).length || 99) - (st.cands.get(b).length || 99));
      const n = order.length, t0 = tnow();
      const remSolid = [], remCov = [];
      for (let i = 0; i <= n; i++) {
        remSolid.push(order.slice(i).filter(s => st.cands.get(s).some(x => x.lb >= SOLID)).length);
        remCov.push(order.slice(i).filter(s => st.cands.get(s).length).length);
      }
      let best = { key: [-1, -1, -Infinity, -Infinity], pick: new Map() };
      const cmp = (a, b) => { for (let i = 0; i < a.length; i++) { if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1; } return 0; };
      let timedOut = false;
      const dfs = (i, used, pick, solid, cov, spend, lb) => {
        if (tnow() - t0 > c.seconds * 1000) { timedOut = true; return; }
        if (i === n) {
          let key;
          if (fleetJoint) {
            if (cmp([solid, cov], best.key.slice(0, 2)) < 0) return;
            const def = pickDefense(dopts, c.dFleets, used, st.can, c.z, c.minDefBattles, must).chosen.reduce((s, x) => s + x.lb, 0);
            key = [solid, cov, def, lb];
          } else key = [solid, cov, -spend, lb];
          if (cmp(key, best.key) > 0) best = { key, pick: new Map(pick) };
          return;
        }
        if (!fleetJoint) {
          const pot = [solid + remSolid[i], cov + remCov[i]], bk = best.key.slice(0, 2);
          const r = cmp(pot, bk);
          if (r < 0) return;
          if (r === 0 && -spend < best.key[2]) return;
        }
        const s = order[i];
        const list = fleetJoint ? st.cands.get(s) : st.cands.get(s).slice().sort((a, b) => ((a.lb < SOLID) - (b.lb < SOLID)) || (a.cost - b.cost));
        for (const cd of list) if (disjoint(used, cd.att)) {
          const u2 = new Set(used); cd.att.forEach(x => u2.add(x));
          pick.set(s, cd);
          dfs(i + 1, u2, pick, solid + (cd.lb >= SOLID ? 1 : 0), cov + 1, spend + cd.cost, lb + cd.lb);
          pick.delete(s);
        }
        dfs(i + 1, used, pick, solid, cov, spend, lb);
      };
      dfs(0, new Set(), new Map(), 0, 0, 0, 0);
      return { pick: best.pick, timedOut };
    };
    st.boardKept = board;
    const chars = board.filter(b => !st.isFleet(b.squad[0])), fleets = board.filter(b => st.isFleet(b.squad[0]));
    say('Choosing counters');
    const rc = solve(chars, false), rf = solve(fleets, !!(fleets.length && dopts.length));
    st.pick = new Map([...rc.pick, ...rf.pick]);
    st.timedOut = rc.timedOut || rf.timedOut;
    st.used = new Set();
    for (const cd of st.pick.values()) cd.att.forEach(u => st.used.add(u));
    // datacrons for the offense
    const charPicked = [...st.pick.keys()].filter(b => !st.isFleet(b.squad[0]));
    const got = assignCrons(charPicked.map(b => st.pick.get(b).att), st.crons, st);
    st.dcOff = new Map(charPicked.map((b, i) => [b, got[i]]));
    // what is free, and which leads to look up for defense
    st.free = Object.keys(st.owned).filter(b => !st.used.has(b));
    const strongest = st.free.filter(b => !st.isShip(b) && st.can(b)).sort((a, b) => st.value(b) - st.value(a)).slice(0, 150);
    if (st.metaSquads && st.metaSquads.length) {
      // the best-holding squads you could field with what is left, by how sure we are of their hold rate
      const ok = st.metaSquads.filter(m => m.units.every(u => st.can(u) && !st.used.has(u))).sort((a, b) => wilson(b.hold, b.seen, c.z) - wilson(a.hold, a.seen, c.z));
      const leads = [];
      for (const m of ok) { if (!leads.includes(m.units[0])) leads.push(m.units[0]); if (leads.length >= c.metaLeads) break; }
      for (const e of c.earmark) if (!st.isShip(e) && st.can(e) && !leads.includes(e)) leads.push(e);
      st.dLeads = leads; st.dSource = 'the season\'s meta list (' + st.metaSquads.length + ' squads)';
    } else { st.dLeads = strongest; st.dSource = 'your strongest units'; }
    return { covered: st.pick.size, of: board.length, solid: [...st.pick.values()].filter(x => x.lb >= SOLID).length, unitsSpent: st.used.size, timedOut: st.timedOut };
  };

  G.stageCharOptions = async (budgetMs = Infinity) => {
    const c = G.cfg, st = G.st, t0 = tnow();
    if (!st.charOpts) { st.charOpts = []; st.charQueue = st.dLeads.slice(); }
    say('Checking how ' + st.charQueue.length + ' more of your leads hold on defense');
    while (st.charQueue.length && tnow() - t0 < budgetMs) {
      const batch = st.charQueue.splice(0, 4);
      const res = await Promise.all(batch.map(l => summarize(l, false, c)));
      res.forEach(r => st.charOpts.push(...r));
      await sleep(60);
    }
    return { left: st.charQueue.length, options: st.charOpts.length };
  };

  G.planDefense = () => {
    const c = G.cfg, st = G.st;
    const must = c.earmark;
    const dc = pickDefense(st.charOpts || [], c.dChars, st.used, st.can, c.z, c.minDefBattles, must.filter(b => !st.isShip(b)));
    const df = pickDefense(st.fleetOpts || [], c.dFleets, st.used, st.can, c.z, c.minDefBattles, must.filter(st.isFleet));
    const offCrons = new Set([...st.dcOff.values()].filter(Boolean).map(x => x.cron.id));
    const left = st.crons.filter(x => !offCrons.has(x.id));
    st.defChars = dc.chosen; st.defFleets = df.chosen;
    st.dcDef = assignCrons(dc.chosen.map(x => x.units), left, st);
    st.freeGLs = st.free.filter(b => (st.meta[b] || {}).gl).map(st.nm).sort();
    // the season's best-holding defenses you can field with what offense left, and whether they made your plan
    const kyber = new Map((st.charOpts || []).map(o => [[...o.units].sort().join('|'), o]));
    const chosen = new Set(dc.chosen.map(x => [...x.units].sort().join('|')));
    st.metaOffer = (st.metaSquads || []).filter(m => m.units.every(u => st.can(u) && !st.used.has(u)))
      .sort((a, b) => wilson(b.hold, b.seen, c.z) - wilson(a.hold, a.seen, c.z)).slice(0, 12)
      .map(m => { const k = [...m.units].sort().join('|'), ky = kyber.get(k); return { units: m.units, hold: m.hold, seen: m.seen, kyberHold: ky ? 1 - ky.atkWin : null, kyberN: ky ? ky.n : 0, inPlan: chosen.has(k) }; });
    return { chars: dc.chosen.length, fleets: df.chosen.length };
  };

  // ---------------------------------------------------------------- report
  const CSS = ':root{--bg:#f5f6f8;--card:#fff;--ink:#14171c;--muted:#5d6672;--line:#e1e5ea;--accent:#2f6fed;--good:#157347;--goodbg:#e3f4ea;--warn:#8a5a00;--warnbg:#fdf0d5;--bad:#b02a37;--chip:#eef1f5;--old:#fbe8e8}@media (prefers-color-scheme:dark){:root{--bg:#0f1318;--card:#171c23;--ink:#e8ecf1;--muted:#98a3b0;--line:#27303a;--accent:#6aa0ff;--good:#6fd39a;--goodbg:#14301f;--warn:#f0c36a;--warnbg:#33290f;--bad:#ff8590;--chip:#212a34;--old:#3a1f23;color-scheme:dark}}'
    + '*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}main{max-width:1100px;margin:0 auto;padding:28px 16px 64px}h1{font-size:28px;margin:0 0 4px}h2{font-size:20px;margin:30px 0 10px}p.lead{color:var(--muted);margin:0 0 16px;max-width:720px}'
    + '.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px;margin:16px 0}.tile{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px}.big{font-size:30px;font-weight:700}.small{color:var(--muted);font-size:13px}'
    + '.scroll{overflow-x:auto;background:var(--card);border:1px solid var(--line);border-radius:12px}table{border-collapse:collapse;width:100%;min-width:760px}th,td{padding:10px 12px;border-bottom:1px solid var(--line);vertical-align:top;text-align:left}th{font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted)}tr:last-child td{border-bottom:0}.num{text-align:right;white-space:nowrap}'
    + '.squad{font-weight:600}.meta{color:var(--muted);font-size:12.5px;margin-top:2px}.muted{color:var(--muted);font-size:12.5px}.chip{display:inline-block;background:var(--chip);border-radius:999px;padding:0 8px;margin-left:6px;font-size:12px}.chip.old{background:var(--old)}'
    + '.badge{display:inline-block;border-radius:6px;padding:1px 8px;font-weight:600}.badge.solid{background:var(--goodbg);color:var(--good)}.badge.promising,.badge.marginal{background:var(--warnbg);color:var(--warn)}.bad{color:var(--bad);font-weight:600}.note{background:var(--card);border:1px solid var(--line);border-left:4px solid var(--accent);border-radius:8px;padding:12px 14px;margin:12px 0}ul{margin:6px 0 0;padding-left:20px}footer{color:var(--muted);font-size:13px;margin-top:36px}';

  G.report = () => {
    const c = G.cfg, st = G.st, nm = st.nm;
    const sq = us => us.map(u => esc(nm(u))).join(' + ');
    const cron = x => (!x ? '<span class="muted">none left</span>' : 'set ' + x.cron.set_id + ', tier ' + x.cron.tier + '<br><span class="muted">' + esc(x.why.length ? x.why.join(', ') : 'stats only') + '</span>');
    const offRows = fleet => st.boardKept.filter(b => st.isFleet(b.squad[0]) === fleet).sort((a, b) => (b.seen - a.seen) || nm(a.squad[0]).localeCompare(nm(b.squad[0]))).map(b => {
      const cd = st.pick.get(b);
      const sets = b.sets.map(s => '<span class="chip' + (st.live.has(s) ? '' : ' old') + '">set ' + s + (st.live.has(s) ? '' : ' expired') + '</span>').join('');
      const left = '<div class="squad">' + sq(b.squad) + '</div><div class="meta">seen in ' + b.seen + ' of 3 rounds ' + sets + '</div>';
      if (!cd) return '<tr><td>' + left + '</td><td colspan="5" class="bad">No counter you can field</td></tr>';
      const dcx = fleet ? '<span class="muted">n/a</span>' : cron(st.dcOff.get(b));
      return '<tr><td>' + left + '</td><td><div class="squad">' + sq(cd.att) + '</div></td><td class="num">' + pct(cd.p) + '</td><td class="num">' + Math.round(cd.n).toLocaleString() + '</td><td class="num"><span class="badge ' + cd.tier + '">' + pct(cd.lb) + '</span></td><td>' + dcx + '</td></tr>';
    }).join('');
    const head = '<table><thead><tr><th>Their squad</th><th>Your counter</th><th class="num">Win rate</th><th class="num">Battles</th><th class="num">Safe bound</th><th>Datacron</th></tr></thead><tbody>';
    const covered = st.pick.size, total = st.boardKept.length, solid = [...st.pick.values()].filter(x => x.lb >= SOLID).length;
    const spent = [...st.used].reduce((s, u) => s + st.value(u), 0), all = Object.keys(st.owned).reduce((s, u) => s + st.value(u), 0);
    const tile = (big, small) => '<div class="tile"><div class="big">' + big + '</div><div class="small">' + small + '</div></div>';
    const defRows = st.defChars.map((d, i) => '<tr><td><div class="squad">' + sq(d.units) + '</div></td><td class="num">' + pct(d.hold) + '</td><td class="num">' + Math.round(d.n).toLocaleString() + '</td><td class="num">' + pct(d.lb) + '</td><td>' + cron(st.dcDef[i]) + '</td></tr>').join('');
    const fleetRows = st.defFleets.map(d => '<tr><td><div class="squad">' + sq(d.units) + '</div></td><td class="num">' + pct(d.hold) + '</td><td class="num">' + Math.round(d.n).toLocaleString() + '</td><td class="num">' + pct(d.lb) + '</td></tr>').join('');
    const dropped = st.dropped.length ? '<h2>Dropped from the plan</h2><p class="muted">Rare under live datacron sets, so they most likely only worked with an expired one:</p><ul>' + st.dropped.map(x => '<li>' + sq(x.squad) + ' <span class="muted">(' + x.battles + ' battles under live sets)</span></li>').join('') + '</ul>' : '';
    return '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>GAC Counter Planner</title><style>' + CSS + '</style></head><body><main>'
      + '<h1>GAC Counter Planner</h1><p class="lead">Predicted from the most recent ' + c.squadSize + 'v' + c.squadSize + ' week. Kyber battles, live datacron sets only.</p>'
      + '<div class="note">Opponent scouted: <b>' + esc(st.owner) + '</b>, ally code ' + esc(c.opp)
      + (c.auto ? (c.auto.stale ? ' (no GAC week is live, so this is the last opponent you faced: ' + esc(c.auto.season) + ', round ' + c.auto.round + ')'
        : ' (your round ' + c.auto.round + ' opponent, picked automatically from your GAC history)') : '') + '</div>'
      + '<div class="tiles">' + tile(covered + ' / ' + total, 'opponent squads covered') + tile(solid, 'counters above the 75% safe bound') + tile(pct(spent / all, 0), 'of your unit power spent on offense') + tile(st.freeGLs.length, 'Galactic Legends kept free for defense') + '</div>'
      + '<h2>Offense: character squads</h2><div class="scroll">' + head + offRows(false) + '</tbody></table></div>'
      + '<h2>Offense: fleets</h2><div class="scroll">' + head + offRows(true) + '</tbody></table></div>' + dropped
      + '<h2>Your defense, from what is left</h2><div class="note">Galactic Legends still free: <b>' + esc(st.freeGLs.join(', ') || 'none') + '</b>. "Hold" is how often attackers lose to that squad in Kyber.</div>'
      + '<div class="scroll"><table><thead><tr><th>Squad</th><th class="num">Hold</th><th class="num">Battles</th><th class="num">Safe bound</th><th>Datacron</th></tr></thead><tbody>' + defRows + '</tbody></table></div>'
      + (st.metaOffer && st.metaOffer.length ? '<h2>Meta defenses you can field</h2><p class="muted">The season\'s best-holding squads (all leagues) that you can build from what offense left. Offense avoids their units where it can.</p><div class="scroll"><table><thead><tr><th>Squad</th><th class="num">Season hold</th><th class="num">Placed</th><th class="num">Kyber hold</th><th>In your plan</th></tr></thead><tbody>'
        + st.metaOffer.map(m => '<tr><td><div class="squad">' + sq(m.units) + '</div></td><td class="num">' + pct(m.hold, 0) + '</td><td class="num">' + Math.round(m.seen).toLocaleString() + '</td><td class="num">' + (m.kyberHold == null ? '<span class="muted">n/a</span>' : pct(m.kyberHold, 0)) + '</td><td>' + (m.inPlan ? 'Yes' : '<span class="muted">No</span>') + '</td></tr>').join('') + '</tbody></table></div>' : '')
      + '<h2>Defense fleets</h2><div class="scroll"><table><thead><tr><th>Fleet</th><th class="num">Hold</th><th class="num">Battles</th><th class="num">Safe bound</th></tr></thead><tbody>' + fleetRows + '</tbody></table></div>'
      + '<footer>Generated in your browser from your own swgoh.gg session. Nothing was uploaded. Defense candidates came from ' + esc(st.dSource || 'your strongest units') + '. '
      + (G.secs ? 'Took ' + G.secs + ' seconds and ' + G.calls + ' requests. ' : '') + (st.timedOut ? 'The counter search hit its time limit, so a slightly better plan may exist.' : '') + '</footer></main></body></html>';
  };

  // ---------------------------------------------------------------- full run with a progress box and a report overlay
  const overlay = html => {
    const old = document.getElementById('gac-overlay'); if (old) old.remove();
    const w = document.createElement('div'); w.id = 'gac-overlay';
    w.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:#0008;display:flex;flex-direction:column';
    const bar = document.createElement('div');
    bar.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;padding:8px;background:#111';
    const mk = (t, f) => { const b = document.createElement('button'); b.textContent = t; b.style.cssText = 'padding:6px 12px;font:14px system-ui;cursor:pointer'; b.onclick = f; return b; };
    if (SUPPORT) {  // in the overlay bar, not in the report, so a downloaded or shared report stays clean
      const a = document.createElement('a');
      a.href = SUPPORT; a.target = '_blank'; a.rel = 'noopener'; a.textContent = 'Support this project';
      a.style.cssText = 'margin-right:auto;padding:6px 14px;font:700 14px system-ui;background:#ff5e5b;color:#fff;border-radius:6px;text-decoration:none';
      bar.append(a);
    }
    if (G.cfg && G.cfg.auto) bar.append(mk('Choose another opponent', () => { w.remove(); G.ask({ manual: true }); }));
    bar.append(mk('Download page', () => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([html], { type: 'text/html' })); a.download = 'gac-plan.html'; a.click(); }), mk('Close', () => w.remove()));
    // sandboxed with no permissions: the report is plain text and styling, so it never needs scripts or access to the swgoh.gg page
    const f = document.createElement('iframe'); f.setAttribute('sandbox', ''); f.srcdoc = html; f.style.cssText = 'flex:1;border:0;background:#fff';
    w.append(bar, f); document.body.append(w);
  };
  G.show = html => overlay(html);

  // The signed-in user's own account(s), so nobody has to type their ally code.
  G.identity = async () => {
    try {
      const d = await dataOf('/api/users/identity/');
      return d.authenticated ? (d.players || []).map(p => ({ name: p.name, ally: String(p.allyCode) })) : [];
    } catch (e) { return []; }
  };
  const mem = {
    get: k => { try { return localStorage.getItem('gac.' + k) || ''; } catch (e) { return ''; } },
    set: (k, v) => { try { localStorage.setItem('gac.' + k, v); } catch (e) { /* private browsing: just do not remember */ } },
  };
  // Who you are facing: your most recent GAC week from the bracket, with the opponent of each round when it is known.
  G.currentOpponents = async me => {
    try {
      const brs = await dataOf('/api/v2/gac/brackets/recent/' + me + '/');
      const b = (Array.isArray(brs) ? brs : []).slice().sort((x, y) => Date.parse(y.startTime + 'Z') - Date.parse(x.startTime + 'Z'))[0];
      if (!b) return null;
      const byName = new Map(b.bracketPlayers.map(p => [p.playerName, p]));
      const doc = await page('/p/' + me + '/gac-history/');
      const found = new Map();
      for (const a of doc.querySelectorAll('a[href*="gac-history/' + b.eventId + '/"]')) {
        const m = a.getAttribute('href').match(/[/]([0-9])[/]$/);
        const text = norm(a.textContent);
        const name = [...byName.keys()].filter(n => text.startsWith(n)).sort((x, y) => y.length - x.length)[0];
        if (m && name) found.set(+m[1], name);
      }
      const row = (p, round) => ({ round, name: p.playerName, ally: String(p.allyCode), guild: p.guildName || '', power: p.playerPower });
      const opps = [...found.entries()].sort((x, y) => x[0] - y[0]).map(([round, name]) => row(byName.get(name), round));
      const others = b.bracketPlayers.filter(p => String(p.allyCode) !== String(me) && !p.playerIsFake && !opps.some(o => o.ally === String(p.allyCode))).map(p => row(p, 0));
      return { season: b.seasonNumber, week: b.weekNumber, startTime: b.startTime, ageDays: (Date.now() - Date.parse(b.startTime + 'Z')) / 864e5, opps, others };
    } catch (e) { return null; }
  };

  // 3v3 or 5v5, from swgoh.gg's season calendar: the size of the week that is on now, or else of the next season
  // (seasons are three weeks long and alternate between the two sizes).
  G.detectSquadSize = async () => {
    try {
      const d = await dataOf('/api/v1/gac/config-data/');
      const now = Date.now(), t = s => Date.parse(String(s).replace(' ', 'T'));
      let latest = null;
      for (const s of (d.seasons || [])) for (const e of (s.events || [])) {
        const st = t(e.startTime), en = t(e.endTime);
        if (st <= now && now < en) return { size: +s.squadSize, why: s.name + ' week ' + e.eventNumber + ' is on now' };
        if (st <= now && (!latest || st > latest.st)) latest = { st, s, e };
      }
      if (!latest) return null;
      const seasonOver = latest.e.eventNumber >= (latest.s.events || []).length;
      const size = seasonOver ? (+latest.s.squadSize === 3 ? 5 : 3) : +latest.s.squadSize;
      return { size, why: seasonOver ? latest.s.name + ' is over, so the next season is ' + size + 'v' + size : latest.s.name + ' continues' };
    } catch (e) { return null; }
  };

  // One click: when a GAC week is on, the opponent of the current round, read from your GAC history.
  // Rounds last two days (a week is six days, three rounds); if that round has no opponent listed yet, the newest listed one is used.
  G.autoOpponent = async (me, opt = {}) => {
    try {
      const now = opt.now || Date.now(), t = s => Date.parse(String(s).replace(' ', 'T'));
      const d = await dataOf('/api/v1/gac/config-data/');
      let live = null;
      for (const s of (d.seasons || [])) for (const e of (s.events || [])) if (t(e.startTime) <= now && now < t(e.endTime)) live = { s, e, start: t(e.startTime) };
      if (!live) return null;
      const brs = await dataOf('/api/v2/gac/brackets/recent/' + me + '/');
      const b = (Array.isArray(brs) ? brs : []).find(x => x.eventId === live.e.id);
      if (!b) return null;
      const byName = new Map(b.bracketPlayers.map(p => [p.playerName, p]));
      const doc = await page('/p/' + me + '/gac-history/');
      const rows = new Map();
      for (const a of doc.querySelectorAll('a[href*="gac-history/' + live.e.id + '/"]')) {
        const m = a.getAttribute('href').match(/[/]([0-9])[/]$/), text = norm(a.textContent);
        const name = [...byName.keys()].filter(n => text.startsWith(n)).sort((x, y) => y.length - x.length)[0];
        if (m && name) rows.set(+m[1], name);
      }
      if (!rows.size) return null;
      const expected = Math.min(3, Math.floor((now - live.start) / (2 * 864e5)) + 1);
      const round = rows.has(expected) ? expected : Math.max(...rows.keys());
      const p = byName.get(rows.get(round));
      return { name: p.playerName, ally: String(p.allyCode), guild: p.guildName || '', round, size: +live.s.squadSize, season: live.s.name };
    } catch (e) { return null; }
  };

  // The opponent to use without asking: this round's opponent in a live week, otherwise the last opponent you faced
  // (planned at the size of the next season, from that player's most recent week of that size).
  G.pickAuto = async (me, opts = {}) => {
    const live = await G.autoOpponent(me, opts);
    if (live) return live;
    const cur = await G.currentOpponents(me);
    const last = cur && cur.opps.length ? cur.opps[cur.opps.length - 1] : null;
    if (!last) return null;
    const det = await G.detectSquadSize();
    return { name: last.name, ally: last.ally, guild: last.guild, round: last.round, size: det ? det.size : (+mem.get('size') || 3), season: 'Season ' + cur.season, stale: true };
  };

  G.ask = async (opts = {}) => {
    const who = await G.identity();
    let me;
    if (who.length === 1) me = who[0].ally;
    else if (who.length > 1) {
      const pick = prompt('Which account?\n' + who.map((p, i) => (i + 1) + ': ' + p.name).join('\n'), '1');
      if (pick === null) return;
      me = (who[+pick - 1] || who[0]).ally;
    } else {
      me = prompt('Your ally code (could not read it from your login)', mem.get('me'));
      if (!me) return;
    }
    const clean = s => String(s).replace(/[^0-9]/g, '');
    if (!opts.manual) {  // no questions: the current opponent, or failing that the last one you faced
      const auto = await G.pickAuto(clean(me), opts);
      if (auto) { mem.set('me', clean(me)); return G.run({ me: clean(me), opp: auto.ally, squadSize: auto.size, auto }); }
    }
    const det = await G.detectSquadSize();
    let size = det ? det.size : (+mem.get('size') || 3);
    const sizeLine = 'Planning for ' + size + 'v' + size + (det ? ' (' + det.why + ')' : '') + '. To use the other size, add a space and 3 or 5 after your answer, like "1 5".';
    let opp = '';
    const cur = await G.currentOpponents(clean(me));
    const list = cur ? cur.opps.concat(cur.others) : [];
    let pick;
    if (list.length) {
      const age = cur.ageDays < 1 ? 'today' : Math.round(cur.ageDays) + ' days ago';
      const lines = list.map((o, i) => (i + 1) + ': ' + o.name + (o.guild ? ' (' + o.guild + ')' : '') + (o.round ? ', round ' + o.round : ', in your bracket'));
      pick = prompt('Your latest GAC week: season ' + cur.season + ' week ' + cur.week + ' (started ' + age + ')\nWho do you want to plan against? Type a number, or an ally code.\n' + sizeLine + '\n\n' + lines.join('\n'), '1');
    } else {
      pick = prompt('Opponent ally code\n' + sizeLine, mem.get('opp'));
    }
    if (pick === null || !String(pick).trim()) return;
    const parts = String(pick).trim().split(/\s+/);
    if (parts[1] === '3' || parts[1] === '5') size = +parts[1];
    const n = +parts[0];
    opp = list.length && n >= 1 && n <= list.length && String(n) === parts[0] ? list[n - 1].ally : clean(parts[0]);
    if (!opp) return;
    mem.set('me', clean(me)); mem.set('opp', opp); mem.set('size', String(size));
    return G.run({ me: clean(me), opp, squadSize: size });
  };

  G.run = async cfg => {
    G.setup(cfg);
    const box = document.createElement('div');
    box.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:2147483647;background:#111;color:#fff;font:13px system-ui;padding:10px 14px;border-radius:8px;max-width:320px';
    document.body.append(box);
    G.ui = m => { box.textContent = m + ' ...'; };
    try {
      G.calls = 0; G.t0 = tnow();
      await G.stage1(); await G.stageDefense(); await G.stageCounters(); await G.stageFleetOptions(); await G.stageMeta();
      G.planOffense(); await G.stageCharOptions(); G.planDefense();
      G.secs = Math.round((tnow() - G.t0) / 1000);
      G.ui = null; box.remove(); overlay(G.report());
    } catch (e) {
      G.ui = null;
      const m = String(e.message);
      box.textContent = /returned (401|403)/.test(m) ? 'Stopped: swgoh.gg refused the request. Make sure you are signed in and have GAC Insight access (Player+).'
        : /returned 404/.test(m) ? 'Stopped: swgoh.gg could not find that ally code. Check both codes.'
        : 'Stopped: ' + m;
      setTimeout(() => box.remove(), 20000);
      throw e;
    }
  };
  return 'GAC ready';
})();
