// 英文書 → 章節 → 朗讀片段（每段 1～3 句，約 30 個英文字以內）

export function decodeBuffer(buf) {
  const b = new Uint8Array(buf);
  if (b[0] === 0xff && b[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf);
  if (b[0] === 0xfe && b[1] === 0xff) return new TextDecoder('utf-16be').decode(buf);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return new TextDecoder('windows-1252').decode(buf);
  }
}

/** 去掉 Project Gutenberg 的前言與授權聲明，只留正文 */
export function stripGutenberg(text) {
  const small = text.search(/\*END\*THE SMALL PRINT/i);
  if (small >= 0) text = text.slice(text.indexOf('\n', small) + 1);
  const start = text.search(/^\*{3}\s*START OF (THE|THIS) PROJECT GUTENBERG[^\n]*$/im);
  if (start >= 0) text = text.slice(text.indexOf('\n', start) + 1);
  const end = text.search(/^\*{3}\s*END OF (THE|THIS) PROJECT GUTENBERG/im);
  if (end >= 0) text = text.slice(0, end);
  const end2 = text.search(/^\s*End of (the )?Project Gutenberg/im);
  if (end2 >= 0) text = text.slice(0, end2);
  return text;
}

const NUMBER_WORDS = 'one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|first|second|third|fourth|fifth|last';
const HEAD_WORD = new RegExp(
  `^(chapter|book|part|stave|adventure|letter|volume|act|canto|section)\\s+([0-9]+|[ivxlcdm]+|${NUMBER_WORDS})\\b[^a-z]{0,3}`,
  'i',
);
const HEAD_ALONE = /^(preface|prologue|epilogue|introduction|conclusion|postscript)\.?$/i;
const HEAD_ROMAN = /^[IVXLC]+\.\s+[A-Z][A-Z0-9 ,'’;:!?.-]+$/; // 例如 "I. A SCANDAL IN BOHEMIA"

const isHeading = (line) => line.length <= 70 && (HEAD_WORD.test(line) || HEAD_ALONE.test(line) || HEAD_ROMAN.test(line));

const ABBR = /\b(Mr|Mrs|Ms|Dr|St|Jr|Sr|Mt|No|vs|etc|Capt|Col|Gen|Lt|Prof|Rev|Hon|Messrs|i\.e|e\.g)\.["'”’]?$/i;

function cleanParagraph(p) {
  return p
    .replace(/\[(Illustration|Footnote)[^\]]*\]/gi, ' ')
    .replace(/_/g, '')
    .replace(/`/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function sentences(p) {
  const parts = p.split(/(?<=[.!?]["'”’)\]]*)\s+(?=["'“‘(\[]*[A-Z0-9])/);
  const out = [];
  for (const s of parts) {
    if (out.length && ABBR.test(out[out.length - 1])) out[out.length - 1] += ` ${s}`;
    else out.push(s);
  }
  return out;
}

function splitLong(s, max) {
  const out = [];
  while (s.length > max) {
    let cut = -1;
    for (const sep of ['; ', ': ', ', ', ' ']) {
      const i = s.lastIndexOf(sep, max);
      if (i > max * 0.4) {
        cut = i + sep.length;
        break;
      }
    }
    if (cut < 0) cut = max;
    out.push(s.slice(0, cut).trim());
    s = s.slice(cut);
  }
  if (s.trim()) out.push(s.trim());
  return out;
}

/** 一個段落 → 數個朗讀片段（不跨段落） */
export function toSegments(paragraph, target = 180, max = 260) {
  const out = [];
  let buf = '';
  for (const s of sentences(paragraph)) {
    if (buf && (buf + ' ' + s).length > target) {
      out.push(...splitLong(buf, max));
      buf = '';
    }
    buf = buf ? `${buf} ${s}` : s;
  }
  if (buf) out.push(...splitLong(buf, max));
  // 去掉只有編號的片段（例如 "I."、"II."）
  return out.filter((x) => x.replace(/[^A-Za-z]/g, '').length >= 2 && !/^[IVXLC]+\.?$/.test(x));
}

/** 整本書 → { chapters: [{ title, segments }] } */
export function parseBook(raw) {
  const text = stripGutenberg(raw.replace(/\r\n?/g, '\n'));
  const paragraphs = text.split(/\n\s*\n/).map((p) => p.split('\n').map((l) => l.trim()).filter(Boolean)).filter((l) => l.length);

  const found = [];
  let cur = { title: 'Opening', heading: false, segs: [] };
  for (let pi = 0; pi < paragraphs.length; pi++) {
    const lines = paragraphs[pi];
    // 目錄：一個段落裡有好幾行章名 → 整段略過
    if (lines.length >= 2 && lines.filter(isHeading).length >= 2) continue;
    if (isHeading(lines[0])) {
      // 標題自己一段、下一段是一行短短的副標題（例如 Alice 的 "Down the Rabbit-Hole"）
      const next = paragraphs[pi + 1];
      if (lines.length === 1 && next?.length === 1 && next[0].length < 60 && !/[.!?,;:]["'”’]?$/.test(next[0]) && !isHeading(next[0])) {
        lines.push(next[0]);
        pi++;
      }
      if (cur.segs.length) found.push(cur);
      // 標題下一行如果是短短的副標題（例如 "Down the Rabbit-Hole"），合併成章名
      const rest = lines.slice(1).join(' ');
      const title = rest && rest.length < 70 ? `${lines[0]} ${rest}` : lines[0];
      cur = { title: title.replace(/\s+/g, ' ').trim(), heading: true, segs: [] };
      if (rest.length >= 70) cur.segs.push(...toSegments(cleanParagraph(rest)));
      continue;
    }
    cur.segs.push(...toSegments(cleanParagraph(lines.join(' '))));
  }
  if (cur.segs.length) found.push(cur);

  let chapters;
  if (found.filter((c) => c.heading).length >= 2) {
    chapters = found.map((c) => ({ title: c.title, segments: c.segs }));
  } else {
    const all = found.flatMap((c) => c.segs);
    const PER = 80;
    chapters = [];
    for (let i = 0; i < all.length; i += PER) chapters.push({ title: `Part ${chapters.length + 1}`, segments: all.slice(i, i + PER) });
  }
  return { chapters: chapters.filter((c) => c.segments.length) };
}
