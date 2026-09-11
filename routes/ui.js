// 表情包插件 - 管理页面渲染（仅 GET /page）
// v0.15.0 - UI 改版：三视图架构 + 薄荷绿/樱花粉配色
// v0.17.4-share: 公共函数从 lib/shared.js 导入
import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  DATA_DIR, VISION_CFG_FILE, TEXT_CFG_FILE, EMBEDDING_CFG_FILE,
  HANA_HOME, MODELS_JSON, MIME_MAP, STICKERS_DIR,
  readVisionConfig, getAvailableVisionModels, getAvailableTextModels,
  readTextConfig, readEmbeddingConfig, getAvailableEmbeddingModels,
  escapeHtml,
} from '../lib/shared.js';
import { AUTO_FIT_MAX } from '../lib/smart-fit.js';
import { readContextFeedback } from '../lib/context-feedback.js';
import { EXPORT_CONFIG_FILE_NAME, readLastExportDir } from '../lib/sticker-transfer.js';
import { safeStickerPath } from '../lib/ball-core.js';

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
  // v0.30.1：学我说话展示名固定（入口按钮/标题统一叫「学我说话」）
  const userstyleName = '学我说话';
  // v0.31.0：学我说话总结前置依赖「内容分析模型」——未配置时页面顶部直接给引导条
  const textReady = !!(textConfig.enabled && (
    (textConfig.source === 'custom' && textConfig.customBaseUrl && textConfig.customModel && textConfig.customApiKey) ||
    (textConfig.source !== 'custom' && textConfig.providerId && textConfig.modelId)
  ));
  // 页面只接收密钥占位符；真实密钥始终留在服务端配置文件中。
  const safeVisionConfig = { ...visionConfig, customApiKey: visionConfig.customApiKey ? '********' : '' };
  const safeTextConfig = { ...textConfig, customApiKey: textConfig.customApiKey ? '********' : '' };
  const safeEmbeddingConfig = { ...embeddingConfig, customApiKey: embeddingConfig.customApiKey ? '********' : '' };
  const exportConfigPath = path.join(DATA_DIR, EXPORT_CONFIG_FILE_NAME);
  const defaultExportDir = readLastExportDir(exportConfigPath, path.join(homedir(), 'Downloads'));

  let prefsData = { version: 1, users: {} };
  try { prefsData = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'preferences.json'), 'utf-8')); } catch {}
  let logData = { version: 1, entries: [] };
  try { logData = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'decision-log.json'), 'utf-8')); } catch {}
  // v0.33.63 - 应景账本注入管理页，偏好区展示“这次很应景”记录
  const contextFeedbackData = readContextFeedback({ dataDir: DATA_DIR });
  // v0.24.0 - 配图卡片显示配置（小图自适应开关）
  // v0.28.0 - 新增 showFeedbackButtons：聊天卡片下方喜欢/不喜欢按钮显示开关
  let displayCfg = { smallImageFit: true, smallImageThreshold: 200, showFeedbackButtons: true, sizeMode: 'auto' };
  try { displayCfg = { ...displayCfg, ...JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'display-config.json'), 'utf-8')) }; } catch {}

  return '<!DOCTYPE html>'
    + '<html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">'
    + '<title>表情包</title><style>'
    // ═══ 设计令牌：薄荷绿主色 + 樱花粉辅色 ═══
    + ':root{'
    + '--bg:#f2f5ef;'
    + '--surface:#fdfcfa;'
    + '--surface-alt:#f4f8f4;'
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
    + '--radius-lg:20px;'
    + '}'
    + '*{margin:0;padding:0;box-sizing:border-box}'
    + '[hidden]{display:none!important}'
    // 滚动条统一：细薄荷圆条（横竖同规范，2026-08-26）
    + '*::-webkit-scrollbar{width:8px;height:8px}'
    + '*::-webkit-scrollbar-track{background:transparent}'
    + '*::-webkit-scrollbar-thumb{background:#c9dfd3;border-radius:99px;border:2px solid var(--bg)}'
    + '*::-webkit-scrollbar-thumb:hover{background:var(--primary)}'
    + '*{scrollbar-width:thin;scrollbar-color:#c9dfd3 transparent}'
    + 'body{font-family:-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;background:var(--bg);color:var(--text);padding:0}'
    // ═══ 视图容器 ═══
    + '.view{padding:24px;max-width:1100px;margin:0 auto}'
    + '.view.hidden{display:none}'
    // v0.18.x view-library 顶部控件统一包成 sticky wrapper
    + '#view-library .library-controls{display:flex;flex-direction:column;gap:10px;position:sticky;top:0;z-index:20;background:var(--bg);padding:14px 0 16px;box-shadow:0 1px 0 var(--border-light)}'
    + '#view-library .sub-header{position:static;background:transparent;margin:0;padding:0}'
    + '#view-library .batch-toolbar{position:static;margin-bottom:0}'
    // ═══ 首页 ═══
    + '.icon-btn{width:38px;height:38px;border:1px solid var(--border);border-radius:50%;background:var(--surface);cursor:pointer;color:var(--text-muted);font-size:16px;display:flex;align-items:center;justify-content:center;transition:all .2s}'
    + '.icon-btn:hover{border-color:var(--primary);color:var(--primary);background:var(--primary-light)}'
    // v0.34.18 - 首页重做：横屏优先，顶部两层 + 主区左右分栏（左库右入口），去掉撑满视口的垂直居中
    + '#view-home{padding:22px 24px 24px;max-width:1800px;margin:0 auto;display:flex;flex-direction:column;gap:14px;height:100vh;min-height:520px}'
    + '#view-home.hidden{display:none}'
    + '.home-top{display:flex;align-items:center;gap:12px}'
    + '.home-top h1{font-size:22px;font-weight:600;color:var(--text);letter-spacing:.5px}'
    + '.home-top .count{font-size:12px;color:var(--primary-dark);background:var(--primary-light);padding:3px 11px;border-radius:20px;font-weight:500}'
    + '.home-top .spacer{flex:1}'
    + '.home-menu-wrap{position:relative}'
    + '.home-menu{position:absolute;right:0;top:calc(100% + 8px);min-width:168px;background:var(--surface);border:1px solid var(--border);border-radius:14px;box-shadow:0 10px 26px rgba(93,174,142,.16);padding:6px;z-index:60;display:flex;flex-direction:column;gap:2px}'
    + '.home-menu[hidden]{display:none}'
    + '.home-menu-item{display:block;width:100%;text-align:left;padding:8px 12px;border:none;background:transparent;border-radius:9px;font-size:13px;font-family:inherit;color:var(--text);cursor:pointer;transition:all .15s}'
    + '.home-menu-item:hover{background:var(--primary-light);color:var(--primary-dark)}'
    + '.home-text-btn.active{border-color:var(--primary);color:var(--primary-dark);background:var(--primary-light)}'
    + '.home-status{display:flex;align-items:center;gap:10px;flex-wrap:wrap;background:var(--surface);border:1px solid var(--border-light);border-radius:var(--radius);padding:10px 16px;box-shadow:var(--shadow)}'
    + '.home-status .spacer{flex:1}'
    + '.status-divider{width:1px;height:16px;background:var(--border-light)}'
    + '.model-state{display:flex;align-items:center;gap:7px;flex-wrap:wrap}'
    + '.model-state-label{font-size:11px;color:var(--text-light)}'
    + '.home-main{display:grid;grid-template-columns:minmax(0,1fr) clamp(236px,26%,300px);gap:14px;align-items:stretch;flex:1;min-height:0}'
    + '.home-hero{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-lg);padding:18px 20px 16px;box-shadow:var(--shadow);cursor:pointer;transition:all .2s;display:flex;flex-direction:column;min-width:0;min-height:0}'
    + '.home-hero:hover{border-color:var(--primary);box-shadow:var(--shadow-hover);transform:translateY(-2px)}'
    + '.home-hero:focus-visible{outline:2px solid var(--primary);outline-offset:3px}'
    + '.hero-head{display:flex;align-items:center;gap:10px;margin-bottom:15px}'
    + '.hero-head h2{font-size:16px;font-weight:600;color:var(--text)}'
    + '.hero-head .spacer{flex:1}'
    + '.hero-go{font-size:12px;color:var(--primary-dark);background:var(--primary-light);padding:5px 12px;border-radius:20px;font-weight:500;transition:all .18s;white-space:nowrap}'
    + '.home-hero:hover .hero-go{background:var(--primary);color:#fff}'
    + '.section-label{font-size:11px;color:var(--text-light);letter-spacing:1px;margin-bottom:9px;display:flex;align-items:center;gap:7px}'
    + '.section-label::after{content:"";flex:1;height:1px;background:var(--border-light)}'
    + '.hero-strip{display:grid;grid-template-columns:repeat(auto-fill,minmax(128px,1fr));gap:9px;flex:1;min-height:120px;align-content:start;overflow-y:auto;padding-right:2px}'
    + '.hero-strip figure{position:relative;aspect-ratio:1/1;border-radius:12px;overflow:hidden;background:var(--surface-alt);border:1px solid var(--border-light);transition:transform .2s}'
    + '.home-hero:hover .hero-strip figure{transform:translateY(-1px)}'
    + '.hero-strip img{width:100%;height:100%;object-fit:cover;display:block}'
    + '.strip-empty{grid-column:1/-1;padding:22px 16px;border:1px dashed var(--border);border-radius:12px;background:var(--surface-alt);color:var(--text-muted);font-size:13px;font-family:inherit;cursor:pointer;transition:all .15s}'
    + '.strip-empty:hover{border-color:var(--primary);color:var(--primary-dark);background:var(--primary-light)}'
    + '.hero-foot{margin-top:auto;padding-top:14px;border-top:1px dashed var(--border);display:flex;align-items:center;gap:16px;flex-wrap:wrap;font-size:12px;color:var(--text-muted)}'
    + '.hero-foot .dot{width:5px;height:5px;border-radius:50%;background:var(--primary);display:inline-block;margin-right:5px;vertical-align:1px}'
    + '.home-entries{display:flex;flex-direction:column;gap:11px;min-width:0;min-height:0}'
    + '.home-entry{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;text-align:center;font-family:inherit;color:var(--text);background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:14px 12px;cursor:pointer;box-shadow:var(--shadow);transition:all .2s;min-height:62px;min-width:0;position:relative}'
    + '.home-entry:hover{border-color:var(--primary);box-shadow:var(--shadow-hover);transform:translateY(-2px)}'
    + '.home-entry:focus-visible{outline:2px solid var(--primary);outline-offset:2px}'
    + '.home-entry .entry-icon{width:44px;height:44px;border-radius:13px;flex-shrink:0;display:flex;align-items:center;justify-content:center;background:var(--primary-light);color:var(--primary-dark)}'
    + '.home-entry .entry-icon.is-pink{background:var(--accent-light);color:#c2708a}'
    + '.home-entry .entry-icon svg{width:22px;height:22px}'
    + '.home-entry .entry-text{flex:none;min-width:0;width:100%}'
    + '.home-entry .entry-text b{display:block;font-size:14px;font-weight:600;margin-bottom:3px}'
    + '.home-entry .entry-text span{display:block;font-size:11.5px;color:var(--text-muted);line-height:1.45;white-space:normal}'
    + '.home-entry .entry-arrow{position:absolute;top:12px;right:14px;color:var(--text-light);font-size:13px;transition:transform .2s,color .2s}'
    + '.home-entry:hover .entry-arrow{transform:translateX(3px);color:var(--primary)}'
    // v0.17.5 - 右上角「模型设置」胶囊按钮，参考「任务 (X)」的细线胶囊样式
    + '.home-text-btn{font-size:13px;padding:5px 14px;border:1px solid var(--border);border-radius:14px;background:var(--surface);cursor:pointer;color:var(--text-muted);font-family:inherit;display:inline-flex;align-items:center;white-space:nowrap;transition:all .15s}'
    + '.home-text-btn:hover{border-color:var(--primary);color:var(--primary);background:var(--primary-light)}'
    // v0.33.77 - 数据与迁移页：整包搬家入口与导入反馈
    + '.migration-panel{max-width:760px;margin:0 auto}'
    + '.migration-card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:22px;box-shadow:var(--shadow);margin-bottom:14px}'
    + '.migration-card h3{font-size:16px;font-weight:600;margin-bottom:8px;color:var(--text)}'
    + '.migration-card p{font-size:13px;line-height:1.7;color:var(--text-muted);margin-bottom:14px}'
    + '.migration-actions{display:flex;gap:10px;flex-wrap:wrap;align-items:center}'
    + '.migration-actions .btn{width:auto}'
    + '.migration-status{margin-top:14px;padding:10px 12px;background:var(--surface-alt);border:1px solid var(--border-light);border-radius:var(--radius-sm);font-size:12px;line-height:1.7;color:var(--text-muted);white-space:pre-wrap;word-break:break-word}'
    + '.migration-status.is-error{color:var(--danger);border-color:#e6b8b0;background:var(--danger-light)}'
    + '.migration-security{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px 18px;margin-top:12px;font-size:12px;color:var(--text-muted);line-height:1.6}'
    + '@media(max-width:560px){.migration-security{grid-template-columns:1fr}}'
    // v0.31.0 - 悬浮球开关放在插件主页，图库只负责加入/移出表情包
    + '.ball-toggle-wrap{display:inline-flex;align-items:center;gap:8px;padding:5px 10px 5px 12px;border:1px solid var(--border);border-radius:16px;background:var(--surface);color:var(--text-muted);font-size:12px;font-family:inherit;cursor:pointer;transition:all .15s;white-space:nowrap}'
    + '.ball-toggle-wrap:hover{border-color:var(--primary);color:var(--primary);background:var(--primary-light)}'
    + '.ball-toggle-wrap.on{border-color:var(--primary);background:var(--primary-light);color:var(--primary-dark)}'
    + '.ball-toggle-wrap:disabled{cursor:wait;opacity:.62}'
    + '.auto-image-toggle-wrap.on{border-color:var(--accent);background:var(--accent-light);color:#a85b72}'
    + '.auto-image-toggle-wrap:hover{border-color:var(--accent);color:#a85b72;background:var(--accent-light)}'
    + '.auto-image-toggle-wrap .ball-toggle-switch.on{background:var(--accent)}'
    + '.ball-toggle-label{line-height:18px}'
    + '.ball-toggle-switch{width:32px;height:18px;border-radius:999px;background:var(--border);padding:2px;display:inline-flex;align-items:center;transition:background .2s}'
    + '.ball-toggle-switch.on{background:var(--primary)}'
    + '.ball-toggle-thumb{width:14px;height:14px;border-radius:50%;background:var(--surface);box-shadow:0 1px 2px rgba(45,58,53,.16);transition:transform .2s}'
    + '.ball-toggle-switch.on .ball-toggle-thumb{transform:translateX(14px)}'
    + '.ball-status-top{font-size:11px;color:var(--text-light);white-space:nowrap}'
    + '.auto-image-status{min-width:42px}'
    + '.global-freq-note{margin:0 0 14px;padding:9px 11px;border:1px solid var(--border-light);border-radius:var(--radius-sm);background:var(--primary-light);color:var(--text-muted);font-size:12px;line-height:1.6}'
    + '.global-freq-note.is-off{border-color:#efc9c2;background:var(--danger-light);color:var(--danger)}'
    + '#view-agent-freq.global-off .agent-card{opacity:.8}'
    + '#view-agent-freq.global-off .freq-pill:disabled{cursor:not-allowed}'
    // v0.34.18 - 模型引导从独立大卡收进状态条右侧，胶囊缩小
    + '.model-guide-item{font-size:11px;color:var(--text-muted);background:var(--surface-alt);border:1px solid var(--border-light);border-radius:12px;padding:3px 9px;white-space:nowrap}'
    + '.model-guide-item.ready{color:var(--success);background:var(--primary-light);border-color:var(--border)}'
    + '.model-guide-item.pending{color:var(--danger);background:var(--danger-light);border-color:#efc9c2}'
    + '.model-guide-btn{padding:5px 12px;border:1px solid var(--primary);border-radius:14px;background:var(--primary);color:#fff;font-size:12px;font-family:inherit;cursor:pointer;transition:all .15s;white-space:nowrap}'
    + '.model-guide-btn:hover{background:var(--primary-dark);border-color:var(--primary-dark)}'
    // v0.34.18 - 旧 5 卡平铺样式（.card-grid / .entry-card）已由 .home-hero + .home-entry 取代
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
    + '/* v0.24.0 - 小图自适应拨动开关（图库页） */'
    + '.fit-toggle{display:inline-flex;align-items:center;gap:6px;cursor:pointer;user-select:none;padding:4px 10px;border:1px solid var(--border);border-radius:999px;background:var(--surface);transition:border-color .15s,background .15s;flex-shrink:0}'
    + '.fit-toggle:hover{border-color:var(--primary)}'
    + '.fit-track{width:36px;height:20px;border-radius:999px;background:var(--border);position:relative;flex-shrink:0;transition:background .2s}'
    + '.fit-knob{position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.18);transition:left .2s}'
    + '.fit-toggle.on .fit-track{background:var(--primary)}'
    + '.fit-toggle.on .fit-knob{left:18px}'
    + '.fit-label{font-size:12px;color:var(--text-muted);white-space:nowrap;transition:color .15s}'
    + '.fit-toggle.on .fit-label{color:var(--primary-dark);font-weight:600}'
    + '/* v0.33.77 - 图片尺寸档位选择器（自动/小/中/大） */'
    + '.size-mode-select{padding:6px 10px;border:1px solid var(--border);border-radius:999px;font-size:12px;background:var(--surface);color:var(--text-muted);font-family:inherit;cursor:pointer;flex-shrink:0;transition:border-color .15s,color .15s}'
    + '.size-mode-select:hover,.size-mode-select:focus{border-color:var(--primary);color:var(--primary-dark);outline:none}'
    + '.size-mode-select option{color:var(--text)}'
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
    + '.tag.group{background:#eee9f7;color:#75638f}'
    + '.card-tagged-at{font-size:10px;color:var(--text-light);margin-top:4px;font-family:monospace}'
    + '.card-actions{display:flex;gap:4px;margin-top:6px;flex-wrap:wrap}'
    + '.card-actions button{font-size:11px;padding:3px 8px;border:1px solid var(--border);border-radius:3px;background:transparent;cursor:pointer;color:var(--text-muted);font-family:inherit;transition:all .15s}'
    + '.card-actions .edit-btn:hover{background:var(--primary-light);color:var(--primary);border-color:var(--primary)}'
    + '.card-actions .retag-btn:hover{background:#f5f0e8;color:#9d7b53;border-color:#c9b88a}'
    + '.card-actions .ball-pin-btn.active{background:var(--primary-light);color:var(--primary-dark);border-color:var(--primary)}'
    + '.card-actions .ball-pin-btn:hover{background:var(--primary-light);color:var(--primary-dark);border-color:var(--primary)}'
    + '.card-actions .delete-btn{color:var(--danger)}'
    + '.card-actions .delete-btn:hover{background:var(--danger-light);border-color:var(--danger)}'
    + '.card-actions .group-btn:hover{background:#eee9f7;color:#75638f;border-color:#b9a9cf}'
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
    + '/* v0.33.77 - 偏好设置行（图片尺寸档位） */'
    + '.pref-row{display:flex;align-items:center}'
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
    + '.pref-del{border:1px solid transparent;background:transparent;color:var(--danger);font-size:10px;cursor:pointer;padding:0 3px;line-height:1.4;border-radius:3px;opacity:.6;font-family:inherit}'
    + '.pref-del:hover{opacity:1;background:var(--danger-light);border-color:#e6b8b0}'
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
    // v0.34.30 - 旧「频率卡片 + 独立分组块」的样式已由 .agent-card / .freq-pill / .agent-lib-note 取代
    + '.group-check{display:inline-flex;align-items:center;gap:5px;padding:5px 8px;border:1px solid var(--border);border-radius:999px;background:var(--surface);font-size:11px;color:var(--text-muted);cursor:pointer;user-select:none;transition:all .15s}'
    + '.group-check:hover{border-color:var(--primary);color:var(--primary-dark)}'
    + '.group-check input{width:14px;height:14px;margin:0;accent-color:var(--primary);cursor:pointer}'
    + '.group-check.is-favorite{border-color:#d8a3b4;background:var(--accent-light);color:#a85b72}'
    + '.group-check.is-ungrouped{border-style:dashed}'
    + '.group-favorite-btn{margin-left:2px;padding:2px 7px;border:1px solid transparent;background:transparent;color:var(--text-light);border-radius:999px;cursor:pointer;font-size:10.5px;line-height:1.5;font-family:inherit;flex:none;transition:all .15s}'
    + '.group-favorite-btn:hover:not(:disabled){color:#c47b91;background:var(--accent-light);border-color:#e4b2c1}'
    + '.group-favorite-btn.is-on{color:#a85b72;background:var(--accent-light);border-color:#e4b2c1;font-weight:600}'
    + '.group-favorite-btn:disabled{opacity:.35;cursor:not-allowed}'
    + '.group-picker-list{display:flex;flex-direction:column;gap:8px;max-height:280px;overflow:auto;padding:2px}'
    + '.group-picker-row{display:flex;align-items:center;gap:8px;padding:8px 10px;border:1px solid var(--border-light);border-radius:var(--radius-sm);background:var(--surface-alt);font-size:13px}'
    + '.group-picker-row input{width:15px;height:15px;accent-color:var(--primary)}'
    + '.group-picker-row small{margin-left:auto;color:var(--text-light);font-size:11px}'
    + '.group-manager-row{display:flex;align-items:center;gap:8px;padding:10px 12px;border:1px solid var(--border-light);border-radius:10px;background:#fff;cursor:pointer;transition:border-color .15s,box-shadow .15s}'
    + '.group-manager-row:hover{border-color:var(--primary);box-shadow:0 2px 8px rgba(93,174,142,.12)}'
    + '.group-manager-row:focus-visible{outline:2px solid var(--primary);outline-offset:2px}'
    + '.group-manager-row .group-manager-name{flex:1;font-size:13.5px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}'
    + '.group-manager-row .group-manager-count{font-size:11.5px;color:var(--text-light);white-space:nowrap}'
    + '.group-manager-row .group-manager-arrow{color:var(--primary);font-size:15px;flex:none}'
    + '.group-manager-row .group-manager-naming{font-size:10px;color:var(--primary-dark);background:var(--primary-light);border-radius:99px;padding:1px 7px;flex:none;white-space:nowrap}'
    + '.group-manager-meta{display:flex;align-items:center;gap:5px;min-width:0;flex:1}'
    + '.group-detail-meta{font-size:12px;color:var(--text-muted);margin-bottom:10px}'
    + '.group-naming-card{border:1px solid var(--border-light);border-radius:12px;padding:12px;background:#fffdf9}'
    + '.group-naming-head{display:flex;align-items:center;gap:8px}'
    + '.group-naming-title{font-size:13.5px;font-weight:600;flex:1}'
    + '.group-naming-hint{font-size:11.5px;color:var(--text-muted);margin-top:8px;line-height:1.7}'
    + '.group-naming-status{font-size:11.5px;color:var(--primary-dark);margin-top:8px}'
    + '.group-naming-status:empty{display:none}'
    + '.group-detail-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(86px,1fr));gap:8px;margin-top:12px}'
    + '.group-detail-grid .gd-item{border:1px solid var(--border-light);border-radius:10px;overflow:hidden;background:var(--surface-alt);position:relative}'
    + '.group-detail-grid .gd-item img{display:block;width:100%;aspect-ratio:1/1;object-fit:cover;background:#f2efe9}'
    + '.group-detail-grid .gd-remove{position:absolute;top:4px;right:4px;width:22px;height:22px;border:none;border-radius:50%;background:rgba(70,60,55,.55);color:#fff;font-size:13px;line-height:1;cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0;font-family:inherit;opacity:.85}'
    + '.group-detail-grid .gd-remove:hover{background:var(--danger);opacity:1}'
    + '.group-detail-grid .gd-remove:focus-visible{opacity:1;outline:2px solid var(--primary);outline-offset:1px}'
    + '.group-detail-grid .gd-desc{padding:4px 6px;font-size:10px;color:var(--text-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}'
    + '.hb-switch{position:relative;display:inline-flex;align-items:center;cursor:pointer;flex:none}'
    + '.hb-switch input{position:absolute;opacity:0;width:0;height:0}'
    + '.hb-switch-track{width:44px;height:24px;border-radius:99px;background:#d8d2c8;transition:background .18s;position:relative;display:inline-block}'
    + '.hb-switch-track::after{content:"";position:absolute;top:2px;left:2px;width:20px;height:20px;border-radius:50%;background:#fff;transition:transform .18s;box-shadow:0 1px 3px rgba(0,0,0,.16)}'
    + '.hb-switch input:checked+.hb-switch-track{background:var(--primary)}'
    + '.hb-switch input:checked+.hb-switch-track::after{transform:translateX(20px)}'
    + '.hb-switch input:focus-visible+.hb-switch-track{outline:2px solid var(--primary);outline-offset:2px}'
    + '.hb-switch input:disabled+.hb-switch-track{opacity:.5}'
    // v0.34.36 - 分组弹窗的两层视图（列表/详情）各自撑满弹窗并成为滚动容器。
    // 之前 pane 没有 flex / min-height 约束，里面的网格一多就把弹窗撑爆、被外层 overflow:hidden 裁掉，
    // 所以分组详情里的图片列表滚不动（外层看不见，内层又没有可滚空间）。
    + '#group-manager-modal .modal-box > #group-manager-pane:not([hidden]),'
    + '#group-manager-modal .modal-box > #group-detail-pane:not([hidden]){display:flex;flex-direction:column;flex:1;min-height:0}'
    // pane 撑满后滚动统一交给 modal-body，列表自己的 280px 内滚就不再需要了
    + '#group-manager-modal .group-picker-list{max-height:none}'
    + '#group-manager-modal .group-detail-head{display:flex;align-items:center;gap:8px;justify-content:flex-start}'
    + '#group-manager-modal .group-detail-head h2{margin:0;flex:1}'
    + '.modal-back{border:none;background:transparent;color:var(--text-muted);font-size:16px;cursor:pointer;padding:2px 8px;border-radius:6px;font-family:inherit;flex:none}'
    + '.modal-back:hover{background:var(--surface-alt);color:var(--primary-dark)}'
    + '.group-detail-delete{color:var(--danger)}'
    + '.agent-card-list{display:flex;flex-direction:column;gap:12px}'
    + '.agent-card{border:1px solid var(--border-light);border-radius:14px;background:#fff;padding:12px 14px}'
    + '.agent-card-head{display:flex;align-items:center;gap:8px;margin-bottom:10px}'
    + '.agent-card-name{font-size:14px;font-weight:600}'
    + '.agent-card-id{font-size:10px;color:var(--text-light)}'
    + '.agent-card-remove{margin-left:auto;flex:none;border:1px solid var(--border-light);background:transparent;color:var(--text-light);font-size:11px;line-height:1;cursor:pointer;padding:4px 9px;border-radius:999px;font-family:inherit;transition:border-color .15s,color .15s,background .15s}'
    + '.agent-card-remove:hover{border-color:#efc9c2;background:var(--danger-light, rgba(231,111,81,.1));color:var(--danger, #c9593c)}'
    + '.agent-card-remove:focus-visible{outline:2px solid var(--primary);outline-offset:2px}'
    + '.freq-line{display:flex;align-items:center;gap:6px;margin-bottom:6px}'
    + '.freq-line-label{width:30px;flex:none;font-size:11.5px;color:var(--text-muted)}'
    + '.freq-pill{border:1px solid var(--border-light);background:#fff;color:var(--text-muted);border-radius:99px;padding:3px 11px;font-size:11.5px;cursor:pointer;font-family:inherit;white-space:nowrap;transition:border-color .15s,background .15s,color .15s}'
    + '.freq-pill:hover{border-color:var(--primary)}'
    + '.freq-pill.is-active{border-color:var(--primary);background:var(--primary-light);color:var(--primary-dark);font-weight:600}'
    + '.freq-pill:focus-visible{outline:2px solid var(--primary);outline-offset:2px}'
    + '.freq-pill:disabled{opacity:.45;cursor:not-allowed}'
    + '.agent-card-foot{display:flex;align-items:center;gap:8px;margin-top:10px;padding-top:10px;border-top:1px dashed var(--border-light)}'
    + '.agent-card-lib{font-size:11.5px;color:var(--text-muted);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}'
    + '.agent-card-config{border:1px solid var(--border);background:transparent;color:var(--text-muted);border-radius:8px;padding:4px 11px;font-size:11.5px;cursor:pointer;font-family:inherit;white-space:nowrap;flex:none}'
    + '.agent-card-config:hover{border-color:var(--primary);color:var(--primary-dark)}'
    + '.agent-card-config:focus-visible{outline:2px solid var(--primary);outline-offset:2px}'
    + '.agent-lib-note{margin-top:10px;padding:8px 10px;border:1px solid var(--border-light);border-radius:9px;background:var(--primary-light);color:var(--text-muted);font-size:11.5px;line-height:1.6}'
    + '.group-picker-list.is-locked{opacity:.5}'
    + '.agent-hidden-row{display:flex;align-items:center;gap:10px;padding:9px 11px;border:1px solid var(--border-light);border-radius:var(--radius-sm);background:var(--surface-alt);font-size:13px}'
    + '.agent-hidden-row span{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}'
    + '.agent-hidden-row button{border:1px solid var(--border);background:transparent;color:var(--text-muted);border-radius:999px;padding:3px 11px;font-size:11.5px;cursor:pointer;font-family:inherit;white-space:nowrap;flex:none;transition:all .15s}'
    + '.agent-hidden-row button:hover:not(:disabled){border-color:var(--primary);color:var(--primary-dark);background:var(--primary-light)}'
    + '.agent-hidden-row button:disabled{opacity:.5;cursor:not-allowed}'
    + '.badge-btn[hidden]{display:none}'
    + '.group-undo-bar{display:flex;align-items:center;gap:8px;padding:8px 10px;border:1px solid #e4c7a6;border-radius:var(--radius-sm);background:#fff8ed;color:#806344;font-size:11px;line-height:1.5;margin:8px 0}'
    + '.group-undo-bar span{flex:1;min-width:0}'
    + '.group-undo-bar button{padding:4px 8px;border:1px solid #d7b98d;border-radius:5px;background:var(--surface);color:#806344;font-size:11px;cursor:pointer;font-family:inherit;white-space:nowrap}'
    + '.group-undo-bar button:hover{border-color:#b88d59;background:#fff3df}'
    + '.group-recognition-note{font-size:11px;color:var(--text-light);line-height:1.6;margin-top:4px}'
    + '.export-scope{padding:10px 12px;border:1px solid var(--border-light);border-radius:var(--radius-sm);background:var(--surface-alt);margin-top:10px}'
    + '.export-scope-options{display:flex;gap:12px;flex-wrap:wrap;font-size:12px;color:var(--text-muted)}'
    + '.export-scope-options label{display:inline-flex;align-items:center;gap:5px;cursor:pointer}'
    + '.export-scope-options input{accent-color:var(--primary)}'
    + '.export-group-picker{display:flex;flex-wrap:wrap;gap:6px;margin-top:9px}'
    + '.export-group-picker label{display:inline-flex;align-items:center;gap:4px;padding:4px 8px;border:1px solid var(--border);border-radius:999px;background:var(--surface);font-size:11px;color:var(--text-muted);cursor:pointer}'
    + '.export-group-picker label:hover{border-color:var(--primary);color:var(--primary-dark)}'
    + '.export-group-picker input{accent-color:var(--primary)}'
    // v0.20.0 方言口音 / v0.23.0 单控件选择器（选即开、选(不选)即关）
    + '.dialect-desc{font-size:12px;color:var(--text-muted);line-height:1.8;margin-bottom:14px}'
    + '.dialect-item{padding:14px;border:1px dashed var(--border);border-radius:var(--radius);background:var(--surface-alt)}'
    + '.dialect-item.is-off{opacity:.85}'
    + '.dialect-head{display:flex;align-items:center;gap:8px;margin-bottom:10px}'
    + '.dialect-name{font-size:13px;font-weight:600;color:var(--text);flex:1}'
    + '.dialect-id{font-size:10px;color:var(--text-light);font-family:monospace}'
    // 选择器 pill：未选为 dashed 灰，已选为实线薄荷绿
    + '.dialect-picker{position:relative}'
    + '.dialect-picker-btn{display:inline-flex;align-items:center;gap:6px;padding:6px 12px;min-width:88px;border:1px dashed var(--border);border-radius:14px;background:var(--surface);color:var(--text-muted);font-size:12px;font-family:inherit;cursor:pointer;transition:all .15s;max-width:230px}'
    + '.dialect-picker-btn:hover{border-color:var(--primary);color:var(--primary)}'
    + '.dialect-picker-btn.is-on{border-style:solid;border-color:var(--primary);background:var(--primary-light);color:var(--primary-dark)}'
    + '.dialect-picker-label{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:left}'
    + '.dialect-picker-arrow{font-size:10px;opacity:.7;transition:transform .15s}'
    + '.dialect-picker.open .dialect-picker-arrow{transform:rotate(180deg)}'
    // 下拉面板：与整体卡片风格统一（圆角、柔和阴影、dashed hover）
    + '.dialect-picker-menu{position:absolute;top:calc(100% + 6px);right:0;z-index:30;min-width:184px;background:var(--surface);border:1px solid var(--border);border-radius:12px;box-shadow:0 6px 24px rgba(45,58,53,.12);padding:6px;display:flex;flex-direction:column;gap:2px}'
    + '.dialect-picker-menu button{display:flex;align-items:center;gap:10px;padding:7px 10px;border:none;border-radius:8px;background:transparent;color:var(--text);font-size:12px;font-family:inherit;cursor:pointer;text-align:left;transition:background .12s;width:100%}'
    + '.dialect-picker-menu button:hover{background:var(--primary-light)}'
    + '.dialect-picker-menu button.is-current{color:var(--primary-dark);font-weight:600}'
    + '.dialect-picker-menu button.is-current::before{content:"✓ ";font-size:11px}'
    + '.dialect-picker-menu button.is-none{color:var(--text-muted)}'
    + '.dialect-picker-note{font-size:10px;color:var(--text-light);font-weight:400;margin-left:auto}'
    + '.dialect-boost-toggle{display:inline-flex;align-items:center;justify-content:center;gap:4px;margin-right:4px;padding:4px 7px;width:88px;border:1px solid var(--border);border-radius:999px;background:var(--surface);cursor:pointer;user-select:none;flex-shrink:0;font-family:inherit;transition:border-color .15s,background .15s}'
    + '.dialect-boost-toggle:hover:not(:disabled){border-color:var(--primary)}'
    + '.dialect-boost-toggle.is-on{border-color:var(--primary);background:var(--primary-light)}'
    + '.dialect-boost-toggle:disabled{cursor:not-allowed;opacity:.45}'
    + '.dialect-boost-track{width:26px;height:17px;border-radius:999px;background:var(--border);position:relative;flex-shrink:0;transition:background .2s}'
    + '.dialect-boost-knob{position:absolute;top:2px;left:2px;width:13px;height:13px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.18);transition:left .2s}'
    + '.dialect-boost-toggle.is-on .dialect-boost-track{background:var(--primary)}'
    + '.dialect-boost-toggle.is-on .dialect-boost-knob{left:11px}'
    + '.dialect-boost-label{font-size:11px;color:var(--text-muted);white-space:nowrap;transition:color .15s}'
    + '.dialect-boost-toggle.is-on .dialect-boost-label{color:var(--primary-dark);font-weight:600}'
    + '.dialect-boost-tip{font-size:10px;color:var(--text-light);white-space:nowrap;line-height:1.4}'
    + '.dialect-preview{font-size:11px;color:var(--text-light);margin-top:8px;line-height:1.6;font-style:italic}'
    + '#save-dialect-btn:disabled{cursor:not-allowed}'
    + '.dialect-save-bar{position:sticky;bottom:10px;z-index:12;display:flex;align-items:center;gap:12px;padding:10px 12px;border:1px solid var(--border);border-radius:var(--radius);background:rgba(250,253,251,.96);box-shadow:0 -2px 12px rgba(45,58,53,.08)}'
    + '.dialect-save-status{flex:1;font-size:12px;color:var(--text-muted)}'
    + '.dialect-save-status.is-dirty{color:var(--accent);font-weight:600}'
    + '.dialect-save-bar .btn{width:auto}'
    + '.dialect-badge{display:inline-block;padding:1px 8px;border-radius:10px;background:var(--primary-light);color:var(--primary-dark);font-size:11px;font-weight:500}'
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
    + '.export-dir-row{display:flex;align-items:center;gap:8px}'
    + '.export-dir-row input{flex:1;min-width:0}'
    + '.export-dir-row .btn{white-space:nowrap}'
    + '.export-dir-note{font-size:11px;line-height:1.65;color:var(--text-muted);margin-top:8px;padding:8px 10px;background:var(--primary-light);border-radius:var(--radius-sm)}'
    + '.export-dir-note.is-gallery-only{color:var(--primary-dark);background:var(--primary-light);font-weight:600}'
    // 导出内容勾选（v0.34.17+：只导图库 vs 搬家包）
    + '.export-content-title{font-size:12px;font-weight:600;color:var(--text);margin-bottom:8px}'
    + '.export-check{display:flex;align-items:flex-start;gap:8px;padding:7px 8px;border-radius:var(--radius-sm);cursor:pointer;transition:background .15s}'
    + '.export-check:hover{background:rgba(93,174,142,.08)}'
    + '.export-check input{width:auto;margin:2px 0 0 0;accent-color:var(--primary);flex-shrink:0;cursor:pointer}'
    + '.export-check-name{font-size:13px;color:var(--text);font-weight:500}'
    + '.export-check-desc{font-size:11px;color:var(--text-muted);line-height:1.55}'
    + '.export-check-all{cursor:pointer;display:flex;align-items:center;gap:6px;font-size:12px;color:var(--text-muted);margin-bottom:4px;padding:2px 8px;border-radius:var(--radius-sm);user-select:none;transition:color .15s}'
    + '.export-check-all:hover{color:var(--primary-dark)}'
    + '.export-check-all input{width:auto;margin:0;accent-color:var(--primary);cursor:pointer}'
    + '.modal-box.fixed-modal-box{max-height:84vh;display:flex;flex-direction:column;overflow:hidden;padding:0}'
    + '.modal-head{position:relative;flex-shrink:0;padding:22px 24px 14px;border-bottom:1px solid var(--border-light)}'
    + '.modal-head h2{margin:0;padding-right:40px}'
    + '.modal-body{min-height:0;overflow-y:auto;padding:20px 24px}'
    + '.modal-foot{flex-shrink:0;padding:14px 24px 18px;border-top:1px solid var(--border-light);background:var(--surface)}'
    + '.modal-foot .modal-actions{margin-top:0}'
    + '.import-section{padding:16px;border:1px dashed var(--border);border-radius:var(--radius);background:var(--surface-alt);margin-bottom:14px}'
    + '.import-section:last-of-type{margin-bottom:0}'
    + '.export-section{padding:16px;border:1px solid var(--border);border-radius:var(--radius);background:var(--surface-alt);margin-bottom:14px}'
    + '.export-section-title{font-size:14px;font-weight:600;color:var(--text);margin-bottom:4px}'
    + '.import-section-title{font-size:14px;font-weight:600;color:var(--text);margin-bottom:4px}'
    + '.import-section-desc{font-size:11px;line-height:1.6;color:var(--text-muted);margin-bottom:10px}'
    + '.upload-pick-row{display:flex;flex-wrap:wrap;gap:8px}'
    + '.upload-pick-row .btn{flex:1 1 30%;min-width:88px;padding:8px 10px;text-align:center}'
    + '.paste-zone{border:2px dashed var(--primary);border-radius:var(--radius);background:var(--primary-light);padding:14px 12px;text-align:center;cursor:pointer;margin-bottom:10px;transition:all .15s;outline:none}'
    + '.paste-zone:hover,.paste-zone:focus{border-color:var(--primary-dark);background:rgba(93,174,142,.18)}'
    + '.paste-zone-title{font-size:13px;color:var(--primary-dark);font-weight:600;margin-bottom:4px}'
    + '.paste-zone-sub{font-size:11px;color:var(--text-muted);line-height:1.5}'
    + '.paste-zone.active{border-style:solid;border-color:var(--success);background:var(--surface-alt)}'
    + '.paste-zone.active .paste-zone-title{color:var(--success)}'
    + '.paste-zone img{max-width:100%;max-height:150px;border-radius:8px;border:2px solid #fff;box-shadow:0 2px 8px rgba(0,0,0,.12);margin-bottom:8px;display:block;margin-left:auto;margin-right:auto;background:#fff}'
    + '.batch-backdrop-tip{font-size:11px;color:var(--text-muted);background:var(--surface-alt);border:1px dashed var(--border);border-radius:var(--radius-sm);padding:8px 12px;margin-bottom:10px;line-height:1.6}'
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
    // v0.25.1 - 进度视图：正在处理的缩略图 + 结果网格
    + '.batch-current-thumbs{display:flex;gap:8px;justify-content:center;flex-wrap:wrap;padding:12px 0 6px}'
    + '.batch-current-thumbs img{width:64px;height:64px;object-fit:cover;border-radius:8px;border:2px solid var(--primary);box-shadow:0 0 0 3px var(--primary-light)}'
    + '.batch-progress-tip{text-align:center;color:var(--text-muted);padding:24px;font-size:12px}'
    + '.batch-result-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(108px,1fr));gap:10px}'
    + '@media (max-width:360px){.batch-result-grid{grid-template-columns:repeat(2,1fr);gap:8px}.batch-grid-item{padding:6px}.batch-grid-item img{height:72px}}'
    + '.batch-grid-item{background:var(--surface-alt);border:1px solid var(--border-light);border-radius:var(--radius-sm);padding:8px;display:flex;flex-direction:column;gap:6px;min-width:0}'
    + '.batch-grid-item img{width:100%;height:84px;object-fit:cover;border-radius:4px;border:1px solid var(--border);background:#fff}'
    + '.bgi-desc{font-size:11px;color:var(--text);line-height:1.4;overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}'
    + '.bgi-tags{display:flex;flex-wrap:wrap;gap:3px}'
    + '.bgi-tags span{font-size:10px;background:var(--primary-light);color:var(--primary-dark);padding:1px 6px;border-radius:8px}'
    + '.bgi-actions{display:flex;gap:4px;margin-top:auto}'
    + '.bgi-actions button{flex:1;font-size:11px;padding:3px 0;border:1px solid var(--border);border-radius:3px;background:var(--surface);cursor:pointer;color:var(--text);font-family:inherit}'
    + '.bgi-actions button.apply{color:var(--success);border-color:var(--success)}'
    + '.bgi-status{font-size:10px;text-align:center;color:var(--success)}'
    + '.bgi-status.pending{color:var(--primary)}'
    + '.bgi-err{font-size:10px;color:var(--danger);line-height:1.4;overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}'
    + '.bgi-edit{display:flex;flex-direction:column;gap:4px;border-top:1px dashed var(--border);padding-top:6px;margin-top:2px}'
    + '.bgi-edit input{font-size:11px;padding:3px 6px;border:1px solid var(--border);border-radius:3px;background:var(--surface);color:var(--text);width:100%;box-sizing:border-box;font-family:inherit}'
    + '.bgi-edit-actions{display:flex;gap:4px}'
    + '.bgi-edit-actions button{flex:1;font-size:11px;padding:3px 0;border:1px solid var(--border);border-radius:3px;background:var(--surface);cursor:pointer;color:var(--text);font-family:inherit}'
    + '#batch-modal{pointer-events:none}'
    + '#batch-modal .modal-box{pointer-events:auto}'
    // 角标
    + '.badge-btn{font-size:12px;padding:4px 12px;border:1px solid var(--primary);border-radius:14px;background:var(--primary-light);color:var(--primary-dark);cursor:pointer;font-family:inherit;display:inline-flex;align-items:center;gap:4px;transition:all .15s}'
    + '.badge-btn:hover{background:rgba(93,174,142,.15)}'
    // v0.34.37 - 「待应用」角标做成告警态：识别结果没写进图库时一直脉动提醒，点一下去保存
    + '.badge-btn.is-alert{border-color:#d6772d;background:#fdf1e6;color:#a4591b;font-weight:600;animation:badgePulse 1.8s ease-in-out infinite}'
    + '@keyframes badgePulse{0%,100%{box-shadow:0 0 0 0 rgba(214,119,45,.32)}50%{box-shadow:0 0 0 7px rgba(214,119,45,0)}}'
    + '.semantic-index-btn.is-pending{border-color:var(--accent);background:rgba(232,155,176,.18);color:var(--accent);box-shadow:0 0 0 3px rgba(232,155,176,.12)}'
    // 偏好页反馈按钮组
    + '.pref-feedback-group{display:flex;gap:4px;flex-shrink:0;align-items:center}'
    + '.pref-feedback-btn{padding:3px 9px;font-size:12px;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--surface);cursor:pointer;color:var(--text-muted);font-family:inherit;line-height:1.4;transition:all .15s;flex-shrink:0}'
    + '.pref-feedback-btn:hover{background:var(--surface-alt);border-color:var(--primary)}'
    + '.pref-feedback-btn[data-fb=positive]:hover{background:#5dae8e;color:#fff;border-color:#5dae8e}'
    + '.pref-feedback-btn[data-fb=negative]:hover{background:#e89bb0;color:#fff;border-color:#e89bb0}'
    // v0.19.5 - 已反馈选中态：持久显示，重启后仍在（颜色与消息卡片按钮统一）
    + '.pref-feedback-btn.active[data-fb=positive]{background:#5dae8e;color:#fff;border-color:#5dae8e;box-shadow:0 0 0 2px rgba(93,174,142,.18)}'
    + '.pref-feedback-btn.active[data-fb=negative]{background:#e89bb0;color:#fff;border-color:#e89bb0;box-shadow:0 0 0 2px rgba(232,155,176,.18)}'
    + '.pref-feedback-btn.active{opacity:1;cursor:default}'
    + '.pref-chat-btn{font-weight:500;margin-left:10px;color:var(--accent);border-color:rgba(232,155,176,.55)}'
    + '.pref-chat-btn:hover{background:var(--accent-light);border-color:var(--accent);color:var(--accent)}'
    + '.pref-del-btn{color:var(--danger);border-color:#e6b8b0}'
    + '.pref-del-btn:hover{background:var(--danger);color:#fff;border-color:var(--danger)}'
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
    // 响应式：首页横屏优先，窄屏时减列减量、主区堆叠
    + '@media(max-width:1400px){'
    + '.hero-strip figure:nth-child(n+25){display:none}'
    + '}'
    + '@media(max-width:820px){'
    + '.hero-strip{grid-template-columns:repeat(auto-fill,minmax(96px,1fr))}'
    + '.hero-strip figure:nth-child(n+17){display:none}'
    + '}'
    + '@media(max-width:640px){'
    + '#view-home{padding:16px;height:auto;min-height:auto}'
    + '.home-main{grid-template-columns:1fr;flex:none;min-height:0}'
    + '.hero-strip{grid-template-columns:repeat(auto-fill,minmax(76px,1fr))}'
    + '.hero-strip figure:nth-child(n+13){display:none}'
    + '.home-entry{flex-direction:row;align-items:center;justify-content:flex-start;text-align:left;gap:12px;padding:0 16px}'
    + '.home-entry .entry-text{flex:1;width:auto}'
    + '.home-entry .entry-arrow{position:static;font-size:15px}'
    + '.view{padding:16px}'
    + '#sticker-grid{grid-template-columns:repeat(auto-fill,minmax(140px,1fr))}'
    + '.modal-box{width:100vw;max-width:100vw;border-radius:0}'
    + '}'
    + '</style></head><body>'

    // ═══════════════════════════════════
    //  视图 1：首页
    // ═══════════════════════════════════
    + '<div class="view" id="view-home">'
    // v0.34.18 - 首页横屏布局：顶栏（标题 + 设置菜单）→ 状态条（开关 + 模型状态）→ 主区（左库右入口）→ 底部提示
    + '<div class="home-top">'
    + '<h1>表情包</h1>'
    + '<span class="count" id="home-count">加载中</span>'
    + '<span class="spacer"></span>'
    + '<div class="home-menu-wrap">'
    + '<button class="home-text-btn" id="btn-settings" type="button" aria-haspopup="true" aria-expanded="false" title="检查更新 · 反馈 · 模型设置 · 数据与迁移">'
    + '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9c.14.63.7 1.09 1.51 1H21a2 2 0 0 1 0 4h-.09c-.81 0-1.37.46-1.51 1z"></path></svg>'
    + '设置</button>'
    + '<div class="home-menu" id="home-menu" hidden>'
    + '<button class="home-menu-item" id="btn-check-update" type="button">检查更新</button>'
    + '<button class="home-menu-item" id="btn-feedback" type="button">反馈</button>'
    + '<button class="home-menu-item" id="btn-model-settings" type="button">模型设置</button>'
    + '<button class="home-menu-item" id="btn-data-migration" type="button">数据与迁移</button>'
    + '</div>'
    + '</div>'
    + '</div>'
    + '<div class="home-status">'
    + '<button class="ball-toggle-wrap auto-image-toggle-wrap" id="auto-image-toggle-top" type="button" title="关闭自动情绪检测和自动配图；不影响方言、识图和纸飞机" aria-label="自动配图开关" aria-pressed="true">'
    + '<span class="ball-toggle-label">自动配图</span><span class="ball-toggle-switch"><span class="ball-toggle-thumb"></span></span></button>'
    + '<span class="ball-status-top auto-image-status" id="auto-image-status" role="status">读取中…</span>'
    + '<span class="status-divider"></span>'
    + '<button class="ball-toggle-wrap" id="ball-toggle-top" type="button" title="开关桌面纸飞机悬浮球；右键可关闭" aria-label="纸飞机悬浮球开关" aria-pressed="false">'
    + '<span class="ball-toggle-label">悬浮球</span><span class="ball-toggle-switch"><span class="ball-toggle-thumb"></span></span></button>'
    + '<span class="ball-status-top" id="ball-status-top" role="status">未开启</span>'
    + '<span class="spacer"></span>'
    + '<div class="model-state">'
    + '<span class="model-state-label">模型</span>'
    + '<span class="model-guide-item" id="guide-vision">识图 · 待检查</span>'
    + '<span class="model-guide-item" id="guide-text">内容 · 待检查</span>'
    + '<span class="model-guide-item" id="guide-embedding">向量 · 待检查</span>'
    + '<button class="model-guide-btn" id="guide-settings-btn" type="button">去配置</button>'
    + '</div>'
    + '</div>'
    + '<div class="home-main">'
    + '<div class="home-hero" id="home-hero" data-goto="library" role="button" tabindex="0" aria-label="进入表情包库">'
    + '<div class="hero-head"><h2>表情包库</h2><span class="spacer"></span><span class="hero-go">进入 →</span></div>'
    + '<div class="section-label">最近入库</div>'
    + '<div class="hero-strip" id="home-strip"></div>'
    + '<div class="hero-foot" id="home-stats"><span>加载中…</span></div>'
    + '</div>'
    + '<div class="home-entries">'
    + '<div class="home-entry" data-action="upload" role="button" tabindex="0">'
    + '<span class="entry-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg></span>'
    + '<span class="entry-text"><b>添加入库</b><span>上传新表情包，自动识别打标签</span></span>'
    + '<span class="entry-arrow">→</span>'
    + '</div>'
    + '<div class="home-entry" data-goto="preferences" role="button" tabindex="0">'
    + '<span class="entry-icon is-pink"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8l1.1 1L12 21.2l7.7-7.8 1.1-1a5.5 5.5 0 0 0 0-7.8z"></path></svg></span>'
    + '<span class="entry-text"><b>偏好设置</b><span>配图偏好与反馈记录</span></span>'
    + '<span class="entry-arrow">→</span>'
    + '</div>'
    + '<div class="home-entry" data-goto="agent-freq" role="button" tabindex="0">'
    + '<span class="entry-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"></circle><polyline points="12 7 12 12 15.5 14"></polyline></svg></span>'
    + '<span class="entry-text"><b>伙伴配图设置</b><span>每位伙伴的配图频率和可用图库，一处调好</span></span>'
    + '<span class="entry-arrow">→</span>'
    + '</div>'
    + '<div class="home-entry" data-goto="dialect" role="button" tabindex="0">'
    + '<span class="entry-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8v.5z"></path></svg></span>'
    + '<span class="entry-text"><b>方言口音</b><span>让伙伴说话带点家乡味</span></span>'
    + '<span class="entry-arrow">→</span>'
    + '</div>'
    + '</div>'
    + '</div>' // end home-main
    + '<button type="button" class="home-preference-tip" data-goto="preferences" aria-label="配图不太对？进入偏好设置调整">'
    + '<span class="preference-tip-icon" aria-hidden="true">💡</span>'
    + '<span class="preference-tip-copy"><strong>配图不太对？</strong><span>进入「偏好设置」，点击「聊聊」告诉小花，她会陪你一起调整。</span></span>'
    + '<span class="preference-tip-action">去调整 →</span>'
    + '</button>'
    + '</div>' // end view-home

    // ═══════════════════════════════════
    //  视图 2：数据与迁移（v0.33.77 一键搬家）
    // ═══════════════════════════════════
    + '<div class="view hidden" id="view-data-migration">'
    + '<div class="sub-header">'
    + '<button class="back-btn" data-goto="home">← 返回</button>'
    + '<h2>数据与迁移</h2>'
    + '</div>'
    + '<div class="migration-panel">'
    + '<div class="migration-card">'
    + '<h3>📦 一键搬家包</h3>'
    + '<p>把这个插件带到另一台电脑或另一套 Hana：图片、名称、描述、标签、图库分组、偏好、教学记录、应景记录、学我说话资料，以及方言/频率/悬浮球等可迁移设置会一起打包。导入时会按图片哈希重新建立新 ID，已有同图也会正确接上原来的关联。</p>'
    + '<div class="migration-actions">'
    + '<button type="button" class="btn btn-primary" id="data-migration-export-btn">导出一键搬家包</button>'
    + '<input type="file" id="data-migration-import-file" accept=".zip,application/zip" style="display:none">'
    + '<button type="button" class="btn btn-secondary" id="data-migration-import-btn">导入一键搬家包</button>'
    + '</div>'
    + '<div class="migration-status" id="data-migration-status" role="status">导出会打开保存位置设置；导入前会先检查 ZIP，普通旧 ZIP 也仍然可以从「添加入库」导入。</div>'
    + '<div class="migration-security">'
    + '<div>✓ 会带走：图片、图库分组与用户自己调过的内容</div>'
    + '<div>✓ 会重建：图片 ID、教学向量（按当前模型）</div>'
    + '<div>× 不会带走：API Key、模型配置、聊天会话</div>'
    + '<div>× 不会带走：日志、批量任务、机器路径和运行状态</div>'
    + '</div>'
    + '</div>'
    + '</div>'
    + '</div>'

    // ═══════════════════════════════════
    //  视图 3：表情包库
    // ═══════════════════════════════════
    + '<div class="view hidden" id="view-library">'
    + '<div class="library-controls">'
    + '<div class="sub-header">'
    + '<button class="back-btn" data-goto="home">← 返回</button>'
    + '<h2>表情包库</h2>'
    + '<span class="count" id="sticker-count">0 张</span>'
    + '<span class="spacer"></span>'
    + '<button class="badge-btn semantic-index-btn" id="embedding-index-btn" title="给有语义描述但还没有索引的图片建立语义索引">图库语义索引</button>'
    + '<button class="badge-btn" id="batch-tasks-badge" title="批量识图任务" hidden>批量识图任务</button>'
    + '<button class="back-btn" id="btn-group-manager">分组管理</button>'
    + '<button class="back-btn" id="btnToggleMulti">多选</button>'
    + '</div>'
    + '<div class="filter-bar">'
    + '<select id="filter-emotion"><option value="">全部情绪</option><option value="开心">开心</option><option value="搞笑">搞笑</option><option value="鼓励">鼓励</option><option value="感谢">感谢</option><option value="难过">难过</option><option value="无语">无语</option><option value="可爱">可爱</option><option value="嘲讽">嘲讽</option><option value="治愈">治愈</option></select>'
    + '<select id="filter-group"><option value="">全部分组</option><option value="__ungrouped__">未分组</option></select>'
    + '<input type="text" id="filter-search" placeholder="搜索描述 / 关键词 / 分组...">'
    + '</div>'
    + '<div id="batch-toolbar" class="batch-toolbar" hidden>'
    + '<span class="batch-info">已选 <b id="batch-count">0</b> 张</span>'
    + '<button class="batch-btn" id="batch-select-all">全选当前</button>'
    + '<button class="batch-btn" id="batch-select-untagged" title="选中整个图库里所有尚未 AI 识图的图片">选中全部未识图</button>'
    + '<button class="batch-btn" id="batch-clear">清空</button>'
    + '<span style="flex:1"></span>'
    + '<button class="batch-btn batch-btn-primary" id="batch-auto-tag">AI 批量识图</button>'
    + '<button class="batch-btn" id="batch-groups">加入分组</button>'
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

    // v0.28.0 - 配图卡片反馈按钮显示开关（聊天里表情包卡片下方喜欢/不喜欢）
    + '<div class="pref-section">'
    + '<h3>🃏 配图卡片</h3>'
    + '<div class="section-desc">聊天里每次配图时，表情包卡片会显示一张图片。这里控制图片的显示尺寸，以及卡片下方那排「喜欢 / 不喜欢」按钮。</div>'
    // v0.33.77 - 图片尺寸档位选择器（自动/小/中/大），全局生效
    + '<div class="pref-row" style="margin-bottom:10px">'
    + '<span class="fit-label" style="margin-right:10px">图片尺寸</span>'
    + '<select class="size-mode-select" id="size-mode-select" title="配图卡片尺寸：自动=小图原尺寸/大图填满（默认）；小/中/大=固定宽度显示">'
    + '<option value="auto">自动</option>'
    + '<option value="small">小（160）</option>'
    + '<option value="medium">中（260）</option>'
    + '<option value="large">大（400）</option>'
    + '</select>'
    + '<span class="section-hint" style="margin-left:8px;font-size:11px;color:var(--text-light)">自动：小图按原尺寸、大图自动填满</span>'
    + '</div>'
    // v0.33.78 - 小图自适应开关：固定档下小于档位的图按原尺寸显示，不拉伸防糊
    + '<div class="fit-toggle" id="sticker-fit-toggle" role="switch" aria-checked="true" title="开 = 小于档位尺寸的图按原图大小显示，不拉伸（防小图糊掉）；关 = 所有图一律按档位尺寸显示">'
    + '<span class="fit-track"><span class="fit-knob"></span></span>'
    + '<span class="fit-label">小图自适应（小于档位不放大）</span>'
    + '</div>'
    + '<div class="fit-toggle" id="sticker-fb-toggle" role="switch" aria-checked="true" title="开 = 卡片下方显示喜欢/不喜欢按钮；关 = 卡片只显示表情包图片" style="margin-top:8px">'
    + '<span class="fit-track"><span class="fit-knob"></span></span>'
    + '<span class="fit-label">显示反馈按钮</span>'
    + '</div>'
    + '</div>'

    // 决策日志 + 偏好映射
    + '<div class="pref-section">'
    + '<h3>📊 配图决策日志</h3>'
    + '<div class="section-desc">每次配图的决策记录。可以点 👍/👎 给反馈，调整伙伴以后的配图偏好。</div>'
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
    + '<h2>伙伴配图设置</h2>'
    + '<span class="spacer"></span>'
    + '<button class="badge-btn" id="agent-hidden-btn" hidden title="查看已经从列表里移除的伙伴，可以把他们放回来">已移除的伙伴</button>'
    + '<button class="badge-btn" id="refresh-agents-btn" title="重新读取 Hana 当前配置的伙伴列表（新加的伙伴会出现在这里）">刷新列表</button>'
    + '</div>'
    + '<div class="pref-section">'
    + '<div class="global-freq-note" id="agent-freq-global-note" role="status">自动配图已开启。每位伙伴的日常与正事两档都在这张卡里，改完立即生效。</div>'
    + '<div id="agent-freq-list" class="agent-card-list">加载中...</div>'
    + '</div>'
    + '</div>'

    // ═══════════════════════════════════
    //  视图 5：方言口音（v0.20.0 / v0.22.0 开关式）
    // ═══════════════════════════════════
    + '<div class="view hidden" id="view-dialect">'
    + '<div class="sub-header">'
    + '<button class="back-btn" data-goto="home">← 返回</button>'
    + '<h2>方言口音</h2>'
    + '</div>'
    + '<div class="pref-section">'
    + '<div class="dialect-desc">给每位伙伴挑个方言就行：挑上即开，选「(不选)」即关。\n开启后会在 ta 的意识栏注入一段方言设定（关闭时自动移除），打字自然带家乡味。\n所有方言都支持「方言加浓」开关：打开后浓度更高，每轮对话都有方言回响，聊到正事时自动让路；四川话另有精修文案，效果最浓。\n方言加浓的回响部分保存后即时生效，人格文件部分要<strong>重启 Hana</strong>才完整生效；重启后建议新开一个对话框聊天，方言味最正。</div>'
    + '<div class="userstyle-entry" style="margin:0 0 12px"><button type="button" class="btn btn-primary" id="goto-userstyle-btn" data-goto="userstyle">「' + userstyleName + '」：让 ta 学你的说话方式 →</button></div>'
    + '<div id="dialect-list" style="display:flex;flex-direction:column;gap:10px;margin-bottom:14px">加载中...</div>'
    + '<div class="dialect-save-bar"><span class="dialect-save-status" id="dialect-save-status">已保存</span>'
    + '<button class="btn btn-primary" id="save-dialect-btn" disabled>保存设置</button></div>'
    + '</div>'
    + '</div>'

    // ═══════════════════════════════════
    //  视图 6：学我说话（v0.30.0 自定义方言模板）
    // ═══════════════════════════════════
    + '<div class="view hidden" id="view-userstyle">'
    + '<div class="sub-header">'
    + '<button class="back-btn" data-goto="dialect">← 返回</button>'
    + '<h2 id="userstyle-title">' + userstyleName + '</h2>'
    + '</div>'
    + '<div class="pref-section">'
    + '<div class="dialect-desc" id="userstyle-desc">让伙伴学你的说话方式打字：点一下按钮，插件会读取你与所选伙伴的聊天记录，提炼你的说话习惯（用词、短语、句式、标点），生成一段可自己修改的方言模板。聊得越多，总结越准。\n模板确认后，到「方言口音」里给伙伴选上「' + userstyleName + '」就生效了。</div>'
    // v0.31.0：内容分析模型未配置时的前置引导（避免点总结才被拒绝）
    + (textReady ? '' : '<div class="form-group" style="background:var(--bg-soft,#f6f4ef);border:1px solid var(--border);border-radius:10px;padding:10px 12px;font-size:13px;color:var(--text-muted)">'
      + '总结需要先配置「内容分析模型」（提炼风格时用来分析你的聊天记录）。'
      + '<button type="button" class="btn btn-primary" id="userstyle-model-config-btn" style="width:auto;margin-left:8px;font-size:12px">去配置 →</button>'
      + '</div>')
    + '<div class="form-group" id="userstyle-agents-wrap">'
    // v0.31.1：入口改胶囊按钮样式（原来纯文字看不出能点）
    + '<details id="userstyle-agents-details" style="font-size:13px">'
    + '<summary style="display:inline-flex;align-items:center;gap:6px;cursor:pointer;user-select:none;color:var(--primary-dark);background:var(--primary-light);border:1px solid var(--primary);border-radius:999px;padding:6px 14px;font-size:13px">聊天记录来源<span id="userstyle-agents-arrow">▾</span></summary>'
    + '<div style="font-size:12px;color:var(--text-muted);margin-top:8px">总结时会读取这些伙伴的聊天记录来提炼你的风格，默认全部勾选，取消勾选就不读那边的记录</div>'
    + '<div id="userstyle-agents" style="display:flex;flex-wrap:wrap;gap:8px;margin-top:8px"></div>'
    + '</details>'
    + '</div>'
    + '<div class="form-group">'
    + '<label style="display:block;margin-bottom:6px">总结档位</label>'
    + '<div id="userstyle-levels" style="display:flex;gap:10px;flex-wrap:wrap"></div>'
    + '</div>'
    // v0.31.1：状态提示移到按钮下方（按钮右边太挤）
    + '<div class="form-group">'
    + '<button type="button" class="btn btn-primary" id="userstyle-start-btn">总结我的发言习惯</button>'
    + '</div>'
    + '<div class="form-group" style="font-size:12px;margin-top:-8px">'
    + '<span class="dialect-save-status" id="userstyle-task-status"></span>'
    + '</div>'
    + '<div class="form-group" id="userstyle-progress" hidden>'
    + '<div class="form-hint" id="userstyle-progress-text"></div>'
    + '</div>'
    + '<div class="form-group" id="userstyle-draft-wrap" hidden>'
    + '<label style="display:block;margin-bottom:6px">草稿（读着不像你就点「再总结一次」，想改就改完点「用它」）</label>'
    + '<textarea id="userstyle-draft" rows="8" style="width:100%;box-sizing:border-box;font-size:13px;line-height:1.6"></textarea>'
    + '<div style="font-size:12px;color:var(--text-muted);margin-top:4px"><span id="userstyle-draft-count">0 / 600 字</span>（模板保存上限 600 字）</div>'
    + '<div style="display:flex;gap:10px;margin-top:8px;flex-wrap:wrap">'
    + '<button type="button" class="btn btn-primary" id="userstyle-confirm-btn">保存模板</button>'
    + '<button type="button" class="btn" id="userstyle-shorten-btn" hidden>自动精简</button>'
    + '</div>'
    + '<div style="font-size:12px;color:var(--text-muted);margin-top:6px">保存后到「方言口音」页，给伙伴选上「<span id="userstyle-save-hint-name">学我说话</span>」就生效了</div>'
    + '</div>'
    + '<div class="form-group" id="userstyle-current-wrap" hidden>'
    + '<label style="display:block;margin-bottom:6px">当前模板（已生效）</label>'
    + '<div id="userstyle-current" style="font-size:12px;line-height:1.7;color:var(--text-muted);white-space:pre-wrap;background:var(--bg-soft,#f6f4ef);border-radius:10px;padding:10px;max-height:180px;overflow:auto"></div>'
    + '<div style="display:flex;gap:10px;margin-top:8px">'
    // v0.31.1：历史只留最近一版，不展示列表，给一个「返回上一版」按钮（可逆：再点一次换回来）
    + '<button type="button" class="btn" id="userstyle-revert-btn" hidden>返回上一版</button>'
    + '<button type="button" class="btn" id="userstyle-clear-btn">清空模板</button>'
    + '</div>'
    + '</div>'
    // v2：展柜版数据画像（统计基线 + 反例/锁定，提炼后展示）
    + '<div class="form-group" id="userstyle-profile-wrap" hidden>'
    + '<label style="display:block;margin-bottom:6px">你的说话画像（总结后自动生成）</label>'
    + '<div id="userstyle-profile" style="font-size:12px;line-height:1.6;color:var(--text-muted)"></div>'
    + '</div>'
    + '<div class="form-group" style="margin-top:10px">'
    + '<div class="form-hint">隐私说明：总结时只读取你与所选伙伴（以及之前总结过的其他伙伴）在本机的聊天记录，仅提炼说话风格（不提炼也不存储对话内容），数据不出本机。</div>'
    + '</div>'
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
    + '<div class="import-section-desc">可以一次选择多张、选整个文件夹、导入 ZIP 包，或直接 Ctrl+V 粘贴图片。导入后可批量 AI 识图自动打标签。ZIP 最多 50MB、2000 个文件，重复或异常文件自动跳过。</div>'
    + '<div class="form-group">'
    + '<div class="paste-zone" id="paste-zone" tabindex="0" title="先从聊天软件复制表情包，点一下这里，再按 Ctrl+V 即可粘贴">'
    + '<div class="paste-zone-title">点击这里，然后按 Ctrl+V 粘贴</div>'
    + '<div class="paste-zone-sub">先从聊天软件（QQ 等）复制表情包，点一下这个框，再按 Ctrl+V</div>'
    + '</div>'
    + '<div class="upload-pick-row">'
    + '<input type="file" id="upload-file" accept="image/png,image/jpeg,image/gif,image/webp,image/bmp" multiple style="display:none">'
    + '<button type="button" class="btn btn-primary" id="pick-files-btn">选择图片文件</button>'
    + '<input type="file" id="upload-folder" webkitdirectory multiple style="display:none">'
    + '<button type="button" class="btn btn-primary" id="pick-folder-btn">选择文件夹</button>'
    + '<input type="file" id="upload-zip" accept=".zip,application/zip" style="display:none">'
    + '<button type="button" class="btn btn-primary" id="pick-zip-btn">选择 ZIP 文件</button>'
    + '</div>'
    + '<div class="form-hint" id="upload-file-hint">支持 PNG、JPG、GIF、WebP 和 BMP，也可以整个文件夹一起选。</div>'
    + '<div class="form-hint" id="upload-folder-hint" hidden></div>'
    + '<div class="form-hint" id="upload-zip-hint">选好后点「导入 ZIP」开始</div>'
    + '</div>'
    + '<div class="form-group" style="display:flex;align-items:center;gap:8px;margin-top:2px">'
    + '<input type="checkbox" id="upload-auto-tag" checked style="width:14px;height:14px;accent-color:var(--primary);cursor:pointer">'
    + '<label for="upload-auto-tag" style="font-size:12px;color:var(--text-muted);cursor:pointer">上传完成后自动 AI 识图打标签</label>'
    + '</div>'
    + '<div class="modal-actions"><button class="btn btn-primary" id="upload-btn">导入图片</button><button class="btn btn-primary" id="import-zip-btn">导入 ZIP</button></div>'
    + '</div>'
    + '<div class="import-result" id="upload-result" hidden></div>'
    + '</div></div></div>'

    // ═══════════════════════════════════
    //  弹窗：导出迁移包
    // ═══════════════════════════════════
    + '<div class="modal-overlay" id="export-modal" hidden>'
    + '<div class="modal-box fixed-modal-box" style="position:relative;width:520px">'
    + '<div class="modal-head"><h2>导出一键搬家包</h2><button class="modal-close" data-close="export-modal">✕</button></div>'
    + '<div class="modal-body">'
    + '<div class="export-section">'
    + '<div class="export-section-title">导出的内容</div>'
    + '<div class="import-section-desc">表情包图库（图片 + 名称/描述/标签 + 语义描述）会一起放进 ZIP，下面的选项控制要不要带上你积累的其他数据。</div>'
    + '<div class="export-content-title" style="margin-top:6px">还要带上：</div>'
    + '<label class="export-check-all" title="勾选全部，就是完整的搬家包"><input type="checkbox" id="export-check-all">全选（完整搬家包）</label>'
    + '<label class="export-check"><input type="checkbox" id="export-group-preference" checked>'
    + '<span><span class="export-check-name">偏好培养</span><br><span class="export-check-desc">喜欢/不喜欢哪张图、识图教学样本、应景反馈、曝光统计</span></span></label>'
    + '<label class="export-check"><input type="checkbox" id="export-group-style" checked>'
    + '<span><span class="export-check-name">学我说话</span><br><span class="export-check-desc">风格模板、风格画像、正反例反馈</span></span></label>'
    + '<label class="export-check"><input type="checkbox" id="export-group-dialect" checked>'
    + '<span><span class="export-check-name">方言配置</span><br><span class="export-check-desc">各伙伴的方言开关与浓度</span></span></label>'
    + '<label class="export-check"><input type="checkbox" id="export-group-interface" checked>'
    + '<span><span class="export-check-name">界面与悬浮球</span><br><span class="export-check-desc">发图频率、展示设置、悬浮球置顶</span></span></label>'
    + '<label class="export-check"><input type="checkbox" id="export-group-groups" checked>'
    + '<span><span class="export-check-name">图库分组</span><br><span class="export-check-desc">分组定义、图片归属、伙伴可用分组与偏爱（要保留按组导出的归属，请勾选）</span></span></label>'
    + '<div class="export-scope">'
    + '<div class="export-content-title">图库范围</div>'
    + '<div class="export-scope-options">'
    + '<label><input type="radio" name="export-sticker-scope" id="export-scope-all" value="all" checked>全部图片</label>'
    + '<label><input type="radio" name="export-sticker-scope" id="export-scope-groups" value="groups">按分组选择</label>'
    + '</div>'
    + '<div class="form-hint">多选分组会取并集，同一张图片只放进 ZIP 一次；图片属于多个分组时会保留这些归属。</div>'
    + '<div class="export-group-picker" id="export-group-picker" hidden></div>'
    + '</div>'
    + '</div>'
    + '<div class="export-section">'
    + '<div class="export-section-title">保存位置</div>'
    + '<div class="import-section-desc">以下设置决定 ZIP 存到哪里。API Key、模型配置、聊天会话、日志和机器路径永远不会导出。</div>'
    + '<div class="form-group">'
    + '<label for="export-dir">保存到文件夹</label>'
    + '<div class="export-dir-row"><input type="text" id="export-dir" spellcheck="false" placeholder="填写或选择本机文件夹路径"><button type="button" class="btn btn-secondary" id="export-pick-folder">选择文件夹…</button><button type="button" class="btn btn-secondary" id="export-use-default">默认目录</button></div>'
    + '<div class="form-hint">可以手动填写，也可以点「选择文件夹…」；第一次导出后会记住上次的位置，目录不存在时会自动创建。</div>'
    + '</div>'
    + '<div class="export-dir-note" id="export-summary">当前图库会导出为一个新的 ZIP 文件。</div>'
    + '</div>'
    + '</div>'
    + '<div class="modal-foot"><div class="modal-actions"><button class="btn btn-secondary" data-close="export-modal">先不导出</button><button class="btn btn-primary" id="export-zip-btn">开始导出</button></div></div>'
    + '</div></div>'

    // ═══════════════════════════════════
    //  弹窗：分组管理与图片归属
    // ═══════════════════════════════════
    + '<div class="modal-overlay" id="group-manager-modal" hidden>'
    + '<div class="modal-box fixed-modal-box" style="position:relative;width:520px">'
    // 第一层：分组列表
    + '<div id="group-manager-pane">'
    + '<div class="modal-head"><h2>我的分组</h2><button class="modal-close" data-close="group-manager-modal">✕</button></div>'
    + '<div class="modal-body">'
    + '<div class="import-section-desc">按你自己的习惯把图片分堆，一张图片可以同时放进多个分组。点分组进去，可以看图、改名，或者让 AI 记住这个叫法。</div>'
    + '<div class="form-group" style="display:flex;gap:8px;align-items:center">'
    + '<input type="text" id="new-group-name" maxlength="80" placeholder="新分组名称，如：月薪喵、熊猫头" style="flex:1">'
    + '<button type="button" class="btn btn-primary" id="create-group-btn" style="width:auto;white-space:nowrap">新建分组</button>'
    + '</div>'
    + '<div id="group-migration-undo" class="group-undo-bar" hidden><span id="group-migration-undo-text"></span><button type="button" id="undo-group-migration">撤销这次迁移</button></div>'
    + '<div id="group-manager-list" class="group-picker-list">加载中...</div>'
    + '</div>'
    + '</div>'
    // 第二层：分组详情
    + '<div id="group-detail-pane" hidden>'
    + '<div class="modal-head group-detail-head"><button type="button" class="modal-back" id="group-detail-back" title="返回分组列表" aria-label="返回分组列表">←</button><h2 id="group-detail-title">分组</h2><button class="modal-close" data-close="group-manager-modal">✕</button></div>'
    + '<div class="modal-body">'
    + '<div class="group-detail-meta"><span id="group-detail-count">0 张图片</span></div>'
    + '<div class="group-naming-card">'
    + '<div class="group-naming-head"><span class="group-naming-title">让 AI 也这么叫它</span>'
    + '<label class="hb-switch"><input type="checkbox" id="group-naming-toggle"><span class="hb-switch-track"></span></label>'
    + '</div>'
    + '<div class="group-naming-hint">适合给有名字的角色或系列命名，比如「月薪喵」「熊猫头」。如果这个组只是你随手分的类（比如「开心」「小花专用」），不用开这个。</div>'
    + '<div class="group-naming-status" id="group-naming-status" role="status"></div>'
    + '</div>'
    + '<div class="group-detail-grid" id="group-detail-grid"></div>'
    + '<div class="form-hint" id="group-detail-empty" hidden>这个分组里还没有图片。到图库里勾选图片后，用「设置分组」加进来。</div>'
    + '</div>'
    + '<div class="modal-foot"><div class="modal-actions"><button class="btn btn-secondary" id="group-detail-rename-btn">重命名</button><button class="btn btn-secondary group-detail-delete" id="group-detail-delete-btn">删除分组</button></div></div>'
    + '</div>'
    + '</div></div>'

    + '<div class="modal-overlay" id="group-recognition-modal" hidden>'
    + '<div class="modal-box fixed-modal-box" style="position:relative;width:480px">'
    + '<div class="modal-head"><h2 id="group-recognition-title">识图设置</h2><button class="modal-close" data-close="group-recognition-modal">✕</button></div>'
    + '<div class="modal-body">'
    + '<div class="import-section-desc">主名称始终是这个分组的正式名称；别名只作为识图候选，不会改写图片原名。</div>'
    + '<div class="form-group"><label for="edit-group-recognition-aliases">识图别名</label><input type="text" id="edit-group-recognition-aliases" maxlength="400" placeholder="多个别名用逗号分隔"></div>'
    + '<label style="display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--text-muted);margin-top:4px"><input type="checkbox" id="edit-group-recognition-enabled">让 AI 在识图时参考这个分组</label>'
    + '<div class="group-recognition-note">只有画面和识图结果确实命中名称/别名时，才会在纸飞机确认面板提出加入建议；最后仍由你勾选确认。</div>'
    + '</div>'
    + '<div class="modal-foot"><div class="modal-actions"><button class="btn btn-secondary" data-close="group-recognition-modal">取消</button><button class="btn btn-primary" id="save-group-recognition-btn">保存设置</button></div></div>'
    + '</div></div>'

    + '<div class="modal-overlay" id="group-membership-modal" hidden>'
    + '<div class="modal-box fixed-modal-box" style="position:relative;width:480px">'
    + '<div class="modal-head"><h2 id="group-membership-title">加入分组</h2><button class="modal-close" data-close="group-membership-modal">✕</button></div>'
    + '<div class="modal-body">'
    + '<div class="import-section-desc" id="group-membership-hint">勾上要加入的分组，保存后生效。</div>'
    + '<div class="form-group" style="display:flex;gap:8px;align-items:center;margin:8px 0 4px">'
    + '<input type="text" id="membership-new-group-name" maxlength="80" placeholder="新建分组并加入所选图片" style="flex:1">'
    + '<button type="button" class="btn btn-secondary" id="create-membership-group-btn" style="width:auto;white-space:nowrap">新建并加入</button>'
    + '</div>'
    + '<div id="group-membership-list" class="group-picker-list">加载中...</div>'
    + '</div>'
    + '<div class="modal-foot"><div class="modal-actions"><button class="btn btn-secondary" data-close="group-membership-modal">取消</button><button class="btn btn-primary" id="save-group-membership-btn">保存</button></div></div>'
    + '</div></div>'

    + '<div class="modal-overlay" id="agent-library-modal" hidden>'
    + '<div class="modal-box fixed-modal-box" style="position:relative;width:480px">'
    + '<div class="modal-head"><h2 id="agent-library-title">可用图库</h2><button class="modal-close" data-close="agent-library-modal">✕</button></div>'
    + '<div class="modal-body">'
    + '<div class="fit-toggle" id="agent-lib-all-toggle" role="switch" aria-checked="false" title="打开后 ta 能用图库里任何一张图，以后新建的分组也会自动算进来">'
    + '<span class="fit-track"><span class="fit-knob"></span></span>'
    + '<span class="fit-label">全部图库</span>'
    + '</div>'
    + '<div class="agent-lib-note" id="agent-lib-all-note"></div>'
    + '<div id="agent-library-list" class="group-picker-list"></div>'
    + '<div class="form-hint" id="agent-library-hint">点「优先」让这个分组的图更容易被 ta 选中，只在已经勾上的分组里生效，不会把没勾的图放进来。</div>'
    + '</div>'
    + '<div class="modal-foot"><div class="modal-actions"><button class="btn btn-secondary" data-close="agent-library-modal">取消</button><button class="btn btn-primary" id="save-agent-library-btn">保存</button></div></div>'
    + '</div></div>'

    + '<div class="modal-overlay" id="agent-hidden-modal" hidden>'
    + '<div class="modal-box fixed-modal-box" style="position:relative;width:460px">'
    + '<div class="modal-head"><h2>已移除的伙伴</h2><button class="modal-close" data-close="agent-hidden-modal">✕</button></div>'
    + '<div class="modal-body">'
    + '<div class="import-section-desc">这些伙伴已经被移除，列表和刷新都不会再带出 ta。点「放回列表」就恢复。</div>'
    + '<div id="agent-hidden-list" class="group-picker-list"></div>'
    + '</div>'
    + '<div class="modal-foot"><div class="modal-actions"><button class="btn btn-secondary" data-close="agent-hidden-modal">关闭</button></div></div>'
    + '</div></div>'

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
    // v0.34.37 - 批量识图：识别完自动应用（默认开，即时保存）
    + '<div class="form-group" style="margin-top:14px;padding-top:12px;border-top:1px solid var(--border-light)">'
    + '<label style="display:flex;align-items:flex-start;gap:8px;font-size:13px;cursor:pointer">'
    + '<input type="checkbox" id="batch-auto-apply" style="margin-top:3px;width:auto;accent-color:var(--primary)">'
    + '<span>批量识图完成后自动写入图库'
    + '<br><span style="font-size:11.5px;color:var(--text-muted);line-height:1.6">打开：识别完直接把标题和标签存进图库，不用再点一步。关掉：先出预览，你点「全部应用」才写入。</span></span>'
    + '</label>'
    + '</div>'
    + '</div>'

    // 分析模型
    + '<div class="settings-section" id="text-settings-section">'
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
    // v0.33.29 - 悬浮球识图确认入库时自动生成向量（分享版默认关）
    + '<div class="form-group" style="margin-top:10px"><label>悬浮球识图入库自动向量</label>'
    + '<div class="switch-row"><input type="checkbox" id="embedding-auto-vector">'
    + '<span style="font-size:12px;color:var(--text-muted)">在悬浮球拖图/粘贴识图、确认入库时自动生成一次向量。关闭则不消耗向量模型，需要时到图库页点「图库语义索引」批量补。</span></div></div>'
        + '</div>'
    + '</div>'

    // v0.24.0 - 配图卡片显示（已移到图库页拨动开关，见 view-library）
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
    + '<div class="batch-backdrop-tip">识别在后台运行，关掉这个窗口或切去聊天都不会中断。图库上方会出现「识图中」按钮，随时点回来看进度。</div>'
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
    + '<script>window.__DISPLAY_CONFIG__=' + JSON.stringify(displayCfg).replace(/</g, '\\u003c') + ';</script>'
    + '<script>window.__DECISION_LOG__=' + JSON.stringify(logData).replace(/</g, '\\u003c') + ';</script>'
    + '<script>window.__CONTEXT_FEEDBACK__=' + JSON.stringify(contextFeedbackData).replace(/</g, '\\u003c') + ';</script>'
    + '<script>window.__EMBEDDING_CONFIG__=' + JSON.stringify(safeEmbeddingConfig).replace(/</g, '\\u003c') + ';</script>'
    + '<script>window.__EMBEDDING_MODELS__=' + JSON.stringify(embeddingModels).replace(/</g, '\\u003c') + ';</script>'
    + '<script>window.__EXPORT_CONFIG__=' + JSON.stringify({ lastExportDir: defaultExportDir, defaultExportDir: path.join(homedir(), 'Downloads') }).replace(/</g, '\\u003c') + ';</script>'
    + '<script>' + js + '</script></body></html>';
}

