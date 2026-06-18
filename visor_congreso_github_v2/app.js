let DATA = null;
let FLAT = [];
const $ = (id) => document.getElementById(id);
const norm = (s) => (s || '').toString().normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
const num = (n) => (n ?? 0).toLocaleString('ca-ES');

const PARTY_COLORS = {
  'PSOE':'#e30613','PP':'#1f77b4','VOX':'#63be21','SUMAR':'#e34aa9','Podemos':'#6f2dbd',
  'Junts':'#00a6b2','ERC':'#f2c300','PNV':'#00843d','EH Bildu':'#7a9a01',
  'BNG':'#76b7e5','Coalición Canaria':'#ffd12a','UPN':'#004b8d','Mixt residual':'#9ca3af',
  'Altres':'#6b7280'
};
const PARTY_ORDER = ['PSOE','PP','VOX','SUMAR','Podemos','Junts','ERC','PNV','EH Bildu','BNG','Coalición Canaria','UPN','Mixt residual','Altres'];
const VOTE_ORDER = {'Sí':0,'Abstención':1,'No vota':2,'No':3,'Dividit':4,'Sense vot':5};

function partyOf(member, group){
  const m = norm(member), g = norm(group);
  if(g.includes('popular')) return 'PP';
  if(g.includes('socialista')) return 'PSOE';
  if(g.includes('vox')) return 'VOX';
  if(g.includes('junts')) return 'Junts';
  if(g.includes('republicano')) return 'ERC';
  if(g.includes('sumar')) return 'SUMAR';
  if(g.includes('vasco') || g.includes('eaj') || g.includes('pnv')) return 'PNV';
  if(g.includes('bildu')) return 'EH Bildu';
  if(g.includes('mixto') || g.includes('mixt')){
    if(m.includes('rego candamil') || m.includes('nestor rego')) return 'BNG';
    if(m.includes('valido garcia') || m.includes('cristina valido')) return 'Coalición Canaria';
    if(m.includes('catalan higueras') || m.includes('alberto catalan')) return 'UPN';
    if(m.includes('belarra') || m.includes('sanchez serna') || m.includes('velarde') || m.includes('santana perera') || m.includes('noemi santana')) return 'Podemos';
    return 'Mixt residual';
  }
  return 'Altres';
}
function partySort(a,b){ return (PARTY_ORDER.indexOf(a) === -1 ? 99 : PARTY_ORDER.indexOf(a)) - (PARTY_ORDER.indexOf(b) === -1 ? 99 : PARTY_ORDER.indexOf(b)) || a.localeCompare(b); }
function dot(p){ return `<span class="dot" style="background:${PARTY_COLORS[p]||PARTY_COLORS.Altres}"></span>`; }
function partyBadge(p){ return `<span class="party-badge">${dot(p)}${escapeHtml(p)}</span>`; }

async function loadData(){
  $('sourceInfo').textContent = 'Carregant dades...';
  let payload;
  const manifestRes = await fetch('data/manifest.json?ts=' + Date.now());
  if(manifestRes.ok){
    const manifest = await manifestRes.json();
    const votes = [];
    const chunks = manifest.chunks || [];
    $('sourceInfo').textContent = `Carregant ${chunks.length} fitxers mensuals...`;
    for(const ch of chunks){
      const res = await fetch('data/' + ch.file + '?ts=' + Date.now());
      if(!res.ok) throw new Error('No es pot carregar ' + ch.file);
      const obj = await res.json();
      votes.push(...(obj.votes || []));
    }
    payload = { metadata: manifest.metadata || {}, indexes: manifest.indexes || {}, votes };
  } else {
    const res = await fetch('data/votacions.json?ts=' + Date.now());
    if(!res.ok) throw new Error('No s\'ha trobat data/manifest.json. Executa l\'Action de GitHub per generar les dades.');
    payload = await res.json();
  }
  DATA = payload;
  FLAT = [];
  for(const v of (DATA.votes || [])){
    for(const m of (v.members || [])){
      const party = partyOf(m.name, m.group);
      FLAT.push({
        voteId: v.id, date: v.date, year: v.year, month: v.month, session: v.session,
        voteNumber: v.vote_number, title: v.title, sourcePdf: v.source_pdf, sourcePage: v.source_page,
        totals: v.totals || {}, member: m.name, group: m.group, party, vote: m.vote, telematic: !!m.telematic
      });
    }
  }
  hydrateFilters();
  render();
}

