import * as db from './db.js';
import * as catalog from './catalog.js';
import * as translate from './translate.js';
import * as gemini from './gemini.js';
import * as zht from './zhtitles.js';
import { decodeBuffer, parseBook } from './textbook.js';
import { BilingualPlayer, MODES, listVoices, ttsSupported } from './player.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const player = new BilingualPlayer();
let cur = null; // 目前開啟的書 { book }
let lastSaved = 0;
let sleep = null; // { type: 'time', end, timer } | { type: 'chapter' }
let seeking = false;
let trAvail = 'unsupported';
let trReady = false;
let trAll = null; // 正在翻譯整本 { stop }
let trStatusTimer = null;

const SAVE_EVERY_MS = 5000;
const REWIND_AFTER_MS = 10 * 60 * 1000; // 超過 10 分鐘沒聽，回來時倒退 1 段
const FADE_MS = 30 * 1000;
const SEC_PER_SEGMENT = 0.2; // 估算翻譯時間用（內建翻譯）
const SEC_PER_SEGMENT_GEMINI = 0.25; // Gemini：一次 40 段，請求間隔約 5～10 秒
const EXPORT_FORMAT = 'listen-english-book';

/* ---------------- 小工具 ---------------- */

function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = v;
    else if (k in el) el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  el.append(...kids.flat().filter((c) => c != null && c !== false));
  return el;
}

const uid = () =>
  globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;

function lsGet(key, fallback) {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

function lsSet(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch { /* 無痕模式等情況可忽略 */ }
}

function fmtClock(sec) {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function fmtCount(n) {
  if (n == null) return '';
  return n >= 10000 ? `${(n / 10000).toFixed(1)} 萬` : n.toLocaleString();
}

function toast(msg, ms = 2800) {
  const t = $('#toast');
  ($('dialog[open]') ?? document.body).append(t); // 對話框開著時要放進去才看得到
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), ms);
}

function hashHue(s) {
  let x = 0;
  for (const c of s) x = (x * 31 + c.codePointAt(0)) >>> 0;
  return x % 360;
}

/** 顯示用書名：有中文就用中文 */
function displayTitle(book) {
  return zht.zhInfo(book)?.zh ?? book.title;
}

/** 書名區塊：中文書名（大）＋英文原名（小）；沒有中文就只顯示英文 */
function titleEls(book, zhCls, enCls) {
  const info = zht.zhInfo(book);
  if (!info) return [h('div', { class: zhCls, lang: 'en' }, book.title)];
  return [
    h('div', { class: zhCls }, info.zh,
      info.machine ? h('small', { class: 'mt-tag', title: '對照表沒有這本書，這是機器翻譯的書名' }, '機翻') : null),
    h('div', { class: enCls, lang: 'en' }, book.title),
  ];
}

function coverEl(book, cls = 'cover') {
  const zh = zht.zhInfo(book)?.zh;
  const generated = () =>
    h('div', { class: `${cls} cover-gen${zh ? ' zh' : ''}`, style: `--hue:${hashHue(book.title)}` },
      h('span', {}, zh ?? book.title.split(/\s+/).slice(0, 5).join(' ')));
  if (!book.cover) return generated();
  const img = h('img', { class: cls, src: book.cover, alt: '', loading: 'lazy' });
  img.addEventListener('error', () => img.replaceWith(generated()), { once: true });
  return img;
}

function bookFraction(book, chapter, pos) {
  const total = book.chapters.reduce((a, c) => a + c.count, 0);
  if (!total) return 0;
  let before = 0;
  for (let i = 0; i < chapter; i++) before += book.chapters[i].count;
  return Math.min(1, (before + pos) / total);
}

const requestPersist = () => navigator.storage?.persist?.().catch(() => {});

/* ---------------- 翻譯器 ---------------- */

/** 必須在按鈕 click 裡同步呼叫：第一次要下載翻譯模型，瀏覽器規定要使用者點擊才能開始 */
function prepareTranslator() {
  if (!translate.supported() || trReady) return;
  translate.getTranslator((p) => {
    if (p < 1) toast(`下載翻譯模型 ${Math.round(p * 100)}%（只需要下載一次）`, 4000);
  }).then(() => {
    trReady = true;
    trAvail = 'available';
    [...titleRetries].forEach((f) => f());
    updateTextUI();
    if (cur) player.showTranslation();
  }).catch((e) => toast(`無法啟用翻譯：${e.message}`, 5000));
}

/** 瀏覽器內建翻譯能不能用 */
const edgeOk = () => translate.supported() && trAvail !== 'unavailable';
/** 這台裝置能不能翻譯（Gemini 或內建） */
const canTr = () => gemini.enabled() || edgeOk();

function zhPlaceholder() {
  if (gemini.enabled()) return '翻譯中…';
  if (!edgeOk()) return gemini.disabled() ? `（${gemini.disabled()}）` : '（還沒翻譯。到「翻譯設定」貼上免費的 Gemini 金鑰，就能在這台裝置翻譯）';
  if (!trReady && trAvail !== 'available') return '（按 ▶ 播放後會自動翻譯）';
  return '翻譯中…';
}

/* ---------------- 書架 ---------------- */

