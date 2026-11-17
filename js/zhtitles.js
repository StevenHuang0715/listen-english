// 中文書名
//   1. 先查內建對照表（台灣常見譯名）：用 Gutenberg 編號，或「英文書名＋作者姓氏」比對
//   2. 查不到時，用瀏覽器內建翻譯翻書名（標示「機器翻譯」），結果存在這台裝置
// 對照表也讓「搜尋」可以直接輸入中文書名或中文作者名。

import * as translate from './translate.js';

// [Gutenberg 編號（沒有就 null）, 英文書名（可多個寫法）, 中文書名, 作者姓氏（比對用，空字串＝不檢查）, 中文作者]
const LIST = [
  // ── 英國小說 ──
  [1342, 'Pride and Prejudice', '傲慢與偏見', 'austen', '珍‧奧斯汀'],
  [161, 'Sense and Sensibility', '理性與感性', 'austen', '珍‧奧斯汀'],
  [158, 'Emma', '艾瑪', 'austen', '珍‧奧斯汀'],
  [105, 'Persuasion', '勸服', 'austen', '珍‧奧斯汀'],
  [121, 'Northanger Abbey', '諾桑覺寺', 'austen', '珍‧奧斯汀'],
  [141, 'Mansfield Park', '曼斯菲爾德莊園', 'austen', '珍‧奧斯汀'],
  [84, 'Frankenstein', '科學怪人', 'shelley', '瑪麗‧雪萊'],
  [1260, 'Jane Eyre', '簡愛', 'bronte', '夏綠蒂‧勃朗特'],
  [768, 'Wuthering Heights', '咆哮山莊', 'bronte', '艾蜜莉‧勃朗特'],
  [98, 'A Tale of Two Cities', '雙城記', 'dickens', '狄更斯'],
  [46, ['A Christmas Carol', 'A Christmas Carol in Prose'], '小氣財神', 'dickens', '狄更斯'],
  [1400, 'Great Expectations', '遠大前程', 'dickens', '狄更斯'],
  [730, 'Oliver Twist', '孤雛淚', 'dickens', '狄更斯'],
  [766, 'David Copperfield', '塊肉餘生錄', 'dickens', '狄更斯'],
  [1023, 'Bleak House', '荒涼山莊', 'dickens', '狄更斯'],
  [786, 'Hard Times', '艱難時世', 'dickens', '狄更斯'],
  [580, 'The Pickwick Papers', '匹克威克外傳', 'dickens', '狄更斯'],
  [564, 'The Mystery of Edwin Drood', '艾德溫‧德魯德之謎', 'dickens', '狄更斯'],
  [174, 'The Picture of Dorian Gray', '道林‧格雷的畫像', 'wilde', '王爾德'],
  [844, 'The Importance of Being Earnest', '不可兒戲', 'wilde', '王爾德'],
  [43, ['The Strange Case of Dr. Jekyll and Mr. Hyde', 'Dr. Jekyll and Mr. Hyde'], '化身博士', 'stevenson', '史蒂文生'],
  [120, 'Treasure Island', '金銀島', 'stevenson', '史蒂文生'],
  [345, 'Dracula', '德古拉', 'stoker', '布蘭‧史托克'],
  [145, 'Middlemarch', '米德鎮的春天', 'eliot', '喬治‧艾略特'],
  [2641, 'A Room with a View', '窗外有藍天', 'forster', '佛斯特'],
  [394, 'Cranford', '克蘭弗德', 'gaskell', '蓋斯凱爾夫人'],
  [6593, ['History of Tom Jones, a Foundling', 'Tom Jones'], '湯姆‧瓊斯', 'fielding', '亨利‧費爾丁'],
  [829, "Gulliver's Travels", '格列佛遊記', 'swift', '綏夫特'],
  [1080, 'A Modest Proposal', '一個溫和的建議', 'swift', '綏夫特'],
  [521, ['Robinson Crusoe', 'The Life and Adventures of Robinson Crusoe'], '魯賓遜漂流記', 'defoe', '笛福'],
  [583, 'The Woman in White', '白衣女人', 'collins', '威爾基‧柯林斯'],
  [155, 'The Moonstone', '月光石', 'collins', '威爾基‧柯林斯'],
  [219, 'Heart of Darkness', '黑暗之心', 'conrad', '康拉德'],
  [16, ['Peter Pan', 'Peter and Wendy'], '彼得潘', 'barrie', '巴利'],
  [11, "Alice's Adventures in Wonderland", '愛麗絲夢遊仙境', 'carroll', '路易斯‧卡羅'],
  [12, 'Through the Looking-Glass', '愛麗絲鏡中奇遇', 'carroll', '路易斯‧卡羅'],
  [289, 'The Wind in the Willows', '柳林風聲', 'grahame', '葛拉罕'],
  [236, 'The Jungle Book', '叢林奇談', 'kipling', '吉卜林'],
  [35, 'The Time Machine', '時光機器', 'wells', 'H. G. 威爾斯'],
  [36, 'The War of the Worlds', '世界大戰', 'wells', 'H. G. 威爾斯'],
  [5230, 'The Invisible Man', '隱形人', 'wells', 'H. G. 威爾斯'],
  [159, 'The Island of Doctor Moreau', '莫羅博士島', 'wells', 'H. G. 威爾斯'],
  [1695, 'The Man Who Was Thursday', '名叫星期四的男人', 'chesterton', '卻斯特頓'],
  [204, 'The Innocence of Father Brown', '布朗神父的天真', 'chesterton', '卻斯特頓'],
  [223, 'The Wisdom of Father Brown', '布朗神父的智慧', 'chesterton', '卻斯特頓'],
  [70175, 'The Secret of Father Brown', '布朗神父的秘密', 'chesterton', '卻斯特頓'],
  [393, 'The Blue Lagoon', '藍色珊瑚礁', 'stacpoole', '斯塔克普爾'],
  [4217, 'A Portrait of the Artist as a Young Man', '一個青年藝術家的畫像', 'joyce', '喬伊斯'],
  [2814, 'Dubliners', '都柏林人', 'joyce', '喬伊斯'],
  [4300, 'Ulysses', '尤利西斯', 'joyce', '喬伊斯'],
  [10007, 'Carmilla', '卡蜜拉', 'fanu', '勒‧法努'],
  [146, 'A Little Princess', '小公主', 'burnett', '柏內特'],
  [113, 'The Secret Garden', '祕密花園', 'burnett', '柏內特'],
  [479, 'Little Lord Fauntleroy', '小公子', 'burnett', '柏內特'],

  // ── 福爾摩斯、推理 ──
  [1661, 'The Adventures of Sherlock Holmes', '福爾摩斯冒險史', 'doyle', '柯南‧道爾'],
  [834, 'The Memoirs of Sherlock Holmes', '福爾摩斯回憶錄', 'doyle', '柯南‧道爾'],
  [108, 'The Return of Sherlock Holmes', '福爾摩斯歸來記', 'doyle', '柯南‧道爾'],
  [2350, 'His Last Bow', '最後致意', 'doyle', '柯南‧道爾'],
  [69700, 'The Case-Book of Sherlock Holmes', '福爾摩斯檔案簿', 'doyle', '柯南‧道爾'],
  [244, 'A Study in Scarlet', '血字的研究', 'doyle', '柯南‧道爾'],
  [2097, ['The Sign of the Four', 'The Sign of Four'], '四簽名', 'doyle', '柯南‧道爾'],
  [2852, 'The Hound of the Baskervilles', '巴斯克維爾的獵犬', 'doyle', '柯南‧道爾'],
  [3289, 'The Valley of Fear', '恐怖谷', 'doyle', '柯南‧道爾'],
  [863, 'The Mysterious Affair at Styles', '史岱爾莊謀殺案', 'christie', '阿嘉莎‧克莉絲蒂'],
  [1155, 'The Secret Adversary', '隱身魔', 'christie', '阿嘉莎‧克莉絲蒂'],
  [58866, 'The Murder on the Links', '高爾夫球場命案', 'christie', '阿嘉莎‧克莉絲蒂'],
  [61262, 'Poirot Investigates', '白羅出擊', 'christie', '阿嘉莎‧克莉絲蒂'],
  [61168, 'The Man in the Brown Suit', '褐衣男子', 'christie', '阿嘉莎‧克莉絲蒂'],
  [65238, 'The Secret of Chimneys', '煙囪的秘密', 'christie', '阿嘉莎‧克莉絲蒂'],
  [69087, 'The Murder of Roger Ackroyd', '羅傑‧艾克洛命案', 'christie', '阿嘉莎‧克莉絲蒂'],
  [70114, 'The Big Four', '四大天王', 'christie', '阿嘉莎‧克莉絲蒂'],
  [58820, 'Whose Body?', '誰的屍體？', 'sayers', '桃樂絲‧榭爾絲'],
  [175, 'The Phantom of the Opera', '歌劇魅影', 'leroux', '卡斯頓‧勒胡'],

  // ── 美國 ──
  [2701, ['Moby Dick', 'Moby-Dick'], '白鯨記', 'melville', '梅爾維爾'],
  [74, 'The Adventures of Tom Sawyer', '湯姆歷險記', 'twain', '馬克‧吐溫'],
  [76, 'Adventures of Huckleberry Finn', '頑童歷險記', 'twain', '馬克‧吐溫'],
  [1837, 'The Prince and the Pauper', '乞丐王子', 'twain', '馬克‧吐溫'],
  [245, 'Life on the Mississippi', '密西西比河上的生活', 'twain', '馬克‧吐溫'],
  [64317, 'The Great Gatsby', '大亨小傳', 'fitzgerald', '費茲傑羅'],
  [75201, 'A Farewell to Arms', '戰地春夢', 'hemingway', '海明威'],
  [514, 'Little Women', '小婦人', 'alcott', '奧爾柯特'],
  [25344, 'The Scarlet Letter', '紅字', 'hawthorne', '霍桑'],
  [55, 'The Wonderful Wizard of Oz', '綠野仙蹤', 'baum', '法蘭克‧鮑姆'],
  [215, 'The Call of the Wild', '野性的呼喚', 'london', '傑克‧倫敦'],
  [910, 'White Fang', '白牙', 'london', '傑克‧倫敦'],
  [205, ['Walden', 'Walden, and On The Duty Of Civil Disobedience'], '湖濱散記', 'thoreau', '梭羅'],
  [41, 'The Legend of Sleepy Hollow', '睡谷傳說', 'irving', '華盛頓‧歐文'],
  [1952, 'The Yellow Wallpaper', '黃色壁紙', 'gilman', '吉爾曼'],
  [209, 'The Turn of the Screw', '碧廬冤孽', 'james', '亨利‧詹姆斯'],
  [2833, 'The Portrait of a Lady', '仕女圖', 'james', '亨利‧詹姆斯'],
  [4517, 'Ethan Frome', '伊坦‧弗洛美', 'wharton', '伊迪絲‧華頓'],
  [541, 'The Age of Innocence', '純真年代', 'wharton', '伊迪絲‧華頓'],
  [284, 'The House of Mirth', '歡樂之家', 'wharton', '伊迪絲‧華頓'],
  [160, ['The Awakening', 'The Awakening and Selected Short Stories'], '覺醒', 'chopin', '凱特‧蕭邦'],
  [8492, 'The King in Yellow', '黃衣之王', 'chambers', '錢伯斯'],
  [68283, 'The Call of Cthulhu', '克蘇魯的呼喚', 'lovecraft', '洛夫克拉夫特'],
  [70652, 'At the Mountains of Madness', '瘋狂山脈', 'lovecraft', '洛夫克拉夫特'],
  [62, 'A Princess of Mars', '火星公主', 'burroughs', '巴勒斯'],
  [78, 'Tarzan of the Apes', '人猿泰山', 'burroughs', '巴勒斯'],
  [932, 'The Fall of the House of Usher', '厄舍府的沒落', 'poe', '愛倫‧坡'],
  [null, 'The Works of Edgar Allan Poe', '愛倫‧坡作品集', 'poe', '愛倫‧坡'],
  [1322, 'Leaves of Grass', '草葉集', 'whitman', '惠特曼'],
  [20203, ['Autobiography of Benjamin Franklin', 'The Autobiography of Benjamin Franklin'], '富蘭克林自傳', 'franklin', '富蘭克林'],
  [23, 'Narrative of the Life of Frederick Douglass, an American Slave', '道格拉斯自傳', 'douglass', '道格拉斯'],
  [408, 'The Souls of Black Folk', '黑人的靈魂', 'bois', '杜博依斯'],
  [45, 'Anne of Green Gables', '清秀佳人', 'montgomery', '露西‧莫德‧蒙哥馬利'],
  [47, 'Anne of Avonlea', '艾凡里的安妮', 'montgomery', '露西‧莫德‧蒙哥馬利'],
  [67979, 'The Blue Castle', '藍色城堡', 'montgomery', '露西‧莫德‧蒙哥馬利'],

  // ── 歐洲與其他 ──
  [1184, 'The Count of Monte Cristo', '基督山恩仇記', 'dumas', '大仲馬'],
  [1257, 'The Three Musketeers', '三劍客', 'dumas', '大仲馬'],
  [1259, 'Twenty Years After', '二十年後', 'dumas', '大仲馬'],
  [135, 'Les Misérables', '悲慘世界', 'hugo', '雨果'],
  [2610, ['Notre-Dame de Paris', 'The Hunchback of Notre Dame'], '鐘樓怪人', 'hugo', '雨果'],
  [2413, 'Madame Bovary', '包法利夫人', 'flaubert', '福樓拜'],
  [2465, 'Carmen', '卡門', 'merimee', '梅里美'],
  [19942, 'Candide', '憨第德', 'voltaire', '伏爾泰'],
  [164, 'Twenty Thousand Leagues under the Sea', '海底兩萬哩', 'verne', '凡爾納'],
  [103, 'Around the World in Eighty Days', '環遊世界八十天', 'verne', '凡爾納'],
  [18857, ['A Journey to the Centre of the Earth', 'A Journey to the Center of the Earth'], '地心歷險記', 'verne', '凡爾納'],
  [83, 'From the Earth to the Moon', '從地球到月球', 'verne', '凡爾納'],
  [1268, 'The Mysterious Island', '神祕島', 'verne', '凡爾納'],
  [2600, 'War and Peace', '戰爭與和平', 'tolstoy', '托爾斯泰'],
  [1399, 'Anna Karenina', '安娜‧卡列尼娜', 'tolstoy', '托爾斯泰'],
  [2554, 'Crime and Punishment', '罪與罰', 'dostoyevsky', '杜斯妥也夫斯基'],
  [28054, 'The Brothers Karamazov', '卡拉馬助夫兄弟們', 'dostoyevsky', '杜斯妥也夫斯基'],
  [2638, 'The Idiot', '白痴', 'dostoyevsky', '杜斯妥也夫斯基'],
  [600, ['Notes from the Underground', 'Notes from Underground'], '地下室手記', 'dostoyevsky', '杜斯妥也夫斯基'],
  [2197, 'The Gambler', '賭徒', 'dostoyevsky', '杜斯妥也夫斯基'],
  [36034, ['White Nights', 'White Nights, and Other Stories'], '白夜', 'dostoyevsky', '杜斯妥也夫斯基'],
  [5200, 'Metamorphosis', '變形記', 'kafka', '卡夫卡'],
  [7849, 'The Trial', '審判', 'kafka', '卡夫卡'],
  [2500, 'Siddhartha', '流浪者之歌', 'hesse', '赫塞'],
  [2542, "A Doll's House", '玩偶之家', 'ibsen', '易卜生'],
  [500, ['The Adventures of Pinocchio', 'Adventures of Pinocchio'], '木偶奇遇記', 'collodi', '科洛迪'],
  [2591, "Grimms' Fairy Tales", '格林童話', 'grimm', '格林兄弟'],
  [1597, "Andersen's Fairy Tales", '安徒生童話', 'andersen', '安徒生'],
  [21, "Aesop's Fables", '伊索寓言', '', '伊索'],
  [78017, 'The Swiss Family Robinson', '海角一樂園', 'wyss', '威斯'],
  [996, 'Don Quixote', '唐吉訶德', 'cervantes', '塞萬提斯'],
  [8800, ['The Divine Comedy', 'Divine Comedy'], '神曲', 'dante', '但丁'],

  // ── 莎士比亞 ──
  [100, 'The Complete Works of William Shakespeare', '莎士比亞全集', 'shakespeare', '莎士比亞'],
  [null, 'The Works of William Shakespeare', '莎士比亞作品集', 'shakespeare', '莎士比亞'],
  [1513, 'Romeo and Juliet', '羅密歐與茱麗葉', 'shakespeare', '莎士比亞'],
  [1524, 'Hamlet', '哈姆雷特', 'shakespeare', '莎士比亞'],
  [1533, 'Macbeth', '馬克白', 'shakespeare', '莎士比亞'],
  [1531, 'Othello', '奧賽羅', 'shakespeare', '莎士比亞'],
  [1532, 'King Lear', '李爾王', 'shakespeare', '莎士比亞'],
  [1514, "A Midsummer Night's Dream", '仲夏夜之夢', 'shakespeare', '莎士比亞'],
  [1515, 'The Merchant of Venice', '威尼斯商人', 'shakespeare', '莎士比亞'],
  [1519, 'Much Ado about Nothing', '無事生非', 'shakespeare', '莎士比亞'],
  [1540, 'The Tempest', '暴風雨', 'shakespeare', '莎士比亞'],
  [1041, "Shakespeare's Sonnets", '莎士比亞十四行詩', 'shakespeare', '莎士比亞'],

  // ── 史詩、哲學、思想 ──
  [1727, 'The Odyssey', '奧德賽', 'homer', '荷馬'],
  [6130, 'The Iliad', '伊利亞德', 'homer', '荷馬'],
  [16328, 'Beowulf', '貝武夫', '', ''],
  [2680, 'Meditations', '沉思錄', 'aurelius', '馬可‧奧理略'],
  [1497, 'The Republic', '理想國', 'plato', '柏拉圖'],
  [3296, ['The Confessions of St. Augustine', 'Confessions'], '懺悔錄', 'augustine', '奧古斯丁'],
  [1232, 'The Prince', '君主論', 'machiavelli', '馬基維利'],
  [2130, 'Utopia', '烏托邦', 'more', '湯瑪斯‧摩爾'],
  [3207, 'Leviathan', '利維坦', 'hobbes', '霍布斯'],
  [7370, 'Second Treatise of Government', '政府論（下篇）', 'locke', '洛克'],
  [3300, ['An Inquiry into the Nature and Causes of the Wealth of Nations', 'The Wealth of Nations'], '國富論', 'smith', '亞當‧斯密'],
  [147, 'Common Sense', '常識', 'paine', '湯瑪斯‧潘恩'],
  [1404, 'The Federalist Papers', '聯邦論', '', '漢彌爾頓等'],
  [34901, 'On Liberty', '論自由', 'mill', '約翰‧彌爾'],
  [4363, 'Beyond Good and Evil', '善惡的彼岸', 'nietzsche', '尼采'],
  [1998, 'Thus Spake Zarathustra', '查拉圖斯特拉如是說', 'nietzsche', '尼采'],
  [4280, 'The Critique of Pure Reason', '純粹理性批判', 'kant', '康德'],
  [5827, 'The Problems of Philosophy', '哲學問題', 'russell', '羅素'],
  [1228, 'On the Origin of Species', '物種起源', 'darwin', '達爾文'],
  [132, 'The Art of War', '孫子兵法', '', '孫子'],
  [10, ['The Bible, Old and New Testaments, King James Version', 'The King James Version of the Bible'], '聖經（欽定版）', '', ''],
];

