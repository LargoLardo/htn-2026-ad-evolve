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
let pollTimer = null, fetchSequence = 0, submitting = false;
const running = () => currentRun?.status === 'running';
const number = value => Number.isFinite(Number(value)) ? Number(value) : 0;
const score = value => number(value).toFixed(1);
const duration = ms => ms < 60000 ? `${(number(ms)/1000).toFixed(ms < 10000 ? 1 : 0)}s` : `${Math.floor(ms/60000)}m ${Math.floor(ms%60000/1000)}s`;
const titleCase = text => String(text).replace(/^./, c => c.toUpperCase());
const safeLink = value => { try { const u = new URL(value); return ['http:','https:'].includes(u.protocol) ? u.href : ''; } catch { return ''; } };
const assetLink = value => typeof value === 'string' && /^\/assets\/[a-f0-9]{64}\.(png|svg|webp|jpg)$/.test(value) ? value : '';
const allCandidates = () => currentRun?.rounds?.flatMap(round => round.candidates || []) || [];
const provenanceLabel = candidate => candidate?.scores?.source === 'tribe-calibrated' ? 'TRIBE + fitted decoder' : 'Design heuristic';
const mediaLabel = kind => kind === 'ai-generated-image' ? 'Generated image' : kind === 'local-storyboard' ? 'Demo illustration' : kind || 'Text genome';

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
  const rounds = +$('#rounds').value, population = +$('#population').value;
  $('#shortlist').max = population;
  if (+$('#shortlist').value > population) $('#shortlist').value = population;
  const k = +$('#shortlist').value;
  $('#budget-note').textContent = `Screen ${rounds*population} concepts; shortlist up to ${(rounds-1)*k+Math.max(3,k)} drafts, plus up to 3 final renders in proxy mode. Identical drafts are reused.`;
}
['rounds','population','shortlist'].forEach(id => $('#'+id).addEventListener('input',updateBudget));
function updateModes() {
  const live = config.liveResearch && config.liveImages;
  $('#mode option[value="live"]').disabled = !live;
  $('#mode option[value="live"]').textContent = live ? 'Live · web research + generated images' : 'Live · connect an API key';
  const canTribe = config.tribe && $('#mode').value === 'live';
  $('#scorer option[value="tribe"]').disabled = !canTribe;
  $('#scorer option[value="tribe"]').textContent = config.tribe ? 'TRIBE · calibrated worker (live images)' : 'TRIBE · connect a calibrated worker';
  if (!canTribe && $('#scorer').value === 'tribe') $('#scorer').value = 'proxy';
  $('#mode-note').textContent = $('#mode').value === 'demo' ? 'No API key needed. Demo research and scores are illustrative.' : 'Live mode makes paid API calls using your server credentials.';
  $('#mode-badge').innerHTML = `<i></i> ${$('#mode').value === 'demo' ? 'Demo workspace' : 'Live generation'}`;
}
$('#mode').addEventListener('change',updateModes);

