#!/usr/bin/env node
/**
 * Local-only, in-memory stand-in for the Hostinger Mail API used to preview the
 * mail experience without a real Hostinger account. The PHP API only talks to it
 * when NODE_ENV=test and HOSTINGER_MAIL_TEST_BASE_URL points at this server.
 *
 *   node scripts/hostinger-mail-dev-mock.mjs            # listens on 127.0.0.1:8090
 *   HOSTINGER_MOCK_PORT=9000 node scripts/hostinger-mail-dev-mock.mjs
 */
import { createServer } from 'node:http';

const port = Number(process.env.HOSTINGER_MOCK_PORT || 8090);
const mailboxes = [
  { resourceId: 'ACdemoInfo01', address: 'info@acme-demo.test', name: 'Acme Info' },
  { resourceId: 'ACdemoSales02', address: 'sales@acme-demo.test', name: 'Acme Sales' },
  { resourceId: 'ACdemoBilling03', address: 'billing@acme-demo.test', name: 'Acme Billing' },
  { resourceId: 'ACdemoSupport04', address: 'support@northwind-demo.test', name: 'Northwind Support' },
];
const folderDefs = [
  ['INBOX', 'Inbox', '\\Inbox'], ['INBOX.Sent', 'Sent', '\\Sent'], ['INBOX.Drafts', 'Drafts', '\\Drafts'],
  ['INBOX.Spam', 'Spam', '\\Junk'], ['INBOX.Trash', 'Trash', '\\Trash'], ['INBOX.Archive', 'Archive', '\\Archive'],
];
const store = new Map();
let nextUid = 100;

function addMessage(resourceId, folder, message) {
  const box = store.get(resourceId);
  const uid = nextUid++;
  const record = {
    uid, path: folder, date: message.date || new Date().toISOString(), flags: message.flags || [],
    size: (message.text || '').length + 512, subject: message.subject ?? null, from: message.from || null,
    to: message.to || [], cc: message.cc || [], bcc: message.bcc || [], messageId: `<${uid}.${resourceId}@mock.test>`,
    inReplyTo: null, attachments: message.attachments || [], text: message.text || '', html: message.html || '',
    attachmentData: message.attachmentData || {},
  };
  box.folders.get(folder).push(record);
  return record;
}

const hoursAgo = (hours) => new Date(Date.now() - hours * 3600_000).toISOString();
const person = (name, address) => ({ name, address });
for (const mailbox of mailboxes) {
  store.set(mailbox.resourceId, { ...mailbox, folders: new Map(folderDefs.map(([path]) => [path, []])) });
  const me = person(mailbox.name, mailbox.address);
  const seed = [
    ['INBOX', { subject: 'Quote request for 40 office chairs', from: person('Lena Ortiz', 'lena@brightdesk.example'), to: [me], text: 'Hi,\n\nCould you send a quote for 40 ergonomic office chairs delivered to our Austin office next month?\n\nThanks,\nLena', date: hoursAgo(1) }],
    ['INBOX', { subject: 'Signed contract attached', from: person('Marcus Chen', 'marcus@harborlogistics.example'), to: [me], cc: [person('Legal', 'legal@harborlogistics.example')], text: 'Please find the signed service contract attached. Let us know once countersigned.', html: '<p>Please find the <b>signed service contract</b> attached.</p><p>Let us know once countersigned.</p>', date: hoursAgo(5), attachments: [{ id: 'att-contract', filename: 'service-contract.pdf', contentType: 'application/pdf', sizeBytes: 48211, inline: false, contentId: null }], attachmentData: { 'att-contract': '%PDF-1.4 mock contract' } }],
    ['INBOX', { subject: 'Invoice #4471 payment confirmation', from: person('Accounts', 'accounts@northpeak.example'), to: [me], text: 'Your payment of $2,450.00 has been received. Thank you for your business.', date: hoursAgo(26), flags: ['\\Seen', '\\Flagged'] }],
    ['INBOX', { subject: 'Site visit photos', from: person('Priya Nair', 'priya@studio-nair.example'), to: [me], text: 'Photos from Tuesday attached.', date: hoursAgo(50), flags: ['\\Seen'], attachments: [{ id: 'att-photo', filename: 'site-visit.png', contentType: 'image/png', sizeBytes: 182340, inline: false, contentId: null }], attachmentData: { 'att-photo': 'mock-image-bytes' } }],
    ['INBOX', { subject: 'Weekly supplier newsletter', from: person('Supplier Hub', 'news@supplierhub.example'), to: [me], text: 'This week: new pricing tiers and shipping updates.', date: hoursAgo(80), flags: ['\\Seen'] }],
    ['INBOX.Sent', { subject: 'Re: Delivery schedule', from: me, to: [person('Omar Haddad', 'omar@fastfreight.example')], text: 'Thursday 10am works for us.', date: hoursAgo(30), flags: ['\\Seen'] }],
    ['INBOX.Spam', { subject: 'You have WON a free cruise!!!', from: person('Prize Team', 'winner@promo-blast.example'), to: [me], text: 'Click here to claim.', date: hoursAgo(12) }],
    ['INBOX.Trash', { subject: 'Old meeting notes', from: person('Dana Ruiz', 'dana@clientco.example'), to: [me], text: 'Notes from last quarter.', date: hoursAgo(200), flags: ['\\Seen'] }],
  ];
  for (const [folder, message] of seed) addMessage(mailbox.resourceId, folder, message);
}