async function renderLibrary() {
  const [books, progress] = await Promise.all([db.getAll('books'), db.getAll('progress')]);
  const prog = new Map(progress.map((p) => [p.bookId, p]));
  const lastTouched = (b) => prog.get(b.id)?.updatedAt ?? b.addedAt ?? 0;
  books.sort((a, b) => lastTouched(b) - lastTouched(a));

  $('#book-grid').replaceChildren(...books.map((b) => bookCard(b, prog.get(b.id))));
  $('#empty-hint').hidden = books.length > 0;
  fillMachineTitles(books);

  const recent = books.find((b) => prog.has(b.id));
  const rc = $('#resume-card');
  rc.hidden = !recent;
  if (recent) {
    const p = prog.get(recent.id);
    rc.replaceChildren(
      coverEl(recent, 'resume-cover'),
      h('div', { class: 'resume-info' },
        h('small', {}, '繼續上次'),
        h('strong', {}, displayTitle(recent)),
        h('span', { class: 'muted' }, `${recent.chapters[p.chapter]?.title ?? ''} · 第 ${p.pos + 1} 段`)),
      h('button', { class: 'round big', title: '繼續播放', 'aria-label': '繼續播放', onclick: () => { prepareTranslator(); openBook(recent, { autoplay: true }); } }, '▶'),
    );
  }
}

/** 對照表沒有的書：用內建翻譯翻書名，存進書本資料（匯出時一起帶走） */
let fillingTitles = false;
async function fillMachineTitles(books) {
  if (fillingTitles) return;
  const todo = books.filter((b) => !zht.zhInfo(b));
  if (!todo.length) return;
  fillingTitles = true;
  let changed = false;
  try {
    for (const b of todo) {
      const zh = await zht.machineTitle(b.title);
      if (!zh) break; // 翻譯器還不能用，下次再試
      await db.put('books', { ...b, zhTitle: zh, zhTitleMachine: true });
      if (cur?.book.id === b.id) Object.assign(cur.book, { zhTitle: zh, zhTitleMachine: true });
      changed = true;
    }
  } finally {
    fillingTitles = false;
  }
  if (changed) renderLibrary();
}

function bookCard(book, p) {
  const pct = Math.round((p?.fraction ?? 0) * 100);
  return h('button', { class: 'book-card', onclick: () => openBook(book) },
    coverEl(book),
    ...titleEls(book, 'book-title', 'book-en'),
    h('div', { class: 'book-author' }, book.author || ' '),
    h('div', { class: 'book-foot' },
      h('span', { class: 'badge' }, `${book.chapters.length} 章`),
      h('span', { class: 'muted' }, p ? `${pct}%` : '未開始')),
    h('div', { class: 'bar' }, h('span', { style: `width:${pct}%` })),
  );
}

function renderBanner() {
  const b = $('#tr-banner');
  const noTr = !canTr();
  const noTts = !ttsSupported();
  b.hidden = !noTr && !noTts;
  b.classList.toggle('clickable', noTr && !noTts);
  b.onclick = noTr && !noTts ? openSettings : null;
  if (noTts) b.textContent = '這個瀏覽器不支援語音朗讀，請改用 Edge、Chrome 或 Safari。';
  else if (noTr) {
    b.textContent = gemini.disabled()
      ? `${gemini.disabled()}。這段期間只能聽已經翻好的部分。（點這裡開啟翻譯設定）`
      : '這台裝置還不能翻譯。點這裡到「⚙ 翻譯設定」貼上免費的 Gemini 金鑰，就能直接在這台裝置邊聽邊翻。';
  }
}

/* ---------------- 翻譯設定（Gemini 金鑰） ---------------- */

function openSettings() {
  const dlg = $('#dlg-settings');
  $('#gm-key').value = gemini.getKey();
  $('#gm-key').type = 'password';
  $('#gm-show').checked = false;
  const sel = $('#gm-model');
  const model = gemini.getModel();
  const opts = gemini.MODELS.some(([id]) => id === model) ? gemini.MODELS : [...gemini.MODELS, [model, model]];
  sel.replaceChildren(...opts.map(([id, label]) => h('option', { value: id, selected: id === model }, label)));
  setGmStatus(gemini.configured()
    ? (gemini.disabled() ? `目前暫停使用：${gemini.disabled()}` : '已設定金鑰，翻譯會使用 Gemini。')
    : (edgeOk() ? '還沒設定金鑰，目前使用瀏覽器內建翻譯。' : '還沒設定金鑰，這台裝置目前不能翻譯。'),
  gemini.disabled() ? 'err' : '');
  dlg.showModal();
}

function setGmStatus(text, cls = '') {
  const el = $('#gm-status');
  el.textContent = text;
  el.className = `note gm-status ${cls}`;
}

