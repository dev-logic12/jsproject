import { useState, useEffect } from "react";

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const MODEL = "claude-sonnet-4-20250514";
const MAX_TOKENS = 3000;

// Claude.ai 아티팩트(프록시 환경)에서는 API 키 불필요
// GitHub 배포 시 env 또는 localStorage에서 읽음
function getApiKey() {
  // Vite env
  try { if (window.__VITE_API_KEY__) return window.__VITE_API_KEY__; } catch {}
  // localStorage (sandbox에서 실패해도 OK)
  try { return localStorage.getItem("anthropic_api_key") || ""; } catch {}
  return "";
}

// localStorage 안전 래퍼 (sandbox 차단 대비)
const safeStorage = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
};

function getCached() {
  try {
    const c = JSON.parse(safeStorage.get("iphone_briefing_v3") || "null");
    if (c?.date === new Date().toDateString() && c?.data) return c.data;
  } catch {}
  return null;
}
function setCache(data) {
  safeStorage.set("iphone_briefing_v3", JSON.stringify({
    date: new Date().toDateString(), data,
  }));
}

// ─── CONSTANTS ────────────────────────────────────────────────────────────────
const PC = {
  BREAKING: { label: "🔴 BREAKING", color: "#FF3B30", bg: "rgba(255,59,48,0.10)", border: "rgba(255,59,48,0.35)" },
  HIGH:     { label: "🟠 HIGH",     color: "#FF9500", bg: "rgba(255,149,0,0.10)", border: "rgba(255,149,0,0.35)" },
  MID:      { label: "🟡 MID",      color: "#FFCC00", bg: "rgba(255,204,0,0.10)", border: "rgba(255,204,0,0.35)" },
  LOW:      { label: "🟢 LOW",      color: "#34C759", bg: "rgba(52,199,89,0.10)", border: "rgba(52,199,89,0.35)" },
};

const SYSTEM_PROMPT = `당신은 애플/아이폰 전담 홍보팀 수석 에디터입니다.
오늘 날짜 기준 최근 7일간의 아이폰 관련 주요 뉴스를 수집하여 아침 브리핑 리포트를 작성하세요.

반드시 순수 JSON만 출력하세요. 마크다운 코드블록 없이 JSON만.

{
  "summary": "홍보팀 시각의 오늘 아이폰 이슈 한줄 총평 (50자 이내)",
  "news": [
    {
      "priority": "BREAKING|HIGH|MID|LOW",
      "category": "신제품|소프트웨어|규제/법률|경쟁사|공급망|시장/판매|보안|기타",
      "headline": "기사 제목 한국어 (40자 이내)",
      "summary": "2문장 요약. 홍보팀 관점 브랜드 영향도 포함.",
      "impact": "긍정|부정|중립",
      "source": "출처 언론사",
      "region": "국내|해외|글로벌",
      "url": "실제 기사 URL",
      "date": "YYYY-MM-DD"
    }
  ]
}

priority 기준:
- BREAKING: 애플 공식 발표·긴급 보안패치·대형 소송 결과
- HIGH: 주요 언론 다수 보도·시장/주가 영향·경쟁사 공격
- MID: 업계 동향·루머/유출·중간 이슈
- LOW: 소규모 트렌드·앱 업데이트·일반 리뷰

8~12개 항목, 국내외 균형 수집.`;

// ─── STREAMING ────────────────────────────────────────────────────────────────
function parsePartialNews(text) {
  const sumMatch = text.match(/"summary"\s*:\s*"([^"]*)"/);
  const summary = sumMatch ? sumMatch[1] : null;

  const arrMatch = text.match(/"news"\s*:\s*\[/);
  if (!arrMatch) return { summary, items: [] };

  const arrStart = text.indexOf("[", arrMatch.index);
  const arrText = text.slice(arrStart + 1);
  const items = [];
  let depth = 0, start = -1;

  for (let i = 0; i < arrText.length; i++) {
    if (arrText[i] === "{") { if (depth === 0) start = i; depth++; }
    else if (arrText[i] === "}") {
      depth--;
      if (depth === 0 && start >= 0) {
        try { items.push(JSON.parse(arrText.slice(start, i + 1))); } catch {}
        start = -1;
      }
    }
  }
  return { summary, items };
}

