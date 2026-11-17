// 雙語朗讀播放器：每一段先唸英文、再唸中文（順序可調）
// 位置單位 = 第幾段。事件：progress / state / chapter / speaking / finished / sleep / error

import * as db from './db.js';
import { Translations } from './translate.js';

export const MODES = {
  'en-zh': ['en', 'zh'],
  'en-zh-en': ['en', 'zh', 'en'],
  'en-en-zh': ['en', 'en', 'zh'],
  en: ['en'],
};

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
const GAP_BETWEEN_LANG = 450; // 英文 → 中文 之間停一下
const GAP_BETWEEN_SEG = 800; // 段與段之間停久一點

export const ttsSupported = () => 'speechSynthesis' in window;

export class BilingualPlayer extends EventTarget {
  constructor() {
    super();
    this.book = null;
    this.en = null;
    this.tr = null;
    this.chapter = 0;
    this.index = 0;
    this.step = 0;
    this._playing = false;
    this.token = 0;
    this.gapTimer = null;
    this.keepAlive = null;
    this.mode = 'en-zh';
    this.rate = { en: 0.9, zh: 1.1 };
    this.voice = { en: null, zh: null };
    this.volume = 1;
    this.speakingLang = null;
    this.stopAtChapterEnd = false;
  }

  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  get playing() {
    return this._playing;
  }

  get pos() {
    return this.index;
  }

  get position() {
    return { chapter: this.chapter, pos: this.index };
  }

  get duration() {
    return this.en?.[this.chapter]?.length ?? 0;
  }

  get chapterCount() {
    return this.book?.chapters.length ?? 0;
  }

  get chapterTitle() {
    return this.book?.chapters[this.chapter]?.title ?? '';
  }

  get currentEn() {
    return this.en?.[this.chapter]?.[this.index] ?? '';
  }

  get currentZh() {
    return this.tr?.peek(this.chapter, this.index) ?? null;
  }

  async load(book, chapter = 0, pos = 0, onTranslated) {
    this.stop();
    this.book = book;
    this.en = await db.get('blobs', `${book.id}:en`);
    if (!this.en) throw new Error('找不到這本書的內容');
    this.tr = new Translations(book.id, this.en, onTranslated, { title: book.title, author: book.author, zhTitle: book.zhTitle });
    await this.setChapter(chapter, pos, false);
  }

  async setChapter(i, pos = 0, autoplay = false) {
    if (!this.en?.[i]) return;
    this.cancel();
    this.chapter = i;
    this.index = clamp(Math.floor(pos), 0, Math.max(this.en[i].length - 1, 0));
    this.step = 0;
    await this.tr.chapter(i);
    this.emit('chapter');
    this.emit('progress');
    this.showTranslation();
    if (autoplay) this.play();
    else if (this._playing) {
      this._playing = false;
      this.emit('state');
    }
  }

  /** 暫停時也把目前這段的中文翻出來顯示 */
  showTranslation() {
    if (this.currentZh != null || !this.tr) return;
    const { chapter, index } = this;
    this.tr.get(chapter, index).then(() => {
      if (this.chapter === chapter && this.index === index) this.emit('progress');
    }).catch(() => {});
  }

  play() {
    if (!this.en) return;
    if (this.index >= this.duration) this.index = 0;
    this.cancel();
    this._playing = true;
    this.step = 0;
    this.emit('state');
    this.run();
  }

  pause() {
    this._playing = false;
    this.cancel();
    this.emit('state');
    this.emit('speaking');
  }

  cancel() {
    this.token++;
    clearTimeout(this.gapTimer);
    clearInterval(this.keepAlive);
    this.speakingLang = null;
    if (ttsSupported()) speechSynthesis.cancel();
  }

