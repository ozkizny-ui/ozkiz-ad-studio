-- 007: 쇼핑검색 검색어 보고서(수동 CSV 업로드) 영속화 (2026-07-29)
-- 네이버 키워드 뷰의 '광고 실측 노출' 근거 — 검색어별 실제 노출/클릭/비용/전환매출 (그룹 단위).
-- 업로드 = 전체 교체(replace, /api/sb 게이트웨이 · 쓰기 인증 필요), 읽기 = 게이트웨이 read.
-- updated_at = 마지막 업로드 시각 표시용.

create table if not exists public.nv_search_terms (
  id bigint generated always as identity primary key,
  term text not null,
  campaign text default '',
  adgroup text default '',
  imp integer default 0,
  clk integer default 0,
  cost numeric default 0,
  conv_value numeric default 0,
  updated_at timestamptz default now()
);

create index if not exists nv_search_terms_term_idx on public.nv_search_terms (term);

-- RLS 켜고 정책 없음 = anon 차단, service_role(게이트웨이) 전용 (nv_ 테이블 공통 패턴)
alter table public.nv_search_terms enable row level security;
