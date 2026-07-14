/*
 * Author: Sivakumar Chandrahasu | Created: 2026-07-07 | Updated: 2026-07-07
 * Purpose: Runs the ChatMonitor notification listener and auto joined/greeting sender.
 *          Uses communication-leg send keys, runtime memory, localStorage, and participant data duplicate checks.
 *          Maintains support/admin dashboard status and exportable logs.
 */
const APP_VERSION = 'v1.2.49';
let currentUser = null;
let channel = null;
let notifySocket = null;
let conversations = new Map();
let latestConversationId = '';
let latestCommunicationId = '';
let userRoleCache = new Map();
let roleNameById = new Map();
const runtimeJoinedKeys = new Set();
const activeSendLocks = new Set();
const MONITOR_INSTANCE_ID = 'gcb-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2,10);
const CROSS_TAB_LOCK_VERIFY_MS = 650;
const rawLogBuffer = [];
let activeLogFilter = 'ALL';
const dashStats = { ok:0, warn:0, error:0, info:0, sent:0, skipped:0 };
let dashLastSent = '-';
let dashLastSkip = '-';
let dashLastError = '-';
const FAST_LOCAL_LOCK_PREFIX = 'AFT_GCB_FAST_LOCK_';
const FAST_LOCAL_DONE_PREFIX = 'AFT_GCB_FAST_DONE_';
const FAST_LOCAL_LOCK_TTL_MS = 15000;
const GCB_INTERACTION_CONTEXTS_KEY = 'AFT_GCB_INTERACTION_CONTEXTS_V1';
const POST_MFA_RECOVERY_MAX_AGE_MS = 15 * 60 * 1000;
const MAX_TRACKED_CONVERSATIONS = 5;
const MAX_RECOVERY_CONVERSATIONS = 5;
const MAX_CONCISE_LOG_EVENTS = 50;
const API_MAX_ATTEMPTS = 3; // Standard Genesys REST transaction: maximum 3 total attempts.
const API_RETRY_DELAYS_MS = [0, 1000, 3000];
let participantApiRetryTrace = [];
function recordParticipantApiRetry(path, method, status, attempt, nextAttempt, waitMs){
  participantApiRetryTrace.push(
    `api::${method || 'GET'} ${path} ==> status::${status} ==> attempt::${attempt} ==> nextAttempt::${nextAttempt} ==> waitMs::${waitMs}`
  );
  if(participantApiRetryTrace.length > 4) participantApiRetryTrace = participantApiRetryTrace.slice(-4);
}
function participantApiRetrySummary(){
  return participantApiRetryTrace.length ? participantApiRetryTrace.join(' | ') : 'apiRetry::NONE';
}

const NOTIFICATION_RECONNECT_ATTEMPTS_PER_CYCLE = 3; // Independent from REST retry policy.
const NOTIFICATION_RECONNECT_COOLDOWN_MS = 5 * 60 * 1000;
const NOTIFICATION_RECONNECT_DELAYS_MS = [2000, 5000, 10000];
const PAGE_LOAD_FALLBACK_DELAY_MS = 2000;
const DEFAULT_SUPPORT_ROLES = ['RAK IT Admin','RAK Script Admin','RAK Access control','AFT_Support'];
const DEFAULT_ADMIN_ROLES = ['AFT_Support','RAK IT Admin'];
let latestGcbAccessConfig = { supportRoles: DEFAULT_SUPPORT_ROLES.slice(), adminRoles: DEFAULT_ADMIN_ROLES.slice(), supervisorKeyword: 'supervisor' };
let currentBannerLayout = 'light';
let manualStopRequested = false;
let intentionalSocketClose = false;
let reconnectTimer = null;
let reconnectAttempt = 0;
let monitorStartPromise = null;
let monitorWatchdogTimer = null;
let monitorReconnectSuspendedUntil = 0;
let monitorReconnectCooldownTimer = null;
let notificationReconnectCycle = 1;
const MONITOR_WATCHDOG_MS = 45000;
const MONITOR_WAKE_CHANNEL = 'AFT_GCB_MONITOR_WAKE_V1';
const MONITOR_WAKE_EVENT_KEY = 'AFT_GCB_MONITOR_WAKE_EVENT_V1';
const MONITOR_WAKE_LAST_KEY = 'AFT_GCB_MONITOR_WAKE_LAST_V1';
const MONITOR_WAKE_MAX_AGE_MS = 10 * 60 * 1000;
const processedWakeRequests = new Set();
let monitorWakeChannel = null;

const MONITOR_LEADER_KEY = 'AFT_GCB_MONITOR_LEADER_V1';
const MONITOR_HEARTBEAT_KEY = 'AFT_GCB_MONITOR_HEARTBEAT_V1';
const MONITOR_LEASE_MS = 15000;
const MONITOR_HEARTBEAT_MS = 5000;
let monitorLeaderTimer = null;
let monitorIsLeader = false;

function readMonitorLeader(){
  try{
    const value=JSON.parse(localStorage.getItem(MONITOR_LEADER_KEY)||'null');
    if(!value?.owner || !Number(value.expiresAt)) return null;
    if(Date.now()>Number(value.expiresAt)){
      localStorage.removeItem(MONITOR_LEADER_KEY);
      return null;
    }
    return value;
  }catch(_){ return null; }
}

function publishMonitorHeartbeat(){
  if(!monitorIsLeader) return;
  const value={
    owner:MONITOR_INSTANCE_ID,
    at:Date.now(),
    expiresAt:Date.now()+MONITOR_LEASE_MS,
    status:socketIsOpen()?'Running':'Starting',
    source:new URLSearchParams(location.search||'').get('source')||'Unknown',
    page:'chatmonitor.html'
  };
  try{
    localStorage.setItem(MONITOR_LEADER_KEY,JSON.stringify(value));
    localStorage.setItem(MONITOR_HEARTBEAT_KEY,JSON.stringify(value));
  }catch(_){}
}

function acquireMonitorLeadership(reason){
  const existing=readMonitorLeader();
  if(existing && existing.owner!==MONITOR_INSTANCE_ID){
    monitorIsLeader=false;
    log('INFO',{monitorStandby:true,reason,leaderOwner:existing.owner,leaderStatus:existing.status||'',leaderSource:existing.source||''});
    setMonitorStatus('Standby – another GCB monitor is running');
    return false;
  }
  monitorIsLeader=true;
  publishMonitorHeartbeat();
  if(!monitorLeaderTimer){
    monitorLeaderTimer=setInterval(publishMonitorHeartbeat,MONITOR_HEARTBEAT_MS);
  }
  log('INFO',{monitorLeadershipAcquired:true,reason,owner:MONITOR_INSTANCE_ID});
  return true;
}

function releaseMonitorLeadership(reason){
  if(monitorLeaderTimer){
    clearInterval(monitorLeaderTimer);
    monitorLeaderTimer=null;
  }
  try{
    const current=readMonitorLeader();
    if(!current || current.owner===MONITOR_INSTANCE_ID){
      localStorage.removeItem(MONITOR_LEADER_KEY);
      localStorage.removeItem(MONITOR_HEARTBEAT_KEY);
    }
  }catch(_){}
  if(monitorIsLeader) log('INFO',{monitorLeadershipReleased:true,reason,owner:MONITOR_INSTANCE_ID});
  monitorIsLeader=false;
}

function installMonitorLeaderRecovery(){
  window.addEventListener('storage',event=>{
    if(event.key!==MONITOR_LEADER_KEY) return;
    const current=readMonitorLeader();
    if(current && current.owner!==MONITOR_INSTANCE_ID) return;
    if(!manualStopRequested && !socketIsOpen()){
      setTimeout(()=>startMonitor({reason:'leader-available'}).catch(e=>log('WARN',{leaderRecoveryFailed:true,error:e.message})),250);
    }
  });
  window.addEventListener('beforeunload',()=>releaseMonitorLeadership('beforeunload'));
}

const EXPECTED_GCB_PARTICIPANT_ATTRIBUTES = [
  {group:'HOLD', name:'AFT_GCB_HoldMessageText', required:true},
  {group:'HOLD', name:'AFT_GCB_ResumeMessageText', required:true},
  {group:'HOLD', name:'AFT_GCB_MaxHoldAttempts', required:true},
  {group:'HOLD', name:'AFT_GCB_MaxHoldTimeSeconds', required:true},
  {group:'HOLD', name:'AFT_GCB_AutoResumeEnabled', required:true},
  {group:'HOLD', name:'AFT_GCB_CustomerBasedHoldCalculation', required:true},
  {group:'HOLD_ALERT', name:'AFT_GCB_AlertBlinkEnabled', required:true},
  {group:'HOLD_ALERT', name:'AFT_GCB_AlertBlinkDurationMs', required:true},
  {group:'HOLD_ALERT', name:'AFT_GCB_AlertSoundEnabled', required:true},
  {group:'HOLD_ALERT', name:'AFT_GCB_AlertSoundRepeatCount', required:true},
  {group:'HOLD_ALERT', name:'AFT_GCB_AlertSoundDurationMs', required:true},
  {group:'HOLD_ALERT', name:'AFT_GCB_AlertSoundGapMs', required:true},
  {group:'HOLD_ALERT', name:'AFT_GCB_BrowserNotificationEnabled', required:true},
  {group:'HOLD_ALERT', name:'AFT_GCB_TaskbarBlinkEnabled', required:true},
  {group:'HOLD_ALERT', name:'AFT_GCB_TitleBlinkDurationMs', required:true},
  {group:'HOLD_ALERT', name:'AFT_GCB_NotificationAutoCloseMs', required:true},
  {group:'HOLD_LABEL', name:'AFT_GCB_HoldMaxTimeAlertText', required:true},
  {group:'HOLD_LABEL', name:'AFT_GCB_HoldMaxAttemptsAlertText', required:true},
  {group:'HOLD_LABEL', name:'AFT_GCB_HoldAlertTitle', required:true},
  {group:'HOLD_LABEL', name:'AFT_GCB_AutoResumeSentText', required:true},
  {group:'PROSPECTS', name:'AFT_GCB_ProspectsTypeDataTableId', required:true},
  {group:'PROSPECTS', name:'AFT_GCB_ProspectsMappingDataTableId', required:true},
  {group:'PROSPECTS', name:'AFT_GCB_InteractionOutcomeMultiSelect', required:true},
  {group:'PROSPECTS', name:'AFT_GCB_ContactReasonSeparator', required:true},
  {group:'PROSPECTS', name:'AFT_GCB_WrapupNameSeparator', required:true},
  {group:'PROSPECTS', name:'AFT_GCB_CreateWrapupIfMissing', required:true},
  {group:'PROSPECTS', name:'AFT_GCB_DisconnectAfterProspectsSubmit', required:true},
  {group:'CHATMONITOR', name:'AFT_GCB_SupportRoles', required:true},
  {group:'CHATMONITOR', name:'AFT_GCB_AdminRoles', required:true},
  {group:'CHATMONITOR', name:'AFT_GCB_SupervisorKeywordDefault', required:true},
  {group:'CHATMONITOR', name:'AFT_GCB_SendGreetingForSupervisor', required:true},
  {group:'CHAT_MESSAGE', name:'AFT_GCB_AgentJoinedText_EN', required:true},
  {group:'CHAT_MESSAGE', name:'AFT_GCB_AgentJoinedText_AR', required:true},
  {group:'CHAT_MESSAGE', name:'AFT_GCB_SupervisorJoinedText_EN', required:true},
  {group:'CHAT_MESSAGE', name:'AFT_GCB_SupervisorJoinedText_AR', required:true},
  {group:'CHAT_MESSAGE', name:'AFT_GCB_GreetingText_EN', required:true},
  {group:'CHAT_MESSAGE', name:'AFT_GCB_GreetingText_AR', required:true},
  {group:'CHAT_MESSAGE_SOURCE', name:'AFT_GCB_GreetingTextWithoutSubject_EN', required:true},
  {group:'CHAT_MESSAGE_SOURCE', name:'AFT_GCB_GreetingTextWithoutSubject_AR', required:true},
  {group:'CHAT_MESSAGE_TRANSFER', name:'AFT_GCB_TransferGreetingText_EN', required:true},
  {group:'CHAT_MESSAGE_TRANSFER', name:'AFT_GCB_TransferGreetingText_AR', required:true},
  {group:'CHAT_MESSAGE_TRANSFER_SOURCE', name:'AFT_GCB_TransferGreetingTextWithoutSubject_EN', required:true},
  {group:'CHAT_MESSAGE_TRANSFER_SOURCE', name:'AFT_GCB_TransferGreetingTextWithoutSubject_AR', required:true}
];