async function streamBriefing({ apiKey, onPhase, onProgress, onDone, onError, onNeedKey }) {
  const today = new Date().toISOString().split("T")[0];

  const headers = {
    "Content-Type": "application/json",
    "anthropic-version": "2023-06-01",
    "anthropic-dangerous-direct-browser-access": "true",
  };
  if (apiKey) headers["x-api-key"] = apiKey;

  let response;
  try {
    response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        stream: true,
        system: SYSTEM_PROMPT,
        tools: [{ type: "web_search_20250305", name: "web_search" }],
        messages: [{
          role: "user",
          content: `오늘 날짜: ${today}\n최근 7일간 아이폰 관련 국내외 주요 뉴스를 웹 검색으로 수집하고 JSON 브리핑을 작성해주세요.`,
        }],
      }),
    });
  } catch (e) {
    onError(`네트워크 오류: ${e.message}`);
    return;
  }

  if (response.status === 401) { onNeedKey(); return; }
  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    onError(`API 오류 ${response.status}: ${err?.error?.message || response.statusText}`);
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "", accumulated = "", lastCount = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop();

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const raw = line.slice(6).trim();
        if (!raw || raw === "[DONE]") continue;

        let evt;
        try { evt = JSON.parse(raw); } catch { continue; }

        if (evt.type === "content_block_start") {
          if (evt.content_block?.type === "tool_use") onPhase("searching");
          else if (evt.content_block?.type === "text") onPhase("generating");
        }

        if (evt.type === "content_block_delta") {
          if (evt.delta?.type === "text_delta") {
            accumulated += evt.delta.text;
            const { summary, items } = parsePartialNews(accumulated);
            if (items.length > lastCount) {
              lastCount = items.length;
              onProgress({ summary, items });
            }
          }
        }

        if (evt.type === "message_stop") {
          const jsonMatch = accumulated.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            try { onDone(JSON.parse(jsonMatch[0])); return; } catch {}
          }
          const { summary, items } = parsePartialNews(accumulated);
          if (items.length > 0) { onDone({ summary, news: items }); return; }
          onError("응답 파싱 실패");
        }
      }
    }
  } catch (e) {
    onError(`스트리밍 오류: ${e.message}`);
  }
}

// ─── UI COMPONENTS ────────────────────────────────────────────────────────────
function ApiKeyModal({ onSave, onClose }) {
  const [val, setVal] = useState("");
  return (
    <div style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,0.75)",
      display: "flex", alignItems: "center", justifyContent: "center", zIndex: 999,
    }}>
      <div style={{
        background: "#111", border: "1px solid #2A2A2A", borderRadius: 14,
        padding: "32px 28px", width: 380, maxWidth: "calc(100vw - 48px)",
      }}>
        <div style={{ fontFamily: "monospace", fontSize: 10, color: "#555", letterSpacing: 2, marginBottom: 8 }}>
          ANTHROPIC API KEY
        </div>
        <h2 style={{ margin: "0 0 8px", fontSize: 17, color: "#F5F5F7", fontFamily: "Georgia, serif" }}>
          API 키 설정
        </h2>
        <p style={{ color: "#666", fontSize: 13, lineHeight: 1.65, margin: "0 0 18px" }}>
          GitHub 배포 환경에서 API 키가 필요합니다.<br />
          Claude.ai에서는 키 없이도 동작합니다.<br />
          <span style={{ color: "#FF9500", fontSize: 12 }}>⚠ 개인 사용 목적으로만</span>
        </p>
        <input
          type="password"
          placeholder="sk-ant-..."
          value={val}
          onChange={e => setVal(e.target.value)}
          onKeyDown={e => e.key === "Enter" && val && onSave(val)}
          autoFocus
          style={{
            width: "100%", boxSizing: "border-box",
            background: "#1A1A1C", border: "1px solid #333", borderRadius: 8,
            padding: "10px 14px", color: "#E8E8EA",
            fontFamily: "monospace", fontSize: 13, outline: "none", marginBottom: 10,
          }}
        />
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={onClose} style={{
            flex: 1, padding: "9px", borderRadius: 8, background: "transparent",
            border: "1px solid #222", color: "#555", fontFamily: "monospace",
            fontSize: 12, cursor: "pointer",
          }}>
            취소
          </button>
          <button disabled={!val} onClick={() => onSave(val)} style={{
            flex: 2, padding: "9px", borderRadius: 8,
            background: val ? "#1D6BED" : "#1C1C1E",
            border: "none", color: val ? "#fff" : "#333",
            fontFamily: "monospace", fontSize: 12, cursor: val ? "pointer" : "not-allowed",
          }}>
            저장 후 브리핑 시작
          </button>
        </div>
      </div>
    </div>
  );
}

