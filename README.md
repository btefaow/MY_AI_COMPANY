# 🏢 나만의 AI 회사 (My AI Company)

> 📦 저장소: https://github.com/btefaow/MY_AI_COMPANY

**LM Studio 로컬 LLM** 위에서 돌아가는 **자율 멀티 에이전트 회사** VS Code 확장입니다.
파트장(CEO)이 팀을 지휘하고, 회사 목표를 계층적으로 관리하며, 코드를 만들고 검증하는 일을 **스스로 반복**합니다. 빌드 과정이 없어 `F5` 한 번으로 바로 실행됩니다.

> 클라우드 API 없이 **내 PC의 로컬 모델만으로** 동작하므로 토큰 비용 걱정 없이 무제한으로 돌릴 수 있습니다.

---

## ✨ 핵심 기능

| 기능 | 설명 |
|------|------|
| 🔄 **자율 루프** | 확장이 켜지면 파트장이 자동 브리핑 → 한 세션에서 여러 라운드로 목표를 평가·개선 → 설정한 간격마다 다음 세션 자동 재시작 |
| 👔 **위임(delegate)** | 파트장이 `<delegate>` 태그로 팀원에게 작업 분배. 태그 없이 말로만 지시해도 **자동으로 위임 태그로 변환**(로컬 LLM 형식 미준수 대비) |
| 🎯 **목표 계층 관리** | 연간→월간→주간→일간을 **부모-자식 + 가중치**로 연결. 상위 진행률은 하위의 **가중 합으로 자동 집계(롤업)**, 기간 경과 대비 **페이스 경보** |
| 🗳️ **의사결정 결재함** | 파트장이 `<ask_user>`로 물으면 팀이 **자동 투표** → 사용자가 대시보드에서 투표 결과를 참고해 **승인/보류** |
| ✅ **코드 검증 루프** | 생성된 `.py`/`.js`를 실제 실행 → 오류 시 개발자 에이전트가 **자동 수정**(최대 3회) |
| 🧠 **영구 기억(Brain)** | 모든 대화·결정·목표를 파일로 저장. VS Code를 꺼도 맥락 유지 |
| 📊 **대시보드** | 에이전트 현황, 오늘의 활동(요약), 최근 생성 파일, 결재함을 한눈에 |

---

## 🤖 에이전트 구성

| 에이전트 | 역할 |
|----------|------|
| 🏢 **파트장** (ceo) | 회사 방향 결정, 팀 조율, 작업 위임, 의사결정 요청 |
| 🎯 **목표관리자** (goal_manager) | 목표를 연→월→주→일 계층으로 분해(Planner)하고 가중 진행률을 집계(Aggregator) |
| 💻 **개발자** (developer) | 코드 작성, 버그 수정, 생성 코드 검증·수정 |
| ▶️ **YouTube** (youtube) | 채널 전략, 콘텐츠 기획, 트렌드 분석 |
| 📋 **비서** (secretary) | 일정·문서 정리, 보고서 작성 |
| 📈 **비즈니스** (business) | 수익화 전략, 시장 분석, 비즈니스 모델 |
| 🇸🇦 **사우디 국담** (saudi) | 사우디아라비아 시장 개척·수출 전략 |
| 🇪🇬 **이집트 국담** (egypt) | 이집트 시장 개척·수출 전략 |

> 에이전트는 [`agents.js`](agents.js)에서 정의합니다. 항목을 추가/수정하면 UI와 동작에 자동 반영됩니다.

---

## 📁 프로젝트 구조