function hydrateFilters(){
  const parties = [...new Set(FLAT.map(x=>x.party).filter(Boolean))].sort(partySort);
  $('groupFilter').innerHTML = '<option value="">Tots</option>' + parties.map(g=>`<option>${escapeHtml(g)}</option>`).join('');
  const members = [...new Set(FLAT.map(x=>x.member).filter(Boolean))].sort((a,b)=>a.localeCompare(b));
  $('membersList').innerHTML = members.map(m=>`<option value="${escapeAttr(m)}"></option>`).join('');
  const titles = [...new Set((DATA.votes||[]).map(v=>v.title).filter(Boolean))].sort((a,b)=>a.localeCompare(b));
  if($('initiativesList')) $('initiativesList').innerHTML = titles.map(t=>`<option value="${escapeAttr(t)}"></option>`).join('');
  hydratePartyChecks(parties);
}
function hydratePartyChecks(parties){
  if(!$('partyChecks')) return;
  const defaultChecked = new Set(['VOX','ERC']);
  $('partyChecks').innerHTML = parties.map(p=>`<label class="party-check">${dot(p)}<input type="checkbox" value="${escapeAttr(p)}" ${defaultChecked.has(p)?'checked':''}>${escapeHtml(p)}</label>`).join('');
  $('partyChecks').querySelectorAll('input').forEach(i=>i.addEventListener('change', renderCompare));
}

function filters(){
  return { q:norm($('q').value), member:norm($('memberFilter').value), party:$('groupFilter').value, vote:$('voteFilter').value, from:$('dateFrom').value, to:$('dateTo').value };
}
function filteredFlat(){
  const f = filters();
  return FLAT.filter(x => {
    if(f.from && x.date < f.from) return false;
    if(f.to && x.date > f.to) return false;
    if(f.party && x.party !== f.party) return false;
    if(f.vote && x.vote !== f.vote) return false;
    if(f.member && !norm(x.member).includes(f.member)) return false;
    if(f.q){
      const hay = norm([x.member,x.group,x.party,x.vote,x.title,x.date,x.session,x.voteNumber].join(' '));
      if(!hay.includes(f.q)) return false;
    }
    return true;
  });
}
function filteredVotes(rows){ const ids = new Set(rows.map(x=>x.voteId)); return (DATA.votes || []).filter(v => ids.has(v.id)); }

function render(){
  const rows = filteredFlat();
  const votes = filteredVotes(rows);
  renderKpis(rows, votes); renderSummary(rows, votes); renderMembers(rows); renderGroups(rows); renderCompare(); renderInitiative(); renderVotes(votes, rows);
  const meta = DATA.metadata || {};
  $('sourceInfo').innerHTML = `Font: ${escapeHtml(meta.source || 'Open Data Congreso')} · Generat: ${escapeHtml(meta.generated_at || '')} · Votacions carregades: ${num((DATA.votes||[]).length)}.`;
}
function renderKpis(rows, votes){
  $('kpis').innerHTML = [['Votacions filtrades', num(votes.length)],['Vots nominals', num(rows.length)],['Diputats', num(new Set(rows.map(x=>x.member)).size)],['Sessions', num(new Set(votes.map(v=>`${v.date}_${v.session}`)).size)]].map(([l,v])=>`<div class="card"><div class="label">${l}</div><div class="value">${v}</div></div>`).join('');
}
function renderSummary(rows){
  const byVote = countBy(rows, x=>x.vote || 'Sense dada');
  const byParty = topN(countBy(rows, x=>x.party || 'Altres'), 12);
  $('summaryGrid').innerHTML = `
    <div class="card"><div class="label">Sí</div><div class="value">${num(byVote['Sí']||0)}</div></div>
    <div class="card"><div class="label">No</div><div class="value">${num(byVote['No']||0)}</div></div>
    <div class="card"><div class="label">Abstenció</div><div class="value">${num(byVote['Abstención']||0)}</div></div>
    <div class="card"><div class="label">No vota</div><div class="value">${num(byVote['No vota']||0)}</div></div>
    <div class="card" style="grid-column:1/-1"><div class="label">Partits/grups més presents al filtre</div><div>${byParty.map(([k,v])=>`<span class="pill">${dot(k)}${escapeHtml(k)}: ${num(v)}</span>`).join('')}</div></div>`;
}
function renderMembers(rows){
  const map = new Map();
  for(const r of rows){
    const key = r.member || 'Sense nom';
    if(!map.has(key)) map.set(key, {member:key, party:r.party, group:r.group, total:0, si:0, no:0, abst:0, novota:0});
    const o = map.get(key); o.total++;
    if(r.vote==='Sí') o.si++; else if(r.vote==='No') o.no++; else if(r.vote==='Abstención') o.abst++; else if(r.vote==='No vota') o.novota++;
  }
  const data = [...map.values()].sort((a,b)=>b.total-a.total || a.member.localeCompare(b.member)).slice(0,500);
  $('membersTable').innerHTML = table(['Diputat','Partit/grup','Total','Sí','No','Abst.','No vota'], data.map(o=>[o.member,{html:partyBadge(o.party)},num(o.total),num(o.si),num(o.no),num(o.abst),num(o.novota)]));
}
function renderGroups(rows){
  const map = new Map();
  for(const r of rows){
    const key = r.party || 'Altres';
    if(!map.has(key)) map.set(key, {party:key, total:0, si:0, no:0, abst:0, novota:0});
    const o = map.get(key); o.total++;
    if(r.vote==='Sí') o.si++; else if(r.vote==='No') o.no++; else if(r.vote==='Abstención') o.abst++; else if(r.vote==='No vota') o.novota++;
  }
  const data = [...map.values()].sort((a,b)=>partySort(a.party,b.party));
  $('groupsTable').innerHTML = table(['Partit/grup','Total','Sí','No','Abst.','No vota'], data.map(o=>[{html:partyBadge(o.party)},num(o.total),num(o.si),num(o.no),num(o.abst),num(o.novota)]));
}

