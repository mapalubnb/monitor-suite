#!/usr/bin/env bash
# ============================================================
# install.sh — 一键部署 fourmeme-monitor + flap-monitor
# 适用于 Ubuntu 24.04 (LTS) x64 / DigitalOcean
# 用法: sudo bash install.sh
# ============================================================

set -euo pipefail

SUITE_DIR="/root/monitor-suite"
CURRENT_DIR="$(cd "$(dirname "$0")" && pwd)"

# 如果从源码目录运行，PM2 直接从源码子目录启动（不复制到外面）
if [ "$CURRENT_DIR" = "$SUITE_DIR" ]; then
  FOURMEME_DIR="$SUITE_DIR/fourmeme-monitor"
  FLAP_DIR="$SUITE_DIR/flap-monitor"
else
  FOURMEME_DIR="/root/fourmeme-monitor"
  FLAP_DIR="/root/flap-monitor"
fi

sync_env_template_keys() {
  local env_file="$1"
  local template_file="$2"

  if [ ! -f "$template_file" ]; then
    return
  fi

  if [ ! -f "$env_file" ]; then
    cp "$template_file" "$env_file"
    echo "  .env 模板已生成，请编辑填入真实密钥: $env_file"
    return
  fi

  local missing_file
  missing_file="$(mktemp)"
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      ""|\#*) continue ;;
      *=*)
        key="${line%%=*}"
        if ! grep -qE "^${key}=" "$env_file"; then
          printf '%s\n' "$line" >> "$missing_file"
        fi
        ;;
    esac
  done < "$template_file"

  if [ -s "$missing_file" ]; then
    {
      echo ""
      echo "# ---- Added by install.sh $(date '+%Y-%m-%d %H:%M:%S') from .env.example ----"
      cat "$missing_file"
    } >> "$env_file"
    echo "  .env 已补齐缺失配置项: $env_file"
  else
    echo "  .env 已存在且配置项完整: $env_file"
  fi
  rm -f "$missing_file"
}

migrate_env_default_value() {
  local env_file="$1"
  local key="$2"
  local old_value="$3"
  local new_value="$4"

  if [ ! -f "$env_file" ]; then
    return
  fi

  if grep -qE "^${key}=${old_value}$" "$env_file"; then
    sed -i "s|^${key}=.*|${key}=${new_value}|" "$env_file"
    echo "  .env 已迁移旧默认值: ${key}=${old_value} → ${new_value}"
  fi
}

migrate_fourmeme_actor_env_defaults() {
  local env_file="$1"
  migrate_env_default_value "$env_file" "FOURMEME_CREATOR_PAGE_MAX_PER_RUN" "8" "2"
  migrate_env_default_value "$env_file" "FOURMEME_ACTOR_CONFIRMATIONS" "2" "1"
  migrate_env_default_value "$env_file" "FOURMEME_ACTOR_BOOTSTRAP_BLOCKS" "6" "20"
  migrate_env_default_value "$env_file" "FOURMEME_ACTOR_MAX_BLOCKS" "8" "80"
}

echo "========================================="
echo "  Monitor Suite 安装脚本"
echo "  - fourmeme-monitor (four.meme)"
echo "  - flap-monitor     (flap.sh)"
echo "========================================="

if [[ $EUID -ne 0 ]]; then
  echo "请使用 sudo 运行此脚本"
  exit 1
fi

# ── 1. 检查 Node.js ──
echo ""
echo "[1/6] 检查 Node.js..."
if ! command -v node &>/dev/null; then
  echo "  安装 Node.js 20.x..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
echo "  Node.js $(node -v)"

# ── 2. 检查 pm2 ──
echo "[2/6] 检查 pm2..."
if ! command -v pm2 &>/dev/null; then
  echo "  安装 pm2..."
  npm install -g pm2
fi
echo "  pm2 $(pm2 -v)"

# ── 3. 部署共享模块 + 配置 ──
SUITE_DIR="/root/monitor-suite"
SHARED_DIR="$SUITE_DIR/shared"
echo "[3/6] 部署共享模块 → ${SHARED_DIR}"
mkdir -p "$SHARED_DIR"
# 如果当前目录就是 SUITE_DIR，跳过复制（避免 cp same file 错误）
CURRENT_DIR="$(cd "$(dirname "$0")" && pwd)"
if [ "$CURRENT_DIR" != "$SUITE_DIR" ]; then
  cp shared/ai-client.mjs "$SHARED_DIR/"
  cp shared/feishu-client.mjs "$SHARED_DIR/"
  cp .env.example "$SUITE_DIR/.env.example"
  if [ ! -f "$SUITE_DIR/ai-models.json" ]; then
    cp ai-models.json "$SUITE_DIR/"
    echo "  ai-models.json 已安装"
  else
    echo "  ai-models.json 已存在，跳过（保留现有配置）"
  fi
  cp package.json "$SUITE_DIR/"
else
  echo "  源码目录即部署目录，跳过复制"
fi
# 安装共享依赖（@larksuiteoapi/node-sdk 等）
echo "  安装共享依赖..."
cd "$SUITE_DIR" && npm install --omit=dev && cd - >/dev/null
# .env：不存在则生成，已存在则补齐 .env.example 中新增的配置项
sync_env_template_keys "$SUITE_DIR/.env" "$SUITE_DIR/.env.example"
migrate_fourmeme_actor_env_defaults "$SUITE_DIR/.env"

# ── 4. 部署 fourmeme-monitor ──
echo "[4/6] 部署 fourmeme-monitor → ${FOURMEME_DIR}"
mkdir -p "$FOURMEME_DIR"
# 如果源目录和目标不同才复制
if [ "$(cd fourmeme-monitor && pwd)" != "$(cd "$FOURMEME_DIR" 2>/dev/null && pwd)" ]; then
  cp fourmeme-monitor/monitor.mjs "$FOURMEME_DIR/"
  cp fourmeme-monitor/package.json "$FOURMEME_DIR/"
  cp fourmeme-monitor/feishu-bot.mjs "$FOURMEME_DIR/"
  # 创建 shared 软链接（让 import "../shared/..." 能正确解析）
  ln -sfn "$SHARED_DIR" "$FOURMEME_DIR/../shared"
  ln -sfn "$SUITE_DIR/ai-models.json" "$FOURMEME_DIR/../ai-models.json"
  ln -sfn "$SUITE_DIR/.env" "$FOURMEME_DIR/../.env"
fi
cd "$FOURMEME_DIR" && npm install --omit=dev && cd - >/dev/null

pm2 delete fourmeme-monitor 2>/dev/null || true
# 创建 .env 文件（如不存在）供快捷命令写入配置
touch "$FOURMEME_DIR/.env"
pm2 start "$FOURMEME_DIR/monitor.mjs" --name fourmeme-monitor --time

# feishu-bot（如果之前启动过也重建）
pm2 delete feishu-bot 2>/dev/null || true
pm2 start "$FOURMEME_DIR/feishu-bot.mjs" --name feishu-bot --time