```
My_AI_Company/
├── extension.js          ← VS Code 확장 본체 (사이드바 UI, 자율 루프, 대시보드)
├── agents.js             ← 에이전트 정의 (이름·역할·시스템 프롬프트)
├── brain.js              ← 영구 기억·목표·결정 파일 I/O + 가중 롤업 로직
├── cycle.js              ← 터미널/스케줄러용 독립 실행 스크립트 (확장 없이 동작)
├── package.json          ← 확장 명세
├── schedule_setup.ps1    ← Windows 작업 스케줄러 등록 (정기 자동 실행)
├── .vscode/launch.json   ← F5 디버그 실행 설정
│
├── my-ai-brain/          ← 영구 기억 폴더 (자동 생성)
│   ├── company/
│   │   ├── identity.md       회사 정체성 (이름·미션·말투) — 사용자 편집
│   │   ├── goals.md          비전·정성 목표 — 사용자 편집
│   │   ├── goals.json        계층 추적 목표 (자동 관리)
│   │   └── settings.json     자율 세션 간격 등 설정
│   ├── agents/<id>/memory.md  에이전트별 학습 기억 (자동 누적)
│   ├── conversations/<날짜>.md 일별 대화 로그 (자동)
│   └── decisions/<id>.json     의사결정 결재 항목 (자동)
│
└── workspace/            ← 에이전트가 만든 산출물·리포트 (자동 생성)
    └── reports/
```

---

## 🚀 시작하기

### 준비물
1. **VS Code**
2. **Node.js** (빌드는 없지만 실행에 필요)
3. **LM Studio** — 로컬 LLM 서버

### 1단계 — LM Studio 서버 켜기
1. LM Studio 실행 후 모델을 하나 **메모리에 로드** (예: Qwen, Gemma, Llama 등)
2. **Developer / Local Server** 탭에서 **Start Server** 클릭
3. `http://localhost:1234` 에서 "Running" 확인

> 모델 ID는 자동 감지합니다(`/v1/models`). 여러 모델이 로드돼 있어도 첫 채팅 모델을 자동 선택합니다.

### 2단계 — 확장 실행
1. VS Code로 이 폴더를 엽니다
2. **F5** 를 누르면 확장이 적용된 새 VS Code 창이 열립니다
3. 왼쪽 액티비티 바의 🤖 아이콘 클릭 → 채팅 패널이 열립니다
4. 확장이 켜지면 **파트장이 자동으로 브리핑을 시작**하고 자율 루프가 돌아갑니다

### 3단계 — 회사 설정 (선택)
- `my-ai-brain/company/identity.md` — 회사 이름·미션 편집
- `my-ai-brain/company/goals.md` — 비전·목표 작성 → 목표관리자가 이를 계층으로 분해

---

## 🖥️ 사이드바 사용법

| 버튼 | 기능 |
|------|------|
| 📊 대시보드 | 에이전트 현황·활동·결재함·생성 파일 |
| 🎯 목표 | 계층 목표 트리(가중치·롤업·페이스) |
| 🧠 뇌 폴더 | identity.md 열기 |
| ⏸ 자율정지 / ▶ 자율시작 | 자율 루프 토글 |
| ⏱️ 자율 세션 간격 | 슬라이더로 1~180분 조정(기본 10분) + 다음 세션 카운트다운 |

탭을 바꾸면 특정 에이전트와 1:1 대화도 가능합니다(파트장 탭은 자율 위임, 나머지는 직접 응답).

---

## 🎯 목표 관리 (계층 + 가중치)

목표는 **연간 → 월간 → 주간 → 일간**으로 유기적으로 연결됩니다.

```
[연간/lag] 중동 6개국 파트너십 12건            46%
  ├─ [월간/lag] UAE 리드 발굴 (⚖60%)          60%
  │    ├─ [주간/lead] 콜드콜 50건 (⚖50%)       80%
  │    └─ [주간/lead] 미팅 10건 (⚖50%)         40%
  └─ [월간/lag] 계약 체결 (⚖40%)               25%
```