function StatusBar({ phase, itemCount }) {
  const steps = [
    { key: "searching",  label: "웹 검색 중" },
    { key: "generating", label: "브리핑 작성 중" },
  ];
  const activeIdx = phase === "generating" ? 1 : 0;

  return (
    <div style={{
      background: "#0F0F11", border: "1px solid #1E1E22",
      borderRadius: 10, padding: "20px 24px", marginBottom: 28,
    }}>
      <div style={{ display: "flex", gap: 0, marginBottom: 16 }}>
        {steps.map((s, i) => (
          <div key={s.key} style={{ flex: 1, display: "flex", alignItems: "center" }}>
            <div style={{
              width: 30, height: 30, borderRadius: "50%", flexShrink: 0,
              display: "flex", alignItems: "center", justifyContent: "center",
              background: i < activeIdx ? "#1D6BED" : i === activeIdx ? "#1D6BED" : "#1A1A1C",
              border: `1px solid ${i <= activeIdx ? "#1D6BED" : "#2A2A2A"}`,
              fontSize: 11, color: i <= activeIdx ? "#fff" : "#444",
              fontFamily: "monospace",
              boxShadow: i === activeIdx ? "0 0 0 4px rgba(29,107,237,0.2)" : "none",
              transition: "all 0.3s",
            }}>
              {i < activeIdx ? "✓" : i + 1}
            </div>
            {i < steps.length - 1 && (
              <div style={{
                flex: 1, height: 1, margin: "0 8px",
                background: i < activeIdx ? "#1D6BED" : "#222",
                transition: "background 0.5s",
              }} />
            )}
          </div>
        ))}
      </div>
      <div style={{ display: "flex", gap: 0 }}>
        {steps.map((s, i) => (
          <div key={s.key} style={{
            flex: 1, fontFamily: "monospace", fontSize: 10, letterSpacing: 1,
            color: i === activeIdx ? "#E8E8EA" : i < activeIdx ? "#1D6BED" : "#444",
          }}>
            {s.label}
          </div>
        ))}
      </div>
      {itemCount > 0 && (
        <div style={{
          marginTop: 14, padding: "6px 12px",
          background: "rgba(29,107,237,0.08)", border: "1px solid rgba(29,107,237,0.2)",
          borderRadius: 6, fontFamily: "monospace", fontSize: 11, color: "#6B9FED",
        }}>
          {itemCount}건 수신 완료 — 나머지 로드 중...
        </div>
      )}
    </div>
  );
}

