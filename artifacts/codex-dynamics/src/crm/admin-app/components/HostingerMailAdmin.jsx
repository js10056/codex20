import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Activity, AlertCircle, BarChart3, CheckCircle2, KeyRound, Link2, Mail, Pencil, RefreshCw, Search, ShieldCheck, Trash2, UserRound, X } from 'lucide-react';
import {
  assignClientMailboxAdmin, getClientMailboxesAdmin, getHostingerMailIntegrationAdmin,
  getHostingerMailOverviewAdmin, getHostingerMailboxStatsAdmin,
  listHostingerMailboxesAdmin, removeClientMailboxAdmin, removeHostingerMailIntegrationAdmin,
  reassignClientMailboxAdmin, saveHostingerMailIntegrationAdmin, testHostingerMailIntegrationAdmin,
  updateClientMailboxAdmin,
} from '../adminApi.js';

const statusCopy = { connected: 'Connected', connection_error: 'Connection error', not_configured: 'Not configured' };
const dateLabel = value => value ? new Date(value).toLocaleString() : 'Not tested';

export function HostingerMailSettings({ onChanged }) {
  const [status, setStatus] = useState(null);
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const refresh = async () => {
    setError('');
    try { const d = await getHostingerMailIntegrationAdmin(); setStatus(d.integration || d.config || (typeof d.status === 'object' ? d.status : d)); }
    catch (e) { setError(e.message || 'Could not load Hostinger Mail settings.'); }
  };
  useEffect(() => { void refresh(); }, []);
  const run = async action => {
    setBusy(true); setError(''); setMessage('');
    try {
      if (action === 'save') { if (!token.trim()) throw new Error('Enter an API token before saving.'); await saveHostingerMailIntegrationAdmin(token.trim()); setToken(''); setMessage('Hostinger Mail API token saved and validated.'); }
      if (action === 'test') { const d = await testHostingerMailIntegrationAdmin(token.trim() || undefined); setMessage(d.message || 'Connection test completed.'); }
      if (action === 'remove') { if (!window.confirm('Remove the Hostinger Mail API configuration? Existing mailbox assignments will remain, but mail access may stop.')) return; await removeHostingerMailIntegrationAdmin(); setToken(''); setMessage('Integration configuration removed.'); }
      await refresh();
      onChanged?.();
    } catch (e) { setError(e.message || 'The request failed.'); }
    finally { setBusy(false); }
  };
  const configured = Boolean(status?.configured);
  const connected = status?.status === 'connected';
  return <section className="crm-settings-panel" aria-label="Hostinger Mail API configuration">
    <div className="crm-settings-section-head"><div><h3><Mail size={17}/> Hostinger Mail API</h3><p>Connect Codex Dynamics to the Hostinger Mail API. Credentials are sent directly to the server and never retained in this form.</p></div><span className={`crm-status-pill ${connected?'saved':'unsaved'}`}><span className="crm-status-pulse" style={{background:connected?'#30D158':undefined}}/>{statusCopy[status?.status] || 'Checking status'}</span></div>
    {error && <div role="alert" className="crm-mail-admin-alert error"><AlertCircle size={16}/>{error}</div>}
    {message && <div role="status" className="crm-mail-admin-alert success"><CheckCircle2 size={16}/>{message}</div>}
    <div className="crm-mail-admin-status"><div><span>Configuration</span><strong>{configured ? 'Configured' : 'Not configured'}</strong></div><div><span>API key</span><strong>{configured ? (status?.maskedToken || 'Stored securely') : 'None stored'}</strong></div><div><span>Hostinger mailboxes</span><strong>{status?.mailboxCount ?? '—'}</strong></div><div><span>Last tested</span><strong>{dateLabel(status?.lastTestedAt)}</strong></div><div><span>Last successful</span><strong>{dateLabel(status?.lastSuccessAt)}</strong></div></div>
    <div className="crm-mail-admin-callout"><ShieldCheck size={18}/><span>Only Super Admins can configure this integration. The token is not saved to browser storage, shown after save, or returned to the page.</span></div>
    <label className="crm-settings-field"><span>{configured?'Replace API token':'API token'}</span><input type="password" autoComplete="new-password" value={token} onChange={e=>setToken(e.target.value)} placeholder={configured?'Enter a new token to rotate':'Paste Hostinger Mail API token'} className="crm-settings-input" /></label>
    <div className="crm-mail-admin-actions"><button type="button" disabled={busy||!token.trim()} onClick={()=>void run('save')} className="crm-mail-primary">{busy?'Saving…':configured?'Save new token':'Save and validate token'}</button><button type="button" disabled={busy} onClick={()=>void run('test')} className="crm-mail-secondary"><RefreshCw size={14}/>{busy?'Working…':'Test connection'}</button>{configured&&<button type="button" disabled={busy} onClick={()=>void run('remove')} className="crm-mail-danger"><Trash2 size={14}/>Remove configuration</button>}</div>
  </section>;
}

