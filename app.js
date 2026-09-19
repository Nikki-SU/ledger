/* ============================================
   账本 - 核心逻辑
   双通道存储：本地 CSV 文件（主）+ IndexedDB（缓存）
   CSV 是人类最易读写的格式，Excel/WPS/Numbers 直接打开
   ============================================ */

const DB_NAME = 'LedgerDB';
const DB_VERSION = 2; // 升级版本以创建 settings store
const STORE_NAME = 'records';
const SETTINGS_STORE = 'settings';
const DATA_FILE = 'ledger_data.csv';

// CSV 表头（顺序即字段顺序）
const CSV_HEADERS = ['id', 'date', 'time', 'source', 'amount', 'type', 'checked'];
const CSV_BOM = '\uFEFF'; // Excel 需要 BOM 才识别 UTF-8

let db = null;
let dirHandle = null;       // 本地目录句柄
let dirHandleGranted = false; // 目录是否已授权
let pendingWrites = false;

/* ====================
   CSV 编解码（RFC 4180）
   ==================== */

const CSV = {
  /** 把 records 数组转成 CSV 文本（带 BOM + 表头） */
  encode(records) {
    const escape = (val) => {
      if (val === null || val === undefined) return '';
      const s = String(val);
      // 含逗号、引号、换行时用双引号包裹，内部双引号翻倍
      if (/[",\r\n]/.test(s)) {
        return '"' + s.replace(/"/g, '""') + '"';
      }
      return s;
    };
    const lines = [CSV_HEADERS.join(',')];
    for (const r of records) {
      lines.push(CSV_HEADERS.map(h => escape(r[h])).join(','));
    }
    return CSV_BOM + lines.join('\n');
  },

  /** 把 CSV 文本解析回 records 数组 */
  decode(text) {
    if (!text) return [];
    // 去掉 UTF-8 BOM
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    // 按行分割（兼容 \r\n 和 \n）
    const rows = this._splitRows(text);
    if (rows.length === 0) return [];
    // 第一行是表头
    const headers = this._splitLine(rows[0]);
    // 找 id 列位置
    const idx = Object.fromEntries(headers.map((h, i) => [h.trim(), i]));
    const records = [];
    for (let i = 1; i < rows.length; i++) {
      if (!rows[i].trim()) continue; // 跳过空行
      const cols = this._splitLine(rows[i]);
      const obj = {};
      for (let j = 0; j < headers.length; j++) {
        let val = (cols[j] !== undefined ? cols[j] : '').trim();
        // 类型转换
        if (headers[j] === 'id' || headers[j] === 'amount') val = val === '' ? 0 : Number(val);
        else if (headers[j] === 'checked') val = val === 'true' || val === '1';
        obj[headers[j].trim()] = val;
      }
      // 必须有 id 才算有效记录
      if (obj.id) records.push(obj);
    }
    return records;
  },

  /** 按行分割，但引号内的 \n 不是行分隔 */
  _splitRows(text) {
    const rows = [];
    let cur = '';
    let inQuote = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (c === '"') {
        // 双引号：如果后面还是双引号，跳过（转义的引号）
        if (inQuote && text[i + 1] === '"') { cur += '"'; i++; continue; }
        inQuote = !inQuote;
        cur += c;
      } else if ((c === '\n' || c === '\r') && !inQuote) {
        if (c === '\r' && text[i + 1] === '\n') i++;
        rows.push(cur); cur = '';
      } else {
        cur += c;
      }
    }
    if (cur.length || rows.length === 0) rows.push(cur);
    return rows;
  },

  /** 单行按逗号分割，处理引号包裹 */
  _splitLine(line) {
    const cols = [];
    let cur = '';
    let inQuote = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') {
        if (inQuote && line[i + 1] === '"') { cur += '"'; i++; continue; }
        inQuote = !inQuote;
      } else if (c === ',' && !inQuote) {
        cols.push(cur); cur = '';
      } else {
        cur += c;
      }
    }
    cols.push(cur);
    return cols;
  }
};

/* ====================
   File System Access API 封装
   ==================== */