const publicMessage = ({ text, html, attachmentData, ...rest }) => ({ ...rest, unseen: !rest.flags.includes('\\Seen') });
const sortMessages = (rows, sort) => {
  const desc = sort.startsWith('-');
  const key = sort.replace('-', '') === 'date' ? 'date' : 'uid';
  return [...rows].sort((a, b) => (a[key] > b[key] ? 1 : -1) * (desc ? -1 : 1));
};
const paginate = (rows, url) => {
  const page = Math.max(1, Number(url.searchParams.get('page') || 1));
  const perPage = Math.min(100, Math.max(1, Number(url.searchParams.get('perPage') || 25)));
  const sorted = sortMessages(rows, url.searchParams.get('sort') || '-uid');
  return {
    data: sorted.slice((page - 1) * perPage, page * perPage).map(publicMessage),
    pagination: { page, perPage, total: rows.length, totalPages: Math.max(1, Math.ceil(rows.length / perPage)) },
  };
};
const matches = (message, criteria) => {
  const has = (value, needle) => String(value || '').toLowerCase().includes(String(needle).toLowerCase());
  const addresses = (list) => list.map((a) => `${a.name} ${a.address}`).join(' ');
  if (criteria.from && !has(addresses([message.from || {}]), criteria.from)) return false;
  if (criteria.subject && !has(message.subject, criteria.subject)) return false;
  if (criteria.flags && !criteria.flags.every((flag) => message.flags.includes(flag))) return false;
  if (criteria.text && ![message.subject, message.text, addresses([message.from || {}, ...message.to, ...message.cc])].some((v) => has(v, criteria.text))) return false;
  return true;
};
const applyFlags = (message, add = [], remove = []) => {
  message.flags = [...new Set([...message.flags.filter((flag) => !remove.includes(flag)), ...add])];
};

