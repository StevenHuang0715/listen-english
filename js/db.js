// IndexedDB 封裝：所有資料只存在這台裝置的瀏覽器裡
// stores（聽書學英文）:
//   books      書本資料 { id, source, title, author, chapters: [{ title, count }], ... }
//   blobs      英文原文 `${bookId}:en`、中文翻譯 `${bookId}:zh:${章}`
//   progress   閱讀進度 { bookId, chapter, pos, fraction, updatedAt }
//   bookmarks  收藏句 { id, bookId, chapter, pos, en, zh, note, createdAt }

const DB_NAME = 'listen-english';
const DB_VERSION = 1;
let dbPromise = null;

function open() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        db.createObjectStore('books', { keyPath: 'id' });
        db.createObjectStore('blobs');
        db.createObjectStore('progress', { keyPath: 'bookId' });
        const bm = db.createObjectStore('bookmarks', { keyPath: 'id' });
        bm.createIndex('bookId', 'bookId');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

const wrap = (req) =>
  new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

const done = (tx) =>
  new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });

export async function get(store, key) {
  const db = await open();
  return wrap(db.transaction(store).objectStore(store).get(key));
}

export async function getAll(store) {
  const db = await open();
  return wrap(db.transaction(store).objectStore(store).getAll());
}

export async function getByIndex(store, index, value) {
  const db = await open();
  return wrap(db.transaction(store).objectStore(store).index(index).getAll(value));
}

export async function put(store, value, key) {
  const db = await open();
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).put(value, key);
  return done(tx);
}

export async function del(store, key) {
  const db = await open();
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).delete(key);
  return done(tx);
}

/** 取出某本書所有的大型內容 → [[key, value], ...]（匯出用） */
export async function getBlobsOf(bookId) {
  const db = await open();
  const store = db.transaction('blobs').objectStore('blobs');
  const range = IDBKeyRange.bound(`${bookId}:`, `${bookId}:￿`);
  const [keys, values] = await Promise.all([wrap(store.getAllKeys(range)), wrap(store.getAll(range))]);
  return keys.map((k, i) => [k, values[i]]);
}

/** 新增書本與其內容（同一個 transaction，失敗時整筆不寫入） */
export async function addBook(book, blobEntries = []) {
  const db = await open();
  const tx = db.transaction(['books', 'blobs'], 'readwrite');
  tx.objectStore('books').put(book);
  const blobs = tx.objectStore('blobs');
  for (const [key, value] of blobEntries) blobs.put(value, key);
  return done(tx);
}

/** 刪除書本以及它的內容、進度、書籤 */
export async function deleteBook(bookId) {
  const db = await open();
  const tx = db.transaction(['books', 'blobs', 'progress', 'bookmarks'], 'readwrite');
  tx.objectStore('books').delete(bookId);
  tx.objectStore('progress').delete(bookId);
  tx.objectStore('blobs').delete(IDBKeyRange.bound(`${bookId}:`, `${bookId}:￿`));
  const bookmarks = tx.objectStore('bookmarks');
  bookmarks.index('bookId').openKeyCursor(IDBKeyRange.only(bookId)).onsuccess = (e) => {
    const cursor = e.target.result;
    if (cursor) {
      bookmarks.delete(cursor.primaryKey);
      cursor.continue();
    }
  };
  return done(tx);
}
