/* Browser state is a view of durable server snapshots; no authority or secrets in URL/storage. */
const $ = id => document.getElementById(id);
let token = '', selected, snapshot, observer, lastSeq = 0, log = [], selectionVersion = 0, refreshVersion = 0, appliedRefresh = 0, listVersion = 0;
let policyDecision;
const runButtons = new Map();
const labels = { CREATED:'待开始', RUNNING:'执行中', PAUSING:'正在安全暂停', PAUSED_USER:'用户已暂停', PAUSED_BUDGET:'预算暂停', PAUSED_APPROVAL:'等待确认', PAUSED_ACCOUNTING:'等待用量核对', RECOVERY_REQUIRED:'需要恢复核对', CANCELLING:'正在确认取消', CANCELLED:'已取消', SUCCEEDED:'已完成并验证', COMPLETED_PARTIAL:'部分交付', FAILED:'失败' };
const stages = { normal:'正常', notice:'预算提醒', conserve:'节约', focus:'聚焦', finalize:'收尾' };
const policyReasons = {
  CANCELLED: '任务已取消',
  PERMISSION_DENIED: '操作超出授权范围',
  DEADLINE_EXCEEDED: '任务已超过截止时间',
  USAGE_UNKNOWN: '存在待核对的用量',
  GLOBAL_BUDGET_UNAVAILABLE: '总预算不足以执行请求',
  WORK_BUDGET_UNAVAILABLE: '工作预算不足以执行请求',
  FINALIZE_BUDGET_UNAVAILABLE: '收尾预算不足以执行请求',
  WAIT_INFLIGHT: '等待在途调用结算后重新评估预算',
  MODEL_CONCURRENCY_LIMIT: '模型调用达到并发限制',
  BUDGET_PRESSURE: '预算使用达到策略阈值',
  OPTIONAL_WORK_BLOCKED: '优先完成必需工作',
  NEW_AGENT_BLOCKED: '当前阶段限制创建新 Agent',
  FINALIZE_ONLY: '当前阶段仅进行收尾工作',
  FINALIZE_INTENT_REQUIRED: '收尾预算需要授权的最终报告意图及收尾阶段',
  REQUIRED_WORK_COMPLETE: '必需工作已完成',
  OUTPUT_CAP_REDUCED: '建议缩减输出长度',
};
function error(err) { $('error').textContent = err.message || String(err); $('error').hidden = false; setTimeout(() => $('error').hidden = true, 8000); }
async function api(path, value, method = value === undefined ? 'GET' : 'POST') {
  const response = await fetch(path, { method, headers: { Authorization:`Bearer ${token}`, ...(value === undefined ? {} : {'Content-Type':'application/json'}) }, ...(value === undefined ? {} : { body:JSON.stringify(value) }) });
  if (!response.ok) { const info = await response.json(); throw new Error(`${info.code}: ${info.message || '操作未完成'}`); }
  return response.json();
}
async function list() {
  const version = ++listVersion; const runs = await api('/runs'); if (version !== listVersion) return runs; $('runs').replaceChildren(); runButtons.clear();
  for (const record of runs.reverse()) {
    const run = snapshot?.runId === record.runId && snapshot.revision >= record.revision ? snapshot : record;
    const button = document.createElement('button'); button.textContent = `${labels[run.status] || run.status} · ${run.task.slice(0,40)}`; button.dataset.revision = String(run.revision);
    button.onclick = () => select(run.runId).catch(error); runButtons.set(run.runId, button); $('runs').append(button);
  }
  return runs;
}
function render(run) {
  snapshot = run; $('empty').hidden = true; $('detail').hidden = false;
  const button = runButtons.get(run.runId);
  if (button && Number(button.dataset.revision) <= run.revision) { button.textContent = `${labels[run.status] || run.status} · ${run.task.slice(0,40)}`; button.dataset.revision = String(run.revision); }
  $('status').textContent = labels[run.status] || run.status; $('task-title').textContent = run.task; $('run-id').textContent = run.runId;
  for (const [element,key] of [['used','usedTokens'],['reserved','reservedTokens'],['available','availableTokens']]) $(element).textContent = run.budget[key].toLocaleString();
  $('budget-bar').value = run.budget.limitTokens ? (run.budget.usedTokens + run.budget.reservedTokens) / run.budget.limitTokens : 0;
  $('stage').textContent = stages[run.policy?.stage] || run.policy?.stage || '正常'; $('metering').textContent = run.budget.meteringComplete ? '用量已核对' : '存在未知用量';
  renderPolicy(run);
  $('pause').disabled = run.status !== 'RUNNING';
  $('resume').disabled = !['PAUSED_USER','PAUSED_BUDGET','PAUSED_ACCOUNTING','RECOVERY_REQUIRED'].includes(run.status);
  $('cancel').disabled = ['SUCCEEDED','COMPLETED_PARTIAL','FAILED','CANCELLED','CANCELLING'].includes(run.status);
  $('outcome').textContent = run.outcome || ''; $('steps').replaceChildren();
  for (const step of run.steps) { const li = document.createElement('li'); li.textContent = `${step.kind} · ${step.status} · ${step.stepId}`; $('steps').append(li); }
  $('artifacts').replaceChildren();
  for (const artifact of run.artifacts) { const button = document.createElement('button'); button.className = 'secondary'; button.textContent = `${artifact.path} · ${artifact.size} B`; button.onclick = async () => {
    try { const response = await fetch(`/runs/${run.runId}/artifacts/${artifact.artifactId}`, {headers:{Authorization:`Bearer ${token}`}}); if (!response.ok) throw new Error('产物读取失败'); const url = URL.createObjectURL(await response.blob()); const a = document.createElement('a'); a.href = url; a.download = artifact.path.split('/').pop(); a.click(); setTimeout(() => URL.revokeObjectURL(url),1000); } catch(err) { error(err); }
  }; $('artifacts').append(button); }
  if (!run.artifacts.length) $('artifacts').textContent = '暂无已提交产物。';
  $('approvals').replaceChildren();
  for (const approval of run.approvals || []) { const div = document.createElement('div'); const p = document.createElement('p'); p.textContent = `${approval.reason} · ${approval.status}`; div.append(p);
    if (approval.status === 'pending') for (const [text,approved] of [['批准一次',true],['拒绝',false]]) { const b = document.createElement('button'); b.textContent = text; b.onclick = async () => { b.disabled = true; try { await api(`/runs/${run.runId}/approvals/${approval.approvalId}`, {decisionId:crypto.randomUUID(),approved}); if (selected === run.runId) await refresh(); } catch(err){error(err);} }; div.append(b); }
    $('approvals').append(div);
  }
  if (!(run.approvals || []).length) $('approvals').textContent = '当前无需确认。';
}
function renderPolicy(run) {
  const current = policyDecision?.stage === run.policy?.stage ? policyDecision : undefined;
  $('policy-mode').textContent = current?.mode === 'observe' ? '观察模式：软限制为建议' : current?.mode === 'enforce' ? '执行模式：软限制已启用' : '策略模式以运行时记录为准';
  $('policy-reasons').replaceChildren();
  for (const reason of current?.reasons || []) { const li = document.createElement('li'); const description = Object.hasOwn(policyReasons, reason.code) ? policyReasons[reason.code] : undefined; li.textContent = `${reason.hard ? '硬限制' : '软限制'} · ${reason.code}${description ? `：${description}` : ''}`; $('policy-reasons').append(li); }
  if (!current?.reasons?.length) $('policy-reasons').textContent = run.policy?.lastOperatorReason || '暂无近期限制原因；详细历史可查看运行时 trace。';
}
async function refresh(id = selected, version = selectionVersion) {
  if (!id) return;
  const requestVersion = ++refreshVersion; const run = await api(`/runs/${id}`);
  if (selected !== id || version !== selectionVersion || requestVersion < appliedRefresh || (snapshot?.runId === id && run.revision < snapshot.revision)) return;
  appliedRefresh = requestVersion; render(run); return run;
}
async function select(id) {
  observer?.abort(); const version = ++selectionVersion; const controller = new AbortController(); observer = controller;
  selected = id; snapshot = undefined; policyDecision = undefined; lastSeq = 0; log = []; $('events').textContent = ''; $('detail').hidden = true; $('empty').hidden = false; $('empty').textContent = '正在读取任务…';
  const run = await refresh(id, version); if (!run || controller.signal.aborted || version !== selectionVersion) return;
  // A small durable lookback restores recent logs/reasons without replaying all history.
  lastSeq = Math.max(0, run.lastEventSeq - 150); void observe(id, controller.signal, version);
}
async function observe(id, signal, version) {
  const current = () => !signal.aborted && selected === id && version === selectionVersion;
  while (current()) {
    let reader;
    try {
      const response = await fetch(`/runs/${id}/events`, {headers:{Authorization:`Bearer ${token}`,'Last-Event-ID':String(lastSeq)},signal});
      if (!current()) { await response.body?.cancel(); return; }
      if (response.status === 409) { const run = await refresh(id, version); if (run) lastSeq = run.lastEventSeq; log = []; await response.body?.cancel(); continue; }
      if (!response.ok) throw new Error(`事件连接失败 ${response.status}`);
      $('connection').textContent = '实时连接'; reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = '';
      while (current()) { const chunk = await reader.read(); if(chunk.done) break; if (!current()) { await reader.cancel(); return; } buffer += decoder.decode(chunk.value,{stream:true}); let end; let changed = false;
        while ((end = buffer.indexOf('\n\n')) >= 0) { const frame = buffer.slice(0,end); buffer = buffer.slice(end+2); const data = frame.split('\n').find(line => line.startsWith('data: ')); if (!data) continue;
          const event = JSON.parse(data.slice(6));
          if (event.runId !== id || !Number.isSafeInteger(event.eventSeq)) throw new Error('事件身份无效');
          if(event.eventSeq <= lastSeq) continue; lastSeq = event.eventSeq;
          log.push(`${new Date(event.timestamp).toLocaleTimeString()} ${event.type}\n${JSON.stringify(event.payload).slice(0,8000)}`); log = log.slice(-150); changed = true;
          if (event.type === 'policy.decision') policyDecision = event.payload;
        }
        if (changed && current()) { $('events').textContent = log.join('\n\n'); await refresh(id, version); }
      }
      if (current()) $('connection').textContent = '连接已结束，正在重连';
    } catch(err) { if(!current()) return; $('connection').textContent = '断线，正在重连'; }
    finally { await reader?.cancel().catch(() => {}); }
    if (current()) { await new Promise(resolve => setTimeout(resolve,1000)); if (current()) await refresh(id, version).catch(error); }
  }
}
$('login-form').onsubmit = async e => { e.preventDefault(); token = $('token').value.trim(); try { const runs = await list(); $('token').value = ''; $('login').hidden = true; $('workspace').hidden = false; $('connection').textContent = '已连接'; if(runs.length) await select(runs[0].runId); } catch(err){error(err);} };
$('create-form').onsubmit = async e => { e.preventDefault(); try { const run = await api('/tasks',{task:$('task').value}); await list(); await select(run.runId); } catch(err){error(err);} };
$('refresh').onclick = () => list().then(() => refresh()).catch(error);
$('pause').onclick = async () => { try { await api(`/runs/${selected}/pause`, { commandId: crypto.randomUUID(), reason: '用户从任务台暂停' }); await refresh(); } catch(err) { error(err); } };
$('cancel').onclick = async () => { try { await api(`/runs/${selected}/cancel`,{commandId:crypto.randomUUID(),reason:'用户从任务台取消'}); await refresh(); } catch(err){error(err);} };
$('resume').onclick = async () => { try { await api(`/runs/${selected}/resume`,{commandId:crypto.randomUUID(),expectedRevision:snapshot.revision}); await refresh(); } catch(err){error(err);} };
