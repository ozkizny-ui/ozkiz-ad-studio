-- 004_inventory_add_cost
-- 재고 테이블에 원가(cost) 컬럼 추가.
-- 재고자산(가용재고 × 원가) 계산용 — 이지어드민 업로드 시 원가 컬럼을 함께 저장한다.
-- 기존 행에는 0으로 채워지며, 다음 재고 업로드부터 실제 원가가 반영된다.

alter table public.inventory
  add column if not exists cost numeric default 0;
