// 書目來源（都是美國公有領域的 Project Gutenberg 書）
//   熱門書單：Gutendex（Gutenberg 的書目 API，依真實下載量排序）
//   關鍵字搜尋：Internet Archive 收藏的 Gutenberg 書（Gutendex 的搜尋太慢）
//   全文下載：Internet Archive（允許網頁直接讀取；gutenberg.org 本身不允許）

import { cleanTitle } from './zhtitles.js';

const IA = 'https://archive.org';
const GUTENDEX = 'https://gutendex.com';

async function getJson(url, timeoutMs = 25000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (e) {
    throw new Error(e.name === 'AbortError' ? '連線逾時，請稍後再試' : `連線失敗（${e.message}）`);
  } finally {
    clearTimeout(timer);
  }
}

/** "Austen, Jane, 1775-1817" → "Jane Austen" */
function cleanAuthor(name) {
  const s = String(name).replace(/,?\s*\d{3,4}\??\s*-\s*\d{0,4}\??\s*$/, '').replace(/\s*\(.*?\)\s*/g, ' ').trim()
    .replace(/,\s*(?:sir|graf|baron|jr\.?|sr\.?)$/i, '');
  const m = s.match(/^([^,]+),\s*([^,]+)$/);
  if (m && /\b(?:of|active)\b/i.test(m[2])) return m[1]; // "Marcus Aurelius, Emperor of Rome"
  return m ? `${m[2]} ${m[1]}` : s;
}

export const bookIdFor = (gutenbergId, iaId) => (gutenbergId ? `gb-${gutenbergId}` : `ia-${iaId}`);
export const gutenbergCover = (id) => `https://www.gutenberg.org/cache/epub/${id}/pg${id}.cover.medium.jpg`;

// Gutendex 是志工維護的服務，偶爾很慢或掛掉；這時改用內建的經典書單
const FALLBACK = [
  [1342, 'Pride and Prejudice', 'Jane Austen'], [84, 'Frankenstein', 'Mary Shelley'],
  [11, "Alice's Adventures in Wonderland", 'Lewis Carroll'], [1661, 'The Adventures of Sherlock Holmes', 'Arthur Conan Doyle'],
  [2701, 'Moby Dick', 'Herman Melville'], [345, 'Dracula', 'Bram Stoker'], [1513, 'Romeo and Juliet', 'William Shakespeare'],
  [43, 'The Strange Case of Dr. Jekyll and Mr. Hyde', 'Robert Louis Stevenson'], [46, 'A Christmas Carol', 'Charles Dickens'],
  [174, 'The Picture of Dorian Gray', 'Oscar Wilde'], [98, 'A Tale of Two Cities', 'Charles Dickens'],
  [1260, 'Jane Eyre', 'Charlotte Brontë'], [768, 'Wuthering Heights', 'Emily Brontë'], [74, 'The Adventures of Tom Sawyer', 'Mark Twain'],
  [76, 'Adventures of Huckleberry Finn', 'Mark Twain'], [1400, 'Great Expectations', 'Charles Dickens'],
  [16, 'Peter Pan', 'J. M. Barrie'], [113, 'The Secret Garden', 'Frances Hodgson Burnett'], [514, 'Little Women', 'Louisa May Alcott'],
  [120, 'Treasure Island', 'Robert Louis Stevenson'], [55, 'The Wonderful Wizard of Oz', 'L. Frank Baum'],
  [35, 'The Time Machine', 'H. G. Wells'], [36, 'The War of the Worlds', 'H. G. Wells'], [161, 'Sense and Sensibility', 'Jane Austen'],
  [158, 'Emma', 'Jane Austen'], [244, 'A Study in Scarlet', 'Arthur Conan Doyle'], [2852, 'The Hound of the Baskervilles', 'Arthur Conan Doyle'],
  [1184, 'The Count of Monte Cristo', 'Alexandre Dumas'], [215, 'The Call of the Wild', 'Jack London'], [910, 'White Fang', 'Jack London'],
  [45, 'Anne of Green Gables', 'L. M. Montgomery'], [64317, 'The Great Gatsby', 'F. Scott Fitzgerald'],
].map(([gutenbergId, title, author]) => ({ gutenbergId, title, author, downloads: null, cover: gutenbergCover(gutenbergId), summary: '' }));

