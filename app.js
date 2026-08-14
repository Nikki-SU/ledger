/* ============================================
   账本 - 核心逻辑
   使用 IndexedDB 存储数据
   ============================================ */

const DB_NAME = 'LedgerDB';
const DB_VERSION = 1;
const STORE_NAME = 'records';

let db = null;

/* ====================
   IndexedDB 封装
   ==================== */


// 兼容性检测
const supportsIndexedDB = typeof indexedDB !== 'undefined';
const supportsLocalStorage = typeof localStorage !== 'undefined';

// 如果不支持 IndexedDB，使用 localStorage 降级
if (!supportsIndexedDB && supportsLocalStorage) {
    console.warn('IndexedDB 不支持，使用 localStorage 降级');
}

// 安全包装 DB 操作
const DB = {
  async init() {
    return new Promise((resolve, reject) => {
      try {
        if (!supportsIndexedDB) {
          throw new Error('IndexedDB not supported');
        }
        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          db = request.result;
          resolve(db);
        };

        request.onupgradeneeded = (event) => {
          const database = event.target.result;
          const store = database.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true });
          store.createIndex('date', 'date', { unique: false });
          store.createIndex('type', 'type', { unique: false });
        };
      } catch (e) {
        console.warn('IndexedDB 初始化失败，使用 localStorage:', e.message);
        // 降级到 localStorage
        if (supportsLocalStorage) {
          try {
            const data = localStorage.getItem(DB_NAME);
            if (!data) localStorage.setItem(DB_NAME, '[]');
            resolve({ type: 'localStorage' });
          } catch (e2) {
            reject(new Error('存储初始化失败: ' + e2.message));
          }
        } else {
          reject(new Error('浏览器不支持任何存储'));
        }
      }
    });
  },

  add(record) {
    return new Promise((resolve, reject) => {
      try {
        if (db && db.type === 'localStorage') {
          const data = this._getLocal();
          record.id = Date.now();
          data.push(record);
          this._setLocal(data);
          resolve(record.id);
          return;
        }
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        const request = store.add(record);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      } catch (e) { reject(e); }
    });
  },

  update(id, updates) {
    return new Promise((resolve, reject) => {
      try {
        if (db && db.type === 'localStorage') {
          const data = this._getLocal();
          const idx = data.findIndex(r => r.id === id);
          if (idx >= 0) {
            Object.assign(data[idx], updates);
            this._setLocal(data);
            resolve(data[idx]);
          } else {
            reject(new Error('记录不存在'));
          }
          return;
        }
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        const request = store.get(id);

        request.onsuccess = () => {
          const record = request.result;
          if (record) {
            Object.assign(record, updates);
            store.put(record).onsuccess = () => resolve(record);
          } else {
            reject(new Error('记录不存在'));
          }
        };

        request.onerror = () => reject(request.error);
      } catch (e) { reject(e); }
    });
  },

  delete(id) {
    return new Promise((resolve, reject) => {
      try {
        if (db && db.type === 'localStorage') {
          const data = this._getLocal();
          const filtered = data.filter(r => r.id !== id);
          this._setLocal(filtered);
          resolve();
          return;
        }
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        const request = store.delete(id);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
      } catch (e) { reject(e); }
    });
  },

  getAll() {
    return new Promise((resolve, reject) => {
      try {
        if (db && db.type === 'localStorage') {
          resolve(this._getLocal());
          return;
        }
        const tx = db.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);
        const request = store.getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      } catch (e) { reject(e); }
    });
  },

  getById(id) {
    return new Promise((resolve, reject) => {
      try {
        if (db && db.type === 'localStorage') {
          const data = this._getLocal();
          resolve(data.find(r => r.id === id) || null);
          return;
        }
        const tx = db.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);
        const request = store.get(id);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      } catch (e) { reject(e); }
    });
  },

  getByDate(dateStr) {
    return new Promise((resolve, reject) => {
      try {
        if (db && db.type === 'localStorage') {
          const data = this._getLocal();
          resolve(data.filter(r => r.date === dateStr));
          return;
        }
        const tx = db.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);
        const index = store.index('date');
        const request = index.getAll(dateStr);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      } catch (e) { reject(e); }
    });
  },

  async clearAll() {
    return new Promise((resolve, reject) => {
      try {
        if (db && db.type === 'localStorage') {
          this._setLocal([]);
          resolve();
          return;
        }
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        const request = store.clear();
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
      } catch (e) { reject(e); }
    });
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
      this.initDates();
      this.bindEvents();
      this.showLoading(false);
    } catch (e) {
      console.error('初始化失败:', e);
      alert('初始化失败: ' + e.message);
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
    const tabMap = { home: 'tabHome', record: 'tabRecord', summary: 'tabSummary', detail: 'tabDetail' };
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
    btnExp.classList.toggle('active', type === 'expense');
    btnInc.classList.toggle('active', type === 'income');
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
      showToast('添加成功');
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
      showToast('已删除');
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
      showToast('保存成功');

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
      showToast('已删除');

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

    showToast('导出成功');
  }
};

/* ====================
   启动
   ==================== */

document.addEventListener('DOMContentLoaded', async () => {
  try {
    await App.init();
    App.showPage('home');
  } catch (e) {
    console.error('启动失败:', e);
    alert('启动失败: ' + e.message);
  }
});