function partyMajoritiesForVote(voteId){
  const rows = FLAT.filter(r=>r.voteId===voteId);
  const parties = {};
  for(const r of rows){
    if(!parties[r.party]) parties[r.party] = [];
    parties[r.party].push(r.vote);
  }
  const out = {};
  for(const [p,votes] of Object.entries(parties)) out[p] = majorityVote(votes);
  return out;
}
function majorityVote(votes){
  if(!votes || !votes.length) return 'Sense vot';
  const c = countBy(votes, x=>x || 'Sense vot');
  const sorted = Object.entries(c).sort((a,b)=>b[1]-a[1]);
  if(sorted.length>1 && sorted[0][1]===sorted[1][1]) return 'Dividit';
  return sorted[0][0];
}
function selectedParties(){
  if(!$('partyChecks')) return [];
  return [...$('partyChecks').querySelectorAll('input:checked')].map(i=>i.value);
}
function comparisonRows(){
  const rows = filteredFlat();
  const votes = filteredVotes(rows);
  const parties = selectedParties();
  const out = [];
  if(parties.length < 2) return out;
  for(const v of votes){
    const pv = partyMajoritiesForVote(v.id);
    const senses = parties.map(p=>pv[p] || 'Sense vot');
    const valid = senses.every(s=>s && s!=='Sense vot');
    const same = valid && senses.every(s=>s===senses[0]) && senses[0] !== 'Dividit';
    out.push({vote:v, parties, senses, same, common:same?senses[0]:''});
  }
  return out;
}
function renderCompare(){
  if(!$('compareSummary')) return;
  const parties = selectedParties();
  const mode = $('compareMode')?.value || 'all';
  let rows = comparisonRows();
  if(mode==='same') rows = rows.filter(r=>r.same);
  else if(mode==='diff') rows = rows.filter(r=>!r.same);
  else if(['Sí','No','Abstención','No vota'].includes(mode)) rows = rows.filter(r=>r.same && r.common===mode);
  const allRows = comparisonRows();
  const total = allRows.length, same = allRows.filter(r=>r.same).length;
  const sameBy = countBy(allRows.filter(r=>r.same), r=>r.common);
  $('compareSummary').innerHTML = `
    <div class="card"><div class="label">Comparativa</div><div class="value small-value">${parties.map(partyBadge).join(' + ') || 'Selecciona partits'}</div></div>
    <div class="card"><div class="label">Votacions comparades</div><div class="value">${num(total)}</div></div>
    <div class="card"><div class="label">Coincidències</div><div class="value">${num(same)}</div></div>
    <div class="card"><div class="label">Alineament</div><div class="value">${total?Math.round((same/total)*100):0}%</div></div>
    <div class="card"><div class="label">Sí conjunt</div><div class="value">${num(sameBy['Sí']||0)}</div></div>
    <div class="card"><div class="label">No conjunt</div><div class="value">${num(sameBy['No']||0)}</div></div>
    <div class="card"><div class="label">Abstenció conjunta</div><div class="value">${num(sameBy['Abstención']||0)}</div></div>
    <div class="card"><div class="label">Divergències</div><div class="value">${num(total-same)}</div></div>`;
  const tableRows = rows.slice(0,300).map(r=>[r.vote.date, `S${r.vote.session} V${r.vote.vote_number}`, r.vote.title, ...r.parties.map((p,i)=>`${p}: ${r.senses[i]}`), r.same?`Coincideixen en ${r.common}`:'Divergeixen']);
  $('compareTable').innerHTML = table(['Data','Sessió','Iniciativa',...parties,'Resultat'], tableRows);
}

