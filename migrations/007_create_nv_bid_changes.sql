-- 007: 네이버 입찰가 변경 이력 (쇼핑검색 소재 / 파워링크 키워드)
-- 대시보드에서 입찰가 반영 시 "언제·무엇을·얼마→얼마" 기록 → 각 탭 하단에 최근 이력 표시.
-- 접근: service_role만(크론·게이트웨이). anon 차단 위해 RLS enable + 정책 없음(service_role은 RLS 우회).
-- 기록/조회는 /api/naver 의 log_bid_change(쓰기·게이트) / get_bid_changes(읽기) 경유.

create table if not exists public.nv_bid_changes (
  id          bigint generated always as identity primary key,
  changed_at  timestamptz not null default now(),
  channel     text not null,        -- 'shopping'(쇼핑 소재) | 'powerlink'(파워링크 키워드)
  entity_id   text not null,        -- nccAdId | nccKeywordId
  name        text,                 -- 상품명 | 키워드
  old_bid     integer,
  new_bid     integer
);
create index if not exists nv_bidchg_idx on public.nv_bid_changes (channel, changed_at desc);

alter table public.nv_bid_changes enable row level security;
-- 정책 없음(의도적): anon/authenticated 전면 차단. service_role만 접근.