/** 熱門書單（每頁 32 本） */
export async function popular(page = 1) {
  let data;
  try {
    data = await getJson(`${GUTENDEX}/books/?languages=en&copyright=false&page=${page}`, 8000);
  } catch (e) {
    if (page === 1) return { hasMore: false, items: FALLBACK, fallback: true };
    throw e;
  }
  return {
    hasMore: !!data.next,
    items: data.results.filter((b) => b.media_type === 'Text').map((b) => ({
      gutenbergId: b.id,
      title: cleanTitle(b.title),
      author: b.authors.map((a) => cleanAuthor(a.name)).join(', '),
      downloads: b.download_count,
      cover: b.formats?.['image/jpeg'] ?? gutenbergCover(b.id),
      summary: b.summaries?.[0] ?? '',
    })),
  };
}

/** 關鍵字搜尋（書名、作者） */
export async function search(query, page = 1, rows = 20) {
  const clean = (query || '').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
  const q = ['collection:gutenberg', 'language:(eng OR English)'];
  if (clean) q.push(`(${clean})`);
  const params = new URLSearchParams({ q: q.join(' AND '), rows, page, output: 'json' });
  for (const f of ['identifier', 'title', 'creator', 'downloads']) params.append('fl[]', f);
  params.append('sort[]', 'downloads desc');
  const data = await getJson(`${IA}/advancedsearch.php?${params}`);
  const docs = data.response?.docs ?? [];
  return {
    hasMore: page * rows < (data.response?.numFound ?? 0),
    items: docs.map((d) => {
      const gid = Number((d.identifier.match(/(\d{5,6})gut$/) || [])[1]) || null;
      return {
        gutenbergId: gid,
        iaId: d.identifier,
        title: cleanTitle([d.title].flat()[0]),
        author: [d.creator].flat().filter(Boolean).map(cleanAuthor).join(', '),
        downloads: d.downloads,
        cover: gid ? gutenbergCover(gid) : null,
        summary: '',
      };
    }),
  };
}

async function findIaId(gutenbergId) {
  const pad = String(gutenbergId).padStart(5, '0');
  const params = new URLSearchParams({ q: `collection:gutenberg AND identifier:*${pad}gut`, rows: 10, output: 'json' });
  params.append('fl[]', 'identifier');
  const data = await getJson(`${IA}/advancedsearch.php?${params}`);
  const exact = new RegExp(`(^|\\D)${pad}gut$`);
  return (data.response?.docs ?? []).map((d) => d.identifier).find((id) => exact.test(id)) ?? null;
}

function decode(buf) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return new TextDecoder('windows-1252').decode(buf);
  }
}

/** 下載整本書的純文字 */
export async function fetchFullText({ gutenbergId, iaId }) {
  const id = iaId ?? (await findIaId(gutenbergId));
  if (!id) {
    const err = new Error('Internet Archive 沒有這本書的副本');
    err.code = 'NOT_FOUND';
    throw err;
  }
  const meta = await getJson(`${IA}/metadata/${encodeURIComponent(id)}`);
  const txt = (meta.files ?? []).filter(
    (f) => /\.txt$/i.test(f.name) && !/_djvu\.txt$/i.test(f.name) && f.format !== 'DjVuTXT' && !/(readme|license)/i.test(f.name),
  );
  if (!txt.length) {
    const err = new Error('這本書沒有純文字版本');
    err.code = 'NOT_FOUND';
    throw err;
  }
  // 優先用 UTF-8 版（檔名 -0.txt），否則用最大的檔案（通常是最新、最完整的版本）
  const pick = txt.find((f) => /-0\.txt$/i.test(f.name)) ?? txt.sort((a, b) => Number(b.size) - Number(a.size))[0];
  const url = `${IA}/download/${encodeURIComponent(id)}/${pick.name.split('/').map(encodeURIComponent).join('/')}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`下載失敗（HTTP ${res.status}）`);
  const creator = [meta.metadata?.creator].flat().filter(Boolean).map(cleanAuthor).join(', ');
  return { text: decode(await res.arrayBuffer()), iaId: id, creator };
}
