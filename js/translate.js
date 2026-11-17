// 翻譯：用瀏覽器內建的離線翻譯（Edge / Chrome 桌面版的 Translator API）
// 每段只翻譯一次，翻好就存進 IndexedDB，之後不需要網路、也不用再翻。

import * as db from './db.js';
import * as gemini from './gemini.js';

const OPTS = { sourceLanguage: 'en', targetLanguage: 'zh-Hant' };
let translatorPromise = null;

export const supported = () => 'Translator' in self;

/** 這台裝置能不能翻譯（Gemini 金鑰或內建翻譯） */
export const canTranslate = () => gemini.enabled() || supported();

/** 'unsupported' | 'unavailable' | 'downloadable' | 'downloading' | 'available' */
export async function availability() {
  if (!supported()) return 'unsupported';
  try {
    return await Translator.availability(OPTS);
  } catch {
    return 'unavailable';
  }
}

/**
 * 取得翻譯器。第一次使用要下載翻譯模型，瀏覽器規定必須在使用者點擊後才能開始，
 * 所以要在按鈕的 click 事件裡「同步」呼叫一次（不要先 await 別的東西）。
 */
export function getTranslator(onDownload) {
  if (!supported()) return Promise.reject(new Error('這個瀏覽器沒有內建翻譯'));
  if (!translatorPromise) {
    translatorPromise = Translator.create({
      ...OPTS,
      monitor(m) {
        m.addEventListener('downloadprogress', (e) => onDownload?.(e.loaded));
      },
    }).catch((e) => {
      translatorPromise = null;
      throw e;
    });
  }
  return translatorPromise;
}

/** 翻譯結果的半形標點換成全形（數字裡的逗號、冒號保留） */
export function fixPunct(s) {
  return s
    .replace(/(?<!\d),|,(?!\d)/g, '，')
    .replace(/\?/g, '？')
    .replace(/!/g, '！')
    .replace(/;/g, '；')
    .replace(/(?<!\d):|:(?!\d)/g, '：')
    .replace(/\s*([，。？！；：「」『』])\s*/g, '$1')
    .trim();
}

/** 一本書的翻譯快取：按章存放，缺的才翻 */
export class Translations {
  constructor(bookId, en, onChange, book = null) {
    this.bookId = bookId;
    this.en = en;
    this.onChange = onChange;
    this.book = book; // 給 Gemini 的書名、作者
    this.pending = new Map(); // `${章}:${段}` → 正在翻譯的 Gemini 請求
    this.batchSize = 20;
    this.cache = new Map();
    this.dirty = new Set();
    this.saveTimer = null;
    this.chain = Promise.resolve(); // 一次只翻一段，避免塞爆翻譯器
    this.prefetchKey = null;
  }

  key(ch) {
    return `${this.bookId}:zh:${ch}`;
  }

  async chapter(ch) {
    if (!this.cache.has(ch)) {
      const saved = await db.get('blobs', this.key(ch));
      if (!this.cache.has(ch)) this.cache.set(ch, saved ?? new Array(this.en[ch].length).fill(null));
    }
    return this.cache.get(ch);
  }

  /** 只看快取，不觸發翻譯 */
  peek(ch, i) {
    return this.cache.get(ch)?.[i] ?? null;
  }

  async get(ch, i) {
    const arr = await this.chapter(ch);
    if (arr[i] != null) return arr[i];
    if (gemini.enabled() || this.pending.has(`${ch}:${i}`)) {
      try {
        await this.geminiBatch(ch, i, arr);
        if (arr[i] != null) return arr[i];
      } catch (e) {
        if (!supported()) throw e; // 沒有內建翻譯可以退
      }
    }
    if (!supported()) return null;
    const run = this.chain.then(async () => {
      if (arr[i] != null) return arr[i];
      const tr = await getTranslator();
      arr[i] = fixPunct(await tr.translate(this.en[ch][i]));
      this.markDirty(ch);
      return arr[i];
    });
    this.chain = run.catch(() => {});
    return run;
  }