export function ClientEmailAccounts({ client, clients = [] }) {
  const clientId = String(client?.id || '');
  const [assignments, setAssignments] = useState([]);
  const [providerMailboxes, setProviderMailboxes] = useState([]);
  const [selectedResource, setSelectedResource] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [editingId, setEditingId] = useState('');
  const [editingName, setEditingName] = useState('');
  const [transferTarget, setTransferTarget] = useState({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const refresh = async () => {
    setError('');
    try { const [assigned, all] = await Promise.all([getClientMailboxesAdmin(clientId), listHostingerMailboxesAdmin()]); setAssignments(assigned); setProviderMailboxes(all); }
    catch (e) { setError(e.message || 'Could not load client email accounts.'); }
  };
  useEffect(() => { if (clientId) void refresh(); }, [clientId]);
  const available = providerMailboxes.filter(m => !m.assignedClientId || String(m.assignedClientId) === clientId);
  const add = async e => {
    e.preventDefault(); if (!selectedResource) return;
    setBusy(true); setError(''); setNotice('');
    try { await assignClientMailboxAdmin(clientId, { providerMailboxId: selectedResource, displayName: displayName.trim() || (providerMailboxes.find(m=>m.resourceId===selectedResource)?.address || ''), enabled: true }); setSelectedResource(''); setDisplayName(''); await refresh(); setNotice('Mailbox access assigned. No Hostinger mailbox was created.'); }
    catch (err) { setError(err.message || 'Could not assign mailbox.'); }
    finally { setBusy(false); }
  };
  const update = async (a, patch) => { setBusy(true); setError(''); try { await updateClientMailboxAdmin(clientId, a.id, patch); await refresh(); return true; } catch(e) { setError(e.message || 'Could not update mailbox access.'); return false; } finally { setBusy(false); } };
  const saveDisplayName = async a => {
    const nextName = editingName.trim();
    if (!nextName || nextName.length > 191) { setError('Enter a display name of 1 to 191 characters.'); return; }
    if (await update(a, { displayName: nextName })) {
      setEditingId('');
      setNotice('Mailbox display name updated.');
    }
  };
  const remove = async a => { if (!window.confirm(`Remove ${a.emailAddress} access from ${client.name || client.company || 'this client'}? This removes only the CRM assignment, not the Hostinger mailbox.`)) return; setBusy(true); setError(''); try { await removeClientMailboxAdmin(clientId,a.id); await refresh(); setNotice('Client mailbox access removed. The Hostinger mailbox was not deleted.'); } catch(e) { setError(e.message || 'Could not remove access.'); } finally { setBusy(false); } };
  const transfer = async a => {
    const target = transferTarget[a.id];
    const clientName = clients.find(c=>String(c.id)===String(target))?.name || clients.find(c=>String(c.id)===String(target))?.company || target;
    if (!target || !window.confirm(`Transfer ${a.emailAddress} to ${clientName}? ${client.name || client.company} will immediately lose access. This moves the CRM assignment only; it does not create or delete a Hostinger mailbox.`)) return;
    setBusy(true); setError('');
    try { await reassignClientMailboxAdmin(a.id,target,a.displayName); await refresh(); setTransferTarget(t=>({...t,[a.id]:''})); setNotice(`Mailbox access transferred to ${clientName}.`); }
    catch(e) { setError(e.message || 'Could not transfer mailbox access.'); }
    finally { setBusy(false); }
  };
  return <section className="crm-email-accounts" aria-label="Client email accounts">
    <div className="crm-email-accounts-head"><div><div className="crm-email-eyebrow"><UserRound size={13}/> Super Admin · Client access</div><h3>Email Accounts</h3><p>Assign existing Hostinger mailboxes to {client.name || client.company || 'this client'}.</p></div><button type="button" onClick={()=>void refresh()} disabled={busy} className="crm-mail-icon" aria-label="Refresh mailbox assignments"><RefreshCw size={15}/></button></div>
    {error&&<div role="alert" className="crm-mail-admin-alert error"><AlertCircle size={15}/>{error}</div>}{notice&&<div role="status" className="crm-mail-admin-alert success"><CheckCircle2 size={15}/>{notice}</div>}
    {assignments.length ? <div className="crm-email-account-list">{assignments.map(a=><div className="crm-email-assignment" key={a.id}>
      <div className="crm-email-ident">
        <div className="crm-email-icon"><Mail size={16}/></div>
        <div className="crm-email-info">
          {editingId === a.id
            ? <div className="flex flex-wrap items-center gap-1"><input aria-label={`Display name for ${a.emailAddress}`} autoFocus maxLength={191} value={editingName} onChange={e=>setEditingName(e.target.value)} className="crm-settings-input" disabled={busy}/><button type="button" onClick={()=>void saveDisplayName(a)} disabled={busy} className="crm-mail-secondary">Save</button><button type="button" aria-label="Cancel display name edit" onClick={()=>setEditingId('')} disabled={busy} className="crm-mail-icon"><X size={14}/></button></div>
            : <div className="flex items-center gap-2"><strong>{a.displayName || a.emailAddress}</strong><button type="button" aria-label={`Edit display name for ${a.emailAddress}`} title="Edit display name" disabled={busy} onClick={()=>{setEditingId(a.id);setEditingName(a.displayName || a.emailAddress);setError('');setNotice('');}} className="crm-mail-icon"><Pencil size={13}/></button></div>}
          <span>{a.emailAddress}</span>
        </div>
        <span className={`crm-email-state ${a.enabled?'enabled':'disabled'}`}>{a.enabled?'Enabled':'Disabled'}</span>
      </div>
      <div className="crm-email-assignment-actions"><label><input type="checkbox" checked={Boolean(a.enabled)} disabled={busy} onChange={e=>void update(a,{enabled:e.target.checked})}/> Portal access</label><select value={transferTarget[a.id] || ''} disabled={busy} onChange={e=>setTransferTarget(t=>({...t,[a.id]:e.target.value}))}><option value="">Transfer to client…</option>{clients.filter(c=>String(c.id)!==clientId).map(c=><option key={c.id} value={c.id}>{c.name || c.company || c.id}</option>)}</select><button type="button" disabled={busy||!transferTarget[a.id]} onClick={()=>void transfer(a)} className="crm-mail-secondary">Transfer</button><button type="button" disabled={busy} onClick={()=>void remove(a)} className="crm-mail-danger"><Trash2 size={13}/>Remove access</button></div>
    </div>)}</div> : <div className="crm-email-empty"><Mail size={21}/><strong>No mailbox access assigned</strong><span>Assigning access never creates or deletes a mailbox with Hostinger.</span></div>}
    <form onSubmit={add} className="crm-email-assign-form"><div className="crm-email-form-title"><KeyRound size={15}/> Assign an existing mailbox</div><div className="crm-email-form-grid"><label className="crm-settings-field"><span>Available mailbox</span><select required value={selectedResource} onChange={e=>setSelectedResource(e.target.value)} className="crm-settings-select"><option value="">Choose mailbox</option>{available.map(m=><option key={m.resourceId} value={m.resourceId}>{m.address}{m.assignedClientId===clientId?' (already assigned)':''}</option>)}</select></label><label className="crm-settings-field"><span>Display name</span><input value={displayName} onChange={e=>setDisplayName(e.target.value)} placeholder="e.g. Project team" className="crm-settings-input"/></label><button type="submit" disabled={busy||!selectedResource} className="crm-mail-primary">{busy?'Saving…':'Assign mailbox'}</button></div><p>Mailbox provisioning and billing remain managed in Hostinger. This controls portal access only.</p></form>
  </section>;
}
const relative = value => {
  if (!value) return 'Never';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Never';
  const minutes = Math.round((Date.now() - date.getTime()) / 60000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 1440) return `${Math.round(minutes / 60)} h ago`;
  return date.toLocaleDateString();
};
const bytes = value => {
  if (!value) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)));
  return `${(value / 1024 ** index).toFixed(index > 1 ? 1 : 0)} ${units[index]}`;
};
const clientLabel = c => c ? (c.company || c.clientCompany || c.name || c.clientName || c.email || c.id || c.clientId) : '';

