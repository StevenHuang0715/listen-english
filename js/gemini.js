// Google Gemini 翻譯（免費 API 金鑰）
//   - 一次送一批段落（JSON 陣列），附上書名和前文，讓 AI 依上下文翻譯
//   - 金鑰只存在這台裝置的瀏覽器（localStorage），程式碼裡沒有金鑰
//   - 免費方案每分鐘、每天都有次數上限：請求之間至少間隔幾秒，超過上限就回報

const API = 'https://generativelanguage.googleapis.com/v1beta';
const KEY_STORE = 'gemini-api-key';
const MODEL_STORE = 'gemini-model';

export const MODELS = [
  ['gemini-flash-lite-latest', 'Flash-Lite（建議：速度快、免費次數最多）'],
  ['gemini-flash-latest', 'Flash（翻得更好，但免費次數較少）'],
];
export const DEFAULT_MODEL = MODELS[0][0];

const read = (k) => {
  try {
    return localStorage.getItem(k) || '';
  } catch {
    return '';
  }
};
const write = (k, v) => {
  try {
    if (v) localStorage.setItem(k, v);
    else localStorage.removeItem(k);
  } catch { /* 無痕模式等情況存不了 */ }
};

export const getKey = () => read(KEY_STORE);
export const getModel = () => read(MODEL_STORE) || DEFAULT_MODEL;
export function save(key, model) {
  write(KEY_STORE, key.trim());
  write(MODEL_STORE, model && model !== DEFAULT_MODEL ? model : '');
  disabledReason = null;
}
export const enabled = () => !!getKey() && !disabledReason;
export const configured = () => !!getKey();

/** 今天不能再用（金鑰錯、額度用完）→ 這次開啟網頁期間改用其他翻譯 */
let disabledReason = null;
export const disabled = () => disabledReason;

let notify = () => {};
export function setNotifier(fn) {
  notify = fn;
}

class GeminiError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code; // KEY | QUOTA_DAY | QUOTA_MINUTE | MODEL | BLOCKED | FORMAT | NETWORK
  }
}

/* ---------- 送出請求（間隔控制） ---------- */

const MIN_GAP_MS = 4500; // 免費方案每分鐘約 10～15 次，間隔 4.5 秒比較保險
let nextSlot = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitSlot() {
  const now = Date.now();
  const wait = Math.max(0, nextSlot - now);
  nextSlot = Math.max(now, nextSlot) + MIN_GAP_MS;
  if (wait) await sleep(wait);
}