function bindSettings() {
  const dlg = $('#dlg-settings');
  $('#btn-settings').onclick = openSettings;
  $('#btn-tr-settings').onclick = openSettings;
  $$('[data-close]', dlg).forEach((b) => { b.onclick = () => dlg.close(); });
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
  $('#gm-show').onchange = (e) => { $('#gm-key').type = e.target.checked ? 'text' : 'password'; };
  $('#gm-save').onclick = async () => {
    const key = $('#gm-key').value.trim();
    const model = $('#gm-model').value;
    if (!key) return setGmStatus('請先貼上金鑰', 'err');
    const btn = $('#gm-save');
    btn.disabled = true;
    setGmStatus('測試中…（翻譯一句試試看）');
    try {
      const zh = await gemini.test(key, model);
      gemini.save(key, model);
      setGmStatus(`成功！已儲存。試譯：${translate.fixPunct(zh)}`, 'ok');
      afterSettingsChange();
    } catch (e) {
      setGmStatus(`沒有成功：${e.message}`, 'err');
    } finally {
      btn.disabled = false;
    }
  };
  $('#gm-clear').onclick = () => {
    if (gemini.configured() && !confirm('確定要清除這台裝置上的 Gemini 金鑰嗎？')) return;
    gemini.save('', '');
    $('#gm-key').value = '';
    setGmStatus(edgeOk() ? '已清除。改用瀏覽器內建翻譯。' : '已清除。這台裝置目前不能翻譯。');
    afterSettingsChange();
  };
  gemini.setNotifier((msg) => {
    toast(`${msg}${edgeOk() ? '，先改用瀏覽器內建翻譯' : ''}`, 7000);
    afterSettingsChange();
  });
}

function afterSettingsChange() {
  renderBanner();
  if (!cur) return;
  updateTextUI();
  updateTrStatus();
  player.showTranslation();
}

/* ---------------- 開書 / 存進度 ---------------- */

async function openBook(book, { autoplay = false } = {}) {
  if (cur?.book.id === book.id) {
    showView('player');
    if (autoplay && !player.playing) player.play();
    return;
  }
  if (!ttsSupported()) {
    toast('這個瀏覽器不支援語音朗讀');
    return;
  }
  await closeCurrent();

  const saved = await db.get('progress', book.id);
  let chapter = saved?.chapter ?? 0;
  let pos = saved?.pos ?? 0;
  if (chapter >= book.chapters.length) chapter = pos = 0;
  if (saved && Date.now() - saved.updatedAt > REWIND_AFTER_MS) pos = Math.max(0, pos - 1);

  cur = { book };
  applySettings();
  try {
    await player.load(book, chapter, pos, onTranslated);
  } catch (e) {
    cur = null;
    toast(e.message || '無法開啟這本書');
    return;
  }
  setupPlayerView();
  showView('player');
  if (autoplay) player.play();
}

async function closeCurrent() {
  if (!cur) return;
  await saveProgress();
  clearSleep();
  if (trAll) trAll.stop = true;
  cur = null; // 先清掉，避免 stop() 觸發的事件把進度存錯
  player.stop();
}

async function saveProgress() {
  if (!cur || !player.book) return;
  const { book } = cur;
  const { chapter, pos } = player.position;
  lastSaved = Date.now();
  try {
    await db.put('progress', { bookId: book.id, chapter, pos, fraction: bookFraction(book, chapter, pos), updatedAt: Date.now() });
  } catch (e) {
    console.warn('儲存進度失敗', e);
  }
}

function onTranslated() {
  updateTextUI();
  scheduleTrStatus();
}

/* ---------------- 播放器畫面 ---------------- */

function setupPlayerView() {
  const { book } = cur;
  $('#p-cover').replaceChildren(coverEl(book, 'mid-cover'));
  const zh = zht.zhInfo(book)?.zh;
  $('#p-title').textContent = zh ?? book.title;
  $('#p-title').lang = zh ? 'zh-Hant' : 'en';
  $('#p-title-en').textContent = zh ? book.title : '';
  $('#p-title-en').hidden = !zh;
  $('#p-author').textContent = book.author || '';
  $('#p-license').replaceChildren(
    `來源／授權：${book.license || ''}`,
    book.sourceUrl ? h('a', { href: book.sourceUrl, target: '_blank', rel: 'noopener' }, '　原始頁面') : '',
  );
  fillVoices();
  renderChapters();
  renderBookmarks();
  updateChapterUI();
  updateProgressUI();
  updateStateUI();
  updateTrStatus();
}

function renderChapters() {
  const { book } = cur;
  $('#ch-list').replaceChildren(
    ...book.chapters.map((c, i) =>
      h('li', {},
        h('button', { class: 'list-btn', onclick: () => { prepareTranslator(); player.setChapter(i, 0, true); } },
          h('span', { lang: 'en' }, c.title),
          h('small', { class: 'muted' }, `${c.count} 段`)))),
  );
}

async function renderBookmarks() {
  if (!cur) return;
  const { book } = cur;
  const list = (await db.getByIndex('bookmarks', 'bookId', book.id)).sort((a, b) => a.chapter - b.chapter || a.pos - b.pos);
  if (cur?.book.id !== book.id) return;
  $('#bm-count').textContent = list.length ? `(${list.length})` : '';
  $('#bm-list').replaceChildren(
    ...(list.length
      ? list.map((bm) =>
        h('li', {},
          h('button', { class: 'list-btn', onclick: () => jumpTo(bm.chapter, bm.pos) },
            h('span', { class: 'bm-en', lang: 'en' }, bm.en),
            bm.zh ? h('small', { class: 'snippet' }, bm.zh) : null,
            h('small', { class: 'muted' }, [bm.note, `${book.chapters[bm.chapter]?.title ?? ''} · 第 ${bm.pos + 1} 段`].filter(Boolean).join('　'))),
          h('button', {
            class: 'icon-btn', title: '刪除', 'aria-label': '刪除收藏',
            onclick: async () => {
              await db.del('bookmarks', bm.id);
              renderBookmarks();
            },
          }, '✕')))
      : [h('li', { class: 'muted empty-li' }, '還沒有收藏。聽到喜歡或想複習的句子，按「⭐ 收藏這一段」。')]),
  );
}