- **가중 롤업**: 상위 진행률 = Σ(자식 진행률 × 가중치). 자식이 바뀌면 자동 재계산
- **lead / lag**: 주간·일간 = 통제 가능한 행동(lead), 월간·연간 = 결과 지표(lag)
- **페이스 경보**: 진행률 vs 기간 경과율 비교 → ⏫앞섬 / ✅정상 / ⚠️지연
- **선택적 KR**: 측정 지표(목표값·현재값)를 붙이면 대시보드에 표시·집계

설계 원칙은 **가중 분해 / 측정 가능(KR) / lead-lag 구분 / 캐치볼(상향 피드백)** 개념을 따릅니다.

---

## 🏷️ 에이전트 액션 태그

파트장·에이전트는 응답 텍스트 안에 태그를 써서 시스템을 조작합니다.

**작업 위임 / 의사결정**
```
<delegate agent="developer" task="..."/>
<ask_user question="..." options="A,B,C" priority="high" recommended="A"/>
```

**목표 관리** (파트장 / 목표관리자)
```
<add_goal level="monthly" title="..." parent="부모ID" weight="0.4" type="lag"/>
<update_goal id="목표ID" weight="0.5" parent="부모ID"/>
<set_progress id="목표ID" progress="60" note="근거"/>
<delete_goal id="목표ID"/>
<goal_status state="done|continue" reason="..."/>
```

**파일·명령 실행** (개발자 등)
```
<create_file path="상대경로">내용</create_file>
<edit_file path="..."><search>찾을것</search><replace>바꿀것</replace></edit_file>
<run_command>명령어</run_command>
<read_file path="..."/>   <list_files path="..."/>
```

---

## ⏰ 터미널 / 스케줄러 실행 (확장 없이)

VS Code를 켜지 않고 [`cycle.js`](cycle.js)로 직접 돌릴 수 있습니다.

```bash
node cycle.js                  # 1회 실행
node cycle.js --rounds 3       # 한 세션에서 3라운드
node cycle.js --loop           # 10분마다 자동 반복 (기본)
node cycle.js --loop 60        # 60분마다 반복
node cycle.js --debate         # 에이전트 간 토론 모드
```

**Windows 작업 스케줄러 등록** (정기 자동 실행):
```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
.\schedule_setup.ps1
```

---

## ⚙️ 주요 설정값

| 항목 | 위치 | 기본값 |
|------|------|--------|
| LM Studio 주소 | `extension.js` `LM_STUDIO_URL` | `http://localhost:1234/v1/chat/completions` |
| 자율 세션 간격 | 사이드바 슬라이더 / `settings.json` | 10분 |
| 세션당 최대 라운드 | `extension.js` `MAX_ROUNDS` | 5 |
| 코드 자동 수정 횟수 | `extension.js` `MAX_FIX_ATTEMPTS` | 3 |

---

## 🔧 동작 흐름 요약

```
[F5 실행]
   │
   ▼
파트장 자동 브리핑 ── 목표·결정·이전 기록을 읽고 평가
   │
   ├─ <delegate> ──▶ 팀원 실행 (파일 생성/분석) ──▶ 코드면 검증·자동수정
   ├─ <ask_user> ──▶ 팀 자동 투표 ──▶ 결재함 (사용자 승인/보류)
   ├─ <set_progress>/<add_goal> ──▶ 목표 계층·진행률 갱신 (자동 롤업)
   └─ <goal_status> ──▶ 세션 계속 / 완료 판단
   │
   ▼
세션 종료 ──▶ 설정 간격 카운트다운 ──▶ 다음 세션 자동 재시작
```

---

## 📝 기술 메모

- **빌드 없음**: 순수 JavaScript + VS Code API. 트랜스파일/번들 단계 없이 바로 실행
- **로컬 전용**: 외부 API 키 불필요. LM Studio OpenAI 호환 엔드포인트만 사용
- **자가 복구**: 로컬 LLM이 태그 형식을 못 지키면 산문 지시를 위임 태그로 자동 변환
- **결정적 목표 집계**: 가중 롤업·페이스는 읽을 때마다 계산되어 항상 일관됨
