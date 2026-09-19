const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const icons = {
  flask:'M9 3h6M10 3v6l-5.5 9A2 2 0 0 0 6.2 21h11.6a2 2 0 0 0 1.7-3L14 9V3M8 14h8',
  layers:'m12 3 10 5-10 5L2 8l10-5ZM2 12l10 5 10-5M2 16l10 5 10-5',
  network:'M12 8v4M5 16v-4h14v4M9 3h6v5H9V3ZM2 16h6v5H2v-5Zm14 0h6v5h-6v-5Z',
  sliders:'M4 3v7m0 4v7M12 3v12m0 4v2M20 3v2m0 4v12M1 10h6M9 15h6M17 5h6',
  sparkles:'m12 3 2.6 6.4L21 12l-6.4 2.6L12 21l-2.6-6.4L3 12l6.4-2.6L12 3ZM20 2v4M18 4h4',
  plus:'M12 5v14M5 12h14',
  bolt:'m13 2-9 12h7l-1 8 10-13h-8l1-7Z',
  help:'M9.1 9a3 3 0 0 1 5.8 1c0 2-3 2-3 4m.1 3h.01M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0Z',
  fingerprint:'M8 10a4 4 0 0 1 8 0c0 5-1 8-3 11M5 10a7 7 0 0 1 14 0c0 3-.2 5-1 8M2 10a10 10 0 0 1 20 0M12 10c0 5-1 7-4 10M8 13c-.5 2-1 3-3 5',
  download:'M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5',
};
const icon = name => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${icons[name] || icons.sparkles}"/></svg>`;
$$('[data-icon]').forEach(node => node.innerHTML = icon(node.dataset.icon));

const emotions = ['joy','trust','curiosity','desire'];
const colors = ['#d8b484','#9eb68e','#b6a2ca','#d0a895'];
const defaultWeights = [30,20,35,15];
$('#emotion-controls').innerHTML = emotions.map((name,i) => `<div class="emotion-row" style="--emotion:${colors[i]}"><label for="weight-${name}"><i></i>${name[0].toUpperCase()+name.slice(1)}</label><input type="range" id="weight-${name}" name="weight-${name}" min="0" max="100" value="${defaultWeights[i]}" aria-label="${name} priority"><output for="weight-${name}">${defaultWeights[i]}</output></div>`).join('');
$$('.emotion-row input').forEach(input => input.addEventListener('input', () => input.nextElementSibling.value = input.value));

let config = {}, currentRun = null, savedRuns = [], currentView = 'candidates', selectedRound = 'latest';
let originalMedia = null, uploading = false;
let pollTimer = null, fetchSequence = 0, submitting = false;
const running = () => currentRun?.status === 'running';
const number = value => Number.isFinite(Number(value)) ? Number(value) : 0;
const score = value => value == null ? '—' : number(value).toFixed(1);
const duration = ms => ms < 60000 ? `${(number(ms)/1000).toFixed(ms < 10000 ? 1 : 0)}s` : `${Math.floor(ms/60000)}m ${Math.floor(ms%60000/1000)}s`;
const titleCase = text => String(text).replace(/^./, c => c.toUpperCase());
const safeLink = value => { try { const u = new URL(value); return ['http:','https:'].includes(u.protocol) ? u.href : ''; } catch { return ''; } };
const assetLink = value => typeof value === 'string' && /^\/assets\/[a-f0-9]{64}\.(png|svg|webp|jpg|mp4)$/.test(value) ? value : '';
const allCandidates = () => currentRun?.rounds?.flatMap(round => round.candidates || []) || [];
const isPerceptRun = () => currentRun?.neuralConfig?.version?.startsWith('percept-') || allCandidates().some(c=>c.scores?.source==='tribe-percept');
const selectionScore = c => c.scores?.neural?.engagementScore ?? c.scores?.fitness;
const provenanceLabel = c => c.scores?.source==='tribe-percept'?'Percept overall score':c.scores?.review?'Media review only':'Historical score';
const mediaLabel = kind => ({'ai-generated-video':'Generated video','ai-generated-image':'Generated image','uploaded-media':'Uploaded original'}[kind]||kind||'Draft');
const mediaPreview = (asset, title, controls=true) => assetLink(asset?.url) ? asset.url.endsWith('.mp4') ? `<video src="${escapeHtml(asset.url)}" ${controls?'controls':''} playsinline preload="metadata" aria-label="${escapeHtml(title)}"></video>` : `<img src="${escapeHtml(asset.url)}" alt="${escapeHtml(title)}" loading="lazy">` : '';