const FS = {
  /** 检查浏览器是否支持 */
  isSupported() {
    return typeof window !== 'undefined' && 'showDirectoryPicker' in window;
  },

  /** 用户手势触发：让用户选一个本地目录 */
  async pickDirectory() {
    if (!this.isSupported()) {
      showToast('你的浏览器不支持 File Access API，请用 Chrome/Edge');
      return null;
    }
    try {
      const handle = await window.showDirectoryPicker({
        mode: 'readwrite',
        startIn: 'documents',
      });
      // 存 IndexedDB 以便下次恢复
      await this.saveDirectoryHandle(handle);
      dirHandle = handle;
      dirHandleGranted = true;
      await this.ensureDataFile();
      // 立刻从本地文件载入数据覆盖 IndexedDB 缓存
      await this.syncFromFile();
      showToast(`已连接：${handle.name}`);
      return handle;
    } catch (e) {
      if (e.name !== 'AbortError') {
        console.error('选择目录失败:', e);
        showToast('选择目录失败');
      }
      return null;
    }
  },

  /** 确保 CSV 数据文件存在（带表头） */
  async ensureDataFile() {
    if (!dirHandle) return false;
    try {
      await dirHandle.getFileHandle(DATA_FILE);
    } catch (e) {
      if (e.name === 'NotFoundError') {
        const fileHandle = await dirHandle.getFileHandle(DATA_FILE, { create: true });
        const writable = await fileHandle.createWritable();
        await writable.write(CSV.encode([])); // 只写表头
        await writable.close();
      }
    }
    return true;
  },

  /** 读取本地 CSV 文件并解析 */
  async readFile() {
    if (!dirHandle) return null;
    try {
      const fileHandle = await dirHandle.getFileHandle(DATA_FILE);
      const file = await fileHandle.getFile();
      const text = await file.text();
      return CSV.decode(text);
    } catch (e) {
      if (e.name === 'NotFoundError') {
        await this.ensureDataFile();
        return [];
      }
      console.error('读取本地 CSV 失败:', e);
      return null;
    }
  },

  /** 写入本地 CSV 文件（全量覆盖，带 BOM + 表头） */
  async writeFile(records) {
    if (!dirHandle) return false;
    try {
      const fileHandle = await dirHandle.getFileHandle(DATA_FILE, { create: true });
      const writable = await fileHandle.createWritable();
      await writable.write(CSV.encode(records));
      await writable.close();
      return true;
    } catch (e) {
      console.error('写入本地 CSV 失败:', e);
      return false;
    }
  },

  /**
   * 从本地文件同步到 IndexedDB（安全合并，永远不覆盖）
   * 合并规则：
   *   1. IndexedDB 里有、CSV 里没有 → 保留（用户新增但还没成功写 CSV 的）
   *   2. CSV 里有、IndexedDB 里没有 → 补进（CSV 独立修改或上次遗留）
   *   3. 两边都有 → 保留 IndexedDB 版本（用户在 app 里操作的优先）
   * @returns {{added:number, kept:number}} 合并统计
   */
  async syncFromFile() {
    const fileRecords = await this.readFile();
    if (!fileRecords) return { added: 0, kept: 0 };

    // 从 IndexedDB 读
    const dbRecords = await DB.getAll();
    const dbIds = new Set(dbRecords.map(r => r.id));

    // CSV 里有、但 IndexedDB 没有 → 补进
    let added = 0;
    for (const r of fileRecords) {
      if (!dbIds.has(r.id)) {
        await DB.addToCache(r);
        added++;
      }
    }

    // 合并后的数据再写回 CSV（补全刚才新增的），确保两边一致
    const merged = [...dbRecords, ...fileRecords.filter(r => !dbIds.has(r.id))];
    if (added > 0) {
      await this.writeFile(merged);
    }

    return { added, kept: dbRecords.length };
  },

  /** 保存目录句柄到 IndexedDB（句柄可被结构化克隆直接存） */
  async saveDirectoryHandle(handle) {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onerror = () => reject(request.error);
      request.onupgradeneeded = (e) => {
        const d = e.target.result;
        if (!d.objectStoreNames.contains(SETTINGS_STORE)) {
          d.createObjectStore(SETTINGS_STORE);
        }
      };
      request.onsuccess = () => {
        const d = request.result;
        if (!d.objectStoreNames.contains(SETTINGS_STORE)) {
          d.close();
          const req2 = indexedDB.open(DB_NAME, DB_VERSION);
          req2.onupgradeneeded = (e2) => {
            e2.target.result.createObjectStore(SETTINGS_STORE);
          };
          req2.onsuccess = () => {
            const d2 = req2.result;
            const tx = d2.transaction(SETTINGS_STORE, 'readwrite');
            tx.objectStore(SETTINGS_STORE).put(handle, 'dirHandle');
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
          };
        } else {
          const tx = d.transaction(SETTINGS_STORE, 'readwrite');
          tx.objectStore(SETTINGS_STORE).put(handle, 'dirHandle');
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        }
      };
    });
  },

  /** 从 IndexedDB 恢复目录句柄 */
  async loadDirectoryHandle() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const d = request.result;
        if (!d.objectStoreNames.contains(SETTINGS_STORE)) { resolve(null); return; }
        const tx = d.transaction(SETTINGS_STORE, 'readonly');
        const req = tx.objectStore(SETTINGS_STORE).get('dirHandle');
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => reject(req.error);
      };
    });
  },

  /** 恢复目录并检查权限 */
  async restoreAndCheck() {
    const handle = await this.loadDirectoryHandle();
    if (!handle) return { handle: null, permission: 'missing' };
    dirHandle = handle;
    let state;
    try {
      state = await handle.queryPermission({ mode: 'readwrite' });
    } catch (e) {
      state = 'prompt';
    }
    if (state === 'granted') {
      dirHandleGranted = true;
      await this.ensureDataFile();
      await this.syncFromFile();
    } else {
      dirHandleGranted = false;
    }
    return { handle, permission: state };
  },

  /** 用户手势触发：重新请求权限 */
  async requestPermission() {
    if (!dirHandle) return false;
    try {
      const state = await dirHandle.requestPermission({ mode: 'readwrite' });
      if (state === 'granted') {
        dirHandleGranted = true;
        await this.ensureDataFile();
        await this.syncFromFile();
        showToast('已授权，数据同步完成');
        return true;
      } else {
        dirHandleGranted = false;
        showToast('授权被拒绝');
        return false;
      }
    } catch (e) {
      console.error('请求权限失败:', e);
      return false;
    }
  },

  /** 清除已存的目录设置 */
  async clear() {
    try {
      const d = await new Promise((res, rej) => {
        const r = indexedDB.open(DB_NAME, DB_VERSION);
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
      if (d.objectStoreNames.contains(SETTINGS_STORE)) {
        const tx = d.transaction(SETTINGS_STORE, 'readwrite');
        tx.objectStore(SETTINGS_STORE).delete('dirHandle');
      }
      dirHandle = null;
      dirHandleGranted = false;
    } catch (e) {
      console.error('清除目录设置失败:', e);
    }
  }
};

/* ====================
   IndexedDB 缓存层 + localStorage 快照兜底
   ==================== */

const LS_KEY = 'ledger_records_cache_v1'; // localStorage 快速快照

const DB = {
  async init() {
    return new Promise((resolve, reject) => {
      try {
        if (typeof indexedDB === 'undefined') throw new Error('IndexedDB not supported');
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          db = request.result;
          resolve(db);
        };
        request.onupgradeneeded = (event) => {
          const d = event.target.result;
          if (!d.objectStoreNames.contains(STORE_NAME)) {
            const store = d.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true });
            store.createIndex('date', 'date', { unique: false });
            store.createIndex('type', 'type', { unique: false });
          }
          if (!d.objectStoreNames.contains(SETTINGS_STORE)) {
            d.createObjectStore(SETTINGS_STORE);
          }
        };
      } catch (e) {
        reject(e);
      }
    });
  },

  // 写入缓存层（内部用）
  addToCache(record) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const r = store.add(record);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  },

  /** 把 IndexedDB 全部记录存一份到 localStorage 做快照兜底 */
  async saveLS() {
    try {
      if (typeof localStorage === 'undefined') return;
      const records = await this.getAll();
      localStorage.setItem(LS_KEY, JSON.stringify(records));
    } catch (e) {
      console.warn('localStorage 快照失败:', e);
    }
  },

  /** 从 localStorage 快照恢复到 IndexedDB（IndexedDB 意外清空时用） */
  async restoreFromLS() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (!raw) return 0;
      const records = JSON.parse(raw);
      if (!Array.isArray(records) || records.length === 0) return 0;
      await this.clearAll();
      for (const r of records) {
        await this.addToCache(r);
      }
      return records.length;
    } catch (e) {
      console.warn('从 localStorage 恢复失败:', e);
      return 0;
    }
  },

  // 写缓存 + 同步 localStorage + 同步本地文件
  async add(record) {
    const id = await this.addToCache(record);
    record.id = id;
    await this.saveLS();
    await this.syncToFile();
    return id;
  },

  async update(id, updates) {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const req = store.get(id);
      req.onsuccess = () => {
        const record = req.result;
        if (!record) { reject(new Error('记录不存在')); return; }
        Object.assign(record, updates);
        store.put(record).onsuccess = () => resolve();
      };
      req.onerror = () => reject(req.error);
    });
    await this.saveLS();
    await this.syncToFile();
  },

  async delete(id) {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    await this.saveLS();
    await this.syncToFile();
  },

  getAll() {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  },

  getById(id) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).get(id);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  },

  getByDate(dateStr) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const idx = store.index('date');
      const req = idx.getAll(dateStr);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  },

  clearAll() {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  },

  /** 把当前 IndexedDB 所有记录同步写入本地 JSON 文件（防抖合并） */
  async syncToFile() {
    if (!dirHandle || !dirHandleGranted) return false;
    // 防抖：如果正在写，标记为待写（下一次写完后再写一次最新全量）
    if (pendingWrites) { return true; }
    pendingWrites = true;
    try {
      const records = await this.getAll();
      await FS.writeFile(records);
    } catch (e) {
      console.error('同步本地文件失败:', e);
    } finally {
      pendingWrites = false;
    }
    return true;
  }
};