  async run() {
    const token = this.token;
    const segs = this.en[this.chapter];
    if (this.index >= segs.length) {
      this._playing = false;
      this.emit('state');
      this.handleChapterEnd();
      return;
    }
    const steps = MODES[this.mode] ?? MODES['en-zh'];
    if (this.step >= steps.length) {
      this.step = 0;
      this.index++;
      this.emit('progress');
      this.wait(GAP_BETWEEN_SEG, token);
      return;
    }

    const lang = steps[this.step];
    let text = segs[this.index];
    if (this.step === 0) this.tr.prefetch(this.chapter, this.index, 4);
    if (lang === 'zh') {
      try {
        text = await this.tr.get(this.chapter, this.index);
      } catch (e) {
        text = null;
        this.emit('error', `翻譯失敗：${e.message}`);
      }
      if (token !== this.token) return;
      this.emit('progress');
      if (!text) {
        this.step++;
        this.run();
        return;
      }
    }

    this.speakingLang = lang;
    this.emit('speaking');
    const u = new SpeechSynthesisUtterance(text);
    const v = this.voice[lang];
    if (v) u.voice = v;
    u.lang = v?.lang ?? (lang === 'en' ? 'en-US' : 'zh-TW');
    u.rate = this.rate[lang];
    u.volume = this.volume;
    u.onend = () => {
      if (token !== this.token) return;
      this.speakingLang = null;
      this.emit('speaking');
      this.step++;
      this.wait(GAP_BETWEEN_LANG, token);
    };
    u.onerror = (e) => {
      if (token !== this.token || e.error === 'interrupted' || e.error === 'canceled') return;
      this._playing = false;
      this.speakingLang = null;
      this.emit('state');
      this.emit('error', `語音朗讀失敗（${e.error}）`);
    };
    this.utterance = u; // 保留參考，避免被回收後 onend 不觸發
    speechSynthesis.resume();
    speechSynthesis.speak(u);
    this.startKeepAlive(v);
  }

  wait(ms, token) {
    this.gapTimer = setTimeout(() => {
      if (token === this.token && this._playing) this.run();
    }, ms);
  }

  // Chrome 的 Google 線上語音約 15 秒會自己停住，定期 pause/resume 可避免
  startKeepAlive(v) {
    clearInterval(this.keepAlive);
    if (v && /google/i.test(v.name) && !/android/i.test(navigator.userAgent)) {
      this.keepAlive = setInterval(() => {
        if (speechSynthesis.speaking && !speechSynthesis.paused) {
          speechSynthesis.pause();
          speechSynthesis.resume();
        }
      }, 10000);
    }
  }

  async handleChapterEnd() {
    const next = this.chapter + 1;
    if (next >= this.chapterCount) {
      this.emit('finished');
      return;
    }
    if (this.stopAtChapterEnd) {
      this.stopAtChapterEnd = false;
      await this.setChapter(next, 0, false);
      this.emit('sleep');
      return;
    }
    await this.setChapter(next, 0, true);
  }

  async goChapter(i, autoplay = this._playing) {
    if (i < 0 || i >= this.chapterCount) return;
    await this.setChapter(i, 0, autoplay);
  }

  seek(index) {
    const wasPlaying = this._playing;
    this.cancel();
    this.index = clamp(Math.floor(index), 0, Math.max(this.duration - 1, 0));
    this.step = 0;
    this.emit('progress');
    this.emit('speaking');
    if (wasPlaying) {
      this._playing = true;
      this.run();
    } else {
      this.showTranslation();
    }
  }

  /** 倒退：正在唸這段 → 從這段開頭重唸；已經在開頭 → 上一段 */
  back() {
    const midSegment = this._playing && (this.step > 0 || this.speakingLang);
    this.seek(midSegment ? this.index : this.index - 1);
  }

  forward() {
    this.seek(this.index + 1);
  }

  setMode(m) {
    if (!MODES[m]) return;
    this.mode = m;
    if (this.step >= MODES[m].length) this.step = 0;
  }

  setVolume(v) {
    this.volume = v;
  }

  stop() {
    this._playing = false;
    this.cancel();
    this.tr?.flush();
    this.book = null;
    this.en = null;
    this.tr = null;
  }
}

/** 列出某語言的語音，品質好的排前面 */
export function listVoices(lang) {
  if (!ttsSupported()) return [];
  const norm = (v) => v.lang.toLowerCase().replace('_', '-');
  const score = (v) => {
    const l = norm(v);
    let s = 0;
    if (/natural|online|neural/i.test(v.name)) s += 4;
    if (lang === 'zh' && /zh-(tw|hant)/.test(l)) s += 3;
    if (lang === 'zh' && l.startsWith('zh-hk')) s += 1;
    if (lang === 'en' && l === 'en-us') s += 2;
    if (lang === 'en' && l === 'en-gb') s += 1;
    return s;
  };
  return speechSynthesis
    .getVoices()
    .filter((v) => norm(v).startsWith(lang))
    .sort((a, b) => score(b) - score(a) || a.name.localeCompare(b.name));
}
