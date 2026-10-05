import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle, Archive, ArrowLeft, Ban, CheckCircle2, ChevronLeft, ChevronRight, Download, Eye, FileText, FolderInput,
  Forward, HardDrive, Inbox, Layers, Mail, MailOpen, Menu, Paperclip, PenLine, RefreshCw, Reply, ReplyAll, RotateCcw,
  Search, Send, ShieldAlert, ShieldCheck, Star, Trash2, Users, X,
} from 'lucide-react';
import type { PortalClient } from '../../services/portalDatabase';
import {
  MailRequestError, blockPortalSender, bulkPortalMailAction, deletePortalMailDraft, downloadPortalMailAttachment,
  emptyPortalMailFolder, getPortalMailFolders, getPortalMailMessage, getPortalMailQuota, getPortalMailboxes,
  getPortalStarredMessages, listPortalBlockedSenders, listPortalMailDrafts, listPortalMailMessages, savePortalMailDraft,
  searchPortalMailMessages, sendPortalMail, sendPortalMailIndividually, setPortalMessageFlags, unblockPortalSender,
  type BlockedSender, type ClientMailbox, type Draft, type Folder, type MailAttachment, type MailMessage, type MailQuota,
} from '../hostingerMailApi';

interface PortalMailProps { client: PortalClient; onNavigate: (path: string) => void }
type ServiceState = 'loading' | 'ready' | 'unconfigured' | 'unassigned' | 'error';
type ViewKind = 'folder' | 'starred' | 'drafts' | 'unified';
interface View { kind: ViewKind; path?: string }
type Row = MailMessage & { mailboxId: string };
type FolderRole = 'inbox' | 'sent' | 'drafts' | 'junk' | 'trash' | 'archive';
type MailAction = 'read' | 'unread' | 'star' | 'unstar' | 'archive' | 'spam' | 'notspam' | 'trash' | 'restore' | 'deleteForever' | 'move';
interface ComposerState { mailboxId: string; draftMailboxId: string; draft: Draft; individually: boolean; showCc: boolean; version: number; dirty: boolean }

const PAGE_SIZE = 25;
const SYNC_INTERVAL_MS = 60_000;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PREVIEWABLE = /^(image\/(png|jpe?g|gif|webp)|application\/pdf|text\/plain)$/i;
const blockedAttachmentFilename = /\.(php|phtml|phar|exe|dll|bat|cmd|com|msi|sh|ps1|js|cjs|mjs|vbs|vbe|jse|wsf|wsh|hta|scr|jar|html|htm|mhtml|xhtml|svg|lnk|url|reg)$/i;
const ROLE_RULES: Record<FolderRole, [string, RegExp]> = {
  inbox: ['\\inbox', /^inbox$/i],
  sent: ['\\sent', /^sent/i],
  drafts: ['\\drafts', /draft/i],
  junk: ['\\junk', /spam|junk/i],
  trash: ['\\trash', /trash|deleted/i],
  archive: ['\\archive', /archive/i],
};
const ROLES = Object.keys(ROLE_RULES) as FolderRole[];
const emptyDraft = (): Draft => ({ to: [], cc: [], bcc: [], subject: '', text: '', attachments: [] });

const findRole = (folders: Folder[], role: FolderRole) => {
  const [use, pattern] = ROLE_RULES[role];
  return folders.find(f => f.specialUse?.toLowerCase() === use) || folders.find(f => pattern.test(f.name));
};
const roleOf = (folders: Folder[], path?: string): FolderRole | null => (path ? ROLES.find(role => findRole(folders, role)?.path === path) || null : null);
const rowKey = (row: Row) => `${row.mailboxId}|${row.path}|${row.uid}`;
const errorText = (e: unknown, fallback: string) => (e instanceof Error && e.message ? e.message : fallback);
const addressLabel = (a?: { address: string; name: string } | null) => (a ? (a.name ? `${a.name} <${a.address}>` : a.address) : 'Unknown sender');
const shortName = (a?: { address: string; name: string } | null) => (a ? a.name || a.address : 'Unknown sender');
const fullDate = (value: string) => { const d = new Date(value); return Number.isNaN(d.getTime()) ? value : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }); };
const listDate = (value: string) => {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  if (d.getFullYear() === now.getFullYear()) return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
};
const formatBytes = (bytes: number) => {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** index).toFixed(index > 1 ? 1 : 0)} ${units[index]}`;
};
const uniqueAddresses = (addresses: string[]) => [...new Map(addresses.filter(Boolean).map(address => [address.toLowerCase(), address])).values()];
const blobToBase64 = async (blob: Blob) => {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(binary);
};
const escapeHtml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const escapeComposeText = (text: string) => escapeHtml(text).replace(/\r?\n/g, '<br>');
const sanitizeComposeHtml = (html: string) => {
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  const allowed = new Set(['b', 'strong', 'i', 'em', 'u', 's', 'strike', 'p', 'div', 'br', 'ul', 'ol', 'li', 'blockquote', 'pre', 'code']);
  const escapeText = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const serialize = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) return escapeText(node.textContent || '');
    if (node.nodeType !== Node.ELEMENT_NODE) return '';
    const element = node as Element;
    const tag = element.tagName.toLowerCase();
    const children = Array.from(element.childNodes, serialize).join('');
    if (!allowed.has(tag)) return children;
    if (tag === 'br') return '<br>';
    return `<${tag}>${children}</${tag}>`;
  };
  return Array.from(parsed.body.childNodes, serialize).join('');
};
const safeMailHtml = (html: string) => {
  // Render untrusted markup in an isolated document: no scripts, frames, forms, external requests or plugins.
  const clean = html.replace(/<\s*(script|iframe|frame|object|embed|form|meta|link|base)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
    .replace(/<\s*(script|iframe|frame|object|embed|form|meta|link|base)\b[^>]*\/?>/gi, '')
    .replace(/\s(on[a-z]+|src|srcset|action|formaction)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/url\s*\([^)]*\)/gi, 'none').replace(/javascript:/gi, '');
  return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'none'; style-src 'unsafe-inline'; font-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'"><meta name="viewport" content="width=device-width, initial-scale=1"><style>body{font:14px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#1D1D1F;margin:0;padding:4px;overflow-wrap:anywhere}a{color:#0071E3;text-decoration:underline}blockquote{margin:8px 0;padding-left:12px;border-left:3px solid #d2d2d7;color:#6e6e73}</style></head><body>${clean}</body></html>`;
};
const quoteOriginal = (row: Row, body: { text: string; html: string }) => {
  const original = body.text.trim() || (body.html ? new DOMParser().parseFromString(body.html, 'text/html').body.textContent || '' : '');
  const header = `On ${fullDate(row.date)}, ${addressLabel(row.from)} wrote:`;
  return {
    text: `\n\n${header}\n${original.split(/\r?\n/).map(line => `> ${line}`).join('\n')}`,
    html: `<p><br></p><p>${escapeHtml(header)}</p><blockquote>${escapeComposeText(original)}</blockquote>`,
  };
};

const panel = 'border border-black/[0.08] bg-white dark:border-white/[0.08] dark:bg-[#1C1C1E]';
const muted = 'text-[#6E6E73] dark:text-[#98989D]';
const strong = 'text-[#1D1D1F] dark:text-[#F5F5F7]';
const hoverRow = 'hover:bg-black/[0.035] dark:hover:bg-white/[0.06]';
const iconButton = `inline-flex size-8 shrink-0 items-center justify-center rounded-lg ${muted} ${hoverRow} hover:text-[#1D1D1F] dark:hover:text-white disabled:cursor-not-allowed disabled:opacity-40`;
const secondaryButton = `inline-flex items-center gap-1.5 rounded-lg border border-black/[0.1] bg-white px-3 py-1.5 text-xs font-semibold ${strong} hover:bg-black/[0.03] disabled:cursor-not-allowed disabled:opacity-40 dark:border-white/[0.12] dark:bg-[#2C2C2E] dark:hover:bg-[#3A3A3C]`;
const primaryButton = 'inline-flex items-center gap-1.5 rounded-lg bg-[#0071E3] px-3.5 py-2 text-xs font-semibold text-white hover:bg-[#0062C3] disabled:cursor-not-allowed disabled:opacity-50';

function Checkbox({ checked, indeterminate = false, onChange, label, disabled }: { checked: boolean; indeterminate?: boolean; onChange: (checked: boolean) => void; label: string; disabled?: boolean }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { if (ref.current) ref.current.indeterminate = indeterminate; }, [indeterminate]);
  return <input ref={ref} type="checkbox" aria-label={label} checked={checked} disabled={disabled} onClick={e => e.stopPropagation()} onChange={e => onChange(e.target.checked)} className="size-4 shrink-0 cursor-pointer rounded border-black/20 accent-[#0071E3] disabled:cursor-not-allowed" />;
}

function RecipientField({ label, values, onChange, autoFocus }: { label: string; values: string[]; onChange: (values: string[]) => void; autoFocus?: boolean }) {
  const [text, setText] = useState('');
  const commit = (raw: string) => {
    const parts = raw.split(/[,;\s]+/).map(v => v.trim().replace(/^<|>$/g, '')).filter(Boolean);
    if (parts.length) onChange(uniqueAddresses([...values, ...parts]));
    setText('');
  };
  return <label className="flex min-h-[42px] flex-wrap items-center gap-1.5 border-b border-black/[0.06] py-1.5 dark:border-white/[0.08]">
    <span className={`w-10 shrink-0 text-xs ${muted}`}>{label}</span>
    {values.map(address => <span key={address} className={`inline-flex max-w-full items-center gap-1 rounded-full px-2.5 py-0.5 text-xs ${EMAIL_PATTERN.test(address) ? 'bg-[#0071E3]/10 text-[#0058B0] dark:text-[#64B5FF]' : 'bg-[#FF3B30]/10 text-[#C9251B]'}`}>
      <span className="truncate">{address}</span>
      <button type="button" aria-label={`Remove ${address}`} onClick={() => onChange(values.filter(v => v !== address))} className="rounded-full hover:opacity-70"><X size={11} /></button>
    </span>)}
    <input
      aria-label={`${label} recipients`}
      autoFocus={autoFocus}
      value={text}
      onChange={e => { const value = e.target.value; if (/[,;]/.test(value)) commit(value); else setText(value); }}
      onKeyDown={e => {
        if ((e.key === 'Enter' || e.key === 'Tab') && text.trim()) { e.preventDefault(); commit(text); }
        if (e.key === 'Backspace' && !text && values.length) onChange(values.slice(0, -1));
      }}
      onBlur={() => { if (text.trim()) commit(text); }}
      onPaste={e => { const pasted = e.clipboardData.getData('text'); if (/[,;\s]/.test(pasted.trim())) { e.preventDefault(); commit(text + pasted); } }}
      placeholder={values.length ? '' : 'name@company.com'}
      className={`min-w-[140px] flex-1 bg-transparent py-1 text-sm outline-none placeholder:text-[#AEAEB2] ${strong}`}
    />
  </label>;
}