function renderInitiative(){
  if(!$('initiativeResults')) return;
  const q = norm($('initiativeInput')?.value || '');
  let votes = (DATA.votes || []);
  if(q) votes = votes.filter(v=>norm(v.title).includes(q) || norm(`${v.date} ${v.session} ${v.vote_number}`).includes(q));
  votes = votes.sort((a,b)=>(b.date||'').localeCompare(a.date||'') || Number(b.vote_number||0)-Number(a.vote_number||0)).slice(0,20);
  if(!q){ $('initiativeResults').innerHTML = '<p class="hint">Escriu una paraula del títol o selecciona una iniciativa per veure el semicercle de vot.</p>'; return; }
  $('initiativeResults').innerHTML = votes.map(v=>renderVoteArc(v)).join('') || '<p class="hint">Cap iniciativa trobada.</p>';
}
function renderVoteArc(v){
  const pv = partyMajoritiesForVote(v.id);
  const entries = Object.entries(pv).filter(([p])=>p!=='Altres').sort((a,b)=>(VOTE_ORDER[a[1]]??9)-(VOTE_ORDER[b[1]]??9) || partySort(a[0],b[0]));
  const n = Math.max(entries.length,1);
  const dots = entries.map(([p,s],i)=>{
    const angle = 200 - (220 * (i/(Math.max(n-1,1))));
    const rad = angle * Math.PI / 180;
    const x = 50 + 43 * Math.cos(rad);
    const y = 88 - 72 * Math.sin(rad);
    return `<div class="arc-dot" title="${escapeAttr(p)}: ${escapeAttr(s)}" style="left:${x}%;top:${y}%;background:${PARTY_COLORS[p]||PARTY_COLORS.Altres}"><span>${escapeHtml(shortParty(p))}</span></div>`;
  }).join('');
  const badges = entries.map(([p,s])=>`<span class="pill">${dot(p)}${escapeHtml(p)}: <strong>${escapeHtml(s)}</strong></span>`).join('');
  return `<article class="vote-card initiative-card"><h3>${escapeHtml(v.title)}</h3><div class="meta">${escapeHtml(v.date)} · Sessió ${escapeHtml(v.session)} · Votació ${escapeHtml(v.vote_number)} · <a href="${escapeAttr(v.source_pdf)}" target="_blank" rel="noopener">PDF oficial</a></div><div class="arc-wrap"><div class="arc-label left">Sí</div><div class="arc-label mid">Abst. / No vota</div><div class="arc-label right">No</div><div class="arc-base"></div>${dots}</div><div class="arc-badges">${badges}</div></article>`;
}
function shortParty(p){ return {'Coalición Canaria':'CC','Mixt residual':'Mixt','EH Bildu':'Bildu'}[p] || p; }

