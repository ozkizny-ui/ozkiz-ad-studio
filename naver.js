/* naver.js — 네이버 검색광고 탭 (ad-studio 편입, 메타 코드와 분리).
 * 슬라이스1: 플랫폼 토글 + 서브탭(입찰/제외제안) + 입찰 대시보드 읽기뷰.
 * 실데이터는 /api/naver 프록시. ?navermock=1 이면 목데이터로 UI만 검증.
 * 쓰기(입찰변경)는 다음 슬라이스에서 sb_write_token(Bearer)로 게이트 통과.
 */
(function () {
  'use strict';
  const PROXY = 'https://ozkiz-proxy.vercel.app';
  const MOCK = /[?&]navermock=1/.test(location.search);
  const TARGET_ROAS = 250; // 목표 구매 ROAS(%). 이 값 기준으로 입찰 상·하향 + ROAS 색상. 변경 시 시뮬→확인→배포.
  // 오가닉(비광고) 쇼핑순위 = 키워드 대시보드 brandboard_rank 엔드포인트(브랜드보드 Supabase 매일수집). 크로스앱 GET.
  const KWDASH = 'https://script.google.com/macros/s/AKfycbwxeD3Ofxr1r5Aq6ZZUmt64B48lVSeq757jh5r0wWJRf1T1tycMU6NN50p7odBgqw_xhw/exec';
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
    // root 지연 초기화 (2026-07-21 버그 수정): #naver-* 해시로 콜드 로드 시 index.html의
    // routeHash()가 init()보다 먼저 open()을 호출 — root가 없으면 여기서 TypeError가 나며
    // 메타 페이지만 숨긴 채 죽고, 이후 init의 open()은 isOpen 가드에 걸려 naver-root를
    // 영영 표시하지 않았음(새로고침·딥링크 진입 시 완전 빈 화면의 원인).
    if (!root) root = document.getElementById('naver-root');
    if (!root) return;
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
  let dashCamp = ''; // ''=전체, 아니면 선택 캠페인만 표시
  // 표시 필터 (2026-07-23 UI 정리): 상태 세그먼트(전체/ON/OFF) + 타일 클릭 필터(미노출·변경대상)
  let dashStatus = 'on', dashFNoimp = false, dashFChanged = false; // 기본 ON(기존 화면과 동일) — OFF 868개가 기본 노출되면 과밀
  // 데이터 기간 (2026-07-23): 0=오늘(부분집계), 3/7/30=완결일 기준 최근 N일. 지표·구매전환 모두 이 기간.
  let dashDays = 3; // 기본 최근 3일 (2026-07-23 사용자 지정)
  // 뷰 모드 (2026-07-29 대표님 요청): 시트(한 줄=한 소재, 광고순위·오가닉 나란히)가 기본. 카드/키워드로 전환 가능.
  let dashView = localStorage.getItem('nv_dash_view') || 'sheet';
  let dashSort = { key: 'cost', dir: -1 }; // 시트 컬럼 정렬 상태 (기본: 총비용 내림차순)
  // 키워드 기준 뷰 (2026-07-29 대표님 요청 2차): 행=추적 키워드, 오가닉 순위 + 검색어 보고서 실측 광고 노출
  let kwSort = { key: 'vol', dir: -1 };        // 키워드 뷰 정렬 (기본: 주간검색수 내림차순)
  let kwFilter = { vol: 0, org: 'all', ad: 'all' }; // 키워드 뷰 필터 (2026-07-29: 검색량 하한·오가닉 1순위·광고 랭킹)
  let organicKwCache = null;                    // {keyword: {vol, products:[{pid,title,rank}]}} — 순위권 밖 키워드 포함
  let nvTermsCache = null, nvTermsTs = null;    // nv_search_terms 행 캐시 + 마지막 업로드 시각(null=조회 전, []=미업로드)
  let nvTermIdxCache = null;                    // {검색어: {list:[{adgroup,imp,clk,cost,conv_value}], imp}} 지연 계산
  let dashFlat = [];       // 시트 행 인덱스 → {camp, grName, it} (행 클릭 시 카드 상세 펼침용)
  let lastDash = null;     // 마지막 렌더 인자(뷰 토글 시 데이터 재수집 없이 재렌더)
  let organicLast = null;  // 마지막 오가닉 맵(재렌더·상세 펼침 후 재주입용)
  const PERIODS = [[0, '오늘'], [3, '3일'], [7, '일주일'], [30, '한 달']];
  const periodLabel = () => dashDays === 0 ? '오늘' : `최근 ${dashDays}일`;
  const periodRange = () => dashDays === 0
    ? { since: isoAgo(0), until: isoAgo(0) }   // 오늘(집계 지연 가능)
    : { since: isoAgo(dashDays), until: isoAgo(1) }; // 어제까지 완결 N일
  async function renderBid() {
    const body = $('#nv-body'); injectNvCss();
    // ⚡ 캐시 우선 렌더 (2026-07-29 대표님 요청): 직전 로드 결과를 0초에 먼저 표시 → 배경에서 최신 수집 후 교체
    const cached = readDashCache();
    let staleShown = false;
    if (cached && !MOCK) {
      try {
        if (!purchaseKwCache) purchaseKwCache = cached.purchaseKw || null; // 브랜드형 키워드 ROAS 표시용(세션 캐시 없을 때만)
        if (!organicKwCache && cached.organicKw) organicKwCache = cached.organicKw; // 키워드 뷰 즉시 표시용
        renderDashboard(body, cached.structure, cached.statsMap, cached.purchase, { staleTs: cached.ts });
        injectOrganic(cached.organic);
        staleShown = true;
      } catch (e) { try { localStorage.removeItem(dashCacheKey()); } catch {} }
    }
    if (!staleShown) body.innerHTML = loading('운영중 쇼핑 캠페인·상품 불러오는 중…');
    const staleMsg = (t) => { const el = document.getElementById('nvc-stale'); if (el) el.innerHTML = t; };
    try {
      const camps = await apiR('get_campaigns');
      // 캠페인은 운영중만(기존 유지). 그룹·소재·키워드는 정지 포함 전부 수집 (2026-07-23:
      // "캠페인 ON + 세트 OFF" 광고도 보이게 — 표시는 상태 세그먼트 전체/ON/OFF로 필터)
      const shopCamps = camps.filter(c => c.campaignTp === 'SHOPPING' && isRunning(c)).sort(runningFirst);
      if (!shopCamps.length) { body.innerHTML = '<div style="color:var(--muted);padding:20px">운영중 쇼핑검색 캠페인이 없어요.</div>'; return; }
      // 구조: 캠페인 → 그룹(정지 포함) → 상품형=소재 / 브랜드형(SHOPPING_BRAND)=키워드(파워링크식)
      // 동시호출 제한(캠페인 3 · 그룹 4) + 재시도로 네이버 rate limit 회피.
      let structure = await mapLimit(shopCamps, 3, async c => {
        const gs = (await apiR('get_adgroups', { params: { nccCampaignId: c.nccCampaignId } }).catch(() => [])) || [];
        const groups = await mapLimit(gs, 4, async g => {
          if (g.adgroupType === 'SHOPPING_BRAND') { // 브랜드형쇼검 = 키워드 입찰(파워링크와 동일)
            const [kws, extR, adsR] = await Promise.all([
              apiR('get_keywords', { params: { nccAdgroupId: g.nccAdgroupId } }).catch(() => []),
              apiR('get_ad_extensions', { params: { ownerId: g.nccAdgroupId } }).catch(() => []),
              apiR('get_ads', { params: { nccAdgroupId: g.nccAdgroupId } }).catch(() => []),
            ]);
            return { group: g, isBrand: true, kws: kws || [], exts: Array.isArray(extR) ? extR : (extR.data || []), banner: Array.isArray(adsR) ? adsR : (adsR.data || []) };
          }
          const ads = (await apiR('get_ads', { params: { nccAdgroupId: g.nccAdgroupId } }).catch(() => [])) || [];
          return { group: g, isBrand: false, ads };
        });
        return { camp: c, groups: groups.filter(x => x.isBrand ? x.kws.length : x.ads.length) };
      });
      // 기본지표+순위: /stats 배치(빠름) → 즉시 렌더. 구매전환(직접)은 뒤에서 채움(progressive)
      structure = structure.filter(s => s.groups.length);
      const ids = structure.flatMap(s => s.groups.flatMap(g => g.isBrand ? g.kws.map(k => k.nccKeywordId) : g.ads.map(a => a.nccAdId)));
      const statsMap = await loadStatsBatch(ids);
      const finishFresh = (p) => { // 최신 데이터 렌더 + 오가닉 주입 + 캐시 저장
        if (sub !== 'shopbid') return;
        renderDashboard(body, structure, statsMap, p);
        loadOrganicRanks().then(m => { injectOrganic(m); writeDashCache(structure, statsMap, p, m); })
          .catch(() => writeDashCache(structure, statsMap, p, null));
      };
      if (staleShown) {
        // 캐시 표시 중엔 중간(ROAS 집계 전) 렌더로 되돌리지 않고, 구매전환까지 끝난 뒤 한 번에 교체
        staleMsg('⚡ 캐시 표시 중 · 최신 구매전환 집계 중…');
        const p = await loadPurchase7d(t => staleMsg('⚡ 캐시 표시 중 · ' + t)).catch(() => null);
        if (p) finishFresh(p);
        else { renderDashboard(body, structure, statsMap, null); loadOrganicRanks().then(injectOrganic).catch(() => {}); }
      } else {
        renderDashboard(body, structure, statsMap, null);
        loadPurchase7d().then(p => { if (document.getElementById('nvc-dash')) finishFresh(p); }).catch(() => {});
        loadOrganicRanks().then(injectOrganic).catch(() => {}); // 첫 렌더에도 주입(재렌더 후 재주입)
      }
    } catch (e) { if (staleShown) staleMsg('⚠️ 최신 데이터 갱신 실패 — 아래는 이전 캐시입니다. ' + esc(e.message || String(e))); else body.innerHTML = errBox(e); }
  }
  // ── 대시보드 로컬 캐시 (2026-07-29): 마지막 로드 결과 저장 → 재방문 시 즉시 표시(stale-while-revalidate) ──
  //    한 건이 ~1.2MB라 기간별로 쌓으면 localStorage 5MB 한도 위험 — 마지막 사용 기간 1개만 유지.
  const dashCacheKey = () => 'nv_dash_cache';
  function readDashCache() {
    try {
      const j = JSON.parse(localStorage.getItem(dashCacheKey()) || 'null');
      if (!j || !j.ts || j.days !== dashDays || !Array.isArray(j.structure) || Date.now() - j.ts > 48 * 3600000) return null; // 기간 불일치·48h 경과 캐시는 미사용
      return j;
    } catch { return null; }
  }
  function writeDashCache(structure, statsMap, purchase, organic) {
    // 렌더에 필요한 필드만 남긴 경량 사본(원본 referenceData 전체는 수 MB — localStorage quota 방지)
    const pick = (o, ks) => { const r = {}; ks.forEach(k => { if (o && o[k] != null) r[k] = o[k]; }); return r; };
    try {
      const lite = structure.map(s => ({
        camp: pick(s.camp, ['nccCampaignId', 'name', 'status']),
        groups: s.groups.map(gr => ({
          isBrand: gr.isBrand,
          group: pick(gr.group, ['nccAdgroupId', 'name', 'status', 'adgroupType']),
          ads: gr.isBrand ? undefined : gr.ads.map(a => ({
            ...pick(a, ['nccAdId', 'userLock', 'status', 'statusReason']),
            adAttr: a.adAttr ? pick(a.adAttr, ['bidAmt']) : undefined,
            nccQi: a.nccQi ? pick(a.nccQi, ['qiGrade']) : undefined,
            referenceData: a.referenceData ? pick(a.referenceData, ['productTitle', 'imageUrl', 'mallProductId', 'mallProductUrl', 'category2Name', 'category3Name', 'scoreInfo', 'reviewCountSum', 'lowPrice']) : undefined,
            ad: a.ad ? pick(a.ad, ['headline', 'image', 'description', 'landingUrl']) : undefined,
          })),
          kws: gr.isBrand ? gr.kws.map(k => ({ ...pick(k, ['nccKeywordId', 'nccAdgroupId', 'keyword', 'userLock', 'status', 'useGroupBidAmt', 'bidAmt']), nccQi: k.nccQi ? pick(k.nccQi, ['qiGrade']) : undefined })) : undefined,
          exts: gr.isBrand ? gr.exts : undefined,
          banner: gr.isBrand ? gr.banner : undefined,
        })),
      }));
      localStorage.setItem(dashCacheKey(), JSON.stringify({ ts: Date.now(), days: dashDays, structure: lite, statsMap, purchase, purchaseKw: purchaseKwCache, organic, organicKw: organicKwCache }));
    } catch (e) { try { localStorage.removeItem(dashCacheKey()); } catch {} } // quota 초과 등 — 캐시 없이 동작(치명 아님)
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
        const r = await apiR('stats', { params: { ids: ch.join(','), fields: JSON.stringify(['impCnt', 'clkCnt', 'salesAmt', 'avgRnk']), timeRange: JSON.stringify(periodRange()) } });
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
.nvc-d{font-size:10.5px;font-weight:800;padding:1px 6px;border-radius:6px}
.nvs-wrap{overflow:auto;border:1px solid var(--border);border-radius:12px;background:var(--surface);max-height:calc(100vh - 130px)}
.nvs-wrap table{border-collapse:collapse;width:100%;font-size:12px;table-layout:fixed}
.nvs-wrap thead th{position:sticky;top:0;background:var(--surface2);padding:7px 9px;font-weight:700;color:var(--text2);text-align:left;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;border-bottom:1px solid var(--border2);z-index:2;user-select:none}
.nvs-wrap thead th[data-key]{cursor:pointer}
.nvs-wrap thead th[data-key]:hover{color:var(--accent-d)}
.nvs-wrap td{padding:4px 9px;border-bottom:1px solid var(--border);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;vertical-align:middle}
.nvc-srow{cursor:pointer}
.nvc-srow:hover td{background:var(--surface2)}
.nvs-th36{width:32px;height:32px;border-radius:7px;object-fit:cover;background:var(--surface2);display:block}
.nvs-nm{font-weight:600}
.nvs-oc{display:inline-block;border-radius:6px;padding:1px 6px;font-weight:700;font-size:10.5px;margin-right:3px}
.nvs-oc.t{background:var(--green-l);color:var(--green)}
.nvs-oc.m{background:var(--amber-l,rgba(245,158,11,.12));color:var(--amber,#B45309)}
.nvs-oc.l{background:var(--surface2);color:var(--muted)}
.nvs-oc.a{background:var(--accent-l);color:var(--accent-d)}
.nvs-grip{position:absolute;right:0;top:0;bottom:0;width:9px;cursor:col-resize;z-index:4}
.nvs-grip:hover{background:linear-gradient(to right,transparent 3px,var(--accent) 3px,var(--accent) 6px,transparent 6px)}
.nvk-th{width:22px;height:22px;border-radius:5px;object-fit:cover;flex:none;background:var(--surface2)}`;
  function injectNvCss() { if (document.getElementById('nv-css')) return; const s = document.createElement('style'); s.id = 'nv-css'; s.textContent = NV_CSS; document.head.appendChild(s); }
  function renderDashboard(body, structure, statsMap, purchase, opts) {
    opts = opts || {};
    lastDash = { body, structure, statsMap, purchase, opts }; // 뷰 토글 시 재렌더용
    const mod = dayModifier(), pending = !purchase;
    nvSuggestions = [];
    let gCost = 0, gConvV = 0, gConvN = 0, prodCount = 0;
    structure.forEach(s => {
      s.groups.forEach(gr => {
        const gOff = !isRunning(gr.group); // 그룹(세트) OFF — 표시는 하되 입찰 제안 제외 (2026-07-23)
        if (gr.isBrand) { // 브랜드형쇼검 = 키워드 입찰(파워링크식)
          gr.items = gr.kws.map(kw => {
            const b = statsMap[kw.nccKeywordId] || { imp: 0, clk: 0, cost: 0, rank: 0 };
            const pc = purchase ? ((purchaseKwCache && purchaseKwCache[kw.nccKeywordId]) || { cnt: 0, val: 0 }) : null;
            const ctr = b.imp ? b.clk / b.imp * 100 : 0, cpc = b.clk ? b.cost / b.clk : 0;
            const roas = (pc && b.cost) ? pc.val / b.cost * 100 : null;
            const grp = kw.useGroupBidAmt === true, cur = grp ? null : Number(kw.bidAmt), hasBid = !grp && Number.isFinite(cur);
            const nb = (!pending && hasBid && !gOff && kw.userLock !== true && b.cost && roas != null) ? computeBid(cur, roas, mod.mod) : cur;
            if (!pending && hasBid && !gOff && nb !== cur && kw.userLock !== true) nvSuggestions.push({ kind: 'kw', id: kw.nccKeywordId, adgroupId: kw.nccAdgroupId, cur, nb, name: kw.keyword });
            gCost += b.cost; if (pc) { gConvV += pc.val; gConvN += pc.cnt; } prodCount++;
            return { kw, b, pc, ctr, cpc, roas, cur, nb, pending, grp, gOff };
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
            const nb = (!pending && hasBid && !gOff && a.userLock !== true && (!a.status || a.status === 'ELIGIBLE') && b.cost && roas != null) ? computeBid(cur, roas, mod.mod) : cur;
            if (!pending && hasBid && !gOff && nb !== cur && a.userLock !== true && (!a.status || a.status === 'ELIGIBLE')) nvSuggestions.push({ kind: 'ad', id: a.nccAdId, cur, nb, name: (a.referenceData && a.referenceData.productTitle) || (a.ad && a.ad.headline) || a.nccAdId });
            gCost += b.cost; if (pc) { gConvV += pc.val; gConvN += pc.cnt; } prodCount++;
            return { a, b, pc, ctr, cpc, roas, cur, nb, pending, hasBid, gOff };
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
    // 뷰 분기 (2026-07-29): 시트=상품형 소재를 한 줄씩 한 표로(광고순위·오가닉 나란히), 키워드=행이 추적 키워드,
    // 브랜드형 섹션은 두 시트 뷰 모두 아래에 그대로. gsecHtml·buildDashFlat은 모듈 스코프(swapProdView와 공유).
    let sections;
    if (dashView === 'sheet' || dashView === 'kw') {
      dashFlat = buildDashFlat(structure); // 키워드 뷰에서도 칩 클릭 → 카드 상세용으로 필요
      const brandSecs = structure.flatMap(s => s.groups.filter(g => g.isBrand).map(gr => gsecHtml(s, gr))).join('');
      sections = (dashView === 'kw' ? kwTable() : sheetTable()) + brandSecs;
    } else {
      sections = structure.map(s => s.groups.map(gr => gsecHtml(s, gr)).join('')).join('');
    }
    // 스냅샷 소스(상품형만) — '📋 스냅샷 복사' 버튼용 (2026-07-28)
    nvSnapProducts = [];
    nvSnapPending = pending; // 구매전환 집계 전이면 ROAS가 비므로 복사 시 경고
    structure.forEach(s => s.groups.forEach(gr => {
      if (gr.isBrand) return;
      gr.items.forEach(it => {
        const a = it.a;
        const paused = it.gOff || a.userLock === true;
        const sysP = !paused && a.status && a.status !== 'ELIGIBLE';
        const rdS = a.referenceData || {}, adcS = a.ad || {};
        nvSnapProducts.push({
          id: a.nccAdId,
          name: rdS.productTitle || adcS.headline || a.nccAdId,
          thumb: rdS.imageUrl || (adcS.image ? (/^https?:/.test(adcS.image) ? adcS.image : EXT_IMG + adcS.image) : ''),
          pid: rdS.mallProductId || '', // 오가닉 순위 매칭키(스마트스토어 상품번호)
          group: gr.group.name, camp: s.camp.name,
          cost: it.b.cost, imp: it.b.imp, rank: it.b.rank || 0,
          roas: (!it.pending && it.b.cost) ? Math.round(it.roas) : null,
          paused, gOff: it.gOff, sysP, noImp: !paused && !sysP && !it.b.imp,
        });
      });
    }));

    // 상태 카운트: ON=운영중(그룹·소재 모두), OFF=그룹 OFF 또는 소재 정지. 미노출=ON인데 기간 노출 0
    let gNoImp = 0, cntOn = 0, cntOff = 0;
    structure.forEach(s => s.groups.forEach(gr => gr.items.forEach(it => {
      const paused = it.gOff || (gr.isBrand ? (it.kw.userLock === true || !isRunning(it.kw)) : (it.a.userLock === true));
      const sysP = !paused && !gr.isBrand && it.a.status && it.a.status !== 'ELIGIBLE'; // 네이버 시스템 중지(연동 이상 등)
      if (paused) cntOff++; else { cntOn++; if (sysP || !it.b.imp) gNoImp++; }
    })));
    const periodChips = PERIODS.map(([d, lbl]) =>
      `<button class="nvf-period" data-d="${d}" style="${chipStyle(dashDays === d)}">${lbl}</button>`).join('');
    const segBtn = (v, lbl) => `<button class="nvf-status" data-v="${v}" style="border:none;background:${dashStatus === v ? 'var(--accent)' : 'transparent'};color:${dashStatus === v ? '#fff' : 'var(--muted)'};padding:8px 13px;font-size:12px;font-weight:700;cursor:pointer">${lbl}</button>`;
    const campSel = `<select id="nvf-campsel" style="padding:8px 10px;border:1px solid var(--border2);border-radius:9px;background:var(--surface);color:var(--text);font-size:12.5px;font-weight:600;max-width:230px">
      <option value="">전체 캠페인</option>
      ${structure.map(s => `<option value="${s.camp.nccCampaignId}" ${dashCamp === s.camp.nccCampaignId ? 'selected' : ''}>${esc(s.camp.name)}</option>`).join('')}</select>`;
    // 미노출 필터 = 반영 버튼 옆 미니 칩 (2026-07-29: 타일에서 이동, 변경대상 타일은 제거 — 제안 수는 반영 버튼에 표시됨)
    const noimpCss = (on) => `padding:8px 12px;border-radius:9px;border:1px solid ${on ? 'var(--amber, #B45309)' : 'var(--border2)'};background:${on ? 'var(--amber-l, rgba(245,158,11,.12))' : 'var(--surface)'};color:var(--amber, #B45309);cursor:pointer;font-weight:700;font-size:12px;white-space:nowrap`;
    const agoTxt = (ts) => { const m = Math.max(1, Math.round((Date.now() - ts) / 60000)); return m < 60 ? m + '분' : (Math.round(m / 6) / 10) + '시간'; };
    const staleNote = opts.staleTs ? `<div id="nvc-stale" style="margin-bottom:10px;font-size:12px;font-weight:700;color:var(--green);background:var(--green-l);border-radius:9px;padding:7px 11px">⚡ ${agoTxt(opts.staleTs)} 전 데이터를 먼저 표시했어요 · 최신 데이터 불러오는 중…</div>` : '';
    const viewBtn = (v, lbl) => `<button class="nvf-view" data-v="${v}" style="border:none;background:${dashView === v ? 'var(--accent)' : 'transparent'};color:${dashView === v ? '#fff' : 'var(--muted)'};padding:8px 13px;font-size:12px;font-weight:700;cursor:pointer">${lbl}</button>`;
    const viewSeg = `<div style="display:flex;border:1px solid var(--border2);border-radius:9px;overflow:hidden;background:var(--surface)">${viewBtn('sheet', '☰ 제품')}${viewBtn('kw', '🔑 키워드')}${viewBtn('card', '⊞ 카드')}</div>`;
    body.innerHTML = `
      ${staleNote}
      <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-bottom:10px">
        <span style="font-size:12px;color:var(--muted);font-weight:700">📅 데이터 기간</span>
        ${periodChips}
        <span style="font-size:11px;color:var(--muted);margin-left:auto">${dashDays === 0 ? '오늘은 집계 지연으로 실제보다 낮게 보일 수 있어요 · ' : '어제까지 완결 ' + dashDays + '일 · '}${mod.label} 보정 · 비용 많은 순</span>
      </div>
      <div class="nvc-tiles" style="grid-template-columns:repeat(3,1fr)">
        <div class="nvc-tile"><div class="k">총비용 (${periodLabel()})</div><div class="v">${won(gCost)}</div></div>
        <div class="nvc-tile"><div class="k">구매 ROAS <span style="color:var(--muted);font-weight:400">직접 · ${periodLabel()}</span></div><div class="v" style="color:${pending ? 'var(--muted)' : (gRoas >= TARGET_ROAS ? 'var(--green)' : 'var(--red)')}">${pending ? '<span style="font-size:13px">집계 중…</span>' : (gCost ? Math.round(gRoas) + '%' : '-')}</div></div>
        <div class="nvc-tile"><div class="k">구매 전환 (${periodLabel()})</div><div class="v">${pending ? '<span style="color:var(--muted);font-size:13px">집계 중…</span>' : gConvN + '건 · ' + cnt(gConvV) + '원'}</div></div>
      </div>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:12px">
        ${viewSeg}
        <input id="nvf-q" placeholder="🔎 상품명 검색" style="padding:7px 10px;border:1px solid var(--border2);border-radius:9px;background:var(--surface);color:var(--text);font-size:13px;min-width:180px">
        <div style="display:flex;border:1px solid var(--border2);border-radius:9px;overflow:hidden;background:var(--surface)">
          ${segBtn('all', `전체 ${cntOn + cntOff}`)}${segBtn('on', `🟢 ON ${cntOn}`)}${segBtn('off', `⚪ OFF ${cntOff}`)}
        </div>
        ${campSel}
        <button id="nvc-snapshot" title="현재 라이브 상품형 광고 + 최근 2주 ON/OFF 기록을 표(TSV)로 복사 — 시트에 바로 붙여넣기" style="margin-left:auto;padding:8px 14px;border-radius:10px;border:1px solid var(--border2);background:var(--surface);color:var(--text2);cursor:pointer;font-weight:700;font-size:12.5px">📋 스냅샷 복사</button>
        <span id="nvc-selmeta" style="font-size:12px;color:var(--muted);${(!pending && nvSuggestions.length && !opts.staleTs) ? '' : 'display:none'}"><a href="javascript:void(0)" id="nvc-selnone" style="color:var(--accent-d);font-weight:700;text-decoration:none">전체 해제</a></span>
        <button id="nvf-noimp" style="${noimpCss(dashFNoimp)}">🟡 미노출 ${gNoImp}</button>
        <button id="nvc-applyall" style="${pBtn}" ${(!pending && nvSuggestions.length && !opts.staleTs) ? '' : 'disabled'}>${opts.staleTs ? '⚡ 최신 데이터 갱신 중…' : pending ? '⏳ 구매전환 집계 중…' : (nvSuggestions.length ? `▶ ${nvSuggestions.length}건 입찰가 반영` : '변경 대상 없음')}</button>
      </div>
      <div id="nvc-dash">${sections}</div>
      <div id="nvc-history" style="margin-top:18px;border-top:1px solid var(--border);padding-top:8px"></div>`;
    const q = $('#nvf-q');
    const applyFilters = () => {
      const term = (q.value || '').toLowerCase();
      document.querySelectorAll('.nvc-card[data-title], .nvc-krow[data-title], .nvc-srow[data-title]').forEach(el => {
        const stOk = dashStatus === 'all' || el.dataset.status === dashStatus;
        const isSrow = el.classList.contains('nvc-srow');
        const campOk = !isSrow || !dashCamp || el.dataset.camp === dashCamp; // 시트 행은 gsec 밖이라 캠페인 필터를 행에서 직접
        const vis = (!term || el.dataset.title.includes(term)) && (!dashFChanged || el.dataset.changed === '1') && (!dashFNoimp || el.dataset.noimp === '1') && stOk && campOk;
        el.style.display = vis ? '' : 'none';
        if (isSrow) { // 딸린 상세(카드 펼침)·이력 행도 함께 숨김/표시
          let n = el.nextElementSibling;
          while (n && !n.classList.contains('nvc-srow')) { n.style.display = vis ? '' : 'none'; n = n.nextElementSibling; }
        }
      });
      applyKwRowFilters(); // 키워드 뷰: 검색어 + 키워드 전용 필터(검색량·오가닉·광고랭킹) — 상태·캠페인 필터는 소재 대상이라 무관
      document.querySelectorAll('.nvc-gsec').forEach(sec => {
        const campMatch = !dashCamp || sec.dataset.camp === dashCamp; // 선택 캠페인만
        const anyVis = [...sec.querySelectorAll('.nvc-card, .nvc-krow')].some(c => c.style.display !== 'none');
        sec.style.display = (campMatch && anyVis) ? '' : 'none';
      });
    };
    if (q) q.oninput = applyFilters;
    // 미노출 미니 필터 — 소재(제품·카드 뷰) 대상이라 키워드 뷰에선 비활성 표시 (2026-07-29)
    const tNo = $('#nvf-noimp');
    const setTileMode = () => {
      const kwMode = dashView === 'kw';
      if (!tNo) return;
      tNo.style.cssText = noimpCss(dashFNoimp) + (kwMode ? ';opacity:.45;cursor:default' : '');
      tNo.title = kwMode ? '제품·카드 뷰 전용 필터 (키워드 뷰에는 소재 행이 없어요)' : '클릭하면 미노출(기간 내 노출 0)만 보기';
    };
    if (tNo) tNo.onclick = () => { if (dashView === 'kw') return; dashFNoimp = !dashFNoimp; setTileMode(); applyFilters(); };
    setTileMode();
    // 상태 세그먼트 (전체/ON/OFF)
    document.querySelectorAll('.nvf-status').forEach(b => b.onclick = () => {
      dashStatus = b.dataset.v;
      document.querySelectorAll('.nvf-status').forEach(x => { const on = x.dataset.v === dashStatus; x.style.background = on ? 'var(--accent)' : 'transparent'; x.style.color = on ? '#fff' : 'var(--muted)'; });
      applyFilters();
    });
    const csel = $('#nvf-campsel'); if (csel) csel.onchange = () => { dashCamp = csel.value; applyFilters(); };
    document.querySelectorAll('.nvf-period').forEach(b => b.onclick = () => { dashDays = +b.dataset.d; renderBid(); });
    // 뷰 토글 (시트↔카드) — 상품 뷰만 부분 재렌더(swapProdView), 브랜드형 표는 DOM 재사용 → 즉시 전환
    document.querySelectorAll('.nvf-view').forEach(b => b.onclick = () => {
      if (dashView === b.dataset.v || !lastDash) return;
      dashView = b.dataset.v; localStorage.setItem('nv_dash_view', dashView);
      document.querySelectorAll('.nvf-view').forEach(x => { const on = x.dataset.v === dashView; x.style.background = on ? 'var(--accent)' : 'transparent'; x.style.color = on ? '#fff' : 'var(--muted)'; });
      if (!swapProdView()) { // 폴백: 부분 재렌더 불가 시 전체 재렌더(기존 방식)
        renderDashboard(lastDash.body, lastDash.structure, lastDash.statsMap, lastDash.purchase, lastDash.opts);
        if (organicLast) injectOrganic(organicLast);
        return;
      }
      // 새로 만든 상품 뷰만 재와이어링(브랜드형 노드는 리스너 유지된 채 이동됨)
      document.querySelectorAll('#nvc-dash .nv-hist').forEach(x => x.onclick = () => toggleEntityHistory(x));
      if (!opts.staleTs) {
        document.querySelectorAll('.nvc-cb').forEach(cb => cb.onchange = updateApplyBtn);
        if (!pending && nvSuggestions.length) updateApplyBtn(); // 체크박스가 전체선택으로 리셋되므로 카운트 갱신
      }
      if (dashView === 'sheet') wireSheet();
      else if (dashView === 'kw') wireKwSheet();
      setTileMode(); // 키워드 뷰=타일 필터 비활성 표시, 제품·카드 뷰=필터 상태 복원
      if (organicLast) injectOrganic(organicLast);
      injectRecentChanges();
      applyFilters();
    });
    if (dashView === 'sheet') wireSheet();
    else if (dashView === 'kw') wireKwSheet();
    document.querySelectorAll('.nv-hist').forEach(b => b.onclick = () => toggleEntityHistory(b));
    const snapBtn = $('#nvc-snapshot'); if (snapBtn) snapBtn.onclick = () => nvcSnapshot(snapBtn);
    const updateApplyBtn = () => { const n = document.querySelectorAll('.nvc-cb:checked').length; const bt = $('#nvc-applyall'); if (bt) { bt.disabled = !n; bt.textContent = n ? `▶ 선택 ${n}건 입찰가 반영` : '선택된 항목 없음'; } };
    if (!opts.staleTs) { // 캐시(스테일) 표시 중엔 입찰 반영 비활성 — 최신 데이터 렌더 후 활성화
      document.querySelectorAll('.nvc-cb').forEach(cb => cb.onchange = updateApplyBtn);
      const btn = $('#nvc-applyall'); if (btn) { btn.onclick = () => applyAll(); if (!pending && nvSuggestions.length) updateApplyBtn(); }
      const selN = $('#nvc-selnone'); if (selN) selN.onclick = () => { const cbs = [...document.querySelectorAll('.nvc-cb')]; const anyOn = cbs.some(c => c.checked); cbs.forEach(c => c.checked = !anyOn); updateApplyBtn(); selN.textContent = anyOn ? '전체 선택' : '전체 해제'; };
    }
    document.querySelectorAll('.nvp-off').forEach(b => b.onclick = () => togglePowerKw(b)); // 브랜드형 키워드 OFF/ON
    document.querySelectorAll('.nv-urlcopy').forEach(b => b.onclick = () => { navigator.clipboard.writeText(b.dataset.url).then(() => { const t = b.textContent; b.textContent = '✓'; setTimeout(() => b.textContent = t, 1200); }); });
    applyFilters(); // 유지 중인 필터 상태(세그먼트·타일·캠페인) 재적용
    loadBidHistory('shopping', 'nvc-history');
    injectRecentChanges(); // 카드·행의 '최근 변경' 상시 표시 채우기
  }
  function fullCard(it) {
    const a = it.a, rd = a.referenceData || {}, adc = a.ad || {}, paused = a.userLock === true || it.gOff, pend = it.pending;
    const d = (it.hasBid && !pend) ? it.nb - it.cur : 0, pct = it.cur ? Math.round(d / it.cur * 100) : 0, changed = !pend && it.hasBid && d !== 0;
    // 소재 종류: 상품형=referenceData / 브랜드형=ad(headline·image·landingUrl)
    const title = rd.productTitle || adc.headline || a.nccAdId;
    const thumb = rd.imageUrl || (adc.image ? (/^https?:/.test(adc.image) ? adc.image : EXT_IMG + adc.image) : '');
    const landing = rd.mallProductUrl || adc.landingUrl || '';
    const meta = [(rd.category3Name || rd.category2Name) ? `<span class="nvc-chip">${esc(rd.category3Name || rd.category2Name)}</span>` : '', !it.hasBid ? '<span class="nvc-chip" style="background:var(--surface2);color:var(--muted)">브랜드형</span>' : '', rd.scoreInfo ? `<span style="color:#E9A23B;font-weight:700">★ ${esc(rd.scoreInfo)}</span>` : '', rd.reviewCountSum ? `<span>리뷰 ${cnt(rd.reviewCountSum)}</span>` : '', rd.lowPrice ? `<span>· ${cnt(rd.lowPrice)}원</span>` : ''].join('');
    // 상태 판정 (2026-07-27 보강): 사람이 끈 것(userLock·그룹OFF)과 별개로, 네이버가 중지시킨
    // 시스템 중지(status=PAUSED인데 userLock=false — 예: AD_ABNORMAL_INTERLOCK 소재 연동 이상)를 구분.
    // 토글은 ON이므로 세그먼트는 ON에 두되 🚫 배지 + 미노출 필터에 포함(조치 필요 신호).
    const SYS_REASON = { AD_ABNORMAL_INTERLOCK: '소재 연동 이상', AD_UNDER_REVIEW: '검토 중', AD_REJECTED: '미승인' };
    const sysPaused = !paused && a.status && a.status !== 'ELIGIBLE';
    const sysLabel = sysPaused ? (SYS_REASON[a.statusReason] || a.statusReason || '시스템 중지') : '';
    const noImp = !paused && !sysPaused && !it.b.imp;
    const statusPill = paused
      ? `<span style="font-size:10.5px;font-weight:800;padding:2px 8px;border-radius:999px;white-space:nowrap;background:var(--surface2);color:var(--muted)">${it.gOff ? '⚪ 정지 (그룹 OFF)' : '⚪ 정지'}</span>`
      : sysPaused
        ? `<span title="네이버가 중지시킨 상태 (statusReason: ${esc(a.statusReason || '')}) — 토글은 ON" style="font-size:10.5px;font-weight:800;padding:2px 8px;border-radius:999px;white-space:nowrap;background:var(--red-l);color:var(--red)">🚫 중지 · ${esc(sysLabel)}</span>`
        : `<span style="font-size:10.5px;font-weight:800;padding:2px 8px;border-radius:999px;white-space:nowrap;background:${noImp ? 'var(--amber-l, rgba(245,158,11,.12))' : 'var(--green-l)'};color:${noImp ? 'var(--amber, #B45309)' : 'var(--green)'}">${noImp ? '🟡 미노출' : '🟢 노출중'}</span>`;
    const bidHtml = !it.hasBid
      ? '<span style="color:var(--muted);font-size:11px">브랜드형 · 입찰 조정 대상 아님</span>'
      : pend
        ? `<span class="new">${it.cur}원</span><span class="nvc-d" style="background:var(--surface);color:var(--muted)">…</span>`
        : (changed
          ? `<span style="color:var(--muted);font-size:10px">현재</span> <span class="cur">${it.cur}</span> <span style="color:var(--muted)">→</span> <span style="color:var(--accent-d);font-size:10px;font-weight:700">제안</span> <span class="new">${it.nb}원</span> <span class="nvc-d" style="background:${d > 0 ? 'var(--green-l)' : 'var(--red-l)'};color:${d > 0 ? 'var(--green)' : 'var(--red)'}">${d > 0 ? '+' : ''}${pct}%</span> <input type="checkbox" class="nvc-cb" data-id="${a.nccAdId}" checked title="이 제안 반영" style="margin-left:4px;width:16px;height:16px;accent-color:var(--accent);cursor:pointer;vertical-align:middle">`
          : `<span class="new">${it.cur}원</span><span class="nvc-d" style="background:var(--surface);color:var(--muted)">유지</span>`);
    // '광고노출순위' 초록 강조 (2026-07-23 사용자 지정) — 별도 배지 대신 지표 첫 칸에서 잘 보이게
    const rankV = it.b.rank > 0
      ? `<b style="color:var(--green);font-size:15px;font-weight:900">${it.b.rank.toFixed(1)}</b><span style="color:var(--green);font-size:11px;font-weight:700">위</span>`
      : '<span style="color:var(--muted)">—</span>';
    const M = [[`<span style="color:var(--green);font-weight:700">광고노출순위</span>`, rankV], ['품질', qiBar(a.nccQi && a.nccQi.qiGrade)], ['노출', cnt(it.b.imp)], ['클릭', cnt(it.b.clk)], ['CTR', it.ctr.toFixed(2) + '%'], ['CPC', won(Math.round(it.cpc))], ['총비용', won(it.b.cost)], ['구매', pend ? '<span style="color:var(--muted)">…</span>' : (it.pc.cnt + '건·' + cnt(it.pc.val))]];
    const roasTxt = pend ? '<span style="color:var(--muted)">…</span>' : (it.b.cost ? Math.round(it.roas) + '%' : '-');
    const roasCol = pend ? 'var(--muted)' : (it.b.cost ? (it.roas >= TARGET_ROAS ? 'var(--green)' : 'var(--red)') : 'var(--muted)');
    return `<div class="nvc-card" data-title="${esc(title.toLowerCase())}" data-changed="${changed ? '1' : '0'}" data-noimp="${(noImp || sysPaused) ? '1' : '0'}" data-status="${paused ? 'off' : 'on'}" style="${paused ? 'opacity:.62' : ''}">
      <div style="display:flex;flex-direction:column;align-items:center;gap:5px">
        <img class="nvc-thumb" src="${esc(thumb)}" onerror="this.style.opacity=.2">
        ${statusPill}
      </div>
      <div style="min-width:0">
        <div class="nvc-title">${esc(title)}</div>
        <div class="nvc-meta" style="margin-top:5px">${meta}</div>
        ${adc.description ? `<div style="font-size:11.5px;color:var(--muted);margin-top:3px">${esc(adc.description)}</div>` : ''}
        ${landing ? `<div style="font-size:11px;margin-top:2px"><span style="color:var(--muted);font-weight:700">🔗 연결 URL</span> <a href="${esc(landing)}" target="_blank" rel="noopener" style="color:var(--accent-d);text-decoration:none;word-break:break-all">${esc(landing)}</a></div>` : ''}
        <div class="nvc-organic" data-pid="${esc(rd.mallProductId || '')}" style="font-size:11px;margin-top:3px;display:flex;gap:5px;flex-wrap:wrap;align-items:center"></div>
        <div class="nvc-metrics">${M.map(([k, v]) => `<div class="nvc-m"><div class="k">${k}</div><div class="v">${v}</div></div>`).join('')}</div>
        <div class="nv-recent" data-id="${esc(a.nccAdId)}" style="margin-top:9px;font-size:11px;color:var(--muted);display:flex;align-items:center;gap:6px;flex-wrap:wrap">
          🕐 최근 변경 <span class="nv-recent-val" style="color:var(--text2);font-weight:700">확인 중…</span>
          <span class="nv-hist" data-id="${esc(a.nccAdId)}" style="color:var(--accent-d);font-weight:700;cursor:pointer">이력 ▾</span>
        </div>
      </div>
      <div class="nvc-right">
        <div class="nvc-roas" style="color:${roasCol}">${roasTxt}<small>구매 ROAS · ${periodLabel()}</small></div>
        <div class="nvc-bid" id="nvb-${a.nccAdId}">${paused && !changed ? '<span style="color:var(--muted);font-size:11px">OFF 상태 · 입찰 조정 대상 아님</span>' : bidHtml}</div>
      </div>
    </div>`;
  }
  // 그룹 섹션 HTML (카드 뷰 본문 + 시트 뷰의 브랜드형 섹션 공용) — 브랜드형엔 data-gid를 달아 뷰 토글 시 DOM 재사용
  const gsecHtml = (s, gr) => `
      <div class="nvc-gsec" data-camp="${s.camp.nccCampaignId}"${gr.isBrand ? ` data-brand="1" data-gid="${esc(gr.group.nccAdgroupId)}"` : ''}>
        <div style="display:flex;align-items:center;gap:8px;margin:16px 0 8px;flex-wrap:wrap">
          <span style="font-size:11px;color:var(--muted)">${esc(s.camp.name)}</span>
          <b style="font-size:14px">${statusDot(gr.group)} ${esc(gr.group.name)}</b>
          ${gr.isBrand ? '<span class="nvc-chip" style="background:var(--surface2);color:var(--muted)">브랜드형 · 키워드입찰</span>' : ''}
          <span style="color:var(--muted);font-size:12px">${won(gr.total)} · ${gr.isBrand ? '키워드 ' : ''}${gr.items.length}개</span>
        </div>
        ${gr.isBrand ? brandGroupBody(gr) : gr.items.map(fullCard).join('')}
      </div>`;
  function buildDashFlat(structure) { // 시트 행 소스(상품형만), 비용 내림차순
    const flat = [];
    structure.forEach(s => s.groups.forEach(gr => { if (!gr.isBrand) gr.items.forEach(it => flat.push({ camp: s.camp, grName: gr.group.name, it })); }));
    flat.sort((a, b) => b.it.b.cost - a.it.b.cost);
    nvPidThumbCache = null; // pid→썸네일 맵 재계산(키워드 뷰 오가닉 이미지)
    return flat;
  }
  // 뷰 토글 부분 재렌더 (2026-07-29 성능): 상품 뷰(시트↔카드)만 새로 만들고, 대시보드 HTML의 85%를
  // 차지하는 브랜드형 키워드 표(수백 행)는 DOM 노드를 그대로 이동·재사용(재파싱·재레이아웃 회피).
  function swapProdView() {
    const dash = document.getElementById('nvc-dash');
    if (!dash || !lastDash) return false;
    const { structure } = lastDash;
    const brandNodes = {};
    dash.querySelectorAll('.nvc-gsec[data-brand="1"]').forEach(n => { brandNodes[n.dataset.gid] = n; });
    const tmp = document.createElement('div');
    const frag = document.createDocumentFragment();
    const addHtml = (html) => { tmp.innerHTML = html; while (tmp.firstChild) frag.appendChild(tmp.firstChild); };
    if (dashView === 'sheet' || dashView === 'kw') {
      dashFlat = buildDashFlat(structure);
      addHtml(dashView === 'kw' ? kwTable() : sheetTable());
      structure.forEach(s => s.groups.forEach(gr => {
        if (!gr.isBrand) return;
        const n = brandNodes[gr.group.nccAdgroupId];
        if (n) frag.appendChild(n); else addHtml(gsecHtml(s, gr)); // 노드 없으면 안전 폴백(재생성)
      }));
    } else {
      structure.forEach(s => s.groups.forEach(gr => {
        if (gr.isBrand) {
          const n = brandNodes[gr.group.nccAdgroupId];
          if (n) frag.appendChild(n); else addHtml(gsecHtml(s, gr));
        } else addHtml(gsecHtml(s, gr));
      }));
    }
    dash.replaceChildren(frag);
    return true;
  }

  // ── 시트 뷰 (2026-07-29 대표님 요청): 소재당 한 행 — 광고순위·오가닉 랭킹을 나란히, 드래그(스크롤)로 흐름 파악 ──
  function sheetTable() {
    const TH = (key, label, right) => {
      const active = dashSort.key === key;
      return `<th data-key="${key}" title="클릭: 정렬 · 다시 클릭: 역순" style="${right ? 'text-align:right' : ''}">${label} <span class="nvs-arr" style="font-size:9px;color:${active ? 'var(--accent-d)' : 'var(--border2)'}">${active ? (dashSort.dir === 1 ? '▲' : '▼') : '↕'}</span></th>`;
    };
    // 고정 레이아웃(가로 스크롤 방지): 수치 컬럼은 px 고정, 제품·오가닉이 남는 폭을 나눠 갖고 말줄임 (2026-07-29)
    return `<div class="nvs-wrap"><table id="nvs-table">
      <colgroup><col style="width:44px"><col><col style="width:72px"><col style="width:36%"><col style="width:92px"><col style="width:62px"><col style="width:66px"><col style="width:150px"></colgroup>
      <thead><tr>
        <th></th>
        ${TH('name', '제품')}
        ${TH('rank', '광고순위', 1)}
        ${TH('organic', '오가닉 랭킹 <span style="font-weight:400;color:var(--muted)">(검색수 많은 순)</span>')}
        ${TH('cost', `총비용(${periodLabel()})`, 1)}
        ${TH('roas', 'ROAS', 1)}
        ${TH('bid', '입찰가', 1)}
        <th style="text-align:center">최근 변경 · 이력</th>
      </tr></thead>
      <tbody id="nvs-tbody">${dashFlat.map((x, i) => sheetRow(x, i)).join('')}</tbody>
    </table></div>
    <div style="font-size:11px;color:var(--muted);margin:6px 2px">행 클릭 = 카드 상세 펼침(입찰 제안은 카드 뷰에서) · 헤더 클릭 = 정렬 · 오가닉 칩 <span class="nvs-oc t">1~10위</span><span class="nvs-oc m">11~50위</span><span class="nvs-oc l">51위~</span></div>`;
  }
  function sheetRow(x, i) {
    const it = x.it, a = it.a, rd = a.referenceData || {}, adc = a.ad || {}, pend = it.pending;
    const paused = it.gOff || a.userLock === true;
    const sysP = !paused && a.status && a.status !== 'ELIGIBLE';
    const noImp = !paused && !sysP && !it.b.imp;
    const title = rd.productTitle || adc.headline || a.nccAdId;
    const thumb = rd.imageUrl || (adc.image ? (/^https?:/.test(adc.image) ? adc.image : EXT_IMG + adc.image) : '');
    const dot = paused ? '⚪' : sysP ? '🚫' : noImp ? '🟡' : '🟢';
    const rk = it.b.rank;
    const rankCell = rk > 0
      ? `<b style="font-size:13.5px;font-weight:900;color:${rk <= 5 ? 'var(--green)' : rk <= 10 ? 'var(--amber, #B45309)' : 'var(--red)'}">${rk.toFixed(1)}위</b>`
      : `<span style="color:var(--muted);font-size:11px">${paused ? '—' : sysP ? '🚫 중지' : '미노출'}</span>`;
    const roasTxt = pend ? '<span style="color:var(--muted)">…</span>' : (it.b.cost ? Math.round(it.roas) + '%' : '-');
    const roasCol = pend ? 'var(--muted)' : (it.b.cost ? (it.roas >= TARGET_ROAS ? 'var(--green)' : 'var(--red)') : 'var(--muted)');
    // 시트엔 현재 입찰가만 표시 — 제안·반영 체크박스는 카드 뷰 전용 (2026-07-29 사용자 지정)
    const changed = !pend && it.hasBid && it.nb !== it.cur;
    const bidCell = !it.hasBid ? '<span style="color:var(--muted);font-size:11px">—</span>'
      : `<span style="font-weight:700${paused ? ';color:var(--muted)' : ''}">${it.cur}원</span>`;
    return `<tr class="nvc-srow" data-i="${i}" data-title="${esc(String(title).toLowerCase())}" data-camp="${x.camp.nccCampaignId}" data-status="${paused ? 'off' : 'on'}" data-changed="${changed ? '1' : '0'}" data-noimp="${(noImp || sysP) ? '1' : '0'}" data-sname="${esc(title)}" data-srank="${rk > 0 ? rk : ''}" data-scost="${it.b.cost}" data-sroas="${(!pend && it.b.cost) ? Math.round(it.roas) : ''}" data-sbid="${it.hasBid ? it.cur : ''}" style="${paused ? 'opacity:.6' : ''}">
      <td>${thumb ? `<img class="nvs-th36" src="${esc(thumb)}" loading="lazy" onerror="this.style.opacity=.15">` : '<span class="nvs-th36"></span>'}</td>
      <td class="nvs-nm" title="${esc(x.grName)} · ${esc(title)}"><span style="font-size:10px">${dot}</span> ${esc(title)}</td>
      <td style="text-align:right">${rankCell}</td>
      <td class="nvc-organic" data-pid="${esc(rd.mallProductId || '')}" data-compact="1"><span style="color:var(--muted);font-size:11px">…</span></td>
      <td style="text-align:right;font-weight:700">${won(it.b.cost)}</td>
      <td style="text-align:right;font-weight:800;color:${roasCol}">${roasTxt}</td>
      <td style="text-align:right">${bidCell}</td>
      <td style="text-align:center;white-space:nowrap"><span class="nv-recent-mini" data-id="${esc(a.nccAdId)}" style="font-size:10px;color:var(--muted);margin-right:4px"></span><button class="nv-hist" data-id="${esc(a.nccAdId)}" style="font-size:11px;padding:2px 8px;border-radius:6px;border:1px solid var(--border2);background:var(--surface);color:var(--muted);cursor:pointer">▾</button></td>
    </tr>`;
  }
  function wireSheet() {
    document.querySelectorAll('.nvs-wrap th[data-key]').forEach(th => th.onclick = () => {
      const k = th.dataset.key;
      // 첫 클릭 기본 방향: 이름·순위류=오름차순(좋은 순위 먼저), 비용·ROAS·입찰=내림차순(큰 값 먼저)
      dashSort = { key: k, dir: dashSort.key === k ? -dashSort.dir : ((k === 'name' || k === 'rank' || k === 'organic') ? 1 : -1) };
      applySheetSort();
    });
    const tb = document.getElementById('nvs-tbody');
    if (tb) tb.onclick = (e) => { // 행 클릭 → 기존 카드 상세 펼침 (체크박스·버튼·링크 클릭은 제외)
      if (e.target.closest('input,button,a')) return;
      const tr = e.target.closest('tr.nvc-srow'); if (!tr) return;
      const next = tr.nextElementSibling;
      if (next && next.classList.contains('nvc-sdetail')) { next.remove(); return; }
      const x = dashFlat[+tr.dataset.i]; if (!x) return;
      const det = document.createElement('tr');
      det.className = 'nvc-sdetail';
      // 카드 HTML 재사용 — 행의 체크박스·입찰셀과 id/반영이 중복되지 않게 상세 쪽은 보기 전용으로
      const html = fullCard(x.it).replace(/class="nvc-cb"/g, 'class="nvc-cbd" disabled').replace(/id="nvb-/g, 'id="nvbd-');
      det.innerHTML = `<td colspan="${tr.children.length}" style="padding:8px 10px;background:var(--surface2);white-space:normal">${html}</td>`;
      tr.after(det);
      det.querySelectorAll('.nv-hist').forEach(b => b.onclick = () => toggleEntityHistory(b));
      if (organicLast) injectOrganic(organicLast);
      injectRecentChanges();
    };
    makeColsResizable('nvs-table', 'nv_colw_sheet'); // 열 폭 드래그 조절 (2026-07-29)
    applySheetSort(); // 기간 변경·재렌더 후에도 유지 중인 정렬 상태 재적용
  }
  function applySheetSort() {
    const tb = document.getElementById('nvs-tbody'); if (!tb) return;
    // 행 + 딸린 상세/이력 행을 한 묶음으로 이동(펼친 상태 유지)
    const packs = [];
    [...tb.children].forEach(tr => {
      if (tr.classList.contains('nvc-srow')) packs.push([tr]);
      else if (packs.length) packs[packs.length - 1].push(tr);
    });
    const { key, dir } = dashSort;
    packs.sort((p1, p2) => {
      const r1 = p1[0], r2 = p2[0];
      if (key === 'name') return dir * String(r1.dataset.sname || '').localeCompare(String(r2.dataset.sname || ''), 'ko');
      const v1 = parseFloat(r1.dataset['s' + key]), v2 = parseFloat(r2.dataset['s' + key]);
      const f1 = Number.isFinite(v1), f2 = Number.isFinite(v2);
      if (f1 && f2) return dir * (v1 - v2);
      return f1 ? -1 : f2 ? 1 : 0; // 값 없는 행(미노출·집계 전·순위권 밖)은 방향과 무관하게 아래로
    });
    packs.forEach(p => p.forEach(tr => tb.appendChild(tr)));
    document.querySelectorAll('.nvs-wrap th[data-key]').forEach(th => {
      const arr = th.querySelector('.nvs-arr'); if (!arr) return;
      const on = th.dataset.key === key;
      arr.textContent = on ? (dir === 1 ? '▲' : '▼') : '↕';
      arr.style.color = on ? 'var(--accent-d)' : 'var(--border2)';
    });
  }

  // ── 🔑 키워드 기준 뷰 (2026-07-29 대표님 요청): 행=추적 키워드 — 검색수·오가닉 순위(우리 제품)·광고 실측 노출 ──
  //    광고 노출은 추정이 아니라 검색어 보고서 CSV(수동 업로드, nv_search_terms 영속) 실측 — 그룹 단위.
  //    (쇼핑 검색어는 API 미제공·제외키워드도 API로 못 읽어, 오가닉 기반 역추정은 부정확 — 사용자 지적으로 B안 확정)
  // 흔적 노출 컷 (2026-07-29 사용자 확정): 보고서 기간 노출 20회 미만은 '노출 안 됨'으로 취급(칩·ROAS·랭킹·필터 전부 제외).
  // 근거: 실데이터에서 클릭 최초 발생 노출수 27회 — 20회 미만 행은 전부 클릭 0·비용 0(우연 매칭 흔적, 예: 샌들 광고가 아쿠아슈즈 검색어에 주 2회).
  const NV_TRACE_IMP = 20;
  function termIdx() {
    if (nvTermIdxCache) return nvTermIdxCache;
    const m = {};
    (nvTermsCache || []).forEach(r => { if ((r.imp || 0) < NV_TRACE_IMP) return; const t = (m[r.term] ||= { list: [], imp: 0, cost: 0, conv: 0, rankW: 0, rankImp: 0 }); t.list.push(r); t.imp += r.imp || 0; t.cost += Number(r.cost) || 0; t.conv += Number(r.conv_value) || 0; if (r.avg_rank != null && r.imp > 0) { t.rankW += Number(r.avg_rank) * r.imp; t.rankImp += r.imp; } });
    for (const k in m) { const t = m[k]; t.list.sort((a, b) => (b.cost || 0) - (a.cost || 0)); t.roas = t.cost > 0 ? Math.round(t.conv / t.cost * 100) : null; t.rank = t.rankImp > 0 ? Math.round(t.rankW / t.rankImp * 10) / 10 : null; } // 대표 ROAS·랭킹 = 전 그룹 노출/비용 가중
    nvTermIdxCache = m; return m;
  }
  // 대시보드 구조 기반 그룹 평균 광고순위 — 보고서에 평균노출순위 컬럼이 없을 때의 대체값(≈, 전체 검색어 평균)
  function dashGroupRank() {
    const m = {};
    (dashFlat || []).forEach(x => { const g = (m[x.grName] ||= { w: 0, imp: 0 }); const b = x.it.b; if (b.rank > 0 && b.imp > 0) { g.w += b.rank * b.imp; g.imp += b.imp; } });
    const out = {};
    for (const k in m) if (m[k].imp > 0) out[k] = Math.round(m[k].w / m[k].imp * 10) / 10;
    return out;
  }
  async function loadSearchTerms() {
    if (nvTermsCache !== null) return nvTermsCache;
    if (MOCK) { nvTermsCache = [{ term: '유아원피스', campaign: 'ONS', adgroup: '원피스_모모리본', imp: 1240, clk: 33, cost: 32000, conv_value: 67000, updated_at: new Date().toISOString() }]; nvTermsTs = nvTermsCache[0].updated_at; nvTermIdxCache = null; return nvTermsCache; }
    try {
      const rows = await sbGet('nv_search_terms', 'term,campaign,adgroup,imp,clk,cost,conv_value,avg_rank,updated_at');
      nvTermsCache = Array.isArray(rows) ? rows : [];
      nvTermsTs = nvTermsCache.length ? nvTermsCache[0].updated_at : null;
    } catch (e) { nvTermsCache = []; nvTermsTs = null; } // 테이블 미생성·게이트웨이 오류 → '미업로드'로 표시
    nvTermIdxCache = null;
    return nvTermsCache;
  }
  function termsStatusText() {
    if (nvTermsCache === null) return '검색어 보고서: 확인 중…';
    if (!nvTermsCache.length) return '검색어 보고서: 미업로드 — 업로드하면 광고 실측 노출이 채워져요';
    const k = new Date(new Date(nvTermsTs).getTime() + 9 * 3600000);
    return `검색어 보고서: ✓ ${cnt(nvTermsCache.length)}행 · 마지막 업로드 ${k.toISOString().slice(0, 16).replace('T', ' ')} (KST)`;
  }
  function kwAdInfo(kw) { // 광고 셀 HTML + 대표 광고랭킹(정렬용) — 랭킹은 CSV 평균노출순위 우선, 없으면 대시보드 평균(≈)
    if (nvTermsCache === null) return { html: '<span style="color:var(--muted);font-size:11px">…</span>', rank: null };
    if (!nvTermsCache.length) return { html: '<span style="color:var(--muted);font-size:11px">보고서 미업로드</span>', rank: null };
    const t = termIdx()[kw];
    if (!t || !t.list.length) return { html: `<span style="color:var(--muted);font-size:11px" title="보고서 기간 노출 ${NV_TRACE_IMP}회 미만(우연 매칭 흔적)은 노출 안 된 것으로 처리">노출 기록 없음</span>`, rank: null };
    const fb = dashGroupRank(); // 대체값(그룹 전체 검색어 평균)
    // 노출 점유율 (2026-07-29): 노출수/주간검색수 — 점유율 5% 미만이면 '어쩌다 뜨는' 광고라 순위를 회색 처리
    // (평균 15위인데 실검색에선 안 보이던 혼란 방지: 점유율 1.3% = 검색 100번 중 1번만 노출)
    const kwVol = (organicKwCache && organicKwCache[kw] && organicKwCache[kw].vol) || 0;
    let fbW = 0, fbImp = 0;
    const html = t.list.slice(0, 4).map(g => {
      const roas = g.cost > 0 ? Math.round((g.conv_value || 0) / g.cost * 100) : null;
      const rc = roas == null ? 'var(--muted)' : roas >= TARGET_ROAS ? 'var(--green)' : 'var(--red)';
      const rk = g.avg_rank != null ? Math.round(Number(g.avg_rank) * 10) / 10 : null;
      const rkFb = rk == null ? fb[g.adgroup] : null;
      if (rkFb != null && g.imp > 0) { fbW += rkFb * g.imp; fbImp += g.imp; }
      const rkV = rk != null ? rk : rkFb;
      const share = kwVol > 0 && g.imp > 0 ? g.imp / kwVol * 100 : null;
      const lowShare = share != null && share < 5;
      // 점유율 낮은 칩은 통째로 회색·흐림 (2026-07-29 사용자 지정: 배경색으로 높/낮 즉시 구분)
      const rkc = (rkV == null || lowShare) ? 'var(--muted)' : rkV <= 5 ? 'var(--green)' : rkV <= 10 ? 'var(--amber, #B45309)' : 'var(--red)';
      const roasC = lowShare ? 'var(--muted)' : rc;
      const rkHtml = rkV == null ? '' : `<b style="color:${rkc}">${rk == null ? '≈' : ''}${rkV}위</b> · `;
      const shareTip = share == null ? '' : ` · 점유율 ${share < 10 ? share.toFixed(1) : Math.round(share)}%${lowShare ? ` (검색 ${Math.max(2, Math.round(100 / share))}번 중 ~1번만 노출 — 실검색에선 잘 안 보임)` : ''}`;
      const tip = `${g.adgroup} · ${rk != null ? '이 검색어 평균노출순위 ' + rk + '위' : (rkFb != null ? '순위 ≈' + rkFb + '위 (보고서에 순위 없음 → 대시보드 전체 평균)' : '순위 정보 없음')} · 노출 ${cnt(g.imp)} · 클릭 ${cnt(g.clk)} · ${won(g.cost)}${roas != null ? ' · ROAS ' + roas + '%' : ' · 클릭 0(비용 없음)'}${shareTip}`;
      return `<span class="nvs-oc ${lowShare ? 'l' : 'a'}" style="${lowShare ? 'opacity:.7' : ''}" title="${esc(tip)}">${esc(g.adgroup)} ${rkHtml}<b style="color:${roasC}">${roas != null ? roas + '%' : '—'}</b></span>`;
    }).join('') + (t.list.length > 4 ? `<span style="color:var(--muted);font-size:10.5px"> 외 ${t.list.length - 4}그룹</span>` : '');
    const rank = t.rank != null ? t.rank : (fbImp > 0 ? Math.round(fbW / fbImp * 10) / 10 : null);
    return { html, rank };
  }
  // 오가닉 제품 썸네일: 상품번호(pid) → 광고 소재의 상품 이미지 (OFF 소재 포함 구조 전체에서 매칭)
  let nvPidThumbCache = null;
  function pidThumbMap() {
    if (nvPidThumbCache) return nvPidThumbCache;
    const m = {};
    (dashFlat || []).forEach(x => {
      const rd = x.it.a.referenceData || {};
      if (rd.mallProductId && rd.imageUrl && !m[rd.mallProductId]) m[rd.mallProductId] = rd.imageUrl;
    });
    nvPidThumbCache = m; return m;
  }
  function kwRow(kw, info) {
    // 2026-07-29 사용자 요청: 오가닉을 1·2·3순위 컬럼으로 분리(각각 정렬) + 제품 썸네일
    const shortT = (t) => { const s = String(t).replace(/오즈키즈|OZKIZ/gi, '').trim(); return s.length > 13 ? s.slice(0, 13) + '…' : s; };
    const thumbs = pidThumbMap();
    const prodCell = (p, i) => {
      if (!p) return `<td style="text-align:center;color:var(--border2)">${i === 0 && !info.products.length ? '<span style="color:var(--muted);font-size:11px">순위권 밖</span>' : '—'}</td>`;
      const cls = p.rank <= 10 ? 't' : p.rank <= 50 ? 'm' : 'l';
      const th = thumbs[p.pid];
      return `<td><span class="nvs-oc ${cls} nvk-chip" data-pid="${esc(p.pid)}" style="cursor:pointer;display:inline-flex;align-items:center;gap:4px;max-width:100%" title="${esc(p.title)} · ${p.rank}위 — 클릭: 광고 소재 상세">${th ? `<img class="nvk-th" src="${esc(th)}" loading="lazy" onerror="this.style.display='none'">` : ''}<span style="overflow:hidden;text-overflow:ellipsis">${esc(shortT(p.title))}</span> <b>${p.rank}</b></span></td>`;
    };
    const [p1, p2, p3] = info.products;
    const t = termIdx()[kw];
    const ad = kwAdInfo(kw);
    return `<tr class="nvk-row" data-title="${esc(kw.toLowerCase())}" data-kname="${esc(kw)}" data-kvol="${info.vol || ''}" data-kb1="${p1 ? p1.rank : ''}" data-kb2="${p2 ? p2.rank : ''}" data-kb3="${p3 ? p3.rank : ''}" data-kroas="${t && t.roas != null ? t.roas : ''}" data-krank="${ad.rank != null ? ad.rank : ''}">
      <td style="font-weight:700">${esc(kw)}</td>
      <td style="text-align:right">${info.vol ? cnt(info.vol) : '<span style="color:var(--muted)">—</span>'}</td>
      ${prodCell(p1, 0)}${prodCell(p2, 1)}${prodCell(p3, 2)}
      <td class="nvk-ad" data-kw="${esc(kw)}">${ad.html}</td>
    </tr>`;
  }
  function kwTable() {
    const KTH = (key, label, right) => {
      const active = kwSort.key === key;
      return `<th data-key="${key}" title="클릭: 정렬 · 다시 클릭: 역순" style="${right ? 'text-align:right' : ''}">${label} <span class="nvs-arr" style="font-size:9px;color:${active ? 'var(--accent-d)' : 'var(--border2)'}">${active ? (kwSort.dir === 1 ? '▲' : '▼') : '↕'}</span></th>`;
    };
    const selCss = 'padding:7px 9px;border:1px solid var(--border2);border-radius:9px;background:var(--surface);color:var(--text);font-size:12px;font-weight:600;cursor:pointer';
    const opt = (v, lbl, cur) => `<option value="${v}" ${String(cur) === String(v) ? 'selected' : ''}>${lbl}</option>`;
    const bar = `<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:8px">
      <button id="nvk-upbtn" style="padding:7px 13px;border-radius:9px;border:1px solid var(--border2);background:var(--surface);color:var(--text2);cursor:pointer;font-weight:700;font-size:12px">📤 검색어 보고서 업로드 (CSV)</button>
      <input type="file" id="nvk-upfile" accept=".csv,text/csv" style="display:none">
      <span id="nvk-upstat" style="font-size:11.5px;color:var(--muted)">${esc(termsStatusText())}</span>
      <span style="margin-left:auto;display:flex;gap:6px;align-items:center;flex-wrap:wrap">
        <select id="nvk-fvol" style="${selCss}" title="주간검색수 하한 필터">
          ${opt(0, '검색량 전체', kwFilter.vol)}${opt(1000, '검색량 1,000+', kwFilter.vol)}${opt(3000, '검색량 3,000+', kwFilter.vol)}${opt(5000, '검색량 5,000+', kwFilter.vol)}${opt(10000, '검색량 10,000+', kwFilter.vol)}
        </select>
        <select id="nvk-forg" style="${selCss}" title="오가닉 1순위 필터">
          ${opt('all', '오가닉 전체', kwFilter.org)}${opt(10, '오가닉 10위 이내', kwFilter.org)}${opt(30, '오가닉 30위 이내', kwFilter.org)}${opt(50, '오가닉 50위 이내', kwFilter.org)}${opt('none', '순위권 밖만', kwFilter.org)}
        </select>
        <select id="nvk-fad" style="${selCss}" title="광고 랭킹 필터">
          ${opt('all', '광고 전체', kwFilter.ad)}${opt(5, '광고 5위 이내', kwFilter.ad)}${opt(10, '광고 10위 이내', kwFilter.ad)}${opt('over10', '광고 10위 초과', kwFilter.ad)}${opt('none', '노출 기록 없음', kwFilter.ad)}
        </select>
        <span id="nvk-fcnt" style="font-size:11.5px;color:var(--muted);min-width:52px"></span>
      </span>
    </div>`;
    if (!organicKwCache) return bar + '<div id="nvk-empty" style="color:var(--muted);padding:18px">⏳ 오가닉 순위 데이터 불러오는 중…</div>';
    const entries = Object.entries(organicKwCache);
    return bar + `<div class="nvs-wrap"><table id="nvk-table">
      <colgroup><col style="width:128px"><col style="width:84px"><col style="width:15%"><col style="width:15%"><col style="width:15%"><col></colgroup>
      <thead><tr>
        ${KTH('name', '키워드')}
        ${KTH('vol', '주간검색수', 1)}
        ${KTH('b1', '오가닉 1순위')}
        ${KTH('b2', '2순위')}
        ${KTH('b3', '3순위')}
        <th>광고 실측 — ${(() => { const S2 = (key, label) => { const active = kwSort.key === key; return `<span class="nvs-sort2" data-key="${key}" style="cursor:pointer" title="클릭: ${label} 정렬">${label} <span class="nvs-arr" style="font-size:9px;color:${active ? 'var(--accent-d)' : 'var(--border2)'}">${active ? (kwSort.dir === 1 ? '▲' : '▼') : '↕'}</span></span>`; }; return S2('rank', '랭킹') + ' · ' + S2('roas', 'ROAS'); })()} <span style="font-weight:400;color:var(--muted)">(검색어 보고서)</span></th>
      </tr></thead>
      <tbody id="nvk-tbody">${entries.map(([kw, info]) => kwRow(kw, info)).join('')}</tbody>
    </table></div>
    <div style="font-size:11px;color:var(--muted);margin:6px 2px">오가닉 칩 색 = 순위 구간 <span class="nvs-oc t">1~10위</span><span class="nvs-oc m">11~50위</span><span class="nvs-oc l">51위~</span> (클릭 = 광고 소재 상세) · 광고 칩 색 = 점유율 <span class="nvs-oc a">보라 = 자주 노출(5%+)</span><span class="nvs-oc l" style="opacity:.7">회색 = 어쩌다 노출(5% 미만)</span> · 광고 실측 = 검색어 보고서(그룹 단위·보고서 기간, 노출 ${NV_TRACE_IMP}회 미만 흔적 제외) · 오가닉 = 추적 키워드 top100</div>`;
  }
  // 키워드 행 필터 (2026-07-29): 상품명 검색창 + 검색량 하한 + 오가닉 1순위 + 광고 랭킹 조합.
  // renderDashboard의 applyFilters와 필터 셀렉트 onchange 양쪽에서 호출(모듈 스코프).
  function applyKwRowFilters() {
    const term = ((document.getElementById('nvf-q') || {}).value || '').toLowerCase();
    document.querySelectorAll('.nvk-row[data-title]').forEach(el => {
      const d = el.dataset;
      let vis = !term || d.title.includes(term);
      if (vis && kwFilter.vol > 0) vis = (parseFloat(d.kvol) || 0) >= kwFilter.vol;
      if (vis && kwFilter.org !== 'all') {
        const b = parseFloat(d.kb1);
        vis = kwFilter.org === 'none' ? !Number.isFinite(b) : (Number.isFinite(b) && b <= +kwFilter.org);
      }
      if (vis && kwFilter.ad !== 'all') {
        const rk = parseFloat(d.krank);
        vis = kwFilter.ad === 'none' ? !Number.isFinite(rk)
          : kwFilter.ad === 'over10' ? (Number.isFinite(rk) && rk > 10)
          : (Number.isFinite(rk) && rk <= +kwFilter.ad);
      }
      el.style.display = vis ? '' : 'none';
      let n = el.nextElementSibling;
      while (n && !n.classList.contains('nvk-row')) { n.style.display = vis ? '' : 'none'; n = n.nextElementSibling; }
    });
    const cntEl = document.getElementById('nvk-fcnt');
    if (cntEl) {
      const all = [...document.querySelectorAll('.nvk-row')];
      const vis = all.filter(x => x.style.display !== 'none').length;
      cntEl.textContent = vis === all.length ? `${all.length}개` : `필터 ${vis}/${all.length}개`;
      cntEl.style.color = vis === all.length ? 'var(--muted)' : 'var(--accent-d)';
    }
  }
  function applyKwSort() {
    const tb = document.getElementById('nvk-tbody'); if (!tb) return;
    const packs = [];
    [...tb.children].forEach(tr => {
      if (tr.classList.contains('nvk-row')) packs.push([tr]);
      else if (packs.length) packs[packs.length - 1].push(tr);
    });
    const { key, dir } = kwSort;
    packs.sort((p1, p2) => {
      const r1 = p1[0], r2 = p2[0];
      if (key === 'name') return dir * String(r1.dataset.kname || '').localeCompare(String(r2.dataset.kname || ''), 'ko');
      const v1 = parseFloat(r1.dataset['k' + key]), v2 = parseFloat(r2.dataset['k' + key]);
      const f1 = Number.isFinite(v1), f2 = Number.isFinite(v2);
      if (f1 && f2) return dir * (v1 - v2);
      return f1 ? -1 : f2 ? 1 : 0; // 값 없는 행은 항상 아래
    });
    packs.forEach(p => p.forEach(tr => tb.appendChild(tr)));
    document.querySelectorAll('#nvk-table th[data-key], #nvk-table .nvs-sort2[data-key]').forEach(el => {
      const arr = el.querySelector('.nvs-arr'); if (!arr) return;
      const on = el.dataset.key === key;
      arr.textContent = on ? (dir === 1 ? '▲' : '▼') : '↕';
      arr.style.color = on ? 'var(--accent-d)' : 'var(--border2)';
    });
  }
  function refreshKwCells() { // 검색어 보고서 도착/업로드 후 광고 셀·상태만 부분 갱신(전체 재렌더 없이 — 재귀 방지)
    const st = document.getElementById('nvk-upstat'); if (st) st.textContent = termsStatusText();
    document.querySelectorAll('#nvk-tbody td.nvk-ad[data-kw]').forEach(td => {
      const kw = td.dataset.kw;
      const ad = kwAdInfo(kw);
      td.innerHTML = ad.html;
      const t = termIdx()[kw], tr = td.closest('tr');
      if (tr) { tr.dataset.kroas = (t && t.roas != null) ? t.roas : ''; tr.dataset.krank = ad.rank != null ? ad.rank : ''; }
    });
    if (kwSort.key === 'roas' || kwSort.key === 'rank') applyKwSort();
    if (kwFilter.ad !== 'all') applyKwRowFilters(); // 광고 랭킹 값이 도착/갱신되면 필터 재평가
  }
  // 검색어 보고서 CSV 파싱 — 제외키워드 탭과 동일한 헤더 탐지·쇼핑검색 전용 필터, (검색어, 광고그룹) 단위 집계
  function parseTermsCsv(text) {
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    const lines = text.split(/\r?\n/).filter(Boolean);
    const hi = lines.findIndex(l => l.includes('검색어') && l.includes('총비용'));
    if (hi < 0) throw new Error('"검색어"·"총비용" 컬럼을 못 찾았어요. 쇼핑검색 검색어 보고서 CSV인지 확인하세요.');
    const H = lines[hi].split(',');
    const idx = (name) => H.findIndex(h => h.split('(')[0].trim().includes(name));
    // 노출은 '노출수'가 '평균노출순위'와 헷갈리지 않게 순위 컬럼을 먼저 확정 후 제외하고 탐색
    const rankIdx = H.findIndex(h => h.split('(')[0].trim().includes('평균노출순위')) >= 0
      ? H.findIndex(h => h.split('(')[0].trim().includes('평균노출순위'))
      : H.findIndex(h => h.split('(')[0].trim().includes('노출순위'));
    const impIdx = H.findIndex((h, i) => i !== rankIdx && h.split('(')[0].trim().includes('노출'));
    const ci = { grp: idx('광고그룹'), camp: idx('캠페인'), type: idx('유형'), term: idx('검색어'), imp: impIdx, clk: idx('클릭'), cost: idx('총비용'), sales: idx('전환매출'), rank: rankIdx };
    if (ci.term < 0 || ci.cost < 0) throw new Error('필수 컬럼(검색어/총비용) 매핑 실패');
    const agg = {}; let skipped = 0;
    for (let i = hi + 1; i < lines.length; i++) {
      const c = lines[i].split(','); if (c.length < H.length) continue;
      const term = (c[ci.term] || '').trim(); if (!term || term === '-') continue;
      const grp = (ci.grp >= 0 ? (c[ci.grp] || '').trim() : '') || '(그룹 미표기)';
      const camp = ci.camp >= 0 ? (c[ci.camp] || '').trim() : '';
      const rowType = ci.type >= 0 ? (c[ci.type] || '').trim() : '';
      if (/플레이스|파워링크|파링|브랜드형/.test(grp + camp) || (ci.type >= 0 && !rowType.includes('쇼핑'))) { skipped++; continue; }
      const k = term + '' + grp;
      const a = (agg[k] ||= { term, campaign: camp, adgroup: grp, imp: 0, clk: 0, cost: 0, conv_value: 0, _rw: 0, _ri: 0 });
      const imp = Number(c[ci.imp]) || 0;
      a.imp += imp; a.clk += Number(c[ci.clk]) || 0; a.cost += Number(c[ci.cost]) || 0; a.conv_value += Number(c[ci.sales]) || 0;
      if (ci.rank >= 0 && imp > 0) { const rk = parseFloat(c[ci.rank]); if (Number.isFinite(rk) && rk > 0) { a._rw += rk * imp; a._ri += imp; } }
    }
    // 평균노출순위(있으면) = 노출 가중 평균. _rw/_ri는 서버에 안 보냄.
    const rows = Object.values(agg).map(a => { const { _rw, _ri, ...row } = a; row.avg_rank = _ri > 0 ? Math.round(_rw / _ri * 10) / 10 : null; return row; });
    return { rows, skipped };
  }
  async function uploadSearchTerms(text) {
    const st = document.getElementById('nvk-upstat');
    try {
      const { rows, skipped } = parseTermsCsv(text);
      if (!rows.length) { alert('쇼핑검색 행이 없습니다.' + (skipped ? ` (쇼핑검색 외 ${skipped}행 제외됨)` : '')); return; }
      if (MOCK) { alert('🧪 목모드: 실제 저장 안 함 (' + rows.length + '행 파싱 성공)'); return; }
      if (st) st.textContent = `⏳ ${cnt(rows.length)}행 서버 저장 중… (완료까지 새로고침 금지)`;
      const save = sbReplace('nv_search_terms', rows); // index.html 게이트웨이(쓰기 인증) — 실패 시 throw
      await (typeof trackSaving === 'function' ? trackSaving(save) : save);
      const now = new Date().toISOString();
      nvTermsCache = rows.map(r => ({ ...r, updated_at: now }));
      nvTermsTs = now; nvTermIdxCache = null;
      refreshKwCells();
    } catch (e) {
      if (st) st.textContent = '⚠️ 서버 저장 실패 — 마지막 업로드 데이터가 유지됩니다';
      alert('검색어 보고서 저장 실패: ' + (e.message || e) + '\n쓰기 인증(🔒 쓰기 잠김) 상태를 확인하고 다시 업로드해주세요.');
    }
  }
  function wireKwSheet() {
    document.querySelectorAll('#nvk-table th[data-key], #nvk-table .nvs-sort2[data-key]').forEach(el => el.onclick = (e) => {
      e.stopPropagation();
      const k = el.dataset.key;
      kwSort = { key: k, dir: kwSort.key === k ? -kwSort.dir : ((k === 'vol' || k === 'roas') ? -1 : 1) }; // 순위류·이름=오름차순, 검색수·ROAS=내림차순 먼저
      applyKwSort();
    });
    const tb = document.getElementById('nvk-tbody');
    if (tb) tb.onclick = (e) => { // 오가닉 칩 클릭 → 해당 제품의 광고 카드 상세 펼침
      const chip = e.target.closest('.nvk-chip[data-pid]'); if (!chip || !chip.dataset.pid) return;
      const tr = e.target.closest('tr.nvk-row'); if (!tr) return;
      const pid = chip.dataset.pid;
      const next = tr.nextElementSibling;
      if (next && next.classList.contains('nvc-sdetail')) { const same = next.dataset.pid === pid; next.remove(); if (same) return; }
      const x = dashFlat.find(f => String((f.it.a.referenceData || {}).mallProductId || '') === pid);
      if (!x) { const old = chip.textContent; chip.textContent = '광고 소재 없음'; setTimeout(() => { chip.textContent = old; }, 1200); return; }
      const det = document.createElement('tr');
      det.className = 'nvc-sdetail'; det.dataset.pid = pid;
      const html = fullCard(x.it).replace(/class="nvc-cb"/g, 'class="nvc-cbd" disabled').replace(/id="nvb-/g, 'id="nvbd-');
      det.innerHTML = `<td colspan="${tr.children.length}" style="padding:8px 10px;background:var(--surface2);white-space:normal">${html}</td>`;
      tr.after(det);
      det.querySelectorAll('.nv-hist').forEach(b => b.onclick = () => toggleEntityHistory(b));
      if (organicLast) injectOrganic(organicLast);
      injectRecentChanges();
    };
    const ub = document.getElementById('nvk-upbtn'), uf = document.getElementById('nvk-upfile');
    if (ub && uf) {
      ub.onclick = () => uf.click();
      uf.onchange = (e) => { const f = e.target.files && e.target.files[0]; e.target.value = ''; if (f) f.text().then(uploadSearchTerms).catch(err => alert('파일 읽기 실패: ' + (err.message || err))); };
    }
    // 키워드 필터 셀렉트 (2026-07-29): 검색량·오가닉 1순위·광고 랭킹
    const fv = document.getElementById('nvk-fvol'), fo = document.getElementById('nvk-forg'), fa = document.getElementById('nvk-fad');
    if (fv) fv.onchange = () => { kwFilter.vol = +fv.value || 0; applyKwRowFilters(); };
    if (fo) fo.onchange = () => { kwFilter.org = fo.value; applyKwRowFilters(); };
    if (fa) fa.onchange = () => { kwFilter.ad = fa.value; applyKwRowFilters(); };
    makeColsResizable('nvk-table', 'nv_colw_kw');
    applyKwSort();
    applyKwRowFilters(); // 유지 중인 필터 상태 재적용(뷰 전환·재렌더 후)
    loadSearchTerms().then(refreshKwCells).catch(() => {}); // 캐시면 즉시 반환 — 셀만 갱신하므로 재귀 없음
  }
  // ── 열 폭 드래그 조절 (2026-07-29 대표님 요청): colgroup 폭 직접 조정, localStorage 유지, 더블클릭=기본 ──
  function makeColsResizable(tableId, storeKey) {
    const table = document.getElementById(tableId); if (!table) return;
    const cols = [...table.querySelectorAll('colgroup col')];
    cols.forEach(c => { if (c.dataset.w0 === undefined) c.dataset.w0 = c.style.width || ''; });
    try { const saved = JSON.parse(localStorage.getItem(storeKey) || 'null'); if (Array.isArray(saved)) saved.forEach((px, i) => { if (px > 0 && cols[i]) cols[i].style.width = px + 'px'; }); } catch (e) {}
    table.querySelectorAll('thead th').forEach((th, i) => {
      if (i >= cols.length || th.querySelector('.nvs-grip')) return;
      const grip = document.createElement('span');
      grip.className = 'nvs-grip'; grip.title = '드래그: 열 폭 조절 · 더블클릭: 기본 폭';
      grip.onclick = (e) => e.stopPropagation(); // 헤더 정렬 클릭과 분리
      grip.ondblclick = (e) => { e.stopPropagation(); cols.forEach(c => { c.style.width = c.dataset.w0; }); try { localStorage.removeItem(storeKey); } catch (er) {} };
      grip.onmousedown = (e) => {
        e.preventDefault(); e.stopPropagation();
        const startX = e.clientX, startW = cols[i].getBoundingClientRect().width;
        const move = (ev) => { cols[i].style.width = Math.max(40, Math.round(startW + ev.clientX - startX)) + 'px'; };
        const up = () => {
          document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up);
          try { localStorage.setItem(storeKey, JSON.stringify(cols.map(c => /px$/.test(c.style.width) ? parseInt(c.style.width) : 0))); } catch (er) {}
        };
        document.addEventListener('mousemove', move); document.addEventListener('mouseup', up);
      };
      th.appendChild(grip);
    });
  }

  // 브랜드형쇼검 그룹 = 파워링크식 키워드 테이블(소재 연결URL·확장소재·키워드 입찰·합계)
  function brandGroupBody(gr) {
    const thc = 'padding:6px 8px;font-weight:600;white-space:nowrap';
    const head = `<thead><tr style="color:var(--muted);font-size:11px;text-align:right;border-bottom:1px solid var(--border)">
      <th style="text-align:left;${thc}">키워드</th><th style="${thc}">순위</th><th style="text-align:left;${thc}">품질</th><th style="${thc}">노출</th><th style="${thc}">클릭</th><th style="${thc}">CTR</th><th style="${thc}">CPC</th><th style="${thc}">총비용</th><th style="${thc}">구매(직접)</th><th style="${thc}">ROAS</th><th style="text-align:right;${thc}">입찰가 (현재→제안)</th><th style="${thc}">On/Off</th><th style="${thc}" title="입찰·ON/OFF 변경 이력">이력</th>
    </tr></thead>`;
    const tf = 'padding:7px 8px;text-align:right;white-space:nowrap;font-weight:700;background:var(--surface2)', pend = gr.acnt == null;
    const foot = `<tfoot><tr style="border-top:2px solid var(--border2)">
      <td style="padding:7px 8px;text-align:left;font-weight:700;background:var(--surface2)">합계 · ${gr.items.length}개</td>
      <td style="${tf}">${gr.aimp ? (gr.arankw / gr.aimp).toFixed(1) : '-'}</td><td style="${tf}"></td>
      <td style="${tf}">${cnt(gr.aimp)}</td><td style="${tf}">${cnt(gr.aclk)}</td>
      <td style="${tf}">${gr.aimp ? (gr.aclk / gr.aimp * 100).toFixed(2) : '0.00'}%</td>
      <td style="${tf}">${won(gr.aclk ? Math.round(gr.total / gr.aclk) : 0)}</td><td style="${tf}">${won(gr.total)}</td>
      <td style="${tf}">${pend ? '…' : (gr.acnt + '건·' + cnt(gr.aval))}</td>
      <td style="${tf};color:${pend ? 'var(--muted)' : (gr.total && gr.aval / gr.total * 100 >= TARGET_ROAS ? 'var(--green)' : 'var(--red)')}">${pend ? '…' : (gr.total ? Math.round(gr.aval / gr.total * 100) + '%' : '-')}</td>
      <td style="${tf}"></td><td style="${tf}"></td><td style="${tf}"></td>
    </tr></tfoot>`;
    const url = (gr.banner && gr.banner.length) ? `<div style="margin:0 0 8px;padding:8px 10px;background:var(--surface2);border:1px solid var(--border);border-radius:9px"><div style="font-size:11px;color:var(--muted);font-weight:700">소재 · 연결 URL</div>${adPreview(gr.banner)}</div>` : '';
    const ext = (gr.exts && gr.exts.length) ? `<div style="margin:0 0 8px;padding:8px 10px;background:var(--surface2);border:1px solid var(--border);border-radius:9px"><div style="font-size:11px;color:var(--muted);font-weight:700;margin-bottom:4px">확장소재 미리보기</div>${extPreview(gr.exts)}</div>` : '';
    return `${url}${ext}<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:12.5px">${head}<tbody>${gr.items.map(brandKwRow).join('')}</tbody>${foot}</table></div>`;
  }
  function brandKwRow(it) {
    const kw = it.kw, locked = kw.userLock === true, paused = locked || !isRunning(kw) || it.gOff, pend = it.pending, grp = it.grp;
    const d = (!pend && !grp) ? it.nb - it.cur : 0, pct = it.cur ? Math.round(d / it.cur * 100) : 0, changed = !pend && !grp && d !== 0;
    const td = 'padding:6px 8px;text-align:right;white-space:nowrap';
    const bidCell = grp ? '<span style="color:var(--muted);font-size:11px">그룹입찰</span>'
      : pend ? '<span style="color:var(--muted)">…</span>'
      : changed ? `<span style="color:var(--muted);text-decoration:line-through">${it.cur}</span><span style="color:var(--muted)"> → </span><span style="font-weight:800;color:var(--accent-d)">${it.nb}원</span> <span class="nvc-d" style="background:${d > 0 ? 'var(--green-l)' : 'var(--red-l)'};color:${d > 0 ? 'var(--green)' : 'var(--red)'}">${d > 0 ? '+' : ''}${pct}%</span> <input type="checkbox" class="nvc-cb" data-id="${esc(kw.nccKeywordId)}" checked title="이 제안 반영" style="width:15px;height:15px;accent-color:var(--accent);cursor:pointer;vertical-align:middle">`
      : `<span style="font-weight:700">${it.cur}원</span> <span style="color:var(--muted);font-size:11px">유지</span>`;
    const roasTxt = pend ? '…' : (it.b.cost ? Math.round(it.roas) + '%' : '-');
    const roasCol = pend ? 'var(--muted)' : (it.b.cost ? (it.roas >= TARGET_ROAS ? 'var(--green)' : 'var(--red)') : 'var(--muted)');
    const buy = pend ? '…' : (it.pc.cnt + '건·' + cnt(it.pc.val));
    const noImp = !paused && !it.b.imp;
    const rk = it.b.rank;
    const rankCell = rk > 0
      ? `<b style="color:${rk <= 3 ? 'var(--green)' : rk <= 6 ? 'var(--amber, #B45309)' : 'var(--red)'}">${rk.toFixed(1)}</b>`
      : '<span style="color:var(--muted)">—</span>';
    return `<tr class="nvc-krow" data-title="${esc((kw.keyword || '').toLowerCase())}" data-changed="${changed ? '1' : '0'}" data-noimp="${noImp ? '1' : '0'}" data-status="${paused ? 'off' : 'on'}" style="border-top:1px solid var(--border)${paused ? ';opacity:.62' : ''}">
      <td style="padding:6px 8px;text-align:left"><span style="font-size:11px" title="${paused ? '정지' : (noImp ? '미노출(기간 내 노출 0)' : '노출중')}">${paused ? '⚪' : (noImp ? '🟡' : '🟢')}</span> <span style="font-weight:600">${esc(kw.keyword || kw.nccKeywordId)}</span>${noImp ? ' <span style="font-size:10px;color:var(--amber, #B45309);font-weight:700">미노출</span>' : ''}</td>
      <td style="${td}">${rankCell}</td>
      <td style="padding:6px 8px;text-align:left">${qiBar(kw.nccQi && kw.nccQi.qiGrade)}</td>
      <td style="${td}">${cnt(it.b.imp)}</td><td style="${td}">${cnt(it.b.clk)}</td>
      <td style="${td}">${it.ctr.toFixed(2)}%</td><td style="${td}">${won(Math.round(it.cpc))}</td>
      <td style="${td}">${won(it.b.cost)}</td><td style="${td}">${buy}</td>
      <td style="${td};font-weight:700;color:${roasCol}">${roasTxt}</td>
      <td id="nvb-${esc(kw.nccKeywordId)}" style="${td}">${bidCell}</td>
      <td style="padding:6px 8px;text-align:center"><button class="nvp-off" data-kw="${esc(kw.nccKeywordId)}" data-ag="${esc(kw.nccAdgroupId)}" data-name="${esc(kw.keyword || kw.nccKeywordId)}" data-lock="${locked ? '0' : '1'}" style="font-size:11px;padding:2px 10px;border-radius:6px;border:1px solid var(--border2);background:var(--surface);color:${locked ? 'var(--green)' : 'var(--red)'};cursor:pointer;font-weight:700">${locked ? 'ON' : 'OFF'}</button></td>
      <td style="padding:6px 8px;text-align:center;white-space:nowrap"><span class="nv-recent-mini" data-id="${esc(kw.nccKeywordId)}" style="font-size:10px;color:var(--muted);margin-right:4px"></span><button class="nv-hist" data-id="${esc(kw.nccKeywordId)}" style="font-size:11px;padding:2px 8px;border-radius:6px;border:1px solid var(--border2);background:var(--surface);color:var(--muted);cursor:pointer">▾</button></td>
    </tr>`;
  }

  // 최근 7일 구매전환(장바구니 제외) — AD_CONVERSION 일별 보고서 합산, 계정단위 1회 수집 후 캐시
  let purchaseCache = null, purchaseCachePeriod = null;
  // AD_CONVERSION 7일 1회 수집 → 소재키(col5)·키워드키(col4) 두 맵 동시 생성(브랜드형쇼검 키워드 ROAS용). 둘 다 캐시.
  async function loadPurchase7d(setMsg) {
    // 기간 연동 (2026-07-23): dashDays 기준 일별 AD_CONVERSION 보고서 합산. 기간 바뀌면 재수집.
    if (purchaseCache && purchaseCachePeriod === dashDays) return purchaseCache;
    if (MOCK) { purchaseCache = { 'nad-1': { cnt: 3, val: 210000 }, 'nad-2': { cnt: 1, val: 33000 } }; purchaseKwCache = { 'nkw-b1': { cnt: 2, val: 96000 }, 'nkw-1': { cnt: 4, val: 320000 }, 'nkw-2': { cnt: 1, val: 28000 } }; purchaseCachePeriod = dashDays; return purchaseCache; }
    const daysArr = dashDays === 0 ? [0] : Array.from({ length: dashDays }, (_, i) => i + 1);
    let done = 0;
    const per = await mapLimit(daysArr, 5, async (d) => {
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
      done++; if (setMsg) setMsg(`구매전환 보고서 수집 ${done}/${daysArr.length}…`);
      return { ad, kw };
    });
    const mAd = {}, mKw = {};
    per.forEach(({ ad, kw }) => { for (const k in ad) { const m = (mAd[k] ||= { cnt: 0, val: 0 }); m.cnt += ad[k].cnt; m.val += ad[k].val; } for (const k in kw) { const m = (mKw[k] ||= { cnt: 0, val: 0 }); m.cnt += kw[k].cnt; m.val += kw[k].val; } });
    purchaseCache = mAd; purchaseKwCache = mKw; purchaseCachePeriod = dashDays; return mAd;
  }
  // 오가닉 순위: brandboard_rank(순위) + keyword_dict(검색수) → {상품번호: [{keyword,rank,vol}...]}. 검색수 많은 순.
  let organicCache = null;
  async function loadOrganicRanks() {
    if (organicCache) return organicCache;
    if (MOCK) {
      organicCache = { '86862273595': [{ keyword: '유아원피스', rank: 9, vol: 40100 }, { keyword: '여아원피스', rank: 12, vol: 12000 }], '9317773272': [] };
      organicKwCache = { '유아원피스': { vol: 40100, products: [{ pid: '86862273595', title: '오즈키즈 유아원피스 모모리본', rank: 9 }] }, '여아원피스': { vol: 12000, products: [{ pid: '86862273595', title: '오즈키즈 유아원피스 모모리본', rank: 12 }] }, '아기샌들': { vol: 21400, products: [] } };
      return organicCache;
    }
    try {
      const [bb, dict] = await Promise.all([
        fetch(KWDASH + '?action=brandboard_rank').then(r => r.json()),
        fetch(KWDASH + '?action=keyword_dict').then(r => r.json()).catch(() => ({ rows: [] })),
      ]);
      // 키워드→최신 주간검색수 (dict: 0~7 메타[…,6키워드,7시드], 8+ 주차. 끝에서 첫 비어있지 않은 값)
      const vol = {};
      (dict.rows || []).forEach(r => { const kw = r[6]; if (!kw) return; let v = 0; for (let i = r.length - 1; i >= 8; i--) { const t = String(r[i]).trim(); if (t) { const n = parseInt(t.replace(/,/g, ''), 10); if (Number.isFinite(n)) { v = n; break; } } } vol[kw] = v; });
      const map = {};
      (bb.values || []).forEach(v => (v.ozProducts || []).forEach(p => {
        const m = String(p.url || '').match(/products\/(\d+)/); if (!m) return;
        (map[m[1]] ||= []).push({ keyword: v.keyword, rank: p.rank });
      }));
      for (const id in map) {
        const best = {}; map[id].forEach(k => { if (!(k.keyword in best) || k.rank < best[k.keyword]) best[k.keyword] = k.rank; });
        map[id] = Object.entries(best).map(([keyword, rank]) => ({ keyword, rank, vol: vol[keyword] || 0 })).sort((a, b) => b.vol - a.vol); // 검색수 많은 순
      }
      // 키워드 기준 맵 (2026-07-29 키워드 뷰): 추적 키워드 전체(순위권 밖 포함), 제품은 최고 순위 1건씩
      const kwMap = {};
      (bb.values || []).forEach(v => {
        const best = {};
        (v.ozProducts || []).forEach(p => {
          const m = String(p.url || '').match(/products\/(\d+)/);
          const key = m ? m[1] : (p.title || '');
          if (!key) return;
          if (!(key in best) || p.rank < best[key].rank) best[key] = { pid: m ? m[1] : '', title: p.title || '', rank: p.rank };
        });
        kwMap[v.keyword] = { vol: vol[v.keyword] || 0, products: Object.values(best).sort((a, b) => a.rank - b.rank) };
      });
      organicKwCache = kwMap;
      organicCache = map; return map;
    } catch { return null; } // 실패 시 캐시 안 함(다음에 재시도) — 잘못된 '순위권 밖' 표시 방지
  }
  // 렌더된 소재 카드(.nvc-organic[data-pid])에 오가닉 순위 주입. top100 진입 없으면 '순위권 밖'. (재렌더 없이)
  function injectOrganic(map) {
    if (!map) return; // fetch 실패 시 아무것도 안 함
    organicLast = map; // 뷰 토글·상세 펼침 후 재주입용
    const setSortVal = (el, v) => { const tr = el.closest('tr.nvc-srow'); if (tr) tr.dataset.sorganic = v; }; // 시트 정렬값(최고 오가닉 순위)
    document.querySelectorAll('.nvc-organic[data-pid]').forEach(el => {
      const pid = el.dataset.pid, compact = el.dataset.compact === '1'; // compact=시트 행 셀
      if (!pid) { el.innerHTML = compact ? '<span style="color:var(--muted);font-size:11px">—</span>' : ''; if (compact) setSortVal(el, ''); return; } // 상품번호 없으면 판정 불가
      const list = map[pid];
      if (!list || !list.length) {
        el.innerHTML = compact ? '<span style="color:var(--muted);font-size:11px">순위권 밖</span>' : '<span style="color:var(--muted)">🌿 오가닉 <span style="font-weight:700">순위권 밖</span> <span style="font-size:10px">(추적 키워드 top100 진입 없음)</span></span>';
        if (compact) setSortVal(el, '');
        return;
      }
      if (compact) {
        el.innerHTML = list.slice(0, 4).map(k => `<span class="nvs-oc ${k.rank <= 10 ? 't' : k.rank <= 50 ? 'm' : 'l'}" title="${esc(k.keyword)}${k.vol ? ' · 주간검색 ' + cnt(k.vol) : ''} · ${k.rank}위">${esc(k.keyword)} ${k.rank}</span>`).join('');
        setSortVal(el, Math.min(...list.map(k => k.rank)));
        return;
      }
      const top = list.slice(0, 6).map(k => `<span style="background:var(--green-l);color:var(--green);border-radius:6px;padding:1px 7px;font-weight:700">${esc(k.keyword)}${k.vol ? ` <span style="opacity:.7;font-weight:400">(${cnt(k.vol)})</span>` : ''} ${k.rank}위</span>`).join(' ');
      el.innerHTML = `<span style="color:var(--muted);font-weight:700;margin-right:4px">🌿 오가닉</span>${top}`;
    });
    if (dashView === 'sheet' && dashSort.key === 'organic') applySheetSort(); // 오가닉 값 도착 후 정렬 재적용
    if (dashView === 'kw' && organicKwCache && document.getElementById('nvk-empty')) { if (swapProdView()) wireKwSheet(); } // 키워드 뷰 자리표시자 → 데이터 도착 후 재구성
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

  // ── 입찰 규칙 엔진 (목표 ROAS = TARGET_ROAS, 데드존 밴드, 요일·공휴일 보정) ──
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
  function roasFactor(r) { // 목표(TARGET_ROAS) 배수 기준 밴드. 목표~1.2배=유지(데드존)
    const t = TARGET_ROAS;
    if (r >= t * 2) return 1.20; if (r >= t * 1.5) return 1.15; if (r >= t * 1.2) return 1.08;
    if (r >= t) return 1.00; if (r >= t * 0.84) return 0.88; return 0.80;
  }
  function computeBid(cur, roas, mod) {
    let nb = Math.round(cur * roasFactor(roas) * mod / 10) * 10;
    const lo = Math.round(cur * 0.75 / 10) * 10, hi = Math.round(cur * 1.25 / 10) * 10; // 1회 ±25% 캡
    nb = Math.max(lo, Math.min(hi, nb));
    nb = Math.max(70, Math.min(100000, nb));
    if (roas < TARGET_ROAS && nb > cur) nb = cur; // 목표 미만은 상향 금지
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
  // 키워드별 직접구매(구매완료·직접) — loadPurchase7d가 소재키·키워드키 동시 수집하므로 재사용(다운로드 1회). 기간 연동.
  async function loadPurchaseKw7d(setMsg) {
    if (purchaseKwCache && purchaseCachePeriod === dashDays) return purchaseKwCache;
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
      <td style="${tf};color:${pending ? 'var(--muted)' : (gr.total && gr.aval / gr.total * 100 >= TARGET_ROAS ? 'var(--green)' : 'var(--red)')}">${pending ? '…' : (gr.total ? Math.round(gr.aval / gr.total * 100) + '%' : '-')}</td>
      <td style="${tf}"></td><td style="${tf}"></td><td style="${tf}"></td>
    </tr></tfoot>`;
    const tableHead = `<thead><tr style="color:var(--muted);font-size:11px;text-align:right;border-bottom:1px solid var(--border)">
      <th style="text-align:left;${thc}">키워드</th><th style="${thc}">순위</th><th style="text-align:left;${thc}">품질</th><th style="${thc}">노출</th><th style="${thc}">클릭</th><th style="${thc}">CTR</th><th style="${thc}">CPC</th><th style="${thc}">총비용</th><th style="${thc}">구매(직접)</th><th style="${thc}">ROAS</th><th style="text-align:right;${thc}">입찰가 (현재→제안)</th><th style="${thc}">On/Off</th><th style="${thc}" title="입찰·ON/OFF 변경 이력">이력</th>
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
    const gNoImp = structure.reduce((t, s) => t + s.groups.reduce((t2, gr) => t2 + gr.items.filter(it => !(it.kw.userLock === true || !isRunning(it.kw)) && !it.b.imp).length, 0), 0);
    const chipP = (on) => `cursor:pointer;padding:4px 10px;border-radius:8px;border:1px solid var(--border2);font-size:12px;font-weight:700;background:${on ? 'var(--accent)' : 'var(--accent-l)'};color:${on ? '#fff' : 'var(--accent-d)'}`;
    body.innerHTML = `
      <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-bottom:10px">
        <span style="font-size:12px;color:var(--muted);font-weight:700">📅 데이터 기간</span>
        ${PERIODS.map(([d, lbl]) => `<button class="nvf-period" data-d="${d}" style="${chipP(dashDays === d)}">${lbl}</button>`).join('')}
        <span style="font-size:11px;color:var(--muted)">${dashDays === 0 ? '· 오늘은 집계 지연으로 실제보다 낮게 보일 수 있어요' : '· 어제까지 완결 ' + dashDays + '일'}</span>
      </div>
      <div class="nvc-tiles" style="grid-template-columns:repeat(5,1fr)">
        <div class="nvc-tile"><div class="k">총비용 (${periodLabel()})</div><div class="v">${won(gCost)}</div></div>
        <div class="nvc-tile"><div class="k">구매 ROAS <span style="color:var(--muted);font-weight:400">직접 · ${periodLabel()}</span></div><div class="v" style="color:${pending ? 'var(--muted)' : (gRoas >= TARGET_ROAS ? 'var(--green)' : 'var(--red)')}">${pending ? '<span style="font-size:13px">집계 중…</span>' : (gCost ? Math.round(gRoas) + '%' : '-')}</div></div>
        <div class="nvc-tile"><div class="k">구매 전환 (${periodLabel()})</div><div class="v">${pending ? '<span style="color:var(--muted);font-size:13px">집계 중…</span>' : gConvN + '건 · ' + cnt(gConvV) + '원'}</div></div>
        <div class="nvc-tile"><div class="k">미노출 (${periodLabel()} 노출 0)</div><div class="v" style="color:${gNoImp ? 'var(--amber)' : 'var(--text)'}">${gNoImp}</div></div>
        <div class="nvc-tile"><div class="k">키워드 · 변경대상</div><div class="v">${kwCount} · <span style="color:var(--accent-d)">${pending ? '…' : nvPwrSug.length}</span></div></div>
      </div>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:8px">
        <input id="nvpf-q" placeholder="🔎 키워드 검색" style="padding:7px 10px;border:1px solid var(--border2);border-radius:9px;background:var(--surface);color:var(--text);font-size:13px;min-width:160px">
        <label style="font-size:12px;color:var(--muted);display:flex;align-items:center;gap:4px"><input type="checkbox" id="nvpf-changed"> 제안 있는 것만</label>
        <label style="font-size:12px;color:var(--muted);display:flex;align-items:center;gap:4px"><input type="checkbox" id="nvpf-paused" ${pwrPaused ? 'checked' : ''}> 정지 포함</label>
        <span style="font-size:12px;color:var(--muted)">· ${mod.label} 보정 · 비용순 · 그룹입찰 키워드는 제외</span>
        <button id="nvp-selnone" style="margin-left:auto;padding:8px 14px;border-radius:10px;border:1px solid var(--border2);background:var(--surface);color:var(--muted);cursor:pointer;font-weight:600;font-size:13px;${(!pending && nvPwrSug.length) ? '' : 'display:none'}">전체 해제</button>
        <button id="nvp-applyall" style="${pBtn}" ${(!pending && nvPwrSug.length) ? '' : 'disabled'}>${pending ? '⏳ 구매전환 집계 중…' : (nvPwrSug.length ? `▶ ${nvPwrSug.length}건 입찰가 반영` : '변경 대상 없음')}</button>
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
    const selN = $('#nvp-selnone'); if (selN) selN.onclick = () => { const cbs = [...document.querySelectorAll('.nvp-cb')]; const anyOn = cbs.some(c => c.checked); cbs.forEach(c => c.checked = !anyOn); upd(); selN.textContent = anyOn ? '전체 선택' : '전체 해제'; };
    document.querySelectorAll('.nvp-off').forEach(b => b.onclick = () => togglePowerKw(b));
    document.querySelectorAll('.nvf-period').forEach(b => b.onclick = () => { dashDays = +b.dataset.d; renderPowerBid(); });
    document.querySelectorAll('.nv-hist').forEach(b => b.onclick = () => toggleEntityHistory(b));
    document.querySelectorAll('.nv-urlcopy').forEach(b => b.onclick = () => { navigator.clipboard.writeText(b.dataset.url).then(() => { const t = b.textContent; b.textContent = '✓'; setTimeout(() => b.textContent = t, 1200); }); });
    loadBidHistory('powerlink', 'nvp-history');
    injectRecentChanges(); // 키워드 행 '최근 변경' 미니 표시
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
      // ON/OFF 조작 기록 (2026-07-23): nv_bid_changes에 channel='onoff', old/new_bid=1(ON)/0(OFF)
      api('log_bid_change', { body: { rows: [{ channel: 'onoff', entity_id: b.dataset.kw, name: b.dataset.name || b.dataset.kw, old_bid: lock ? 1 : 0, new_bid: lock ? 0 : 1 }] } }).catch(() => {});
      nvHistCache = null; // 이력 캐시 무효화(다음 펼침 때 새 기록 반영)
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
    const roasCol = pend ? 'var(--muted)' : (it.b.cost ? (it.roas >= TARGET_ROAS ? 'var(--green)' : 'var(--red)') : 'var(--muted)');
    const buyTxt = pend ? '…' : (it.pc.cnt + '건·' + cnt(it.pc.val));
    const noImp = !paused && !it.b.imp;
    const rk = it.b.rank;
    const rankCell = rk > 0
      ? `<b style="color:${rk <= 3 ? 'var(--green)' : rk <= 6 ? 'var(--amber, #B45309)' : 'var(--red)'}">${rk.toFixed(1)}</b>`
      : '<span style="color:var(--muted)">—</span>';
    return `<tr class="nvp-row" data-kw="${esc((kw.keyword || '').toLowerCase())}" data-changed="${changed ? '1' : '0'}" data-noimp="${noImp ? '1' : '0'}" style="border-top:1px solid var(--border)">
      <td style="padding:6px 8px;text-align:left"><span style="font-size:11px" title="${paused ? '정지' : (noImp ? '미노출(기간 내 노출 0)' : '노출중')}">${paused ? '⚪' : (noImp ? '🟡' : '🟢')}</span> <span style="font-weight:600">${esc(kw.keyword || kw.nccKeywordId)}</span>${noImp ? ' <span style="font-size:10px;color:var(--amber, #B45309);font-weight:700">미노출</span>' : ''}</td>
      <td style="${td}">${rankCell}</td>
      <td style="padding:6px 8px;text-align:left">${qiBar(kw.nccQi && kw.nccQi.qiGrade)}</td>
      <td style="${td}">${cnt(it.b.imp)}</td>
      <td style="${td}">${cnt(it.b.clk)}</td>
      <td style="${td}">${it.ctr.toFixed(2)}%</td>
      <td style="${td}">${won(Math.round(it.cpc))}</td>
      <td style="${td}">${won(it.b.cost)}</td>
      <td style="${td}">${buyTxt}</td>
      <td style="${td};font-weight:700;color:${roasCol}">${roasTxt}</td>
      <td id="nvpb-${esc(kw.nccKeywordId)}" style="${td}">${bidCell}</td>
      <td style="padding:6px 8px;text-align:center"><button class="nvp-off" data-kw="${esc(kw.nccKeywordId)}" data-ag="${esc(kw.nccAdgroupId)}" data-name="${esc(kw.keyword || kw.nccKeywordId)}" data-lock="${locked ? '0' : '1'}" style="font-size:11px;padding:2px 10px;border-radius:6px;border:1px solid var(--border2);background:var(--surface);color:${locked ? 'var(--green)' : 'var(--red)'};cursor:pointer;font-weight:700">${locked ? 'ON' : 'OFF'}</button></td>
      <td style="padding:6px 8px;text-align:center;white-space:nowrap"><span class="nv-recent-mini" data-id="${esc(kw.nccKeywordId)}" style="font-size:10px;color:var(--muted);margin-right:4px"></span><button class="nv-hist" data-id="${esc(kw.nccKeywordId)}" style="font-size:11px;padding:2px 8px;border-radius:6px;border:1px solid var(--border2);background:var(--surface);color:var(--muted);cursor:pointer">▾</button></td>
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
  // ── 항목별 변경 이력 토글 (2026-07-23): 입찰 변경 + ON/OFF 조작을 행/카드 아래로 펼침 ──
  //    nv_bid_changes 전체(채널 무필터, 최근 200건)를 1회 로드 후 entity_id로 필터. 세션 캐시.
  let nvHistCache = null;
  async function loadAllHistory() {
    if (nvHistCache) return nvHistCache;
    const r = await api('get_bid_changes', { params: { limit: '200' } });
    nvHistCache = (r && r.changes) || [];
    return nvHistCache;
  }
  async function toggleEntityHistory(btn) {
    const host = btn.closest('tr') || btn.closest('.nvc-card');
    if (!host) return;
    const next = host.nextElementSibling;
    if (next && next.classList.contains('nv-hist-row')) { next.remove(); return; } // 재클릭 = 접기
    const isRow = host.tagName === 'TR';
    const detail = document.createElement(isRow ? 'tr' : 'div');
    detail.className = 'nv-hist-row';
    const fill = (html) => {
      if (isRow) detail.innerHTML = `<td colspan="${host.children.length}" style="padding:6px 12px;background:var(--surface2);border-top:1px solid var(--border)">${html}</td>`;
      else { detail.style.cssText = 'margin:-6px 0 10px;padding:8px 14px;background:var(--surface2);border:1px solid var(--border);border-radius:0 0 12px 12px'; detail.innerHTML = html; }
    };
    fill('<span style="font-size:11px;color:var(--muted)">⏳ 이력 불러오는 중…</span>');
    host.after(detail);
    try {
      const all = await loadAllHistory();
      const mine = all.filter(c => c.entity_id === btn.dataset.id);
      if (!mine.length) { fill('<span style="font-size:11px;color:var(--muted)">이 항목의 변경 이력이 없어요.</span>'); return; }
      const fmt = (iso) => { const k = new Date(new Date(iso).getTime() + 9 * 3600000); return k.toISOString().slice(5, 16).replace('T', ' '); };
      fill(`<div style="font-size:11px;color:var(--muted);font-weight:700;margin-bottom:3px">변경 이력 ${mine.length}건</div>` +
        mine.map(c => {
          if (c.channel === 'onoff') {
            const on = c.new_bid === 1;
            const ext = String(c.name || '').includes('(외부감지)') ? ' <span style="color:var(--muted);font-weight:400">· 관리자에서 변경(감지 시각 기준)</span>' : '';
            return `<div style="font-size:11px;padding:1px 0;display:flex;gap:8px"><span style="min-width:78px;color:var(--muted)">${fmt(c.changed_at)}</span><span style="font-weight:700;color:${on ? 'var(--green)' : 'var(--red)'}">${on ? '🟢 ON (노출 재개)' : '🔴 OFF (정지)'}${ext}</span></div>`;
          }
          const d = (c.new_bid || 0) - (c.old_bid || 0); const col = d > 0 ? 'var(--green)' : (d < 0 ? 'var(--red)' : 'var(--muted)');
          return `<div style="font-size:11px;padding:1px 0;display:flex;gap:8px"><span style="min-width:78px;color:var(--muted)">${fmt(c.changed_at)}</span><span>입찰 ${cnt(c.old_bid)} → <b style="color:${col}">${cnt(c.new_bid)}원</b></span></div>`;
        }).join(''));
    } catch (e) { fill('<span style="font-size:11px;color:var(--red)">이력 조회 실패: ' + esc(e.message || String(e)) + '</span>'); }
  }

  // ── 📋 스냅샷 복사 (2026-07-28): 라이브 상품형 광고 + 최근 7일 ON/OFF 기록 → TSV 클립보드 ──
  //    정렬: ON 먼저 → OFF, 각 그룹 안에서 총비용(선택 기간) 내림차순. 시트에 바로 붙여넣기 가능.
  let nvSnapProducts = [], nvSnapPending = true;
  async function nvcSnapshot(btn) {
    if (nvSnapPending && !confirm('구매 ROAS가 아직 집계 중이라 ROAS 컬럼이 비어 있어요.\n집계가 끝나면(상단 타일 숫자 표시) 다시 누르는 걸 권장합니다.\n그래도 지금 복사할까요?')) return;
    const prev = btn.textContent; btn.disabled = true; btn.textContent = '⏳ 생성 중…';
    try {
      // 최근 2주 ON/OFF 기록 (앱 조작 + 외부감지 + 수동 등록 모두 — 2026-07-28: 7일→14일, 오가닉 상위라 수동 OFF한 소재들이 창 밖으로 빠지던 문제)
      let recent = {};
      try {
        const all = await loadAllHistory();
        const cut = Date.now() - 14 * 86400000;
        all.filter(c => c.channel === 'onoff' && new Date(c.changed_at).getTime() >= cut)
          .sort((a, b) => a.changed_at < b.changed_at ? -1 : 1)
          .forEach(c => {
            const t = new Date(new Date(c.changed_at).getTime() + 9 * 3600000).toISOString().slice(5, 10);
            (recent[c.entity_id] ||= []).push(`${t} ${c.new_bid === 1 ? 'ON' : 'OFF'}${String(c.name || '').includes('(외부감지)') ? '(관리자)' : ''}`);
          });
      } catch (e) {}
      const rows = nvSnapProducts
        .filter(it => !it.paused || recent[it.id])
        .sort((a, b) => (a.paused - b.paused) || (b.cost - a.cost));
      if (!rows.length) { btn.textContent = '대상 없음'; setTimeout(() => { btn.textContent = prev; btn.disabled = false; }, 1500); return; }
      const stLabel = it => it.paused ? (it.gOff ? 'OFF(그룹)' : 'OFF') : (it.sysP ? '중지(연동이상)' : (it.noImp ? 'ON·미노출' : 'ON·노출중'));
      const clean = v => String(v == null ? '' : v).replace(/[\t\r\n]+/g, ' ');
      const kst = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 16).replace('T', ' ');
      const head = `네이버 쇼핑검색 상품형 스냅샷 · 생성 ${kst} (KST) · 데이터 기간: ${periodLabel()} · ${rows.length}개 (라이브 전체 + 2주 내 ON/OFF 기록)`;
      // 오가닉 순위(추적 키워드 top100, 검색수 상위 3개) — 카드와 동일 소스(loadOrganicRanks)
      const org = await loadOrganicRanks().catch(() => null);
      const orgTxt = it => {
        if (!org || !it.pid) return '-';
        const list = org[it.pid];
        if (!list || !list.length) return '순위권 밖';
        return list.slice(0, 3).map(k => `${k.keyword} ${k.rank}위`).join(' / ');
      };
      // 제품명을 첫 컬럼으로(노션 붙여넣기 시 제목(Aa)=소재명), 썸네일은 맨 끝(노션이 이미지를
      // 파일 속성으로 옮기며 열이 밀리던 문제 회피 — 2026-07-28)
      const cols = ['제품', '상태', '광고그룹', '광고순위', '오가닉 순위', `총비용(${periodLabel()})`, 'ROAS', '최근 2주 ON/OFF 기록', '썸네일'];
      const cell = it => [
        clean(it.name),
        stLabel(it),
        clean(it.group),
        it.rank > 0 ? it.rank.toFixed(1) + '위' : '-',
        clean(orgTxt(it)),
        Math.round(it.cost).toLocaleString() + '원',
        it.roas != null ? it.roas + '%' : '-',
        (recent[it.id] || []).join(' / ') || '-',
        it.thumb ? `=IMAGE("${String(it.thumb).replace(/"/g, '')}")` : '', // 시트/엑셀365에서 이미지로 렌더
      ];
      const tsv = [head, cols.join('\t'), ...rows.map(it => cell(it).join('\t'))].join('\n');
      // HTML 포맷(이미지 셀 포함) — 구글시트는 붙여넣기 시 HTML을 우선 사용해 <img>를 셀 이미지로 삽입
      const eh = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const htmlTbl = `<table><tr><td colspan="${cols.length}">${eh(head)}</td></tr>` +
        `<tr>${cols.map(c => `<th>${eh(c)}</th>`).join('')}</tr>` +
        rows.map(it => {
          const c = cell(it);
          return '<tr>' + c.slice(0, 8).map(x => `<td>${eh(x)}</td>`).join('') +
            `<td>${it.thumb ? `<img src="${eh(it.thumb)}" width="64">` : ''}</td></tr>`;
        }).join('') + '</table>';
      // 이중 포맷 클립보드(HTML+텍스트) → 미지원 브라우저는 TSV 텍스트 폴백
      try {
        await navigator.clipboard.write([new ClipboardItem({
          'text/plain': new Blob([tsv], { type: 'text/plain' }),
          'text/html': new Blob([htmlTbl], { type: 'text/html' }),
        })]);
      } catch (e2) { await navigator.clipboard.writeText(tsv); }
      btn.textContent = `✓ ${rows.length}행 복사됨 — 시트에 붙여넣기`;
    } catch (e) { btn.textContent = '복사 실패'; alert('스냅샷 복사 실패: ' + (e.message || e)); }
    setTimeout(() => { btn.textContent = prev; btn.disabled = false; }, 2500);
  }

  // ── 최근 변경 상시 표시 (2026-07-23): 카드 하단 '🕐 최근 변경'과 키워드 표 이력 셀을 채움 ──
  async function injectRecentChanges() {
    try {
      const all = await loadAllHistory();
      const latest = {}; // entity_id -> 최신 1건 (changed_at desc 정렬이므로 첫 것)
      all.forEach(c => { if (!(c.entity_id in latest)) latest[c.entity_id] = c; });
      const fmt = (iso) => { const k = new Date(new Date(iso).getTime() + 9 * 3600000); return k.toISOString().slice(5, 16).replace('T', ' '); };
      const line = (c) => c.channel === 'onoff'
        ? `${fmt(c.changed_at)} ${c.new_bid === 1 ? '🟢 ON' : '🔴 OFF'}${String(c.name || '').includes('(외부감지)') ? ' (관리자)' : ''}`
        : `${fmt(c.changed_at)} 입찰 ${cnt(c.old_bid)}→${cnt(c.new_bid)}원`;
      document.querySelectorAll('.nv-recent[data-id]').forEach(el => {
        const v = el.querySelector('.nv-recent-val'); if (!v) return;
        const c = latest[el.dataset.id];
        if (c) v.textContent = line(c);
        else { v.textContent = '기록 없음'; v.style.color = 'var(--muted)'; v.style.fontWeight = '400'; }
      });
      document.querySelectorAll('.nv-recent-mini[data-id]').forEach(el => {
        const c = latest[el.dataset.id];
        el.textContent = c ? line(c) : '';
      });
    } catch (e) { /* 이력 테이블 미가용 시 조용히 생략 */ }
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
            <td style="padding:6px 8px;text-align:right;font-weight:700;color:${d.roas == null ? 'var(--muted)' : (d.roas >= TARGET_ROAS ? 'var(--green)' : 'var(--red)')}">${d.roas == null ? '-' : d.roas + '%'}</td>
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
        { nccAdId: 'nad-1', userLock: false, adAttr: { bidAmt: 660, useGroupBidAmt: false }, nccQi: { qiGrade: 5 }, ad: { headline: '오즈키즈 래쉬가드', description: '자외선 차단 UPF50+ 아기 유아 수영복', pc: { final: 'https://brand.naver.com/ozkiz/search?q=래쉬가드&st=REVIEW&dt=IMAGE&nt_source=npowerlink&nt_medium=swimsuit&nt_keyword={keyword}', display: 'https://smartstore.naver.com/ozkids' } }, referenceData: { productTitle: '오즈키즈 여아 치랭스 레깅스 유아 아기', mallProductId: '86862273595', lowPrice: '16900', category3Name: '레깅스', scoreInfo: '4.9', reviewCountSum: '312', imageUrl: 'https://shopping-phinf.pstatic.net/main_8686227/86862273595.1.jpg' } },
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
