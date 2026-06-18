let DATA = null;
let FLAT = [];

const $ = (id) => document.getElementById(id);
const norm = (s) => (s || '').toString().normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
const num = (n) => (n ?? 0).toLocaleString('ca-ES');

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
    // Compatibilitat amb la mostra inicial antiga.
    const res = await fetch('data/votacions.json?ts=' + Date.now());
    if(!res.ok) throw new Error('No s\'ha trobat data/manifest.json. Executa l\'Action de GitHub per generar les dades.');
    payload = await res.json();
  }

  DATA = payload;
  FLAT = [];
  for(const v of (DATA.votes || [])){
    for(const m of (v.members || [])){
      FLAT.push({
        voteId: v.id,
        date: v.date,
        year: v.year,
        month: v.month,
        session: v.session,
        voteNumber: v.vote_number,
        title: v.title,
        sourcePdf: v.source_pdf,
        sourcePage: v.source_page,
        totals: v.totals || {},
        member: m.name,
        group: m.group,
        vote: m.vote,
        telematic: !!m.telematic
      });
    }
  }
  hydrateFilters();
  render();
}

function hydrateFilters(){
  const groups = [...new Set(FLAT.map(x=>x.group).filter(Boolean))].sort((a,b)=>a.localeCompare(b));
  $('groupFilter').innerHTML = '<option value="">Tots</option>' + groups.map(g=>`<option>${escapeHtml(g)}</option>`).join('');
  const members = [...new Set(FLAT.map(x=>x.member).filter(Boolean))].sort((a,b)=>a.localeCompare(b));
  $('membersList').innerHTML = members.map(m=>`<option value="${escapeAttr(m)}"></option>`).join('');
}

function filters(){
  return {
    q: norm($('q').value),
    member: norm($('memberFilter').value),
    group: $('groupFilter').value,
    vote: $('voteFilter').value,
    from: $('dateFrom').value,
    to: $('dateTo').value,
  };
}

function filteredFlat(){
  const f = filters();
  return FLAT.filter(x => {
    if(f.from && x.date < f.from) return false;
    if(f.to && x.date > f.to) return false;
    if(f.group && x.group !== f.group) return false;
    if(f.vote && x.vote !== f.vote) return false;
    if(f.member && !norm(x.member).includes(f.member)) return false;
    if(f.q){
      const hay = norm([x.member,x.group,x.vote,x.title,x.date,x.session,x.voteNumber].join(' '));
      if(!hay.includes(f.q)) return false;
    }
    return true;
  });
}

function filteredVotes(rows){
  const ids = new Set(rows.map(x=>x.voteId));
  return (DATA.votes || []).filter(v => ids.has(v.id));
}

function render(){
  const rows = filteredFlat();
  const votes = filteredVotes(rows);
  renderKpis(rows, votes);
  renderSummary(rows, votes);
  renderMembers(rows);
  renderGroups(rows);
  renderVotes(votes, rows);
  const meta = DATA.metadata || {};
  $('sourceInfo').innerHTML = `Font: ${escapeHtml(meta.source || 'Open Data Congreso')} · Generat: ${escapeHtml(meta.generated_at || '')} · Votacions carregades: ${num((DATA.votes||[]).length)}.`;
}

function renderKpis(rows, votes){
  const members = new Set(rows.map(x=>x.member)).size;
  const groups = new Set(rows.map(x=>x.group)).size;
  const sessions = new Set(votes.map(v=>`${v.date}_${v.session}`)).size;
  $('kpis').innerHTML = [
    ['Votacions filtrades', num(votes.length)],
    ['Vots nominals', num(rows.length)],
    ['Diputats', num(members)],
    ['Sessions', num(sessions)],
  ].map(([label,value])=>`<div class="card"><div class="label">${label}</div><div class="value">${value}</div></div>`).join('');
}

function renderSummary(rows, votes){
  const byVote = countBy(rows, x=>x.vote || 'Sense dada');
  const byGroup = topN(countBy(rows, x=>x.group || 'Sense grup'), 8);
  $('summaryGrid').innerHTML = `
    <div class="card"><div class="label">Sí</div><div class="value">${num(byVote['Sí']||0)}</div></div>
    <div class="card"><div class="label">No</div><div class="value">${num(byVote['No']||0)}</div></div>
    <div class="card"><div class="label">Abstenció</div><div class="value">${num(byVote['Abstención']||0)}</div></div>
    <div class="card"><div class="label">No vota</div><div class="value">${num(byVote['No vota']||0)}</div></div>
    <div class="card" style="grid-column:1/-1"><div class="label">Grups més presents al filtre</div><div>${byGroup.map(([k,v])=>`<span class="pill">${escapeHtml(shortGroup(k))}: ${num(v)}</span>`).join('')}</div></div>
  `;
}

function renderMembers(rows){
  const map = new Map();
  for(const r of rows){
    const key = r.member || 'Sense nom';
    if(!map.has(key)) map.set(key, {member:key, group:r.group, total:0, si:0, no:0, abst:0, novota:0});
    const o = map.get(key); o.total++;
    if(r.vote==='Sí') o.si++; else if(r.vote==='No') o.no++; else if(r.vote==='Abstención') o.abst++; else if(r.vote==='No vota') o.novota++;
  }
  const data = [...map.values()].sort((a,b)=>b.total-a.total || a.member.localeCompare(b.member)).slice(0,500);
  $('membersTable').innerHTML = table(['Diputat','Grup','Total','Sí','No','Abst.','No vota'], data.map(o=>[
    o.member, shortGroup(o.group), num(o.total), num(o.si), num(o.no), num(o.abst), num(o.novota)
  ]));
}