function NewsCard({ item, expanded, onToggle }) {
  const cfg = PC[item.priority] || PC.LOW;
  return (
    <div onClick={onToggle} style={{
      background: expanded ? cfg.bg : "rgba(255,255,255,0.025)",
      border: `1px solid ${expanded ? cfg.border : "#1C1C1E"}`,
      borderLeft: `3px solid ${cfg.color}`,
      borderRadius: "0 10px 10px 0",
      padding: "14px 18px", cursor: "pointer",
      transition: "border-color 0.15s, background 0.15s",
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10 }}>
        <div style={{ flex: 1 }}>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 7, alignItems: "center" }}>
            <span style={{
              background: cfg.bg, border: `1px solid ${cfg.border}`,
              color: cfg.color, borderRadius: 4, padding: "1px 7px",
              fontFamily: "monospace", fontSize: 10, letterSpacing: 1, fontWeight: 700,
            }}>
              {cfg.label}
            </span>
            <span style={{
              color: "#555", border: "1px solid #1E1E20", borderRadius: 4,
              padding: "1px 7px", fontFamily: "monospace", fontSize: 10,
            }}>
              {item.category}
            </span>
            <span style={{ color: "#444", fontFamily: "monospace", fontSize: 10 }}>
              {item.region} · {item.date}
            </span>
          </div>
          <div style={{ fontSize: 14, fontWeight: 600, color: "#F0F0F2", lineHeight: 1.45, fontFamily: "Georgia, serif" }}>
            {item.headline}
          </div>
        </div>
        <span style={{
          color: "#333", fontSize: 11, flexShrink: 0, paddingTop: 2,
          transform: expanded ? "rotate(180deg)" : "none", transition: "transform 0.2s",
          display: "inline-block",
        }}>▾</span>
      </div>

      {expanded && (
        <div style={{ marginTop: 12, borderTop: `1px solid ${cfg.border}`, paddingTop: 12 }}>
          <p style={{ margin: "0 0 10px", color: "#A0A0A2", fontSize: 13, lineHeight: 1.7 }}>
            {item.summary}
          </p>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
            <span style={{
              fontFamily: "monospace", fontSize: 11,
              color: item.impact === "긍정" ? "#34C759" : item.impact === "부정" ? "#FF3B30" : "#888",
            }}>
              브랜드 영향 {item.impact}
            </span>
            <span style={{ color: "#444", fontFamily: "monospace", fontSize: 11 }}>
              {item.source}
            </span>
            {item.url && item.url !== "N/A" && (
              <a
                href={item.url} target="_blank" rel="noopener noreferrer"
                onClick={e => e.stopPropagation()}
                style={{
                  color: cfg.color, fontFamily: "monospace", fontSize: 11,
                  textDecoration: "none", border: `1px solid ${cfg.border}`,
                  borderRadius: 4, padding: "2px 9px",
                }}
              >
                → 원문
              </a>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── MAIN APP ─────────────────────────────────────────────────────────────────
export default function App() {
  const dateStr = new Date().toLocaleDateString("ko-KR", {
    year: "numeric", month: "long", day: "numeric", weekday: "long",
  });

  const [briefing, setBriefing]     = useState(null);
  const [partial, setPartial]       = useState(null);
  const [phase, setPhase]           = useState("idle");
  const [error, setError]           = useState(null);
  const [filter, setFilter]         = useState("ALL");
  const [expandedIdx, setExpandedIdx] = useState(null);
  const [showKeyModal, setShowKeyModal] = useState(false);
  const [apiKey, setApiKey]         = useState(() => getApiKey());
  const [fromCache, setFromCache]   = useState(false);

  const isLoading = phase === "searching" || phase === "generating";
  const displayData = briefing || partial;
  const news = displayData?.news || [];
  const filtered = news.filter(n => filter === "ALL" || n.priority === filter);
  const counts = news.reduce((a, n) => ({ ...a, [n.priority]: (a[n.priority] || 0) + 1 }), {});

  function startFetch(key) {
    const k = key !== undefined ? key : apiKey;
    setError(null);
    setBriefing(null);
    setPartial(null);
    setPhase("searching");
    setExpandedIdx(null);
    setFromCache(false);

    streamBriefing({
      apiKey: k,
      onPhase: (p) => setPhase(p),
      onProgress: (data) => setPartial(data),
      onDone: (data) => {
        setBriefing(data);
        setPartial(null);
        setPhase("done");
        setCache(data);
      },
      onError: (msg) => {
        setError(msg);
        setPhase("idle");
      },
      onNeedKey: () => {
        setPhase("idle");
        setShowKeyModal(true);
      },
    });
  }

  useEffect(() => {
    const cached = getCached();
    if (cached) { setBriefing(cached); setPhase("done"); setFromCache(true); return; }
    // API 키 없어도 Claude.ai 환경에선 프록시가 처리하므로 바로 시작
    startFetch(apiKey);
  }, []);

  function handleSaveKey(k) {
    safeStorage.set("anthropic_api_key", k);
    setApiKey(k);
    setShowKeyModal(false);
    startFetch(k);
  }

  return (
    <div style={{ minHeight: "100vh", background: "#0A0A0B", color: "#E8E8EA", fontFamily: "Georgia, serif" }}>
      {showKeyModal && <ApiKeyModal onSave={handleSaveKey} onClose={() => setShowKeyModal(false)} />}

      {/* ── Header ── */}
      <div style={{
        borderBottom: "1px solid #181818",
        padding: "22px 28px 16px",
        background: "#0D0D0F",
        position: "sticky", top: 0, zIndex: 100,
      }}>
        <div style={{ maxWidth: 820, margin: "0 auto" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
            <div>
              <div style={{ fontFamily: "monospace", fontSize: 9, color: "#444", letterSpacing: 3, marginBottom: 4, textTransform: "uppercase" }}>
                iPhone Intelligence Briefing
              </div>
              <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700, color: "#F5F5F7", letterSpacing: "-0.3px", lineHeight: 1.2 }}>
                아이폰 모닝 브리핑
              </h1>
              <div style={{ fontFamily: "monospace", fontSize: 11, color: "#555", marginTop: 3 }}>
                {dateStr} · 최근 7일
                {fromCache && <span style={{ color: "#1D6BED", marginLeft: 8 }}>· 캐시됨</span>}
                {isLoading && news.length > 0 && <span style={{ color: "#FF9500", marginLeft: 8 }}>· {news.length}건 수신 중</span>}
              </div>
            </div>
            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <button onClick={() => setShowKeyModal(true)} title="API 키 설정" style={{
                background: "transparent", border: "1px solid #1E1E20", borderRadius: 6,
                color: "#444", padding: "6px 10px", cursor: "pointer", fontSize: 13,
              }}>🔑</button>
              <button onClick={() => startFetch()} disabled={isLoading} style={{
                background: "#1A1A1C", border: "1px solid #2A2A2A", borderRadius: 8,
                color: isLoading ? "#3A3A3C" : "#C8C8CA",
                padding: "7px 14px", cursor: isLoading ? "not-allowed" : "pointer",
                fontFamily: "monospace", fontSize: 11, letterSpacing: 1,
              }}>
                {isLoading ? "⟳ 수집 중" : "↺ 새로고침"}
              </button>
            </div>
          </div>

          {/* Filter */}
          {news.length > 0 && (
            <div style={{ display: "flex", gap: 5, marginTop: 14, flexWrap: "wrap" }}>
              {["ALL", "BREAKING", "HIGH", "MID", "LOW"].map(p => {
                const cfg = PC[p];
                const count = p === "ALL" ? news.length : (counts[p] || 0);
                const active = filter === p;
                return (
                  <button key={p} onClick={() => setFilter(p)} style={{
                    background: active ? (cfg?.bg || "rgba(255,255,255,0.07)") : "transparent",
                    border: `1px solid ${active ? (cfg?.border || "#3A3A3C") : "#1E1E20"}`,
                    borderRadius: 20, color: active ? (cfg?.color || "#E8E8EA") : "#444",
                    padding: "3px 11px", cursor: "pointer",
                    fontFamily: "monospace", fontSize: 10, letterSpacing: 1,
                  }}>
                    {p}{count > 0 ? ` (${count})` : ""}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* ── Body ── */}
      <div style={{ maxWidth: 820, margin: "0 auto", padding: "24px 28px 80px" }}>

        {/* Phase bar - 뉴스 0건일 때만 전체 표시 */}
        {isLoading && news.length === 0 && <StatusBar phase={phase} itemCount={0} />}

        {/* 에러 */}
        {error && (
          <div style={{
            background: "rgba(255,59,48,0.06)", border: "1px solid rgba(255,59,48,0.18)",
            borderRadius: 8, padding: "16px 20px", marginBottom: 20,
          }}>
            <div style={{ color: "#FF3B30", fontFamily: "monospace", fontSize: 11, marginBottom: 6 }}>오류</div>
            <div style={{ color: "#C0C0C2", fontSize: 13 }}>{error}</div>
            {(error.includes("401") || error.includes("403")) && (
              <button onClick={() => setShowKeyModal(true)} style={{
                marginTop: 12, background: "transparent", border: "1px solid rgba(255,59,48,0.3)",
                borderRadius: 6, color: "#FF3B30", padding: "5px 12px",
                fontFamily: "monospace", fontSize: 11, cursor: "pointer",
              }}>
                API 키 설정하기
              </button>
            )}
          </div>
        )}

        {/* Summary */}
        {displayData?.summary && (
          <div style={{
            border: "1px solid #202022", borderLeft: "3px solid #3A3A3C",
            borderRadius: "0 8px 8px 0", padding: "13px 17px", marginBottom: 20,
          }}>
            <div style={{ fontFamily: "monospace", fontSize: 9, color: "#444", letterSpacing: 2, marginBottom: 4 }}>
              에디터 총평
            </div>
            <div style={{ fontSize: 13, color: "#A0A0A2", lineHeight: 1.65, fontStyle: "italic" }}>
              "{displayData.summary}"
            </div>
          </div>
        )}

        {/* 스트리밍 중 진행 인디케이터 */}
        {isLoading && news.length > 0 && (
          <div style={{
            display: "flex", alignItems: "center", gap: 8, marginBottom: 16,
            fontFamily: "monospace", fontSize: 11, color: "#555",
            padding: "7px 12px", background: "#0F0F11",
            border: "1px solid #1A1A1C", borderRadius: 6,
          }}>
            <span style={{
              width: 7, height: 7, borderRadius: "50%",
              background: "#1D6BED", display: "inline-block",
              animation: "blink 1.2s ease infinite",
            }} />
            <style>{`@keyframes blink{0%,100%{opacity:1}50%{opacity:0.25}}`}</style>
            브리핑 수신 중 · {news.length}건 완료
          </div>
        )}

        {/* 뉴스 카드 */}
        <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
          {filtered.map((item, i) => (
            <NewsCard
              key={i}
              item={item}
              expanded={expandedIdx === i}
              onToggle={() => setExpandedIdx(expandedIdx === i ? null : i)}
            />
          ))}
        </div>

        {briefing && filtered.length === 0 && (
          <div style={{ textAlign: "center", padding: "48px 0", color: "#2A2A2C", fontFamily: "monospace", fontSize: 12 }}>
            해당 분류의 뉴스가 없습니다.
          </div>
        )}

        {briefing && (
          <div style={{
            marginTop: 44, borderTop: "1px solid #121214", paddingTop: 14,
            fontFamily: "monospace", fontSize: 9, color: "#2A2A2C",
            textAlign: "center", letterSpacing: 2,
          }}>
            AI GENERATED · VERIFY URLS BEFORE DISTRIBUTION · INTERNAL USE ONLY
          </div>
        )}
      </div>
    </div>
  );
}
