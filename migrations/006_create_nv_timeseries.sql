-- 006: 네이버 검색광고 시계열 수집(nv_stat_snapshots) + 알림 로그(nv_alert_log)
-- Phase 1(수집·영속 + 알림): /api/naver-collect 크론이 6시간마다 적재. 읽기전용 수집 — 네이버에 쓰기 없음(돈 안 나감).
--   intraday : 오늘 누적 지표(캠페인별 예산 급증 감지용). 매 실행 적재.
--   daily    : 전일 완결 지표 + 직접구매 전환(ROAS 프로파일=Phase 2·3 토대). 하루 1회(03시 KST 슬롯) 적재.
-- 격리: 신규 nv_ 접두사로 논리 격리. (당초 계획의 별도 naver 스키마는 PostgREST exposed-schemas 수동설정이
--       필요해 무인 크론의 실패 지점이 되므로 회피 — public+prefix로 동일한 격리 효과.)
-- 접근: service_role(크론·게이트웨이)만. anon 차단 위해 RLS enable + 정책 없음(service_role은 RLS 우회).
--       프론트 읽기는 후속 단계에서 /api/sb 게이트웨이(service_role) 경유로 노출.

create table if not exists public.nv_stat_snapshots (
  id           bigint generated always as identity primary key,
  kind         text not null,                 -- 'intraday' | 'daily'
  captured_at  timestamptz not null default now(),
  stat_dt      date not null,                 -- 집계 대상일(KST)
  level        text not null default 'ad',    -- 'ad'(쇼핑 소재). 추후 'keyword'(파워링크) 확장 여지
  campaign_id  text,
  adgroup_id   text,
  entity_id    text not null,                 -- nccAdId
  imp          bigint  default 0,
  clk          bigint  default 0,
  cost         numeric default 0,             -- /stats salesAmt = 광고비
  avg_rnk      numeric,                       -- 평균 노출순위
  conv_cnt     integer default 0,             -- 직접구매 전환수 (daily만; 구매완료·직접)
  conv_val     numeric default 0              -- 직접구매 전환매출액 (daily만)
);
create index if not exists nv_snap_lookup_idx on public.nv_stat_snapshots (kind, stat_dt, campaign_id);
create index if not exists nv_snap_entity_idx on public.nv_stat_snapshots (entity_id, captured_at desc);

create table if not exists public.nv_alert_log (
  id          bigint generated always as identity primary key,
  created_at  timestamptz not null default now(),
  kind        text not null,                  -- 'budget_spike' | 'landing_error'
  ref         text,                           -- 캠페인 id 또는 랜딩 url (24h 중복 알림 방지 키)
  detail      jsonb,
  notified    boolean default false           -- 구글챗 발송 성공 여부
);
create index if not exists nv_alert_ref_idx on public.nv_alert_log (kind, ref, created_at desc);

alter table public.nv_stat_snapshots enable row level security;
alter table public.nv_alert_log      enable row level security;
-- 정책 없음(의도적): anon/authenticated 전면 차단. service_role만 접근(RLS 우회).