function MailboxStats({ resourceId }) {
  const [stats, setStats] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    getHostingerMailboxStatsAdmin(resourceId).then(d => { if (active) setStats(d); }).catch(e => { if (active) setError(e.message || 'Could not load mailbox statistics.'); });
    return () => { active = false; };
  }, [resourceId]);
  if (error) return <div className="crm-mail-monitor-stats"><span className="crm-mail-monitor-muted">{error}</span></div>;
  if (!stats) return <div className="crm-mail-monitor-stats"><span className="crm-mail-monitor-muted">Loading live statistics from Hostinger…</span></div>;
  const cell = (label, folder) => <div><span>{label}</span><strong>{folder ? folder.messageCount : '—'}</strong>{folder?.unreadCount ? <em>{folder.unreadCount} unread</em> : null}</div>;
  return <div className="crm-mail-monitor-stats">
    {cell('Inbox', stats.folders?.inbox)}{cell('Sent', stats.folders?.sent)}{cell('Spam', stats.folders?.junk)}{cell('Trash', stats.folders?.trash)}
    <div><span>Storage</span><strong>{stats.quota?.supported && stats.quota.totalLimit ? `${stats.quota.totalPercentage}%` : '—'}</strong>{stats.quota?.supported && stats.quota.totalLimit ? <em>{bytes(stats.quota.totalUsage)} of {bytes(stats.quota.totalLimit)}</em> : null}</div>
    <p className="crm-mail-monitor-muted">Counts only. Message content is never shown to administrators.</p>
  </div>;
}

