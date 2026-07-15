-- 005_rls_lock_data_tables
-- 보안 마이그레이션 5단계: RLS 잠금.
--
-- 목적: 공개된 anon 키(index.html, GitHub, seed_product_url.py에 노출)로 Supabase REST에
--       직접 접근하는 "옆문"을 닫는다. 잠그면 anon 롤은 정책이 없어 전면 거부되고,
--       게이트웨이(/api/sb)가 쓰는 service_role은 BYPASSRLS라 그대로 동작한다.
--       → 이후 앱은 게이트웨이+쓰기인증(4단계)이 유일 경로가 된다.
--
-- ⚠️ 실행 전 반드시 확인 (프리플라이트):
--   1) 라이브 ad-studio가 READ_VIA_GATEWAY=true, WRITE_VIA_GATEWAY=true 로 배포돼 있음
--      (index.html:498, 500 — 현재 true). anon 직접 경로가 활성 상태면 잠그는 순간 화면이 깨진다.
--   2) 라이브 dashboard도 게이트웨이 경유 읽기(NW_VIA_GATEWAY=true)로 배포돼 있음.
--   3) /api/sb 게이트웨이가 SUPABASE_SERVICE_ROLE_KEY 사용(= RLS 우회) — 확인됨.
--
-- ⚠️ 롤백 주의: RLS를 켜면 "플래그를 false로 내려 anon 직접으로 롤백"하는 안전망이 죽는다.
--   RLS 이후의 롤백은 아래 [ROLLBACK] 섹션대로 DISABLE ROW LEVEL SECURITY 로만 가능하다.
--
-- ────────────────────────────────────────────────────────────────────────
-- [PHASE A] 지금 잠가도 안전 — 프론트/대시보드가 100% 게이트웨이 경유, auto-adjust 무관
-- ────────────────────────────────────────────────────────────────────────
-- 검증 근거(index.html): 읽기 sbGet(게이트웨이), 쓰기 sbReplace/sbUpsert(게이트웨이).
--   inventory       : sbGet 1165 / sbReplace 1311
--   strategy        : sbGet 1184 / sbReplace 1318
--   sera            : sbGet 1192 / sbReplace 1328
--   product_url     : sbGet 1215 / sbUpsert 4072
--   creative_status : sbGet 1236 / sbUpsert 1253
-- anon 직접 접근 경로 없음.

alter table public.inventory       enable row level security;
alter table public.strategy        enable row level security;
alter table public.sera            enable row level security;
alter table public.product_url     enable row level security;
alter table public.creative_status enable row level security;

-- ⚠️ 2026-07-14 실행 결과: inventory·strategy는 즉시 차단됐으나 sera·product_url·
--    creative_status는 여전히 anon 읽기 통과. 원인 = 생성 시 만든 허용 정책(002/003):
--      create policy "sera_all"        on sera        for all using(true) with check(true);
--      create policy "product_url_all" on product_url for all using(true) with check(true);
--    (creative_status도 동일 계열 추정). RLS는 켜져 있어도 이 permissive 정책이 통과시킴.
--    → 아래에서 5개 테이블의 모든 정책을 제거해야 실제로 잠긴다.
--    service_role(게이트웨이)은 BYPASSRLS라 정책 유무와 무관하게 정상 동작.

do $$
declare r record;
begin
  for r in
    select policyname, tablename from pg_policies
     where schemaname = 'public'
       and tablename in ('inventory','strategy','sera','product_url','creative_status')
  loop
    execute format('drop policy if exists %I on public.%I', r.policyname, r.tablename);
  end loop;
end $$;

-- 정책 제거 후 = anon/authenticated 전면 거부, service_role만 통과(BYPASSRLS).

-- ────────────────────────────────────────────────────────────────────────
-- [PHASE B] 잠글 수 있으나 실행 전 2가지 확인 필요 (돈/자동화 인접) — 기본 주석처리
-- ────────────────────────────────────────────────────────────────────────
-- 현재 프론트 코드상 이들도 게이트웨이 경유다:
--   budget_rule_logs  : sbGet 807·2445 (읽기), sbUpsert 2584 (쓰기)
--   budget_rule_edits : sbUpsert 2593 (쓰기)
--   budget_rules      : 프론트 미사용(주석 679·2148, 빈 테이블)
-- 다만 옛 메모리 노트에 "budget_rules·budget_rule_logs RLS 잠금 금지"가 있어 충돌한다.
-- 잠그기 전 반드시 확인:
--   (a) proxy auto-adjust.js 가 budget_rule_logs / budget_rules 를 service_role로 접근하는가?
--       (anon으로 접근하면 잠그는 순간 자동 예산조정 로깅이 깨진다 = 돈 시스템 영향)
--   (b) budget_rule_logs 읽기가 정말 게이트웨이 경유인지 라이브에서 재확인(5-bis 여부).
-- 위 (a)(b) 확인 후 아래 주석 해제:
--
-- alter table public.budget_rule_logs  enable row level security;
-- alter table public.budget_rule_edits enable row level security;
-- alter table public.budget_rules      enable row level security;

-- ────────────────────────────────────────────────────────────────────────
-- [PHASE C] 코드 수정이 선행돼야 함 — 지금 잠그면 즉시 깨짐
-- ────────────────────────────────────────────────────────────────────────
-- app_settings 는 아직 anon 직접이다:
--   sbSettingGet (index.html:631), sbSettingSet (index.html:636)  ← sbHeaders 직접 사용
-- 먼저 이 두 함수를 /api/sb 게이트웨이로 이설(op=read/upsert)한 뒤에 잠글 것.
--
-- alter table public.app_settings enable row level security;

-- ────────────────────────────────────────────────────────────────────────
-- [검증] 적용 후 실행 — rowsecurity=true 확인
-- ────────────────────────────────────────────────────────────────────────
-- select tablename, rowsecurity
--   from pg_tables
--  where schemaname = 'public'
--    and tablename in ('inventory','strategy','sera','product_url','creative_status')
--  order by tablename;
--
-- 추가 검증(앱 밖에서):
--   · anon 키로 GET /rest/v1/inventory  → 이제 200 이어도 빈 배열([]) 반환해야 정상(=차단됨)
--   · ad-studio 화면 로드 → 재고/전략/소재상태 정상 표시(게이트웨이 읽기)
--   · 소재상태 토글 저장(쓰기인증 필요) → 정상(게이트웨이 쓰기)

-- ────────────────────────────────────────────────────────────────────────
-- [ROLLBACK] 문제 발생 시 (플래그 롤백은 RLS 이후 무효 — 이 방법만 유효)
-- ────────────────────────────────────────────────────────────────────────
-- alter table public.inventory       disable row level security;
-- alter table public.strategy        disable row level security;
-- alter table public.sera            disable row level security;
-- alter table public.product_url     disable row level security;
-- alter table public.creative_status disable row level security;
