# 📱 iPhone Daily Briefing

Anthropic Claude API + 웹 검색으로 매일 아침 아이폰 뉴스를 자동 수집·분류하는 브리핑 앱.

---

## 빠른 시작 (Vite 기준)

```bash
npm create vite@latest iphone-briefing -- --template react
cd iphone-briefing
npm install
```

`src/App.jsx`를 `iphone-daily-briefing-v2.jsx` 내용으로 교체 후:

```bash
# .env 파일 생성 (절대 커밋 금지)
echo "VITE_ANTHROPIC_API_KEY=sk-ant-..." > .env

npm run dev
```

---

## GitHub Pages 배포

### 1. API 키 보안 (중요)

```
# .gitignore에 반드시 추가
.env
.env.local
.env.production
```

> **경고**: GitHub Pages는 정적 사이트이므로 API 키가 번들에 포함되면 노출됩니다.  
> 개인 레포 + 팀 내부용으로만 사용하거나, Vercel/Cloudflare Worker 백엔드 프록시를 권장합니다.

### 2. 두 가지 배포 방식

#### A. 개인 사용 (빌드 타임 키 주입)
```bash
# GitHub Actions Secret에 VITE_ANTHROPIC_API_KEY 등록
# .github/workflows/deploy.yml

name: Deploy
on:
  push:
    branches: [main]
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20' }
      - run: npm ci && npm run build
        env:
          VITE_ANTHROPIC_API_KEY: ${{ secrets.VITE_ANTHROPIC_API_KEY }}
      - uses: peaceiris/actions-gh-pages@v4
        with:
          github_token: ${{ secrets.GITHUB_TOKEN }}
          publish_dir: ./dist
```

#### B. 런타임 키 입력 (키 미포함 배포)
`.env` 없이 배포 → 앱 첫 실행 시 API 키 입력 모달 표시 → localStorage 저장.

---

## 환경변수

| 변수명 | 설명 | 예시 |
|--------|------|------|
| `VITE_ANTHROPIC_API_KEY` | Anthropic API 키 | `sk-ant-api03-...` |

CRA(Create React App) 사용 시: `REACT_APP_ANTHROPIC_API_KEY`

---

## API 요구사항

| 항목 | 내용 |
|------|------|
| 모델 | claude-sonnet-4-20250514 |
| 기능 | Web Search (`web_search_20250305`) — Anthropic API 별도 활성화 필요 |
| 과금 | 1회 실행 기준 약 2,000~4,000 input tokens + 검색 비용 |

---

## 주요 기능

- **SSE 스트리밍** — 뉴스 카드를 1건씩 실시간 표시 (대기 시간 체감 80% 감소)
- **실제 진행상태 표시** — API 이벤트 기반 (웹 검색 중 / 브리핑 작성 중)
- **당일 캐시** — 같은 날 재접속 시 즉시 표시, API 미호출
- **4단계 중요도** — BREAKING / HIGH / MID / LOW
- **Progressive 렌더링** — 전체 응답 완료 전에도 완성된 항목부터 표시

---

## 파일 구조

```
iphone-briefing/
├── src/
│   └── App.jsx          ← iphone-daily-briefing-v2.jsx 내용
├── .env                 ← API 키 (gitignore)
├── .env.example         ← 키 없는 템플릿 (커밋 가능)
├── .gitignore
└── vite.config.js
```