createServer((request, response) => {
  const chunks = [];
  request.on('data', (chunk) => chunks.push(chunk));
  request.on('end', () => {
    const url = new URL(request.url || '/', 'http://127.0.0.1');
    const json = (status, payload) => {
      response.writeHead(status, payload === undefined ? {} : { 'Content-Type': 'application/json' });
      response.end(payload === undefined ? undefined : JSON.stringify(payload));
    };
    let body = {};
    try { body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}; } catch { return json(400, { code: 'ERR_BAD_JSON' }); }
    const auth = request.headers.authorization || '';
    if (!auth.startsWith('Bearer ') || auth.length < 23) return json(401, { error: 'Unauthorized', code: 'ERR_UNAUTHORIZED' });
    if (request.method === 'GET' && url.pathname === '/api/v1/me') {
      return json(200, { data: { orderResourceId: 'ACdemoOrder', mailboxes: mailboxes.map(({ resourceId, address }) => ({ resourceId, address })) } });
    }
    const parts = url.pathname.split('/').slice(1).map(decodeURIComponent);
    if (parts[0] !== 'api' || parts[1] !== 'v1' || parts[2] !== 'mailboxes') return json(404, { code: 'ERR_NOT_FOUND' });
    const box = store.get(parts[3]);
    if (!box) return json(404, { code: 'ERR_NOT_FOUND' });
    const rest = parts.slice(4);
    const method = request.method;

    if (method === 'GET' && rest[0] === 'quota') {
      const usage = [...box.folders.values()].flat().reduce((total, m) => total + m.size, 0) + 734_003_200;
      const limit = 10 * 1024 ** 3;
      return json(200, { data: { quotas: [], totalUsage: usage, totalLimit: limit, totalPercentage: Math.round((usage / limit) * 100), supported: true } });
    }
    if (method === 'GET' && rest.length === 1 && rest[0] === 'folders') {
      const data = folderDefs.map(([path, name, specialUse]) => {
        const rows = box.folders.get(path);
        return { path, name, delimiter: '.', specialUse, messageCount: rows.length, unreadCount: rows.filter((m) => !m.flags.includes('\\Seen')).length };
      });
      return json(200, { data, pagination: { page: 1, perPage: 100, total: data.length, totalPages: 1 } });
    }
    if (method === 'POST' && rest[0] === 'send') {
      if (!(body.to?.length || body.cc?.length || body.bcc?.length)) return json(422, { code: 'ERR_VALIDATION' });
      const me = person(body.displayName || box.name, box.address);
      const toList = (list = []) => list.map((address) => person('', address));
      const attachments = (body.attachments || []).map((a, i) => ({ id: `att-${nextUid}-${i}`, filename: a.filename, contentType: a.contentType, sizeBytes: Buffer.from(a.content, 'base64').length, inline: false, contentId: null }));
      const attachmentData = Object.fromEntries((body.attachments || []).map((a, i) => [`att-${nextUid}-${i}`, Buffer.from(a.content, 'base64').toString('binary')]));
      const message = { subject: body.subject, from: me, to: toList(body.to), cc: toList(body.cc), bcc: toList(body.bcc), text: body.text, html: body.html, attachments, attachmentData };
      addMessage(box.resourceId, 'INBOX.Sent', { ...message, flags: ['\\Seen'] });
      for (const address of [...(body.to || []), ...(body.cc || []), ...(body.bcc || [])]) {
        const target = mailboxes.find((m) => m.address.toLowerCase() === address.toLowerCase());
        if (target) addMessage(target.resourceId, 'INBOX', { ...message, bcc: [] });
      }
      const ref = body.inReplyTo || body.forwardOf;
      const source = ref && box.folders.get(ref.folder)?.find((m) => m.uid === ref.uid);
      if (source) applyFlags(source, [body.inReplyTo ? '\\Answered' : '$forwarded']);
      return json(204);
    }
    if (rest[0] !== 'folders' || !box.folders.has(rest[1])) return json(404, { code: 'ERR_NOT_FOUND' });
    const folder = box.folders.get(rest[1]);
    const action = rest.slice(2);
    const findMessage = (uid) => folder.find((m) => m.uid === Number(uid));
    const moveTo = (uids, target) => {
      if (!box.folders.has(target)) return false;
      for (const uid of uids) {
        const index = folder.findIndex((m) => m.uid === Number(uid));
        if (index < 0) continue;
        const [message] = folder.splice(index, 1);
        message.path = target;
        message.uid = nextUid++;
        box.folders.get(target).push(message);
      }
      return true;
    };

    if (action.length === 1 && action[0] === 'messages') {
      if (method === 'GET') return json(200, paginate(folder, url));
      if (method === 'DELETE') { folder.splice(0, folder.length); return json(204); }
    }
    if (action.length === 2 && action[0] === 'messages' && method === 'POST') {
      if (action[1] === 'search') return json(200, paginate(folder.filter((m) => matches(m, body)), url));
      if (action[1] === 'move') return moveTo(body.uids || [], body.targetFolder) ? json(204) : json(422, { code: 'ERR_VALIDATION' });
      if (action[1] === 'delete') {
        for (const uid of body.uids || []) { const index = folder.findIndex((m) => m.uid === Number(uid)); if (index >= 0) folder.splice(index, 1); }
        return json(204);
      }
      if (action[1] === 'flags') {
        const successful = [];
        for (const uid of body.uids || []) { const m = findMessage(uid); if (m) { applyFlags(m, body.addFlags, body.removeFlags); successful.push(m.uid); } }
        return json(200, { data: { successful, failed: [] } });
      }
    }
    const message = action[0] === 'messages' ? findMessage(action[1]) : null;
    if (!message) return json(404, { code: 'ERR_NOT_FOUND' });
    if (action.length === 2) {
      if (method === 'GET') return json(200, { data: publicMessage(message) });
      if (method === 'PATCH') { applyFlags(message, body.addFlags, body.removeFlags); return json(200, { data: publicMessage(message) }); }
      if (method === 'DELETE') { folder.splice(folder.indexOf(message), 1); return json(204); }
    }
    if (action.length === 3 && action[2] === 'text' && method === 'GET') return json(200, { data: { text: message.text, html: message.html } });
    if (action.length === 3 && action[2] === 'move' && method === 'POST') return moveTo([message.uid], body.targetFolder) ? json(204) : json(422, { code: 'ERR_VALIDATION' });
    if (action.length === 4 && action[2] === 'attachments' && method === 'GET') {
      const data = message.attachmentData[action[3]];
      if (data === undefined) return json(404, { code: 'ERR_NOT_FOUND' });
      response.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      return response.end(Buffer.from(data, 'binary'));
    }
    return json(404, { code: 'ERR_NOT_FOUND' });
  });
}).listen(port, '127.0.0.1', () => {
  console.log(`Hostinger Mail dev mock listening on http://127.0.0.1:${port}`);
});