async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { ...(options.body ? {'content-type':'application/json'} : {}), ...options.headers }, signal: AbortSignal.timeout(15000) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status}).`);
  return data;
}
let toastTimer;
function toast(message) { $('#toast').textContent = message; $('#toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => $('#toast').hidden = true, 5500); }
function errorMessage(error) { return error.name === 'TimeoutError' ? 'The local server did not respond. Check that npm start is running.' : error.message; }
function updateBudget() {
  const rounds=+$('#rounds').value, population=+$('#population').value;
  $('#shortlist').max=population;
  if (+$('#shortlist').value>population) $('#shortlist').value=population;
  const k=+$('#shortlist').value, type=$('#mediaType').value;
  $('#budget-note').textContent=`Up to ${rounds*population} ${type} drafts; ${rounds*k} shortlist slots${originalMedia?' plus one original baseline evaluation':''}. Cached media reuses work.`;
}
['rounds','population','shortlist'].forEach(id=>$('#'+id).addEventListener('input',updateBudget));
function updateModes() {
  const video=$('#mediaType').value==='video';
  $('#video-settings').hidden=!video;
  $('#original-file').accept=video?'video/mp4':'image/png,image/jpeg,image/webp';
  $('#mode-note').textContent=video?'Seedance/Pika generates video; OpenAI researches and reviews; TRIBE scores. Paid API calls.':'OpenAI generates and reviews images; TRIBE scores a 10-second still presentation. Paid API calls.';
  $('#mode-badge').innerHTML=`<i></i> ${video?'Video evolution':'Image evolution'}`;
  updateBudget();
}
function showOriginal() {
  $('#original-preview').innerHTML=originalMedia?mediaPreview(originalMedia.asset,'Original creative')+'<p class="field-hint">Original uploaded and saved.</p>':'';
  $('#clear-original').hidden=!originalMedia;
  updateBudget();
}
$('#mediaType').addEventListener('change',()=>{if(originalMedia && originalMedia.asset.mediaType!==$('#mediaType').value){originalMedia=null;$('#original-file').value='';showOriginal();}updateModes();});
$('#clear-original').addEventListener('click',()=>{originalMedia=null;$('#original-file').value='';showOriginal();});
$('#original-file').addEventListener('change',async()=>{
  const file=$('#original-file').files[0]; if(!file) return;
  if(file.size>50*1024*1024){toast('Use media no larger than 50 MiB.');return;}
  uploading=true; $('#start-run').disabled=true;
  $('#original-preview').innerHTML='<p>Uploading and checking media…</p>';
  try {
    const response=await fetch('/api/media',{method:'POST',headers:{'content-type':file.type},body:file,signal:AbortSignal.timeout(180000)});
    const result=await response.json(); if(!response.ok) throw new Error(result.error);
    if(result.asset.mediaType!==$('#mediaType').value) throw new Error('Upload media matching the selected ad format.');
    originalMedia=result; showOriginal();
  } catch(error) {showOriginal();toast(errorMessage(error));}
  finally {uploading=false;$('#start-run').disabled=running();}
});

function readBrief() {
  return Object.fromEntries([...new FormData($('#brief-form'))].map(([key,value]) => [key,['rounds','population','shortlist','seed','videoDuration'].includes(key)?Number(value):value]).filter(([key]) => !key.startsWith('weight-')).concat([['originalMediaId',originalMedia?.id||null],['weights',Object.fromEntries(emotions.map(key => [key,+$('#weight-'+key).value]))]]));
}
function fillBrief(brief) {
  for (const [key,value] of Object.entries(brief || {})) {
    if (key === 'weights') { for (const emotion of emotions) { $('#weight-'+emotion).value = value[emotion]; $('#weight-'+emotion).nextElementSibling.value = value[emotion]; } }
    else if ($('#brief-form').elements.namedItem(key)) $('#brief-form').elements.namedItem(key).value = value;
  }
  originalMedia=brief?.originalAsset?{id:brief.originalMediaId,asset:brief.originalAsset}:null;showOriginal();
  updateBudget(); updateModes();
}
function lockForm(locked) {
  $$('#brief-form input, #brief-form textarea, #brief-form select, #start-run, #clear-original').forEach(node => node.disabled = locked);
  $('#start-run').innerHTML = locked ? `${icon('sparkles')}<span>Evolution in progress</span><span>↗</span>` : `${icon('sparkles')}<span>Start evolution</span><span>↗</span>`;
  if (!locked) updateModes();
}
$('#brief-form').addEventListener('submit', async event => {
  event.preventDefault(); if (submitting || running() || uploading) return;
  const brief = readBrief(); $('#form-error').hidden = true;
  if (!Object.values(brief.weights).some(Boolean)) { $('#form-error').textContent = 'Choose at least one emotional priority above zero.'; $('#form-error').hidden = false; return; }
  submitting = true; lockForm(true);
  try {
    const run = await api('/api/runs', { method:'POST', body:JSON.stringify(brief) });
    clearTimeout(pollTimer); fetchSequence++;
    currentRun = run; currentView = 'candidates'; selectedRound = 'latest';
    history.replaceState(null,'',`/#run=${run.id}`); renderRun(); schedulePoll(); refreshRuns();
    if (matchMedia('(max-width:710px)').matches) $('#run-workspace').scrollIntoView({behavior:'smooth',block:'start'});
  } catch(error) { $('#form-error').textContent = errorMessage(error); $('#form-error').hidden = false; lockForm(false); }
  finally { submitting = false; }
});
function schedulePoll() { clearTimeout(pollTimer); if (running()) pollTimer = setTimeout(pollRun,700); }
async function pollRun() {
  if (!currentRun) return;
  const id = currentRun.id, sequence = fetchSequence;
  try {
    const run = await api(`/api/runs/${id}`);
    if (sequence !== fetchSequence || currentRun?.id !== id) return;
    currentRun = run; renderRun(); if (!running()) refreshRuns();
  } catch(error) { if (sequence === fetchSequence) toast(errorMessage(error)); }
  schedulePoll();
}
async function openRun(id) {
  clearTimeout(pollTimer); const sequence = ++fetchSequence;
  try {
    const run = await api(`/api/runs/${encodeURIComponent(id)}`);
    if (sequence !== fetchSequence) return;
    currentRun = run; selectedRound = 'latest'; currentView = 'candidates'; fillBrief(run.brief);
    history.replaceState(null,'',`/#run=${run.id}`); renderRun(); schedulePoll();
    $('#info-dialog').close();
  } catch(error) { toast(errorMessage(error)); }
}
function newExperiment() {
  clearTimeout(pollTimer); fetchSequence++; currentRun = null; selectedRound = 'latest'; originalMedia=null;$('#original-file').value='';showOriginal();
  history.replaceState(null,'','/'); $('#empty-state').hidden = false; $('#run-workspace').hidden = true;
  lockForm(false); $('#form-error').hidden = true; $('#product').focus();
}
$('#new-run').addEventListener('click',newExperiment); $('#nav-lab').addEventListener('click', () => window.scrollTo({top:0,behavior:'smooth'}));
$('#cancel-run').addEventListener('click',async () => {
  if (!running()) return; $('#cancel-run').disabled = true;
  try { await api(`/api/runs/${currentRun.id}/cancel`,{method:'POST'}); await pollRun(); }
  catch(error) { toast(errorMessage(error)); }
  finally { $('#cancel-run').disabled = false; }
});
async function refreshRuns() {
  try {
    savedRuns = await api('/api/runs'); $('#run-count').textContent = savedRuns.length;
    if (savedRuns.length) $('#recent-runs').innerHTML = savedRuns.slice(0,5).map(run => `<button class="recent-run" data-run="${escapeHtml(run.id)}" title="${escapeHtml(run.product)} · ${escapeHtml(run.status)}">${escapeHtml(run.product)}</button>`).join('');
  } catch(error) { toast(errorMessage(error)); }
}
$('#recent-runs').addEventListener('click',event => { const button = event.target.closest('[data-run]'); if(button) openRun(button.dataset.run); });
const stageText = {queued:'Your experiment is queued.',research:'Finding the context behind your product…',generating:'Creating and recombining creative genomes…',screening:'Screening the population against your priorities…',rendering:'Rendering creative drafts for review…',scoring:'Scoring shortlisted takes against the original creative…',evolving:'Selecting parents and preserving useful variation…',finalizing:'Preparing your strongest distinct drafts…',complete:'Your final drafts are ready to explore.',cancelled:'Stopped. Completed work is saved.',failed:'The run stopped with an error. Details are below.'};
function renderRun() {
  if(!currentRun) return;
  const run=currentRun, completed=run.status==='completed';
  $('#empty-state').hidden = true; $('#run-workspace').hidden = false; lockForm(running());
  $('#run-label').textContent = `EXPERIMENT ${run.id.slice(0,8).toUpperCase()} · ${run.brief.mode.toUpperCase()}`;
  $('#run-title').textContent = `${run.brief.product} / ${completed?'The next generation':'Creative exploration'}`;
  $('#run-stage').textContent = stageText[run.stage] || titleCase(run.stage);
  $('#run-state').textContent = run.requiresReview ? `${run.status} · needs review` : run.status;
  $('#cancel-run').hidden = !running(); $('#export-run').hidden = running(); $('#export-run').href = `/api/runs/${run.id}/export`;
  const metrics=run.metrics || {};
  $('#metric-generated').textContent = metrics.generated || 0; $('#metric-rendered').textContent = metrics.rendered || 0;
  $('#metric-cache').textContent = metrics.cacheHits || 0; $('#metric-time').textContent = duration(metrics.elapsedMs);
  $('#progress-fill').style.width = completed?'100%':`${Math.min(96,5+(run.rounds.length/run.brief.rounds)*85)}%`;
  $('#score-disclosure').innerHTML=icon('help')+(isPerceptRun()?'Percept overall score / 100: four equally weighted Glasser families, normalized against one original creative. Highest neural score wins among reviewed takes. If all fail review, provisional takes remain visible. Predicted cortical response, not validated emotion or ad effectiveness.':'Historical run: recorded scores use an earlier method. They are not Percept scores.');
  $$('.result-tabs button').forEach(button => { const active=button.dataset.view===currentView; button.classList.toggle('active',active); button.setAttribute('aria-selected',String(active)); });
  const content=$('#result-content');
  const html = (run.error?`<div class="error-note" role="alert">${escapeHtml(run.error)}</div>`:'') + ({candidates:renderCandidates,lineage:renderLineage,research:renderResearch,log:renderLog}[currentView])();
  if (content.renderedHtml !== html) {
    const videos = new Map([...content.querySelectorAll('article[data-creative-id] video')].map(video => [video.closest('article').dataset.creativeId, { video, playing: !video.paused }]));
    const template = document.createElement('template'); template.innerHTML = html;
    for (const next of template.content.querySelectorAll('article[data-creative-id] video')) {
      const saved = videos.get(next.closest('article').dataset.creativeId);
      if (saved && saved.video.getAttribute('src') === next.getAttribute('src')) next.replaceWith(saved.video);
    }
    content.replaceChildren(template.content); content.renderedHtml = html;
    for (const { video, playing } of videos.values()) if (playing && video.isConnected) video.play().catch(() => {});
  }
}
$$('.result-tabs button').forEach(button => button.addEventListener('click',() => { currentView=button.dataset.view;renderRun(); }));
$$('.result-tabs button').forEach((button,i,buttons) => button.addEventListener('keydown',event => { if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return; event.preventDefault(); const next=event.key==='Home'?0:event.key==='End'?buttons.length-1:(i+(event.key==='ArrowRight'?1:-1)+buttons.length)%buttons.length; buttons[next].focus(); buttons[next].click(); }));
function waiting(title,detail) { return `<div class="waiting-panel">${running()?'<span class="spinner"></span>':icon('layers')}<h3>${escapeHtml(title)}</h3><p>${escapeHtml(detail)}</p></div>`; }
function compareCards(a,b) {
  const tier=c=>c.scores?.eligible && c.scores?.neural?2:c.provisional?1:0;
  return tier(b)-tier(a)||number(selectionScore(b))-number(selectionScore(a));
}
function scoreBreakdown(candidate) {
  const s=candidate.scores,n=s?.neural;
  const row=(label,value)=>`<div class="score-row"><span>${escapeHtml(label)}</span><div class="score-track"><i style="width:${Math.min(100,Math.max(0,number(value)))}%"></i></div><b>${score(value)}</b></div>`;
  let html=s?.review?`<h3>Media review</h3>${row('Quality',s.quality)}${row('Brief alignment',s.briefAlignment)}<p>${s.eligible?'Passed automated checks.':candidate.provisional?'Provisional: needs review.':'Review checks failed.'}</p><p class="detail-meta">${escapeHtml(s.review.evidenceScope||'Image review')}</p><ul>${Object.entries(s.review.checks).map(([k,v])=>`<li>${escapeHtml(k.replace(/[A-Z]/g,c=>' '+c.toLowerCase()))}: ${v?'pass':'fail'}</li>`).join('')}</ul><p>${s.review.reasons.map(escapeHtml).join(' · ')}</p><details><summary>Observed copy and transcript</summary><p>${escapeHtml(s.review.observedText)}</p><p>${escapeHtml(s.review.transcript||'No audio transcript.')}</p></details>`:'';
  if(n?.source==='tribe-percept') {
    const original=allCandidates().find(c=>c.id===currentRun.neuralBaseline?.candidateId);
    html+=`<h3>Percept overall · ${score(n.engagementScore)} / 100</h3><p>Original: ${escapeHtml(original?.headline||'first shortlisted creative')}. Every take uses this same baseline.</p>`;
    html+=n.regions.map(r=>row(r.name,r.score)+`<svg class="neural-trace" viewBox="0 0 240 60" role="img" aria-label="${escapeHtml(r.name)} over time"><path d="M0 30H240" stroke="#ddd" fill="none"/><polyline fill="none" stroke="${escapeHtml(r.color||'#315c51')}" stroke-width="2" points="${r.values.map((v,i)=>`${240*i/Math.max(1,r.values.length-1)},${60-number(v)*0.6}`).join(' ')}"/></svg>`).join('');
    html+=`<p class="detail-meta">50 = original mean activity. These are cortical proxies; reliability labels are not used as weights. ${escapeHtml(n.provenance)}</p>`;
  } else if(n) html+='<p>Archived scoring method. Original values remain in the JSON export.</p>';
  else html+='<p>No neural score yet.</p>';
  return html;
}
function renderCandidates() {
  const run=currentRun, rounds=run.rounds||[], hasFinalists=run.finalists?.length>0;
  if(!rounds.length) return waiting('The first generation starts here.', 'Your research and creative genomes will appear as the run progresses.');
  const choice=selectedRound==='latest'?(hasFinalists?'final':rounds.at(-1).number):selectedRound;
  const round=rounds.find(r=>String(r.number)===String(choice)) || rounds.at(-1);
  const candidates=choice==='final'?run.finalists:[...(round.candidates||[])].sort(compareCards);
  const toolbar=`<div class="round-toolbar"><div class="round-buttons">${hasFinalists?`<button data-round="final" class="${choice==='final'?'active':''}">${run.requiresReview?'Provisional drafts':'Finalists'} ✳</button>`:''}${rounds.map(r=>`<button data-round="${r.number}" class="${String(choice)===String(r.number)?'active':''}">Gen ${r.number}</button>`).join('')}</div><span class="sort-note">${choice==='final'?(run.requiresReview?'Provisional drafts · need review':'Selected final drafts'):(isPerceptRun()?'Reviewed takes, ranked by Percept score':'Historical run')}</span></div>`;
  return toolbar+`<div class="creative-grid">${candidates.map((c,i)=>creativeCard(c,i,choice==='final')).join('')}</div>`+(choice==='final'?`<div class="results-summary"><strong>${candidates.length} ${run.requiresReview?'provisional drafts needing review and revision':'drafts, ready for your judgment'}.</strong> Inspect a creative to see its genome, inherited strengths and score breakdown. Take the strongest candidates into a human preference test.</div>`:'')+renderChart();
}
function creativeCard(candidate,index,final) {
  return `<article class="creative-card" data-creative-id="${escapeHtml(candidate.id)}"><div class="creative-image">${mediaPreview(candidate.asset,candidate.headline)||'<div class="unrendered">Awaiting media</div>'}<span class="creative-rank">${candidate.provisional?'PROVISIONAL · NEEDS REVIEW':candidate.original?'ORIGINAL':final?`FINALIST 0${index+1}`:candidate.selected?'SELECTED PARENT':`CONCEPT ${index+1}`}</span></div><button class="creative-card-body" data-candidate="${escapeHtml(candidate.id)}"><div class="creative-card-title">${escapeHtml(candidate.headline)}</div><div class="creative-card-info"><span class="fitness">${score(selectionScore(candidate))}<small> / 100</small></span><span class="generation-badge">${provenanceLabel(candidate)}</span></div><p class="field-hint">${escapeHtml(mediaLabel(candidate.asset?.kind))} · ${candidate.scores?.neural?'Neural score':candidate.scores?.review?'Review only':'Awaiting evaluation'}</p><div class="gene-tags"><span>${escapeHtml(candidate.genome.emotion)}</span><span>${escapeHtml(candidate.genome.palette)}</span></div></button></article>`;
}
function renderChart() {
  const rounds=currentRun.rounds.filter(r=>r.candidates?.some(c=>c.scores));
  if(rounds.length<2) return '';
  return `<div class="chart-panel"><h3>How the population is changing</h3><p>${isPerceptRun()?'Percept overall scores against one shared original creative.':'Recorded scores from a historical run.'} Higher scores are not evidence of better ad outcomes.</p><div class="chart">${rounds.map(r=>`<div class="chart-group"><div class="chart-bar mean" style="height:${Math.min(100,Math.max(0,number(r.mean)))}%" title="Generation ${r.number} mean ${score(r.mean)}"></div><div class="chart-bar" style="height:${Math.min(100,Math.max(0,number(r.best)))}%" title="Generation ${r.number} best ${score(r.best)}"><span>${score(r.best)}</span></div></div>`).join('')}</div><div class="chart-labels">${rounds.map(r=>`<span>Gen ${r.number}</span>`).join('')}</div><div class="chart-legend"><span><i></i>Selected draft score</span><span><i></i>Ranked population mean</span></div></div>`;
}
function renderLineage() {
  if(!currentRun.rounds.length) return waiting('A family tree, in the making.', 'Selected parents and inherited genes will appear after the first generation.');
  const names=new Map(allCandidates().map(c=>[c.id,`Gen ${c.round} / ${c.id.split('-').at(-1)}`]));
  return `<div class="lineage-panel"><h3>Follow the creative DNA</h3><p>Each child combines parent genes, then changes a specific trait. Elites carry forward unchanged. Click a node to inspect its full genome.</p>${currentRun.rounds.map(r=>`<section class="lineage-round"><strong>GENERATION ${r.number}</strong>${r.candidates.map(c=>`<button class="lineage-node" data-candidate="${escapeHtml(c.id)}"><div><span>${c.selected?'✳ ':''}${escapeHtml(c.headline)}</span><b>${score(selectionScore(c))}</b></div><small>${escapeHtml(c.mutation)} · ${provenanceLabel(c)}</small><small class="parent-list">${c.parents.length?'↳ Inherits from '+c.parents.map(id=>escapeHtml(names.get(id)||id)).join(' + '):'Original genome · no parents'}</small></button>`).join('')}</section>`).join('')}</div>`;
}
function renderResearch() {
  const research=currentRun.research;
  if(!research) return waiting('Finding a starting point.', 'Research runs once, then informs every generation in this experiment.');
  return `<div class="research-panel"><h3>Research behind the creative</h3><p>${escapeHtml(research.summary)}</p>${(research.insights||[]).map((insight,i)=>`<article class="research-insight"><span>0${i+1}</span><div><h4>${escapeHtml(insight.title)} ${insight.kind?`<span class="tiny-badge">${escapeHtml(insight.kind)}</span>`:''}</h4><p>${escapeHtml(insight.detail)}</p>${(insight.sourceUrls||[]).filter(safeLink).map(url=>`<div class="source-list"><a href="${escapeHtml(safeLink(url))}" target="_blank" rel="noopener noreferrer">Supporting source ↗</a></div>`).join('')}</div></article>`).join('')}<div class="source-list"><h4>${research.sources?.length?'RESEARCH SOURCES':'NO EXTERNAL SOURCES RECORDED'}</h4>${(research.sources||[]).filter(source=>safeLink(source.url)).map(source=>`<a href="${escapeHtml(safeLink(source.url))}" target="_blank" rel="noopener noreferrer">${escapeHtml(source.title)} ↗</a>`).join('')}</div><p class="provenance">${escapeHtml(research.provenance)}</p></div>`;
}
function renderLog() {
  return `<div class="log-panel">${(currentRun.events||[]).map(event=>`<div class="log-event"><time>${escapeHtml(new Date(event.time).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit'}))}</time><p>${escapeHtml(event.message)}</p></div>`).join('')||'<p class="field-hint">Waiting for the first event…</p>'}</div>`;
}
$('#result-content').addEventListener('click',event=>{
  const round=event.target.closest('[data-round]'); if(round){selectedRound=round.dataset.round;renderRun();return;}
  const card=event.target.closest('[data-candidate]'); if(card) showCandidate(card.dataset.candidate);
});
function showCandidate(id) {
  const candidate=allCandidates().find(c=>c.id===id) || currentRun.finalists.find(c=>c.id===id); if(!candidate)return;
  const asset=assetLink(candidate.asset?.url);
  $('#detail-body').innerHTML=`<div class="detail-layout"><div class="detail-image">${asset?`${mediaPreview(candidate.asset,candidate.headline)}<a class="button secondary" href="${escapeHtml(asset)}" download="${escapeHtml(currentRun.brief.product.replace(/[^a-z0-9]/gi,'-'))}-${candidate.id}.${asset.split('.').at(-1)}">${icon('download')} Download draft</a>`:'<div class="waiting-panel">No media is available for this concept.</div>'}<p class="field-hint">${asset?(candidate.scores?.neural?'TRIBE evaluated this media using the scoring method shown below.':candidate.scores?.review?'Automated media review is available below.':'No media evaluation has been recorded.'):''}</p></div><div class="detail-info"><h2>${escapeHtml(candidate.headline)}</h2><p>${escapeHtml(candidate.body)}</p><span class="tiny-badge">CTA / ${escapeHtml(candidate.cta)}</span><h3>Creative genome</h3><dl class="genome-list">${Object.entries(candidate.genome).map(([key,value])=>`<dt>${escapeHtml(key)}</dt><dd>${escapeHtml(value)}</dd>`).join('')}</dl><h3>${provenanceLabel(candidate)} · ${score(selectionScore(candidate))} / 100</h3>${scoreBreakdown(candidate)}<p class="detail-meta">${escapeHtml(candidate.scores?.provenance)}${candidate.scores?.confidence==null?' · Uncertainty not estimated.':''}</p><h3>Where this came from</h3><p class="detail-meta">Generation ${candidate.round} · ${escapeHtml(candidate.mutation)}<br>${candidate.parents.length?'Parents: '+candidate.parents.map(escapeHtml).join(', '):'Initial population'}</p><details class="advanced"><summary>Render prompt <span>+</span></summary><p class="detail-meta">${escapeHtml(candidate.asset?.prompt||'No render prompt yet.')}</p></details></div></div>`;
  $('#detail-dialog').showModal();
}
$$('.close-dialog').forEach(button=>button.addEventListener('click',()=>button.closest('dialog').close()));
$$('dialog').forEach(dialog=>dialog.addEventListener('close',()=>dialog.querySelectorAll('video').forEach(video=>video.pause())));
$$('dialog').forEach(dialog=>dialog.addEventListener('click',event=>{if(event.target===dialog){const r=dialog.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)dialog.close();}}));
function showInfo(label,body){$('#info-label').textContent=label;$('#info-body').innerHTML=`<div class="info-copy">${body}</div>`;$('#info-dialog').showModal();}
function showHow(){showInfo('THE EVOLUTION LOOP',`<h2>Images and videos, evolved through neural feedback.</h2><ol><li>Choose an ad format and optionally upload an original.</li><li>Research once. Generate varied image or Seedance video takes; crossover and mutation include motion and audio traits.</li><li>Review actual media. Video review samples six frames and transcribes audio; it cannot inspect every moment. Keep a nonempty provisional shortlist if all fail.</li><li>Evaluate shortlisted media with TRIBE. Images are wrapped as ten-second silent videos. Videos retain audio and use TRIBE's transcript/event processing.</li><li>Score exactly as Percept: original-media temporal normalization, bilateral Glasser parcel means, four equally weighted families, then its 0–100 transform and rounding.</li><li>The highest overall neural score wins. Keep the original baseline fixed while crossing and mutating winners.</li></ol><p>This predicts cortical response, not a validated emotional response or conversion rate. No decoder training or OASIS reference is used. An uploaded original gets one baseline evaluation in addition to the shortlist budget; otherwise the first shortlisted creative establishes it.</p>`);}
$('#help').addEventListener('click',showHow);$('#nav-how').addEventListener('click',showHow);
$('#nav-connections').addEventListener('click',()=>showInfo('MODEL CONNECTIONS',`<h2>Generation and neural evaluation.</h2><div class="connection-row">OpenAI research, images & review <span>${config.liveResearch?'Configured':'Not connected'}</span></div><div class="connection-row">Seedance 2.0 video <span>${config.liveVideos?'Configured':'Not connected'}</span></div><div class="connection-row">Percept/TRIBE worker <span>${config.tribe?'Endpoint configured':'Not connected'}</span></div><p>Set OPENAI_API_KEY, PIKA_API_KEY and BASETEN_TRIBE_ENDPOINT / BASETEN_API_KEY in the server environment. The worker must support the new Percept scoring contract. See README.md for setup.</p><p>Model downloads and OASIS training remain stopped. Configuration does not prove provider readiness.</p>`));
$('#nav-runs').addEventListener('click',()=>showInfo('SAVED EXPERIMENTS',`<h2>Your creative explorations.</h2>${savedRuns.length?savedRuns.map(run=>`<button class="run-list-row" data-run="${escapeHtml(run.id)}"><div>${escapeHtml(run.product)}<small>${escapeHtml(new Date(run.createdAt).toLocaleString())}</small></div><span class="tiny-badge">${escapeHtml(run.status)}</span></button>`).join(''):'<p>Run your first experiment to start a creative history. Runs are saved on this computer.</p>'}`));
$('#info-body').addEventListener('click',event=>{const button=event.target.closest('[data-run]');if(button)openRun(button.dataset.run);});

async function initialize(){
  updateBudget();
  try {config=await api('/api/config');updateModes();await refreshRuns();const id=location.hash.match(/^#run=([a-f0-9-]{36})$/i)?.[1];if(id)await openRun(id);}
  catch(error){$('#form-error').textContent=errorMessage(error);$('#form-error').hidden=false;}
}
initialize();