  /**
   * 用 Gemini 翻譯從第 i 段開始、還沒翻的連續幾段（一次請求）
   * 同一段已經在翻的話，等那個請求就好
   */
  geminiBatch(ch, i, arr) {
    const key = (j) => `${ch}:${j}`;
    if (this.pending.has(key(i))) return this.pending.get(key(i));
    const idx = [];
    let chars = 0;
    for (let j = i; j < arr.length && idx.length < this.batchSize && chars < 6000; j++) {
      if (arr[j] != null || this.pending.has(key(j))) break;
      idx.push(j);
      chars += this.en[ch][j].length;
    }
    const context = [];
    for (let j = Math.max(0, i - 3); j < i; j++) context.push({ en: this.en[ch][j], zh: arr[j] });
    const run = gemini.translateSafe(idx.map((j) => this.en[ch][j]), { book: this.book, context }).then((zhs) => {
      idx.forEach((j, k) => {
        if (arr[j] == null) arr[j] = fixPunct(zhs[k]);
      });
      this.markDirty(ch);
    }).finally(() => {
      for (const j of idx) this.pending.delete(key(j));
    });
    for (const j of idx) this.pending.set(key(j), run);
    return run;
  }

  /** 播放時預先翻譯後面幾段，讓英文唸完時中文已經好了 */
  async prefetch(ch, from, n = 4) {
    if (!canTranslate()) return;
    if (gemini.enabled()) n = 10; // Gemini 一次翻一批，提早送出下一批
    const key = `${ch}:${from}`;
    this.prefetchKey = key;
    const arr = await this.chapter(ch);
    for (let i = from; i < Math.min(from + n, arr.length); i++) {
      if (this.prefetchKey !== key) return; // 使用者跳到別處了
      if (arr[i] == null) {
        try {
          await this.get(ch, i);
        } catch {
          return;
        }
      }
    }
  }

  markDirty(ch) {
    this.dirty.add(ch);
    this.onChange?.(ch);
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.flush(), 2000);
  }

  async flush() {
    clearTimeout(this.saveTimer);
    const chs = [...this.dirty];
    this.dirty.clear();
    for (const ch of chs) await db.put('blobs', this.cache.get(ch), this.key(ch));
  }

  /** 統計：{ done, total } 全書 / 某一章 */
  async stats(ch) {
    if (ch != null) {
      const arr = await this.chapter(ch);
      return { done: arr.filter((x) => x != null).length, total: arr.length };
    }
    let done = 0;
    let total = 0;
    for (let c = 0; c < this.en.length; c++) {
      const s = await this.stats(c);
      done += s.done;
      total += s.total;
    }
    return { done, total };
  }

  /** 翻譯整本書；shouldStop() 回傳 true 就停 */
  async translateAll(onProgress, shouldStop) {
    let { done, total } = await this.stats();
    this.batchSize = 40; // 整本翻譯：一次多翻一點，減少請求次數
    try {
      return await this.translateAllInner(onProgress, shouldStop, done, total);
    } finally {
      this.batchSize = 20;
    }
  }

  async translateAllInner(onProgress, shouldStop, done, total) {
    const count = (arr) => arr.reduce((n, x) => n + (x != null), 0);
    for (let c = 0; c < this.en.length; c++) {
      const arr = await this.chapter(c);
      let have = count(arr);
      for (let i = 0; i < arr.length; i++) {
        if (shouldStop()) {
          await this.flush();
          return false;
        }
        if (arr[i] == null) {
          await this.get(c, i);
          // Gemini 一次會翻好好幾段，重新數一次
          const now = count(arr);
          if (now === have) throw new Error(gemini.disabled() ?? '這段翻不出來');
          done += now - have;
          have = now;
          onProgress(done, total);
        }
      }
    }
    await this.flush();
    onProgress(total, total);
    return true;
  }
}
