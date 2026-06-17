-- 상품 랜딩 URL 매핑 테이블
-- 이지어드민 상품명(= cafe24 internal_product_name)으로 카페24 랜딩 URL을 조회.
-- 최초 시딩: '카페24 상품명 이지어드민 상품명 매칭.xlsx' (3387행).
-- 신규상품은 광고세팅에서 상품 선택 시 cafe24 API로 자동조회되어 여기에 자동 저장됨(source='cafe24').

create table if not exists public.product_url (
  ez_name     text primary key,           -- 이지어드민 상품명 (입력/매칭 키) = cafe24 internal_product_name
  pcode       text,                        -- 카페24 상품코드 (P0000...) = inventory.rep_code
  product_no  integer,                     -- 카페24 내부 상품번호 (URL 생성용)
  cafe24_name text,                         -- 카페24 표시 상품명
  url         text,                         -- 랜딩 URL (https://ozkiz.com/product/detail.html?product_no=N)
  source      text default 'excel',         -- 'excel'(최초 시딩) | 'cafe24'(자동 추가)
  updated_at  timestamptz default now()
);

create index if not exists product_url_pcode_idx on public.product_url (pcode);

-- anon 키로 읽기/쓰기 (재고·전략·SERA 테이블과 동일 정책)
alter table public.product_url enable row level security;
drop policy if exists "product_url_all" on public.product_url;
create policy "product_url_all" on public.product_url
  for all using (true) with check (true);