async function jumpTo(chapter, pos) {
  prepareTranslator();
  if (player.chapter === chapter) {
    player.seek(pos);
    if (!player.playing) player.play();
  } else {
    await player.setChapter(chapter, pos, true);
  }
}

function updateChapterUI() {
  if (!cur) return;
  $('#p-chapter').textContent = `${player.chapter + 1} / ${cur.book.chapters.length}　${player.chapterTitle}`;
  $$('#ch-list li').forEach((li, i) => li.classList.toggle('active', i === player.chapter));
  updateMediaMeta();
  updateMini();
  scheduleTrStatus();
}

function updateTextUI() {
  if (!cur) return;
  const zh = player.currentZh;
  const en = $('#t-en');
  const zhEl = $('#t-zh');
  en.textContent = player.currentEn || '（本章已讀完）';
  zhEl.textContent = zh ?? zhPlaceholder();
  zhEl.classList.toggle('pending', zh == null);
  zhEl.hidden = !$('#o-show-zh').checked;
  en.classList.toggle('speaking', player.speakingLang === 'en');
  zhEl.classList.toggle('speaking', player.speakingLang === 'zh');
}

function updateProgressUI() {
  if (!cur) return;
  const dur = player.duration;
  const seek = $('#p-seek');
  if (!seeking) {
    seek.max = Math.max(dur - 1, 0);
    seek.value = player.pos;
    $('#p-cur').textContent = `第 ${Math.min(player.pos + 1, dur)} 段`;
  }
  $('#p-dur').textContent = `共 ${dur} 段`;
  updateTextUI();
}

function updateStateUI() {
  const playing = !!cur && player.playing;
  $('#c-play').textContent = playing ? '⏸' : '▶';
  $('#mini-play').textContent = playing ? '⏸' : '▶';
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = cur ? (playing ? 'playing' : 'paused') : 'none';
}

function updateMini() {
  const show = !!cur && $('#view-player').hidden;
  $('#mini').hidden = !show;
  document.body.classList.toggle('has-mini', show);
  if (cur) {
    $('#mini-title').textContent = displayTitle(cur.book);
    $('#mini-sub').textContent = player.chapterTitle;
  }
}

function showView(view, push = true) {
  $('#view-library').hidden = view !== 'library';
  $('#view-player').hidden = view !== 'player';
  if (view === 'player' && push && history.state?.view !== 'player') history.pushState({ view: 'player' }, '');
  if (view === 'library') renderLibrary();
  window.scrollTo(0, 0);
  updateMini();
}

/* ---------------- 翻譯進度 ---------------- */

function scheduleTrStatus() {
  clearTimeout(trStatusTimer);
  trStatusTimer = setTimeout(updateTrStatus, 800);
}

async function updateTrStatus() {
  if (!cur || !player.tr || trAll) return;
  const tr = player.tr;
  const [c, all] = await Promise.all([tr.stats(player.chapter), tr.stats()]);
  if (player.tr !== tr || trAll) return;
  const pct = all.total ? Math.floor((all.done / all.total) * 100) : 0;
  const engine = gemini.enabled() ? 'Gemini' : edgeOk() ? '內建翻譯' : '';
  $('#tr-status').textContent = `已翻譯：本章 ${c.done}/${c.total} 段 · 全書 ${pct}%${engine ? `（${engine}）` : ''}`;
  const btn = $('#btn-tr-all');
  btn.hidden = !canTr() || all.done >= all.total;
  const sec = gemini.enabled() ? SEC_PER_SEGMENT_GEMINI : SEC_PER_SEGMENT;
  btn.textContent = `翻譯整本（約 ${Math.max(1, Math.ceil(((all.total - all.done) * sec) / 60))} 分鐘）`;
}

async function translateWholeBook() {
  if (trAll) {
    trAll.stop = true;
    // 正在送出的那一批翻完才會停（Gemini 可能要等幾秒）
    $('#btn-tr-all').textContent = '停止中…';
    $('#btn-tr-all').disabled = true;
    return;
  }
  if (!cur || !player.tr) return;
  prepareTranslator(); // 在 click 裡同步呼叫
  const job = (trAll = { stop: false });
  const tr = player.tr;
  const bar = $('#tr-bar');
  const btn = $('#btn-tr-all');
  bar.hidden = false;
  btn.textContent = '停止翻譯';
  const t0 = Date.now();
  let startDone = null;
  try {
    const finished = await tr.translateAll(
      (done, total) => {
        if (player.tr !== tr) return;
        startDone ??= done;
        bar.firstElementChild.style.width = `${(done / total) * 100}%`;
        const rate = (done - startDone) / Math.max(1, (Date.now() - t0) / 1000);
        const left = rate > 0 ? Math.ceil((total - done) / rate / 60) : '?';
        $('#tr-status').textContent = `翻譯整本中… ${done}/${total} 段（${Math.floor((done / total) * 100)}%，約剩 ${left} 分鐘）`;
      },
      () => job.stop || player.tr !== tr,
    );
    if (finished) toast('整本翻譯完成 🎉 現在可以離線聽了', 5000);
  } catch (e) {
    toast(`翻譯中斷：${e.message}`, 5000);
  } finally {
    trAll = null;
    bar.hidden = true;
    btn.disabled = false;
    updateTrStatus();
  }
}

