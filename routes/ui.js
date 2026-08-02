// 表情包插件 - 管理页面渲染（仅 GET /page）
// v0.15.0 - UI 改版：三视图架构 + 薄荷绿/樱花粉配色
// v0.17.4-share: 公共函数从 lib/shared.js 导入
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DATA_DIR, VISION_CFG_FILE, TEXT_CFG_FILE, EMBEDDING_CFG_FILE,
  HANA_HOME, MODELS_JSON, MIME_MAP,
  readVisionConfig, getAvailableVisionModels, getAvailableTextModels,
  readTextConfig, readEmbeddingConfig, getAvailableEmbeddingModels,
  escapeHtml,
} from '../lib/shared.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ASSETS_DIR = path.join(__dirname, '..', 'assets');

function renderPage() {
  let js = '';
  try {
    js = fs.readFileSync(path.join(ASSETS_DIR, 'sticker-manager.js'), 'utf-8')
      .replace(/<\/script>/gi, '<\\/script>');
  } catch (e) {
    return '<!DOCTYPE html><html><body><h1>加载失败</h1><p>' + e.message + '</p></body></html>';
  }

  const visionConfig = readVisionConfig();
  const visionModels = getAvailableVisionModels();
  const textConfig = readTextConfig();
  const textModels = getAvailableTextModels();
  const embeddingConfig = readEmbeddingConfig();
  const embeddingModels = getAvailableEmbeddingModels();
  // 页面只接收密钥占位符；真实密钥始终留在服务端配置文件中。
  const safeVisionConfig = { ...visionConfig, customApiKey: visionConfig.customApiKey ? '********' : '' };
  const safeTextConfig = { ...textConfig, customApiKey: textConfig.customApiKey ? '********' : '' };
  const safeEmbeddingConfig = { ...embeddingConfig, customApiKey: embeddingConfig.customApiKey ? '********' : '' };

  let prefsData = { version: 1, users: {} };
  try { prefsData = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'preferences.json'), 'utf-8')); } catch {}
  let logData = { version: 1, entries: [] };
  try { logData = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'decision-log.json'), 'utf-8')); } catch {}

  return '<!DOCTYPE html>'
    + '<html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">'
    + '<title>表情包</title><style>'
    // ═══ 设计令牌：薄荷绿主色 + 樱花粉辅色 ═══
    + ':root{'
    + '--bg:#eef6f2;'
    + '--surface:#fafdfb;'
    + '--surface-alt:#f2f8f5;'
    + '--primary:#5dae8e;'
    + '--primary-dark:#4a9277;'
    + '--primary-light:#e6f3ed;'
    + '--accent:#e89bb0;'
    + '--accent-light:#fce8ee;'
    + '--text:#2d3a35;'
    + '--text-muted:#7a8a82;'
    + '--text-light:#a5b2ac;'
    + '--border:#d5e5dd;'
    + '--border-light:#e8f0ec;'
    + '--danger:#c45a4e;'
    + '--danger-light:#fbe9e5;'
    + '--success:#4a8a5e;'
    + '--shadow:0 2px 8px rgba(93,174,142,.08);'
    + '--shadow-hover:0 4px 16px rgba(93,174,142,.15);'
    + '--radius:10px;'
    + '--radius-sm:6px;'
    + '}'
    + '*{margin:0;padding:0;box-sizing:border-box}'
    + '[hidden]{display:none!important}'
    + 'body{font-family:-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;background:var(--bg);color:var(--text);padding:0}'
    // ═══ 视图容器 ═══
    + '.view{padding:24px;max-width:1100px;margin:0 auto}'
    + '.view.hidden{display:none}'
    // v0.18.x view-library 顶部控件统一包成 sticky wrapper
    + '#view-library .library-controls{display:flex;flex-direction:column;gap:10px;position:sticky;top:0;z-index:20;background:var(--bg);padding:14px 0 16px;box-shadow:0 1px 0 var(--border-light)}'
    + '#view-library .sub-header{position:static;background:transparent;margin:0;padding:0}'
    + '#view-library .batch-toolbar{position:static;margin-bottom:0}'
    // ═══ 首页 ═══
    + '.home-header{display:flex;align-items:center;gap:14px;margin-bottom:32px;padding-top:8px}'
    + '.home-header h1{font-size:24px;font-weight:600;color:var(--text);letter-spacing:.5px}'
    + '.home-header .count{font-size:13px;color:var(--text-muted);background:var(--primary-light);padding:3px 12px;border-radius:20px}'
    + '.home-header .spacer{flex:1}'
    + '.icon-btn{width:38px;height:38px;border:1px solid var(--border);border-radius:50%;background:var(--surface);cursor:pointer;color:var(--text-muted);font-size:16px;display:flex;align-items:center;justify-content:center;transition:all .2s}'
    + '.icon-btn:hover{border-color:var(--primary);color:var(--primary);background:var(--primary-light)}'
    // v0.17.5 - 首页主体垂直居中：absolute 定位让卡片中心对齐视口中点
    + '#view-home{position:relative;min-height:100vh;padding:0}'
    + '#view-home .home-header{padding:24px 24px 0;margin-bottom:0}'
    + '#view-home .home-main{position:absolute;top:50%;left:0;right:0;transform:translateY(-50%);width:100%;max-width:1100px;margin:0 auto;padding:0 24px;box-sizing:border-box;display:flex;flex-direction:column;gap:18px}'
    + '#view-home .card-grid{width:100%}'
    // v0.17.5 - 右上角「模型设置」胶囊按钮，参考「任务 (X)」的细线胶囊样式
    + '.home-text-btn{font-size:13px;padding:5px 14px;border:1px solid var(--border);border-radius:14px;background:var(--surface);cursor:pointer;color:var(--text-muted);font-family:inherit;display:inline-flex;align-items:center;white-space:nowrap;transition:all .15s}'
    + '.home-text-btn:hover{border-color:var(--primary);color:var(--primary);background:var(--primary-light)}'
    + '.model-guide{background:var(--surface);border:1px dashed var(--accent);border-radius:18px;padding:16px 18px;box-shadow:var(--shadow);display:flex;align-items:center;gap:16px;flex-wrap:wrap}'
    + '.model-guide-copy{flex:1;min-width:220px}'
    + '.model-guide-title{font-size:15px;font-weight:600;color:var(--text);margin-bottom:8px}'
    + '.model-guide-list{display:flex;gap:8px;flex-wrap:wrap}'
    + '.model-guide-item{font-size:12px;color:var(--text-muted);background:var(--surface-alt);border:1px solid var(--border-light);border-radius:14px;padding:4px 10px}'
    + '.model-guide-item.ready{color:var(--success);background:var(--primary-light);border-color:var(--border)}'
    + '.model-guide-item.pending{color:var(--danger);background:var(--danger-light);border-color:#efc9c2}'
    + '.model-guide-note{font-size:11px;color:var(--text-light);margin-top:8px;line-height:1.6}'
    + '.model-guide-btn{padding:7px 16px;border:1px solid var(--primary);border-radius:16px;background:var(--primary);color:#fff;font-size:13px;font-family:inherit;cursor:pointer;transition:all .15s;white-space:nowrap}'
    + '.model-guide-btn:hover{background:var(--primary-dark);border-color:var(--primary-dark);transform:translateY(-1px)}'
    + '.card-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:18px}'
    + '.entry-card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:28px 24px;cursor:pointer;transition:all .2s;position:relative;overflow:hidden}'
    + '.entry-card:hover{border-color:var(--primary);box-shadow:var(--shadow-hover);transform:translateY(-2px)}'
    + '.entry-card .card-icon{width:48px;height:48px;border-radius:12px;display:flex;align-items:center;justify-content:center;font-size:22px;margin-bottom:16px}'
    + '.entry-card[data-color=mint] .card-icon{background:var(--primary-light);color:var(--primary)}'
    + '.entry-card[data-color=pink] .card-icon{background:var(--accent-light);color:var(--accent)}'
    + '.entry-card[data-color=sage] .card-icon{background:#eef0e8;color:#7a9a6a}'
    + '.entry-card[data-color=lavender] .card-icon{background:#f0eef5;color:#8a7aaa}'
    + '.entry-card .card-title{font-size:16px;font-weight:600;color:var(--text);margin-bottom:4px}'
    + '.entry-card .card-meta{font-size:12px;color:var(--text-muted)}'
    + '.entry-card .card-badge{position:absolute;top:16px;right:16px;font-size:11px;background:var(--accent-light);color:var(--accent);padding:2px 10px;border-radius:12px;font-weight:500}'
    + '.entry-card .card-arrow{position:absolute;bottom:20px;right:20px;color:var(--text-light);font-size:18px;transition:transform .2s}'
    + '.entry-card:hover .card-arrow{transform:translateX(4px);color:var(--primary)}'
    + '.home-preference-tip{width:100%;display:flex;align-items:center;gap:14px;padding:14px 18px;text-align:left;font-family:inherit;background:var(--surface);border:1px dashed var(--accent);border-radius:18px;color:var(--text);box-shadow:var(--shadow);flex-wrap:wrap}'
    + '.home-preference-tip:hover{border-color:var(--accent);background:var(--accent-light)}'
    + '.home-preference-tip:focus-visible{outline:2px solid var(--accent);outline-offset:3px}'
    + '.preference-tip-icon{width:38px;height:38px;display:flex;align-items:center;justify-content:center;border-radius:12px;background:var(--accent-light);font-size:18px;flex-shrink:0}'
    + '.home-preference-tip:hover .preference-tip-icon{background:var(--surface)}'
    + '.preference-tip-copy{display:flex;flex-direction:column;gap:3px;flex:1;min-width:220px}'
    + '.preference-tip-copy strong{font-size:14px;font-weight:600;color:var(--text)}'
    + '.preference-tip-copy span{font-size:12px;line-height:1.6;color:var(--text-muted)}'
    + '.preference-tip-action{padding:6px 12px;border-radius:14px;background:var(--primary-light);color:var(--primary-dark);font-size:12px;font-weight:600;white-space:nowrap;transition:all .15s}'
    + '.home-preference-tip:hover .preference-tip-action{background:var(--primary);color:#fff}'
    // ═══ 子页面 header ═══
    + '.sub-header{display:flex;align-items:center;gap:12px;margin-bottom:20px;flex-wrap:wrap;position:sticky;top:0;z-index:20;background:var(--bg);padding:12px 0}'
    + '.back-btn{display:flex;align-items:center;gap:4px;padding:6px 14px;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--surface);cursor:pointer;color:var(--text-muted);font-size:13px;font-family:inherit;transition:all .15s;white-space:nowrap}'
    + '.back-btn:hover{border-color:var(--primary);color:var(--primary);background:var(--primary-light)}'
    + '.sub-header h2{font-size:18px;font-weight:600;color:var(--text)}'
    + '.sub-header .count{font-size:13px;color:var(--text-muted)}'
    + '.sub-header .spacer{flex:1}'
    + '.sub-header .icon-btn{width:34px;height:34px;font-size:14px}'
    // ═══ 筛选栏 ═══
    + '.filter-bar{display:flex;gap:8px;align-items:center;margin-bottom:16px;flex-wrap:wrap}'
    + '.filter-bar select{padding:7px 12px;border:1px solid var(--border);border-radius:var(--radius-sm);font-size:13px;background:var(--surface);color:var(--text);font-family:inherit;cursor:pointer}'
    + '.filter-bar select:focus{outline:none;border-color:var(--primary)}'
    + '.filter-bar input{padding:7px 12px;border:1px solid var(--border);border-radius:var(--radius-sm);font-size:13px;background:var(--surface);color:var(--text);font-family:inherit;flex:1;min-width:140px}'
    + '.filter-bar input:focus{outline:none;border-color:var(--primary)}'
    // ═══ 批量工具栏 ═══
    + '.batch-toolbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;background:var(--primary-light);border:1px solid var(--primary);border-radius:var(--radius-sm);padding:8px 14px;margin-bottom:14px;font-size:13px;position:sticky;bottom:0;z-index:15;box-shadow:0 -2px 12px rgba(45,58,53,.08);backdrop-filter:blur(8px)}'
    + '.batch-toolbar .batch-info{color:var(--primary-dark);font-weight:500}'
    + '.batch-toolbar .batch-info b{font-size:15px;margin:0 3px}'
    + '.batch-btn{padding:5px 12px;font-size:12px;border:1px solid var(--border);border-radius:4px;background:var(--surface);cursor:pointer;color:var(--text-muted);font-family:inherit;transition:all .15s}'
    + '.batch-btn:hover{background:var(--surface-alt);border-color:var(--primary)}'
    + '.batch-btn-primary{background:var(--primary);color:#fff;border-color:var(--primary)}'
    + '.batch-btn-primary:hover{background:var(--primary-dark);color:#fff}'
    // ═══ 表情包网格 ═══
    + '#sticker-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:14px}'
    + '.empty-state{grid-column:1/-1;text-align:center;padding:50px 20px;color:var(--text-muted);font-size:14px}'
    + '.sticker-card{background:var(--surface);border-radius:var(--radius);border:1px solid var(--border);overflow:hidden;transition:box-shadow .15s,transform .15s;position:relative}'
    + '.sticker-card:hover{box-shadow:var(--shadow-hover);transform:translateY(-1px)}'
    + '.sticker-card img{width:100%;aspect-ratio:1;object-fit:cover;display:block;cursor:pointer;background:var(--surface-alt)}'
    + '.card-info{padding:10px 12px 12px}'
    + '.card-desc{font-size:12px;font-weight:500;margin-bottom:6px;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}'
    + '.card-tags{display:flex;flex-wrap:wrap;gap:3px;margin-bottom:6px}'
    + '.tag{display:inline-block;padding:1px 7px;font-size:10px;border-radius:3px;background:var(--primary-light);color:var(--primary-dark)}'
    + '.tag.scene{background:#f0eee6;color:#8a8a6a}'
    + '.card-tagged-at{font-size:10px;color:var(--text-light);margin-top:4px;font-family:monospace}'
    + '.card-actions{display:flex;gap:4px;margin-top:6px}'
    + '.card-actions button{font-size:11px;padding:3px 8px;border:1px solid var(--border);border-radius:3px;background:transparent;cursor:pointer;color:var(--text-muted);font-family:inherit;transition:all .15s}'
    + '.card-actions .edit-btn:hover{background:var(--primary-light);color:var(--primary);border-color:var(--primary)}'
    + '.card-actions .retag-btn:hover{background:#f5f0e8;color:#9d7b53;border-color:#c9b88a}'
    + '.card-actions .delete-btn{color:var(--danger)}'
    + '.card-actions .delete-btn:hover{background:var(--danger-light);border-color:var(--danger)}'
    // 多选模式
    + '.sticker-check{position:absolute;top:6px;left:6px;width:26px;height:26px;border-radius:50%;background:rgba(250,253,251,.92);border:2px solid var(--border);display:none;align-items:center;justify-content:center;font-size:15px;color:transparent;cursor:pointer;z-index:5;transition:all .15s}'
    + 'body.batch-mode .sticker-check{display:flex}'
    + 'body.batch-mode .sticker-card{cursor:pointer}'
    + '.sticker-card.selected{border:2px solid var(--primary);background:var(--primary-light)}'
    + '.sticker-card.selected .sticker-check{background:var(--primary);color:#fff;border-color:var(--primary)}'
    // ═══ 偏好页面 ═══
    + '.pref-section{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:20px;margin-bottom:16px}'
    + '.pref-section h3{font-size:14px;font-weight:600;color:var(--primary-dark);margin-bottom:12px;display:flex;align-items:center;gap:6px}'
    + '.pref-section .section-desc{font-size:12px;color:var(--text-muted);margin-bottom:14px;line-height:1.6}'
    + '.pref-stats{display:flex;gap:16px;margin-bottom:14px}'
    + '.pref-stats .stat-box{min-width:60px}'
    + '.pref-stats .stat-label{font-size:10px;color:var(--text-muted)}'
    + '.pref-stats .stat-val{font-size:20px;font-weight:600;color:var(--primary)}'
    + '.pref-btn{padding:1px 6px;font-size:11px;border:1px solid var(--border);border-radius:3px;background:var(--surface);cursor:pointer;color:var(--text-muted);font-family:inherit;line-height:1.4;transition:all .15s}'
    + '.pref-btn:hover{background:var(--surface-alt);border-color:var(--primary)}'
    + '.pref-btn-mini{padding:0 5px;font-size:13px;line-height:1.5}'
    + '.pref-btn-danger{color:var(--danger);border-color:#e6b8b0;background:var(--danger-light)}'
    + '.pref-btn-danger:hover{background:#f5d5cd}'
    + '.pref-chip{display:inline-flex;align-items:center;gap:3px;padding:1px 4px 1px 2px;font-size:10px;border-radius:3px;background:rgba(74,138,94,.12);color:var(--success);border:1px solid rgba(74,138,94,.3);font-family:monospace}'
    + '.pref-chip-veto{background:var(--danger-light);color:var(--danger);border-color:rgba(196,90,78,.3)}'
    + '.pref-thumb{width:18px;height:18px;border-radius:2px;object-fit:cover;border:1px solid rgba(74,138,94,.4);flex-shrink:0}'
    + '.pref-chip-veto .pref-thumb{border-color:rgba(196,90,78,.4)}'
    + '.pref-chip-id{font-size:10px;color:inherit}'
    + '.pref-x{border:none;background:transparent;color:inherit;font-size:14px;cursor:pointer;padding:0 2px;line-height:1;opacity:.5;font-family:inherit}'
    + '.pref-x:hover{opacity:1;color:var(--danger)}'
    + '.pref-mapping{padding:8px 10px;background:var(--surface-alt);border:1px solid var(--border-light);border-radius:4px;font-size:11px}'
    + '.log-thumb-wrap{position:relative;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;flex-shrink:0;vertical-align:middle}'
    + '.log-thumb{width:28px;height:28px;border-radius:3px;object-fit:cover;border:1px solid var(--border);flex-shrink:0;cursor:zoom-in;transition:transform .15s;display:block}'
    + '.log-thumb-wrap:hover .log-thumb{transform:scale(2.6);z-index:50;border-color:var(--primary);box-shadow:0 3px 10px rgba(0,0,0,.18)}'
    + '.log-thumb-wrap.log-deleted{background:var(--danger-light);border:1px dashed var(--danger);border-radius:3px}'
    + '.log-thumb-deleted{display:flex;align-items:center;justify-content:center;width:100%;height:100%;color:var(--danger);font-size:15px;font-weight:700}'
    + '.log-thumb-id{font-size:10px;font-family:monospace;color:var(--text-muted);max-width:72px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex-shrink:1}'
    + '.log-thumb-id-missing{color:var(--danger);max-width:90px}'
    // 助手排除
    + '.agent-item{display:flex;align-items:center;gap:8px;padding:8px 10px;border-radius:var(--radius-sm);background:var(--surface-alt);border:1px solid var(--border-light);font-size:13px;transition:all .15s}'
    + '.agent-item:hover{background:var(--primary-light);border-color:var(--border)}'
    + '.agent-item input[type=checkbox]{width:16px;height:16px;cursor:pointer;accent-color:var(--primary)}'
    + '.agent-item .agent-icon{font-size:16px;width:20px;text-align:center}'
    + '.agent-item .agent-name{flex:1}'
    + '.agent-item .agent-id{font-size:11px;color:var(--text-muted)}'
    // 助手配图频率
    + '.agent-freq-item{padding:14px;border:1px dashed var(--border);border-radius:var(--radius);background:var(--surface-alt)}'
    + '.agent-freq-head{display:flex;align-items:center;gap:8px;margin-bottom:10px}'
    + '.agent-freq-name{font-size:13px;font-weight:600;color:var(--text);flex:1}'
    + '.agent-freq-id{font-size:10px;color:var(--text-light);font-family:monospace}'
    + '.freq-enabled-btn{padding:4px 10px;border:1px solid var(--primary);border-radius:14px;background:var(--primary-light);color:var(--primary-dark);font-size:11px;cursor:pointer;font-family:inherit}'
    + '.freq-enabled-btn.is-off{border-color:var(--border);background:var(--surface);color:var(--text-muted)}'
    + '.freq-options{display:flex;gap:6px;flex-wrap:wrap}'
    + '.freq-btn{flex:1;min-width:70px;font-size:11px;padding:6px 9px;border:1px solid var(--border);background:var(--surface);color:var(--text-muted);border-radius:4px;cursor:pointer;font-family:inherit}'
    + '.freq-btn:hover{border-color:var(--primary);color:var(--primary)}'
    + '.freq-btn.freq-btn-active{border-color:var(--primary);background:var(--primary-light);color:var(--primary-dark);font-weight:600}'
    + '.agent-freq-item.is-off .freq-options{opacity:.42;pointer-events:none}'
    + '.freq-save-bar{position:sticky;bottom:10px;z-index:12;display:flex;align-items:center;gap:12px;padding:10px 12px;border:1px solid var(--border);border-radius:var(--radius);background:rgba(250,253,251,.96);box-shadow:0 -2px 12px rgba(45,58,53,.08)}'
    + '.freq-save-status{flex:1;font-size:12px;color:var(--text-muted)}'
    + '.freq-save-status.is-dirty{color:var(--accent);font-weight:600}'
    + '.freq-save-bar .btn{width:auto}'
    // 按场景关闭
    
    // ═══ 弹窗 ═══
    + '.modal-overlay{position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(45,58,53,.35);display:flex;align-items:center;justify-content:center;z-index:100}'
    + '.modal-overlay > .modal-box{pointer-events:auto}'
    + '.modal-box{background:var(--surface);border-radius:var(--radius);padding:24px;width:440px;max-width:92vw;border:1px solid var(--border);max-height:88vh;overflow-y:auto;box-shadow:0 8px 32px rgba(0,0,0,.12)}'
    + '.modal-box h2{font-size:16px;margin-bottom:16px;color:var(--text);font-weight:600}'
    + '.modal-actions{display:flex;gap:8px;justify-content:flex-end;margin-top:16px;flex-wrap:wrap}'
    + '.modal-actions .btn{width:auto}'
    + '.modal-close{position:absolute;top:14px;right:16px;width:30px;height:30px;border:1px solid var(--border);border-radius:50%;background:var(--surface);cursor:pointer;font-size:16px;line-height:1;color:var(--text-muted);font-family:inherit;display:flex;align-items:center;justify-content:center;padding:0;transition:all .15s}'
    + '.modal-close:hover{border-color:var(--danger);color:var(--danger);background:var(--danger-light)}'
    // 表单
    + '.form-group{margin-bottom:12px}'
    + '.form-group label{display:block;font-size:12px;color:var(--text-muted);margin-bottom:4px}'
    + '.form-group input[type=text],.form-group input[type=password]{width:100%;padding:8px 12px;border:1px solid var(--border);border-radius:var(--radius-sm);font-size:13px;background:var(--surface-alt);color:var(--text);font-family:inherit}'
    + '.form-group input:focus{outline:none;border-color:var(--primary);background:var(--surface)}'
    + '.form-group input[type=file]{width:100%;padding:6px 0;font-size:13px;color:var(--text-muted)}'
    + '.form-hint{font-size:11px;line-height:1.6;color:var(--text-muted);margin-top:4px}'
    + '.import-result{margin-top:14px;padding:10px 12px;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--surface-alt);font-size:12px;line-height:1.65;color:var(--text);white-space:pre-wrap;max-height:180px;overflow:auto}'
    + '.modal-box.fixed-modal-box{max-height:84vh;display:flex;flex-direction:column;overflow:hidden;padding:0}'
    + '.modal-head{position:relative;flex-shrink:0;padding:22px 24px 14px;border-bottom:1px solid var(--border-light)}'
    + '.modal-head h2{margin:0;padding-right:40px}'
    + '.modal-body{min-height:0;overflow-y:auto;padding:20px 24px}'
    + '.modal-foot{flex-shrink:0;padding:14px 24px 18px;border-top:1px solid var(--border-light);background:var(--surface)}'
    + '.modal-foot .modal-actions{margin-top:0}'
    + '.import-section{padding:16px;border:1px dashed var(--border);border-radius:var(--radius);background:var(--surface-alt);margin-bottom:14px}'
    + '.import-section:last-of-type{margin-bottom:0}'
    + '.import-section-title{font-size:14px;font-weight:600;color:var(--text);margin-bottom:4px}'
    + '.import-section-desc{font-size:11px;line-height:1.6;color:var(--text-muted);margin-bottom:10px}'
    + 'button:disabled{opacity:.45;cursor:not-allowed}'
    + '.select-group{display:flex;gap:6px;align-items:center;margin-bottom:8px}'
    + '.select-group select{flex:1;padding:7px 10px;border:1px solid var(--border);border-radius:var(--radius-sm);font-size:12px;background:var(--surface-alt);color:var(--text);font-family:inherit}'
    + '.ai-btn{width:100%;padding:9px;border:1px dashed var(--primary);background:var(--primary-light);color:var(--primary-dark);border-radius:var(--radius-sm);font-size:13px;cursor:pointer;margin-bottom:12px;transition:all .15s;font-family:inherit}'
    + '.ai-btn:hover{background:rgba(93,174,142,.15)}'
    + '.ai-btn:disabled{opacity:.5;cursor:wait}'
    + '.btn{padding:8px 16px;border:none;border-radius:var(--radius-sm);font-size:14px;cursor:pointer;font-family:inherit}'
    + '.btn-primary{background:var(--primary);color:#fff;width:100%}'
    + '.btn-primary:hover{background:var(--primary-dark)}'
    + '.btn-primary:disabled{opacity:.5;cursor:wait}'
    + '.btn-secondary{background:var(--surface);border:1px solid var(--border);color:var(--text-muted)}'
    + '.btn-secondary:hover{border-color:var(--primary);color:var(--primary)}'
    // 加载遮罩
    + '.loading-overlay{position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(238,246,242,.88);display:flex;flex-direction:column;align-items:center;justify-content:center;z-index:200;gap:12px}'
    + '.spinner{width:36px;height:36px;border:3px solid var(--border);border-top-color:var(--primary);border-radius:50%;animation:spin .8s linear infinite}'
    + '@keyframes spin{to{transform:rotate(360deg)}}'
    // 设置弹窗内部分组
    + '.settings-section{margin-bottom:20px;padding-bottom:16px;border-bottom:1px solid var(--border-light)}'
    + '.settings-section:last-child{border-bottom:none;margin-bottom:0;padding-bottom:0}'
    + '.settings-section h3{font-size:13px;font-weight:600;color:var(--primary-dark);margin-bottom:8px}'
    + '.settings-section .settings-desc{font-size:11px;color:var(--text-muted);margin-bottom:10px;line-height:1.5}'
    // 批量识图弹窗
    // v0.18.x 让 .batch-list 自己滚动，弹窗整体不滚，关闭按钮钉在弹窗右上角不消失
    + '.modal-box.batch-modal{max-width:720px;max-height:84vh;display:flex;flex-direction:column;overflow:hidden;padding:0}'
    + '.modal-box.batch-modal .modal-body{display:flex;flex:1;flex-direction:column;overflow:hidden}'
    + '.modal-box.batch-modal .batch-summary{flex-shrink:0}'
    + '.modal-box.batch-modal .batch-list{flex:1;min-height:0;overflow-y:auto;margin-bottom:0}'
    + '.batch-summary{padding:10px 14px;background:var(--primary-light);border:1px solid rgba(93,174,142,.2);border-radius:var(--radius-sm);margin-bottom:14px;font-size:13px;color:var(--primary-dark);position:sticky;top:0;z-index:5;backdrop-filter:blur(6px)}'
    + '.batch-list{display:flex;flex-direction:column;gap:8px;margin-bottom:14px}'
    + '.batch-item{display:flex;gap:12px;padding:10px 12px;background:var(--surface-alt);border:1px solid var(--border-light);border-radius:var(--radius-sm);align-items:center}'
    + '.batch-item img.batch-thumb{width:52px;height:52px;border-radius:5px;object-fit:cover;border:1px solid var(--border);flex-shrink:0}'
    + '.batch-info-col{flex:1;min-width:0;font-size:12px;line-height:1.6}'
    + '.batch-info-col .batch-current{color:var(--text-muted);font-size:11px}'
    + '.batch-info-col .batch-current b{color:var(--text);font-weight:500}'
    + '.batch-info-col .batch-suggest{color:var(--text)}'
    + '.batch-info-col .batch-suggest b{color:var(--primary)}'
    + '.batch-info-col .batch-tag-line{margin:2px 0;font-size:11px;color:var(--text-muted)}'
    + '.batch-info-col .batch-tag-line span{background:var(--primary-light);padding:1px 5px;border-radius:3px;margin-right:3px;color:var(--primary-dark)}'
    + '.batch-status{padding:3px 8px;border-radius:3px;font-size:11px;font-weight:600;white-space:nowrap}'
    + '.batch-status.pending{background:#fff8e1;color:#8a6e00}'
    + '.batch-status.applied{background:#e8f5e9;color:#2e7d32}'
    + '.batch-status.edited{background:#e3f2fd;color:#1565c0}'
    + '.batch-status.skipped{background:#f5f5f5;color:#999}'
    + '.batch-actions-col{display:flex;gap:4px;flex-shrink:0}'
    + '.batch-actions-col button{padding:4px 9px;font-size:11px;border:1px solid var(--border);border-radius:3px;background:var(--surface);cursor:pointer;color:var(--text-muted);font-family:inherit;white-space:nowrap;transition:all .15s}'
    + '.batch-actions-col button:hover{background:var(--surface-alt)}'
    + '.batch-actions-col button.apply:hover{background:var(--success);color:#fff;border-color:var(--success)}'
    + '.batch-actions-col button.edit:hover{background:var(--primary);color:#fff;border-color:var(--primary)}'
    + '.batch-edit-area{margin-top:6px;padding:6px 8px;background:var(--surface);border:1px dashed var(--primary);border-radius:4px;display:none;position:relative;z-index:10}'
    + '.batch-edit-area.open{display:block}'
    + '.batch-edit-area input,.batch-edit-area textarea{width:100%;padding:4px 6px;font-size:11px;border:1px solid var(--border);border-radius:3px;margin-bottom:4px;font-family:inherit;box-sizing:border-box}'
    + '.batch-edit-area textarea{min-height:40px;resize:vertical}'
    + '.batch-edit-area .batch-edit-actions{display:flex;gap:4px;justify-content:flex-end;margin-top:4px}'
    + '.batch-progress{padding:18px;text-align:center;color:var(--primary);font-size:14px}'
    + '.batch-progress .spinner{display:inline-block;width:18px;height:18px;border:2px solid var(--border);border-top-color:var(--primary);border-radius:50%;animation:spin .8s linear infinite;vertical-align:middle;margin-right:8px}'
    + '#batch-modal{pointer-events:none}'
    + '#batch-modal .modal-box{pointer-events:auto}'
    // 角标
    + '.badge-btn{font-size:12px;padding:4px 12px;border:1px solid var(--primary);border-radius:14px;background:var(--primary-light);color:var(--primary-dark);cursor:pointer;font-family:inherit;display:inline-flex;align-items:center;gap:4px;transition:all .15s}'
    + '.badge-btn:hover{background:rgba(93,174,142,.15)}'
    + '.semantic-index-btn.is-pending{border-color:var(--accent);background:rgba(232,155,176,.18);color:var(--accent);box-shadow:0 0 0 3px rgba(232,155,176,.12)}'
    // 偏好页反馈按钮组
    + '.pref-feedback-group{display:flex;gap:4px;flex-shrink:0;align-items:center}'
    + '.pref-feedback-btn{padding:3px 9px;font-size:12px;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--surface);cursor:pointer;color:var(--text-muted);font-family:inherit;line-height:1.4;transition:all .15s;flex-shrink:0}'
    + '.pref-feedback-btn:hover{background:var(--surface-alt);border-color:var(--primary)}'
    + '.pref-feedback-btn[data-fb=positive]:hover{background:var(--success);color:#fff;border-color:var(--success)}'
    + '.pref-feedback-btn[data-fb=negative]:hover{background:var(--danger);color:#fff;border-color:var(--danger)}'
    // v0.19.5 - 已反馈选中态：持久显示，重启后仍在
    + '.pref-feedback-btn.active[data-fb=positive]{background:var(--success);color:#fff;border-color:var(--success);box-shadow:0 0 0 2px rgba(93,174,142,.18)}'
    + '.pref-feedback-btn.active[data-fb=negative]{background:var(--danger);color:#fff;border-color:var(--danger);box-shadow:0 0 0 2px rgba(219,109,102,.18)}'
    + '.pref-feedback-btn.active{opacity:1;cursor:default}'
    + '.pref-chat-btn{font-weight:500}'
    + '.pref-chat-btn:hover{background:var(--accent-light);border-color:var(--accent);color:var(--accent)}'
    // 聊天弹窗
    + '#chat-modal .modal-box{width:920px;max-width:94vw;height:80vh;max-height:760px;padding:0;display:flex;flex-direction:column;overflow:hidden}'
    + '#chat-modal .chat-header{padding:18px 24px 14px;border-bottom:1px solid var(--border-light);display:flex;align-items:center;gap:10px;flex-shrink:0}'
    + '#chat-modal .chat-header h2{font-size:16px;font-weight:600;color:var(--text);margin:0}'
    + '#chat-modal .chat-header .chat-sticker-id{font-size:11px;color:var(--text-light);font-family:monospace;margin-left:auto}'
    + '#chat-modal .chat-body{flex:1;display:flex;overflow:hidden;min-height:0}'
    + '#chat-modal .chat-left{width:260px;flex-shrink:0;padding:16px 18px;border-right:1px solid var(--border-light);background:var(--surface-alt);overflow-y:auto;display:flex;flex-direction:column;gap:12px}'
    + '#chat-modal .chat-left img{width:100%;border-radius:6px;border:1px solid var(--border);background:#fff;aspect-ratio:1;object-fit:contain}'
    + '#chat-modal .chat-tag-block{display:flex;flex-direction:column;gap:4px}'
    + '#chat-modal .chat-tag-label{font-size:10px;color:var(--text-light);font-weight:600;text-transform:uppercase;letter-spacing:.5px}'
    + '#chat-modal .chat-tag-value{font-size:12px;color:var(--text);line-height:1.5}'
    + '#chat-modal .chat-tag-list{display:flex;flex-wrap:wrap;gap:3px}'
    + '#chat-modal .chat-tag-list .tag{font-size:10px;padding:2px 7px}'
    + '#chat-modal .chat-right{flex:1;display:flex;flex-direction:column;min-width:0;background:var(--surface)}'
    + '#chat-modal .chat-messages{flex:1;overflow-y:auto;padding:16px 20px;display:flex;flex-direction:column;gap:10px}'
    + '#chat-modal .chat-bubble{max-width:78%;padding:9px 14px;border-radius:14px;font-size:13px;line-height:1.55;word-wrap:break-word;white-space:pre-wrap}'
    + '#chat-modal .chat-bubble.chat-user{align-self:flex-end;background:var(--primary);color:#fff;border-bottom-right-radius:4px}'
    + '#chat-modal .chat-bubble.chat-assistant{align-self:flex-start;background:var(--surface-alt);color:var(--text);border:1px solid var(--border-light);border-bottom-left-radius:4px}'
    + '#chat-modal .chat-bubble.chat-error{background:var(--danger-light);color:var(--danger);border-color:#e6b8b0}'
    + '#chat-modal .chat-bubble.chat-thinking{align-self:flex-start;color:var(--text-muted);font-style:italic;background:transparent;border:none;padding:4px 0}'
    + '#chat-modal .chat-input-area{padding:12px 18px;border-top:1px solid var(--border-light);display:flex;gap:8px;flex-shrink:0;background:var(--surface-alt)}'
    + '#chat-modal .chat-input-area textarea{flex:1;padding:8px 12px;border:1px solid var(--border);border-radius:var(--radius-sm);font-size:13px;font-family:inherit;background:var(--surface);color:var(--text);resize:none;min-height:38px;max-height:96px;line-height:1.5}'
    + '#chat-modal .chat-input-area textarea:focus{outline:none;border-color:var(--primary)}'
    + '#chat-modal .chat-input-area button{flex-shrink:0;padding:8px 18px;background:var(--primary);color:#fff;border:none;border-radius:var(--radius-sm);cursor:pointer;font-size:13px;font-family:inherit;transition:background .15s}'
    + '#chat-modal .chat-input-area button:hover:not(:disabled){background:var(--primary-dark)}'
    + '#chat-modal .chat-input-area button:disabled{opacity:.5;cursor:wait}'
    + '#chat-modal .chat-preview{padding:12px 18px;background:#f0f8f4;border-top:1px solid var(--primary);flex-shrink:0}'
    + '#chat-modal .chat-preview-header{display:flex;align-items:center;gap:6px;margin-bottom:8px;font-size:12px;font-weight:600;color:var(--primary-dark)}'
    + '#chat-modal .chat-preview-diff{display:grid;grid-template-columns:1fr 1fr;gap:10px;font-size:11px;margin-bottom:10px}'
    + '#chat-modal .chat-preview-col{padding:8px 10px;background:var(--surface);border:1px solid var(--border-light);border-radius:4px}'
    + '#chat-modal .chat-preview-col h5{font-size:10px;color:var(--text-light);text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px;font-weight:600}'
    + '#chat-modal .chat-preview-col.modified{border-color:var(--primary);background:var(--primary-light)}'
    + '#chat-modal .chat-preview-col h5.modified{color:var(--primary-dark)}'
    + '#chat-modal .chat-preview-col .diff-row{margin:3px 0;line-height:1.4;color:var(--text-muted)}'
    + '#chat-modal .chat-preview-col .diff-row b{color:var(--text);font-weight:500}'
    + '#chat-modal .chat-preview-col.modified .diff-row b{color:var(--primary-dark)}'
    + '#chat-modal .chat-preview-actions{display:flex;gap:8px;justify-content:flex-end}'
    + '#chat-modal .chat-preview-actions button{padding:6px 16px;border-radius:var(--radius-sm);font-size:13px;cursor:pointer;font-family:inherit;border:1px solid var(--border);transition:all .15s}'
    + '#chat-modal .chat-preview-actions .btn-confirm{background:var(--primary);color:#fff;border-color:var(--primary)}'
    + '#chat-modal .chat-preview-actions .btn-confirm:hover:not(:disabled){background:var(--primary-dark)}'
    + '#chat-modal .chat-preview-actions .btn-cancel{background:var(--surface);color:var(--text-muted)}'
    + '#chat-modal .chat-preview-actions .btn-cancel:hover{border-color:var(--text-muted)}'
    + '#chat-modal .chat-empty{flex:1;display:flex;align-items:center;justify-content:center;color:var(--text-muted);font-size:13px;padding:20px;text-align:center;line-height:1.6}'
    // 响应式
    + '@media(max-width:640px){'
    + '.view{padding:16px}'
    + '.card-grid{grid-template-columns:1fr}'
    + '#sticker-grid{grid-template-columns:repeat(auto-fill,minmax(140px,1fr))}'
    + '.modal-box{width:100vw;max-width:100vw;border-radius:0}'
    + '}'
    + '</style></head><body>'

    // ═══════════════════════════════════
    //  视图 1：首页
    // ═══════════════════════════════════
    + '<div class="view" id="view-home">'
    + '<div class="home-header">'
    + '<h1>表情包</h1>'
    + '<span class="count" id="home-count">加载中</span>'
    + '<span class="spacer"></span>'
    + '<button class="home-text-btn" id="btn-check-update" title="检查 GitHub 上的新版本">检查更新</button>'
    + '<button class="home-text-btn" id="btn-settings" title="设置">模型设置</button>'
    + '</div>'
    + '<div class="home-main">'
    + '<div class="model-guide" id="model-guide">'
    + '<div class="model-guide-copy">'
    + '<div class="model-guide-title">先添加表情包，再按需配置模型</div>'
    + '<div class="model-guide-list">'
    + '<span class="model-guide-item" id="guide-vision">识图模型 · 待检查</span>'
    + '<span class="model-guide-item" id="guide-text">内容分析 · 待检查</span>'
    + '<span class="model-guide-item" id="guide-embedding">向量检索 · 待检查</span>'
    + '</div>'
    + '<div class="model-guide-note" id="model-guide-note">识图负责自动打标签，内容分析负责聊天时自动配图，向量模型让语义选图更准确。</div>'
    + '</div>'
    + '<button class="model-guide-btn" id="guide-settings-btn">去配置</button>'
    + '</div>'
    + '<div class="card-grid">'
    + '<div class="entry-card" data-color="mint" data-goto="library">'
    + '<div class="card-icon">😺</div>'
    + '<div class="card-title">表情包库</div>'
    + '<div class="card-meta" id="home-lib-meta">加载中...</div>'
    + '<span class="card-arrow">→</span>'
    + '</div>'
    + '<div class="entry-card" data-color="pink" data-action="upload">'
    + '<div class="card-icon">➕</div>'
    + '<div class="card-title">添加入库</div>'
    + '<div class="card-meta">上传新表情包</div>'
    + '<span class="card-arrow">→</span>'
    + '</div>'
    + '<div class="entry-card" data-color="sage" data-goto="preferences">'
    + '<div class="card-icon">🎯</div>'
    + '<div class="card-title">偏好设置</div>'
    + '<div class="card-meta" id="home-pref-meta">配图偏好与反馈记录</div>'
    + '<span class="card-arrow">→</span>'
    + '</div>'
    + '<div class="entry-card" data-color="lavender" data-goto="agent-freq">'
    + '<div class="card-icon">🤖</div>'
    + '<div class="card-title">助手配图频率</div>'
    + '<div class="card-meta">控制每个助手发图的频率高低</div>'
    + '<span class="card-arrow">→</span>'
    + '</div>'
    + '</div>'
    + '<button type="button" class="entry-card home-preference-tip" data-goto="preferences" aria-label="配图不太对？进入偏好设置调整">'
    + '<span class="preference-tip-icon" aria-hidden="true">💡</span>'
    + '<span class="preference-tip-copy"><strong>配图不太对？</strong><span>进入「偏好设置」，点击「聊聊」告诉小花，她会陪你一起调整。</span></span>'
    + '<span class="preference-tip-action">去调整 →</span>'
    + '</button>'
    + '</div>' // end home-main
    + '</div>' // end view-home

    // ═══════════════════════════════════
    //  视图 2：表情包库
    // ═══════════════════════════════════
    + '<div class="view hidden" id="view-library">'
    + '<div class="library-controls">'
    + '<div class="sub-header">'
    + '<button class="back-btn" data-goto="home">← 返回</button>'
    + '<h2>表情包库</h2>'
    + '<span class="count" id="sticker-count">0 张</span>'
    + '<span class="spacer"></span>'
    + '<button class="badge-btn semantic-index-btn" id="embedding-index-btn" title="给有语义描述但还没有索引的图片建立语义索引">图库语义索引</button>'
    + '<button class="badge-btn" id="batch-tasks-badge" title="批量识图任务">批量识图任务</button>'
    + '<button class="back-btn" id="btnToggleMulti">多选图片识图</button>'
    + '</div>'
    + '<div class="filter-bar">'
    + '<select id="filter-emotion"><option value="">全部情绪</option><option value="开心">开心</option><option value="搞笑">搞笑</option><option value="鼓励">鼓励</option><option value="感谢">感谢</option><option value="难过">难过</option><option value="无语">无语</option><option value="可爱">可爱</option><option value="嘲讽">嘲讽</option><option value="治愈">治愈</option></select>'
    + '<input type="text" id="filter-search" placeholder="搜索描述 / 关键词...">'
    + '</div>'
    + '<div id="batch-toolbar" class="batch-toolbar" hidden>'
    + '<span class="batch-info">已选 <b id="batch-count">0</b> 张</span>'
    + '<button class="batch-btn" id="batch-select-all">全选当前</button>'
    + '<button class="batch-btn" id="batch-select-untagged" title="选中整个图库里所有尚未 AI 识图的图片">选中全部未识图</button>'
    + '<button class="batch-btn" id="batch-clear">清空</button>'
    + '<span style="flex:1"></span>'
    + '<button class="batch-btn batch-btn-primary" id="batch-auto-tag">AI 批量识图</button>'
    + '<button class="batch-btn" id="batch-delete">删除</button>'
    + '</div>'
    + '</div>' /* end library-controls */
    + '<div id="sticker-grid"><div class="empty-state">加载中...</div></div>'
    + '</div>'

    // ═══════════════════════════════════
    //  视图 3：偏好设置（含助手排除）
    // ═══════════════════════════════════
    + '<div class="view hidden" id="view-preferences">'
    + '<div class="sub-header">'
    + '<button class="back-btn" data-goto="home">← 返回</button>'
    + '<h2>偏好设置</h2>'
    + '</div>'

    // 决策日志 + 偏好映射
    + '<div class="pref-section">'
    + '<h3>📊 配图决策日志</h3>'
    + '<div class="section-desc">每次配图的决策记录。可以点 👍/👎 给反馈，调整助手以后的配图偏好。</div>'
    + '<div class="pref-stats" id="pref-stats"></div>'
    + '<div id="pref-log" style="font-size:12px">加载中...</div>'
    + '</div>'

    + '</div>' // end view-preferences

    // ═══════════════════════════════════
    //  视图 4：助手配图频率
    // ═══════════════════════════════════
    + '<div class="view hidden" id="view-agent-freq">'
    + '<div class="sub-header">'
    + '<button class="back-btn" data-goto="home">← 返回</button>'
    + '<h2>助手配图频率</h2>'
    + '</div>'
    + '<div class="pref-section">'
    + '<div class="section-desc">先决定这位助手是否可以配图，再分别设置日常聊天和处理正事时的频率。四档都是大致频率，插件会避免连续两轮提醒配图。</div>'
    + '<div class="scene-toggle" id="agent-freq-scene-toggle" style="display:flex;gap:4px;margin-bottom:14px;padding:4px;background:var(--surface-alt);border-radius:var(--radius-sm);border:1px solid var(--border)">'
    + '<button type="button" class="scene-toggle-btn scene-toggle-btn-active" data-scene="daily" style="flex:1;padding:7px 12px;border:none;background:var(--primary-light);color:var(--primary-dark);border-radius:4px;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit">日常</button>'
    + '<button type="button" class="scene-toggle-btn" data-scene="task" style="flex:1;padding:7px 12px;border:none;background:transparent;color:var(--text-muted);border-radius:4px;font-size:13px;font-weight:500;cursor:pointer;font-family:inherit">正事</button>'
    + '</div>'
    + '<div id="agent-freq-list" style="display:flex;flex-direction:column;gap:10px;margin-bottom:14px">加载中...</div>'
    + '<div class="freq-save-bar"><span class="freq-save-status" id="agent-freq-save-status">已保存</span>'
    + '<button class="btn btn-primary" id="save-agent-freq-btn" disabled>保存设置</button></div>'
    + '</div>'
    + '</div>'

    // ═══════════════════════════════════
    //  弹窗：添加入库
    // ═══════════════════════════════════
    + '<div class="modal-overlay" id="upload-modal" hidden>'
    + '<div class="modal-box fixed-modal-box upload-modal-box" style="position:relative">'
    + '<div class="modal-head"><h2>添加入库</h2><button class="modal-close" data-close="upload-modal" style="z-index:10">✕</button></div>'
    + '<div class="modal-body">'
    + '<div class="import-section">'
    + '<div class="import-section-title">导入图片</div>'
    + '<div class="import-section-desc">可以一次选择多张。导入后再到图库里单张编辑或批量识图。</div>'
    + '<div class="form-group"><input type="file" id="upload-file" accept="image/png,image/jpeg,image/gif,image/webp,image/bmp" multiple><div class="form-hint" id="upload-file-hint">支持 PNG、JPG、GIF、WebP 和 BMP。</div></div>'
    + '<div class="modal-actions"><button class="btn btn-primary" id="upload-btn">导入图片</button></div>'
    + '</div>'
    + '<div class="import-section">'
    + '<div class="import-section-title">导入 ZIP 图片包</div>'
    + '<div class="import-section-desc">最多 50MB、500 个文件；只导入支持的图片，重复或异常文件会自动跳过。</div>'
    + '<div class="form-group"><input type="file" id="upload-zip" accept=".zip,application/zip"></div>'
    + '<div class="modal-actions"><button class="btn" id="import-zip-btn">导入 ZIP</button></div>'
    + '</div>'
    + '<div class="import-result" id="upload-result" hidden></div>'
    + '</div></div></div>'

    // ═══════════════════════════════════
    //  弹窗：设置（识图模型 + 分析模型）
    // ═══════════════════════════════════
    + '<div class="modal-overlay" id="settings-modal" hidden>'
    + '<div class="modal-box fixed-modal-box" style="position:relative;width:480px">'
    + '<div class="modal-head"><h2>设置</h2><button class="modal-close" data-close="settings-modal">✕</button></div>'
    + '<div class="modal-body">'

    // 识图模型
    + '<div class="settings-section">'
    + '<h3>⚙️ 识图模型</h3>'
    + '<div class="settings-desc">用来识别表情包图片内容、自动生成标签的视觉模型。</div>'
    + '<div class="select-group"><label style="font-size:12px;color:var(--text-muted);min-width:40px">来源</label>'
    + '<select id="vision-source"><option value="hana">Hana 已配置模型</option><option value="custom">自定义 API</option></select></div>'
    + '<div id="vision-hana-block">'
    + '<div class="select-group"><select id="vision-provider"><option value="">选择 Provider...</option></select>'
    + '<select id="vision-model"><option value="">选择模型...</option></select></div></div>'
    + '<div id="vision-custom-block" style="display:none">'
    + '<div class="form-group"><label>Base URL</label><input type="text" id="vision-custom-url" placeholder="https://api.openai.com/v1"></div>'
    + '<div class="form-group"><label>API Key</label><input type="password" id="vision-custom-key" placeholder="sk-..."></div>'
    + '<div class="form-group"><label>模型名</label><input type="text" id="vision-custom-model" placeholder="gpt-4o"></div></div>'
    + '<div class="select-group" style="margin-top:8px"><button class="btn btn-secondary" id="vision-test-btn" style="width:auto;font-size:12px">测试连通</button>'
    + '<span id="vision-test-result" style="font-size:12px;color:var(--text-muted);flex:1;min-width:120px"></span></div>'
    + '</div>'

    // 分析模型
    + '<div class="settings-section">'
    + '<h3>🧠 内容分析模型</h3>'
    + '<div class="settings-desc">在每次聊天时自动判断「该不该配图、配什么图」。配轻量便宜的就行。</div>'
    + '<div class="form-group"><label><input type="checkbox" id="text-enabled" style="vertical-align:middle;width:auto;margin-right:6px;accent-color:var(--primary)">启用辅助模型（关闭后不做自动判断）</label></div>'
    + '<div class="select-group"><label style="font-size:12px;color:var(--text-muted);min-width:40px">来源</label>'
    + '<select id="text-source"><option value="hana">Hana 已配置模型</option><option value="custom">自定义 API</option></select></div>'
    + '<div id="text-hana-block">'
    + '<div class="select-group"><select id="text-provider"><option value="">选择 Provider...</option></select>'
    + '<select id="text-model"><option value="">选择模型...</option></select></div></div>'
    + '<div id="text-custom-block" style="display:none">'
    + '<div class="form-group"><label>Base URL</label><input type="text" id="text-custom-url" placeholder="https://api.deepseek.com/v1"></div>'
    + '<div class="form-group"><label>API Key</label><input type="password" id="text-custom-key" placeholder="sk-..."></div>'
    + '<div class="form-group"><label>模型名</label><input type="text" id="text-custom-model" placeholder="deepseek-chat"></div></div>'
    + '<div class="select-group" style="margin-top:8px"><button class="btn btn-secondary" id="text-test-btn" style="width:auto;font-size:12px">测试连通</button>'
    + '<span id="text-test-result" style="font-size:12px;color:var(--text-muted);flex:1;min-width:120px"></span></div>'
    + '</div>'

    // v0.18.0 Embedding 向量检索：与识图/内容模型完全对称
    + '<div class="settings-section">'
    + '<h3>🔮 向量检索</h3>'
    + '<div class="settings-desc">把表情包的语义描述转成向量，用语义相似度匹配情绪词，让选图更准。锦上添花的功能，不配也不影响发图。</div>'
    + '<div class="select-group"><label style="font-size:12px;color:var(--text-muted);min-width:40px">来源</label>'
    + '<select id="embedding-source"><option value="hana">Hana 已配置模型</option><option value="custom">自定义 API</option></select></div>'
    + '<div id="embedding-hana-block">'
    + '<div id="embedding-hana-empty" style="display:none;color:var(--text-muted);font-size:12px;padding:6px 0">Hana 当前没有配置向量模型。可以在 Hana 模型管理中添加，或用下方自定义 API。</div>'
    + '<div class="select-group"><select id="embedding-provider"><option value="">选择 Provider...</option></select>'
    + '<select id="embedding-model"><option value="">选择模型...</option></select></div></div>'
    + '<div id="embedding-custom-block" style="display:none">'
    + '<div class="form-group"><label>Base URL</label><input type="text" id="embedding-custom-url" placeholder="https://api.example.com/v1"></div>'
    + '<div class="form-group"><label>API Key</label><input type="password" id="embedding-custom-key" placeholder="sk-..."></div>'
    + '<div class="form-group"><label>模型名</label><input type="text" id="embedding-custom-model" placeholder="embedding-model-name"></div>'
    + '<div class="form-group"><label>向量维度（选填）</label><input type="text" id="embedding-custom-dimensions" placeholder="1024"></div></div>'
    + '<div class="select-group" style="margin-top:8px">'
    + '<button class="btn btn-secondary" id="embedding-test-btn" style="width:auto;font-size:12px">测试连通</button>'
    + '<span id="embedding-test-result" style="font-size:12px;color:var(--text-muted);flex:1;min-width:120px"></span></div>'
        + '</div>'
    + '</div>'

    + '<div class="modal-foot"><div class="modal-actions">'
    + '<button class="btn btn-secondary" data-close="settings-modal">取消</button>'
    + '<button class="btn btn-primary" id="settings-save" style="width:auto">保存</button>'
    + '</div></div>'
    + '</div></div>'

    // ═══════════════════════════════════
    //  弹窗：编辑标签
    // ═══════════════════════════════════
    + '<div class="modal-overlay" id="editor-modal" hidden>'
    + '<div class="modal-box fixed-modal-box" style="position:relative">'
    + '<div class="modal-head"><h2>编辑标签</h2><button class="modal-close" data-close="editor-modal">✕</button></div>'
    + '<div class="modal-body">'
    + '<input type="hidden" id="edit-id">'
    + '<div class="form-group"><label>描述</label><input type="text" id="edit-desc"></div>'
    + '<div class="form-group"><label>情绪标签</label><input type="text" id="edit-emotion" placeholder="逗号分隔"></div>'
    + '<div class="form-group"><label>场景标签</label><input type="text" id="edit-scene" placeholder="逗号分隔"></div>'
    + '<div class="form-group"><label>关键词</label><input type="text" id="edit-keywords" placeholder="逗号分隔"></div>'
    + '<button class="ai-btn" id="editor-autotag-btn" style="margin-top:4px">AI 重新识图</button>'
    + '</div>'
    + '<div class="modal-foot"><div class="modal-actions"><button class="btn btn-secondary" data-close="editor-modal">取消</button>'
    + '<button class="btn btn-primary" id="editor-save" style="width:auto">保存</button></div></div>'
    + '</div></div>'

    // ═══════════════════════════════════
    //  弹窗：批量识图结果
    // ═══════════════════════════════════
    + '<div class="modal-overlay" id="batch-modal" hidden>'
    + '<div class="modal-box batch-modal" style="position:relative">'
    + '<div class="modal-head"><h2>批量 AI 识图</h2><button class="modal-close" id="batch-modal-close">✕</button></div>'
    + '<div class="modal-body">'
    + '<div class="batch-summary" id="batch-summary"></div>'
    + '<div class="batch-list" id="batch-list"></div>'
    + '</div></div></div>'

    // ═══════════════════════════════════
    //  弹窗：聊天调整标签
    // ═══════════════════════════════════
    + '<div class="modal-overlay" id="chat-modal" hidden>'
    + '<div class="modal-box">'
    + '<div class="chat-header">'
    + '<h2>💬 跟小花聊聊这张图</h2>'
    + '<span class="chat-sticker-id" id="chat-sticker-id"></span>'
    + '<button class="modal-close" data-close="chat-modal">✕</button>'
    + '</div>'
    + '<div class="chat-body">'
    + '<div class="chat-left">'
    + '<img id="chat-sticker-img" alt="">'
    + '<div class="chat-tag-block"><span class="chat-tag-label">描述</span><span class="chat-tag-value" id="chat-tag-desc"></span></div>'
    + '<div class="chat-tag-block"><span class="chat-tag-label">情绪</span><div class="chat-tag-list" id="chat-tag-emotion"></div></div>'
    + '<div class="chat-tag-block"><span class="chat-tag-label">场景</span><div class="chat-tag-list" id="chat-tag-scene"></div></div>'
    + '<div class="chat-tag-block"><span class="chat-tag-label">关键词</span><div class="chat-tag-list" id="chat-tag-keywords"></div></div>'
    + '</div>'
    + '<div class="chat-right">'
    + '<div class="chat-messages" id="chat-messages">'
    + '<div class="chat-empty">告诉我哪里不对、该怎么调。<br>比如：这张图表达的是撒娇不是开心</div>'
    + '</div>'
    + '<div class="chat-preview" id="chat-preview" hidden>'
    + '<div class="chat-preview-header">📝 修改预览</div>'
    + '<div class="chat-preview-diff" id="chat-preview-diff"></div>'
    + '<div class="chat-preview-actions">'
    + '<button class="btn-cancel" id="chat-preview-discard">取消预览</button>'
    + '<button class="btn-confirm" id="chat-preview-confirm">✅ 确认修改</button>'
    + '</div>'
    + '</div>'
    + '<div class="chat-input-area">'
    + '<textarea id="chat-input" placeholder="说说哪里不对…（Shift+Enter 换行）" rows="1"></textarea>'
    + '<button id="chat-send-btn">发送</button>'
    + '</div>'
    + '</div>'
    + '</div>'
    + '</div></div>'

    // 加载遮罩
    + '<div class="loading-overlay" id="loading-overlay" hidden><div class="spinner"></div><div id="loading-text" style="font-size:14px;color:var(--primary)">处理中...</div></div>'

    // 注入服务端配置
    + '<script>window.__VISION_CONFIG__=' + JSON.stringify(safeVisionConfig).replace(/</g, '\\u003c') + ';</script>'
    + '<script>window.__VISION_MODELS__=' + JSON.stringify(visionModels).replace(/</g, '\\u003c') + ';</script>'
    + '<script>window.__TEXT_CONFIG__=' + JSON.stringify(safeTextConfig).replace(/</g, '\\u003c') + ';</script>'
    + '<script>window.__TEXT_MODELS__=' + JSON.stringify(textModels).replace(/</g, '\\u003c') + ';</script>'
    + '<script>window.__PREFERENCES__=' + JSON.stringify(prefsData).replace(/</g, '\\u003c') + ';</script>'
    + '<script>window.__DECISION_LOG__=' + JSON.stringify(logData).replace(/</g, '\\u003c') + ';</script>'
    + '<script>window.__EMBEDDING_CONFIG__=' + JSON.stringify(safeEmbeddingConfig).replace(/</g, '\\u003c') + ';</script>'
    + '<script>window.__EMBEDDING_MODELS__=' + JSON.stringify(embeddingModels).replace(/</g, '\\u003c') + ';</script>'
    + '<script>' + js + '</script></body></html>';
}