function renderGroups(rows){
  const map = new Map();
  for(const r of rows){
    const key = r.group || 'Sense grup';
    if(!map.has(key)) map.set(key, {group:key, total:0, si:0, no:0, abst:0, novota:0});
    const o = map.get(key); o.total++;
    if(r.vote==='Sí') o.si++; else if(r.vote==='No') o.no++; else if(r.vote==='Abstención') o.abst++; else if(r.vote==='No vota') o.novota++;
  }
  const data = [...map.values()].sort((a,b)=>b.total-a.total || a.group.localeCompare(b.group));
  $('groupsTable').innerHTML = table(['Grup','Total','Sí','No','Abst.','No vota'], data.map(o=>[
    o.group, num(o.total), num(o.si), num(o.no), num(o.abst), num(o.novota)
  ]));
}

function renderVotes(votes, rows){
  const byId = new Map();
  for(const r of rows){
    if(!byId.has(r.voteId)) byId.set(r.voteId, []);
    byId.get(r.voteId).push(r);
  }
  const sorted = [...votes].sort((a,b)=>(b.date||'').localeCompare(a.date||'') || Number(b.vote_number||0)-Number(a.vote_number||0)).slice(0,250);
  $('votesList').innerHTML = sorted.map(v=>{
    const r = byId.get(v.id) || [];
    const c = countBy(r, x=>x.vote || 'Sense dada');
    const t = v.totals || {};
    return `<article class="vote-card">
      <h3>${escapeHtml(v.title || 'Sense títol')}</h3>
      <div class="meta">${escapeHtml(v.date)} · Sessió ${escapeHtml(v.session)} · Votació ${escapeHtml(v.vote_number)} · <a href="${escapeAttr(v.source_pdf)}" target="_blank" rel="noopener">PDF oficial</a></div>
      <div class="mini-grid">
        <div class="mini"><strong>${num(t.si ?? c['Sí'] ?? 0)}</strong>Sí</div>
        <div class="mini"><strong>${num(t.no ?? c['No'] ?? 0)}</strong>No</div>
        <div class="mini"><strong>${num(t.abstenciones ?? c['Abstención'] ?? 0)}</strong>Abst.</div>
        <div class="mini"><strong>${num(t.no_votan ?? c['No vota'] ?? 0)}</strong>No vota</div>
      </div>
      <details><summary>Veure diputats filtrats en aquesta votació (${num(r.length)})</summary>${table(['Diputat','Grup','Vot'], r.map(x=>[x.member, shortGroup(x.group), x.vote]))}</details>
    </article>`
  }).join('') || '<p class="hint">Cap resultat amb aquests filtres.</p>';
}

function table(headers, rows){
  return `<div class="table-wrap"><table><thead><tr>${headers.map(h=>`<th>${escapeHtml(h)}</th>`).join('')}</tr></thead><tbody>${rows.map(row=>`<tr>${row.map(cell=>`<td>${escapeHtml(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}

function countBy(arr, fn){
  const o = {};
  for(const x of arr){ const k = fn(x); o[k] = (o[k]||0)+1; }
  return o;
}
function topN(obj, n){ return Object.entries(obj).sort((a,b)=>b[1]-a[1]).slice(0,n); }
function shortGroup(g){
  return (g||'').replace('Grupo Parlamentario ', '').replace('en el Congreso','').trim();
}
function escapeHtml(s){ return (s ?? '').toString().replace(/[&<>"]/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[ch])); }
function escapeAttr(s){ return escapeHtml(s).replace(/'/g,'&#39;'); }

function exportCsv(){
  const rows = filteredFlat();
  const headers = ['date','session','voteNumber','title','member','group','vote','sourcePdf'];
  const csv = [headers.join(';')].concat(rows.map(r=>headers.map(h=>`"${(r[h]??'').toString().replaceAll('"','""')}"`).join(';'))).join('\n');
  const blob = new Blob([csv], {type:'text/csv;charset=utf-8'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'votacions_filtrades.csv';
  a.click();
  URL.revokeObjectURL(a.href);
}

for(const id of ['q','memberFilter','groupFilter','voteFilter','dateFrom','dateTo']){
  document.addEventListener('input', (e)=>{ if(e.target && e.target.id===id) render(); });
  document.addEventListener('change', (e)=>{ if(e.target && e.target.id===id) render(); });
}

document.querySelectorAll('.tab').forEach(btn=>btn.addEventListener('click',()=>{
  document.querySelectorAll('.tab').forEach(b=>b.classList.remove('active'));
  btn.classList.add('active');
  for(const id of ['resum','diputats','grups','votacions']) $('tab-'+id).classList.add('hidden');
  $('tab-'+btn.dataset.tab).classList.remove('hidden');
}));

$('refreshBtn').addEventListener('click', loadData);
$('csvBtn').addEventListener('click', exportCsv);

loadData().catch(err=>{
  document.querySelector('main').innerHTML = `<section class="panel"><h2>No hi ha dades encara</h2><p>${escapeHtml(err.message)}</p><p>Ves a <strong>Actions</strong> → <strong>Actualitza dades Congreso</strong> → <strong>Run workflow</strong>. Quan acabi, activa GitHub Pages i obre el visor.</p></section>`;
});