/* ---------------- 聲音 ---------------- */

function fillVoices() {
  for (const lang of ['en', 'zh']) {
    const sel = $(`#o-voice-${lang}`);
    const voices = listVoices(lang);
    if (!voices.length) {
      sel.replaceChildren(h('option', { value: '' }, '系統預設'));
      player.voice[lang] = null;
      continue;
    }
    sel.replaceChildren(...voices.map((v) => h('option', { value: v.voiceURI }, `${v.name}（${v.lang}）`)));
    const chosen = voices.find((v) => v.voiceURI === lsGet(`voice:${lang}`, '')) ?? voices[0];
    sel.value = chosen.voiceURI;
    player.voice[lang] = chosen;
  }
}

function applySettings() {
  player.setMode($('#o-mode').value);
  player.rate.en = parseFloat($('#o-rate-en').value) || 0.9;
  player.rate.zh = parseFloat($('#o-rate-zh').value) || 1.1;
  player.setVolume(1);
}

/* ---------------- 睡眠定時 ---------------- */

function setSleep(value) {
  clearSleep();
  if (value === 'off') return;
  if (value === 'chapter') {
    sleep = { type: 'chapter' };
    player.stopAtChapterEnd = true;
  } else {
    sleep = { type: 'time', end: Date.now() + Number(value) * 60000, timer: setInterval(checkSleep, 1000) };
  }
  $('#o-sleep').value = value;
  renderSleep();
}

function clearSleep() {
  if (sleep?.timer) clearInterval(sleep.timer);
  sleep = null;
  player.stopAtChapterEnd = false;
  player.setVolume(1);
  $('#o-sleep').value = 'off';
  renderSleep();
}

function checkSleep() {
  if (sleep?.type !== 'time' || !cur) return;
  const left = sleep.end - Date.now();
  if (left <= 0) {
    sleepDone();
    return;
  }
  if (left < FADE_MS) player.setVolume(Math.max(0.1, left / FADE_MS));
  renderSleep();
}

function sleepDone() {
  if (player.playing) player.pause();
  clearSleep();
  toast('晚安 🌙 已自動停止播放', 5000);
}

function renderSleep() {
  const el = $('#sleep-left');
  if (!sleep) el.textContent = '';
  else if (sleep.type === 'chapter') el.textContent = '本章結束後停止';
  else el.textContent = `剩 ${fmtClock((sleep.end - Date.now()) / 1000)}`;
}

/* ---------------- 收藏 ---------------- */

async function addBookmark() {
  if (!cur) return;
  const { book } = cur;
  const { chapter, pos } = player.position;
  const en = player.currentEn;
  const zh = player.currentZh;
  const dlg = $('#dlg-bm');
  $('#bm-preview').textContent = en;
  $('#bm-note').value = '';
  dlg.returnValue = '';
  dlg.showModal();
  const ok = await new Promise((resolve) => dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok'), { once: true }));
  if (!ok || cur?.book.id !== book.id) return;
  await db.put('bookmarks', {
    id: uid(), bookId: book.id, chapter, pos, en,
    zh: zh ?? player.tr?.peek(chapter, pos) ?? '',
    note: $('#bm-note').value.trim(), createdAt: Date.now(),
  });
  $('#bm-list').closest('details').open = true;
  renderBookmarks();
  toast('已收藏 ⭐');
}

/* ---------------- 匯出 / 匯入（帶到手機） ---------------- */

async function exportBook() {
  if (!cur || !player.tr) return;
  const { book } = cur;
  await player.tr.flush();
  const [blobs, bookmarks, progress, stats] = await Promise.all([
    db.getBlobsOf(book.id), db.getByIndex('bookmarks', 'bookId', book.id), db.get('progress', book.id), player.tr.stats(),
  ]);
  const data = { format: EXPORT_FORMAT, version: 1, exportedAt: Date.now(), book, blobs, bookmarks, progress: progress ?? null };
  const url = URL.createObjectURL(new Blob([JSON.stringify(data)], { type: 'application/json' }));
  const a = h('a', { href: url, download: `${[zht.zhInfo(book)?.zh, book.title].filter(Boolean).join(' ').replace(/[\\/:*?"<>|]+/g, ' ').trim().slice(0, 80)}.json` });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  const pct = stats.total ? Math.floor((stats.done / stats.total) * 100) : 0;
  toast(pct < 100 ? `已匯出（目前只翻譯了 ${pct}%，建議先「翻譯整本」再匯出）` : '已匯出，把檔案傳到手機後用「匯入檔案」加入', 5000);
}

async function importJson(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('檔案格式不正確');
  }
  if (data?.format !== EXPORT_FORMAT || !data.book?.id || !Array.isArray(data.blobs)) throw new Error('這不是「聽書學英文」匯出的檔案');
  const { book } = data;
  const existing = await db.get('books', book.id);
  if (existing && !confirm(`書架上已經有「${displayTitle(book)}」，要用匯入的版本取代嗎？`)) return null;
  if (cur?.book.id === book.id) await closeCurrent();
  await db.addBook(book, data.blobs.filter(([k]) => typeof k === 'string' && k.startsWith(`${book.id}:`)));
  for (const bm of data.bookmarks ?? []) if (bm.bookId === book.id) await db.put('bookmarks', bm);
  const localProgress = await db.get('progress', book.id);
  if (data.progress?.bookId === book.id && (!localProgress || data.progress.updatedAt > localProgress.updatedAt)) {
    await db.put('progress', data.progress);
  }
  return book;
}