export default async function registerRoutes(app, ctx) {
  ctx?.log?.info?.('[biaoqingbao] UI 路由已注册');

  app.get('/page', (c) => {
    return c.html(renderPage(), 200);
  });

  app.get('/sticker', (c) => {
    const id = c.req.query('id') || '';
    const label = c.req.query('label') || '表情包';
    const description = c.req.query('description') || '';
    const score = c.req.query('score') || '';

    if (!id) return c.text('missing id', 400);

    const META_FILE = path.join(DATA_DIR, 'stickers.json');
    const STICKERS_DIR_LOCAL = path.join(__dirname, '..', 'stickers');
    let meta;
    try { meta = JSON.parse(fs.readFileSync(META_FILE, 'utf-8')); } catch { meta = []; }
    const s = meta.find(x => x.id === id);
    if (!s) return c.text('sticker not found', 404);

    let imgBase64 = '';
    try {
      const buf = fs.readFileSync(path.join(STICKERS_DIR_LOCAL, s.file));
      const ext = s.file.split('.').pop().toLowerCase();
      const mime = MIME_MAP[ext] || 'image/jpeg';
      imgBase64 = `data:${mime};base64,${buf.toString('base64')}`;
    } catch (e) {
      return c.text('sticker file read error: ' + e.message, 500);
    }

    return c.html(`<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <title>表情包</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { width: 100%; height: 100%; }
    body {
      display: flex;
      align-items: center;
      justify-content: center;
      background: transparent;
    }
    img {
      width: 100%;
      height: 100%;
      display: block;
      object-fit: contain;
    }
  </style>
</head>
<body>
  <img src="${imgBase64}" alt="表情包" />
</body>
</html>`, 200);
  });
}