echo "  fourmeme-monitor ✓"

# ── 5. 部署 flap-monitor ──
echo "[5/6] 部署 flap-monitor → ${FLAP_DIR}"
mkdir -p "$FLAP_DIR"
# 如果源目录和目标不同才复制
if [ "$(cd flap-monitor && pwd)" != "$(cd "$FLAP_DIR" 2>/dev/null && pwd)" ]; then
  cp flap-monitor/monitor.mjs "$FLAP_DIR/"
  cp flap-monitor/package.json "$FLAP_DIR/"
  # 创建 shared 软链接
  ln -sfn "$SHARED_DIR" "$FLAP_DIR/../shared"
  ln -sfn "$SUITE_DIR/ai-models.json" "$FLAP_DIR/../ai-models.json"
  ln -sfn "$SUITE_DIR/.env" "$FLAP_DIR/../.env"
fi
cd "$FLAP_DIR" && npm install --omit=dev && cd - >/dev/null

pm2 delete flap-monitor 2>/dev/null || true
pm2 start "$FLAP_DIR/monitor.mjs" --name flap-monitor --time

echo "  flap-monitor ✓"

# pm2 持久化 + 开机自启
pm2 save
if pm2 startup systemd -u root --hp /root 2>/dev/null; then
  echo "  pm2 开机自启已配置"
else
  echo "  ⚠ pm2 开机自启配置失败（可能不支持 systemd），请手动配置"
fi

# ── 6. 安装快捷命令（可执行脚本，非 alias）──
echo "[6/6] 安装快捷命令到 /usr/local/bin/..."

BIN_DIR="/usr/local/bin"

# 清理旧版本遗留的心跳/日报快捷命令。
rm -f "$BIN_DIR/fm-daily" "$BIN_DIR/fm-heartbeat"