function renderVotes(votes, rows){
  const byId = new Map();
  for(const r of rows){ if(!byId.has(r.voteId)) byId.set(r.voteId, []); byId.get(r.voteId).push(r); }
  const sorted = [...votes].sort((a,b)=>(b.date||'').localeCompare(a.date||'') || Number(b.vote_number||0)-Number(a.vote_number||0)).slice(0,250);
  $('votesList').innerHTML = sorted.map(v=>{
    const r = byId.get(v.id) || []; const c = countBy(r, x=>x.vote || 'Sense dada'); const t = v.totals || {};
    return `<article class="vote-card"><h3>${escapeHtml(v.title || 'Sense títol')}</h3><div class="meta">${escapeHtml(v.date)} · Sessió ${escapeHtml(v.session)} · Votació ${escapeHtml(v.vote_number)} · <a href="${escapeAttr(v.source_pdf)}" target="_blank" rel="noopener">PDF oficial</a></div><div class="mini-grid"><div class="mini"><strong>${num(t.si ?? c['Sí'] ?? 0)}</strong>Sí</div><div class="mini"><strong>${num(t.no ?? c['No'] ?? 0)}</strong>No</div><div class="mini"><strong>${num(t.abstenciones ?? c['Abstención'] ?? 0)}</strong>Abst.</div><div class="mini"><strong>${num(t.no_votan ?? c['No vota'] ?? 0)}</strong>No vota</div></div><details><summary>Veure diputats filtrats en aquesta votació (${num(r.length)})</summary>${table(['Diputat','Partit/grup','Vot'], r.map(x=>[x.member,{html:partyBadge(x.party)},x.vote]))}</details></article>`;
  }).join('') || '<p class="hint">Cap resultat amb aquests filtres.</p>';
}
function table(headers, rows){ return `<div class="table-wrap"><table><thead><tr>${headers.map(h=>`<th>${escapeHtml(h)}</th>`).join('')}</tr></thead><tbody>${rows.map(row=>`<tr>${row.map(cell=>`<td>${cell && typeof cell==='object' && cell.html ? cell.html : escapeHtml(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`; }
function countBy(arr, fn){ const o = {}; for(const x of arr){ const k = fn(x); o[k] = (o[k]||0)+1; } return o; }
function topN(obj, n){ return Object.entries(obj).sort((a,b)=>b[1]-a[1]).slice(0,n); }
function escapeHtml(s){ return (s ?? '').toString().replace(/[&<>"]/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[ch])); }
function escapeAttr(s){ return escapeHtml(s).replace(/'/g,'&#39;'); }

function exportCsv(){
  const rows = filteredFlat();
  const headers = ['date','session','voteNumber','title','member','party','group','vote','sourcePdf'];
  const csv = [headers.join(';')].concat(rows.map(r=>headers.map(h=>`"${(r[h]??'').toString().replaceAll('"','""')}"`).join(';'))).join('\n');
  const blob = new Blob([csv], {type:'text/csv;charset=utf-8'});
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'votacions_filtrades.csv'; a.click(); URL.revokeObjectURL(a.href);
}

for(const id of ['q','memberFilter','groupFilter','voteFilter','dateFrom','dateTo']){
  document.addEventListener('input', e=>{ if(e.target && e.target.id===id) render(); });
  document.addEventListener('change', e=>{ if(e.target && e.target.id===id) render(); });
}
document.addEventListener('change', e=>{ if(e.target && e.target.id==='compareMode') renderCompare(); });
document.addEventListener('input', e=>{ if(e.target && e.target.id==='initiativeInput') renderInitiative(); });
document.addEventListener('click', e=>{
  const btn = e.target.closest('button[data-set]');
  if(btn && $('partyChecks')){
    const set = new Set(btn.dataset.set.split('|'));
    $('partyChecks').querySelectorAll('input').forEach(i=>i.checked=set.has(i.value));
    renderCompare();
  }
  if(e.target && e.target.id==='clearInitiative'){ $('initiativeInput').value=''; renderInitiative(); }
});
document.querySelectorAll('.tab').forEach(btn=>btn.addEventListener('click',()=>{
  document.querySelectorAll('.tab').forEach(b=>b.classList.remove('active'));
  btn.classList.add('active');
  for(const id of ['resum','diputats','grups','comparativa','iniciativa','votacions']) $('tab-'+id).classList.add('hidden');
  $('tab-'+btn.dataset.tab).classList.remove('hidden');
}));
$('refreshBtn').addEventListener('click', loadData);
$('csvBtn').addEventListener('click', exportCsv);
loadData().catch(err=>{ document.querySelector('main').innerHTML = `<section class="panel"><h2>No hi ha dades encara</h2><p>${escapeHtml(err.message)}</p><p>Ves a <strong>Actions</strong> → <strong>Actualitza dades Congreso</strong> → <strong>Run workflow</strong>.</p></section>`; });
