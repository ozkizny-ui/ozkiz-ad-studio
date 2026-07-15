# ozkiz-ad-studio — 작업 가이드

이 파일은 매 세션 자동 로드된다. **작업 유형에 따라 아래 워크플로우/플러그인을 자동 적용할 것.**

## 이 저장소 개요
- 프론트: 단일 `index.html`(대용량 SPA) → GitHub Pages(`ozkizny-ui/ozkiz-ad-studio`)로 배포.
- API: 별도 레포 `ozkiz-proxy`(Vercel, `ozkiz-proxy.vercel.app/api/*`). 이 레포에는 서버 코드 없음.
- 데이터: Supabase `bauc`(baucagnqmtmaqlybjyzc). 프론트는 `/api/sb` 게이트웨이(service_role) 경유.
- 자매 앱: 마케팅 대시보드(별도 레포/별도 Supabase). 자세한 맥락은 사용자 메모리(`MEMORY.md`) 참조.

## 작업 유형별 라우팅 — "알맞은 작업에 알맞은 플러그인"

| 작업 유형 | 자동 적용 | 방법 |
|---|---|---|
| **예산 규칙 / 돈·광고 집행 로직** | 기획먼저 → 테스트 → 보안 → **시뮬 보고·확인·배포** | Superpowers(계획/TDD) + `/security-review`. 수치를 받았어도 최종 확인 없이 배포 금지 |
| **API·Supabase·인증·키·RLS 변경** | 보안 리뷰 필수 | `/security-review`. 노출 키·무인증 엔드포인트·RLS 정책 확인 |
| **커밋 전(비트리비얼 변경)** | 코드 리뷰 | `/code-review` (정리 위주면 `/simplify`) |
| **UI·대시보드·차트** | 디자인 가이드 | 프론트 디자인 플러그인 + `/dataviz`·`artifact-design`. 기존 스타일·시간축 규칙 준수 |
| **큰 기능(탭 통째·마이그레이션·두 앱 미러링)** | 역할 분업/병렬 | Stack 또는 서브에이전트(`Agent`)/`Workflow`로 분해 |
| **브라우저에서 확인 가능한 변경** | 실제 동작 검증 | `/verify` 또는 프리뷰로 확인 후 증거 제시 (수동 확인 요청 금지) |
| **모든 작업** | 결정·제약 축적 | 새 결정/제약/함정은 메모리에 저장(Claude mem) |

## 프로젝트 불변 규칙 (위반 금지)
- **예산 규칙 배포**: 시뮬레이션 결과 보고 → 사용자 확인 → 배포. (수치 명시받아도 최종 확인 생략 금지)
- **`ozkiz-proxy`의 `auto-adjust.js` 변경 금지.**
- **RLS**: 데이터 5테이블(inventory·strategy·sera·product_url·creative_status)은 잠금 완료(`migrations/005`). `budget_rules`·`budget_rule_logs`·`app_settings`는 선행 확인 전 잠그지 말 것(각각 auto-adjust 경로·anon 직접 경로 확인 필요).
- **막대그래프 시간축**: 과거=왼쪽/최근=오른쪽, 매출=왼쪽/광고비=오른쪽.
- **두 앱은 별도 Supabase 프로젝트**. 대시보드가 자기 프로젝트를 교차 호출하지 않도록 주의.
- 커밋은 사용자가 요청할 때만. 커밋 메시지는 한글 conventional(`feat:`/`fix:`/`chore:`) 스타일.

## 보안 백로그 (진행중)
- `/api/claude` 무인증 → 토큰 소진 취약(HIGH). proxy에서 인증 추가 필요.
- 무인증 read 엔드포인트(`/api/meta?action=get_*`, `/api/cafe24`) 노출.
- RLS Phase B(budget_*)·Phase C(app_settings)·6단계(anon 키 교체) 남음. 상세: 사용자 메모리 `ozkiz-supabase-security-migration`.