async function call(model, body, key = getKey()) {
  for (let attempt = 0; ; attempt++) {
    await waitSlot();
    let res;
    try {
      res = await fetch(`${API}/models/${encodeURIComponent(model)}:generateContent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify(body),
      });
    } catch {
      if (attempt < 2) {
        await sleep(3000);
        continue;
      }
      throw new GeminiError('NETWORK', '連不上 Gemini，請檢查網路');
    }
    if (res.ok) return res.json();

    const err = await res.json().catch(() => ({}));
    const text = JSON.stringify(err);
    const msg = err.error?.message ?? `HTTP ${res.status}`;
    if (/API_KEY_INVALID|API key not valid/i.test(text) || res.status === 401 || res.status === 403) {
      throw new GeminiError('KEY', 'Gemini 金鑰無效或沒有權限，請到「翻譯設定」重新貼上');
    }
    if (res.status === 404) throw new GeminiError('MODEL', `找不到模型 ${model}，請到「翻譯設定」換一個`);
    if (res.status === 429) {
      if (/PerDay/i.test(text)) throw new GeminiError('QUOTA_DAY', '今天的 Gemini 免費額度用完了，明天會恢復');
      const delay = Number((text.match(/"retryDelay":\s*"(\d+(?:\.\d+)?)s"/) || [])[1] ?? 20);
      if (attempt < 3 && delay <= 65) {
        nextSlot = Math.max(nextSlot, Date.now() + delay * 1000);
        continue;
      }
      throw new GeminiError('QUOTA_MINUTE', 'Gemini 暫時太忙（每分鐘次數上限），稍後再試');
    }
    if (res.status >= 500 && attempt < 2) {
      await sleep(4000);
      continue;
    }
    throw new GeminiError('NETWORK', `Gemini 錯誤：${msg}`);
  }
}

/* ---------- 翻譯 ---------- */

const SYSTEM = `你是專業的英文文學譯者，把英文小說片段翻成自然、流暢、符合上下文的台灣繁體中文。
規則：
1. 輸入是 JSON 字串陣列，每個元素是一段。輸出必須是 JSON 字串陣列，元素數量與順序和輸入完全一樣，每個元素是對應那一段的中文；不可合併、拆分、省略或調換。
2. 依前後文判斷代名詞、詞義和語氣，古典或老式英文要譯出實際意思，不要逐字直譯。
3. 人名、地名全書譯法一致，採台灣常見譯名。
4. 使用台灣用語與全形標點；對話用「」。不要加註解、拼音或英文原文。`;

/**
 * 翻譯一批段落 → 與 items 等長的中文陣列
 * book: { title, author, zhTitle }；context: 前面幾段 [{ en, zh }]（只供參考）
 */
export async function translateBatch(items, { book, context = [] } = {}, opts = {}) {
  const model = opts.model ?? getModel();
  const key = opts.key ?? getKey();
  const head = book ? `書名：${book.title}${book.zhTitle ? `（${book.zhTitle}）` : ''}${book.author ? `，作者：${book.author}` : ''}\n` : '';
  const ctx = context.length
    ? `前文（只供理解上下文，不用翻譯）：\n${context.map((c) => `- ${c.en}${c.zh ? `\n  譯文：${c.zh}` : ''}`).join('\n')}\n`
    : '';
  const body = {
    systemInstruction: { parts: [{ text: SYSTEM }] },
    contents: [{ role: 'user', parts: [{ text: `${head}${ctx}請翻譯以下 ${items.length} 段：\n${JSON.stringify(items)}` }] }],
    generationConfig: {
      temperature: 0.3,
      responseMimeType: 'application/json',
      responseSchema: { type: 'ARRAY', items: { type: 'STRING' } },
    },
  };
  const data = await call(model, body, key);
  const cand = data.candidates?.[0];
  const text = cand?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
  if (!text) throw new GeminiError('BLOCKED', `Gemini 沒有回傳翻譯（${cand?.finishReason ?? data.promptFeedback?.blockReason ?? '原因不明'}）`);
  let out;
  try {
    out = JSON.parse(text);
  } catch {
    throw new GeminiError('FORMAT', 'Gemini 回傳的格式不正確');
  }
  if (!Array.isArray(out) || out.length !== items.length || out.some((x) => typeof x !== 'string' || !x.trim())) {
    throw new GeminiError('FORMAT', `Gemini 回傳 ${Array.isArray(out) ? out.length : 0} 段，應該是 ${items.length} 段`);
  }
  return out.map((s) => s.trim());
}

/**
 * 翻譯一批；段數對不上就切成兩半重試，最後退到一段一段翻
 * 金鑰錯、今日額度用完 → 停用 Gemini（這次開網頁期間），並通知畫面
 */
export async function translateSafe(items, info) {
  try {
    return await translateBatch(items, info);
  } catch (e) {
    if (e.code === 'FORMAT' || e.code === 'BLOCKED') {
      if (items.length === 1) throw e;
      const mid = Math.ceil(items.length / 2);
      const a = await translateSafe(items.slice(0, mid), info);
      const b = await translateSafe(items.slice(mid), { ...info, context: [] });
      return [...a, ...b];
    }
    if (e.code === 'KEY' || e.code === 'QUOTA_DAY' || e.code === 'MODEL') {
      disabledReason = e.message;
      notify(e.message);
    }
    throw e;
  }
}

/** 設定頁的「測試」：用目前輸入的金鑰和模型翻一句 */
export async function test(key, model) {
  const [zh] = await translateBatch(['It is a truth universally acknowledged, that a single man in possession of a good fortune, must be in want of a wife.'],
    { book: { title: 'Pride and Prejudice', author: 'Jane Austen' } }, { key, model });
  return zh;
}
