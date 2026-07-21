/* naver.js — 네이버 검색광고 탭 (ad-studio 편입, 메타 코드와 분리).
 * 슬라이스1: 플랫폼 토글 + 서브탭(입찰/제외제안) + 입찰 대시보드 읽기뷰.
 * 실데이터는 /api/naver 프록시. ?navermock=1 이면 목데이터로 UI만 검증.
 * 쓰기(입찰변경)는 다음 슬라이스에서 sb_write_token(Bearer)로 게이트 통과.
 */
(function () {
  'use strict';
  const PROXY = 'https://ozkiz-proxy.vercel.app';
  const MOCK = /[?&]navermock=1/.test(location.search);
  const $ = (sel, root = document) => root.querySelector(sel);
  const el = (html) => { const d = document.createElement('div'); d.innerHTML = html.trim(); return d.firstElementChild; };
  const won = (n) => (n == null ? '-' : Number(n).toLocaleString('ko-KR') + '원');
  const cnt = (n) => Number(n || 0).toLocaleString('ko-KR');
  // 품질지수(1~7단계) → 네이버 대시보드식 7칸 막대. 높을수록 초록.
  function qiBar(g) {
    if (g == null || isNaN(g)) return '<span style="color:var(--muted)">-</span>';
    let s = '';
    for (let n = 1; n <= 7; n++) s += `<span style="display:inline-block;width:4px;height:12px;margin-right:1px;border-radius:1px;background:${n <= g ? 'var(--green)' : 'var(--surface2)'}"></span>`;
    return `<span title="품질지수 ${g}/7" style="display:inline-flex;align-items:center">${s}</span>`;
  }
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const isRunning = (x) => x && x.status === 'ELIGIBLE';        // 운영중(노출가능)
  const statusDot = (x) => isRunning(x) ? '🟢' : '⚪';           // 운영중/정지 표시
  const runningFirst = (a, b) => (isRunning(b) - isRunning(a)) || String(a.name).localeCompare(String(b.name), 'ko');

  // ── API 클라이언트 ────────────────────────────────────────────
  async function api(action, { params, body } = {}) {
    if (MOCK) return mockApi(action, params);
    const qs = new URLSearchParams({ action, ...(params || {}) });
    const opt = { method: 'GET', headers: {} };
    if (body) {
      opt.method = 'POST';
      opt.headers['Content-Type'] = 'application/json';
      opt.body = JSON.stringify(body);
      const t = localStorage.getItem('sb_write_token');
      if (t) opt.headers['Authorization'] = 'Bearer ' + t;
    }
    const r = await fetch(`${PROXY}/api/naver?` + qs.toString(), opt);
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || ('HTTP ' + r.status));
    return data;
  }
  // 읽기 재시도(네이버 rate limit 완화): 실패 시 backoff 후 재시도, 최종 실패는 throw.
  async function apiR(action, opts, tries = 3) {
    for (let t = 0; ; t++) {
      try { return await api(action, opts); }
      catch (e) { if (t >= tries - 1) throw e; await sleep(600 + t * 800); }
    }
  }
  // 동시 실행 개수 제한(호출 폭증 방지). arr을 limit개씩만 병렬 처리.
  async function mapLimit(arr, limit, fn) {
    const ret = new Array(arr.length); let i = 0;
    const worker = async () => { while (i < arr.length) { const idx = i++; ret[idx] = await fn(arr[idx], idx); } };
    await Promise.all(Array.from({ length: Math.min(limit, arr.length || 1) }, worker));
    return ret;
  }

  // ── 렌더 ─────────────────────────────────────────────────────
  // 해시 라우팅(2026-07-16): 네이버 모드는 #naver-{하위탭} 해시를 가짐 → 새로고침·뒤로가기·링크 공유 동작.
  // open/close는 index.html의 routeHash()가 해시 기준으로 호출 (멱등 — isOpen 가드).
  let root, prevActive = null, isOpen = false;
  function open(hash) {
    const m = String(hash || '').match(/^naver-(\w+)$/);
    if (m && SUBTABS.some(t => t.k === m[1])) sub = m[1];
    if (isOpen) { setPlatform(true); render(); return; }
    isOpen = true;
    document.querySelectorAll('main.main > .page').forEach(p => { p.style.display = 'none'; });
    document.querySelectorAll('.nav-item:not(.nv-navitem)').forEach(b => { b.style.display = 'none'; });
    document.querySelectorAll('.nv-navitem').forEach(b => { b.style.display = ''; });
    prevActive = document.querySelector('.nav-item.active:not(.nv-navitem)');
    if (prevActive) prevActive.classList.remove('active');
    const nb = document.getElementById('nav-naver-bid'); if (nb) nb.classList.add('active');
    root.style.display = 'block';
    setPlatform(true);
    render();
  }
  function close() {
    if (!isOpen) return;
    isOpen = false;
    root.style.display = 'none';
    document.querySelectorAll('main.main > .page').forEach(p => { p.style.display = ''; });
    document.querySelectorAll('.nv-navitem').forEach(b => { b.style.display = 'none'; b.classList.remove('active'); });
    document.querySelectorAll('.nav-item:not(.nv-navitem)').forEach(b => { b.style.display = ''; });
    if (prevActive) prevActive.classList.add('active');
    setPlatform(false);
  }
  function setPlatform(naver) {
    const mBtn = $('#pf-meta'), nBtn = $('#pf-naver');
    if (!mBtn || !nBtn) return;
    // 배경은 항상 투명, 선택된 쪽만 실선(accent) 테두리+글자로 표시
    const sel = (b, on) => { b.style.background = 'transparent'; b.style.borderColor = on ? 'var(--accent)' : 'var(--border2)'; b.style.color = on ? 'var(--accent)' : 'var(--muted)'; };
    sel(mBtn, !naver); sel(nBtn, naver);
  }

  // 네이버 · 광고 예산 조정 — 하위탭 3개
  let sub = 'shopbid';
  const SUBTABS = [
    { k: 'shopbid', label: '쇼핑검색 입찰가 조정' },
    { k: 'powerbid', label: '파워링크 입찰가 조정' },
    { k: 'shopneg', label: '쇼핑검색 제외키워드' },
    { k: 'monitor', label: '수집·알림 현황' },
  ];
  function render() {
    root.innerHTML = `
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px">
        <div style="font-size:18px;font-weight:700">네이버 · 광고 예산 조정</div>
        ${MOCK ? '<span style="color:var(--muted);font-size:12px">🧪 목데이터 모드</span>' : ''}
      </div>
      <div style="display:flex;gap:6px;margin-bottom:16px;border-bottom:1px solid var(--border)">
        ${SUBTABS.map(t => `<button class="nv-tab" data-sub="${t.k}" style="padding:8px 16px;border:none;background:transparent;color:${t.k === sub ? 'var(--accent)' : 'var(--muted)'};border-bottom:2px solid ${t.k === sub ? 'var(--accent)' : 'transparent'};cursor:pointer;font-weight:600;font-size:14px;margin-bottom:-1px">${t.label}</button>`).join('')}
      </div>
      <div id="nv-body"></div>`;
    root.querySelectorAll('.nv-tab').forEach(b => b.onclick = () => {
      sub = b.dataset.sub;
      const target = 'naver-' + sub;
      // 해시를 하위탭까지 반영 (같은 해시 재클릭은 hashchange가 없어 직접 렌더)
      if ((location.hash || '').replace(/^#\/?/, '') === target) { render(); return; }
      location.hash = target;
    });
    if (sub === 'shopbid') renderBid();
    else if (sub === 'powerbid') renderPowerBid();
    else if (sub === 'shopneg') renderShopNeg();
    else renderMonitor();
  }

  // ── 입찰가 조정 = 전체 대시보드(B): 운영중 쇼핑 상품 전부, 비용순, 드릴다운 없음 ──
  let dashPaused = false, dashCamp = ''; // dashCamp='' = 전체, 아니면 선택 캠페인만 표시(메뉴형)
  async function renderBid() {
    const body = $('#nv-body'); injectNvCss();
    body.innerHTML = loading('운영중 쇼핑 캠페인·상품 불러오는 중…');
    try {
      const camps = await apiR('get_campaigns');
      const shopCamps = camps.filter(c => c.campaignTp === 'SHOPPING' && (dashPaused || isRunning(c))).sort(runningFirst);
      if (!shopCamps.length) { body.innerHTML = '<div style="color:var(--muted);padding:20px">운영중 쇼핑검색 캠페인이 없어요.</div>'; return; }
      // 구조: 캠페인 → (운영중)그룹 → 상품형=소재 / 브랜드형(SHOPPING_BRAND)=키워드(파워링크식)
      // 동시호출 제한(캠페인 3 · 그룹 4) + 재시도로 네이버 rate limit 회피.
      let structure = await mapLimit(shopCamps, 3, async c => {
        const gs = (await apiR('get_adgroups', { params: { nccCampaignId: c.nccCampaignId } }).catch(() => [])) || [];
        const egs = gs.filter(g => dashPaused || isRunning(g));
        const groups = await mapLimit(egs, 4, async g => {
          if (g.adgroupType === 'SHOPPING_BRAND') { // 브랜드형쇼검 = 키워드 입찰(파워링크와 동일)
            const [kws, extR, adsR] = await Promise.all([
              apiR('get_keywords', { params: { nccAdgroupId: g.nccAdgroupId } }).catch(() => []),
              apiR('get_ad_extensions', { params: { ownerId: g.nccAdgroupId } }).catch(() => []),
              apiR('get_ads', { params: { nccAdgroupId: g.nccAdgroupId } }).catch(() => []),
            ]);
            const kwArr = (kws || []).filter(k => dashPaused || (isRunning(k) && k.userLock !== true));
            return { group: g, isBrand: true, kws: kwArr, exts: Array.isArray(extR) ? extR : (extR.data || []), banner: Array.isArray(adsR) ? adsR : (adsR.data || []) };
          }
          const ads = (await apiR('get_ads', { params: { nccAdgroupId: g.nccAdgroupId } }).catch(() => [])) || [];
          return { group: g, isBrand: false, ads: dashPaused ? ads : ads.filter(a => a.userLock !== true) };
        });
        return { camp: c, groups: groups.filter(x => x.isBrand ? x.kws.length : x.ads.length) };
      });
      // 기본지표+순위: /stats 배치(빠름) → 즉시 렌더. 구매전환(직접)은 뒤에서 채움(progressive)
      structure = structure.filter(s => s.groups.length);
      const ids = structure.flatMap(s => s.groups.flatMap(g => g.isBrand ? g.kws.map(k => k.nccKeywordId) : g.ads.map(a => a.nccAdId)));
      const statsMap = await loadStatsBatch(ids);
      renderDashboard(body, structure, statsMap, null);
      loadPurchase7d().then(p => { if (sub === 'shopbid' && document.getElementById('nvc-dash')) renderDashboard(body, structure, statsMap, p); }).catch(() => {});
    } catch (e) { body.innerHTML = errBox(e); }
  }
  // 기본지표+순위 배치(/stats ids, 90개씩) — AD보고서 대체·빠름. per-id avgRnk/노출/클릭/비용 반환.
  async function loadStatsBatch(ids) {
    if (MOCK) return { 'nad-1': { imp: 5000, clk: 70, cost: 100000, rank: 4.2 }, 'nad-2': { imp: 900, clk: 8, cost: 40000, rank: 6.1 }, 'nad-3': { imp: 200, clk: 2, cost: 3000, rank: 8 }, 'nad-brand': { imp: 17946, clk: 70, cost: 23980, rank: 3.0 }, 'nkw-1': { imp: 3000, clk: 60, cost: 60000, rank: 2.1 }, 'nkw-2': { imp: 800, clk: 15, cost: 40000, rank: 4.5 }, 'nkw-3': { imp: 200, clk: 3, cost: 5000, rank: 7 } };
    // ⚠️ /stats는 한 요청에 동일 타입 ID만 허용(nad·nkw 섞으면 code11001). 타입별로 분리 후 90개씩 청크.
    const map = {}, byType = {}, chunks = [];
    ids.forEach(id => { const t = String(id).split('-')[0]; (byType[t] ||= []).push(id); });
    for (const t in byType) for (let i = 0; i < byType[t].length; i += 90) chunks.push(byType[t].slice(i, i + 90));
    await mapLimit(chunks, 4, async ch => { // 동시 4청크로 제한(rate limit 완화)
      try {
        const r = await apiR('stats', { params: { ids: ch.join(','), fields: JSON.stringify(['impCnt', 'clkCnt', 'salesAmt', 'avgRnk']), timeRange: JSON.stringify({ since: isoAgo(7), until: isoAgo(1) }) } });
        const rows = Array.isArray(r) ? r : (Array.isArray(r.data) ? r.data : []);
        rows.forEach(x => { map[x.id] = { imp: +x.impCnt || 0, clk: +x.clkCnt || 0, cost: +x.salesAmt || 0, rank: +x.avgRnk || 0 }; });
      } catch {}
    });
    return map;
  }

  const pBtn = 'padding:8px 16px;border-radius:10px;border:none;background:var(--accent);color:#fff;cursor:pointer;font-weight:700;font-size:13px';
  const NV_CSS = `
.nvc-tiles{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:14px}
.nvc-tile{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:12px 14px;box-shadow:0 1px 3px rgba(24,23,46,.04)}
.nvc-tile .k{font-size:11px;color:var(--muted);margin-bottom:5px;font-weight:600}
.nvc-tile .v{font-size:19px;font-weight:800;letter-spacing:-.01em}
.nvc-card{display:grid;grid-template-columns:72px minmax(0,1fr) auto;gap:14px;align-items:center;background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:12px 14px;margin-bottom:10px;box-shadow:0 1px 3px rgba(24,23,46,.05);transition:box-shadow .15s}
.nvc-card:hover{box-shadow:0 4px 14px rgba(123,111,232,.10)}
.nvc-thumb{width:72px;height:72px;border-radius:10px;object-fit:cover;background:var(--surface2);border:1px solid var(--border)}
.nvc-title{font-weight:700;font-size:13.5px;line-height:1.35;margin-bottom:5px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.nvc-meta{display:flex;gap:7px;align-items:center;flex-wrap:wrap;color:var(--muted);font-size:12px}
.nvc-chip{background:var(--accent-l);color:var(--accent-d);border-radius:6px;padding:2px 7px;font-weight:700;font-size:11px}
.nvc-metrics{display:grid;grid-template-columns:repeat(4,minmax(54px,auto));gap:7px 16px;margin-top:9px}
.nvc-m .k{font-size:10px;color:var(--muted)} .nvc-m .v{font-size:12.5px;font-weight:700}
.nvc-right{display:flex;flex-direction:column;align-items:flex-end;gap:6px;min-width:172px}
.nvc-roas{font-size:23px;font-weight:900;line-height:1} .nvc-roas small{display:block;font-size:10px;color:var(--muted);font-weight:600;text-align:right;margin-top:2px}
.nvc-bid{display:flex;align-items:center;gap:6px;background:var(--surface2);border-radius:9px;padding:5px 9px;font-size:12px}
.nvc-bid .cur{color:var(--muted);text-decoration:line-through} .nvc-bid .new{font-weight:800;color:var(--accent-d)}
.nvc-d{font-size:10.5px;font-weight:800;padding:1px 6px;border-radius:6px}`;
  function injectNvCss() { if (document.getElementById('nv-css')) return; const s = document.createElement('style'); s.id = 'nv-css'; s.textContent = NV_CSS; document.head.appendChild(s); }
  function renderDashboard(body, structure, statsMap, purchase) {
    const mod = dayModifier(), pending = !purchase;
    nvSuggestions = [];
    let gCost = 0, gConvV = 0, gConvN = 0, prodCount = 0;
    structure.forEach(s => {
      s.groups.forEach(gr => {
        if (gr.isBrand) { // 브랜드형쇼검 = 키워드 입찰(파워링크식)
          gr.items = gr.kws.map(kw => {
            const b = statsMap[kw.nccKeywordId] || { imp: 0, clk: 0, cost: 0, rank: 0 };
            const pc = purchase ? ((purchaseKwCache && purchaseKwCache[kw.nccKeywordId]) || { cnt: 0, val: 0 }) : null;
            const ctr = b.imp ? b.clk / b.imp * 100 : 0, cpc = b.clk ? b.cost / b.clk : 0;
            const roas = (pc && b.cost) ? pc.val / b.cost * 100 : null;
            const grp = kw.useGroupBidAmt === true, cur = grp ? null : Number(kw.bidAmt), hasBid = !grp && Number.isFinite(cur);
            const nb = (!pending && hasBid && kw.userLock !== true && b.cost && roas != null) ? computeBid(cur, roas, mod.mod) : cur;
            if (!pending && hasBid && nb !== cur && kw.userLock !== true) nvSuggestions.push({ kind: 'kw', id: kw.nccKeywordId, adgroupId: kw.nccAdgroupId, cur, nb, name: kw.keyword });
            gCost += b.cost; if (pc) { gConvV += pc.val; gConvN += pc.cnt; } prodCount++;
            return { kw, b, pc, ctr, cpc, roas, cur, nb, pending, grp };
          }).sort((x, y) => y.b.cost - x.b.cost);
          gr.aimp = gr.items.reduce((t, it) => t + it.b.imp, 0); gr.aclk = gr.items.reduce((t, it) => t + it.b.clk, 0);
          gr.arankw = gr.items.reduce((t, it) => t + it.b.rank * it.b.imp, 0);
          gr.acnt = purchase ? gr.items.reduce((t, it) => t + (it.pc ? it.pc.cnt : 0), 0) : null;
          gr.aval = purchase ? gr.items.reduce((t, it) => t + (it.pc ? it.pc.val : 0), 0) : null;
        } else {
          gr.items = gr.ads.map(a => {
            const b = statsMap[a.nccAdId] || { imp: 0, clk: 0, cost: 0, rank: 0 };
            const pc = purchase ? (purchase[a.nccAdId] || { cnt: 0, val: 0 }) : null;
            const ctr = b.imp ? b.clk / b.imp * 100 : 0, cpc = b.clk ? b.cost / b.clk : 0;
            const roas = (pc && b.cost) ? pc.val / b.cost * 100 : null;
            const hasBid = !!(a.adAttr && a.adAttr.bidAmt != null && Number.isFinite(Number(a.adAttr.bidAmt)));
            const cur = hasBid ? Number(a.adAttr.bidAmt) : null;
            const nb = (!pending && hasBid && a.userLock !== true && b.cost && roas != null) ? computeBid(cur, roas, mod.mod) : cur;
            if (!pending && hasBid && nb !== cur && a.userLock !== true) nvSuggestions.push({ kind: 'ad', id: a.nccAdId, cur, nb, name: (a.referenceData && a.referenceData.productTitle) || (a.ad && a.ad.headline) || a.nccAdId });
            gCost += b.cost; if (pc) { gConvV += pc.val; gConvN += pc.cnt; } prodCount++;
            return { a, b, pc, ctr, cpc, roas, cur, nb, pending, hasBid };
          }).sort((x, y) => y.b.cost - x.b.cost);
        }
        gr.total = gr.items.reduce((t, it) => t + it.b.cost, 0);
      });
      s.groups.sort((a, b) => b.total - a.total);
      s.total = s.groups.reduce((t, g) => t + g.total, 0);
    });
    // 캠페인 우선순위: 묶음코드 → 브랜드형 → 인디비주엘 → 나머지(비용순)
    const CAMP_ORDER = ['묶음코드', '브랜드형', '인디비주엘'];
    const campRank = (nm) => { for (let i = 0; i < CAMP_ORDER.length; i++) if ((nm || '').includes(CAMP_ORDER[i])) return i; return CAMP_ORDER.length; };
    structure.sort((a, b) => campRank(a.camp.name) - campRank(b.camp.name) || b.total - a.total);
    const gRoas = gCost ? gConvV / gCost * 100 : 0;
    const totalAll = structure.reduce((t, s) => t + s.total, 0);
    if (dashCamp && !structure.some(s => s.camp.nccCampaignId === dashCamp)) dashCamp = ''; // 사라진 캠페인 선택 방어
    const chipStyle = (on) => `cursor:pointer;padding:4px 10px;border-radius:8px;border:1px solid var(--border2);font-size:12px;font-weight:700;background:${on ? 'var(--accent)' : 'var(--accent-l)'};color:${on ? '#fff' : 'var(--accent-d)'}`;
    const chips = [`<button class="nvf-camp" data-camp="" style="${chipStyle(!dashCamp)}">전체 <span style="opacity:.7">${won(totalAll)}</span></button>`]
      .concat(structure.map(s => `<button class="nvf-camp" data-camp="${s.camp.nccCampaignId}" style="${chipStyle(dashCamp === s.camp.nccCampaignId)}">${esc(s.camp.name)} <span style="opacity:.7">${won(s.total)}</span></button>`)).join('');
    const sections = structure.map(s => s.groups.map(gr => `
      <div class="nvc-gsec" data-camp="${s.camp.nccCampaignId}">
        <div style="display:flex;align-items:center;gap:8px;margin:16px 0 8px;flex-wrap:wrap">
          <span style="font-size:11px;color:var(--muted)">${esc(s.camp.name)}</span>
          <b style="font-size:14px">${statusDot(gr.group)} ${esc(gr.group.name)}</b>
          ${gr.isBrand ? '<span class="nvc-chip" style="background:var(--surface2);color:var(--muted)">브랜드형 · 키워드입찰</span>' : ''}
          <span style="color:var(--muted);font-size:12px">${won(gr.total)} · ${gr.isBrand ? '키워드 ' : ''}${gr.items.length}개</span>
        </div>
        ${gr.isBrand ? brandGroupBody(gr) : gr.items.map(fullCard).join('')}
      </div>`).join('')).join('');
    body.innerHTML = `
      <div class="nvc-tiles">
        <div class="nvc-tile"><div class="k">총비용 (7일)</div><div class="v">${won(gCost)}</div></div>
        <div class="nvc-tile"><div class="k">구매 ROAS <span style="color:var(--muted);font-weight:400">직접</span></div><div class="v" style="color:${pending ? 'var(--muted)' : (gRoas >= 300 ? 'var(--green)' : 'var(--red)')}">${pending ? '<span style="font-size:13px">집계 중…</span>' : (gCost ? Math.round(gRoas) + '%' : '-')}</div></div>
        <div class="nvc-tile"><div class="k">구매 전환</div><div class="v">${pending ? '<span style="color:var(--muted);font-size:13px">집계 중…</span>' : gConvN + '건 · ' + cnt(gConvV) + '원'}</div></div>
        <div class="nvc-tile"><div class="k">상품 · 변경대상</div><div class="v">${prodCount} · <span style="color:var(--accent-d)">${pending ? '…' : nvSuggestions.length}</span></div></div>
      </div>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:8px">
        <input id="nvf-q" placeholder="🔎 상품명 검색" style="padding:7px 10px;border:1px solid var(--border2);border-radius:9px;background:var(--surface);color:var(--text);font-size:13px;min-width:180px">
        <label style="font-size:12px;color:var(--muted);display:flex;align-items:center;gap:4px"><input type="checkbox" id="nvf-changed"> 제안 있는 것만</label>
        <label style="font-size:12px;color:var(--muted);display:flex;align-items:center;gap:4px"><input type="checkbox" id="nvf-paused" ${dashPaused ? 'checked' : ''}> 정지 포함</label>
        <span style="font-size:12px;color:var(--muted)">· ${mod.label} 보정 · 비용 많은 순</span>
        <button id="nvc-applyall" style="${pBtn};margin-left:auto" ${(!pending && nvSuggestions.length) ? '' : 'disabled'}>${pending ? '⏳ 구매전환 집계 중…' : (nvSuggestions.length ? `▶ ${nvSuggestions.length}건 입찰가 반영` : '변경 대상 없음')}</button>
      </div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:6px">${chips}</div>
      <div id="nvc-dash">${sections}</div>
      <div id="nvc-history" style="margin-top:18px;border-top:1px solid var(--border);padding-top:8px"></div>`;
    const q = $('#nvf-q'), ch = $('#nvf-changed');
    const applyFilters = () => {
      const term = (q.value || '').toLowerCase(), onlyCh = ch.checked;
      document.querySelectorAll('.nvc-card[data-title], .nvc-krow[data-title]').forEach(el => {
        el.style.display = ((!term || el.dataset.title.includes(term)) && (!onlyCh || el.dataset.changed === '1')) ? '' : 'none';
      });
      document.querySelectorAll('.nvc-gsec').forEach(sec => {
        const campMatch = !dashCamp || sec.dataset.camp === dashCamp; // 선택 캠페인만(메뉴형)
        const anyVis = [...sec.querySelectorAll('.nvc-card, .nvc-krow')].some(c => c.style.display !== 'none');
        sec.style.display = (campMatch && anyVis) ? '' : 'none';
      });
    };
    if (q) q.oninput = applyFilters; if (ch) ch.onchange = applyFilters;
    document.querySelectorAll('.nvf-camp').forEach(b => b.onclick = () => {
      dashCamp = b.dataset.camp;
      document.querySelectorAll('.nvf-camp').forEach(x => { const on = x.dataset.camp === dashCamp; x.style.background = on ? 'var(--accent)' : 'var(--accent-l)'; x.style.color = on ? '#fff' : 'var(--accent-d)'; });
      applyFilters();
    });
    const pcb = $('#nvf-paused'); if (pcb) pcb.onchange = () => { dashPaused = pcb.checked; renderBid(); };
    const updateApplyBtn = () => { const n = document.querySelectorAll('.nvc-cb:checked').length; const bt = $('#nvc-applyall'); if (bt) { bt.disabled = !n; bt.textContent = n ? `▶ 선택 ${n}건 입찰가 반영` : '선택된 항목 없음'; } };
    document.querySelectorAll('.nvc-cb').forEach(cb => cb.onchange = updateApplyBtn);
    const btn = $('#nvc-applyall'); if (btn) { btn.onclick = () => applyAll(); if (!pending && nvSuggestions.length) updateApplyBtn(); }
    document.querySelectorAll('.nvp-off').forEach(b => b.onclick = () => togglePowerKw(b)); // 브랜드형 키워드 OFF/ON
    document.querySelectorAll('.nv-urlcopy').forEach(b => b.onclick = () => { navigator.clipboard.writeText(b.dataset.url).then(() => { const t = b.textContent; b.textContent = '✓'; setTimeout(() => b.textContent = t, 1200); }); });
    loadBidHistory('shopping', 'nvc-history');
  }
  function fullCard(it) {
    const a = it.a, rd = a.referenceData || {}, adc = a.ad || {}, paused = a.userLock === true, pend = it.pending;
    const d = (it.hasBid && !pend) ? it.nb - it.cur : 0, pct = it.cur ? Math.round(d / it.cur * 100) : 0, changed = !pend && it.hasBid && d !== 0;
    // 소재 종류: 상품형=referenceData / 브랜드형=ad(headline·image·landingUrl)
    const title = rd.productTitle || adc.headline || a.nccAdId;
    const thumb = rd.imageUrl || (adc.image ? (/^https?:/.test(adc.image) ? adc.image : EXT_IMG + adc.image) : '');
    const landing = rd.mallProductUrl || adc.landingUrl || '';
    const meta = [(rd.category3Name || rd.category2Name) ? `<span class="nvc-chip">${esc(rd.category3Name || rd.category2Name)}</span>` : '', !it.hasBid ? '<span class="nvc-chip" style="background:var(--surface2);color:var(--muted)">브랜드형</span>' : '', rd.scoreInfo ? `<span style="color:#E9A23B;font-weight:700">★ ${esc(rd.scoreInfo)}</span>` : '', rd.reviewCountSum ? `<span>리뷰 ${cnt(rd.reviewCountSum)}</span>` : '', rd.lowPrice ? `<span>· ${cnt(rd.lowPrice)}원</span>` : ''].join('');
    const statusPill = `<span style="flex:none;font-size:11px;font-weight:700;padding:2px 9px;border-radius:999px;white-space:nowrap;background:${paused ? 'var(--surface2)' : 'var(--green-l)'};color:${paused ? 'var(--muted)' : 'var(--green)'}">${paused ? '⚪ 정지' : '🟢 노출중'}</span>`;
    const bidHtml = !it.hasBid
      ? '<span style="color:var(--muted);font-size:11px">브랜드형 · 입찰 조정 대상 아님</span>'
      : pend
        ? `<span class="new">${it.cur}원</span><span class="nvc-d" style="background:var(--surface);color:var(--muted)">…</span>`
        : (changed
          ? `<span style="color:var(--muted);font-size:10px">현재</span> <span class="cur">${it.cur}</span> <span style="color:var(--muted)">→</span> <span style="color:var(--accent-d);font-size:10px;font-weight:700">제안</span> <span class="new">${it.nb}원</span> <span class="nvc-d" style="background:${d > 0 ? 'var(--green-l)' : 'var(--red-l)'};color:${d > 0 ? 'var(--green)' : 'var(--red)'}">${d > 0 ? '+' : ''}${pct}%</span> <input type="checkbox" class="nvc-cb" data-id="${a.nccAdId}" checked title="이 제안 반영" style="margin-left:4px;width:16px;height:16px;accent-color:var(--accent);cursor:pointer;vertical-align:middle">`
          : `<span class="new">${it.cur}원</span><span class="nvc-d" style="background:var(--surface);color:var(--muted)">유지</span>`);
    const M = [['순위', it.b.rank ? it.b.rank.toFixed(1) : '-'], ['품질', qiBar(a.nccQi && a.nccQi.qiGrade)], ['노출', cnt(it.b.imp)], ['클릭', cnt(it.b.clk)], ['CTR', it.ctr.toFixed(2) + '%'], ['CPC', won(Math.round(it.cpc))], ['총비용', won(it.b.cost)], ['구매', pend ? '<span style="color:var(--muted)">…</span>' : (it.pc.cnt + '건·' + cnt(it.pc.val))]];
    const roasTxt = pend ? '<span style="color:var(--muted)">…</span>' : (it.b.cost ? Math.round(it.roas) + '%' : '-');
    const roasCol = pend ? 'var(--muted)' : (it.b.cost ? (it.roas >= 300 ? 'var(--green)' : 'var(--red)') : 'var(--muted)');
    return `<div class="nvc-card" data-title="${esc(title.toLowerCase())}" data-changed="${changed ? '1' : '0'}">
      <img class="nvc-thumb" src="${esc(thumb)}" onerror="this.style.opacity=.2">
      <div style="min-width:0">
        <div style="display:flex;align-items:flex-start;gap:8px">
          <div class="nvc-title" style="flex:1;margin-bottom:0">${esc(title)}</div>
          ${statusPill}
        </div>
        <div class="nvc-meta" style="margin-top:5px">${meta}</div>
        ${adc.description ? `<div style="font-size:11.5px;color:var(--muted);margin-top:3px">${esc(adc.description)}</div>` : ''}
        ${landing ? `<div style="font-size:11px;margin-top:2px"><span style="color:var(--muted);font-weight:700">🔗 연결 URL</span> <a href="${esc(landing)}" target="_blank" rel="noopener" style="color:var(--accent-d);text-decoration:none;word-break:break-all">${esc(landing)}</a></div>` : ''}
        <div class="nvc-metrics">${M.map(([k, v]) => `<div class="nvc-m"><div class="k">${k}</div><div class="v">${v}</div></div>`).join('')}</div>
      </div>
      <div class="nvc-right">
        <div class="nvc-roas" style="color:${roasCol}">${roasTxt}<small>구매 ROAS</small></div>
        <div class="nvc-bid" id="nvb-${a.nccAdId}">${bidHtml}</div>
      </div>
    </div>`;
  }
  // 브랜드형쇼검 그룹 = 파워링크식 키워드 테이블(소재 연결URL·확장소재·키워드 입찰·합계)
  function brandGroupBody(gr) {
    const thc = 'padding:6px 8px;font-weight:600;white-space:nowrap';
    const head = `<thead><tr style="color:var(--muted);font-size:11px;text-align:right;border-bottom:1px solid var(--border)">
      <th style="text-align:left;${thc}">키워드</th><th style="${thc}">순위</th><th style="text-align:left;${thc}">품질</th><th style="${thc}">노출</th><th style="${thc}">클릭</th><th style="${thc}">CTR</th><th style="${thc}">CPC</th><th style="${thc}">총비용</th><th style="${thc}">구매(직접)</th><th style="${thc}">ROAS</th><th style="text-align:right;${thc}">입찰가 (현재→제안)</th><th style="${thc}">On/Off</th>
    </tr></thead>`;
    const tf = 'padding:7px 8px;text-align:right;white-space:nowrap;font-weight:700;background:var(--surface2)', pend = gr.acnt == null;
    const foot = `<tfoot><tr style="border-top:2px solid var(--border2)">
      <td style="padding:7px 8px;text-align:left;font-weight:700;background:var(--surface2)">합계 · ${gr.items.length}개</td>
      <td style="${tf}">${gr.aimp ? (gr.arankw / gr.aimp).toFixed(1) : '-'}</td><td style="${tf}"></td>
      <td style="${tf}">${cnt(gr.aimp)}</td><td style="${tf}">${cnt(gr.aclk)}</td>
      <td style="${tf}">${gr.aimp ? (gr.aclk / gr.aimp * 100).toFixed(2) : '0.00'}%</td>
      <td style="${tf}">${won(gr.aclk ? Math.round(gr.total / gr.aclk) : 0)}</td><td style="${tf}">${won(gr.total)}</td>
      <td style="${tf}">${pend ? '…' : (gr.acnt + '건·' + cnt(gr.aval))}</td>
      <td style="${tf};color:${pend ? 'var(--muted)' : (gr.total && gr.aval / gr.total * 100 >= 300 ? 'var(--green)' : 'var(--red)')}">${pend ? '…' : (gr.total ? Math.round(gr.aval / gr.total * 100) + '%' : '-')}</td>
      <td style="${tf}"></td><td style="${tf}"></td>
    </tr></tfoot>`;
    const url = (gr.banner && gr.banner.length) ? `<div style="margin:0 0 8px;padding:8px 10px;background:var(--surface2);border:1px solid var(--border);border-radius:9px"><div style="font-size:11px;color:var(--muted);font-weight:700">소재 · 연결 URL</div>${adPreview(gr.banner)}</div>` : '';
    const ext = (gr.exts && gr.exts.length) ? `<div style="margin:0 0 8px;padding:8px 10px;background:var(--surface2);border:1px solid var(--border);border-radius:9px"><div style="font-size:11px;color:var(--muted);font-weight:700;margin-bottom:4px">확장소재 미리보기</div>${extPreview(gr.exts)}</div>` : '';
    return `${url}${ext}<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:12.5px">${head}<tbody>${gr.items.map(brandKwRow).join('')}</tbody>${foot}</table></div>`;
  }
  function brandKwRow(it) {
    const kw = it.kw, locked = kw.userLock === true, paused = locked || !isRunning(kw), pend = it.pending, grp = it.grp;
    const d = (!pend && !grp) ? it.nb - it.cur : 0, pct = it.cur ? Math.round(d / it.cur * 100) : 0, changed = !pend && !grp && d !== 0;
    const td = 'padding:6px 8px;text-align:right;white-space:nowrap';
    const bidCell = grp ? '<span style="color:var(--muted);font-size:11px">그룹입찰</span>'
      : pend ? '<span style="color:var(--muted)">…</span>'
      : changed ? `<span style="color:var(--muted);text-decoration:line-through">${it.cur}</span><span style="color:var(--muted)"> → </span><span style="font-weight:800;color:var(--accent-d)">${it.nb}원</span> <span class="nvc-d" style="background:${d > 0 ? 'var(--green-l)' : 'var(--red-l)'};color:${d > 0 ? 'var(--green)' : 'var(--red)'}">${d > 0 ? '+' : ''}${pct}%</span> <input type="checkbox" class="nvc-cb" data-id="${esc(kw.nccKeywordId)}" checked title="이 제안 반영" style="width:15px;height:15px;accent-color:var(--accent);cursor:pointer;vertical-align:middle">`
      : `<span style="font-weight:700">${it.cur}원</span> <span style="color:var(--muted);font-size:11px">유지</span>`;
    const roasTxt = pend ? '…' : (it.b.cost ? Math.round(it.roas) + '%' : '-');
    const roasCol = pend ? 'var(--muted)' : (it.b.cost ? (it.roas >= 300 ? 'var(--green)' : 'var(--red)') : 'var(--muted)');
    const buy = pend ? '…' : (it.pc.cnt + '건·' + cnt(it.pc.val));
    return `<tr class="nvc-krow" data-title="${esc((kw.keyword || '').toLowerCase())}" data-changed="${changed ? '1' : '0'}" style="border-top:1px solid var(--border)">
      <td style="padding:6px 8px;text-align:left"><span style="font-size:11px">${paused ? '⚪' : '🟢'}</span> <span style="font-weight:600">${esc(kw.keyword || kw.nccKeywordId)}</span></td>
      <td style="${td}">${it.b.rank ? it.b.rank.toFixed(1) : '-'}</td>
      <td style="padding:6px 8px;text-align:left">${qiBar(kw.nccQi && kw.nccQi.qiGrade)}</td>
      <td style="${td}">${cnt(it.b.imp)}</td><td style="${td}">${cnt(it.b.clk)}</td>
      <td style="${td}">${it.ctr.toFixed(2)}%</td><td style="${td}">${won(Math.round(it.cpc))}</td>
      <td style="${td}">${won(it.b.cost)}</td><td style="${td}">${buy}</td>
      <td style="${td};font-weight:700;color:${roasCol}">${roasTxt}</td>
      <td id="nvb-${esc(kw.nccKeywordId)}" style="${td}">${bidCell}</td>
      <td style="padding:6px 8px;text-align:center"><button class="nvp-off" data-kw="${esc(kw.nccKeywordId)}" data-ag="${esc(kw.nccAdgroupId)}" data-lock="${locked ? '0' : '1'}" style="font-size:11px;padding:2px 10px;border-radius:6px;border:1px solid var(--border2);background:var(--surface);color:${locked ? 'var(--green)' : 'var(--red)'};cursor:pointer;font-weight:700">${locked ? 'ON' : 'OFF'}</button></td>
    </tr>`;
  }

  // 최근 7일 구매전환(장바구니 제외) — AD_CONVERSION 일별 보고서 합산, 계정단위 1회 수집 후 캐시
  let purchaseCache = null;
  // AD_CONVERSION 7일 1회 수집 → 소재키(col5)·키워드키(col4) 두 맵 동시 생성(브랜드형쇼검 키워드 ROAS용). 둘 다 캐시.
  async function loadPurchase7d(setMsg) {
    if (purchaseCache) return purchaseCache;
    if (MOCK) { purchaseCache = { 'nad-1': { cnt: 3, val: 210000 }, 'nad-2': { cnt: 1, val: 33000 } }; purchaseKwCache = { 'nkw-b1': { cnt: 2, val: 96000 }, 'nkw-1': { cnt: 4, val: 320000 }, 'nkw-2': { cnt: 1, val: 28000 } }; return purchaseCache; }
    let done = 0;
    const per = await Promise.all([1, 2, 3, 4, 5, 6, 7].map(async (d) => {
      const ad = {}, kw = {};
      try {
        const job = await api('report_create', { body: { reportTp: 'AD_CONVERSION', statDt: isoAgo(d) } });
        const id = job.reportJobId || job.id; let url = null;
        for (let i = 0; i < 15; i++) { await sleep(1500); const st = await api('report_status', { params: { id } }); if (st.status === 'BUILT' || st.status === 'DONE') { url = st.downloadUrl; break; } if (st.status === 'NONE' || st.status === 'DELETED') break; }
        if (url) { const dl = await api('report_download', { params: { url } });
          // col10=전환유형(purchase), col9=직접(1). col5=소재, col4=키워드. 구매완료 직접전환만.
          (dl.tsv || '').split(/\r?\n/).forEach(ln => { const c = ln.split('\t'); if (c[10] === 'purchase' && c[9] === '1') { const q = Number(c[11]) || 0, v = Number(c[12]) || 0; const a = (ad[c[5]] ||= { cnt: 0, val: 0 }); a.cnt += q; a.val += v; const k = (kw[c[4]] ||= { cnt: 0, val: 0 }); k.cnt += q; k.val += v; } });
        }
        api('report_delete', { params: { id } }).catch(() => {});
      } catch {}
      done++; if (setMsg) setMsg(`구매전환 보고서 수집 ${done}/7…`);
      return { ad, kw };
    }));
    const mAd = {}, mKw = {};
    per.forEach(({ ad, kw }) => { for (const k in ad) { const m = (mAd[k] ||= { cnt: 0, val: 0 }); m.cnt += ad[k].cnt; m.val += ad[k].val; } for (const k in kw) { const m = (mKw[k] ||= { cnt: 0, val: 0 }); m.cnt += kw[k].cnt; m.val += kw[k].val; } });
    purchaseCache = mAd; purchaseKwCache = mKw; return mAd;
  }
  // 소재 기본지표(최근 7일): /stats 라벨값 합산
  async function adBase(nad) {
    try {
      const r = await api('stats', { params: { id: nad, fields: JSON.stringify(['impCnt', 'clkCnt', 'salesAmt', 'avgRnk']), timeRange: JSON.stringify({ since: isoAgo(7), until: isoAgo(1) }) } });
      const rows = Array.isArray(r) ? r : (Array.isArray(r.data) ? r.data : []);
      let imp = 0, clk = 0, cost = 0, rw = 0;
      rows.forEach(x => { imp += +x.impCnt || 0; clk += +x.clkCnt || 0; cost += +x.salesAmt || 0; rw += (+x.avgRnk || 0) * (+x.impCnt || 0); });
      return { imp, clk, cost, rank: imp ? rw / imp : 0 };
    } catch { return null; }
  }
  let nvSuggestions = [];

  // ── 입찰 규칙 엔진 (목표 ROAS 300, 데드존 밴드, 요일·공휴일 보정) ──
  const KR_HOLIDAYS = new Set([ // 2026 하반기~2027 상반기 (PLAN 근거)
    '2026-07-17', '2026-08-15', '2026-08-17', '2026-09-24', '2026-09-25', '2026-09-26', '2026-09-28',
    '2026-10-03', '2026-10-05', '2026-10-09', '2026-12-25', '2027-01-01', '2027-02-16', '2027-02-17', '2027-02-18',
  ]);
  const isoAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
  function kstNow() { const d = new Date(Date.now() + 9 * 3600 * 1000); return { dow: d.getUTCDay(), ymd: d.toISOString().slice(0, 10) }; }
  function dayModifier() {
    const { dow, ymd } = kstNow();
    if (KR_HOLIDAYS.has(ymd)) return { mod: 0.85, label: '공휴일 −15%' };
    if (dow === 5 || dow === 6 || dow === 0) return { mod: 0.90, label: '금·토·일 −10%' };
    return { mod: 1, label: '평일' };
  }
  function roasFactor(r) { // 데드존: 300~360% 유지
    if (r >= 600) return 1.20; if (r >= 450) return 1.15; if (r >= 360) return 1.08;
    if (r >= 300) return 1.00; if (r >= 250) return 0.88; return 0.80;
  }
  function computeBid(cur, roas, mod) {
    let nb = Math.round(cur * roasFactor(roas) * mod / 10) * 10;
    const lo = Math.round(cur * 0.75 / 10) * 10, hi = Math.round(cur * 1.25 / 10) * 10; // 1회 ±25% 캡
    nb = Math.max(lo, Math.min(hi, nb));
    nb = Math.max(70, Math.min(100000, nb));
    if (roas < 300 && nb > cur) nb = cur; // 300 미만은 상향 금지
    return nb;
  }
  async function applyAll() {
    if (!nvSuggestions.length) return;
    const checkedIds = new Set([...document.querySelectorAll('.nvc-cb:checked')].map(cb => cb.dataset.id));
    const sel = nvSuggestions.filter(s => checkedIds.has(s.id));
    if (!sel.length) { alert('반영할 제안을 선택하세요. (제안 옆 체크박스)'); return; }
    if (MOCK) { alert('🧪 목모드: 실제 반영 안 함 (선택 ' + sel.length + '건)'); return; }
    if (!localStorage.getItem('sb_write_token')) { alert('쓰기 인증이 필요합니다. 좌측 사이드바 "🔒 쓰기 잠김"을 눌러 해제하세요.'); return; }
    if (!confirm('선택한 ' + sel.length + '건의 입찰가를 실제로 변경합니다. 진행할까요?')) return;
    const btn = $('#nvc-applyall'); if (btn) btn.disabled = true;
    let ok = 0, fail = 0; const logged = [];
    for (const s of sel) {
      try {
        if (s.kind === 'kw') await api('update_keyword_bid', { body: { nccKeywordId: s.id, nccAdgroupId: s.adgroupId, bidAmt: s.nb } }); // 브랜드형쇼검 키워드
        else await api('update_ad_bid', { body: { nccAdId: s.id, bidAmt: s.nb } }); // 쇼핑몰상품형 소재
        ok++;
        logged.push({ channel: 'shopping', entity_id: s.id, name: s.name, old_bid: s.cur, new_bid: s.nb });
        const bd = $('#nvb-' + s.id); if (bd) bd.innerHTML = `<span style="font-weight:800;color:var(--accent-d)">${s.nb}원</span> <span class="nvc-d" style="background:var(--green-l);color:var(--green)">✓ 반영</span>`;
      } catch (e) { fail++; }
    }
    if (logged.length) { try { await api('log_bid_change', { body: { rows: logged } }); } catch {} loadBidHistory('shopping', 'nvc-history'); }
    if (btn) btn.textContent = `완료 · 성공 ${ok}${fail ? ' / 실패 ' + fail : ''}`;
  }

  // ── 파워링크 입찰가 조정 = 광고그룹별·키워드별 카드(확장소재 포함). 쇼핑 대시보드와 동일 규칙엔진 ──
  let pwrPaused = false, nvPwrSug = [], purchaseKwCache = null;
  async function renderPowerBid() {
    const body = $('#nv-body'); injectNvCss();
    body.innerHTML = loading('운영중 파워링크 캠페인·키워드 불러오는 중…');
    try {
      const camps = await apiR('get_campaigns');
      const plCamps = camps.filter(c => c.campaignTp === 'WEB_SITE' && (pwrPaused || isRunning(c))).sort(runningFirst);
      if (!plCamps.length) { body.innerHTML = '<div style="color:var(--muted);padding:20px">운영중 파워링크(웹사이트) 캠페인이 없어요.</div>'; return; }
      // 구조: 캠페인 → (운영중)그룹 → {확장소재, (운영중)키워드}
      let structure = await mapLimit(plCamps, 3, async c => {
        const gs = (await apiR('get_adgroups', { params: { nccCampaignId: c.nccCampaignId } }).catch(() => [])) || [];
        const egs = gs.filter(g => pwrPaused || isRunning(g));
        const withKw = await mapLimit(egs, 4, async g => {
          const [kws, extR, adsR] = await Promise.all([
            apiR('get_keywords', { params: { nccAdgroupId: g.nccAdgroupId } }).catch(() => []),
            apiR('get_ad_extensions', { params: { ownerId: g.nccAdgroupId } }).catch(() => []),
            apiR('get_ads', { params: { nccAdgroupId: g.nccAdgroupId } }).catch(() => []),
          ]);
          const kwArr = (kws || []).filter(k => pwrPaused || (isRunning(k) && k.userLock !== true));
          const exts = Array.isArray(extR) ? extR : (Array.isArray(extR.data) ? extR.data : []);
          const ads = Array.isArray(adsR) ? adsR : (Array.isArray(adsR.data) ? adsR.data : []);
          return { group: g, exts, kws: kwArr, ads };
        });
        return { camp: c, groups: withKw.filter(x => x.kws.length) };
      });
      structure = structure.filter(s => s.groups.length);
      if (!structure.length) { body.innerHTML = '<div style="color:var(--muted);padding:20px">운영중 파워링크 키워드가 없어요.</div>'; return; }
      const ids = structure.flatMap(s => s.groups.flatMap(g => g.kws.map(k => k.nccKeywordId)));
      const statsMap = await loadStatsBatch(ids);
      renderPowerDash(body, structure, statsMap, null);
      loadPurchaseKw7d().then(p => { if (sub === 'powerbid' && document.getElementById('nvp-dash')) renderPowerDash(body, structure, statsMap, p); }).catch(() => {});
    } catch (e) { body.innerHTML = errBox(e); }
  }
  // 키워드별 직접구매(구매완료·직접) 7일 — loadPurchase7d가 소재키·키워드키 동시 수집하므로 재사용(다운로드 1회).
  async function loadPurchaseKw7d(setMsg) {
    if (purchaseKwCache) return purchaseKwCache;
    await loadPurchase7d(setMsg);
    return purchaseKwCache || {};
  }
  function renderPowerDash(body, structure, statsMap, purchase) {
    const mod = dayModifier(), pending = !purchase;
    nvPwrSug = [];
    let gCost = 0, gConvV = 0, gConvN = 0, kwCount = 0;
    structure.forEach(s => {
      s.groups.forEach(gr => {
        gr.items = gr.kws.map(kw => {
          const b = statsMap[kw.nccKeywordId] || { imp: 0, clk: 0, cost: 0, rank: 0 };
          const pc = purchase ? (purchase[kw.nccKeywordId] || { cnt: 0, val: 0 }) : null;
          const ctr = b.imp ? b.clk / b.imp * 100 : 0, cpc = b.clk ? b.cost / b.clk : 0;
          const roas = (pc && b.cost) ? pc.val / b.cost * 100 : null;
          const grp = kw.useGroupBidAmt === true;
          const cur = Number(kw.bidAmt) || 0;
          const nb = (!pending && !grp && kw.userLock !== true && b.cost && roas != null) ? computeBid(cur, roas, mod.mod) : cur;
          if (!pending && !grp && nb !== cur && kw.userLock !== true) nvPwrSug.push({ kw, cur, nb });
          gCost += b.cost; if (pc) { gConvV += pc.val; gConvN += pc.cnt; } kwCount++;
          return { kw, b, pc, ctr, cpc, roas, cur, nb, pending, grp };
        }).sort((x, y) => y.b.cost - x.b.cost);
        gr.total = gr.items.reduce((t, it) => t + it.b.cost, 0);
        // 그룹 합계(전체 키워드 합산)
        gr.aimp = gr.items.reduce((t, it) => t + it.b.imp, 0);
        gr.aclk = gr.items.reduce((t, it) => t + it.b.clk, 0);
        gr.arankw = gr.items.reduce((t, it) => t + it.b.rank * it.b.imp, 0); // 노출 가중 평균순위용
        gr.acnt = purchase ? gr.items.reduce((t, it) => t + (it.pc ? it.pc.cnt : 0), 0) : null;
        gr.aval = purchase ? gr.items.reduce((t, it) => t + (it.pc ? it.pc.val : 0), 0) : null;
      });
      s.groups.sort((a, b) => b.total - a.total);
      s.total = s.groups.reduce((t, g) => t + g.total, 0);
    });
    structure.sort((a, b) => b.total - a.total);
    const gRoas = gCost ? gConvV / gCost * 100 : 0;
    const thc = 'padding:6px 8px;font-weight:600;white-space:nowrap';
    const tf = 'padding:7px 8px;text-align:right;white-space:nowrap;font-weight:700;background:var(--surface2)';
    const groupFoot = (gr) => `<tfoot><tr style="border-top:2px solid var(--border2)">
      <td style="padding:7px 8px;text-align:left;font-weight:700;background:var(--surface2)">합계 · ${gr.items.length}개</td>
      <td style="${tf}">${gr.aimp ? (gr.arankw / gr.aimp).toFixed(1) : '-'}</td>
      <td style="${tf}"></td>
      <td style="${tf}">${cnt(gr.aimp)}</td>
      <td style="${tf}">${cnt(gr.aclk)}</td>
      <td style="${tf}">${gr.aimp ? (gr.aclk / gr.aimp * 100).toFixed(2) : '0.00'}%</td>
      <td style="${tf}">${won(gr.aclk ? Math.round(gr.total / gr.aclk) : 0)}</td>
      <td style="${tf}">${won(gr.total)}</td>
      <td style="${tf}">${pending ? '…' : (gr.acnt + '건·' + cnt(gr.aval))}</td>
      <td style="${tf};color:${pending ? 'var(--muted)' : (gr.total && gr.aval / gr.total * 100 >= 300 ? 'var(--green)' : 'var(--red)')}">${pending ? '…' : (gr.total ? Math.round(gr.aval / gr.total * 100) + '%' : '-')}</td>
      <td style="${tf}"></td><td style="${tf}"></td>
    </tr></tfoot>`;
    const tableHead = `<thead><tr style="color:var(--muted);font-size:11px;text-align:right;border-bottom:1px solid var(--border)">
      <th style="text-align:left;${thc}">키워드</th><th style="${thc}">순위</th><th style="text-align:left;${thc}">품질</th><th style="${thc}">노출</th><th style="${thc}">클릭</th><th style="${thc}">CTR</th><th style="${thc}">CPC</th><th style="${thc}">총비용</th><th style="${thc}">구매(직접)</th><th style="${thc}">ROAS</th><th style="text-align:right;${thc}">입찰가 (현재→제안)</th><th style="${thc}">On/Off</th>
    </tr></thead>`;
    const sections = structure.map(s => s.groups.map(gr => `
      <div class="nvp-gcard" data-camp="${s.camp.nccCampaignId}" style="border:1px solid var(--border);border-radius:12px;padding:12px 14px;margin-bottom:14px;background:var(--surface);box-shadow:0 1px 3px rgba(24,23,46,.05)">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;flex-wrap:wrap">
          <span style="font-size:11px;color:var(--muted)">${esc(s.camp.name)}</span>
          <b style="font-size:15px">${statusDot(gr.group)} ${esc(gr.group.name)}</b>
          <span style="color:var(--muted);font-size:12px">${won(gr.total)} · 키워드 ${gr.items.length}개</span>
        </div>
        <div style="margin:0 0 10px;padding:10px 12px;background:var(--surface2);border:1px solid var(--border);border-radius:10px">
          <div style="font-size:11px;color:var(--muted);font-weight:700;margin-bottom:6px">확장소재 미리보기</div>
          ${extPreview(gr.exts)}
        </div>
        <div style="margin:0 0 10px;padding:10px 12px;background:var(--surface2);border:1px solid var(--border);border-radius:10px">
          <div style="font-size:11px;color:var(--muted);font-weight:700">소재 · 연결 URL</div>
          ${adPreview(gr.ads)}
        </div>
        <div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:12.5px">
          ${tableHead}<tbody>${gr.items.map(powerKwRow).join('')}</tbody>${groupFoot(gr)}
        </table></div>
      </div>`).join('')).join('');
    body.innerHTML = `
      <div class="nvc-tiles">
        <div class="nvc-tile"><div class="k">총비용 (7일)</div><div class="v">${won(gCost)}</div></div>
        <div class="nvc-tile"><div class="k">구매 ROAS <span style="color:var(--muted);font-weight:400">직접</span></div><div class="v" style="color:${pending ? 'var(--muted)' : (gRoas >= 300 ? 'var(--green)' : 'var(--red)')}">${pending ? '<span style="font-size:13px">집계 중…</span>' : (gCost ? Math.round(gRoas) + '%' : '-')}</div></div>
        <div class="nvc-tile"><div class="k">구매 전환</div><div class="v">${pending ? '<span style="color:var(--muted);font-size:13px">집계 중…</span>' : gConvN + '건 · ' + cnt(gConvV) + '원'}</div></div>
        <div class="nvc-tile"><div class="k">키워드 · 변경대상</div><div class="v">${kwCount} · <span style="color:var(--accent-d)">${pending ? '…' : nvPwrSug.length}</span></div></div>
      </div>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:8px">
        <input id="nvpf-q" placeholder="🔎 키워드 검색" style="padding:7px 10px;border:1px solid var(--border2);border-radius:9px;background:var(--surface);color:var(--text);font-size:13px;min-width:160px">
        <label style="font-size:12px;color:var(--muted);display:flex;align-items:center;gap:4px"><input type="checkbox" id="nvpf-changed"> 제안 있는 것만</label>
        <label style="font-size:12px;color:var(--muted);display:flex;align-items:center;gap:4px"><input type="checkbox" id="nvpf-paused" ${pwrPaused ? 'checked' : ''}> 정지 포함</label>
        <span style="font-size:12px;color:var(--muted)">· ${mod.label} 보정 · 비용순 · 그룹입찰 키워드는 제외</span>
        <button id="nvp-applyall" style="${pBtn};margin-left:auto" ${(!pending && nvPwrSug.length) ? '' : 'disabled'}>${pending ? '⏳ 구매전환 집계 중…' : (nvPwrSug.length ? `▶ ${nvPwrSug.length}건 입찰가 반영` : '변경 대상 없음')}</button>
      </div>
      <div id="nvp-dash">${sections || '<div style="color:var(--muted);padding:20px">운영중 파워링크 키워드가 없어요.</div>'}</div>
      <div id="nvp-history" style="margin-top:18px;border-top:1px solid var(--border);padding-top:8px"></div>`;
    const q = $('#nvpf-q'), ch = $('#nvpf-changed');
    const applyF = () => {
      const term = (q.value || '').toLowerCase(), onlyCh = ch.checked;
      document.querySelectorAll('.nvp-row').forEach(r => { r.style.display = ((!term || r.dataset.kw.includes(term)) && (!onlyCh || r.dataset.changed === '1')) ? '' : 'none'; });
      document.querySelectorAll('.nvp-gcard').forEach(card => { const any = [...card.querySelectorAll('.nvp-row')].some(r => r.style.display !== 'none'); card.style.display = any ? '' : 'none'; });
    };
    if (q) q.oninput = applyF; if (ch) ch.onchange = applyF;
    const pcb = $('#nvpf-paused'); if (pcb) pcb.onchange = () => { pwrPaused = pcb.checked; renderPowerBid(); };
    const upd = () => { const n = document.querySelectorAll('.nvp-cb:checked').length; const bt = $('#nvp-applyall'); if (bt) { bt.disabled = !n; bt.textContent = n ? `▶ 선택 ${n}건 입찰가 반영` : '선택된 항목 없음'; } };
    document.querySelectorAll('.nvp-cb').forEach(cb => cb.onchange = upd);
    const btn = $('#nvp-applyall'); if (btn) { btn.onclick = () => applyPowerBids(); if (!pending && nvPwrSug.length) upd(); }
    document.querySelectorAll('.nvp-off').forEach(b => b.onclick = () => togglePowerKw(b));
    document.querySelectorAll('.nv-urlcopy').forEach(b => b.onclick = () => { navigator.clipboard.writeText(b.dataset.url).then(() => { const t = b.textContent; b.textContent = '✓'; setTimeout(() => b.textContent = t, 1200); }); });
    loadBidHistory('powerlink', 'nvp-history');
  }
  // 키워드 OFF(정지)/ON(노출) — userLock 토글. 파워링크는 제외키워드 대신 낭비 키워드를 직접 끔.
  async function togglePowerKw(b) {
    const lock = b.dataset.lock === '1'; // 현재 노출중이면 OFF(true), 정지면 ON(false)
    if (MOCK) { alert('🧪 목모드: 실제 반영 안 함 (' + (lock ? 'OFF' : 'ON') + ')'); return; }
    if (!localStorage.getItem('sb_write_token')) { alert('쓰기 인증이 필요합니다. 좌측 사이드바 "🔒 쓰기 잠김"을 눌러 해제하세요.'); return; }
    if (!confirm(lock ? '이 키워드를 OFF(정지)할까요? 노출이 즉시 중단됩니다.' : '이 키워드를 다시 ON(노출)할까요?')) return;
    b.disabled = true; const prev = b.textContent; b.textContent = '…';
    try {
      await api('set_keyword_userlock', { body: { nccKeywordId: b.dataset.kw, nccAdgroupId: b.dataset.ag, userLock: lock } });
      b.disabled = false; b.textContent = lock ? '✓ OFF됨' : '✓ ON됨';
      b.dataset.lock = lock ? '0' : '1'; b.style.color = 'var(--muted)';
    } catch (e) { b.disabled = false; b.textContent = prev; alert('실패: ' + (e.message || e)); }
  }
  function powerKwRow(it) {
    const kw = it.kw, locked = kw.userLock === true, paused = locked || !isRunning(kw), pend = it.pending, grp = it.grp;
    const d = it.nb - it.cur, pct = it.cur ? Math.round(d / it.cur * 100) : 0, changed = !pend && !grp && d !== 0;
    const td = 'padding:6px 8px;text-align:right;white-space:nowrap';
    const bidCell = grp
      ? '<span style="color:var(--muted);font-size:11px">그룹입찰</span>'
      : pend
        ? '<span style="color:var(--muted)">…</span>'
        : changed
          ? `<span style="color:var(--muted);text-decoration:line-through">${it.cur}</span><span style="color:var(--muted)"> → </span><span style="font-weight:800;color:var(--accent-d)">${it.nb}원</span> <span class="nvc-d" style="background:${d > 0 ? 'var(--green-l)' : 'var(--red-l)'};color:${d > 0 ? 'var(--green)' : 'var(--red)'}">${d > 0 ? '+' : ''}${pct}%</span> <input type="checkbox" class="nvp-cb" data-kw="${esc(kw.nccKeywordId)}" checked title="이 제안 반영" style="width:15px;height:15px;accent-color:var(--accent);cursor:pointer;vertical-align:middle">`
          : `<span style="font-weight:700">${it.cur}원</span> <span style="color:var(--muted);font-size:11px">유지</span>`;
    const roasTxt = pend ? '…' : (it.b.cost ? Math.round(it.roas) + '%' : '-');
    const roasCol = pend ? 'var(--muted)' : (it.b.cost ? (it.roas >= 300 ? 'var(--green)' : 'var(--red)') : 'var(--muted)');
    const buyTxt = pend ? '…' : (it.pc.cnt + '건·' + cnt(it.pc.val));
    return `<tr class="nvp-row" data-kw="${esc((kw.keyword || '').toLowerCase())}" data-changed="${changed ? '1' : '0'}" style="border-top:1px solid var(--border)">
      <td style="padding:6px 8px;text-align:left"><span style="font-size:11px" title="${paused ? '정지' : '노출중'}">${paused ? '⚪' : '🟢'}</span> <span style="font-weight:600">${esc(kw.keyword || kw.nccKeywordId)}</span></td>
      <td style="${td}">${it.b.rank ? it.b.rank.toFixed(1) : '-'}</td>
      <td style="padding:6px 8px;text-align:left">${qiBar(kw.nccQi && kw.nccQi.qiGrade)}</td>
      <td style="${td}">${cnt(it.b.imp)}</td>
      <td style="${td}">${cnt(it.b.clk)}</td>
      <td style="${td}">${it.ctr.toFixed(2)}%</td>
      <td style="${td}">${won(Math.round(it.cpc))}</td>
      <td style="${td}">${won(it.b.cost)}</td>
      <td style="${td}">${buyTxt}</td>
      <td style="${td};font-weight:700;color:${roasCol}">${roasTxt}</td>
      <td id="nvpb-${esc(kw.nccKeywordId)}" style="${td}">${bidCell}</td>
      <td style="padding:6px 8px;text-align:center"><button class="nvp-off" data-kw="${esc(kw.nccKeywordId)}" data-ag="${esc(kw.nccAdgroupId)}" data-lock="${locked ? '0' : '1'}" style="font-size:11px;padding:2px 10px;border-radius:6px;border:1px solid var(--border2);background:var(--surface);color:${locked ? 'var(--green)' : 'var(--red)'};cursor:pointer;font-weight:700">${locked ? 'ON' : 'OFF'}</button></td>
    </tr>`;
  }
  async function applyPowerBids() {
    if (!nvPwrSug.length) return;
    const checked = new Set([...document.querySelectorAll('.nvp-cb:checked')].map(cb => cb.dataset.kw));
    const sel = nvPwrSug.filter(s => checked.has(s.kw.nccKeywordId));
    if (!sel.length) { alert('반영할 제안을 선택하세요. (제안 옆 체크박스)'); return; }
    if (MOCK) { alert('🧪 목모드: 실제 반영 안 함 (선택 ' + sel.length + '건)'); return; }
    if (!localStorage.getItem('sb_write_token')) { alert('쓰기 인증이 필요합니다. 좌측 사이드바 "🔒 쓰기 잠김"을 눌러 해제하세요.'); return; }
    if (!confirm('선택한 ' + sel.length + '건의 파워링크 키워드 입찰가를 실제로 변경합니다. 진행할까요?')) return;
    const btn = $('#nvp-applyall'); if (btn) btn.disabled = true;
    let ok = 0, fail = 0; const logged = [];
    for (const s of sel) {
      try {
        await api('update_keyword_bid', { body: { nccKeywordId: s.kw.nccKeywordId, nccAdgroupId: s.kw.nccAdgroupId, bidAmt: s.nb } }); ok++;
        logged.push({ channel: 'powerlink', entity_id: s.kw.nccKeywordId, name: s.kw.keyword || s.kw.nccKeywordId, old_bid: s.cur, new_bid: s.nb });
        const bd = $('#nvpb-' + s.kw.nccKeywordId); if (bd) bd.innerHTML = `<span style="font-weight:800;color:var(--accent-d)">${s.nb}원</span> <span class="nvc-d" style="background:var(--green-l);color:var(--green)">✓ 반영</span>`;
      } catch (e) { fail++; }
    }
    if (logged.length) { try { await api('log_bid_change', { body: { rows: logged } }); } catch {} loadBidHistory('powerlink', 'nvp-history'); }
    if (btn) btn.textContent = `완료 · 성공 ${ok}${fail ? ' / 실패 ' + fail : ''}`;
  }
  // 입찰 변경 이력 로더 — 각 탭 하단에 최근 변경(날짜·이전→새값) 표시
  async function loadBidHistory(channel, elId) {
    const el = document.getElementById(elId); if (!el) return;
    try {
      const r = await api('get_bid_changes', { params: { channel, limit: '40' } });
      const rows = (r && r.changes) || [];
      if (!rows.length) { el.innerHTML = '<div style="color:var(--muted);font-size:11px;padding:6px 2px">아직 변경 이력이 없어요.</div>'; return; }
      const fmt = (iso) => { const k = new Date(new Date(iso).getTime() + 9 * 3600000); return k.toISOString().slice(5, 16).replace('T', ' '); };
      el.innerHTML = `<div style="font-size:11px;color:var(--muted);font-weight:700;margin:4px 2px">입찰가 변경 이력 <span style="font-weight:400">(최근 ${rows.length}건)</span></div>` +
        rows.map(c => { const d = (c.new_bid || 0) - (c.old_bid || 0); const col = d > 0 ? 'var(--green)' : (d < 0 ? 'var(--red)' : 'var(--muted)'); return `<div style="font-size:11px;color:var(--muted);padding:2px 2px;display:flex;gap:8px"><span style="min-width:78px">${fmt(c.changed_at)}</span><span style="flex:1;color:var(--text)">${esc(c.name || c.entity_id)}</span><span>${cnt(c.old_bid)} → <b style="color:${col}">${cnt(c.new_bid)}원</b></span></div>`; }).join('');
    } catch (e) { el.innerHTML = ''; }
  }

  // ── 제외키워드 제안 ───────────────────────────────────────────
  const btnCss = 'padding:6px 14px;border-radius:8px;border:1px solid var(--border,#333);background:var(--accent,#4a7);color:inherit;cursor:pointer;font-weight:600';
  // ── 탭2: 쇼핑검색 제외키워드 (CSV 업로드 제안) ──
  function renderShopNeg() {
    $('#nv-body').innerHTML = `
      <div style="max-width:880px">
        <div style="color:var(--muted);font-size:13px;margin-bottom:12px;line-height:1.7">
          쇼핑 검색어는 네이버가 API를 제공하지 않아, 광고관리에서 받은 <b>"랭킹 키워드_쇼핑검색" CSV</b>(최근 1주일)를 올리면
          <b>비용 3,000원 이상 & 구매 0인 검색어</b>를 자동 분석해 제외 후보를 제안합니다.<br>
          <span style="font-size:12px">· 쇼핑검색만 분석(플레이스·파워링크 제외) · <b>오즈키즈/ozkiz 브랜드 검색어</b>는 (제외키워드 세팅용) 조건과 무관하게 항상 표시<br>
          ※ 제외 반영은 네이버 대시보드에서 붙여넣기 (쇼핑 제외검색어는 API 쓰기 미지원)</span>
        </div>
        <input type="file" id="nv-csv" accept=".csv,text/csv">
        <div id="nv-csv-out" style="margin-top:12px"></div>
      </div>`;
    $('#nv-csv').onchange = (e) => { const f = e.target.files && e.target.files[0]; if (f) f.text().then(parseShoppingCsv).catch(err => { $('#nv-csv-out').innerHTML = errBox(err); }); };
  }

  // 확장소재 라벨 + 실제 내용 미리보기 (파워링크 입찰 조정 탭). 확장이미지는 실제 썸네일, 홍보문구/네이버쇼핑/서브링크는 실제 값.
  const EXT_IMG = 'https://searchad-phinf.pstatic.net'; // POWER_LINK_IMAGE imagePath 호스트 (검증됨)
  const EXT_LABEL = { POWER_LINK_IMAGE: '🖼️ 확장이미지', IMAGE: '🖼️ 이미지', DESCRIPTION: '💬 홍보문구', HEADLINE: '📝 추가제목', SUBLINKS: '🔗 서브링크', SUB_LINKS: '🔗 서브링크', PHONE: '📞 전화', LOCATION: '📍 위치', SHOPPING_WEB: '🛒 네이버쇼핑', CATALOG: '📖 카탈로그', PROMOTION: '🎁 프로모션', PRICE_LINK: '💲 가격링크', PRICE_TABLE: '💲 가격표', BLOG_REVIEW: '✍️ 블로그리뷰', NAVER_TV_VIDEO: '🎬 동영상', CALCULATION: '🧮 계산' };
  const extRow = (label, inner) => `<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:2px 0"><span style="font-size:11px;color:var(--muted);font-weight:700;min-width:66px">${label}</span>${inner}</div>`;
  // 소재 실제 연결 URL 미리보기 (ad.pc.final = 실제 연결, ad.pc.display = 표시 URL)
  function adPreview(ads) {
    const list = (ads || []).filter(a => isRunning(a) && a.userLock !== true); // OFF(정지) 소재는 제외
    if (!list.length) return '<span style="color:var(--muted);font-size:12px">노출중 소재 없음</span>';
    return list.map(a => {
      const ad = a.ad || {}, pc = ad.pc || {}, mo = ad.mobile || {};
      const final = pc.final || mo.final || ad.landingUrl || ''; // 브랜드형 배너는 ad.landingUrl
      const disp = pc.display || mo.display || '';
      const img = ad.image ? (/^https?:/.test(ad.image) ? ad.image : EXT_IMG + ad.image) : ''; // 브랜드형 소재 이미지
      return `<div style="display:flex;gap:10px;padding:6px 0;border-top:1px solid var(--border)">
        ${img ? `<img src="${esc(img)}" style="width:60px;height:60px;border-radius:8px;object-fit:cover;border:1px solid var(--border);flex:none" onerror="this.style.display='none'">` : ''}
        <div style="min-width:0">
          <div style="display:flex;align-items:center;gap:6px;margin-bottom:2px"><span style="font-size:11px">🟢</span>${ad.headline ? `<span style="font-size:12.5px;font-weight:600">${esc(ad.headline)}</span>` : `<span style="font-size:12px;color:var(--muted)">${esc(a.nccAdId)}</span>`}</div>
          ${ad.description ? `<div style="font-size:11.5px;color:var(--muted);margin-bottom:3px">${esc(ad.description)}</div>` : ''}
          ${final ? `<div style="font-size:11.5px;line-height:1.5"><span style="color:var(--muted);font-weight:700">🔗 연결 URL</span> <a href="${esc(final)}" target="_blank" rel="noopener" style="color:var(--accent-d);text-decoration:none;word-break:break-all">${esc(final)}</a> <button class="nv-urlcopy" data-url="${esc(final)}" style="font-size:10px;padding:1px 7px;border-radius:6px;border:1px solid var(--border2);background:var(--surface);cursor:pointer">복사</button></div>` : '<div style="font-size:11.5px;color:var(--muted)">연결 URL 없음</div>'}
          ${disp ? `<div style="font-size:11px;color:var(--muted)">표시 URL: ${esc(disp)}</div>` : ''}
        </div>
      </div>`;
    }).join('');
  }
  function extPreview(exts) {
    if (!exts || !exts.length) return '<span style="color:var(--muted);font-size:12px">확장소재 없음</span>';
    const by = {}; exts.forEach(e => { (by[e.type] ||= []).push(e.adExtension || {}); });
    const parts = [];
    const imgs = [...(by.POWER_LINK_IMAGE || []), ...(by.IMAGE || [])];
    if (imgs.length) parts.push(extRow('🖼️ 확장이미지', imgs.map(a => a.imagePath ? `<img src="${esc(EXT_IMG + a.imagePath)}" title="확장이미지" style="width:52px;height:52px;border-radius:8px;object-fit:cover;border:1px solid var(--border)" onerror="this.style.display='none'">` : '').join('')));
    if (by.DESCRIPTION) parts.push(extRow('💬 홍보문구', by.DESCRIPTION.map(a => `<span style="background:var(--surface2);border:1px solid var(--border2);border-radius:8px;padding:3px 10px;font-size:12.5px">${esc(a.description || '')}</span>`).join('')));
    if (by.HEADLINE) parts.push(extRow('📝 추가제목', by.HEADLINE.map(a => `<span style="font-size:12.5px">${esc(a.headline || a.description || '')}</span>`).join(' · ')));
    const subs = [...(by.SUBLINKS || []), ...(by.SUB_LINKS || [])];
    if (subs.length) { const items = subs.flatMap(a => Array.isArray(a.links) ? a.links : (a.sublinks || [a])).map(l => l && (l.name || l.title || l.linkName)).filter(Boolean); parts.push(extRow('🔗 서브링크', items.length ? items.map(t => `<span style="font-size:12px;background:var(--accent-l);color:var(--accent-d);border-radius:7px;padding:2px 8px">${esc(t)}</span>`).join('') : `<span style="font-size:12px;color:var(--muted)">${subs.length}개</span>`)); }
    if (by.SHOPPING_WEB) parts.push(extRow('🛒 네이버쇼핑', by.SHOPPING_WEB.map(a => a.view ? `<a href="${esc(a.view)}" target="_blank" rel="noopener" style="font-size:12px;color:var(--accent-d);text-decoration:none">${esc(a.view)} ↗</a>` : '<span style="font-size:12px;color:var(--muted)">연결됨</span>').join(' ')));
    const known = new Set(['POWER_LINK_IMAGE', 'IMAGE', 'DESCRIPTION', 'HEADLINE', 'SUBLINKS', 'SUB_LINKS', 'SHOPPING_WEB']);
    const others = Object.keys(by).filter(t => !known.has(t));
    if (others.length) parts.push(extRow('기타', others.map(t => `<span style="background:var(--surface2);border:1px solid var(--border2);border-radius:8px;padding:3px 9px;font-size:12px;font-weight:600">${EXT_LABEL[t] || t}${by[t].length > 1 ? ' ×' + by[t].length : ''}</span>`).join('')));
    return `<div style="display:flex;flex-direction:column;gap:3px">${parts.join('')}</div>`;
  }
  // 쇼핑: CSV 업로드 → 낭비 검색어(비용 있고 판매 0) 제안 + 복사
  function parseShoppingCsv(text) {
    const out = $('#nv-csv-out');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    const lines = text.split(/\r?\n/).filter(Boolean);
    const hi = lines.findIndex(l => l.includes('검색어') && l.includes('총비용'));
    if (hi < 0) { out.innerHTML = errBox({ message: '"검색어"·"총비용" 컬럼을 못 찾았어요. 쇼핑검색 검색어 CSV가 맞는지 확인하세요.' }); return; }
    const H = lines[hi].split(',');
    const idx = (name) => H.findIndex(h => h.split('(')[0].trim().includes(name));
    const ci = { grp: idx('광고그룹'), camp: idx('캠페인'), type: idx('유형'), term: idx('검색어'), imp: idx('노출'), clk: idx('클릭'), cost: idx('총비용'), sales: idx('전환매출') };
    if (ci.term < 0 || ci.cost < 0) { out.innerHTML = errBox({ message: '필수 컬럼(검색어/총비용) 매핑 실패' }); return; }
    // 광고그룹 → 검색어 집계. 쇼핑검색 전용 탭이므로 플레이스·파워링크는 제외(파워링크는 "파워링크 입찰가 조정" 탭에서 관리).
    const groups = {};
    let nonShopSkipped = 0;
    for (let i = hi + 1; i < lines.length; i++) {
      const c = lines[i].split(','); if (c.length < H.length) continue;
      const term = (c[ci.term] || '').trim(); if (!term || term === '-') continue;
      const grp = (ci.grp >= 0 ? (c[ci.grp] || '').trim() : '') || '(그룹 미표기)';
      const camp = ci.camp >= 0 ? (c[ci.camp] || '').trim() : '';
      const rowType = ci.type >= 0 ? (c[ci.type] || '').trim() : '';
      // 쇼핑검색 상품형만: 브랜드형(키워드입찰)·파워링크·플레이스는 항상 제외. 유형컬럼 있으면 '쇼핑'도 요구.
      if (/플레이스|파워링크|파링|브랜드형/.test(grp + camp) || (ci.type >= 0 && !rowType.includes('쇼핑'))) { nonShopSkipped++; continue; }
      const g = (groups[grp] ||= {});
      const a = (g[term] ||= { term, imp: 0, clk: 0, cost: 0, sales: 0 });
      a.imp += Number(c[ci.imp]) || 0; a.clk += Number(c[ci.clk]) || 0; a.cost += Number(c[ci.cost]) || 0; a.sales += Number(c[ci.sales]) || 0;
    }
    const isBrand = (t) => /오즈키즈|ozkiz/i.test(t);
    const groupWaste = Object.entries(groups).map(([grp, terms]) => {
      // 낭비(비용 ≥3,000 & 구매 0) 또는 브랜드 검색어(오즈키즈/ozkiz)는 조건 무관 항상 포함
      const waste = Object.values(terms).filter(x => isBrand(x.term) || (x.cost >= 3000 && x.sales === 0)).sort((a, b) => b.cost - a.cost);
      return { grp, waste, total: waste.reduce((s, x) => s + x.cost, 0) };
    }).filter(g => g.waste.length).sort((a, b) => b.total - a.total);
    if (!groupWaste.length) { out.innerHTML = '<div style="color:var(--muted);padding:16px">해당 검색어(비용 ≥3,000원 & 구매 0, 또는 브랜드 검색어)가 없어요.' + (nonShopSkipped ? ` <span style="font-size:12px">(쇼핑검색 외 ${nonShopSkipped}행 제외됨)</span>` : '') + '</div>'; return; }
    const grandCnt = groupWaste.reduce((s, g) => s + g.waste.length, 0);
    const grandTotal = groupWaste.reduce((s, g) => s + g.total, 0);
    const sections = groupWaste.map((g, gi) => {
      const trs = g.waste.slice(0, 200).map(w => `<tr style="border-bottom:1px solid var(--border)">
        <td style="padding:5px 8px">${esc(w.term)}${isBrand(w.term) ? ' <span style="background:var(--accent-l);color:var(--accent-d);border-radius:5px;padding:1px 6px;font-size:10px;font-weight:700">브랜드</span>' : ''}</td><td style="padding:5px 8px;text-align:right">${cnt(w.imp)}</td>
        <td style="padding:5px 8px;text-align:right">${cnt(w.clk)}</td><td style="padding:5px 8px;text-align:right">${won(w.cost)}</td></tr>`).join('');
      return `<div style="border:1px solid var(--border);border-radius:10px;padding:12px;margin-bottom:14px">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px;flex-wrap:wrap">
          <b style="font-size:14px">${esc(g.grp)}</b>
          <span style="color:var(--muted);font-size:12px">낭비 ${g.waste.length}개 · <span style="color:var(--red)">${won(g.total)}</span></span>
          <button class="nv-gcopy" data-gi="${gi}" style="${btnCss};margin-left:auto">📋 이 그룹 검색어 복사</button>
        </div>
        <div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:13px"><thead><tr style="text-align:left;color:var(--muted);border-bottom:1px solid var(--border)">
          <th style="padding:5px 8px">검색어</th><th style="padding:5px 8px;text-align:right">노출</th><th style="padding:5px 8px;text-align:right">클릭</th><th style="padding:5px 8px;text-align:right">비용</th>
        </tr></thead><tbody>${trs}</tbody></table></div>
      </div>`;
    }).join('');
    out.innerHTML = `
      <div style="margin-bottom:6px"><b>${groupWaste.length}개 광고그룹</b> · 검색어 <b>${grandCnt}개</b> · 소진 비용 <b style="color:var(--red)">${won(grandTotal)}</b> <span style="color:var(--muted);font-size:12px">(비용 ≥3,000원 & 구매 0 · 브랜드 검색어 항상 포함${nonShopSkipped ? ` · 쇼핑검색 외 ${nonShopSkipped}행 제외` : ''})</span></div>
      <div style="color:var(--muted);font-size:12px;margin-bottom:12px">그룹마다 "이 그룹 검색어 복사" → 네이버 대시보드에서 <b>해당 광고그룹</b>의 제외검색어에 붙여넣으세요.</div>
      ${sections}`;
    out.querySelectorAll('.nv-gcopy').forEach(b => b.onclick = () => { const g = groupWaste[+b.dataset.gi]; navigator.clipboard.writeText(g.waste.map(w => w.term).join('\n')).then(() => { b.textContent = '✓ 복사됨'; }); });
  }

  const loading = (m) => `<div style="color:var(--muted,#888);padding:24px;text-align:center">⏳ ${esc(m)}</div>`;
  const errBox = (e) => `<div style="padding:16px;border:1px solid var(--red,#c33);border-radius:8px;color:var(--red,#c33)">에러: ${esc(e.message || e)}<br><span style="color:var(--muted,#888);font-size:12px">프록시 미배포 상태면 ?navermock=1 로 UI 확인 가능</span></div>`;

  // ── 초기화: 토글 배선 (해시 라우팅 — 전환은 해시 변경으로만, 화면 조작은 routeHash가 담당) ──
  function init() {
    root = document.getElementById('naver-root');
    if (!root) return;
    const mBtn = document.getElementById('pf-meta'), nBtn = document.getElementById('pf-naver');
    if (nBtn) nBtn.onclick = () => {
      if (((location.hash || '').replace(/^#\/?/, '')).startsWith('naver')) return;
      location.hash = 'naver-' + sub;   // → index.html routeHash()가 open() 호출
    };
    if (mBtn) mBtn.onclick = () => { location.hash = window._lastMetaPage || 'roas'; };  // → routeHash()가 close()+activateTab()
    const navBid = document.getElementById('nav-naver-bid');
    if (navBid) navBid.onclick = () => { location.hash = 'naver-' + sub; render(); };
    // (메타 사이드바 클릭 시 close 리스너 제거 — nav 클릭이 메타 해시를 세팅하면 routeHash가 닫아줌)
    // 최초 진입이 #naver-* 해시였다면 열기 (index.html 라우터는 이 파일 로드 전에 이미 지나감)
    const h0 = (location.hash || '').replace(/^#\/?/, '');
    if (/^naver(-\w+)?$/.test(h0)) open(h0);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  // index.html의 해시 라우터(routeHash)가 호출하는 공개 훅
  window.naverPlatform = { open, close };

  // ── 목데이터 (UI 검증용) ──────────────────────────────────────
  // ── 수집·알림 현황 (nv_stat_snapshots·nv_alert_log를 collect_status로 조회) ──
  async function renderMonitor() {
    const body = $('#nv-body'); injectNvCss();
    body.innerHTML = loading('수집 현황 불러오는 중…');
    try {
      const s = await api('collect_status');
      const lr = s.lastRun;
      const fmtT = (iso) => { if (!iso) return '-'; const k = new Date(new Date(iso).getTime() + 9 * 3600000); return k.toISOString().slice(5, 16).replace('T', ' '); }; // MM-DD HH:mm (KST)
      const daily = s.daily || [], alerts = s.alerts || [], runs = s.runs || [];
      const maxCost = Math.max(1, ...daily.map(d => d.cost));
      const aicon = (k) => k === 'budget_spike' ? '⚠️' : (k === 'landing_error' ? '🔗' : '🔔');
      const amsg = (a) => { const d = a.detail || {}; if (a.kind === 'budget_spike') return `예산 급증 · ${a.ref} (오늘 ${cnt(Math.round(d.today || 0))}원 · 평소의 ${d.ratio}배)`; if (a.kind === 'landing_error') return `랜딩 오류(${d.status || 'timeout'}) · ${d.ez_name || ''} ${a.ref}`; return a.kind + ' · ' + (a.ref || ''); };
      body.innerHTML = `
        <div class="nvc-tiles">
          <div class="nvc-tile"><div class="k">마지막 수집</div><div class="v" style="font-size:15px">${lr ? fmtT(lr.at) : '<span style="color:var(--muted)">아직 없음</span>'}</div></div>
          <div class="nvc-tile"><div class="k">이번 수집 소재</div><div class="v">${lr ? lr.ads + '개' : '-'}</div></div>
          <div class="nvc-tile"><div class="k">일별 데이터</div><div class="v">${daily.length}일치</div></div>
          <div class="nvc-tile"><div class="k">최근 알림</div><div class="v">${alerts.length}건</div></div>
        </div>
        <div style="font-size:11px;color:var(--muted);margin:2px 0 16px">6시간마다 자동 수집(00·06·12·18시 KST). 예산 급증 알림은 데이터 3일 이상 쌓이면 자동 발동돼요.</div>

        <div style="font-weight:700;font-size:14px;margin:14px 0 8px">📈 일별 성과 <span style="color:var(--muted);font-weight:400;font-size:12px">최근 ${daily.length}일 · 과거→최근 · ROAS는 직접구매 기준</span></div>
        ${daily.length ? `<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:12.5px">
          <thead><tr style="color:var(--muted)">
            <th style="text-align:left;padding:6px 8px">날짜</th><th style="text-align:right;padding:6px 8px">광고비</th><th style="text-align:right;padding:6px 8px">직접구매</th><th style="text-align:right;padding:6px 8px">구매액</th><th style="text-align:right;padding:6px 8px">ROAS</th><th style="width:120px"></th></tr></thead>
          <tbody>${daily.map(d => `<tr style="border-top:1px solid var(--border)">
            <td style="padding:6px 8px;font-weight:600">${d.stat_dt.slice(5)}</td>
            <td style="padding:6px 8px;text-align:right">${cnt(Math.round(d.cost))}원</td>
            <td style="padding:6px 8px;text-align:right">${d.convCnt}건</td>
            <td style="padding:6px 8px;text-align:right">${cnt(Math.round(d.convVal))}원</td>
            <td style="padding:6px 8px;text-align:right;font-weight:700;color:${d.roas == null ? 'var(--muted)' : (d.roas >= 300 ? 'var(--green)' : 'var(--red)')}">${d.roas == null ? '-' : d.roas + '%'}</td>
            <td style="padding:6px 8px"><div style="height:8px;border-radius:4px;background:var(--accent);width:${Math.round(d.cost / maxCost * 100)}%;min-width:2px"></div></td>
          </tr>`).join('')}</tbody></table></div>`
          : `<div style="color:var(--muted);padding:14px">아직 일별 데이터가 없어요. 내일 06시 수집부터 하루씩 쌓입니다.</div>`}

        <div style="font-weight:700;font-size:14px;margin:22px 0 8px">🔔 최근 알림 이력</div>
        ${alerts.length ? alerts.map(a => `<div style="display:flex;gap:8px;align-items:baseline;padding:7px 10px;border:1px solid var(--border);border-radius:9px;margin-bottom:6px;background:var(--surface)">
          <span>${aicon(a.kind)}</span><span style="flex:1;font-size:12.5px">${esc(amsg(a))}</span>
          <span style="color:var(--muted);font-size:11px;white-space:nowrap">${fmtT(a.created_at)}</span></div>`).join('')
          : `<div style="color:var(--muted);padding:14px">아직 알림이 없어요 — 정상입니다. (예산 급증·랜딩 오류가 감지되면 여기와 구글챗에 표시돼요)</div>`}

        <div style="margin-top:16px;display:flex;align-items:center;gap:8px;flex-wrap:wrap">
          <button id="nv-mon-refresh" style="${pBtn}">↻ 새로고침</button>
          <span style="font-size:11px;color:var(--muted)">최근 실행: ${runs.slice(0, 6).map(r => fmtT(r.at) + `(${r.ads})`).join(' · ') || '-'}</span></div>`;
      const rb = $('#nv-mon-refresh'); if (rb) rb.onclick = () => renderMonitor();
    } catch (e) { body.innerHTML = errBox(e); }
  }

  function mockApi(action, p) {
    const D = {
      get_campaigns: [
        { nccCampaignId: 'cmp-s1', name: 'ONS_쇼검_의류', campaignTp: 'SHOPPING', status: 'ELIGIBLE' },
        { nccCampaignId: 'cmp-s2', name: 'ONS_쇼검_슈즈', campaignTp: 'SHOPPING', status: 'PAUSED' },
        { nccCampaignId: 'cmp-p1', name: 'ONS_파링_브랜드', campaignTp: 'WEB_SITE', status: 'ELIGIBLE' },
      ],
      get_adgroups: [
        { nccAdgroupId: 'grp-1', name: '유아레깅스', nccCampaignId: 'cmp-s1', status: 'ELIGIBLE', adgroupType: 'SHOPPING' },
        { nccAdgroupId: 'grp-2', name: '원피스_메인', nccCampaignId: 'cmp-s1', status: 'PAUSED', adgroupType: 'SHOPPING' },
        { nccAdgroupId: 'grp-brand', name: '★스스_쇼핑검색_브랜드형_층간소음', nccCampaignId: 'cmp-s1', status: 'ELIGIBLE', adgroupType: 'SHOPPING_BRAND' },
      ],
      get_ads: [
        { nccAdId: 'nad-1', userLock: false, adAttr: { bidAmt: 660, useGroupBidAmt: false }, nccQi: { qiGrade: 5 }, ad: { headline: '오즈키즈 래쉬가드', description: '자외선 차단 UPF50+ 아기 유아 수영복', pc: { final: 'https://brand.naver.com/ozkiz/search?q=래쉬가드&st=REVIEW&dt=IMAGE&nt_source=npowerlink&nt_medium=swimsuit&nt_keyword={keyword}', display: 'https://smartstore.naver.com/ozkids' } }, referenceData: { productTitle: '오즈키즈 여아 치랭스 레깅스 유아 아기', lowPrice: '16900', category3Name: '레깅스', scoreInfo: '4.9', reviewCountSum: '312', imageUrl: 'https://shopping-phinf.pstatic.net/main_8686227/86862273595.1.jpg' } },
        { nccAdId: 'nad-2', userLock: false, adAttr: { bidAmt: 510, useGroupBidAmt: false }, nccQi: { qiGrade: 3 }, referenceData: { productTitle: '오즈키즈 유아 사계절 레깅스', lowPrice: '13900', category3Name: '레깅스', scoreInfo: '4.8', reviewCountSum: '846', imageUrl: 'https://shopping-phinf.pstatic.net/main_8466870/84668700368.20.jpg' } },
        { nccAdId: 'nad-3', userLock: true, adAttr: { bidAmt: 300, useGroupBidAmt: false }, nccQi: { qiGrade: 4 }, referenceData: { productTitle: '오즈키즈 아기 짜임 레깅스', lowPrice: '11900', category3Name: '레깅스', scoreInfo: '4.7', reviewCountSum: '120', imageUrl: 'https://shopping-phinf.pstatic.net/main_8606587/86065876027.3.jpg' } },
        { nccAdId: 'nad-brand', type: 'SHOPPING_BRAND_IMAGE_BANNER_AD', userLock: false, status: 'ELIGIBLE', ad: { headline: '층간소음방지 실내화', description: '매트 깔지 말고, 신으세요', image: '/MjAyNTA1MjFfNzgg/MDAxNzQ3Nzk2MzQ1MTY5.Gtm20W67KhPMyL1lMVVekNIIq5Panqgh8mhzhZkv7T4g.wV8gsH9AotPVVvm_jaGu8MokOjNRe1cRgAOGw9e2WdQg.JPEG/434195-92a7d4b4-2214-40b0-b2da-2cc6b11b8dda.jpg', landingUrl: 'https://brand.naver.com/ozkiz/category/d59b32ff4eb74d82bdc0648e949dc573?cp=1&nt_keyword={keyword}' } },
      ],
      get_keywords: [
        { nccKeywordId: 'nkw-1', nccAdgroupId: 'grp-1', keyword: '유아 레깅스', bidAmt: 450, useGroupBidAmt: false, userLock: false, status: 'ELIGIBLE', nccQi: { qiGrade: 5 } },
        { nccKeywordId: 'nkw-2', nccAdgroupId: 'grp-1', keyword: '아기 레깅스', bidAmt: 380, useGroupBidAmt: false, userLock: false, status: 'ELIGIBLE', nccQi: { qiGrade: 4 } },
        { nccKeywordId: 'nkw-3', nccAdgroupId: 'grp-1', keyword: '키즈 레깅스', bidAmt: 0, useGroupBidAmt: true, userLock: false, status: 'ELIGIBLE', nccQi: { qiGrade: 3 } },
      ],
      get_ad_extensions: [
        { type: 'POWER_LINK_IMAGE', adExtension: { imagePath: '/MjAyNTA0MjNfMTM2/MDAxNzQ1MzcxNzAzNjkx.2cFZ2-acQgCpuPv03NPLKmFXGC1crwqs3q6oqpfw-gog.Laf2lqUNKKlJ8CzSdmZHyI8GPYarTmcm49XxStew2ZIg.JPEG/434195-68d4b235-f5ac-4a00-93b7-92213397b5f9.jpg' } },
        { type: 'POWER_LINK_IMAGE', adExtension: { imagePath: '/MjAyNTA0MjNfMTg5/MDAxNzQ1MzcxNjY1MzA5.cMp6WGkbajRQ8GwqhXTgDmOeM1hLiK8PQSPxHCq81Xcg.fE7WGEese13ZFO4ZlNqv6sZlZZcF2DjIJqqH192H4PMg.JPEG/434195-40f3562b-6534-43ff-aaae-423be4a567c2.jpg' } },
        { type: 'DESCRIPTION', adExtension: { description: '무료배송 무료교환반품' } },
        { type: 'SHOPPING_WEB', adExtension: { view: 'https://smartstore.naver.com/ozkids' } },
      ],
    };
    if (action === 'stats') {
      // 소재별 최근 성과 목데이터. impCnt/clkCnt/salesAmt/avgRnk(기본지표) + convAmt(총전환, 규칙미리보기용).
      const M = {
        'nad-1': { impCnt: 5000, clkCnt: 70, salesAmt: 100000, avgRnk: 4.2, convAmt: 680000 }, // 680% → +20%
        'nad-2': { impCnt: 900, clkCnt: 8, salesAmt: 100000, avgRnk: 6.1, convAmt: 330000 },   // 330% → 유지
      };
      return Promise.resolve({ data: [M[p && p.id] || { impCnt: 200, clkCnt: 2, salesAmt: 100000, avgRnk: 8, convAmt: 200000 }] });
    }
    if (action === 'update_ad_bid') return Promise.resolve({ ok: true });
    if (action === 'report_create') return Promise.resolve({ reportJobId: 'mock1', status: 'REGIST' });
    if (action === 'report_status') return Promise.resolve({ status: 'BUILT', downloadUrl: 'https://api.searchad.naver.com/report-download?mock' });
    if (action === 'report_download') return Promise.resolve({ tsv:
      '20260712\t434195\tcmp-a001-01-1\tgrp-a001-01-1\t키즈아쿠아슈즈\t33421\tM\t0\t8\t0\t0\t0\n' +
      '20260712\t434195\tcmp-a001-01-1\tgrp-a001-01-2\t아동레쉬가드\t27758\tP\t2\t4\t0\t0\t0\n' +
      '20260712\t434195\tcmp-a001-01-1\tgrp-a001-01-1\t남아수영복\t33421\tM\t5\t1\t0\t0\t0' });
    if (action === 'report_delete' || action === 'add_restricted_keyword' || action === 'log_bid_change') return Promise.resolve({ ok: true });
    if (action === 'collect_status') { /* handled below */ }
    if (action === 'get_bid_changes') {
      const now = Date.now();
      const ch = p && p.channel;
      const all = [
        { changed_at: new Date(now - 20 * 60000).toISOString(), channel: 'shopping', entity_id: 'nad-1', name: '오즈키즈 여아 치랭스 레깅스', old_bid: 660, new_bid: 540 },
        { changed_at: new Date(now - 26 * 3600000).toISOString(), channel: 'shopping', entity_id: 'nad-2', name: '오즈키즈 유아 사계절 레깅스', old_bid: 510, new_bid: 560 },
        { changed_at: new Date(now - 35 * 60000).toISOString(), channel: 'powerlink', entity_id: 'nkw-1', name: '유아 레깅스', old_bid: 450, new_bid: 520 },
        { changed_at: new Date(now - 50 * 3600000).toISOString(), channel: 'powerlink', entity_id: 'nkw-2', name: '아기 레깅스', old_bid: 380, new_bid: 300 },
      ];
      return Promise.resolve({ changes: all.filter(c => !ch || c.channel === ch) });
    }
    if (action === 'collect_status') {
      const now = Date.now(), day = 86400000;
      const dstr = (n) => new Date(now - n * day + 9 * 3600000).toISOString().slice(0, 10);
      return Promise.resolve({
        lastRun: { at: new Date(now - 40 * 60000).toISOString(), ads: 44 },
        runs: [0, 6, 12, 18, 24].map(h => ({ at: new Date(now - h * 3600000).toISOString(), ads: 44 })),
        daily: [
          { stat_dt: dstr(5), cost: 512000, convCnt: 22, convVal: 2300000, roas: 449 },
          { stat_dt: dstr(4), cost: 498000, convCnt: 18, convVal: 1560000, roas: 313 },
          { stat_dt: dstr(3), cost: 470000, convCnt: 12, convVal: 1080000, roas: 230 },
          { stat_dt: dstr(2), cost: 505000, convCnt: 20, convVal: 1910000, roas: 378 },
          { stat_dt: dstr(1), cost: 488000, convCnt: 24, convVal: 2440000, roas: 500 },
        ],
        alerts: [
          { created_at: new Date(now - 2 * 3600000).toISOString(), kind: 'budget_spike', ref: 'ONS_쇼검_의류', detail: { today: 182000, ratio: '3.2', hour: 12 } },
          { created_at: new Date(now - 26 * 3600000).toISOString(), kind: 'landing_error', ref: 'https://ozkiz.com/product/detail.html?product_no=999', detail: { status: 404, ez_name: '유아 레깅스 3종' } },
        ],
      });
    }
    return Promise.resolve(D[action] || []);
  }
})();