export function PortalMail({ client }: PortalMailProps) {
  const [service, setService] = useState<ServiceState>('loading');
  const [mailboxes, setMailboxes] = useState<ClientMailbox[]>([]);
  const [resourceId, setResourceId] = useState('');
  const [folderMap, setFolderMap] = useState<Record<string, Folder[]>>({});
  const [view, setView] = useState<View>({ kind: 'folder', path: '' });
  const [rows, setRows] = useState<Row[]>([]);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [checked, setChecked] = useState<Set<string>>(() => new Set());
  const [checkedDrafts, setCheckedDrafts] = useState<Set<string>>(() => new Set());
  const [selected, setSelected] = useState<Row | null>(null);
  const [body, setBody] = useState({ text: '', html: '' });
  const [bodyLoading, setBodyLoading] = useState(false);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal] = useState(0);
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  const [loadingList, setLoadingList] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [quota, setQuota] = useState<MailQuota | null>(null);
  const [blockedMap, setBlockedMap] = useState<Record<string, BlockedSender[]>>({});
  const [blockedOpen, setBlockedOpen] = useState(false);
  const [preview, setPreview] = useState<{ name: string; type: string; url?: string; text?: string } | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [mobileReader, setMobileReader] = useState(false);
  const [moveTarget, setMoveTarget] = useState('');
  const [lastSynced, setLastSynced] = useState<Date | null>(null);
  const [composer, setComposer] = useState<ComposerState | null>(null);
  const listRequest = useRef(0);
  const messageRequest = useRef(0);
  const folderMapRef = useRef(folderMap);
  const mailboxesRef = useRef(mailboxes);
  const editorRef = useRef<HTMLDivElement>(null);
  folderMapRef.current = folderMap;
  mailboxesRef.current = mailboxes;

  const folders = useMemo(() => folderMap[resourceId] || [], [folderMap, resourceId]);
  const mailbox = mailboxes.find(m => m.providerMailboxId === resourceId);
  const currentRole = view.kind === 'folder' ? roleOf(folders, view.path) : null;
  const blocked = blockedMap[resourceId] || [];
  const ready = service === 'ready';

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(''), 5000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const loadFolders = useCallback(async (id: string) => {
    const list = await getPortalMailFolders(id);
    setFolderMap(map => ({ ...map, [id]: list }));
    return list;
  }, []);

  const loadBlocked = useCallback(async (id: string) => {
    const list = await listPortalBlockedSenders(id);
    setBlockedMap(map => ({ ...map, [id]: list }));
    return list;
  }, []);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const list = (await getPortalMailboxes()).filter(m => m.enabled);
        if (!active) return;
        setMailboxes(list);
        if (!list.length) { setService('unassigned'); return; }
        const first = list[0].providerMailboxId;
        setResourceId(first);
        const results = await Promise.allSettled(list.map(m => loadFolders(m.providerMailboxId)));
        if (!active) return;
        const firstFolders = results[0].status === 'fulfilled' ? results[0].value : [];
        if (results[0].status === 'rejected') setError(errorText(results[0].reason, 'Could not open this mailbox.'));
        setView({ kind: 'folder', path: findRole(firstFolders, 'inbox')?.path || firstFolders[0]?.path || 'INBOX' });
        setService('ready');
        setLastSynced(new Date());
      } catch (e) {
        if (!active) return;
        if (e instanceof MailRequestError && e.status === 409) { setService('unconfigured'); return; }
        setService('error');
        setError(errorText(e, 'Could not load your mailboxes.'));
      }
    })();
    return () => { active = false; };
  }, [loadFolders]);

  useEffect(() => {
    if (!ready || !resourceId) return;
    let active = true;
    Promise.allSettled([listPortalMailDrafts(resourceId), getPortalMailQuota(resourceId), loadBlocked(resourceId)]).then(([nextDrafts, nextQuota]) => {
      if (!active) return;
      setDrafts(nextDrafts.status === 'fulfilled' ? nextDrafts.value : []);
      setQuota(nextQuota.status === 'fulfilled' ? nextQuota.value : null);
    });
    return () => { active = false; };
  }, [ready, resourceId, loadBlocked]);

  useEffect(() => {
    const id = selected?.mailboxId;
    if (id && !blockedMap[id]) void loadBlocked(id).catch(() => undefined);
  }, [selected?.mailboxId, blockedMap, loadBlocked]);

  const fetchList = useCallback(async (silent = false) => {
    if (!ready || !resourceId) return;
    const requestId = ++listRequest.current;
    if (!silent) setLoadingList(true);
    try {
      let next: Row[] = [];
      let pages = 1;
      let count = 0;
      if (view.kind === 'drafts') {
        const list = await listPortalMailDrafts(resourceId);
        if (requestId !== listRequest.current) return;
        setDrafts(list);
        count = list.length;
      } else if (view.kind === 'unified') {
        const results = await Promise.all(mailboxesRef.current.map(async m => {
          const id = m.providerMailboxId;
          const list = folderMapRef.current[id] || await loadFolders(id);
          const inbox = findRole(list, 'inbox')?.path || 'INBOX';
          const result = search ? await searchPortalMailMessages(id, inbox, search, page, PAGE_SIZE) : await listPortalMailMessages(id, inbox, page, PAGE_SIZE);
          return { rows: (result.messages || []).map(message => ({ ...message, mailboxId: id })), pagination: result.pagination };
        }));
        next = results.flatMap(r => r.rows).sort((a, b) => Date.parse(b.date) - Date.parse(a.date));
        pages = Math.max(1, ...results.map(r => r.pagination?.totalPages || 1));
        count = results.reduce((sum, r) => sum + (r.pagination?.total || 0), 0);
      } else if (view.kind === 'starred') {
        const result = await getPortalStarredMessages(resourceId, page, PAGE_SIZE);
        next = (result.messages || []).map(message => ({ ...message, mailboxId: resourceId }));
        pages = Math.max(1, result.pagination?.totalPages || 1);
        count = result.pagination?.total || next.length;
      } else if (view.path) {
        const result = search
          ? await searchPortalMailMessages(resourceId, view.path, search, page, PAGE_SIZE)
          : await listPortalMailMessages(resourceId, view.path, page, PAGE_SIZE);
        next = (result.messages || []).map(message => ({ ...message, path: message.path || view.path || '', mailboxId: resourceId }));
        pages = Math.max(1, result.pagination?.totalPages || 1);
        count = result.pagination?.total || next.length;
      }
      if (requestId !== listRequest.current) return;
      setRows(next);
      setTotalPages(pages);
      setTotal(count);
      setChecked(prev => new Set([...prev].filter(key => next.some(row => rowKey(row) === key))));
      setLastSynced(new Date());
    } catch (e) {
      if (requestId === listRequest.current && !silent) setError(errorText(e, 'Could not load messages.'));
    } finally {
      if (requestId === listRequest.current) setLoadingList(false);
    }
  }, [ready, resourceId, view, search, page, loadFolders]);

  useEffect(() => { void fetchList(); }, [fetchList]);

  const syncNow = useCallback(async (silent = false) => {
    await Promise.allSettled(mailboxesRef.current.map(m => loadFolders(m.providerMailboxId)));
    await fetchList(silent);
  }, [loadFolders, fetchList]);

  useEffect(() => {
    if (!ready) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible' && !busy) void syncNow(true);
    }, SYNC_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [ready, busy, syncNow]);

  const resetForView = () => {
    listRequest.current++;
    messageRequest.current++;
    setSelected(null);
    setBody({ text: '', html: '' });
    setChecked(new Set());
    setCheckedDrafts(new Set());
    setRows([]);
    setPage(1);
    setSearch('');
    setQuery('');
    setMobileReader(false);
    setSidebarOpen(false);
    setMoveTarget('');
  };
  const openView = (next: View, mailboxId = resourceId) => {
    resetForView();
    if (mailboxId !== resourceId) setResourceId(mailboxId);
    setView(next);
  };
  const switchMailbox = (id: string) => {
    const list = folderMap[id] || [];
    openView({ kind: 'folder', path: findRole(list, 'inbox')?.path || list[0]?.path || 'INBOX' }, id);
  };

  const openMessage = async (row: Row) => {
    const requestId = ++messageRequest.current;
    setSelected(row);
    setBody({ text: '', html: '' });
    setBodyLoading(true);
    setMobileReader(true);
    setMoveTarget('');
    try {
      const result = await getPortalMailMessage(row.mailboxId, row.path, row.uid);
      if (requestId !== messageRequest.current) return;
      setBody(result.body || { text: '', html: '' });
      const flags = [...new Set([...(result.message?.flags || row.flags), '\\Seen'])];
      const opened: Row = { ...row, ...(result.message || {}), path: row.path, mailboxId: row.mailboxId, unseen: false, flags };
      setSelected(opened);
      if (row.unseen) {
        await setPortalMessageFlags(row.mailboxId, row.path, row.uid, ['\\Seen'], []);
        setRows(list => list.map(item => (rowKey(item) === rowKey(row) ? { ...item, unseen: false, flags } : item)));
        void loadFolders(row.mailboxId).catch(() => undefined);
      }
    } catch (e) {
      if (requestId === messageRequest.current) setError(errorText(e, 'Could not open this message.'));
    } finally {
      if (requestId === messageRequest.current) setBodyLoading(false);
    }
  };

  const runAction = async (action: MailAction, targets: Row[], targetFolder?: string) => {
    if (!targets.length) return;
    const count = targets.length;
    if (action === 'deleteForever' && !window.confirm(`Permanently delete ${count} email${count === 1 ? '' : 's'}? This also removes ${count === 1 ? 'it' : 'them'} from Hostinger webmail and cannot be undone.`)) return;
    setBusy(true);
    setError('');
    let removesFromView = false;
    try {
      const groups = new Map<string, Row[]>();
      targets.forEach(row => { const key = `${row.mailboxId}\u0000${row.path}`; groups.set(key, [...(groups.get(key) || []), row]); });
      for (const group of groups.values()) {
        const { mailboxId, path } = group[0];
        const uids = group.map(row => row.uid);
        const list = folderMapRef.current[mailboxId] || [];
        const moveToRole = async (role: FolderRole, label: string) => {
          const target = findRole(list, role);
          if (!target) throw new Error(`This mailbox has no ${label} folder.`);
          if (target.path !== path) await bulkPortalMailAction(mailboxId, path, uids, { action: 'move', targetFolder: target.path });
          removesFromView = removesFromView || target.path !== path;
        };
        if (action === 'read') await bulkPortalMailAction(mailboxId, path, uids, { action: 'flags', addFlags: ['\\Seen'] });
        if (action === 'unread') await bulkPortalMailAction(mailboxId, path, uids, { action: 'flags', removeFlags: ['\\Seen'] });
        if (action === 'star') await bulkPortalMailAction(mailboxId, path, uids, { action: 'flags', addFlags: ['\\Flagged'] });
        if (action === 'unstar') await bulkPortalMailAction(mailboxId, path, uids, { action: 'flags', removeFlags: ['\\Flagged'] });
        if (action === 'archive') await moveToRole('archive', 'Archive');
        if (action === 'spam') await moveToRole('junk', 'Spam');
        if (action === 'notspam' || action === 'restore') await moveToRole('inbox', 'Inbox');
        if (action === 'move' && targetFolder) {
          await bulkPortalMailAction(mailboxId, path, uids, { action: 'move', targetFolder });
          removesFromView = true;
        }
        if (action === 'trash') {
          const trash = findRole(list, 'trash');
          if (trash && trash.path !== path) {
            await bulkPortalMailAction(mailboxId, path, uids, { action: 'move', targetFolder: trash.path });
          } else {
            if (!window.confirm('This mailbox has no separate Trash folder. Permanently delete these emails?')) return;
            await bulkPortalMailAction(mailboxId, path, uids, { action: 'delete' });
          }
          removesFromView = true;
        }
        if (action === 'deleteForever') {
          await bulkPortalMailAction(mailboxId, path, uids, { action: 'delete' });
          removesFromView = true;
        }
      }
      const label = `${count} email${count === 1 ? '' : 's'}`;
      const messages: Record<MailAction, string> = {
        read: `Marked ${label} as read.`, unread: `Marked ${label} as unread.`, star: `Starred ${label}.`, unstar: `Removed star from ${label}.`,
        archive: `Archived ${label}.`, spam: `Moved ${label} to Spam.`, notspam: `Moved ${label} back to Inbox.`, trash: `Moved ${label} to Trash.`,
        restore: `Restored ${label} to Inbox.`, deleteForever: `Permanently deleted ${label}.`, move: `Moved ${label}.`,
      };
      setNotice(messages[action]);
      setChecked(new Set());
      const keys = new Set(targets.map(rowKey));
      const flagChange: Partial<Record<MailAction, (flags: string[]) => string[]>> = {
        read: flags => [...new Set([...flags, '\\Seen'])],
        unread: flags => flags.filter(flag => flag !== '\\Seen'),
        star: flags => [...new Set([...flags, '\\Flagged'])],
        unstar: flags => flags.filter(flag => flag !== '\\Flagged'),
      };
      const change = flagChange[action];
      const removed = removesFromView || (view.kind === 'starred' && action === 'unstar');
      if (selected && keys.has(rowKey(selected))) {
        if (removed) { setSelected(null); setMobileReader(false); }
        else if (change) setSelected({ ...selected, flags: change(selected.flags), unseen: !change(selected.flags).includes('\\Seen') });
      }
      if (removed) setRows(list => list.filter(row => !keys.has(rowKey(row))));
      else if (change) setRows(list => list.map(row => (keys.has(rowKey(row)) ? { ...row, flags: change(row.flags), unseen: !change(row.flags).includes('\\Seen') } : row)));
      await syncNow(true);
    } catch (e) {
      setError(errorText(e, 'That email action could not be completed.'));
    } finally {
      setBusy(false);
    }
  };

  const emptyCurrentFolder = async () => {
    if (!view.path || (currentRole !== 'trash' && currentRole !== 'junk')) return;
    const name = currentRole === 'trash' ? 'Trash' : 'Spam';
    if (!window.confirm(`Permanently delete all ${total} email${total === 1 ? '' : 's'} in ${name}? This also empties ${name} in Hostinger webmail.`)) return;
    setBusy(true);
    setError('');
    try {
      await emptyPortalMailFolder(resourceId, view.path);
      setNotice(`${name} emptied.`);
      setSelected(null);
      setRows([]);
      await syncNow(true);
    } catch (e) { setError(errorText(e, `Could not empty ${name}.`)); }
    finally { setBusy(false); }
  };

  const blockSender = async (mailboxId: string, address: string) => {
    if (!window.confirm(`Block ${address}? Existing and future emails from this sender will be moved to Spam for this mailbox.`)) return;
    setBusy(true);
    setError('');
    try {
      const result = await blockPortalSender(mailboxId, address);
      setBlockedMap(map => ({ ...map, [mailboxId]: result.blockedSenders || [] }));
      setNotice(result.message || 'Sender blocked.');
      if (selected && (selected.from?.address || '').toLowerCase() === address.toLowerCase() && roleOf(folderMapRef.current[mailboxId] || [], selected.path) === 'inbox') {
        setSelected(null);
        setMobileReader(false);
      }
      await syncNow(true);
    } catch (e) { setError(errorText(e, 'Could not block this sender.')); }
    finally { setBusy(false); }
  };
  const unblockSender = async (mailboxId: string, address: string) => {
    setBusy(true);
    setError('');
    try {
      const result = await unblockPortalSender(mailboxId, address);
      setBlockedMap(map => ({ ...map, [mailboxId]: result.blockedSenders || [] }));
      setNotice(`${address} unblocked.`);
    } catch (e) { setError(errorText(e, 'Could not unblock this sender.')); }
    finally { setBusy(false); }
  };

  const fetchAttachment = async (row: Row, attachment: MailAttachment) => {
    const blob = await downloadPortalMailAttachment(row.mailboxId, row.path, row.uid, attachment.id);
    return new Blob([blob], { type: attachment.contentType || 'application/octet-stream' });
  };
  const downloadAttachment = async (attachment: MailAttachment) => {
    if (!selected) return;
    try {
      const blob = await fetchAttachment(selected, attachment);
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = attachment.filename || 'attachment';
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) { setError(errorText(e, 'Attachment download failed.')); }
  };
  const downloadAll = async () => {
    for (const attachment of selected?.attachments || []) await downloadAttachment(attachment);
  };
  const previewAttachment = async (attachment: MailAttachment) => {
    if (!selected) return;
    try {
      const blob = await fetchAttachment(selected, attachment);
      const name = attachment.filename || 'Attachment';
      if (/^text\/plain$/i.test(attachment.contentType)) setPreview({ name, type: attachment.contentType, text: await blob.text() });
      else setPreview({ name, type: attachment.contentType, url: URL.createObjectURL(blob) });
    } catch (e) { setError(errorText(e, 'Could not preview this attachment.')); }
  };
  const closePreview = () => {
    if (preview?.url) URL.revokeObjectURL(preview.url);
    setPreview(null);
  };

  const openComposer = (draft: Draft = emptyDraft(), mailboxId = selected?.mailboxId || resourceId, draftMailboxId = mailboxId) => {
    setComposer(current => ({
      mailboxId,
      draftMailboxId,
      draft,
      individually: false,
      showCc: Boolean(draft.cc.length || draft.bcc.length),
      version: (current?.version || 0) + 1,
      dirty: false,
    }));
  };
  const updateDraft = (patch: Partial<Draft>) => setComposer(c => (c ? { ...c, draft: { ...c.draft, ...patch }, dirty: true } : c));

  useEffect(() => {
    if (!composer || !editorRef.current) return;
    editorRef.current.innerHTML = composer.draft.html?.trim() ? sanitizeComposeHtml(composer.draft.html) : escapeComposeText(composer.draft.text);
    // Only re-seed the editor when a new compose session starts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [composer?.version]);

  const startReply = (all: boolean) => {
    if (!selected) return;
    const own = (mailboxes.find(m => m.providerMailboxId === selected.mailboxId)?.emailAddress || '').toLowerCase();
    const sentByMe = (selected.from?.address || '').toLowerCase() === own;
    const primary = sentByMe ? selected.to.map(a => a.address) : [selected.from?.address || ''];
    const to = uniqueAddresses(all ? [...primary, ...selected.to.map(a => a.address)] : primary).filter(a => a.toLowerCase() !== own || !all);
    const cc = all ? uniqueAddresses(selected.cc.map(a => a.address)).filter(a => a.toLowerCase() !== own && !to.includes(a)) : [];
    const subject = /^re:/i.test(selected.subject || '') ? selected.subject || '' : `Re: ${selected.subject || ''}`;
    const quoted = quoteOriginal(selected, body);
    openComposer({ to: to.filter(Boolean), cc, bcc: [], subject, text: quoted.text, html: quoted.html, attachments: [], inReplyTo: { folder: selected.path, uid: selected.uid } }, selected.mailboxId);
  };
  const startForward = async () => {
    if (!selected) return;
    setBusy(true);
    setError('');
    const messageText = body.text.trim() || (body.html ? new DOMParser().parseFromString(body.html, 'text/html').body.textContent || '' : '');
    const details = [
      '', '---------- Forwarded message ----------', `From: ${addressLabel(selected.from)}`, `Date: ${fullDate(selected.date)}`,
      `Subject: ${selected.subject || '(No subject)'}`, `To: ${selected.to.map(addressLabel).join(', ') || '—'}`,
      ...(selected.cc.length ? [`Cc: ${selected.cc.map(addressLabel).join(', ')}`] : []), '', messageText,
    ].join('\n');
    const attachments: Draft['attachments'] = [];
    let totalBytes = 0;
    let omitted = 0;
    try {
      for (const attachment of selected.attachments || []) {
        if (blockedAttachmentFilename.test(attachment.filename || '') || attachment.sizeBytes > 10 * 1024 * 1024 || totalBytes + attachment.sizeBytes > 20 * 1024 * 1024) { omitted++; continue; }
        try {
          const blob = await fetchAttachment(selected, attachment);
          if (blob.size > 10 * 1024 * 1024 || totalBytes + blob.size > 20 * 1024 * 1024) { omitted++; continue; }
          attachments.push({ filename: attachment.filename || 'forwarded-attachment', contentType: attachment.contentType || 'application/octet-stream', content: await blobToBase64(blob), encoding: 'base64' });
          totalBytes += blob.size;
        } catch { omitted++; }
      }
      const subject = /^fwd?:/i.test(selected.subject || '') ? selected.subject || '' : `Fwd: ${selected.subject || ''}`;
      openComposer({ to: [], cc: [], bcc: [], subject, text: details, attachments, forwardOf: { folder: selected.path, uid: selected.uid } }, selected.mailboxId);
      if (omitted) setNotice(`${omitted} original attachment${omitted === 1 ? ' was' : 's were'} left out because of attachment limits.`);
    } catch (e) { setError(errorText(e, 'Could not prepare this message for forwarding.')); }
    finally { setBusy(false); }
  };

  const saveDraft = async (closeAfter = false) => {
    if (!composer) return;
    const { mailboxId, draftMailboxId, draft } = composer;
    setBusy(true);
    setError('');
    try {
      const moving = Boolean(draft.id && draftMailboxId !== mailboxId);
      const safe = { ...draft, html: draft.html ? sanitizeComposeHtml(draft.html) : undefined };
      const saved = await savePortalMailDraft(mailboxId, moving ? { ...safe, id: undefined } : safe);
      if (moving && draft.id) await deletePortalMailDraft(draftMailboxId, draft.id).catch(() => undefined);
      if (mailboxId === resourceId || draftMailboxId === resourceId) setDrafts(await listPortalMailDrafts(resourceId));
      setNotice(`Draft saved to ${mailboxes.find(m => m.providerMailboxId === mailboxId)?.emailAddress || 'this mailbox'}.`);
      if (closeAfter) setComposer(null);
      else setComposer(c => (c ? { ...c, draft: { ...c.draft, id: saved.id, updatedAt: saved.updatedAt }, draftMailboxId: mailboxId, dirty: false } : c));
    } catch (e) { setError(errorText(e, 'Could not save draft.')); }
    finally { setBusy(false); }
  };

  const closeComposer = () => {
    if (composer?.dirty && !window.confirm('Discard this unsaved message? Use "Save draft" to keep it.')) return;
    setComposer(null);
  };

  const sendComposer = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!composer) return;
    const { draft, mailboxId, draftMailboxId, individually } = composer;
    const recipients = [...draft.to, ...draft.cc, ...draft.bcc];
    if (!recipients.length) { setError('Add at least one recipient before sending.'); return; }
    if (recipients.some(address => !EMAIL_PATTERN.test(address))) { setError('Fix the highlighted email addresses before sending.'); return; }
    if (!draft.text.trim() && !draft.html?.replace(/<[^>]*>/g, '').trim()) { setError('Write a message before sending.'); return; }
    if (individually && draft.to.length > 50) { setError('Individual sending supports up to 50 recipients at a time.'); return; }
    setBusy(true);
    setError('');
    try {
      const html = draft.html ? sanitizeComposeHtml(draft.html) : undefined;
      if (individually) {
        const result = await sendPortalMailIndividually(mailboxId, { to: draft.to, subject: draft.subject, text: draft.text, html, attachments: draft.attachments });
        setNotice(result.message || 'Emails sent.');
        if (result.failed?.length) setError(`Not sent to: ${result.failed.join(', ')}`);
      } else {
        await sendPortalMail(mailboxId, { to: draft.to, cc: draft.cc, bcc: draft.bcc, subject: draft.subject, text: draft.text, html, attachments: draft.attachments, inReplyTo: draft.inReplyTo, forwardOf: draft.forwardOf });
        setNotice(`Message sent from ${mailboxes.find(m => m.providerMailboxId === mailboxId)?.emailAddress || 'your mailbox'}.`);
      }
      if (draft.id) await deletePortalMailDraft(draftMailboxId, draft.id).catch(() => undefined);
      setComposer(null);
      if (draftMailboxId === resourceId || mailboxId === resourceId) setDrafts(await listPortalMailDrafts(resourceId).catch(() => drafts));
      await syncNow(true);
    } catch (e) { setError(errorText(e, 'Message could not be sent.')); }
    finally { setBusy(false); }
  };

  const chooseFiles = async (files: FileList | null) => {
    if (!files || !composer) return;
    const chosen = Array.from(files);
    if (chosen.some(f => f.size > 10 * 1024 * 1024)) { setError('Each attachment must be 10 MB or smaller.'); return; }
    if (chosen.some(f => blockedAttachmentFilename.test(f.name))) { setError('This file type cannot be attached.'); return; }
    const existingBytes = composer.draft.attachments.reduce((sum, a) => sum + Math.floor(a.content.length * 3 / 4), 0);
    if (existingBytes + chosen.reduce((sum, f) => sum + f.size, 0) > 20 * 1024 * 1024) { setError('The combined attachment size must be 20 MB or smaller.'); return; }
    // eslint-disable-next-line no-control-regex -- reject control characters in filenames
    if (chosen.some(f => /[\\/\u0000-\u001f\u007f]/.test(f.name) || !f.name.trim())) { setError('One or more attachment filenames are invalid.'); return; }
    const encoded = await Promise.all(chosen.map(file => new Promise<Draft['attachments'][number]>((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('Could not read attachment.'));
      reader.onload = () => resolve({ filename: file.name, contentType: file.type || 'application/octet-stream', content: String(reader.result).split(',')[1] || '', encoding: 'base64' });
      reader.readAsDataURL(file);
    })));
    setComposer(c => (c ? { ...c, draft: { ...c.draft, attachments: [...c.draft.attachments, ...encoded] }, dirty: true } : c));
  };

  const deleteDrafts = async (ids: string[]) => {
    if (!ids.length || !window.confirm(`Delete ${ids.length} draft${ids.length === 1 ? '' : 's'}?`)) return;
    setBusy(true);
    try {
      for (const id of ids) await deletePortalMailDraft(resourceId, id);
      setCheckedDrafts(new Set());
      setDrafts(await listPortalMailDrafts(resourceId));
      setNotice(`Deleted ${ids.length} draft${ids.length === 1 ? '' : 's'}.`);
    } catch (e) { setError(errorText(e, 'Could not delete drafts.')); }
    finally { setBusy(false); }
  };

  const iframeDoc = useMemo(() => safeMailHtml(body.html), [body.html]);
  const checkedRows = rows.filter(row => checked.has(rowKey(row)));
  const allChecked = view.kind === 'drafts' ? drafts.length > 0 && checkedDrafts.size === drafts.length : rows.length > 0 && checkedRows.length === rows.length;
  const someChecked = view.kind === 'drafts' ? checkedDrafts.size > 0 : checkedRows.length > 0;
  const selectedFolders = selected ? folderMap[selected.mailboxId] || [] : [];
  const selectedRole = selected ? roleOf(selectedFolders, selected.path) : null;
  const selectedSender = (selected?.from?.address || '').toLowerCase();
  const selectedOwn = (mailboxes.find(m => m.providerMailboxId === selected?.mailboxId)?.emailAddress || '').toLowerCase();
  const senderBlocked = Boolean(selectedSender && (blockedMap[selected?.mailboxId || ''] || []).some(b => b.address === selectedSender));
  const inboxUnread = (id: string) => findRole(folderMap[id] || [], 'inbox')?.unreadCount || 0;
  const totalUnread = mailboxes.reduce((sum, m) => sum + inboxUnread(m.providerMailboxId), 0);
  const roleForRows = view.kind === 'folder' ? currentRole : view.kind === 'unified' ? 'inbox' : null;
  const viewTitle = view.kind === 'unified' ? 'All inboxes' : view.kind === 'starred' ? 'Starred' : view.kind === 'drafts' ? 'Drafts' : (currentRole ? { inbox: 'Inbox', sent: 'Sent', drafts: 'Webmail drafts', junk: 'Spam', trash: 'Trash', archive: 'Archive' }[currentRole] : folders.find(f => f.path === view.path)?.name || 'Messages');
  const rangeStart = total ? (page - 1) * PAGE_SIZE + 1 : 0;
  const rangeEnd = view.kind === 'unified' ? Math.min(total, rangeStart + rows.length - 1) : Math.min(total, page * PAGE_SIZE);
  const mailboxLabel = (id: string) => mailboxes.find(m => m.providerMailboxId === id)?.emailAddress || '';

  const bulkActions = (targets: Row[]): { key: MailAction; label: string; icon: typeof Mail; danger?: boolean }[] => {
    const anyUnread = targets.some(r => r.unseen);
    const anyUnstarred = targets.some(r => !r.flags.includes('\\Flagged'));
    const role = view.kind === 'folder' ? currentRole : view.kind === 'unified' ? 'inbox' : null;
    const readAction = anyUnread ? { key: 'read' as const, label: 'Mark as read', icon: MailOpen } : { key: 'unread' as const, label: 'Mark as unread', icon: Mail };
    const starAction = anyUnstarred ? { key: 'star' as const, label: 'Star', icon: Star } : { key: 'unstar' as const, label: 'Remove star', icon: Star };
    if (role === 'trash') return [{ key: 'restore', label: 'Restore to Inbox', icon: RotateCcw }, readAction, { key: 'deleteForever', label: 'Delete forever', icon: Trash2, danger: true }];
    if (role === 'junk') return [{ key: 'notspam', label: 'Not spam', icon: ShieldCheck }, readAction, { key: 'deleteForever', label: 'Delete forever', icon: Trash2, danger: true }];
    return [
      ...(role !== 'archive' ? [{ key: 'archive' as const, label: 'Archive', icon: Archive }] : [{ key: 'restore' as const, label: 'Move to Inbox', icon: Inbox }]),
      { key: 'spam', label: 'Report spam', icon: ShieldAlert },
      { key: 'trash', label: 'Delete', icon: Trash2 },
      readAction,
      starAction,
    ];
  };

  const navItems: { key: string; label: string; icon: typeof Mail; view: View; count?: number; countStyle?: 'unread' | 'total' }[] = (() => {
    const items: { key: string; label: string; icon: typeof Mail; view: View; count?: number; countStyle?: 'unread' | 'total' }[] = [];
    const inbox = findRole(folders, 'inbox');
    items.push({ key: 'inbox', label: 'Inbox', icon: Inbox, view: { kind: 'folder', path: inbox?.path || 'INBOX' }, count: inbox?.unreadCount, countStyle: 'unread' });
    items.push({ key: 'starred', label: 'Starred', icon: Star, view: { kind: 'starred' } });
    const sent = findRole(folders, 'sent');
    items.push({ key: 'sent', label: 'Sent', icon: Send, view: { kind: 'folder', path: sent?.path || '' } });
    items.push({ key: 'drafts', label: 'Drafts', icon: FileText, view: { kind: 'drafts' }, count: drafts.length, countStyle: 'total' });
    const junk = findRole(folders, 'junk');
    items.push({ key: 'junk', label: 'Spam', icon: ShieldAlert, view: { kind: 'folder', path: junk?.path || '' }, count: junk?.messageCount, countStyle: 'total' });
    const trash = findRole(folders, 'trash');
    items.push({ key: 'trash', label: 'Trash', icon: Trash2, view: { kind: 'folder', path: trash?.path || '' }, count: trash?.messageCount, countStyle: 'total' });
    const archive = findRole(folders, 'archive');
    if (archive || !ready) items.push({ key: 'archive', label: 'Archive', icon: Archive, view: { kind: 'folder', path: archive?.path || '' } });
    const providerDrafts = findRole(folders, 'drafts');
    if (providerDrafts && providerDrafts.messageCount > 0) items.push({ key: 'webmail-drafts', label: 'Webmail drafts', icon: FileText, view: { kind: 'folder', path: providerDrafts.path }, count: providerDrafts.messageCount, countStyle: 'total' });
    const rolePaths = new Set(ROLES.map(role => findRole(folders, role)?.path).filter(Boolean));
    folders.filter(f => !rolePaths.has(f.path)).forEach(f => items.push({ key: `custom-${f.path}`, label: f.name, icon: FolderInput, view: { kind: 'folder', path: f.path }, count: f.unreadCount, countStyle: 'unread' }));
    return items;
  })();
  const isActive = (item: View) => (item.kind === view.kind && (item.kind !== 'folder' || item.path === view.path));
  const movableFolders = (list: Folder[], exclude?: string) => list.filter(f => f.path !== exclude && roleOf(list, f.path) !== 'drafts');

  const sidebar = <div className="flex h-full flex-col">
    <div className="p-3">
      <button type="button" data-testid="compose-email" disabled={!ready || busy} onClick={() => { setSidebarOpen(false); openComposer(emptyDraft(), resourceId); }} className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-[#0071E3] px-4 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-[#0062C3] disabled:cursor-not-allowed disabled:opacity-50">
        <PenLine size={16} /> Compose
      </button>
    </div>
    <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
      {mailboxes.length > 0 && <div className="mb-3">
        <div className={`px-2 pb-1.5 text-[10px] font-semibold uppercase tracking-[.12em] ${muted}`}>{mailboxes.length > 1 ? 'Accounts' : 'Account'}</div>
        {mailboxes.length > 1 && <button type="button" data-testid="mail-all-inboxes" onClick={() => openView({ kind: 'unified' })} className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm ${view.kind === 'unified' ? 'bg-[#0071E3]/10 font-semibold text-[#0058B0] dark:text-[#64B5FF]' : `${strong} ${hoverRow}`}`}>
          <Layers size={16} className="shrink-0" /><span className="flex-1 truncate">All inboxes</span>{totalUnread > 0 && <span className="text-xs font-semibold">{totalUnread}</span>}
        </button>}
        {mailboxes.map(m => {
          const active = view.kind !== 'unified' && m.providerMailboxId === resourceId;
          const unread = inboxUnread(m.providerMailboxId);
          return <button key={m.id} type="button" data-testid={`mailbox-${m.providerMailboxId}`} onClick={() => switchMailbox(m.providerMailboxId)} title={m.emailAddress} className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left ${active ? 'bg-black/[0.05] dark:bg-white/[0.08]' : hoverRow}`}>
            <span className={`flex size-7 shrink-0 items-center justify-center rounded-full text-[11px] font-bold uppercase ${active ? 'bg-[#0071E3] text-white' : 'bg-black/[0.06] text-[#424245] dark:bg-white/[0.1] dark:text-[#E5E5EA]'}`}>{(m.displayName || m.emailAddress).charAt(0)}</span>
            <span className="min-w-0 flex-1"><span className={`block truncate text-[13px] font-medium ${strong}`}>{m.displayName || m.emailAddress}</span><span className={`block truncate text-[11px] ${muted}`}>{m.emailAddress}</span></span>
            {unread > 0 && <span className="rounded-full bg-[#0071E3] px-1.5 py-0.5 text-[10px] font-semibold text-white">{unread}</span>}
          </button>;
        })}
      </div>}
      <div className={`px-2 pb-1.5 text-[10px] font-semibold uppercase tracking-[.12em] ${muted}`}>{mailboxes.length > 1 && view.kind !== 'unified' ? `Folders · ${mailbox?.displayName || mailbox?.emailAddress || ''}` : 'Folders'}</div>
      {navItems.map(item => {
        const active = ready && view.kind !== 'unified' && isActive(item.view);
        const disabled = !ready || (item.view.kind === 'folder' && !item.view.path);
        const Icon = item.icon;
        return <button key={item.key} type="button" data-testid={`mail-folder-${item.key}`} disabled={disabled} onClick={() => openView(item.view)} className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm disabled:cursor-not-allowed disabled:opacity-45 ${active ? 'bg-[#0071E3]/10 font-semibold text-[#0058B0] dark:text-[#64B5FF]' : `${strong} ${disabled ? '' : hoverRow}`}`}>
          <Icon size={16} className="shrink-0" /><span className="flex-1 truncate">{item.label}</span>
          {Boolean(item.count) && <span className={`text-xs ${item.countStyle === 'unread' ? 'font-semibold' : muted}`}>{item.count}</span>}
        </button>;
      })}
    </div>
    <div className="space-y-2.5 border-t border-black/[0.06] p-3 dark:border-white/[0.08]">
      {quota?.supported && quota.totalLimit > 0 && <div>
        <div className={`flex items-center justify-between text-[11px] ${muted}`}><span className="inline-flex items-center gap-1"><HardDrive size={12} />Storage</span><span>{formatBytes(quota.totalUsage)} of {formatBytes(quota.totalLimit)}</span></div>
        <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-black/[0.07] dark:bg-white/[0.1]"><div className={`h-full rounded-full ${quota.totalPercentage >= 90 ? 'bg-[#FF3B30]' : 'bg-[#0071E3]'}`} style={{ width: `${Math.min(100, Math.max(2, quota.totalPercentage))}%` }} /></div>
      </div>}
      <button type="button" disabled={!ready} onClick={() => { setSidebarOpen(false); setBlockedOpen(true); }} className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs ${strong} ${hoverRow} disabled:opacity-45`}>
        <Ban size={14} /><span className="flex-1">Blocked senders</span><span className={muted}>{blocked.length}</span>
      </button>
      <div className={`flex items-center gap-1.5 px-2 text-[11px] ${muted}`}>
        <span className={`size-1.5 rounded-full ${ready ? 'bg-[#30D158]' : 'bg-[#AEAEB2]'}`} />
        {ready ? `Synced with Hostinger${lastSynced ? ` · ${lastSynced.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}` : ''}` : 'Not connected'}
      </div>
    </div>
  </div>;

  const stateCard = (() => {
    if (service === 'loading') return { icon: RefreshCw, title: 'Connecting to your mailbox…', text: 'Loading your business email from Hostinger.', spin: true };
    if (service === 'unconfigured') return { icon: Mail, title: 'Business email is not connected yet', text: `Once your administrator connects a Hostinger mailbox to ${client.company || 'your account'}, your Inbox, Sent, Drafts, Spam and Trash will appear here. You will be able to send and receive email with anyone, just like in Hostinger webmail.` };
    if (service === 'unassigned') return { icon: Users, title: 'No mailbox assigned to your account yet', text: `Email is enabled on the platform, but no business mailbox has been assigned to ${client.company || 'your account'}. When your administrator assigns one (or several), they will appear here and you can switch between them.` };
    if (service === 'error') return { icon: AlertCircle, title: 'Email is temporarily unavailable', text: 'We could not reach the email service. Please try again shortly.' };
    return null;
  })();

  const listPane = <section className={`${mobileReader ? 'hidden md:flex' : 'flex'} min-h-0 w-full shrink-0 flex-col border-black/[0.06] md:w-[350px] md:border-r xl:w-[400px] dark:border-white/[0.08]`}>
    <form onSubmit={e => { e.preventDefault(); listRequest.current++; setPage(1); setSearch(query.trim()); }} className="flex items-center gap-2 border-b border-black/[0.06] px-3 py-2.5 dark:border-white/[0.08]">
      <button type="button" aria-label="Open folders" onClick={() => setSidebarOpen(true)} className={`${iconButton} lg:hidden`}><Menu size={17} /></button>
      <div className="flex min-w-0 flex-1 items-center gap-2 rounded-lg bg-black/[0.04] px-2.5 py-1.5 dark:bg-white/[0.07]">
        <Search size={14} className={muted} />
        <input aria-label="Search mail" disabled={!ready || view.kind === 'drafts' || view.kind === 'starred'} value={query} onChange={e => setQuery(e.target.value)} placeholder={view.kind === 'unified' ? 'Search all inboxes' : `Search ${viewTitle.toLowerCase()}`} className={`min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-[#AEAEB2] disabled:cursor-not-allowed ${strong}`} />
        {search && <button type="button" aria-label="Clear search" onClick={() => { setQuery(''); setSearch(''); setPage(1); }} className={muted}><X size={14} /></button>}
      </div>
    </form>
    <div className="flex min-h-[46px] items-center gap-1 border-b border-black/[0.06] px-3 py-1.5 dark:border-white/[0.08]">
      <Checkbox label="Select all" disabled={!ready || (view.kind === 'drafts' ? !drafts.length : !rows.length)} checked={allChecked} indeterminate={someChecked && !allChecked} onChange={value => {
        if (view.kind === 'drafts') setCheckedDrafts(value ? new Set(drafts.map(d => d.id || '')) : new Set());
        else setChecked(value ? new Set(rows.map(rowKey)) : new Set());
      }} />
      {someChecked ? <div className="ml-1 flex min-w-0 flex-1 flex-wrap items-center gap-0.5">
        <span className={`mr-1 text-xs font-semibold ${strong}`}>{view.kind === 'drafts' ? checkedDrafts.size : checkedRows.length} selected</span>
        {view.kind === 'drafts'
          ? <button type="button" title="Delete drafts" aria-label="Delete selected drafts" disabled={busy} onClick={() => void deleteDrafts([...checkedDrafts])} className={iconButton}><Trash2 size={15} /></button>
          : <>
            {bulkActions(checkedRows).map(action => { const Icon = action.icon; return <button key={action.key} type="button" title={action.label} aria-label={action.label} disabled={busy} onClick={() => void runAction(action.key, checkedRows)} className={`${iconButton} ${action.danger ? 'hover:!text-[#FF3B30]' : ''}`}><Icon size={15} /></button>; })}
            {view.kind !== 'unified' && <select aria-label="Move selected to folder" disabled={busy} value="" onChange={e => { if (e.target.value) void runAction('move', checkedRows, e.target.value); }} className={`ml-1 max-w-[110px] rounded-md border border-black/[0.1] bg-transparent px-1.5 py-1 text-xs dark:border-white/[0.12] ${strong}`}>
              <option value="">Move to…</option>
              {movableFolders(folders, view.path).map(f => <option key={f.path} value={f.path}>{f.name}</option>)}
            </select>}
          </>}
      </div> : <div className="ml-1 flex min-w-0 flex-1 items-center gap-1">
        <span className={`truncate text-sm font-semibold ${strong}`}>{viewTitle}</span>
        {search && <span className={`truncate text-xs ${muted}`}>· “{search}”</span>}
        <button type="button" aria-label="Refresh mail" title="Sync with Hostinger" disabled={!ready || loadingList} onClick={() => void syncNow()} className={`${iconButton} ml-auto`}><RefreshCw size={15} className={loadingList ? 'animate-spin' : ''} /></button>
      </div>}
    </div>
    {(currentRole === 'trash' || currentRole === 'junk') && total > 0 && !search && <div className={`flex items-center justify-between gap-2 border-b border-black/[0.06] bg-black/[0.02] px-3 py-2 text-xs dark:border-white/[0.08] dark:bg-white/[0.03] ${muted}`}>
      <span>{currentRole === 'trash' ? 'Emails in Trash can be restored to your Inbox.' : 'Messages in Spam are hidden from your Inbox.'}</span>
      <button type="button" disabled={busy} onClick={() => void emptyCurrentFolder()} className="shrink-0 font-semibold text-[#FF3B30] hover:underline disabled:opacity-50">Empty {currentRole === 'trash' ? 'Trash' : 'Spam'} now</button>
    </div>}
    <div className="min-h-0 flex-1 overflow-y-auto">
      {stateCard && <div className="flex flex-col items-center px-6 py-14 text-center">
        <div className="flex size-12 items-center justify-center rounded-2xl bg-[#0071E3]/10 text-[#0071E3]"><stateCard.icon size={22} className={stateCard.spin ? 'animate-spin' : ''} /></div>
        <h2 className={`mt-4 text-[15px] font-semibold ${strong}`}>{stateCard.title}</h2>
        <p className={`mt-1.5 max-w-sm text-sm leading-relaxed ${muted}`}>{stateCard.text}</p>
      </div>}
      {ready && view.kind === 'drafts' && (drafts.length ? drafts.map(d => <div key={d.id} role="button" tabIndex={0} onClick={() => openComposer(d, resourceId, resourceId)} onKeyDown={e => { if (e.key === 'Enter') openComposer(d, resourceId, resourceId); }} className={`group flex cursor-pointer items-start gap-3 border-b border-black/[0.05] px-3 py-3 dark:border-white/[0.06] ${hoverRow}`}>
        <div className="pt-0.5"><Checkbox label={`Select draft ${d.subject || ''}`} checked={checkedDrafts.has(d.id || '')} onChange={value => setCheckedDrafts(prev => { const next = new Set(prev); if (value) next.add(d.id || ''); else next.delete(d.id || ''); return next; })} /></div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2"><span className="text-xs font-semibold text-[#FF3B30]">Draft</span><span className={`min-w-0 flex-1 truncate text-sm ${strong}`}>{d.to.length ? d.to.join(', ') : '(no recipients)'}</span><span className={`shrink-0 text-[11px] ${muted}`}>{d.updatedAt ? listDate(d.updatedAt) : ''}</span></div>
          <div className={`mt-0.5 truncate text-[13px] ${strong}`}>{d.subject || '(No subject)'}</div>
          <div className={`mt-0.5 truncate text-xs ${muted}`}>{d.text.trim().slice(0, 120) || 'No message text'}</div>
        </div>
        <button type="button" aria-label="Delete draft" onClick={e => { e.stopPropagation(); void deleteDrafts([d.id || '']); }} className={`${iconButton} opacity-0 group-hover:opacity-100`}><Trash2 size={14} /></button>
      </div>) : <EmptyList icon={FileText} title="No drafts" text="Messages you save as drafts will appear here." />)}
      {ready && view.kind !== 'drafts' && loadingList && !rows.length && <div className="space-y-px">{Array.from({ length: 6 }, (_, i) => <div key={i} className="flex gap-3 border-b border-black/[0.05] px-3 py-3.5 dark:border-white/[0.06]"><div className="size-4 rounded bg-black/[0.06] dark:bg-white/[0.08]" /><div className="flex-1 space-y-2"><div className="h-3 w-1/2 animate-pulse rounded bg-black/[0.06] dark:bg-white/[0.08]" /><div className="h-3 w-4/5 animate-pulse rounded bg-black/[0.05] dark:bg-white/[0.06]" /></div></div>)}</div>}
      {ready && view.kind !== 'drafts' && !loadingList && !rows.length && <EmptyList
        icon={search ? Search : currentRole === 'trash' ? Trash2 : currentRole === 'junk' ? ShieldCheck : currentRole === 'sent' ? Send : view.kind === 'starred' ? Star : Inbox}
        title={search ? 'No matching emails' : currentRole === 'trash' ? 'Trash is empty' : currentRole === 'junk' ? 'No spam here' : currentRole === 'sent' ? 'No sent emails yet' : view.kind === 'starred' ? 'No starred emails' : 'You’re all caught up'}
        text={search ? 'Try another word, name or email address.' : currentRole === 'sent' ? 'Emails you send from this mailbox will appear here.' : view.kind === 'starred' ? 'Star important emails to find them quickly.' : 'New emails sent to this mailbox will appear here automatically.'}
      />}
      {ready && view.kind !== 'drafts' && rows.map(row => {
        const key = rowKey(row);
        const isSelected = selected ? rowKey(selected) === key : false;
        const starred = row.flags.includes('\\Flagged');
        const rowRole = roleOf(folderMap[row.mailboxId] || [], row.path) || roleForRows;
        const counterpart = rowRole === 'sent' ? `To: ${row.to.map(shortName).join(', ') || '—'}` : shortName(row.from);
        return <div key={key} role="button" tabIndex={0} data-testid={`mail-row-${row.uid}`} onClick={() => void openMessage(row)} onKeyDown={e => { if (e.key === 'Enter') void openMessage(row); }} className={`group relative flex cursor-pointer items-start gap-2.5 border-b border-black/[0.05] px-3 py-2.5 dark:border-white/[0.06] ${isSelected ? 'bg-[#0071E3]/[0.08] dark:bg-[#0A84FF]/[0.14]' : checked.has(key) ? 'bg-[#0071E3]/[0.05]' : hoverRow}`}>
          {row.unseen && <span className="absolute left-0 top-0 h-full w-[3px] bg-[#0071E3]" />}
          <div className="flex flex-col items-center gap-1.5 pt-0.5">
            <Checkbox label={`Select ${row.subject || 'email'}`} checked={checked.has(key)} onChange={value => setChecked(prev => { const next = new Set(prev); if (value) next.add(key); else next.delete(key); return next; })} />
            <button type="button" aria-label={starred ? 'Remove star' : 'Star'} onClick={e => { e.stopPropagation(); void runAction(starred ? 'unstar' : 'star', [row]); }} className={starred ? 'text-[#FF9F0A]' : 'text-[#C7C7CC] hover:text-[#FF9F0A] dark:text-[#48484A]'}><Star size={14} className={starred ? 'fill-current' : ''} /></button>
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className={`min-w-0 flex-1 truncate text-[13px] ${row.unseen ? `font-bold ${strong}` : `font-medium ${strong}`}`}>{counterpart}</span>
              {row.attachments?.length > 0 && <Paperclip size={12} className={`shrink-0 ${muted}`} />}
              <span className={`shrink-0 text-[11px] ${row.unseen ? 'font-semibold text-[#0071E3]' : muted}`}>{listDate(row.date)}</span>
            </div>
            <div className={`mt-0.5 truncate text-[13px] ${row.unseen ? `font-semibold ${strong}` : muted}`}>{row.subject || '(No subject)'}</div>
            <div className="mt-1 flex items-center gap-1.5">
              {view.kind === 'unified' && <span className="truncate rounded bg-black/[0.05] px-1.5 py-0.5 text-[10px] font-medium text-[#424245] dark:bg-white/[0.08] dark:text-[#D1D1D6]">{mailboxLabel(row.mailboxId)}</span>}
              {view.kind === 'starred' && rowRole && rowRole !== 'inbox' && <span className="rounded bg-black/[0.05] px-1.5 py-0.5 text-[10px] font-medium capitalize text-[#424245] dark:bg-white/[0.08] dark:text-[#D1D1D6]">{rowRole === 'junk' ? 'spam' : rowRole}</span>}
              {row.attachments?.slice(0, 2).map(a => <span key={a.id} className={`inline-flex max-w-[140px] items-center gap-1 truncate rounded-full border border-black/[0.08] px-2 py-0.5 text-[10px] dark:border-white/[0.1] ${muted}`}><Paperclip size={9} />{a.filename || 'file'}</span>)}
            </div>
          </div>
          <div className="absolute right-2 top-1/2 hidden -translate-y-1/2 items-center gap-0.5 rounded-lg border border-black/[0.08] bg-white p-0.5 shadow-sm group-hover:flex dark:border-white/[0.1] dark:bg-[#2C2C2E]">
            {rowRole === 'trash' || rowRole === 'junk'
              ? <button type="button" title={rowRole === 'trash' ? 'Restore to Inbox' : 'Not spam'} aria-label={rowRole === 'trash' ? 'Restore to Inbox' : 'Not spam'} onClick={e => { e.stopPropagation(); void runAction(rowRole === 'trash' ? 'restore' : 'notspam', [row]); }} className={iconButton}><RotateCcw size={14} /></button>
              : <button type="button" title="Delete" aria-label="Delete" onClick={e => { e.stopPropagation(); void runAction('trash', [row]); }} className={iconButton}><Trash2 size={14} /></button>}
            <button type="button" title={row.unseen ? 'Mark as read' : 'Mark as unread'} aria-label={row.unseen ? 'Mark as read' : 'Mark as unread'} onClick={e => { e.stopPropagation(); void runAction(row.unseen ? 'read' : 'unread', [row]); }} className={iconButton}>{row.unseen ? <MailOpen size={14} /> : <Mail size={14} />}</button>
          </div>
        </div>;
      })}
    </div>
    {ready && view.kind !== 'drafts' && <div className={`flex items-center justify-between border-t border-black/[0.06] px-3 py-1.5 text-[11px] dark:border-white/[0.08] ${muted}`}>
      <span>{total ? `${rangeStart}–${Math.max(rangeStart, rangeEnd)} of ${total}` : '0 emails'}</span>
      <div className="flex items-center">
        <button type="button" aria-label="Previous page" disabled={page <= 1 || loadingList} onClick={() => setPage(p => Math.max(1, p - 1))} className={iconButton}><ChevronLeft size={16} /></button>
        <button type="button" aria-label="Next page" disabled={page >= totalPages || loadingList} onClick={() => setPage(p => p + 1)} className={iconButton}><ChevronRight size={16} /></button>
      </div>
    </div>}
  </section>;

  const readerActions = selected ? (() => {
    const list: { key: string; label: string; icon: typeof Mail; run: () => void; danger?: boolean }[] = [];
    const starred = selected.flags.includes('\\Flagged');
    if (selectedRole === 'trash') {
      list.push({ key: 'restore', label: 'Restore to Inbox', icon: RotateCcw, run: () => void runAction('restore', [selected]) });
      list.push({ key: 'forever', label: 'Delete forever', icon: Trash2, danger: true, run: () => void runAction('deleteForever', [selected]) });
    } else if (selectedRole === 'junk') {
      list.push({ key: 'notspam', label: 'Not spam', icon: ShieldCheck, run: () => void runAction('notspam', [selected]) });
      list.push({ key: 'forever', label: 'Delete forever', icon: Trash2, danger: true, run: () => void runAction('deleteForever', [selected]) });
    } else {
      if (selectedRole !== 'archive' && findRole(selectedFolders, 'archive')) list.push({ key: 'archive', label: 'Archive', icon: Archive, run: () => void runAction('archive', [selected]) });
      if (selectedRole !== 'sent') list.push({ key: 'spam', label: 'Report spam', icon: ShieldAlert, run: () => void runAction('spam', [selected]) });
      list.push({ key: 'trash', label: 'Delete', icon: Trash2, run: () => void runAction('trash', [selected]) });
    }
    list.push({ key: 'unread', label: 'Mark as unread', icon: Mail, run: () => void runAction('unread', [selected]) });
    list.push({ key: 'star', label: starred ? 'Remove star' : 'Star', icon: Star, run: () => void runAction(starred ? 'unstar' : 'star', [selected]) });
    return list;
  })() : [];

  const readerPane = <section className={`${mobileReader ? 'flex' : 'hidden md:flex'} min-h-0 min-w-0 flex-1 flex-col`}>
    {!selected ? <div className={`flex flex-1 flex-col items-center justify-center p-8 text-center ${muted}`}>
      <div className="flex size-14 items-center justify-center rounded-2xl bg-black/[0.04] dark:bg-white/[0.06]"><MailOpen size={26} /></div>
      <p className={`mt-4 text-sm font-medium ${strong}`}>{ready ? 'Select an email to read' : 'Your reading pane'}</p>
      <p className="mt-1 max-w-xs text-xs">{ready ? 'Choose a message from the list. Tick several messages to act on them together.' : 'Messages open here once a mailbox is connected.'}</p>
    </div> : <article className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-1 border-b border-black/[0.06] px-3 py-1.5 dark:border-white/[0.08]">
        <button type="button" aria-label="Back to list" onClick={() => { setMobileReader(false); }} className={`${iconButton} md:hidden`}><ArrowLeft size={17} /></button>
        {readerActions.map(action => { const Icon = action.icon; return <button key={action.key} type="button" title={action.label} aria-label={action.label} disabled={busy} onClick={action.run} className={`${iconButton} ${action.danger ? 'hover:!text-[#FF3B30]' : ''}`}><Icon size={16} className={action.key === 'star' && selected.flags.includes('\\Flagged') ? 'fill-[#FF9F0A] text-[#FF9F0A]' : ''} /></button>; })}
        {movableFolders(selectedFolders, selected.path).length > 0 && <select aria-label="Move message to folder" value={moveTarget} disabled={busy} onChange={e => { const target = e.target.value; setMoveTarget(''); if (target) void runAction('move', [selected], target); }} className={`ml-1 max-w-[120px] rounded-md border border-black/[0.1] bg-transparent px-1.5 py-1 text-xs dark:border-white/[0.12] ${strong}`}>
          <option value="">Move to…</option>
          {movableFolders(selectedFolders, selected.path).map(f => <option key={f.path} value={f.path}>{f.name}</option>)}
        </select>}
        {selectedSender && selectedSender !== selectedOwn && selectedRole !== 'sent' && <button type="button" disabled={busy} onClick={() => void (senderBlocked ? unblockSender(selected.mailboxId, selectedSender) : blockSender(selected.mailboxId, selectedSender))} className={`ml-auto inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium ${senderBlocked ? 'text-[#0071E3] hover:bg-[#0071E3]/10' : 'text-[#FF3B30] hover:bg-[#FF3B30]/10'} disabled:opacity-50`}>
          <Ban size={14} />{senderBlocked ? 'Unblock sender' : 'Block sender'}
        </button>}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="px-5 pb-3 pt-4 sm:px-6">
          <h2 className={`text-lg font-semibold leading-snug sm:text-xl ${strong}`}>{selected.subject || '(No subject)'}</h2>
          {senderBlocked && <div className="mt-2 inline-flex items-center gap-1.5 rounded-md bg-[#FF3B30]/10 px-2 py-1 text-[11px] font-medium text-[#C9251B]"><Ban size={12} />This sender is blocked; new emails from them go to Spam.</div>}
          <div className="mt-4 flex items-start gap-3">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-[#0071E3]/10 text-sm font-semibold uppercase text-[#0071E3]">{shortName(selected.from).charAt(0)}</span>
            <div className="min-w-0 flex-1 text-xs">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
                <span className={`text-sm font-semibold ${strong}`}>{selected.from?.name || selected.from?.address || 'Unknown sender'} {selected.from?.name && <span className={`text-xs font-normal ${muted}`}>&lt;{selected.from.address}&gt;</span>}</span>
                <span className={muted}>{fullDate(selected.date)}</span>
              </div>
              <div className={`mt-0.5 ${muted}`}>to {selected.to.map(shortName).join(', ') || '—'}</div>
              {selected.cc.length > 0 && <div className={muted}>cc {selected.cc.map(shortName).join(', ')}</div>}
              {selected.bcc.length > 0 && <div className={muted}>bcc {selected.bcc.map(shortName).join(', ')}</div>}
              {mailboxes.length > 1 && <div className={`mt-0.5 ${muted}`}>in {mailboxLabel(selected.mailboxId)}</div>}
            </div>
          </div>
        </div>
        <div className="px-5 pb-6 sm:px-6">
          {bodyLoading ? <div className="space-y-2.5 py-2">{[90, 75, 82, 40].map(w => <div key={w} className="h-3 animate-pulse rounded bg-black/[0.06] dark:bg-white/[0.08]" style={{ width: `${w}%` }} />)}</div>
            : body.html ? <div className="rounded-xl bg-white p-3 ring-1 ring-black/[0.04] dark:ring-white/[0.08]"><iframe title="Email message content" sandbox="" referrerPolicy="no-referrer" srcDoc={iframeDoc} className="min-h-[320px] w-full border-0" /></div>
              : <pre className={`whitespace-pre-wrap break-words font-sans text-sm leading-relaxed ${strong}`}>{body.text || '(This message has no readable body.)'}</pre>}
          {selected.attachments?.length > 0 && <div className="mt-6 border-t border-black/[0.06] pt-4 dark:border-white/[0.08]">
            <div className="mb-2.5 flex items-center justify-between">
              <span className={`text-xs font-semibold ${strong}`}>{selected.attachments.length} attachment{selected.attachments.length === 1 ? '' : 's'}</span>
              {selected.attachments.length > 1 && <button type="button" onClick={() => void downloadAll()} className="inline-flex items-center gap-1 text-xs font-semibold text-[#0071E3] hover:underline"><Download size={13} />Download all</button>}
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              {selected.attachments.map(a => <div key={a.id} className="flex items-center gap-2.5 rounded-xl border border-black/[0.08] p-2.5 dark:border-white/[0.1]">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-[#0071E3]/10 text-[#0071E3]"><Paperclip size={15} /></span>
                <div className="min-w-0 flex-1"><div className={`truncate text-xs font-medium ${strong}`}>{a.filename || 'Attachment'}</div><div className={`text-[11px] ${muted}`}>{formatBytes(a.sizeBytes)}</div></div>
                {PREVIEWABLE.test(a.contentType) && <button type="button" title="Preview" aria-label={`Preview ${a.filename || 'attachment'}`} onClick={() => void previewAttachment(a)} className={iconButton}><Eye size={15} /></button>}
                <button type="button" title="Download" aria-label={`Download ${a.filename || 'attachment'}`} onClick={() => void downloadAttachment(a)} className={iconButton}><Download size={15} /></button>
              </div>)}
            </div>
          </div>}
          <div className="mt-6 flex flex-wrap gap-2">
            <button type="button" disabled={busy} onClick={() => startReply(false)} className={secondaryButton}><Reply size={14} />Reply</button>
            <button type="button" disabled={busy} onClick={() => startReply(true)} className={secondaryButton}><ReplyAll size={14} />Reply all</button>
            <button type="button" disabled={busy} onClick={() => void startForward()} className={secondaryButton}><Forward size={14} />Forward</button>
          </div>
        </div>
      </div>
    </article>}
  </section>;

  const canSendIndividually = composer ? composer.draft.to.length > 1 && !composer.draft.cc.length && !composer.draft.bcc.length && !composer.draft.inReplyTo && !composer.draft.forwardOf : false;

  return <div className="flex h-[calc(100dvh-9rem)] min-h-[560px] flex-col gap-3 lg:h-[calc(100dvh-10.5rem)]">
    <header className="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className={`text-2xl font-semibold tracking-tight ${strong}`}>Email</h1>
        <p className={`mt-0.5 text-sm ${muted}`}>{view.kind === 'unified' ? `All ${mailboxes.length} business inboxes` : mailbox ? `${mailbox.displayName && mailbox.displayName !== mailbox.emailAddress ? `${mailbox.displayName} · ` : ''}${mailbox.emailAddress}` : 'Your business mailboxes, powered by Hostinger'}</p>
      </div>
      {ready && <div className={`hidden items-center gap-1.5 text-xs sm:flex ${muted}`}><ShieldCheck size={14} className="text-[#30D158]" />Send and receive with anyone · changes sync with Hostinger webmail</div>}
    </header>
    {error && <div role="alert" className="flex items-start justify-between gap-3 rounded-xl border border-[#FF3B30]/25 bg-[#FF3B30]/[0.07] px-4 py-2.5 text-sm text-[#C9251B] dark:text-[#FF6961]"><span className="flex items-start gap-2"><AlertCircle size={16} className="mt-0.5 shrink-0" />{error}</span><button type="button" onClick={() => setError('')} aria-label="Dismiss error"><X size={16} /></button></div>}
    {notice && <div role="status" className="flex items-center gap-2 rounded-xl border border-[#30D158]/30 bg-[#30D158]/[0.08] px-4 py-2 text-sm text-[#1E7B3A] dark:text-[#5BE07F]"><CheckCircle2 size={16} />{notice}</div>}
    <div className={`relative flex min-h-0 flex-1 overflow-hidden rounded-2xl shadow-[0_1px_3px_rgba(0,0,0,0.04)] ${panel}`}>
      <aside className="hidden w-60 shrink-0 border-r border-black/[0.06] bg-[#FBFBFD] lg:block dark:border-white/[0.08] dark:bg-[#161618]">{sidebar}</aside>
      {sidebarOpen && <div className="absolute inset-0 z-30 flex lg:hidden">
        <div className="w-64 max-w-[85%] border-r border-black/[0.08] bg-[#FBFBFD] shadow-xl dark:border-white/[0.08] dark:bg-[#161618]">{sidebar}</div>
        <button type="button" aria-label="Close folders" className="flex-1 bg-black/25" onClick={() => setSidebarOpen(false)} />
      </div>}
      {listPane}
      {readerPane}
    </div>

    {composer && <div className="fixed inset-0 z-[100] flex items-end justify-center bg-black/35 p-0 sm:items-center sm:p-6" onClick={closeComposer}>
      <form onSubmit={sendComposer} onClick={e => e.stopPropagation()} className={`flex max-h-[94dvh] w-full max-w-3xl flex-col overflow-hidden rounded-t-2xl shadow-2xl sm:rounded-2xl ${panel}`}>
        <div className="flex items-center justify-between border-b border-black/[0.06] px-5 py-3 dark:border-white/[0.08]">
          <div className={`text-sm font-semibold ${strong}`}>{composer.draft.forwardOf ? 'Forward' : composer.draft.inReplyTo ? 'Reply' : composer.draft.id ? 'Edit draft' : 'New message'}</div>
          <button type="button" aria-label="Close compose" onClick={closeComposer} className={iconButton}><X size={17} /></button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5">
          <label className="flex min-h-[42px] items-center gap-1.5 border-b border-black/[0.06] py-1.5 dark:border-white/[0.08]">
            <span className={`w-10 shrink-0 text-xs ${muted}`}>From</span>
            <select data-testid="compose-from-mailbox" aria-label="From mailbox" value={composer.mailboxId} onChange={e => { const id = e.target.value; setComposer(c => (c ? { ...c, mailboxId: id, dirty: true, draft: id !== c.draftMailboxId ? { ...c.draft, inReplyTo: undefined, forwardOf: undefined } : c.draft } : c)); }} className={`min-w-0 flex-1 bg-transparent py-1 text-sm outline-none ${strong}`}>
              {mailboxes.map(m => <option key={m.id} value={m.providerMailboxId}>{m.displayName && m.displayName !== m.emailAddress ? `${m.displayName} <${m.emailAddress}>` : m.emailAddress}</option>)}
            </select>
          </label>
          <div className="relative">
            <RecipientField label="To" values={composer.draft.to} onChange={to => updateDraft({ to })} autoFocus={!composer.draft.to.length} />
            {!composer.showCc && <button type="button" onClick={() => setComposer(c => (c ? { ...c, showCc: true } : c))} className={`absolute right-0 top-3 text-xs font-medium ${muted} hover:text-[#0071E3]`}>Cc / Bcc</button>}
          </div>
          {composer.showCc && <>
            <RecipientField label="Cc" values={composer.draft.cc} onChange={cc => updateDraft({ cc })} />
            <RecipientField label="Bcc" values={composer.draft.bcc} onChange={bcc => updateDraft({ bcc })} />
          </>}
          {canSendIndividually && <label className={`flex items-start gap-2 border-b border-black/[0.06] py-2.5 text-xs dark:border-white/[0.08] ${muted}`}>
            <input type="checkbox" checked={composer.individually} onChange={e => setComposer(c => (c ? { ...c, individually: e.target.checked } : c))} className="mt-0.5 size-4 accent-[#0071E3]" />
            <span><span className={`font-semibold ${strong}`}>Bulk send: send individually to each recipient</span><br />Each of the {composer.draft.to.length} recipients gets a separate copy and cannot see the others (up to 50).</span>
          </label>}
          <input aria-label="Subject" value={composer.draft.subject} onChange={e => updateDraft({ subject: e.target.value })} placeholder="Subject" className={`w-full border-b border-black/[0.06] bg-transparent py-3 text-sm font-medium outline-none placeholder:text-[#AEAEB2] dark:border-white/[0.08] ${strong}`} />
          <div className="flex items-center gap-0.5 border-b border-black/[0.06] py-1.5 dark:border-white/[0.08]" role="toolbar" aria-label="Message formatting">
            {[['bold', 'Bold', 'B'], ['italic', 'Italic', 'I'], ['underline', 'Underline', 'U'], ['insertUnorderedList', 'Bulleted list', '• List'], ['insertOrderedList', 'Numbered list', '1. List']].map(([command, label, text]) => <button key={command} type="button" aria-label={label} title={label} onMouseDown={e => e.preventDefault()} onClick={() => {
              const editor = editorRef.current;
              if (!editor) return;
              editor.focus();
              document.execCommand(command, false);
              updateDraft({ html: sanitizeComposeHtml(editor.innerHTML), text: editor.innerText || editor.textContent || '' });
            }} className={`rounded-md px-2.5 py-1 text-xs font-semibold ${strong} ${hoverRow}`}>{text}</button>)}
          </div>
          <div ref={editorRef} data-testid="email-rich-text-editor" role="textbox" aria-label="Message" aria-multiline="true" contentEditable suppressContentEditableWarning
            onInput={e => { const editor = e.currentTarget; updateDraft({ html: sanitizeComposeHtml(editor.innerHTML), text: editor.innerText || editor.textContent || '' }); }}
            onPaste={e => { e.preventDefault(); document.execCommand('insertText', false, e.clipboardData.getData('text/plain')); }}
            className={`min-h-[240px] w-full whitespace-pre-wrap break-words py-3 text-sm leading-relaxed outline-none empty:before:text-[#AEAEB2] empty:before:content-['Write_your_message…'] [&_blockquote]:border-l-[3px] [&_blockquote]:border-[#D2D2D7] [&_blockquote]:pl-3 [&_blockquote]:text-[#6E6E73] ${strong}`} />
          {composer.draft.attachments.length > 0 && <div className="flex flex-wrap gap-2 pb-3">{composer.draft.attachments.map((a, i) => <span key={`${a.filename}-${i}`} className={`inline-flex max-w-full items-center gap-1.5 rounded-lg border border-black/[0.08] px-2.5 py-1 text-xs dark:border-white/[0.1] ${strong}`}>
            <Paperclip size={12} /><span className="truncate">{a.filename}</span><span className={muted}>{formatBytes(Math.floor(a.content.length * 3 / 4))}</span>
            <button type="button" aria-label={`Remove ${a.filename}`} onClick={() => setComposer(c => (c ? { ...c, dirty: true, draft: { ...c.draft, attachments: c.draft.attachments.filter((_, ix) => ix !== i) } } : c))} className={muted}><X size={12} /></button>
          </span>)}</div>}
        </div>
        <div className="flex flex-wrap items-center gap-2 border-t border-black/[0.06] px-5 py-3 dark:border-white/[0.08]">
          <button type="submit" disabled={busy || !(composer.draft.to.length || composer.draft.cc.length || composer.draft.bcc.length)} className={primaryButton}><Send size={14} />{busy ? 'Sending…' : composer.individually ? `Send ${composer.draft.to.length} emails` : 'Send'}</button>
          <label className={`${iconButton} cursor-pointer`} title="Attach files"><Paperclip size={16} /><input type="file" multiple aria-label="Attach files" className="sr-only" onChange={e => { void chooseFiles(e.target.files); e.target.value = ''; }} /></label>
          <span className={`text-[11px] ${muted}`}>Up to 10 MB per file</span>
          <div className="ml-auto flex items-center gap-2">
            <button type="button" disabled={busy} onClick={() => void saveDraft()} className={secondaryButton}>Save draft</button>
            <button type="button" title="Discard" aria-label="Discard message" disabled={busy} onClick={closeComposer} className={`${iconButton} hover:!text-[#FF3B30]`}><Trash2 size={15} /></button>
          </div>
        </div>
      </form>
    </div>}

    {blockedOpen && <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/35 p-4" onClick={() => setBlockedOpen(false)}>
      <BlockedSendersDialog mailbox={mailbox} blocked={blocked} busy={busy} onClose={() => setBlockedOpen(false)} onBlock={address => void blockSender(resourceId, address)} onUnblock={address => void unblockSender(resourceId, address)} />
    </div>}

    {preview && <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/60 p-4" onClick={closePreview}>
      <div onClick={e => e.stopPropagation()} className={`flex max-h-[90dvh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl ${panel}`}>
        <div className="flex items-center justify-between border-b border-black/[0.06] px-4 py-2.5 dark:border-white/[0.08]"><span className={`truncate text-sm font-semibold ${strong}`}>{preview.name}</span><button type="button" aria-label="Close preview" onClick={closePreview} className={iconButton}><X size={17} /></button></div>
        <div className="min-h-0 flex-1 overflow-auto bg-[#F5F5F7] p-4 dark:bg-black">
          {preview.text !== undefined ? <pre className={`whitespace-pre-wrap break-words font-mono text-xs ${strong}`}>{preview.text}</pre>
            : /^image\//i.test(preview.type) ? <img src={preview.url} alt={preview.name} className="mx-auto max-h-[75dvh] max-w-full object-contain" />
              : <iframe title={preview.name} src={preview.url} sandbox="" className="h-[75dvh] w-full rounded-lg border-0 bg-white" />}
        </div>
      </div>
    </div>}
  </div>;
}

function EmptyList({ icon: Icon, title, text }: { icon: typeof Mail; title: string; text: string }) {
  return <div className="flex flex-col items-center px-6 py-14 text-center">
    <div className="flex size-11 items-center justify-center rounded-2xl bg-black/[0.04] text-[#8E8E93] dark:bg-white/[0.06]"><Icon size={20} /></div>
    <p className={`mt-3 text-sm font-semibold ${strong}`}>{title}</p>
    <p className={`mt-1 max-w-xs text-xs leading-relaxed ${muted}`}>{text}</p>
  </div>;
}

function BlockedSendersDialog({ mailbox, blocked, busy, onClose, onBlock, onUnblock }: { mailbox?: ClientMailbox; blocked: BlockedSender[]; busy: boolean; onClose: () => void; onBlock: (address: string) => void; onUnblock: (address: string) => void }) {
  const [address, setAddress] = useState('');
  return <div onClick={e => e.stopPropagation()} className={`w-full max-w-md overflow-hidden rounded-2xl shadow-2xl ${panel}`}>
    <div className="flex items-start justify-between gap-3 border-b border-black/[0.06] px-5 py-4 dark:border-white/[0.08]">
      <div><h2 className={`text-base font-semibold ${strong}`}>Blocked senders</h2><p className={`mt-0.5 text-xs ${muted}`}>Emails from these addresses to {mailbox?.emailAddress || 'this mailbox'} are moved to Spam.</p></div>
      <button type="button" aria-label="Close blocked senders" onClick={onClose} className={iconButton}><X size={17} /></button>
    </div>
    <form onSubmit={e => { e.preventDefault(); if (EMAIL_PATTERN.test(address.trim())) { onBlock(address.trim()); setAddress(''); } }} className="flex gap-2 px-5 pt-4">
      <input aria-label="Sender address to block" value={address} onChange={e => setAddress(e.target.value)} placeholder="sender@example.com" className={`min-w-0 flex-1 rounded-lg border border-black/[0.1] bg-transparent px-3 py-2 text-sm outline-none focus:border-[#0071E3] dark:border-white/[0.12] ${strong}`} />
      <button type="submit" disabled={busy || !EMAIL_PATTERN.test(address.trim())} className={primaryButton}><Ban size={14} />Block</button>
    </form>
    <div className="max-h-[50dvh] overflow-y-auto px-5 py-4">
      {blocked.length ? <ul className="divide-y divide-black/[0.06] rounded-xl border border-black/[0.08] dark:divide-white/[0.08] dark:border-white/[0.1]">
        {blocked.map(b => <li key={b.address} className="flex items-center gap-3 px-3 py-2.5">
          <Ban size={14} className="shrink-0 text-[#FF3B30]" />
          <div className="min-w-0 flex-1"><div className={`truncate text-sm ${strong}`}>{b.address}</div><div className={`text-[11px] ${muted}`}>Blocked {fullDate(b.blockedAt)}</div></div>
          <button type="button" disabled={busy} onClick={() => onUnblock(b.address)} className={secondaryButton}>Unblock</button>
        </li>)}
      </ul> : <p className={`py-6 text-center text-sm ${muted}`}>You have not blocked anyone.</p>}
    </div>
  </div>;
}
