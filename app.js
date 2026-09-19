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
let pendingWrites = false;   // 是否有一次写盘正在进行
let writeDirty = false;      // 写盘期间是否又有新数据需要补写

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

  /**
   * 把 CSV 文本解析回 records 数组
   * 兼容：BOM、\r\n、表头多余空格、Excel 写回的各种格式（日期/布尔值）
   */
  decode(text) {
    if (!text) return [];
    // 去掉 UTF-8 BOM
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    // 按行分割（兼容 \r\n 和 \n）
    const rows = this._splitRows(text);
    if (rows.length === 0) return [];
    // 表头统一 trim，避免 Excel 写回时带空格导致字段识别失败
    const headers = this._splitLine(rows[0]).map(h => h.trim());

    const records = [];
    for (let i = 1; i < rows.length; i++) {
      if (!rows[i].trim()) continue; // 跳过空行
      const cols = this._splitLine(rows[i]);
      const obj = {};
      let hasId = false;

      for (let j = 0; j < headers.length; j++) {
        const key = headers[j];
        if (!key) continue;
        const raw = (cols[j] !== undefined ? cols[j] : '').trim();

        if (key === 'id') {
          if (raw === '') continue;              // 缺 id 视为无效行
          const n = Number(raw);
          obj.id = Number.isFinite(n) ? n : raw; // 非数字则保留原值
          hasId = true;
        } else if (key === 'amount') {
          const n = Number(raw);
          obj.amount = Number.isFinite(n) ? n : 0;
        } else if (key === 'checked') {
          // Excel 会把布尔值写成 TRUE/FALSE
          obj.checked = /^(true|1|yes|是)$/i.test(raw);
        } else if (key === 'date') {
          obj.date = this._normalizeDate(raw);
        } else if (key === 'time') {
          obj.time = this._normalizeTime(raw);
        } else {
          obj[key] = raw;
        }
      }
      if (hasId) records.push(obj);
    }
    return records;
  },

  /** 把 Excel 可能写成的 2026/9/20、2026-09-20 00:00:00 统一成 2026-09-20 */
  _normalizeDate(v) {
    const s = String(v == null ? '' : v).trim();
    const m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(s);
    if (m) {
      return `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
    }
    return s;
  },

  /** 把 9:5、10:00:00 统一成 09:05、10:00 */
  _normalizeTime(v) {
    const s = String(v == null ? '' : v).trim();
    const m = /^(\d{1,2}):(\d{1,2})/.exec(s);
    if (m) {
      return `${String(m[1]).padStart(2, '0')}:${String(m[2]).padStart(2, '0')}`;
    }
    return s;
  },

  /**
   * 按行分割，但引号内的 \n 不是行分隔
   * 注意：这里只跟踪引号状态、原样保留字符，
   * 真正的反转义（"" → "）交给 _splitLine 做一次即可。
   * 若在此处也反转义，会和 _splitLine 叠加成"二次反转义"，把字段里的双引号吃掉。
   */
  _splitRows(text) {
    const rows = [];
    let cur = '';
    let inQuote = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (c === '"') {
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

  /**
   * 用户手势触发：重新请求权限
   * @param {boolean} silent 静默模式（顺带授权时用，不弹提示）
   */
  async requestPermission(silent = false) {
    if (!dirHandle) return false;
    try {
      const state = await dirHandle.requestPermission({ mode: 'readwrite' });
      if (state === 'granted') {
        dirHandleGranted = true;
        await this.ensureDataFile();
        await this.syncFromFile();
        if (!silent) showToast('已授权，数据同步完成');
        return true;
      } else {
        dirHandleGranted = false;
        if (!silent) showToast('授权被拒绝');
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
const LS_INSTALL_DISMISSED = 'ledger_install_dismissed_v1'; // 用户关掉过安装引导

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
      const json = JSON.stringify(records);
      // localStorage 约 5MB 上限，超大时跳过（IndexedDB 与 CSV 仍然是完整的）
      if (json.length > 4 * 1024 * 1024) {
        console.warn('记录过多，跳过 localStorage 快照（IndexedDB / CSV 不受影响）');
        return;
      }
      localStorage.setItem(LS_KEY, json);
    } catch (e) {
      console.warn('localStorage 快照失败（不影响主存储）:', e);
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

  /**
   * 把当前 IndexedDB 所有记录同步写入本地 CSV 文件
   * 写盘期间若又有新写入，会在本轮结束后自动再写一次（dirty 标记），
   * 保证不会因为"正在写"而静默丢掉最新数据。
   */
  async syncToFile() {
    if (!dirHandle || !dirHandleGranted) return false;
    if (pendingWrites) { writeDirty = true; return false; } // 标记待写，稍后补写
    pendingWrites = true;
    try {
      do {
        writeDirty = false;
        const records = await this.getAll();
        await FS.writeFile(records);
      } while (writeDirty);
    } catch (e) {
      console.error('同步本地文件失败:', e);
    } finally {
      pendingWrites = false;
      writeDirty = false;
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
  const v = Number(n);
  return (Number.isFinite(v) ? v : 0).toFixed(2);
}

/** 安全取日期字符串：CSV 里可能缺 date，直接用会崩 */
function dateOf(record) {
  return String((record && record.date) || '');
}

/** 安全取时间字符串 */
function timeOf(record) {
  return String((record && record.time) || '');
}

/**
 * 把 'YYYY-MM-DD' 按【本地时区】解析成 Date
 * 直接用 new Date('2026-09-20') 会按 UTC 解析，在西半球时区会整体偏一天，
 * 导致星期显示错误、日期导航原地踏步。
 */
function parseLocalDate(dateStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || ''));
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const d = new Date(dateStr);
  return isNaN(d.getTime()) ? new Date() : d;
}

function getWeekday(dateStr) {
  const days = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  return days[parseLocalDate(dateStr).getDay()];
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

/** 转义 HTML，避免用户可控文本（如目录名、来源）注入标签 */
function escapeHtml(v) {
  return String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
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
    const records = all.filter(r => dateOf(r).startsWith(prefix));
    const income = records.filter(r => r.type === 'income').reduce((s, r) => s + r.amount, 0);
    const expense = records.filter(r => r.type === 'expense').reduce((s, r) => s + r.amount, 0);
    return { year, month, income, expense, net: income - expense, count: records.length };
  },

  async byYear(year) {
    const all = await DB.getAll();
    const records = all.filter(r => dateOf(r).startsWith(String(year)));
    const totalIncome = records.filter(r => r.type === 'income').reduce((s, r) => s + r.amount, 0);
    const totalExpense = records.filter(r => r.type === 'expense').reduce((s, r) => s + r.amount, 0);

    const monthly = {};
    for (let m = 1; m <= 12; m++) {
      const mPrefix = `${year}-${String(m).padStart(2, '0')}`;
      const mRecords = all.filter(r => dateOf(r).startsWith(mPrefix));
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
  installPromptEvent: null, // beforeinstallprompt 事件（用于引导安装到桌面）

  /* ---- 初始化 ---- */
  async init() {
    try {
      await DB.init();
      this.initDates();
      this.bindEvents();
      this.showLoading(false);
      this.renderStorageStatus();
      // 异步恢复本地存储；完成后重绘当前页，
      // 否则从 CSV 恢复的数据要等用户切页才显示，容易误以为"数据丢了"
      this.restoreStorage()
        .then(() => this.refreshCurrentPage())
        .catch((e) => console.error('恢复存储失败:', e));
    } catch (e) {
      console.error('初始化失败:', e);
      alert('初始化失败: ' + e.message);
    }
  },

  /** 重绘当前所在页面 */
  refreshCurrentPage() {
    const active = document.querySelector('.page.active');
    if (!active) return;
    const name = active.id.replace('page-', '');
    if (name === 'record') this.refreshRecordPage();
    else if (name === 'summary') this.refreshSummaryPage();
    else if (name === 'detail') this.refreshDetailPage();
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
      } else if (r.handle && r.permission === 'prompt') {
        // 句柄还在但权限过期，不做破坏性操作
        // IndexedDB/localStorage 的数据继续用，等用户点「重新授权」再合并 CSV
        console.log('[restoreStorage] 目录权限已过期，等用户授权后再合并 CSV');
      }

      // 只有确实有数据时才刷新快照，避免把 localStorage 里仅存的备份覆盖成空
      if ((await DB.getAll()).length > 0) await DB.saveLS();

      this.renderStorageStatus();
    } catch (e) {
      console.error('恢复存储失败:', e);
    }
  },

  /* ---- 存储设置 ---- */

  /** 用户选择一个本地目录作为数据存储位置 */
  async setStorageLocation() {
    // 之前是否已经绑定过目录（只有首次绑定才需要做"迁移旧数据"）
    const hadBinding = this.storagePermission === 'granted' || this.storagePermission === 'prompt';
    const handle = await FS.pickDirectory();
    if (!handle) return;

    this.storagePermission = 'granted';
    this.storageHandleName = handle.name;
    this.renderStorageStatus();

    // 首次绑定：若新目录里 CSV 是空的，而浏览器里已有数据，迁移过去
    if (!hadBinding) {
      const fileRecords = await FS.readFile();
      if (fileRecords && fileRecords.length === 0) {
        const cached = await DB.getAll();
        if (cached.length > 0) {
          await FS.writeFile(cached);
          showToast(`已将 ${cached.length} 条数据迁移到新目录`);
        }
      }
    }

    // 绑定/合并不改动记录数时也要刷新页面，保证列表与磁盘一致
    this.refreshCurrentPage();
  },

  /** 重新请求已有目录的写权限（浏览器安全模型要求用户手势） */
  async reauthStorage() {
    const ok = await FS.requestPermission();
    if (ok) {
      this.storagePermission = 'granted';
      this.renderStorageStatus();
      this.refreshCurrentPage();
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

  /* ---- 安装引导 ----
     浏览器默认只给「本次会话」的文件权限，关掉标签页就失效。
     按 Chrome 官方方案，应用一旦被安装成 PWA，权限会自动长期保留，
     所以这里主动引导用户安装，从根上省掉反复授权。 */

  /** 是否已经处于"已安装"（独立窗口）状态 */
  isStandalone() {
    return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches)
      || window.navigator.standalone === true;
  },

  /** 浏览器给出安装能力时记下来并亮出引导条 */
  captureInstallPrompt(event) {
    event.preventDefault(); // 拦住浏览器自带的迷你提示，改用我们自己的引导条
    this.installPromptEvent = event;
    this.renderInstallBanner();
  },

  renderInstallBanner() {
    const el = document.getElementById('installBanner');
    if (!el) return;
    let dismissed = false;
    try { dismissed = localStorage.getItem(LS_INSTALL_DISMISSED) === '1'; } catch (e) { /* 忽略 */ }
    const show = !!this.installPromptEvent && !this.isStandalone() && !dismissed;
    el.classList.toggle('hidden', !show);
  },

  /** 触发浏览器原生安装弹窗 */
  async installApp() {
    if (!this.installPromptEvent) return;
    this.installPromptEvent.prompt();
    try { await this.installPromptEvent.userChoice; } catch (e) { /* 忽略 */ }
    this.installPromptEvent = null;
    this.renderInstallBanner();
  },

  dismissInstallBanner() {
    try { localStorage.setItem(LS_INSTALL_DISMISSED, '1'); } catch (e) { /* 忽略 */ }
    this.installPromptEvent = null;
    this.renderInstallBanner();
  },

  /** 安装完成：清掉引导条 */
  onAppInstalled() {
    this.installPromptEvent = null;
    this.renderInstallBanner();
  },

  /**
   * 在用户手势内顺带恢复文件权限。
   * 浏览器硬性要求 requestPermission() 必须由用户手势触发，
   * 而「点击保存」本身就是手势——在这里顺手把授权补上，
   * 用户就不必再单独点一次「重新授权」。
   */
  async ensureFileAccess() {
    if (!dirHandle || dirHandleGranted) return;
    const ok = await FS.requestPermission(true);
    if (ok) {
      this.storagePermission = 'granted';
      this.renderStorageStatus();
    }
  },

  /** 在记账页状态条和关于弹窗里渲染存储状态 */
  renderStorageStatus() {
    const bar = document.getElementById('storageStatusBar');
    const aboutStorage = document.getElementById('aboutStorageInfo');
    const perm = this.storagePermission || 'missing';
    const name = escapeHtml(this.storageHandleName || '');

    let html = '';
    if (perm === 'granted') {
      html = `<span class="ss-dot ok"></span>本地: <b>${name || '(已连接)'}</b>`;
    } else if (perm === 'prompt') {
      html = `<span class="ss-dot warn"></span>本地目录已保存，需要<b onclick="App.reauthStorage()" style="text-decoration:underline;cursor:pointer;">重新授权</b><span class="ss-hint">弹窗里选「每次访问时都允许」，以后就不用再点了</span>`;
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
        ? '<button class="storage-btn" onclick="App.setStorageLocation()">📁 选择本地目录</button>'
        : '<p style="color:var(--color-expense);">当前浏览器不支持 File System Access API</p><p>请使用 <b>Chrome / Edge / Opera</b> 桌面版</p>';
      const clearBtn = (perm === 'granted' || perm === 'prompt')
        ? '<button class="storage-btn danger" onclick="App.clearStorageLocation()">解绑本地存储</button>'
        : '';
      aboutStorage.innerHTML = `
        <p><b>存储位置</b></p>
        <p style="color:var(--color-text-secondary);font-size:0.8125rem;">${html}</p>
        <p style="color:var(--color-text-hint);font-size:0.75rem;margin-top:0.25rem;">开启本地存储后，数据会写入所选目录下的 <code>ledger_data.csv</code>，清浏览器缓存也不会丢。</p>
        <p style="color:var(--color-text-hint);font-size:0.75rem;">浏览器默认只给「本次会话」的文件权限，关掉标签页即失效——这是浏览器的安全设计，不是本应用的行为。想一次授权长期有效，二选一：<br>① 授权弹窗里选「<b>每次访问时都允许</b>」；<br>② 把本应用<b>安装到桌面</b>，安装后权限会自动保留。</p>
        <div class="storage-btn-row">${extra}${clearBtn}</div>
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
      await this.ensureFileAccess(); // 权限过期时顺手补授权（点保存本身就是手势）
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

    const sorted = [...todayRecords].sort((a, b) => timeOf(b).localeCompare(timeOf(a)));
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
    // CSS 需要 .active.expense / .active.income 才会着色，这里确保类型 class 始终存在
    btnExp.classList.add('expense');
    btnInc.classList.add('income');
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
      await this.ensureFileAccess(); // 权限过期时顺手补授权
      await DB.update(this.editingId, { source, amount, type: this.editType });
      this.closeEdit();
      this.refreshCurrentPage();
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
      this.refreshCurrentPage();
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

    // 统一取出"当前参考年月"，避免 summaryDate(null) / summaryYear(number) 混用导致崩溃
    let refYear = Number(this.summaryYear);
    let refMonth = Number(this.summaryMonth);
    if (!Number.isFinite(refYear)) {
      const base = parseLocalDate(this.summaryDate || formatDate(now));
      refYear = base.getFullYear();
      refMonth = base.getMonth() + 1;
    }
    if (!Number.isFinite(refMonth) || refMonth < 1 || refMonth > 12) refMonth = now.getMonth() + 1;

    if (view === 'day') {
      this.summaryDate = /^\d{4}-\d{2}-\d{2}$/.test(String(this.summaryDate))
        ? this.summaryDate
        : formatDate(now);
      this.summaryYear = parseLocalDate(this.summaryDate).getFullYear();
      this.summaryMonth = parseLocalDate(this.summaryDate).getMonth() + 1;
    } else if (view === 'month') {
      this.summaryYear = refYear;
      this.summaryMonth = refMonth;
    } else {
      this.summaryYear = refYear;
    }

    this.refreshSummaryPage();
  },

  navSummary(direction) {
    const step = Number(direction) || 0;
    if (this.summaryView === 'day') {
      const d = parseLocalDate(this.summaryDate);
      d.setDate(d.getDate() + step);
      this.summaryDate = formatDate(d);
      this.summaryYear = d.getFullYear();
      this.summaryMonth = d.getMonth() + 1;
    } else if (this.summaryView === 'month') {
      this.summaryYear = Number(this.summaryYear) || new Date().getFullYear();
      this.summaryMonth = (Number(this.summaryMonth) || 1) + step;
      if (this.summaryMonth < 1) { this.summaryMonth = 12; this.summaryYear--; }
      if (this.summaryMonth > 12) { this.summaryMonth = 1; this.summaryYear++; }
    } else {
      this.summaryYear = (Number(this.summaryYear) || new Date().getFullYear()) + step;
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
      records.sort((a, b) => timeOf(a).localeCompare(timeOf(b)));
      if (records.length === 0) {
        content.innerHTML = '<div class="empty">该日暂无记录</div>';
        return;
      }
      records.forEach(r => content.appendChild(this.createSummaryItem(r)));
    } else if (this.summaryView === 'month') {
      const all = await DB.getAll();
      const prefix = `${this.summaryYear}-${String(this.summaryMonth).padStart(2, '0')}`;
      const records = all.filter(r => dateOf(r).startsWith(prefix));
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

        dayRecords.sort((a, b) => timeOf(a).localeCompare(timeOf(b)));
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
      records = all.filter(r => dateOf(r).startsWith(prefix));
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

      dayRecords.sort((a, b) => timeOf(b).localeCompare(timeOf(a)));
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
    const all = await DB.getAll();
    if (all.length === 0) {
      alert('暂无数据可导出');
      return;
    }

    // 按日期 + 时间排序（不修改原数组）
    const records = [...all].sort((a, b) =>
      dateOf(a).localeCompare(dateOf(b)) || timeOf(a).localeCompare(timeOf(b))
    );

    // 复用统一的 CSV 编码器，保证与本地存储文件格式完全一致
    const csv = CSV.encode(records);

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

// 安装引导：装成 PWA 后浏览器会自动长期保留文件权限，从根上省掉反复授权。
// 放在顶层注册（而不是 DOMContentLoaded 里），避免事件比 DOMContentLoaded 更早触发时漏接。
window.addEventListener('beforeinstallprompt', (e) => App.captureInstallPrompt(e));
window.addEventListener('appinstalled', () => App.onAppInstalled());

document.addEventListener('DOMContentLoaded', async () => {
  try {
    await App.init();
    App.showPage('record');
  } catch (e) {
    console.error('启动失败:', e);
    alert('启动失败: ' + e.message);
  }
});
