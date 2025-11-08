// 动态文本框：自动从币安拉取数据并生成中文报告（支持多币种）
(function () {
  // 保存各交易对的最新文本，供AI模块选择发送
  const latestTextMap = {};
  // 保存各交易对的最新标记价（供合约模拟盘使用）
  const latestPriceMap = {};
  const endpoints = [
    'https://api.binance.com',
    'https://api1.binance.com',
    'https://api2.binance.com',
    'https://api3.binance.com',
  ];
  // 币安期货（USDⓈ-M 永续）端点
  const futuresEndpoints = [
    'https://fapi.binance.com',
  ];

  // 顶部价格栏元素与状态
  const topbarEls = {
    BTCUSDT: document.getElementById('pr_BTCUSDT'),
    ETHUSDT: document.getElementById('pr_ETHUSDT'),
    SOLUSDT: document.getElementById('pr_SOLUSDT'),
    BNBUSDT: document.getElementById('pr_BNBUSDT'),
    DOGEUSDT: document.getElementById('pr_DOGEUSDT'),
    XRPUSDT: document.getElementById('pr_XRPUSDT'),
    status: document.getElementById('binanceStatus'),
  };

  // 底部价格栏元素与状态
  const bottombarEls = {
    BTCUSDT: document.getElementById('pr2_BTCUSDT'),
    ETHUSDT: document.getElementById('pr2_ETHUSDT'),
    SOLUSDT: document.getElementById('pr2_SOLUSDT'),
    BNBUSDT: document.getElementById('pr2_BNBUSDT'),
    DOGEUSDT: document.getElementById('pr2_DOGEUSDT'),
    XRPUSDT: document.getElementById('pr2_XRPUSDT'),
    status: document.getElementById('binanceStatusBottom'),
  };

  let binanceWsConnected = false;
  let lastApiOk = 0;
  let lastApiErr = 0;
  // 全局开关：是否允许执行AI自动操盘指令（在模拟盘面板控制）
  let aiAutoOpsEnabled = false;
  // 全自动状态：AI解析自动执行开关 + 模拟盘总开关 + 自动发送循环
  let autoExecEnabled = false; // 跟随AI刷新自动执行（第二列开关）
  let autoTimer = null;       // 定时自动发送计时器（第二列开关）

  // AI策略约束（默认从配置覆盖）
  let aiPolicy = { allowMarket: true, allowLimit: true, requireSlForOpen: true, requireTpForOpen: false };

  // 模式：AI自动操盘数据源（sim|off）
  let aiMode = 'off';
  function setAiMode(mode){
    aiMode = (mode === 'sim') ? 'sim' : 'off';
    aiAutoOpsEnabled = aiMode !== 'off';
    const simBtn = document.getElementById('aiAutoSwitchBtn');
    try { if (simBtn) simBtn.textContent = aiMode==='sim' ? tr('ai_auto_on') : tr('ai_auto_off'); } catch {}
    // 按钮状态样式
    try {
      if (simBtn) {
        simBtn.classList.toggle('toggle-on', aiMode==='sim');
        simBtn.classList.toggle('toggle-off', aiMode!=='sim');
      }
    } catch{}
    recalcAutoUptime();
  }

  // ====== 实盘（U本位）配置与状态 ======
  let liveEnabled = false;
  // 实盘轮询器（用于第三列展示真实账户/持仓/委托）
  let livePollTimer = null;
  let livePollInFlight = false;
  let latestLiveEquity = null;
  let latestLiveAccount = null;
  let latestLiveRisks = [];
  let latestLiveOpenOrders = [];
  let latestLiveOrderHistory = [];
  let latestLiveTradeHistory = [];
  let latestMakerRate = null;
  let latestTakerRate = null;
  const FEE_RATE_STORAGE = { maker: 'live_maker_rate_text', taker: 'live_taker_rate_text' };
  // 交易对过滤器缓存：来自 /fapi/v1/exchangeInfo，用于精度与最小值校验
  const symbolFiltersCache = {}; // symbol -> { tickSize, minPrice, stepSize, minQty, mktStepSize, mktMinQty, minNotional }
  const LIVE_STORE_KEYS = {
    serverUrl: 'live_server_url',
    apiKey: 'live_api_key',
    apiSecret: 'live_api_secret'
  };
  const liveEls = {
    serverUrl: document.getElementById('liveServerUrl'),
    apiKey: document.getElementById('liveApiKey'),
    apiSecret: document.getElementById('liveApiSecret'),
    saveBtn: document.getElementById('saveLiveCfgBtn'),
    toggleBtn: document.getElementById('liveToggleBtn'),
    status: document.getElementById('liveStatus')
  };

  function loadLiveCfg(){
    try {
      const url = localStorage.getItem(LIVE_STORE_KEYS.serverUrl) || '';
      const key = localStorage.getItem(LIVE_STORE_KEYS.apiKey) || '';
      const sec = localStorage.getItem(LIVE_STORE_KEYS.apiSecret) || '';
      if (liveEls.serverUrl) liveEls.serverUrl.value = url;
      if (liveEls.apiKey) liveEls.apiKey.value = key;
      if (liveEls.apiSecret) liveEls.apiSecret.value = sec;
    } catch {}
  }

  // 从后端配置自动调取（不暴露密钥，仅可能提供 serverUrl 与默认开关）
  async function applyBackendCfg(){
    try {
      const res = await fetch('/config');
      if (!res.ok) return; // 静默跳过
      const cfg = await res.json();
      const url = String(cfg?.live?.serverUrl || '').trim();
      if (url) {
        try { localStorage.setItem(LIVE_STORE_KEYS.serverUrl, url); } catch {}
        if (liveEls.serverUrl) liveEls.serverUrl.value = url;
      }
      // 仅在交易页面遵循后端默认开关
      const isTradingPage = /trading\.html$/i.test(location.pathname);
      const defLive = !!(cfg?.defaults?.liveEnabled);
      if (isTradingPage && defLive) setLiveEnabled(true);
      // 从后端配置应用AI策略约束
      if (cfg?.aiPolicy) {
        aiPolicy = Object.assign({}, aiPolicy, {
          allowMarket: !!cfg.aiPolicy.allowMarket,
          allowLimit: !!cfg.aiPolicy.allowLimit,
          requireSlForOpen: !!cfg.aiPolicy.requireSlForOpen,
          requireTpForOpen: !!cfg.aiPolicy.requireTpForOpen,
        });
      }
    } catch {}
  }

  function saveLiveCfg(){
    try {
      const url = (liveEls.serverUrl && liveEls.serverUrl.value || '').trim();
      const key = (liveEls.apiKey && liveEls.apiKey.value || '').trim();
      const sec = (liveEls.apiSecret && liveEls.apiSecret.value || '').trim();
      localStorage.setItem(LIVE_STORE_KEYS.serverUrl, url);
      localStorage.setItem(LIVE_STORE_KEYS.apiKey, key);
      localStorage.setItem(LIVE_STORE_KEYS.apiSecret, sec);
      if (liveEls.status) liveEls.status.textContent = '已保存（仅前端本地）';
    } catch {}
  }

  function setLiveEnabled(val){
    liveEnabled = !!val;
    try {
      if (liveEls.toggleBtn) {
        liveEls.toggleBtn.textContent = liveEnabled ? '实盘：开启' : '实盘：关闭';
        liveEls.toggleBtn.classList.toggle('toggle-on', liveEnabled);
        liveEls.toggleBtn.classList.toggle('toggle-off', !liveEnabled);
        // 开启时按钮变红更醒目
        liveEls.toggleBtn.classList.toggle('live-on', liveEnabled);
      }
      if (liveEls.status) liveEls.status.textContent = liveEnabled ? '实盘已启用（通过服务器代理）' : '实盘未启用';
    } catch{}
    try { updateContractPanelTitle(); } catch {}
    try { applyLiveUiToggles(); } catch {}
    if (liveEnabled) startLivePolling(); else stopLivePolling();
  }

  function updateContractPanelTitle(){
    const el = document.querySelector('.contract-panel .panel__title');
    if (!el) return;
    el.textContent = liveEnabled ? '合约实盘（USDT本位·全仓模式）' : '合约模拟盘（USDT本位·全仓模式·未包含手续费）';
  }

  function applyLiveUiToggles(){
    try {
      const rowInit = simEls.initBalance && simEls.initBalance.closest('.form-row');
      if (rowInit) rowInit.style.display = liveEnabled ? 'none' : '';
      if (simEls.saveBalanceBtn) simEls.saveBalanceBtn.style.display = liveEnabled ? 'none' : '';
      if (simEls.placeBtn) simEls.placeBtn.style.display = liveEnabled ? 'none' : '';
      if (simEls.resetBtn) simEls.resetBtn.style.display = liveEnabled ? 'none' : '';
      const balItem = simEls.accBalance && simEls.accBalance.closest('.item');
      if (balItem) balItem.style.display = liveEnabled ? 'none' : '';
      // 在交易页去掉未实现盈亏展示
      const isTradingPage = /trading\.html$/i.test(location.pathname);
      const upnlItem = simEls.accUpnl && simEls.accUpnl.closest('.item');
      if (upnlItem) upnlItem.style.display = liveEnabled && isTradingPage ? 'none' : '';
      const box = document.getElementById('accountBox');
      if (!box) return;
      if (liveEnabled){
        // 手动输入费率（自动保存，默认以百分号显示）
        if (!document.getElementById('feeMakerInput')){
          const d = document.createElement('div'); d.className='item';
          const l = document.createElement('div'); l.className='label'; l.textContent='手续费率（挂单）';
          const v = document.createElement('input'); v.className='value'; v.id='feeMakerInput'; v.type='text'; v.placeholder='0.02%';
          try { const saved = localStorage.getItem(FEE_RATE_STORAGE.maker)||''; if (saved) v.value = saved; } catch{}
          d.appendChild(l); d.appendChild(v); box.appendChild(d);
          v.addEventListener('change', ()=>{ try { localStorage.setItem(FEE_RATE_STORAGE.maker, v.value||''); } catch{}; updateLatestFeeRatesFromInputs(); });
        }
        if (!document.getElementById('feeTakerInput')){
          const d = document.createElement('div'); d.className='item';
          const l = document.createElement('div'); l.className='label'; l.textContent='手续费率（吃单）';
          const v = document.createElement('input'); v.className='value'; v.id='feeTakerInput'; v.type='text'; v.placeholder='0.04%';
          try { const saved = localStorage.getItem(FEE_RATE_STORAGE.taker)||''; if (saved) v.value = saved; } catch{}
          d.appendChild(l); d.appendChild(v); box.appendChild(d);
          v.addEventListener('change', ()=>{ try { localStorage.setItem(FEE_RATE_STORAGE.taker, v.value||''); } catch{}; updateLatestFeeRatesFromInputs(); });
        }
        // 初次应用时同步一次全局费率
        updateLatestFeeRatesFromInputs();
      } else {
        const mk = document.getElementById('feeMakerInput');
        const tk = document.getElementById('feeTakerInput');
        if (mk) mk.closest('.item')?.remove();
        if (tk) tk.closest('.item')?.remove();
      }
    } catch{}
  }

  // 解析百分比字符串为十进制费率（如 "0.02%" -> 0.0002；"0.02" -> 0.0002）
  function parsePercentRate(text){
    const s = String(text||'').trim();
    if (!s) return null;
    const hadPct = /%$/.test(s);
    const num = Number(s.replace('%',''));
    if (!isFinite(num)) return null;
    const pct = num;
    const dec = pct / 100;
    return dec;
  }
  function updateLatestFeeRatesFromInputs(){
    try {
      const mkEl = document.getElementById('feeMakerInput');
      const tkEl = document.getElementById('feeTakerInput');
      latestMakerRate = parsePercentRate(mkEl?.value || '') ?? latestMakerRate;
      latestTakerRate = parsePercentRate(tkEl?.value || '') ?? latestTakerRate;
    } catch{}
  }

  async function fetchLiveSnapshot(){
    // 统一抓取账户、风险与当前委托
    const recv = 5000;
    const [account, risks, openOrders] = await Promise.all([
      proxySigned('GET', '/fapi/v2/account', { recvWindow: recv }),
      proxySigned('GET', '/fapi/v2/positionRisk', { recvWindow: recv }),
      proxySigned('GET', '/fapi/v1/openOrders', { recvWindow: recv }),
    ]);
    return { account, risks: Array.isArray(risks)?risks:[], openOrders: Array.isArray(openOrders)?openOrders:[] };
  }

  function selectedSymbolsForLiveHistory(){
    const syms = selectedSymbols();
    if (syms && syms.length) return syms.map(s=> String(s).toUpperCase());
    const fromPos = (latestLiveRisks||[]).map(r=> String(r.symbol||'').toUpperCase()).filter(Boolean);
    const fromOpen = (latestLiveOpenOrders||[]).map(o=> String(o.symbol||'').toUpperCase()).filter(Boolean);
    const set = new Set([...fromPos, ...fromOpen]);
    const list = Array.from(set);
    return list.length ? list : ['BTCUSDT'];
  }

  // 轻量级延迟（用于顺序请求以避免限速/权重峰值）
  function wait(ms){ return new Promise(r=> setTimeout(r, ms)); }

  async function fetchLiveOrderHistory(symbols, limit=50){
    const syms = (symbols && symbols.length) ? symbols : selectedSymbolsForLiveHistory();
    const recv = 5000;
    const all = [];
    try {
      for (const s of syms){
        try {
          const arr = await proxySigned('GET', '/fapi/v1/allOrders', { symbol: s, limit: Math.min(limit, 1000), recvWindow: recv });
          if (Array.isArray(arr)) all.push(...arr);
          else {
            pushLocalLog('ai_cmd_exec_log_v1', `[${new Date().toLocaleString()}] 历史抓取失败：GET /fapi/v1/allOrders ${s} -> 非数组返回`);
          }
        } catch (err){
          pushLocalLog('ai_cmd_exec_log_v1', `[${new Date().toLocaleString()}] 历史抓取异常：GET /fapi/v1/allOrders ${s} -> ${String(err && err.message || err)}`);
        }
        // 避免连续请求造成限速/漏数
        await wait(120);
      }
      all.sort((a,b)=> Number(b.updateTime||b.time||0) - Number(a.updateTime||a.time||0));
      latestLiveOrderHistory = all.slice(0, limit);
      return latestLiveOrderHistory;
    } catch(e){ console.error('fetchLiveOrderHistory error', e); return latestLiveOrderHistory; }
  }

  async function fetchLiveTrades(symbols, limit=50){
    const syms = (symbols && symbols.length) ? symbols : selectedSymbolsForLiveHistory();
    const recv = 5000;
    const all = [];
    try {
      for (const s of syms){
        try {
          const arr = await proxySigned('GET', '/fapi/v1/userTrades', { symbol: s, limit: Math.min(limit, 1000), recvWindow: recv });
          if (Array.isArray(arr)) all.push(...arr);
          else {
            pushLocalLog('ai_cmd_exec_log_v1', `[${new Date().toLocaleString()}] 历史抓取失败：GET /fapi/v1/userTrades ${s} -> 非数组返回`);
          }
        } catch (err){
          pushLocalLog('ai_cmd_exec_log_v1', `[${new Date().toLocaleString()}] 历史抓取异常：GET /fapi/v1/userTrades ${s} -> ${String(err && err.message || err)}`);
        }
        await wait(120);
      }
      all.sort((a,b)=> Number(b.time||0) - Number(a.time||0));
      latestLiveTradeHistory = all.slice(0, limit);
      return latestLiveTradeHistory;
    } catch(e){ console.error('fetchLiveTrades error', e); return latestLiveTradeHistory; }
  }

  function renderLiveAccount(account){
    if (!account) return;
    try {
      latestLiveAccount = account;
      const balance = Number(account.totalWalletBalance || account.totalMarginBalance || 0);
      const equity = Number(account.totalMarginBalance || balance);
      const upnl = Number(account.totalUnrealizedProfit || 0);
      const avail = Number(account.availableBalance || balance);
      // 估算已用保证金：遍历 positions 结合标记价
      let used = 0;
      (account.positions||[]).forEach(p=>{
        const sym = String(p.symbol||'').toUpperCase();
        const qty = Math.abs(Number(p.positionAmt||0));
        const lev = Math.max(1, Number(p.leverage||1));
        const mp = Number(latestPriceMap[sym] || p.markPrice || p.entryPrice || 0);
        if (qty>0 && mp>0) used += (qty * mp) / lev;
      });
      latestLiveEquity = equity;
      if (simEls.accBalance) simEls.accBalance.textContent = fmt(balance, 2);
      if (simEls.accEquity) simEls.accEquity.textContent = fmt(equity, 2);
      if (simEls.accUsedMargin) simEls.accUsedMargin.textContent = fmt(used, 2);
      if (simEls.accAvail) simEls.accAvail.textContent = fmt(avail, 2);
      // 交易页不展示未实现盈亏
      const isTradingPage = /trading\.html$/i.test(location.pathname);
      if (simEls.accUpnl) simEls.accUpnl.textContent = isTradingPage ? '—' : fmt(upnl, 2);
      if (simEls.accRpnl) simEls.accRpnl.textContent = '—';
      // 通知收益曲线进行一次即时采样（在模拟盘模块中监听此事件）
      try { window.dispatchEvent(new CustomEvent('equity_update')); } catch {}
      // 费率改为手动输入，不再覆盖；仅同步到全局
      updateLatestFeeRatesFromInputs();
    } catch{}
  }

  function renderLivePositions(risks){
    try {
      const tbodyPos = simEls.posTable.querySelector('tbody');
      tbodyPos.innerHTML = '';
      risks.forEach(it=>{
        const symbol = String(it.symbol||'');
        const amt = Number(it.positionAmt||0);
        if (!symbol || !amt) return;
        const tr = document.createElement('tr');
        const side = amt>0 ? '多' : '空';
        const qtyAbs = Math.abs(amt);
        const entry = Number(it.entryPrice||0);
        const lev = Number(it.leverage||1);
        // 未实现盈亏字段修正：positionRisk 返回 unRealizedProfit（R 大写）
        const upnl = Number((typeof it.unRealizedProfit!=='undefined' ? it.unRealizedProfit : it.unrealizedProfit)||0);
        const mp = Number(latestPriceMap[symbol] || it.markPrice || entry);
        const used = mp>0 ? (qtyAbs * mp) / Math.max(1, lev) : 0;
        const td = (t)=>{ const el=document.createElement('td'); el.textContent=t; return el; };
        tr.appendChild(td(symbol));
        tr.appendChild(td(side));
        tr.appendChild(td(fmt(qtyAbs, 4)));
        tr.appendChild(td(fmt(entry, decimalsForSymbol(symbol))));
        tr.appendChild(td(`${lev}x`));
        // 交易页去掉未实现盈亏列
        if (!/trading\.html$/i.test(location.pathname)){
          tr.appendChild(td(fmt(upnl, 2)));
        }
        tr.appendChild(td(fmt(used, 2)));
        const op = document.createElement('td');
        const a = document.createElement('span'); a.className='action-link'; a.textContent='平仓';
        const posSide = String(it.positionSide || (amt>0?'LONG':'SHORT'));
        a.addEventListener('click', ()=> execLiveOp({ action:'close', symbol, positionSide: posSide }));
        op.appendChild(a); tr.appendChild(op);
        tbodyPos.appendChild(tr);
      });
    } catch{}
  }

  function renderLiveOpenOrders(openOrders){
    try {
      const tbodyOpen = simEls.openOrdersTable.querySelector('tbody');
      tbodyOpen.innerHTML = '';
      openOrders.forEach(o=>{
        const tr = document.createElement('tr');
        const td = (t)=>{ const el=document.createElement('td'); el.textContent=t; return el; };
        const ts = Number(o.updateTime || o.time || Date.now());
        tr.appendChild(td(new Date(ts).toLocaleString()));
        const symbol = String(o.symbol||'');
        tr.appendChild(td(symbol));
        tr.appendChild(td(String(o.side||'').toUpperCase()));
        tr.appendChild(td(String(o.type||'').toUpperCase()));
        tr.appendChild(td(fmt(Number(o.price||0), decimalsForSymbol(symbol))));
        tr.appendChild(td(fmt(Number(o.origQty||o.quantity||0), 4)));
        tr.appendChild(td(String(o.status||'NEW')));
        const op = document.createElement('td');
        const c = document.createElement('span'); c.className='action-link'; c.textContent='撤销';
        c.addEventListener('click', async ()=>{
          try{ await proxySigned('DELETE', '/fapi/v1/order', { symbol, orderId: o.orderId, recvWindow: 5000 }); setSimStatus('状态：已撤销委托'); } catch(e){ setSimStatus(`状态：撤销失败：${e?.message||e}`); }
        });
        op.appendChild(c); tr.appendChild(op);
        tbodyOpen.appendChild(tr);
      });
    } catch{}
  }

  function renderLiveOrderHistory(list){
    try {
      if (!simEls.orderHistoryTable) return; // 已移除表格：跳过渲染
      const tbody = simEls.orderHistoryTable.querySelector('tbody');
      tbody.innerHTML = '';
      (list||latestLiveOrderHistory||[]).forEach(o=>{
        const tr = document.createElement('tr');
        const td = (t)=>{ const el=document.createElement('td'); el.textContent=t; return el; };
        const ts = Number(o.updateTime || o.time || o.workingTime || Date.now());
        const symbol = String(o.symbol||'');
        const price = Number(o.price||0);
        const qty = Number(o.origQty || o.executedQty || 0);
        const status = String(o.status||'NEW');
        tr.appendChild(td(new Date(ts).toLocaleString()));
        tr.appendChild(td(symbol));
        tr.appendChild(td(String(o.side||'').toUpperCase()));
        tr.appendChild(td(String(o.type||'').toUpperCase()));
        tr.appendChild(td(fmt(price, decimalsForSymbol(symbol))));
        tr.appendChild(td(fmt(qty, 4)));
        tr.appendChild(td(String(status)));
        tbody.appendChild(tr);
      });
    } catch{}
  }

  function renderLiveTradeHistory(list){
    try {
      const tbody = simEls.tradeHistoryTable.querySelector('tbody');
      tbody.innerHTML = '';
      (list||latestLiveTradeHistory||[]).forEach(t=>{
        const tr = document.createElement('tr');
        const td = (v)=>{ const el=document.createElement('td'); el.textContent=v; return el; };
        const ts = Number(t.time || Date.now());
        const symbol = String(t.symbol||'');
        const side = String(t.side || (t.buyer?'BUY':'SELL')).toUpperCase();
        const price = Number(t.price||0);
        const qty = Number(t.qty||0);
        const rpnl = t.realizedPnl!=null ? Number(t.realizedPnl) : '—';
        tr.appendChild(td(new Date(ts).toLocaleString()));
        tr.appendChild(td(symbol));
        tr.appendChild(td(side));
        tr.appendChild(td(fmt(price, decimalsForSymbol(symbol))));
        tr.appendChild(td(fmt(qty, 4)));
        tr.appendChild(td(rpnl));
        tbody.appendChild(tr);
      });
    } catch{}
  }

  async function refreshLive(){
    if (!liveEnabled || livePollInFlight) return;
    livePollInFlight = true;
    try {
      const snap = await fetchLiveSnapshot();
      latestLiveRisks = Array.isArray(snap.risks) ? snap.risks : [];
      latestLiveOpenOrders = Array.isArray(snap.openOrders) ? snap.openOrders : [];
      renderLiveAccount(snap.account);
      renderLivePositions(snap.risks);
      renderLiveOpenOrders(snap.openOrders);
      // fetch histories for selected symbols and render
      const syms = selectedSymbolsForLiveHistory();
      const [histOrders, histTrades] = await Promise.all([
        fetchLiveOrderHistory(syms, 50),
        fetchLiveTrades(syms, 50)
      ]);
      renderLiveOrderHistory(histOrders);
      renderLiveTradeHistory(histTrades);
      setSimStatus('状态：实盘数据已刷新');
    } catch(e){ setSimStatus(`状态：实盘刷新失败：${e?.message||e}`); }
    finally { livePollInFlight = false; }
  }

  function startLivePolling(){
    stopLivePolling();
    // 首次立即刷新，随后每5秒刷新一次
    refreshLive();
    livePollTimer = setInterval(refreshLive, 5000);
  }
  function stopLivePolling(){
    if (livePollTimer){ clearInterval(livePollTimer); livePollTimer = null; }
  }

  async function proxySigned(method, path, params = {}){
    // 新策略：优先使用后端提供的 serverUrl；否则默认同源 /signed
    const cfgUrl = (localStorage.getItem(LIVE_STORE_KEYS.serverUrl) || '').trim();
    const url = cfgUrl ? cfgUrl.replace(/\/$/, '') + '/signed' : '/signed';
    const apiKey = (liveEls.apiKey && liveEls.apiKey.value) || localStorage.getItem(LIVE_STORE_KEYS.apiKey) || '';
    const apiSecret = (liveEls.apiSecret && liveEls.apiSecret.value) || localStorage.getItem(LIVE_STORE_KEYS.apiSecret) || '';
    const body = { method: String(method||'GET').toUpperCase(), path, params };
    if (apiKey && apiSecret) { body.apiKey = apiKey; body.apiSecret = apiSecret; }
    // 仅对订单相关接口记录一次“前端已发起”以便诊断（不会记录轮询类GET）
    try {
      const m = String(body.method||'').toUpperCase();
      const p = String(path||'');
      const important = new Set([
        '/fapi/v1/order',
        '/fapi/v1/allOpenOrders',
        '/fapi/v1/batchOrders',
        '/fapi/v1/leverage',
      ]);
      if ((m==='POST' || m==='DELETE') && important.has(p)){
        const line = `[${new Date().toLocaleString()}] 发送至Binance：${m} ${p} params=${JSON.stringify(params)}`;
        pushLocalLog('ai_cmd_exec_log_v1', line);
        try {
          const view = document.getElementById('aiCmdLog');
          const opsView = document.getElementById('aiOpsLog');
          if (view){ const arr = JSON.parse(localStorage.getItem('ai_cmd_exec_log_v1') || '[]'); view.textContent = arr.slice(-200).reverse().join('\n\n'); opsView && (opsView.textContent = view.textContent); }
        } catch {}
      }
    } catch {}
    try {
      const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!res.ok){
        const txt = await res.text();
        const errStr = `服务器代理错误：${res.status} ${res.statusText} ${txt}`;
        pushLocalLog('ai_cmd_exec_log_v1', `[${new Date().toLocaleString()}] 前端发送失败：${errStr}`);
        try { const view = document.getElementById('aiCmdLog'); const opsView = document.getElementById('aiOpsLog'); if (view){ const arr = JSON.parse(localStorage.getItem('ai_cmd_exec_log_v1') || '[]'); view.textContent = arr.slice(-200).reverse().join('\n\n'); opsView && (opsView.textContent = view.textContent); } } catch {}
        throw new Error(errStr);
      }
      return await res.json();
    } catch (e){
      pushLocalLog('ai_cmd_exec_log_v1', `[${new Date().toLocaleString()}] 前端网络异常：${String(e && e.message || e)}`);
      try { const view = document.getElementById('aiCmdLog'); const opsView = document.getElementById('aiOpsLog'); if (view){ const arr = JSON.parse(localStorage.getItem('ai_cmd_exec_log_v1') || '[]'); view.textContent = arr.slice(-200).reverse().join('\n\n'); opsView && (opsView.textContent = view.textContent); } } catch {}
      throw e;
    }
  }

  function oppositeSide(side){ return side==='long' ? 'SELL' : 'BUY'; }
  function openSide(side){ return side==='short' ? 'SELL' : 'BUY'; }
  // 数量步进（粗略映射常用交易对，确保合规）；如需更全面可动态拉取 exchangeInfo
  function qtyStepForSymbol(symbol, isMarket){
    const s = String(symbol||'').toUpperCase();
    // 静态后备（在未拉取到 filters 前使用）；MARKET 使用更粗的步进以提升通过率
    if (s==='BTCUSDT') return isMarket ? 0.001 : 0.001;
    if (s==='ETHUSDT') return isMarket ? 0.01 : 0.01;
    if (s==='SOLUSDT') return isMarket ? 0.1 : 0.1;
    if (s==='BNBUSDT') return isMarket ? 0.01 : 0.01;
    if (s==='DOGEUSDT') return isMarket ? 1 : 1;
    if (s==='XRPUSDT') return isMarket ? 1 : 1;
    return isMarket ? 0.001 : 0.001; // 默认后备
  }
  function _decimalsFromStep(step){
    const s = String(step||'');
    if (!s) return 8;
    if (s.includes('e-')){ const n = Number(s.split('e-')[1]||'0'); return Number.isFinite(n)?n:8; }
    const i = s.indexOf('.');
    return i>=0 ? (s.length - i - 1) : 0;
  }
  function roundStep(val, step){
    const s = Number(step||0.001);
    if (!isFinite(val) || s<=0) return val;
    const raw = Math.floor(val / s + 1e-9) * s;
    const digits = _decimalsFromStep(step);
    return Number(raw.toFixed(digits));
  }

  function roundTick(val, tick){
    const t = Number(tick||0.01);
    if (!isFinite(val) || t<=0) return val;
    return Math.floor(val / t + 1e-9) * t;
  }

  function getFiltersForSymbol(symbol){
    return symbolFiltersCache[String(symbol||'').toUpperCase()] || null;
  }

  async function ensureExchangeInfoFor(symbols){
    const need = symbols.filter(s=> !symbolFiltersCache[String(s).toUpperCase()]);
    if (!need.length) return;
    const info = await binanceFutures('/fapi/v1/exchangeInfo');
    const arr = Array.isArray(info?.symbols)? info.symbols : [];
    for (const s of arr){
      const sym = String(s?.symbol||'').toUpperCase();
      if (!need.includes(sym)) continue;
      const filters = Array.isArray(s?.filters)? s.filters : [];
      const byType = {};
      for (const f of filters) byType[f.filterType] = f;
      const pf = byType.PRICE_FILTER || {};
      const lot = byType.LOT_SIZE || {};
      const mkt = byType.MARKET_LOT_SIZE || {};
      const mn = byType.MIN_NOTIONAL || byType.NOTIONAL || {};
      symbolFiltersCache[sym] = {
        tickSize: Number(pf.tickSize||0) || null,
        minPrice: Number(pf.minPrice||0) || null,
        stepSize: Number(lot.stepSize||0) || null,
        minQty: Number(lot.minQty||0) || null,
        mktStepSize: Number(mkt.stepSize||0) || null,
        mktMinQty: Number(mkt.minQty||0) || null,
        minNotional: Number(mn.minNotional||0) || null,
      };
    }
  }

  function qtyStepForSymbol(symbol, isMarket){
    const f = getFiltersForSymbol(symbol);
    if (!f) return qtyStepForSymbol(String(symbol||'').toUpperCase(), !!isMarket);
    // 市价单优先采用 MARKET_LOT_SIZE，限价单采用 LOT_SIZE
    const step = isMarket ? (f.mktStepSize || f.stepSize || 0.001) : (f.stepSize || 0.001);
    return step;
  }

  function tickSizeForSymbol(symbol){
    const f = getFiltersForSymbol(symbol);
    return f?.tickSize || 0.01;
  }

  function minQtyForSymbol(symbol, isMarket){
    const f = getFiltersForSymbol(symbol);
    if (!f) return 0;
    return isMarket ? (f.mktMinQty || f.minQty || 0) : (f.minQty || 0);
  }

  function minNotionalForSymbol(symbol){
    const f = getFiltersForSymbol(symbol);
    return f?.minNotional || 0;
  }

  async function fetchIsHedgeMode(){
    // 更稳妥的持仓模式检测：优先查询 /fapi/v1/positionSide/dual，其次 /fapi/v2/account
    try {
      const r = await proxySigned('GET', '/fapi/v1/positionSide/dual', {});
      if (typeof r?.dualSidePosition !== 'undefined') return !!r.dualSidePosition;
    } catch {}
    try {
      const acc = await proxySigned('GET', '/fapi/v2/account', {});
      if (typeof acc?.dualSidePosition !== 'undefined') return !!acc.dualSidePosition;
    } catch {}
    return null; // 无法确认
  }

  // 设置杠杆（若提供 lev），失败不阻断下单
  async function setLeverageIfNeeded(symbol, lev){
    const raw = Number(lev||0);
    if (!isFinite(raw) || raw < 1) return;
    const leverage = Math.max(1, Math.min(125, Math.floor(raw)));
    try {
      await proxySigned('POST', '/fapi/v1/leverage', { symbol, leverage, recvWindow: 5000 });
    } catch (e){
      // 不中断流程，仅提示
      try { setSimStatus(`状态：设置杠杆失败 ${symbol} ${leverage}x：${e?.message||e}`); } catch {}
    }
  }

  async function execLiveOp(op){
    const act = String(op?.action||'').toLowerCase();
    if (act==='open'){
      // 确保加载过滤器
      const symbol = String(op.symbol||'').toUpperCase();
      const side = openSide(op.side==='short'?'short':'long');
      const type = op.type==='limit' ? 'LIMIT' : 'MARKET';
      const qty = Number(op.qty||0);
      if (!symbol || !qty || qty<=0) throw new Error('指令错误：数量或交易对无效');
      // 账户模式：对冲/单向（稳妥检测）
      let isHedge = await fetchIsHedgeMode();
      if (isHedge === null) isHedge = false; // 无法确认时默认按单向试；若报 -4061 再人工处理
      await ensureExchangeInfoFor([symbol]);
      // 精度与最小值校验
      const step = qtyStepForSymbol(symbol, type==='MARKET');
      const tick = tickSizeForSymbol(symbol);
      const minQty = minQtyForSymbol(symbol, type==='MARKET');
      const qNorm = roundStep(qty, step);
      if (qNorm < minQty - 1e-12) throw new Error(`数量过小：最小 ${minQty}`);
      // 若提供 lev，则在开仓前尝试设置杠杆
      await setLeverageIfNeeded(symbol, op.lev);
      const baseParams = { symbol, side, type, recvWindow: 5000 };
      const posSide = (op.side==='short') ? 'SHORT' : 'LONG';
      if (isHedge) baseParams.positionSide = posSide;
      if (type==='MARKET') {
        baseParams.quantity = qNorm;
        const mn = minNotionalForSymbol(symbol);
        if (mn>0){
          const mp = Number(latestPriceMap[symbol]||0);
          if (mp>0 && mp * baseParams.quantity < mn - 1e-9){
            throw new Error(`名义金额过小：需≥${mn}`);
          }
        }
      } else {
        const price = Number(op.price||0);
        if (!price || price<=0) throw new Error('限价需有效价格');
        baseParams.timeInForce = 'GTC';
        baseParams.quantity = qNorm;
        baseParams.price = roundTick(price, tick);
        // MIN_NOTIONAL 校验（price * qty）
        const mn = minNotionalForSymbol(symbol);
        if (mn>0 && baseParams.price * baseParams.quantity < mn - 1e-9) {
          throw new Error(`名义金额过小：需≥${mn}`);
        }
      }
      await proxySigned('POST', '/fapi/v1/order', baseParams);
      // 附加TP/SL（使用MARK_PRICE触发，平掉全部持仓）
      const tp = Number(op.sl_tp?.tp||op.tp||'') || null;
      const sl = Number(op.sl_tp?.sl||op.sl||'') || null;
      const tpSide = oppositeSide(op.side==='short'?'short':'long');
      if (tp){
        await proxySigned('POST', '/fapi/v1/order', {
          symbol,
          side: tpSide,
          type: 'TAKE_PROFIT_MARKET',
          stopPrice: roundTick(tp, tickSizeForSymbol(symbol)),
          closePosition: true,
          workingType: 'MARK_PRICE',
          ...(isHedge ? { positionSide: posSide } : {}),
          recvWindow: 5000
        });
      }
      if (sl){
        await proxySigned('POST', '/fapi/v1/order', {
          symbol,
          side: tpSide,
          type: 'STOP_MARKET',
          stopPrice: roundTick(sl, tickSizeForSymbol(symbol)),
          closePosition: true,
          workingType: 'MARK_PRICE',
          ...(isHedge ? { positionSide: posSide } : {}),
          recvWindow: 5000
        });
      }
      setSimStatus(`状态：实盘下单成功 ${symbol} ${side} qty=${qty}`);
      return;
    }
    if (act==='close' && op.symbol){
      const symbol = String(op.symbol).toUpperCase();
      // 查询持仓方向与数量
      const risks = await proxySigned('GET', '/fapi/v2/positionRisk', { recvWindow: 5000 });
      const list = (Array.isArray(risks)?risks:[]).filter(r=> String(r.symbol).toUpperCase()===symbol);
      if (!list.length){ setSimStatus('状态：实盘无持仓'); return; }
      // 对冲模式优先按参数 positionSide；否则取非零的那一个
      let isHedge = await fetchIsHedgeMode();
      if (isHedge === null) isHedge = false;
      let chosen = null;
      if (isHedge && op.positionSide){
        chosen = list.find(r=> String(r.positionSide||'').toUpperCase()===String(op.positionSide||'').toUpperCase());
      }
      if (!chosen){
        chosen = list.find(r=> Number(r.positionAmt||0) !== 0) || list[0];
      }
      const amt = Number(chosen?.positionAmt||0);
      if (!amt){ setSimStatus('状态：实盘无持仓'); return; }
      const qty = Math.abs(amt);
      const side = amt>0 ? 'SELL' : 'BUY';
      const posSide = amt>0 ? 'LONG' : 'SHORT';
      await ensureExchangeInfoFor([symbol]);
      // 先撤对应TP/SL（避免触发）
      try {
        const openOrders = await proxySigned('GET', '/fapi/v1/openOrders', { symbol, recvWindow: 5000 }) || [];
        const tpslTypes = new Set(['TAKE_PROFIT','TAKE_PROFIT_MARKET','STOP','STOP_MARKET','TRAILING_STOP_MARKET']);
        const cancelList = (Array.isArray(openOrders)?openOrders:[]).filter(o=>{
          const t = String(o.type||'').toUpperCase();
          if (!tpslTypes.has(t)) return false;
          if (isHedge) return String(o.positionSide||'').toUpperCase()===posSide;
          return true;
        });
        for (const o of cancelList){
          try { await proxySigned('DELETE','/fapi/v1/order',{ symbol, orderId: o.orderId, recvWindow: 5000 }); } catch(e){}
        }
      } catch(e){
        // 忽略撤单错误，继续平仓
      }
      const qNorm = roundStep(qty, qtyStepForSymbol(symbol, true));
      // 单向模式使用 reduceOnly；对冲模式通过 positionSide 精确平仓
      const params = { symbol, side, type:'MARKET', quantity: qNorm, recvWindow: 5000 };
      if (isHedge) params.positionSide = posSide;
      // 仅在单向模式发送 reduceOnly，避免 -1106 错误
      if (!isHedge) params.reduceOnly = true;
      await proxySigned('POST', '/fapi/v1/order', params);
      setSimStatus(`状态：实盘平仓成功 ${symbol} qty=${qty}`);
      return;
    }
    if (act==='cancel_all'){
      const symbol = String(op.symbol||'').toUpperCase();
      await proxySigned('DELETE', '/fapi/v1/allOpenOrders', { symbol, recvWindow: 5000 });
      setSimStatus(`状态：实盘撤销全部委托 ${symbol}`);
      return;
    }
    if (act==='close_all'){
      const risks = await proxySigned('GET', '/fapi/v2/positionRisk', {});
      const arr = Array.isArray(risks)?risks:[];
      // 检测持仓模式
      let isHedge = await fetchIsHedgeMode();
      if (isHedge === null) isHedge = false;
      for (const it of arr){
        const symbol = String(it.symbol||'');
        const amt = Number(it.positionAmt||0);
        if (!symbol || !amt) continue;
        const qty = Math.abs(amt);
        const side = amt>0 ? 'SELL' : 'BUY';
        const posSide = amt>0 ? 'LONG' : 'SHORT';
        // 先撤该交易对对应的TP/SL（对冲模式按positionSide过滤）
        try {
          const openOrders = await proxySigned('GET', '/fapi/v1/openOrders', { symbol, recvWindow: 5000 }) || [];
          const tpslTypes = new Set(['TAKE_PROFIT','TAKE_PROFIT_MARKET','STOP','STOP_MARKET','TRAILING_STOP_MARKET']);
          const cancelList = (Array.isArray(openOrders)?openOrders:[]).filter(o=>{
            const t = String(o.type||'').toUpperCase();
            if (!tpslTypes.has(t)) return false;
            if (isHedge) return String(o.positionSide||'').toUpperCase()===posSide;
            return true;
          });
          for (const o of cancelList){
            try { await proxySigned('DELETE','/fapi/v1/order',{ symbol, orderId: o.orderId, recvWindow: 5000 }); } catch(e){}
            await wait(100);
          }
        } catch {}
        // 平仓（reduceOnly；对冲模式附带positionSide）
        const params = { symbol, side, type:'MARKET', quantity: roundStep(qty, qtyStepForSymbol(symbol, true)), recvWindow: 5000 };
        if (isHedge) params.positionSide = posSide;
        // 单向模式才附带 reduceOnly
        if (!isHedge) params.reduceOnly = true;
        await proxySigned('POST', '/fapi/v1/order', params);
        await wait(120);
      }
      setSimStatus('状态：实盘已平所有持仓（并撤销对应TP/SL）');
      return;
    }
    if (act==='set_balance'){
      // 实盘不支持设置余额，忽略
      setSimStatus('状态：实盘模式忽略设置余额');
      return;
    }
  }

  async function execLiveOps(ops){
    if (!Array.isArray(ops) || !ops.length) return;
    // 重用策略约束过滤
    const { validOps, invalidOps } = enforceAiPolicyOnOps(ops);
    if (!validOps.length){ setSimStatus('状态：策略不合规（全部被过滤：禁止限价，需市价+TP/SL）'); return; }
    for (const op of validOps){
      try {
        await execLiveOp(op);
        // 轻微节流，降低快速连续请求导致的漏单/限速风险
        await new Promise(r=>setTimeout(r, 180));
      } catch(e){ setSimStatus(`状态：实盘执行失败：${e?.message||e}`); }
    }
    setSimStatus(`状态：实盘指令已执行（${validOps.length}条，过滤${invalidOps.length}条）`);
  }

  // —— 持久化日志与自动操盘累计时长 ——
  const ORDER_LOG_KEY = 'order_history_log_v1';
  const TRADE_LOG_KEY = 'trade_history_log_v1';
  const AI_CMD_LOG_KEY = 'ai_cmd_exec_log_v1';
  const AUTO_UPTIME_KEY = 'ai_auto_uptime_v1';
  let autoUptimeStart = 0; // 正在计时的起点（0表示未计时）
  let autoUptimeAccum = 0; // 累积毫秒数
  try {
    const u = JSON.parse(localStorage.getItem(AUTO_UPTIME_KEY) || '{}');
    autoUptimeStart = Number(u.start||0) || 0;
    autoUptimeAccum = Number(u.accum||0) || 0;
  } catch {}

  function saveAutoUptime(){
    try { localStorage.setItem(AUTO_UPTIME_KEY, JSON.stringify({ start:autoUptimeStart, accum:autoUptimeAccum })); } catch {}
  }
  function isFullAutoActive(){
    return !!autoTimer && !!autoExecEnabled && !!aiAutoOpsEnabled;
  }
  function fmtDuration(ms){
    if (ms <= 0) return '0分钟';
    const totalMin = Math.floor(ms/60000);
    const d = Math.floor(totalMin / (60*24));
    const h = Math.floor((totalMin % (60*24)) / 60);
    const m = totalMin % 60;
    return `${d}天${h}小时${m}分钟`;
  }
  function autoUptimeText(){
    const runMs = autoUptimeAccum + (isFullAutoActive() && autoUptimeStart ? (Date.now() - autoUptimeStart) : 0);
    return `已执行AI自动操盘${fmtDuration(runMs)}`;
  }
  function recalcAutoUptime(){
    if (isFullAutoActive()){
      if (!autoUptimeStart){ autoUptimeStart = Date.now(); saveAutoUptime(); }
    } else {
      if (autoUptimeStart){ autoUptimeAccum += Math.max(0, Date.now() - autoUptimeStart); autoUptimeStart = 0; saveAutoUptime(); }
    }
  }

  // —— 主题固定为暗色（移除明暗切换相关逻辑） ——
  try {
    // 确保使用暗色变量（不添加 theme-light 类）
    document.documentElement.classList.remove('theme-light');
  } catch{}

  // —— 语言切换与文案 ——
  // —— 语言固定为中文（移除选择与存储） ——
  let lang = 'zh-CN';
  const I18N = {
    'zh-CN': {
      // Global Settings
      settings_title: '全局设置',
      label_theme: '主题',
      btn_theme_dark: '暗色主题',
      btn_theme_light: '明亮主题',
      label_language: '语言',
      lang_zh: '中文',
      lang_en: 'English',

      // AI Interaction
      ai_panel_title: 'AI 交互模块',
      label_choose_ai: '选择AI',
      provider_gemini: 'Gemini 2.5 Flash（免费）',
      provider_openai: 'OpenAI（待定）',
      provider_claude: 'Claude（待定）',
      api_key_placeholder: '粘贴你的API Key',
      btn_save_key: '保存Key',
      label_rule: '策略规则',
      rule_placeholder: '在此输入你的策略规则，例如：短线机会、中长线稳定获利…',
      btn_save_rule: '保存规则',
      btn_clear_rule: '清空',
      btn_opt_prompt: 'AI优化提示词',
      label_history_rule: '历史规则',
      label_data_select: '数据选择',
      btn_select_all: '全选',
      btn_select_none: '全不选',
      btn_send_once: '发送一次',
      min_3: '3分钟',
      min_5: '5分钟',
      min_10: '10分钟',
      min_30: '30分钟',
      min_60: '60分钟',
      ai_status_waiting: '状态：等待中',
      ai_output_placeholder: 'AI输出将在此显示…',
      ai_parse_title: 'AI 建议解析与执行',
      btn_parse_once: '解析并执行一次',
      parse_status_wait: '解析状态：等待',
      parse_status_prefix: '解析状态：',
      ai_ops_log_placeholder: '解析日志将显示在此…',
      ai_cmd_log_title: 'AI 命令执行记录',
      ai_cmd_log_placeholder: '暂无记录…',

      // Dynamic statuses/buttons
      auto_send_on: '定时自动发送：开启',
      auto_send_off: '定时自动发送：关闭',
      auto_exec_on: '跟随AI刷新自动执行：开启',
      auto_exec_off: '跟随AI刷新自动执行：关闭',
      exec_on: '自动执行开启',
      exec_off: '自动执行关闭',
      ai_auto_on: 'AI自动操盘：开启',
      ai_auto_off: 'AI自动操盘：关闭',
      status_prefix: '状态：',
      waiting: '等待中',
      next_auto_send: '下次自动发送',
      last_reply: '最后回复：',
      missing_api_key: '缺少API Key',
      ai_sending: '正在向AI发送…',
      ai_replied: 'AI已回复',
      not_supported_ai: '暂未支持所选AI',
      status_saved_key: '状态：已保存Key',
      opt_ready: '优化状态：就绪',
      opt_missing_key: '优化状态：缺少API Key',
      opt_running: '优化状态：进行中…',
      opt_done: '优化状态：完成',
      opt_no_return: '优化状态：AI无返回或格式不匹配',
      opt_failed: '优化状态：失败',
      // Parse result messages
      parse_failed_prefix: '解析状态：失败（',
      parse_invalid_all: '解析状态：失败（均不合规：禁止限价，需市价+TP/SL）',
      parse_partial_prefix: '解析状态：部分合规（可执行',
      parse_partial_mid: '条；过滤',
      parse_partial_suffix: '条不合规）',
      parse_success_prefix: '解析状态：成功，共 ',
      parse_success_suffix: ' 条',
      parse_manual_exec_prefix: '解析状态：已手动执行（',
      parse_manual_exec_mid: '条，过滤',
      parse_manual_exec_suffix: '条）',

      // Binance status
      ws_connected: 'WS：已连接',
      ws_disconnected: 'WS：未连接',
      api_ok: 'API：正常',
      api_error: 'API：错误',
      api_unknown: 'API：未知',

      // Crypto panel fetch
      panel_fetching: '状态：正在获取数据…',
      panel_updated_ok_html: '状态：<span class="ok">已更新</span>',
      panel_updated_err_html: '状态：<span class="err">错误</span>',
      last_updated_prefix: '最后更新：',
      fetch_error_msg_prefix: '获取数据时出错：',
      fetch_error_tip: '提示：若长时间失败，请稍后再试或检查网络。'
    },
    'en-US': {
      // Global Settings
      settings_title: 'Global Settings',
      label_theme: 'Theme',
      btn_theme_dark: 'Dark Theme',
      btn_theme_light: 'Light Theme',
      label_language: 'Language',
      lang_zh: '中文',
      lang_en: 'English',

      // AI Interaction
      ai_panel_title: 'AI Interaction Module',
      label_choose_ai: 'Choose AI',
      provider_gemini: 'Gemini 2.5 Flash (Free)',
      provider_openai: 'OpenAI (TBD)',
      provider_claude: 'Claude (TBD)',
      api_key_placeholder: 'Paste your API Key',
      btn_save_key: 'Save Key',
      label_rule: 'Strategy Rules',
      rule_placeholder: 'Enter your strategy rules here, e.g., short-term opportunities, mid-to-long-term stability…',
      btn_save_rule: 'Save Rule',
      btn_clear_rule: 'Clear',
      btn_opt_prompt: 'Optimize Prompt',
      label_history_rule: 'Rule History',
      label_data_select: 'Data Selection',
      btn_select_all: 'Select All',
      btn_select_none: 'Select None',
      btn_send_once: 'Send Once',
      min_3: '3 min',
      min_5: '5 min',
      min_10: '10 min',
      min_30: '30 min',
      min_60: '60 min',
      ai_status_waiting: 'Status: Waiting',
      ai_output_placeholder: 'AI output will appear here…',
      ai_parse_title: 'AI Suggestion Parse & Execute',
      btn_parse_once: 'Parse & Execute Once',
      parse_status_wait: 'Parse Status: Waiting',
      parse_status_prefix: 'Parse Status: ',
      ai_ops_log_placeholder: 'Parse log will appear here…',
      ai_cmd_log_title: 'AI Command Execution Log',
      ai_cmd_log_placeholder: 'No records…',

      // Dynamic statuses/buttons
      auto_send_on: 'Auto Send: On',
      auto_send_off: 'Auto Send: Off',
      auto_exec_on: 'Auto Execute on AI refresh: On',
      auto_exec_off: 'Auto Execute on AI refresh: Off',
      exec_on: 'Auto execute ON',
      exec_off: 'Auto execute OFF',
      ai_auto_on: 'AI Auto Trading: ON',
      ai_auto_off: 'AI Auto Trading: OFF',
      status_prefix: 'Status: ',
      waiting: 'Waiting',
      next_auto_send: 'Next auto send',
      last_reply: 'Last reply: ',
      missing_api_key: 'Missing API Key',
      ai_sending: 'Sending to AI…',
      ai_replied: 'AI replied',
      not_supported_ai: 'Selected AI is not supported yet',
      status_saved_key: 'Status: Key saved',
      opt_ready: 'Optimize Status: Ready',
      opt_missing_key: 'Optimize Status: Missing API Key',
      opt_running: 'Optimize Status: Running…',
      opt_done: 'Optimize Status: Done',
      opt_no_return: 'Optimize Status: No return or format mismatch',
      opt_failed: 'Optimize Status: Failed',
      // Parse result messages
      parse_failed_prefix: 'Parse Status: Failed (',
      parse_invalid_all: 'Parse Status: Failed (All invalid: No limit orders; require market + TP/SL)',
      parse_partial_prefix: 'Parse Status: Partially valid (executable ',
      parse_partial_mid: '; filtered ',
      parse_partial_suffix: ' invalid)',
      parse_success_prefix: 'Parse Status: Success, total ',
      parse_success_suffix: '',
      parse_manual_exec_prefix: 'Parse Status: Executed manually (',
      parse_manual_exec_mid: ', filtered ',
      parse_manual_exec_suffix: ')',

      // Binance status
      ws_connected: 'WS: Connected',
      ws_disconnected: 'WS: Disconnected',
      api_ok: 'API: OK',
      api_error: 'API: Error',
      api_unknown: 'API: Unknown',

      // Crypto panel fetch
      panel_fetching: 'Status: Fetching data…',
      panel_updated_ok_html: 'Status: <span class="ok">Updated</span>',
      panel_updated_err_html: 'Status: <span class="err">Error</span>',
      last_updated_prefix: 'Last updated: ',
      fetch_error_msg_prefix: 'Error fetching data: ',
      fetch_error_tip: 'Tip: If failures persist, try later or check the network.'
    }
  };
  function tr(key){ const d = I18N[lang] || I18N['zh-CN']; return d[key] ?? key; }
  function applyLang(){
    try {
      document.querySelectorAll('[data-i18n]').forEach(el => {
        const k = el.getAttribute('data-i18n');
        if (k) el.textContent = tr(k);
      });
      document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
        const k = el.getAttribute('data-i18n-placeholder');
        if (k) el.setAttribute('placeholder', tr(k));
      });
      // Buttons reflecting runtime state
      const autoSendBtn = document.getElementById('autoSendBtn');
      if (autoSendBtn) autoSendBtn.textContent = tr((autoTimer?'auto_send_on':'auto_send_off'));
      const autoExecBtn = document.getElementById('autoExecBtn');
      if (autoExecBtn) autoExecBtn.textContent = tr((autoExecEnabled?'auto_exec_on':'auto_exec_off'));
      // Initial AI status placeholder
      const aiStatusEl = document.getElementById('aiStatus');
      if (aiStatusEl) aiStatusEl.textContent = tr('ai_status_waiting');
    } catch{}
  }
  // 移除 setLang，语言固定为中文

  // 通用本地日志追加
  function pushLocalLog(key, line){
    try {
      const arr = JSON.parse(localStorage.getItem(key) || '[]');
      const tsStr = new Date().toLocaleString();
      const withTs = /^\s*\[[^\]]+\]/.test(line) ? line : `[${tsStr}] ${line}`;
      arr.push(withTs);
      // 简单限制大小，避免localStorage过大（保留最近10000条）
      const trimmed = arr.slice(-10000);
      localStorage.setItem(key, JSON.stringify(trimmed));
    } catch {}
  }

  function updateBinanceStatus(){
    if (!topbarEls.status && !bottombarEls.status) return;
    const apiStr = lastApiErr > lastApiOk
      ? `${tr('api_error')} ${new Date(lastApiErr).toLocaleTimeString()}`
      : (lastApiOk ? `${tr('api_ok')} ${new Date(lastApiOk).toLocaleTimeString()}` : tr('api_unknown'));
    const wsStr = binanceWsConnected ? tr('ws_connected') : tr('ws_disconnected');
    if (topbarEls.status){
      topbarEls.status.textContent = `${wsStr}｜${apiStr}`;
      try { topbarEls.status.className = `value ${binanceWsConnected ? 'ok' : 'err'}`; } catch {}
    }
    if (bottombarEls.status){
      bottombarEls.status.textContent = `${wsStr}｜${apiStr}`;
      try { bottombarEls.status.className = `value ${binanceWsConnected ? 'ok' : 'err'}`; } catch {}
    }
  }

  // —— 通用：表格行选中绑定 ——
  function bindRowSelection(tableEl){
    try {
      const tbody = tableEl?.querySelector('tbody');
      if (!tbody) return;
      tbody.addEventListener('click', (e)=>{
        if (e.target.closest('.action-link')) return; // 操作链接不触发行选中
        const tr = e.target.closest('tr');
        if (!tr) return;
        const selected = tr.classList.contains('selected');
        tbody.querySelectorAll('tr.selected').forEach(r=>r.classList.remove('selected'));
        tr.classList.toggle('selected', !selected);
      });
    } catch{}
  }

  function renderTopbar(){
    ['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','DOGEUSDT','XRPUSDT'].forEach(s=>{
      const el = topbarEls[s];
      if (!el) return;
      const p = latestPriceMap[s];
      el.textContent = fmt(p, decimalsForSymbol(s));
    });
  }

  function renderBottombar(){
    ['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','DOGEUSDT','XRPUSDT'].forEach(s=>{
      const el = bottombarEls[s];
      if (!el) return;
      const p = latestPriceMap[s];
      el.textContent = fmt(p, decimalsForSymbol(s));
    });
  }

  const fmt = (n, d = 4) => {
    if (n === undefined || n === null || Number.isNaN(n)) return '—';
    return Number(n).toLocaleString('zh-CN', {
      minimumFractionDigits: d,
      maximumFractionDigits: d,
    });
  };

  // 按交易对控制价格显示的小数位（避免低价币被四舍五入丢精度）
  function decimalsForSymbol(symbol){
    const s = String(symbol||'').toUpperCase();
    if (s==='XRPUSDT' || s==='DOGEUSDT') return 5; // 低价币给更高精度
    return 2; // 其他默认两位
  }

  const fmt2 = (n, d = 2) => fmt(n, d);

  function nowStr() {
    const d = new Date();
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0');
    const mi = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}`;
  }

  async function binance(path, params = {}) {
    const qs = new URLSearchParams(params).toString();
    const opts = { cache: 'no-store' };
    for (const base of endpoints) {
      try {
        const url = `${base}${path}${qs ? `?${qs}` : ''}`;
        const res = await fetch(url, opts);
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        return await res.json();
      } catch (_) {
        // 尝试下一个端点
      }
    }
    throw new Error('无法连接币安公共接口');
  }

  // 币安期货（USDⓈ-M 永续）公共接口
  async function binanceFutures(path, params = {}) {
    const qs = new URLSearchParams(params).toString();
    const opts = { cache: 'no-store' };
    for (const base of futuresEndpoints) {
      try {
        const url = `${base}${path}${qs ? `?${qs}` : ''}`;
        const res = await fetch(url, opts);
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        return await res.json();
      } catch (_) {
        // 尝试下一个端点
      }
    }
    throw new Error('无法连接币安期货接口');
  }

  function emaSeries(values, period) {
    if (values.length < period) return [];
    const k = 2 / (period + 1);
    const sma = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
    const out = [sma];
    let prev = sma;
    for (let i = period; i < values.length; i++) {
      prev = values[i] * k + prev * (1 - k);
      out.push(prev);
    }
    return out;
  }

  function rsiLast(values, period = 14) {
    if (values.length <= period) return NaN;
    const deltas = [];
    for (let i = 1; i < values.length; i++) deltas.push(values[i] - values[i - 1]);
    let gain = 0, loss = 0;
    for (let i = 0; i < period; i++) {
      const d = deltas[i];
      if (d >= 0) gain += d; else loss -= d;
    }
    gain /= period; loss /= period || 1e-12;
    let rs = gain / loss;
    let rsi = 100 - 100 / (1 + rs);
    let prevGain = gain, prevLoss = loss;
    for (let i = period; i < deltas.length; i++) {
      const d = deltas[i];
      const g = d > 0 ? d : 0;
      const l = d < 0 ? -d : 0;
      prevGain = (prevGain * (period - 1) + g) / period;
      prevLoss = (prevLoss * (period - 1) + l) / period || 1e-12;
      rs = prevGain / prevLoss;
      rsi = 100 - 100 / (1 + rs);
    }
    return rsi;
  }

  function macdLast(values, fast = 12, slow = 26, signal = 9) {
    if (values.length < slow + signal) return { macd: NaN, signal: NaN, hist: NaN };
    const fastE = emaSeries(values, fast);
    const slowE = emaSeries(values, slow);
    const align = Math.min(fastE.length, slowE.length);
    const macdLine = [];
    for (let i = 0; i < align; i++) {
      macdLine.push(fastE[fastE.length - align + i] - slowE[slowE.length - align + i]);
    }
    const signalE = emaSeries(macdLine, signal);
    const macd = macdLine[macdLine.length - 1];
    const signalLast = signalE[signalE.length - 1];
    return { macd, signal: signalLast, hist: macd - signalLast };
  }

  function pick(list, count) {
    const n = Math.max(0, list.length - count);
    return list.slice(n);
  }

  function buildText(ctx, symbol) {
    const { price, ema20, ema50, rsi7, rsi14, macd, ticker24h, minutePrices, ema20List, ema50List, rsi14List, rsi7List, macdList, fourHour } = ctx;
    const dp = decimalsForSymbol(symbol);

    const lines = [];
    lines.push(`当前价格 = ${fmt(price, dp)}，当前20日均线 = ${fmt(ema20, dp)}`);
    lines.push(`当前MACD = ${fmt2(macd.macd)}，当前RSI（7周期） = ${fmt2(rsi7)}`);
    lines.push(`此外，以下是最新${symbol}的统计与波动指标（自动从币安获取）`);

    lines.push(`24小时统计：最新: ${fmt(ticker24h.lastPrice, dp)} 开盘: ${fmt(ticker24h.openPrice, dp)} 最高: ${fmt(ticker24h.highPrice, dp)} 最低: ${fmt(ticker24h.lowPrice, dp)} 成交量: ${fmt(ticker24h.volume, 2)}`);

    lines.push('');
    lines.push('分钟价格列表（按分钟排列，最早->最新）：');
    lines.push(pick(minutePrices, 20).map(v => fmt(v, dp)).join(', '));

    lines.push('');
    lines.push('EMA 指标（20 周期，最早->最新）：');
    lines.push(pick(ema20List, 16).map(v => fmt(v, dp)).join(', '));
    lines.push('EMA 指标（50 周期，最早->最新）：');
    lines.push(pick(ema50List, 16).map(v => fmt(v, dp)).join(', '));

    lines.push('');
    lines.push('MACD 指标（12/26/9，最早->最新）：');
    lines.push(pick(macdList, 16).map(v => fmt2(v)).join(', '));

    lines.push('');
    lines.push('RSI 指标（7 周期，最早->最新）：');
    lines.push(pick(rsi7List, 16).map(v => fmt2(v)).join(', '));
    lines.push('RSI 指标（14 周期，最早->最新）：');
    lines.push(pick(rsi14List, 16).map(v => fmt2(v)).join(', '));

    lines.push('');
    lines.push('更长期的背景（4 小时时间范围）：');
    lines.push(`20周期EMA: ${fmt(fourHour.ema20, dp)} vs 50周期EMA: ${fmt(fourHour.ema50, dp)}`);
    lines.push(`当前RSI（14周期）: ${fmt2(fourHour.rsi14)}，当前MACD: ${fmt2(fourHour.macd.macd)}，信号: ${fmt2(fourHour.macd.signal)}，柱体: ${fmt2(fourHour.macd.hist)}`);

    return lines.join('\n');
  }

  async function updateFor(symbol, els) {
    const { textId, statusId, lastId } = els;
    const textEl = document.getElementById(textId);
    const statusEl = document.getElementById(statusId);
    const lastEl = document.getElementById(lastId);
    try {
      statusEl.textContent = tr('panel_fetching');

      const [klines1m, klines4h, ticker24h] = await Promise.all([
        // 使用期货永续（USDⓈ-M）数据源
        binanceFutures('/fapi/v1/klines', { symbol, interval: '1m', limit: 600 }),
        binanceFutures('/fapi/v1/klines', { symbol, interval: '4h', limit: 600 }),
        binanceFutures('/fapi/v1/ticker/24hr', { symbol }),
      ]);

      const closes1m = klines1m.map(k => parseFloat(k[4]));
      const closes4h = klines4h.map(k => parseFloat(k[4]));
      const price = closes1m[closes1m.length - 1];

      const ema20List = emaSeries(closes1m, 20);
      const ema50List = emaSeries(closes1m, 50);
      const rsi7List = []; const rsi14List = [];
      for (let i = closes1m.length - 20; i < closes1m.length; i++) {
        const sub = closes1m.slice(0, i + 1);
        rsi7List.push(rsiLast(sub, 7));
        rsi14List.push(rsiLast(sub, 14));
      }
      const macdList = [];
      for (let i = closes1m.length - 20; i < closes1m.length; i++) {
        const sub = closes1m.slice(0, i + 1);
        macdList.push(macdLast(sub).macd);
      }

      const ema20 = ema20List[ema20List.length - 1];
      const ema50 = ema50List[ema50List.length - 1];
      const rsi7 = rsiLast(closes1m, 7);
      const rsi14 = rsiLast(closes1m, 14);
      const macd = macdLast(closes1m);

      const fourHour = {
        ema20: emaSeries(closes4h, 20).slice(-1)[0],
        ema50: emaSeries(closes4h, 50).slice(-1)[0],
        rsi14: rsiLast(closes4h, 14),
        macd: macdLast(closes4h),
      };

      const txt = buildText({
        price,
        ema20, ema50,
        rsi7, rsi14,
        macd,
        ticker24h,
        minutePrices: closes1m,
        ema20List, ema50List,
        rsi14List, rsi7List,
        macdList,
        fourHour,
      }, symbol);

      textEl.textContent = txt;
      latestTextMap[symbol] = txt;
      latestPriceMap[symbol] = price;
      lastApiOk = Date.now();
      renderTopbar();
      try { renderBottombar(); } catch{}
      updateBinanceStatus();
      statusEl.innerHTML = tr('panel_updated_ok_html');
      lastEl.textContent = `${tr('last_updated_prefix')}${nowStr()}`;
    } catch (err) {
      statusEl.innerHTML = tr('panel_updated_err_html');
      const msg = `${tr('fetch_error_msg_prefix')}${err?.message || err}\n\n${tr('fetch_error_tip')}`;
      const textEl = document.getElementById(textId);
      textEl.textContent = msg;
      lastApiErr = Date.now();
      updateBinanceStatus();
    }
  }

  // 启动两个币种的定时更新
  function start(symbol, els, intervalMs = 10_000) {
    updateFor(symbol, els);
    setInterval(() => updateFor(symbol, els), intervalMs);
  }

  start('BTCUSDT', { textId: 'textBox', statusId: 'status', lastId: 'lastUpdated' });
  start('ETHUSDT', { textId: 'textBoxEth', statusId: 'statusEth', lastId: 'lastUpdatedEth' });
  start('SOLUSDT', { textId: 'textBoxSol', statusId: 'statusSol', lastId: 'lastUpdatedSol' });
  start('BNBUSDT', { textId: 'textBoxBnb', statusId: 'statusBnb', lastId: 'lastUpdatedBnb' });
  start('DOGEUSDT', { textId: 'textBoxDoge', statusId: 'statusDoge', lastId: 'lastUpdatedDoge' });
  start('XRPUSDT', { textId: 'textBoxXrp', statusId: 'statusXrp', lastId: 'lastUpdatedXrp' });

  // ===== AI 交互模块逻辑 =====
  const providerEl = document.getElementById('aiProvider');
  if (providerEl) {
    // 移除主题/语言事件绑定，直接应用中文文案
    applyLang();
    const apiKeyEl = document.getElementById('apiKey');
    const saveKeyBtn = document.getElementById('saveKeyBtn');
    const ruleEl = document.getElementById('ruleInput');
    const saveRuleBtn = document.getElementById('saveRuleBtn');
    const clearRuleBtn = document.getElementById('clearRuleBtn');
    const optPromptBtn = document.getElementById('optPromptBtn');
    const optPromptStatusEl = document.getElementById('optPromptStatus');
    const ruleListEl = document.getElementById('ruleHistoryList');
    const selectAllBtn = document.getElementById('selectAllBtn');
    const selectNoneBtn = document.getElementById('selectNoneBtn');
    const dataGroupEl = document.getElementById('dataSelectGroup');
    const sendOnceBtn = document.getElementById('sendOnceBtn');
    const autoSendBtn = document.getElementById('autoSendBtn');
    const statusEl = document.getElementById('aiStatus');
    const outputEl = document.getElementById('aiOutput');
    // 解析与执行控制（第二列）
    const parseOnceBtn = document.getElementById('parseOnceBtn');
    const autoExecBtn = document.getElementById('autoExecBtn');
    const aiOpsStatusEl = document.getElementById('aiOpsStatus');
    const aiOpsLogEl = document.getElementById('aiOpsLog');
    const aiCmdLogView = document.getElementById('aiCmdLog');
    // 初始化AI命令执行记录视图（最近200条）
    if (aiCmdLogView){
      try {
    const arr = JSON.parse(localStorage.getItem(AI_CMD_LOG_KEY) || '[]');
    aiCmdLogView.textContent = (arr.slice(-200).reverse().join('\n\n')) || tr('ai_cmd_log_placeholder');
      } catch {}
    }

    function extractOpsFromText(text){
      if (!text || typeof text!=='string') return { ops: [], errors: ['空文本'] };
      let jsonStr = '';
      const m = text.match(/```json\s*([\s\S]*?)```/i) || text.match(/```\s*([\s\S]*?)```/);
      if (m) jsonStr = m[1];
      else {
        const m2 = text.match(/\{[\s\S]*"ops"[\s\S]*\}/);
        if (m2) jsonStr = m2[0];
      }
      if (!jsonStr) return { ops: [], errors: ['未找到JSON指令块（```json ... ```）'] };
      try {
        const obj = JSON.parse(jsonStr);
        const ops = Array.isArray(obj?.ops) ? obj.ops : (Array.isArray(obj) ? obj : []);
        return { ops, errors: [] };
      } catch (e) {
        return { ops: [], errors: ['JSON解析失败：'+(e?.message||e)] };
      }
    }

    function formatOpsPreview(ops){
      if (!ops?.length) return '（无可执行指令）';
      return ops.map((op, i)=>{
        const typeStr = String(op.type||'').toLowerCase();
        const isLimit = typeStr === 'limit';
        const tpVal = (op?.sl_tp && op.sl_tp.tp!=null) ? op.sl_tp.tp : op.tp;
        const slVal = (op?.sl_tp && op.sl_tp.sl!=null) ? op.sl_tp.sl : op.sl;
        const parts = [ `${i+1}. ${op.action} ${op.symbol||''} ${op.side||''} ${typeStr}` ];
        if (isLimit) parts.push(`price=${op.price??'—'}`);
        parts.push(`qty=${op.qty??'—'}`);
        parts.push(`lev=${op.lev??'—'}`);
        parts.push(`tp=${tpVal??'—'}`);
        parts.push(`sl=${slVal??'—'}`);
        return parts.join(' ');
      }).join('\n');
    }

    // 后台策略约束（来源：config.json -> /config）
    function enforceAiPolicyOnOps(ops){
      const invalidOps = [];
      const validOps = [];
      const arr = Array.isArray(ops) ? ops : [];
      arr.forEach((op, i) => {
        const act = String(op?.action||'').toLowerCase();
        if (act === 'open'){
          const type = (op?.type==='limit') ? 'limit' : 'market';
          const tp = Number(op?.sl_tp?.tp || op?.tp || '') || null;
          const sl = Number(op?.sl_tp?.sl || op?.sl || '') || null;
          const reasons = [];
          if (type!=='market' && type!=='limit') reasons.push('类型不支持');
          if (type==='market' && !aiPolicy.allowMarket) reasons.push('禁止市价');
          if (type==='limit' && !aiPolicy.allowLimit) reasons.push('禁止限价');
          if (aiPolicy.requireSlForOpen && sl === null) reasons.push('必须提供SL（止损）');
          if (aiPolicy.requireTpForOpen && tp === null) reasons.push('必须提供TP（止盈）');
          if (reasons.length) invalidOps.push({ index: i, op, reasons });
          else validOps.push(op);
        } else {
          // 非开仓动作（close/cancel_all/close_all/set_balance）默认合规
          validOps.push(op);
        }
      });
      return { validOps, invalidOps };
    }

    function onAiOutputUpdated(out){
      const { ops, errors } = extractOpsFromText(out);
      if (errors.length){
        aiOpsStatusEl && (aiOpsStatusEl.textContent = `${tr('parse_failed_prefix')}${errors[0]}）`);
        aiOpsLogEl && (aiOpsLogEl.textContent = out || '');
        return;
      }
      const pol = enforceAiPolicyOnOps(ops);
      const validOps = pol.validOps || [];
      const invalidOps = pol.invalidOps || [];
      if (!validOps.length){
        aiOpsStatusEl && (aiOpsStatusEl.textContent = tr('parse_invalid_all'));
        aiOpsLogEl && (aiOpsLogEl.textContent = formatOpsPreview(ops));
        return;
      }
      const statusMsg = invalidOps.length
        ? `${tr('parse_partial_prefix')}${validOps.length}${tr('parse_partial_mid')}${invalidOps.length}${tr('parse_partial_suffix')}`
        : `${tr('parse_success_prefix')}${validOps.length}${tr('parse_success_suffix')}`;
      aiOpsStatusEl && (aiOpsStatusEl.textContent = statusMsg);
      aiOpsLogEl && (aiOpsLogEl.textContent = formatOpsPreview(validOps));
      // 自动执行：需两侧开关均开启；只执行合规部分
      if (autoExecEnabled && aiAutoOpsEnabled && validOps.length){
        try {
          const lines = [`[${nowStr()}] 自动执行：${validOps.length}条（过滤${invalidOps.length}条不合规）`, ...validOps.map(o=>`  - 执行 ${JSON.stringify(o)}`)];
          if (invalidOps.length){
            lines.push('  - 跳过不合规：');
            invalidOps.forEach(it=>{ lines.push(`    [第${it.index+1}条] ${JSON.stringify(it.op)} ｜ 原因：${it.reasons.join('，')}`); });
          }
          pushLocalLog(AI_CMD_LOG_KEY, lines.join('\n'));
          if (aiCmdLogView) {
            const arr = JSON.parse(localStorage.getItem(AI_CMD_LOG_KEY) || '[]');
            aiCmdLogView.textContent = arr.slice(-200).reverse().join('\n\n') || tr('ai_cmd_log_placeholder');
          }
        } catch {}
        // 实盘优先：若已开启实盘则调用真实执行器，否则走模拟
        try {
          if (liveEnabled && window.execLiveOps) window.execLiveOps(validOps);
          else window.execSimOps && window.execSimOps(validOps);
        } catch{}
      }
    }

    function toggleAutoExec(){
      autoExecEnabled = !autoExecEnabled;
      if (autoExecBtn) autoExecBtn.textContent = tr(autoExecEnabled ? 'auto_exec_on' : 'auto_exec_off');
      // 显示开关视觉状态
      try {
        if (autoExecBtn){
          autoExecBtn.classList.toggle('toggle-on', !!autoExecEnabled);
          autoExecBtn.classList.toggle('toggle-off', !autoExecEnabled);
        }
      } catch{}
      if (aiOpsStatusEl) aiOpsStatusEl.textContent = `${tr('parse_status_prefix')}${autoExecEnabled ? tr('exec_on') : tr('exec_off')}`;
      recalcAutoUptime();
    }

    // 本地存储键名
    const KEY_STORAGE = 'ai_api_key';
    const RULES_STORAGE = 'ai_rules_history';

    // 加载与显示历史规则
    function loadRuleHistory() {
      let hist = [];
      try { hist = JSON.parse(localStorage.getItem(RULES_STORAGE) || '[]'); } catch {}
      ruleListEl.innerHTML = '';
      hist.slice().reverse().forEach((item, idx) => {
        const li = document.createElement('li');
        li.textContent = `${new Date(item.ts).toLocaleString()} - ${item.text.slice(0, 48)}…`;
        li.title = item.text;
        li.addEventListener('click', () => { ruleEl.value = item.text; });
        ruleListEl.appendChild(li);
      });
    }
    function saveRule() {
      const text = (ruleEl.value || '').trim();
      if (!text) return;
      let hist = [];
      try { hist = JSON.parse(localStorage.getItem(RULES_STORAGE) || '[]'); } catch {}
      hist.push({ ts: Date.now(), text });
      localStorage.setItem(RULES_STORAGE, JSON.stringify(hist).slice(0, 200000));
      loadRuleHistory();
    }

    // API Key 存取
    function loadKey() {
      try { apiKeyEl.value = localStorage.getItem(KEY_STORAGE) || ''; } catch {}
    }
    function saveKey() {
      try { localStorage.setItem(KEY_STORAGE, apiKeyEl.value || ''); } catch {}
      statusEl.textContent = tr('status_saved_key');
      setTimeout(() => statusEl.textContent = tr('ai_status_waiting'), 1200);
    }

    // 选择数据的交易对
    function selectedSymbols() {
      return Array.from(dataGroupEl.querySelectorAll('input[type="checkbox"]:checked')).map(c => c.value);
    }

    // 模拟盘快照：供AI提示词使用（移动到此处以修复作用域问题）
    function buildSimSummary() {
      let s = {};
      try { s = JSON.parse(localStorage.getItem('sim_contract_v1') || '{}'); } catch {}
      const positions = s.positions || {};
      const orders = s.openOrders || [];
      const trades = s.trades || [];
      const initial = Number((s.account && s.account.initialBalance) || 10000);

      function upnlFor(symbol, pos){
        const mp = latestPriceMap[symbol];
        if (!pos || !pos.qty || !isFinite(mp)) return null;
        const qtyAbs = Math.abs(pos.qty);
        if (pos.qty>0) return qtyAbs * (mp - pos.entryPrice);
        return qtyAbs * (pos.entryPrice - mp);
      }
      function usedMargin(pos){
        if (!pos || !pos.qty || !pos.lev) return 0;
        return (Math.abs(pos.qty) * pos.entryPrice) / Math.max(1, pos.lev);
      }

      let upnl = 0, used = 0, reserved = 0, rpnl = 0;
      Object.entries(positions).forEach(([sym, pos])=>{
        const u = upnlFor(sym, pos);
        if (u!==null) upnl += Number(u||0);
        used += usedMargin(pos);
      });
      orders.forEach(o=>{
        const kind = o.kind || 'NORMAL';
        if (o.type==='limit' && kind==='NORMAL'){
          const r = Number(o.reservedMargin || ((Number(o.price)||0) * (Number(o.qty)||0) / Math.max(1, Number(o.lev)||1)));
          reserved += r;
        }
      });
      rpnl = trades.reduce((sum,t)=> sum + (Number(t.realizedPnl)||0), 0);
      const equity = initial + rpnl + upnl;
      const balance = equity - used - reserved;
      const avail = Math.max(0, balance);

      const lines = [];
      lines.push('【账户状态（模拟盘）】');
      lines.push(`初始余额: ${fmt(initial,2)} 权益: ${fmt(equity,2)} 余额: ${fmt(balance,2)} 可用保证金: ${fmt(avail,2)} 已用保证金: ${fmt(used,2)} 保留保证金: ${fmt(reserved,2)} 未实现盈亏: ${fmt(upnl,2)} 已实现盈亏: ${fmt(rpnl,2)}`);
      lines.push('');
      lines.push('【持仓（净仓）】');
      const posList = Object.entries(positions).filter(([,p])=> p && p.qty);
      if (!posList.length) {
        lines.push('（无持仓）');
      } else {
        posList.forEach(([sym, p])=>{
          const side = p.qty>0 ? '多' : '空';
          const qtyAbs = Math.abs(p.qty);
          const u = upnlFor(sym, p);
          lines.push(`${sym} ${side} 数量 ${fmt(qtyAbs,4)} 均价 ${fmt(p.entryPrice,2)} 杠杆 ${p.lev}x 未实现盈亏 ${fmt(u,2)}`);
        });
      }
      lines.push('');
      lines.push('【当前委托】');
      const ordList = orders.slice();
      if (!ordList.length) {
        lines.push('（无委托）');
      } else {
        ordList.forEach(o=>{
          const typeText = o.type==='market' ? '市价' : ((o.kind==='TP')?'止盈':(o.kind==='SL')?'止损':'限价');
          lines.push(`${new Date(o.ts).toLocaleString()} ${o.symbol} ${o.side==='long'?'做多':'做空'} ${typeText} ${o.type==='market'?'—':fmt(o.price,2)} 数量 ${fmt(o.qty,4)} 状态 ${o.status||'NEW'}`);
        });
      }
      return lines.join('\n');
    }

    // 实盘快照摘要：含账户费率与预计手续费
    function buildLiveSummary(){
      const acc = latestLiveAccount || {};
      const risks = Array.isArray(latestLiveRisks) ? latestLiveRisks : [];
      const orders = Array.isArray(latestLiveOpenOrders) ? latestLiveOpenOrders : [];
      const balance = Number(acc.totalWalletBalance || acc.totalMarginBalance || 0);
      const equity = Number(acc.totalMarginBalance || balance);
      const upnl = Number(acc.totalUnrealizedProfit || 0);
      const avail = Number(acc.availableBalance || balance);
      // 估算已用保证金：按标记价
      let used = 0;
      risks.forEach(p=>{
        const sym = String(p.symbol||'').toUpperCase();
        const qty = Math.abs(Number(p.positionAmt||0));
        const lev = Math.max(1, Number(p.leverage||1));
        const mp = Number(latestPriceMap[sym] || p.markPrice || p.entryPrice || 0);
        if (qty>0 && mp>0) used += (qty * mp) / lev;
      });
      const maker = isFinite(Number(latestMakerRate)) ? Number(latestMakerRate) : null;
      const taker = isFinite(Number(latestTakerRate)) ? Number(latestTakerRate) : null;
      const fmtRate = (r)=>{ if (!isFinite(Number(r))) return '—'; const v=Number(r); return v<1?`${fmt(v*100,4)}%`:`${fmt(v,4)}%`; };

      const lines = [];
      lines.push('【账户状态（实盘）】');
      lines.push(`权益: ${fmt(equity,2)} 可用保证金: ${fmt(avail,2)} 已用保证金(估算): ${fmt(used,2)} 未实现盈亏: ${fmt(upnl,2)} 手续费率：挂单 ${fmtRate(maker)} ｜ 吃单 ${fmtRate(taker)}`);
      lines.push('');
      lines.push('【持仓（净仓）】');
      const posList = risks.filter(it=> Number(it.positionAmt||0) !== 0);
      if (!posList.length){
        lines.push('（无持仓）');
      } else {
        posList.forEach(it=>{
          const sym = String(it.symbol||'');
          const qtyAbs = Math.abs(Number(it.positionAmt||0));
          const side = (Number(it.positionAmt||0)>0) ? '多' : '空';
          const entry = Number(it.entryPrice||0);
          const lev = Number(it.leverage||1);
          const up = Number(it.unrealizedProfit||0);
          const mp = Number(latestPriceMap[sym] || it.markPrice || entry);
          const usedM = mp>0 ? (qtyAbs * mp) / Math.max(1, lev) : 0;
          const estCloseFee = (isFinite(taker) && mp>0) ? mp * qtyAbs * taker : null;
          const feeText = (estCloseFee!=null) ? `预计平仓手续费(吃单): ${fmt(estCloseFee,4)} USDT` : '手续费未知';
          lines.push(`${sym} ${side} 数量 ${fmt(qtyAbs,4)} 均价 ${fmt(entry,decimalsForSymbol(sym))} 杠杆 ${lev}x 未实现盈亏 ${fmt(up,2)} 保证金 ${fmt(usedM,2)} ｜ ${feeText}`);
        });
      }
      lines.push('');
      lines.push('【当前委托】');
      if (!orders.length){
        lines.push('（无委托）');
      } else {
        orders.forEach(o=>{
          const sym = String(o.symbol||'');
          const type = String(o.type||'').toUpperCase();
          const px = Number(o.price||0);
          const qty = Number(o.origQty||o.quantity||0);
          const rate = (type==='LIMIT' ? maker : taker);
          const estFee = (isFinite(rate) && ((type==='MARKET' && qty>0 && (latestPriceMap[sym]||0)>0) || (type==='LIMIT' && px>0 && qty>0)))
            ? ((type==='LIMIT' ? (px*qty) : (Number(latestPriceMap[sym]||0)*qty)) * rate)
            : null;
          const feeText = (estFee!=null) ? `预计成交手续费: ${fmt(estFee,4)} USDT` : '手续费未知';
          lines.push(`${sym} ${String(o.side||'').toUpperCase()} ${type} 价格 ${fmt(px,decimalsForSymbol(sym))} 数量 ${fmt(qty,4)} 状态 ${String(o.status||'NEW')} ｜ ${feeText}`);
        });
      }
      return lines.join('\n');
    }


  function buildPrompt(ruleText, syms) {
    const lines = [];
    lines.push('你是一名加密市场策略分析AI，请根据给定的规则与数据输出可执行的建议、风险与阈值参数。');
    lines.push('');
    lines.push('【策略规则】');
    lines.push(ruleText || '（未提供规则）');
    lines.push('');
    // 根据模式提供账户与仓位快照（实盘包含手续费信息）
    if (liveEnabled){
      lines.push('【实盘账户与仓位】');
      lines.push(buildLiveSummary());
    } else {
      lines.push('【模拟盘账户与仓位】');
      lines.push(buildSimSummary());
    }
    lines.push('');
    lines.push('【行情数据】');
    if (!syms.length) lines.push('（未选择数据）');
    syms.forEach(s => {
      const t = latestTextMap[s] || '（该交易对的最新数据尚未载入）';
      lines.push(`=== ${s} ===`);
      lines.push(t);
      lines.push('');
    });
    lines.push('输出格式：请用中文给出简洁的交易建议（开/平仓条件、风控、止损止盈），并说明依据。');
    lines.push('');
    lines.push('【机器可读指令（严格JSON）】请在回复末尾追加一个```json 代码块，内容仅为以下结构，不得添加注释或多余字段：');
    lines.push('{"ops": [');
    lines.push('  {"action":"open","symbol":"BTCUSDT","side":"long|short","type":"market|limit","price":110000.0,"qty":0.01,"lev":10,"tp":111000.0,"sl":109000.0},');
    lines.push('  {"action":"close","symbol":"BTCUSDT"},');
    lines.push('  {"action":"cancel_all","symbol":"BTCUSDT"},');
    lines.push('  {"action":"close_all"}');
    lines.push(']}');
    lines.push('```');
    lines.push('字段含义：open为下单（市价可不填price；限价必须填写price；tp/sl可选），close为平指定交易对持仓，cancel_all为撤销该交易对全部委托（不含TP/SL），close_all为平掉所有持仓。若需设置初始余额，追加{"action":"set_balance","initialBalance":10000}。');
    return lines.join('\n');
  }

  // 构建“优化提示词”任务：仅优化用户在策略规则框中的文本
    function buildOptimizePrompt(ruleText, syms) {
      const lines = [];
      lines.push('请仅对下面的“策略规则”文本进行改写与优化，使其更清晰、结构化、可直接用作系统提示词。');
      lines.push('限制：不要添加任何与行情、账户、数据或本系统指令格式相关的额外信息；不要输出分析或示例；保持中文。');
      lines.push('输出：仅返回优化后的文本，并使用```prompt 代码块包裹。');
      lines.push('');
      lines.push('【策略规则（原文）】');
      lines.push(ruleText || '（未提供规则）');
      lines.push('');
      lines.push('只返回一个代码块：');
      lines.push('```prompt');
      lines.push('（在此输出优化后的提示词正文）');
      lines.push('```');
      return lines.join('\n');
    }

    async function optimizePromptOnce(){
      const provider = providerEl.value;
      const apiKey = (apiKeyEl.value || '').trim();
      const ruleText = (ruleEl.value || '').trim();
      const syms = selectedSymbols();
      if (!apiKey) { if (optPromptStatusEl) optPromptStatusEl.textContent = tr('opt_missing_key'); return; }
      if (optPromptStatusEl) optPromptStatusEl.textContent = tr('opt_running');
      try { if (optPromptBtn) optPromptBtn.disabled = true; } catch {}
      try {
        const prompt = buildOptimizePrompt(ruleText, syms);
        let out = '';
        if (provider === 'gemini_flash') out = await callGeminiFlash(apiKey, prompt);
        else throw new Error('暂未支持所选AI');
        // 提取```prompt 块内容作为优化后的提示词
        let optimized = '';
        const m = out.match(/```prompt\s*([\s\S]*?)```/i) || out.match(/```\s*([\s\S]*?)```/);
        optimized = (m ? m[1] : out).trim();
        if (optimized){
          ruleEl.value = optimized;
          // 保存到历史，便于回溯
          try { saveRule(); } catch{}
          if (optPromptStatusEl) optPromptStatusEl.textContent = tr('opt_done');
        } else {
          if (optPromptStatusEl) optPromptStatusEl.textContent = tr('opt_no_return');
        }
      } catch (err) {
        if (optPromptStatusEl) optPromptStatusEl.textContent = `${tr('opt_failed')} (${err?.message || err})`;
      } finally {
        try { if (optPromptBtn) optPromptBtn.disabled = false; } catch {}
        // 不更新下方AI输出框与全局状态
      }
    }

    async function callGeminiFlash(apiKey, prompt) {
      // 参考官方文档使用 v1beta generateContent 与 gemini-2.5-flash 模型
      // https://ai.google.dev/gemini-api/docs/quickstart?hl=zh-cn#java_1
      const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';
      const body = {
        contents: [{ parts: [{ text: prompt }]}],
        generationConfig: { temperature: 0.7 },
      };
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey,
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        // 提供更友好的错误提示
        if (res.status === 404) {
          throw new Error('404 Not Found：请检查模型ID或请求路径是否正确（建议使用 gemini-2.5-flash）');
        }
        if (res.status === 401 || res.status === 403) {
          throw new Error(`${res.status}：密钥无效或权限不足，请在AI Studio重新生成并重试`);
        }
        throw new Error(`${res.status} ${res.statusText}`);
      }
      const data = await res.json();
      const parts = data?.candidates?.[0]?.content?.parts || [];
      const text = parts.map(p => (typeof p.text === 'string' ? p.text : '')).join('\n').trim();
      return text || JSON.stringify(data, null, 2);
    }

    // 自动发送间隔设置（默认3分钟）
    const autoIntervalEl = document.getElementById('autoIntervalSelect');
    let autoIntervalMs = (autoIntervalEl ? Number(autoIntervalEl.value) * 60000 : 180000);
    function currentIntervalMinutes(){
      const v = Number(autoIntervalEl?.value || 3);
      return Number.isFinite(v) && v > 0 ? v : 3;
    }
    function updateAutoIntervalMs(){ autoIntervalMs = currentIntervalMinutes() * 60000; }
    function updateAutoSendBtnText(){
      autoSendBtn.textContent = tr(autoTimer ? 'auto_send_on' : 'auto_send_off');
      try {
        if (autoSendBtn){
          autoSendBtn.classList.toggle('toggle-on', !!autoTimer);
          autoSendBtn.classList.toggle('toggle-off', !autoTimer);
        }
      } catch{}
    }

    // 自动发送倒计时状态管理
    let autoTimer = null;
    let countdownTimer = null;
    let nextRunAt = 0;
    let baseStatusText = tr('waiting');
    let lastAiReplyAt = '';
    function formatCountdown(ms){
      if (ms <= 0) return '00:00';
      const s = Math.floor(ms/1000);
      const mm = String(Math.floor(s/60)).padStart(2,'0');
      const ss = String(s%60).padStart(2,'0');
      return `${mm}:${ss}`;
    }
    function refreshStatus(){
      const hasAuto = !!autoTimer;
      const suffix = hasAuto ? `（${tr('next_auto_send')} ${formatCountdown(Math.max(0, nextRunAt - Date.now()))}）` : '';
      const replySuffix = (baseStatusText||'').includes(tr('ai_replied')) ? `（${tr('last_reply')}${lastAiReplyAt || nowStr()}）` : '';
      statusEl.textContent = `${tr('status_prefix')}${baseStatusText}${replySuffix}${suffix}`;
    }
    function setStatus(text){
      baseStatusText = text || '';
      refreshStatus();
    }

    async function sendOnce() {
      const provider = providerEl.value;
      const apiKey = (apiKeyEl.value || '').trim();
      const ruleText = (ruleEl.value || '').trim();
      const syms = selectedSymbols();
      if (!apiKey) { setStatus(tr('missing_api_key')); return; }
      const prompt = buildPrompt(ruleText, syms);
      setStatus(tr('ai_sending'));
      try { sendOnceBtn.disabled = true; } catch {}
      try {
        let out = '';
        if (provider === 'gemini_flash') out = await callGeminiFlash(apiKey, prompt);
        else throw new Error(tr('not_supported_ai'));
        outputEl.textContent = out;
        // 将最新输出送入解析模块（若开启自动执行则执行）
        try { onAiOutputUpdated(out); } catch{}
        lastAiReplyAt = nowStr();
        setStatus(tr('ai_replied'));
      } catch (err) {
        outputEl.textContent = `AI调用失败：${err?.message || err}`;
        setStatus('错误');
      } finally {
        try { sendOnceBtn.disabled = false; } catch {}
        if (autoTimer) nextRunAt = Date.now() + autoIntervalMs;
        refreshStatus();
      }
    }

    function toggleAuto() {
      if (autoTimer) {
        clearInterval(autoTimer); autoTimer = null;
        if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
        nextRunAt = 0;
        updateAutoSendBtnText();
        setStatus('自动发送已关闭');
        recalcAutoUptime();
        return;
      }
      // 使用所选分钟间隔
      updateAutoIntervalMs();
      autoTimer = setInterval(sendOnce, autoIntervalMs);
      nextRunAt = Date.now() + autoIntervalMs;
      if (!countdownTimer){
        countdownTimer = setInterval(refreshStatus, 1000);
      }
      updateAutoSendBtnText();
      setStatus('自动发送已开启');
      recalcAutoUptime();
    }

    // 绑定事件
    loadKey();
    loadRuleHistory();
    saveKeyBtn.addEventListener('click', saveKey);
    saveRuleBtn.addEventListener('click', saveRule);
    clearRuleBtn.addEventListener('click', () => { ruleEl.value = ''; });
    if (optPromptBtn) optPromptBtn.addEventListener('click', optimizePromptOnce);
    selectAllBtn.addEventListener('click', () => {
      dataGroupEl.querySelectorAll('input[type="checkbox"]').forEach(c => c.checked = true);
    });
    selectNoneBtn.addEventListener('click', () => {
      dataGroupEl.querySelectorAll('input[type="checkbox"]').forEach(c => c.checked = false);
    });
    sendOnceBtn.addEventListener('click', sendOnce);
    autoSendBtn.addEventListener('click', toggleAuto);
    // 当用户更改自动发送间隔时，更新按钮文案并重启计时
    if (autoIntervalEl) autoIntervalEl.addEventListener('change', () => {
      updateAutoIntervalMs();
      updateAutoSendBtnText();
      if (autoTimer) {
        clearInterval(autoTimer);
        autoTimer = setInterval(sendOnce, autoIntervalMs);
        nextRunAt = Date.now() + autoIntervalMs;
        refreshStatus();
      }
    });
    // 初始化按钮文案
    updateAutoSendBtnText();
    // 初始化AI自动操盘互斥状态的按钮样式
    try { setAiMode(aiMode); } catch{}
    // 解析与执行按钮绑定
    if (parseOnceBtn) parseOnceBtn.addEventListener('click', ()=>{
      const out = outputEl?.textContent || '';
      const r = extractOpsFromText(out);
      if (r.errors.length){
        aiOpsStatusEl && (aiOpsStatusEl.textContent = `${tr('parse_failed_prefix')}${r.errors[0]}）`);
        aiOpsLogEl && (aiOpsLogEl.textContent = out || '');
        return;
      }
      const pol = enforceAiPolicyOnOps(r.ops);
      const validOps = pol.validOps || [];
      const invalidOps = pol.invalidOps || [];
      if (!validOps.length){
        aiOpsStatusEl && (aiOpsStatusEl.textContent = tr('parse_invalid_all'));
        aiOpsLogEl && (aiOpsLogEl.textContent = formatOpsPreview(r.ops));
        return;
      }
      const statusMsg = invalidOps.length
        ? `${tr('parse_partial_prefix')}${validOps.length}${tr('parse_partial_mid')}${invalidOps.length}${tr('parse_partial_suffix')}`
        : `${tr('parse_success_prefix')}${validOps.length}${tr('parse_success_suffix')}`;
      aiOpsStatusEl && (aiOpsStatusEl.textContent = statusMsg);
      aiOpsLogEl && (aiOpsLogEl.textContent = formatOpsPreview(validOps));
      // 手动执行一次：不受AI自动操盘总开关限制
      if (validOps.length){
        // 记录到AI命令日志（手动）
        try {
          const lines = [`[${nowStr()}] 手动执行：${validOps.length}条（过滤${invalidOps.length}条不合规）`, ...validOps.map(o=>`  - 执行 ${JSON.stringify(o)}`)];
          if (invalidOps.length){
            lines.push('  - 跳过不合规：');
            invalidOps.forEach(it=>{ lines.push(`    [第${it.index+1}条] ${JSON.stringify(it.op)} ｜ 原因：${it.reasons.join('，')}`); });
          }
          pushLocalLog(AI_CMD_LOG_KEY, lines.join('\n'));
          if (aiCmdLogView) {
            const arr = JSON.parse(localStorage.getItem(AI_CMD_LOG_KEY) || '[]');
            aiCmdLogView.textContent = arr.slice(-200).reverse().join('\n\n');
          }
        } catch {}
        try {
          if (liveEnabled && window.execLiveOps) window.execLiveOps(validOps);
          else window.execSimOps && window.execSimOps(validOps);
        } catch{}
        aiOpsStatusEl && (aiOpsStatusEl.textContent = `${tr('parse_manual_exec_prefix')}${validOps.length}${tr('parse_manual_exec_mid')}${invalidOps.length}${tr('parse_manual_exec_suffix')}`);
      }
    });
    if (autoExecBtn) autoExecBtn.addEventListener('click', toggleAutoExec);
  }

  // ====== 合约模拟盘 ======
  const simEls = {
    symbol: document.getElementById('orderSymbol'),
    side: document.getElementById('orderSide'),
    type: document.getElementById('orderType'),
    price: document.getElementById('orderPrice'),
    qty: document.getElementById('orderQty'),
    lev: document.getElementById('orderLev'),
    tp: document.getElementById('tpPrice'),
    sl: document.getElementById('slPrice'),
    initBalance: document.getElementById('initBalance'),
    saveBalanceBtn: document.getElementById('saveBalanceBtn'),
    placeBtn: document.getElementById('placeOrderBtn'),
    cancelAllBtn: document.getElementById('cancelAllBtn'),
    closePosBtn: document.getElementById('closePosBtn'),
    closeAllBtn: document.getElementById('closeAllBtn'),
    resetBtn: document.getElementById('resetSimBtn'),
    status: document.getElementById('simStatus'),
    posTable: document.getElementById('positionsTable'),
    openOrdersTable: document.getElementById('openOrdersTable'),
    orderHistoryTable: document.getElementById('orderHistoryTable'),
    tradeHistoryTable: document.getElementById('tradeHistoryTable'),
    accBalance: document.getElementById('accBalance'),
    accEquity: document.getElementById('accEquity'),
    accUsedMargin: document.getElementById('accUsedMargin'),
    accAvail: document.getElementById('accAvail'),
    accUpnl: document.getElementById('accUpnl'),
    accRpnl: document.getElementById('accRpnl'),
  };

  if (simEls.status) {
    const STORE_KEY = 'sim_contract_v1';
    const state = {
      // 持仓：净仓模式，每个交易对最多一个持仓（qty>0多，qty<0空）
      positions: {}, // symbol -> { qty, entryPrice, lev }
      // 当前委托（未成交）：数组
      openOrders: [], // { id, ts, symbol, side:'long|short', type:'market|limit', price, qty, lev, status:'NEW', kind:'NORMAL|TP|SL', tp?, sl?, reservedMargin? }
      // 委托历史（含取消与成交完成）：数组
      orderHistory: [], // { id, ts, symbol, side, type, price, qty, result:'FILLED|CANCELED' }
      // 交易历史（成交明细）：数组
      trades: [], // { id, ts, symbol, side, price, qty, realizedPnl }
      // 账户（初始余额）
      account: { initialBalance: 10000 },
    };

    function loadState() {
      try {
        const s = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
        ['positions','openOrders','orderHistory','trades','account'].forEach(k => {
          if (s[k]) state[k] = s[k];
        });
      } catch {}
    }
    function saveState() {
      try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch {}
    }
    loadState();

    function markPrice(symbol) { return latestPriceMap[symbol]; }

    function unrealizedPnl(symbol, pos) {
      const mp = markPrice(symbol);
      if (!mp || !pos || !pos.qty) return null;
      const side = pos.qty > 0 ? 'long' : 'short';
      const qtyAbs = Math.abs(pos.qty);
      if (side === 'long') return qtyAbs * (mp - pos.entryPrice);
      return qtyAbs * (pos.entryPrice - mp);
    }

    function marginUsed(pos) {
      if (!pos || !pos.qty || !pos.lev) return 0;
      const qtyAbs = Math.abs(pos.qty);
      return (pos.entryPrice * qtyAbs) / pos.lev;
    }

    function calcAccount(){
      // 汇总未实现盈亏与保证金
      let upnl = 0, used = 0, reserved = 0, rpnl = 0;
      Object.entries(state.positions).forEach(([symbol, pos])=>{
        if (!pos || !pos.qty) return;
        const u = unrealizedPnl(symbol, pos);
        upnl += Number(u || 0);
        used += marginUsed(pos);
      });
      state.openOrders.forEach(o=>{
        const kind = o.kind || 'NORMAL';
        if (o.type==='limit' && kind==='NORMAL'){
          reserved += (Number(o.price)||0) * (Number(o.qty)||0) / Math.max(1, Number(o.lev)||1);
        }
      });
      rpnl = state.trades.reduce((s,t)=> s + (Number(t.realizedPnl)||0), 0);
      const initial = Number(state.account?.initialBalance || 10000);
      const equity = initial + rpnl + upnl;
      const balance = equity - used - reserved; // 可用 = 余额
      const avail = Math.max(0, balance);
      return { upnl, used, reserved, rpnl, equity, balance, avail };
    }

    function renderAccount(){
      const acc = calcAccount();
      if (simEls.accBalance) simEls.accBalance.textContent = fmt(acc.balance, 2);
      if (simEls.accEquity) simEls.accEquity.textContent = fmt(acc.equity, 2);
      if (simEls.accUsedMargin) simEls.accUsedMargin.textContent = fmt(acc.used, 2);
      if (simEls.accAvail) simEls.accAvail.textContent = fmt(acc.avail, 2);
      if (simEls.accUpnl) simEls.accUpnl.textContent = fmt(acc.upnl, 2);
      if (simEls.accRpnl) simEls.accRpnl.textContent = fmt(acc.rpnl, 2);
    }

    // —— 账户收益曲线（重写：TimeSeriesChart，保留最近1小时） ——
    const balanceCanvas = document.getElementById('balanceChart');
    class TimeSeriesChart {
      constructor(canvas, options = {}){
        this.canvas = canvas;
        this.points = [];
        this.spanMs = Number.isFinite(options.spanMs) ? options.spanMs : (60*60*1000);
        this.label = options.label || '最近1小时';
        this._w = 0; this._h = 0; this._dpr = 1; this.ctx = null;
      }
      _resize(){
        if (!this.canvas) return false;
        const rect = this.canvas.getBoundingClientRect();
        const parentRect = (this.canvas.parentElement && this.canvas.parentElement.getBoundingClientRect()) || { width: 0, height: 0 };
        const dpr = window.devicePixelRatio || 1;
        const wRaw = rect.width || parentRect.width || 0;
        const hRaw = rect.height || parentRect.height || 0;
        const w = Math.max(300, Math.floor(wRaw));
        const h = Math.max(180, Math.floor(hRaw));
        this.canvas.width = Math.floor(w * dpr);
        this.canvas.height = Math.floor(h * dpr);
        const ctx = this.canvas.getContext('2d');
        if (!ctx) return false;
        ctx.reset?.();
        ctx.scale(dpr, dpr);
        this.ctx = ctx; this._w = w; this._h = h; this._dpr = dpr;
        return true;
      }
      addSample(t, v){
        const now = Number(t)||Date.now();
        // 允许字符串带千分位，解析为数值；不再把无效值当作0
        let val;
        if (typeof v === 'number') val = v;
        else if (typeof v === 'string') {
          const s = v.replace(/,/g, '').trim();
          val = Number(s);
        } else val = Number(v);
        if (!Number.isFinite(val)) return; // 跳过无效采样，避免把曲线压成0
        this.points.push({ t: now, v: val });
        const cutoff = now - this.spanMs;
        while (this.points.length && this.points[0].t < cutoff) this.points.shift();
      }
      _fmtTime(ms){ return new Date(ms).toLocaleTimeString([], { hour12:false, hour:'2-digit', minute:'2-digit' }); }
      render(){
        if (!this._resize()) return;
        const ctx = this.ctx; const w = this._w; const h = this._h;
        const css = getComputedStyle(document.documentElement);
        const bg = css.getPropertyValue('--surface-2').trim() || '#1e1e1e';
        const border = css.getPropertyValue('--border').trim() || 'rgba(255,255,255,0.1)';
        const muted = css.getPropertyValue('--muted').trim() || '#aaa';
        const accent = css.getPropertyValue('--accent').trim() || '#ffd54f';
        ctx.fillStyle = bg; ctx.fillRect(0,0,w,h);
        ctx.strokeStyle = border; ctx.lineWidth = 1; ctx.strokeRect(0.5,0.5,w-1,h-1);
        ctx.fillStyle = muted; ctx.font = '12px system-ui';
        try { ctx.fillText(this.label, w - 70, 18); } catch {}
        const leftPad = 52, rightPad = 10, topPad = 8, bottomPad = 26;
        const plotW = w - leftPad - rightPad;
        const plotH = h - topPad - bottomPad;
        const points = this.points.slice();
        const vals = points.map(p=>p.v);
        let minV = vals.length ? Math.min(...vals) : 0;
        let maxV = vals.length ? Math.max(...vals) : 1;
        const pad = (maxV - minV) * 0.1 + 1e-6;
        const yMin = minV - pad, yMax = maxV + pad;
        // y轴
        ctx.strokeStyle = border; ctx.fillStyle = muted; ctx.font = '12px system-ui';
        const yTicks = 4;
        for (let i=0;i<=yTicks;i++){
          const y = topPad + (plotH * i / yTicks);
          const v = yMax - (yMax - yMin) * i / yTicks;
          ctx.beginPath(); ctx.moveTo(leftPad, y); ctx.lineTo(leftPad+plotW, y); ctx.stroke();
          // 改用右对齐并靠近Y轴，避免大数显示被裁切
          try {
            const lab = Number.isFinite(v)
              ? v.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })
              : '—';
            const prevAlign = ctx.textAlign, prevBase = ctx.textBaseline;
            ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
            ctx.fillText(lab, leftPad - 6, y);
            ctx.textAlign = prevAlign; ctx.textBaseline = prevBase;
          } catch {}
        }
        // x轴与数据
        const N = points.length;
        if (N===0){ ctx.fillStyle = muted; ctx.fillText('暂无数据', leftPad+6, topPad+18); return; }
        const step = N>1 ? plotW / (N-1) : 0;
        const tickEvery = N>1 ? Math.max(1, Math.floor(N/6)) : 1;
        if (N>1){
          for (let i=0;i<N;i+=tickEvery){
            const x = leftPad + i*step;
            const prevAlign = ctx.textAlign, prevBase = ctx.textBaseline;
            ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
            ctx.fillText(this._fmtTime(points[i].t), x, h-8);
            ctx.textAlign = prevAlign; ctx.textBaseline = prevBase;
          }
          ctx.strokeStyle = accent; ctx.lineWidth = 2; ctx.beginPath();
          for (let i=0;i<N;i++){
            const x = leftPad + i*step;
            const y = topPad + (yMax - points[i].v) * plotH / (yMax - yMin);
            if (i===0) ctx.moveTo(x,y); else ctx.lineTo(x,y);
          }
          ctx.stroke();
        } else {
          const x = leftPad;
          const y = topPad + (yMax - points[0].v) * plotH / (yMax - yMin);
          ctx.fillStyle = accent; ctx.beginPath(); ctx.arc(x, y, 2.5, 0, Math.PI*2); ctx.fill();
          ctx.fillStyle = muted; ctx.fillText(this._fmtTime(points[0].t), x-24, h-8);
        }
      }
    }

    let balanceChartObj = balanceCanvas ? new TimeSeriesChart(balanceCanvas, { spanMs: 60*60*1000, label: '最近1小时' }) : null;
    // 初始化立即渲染一次（即使没有数据也显示坐标与“暂无数据”）
    try { balanceChartObj && balanceChartObj.render(); } catch {}
    // 监听尺寸变化，保持绘制同步
    try {
      if (balanceCanvas) {
        if (window.ResizeObserver) {
          const ro = new ResizeObserver(()=>{ try { balanceChartObj && balanceChartObj.render(); } catch {} });
          ro.observe(balanceCanvas);
        } else {
          window.addEventListener('resize', ()=>{ try { balanceChartObj && balanceChartObj.render(); } catch {} });
        }
      }
    } catch {}
    // 将可能带逗号的字符串安全转为数值
    function toNumberStrict(x){
      if (typeof x === 'number') return x;
      if (typeof x === 'string') {
        const s = x.replace(/,/g, '').trim();
        const n = Number(s);
        return Number.isFinite(n) ? n : NaN;
      }
      const n = Number(x);
      return Number.isFinite(n) ? n : NaN;
    }
    function sampleBalance(){
      try {
        let eq = NaN;
        if (liveEnabled && latestLiveEquity!=null) eq = toNumberStrict(latestLiveEquity);
        if (!Number.isFinite(eq)) {
          const acc = calcAccount();
          eq = toNumberStrict(acc.equity);
        }
        if (Number.isFinite(eq) && balanceChartObj){ const now = Date.now(); balanceChartObj.addSample(now, eq); balanceChartObj.render(); }
      } catch {}
    }
    // 初次绘制并定时刷新
    setTimeout(sampleBalance, 0);
    setInterval(sampleBalance, 5000);
    // 监听实盘账户刷新通知，及时进行一次采样
    try { window.addEventListener('equity_update', ()=>{ try { sampleBalance(); } catch {} }); } catch {}

    // 状态显示：在尾部附加全自动累计时长
    let _lastSimMsg = '';
    function setSimStatus(msg){
      _lastSimMsg = String(msg||'');
      let display = _lastSimMsg;
      if (display.startsWith('状态：')) display = display.replace('状态：', tr('status_prefix'));
      const tail = isFullAutoActive() ? `（${autoUptimeText()}）` : '';
      simEls.status.textContent = `${display}${tail}`;
    }

    function render() {
      // 持仓表
      const tbodyPos = simEls.posTable.querySelector('tbody');
      tbodyPos.innerHTML = '';
      Object.entries(state.positions).forEach(([symbol, pos]) => {
        if (!pos || !pos.qty) return;
        const tr = document.createElement('tr');
        const side = pos.qty > 0 ? '多' : '空';
        const qtyAbs = Math.abs(pos.qty);
        const upnl = unrealizedPnl(symbol, pos);
        const td = (t)=>{ const el=document.createElement('td'); el.textContent=t; return el; };
        tr.appendChild(td(symbol));
        tr.appendChild(td(side));
        tr.appendChild(td(fmt(qtyAbs, 4)));
        tr.appendChild(td(fmt(pos.entryPrice, decimalsForSymbol(symbol))));
        tr.appendChild(td(`${pos.lev}x`));
        tr.appendChild(td(fmt(upnl, 2)));
        tr.appendChild(td(fmt(marginUsed(pos), 2)));
        const op = document.createElement('td');
        const a = document.createElement('span'); a.className='action-link'; a.textContent='平仓';
        a.addEventListener('click', ()=> closePosition(symbol));
        op.appendChild(a); tr.appendChild(op);
        tbodyPos.appendChild(tr);
      });

      // 当前委托
      const tbodyOpen = simEls.openOrdersTable.querySelector('tbody');
      tbodyOpen.innerHTML = '';
      state.openOrders.forEach(o => {
        const tr = document.createElement('tr');
        const td = (t)=>{ const el=document.createElement('td'); el.textContent=t; return el; };
        tr.appendChild(td(new Date(o.ts).toLocaleString()));
        tr.appendChild(td(o.symbol));
        const kind = o.kind || 'NORMAL';
        const dirText = (kind==='TP' || kind==='SL') ? (o.side==='short' ? '平多' : '平空') : (o.side==='long' ? '多' : '空');
        tr.appendChild(td(dirText));
        const typeText = o.type==='market' ? '市价' : ((o.kind==='TP')?'止盈':(o.kind==='SL')?'止损':'限价');
        tr.appendChild(td(typeText));
        tr.appendChild(td(o.type==='market'?'—':fmt(o.price, decimalsForSymbol(o.symbol))));
        tr.appendChild(td(fmt(o.qty,4)));
        tr.appendChild(td(o.status||'NEW'));
        const op = document.createElement('td');
        const a = document.createElement('span'); a.className='action-link'; a.textContent='撤单';
        a.addEventListener('click', ()=> cancelOrder(o.id));
        op.appendChild(a); tr.appendChild(op);
        tbodyOpen.appendChild(tr);
      });

      // 委托历史已移除：若表格不存在则跳过渲染
      if (simEls.orderHistoryTable) {
        const tbodyHis = simEls.orderHistoryTable.querySelector('tbody');
        tbodyHis.innerHTML='';
        state.orderHistory.slice(-20).reverse().forEach(o=>{
          const tr=document.createElement('tr');
          const td=(t)=>{const el=document.createElement('td'); el.textContent=t; return el;};
          tr.appendChild(td(new Date(o.ts).toLocaleString()));
          tr.appendChild(td(o.symbol));
          const kind = o.kind || 'NORMAL';
          const dirText = (kind==='TP' || kind==='SL') ? (o.side==='short' ? '平多' : '平空') : (o.side==='long' ? '多' : '空');
          const typeText = o.type==='market' ? '市价' : (kind==='TP' ? '止盈' : (kind==='SL' ? '止损' : '限价'));
          tr.appendChild(td(dirText));
          tr.appendChild(td(typeText));
          tr.appendChild(td(fmt(o.price, decimalsForSymbol(o.symbol))));
          tr.appendChild(td(fmt(o.qty,4)));
          tr.appendChild(td(o.result||''));
          tbodyHis.appendChild(tr);
        });
      }

      // 交易历史
      const tbodyTrade = simEls.tradeHistoryTable.querySelector('tbody');
      tbodyTrade.innerHTML='';
      state.trades.slice(-20).reverse().forEach(t=>{
        const tr=document.createElement('tr');
        const td=(x)=>{const el=document.createElement('td'); el.textContent=x; return el;};
        tr.appendChild(td(new Date(t.ts).toLocaleString()));
        tr.appendChild(td(t.symbol));
        tr.appendChild(td(t.side==='long'?'多':'空'));
        tr.appendChild(td(fmt(t.price, decimalsForSymbol(t.symbol))));
        tr.appendChild(td(fmt(t.qty,4)));
        tr.appendChild(td(fmt(t.realizedPnl,2)));
        tbodyTrade.appendChild(tr);
      });

      // 账户信息
      renderAccount();
      // 账户变化后立即采样一次，确保曲线跟随更新
      try { sampleBalance(); } catch {}
    }

    function addOrderHistory(o, result){
      const row = { id:o.id, ts:o.ts, symbol:o.symbol, side:o.side, type:o.type, price:o.price, qty:o.qty, kind:(o.kind||'NORMAL'), result };
      state.orderHistory.push(row);
      try { pushLocalLog(ORDER_LOG_KEY, `[${new Date(row.ts).toLocaleString()}] ${row.symbol} ${row.side} ${row.type} price=${row.price} qty=${row.qty} -> ${row.result}`); } catch {}
    }

    function placeOrder() {
      // 手动输入已移除时，优雅提示
      if (!simEls.symbol || !simEls.side || !simEls.type || !simEls.qty || !simEls.lev) {
        setSimStatus('状态：手动下单功能已移除（请使用AI建议或表格操作）');
        return;
      }
      const symbol = simEls.symbol.value;
      const side = simEls.side.value; // long/short
      const type = simEls.type.value; // market/limit
      const qty = Number(simEls.qty.value);
      const lev = Math.max(1, Math.min(125, Number(simEls.lev.value||10)));
      if (!symbol || !qty || qty<=0) { setSimStatus('状态：请输入有效数量'); return; }
      const id = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
      const ts = Date.now();
      const mp = markPrice(symbol);
      let price = type==='market' ? mp : Number(simEls.price.value);
      if (type==='limit' && (!price || price<=0)) { setSimStatus('状态：限价请输入有效价格'); return; }
      const tp = Number(simEls.tp?.value || '') || null;
      const sl = Number(simEls.sl?.value || '') || null;

      // 保证金校验：若为纯平仓（reduce-only），跳过；否则需要保证金
      const cur = state.positions[symbol] || { qty:0 };
      const reduceOnly = (cur.qty>0 && side==='short' && qty<=Math.abs(cur.qty)) || (cur.qty<0 && side==='long' && qty<=Math.abs(cur.qty));
      const orderMargin = (type==='market' ? (mp||price) : price) * qty / lev;
      if (!reduceOnly){
        const acc = calcAccount();
        if (orderMargin > acc.avail + 1e-9){
          setSimStatus(`状态：保证金不足（需 ${fmt(orderMargin,2)}，可用 ${fmt(acc.avail,2)}）`);
          return;
        }
      }

      const ord = { id, ts, symbol, side, type, price, qty, lev, status:'NEW', kind:'NORMAL', tp, sl };
      if (type==='market') {
        // 立即成交
        fillOrder(ord, mp);
        // 若提供TP/SL，为当前持仓生成自动保护委托（不占用保证金）
        createBracketsForSymbol(symbol, tp, sl);
        addOrderHistory(ord, 'FILLED');
        setSimStatus('状态：市价单已成交');
      } else {
        // 限价保留保证金（仅对普通限价单）
        const reservedMargin = price * qty / lev;
        state.openOrders.push({ ...ord, reservedMargin });
        setSimStatus('状态：限价单已下入委托');
      }
      saveState(); render();
    }

    function cancelOrder(id){
      const idx = state.openOrders.findIndex(o=>o.id===id);
      if (idx>=0){
        const o = state.openOrders[idx];
        state.openOrders.splice(idx,1);
        addOrderHistory(o, 'CANCELED');
        setSimStatus('状态：已撤单');
        saveState(); render();
      }
    }

    function cancelAll(){
      state.openOrders.forEach(o=> addOrderHistory(o,'CANCELED'));
      state.openOrders = [];
      setSimStatus('状态：已撤销全部委托');
      saveState(); render();
    }

    function cancelAllForSymbol(symbol){
      const toCancel = state.openOrders.filter(o=> o.symbol===symbol);
      toCancel.forEach(o=> addOrderHistory(o,'CANCELED'));
      state.openOrders = state.openOrders.filter(o=> o.symbol!==symbol);
      setSimStatus(`状态：已撤销 ${symbol} 委托`);
      saveState(); render();
    }

    function closePosition(symbol){
      const pos = state.positions[symbol];
      if (!pos || !pos.qty) { setSimStatus('状态：当前交易对无持仓'); return; }
      const mp = markPrice(symbol);
      const qtyAbs = Math.abs(pos.qty);
      const side = pos.qty>0?'long':'short';
      const realized = side==='long' ? qtyAbs*(mp-pos.entryPrice) : qtyAbs*(pos.entryPrice-mp);
      // 记录交易
      state.trades.push({ id:`close_${Date.now()}`, ts:Date.now(), symbol, side, price:mp, qty:qtyAbs, realizedPnl:realized });
      // 平仓
      state.positions[symbol] = { qty:0, entryPrice:0, lev:pos.lev };
      setSimStatus('状态：已平仓');
      saveState(); render();
    }

    function closeAll(){
      Object.keys(state.positions).forEach(symbol=> closePosition(symbol));
      setSimStatus('状态：已平所有持仓');
      saveState(); render();
    }

    function fillOrder(ord, execPrice){
      // 更新持仓（净仓合并）
      const cur = state.positions[ord.symbol] || { qty:0, entryPrice:0, lev:ord.lev };
      let qty = cur.qty || 0;
      const qtyChange = ord.side==='long' ? ord.qty : -ord.qty;
      const newQty = qty + qtyChange;
      if (qty===0 || Math.sign(qty)===Math.sign(newQty)){
        // 同向加仓或开新仓：加权均价
        const absOld = Math.abs(qty);
        const absInc = Math.abs(qtyChange);
        const newEntry = absOld+absInc>0 ? ((cur.entryPrice*absOld + execPrice*absInc)/(absOld+absInc)) : execPrice;
        state.positions[ord.symbol] = { qty:newQty, entryPrice:newEntry, lev:ord.lev };
      } else {
        // 反向减仓或反向开仓：先计算平掉部分的实现盈亏
        const closeQty = Math.min(Math.abs(qty), Math.abs(qtyChange));
        const sideOld = qty>0?'long':'short';
        const realized = sideOld==='long' ? closeQty*(execPrice-cur.entryPrice) : closeQty*(cur.entryPrice-execPrice);
        state.trades.push({ id:`fill_${ord.id}`, ts:Date.now(), symbol:ord.symbol, side:sideOld, price:execPrice, qty:closeQty, realizedPnl:realized });
        try { pushLocalLog(TRADE_LOG_KEY, `[${new Date(Date.now()).toLocaleString()}] ${ord.symbol} ${sideOld} price=${execPrice} qty=${closeQty} pnl=${realized}`); } catch {}
        const remain = qty + qtyChange; // 可能为0或反向持仓
        if (remain===0){
          state.positions[ord.symbol] = { qty:0, entryPrice:0, lev:ord.lev };
        } else {
          // 反向开仓：新的均价为成交价
          state.positions[ord.symbol] = { qty:remain, entryPrice:execPrice, lev:ord.lev };
        }
      }
    }

    function createBracketsForSymbol(symbol, tp, sl){
      const pos = state.positions[symbol];
      if (!pos || !pos.qty) return;
      const qtyAbs = Math.abs(pos.qty);
      const baseSide = pos.qty>0 ? 'long' : 'short';
      const closeSide = baseSide==='long' ? 'short' : 'long';
      const now = Date.now();
      if (tp && tp>0){
        state.openOrders.push({ id:`tp_${now}_${Math.random().toString(36).slice(2)}`, ts:now, symbol, side:closeSide, type:'limit', price:tp, qty:qtyAbs, lev:pos.lev, status:'NEW', kind:'TP' });
      }
      if (sl && sl>0){
        state.openOrders.push({ id:`sl_${now}_${Math.random().toString(36).slice(2)}`, ts:now, symbol, side:closeSide, type:'limit', price:sl, qty:qtyAbs, lev:pos.lev, status:'NEW', kind:'SL' });
      }
    }

    function matchOnPrice(symbol){
      const mp = markPrice(symbol);
      if (!mp) return;
      const fills = [];
      state.openOrders.forEach(o=>{
        if (o.symbol!==symbol) return;
        if (o.type!=='limit') return;
        const kind = o.kind || 'NORMAL';
        if (kind==='NORMAL'){
          if (o.side==='long' && mp<=o.price) fills.push(o);
          if (o.side==='short' && mp>=o.price) fills.push(o);
        } else if (kind==='TP'){
          // 止盈：多仓在价>=tp触发（卖出），空仓在价<=tp触发（买入）
          if (o.side==='short' && mp>=o.price) fills.push(o);
          if (o.side==='long' && mp<=o.price) fills.push(o);
        } else if (kind==='SL'){
          // 止损：多仓在价<=sl触发（卖出），空仓在价>=sl触发（买入）
          if (o.side==='short' && mp<=o.price) fills.push(o);
          if (o.side==='long' && mp>=o.price) fills.push(o);
        }
      });
      if (!fills.length) return;
      // 成交并从委托移除
      state.openOrders = state.openOrders.filter(o=> !fills.includes(o));
      fills.forEach(o=>{
        fillOrder(o, mp);
        if ((o.kind||'NORMAL')==='NORMAL'){
          // 普通限价单成交后根据下单时指定的TP/SL生成保护委托
          createBracketsForSymbol(o.symbol, o.tp, o.sl);
        }
        const res = (o.kind==='TP')? 'FILLED(TP)' : (o.kind==='SL')? 'FILLED(SL)' : 'FILLED';
        addOrderHistory(o, res);
      });
      setSimStatus(`状态：撮合成交 ${fills.length} 条@${symbol}`);
      saveState(); render();
    }

    function onUpdateSymbol(symbol){
      matchOnPrice(symbol);
      // 实盘开启时不刷新模拟盘界面，避免覆盖实盘渲染
      if (!liveEnabled) render();
    }

    // 启用期货标记价实时WS，严格按真实行情计算持仓盈亏
    function startFuturesMarkWS(symbols){
      try {
        const streams = symbols.map(s=> `${s.toLowerCase()}@markPrice@1s`).join('/');
        const url = `wss://fstream.binance.com/stream?streams=${streams}`;
        let ws = new WebSocket(url);
        ws.onopen = ()=>{ binanceWsConnected = true; updateBinanceStatus(); };
        ws.onmessage = (ev)=>{
          try {
            const obj = JSON.parse(ev.data);
            const data = obj?.data || obj;
            const sym = (data?.s || data?.symbol || '').toUpperCase();
            const price = Number(data?.p || data?.markPrice || data?.c);
            if (sym && price && isFinite(price)){
              latestPriceMap[sym] = price;
              onUpdateSymbol(sym);
              renderTopbar();
              try { renderBottombar(); } catch{}
            }
          } catch {}
        };
        ws.onerror = ()=>{ binanceWsConnected = false; updateBinanceStatus(); };
        ws.onclose = ()=>{
          binanceWsConnected = false; updateBinanceStatus();
          // 简单重连
          setTimeout(()=> startFuturesMarkWS(symbols), 3000);
        };
      } catch {}
    }

    // 将撮合挂到行情更新钩子（在updateFor内部已更新latestPriceMap）
    const _updateFor = updateFor;
    updateFor = async function(symbol, els){
      await _updateFor(symbol, els);
      try { onUpdateSymbol(symbol); } catch {}
    };

    // 启动 WS 实时标记价（BTC/ETH/SOL/BNB/DOGE/XRP）
    startFuturesMarkWS(['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','DOGEUSDT','XRPUSDT']);

    // 绑定表单交互（兼容移除输入）
    if (simEls.type && simEls.price){
      simEls.type.addEventListener('change', ()=>{
        const isLimit = simEls.type.value==='limit';
        simEls.price.disabled = !isLimit;
      });
    }
    if (simEls.placeBtn) simEls.placeBtn.addEventListener('click', placeOrder);
    if (simEls.cancelAllBtn) simEls.cancelAllBtn.addEventListener('click', cancelAll);
    function getSelectedOrDefaultSymbol(){
      try {
        const tr = simEls.posTable?.querySelector('tbody tr.selected');
        const sym = tr?.children?.[0]?.textContent || '';
        if (sym) return sym;
      } catch {}
      const keys = Object.keys(state.positions||{}).filter(s=> state.positions[s]?.qty);
      return keys[0] || 'BTCUSDT';
    }
    if (simEls.closePosBtn) simEls.closePosBtn.addEventListener('click', ()=>{
      const sym = getSelectedOrDefaultSymbol();
      closePosition(sym);
    });
    simEls.closeAllBtn.addEventListener('click', closeAll);
    simEls.resetBtn.addEventListener('click', ()=>{
      state.positions={}; state.openOrders=[]; state.orderHistory=[]; state.trades=[];
      saveState(); render(); setSimStatus('状态：已重置');
    });

    // 保存初始余额
    if (simEls.saveBalanceBtn){
      simEls.saveBalanceBtn.addEventListener('click', ()=>{
        const val = Number(simEls.initBalance?.value || '') || 10000;
        state.account = state.account || { initialBalance: 10000 };
        state.account.initialBalance = val;
        saveState(); render();
        setSimStatus(`状态：初始余额已设置为 ${fmt(val,2)} USDT`);
      });
    }

    // 模拟盘面板中的自动操盘总开关（放入闭包确保访问内部状态）
    const aiAutoSwitchBtn = document.getElementById('aiAutoSwitchBtn');
    if (aiAutoSwitchBtn){
      aiAutoSwitchBtn.addEventListener('click', ()=>{
        const newMode = (aiMode==='sim') ? 'off' : 'sim';
        setAiMode(newMode);
        setSimStatus(newMode==='sim' ? '状态：AI自动操盘已开启（模拟盘）' : '状态：AI自动操盘已关闭');
      });
    }

    // —— 将AI指令映射到模拟盘执行 ——
    function placeOrderByOp(op){
      const symbol = String(op.symbol||'').toUpperCase();
      const side = op.side==='short' ? 'short' : 'long';
      const type = op.type==='limit' ? 'limit' : 'market';
      const qty = Number(op.qty||0);
      const lev = Math.max(1, Math.min(125, Number(op.lev||10)));
      if (!symbol || !qty || qty<=0) { setSimStatus('状态：指令错误（数量或交易对无效）'); return; }
      const id = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
      const ts = Date.now();
      const mp = markPrice(symbol);
      let price = type==='market' ? mp : Number(op.price||0);
      if (type==='limit' && (!price || price<=0)) { setSimStatus('状态：指令错误（限价需有效价格）'); return; }
      const tp = Number(op.sl_tp?.tp||op.tp||'') || null;
      const sl = Number(op.sl_tp?.sl||op.sl||'') || null;

      // 政策：禁止限价单；市价单必须同时提供TP/SL
      if (type==='limit') { setSimStatus('状态：策略不合规（禁止限价单）'); return; }
      if (type==='market' && (tp===null || sl===null)) { setSimStatus('状态：策略不合规（市价单需TP/SL）'); return; }

      const cur = state.positions[symbol] || { qty:0 };
      const reduceOnly = (cur.qty>0 && side==='short' && qty<=Math.abs(cur.qty)) || (cur.qty<0 && side==='long' && qty<=Math.abs(cur.qty));
      const orderMargin = (type==='market' ? (mp||price) : price) * qty / lev;
      if (!reduceOnly){
        const acc = calcAccount();
        if (orderMargin > acc.avail + 1e-9){
          setSimStatus(`状态：保证金不足（需 ${fmt(orderMargin,2)}，可用 ${fmt(acc.avail,2)}）`);
          return;
        }
      }

      const ord = { id, ts, symbol, side, type, price, qty, lev, status:'NEW', kind:'NORMAL', tp, sl };
      if (type==='market') {
        fillOrder(ord, mp);
        createBracketsForSymbol(symbol, tp, sl);
        addOrderHistory(ord, 'FILLED');
        setSimStatus('状态：AI市价单已成交');
      }
      saveState(); render();
    }

    function execSimOp(op){
      if (!op || !op.action) return;
      const act = String(op.action).toLowerCase();
      if (act==='open') return placeOrderByOp(op);
      if (act==='close' && op.symbol) return closePosition(String(op.symbol).toUpperCase());
      if (act==='close_all') return closeAll();
      if (act==='cancel_all'){
        if (op.symbol) return cancelAllForSymbol(String(op.symbol).toUpperCase());
        return cancelAll();
      }
      if (act==='set_balance'){
        const val = Number(op.initialBalance||op.balance||0);
        if (val>0){ state.account = state.account||{}; state.account.initialBalance = val; saveState(); render(); setSimStatus(`状态：余额设为 ${fmt(val,2)} USDT`); }
        return;
      }
    }

    function execSimOps(ops){
      if (!Array.isArray(ops) || !ops.length) return;
      const { validOps, invalidOps } = enforceAiPolicyOnOps(ops);
      if (!validOps.length){ setSimStatus('状态：策略不合规（全部被过滤：禁止限价，需市价+TP/SL）'); return; }
      validOps.forEach(op=>{ try { execSimOp(op); } catch{} });
      setSimStatus(`状态：AI指令已执行（${validOps.length}条，过滤${invalidOps.length}条）`);
    }

    // 暴露执行器给解析模块（根据实盘开关选择）
    window.execSimOps = execSimOps;
    window.execLiveOps = execLiveOps;

    // 初始化控件与渲染
  if (simEls.type) simEls.type.dispatchEvent(new Event('change'));
  render();
    // 绑定表格选中交互
    bindRowSelection(simEls.posTable);
    bindRowSelection(simEls.openOrdersTable);
    bindRowSelection(simEls.orderHistoryTable);
    bindRowSelection(simEls.tradeHistoryTable);
    // 初始刷新一次状态尾部累计时间；并每分钟更新一次
  try { setSimStatus(simEls.status.textContent || tr('ai_status_waiting')); } catch {}
  setInterval(()=>{ try { setSimStatus(_lastSimMsg); } catch {} }, 60000);

  // 绑定实盘配置交互与后端自动调取
  loadLiveCfg();
  applyBackendCfg();
  if (liveEls.saveBtn) liveEls.saveBtn.addEventListener('click', saveLiveCfg);
  if (liveEls.toggleBtn) liveEls.toggleBtn.addEventListener('click', ()=> setLiveEnabled(!liveEnabled));
  // 交易页默认启用实盘（去掉模拟盘开关）
  try { if (/trading\.html$/i.test(location.pathname)) setLiveEnabled(true); } catch {}
}








})();