async function importTxt(buf, title, author) {
  const { chapters } = parseBook(decodeBuffer(buf));
  if (!chapters.length) throw new Error('檔案裡沒有可朗讀的英文內容');
  const id = `txt-${uid()}`;
  const book = {
    id, source: 'import', title, author, addedAt: Date.now(),
    license: '使用者匯入的文字（匯入時已確認為公有領域或有權使用）',
    chapters: chapters.map((c) => ({ title: c.title, count: c.segments.length })),
  };
  await db.addBook(book, [[`${id}:en`, chapters.map((c) => c.segments)]]);
  return book;
}

/* ---------------- 加入書本對話框 ---------------- */

const lists = {
  popular: { page: 1, loading: false },
  search: { page: 1, loading: false, q: '' },
};

async function loadList(kind, reset) {
  const st = lists[kind];
  if (st.loading) return;
  const box = $(kind === 'popular' ? '#pop-results' : '#search-results');
  const more = $(kind === 'popular' ? '#pop-more' : '#search-more');
  if (reset) {
    st.page = 1;
    if (kind === 'search') st.q = $('#search-q').value;
    box.replaceChildren(h('p', { class: 'muted' }, '載入中…'));
    more.hidden = true;
  }
  st.loading = true;
  try {
    const [res, books] = await Promise.all([
      kind === 'popular' ? catalog.popular(st.page)
        : zht.hasCjk(st.q) ? { hasMore: false, zh: true, items: zht.searchZh(st.q).map((it) => ({ ...it, cover: catalog.gutenbergCover(it.gutenbergId) })) }
        : catalog.search(st.q, st.page),
      db.getAll('books'),
    ]);
    const have = new Set(books.map((b) => b.id));
    if (reset) {
      box.replaceChildren();
      if (res.fallback) box.append(h('p', { class: 'muted' }, '熱門排行暫時連不上，先顯示精選經典。'));
      if (!res.items.length) {
        box.append(h('p', { class: 'muted' }, res.zh
          ? '中文只能搜尋常見經典的書名和作者。找不到的話，請改用英文書名或作者搜尋。'
          : '找不到符合的書，試試其他關鍵字。'));
      }
    }
    box.append(...res.items.map((item) => catalogItem(item, have.has(catalog.bookIdFor(item.gutenbergId, item.iaId)))));
    st.page++;
    more.hidden = !res.hasMore;
  } catch (e) {
    if (reset) box.replaceChildren(h('p', { class: 'muted' }, `${e.message}`));
    else toast(e.message);
  } finally {
    st.loading = false;
  }
}

/** 書名還沒翻好的目錄項目，等翻譯模型下載好再補 */
const titleRetries = new Set();

/** 加入書本時一起存的中文書名 */
function zhFields(item) {
  const info = zht.zhInfo(item);
  return info ? { zhTitle: info.zh, zhTitleMachine: info.machine } : {};
}