export function HostingerMailboxMonitor({ refreshKey = 0 }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [assigning, setAssigning] = useState({});
  const [expanded, setExpanded] = useState('');

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try { setData(await getHostingerMailOverviewAdmin()); }
    catch (e) { setError(e.message || 'Could not load connected mailboxes.'); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load, refreshKey]);
  useEffect(() => { if (!notice) return undefined; const t = setTimeout(() => setNotice(''), 5000); return () => clearTimeout(t); }, [notice]);

  const mailboxes = useMemo(() => data?.mailboxes || [], [data]);
  const clients = data?.clients || [];
  const configured = Boolean(data?.integration?.configured);
  const summary = useMemo(() => ({
    total: mailboxes.filter(m => m.inHostinger !== false).length,
    assigned: mailboxes.filter(m => m.assignment).length,
    enabled: mailboxes.filter(m => m.assignment?.enabled).length,
    unassigned: mailboxes.filter(m => !m.assignment && m.inHostinger !== false).length,
    attention: mailboxes.filter(m => m.inHostinger === false || (m.assignment && (!m.assignment.enabled || !m.assignment.portalActive))).length,
  }), [mailboxes]);
  const visible = mailboxes.filter(m => {
    const text = `${m.address} ${m.resourceId} ${clientLabel(m.assignment)} ${m.assignment?.clientEmail || ''} ${m.assignment?.displayName || ''}`.toLowerCase();
    if (query.trim() && !text.includes(query.trim().toLowerCase())) return false;
    if (filter === 'assigned') return Boolean(m.assignment);
    if (filter === 'unassigned') return !m.assignment && m.inHostinger !== false;
    if (filter === 'attention') return m.inHostinger === false || (m.assignment && (!m.assignment.enabled || !m.assignment.portalActive));
    return true;
  });

  const act = async (key, fn, success) => {
    setBusy(key); setError(''); setNotice('');
    try { await fn(); setNotice(success); await load(); }
    catch (e) { setError(e.message || 'The request failed.'); }
    finally { setBusy(''); }
  };
  const assign = m => {
    const form = assigning[m.resourceId] || {};
    if (!form.clientId) return;
    const target = clients.find(c => c.id === form.clientId);
    const displayName = (form.displayName || '').trim() || m.address;
    return act(m.resourceId, async () => {
      if (m.assignment) await reassignClientMailboxAdmin(m.assignment.id, form.clientId, displayName);
      else await assignClientMailboxAdmin(form.clientId, { providerMailboxId: m.resourceId, displayName, enabled: true });
      setAssigning(a => ({ ...a, [m.resourceId]: undefined }));
    }, `${m.address} ${m.assignment ? 'transferred' : 'assigned'} to ${clientLabel(target)}.`);
  };
  const toggle = m => act(m.resourceId, () => updateClientMailboxAdmin(m.assignment.clientId, m.assignment.id, { enabled: !m.assignment.enabled }), `Portal access ${m.assignment.enabled ? 'paused' : 'enabled'} for ${m.address}.`);
  const unassign = m => {
    if (!window.confirm(`Remove ${clientLabel(m.assignment)}'s access to ${m.address}? The Hostinger mailbox and its email are not deleted.`)) return;
    return act(m.resourceId, () => removeClientMailboxAdmin(m.assignment.clientId, m.assignment.id), `Access to ${m.address} removed. The Hostinger mailbox was not changed.`);
  };

  const status = m => {
    if (m.inHostinger === false) return ['danger', 'Missing in Hostinger'];
    if (!m.assignment) return ['idle', 'Unassigned'];
    if (!m.assignment.enabled) return ['warn', 'Access paused'];
    if (!m.assignment.portalActive) return ['warn', 'Client portal inactive'];
    return ['ok', 'Live in portal'];
  };

  return <section className="crm-settings-panel crm-mail-monitor" aria-label="Connected mailboxes">
    <div className="crm-settings-section-head">
      <div><h3><Link2 size={17}/> Mailboxes &amp; client assignments</h3><p>Every mailbox you created in Hostinger, which client portal account uses it, and whether it is live. Clients use their mailboxes to email anyone in their business; you only distribute and monitor access.</p></div>
      <button type="button" onClick={() => void load()} disabled={loading} className="crm-mail-secondary" aria-label="Refresh connected mailboxes"><RefreshCw size={14} className={loading ? 'crm-spin' : ''}/>{loading ? 'Syncing…' : 'Sync with Hostinger'}</button>
    </div>
    {error && <div role="alert" className="crm-mail-admin-alert error"><AlertCircle size={16}/>{error}</div>}
    {data?.providerError && <div role="alert" className="crm-mail-admin-alert error"><AlertCircle size={16}/>Hostinger could not be reached: {data.providerError}. Showing saved assignments only.</div>}
    {notice && <div role="status" className="crm-mail-admin-alert success"><CheckCircle2 size={16}/>{notice}</div>}
    <div className="crm-mail-admin-status">
      <div><span>Hostinger mailboxes</span><strong>{data ? summary.total : '—'}</strong></div>
      <div><span>Assigned to clients</span><strong>{data ? summary.assigned : '—'}</strong></div>
      <div><span>Live in portal</span><strong>{data ? summary.enabled : '—'}</strong></div>
      <div><span>Unassigned</span><strong>{data ? summary.unassigned : '—'}</strong></div>
      <div><span>Need attention</span><strong className={summary.attention ? 'crm-mail-monitor-warn-text' : ''}>{data ? summary.attention : '—'}</strong></div>
    </div>
    {!loading && data && !configured && !mailboxes.length ? <div className="crm-email-empty"><KeyRound size={21}/><strong>Connect the Hostinger Mail API first</strong><span>Save your Hostinger Mail API token above. Mailboxes you create in Hostinger will then appear here, ready to assign to client portal accounts.</span></div> : <>
      <div className="crm-mail-monitor-toolbar">
        <label className="crm-mail-monitor-search"><Search size={14}/><input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search mailbox, client or resource ID" aria-label="Search mailboxes"/></label>
        <div className="crm-mail-monitor-filters" role="tablist" aria-label="Filter mailboxes">
          {[['all', 'All'], ['assigned', 'Assigned'], ['unassigned', 'Unassigned'], ['attention', 'Needs attention']].map(([key, label]) => <button key={key} type="button" role="tab" aria-selected={filter === key} className={filter === key ? 'active' : ''} onClick={() => setFilter(key)}>{label}</button>)}
        </div>
      </div>
      {loading && !data ? <div className="crm-email-empty"><RefreshCw size={21} className="crm-spin"/><strong>Loading mailboxes from Hostinger…</strong></div>
        : !visible.length ? <div className="crm-email-empty"><Mail size={21}/><strong>{mailboxes.length ? 'No mailboxes match this view' : 'No mailboxes found in Hostinger'}</strong><span>{mailboxes.length ? 'Try another search or filter.' : 'Create a mailbox in your Hostinger panel, then sync to see it here.'}</span></div>
        : <div className="crm-mail-monitor-list">{visible.map(m => {
          const [tone, label] = status(m);
          const form = assigning[m.resourceId];
          const rowBusy = busy === m.resourceId;
          return <div key={m.resourceId} className="crm-mail-monitor-row">
            <div className="crm-mail-monitor-main">
              <div className="crm-mail-monitor-mailbox"><div className="crm-email-icon"><Mail size={16}/></div><div><strong>{m.address || 'Unknown address'}</strong><span>{m.resourceId}{m.assignment?.displayName && m.assignment.displayName !== m.address ? ` · “${m.assignment.displayName}”` : ''}</span></div></div>
              <div className="crm-mail-monitor-client">{m.assignment ? <><UserRound size={14}/><div><strong>{clientLabel(m.assignment)}</strong><span>{m.assignment.clientEmail || m.assignment.clientName}</span></div></> : <span className="crm-mail-monitor-muted">Not assigned to a client</span>}</div>
              <div className="crm-mail-monitor-activity">{m.assignment ? <><span><Activity size={12}/> Opened {relative(m.activity?.lastOpenedAt)}</span><span>Sent {m.activity?.sentLast30Days || 0} in 30 days</span></> : <span className="crm-mail-monitor-muted">—</span>}</div>
              <span className={`crm-mail-monitor-pill ${tone}`}>{label}</span>
            </div>
            <div className="crm-mail-monitor-actions">
              {m.inHostinger !== false && <button type="button" disabled={rowBusy} className="crm-mail-primary" onClick={() => setAssigning(a => ({ ...a, [m.resourceId]: form ? undefined : { clientId: '', displayName: m.assignment?.displayName || '' } }))}>{form ? 'Cancel' : m.assignment ? 'Transfer' : 'Assign to client'}</button>}
              {m.assignment && <label className="crm-mail-monitor-toggle"><input type="checkbox" checked={m.assignment.enabled} disabled={rowBusy} onChange={() => void toggle(m)}/> Portal access</label>}
              {m.inHostinger !== false && <button type="button" className="crm-mail-secondary" onClick={() => setExpanded(e => e === m.resourceId ? '' : m.resourceId)}><BarChart3 size={13}/>{expanded === m.resourceId ? 'Hide stats' : 'Stats'}</button>}
              {m.assignment && <button type="button" disabled={rowBusy} className="crm-mail-danger" onClick={() => void unassign(m)}><Trash2 size={13}/>Remove access</button>}
            </div>
            {form && <div className="crm-mail-monitor-assign">
              <label className="crm-settings-field"><span>{m.assignment ? 'Transfer to client' : 'Client portal account'}</span><select value={form.clientId} onChange={e => setAssigning(a => ({ ...a, [m.resourceId]: { ...form, clientId: e.target.value } }))} className="crm-settings-select"><option value="">Choose client…</option>{clients.filter(c => c.id !== m.assignment?.clientId).map(c => <option key={c.id} value={c.id}>{clientLabel(c)}{c.email ? ` — ${c.email}` : ''}{c.portalActive ? '' : ' (portal inactive)'}</option>)}</select></label>
              <label className="crm-settings-field"><span>Display name (shown as sender)</span><input value={form.displayName} onChange={e => setAssigning(a => ({ ...a, [m.resourceId]: { ...form, displayName: e.target.value } }))} placeholder={m.address} maxLength={191} className="crm-settings-input"/></label>
              <button type="button" disabled={rowBusy || !form.clientId} onClick={() => void assign(m)} className="crm-mail-primary">{rowBusy ? 'Saving…' : m.assignment ? 'Transfer mailbox' : 'Assign mailbox'}</button>
              {m.assignment && <p className="crm-mail-monitor-muted">Transferring moves portal access to the new client. Saved Codex drafts and blocked senders of the previous client are removed; email in Hostinger is untouched.</p>}
            </div>}
            {expanded === m.resourceId && <MailboxStats resourceId={m.resourceId}/>}
          </div>;
        })}</div>}
    </>}
  </section>;
}

export function HostingerMailWorkspace() {
  const [refreshKey, setRefreshKey] = useState(0);
  return <div className="crm-mail-workspace">
    <HostingerMailSettings onChanged={() => setRefreshKey(k => k + 1)}/>
    <HostingerMailboxMonitor refreshKey={refreshKey}/>
  </div>;
}
