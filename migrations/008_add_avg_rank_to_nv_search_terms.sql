-- 008: 검색어 보고서의 평균노출순위 저장 (2026-07-29)
-- 키워드 뷰 '광고 랭킹' — CSV에 평균노출순위 컬럼이 있으면 (검색어, 광고그룹)별 노출가중 평균으로 저장.
alter table public.nv_search_terms add column if not exists avg_rank numeric;