const regionMap = {
  euw1: { api: 'https://api.mypurecloud.ie', login: 'https://login.mypurecloud.ie' },
  usw2: { api: 'https://api.usw2.pure.cloud', login: 'https://login.usw2.pure.cloud' },
  use1: { api: 'https://api.mypurecloud.com', login: 'https://login.mypurecloud.com' },
  apse2:{ api: 'https://api.mypurecloud.com.au', login: 'https://login.mypurecloud.com.au' },
  cac1: { api: 'https://api.mypurecloud.ca', login: 'https://login.mypurecloud.ca' },
  euc1: { api: 'https://api.mypurecloud.de', login: 'https://login.mypurecloud.de' }
};
function $(id){ return document.getElementById(id); }
function now(){ return new Date().toLocaleTimeString(); }
function escapeHtml(s){ return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c])); }
function delay(ms){ return new Promise(resolve => setTimeout(resolve, ms)); }
function token(){
  const inlineToken = $('accessToken').value.trim();
  if(inlineToken) return inlineToken;
  try{
    const sharedToken = window.RakAuth && window.RakAuth.getAccessToken ? window.RakAuth.getAccessToken() : '';
    if(sharedToken){ $('accessToken').value = sharedToken; return sharedToken; }
  }catch(e){}
  const sessionToken = sessionStorage.getItem('gc_access_token') || '';
  if(sessionToken){ $('accessToken').value = sessionToken; return sessionToken; }
  return '';
}
function apiBase(){ return $('apiBase').value.replace(/\/$/, ''); }
function compactLogData(data){
  if(typeof data==='string') return data;
  if(!data || typeof data!=='object') return String(data ?? '');
  const verbose=!!$('adminVerbose')?.checked;
  if(verbose) return JSON.stringify(data, null, 2);
  const copy={...data};
  ['roles','roleNames','roleIds','result','payload','raw','connectUri','participants','attributes'].forEach(key=>{
    if(Array.isArray(copy[key])) copy[key+'Count']=copy[key].length;
    delete copy[key];
  });
  if(Array.isArray(copy.errors)) copy.errors=copy.errors.slice(0,2);
  return JSON.stringify(copy);
}
function log(type, data){
  const level = String(type || 'INFO').toUpperCase();
  const cls = level === 'ERROR' ? 'errText' : level === 'WARN' ? 'warnText' : level === 'OK' ? 'okText' : 'infoText';
  const text = compactLogData(data);
  const line = `[${now()}] ${level}: ${text}`;
  rawLogBuffer.push(line);
  while(rawLogBuffer.length > MAX_CONCISE_LOG_EVENTS) rawLogBuffer.shift();
  if(level === 'OK') dashStats.ok++;
  else if(level === 'WARN') dashStats.warn++;
  else if(level === 'ERROR') { dashStats.error++; dashLastError = text.slice(0,180); }
  else dashStats.info++;
  if(/autoMessageSent|\bSENT\b|Send API success/i.test(text)) dashStats.sent++;
  if(/duplicateMessageSkipped|Skipped duplicate|fastLocalLockActive|localDone|participantDataKeyExists|already sent/i.test(text)) dashStats.skipped++;
  const logEl=$('log');
  const levelAttr = escapeHtml(level);
  logEl.insertAdjacentHTML('afterbegin', `<div class="line ${cls}" data-level="${levelAttr}">${escapeHtml(line)}</div>`);
  while(logEl.children.length > MAX_CONCISE_LOG_EVENTS) logEl.removeChild(logEl.lastElementChild);
  applyLogFilter();
  refreshParticipantConfigStatus();
  updateDashboardStatus();
}
function buildLogText(){
  const visibleLogs = rawLogBuffer.slice().reverse().join('\n\n');
  const adminText = $('adminTable') ? $('adminTable').innerText : '';
  const summary = [
    'AFT GCB Conversation Monitor ' + APP_VERSION,
    `Exported: ${new Date().toISOString()}`,
    `Agent: ${currentUser?.name || '-'} (${currentUser?.id || '-'})`,
    `Nickname: ${$('agentNickname')?.textContent || '-'}`,
    `Agent Role: ${$('agentRole')?.textContent || '-'}`,
    `Monitor Status: ${$('monitorStatus')?.textContent || '-'}`,
    `Channel: ${$('channelId')?.textContent || '-'}`,
    ''
  ].join('\n');
  return summary + '=== Admin Events ===\n' + adminText + '\n\n=== Raw Notification Logs ===\n' + visibleLogs;
}
function setAgentDiagnosticStatus(message, level){
  const el = $('agentDiagnosticStatus');
  if(!el) return;
  el.textContent = message || '';
  el.className = 'small diagnosticStatus ' + (level || '');
}
function buildAgentDiagnosticText(){
  const agentTableText = $('agentTable') ? $('agentTable').innerText : 'No conversation records.';
  const participantSummary = $('supportConfigSummary') ? $('supportConfigSummary').textContent : 'Not available';
  const safeLogs = rawLogBuffer
    .filter(entry => {
      const value = String(entry || '');
      if(value.length > 1200) return false;
      return !/"eventBody"|"attributes"|mobileNumber|email|cifId|SI_Customer_CIF|access_token|authorization code|pkce|client_secret/i.test(value);
    })
    .slice(0, 120)
    .reverse()
    .join('\n\n');
  const summary = [
    'AFT GCB Agent Diagnostic Report ' + APP_VERSION,
    `Exported: ${new Date().toISOString()}`,
    `Logged-in User: ${currentUser?.name || '-'} (${currentUser?.id || '-'})`,
    `Nickname: ${$('agentNickname')?.textContent || '-'}`,
    `User Role: ${$('agentRole')?.textContent || '-'}`,
    `Monitor Status: ${$('monitorStatus')?.textContent || '-'}`,
    `Notification Channel: ${$('channelId')?.textContent || '-'}`,
    `Source: ${$('sourceInfo')?.textContent || '-'}`,
    `Target Environment: ${$('targetEnvInfo')?.textContent || '-'}`,
    `Region: ${$('regionInfo')?.textContent || '-'}`,
    `Active Connected Chats: ${$('mActive')?.textContent || '0'}`,
    `Greetings Sent: ${$('mSent')?.textContent || '0'}`,
    `Pending / Not Sent: ${$('mPending')?.textContent || '0'}`,
    `Failed / Skipped: ${$('mFailed')?.textContent || '0'}`,
    `Participant Config Summary: ${participantSummary || '-'}`,
    '',
    'Security Note: OAuth data, raw participant attributes, and customer personal/banking data are excluded.',
    ''
  ].join('\n');
  return summary + '=== Conversation Greeting Status ===\n' + agentTableText + '\n\n=== Recent Concise Monitoring Logs ===\n' + (safeLogs || 'No concise logs available.');
}

function legacyCopyText(text){
  try{
    const area=document.createElement('textarea');
    area.value=text; area.setAttribute('readonly','readonly');
    area.style.position='fixed'; area.style.opacity='0';
    document.body.appendChild(area); area.select();
    const ok=document.execCommand&&document.execCommand('copy');
    area.remove(); return !!ok;
  }catch(_){ return false; }
}

async function copyAgentDiagnostics(){
  const text = buildAgentDiagnosticText();
  try{
    await navigator.clipboard.writeText(text);
    setAgentDiagnosticStatus('Diagnostic details copied.', 'ok');
    log('OK','Agent diagnostic details copied to clipboard.');
  }catch(e){
    if(legacyCopyText(text)){
      setAgentDiagnosticStatus('Diagnostic details copied using browser fallback.', 'ok');
      log('OK','Agent diagnostic details copied using browser fallback.');
    } else {
      setAgentDiagnosticStatus('Clipboard is unavailable in the Genesys frame. Use Download Diagnostic Logs.', 'warn');
      log('WARN','Agent diagnostic clipboard copy failed. Download remains available. '+(e?.message || e));
    }
  }
}
function downloadAgentDiagnostics(){
  const text = buildAgentDiagnosticText();
  const blob = new Blob([text], {type:'text/plain;charset=utf-8'});
  const a = document.createElement('a');
  const ts = new Date().toISOString().replace(/[:.]/g,'-');
  a.href = URL.createObjectURL(blob);
  a.download = `AFT_GCB_Agent_Diagnostics_${ts}.txt`;
  document.body.appendChild(a);
  a.click();
  setTimeout(()=>{ URL.revokeObjectURL(a.href); a.remove(); }, 500);
  setAgentDiagnosticStatus('Diagnostic log downloaded.', 'ok');
  log('OK','Agent diagnostic log downloaded.');
}

async function copyLogs(){
  const text = buildLogText();
  try{ await navigator.clipboard.writeText(text); log('OK','Admin logs copied to clipboard.'); }
  catch(e){ if(legacyCopyText(text)) log('OK','Admin logs copied using browser fallback.'); else log('WARN','Clipboard copy failed. Use Download Logs instead. '+e.message); }
}
function downloadLogs(){
  const text = buildLogText();
  const blob = new Blob([text], {type:'text/plain;charset=utf-8'});
  const a = document.createElement('a');
  const ts = new Date().toISOString().replace(/[:.]/g,'-');
  a.href = URL.createObjectURL(blob);
  a.download = `AFT_GCB_ConversationMonitor_Logs_${ts}.txt`;
  document.body.appendChild(a); a.click();
  setTimeout(()=>{ URL.revokeObjectURL(a.href); a.remove(); }, 500);
  log('OK','Admin logs downloaded.');
}
function clearLogsOnly(){
  rawLogBuffer.length=0;
  $('log').innerHTML='';
  const admin=$('adminTable');
  if(admin) admin.innerHTML='<tr><td colspan="5" class="small">No admin events yet.</td></tr>';
  dashStats.ok=0; dashStats.warn=0; dashStats.error=0; dashStats.info=0; dashStats.sent=0; dashStats.skipped=0;
  dashLastSent='-'; dashLastSkip='-'; dashLastError='-';
  log('OK','Admin logs cleared. Live monitoring continues.');
}
function setLogFilter(filter){
  activeLogFilter = String(filter || 'ALL').toUpperCase();
  document.querySelectorAll('.logFilters button.filter').forEach(b=>b.classList.remove('active'));
  const map={ALL:'filterAll',OK:'filterOk',WARN:'filterWarn',ERROR:'filterError',SENT:'filterSent',SKIPPED:'filterSkipped'};
  const btn=$(map[activeLogFilter]); if(btn) btn.classList.add('active');
  applyLogFilter();
}
function applyLogFilter(){
  const logEl=$('log'); if(!logEl) return;
  Array.from(logEl.children).forEach(el=>{
    const text=el.textContent || '';
    const level=(el.getAttribute('data-level') || '').toUpperCase();
    let show=true;
    if(activeLogFilter==='OK') show=level==='OK';
    else if(activeLogFilter==='WARN') show=level==='WARN';
    else if(activeLogFilter==='ERROR') show=level==='ERROR';
    else if(activeLogFilter==='SENT') show=/autoMessageSent|\bSENT\b|Send API success/i.test(text);
    else if(activeLogFilter==='SKIPPED') show=/duplicateMessageSkipped|Skipped duplicate|fastLocalLockActive|localDone|participantDataKeyExists|already sent/i.test(text);
    el.style.display=show?'':'none';
  });
}
function socketStateText(){
  if(!notifySocket) return 'Not started';
  if(notifySocket.readyState===0) return 'Connecting';
  if(notifySocket.readyState===1) return 'Connected';
  if(notifySocket.readyState===2) return 'Closing';
  return 'Closed';
}
function updateDashboardStatus(){
  const oauth=$('dashOAuthStatus'); if(oauth) oauth.textContent = token() ? (currentUser?.name ? 'Valid - '+currentUser.name : 'Token available') : 'Missing token / OAuth pending';
  const socket=$('dashSocketStatus'); if(socket) socket.textContent = socketStateText();
  const sub=$('dashSubscriptionStatus'); if(sub) sub.textContent = channel?.id ? 'Subscribed - '+shortId(channel.id) : 'Pending';
  const loaded=$('dashLoadedFrom'); if(loaded) loaded.textContent = `${$('sourceInfo')?.textContent || 'ClientApp'} | ${location.pathname.split('/').pop() || 'chatmonitor.html'}`;
  const lastConv=$('dashLastConversation'); if(lastConv) lastConv.textContent = latestConversationId ? `${shortId(latestConversationId)} / ${shortId(latestCommunicationId)}` : '-';
  const lastSent=$('dashLastSent'); if(lastSent) lastSent.textContent = dashLastSent;
  const lastSkip=$('dashLastSkip'); if(lastSkip) lastSkip.textContent = dashLastSkip;
  const lastErr=$('dashLastError'); if(lastErr) lastErr.textContent = dashLastError;
  const counts=$('dashLogCounts'); if(counts) counts.textContent = `OK: ${dashStats.ok} | WARN: ${dashStats.warn} | ERROR: ${dashStats.error} | SENT: ${dashStats.sent} | SKIPPED: ${dashStats.skipped}`;
}
function showTab(name){
  const panel = $('tab-'+name);
  const button = $('tabBtn'+name.charAt(0).toUpperCase()+name.slice(1));
  if(!panel || (button && button.style.display==='none')) return;
  document.querySelectorAll('.tab').forEach(b=>b.classList.remove('active'));
  document.querySelectorAll('.tabPanel').forEach(p=>p.classList.remove('active'));
  if(button) button.classList.add('active');
  panel.classList.add('active');
}
function normalizeAccessRole(value){ return String(value||'').toLowerCase().replace(/[\s_\-]+/g,' ').trim(); }
function hasAccessRole(roleNames, target){
  const t = normalizeAccessRole(target);
  return (roleNames||[]).some(r => normalizeAccessRole(r) === t || normalizeAccessRole(r).includes(t));
}
function splitCsvConfig(value, fallback=[]){
  const items = String(value || '').split(/[;,|]/).map(x=>x.trim()).filter(Boolean);
  return items.length ? items : fallback.slice();
}
function updateViewAccess(roleInfo, accessConfig){
  // Agent View is always available for all logged-in users.
  const roles = (roleInfo && roleInfo.roleNames) || [];
  const cfg = accessConfig || latestGcbAccessConfig || {};
  const supportTargets = splitCsvConfig(cfg.supportRolesText || cfg.supportRoles, DEFAULT_SUPPORT_ROLES);
  const adminTargets = splitCsvConfig(cfg.adminRolesText || cfg.adminRoles, DEFAULT_ADMIN_ROLES);
  const supportAccess = supportTargets.some(target => hasAccessRole(roles, target));
  const adminAccess = adminTargets.some(target => hasAccessRole(roles, target));
  const btnSupport = $('tabBtnSupport'), btnAdmin = $('tabBtnAdmin');
  if(btnSupport) btnSupport.style.display = supportAccess ? '' : 'none';
  if(btnAdmin) btnAdmin.style.display = adminAccess ? '' : 'none';
  if(!supportAccess && $('tab-support').classList.contains('active')) showTab('agent');
  if(!adminAccess && $('tab-admin').classList.contains('active')) showTab('agent');
  log('INFO',{viewAccess:true,roles,agentView:true,supportView:supportAccess,adminView:adminAccess,supportRolesConfig:supportTargets,adminRolesConfig:adminTargets,rule:'Agent View for all. Support/Admin roles loaded from AFT_GCB_SupportRoles and AFT_GCB_AdminRoles participant data when available.'});
}
function applyRegion(){ const r = regionMap[$('region').value]; $('apiBase').value = r.api; $('loginBase').value = r.login; }
function queryParam(name){ return new URLSearchParams(location.search).get(name) || ''; }

