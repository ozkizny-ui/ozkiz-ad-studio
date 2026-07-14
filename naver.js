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
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

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

  // ── 렌더 ─────────────────────────────────────────────────────
  let root, prevActive = null;
  function open() {
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

  // 네이버는 '광고 예산 조정'(입찰 대시보드)만. (제외키워드 renderNeg는 코드 유지·추후 내비 추가)
  function render() {
    root.innerHTML = `
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:14px">
        <div style="font-size:18px;font-weight:700">네이버 · 광고 예산 조정</div>
        ${MOCK ? '<span style="color:var(--muted,#888);font-size:12px">🧪 목데이터 모드</span>' : ''}
      </div>
      <div id="nv-body"></div>`;
    renderBid();
  }

  // ── 입찰 대시보드 (읽기) ──────────────────────────────────────
  async function renderBid() {
    const body = $('#nv-body');
    body.innerHTML = loading('쇼핑검색 캠페인 불러오는 중…');
    try {
      const camps = await api('get_campaigns');
      const shopping = camps.filter(c => c.campaignTp === 'SHOPPING');
      const pl = camps.filter(c => c.campaignTp === 'WEB_SITE');
      body.innerHTML = `
        <div style="display:flex;gap:12px;align-items:center;margin-bottom:12px;flex-wrap:wrap">
          <div style="font-weight:600">쇼핑검색 ${shopping.length} · 파워링크 ${pl.length}</div>
          <select id="nv-camp" style="padding:6px;border-radius:8px;background:var(--surface);color:inherit;border:1px solid var(--border,#333);min-width:260px">
            <option value="">— 쇼핑검색 캠페인 선택 —</option>
            ${shopping.map(c => `<option value="${c.nccCampaignId}">${esc(c.name)}</option>`).join('')}
          </select>
          <select id="nv-group" style="padding:6px;border-radius:8px;background:var(--surface);color:inherit;border:1px solid var(--border,#333);min-width:220px" disabled>
            <option value="">— 광고그룹 —</option>
          </select>
        </div>
        <div id="nv-ads"><div style="color:var(--muted);padding:16px">쇼핑검색 캠페인 → 광고그룹을 선택하면 상품별 입찰가와 규칙 미리보기가 표시됩니다.</div></div>`;
      const campSel = $('#nv-camp'), groupSel = $('#nv-group'), adsEl = $('#nv-ads');
      campSel.onchange = async () => {
        groupSel.innerHTML = '<option value="">— 광고그룹 —</option>'; groupSel.disabled = true; adsEl.innerHTML = '';
        if (!campSel.value) return;
        adsEl.innerHTML = loading('광고그룹 불러오는 중…');
        const groups = await api('get_adgroups', { params: { nccCampaignId: campSel.value } });
        groupSel.innerHTML = '<option value="">— 광고그룹 선택 —</option>' +
          groups.map(g => `<option value="${g.nccAdgroupId}">${esc(g.name)}</option>`).join('');
        groupSel.disabled = false; adsEl.innerHTML = '<div style="color:var(--muted,#888);padding:16px">광고그룹을 선택하면 상품별 입찰가가 표시됩니다.</div>';
      };
      groupSel.onchange = async () => {
        if (!groupSel.value) return;
        adsEl.innerHTML = loading('상품(소재) 불러오는 중…');
        const ads = await api('get_ads', { params: { nccAdgroupId: groupSel.value } });
        renderAdsTable(adsEl, ads);
      };
    } catch (e) { body.innerHTML = errBox(e); }
  }

  function renderAdsTable(container, ads) {
    if (!ads.length) { container.innerHTML = '<div style="color:var(--muted,#888);padding:16px">이 그룹에 상품(소재)이 없어요.</div>'; return; }
    const rows = ads.map(a => {
      const rd = a.referenceData || {};
      const paused = a.userLock === true;
      return `<tr style="border-bottom:1px solid var(--border,#2a2a2a)">
        <td style="padding:8px">${esc(rd.productTitle || a.nccAdId)}</td>
        <td style="padding:8px;text-align:right;font-variant-numeric:tabular-nums">${won(a.adAttr && a.adAttr.bidAmt)}</td>
        <td style="padding:8px;text-align:right;color:var(--muted,#888)">${rd.lowPrice ? won(rd.lowPrice) : '-'}</td>
        <td style="padding:8px;text-align:center">${paused ? '<span style="color:var(--muted,#888)">일시정지</span>' : '<span style="color:var(--green,#4a7)">노출중</span>'}</td>
      </tr>`;
    }).join('');
    container.innerHTML = `
      <table style="width:100%;border-collapse:collapse;font-size:14px">
        <thead><tr style="text-align:left;color:var(--muted,#888);border-bottom:1px solid var(--border,#333)">
          <th style="padding:8px">상품(소재)</th><th style="padding:8px;text-align:right">현재 입찰가</th>
          <th style="padding:8px;text-align:right">최저가</th><th style="padding:8px;text-align:center">상태</th>
        </tr></thead><tbody>${rows}</tbody>
      </table>
      <div style="margin-top:12px;display:flex;gap:10px;align-items:center;flex-wrap:wrap">
        <button id="nv-preview" style="padding:6px 14px;border-radius:8px;border:1px solid var(--border,#333);background:var(--accent,#4a7);color:inherit;cursor:pointer;font-weight:600">🔮 규칙 미리보기</button>
        <span style="color:var(--muted,#888);font-size:12px">목표 ROAS 300% · 금토일 −10% · 공휴일 −15% · 최근 30일 ROAS 기준</span>
      </div>
      <div id="nv-preview-out" style="margin-top:12px"></div>`;
    const pv = container.querySelector('#nv-preview');
    if (pv) pv.onclick = () => previewBids(ads);
  }

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
  async function adRoas(nccAdId) {
    try {
      const r = await api('stats', { params: { id: nccAdId, fields: JSON.stringify(['salesAmt', 'convAmt']), timeRange: JSON.stringify({ since: isoAgo(30), until: isoAgo(1) }) } });
      const rows = Array.isArray(r) ? r : (Array.isArray(r.data) ? r.data : []);
      let cost = 0, rev = 0;
      rows.forEach(x => { cost += Number(x.salesAmt) || 0; rev += Number(x.convAmt) || 0; });
      return cost > 0 ? rev / cost * 100 : null;
    } catch { return null; }
  }
  async function previewBids(ads) {
    const out = $('#nv-preview-out'); out.innerHTML = loading('소재별 최근 ROAS 계산 중…');
    const { mod, label } = dayModifier();
    const active = ads.filter(a => a.userLock !== true);
    const rows = await Promise.all(active.map(async a => {
      const cur = Number(a.adAttr && a.adAttr.bidAmt);
      const roas = await adRoas(a.nccAdId);
      const nb = roas == null ? cur : computeBid(cur, roas, mod);
      return { a, cur, roas, nb };
    }));
    const changed = rows.filter(r => r.nb !== r.cur);
    const fmtRoas = (r) => r == null ? '<span style="color:var(--muted,#888)">데이터없음</span>' : Math.round(r) + '%';
    const trs = rows.map(r => {
      const d = r.nb - r.cur, pct = r.cur ? Math.round(d / r.cur * 100) : 0;
      const color = d > 0 ? 'var(--green,#4a7)' : d < 0 ? 'var(--red,#c33)' : 'var(--muted,#888)';
      return `<tr style="border-bottom:1px solid var(--border,#2a2a2a)">
        <td style="padding:6px 8px">${esc((r.a.referenceData || {}).productTitle || r.a.nccAdId)}</td>
        <td style="padding:6px 8px;text-align:right">${fmtRoas(r.roas)}</td>
        <td style="padding:6px 8px;text-align:right">${won(r.cur)}</td>
        <td style="padding:6px 8px;text-align:right;color:${color};font-weight:600">${won(r.nb)}</td>
        <td style="padding:6px 8px;text-align:right;color:${color}">${d === 0 ? '-' : (d > 0 ? '+' : '') + pct + '%'}</td>
      </tr>`;
    }).join('');
    out.innerHTML = `
      <div style="margin-bottom:8px;font-size:13px"><b>보정:</b> ${label} · <b>변경 대상 ${changed.length}</b>/${active.length}건 (일시정지 제외)</div>
      <table style="width:100%;border-collapse:collapse;font-size:13px">
        <thead><tr style="text-align:left;color:var(--muted,#888);border-bottom:1px solid var(--border,#333)">
          <th style="padding:6px 8px">상품</th><th style="padding:6px 8px;text-align:right">최근 ROAS</th>
          <th style="padding:6px 8px;text-align:right">현재</th><th style="padding:6px 8px;text-align:right">제안</th><th style="padding:6px 8px;text-align:right">Δ</th>
        </tr></thead><tbody>${trs}</tbody></table>
      ${changed.length
        ? `<button id="nv-exec" style="margin-top:12px;padding:8px 18px;border-radius:8px;border:none;background:var(--accent,#4a7);color:#fff;cursor:pointer;font-weight:600">▶ ${changed.length}건 입찰가 반영</button>`
        : '<div style="margin-top:12px;color:var(--muted,#888)">변경할 소재 없음 (모두 안전구간이거나 데이터 없음).</div>'}
      <div id="nv-exec-out" style="margin-top:10px"></div>`;
    const ex = $('#nv-exec'); if (ex) ex.onclick = () => execBids(changed);
  }
  async function execBids(changed) {
    if (MOCK) { $('#nv-exec-out').innerHTML = `<div style="color:var(--muted,#888)">🧪 목모드: 실제 반영 안 함 (${changed.length}건).</div>`; return; }
    if (!localStorage.getItem('sb_write_token')) { alert('쓰기 인증이 필요합니다. 좌측 사이드바 "🔒 쓰기 잠김"을 눌러 해제하세요.'); return; }
    if (!confirm(`${changed.length}건의 입찰가를 실제로 변경합니다. 진행할까요?`)) return;
    const out = $('#nv-exec-out'); out.innerHTML = loading('입찰가 반영 중…');
    let ok = 0, fail = 0; const errs = [];
    for (const r of changed) {
      try { await api('update_ad_bid', { body: { nccAdId: r.a.nccAdId, bidAmt: r.nb } }); ok++; }
      catch (e) { fail++; errs.push(esc((r.a.referenceData || {}).productTitle || r.a.nccAdId) + ': ' + esc(e.message)); }
    }
    out.innerHTML = `<div style="padding:8px;border-radius:8px;background:var(--surface)">반영 완료 — 성공 ${ok} / 실패 ${fail}${errs.length ? '<br><span style="color:var(--red,#c33);font-size:12px">' + errs.join('<br>') + '</span>' : ''}</div>`;
  }

  // ── 제외키워드 제안 ───────────────────────────────────────────
  const btnCss = 'padding:6px 14px;border-radius:8px;border:1px solid var(--border,#333);background:var(--accent,#4a7);color:inherit;cursor:pointer;font-weight:600';
  function renderNeg() {
    $('#nv-body').innerHTML = `
      <div style="display:grid;gap:22px;max-width:820px">
        <section>
          <div style="font-weight:600;margin-bottom:6px">🔍 파워링크 검색어 자동 분석 (EXPKEYWORD)</div>
          <div style="color:var(--muted,#888);font-size:12px;margin-bottom:8px">검색어 보고서를 자동 수집해 낭비 검색어를 찾고, 파워링크 광고그룹에 <b>원클릭 제외</b>합니다.</div>
          <button id="nv-plkw" style="${btnCss}">최근 검색어 불러오기</button>
          <div id="nv-plkw-out" style="margin-top:12px"></div>
        </section>
        <section style="border-top:1px solid var(--border,#333);padding-top:18px">
          <div style="font-weight:600;margin-bottom:6px">📄 쇼핑검색 제외검색어 제안 (CSV 업로드)</div>
          <div style="color:var(--muted,#888);font-size:12px;margin-bottom:8px">쇼핑 검색어는 네이버 API 미제공 → 광고관리에서 받은 <b>"랭킹 키워드_쇼핑검색" CSV</b>를 올리면 낭비 검색어를 분석해 제외 후보를 제안합니다. (반영은 대시보드에서 수동)</div>
          <input type="file" id="nv-csv" accept=".csv,text/csv">
          <div id="nv-csv-out" style="margin-top:12px"></div>
        </section>
      </div>`;
    $('#nv-plkw').onclick = analyzePowerlink;
    $('#nv-csv').onchange = (e) => { const f = e.target.files && e.target.files[0]; if (f) f.text().then(parseShoppingCsv).catch(err => { $('#nv-csv-out').innerHTML = errBox(err); }); };
  }

  // 파워링크: EXPKEYWORD 보고서 → 낭비 검색어 → 원클릭 제외
  async function analyzePowerlink() {
    const out = $('#nv-plkw-out'); out.innerHTML = loading('EXPKEYWORD 보고서 생성·다운로드 중… (수십 초 걸릴 수 있어요)');
    try {
      const job = await api('report_create', { body: { reportTp: 'EXPKEYWORD', statDt: isoAgo(2) } });
      const id = job.reportJobId || job.id;
      let url = null;
      for (let i = 0; i < 15; i++) { await sleep(2000); const st = await api('report_status', { params: { id } }); if (st.status === 'BUILT' || st.status === 'DONE') { url = st.downloadUrl; break; } if (st.status === 'NONE' || st.status === 'DELETED') break; }
      if (!url) { out.innerHTML = errBox({ message: '보고서 생성 실패 또는 데이터 없음' }); return; }
      const dl = await api('report_download', { params: { url } });
      const rows = parseExpKw(dl.tsv || (typeof dl === 'string' ? dl : ''));
      api('report_delete', { params: { id } }).catch(() => {});
      renderPlkwOut(out, rows);
    } catch (e) { out.innerHTML = errBox(e); }
  }
  // EXPKEYWORD TSV 파싱. 신뢰 컬럼: [3]광고그룹 [4]검색어 [8]클릭수. (비용/전환 컬럼은 배포 후 실데이터로 확정)
  function parseExpKw(tsv) {
    const agg = {};
    tsv.split(/\r?\n/).filter(Boolean).forEach(ln => {
      const c = ln.split('\t'); if (c.length < 9) return;
      const key = c[3] + '|' + c[4];
      const a = (agg[key] ||= { adgroupId: c[3], term: c[4], clk: 0 });
      a.clk += Number(c[8]) || 0;
    });
    return Object.values(agg).sort((a, b) => b.clk - a.clk);
  }
  function renderPlkwOut(out, rows) {
    if (!rows.length) { out.innerHTML = '<div style="color:var(--muted,#888)">검색어 데이터가 없어요.</div>'; return; }
    const trs = rows.slice(0, 100).map((r, i) => `<tr style="border-bottom:1px solid var(--border,#2a2a2a)">
      <td style="padding:6px 8px">${esc(r.term)}</td>
      <td style="padding:6px 8px;text-align:right">${r.clk}</td>
      <td style="padding:6px 8px;text-align:center"><button data-i="${i}" class="nv-exc" style="padding:3px 10px;border-radius:6px;border:1px solid var(--red,#c33);background:transparent;color:var(--red,#c33);cursor:pointer">제외</button></td>
    </tr>`).join('');
    out.innerHTML = `
      <div style="font-size:12px;color:var(--muted,#888);margin-bottom:6px">검색어 ${rows.length}개. 낭비어를 "제외" 누르면 해당 광고그룹에 즉시 제외키워드로 등록됩니다. (비용/전환 컬럼 정렬은 배포 후 실데이터로 고도화)</div>
      <table style="width:100%;border-collapse:collapse;font-size:13px"><thead><tr style="text-align:left;color:var(--muted,#888);border-bottom:1px solid var(--border,#333)">
        <th style="padding:6px 8px">검색어</th><th style="padding:6px 8px;text-align:right">클릭</th><th style="padding:6px 8px;text-align:center">제외</th>
      </tr></thead><tbody>${trs}</tbody></table>`;
    out.querySelectorAll('.nv-exc').forEach(b => b.onclick = async () => {
      const r = rows[+b.dataset.i];
      if (MOCK) { b.textContent = '✓(목)'; b.disabled = true; return; }
      if (!localStorage.getItem('sb_write_token')) { alert('쓰기 인증이 필요합니다. 좌측 "🔒 쓰기 잠김" 해제.'); return; }
      b.textContent = '…'; b.disabled = true;
      try { await api('add_restricted_keyword', { body: { nccAdgroupId: r.adgroupId, keyword: r.term } }); b.textContent = '✓ 제외됨'; b.style.color = 'var(--green,#4a7)'; b.style.borderColor = 'var(--green,#4a7)'; }
      catch (e) { b.textContent = '실패'; b.disabled = false; alert('제외 실패: ' + e.message); }
    });
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
    const ci = { term: idx('검색어'), imp: idx('노출'), clk: idx('클릭'), cost: idx('총비용'), sales: idx('전환매출') };
    if (ci.term < 0 || ci.cost < 0) { out.innerHTML = errBox({ message: '필수 컬럼(검색어/총비용) 매핑 실패' }); return; }
    const agg = {};
    for (let i = hi + 1; i < lines.length; i++) {
      const c = lines[i].split(','); if (c.length < H.length) continue;
      const term = (c[ci.term] || '').trim(); if (!term || term === '-') continue;
      const a = (agg[term] ||= { term, imp: 0, clk: 0, cost: 0, sales: 0 });
      a.imp += Number(c[ci.imp]) || 0; a.clk += Number(c[ci.clk]) || 0; a.cost += Number(c[ci.cost]) || 0; a.sales += Number(c[ci.sales]) || 0;
    }
    const waste = Object.values(agg).filter(x => x.cost >= 1000 && x.sales === 0).sort((a, b) => b.cost - a.cost);
    const totalWasted = waste.reduce((s, x) => s + x.cost, 0);
    const trs = waste.slice(0, 200).map(w => `<tr style="border-bottom:1px solid var(--border,#2a2a2a)">
      <td style="padding:6px 8px">${esc(w.term)}</td><td style="padding:6px 8px;text-align:right">${w.imp}</td>
      <td style="padding:6px 8px;text-align:right">${w.clk}</td><td style="padding:6px 8px;text-align:right">${won(w.cost)}</td>
      <td style="padding:6px 8px;text-align:right">${won(w.sales)}</td></tr>`).join('');
    out.innerHTML = `
      <div style="margin-bottom:8px"><b>낭비 검색어 ${waste.length}개</b> · 소진 비용 합계 <b style="color:var(--red,#c33)">${won(totalWasted)}</b> <span style="color:var(--muted,#888);font-size:12px">(비용 ≥1,000원 & 판매 0)</span></div>
      ${waste.length ? `<button id="nv-copy" style="${btnCss};margin-bottom:8px">📋 검색어 목록 복사 (대시보드에 붙여넣기)</button>` : ''}
      <table style="width:100%;border-collapse:collapse;font-size:13px"><thead><tr style="text-align:left;color:var(--muted,#888);border-bottom:1px solid var(--border,#333)">
        <th style="padding:6px 8px">검색어</th><th style="padding:6px 8px;text-align:right">노출</th><th style="padding:6px 8px;text-align:right">클릭</th><th style="padding:6px 8px;text-align:right">비용</th><th style="padding:6px 8px;text-align:right">판매액</th>
      </tr></thead><tbody>${trs}</tbody></table>`;
    const cp = $('#nv-copy'); if (cp) cp.onclick = () => { navigator.clipboard.writeText(waste.map(w => w.term).join('\n')).then(() => { cp.textContent = '✓ 복사됨'; }); };
  }

  const loading = (m) => `<div style="color:var(--muted,#888);padding:24px;text-align:center">⏳ ${esc(m)}</div>`;
  const errBox = (e) => `<div style="padding:16px;border:1px solid var(--red,#c33);border-radius:8px;color:var(--red,#c33)">에러: ${esc(e.message || e)}<br><span style="color:var(--muted,#888);font-size:12px">프록시 미배포 상태면 ?navermock=1 로 UI 확인 가능</span></div>`;

  // ── 초기화: 토글 배선 ─────────────────────────────────────────
  function init() {
    root = document.getElementById('naver-root');
    if (!root) return;
    const mBtn = document.getElementById('pf-meta'), nBtn = document.getElementById('pf-naver');
    if (nBtn) nBtn.onclick = open;
    if (mBtn) mBtn.onclick = close;
    const navBid = document.getElementById('nav-naver-bid');
    if (navBid) navBid.onclick = () => render();
    // 메타 사이드바 탭 클릭 시 네이버 모드 해제 (네이버 전용 내비는 제외)
    document.querySelectorAll('.nav-item:not(.nv-navitem)').forEach(b => b.addEventListener('click', close));
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  // ── 목데이터 (UI 검증용) ──────────────────────────────────────
  function mockApi(action, p) {
    const D = {
      get_campaigns: [
        { nccCampaignId: 'cmp-s1', name: 'ONS_쇼검_의류', campaignTp: 'SHOPPING' },
        { nccCampaignId: 'cmp-s2', name: 'ONS_쇼검_슈즈', campaignTp: 'SHOPPING' },
        { nccCampaignId: 'cmp-p1', name: 'ONS_파링_브랜드', campaignTp: 'WEB_SITE' },
      ],
      get_adgroups: [
        { nccAdgroupId: 'grp-1', name: '유아레깅스', nccCampaignId: 'cmp-s1' },
        { nccAdgroupId: 'grp-2', name: '원피스_메인', nccCampaignId: 'cmp-s1' },
      ],
      get_ads: [
        { nccAdId: 'nad-1', userLock: false, adAttr: { bidAmt: 660, useGroupBidAmt: false }, referenceData: { productTitle: '오즈키즈 여아 치랭스 레깅스', lowPrice: '16900' } },
        { nccAdId: 'nad-2', userLock: false, adAttr: { bidAmt: 510, useGroupBidAmt: false }, referenceData: { productTitle: '오즈키즈 유아 사계절 레깅스', lowPrice: '13900' } },
        { nccAdId: 'nad-3', userLock: true, adAttr: { bidAmt: 300, useGroupBidAmt: false }, referenceData: { productTitle: '오즈키즈 아기 짜임 레깅스', lowPrice: '11900' } },
      ],
    };
    if (action === 'stats') {
      // 소재별 최근 성과 목데이터 (salesAmt=광고비, convAmt=전환매출). ROAS 밴드 다양화.
      const M = {
        'nad-1': { salesAmt: 100000, convAmt: 680000 }, // 680% → +20%
        'nad-2': { salesAmt: 100000, convAmt: 330000 }, // 330% → 유지
      };
      return Promise.resolve({ data: [M[p && p.id] || { salesAmt: 100000, convAmt: 200000 }] }); // 기본 200% → 하향
    }
    if (action === 'update_ad_bid') return Promise.resolve({ ok: true });
    if (action === 'report_create') return Promise.resolve({ reportJobId: 'mock1', status: 'REGIST' });
    if (action === 'report_status') return Promise.resolve({ status: 'BUILT', downloadUrl: 'https://api.searchad.naver.com/report-download?mock' });
    if (action === 'report_download') return Promise.resolve({ tsv:
      '20260712\t434195\tcmp-a001-01-1\tgrp-a001-01-1\t키즈아쿠아슈즈\t33421\tM\t0\t8\t0\t0\t0\n' +
      '20260712\t434195\tcmp-a001-01-1\tgrp-a001-01-2\t아동레쉬가드\t27758\tP\t2\t4\t0\t0\t0\n' +
      '20260712\t434195\tcmp-a001-01-1\tgrp-a001-01-1\t남아수영복\t33421\tM\t5\t1\t0\t0\t0' });
    if (action === 'report_delete' || action === 'add_restricted_keyword') return Promise.resolve({ ok: true });
    return Promise.resolve(D[action] || []);
  }
})();