function readBrief() {
  return Object.fromEntries([...new FormData($('#brief-form'))].map(([key,value]) => [key,['rounds','population','shortlist','seed'].includes(key)?Number(value):value]).filter(([key]) => !key.startsWith('weight-')).concat([['weights',Object.fromEntries(emotions.map(key => [key,+$('#weight-'+key).value]))]]));
}
function fillBrief(brief) {
  for (const [key,value] of Object.entries(brief || {})) {
    if (key === 'weights') { for (const emotion of emotions) { $('#weight-'+emotion).value = value[emotion]; $('#weight-'+emotion).nextElementSibling.value = value[emotion]; } }
    else if ($('#brief-form').elements.namedItem(key)) $('#brief-form').elements.namedItem(key).value = value;
  }
  updateBudget(); updateModes();
}
function lockForm(locked) {
  $$('#brief-form input, #brief-form textarea, #brief-form select, #start-run').forEach(node => node.disabled = locked);
  $('#start-run').innerHTML = locked ? `${icon('sparkles')}<span>Evolution in progress</span><span>↗</span>` : `${icon('sparkles')}<span>Start evolution</span><span>↗</span>`;
  if (!locked) updateModes();
}
$('#brief-form').addEventListener('submit', async event => {
  event.preventDefault(); if (submitting || running()) return;
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
  clearTimeout(pollTimer); fetchSequence++; currentRun = null; selectedRound = 'latest';
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
const stageText = {queued:'Your experiment is queued.',research:'Finding the context behind your product…',generating:'Creating and recombining creative genomes…',screening:'Screening the population against your priorities…',rendering:'Rendering the shortlist. Other concepts stay lightweight.',scoring:'Evaluating selected media with the calibrated TRIBE worker…',evolving:'Selecting parents and preserving useful variation…',finalizing:'Preparing your strongest distinct drafts…',complete:'Your final drafts are ready to explore.',cancelled:'Stopped. Completed work is saved.',failed:'The run stopped with an error. Details are below.'};
function renderRun() {
  if(!currentRun) return;
  const run=currentRun, completed=run.status==='completed';
  $('#empty-state').hidden = true; $('#run-workspace').hidden = false; lockForm(running());
  $('#run-label').textContent = `EXPERIMENT ${run.id.slice(0,8).toUpperCase()} · ${run.brief.mode.toUpperCase()}`;
  $('#run-title').textContent = `${run.brief.product} / ${completed?'The next generation':'Creative exploration'}`;
  $('#run-stage').textContent = stageText[run.stage] || titleCase(run.stage);
  $('#run-state').textContent = run.status;
  $('#cancel-run').hidden = !running(); $('#export-run').hidden = running(); $('#export-run').href = `/api/runs/${run.id}/export`;
  const metrics=run.metrics || {};
  $('#metric-generated').textContent = metrics.generated || 0; $('#metric-rendered').textContent = metrics.rendered || 0;
  $('#metric-cache').textContent = metrics.cacheHits || 0; $('#metric-time').textContent = duration(metrics.elapsedMs);
  $('#progress-fill').style.width = completed?'100%':`${Math.min(96,5+(run.rounds.length/run.brief.rounds)*85)}%`;
  $('#score-disclosure').innerHTML = icon('help') + (run.brief.scorer==='tribe' ? 'TRIBE + an experimental fitted decoder. Scores estimate ratings; predictive validity must be established separately.' : 'Design heuristic / 100. These scores are illustrative design priors, not measured emotions or predicted conversions.');
  $$('.result-tabs button').forEach(button => { const active=button.dataset.view===currentView; button.classList.toggle('active',active); button.setAttribute('aria-selected',String(active)); });
  const content=$('#result-content');
  content.innerHTML = (run.error?`<div class="error-note" role="alert">${escapeHtml(run.error)}</div>`:'') + ({candidates:renderCandidates,lineage:renderLineage,research:renderResearch,log:renderLog}[currentView])();
}
$$('.result-tabs button').forEach(button => button.addEventListener('click',() => { currentView=button.dataset.view;renderRun(); }));
$$('.result-tabs button').forEach((button,i,buttons) => button.addEventListener('keydown',event => { if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return; event.preventDefault(); const next=event.key==='Home'?0:event.key==='End'?buttons.length-1:(i+(event.key==='ArrowRight'?1:-1)+buttons.length)%buttons.length; buttons[next].focus(); buttons[next].click(); }));
function waiting(title,detail) { return `<div class="waiting-panel">${running()?'<span class="spinner"></span>':icon('layers')}<h3>${escapeHtml(title)}</h3><p>${escapeHtml(detail)}</p></div>`; }
function renderCandidates() {
  const run=currentRun, rounds=run.rounds||[], hasFinalists=run.finalists?.length>0;
  if(!rounds.length) return waiting('The first generation starts here.', 'Your research and creative genomes will appear as the run progresses.');
  const choice=selectedRound==='latest'?(hasFinalists?'final':rounds.at(-1).number):selectedRound;
  const round=rounds.find(r=>String(r.number)===String(choice)) || rounds.at(-1);
  const candidates=choice==='final'?run.finalists:[...(round.candidates||[])].sort((a,b)=>Number(b.scores?.source==='tribe-calibrated')-Number(a.scores?.source==='tribe-calibrated') || number(b.scores?.fitness)-number(a.scores?.fitness));
  const toolbar=`<div class="round-toolbar"><div class="round-buttons">${hasFinalists?`<button data-round="final" class="${choice==='final'?'active':''}">Finalists ✳</button>`:''}${rounds.map(r=>`<button data-round="${r.number}" class="${String(choice)===String(r.number)?'active':''}">Gen ${r.number}</button>`).join('')}</div><span class="sort-note">${choice==='final'?'Selected final drafts':(run.brief.scorer==='tribe'?'TRIBE evaluated first':'Sorted by design heuristic')}</span></div>`;
  return toolbar+`<div class="creative-grid">${candidates.map((c,i)=>creativeCard(c,i,choice==='final')).join('')}</div>`+(choice==='final'?`<div class="results-summary"><strong>${candidates.length} drafts, ready for your judgment.</strong> Inspect a creative to see its genome, inherited strengths and score breakdown. Take the strongest candidates into a human preference test.</div>`:'')+renderChart();
}
function creativeCard(candidate,index,final) {
  const asset=assetLink(candidate.asset?.url);
  return `<button class="creative-card" data-candidate="${escapeHtml(candidate.id)}" aria-label="Inspect ${escapeHtml(candidate.headline)}"><div class="creative-image">${asset?`<img src="${escapeHtml(asset)}" alt="${escapeHtml(candidate.headline)}" loading="lazy">`:`<div class="unrendered"><small>CONCEPT / NOT RENDERED</small>${escapeHtml(candidate.headline)}</div>`}<span class="creative-rank">${final?`FINALIST 0${index+1}`:candidate.selected?'SELECTED PARENT':`CONCEPT ${index+1}`}</span><span class="creative-source">${asset?escapeHtml(mediaLabel(candidate.asset.kind)):'Text genome'}</span></div><div class="creative-card-body"><div class="creative-card-title">${escapeHtml(candidate.headline)}</div><div class="creative-card-info"><span class="fitness">${score(candidate.scores?.fitness)}<small> / 100</small></span><span class="generation-badge">${provenanceLabel(candidate)}</span></div><div class="gene-tags"><span>${escapeHtml(candidate.genome.emotion)}</span><span>${escapeHtml(candidate.genome.palette)}</span></div></div></button>`;
}
function renderChart() {
  const rounds=currentRun.rounds.filter(r=>r.candidates?.some(c=>c.scores));
  if(rounds.length<2) return '';
  return `<div class="chart-panel"><h3>How the population is changing</h3><p>Relative fitness within this experiment. A higher proxy score is not evidence of a better ad.</p><div class="chart">${rounds.map(r=>`<div class="chart-group"><div class="chart-bar mean" style="height:${Math.min(100,Math.max(0,number(r.mean)))}%" title="Generation ${r.number} mean ${score(r.mean)}"></div><div class="chart-bar" style="height:${Math.min(100,Math.max(0,number(r.best)))}%" title="Generation ${r.number} best ${score(r.best)}"><span>${score(r.best)}</span></div></div>`).join('')}</div><div class="chart-labels">${rounds.map(r=>`<span>Gen ${r.number}</span>`).join('')}</div><div class="chart-legend"><span><i></i>Best eligible score</span><span><i></i>Eligible population mean</span></div></div>`;
}
function renderLineage() {
  if(!currentRun.rounds.length) return waiting('A family tree, in the making.', 'Selected parents and inherited genes will appear after the first generation.');
  const names=new Map(allCandidates().map(c=>[c.id,`Gen ${c.round} / ${c.id.split('-').at(-1)}`]));
  return `<div class="lineage-panel"><h3>Follow the creative DNA</h3><p>Each child combines parent genes, then changes a specific trait. Elites carry forward unchanged. Click a node to inspect its full genome.</p>${currentRun.rounds.map(r=>`<section class="lineage-round"><strong>GENERATION ${r.number}</strong>${r.candidates.map(c=>`<button class="lineage-node" data-candidate="${escapeHtml(c.id)}"><div><span>${c.selected?'✳ ':''}${escapeHtml(c.headline)}</span><b>${score(c.scores?.fitness)}</b></div><small>${escapeHtml(c.mutation)} · ${provenanceLabel(c)}</small><small class="parent-list">${c.parents.length?'↳ Inherits from '+c.parents.map(id=>escapeHtml(names.get(id)||id)).join(' + '):'Original genome · no parents'}</small></button>`).join('')}</section>`).join('')}</div>`;
}
function renderResearch() {
  const research=currentRun.research;
  if(!research) return waiting('Finding a starting point.', 'Research runs once, then informs every generation in this experiment.');
  return `<div class="research-panel"><h3>${currentRun.brief.mode==='demo'?'Brief-derived creative hypotheses':'Research behind the creative'}</h3><p>${escapeHtml(research.summary)}</p>${(research.insights||[]).map((insight,i)=>`<article class="research-insight"><span>0${i+1}</span><div><h4>${escapeHtml(insight.title)} ${insight.kind?`<span class="tiny-badge">${escapeHtml(insight.kind)}</span>`:''}</h4><p>${escapeHtml(insight.detail)}</p>${(insight.sourceUrls||[]).filter(safeLink).map(url=>`<div class="source-list"><a href="${escapeHtml(safeLink(url))}" target="_blank" rel="noopener noreferrer">Supporting source ↗</a></div>`).join('')}</div></article>`).join('')}<div class="source-list"><h4>${research.sources?.length?'RESEARCH SOURCES':'NO EXTERNAL SOURCES IN DEMO MODE'}</h4>${(research.sources||[]).filter(source=>safeLink(source.url)).map(source=>`<a href="${escapeHtml(safeLink(source.url))}" target="_blank" rel="noopener noreferrer">${escapeHtml(source.title)} ↗</a>`).join('')}</div><p class="provenance">${escapeHtml(research.provenance)}</p></div>`;
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
  $('#detail-body').innerHTML=`<div class="detail-layout"><div class="detail-image">${asset?`<img src="${escapeHtml(asset)}" alt="${escapeHtml(candidate.headline)}"><a class="button secondary" href="${escapeHtml(asset)}" download="${escapeHtml(currentRun.brief.product.replace(/[^a-z0-9]/gi,'-'))}-${candidate.id}.${asset.split('.').at(-1)}">${icon('download')} Download draft</a>`:'<div class="waiting-panel">This concept was screened without rendering an image.</div>'}<p class="field-hint">${asset?(candidate.scores?.source==='tribe-calibrated'?'TRIBE evaluated this exact image under the worker presentation protocol.':'The heuristic scores the text genome. This image illustrates the concept.'):''}</p></div><div class="detail-info"><h2>${escapeHtml(candidate.headline)}</h2><p>${escapeHtml(candidate.body)}</p><span class="tiny-badge">CTA / ${escapeHtml(candidate.cta)}</span><h3>Creative genome</h3><dl class="genome-list">${Object.entries(candidate.genome).map(([key,value])=>`<dt>${escapeHtml(key)}</dt><dd>${escapeHtml(value)}</dd>`).join('')}</dl><h3>${provenanceLabel(candidate)} · ${score(candidate.scores?.fitness)} / 100</h3>${emotions.map(key=>`<div class="score-row"><span>${titleCase(key)}</span><div class="score-track"><i style="width:${Math.min(100,Math.max(0,number(candidate.scores?.[key])))}%"></i></div><b>${score(candidate.scores?.[key])}</b></div>`).join('')}<p class="detail-meta">${escapeHtml(candidate.scores?.provenance)}${candidate.scores?.confidence==null?' · Uncertainty not estimated.':''}</p><h3>Where this came from</h3><p class="detail-meta">Generation ${candidate.round} · ${escapeHtml(candidate.mutation)}<br>${candidate.parents.length?'Parents: '+candidate.parents.map(escapeHtml).join(', '):'Initial population'}</p><details class="advanced"><summary>Render prompt <span>+</span></summary><p class="detail-meta">${escapeHtml(candidate.asset?.prompt||'No render prompt yet.')}</p></details></div></div>`;
  $('#detail-dialog').showModal();
}
$$('.close-dialog').forEach(button=>button.addEventListener('click',()=>button.closest('dialog').close()));
$$('dialog').forEach(dialog=>dialog.addEventListener('click',event=>{if(event.target===dialog){const r=dialog.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)dialog.close();}}));
function showInfo(label,body){$('#info-label').textContent=label;$('#info-body').innerHTML=`<div class="info-copy">${body}</div>`;$('#info-dialog').showModal();}
function showHow(){showInfo('THE EVOLUTION LOOP',`<h2>A population of ideas. A visible lineage.</h2><ol><li><strong>Research once.</strong> Turn the product, audience and goal into evidence-linked creative hypotheses. Demo mode uses your brief only.</li><li><strong>Generate genomes.</strong> Give every concept a hook, visual approach, emotional angle, proof point, call to action and palette.</li><li><strong>Screen, then render.</strong> A cheap design heuristic screens every concept. The shortlist preserves a slot for a different direction. Only selected concepts become images.</li><li><strong>Evaluate and select.</strong> Use your relative emotional priorities to rank eligible candidates. Optional TRIBE scoring uses a separately calibrated decoder on rendered media.</li><li><strong>Recombine and mutate.</strong> Preserve the best candidate, mix parent genes and change individual traits. Repeat for your chosen number of rounds.</li><li><strong>Review the finalists.</strong> Inspect genomes, compare generations and download the final drafts and complete run.</li></ol><h3>What the score means</h3><p>The demo score is a transparent, unvalidated design heuristic. TRIBE predicts population-average cortical activity. It needs a separately trained emotion decoder before it can estimate your chosen responses. Neither score is a conversion forecast.</p><h3>Why it runs faster</h3><p>One research pass, a small shortlist, two parallel image jobs, cached identical candidates, and a warm TRIBE worker. The prototype generates still-image drafts; video generation and validated temporal response targets are extensions.</p><p><a href="https://github.com/facebookresearch/tribev2" target="_blank" rel="noopener noreferrer">Meta TRIBE v2 documentation ↗</a></p>`);}
$('#help').addEventListener('click',showHow);$('#nav-how').addEventListener('click',showHow);
$('#nav-connections').addEventListener('click',()=>showInfo('MODEL CONNECTIONS',`<h2>Your models, connected locally.</h2><div class="connection-row">Research & concept generation <span>${config.liveResearch?'Key configured':'Not connected'}</span></div><div class="connection-row">Image generation <span>${config.liveImages?'Key configured':'Not connected'}</span></div><div class="connection-row">Calibrated TRIBE worker <span>${config.tribe?'Endpoint configured':'Not connected'}</span></div><p>Credentials stay in the local server environment. Configured credentials do not guarantee model access or worker readiness.</p><h3>Enable live research and images</h3><p>Copy <code>.env.example</code> to <code>.env</code>, set <code>OPENAI_API_KEY</code> and restart the server. You can select your text and image models there.</p><p>Text model: <code>${escapeHtml(config.textModel)}</code><br>Image model: <code>${escapeHtml(config.imageModel)}</code></p><h3>Enable calibrated TRIBE scoring</h3><p>Follow <code>worker/WORKER.md</code>. A GPU worker, model access and a trained emotion decoder are required. Set <code>TRIBE_URL</code> and <code>TRIBE_DECODER_VERSION</code> in the server environment. No pretrained emotion decoder is included.</p><p>TRIBE code and weights have noncommercial licensing restrictions. Review upstream terms before commercial deployment.</p>`));
$('#nav-runs').addEventListener('click',()=>showInfo('SAVED EXPERIMENTS',`<h2>Your creative explorations.</h2>${savedRuns.length?savedRuns.map(run=>`<button class="run-list-row" data-run="${escapeHtml(run.id)}"><div>${escapeHtml(run.product)}<small>${escapeHtml(new Date(run.createdAt).toLocaleString())}</small></div><span class="tiny-badge">${escapeHtml(run.status)}</span></button>`).join(''):'<p>Run your first experiment to start a creative history. Runs are saved on this computer.</p>'}`));
$('#info-body').addEventListener('click',event=>{const button=event.target.closest('[data-run]');if(button)openRun(button.dataset.run);});

async function initialize(){
  updateBudget();
  try {config=await api('/api/config');updateModes();await refreshRuns();const id=location.hash.match(/^#run=([a-f0-9-]{36})$/i)?.[1];if(id)await openRun(id);}
  catch(error){$('#form-error').textContent=errorMessage(error);$('#form-error').hidden=false;}
}
initialize();