/* ====================
   工具函数
   ==================== */

function formatDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function formatTime(date) {
  const h = String(date.getHours()).padStart(2, '0');
  const m = String(date.getMinutes()).padStart(2, '0');
  return `${h}:${m}`;
}

function formatMoney(n) {
  return n.toFixed(2);
}

function getWeekday(dateStr) {
  const days = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  return days[new Date(dateStr).getDay()];
}

function showToast(message) {
  const toast = document.createElement('div');
  toast.textContent = message;
  toast.style.cssText = `
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    background: rgba(0,0,0,0.8);
    color: white;
    padding: 0.75rem 1.5rem;
    border-radius: 0.5rem;
    font-size: 0.875rem;
    z-index: 3000;
    animation: fadeIn 0.2s;
  `;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 2000);
}

/* ====================
   数据统计
   ==================== */

const Stats = {
  async byDate(dateStr) {
    const records = await DB.getByDate(dateStr);
    const income = records.filter(r => r.type === 'income').reduce((s, r) => s + r.amount, 0);
    const expense = records.filter(r => r.type === 'expense').reduce((s, r) => s + r.amount, 0);
    const weekday = getWeekday(dateStr);
    return { date: dateStr, weekday, income, expense, net: income - expense, count: records.length };
  },

  async byMonth(year, month) {
    const all = await DB.getAll();
    const prefix = `${year}-${String(month).padStart(2, '0')}`;
    const records = all.filter(r => r.date.startsWith(prefix));
    const income = records.filter(r => r.type === 'income').reduce((s, r) => s + r.amount, 0);
    const expense = records.filter(r => r.type === 'expense').reduce((s, r) => s + r.amount, 0);
    return { year, month, income, expense, net: income - expense, count: records.length };
  },

  async byYear(year) {
    const all = await DB.getAll();
    const records = all.filter(r => r.date.startsWith(String(year)));
    const totalIncome = records.filter(r => r.type === 'income').reduce((s, r) => s + r.amount, 0);
    const totalExpense = records.filter(r => r.type === 'expense').reduce((s, r) => s + r.amount, 0);

    const monthly = {};
    for (let m = 1; m <= 12; m++) {
      const mPrefix = `${year}-${String(m).padStart(2, '0')}`;
      const mRecords = all.filter(r => r.date.startsWith(mPrefix));
      const mIncome = mRecords.filter(r => r.type === 'income').reduce((s, r) => s + r.amount, 0);
      const mExpense = mRecords.filter(r => r.type === 'expense').reduce((s, r) => s + r.amount, 0);
      monthly[m] = { income: mIncome, expense: mExpense, net: mIncome - mExpense };
    }

    return { year, totalIncome, totalExpense, totalNet: totalIncome - totalExpense, monthly };
  }
};