# 通用 pm2 进程状态显示工具（供其他命令复用）
cat > "$BIN_DIR/_pm2-proc-info" << 'HELPER_EOF'
#!/usr/bin/env node
// 用法: pm2 jlist | _pm2-proc-info <进程名> [--brief]
const name = process.argv[2];
const brief = process.argv.includes("--brief");
let d = "";
const statusText = (status) => ({
  online: "在线",
  stopped: "已停止",
  errored: "异常",
  launching: "启动中",
  stopping: "停止中",
  waiting: "等待中",
}[status] || "未知");
process.stdin.on("data", c => d += c);
process.stdin.on("end", () => {
  try {
    const clean = d.replace(/\u001b\[[0-?]*[ -\/]*[@-~]/g, "").trim();
    const start = clean.indexOf("[");
    const end = clean.lastIndexOf("]");
    const list = JSON.parse(start >= 0 && end >= start ? clean.slice(start, end + 1) : "[]");
    const p = list.find(x => x.name === name);
    if (!p) { console.log(brief ? "  未找到进程" : "  状态: 未运行"); return; }
    const env = p.pm2_env || {};
    if (brief) {
      console.log("  状态: " + statusText(env.status));
      console.log("  PID: " + p.pid);
      console.log("  重启次数: " + (env.restart_time ?? 0));
      return;
    }
    const mem = p.monit?.memory ? (p.monit.memory / 1024 / 1024).toFixed(1) + " MB" : "未知";
    const cpu = p.monit?.cpu ?? "未知";
    const up = env.pm_uptime ? Math.floor((Date.now() - env.pm_uptime) / 1000) : 0;
    const h = Math.floor(up / 3600), m = Math.floor((up % 3600) / 60), s = up % 60;
    console.log("  状态: " + statusText(env.status));
    console.log("  PID: " + p.pid);
    console.log("  内存: " + mem + "  |  CPU: " + cpu + "%");
    console.log("  运行时间: " + h + "h " + m + "m " + s + "s");
    console.log("  重启次数: " + (env.restart_time ?? 0));
  } catch (e) { console.log("  解析失败: " + e.message); }
});
HELPER_EOF
chmod +x "$BIN_DIR/_pm2-proc-info"

# fourmeme-monitor
cat > "$BIN_DIR/fm-status" << 'EOF'
#!/bin/sh
SNAP="/root/monitor-suite/fourmeme-monitor/snapshot.json"
[ -f "$SNAP" ] || SNAP="/root/fourmeme-monitor/snapshot.json"
PM2_JSON="$(pm2 jlist 2>/dev/null)"

echo "**Four.meme 监控中心**"
echo ""

echo "$PM2_JSON" | node -e "
  let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{
    const statusText=(status)=>({online:'在线',stopped:'已停止',errored:'异常',launching:'启动中',stopping:'停止中',waiting:'等待中'}[status]||'未知');
    const fmtUp=(ms)=>{if(!ms)return '未知';const sec=Math.max(0,Math.floor((Date.now()-ms)/1000));const day=Math.floor(sec/86400),h=Math.floor((sec%86400)/3600),m=Math.floor((sec%3600)/60);return day>0?day+' 天 '+h+' 小时':h+' 小时 '+m+' 分钟'};
    try{
      const clean=d.replace(/\u001b\[[0-?]*[ -\/]*[@-~]/g,'').trim();
      const start=clean.indexOf('['),end=clean.lastIndexOf(']');
      const list=JSON.parse(start>=0&&end>=start?clean.slice(start,end+1):'[]');
      const p=list.find(x=>x.name==='fourmeme-monitor');
      console.log('**01｜运行状态**');
      if(!p){
        console.log('进程：未运行');
        return;
      }
      const env=p.pm2_env||{};
      const mem=p.monit?.memory?(p.monit.memory/1024/1024).toFixed(1)+' MB':'未知';
      const cpu=(p.monit?.cpu??0)+'%';
      console.log('进程：'+statusText(env.status)+'｜PID '+(p.pid||'-')+'｜重启 '+(env.restart_time??0)+' 次');
      console.log('资源：内存 '+mem+'｜CPU '+cpu+'｜运行 '+fmtUp(env.pm_uptime));
    }catch(e){
      console.log('**01｜运行状态**');
      console.log('进程：状态解析失败');
    }
  })
"

if [ -f "$SNAP" ]; then
  echo ""
  node -e "
    const s=JSON.parse(require('fs').readFileSync('$SNAP','utf-8'));
    const mdLink=(label,url)=>'['+label+']('+url+')';
    const isAddr=(v)=>/^0x[a-fA-F0-9]{40}$/.test(String(v||''));
    const bscAddress=(addr,label)=>addr?mdLink(label||addr,'https://bscscan.com/address/'+addr):'-';
    const pageLabel=(url)=>String(url||'-');
    const fmtTime=(value)=>{if(!value)return '未知';const d=new Date(value);if(Number.isNaN(d.getTime()))return String(value);const p=n=>String(n).padStart(2,'0');return d.getFullYear()+'-'+p(d.getMonth()+1)+'-'+p(d.getDate())+' '+p(d.getHours())+':'+p(d.getMinutes())+':'+p(d.getSeconds())};
    const value=(v)=>v===undefined||v===null||v===''?'-':String(v);
    const quote=String.fromCharCode(34);
    const colorStatus=(status)=>{const text=value(status);if(text==='PUBLISH')return '<font color='+quote+'green'+quote+'>PUBLISH</font>';if(text==='INIT')return '<font color='+quote+'red'+quote+'>INIT</font>';return text};
    const apiLinks={
      public_config:['/v1/public/config','https://four.meme/meme-api/v1/public/config'],
      public_address:['/v1/public/address','https://four.meme/meme-api/v1/public/address'],
      public_file_host:['/v1/public/file/host','https://four.meme/meme-api/v1/public/file/host'],
      kol_teams:['/v1/public/kol/teams','https://four.meme/meme-api/v1/public/kol/teams?tcs=fm25'],
      kol_traders:['/v1/public/kol/traders','https://four.meme/meme-api/v1/public/kol/traders?tcs=fm25'],
      token_ranking_cap:['/v1/public/token/ranking CAP','https://four.meme/meme-api/v1/public/token/ranking'],
      token_ranking_binance:['/v1/public/token/ranking BINANCE','https://four.meme/meme-api/v1/public/token/ranking'],
      token_search_new:['/v1/public/token/search NEW','https://four.meme/meme-api/v1/public/token/search'],
      token_search_cap:['/v1/public/token/search CAP','https://four.meme/meme-api/v1/public/token/search']
    };

    const allPools=s.poolConfig||[];
    const networks={};
    for(const p of allPools){const n=p.networkCode||'?';networks[n]=(networks[n]||0)+1}
    const netStr=Object.entries(networks).map(([k,v])=>k+' '+v).join('、')||'-';
    const canonicalFrontendUrl=(url)=>{try{const u=new URL(url,'https://four.meme');u.hash='';if(u.pathname!=='/'&&u.pathname.endsWith('/'))u.pathname=u.pathname.replace(/\/+$/,'');return u.origin+(u.pathname==='/'?'':u.pathname)+u.search}catch{return url}};
    const removedFrontendUrls=new Set([
      'https://four.meme/zh-TW/create-token?entry=X-mode',
      'https://four.meme/zh-TW/ja',
      'https://four.meme/zh-TW/vi'
    ].map(canonicalFrontendUrl));
    const pageEntries=Object.entries(s.frontendPages||{}).filter(([k,p])=>{
      const url=p&&p.originalUrl?canonicalFrontendUrl(p.originalUrl):'';
      return url&&!removedFrontendUrls.has(url);
    });
    const assetFiles=pageEntries.reduce((sum,[,p])=>sum+(p.assetFiles||[]).length,0);
    const downloaded=pageEntries.reduce((sum,[,p])=>sum+Object.keys(p.assetContents||{}).length,0);
    const i18nTotal=pageEntries.reduce((sum,[,p])=>sum+Object.keys(p.i18nStrings||{}).length,0);
    const api=s.apiStructure||{};
    const apiKeys=Object.keys(api);
    const templates=s.openFourTemplates||{};
    const templateKeys=Object.keys(templates);
    const published=templateKeys.filter(id=>String((templates[id]||{}).status||'').toUpperCase()==='PUBLISHED').length;
    const ofm=s.openFourModules||{};
    const moduleEntries=Object.entries(ofm.byAddress||{}).sort(([a],[b])=>a.localeCompare(b));
    const moduleItems=moduleEntries.map(([,m])=>m);
    const roleCounts={};
    for(const m of moduleItems) for(const r of m.roles||[]) roleCounts[r]=(roleCounts[r]||0)+1;
    const roleNames=Object.keys(roleCounts).sort();
    const sha=(s.githubSha||'')||'未知';
    const repoEntries=Object.values(s.githubRepos||{}).sort((a,b)=>String(a.full_name||'').localeCompare(String(b.full_name||'')));
    const repos=repoEntries.length;
    const fp=s.contractFingerprints||{};
    const fpKeys=Object.keys(fp);
    const op=s.onchainParams||{};
    const nfts=op.agentNfts||[];
    const am=s.chainActorMonitor||{};
    const allActors=am.actors||{};
    const actors=Object.keys(allActors).filter(a=>allActors[a]?.actionWatched);
    const cachedCreators=Object.values(am.creators||{}).filter(x=>x&&x.creator).length;
    const modes=[];
    if(am.creatorChainLookupEnabled) modes.push('RPC近期反查');
    if(am.creatorPageLookupEnabled) modes.push('BscScan页面自动抓取');
    if(am.creatorApiLookupEnabled) modes.push('Etherscan API备用');
    if(modes.length===0) modes.push('仅缓存/手动配置');
    const feed=am.blockFeed||{};
    const pendingRoutes=Object.values(s._frontendPendingRoutes||{}).filter(r=>r&&r.status==='pending').length;
    const ignoredRoutes=Object.values(s._frontendIgnoredRoutes||{}).filter(r=>r&&r.status==='ignored').length;
    const approvedRoutes=Object.values(s._frontendRouteApprovals||{}).filter(r=>r&&r.status==='approved').length;

    const color=(text,c)=>'<font color='+quote+c+quote+'>'+text+'</font>';
    const ok=(text)=>color(text,'green');
    const warn=(text)=>color(text,'orange');
    const bad=(text)=>color(text,'red');
    const compact=(arr)=>arr;
    const lag=am.actorLagBlocks??(am.safeLatestBlock?Math.max(0,am.safeLatestBlock-am.lastBlock):'-');
    const health=[];
    if(pendingRoutes>0) health.push(warn('新路由待确认 '+pendingRoutes));
    if(feed.enabled!==undefined&&!feed.connected) health.push(warn('新区块 WS 未连接'));
    if(typeof lag==='number'&&lag>120) health.push(warn('扫链延迟 '+lag+' 块'));

    console.log('**02｜总览**');
    console.log('状态：'+(health.length?warn('需要关注')+'｜'+health.join('｜'):ok('运行正常')));
    console.log('底池：'+allPools.length+' 个｜前端：'+pageEntries.length+' 个页面｜API：'+apiKeys.length+' 个端点｜合约：'+fpKeys.length+' 个');
    console.log('OpenFour：模板 '+templateKeys.length+' 个｜PUBLISHED '+published+' 个｜模块 '+moduleItems.length+' 个｜presetIds '+((ofm.presetIds||[]).length)+' 个');
    console.log('GitHub：仓库 '+repos+' 个｜最新提交 '+(sha&&sha!=='未知'?mdLink(sha,'https://github.com/four-meme-community/four-meme-ai/commit/'+sha):sha));
    console.log('');

    console.log('**03｜重点状态**');
    console.log('前端资源：JS/CSS '+assetFiles+' 个｜已下载 '+downloaded+' 个｜i18n '+i18nTotal+' 键');
    console.log('链上：AgentNFT '+(op.agentNftCount??'未知')+' 个｜创建者监听 '+actors.length+' 个｜缓存创建者 '+cachedCreators+' 个');
    console.log('新路由：待确认 '+pendingRoutes+' 个｜已纳管 '+approvedRoutes+' 个｜已忽略 '+ignoredRoutes+' 个');
    if(feed.enabled!==undefined) console.log('新区块：'+(feed.connected?ok('WS 已连接'):warn('WS 未连接'))+'｜模式 '+(feed.mode||'未知')+(feed.latestHeadBlock?'｜头块 '+feed.latestHeadBlock:''));
    console.log('扫链：已扫 '+(am.lastBlock||'未知')+'｜确认 '+(am.safeLatestBlock||'未知')+'｜延迟 '+lag+' 块');
    console.log('');

    console.log('**04｜底池配置**');
    if(allPools.length===0) console.log('暂无底池');
    for(const [index,p] of allPools.entries()) console.log(String(index+1).padStart(2,'0')+'　符号 '+value(p.symbol||p.nativeSymbol)+'｜状态 '+value(p.status)+'｜地址 '+bscAddress(p.symbolAddress)+'｜买入费 '+value(p.buyFee)+'｜卖出费 '+value(p.sellFee)+'｜初始金额 '+value(p.b0Amount)+'｜募集总量 '+value(p.totalBAmount));
    console.log('');

    console.log('**05｜前端页面**');
    if(pageEntries.length===0) console.log('暂无页面快照');
    for(const [index,[k,p]] of pageEntries.entries()) console.log(String(index+1).padStart(2,'0')+'　'+mdLink(pageLabel(p.originalUrl||k),p.originalUrl||k)+'｜资源 '+((p.assetFiles||[]).length)+' 个｜已下载 '+Object.keys(p.assetContents||{}).length+' 个｜i18n '+Object.keys(p.i18nStrings||{}).length+' 键');
    console.log('');

    console.log('**06｜公开 API**');
    if(apiKeys.length===0) console.log('暂无 API 快照');
    for(const [index,k] of apiKeys.entries()) console.log(String(index+1).padStart(2,'0')+'　'+(apiLinks[k]?mdLink(apiLinks[k][0],apiLinks[k][1]):k));
    console.log('');

    console.log('**07｜OpenFour**');
    console.log('Registry：'+bscAddress(ofm.registry||'0x912cef0c3ae9ab6eb3ec87cab69371cfb317ab94'));
    console.log('模块角色：'+(roleNames.length?roleNames.join('、'):'暂无'));
    console.log('presetIds：'+((ofm.presetIds||[]).length?(ofm.presetIds||[]).join(', '):'暂无'));
    if(moduleEntries.length===0) console.log('模块实现：暂无');
    for(const [index,[addr,m]] of moduleEntries.entries()) console.log('模块 '+String(index+1).padStart(2,'0')+'　'+bscAddress(addr)+'｜roles '+(m.roles||[]).join(', ')+'｜presetIds '+(m.presetIds||[]).join(', '));
    if(templateKeys.length===0) console.log('模板：暂无');
    for(const [index,id] of templateKeys.entries()){const t=templates[id]||{};console.log('模板 '+String(index+1).padStart(2,'0')+'　id '+id+'｜名称 '+value(t.name)+'｜状态 '+value(t.status)+'｜作者 '+value(t.userAddress))}
    console.log('');

    console.log('**08｜合约与链上资产**');
    if(fpKeys.length===0) console.log('合约：暂无');
    for(const [index,[name,data]] of Object.entries(fp).entries()) console.log('合约 '+String(index+1).padStart(2,'0')+'　'+name+'｜地址 '+value(data.address||data.contractAddress)+'｜实现 '+value(data.implAddress||data.implementation));
    console.log('AgentNFT 数量：'+value(op.agentNftCount));
    for(const [index,addr] of nfts.entries()) console.log('AgentNFT '+String(index+1).padStart(2,'0')+'　'+bscAddress(addr));
    console.log('');

    console.log('**09｜创建者动作监听**');
    console.log('发现方式：'+modes.join(' + '));
    if(actors.length===0) console.log('监听地址：暂无');
    for(const [index,addr] of actors.entries()){const item=allActors[addr]||{};console.log(String(index+1).padStart(2,'0')+'　'+bscAddress(addr)+'｜角色 '+(item.roles||[]).join(', ')+'｜标签 '+(item.labels||[]).join(', '))}
    console.log('');

    console.log('**10｜GitHub 仓库**');
    if(repoEntries.length===0) console.log('暂无仓库');
    for(const [index,repo] of repoEntries.entries()) console.log(String(index+1).padStart(2,'0')+'　'+mdLink(repo.full_name||repo.name,repo.html_url||('https://github.com/'+repo.full_name))+'｜默认分支 '+value(repo.default_branch)+'｜更新时间 '+value(repo.updated_at));
    console.log('');

    console.log('**11｜操作入口**');
    console.log('详情快照：snapshot.json｜日志：fm-log｜全量检测：fm-check');
    console.log('');
    console.log('更新时间：'+fmtTime(new Date()));
  " 2>/dev/null
  echo ""
  LASTPOLL="/root/monitor-suite/fourmeme-monitor/lastpoll.txt"
  [ -f "$LASTPOLL" ] || LASTPOLL="/root/fourmeme-monitor/lastpoll.txt"
  if [ -f "$LASTPOLL" ]; then
    echo "最后检测：$(cat "$LASTPOLL")"
  else
    echo "最后检测：未知"
  fi
  echo "快照更新：$(stat -c '%y' "$SNAP" 2>/dev/null | cut -d. -f1)"
else
  echo "**数据状态**"
  echo "快照：未找到"
  echo ""
  echo "更新时间：$(date '+%Y-%m-%d %H:%M:%S')"
fi
EOF

cat > "$BIN_DIR/fm-log" << 'EOF'
#!/bin/sh
LINES=${1:-80}
echo "====== fourmeme-monitor 日志 (最近 ${LINES} 行, 倒序) ======"
echo "时间: $(date '+%Y-%m-%d %H:%M:%S')"
PM2_HOME="${PM2_HOME:-/root/.pm2}"
echo "日志文件: $(ls -la $PM2_HOME/logs/fourmeme-monitor-out*.log 2>/dev/null | awk '{print $NF, $5}' | head -1)"
echo "错误日志: $(ls -la $PM2_HOME/logs/fourmeme-monitor-err*.log 2>/dev/null | awk '{print $NF, $5}' | head -1)"
echo "========================================="
pm2 logs fourmeme-monitor --lines "$LINES" --nostream 2>&1 | tac
EOF

cat > "$BIN_DIR/fm-restart" << 'EOF'
#!/bin/sh
echo "====== 重启 fourmeme-monitor ======"
echo "[$(date '+%H:%M:%S')] 正在重启..."
pm2 restart fourmeme-monitor --update-env
echo ""
echo "[$(date '+%H:%M:%S')] 重启完成，当前状态："
pm2 jlist 2>/dev/null | _pm2-proc-info fourmeme-monitor --brief
  echo "========================================="
EOF

cat > "$BIN_DIR/fm-stop" << 'EOF'
#!/bin/sh
pm2 stop fourmeme-monitor
echo "[$(date '+%H:%M:%S')] fourmeme-monitor 已停止"
EOF

cat > "$BIN_DIR/fm-check" << 'EOF'
#!/bin/sh
echo "====== 触发 fourmeme 全量检测 ======"
PID=$(pm2 pid fourmeme-monitor 2>/dev/null)
if [ -n "$PID" ] && [ "$PID" != "0" ]; then
  kill -USR1 "$PID"
  echo "[$(date '+%H:%M:%S')] 已向 PID $PID 发送 SIGUSR1"
  echo "提示: 使用 fm-log 查看检测结果"
else
  echo "fourmeme-monitor 未运行，使用 fm-restart 启动"
fi
echo "========================================="
EOF


# flap-monitor
cat > "$BIN_DIR/fl-status" << 'EOF'
#!/bin/sh
echo "**Flap.sh 监控中心**"
echo ""
echo "**01｜运行状态**"
pm2 jlist 2>/dev/null | _pm2-proc-info flap-monitor
# 快照摘要（兼容两种部署路径）
SNAP="/root/monitor-suite/flap-monitor/snapshot.json"
[ -f "$SNAP" ] || SNAP="/root/flap-monitor/snapshot.json"
if [ -f "$SNAP" ]; then
  echo ""
  node -e "
    const s=JSON.parse(require('fs').readFileSync('$SNAP','utf-8'));
    const mdLink=(label,url)=>'['+label+']('+url+')';
    const pageLabel=(url)=>String(url||'-');
    const fmtTime=(value)=>{if(!value)return '未知';const d=new Date(value);if(Number.isNaN(d.getTime()))return String(value);const p=n=>String(n).padStart(2,'0');return d.getFullYear()+'-'+p(d.getMonth()+1)+'-'+p(d.getDate())+' '+p(d.getHours())+':'+p(d.getMinutes())+':'+p(d.getSeconds())};
    const pages=s.pages||{};
    const keys=Object.keys(pages);
    const factories=s.vaultFactories||{};
    const factoryItems=Object.values(factories);
    const visibleFactoryItems=factoryItems.filter(v=>v&&v.showInCAStore);
    const visibleFactories=visibleFactoryItems.length;
    const enabledVisibleFactories=visibleFactoryItems.filter(v=>v&&v.enabled).length;
    const registry=s.registryMonitor||{};
    const registryAddress=registry.address||'0x90497450f2a706f1951b5bdda52b4e5d16f34c06';
    const knownVaults=Object.keys(registry.knownVaults||{});
    const safeLatest=registry.safeLatestBlock??'-';
    const lastBlock=registry.lastBlock??'-';
    const latest=registry.latestBlock??'-';
    const lag=registry.lagBlocks??(
      Number.isFinite(Number(safeLatest))&&Number.isFinite(Number(lastBlock))
        ? Math.max(0,Number(safeLatest)-Number(lastBlock))
        : '-'
    );

    const quote=String.fromCharCode(34);
    const color=(text,c)=>'<font color='+quote+c+quote+'>'+text+'</font>';
    const ok=(text)=>color(text,'green');
    const warn=(text)=>color(text,'orange');
    const health=[];
    if(typeof lag==='number'&&lag>300) health.push(warn('链上延迟 '+lag+' 块'));
    if(enabledVisibleFactories<visibleFactories) health.push(warn('有可见金库未启用'));

    const pageStats=keys.map(k=>{
      const f=pages[k]||{};
      const url=f.originalUrl||k;
      const assets=f.assetFiles||[];
      const i18n=f.i18nStrings?Object.keys(f.i18nStrings).length:0;
      return { url, label: pageLabel(url), assets: assets.length, text: (f.textContent||'').length, i18n };
    });
    const totalAssets=pageStats.reduce((sum,p)=>sum+p.assets,0);
    const totalText=pageStats.reduce((sum,p)=>sum+p.text,0);
    const totalI18n=pageStats.reduce((sum,p)=>sum+p.i18n,0);

    console.log('**02｜总览**');
    console.log('状态：'+(health.length?warn('需要关注')+'｜'+health.join('｜'):ok('运行正常')));
    console.log('页面：'+keys.length+' 个｜资源 '+totalAssets+' 个｜文案 '+totalText+' 字｜i18n '+totalI18n+' 键');
    console.log('金库工厂：总数 '+factoryItems.length+' 个｜CAStore 可见 '+visibleFactories+' 个｜已启用 '+enabledVisibleFactories+' 个｜链上金库 '+knownVaults.length+' 个');
    console.log('');

    console.log('**03｜页面监控**');
    if(pageStats.length===0) console.log('暂无页面快照');
    for(const [index,p] of pageStats.entries()) console.log(String(index+1).padStart(2,'0')+'　'+mdLink(p.label,p.url)+'｜资源 '+p.assets+' 个｜文案 '+p.text+' 字｜i18n '+p.i18n+' 键');
    console.log('');

    console.log('**04｜金库工厂**');
    console.log('可见：'+visibleFactories+' 个｜启用：'+enabledVisibleFactories+' 个｜隐藏或其他：'+Math.max(0,factoryItems.length-visibleFactories)+' 个');
    if(factoryItems.length===0) console.log('暂无金库工厂');
    for(const [index,v] of factoryItems.entries()){
      const name=v.name||v.id||v.factory||'未知金库';
      const factory=v.factory||v.address||'';
      const link=factory?mdLink(factory,'https://bscscan.com/address/'+factory):'无地址';
      console.log(String(index+1).padStart(2,'0')+'　名称 '+name+'｜地址 '+link+'｜启用 '+(v.enabled?'是':'否')+'｜CAStore 展示 '+(v.showInCAStore?'是':'否'));
    }
    console.log('');

    console.log('**05｜链上注册中心**');
    console.log('注册中心：'+mdLink(registryAddress,'https://bscscan.com/address/'+registryAddress));
    console.log('扫描进度：已扫 '+lastBlock+'｜确认 '+safeLatest+'｜最新 '+latest+'｜延迟 '+lag+' 块');
    console.log('已知链上金库：'+knownVaults.length+' 个');
    for(const [index,addr] of knownVaults.entries()) console.log(String(index+1).padStart(2,'0')+'　'+mdLink(addr,'https://bscscan.com/address/'+addr));
    console.log('');

    console.log('**06｜操作入口**');
    console.log('详情快照：snapshot.json｜日志：fl-log｜全量检测：fl-check');
    console.log('更新时间：'+fmtTime(new Date()));
  " 2>/dev/null
  echo ""
  LASTPOLL="/root/monitor-suite/flap-monitor/lastpoll.txt"
  [ -f "$LASTPOLL" ] || LASTPOLL="/root/flap-monitor/lastpoll.txt"
  [ -f "$LASTPOLL" ] && echo "最后检测：$(cat "$LASTPOLL")"
  echo "快照更新：$(stat -c '%y' "$SNAP" 2>/dev/null | cut -d. -f1)"
else
  echo ""
  echo "**02｜数据状态**"
  echo "快照：未找到"
  echo ""
  echo "更新时间：$(date '+%Y-%m-%d %H:%M:%S')"
fi
EOF

cat > "$BIN_DIR/fl-log" << 'EOF'
#!/bin/sh
LINES=${1:-80}
echo "====== flap-monitor 日志 (最近 ${LINES} 行, 倒序) ======"
echo "时间: $(date '+%Y-%m-%d %H:%M:%S')"
PM2_HOME="${PM2_HOME:-/root/.pm2}"
echo "日志文件: $(ls -la $PM2_HOME/logs/flap-monitor-out*.log 2>/dev/null | awk '{print $NF, $5}' | head -1)"
echo "错误日志: $(ls -la $PM2_HOME/logs/flap-monitor-err*.log 2>/dev/null | awk '{print $NF, $5}' | head -1)"
echo "========================================="
pm2 logs flap-monitor --lines "$LINES" --nostream 2>&1 | tac
EOF

cat > "$BIN_DIR/fl-restart" << 'EOF'
#!/bin/sh
echo "====== 重启 flap-monitor ======"
echo "[$(date '+%H:%M:%S')] 正在重启..."
pm2 restart flap-monitor
echo ""
echo "[$(date '+%H:%M:%S')] 重启完成，当前状态："
pm2 jlist 2>/dev/null | _pm2-proc-info flap-monitor --brief
echo "========================================="
EOF

cat > "$BIN_DIR/fl-stop" << 'EOF'
#!/bin/sh
pm2 stop flap-monitor
echo "[$(date '+%H:%M:%S')] flap-monitor 已停止"
EOF

cat > "$BIN_DIR/fl-check" << 'EOF'
#!/bin/sh
echo "====== 触发 flap 全量检测 ======"
PID=$(pm2 pid flap-monitor 2>/dev/null)
if [ -n "$PID" ] && [ "$PID" != "0" ]; then
  kill -USR1 "$PID"
  echo "[$(date '+%H:%M:%S')] 已向 PID $PID 发送 SIGUSR1"
  echo "提示: 使用 fl-log 查看检测结果"
else
  echo "flap-monitor 未运行，使用 fl-restart 启动"
fi
echo "========================================="
EOF

cat > "$BIN_DIR/fl-check-manual" << 'EOF'
#!/bin/sh
echo "[$(date '+%H:%M:%S')] flap 手动检测（独立进程）..."
node /root/flap-monitor/monitor.mjs check
echo "[$(date '+%H:%M:%S')] 检测完成"
EOF

# feishu-bot
cat > "$BIN_DIR/bot-status" << 'EOF'
#!/bin/sh
echo "**飞书机器人状态**"
echo ""
echo "**01｜运行状态**"
pm2 jlist 2>/dev/null | _pm2-proc-info feishu-bot
echo ""
echo "**02｜服务能力**"
echo "模式：WebSocket 长连接｜无需公网 IP"
echo "能力：命令执行｜状态查询｜日志附件｜卡片交互｜AI 助手"
echo ""
echo "**03｜操作入口**"
echo "发送 \`help\` 查看全部指令"
echo ""
echo "更新时间：$(date '+%Y-%m-%d %H:%M:%S')"
EOF

cat > "$BIN_DIR/bot-log" << 'EOF'
#!/bin/sh
LINES=${1:-80}
echo "====== feishu-bot 日志 (最近 ${LINES} 行, 倒序) ======"
echo "时间: $(date '+%Y-%m-%d %H:%M:%S')"
echo "========================================="
pm2 logs feishu-bot --lines "$LINES" --nostream 2>&1 | tac
EOF

cat > "$BIN_DIR/bot-restart" << 'EOF'
#!/bin/sh
echo "====== 重启 feishu-bot ======"
echo "[$(date '+%H:%M:%S')] 正在重启..."
pm2 restart feishu-bot
echo ""
echo "[$(date '+%H:%M:%S')] 重启完成，当前状态："
pm2 jlist 2>/dev/null | _pm2-proc-info feishu-bot --brief
echo "========================================="
EOF

cat > "$BIN_DIR/bot-stop" << 'EOF'
#!/bin/sh
pm2 stop feishu-bot
echo "[$(date '+%H:%M:%S')] feishu-bot 已停止"
EOF

# 全局
cat > "$BIN_DIR/mon-status" << 'EOF'
#!/bin/sh
echo "**Monitor Suite 状态总览**"
echo ""
echo "**01｜主机状态**"
echo "主机：$(hostname)｜内核 $(uname -r)"
echo "负载：$(cat /proc/loadavg 2>/dev/null | awk '{print $1, $2, $3}' || echo '未知')"
echo ""
echo "**02｜进程状态**"
pm2 jlist 2>/dev/null | node -e "
  let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{
    try{
      const clean=d.replace(/\u001b\[[0-?]*[ -\/]*[@-~]/g,'').trim();
      const start=clean.indexOf('['),end=clean.lastIndexOf(']');
      const list=JSON.parse(start>=0&&end>=start?clean.slice(start,end+1):'[]');
      const statusText=(status)=>({
        online:'在线',
        stopped:'已停止',
        errored:'异常',
        launching:'启动中',
        stopping:'停止中',
        waiting:'等待中',
      }[status]||'未知');
      const services=[
        {name:'fourmeme-monitor', label:'Four.meme 监控', desc:'OpenFour + 多模块全面监控'},
        {name:'flap-monitor',     label:'Flap.sh 监控',   desc:'页面/资源/文案监控'},
        {name:'feishu-bot',       label:'飞书交互机器人',   desc:'WebSocket 长连接'},
      ];
      for(const svc of services){
        const p=list.find(x=>x.name===svc.name);
        if(!p){console.log(svc.label+'｜未部署');continue}
        const env=p.pm2_env||{};
        const mem=p.monit?.memory?(p.monit.memory/1024/1024).toFixed(1)+'MB':'?';
        const cpu=(p.monit?.cpu??0)+'%';
        const up=env.pm_uptime?Math.floor((Date.now()-env.pm_uptime)/1000):0;
        const d=Math.floor(up/86400),h=Math.floor((up%86400)/3600),m=Math.floor((up%3600)/60);
        const upStr=d>0?d+'d '+h+'h '+m+'m':h+'h '+m+'m';
        const restarts=env.restart_time||0;
        console.log(svc.label+'｜'+statusText(env.status)+'｜PID '+String(p.pid)+'｜内存 '+mem+'｜CPU '+cpu+'｜运行 '+upStr+'｜重启 '+restarts+' 次');
      }
    }catch(e){console.log('  解析失败: '+e.message)}
  })
" 2>/dev/null
echo ""
# 快照摘要
echo "**03｜数据摘要**"
FM_SNAP="/root/monitor-suite/fourmeme-monitor/snapshot.json"
[ -f "$FM_SNAP" ] || FM_SNAP="/root/fourmeme-monitor/snapshot.json"
FL_SNAP="/root/monitor-suite/flap-monitor/snapshot.json"
[ -f "$FL_SNAP" ] || FL_SNAP="/root/flap-monitor/snapshot.json"
if [ -f "$FM_SNAP" ]; then
  node -e "
    const s=JSON.parse(require('fs').readFileSync('$FM_SNAP','utf-8'));
    const pools=(s.poolConfig||[]).length;
    const nets={};for(const p of s.poolConfig||[]){const n=p.networkCode||'?';nets[n]=(nets[n]||0)+1}
    const netStr=Object.entries(nets).map(([k,v])=>k+':'+v).join(' ');
    const pages=Object.keys(s.frontendPages||{}).length;
    const apis=Object.keys(s.apiStructure||{}).length;
    const templates=Object.keys(s.openFourTemplates||{}).length;
    const published=Object.values(s.openFourTemplates||{}).filter(t=>String(t?.status||'').toUpperCase()==='PUBLISHED').length;
    const ofMods=Object.keys((s.openFourModules||{}).byAddress||{}).length;
    const ofPresets=((s.openFourModules||{}).presetIds||[]).length;
    const sha=(s.githubSha||'')||'-';
    const repos=Object.keys(s.githubRepos||{}).length;
    const contracts=Object.keys(s.contractFingerprints||{}).length;
    const actors=(s.chainActorMonitor||{}).actionActorCount??Object.values((s.chainActorMonitor||{}).actors||{}).filter(a=>a&&a.actionWatched).length;
    const nfts=(s.onchainParams||{}).agentNftCount??'-';
    console.log('**Four.meme**');
    console.log('底池：'+pools+' 个（'+netStr+'）｜前端 '+pages+' 页面｜API '+apis+' 端点');
    console.log('OpenFour：模板 '+templates+' 个（PUBLISHED '+published+'）｜Preset '+ofPresets+'｜模块 '+ofMods);
    console.log('GitHub：'+sha+'｜仓库 '+repos+'｜合约 '+contracts+'｜创建者 '+actors+'｜AgentNFT '+nfts);
  " 2>/dev/null
  FM_LASTPOLL="/root/monitor-suite/fourmeme-monitor/lastpoll.txt"
  [ -f "$FM_LASTPOLL" ] || FM_LASTPOLL="/root/fourmeme-monitor/lastpoll.txt"
  if [ -f "$FM_LASTPOLL" ]; then
    echo "最后检测：$(cat "$FM_LASTPOLL")"
  fi
  echo "快照：$(stat -c '%y' "$FM_SNAP" 2>/dev/null | cut -d. -f1)"
else
  echo "**Four.meme**"
  echo "快照：无（首次启动中）"
fi
if [ -f "$FL_SNAP" ]; then
  node -e "
    const s=JSON.parse(require('fs').readFileSync('$FL_SNAP','utf-8'));
    const pages=Object.keys(s.pages||{}).length;
    const factories=Object.values(s.vaultFactories||{}).filter(v=>v&&v.showInCAStore).length;
    const registry=Object.keys((s.registryMonitor||{}).knownVaults||{}).length;
    console.log('');
    console.log('**Flap.sh**');
    console.log('页面：'+pages+' 个｜CAStore 金库工厂 '+factories+' 个｜链上金库 '+registry+' 个');
  " 2>/dev/null
  FL_LASTPOLL="/root/monitor-suite/flap-monitor/lastpoll.txt"
  [ -f "$FL_LASTPOLL" ] || FL_LASTPOLL="/root/flap-monitor/lastpoll.txt"
  if [ -f "$FL_LASTPOLL" ]; then
    echo "最后检测：$(cat "$FL_LASTPOLL")"
  fi
  echo "快照：$(stat -c '%y' "$FL_SNAP" 2>/dev/null | cut -d. -f1)"
else
  echo ""
  echo "**Flap.sh**"
  echo "快照：无（首次启动中）"
fi
echo ""
# 磁盘和日志
echo "**04｜磁盘占用**"
FM_DIR="/root/monitor-suite/fourmeme-monitor"
[ -d "$FM_DIR" ] || FM_DIR="/root/fourmeme-monitor"
FL_DIR="/root/monitor-suite/flap-monitor"
[ -d "$FL_DIR" ] || FL_DIR="/root/flap-monitor"
FM_SIZE=$(du -sh "$FM_DIR" 2>/dev/null | awk '{print $1}' || echo '?')
FL_SIZE=$(du -sh "$FL_DIR" 2>/dev/null | awk '{print $1}' || echo '?')
PM2_HOME="${PM2_HOME:-/root/.pm2}"
LOG_SIZE=$(du -sh $PM2_HOME/logs 2>/dev/null | awk '{print $1}' || echo '?')
echo "Four.meme：$FM_SIZE｜Flap：$FL_SIZE｜PM2 日志：$LOG_SIZE"
echo ""
echo "**05｜操作入口**"
echo "详情：\`fm-status\`｜\`fl-status\`｜\`bot-status\`"
echo "帮助：\`mon-help\`"
echo ""
echo "更新时间：$(date '+%Y-%m-%d %H:%M:%S')"
EOF

cat > "$BIN_DIR/mon-log" << 'EOF'
#!/bin/sh
LINES=${1:-80}
echo "====== 全部日志 (最近 ${LINES} 行, 倒序) ======"
echo "时间: $(date '+%Y-%m-%d %H:%M:%S')"
echo "========================================="
pm2 logs --lines "$LINES" --nostream 2>&1 | tac
EOF

cat > "$BIN_DIR/mon-restart" << 'EOF'
#!/bin/sh
echo "====== 重启全部进程 ======"
echo "[$(date '+%H:%M:%S')] 正在重启所有监控进程..."
pm2 restart all
echo ""
echo "[$(date '+%H:%M:%S')] 重启完成"
echo ""
pm2 jlist 2>/dev/null | _pm2-proc-info fourmeme-monitor --brief
pm2 jlist 2>/dev/null | _pm2-proc-info flap-monitor --brief
pm2 jlist 2>/dev/null | _pm2-proc-info feishu-bot --brief
echo "========================================="
EOF

cat > "$BIN_DIR/mon-stop" << 'EOF'
#!/bin/sh
pm2 stop all
echo "[$(date '+%H:%M:%S')] 全部进程已停止"
EOF

cat > "$BIN_DIR/mon-ai" << 'AIEOF'
#!/usr/bin/env node
// mon-ai — AI 模型管理命令（仅显示已配置 Key 的提供商）
const fs = require("fs");
const path = require("path");

// ── .env 加载 ──
const ENV_PATHS = ["/root/monitor-suite/.env", "/root/fourmeme-monitor/../.env"];
for (const envPath of ENV_PATHS) {
  if (fs.existsSync(envPath)) {
    try {
      for (const line of fs.readFileSync(envPath, "utf-8").split("\n")) {
        const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
        if (m && !(m[1] in process.env)) {
          process.env[m[1]] = m[2].replace(/^["']|["']$/g, "").trim();
        }
      }
    } catch {}
    break;
  }
}

function loadConfig() {
  const paths = [
    "/root/monitor-suite/ai-models.json",
    "/root/fourmeme-monitor/../ai-models.json",
  ];
  for (const p of paths) {
    try {
      if (fs.existsSync(p)) return { data: JSON.parse(fs.readFileSync(p, "utf-8")), path: p };
    } catch {}
  }
  console.log("  错误：未找到 ai-models.json");
  process.exit(1);
}

function resolveKey(raw) {
  if (!raw) return "";
  if (raw.startsWith("ENV:")) return process.env[raw.slice(4)] || "";
  return raw;
}

function getAvailable(providers) {
  return Object.entries(providers).filter(([, cfg]) => !!resolveKey(cfg.apiKey));
}

const arg = process.argv[2] || "";
const modelOverride = process.argv[3] || "";

if (!arg) {
  const { data, path: cfgPath } = loadConfig();
  const current = data.current || "(未设置)";
  const providers = data.providers || {};
  const available = getAvailable(providers);
  const p = providers[current];
  console.log("====== AI 模型管理 ======");
  console.log("");
  if (p && resolveKey(p.apiKey)) {
    console.log("当前: " + current + " (" + p.model + ") — " + (p.label || ""));
  } else {
    console.log("当前: (无可用提供商)");
  }
  console.log("");
  if (available.length === 0) {
    console.log("⚠ 未配置任何 API Key，请编辑 .env");
  } else {
    console.log("可用提供商（已配置 Key）:");
    for (const [name, cfg] of available) {
      const icon = name === current ? "●" : "○";
      const label = (cfg.label || "").padEnd(12);
      const model = cfg.model || "";
      const models = (cfg.models || []).slice(0, 4).join(", ");
      const fmt = cfg.format === "anthropic" ? " [Anthropic]" : "";
      console.log("  " + icon + " " + name.padEnd(12) + label + "当前: " + model + fmt);
      if (models) console.log("    " + "".padEnd(12) + "可选: " + models);
    }
  }
  console.log("");
  console.log("用法:");
  console.log("  mon-ai <提供商>              切换提供商");
  console.log("  mon-ai <提供商> <模型名>     切换并指定模型");
  console.log("  mon-ai list                 列出所有可用提供商");
  console.log("");
  console.log("配置文件: " + cfgPath);
  console.log("切换即时生效（5s 内），无需重启。");
  console.log("=========================================");
} else if (arg === "list") {
  const { data } = loadConfig();
  const available = getAvailable(data.providers || {});
  if (available.length === 0) {
    console.log("⚠ 无可用提供商（未配置 API Key）");
  } else {
    for (const [name, cfg] of available) {
      const models = (cfg.models || [cfg.model]).join(", ");
      console.log(name + " — " + (cfg.label || "") + " (当前: " + cfg.model + ", 可选: " + models + ")");
    }
  }
} else {
  const { data, path: cfgPath } = loadConfig();
  // 模糊匹配
  let providerName = arg;
  if (!data.providers[providerName]) {
    const match = Object.keys(data.providers).find(k => k.toLowerCase() === providerName.toLowerCase());
    if (match) providerName = match;
  }
  if (!data.providers[providerName]) {
    console.log("未知提供商: " + arg);
    const available = getAvailable(data.providers).map(([n]) => n);
    console.log("可用: " + (available.join(", ") || "(无，请先配置 API Key)"));
    process.exit(1);
  }
  const cfg = data.providers[providerName];
  if (!resolveKey(cfg.apiKey)) {
    console.log("⚠ " + providerName + " 未配置 API Key，无法切换");
    console.log("请在 .env 中设置对应的 Key 变量");
    process.exit(1);
  }
  data.current = providerName;
  if (modelOverride) {
    data.providers[providerName].model = modelOverride;
  }
  fs.writeFileSync(cfgPath, JSON.stringify(data, null, 2), "utf-8");
  const model = modelOverride || cfg.model;
  console.log("[" + new Date().toTimeString().slice(0,8) + "] 已切换为: " + providerName + " (" + model + ") — " + (cfg.label || ""));
  if (cfg.models && cfg.models.length > 1) {
    console.log("可选模型: " + cfg.models.join(", "));
  }
  console.log("已即时生效，无需重启。");
  console.log("=========================================");
}
AIEOF

cat > "$BIN_DIR/mon-help" << 'HELPEOF'
#!/bin/sh
cat << 'INNER'
╔══════════════════════════════════════════════════════╗
║            Monitor Suite 快捷命令                    ║
╚══════════════════════════════════════════════════════╝

── 全局 (mon-*) ─────────────────────────────────────
  mon-status          所有进程 + 数据摘要 + 磁盘占用
  mon-log [N]         所有进程日志（默认 80 行, 倒序）
  mon-restart         重启全部进程
  mon-stop            停止全部进程
  mon-ai              查看/切换 AI 模型（支持 10+ 模型，动态配置）
  mon-help            显示此帮助

── fourmeme (fm-*) ──────────────────────────────────
  fm-status           进程 + OpenFour/底池/前端/API/GitHub/合约/链上/创建者数据摘要
  fm-log [N]          日志（默认 80 行, 倒序）
  fm-restart          重启
  fm-stop             停止
  fm-check            SIGUSR1 触发全量检测

── flap (fl-*) ──────────────────────────────────────
  fl-status           进程 + 页面/资源/i18n 摘要
  fl-log [N]          日志（默认 80 行, 倒序）
  fl-restart          重启
  fl-stop             停止
  fl-check            SIGUSR1 触发检测
  fl-check-manual     独立进程完整检测

── feishu-bot (bot-*) ───────────────────────────────
  bot-status          进程 + 端口状态
  bot-log [N]         日志（默认 80 行, 倒序）
  bot-restart         重启
  bot-stop            停止

── 飞书 bot 内置指令 ────────────────────────────────
  help / ai <问题> / history [N]
  直接输入任意 shell 命令亦可执行

══════════════════════════════════════════════════════
INNER
HELPEOF

# 给所有命令加执行权限
chmod +x "$BIN_DIR"/fm-* "$BIN_DIR"/fl-* "$BIN_DIR"/bot-* "$BIN_DIR"/mon-*

# 清理旧版 alias 文件（如果存在）
rm -f /etc/profile.d/monitor-aliases.sh

echo ""
echo "========================================="
echo "  安装完成"
echo "========================================="
echo ""
pm2 status
echo ""
echo "输入 mon-help 查看所有快捷命令"
echo "（命令在任何 shell 中均可使用，包括飞书 bot）"
echo ""