function catalogItem(item, added) {
  const btn = h('button', { class: `btn small${added ? '' : ' primary'}`, disabled: added }, added ? '已在書架' : '加入');
  btn.onclick = async () => {
    btn.disabled = true;
    btn.textContent = '下載中…';
    try {
      const id = catalog.bookIdFor(item.gutenbergId, item.iaId);
      const { text, iaId, creator } = await catalog.fetchFullText(item);
      btn.textContent = '整理中…';
      const { chapters } = parseBook(text);
      if (!chapters.length) throw new Error('這本書解析不到內容');
      const book = {
        id, source: 'gutenberg', gutenbergId: item.gutenbergId, iaId,
        title: item.title, author: item.authorIsZh ? creator || item.author : item.author, cover: item.cover, addedAt: Date.now(),
        ...zhFields(item),
        sourceUrl: item.gutenbergId ? `https://www.gutenberg.org/ebooks/${item.gutenbergId}` : `https://archive.org/details/${iaId}`,
        license: '公有領域（Project Gutenberg）',
        chapters: chapters.map((c) => ({ title: c.title, count: c.segments.length })),
      };
      await db.addBook(book, [[`${id}:en`, chapters.map((c) => c.segments)]]);
      requestPersist();
      btn.textContent = '已加入 ✓';
      btn.classList.remove('primary');
      toast(`已加入「${displayTitle(book)}」，共 ${book.chapters.length} 章`);
      renderLibrary();
    } catch (e) {
      if (e.code === 'NOT_FOUND' && item.gutenbergId) {
        btn.replaceWith(h('a', { class: 'btn small', href: `https://www.gutenberg.org/ebooks/${item.gutenbergId}`, target: '_blank', rel: 'noopener' }, '手動下載'));
        toast('這本書要手動下載：在 Gutenberg 頁面選「Plain Text UTF-8」，再用「匯入檔案」加入', 7000);
      } else {
        btn.disabled = false;
        btn.textContent = '加入';
        toast(e.message || '加入失敗');
      }
    }
  };
  const thumb = coverEl(item, 'lv-thumb');
  const titles = h('div', { class: 'lv-titles' }, ...titleEls(item, 'lv-zh', 'lv-en'));
  if (!zht.zhInfo(item)) {
    // 對照表沒有：翻譯器可用的話翻書名；還不能用就等翻譯模型下載好再補
    const fill = () => {
      titleRetries.delete(fill);
      zht.machineTitle(item.title).then((zh) => {
        if (zh) titles.replaceChildren(...titleEls(item, 'lv-zh', 'lv-en'));
        else if (titles.isConnected) titleRetries.add(fill);
      });
    };
    fill();
  }
  return h('div', { class: 'lv-item' },
    thumb,
    h('div', { class: 'lv-info' },
      titles,
      h('span', { class: 'muted' }, item.author || ''),
      item.downloads ? h('small', { class: 'muted' }, `近期下載 ${fmtCount(item.downloads)} 次`) : null),
    btn,
  );
}

function bindAddDialog() {
  const dlg = $('#dlg-add');
  $('#btn-add').onclick = () => {
    dlg.showModal();
    if (!$('#pop-results').childElementCount) loadList('popular', true);
  };
  $$('[data-close]', dlg).forEach((b) => { b.onclick = () => dlg.close(); });
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
  $$('.tab', dlg).forEach((tab) => {
    tab.onclick = () => {
      $$('.tab', dlg).forEach((t) => t.classList.toggle('active', t === tab));
      $$('.tab-panel', dlg).forEach((p) => { p.hidden = p.dataset.panel !== tab.dataset.tab; });
      if (tab.dataset.tab === 'search') $('#search-q').focus();
    };
  });

  $('#pop-more').onclick = () => loadList('popular', false);
  $('#search-form').onsubmit = (e) => {
    e.preventDefault();
    loadList('search', true);
  };
  $('#search-more').onclick = () => loadList('search', false);

  $('#import-file').onchange = (e) => {
    const f = e.target.files[0];
    $('#import-picked').textContent = f ? `${f.name}（${Math.max(1, Math.round(f.size / 1024))} KB）` : '';
    const isJson = f && /\.json$/i.test(f.name);
    $('#import-title').hidden = $('#import-author').hidden = isJson;
    $('#import-legal').closest('label').hidden = isJson;
    if (f && !isJson && !$('#import-title').value) $('#import-title').value = f.name.replace(/\.[^.]+$/, '');
  };

  $('#import-form').onsubmit = async (e) => {
    e.preventDefault();
    const form = e.target;
    const file = $('#import-file').files[0];
    if (!file) return toast('請先選擇檔案');
    const isJson = /\.json$/i.test(file.name);
    if (!isJson) {
      if (!$('#import-title').value.trim()) return toast('請填書名');
      if (!$('#import-legal').checked) return toast('請先確認這份文字可以合法使用');
    }
    const btn = form.querySelector('button');
    btn.disabled = true;
    btn.textContent = '處理中…';
    try {
      const book = isJson
        ? await importJson(await file.text())
        : await importTxt(await file.arrayBuffer(), $('#import-title').value.trim(), $('#import-author').value.trim());
      if (!book) return;
      requestPersist();
      form.reset();
      $('#import-picked').textContent = '';
      $('#import-title').hidden = $('#import-author').hidden = false;
      $('#import-legal').closest('label').hidden = false;
      dlg.close();
      toast(`已加入「${displayTitle(book)}」`);
      renderLibrary();
    } catch (err) {
      toast(`匯入失敗：${err.message}`, 5000);
    } finally {
      btn.disabled = false;
      btn.textContent = '加入書架';
    }
  };
}

/* ---------------- 系統媒體控制（鎖定畫面、耳機按鍵） ---------------- */

function updateMediaMeta() {
  if (!('mediaSession' in navigator) || !cur) return;
  const { book } = cur;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: player.chapterTitle || book.title,
      artist: book.author || '',
      album: displayTitle(book),
      artwork: [{ src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' }],
    });
  } catch { /* 部分瀏覽器不支援 */ }
}

function setupMediaSession() {
  if (!('mediaSession' in navigator)) return;
  const set = (action, fn) => {
    try {
      navigator.mediaSession.setActionHandler(action, fn);
    } catch { /* 不支援的動作 */ }
  };
  set('play', () => cur && player.play());
  set('pause', () => cur && player.pause());
  set('previoustrack', () => cur && player.back());
  set('nexttrack', () => cur && player.forward());
  set('seekbackward', () => cur && player.back());
  set('seekforward', () => cur && player.forward());
}