/* ====================
   主应用
   ==================== */

const App = {
  // 状态
  currentType: 'expense',
  summaryView: 'day',
  summaryDate: null,
  detailShowAll: false,
  editingId: null,
  editType: 'expense',
  detailYear: null,
  detailMonth: null,

  /* ---- 初始化 ---- */
  async init() {
    try {
      await DB.init();
      // 尝试恢复本地目录句柄（不阻塞 UI）
      this.restoreStorage();
      this.initDates();
      this.bindEvents();
      this.showLoading(false);
      // 渲染存储状态
      this.renderStorageStatus();
    } catch (e) {
      console.error('初始化失败:', e);
      alert('初始化失败: ' + e.message);
    }
  },

  /**
   * 启动时恢复目录权限 + 合并数据
   * 恢复策略（安全优先，绝不丢数据）：
   *   1. IndexedDB 没数据？→ 从 localStorage 快照恢复
   *   2. 有 CSV 权限？→ 把 CSV 和当前数据做合并（ID 并集，不覆盖）
   *   3. 没 CSV 权限？→ 就用 IndexedDB/localStorage 的数据
   */
  async restoreStorage() {
    try {
      // Step 1: localStorage 快照兜底
      const dbRecords = await DB.getAll();
      if (dbRecords.length === 0) {
        const restored = await DB.restoreFromLS();
        if (restored > 0) {
          console.log(`[restoreStorage] IndexedDB 空，从 localStorage 快照恢复了 ${restored} 条`);
        }
      }

      // Step 2: 恢复目录句柄 + 合并 CSV
      const r = await FS.restoreAndCheck();
      this.storagePermission = r.permission;
      this.storageHandleName = r.handle ? r.handle.name : null;

      if (r.permission === 'granted') {
        // 已经有权限，syncFromFile 做安全合并
        const m = await FS.syncFromFile();
        if (m.added > 0) {
          console.log(`[restoreStorage] 从 CSV 补回 ${m.added} 条，保留 ${m.kept} 条本地记录`);
        }
        // 合并完再存一次 localStorage
        await DB.saveLS();
      } else if (r.handle && r.permission === 'prompt') {
        // 句柄还在但权限过期，不做破坏性操作
        // IndexedDB/localStorage 的数据继续用，等用户点「重新授权」再合并 CSV
        console.log('[restoreStorage] 目录权限已过期，等用户授权后再合并 CSV');
      }

      this.renderStorageStatus();
    } catch (e) {
      console.error('恢复存储失败:', e);
    }
  },

  /* ---- 存储设置 ---- */

  /** 用户选择一个本地目录作为数据存储位置 */
  async setStorageLocation() {
    const old = this.storageHandleName;
    const handle = await FS.pickDirectory();
    if (handle) {
      this.storagePermission = 'granted';
      this.storageHandleName = handle.name;
      this.renderStorageStatus();
      // 首次设置时，如果 IndexedDB 里有老数据而新目录空，做一次同步
      if (old === null) {
        const localRecords = await FS.readFile();
        if (localRecords && localRecords.length === 0) {
          const cached = await DB.getAll();
          if (cached.length > 0) {
            await FS.writeFile(cached);
            showToast(`已将 ${cached.length} 条旧数据迁移到新目录`);
          }
        }
      }
    }
  },

  /** 重新请求已有目录的写权限（浏览器安全模型要求用户手势） */
  async reauthStorage() {
    const ok = await FS.requestPermission();
    if (ok) {
      this.storagePermission = 'granted';
      this.renderStorageStatus();
    }
  },

  /** 清除存储设置（不删数据文件，只解绑浏览器） */
  async clearStorageLocation() {
    if (!confirm('确定要解绑本地存储吗？\n（不会删除磁盘上的数据文件，只是解除浏览器关联）')) return;
    await FS.clear();
    this.storagePermission = 'missing';
    this.storageHandleName = null;
    this.renderStorageStatus();
    showToast('已解绑本地存储');
  },

  /** 在首页和关于弹窗里渲染存储状态 */
  renderStorageStatus() {
    const bar = document.getElementById('storageStatusBar');
    const aboutStorage = document.getElementById('aboutStorageInfo');
    const perm = this.storagePermission || 'missing';

    let html = '';
    if (perm === 'granted') {
      html = `<span class="ss-dot ok"></span>本地: <b>${this.storageHandleName || '(已连接)'}</b>`;
    } else if (perm === 'prompt') {
      html = `<span class="ss-dot warn"></span>本地目录已保存，需要<b onclick="App.reauthStorage()" style="text-decoration:underline;cursor:pointer;">重新授权</b>`;
    } else if (perm === 'denied') {
      html = `<span class="ss-dot bad"></span>本地目录权限已被拒绝，<b onclick="App.setStorageLocation()" style="text-decoration:underline;cursor:pointer;">重新选择目录</b>`;
    } else {
      if (FS.isSupported()) {
        html = `<span class="ss-dot"></span>未开启本地存储 <b onclick="App.setStorageLocation()" style="text-decoration:underline;cursor:pointer;">[选择目录]</b>`;
      } else {
        html = `<span class="ss-dot"></span>浏览器不支持本地文件访问（建议用 Chrome/Edge）`;
      }
    }

    if (bar) {
      bar.innerHTML = html;
      bar.classList.remove('ss-granted', 'ss-prompt', 'ss-denied', 'ss-missing');
      bar.classList.add(`ss-${perm === 'granted' ? 'granted' : perm === 'prompt' ? 'prompt' : perm === 'denied' ? 'denied' : 'missing'}`);
    }
    if (aboutStorage) {
      const supported = FS.isSupported();
      const extra = supported
        ? '<br><button class="home-btn small" onclick="App.setStorageLocation()">📁 选择本地目录</button>'
        : '<br><span style="color:var(--color-expense);">当前浏览器不支持 File System Access API</span><br>请使用 <b>Chrome / Edge / Opera</b> 桌面版';
      const clearBtn = (perm === 'granted' || perm === 'prompt')
        ? '<br><button class="home-btn small" style="background:var(--color-expense);" onclick="App.clearStorageLocation()">解绑本地存储</button>'
        : '';
      aboutStorage.innerHTML = `
        <p><b>存储位置</b></p>
        <p style="color:var(--color-text-secondary);font-size:0.8125rem;">${html}</p>
        <p style="color:var(--color-text-hint);font-size:0.75rem;margin-top:0.25rem;">开启本地存储后，数据将写入你选的目录下的 <code>ledger_data.csv</code>，清浏览器缓存不会丢数据。</p>
        ${extra}
        ${clearBtn}
      `;
    }
  },

  initDates() {
    const now = new Date();
    this.summaryDate = formatDate(now);
    this.detailYear = now.getFullYear();
    this.detailMonth = now.getMonth() + 1;
  },

  showLoading(show) {
    const overlay = document.getElementById('loadingOverlay');
    if (show) overlay.classList.remove('hidden');
    else overlay.classList.add('hidden');
  },

  bindEvents() {
    const source = document.getElementById('inputSource');
    const amount = document.getElementById('inputAmount');

    source.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') amount.focus();
    });

    amount.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') this.addRecord();
    });
  },

  /* ---- 页面切换 ---- */
  showPage(pageName) {
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    document.getElementById(`page-${pageName}`).classList.add('active');

    // 更新底部导航
    document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
    const tabMap = { record: 'tabRecord', summary: 'tabSummary', detail: 'tabDetail' };
    if (tabMap[pageName]) {
      document.getElementById(tabMap[pageName]).classList.add('active');
    }

    // 刷新页面数据
    if (pageName === 'record') this.refreshRecordPage();
    if (pageName === 'summary') this.refreshSummaryPage();
    if (pageName === 'detail') this.refreshDetailPage();
  },

  /* ---- 记账页 ---- */
  setType(type) {
    this.currentType = type;
    const btnExp = document.getElementById('btnExpense');
    const btnInc = document.getElementById('btnIncome');
    const addBtn = document.getElementById('addBtn');
    btnExp.classList.toggle('active', type === 'expense');
    btnExp.classList.toggle('expense', true);
    btnInc.classList.toggle('active', type === 'income');
    btnInc.classList.toggle('income', true);
    // 确认按钮跟随类型变色
    if (addBtn) {
      addBtn.style.background = type === 'expense'
        ? 'var(--color-expense)'
        : 'var(--color-income)';
    }
  },

  async addRecord() {
    const source = document.getElementById('inputSource').value.trim();
    const amountText = document.getElementById('inputAmount').value.trim();

    if (!source) { showToast('请输入物品/来源'); return; }
    if (!amountText) { showToast('请输入金额'); return; }

    const amount = parseFloat(amountText);
    if (amount <= 0) { showToast('金额必须大于0'); return; }

    const now = new Date();
    const record = {
      date: formatDate(now),
      time: formatTime(now),
      source: source,
      amount: amount,
      type: this.currentType,
      checked: false
    };

    try {
      await DB.add(record);
      document.getElementById('inputSource').value = '';
      document.getElementById('inputAmount').value = '';
      this.refreshRecordPage();
    } catch (e) {
      alert('添加失败: ' + e.message);
    }
  },

  async toggleChecked(id) {
    try {
      const record = await DB.getById(id);
      if (record) {
        await DB.update(id, { checked: !record.checked });
        this.refreshRecordPage();
      }
    } catch (e) {
      alert('操作失败');
    }
  },

  async deleteRecord(id) {
    if (!confirm('确定要删除这条记录吗？')) return;
    try {
      await DB.delete(id);
      this.refreshRecordPage();
    } catch (e) {
      alert('删除失败');
    }
  },

  async refreshRecordPage() {
    const now = new Date();
    const today = formatDate(now);
    const weekday = getWeekday(today);
    document.getElementById('recordDateLabel').textContent = `${today} ${weekday}`;

    const todayRecords = await DB.getByDate(today);
    const income = todayRecords.filter(r => r.type === 'income').reduce((s, r) => s + r.amount, 0);
    const expense = todayRecords.filter(r => r.type === 'expense').reduce((s, r) => s + r.amount, 0);
    const net = income - expense;

    document.getElementById('todayIncome').textContent = `+${formatMoney(income)}`;
    document.getElementById('todayExpense').textContent = `-${formatMoney(expense)}`;
    const netEl = document.getElementById('todayNet');
    netEl.textContent = `${net >= 0 ? '+' : ''}${formatMoney(net)}`;
    netEl.style.color = net >= 0 ? '' : 'var(--color-expense)';

    // 渲染列表
    const listEl = document.getElementById('recordList');
    listEl.innerHTML = '';

    if (todayRecords.length === 0) {
      listEl.innerHTML = '<div class="empty">今日暂无记录，点击上方添加</div>';
      return;
    }

    const sorted = [...todayRecords].sort((a, b) => b.time.localeCompare(a.time));
    sorted.forEach(record => {
      listEl.appendChild(this.createRecordItem(record));
    });
  },

  createRecordItem(record) {
    const item = document.createElement('div');
    item.className = 'record-item';

    const check = document.createElement('div');
    check.className = `record-check ${record.type}${record.checked ? ' checked' : ''}`;
    check.textContent = record.checked ? '✓' : '○';
    check.onclick = () => this.toggleChecked(record.id);

    const info = document.createElement('div');
    info.className = 'record-info';

    const source = document.createElement('div');
    source.className = `record-source${record.checked ? ' checked' : ''}`;
    source.textContent = record.source;
    info.appendChild(source);

    const time = document.createElement('div');
    time.className = 'record-time';
    time.textContent = record.time;
    info.appendChild(time);

    const amount = document.createElement('div');
    amount.className = `record-amount ${record.type}`;
    amount.textContent = `${record.type === 'income' ? '+' : '-'}${formatMoney(record.amount)}`;

    const actions = document.createElement('div');
    actions.className = 'record-actions';

    const btnEdit = document.createElement('button');
    btnEdit.className = 'btn-edit';
    btnEdit.innerHTML = '✎';
    btnEdit.onclick = () => this.openEdit(record.id);

    const btnDel = document.createElement('button');
    btnDel.className = 'btn-delete';
    btnDel.innerHTML = '×';
    btnDel.onclick = () => this.deleteRecord(record.id);

    actions.appendChild(btnEdit);
    actions.appendChild(btnDel);

    item.appendChild(check);
    item.appendChild(info);
    item.appendChild(amount);
    item.appendChild(actions);

    return item;
  },

  /* ---- 编辑弹窗 ---- */
  async openEdit(id) {
    try {
      const record = await DB.getById(id);
      if (!record) return;
      this.editingId = id;
      this.editType = record.type;

      document.getElementById('editSource').value = record.source;
      document.getElementById('editAmount').value = record.amount;

      this.setEditTypeUI(record.type);
      document.getElementById('editModal').classList.add('show');
    } catch (e) {
      alert('加载失败');
    }
  },

  setEditType(type) {
    this.editType = type;
    this.setEditTypeUI(type);
  },

  setEditTypeUI(type) {
    const btnExp = document.getElementById('editExpense');
    const btnInc = document.getElementById('editIncome');
    btnExp.classList.toggle('active', type === 'expense');
    btnInc.classList.toggle('active', type === 'income');
  },

  closeEdit() {
    this.editingId = null;
    document.getElementById('editModal').classList.remove('show');
  },

  async saveEdit() {
    if (this.editingId === null) return;

    const source = document.getElementById('editSource').value.trim();
    const amountText = document.getElementById('editAmount').value.trim();

    if (!source) { showToast('请输入来源/物品名称'); return; }
    if (!amountText) { showToast('请输入金额'); return; }

    const amount = parseFloat(amountText);
    if (amount <= 0) { showToast('金额必须大于0'); return; }

    try {
      await DB.update(this.editingId, { source, amount, type: this.editType });
      this.closeEdit();

      // 刷新当前页面
      const activePage = document.querySelector('.page.active').id.replace('page-', '');
      if (activePage === 'record') this.refreshRecordPage();
      else if (activePage === 'summary') this.refreshSummaryPage();
      else if (activePage === 'detail') this.refreshDetailPage();
    } catch (e) {
      alert('保存失败: ' + e.message);
    }
  },

  async deleteEdit() {
    if (this.editingId === null) return;
    if (!confirm('确定要删除这条记录吗？')) return;

    try {
      await DB.delete(this.editingId);
      this.closeEdit();

      const activePage = document.querySelector('.page.active').id.replace('page-', '');
      if (activePage === 'record') this.refreshRecordPage();
      else if (activePage === 'summary') this.refreshSummaryPage();
      else if (activePage === 'detail') this.refreshDetailPage();
    } catch (e) {
      alert('删除失败');
    }
  },

  /* ---- 总结页 ---- */
  setSummaryView(view) {
    this.summaryView = view;
    document.querySelectorAll('#viewDay, #viewMonth, #viewYear').forEach(btn => btn.classList.remove('active'));
    const map = { day: 'viewDay', month: 'viewMonth', year: 'viewYear' };
    document.getElementById(map[view]).classList.add('active');

    const now = new Date();
    if (view === 'day') {
      this.summaryDate = formatDate(now);
    } else if (view === 'month') {
      const [year, month] = this.summaryDate.split('-').map(Number);
      this.summaryYear = year;
      this.summaryMonth = month;
      this.summaryDate = null;
    } else {
      const [year] = (this.summaryYear || String(now.getFullYear())).split('-').map(Number);
      this.summaryYear = year || now.getFullYear();
      this.summaryDate = null;
    }

    this.refreshSummaryPage();
  },

  navSummary(direction) {
    if (this.summaryView === 'day') {
      const d = new Date(this.summaryDate);
      d.setDate(d.getDate() + direction);
      this.summaryDate = formatDate(d);
    } else if (this.summaryView === 'month') {
      this.summaryMonth += direction;
      if (this.summaryMonth < 1) { this.summaryMonth = 12; this.summaryYear--; }
      if (this.summaryMonth > 12) { this.summaryMonth = 1; this.summaryYear++; }
    } else {
      this.summaryYear += direction;
    }
    this.refreshSummaryPage();
  },

  async refreshSummaryPage() {
    const label = document.getElementById('summaryDateLabel');
    let income, expense, net;

    if (this.summaryView === 'day') {
      const d = new Date(this.summaryDate);
      const weekday = getWeekday(this.summaryDate);
      label.textContent = `${this.summaryDate} ${weekday}`;
      const s = await Stats.byDate(this.summaryDate);
      income = s.income; expense = s.expense; net = s.net;
    } else if (this.summaryView === 'month') {
      label.textContent = `${this.summaryYear}年${this.summaryMonth}月`;
      const s = await Stats.byMonth(this.summaryYear, this.summaryMonth);
      income = s.income; expense = s.expense; net = s.net;
    } else {
      label.textContent = `${this.summaryYear}年`;
      const s = await Stats.byYear(this.summaryYear);
      income = s.totalIncome; expense = s.totalExpense; net = s.totalNet;
    }

    document.getElementById('summaryIncome').textContent = `+${formatMoney(income)}`;
    document.getElementById('summaryExpense').textContent = `-${formatMoney(expense)}`;
    const netEl = document.getElementById('summaryNet');
    netEl.textContent = `${net >= 0 ? '+' : ''}${formatMoney(net)}`;
    netEl.style.color = net >= 0 ? '' : 'var(--color-expense)';

    const content = document.getElementById('summaryContent');
    content.innerHTML = '';

    if (this.summaryView === 'day') {
      const records = await DB.getByDate(this.summaryDate);
      records.sort((a, b) => a.time.localeCompare(b.time));
      if (records.length === 0) {
        content.innerHTML = '<div class="empty">该日暂无记录</div>';
        return;
      }
      records.forEach(r => content.appendChild(this.createSummaryItem(r)));
    } else if (this.summaryView === 'month') {
      const all = await DB.getAll();
      const prefix = `${this.summaryYear}-${String(this.summaryMonth).padStart(2, '0')}`;
      const records = all.filter(r => r.date.startsWith(prefix));
      if (records.length === 0) {
        content.innerHTML = '<div class="empty">该月暂无记录</div>';
        return;
      }
      const grouped = {};
      records.forEach(r => {
        if (!grouped[r.date]) grouped[r.date] = [];
        grouped[r.date].push(r);
      });

      Object.keys(grouped).sort().reverse().forEach(date => {
        const dayRecords = grouped[date];
        const s = Stats.byDate(date);
        // 同步调用需要用异步，简化处理
        const income = dayRecords.filter(r => r.type === 'income').reduce((s, r) => s + r.amount, 0);
        const expense = dayRecords.filter(r => r.type === 'expense').reduce((s, r) => s + r.amount, 0);
        const weekday = getWeekday(date);

        const header = document.createElement('div');
        header.className = 'date-header';
        header.innerHTML = `<span>${date} ${weekday}</span><span class="summary">收+${formatMoney(income)} 支-${formatMoney(expense)}</span>`;
        content.appendChild(header);

        dayRecords.sort((a, b) => a.time.localeCompare(b.time));
        dayRecords.forEach(r => content.appendChild(this.createSummaryItem(r)));
      });
    } else {
      const yearData = await Stats.byYear(this.summaryYear);
      const hasData = Object.values(yearData.monthly).some(m => m.income > 0 || m.expense > 0);
      if (!hasData) {
        content.innerHTML = '<div class="empty">该年暂无记录</div>';
        return;
      }

      const monthNames = ['一月', '二月', '三月', '四月', '五月', '六月', '七月', '八月', '九月', '十月', '十一月', '十二月'];
      for (let m = 1; m <= 12; m++) {
        const data = yearData.monthly[m];
        if (data.income === 0 && data.expense === 0) continue;

        const item = document.createElement('div');
        item.className = 'month-item';
        const netColor = data.net >= 0 ? 'var(--color-text)' : 'var(--color-expense)';
        item.innerHTML = `
          <div class="month-name">${monthNames[m - 1]}</div>
          <div class="month-stats">
            <span>收 +${formatMoney(data.income)}</span>
            <span>支 -${formatMoney(data.expense)}</span>
            <span style="color:${netColor};font-weight:600;">净 ${data.net >= 0 ? '+' : ''}${formatMoney(data.net)}</span>
          </div>
        `;
        content.appendChild(item);
      }
    }
  },

  createSummaryItem(record) {
    const item = document.createElement('div');
    item.className = 'card';
    const isIncome = record.type === 'income';
    const color = isIncome ? 'var(--color-income)' : 'var(--color-expense)';
    const icon = isIncome ? '↓' : '↑';

    item.innerHTML = `
      <span class="item-icon" style="color:${color};">${icon}</span>
      <span class="item-name">${record.source}</span>
      <span class="item-time">${record.time}</span>
      <span class="item-amount" style="color:${color};">${isIncome ? '+' : '-'}${formatMoney(record.amount)}</span>
    `;

    return item;
  },

  /* ---- 明细页 ---- */
  detailNav(direction) {
    this.detailShowAll = false;
    this.detailMonth += direction;
    if (this.detailMonth < 1) { this.detailMonth = 12; this.detailYear--; }
    if (this.detailMonth > 12) { this.detailMonth = 1; this.detailYear++; }
    document.getElementById('showAllBtn').classList.remove('active');
    document.getElementById('showAllBtn').style.background = '';
    this.refreshDetailPage();
  },

  toggleShowAll() {
    this.detailShowAll = !this.detailShowAll;
    const btn = document.getElementById('showAllBtn');
    btn.classList.toggle('active');
    btn.style.background = this.detailShowAll ? 'var(--color-primary)' : '';
    this.refreshDetailPage();
  },

  async refreshDetailPage() {
    const label = document.getElementById('detailLabel');
    label.textContent = this.detailShowAll ? '全部记录' : `${this.detailYear}年${this.detailMonth}月`;

    let records;
    if (this.detailShowAll) {
      records = await DB.getAll();
    } else {
      const prefix = `${this.detailYear}-${String(this.detailMonth).padStart(2, '0')}`;
      const all = await DB.getAll();
      records = all.filter(r => r.date.startsWith(prefix));
    }

    const income = records.filter(r => r.type === 'income').reduce((s, r) => s + r.amount, 0);
    const expense = records.filter(r => r.type === 'expense').reduce((s, r) => s + r.amount, 0);
    const net = income - expense;

    document.getElementById('detailIncome').textContent = `+${formatMoney(income)}`;
    document.getElementById('detailExpense').textContent = `-${formatMoney(expense)}`;
    const netEl = document.getElementById('detailNet');
    netEl.textContent = `${net >= 0 ? '+' : ''}${formatMoney(net)}`;
    netEl.style.color = net >= 0 ? '' : 'var(--color-expense)';

    const content = document.getElementById('detailContent');
    content.innerHTML = '';

    if (records.length === 0) {
      content.innerHTML = '<div class="empty">暂无记录</div>';
      return;
    }

    const grouped = {};
    records.forEach(r => {
      if (!grouped[r.date]) grouped[r.date] = [];
      grouped[r.date].push(r);
    });

    // 降序排列日期
    const dates = Object.keys(grouped).sort().reverse();
    for (const date of dates) {
      const dayRecords = grouped[date];
      const income = dayRecords.filter(r => r.type === 'income').reduce((s, r) => s + r.amount, 0);
      const expense = dayRecords.filter(r => r.type === 'expense').reduce((s, r) => s + r.amount, 0);
      const weekday = getWeekday(date);

      const header = document.createElement('div');
      header.className = 'date-header';
      header.innerHTML = `<span>${date} ${weekday}</span><span class="summary">收+${formatMoney(income)} 支-${formatMoney(expense)}</span>`;
      content.appendChild(header);

      dayRecords.sort((a, b) => b.time.localeCompare(a.time));
      dayRecords.forEach(r => content.appendChild(this.createDetailItem(r)));
    }
  },

  createDetailItem(record) {
    const item = document.createElement('div');
    item.className = 'record-item';

    const isIncome = record.type === 'income';
    const color = isIncome ? 'var(--color-income)' : 'var(--color-expense)';

    item.innerHTML = `
      <span style="color:${color};font-size:0.625rem;margin-right:0.25rem;font-weight:700;">${isIncome ? '↓' : '↑'}</span>
      <span style="flex:1;font-size:0.8125rem;">${record.source}</span>
      <span style="font-size:0.6875rem;color:var(--color-text-hint);margin-right:0.375rem;">${record.time}</span>
      <span style="color:${color};font-weight:700;font-size:0.8125rem;margin-right:0.25rem;">${isIncome ? '+' : '-'}${formatMoney(record.amount)}</span>
    `;

    const actions = document.createElement('div');
    actions.className = 'record-actions';
    actions.style.marginRight = '0.5rem';

    const btnEdit = document.createElement('button');
    btnEdit.className = 'btn-edit';
    btnEdit.innerHTML = '✎';
    btnEdit.onclick = (e) => { e.stopPropagation(); this.openEdit(record.id); };

    const btnDel = document.createElement('button');
    btnDel.className = 'btn-delete';
    btnDel.innerHTML = '×';
    btnDel.onclick = (e) => {
      e.stopPropagation();
      this.deleteRecord(record.id);
    };

    actions.appendChild(btnEdit);
    actions.appendChild(btnDel);
    item.appendChild(actions);

    return item;
  },

  /* ---- 统计弹窗 ---- */
  async showStats() {
    const records = await DB.getAll();
    const totalIncome = records.filter(r => r.type === 'income').reduce((s, r) => s + r.amount, 0);
    const totalExpense = records.filter(r => r.type === 'expense').reduce((s, r) => s + r.amount, 0);
    const totalNet = totalIncome - totalExpense;

    // 计算统计
    const stats = {
      total: records.length,
      totalIncome,
      totalExpense,
      totalNet,
      daysWithRecords: new Set(records.map(r => r.date)).size,
      avgDailyIncome: totalIncome / Math.max(new Set(records.map(r => r.date)).size, 1),
      avgDailyExpense: totalExpense / Math.max(new Set(records.map(r => r.date)).size, 1)
    };

    document.getElementById('statsContent').innerHTML = `
      <div class="stat-item"><span>总记录数</span><span>${stats.total} 条</span></div>
      <div class="stat-item"><span>有记录天数</span><span>${stats.daysWithRecords} 天</span></div>
      <div class="stat-item"><span>总收入</span><span class="stat-value income">+${formatMoney(totalIncome)}</span></div>
      <div class="stat-item"><span>总支出</span><span class="stat-value expense">-${formatMoney(totalExpense)}</span></div>
      <div class="stat-item"><span>净收入</span><span class="stat-value ${totalNet >= 0 ? 'income' : 'expense'}">${totalNet >= 0 ? '+' : ''}${formatMoney(totalNet)}</span></div>
    `;

    document.getElementById('statsModal').classList.add('show');
  },

  closeStats() {
    document.getElementById('statsModal').classList.remove('show');
  },

  /* ---- 关于弹窗 ---- */
  showAbout() {
    this.renderStorageStatus();
    document.getElementById('aboutModal').classList.add('show');
  },

  closeAbout() {
    document.getElementById('aboutModal').classList.remove('show');
  },

  /* ---- CSV导出 ---- */
  async exportCSV() {
    const records = await DB.getAll();
    if (records.length === 0) {
      alert('暂无数据可导出');
      return;
    }

    // 按日期排序
    records.sort((a, b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time));

    let csv = '\uFEFFid,date,time,source,amount,type,checked\n';
    records.forEach(r => {
      csv += `${r.id},${r.date},${r.time},"${r.source.replace(/"/g, '""')}",${r.amount},${r.type},${r.checked ? 'true' : 'false'}\n`;
    });

    // 创建下载
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `账本_${formatDate(new Date())}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

  }
};

/* ====================
   启动
   ==================== */

document.addEventListener('DOMContentLoaded', async () => {
  try {
    await App.init();
    App.showPage('record');
  } catch (e) {
    console.error('启动失败:', e);
    alert('启动失败: ' + e.message);
  }
});