const strip = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** 書名去掉 Gutenberg / IA 的雜訊（例如 " : $b "） */
export function cleanTitle(t) {
  return String(t ?? '').replace(/\s*:?\s*\$b\s*/g, ': ').replace(/\s+/g, ' ').trim();
}

/** 第幾冊："… — Volume 2"、"[Vol. 5 of 9]" → "2" / "5" */
function volumeOf(t) {
  const m = t.match(/\b(?:vol(?:ume)?)\.?\s*(\d+|[ivxlc]+)\b/i);
  return m ? m[1].toUpperCase() : null;
}

/** 比對用的書名：小寫、去副標題、去冠詞與標點 */
function normTitle(t) {
  return strip(cleanTitle(t))
    .split(/\s*(?:[;:([]|\s[—–-]\s|—|,\s*or,?\s)/)[0]
    .replace(/\s+(?:translated|edited|illustrated|rendered)\b.*$/, '')
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+complete$/, '')
    .replace(/^(?:the|a|an) /, '')
    .trim();
}

const byId = new Map();
const byTitle = new Map(); // normTitle → [entry]
const ENTRIES = LIST.map(([id, en, zh, au, zhAuthor]) => {
  const e = { id, en: [en].flat(), zh, au, zhAuthor };
  if (id) byId.set(id, e);
  for (const t of e.en) {
    const k = normTitle(t);
    if (!byTitle.has(k)) byTitle.set(k, []);
    byTitle.get(k).push(e);
  }
  return e;
});

/**
 * 查內建對照表 → 中文書名或 null
 * book: { gutenbergId?, title, author? }
 */
export function lookup(book) {
  const title = cleanTitle(book.title);
  const vol = volumeOf(title);
  let e = book.gutenbergId ? byId.get(Number(book.gutenbergId)) : null;
  if (!e) {
    const author = strip(book.author);
    e = (byTitle.get(normTitle(title)) ?? []).find((x) => !x.au || !author || author.includes(x.au)) ?? null;
  }
  if (!e) return null;
  return vol ? `${e.zh}（第 ${vol} 冊）` : e.zh;
}

/* ---------- 機器翻譯書名（對照表沒有的書） ---------- */

const CACHE_KEY = 'zh-title-cache-v1';
let cache = null;
function loadCache() {
  if (!cache) {
    try {
      cache = JSON.parse(localStorage.getItem(CACHE_KEY)) || {};
    } catch {
      cache = {};
    }
  }
  return cache;
}
function saveCache() {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
  } catch { /* 無痕模式等情況存不了，沒關係 */ }
}