/* ---------------- 控制 ---------------- */

function togglePlay() {
  if (!cur) return;
  if (player.playing) player.pause();
  else {
    prepareTranslator();
    player.play();
  }
}

function bindPlayer() {
  player.addEventListener('progress', () => {
    if (!cur) return;
    updateProgressUI();
    checkSleep();
    if (player.playing && Date.now() - lastSaved > SAVE_EVERY_MS) saveProgress();
  });
  player.addEventListener('speaking', () => cur && updateTextUI());
  player.addEventListener('state', () => {
    if (!cur) return;
    updateStateUI();
    if (!player.playing) saveProgress();
  });
  player.addEventListener('chapter', () => {
    if (!cur) return;
    updateChapterUI();
    saveProgress();
  });
  player.addEventListener('finished', () => {
    if (!cur) return;
    updateStateUI();
    saveProgress();
    toast('全書讀完了 🎉');
  });
  player.addEventListener('sleep', () => cur && sleepDone());
  player.addEventListener('error', (e) => cur && toast(e.detail, 4000));
}

function bindControls() {
  $('#c-play').onclick = togglePlay;
  $('#mini-play').onclick = togglePlay;
  $('#mini-open').onclick = () => cur && showView('player');
  $('#c-back').onclick = () => cur && player.back();
  $('#c-fwd').onclick = () => cur && player.forward();
  $('#c-prev').onclick = () => cur && player.goChapter(player.chapter - 1);
  $('#c-next').onclick = () => cur && player.goChapter(player.chapter + 1);
  $('#btn-bookmark').onclick = addBookmark;
  $('#btn-tr-all').onclick = translateWholeBook;
  $('#btn-export').onclick = exportBook;
  $('#btn-back').onclick = () => (history.state?.view === 'player' ? history.back() : showView('library'));
  window.addEventListener('popstate', () => showView(history.state?.view === 'player' && cur ? 'player' : 'library', false));

  const seek = $('#p-seek');
  seek.addEventListener('input', () => {
    seeking = true;
    $('#p-cur').textContent = `第 ${Number(seek.value) + 1} 段`;
  });
  seek.addEventListener('change', () => {
    seeking = false;
    if (cur) player.seek(Number(seek.value));
  });

  // 設定（記在這台裝置）
  const bindSetting = (sel, key, fallback, apply) => {
    const el = $(sel);
    const saved = lsGet(key, fallback);
    if (el.type === 'checkbox') el.checked = saved === '1';
    else {
      el.value = saved;
      if (!el.value) el.value = fallback;
    }
    el.onchange = () => {
      lsSet(key, el.type === 'checkbox' ? (el.checked ? '1' : '0') : el.value);
      apply();
    };
  };
  bindSetting('#o-mode', 'mode', 'en-zh', () => player.setMode($('#o-mode').value));
  bindSetting('#o-rate-en', 'rateEn', '0.9', () => { player.rate.en = parseFloat($('#o-rate-en').value); });
  bindSetting('#o-rate-zh', 'rateZh', '1.1', () => { player.rate.zh = parseFloat($('#o-rate-zh').value); });
  bindSetting('#o-show-zh', 'showZh', '1', updateTextUI);
  if (!MODES[$('#o-mode').value]) $('#o-mode').value = 'en-zh';

  $('#o-sleep').onchange = (e) => setSleep(e.target.value);

  for (const lang of ['en', 'zh']) {
    $(`#o-voice-${lang}`).onchange = (e) => {
      const v = listVoices(lang).find((x) => x.voiceURI === e.target.value) ?? null;
      player.voice[lang] = v;
      lsSet(`voice:${lang}`, e.target.value);
      if (player.playing) player.seek(player.index); // 用新聲音重唸這段
    };
  }
  if (ttsSupported()) speechSynthesis.addEventListener('voiceschanged', () => cur && fillVoices());

  $('#btn-delete').onclick = async () => {
    if (!cur) return;
    const { book } = cur;
    if (!confirm(`確定要刪除「${displayTitle(book)}」嗎？\n進度、收藏和已翻譯的中文都會一起刪除。`)) return;
    await closeCurrent();
    await db.deleteBook(book.id);
    toast('已刪除');
    if (history.state?.view === 'player') history.back();
    else showView('library');
  };

  document.addEventListener('keydown', (e) => {
    if (!cur || $('#view-player').hidden || e.target.closest('input, select, textarea, button, dialog')) return;
    if (e.code === 'Space') {
      e.preventDefault();
      togglePlay();
    } else if (e.code === 'ArrowLeft') player.back();
    else if (e.code === 'ArrowRight') player.forward();
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      saveProgress();
      player.tr?.flush();
    }
  });
  window.addEventListener('pagehide', () => {
    saveProgress();
    player.tr?.flush();
  });
}

/* ---------------- 啟動 ---------------- */

bindPlayer();
bindControls();
bindAddDialog();
bindSettings();
setupMediaSession();
history.replaceState({ view: 'library' }, '');
renderLibrary();
translate.availability().then((a) => {
  trAvail = a;
  renderBanner();
});

if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