function normalizeBannerLayout(value){
  const v=String(value||'').trim().toLowerCase();
  return v==='dark' ? 'dark' : 'light';
}
function applyBannerLayout(layout, source=''){
  const finalLayout=normalizeBannerLayout(layout);
  currentBannerLayout=finalLayout;
  document.body.classList.remove('banner-dark','banner-light');
  document.body.classList.add(finalLayout==='light' ? 'banner-light' : 'banner-dark');
  const hdr=document.querySelector('.header');
  if(hdr) hdr.setAttribute('data-banner-layout', finalLayout);
  if(source) log('INFO', {bannerLayoutApplied:finalLayout, source});
  return finalLayout;
}
function getBannerLayoutFromAttrs(attrs={}){
  return cleanGcbText(attrs.AFT_GCB_BannerLayout || attrs.AFT_GCB_BannerTheme || '');
}
function resolveBannerLayoutPreference(){
  const qp=queryParam('bannerLayout') || queryParam('bannerTheme');
  if(qp) return {value:normalizeBannerLayout(qp), source:'query'};
  return {value:'light', source:'default'};
}
function refreshBannerLayoutFromAttributes(attrs={}){
  const qp=queryParam('bannerLayout') || queryParam('bannerTheme');
  if(qp) return; // explicit query parameter always wins for demo/testing.
  const attrValue=getBannerLayoutFromAttrs(attrs);
  if(!attrValue) return;
  const finalLayout=normalizeBannerLayout(attrValue);
  if(finalLayout!==currentBannerLayout) applyBannerLayout(finalLayout, 'participantAttribute');
}
function getIndexRedirectUri(){
  try{
    const path = location.pathname.replace(/\/[^\/]*$/, '/index.html');
    return location.origin + path;
  }catch(e){ return location.origin + '/index.html'; }
}
function normaliseRegion(value){
  const v=String(value||'').toLowerCase().trim();
  if(!v || v==='mypurecloud.ie' || v==='euw1') return 'euw1';
  if(v==='mypurecloud.com' || v==='use1') return 'use1';
  if(v==='usw2.pure.cloud' || v==='usw2') return 'usw2';
  if(v==='mypurecloud.com.au' || v==='apse2') return 'apse2';
  if(v==='mypurecloud.ca' || v==='cac1') return 'cac1';
  if(v==='mypurecloud.de' || v==='euc1') return 'euc1';
  return 'euw1';
}
function loadClientAppParams(){
  const clientId=queryParam('clientId') || sessionStorage.getItem('genesys_client_id') || '';
  const regionValue=queryParam('region') || sessionStorage.getItem('genesys_region_value') || 'mypurecloud.ie';
  const regionKey=normaliseRegion(regionValue);
  const r=regionMap[regionKey] || regionMap.euw1;
  $('region').value=regionKey;
  $('apiBase').value=r.api;
  $('loginBase').value=r.login;
  $('clientId').value=clientId;
  $('redirectUri').value=getIndexRedirectUri();
  sessionStorage.setItem('genesys_region_value', regionValue);
  if(clientId) sessionStorage.setItem('genesys_client_id', clientId);
  $('sourceInfo').textContent = queryParam('source') || sessionStorage.getItem('csk_source') || 'ClientApp';
  $('targetEnvInfo').textContent = queryParam('gcTargetEnv') || sessionStorage.getItem('csk_target_env') || '-';
  $('regionInfo').textContent = regionValue || 'mypurecloud.ie';
  if(queryParam('source')) sessionStorage.setItem('csk_source', queryParam('source'));
  if(queryParam('gcTargetEnv')) sessionStorage.setItem('csk_target_env', queryParam('gcTargetEnv'));
  const bannerPref = resolveBannerLayoutPreference();
  applyBannerLayout(bannerPref.value, bannerPref.source);
  updateDashboardStatus();
}
async function init(){
  loadClientAppParams();
  $('redirectUri').value = getIndexRedirectUri();
  useTokenFromUrl(false);
  refreshTables();
  updateViewAccess({roleNames:[]});
  installMonitorLifecycleRecovery();
  installMonitorLeaderRecovery();
  installMonitorWakeListener();

  if(!$('clientId').value.trim()){
    setMonitorStatus('Missing clientId');
    log('ERROR','Missing clientId URL parameter. Add clientId=<Genesys OAuth Client ID>.');
    return;
  }

  try{
    await startMonitor({reason:'page-load'});
  }catch(e){
    log('ERROR','Auto start failed: '+e.message);
  }
}
function randomString(length=64){ const chars='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~'; const arr=new Uint8Array(length); crypto.getRandomValues(arr); return Array.from(arr,x=>chars[x%chars.length]).join(''); }
function base64UrlEncode(buffer){ const bytes=new Uint8Array(buffer); let binary=''; bytes.forEach(b=>binary+=String.fromCharCode(b)); return btoa(binary).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,''); }
async function sha256(text){ return crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)); }
async function loginPkce(){
  const clientId=$('clientId').value.trim(); if(!clientId){ alert('Paste OAuth Client ID first.'); return; }
  if(window.RakAuth && window.RakAuth.startPKCELogin){
    sessionStorage.setItem('gcb_clientId', clientId);
    sessionStorage.setItem('gcb_region', queryParam('region') || sessionStorage.getItem('genesys_region_value') || 'mypurecloud.ie');
    await window.RakAuth.startPKCELogin({ restoreUrl: window.location.href });
    return;
  }
  const verifier=randomString(96), challenge=base64UrlEncode(await sha256(verifier)), state=randomString(24);
  sessionStorage.setItem('genesys_pkce_verifier',verifier); sessionStorage.setItem('genesys_pkce_state',state); sessionStorage.setItem('genesys_client_id',clientId); sessionStorage.setItem('genesys_login_base',$('loginBase').value.replace(/\/$/,'')); sessionStorage.setItem('genesys_redirect_uri',$('redirectUri').value.trim()); sessionStorage.setItem('genesys_region_value', queryParam('region') || sessionStorage.getItem('genesys_region_value') || 'mypurecloud.ie');
  const params=new URLSearchParams({client_id:clientId,response_type:'code',redirect_uri:$('redirectUri').value.trim(),code_challenge:challenge,code_challenge_method:'S256',state});
  location.href=`${$('loginBase').value.replace(/\/$/,'')}/oauth/authorize?${params.toString()}`;
}
async function handleOAuthReturn(){
  const query=new URLSearchParams(location.search); const hash=new URLSearchParams(location.hash.replace(/^#/,'')); const hashToken=hash.get('access_token');
  if(hashToken){ $('accessToken').value=hashToken; log('OK','Access token loaded from URL hash.'); history.replaceState(null,'',location.origin+location.pathname); return; }
  const err=query.get('error'); if(err){ log('ERROR',`OAuth redirect returned error=${err}. ${query.get('error_description') || ''}`); return; }
  const code=query.get('code'); if(!code) return;
  const state=query.get('state'), expectedState=sessionStorage.getItem('genesys_pkce_state'); if(expectedState && state!==expectedState){ log('ERROR','OAuth state mismatch.'); return; }
  const verifier=sessionStorage.getItem('genesys_pkce_verifier'); const clientId=sessionStorage.getItem('genesys_client_id') || $('clientId').value.trim(); const loginBase=sessionStorage.getItem('genesys_login_base') || $('loginBase').value.replace(/\/$/,''); const redirectUri=sessionStorage.getItem('genesys_redirect_uri') || $('redirectUri').value.trim();
  if(!verifier || !clientId){ log('ERROR','Missing PKCE verifier/client ID. Start login again.'); return; }
  try{
    log('INFO','OAuth code received. Exchanging code for access token...');
    const body=new URLSearchParams({grant_type:'authorization_code',code,redirect_uri:redirectUri,client_id:clientId,code_verifier:verifier});
    const res=await fetch(`${loginBase}/oauth/token`,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body});
    const txt=await res.text(); let data=null; try{data=JSON.parse(txt)}catch(e){data=txt}
    if(!res.ok) throw new Error(`${res.status} ${res.statusText}: ${txt}`);
    $('accessToken').value=data.access_token || '';
    if(data.access_token){
      sessionStorage.setItem('gc_access_token', data.access_token);
      sessionStorage.setItem('gc_token_expires_at', String(Date.now() + ((data.expires_in || 3600) * 1000)));
    }
    log('OK','Access token received using Authorization Code / PKCE.'); history.replaceState(null,'',location.origin+location.pathname);
  }catch(e){ log('ERROR','Token exchange failed: '+e.message); }
}
function useTokenFromUrl(showMsg=true){ const hash=new URLSearchParams(location.hash.replace(/^#/,'')); const query=new URLSearchParams(location.search); const t=hash.get('access_token')||query.get('access_token'); if(t){$('accessToken').value=t;if(showMsg)log('OK','Access token loaded from URL.')} else if(showMsg)log('WARN','No access_token found in URL.'); }
function isTransientApiStatus(status){
  return [408,429,500,502,503,504].includes(Number(status||0));
}
function retryAfterMs(response, fallbackMs){
  const raw=response?.headers?.get?.('Retry-After');
  if(!raw) return fallbackMs;
  const seconds=Number(raw);
  if(Number.isFinite(seconds) && seconds>=0) return Math.min(seconds*1000,60000);
  const dateMs=Date.parse(raw);
  return Number.isFinite(dateMs) ? Math.max(0,Math.min(dateMs-Date.now(),60000)) : fallbackMs;
}
async function api(path, opts={}){
  if(!token()) {
    const error = new Error('Missing access token.');
    error.status = 401;
    throw error;
  }
  let lastError=null;
  for(let attempt=1; attempt<=API_MAX_ATTEMPTS; attempt++){
    let res=null;
    try{
      res=await fetch(apiBase()+path,{...opts,headers:{'Authorization':'Bearer '+token(),'Content-Type':'application/json',...(opts.headers||{})}});
      const txt=await res.text(); let body=null; try{body=txt?JSON.parse(txt):null}catch(e){body=txt}
      if(res.ok) return body;
      const error = new Error(`${res.status} ${res.statusText}: ${txt}`);
      error.status = res.status;
      error.payload = body;
      lastError=error;
      if(res.status===401 && window.RakAuth?.clearToken){
        window.RakAuth.clearToken();
        $('accessToken').value='';
      }
      const retryable=isTransientApiStatus(res.status);
      if(!retryable || attempt>=API_MAX_ATTEMPTS) throw error;
      const waitMs=retryAfterMs(res,API_RETRY_DELAYS_MS[attempt]||3000);
      log('WARN',{apiRetry:true,path,method:opts.method||'GET',status:res.status,attempt,nextAttempt:attempt+1,waitMs});
      recordParticipantApiRetry(path,opts.method||'GET',res.status,attempt,attempt+1,waitMs);
      await delay(waitMs);
    }catch(error){
      if(error?.status) throw error;
      lastError=error;
      if(attempt>=API_MAX_ATTEMPTS) throw error;
      const waitMs=API_RETRY_DELAYS_MS[attempt]||3000;
      log('WARN',{apiRetry:true,path,method:opts.method||'GET',status:'NETWORK',attempt,nextAttempt:attempt+1,waitMs});
      recordParticipantApiRetry(path,opts.method||'GET','NETWORK',attempt,attempt+1,waitMs);
      await delay(waitMs);
    }
  }
  throw lastError || new Error('Genesys API request failed.');
}
function getUserDisplayNickname(user){
  return user?.preferredName || user?.name || user?.email || '-';
}
async function refreshLoggedInUserRoleDisplay(){
  if(!currentUser?.id) return;
  try{
    const roleInfo = await getUserRoleInfo(currentUser.id, true);
    // Display a simple business classification only when role lookup is really available.
    // If authorization scope is missing, do not incorrectly display Agent/Supervisor.
    let roleText = 'Agent';
    if(roleInfo.roleLookupFailed || roleInfo.authorizationScopeMissing){
      roleText = 'Role access missing';
    } else if(roleInfo.isSupervisor){
      roleText = 'Supervisor role assigned';
    }
    $('agentRole').textContent = roleText;
    $('agentRole').title = [
      'Detected classification: ' + roleText,
      'Role names: ' + ((roleInfo.roleNames && roleInfo.roleNames.length) ? roleInfo.roleNames.join(', ') : '-'),
      'Authorization scope missing: ' + (roleInfo.authorizationScopeMissing ? 'YES' : 'NO'),
      'Errors: ' + ((roleInfo.errors && roleInfo.errors.length) ? roleInfo.errors.slice(0,3).join(' | ') : '-')
    ].join('\n');
    $('agentNickname').textContent = getUserDisplayNickname(currentUser);
    updateViewAccess(roleInfo);
    log(roleInfo.roleLookupFailed?'WARN':roleInfo.isSupervisor?'OK':'INFO',{loggedInUserRoleDisplay:true,userId:currentUser.id,nickname:$('agentNickname').textContent,displayRole:roleText,roleNames:roleInfo.roleNames||[],isSupervisor:roleInfo.isSupervisor,roleLookupFailed:roleInfo.roleLookupFailed,authorizationScopeMissing:roleInfo.authorizationScopeMissing,errors:(roleInfo.errors||[]).slice(0,3)});
  }catch(e){
    $('agentRole').textContent = 'Role lookup failed';
    $('agentRole').title = 'Role lookup failed. Error: ' + e.message;
    updateViewAccess({roleNames:[]});
    log('WARN','Logged-in agent role display failed: '+e.message);
  }
}
async function getMe(){
  try{
    currentUser=await api('/api/v2/users/me');
    $('agentName').textContent=currentUser.name||currentUser.email||'-';
    $('agentId').textContent=currentUser.id||'-';
    $('agentNickname').textContent=getUserDisplayNickname(currentUser);
    $('agentRole').textContent='Checking...';
    updateDashboardStatus();
    log('OK',`Logged-in agent: ${currentUser.name} (${currentUser.id})`);
    addAgentMsg('AFT GCB',`Logged in as ${currentUser.name}. Monitoring starts automatically.`,'system');
    await refreshLoggedInUserRoleDisplay();
  }catch(e){
    log('ERROR',e.message);
    throw e;
  }
}


function isValidConversationId(value){
  const text=String(value||'').trim();
  if(!text) return false;
  if(/^\[.*\]$/.test(text)) return false;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(text);
}

async function recoverPublishedActiveInteractions(reason='post-mfa-startup'){
  let contexts=[];
  try{
    const raw=localStorage.getItem(GCB_INTERACTION_CONTEXTS_KEY);
    const map=raw?JSON.parse(raw):{};
    contexts=Object.values(map&&typeof map==='object'&&!Array.isArray(map)?map:{});
  }catch(e){ log('WARN',{activeInteractionRecoveryReadFailed:true,reason,error:e.message}); return; }
  const nowMs=Date.now();
  const recent=contexts.filter(item=>{
    if(!isValidConversationId(item?.conversationId))return false;
    const age=nowMs-new Date(item.updatedAt||0).getTime();
    return Number.isFinite(age)&&age>=0&&age<=POST_MFA_RECOVERY_MAX_AGE_MS;
  }).sort((a,b)=>new Date(b.updatedAt||0)-new Date(a.updatedAt||0))
    .slice(0,MAX_RECOVERY_CONVERSATIONS);
  log('INFO',{activeInteractionRecoveryStart:true,reason,candidateCount:recent.length});
  for(const item of recent){
    try{
      const snapshot=await getConversationSnapshot(item.conversationId);
      const participants=snapshot?.participants||[];
      const agent=findCurrentAgentParticipant(participants);
      const comm=agent?getAgentCommunication(agent):{};
      const info=agent?getAgentState(agent,comm):{state:'',note:''};
      log('INFO',{activeInteractionRecoveryCheck:true,reason,conversationId:item.conversationId,agentParticipantId:agent?.id||'',agentCommunicationId:comm?.id||'',communicationState:comm?.state||'',resolved:!!(agent&&comm?.id&&info.state==='JOINED / CONNECTED')});
      if(agent&&comm?.id&&info.state==='JOINED / CONNECTED'){
        processConversationBody(snapshot,'post-mfa-recovery');
      }
    }catch(e){
      log('WARN',{activeInteractionRecoveryFailed:true,reason,conversationId:item.conversationId,error:e.message});
    }
  }
  log('OK',{activeInteractionRecoveryComplete:true,reason,candidateCount:recent.length});
}

function setMonitorStatus(value){
  const text=String(value||'');
  const el=$('monitorStatus');
  if(el) el.textContent=text;
  const notice=$('monitorRecoveryNotice');
  const restart=$('restartMonitorButton');
  const failed=/Recovery failed|Stopped manually|Waiting for OAuth \/ MFA/i.test(text);
  if(notice){
    notice.style.display=failed?'block':'none';
    notice.textContent=/Stopped manually/i.test(text)
      ? 'Automatic greeting monitor is stopped. It will restart when a new Agent Script wake request is received, or click Restart Monitor.'
      : /Waiting for OAuth \/ MFA/i.test(text)
        ? 'Authentication is required. Complete OAuth/MFA; the monitor will restart automatically.'
        : 'Automatic greeting monitor is not running. Click Restart Monitor or send the approved greeting manually for any already-arrived chat.';
  }
  if(restart) restart.style.display=failed?'inline-block':'none';
  updateDashboardStatus();
}

function socketIsOpen(){
  return !!notifySocket && notifySocket.readyState===WebSocket.OPEN;
}

function clearReconnectTimer(){
  if(reconnectTimer){
    clearTimeout(reconnectTimer);
    reconnectTimer=null;
  }
}

function closeMonitorSocket(){
  clearReconnectTimer();
  const socket=notifySocket;
  notifySocket=null;
  if(socket){
    intentionalSocketClose=true;
    try{socket.close()}catch(e){}
    setTimeout(()=>{intentionalSocketClose=false;},0);
  }
}

async function ensureAuthenticated(reason){
  setMonitorStatus('Checking OAuth');
  let activeToken=token();

  if(!activeToken && window.RakAuth?.ensureToken){
    setMonitorStatus('Waiting for OAuth / MFA');
    log('INFO',{oauthRecoveryStarted:true,reason});
    activeToken=await window.RakAuth.ensureToken({restoreUrl:window.location.href});
    if(activeToken) $('accessToken').value=activeToken;
  }

  if(!token()){
    setMonitorStatus('Waiting for OAuth / MFA');
    throw new Error('OAuth/MFA recovery started. Waiting for page restoration.');
  }

  try{
    await getMe();
    log('OK',{tokenValidationSuccess:true,reason,userId:currentUser?.id||''});
    return true;
  }catch(e){
    const isAuthError=window.RakAuth?.isAuthError ? window.RakAuth.isAuthError(e) : [401,403].includes(Number(e?.status||0));
    if(!isAuthError) throw e;

    log('WARN',{tokenValidationFailed:true,reason,status:e?.status||0});
    $('accessToken').value='';
    currentUser=null;
    window.RakAuth?.clearToken?.();
    setMonitorStatus('Waiting for OAuth / MFA');
    await window.RakAuth.ensureToken({restoreUrl:window.location.href});
    throw new Error('OAuth/MFA recovery started. Waiting for page restoration.');
  }
}

function scheduleMonitorReconnect(reason){
  if(manualStopRequested || reconnectTimer) return;
  if(reconnectAttempt>=NOTIFICATION_RECONNECT_ATTEMPTS_PER_CYCLE){
    monitorReconnectSuspendedUntil=Date.now()+NOTIFICATION_RECONNECT_COOLDOWN_MS;
    setMonitorStatus('Reconnect suspended');
    log('WARN',{monitorReconnectSuspended:true,reason,cycle:notificationReconnectCycle,attempts:reconnectAttempt,attemptsPerCycle:NOTIFICATION_RECONNECT_ATTEMPTS_PER_CYCLE,cooldownMs:NOTIFICATION_RECONNECT_COOLDOWN_MS,policy:'Notification reconnect is 3 attempts per cycle, then cooldown; it is independent from REST API retry.'});
    if(monitorReconnectCooldownTimer) clearTimeout(monitorReconnectCooldownTimer);
    monitorReconnectCooldownTimer=setTimeout(()=>{
      monitorReconnectCooldownTimer=null;
      if(manualStopRequested) return;
      reconnectAttempt=0;
      notificationReconnectCycle+=1;
      monitorReconnectSuspendedUntil=0;
      log('INFO',{notificationReconnectCycleStarted:true,cycle:notificationReconnectCycle,reason:'cooldown-expired'});
      ensureMonitorHealthy('reconnect-cooldown-expired');
    },NOTIFICATION_RECONNECT_COOLDOWN_MS);
    return;
  }
  const delayMs=NOTIFICATION_RECONNECT_DELAYS_MS[reconnectAttempt]||NOTIFICATION_RECONNECT_DELAYS_MS[NOTIFICATION_RECONNECT_DELAYS_MS.length-1];
  reconnectAttempt+=1;
  setMonitorStatus('Reconnecting');
  log('WARN',{monitorReconnectScheduled:true,reason,cycle:notificationReconnectCycle,attempt:reconnectAttempt,attemptsPerCycle:NOTIFICATION_RECONNECT_ATTEMPTS_PER_CYCLE,delayMs,policy:'Notification reconnect cycle; not a REST API retry count.'});
  reconnectTimer=setTimeout(async()=>{
    reconnectTimer=null;
    if(manualStopRequested) return;
    try{
      await startMonitor({reason:'reconnect-'+reason});
    }catch(e){
      log('WARN',{monitorReconnectAttemptFailed:true,reason,attempt:reconnectAttempt,error:e.message});
      scheduleMonitorReconnect(reason);
    }
  },delayMs);
}

async function startMonitor(options={}){
  const reason=options.reason||'manual-start';
  if(!acquireMonitorLeadership(reason)) return false;
  if(reason==='manual-start') manualStopRequested=false;
  if(manualStopRequested && reason!=='manual-start'){
    setMonitorStatus('Stopped manually');
    return false;
  }
  if(socketIsOpen()){
    setMonitorStatus('Running');
    return true;
  }
  if(monitorStartPromise) return monitorStartPromise;

  monitorStartPromise=(async()=>{
    clearReconnectTimer();
    setMonitorStatus(reconnectAttempt>0 ? 'Reconnecting' : 'Starting');

    await ensureAuthenticated(reason);
    if(!currentUser?.id) throw new Error('Cannot start without logged-in user ID.');

    closeMonitorSocket();
    channel=await api('/api/v2/notifications/channels',{method:'POST',body:'{}'});
    $('channelId').textContent=channel.id||'-';
    updateDashboardStatus();
    log('OK',{createdChannel:channel.id,connectUri:channel.connectUri,reason});

    const topic=`v2.users.${currentUser.id}.conversations`;
    await api(`/api/v2/notifications/channels/${channel.id}/subscriptions`,{
      method:'PUT',
      body:JSON.stringify([{id:topic}])
    });
    log('OK',`Subscribed to ${topic}`);

    const socket=new WebSocket(channel.connectUri);
    notifySocket=socket;

    socket.onopen=()=>{
      if(notifySocket!==socket) return;
      reconnectAttempt=0;
      setMonitorStatus('Running');
      publishMonitorHeartbeat();
      log('OK','Notification WebSocket connected.');
      addAgentMsg('CSK System','Monitor running. Waiting for assigned/connected chats.','system');
      recoverPublishedActiveInteractions('post-auth-subscription')
        .catch(e=>log('WARN',{activeInteractionRecoveryUnhandled:true,error:e.message}));
    };

    socket.onerror=()=>{
      if(notifySocket!==socket) return;
      log('ERROR','Notification WebSocket error. Check token, permissions, and network.');
    };

    socket.onclose=(e)=>{
      if(notifySocket===socket) notifySocket=null;
      const expected=intentionalSocketClose || manualStopRequested;
      log('WARN',`Notification WebSocket closed. code=${e.code} reason=${e.reason||'-'} expected=${expected}`);
      if(manualStopRequested){
        setMonitorStatus('Stopped manually');
        return;
      }
      if(expected) return;
      scheduleMonitorReconnect('websocket-close');
    };

    socket.onmessage=(event)=>{
      let msg;
      try{msg=JSON.parse(event.data)}catch(e){msg=event.data}
      const isHeartbeat=msg && msg.topicName==='channel.metadata' && msg.eventBody && msg.eventBody.message==='WebSocket Heartbeat';
      if($('adminVerbose').checked && !isHeartbeat) log('INFO',msg);
      handleNotification(msg);
    };

    return true;
  })();

  try{
    return await monitorStartPromise;
  }catch(e){
    const isWaiting=/OAuth\/MFA recovery started/i.test(e.message||'');
    if(!isWaiting){
      log('ERROR',{monitorStartFailed:true,reason,error:e.message,status:e.status||0});
      scheduleMonitorReconnect('start-failed');
    }
    throw e;
  }finally{
    monitorStartPromise=null;
  }
}

async function stopMonitor(writeLog=true){
  manualStopRequested=writeLog!==false;
  clearReconnectTimer();
  closeMonitorSocket();
  if(manualStopRequested) releaseMonitorLeadership('manual-stop');
  setMonitorStatus(manualStopRequested ? 'Stopped manually' : 'Stopped');
  if(writeLog) log('WARN','Monitor stopped manually.');
}

async function restartMonitorFromUi(){
  manualStopRequested=false;
  reconnectAttempt=0;
  monitorReconnectSuspendedUntil=0;
  if(monitorReconnectCooldownTimer){ clearTimeout(monitorReconnectCooldownTimer); monitorReconnectCooldownTimer=null; }
  clearReconnectTimer();
  setMonitorStatus('Starting');
  log('INFO',{manualRestartRequested:true,source:'ui'});
  try{
    await startMonitor({reason:'ui-restart'});
  }catch(e){
    setMonitorStatus('Recovery failed');
    log('ERROR',{manualRestartFailed:true,error:e.message});
  }
}

async function simulateUnexpectedMonitorStop(){
  manualStopRequested=false;
  intentionalSocketClose=false;
  const socket=notifySocket;
  notifySocket=null;
  try{ if(socket) socket.close(); }catch(e){}
  setMonitorStatus('Stopped');
  log('WARN',{simulatedUnexpectedMonitorStop:true});
}

async function ensureMonitorHealthy(reason){
  if(manualStopRequested) return;
  const forceRecovery=/agent-script-wake|manual|ui|online|pageshow|visibility|focus/i.test(String(reason||''));
  if(monitorReconnectSuspendedUntil>Date.now() && !forceRecovery) return;
  if(forceRecovery){
    monitorReconnectSuspendedUntil=0;
    reconnectAttempt=0;
    notificationReconnectCycle=1;
    if(monitorReconnectCooldownTimer){ clearTimeout(monitorReconnectCooldownTimer); monitorReconnectCooldownTimer=null; }
  }
  if(socketIsOpen()){
    if($('monitorStatus')?.textContent!=='Running') setMonitorStatus('Running');
    return;
  }
  if(notifySocket && notifySocket.readyState===WebSocket.CONNECTING) return;
  log('INFO',{monitorHealthRecovery:true,reason,socketState:notifySocket?.readyState??'none'});
  try{
    await startMonitor({reason:'health-'+reason});
  }catch(e){
    if(!/OAuth\/MFA recovery started/i.test(e.message||'')){
      log('WARN',{monitorHealthRecoveryFailed:true,reason,error:e.message});
    }
  }
}

function isWakeRequestFresh(request){
  const created=Number(request?.createdAtMs||new Date(request?.createdAt||0).getTime()||0);
  return !!created && Date.now()-created>=0 && Date.now()-created<=MONITOR_WAKE_MAX_AGE_MS;
}

function isValidRuntimeId(value){
  return isValidConversationId(value);
}
function findWakeAgentParticipant(participants,request){
  const requestedId=String(request?.agentParticipantId||'').trim();
  if(isValidRuntimeId(requestedId)){
    const exact=participants.find(p=>p?.id===requestedId && String(p?.purpose||'').toLowerCase()==='agent');
    if(exact) return exact;
  }
  return findCurrentAgentParticipant(participants);
}
function buildWakeFailureRecord(snapshot,request,agent,reasonText,reason){
  const participants=snapshot?.participants||[];
  const customer=participants.find(p=>String(p?.purpose||'').toLowerCase()==='customer')||{};
  const fallbackAgent=agent||{
    id:String(request?.agentParticipantId||''),
    userId:currentUser?.id||'',
    name:request?.agentName||currentUser?.name||'Agent'
  };
  const info={state:'JOINED / CONNECTED',note:reasonText};
  const rec=upsertRecord(
    request.conversationId,
    fallbackAgent,
    {id:'',type:'webmessaging',state:'connected'},
    info,
    snapshot||{},
    customer,
    participants
  );
  rec.greetingStatus='Failed';
  rec.messageType='JOINED+GREETING';
  rec.lastAction=reasonText;
  rec.recoverySource=reason;
  conversations.set(rec.recordId,rec);
  addAdminEvent('JOINED / GREETING NOT SENT',rec,reasonText);
  refreshTables();
  return rec;
}
async function recoverWakeConversation(request, reason){
  if(!request?.conversationId) return;
  try{
    const snapshot=await getConversationSnapshot(request.conversationId);
    const participants=snapshot?.participants||[];
    const agent=findWakeAgentParticipant(participants,request);
    const resolvedComm=agent?getAgentCommunication(agent):{};
    const suppliedCommunicationId=isValidRuntimeId(request.agentCommunicationId) ? String(request.agentCommunicationId).trim() : '';
    const resolvedCommunicationId=isValidRuntimeId(resolvedComm?.id) ? String(resolvedComm.id).trim() : '';
    const effectiveCommunicationId=resolvedCommunicationId || suppliedCommunicationId;
    const resolvedInfo=agent?getAgentState(agent,resolvedComm):{state:'',note:''};
    const participantConnected=!!agent && resolvedInfo.state==='JOINED / CONNECTED';
    const effectiveConnected=participantConnected && !!effectiveCommunicationId;
    const communicationSource=resolvedCommunicationId ? 'conversation-snapshot' : (suppliedCommunicationId ? 'agent-script' : 'missing');

    log('INFO',{
      monitorWakeConversationCheck:true,
      reason,
      conversationId:request.conversationId,
      suppliedAgentCommunicationId:suppliedCommunicationId,
      resolvedAgentCommunicationId:resolvedCommunicationId,
      effectiveAgentCommunicationId:effectiveCommunicationId,
      communicationSource,
      communicationState:resolvedComm?.state||'',
      participantConnected,
      connected:effectiveConnected
    });

    if(!agent){
      buildWakeFailureRecord(
        snapshot,request,null,
        'Joined/Greeting not sent: logged-in agent participant could not be resolved from the conversation.',
        reason
      );
      return;
    }
    if(!effectiveCommunicationId){
      buildWakeFailureRecord(
        snapshot,request,agent,
        'Joined/Greeting not sent: agent communication ID was not supplied and could not be resolved.',
        reason
      );
      return;
    }
    if(!participantConnected){
      buildWakeFailureRecord(
        snapshot,request,agent,
        'Joined/Greeting not sent: connected agent communication could not be confirmed.',
        reason
      );
      return;
    }

    const customer=participants.find(p=>String(p.purpose||'').toLowerCase()==='customer')||{};
    const effectiveComm={
      ...resolvedComm,
      id:effectiveCommunicationId,
      type:resolvedComm?.type||'webmessaging',
      state:resolvedComm?.state||'connected',
      connectedTime:resolvedComm?.connectedTime||agent.connectedTime||agent.startTime||''
    };
    const info={state:'JOINED / CONNECTED',note:`Page-load recovery confirmed connected agent leg. Communication source: ${communicationSource}.`};
    const rec=upsertRecord(request.conversationId,agent,effectiveComm,info,snapshot,customer,participants);
    rec.recoverySource=reason;
    rec.lastAction='Page-load fallback confirmed the connected agent leg. Checking Joined/Greeting delivery.';
    conversations.set(rec.recordId,rec);
    addAdminEvent('PAGE-LOAD FALLBACK CONNECTED',rec,rec.lastAction);
    refreshTables();
    await maybeAutoSendGreeting(rec);
  }catch(e){
    log('WARN',{monitorWakeConversationRecoveryFailed:true,reason,conversationId:request.conversationId,error:e.message});
    try{
      buildWakeFailureRecord(
        {participants:[]},request,null,
        `Joined/Greeting not sent: page-load recovery failed. ${e.message}`,
        reason
      );
    }catch(_){}
  }
}

async function handleMonitorWakeRequest(request, source){
  if(!request || request.type!=='GCB_MONITOR_WAKE_REQUEST') return;
  if(!isWakeRequestFresh(request)) return;
  const requestId=String(request.requestId||'');
  if(requestId && processedWakeRequests.has(requestId)) return;
  if(requestId){
    processedWakeRequests.add(requestId);
    if(processedWakeRequests.size>100){
      const first=processedWakeRequests.values().next().value;
      processedWakeRequests.delete(first);
    }
  }

  log('INFO',{
    monitorWakeRequestReceived:true,
    source,
    requestId,
    conversationId:request.conversationId||'',
    agentCommunicationId:request.agentCommunicationId||'',
    forceStart:request.forceStart!==false,
    currentStatus:$('monitorStatus')?.textContent||'',
    socketOpen:socketIsOpen()
  });

  if(request.forceStart!==false){
    manualStopRequested=false;
  }

  try{
    await ensureMonitorHealthy('agent-script-wake');
    if(socketIsOpen()){
      await recoverWakeConversation(request,'agent-script-wake-primary');
    }else{
      setTimeout(()=>recoverWakeConversation(request,'page-load-fallback-joined-greeting'),PAGE_LOAD_FALLBACK_DELAY_MS);
    }
  }catch(e){
    setMonitorStatus('Recovery failed');
    log('ERROR',{monitorWakeRequestFailed:true,source,requestId,error:e.message});
  }
}

function installMonitorWakeListener(){
  if(monitorWakeChannel) return;

  try{
    if('BroadcastChannel' in window){
      monitorWakeChannel=new BroadcastChannel(MONITOR_WAKE_CHANNEL);
      monitorWakeChannel.onmessage=event=>{
        handleMonitorWakeRequest(event.data,'broadcast').catch(e=>log('ERROR',{monitorWakeUnhandled:true,error:e.message}));
      };
    }
  }catch(e){
    log('WARN',{monitorWakeBroadcastChannelFailed:true,error:e.message});
  }

  window.addEventListener('storage',event=>{
    if(event.key!==MONITOR_WAKE_EVENT_KEY || !event.newValue) return;
    try{
      handleMonitorWakeRequest(JSON.parse(event.newValue),'storage').catch(e=>log('ERROR',{monitorWakeUnhandled:true,error:e.message}));
    }catch(e){
      log('WARN',{monitorWakeStorageParseFailed:true,error:e.message});
    }
  });

  try{
    const latestRaw=localStorage.getItem(MONITOR_WAKE_LAST_KEY);
    const latest=latestRaw?JSON.parse(latestRaw):null;
    if(latest && isWakeRequestFresh(latest)){
      setTimeout(()=>handleMonitorWakeRequest(latest,'startup-last-wake'),250);
    }
  }catch(e){
    log('WARN',{monitorWakeStartupReadFailed:true,error:e.message});
  }

  log('INFO',{monitorWakeListenerInstalled:true,channel:MONITOR_WAKE_CHANNEL});
}

function installMonitorLifecycleRecovery(){
  if(monitorWatchdogTimer) return;
  const recover=(reason)=>ensureMonitorHealthy(reason);
  document.addEventListener('visibilitychange',()=>{
    if(document.visibilityState==='visible') recover('visibility');
  });
  window.addEventListener('focus',()=>recover('focus'));
  window.addEventListener('online',()=>recover('online'));
  window.addEventListener('pageshow',()=>recover('pageshow'));
  monitorWatchdogTimer=setInterval(()=>recover('watchdog'),MONITOR_WATCHDOG_MS);
  log('INFO',{monitorLifecycleRecoveryInstalled:true,watchdogMs:MONITOR_WATCHDOG_MS});
}
const transferResolutionLocks=new Set();
function handleNotification(msg){
  const body=msg.eventBody||msg.body||msg; if(!body||typeof body!=='object')return;
  processConversationBody(body,'notification');
}
function processConversationBody(body, source='notification'){
  const conversationId=body.id||body.conversationId||body.conversation?.id;
  const participants=body.participants||body.conversation?.participants||[];
  if(!conversationId||!Array.isArray(participants))return;
  const agent=findCurrentAgentParticipant(participants);
  if(!agent){
    if(source==='notification') resolveCurrentAgentLeg(conversationId,'agent-participant-missing');
    return;
  }
  const customer=participants.find(p=>String(p.purpose||'').toLowerCase()==='customer')||{};
  const comm=getAgentCommunication(agent);
  const info=getAgentState(agent, comm); if(!info.state)return;
  // Transfer notifications can arrive before the new agent communication leg is attached.
  // Do not send or create a failed record until the full conversation snapshot is re-read.
  if(info.state==='JOINED / CONNECTED' && !comm.id){
    log('INFO',{transferLegPending:true,conversationId,agentParticipantId:agent.id||'',agentUserId:agent.userId||agent.user?.id||'',source});
    resolveCurrentAgentLeg(conversationId,'communication-id-missing');
    return;
  }
  const rec=upsertRecord(conversationId,agent,comm,info,body,customer,participants);
  addAdminEvent(info.state, rec, info.note);
  refreshTables();
  if(info.state==='JOINED / CONNECTED'){
    log('INFO',`JOINED / CONNECTED detected. recordId=${rec.recordId}; conversationId=${rec.conversationId}; communicationId=${rec.communicationId||'-'}; autoSend=${$('autoSendGreeting').checked}; source=${source}`);
    maybeAutoSendGreeting(rec).catch(async e=>{
      rec.greetingStatus='Failed';
      rec.lastAction=e.message;
      addAdminEvent('AUTO GREETING ERROR',rec,e.message);
      log('ERROR',e.message);
      await writeChatMonitorAgentLogSafe(
        rec,
        'FAILED',
        'MESSAGE_SEND',
        `messageType::${rec.messageType || 'MESSAGE'} ==> error::${e.message || e}`
      );
      refreshTables();
    });
  }
}
function findCurrentAgentParticipant(participants){
  const me=currentUser?.id;
  const agents=participants.filter(p=>String(p.purpose||'').toLowerCase()==='agent');
  if(me){
    const mine=agents.filter(p=>(p.userId||p.user?.id)===me);
    return mine.sort((a,b)=>new Date(b.connectedTime||b.startTime||0)-new Date(a.connectedTime||a.startTime||0))[0]||null;
  }
  return agents.sort((a,b)=>new Date(b.connectedTime||b.startTime||0)-new Date(a.connectedTime||a.startTime||0))[0]||null;
}
async function resolveCurrentAgentLeg(conversationId, reason){
  if(!conversationId||transferResolutionLocks.has(conversationId))return;
  transferResolutionLocks.add(conversationId);
  const waits=[250,1000,3000];
  try{
    for(let i=0;i<waits.length;i++){
      await delay(waits[i]);
      let snapshot;
      try{ snapshot=await getConversationSnapshot(conversationId); }
      catch(e){ log('WARN',{transferLegResolveAttempt:i+1,conversationId,reason,error:e.message}); continue; }
      const participants=snapshot?.participants||[];
      const agent=findCurrentAgentParticipant(participants);
      const comm=agent?getAgentCommunication(agent):{};
      const info=agent?getAgentState(agent,comm):{state:'',note:''};
      log('INFO',{transferLegResolveAttempt:i+1,conversationId,reason,agentParticipantId:agent?.id||'',agentCommunicationId:comm?.id||'',communicationState:comm?.state||'',resolved:!!(agent&&comm?.id&&info.state==='JOINED / CONNECTED')});
      if(agent&&comm?.id&&info.state==='JOINED / CONNECTED'){
        processConversationBody(snapshot,'conversation-refresh');
        return;
      }
    }
    log('WARN',{transferLegResolveExhausted:true,conversationId,reason,attempts:waits.length});
  }finally{
    transferResolutionLocks.delete(conversationId);
  }
}
function getAgentCommunication(agent){
  const arr=(agent.messages||agent.sessions||agent.calls||[]).filter(s=>String(s.type||'').toLowerCase().includes('webmessaging'));
  if(!arr.length) return (agent.messages||agent.sessions||agent.calls||[])[0] || {};
  const activeConnected = arr.filter(s=>{
    const st=String(s.state||'').toLowerCase();
    return !s.endTime && !st.includes('disconnect') && !st.includes('terminated') && (st.includes('connect') || s.connectedTime);
  }).sort((a,b)=>new Date(b.connectedTime||0)-new Date(a.connectedTime||0));
  if(activeConnected.length) return activeConnected[0];
  const alerting = arr.filter(s=>{
    const st=String(s.state||'').toLowerCase();
    return !s.endTime && (st.includes('alert') || st.includes('routing'));
  }).sort((a,b)=>new Date(b.connectedTime||b.startTime||0)-new Date(a.connectedTime||a.startTime||0));
  if(alerting.length) return alerting[0];
  return arr.sort((a,b)=>new Date(b.connectedTime||b.disconnectedTime||b.endTime||0)-new Date(a.connectedTime||a.disconnectedTime||a.endTime||0))[0] || {};
}
function getAgentState(agent, selectedComm={}){
  const directState=String(agent.state||agent.direction||'').toLowerCase(); let state='', note='';
  const sState=String(selectedComm.state||'').toLowerCase();
  if(sState.includes('alert') || sState.includes('routing')){ state='ASSIGNED / ALERTING'; note='Selected web messaging leg is alerting/routing.'; }
  if(!selectedComm.endTime && (sState.includes('connect') || selectedComm.connectedTime)){ state='JOINED / CONNECTED'; note='Selected web messaging leg is connected.'; }
  if(selectedComm.endTime || sState.includes('disconnect') || sState.includes('terminated')){ state='ENDED / DISCONNECTED'; note='Selected web messaging leg ended/disconnected.'; }
  if(!state){
    if(directState.includes('alert')||directState.includes('routing')){state='ASSIGNED / ALERTING';note='Agent participant state indicates alerting/routing.'}
    if(directState.includes('connect')||agent.connectedTime||agent.startTime){state='JOINED / CONNECTED';note='Agent participant has connectedTime/startTime.'}
    if(agent.endTime||directState.includes('disconnect')||directState.includes('terminated')){state='ENDED / DISCONNECTED';note='Agent participant ended/disconnected.'}
  }
  return {state,note};
}
function pruneTrackedConversations(){
  if(conversations.size<=MAX_TRACKED_CONVERSATIONS) return;
  const list=Array.from(conversations.values()).sort((a,b)=>{
    const aEnded=/ENDED|DISCONNECTED/i.test(String(a.state||'')) ? 1 : 0;
    const bEnded=/ENDED|DISCONNECTED/i.test(String(b.state||'')) ? 1 : 0;
    if(aEnded!==bEnded) return bEnded-aEnded;
    return new Date(a.connectedTime||a.firstTime||0)-new Date(b.connectedTime||b.firstTime||0);
  });
  while(conversations.size>MAX_TRACKED_CONVERSATIONS && list.length){
    const oldest=list.shift();
    if(oldest?.recordId) conversations.delete(oldest.recordId);
  }
}
function upsertRecord(conversationId,agent,comm,info,body,customer,participants=[]){
  const agentUserId=agent.userId||agent.user?.id||currentUser?.id||'';
  const participantId=agent.id||'';
  const communicationId=comm.id||'';
  // One record per connected agent leg. This is important for transfer-back scenarios:
  // Agent 1 -> Agent 2 -> Agent 1 must send a new joined message for the second Agent 1 leg.
  const recordId=[conversationId, participantId||'NO_PARTICIPANT', communicationId||'NO_COMM'].join('|');
  const existing=conversations.get(recordId)||{};
  const customerAttrs=customer.attributes||{};
  refreshBannerLayoutFromAttributes(customerAttrs);
  const gcbConfig=getGcbMessageConfig(customerAttrs);
  if(currentUser?.id){ updateViewAccess({roleNames: Array.from(userRoleCache.values()).find(x=>x && Array.isArray(x.roleNames))?.roleNames || []}, gcbConfig); }
  const customerSessionId=getCustomerSessionId(customer, customerAttrs);
  const customerSessionStartTime=getCustomerSessionStartTime(customer, customerAttrs);
  const currentAgentConnectedTime=comm.connectedTime||agent.connectedTime||agent.startTime||'';
  const previousAgentCount=getPreviousDifferentAgentCount(participants, agentUserId, participantId, currentAgentConnectedTime, customerSessionStartTime);
  const isTransferJoin=previousAgentCount>0;
  const baseMessageType=isTransferJoin ? 'TRANSFER_JOIN' : 'INITIAL_JOIN';
  const rec={...existing, recordId, conversationId, lastTime:now(), firstTime:existing.firstTime||now(), state:info.state, note:info.note,
    agentName:agent.name||agent.user?.name||currentUser?.name||'-', agentUserId, participantId:participantId||existing.participantId||'',
    communicationId:communicationId||existing.communicationId||'', channel:comm.toAddress?.name||comm.fromAddress?.name||customer.messages?.[0]?.toAddress?.name||'WebMessaging',
    mediaType:comm.type||'webmessaging', held:!!comm.held, connectedTime:comm.connectedTime||agent.connectedTime||existing.connectedTime||'',
    greetingStatus:existing.greetingStatus||'Pending', lastAction:info.note || existing.lastAction || '-', raw:body, gcbParticipantAttributes: customerAttrs,
    customerParticipantId:customer.id||existing.customerParticipantId||'', customerSessionId, customerSessionStartTime, customerSessionSource:getCustomerSessionSource(customer,customerAttrs),
    existingJoinedKeys:collectExistingJoinedKeys(participants) || customerAttrs.AFT_GCB_JoinedSentKeys || customerAttrs.AFT_GCB_GREETING_SENT_KEYS || '', isTransferJoin, previousAgentCount, messageType:existing.messageType||baseMessageType, supervisorRole:false,
    supervisorRoleChecked:false, roleNames:existing.roleNames||'', gcbConfig };
  if(info.state.includes('ENDED')) rec.greetingStatus = rec.greetingStatus==='Sent' ? 'Sent' : 'Skipped';
  conversations.set(recordId,rec); pruneTrackedConversations(); latestConversationId=conversationId; latestCommunicationId=rec.communicationId||latestCommunicationId; return rec;
}
function getCustomerSessionId(customer, attrs={}){
  const msg=(customer.messages||customer.sessions||[])[0]||{};
  return msg.journeyContext?.customerSession?.id || attrs.sessionID || attrs.SI_Summary_Customer_StartDateTime || attrs.SI_Message_UserTypedMessage || msg.connectedTime || customer.connectedTime || 'NO_SESSION';
}
function getCustomerSessionStartTime(customer, attrs={}){
  const msg=(customer.messages||customer.sessions||[])[0]||{};
  return msg.connectedTime || customer.connectedTime || attrs.SI_Summary_Customer_StartDateTime || '';
}
function getCustomerSessionSource(customer, attrs={}){
  const msg=(customer.messages||customer.sessions||[])[0]||{};
  if(msg.journeyContext?.customerSession?.id) return 'journeyContext.customerSession.id';
  if(attrs.sessionID) return 'sessionID';
  if(attrs.SI_Summary_Customer_StartDateTime) return 'SI_Summary_Customer_StartDateTime';
  if(msg.connectedTime) return 'customer message connectedTime';
  if(customer.connectedTime) return 'customer participant connectedTime';
  return 'fallback';
}
function collectExistingJoinedKeys(participants=[]){
  const keys=[];
  for(const p of participants){
    const a=p.attributes||{};
    for(const k of ['AFT_GCB_JoinedSentKeys','AFT_GCB_GREETING_SENT_KEYS']){
      if(a[k]) keys.push(String(a[k]));
    }
  }
  return keys.filter(Boolean).join(';');
}
function getPreviousDifferentAgentCount(participants=[], currentAgentUserId='', currentParticipantId='', currentAgentConnectedTime='', customerSessionStartTime=''){
  const currentMs=Date.parse(currentAgentConnectedTime || '') || 0;
  const sessionStartMs=Date.parse(customerSessionStartTime || '') || 0;
  const sessionWindowStartMs=sessionStartMs ? sessionStartMs - 5000 : 0;

  return participants.filter(p=>{
    if(String(p.purpose||'').toLowerCase()!=='agent') return false;
    const uid=p.userId||p.user?.id||'';
    const pid=p.id||'';
    if(pid && currentParticipantId && pid===currentParticipantId) return false;
    if(!uid) return false;

    const comms=(p.messages||p.sessions||p.calls||[]);
    const times=[p.connectedTime,p.startTime,p.endTime];
    comms.forEach(c=>times.push(c.connectedTime,c.startTime,c.disconnectedTime,c.endTime));
    const validTimes=times.map(t=>Date.parse(t||'')).filter(n=>Number.isFinite(n) && n>0);
    const agentMs=validTimes.length ? Math.min(...validTimes) : 0;

    // Threading-safe rule:
    // A previous agent from an older customer web session must NOT convert the current first join into a transfer.
    // Count only prior agent legs that belong to the current customer session window.
    if(sessionWindowStartMs && agentMs && agentMs < sessionWindowStartMs) return false;

    // Count only legs that happened before the current connected leg.
    // This keeps initial assignment as Agent Joined, even if the logged-in user has Supervisor role.
    if(currentMs && agentMs && agentMs >= currentMs) return false;

    // Any earlier/different agent participant in the same customer session means transfer/new join.
    // We intentionally count the same user in a different participant leg too, to support transfer-back.
    return !!(p.connectedTime || p.endTime || comms.length);
  }).length;
}
function buildGreetingKey(rec, msgType){
  // v1.2.5 validation rule:
  // Validate duplicate control only with the active agent communication leg.
  // Key = Conversation ID + Customer Session ID + Agent Communication ID + Message Type.
  // This allows a reconnected/new live chat leg in the same threaded conversation to send again,
  // while the same active leg is skipped once the key exists in participant data/runtime memory.
  const sessionId=rec.customerSessionId || 'NO_SESSION';
  const agentCommId=rec.communicationId || rec.participantId || rec.agentUserId || 'NO_AGENT_COMM';
  return [rec.conversationId, sessionId, agentCommId, msgType].join('|');
}
function hasKey(existingKeys, key){
  return String(existingKeys||'').split(/[;,\n]+/).map(x=>x.trim()).filter(Boolean).includes(key);
}
function appendKey(existingKeys, key){
  const keys=String(existingKeys||'').split(/[;,\n]+/).map(x=>x.trim()).filter(Boolean);
  if(!keys.includes(key)) keys.push(key);
  return keys.slice(-25).join(';');
}
function safeLocalKey(key){
  return String(key||'').replace(/[^a-zA-Z0-9_.:-]/g,'_').slice(0,420);
}
function localDoneExists(key){
  try{ return localStorage.getItem(FAST_LOCAL_DONE_PREFIX + safeLocalKey(key)) === 'YES'; }catch(_){ return false; }
}
function markLocalDone(key){
  try{ localStorage.setItem(FAST_LOCAL_DONE_PREFIX + safeLocalKey(key), 'YES'); }catch(_){}
}
function acquireFastLocalLock(key){
  try{
    const storageKey=FAST_LOCAL_LOCK_PREFIX + safeLocalKey(key);
    const nowMs=Date.now();
    const raw=localStorage.getItem(storageKey);
    if(raw){
      try{
        const lock=JSON.parse(raw);
        if(nowMs - Number(lock.time || 0) < FAST_LOCAL_LOCK_TTL_MS) return false;
      }catch(_){}
    }
    localStorage.setItem(storageKey, JSON.stringify({key, owner: MONITOR_INSTANCE_ID, time: nowMs, savedAtUtc: new Date().toISOString()}));
    return true;
  }catch(_){ return true; }
}
function releaseFastLocalLock(key){
  try{ localStorage.removeItem(FAST_LOCAL_LOCK_PREFIX + safeLocalKey(key)); }catch(_){}
}
function cleanGcbText(value){
  const text=String(value ?? '').trim();
  if(!text || ['null','undefined','--na--','na','n/a'].includes(text.toLowerCase())) return '';
  return text;
}

function parseConfigBoolean(value, defaultValue=false){
  const normalized=cleanGcbText(value).toLowerCase();
  if(!normalized) return !!defaultValue;
  if(['true','1','yes','y','on','enabled'].includes(normalized)) return true;
  if(['false','0','no','n','off','disabled'].includes(normalized)) return false;
  return !!defaultValue;
}
function getConversationLanguage(attrs={}){
  return cleanGcbText(attrs.language || attrs.Language || attrs.AFT_Language || attrs.Chat_Language || attrs.SI_Language || attrs.customerLanguage || 'en').toLowerCase();
}
function pickLanguageSpecificText(attrs, enName, arName){
  const lang = getConversationLanguage(attrs);
  const isArabic = lang === 'ar' || lang === 'arabic' || lang.includes('arabic');
  return cleanGcbText(isArabic ? (attrs[arName] || '') : (attrs[enName] || ''));
}
function getGcbMessageConfig(attrs={}){
  const supervisorKeyword = cleanGcbText(attrs.AFT_GCB_SupervisorKeyword || attrs.AFT_GCB_SupervisorKeywordDefault || 'supervisor') || 'supervisor';
  const supportRoles = cleanGcbText(attrs.AFT_GCB_SupportRoles || '');
  const adminRoles = cleanGcbText(attrs.AFT_GCB_AdminRoles || '');
  const cfg = {
    agentJoinedText: pickLanguageSpecificText(attrs, 'AFT_GCB_AgentJoinedText_EN', 'AFT_GCB_AgentJoinedText_AR'),
    supervisorJoinedText: pickLanguageSpecificText(attrs, 'AFT_GCB_SupervisorJoinedText_EN', 'AFT_GCB_SupervisorJoinedText_AR'),
    supervisorKeyword,
    greetingText: pickLanguageSpecificText(attrs, 'AFT_GCB_GreetingText_EN', 'AFT_GCB_GreetingText_AR'),
    transferGreetingText: pickLanguageSpecificText(attrs, 'AFT_GCB_TransferGreetingText_EN', 'AFT_GCB_TransferGreetingText_AR'),
    sendGreetingForSupervisor: parseConfigBoolean(attrs.AFT_GCB_SendGreetingForSupervisor, false),
    supportRolesText: supportRoles,
    adminRolesText: adminRoles,
    bannerLayout: normalizeBannerLayout(getBannerLayoutFromAttrs(attrs) || 'light')
  };
  latestGcbAccessConfig = {
    supportRoles: splitCsvConfig(supportRoles, DEFAULT_SUPPORT_ROLES),
    adminRoles: splitCsvConfig(adminRoles, DEFAULT_ADMIN_ROLES),
    supportRolesText: supportRoles,
    adminRolesText: adminRoles,
    supervisorKeyword
  };
  return cfg;
}
function getAgentNickname(){
  return cleanGcbText($('agentNickname')?.textContent || currentUser?.preferredName || currentUser?.name || currentUser?.email || 'Agent') || 'Agent';
}
function applyGcbPlaceholders(text){
  let output=cleanGcbText(text);
  if(!output) return '';
  const nick=getAgentNickname();
  output=output.replace(/<agent nickname>/gi, nick);
  output=output.replace(/\{\{\s*AgentNickname\s*\}\}/gi, nick);
  output=output.replace(/\{\{\s*AgentName\s*\}\}/gi, nick);
  return output.trim();
}
function getTextSourceLabel(config, key){
  const map={agentJoinedText:'AFT_GCB_AgentJoinedText_EN / _AR', supervisorJoinedText:'AFT_GCB_SupervisorJoinedText_EN / _AR', supervisorKeyword:'AFT_GCB_SupervisorKeywordDefault', greetingText:'AFT_GCB_GreetingText_EN / _AR', transferGreetingText:'AFT_GCB_TransferGreetingText_EN / _AR'};
  return config?.[key] ? map[key] : 'blank / skipped';
}
function getSupervisorKeywords(keywordText){
  // RAKBANK supervisor role rule is now configurable from participant data:
  // AFT_GCB_SupervisorKeywordDefault. Default remains "supervisor".
  const raw=cleanGcbText(keywordText || 'supervisor') || 'supervisor';
  return raw.split(/[;,|]/).map(x=>x.trim().toLowerCase()).filter(Boolean);
}
function isAuthorizationScopeMissing(errors){
  const text = (errors || []).join(' | ').toLowerCase();
  return text.includes('app.not.authorized.for.scope') ||
         text.includes('scope [authorization') ||
         text.includes('authorization:readonly');
}
function normalizeForCompare(value){
  return String(value || '').trim().toLowerCase();
}
function isProbablyUserIdentityValue(value, userId){
  const v = normalizeForCompare(value);
  if(!v) return true;
  const cu = currentUser || {};
  const compare = [
    userId,
    cu.id,
    cu.name,
    cu.email,
    cu.username,
    cu.preferredName,
    cu.displayName
  ].map(normalizeForCompare).filter(Boolean);
  return compare.includes(v);
}
function extractRoleNames(subject){
  const names=[];
  const ids=[];
  function addName(v){ if(typeof v==='string' && v.trim()) names.push(v.trim()); }
  function addId(v){ if(typeof v==='string' && v.trim()) ids.push(v.trim()); }
  function looksRoleContainer(key){
    return ['role','roles','roleids','rolename','grants','entities','items','inheritedroles','subjectroles','authorizationroles','permissions'].includes(String(key||'').toLowerCase());
  }
  function walk(x,parentKey=''){
    if(!x) return;
    if(Array.isArray(x)){ x.forEach(v=>walk(v,parentKey)); return; }
    if(typeof x==='object'){
      const pk=String(parentKey||'').toLowerCase();
      const hasRoleShape = ('roleName' in x) || ('roleId' in x) || ('role' in x) || ('permissions' in x) || ('division' in x) || pk.includes('role') || ['roles','grants','entities','items','inheritedroles','subjectroles','authorizationroles'].includes(pk);
      if(hasRoleShape){
        addName(x.name); addName(x.roleName); addName(x.displayName);
        addId(x.id); addId(x.roleId);
      }
      for(const [k,v] of Object.entries(x)){
        const kl=String(k||'').toLowerCase();
        if(kl==='roleid') addId(v);
        if(kl==='rolename') addName(v);
        if(kl==='name' && pk.includes('role')) addName(v);
        if(looksRoleContainer(kl)) walk(v,k);
      }
    } else if(typeof x==='string'){
      const pk=String(parentKey||'').toLowerCase();
      if(pk.includes('roleid') || pk==='roleids') addId(x);
      else if(pk.includes('role') || ['roles','entities','items'].includes(pk)) addName(x);
    }
  }
  walk(subject);
  const cleanNames = Array.from(new Set(names.filter(Boolean))).filter(n=>!/^[-a-f0-9]{30,}$/i.test(n));
  const cleanIds = Array.from(new Set(ids.filter(Boolean)));
  return {roleNames:cleanNames, roleIds:cleanIds};
}
async function resolveRoleIdsToNames(roleIds=[]){
  const missing=roleIds.filter(id=>id && !roleNameById.has(id));
  if(missing.length){
    try{
      const roles=await api('/api/v2/authorization/roles?pageSize=500');
      const entities=roles.entities || roles.roles || roles.items || [];
      entities.forEach(r=>{ if(r.id && r.name) roleNameById.set(r.id,r.name); });
    }catch(e){
      log('WARN',`Role name lookup failed: ${e.message}`);
    }
  }
  return roleIds.map(id=>roleNameById.get(id)).filter(Boolean);
}
async function getUserRoleInfo(userId, forceRefresh=false, supervisorKeyword='supervisor'){
  if(!userId) return {roleNames:[], roleIds:[], isSupervisor:false, fromCache:false};
  const cacheKey=`${userId}|${String(supervisorKeyword||'supervisor').toLowerCase()}`;
  if(!forceRefresh && userRoleCache.has(cacheKey)) return {...userRoleCache.get(cacheKey), fromCache:true};
  const errors=[];
  const payloads=[];
  // Role lookup is intentionally kept simple. For the logged-in client app user,
  // Genesys returns grants[].role.name in /api/v2/authorization/subjects/me.
  // For safety, if the record user is not the current user, use /subjects/{userId}.
  const ep = (currentUser?.id && userId === currentUser.id)
    ? '/api/v2/authorization/subjects/me'
    : `/api/v2/authorization/subjects/${encodeURIComponent(userId)}`;
  try{
    const data=await api(ep);
    payloads.push({endpoint:ep,data});
  }catch(e){
    errors.push(`${ep}: ${e.message}`);
  }
  let roleNames=[];
  let roleIds=[];
  for(const p of payloads){
    const extracted=extractRoleNames(p.data);
    roleNames=roleNames.concat(extracted.roleNames||[]);
    roleIds=roleIds.concat(extracted.roleIds||[]);
  }
  roleNames=Array.from(new Set(roleNames.filter(Boolean))).filter(n=>!isProbablyUserIdentityValue(n, userId));
  roleIds=Array.from(new Set(roleIds.filter(Boolean))).filter(id=>!isProbablyUserIdentityValue(id, userId));
  const lower=roleNames.join(' | ').toLowerCase();
  const keywords=getSupervisorKeywords(supervisorKeyword);
  const isSupervisor=keywords.some(k=>lower.includes(k));
  const authorizationScopeMissing=isAuthorizationScopeMissing(errors);
  const roleLookupFailed=authorizationScopeMissing && roleNames.length===0;
  const info={roleNames,roleIds,isSupervisor,roleLookupFailed,authorizationScopeMissing,supervisorKeyword:keywords.join(','),raw:payloads.map(p=>({endpoint:p.endpoint})),errors};
  userRoleCache.set(cacheKey,info);
  log(isSupervisor?'OK':roleLookupFailed?'WARN':'INFO',{roleCheckUserId:userId,isSupervisor,roleLookupFailed,authorizationScopeMissing,supervisorKeyword:keywords,roleNames,roleIds,endpoint:ep,endpointCount:payloads.length,errors:errors.slice(0,5)});
  return {...info, fromCache:false};
}
async function getJoinedDecision(rec){
  const cfg=rec.gcbConfig || getGcbMessageConfig({});
  const agentJoinedText=applyGcbPlaceholders(cfg.agentJoinedText);
  const supervisorJoinedText=applyGcbPlaceholders(cfg.supervisorJoinedText);
  const greetingText=applyGcbPlaceholders(cfg.greetingText);
  // Architect prepares the final language-specific transfer greeting before GCB sends it.
  const transferGreetingText=applyGcbPlaceholders(cfg.transferGreetingText);
  // Initial queue assignment always uses Agent Joined, even when the user has a supervisor role.
  if(!rec.isTransferJoin){
    const messages=[];
    if(agentJoinedText) messages.push({messageType:'AGENT_JOINED', text:agentJoinedText, duplicateType:'AGENT_JOINED'});
    if(greetingText) messages.push({messageType:'GREETING', text:greetingText, duplicateType:'GREETING'});
    return {messageType:messages.map(m=>m.messageType).join('+') || 'NO_MESSAGE', messages, roleNames:rec.roleNames||'', supervisorRole:false, reason:'Initial connected chat. Agent Joined first, then Greeting if configured.'};
  }
  // For transfers, check whether the newly connected user has a Supervisor role.
  const roleInfo=await getUserRoleInfo(rec.agentUserId,false,cfg.supervisorKeyword);
  const roleNames=(roleInfo.roleNames||[]).join(', ');
  const isSupervisor=!!roleInfo.isSupervisor;
  log(roleInfo.roleLookupFailed?'WARN':isSupervisor?'OK':'INFO',{transferRoleDecision:true,conversationId:rec.conversationId,agentUserId:rec.agentUserId,agentName:rec.agentName,roleNames,isSupervisor,supervisorKeyword:cfg.supervisorKeyword,sendGreetingForSupervisor:cfg.sendGreetingForSupervisor,roleLookupFailed:roleInfo.roleLookupFailed,authorizationScopeMissing:roleInfo.authorizationScopeMissing,rule:'Initial chat => Agent Joined + Greeting; Transfer + supervisor keyword match => Supervisor Joined plus optional Greeting controlled by AFT_GCB_SendGreetingForSupervisor; Transfer + non-supervisor => Agent Joined + Greeting'});
  if(isSupervisor){
    const messages=[];
    if(supervisorJoinedText) messages.push({messageType:'SUPERVISOR_JOINED', text:supervisorJoinedText, duplicateType:'SUPERVISOR_JOINED'});
    if(cfg.sendGreetingForSupervisor && transferGreetingText) messages.push({messageType:'GREETING', text:transferGreetingText, duplicateType:'GREETING'});
    return {
      messageType:messages.map(m=>m.messageType).join('+') || 'NO_MESSAGE',
      messages,
      roleNames,
      supervisorRole:true,
      reason:cfg.sendGreetingForSupervisor
        ? 'Transfer detected and connected user has Supervisor role. Supervisor Joined is sent first, followed by Greeting because AFT_GCB_SendGreetingForSupervisor=true.'
        : 'Transfer detected and connected user has Supervisor role. Only Supervisor Joined is sent because AFT_GCB_SendGreetingForSupervisor is false or missing.'
    };
  }
  const messages=[];
  if(agentJoinedText) messages.push({messageType:'AGENT_JOINED', text:agentJoinedText, duplicateType:'AGENT_JOINED'});
  if(transferGreetingText) messages.push({messageType:'GREETING', text:transferGreetingText, duplicateType:'GREETING'});
  return {messageType:messages.map(m=>m.messageType).join('+') || 'NO_MESSAGE', messages, roleNames, supervisorRole:false, reason:'Transfer detected for a non-supervisor agent. Agent Joined is sent first, followed by the final language-specific Transfer Greeting prepared by Architect.'};
}
async function getConversationSnapshot(conversationId){
  // Used only for duplicate/lock verification. The notification event remains the primary monitor source.
  return api(`/api/v2/conversations/messages/${encodeURIComponent(conversationId)}`);
}
function getCustomerParticipantFromSnapshot(snapshot, rec){
  const participants=snapshot?.participants || [];
  if(rec.customerParticipantId){
    const exact=participants.find(p=>p.id===rec.customerParticipantId);
    if(exact) return exact;
  }
  return participants.find(p=>String(p.purpose||'').toLowerCase()==='customer') || null;
}
async function getLatestCustomerAttributes(rec){
  try{
    const snapshot=await getConversationSnapshot(rec.conversationId);
    const customer=getCustomerParticipantFromSnapshot(snapshot, rec);
    const attrs=customer?.attributes || {};
    return {attrs, customerParticipantId:customer?.id || rec.customerParticipantId || ''};
  }catch(e){
    log('WARN',`Could not fetch latest customer participant attributes for lock verification: ${e.message}`);
    return {attrs:{}, customerParticipantId:rec.customerParticipantId || ''};
  }
}
async function writeChatMonitorAgentLogSafe(rec, status, stage, details){
  try{
    const participantId=String(rec?.participantId||'').trim();
    const conversationId=String(rec?.conversationId||'').trim();
    if(!conversationId || !participantId) return;
    const value=[
      new Date().toISOString(),
      `version::${APP_VERSION}`,
      `stage::${stage || 'MESSAGE_SEND'}`,
      `status::${status || 'INFO'}`,
      details || '',
      participantApiRetrySummary()
    ].filter(Boolean).join(' ==> ').slice(0,4000);
    await api(`/api/v2/conversations/${encodeURIComponent(conversationId)}/participants/${encodeURIComponent(participantId)}/attributes`,{
      method:'PATCH',
      body:JSON.stringify({attributes:{AFT_GCB_Logs_ChatMonitor:value}})
    });
  }catch(e){
    log('WARN',{chatMonitorAgentLogWriteFailed:true,error:e.message,conversationId:rec?.conversationId||'',participantId:rec?.participantId||''});
  }
}
async function reserveCrossTabSendLock(rec, key, msgType){
  if(!rec.customerParticipantId){
    log('WARN',`No customer participant ID found for cross-tab send lock. Falling back to participant-data duplicate check only. key=${key}`);
    return {allowed:true, reason:'No customer participant ID for lock'};
  }

  // First read latest participant data. Another tab may have already completed the send.
  const latestBefore=await getLatestCustomerAttributes(rec);
  const beforeKeys=collectExistingJoinedKeys([{attributes:latestBefore.attrs}]) || latestBefore.attrs.AFT_GCB_JoinedSentKeys || latestBefore.attrs.AFT_GCB_GREETING_SENT_KEYS || rec.existingJoinedKeys || '';
  rec.existingJoinedKeys=beforeKeys;
  if(hasKey(beforeKeys,key)){
    return {allowed:false, reason:'Already sent according to latest participant data'};
  }

  const owner=`${MONITOR_INSTANCE_ID}|${msgType}|${Date.now()}`;
  const attributes={
    AFT_GCB_SendLockKey:key,
    AFT_GCB_SendLockOwner:owner,
    AFT_GCB_SendLockMessageType:msgType,
    AFT_GCB_SendLockTime:new Date().toISOString()
  };
  await api(`/api/v2/conversations/${encodeURIComponent(rec.conversationId)}/participants/${encodeURIComponent(rec.customerParticipantId)}/attributes`,{
    method:'PATCH',body:JSON.stringify({attributes})
  });

  // Wait briefly so if multiple Genesys tabs wrote a lock at the same time, only the last verified owner sends.
  await delay(CROSS_TAB_LOCK_VERIFY_MS + Math.floor(Math.random()*250));
  const latestAfter=await getLatestCustomerAttributes(rec);
  const attrs=latestAfter.attrs || {};
  const afterKeys=collectExistingJoinedKeys([{attributes:attrs}]) || attrs.AFT_GCB_JoinedSentKeys || attrs.AFT_GCB_GREETING_SENT_KEYS || rec.existingJoinedKeys || '';
  rec.existingJoinedKeys=afterKeys;
  if(hasKey(afterKeys,key)){
    return {allowed:false, reason:'Already sent by another tab before lock verification'};
  }
  const ownsLock = attrs.AFT_GCB_SendLockKey===key && attrs.AFT_GCB_SendLockOwner===owner;
  if(!ownsLock){
    return {allowed:false, reason:'Another active Genesys tab owns the send lock'};
  }
  return {allowed:true, owner, reason:'Cross-tab send lock verified'};
}
async function updateCustomerParticipantAttributes(rec, key, decision){
  if(!rec.customerParticipantId){ log('WARN',`No customer participant ID found for ${rec.conversationId}; participant data was not updated.`); return null; }
  // Read latest keys before patching, so concurrent tabs do not overwrite each other's sent-key list.
  const latest=await getLatestCustomerAttributes(rec);
  const latestKeys=collectExistingJoinedKeys([{attributes:latest.attrs}]) || latest.attrs.AFT_GCB_JoinedSentKeys || latest.attrs.AFT_GCB_GREETING_SENT_KEYS || rec.existingJoinedKeys || '';
  const mergedKeys=appendKey(latestKeys, key);
  const attributes={
    AFT_GCB_SessionKey: rec.customerSessionId || '',
    AFT_GCB_JoinedSentKeys: mergedKeys,
    AFT_GCB_LastJoinedMessageType: decision.messageType,
    AFT_GCB_LastJoinedSentBy: rec.agentUserId || '',
    AFT_GCB_LastJoinedSentName: rec.agentName || '',
    AFT_GCB_LastJoinedSentRoleMatch: decision.supervisorRole ? 'Supervisor' : 'Agent',
    AFT_GCB_LastJoinedSentTime: new Date().toISOString(),
    AFT_GCB_SendLockKey:'',
    AFT_GCB_SendLockOwner:'',
    AFT_GCB_SendLockMessageType:'',
    AFT_GCB_SendLockTime:''
  };
  const result=await api(`/api/v2/conversations/${encodeURIComponent(rec.conversationId)}/participants/${encodeURIComponent(rec.customerParticipantId)}/attributes`,{
    method:'PATCH',body:JSON.stringify({attributes})
  });
  rec.existingJoinedKeys=mergedKeys;
  await writeChatMonitorAgentLogSafe(
    rec,
    'SUCCESS',
    'MESSAGE_SEND',
    `messageType::${decision.messageType || 'MESSAGE'} ==> customerParticipantData::UPDATED`
  );
  return result;
}
async function maybeAutoSendGreeting(rec){
  if(!$('autoSendGreeting').checked){ if(rec.greetingStatus==='Pending') rec.lastAction='Connected. Auto-send disabled.'; refreshTables(); return; }
  if(activeSendLocks.has(rec.recordId)){ log('INFO',`Send already in progress for ${rec.recordId}; ignoring duplicate notification.`); return; }
  activeSendLocks.add(rec.recordId);
  rec.greetingStatus = rec.greetingStatus==='Sent' ? 'Sent' : 'Checking';
  rec.lastAction = 'Connected. Checking message config, role rule and duplicate participant data.';
  refreshTables();
  const decision=await getJoinedDecision(rec);
  rec.messageType=decision.messageType; rec.roleNames=decision.roleNames || ''; rec.supervisorRole=decision.supervisorRole; rec.supervisorRoleChecked=rec.isTransferJoin;
  const messages=decision.messages || [];
  if(!messages.length){
    rec.greetingStatus='Skipped';
    rec.lastAction=`No message text configured. Skipped send. ${decision.reason}`;
    addAdminEvent('NO MESSAGE CONFIGURED',rec,rec.lastAction);
    activeSendLocks.delete(rec.recordId); refreshTables(); return;
  }
  if(!rec.communicationId){ rec.greetingStatus='Failed'; rec.lastAction='Missing agent communication ID.'; activeSendLocks.delete(rec.recordId); refreshTables(); return; }
  if(rec.greetingStatus==='Sent' || rec.greetingStatus==='Sending'){ activeSendLocks.delete(rec.recordId); return; }

  const sentTypes=[];
  const skippedTypes=[];
  const sentKeys=[];
  try{
    rec.greetingStatus='Sending'; rec.lastAction=`Sending configured message(s). ${decision.reason}`; refreshTables();
    for(const msg of messages){
      const key=buildGreetingKey(rec, msg.duplicateType || msg.messageType);
      if($('sendGreetingOnlyOnce').checked && (hasKey(rec.existingJoinedKeys,key) || runtimeJoinedKeys.has(key) || localDoneExists(key))){
        skippedTypes.push(msg.messageType);
        dashLastSkip = `${msg.messageType} | participantData/runtime/localDone | ${shortId(rec.conversationId)}`; updateDashboardStatus();
        log('INFO',{duplicateMessageSkipped:true,messageType:msg.messageType,participantDataKey:key,conversationId:rec.conversationId,source:'participantData/runtime/localDone'});
        if(hasKey(rec.existingJoinedKeys,key)) markLocalDone(key);
        continue;
      }

      // v1.2.5:
      // Build the send key first, then reserve it immediately in runtime memory + localStorage
      // before any async send/read flow. This mirrors the old GCB fast local lock approach,
      // but the key includes the active agent communication ID so reconnect/transfer legs can send again.
      runtimeJoinedKeys.add(key);
      if(!acquireFastLocalLock(key)){
        skippedTypes.push(msg.messageType);
        dashLastSkip = `${msg.messageType} | fastLocalLockActive | ${shortId(rec.conversationId)}`; updateDashboardStatus();
        log('INFO',{duplicateMessageSkipped:true,messageType:msg.messageType,participantDataKey:key,conversationId:rec.conversationId,source:'fastLocalLockActive'});
        continue;
      }
      log('INFO',{sendKeyReservedFastLocal:true,messageType:msg.messageType,participantDataKey:key,conversationId:rec.conversationId,communicationId:rec.communicationId,owner:MONITOR_INSTANCE_ID});

      let result;
      try{
        result=await sendMessage(rec.conversationId,rec.communicationId,msg.text);
        markLocalDone(key);
      }finally{
        releaseFastLocalLock(key);
      }
      sentTypes.push(msg.messageType);
      sentKeys.push({key,msg,result});
      addAgentMsg(rec.agentName, msg.text, 'agent');
      addAdminEvent(`${msg.messageType} SENT`,rec,'Send API success. '+decision.reason);
      dashLastSent = `${msg.messageType} | ${shortId(rec.conversationId)} | ${shortId(rec.communicationId)}`; updateDashboardStatus(); log('OK',{autoMessageSent:true,messageType:msg.messageType,conversationId:rec.conversationId,customerSessionId:rec.customerSessionId,communicationId:rec.communicationId,duplicateKeyMode:'COMMUNICATION_LEG_FASTLOCAL',participantDataKey:key,participantId:rec.participantId,result});
    }
    if(sentKeys.length){
      // Update participant data once for every sent message key. Existing duplicate list is merged each time.
      for(const item of sentKeys){
        try{ await updateCustomerParticipantAttributes(rec,item.key,{...decision,messageType:item.msg.messageType,supervisorRole:decision.supervisorRole}); }
        catch(attrErr){ log('WARN',`Participant data update failed for ${rec.conversationId}: ${attrErr.message}`); }
      }
    }
    if(sentTypes.length){
      rec.greetingStatus='Sent'; rec.sentTime=now(); rec.lastAction=`Sent: ${sentTypes.join(', ')}. ${skippedTypes.length ? 'Skipped duplicate: '+skippedTypes.join(', ')+'. ' : ''}${decision.reason} Participant data updated.`;
    }else{
      rec.greetingStatus='Sent'; rec.lastAction=`Already sent previously. Skipped duplicate: ${skippedTypes.join(', ') || 'all configured messages'}. ${decision.reason}`;
    }
  }catch(e){
    rec.greetingStatus='Failed'; rec.lastAction=e.message; addAdminEvent(`${decision.messageType} FAILED`,rec,e.message); log('ERROR',e.message);
  }
  activeSendLocks.delete(rec.recordId);
  conversations.set(rec.recordId,rec); refreshTables();
}
async function sendMessage(conversationId, communicationId, text){
  const payload={textBody:text};
  return api(`/api/v2/conversations/messages/${encodeURIComponent(conversationId)}/communications/${encodeURIComponent(communicationId)}/messages`,{method:'POST',body:JSON.stringify(payload)});
}
async function sendAgentMessageTest(){
  const conversationId=$('sendConversationId').value.trim(), communicationId=$('sendCommunicationId').value.trim(), text=$('sendText').value.trim();
  if(!conversationId||!communicationId||!text){alert('conversationId, communicationId and message text are required.');return;}
  try{ const result=await sendMessage(conversationId,communicationId,text); log('OK',{sentWithPayload:{textBody:text},result}); addAgentMsg(currentUser?.name||'Agent',text,'agent'); }
  catch(e){ log('ERROR',e.message); }
}
function fillLatestSendTest(){ $('sendConversationId').value=latestConversationId; $('sendCommunicationId').value=latestCommunicationId; }

function firstAvailableConfigRecord(){
  const list=Array.from(conversations.values()).sort((a,b)=>(b.firstTime||'').localeCompare(a.firstTime||''));
  return list.find(r=>r && r.gcbParticipantAttributes && Object.keys(r.gcbParticipantAttributes).length) || list[0] || null;
}
function normalizeAttrValueForStatus(value){
  const text=String(value ?? '').trim();
  if(!text || ['null','undefined','--na--','na','n/a'].includes(text.toLowerCase())) return '';
  return text;
}
function formatConfigValue(value){
  const text=normalizeAttrValueForStatus(value);
  if(!text) return '<span class="missingText">[missing]</span>';
  const short=text.length>160 ? text.slice(0,157)+'...' : text;
  return escapeHtml(short);
}
function buildConfigStatusRows(attrs={}){
  return EXPECTED_GCB_PARTICIPANT_ATTRIBUTES.map(item=>{
    const value=normalizeAttrValueForStatus(attrs[item.name]);
    const ok=!!value;
    const status=ok ? '<span class="badge sent">OK</span>' : (item.required ? '<span class="badge fail">Missing</span>' : '<span class="badge skip">Optional</span>');
    return `<tr><td><b>${escapeHtml(item.name)}</b><br><span class="small">${escapeHtml(item.group)}</span></td><td>${formatConfigValue(value)}</td><td>${status}</td></tr>`;
  }).join('');
}
function refreshParticipantConfigStatus(){
  const rec=firstAvailableConfigRecord();
  const attrs=(rec && rec.gcbParticipantAttributes) || {};
  refreshBannerLayoutFromAttributes(attrs);
  const total=EXPECTED_GCB_PARTICIPANT_ATTRIBUTES.length;
  const required=EXPECTED_GCB_PARTICIPANT_ATTRIBUTES.filter(x=>x.required).length;
  const okRequired=EXPECTED_GCB_PARTICIPANT_ATTRIBUTES.filter(x=>x.required && normalizeAttrValueForStatus(attrs[x.name])).length;
  const missing=required-okRequired;
  const summary=rec ? `Conversation: ${shortId(rec.conversationId)} | Data Table Participant Config: ${okRequired}/${required} OK | Missing: ${missing}` : 'Waiting for active conversation participant data.';
  const rows=rec ? buildConfigStatusRows(attrs) : '<tr><td class="small" colspan="3">No participant data loaded yet.</td></tr>';
  const supportBody=$('supportConfigStatus'); if(supportBody) supportBody.innerHTML=rows;
  const adminBody=$('adminConfigStatus'); if(adminBody) adminBody.innerHTML=rows;
  const supportSummary=$('supportConfigSummary'); if(supportSummary) supportSummary.textContent=summary;
  const adminSummary=$('adminConfigSummary'); if(adminSummary) adminSummary.textContent=summary;
}
function refreshTables(){
  const list=Array.from(conversations.values()).sort((a,b)=>(b.firstTime||'').localeCompare(a.firstTime||''));
  const active=list.filter(r=>r.state==='JOINED / CONNECTED'); const sent=list.filter(r=>r.greetingStatus==='Sent'); const pending=list.filter(r=>r.greetingStatus==='Pending'||r.greetingStatus==='Sending'); const failed=list.filter(r=>r.greetingStatus==='Failed'||r.greetingStatus==='Skipped');
  $('mActive').textContent=active.length; $('mSent').textContent=sent.length; $('mPending').textContent=pending.length; $('mFailed').textContent=failed.length; $('sTotal').textContent=list.length; $('sSent').textContent=sent.length; $('sPending').textContent=pending.length; $('sFailed').textContent=failed.length;
  const agentRows=list.map(r=>`<tr><td>${escapeHtml(r.lastTime)}</td><td>${escapeHtml(shortId(r.conversationId))}</td><td>${escapeHtml(shortId(r.customerSessionId||'-'))}</td><td>${escapeHtml(r.isTransferJoin?'Transfer Join':'Initial Join')}</td><td>${greetingBadge(r.greetingStatus)}<br><span class="small">${escapeHtml(r.messageType||'-')}</span></td><td>${escapeHtml(r.lastAction||r.note||'-')}${r.recoverySource?`<br><span class="small">Source: ${escapeHtml(r.recoverySource)}</span>`:''}</td></tr>`).join('') || '<tr><td colspan="6" class="small">No active chats detected yet.</td></tr>';
  $('agentTable').innerHTML=agentRows;
  const supportRows=list.map(r=>`<tr><td>${escapeHtml(r.lastTime)}</td><td>${escapeHtml(r.conversationId)}</td><td>${escapeHtml(r.customerSessionId||'-')}</td><td>${escapeHtml(r.communicationId||'-')}</td><td>${escapeHtml(r.isTransferJoin?'Yes':'No')}</td><td title="${escapeHtml(r.participantId||'-')}">${escapeHtml(shortId(r.participantId||'-'))}<br><span class="small">${escapeHtml(r.state||'-')}</span></td><td>${escapeHtml(r.messageType||'-')}</td><td>${greetingBadge(r.greetingStatus)}<br><span class="small">${escapeHtml(r.lastAction||r.note||'-')}${r.recoverySource?`<br>Source: ${escapeHtml(r.recoverySource)}`:''}</span></td></tr>`).join('') || '<tr><td colspan="8" class="small">No support records yet.</td></tr>';
  $('supportTable').innerHTML=supportRows;
  updateDashboardStatus();
}
function shortId(id){ return id ? id.slice(0,8)+'...'+id.slice(-6) : '-'; }
function stateBadge(state){ const cls=state?.includes('ASSIGNED')?'assigned':state?.includes('JOINED')?'joined':state?.includes('ENDED')?'ended':'unknown'; return `<span class="badge ${cls}">${escapeHtml(state||'Unknown')}</span>`; }
function greetingBadge(s){ const cls=s==='Sent'?'sent':s==='Pending'||s==='Sending'?'pending':s==='Failed'?'fail':s==='Skipped'?'skip':'unknown'; return `<span class="badge ${cls}">${escapeHtml(s||'Pending')}</span>`; }
function copyRecord(id){ const r=conversations.get(id); if(!r)return; latestConversationId=r.conversationId; latestCommunicationId=r.communicationId||''; }
function addAdminEvent(eventName, rec, details){
  if(/SENT/i.test(eventName || '')) dashLastSent = `${eventName} | ${shortId(rec.conversationId)} | ${shortId(rec.communicationId)}`;
  if(/SKIP|DUPLICATE|ALREADY/i.test(String(eventName)+' '+String(details||''))) dashLastSkip = `${eventName} | ${shortId(rec.conversationId)}`;
  const row=`<tr><td>${now()}</td><td>${escapeHtml(eventName)}</td><td>${escapeHtml(rec.conversationId||'-')}<br><span class="small">comm: ${escapeHtml(rec.communicationId||'-')}<br>session: ${escapeHtml(shortId(rec.customerSessionId||'-'))}</span></td><td>${stateBadge(rec.state)}</td><td>${escapeHtml(details||rec.note||'-')}<br><span class="small">agent=${escapeHtml(rec.agentName||'-')} | msg=${escapeHtml(rec.messageType||'-')} | transfer=${rec.isTransferJoin?'Y':'N'} | supervisorRole=${rec.supervisorRole?'Y':'N'} | roles=${escapeHtml(rec.roleNames||'-')} | channel=${escapeHtml(rec.channel||'-')} | held=${rec.held?'Y':'N'}</span></td></tr>`;
  if($('adminTable').textContent.includes('No admin events yet')) $('adminTable').innerHTML=''; $('adminTable').insertAdjacentHTML('afterbegin',row);
  updateDashboardStatus();
}
function addAgentMsg(who,text,type='system'){ const box=$('agentMessages'); if(!box) return; box.insertAdjacentHTML('afterbegin',`<div class="bubble ${type}"><div class="who">${escapeHtml(who)}</div>${escapeHtml(text)}</div>`); }
function simulateAssigned(){ const conv='SIM-'+Math.random().toString(36).slice(2,8); const rec=upsertRecord(conv,{userId:currentUser?.id||'agent-id',name:currentUser?.name||'Demo Agent'},{id:'SIM-COMM-'+Math.random().toString(36).slice(2,6),type:'webmessaging'},{state:'ASSIGNED / ALERTING',note:'Simulated assigned event.'},{},{id:'SIM-CUSTOMER',attributes:{sessionID:'SIM-SESSION'}},[]); addAdminEvent('SIMULATED ASSIGNED',rec,'Simulated assigned event.'); refreshTables(); }
function simulateJoined(){ const conv='SIM-'+Math.random().toString(36).slice(2,8); const rec=upsertRecord(conv,{id:'SIM-AGENT-PART',userId:currentUser?.id||'agent-id',name:currentUser?.name||'Demo Agent',connectedTime:new Date().toISOString()},{id:'SIM-COMM-'+Math.random().toString(36).slice(2,6),type:'webmessaging',state:'connected',connectedTime:new Date().toISOString()},{state:'JOINED / CONNECTED',note:'Simulated joined event.'},{},{id:'SIM-CUSTOMER',attributes:{sessionID:'SIM-SESSION'}},[{purpose:'agent',userId:currentUser?.id||'agent-id',connectedTime:new Date().toISOString()}]); addAdminEvent('SIMULATED JOINED',rec,'Simulated joined event.'); refreshTables(); maybeAutoSendGreeting(rec); }
function clearAll(){ $('log').innerHTML=''; rawLogBuffer.length=0; $('adminTable').innerHTML='<tr><td colspan="5" class="small">No admin events yet.</td></tr>'; const box=$('agentMessages'); if(box){ box.innerHTML='<div class="bubble system"><div class="who">CSK System</div>Screen cleared.</div>'; } conversations.clear(); refreshTables(); }
init();