let chain = Promise.resolve();

/** 只看快取 */
export const cachedMachine = (title) => loadCache()[cleanTitle(title)] ?? null;

/**
 * 用內建翻譯翻書名。翻譯模型還沒下載好時回傳 null（不會自己觸發下載）。
 */
export function machineTitle(title) {
  const t = cleanTitle(title);
  const hit = loadCache()[t];
  if (hit) return Promise.resolve(hit);
  const run = chain.then(async () => {
    if (loadCache()[t]) return cache[t];
    if ((await translate.availability()) !== 'available') return null;
    const tr = await translate.getTranslator();
    // 只翻主書名（副標題、括號常被翻得很奇怪），冊數另外補上
    const main = t.split(/\s*(?:[;:([]|\s[—–-]\s|—)/)[0].trim() || t;
    const vol = volumeOf(t);
    let zh = translate.fixPunct(await tr.translate(main)).replace(/[。．.]$/, '');
    if (zh && vol) zh += `（第 ${vol} 冊）`;
    if (!zh || zh === t) return null;
    cache[t] = zh;
    saveCache();
    return zh;
  });
  chain = run.catch(() => {});
  return run.catch(() => null);
}

/**
 * 中文書名資訊：{ zh, machine } 或 null
 * 先看對照表，再看已存的結果（book.zhTitle）或機器翻譯快取
 */
export function zhInfo(book) {
  const zh = lookup(book);
  if (zh) return { zh, machine: false };
  if (book.zhTitle) return { zh: book.zhTitle, machine: !!book.zhTitleMachine };
  const m = cachedMachine(book.title);
  return m ? { zh: m, machine: true } : null;
}

/* ---------- 中文搜尋 ---------- */

// 額外的搜尋關鍵字（依作者）
const TAGS = { doyle: '福爾摩斯 夏洛克', christie: '白羅 推理', chesterton: '布朗神父 推理', sayers: '推理', verne: '科幻', wells: '科幻' };

export const hasCjk = (s) => /[㐀-鿿]/.test(s);

/** 用中文書名或中文作者找書 → 目錄項目（只找得到對照表裡、有 Gutenberg 編號的書） */
export function searchZh(query) {
  const words = String(query).replace(/[《》〈〉「」『』\s‧·・．.]+/g, ' ').trim().split(' ').filter(Boolean);
  if (!words.length) return [];
  const flat = (s) => String(s).replace(/[‧·・．.\s]/g, '');
  const text = (e) => flat(`${e.zh} ${e.zhAuthor} ${TAGS[e.au] ?? ''}`);
  return ENTRIES.filter((e) => e.id && words.every((w) => text(e).includes(flat(w))))
    .map((e) => ({ gutenbergId: e.id, title: e.en[0], author: e.zhAuthor, authorIsZh: true, zhTitle: e.zh, cover: null }));
}