export default async function registerRoutes(app, ctx) {
  ctx?.log?.info?.('[biaoqingbao] UI 路由已注册');

  app.get('/page', (c) => {
    return c.html(renderPage(), 200);
  });

  app.get('/sticker', (c) => {
    // 卡片 HTML 内联了当前版本脚本；禁止浏览器/宿主复用旧页面，避免更新后继续执行旧确认逻辑。
    c.header('Cache-Control', 'no-store, no-cache, must-revalidate');
    c.header('Pragma', 'no-cache');
    c.header('Expires', '0');
    const id = c.req.query('id') || '';
    const label = c.req.query('label') || '表情包';
    const description = c.req.query('description') || '';
    const score = c.req.query('score') || '';
    // 临时诊断：确认聊天 iframe 是否真的请求到了插件页面；不记录 token/ticket 原文。
    const authKind = c.req.query('pluginIframeTicket')
      ? 'iframe-ticket'
      : c.req.query('token')
        ? 'query-token'
        : 'none';
    ctx?.log?.info?.(`[biaoqingbao] sticker iframe 请求: id=${id}, auth=${authKind}, surface=${c.req.query('pluginSurfaceSession') ? 'yes' : 'no'}`);

    if (!id) return c.text('missing id', 400);

    const META_FILE = path.join(DATA_DIR, 'stickers.json');
    const STICKERS_DIR_LOCAL = STICKERS_DIR;
    let meta;
    try { meta = JSON.parse(fs.readFileSync(META_FILE, 'utf-8')); } catch { meta = []; }
    const s = meta.find(x => x.id === id);
    if (!s) return c.text('sticker not found', 404);

    let imgBase64 = '';
    try {
      const filePath = safeStickerPath(STICKERS_DIR_LOCAL, s.file);
      if (!filePath) return c.text('sticker file path rejected', 404);
      const buf = fs.readFileSync(filePath);
      const ext = s.file.split('.').pop().toLowerCase();
      const mime = MIME_MAP[ext] || 'image/jpeg';
      imgBase64 = `data:${mime};base64,${buf.toString('base64')}`;
    } catch (e) {
      return c.text('sticker file read error: ' + e.message, 500);
    }

    const agent = c.req.query('agent') || '';
    const emotion = c.req.query('emotion') || '';

    // v0.24.0 - 配图卡片显示配置（小图自适应开关，仅对小于阈值的图生效）
    let displayCfg = { smallImageFit: true, smallImageThreshold: 200, showFeedbackButtons: true, sizeMode: 'auto' };
    try { displayCfg = { ...displayCfg, ...JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'display-config.json'), 'utf-8')) }; } catch {}
    const fitEnabled = displayCfg.smallImageFit !== false;
    const fitThreshold = Math.max(50, Math.min(500, Number(displayCfg.smallImageThreshold) || 200));
    // v0.33.77 - 图片尺寸档位：auto=智能自适应（默认，即原行为）；small/medium/large=固定宽 160/260/400
    const sizeMode = ['auto', 'small', 'medium', 'large'].includes(displayCfg.sizeMode) ? displayCfg.sizeMode : 'auto';
    // v0.28.0 - 反馈按钮显示开关（关掉后卡片只显示表情包图片）
    const showFb = displayCfg.showFeedbackButtons !== false;

    // v0.22.0 - 初始反馈状态：该图在 agent+emotion 偏好映射里已记过则预置
    // v0.25.0 - 不喜欢累计次数也预置状态（多轮不喜欢 → 频率衰减），次数传给前端显示
    let initPref = '';
    let initDislikes = 0;
    try {
      const prefs = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'preferences.json'), 'utf-8'));
      const users = prefs.users || {};
      const user = users[agent] || users.default;
      if (user && Array.isArray(user.mappings)) {
        const m = user.mappings.find(mp => (mp.context || {}).emotion === emotion);
        if (m) {
          if ((m.preferred_ids || []).includes(id)) initPref = 'positive';
          else if ((m.vetoed_ids || []).includes(id)) initPref = 'negative';
          else if (((m.dislike_counts || {})[id] || 0) > 0) {
            initPref = 'negative';
            initDislikes = m.dislike_counts[id];
          }
        }
      }
    } catch {}

    const sessionPath = c.req.query('sessionPath') || '';
    const sessionId = c.req.query('sessionId') || '';

    const STICKER_CFG = JSON.stringify({ id, agent, emotion, init: initPref, dislikes: initDislikes, fit: fitEnabled, fitThreshold, fb: showFb, sessionPath, sessionId }).replace(/</g, '\\u003c');

    return c.html(`<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <title>表情包</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { height: 100%; }
    /* v0.33.3 - 根绝滚动条：iframe 内容必须完全贴合上报尺寸，任何超宽（toast 长提示等）只裁不滚 */
    html, body { overflow: hidden; }
    /* v0.33.74 - body 受宿主 iframe 宽度约束：旧版 fit-content 会按内容撑宽（按钮行 190px），
       宿主把 iframe 开窄时内容溢出被裁（“不喜欢”变“不喜”）。改 width:100% 后内容在窄容器里折行/压缩。 */
    body { width: 100%; max-width: 100%; display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 6px; background: transparent; box-sizing: border-box; }
    /* v0.32.3 - align-items:center 兜底：宿主槽位比内容宽时（如微小图小于宿主 50px 下限）内容居中，不再挤左上角 */
    /* v0.25.1 - hidden 必须真生效：display:flex 等显式样式会覆盖 hidden 属性（经典坑） */
    [hidden] { display: none !important; }
    .img-card {
      width: fit-content; max-width: 100%; /* v0.32.3 - 卡片跟图片走：小图不再被 flex:1 撑满 400px 留大白边 */
      min-height: 0;
      display: flex; align-items: center; justify-content: center;
      /* v0.33.4 - 去掉外边装饰：图片直接展示，不再套薄荷绿描边+内边距+浅底（用户嫌多余） */
    }
    .img-card img { max-width: 100%; max-height: 100%; display: block; object-fit: contain; border-radius: 6px; }
    /* v0.24.0 - 小图自适应开启时：强制占满卡片尺寸，按比例缩放不裁切 */
    .img-card img.fit { width: 100%; height: 100%; }
    /* v0.28.0 - 去掉外层容器框：按钮直接贴在图片下，不再套白底圆角框（保留 flex 居中与 toast 定位） */
    .fb-card {
      position: relative; margin: 0 auto;
      align-self: center; /* v0.32.3 - 跟随 body 居中对齐（原 flex-start 在收窄后会让按钮偏离图片中轴） */
      display: flex; align-items: center; gap: 8px;
      padding: 2px 0;
      /* v0.33.74 - body 受宿主 iframe 宽度约束：旧版 fit-content 会按内容撑宽（按钮行 190px），
         宿主把 iframe 开窄时内容溢出被裁（“不喜欢”变“不喜”）。改 width:100% 后内容跟随容器。
         v0.33.75 - 按钮行保持横排一排（用户明确要求），宽度由 fitCard 上报 max(图宽, 按钮行需求宽)
         保证，宿主按上报宽度开窗即可完整放下；不折行。
         v0.33.76 - 按钮行两侧留白 + 缩小按钮间距：padding 10px 左右、gap 6px，视觉不贴边。 */
      width: 100%; justify-content: center;
      padding: 2px 10px;
      gap: 6px;
      box-sizing: border-box;
    }
    .fb-btn {
      border: 1px solid #d5e5dd; border-radius: 999px;
      background: transparent; cursor: pointer;
      font-size: 12px; padding: 4px 14px;
      color: #4a9277; transition: all .15s;
      /* v0.33.2 - 按钮永不被挤压：不收缩、不换行，保证「喜欢/不喜欢」始终横排一行 */
      flex-shrink: 0; white-space: nowrap;
    }
    .fb-btn:hover { background: #e6f3ed; }
    .fb-btn.on-love { background: #5dae8e; border-color: #5dae8e; color: #fff; }
    .fb-btn.on-love:hover { background: #5dae8e; }
    .fb-btn.on-fit { background: #e8b87a; border-color: #e8b87a; color: #fff; }
    .fb-btn.on-fit:hover { background: #e8b87a; }
    .fb-btn.on-hate { background: #e89bb0; border-color: #e89bb0; color: #fff; }
    .fb-btn.on-hate:hover { background: #e89bb0; }
    .fb-toast {
      position: absolute; bottom: calc(100% + 6px); left: 50%; transform: translateX(-50%);
      background: #fafdfb; border: 1px solid #d5e5dd; border-radius: 8px;
      padding: 4px 10px; font-size: 11px; color: #2d3a35;
      opacity: 0; transition: opacity .15s;
      /* v0.33.3 - 不再 nowrap 硬撑：限在按钮区宽内，长提示折行显示，绝不顶出横向滚动条 */
      max-width: 100%; white-space: normal; line-height: 1.4; text-align: left;
      pointer-events: none;
    }
    .fb-toast.show { opacity: 1; }
    /* v0.25.0 - 不喜欢后的「聊聊」入口条 */
    .chat-invite {
      display: flex; align-items: center; gap: 8px;
      background: #fdf4f7; border: 1px dashed #e8b7c8; border-radius: 8px;
      padding: 6px 10px; font-size: 11px; color: #8a5a68;
    }
    .chat-invite .invite-text { flex: 1; line-height: 1.5; }
    .chat-invite-btn {
      border: none; border-radius: 999px;
      background: #e89bb0; color: #fff;
      font-size: 11px; padding: 4px 12px; cursor: pointer; flex-shrink: 0;
      transition: background .15s;
    }
    .chat-invite-btn:hover { background: #df86a0; }
    /* v0.25.0 - 卡片内联聊天面板 */
    .chat-panel {
      width: 100%; height: 420px; min-height: 0; overflow: hidden;
      display: flex; flex-direction: column; gap: 6px;
      background: #fafdfb; border: 1px solid #d5e5dd; border-radius: 8px;
      padding: 8px;
      box-sizing: border-box;
    }
    /* v0.34.6 - 修改建议区不再限 42vh：diff 内容长时在建议区内滚动，
       不再被 iframe 裁切线截掉（iframe 高度 < 420 时 diff 内容必须能滚到） */
    .chat-panel-head { display: flex; align-items: center; gap: 8px; }
    .chat-panel-head img {
      width: 38px; height: 38px; object-fit: cover;
      border-radius: 6px; border: 1px solid #d5e5dd; background: #fff;
    }
    .chat-panel-head .chat-title { flex: 1; font-size: 12px; color: #2d3a35; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .chat-close-btn {
      border: 1px solid #d5e5dd; border-radius: 999px;
      background: transparent; font-size: 11px; color: #4a9277;
      padding: 3px 10px; cursor: pointer; flex-shrink: 0;
    }
    .chat-close-btn:hover { background: #e6f3ed; }
    .chat-msgs {
      height: auto; min-height: 64px; flex: 1 1 190px; overflow-y: auto;
      display: flex; flex-direction: column; gap: 6px;
      background: #f4faf7; border: 1px solid #e2eee8; border-radius: 8px;
      padding: 8px;
    }
    /* v0.34.8 - 修改建议卡改为嵌进聊天流（随消息一起滚动），不再占面板中间固定区块；
       消息区也不再让空间——建议卡就是消息流里的一条卡片，滚动即可看到完整 diff 与按钮 */
    .chat-empty { color: #8a9b92; font-size: 11px; text-align: center; padding: 14px 0; line-height: 1.6; }
    .msg {
      max-width: 85%; padding: 6px 10px; border-radius: 10px;
      font-size: 12px; line-height: 1.5; word-break: break-word; white-space: pre-wrap;
    }
    .msg-user { align-self: flex-end; background: #5dae8e; color: #fff; border-bottom-right-radius: 2px; }
    .msg-assistant { align-self: flex-start; background: #fff; border: 1px solid #d5e5dd; color: #2d3a35; border-bottom-left-radius: 2px; }
    .msg-thinking { align-self: flex-start; background: #fff; border: 1px dashed #d5e5dd; color: #8a9b92; }
    .msg-error { align-self: flex-start; background: #fdf0f3; border: 1px solid #f0c4d2; color: #b0546e; }
    .chat-sug {
      width: 100%; flex-shrink: 0; box-sizing: border-box;
      display: flex; flex-direction: column;
      background: #fff7f9; border: 1px solid #eebdcd; border-radius: 8px; padding: 8px;
    }
    .chat-sug-title { font-size: 11px; color: #b0546e; font-weight: 600; margin-bottom: 6px; flex-shrink: 0; }
    .chat-sug-diff {
      font-size: 11px; color: #2d3a35; line-height: 1.7; word-break: break-word;
    }
    .chat-sug-diff .diff-row { margin-bottom: 2px; }
    .chat-sug-diff .diff-label { color: #8a5a68; font-weight: 600; margin-right: 4px; }
    .chat-sug-diff .diff-old { color: #b3a8ac; text-decoration: line-through; margin-right: 4px; }
    .chat-sug-diff .diff-new { color: #2d6b52; font-weight: 600; }
    .chat-sug-actions { display: flex; gap: 8px; margin-top: 8px; flex-shrink: 0; }
    .chat-sug-btn { border: none; border-radius: 999px; font-size: 11px; padding: 4px 12px; cursor: pointer; }
    .chat-sug-btn.no { background: transparent; border: 1px solid #d5e5dd; color: #4a9277; }
    .chat-sug-btn.no:hover { background: #e6f3ed; }
    .chat-sug-btn.yes { background: #e89bb0; color: #fff; }
    .chat-sug-btn.yes:hover { background: #df86a0; }
    .chat-sug-btn:disabled { opacity: .55; cursor: default; }
    .chat-input-row { display: flex; gap: 6px; align-items: flex-end; flex-shrink: 0; }
    .chat-input-row textarea {
      flex: 1; resize: none;
      border: 1px solid #d5e5dd; border-radius: 8px;
      padding: 6px 10px; font-size: 12px; font-family: inherit; color: #2d3a35;
      background: #fff; min-height: 32px; max-height: 80px;
      outline: none;
    }
    .chat-input-row textarea:focus { border-color: #5dae8e; }
    .chat-send-btn {
      border: none; border-radius: 999px;
      background: #5dae8e; color: #fff;
      font-size: 12px; padding: 7px 14px; cursor: pointer; flex-shrink: 0;
    }
    .chat-send-btn:hover { background: #4c9a7c; }
    .chat-send-btn:disabled { opacity: .5; cursor: default; }
  </style>
</head>
<body>
  <div class="img-card" id="img-card"><img src="${imgBase64}" alt="表情包" /></div>
  <div class="fb-card" id="fb-card"${showFb ? '' : ' hidden'}>
    <button class="fb-btn" id="fb-pos" type="button">喜欢</button>
    <button class="fb-btn" id="fb-fit" type="button">应景</button>
    <button class="fb-btn" id="fb-neg" type="button">不喜欢</button>
    <span class="fb-toast" id="fb-toast"></span>
  </div>
  <div class="chat-invite" id="chat-invite" hidden>
    <span class="invite-text">觉得配图不精准？可以和小花聊聊</span>
    <button class="chat-invite-btn" id="chat-open-btn" type="button">聊聊</button>
  </div>
  <div class="chat-panel" id="chat-panel" hidden>
    <div class="chat-panel-head">
      <img id="chat-mini-img" alt="">
      <span class="chat-title">和小花聊聊这张图</span>
      <button class="chat-close-btn" id="chat-close-btn" type="button">收起</button>
    </div>
    <div class="chat-msgs" id="chat-msgs"></div>
    <div class="chat-sug" id="chat-sug" hidden>
      <div class="chat-sug-title">✨ 小花建议这样调整标签</div>
      <div class="chat-sug-diff" id="chat-sug-diff"></div>
      <div class="chat-sug-actions">
        <button class="chat-sug-btn no" id="chat-sug-no" type="button">再看看</button>
        <button class="chat-sug-btn yes" id="chat-sug-yes" type="button">确认修改</button>
      </div>
    </div>
    <div class="chat-input-row">
      <textarea id="chat-input" rows="1" placeholder="说说哪里不对…（Enter 发送）"></textarea>
      <button class="chat-send-btn" id="chat-send-btn" type="button">发送</button>
    </div>
  </div>
  <script>window.__STICKER__ = ${STICKER_CFG};</script>
  <script>
    (function () {
      // v0.31.8 - sticker iframe 必须完成 Hana UI 握手；否则宿主可能只保留卡片文字回退，不显示实际 iframe 内容。
      window.parent.postMessage({
        protocol: 'hana.plugin.ui',
        version: 1,
        kind: 'event',
        type: 'hana.ready'
      }, '*');
      // v0.33.70 - devkit 1.0 宿主（0.686+）兼容裸原始握手 { type: 'ready' }；双发幂等，老宿主忽略未知格式
      window.parent.postMessage({ type: 'ready' }, '*');
      var cfg = window.__STICKER__;
      var posBtn = document.getElementById('fb-pos');
      var fitBtn = document.getElementById('fb-fit');
      var negBtn = document.getElementById('fb-neg');
      var toast = document.getElementById('fb-toast');
      var invite = document.getElementById('chat-invite');
      var chatPanel = document.getElementById('chat-panel');
      var pending = false;
      var toastTimer = null;
      // v0.25.0 - 不喜欢累计次数（多轮不喜欢 → 频率衰减）
      var dislikeCount = cfg.dislikes || 0;
      // 聊天状态
      var chatMode = false;
      var chatSessionId = null;
      var chatSuggestion = null;
      var chatBusy = false;

      function escHtml(s) {
        return String(s == null ? '' : s)
          .replace(/&/g, '&amp;').replace(/</g, '&lt;')
          .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
      }
      // 从当前 iframe 地址推导插件 API 前缀（页面在 /api/plugins/biaoqingbao/sticker 下）
      function apiBase() {
        var pagePath = window.location.pathname;
        return pagePath.substring(0, pagePath.lastIndexOf('/'));
      }
      // 透传 iframe URL 上的插件会话凭证（Hana 页面鉴权必需）
      // 旧版 Hana 用 server token（query），新版用 pluginSurfaceSession（query/header）。
      // token 优先、surface 兜底，与管理页 withAuth 保持一致；
      // pluginIframeTicket 是一次性文档加载凭证，不复用到 API 请求。
      function authQuery() {
        var parts = [];
        var locParams = new URLSearchParams(window.location.search);
        var token = locParams.get('token');
        var surface = locParams.get('pluginSurfaceSession');
        if (token) parts.push('token=' + encodeURIComponent(token));
        else if (surface) parts.push('pluginSurfaceSession=' + encodeURIComponent(surface));
        return parts.length > 0 ? '?' + parts.join('&') : '';
      }
      function authUrl(url) {
        var query = authQuery();
        if (!query) return url;
        return url + (url.indexOf('?') >= 0 ? '&' : '') + query.slice(1);
      }
      // 新版页面凭证优先走请求头，同时保留 query 兼容旧版 Hana。
      function authInit(init) {
        var next = Object.assign({}, init || {});
        var locParams = new URLSearchParams(window.location.search);
        var surface = locParams.get('pluginSurfaceSession');
        if (!surface) return next;
        var headers = {};
        var source = next.headers || {};
        if (typeof source.forEach === 'function') source.forEach(function (value, key) { headers[key] = value; });
        else Object.keys(source).forEach(function (key) { headers[key] = source[key]; });
        headers['X-Hana-Plugin-Surface-Session'] = surface;
        next.headers = headers;
        return next;
      }
      function timedPromise(promise, timeoutMs) {
        var timer = null;
        var timeout = new Promise(function (_, reject) {
          timer = setTimeout(function () {
            var error = new Error('请求超时');
            error.name = 'TimeoutError';
            reject(error);
          }, timeoutMs);
        });
        return Promise.race([promise, timeout]).then(function (value) {
          clearTimeout(timer);
          return value;
        }, function (error) {
          clearTimeout(timer);
          throw error;
        });
      }
      function timedFetch(url, init, timeoutMs) {
        return timedPromise(fetch(url, init), timeoutMs);
      }
      function waitMs(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }
      function sameStringList(a, b) {
        if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
        for (var i = 0; i < a.length; i++) {
          if (String(a[i] == null ? '' : a[i]).trim() !== String(b[i] == null ? '' : b[i]).trim()) return false;
        }
        return true;
      }
      function stickerMatchesSuggestion(sticker, suggestion) {
        if (!sticker || !suggestion) return false;
        var tags = sticker.tags || {};
        var checked = false;
        if (suggestion.description !== undefined) {
          checked = true;
          if (String(sticker.description || '').trim() !== String(suggestion.description || '').trim()) return false;
        }
        if (suggestion.semantic_description !== undefined) {
          checked = true;
          if (String(sticker.semantic_description || '').trim() !== String(suggestion.semantic_description || '').trim()) return false;
        }
        var fields = ['emotion', 'scene', 'keywords'];
        for (var i = 0; i < fields.length; i++) {
          var field = fields[i];
          if (suggestion[field] !== undefined) {
            checked = true;
            if (!sameStringList(tags[field] || [], suggestion[field])) return false;
          }
        }
        return checked;
      }
      // 确认请求可能已经写入成功，只是响应在 iframe 侧丢失；回查落盘结果再决定是否报错。
      async function recoverConfirmedChange(stickerId, suggestion) {
        for (var attempt = 0; attempt < 3; attempt++) {
          try {
            var res = await timedFetch(authUrl(apiBase() + '/api/list?id=' + encodeURIComponent(stickerId)), authInit({ method: 'GET' }), 2500);
            var data = await timedPromise(res.json(), 2500);
            var list = data && data.ok && Array.isArray(data.data) ? data.data : [];
            var sticker = list.find(function (item) { return item && item.id === stickerId; });
            if (stickerMatchesSuggestion(sticker, suggestion)) return true;
          } catch (e) {}
          if (attempt < 2) await waitMs(180 + attempt * 240);
        }
        return false;
      }
      function showToast(msg, isErr) {
        toast.textContent = msg;
        toast.classList.toggle('err', !!isErr);
        toast.classList.add('show');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(function () { toast.classList.remove('show'); }, 1800);
      }
      function showInvite() { if (invite) invite.hidden = false; }
      function hideInvite() { if (invite) invite.hidden = true; }

      // ── 新版反馈系统（v0.33.68，对齐纸飞机悬浮球） ──
      // 三键：〔喜欢〕〔应景〕〔不喜欢〕；喜欢/应景可独立点、叠加成 both，再点同维度取消；
      // 不喜欢独立一键，再点取消；「聊一聊」只在点过不喜后出现。
      // 状态：null | positive(image) | positive(context) | positive(both) | negative
      var fbCurrent = null;   // 当前反馈：null | 'positive' | 'negative'
      var fbKind = 'image';   // 正反馈细分：'image' | 'context' | 'both'
      var likeActive = false;
      var fitActive = false;
      var negActive = false;

      // 初始：历史态度只提示、不预置亮灯（v0.27.2 延续）
      if (cfg.init === 'positive') showToast('这张之前记过喜欢，可重新选择');
      if (cfg.init === 'negative') {
        showToast(dislikeCount > 0 ? '这张之前点过 ' + dislikeCount + ' 次不喜欢，可重新选择' : '这张之前记过不喜欢，可重新选择');
      }

      // 同维度再点 = 取消；不同维度 = 叠成 both；both 再点某维度 = 只剩另一维度（对齐球端 _next_positive_kind）
      function nextPositiveKind(tapped) {
        if (fbCurrent !== 'positive') return tapped;
        if (fbKind === tapped) return null;
        if (fbKind === 'both') return tapped === 'image' ? 'context' : 'image';
        return 'both';
      }

      function reflectButtons() {
        likeActive = fbCurrent === 'positive' && (fbKind === 'image' || fbKind === 'both');
        fitActive = fbCurrent === 'positive' && (fbKind === 'context' || fbKind === 'both');
        negActive = fbCurrent === 'negative';
        posBtn.classList.toggle('on-love', likeActive);
        posBtn.textContent = likeActive ? '已喜欢' : '喜欢';
        fitBtn.classList.toggle('on-fit', fitActive);
        fitBtn.textContent = fitActive ? '已应景' : '应景';
        negBtn.classList.toggle('on-hate', negActive);
        negBtn.textContent = negActive ? '已反馈' : '不喜欢';
        if (negActive) showInvite(); else hideInvite();
      }

      function toastFor(feedback, kind) {
        if (feedback === 'negative') return dislikeCount > 0
          ? '已记下：不喜欢（累计 ' + dislikeCount + ' 次，会慢慢少发）'
          : '已记下：不喜欢';
        if (feedback === 'positive') {
          if (kind === 'context') return '已记下：这次很应景';
          if (kind === 'both') return '已记下：喜欢这张图，也很应景';
          return '已记下：喜欢这张图';
        }
        return '已取消这次反馈';
      }

      async function sendFb(tappedKind) {
        if (pending) return;
        var nextKind = nextPositiveKind(tappedKind);
        var isNegTap = tappedKind === 'negative';
        var nextFeedback;
        var nextFbKind = null;
        if (isNegTap) {
          nextFeedback = fbCurrent === 'negative' ? 'clear' : 'negative';
        } else {
          nextFeedback = nextKind === null ? 'clear' : 'positive';
          nextFbKind = nextKind;
        }
        // 当前无反馈时不可能走到 clear（无状态点喜欢/应景/不喜欢首击都是新增），此 guard 只是防御性兜底
        if (nextFeedback === 'clear' && fbCurrent === null) return;
        pending = true;
        var prev = { fbCurrent: fbCurrent, fbKind: fbKind };
        var prevLike = likeActive, prevFit = fitActive, prevNeg = negActive;
        if (nextFeedback === 'clear') { fbCurrent = null; fbKind = 'image'; }
        else { fbCurrent = nextFeedback; fbKind = nextFbKind || fbKind; }
        reflectButtons();
        function rollbackFb() {
          fbCurrent = prev.fbCurrent; fbKind = prev.fbKind;
          likeActive = prevLike; fitActive = prevFit; negActive = prevNeg;
          reflectButtons();
        }
        try {
          var body = {
            stickerId: cfg.id,
            feedback: nextFeedback,
            agentId: cfg.agent,
          };
          if (cfg.sessionPath) body.sessionPath = cfg.sessionPath;
          // v0.33.81 - 显式传 sessionId（发图时 ctx.sessionId 的权威值），避免后端从 jsonl 文件头
          // 解析 sessionId 失败（无媒体消息的会话头部匹配不到）导致“没有找到对应的配图记录”。
          if (cfg.sessionId) body.sessionId = cfg.sessionId;
          if (nextFeedback === 'positive') body.feedbackKind = nextFbKind;
          // 应景账本需要 context_emotion；submitBallFeedback 从 recent-match 记录取 emotion，这里兜底传一下
          var res = await fetch(apiBase() + '/api/ball/feedback' + authQuery(), authInit({
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
          }));
          var data = await res.json();
          if (data.ok) {
            if (nextFeedback === 'negative') {
              dislikeCount = data.dislike_count || dislikeCount + 1;
            }
            showToast(toastFor(nextFeedback, nextFbKind));
          } else {
            rollbackFb();
            showToast('没记上：' + (data.error || '出错了'), true);
          }
        } catch (e) {
          rollbackFb();
          showToast('没记上，网络开小差了', true);
        }
        pending = false;
      }

      // ── 内联聊天（v0.25.0：点「聊聊」在卡片里直接跟小花说） ──
      function appendMsg(role, text) {
        var box = document.getElementById('chat-msgs');
        var empty = box.querySelector('.chat-empty');
        if (empty) empty.remove();
        var b = document.createElement('div');
        b.className = 'msg msg-' + role;
        b.textContent = text;
        box.appendChild(b);
        box.scrollTop = box.scrollHeight;
        return b;
      }
      function clearChildren(el) {
        while (el.firstChild) el.removeChild(el.firstChild);
      }
      function renderSuggestion(sug, oldTags) {
        chatSuggestion = sug;
        var diff = document.getElementById('chat-sug-diff');
        clearChildren(diff);
        var rows = [];
        function addRow(label, oldVal, newVal) {
          if (!newVal) return;
          var o = oldVal ? String(oldVal) : '（无）';
          var n = String(newVal);
          if (o === n) return;
          var row = document.createElement('div');
          row.className = 'diff-row';
          var lb = document.createElement('span');
          lb.className = 'diff-label';
          lb.textContent = label + '：';
          var od = document.createElement('span');
          od.className = 'diff-old';
          od.textContent = o;
          var nd = document.createElement('span');
          nd.className = 'diff-new';
          nd.textContent = '→ ' + n;
          row.appendChild(lb); row.appendChild(od); row.appendChild(nd);
          rows.push(row);
        }
        var ot = oldTags || {};
        addRow('描述', ot.description, sug.description);
        addRow('情绪', (ot.emotion || []).join('、'), (sug.emotion || []).join('、'));
        addRow('场景', (ot.scene || []).join('、'), (sug.scene || []).join('、'));
        addRow('关键词', (ot.keywords || []).join('、'), (sug.keywords || []).join('、'));
        if (rows.length === 0) {
          var noChange = document.createElement('div');
          noChange.className = 'diff-row';
          noChange.textContent = '小花暂时没看出要改的，你先说说哪里不对？';
          diff.appendChild(noChange);
        } else {
          for (var i = 0; i < rows.length; i++) diff.appendChild(rows[i]);
        }
        // v0.34.8 - 建议卡作为消息流里的一条卡片，move 到消息区末尾并异步滚动到底，
        //   确保完整 diff 与「确认修改 / 再看看」按钮随聊天流可达，不再挤在面板中间
        var sugEl = document.getElementById('chat-sug');
        var box = document.getElementById('chat-msgs');
        box.appendChild(sugEl);
        sugEl.hidden = false;
        box.scrollTop = box.scrollHeight;
        reportChatSize();
      }
      function hideSuggestion() {
        chatSuggestion = null;
        var sug = document.getElementById('chat-sug');
        if (sug && !sug.hidden) { sug.hidden = true; reportChatSize(); }
      }
      async function sendChat() {
        var input = document.getElementById('chat-input');
        var msg = input.value.trim();
        if (!msg || chatBusy) return;
        appendMsg('user', msg);
        input.value = '';
        input.style.height = ''; // v0.34.2 - 清空后恢复默认高度，不残留上一帧的内联高度
        chatBusy = true;
        var sendBtn = document.getElementById('chat-send-btn');
        sendBtn.disabled = true;
        sendBtn.textContent = '思考中...';
        var thinking = appendMsg('thinking', '小花正在思考...');
        try {
          var res = await fetch(apiBase() + '/api/sticker/chat' + authQuery(), authInit({
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sticker_id: cfg.id, message: msg, session_id: chatSessionId })
          }));
          var data = await res.json();
          thinking.remove();
          // 失败回合也可能带回聊天号，保留它才能让“继续”沿用当前上下文。
          if (data.session_id) chatSessionId = data.session_id;
          if (data.ok) {
            appendMsg('assistant', data.reply || '（无回复）');
            if (data.suggestion) renderSuggestion(data.suggestion, data.old_tags || {});
            else hideSuggestion();
          } else {
            appendMsg('error', '出错：' + (data.error || '未知错误'));
          }
        } catch (e) {
          thinking.remove();
          appendMsg('error', '网络开小差了，再试一次？');
        }
        chatBusy = false;
        sendBtn.disabled = false;
        sendBtn.textContent = '发送';
        input.focus();
      }
      async function confirmSuggestion() {
        if (!chatSessionId || !chatSuggestion || chatBusy) return;
        chatBusy = true;
        var btn = document.getElementById('chat-sug-yes');
        var requestSessionId = chatSessionId;
        var requestStickerId = cfg.id;
        var requestSuggestion = chatSuggestion;
        var finished = false;
        btn.disabled = true;
        btn.textContent = '保存中...';
        // v0.34.10 - 确认接口只写本地元数据，向量重算已在后端异步处理，正常应立即返回。
        //   这里不绑定 AbortController/AbortSignal：部分宿主 iframe 对 fetch 的 signal 支持不完整，
        //   会在请求尚未发出时直接抛异常，误报「网络开小差了」。
        var confirmInit = {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ session_id: requestSessionId, sticker_id: requestStickerId, new_tags: requestSuggestion })
        };
        function resetConfirmButton() {
          if (!btn) return;
          btn.disabled = false;
          btn.textContent = '确认修改';
        }
        function finishConfirm(recovered) {
          finished = true;
          showToast(recovered ? '已修改（刚才回包晚了一点）' : '已修改');
          closeChat();
        }
        try {
          var res = await timedFetch(apiBase() + '/api/sticker/chat/confirm' + authQuery(), authInit(confirmInit), 30000);
          var data;
          try { data = await timedPromise(res.json(), 5000); } catch (e) { data = null; }
          if (data && data.ok) {
            // 后端确认成功即标签已落盘（向量异步重算，不阻塞）。
            finishConfirm(false);
          } else if (await recoverConfirmedChange(requestStickerId, requestSuggestion)) {
            // 兼容“后端已写入、但响应体没回到 iframe”的半成功请求。
            finishConfirm(true);
          } else {
            var errMsg = (data && data.error) ? data.error : ('HTTP ' + res.status);
            if (res.status === 409) {
              showToast('确认回包没接到，修改建议先留着；可以继续聊一轮后再确认', true);
            } else {
              showToast('保存失败：' + errMsg, true);
            }
          }
        } catch (e) {
          // 网络/超时先回查落盘结果，只有查不到时才保留重试入口。
          if (await recoverConfirmedChange(requestStickerId, requestSuggestion)) {
            finishConfirm(true);
          } else {
            var isTimeout = e && (e.name === 'AbortError' || e.name === 'TimeoutError');
            showToast(isTimeout ? '网络有点慢，结果还没确认，再点一次' : '网络开小差了，结果还没确认，再点一次', true);
          }
        } finally {
          chatBusy = false;
          if (!finished) resetConfirmButton();
        }
      }
      function openChat() {
        chatMode = true;
        window.__CHAT_MODE__ = true;
        document.getElementById('img-card').style.display = 'none';
        document.getElementById('fb-card').style.display = 'none';
        hideInvite();
        // v0.34.2 - 打开时按当前视口定面板高度，与上报值一致（CSS 默认 420 作兜底）
        chatPanel.style.height = chatFixedHeight() + 'px';
        chatPanel.hidden = false;
        var mini = document.getElementById('chat-mini-img');
        var big = document.querySelector('.img-card img');
        if (mini && big) mini.src = big.src;
        var box = document.getElementById('chat-msgs');
        if (box.childNodes.length === 0) {
          var empty = document.createElement('div');
          empty.className = 'chat-empty';
          empty.textContent = '告诉我哪里不对、该怎么调。\\n比如：这张图表达的是撒娇不是开心';
          box.appendChild(empty);
        }
        setTimeout(function () { document.getElementById('chat-input').focus(); }, 100);
        reportChatSize();
      }
      function closeChat() {
        chatMode = false;
        window.__CHAT_MODE__ = false;
        chatPanel.hidden = true;
        // v0.25.0 - 收起时也藏掉建议面板，避免重开后幽灵面板残留（确认按钮点了没反应）
        var sugEl = document.getElementById('chat-sug');
        if (sugEl && !sugEl.hidden) sugEl.hidden = true;
        document.getElementById('img-card').style.display = '';
        document.getElementById('fb-card').style.display = '';
        if (state === 'negative') showInvite();
        if (chatSessionId) {
          fetch(apiBase() + '/api/sticker/chat/close' + authQuery(), authInit({
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ session_id: chatSessionId })
          })).catch(function () {});
          chatSessionId = null;
        }
        chatSuggestion = null;
        reportChatSize();
      }
      function postResize(payload) {
        var msg = {
          protocol: 'hana.plugin.ui',
          version: 1,
          kind: 'event',
          type: 'ui.resize',
          payload: payload
        };
        window.parent.postMessage(msg, '*');
        // v0.33.70 - devkit 1.0 宿主（0.686+）兼容裸原始事件；双发幂等，老宿主忽略未知格式
        window.parent.postMessage({ type: 'ui.resize', payload: payload }, '*');
        // v0.33.4 - 0.712.5 宿主聊天流内嵌卡（wd 组件）消息归一化 ru() 的裸分支**只认 resize-request**：
        //   e.type==="resize-request" 且 payload 带 width/height 才返回 {kind:'resize',size}；
        //   裸 ui.resize 在裸分支直接 return null，协议消息又要过 Oo 校验，两条老通道都会静默丢失。
        //   补发宿主真正认的裸格式；老宿主（<0.686）忽略未知 type，无副作用。
        window.parent.postMessage({ type: 'resize-request', payload: payload }, '*');
      }
      // v0.33.4 - 挂到 window：fitCard 在第二个独立 IIFE 里调用 postResize，
      //   不挂 window 的话每次执行都 ReferenceError，尺寸上报从未发出（宿主永远拿不到真实宽高）
      window.postResize = postResize;
      // v0.34.2 - 聊天面板固定高度，打破「上报高度 → 宿主改 iframe → 面板随 100vh 收缩 → 再上报」
      //   的自引用循环（每打一个字 input 事件重设 textarea 高度 + 上报，宿主应用时有损耗就累积缩小，
      //   输入框被压成一条缝）。面板高度只在上报一次后保持不变，内容变化全部在面板内部消化。
      // v0.34.6 - 高度上限 420→470：建议区 diff 需要更多空间展示修改前后对照，
      //   宿主对 card 槽位高度 clamp 上限是 600，470 安全。
      var CHAT_PANEL_H = 470;
      var lastChatHeight = 0;
      function chatFixedHeight() {
        // 小屏兜底：不超过视口可用高度太多
        return Math.min(CHAT_PANEL_H, Math.max(240, window.innerHeight - 120));
      }
      function reportChatSize() {
        if (!chatMode) return;
        var width = Math.max(50, Math.min(400, Math.round(window.innerWidth)));
        var height = chatFixedHeight();
        if (height === lastChatHeight) return; // 高度没变化不上报，避免重复 resize 触发宿主再处理
        lastChatHeight = height;
        postResize({ height: height, width: width });
      }

      posBtn.addEventListener('click', function () { sendFb('image'); });
      fitBtn.addEventListener('click', function () { sendFb('context'); });
      negBtn.addEventListener('click', function () { sendFb('negative'); });
      document.getElementById('chat-open-btn').addEventListener('click', openChat);
      document.getElementById('chat-close-btn').addEventListener('click', closeChat);
      document.getElementById('chat-send-btn').addEventListener('click', sendChat);
      var chatInput = document.getElementById('chat-input');
      chatInput.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); }
      });
      chatInput.addEventListener('input', function () {
        // v0.34.2 - 输入框只在自己真实变高时才改高度（打破 scrollHeight 负反馈），面板高度固定后无需再上报
        var lineH = 20;
        var want = Math.min(Math.max(this.scrollHeight, lineH + 2), 80);
        if (Math.abs(want - this.offsetHeight) > 4) {
          this.style.height = 'auto';
          this.style.height = want + 'px';
        }
      });
      document.getElementById('chat-sug-yes').addEventListener('click', confirmSuggestion);
      document.getElementById('chat-sug-no').addEventListener('click', function () {
        appendMsg('assistant', '好的，那先不动这张图。');
        hideSuggestion();
      });
    })();
  </script>
  <script>
    // v0.22.0 - 卡片高度自适应：按图片比例上报高度，消除四周大白边
    // v0.24.0 - 小图自适应开关：尺寸够大的图永远放大填满；小于阈值的小图才看开关（怕糊可关）
    // v0.33.1 - 自适应二分化：图片短边 < 400 保持原尺寸贴图，≥ 400 放大填满 400。废弃四档。
    (function () {
      var FIT = ${fitEnabled ? 'true' : 'false'};
      var FIT_THRESHOLD = ${fitThreshold};
      var AUTO_FIT_MAX = ${AUTO_FIT_MAX}; // 宿主槽位宽上限（前后端同源）
      // v0.28.0 - 反馈按钮开关：关闭时宽度不再给按钮区留空间
      var FBN = ${showFb ? 'true' : 'false'};
      // v0.33.77 - 图片尺寸档位：auto=智能自适应（原行为），small/medium/large=固定宽
      var SIZE_MODE = '${sizeMode}';
      var SIZE_MODE_WIDTH = { small: 160, medium: 260, large: 400 };
      var IMG = document.querySelector('.img-card img');
      var FB_CARD = document.querySelector('.fb-card');
      // v0.33.0 - 与宿主槽位口径一致：宽度生效区间 [50,400]，高度 [30,600]（宿主对 card 槽位的 clamp）
      function clampW(v) { return Math.max(50, Math.min(400, Math.round(v))); }
      function clampH(v) { return Math.max(30, Math.min(600, Math.round(v))); }
      // v0.33.1 - 二分决策：fit=是否放大填满，cap=目标显示宽度（null=不放大/原尺寸）
      // v0.33.72 - 智能开时一律放大填满（0.686+ 聊天流宽度锁死，ui.resize 不生效，
      //   小图不再贴原尺寸；关智能才回退旧阈值行为（≥200 放大、<200 原尺寸防糊））
      // v0.33.77 - 固定档：默认按档位宽显示
      // v0.33.78 - 固定档 + 小图自适应开：原图小于档位宽时不放大（按原尺寸），避免小图被拉伸糊掉；
      //   关时所有图一律按档位宽（强行统一尺寸）。auto 档保持原行为。
      function fitDecision(minSide) {
        if (SIZE_MODE !== 'auto') {
          var capW = SIZE_MODE_WIDTH[SIZE_MODE];
          if (FIT && minSide < capW) return { fit: false, cap: null };  // 小图自适应开 + 图比档位小 → 原尺寸
          return { fit: true, cap: capW };
        }
        if (!FIT) return { fit: minSide >= FIT_THRESHOLD, cap: null };  // 关：回退旧行为（阈值默认 200）
        return { fit: true, cap: AUTO_FIT_MAX };
      }
      function fitCard() {
        // v0.25.0 - 聊天模式：高度由聊天面板决定（脚本1 reportChatSize 负责），这里不覆盖
        if (window.__CHAT_MODE__) return;
        if (!IMG || !IMG.naturalWidth) return;
        var d = fitDecision(Math.min(IMG.naturalWidth, IMG.naturalHeight));
        if (d.fit) IMG.classList.add('fit');
        else IMG.classList.remove('fit');
        var ratio = IMG.naturalHeight / IMG.naturalWidth;
        var w = window.innerWidth;
        var displayW = d.fit ? (d.cap ? Math.min(w, d.cap) : w) : Math.min(w, IMG.naturalWidth);
        // v0.33.4 - 去掉 img-card 边框后，宽度直接贴图宽（原 +14 是边框+内边距补偿）
        document.getElementById('img-card').style.width = (displayW) + 'px';
        // v0.28.0 - 高度自适应：按钮显示时按按钮区实际高度放大卡片；隐藏时只留图片卡片自身留白，底部不再有白边
        var imgH = Math.round(displayW * ratio);
  // v0.33.102 - 前端 displayW 上限对齐后端 aspectRatio：fit 时 cap 恒 ≤400、原尺寸分支受宿主 iframe 宽约束
  //   （window.innerWidth ≤ 400，min(宽, naturalWidth) 天然封顶），横图/超宽扁图不再撑出比后端高的卡。
  displayW = Math.min(displayW, 400);
  imgH = Math.round(displayW * ratio);
        // v0.33.2 - 按钮「真实可见」统一判定（配置显示且未 hidden）
        var fbBtnVisible = FBN && FB_CARD && !FB_CARD.hidden;
        var fbH = fbBtnVisible ? FB_CARD.offsetHeight : 0;
        if (fbBtnVisible && fbH < 30) fbH = 30;  // 高度兜底：按钮区至少 30px，防止首帧太低冒出滚动条把宽度吃掉
        var extra = 12;                 // body 上下 padding 6*2
        if (fbH > 0) extra += 8 + fbH;  // 图片卡片与按钮区的 gap 8 + 按钮区实际高度
        var target = imgH + extra;      // v0.33.4 - img-card 无边框无内边距，不再 +14
        target = clampH(target);
        var payload = { height: target };
        // v0.33.73 - 宽度兜底改为「按钮行固有需求宽」：
        //   旧逻辑用 FB_CARD.offsetWidth 当基准，但 iframe 被宿主开窄时 offsetWidth 已被压缩失真，
        //   拿到的是“被挤扁后的宽度”，越窄越不准，最右的「不喜欢」依然会被裁掉。
        //   现在用按钮固有宽（每枚按钮 offsetWidth 在窄容器里可能也失真，取滚动内容宽 scrollWidth 兜底）
        //   + 间距合成需求宽，上报 max(图宽, 按钮需求宽)，按钮行永远完整显示。
        // v0.33.76 - 按钮行两侧留白：fb-card 带 padding 10px 左右，scrollWidth 已含 padding，
        //   宿主按需求宽开窗后按钮不贴边；gap 改为 6px 缩小按钮间距。
        var BTN_EST_W = 210; // 首帧未布局时的保守估算（三枚按钮+gap+padding 实测约 210px）
        if (displayW < w) {
          var fbBtnW = fbBtnVisible ? FB_CARD.offsetWidth : 0;
          var needBtnW = 0;
          if (fbBtnVisible) {
            var scrollW = FB_CARD.scrollWidth;              // 含 padding 的内容宽（三按钮+gap+左右留白）
            var sumBtn = 0;                                  // 三枚按钮固有宽之和
            var btns = FB_CARD.querySelectorAll('.fb-btn');
            for (var bi = 0; bi < btns.length; bi++) sumBtn += btns[bi].offsetWidth;
            sumBtn += (btns.length - 1) * 6;                 // gap 6px × 间隔数（v0.33.76 缩小间距）
            needBtnW = Math.max(scrollW, sumBtn + 20);      // 按钮+间距+两侧 padding 10px×2
            needBtnW = Math.max(needBtnW, fbBtnW);
            if (needBtnW === 0) needBtnW = BTN_EST_W;       // 首帧未布局时用估算兜底
          }
          var imgCardW = displayW;
          var contentW = fbBtnVisible ? Math.max(imgCardW, needBtnW) : imgCardW;
          var targetW = clampW(contentW);
          if (targetW > 0) payload.width = targetW;
        }
        postResize(payload);
      }
      if (IMG) {
        // v0.33.2 - 加载完成后等两帧再量尺寸：让下方反馈按钮区完成布局（off-…Width/Height 就绪），
        //   避免首帧把按钮区当作 0 高度/宽度导致上报过窄过矮、按钮被裁或变形。
        function runFit() {
          window.requestAnimationFrame(function () { window.requestAnimationFrame(fitCard); });
        }
        if (IMG.complete) runFit();
        else IMG.addEventListener('load', runFit);
      }
      window.addEventListener('resize', fitCard);
    })();
  </script>
</body>
</html>`, 200);
  });
}
