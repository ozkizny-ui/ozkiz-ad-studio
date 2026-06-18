-- ────────────────────────────────────────────────────────────────
-- budget_rule_logs 컬럼 추가 마이그레이션
-- 기존 컬럼(id, rule_id, rule_label, ad_name, old_budget, new_budget, success)·데이터는 건드리지 않음.
-- ADD COLUMN IF NOT EXISTS 만 사용 → 재실행해도 안전(멱등).
-- 실행: Supabase 대시보드 → SQL Editor 에 붙여넣고 Run.
-- ────────────────────────────────────────────────────────────────

-- ── 적용 시점 메타 ──────────────────────────────────────────────
ALTER TABLE public.budget_rule_logs
  ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now();

ALTER TABLE public.budget_rule_logs
  ADD COLUMN IF NOT EXISTS adset_id text;

ALTER TABLE public.budget_rule_logs
  ADD COLUMN IF NOT EXISTS adset_name text;

-- ── 규칙 발동 당시 스냅샷 ───────────────────────────────────────
ALTER TABLE public.budget_rule_logs
  ADD COLUMN IF NOT EXISTS spend_at_trigger numeric;

ALTER TABLE public.budget_rule_logs
  ADD COLUMN IF NOT EXISTS value_at_trigger numeric;

ALTER TABLE public.budget_rule_logs
  ADD COLUMN IF NOT EXISTS roas_at_trigger numeric;

-- ── 발동 시점 판정 ──────────────────────────────────────────────
ALTER TABLE public.budget_rule_logs
  ADD COLUMN IF NOT EXISTS verdict text;

ALTER TABLE public.budget_rule_logs
  ADD COLUMN IF NOT EXISTS verdict_reason text;

-- ── 사후(事後) 판정용 — 지금은 비워둠 ──────────────────────────
ALTER TABLE public.budget_rule_logs
  ADD COLUMN IF NOT EXISTS roas_after numeric;

ALTER TABLE public.budget_rule_logs
  ADD COLUMN IF NOT EXISTS verdict_post text;

ALTER TABLE public.budget_rule_logs
  ADD COLUMN IF NOT EXISTS verified_at timestamptz;
