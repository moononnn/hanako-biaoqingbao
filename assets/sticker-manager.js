// 表情包页面 - 前端交互 v0.15.0
// 三视图架构：首页 / 表情包库 / 偏好设置
// 薄荷绿主色 + 樱花粉辅色
(function () {
  'use strict';

  // ═══════════════════════════════════
  //  认证工具
  // ═══════════════════════════════════
  function getAuthParams() {
    var params = new URLSearchParams(window.location.search);
    var result = {};
    var surface = params.get('pluginSurfaceSession');
    if (surface) result.pluginSurfaceSession = surface;
    return result;
  }

  function withAuth(url) {
    var auth = getAuthParams();
    var parts = [];
    for (var k in auth) {
      parts.push(k + '=' + encodeURIComponent(auth[k]));
    }
    if (parts.length === 0) return url;
    var sep = url.indexOf('?') >= 0 ? '&' : '?';
    return url + sep + parts.join('&');
  }

  function baseUrl() {
    var p = window.location.pathname;
    return p.replace(/\/page\/?$/, '').replace(/\/+$/, '') || '';
  }

  var API = baseUrl();

  // ═══════════════════════════════════
  //  DOM 工具
  // ═══════════════════════════════════
  function $(id) { return document.getElementById(id); }
  function escHtml(s) {
    if (!s) return '';
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function formatTaggedAt(iso) {
    if (!iso) return '未识图';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '未识图';
    var mm = String(d.getMonth() + 1).padStart(2, '0');
    var dd = String(d.getDate()).padStart(2, '0');
    var hh = String(d.getHours()).padStart(2, '0');
    var mi = String(d.getMinutes()).padStart(2, '0');
    return mm + '-' + dd + ' ' + hh + ':' + mi;
  }

  function showLoading(text) {
    $('loading-text').textContent = text || '处理中...';
    $('loading-overlay').hidden = false;
  }
  function hideLoading() {
    $('loading-overlay').hidden = true;
  }

  function toast(msg, isErr) {
    var el = document.createElement('div');
    el.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);padding:8px 20px;border-radius:20px;font-size:13px;z-index:300;box-shadow:0 4px 12px rgba(0,0,0,.15);pointer-events:none;transition:opacity .3s';
    el.style.background = isErr ? '#c45a4e' : 'var(--primary)';
    el.style.color = '#fff';
    el.textContent = msg;
    document.body.appendChild(el);
    requestAnimationFrame(function () { el.style.opacity = '1'; });
    setTimeout(function () { el.style.opacity = '0'; setTimeout(function () { el.remove(); }, 300); }, 2500);
  }

  // ═══════════════════════════════════
  //  视图切换
  // ═══════════════════════════════════
  function showView(name) {
    document.querySelectorAll('.view').forEach(function (v) { v.classList.add('hidden'); });
    var view = $('view-' + name);
    if (view) view.classList.remove('hidden');
    window.scrollTo(0, 0);
  }

  // ═══════════════════════════════════
  //  数据加载
  // ═══════════════════════════════════
  var allStickers = [];
  var selectedIds = new Set();
  var batchMode = false;

  async function loadStickers() {
    var emotion = $('filter-emotion').value;
    var search = $('filter-search').value.trim().toLowerCase();
    try {
      var url = withAuth(API + '/api/list');
      if (emotion) url += (url.indexOf('?') >= 0 ? '&' : '?') + 'emotion=' + encodeURIComponent(emotion);
      var resp = await fetch(url);
      if (!resp.ok) {
        showError('加载列表失败 HTTP ' + resp.status);
        return;
      }
      var data = await resp.json();
      if (data.ok) {
        allStickers = data.data || [];
        updateHomeCount();
        applyFilter();
        loadSemanticIndexStatus();
      } else {
        showError('加载失败: ' + (data.error || ''));
      }
    } catch (e) {
      showError('网络错误: ' + e.message);
    }
  }

  function updateHomeCount() {
    var count = allStickers.length;
    var homeCount = $('home-count');
    if (homeCount) homeCount.textContent = count + ' 张';
    var libMeta = $('home-lib-meta');
    if (libMeta) libMeta.textContent = count ? count + ' 张表情包' : '图库为空，先添加图片';
    ['embedding-index-btn', 'batch-tasks-badge', 'btnToggleMulti'].forEach(function (id) {
      var button = $(id);
      if (button) button.disabled = count === 0;
    });
  }

  function applyFilter() {
    var search = $('filter-search').value.trim().toLowerCase();
    var filtered = allStickers;
    if (search) {
      filtered = allStickers.filter(function (s) {
        var desc = (s.description || '').toLowerCase();
        var kws = (s.tags?.keywords || []).join(' ').toLowerCase();
        var ems = (s.tags?.emotion || []).join(' ').toLowerCase();
        var scs = (s.tags?.scene || []).join(' ').toLowerCase();
        return desc.includes(search) || kws.includes(search) || ems.includes(search) || scs.includes(search);
      });
    }
    renderGrid(filtered);
  }

  function renderGrid(stickers) {
    var grid = $('sticker-grid');
    var countEl = $('sticker-count');
    grid.innerHTML = '';
    if (!stickers || stickers.length === 0) {
      if (allStickers.length === 0) {
        grid.innerHTML = '<div class="empty-state">图库还是空的。先添加几张常用表情包，让助手慢慢认识你的表达方式。<br><button class="btn btn-primary" id="empty-upload-btn" style="margin-top:12px">添加表情包</button></div>';
        var emptyUploadBtn = $('empty-upload-btn');
        if (emptyUploadBtn) emptyUploadBtn.onclick = function () { openModal('upload-modal'); };
      } else {
        grid.innerHTML = '<div class="empty-state">没有找到符合当前筛选条件的表情包</div>';
      }
      if (countEl) countEl.textContent = '0 张';
      return;
    }
    if (countEl) countEl.textContent = stickers.length + ' 张';

    for (var i = 0; i < stickers.length; i++) {
      (function (s) {
        var card = document.createElement('div');
        card.className = 'sticker-card' + (selectedIds.has(s.id) ? ' selected' : '');
        card.setAttribute('data-id', s.id);
        var imgUrl = withAuth(API + '/api/image?id=' + encodeURIComponent(s.id));
        var emTags = '';
        var scTags = '';
        for (var j = 0; j < (s.tags.emotion || []).length; j++) {
          emTags += '<span class="tag">' + escHtml(s.tags.emotion[j]) + '</span>';
        }
        for (var k = 0; k < (s.tags.scene || []).length; k++) {
          scTags += '<span class="tag scene">' + escHtml(s.tags.scene[k]) + '</span>';
        }
        card.innerHTML =
          '<div class="sticker-check" data-act="toggle-select">✓</div>'
          + '<img src="' + imgUrl + '" alt="' + escHtml(s.description) + '" loading="lazy">'
          + '<div class="card-info">'
          + '<div class="card-desc" title="' + escHtml(s.description) + '">' + escHtml(s.description) + '</div>'
          + '<div class="card-tags">' + emTags + scTags + '</div>'
          + '<div class="card-tagged-at">' + formatTaggedAt(s.tagged_at) + '</div>'
          + '<div class="card-actions">'
          + '<button class="edit-btn" data-id="' + escHtml(s.id) + '">编辑</button>'
          + '<button class="retag-btn" data-id="' + escHtml(s.id) + '">识图</button>'
          + '<button class="delete-btn" data-id="' + escHtml(s.id) + '">删除</button>'
          + '</div></div>';
        card.querySelector('.edit-btn').onclick = function (e) { e.stopPropagation(); openEditor(s); };
        card.querySelector('.retag-btn').onclick = function (e) { e.stopPropagation(); retagSticker(s); };
        card.querySelector('.delete-btn').onclick = function (e) { e.stopPropagation(); deleteSticker(s.id); };
        card.querySelector('.sticker-check').onclick = function (e) { e.stopPropagation(); toggleSelect(s.id); };
        card.addEventListener('click', function () {
          if (document.body.classList.contains('batch-mode')) toggleSelect(s.id);
        });
        grid.appendChild(card);
      })(stickers[i]);
    }
    updateBatchCount();
  }

  function showError(msg) {
    $('sticker-grid').innerHTML = '<div class="empty-state" style="color:var(--danger)">' + escHtml(msg) + '</div>';
    var c = $('sticker-count');
    if (c) c.textContent = '错误';
  }

  // ═══════════════════════════════════
  //  AI 识图
  // ═══════════════════════════════════
  async function enqueueTagTask(stickerIds, options) {
    options = options || {};
    var ids = Array.from(new Set(stickerIds || [])).filter(Boolean);
    if (ids.length === 0) { toast('没有需要识图的图片', true); return null; }
    try {
      var resp = await fetch(withAuth(API + '/api/batch-auto-tag'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sticker_ids: ids, concurrency: Math.min(ids.length, 5) }),
      });
      var data = await resp.json();
      if (!data.ok) { toast('创建任务失败: ' + (data.error || ''), true); return null; }
      toast(options.message || ('已加入后台任务，共 ' + ids.length + ' 张'));
      await checkBatchTasks();
      if (options.openDetail) openBatchTaskDetail(data.data.taskId);
      return data.data.taskId;
    } catch (e) {
      toast('创建任务失败: ' + e.message, true);
      return null;
    }
  }

  async function handleAutoTagEditor() {
    var id = $('edit-id').value;
    if (!allStickers.some(function (s) { return s.id === id; })) return;
    var btn = $('editor-autotag-btn');
    btn.disabled = true;
    btn.textContent = '加入中...';
    await enqueueTagTask([id], { message: '已加入后台识图任务' });
    btn.disabled = false;
    btn.textContent = 'AI 重新识图';
  }

  async function retagSticker(sticker) {
    customConfirm('把「' + sticker.description + '」作为新任务加入后台识图？识别完成后可在后台任务里确认应用。', function () { doRetag(sticker); });
  }

  async function doRetag(sticker) {
    await enqueueTagTask([sticker.id], { message: '已加入后台识图任务' });
  }

  // ═══════════════════════════════════
  //  上传（弹窗）
  // ═══════════════════════════════════
  function readFileAsDataUrl(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function (event) { resolve(event.target.result); };
      reader.onerror = function () { reject(new Error('读取文件失败：' + file.name)); };
      reader.readAsDataURL(file);
    });
  }

  function showUploadResult(lines) {
    var result = $('upload-result');
    if (!result) return;
    result.textContent = lines.join('\n');
    result.hidden = false;
  }

  function clearUploadResult() {
    var result = $('upload-result');
    if (!result) return;
    result.textContent = '';
    result.hidden = true;
  }

  async function handleUpload() {
    var fileInput = $('upload-file');
    var files = Array.from(fileInput.files || []);
    if (!files.length) { toast('请选择图片', true); return; }

    var fields = { emotion: '', scene: '', keywords: '', description: '' };
    var success = 0;
    var failed = [];
    clearUploadResult();
    showLoading('正在上传 0/' + files.length + '...');

    try {
      for (var i = 0; i < files.length; i++) {
        showLoading('正在上传 ' + (i + 1) + '/' + files.length + '...');
        try {
          var base64 = await readFileAsDataUrl(files[i]);
          var resp = await fetch(withAuth(API + '/api'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(Object.assign({
              action: 'upload',
              imageBase64: base64,
              fileName: files[i].name,
            }, fields)),
            signal: AbortSignal.timeout(60000),
          });
          var data = await resp.json();
          if (!data.ok) throw new Error(data.error || '未知错误');
          success++;
        } catch (error) {
          failed.push(files[i].name + '：' + error.message);
        }
      }

      fileInput.value = '';
      $('upload-file-hint').textContent = '支持 PNG、JPG、GIF、WebP 和 BMP。';
      if (success > 0) loadStickers();
      if (failed.length) {
        showUploadResult(['导入完成：成功 ' + success + ' 张，失败 ' + failed.length + ' 张。', '', '失败详情：'].concat(failed));
        toast('有 ' + failed.length + ' 张导入失败，详情已留在弹窗里', true);
      } else {
        toast('成功导入 ' + success + ' 张图片');
        closeModal('upload-modal');
      }
    } finally {
      hideLoading();
    }
  }

  async function handleImportZip() {
    var input = $('upload-zip');
    var file = input.files && input.files[0];
    if (!file) { toast('请选择 ZIP 文件', true); return; }
    if (file.size > 50 * 1024 * 1024) { toast('ZIP 文件不能超过 50MB', true); return; }

    clearUploadResult();
    showLoading('正在读取 ZIP...');
    try {
      var zipBase64 = await readFileAsDataUrl(file);
      showLoading('正在导入 ZIP...');
      var resp = await fetch(withAuth(API + '/api'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'import_zip', zipBase64: zipBase64, fileName: file.name }),
        signal: AbortSignal.timeout(120000),
      });
      var data = await resp.json();
      if (!data.ok) throw new Error(data.error || 'ZIP 导入失败');
      input.value = '';
      loadStickers();
      var skippedItems = data.data && data.data.skippedItems ? data.data.skippedItems : [];
      if (skippedItems.length) {
        var details = skippedItems.map(function (item) { return item.file + '：' + item.reason; });
        showUploadResult([data.message || 'ZIP 导入完成', '', '跳过详情：'].concat(details));
        toast('ZIP 已导入，跳过详情已留在弹窗里');
      } else {
        toast(data.message || 'ZIP 导入完成');
        closeModal('upload-modal');
      }
    } catch (error) {
      toast('ZIP 导入失败：' + error.message, true);
    } finally {
      hideLoading();
    }
  }

  // ═══════════════════════════════════
  //  弹窗工具
  // ═══════════════════════════════════
  function openModal(id) {
    var modal = $(id);
    if (modal) { modal.hidden = false; modal.style.display = 'flex'; }
  }

  function closeModal(id) {
    var modal = $(id);
    if (modal) { modal.hidden = true; modal.style.display = ''; }
  }

  // ═══════════════════════════════════
  //  编辑弹窗
  // ═══════════════════════════════════
  function openEditor(sticker) {
    $('edit-id').value = sticker.id;
    $('edit-desc').value = sticker.description || '';
    $('edit-emotion').value = (sticker.tags.emotion || []).join(', ');
    $('edit-scene').value = (sticker.tags.scene || []).join(', ');
    $('edit-keywords').value = (sticker.tags.keywords || []).join(', ');
    openModal('editor-modal');
  }

  function closeEditor() { closeModal('editor-modal'); }

  async function saveEdit() {
    var id = $('edit-id').value;
    try {
      var resp = await fetch(withAuth(API + '/api'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'update',
          id: id,
          description: $('edit-desc').value,
          emotion: $('edit-emotion').value,
          scene: $('edit-scene').value,
          keywords: $('edit-keywords').value,
        }),
      });
      var data = await resp.json();
      if (data.ok) {
        closeEditor();
        toast('已保存');
        loadStickers();
      } else {
        toast('保存失败: ' + (data.error || ''), true);
      }
    } catch (err) {
      toast('保存出错: ' + err.message, true);
    }
  }

  // ═══════════════════════════════════
  //  删除
  // ═══════════════════════════════════
  async function deleteSticker(id) {
    customConfirm('确定要删除这个表情包吗？此操作不可撤销。', async function () {
      try {
        var resp = await fetch(withAuth(API + '/api'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'delete', id: id }),
        });
        var data = await resp.json();
        if (data.ok) {
          toast('已删除');
          loadStickers();
        } else {
          toast('删除失败: ' + (data.error || ''), true);
        }
      } catch (err) {
        toast('删除出错: ' + err.message, true);
      }
    });
  }

  // ═══════════════════════════════════
  //  自定义确认弹窗
  // ═══════════════════════════════════
  function customConfirm(message, onConfirm) {
    var overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.style.zIndex = '100000';
    overlay.style.display = 'flex';
    overlay.innerHTML = ''
      + '<div class="modal-box" style="max-width:360px;position:relative">'
      + '<h2 style="margin-top:0;font-size:16px">确认操作</h2>'
      + '<div style="font-size:13px;color:var(--text-muted);margin:14px 0;line-height:1.6;white-space:pre-wrap">' + escHtml(message) + '</div>'
      + '<div class="modal-actions" style="display:flex;gap:8px;justify-content:flex-end">'
      + '<button class="btn btn-secondary" id="cc-cancel">取消</button>'
      + '<button class="btn btn-primary" id="cc-ok" style="width:auto">确定</button>'
      + '</div></div>';
    document.body.appendChild(overlay);
    var okBtn = overlay.querySelector('#cc-ok');
    var cancelBtn = overlay.querySelector('#cc-cancel');
    function close() { overlay.remove(); }
    cancelBtn.onclick = close;
    okBtn.onclick = function () { close(); onConfirm(); };
    overlay.addEventListener('click', function (e) { if (e.target === overlay) close(); });
    okBtn.focus();
  }

  // ═══════════════════════════════════
  //  检查更新（v0.19.5 分享版）
  // ═══════════════════════════════════
  function checkUpdate() {
    var btn = $('btn-check-update');
    var original = btn ? btn.textContent : '';
    if (btn) { btn.textContent = '检查中…'; btn.disabled = true; }
    var done = function () {
      if (btn) { btn.textContent = original; btn.disabled = false; }
    };
    fetch(withAuth(API + '/api/check-update'), { signal: AbortSignal.timeout(12000) })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (!data || data.success === false) {
          showUpdateResult({
            title: '❌ 检查失败',
            body: '<div style="font-size:13px;color:var(--text-muted);margin:10px 0;line-height:1.7">' + escHtml(data ? (data.error || '未知错误') : '无响应') + '</div>',
            repoUrl: (data && data.repoUrl) || 'https://github.com/moononnn/hanako-biaoqingbao',
            okText: '知道了',
          });
          return;
        }
        if (!data.hasUpdate) {
          // v0.19.5 - API 不可用（apiDown）时弹窗展示仓库地址，让用户自己去看；真无更新才轻提示
          if (data.apiDown) {
            showUpdateResult({
              title: '⚠️ 暂时检查不了',
              body: '<div style="font-size:13px;color:var(--text-muted);margin:10px 0;line-height:1.7">' + escHtml(data.message || 'GitHub API 暂时不可用') + '，可以先去仓库看看有没有新版本。</div>',
              repoUrl: data.repoUrl || 'https://github.com/moononnn/hanako-biaoqingbao',
              okText: '知道了',
            });
            return;
          }
          toast(data.message || '已是最新版本 ✨');
          return;
        }
        // 有更新：更新卡片
        var bodyHtml = '<div style="font-size:13px;color:var(--text);margin:10px 0;line-height:1.7">' + escHtml(data.message) + '</div>';
        if (data.releaseBody) {
          var release = escHtml(data.releaseBody)
            .replace(/^###?\s+(.+)$/gm, '<strong>$1</strong>')
            .replace(/^[-*]\s+(.+)$/gm, '· $1')
            .replace(/\n{2,}/g, '<br><br>')
            .replace(/\n/g, '<br>');
          bodyHtml += '<div style="font-size:12px;color:var(--text-muted);max-height:180px;overflow-y:auto;border:1px solid var(--border-light);border-radius:8px;padding:10px;line-height:1.7">' + release + '</div>';
        }
        showUpdateResult({
          title: '🎉 发现新版本',
          body: bodyHtml,
          actions: '<a href="' + data.downloadUrl + '" target="_blank" class="btn" style="text-decoration:none;background:var(--primary);color:#fff;border-color:var(--primary)">⬇ 下载更新</a>'
            + '<a href="' + data.updateUrl + '" target="_blank" class="btn" style="text-decoration:none">查看详情 →</a>',
          repoUrl: data.repoUrl,
          okText: '稍后再说',
        });
      })
      .catch(function (e) {
        showUpdateResult({
          title: '❌ 网络错误',
          body: '<div style="font-size:13px;color:var(--text-muted);margin:10px 0;line-height:1.7">' + escHtml(e.message || '请求失败') + '</div>',
          repoUrl: 'https://github.com/moononnn/hanako-biaoqingbao',
          okText: '知道了',
        });
      })
      .finally(done);
  }

  // 更新结果弹窗（失败/有更新共用）
  function showUpdateResult(opts) {
    var overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.style.zIndex = '100000';
    overlay.style.display = 'flex';
    var repoUrl = opts.repoUrl || 'https://github.com/moononnn/hanako-biaoqingbao';
    var html = '<div class="modal-box" style="max-width:460px;position:relative">'
      + '<h2 style="margin-top:0;font-size:16px">' + opts.title + '</h2>'
      + opts.body;
    if (opts.actions) {
      html += '<div style="display:flex;gap:8px;margin-top:12px">' + opts.actions + '</div>';
    }
    html += '<div style="margin-top:12px;padding-top:8px;border-top:1px solid var(--border-light);font-size:11px;color:var(--text-muted);word-break:break-all">也可复制链接手动下载：<br>'
      + '<a href="' + repoUrl + '" target="_blank" style="color:var(--primary);word-break:break-all">' + repoUrl + '</a></div>'
      + '<button class="btn" data-update-close style="margin-top:12px;width:100%">' + (opts.okText || '知道了') + '</button>'
      + '</div>';
    overlay.innerHTML = html;
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay || e.target.hasAttribute('data-update-close')) {
        overlay.remove();
      }
    });
    document.body.appendChild(overlay);
  }

  // ═══════════════════════════════════
  //  模型配置（设置弹窗内）
  // ═══════════════════════════════════
  var visionModels = window.__VISION_MODELS__ || [];
  var visionConfig = window.__VISION_CONFIG__ || {};
  var textModels = window.__TEXT_MODELS__ || [];
  var textConfig = window.__TEXT_CONFIG__ || { enabled: false, source: 'hana' };

  function hasConfiguredModel(cfg) {
    if (!cfg) return false;
    if (cfg.source === 'custom') return Boolean(cfg.customBaseUrl && cfg.customApiKey && cfg.customModel);
    return Boolean(cfg.providerId && cfg.modelId);
  }

  function setGuideState(id, label, ready) {
    var el = $(id);
    if (!el) return;
    el.textContent = label + (ready ? ' · 已配置' : ' · 待配置');
    el.classList.toggle('ready', ready);
    el.classList.toggle('pending', !ready);
  }

  function updateModelGuide() {
    var embeddingConfig = window.__EMBEDDING_CONFIG__ || {};
    var visionReady = hasConfiguredModel(visionConfig);
    var textReady = textConfig.enabled !== false && hasConfiguredModel(textConfig);
    var embeddingModel = embeddingConfig.source === 'custom' ? embeddingConfig.customModel : embeddingConfig.modelId;
    var embeddingReady = hasConfiguredModel(embeddingConfig)
      && String(embeddingModel || '').toLowerCase() === 'baai/bge-m3';
    setGuideState('guide-vision', '识图模型', visionReady);
    if (textConfig.enabled === false) {
      var textEl = $('guide-text');
      if (textEl) {
        textEl.textContent = '内容分析 · 已关闭';
        textEl.classList.remove('ready');
        textEl.classList.add('pending');
      }
    } else {
      setGuideState('guide-text', '内容分析', textReady);
    }
    setGuideState('guide-embedding', '向量检索', embeddingReady);
    var note = $('model-guide-note');
    if (note) {
      var vectorNote = embeddingReady
        ? 'BGE-M3 已接入，上传并完成识图后即可生成图库语义索引。'
        : '向量检索建议配置 BAAI/bge-m3；更换模型后需要重新生成图库语义索引。';
      note.textContent = '识图负责自动打标签，内容分析负责聊天时自动配图。' + vectorNote;
    }
  }

  function openSettings() {
    // 填充识图模型
    var vCfg = visionConfig;
    $('vision-source').value = vCfg.source || 'hana';
    var vProv = $('vision-provider');
    vProv.innerHTML = '<option value="">选择 Provider...</option>';
    for (var i = 0; i < visionModels.length; i++) {
      var p = visionModels[i];
      var sel = p.providerId === vCfg.providerId ? ' selected' : '';
      vProv.innerHTML += '<option value="' + escHtml(p.providerId) + '"' + sel + '>' + escHtml(p.providerName) + '</option>';
    }
    updateVisionModelDropdown(vCfg.providerId, vCfg.modelId);
    $('vision-custom-url').value = vCfg.customBaseUrl || '';
    $('vision-custom-key').value = vCfg.customApiKey ? '********' : '';
    $('vision-custom-model').value = vCfg.customModel || '';
    toggleVisionBlocks();

    // 填充分析模型
    var tCfg = textConfig;
    $('text-enabled').checked = tCfg.enabled !== false;
    $('text-source').value = tCfg.source || 'hana';
    var tProv = $('text-provider');
    tProv.innerHTML = '<option value="">选择 Provider...</option>';
    for (var j = 0; j < textModels.length; j++) {
      var tp = textModels[j];
      var tsel = tp.providerId === tCfg.providerId ? ' selected' : '';
      tProv.innerHTML += '<option value="' + escHtml(tp.providerId) + '"' + tsel + '>' + escHtml(tp.providerName) + '</option>';
    }
    updateTextModelDropdown(tCfg.providerId, tCfg.modelId);
    $('text-custom-url').value = tCfg.customBaseUrl || '';
    $('text-custom-key').value = tCfg.customApiKey ? '********' : '';
    $('text-custom-model').value = tCfg.customModel || '';
    $('text-test-result').textContent = '';
    toggleTextBlocks();

    // v0.16.0 - 加载 Embedding 配置
    loadEmbeddingConfig();

    openModal('settings-modal');
  }

  function updateVisionModelDropdown(providerId, selectedModel) {
    var modelSel = $('vision-model');
    modelSel.innerHTML = '<option value="">选择模型...</option>';
    if (!providerId) return;
    for (var i = 0; i < visionModels.length; i++) {
      if (visionModels[i].providerId === providerId) {
        var models = visionModels[i].models || [];
        for (var j = 0; j < models.length; j++) {
          var sel = models[j].id === selectedModel ? ' selected' : '';
          modelSel.innerHTML += '<option value="' + escHtml(models[j].id) + '"' + sel + '>' + escHtml(models[j].name) + '</option>';
        }
      }
    }
  }

  function toggleVisionBlocks() {
    var source = $('vision-source').value;
    $('vision-hana-block').style.display = source === 'hana' ? '' : 'none';
    $('vision-custom-block').style.display = source === 'custom' ? '' : 'none';
  }

  function updateTextModelDropdown(providerId, selectedModel) {
    var modelSel = $('text-model');
    modelSel.innerHTML = '<option value="">选择模型...</option>';
    if (!providerId) return;
    for (var i = 0; i < textModels.length; i++) {
      if (textModels[i].providerId === providerId) {
        var models = textModels[i].models || [];
        for (var j = 0; j < models.length; j++) {
          var sel = models[j].id === selectedModel ? ' selected' : '';
          modelSel.innerHTML += '<option value="' + escHtml(models[j].id) + '"' + sel + '>' + escHtml(models[j].name) + '</option>';
        }
      }
    }
  }

  function toggleTextBlocks() {
    var source = $('text-source').value;
    $('text-hana-block').style.display = source === 'hana' ? '' : 'none';
    $('text-custom-block').style.display = source === 'custom' ? '' : 'none';
  }

  function buildTextConfigFromForm() {
    var source = $('text-source').value;
    return {
      enabled: $('text-enabled').checked,
      source: source,
      providerId: source === 'hana' ? $('text-provider').value : '',
      modelId: source === 'hana' ? $('text-model').value : '',
      customBaseUrl: source === 'custom' ? $('text-custom-url').value : '',
      customApiKey: $('text-custom-key').value,
      customModel: source === 'custom' ? $('text-custom-model').value : '',
    };
  }

  // v0.18.0 - Embedding 向量检索（与识图/内容模型对称）
  function toggleEmbeddingBlocks() {
    var source = $('embedding-source').value;
    $('embedding-hana-block').style.display = source === 'hana' ? '' : 'none';
    $('embedding-custom-block').style.display = source === 'custom' ? '' : 'none';
  }

  // 根据后端返回的可用模型列表填充 provider/model 下拉框
  // v0.18.3 - 与 vision/text 完全对齐：用 selected 标记已保存的 provider
  function populateEmbeddingSelectors(savedProviderId) {
    var providerSel = $('embedding-provider');
    var modelSel = $('embedding-model');
    var emptyDiv = $('embedding-hana-empty');
    if (!providerSel || !modelSel) return;

    var list = (window.__EMBEDDING_MODELS__ || []);
    if (!list.length) {
      emptyDiv.style.display = '';
      providerSel.style.display = 'none';
      modelSel.style.display = 'none';
      return;
    }
    emptyDiv.style.display = 'none';
    providerSel.style.display = '';
    modelSel.style.display = '';

    providerSel.innerHTML = '<option value="">选择 Provider...</option>';
    for (var i = 0; i < list.length; i++) {
      var opt = document.createElement('option');
      opt.value = list[i].providerId;
      opt.textContent = list[i].providerName + ' (' + list[i].models.length + ')';
      // v0.18.3 - 与 savedProviderId 匹配时标记 selected
      if (savedProviderId && list[i].providerId === savedProviderId) opt.selected = true;
      providerSel.appendChild(opt);
    }
    providerSel.onchange = function () {
      modelSel.innerHTML = '<option value="">选择模型...</option>';
      var pid = providerSel.value;
      for (var j = 0; j < list.length; j++) {
        if (list[j].providerId === pid) {
          for (var k = 0; k < list[j].models.length; k++) {
            var mo = document.createElement('option');
            mo.value = list[j].models[k].id;
            mo.textContent = list[j].models[k].name;
            modelSel.appendChild(mo);
          }
          break;
        }
      }
    };
  }

  async function loadEmbeddingConfig() {
    var cfg = window.__EMBEDDING_CONFIG__ || {};
    var savedProviderId = cfg.providerId || '';
    var savedModelId = cfg.modelId || '';

    // v0.18.3 - 防御：providerId 缺失但 modelId 有，从 modelId 反查 providerId
    if (!savedProviderId && savedModelId) {
      var list0 = window.__EMBEDDING_MODELS__ || [];
      for (var pi = 0; pi < list0.length; pi++) {
        for (var mj = 0; mj < list0[pi].models.length; mj++) {
          if (list0[pi].models[mj].id === savedModelId) {
            savedProviderId = list0[pi].providerId;
            console.info('[embed cfg] 从 modelId 反查 providerId:', savedProviderId);
            break;
          }
        }
        if (savedProviderId) break;
      }
    }

    populateEmbeddingSelectors(savedProviderId);
    try {
      $('embedding-source').value = cfg.source || 'hana';
      // hana 模型回填：有 providerId 就回填（即使是反查出来的）
      if (cfg.source === 'hana' && savedProviderId) {
        var providerSel = $('embedding-provider');
        if (providerSel) {
          providerSel.value = savedProviderId;
          providerSel.onchange();
          $('embedding-model').value = savedModelId || '';
        }
      }
      $('embedding-custom-url').value = cfg.customBaseUrl || '';
      $('embedding-custom-key').value = cfg.customApiKey ? '********' : '';
      $('embedding-custom-model').value = cfg.customModel || '';
      $('embedding-custom-dimensions').value = cfg.customDimensions || '';
    } catch (e) { console.warn('[embed cfg] load err:', e); }
    toggleEmbeddingBlocks();
  }

  async function loadSemanticIndexStatus() {
    var btn = $('embedding-index-btn');
    if (!btn) return;
    try {
      var resp = await fetch(withAuth(API + '/api/vector-status'));
      var data = await resp.json();
      if (!data.ok) return;
      var d = data.data || {};
      btn.classList.toggle('is-pending', d.pending > 0);
      if (!d.configured) {
        btn.textContent = '图库语义索引';
        btn.title = '还没有配置语义索引模型，点击查看提示';
      } else if (d.pending > 0) {
        btn.textContent = '图库语义索引 (' + d.pending + ')';
        btn.title = '有 ' + d.pending + ' 张图片等待加入语义索引';
      } else {
        btn.textContent = '图库语义索引';
        btn.title = '图库中的图片都已建立语义索引';
      }
    } catch (e) {
      console.warn('[semantic index] status error:', e);
    }
  }

  async function generateSemanticIndex() {
    var btn = $('embedding-index-btn');
    if (!btn || btn.disabled) return;
    btn.disabled = true;
    btn.textContent = '索引中...';
    try {
      var resp = await fetch(withAuth(API + '/api/generate-embeddings'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ onlyMissing: true }),
      });
      var data = await resp.json();
      if (!data.ok) {
        var msg = data.error || '语义索引失败';
        if (msg.indexOf('未配置') >= 0) msg += '，请先去设置里配置';
        toast(msg, true);
      } else {
        var d = data.data || {};
        toast(d.processed > 0 ? '语义索引完成：' + d.processed + ' 张' : '没有需要处理的图片');
      }
    } catch (e) {
      toast('语义索引出错：' + e.message, true);
    } finally {
      btn.disabled = false;
      await loadSemanticIndexStatus();
    }
  }

  function buildEmbeddingConfigFromForm() {
    var source = $('embedding-source').value;
    if (source === 'hana') {
      var providerId = $('embedding-provider').value || '';
      var modelId = $('embedding-model').value || '';
      // 防御：如果选了模型但没选 provider（UI 偶发 bug），从模型反查 provider
      if (modelId && !providerId) {
        var list = window.__EMBEDDING_MODELS__ || [];
        for (var i = 0; i < list.length; i++) {
          for (var j = 0; j < list[i].models.length; j++) {
            if (list[i].models[j].id === modelId) {
              providerId = list[i].providerId;
              break;
            }
          }
          if (providerId) break;
        }
        if (providerId) console.info('[embed save] 从 modelId 反查 providerId:', providerId);
      }
      return {
        source: 'hana',
        providerId: providerId,
        modelId: modelId,
        dimensions: 1024,
        customBaseUrl: '',
        customApiKey: '',
        customModel: '',
        customDimensions: 1024,
      };
    }
    return {
      source: 'custom',
      providerId: '',
      modelId: '',
      dimensions: 1024,
      customBaseUrl: $('embedding-custom-url').value || '',
      customApiKey: $('embedding-custom-key').value || '',
      customModel: $('embedding-custom-model').value || '',
      customDimensions: parseInt($('embedding-custom-dimensions').value, 10) || 1024,
    };
  }

  async function saveEmbeddingConfig() {
    var cfg = buildEmbeddingConfigFromForm();
    try {
      var resp = await fetch(withAuth(API + '/api/embedding-config'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(cfg),
      });
      var data = await resp.json();
      if (!data.ok) console.warn('[embed save] server error:', data.error);
      if (data.ok) window.__EMBEDDING_CONFIG__ = cfg;
      return data.ok;
    } catch (e) {
      console.warn('[embed save] network error:', e);
      return false;
    }
  }

  // v0.18.4 - embedding 连通测试（复用 vision/text 的「测试连通」模式）
  async function testEmbeddingConfig() {
    var statusEl = $('embedding-test-result');
    var btn = $('embedding-test-btn');
    statusEl.textContent = '测试中...';
    statusEl.style.color = 'var(--text-muted)';
    btn.disabled = true;
    var cfg = buildEmbeddingConfigFromForm();
    try {
      var resp = await fetch(withAuth(API + '/api/embedding-test'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(cfg),
      });
      var data = await resp.json();
      if (data.ok) {
        var d = data.data;
        statusEl.textContent = '✅ ' + d.model + ' · ' + d.dimensions + ' 维';
        statusEl.style.color = 'var(--success)';
      } else {
        statusEl.textContent = '❌ ' + (data.error || '连接失败');
        statusEl.style.color = 'var(--danger)';
      }
    } catch (e) {
      statusEl.textContent = '❌ ' + e.message;
      statusEl.style.color = 'var(--danger)';
    } finally {
      btn.disabled = false;
    }
  }

  async function saveAllSettings() {
    // 保存识图模型
    var vSource = $('vision-source').value;
    var vCfg = {
      source: vSource,
      providerId: vSource === 'hana' ? $('vision-provider').value : '',
      modelId: vSource === 'hana' ? $('vision-model').value : '',
      customBaseUrl: vSource === 'custom' ? $('vision-custom-url').value : '',
      customApiKey: $('vision-custom-key').value,
      customModel: vSource === 'custom' ? $('vision-custom-model').value : '',
    };

    // 保存分析模型
    var tCfg = buildTextConfigFromForm();

    try {
      // 保存识图
      var resp1 = await fetch(withAuth(API + '/api/vision-config'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(vCfg),
      });
      var data1 = await resp1.json();

      // 保存分析
      var resp2 = await fetch(withAuth(API + '/api/text-config'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(tCfg),
      });
      var data2 = await resp2.json();

      // v0.16.0 - 保存 Embedding 配置
      var embOk = await saveEmbeddingConfig();

      // v0.18.3 - 三个都要成功才算保存成功，否则报错且不关弹窗
      if (data1.ok && data2.ok && embOk) {
        visionConfig = vCfg;
        if (vCfg.customApiKey === '********') {
          visionConfig.customApiKey = window.__VISION_CONFIG__?.customApiKey || '';
        }
        textConfig = tCfg;
        if (tCfg.customApiKey === '********') {
          textConfig.customApiKey = window.__TEXT_CONFIG__?.customApiKey || '';
        }
        updateModelGuide();
        closeModal('settings-modal');
        toast('设置已保存');
      } else {
        var failed = [];
        if (!data1.ok) failed.push('识图');
        if (!data2.ok) failed.push('分析');
        if (!embOk) failed.push('向量');
        toast('保存失败: ' + failed.join(' / ') + '，请看控制台日志', true);
      }
    } catch (e) {
      toast('保存出错: ' + e.message, true);
    }
  }

  async function testTextConfig() {
    var statusEl = $('text-test-result');
    statusEl.textContent = '测试中...';
    statusEl.style.color = 'var(--text-muted)';
    var cfg = buildTextConfigFromForm();
    try {
      var resp = await fetch(withAuth(API + '/api/text-test'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(cfg),
      });
      var data = await resp.json();
      if (data.ok) {
        statusEl.textContent = '✅ ' + (data.data.reply || '连接成功');
        statusEl.style.color = 'var(--success)';
      } else {
        statusEl.textContent = '❌ ' + (data.error || '连接失败');
        statusEl.style.color = 'var(--danger)';
      }
    } catch (e) {
      statusEl.textContent = '❌ ' + e.message;
      statusEl.style.color = 'var(--danger)';
    }
  }

  // v0.15.1 - 识图模型连通测试
  async function testVisionConfig() {
    var statusEl = $('vision-test-result');
    statusEl.textContent = '测试中...';
    statusEl.style.color = 'var(--text-muted)';
    var source = $('vision-source').value;
    var cfg = {
      source: source,
      providerId: source === 'hana' ? $('vision-provider').value : '',
      modelId: source === 'hana' ? $('vision-model').value : '',
      customBaseUrl: source === 'custom' ? $('vision-custom-url').value : '',
      customApiKey: $('vision-custom-key').value,
      customModel: source === 'custom' ? $('vision-custom-model').value : '',
    };
    try {
      var resp = await fetch(withAuth(API + '/api/vision-test'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(cfg),
      });
      var data = await resp.json();
      if (data.ok) {
        statusEl.textContent = '✅ ' + (data.data.reply || '连接成功');
        statusEl.style.color = 'var(--success)';
      } else {
        statusEl.textContent = '❌ ' + (data.error || '连接失败');
        statusEl.style.color = 'var(--danger)';
      }
    } catch (e) {
      statusEl.textContent = '❌ ' + e.message;
      statusEl.style.color = 'var(--danger)';
    }
  }

  // ═══════════════════════════════════
  //  偏好设置
  // ═══════════════════════════════════
  function initPreferencesView() {
    renderPreferences();
  }

  // v0.19.5 - 查这条决策日志对应的反馈状态。匹配口径：
  // 情绪包含关系（与 collectPrefsForEmotion 一致，日志与映射的情绪词可略有出入）；
  // 关键词不作为必需条件（反馈时往往没有关键词，空对空也要能命中）。
  // 返回 { state: 'positive'|'negative', mappingIndex } 或 null
  function findFeedbackFor(agent, stickerId, emotion, kws) {
    var users = (window.__PREFERENCES__ || {}).users || {};
    var user = users[agent];
    if (!user || !Array.isArray(user.mappings)) return null;
    for (var i = 0; i < user.mappings.length; i++) {
      var m = user.mappings[i];
      var ctx = m.context || {};
      if (!(ctx.emotion && (emotion.includes(ctx.emotion) || ctx.emotion.includes(emotion)))) continue;
      if ((m.preferred_ids || []).includes(stickerId)) return { state: 'positive', mappingIndex: i };
      if ((m.vetoed_ids || []).includes(stickerId)) return { state: 'negative', mappingIndex: i };
    }
    return null;
  }

  async function renderPreferences() {
    var prefs = window.__PREFERENCES__ || { version: 1, users: {} };
    var logs = window.__DECISION_LOG__ || { version: 1, entries: [] };
    var entries = logs.entries || [];

    if (!allStickers || allStickers.length === 0) {
      try {
        var r = await fetch(withAuth(API + '/api/list'));
        var d = await r.json();
        if (d.ok) allStickers = d.data || [];
      } catch (e) {}
    }
    var validIds = new Set(allStickers.map(function (s) { return s.id; }));

    var totalDecisions = entries.length;
    var feedbacks = entries.filter(function (e) { return e.type === 'user_feedback'; });
    var statsHtml = ''
      + '<div class="stat-box"><div class="stat-label">总决策</div>'
      + '<div class="stat-val">' + totalDecisions + '</div></div>'
      + '<div class="stat-box"><div class="stat-label">用户反馈</div>'
      + '<div class="stat-val">' + feedbacks.length + '</div></div>';

    var mappingMeta = [];
    for (var uid in (prefs.users || {})) {
      var ms = (prefs.users[uid] && prefs.users[uid].mappings) || [];
      for (var li = 0; li < ms.length; li++) {
        mappingMeta.push({ mapping: ms[li], agent: uid, localIndex: li });
      }
    }
    var allMappings = mappingMeta.map(function (x) { return x.mapping; });
    statsHtml += '<div class="stat-box"><div class="stat-label">偏好规则</div>'
      + '<div class="stat-val">' + allMappings.length + '</div></div>';
    statsHtml += '<button class="pref-btn pref-btn-mini" id="pref-cleanup-btn" title="清理已删除表情包的偏好引用" style="align-self:flex-start;margin-left:auto">清理失效</button>';
    $('pref-stats').innerHTML = statsHtml;
    var cleanupBtn = $('pref-cleanup-btn');
    if (cleanupBtn) {
      cleanupBtn.onclick = function () {
        customConfirm('扫描所有偏好映射，移除已删除表情包的引用。空映射也会一起删除。', function () { cleanupPreferences(); });
      };
    }

    // 更新首页偏好卡片
    var prefMeta = $('home-pref-meta');
    if (prefMeta) {
      var parts = [];
      if (allMappings.length > 0) parts.push(allMappings.length + ' 条偏好');
      if (feedbacks.length > 0) parts.push(feedbacks.length + ' 条反馈');
      prefMeta.textContent = parts.length > 0 ? parts.join(' · ') : '配图偏好与助手管理';
    }

    var recent = entries.slice(-20).reverse();
    if (recent.length === 0) {
      $('pref-log').innerHTML = '<div style="color:var(--text-muted);padding:20px;text-align:center">还没有配图记录，聊聊天试试</div>';
      return;
    }

    var html = '<div style="font-size:12px;color:var(--text-muted);margin-bottom:8px">最近 ' + recent.length + ' 次配图决策</div>';
    html += '<div style="display:flex;flex-direction:column;gap:6px">';
    for (var i = 0; i < recent.length; i++) {
      var e = recent[i];
      var ts = e.ts ? e.ts.slice(0, 16).replace('T', ' ') : '';
      var emotion = e.emotion || '';
      var kws = (e.keywords || []).join(', ');
      var stickerLabel = e.sticker_id || '';
      var decLabel = '';
      var decColor = '';
      // v0.22.0 - 去掉 ✅⏭📌 符号，只保留用户反馈方向文字
      if (e.type === 'user_feedback') {
        decLabel = e.feedback_type === 'positive' ? '喜欢' : '不喜欢';
        decColor = e.feedback_type === 'positive' ? 'var(--success)' : 'var(--danger)';
      }

      html += '<div style="display:flex;align-items:center;gap:6px;padding:6px 8px;background:var(--surface-alt);border:1px solid var(--border-light);border-radius:4px;font-size:11px;min-width:0">';
      html += '<span style="color:var(--text-light);font-size:10px;white-space:nowrap" title="' + escHtml(ts) + '">' + escHtml(ts.slice(5)) + '</span>';
      if (stickerLabel) {
        if (validIds.has(stickerLabel)) {
          html += '<span class="log-thumb-wrap" title="' + escHtml(stickerLabel) + '">'
            + '<img class="log-thumb" src="' + withAuth(API + '/api/image?id=' + encodeURIComponent(stickerLabel)) + '" alt="' + escHtml(stickerLabel) + '">'
            + '</span>'
            + '<span class="log-thumb-id">' + escHtml(stickerLabel) + '</span>';
        } else {
          html += '<span class="log-thumb-wrap log-deleted" title="' + escHtml(stickerLabel) + '（已删除）">'
            + '<span class="log-thumb-deleted">✕</span>'
            + '</span>'
            + '<span class="log-thumb-id log-thumb-id-missing">' + escHtml(stickerLabel) + ' · 已删除</span>';
        }
      }
      if (emotion) html += '<span class="tag" style="font-size:10px;flex-shrink:0">' + escHtml(emotion) + '</span>';
      if (kws) html += '<span style="color:var(--text-muted);flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + escHtml(kws) + '</span>';
      else html += '<span style="flex:1;min-width:0"></span>';
      if (decLabel) html += '<span style="color:' + decColor + ';font-size:11px;font-weight:600;flex-shrink:0">' + decLabel + '</span>';
      if (stickerLabel && e.type !== 'user_feedback') {
        // v0.19.5 - 根据持久化偏好判断这条的反馈状态，按钮显示选中态；点选中的按钮可取消
        var fbState = findFeedbackFor(e.agent || '', stickerLabel, emotion, kws);
        var posActive = fbState && fbState.state === 'positive' ? ' active' : '';
        var negActive = fbState && fbState.state === 'negative' ? ' active' : '';
        var posTitle = fbState && fbState.state === 'positive' ? '已标记喜欢，点这里取消' : '喜欢这张，以后多发';
        var negTitle = fbState && fbState.state === 'negative' ? '已标记不喜欢，点这里取消' : '不喜欢这张，以后少发';
        html += '<div class="pref-feedback-group">';
        // v0.22.0 - 删除入口（图还在时显示），放在反馈按钮最左边
        html += '<button class="pref-feedback-btn pref-del-btn" data-act="delete-sticker" data-sticker="' + escHtml(stickerLabel) + '" title="删除这张表情包（从库中彻底删除）">删除</button>';
        // v0.19.5 - 带上决策日志里的 agent，反馈才记到正确的助手名下（否则写入 default 桶永远读不到）
        html += '<button class="pref-feedback-btn' + posActive + '" data-act="quick-feedback" data-fb="positive" data-sticker="' + escHtml(stickerLabel) + '" data-emotion="' + escHtml(emotion) + '" data-keywords="' + escHtml(kws) + '" data-agent="' + escHtml(e.agent || '') + '" title="' + posTitle + '">喜欢</button>';
        html += '<button class="pref-feedback-btn' + negActive + '" data-act="quick-feedback" data-fb="negative" data-sticker="' + escHtml(stickerLabel) + '" data-emotion="' + escHtml(emotion) + '" data-keywords="' + escHtml(kws) + '" data-agent="' + escHtml(e.agent || '') + '" title="' + negTitle + '">不喜欢</button>';
        html += '<button class="pref-feedback-btn pref-chat-btn" data-act="open-chat" data-sticker="' + escHtml(stickerLabel) + '" title="和小花聊聊这张图哪里不对">和小花聊聊</button>';
        html += '</div>';
      }
      html += '</div>';
    }
    html += '</div>';

    if (allMappings.length === 0) {
      html += '<div style="margin-top:14px;padding:12px 14px;background:var(--primary-light);border:1px dashed var(--primary);border-radius:6px;font-size:12px;color:var(--primary-dark);line-height:1.8">';
      html += '<strong>还没有偏好规则</strong><br>';
      html += '产生偏好的两种方式：<br>';
      html += '① 在聊天里对某张图说"这张我喜欢"或"这图不合适"<br>';
      html += '② 点上面决策日志里的「喜欢 / 不喜欢」按钮直接反馈<br>';
      html += '产生偏好后，这里会出现可手动调整的卡片。';
      html += '</div>';
    }

    if (allMappings.length > 0) {
      html += '<div id="pref-toggle" style="display:flex;align-items:center;gap:6px;font-size:12px;color:var(--text-muted);margin:14px 0 8px;cursor:pointer;user-select:none">'
        + '<span id="pref-toggle-arrow" style="display:inline-block;font-size:11px">▸</span>'
        + '<span>已记住的偏好（' + allMappings.length + ' 条）</span>'
        + '<span style="font-size:10px;color:var(--text-light)">点开展开</span>'
        + '</div>';
      html += '<div id="pref-mapping-list" style="display:none;flex-direction:column;gap:6px">';
      for (var mi = 0; mi < mappingMeta.length; mi++) {
        var meta = mappingMeta[mi];
        var m = meta.mapping;
        var ctx = m.context || {};
        var em = ctx.emotion || '';
        var kw = (ctx.keywords || []).join(', ');
        var pref = m.preferred_ids || [];
        var veto = m.vetoed_ids || [];
        html += '<div class="pref-mapping" data-agent="' + escHtml(meta.agent) + '" data-li="' + meta.localIndex + '">';
        html += '<div style="display:flex;align-items:center;gap:6px;margin-bottom:6px;flex-wrap:wrap">';
        if (em) html += '<span class="tag">' + escHtml(em) + '</span>';
        if (kw) html += '<span style="color:var(--text-muted);flex:1;min-width:100px;overflow:hidden;text-overflow:ellipsis">' + escHtml(kw) + '</span>';
        else html += '<span style="flex:1"></span>';
        html += '</div>';
        if (pref.length > 0) {
          html += '<div style="display:flex;align-items:center;gap:4px;margin-top:3px;flex-wrap:wrap">';
          html += '<span style="color:var(--success);font-size:11px;font-weight:600;flex-shrink:0">喜欢 ' + pref.length + ' 张</span>';
          for (var pi = 0; pi < pref.length; pi++) {
            html += '<span class="pref-chip">'
              + '<img class="pref-thumb" src="' + withAuth(API + '/api/image?id=' + encodeURIComponent(pref[pi])) + '" onerror="this.style.display=\'none\'" alt="">'
              + '<button class="pref-x" data-act="remove" data-list="preferred" data-sticker="' + escHtml(pref[pi]) + '" title="从偏好中移除">×</button>'
              + '<button class="pref-del" data-act="delete-sticker" data-sticker="' + escHtml(pref[pi]) + '" title="删除这张表情包（从库中彻底删除）">删</button>'
              + '</span>';
          }
          html += '</div>';
        }
        if (veto.length > 0) {
          html += '<div style="display:flex;align-items:center;gap:4px;margin-top:3px;flex-wrap:wrap">';
          html += '<span style="color:var(--danger);font-size:11px;font-weight:600;flex-shrink:0">不喜欢 ' + veto.length + ' 张</span>';
          for (var vi = 0; vi < veto.length; vi++) {
            html += '<span class="pref-chip pref-chip-veto">'
              + '<img class="pref-thumb" src="' + withAuth(API + '/api/image?id=' + encodeURIComponent(veto[vi])) + '" onerror="this.style.display=\'none\'" alt="">'
              + '<button class="pref-x" data-act="remove" data-list="vetoed" data-sticker="' + escHtml(veto[vi]) + '" title="从排除中移除">×</button>'
              + '<button class="pref-del" data-act="delete-sticker" data-sticker="' + escHtml(veto[vi]) + '" title="删除这张表情包（从库中彻底删除）">删</button>'
              + '</span>';
          }
          html += '</div>';
        }
        html += '</div>';
      }
      html += '</div>';
    }

    $('pref-log').innerHTML = html;
    bindPreferenceActions();
    
  }

  async function callPrefUpdate(body) {
    try {
      var resp = await fetch(withAuth(API + '/api/preferences/update'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      var data = await resp.json();
      if (data.ok) {
        await refreshPreferences();
        toast('已更新');
      } else {
        toast('更新失败: ' + (data.error || ''), true);
      }
    } catch (err) {
      toast('更新出错: ' + err.message, true);
    }
  }

  async function refreshPreferences() {
    try {
      var resp = await fetch(withAuth(API + '/api/preferences'));
      var data = await resp.json();
      if (data.ok) {
        window.__PREFERENCES__ = data.data;
        renderPreferences();
      }
    } catch (e) {
      console.error('刷新偏好失败', e);
    }
  }

  function bindPreferenceActions() {
    var container = $('pref-log');
    if (!container || container.__prefBound) return;
    container.__prefBound = true;
    container.addEventListener('click', function (e) {
      var toggleHit = e.target.closest('#pref-toggle');
      if (toggleHit) {
        var prefList = $('pref-mapping-list');
        var arrow = $('pref-toggle-arrow');
        if (prefList) {
          var showing = prefList.style.display === 'flex';
          prefList.style.display = showing ? 'none' : 'flex';
          if (arrow) arrow.textContent = showing ? '▸' : '▾';
        }
        return;
      }
      var btn = e.target.closest('button[data-act]');
      if (!btn) return;
      var act = btn.getAttribute('data-act');
      var card = btn.closest('.pref-mapping');

      if (act === 'quick-feedback') {
        var fb = btn.getAttribute('data-fb');
        var stickerId = btn.getAttribute('data-sticker');
        var emotion = btn.getAttribute('data-emotion') || '';
        var kws = btn.getAttribute('data-keywords') || '';
        // v0.19.5 - 透传决策日志的 agent，反馈落到正确助手名下（否则写入 default 桶永远读不到）
        var agent = btn.getAttribute('data-agent') || '';
        // v0.19.5 - 已选中的按钮再点 = 取消这条反馈
        var fbState = findFeedbackFor(agent, stickerId, emotion, kws);
        if (fbState && fbState.state === fb) {
          callPrefUpdate({
            action: 'remove_from_list',
            agent: agent,
            mapping_index: fbState.mappingIndex,
            list: fb === 'positive' ? 'preferred' : 'vetoed',
            sticker_id: stickerId,
          });
          return;
        }
        callQuickFeedback({ sticker_id: stickerId, feedback_type: fb, context_emotion: emotion, context_keywords: kws, agent: agent || undefined });
        return;
      }

      if (act === 'open-chat') {
        var chatStickerId = btn.getAttribute('data-sticker');
        if (chatStickerId) openChatModal(chatStickerId);
        return;
      }

      if (act === 'delete-sticker') {
        var delStickerId = btn.getAttribute('data-sticker');
        customConfirm('确定要删除表情包「' + delStickerId + '」吗？\n会从图库中彻底删除这张图片，并自动清理相关的偏好记录。', function () {
          deleteSticker(delStickerId);
        });
        return;
      }

      if (!card) return;
      var agent = card.getAttribute('data-agent');
      var li = parseInt(card.getAttribute('data-li'), 10);
      if (!agent || isNaN(li)) return;

      if (act === 'remove') {
        var list = btn.getAttribute('data-list');
        var stickerId3 = btn.getAttribute('data-sticker');
        callPrefUpdate({ action: 'remove_from_list', agent: agent, mapping_index: li, list: list, sticker_id: stickerId3 });
      }
    });
  }

  async function callQuickFeedback(body) {
    try {
      var resp = await fetch(withAuth(API + '/api/preferences/correct'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      var data = await resp.json();
      if (data.ok) {
        await refreshPreferences();
        toast('已反馈');
      } else {
        toast('反馈失败: ' + (data.error || ''), true);
      }
    } catch (err) {
      toast('反馈出错: ' + err.message, true);
    }
  }

  // v0.22.0 - 从偏好设置直接删除表情包（二次确认后调删除接口，自动清理偏好引用/向量）
  async function deleteSticker(id) {
    try {
      var resp = await fetch(withAuth(API + '/api'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'delete', id: id }),
      });
      var data = await resp.json();
      if (data.ok) {
        toast(data.message || '已删除');
        await refreshPreferences();
        loadStickers();
      } else {
        toast('删除失败: ' + (data.error || ''), true);
      }
    } catch (err) {
      toast('删除出错: ' + err.message, true);
    }
  }

  // ════════════════════════════════════════════════════════════════
  //  v0.18.0 聊天调整标签
  // ════════════════════════════════════════════════════════════════
  var chatSessionId = null;
  var chatStickerId = null;
  var chatCurrentSuggestion = null;

  async function openChatModal(stickerId) {
    var sticker = allStickers.find(function (s) { return s.id === stickerId; });
    if (!sticker) {
      toast('表情包不存在或已删除', true);
      return;
    }
    chatStickerId = stickerId;
    chatSessionId = null;
    chatCurrentSuggestion = null;

    $('chat-sticker-id').textContent = stickerId;
    $('chat-sticker-img').src = withAuth(API + '/api/image?id=' + encodeURIComponent(stickerId));
    $('chat-sticker-img').onerror = function () { this.style.opacity = '.3'; };

    var tags = sticker.tags || {};
    $('chat-tag-desc').textContent = sticker.description || '（无描述）';
    renderTagList('chat-tag-emotion', tags.emotion || []);
    renderTagList('chat-tag-scene', tags.scene || []);
    renderTagList('chat-tag-keywords', tags.keywords || []);

    $('chat-messages').innerHTML = '<div class="chat-empty">告诉我哪里不对、该怎么调。<br>比如：这张图表达的是撒娇不是开心</div>';
    $('chat-preview').hidden = true;
    $('chat-input').value = '';
    $('chat-send-btn').disabled = false;

    $('chat-modal').hidden = false;
    $('chat-modal').style.display = 'flex';
    setTimeout(function () { $('chat-input').focus(); }, 100);
  }

  function renderTagList(elId, items) {
    var el = $(elId);
    el.innerHTML = '';
    if (!items || items.length === 0) {
      el.innerHTML = '<span style="color:var(--text-light);font-size:11px">（无）</span>';
      return;
    }
    for (var i = 0; i < items.length; i++) {
      var span = document.createElement('span');
      span.className = 'tag';
      span.textContent = items[i];
      el.appendChild(span);
    }
  }

  function appendChatBubble(role, text) {
    var container = $('chat-messages');
    var empty = container.querySelector('.chat-empty');
    if (empty) empty.remove();
    var bubble = document.createElement('div');
    bubble.className = 'chat-bubble chat-' + role;
    bubble.textContent = text;
    container.appendChild(bubble);
    container.scrollTop = container.scrollHeight;
    return bubble;
  }

  function updateChatBubble(bubble, text) {
    if (bubble) bubble.textContent = text;
  }

  async function sendChatMessage() {
    var input = $('chat-input');
    var msg = input.value.trim();
    if (!msg) return;
    appendChatBubble('user', msg);
    input.value = '';
    input.style.height = 'auto';

    var sendBtn = $('chat-send-btn');
    sendBtn.disabled = true;
    sendBtn.textContent = '思考中...';

    var thinkingBubble = appendChatBubble('thinking', '小花正在思考...');

    try {
      var resp = await fetch(withAuth(API + '/api/sticker/chat'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sticker_id: chatStickerId,
          message: msg,
          session_id: chatSessionId,
        }),
      });
      var data = await resp.json();
      thinkingBubble.remove();
      if (data.ok) {
        chatSessionId = data.session_id;
        appendChatBubble('assistant', data.reply || '（无回复）');
        if (data.suggestion) {
          chatCurrentSuggestion = data.suggestion;
          renderChatPreview(data.suggestion);
        }
      } else {
        appendChatBubble('error', '出错：' + (data.error || '未知错误'));
      }
    } catch (e) {
      thinkingBubble.remove();
      appendChatBubble('error', '网络错误：' + e.message);
    } finally {
      sendBtn.disabled = false;
      sendBtn.textContent = '发送';
      input.focus();
    }
  }

  function renderChatPreview(suggestion) {
    var sticker = allStickers.find(function (s) { return s.id === chatStickerId; });
    if (!sticker) return;
    var oldTags = sticker.tags || {};

    var diffHtml = '<div class="chat-preview-col">';
    diffHtml += '<h5>修改前</h5>';
    diffHtml += '<div class="diff-row"><b>描述：</b>' + escHtml(sticker.description || '（空）') + '</div>';
    diffHtml += '<div class="diff-row"><b>情绪：</b>' + (oldTags.emotion || []).map(escHtml).join('、') + '</div>';
    diffHtml += '<div class="diff-row"><b>场景：</b>' + (oldTags.scene || []).map(escHtml).join('、') + '</div>';
    diffHtml += '<div class="diff-row"><b>关键词：</b>' + (oldTags.keywords || []).map(escHtml).join('、') + '</div>';
    diffHtml += '</div>';

    diffHtml += '<div class="chat-preview-col modified">';
    diffHtml += '<h5 class="modified">修改后</h5>';
    diffHtml += '<div class="diff-row"><b>描述：</b>' + escHtml(suggestion.description || sticker.description || '（空）') + '</div>';
    diffHtml += '<div class="diff-row"><b>情绪：</b>' + (suggestion.emotion || []).map(escHtml).join('、') + '</div>';
    diffHtml += '<div class="diff-row"><b>场景：</b>' + (suggestion.scene || []).map(escHtml).join('、') + '</div>';
    diffHtml += '<div class="diff-row"><b>关键词：</b>' + (suggestion.keywords || []).map(escHtml).join('、') + '</div>';
    diffHtml += '</div>';

    $('chat-preview-diff').innerHTML = diffHtml;
    $('chat-preview').hidden = false;
    $('chat-messages').scrollTop = $('chat-messages').scrollHeight;
  }

  function discardChatPreview() {
    chatCurrentSuggestion = null;
    $('chat-preview').hidden = true;
    appendChatBubble('assistant', '好的，那我不动这张图。你要是想继续聊就再说。');
  }

  async function confirmChatChange() {
    if (!chatSessionId || !chatCurrentSuggestion) return;
    var btn = $('chat-preview-confirm');
    btn.disabled = true;
    btn.textContent = '保存中...';
    try {
      var resp = await fetch(withAuth(API + '/api/sticker/chat/confirm'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session_id: chatSessionId,
          sticker_id: chatStickerId,
          new_tags: chatCurrentSuggestion,
        }),
      });
      var data = await resp.json();
      if (data.ok) {
        toast(data.vector_regenerated ? '已修改，向量也重算了' : '已修改');
        closeChatModal();
        await loadStickers();
        await refreshPreferences();
      } else {
        toast('保存失败: ' + (data.error || ''), true);
        btn.disabled = false;
        btn.textContent = '✅ 确认修改';
      }
    } catch (e) {
      toast('网络错误: ' + e.message, true);
      btn.disabled = false;
      btn.textContent = '✅ 确认修改';
    }
  }

  function closeChatModal() {
    // 通知后端清空 session（如果还有效）
    if (chatSessionId) {
      fetch(withAuth(API + '/api/sticker/chat/close'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: chatSessionId }),
      }).catch(function () {});
    }
    chatSessionId = null;
    chatStickerId = null;
    chatCurrentSuggestion = null;
    $('chat-modal').hidden = true;
    $('chat-modal').style.display = '';
  }

  function bindChatModalActions() {
    var sendBtn = $('chat-send-btn');
    if (sendBtn && !sendBtn.__bound) {
      sendBtn.__bound = true;
      sendBtn.addEventListener('click', sendChatMessage);
    }
    var input = $('chat-input');
    if (input && !input.__bound) {
      input.__bound = true;
      input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          sendChatMessage();
        }
      });
      input.addEventListener('input', function () {
        this.style.height = 'auto';
        this.style.height = Math.min(this.scrollHeight, 96) + 'px';
      });
    }
    var confirmBtn = $('chat-preview-confirm');
    if (confirmBtn && !confirmBtn.__bound) {
      confirmBtn.__bound = true;
      confirmBtn.addEventListener('click', confirmChatChange);
    }
    var discardBtn = $('chat-preview-discard');
    if (discardBtn && !discardBtn.__bound) {
      discardBtn.__bound = true;
      discardBtn.addEventListener('click', discardChatPreview);
    }
  }

  async function cleanupPreferences() {
    try {
      var resp = await fetch(withAuth(API + '/api/preferences/cleanup'), { method: 'POST' });
      var data = await resp.json();
      if (data.ok) {
        await refreshPreferences();
        toast(data.message || ('已清理 ' + data.cleanedReferences + ' 条引用'));
      } else {
        toast('清理失败: ' + (data.error || ''), true);
      }
    } catch (err) {
      toast('清理出错: ' + err.message, true);
    }
  }

  // ════════════════════════════════════════════════════════════════
  //  v0.18.x 助手配图频率（场景维度化：日常 / 正事）
  // ════════════════════════════════════════════════════════════════
  var freqAgentsData = [];
  var freqConfigData = { version: 2, default_daily: 50, default_task: 20, agents: {} };
  var currentScene = 'daily';
  var freqDirty = false;
  var duplicateAgentNames = {};

  var FREQ_LEVELS = [
    { value: 0, label: '不配图', desc: '这个场景不主动提示配图' },
    { value: 15, label: '少配图', desc: '偶尔提示' },
    { value: 50, label: '正常', desc: '大约一半合适场景会提示' },
    { value: 90, label: '经常配图', desc: '大多数合适场景会提示' },
  ];

  function getAgentFreqSettings(agentId) {
    if (!freqConfigData.agents[agentId]) {
      freqConfigData.agents[agentId] = {
        enabled: true,
        daily: freqConfigData.default_daily,
        task: freqConfigData.default_task,
      };
    }
    return freqConfigData.agents[agentId];
  }

  function setAgentSceneFreq(agentId, scene, value) {
    var agent = getAgentFreqSettings(agentId);
    if (scene === 'task') agent.task = value;
    else agent.daily = value;
  }

  function freqToLevel(freq) {
    var best = FREQ_LEVELS[0];
    var minDiff = Infinity;
    for (var i = 0; i < FREQ_LEVELS.length; i++) {
      var diff = Math.abs(freq - FREQ_LEVELS[i].value);
      if (diff < minDiff) { minDiff = diff; best = FREQ_LEVELS[i]; }
    }
    return best.value;
  }

  function markFreqDirty() {
    freqDirty = true;
    var status = $('agent-freq-save-status');
    var button = $('save-agent-freq-btn');
    if (status) { status.textContent = '有未保存的更改'; status.classList.add('is-dirty'); }
    if (button) button.disabled = false;
  }

  function markFreqSaved() {
    freqDirty = false;
    var status = $('agent-freq-save-status');
    var button = $('save-agent-freq-btn');
    if (status) { status.textContent = '已保存'; status.classList.remove('is-dirty'); }
    if (button) button.disabled = true;
  }

  function renderAgentFreq() {
    var list = $('agent-freq-list');
    if (!list) return;
    list.innerHTML = '加载中...';

    Promise.all([
      fetch(withAuth(API + '/api/agents'), { signal: AbortSignal.timeout(5000) }).then(function (r) { return r.json(); }),
      fetch(withAuth(API + '/api/agent-freq'), { signal: AbortSignal.timeout(5000) }).then(function (r) { return r.json(); }),
    ]).then(function (results) {
      var agentsResult = results[0];
      var freqResult = results[1];
      if (!agentsResult.ok || !Array.isArray(agentsResult.data) || !freqResult.ok) throw new Error('加载失败');
      freqAgentsData = agentsResult.data;
      freqConfigData = freqResult.data;
      duplicateAgentNames = {};
      for (var i = 0; i < freqAgentsData.length; i++) {
        var name = freqAgentsData[i].name || freqAgentsData[i].id;
        duplicateAgentNames[name] = (duplicateAgentNames[name] || 0) + 1;
      }
      markFreqSaved();
      renderAgentFreqList();
      bindSceneToggle();
      bindFreqList();
      bindFreqSave();
    }).catch(function () {
      list.innerHTML = '<div style="color:var(--text-muted);font-size:13px">加载失败，请稍后重试</div>';
    });
  }

  function bindSceneToggle() {
    var toggle = $('agent-freq-scene-toggle');
    if (!toggle || toggle.dataset.bound === '1') return;
    toggle.dataset.bound = '1';
    var btns = toggle.querySelectorAll('.scene-toggle-btn');
    btns.forEach(function (btn) {
      btn.addEventListener('click', function () {
        var scene = this.getAttribute('data-scene');
        if (currentScene === scene) return;
        currentScene = scene;
        btns.forEach(function (b) {
          var active = b.getAttribute('data-scene') === scene;
          b.classList.toggle('scene-toggle-btn-active', active);
          b.style.background = active ? 'var(--primary-light)' : 'transparent';
          b.style.color = active ? 'var(--primary-dark)' : 'var(--text-muted)';
          b.style.fontWeight = active ? '600' : '500';
        });
        renderAgentFreqList();
      });
    });
  }

  function renderAgentFreqRow(agent) {
    var settings = getAgentFreqSettings(agent.id);
    var freq = currentScene === 'task' ? settings.task : settings.daily;
    var selectedLevel = freqToLevel(freq);
    var showId = duplicateAgentNames[agent.name || agent.id] > 1;
    var html = '<div class="agent-freq-item' + (settings.enabled ? '' : ' is-off') + '" data-agent-row="' + escHtml(agent.id) + '">';
    html += '<div class="agent-freq-head"><span class="agent-freq-name">' + escHtml(agent.name || agent.id) + '</span>';
    if (showId) html += '<span class="agent-freq-id">' + escHtml(agent.id) + '</span>';
    html += '<button type="button" class="freq-enabled-btn' + (settings.enabled ? '' : ' is-off') + '" data-act="toggle-freq-enabled" data-agent-id="' + escHtml(agent.id) + '">' + (settings.enabled ? '允许配图' : '点击开启') + '</button></div>';
    html += '<div class="freq-options">';
    for (var i = 0; i < FREQ_LEVELS.length; i++) {
      var level = FREQ_LEVELS[i];
      html += '<button type="button" class="freq-btn' + (level.value === selectedLevel ? ' freq-btn-active' : '') + '" data-act="set-freq" data-agent-id="' + escHtml(agent.id) + '" data-freq="' + level.value + '" title="' + escHtml(level.desc) + '">' + escHtml(level.label) + '</button>';
    }
    html += '</div></div>';
    return html;
  }

  function renderAgentFreqList() {
    var list = $('agent-freq-list');
    if (!list) return;
    if (freqAgentsData.length === 0) {
      list.innerHTML = '<div style="color:var(--text-muted);font-size:13px">没有找到助手</div>';
      return;
    }
    var html = '';
    for (var i = 0; i < freqAgentsData.length; i++) html += renderAgentFreqRow(freqAgentsData[i]);
    list.innerHTML = html;
  }

  function findAgentFreqRow(agentId) {
    var list = $('agent-freq-list');
    if (!list) return null;
    var rows = list.querySelectorAll('[data-agent-row]');
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].getAttribute('data-agent-row') === agentId) return rows[i];
    }
    return null;
  }

  function refreshAgentFreqRow(agentId, focusAction, focusFreq) {
    var row = findAgentFreqRow(agentId);
    var agent = freqAgentsData.find(function (item) { return item.id === agentId; });
    if (!row || !agent) return;
    row.outerHTML = renderAgentFreqRow(agent);
    var newRow = findAgentFreqRow(agentId);
    if (!newRow || !focusAction) return;
    var buttons = newRow.querySelectorAll('button[data-act]');
    for (var i = 0; i < buttons.length; i++) {
      var sameAction = buttons[i].getAttribute('data-act') === focusAction;
      var sameFreq = focusAction !== 'set-freq' || buttons[i].getAttribute('data-freq') === focusFreq;
      if (sameAction && sameFreq) { buttons[i].focus(); break; }
    }
  }

  function bindFreqList() {
    var list = $('agent-freq-list');
    if (!list || list.dataset.bound === '1') return;
    list.dataset.bound = '1';
    list.addEventListener('click', function (event) {
      var button = event.target.closest('button[data-act]');
      if (!button) return;
      var agentId = button.getAttribute('data-agent-id');
      if (!agentId) return;
      var action = button.getAttribute('data-act');
      var focusFreq = button.getAttribute('data-freq');
      if (action === 'toggle-freq-enabled') {
        var settings = getAgentFreqSettings(agentId);
        settings.enabled = !settings.enabled;
      } else if (action === 'set-freq') {
        setAgentSceneFreq(agentId, currentScene, parseInt(button.getAttribute('data-freq'), 10));
      } else {
        return;
      }
      markFreqDirty();
      refreshAgentFreqRow(agentId, action, focusFreq);
    });
  }

  function bindFreqSave() {
    var saveButton = $('save-agent-freq-btn');
    if (!saveButton || saveButton.dataset.bound === '1') return;
    saveButton.dataset.bound = '1';
    saveButton.addEventListener('click', function () {
      if (!freqDirty) return;
      var status = $('agent-freq-save-status');
      saveButton.disabled = true;
      if (status) { status.textContent = '正在保存…'; status.classList.remove('is-dirty'); }
      fetch(withAuth(API + '/api/agent-freq'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(freqConfigData),
        signal: AbortSignal.timeout(5000),
      }).then(function (response) { return response.json(); })
        .then(function (result) {
          if (!result.ok) throw new Error(result.error || '保存失败');
          freqConfigData = result.data;
          markFreqSaved();
          toast('已保存');
        }).catch(function (error) {
          markFreqDirty();
          toast('保存失败：' + error.message, true);
        });
    });
  }

  // ════════════════════════════════════════════════════════════════
  //  v0.20.0 方言口音（让助手说话带方言味）
  // ════════════════════════════════════════════════════════════════
  var dialectAgentsData = [];
  var dialectConfigData = { version: 2, agents: {} };
  var dialectMetaData = { dialects: [] };
  var dialectDirty = false;
  var dialectDuplicateNames = {};

  function getDialectSetting(agentId) {
    if (!dialectConfigData.agents[agentId]) {
      dialectConfigData.agents[agentId] = { dialect: '', enabled: false };
    }
    return dialectConfigData.agents[agentId];
  }

  function markDialectDirty() {
    dialectDirty = true;
    var status = $('dialect-save-status');
    var button = $('save-dialect-btn');
    if (status) { status.textContent = '有未保存的更改'; status.classList.add('is-dirty'); }
    if (button) button.disabled = false;
  }

  function markDialectSaved() {
    dialectDirty = false;
    var status = $('dialect-save-status');
    var button = $('save-dialect-btn');
    if (status) { status.textContent = '已保存'; status.classList.remove('is-dirty'); }
    if (button) button.disabled = true;
  }

  // 方言预览句（v0.23.0 起难度提示仅新疆话保留，其余方言不带括号标注）
  function dialectPreviewText(dialectId) {
    var d = null;
    for (var i = 0; i < dialectMetaData.dialects.length; i++) {
      if (dialectMetaData.dialects[i].id === dialectId) { d = dialectMetaData.dialects[i]; break; }
    }
    if (!d) return '';
    var note = d.difficultyNote ? '（模型表现：' + d.difficultyNote + '）' : '';
    return '开启后 ta 打字会自然带点' + d.name + '味，正事闲聊都这样' + note + ' · ' + d.tagline;
  }

  // 方言 id → 名字（渲染选择器按钮标签用）
  function dialectName(id) {
    for (var i = 0; i < dialectMetaData.dialects.length; i++) {
      if (dialectMetaData.dialects[i].id === id) return dialectMetaData.dialects[i].name;
    }
    return id;
  }

  // v0.23.0 单控件选择器：一个按钮搞定开关+选择（选方言=开，选(不选)=关）
  function renderDialectRow(agent) {
    var settings = getDialectSetting(agent.id);
    var enabled = settings.dialect && settings.enabled;
    var showId = dialectDuplicateNames[agent.name || agent.id] > 1;
    var html = '<div class="dialect-item' + (enabled ? '' : ' is-off') + '" data-agent-row="' + escHtml(agent.id) + '">';
    html += '<div class="dialect-head"><span class="dialect-name">' + escHtml(agent.name || agent.id) + '</span>';
    if (showId) html += '<span class="dialect-id">' + escHtml(agent.id) + '</span>';
    html += '<div class="dialect-picker" data-agent-id="' + escHtml(agent.id) + '">';
    html += '<button type="button" class="dialect-picker-btn' + (enabled ? ' is-on' : '') + '" data-act="toggle-picker">';
    html += '<span class="dialect-picker-label">' + escHtml(enabled ? dialectName(settings.dialect) : '选个方言') + '</span>';
    html += '<span class="dialect-picker-arrow">▾</span></button>';
    html += '<div class="dialect-picker-menu" hidden>';
    html += '<button type="button" data-act="pick-dialect" data-value="" class="is-none' + (!enabled ? ' is-current' : '') + '">(不选)</button>';
    for (var i = 0; i < dialectMetaData.dialects.length; i++) {
      var d = dialectMetaData.dialects[i];
      html += '<button type="button" data-act="pick-dialect" data-value="' + escHtml(d.id) + '"' + (settings.dialect === d.id ? ' class="is-current"' : '') + '>' + escHtml(d.name);
      if (d.difficultyNote) html += '<span class="dialect-picker-note">' + escHtml(d.difficultyNote) + '</span>';
      html += '</button>';
    }
    html += '</div></div>';
    html += '</div>';
    html += '<div class="dialect-preview" id="dialect-preview-' + escHtml(agent.id) + '">' + (enabled ? escHtml(dialectPreviewText(settings.dialect)) : '挑一个方言试试，味道会显示在这里') + '</div>';
    html += '</div>';
    return html;
  }

  function renderDialectList() {
    var list = $('dialect-list');
    if (!list) return;
    if (dialectAgentsData.length === 0) {
      list.innerHTML = '<div style="color:var(--text-muted);font-size:13px">没有找到助手</div>';
      return;
    }
    var html = '';
    for (var i = 0; i < dialectAgentsData.length; i++) html += renderDialectRow(dialectAgentsData[i]);
    list.innerHTML = html;
  }

  function refreshDialectRow(agentId) {
    var list = $('dialect-list');
    if (!list) return;
    var rows = list.querySelectorAll('[data-agent-row]');
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].getAttribute('data-agent-row') === agentId) {
        var agent = null;
        for (var j = 0; j < dialectAgentsData.length; j++) {
          if (dialectAgentsData[j].id === agentId) { agent = dialectAgentsData[j]; break; }
        }
        if (agent) rows[i].outerHTML = renderDialectRow(agent);
        return;
      }
    }
  }

  function renderDialect() {
    var list = $('dialect-list');
    if (!list) return;
    list.innerHTML = '加载中...';

    Promise.all([
      fetch(withAuth(API + '/api/agents'), { signal: AbortSignal.timeout(5000) }).then(function (r) { return r.json(); }),
      fetch(withAuth(API + '/api/dialect'), { signal: AbortSignal.timeout(5000) }).then(function (r) { return r.json(); }),
    ]).then(function (results) {
      var agentsResult = results[0];
      var dialectResult = results[1];
      if (!agentsResult.ok || !Array.isArray(agentsResult.data) || !dialectResult.ok) throw new Error('加载失败');
      dialectAgentsData = agentsResult.data;
      dialectConfigData = dialectResult.data.config || { version: 2, agents: {} };
      dialectMetaData = dialectResult.data;
      dialectDuplicateNames = {};
      for (var i = 0; i < dialectAgentsData.length; i++) {
        var name = dialectAgentsData[i].name || dialectAgentsData[i].id;
        dialectDuplicateNames[name] = (dialectDuplicateNames[name] || 0) + 1;
      }
      markDialectSaved();
      renderDialectList();
      bindDialectList();
      bindDialectSave();
    }).catch(function () {
      list.innerHTML = '<div style="color:var(--text-muted);font-size:13px">加载失败，请稍后重试</div>';
    });
  }

  function bindDialectList() {
    var list = $('dialect-list');
    if (!list || list.dataset.bound === '1') return;
    list.dataset.bound = '1';
    list.addEventListener('click', function (event) {
      var pickerBtn = event.target.closest('button[data-act="toggle-picker"]');
      if (pickerBtn) {
        var picker = pickerBtn.closest('.dialect-picker');
        if (!picker) return;
        var menu = picker.querySelector('.dialect-picker-menu');
        var wasOpen = menu && !menu.hidden;
        closeAllDialectMenus();
        if (!wasOpen && menu) { menu.hidden = false; picker.classList.add('open'); }
        return;
      }
      var pickBtn = event.target.closest('button[data-act="pick-dialect"]');
      if (pickBtn) {
        var picker2 = pickBtn.closest('.dialect-picker');
        if (!picker2) return;
        var agentId = picker2.getAttribute('data-agent-id');
        if (!agentId) return;
        var settings = getDialectSetting(agentId);
        settings.dialect = pickBtn.getAttribute('data-value') || '';
        settings.enabled = !!settings.dialect;
        closeAllDialectMenus();
        markDialectDirty();
        refreshDialectRow(agentId);
        return;
      }
    });
    // 点击选择器外部时收起所有下拉面板
    document.addEventListener('click', function (event) {
      if (!event.target.closest('.dialect-picker')) closeAllDialectMenus();
    });
  }

  function closeAllDialectMenus() {
    var list = $('dialect-list');
    if (!list) return;
    var menus = list.querySelectorAll('.dialect-picker-menu');
    for (var i = 0; i < menus.length; i++) menus[i].hidden = true;
    var pickers = list.querySelectorAll('.dialect-picker.open');
    for (var j = 0; j < pickers.length; j++) pickers[j].classList.remove('open');
  }

  function bindDialectSave() {
    var saveButton = $('save-dialect-btn');
    if (!saveButton || saveButton.dataset.bound === '1') return;
    saveButton.dataset.bound = '1';
    saveButton.addEventListener('click', function () {
      if (!dialectDirty) return;
      var status = $('dialect-save-status');
      saveButton.disabled = true;
      if (status) { status.textContent = '正在保存…'; status.classList.remove('is-dirty'); }
      fetch(withAuth(API + '/api/dialect'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(dialectConfigData),
        signal: AbortSignal.timeout(5000),
      }).then(function (response) { return response.json(); })
        .then(function (result) {
          if (!result.ok) throw new Error(result.error || '保存失败');
          dialectConfigData = result.data;
          markDialectSaved();
          if (result.syncFailed && result.syncFailed.length) {
            var names = result.syncFailed.map(function (f) { return f.agentId; }).join('、');
            var reason = result.syncFailed.map(function (f) { return f.error; }).join('；');
            toast('已保存，但 ' + names + ' 的人格写入失败：' + reason + '（重启后不生效）', true);
          } else {
            toast(result.message || '已保存');
          }
        }).catch(function (error) {
          markDialectDirty();
          toast('保存失败：' + error.message, true);
        });
    });
  }

  // ═══════════════════════════════════
  //  多选模式 + 批量操作
  // ═══════════════════════════════════
  function toggleBatchMode() {
    batchMode = !batchMode;
    document.body.classList.toggle('batch-mode', batchMode);
    var btn = $('btnToggleMulti');
    if (btn) {
      btn.textContent = batchMode ? '退出多选识图' : '多选图片识图';
      btn.style.background = batchMode ? 'var(--primary-light)' : '';
      btn.style.borderColor = batchMode ? 'var(--primary)' : '';
      btn.style.color = batchMode ? 'var(--primary)' : '';
    }
    var toolbar = $('batch-toolbar');
    if (toolbar) toolbar.hidden = !batchMode;
    if (!batchMode) clearSelection();
  }

  function toggleSelect(id) {
    if (selectedIds.has(id)) selectedIds.delete(id);
    else selectedIds.add(id);
    var card = document.querySelector('.sticker-card[data-id="' + id + '"]');
    if (card) card.classList.toggle('selected', selectedIds.has(id));
    updateBatchCount();
  }

  function clearSelection() {
    selectedIds.clear();
    document.querySelectorAll('.sticker-card.selected').forEach(function (c) { c.classList.remove('selected'); });
    updateBatchCount();
  }

  function selectAllVisible() {
    document.querySelectorAll('#sticker-grid .sticker-card').forEach(function (c) {
      var id = c.getAttribute('data-id');
      if (id && !selectedIds.has(id)) { selectedIds.add(id); c.classList.add('selected'); }
    });
    updateBatchCount();
  }

  async function selectAllUntagged() {
    var button = $('batch-select-untagged');
    if (button) button.disabled = true;
    try {
      var resp = await fetch(withAuth(API + '/api/list'), { signal: AbortSignal.timeout(5000) });
      var data = await resp.json();
      if (!resp.ok || !data.ok) throw new Error(data.error || ('HTTP ' + resp.status));
      var untagged = (data.data || []).filter(function (sticker) { return !sticker.tagged_at; });
      selectedIds.clear();
      for (var i = 0; i < untagged.length; i++) selectedIds.add(untagged[i].id);
      document.querySelectorAll('#sticker-grid .sticker-card').forEach(function (card) {
        card.classList.toggle('selected', selectedIds.has(card.getAttribute('data-id')));
      });
      updateBatchCount();
      toast(untagged.length ? '已选中全部 ' + untagged.length + ' 张未识图表情包' : '图库里没有未识图的表情包');
    } catch (e) {
      toast('读取未识图列表失败：' + e.message, true);
    } finally {
      if (button) button.disabled = false;
    }
  }

  function updateBatchCount() {
    var el = $('batch-count');
    if (el) el.textContent = selectedIds.size;
  }

  async function batchDelete() {
    if (selectedIds.size === 0) { toast('请先勾选表情包', true); return; }
    var ids = Array.from(selectedIds);
    customConfirm('确定要批量删除 ' + ids.length + ' 张表情包吗？', async function () {
      var ok = 0, fail = 0;
      for (var i = 0; i < ids.length; i++) {
        try {
          var resp = await fetch(withAuth(API + '/api'), {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'delete', id: ids[i] }),
          });
          var d = await resp.json();
          if (d.ok) ok++; else fail++;
        } catch { fail++; }
      }
      clearSelection();
      loadStickers();
      toast(ok + ' 张已删除' + (fail ? '（' + fail + ' 张失败）' : ''), fail > 0);
    });
  }

  function closeBatchModal() {
    var modal = $('batch-modal');
    if (modal) { modal.hidden = true; modal.style.display = ''; }
    stopBatchPolling();
    currentBatchTaskId = null;
  }

  function addModalCloseButton() {
    var box = $('batch-modal').querySelector('.modal-box');
    if (!box) return;
    var existing = box.querySelector('#batch-modal-close');
    if (existing) return;
    var btn = document.createElement('button');
    btn.id = 'batch-modal-close';
    btn.className = 'modal-close';
    btn.textContent = '✕';
    btn.style.cssText = 'position:absolute;top:14px;right:16px;z-index:10;width:30px;height:30px;border:1px solid var(--border);border-radius:50%;background:var(--surface);cursor:pointer;font-size:16px;line-height:1;color:var(--text-muted);font-family:inherit;display:flex;align-items:center;justify-content:center;padding:0';
    btn.onclick = closeBatchModal;
    box.appendChild(btn);
  }

  // ═══════════════════════════════════
  //  异步批量识图
  // ═══════════════════════════════════
  var batchPollTimer = null;
  var currentBatchTaskId = null;
  var batchTaskNotified = {};
  var batchTasksData = [];

  async function batchAutoTag() {
    if (selectedIds.size === 0) { toast('请先勾选表情包', true); return; }
    var ids = Array.from(selectedIds);
    if (ids.length > 200) { toast('单次最多 200 张，请分批', true); return; }

    var modal = $('batch-modal');
    var summary = $('batch-summary');
    var list = $('batch-list');
    modal.removeAttribute('hidden');
    modal.hidden = false;
    modal.style.cssText = 'display:flex;position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(45,58,53,.45);align-items:center;justify-content:center;z-index:99999;pointer-events:auto';
    addModalCloseButton();

    var placeholderHtml = '';
    for (var i = 0; i < ids.length; i++) {
      placeholderHtml += renderBatchPlaceholder(ids[i]);
    }
    list.innerHTML = placeholderHtml;
    summary.innerHTML = renderBatchSummary(0, ids.length, 0, true);

    try {
      var resp = await fetch(withAuth(API + '/api/batch-auto-tag'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sticker_ids: ids, concurrency: 5 }),
      });
      var data = await resp.json();
      if (data.ok) {
        currentBatchTaskId = data.data.taskId;
        summary.innerHTML = renderBatchSummary(0, ids.length, 0, true);
        if (batchPollTimer) clearInterval(batchPollTimer);
        batchPollTimer = setInterval(function () { pollBatchTask(currentBatchTaskId); }, 1500);
        pollBatchTask(currentBatchTaskId);
      } else {
        summary.innerHTML = '<div style="color:var(--danger)">创建任务失败：' + escHtml(data.error || '') + '</div>';
      }
    } catch (e) {
      summary.innerHTML = '<div style="color:var(--danger)">网络错误：' + escHtml(e.message) + '</div>';
    }
  }

  function stopBatchPolling() {
    if (batchPollTimer) { clearInterval(batchPollTimer); batchPollTimer = null; }
  }

  async function pollBatchTask(taskId) {
    try {
      var resp = await fetch(withAuth(API + '/api/batch-task/' + encodeURIComponent(taskId)), { cache: 'no-store' });
      var data = await resp.json();
      if (!data.ok) {
        $('batch-list').innerHTML = '<div style="color:var(--danger);padding:20px">❌ ' + escHtml(data.error || '任务不存在') + '</div>';
        $('batch-summary').innerHTML = '';
        stopBatchPolling();
        return;
      }
      renderBatchTaskDetail(data.data);
    } catch (e) {
      console.warn('[batch] poll error:', e);
    }
  }

  function renderBatchTaskDetail(task) {
    var processed = task.completed.length + task.failed.length;
    var pct = task.total > 0 ? Math.round(processed / task.total * 100) : 0;
    $('batch-summary').innerHTML = renderBatchTaskSummary(task, processed, pct);

    var listHtml = '';
    // v0.15.1 - 支持多并发：current_ids 是正在处理的数组
    var currentIds = Array.isArray(task.current_ids) ? task.current_ids : (task.current ? [task.current] : []);
    if (task.status === 'running') {
      for (var ci = 0; ci < currentIds.length; ci++) {
        listHtml += renderBatchTaskItem(currentIds[ci], null, 'processing');
      }
    }
    var appliedIds = new Set(Array.isArray(task.applied) ? task.applied : []);
    for (var i = 0; i < task.completed.length; i++) {
      var completedId = task.completed[i];
      listHtml += renderBatchTaskItem(completedId, task.results[completedId], appliedIds.has(completedId) ? 'applied' : 'success');
    }
    for (var j = 0; j < task.failed.length; j++) {
      var f = task.failed[j];
      listHtml += renderBatchTaskItem(f.id, { ok: false, error: f.error }, 'failed');
    }
    if (task.pending.length > 0 && task.status === 'running') {
      for (var k = 0; k < Math.min(task.pending.length, 10); k++) {
        listHtml += renderBatchTaskItem(task.pending[k], null, 'pending');
      }
      if (task.pending.length > 10) {
        listHtml += '<div style="text-align:center;color:var(--text-muted);padding:8px;font-size:11px">还有 ' + (task.pending.length - 10) + ' 张待处理...</div>';
      }
    }
    $('batch-list').innerHTML = listHtml || '<div style="text-align:center;padding:30px;color:var(--text-muted)">暂无内容</div>';
    bindBatchItemActions();
    if (task.status !== 'running') stopBatchPolling();
  }

  function renderBatchTaskSummary(task, processed, pct) {
    var statusLabel = { running:'进行中', completed:'已完成', failed:'失败', cancelled:'已取消' }[task.status] || task.status;
    var statusColor = { running:'var(--primary)', completed:'var(--success)', failed:'var(--danger)', cancelled:'var(--text-muted)' }[task.status] || 'var(--primary)';

    var html = '<div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">';
    html += '<div style="flex:1;min-width:200px">';
    html += '<div style="font-size:13px;color:var(--primary-dark);margin-bottom:4px">';
    html += '<b style="color:' + statusColor + '">' + statusLabel + '</b>';
    html += ' · 已处理 <b style="color:var(--primary)">' + processed + '</b> / ' + task.total;
    html += '（成功 <b style="color:var(--success)">' + task.completed.length + '</b>';
    if (task.failed.length > 0) html += '，失败 <b style="color:var(--danger)">' + task.failed.length + '</b>';
    html += '）</div>';
    html += '<div style="height:6px;background:var(--border);border-radius:3px;overflow:hidden"><div style="height:100%;width:' + pct + '%;background:' + statusColor + ';transition:width .3s"></div></div>';
    html += '</div>';
    var showApply = task.status === 'completed' && task.completed.length > (task.applied || []).length;
    var showRetry = task.status === 'completed' && task.failed.length > 0;
    if (task.status === 'running' || showApply || showRetry) {
      html += '<div style="display:flex;flex-direction:column;gap:8px;align-items:stretch;min-width:92px;margin-left:auto;flex-shrink:0">';
      if (task.status === 'running') {
        html += '<button class="btn btn-secondary" id="batch-cancel-task" data-task-id="' + escHtml(task.id) + '" style="font-size:12px;width:100%">取消任务</button>';
      } else if (showApply) {
        html += '<button class="btn btn-secondary" id="batch-apply-all" style="border-color:var(--success);color:var(--success);width:100%">全部应用</button>';
      }
      if (showRetry) {
        html += '<button class="btn btn-secondary" id="batch-retry-failed" style="border-color:var(--danger);color:var(--danger);width:100%">全部重试</button>';
      }
      html += '</div>';
    }
    html += '</div>';
    return html;
  }

  function renderBatchTaskItem(id, result, status) {
    var sticker = allStickers.find(function (s) { return s.id === id; });
    var desc = sticker ? sticker.description : id;
    var imgUrl = withAuth(API + '/api/image?id=' + encodeURIComponent(id));
    var statusBadge = {
      success: '<div class="batch-status pending">待确认</div>',
      applied: '<div class="batch-status applied">已应用</div>',
      failed: '<div class="batch-status" style="background:var(--danger-light);color:var(--danger)">失败</div>',
      processing: '<div class="batch-status pending"><span class="spinner" style="width:10px;height:10px;border-width:2px;display:inline-block;vertical-align:middle;margin-right:4px"></span>处理中</div>',
      pending: '<div class="batch-status" style="background:#f5f5f5;color:#999">待处理</div>',
    }[status] || '';

    var html = '<div class="batch-item" data-id="' + escHtml(id) + '" data-status="' + status + '">';
    html += '<img class="batch-thumb" src="' + imgUrl + '" onerror="this.style.display=\'none\'" alt="">';
    html += '<div class="batch-info-col">';
    html += '<div style="font-weight:500;margin-bottom:3px">' + escHtml(desc) + ' <span style="color:var(--text-light);font-size:11px;font-family:monospace">' + escHtml(id) + '</span></div>';
    if ((status === 'success' || status === 'applied') && result && result.ok) {
      var sug = result.data;
      html += '<div class="batch-tag-line"><b>描述：</b>' + escHtml(sug.description) + '</div>';
      if (sug.semantic_description) html += '<div class="batch-tag-line" style="color:var(--text-light)"><b>语义：</b>' + escHtml(sug.semantic_description) + '</div>';
      html += '<div class="batch-tag-line"><b>情绪：</b>' + sug.emotion.map(function (t) { return '<span>' + escHtml(t) + '</span>'; }).join('') + '</div>';
      html += '<div class="batch-tag-line"><b>场景：</b>' + sug.scene.map(function (t) { return '<span>' + escHtml(t) + '</span>'; }).join('') + '</div>';
      html += '<div class="batch-tag-line"><b>关键词：</b>' + sug.keywords.map(function (t) { return '<span>' + escHtml(t) + '</span>'; }).join('') + '</div>';
      html += '<div class="batch-edit-area">';
      html += '<input class="batch-edit-desc" placeholder="描述" value="' + escHtml(sug.description) + '">';
      html += '<input class="batch-edit-semantic" type="hidden" value="' + escHtml(sug.semantic_description || '') + '">';
      html += '<input class="batch-edit-emotion" placeholder="情绪（逗号分隔）" value="' + escHtml(sug.emotion.join(', ')) + '">';
      html += '<input class="batch-edit-scene" placeholder="场景（逗号分隔）" value="' + escHtml(sug.scene.join(', ')) + '">';
      html += '<input class="batch-edit-keywords" placeholder="关键词（逗号分隔）" value="' + escHtml(sug.keywords.join(', ')) + '">';
      html += '<div class="batch-edit-actions">';
      html += '<button data-edit-act="cancel">取消</button>';
      html += '<button data-edit-act="confirm" style="border-color:var(--primary);color:var(--primary)">确认修改</button>';
      html += '</div></div>';
    } else if (status === 'failed' && result) {
      html += '<div style="color:var(--danger);font-size:12px">❌ ' + escHtml(result.error || '未知错误') + '</div>';
      html += '<div style="margin-top:6px"><button data-batch-act="retry" class="batch-retry-btn" style="border:1px solid var(--danger);color:var(--danger);background:var(--surface);font-size:11px;padding:3px 8px;border-radius:3px;cursor:pointer">重试识图</button></div>';
    } else if (status === 'processing') {
      html += '<div style="color:var(--primary);font-size:11px;display:flex;align-items:center;gap:6px"><span class="spinner" style="width:10px;height:10px;border-width:2px;display:inline-block"></span>正在识别这张图...</div>';
    } else if (status === 'pending') {
      html += '<div style="color:var(--text-muted);font-size:11px">等待识别...</div>';
    }
    html += '</div>';
    html += '<div style="display:flex;flex-direction:column;align-items:center;gap:6px;flex-shrink:0">';
    html += statusBadge;
    if (status === 'success') {
      html += '<div class="batch-actions-col">';
      html += '<button class="apply" data-batch-act="apply">应用</button>';
      html += '<button data-batch-act="edit">编辑</button>';
      html += '</div>';
    }
    html += '</div>';
    html += '</div>';
    return html;
  }

  function renderBatchPlaceholder(id) {
    var sticker = allStickers.find(function (s) { return s.id === id; });
    var desc = sticker ? sticker.description : id;
    var imgUrl = withAuth(API + '/api/image?id=' + encodeURIComponent(id));
    var html = '<div class="batch-item" data-id="' + escHtml(id) + '" data-status="processing">';
    html += '<img class="batch-thumb" src="' + imgUrl + '" onerror="this.style.display=\'none\'" alt="">';
    html += '<div class="batch-info-col">';
    html += '<div style="font-weight:500;margin-bottom:3px">' + escHtml(desc) + ' <span style="color:var(--text-light);font-size:11px;font-family:monospace">' + escHtml(id) + '</span></div>';
    html += '<div style="color:var(--text-muted);font-size:11px;display:flex;align-items:center;gap:6px"><span class="spinner" style="width:10px;height:10px;border-width:2px;display:inline-block"></span>等待处理...</div>';
    html += '</div>';
    html += '<div style="display:flex;flex-direction:column;align-items:center;gap:6px;flex-shrink:0">';
    html += '<div class="batch-status pending">处理中</div>';
    html += '</div>';
    html += '</div>';
    return html;
  }

  function bindBatchItemActions() {
    var list = $('batch-list');
    if (!list || list.__bound) return;
    list.__bound = true;
    list.addEventListener('mousedown', function (e) {
      if (e.target.closest('.batch-edit-area, input, textarea')) e.stopPropagation();
    }, true);
    list.addEventListener('mouseup', function (e) {
      if (e.target.closest('.batch-edit-area, input, textarea')) e.stopPropagation();
    }, true);
    list.addEventListener('click', function (e) {
      var btn = e.target.closest('button[data-batch-act]');
      if (!btn) return;
      var item = btn.closest('.batch-item');
      if (!item) return;
      var act = btn.getAttribute('data-batch-act');
      var id = item.getAttribute('data-id');
      if (act === 'apply') applyBatchItem(item, id, null);
      else if (act === 'edit') {
        var editArea = item.querySelector('.batch-edit-area');
        if (editArea) editArea.classList.toggle('open');
      } else if (act === 'retry') retryBatchItem(id, item);
    });
    list.addEventListener('click', function (e) {
      var btn = e.target.closest('button[data-edit-act]');
      if (!btn) return;
      var editArea = btn.closest('.batch-edit-area');
      if (!editArea) return;
      var item = btn.closest('.batch-item');
      var id = item.getAttribute('data-id');
      var editAct = btn.getAttribute('data-edit-act');
      if (editAct === 'cancel') editArea.classList.remove('open');
      else if (editAct === 'confirm') {
        var customTags = {
          description: editArea.querySelector('.batch-edit-desc').value.trim(),
          semantic_description: (editArea.querySelector('.batch-edit-semantic') || {}).value || '',
          emotion: editArea.querySelector('.batch-edit-emotion').value.split(',').map(function (s) { return s.trim(); }).filter(Boolean),
          scene: editArea.querySelector('.batch-edit-scene').value.split(',').map(function (s) { return s.trim(); }).filter(Boolean),
          keywords: editArea.querySelector('.batch-edit-keywords').value.split(',').map(function (s) { return s.trim(); }).filter(Boolean),
        };
        applyBatchItem(item, id, customTags);
      }
    });
  }

  function setBatchItemStatus(item, status, text) {
    var el = item.querySelector('.batch-status');
    if (!el) return;
    el.className = 'batch-status ' + status;
    el.textContent = text;
    item.setAttribute('data-status', status);
    item.querySelectorAll('button[data-batch-act]').forEach(function (b) { b.disabled = true; b.style.opacity = '0.4'; });
  }

  async function markBatchItemsApplied(taskId, ids) {
    if (!taskId || !ids.length) return false;
    try {
      var resp = await fetch(withAuth(API + '/api/batch-task/' + encodeURIComponent(taskId) + '/applied'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sticker_ids: ids }),
      });
      var data = await resp.json();
      return !!data.ok;
    } catch (e) {
      return false;
    }
  }

  async function applyBatchItem(item, id, customTags) {
    var taskId = currentBatchTaskId;
    var editArea = item.querySelector('.batch-edit-area');
    var tags;
    if (customTags) { tags = customTags; }
    else {
      var sug = { description: '', emotion: [], scene: [], keywords: [] };
      if (editArea) {
        sug.description = editArea.querySelector('.batch-edit-desc').value.trim();
        sug.semantic_description = (editArea.querySelector('.batch-edit-semantic') || {}).value || '';
        sug.emotion = editArea.querySelector('.batch-edit-emotion').value.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
        sug.scene = editArea.querySelector('.batch-edit-scene').value.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
        sug.keywords = editArea.querySelector('.batch-edit-keywords').value.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
      }
      tags = sug;
    }
    try {
      var resp = await fetch(withAuth(API + '/api'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'update', id: id,
          description: tags.description,
          semantic_description: tags.semantic_description || '',
          emotion: tags.emotion.join(', '),
          scene: tags.scene.join(', '),
          keywords: tags.keywords.join(', '),
        }),
      });
      var data = await resp.json();
      if (data.ok) {
        var marked = await markBatchItemsApplied(taskId, [id]);
        setBatchItemStatus(item, 'applied', '已应用');
        if (!marked) toast('标签已应用，但任务确认状态保存失败', true);
        selectedIds.delete(id);
        var card = document.querySelector('.sticker-card[data-id="' + id + '"]');
        if (card) card.classList.remove('selected');
        var sticker = allStickers.find(function (s) { return s.id === id; });
        if (sticker) sticker.tagged_at = data.tagged_at || new Date().toISOString();
        updateBatchCount();
      } else {
        toast('更新失败: ' + (data.error || ''), true);
      }
    } catch (e) {
      toast('更新出错: ' + e.message, true);
    }
  }

  async function retryBatchItem(id, item) {
    var button = item && item.querySelector('[data-batch-act="retry"]');
    if (button) { button.disabled = true; button.textContent = '加入中...'; }
    var taskId = await enqueueTagTask([id], { message: '已作为新任务加入后台', openDetail: true });
    if (!taskId && button) { button.disabled = false; button.textContent = '重试识图'; }
  }

  async function applyAllBatch() {
    var items = document.querySelectorAll('.batch-item[data-status="pending"], .batch-item[data-status="success"]');
    var pending = [];
    items.forEach(function (it) {
      if (it.querySelector('.batch-thumb') && it.querySelector('.batch-thumb').style.display !== 'none') pending.push(it);
      else if (it.querySelector('.batch-edit-desc')) pending.push(it);
    });
    if (pending.length === 0) { toast('没有待确认的项', true); return; }
    var taskId = currentBatchTaskId;
    customConfirm('确定应用全部 ' + pending.length + ' 项吗？', async function () {
      var ok = 0, fail = 0, appliedIds = [];
      for (var i = 0; i < pending.length; i++) {
        var item = pending[i];
        var id = item.getAttribute('data-id');
        var editArea = item.querySelector('.batch-edit-area');
        var tags = {
          description: editArea.querySelector('.batch-edit-desc').value.trim(),
          semantic_description: (editArea.querySelector('.batch-edit-semantic') || {}).value || '',
          emotion: editArea.querySelector('.batch-edit-emotion').value.split(',').map(function (s) { return s.trim(); }).filter(Boolean),
          scene: editArea.querySelector('.batch-edit-scene').value.split(',').map(function (s) { return s.trim(); }).filter(Boolean),
          keywords: editArea.querySelector('.batch-edit-keywords').value.split(',').map(function (s) { return s.trim(); }).filter(Boolean),
        };
        var success = await applyBatchItemSilent(id, tags);
        if (success) { ok++; appliedIds.push(id); } else fail++;
      }
      var marked = appliedIds.length === 0 || await markBatchItemsApplied(taskId, appliedIds);
      pending.forEach(function (item) {
        var id = item.getAttribute('data-id');
        if (appliedIds.indexOf(id) < 0) return;
        setBatchItemStatus(item, 'applied', '已应用');
        selectedIds.delete(id);
        var card = document.querySelector('.sticker-card[data-id="' + id + '"]');
        if (card) card.classList.remove('selected');
      });
      updateBatchCount();
      if (!marked) toast('标签已应用，但任务确认状态保存失败', true);
      else toast(ok + ' 张已应用' + (fail ? '（' + fail + ' 张失败）' : ''), fail > 0);
    });
  }

  async function applyBatchItemSilent(id, tags) {
    try {
      var resp = await fetch(withAuth(API + '/api'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'update', id: id,
          description: tags.description,
          semantic_description: tags.semantic_description || '',
          emotion: tags.emotion.join(', '),
          scene: tags.scene.join(', '),
          keywords: tags.keywords.join(', '),
        }),
      });
      var data = await resp.json();
      if (data.ok && data.tagged_at) {
        var sticker = allStickers.find(function (s) { return s.id === id; });
        if (sticker) sticker.tagged_at = data.tagged_at;
      }
      return data.ok;
    } catch { return false; }
  }

  async function cancelBatchTask(taskId) {
    try {
      var resp = await fetch(withAuth(API + '/api/batch-task/' + encodeURIComponent(taskId) + '/cancel'), { method: 'POST' });
      var data = await resp.json();
      if (data.ok) { toast('任务已取消'); pollBatchTask(taskId); checkBatchTasks(); }
      else { toast('取消失败: ' + (data.error || ''), true); }
    } catch (e) { toast('取消出错: ' + e.message, true); }
  }

  async function retryAllFailedBatch() {
    var failedItems = document.querySelectorAll('.batch-item[data-status="failed"]');
    if (failedItems.length === 0) { toast('没有失败的项需要重试', true); return; }
    var ids = [];
    failedItems.forEach(function (it) { ids.push(it.getAttribute('data-id')); });
    await enqueueTagTask(ids, { message: '已创建全部重试任务，共 ' + ids.length + ' 张', openDetail: true });
  }

  function renderBatchSummary(processed, total, success, hasFail) {
    var pct = total > 0 ? Math.round(processed / total * 100) : 0;
    var html = '<div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">';
    html += '<div style="flex:1;min-width:180px">';
    html += '<div style="font-size:13px;color:var(--primary-dark)">已处理 <b style="color:var(--primary)">' + processed + '</b> / ' + total + '（成功 ' + success + (hasFail ? '，失败 ' + (processed - success) : '') + '）</div>';
    html += '<div style="height:6px;background:var(--border);border-radius:3px;margin-top:5px;overflow:hidden"><div style="height:100%;width:' + pct + '%;background:var(--primary);transition:width .3s"></div></div>';
    html += '</div></div>';
    return html;
  }

  // ═══════════════════════════════════
  //  后台任务角标
  // ═══════════════════════════════════
  async function checkBatchTasks() {
    try {
      var resp = await fetch(withAuth(API + '/api/batch-tasks'));
      var data = await resp.json();
      if (!data.ok || !data.data || data.data.length === 0) {
        renderBatchTasksBadge([]);
        return;
      }
      batchTasksData = data.data;
      renderBatchTasksBadge(data.data);

      for (var i = 0; i < data.data.length; i++) {
        var t = data.data[i];
        if (t.status !== 'running' && t.status !== 'cancelled' && !batchTaskNotified[t.id]) {
          batchTaskNotified[t.id] = true;
          if (t.status === 'completed') {
            if (t.failed > 0) toast('批量识图完成：' + t.completed + ' 张成功，' + t.failed + ' 张失败', false);
            else if (t.completed > 0) toast('批量识图完成：' + t.completed + ' 张都成功', false);
          } else if (t.status === 'failed') {
            toast('批量识图失败，请查看详情', true);
          }
        }
      }
    } catch (e) {
      console.warn('[batch] checkBatchTasks error:', e.message);
    }
  }

  function renderBatchTasksBadge(tasks) {
    var badge = $('batch-tasks-badge');
    if (!badge) return;
    // v0.15.2 - 按钮始终显示，即使没有任务
    badge.hidden = false;
    if (tasks.length === 0) {
      badge.innerHTML = '批量识图任务 (0)';
      badge.style.borderColor = 'var(--border)';
      badge.style.color = 'var(--text-muted)';
      return;
    }
    var running = 0, done = 0, failed = 0;
    for (var i = 0; i < tasks.length; i++) {
      if (tasks[i].status === 'running') running++;
      else if (tasks[i].status === 'completed') done++;
      else if (tasks[i].status === 'failed') failed++;
    }
    if (running > 0) {
      badge.innerHTML = '批量识图任务 (' + tasks.length + ') · 进行中 ' + running;
      badge.style.borderColor = 'var(--primary)';
      badge.style.color = 'var(--primary-dark)';
    } else if (failed > 0) {
      badge.innerHTML = '批量识图任务 (' + tasks.length + ') · ' + failed + ' 失败';
      badge.style.borderColor = 'var(--danger)';
      badge.style.color = 'var(--danger)';
    } else {
      badge.innerHTML = '批量识图任务 (' + tasks.length + ') · 完成';
      badge.style.borderColor = 'var(--success)';
      badge.style.color = 'var(--success)';
    }
  }

  // v0.15.1 - 任务列表弹窗轮询定时器
  var batchListPollTimer = null;

  function openBatchTasksModal() {
    var modal = $('batch-tasks-list-modal');
    if (modal) {
      modal.hidden = false;
      modal.style.cssText = 'display:flex;position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(45,58,53,.45);align-items:center;justify-content:center;z-index:99999;pointer-events:auto';
      renderBatchTasksModalContent();
    } else {
      modal = document.createElement('div');
      modal.id = 'batch-tasks-list-modal';
      modal.className = 'modal-overlay';
      modal.onclick = function (e) { if (e.target === modal) closeBatchTasksModal(); };
      modal.style.cssText = 'display:flex;position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(45,58,53,.45);align-items:center;justify-content:center;z-index:99999;pointer-events:auto';
      var box = document.createElement('div');
      box.className = 'modal-box fixed-modal-box batch-tasks-modal-box';
      box.style.cssText = 'background:var(--surface);border-radius:var(--radius);padding:0;width:560px;max-width:92vw;max-height:80vh;overflow:hidden;border:1px solid var(--border);position:relative;box-shadow:0 8px 32px rgba(0,0,0,.12)';
      modal.appendChild(box);
      document.body.appendChild(modal);
      renderBatchTasksModalContent();
    }
    // v0.15.1 - 开启轮询，每 2s 刷新任务列表
    if (batchListPollTimer) clearInterval(batchListPollTimer);
    batchListPollTimer = setInterval(async function () {
      await checkBatchTasks();
      // 如果弹窗还开着，重新渲染内容
      var m = $('batch-tasks-list-modal');
      if (m && m.style.display !== 'none' && !m.hidden) {
        renderBatchTasksModalContent();
      }
    }, 2000);
  }

  function closeBatchTasksModal() {
    var modal = $('batch-tasks-list-modal');
    if (!modal) return;
    modal.hidden = true;
    modal.style.display = 'none';
    if (batchListPollTimer) { clearInterval(batchListPollTimer); batchListPollTimer = null; }
  }

  function renderBatchTasksModalContent() {
    var modal = $('batch-tasks-list-modal');
    if (!modal) return;
    var box = modal.querySelector('.modal-box');
    if (!box) return;

    var html = '<div class="modal-head"><h2>批量识图任务</h2>';
    html += '<button class="modal-close" data-modal-list-close="1" title="关闭">✕</button></div>';
    html += '<div class="modal-body">';

    if (batchTasksData.length === 0) {
      html += '<div style="text-align:center;color:var(--text-muted);padding:40px 20px">暂无后台任务</div>';
    } else {
      html += '<div style="display:flex;flex-direction:column;gap:8px">';
      for (var i = 0; i < batchTasksData.length; i++) {
        var t = batchTasksData[i];
        var processed = t.completed + t.failed;
        var pct = t.total > 0 ? Math.round(processed / t.total * 100) : 0;
        var label = t.status === 'running' ? '进行中' : (t.status === 'completed' ? '已完成' : (t.status === 'cancelled' ? '已取消' : '失败'));
        var color = t.status === 'running' ? 'var(--primary)' : (t.status === 'completed' ? 'var(--success)' : (t.status === 'failed' ? 'var(--danger)' : 'var(--text-muted)'));

        html += '<div data-task-row="' + escHtml(t.id) + '" style="background:var(--surface-alt);border:1px solid var(--border-light);border-radius:6px;padding:12px 14px;display:flex;flex-direction:column;gap:6px">';
        html += '<div style="display:flex;align-items:center;gap:10px">';
        html += '<div style="flex:1;min-width:0">';
        html += '<div style="font-size:13px;font-weight:500;color:' + color + '">' + label + ' · ' + processed + ' / ' + t.total + '</div>';
        html += '<div style="font-size:11px;color:var(--text-muted);margin-top:2px">成功 ' + t.completed + (t.failed > 0 ? '，失败 ' + t.failed : '') + '</div>';
        if (t.status === 'running') {
          html += '<div style="height:4px;background:var(--border);border-radius:2px;margin-top:5px;overflow:hidden"><div style="height:100%;width:' + pct + '%;background:var(--primary);transition:width .3s"></div></div>';
        }
        html += '</div></div>';
        html += '<div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;justify-content:flex-end">';
        html += '<button class="pref-btn" data-list-act="open-detail" data-task-id="' + escHtml(t.id) + '" style="padding:3px 10px;font-size:12px">查看详情</button>';
        if ((t.status === 'completed' || t.status === 'failed') && t.failed > 0) {
          html += '<button class="pref-btn" data-list-act="retry-failed" data-task-id="' + escHtml(t.id) + '" style="padding:3px 10px;font-size:12px;border-color:var(--danger);color:var(--danger)">全部重试</button>';
        }
        html += '<button class="pref-btn" data-list-act="delete" data-task-id="' + escHtml(t.id) + '" data-status="' + escHtml(t.status) + '" style="padding:3px 10px;font-size:12px;color:var(--danger);border-color:#e6b8b0">删除记录</button>';
        html += '</div></div>';
      }
      html += '</div>';
    }
    html += '</div>';
    box.innerHTML = html;

    box.onclick = function (e) {
      var btn = e.target.closest('button');
      if (!btn) return;
      if (btn.getAttribute('data-modal-list-close') === '1') { closeBatchTasksModal(); return; }
      var act = btn.getAttribute('data-list-act');
      var tid = btn.getAttribute('data-task-id');
      var status = btn.getAttribute('data-status') || '';
      if (act === 'open-detail' && tid) { openBatchTaskDetail(tid); closeBatchTasksModal(); }
      else if (act === 'retry-failed' && tid) { retryFailedFromTask(tid); }
      else if (act === 'delete' && tid) {
        var promptMsg = status === 'running'
          ? '删除这条正在跑的任务记录？任务本身会继续在后台跑完，但这条记录下次进来不会再显示。'
          : '删除这条任务记录？';
        customConfirm(promptMsg, async function () {
          await deleteBatchTask(tid);
          renderBatchTasksModalContent();
        });
      }
    };
  }

  async function deleteBatchTask(taskId) {
    try {
      var resp = await fetch(withAuth(API + '/api/batch-task/' + encodeURIComponent(taskId)), { method: 'DELETE' });
      var data = await resp.json();
      if (data.ok) { batchTaskNotified[taskId] = true; checkBatchTasks(); toast('已删除任务记录'); }
      else { toast('删除失败: ' + (data.error || ''), true); }
    } catch (e) { toast('删除出错: ' + e.message, true); }
  }

  async function retryFailedFromTask(taskId) {
    try {
      var resp = await fetch(withAuth(API + '/api/batch-task/' + encodeURIComponent(taskId)));
      var data = await resp.json();
      if (!data.ok || !data.data) { toast('任务已不存在', true); return; }
      var failedIds = (data.data.failed || []).map(function (f) { return f.id; });
      if (failedIds.length === 0) { toast('没有失败的项', true); return; }
      var newTaskId = await enqueueTagTask(failedIds, { message: '已创建全部重试任务，共 ' + failedIds.length + ' 张' });
      if (newTaskId) {
        closeBatchTasksModal();
        openBatchTaskDetail(newTaskId);
      }
    } catch (e) { toast('重试失败: ' + e.message, true); }
  }

  function openBatchTaskDetail(taskId) {
    var modal = $('batch-modal');
    var summary = $('batch-summary');
    var list = $('batch-list');
    modal.removeAttribute('hidden');
    modal.hidden = false;
    modal.style.cssText = 'display:flex;position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(45,58,53,.45);align-items:center;justify-content:center;z-index:99999;pointer-events:auto';
    addModalCloseButton();
    summary.innerHTML = '<div class="batch-progress"><span class="spinner"></span>加载任务详情...</div>';
    list.innerHTML = '';
    currentBatchTaskId = taskId;
    if (batchPollTimer) clearInterval(batchPollTimer);
    batchPollTimer = setInterval(function () { pollBatchTask(taskId); }, 1500);
    pollBatchTask(taskId);
  }

  // ═══════════════════════════════════
  //  初始化
  // ═══════════════════════════════════
  document.addEventListener('DOMContentLoaded', function () {
    loadStickers();
    loadSemanticIndexStatus();
    checkBatchTasks();
    updateModelGuide();

    // 导航：首页卡片点击
    document.querySelectorAll('.entry-card[data-goto]').forEach(function (card) {
      card.addEventListener('click', function () {
        var target = card.getAttribute('data-goto');
        showView(target);
        if (target === 'preferences') initPreferencesView();
        if (target === 'agent-freq') renderAgentFreq();
        if (target === 'dialect') renderDialect();
      });
    });

    // 导航：添加入库卡片 -> 打开上传弹窗
    var uploadCard = document.querySelector('.entry-card[data-action="upload"]');
    if (uploadCard) {
      uploadCard.addEventListener('click', function () { openModal('upload-modal'); });
    }

    // 导航：返回按钮
    document.querySelectorAll('.back-btn[data-goto]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        showView(btn.getAttribute('data-goto'));
      });
    });

    // 设置按钮
    $('btn-settings').addEventListener('click', openSettings);
    $('guide-settings-btn').addEventListener('click', openSettings);
    // v0.19.5 - 检查更新按钮
    $('btn-check-update').addEventListener('click', checkUpdate);

    // 弹窗关闭按钮（通用 data-close 属性）
    document.querySelectorAll('[data-close]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var target = btn.getAttribute('data-close');
        if (target === 'chat-modal') { closeChatModal(); return; }
        closeModal(target);
      });
    });

    // 弹窗点击外部关闭
    document.querySelectorAll('.modal-overlay').forEach(function (overlay) {
      overlay.addEventListener('click', function (e) {
        if (e.target === overlay && overlay.id !== 'batch-modal' && overlay.id !== 'editor-modal') {
          if (overlay.id === 'chat-modal') { closeChatModal(); return; }
          overlay.hidden = true;
          overlay.style.display = '';
        }
      });
    });

    // v0.18.0 - 聊天弹窗事件
    bindChatModalActions();

    // 设置弹窗
    $('settings-save').addEventListener('click', saveAllSettings);
    $('text-test-btn').addEventListener('click', testTextConfig);
    $('vision-test-btn').addEventListener('click', testVisionConfig);
    $('vision-source').addEventListener('change', toggleVisionBlocks);
    $('vision-provider').addEventListener('change', function () { updateVisionModelDropdown(this.value, ''); });
    $('text-source').addEventListener('change', toggleTextBlocks);
    $('text-provider').addEventListener('change', function () { updateTextModelDropdown(this.value, ''); });

    // v0.16.0 - Embedding 配置；索引入口位于图库页
    $('embedding-source').addEventListener('change', toggleEmbeddingBlocks);
    $('embedding-test-btn').addEventListener('click', testEmbeddingConfig);

    var embeddingIndexBtn = $('embedding-index-btn');
    if (embeddingIndexBtn) embeddingIndexBtn.addEventListener('click', generateSemanticIndex);

    // 上传弹窗
    $('upload-btn').addEventListener('click', handleUpload);
    $('import-zip-btn').addEventListener('click', handleImportZip);
    $('upload-file').addEventListener('change', function () {
      var count = this.files ? this.files.length : 0;
      $('upload-file-hint').textContent = count
        ? '已选择 ' + count + ' 张图片。导入后可以到图库中批量识图。'
        : '支持 PNG、JPG、GIF、WebP 和 BMP。';
      clearUploadResult();
    });
    $('upload-zip').addEventListener('change', clearUploadResult);

    // 编辑弹窗
    $('editor-save').addEventListener('click', saveEdit);
    $('editor-autotag-btn').addEventListener('click', handleAutoTagEditor);

    // 批量识图弹窗关闭按钮
    var batchCloseBtn = $('batch-modal-close');
    if (batchCloseBtn) batchCloseBtn.addEventListener('click', closeBatchModal);

    // 多选模式
    $('btnToggleMulti').addEventListener('click', toggleBatchMode);
    $('batch-select-all').addEventListener('click', selectAllVisible);
    $('batch-select-untagged').addEventListener('click', selectAllUntagged);
    $('batch-clear').addEventListener('click', clearSelection);
    $('batch-auto-tag').addEventListener('click', batchAutoTag);
    $('batch-delete').addEventListener('click', batchDelete);

    // 批量任务角标
    var badge = $('batch-tasks-badge');
    if (badge) badge.addEventListener('click', openBatchTasksModal);

    // 批量 summary 事件委托
    var batchSummaryEl = $('batch-summary');
    if (batchSummaryEl) {
      batchSummaryEl.addEventListener('click', function (e) {
        var btn = e.target.closest('button');
        if (!btn) return;
        if (btn.id === 'batch-apply-all' && !btn.disabled) applyAllBatch();
        else if (btn.id === 'batch-retry-failed') retryAllFailedBatch();
        else if (btn.id === 'batch-cancel-task') {
          var tid = btn.getAttribute('data-task-id');
          customConfirm('确定取消这个批量识图任务吗？', function () { cancelBatchTask(tid); });
        }
      });
    }

    // 筛选
    $('filter-emotion').addEventListener('change', loadStickers);
    $('filter-search').addEventListener('input', applyFilter);

    // 点击图片放大
    $('sticker-grid').addEventListener('click', function (e) {
      if (document.body.classList.contains('batch-mode')) return;
      if (e.target.tagName === 'IMG' && e.target.closest('.sticker-card')) {
        var overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,.8);display:flex;align-items:center;justify-content:center;z-index:300;cursor:zoom-out';
        var img = document.createElement('img');
        img.src = e.target.src;
        img.style.cssText = 'max-width:90vw;max-height:90vh;object-fit:contain;border-radius:8px';
        overlay.appendChild(img);
        overlay.onclick = function () { overlay.remove(); };
        document.body.appendChild(overlay);
      }
    });

    // ESC 关闭弹窗
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        document.querySelectorAll('.modal-overlay:not([hidden])').forEach(function (m) {
          if (m.id !== 'editor-modal' && m.id !== 'batch-modal') {
            m.hidden = true;
            m.style.display = '';
          }
        });
        var batchListModal = $('batch-tasks-list-modal');
        if (batchListModal && batchListModal.style.display !== 'none') closeBatchTasksModal();
      }
    });
  });
})();
